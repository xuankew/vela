//! 外部改动监听的落地层（M2-G-2，PLAN.md §3.4「文件监听」）。
//!
//! ## 为什么这一个模块不在 `commands.rs` 里
//!
//! 其余接受路径的命令都住在 `commands.rs`，那儿的模块文档是一整篇「谁接受了路径、
//! 拿它能干什么」的账（那张表把本模块这一条也算进去了，按文件分家就漏一笔）。
//! 这一条要记的是另一种东西：它引入了 Vela 到目前为止
//! **唯一一个会自己起线程、自己回调进来**的依赖（`notify`）。两份账混在一篇里，
//! 两边都读不清。
//!
//! ⚠️ M2-H 之后 `src/shard.rs` 也不住在 `commands.rs` 里，但它分家的理由与这里
//! **不一样**（那份是第一份必须有人来收尾的资源），别把两条理由并成一条。
//!
//! ## 这一层只有胶水，判断都在 vela-core
//!
//! - 该盯哪些目录、两份计划之间要动哪几个订阅：`vela_core::watcher::{plan_watches, diff_dirs}`
//! - 一条事件算不算变化、算哪一种：`vela_core::watcher::classify`
//!
//! 留在这儿的只有两件下沉不下去的事：起 debouncer（要 `notify`，而 vela-core 一个字节
//! 都不引它，理由见 `crates/vela-core/src/watcher/mod.rs` 开头），以及 `notify::EventKind` → `ChangeKind`
//! 的映射（同一条理由）。两件都写成了**不需要真 watcher 就能测**的样子。
//!
//! ## 信任面：这是**第十三条**接受路径的命令，而它一个字节都不读
//!
//! `set_watched` 收一组任意绝对路径（前端递的是 `doc.path()`，也就是 `open_file`
//! 当初收到的那个字符串）。它拿这些路径做两件事：**订阅它们的父目录**、
//! **把它们记进一张过滤器表**。⛔ 没有 `File::open`，没有读，也没有写。
//! 而事件推给谁的前提是「那个路径本来就在过滤器表里」，也就是前端自己递进来过的。
//!
//! ⚠️ 所以「递一份恶意清单」的后果是**让 Vela 去盯一个用户没打开过的目录**，
//! 并把那个目录里被盯着的那些文件的变动事件发给 webview——事件里只有路径，没有内容。
//! 这与 `query_project` 收 `recent` 是同一档：扩大了「能看到哪些名字」，
//! 没有扩大「能读到哪些内容」。M5 开放插件时，这一条要跟着其余几条一起换成 `rootId`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockWriteGuard};
use std::time::Duration;

use notify::event::EventKind;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{command, AppHandle, Emitter, State};
use vela_core::project::TreeError;
use vela_core::watcher::{classify, diff_dirs, normalize, plan_watches, ChangeKind, FileChange, WatchPlan};

/// 去抖窗口。
///
/// 这个数字与搜索那边的 `HEARTBEAT_MS` 一样是 250，但两件事毫无关系。这里要吸收的是
/// 「一次保存 = 写临时文件 + rename + fsync」产生的一串事件：debouncer 会把窗口内
/// 落在同一个文件上的那几条合并成一条。太短的话一次保存能推出两三条「文件被改了」，
/// 前端就接着弹两三次冲突对话框；太长的话用户在别的编辑器里改完切回来，
/// 要等半秒才看见提示。
const DEBOUNCE_TIMEOUT: Duration = Duration::from_millis(250);

type Watcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// canonical 路径 → 前端认得的那几个**原样**字符串。
///
/// ## 🔴 为什么值是「原样字符串」而不是 canonical 路径
///
/// 前端拿事件里的 `path` 去与 `doc.path()` 比，而 `doc.path()` 是 `open_file`
/// 当初收到的那个字符串，**没有被规范化过**（`src/doc/workspace.ts` 的 `dirtyPaths`
/// 上写着同一条理由）。macOS 上 `/tmp`、`/var` 都是指向 `/private/...` 的符号链接，
/// 于是把 canonical 形式发回去的话，`/tmp/a.txt` 这个标签**永远**匹配不上
/// `/private/tmp/a.txt` 这条事件。失败方式是彻底的静默：不报错、不崩溃，
/// 只是外部改了文件而 Vela 一声不吭。
///
/// 键必须是 canonical 的，因为 FSEvents 报上来的就是内核眼里的那个名字。
/// 于是这张表干的活是「canonical → 前端的话」的翻译。
///
/// ## 为什么值是 `Vec` 而不是一个 `String`
///
/// 两个不同的原样字符串可以 canonical 到同一个文件（一个符号链接与它的目标，
/// 或者同一个卷的两个挂载别名）。只留一个的话，另一个标签就静默地听不见了。
type Filter = HashMap<PathBuf, Vec<String>>;

struct Inner {
    /// 上一次**生效**的计划，也就是 `diff_dirs` 的基准。
    ///
    /// ⚠️ 它必须与实际订阅状态一致：订阅动作全做完了才写回。写早了的后果是
    /// 「计划里说盯着、实际没订上」，而下一次 diff 会认为这个目录不用动——
    /// 那是一份永远不会自愈的静默失效
    plan: WatchPlan,
    debouncer: Option<Watcher>,
}

impl Default for Inner {
    fn default() -> Self {
        // `plan_watches(&[])` 就是一份空计划，而空输入意味着一个系统调用都不做
        Self { plan: plan_watches(&[] as &[PathBuf]), debouncer: None }
    }
}

/// 第三份 managed state（前两份是 `TaskRegistry` 与 `ProjectIndexCache`）。
///
/// ⚠️ 两把锁都包在 `Arc` 里不是为了共享给别处，而是为了能把它们**克隆进 blocking 池**：
/// `State<'_, T>` 是个借用，而 `spawn_blocking` 要 `'static`。
///
/// ⚠️ 而它确实要在 blocking 池里跑：`Debouncer::watch` 除了起一条 FSEvents stream，
/// 还会同步把那个目录**枚举一层**去填它的 file-id 缓存（rename 检测靠它）。
/// 一个装了一万个文件的目录就是一万次 stat，在网络卷上能到秒级——
/// 那是 `open_file` / `save_file` / `list_dir` 共用的那批 async worker 的位置。
#[derive(Default)]
pub struct WatcherState {
    inner: Arc<Mutex<Inner>>,
    /// 事件回调与 `set_watched` 共享这一张表。回调用**读**锁（每条事件都要查一次），
    /// 命令用**写**锁（只在标签集合变化时整张换掉）
    filter: Arc<RwLock<Filter>>,
}

/// `set_watched` 的总账。
///
/// ⚠️ 这五个数字里，`failed` / `skipped` / `truncated` 三个都是**要对用户说话的**，
/// 因为它们仨指向同一件事：「某个文件外部改了而 Vela 没吭声」与「Vela 压根没在盯它」
/// 在界面上长得一模一样。`dirs` 与 `files` 是给你在 devtools 里对账用的。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStats {
    /// 现在订阅着几个目录
    pub dirs: usize,
    /// 过滤器里有几个文件
    pub files: usize,
    /// 这一次 `watch` / `unwatch` 失败的个数。**不 reject**，理由见 [`set_watched`]
    pub failed: usize,
    /// 计划阶段就被丢掉的输入条数：不是绝对路径、或者长在 `/` 底下
    pub skipped: usize,
    /// 目录数撞了 `MAX_WATCH_DIRS`，`files` 也跟着少
    pub truncated: bool,
}

/// `vela://file-changed` 的载荷。另一半在 `src/ipc/watch.ts`。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangedPayload {
    /// ⚠️ 前端递进来的**原样**字符串，不是 canonical 形式。理由见 [`Filter`]
    path: String,
    kind: FileChange,
}

/// 把「现在打开着的这些文件」同步成监听状态，回报一份总账。
///
/// `paths` 是**完整清单**而不是增量：前端每次把当前所有标签的路径整份递过来，
/// 这一层自己与上一次那份做 diff，只动变化的那几个目录。刻意不让前端递增量——
/// 两边各记一份状态的话，「谁漏了一次调用」的失败方式是永久性的静默失效，
/// 而整份清单的失败方式最坏是「多订阅一个目录」。
///
/// ⚠️ **一个目录订不上不会让整次调用失败**，只记进 `failed` 继续走。
/// 与搜索/替换那条「一个根不合法就整次 reject」的规矩**相反**，理由是失败的方向不同：
/// 那边 reject 换来的是「用户知道这次没搜成」，这边 reject 换来的是
/// 「前端把整件事关掉，于是**所有**文件都不再被监听」——为了一个订不上的目录
/// 赔上其余十几个，方向是错的。
///
/// ⚠️ 代价是这份失败**不会自愈**：`plan` 照原样写回，下一次 diff 认为它已经订上了。
/// 真要重来一次，得让那个目录先从清单里消失再回来（关掉那个标签再打开）。
/// `failed` 如实报出来，就是为了让前端有机会说一句，而不是把这笔账咽下去。
#[command]
pub async fn set_watched(
    app: AppHandle,
    state: State<'_, WatcherState>,
    paths: Vec<String>,
) -> Result<WatchStats, TreeError> {
    let inner = Arc::clone(&state.inner);
    let filter = Arc::clone(&state.filter);
    tauri::async_runtime::spawn_blocking(move || sync_watches(&app, inner, filter, paths))
        .await
        .map_err(crate::commands::join_failed)?
}

/// [`set_watched`] 的本体。拆出来只有一个理由：`State<'_, T>` 没有公开构造器，
/// 裹着它的命令在单测里压根调不到。与 `commands.rs` 里 `rebuild_indexes` /
/// `query_cached` 同一个手法。
fn sync_watches(
    app: &AppHandle,
    inner: Arc<Mutex<Inner>>,
    filter: Arc<RwLock<Filter>>,
    paths: Vec<String>,
) -> Result<WatchStats, TreeError> {
    let plan = plan_watches(&paths);
    let next_filter = build_filter(&paths, &plan);

    let mut guard = lock_inner(&inner);
    let delta = diff_dirs(&guard.plan, &plan);
    let mut failed = 0;

    // ⚠️ 过滤器**先换**，再去动订阅。反过来的话，「目录刚订上、它的文件还没进表」
    // 这个窗口里发生的改动会被静默丢掉。先换的代价在另一个方向：
    // 还订着的旧目录发来的事件按新表过滤——那是**少报**（用户已经关掉的标签
    // 本来也不该被打扰），不是错报。
    // 空计划时 `next_filter` 也是空的，于是「把监听整个关掉」顺带把表清空
    *lock_filter(&filter) = next_filter;

    if plan.dirs.is_empty() {
        // 一个目录都不用盯 = 把整件事关掉。⚠️ 连 debouncer 一起放掉：
        // 留着的话那条线程与它手里的 FSEvents stream 会一直活到进程结束，
        // 而那时它一个订阅都不需要。`Drop` 会去设停止标志，`Watcher` 那侧自己退订
        guard.debouncer = None;
    } else {
        // 懒创建：一次都不需要盯的时候（没有打开任何文件）不该起一条线程
        if guard.debouncer.is_none() {
            guard.debouncer = Some(start_debouncer(app, &filter)?);
        }
        if let Some(debouncer) = guard.debouncer.as_mut() {
            // 先退订再订阅：反过来会在「同一个目录换了名字」这种现场上短暂地订两遍
            for dir in &delta.removed {
                if debouncer.unwatch(dir).is_err() {
                    failed += 1;
                }
            }
            for dir in &delta.added {
                if debouncer.watch(dir, RecursiveMode::NonRecursive).is_err() {
                    failed += 1;
                }
            }
        }
    }

    let stats = WatchStats {
        dirs: plan.dirs.len(),
        files: plan.files.len(),
        failed,
        skipped: plan.skipped,
        truncated: plan.truncated,
    };
    guard.plan = plan;
    Ok(stats)
}

/// 起 debouncer，并把事件回调接上去。
///
/// ⚠️ 这一条**会** reject（与单个目录订不上不同）：debouncer 起不来意味着
/// 整个后端不可用，那时「静默地什么都不盯」比「告诉前端起不来」坏得多。
fn start_debouncer(app: &AppHandle, filter: &Arc<RwLock<Filter>>) -> Result<Watcher, TreeError> {
    let emitter = app.clone();
    let filter = Arc::clone(filter);
    // ⚠️ 参数类型**必须写出来**：`DebounceEventHandler` 对 `FnMut(DebounceEventResult)`
    // 有一条 blanket impl，而闭包参数不标注的话 rustc 推不出 `result` 是什么，
    // 会一路去找 `&_: IntoIterator` 直到递归上限（E0275），报错里一个字都不提
    // 「你只是忘了标类型」
    new_debouncer(DEBOUNCE_TIMEOUT, None, move |result: DebounceEventResult| match result {
        Ok(events) => {
            for event in &events {
                emit_changes(&emitter, &filter, event);
            }
        }
        // notify 把「后端掉了事件」也走这一条报出来。除了记一行没有别的可做：
        // 重新订阅要一个 `&mut Debouncer`，而这个回调正跑在它自己的线程里，
        // 那个 `&mut` 拿不到（拿到了也是死锁）
        Err(errors) => {
            for error in &errors {
                eprintln!("[vela] 文件监听出错：{error}");
            }
        }
    })
    .map_err(|e| TreeError::Io { reason: "Notify".to_owned(), message: format!("起不了文件监听：{e}") })
}

/// 一条 debounced 事件 → 零条或多条 `vela://file-changed`。
///
/// 「多条」有两个来源：一条事件可以带**多个路径**（FSEvents 会把一批改动打包），
/// 而一个 canonical 路径可以对应**多个原样字符串**（见 [`Filter`]）。
fn emit_changes(app: &AppHandle, filter: &RwLock<Filter>, event: &DebouncedEvent) {
    let kind = change_kind(&event.kind);
    // 先过这一道再拿锁：一个被盯目录里绝大多数事件是关于**别的**文件的
    if kind == ChangeKind::Other {
        return;
    }

    // ⚠️ 先把命中的挑出来、**放掉锁**，再去 stat 与 emit：
    // 一次 stat 在网络卷上不便宜，而 emit 要走一趟 IPC 序列化，
    // 两者都不该占着一把「每条事件都要拿」的读锁
    let mut hits: Vec<(PathBuf, String)> = Vec::new();
    {
        let table = filter.read().unwrap_or_else(PoisonError::into_inner);
        for path in &event.paths {
            if let Some(raws) = table.get(path) {
                hits.extend(raws.iter().map(|raw| (path.clone(), raw.clone())));
            }
        }
    }

    for (canonical, raw) in hits {
        // stat 的是**事件里那个 canonical 路径**，发出去的是原样字符串。
        // 两者指向同一个文件（[`build_filter`] 就是按 canonical 挂上去的），
        // 而 stat 只能用内核眼里的那个名字
        //
        // ⚠️ `kind` 到这儿一定不是 `Other`，所以 `classify` 恒有值；
        // 写成 let-else 只是为了不再 unwrap 一次
        let Some(change) = classify(kind, canonical.exists()) else { continue };
        if let Err(e) = app.emit(crate::FILE_CHANGED, FileChangedPayload { path: raw, kind: change }) {
            // 发不出去只可能是 webview 已经没了，那时也没有前端要通知。
            // 记一行比 panic 好：release 是 `panic = "abort"`
            eprintln!("[vela] 文件改动事件没能发出去：{e}");
        }
    }
}

/// `notify::EventKind` → `ChangeKind`。
///
/// ## `Modify(Name(..))` 一律当 `Modified`，不去分辨是改进来还是改出去
///
/// 改名在一对 `From` / `To` 里，而 debouncer 合并它们的结果取决于时序。
/// 「文件还在不在」才是唯一可靠的结论，而那正是 `classify` 要 stat 一次的理由——
/// 这里多分一档，只是多一处要跟着时序走的地方。
///
/// ## `Any` 也当 `Modified`
///
/// notify 在「不精确」模式下把认不出来的东西一律报成 `Any`。当成 `Modified` 的最坏
/// 结果是**多 stat 一次**，随后 `classify` 按「在不在」给结论；当成 `Other` 的最坏
/// 结果是彻底静默。两个方向里选那个还会说话的。
fn change_kind(kind: &EventKind) -> ChangeKind {
    match kind {
        EventKind::Create(_) => ChangeKind::Created,
        EventKind::Remove(_) => ChangeKind::Removed,
        EventKind::Modify(_) | EventKind::Any => ChangeKind::Modified,
        // 读了一次文件、atime 动了一下、权限被 chmod：都不该惊动用户。
        // 一次 Spotlight 索引就让编辑器弹一句「文件被改了」是没完没了的
        EventKind::Access(_) | EventKind::Other => ChangeKind::Other,
    }
}

/// 按 canonical 形式把原样字符串挂成一张过滤器表。
///
/// ⚠️ 只挂**在 `plan.files` 里活下来的**那些：不在里面意味着它的父目录压根没被订阅，
/// 而留在表里的后果不是「多盯一个」，是「以为盯住了」——一条永远等不到事件的条目
/// 躺在那儿，界面上什么也看不出来。`plan.files` 排过序，所以是二分。
///
/// ⚠️ 同一个原样字符串递两遍只挂一条：重复的后果是**一次改动弹两个对话框**，
/// 而那看起来像是前端的状态机坏了，很难联想到是这张表里有两份。
fn build_filter(paths: &[String], plan: &WatchPlan) -> Filter {
    let mut table: Filter = HashMap::with_capacity(plan.files.len());
    for raw in paths {
        let canonical = normalize(Path::new(raw));
        if plan.files.binary_search(&canonical).is_err() {
            continue;
        }
        let slot = table.entry(canonical).or_default();
        if !slot.contains(raw) {
            slot.push(raw.clone());
        }
    }
    table
}

/// ⚠️ `unwrap_or_else(into_inner)` 而不是 `expect`，理由与 `TaskRegistry::lock`
/// 一字不差：release 是 `panic = "abort"`，而中毒只意味着「有人持锁的时候 panic 了」，
/// 底下那份数据本身还是完好的
fn lock_inner(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

fn lock_filter(filter: &RwLock<Filter>) -> RwLockWriteGuard<'_, Filter> {
    filter.write().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};

    /// 造一条一定存在的绝对路径，**原样**返回（不 normalize）。
    ///
    /// ⚠️ 断言一律拿 `normalize` 之后的值当键来比，不写死字面量：
    /// `tempdir()` 在 macOS 上给的是 `/var/folders/...`，而 `/var` 是个符号链接
    fn existing(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, "x").unwrap();
        path.to_string_lossy().into_owned()
    }

    /// 对照 `src/ipc/watch.test.ts` 的 `GOLDEN_STATS`。
    ///
    /// ⚠️ 这一条钉的是**字段顺序与名字**，而 `WatchStats` 那五个数字里有三个
    /// （`failed` / `skipped` / `truncated`）是「Vela 压根没在盯它」的唯一出口。
    /// 名字漂了的失败方式是前端读到 `undefined`，于是那句话说不出来，
    /// 而用户看到的是「外部改了文件、Vela 一声不吭」——与控制台一行错都没有
    #[test]
    fn 监听总账的线上形状() {
        let stats = WatchStats { dirs: 3, files: 5, failed: 1, skipped: 2, truncated: false };
        assert_eq!(
            serde_json::to_string(&stats).unwrap(),
            r#"{"dirs":3,"files":5,"failed":1,"skipped":2,"truncated":false}"#
        );
    }

    /// 对照 `src/ipc/watch.test.ts` 的 `GOLDEN_CHANGED` / `GOLDEN_REMOVED`。
    ///
    /// ⚠️ `path` 必须是前端递进来的**原样**字符串（理由见 [`Filter`]），
    /// 所以这条测试里写的是一个人能认出来的路径，而不是 canonical 形式。
    /// `kind` 的两个取值另外还在 `wire_contract.rs` 的 `file_change_是两个小写单词`
    /// 里钉了一遍——那边钉的是枚举，这边钉的是信封，两层各自都可能漂
    #[test]
    fn 文件改动载荷的线上形状() {
        let changed = FileChangedPayload { path: "/repo/a.txt".to_owned(), kind: FileChange::Changed };
        assert_eq!(serde_json::to_string(&changed).unwrap(), r#"{"path":"/repo/a.txt","kind":"changed"}"#);
        let removed = FileChangedPayload { path: "/repo/a.txt".to_owned(), kind: FileChange::Removed };
        assert_eq!(serde_json::to_string(&removed).unwrap(), r#"{"path":"/repo/a.txt","kind":"removed"}"#);
    }

    #[test]
    fn 只读一类的动静归到_other() {
        assert_eq!(change_kind(&EventKind::Access(AccessKind::Read)), ChangeKind::Other);
        assert_eq!(change_kind(&EventKind::Other), ChangeKind::Other);
    }

    #[test]
    fn 增删各归各的() {
        assert_eq!(change_kind(&EventKind::Create(CreateKind::File)), ChangeKind::Created);
        assert_eq!(change_kind(&EventKind::Remove(RemoveKind::File)), ChangeKind::Removed);
    }

    /// ⚠️ 这一条钉的是**假警报**那个坑的一半：Vela 自己的 `save_file` 是
    /// 「写临时文件 + rename 盖上去」，在 FSEvents 上会产生 `Modify(Name(..))`
    /// 与 `Remove(..)`。它们都必须走到 `classify` 那一次 stat 上去，
    /// 而不能在这儿就被判成「文件没了」
    #[test]
    fn 改名与认不出来的都当正文可能变了() {
        let metadata = ModifyKind::Metadata(notify::event::MetadataKind::Any);
        for kind in [
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(metadata),
            EventKind::Any,
        ] {
            assert_eq!(change_kind(&kind), ChangeKind::Modified, "{kind:?}");
        }
    }

    #[test]
    fn 过滤器按_canonical_挂而值留着原样() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = existing(tmp.path(), "a.txt");
        let plan = plan_watches(std::slice::from_ref(&raw));

        let table = build_filter(std::slice::from_ref(&raw), &plan);

        assert_eq!(table.len(), 1);
        // 🔴 键是 canonical，值是前端递进来的那个原样字符串。
        // 两者在 macOS 上通常**不相等**（`/var` → `/private/var`），
        // 而在多数 Linux 上相等——所以断言写成「等于 normalize 的结果」
        assert_eq!(table.get(&normalize(Path::new(&raw))), Some(&vec![raw]));
    }

    #[test]
    fn 没被订阅的文件不进过滤器() {
        // `/a.txt` 的父目录是 `/`，`plan_watches` 不会去盯整台机器，
        // 于是它也不该出现在表里
        let raw = "/a.txt".to_owned();
        let plan = plan_watches(std::slice::from_ref(&raw));

        let table = build_filter(&[raw], &plan);

        assert!(table.is_empty());
    }

    #[test]
    fn 同一个原样字符串递两遍只挂一条() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = existing(tmp.path(), "a.txt");
        let plan = plan_watches(&[raw.clone(), raw.clone()]);

        let table = build_filter(&[raw.clone(), raw.clone()], &plan);

        assert_eq!(table.len(), 1);
        assert_eq!(table.get(&normalize(Path::new(&raw))), Some(&vec![raw]));
    }

    #[test]
    fn 同目录下的两个文件各挂各的() {
        let tmp = tempfile::tempdir().unwrap();
        let a = existing(tmp.path(), "a.txt");
        let b = existing(tmp.path(), "b.txt");
        let plan = plan_watches(&[a.clone(), b.clone()]);

        let table = build_filter(&[a.clone(), b.clone()], &plan);

        assert_eq!(table.len(), 2);
        assert_eq!(table.get(&normalize(Path::new(&a))), Some(&vec![a]));
        assert_eq!(table.get(&normalize(Path::new(&b))), Some(&vec![b]));
        // 两个文件共用**一个**目录订阅，这正是「盯父目录」的全部意义
        assert_eq!(plan.dirs.len(), 1);
    }

    /// 🔴 这一条是 `Filter` 那个「为什么值是原样字符串」的**唯一**一条正面证据。
    ///
    /// 用一个真的符号链接把两个原样字符串 canonical 到同一个文件上，
    /// 于是「只留一个就会静默漏掉另一个标签」这件事变得可测。
    /// `#[cfg(unix)]`：Windows 上建符号链接要管理员权限，而 CI 跑的是 ubuntu
    #[cfg(unix)]
    #[test]
    fn 两个原样字符串指向同一个文件时两个都留着() {
        let tmp = tempfile::tempdir().unwrap();
        let real = existing(tmp.path(), "real.txt");
        let link = tmp.path().join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let link = link.to_string_lossy().into_owned();

        let plan = plan_watches(&[real.clone(), link.clone()]);
        // 两条 canonical 之后是同一个文件，于是计划里只有一条
        assert_eq!(plan.files.len(), 1);

        let table = build_filter(&[real.clone(), link.clone()], &plan);

        assert_eq!(table.len(), 1);
        let slot = table.get(&normalize(Path::new(&real))).unwrap();
        assert_eq!(slot.len(), 2, "{slot:?}");
        assert!(slot.contains(&real) && slot.contains(&link), "{slot:?}");
    }

    #[test]
    fn 一开始什么都没盯() {
        let state = WatcherState::default();
        let guard = lock_inner(&state.inner);

        assert!(guard.plan.dirs.is_empty());
        assert!(guard.plan.files.is_empty());
        // ⚠️ debouncer 是**懒**创建的：没有打开任何文件时不该起一条线程
        assert!(guard.debouncer.is_none());
        assert!(lock_filter_read(&state.filter).is_empty());
    }

    fn lock_filter_read(filter: &RwLock<Filter>) -> std::sync::RwLockReadGuard<'_, Filter> {
        filter.read().unwrap_or_else(PoisonError::into_inner)
    }
}
