//! 全局替换的**落盘**那一半（PLAN.md §3.4 M2-D-2）。
//!
//! 与 `run.rs` 那一半（预览）的关系只有一句话：**遍历同一个函数、匹配机同一个对象、
//! 展开同一个函数**。三样都共用，于是「预览里看到的」与「写进磁盘的」不可能不一致——
//! 不是靠两边测试都过才一致，是靠结构上只有一份实现。
//!
//! ## ⚠️ 这一层是 Vela 里唯一一处「不可撤销地改用户磁盘上的东西」
//!
//! 保存文件也是写盘，但那是用户自己按的 ⌘S，改的是他正在看的那一个文件，而且编辑器里
//! 还有撤销栈。这里是一次按键改**两万个文件**，Vela 没有跨文件撤销，改坏了只能靠
//! `git checkout`——而用户搜的很可能正是一个不在 git 里的目录。
//!
//! 所以这一层的每一个「不确定」都倒向**不写**，并且各自有一个计数器把这件事说出来。
//! 少改一个文件是「报告里多一行」，改坏一个文件是「用户三个月后才发现」。
//!
//! ## 三种「不确定」，三个计数器，三次不写
//!
//! | 计数器 | 触发条件 | 为什么不能写 |
//! |---|---|---|
//! | `skipped_binary` | 原始字节里有 NUL | 那是 `.png` / `.woff2` / `pack-*.idx`，正则在上面命中的是一段碰巧相同的字节。写回去等于把二进制文件按文本重排一遍 |
//! | `skipped_lossy` | `decode` 报了有损 | 解码时已经有字节被换成 U+FFFD 了，写回去就是把那个替换字符**永久焊进**用户的文件 |
//! | `skipped_unmappable` | `encode` 报了映射不出 | 替换模板引入了原编码写不出的字符（往 GBK 文件里换进一个 emoji）。这时文件还没写，拦住是零成本的 |
//!
//! ⚠️ 第三条是**先编码再写**换来的。`fs::write_text_atomic` 是「先写、再在
//! `WriteReport.unmappable` 里告诉你」——对保存文件来说那没问题（用户看得见结果），
//! 对这里不行：等报告回来的时候磁盘上已经是一堆 U+FFFD 了。所以这一层不调它，
//! 自己把 `encode` → 判断 → `write_bytes_atomic` 三步摆开。
//!
//! ## ⚠️ 二进制判定比搜索那一侧**更严**，而这个不一致是刻意的
//!
//! 搜索用 `BinaryDetection::quit(0)`：NUL 出现在很后面时，前面那些缓冲里的命中**留着**。
//! 那是搜索的正确取舍（只读的，少报不如多报）。这里见到任何一个 NUL 就整个文件不碰。
//! 两边不一致的方向是安全的：**预览里出现、落盘时跳过**，最坏结果是「少改一个文件」，
//! 而它被 `skipped_binary` 说出来。反过来的不一致（预览没显示、落盘却改了）才是
//! 不可接受的，而那种情况在结构上不可能——落盘走的文件集是预览那个的子集。
//!
//! ## ⚠️ 单个文件的上限只管**报**，不管**做**
//!
//! 搜索侧一个文件最多报 `MAX_HITS_PER_FILE`（500）条，超了就截断。这里**换到底**：
//! 一个有 600 处命中的文件，600 处全换。半份替换的文件比「一个都没换」和「全换了」
//! 都糟——它是三种状态里唯一一种让文件处于「谁也不认识」的样子的。
//! 代价是预览里那 500 条之外的 100 处用户没见过，所以 `replacements` 必须如实报出来，
//! 让 UI 有机会说清「预览里显示 500 处，实际换了 600 处」。
//!
//! 全局的 `MAX_HITS`（20000）**照样生效**：撞到了就整个停下来，`truncated` 为真。
//! 这一条与预览同一把尺子，于是「预览说 truncated」与「落盘说 truncated」是同一件事。
//!
//! ## ⚠️ 不走 `fs::read_text`，因为两条路的大小上限不一样
//!
//! `read_text` 的闸是 `MAX_INLINE_BYTES` = 4 MiB（那是单次 IPC payload 的限制），
//! 遍历这一层的闸是 `MAX_FILE_BYTES` = 10 MiB。调它的话 4–10 MiB 的文件
//! **在预览里出现、在落盘时被跳过**——正是上面那条「用户批准一份清单、改的是另一份」。
//! 所以这里把七个公开原语自己摆一遍：`fs::read`、`decode`、`detect_eol`、
//! `normalize_to_lf`、`apply_eol`、`encode`、`write_bytes_atomic`。摆两遍的代价是
//! 十几行代码，换来的是两条路覆盖同一个文件集。

use std::borrow::Cow;
use std::collections::HashSet;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use grep_regex::RegexMatcher;
use serde::{Deserialize, Serialize};

use super::query::{SearchError, SearchQuery, Template};
use super::run::{prepare, walk_files, WalkOutcome, HEARTBEAT_FILES, HEARTBEAT_MS, MAX_HITS};
use crate::fs::{apply_eol, decode, detect_eol, encode, normalize_to_lf, write_bytes_atomic};

/// 一次落盘替换的请求。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    /// 与预览**完全同一个** `SearchQuery`，`replace` 必须是 `Some`。
    ///
    /// ⚠️ 前端必须把预览时用过的那一份原样传回来，不能重新构造一个「看起来一样」的：
    /// 三个开关里任何一个不同，写进磁盘的就不是用户批准的那份改动
    pub query: SearchQuery,
    /// **不要碰**的文件，绝对路径。
    ///
    /// 用途是「已经打开且有未保存改动的标签页」：那些文件的磁盘版本不是用户在看的版本，
    /// 改了它，用户下次一按 ⌘S 就会把改动盖回去，而且是静默地盖。
    ///
    /// ⚠️ 比对用的是 `Path` 相等，也就是**逐组件比**：不解析符号链接、不化简 `..`、
    /// 不管大小写。这是刻意的——前端手上的绝对路径本来就是从树或打开对话框里拿到的
    /// 那一份，与遍历给出的路径同源。要是在这里做 canonicalize，两边的解析时机不同
    /// （中间可能有文件被删/被建），反而会出现「同一个文件解析成两个路径」
    #[serde(default)]
    pub skip: Vec<String>,
}

/// 进度快照。累计值，不是增量——理由与搜索侧批次里那个 `files_scanned` 相同：
/// 增量要求两边对「什么时候清零」达成一致，而那种约定的失败方式是进度条悄悄倒退或翻倍
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceProgress {
    pub files_scanned: u32,
    pub files_changed: u32,
    pub replacements: u32,
}

/// 一次落盘替换的总账。
///
/// ⚠️ **每一个「没改成」的原因都有自己的字段**，不合成一个 `skipped`：
/// 用户在结果条上读到「跳过 3 个」时，「3 个二进制文件」与「3 个写失败」
/// 该做的事完全不同——前者什么都不用做，后者要去查权限。合成一个数的话，
/// 唯一的追查办法是让用户自己再搜一遍看是哪三个
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSummary {
    /// 读过并尝试替换的文件数。`skip` 里的、太大的、读不动的都**不算**
    pub files_scanned: u32,
    /// 真的写了盘的文件数
    pub files_changed: u32,
    /// 真的换掉的处数
    pub replacements: u32,
    pub skipped_binary: u32,
    pub skipped_lossy: u32,
    pub skipped_unmappable: u32,
    /// 超过 `MAX_FILE_BYTES`，遍历那一层就没碰
    pub skipped_too_large: u32,
    /// 在 `ReplaceRequest::skip` 里（已打开且有未保存改动）
    pub skipped_open: u32,
    /// 目录读不动 + 文件读不动，两者合一（与搜索侧同一个口径）
    pub unreadable: u32,
    /// 内容算好了、写盘失败了（权限、磁盘满、途中被删）
    pub write_failed: u32,
    /// 撞到 `MAX_HITS` 提前停了
    pub truncated: bool,
    /// 是被取消的，不是走完了
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

/// 落盘替换的起飞前检查。规矩与 `search::preflight` 完全一致（共用 `prepare`），
/// 只多一条：`replace` 必须是 `Some`，否则这就是一次搜索，走错门了。
///
/// 前端因此保住同一条规则：**invoke reject = 一个文件都没被改**
pub fn preflight_apply(root: &Path, request: &ReplaceRequest) -> Result<(), SearchError> {
    prepare(root, &request.query).and_then(|prepared| need_template(&prepared.template))
}

/// `replace` 为 `None` 时那一句报错。两个入口共用，于是它们不可能说出两句话
fn need_template(template: &Option<Template>) -> Result<(), SearchError> {
    if template.is_some() {
        Ok(())
    } else {
        Err(SearchError::BadReplacement { message: "缺少替换内容：replace 不能为 null".to_owned() })
    }
}

/// 走一遍 `root`，把每一处命中换成模板的结果并原子写盘。
///
/// ⚠️ **调用方必须已经让用户看过预览并确认过**。这个函数自己不会问：
/// 它拿到一个 `ReplaceRequest` 就开始改文件。确认对话框是命令层与 UI 的责任，
/// 而「有没有确认过」这件事在这一层的签名上看不出来——所以这句话只能写在这里，
/// 编译器帮不上忙
pub fn apply<F>(
    root: &Path,
    request: &ReplaceRequest,
    cancel: &AtomicBool,
    on_progress: F,
) -> Result<ReplaceSummary, SearchError>
where
    F: FnMut(ReplaceProgress),
{
    let prepared = prepare(root, &request.query)?;
    need_template(&prepared.template)?;
    // ⚠️ 上面已经判过一次，这里的 `expect` 因此不是「赌它不会失败」。
    // 而 release 档是 `panic = "abort"`——真走到这一支就是整个编辑器被带走，
    // 连带用户还没保存的东西。所以宁可判两次：一次为了给出人能读的错误，
    // 一次为了把「两次判断之间被人改掉」这种不可能也堵死
    let template = prepared.template.expect("need_template 刚判过");

    let started = Instant::now();
    let mut run = Apply {
        matcher: prepared.matcher,
        template,
        skip: request.skip.iter().map(PathBuf::from).collect(),
        sink: Sink::new(on_progress),
        tally: Tally::default(),
    };
    // 遍历与预览共用 `walk_files` 这一个实现，理由写在那个函数上
    let outcome = walk_files(root, &prepared.filters, cancel, |path, _rel| run.visit(path));
    run.tally.absorb(outcome);
    // 结尾刻意**不**补一次进度：下一行返回的 `ReplaceSummary` 才是终止信号，
    // 在它前面多推一个快照只是让前端在「最后一次进度」与「done」之间多插一帧
    Ok(run.tally.into_summary(started.elapsed().as_millis() as u64))
}

/// 一次落盘替换的可变状态。
///
/// ⚠️ **这里没有 `cancel` 字段**：取消由 [`walk_files`] 逐个条目检查，粒度就是
/// 「一个文件」，与搜索侧完全相同。自己再存一份的话就有两处读同一个原子量，
/// 而两处的检查时机不同会让「取消之后还改了几个」变成一个说不清的数
struct Apply<F> {
    /// ⚠️ 与下面那个 `template` 是 `prepare` 一起编出来的那一对，理由写在
    /// `run::Prepared` 上：模板里的组号是拿**这台**匹配机的 `capture_count()` 校验过的
    matcher: RegexMatcher,
    template: Template,
    skip: HashSet<PathBuf>,
    sink: Sink<F>,
    tally: Tally,
}

impl<F: FnMut(ReplaceProgress)> Apply<F> {
    fn visit(&mut self, path: &Path) -> ControlFlow<()> {
        self.apply_file(path);
        // ⚠️ 上限是在**一个文件写完之后**才判的，所以撞线的那个文件是完整写进去的，
        // 不存在「改了一半的文件」这种中间状态
        if self.tally.replacements >= MAX_HITS {
            self.tally.truncated = true;
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }

    /// 一个文件的完整流水线。
    ///
    /// ⚠️ 九步的顺序是硬的，每一步的「不写就 return」都必须在**写之前**：
    /// 写下去之后再发现问题，就只剩「告诉用户他的文件坏了」这一条路了
    fn apply_file(&mut self, path: &Path) {
        // ① 已打开且有未保存改动的：连读都不读。
        //    放在最前面是因为它是最「不该碰」的一种——不是碰不了，是碰了会被盖回去
        if self.skip.contains(path) {
            self.tally.skipped_open += 1;
            return;
        }

        // ② 原始字节。⚠️ 不走 `fs::read_text`，理由写在模块文档最后那一节
        let raw = match std::fs::read(path) {
            Ok(raw) => raw,
            // 读不动（权限、途中被删、是个特殊文件）。与遍历错误记进同一个数：
            // 对用户来说都是「有一个东西我没能看」
            Err(_) => {
                self.tally.unreadable += 1;
                self.sink.tick(&self.tally, false);
                return;
            }
        };
        self.tally.files_scanned += 1;

        // ③ 二进制。⚠️ 比搜索侧严，方向与理由都写在模块文档里
        if raw.contains(&0) {
            self.tally.skipped_binary += 1;
            self.sink.tick(&self.tally, false);
            return;
        }

        // ④ 解码。有损就不写：U+FFFD 一旦写回去就是永久的
        let decoded = decode(&raw);
        if decoded.lossy {
            self.tally.skipped_lossy += 1;
            self.sink.tick(&self.tally, false);
            return;
        }

        // ⑤ 行尾必须在归一化**之前**探测，否则就再也分不出原文件是 LF 还是 CRLF
        let eol = detect_eol(&decoded.text);
        let normalized = normalize_to_lf(&decoded.text);

        // ⑥ 换。⚠️ 与预览走的是**同一个** `Template::expand_line`
        let (body, replacements) = expand_text(&self.template, &self.matcher, &normalized);
        if replacements == 0 {
            // 一个字都没变就不写盘：不是「写了同样的内容」，是**一次 write 都不发**。
            // 差别在文件外面看得见——mtime 不变，于是 git 不会把它列进 diff，
            // 文件监听（M2-G）不会被惊动，Time Machine 不会多备一份
            self.sink.tick(&self.tally, false);
            return;
        }

        // ⑦ 还原行尾。
        //
        // ⚠️ 中间那次 `normalize_to_lf` 是**第二道防线**：第一道在 `build_template`，
        // 模板里的 `\r` 在编译时就被归一化掉了，所以正常路径上这一步是零拷贝的空转。
        // 留着它是因为 `apply_eol` 要求入参不含 `\r`——真漏进一个 `\r` 的话，
        // CRLF 档会写出 `\r\r\n`，读回来每行多一个空行，而且没有任何报错。
        // 在写盘的路上，一次零成本的调用换掉一种静默损坏是划算的
        let lf = normalize_to_lf(&body);
        let payload = apply_eol(&lf, eol);

        // ⑧ 编码。**先看 unmappable 再决定写不写**，这一层不调 `write_text_atomic`
        //    的全部理由就在这里
        let encoded = encode(&payload, decoded.encoding, decoded.bom);
        if encoded.unmappable {
            self.tally.skipped_unmappable += 1;
            self.sink.tick(&self.tally, false);
            return;
        }

        // ⑨ 原子写。失败只记一笔继续：整次替换失败比少改一个文件糟得多，
        //    但**必须记下来**——不记的话「替换完成」就是一句假话
        match write_bytes_atomic(path, &encoded.bytes) {
            Ok(()) => {
                self.tally.files_changed += 1;
                self.tally.replacements += replacements;
                self.sink.tick(&self.tally, true);
            }
            Err(_) => {
                self.tally.write_failed += 1;
                self.sink.tick(&self.tally, false);
            }
        }
    }
}

/// 把整份（已归一化为 LF 的）正文按行换完。
///
/// ⚠️ **按行走，而不是把整份正文一次交给正则**，与 `Template::expand_line` 上那条
/// 理由是同一条：搜索是按行进行的，`build_matcher` 里 `line_terminator(Some(b'\n'))`
/// 让「命中不跨行」在引擎那一层就成立，于是「一行一行换完再用 `\n` 拼回去」与
/// 「整份一次换完」结果相同，而前者与预览逐行对得上。
///
/// ⚠️ 返回 `Cow`，**一个字都没改时是 `Borrowed`**：调用方据此决定「一次 write 都不发」。
/// 顺带省掉了「把整份文件复制一遍再发现没变」那次分配——十万个文件里绝大多数是没有命中的。
///
/// ⚠️ 这里刻意**没有**加一条 `matcher.is_match(line)` 的前置判断来跳过没命中的行。
/// 看着像白捡的优化，其实不是：判断本身就要把整行扫一遍正则，省下的只是
/// `expand_line` 里那次按行长度分配（`String::from_utf8` 会复用那块缓冲，所以是一次）。
/// 真嫌慢要先量——而量出来的结论很可能是瓶颈在把 10 MiB 从盘上读进来（实测 6.9–8.5ms）。
/// 更要紧的是：多一个判断就多一处「两个谓词对『有没有命中』不一致」的可能，
/// 而这一层的失败方式是把用户的文件改坏
fn expand_text<'t>(template: &Template, matcher: &RegexMatcher, text: &'t str) -> (Cow<'t, str>, u32) {
    let mut replacements = 0u32;
    let mut out: Option<String> = None;
    // `text[..copied]` 已经进了 `out`；`text[copied..line_start]` 是「上一处改动之后、
    // 这一行之前」那一段，原样抄过去
    let mut copied = 0usize;
    let mut line_start = 0usize;
    // `<=` 而不是 `<`：末尾那个换行符之后还有一个「空行」要过一遍。
    // 正是它让「文件以 `\n` 结尾」与「不以 `\n` 结尾」两种情况共用同一套代码——
    // 而后者是最后一行整个被漏掉的那种错，漏掉的恰好是文件的最后一行
    while line_start <= text.len() {
        let rest = &text[line_start..];
        let newline = rest.find('\n');
        let line = newline.map_or(rest, |i| &rest[..i]);
        let (new, count) = template.expand_line(matcher, line);
        replacements += count;
        if count > 0 {
            let buf = out.get_or_insert_with(|| String::with_capacity(text.len()));
            buf.push_str(&text[copied..line_start]);
            buf.push_str(&new);
            copied = line_start + line.len();
        }
        let Some(i) = newline else { break };
        line_start += i + 1;
    }
    match out {
        // `replacements` 在这一支一定是 0：`out` 只有在 `count > 0` 时才被创建
        None => (Cow::Borrowed(text), replacements),
        Some(mut buf) => {
            buf.push_str(&text[copied..]);
            (Cow::Owned(buf), replacements)
        }
    }
}

/// 推进度，兼管心跳。节奏与搜索侧那两个阈值是同一组常量。
///
/// ## ⚠️ 这里**刻意没有**搜索侧那个收尾 `flush`
///
/// `run::Collector::flush` 存在是因为最后一个不满的批次里装着**命中**，不推就真丢了。
/// `ReplaceProgress` 里没有这种东西：它的三个数字 `ReplaceSummary` 全都有，而 summary
/// 紧跟着就通过 `replace-done` 送到前端。多推一个事件换来的只是进度条早几微秒走到头。
///
/// 后果得说清，否则会被当成 bug「修」掉：**最后一个快照的 `files_scanned` 可以小于总账**
/// ——最后一次 emit 发生在最后一个**被改动的**文件上，它之后扫过的那些没命中的文件
/// 不进快照（除非正好撞上心跳阈值）。而 `files_changed` 与 `replacements` 一定相等：
/// emit 是在那两个计数器加完之后才发生的，且之后再没有文件被改。
/// 前端因此只能拿 `replace-done` 里的 summary 当最终数字，progress 只用于飞行途中。
struct Sink<F> {
    on_progress: F,
    last_emit: Instant,
    last_emit_scanned: u32,
}

impl<F: FnMut(ReplaceProgress)> Sink<F> {
    fn new(on_progress: F) -> Self {
        Self { on_progress, last_emit: Instant::now(), last_emit_scanned: 0 }
    }

    /// 每处理完一个文件问一次「要不要报个平安」。
    ///
    /// ⚠️ **改成了一个文件就立刻推**，不等心跳：落盘与搜索不一样，搜索的进度只是
    /// 一个数字，落盘的进度是「已经有 N 个文件被改掉了」——那是用户唯一能用来
    /// 决定要不要按取消的信息，晚 250ms 就是晚 250ms 的不可撤销。
    /// 心跳那一半管的是「一路都没有命中」时的长时间静默，与搜索侧同一个理由
    fn tick(&mut self, tally: &Tally, changed: bool) {
        if changed
            || tally.files_scanned - self.last_emit_scanned >= HEARTBEAT_FILES
            || self.last_emit.elapsed() >= Duration::from_millis(HEARTBEAT_MS)
        {
            self.emit(tally);
        }
    }

    fn emit(&mut self, tally: &Tally) {
        self.last_emit = Instant::now();
        self.last_emit_scanned = tally.files_scanned;
        (self.on_progress)(ReplaceProgress {
            files_scanned: tally.files_scanned,
            files_changed: tally.files_changed,
            replacements: tally.replacements,
        });
    }
}

#[derive(Debug, Default)]
struct Tally {
    files_scanned: u32,
    files_changed: u32,
    replacements: u32,
    skipped_binary: u32,
    skipped_lossy: u32,
    skipped_unmappable: u32,
    skipped_too_large: u32,
    skipped_open: u32,
    unreadable: u32,
    write_failed: u32,
    truncated: bool,
    cancelled: bool,
}

impl Tally {
    /// 把遍历那一层的账并进来。
    ///
    /// ⚠️ `unreadable` 是**加**不是赋值，理由与搜索侧那条同名方法相同：
    /// 它同时收遍历时读不动的目录与 `fs::read` 读不动的文件。
    /// `skipped_too_large` 则是赋值——只有遍历那一层会记它
    fn absorb(&mut self, out: WalkOutcome) {
        self.unreadable += out.unreadable;
        self.skipped_too_large = out.skipped_too_large;
        self.cancelled |= out.cancelled;
    }

    fn into_summary(self, elapsed_ms: u64) -> ReplaceSummary {
        ReplaceSummary {
            files_scanned: self.files_scanned,
            files_changed: self.files_changed,
            replacements: self.replacements,
            skipped_binary: self.skipped_binary,
            skipped_lossy: self.skipped_lossy,
            skipped_unmappable: self.skipped_unmappable,
            skipped_too_large: self.skipped_too_large,
            skipped_open: self.skipped_open,
            unreadable: self.unreadable,
            write_failed: self.write_failed,
            truncated: self.truncated,
            cancelled: self.cancelled,
            elapsed_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::Encoding;
    use crate::search::{MAX_FILE_BYTES, MAX_HITS_PER_FILE};
    use std::fs;
    use std::sync::atomic::Ordering;

    /// 跑一次落盘替换，忽略进度。
    fn go(root: &Path, request: &ReplaceRequest) -> ReplaceSummary {
        apply(root, request, &AtomicBool::new(false), |_| {}).unwrap()
    }

    fn request(pattern: &str, replace: &str) -> ReplaceRequest {
        ReplaceRequest {
            query: SearchQuery {
                pattern: pattern.to_owned(),
                replace: Some(replace.to_owned()),
                ..SearchQuery::default()
            },
            skip: Vec::new(),
        }
    }

    /// 一个三文件的小仓库：一个有命中、一个没有、一个被 .gitignore 挡掉。
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("build")).unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::write(root.join("src/a.ts"), "let a = needle;\nlet b = 2;\nneedle + needle\n").unwrap();
        fs::write(root.join("src/b.ts"), "nothing here\n").unwrap();
        fs::write(root.join("build/out.txt"), "needle in build output\n").unwrap();
        dir
    }

    /// 一条预览出来的命中。
    ///
    /// ⚠️ 单独一个结构体而不是元组，是因为它带了一个很容易搞混的数：
    /// **`matches` 是这一行里换了几处，而一个 `Previewed` 是一条命中行**。
    /// 一行里可以有多处命中，于是「预览了几条」与「换了几处」是两个数——
    /// 落盘侧的 `replacements` 对的是后者。把它们混成一个的话，
    /// 「一行两处命中」这种最常见的情况就会让对账悄悄差一截
    #[derive(Debug)]
    struct Previewed {
        rel: String,
        line: u32,
        replaced: String,
        matches: usize,
    }

    /// 跑一次预览，把所有命中收出来。
    fn preview(root: &Path, query: &SearchQuery) -> Vec<Previewed> {
        let mut out = Vec::new();
        crate::search::search(root, query, &AtomicBool::new(false), |batch| {
            for file in batch.files {
                for hit in file.hits {
                    out.push(Previewed {
                        rel: file.rel.clone(),
                        line: hit.line,
                        // 这一层测的就是替换，`replaced` 为 None 说明查询根本没带模板
                        replaced: hit.replaced.clone().expect("带模板时每条命中都有 replaced"),
                        matches: hit.ranges.len(),
                    });
                }
            }
        })
        .unwrap();
        out
    }

    // ───────────────────────── 基本正确性 ─────────────────────────

    /// 整层最该守住的一条：**没有命中的文件一个字节都不动，而且一次 write 都不发。**
    ///
    /// 断言的不只是内容相同，还有 mtime：内容相同而 mtime 变了的话，
    /// git 会把它列进 diff、文件监听会被惊动、备份会多备一份——
    /// 用户看到的是一次「什么都没改却动了整个仓库」的操作
    #[test]
    fn 没有命中的文件既不写也不动() {
        let dir = fixture();
        let untouched = dir.path().join("src/b.ts");
        let before_mtime = fs::metadata(&untouched).unwrap().modified().unwrap();
        let ignored = dir.path().join("build/out.txt");
        let ignored_before = fs::read(&ignored).unwrap();

        let summary = go(dir.path(), &request("needle", "N"));

        assert_eq!(fs::read(&untouched).unwrap(), b"nothing here\n");
        assert_eq!(fs::metadata(&untouched).unwrap().modified().unwrap(), before_mtime, "没有命中却写了盘");
        // .gitignore 挡掉的文件连读都没读
        assert_eq!(fs::read(&ignored).unwrap(), ignored_before);
        assert_eq!(summary.files_changed, 1);
        // `.gitignore` 自己也是一个普通文件，照样被读（点开头的文件不排除，
        // 理由在 `run::walker` 那一行上）；被 gitignore 挡掉的只有 `build/out.txt`
        assert_eq!(summary.files_scanned, 3, "src/a.ts、src/b.ts 与 .gitignore");
        assert_eq!(summary.replacements, 3, "一行一个 + 一行两个");
    }

    #[test]
    fn 命中的行被换掉_其余部分一个字节都不动() {
        let dir = fixture();
        go(dir.path(), &request("needle", "N"));
        assert_eq!(fs::read_to_string(dir.path().join("src/a.ts")).unwrap(), "let a = N;\nlet b = 2;\nN + N\n");
    }

    #[test]
    fn 空模板是删除() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "x needle y\n").unwrap();
        let summary = go(dir.path(), &request("needle", ""));
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "x  y\n");
        assert_eq!(summary.replacements, 1);
    }

    /// 三个开关在落盘时照样生效。预览侧那条 `三个开关在替换模式下照样生效` 测的是
    /// 预览，这条测的是**写进磁盘的字节**——两边各测各的并不能证明它们相同
    #[test]
    fn 三个开关决定写进磁盘的是什么() {
        let cases: Vec<(SearchQuery, &str)> = vec![
            (
                SearchQuery { pattern: "needle".to_owned(), replace: Some("N".to_owned()), ..SearchQuery::default() },
                "N N NX",
            ),
            (
                SearchQuery {
                    pattern: "needle".to_owned(),
                    replace: Some("N".to_owned()),
                    case_sensitive: true,
                    ..SearchQuery::default()
                },
                "Needle N NX",
            ),
            (
                SearchQuery {
                    pattern: "needle".to_owned(),
                    replace: Some("N".to_owned()),
                    whole_word: true,
                    ..SearchQuery::default()
                },
                "N N needleX",
            ),
            (
                SearchQuery {
                    pattern: "a.c".to_owned(),
                    replace: Some("Z".to_owned()),
                    literal: true,
                    ..SearchQuery::default()
                },
                "Z axc",
            ),
        ];
        for (query, want) in cases {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("a.txt");
            let body = if query.literal { "a.c axc\n" } else { "Needle needle needleX\n" };
            fs::write(&path, body).unwrap();
            go(dir.path(), &ReplaceRequest { query, skip: Vec::new() });
            assert_eq!(fs::read_to_string(&path).unwrap(), format!("{want}\n"), "查询是 {body:?}");
        }
    }

    /// 预览与落盘之间最容易走偏的一条：**同一份查询跑出来的结果必须一字不差**。
    ///
    /// 这不是「两个模块都各自测过了所以没问题」能替代的——两边各测各的，
    /// 测的是各自的实现；这条测的是**它们相等**。而且是逐行相等：
    /// `replaced` 给的是整行换完的结果，所以拿它去比落盘后的那一行，
    /// 是「所见即所做」能写出来的最强断言
    #[test]
    fn 落盘后的每一行与预览里那条_replaced_逐行相同() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("d")).unwrap();
        // 覆盖：一行一处、一行两处、没有命中的行、末尾没有换行符、多字节字符
        fs::write(root.join("d/x.txt"), "a needle b\nnothing\nneedle needle\n中文 needle 中文\nlast").unwrap();
        fs::write(root.join("d/y.txt"), "let v = needle;\n").unwrap();

        let query = SearchQuery {
            pattern: "(needle|中文)".to_owned(),
            replace: Some("[$1]".to_owned()),
            ..SearchQuery::default()
        };
        let previewed = preview(root, &query);

        let summary = go(root, &ReplaceRequest { query, skip: Vec::new() });

        // ⚠️ 对的是**处数之和**，不是命中行数：一行里可以有多处命中
        let matches: usize = previewed.iter().map(|p| p.matches).sum();
        assert_eq!(summary.replacements, matches as u32, "预览 {previewed:?}");
        assert!(previewed.iter().any(|p| p.matches > 1), "前提：得有「一行多处」才测得出上面那条区分");
        for p in &previewed {
            let got = fs::read_to_string(root.join(&p.rel)).unwrap();
            let actual =
                got.split('\n').nth((p.line - 1) as usize).unwrap_or_else(|| panic!("{}:{} 不存在", p.rel, p.line));
            assert_eq!(actual, p.replaced, "{}:{} 写进磁盘的与预览不同", p.rel, p.line);
        }
    }

    // ───────────────────────── 格式往返 ─────────────────────────

    #[test]
    fn crlf_文件换完仍然是_crlf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("win.txt");
        fs::write(&path, b"a = needle\r\nb = 2\r\n").unwrap();
        go(dir.path(), &request("needle", "N"));
        assert_eq!(fs::read(&path).unwrap(), b"a = N\r\nb = 2\r\n");
    }

    #[test]
    fn bom_被保留() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bom.txt");
        let original: Vec<u8> = [0xEF, 0xBB, 0xBF, b'a', b' ', b'n', b'e', b'e', b'd', b'l', b'e', b'\n'].to_vec();
        fs::write(&path, &original).unwrap();
        let summary = go(dir.path(), &request("needle", "N"));
        assert_eq!(summary.files_changed, 1);
        assert_eq!(fs::read(&path).unwrap(), [0xEF, 0xBB, 0xBF, b'a', b' ', b'N', b'\n']);
    }

    /// GBK 文件用 GBK 写回去。这条同时钉住「替换模板里的中文也能编进 GBK」
    #[test]
    fn gbk_文件换完仍然是_gbk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gbk.txt");
        let original = encode("needle 需要替换\n第二行\n", Encoding::Gbk, false).bytes;
        fs::write(&path, &original).unwrap();

        let summary = go(dir.path(), &request("needle", "钢针"));
        assert_eq!(summary.files_changed, 1);
        assert_eq!(summary.skipped_lossy, 0);

        let after = fs::read(&path).unwrap();
        assert_ne!(after, original, "文件其实没被改");
        let decoded = decode(&after);
        assert_eq!(decoded.encoding, Encoding::Gbk, "被转成了别的编码");
        assert!(!decoded.lossy);
        assert_eq!(decoded.text, "钢针 需要替换\n第二行\n");
    }

    /// 没有末尾换行符的文件，换完也不能被多加一个，更不能把最后一行漏掉。
    ///
    /// 这是 `expand_text` 里 `while line_start <= text.len()` 那个 `<=` 的边界：
    /// 写成 `<` 的话最后一行整个不参与替换，而漏掉的恰好是文件的最后一行——
    /// 一种很难被注意到的少
    #[test]
    fn 没有末尾换行符时既不丢最后一行也不多一个换行() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("noeol.txt");
        fs::write(&path, b"a\nb needle").unwrap();
        let summary = go(dir.path(), &request("needle", "N"));
        assert_eq!(fs::read(&path).unwrap(), b"a\nb N");
        assert_eq!(summary.replacements, 1);
    }

    #[test]
    fn 空文件与只有换行的文件都不会出事() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("empty.txt"), []).unwrap();
        fs::write(dir.path().join("nl.txt"), "\n\n").unwrap();
        let summary = go(dir.path(), &request("needle", "N"));
        assert_eq!(summary.files_changed, 0);
        assert_eq!(fs::read(dir.path().join("empty.txt")).unwrap(), b"");
        assert_eq!(fs::read_to_string(dir.path().join("nl.txt")).unwrap(), "\n\n");
    }

    // ───────────────────────── 三种「不写」 ─────────────────────────

    #[test]
    fn 含空字符的二进制文件不写_计入_skipped_binary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        let original = b"\x00\x01needle\x02\xff".to_vec();
        fs::write(&path, &original).unwrap();

        let summary = go(dir.path(), &request("needle", "N"));
        assert_eq!(summary.skipped_binary, 1);
        assert_eq!(summary.files_changed, 0);
        assert_eq!(summary.replacements, 0);
        assert_eq!(fs::read(&path).unwrap(), original, "二进制文件被改了");
    }

    /// NUL 在**很后面**时搜索侧会留下前面的命中，这里必须整个文件不碰。
    ///
    /// 钉的是模块文档里那条「比搜索更严」的不一致。把它改松的失败方式是
    /// 一个 `.woff2` 被当文本重排了一遍，而它看起来还是个字体的大小
    #[test]
    fn 空字符在很后面时整个文件也不写() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("late.bin");
        let mut original = b"needle at the top\n".to_vec();
        original.extend_from_slice(&[0u8; 4096]);
        fs::write(&path, &original).unwrap();

        let summary = go(dir.path(), &request("needle", "N"));
        assert_eq!(summary.skipped_binary, 1);
        assert_eq!(summary.files_changed, 0);
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn 有损解码的文件不写_计入_skipped_lossy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latin1.txt");
        // 0xFF 不是合法 UTF-8，`decode` 会把它换成 U+FFFD 并报 lossy
        let original = b"needle \xFF\xFE tail\n".to_vec();
        fs::write(&path, &original).unwrap();
        assert!(decode(&original).lossy, "前提：这份字节确实是有损解码的");

        let summary = go(dir.path(), &request("needle", "N"));
        assert_eq!(summary.skipped_lossy, 1);
        assert_eq!(summary.files_changed, 0);
        assert_eq!(fs::read(&path).unwrap(), original, "U+FFFD 被焊进了用户的文件");
    }

    /// 往 GBK 文件里换进一个 GBK 写不出的字符：**不写**，而不是写一堆 U+FFFD。
    ///
    /// ⚠️ 这条测的是「先编码后写」而不是「先写后报告」。改成调 `write_text_atomic`
    /// 的话这条会红——那正是它存在的理由
    #[test]
    fn 替换结果编不回原编码时不写_计入_skipped_unmappable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gbk.txt");
        // ⚠️ 正文里必须有中文。纯 ASCII 的文件不管用什么编码器写出来都是同一串字节，
        // `decode` 会判成 UTF-8——而 UTF-8 编得出任何字符，于是 `unmappable` 永远是 false，
        // 这条测试就会变成一条「怎么改都绿」的空转
        let original = encode("needle 需要替换\n", Encoding::Gbk, false).bytes;
        fs::write(&path, &original).unwrap();
        assert_eq!(decode(&original).encoding, Encoding::Gbk, "前提：这份字节确实被探测成 GBK");

        let summary = go(dir.path(), &request("needle", "针🎉"));
        assert_eq!(summary.skipped_unmappable, 1);
        assert_eq!(summary.files_changed, 0);
        assert_eq!(summary.replacements, 0, "没写成就不该算进「换了几处」");
        assert_eq!(fs::read(&path).unwrap(), original, "文件被改成了带 U+FFFD 的样子");

        // 反证：同一个文件、同一个编码，换一个 GBK 编得出的字符就照改不误。
        // 少了这一半，上面那条红了也分不清是「拦对了」还是「压根没走到写盘」
        let summary = go(dir.path(), &request("needle", "钢针"));
        assert_eq!(summary.skipped_unmappable, 0);
        assert_eq!(summary.files_changed, 1);
        assert_eq!(decode(&fs::read(&path).unwrap()).text, "钢针 需要替换\n");
    }

    // ───────────────────────── skip 与失败 ─────────────────────────

    #[test]
    fn skip_里的文件连读都不读_计入_skipped_open() {
        let dir = fixture();
        let skipped = dir.path().join("src/a.ts");
        let original = fs::read(&skipped).unwrap();
        let before_mtime = fs::metadata(&skipped).unwrap().modified().unwrap();

        let request = ReplaceRequest { skip: vec![skipped.display().to_string()], ..request("needle", "N") };
        let summary = go(dir.path(), &request);

        assert_eq!(summary.skipped_open, 1);
        assert_eq!(summary.files_changed, 0);
        assert_eq!(summary.files_scanned, 2, "src/b.ts 与 .gitignore；skip 掉的那个不算扫过");
        assert_eq!(fs::read(&skipped).unwrap(), original);
        assert_eq!(fs::metadata(&skipped).unwrap().modified().unwrap(), before_mtime);
    }

    /// `skip` 收的是绝对路径，与前端标签页手上那一份同源。
    /// 相对路径不会匹配上任何文件——那是一份「看起来生效了其实没有」的清单，
    /// 所以钉一条：只有绝对路径才算数
    #[test]
    fn skip_里的相对路径不匹配任何文件() {
        let dir = fixture();
        let request = ReplaceRequest { skip: vec!["src/a.ts".to_owned()], ..request("needle", "N") };
        let summary = go(dir.path(), &request);
        assert_eq!(summary.skipped_open, 0);
        assert_eq!(summary.files_changed, 1, "相对路径没有生效，文件照改");
    }

    #[test]
    #[cfg(unix)]
    fn 写不进去的文件计入_write_failed_而替换继续() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        let bad = locked.join("a.txt");
        fs::write(&bad, "needle\n").unwrap();
        fs::write(dir.path().join("ok.txt"), "needle\n").unwrap();
        // 目录只读：原子写要在同目录建临时文件，于是在 rename 之前就失败
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();

        let summary = go(dir.path(), &request("needle", "N"));

        // 先恢复权限再断言：否则 TempDir 清理失败会 panic 在断言之后，看起来像是别的测试坏了
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(summary.write_failed, 1, "写失败没有被记下来");
        assert_eq!(summary.files_changed, 1, "另一个文件照样改成了");
        assert_eq!(fs::read_to_string(dir.path().join("ok.txt")).unwrap(), "N\n");
        assert_eq!(fs::read_to_string(&bad).unwrap(), "needle\n");
        let leftovers: Vec<_> =
            fs::read_dir(&locked).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(leftovers, vec!["a.txt".to_owned()], "失败后留下了临时文件：{leftovers:?}");
    }

    // ───────────────────────── 写盘的副作用 ─────────────────────────

    #[test]
    #[cfg(unix)]
    fn 替换不会把目标文件的权限放宽() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.conf");
        fs::write(&path, "token=needle\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        go(dir.path(), &request("needle", "N"));

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "替换把权限改成了 {mode:o}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "token=N\n");
    }

    #[test]
    fn 替换后目录里不留临时文件() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "needle\n").unwrap();
        go(dir.path(), &request("needle", "N"));
        let names: Vec<_> =
            fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["a.txt".to_owned()], "残留：{names:?}");
    }

    /// 只读文件（0444）在**没有命中**时必须成功：一次 write 都不发，
    /// 所以「只读」这件事压根不该被碰到。
    ///
    /// ⚠️ 这条钉的是 `replacements == 0 → return` 那个分支真的没有写盘。
    /// 要是有人把它改成「照样写一遍同样的内容」，这条会红
    #[test]
    #[cfg(unix)]
    fn 只读文件在没有命中时不报错() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("readonly.txt");
        fs::write(&path, "nothing\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();

        let summary = go(dir.path(), &request("needle", "N"));
        assert_eq!(summary.files_scanned, 1);
        assert_eq!(summary.write_failed, 0, "没有命中却尝试写盘了");
        assert_eq!(summary.files_changed, 0);
    }

    // ───────────────────────── 遍历、上限、取消 ─────────────────────────

    /// 预览与落盘必须走过**同一个文件集**——gitignore、include、太大的文件、符号链接，
    /// 四条规则一条都不能只在其中一边生效。
    ///
    /// ⚠️ 这条是「共用 `walk_files`」这件事唯一能被测出来的地方。
    /// 哪天有人给落盘另写一个遍历，两边各自的测试还是全绿的，只有这条会红
    #[test]
    fn 预览与落盘走过同一个文件集() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::write(root.join("src/a.ts"), "needle\n").unwrap();
        fs::write(root.join("src/b.md"), "needle\n").unwrap();
        fs::write(root.join("src/c.log"), "needle\n").unwrap();
        fs::write(root.join("build/out.txt"), "needle\n").unwrap();
        fs::write(root.join("big.dat"), "needle\n").unwrap();
        // 一个超过 MAX_FILE_BYTES 的文件：遍历那一层就该把它挡掉，两边都不碰
        fs::write(root.join("huge.bin"), vec![b'n'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("src/a.ts"), root.join("link.ts")).unwrap();

        let query = SearchQuery {
            pattern: "needle".to_owned(),
            replace: Some("N".to_owned()),
            include: vec![
                "*.ts".to_owned(),
                "*.md".to_owned(),
                "*.log".to_owned(),
                "*.dat".to_owned(),
                "*.bin".to_owned(),
            ],
            ..SearchQuery::default()
        };
        let mut previewed: Vec<String> = Vec::new();
        crate::search::search(root, &query, &AtomicBool::new(false), |b| {
            for f in b.files {
                previewed.push(f.rel);
            }
        })
        .unwrap();

        let summary = go(root, &ReplaceRequest { query, skip: Vec::new() });

        // gitignore 挡掉的（build/、*.log）两边都不出现；符号链接两边都不跟随
        assert_eq!(previewed, vec!["big.dat".to_owned(), "src/a.ts".to_owned(), "src/b.md".to_owned()]);
        assert_eq!(summary.files_changed, previewed.len() as u32);
        assert_eq!(summary.skipped_too_large, 1, "太大的那个文件没有被单独计数");
        assert_eq!(
            fs::read_to_string(root.join("src/c.log")).unwrap(),
            "needle\n",
            ".log 被 gitignore 挡掉了却还是改了"
        );
        assert_eq!(fs::read_to_string(root.join("build/out.txt")).unwrap(), "needle\n");
        assert_eq!(fs::read_to_string(root.join("big.dat")).unwrap(), "N\n");
    }

    /// 单个文件里超过 `MAX_HITS_PER_FILE`（500）处的命中**照样全换**。
    ///
    /// ⚠️ 这是落盘与预览刻意不同的一处：预览截到 500 条，落盘换 600 处。
    /// 半份替换的文件比两个极端都糟，理由写在模块文档里。
    /// 断言把两边的数都摆出来，于是「刻意不同」这件事是可读的，不是看起来像 bug
    #[test]
    fn 单文件超过报数上限时照样全部换掉() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("many.txt");
        let total = MAX_HITS_PER_FILE + 100;
        fs::write(&path, "needle\n".repeat(total as usize)).unwrap();

        let query =
            SearchQuery { pattern: "needle".to_owned(), replace: Some("N".to_owned()), ..SearchQuery::default() };
        let previewed = preview(dir.path(), &query);

        let summary = go(dir.path(), &ReplaceRequest { query, skip: Vec::new() });

        assert_eq!(previewed.len(), MAX_HITS_PER_FILE as usize, "前提：预览确实截在 500 条");
        assert_eq!(summary.replacements, total, "落盘只换了一部分");
        assert!(!summary.truncated, "这是单文件上限，不是全局上限，不该报截断");
        let after = fs::read_to_string(&path).unwrap();
        assert!(!after.contains("needle"), "还有没换掉的");
        assert_eq!(after.matches('N').count(), total as usize);
    }

    #[test]
    fn 全局命中撞到上限时整个替换停下来() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // 45 个文件 × 500 处 = 22500，超过 MAX_HITS(20000)，于是在第 40 个之后停。
        // ⚠️ 不能靠「建两万个文件」来凑这个数：那会让这一条测试跑上几十秒
        let body = "needle\n".repeat(MAX_HITS_PER_FILE as usize);
        for i in 0..45 {
            fs::write(root.join(format!("f{i:02}.txt")), &body).unwrap();
        }

        let summary = go(root, &request("needle", "N"));

        assert!(summary.truncated, "撞到上限却没有报截断");
        assert_eq!(summary.replacements, MAX_HITS);
        assert_eq!(summary.files_changed, MAX_HITS / MAX_HITS_PER_FILE);
        assert!(!summary.cancelled);
    }

    #[test]
    fn 取消之后替换停下_已经改了的文件留着() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..20 {
            fs::write(dir.path().join(format!("f{i:02}.txt")), "needle\n").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let mut seen = 0u32;
        let summary = apply(dir.path(), &request("needle", "N"), &cancel, |p| {
            seen += 1;
            // 改到第三个就叫停。于是钉住的是「改了一半」那种状态——
            // 「一个都没改」与「全改完」两种情况都测不出取消有没有生效
            if p.files_changed >= 3 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .unwrap();

        assert!(summary.cancelled, "取消没有记进总账");
        assert!((3..20).contains(&summary.files_changed), "改了 {} 个", summary.files_changed);
        assert!(seen >= 1, "一次进度都没推");
        // 已经改了的不会被回滚——没有跨文件撤销，这一点必须如实报出来
        let changed: Vec<_> =
            (0..20).filter(|i| fs::read_to_string(dir.path().join(format!("f{i:02}.txt"))).unwrap() == "N\n").collect();
        assert_eq!(changed.len(), summary.files_changed as usize, "总账里的数与磁盘上的数不一致");
    }

    /// 进度快照是累计的，而且**改成一个文件就推一次**。
    ///
    /// ⚠️ 断言的是「`files_changed` 取过 5 个不同的值」，不是「推了 5 次」：
    /// 心跳那一半（`HEARTBEAT_MS`）在慢盘上会插进来几个额外的快照，
    /// 而按次数断言的测试测的是这台机器有多快
    #[test]
    fn 进度快照是累计的_而且每改成一个文件都能看见() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            fs::write(dir.path().join(format!("f{i}.txt")), "needle needle\n").unwrap();
        }
        fs::write(dir.path().join("clean.txt"), "nothing\n").unwrap();
        // ⚠️ 这一个是为了把「最后一个快照的 `files_scanned` 会落后」钉住。
        // 它按文件名排在所有 `f*.txt` **之后**且没有命中，于是它被扫过、
        // 但不触发任何 emit（改动才触发，心跳阈值又远没到）——
        // 少了它，下面那条断言会因为 `clean.txt` 恰好排在最前面而**碰巧**相等，
        // 测的就不是行为而是这台机器上文件名的排序运气了。理由见 `Sink` 的文档
        fs::write(dir.path().join("zzz-clean.txt"), "nothing\n").unwrap();

        let mut snapshots: Vec<ReplaceProgress> = Vec::new();
        let summary =
            apply(dir.path(), &request("needle", "N"), &AtomicBool::new(false), |p| snapshots.push(p)).unwrap();

        assert!(!snapshots.is_empty(), "一次进度都没推");
        for w in snapshots.windows(2) {
            assert!(w[1].files_scanned >= w[0].files_scanned, "扫描数倒退了");
            assert!(w[1].files_changed >= w[0].files_changed, "改动数倒退了");
            assert!(w[1].replacements >= w[0].replacements, "处数倒退了");
        }
        let distinct: Vec<u32> =
            snapshots.iter().map(|p| p.files_changed).collect::<HashSet<_>>().into_iter().collect();
        assert_eq!(distinct.len(), 5, "五个改成的文件里有几个没被推进度看见：{distinct:?}");

        let last = *snapshots.last().unwrap();
        // 改动数与处数**一定**与总账相等：emit 发生在那两个计数器加完之后，
        // 而且之后再没有文件被改
        assert_eq!(last.files_changed, 5);
        assert_eq!(last.replacements, 10);
        assert_eq!(summary.files_changed, last.files_changed);
        assert_eq!(summary.replacements, last.replacements);
        // 扫描数**只保证不超过**，这里正好差那个排在最后又没命中的文件
        assert_eq!(summary.files_scanned, 7);
        assert_eq!(last.files_scanned, 6, "最后一个快照该落后总账一个：{last:?}");
    }

    // ───────────────────────── 起飞前检查 ─────────────────────────

    #[test]
    fn 没发_replace_时落盘被拒() {
        let dir = fixture();
        let request = ReplaceRequest {
            query: SearchQuery { pattern: "needle".to_owned(), ..SearchQuery::default() },
            skip: Vec::new(),
        };
        match preflight_apply(dir.path(), &request) {
            Err(SearchError::BadReplacement { message }) => assert!(message.contains("replace"), "{message}"),
            other => panic!("期望 BadReplacement，实际 {other:?}"),
        }
        // 绕过 preflight 直接调 apply 也是同一个错，而不是 panic
        match apply(dir.path(), &request, &AtomicBool::new(false), |_| {}) {
            Err(SearchError::BadReplacement { .. }) => {}
            other => panic!("期望 BadReplacement，实际 {other:?}"),
        }
    }

    /// `preflight_apply` 与 `apply` 必须给出同一个结论，且**一个文件都没被改**。
    /// 与搜索侧那条 `起飞前检查的两个入口结论一致` 是同一件事
    #[test]
    fn 起飞前检查挡住的时候一个文件都没动() {
        let dir = fixture();
        let target = dir.path().join("src/a.ts");
        let before = fs::read(&target).unwrap();
        for replace in ["$name", "$2", "$", "${"] {
            let request = ReplaceRequest {
                query: SearchQuery {
                    pattern: "(needle)".to_owned(),
                    replace: Some(replace.to_owned()),
                    ..SearchQuery::default()
                },
                skip: Vec::new(),
            };
            let pre = preflight_apply(dir.path(), &request);
            let real = apply(dir.path(), &request, &AtomicBool::new(false), |_| {});
            assert!(pre.is_err(), "{replace:?} 应该被拒");
            assert_eq!(pre.is_ok(), real.is_ok(), "两个入口对 {replace:?} 的结论不同");
        }
        // 正则本身编不出来 / 搜索词为空 / root 不对
        for request in [
            ReplaceRequest {
                query: SearchQuery { pattern: "(".to_owned(), replace: Some("N".to_owned()), ..SearchQuery::default() },
                skip: Vec::new(),
            },
            ReplaceRequest {
                query: SearchQuery { pattern: "".to_owned(), replace: Some("N".to_owned()), ..SearchQuery::default() },
                skip: Vec::new(),
            },
        ] {
            assert!(preflight_apply(dir.path(), &request).is_err());
            assert!(apply(dir.path(), &request, &AtomicBool::new(false), |_| {}).is_err());
        }
        assert!(preflight_apply(&dir.path().join("nope"), &request("needle", "N")).is_err());
        assert!(preflight_apply(Path::new("relative"), &request("needle", "N")).is_err());

        assert_eq!(fs::read(&target).unwrap(), before, "上面某一条报错的路径上还是改了文件");

        // ⚠️ 反证必须换一个目录跑：合法的模板**会**写盘，把它放进上面那个循环里，
        // 这条测试就在自己改过的文件上断言「文件没被改」——红的绿的都说不清是为什么
        let control = fixture();
        let ok = ReplaceRequest {
            query: SearchQuery {
                pattern: "(needle)".to_owned(),
                replace: Some("ok".to_owned()),
                ..SearchQuery::default()
            },
            skip: Vec::new(),
        };
        assert!(preflight_apply(control.path(), &ok).is_ok(), "合法的模板反倒被拒了，上面那一串就全是空转");
        assert_eq!(apply(control.path(), &ok, &AtomicBool::new(false), |_| {}).unwrap().files_changed, 1);
    }

    // ───────────────────────── expand_text 单元 ─────────────────────────

    /// 直接测 `expand_text`：上面那些端到端用例走的是整条流水线，
    /// 出错时分不清是按行拼字符串错了还是编码错了
    #[test]
    fn 按行拼接的边界情况() {
        let dir = tempfile::tempdir().unwrap();
        let prepared = prepare(
            dir.path(),
            &SearchQuery { pattern: "a".to_owned(), replace: Some("Z".to_owned()), ..SearchQuery::default() },
        )
        .unwrap();
        let matcher = &prepared.matcher;
        let template = prepared.template.as_ref().unwrap();
        let run =
            |text: &str| (expand_text(template, matcher, text).0.into_owned(), expand_text(template, matcher, text).1);

        // 一个字都没改 → Borrowed，且 count 为 0
        let (body, count) = expand_text(template, matcher, "xyz\n");
        assert_eq!(count, 0);
        assert!(matches!(body, Cow::Borrowed(_)), "没有改动却复制了一份");

        assert_eq!(run("a\nb\n"), ("Z\nb\n".to_owned(), 1)); // 首行改
        assert_eq!(run("b\na\n"), ("b\nZ\n".to_owned(), 1)); // 末行改（有末尾换行符）
        assert_eq!(run("b\na"), ("b\nZ".to_owned(), 1)); // 末行改（没有末尾换行符）
        assert_eq!(run("1\na\n2\n"), ("1\nZ\n2\n".to_owned(), 1)); // 中间行改，两边原样
        assert_eq!(run("a\na\na\n"), ("Z\nZ\nZ\n".to_owned(), 3)); // 连续多行都改
        assert_eq!(run("aaa\n"), ("ZZZ\n".to_owned(), 3)); // 一行里多处
        assert_eq!(run("a\n\na"), ("Z\n\nZ".to_owned(), 2)); // 空行夹在中间
        assert_eq!(run("\n"), ("\n".to_owned(), 0)); // 只有换行符
        assert_eq!(run(""), ("".to_owned(), 0)); // 空文件
    }

    /// 多字节字符：按行切用的是 `\n`（单字节），所以 CJK 与 emoji 不会被劈开
    #[test]
    fn 多字节字符在替换里不会被劈开() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cjk.txt");
        fs::write(&path, " needle 是「针」\n🎉 needle\n").unwrap();
        let summary = go(dir.path(), &request("needle", "钢针"));
        assert_eq!(summary.replacements, 2);
        assert_eq!(fs::read_to_string(&path).unwrap(), " 钢针 是「针」\n🎉 钢针\n");
    }

    /// 替换模板里带回车（用户在替换框里粘了一段 Windows 文本）：它在**编译模板时**
    /// 就被归一化成一个真的换行，于是写出去的是按原文件行尾还原的两行。
    ///
    /// ⚠️ 两件事一起钉：
    /// - 不写出 `\r\r\n`。少了归一化的话 `apply_eol` 在 CRLF 档上就会那样做，
    ///   读回来每行多一个空行，而且没有任何报错。
    /// - **预览与落盘一致**。`replaced` 里显示的是 `a = x\ny`，写进去的读回来也是它。
    ///   归一化要是只做在写盘那一侧，预览里就会是一个孤零零的 `\r`——那就是预览说谎
    #[test]
    fn 模板里的回车变成一个真的换行_而且与预览一致() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("win.txt");
        fs::write(&path, b"a = needle\r\n").unwrap();

        let query =
            SearchQuery { pattern: "needle".to_owned(), replace: Some("x\ry".to_owned()), ..SearchQuery::default() };
        let previewed = preview(dir.path(), &query);
        go(dir.path(), &ReplaceRequest { query, skip: Vec::new() });

        assert_eq!(fs::read(&path).unwrap(), b"a = x\r\ny\r\n");
        // 读回来的正文（归一化之后）与预览给出的那一行是同一个字符串
        let first = &previewed[0];
        assert!(!first.replaced.contains('\r'), "预览里还留着回车：{:?}", first.replaced);
        let reread = crate::fs::read_text(&path).unwrap();
        assert_eq!(reread.text, format!("{}\n", first.replaced));
    }

    // ── 线上形状 ────────────────────────────────────────────────────────────
    //
    // `ReplaceRequest` / `ReplaceProgress` / `ReplaceSummary` 的黄金 JSON 不在这里，在
    // `crates/vela-core/tests/wire_contract.rs` 的「M2-D 全局替换」那一节。理由与
    // `SearchQuery` 那条完全相同：契约只能拿 pub 的东西说事，放 `tests/` 才逼得住
    // 这条边界。对照的前端快照是 `src/ipc/replace.test.ts`。
}
