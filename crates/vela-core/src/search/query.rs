//! 把用户在输入框里打的那串字符变成一台匹配机 + 一组路径过滤 + 一份替换模板
//! （PLAN.md §3.4 M2-C、M2-D）。
//!
//! 这一层单独一个文件，是因为它是搜索里**唯一会对用户输入报错**的地方：正则编不出来、
//! 通配编不出来、替换模板里的 `$` 写法不支持、root 不对，四件事都必须在遍历开始之前
//! 判完（理由见 `mod.rs` 最后一条）。
//! 把它们与遍历混在一起，「搜索没找到」与「搜索没跑起来」就会共用一个出口。

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::{Captures, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use serde::{Deserialize, Serialize};

use crate::fs::normalize_to_lf;

/// 前端发过来的那一份搜索条件。
///
/// `#[serde(default)]` 挂在容器上：三个开关与两个通配列表缺 key 时都落到默认值，
/// 于是前端可以只发 `{ pattern: "foo" }`。这与 `Session` 那边的取舍相反——
/// 会话存档刻意**永远序列化**出每个字段，好让契约测试有稳定的键可钉；
/// 而搜索条件是一次性的请求，宽容一点省掉的是前端四处 `?? false`。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    /// 要搜的东西。⚠️ 空字符串会被拒（见 [`SearchError::BadPattern`]）：
    /// 空正则匹配**每一行**，于是用户会收到两万条与他的意图毫无关系的结果
    pub pattern: String,
    /// 把 `pattern` 当字面串而不是正则。默认关——与 VS Code 的「.*」开关同向
    pub literal: bool,
    /// 区分大小写。默认**不**区分
    pub case_sensitive: bool,
    /// 整词匹配（要求命中落在词边界上）。与 `literal` 可以同时开
    pub whole_word: bool,
    /// 只搜匹配这些通配的路径（相对 root，例如 `*.ts`、`src/**`）。空列表 = 不限
    pub include: Vec<String>,
    /// 排除匹配这些通配的路径。优先级高于 `include`
    pub exclude: Vec<String>,
    /// 把命中换成什么（M2-D）。`None` = 这是一次搜索，不替换。
    ///
    /// ⚠️ **`Some("")` 是合法的**，意思是「把命中的地方删掉」——与 `pattern` 恰好相反，
    /// 那边空串必须拒（空正则匹配每一行，见 [`SearchError::BadPattern`]），这边空串
    /// 正是一个用户真会想要的操作。所以判的是 `is_none()`，不是「为空」。
    ///
    /// 模板语法与错误见 [`Template`]。
    pub replace: Option<String>,
}

/// 搜索**没能开始**的原因。
///
/// 用 `#[serde(tag = "kind")]`，与 `TreeError` / `ReadError` 同一套路数：前端要按类型
/// 分支，把错误压成一个字符串会逼它去 `includes('正则')`。
///
/// ⚠️ 这里**没有** `Io` 变体，是刻意的：遍历途中读不动某个目录或某个文件不是
/// 「搜索失败」，它计入 `SearchSummary::unreadable` 而搜索继续。少搜一个目录
/// 比整次搜索报错有用得多——用户此刻要的是找到东西。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SearchError {
    /// 搜索词本身不能用：空的、含换行、或者正则编不出来
    BadPattern { message: String },
    /// `include` / `exclude` 里的某一条通配编不出来。
    ///
    /// 单独带上那条 `glob`：一个列表里可能有好几条，只说「通配写错了」
    /// 等于让用户挨个试
    BadGlob { glob: String, message: String },
    /// `replace` 模板里的 `$` 用法不支持（M2-D）。
    ///
    /// ⚠️ **报错而不是静默兜底，是刻意与 `regex` 和 JS 的 `replace` 相反的**：
    /// 那两个都把认不出的 `$foo` 当成字面串或空串放过去。放过去的后果是
    /// 用户写了 `$name` 期待命名分组，得到的是**两万处安静地插进一个空串**——
    /// 而这一步是直接改写磁盘上的文件的，没有撤销。
    /// 模板在起飞前就编好了（见 [`build_template`]），当场拒一句的成本是零。
    BadReplacement { message: String },
    /// root 不是绝对路径。防的是**静默的错答案**：相对路径会按 Rust 进程的 cwd 解析，
    /// 而 `.app` 双击启动时 cwd 是 `/`，于是搜的是整个磁盘
    BadRoot { path: String },
    /// root 不存在，或者不是一个目录
    NotFound { path: String },
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SearchError::BadPattern { message } => f.write_str(message),
            SearchError::BadGlob { glob, message } => write!(f, "通配 {glob:?} 不合法：{message}"),
            // message 里已经写清了支持哪几种写法，不再套一层前缀
            SearchError::BadReplacement { message } => f.write_str(message),
            SearchError::BadRoot { path } => write!(f, "项目根目录 {path:?} 不是绝对路径"),
            SearchError::NotFound { path } => write!(f, "找不到 {path}"),
        }
    }
}

/// 编出匹配机。**所有会对用户输入报错的检查都在这里**，所以它必须在遍历之前调。
pub(crate) fn build_matcher(query: &SearchQuery) -> Result<RegexMatcher, SearchError> {
    if query.pattern.is_empty() {
        return Err(SearchError::BadPattern { message: "搜索词不能为空".to_owned() });
    }
    // 搜索是**按行**进行的，所以含换行的搜索词永远匹配不到任何东西。
    // 让它安静地返回 0 条结果，用户会以为仓库里真的没有——一句话的报错比这个好。
    // ⚠️ 检查的是真的换行字节，不是正则里的 `\n` 转义（那是两个字符 `\` 和 `n`，
    // 在正则模式下由 `line_terminator` 那条自己处理）
    if query.pattern.contains('\n') {
        return Err(SearchError::BadPattern {
            message: "搜索是按行进行的，搜索词里不能有换行".to_owned()
        });
    }

    RegexMatcherBuilder::new()
        // `fixed_strings` 就是「.*」开关：字面串模式下 `a.c` 匹配的是 `a.c` 而不是 `axb`。
        // grep-regex 没有 `RegexMatcher::new_literal`，自己转义的话就得再引一个 `regex`
        // 依赖——而这个开关本来就在那儿
        .fixed_strings(query.literal)
        .case_insensitive(!query.case_sensitive)
        .word(query.whole_word)
        // 告诉正则「行终止符是 \n」，于是 `$` 只在行尾成立，且任何想跨行的匹配
        // 都会被引擎自己排除。必须与 `Searcher` 的行终止符一致（它的默认值也是 \n）
        .line_terminator(Some(b'\n'))
        .build(&query.pattern)
        .map_err(|e| SearchError::BadPattern { message: e.to_string() })
}

/// 编译好的替换模板（M2-D）。
///
/// **在编译期就把 `$` 语法解析成一串片段**，而不是每命中一次重新扫一遍模板字符串：
/// 一次替换能命中两万处，而模板自始至终是同一个。
///
/// ## 支持的写法
///
/// | 写法 | 含义 |
/// |---|---|
/// | `$$` | 一个字面的 `$` |
/// | `$&` 或 `$0` | 整个命中 |
/// | `$1` … `$9` | 第 n 个捕获组 |
/// | `${n}` | 同上，**编号是多位数时只能用这一种**（见下） |
///
/// ⚠️ `$12` 读作「第 12 组」而不是「第 1 组后面跟个字面的 2」——**取最长的数字串**。
/// 这与 `regex` crate 相反（它先试两位、编不出来再退回一位），退回规则的失败方式是
/// 「同一个模板在有 12 个组和只有 1 个组的正则上含义不同」，而用户在输入框里
/// 看不见自己的正则有几个括号。要「第 1 组后面跟个 2」就写 `${1}2`。
///
/// ⚠️ **命名分组（`$name` / `${name}` / `$<name>`）与 `` $` `` / `$'`（命中之前/之后
/// 那两段）一律报 [`SearchError::BadReplacement`]**，不像 `regex` 与 JS 那样静默放过去。
/// 理由写在那个变体的文档注释里：这一步是直接改写磁盘上的文件的，没有撤销，
/// 而「期待命名分组、实际插进一个空串」这件事在两万处命中上没有任何可见的迹象。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Template {
    pieces: Vec<Piece>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Piece {
    /// 原样写进结果
    Lit(String),
    /// 取第 n 个捕获组。**`0` 就是「整个命中」**，与 `$&` 同义（`regex` 的规矩），
    /// 于是两种写法落到同一条分支上
    Group(u32),
}

/// `$` 后面认不出来时说的那一句。写成常量是因为四个分支要说同一句话，
/// 抄四遍的失败方式是四处文案各自漂移，用户看到的是「同一种错，四种说法」
const TEMPLATE_SYNTAX: &str = "$ 后面只能跟 $（字面的美元符号）、&（整个命中）、0-9 或 {编号}";

/// 编译替换模板。`query.replace` 为 `None` 时返回 `None`——那是一次纯搜索。
///
/// ⚠️ 需要 `matcher` 是为了**用正则自己的捕获组个数校验模板里的编号**。
/// 少了这一步，`(a)` 配 `$2` 会安静地展开成空串：预览里那一行看起来只是「变短了」，
/// 而它会照样写进磁盘。校验做在起飞前，所以这条错误与正则编不出来一样当场 reject。
pub(crate) fn build_template(query: &SearchQuery, matcher: &RegexMatcher) -> Result<Option<Template>, SearchError> {
    let Some(requested) = query.replace.as_deref() else { return Ok(None) };
    // ⚠️ 模板里的 `\r\n` / `\r` 在**这里**就归一化成 `\n`，与整个 fs 模块那条
    // 「编辑器内部永远是 LF」的规矩对齐。
    //
    // 不在写盘那一侧做，是因为**只在一边做等于让预览说谎**：用户在替换框里粘了一段
    // Windows 文本，模板里于是有个 `\r`。落盘那一侧必须把它归一化掉
    // （否则 `apply_eol` 在 CRLF 档上会写出 `\r\r\n`，读回来每行多一个空行），
    // 归一化之后写进文件的是一个真的换行；而预览要是照着原样展开，
    // `replaced` 里显示的就是一个孤零零的 `\r`——用户批准的和实际发生的不是同一件事。
    // 放在编译模板这一步，两边拿到的是同一个 `Template`，不存在第二种可能。
    //
    // `\n` 本身**放行**：那是「把一处命中换成两行」，一个真会想要的操作，
    // 与搜索词里不许有换行不是一回事（那条是因为搜索按行进行，含换行的搜索词
    // 永远匹配不到任何东西）。UI 怎么在一行里显示它，是面板那一层的问题
    let normalized = normalize_to_lf(requested);
    let raw: &str = &normalized;
    let groups = matcher.capture_count();

    let mut pieces: Vec<Piece> = Vec::new();
    let mut lit = String::new();
    // 攒着的字面串落进 pieces。空串不落：`a$$b` 会攒出 "a"、"$"、"b"，
    // 中间那个 `$` 单独成段的话片段数翻倍而正文一个字符都没多
    fn flush(pieces: &mut Vec<Piece>, lit: &mut String) {
        if !lit.is_empty() {
            pieces.push(Piece::Lit(std::mem::take(lit)));
        }
    }
    /// 编号越界时说的那一句。带上「正则里到底有几个组」：用户此刻看不见自己写的正则
    /// 有几个括号，而 `$2` 配 `(a)` 这种错自己盯半天也盯不出来
    fn out_of_range(n: u32, groups: usize) -> SearchError {
        SearchError::BadReplacement {
            message: format!("正则里只有 {} 个捕获组（含 $0 那个「整个命中」），模板引用了 ${n}", groups - 1),
        }
    }

    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '$' {
            lit.push(chars[i]);
            i += 1;
            continue;
        }
        let Some(&next) = chars.get(i + 1) else {
            return Err(SearchError::BadReplacement { message: format!("模板以 $ 结尾：{TEMPLATE_SYNTAX}") });
        };
        match next {
            '$' => {
                lit.push('$');
                i += 2;
            }
            '&' => {
                flush(&mut pieces, &mut lit);
                pieces.push(Piece::Group(0));
                i += 2;
            }
            // `${12}`：读到 `}` 为止，中间必须全是数字。花括号的存在意义就是消歧——
            // `$1x` 到底是「组 1 加个 x」还是「组 1x」，只有写法本身能回答
            '{' => {
                let rest = &chars[i + 2..];
                let Some(close) = rest.iter().position(|&c| c == '}') else {
                    return Err(SearchError::BadReplacement {
                        message: format!("${{ 没有配对的 }}：{TEMPLATE_SYNTAX}"),
                    });
                };
                let digits: String = rest[..close].iter().collect();
                let n = parse_group(&digits, TEMPLATE_SYNTAX)?;
                if n as usize >= groups {
                    return Err(out_of_range(n, groups));
                }
                flush(&mut pieces, &mut lit);
                pieces.push(Piece::Group(n));
                i += 2 + close + 1;
            }
            '0'..='9' => {
                // **取最长的数字串**，不像 `regex` 那样先试两位再退回一位。
                // 退回规则的失败方式是「同一个模板在有 12 个组和只有 1 个组的正则上
                // 含义不同」，而用户在输入框里看不到自己正则有几个组。
                // 要消歧用 `${1}2`
                let end =
                    (i + 1..chars.len()).take_while(|&j| chars[j].is_ascii_digit()).last().map_or(i + 1, |j| j + 1);
                let digits: String = chars[i + 1..end].iter().collect();
                let n = parse_group(&digits, TEMPLATE_SYNTAX)?;
                if n as usize >= groups {
                    return Err(out_of_range(n, groups));
                }
                flush(&mut pieces, &mut lit);
                pieces.push(Piece::Group(n));
                i = end;
            }
            '<' => {
                return Err(SearchError::BadReplacement {
                    message: "暂不支持 $<名字> 这种命名分组，用 ${1} 这样的编号".to_owned(),
                })
            }
            '`' | '\'' => {
                return Err(SearchError::BadReplacement {
                    message: "暂不支持 $` 与 $'（命中之前/之后的那两段），用 $1 这样的编号取捕获组".to_owned(),
                })
            }
            // 单独挑出「像名字」的那一类：用户打 `$foo` 时十有八九是在找命名分组，
            // 跟他说「认不出这个字符」不如直接说「命名分组不支持，用编号」
            _ if next.is_alphabetic() || next == '_' => {
                return Err(SearchError::BadReplacement {
                    message: "暂不支持 $名字 这种命名分组，用 ${1} 这样的编号".to_owned(),
                })
            }
            _ => {
                return Err(SearchError::BadReplacement {
                    message: format!("认不出 ${next} 这种写法：{TEMPLATE_SYNTAX}"),
                })
            }
        }
    }
    flush(&mut pieces, &mut lit);
    Ok(Some(Template { pieces }))
}

/// 花括号里那一串 → 组号。三种坏法各说一句自己的话，因为用户看到文案之后要做的事不同：
///
/// - **空的**（`${}`）：他漏了编号，那句要说「这里该填一个编号」
/// - **不是数字**（`${name}`）：他十有八九在找命名分组，于是与 `$name` 说**同一句话**。
///   ⚠️ 这一条不能偷懒合并进「太大」：报「捕获组编号 name 太大」是答非所问，
///   用户会去数自己的括号，而真正的问题是这种写法压根不支持
/// - **全是数字但编不成 `u32`**（`$999999999999`）：它确实是个编号，只是不可能是真的
fn parse_group(body: &str, syntax: &str) -> Result<u32, SearchError> {
    if body.is_empty() {
        return Err(SearchError::BadReplacement { message: format!("${{}} 里该是一个编号：{syntax}") });
    }
    if !body.bytes().all(|b| b.is_ascii_digit()) {
        return Err(SearchError::BadReplacement {
            message: "暂不支持 ${名字} 这种命名分组，用 ${1} 这样的编号".to_owned(),
        });
    }
    body.parse::<u32>()
        .map_err(|_| SearchError::BadReplacement { message: format!("捕获组编号 {body} 太大：{syntax}") })
}

impl Template {
    /// 把一整行按模板换完，返回**换后的正文**与**换了几处**。
    ///
    /// ⚠️ **按行**而不是按整份文件：搜索也是按行进行的（`line_terminator` + grep-searcher
    /// 一行一行喂），于是「一行一行换完再用原来的行终止符拼回去」与「整份文件一次换完」
    /// 结果相同，而前者让「命中不跨行」这件事**在结构上成立**，不必依赖正则引擎的配置
    /// 是否正确。这一点很重要：跨行的命中会让「写回的文件」与「预览的那一行」对不上，
    /// 而对不上的方向是安静的。
    ///
    /// 处数一路数出来而不是再跑一遍 `find_iter`：同一次遍历里两个数天然一致，
    /// 分两遍的话「替换了 3 处而报告 4 处」这种不一致没有任何测试能拦住。
    pub(crate) fn expand_line(&self, matcher: &RegexMatcher, line: &str) -> (String, u32) {
        // ⚠️ `new_captures` 与 `replace_with_captures` 都返回 `Result`，而 `RegexMatcher`
        // 的错误类型是 `grep_matcher::NoError`——一个**不可构造**的类型
        // （与搜索侧 `find_iter` 那条同理）。全仓库对它的写法是 `expect` 说明理由，
        // 不是 `unwrap()`：读代码的人不该需要去查那个 Err 到底是什么
        let mut caps = matcher.new_captures().expect("NoError 不可构造");
        // 绑一份出来复用：haystack 与 `expand_into` 里切捕获组用的必须是**同一份字节**，
        // 各切一次的话两边理论上可以指向不同的东西，而 span 是按 haystack 算的
        let bytes = line.as_bytes();
        let mut dst: Vec<u8> = Vec::with_capacity(bytes.len());
        let mut count = 0u32;
        // ⚠️ 用 `replace_with_captures` 而不是自己拿 `captures_iter` 拼：
        // 它自己管「上一处命中的结尾到这一处命中的开头那段原样抄过去」以及
        // **空匹配的推进**（`a*` 这类能匹配零宽的正则，不推进就是死循环）。
        // 那套算术与库里 `replace_with_captures_at` 是同一份，抄一遍只会抄出偏差
        let _ = matcher.replace_with_captures(bytes, &mut caps, &mut dst, |caps, dst| {
            self.expand_into(caps, bytes, dst);
            count += 1;
            true
        });
        // 拼进 `dst` 的只有三种字节，每一种都保证落在字符边界上：
        // ① haystack 里两个 span 之间那一段（`replace_with_captures` 自己抄的）、
        // ② 捕获组那一段（regex 在 UTF-8 模式下不会把一个码点劈成两半）、
        // ③ 模板里的字面串（它本来就是 `&str`）。
        // 所以这一次 `from_utf8` 是**唯一**需要检查边界的地方，而它不会失败
        let text = String::from_utf8(dst).expect("三种来源都是按字符边界切的 UTF-8");
        (text, count)
    }

    /// 把**一次命中**的替换结果追加到 `dst`。
    ///
    /// ⚠️ `line` 收的是 `&[u8]` 而不是 `&str`：这里做的全是字节活（grep-matcher 给出的
    /// span 是**字节**偏移），而收 `&str` 的话每一片都得先 `line[a..b]` 切一次字符串——
    /// 那会在每个切点上各查一次字符边界（clippy 的 `sliced_string_as_bytes` 说的就是这件事）。
    /// 收成字节之后，「切点全落在字符边界上」这条不变量**只在 `expand_line` 结尾那一次
    /// `String::from_utf8` 上检查**，一处、一句话，而不是散在每一次切片里。
    ///
    /// ⚠️ 另外两处照着 `regex` 的直觉写就会红的地方（都是实测出来的）：
    /// `Captures` 在 grep-matcher 里是 **trait**，取组的方法叫 `get(i)` 不是 `at(i)`；
    /// 它返回的 `Match` 把 `start` / `end` 做成了**私有字段 + 同名方法**，
    /// 而 `regex::Match` 那两个是公开字段。`.start` 写下去报的是 E0616「字段是私有的」，
    /// 长得像权限问题，其实是拼写问题
    fn expand_into(&self, caps: &impl Captures, line: &[u8], dst: &mut Vec<u8>) {
        for piece in &self.pieces {
            match piece {
                Piece::Lit(text) => dst.extend_from_slice(text.as_bytes()),
                // 越界的组号展开成空串。⚠️ 正常情况下到不了这一支：`build_template`
                // 已经用 `capture_count` 拦过了。留着是因为「组存在但这次没参与匹配」
                // 是**合法的**（`(a)|(b)` 命中 `a` 时第 2 组就是 None），
                // 而 `regex` 与 JS 对它的处理都是空串
                Piece::Group(n) => {
                    if let Some(span) = caps.get(*n as usize) {
                        dst.extend_from_slice(&line[span.start()..span.end()]);
                    }
                }
            }
        }
    }
}

/// 编译好的 include / exclude。`None` 表示「那一边没有条件」。
#[derive(Debug)]
pub(crate) struct Filters {
    pub(crate) include: Option<GlobSet>,
    pub(crate) exclude: Option<GlobSet>,
}

impl Filters {
    /// 一条相对路径（`DirEntry.rel` 那一套规矩：`/` 分隔、不以 `/` 开头）该不该搜。
    ///
    /// **exclude 先判，而且判赢**：两个列表都命中时排除。理由是「我明确说了不要它」
    /// 比「我说的范围里包含它」更具体——与 ripgrep 的 `-g '!x'` 同向。
    pub(crate) fn allows(&self, rel: &str) -> bool {
        if self.exclude.as_ref().is_some_and(|set| set.is_match(rel)) {
            return false;
        }
        match &self.include {
            Some(set) => set.is_match(rel),
            None => true,
        }
    }
}

pub(crate) fn build_filters(query: &SearchQuery) -> Result<Filters, SearchError> {
    Ok(Filters { include: glob_set(&query.include)?, exclude: glob_set(&query.exclude)? })
}

/// 把一串通配编成一个 `GlobSet`。
///
/// ⚠️ **全是空串时返回 `None` 而不是一个空的 `GlobSet`。** 空集合在 include 那一侧的含义是
/// 「什么都不匹配」，于是用户会在界面上看到「0 个结果」而没有任何解释——
/// 而他其实只是在一个文本框里打了个空格。「没有条件」与「条件匹配不到任何东西」
/// 是两件事，不能让一个笔误从前者滑到后者。
///
/// **不 trim、也不按逗号拆**：那是前端在把文本框变成列表时的事
/// （它知道用户打的是 `*.ts, *.md` 还是真的想要一个含空格的通配）。
fn glob_set(patterns: &[String]) -> Result<Option<GlobSet>, SearchError> {
    let kept: Vec<&str> = patterns.iter().map(String::as_str).filter(|p| !p.is_empty()).collect();
    if kept.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    // `iter().copied()` 而不是 `for pattern in kept`：下面那个错误分支还要用 `kept`
    // 拼出「这几条合起来不行」，移走了就没了
    for pattern in kept.iter().copied() {
        let glob = Glob::new(pattern)
            .map_err(|e| SearchError::BadGlob { glob: pattern.to_owned(), message: e.to_string() })?;
        builder.add(glob);
    }
    // 每一条 `Glob::new` 都过了才会走到这里，所以这个 `build` 失败只可能是合集合时
    // 的内部错误。报成「这几条合起来不行」而不是编一个假的 glob 名字
    builder.build().map(Some).map_err(|e| SearchError::BadGlob { glob: kept.join("  "), message: e.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use grep_matcher::Matcher;

    fn query(pattern: &str) -> SearchQuery {
        SearchQuery { pattern: pattern.to_owned(), ..SearchQuery::default() }
    }

    /// 命中数用「一段文本里找出几个」来数，比断言 `Matcher` 的内部状态稳。
    ///
    /// `find_iter` 的 Err 类型是 `grep_matcher::NoError`，不可构造，所以 `let _ =` 丢掉的
    /// 永远是 `Ok`。生产代码那一处（`run.rs` 的 `make_hit`）用的是 `expect`，理由相同。
    fn count(matcher: &RegexMatcher, text: &str) -> usize {
        let mut n = 0;
        let _ = matcher.find_iter(text.as_bytes(), |_| {
            n += 1;
            true
        });
        n
    }

    fn ranges_of(matcher: &RegexMatcher, text: &str) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let _ = matcher.find_iter(text.as_bytes(), |m| {
            out.push((m.start(), m.end()));
            true
        });
        out
    }

    // ── 三个开关 ────────────────────────────────────────────────────────────

    #[test]
    fn 默认是正则且不区分大小写() {
        let matcher = build_matcher(&query("a.c")).unwrap();
        assert_eq!(count(&matcher, "abc ABC a-c"), 3);
    }

    #[test]
    fn literal_关掉之后点号就是点号() {
        let matcher = build_matcher(&SearchQuery { literal: true, ..query("a.c") }).unwrap();
        // 正则模式下这三段全都命中（`.` 匹配任意字符），字面模式下只有真写了 `a.c` 的那一处
        let text = "abc a.c a-c";
        assert_eq!(count(&matcher, text), 1);
        assert_eq!(ranges_of(&matcher, text), [(4, 7)]);
    }

    #[test]
    fn case_sensitive_打开之后大小写要对上() {
        let matcher = build_matcher(&SearchQuery { case_sensitive: true, ..query("abc") }).unwrap();
        assert_eq!(count(&matcher, "abc ABC Abc"), 1);
    }

    #[test]
    fn whole_word_要求命中落在词边界上() {
        let matcher = build_matcher(&SearchQuery { whole_word: true, ..query("cat") }).unwrap();
        // `concat` 里那个不算（左边是词字符），`cat's` 那个算（撇号不是词字符）
        assert_eq!(count(&matcher, "cat concat cat's a cat"), 3);
    }

    /// `literal` 与 `whole_word` 同时开：字面串仍然要落在词边界上。
    ///
    /// 这一条值得单独钉：`fixed_strings` 走的是「编成字面量交替」的另一条路径，
    /// 词边界是外挂上去的，两条机制叠在一起最容易只生效一半。
    #[test]
    fn literal_与_whole_word_可以同时开() {
        let matcher = build_matcher(&SearchQuery { literal: true, whole_word: true, ..query("a.c") }).unwrap();
        assert_eq!(count(&matcher, "a.c xa.cx"), 1);
    }

    /// 搜索是**按行**的，所以跨行的搜索词在结构上不可能命中。
    ///
    /// 与其让它安静地返回 0 条（用户会以为仓库里没有），不如当场说一句。
    #[test]
    fn 含换行的搜索词被拒() {
        assert_eq!(
            build_matcher(&query("a\nb")).unwrap_err(),
            SearchError::BadPattern { message: "搜索是按行进行的，搜索词里不能有换行".to_owned() }
        );
    }

    #[test]
    fn 空搜索词被拒_因为它会匹配每一行() {
        assert_eq!(
            build_matcher(&query("")).unwrap_err(),
            SearchError::BadPattern { message: "搜索词不能为空".to_owned() }
        );
        // 证明「空正则会匹配」不是想象出来的：这一条要是哪天不成立了，
        // 上面那句拒绝就该重新考虑（不拒的话用户会收到一堆与他的意图无关的结果）
        assert!(count(&RegexMatcher::new("").unwrap(), "a\nb\nc") > 0);
    }

    #[test]
    fn 编不出来的正则报_bad_pattern_并且带上引擎自己的话() {
        match build_matcher(&query("(没关上")).unwrap_err() {
            SearchError::BadPattern { message } => assert!(!message.is_empty(), "要把引擎的话带给用户"),
            other => panic!("应该是 BadPattern，实际是 {other:?}"),
        }
    }

    #[test]
    fn 中文与正则元字符在_literal_模式下原样匹配() {
        let matcher = build_matcher(&SearchQuery { literal: true, ..query("落霞|孤鹜") }).unwrap();
        assert_eq!(count(&matcher, "落霞|孤鹜 落霞 孤鹜"), 1, "竖线在字面模式下不是「或」");
    }

    // ── include / exclude ───────────────────────────────────────────────────

    fn allows(query: &SearchQuery, rel: &str) -> bool {
        build_filters(query).unwrap().allows(rel)
    }

    #[test]
    fn 两个列表都空时什么都放行() {
        let q = query("x");
        let filters = build_filters(&q).unwrap();
        assert!(filters.include.is_none() && filters.exclude.is_none());
        for rel in ["a.ts", "src/a.ts", "node_modules/x/index.js"] {
            assert!(allows(&q, rel), "{rel}");
        }
    }

    /// ⚠️ `*` **跨过** `/`（globset 的 `literal_separator` 默认关）。
    ///
    /// 这正是想要的：用户在 include 里打 `*.ts`，他要的是「所有 ts 文件」，
    /// 不是「只有顶层的 ts 文件」。ripgrep 的 `-g '*.rs'` 同样是这个语义。
    #[test]
    fn include_的星号跨过目录分隔符() {
        let q = SearchQuery { include: vec!["*.ts".to_owned()], ..query("x") };
        assert!(allows(&q, "a.ts"));
        assert!(allows(&q, "src/deep/a.ts"));
        assert!(!allows(&q, "a.tsx"));
        assert!(!allows(&q, "src/a.js"));
    }

    #[test]
    fn include_可以有多条_命中任意一条就放行() {
        let q = SearchQuery { include: vec!["*.ts".to_owned(), "*.md".to_owned()], ..query("x") };
        assert!(allows(&q, "src/a.ts"));
        assert!(allows(&q, "README.md"));
        assert!(!allows(&q, "src/a.js"));
    }

    #[test]
    fn exclude_判赢_include() {
        let q =
            SearchQuery { include: vec!["*.ts".to_owned()], exclude: vec!["src/generated/*".to_owned()], ..query("x") };
        assert!(allows(&q, "src/a.ts"));
        assert!(!allows(&q, "src/generated/a.ts"), "两个列表都命中时排除赢");
    }

    #[test]
    fn exclude_单独用也行() {
        let q = SearchQuery { exclude: vec!["*.min.js".to_owned()], ..query("x") };
        assert!(allows(&q, "src/a.ts"));
        assert!(!allows(&q, "dist/vendor.min.js"));
    }

    /// **全是空串时必须当成「没有条件」，不能编出一个空集合。**
    ///
    /// 空集合在 include 那一侧的含义是「什么都不匹配」，于是用户打了个空格就得到
    /// 「0 个结果」而没有任何解释。「没有条件」与「条件匹配不到任何东西」是两件事。
    #[test]
    fn 空串的条件被丢掉_而不是变成一个匹配不到任何东西的集合() {
        let q = SearchQuery { include: vec!["".to_owned(), "".to_owned()], ..query("x") };
        assert!(build_filters(&q).unwrap().include.is_none());
        assert!(allows(&q, "src/a.ts"));

        // exclude 那一侧同样丢掉：留着的话它永远不命中，行为上没差别，
        // 但两边一致才好解释
        let q = SearchQuery { exclude: vec!["".to_owned()], ..query("x") };
        assert!(build_filters(&q).unwrap().exclude.is_none());
    }

    #[test]
    fn 编不出来的通配报_bad_glob_并且点名是哪一条() {
        let q = SearchQuery { include: vec!["*.ts".to_owned(), "[".to_owned()], ..query("x") };
        match build_filters(&q).unwrap_err() {
            SearchError::BadGlob { glob, message } => {
                assert_eq!(glob, "[", "列表里有好几条，必须点名");
                assert!(!message.is_empty());
            }
            other => panic!("应该是 BadGlob，实际是 {other:?}"),
        }
    }

    // ── M2-D 替换模板 ───────────────────────────────────────────────────────
    //
    // 这一节钉的是「`$` 语法」这一件事：认哪些写法、拒哪些写法、认下来的展开成什么。
    // **展开用的函数与落盘用的是同一个**（`expand_line`，M2-D-2 的写盘那条路也调它），
    // 所以这里绿了，「预览所见」与「落盘所做」在模板语法上就不可能分岔。

    /// 用 `pattern` 编一台匹配机、把 `template` 编成模板，然后对 `line` 换一遍。
    ///
    /// ⚠️ 编译模板与展开**必须由同一台 matcher 做**——这正是 `run::Prepared` 存在的理由，
    /// 测试里也不能破例：破了例的话这些用例就测不出「组号越界」那条校验了
    fn expand(pattern: &str, template: &str, line: &str) -> (String, u32) {
        let q = SearchQuery { replace: Some(template.to_owned()), ..query(pattern) };
        let matcher = build_matcher(&q).unwrap();
        let compiled = build_template(&q, &matcher).unwrap().expect("发了 replace 就该编出模板");
        compiled.expand_line(&matcher, line)
    }

    /// 只编译、不展开。断言「这一种写法被拒了」，并把文案取出来核对——
    /// 文案是用户唯一能看到的东西，只断言 `is_err()` 的话四句不同的错可以漂成一句
    fn template_error(pattern: &str, template: &str) -> String {
        let q = SearchQuery { replace: Some(template.to_owned()), ..query(pattern) };
        let matcher = build_matcher(&q).unwrap();
        match build_template(&q, &matcher).unwrap_err() {
            SearchError::BadReplacement { message } => message,
            other => panic!("应该是 BadReplacement，实际是 {other:?}"),
        }
    }

    #[test]
    fn 没发_replace_时编不出模板_那是一次纯搜索() {
        let q = query("needle");
        let matcher = build_matcher(&q).unwrap();
        assert!(build_template(&q, &matcher).unwrap().is_none());
        // `Some("")` 与 `None` 是两件事：前者是「把命中的地方删掉」，后者是「不替换」。
        // 判错方向的后果是两万个文件被清空，所以这一条单独钉
        let q = SearchQuery { replace: Some(String::new()), ..q };
        assert!(build_template(&q, &matcher).unwrap().is_some());
    }

    #[test]
    fn 字面量模板把命中处换掉_没命中的部分一个字都不动() {
        assert_eq!(expand("needle", "haystack", "let a = needle;"), ("let a = haystack;".to_owned(), 1));
        // 空模板 = 删除。这是用户真会想要的操作，不能与「没发 replace」混为一谈
        assert_eq!(expand("needle", "", "let a = needle;"), ("let a = ;".to_owned(), 1));
        // 一行里有多处时**每处都换**，处数与换的次数是同一个数
        assert_eq!(expand("a", "b", "aaa"), ("bbb".to_owned(), 3));
        // 没命中的行原样返回，处数为 0。⚠️ 落盘那条路靠这个 0 决定「这个文件不改」，
        // 于是「不改一个字时文件字节完全不变」这件事有得可测
        assert_eq!(expand("needle", "x", "nothing here"), ("nothing here".to_owned(), 0));
    }

    #[test]
    fn 两个美元符号展开成一个字面的美元符号() {
        assert_eq!(expand("needle", "$$", "a needle b"), ("a $ b".to_owned(), 1));
        // ⚠️ `$$&` 是「一个 `$` 再跟一个字面的 `&`」，**不是**「一个 `$` 加整个命中」：
        // `$$` 先被吃成转义，剩下的 `&` 就只是普通字符。这与 JS 的 `String.replace`
        // 和 `regex` crate 完全一致，而一致是有价值的——用户是从那边带习惯过来的。
        // 真要「$ 加整个命中」得写 `$$$&`
        assert_eq!(expand("n", "$$&", "n"), ("$&".to_owned(), 1));
        assert_eq!(expand("n", "$$$&", "n"), ("$n".to_owned(), 1));
    }

    #[test]
    fn 整个命中可以用_和_0_两种写法取到() {
        assert_eq!(expand("n(eed)le", "[$&]", "a needle b"), ("a [needle] b".to_owned(), 1));
        // `$0` 是 `regex` 的规矩（第 0 组就是整个命中），与 `$&` 落到同一条分支上
        assert_eq!(expand("n(eed)le", "[$0]", "a needle b"), ("a [needle] b".to_owned(), 1));
    }

    #[test]
    fn 捕获组按编号取_花括号是为了消歧() {
        assert_eq!(expand(r"(\w+)@(\w+)", "$2/$1", "a@b"), ("b/a".to_owned(), 1));
        assert_eq!(expand(r"(\w+)@(\w+)", "${2}/${1}", "a@b"), ("b/a".to_owned(), 1));
        // `${1}2` 是「第 1 组后面跟个字面的 2」。没有花括号的话 `$12` 会被读成第 12 组，
        // 于是这里必须写花括号——这条断言钉的就是「花括号真的能消歧」
        assert_eq!(expand(r"(a)", "${1}2", "a"), ("a2".to_owned(), 1));
    }

    #[test]
    fn 多位数编号取最长的数字串_不退回一位() {
        // `(a)(b)` 只有两个组，`$12` 因此是**越界**而不是「第 1 组加个字面的 2」。
        // `regex` 在这里会退回一位并安静地给出 `a2`；我们报错，
        // 因为「同一个模板在不同正则上含义不同」这件事用户在输入框里看不出来
        let message = template_error(r"(a)(b)", "$12");
        assert!(message.contains('2'), "该点名越界的编号：{message}");
        assert!(message.contains("捕获组"), "{message}");
        // 组够多的时候 `$12` 就是第 12 组。⚠️ 十二个组各匹配一个**不同**的字母，
        // 于是 `$12` 与 `$1` 的答案不一样——相同的话这条断言就区分不出
        // 「读了两位」与「读了一位再跟个字面的 2」（后者会给出 `a2`）
        let twelve = "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)";
        assert_eq!(expand(twelve, "$12", "abcdefghijkl"), ("l".to_owned(), 1));
        assert_eq!(expand(twelve, "$1", "abcdefghijkl"), ("a".to_owned(), 1));
        assert_eq!(expand(twelve, "${1}2", "abcdefghijkl"), ("a2".to_owned(), 1));
    }

    #[test]
    fn 组存在但这次没参与匹配时展开成空串() {
        // `(a)|(b)` 命中 `b` 时第 1 组是 None。这是**合法**的（不是越界），
        // 而 `regex` 与 JS 对它的处理都是空串，所以这里不报错
        assert_eq!(expand("(a)|(b)", "[$1]", "b"), ("[]".to_owned(), 1));
        assert_eq!(expand("(a)|(b)", "[$2]", "b"), ("[b]".to_owned(), 1));
    }

    #[test]
    fn 零宽命中不会让展开变成死循环() {
        // `a*` 能匹配空串。展开逻辑委托给 `replace_with_captures`，
        // 它自己管「空匹配之后往前推一格」——这条测试钉的就是那个推进真的在。
        // 少了它的话这里不是红，是**挂住**：CI 会超时，而本地要手动 kill
        let (text, count) = expand("a*", "X", "bb");
        assert_eq!(text, "XbXbX");
        assert_eq!(count, 3);
    }

    #[test]
    fn 多字节字符在正文与模板里都不会被劈开() {
        // `expand_line` 结尾那句 `String::from_utf8(..).expect(..)` 的全部依据：
        // haystack 是 `&str`、模板里的字面串也是 `&str`，而 regex 在 UTF-8 模式下
        // 切出来的每个 span 都落在字符边界上。这条测试用 CJK 与 emoji 各试一次
        assert_eq!(expand("needle", "«$&»", "中文 needle 中文"), ("中文 «needle» 中文".to_owned(), 1));
        assert_eq!(expand("(🎉)", "$1$1", "a🎉b"), ("a🎉🎉b".to_owned(), 1));
        // 命中本身就是多字节字符的一部分时也一样
        assert_eq!(expand("中文", "CN", "中文中文"), ("CNCN".to_owned(), 2));
    }

    #[test]
    fn 命名分组的三种写法一律被拒() {
        for template in ["$name", "${name}", "$<name>"] {
            let message = template_error("(a)", template);
            assert!(message.contains("命名分组"), "{template} 该说清是命名分组不支持：{message}");
            assert!(message.contains("${1}"), "该给出可用的替代写法：{message}");
        }
        // ⚠️ `$name` 单独有一条更贴切的文案：用户打它的时候十有八九就是在找命名分组，
        // 跟他说「认不出这个字符」不如直接说「不支持，用编号」。
        // 而 `$+` 这种是真的认不出，走的是另一句
        assert!(template_error("(a)", "$name").contains("暂不支持"));
        assert!(template_error("(a)", "$+").contains("认不出"));
    }

    #[test]
    fn 命中之前与之后的那两段也不支持() {
        // JS 的 `$`` 与 `$'`。不支持的理由与命名分组同一条：认不出来还静默放过去的话，
        // 用户得到的是两万处安静地插进一段他没要的东西
        for template in ["$`", "$'"] {
            let message = template_error("a", template);
            assert!(message.contains("暂不支持"), "{template}: {message}");
        }
    }

    #[test]
    fn 组号越界时报错_并且说出正则里到底有几个组() {
        // `$0` 是「整个命中」，所以它永远合法；从 `$1` 起才可能越界
        assert_eq!(expand("a", "$0", "a"), ("a".to_owned(), 1));
        let message = template_error("(a)", "$2");
        // 「正则里只有 1 个捕获组」——`groups - 1` 那个减一减的就是 `$0`
        assert!(message.contains("只有 1 个捕获组"), "{message}");
        assert!(message.contains("$2"), "该点名越界的那一个：{message}");
        // 一个组都没有的正则：`$1` 就越界，而 `$0` 照样能用
        assert!(template_error("a", "$1").contains("只有 0 个捕获组"));
    }

    #[test]
    fn 模板本身写坏了也报_bad_replacement() {
        // 以 `$` 结尾：后面什么都没有，无从判断用户想要哪种写法
        assert!(template_error("a", "x$").contains("以 $ 结尾"));
        // `${` 没有配对的 `}`
        assert!(template_error("a", "${1").contains("没有配对"));
        // 花括号里不是数字 → 与 `$name` 同一句话（用户要找的是命名分组，
        // 报「编号太大」是答非所问，见 `parse_group` 的文档）
        assert!(template_error("a", "${x}").contains("命名分组"));
        // 花括号是空的
        assert!(template_error("a", "${}").contains("该是一个编号"));
        // 一长串数字：它确实是个编号，只是不可能是真的。报「太大」比报「认不出」准
        assert!(template_error("a", "$999999999999").contains("太大"));
        assert!(template_error("a", "${999999999999}").contains("太大"));
        // 真的认不出的字符
        assert!(template_error("a", "$-").contains("认不出"));
        assert!(template_error("a", "$ ").contains("认不出"));
    }

    /// 模板里的 `\r\n` 与孤零零的 `\r` 在编译时就变成 `\n`。
    ///
    /// ⚠️ 这条钉的不是「格式好看」，而是**预览与落盘说的是同一件事**：
    /// 落盘那一侧必须归一化（否则 `apply_eol` 在 CRLF 档上写出 `\r\r\n`），
    /// 而它归一化之后写进去的是一个真的换行。预览要是照着原样展开，
    /// `replaced` 里就是一个 `\r`——用户批准的和实际发生的不是同一件事。
    /// 归一化只做在编译这一步，两边就不可能分岔。理由写在 `build_template` 上
    #[test]
    fn 模板里的回车在编译时就归一化成换行() {
        // CRLF：两个字符变成一个
        assert_eq!(expand("a", "x\r\ny", "a").0, "x\ny");
        // 孤零零的 CR
        assert_eq!(expand("a", "x\ry", "a").0, "x\ny");
        // 只有 CR 的模板
        assert_eq!(expand("a", "\r", "a").0, "\n");
        // 换行本身放行，而且处数照样数得对
        assert_eq!(expand("a", "1\n2", "aaa"), ("1\n21\n21\n2".to_owned(), 3));
        // 归一化不影响 `$` 语法：`\r` 夹在 `$` 与它后面的字符之间时，
        // 先归一化再解析，于是 `$\n1` 不是「第 1 组」而是「认不出 $\n」
        assert!(template_error("a", "$\r1").contains("认不出"));
        // ⚠️ 这里的正则必须真能匹配上那一行，否则 `expand_line` 原样返回，
        // 「归一化成了 \n」与「压根没换」两种情况分不出来
        assert_eq!(expand("(x)", "$1\r", "x").0, "x\n");
    }

    // ── 线上形状 ────────────────────────────────────────────────────────────
    //
    // `SearchQuery` / `SearchError` 的黄金 JSON 不在这里，在
    // `crates/vela-core/tests/wire_contract.rs` 的「M2-C 全文搜索」那一节。
    // 契约测试只能用 pub 的东西，放 `tests/` 才逼得住这条边界；对照的前端快照是
    // `src/ipc/search.test.ts`。
}
