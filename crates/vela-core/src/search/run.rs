//! 遍历 + 扫描 + 分批（PLAN.md §3.4 M2-C）。
//!
//! 这一层的形状是一条直线：`ignore::WalkBuilder` 吐出文件 → 逐个用 `grep-searcher` 按行扫
//! → 命中攒够一批就交给回调。没有队列、没有通道、没有线程——**并发是调用方的事**
//! （`src-tauri` 把这一整个函数放进后台线程，回调里 `app.emit`）。
//! 这样本模块的每个分支都能用 `tempfile` 在当前线程上测完。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::{sinks, BinaryDetection, Searcher, SearcherBuilder};
use ignore::WalkBuilder;
use serde::Serialize;

use super::query::{build_filters, build_matcher, Filters, SearchError, SearchQuery};

/// 一次搜索最多产出多少条命中。撞到就**整个停下来**，`SearchSummary::truncated` 为真。
///
/// 不是「留着但只显示前 N 条」：两万条之后的那部分对用户没有价值（他要的是缩小范围），
/// 而继续扫完十万个文件是实打实的几秒钟。
pub const MAX_HITS: u32 = 20_000;

/// 单个文件最多留多少条命中。
///
/// minified 的一行 JS、一份生成的 i18n 表、一个几十万行的日志，都能轻松过万，
/// 而它们在 UI 上都只是同一句话：「这个文件里到处都是」。
pub const MAX_HITS_PER_FILE: u32 = 500;

/// 超过这个大小的文件整个跳过，计入 `SearchSummary::skipped_too_large`。
///
/// 与 `fs` 那边「打开文件」的 4MB 上限不是一回事：那边管的是 IPC payload，
/// 这边管的是「别为一个 2GB 的日志把整次搜索卡住」。
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// 一条命中行的预览最多留多少**字节**（不是字符）。
///
/// minified 的产物可以把整个文件压成一行。不留上限的话，一行就能顶掉一批的预算。
const MAX_PREVIEW_BYTES: usize = 1_000;

/// 一行里最多标出几个命中段。
const MAX_RANGES_PER_HIT: usize = 32;

/// 攒够这么多**文件**就推一批。
const BATCH_FILES: usize = 16;

/// 或者攒够这么多**条命中**就推一批。
///
/// ⚠️ 这是个**软**上限：批次以文件为单位，所以一批最多能到
/// `(BATCH_FILES - 1) * MAX_HITS_PER_FILE + MAX_HITS_PER_FILE` = 8000 条命中，
/// 按每条 60 字节算约 480KB——离 §2.6 的 4MB payload 上限还有一个数量级。
/// 光按文件数攒的话一批就能到 8000 条，这个数存在的意义就是让「文件少但每个都命中很多」
/// 那种情况不至于攒出一个巨大的批次。
const BATCH_HITS: usize = 256;

/// 一条结果都没有时，每扫过这么多文件推一次**心跳**（一个 `files` 为空的批次）。
///
/// 实测逼出来的：十万个文件、搜索词一个都不命中时，第一个信号在 **7.14s** 才到，
/// 在那之前 UI 手上什么都没有——既不能显示进度也不能说「没找到」，看起来就是卡死了。
/// §2.6 约束 3 那句「通过 event 推进度」指的正是这件事。
///
/// 256 是按「十万个文件最多推 400 次心跳」倒推的：一次心跳的 payload 只有几十字节，
/// 400 次连 4MB 上限的零头都不到，而前端每 256 个文件能刷一次「已扫 N 个」。
const HEARTBEAT_FILES: u32 = 256;

/// 或者距上一次推批次过了这么久，也推一次心跳。
///
/// ⚠️ 光有文件数那一半不够：一屋子接近 `MAX_FILE_BYTES` 的文件，256 个能扫上十几秒。
/// 两条阈值取「先到者」，于是**前端最多 250ms 或 256 个文件收不到信号**，
/// 与仓库里文件的平均大小无关。
///
/// 这一半没法确定地测（要测就得 sleep，而 sleep 出来的测试测的是调度器）；
/// 钉住的是文件数那一半，见 `扫过很多个没有命中的文件时会推心跳`。
const HEARTBEAT_MS: u64 = 250;

/// 一行里的一个命中段。
///
/// ⚠️ `start` / `end` 数的是 **UTF-16 码元**，不是字符也不是字节（理由见 `mod.rs`）。
/// 前端可以把这两个数直接交给 CodeMirror，不需要任何换算。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

/// 命中的一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 1 起算的行号——编辑器与 `Cmd+Alt+G` 跳行用的都是 1 起算
    pub line: u32,
    /// 这一行的正文，**不含**行终止符，也不做 trim：`ranges` 里的偏移量是按这个字符串
    /// 算的，前端一 trim 就全错了。缩进深的话让它自己横向溢出，别在这儿动内容
    pub text: String,
    /// 这一行里的命中段，升序、不重叠。
    ///
    /// ⚠️ **可能是空的**，只有两种情况：正文被 `MAX_PREVIEW_BYTES` 截断且命中落在
    /// 截断之外，或者命中段数撞到 `MAX_RANGES_PER_HIT`。空的意思是「这一行确实命中了，
    /// 只是没能告诉你命中在哪儿」，行号照样能跳
    pub ranges: Vec<MatchRange>,
    /// 正文被截断了（原文比 `text` 长）
    pub truncated: bool,
}

/// 一个文件的全部命中。**批次以它为单位**：一个文件的命中只有扫完它之后才齐，
/// 而 UI 是按文件分组的，半份文件的命中没有意义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    /// 相对 root 的路径，与 `DirEntry.rel` 同一套规矩：`/` 分隔、不以 `/` 开头或结尾。
    /// 前端拿它去树上定位，也拿它当分组标题
    pub rel: String,
    /// 绝对路径，交给 `open_file` 用。与 `rel` 冗余是刻意买的：前端不做路径拼接
    pub path: String,
    pub hits: Vec<SearchHit>,
    /// 这个文件的命中被 `MAX_HITS_PER_FILE` 截断了
    pub truncated: bool,
}

/// 推给前端的一批结果。
///
/// ⚠️ **`files` 可以是空的**，那是一次**心跳**而不是「没有结果」。
/// 实测逼出来的：十万个文件、搜索词一个都不命中时，第一个信号在 **7.14s** 才到——
/// 在那之前 UI 手上什么都没有，既不能显示进度也不能说「没找到」，看起来就是卡死了。
/// 心跳带着 `files_scanned` 定期推一次，让「还在扫」这件事可见。
///
/// 前端的规则因此是：**`files` 为空时只更新进度，不要动结果列表，更不要把它当成
/// 「搜索结束了」**。结束的唯一信号是命令返回的 [`SearchSummary`]。
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBatch {
    pub files: Vec<SearchFile>,
    /// 到这一批推出去为止，一共读了多少个文件的正文。累计值，不是增量
    pub files_scanned: u32,
}

/// 一次搜索结束时的总账。
///
/// ⚠️ `elapsed_ms` 让它不适合直接做黄金 JSON 断言——契约测试要手搓一个字面量。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    /// 真的读了正文的文件数。**不含**被跳过的与被取消打断的
    pub files_scanned: u32,
    pub files_with_hits: u32,
    pub hits: u32,
    /// 因为超过 [`MAX_FILE_BYTES`] 被整个跳过的文件数。
    ///
    /// 单独一个数而不是并进 `unreadable`：这一条是**我们主动决定不搜**，
    /// 那一条是**想搜而搜不动**，对用户是两句话
    pub skipped_too_large: u32,
    /// 读不动的条目数（目录权限不够、文件被删、二进制探测之外的 IO 错误）。
    ///
    /// ⚠️ 这个数非零意味着「没找到」可能是假的。UI 必须说出来，
    /// 否则用户会得到一个看起来很确定的错答案
    pub unreadable: u32,
    /// 撞到 [`MAX_HITS`]，剩下的没搜
    pub truncated: bool,
    /// 被取消了。已经推出去的批次仍然有效
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

/// 在 `root` 下搜一遍，结果分批交给 `on_batch`。
///
/// `cancel` 由调用方持有（生产上是 `Arc<AtomicBool>`，一半注册在 Tauri 的 managed state
/// 里等 `cancel_search` 来置真）。**遍历途中每个文件之间、以及扫描途中每一行之间**都会
/// 读它一次：只在大循环里读的话，一个几十万行的文件能让「点了取消」等上好几秒。
///
/// ⚠️ `root` 必须是**绝对路径**且确实是一个目录，否则返回 `SearchError`。
/// 这两条检查与编译正则、编译通配一起构成「起飞前检查」，所以**每一个 `SearchError`
/// 都发生在第一批结果推出去之前**（见 `mod.rs` 最后一条）。
///
/// ⚠️ `on_batch` 收到的批次**可能 `files` 为空**——那是一次心跳，不是「搜完了」。
/// 搜完的唯一信号是本函数返回。理由与阈值见 `mod.rs`「一个都不命中时」那一节。
pub fn search<F>(
    root: &Path,
    query: &SearchQuery,
    cancel: &AtomicBool,
    on_batch: F,
) -> Result<SearchSummary, SearchError>
where
    F: FnMut(SearchBatch),
{
    let (matcher, filters) = prepare(root, query)?;

    let started = Instant::now();
    let mut run = Run {
        root,
        matcher,
        filters,
        cancel,
        searcher: searcher(),
        collector: Collector::new(on_batch),
        tally: Tally::default(),
    };
    run.walk();
    // ⚠️ 结尾必须冲一次：最后一批几乎总是不满的。漏掉它的失败方式是
    // 「搜索结果少了最后几个文件」，而那恰好是最难发现的一种少——
    // 用户不会知道有几个文件本该出现在列表末尾。
    // 这里刻意**不**补一次心跳：下一行就返回 `SearchSummary` 了，那才是终止信号，
    // 在它前面多推一个空批次只是噪音，还会让前端在「最后一批」与「done」之间多插一帧
    run.collector.flush(run.tally.files_scanned);
    Ok(run.tally.into_summary(started.elapsed().as_millis() as u64))
}

/// 只做起飞前检查，不搜。
///
/// 给**调用方**用的：Tauri command 在开后台线程之前先调它一次，于是「搜索词编不出来」
/// 这件事当场 reject 掉 invoke，不需要先返回一个 taskId、再等一个 error event 绕回来。
/// 前端因此保住了一条很简单的规则：**`start_search` reject = 这次搜索压根没开始**
/// （见 `mod.rs` 最后一条）。代价是多编一次正则——微秒级。
///
/// ⚠️ 它必须与 [`search`] 的检查**完全一致**，两者共用 [`prepare`] 这一个实现处。
/// 要是哪天有人只改一边，「preflight 过了而 search 报错」会让前端收到一个它以为
/// 不可能出现的 event，而那条路径没有测试也没有 UI。一致性由
/// `起飞前检查的两个入口结论一致` 钉住。
pub fn preflight(root: &Path, query: &SearchQuery) -> Result<(), SearchError> {
    prepare(root, query).map(|_| ())
}

/// 起飞前检查本体：root 与 query 有没有可能跑起来，跑起来的话用什么匹配机与过滤器。
fn prepare(root: &Path, query: &SearchQuery) -> Result<(RegexMatcher, Filters), SearchError> {
    if !root.is_absolute() {
        return Err(SearchError::BadRoot { path: root.display().to_string() });
    }
    // 用 `metadata` 而不是 `Path::exists` + `is_dir` 两次 stat：一次就够，
    // 而且 `metadata` 跟着符号链接走——指向目录的链接是一个合法的 root
    match std::fs::metadata(root) {
        Ok(meta) if meta.is_dir() => {}
        _ => return Err(SearchError::NotFound { path: root.display().to_string() }),
    }
    Ok((build_matcher(query)?, build_filters(query)?))
}

/// 造一个扫描器。
///
/// ⚠️ **二进制探测是这里显式打开的，不是默认的。**`Searcher::new()` 拿到一份
/// `\x00\xff\nneedle\n` 照样把 `needle` 报出来——钉这件事的那条测试
/// （`含空字符的二进制文件不产生命中`）在配上 `BinaryDetection` 之前是红的。
/// 不去猜第三方库的默认值，是因为猜错的失败方式很安静：搜索结果里混进
/// `pack-*.idx`、`.woff2`、编译产物，而它们全都「看起来像个文件」。
///
/// 用 `quit` 不用 `convert`：`convert` 把 NUL 换成行终止符，于是二进制文件被
/// 切成许多「行」继续搜下去，命中数还会算进总账；`quit` 是见到 NUL 就收手。
/// 收手的具体粒度是按读缓冲来的（含 NUL 的那个缓冲整个丢掉，更早的留着），
/// 那条规则由 `空字符在第一个缓冲里时整个文件不报_在很后面时之前的命中留着` 钉住。
fn searcher() -> Searcher {
    SearcherBuilder::new().binary_detection(BinaryDetection::quit(0)).build()
}

/// 一次搜索的可变状态。收进一个结构体是为了让 `walk` / `scan_file` 各自短一点：
/// 摊平成一个函数的话，遍历、过滤、扫描、分批四件事会挤在同一个作用域里，
/// 而它们各自都有需要注释的取舍。
struct Run<'a, F> {
    root: &'a Path,
    matcher: RegexMatcher,
    filters: Filters,
    cancel: &'a AtomicBool,
    searcher: Searcher,
    collector: Collector<F>,
    tally: Tally,
}

impl<F: FnMut(SearchBatch)> Run<'_, F> {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn walk(&mut self) {
        let mut builder = WalkBuilder::new(self.root);
        builder
            // 点开头的目录要搜：`.github/workflows/ci.yml`、`.vscode/settings.json`
            // 都是用户真会去搜的东西。代价是 `.git` 不再被「隐藏文件」那条规则顺带挡掉，
            // 所以下面显式挡一次
            .hidden(false)
            // 一个光秃秃的 `.gitignore`（没有 `.git` 目录）也算数。默认值是 true，
            // 那意味着「不在 git 仓库里就完全不过滤」——而用户打开的文件夹是不是一个
            // 仓库，与他要不要跳过 `build/` 里的产物没有任何关系
            .require_git(false)
            // ⚠️ 与文件树相反：**不跟随符号链接**。树放行链接是因为「展开一层」的成本有限，
            // 而搜索要读正文——跟着 pnpm 的符号链接农场走会把同一个包读几十遍，
            // 还可能成环。`follow_links(false)` 之下链接自己的 `file_type` 既不是 file
            // 也不是 dir，于是下面那条 `is_file()` 把「目录」与「链接」一起挡掉了
            .follow_links(false)
            // `.git` 里面是几万条对象文件与 reflog，搜它们从来不是用户的意思
            .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git")
            // 顺序确定，同一棵树搜两次长得一样。并行遍历做不到这一点，
            // 而测试与 UI 都依赖顺序稳定（见 `mod.rs`「为什么是单线程遍历」）。
            // 参数类型必须写出来：这里传的是 `impl Fn`，编译器没有位置可以反推
            .sort_by_file_name(|a: &std::ffi::OsStr, b: &std::ffi::OsStr| a.cmp(b));

        for item in builder.build() {
            if self.cancelled() {
                self.tally.cancelled = true;
                break;
            }
            let entry = match item {
                Ok(entry) => entry,
                // 某个目录读不动（权限不够、遍历途中被删）：记一笔继续。
                // 整次搜索失败比少搜一个目录糟得多，但**必须记下来**——
                // 不记的话「没找到」就成了一个看起来很确定的错答案
                Err(_) => {
                    self.tally.unreadable += 1;
                    continue;
                }
            };
            // depth 0 是 root 自己
            if entry.depth() == 0 || !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let path = entry.path();
            // `rel_of` 返回 None 只可能是路径没长在 root 下面——`WalkBuilder` 从 root
            // 出发，正常走不到这一支。真走到了就跳过：一个算不出 rel 的命中
            // 在 UI 上无处可挂
            let Some(rel) = rel_of(self.root, path) else { continue };
            if !self.filters.allows(&rel) {
                continue;
            }
            // `metadata()` 读不动就当它不大：宁可扫一个可能很大的文件，
            // 也不要因为一次 stat 失败就静默地少搜一个文件
            if entry.metadata().is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
                self.tally.skipped_too_large += 1;
                continue;
            }
            self.scan_file(path, &rel);
            if self.tally.hits >= MAX_HITS {
                self.tally.truncated = true;
                break;
            }
        }
    }

    fn scan_file(&mut self, path: &Path, rel: &str) {
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut truncated = false;
        if scan(&mut self.searcher, &self.matcher, self.cancel, path, &mut hits, &mut truncated).is_err() {
            // 读不动这个文件（权限、途中被删、或者二进制探测之外的 IO 错误）。
            // 与遍历错误记进同一个数：对用户来说都是「有一个东西我没能看」
            self.tally.unreadable += 1;
            return;
        }
        // ⚠️ 取消发生在这个文件**中间**时，`hits` 是半份的。半份文件不推出去：
        // 推出去的话 `truncated` 是 false，UI 就会声称「这个文件里就这几处」，
        // 而那句话是假的。已经取消了的搜索少一个文件没有人在乎，说一句假话有人在乎
        if self.cancelled() {
            return;
        }
        // 多扫的那一行只用来判断「还有没有更多」，不进结果
        hits.truncate(MAX_HITS_PER_FILE as usize);

        self.tally.files_scanned += 1;
        if !hits.is_empty() {
            self.tally.files_with_hits += 1;
            self.tally.hits += hits.len() as u32;
            let file = SearchFile { rel: rel.to_owned(), path: path.display().to_string(), hits, truncated };
            self.collector.push(file, self.tally.files_scanned);
        }
        // 一个调用点，不管有没有命中都问一次。有结果压着的时候它自己什么也不做
        self.collector.heartbeat(self.tally.files_scanned);
    }
}

/// 扫一个文件，把命中追加到 `hits` 里。
///
/// `truncated` 由内部置真：判据是「命中数**超过**了单文件上限」而不是「达到了」。
/// 达到就报截断的话，一个正好 500 行命中的文件会被标成「还有更多」，
/// 而它其实已经扫完了。代价是多扫一行——`MAX_HITS_PER_FILE + 1` 行时停下来，
/// 回到调用方再 `truncate` 掉那一条。
///
/// 错误类型是 `std::io::Error` 而不是某个 grep-searcher 自己的类型（那个类型没导出）：
/// `Sink::Error: From<io::Error>`，而下面的闭包只产出 `Ok(bool)`，于是 `S::Error` 被
/// 反推成 `io::Error`，`search_path` 返回的就是它。调用方也只看 `.is_err()`——
/// 一个读不动的文件是「少搜一个」，不是「这次搜索失败了」。
fn scan(
    searcher: &mut Searcher,
    matcher: &RegexMatcher,
    cancel: &AtomicBool,
    path: &Path,
    hits: &mut Vec<SearchHit>,
    truncated: &mut bool,
) -> Result<(), std::io::Error> {
    searcher.search_path(
        matcher,
        path,
        sinks::Lossy(|line_num: u64, line: &str| {
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            hits.push(make_hit(line_num, line, matcher));
            if hits.len() as u32 > MAX_HITS_PER_FILE {
                *truncated = true;
                return Ok(false);
            }
            Ok(true)
        }),
    )?;
    Ok(())
}

/// 一行正文 → 一条命中。
///
/// ⚠️ 用 `sinks::Lossy` 而不是 `sinks::UTF8`：后者遇到非法 UTF-8 会让整个文件报错，
/// 于是一份 GBK 文件在搜索结果里**整个消失**，而用户没有任何线索。
/// `Lossy` 把非法字节换成 U+FFFD，ASCII 搜索词（标识符、URL、错误码）照样能命中——
/// Vela 的目标用户会打开 GBK 文件，这不是边角情况（`fs` 那边专门做了 GBK 探测）。
/// 代价是**中文搜索词搜不到非 UTF-8 文件里的中文**：字节序列不同，
/// 要支持它得先按探测出的编码解码整个文件，那是另一件事。
fn make_hit(line_num: u64, line: &str, matcher: &RegexMatcher) -> SearchHit {
    // ⚠️ 先脱掉行终止符再算任何东西。`sinks::Lossy` 交出来的 `&str` 是**带着** `\n` 的
    // （实测；钉它的是 `命中里的文本不带行尾换行_两种行尾与没有换行的最后一行都一样`）。
    // 带着它的话：预览末尾多一个看不见的字符、`text.len()` 的分母对不上编辑器里那一行、
    // CRLF 文件里还会多留一个 `\r`。
    let line = strip_terminator(line);
    let (text, truncated) = preview(line);
    let mut ranges: Vec<MatchRange> = Vec::new();
    // (字节游标, UTF-16 游标)。`find_iter` 给出的区间升序且不重叠，字符边界也升序，
    // 所以两个游标一起单向前走就够，不需要为每行建一张偏移映射表
    let mut cursor = (0usize, 0u32);
    // `find_iter` 的 Err 类型是 `grep_matcher::NoError`，一个**不可构造**的类型，
    // 所以这条 `expect` 没有对应的 panic 路径——写出来只是为了满足 must_use
    matcher
        .find_iter(line.as_bytes(), |m| {
            // 命中跨过或被截断留在预览之外：后面的也一定在外面（升序），直接停
            if m.end() > text.len() {
                return false;
            }
            let start = utf16_at(text, m.start(), &mut cursor);
            let end = utf16_at(text, m.end(), &mut cursor);
            ranges.push(MatchRange { start, end });
            ranges.len() < MAX_RANGES_PER_HIT
        })
        .expect("NoError 不可构造");
    SearchHit { line: line_num as u32, text: text.to_owned(), ranges, truncated }
}

/// 脱掉行尾的换行符。CRLF 文件里 `\n` 前面还留着一个 `\r`，一并脱掉。
///
/// 文件最后一行没有换行时这里什么都不做——`strip_suffix` 本来就允许「没有」。
fn strip_terminator(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

/// 取这一行的预览。第二个返回值是「截断了没有」。
fn preview(line: &str) -> (&str, bool) {
    if line.len() <= MAX_PREVIEW_BYTES {
        return (line, false);
    }
    // 往回退到最近的字符边界：切在一个多字节字符中间会 panic，
    // 而 minified 的一行里什么字节都可能有
    let mut cut = MAX_PREVIEW_BYTES;
    while cut > 0 && !line.is_char_boundary(cut) {
        cut -= 1;
    }
    (&line[..cut], true)
}

/// `text` 里字节偏移 `target` 对应的 **UTF-16 码元**偏移。
///
/// `cursor` 是 `(字节, UTF-16)` 双游标，只往前走——调用方保证 `target` 单调不减。
fn utf16_at(text: &str, target: usize, cursor: &mut (usize, u32)) -> u32 {
    while cursor.0 < target {
        // 走到头了就停在末尾：`target` 越界是调用方的 bug，而这里返回一个
        // 「等于文本长度」的偏移量比 panic 好——高亮画不出来，搜索结果还在
        let Some(c) = text[cursor.0..].chars().next() else { break };
        cursor.0 += c.len_utf8();
        cursor.1 += c.len_utf16() as u32;
    }
    cursor.1
}

/// `path` 相对 `root` 的那条 rel，规矩与 `DirEntry.rel` 完全一致。
fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    // 逐组件用 `/` 拼，而不是 `replace('\\', "/")`：后者是「假设分隔符是反斜杠」，
    // 前者是「不假设任何平台的分隔符」
    Some(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
}

/// 攒批次，兼管心跳。
struct Collector<F> {
    files: Vec<SearchFile>,
    hits: usize,
    on_batch: F,
    /// 上一次推批次（结果批或心跳批都算）的时刻
    last_emit: Instant,
    /// 上一次推批次时已经扫过多少个文件。用它而不是让调用方传增量，
    /// 是因为「增量」要求两边对「什么时候清零」达成一致——那种约定的失败方式是
    /// 心跳频率悄悄变成两倍或一半，而测试测不出来
    last_emit_scanned: u32,
}

impl<F: FnMut(SearchBatch)> Collector<F> {
    fn new(on_batch: F) -> Self {
        Self { files: Vec::new(), hits: 0, on_batch, last_emit: Instant::now(), last_emit_scanned: 0 }
    }

    fn push(&mut self, file: SearchFile, scanned: u32) {
        self.hits += file.hits.len();
        self.files.push(file);
        if self.files.len() >= BATCH_FILES || self.hits >= BATCH_HITS {
            self.flush(scanned);
        }
    }

    /// 每扫完一个文件问一次「要不要报个平安」。
    ///
    /// ⚠️ 手上还压着结果时**什么也不做**。压着的结果本身就是进度，而且提前冲批会让
    /// 批次大小取决于机器快慢——`攒够一批就推_最后一批不满也推` 那条断言的是
    /// `[16, 16, 8]` 这个确定的形状，一旦「压着 3 个结果时正好过了 250ms」也能触发冲批，
    /// 那条测试就变成随机红的了。
    ///
    /// 代价是一个空洞：压着结果时撞上单个慢文件，那段时间没有信号。实测这个空洞有多小
    /// （release，外部卷，连跑三次）：一个正好 `MAX_FILE_BYTES`（10MiB）的文本文件
    /// 从头扫到尾是 **6.9–8.5ms**。而 `MAX_FILE_BYTES` 就是单文件的上限，
    /// 所以空洞最长也就十几毫秒——比 `HEARTBEAT_MS` 小一个数量级，
    /// 不值得为它另起一个计时线程。
    ///
    /// ⚠️ 实测还有一件事：命中密度低时（十万个文件里 2000 个命中，约 2%），
    /// 相邻两次**结果批**之间会隔到 ~800 个文件——因为每攒够 16 个命中文件才冲一次批，
    /// 而这 16 个文件摊在 800 个文件里。那段时间静默 **69ms**，仍在 `HEARTBEAT_MS` 之内。
    /// 换句话说「最多 256 个文件」这句话只在没有结果时严格成立；用户真正在乎的
    /// 「最多多久没信号」那一头，两种情况下都守在 250ms 以内。
    fn heartbeat(&mut self, scanned: u32) {
        if !self.files.is_empty() {
            return;
        }
        if scanned - self.last_emit_scanned >= HEARTBEAT_FILES
            || self.last_emit.elapsed() >= Duration::from_millis(HEARTBEAT_MS)
        {
            self.emit(scanned);
        }
    }

    fn flush(&mut self, scanned: u32) {
        if self.files.is_empty() {
            return;
        }
        self.emit(scanned);
    }

    /// 真的推一批出去。`files` 为空时这就是一次心跳。
    fn emit(&mut self, scanned: u32) {
        // 先 take 再调回调：回调要是又触发了什么（生产上是 `app.emit`），
        // 手上还留着一份已经被交出去的批次是一份等着被重复发送的状态
        let files = std::mem::take(&mut self.files);
        self.hits = 0;
        self.last_emit = Instant::now();
        self.last_emit_scanned = scanned;
        (self.on_batch)(SearchBatch { files, files_scanned: scanned });
    }
}

#[derive(Debug, Default)]
struct Tally {
    files_scanned: u32,
    files_with_hits: u32,
    hits: u32,
    skipped_too_large: u32,
    unreadable: u32,
    truncated: bool,
    cancelled: bool,
}

impl Tally {
    fn into_summary(self, elapsed_ms: u64) -> SearchSummary {
        SearchSummary {
            files_scanned: self.files_scanned,
            files_with_hits: self.files_with_hits,
            hits: self.hits,
            skipped_too_large: self.skipped_too_large,
            unreadable: self.unreadable,
            truncated: self.truncated,
            cancelled: self.cancelled,
            elapsed_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    /// ```text
    /// root/
    /// ├── .gitignore            build/ 与 *.log
    /// ├── README.md             1 处命中
    /// ├── src/main.rs           2 处命中（其中一行有两个）
    /// ├── src/lib.rs            0 处命中
    /// ├── build/out.txt         命中，但被 .gitignore 挡掉
    /// └── notes.log             命中，但被 .gitignore 挡掉
    /// ```
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::write(root.join("README.md"), "# needle 的说明\n没有命中的行\n").unwrap();
        fs::write(root.join("src/main.rs"), "fn main() { needle(); }\nlet a = 1;\nneedle + needle\n").unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn nothing() {}\n").unwrap();
        fs::write(root.join("build/out.txt"), "needle in build output\n").unwrap();
        fs::write(root.join("notes.log"), "needle in a log\n").unwrap();
        dir
    }

    fn query(pattern: &str) -> SearchQuery {
        SearchQuery { pattern: pattern.to_owned(), ..SearchQuery::default() }
    }

    /// 跑一次搜索，返回「所有批次」与总账。
    fn run(root: &Path, q: &SearchQuery) -> (Vec<SearchBatch>, SearchSummary) {
        let mut batches = Vec::new();
        let summary = search(root, q, &AtomicBool::new(false), |b| batches.push(b)).unwrap();
        (batches, summary)
    }

    /// 跑一次搜索，只把所有文件平铺出来（跨批次）。
    fn collect(root: &Path, q: &SearchQuery) -> Vec<SearchFile> {
        run(root, q).0.into_iter().flat_map(|b| b.files).collect()
    }

    fn rels(root: &Path, q: &SearchQuery) -> Vec<String> {
        collect(root, q).into_iter().map(|f| f.rel).collect()
    }

    fn hits_of(root: &Path, q: &SearchQuery) -> Vec<SearchHit> {
        collect(root, q).into_iter().flat_map(|f| f.hits).collect()
    }

    /// 按 rel 取出一个文件的结果。
    ///
    /// ⚠️ 不要用 `collect(..)[i]` / `hits_of(..)[0]`：`fixture()` 里的 `README.md`
    /// 本身就含 `needle`，而且按文件名排在最前面，所以位置索引拿到的常常是它。
    /// 那样写出来的测试会「通过」，通过的却是别的文件——写下这个 helper 之前，
    /// 有三条测试正是这样错的（其中两条当场红了，一条红在断言的其实是 README）。
    fn file_of(root: &Path, q: &SearchQuery, rel: &str) -> SearchFile {
        collect(root, q).into_iter().find(|f| f.rel == rel).unwrap_or_else(|| panic!("{rel} 没有命中"))
    }

    /// `rel` 这个文件里的那条命中（要求正好一条）。
    fn hit_in(root: &Path, q: &SearchQuery, rel: &str) -> SearchHit {
        let file = file_of(root, q, rel);
        assert_eq!(file.hits.len(), 1, "{rel} 应该正好一条命中，实际 {:?}", file.hits);
        file.hits.into_iter().next().unwrap()
    }

    /// 按 **UTF-16 码元**切一段——`String.prototype.slice` 在 Rust 里的等价物。
    ///
    /// 用它来断言偏移量，等于让测试自己走一遍前端会走的那条路：
    /// 直接断言 `start == 15` 只证明「Rust 算出了 15」，切一次才证明「15 是对的」。
    fn js_slice(text: &str, start: u32, end: u32) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16_lossy(&units[start as usize..end as usize])
    }

    // ── 基本形状 ────────────────────────────────────────────────────────────

    #[test]
    fn 命中按文件分组_行号与文本都对() {
        let dir = fixture();
        let files = collect(dir.path(), &query("needle"));

        assert_eq!(files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), ["README.md", "src/main.rs"]);
        // 目录不产生命中，`src` 本身不在结果里
        assert!(!files.iter().any(|f| f.rel == "src"));

        let main = &files[1];
        assert_eq!(main.path, dir.path().join("src/main.rs").display().to_string());
        assert_eq!(main.hits.len(), 2, "两行命中，其中一行有两个命中段");
        assert_eq!(main.hits[0].line, 1);
        assert_eq!(main.hits[0].text, "fn main() { needle(); }");
        assert_eq!(main.hits[1].line, 3);
        assert!(!main.truncated);
    }

    /// `rel` 与 `path` 的关系必须与 `DirEntry` 那一份完全一致：前端拿 `rel` 去树上定位、
    /// 拿 `path` 去开文件，两者对不上的失败方式是「点了搜索结果，打开的是别的文件」。
    #[test]
    fn 命中里的_rel_与_path_指向同一个文件() {
        let dir = fixture();
        for file in collect(dir.path(), &query("needle")) {
            assert!(!file.rel.starts_with('/') && !file.rel.ends_with('/'), "{}", file.rel);
            assert!(!file.rel.contains('\\'), "{}", file.rel);
            assert_eq!(Path::new(&file.path), dir.path().join(&file.rel), "{}", file.rel);
        }
    }

    #[test]
    fn 一行里的多个命中都标出来_升序且不重叠() {
        let dir = fixture();
        let main = file_of(dir.path(), &query("needle"), "src/main.rs");
        let hit = &main.hits[1];
        assert_eq!(hit.text, "needle + needle");
        assert_eq!(hit.ranges, vec![MatchRange { start: 0, end: 6 }, MatchRange { start: 9, end: 15 }]);
    }

    /// `text` 里**不带**行终止符。
    ///
    /// ⚠️ 这一条钉的是我们从 `sinks::Lossy` 手里接过来之后的加工：那个 `&str` 是带着
    /// `\n` 的，`strip_terminator` 把它脱掉。带着它的失败方式有三层，一层比一层难查：
    /// 预览末尾多一个看不见的字符 → `text.len()` 对不上编辑器里那一行 →
    /// CRLF 文件里末尾还留一个 `\r`，而 Windows 上写的文件在 macOS 上打开就是这种。
    #[test]
    fn 命中里的文本不带行尾换行_两种行尾与没有换行的最后一行都一样() {
        let dir = fixture();
        let root = dir.path();
        fs::write(root.join("lf.txt"), "needle\n").unwrap();
        fs::write(root.join("crlf.txt"), "needle\r\nsecond needle\r\n").unwrap();
        // 最后一行没有换行：`strip_suffix` 找不到就什么也不做，不能因此 panic 或者少一条
        fs::write(root.join("noeol.txt"), "first\nneedle").unwrap();

        assert_eq!(hit_in(root, &query("needle"), "lf.txt").text, "needle");

        let crlf = file_of(root, &query("needle"), "crlf.txt");
        assert_eq!(crlf.hits.len(), 2);
        assert_eq!(crlf.hits[0].text, "needle", "末尾那个 \\r 也要脱掉");
        assert_eq!(crlf.hits[1].text, "second needle");

        let noeol = file_of(root, &query("needle"), "noeol.txt");
        assert_eq!(noeol.hits.len(), 1, "没有换行的最后一行照样搜得到");
        assert_eq!(noeol.hits[0].text, "needle");
        assert_eq!(noeol.hits[0].line, 2);
    }

    /// ⚠️ 这条断言的是「不推任何**结果**」，不是「不推任何批次」。
    ///
    /// 心跳上线之前这里写的是 `batches.is_empty()`，理由还是「推一个空的过去，
    /// 前端要多处理一种状态」。心跳把那个理由推翻了：一个空批次现在**正是**
    /// 「还在扫」这句话本身，而十万个文件一个都不命中时它是前端手上唯一的东西。
    /// 于是这条测试的口径跟着改成了「空批次可以来，带着结果的不许来」。
    #[test]
    fn 没有命中时不推任何结果_而总账照样回来() {
        let dir = fixture();
        let (batches, summary) = run(dir.path(), &query("一个都搜不到的词"));
        assert!(batches.iter().all(|b| b.files.is_empty()), "没有命中就不该推结果：{batches:?}");
        assert_eq!(summary.hits, 0);
        assert_eq!(summary.files_with_hits, 0);
        // 但文件确实被扫了：`files_scanned` 是「0 个结果」与「压根没搜」的唯一区别
        assert!(summary.files_scanned > 0);
        assert!(!summary.truncated && !summary.cancelled);
    }

    /// 心跳的**文件数**那一半。
    ///
    /// ⚠️ 时间那一半（`HEARTBEAT_MS`）故意不在这里钉：要让它确定地触发就得 sleep，
    /// 而一条靠 sleep 的测试测的是调度器——它在快的机器上过、在慢的机器上红，
    /// 两边都指不出任何真实的问题。所以这里断言的是**与机器快慢无关**的那条性质：
    /// 「相邻两次信号之间最多 `HEARTBEAT_FILES` 个文件」。时间那一半只会让间隔更小，
    /// 永远不会让这条断言失败。
    ///
    /// 而 `!batches.is_empty()` 这半句钉的正是文件数那一半在干活：
    /// 把它删掉的话，在一台够快的机器上（250ms 内扫完 306 个小文件）这条测试会红。
    #[test]
    fn 扫过很多个没有命中的文件时会推心跳() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let total = HEARTBEAT_FILES + 50;
        for i in 0..total {
            fs::write(root.join(format!("f{i:04}.txt")), "nothing here\n").unwrap();
        }

        let (batches, summary) = run(root, &query("needle"));
        assert_eq!(summary.files_scanned, total, "本测试的前提：每个文件都被扫过了");
        assert_eq!(summary.hits, 0);

        assert!(!batches.is_empty(), "一个都不命中时，心跳是前端手上唯一的东西");
        assert!(batches.iter().all(|b| b.files.is_empty()), "心跳不带结果：{batches:?}");

        let scanned: Vec<u32> = batches.iter().map(|b| b.files_scanned).collect();
        // 累计值，不是增量：单调不减，而且不会超过总数
        assert!(scanned.windows(2).all(|w| w[0] <= w[1]), "{scanned:?} 应该是单调不减的");
        assert!(scanned.iter().all(|&s| s <= total), "{scanned:?} 越过了总数 {total}");
        // 真正钉住「文件数那一半」的那条：任何一个间隔都不能大于阈值
        let mut prev = 0;
        for &cur in &scanned {
            assert!(cur - prev <= HEARTBEAT_FILES, "两次信号之间隔了 {} 个文件：{scanned:?}", cur - prev);
            prev = cur;
        }
    }

    /// 结尾那次 `flush` 在没有结果压着时**不**补一次心跳。
    ///
    /// 单独测 `Collector` 是因为这件事在 `search()` 的层面上测不出来：
    /// 时间那一半的心跳完全可能正好落在最后一个文件上，于是「多推的那个空批次」
    /// 与「合法的最后一次心跳」长得一模一样，断言它就只能靠机器够快——那是随机红的。
    #[test]
    fn 结尾那次冲批在没有结果时什么也不推() {
        let mut batches = Vec::new();
        {
            // ⚠️ 圈一个作用域：`Collector::new` 的闭包借走了 `batches`，
            // 在它活着的时候读 `batches` 是 E0502
            let mut collector = Collector::new(|b| batches.push(b));
            collector.flush(999);
            collector.push(
                SearchFile { rel: "a.txt".into(), path: "/a.txt".into(), hits: Vec::new(), truncated: false },
                999,
            );
            collector.flush(999);
        }
        assert_eq!(batches.len(), 1, "第一次手上没有结果所以什么也不推，第二次带着那个文件推出去：{batches:?}");
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files_scanned, 999);
    }

    // ── ⚠️ .gitignore：与文件树方向相反 ─────────────────────────────────────

    /// **这一条与 `project::tree` 的 `gitignore_命中的条目照常列出` 方向相反，
    /// 而且是刻意相反的。**
    ///
    /// 树是按需的，过滤省下的是本来就没花的钱；搜索要读每个文件的正文，
    /// 不过滤就等于 grep 十万个依赖文件。两条测试都留着，谁也不许「顺手统一」成另一条。
    #[test]
    fn gitignore_命中的文件不搜() {
        let dir = fixture();
        let rels = rels(dir.path(), &query("needle"));
        assert!(!rels.iter().any(|r| r.starts_with("build/")), "build/ 在 .gitignore 里：{rels:?}");
        assert!(!rels.contains(&"notes.log".to_owned()), "*.log 在 .gitignore 里：{rels:?}");

        // 这两个文件**确实存在也确实含命中**：少了这一句，上面的断言在
        // 「fixture 压根没建这两个文件」的情况下同样会绿
        assert!(fs::read_to_string(dir.path().join("build/out.txt")).unwrap().contains("needle"));
        assert!(fs::read_to_string(dir.path().join("notes.log")).unwrap().contains("needle"));
        assert_eq!(crate::project::list_dir(dir.path(), "").unwrap().entries.len(), 5, "树那边照会把它们列出来");
    }

    /// `require_git(false)` 的意义：**没有 `.git` 目录时 `.gitignore` 仍然算数**。
    ///
    /// `ignore` 的默认值是「不在仓库里就完全不过滤」。用户打开的文件夹是不是一个
    /// git 仓库，与他要不要搜 `build/` 里的产物没有关系。
    #[test]
    fn 没有_git_目录时_gitignore_仍然生效() {
        let dir = fixture();
        assert!(!dir.path().join(".git").exists(), "本测试的前提：fixture 不是一个 git 仓库");
        assert!(rels(dir.path(), &query("needle")).iter().all(|r| !r.starts_with("build/")));
    }

    /// `.gitignore` 自己**也会被搜**——它是仓库里的一个普通文本文件，
    /// 用户搜「build」的时候想看到它。
    #[test]
    fn gitignore_文件自己照搜() {
        let dir = fixture();
        assert!(rels(dir.path(), &query("build")).contains(&".gitignore".to_owned()));
    }

    /// `hidden(false)` 换来的东西与它的代价，一条测试里同时钉住。
    ///
    /// 收益是 `.github/workflows/ci.yml` 这种「点开头但用户真要搜」的文件不再被漏掉；
    /// 代价是 `.git` 也不再被顺带挡掉，所以必须显式挡一次。
    #[test]
    fn 点开头的目录照搜_但_git_整个不搜() {
        let dir = fixture();
        let root = dir.path();
        fs::create_dir_all(root.join(".github/workflows")).unwrap();
        fs::write(root.join(".github/workflows/ci.yml"), "run: needle\n").unwrap();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::write(root.join(".git/config"), "needle = true\n").unwrap();
        fs::write(root.join(".git/objects/pack"), "needle\n").unwrap();

        let rels = rels(root, &query("needle"));
        assert!(rels.contains(&".github/workflows/ci.yml".to_owned()), "点开头的普通目录要搜：{rels:?}");
        assert!(!rels.iter().any(|r| r.starts_with(".git/")), ".git 里面从来不搜：{rels:?}");
    }

    // ── 符号链接：也是与文件树相反 ──────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn 符号链接不跟随_不管指向文件还是目录() {
        let dir = fixture();
        let root = dir.path();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "needle outside\n").unwrap();
        fs::create_dir(outside.path().join("pkg")).unwrap();
        fs::write(outside.path().join("pkg/index.js"), "needle in pkg\n").unwrap();

        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("link-file.txt")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("pkg"), root.join("link-dir")).unwrap();

        let rels = rels(root, &query("needle"));
        assert!(!rels.iter().any(|r| r.contains("link-")), "两个链接都不该被搜：{rels:?}");
        // 链接指向的东西本身没被搜到（它们长在 root 外面，遍历压根到不了）
        assert!(!rels.iter().any(|r| r.contains("secret") || r.contains("index.js")));
    }

    // ── include / exclude 落到真实路径上 ────────────────────────────────────

    #[test]
    fn include_通配把不匹配的文件整个挡在扫描之外() {
        let dir = fixture();
        let q = SearchQuery { include: vec!["*.rs".to_owned()], ..query("needle") };
        assert_eq!(rels(dir.path(), &q), ["src/main.rs"]);
    }

    #[test]
    fn exclude_通配把匹配的文件拿掉() {
        let dir = fixture();
        let q = SearchQuery { exclude: vec!["src/*".to_owned()], ..query("needle") };
        assert_eq!(rels(dir.path(), &q), ["README.md"]);
    }

    // ── 偏移量是 UTF-16 码元 ────────────────────────────────────────────────

    /// ⚠️ 这一条是「偏移量按 UTF-16 数」的钉子。
    ///
    /// `😀` 是**一个字符、两个 UTF-16 码元、四个字节**。三套计数在这一行上互不相同，
    /// 所以它是唯一能一次性区分三者的测试数据。前端把这个区间直接交给 CodeMirror，
    /// 而 CodeMirror 的位置就是 UTF-16 码元——发字符偏移的话高亮会整体左移一个字，
    /// 且只在含 emoji / CJK 扩展区的行上出现，安静得几乎查不到。
    #[test]
    fn 偏移量数的是码元_不是字符也不是字节() {
        let dir = fixture();
        fs::write(dir.path().join("emoji.txt"), "let emoji = \"😀needle\";\n").unwrap();

        let hit = hit_in(dir.path(), &query("needle"), "emoji.txt");
        assert_eq!(hit.text, "let emoji = \"😀needle\";");
        assert_eq!(hit.ranges, vec![MatchRange { start: 15, end: 21 }]);
        assert_eq!(js_slice(&hit.text, 15, 21), "needle", "按 UTF-16 码元切回来正好是命中那段");

        // `needle` 的起点按字节是 17、按字符是 14、按 UTF-16 码元是 15——三个数互不相同，
        // 所以这一行能一次性区分三套口径（只有 emoji 这种「非 BMP 且非 ASCII」的字符做得到，
        // 纯中文行上字符数与 UTF-16 码元数重合，见下一条测试）。
        // 下面三个断言不是凑数：它们证明 15 是算出来的，不是从别的实现里抄来的
        assert_eq!(hit.text.chars().count(), 22, "字符数");
        assert_eq!(hit.text.encode_utf16().count(), 23, "UTF-16 码元数");
        assert_eq!(hit.text.len(), 25, "字节数");
    }

    #[test]
    fn 纯中文行的偏移量与字符数相同_但仍然是按码元算的() {
        let dir = fixture();
        fs::write(dir.path().join("cn.txt"), "落霞与孤鹜齐飞\n").unwrap();
        let hit = hit_in(dir.path(), &query("孤鹜"), "cn.txt");
        // BMP 里的汉字是一个字符一个 UTF-16 码元，所以这里两套计数恰好重合。
        // 钉住它是为了说明「上面那条 emoji 测试不是因为算错了才需要 15」
        assert_eq!(hit.ranges, vec![MatchRange { start: 3, end: 5 }]);
        assert_eq!(js_slice(&hit.text, 3, 5), "孤鹜");
    }

    // ── 各种上限 ────────────────────────────────────────────────────────────

    /// 一个正好 `MAX_HITS_PER_FILE` 行的文件**不算**被截断。
    ///
    /// 「达到上限就报截断」的写法会让这个文件被标成「还有更多」，而它其实已经扫完了。
    /// 判据是「**超过**上限」，代价是多扫一行。
    #[test]
    fn 正好撞上限的文件不报截断_超过一行才报() {
        let dir = fixture();
        let root = dir.path();
        let body = "needle\n".repeat(MAX_HITS_PER_FILE as usize);
        fs::write(root.join("exact.txt"), &body).unwrap();
        fs::write(root.join("over.txt"), format!("{body}needle\n")).unwrap();

        let files = collect(root, &query("needle"));
        let exact = files.iter().find(|f| f.rel == "exact.txt").unwrap();
        let over = files.iter().find(|f| f.rel == "over.txt").unwrap();

        assert_eq!(exact.hits.len(), MAX_HITS_PER_FILE as usize);
        assert!(!exact.truncated, "正好 500 行，全都在这儿了");
        assert_eq!(over.hits.len(), MAX_HITS_PER_FILE as usize, "多出来的那一条不进结果");
        assert!(over.truncated);
        assert_eq!(over.hits.last().unwrap().line, MAX_HITS_PER_FILE, "留下的是**最前面**的 500 条");
    }

    #[test]
    fn 总命中撞到上限时整个搜索停下来() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // 45 个文件 × 500 条 = 22500，超过 MAX_HITS(20000)，所以在第 40 个文件之后停
        let body = "needle\n".repeat(MAX_HITS_PER_FILE as usize);
        for i in 0..45 {
            fs::write(root.join(format!("f{i:02}.txt")), &body).unwrap();
        }

        let (batches, summary) = run(root, &query("needle"));
        assert!(summary.truncated);
        assert_eq!(summary.hits, MAX_HITS);
        assert_eq!(summary.files_scanned, MAX_HITS / MAX_HITS_PER_FILE);
        assert!(!summary.cancelled);
        // 已经推出去的批次一条不少
        let pushed: usize = batches.iter().map(|b| b.files.iter().map(|f| f.hits.len()).sum::<usize>()).sum();
        assert_eq!(pushed, MAX_HITS as usize);
    }

    #[test]
    fn 太大的文件整个跳过_并且单独计数() {
        let dir = fixture();
        let root = dir.path();
        // `edge.txt` 必须是真的写满 10MiB 的**文本**：`set_len` 撑出来的稀疏文件正文全是
        // NUL，会被二进制探测整个丢掉，那样「出现在结果里」就证不了「它被扫过」——
        // 而这条测试要钉的正是 `>` 与 `==` 的分界
        let mut body = "x".repeat(MAX_FILE_BYTES as usize - "needle\n".len());
        body.push_str("needle\n");
        assert_eq!(body.len() as u64, MAX_FILE_BYTES, "正好等于上限");
        fs::write(root.join("edge.txt"), &body).unwrap();
        // `big.txt` 的内容无所谓——它压根不会被读，所以这里用 `set_len` 省掉 10MiB 的写入
        let mut big = fs::File::create(root.join("big.txt")).unwrap();
        big.write_all(b"needle\n").unwrap();
        big.set_len(MAX_FILE_BYTES + 1).unwrap();

        let (batches, summary) = run(root, &query("needle"));
        let files: Vec<SearchFile> = batches.into_iter().flat_map(|b| b.files).collect();
        assert_eq!(summary.skipped_too_large, 1, "只有超过上限的那个被跳过");
        assert!(!files.iter().any(|f| f.rel == "big.txt"), "超过上限的整个不扫");

        let edge = files.iter().find(|f| f.rel == "edge.txt").expect("正好等于上限的照常扫");
        assert_eq!(edge.hits.len(), 1, "10MiB 的正文只有末尾一处命中");
        assert!(!edge.truncated, "「命中数」没有截断；预览那一行的截断是另一回事");
    }

    /// minified 的产物可以把整个文件压成一行。不留预览上限的话一行就能顶掉一批的预算。
    #[test]
    fn 超长的一行被截断_落在截断之外的命中段不标() {
        let dir = fixture();
        let root = dir.path();
        let mut line = "x".repeat(MAX_PREVIEW_BYTES + 500);
        line.push_str("needle");
        fs::write(root.join("min.js"), format!("needle{line}\n")).unwrap();

        let hit = hit_in(root, &query("needle"), "min.js");
        assert!(hit.truncated);
        assert!(hit.text.len() <= MAX_PREVIEW_BYTES);
        // 开头那个命中在预览里，后面那个被截掉了：`ranges` 只剩一个，
        // 而不是「有一个偏移量指向 text 之外」——后者会让前端的高亮画到别的字上
        assert_eq!(hit.ranges, vec![MatchRange { start: 0, end: 6 }]);
        assert_eq!(js_slice(&hit.text, 0, 6), "needle");
    }

    /// ⚠️ 这一条钉的是 `grep-searcher` **本来的**行为，不是我们加的规则：
    /// 默认的二进制探测是「见到 NUL 就停」。
    ///
    /// 钉住它的价值在于将来有人改 `Searcher` 的配置时会先看到这条测试。
    /// 要是哪天它红了，说明二进制文件开始产出命中了——那会把一堆
    /// `pack-*.idx` 之类的东西塞进搜索结果里。
    #[test]
    fn 含空字符的二进制文件不产生命中() {
        let dir = fixture();
        let root = dir.path();
        let mut bytes = vec![0x00u8, 0xFF];
        bytes.extend_from_slice(b"\nneedle\n");
        fs::write(root.join("blob.bin"), &bytes).unwrap();

        assert!(rels(root, &query("needle")).iter().all(|r| r != "blob.bin"));
    }

    /// `quit` 的**另一半**，以及它的边界在哪儿。
    ///
    /// 实测（不是猜的，两个数字都来自跑过的事实）：
    /// - NUL 落在**第一个读缓冲**里 → 整个文件一条命中都不报。真实的二进制文件
    ///   （`.woff2`、`.png`、`pack-*.idx`、ELF）几乎都是这一种，所以搜索结果里不会混进垃圾。
    /// - NUL 落在很后面 → 更早的缓冲里已经报出去的命中**留着**，含 NUL 的那个缓冲
    ///   及之后全部丢掉。
    ///
    /// ⚠️ 切在哪儿是 `grep-searcher` 的缓冲边界，我们**不依赖它的具体位置**——
    /// 上面两条断言只区分「第一个缓冲内」与「远在后面」，不写死 64KB。
    ///
    /// ⚠️ 已知限制：`search_path` 返回的是 `()` 而不是「有没有搜完」，所以二进制收手
    /// 与「这文件就这几处」在返回值上长得一样，`SearchFile::truncated` 于是保持 false。
    /// 要修得自己实现 `Sink` 并接 `binary_data` 钩子（顺便给总账加一个 `skippedBinary`），
    /// 而 `sinks::Lossy` 里那套行号簿记重写一遍很容易出错。收益是「一个前 64KB 不含 NUL
    /// 的二进制文件不再报出垃圾命中」——按上面第一条，那种文件很少。记在这儿，不是忘了。
    #[test]
    fn 空字符在第一个缓冲里时整个文件不报_在很后面时之前的命中留着() {
        let dir = fixture();
        let root = dir.path();

        let mut early = b"head needle\n".to_vec();
        early.extend_from_slice(&[0x00]);
        early.extend_from_slice(b"\ntail needle\n");
        fs::write(root.join("nul_early.bin"), &early).unwrap();

        let mut late = b"head needle\n".to_vec();
        late.extend_from_slice("x\n".repeat(100_000).as_bytes());
        late.extend_from_slice(b"mid needle\n");
        late.extend_from_slice(&[0x00]);
        late.extend_from_slice(b"\ntail needle\n");
        fs::write(root.join("nul_late.bin"), &late).unwrap();

        assert!(
            collect(root, &query("needle")).iter().all(|f| f.rel != "nul_early.bin"),
            "第一个缓冲里的 NUL 让整个文件出局"
        );

        let late = file_of(root, &query("needle"), "nul_late.bin");
        assert_eq!(late.hits.len(), 1, "只留下更早那个缓冲里的命中：{:?}", late.hits);
        assert_eq!(late.hits[0].text, "head needle");
        assert!(!late.truncated, "已知限制：收手的文件不会被标成截断，见上面的注释");
    }

    /// `sinks::Lossy` 换来的东西：**一份非 UTF-8 的文件不会从结果里整个消失**。
    ///
    /// 用 `sinks::UTF8` 的话这个文件会让 `search_path` 报错，于是它被计入 `unreadable`
    /// 而不产生命中——用户搜一个明明在文件里的标识符，得到「0 个结果」加一句
    /// 「有 1 个文件读不出来」，而那个文件正是他要的。
    #[test]
    fn 非纯文本编码的文件走有损解码_英文搜索词照样命中() {
        let dir = fixture();
        let root = dir.path();
        // 0xC2 在 UTF-8 里是一个双字节序列的开头，后面必须跟 0x80..0xBF，
        // 这里跟的是 0xE4，所以这两个字节是非法 UTF-8（GBK 编码的中文长这样）
        let mut bytes = b"// ".to_vec();
        bytes.extend_from_slice(&[0xC2, 0xE4]);
        bytes.extend_from_slice(b" needle\n");
        fs::write(root.join("gbk.txt"), &bytes).unwrap();

        let hits = hits_of(root, &query("needle"));
        let hit = hits.iter().find(|h| h.text.contains("needle") && h.text.contains('\u{FFFD}'));
        assert!(hit.is_some(), "非法字节被换成 U+FFFD，ASCII 那半照常命中：{hits:?}");

        // ⚠️ 诚实的限制：**中文搜索词搜不到非 UTF-8 文件里的中文**，字节序列不同。
        // 要支持它得先按探测出的编码把整个文件解码一遍——`fs` 那边有探测器，
        // 但把它接到搜索上是另一件事，不在 M2-C 里
        let hit = hits.iter().find(|h| h.ranges.iter().any(|r| js_slice(&h.text, r.start, r.end) == "needle"));
        assert!(hit.is_some(), "命中段的偏移量在 lossy 之后仍然对得上");
    }

    // ── 取消 ────────────────────────────────────────────────────────────────

    /// 在第一批推出去的那一刻置真——这是唯一能**确定地**「搜到一半」的办法。
    ///
    /// 靠 sleep 或者另起一个线程的话，这条测试测的就是调度器：它会在快的机器上过、
    /// 在慢的机器上红，而两边都没有指出任何真实的问题。
    #[test]
    fn 取消之后搜索停下_已经推出去的批次留着() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // 40 个文件各一处命中：不取消的话要 3 批（16 + 16 + 8）
        for i in 0..40 {
            fs::write(root.join(format!("f{i:02}.txt")), "needle\n").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let mut batches = Vec::new();

        let summary = search(root, &query("needle"), &cancel, |b| {
            batches.push(b);
            cancel.store(true, Ordering::Relaxed);
        })
        .unwrap();

        assert_eq!(batches.len(), 1, "第一批推出去之后就停了");
        assert_eq!(batches[0].files.len(), BATCH_FILES);
        assert!(summary.cancelled);
        assert_eq!(summary.files_scanned, BATCH_FILES as u32, "剩下的 24 个文件一个都没扫");
        assert!(!summary.truncated, "取消不是截断，两个数在 UI 上是两句话");
    }

    /// 一开始就取消：一个文件都不扫，也不推任何批次。
    ///
    /// 这条路在生产上是「用户在搜索结果出来之前就点了取消」，
    /// 而它的失败方式是前端收到一个空批次、把界面切到「0 个结果」。
    #[test]
    fn 一开始就取消时什么也不推() {
        let dir = fixture();
        let cancel = AtomicBool::new(true);
        let mut batches = Vec::new();
        let summary = search(dir.path(), &query("needle"), &cancel, |b| batches.push(b)).unwrap();
        assert!(batches.is_empty());
        assert!(summary.cancelled);
        assert_eq!(summary.files_scanned, 0);
    }

    // ── 批次 ────────────────────────────────────────────────────────────────

    #[test]
    fn 攒够一批就推_最后一批不满也推() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..(BATCH_FILES * 2 + 8) {
            fs::write(root.join(format!("f{i:02}.txt")), "needle\n").unwrap();
        }

        let (batches, summary) = run(root, &query("needle"));
        let sizes: Vec<usize> = batches.iter().map(|b| b.files.len()).collect();
        assert_eq!(sizes, [BATCH_FILES, BATCH_FILES, 8]);
        // ⚠️ 最后一批是这一条测试真正的重点：漏掉 `flush()` 的话它会安静地消失，
        // 而用户看到的是「搜索结果少了末尾几个文件」——最难发现的一种少
        assert_eq!(sizes.iter().sum::<usize>(), summary.files_with_hits as usize);
    }

    /// 命中很多但文件很少时，按**命中数**冲批。
    ///
    /// 只按文件数攒的话，16 个各 500 条命中的文件会攒出一个 8000 条的批次。
    #[test]
    fn 命中数也能触发冲批() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let body = "needle\n".repeat(BATCH_HITS + 40);
        fs::write(root.join("a.txt"), &body).unwrap();
        fs::write(root.join("b.txt"), &body).unwrap();

        let (batches, _) = run(root, &query("needle"));
        assert_eq!(batches.len(), 2, "一个文件就顶破了命中数上限，于是各成一批");
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[1].files.len(), 1);
    }

    // ── 读不动的东西 ────────────────────────────────────────────────────────

    /// ⚠️ 这个数非零意味着「没找到」可能是假的，所以 UI 必须说出来。
    ///
    /// 前提断言（`fs::read` 确实失败）是这条测试的一半价值：以 root 身份跑的话
    /// `chmod 000` 挡不住任何人，少了这句它会**静默地什么也没测**——
    /// 与 `project::tree` 那条「大小写平局只能用合成数据测」是同一个教训。
    #[cfg(unix)]
    #[test]
    fn 读不动的文件计入_unreadable_而搜索继续() {
        use std::os::unix::fs::PermissionsExt;

        let dir = fixture();
        let root = dir.path();
        fs::write(root.join("locked.txt"), "needle\n").unwrap();
        let locked = root.join("locked.txt");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        assert!(fs::read(&locked).is_err(), "本测试的前提：这个文件当前用户读不动");

        let rels = rels(root, &query("needle"));
        assert!(!rels.contains(&"locked.txt".to_owned()));
        // 关键的一半：**别的文件照常搜到了**。整次搜索失败比少搜一个文件糟得多
        assert!(rels.contains(&"README.md".to_owned()));

        let (_, summary) = run(root, &query("needle"));
        assert_eq!(summary.unreadable, 1);
        assert!(summary.files_scanned >= 3, "被挡掉的那个不算扫过");

        // 收尾：把权限还回去，否则 TempDir 删不掉自己
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    }

    // ── root 检查 ───────────────────────────────────────────────────────────

    #[test]
    fn root_不是绝对路径被拒() {
        // 防的是**静默的错答案**：相对路径按进程的 cwd 解析，
        // 而 `.app` 双击启动时 cwd 是 `/`，于是搜的是整个磁盘
        assert_eq!(
            search(Path::new("repo"), &query("x"), &AtomicBool::new(false), |_| {}).unwrap_err(),
            SearchError::BadRoot { path: "repo".to_owned() }
        );
    }

    #[test]
    fn root_不存在或者不是目录都被拒() {
        let dir = fixture();
        let missing = dir.path().join("nope");
        assert_eq!(
            search(&missing, &query("x"), &AtomicBool::new(false), |_| {}).unwrap_err(),
            SearchError::NotFound { path: missing.display().to_string() }
        );
        let file = dir.path().join("README.md");
        assert_eq!(
            search(&file, &query("x"), &AtomicBool::new(false), |_| {}).unwrap_err(),
            SearchError::NotFound { path: file.display().to_string() }
        );
    }

    /// 指向目录的符号链接可以当 root：`metadata` 跟着链接走。
    #[cfg(unix)]
    #[test]
    fn 指向目录的符号链接可以当_root() {
        let dir = fixture();
        let holder = tempfile::tempdir().unwrap();
        let link = holder.path().join("to-repo");
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        assert!(!rels(&link, &query("needle")).is_empty());
    }

    /// 每一个 `SearchError` 都发生在第一批结果之前。
    ///
    /// 这条性质让前端的规则可以很简单：`start_search` reject 了 = 这次搜索压根没开始；
    /// 收到了 event = 搜索开始了，剩下的只会是 done。
    #[test]
    fn 出错时一个批次都没推出去() {
        let dir = fixture();
        for q in [query(""), query("a\nb"), query("(没关上")] {
            let mut batches = 0;
            let err = search(dir.path(), &q, &AtomicBool::new(false), |_| batches += 1).unwrap_err();
            assert_eq!(batches, 0, "{err}");
        }
    }

    /// `preflight` 与 `search` 的结论**必须一致**。
    ///
    /// 两者共用 `prepare` 这一个实现处，所以这条测试今天看来是同义反复。它防的是将来：
    /// 有人在 `search()` 里多加一条检查（比如「root 必须是个 git 仓库」）而忘了同步
    /// `prepare`，于是 `preflight` 说「可以搜」、Tauri 那边返回了 taskId、
    /// 后台线程里 `search()` 才报错——前端于是收到一个它按规则**不可能**收到的
    /// failed event，而那条路径既没有 UI 也没有别的测试。
    ///
    /// ⚠️ 断言的是「同一个错误值」而不只是「都是 Err」：只判 is_err 的话，
    /// `preflight` 报 `BadRoot` 而 `search` 报 `NotFound` 也能过，
    /// 而前端会因此把「路径不对」显示成「文件夹没了」。
    #[test]
    fn 起飞前检查的两个入口结论一致() {
        let dir = fixture();
        let root = dir.path();
        let missing = root.join("nope");
        let file = root.join("README.md");
        let cases: Vec<(&Path, SearchQuery)> = vec![
            (root, query("needle")),
            (root, query("")),
            (root, query("a\nb")),
            (root, query("(没关上")),
            (root, SearchQuery { include: vec!["[".to_owned()], ..query("needle") }),
            (root, SearchQuery { exclude: vec!["[".to_owned()], ..query("needle") }),
            (Path::new("repo"), query("needle")),
            (&missing, query("needle")),
            (&file, query("needle")),
        ];

        for (case_root, q) in cases {
            let before = preflight(case_root, &q);
            let during = search(case_root, &q, &AtomicBool::new(false), |_| {});
            match (&before, &during) {
                (Ok(()), Ok(_)) => {}
                (Err(a), Err(b)) => assert_eq!(a, b, "{case_root:?} {q:?}：两个入口报的不是同一个错"),
                _ => panic!("{case_root:?} {q:?}：preflight 是 {before:?} 而 search 是 {:?}", during.is_ok()),
            }
        }
    }

    // ── 线上形状 ────────────────────────────────────────────────────────────
    //
    // `MatchRange` / `SearchHit` / `SearchFile` / `SearchBatch` / `SearchSummary` 的黄金 JSON
    // 不在这里，在 `crates/vela-core/tests/wire_contract.rs` 的「M2-C 全文搜索」那一节
    // （契约测试只能用 pub 的东西，放 `tests/` 才逼得住这条边界）。那边还有一条
    // `真实搜索的批次与总账互相对得上`，负责把字面量与这里跑出来的真实输出连起来。
}
