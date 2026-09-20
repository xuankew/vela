//! 外部改动监听（PLAN.md §2.5 `watcher/`，M2-G）。
//!
//! ## 这一层**不含 `notify`**
//!
//! `notify` 与 `notify-debouncer-full` 都是 `src-tauri` 的依赖，vela-core 一个字节都不引。
//! 与 `trash::delete` 不进 `project/ops.rs` 是同一条理由，只是更硬一档：一个真的 watcher
//! 在单测里既会漏文件描述符、又要等 FSEvents/inotify 的异步回调，于是「改一行断言、
//! 睡 200ms、偶尔红一次」会变成这一层的常态。这里只留三件能同步跑完的事：
//! **该盯哪些目录**（[`plan_watches`]）、**两次计划之间要动哪些订阅**（[`diff_dirs`]）、
//! 以及**一条事件算哪一种变化**（[`classify`]）。
//!
//! ⚠️ 「不含 notify」不等于「不碰文件系统」：[`plan_watches`] 每个路径要 canonicalize
//! 一次，[`classify`] 的 `path_exists` 由调用方 stat 出来递进来。两者都是元数据级的一次
//! 系统调用，不起线程、不注册回调，所以在单测里是确定的。
//!
//! ## 监听范围是「打开过的文件的父目录」，⛔ 不是整棵项目树
//!
//! PLAN §3.4 那一行要的是「文件被外部修改时提示重载」，说的就是**开着的那些文件**。
//! 盯整棵树是另一个功能（侧边栏自动刷新），而它恰好落在 M2-A 那条教训的正上方：
//! 十万文件的仓库上，任何「对整棵树做点什么」的操作都是预算要去的地方。
//! 侧边栏今天有一个手动刷新按钮，那已经够用了。

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 一次能盯住的目录数上限。
///
/// 正常情况下压根到不了：一个目录能装下几十个打开的文件，而标签本身有
/// `session::MAX_SESSION_TABS = 64` 那个上限。这个数字管的是另一种现场——
/// 用户开了 64 个分散在 64 个不同目录里的文件，而其中一些长在挂载点上。
///
/// ⚠️ 截断不是静默的：[`WatchPlan::truncated`] 会为真，调用方要说一句。
/// 「某个文件外部改了而 Vela 没吭声」与「Vela 压根没在盯它」在界面上长得一模一样，
/// 而那正是这一层最该避免的失败方式。
pub const MAX_WATCH_DIRS: usize = 256;

/// `notify::EventKind` 在这一层的对应物。
///
/// ⚠️ 刻意比 notify 那一个粗得多：notify 区分 `Modify(Data)` / `Modify(Metadata)` /
/// `Modify(Name(..))` / `Modify(Other)`，而这一层只需要「正文可能变了」与「文件没了」
/// 两种结论。把 notify 的十几个变体原样搬过来，等于要求前端也跟着分支——
/// 而它对每一个分支要做的事都是一样的。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChangeKind {
    /// 正文或元数据被写过（`Modify` 与 `Any` 都归这里）
    Modified,
    /// 新出现（`Create`）
    Created,
    /// 被删掉或被改名走了（`Remove`）
    Removed,
    /// 只读一类的动静（`Access`）与认不出来的（`Other`）
    Other,
}

/// 交给前端的那一种变化。只有两种。
///
/// ⚠️ `rename_all = "camelCase"` 是线上契约的一部分：前端那份
/// `FileChangeKind`（`src/ipc/watch.ts`）的字面量是 `"changed"` 与 `"removed"`，
/// 而 serde 对一个无字段枚举的默认写法是 `"Changed"`。对不上的失败方式极其安静——
/// 前端收到一个认不出的字符串，`switch` 走完 default 分支，什么都不发生。
/// 两边各有一份对照测试（`crates/vela-core/tests/wire_contract.rs` 与
/// `src/ipc/watch.test.ts`），改一边必须同时改另一边。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChange {
    /// 磁盘上的正文可能已经不是编辑器里那一份了
    Changed,
    /// 文件没了
    Removed,
}

/// 一份监听计划：盯哪些目录、关心哪些文件。
///
/// 两个 `Vec` 都是**去重且按字节排序**的。排序不是为了好看：`set_watched` 要拿它
/// 与上一次那份做 diff，只 watch/unwatch 变化的那几个，而 diff 要在两份
/// 「顺序稳定」的清单上做才有意义（否则同一个标签集合会因为 `HashMap` 的迭代顺序
/// 每次都不一样，diff 每次都得出「全变了」）。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchPlan {
    /// 要交给 `notify` 的目录，**已经是 canonical 形式**
    pub dirs: Vec<PathBuf>,
    /// 关心的文件，**已经是 canonical 形式**，且每一条的父目录都在 `dirs` 里
    pub files: Vec<PathBuf>,
    /// 被丢掉的输入条数：不是绝对路径、或者没有父目录（`/` 本身）
    pub skipped: usize,
    /// `dirs` 撞了 [`MAX_WATCH_DIRS`] 被截断。为真时 `files` 也跟着少
    pub truncated: bool,
}

/// 把路径 canonicalize 一次，失败就原样返回。
///
/// ## 为什么必须做这一步
///
/// FSEvents 报上来的是**内核眼里**的路径，而前端递过来的是 dialog 插件或会话存档里的
/// 字符串。macOS 上 `/tmp`、`/var` 都是指向 `/private/...` 的符号链接，于是
/// 「盯 `/tmp/a.txt`、收到 `/private/tmp/a.txt`」这个组合会让每一条事件都对不上号。
///
/// 🔴 **失败方式是彻底的静默**：不报错、不崩溃，只是外部改了文件而 Vela 一声不吭。
/// 这一层里没有任何一个断言能发现它，只有真机上把文件放在符号链接底下才看得见。
///
/// 失败时原样返回而不是丢掉：文件**不存在**的时候 canonicalize 必然失败，
/// 而「盯一个还不存在的文件」是合法的（用户可能正要在别处创建它）。
/// 那种情况下两边都拿到同一个原始字符串，比对仍然成立。
pub fn normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `dirs` 里有没有这一个。`dirs` 排过序，所以是二分。
///
/// ⚠️ 写成 `binary_search_by` 而不是 `binary_search(parent)`：`dirs` 是 `Vec<PathBuf>`
/// 而 `Path::parent()` 给的是 `&Path`，`binary_search` 要的是 `&PathBuf`，
/// 两者之间没有自动的 deref。`Path` 的 `Ord` 比的是 components，与 `PathBuf` 的完全一致
fn has_dir(dirs: &[PathBuf], parent: &Path) -> bool {
    dirs.binary_search_by(|dir| dir.as_path().cmp(parent)).is_ok()
}

/// 从「打开着的文件」算出「该盯哪些目录」。
///
/// 盯父目录而不是文件本身：`notify` 在 macOS 上盯单个文件时，一次「写临时文件再 rename
/// 盖上去」的保存会让它**失去订阅**（inode 换了），而那是编辑器与构建工具最常见的写法。
/// 盯目录再自己过滤文件名，就没有这个坑。
///
/// ⚠️ 因此 `files` 不是「要通知谁」而是一份**过滤器**：目录里任何一个条目动了都会
/// 产生一条事件，调用方拿它去 `files` 里查一下，不在里面的直接丢掉。
pub fn plan_watches<P: AsRef<Path>>(paths: &[P]) -> WatchPlan {
    let mut files: Vec<PathBuf> = Vec::with_capacity(paths.len());
    let mut skipped = 0;
    for path in paths {
        let path = path.as_ref();
        // 相对路径一律丢：它相对于谁的 cwd 是说不清的（Tauri 的进程 cwd 通常是 `/`），
        // 而盯错一个目录的失败方式同样是静默
        if !path.is_absolute() {
            skipped += 1;
            continue;
        }
        files.push(normalize(path));
    }
    files.sort();
    files.dedup();

    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut no_parent = 0;
    for file in &files {
        match file.parent() {
            // `/a.txt` 的父目录是 `/`；`/` 自己没有父目录。盯 `/` 等于盯整台机器，
            // 所以这两种都算跳过
            Some(parent) if parent != Path::new("/") => dirs.push(parent.to_path_buf()),
            _ => no_parent += 1,
        }
    }
    dirs.sort();
    dirs.dedup();
    skipped += no_parent;

    let truncated = dirs.len() > MAX_WATCH_DIRS;
    if truncated {
        dirs.truncate(MAX_WATCH_DIRS);
    }
    // `files` 只留父目录活下来的那些。⚠️ 这一步**不只**在截断时才做：
    // `/a.txt` 的父目录是 `/`，而 `/` 压根没进 `dirs`，于是它也不该留在 `files` 里。
    // 留着的后果不是「多盯一个」而是「以为盯住了」——调用方拿 `files` 当过滤器，
    // 一条永远不会有人发事件的条目躺在那儿，界面上什么也看不出来
    files.retain(|file| file.parent().is_some_and(|parent| has_dir(&dirs, parent)));

    WatchPlan { dirs, files, skipped, truncated }
}

/// 从一份计划换到另一份计划，**目录订阅**要动哪几个。
///
/// ## 为什么要 diff，而不是「全退订再全订上」
///
/// 每一次 `watch()` 在 macOS 上都是一条 FSEvents stream，而 debouncer 那侧还会顺手
/// 把目录枚举一遍填它的 file-id 缓存（rename 检测靠它）。用户每开一个标签就要重订
/// 十几个目录，白付的是这个开销；更难看的是「订阅断了一下又接上」这个窗口里发生
/// 的改动没人报——那又是一次彻底的静默。
///
/// 所以只动变化的那几个。⚠️ 前提是两份计划的 `dirs` 都**去重且排好序**
/// （[`WatchPlan`] 的构造保证了这一点），否则同一个标签集合会每次 diff 出「全变了」。
/// 两边都有序，于是这里是一次线性归并，不是 `contains` 的平方。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WatchDelta {
    /// 要新订阅的
    pub added: Vec<PathBuf>,
    /// 要退订的
    pub removed: Vec<PathBuf>,
    /// 两边都有、不用动的个数。留着它是为了在测试里把「没动」也断言出来——
    /// 只断言 added/removed 为空的话，「两边都算错了但刚好抵消」是看不见的
    pub kept: usize,
}

/// 算出从 `previous` 到 `next` 的目录增删。理由与前提见 [`WatchDelta`]。
pub fn diff_dirs(previous: &WatchPlan, next: &WatchPlan) -> WatchDelta {
    let mut delta = WatchDelta::default();
    let (mut old, mut new) = (0, 0);
    while old < previous.dirs.len() && new < next.dirs.len() {
        let was = previous.dirs[old].as_path();
        let now = next.dirs[new].as_path();
        match was.cmp(now) {
            // 旧的那一个小 = 新的里没有它 = 退订
            Ordering::Less => {
                delta.removed.push(was.to_path_buf());
                old += 1;
            }
            Ordering::Greater => {
                delta.added.push(now.to_path_buf());
                new += 1;
            }
            Ordering::Equal => {
                delta.kept += 1;
                old += 1;
                new += 1;
            }
        }
    }
    // 有一边先走完，剩下那一段整个是增（或整个是删）
    delta.removed.extend(previous.dirs[old..].iter().cloned());
    delta.added.extend(next.dirs[new..].iter().cloned());
    delta
}

/// 一条事件算哪一种变化，或者压根不算（[`None`]）。
///
/// `path_exists` 由调用方 stat 出来递进来，而不是这里自己查：这一层不该有第二个
/// 「什么时候碰文件系统」的决定点，而且调用方（src-tauri）本来就要在过滤之后
/// 才知道该不该 stat 一次。
///
/// ## 规则只有一条：**在不在，是 stat 说了算；事件种类只用来决定要不要看**
///
/// - `Other`（只读一类的动静、认不出来的）→ [`None`]，不惊动任何人；
/// - 其余三种，文件**还在** → [`FileChange::Changed`]，文件**没了** → [`FileChange::Removed`]。
///
/// ## 🔴 「说被删了但文件还在 → 算正文变了」不是兜底，这是主要路径
///
/// 原子写盘（写临时文件 → rename 盖上去）在 FSEvents 上会产生一对 `Remove` + `Create`，
/// 而 debouncer 合并它们的结果取决于时序：合并成功是一条 `Modify`，
/// 没合并上就是先一条 `Remove`。**本项目自己的 `save_file` 就是这么写的**，
/// 所以「收到 Removed 但文件还在」不是罕见竞态，是每次保存都会走到的地方。
/// 不做这一次转换的话，用户每存一次盘就会看到一句「这个文件被删掉了」——
/// 一句关于他自己刚刚那次保存的假警报。
///
/// 反过来「说被写了但文件没了」也照同一条规则走：结论是 `Removed`。
/// 那种现场来自「建了又删」被 debouncer 合并成一条，而**编辑器里那份正文与磁盘那份
/// 不一致**这件事仍然成立，只是不一致的方式是「磁盘上没有了」——那要说的是后者。
pub fn classify(kind: ChangeKind, path_exists: bool) -> Option<FileChange> {
    if kind == ChangeKind::Other {
        return None;
    }
    Some(if path_exists { FileChange::Changed } else { FileChange::Removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一条一定存在的绝对路径。canonicalize 之后 `/tmp` 会变成 `/private/tmp`，
    /// 所以断言一律拿 `normalize` 之后的值来比，⛔ 不写死字面量
    fn existing(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "x").unwrap();
        normalize(&path)
    }

    #[test]
    fn 同目录下的两个文件只盯一个目录() {
        let tmp = tempfile::tempdir().unwrap();
        let a = existing(tmp.path(), "a.txt");
        let b = existing(tmp.path(), "b.txt");

        let plan = plan_watches(&[a.clone(), b.clone()]);

        assert_eq!(plan.dirs, vec![normalize(tmp.path())]);
        assert_eq!(plan.files, {
            let mut v = vec![a, b];
            v.sort();
            v
        });
        assert_eq!(plan.skipped, 0);
        assert!(!plan.truncated);
    }

    #[test]
    fn 目录与文件都是去重且排好序的() {
        let tmp = tempfile::tempdir().unwrap();
        let one = tmp.path().join("one");
        let two = tmp.path().join("two");
        std::fs::create_dir(&one).unwrap();
        std::fs::create_dir(&two).unwrap();
        // 刻意乱序递进去：diff 要在两份顺序稳定的清单上做才有意义
        let paths = [existing(&two, "b.txt"), existing(&one, "z.txt"), existing(&two, "a.txt")];

        let plan = plan_watches(&paths);

        let mut want_dirs = vec![normalize(&one), normalize(&two)];
        want_dirs.sort();
        assert_eq!(plan.dirs, want_dirs);
        let mut want_files: Vec<PathBuf> = paths.iter().map(|p| normalize(p)).collect();
        want_files.sort();
        assert_eq!(plan.files, want_files);
    }

    #[test]
    fn 同一个文件递两遍只算一条() {
        let tmp = tempfile::tempdir().unwrap();
        let a = existing(tmp.path(), "a.txt");

        let plan = plan_watches(&[a.clone(), a.clone(), a]);

        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.dirs.len(), 1);
    }

    #[test]
    fn 相对路径被丢掉并计数() {
        let tmp = tempfile::tempdir().unwrap();
        let a = existing(tmp.path(), "a.txt");

        let plan = plan_watches(&[a.clone(), PathBuf::from("src/main.rs"), PathBuf::from("../up.txt")]);

        assert_eq!(plan.files, vec![a]);
        assert_eq!(plan.skipped, 2);
    }

    #[test]
    fn 根目录与没有父目录的条目被丢掉() {
        let plan = plan_watches(&[PathBuf::from("/"), PathBuf::from("/a.txt")]);

        // `/a.txt` 的父目录是 `/`，盯 `/` 等于盯整台机器，所以两条都不进 dirs
        assert!(plan.dirs.is_empty());
        assert!(plan.files.is_empty());
        assert_eq!(plan.skipped, 2);
    }

    #[test]
    fn 空输入得到一份空计划而不是报错() {
        let plan = plan_watches(&[] as &[PathBuf]);

        assert_eq!(plan, WatchPlan { dirs: vec![], files: vec![], skipped: 0, truncated: false });
    }

    /// ⚠️ canonicalize 那一步的**唯一**一条正面证据。
    ///
    /// 它在 macOS 上把 `/var/...` 变成 `/private/var/...`，在 Linux 上通常什么都不变。
    /// 所以断言写成「等于 `normalize` 的结果」而不是写死一个前缀——这一条钉的是
    /// **计划里的路径与 `normalize` 走的是同一条路**，而不是某台机器上的具体形状
    #[test]
    fn 计划里的路径是_canonical_形式() {
        let tmp = tempfile::tempdir().unwrap();
        // `tempdir()` 在 macOS 上给的是 `/var/folders/...`，而 `/var` 是符号链接
        let raw = tmp.path().join("a.txt");
        std::fs::write(&raw, "x").unwrap();

        let plan = plan_watches(std::slice::from_ref(&raw));

        assert_eq!(plan.files, vec![normalize(&raw)]);
        assert_eq!(plan.dirs, vec![normalize(tmp.path())]);
        // 这一句在 macOS 上为真、在多数 Linux 上两边相等。两种都算过：
        // 要紧的是 `files` 与 `dirs` 出自同一次 normalize，而不是它们各自长什么样
        assert_eq!(plan.files[0].parent().unwrap(), plan.dirs[0]);
    }

    #[test]
    fn 文件不存在时也进计划_原样保留路径() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = tmp.path().join("not-yet.txt");

        let plan = plan_watches(std::slice::from_ref(&gone));

        // canonicalize 失败 → 原样。盯一个还不存在的文件是合法的
        assert_eq!(plan.files, vec![gone]);
        assert_eq!(plan.skipped, 0);
    }

    #[test]
    fn 目录数撞上限时截断并如实报出来() {
        let tmp = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for i in 0..(MAX_WATCH_DIRS + 5) {
            let dir = tmp.path().join(format!("d{i}"));
            std::fs::create_dir(&dir).unwrap();
            paths.push(existing(&dir, "f.txt"));
        }

        let plan = plan_watches(&paths);

        assert!(plan.truncated);
        assert_eq!(plan.dirs.len(), MAX_WATCH_DIRS);
        // `files` 跟着少：留着的每一条都得有人替它发事件
        assert_eq!(plan.files.len(), MAX_WATCH_DIRS);
        assert!(plan.files.iter().all(|f| has_dir(&plan.dirs, f.parent().unwrap())));
    }

    #[test]
    fn 正好撞上限不算截断() {
        let tmp = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for i in 0..MAX_WATCH_DIRS {
            let dir = tmp.path().join(format!("d{i}"));
            std::fs::create_dir(&dir).unwrap();
            paths.push(existing(&dir, "f.txt"));
        }

        let plan = plan_watches(&paths);

        assert!(!plan.truncated);
        assert_eq!(plan.dirs.len(), MAX_WATCH_DIRS);
    }

    /// 直接造一份只有 `dirs` 的计划。
    ///
    /// ⚠️ 不走 `plan_watches`：`diff_dirs` 只看 `dirs`，而经 `plan_watches` 的话
    /// 每个目录都得先在磁盘上建出来、再塞一个文件进去，那些步骤测的是 `plan_watches`
    /// 而不是这里要钉的归并。前提（去重、排序）由字面量自己保证
    fn dirs_only(list: &[&str]) -> WatchPlan {
        WatchPlan { dirs: list.iter().map(PathBuf::from).collect(), files: Vec::new(), skipped: 0, truncated: false }
    }

    #[test]
    fn 同一份计划diff不出任何东西() {
        let plan = dirs_only(&["/a", "/b", "/c"]);

        let delta = diff_dirs(&plan, &plan);

        assert_eq!(delta, WatchDelta { added: vec![], removed: vec![], kept: 3 });
    }

    #[test]
    fn 空到空什么都不动() {
        let delta = diff_dirs(&dirs_only(&[]), &dirs_only(&[]));

        assert_eq!(delta, WatchDelta::default());
    }

    #[test]
    fn 第一次全是新增_清空全是退订() {
        let empty = dirs_only(&[]);
        let two = dirs_only(&["/a", "/b"]);

        let opened = diff_dirs(&empty, &two);
        assert_eq!(opened.added, vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        assert!(opened.removed.is_empty());
        assert_eq!(opened.kept, 0);

        // 「关掉最后一个标签」走的正是反方向，而它必须真的退订：
        // 留着的订阅会继续把事件送到一个已经没人关心的过滤器上
        let closed = diff_dirs(&two, &empty);
        assert!(closed.added.is_empty());
        assert_eq!(closed.removed, vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        assert_eq!(closed.kept, 0);
    }

    #[test]
    fn 只动变化的那几个_交集一动不动() {
        let before = dirs_only(&["/a", "/b", "/c"]);
        let after = dirs_only(&["/b", "/c", "/d", "/e"]);

        let delta = diff_dirs(&before, &after);

        assert_eq!(delta.removed, vec![PathBuf::from("/a")]);
        assert_eq!(delta.added, vec![PathBuf::from("/d"), PathBuf::from("/e")]);
        // `kept` 是这一条真正的断言：`/b` 与 `/c` 不许同时出现在 added 与 removed 里
        assert_eq!(delta.kept, 2);
    }

    #[test]
    fn 文件还在就是正文变了_不管事件说的是哪一种() {
        assert_eq!(classify(ChangeKind::Modified, true), Some(FileChange::Changed));
        assert_eq!(classify(ChangeKind::Created, true), Some(FileChange::Changed));
        // 🔴 这一条钉的是文档里那个「假警报」：Vela 自己每次原子保存都会产生一对
        // Remove + Create，合并不上时就是一条 `Removed`，而文件明明还在
        assert_eq!(classify(ChangeKind::Removed, true), Some(FileChange::Changed));
    }

    #[test]
    fn 文件没了就是没了_也不管事件说的是哪一种() {
        assert_eq!(classify(ChangeKind::Removed, false), Some(FileChange::Removed));
        // 「建了又删」被 debouncer 合并成一条 `Created`：磁盘上没有这件事是结论，
        // 事件种类不是
        assert_eq!(classify(ChangeKind::Created, false), Some(FileChange::Removed));
        assert_eq!(classify(ChangeKind::Modified, false), Some(FileChange::Removed));
    }

    #[test]
    fn 只读一类的动静不算变化() {
        // `Access`（读了一次、atime 动了）与认不出来的 `Other` 都不该惊动用户：
        // 一次 `cat` 或者一次 Spotlight 索引就让编辑器弹一句「文件被改了」是没完没了的
        assert_eq!(classify(ChangeKind::Other, true), None);
        assert_eq!(classify(ChangeKind::Other, false), None);
    }
}
