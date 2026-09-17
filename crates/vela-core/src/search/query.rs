//! 把用户在输入框里打的那串字符变成一台匹配机 + 一组路径过滤（PLAN.md §3.4 M2-C）。
//!
//! 这一层单独一个文件，是因为它是搜索里**唯一会对用户输入报错**的地方：正则编不出来、
//! 通配编不出来、root 不对，三件事都必须在遍历开始之前判完（理由见 `mod.rs` 最后一条）。
//! 把它们与遍历混在一起，「搜索没找到」与「搜索没跑起来」就会共用一个出口。

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use serde::{Deserialize, Serialize};

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

    // ── 线上形状 ────────────────────────────────────────────────────────────
    //
    // `SearchQuery` / `SearchError` 的黄金 JSON 不在这里，在
    // `crates/vela-core/tests/wire_contract.rs` 的「M2-C 全文搜索」那一节。
    // 契约测试只能用 pub 的东西，放 `tests/` 才逼得住这条边界；对照的前端快照是
    // `src/ipc/search.test.ts`。
}
