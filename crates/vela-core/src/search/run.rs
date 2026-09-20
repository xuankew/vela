//! 遍历 + 扫描 + 分批（PLAN.md §3.4 M2-C）。
//!
//! 这一层的形状是一条直线：`ignore::WalkBuilder` 吐出文件 → 逐个用 `grep-searcher` 按行扫
//! → 命中攒够一批就交给回调。没有队列、没有通道、没有线程——**并发是调用方的事**
//! （`src-tauri` 把这一整个函数放进后台线程，回调里 `app.emit`）。
//! 这样本模块的每个分支都能用 `tempfile` 在当前线程上测完。

use std::ops::ControlFlow;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::{sinks, BinaryDetection, Searcher, SearcherBuilder};
use serde::Serialize;

// 遍历不住在本模块了：`Cmd+P` 的文件索引（`project::index`）是它的第三个消费者，
// 而共用点必须是**同一个函数**，不能是抄的第二份。理由见 `project/walk.rs`
use crate::project::walk::each_file;

use super::query::{build_filters, build_matcher, build_template, Filters, SearchError, SearchQuery, Template};

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
/// 与 `fs` 那边两条「打开文件」的上限都不是一回事：`MAX_INLINE_BYTES`（4 MiB）管的是
/// 单次 IPC payload，`MAX_SHARD_BYTES`（256 MiB）管的是「能不能以只读分片打开」。
/// 这一条管的是「别为一个 2GB 的日志把整次搜索卡住」。
///
/// ## 🔴 为什么是 64 MiB：M2-H 之后它必须与分片对账
///
/// M2-H 之前这个数是 10 MiB，与分片毫无关系。之后它必须重新定，因为大文件里刻意
/// **不做** ⌘F（分片是只读虚拟列表，压根没有 CM6 的搜索扩展），理由是「全局搜索已经
/// 够了」——而那句话只在「打得开的都搜得到」的区间里成立。留着 10 MiB 的话，一个
/// 100 MiB 的日志能打开成只读分片，却在自己的项目里搜不到：用户按 ⌘⇧F 找一句话
/// 得到「0 个结果」，而那个文件就在眼前开着。
///
/// 不取 `MAX_SHARD_BYTES`（256 MiB）是因为搜索与替换**共用这一个闸**（理由见
/// `replace.rs` 的「预览与落盘走过同一个文件集」），而两条路的成本结构完全不同：
/// 搜索是流式的，文件多大都只花**时间**（实测 10 MiB 从头扫到尾 6.9–8.5ms，
/// 线性外推 64 MiB ≈ 55ms、256 MiB ≈ 215ms）；替换要把整份读进内存、换完再原子写回，
/// 峰值约两倍文件大小——256 MiB 就是 ~512 MiB 的瞬时占用，而 §2.9 那条预算是
/// 「空转常驻 < 200MB」（实测均值 104MB）。64 MiB 把峰值压在 ~128 MiB，
/// 而且它只在用户点过「替换全部」之后才发生。
///
/// ## ⚠️ 于是 64–256 MiB 这一段是「打得开、搜不到」
///
/// 这段缺口是**有意的**，而且不静默：跳过的文件计入 `skipped_too_large`，面板会把
/// 「N 个太大的文件没搜」说出来。真要覆盖它，正确的做法是给分片视图加一个走行索引的
/// 搜索（Rust 侧 `read_lines` 已经能按页取正文），而不是把替换的内存峰值再抬四倍。
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

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
pub(super) const HEARTBEAT_FILES: u32 = 256;

/// 或者距上一次推批次过了这么久，也推一次心跳。
///
/// ⚠️ 光有文件数那一半不够：一屋子接近 `MAX_FILE_BYTES` 的文件，256 个能扫上十几秒。
/// 两条阈值取「先到者」，于是**前端最多 250ms 或 256 个文件收不到信号**，
/// 与仓库里文件的平均大小无关。
///
/// 这一半没法确定地测（要测就得 sleep，而 sleep 出来的测试测的是调度器）；
/// 钉住的是文件数那一半，见 `扫过很多个没有命中的文件时会推心跳`。
pub(super) const HEARTBEAT_MS: u64 = 250;

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
    /// 这一行**换完之后**长什么样（M2-D）。`None` = 这是一次纯搜索，没有替换。
    ///
    /// ⚠️ 三条不显然的规矩：
    ///
    /// - **`Some("")` 是合法且常见的**：模板为空、或者模板是 `$1` 而第 1 组这次没参与匹配，
    ///   都会得到空串。它的含义是「这一行换完就没了那一段」，不是「没有替换」。
    ///   前端必须判 `!== undefined`，判真假的话这一行会安静地退回成纯搜索的样子。
    /// - **`skip_serializing_if` 是有意的**：纯搜索时这个字段整个不上线，
    ///   于是 M2-C 那批黄金 JSON 一字不改。省下的是真金白银——两万条命中每条多
    ///   `"replaced":null,` 十七个字节就是 340KB，全花在「本来就没有替换」上。
    /// - **它是整行的替换结果，不是命中那一段的**。UI 显示成「原行 → 新行」，
    ///   所以两边都得是整行才对得上。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced: Option<String>,
    /// 正文或替换预览**任一个**被 `MAX_PREVIEW_BYTES` 截断了（原文比字段里的长）。
    ///
    /// ⚠️ 刻意合成一个标志而不是两个：UI 上它就是一条省略号，而「哪一半被截了」
    /// 对用户没有可操作的区别。分成两个字段的话前端要写 `a || b`，
    /// 而那正是两个字段会各自漂掉的地方
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
    /// 这一条来自 `roots` 里的第几个根（M2-F 多根工作区）。单根时恒为 0。
    ///
    /// ⚠️ **为什么不让前端自己从 `path` 里剥出根来**：那样它就得拿 `path` 去掉
    /// `/{rel}` 后缀反推，而「前端不做路径运算」是 M2-A 就定下的规矩
    /// （`DirEntry` 同时带 `rel` 与 `path` 正是为此）。
    ///
    /// 多根之下 `rel` 不再唯一——两个根都可以有一个 `src/a.ts`——分组标题因此要么
    /// 带上根名，要么在两个同名文件之间说不清是哪个。给一个序号，前端查一次
    /// `roots[i]` 就拿到根名，一次拼接都不必做。
    pub root_index: u16,
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
/// 里等 `cancel_task` 来置真）。**遍历途中每个文件之间、以及扫描途中每一行之间**都会
/// 读它一次：只在大循环里读的话，一个几十万行的文件能让「点了取消」等上好几秒。
///
/// ⚠️ `root` 必须是**绝对路径**且确实是一个目录，否则返回 `SearchError`。
/// 这两条检查与编译正则、编译通配一起构成「起飞前检查」，所以**每一个 `SearchError`
/// 都发生在第一批结果推出去之前**（见 `mod.rs` 最后一条）。
///
/// ⚠️ `on_batch` 收到的批次**可能 `files` 为空**——那是一次心跳，不是「搜完了」。
/// 搜完的唯一信号是本函数返回。理由与阈值见 `mod.rs`「一个都不命中时」那一节。
///
/// ## `query.replace` 为 `Some` 时它是**预览**，不是替换（M2-D）
///
/// 那条路上每一条命中多带一个 [`SearchHit::replaced`]：整行按模板换完之后的样子。
/// 除此之外**什么都不变**——遍历、过滤、批次、总账里的每一个数都与纯搜索逐位相同
/// （钉住这一点的是 `替换预览不改变总账里的任何一个数`）。
///
/// ⚠️ 它一个字节都不写盘。真正落盘是另一层的事（M2-D-2），而那边**共用同一个
/// `Template::expand_line`**：预览与落盘各写一套替换逻辑的话，两边的偏差
/// 没有任何测试能发现，而用户是拿预览去决定要不要按下「替换全部」的。
pub fn search<F>(
    root: &Path,
    query: &SearchQuery,
    cancel: &AtomicBool,
    on_batch: F,
) -> Result<SearchSummary, SearchError>
where
    F: FnMut(SearchBatch),
{
    search_roots(&[root], query, cancel, on_batch)
}

/// 在**好几个** root 下各搜一遍，结果仍然分批交给同一个 `on_batch`（M2-F 多根工作区）。
///
/// [`search`] 就是它的单根特例，两者不可能分岔——单根那条压根没有第二份实现。
///
/// ## 三样东西共用一份，两本账也共用一本
///
/// `matcher` / `filters` / `template` 由 [`compile`] 编出来，而它**只看 `query`、不看 root**
/// （root 那两条检查是「是不是绝对路径」「是不是一个目录」，与编译无关）。所以多根之下：
///
/// - 编译只做一次。逐根重编是 N 倍的无用功，而更重要的是**它会让「预览与落盘用同一台
///   匹配机」这条性质从「同一个对象」退化成「N 个内容相同的对象」**——那正是
///   `mod.rs` 开头那张表要防的事。
/// - `Tally` 只有一本，于是 `MAX_HITS` 是**整次搜索**的预算而不是每个根一份。
///   逐根各给一份的话，挂五个根就能拿到五倍的命中，而那个上限本来是为
///   「单次 IPC payload ≤ 4MB」与前端渲染量设的。
/// - `Collector` 只有一个，于是 `files_scanned` 跨根**连续累计**，与它「累计值不是增量」
///   的口径一致；批次也不会因为换根而多出一次无谓的冲批。
///
/// ## ⚠️ 收手就整个收手，不再走下一个根
///
/// `cancelled` 的意思是「别再碰文件了」，`truncated` 的意思是预算用完了，
/// 两者都与「还有几个根没走」无关。接着走下一个根的话，取消要等一整个根走完才生效
/// （十万文件的仓库上那是几秒），而截断会变成一个根一份的假上限。
///
/// ## `roots` 为空是合法的，得到一份全零的总账
///
/// 「在零个文件夹里搜」当然什么都搜不到，这不是一种失败。⚠️ 但 UI 因此必须自己挡住
/// 「一个文件夹都没打开」这种处境并说一句话，否则用户看到的是「没有匹配」——
/// 那是一句看起来很确定的错答案。前端今天挡在 `src/search/store.ts` 里
/// （`roots().length === 0` 时压根不发命令），与 `goto/store.ts` 那句
/// 「先打开一个文件夹，才能按名字找文件」是同一条规矩。
pub fn search_roots<F>(
    roots: &[&Path],
    query: &SearchQuery,
    cancel: &AtomicBool,
    on_batch: F,
) -> Result<SearchSummary, SearchError>
where
    F: FnMut(SearchBatch),
{
    // ⚠️ 所有根一起检查完才开始走第一个：「每一个 `SearchError` 都发生在第一批结果
    // 之前」这条性质对多根同样成立（见 `mod.rs` 最后一条）。逐根「检查一个走一个」的话，
    // 第二个根不合法就变成一个 done 事件之后的 failed 事件，而那条路径前端没有 UI 也没有测试
    for root in roots {
        check_root(root)?;
    }
    let prepared = compile(query)?;

    let started = Instant::now();
    let mut run = Run {
        matcher: prepared.matcher,
        template: prepared.template,
        cancel,
        searcher: searcher(),
        collector: Collector::new(on_batch),
        tally: Tally::default(),
        root_index: 0,
    };
    for (index, root) in roots.iter().enumerate() {
        run.root_index = u16::try_from(index).unwrap_or(u16::MAX);
        // ⚠️ `prepared.filters` 刻意**留在局部**、不搬进 `Run`：搬进去的话下面这个闭包
        // 就没法整体可变借用 `run`（`&self.filters` 与 `&mut self` 打架）。
        // 而「走哪些文件」这件事必须由 [`walk_files`] 这一个函数说了算——
        // 预览走过一遍的文件集与落盘走过的不是同一个的话，用户批准的是一份清单、
        // 改的是另一份。
        //
        // ⚠️ 分两句写：`run.tally.absorb(walk_files(..))` 编不过，
        // 接收者 `run.tally` 与闭包捕获的 `&mut run` 会同时活着
        let outcome = walk_files(root, &prepared.filters, cancel, |path, rel| run.visit(path, rel));
        run.tally.absorb(outcome);
        if run.tally.cancelled || run.tally.truncated {
            break;
        }
    }
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
/// ⚠️ 它必须与 [`search`] 的检查**完全一致**，两者共用 [`check_root`] 与 [`compile`]
/// 这两个实现处。
/// 要是哪天有人只改一边，「preflight 过了而 search 报错」会让前端收到一个它以为
/// 不可能出现的 event，而那条路径没有测试也没有 UI。一致性由
/// `起飞前检查的两个入口结论一致` 钉住。
pub fn preflight(root: &Path, query: &SearchQuery) -> Result<(), SearchError> {
    preflight_roots(&[root], query)
}

/// [`preflight`] 的多根版：**所有**根一起查，任何一个不合法就整次不开工。
///
/// ⚠️ 「全查完才开始」不是顺手写的。逐根「查一个走一个」的话，第二个根不合法会变成
/// 「已经推出去几批结果、然后一个 failed 事件」——而前端那条简单规则
/// （reject = 压根没开始 / 拿到 taskId = 一定等到 done 或 failed）正是靠
/// 「失败只可能在开始之前」撑着的，`mod.rs` 最后那一节整节都在说这件事。
pub fn preflight_roots(roots: &[&Path], query: &SearchQuery) -> Result<(), SearchError> {
    for root in roots {
        check_root(root)?;
    }
    compile(query).map(|_| ())
}

/// root 那两条检查：必须是绝对路径、必须确实是一个目录。
///
/// 与编译 query 分开成两个函数是 M2-F 逼出来的：多根之下「检查」要做 N 次而「编译」
/// 只做一次，摊在一个函数里就只能逐根重编——N 倍无用功还是小事，
/// 要紧的是那会让「预览与落盘用同一台匹配机」从「同一个对象」退化成
/// 「N 个内容相同的对象」（见 [`search_roots`]）。
pub(crate) fn check_root(root: &Path) -> Result<(), SearchError> {
    if !root.is_absolute() {
        return Err(SearchError::BadRoot { path: root.display().to_string() });
    }
    // 用 `metadata` 而不是 `Path::exists` + `is_dir` 两次 stat：一次就够，
    // 而且 `metadata` 跟着符号链接走——指向目录的链接是一个合法的 root
    match std::fs::metadata(root) {
        Ok(meta) if meta.is_dir() => Ok(()),
        _ => Err(SearchError::NotFound { path: root.display().to_string() }),
    }
}

/// 编 query 那三样。**它不看 root**，所以一次搜索里无论挂了几个根都只编一次
pub(crate) fn compile(query: &SearchQuery) -> Result<Prepared, SearchError> {
    let matcher = build_matcher(query)?;
    let filters = build_filters(query)?;
    // ⚠️ 模板也在这里编，于是 `$2` 配 `(a)` 这种错与「正则编不出来」一样当场 reject，
    // 而不是等第一批结果推出去之后才发现。`mod.rs` 最后那条性质
    // （「每一个 `SearchError` 都发生在第一批结果之前」）因此对 M2-D 也成立
    let template = build_template(query, &matcher)?;
    Ok(Prepared { matcher, filters, template })
}

/// 编好的三样东西。字段全是 `pub(crate)`：落盘那一层（M2-D-2）要用同一个
/// `matcher` 与 `template` 去**改文件**，而「预览用的匹配机」与「落盘用的匹配机」
/// 是同一个对象这件事，正是「所见即所做」的全部依据
///
/// ⚠️ **收进一个结构体而不是返回一个三元组**：`matcher` 与 `template` **必须成对旅行**。
/// 模板里的组号是拿 `matcher.capture_count()` 校验过的（见 `query::build_template`），
/// 把它们摊成两个自由变量的话，某天有人把模板交给另一个 matcher，失败方式是
/// `caps.get(n)` 安静地返回 `None`——两万处各插进一个空串，而这一步是直接改写磁盘的。
pub(crate) struct Prepared {
    pub(crate) matcher: RegexMatcher,
    pub(crate) filters: Filters,
    /// `None` = 这是一次纯搜索
    pub(crate) template: Option<Template>,
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

/// 遍历自己的那几笔账。
///
/// ⚠️ **返回值而不是 `&mut` 参数**，这不是风格问题：[`search`] 里 visit 闭包
/// 已经整体可变借用了 `Run`，再传一个 `&mut` 计数器进去就得让那个计数器
/// 长在 `Run` 外面（否则一次调用里两个 `&mut`）。而它长在 `Run` 里面的话，
/// 闭包就没法整体借用 `Run` 了——绕来绕去的终点还是「遍历逻辑抄两份」
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WalkOutcome {
    /// 遍历途中读不动的目录（权限不够、途中被删）
    pub(crate) unreadable: u32,
    /// 因为超过 `MAX_FILE_BYTES` 而没碰的文件
    pub(crate) skipped_too_large: u32,
    /// 是被 `cancel` 叫停的，不是走完了
    pub(crate) cancelled: bool,
}

/// 走一遍 root 下所有**该搜的**文件，对每一个调 `visit`。
///
/// 规则分两半，各只写一次：
///
/// 「是不是一个文件」那一半（不是 root 自己、是普通文件而不是目录或符号链接、
/// 算得出 rel、读不动的目录记一笔继续）住在 [`each_file`] 里，与 `Cmd+P` 的索引共用——
/// 那三条要是各写一份，两侧的测试还会全绿，而「跳得到的文件」与「搜得到的文件」就分岔了。
///
/// 「这个文件搜不搜」那一半住在这里，因为它们是**搜索专属**的：取消、include/exclude、
/// `MAX_FILE_BYTES`。索引不需要其中任何一条，所以不能把它们塞进共用点。
///
/// `visit` 返回 `Break` 就当场收手（`MAX_HITS` 到了）。取消是**每个条目问一次**，
/// 粒度是「走到哪儿停到哪儿」——十万个文件的仓库上取消必须在一帧内生效
pub(crate) fn walk_files<V>(root: &Path, filters: &Filters, cancel: &AtomicBool, mut visit: V) -> WalkOutcome
where
    V: FnMut(&Path, &str) -> ControlFlow<()>,
{
    let mut out = WalkOutcome::default();
    let tally = each_file(root, |entry, rel| {
        if cancel.load(Ordering::Relaxed) {
            out.cancelled = true;
            return ControlFlow::Break(());
        }
        if !filters.allows(rel) {
            return ControlFlow::Continue(());
        }
        // `metadata()` 读不动就当它不大：宁可扫一个可能很大的文件，
        // 也不要因为一次 stat 失败就静默地少搜一个文件
        if entry.metadata().is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
            out.skipped_too_large += 1;
            return ControlFlow::Continue(());
        }
        visit(entry.path(), rel)
    });
    out.unreadable = tally.unreadable;
    out
}

/// 一次搜索的可变状态。收进一个结构体是为了让 `visit` / `scan_file` 各自短一点：
/// 摊平成一个函数的话，遍历、过滤、扫描、分批四件事会挤在同一个作用域里，
/// 而它们各自都有需要注释的取舍。
///
/// ⚠️ **这里没有 `filters` 字段**，那是刻意的：过滤器由 [`walk_files`] 拿着，
/// 而 `walk_files` 的 visit 闭包要整体可变借用 `Run`。把它搬进结构体的话，
/// 闭包里的 `&self.filters` 与 `&mut self` 会打架——而绕开这个冲突的唯一办法是
/// 让闭包只借用 `Run` 的一部分，那正是「遍历逻辑散到两处」的开头。
struct Run<'a, F> {
    matcher: RegexMatcher,
    /// 替换模板（M2-D）。`None` = 纯搜索，`make_hit` 就不算 `replaced`。
    ///
    /// ⚠️ 它必须与上面那个 `matcher` 是 `compile` 一起编出来的那一对，
    /// 理由写在 [`Prepared`] 上
    template: Option<Template>,
    cancel: &'a AtomicBool,
    searcher: Searcher,
    collector: Collector<F>,
    tally: Tally,
    /// 现在正在走的是 `roots` 里第几个（M2-F）。`search_roots` 每换一个根就改一次，
    /// 于是盖到 `SearchFile` 上的序号天然与那一批命中的来源对得上。
    ///
    /// ⚠️ 它是 `Run` 里**唯一**一个在遍历途中被改的字段，其余五个都是开工前定死的。
    /// 改成「每个根一个新 `Run`」看着更干净，代价是 `tally` 与 `collector` 也得跟着换——
    /// 而那两样正是必须跨根共用的（`MAX_HITS` 的预算口径与 `files_scanned` 的累计口径，
    /// 理由见 [`search_roots`]）
    root_index: u16,
}

impl<F: FnMut(SearchBatch)> Run<'_, F> {
    /// 取消了吗。
    ///
    /// ⚠️ 与 [`walk_files`] 里那次检查**不是同一件事**：那边是「下一个文件别碰了」，
    /// 这边是「这个文件扫到一半被叫停，半份结果不能推出去」（理由在 `scan_file` 那一支上）
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// 扫一个文件，然后回答「还要不要继续走」。
    ///
    /// 返回 `ControlFlow` 而不是 `()`：`MAX_HITS` 到了就得停，而停下来这件事发生在
    /// **命中被数出来之后**，也就是在遍历那一层看不见的地方。让 visit 自己说
    /// `Break`，比让 [`walk_files`] 反过来去读调用方的某个计数器要诚实
    fn visit(&mut self, path: &Path, rel: &str) -> ControlFlow<()> {
        self.scan_file(path, rel);
        if self.tally.hits >= MAX_HITS {
            self.tally.truncated = true;
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }

    fn scan_file(&mut self, path: &Path, rel: &str) {
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut truncated = false;
        if scan(&mut self.searcher, &self.matcher, self.template.as_ref(), self.cancel, path, &mut hits, &mut truncated)
            .is_err()
        {
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
            let file = SearchFile {
                rel: rel.to_owned(),
                path: path.display().to_string(),
                root_index: self.root_index,
                hits,
                truncated,
            };
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
    template: Option<&Template>,
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
            hits.push(make_hit(line_num, line, matcher, template));
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
fn make_hit(line_num: u64, line: &str, matcher: &RegexMatcher, template: Option<&Template>) -> SearchHit {
    // ⚠️ 先脱掉行终止符再算任何东西。`sinks::Lossy` 交出来的 `&str` 是**带着** `\n` 的
    // （实测；钉它的是 `命中里的文本不带行尾换行_两种行尾与没有换行的最后一行都一样`）。
    // 带着它的话：预览末尾多一个看不见的字符、`text.len()` 的分母对不上编辑器里那一行、
    // CRLF 文件里还会多留一个 `\r`。
    let line = strip_terminator(line);
    let (text, text_truncated) = preview(line);
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

    // 替换预览（M2-D）。⚠️ 三件事的顺序是硬的：
    //
    // 1. **对整行原文换，不是对 `text` 换。**`text` 可能已经被 `MAX_PREVIEW_BYTES`
    //    截断了，在截断过的串上跑正则，命中可能落在切口上，换出来的东西与真换的结果
    //    不一样——而用户拿这个预览去决定要不要按下「替换全部」。
    // 2. **走 `expand_line` 这一个实现**，与落盘那条路（M2-D-2）是同一个函数。
    //    前端算预览、Rust 算落盘是另一种写法，它的失败方式是「预览说会改成 A、
    //    实际改成了 B」，而两边各有一套 `$` 语法解析，谁也测不出对方的偏差。
    //    代价是替换模式下这一行跑了**两遍**正则（`find_iter` 一遍、替换一遍）。
    //    这个代价买得值：正则只跑在**命中的那些行**上，而遍历的主要成本是把文件
    //    从盘上读进来（实测 10MiB 是 6.9–8.5ms）；换成「预览可能说谎」是不可接受的。
    // 3. **换完再过一次 `preview`**，于是两边受同一个上限管，一行最多两个 1000 字节。
    let (replaced, truncated) = match template {
        None => (None, text_truncated),
        Some(t) => {
            let (whole, _) = t.expand_line(matcher, line);
            let (shown, replaced_truncated) = preview(&whole);
            (Some(shown.to_owned()), text_truncated || replaced_truncated)
        }
    };

    SearchHit { line: line_num as u32, text: text.to_owned(), ranges, replaced, truncated }
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
    /// （release，外部卷，连跑三次）：10MiB 的文本文件从头扫到尾是 **6.9–8.5ms**。
    /// ⚠️ M2-H 把 `MAX_FILE_BYTES` 抬到 64 MiB 之后这个数**没有重量过**，只有线性
    /// 外推：扫描吞吐与字节数成正比，于是单文件空洞的上界变成 **~55ms**。
    /// 它仍然是「一个文件」的上限，而 `HEARTBEAT_MS` 是 250ms——余量从一个数量级
    /// 掉到 ~4.5 倍，但还是不值得为它另起一个计时线程。真要把上限再抬，这一条得重量。
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
    /// 把遍历那一层的账并进总账。
    ///
    /// ⚠️ `unreadable` 是**加**不是赋值：它同时收两种东西——遍历时读不动的目录
    /// （[`walk_files`] 记的）与扫描时读不动的文件（`scan_file` 记的）。
    /// 对用户来说都是「有一个东西我没能看」，所以共用一个数；
    /// 写成赋值的话其中一种会被另一种安静地盖掉，而盖掉的顺序取决于谁先跑完
    fn absorb(&mut self, out: WalkOutcome) {
        self.unreadable += out.unreadable;
        self.skipped_too_large += out.skipped_too_large;
        self.cancelled |= out.cancelled;
    }

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
                SearchFile {
                    rel: "a.txt".into(),
                    path: "/a.txt".into(),
                    root_index: 0,
                    hits: Vec::new(),
                    truncated: false,
                },
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
        // `edge.txt` 必须是真的写满 64MiB 的**文本**：`set_len` 撑出来的稀疏文件正文全是
        // NUL，会被二进制探测整个丢掉，那样「出现在结果里」就证不了「它被扫过」——
        // 而这条测试要钉的正是 `>` 与 `==` 的分界
        let mut body = "x".repeat(MAX_FILE_BYTES as usize - "needle\n".len());
        body.push_str("needle\n");
        assert_eq!(body.len() as u64, MAX_FILE_BYTES, "正好等于上限");
        fs::write(root.join("edge.txt"), &body).unwrap();
        // `big.txt` 的内容无所谓——它压根不会被读，所以这里用 `set_len` 省掉 64MiB 的写入
        let mut big = fs::File::create(root.join("big.txt")).unwrap();
        big.write_all(b"needle\n").unwrap();
        big.set_len(MAX_FILE_BYTES + 1).unwrap();

        let (batches, summary) = run(root, &query("needle"));
        let files: Vec<SearchFile> = batches.into_iter().flat_map(|b| b.files).collect();
        assert_eq!(summary.skipped_too_large, 1, "只有超过上限的那个被跳过");
        assert!(!files.iter().any(|f| f.rel == "big.txt"), "超过上限的整个不扫");

        let edge = files.iter().find(|f| f.rel == "edge.txt").expect("正好等于上限的照常扫");
        assert_eq!(edge.hits.len(), 1, "64MiB 的正文只有末尾一处命中");
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
        // 后两条是 M2-D 的替换模板：`mod.rs` 最后那条性质（每一个 `SearchError`
        // 都发生在第一批结果之前）对模板也成立，靠的是 `compile` 把模板一起编了
        for q in [
            query(""),
            query("a\nb"),
            query("(没关上"),
            SearchQuery { replace: Some("$name".to_owned()), ..query("(a)") },
            SearchQuery { replace: Some("$2".to_owned()), ..query("(a)") },
        ] {
            let mut batches = 0;
            let err = search(dir.path(), &q, &AtomicBool::new(false), |_| batches += 1).unwrap_err();
            assert_eq!(batches, 0, "{err}");
        }
    }

    /// `preflight` 与 `search` 的结论**必须一致**。
    ///
    /// 两者共用 `check_root` 与 `compile` 这两个实现处，所以这条测试今天看来是同义反复。
    /// 它防的是将来：有人在 `search_roots()` 里多加一条检查（比如「root 必须是个 git
    /// 仓库」）而忘了同步 `preflight_roots`，于是 `preflight` 说「可以搜」、Tauri 那边返回了 taskId、
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
            // M2-D：模板也是起飞前检查的一部分。⚠️ 这两条要是漏掉，失败方式是
            // `preflight` 说「可以搜」、taskId 已经返回给前端了、后台线程里才报错——
            // 前端于是收到一个它按规则不可能收到的 failed event
            (root, SearchQuery { replace: Some("$name".to_owned()), ..query("(a)") }),
            (root, SearchQuery { replace: Some("$2".to_owned()), ..query("(a)") }),
            (root, SearchQuery { replace: Some("ok".to_owned()), ..query("needle") }),
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

    // ── 多根工作区（M2-F） ──────────────────────────────────────────────────
    //
    // 这一节钉的是**跨根共用的那三样**：一份 `Prepared`、一本 `Tally`、一个 `Collector`。
    // 「每条结果带对根序号」「`filesScanned` 在线上跨根累计」那种**形状**的事在
    // `tests/wire_contract.rs` 里，两边刻意不重复。

    /// 三棵各自独立的小树，每棵里都有一个**同名**的 `a.txt`。
    ///
    /// 同名是刻意的：多根之下 `rel` 不再唯一，而 `SearchFile::root_index` 存在的
    /// 全部理由就是这件事
    fn three_roots() -> Vec<tempfile::TempDir> {
        (0..3)
            .map(|i| {
                let dir = tempfile::tempdir().unwrap();
                fs::write(dir.path().join("a.txt"), format!("needle {i}\n")).unwrap();
                // 一个没有命中的文件：它照样计入 `files_scanned`，
                // 否则那个数就不是「扫过多少」而是「命中过多少」
                fs::write(dir.path().join("quiet.txt"), "nothing\n").unwrap();
                dir
            })
            .collect()
    }

    /// 命中上限是**整次搜索**的预算，不是每个根一份。
    ///
    /// 每个根各记一本账的话，两个根就是四万条——而用户批准的预览里最多只有两万条。
    /// 这是「共用一本 `Tally`」这件事唯一能被测出来的一面
    #[test]
    fn 命中上限是整次搜索的预算不是每个根一份() {
        let body = "needle\n".repeat(MAX_HITS_PER_FILE as usize);
        let dirs: Vec<tempfile::TempDir> = (0..2)
            .map(|_| {
                let dir = tempfile::tempdir().unwrap();
                // 每个根 25 个满文件 = 12500 条，两个根 25000 条，超过 MAX_HITS(20000)
                for i in 0..25 {
                    fs::write(dir.path().join(format!("f{i:02}.txt")), &body).unwrap();
                }
                dir
            })
            .collect();
        let roots: Vec<&Path> = dirs.iter().map(|d| d.path()).collect();

        let mut batches = Vec::new();
        let summary = search_roots(&roots, &query("needle"), &AtomicBool::new(false), |b| batches.push(b)).unwrap();

        assert!(summary.truncated);
        assert_eq!(summary.hits, MAX_HITS);
        assert_eq!(summary.files_scanned, MAX_HITS / MAX_HITS_PER_FILE);
        // 撞线之后**整个**收手：第二个根剩下的 10 个文件一个都没碰
        let files: Vec<&SearchFile> = batches.iter().flat_map(|b| b.files.iter()).collect();
        let per_root: Vec<usize> = (0..2u16).map(|i| files.iter().filter(|f| f.root_index == i).count()).collect();
        assert_eq!(per_root, [25, 15], "{per_root:?}：预算用完了还在走第二个根");
    }

    /// 取消在**根之间**也生效：`cancelled` 一到就整个收手，不把剩下的根走完。
    ///
    /// 「等走完当前这个根再看」在十万文件的仓库上是几秒到几十秒，而取消是用户
    /// 觉得搜错了当场按下去的——那几秒里 UI 既不能说「已取消」也不能说「还在搜」
    #[test]
    fn 取消之后不再走下一个根() {
        let dirs = three_roots();
        let roots: Vec<&Path> = dirs.iter().map(|d| d.path()).collect();
        // 一开始就是取消状态：`walk_files` 是**逐个条目**问的，
        // 而问的时机在扫那个文件之前，所以一个字节都不该被读
        let cancel = AtomicBool::new(true);

        let mut batches = Vec::new();
        let summary = search_roots(&roots, &query("needle"), &cancel, |b| batches.push(b)).unwrap();

        assert!(summary.cancelled);
        assert!(!summary.truncated, "取消不是截断，两个数在 UI 上是两句话");
        assert_eq!(summary.files_scanned, 0);
        // ⚠️ 连一个心跳都不该有：`Collector` 手上没有结果时 `flush` 什么也不推
        assert!(batches.is_empty(), "{batches:?}");
    }

    /// `roots` 为空是**合法**的，得到一份全零的总账，而不是一个新的错误变体。
    ///
    /// 「没有根」这个状态在 UI 上到不了（面板与浮层都自己拦着，见 `search_roots` 的文档），
    /// 为它加一个 `SearchError` 变体的代价是前端多一条翻译分支、契约测试多一个用例，
    /// 而收益是零——它描述的是一个不可能发生的输入
    #[test]
    fn 空的根清单得到一份全零总账() {
        let mut batches = 0;
        let summary = search_roots(&[], &query("needle"), &AtomicBool::new(false), |_| batches += 1).unwrap();
        assert_eq!(batches, 0, "一个文件都没扫，连心跳都不该有");
        assert_eq!(
            (
                summary.files_scanned,
                summary.files_with_hits,
                summary.hits,
                summary.skipped_too_large,
                summary.unreadable,
                summary.truncated,
                summary.cancelled
            ),
            (0, 0, 0, 0, 0, false, false)
        );
        // 起飞前检查也得放行。两处要是说法不一致，前端就会在一条**到不了**的路径上
        // 多一个分支，而那个分支永远测不到
        assert!(preflight_roots(&[], &query("needle")).is_ok());
    }

    /// `preflight_roots` 与 `search_roots` 在多根下也必须给出**同一个错误值**。
    ///
    /// 与上面 `起飞前检查的两个入口结论一致` 同一条理由的延伸：多根之后
    /// 「第几个根坏了」成了一个新自由度，两个入口要是各查各的，
    /// 就会出现在「一个说不合法、另一个说合法」这种没法在前端表达的分岔。
    ///
    /// ⚠️ 四个用例里坏的根**位置不同**（第一个 / 第二个）、**坏法不同**
    /// （不存在 / 是个文件 / 不是绝对路径），而且都夹着一个合法的根：
    /// 只测「全坏」的话，一个「碰到第一个合法的就 return Ok」的实现照样能过
    #[test]
    fn 起飞前检查的两个入口在多根下也一致() {
        let dirs = three_roots();
        let good = dirs[0].path();
        let missing = good.join("没有这个根");
        let not_a_dir = good.join("a.txt");
        let cases: Vec<Vec<&Path>> =
            vec![vec![good, &missing], vec![&missing, good], vec![good, &not_a_dir], vec![Path::new("repo"), good]];

        for roots in cases {
            let before = preflight_roots(&roots, &query("needle"));
            let during = search_roots(&roots, &query("needle"), &AtomicBool::new(false), |_| {});
            match (&before, &during) {
                (Err(a), Err(b)) => assert_eq!(a, b, "{roots:?}：两个入口报的不是同一个错"),
                _ => panic!("{roots:?}：这一组该被拒，preflight 是 {before:?}、search 是 {}", during.is_ok()),
            }
        }
    }

    // ── M2-D 替换预览 ───────────────────────────────────────────────────────
    //
    // 这一节钉的是 `SearchHit::replaced` 在**真实目录**上的行为。`$` 语法本身在
    // `query.rs` 那一节，两边刻意不重复：这里只关心「模板与遍历接起来之后，
    // 前端拿到的那一行是对的还是错的」。

    fn replace_query(pattern: &str, template: &str) -> SearchQuery {
        SearchQuery { replace: Some(template.to_owned()), ..query(pattern) }
    }

    #[test]
    fn 带模板时每条命中都带_replaced_不带时一条都没有() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "let needle = 1;\nno match\nneedle needle\n").unwrap();

        let plain = hits_of(root, &query("needle"));
        assert_eq!(plain.len(), 2, "本测试的前提：这个文件里有两行命中");
        assert!(plain.iter().all(|h| h.replaced.is_none()), "纯搜索不该带替换预览");

        let hits = hits_of(root, &replace_query("needle", "haystack"));
        assert_eq!(hits.len(), 2, "替换预览不该改变命中数");
        // ⚠️ `text` 是**原行**，`replaced` 是换完的行——UI 显示成「原行 → 新行」，
        // 两边都得留着。把 `text` 也换成新串的话用户就看不出这一处改了什么
        assert_eq!(hits[0].text, "let needle = 1;");
        assert_eq!(hits[0].replaced.as_deref(), Some("let haystack = 1;"));
        // 一行里的每一处都换
        assert_eq!(hits[1].text, "needle needle");
        assert_eq!(hits[1].replaced.as_deref(), Some("haystack haystack"));
        // `ranges` 是按 `text` 算的，加了替换之后不能跟着漂——
        // 漂了的失败方式是「高亮画在换完的那一行上」，而那一段已经不是命中了
        assert_eq!(hits[0].ranges, vec![MatchRange { start: 4, end: 10 }]);
    }

    #[test]
    fn 空模板是删除_而它照样出现在_replaced_里() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "x needle y\n").unwrap();

        let hit = &hits_of(root, &replace_query("needle", ""))[0];
        // ⚠️ 断的是 `Some` 而不是「非空」：前端判真假的话这一行会安静地退回成
        // 纯搜索的样子，而用户以为自己刚刚预览了一次删除
        assert_eq!(hit.replaced, Some("x  y".to_owned()));
        assert_eq!(hit.text, "x needle y");
    }

    #[test]
    fn replaced_里不带行终止符_crlf_也一样() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("crlf.txt"), "a needle b\r\nc needle d\r\n").unwrap();

        let hits = hits_of(root, &replace_query("needle", "N"));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].replaced.as_deref(), Some("a N b"));
        assert_eq!(hits[1].replaced.as_deref(), Some("c N d"));
        // `\r` 由 `strip_terminator` 在替换**之前**就脱掉了。漏掉的话写回去的文件
        // 会在每一行多一个 `\r`，而那正是 M1-B 修过的那个 `\r\r\n` 的翻版
        for h in &hits {
            let replaced = h.replaced.as_deref().unwrap();
            assert!(!replaced.ends_with('\r') && !replaced.ends_with('\n'), "{replaced:?}");
        }
    }

    /// ⚠️ 这一条是替换预览里最容易错、错了又最安静的一处：**替换必须对整行原文做，
    /// 不能对已经截断过的 `text` 做**。
    ///
    /// 构造一行「命中正好落在预览切口上」的正文：995 个 `x` 加 `needle`，
    /// 一共 1001 字节，比 `MAX_PREVIEW_BYTES`（1000）恰好多一个。于是 `text`
    /// 是前 1000 字节，那个 `needle` 被切成了 `needl`——**在截断过的串上压根匹配不到**。
    /// 要是对 `text` 做替换，`replaced` 会等于 `text`、处数为 0，
    /// 用户在预览里看到「这一行不会改」，而落盘时它被改了。
    #[test]
    fn 替换对整行原文做_不是对截断过的预览做() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let pad = "x".repeat(MAX_PREVIEW_BYTES - 5);
        let line = format!("{pad}needle");
        assert_eq!(line.len(), MAX_PREVIEW_BYTES + 1, "本测试的前提：正好比预览上限长一个字节");
        fs::write(root.join("long.txt"), format!("{line}\n")).unwrap();

        let hit = &hits_of(root, &replace_query("needle", "N"))[0];
        assert!(hit.truncated, "正文被截断了");
        assert_eq!(hit.text.len(), MAX_PREVIEW_BYTES);
        assert!(hit.ranges.is_empty(), "命中跨在切口上，高亮画不出来——但这一行确实命中了");
        // 换完是 995 个 `x` 加一个 `N`，比预览上限短，所以 `replaced` 自己是完整的。
        // 要是替换跑在 `text` 上，这里会等于 `text`
        let expected = format!("{pad}N");
        assert_eq!(hit.replaced.as_deref(), Some(expected.as_str()));
    }

    /// 加了替换预览之后，总账里的每个数都必须与纯搜索**完全一致**（`elapsed_ms` 除外）。
    ///
    /// 这条钉的是「预览不改变搜索的语义」。M2-D-2 的落盘那条路要靠
    /// 「预览看到多少处，落盘就改多少处」这个推理，两边总账不一致的话它就断了。
    #[test]
    fn 替换预览不改变总账里的任何一个数() {
        let dir = fixture();
        let root = dir.path();
        let plain = run(root, &query("needle")).1;
        assert!(plain.hits > 0, "本测试的前提：fixture 里真的有命中");
        let previewed = run(root, &replace_query("needle", "N")).1;

        // 摊成一个元组比七条 assert 好：失败时一眼能看出是哪一个数漂了
        let strip = |s: SearchSummary| {
            (s.files_scanned, s.files_with_hits, s.hits, s.skipped_too_large, s.unreadable, s.truncated, s.cancelled)
        };
        assert_eq!(strip(plain), strip(previewed));
    }

    /// `MAX_HITS_PER_FILE` 是**报告**的上限，不是「做」的上限。
    ///
    /// ⚠️ 这条对 M2-D-2 很重要：预览里少掉的那些命中，落盘时**照样要换**。
    /// 写一个只换了一半的文件比两个极端都糟——而这一条钉住的正是
    /// 「预览会少报」这件事本身，好让落盘那边不去对齐它。
    #[test]
    fn 替换预览也受单文件上限管_而且截断标志照样报() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("many.txt"), "needle\n".repeat(MAX_HITS_PER_FILE as usize + 10)).unwrap();

        let file = file_of(root, &replace_query("needle", "N"), "many.txt");
        assert!(file.truncated, "命中数超过了单文件上限");
        assert_eq!(file.hits.len(), MAX_HITS_PER_FILE as usize, "多扫的那一行只用来判断「还有没有更多」");
        assert!(file.hits.iter().all(|h| h.replaced.is_some()), "留下来的每一条都该带预览");
    }

    #[test]
    fn 三个开关在替换模式下照样生效() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "Needle needle needleX\n").unwrap();
        fs::write(root.join("b.txt"), "a.c axc\n").unwrap();

        // 默认不区分大小写、不要求整词：三处都换
        assert_eq!(hits_of(root, &replace_query("needle", "N"))[0].replaced.as_deref(), Some("N N NX"));
        // 区分大小写：大写那个不动
        let q = SearchQuery { case_sensitive: true, ..replace_query("needle", "N") };
        assert_eq!(hits_of(root, &q)[0].replaced.as_deref(), Some("Needle N NX"));
        // 整词：`needleX` 里那个不算
        let q = SearchQuery { whole_word: true, ..replace_query("needle", "N") };
        assert_eq!(hits_of(root, &q)[0].replaced.as_deref(), Some("N N needleX"));
        // 字面量：`.` 不再是「任意字符」，于是只有 b.txt 命中
        let q = SearchQuery { literal: true, ..replace_query("a.c", "Z") };
        assert_eq!(hits_of(root, &q)[0].replaced.as_deref(), Some("Z axc"));
    }

    // ── 线上形状 ────────────────────────────────────────────────────────────
    //
    // `MatchRange` / `SearchHit` / `SearchFile` / `SearchBatch` / `SearchSummary` 的黄金 JSON
    // 不在这里，在 `crates/vela-core/tests/wire_contract.rs` 的「M2-C 全文搜索」那一节
    // （契约测试只能用 pub 的东西，放 `tests/` 才逼得住这条边界）。那边还有一条
    // `真实搜索的批次与总账互相对得上`，负责把字面量与这里跑出来的真实输出连起来。
}
