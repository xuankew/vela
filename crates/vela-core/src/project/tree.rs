//! 目录树的按需列举（PLAN.md §3.4 M2-A「文件树 Rust 侧」）。
//!
//! **贯穿这个模块的一条规则：一次只列一层，绝不建全量树。**
//!
//! 为什么：验收标准是「打开一个含 `node_modules` 的真实前端仓库（10 万+ 文件），侧边栏
//! 秒开不卡」。全量树要在打开的一瞬间 stat 十万个文件；按需列举只 stat 用户真的展开的
//! 那几个目录，成本与仓库大小无关、只与用户看了多少成正比。这也顺带让「展开状态」变成
//! 纯前端的事——Rust 侧不持有任何树形状态，没有需要同步的东西。
//!
//! ## IPC 面为什么长成 `(root, rel)` 两个字符串
//!
//! 前端传相对路径而不是绝对路径，不是审美问题：**这样逃逸在结构上就不可能发生**。
//! `rel` 里只要出现 `..` 或本身是绝对路径，`resolve` 直接拒绝，压根不去拼路径。
//! 换成「前端传绝对路径 + Rust 侧检查它是不是在 root 下面」也能做，但那是一个需要
//! 逐次审计的**判断**，而这里是一个不需要判断的**形状**。
//!
//! 代价是 `DirEntry` 里 `rel` 与 `path` 有点冗余（`path` = root + `rel`）。这个冗余是
//! 刻意买的：前端因此永远不需要做路径拼接，也就不会在分隔符、大小写、末尾斜杠上犯错。
//!
//! ⚠️ **符号链接是有意放行的。** `resolve` 只挡住词法上的逃逸，一个指向 root 外面的
//! 符号链接仍然能被展开。这不是漏洞：pnpm 的 `node_modules` 整个就是符号链接搭起来的，
//! 挡住它等于让本项目的文件树不能用；而 `open_file` 本来就接受任意绝对路径，
//! 放行符号链接没有扩大任何一类信任面。信任边界与 `src-tauri/src/commands.rs` 文件头
//! 那条是同一句话：webview 只加载第一方打包产物。
//!
//! ## 为什么不按 .gitignore 过滤（2026-09-17 定的，与 PLAN §3.4 第 1 项原文相反）
//!
//! PLAN 原来写的是「`ignore::WalkBuilder` 遵守 .gitignore」。实测本仓库后推翻了，
//! 三条理由：
//!
//! 1. **性能理由已经不存在，而且方向是反的。** 上面那条「绝不建全量树」让成本只与用户
//!    展开了多少层成正比，与仓库里有多少文件无关。实测本仓库（Apple Silicon、dev 构建、
//!    三次连跑取区间）：
//!
//!    | 层 | 条目 | `WalkBuilder`（过滤） | `read_dir`（不过滤） |
//!    |---|---|---|---|
//!    | 顶层 | 25 | 5.14ms | **79~115µs** |
//!    | `crates/vela-core/src` | 4 | 599µs | **27~36µs** |
//!    | `node_modules`（21 个符号链接） | 23 | 779µs | **120~134µs** |
//!    | `node_modules/.pnpm`（本仓库最宽的一层） | 289 | 8.76ms | **698~732µs** |
//!
//!    不过滤反而**快了一个数量级**：过滤省下的是本来就没花的钱，而它自己得先把
//!    .gitignore 链（仓库级 + 全局配置 + `.git/info/exclude`）读一遍、编成 regex set。
//!    ⚠️ 一个诚实的例外：`node_modules` 那一层**首次**展开量到 3.24ms，之后才落回
//!    120µs——那是 21 个 pnpm 符号链接第一次被 stat 时的冷缓存，与过滤无关。
//! 2. **代价是实的。** 顶层被滤掉的是 `dist/`、`node_modules/`、`target/`、`.DS_Store`。
//!    前两个正是开发者最常要开的：刚 build 完想看一眼 `dist/index.html`，或者要翻
//!    `node_modules/@codemirror/view` 的类型声明。把它们从树里拿掉，用户只能退回
//!    「打开对话框」或 `Cmd+P`——而 Vela 的定位就是速开。
//! 3. **PLAN 自己就是矛盾的。** §3.4 第 2 项要求 `node_modules`/`.git`/`dist`「默认折叠」，
//!    这句话预设它们**可见**。第 1 项的过滤会让其中两个压根不出现，第 2 项就无从实现。
//!
//! 连带结果：`ignore` 这个依赖在本模块里没有任何使用者了，已从 `Cargo.toml` 摘掉
//! （留着一条没人用的依赖，等于让 manifest 说一句假话）。M2-C 会把它加回到搜索侧。
//!
//! ⚠️ **全局搜索是另一回事，那边必须过滤。** 一次搜索要把每个文件的正文都读一遍，
//! 不过滤就等于 grep 十万个 `node_modules` 里的文件——那才是 `.gitignore` 真正省钱的地方。
//! M2-C 落地时 `ignore::WalkBuilder` 用在搜索侧，并且要有与本章相反的一条测试。

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// 目录里的一项。
///
/// `rel` 与 `path` 都可以直接回传：`rel` 喂给下一次 `list_dir`，`path` 喂给 `open_file`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// 相对 root 的路径，永远用 `/` 分隔，永远不以 `/` 开头或结尾
    pub rel: String,
    /// 绝对路径，给 `open_file` 用
    pub path: String,
    pub is_dir: bool,
}

/// 一次单层列举的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// 归一化之后的 `rel`。前端存这一份，不要存自己传进来的那个字符串：
    /// `""`、`"."`、`"a//b"` 传进来都会变成同一个规范形式
    pub rel: String,
    /// 已排好序：文件夹优先，同组内按不区分大小写的名字
    pub entries: Vec<DirEntry>,
}

/// 用 `#[serde(tag = "kind")]`，与 `fs::ReadError` 同一套路数：前端要按类型分支，
/// 把错误压成一个字符串会逼它去 `includes('不存在')`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TreeError {
    Io {
        reason: String,
        message: String,
    },
    NotFound {
        path: String,
    },
    /// 路径存在但不是目录。前端拿它去区分「点了个文件」与「文件没了」——
    /// 两者在 UI 上是完全不同的两句话
    NotADirectory {
        path: String,
    },
    /// 新建/重命名的目标已经存在（M2-B-5）。
    ///
    /// **不覆盖，也不自动加 ` (1)` 后缀**：自动改名会让「新建 README.md」在已有
    /// README.md 的目录里静默产出 `README.md (1)`，用户以为成功了，实际写进了另一个文件。
    /// Finder 与 VS Code 都是当场报错让用户自己决定
    AlreadyExists {
        path: String,
    },
    /// 名字本身不合法（M2-B-5）：空字符串、含 `/`、或者就是 `.` / `..`。
    ///
    /// 与 `Escape` 的区别是**谁错了**：`Escape` 是 `rel` 想离开 root（只可能来自我们的
    /// 代码有 bug），而 `BadName` 是用户在输入框里打了一个不能当文件名的东西——
    /// 这是一句要对用户说的话，所以它单独一个变体
    BadName {
        name: String,
    },
    /// `rel` 想离开 root（含 `..`，或本身就是绝对路径）
    Escape {
        rel: String,
    },
    /// root 不是绝对路径。这条防的是**静默的错答案**：相对路径会按 Rust 进程的
    /// cwd 解析，而 `.app` 双击启动时 cwd 是 `/`，于是列举出来的是根目录的内容
    BadRoot {
        path: String,
    },
}

impl TreeError {
    pub(crate) fn io(err: std::io::Error) -> Self {
        TreeError::Io { reason: format!("{:?}", err.kind()), message: err.to_string() }
    }
}

/// 把「路径不存在」从 io 错误里单拎出来。
///
/// 前端要说「找不到 X（可能被移动或删除了）」而不是笼统一句「出错了」，而 `io::Error`
/// 一旦被压成字符串就再也没法分支——这与 `TreeError` 用 `#[serde(tag = "kind")]`
/// 而不是 `String` 是同一条理由。
pub(crate) fn missing_or_io(err: std::io::Error, path: &Path) -> TreeError {
    match err.kind() {
        std::io::ErrorKind::NotFound => TreeError::NotFound { path: path.display().to_string() },
        _ => TreeError::io(err),
    }
}

/// 从一条**已经落地**的路径造出 `DirEntry`（M2-B-5 的新建与重命名共用）。
///
/// `rel` 必须是 `resolve` 归一化之后的形式，`name` 直接取它的最后一段。这样
/// 「`DirEntry.rel` 原样回传就能用」这条性质对新建出来的条目同样成立——
/// 前端拿到返回值之后不需要自己拼任何东西。
pub(crate) fn entry_for(rel: &str, path: &Path, is_dir: bool) -> DirEntry {
    DirEntry {
        name: rel.rsplit_once('/').map_or(rel, |(_, name)| name).to_owned(),
        rel: rel.to_owned(),
        path: path.display().to_string(),
        is_dir,
    }
}

impl std::fmt::Display for TreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TreeError::Io { message, .. } => f.write_str(message),
            TreeError::NotFound { path } => write!(f, "找不到 {path}"),
            TreeError::NotADirectory { path } => write!(f, "{path} 不是目录"),
            TreeError::AlreadyExists { path } => write!(f, "{path} 已经存在"),
            TreeError::BadName { name } => write!(f, "{name:?} 不能用作文件名"),
            TreeError::Escape { rel } => write!(f, "路径 {rel:?} 越出了项目根目录"),
            TreeError::BadRoot { path } => write!(f, "项目根目录 {path:?} 不是绝对路径"),
        }
    }
}

/// 列出 `root` 下 `rel` 这一层的条目。`rel` 为空字符串表示 root 本身。
pub fn list_dir(root: &Path, rel: &str) -> Result<DirListing, TreeError> {
    let (target, rel) = resolve(root, rel)?;

    // 先自己判一次目录，有两个理由：① `read_dir` 报的是 io::Error，而
    // `ErrorKind::NotADirectory` 到 Rust 1.83 才稳定，本仓库 MSRV 是 1.77.2，
    // 靠它区分就得抬 MSRV；② 前端要分别说话——「这个文件夹没了」与「你点的是个文件」
    // 是两句完全不同的提示，压成一条 io 错误就只能说「出错了」
    let meta = std::fs::metadata(&target).map_err(|e| missing_or_io(e, &target))?;
    if !meta.is_dir() {
        return Err(TreeError::NotADirectory { path: target.display().to_string() });
    }

    let mut entries = Vec::new();
    for item in std::fs::read_dir(&target).map_err(TreeError::io)? {
        // 单个条目读不出来（权限不够、列举途中被删）就跳过。让整次展开失败比少显示
        // 一个条目更糟——Finder 与 VS Code 都是这个行为
        let Ok(item) = item else { continue };
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        entries.push(DirEntry { name, rel: child_rel, path: path.display().to_string(), is_dir: entry_is_dir(&item) });
    }

    sort_entries(&mut entries);

    Ok(DirListing { rel, entries })
}

/// 文件夹优先，同组内按不区分大小写的名字，最后按字节定平局。
///
/// 提出来单独一个函数是为了能被单测直接钉住：macOS 默认文件系统不区分大小写，
/// `foo` / `Foo` / `FOO` 在那儿是**同一个文件**，用真实目录测不出平局那一条。
fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        // `bool` 里 true > false，而我们要文件夹在前，所以是 b 比 a
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            // 大小写不敏感那一层比出平局时（Linux、或 macOS 的区分大小写卷），
            // 少了这一条，先后就取决于 `read_dir` 的返回顺序，也就是随机的：
            // 同一棵树刷新两次可能长得不一样
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// 这一项是不是目录。
///
/// `read_dir` 在 Unix 上直接拿 `d_type`，所以普通文件与目录这一步**不需要 stat**——
/// 一个两千项的 `node_modules` 顶层因此省下两千次系统调用。只有符号链接必须 stat：
/// `d_type` 只知道「这是个链接」，不知道链接那头是文件还是目录。
fn entry_is_dir(item: &std::fs::DirEntry) -> bool {
    match item.file_type() {
        Ok(ft) if !ft.is_symlink() => ft.is_dir(),
        // 断链的符号链接 stat 会失败，当成文件显示：展开它会得到 not_found，
        // 而点开一个文件会走 open_file 的报错，两条路都有话可说
        _ => std::fs::metadata(item.path()).is_ok_and(|m| m.is_dir()),
    }
}

/// 这个路径上**有没有东西**。
///
/// ⚠️ 用 `symlink_metadata` 而不是 `Path::exists()`：后者跟着符号链接走，
/// 于是「这里有一个指向不存在处的断链」会被判成「这里什么都没有」——
/// 新建就此成功，磁盘上从此有两条同名条目，而树里只显示一行。
/// 断链是 pnpm 仓库里的常态（依赖被删了一半），不是边角情况。
pub(crate) fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// 把 `rel` 拼到 `root` 上，同时产出归一化的 `rel`。
///
/// 只接受 `Normal` 组件：`..` 会逃出 root，绝对路径会**整个替换掉** root
/// （`Path::push` 的语义），两者一律拒绝。
///
/// ⚠️ **这是整条「(root, rel) 让逃逸在结构上不可能」保证的唯一实现处**（模块文档第 2 条）。
/// `ops.rs` 的新建/重命名/删除解析一律走这里，绝不自己 `root.join(rel)`：
/// 第二份拼接逻辑就意味着第二处需要审计的地方，而那条保证的价值恰恰在于「不需要审计」。
pub(crate) fn resolve(root: &Path, rel: &str) -> Result<(PathBuf, String), TreeError> {
    if !root.is_absolute() {
        return Err(TreeError::BadRoot { path: root.display().to_string() });
    }
    let mut target = root.to_path_buf();
    let mut parts: Vec<String> = Vec::new();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => {
                target.push(part);
                parts.push(part.to_string_lossy().into_owned());
            }
            // `Path::new(".").components()` 产出一个 `CurDir`，接受它但什么也不做
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(TreeError::Escape { rel: rel.to_owned() })
            }
        }
    }
    Ok((target, parts.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 建一棵固定的树，所有排序/层级测试共用它。
    ///
    /// ```text
    /// root/
    /// ├── src/
    /// │   └── deep/          ← 孙子目录，用来证明不递归
    /// │       └── leaf.txt
    /// ├── zeta.txt
    /// ├── Alpha.txt
    /// └── beta.txt
    /// ```
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::write(root.join("src/deep/leaf.txt"), "叶子").unwrap();
        for name in ["zeta.txt", "Alpha.txt", "beta.txt"] {
            fs::write(root.join(name), name).unwrap();
        }
        dir
    }

    fn names(listing: &DirListing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn 只列一层_孙子目录不出现() {
        let dir = fixture();
        let listing = list_dir(dir.path(), "").unwrap();
        assert_eq!(names(&listing), vec!["src", "Alpha.txt", "beta.txt", "zeta.txt"]);
        // `deep` 与 `leaf.txt` 都不在结果里：全量树是这一项 ⛔ 明令禁止的做法
        assert!(!listing.entries.iter().any(|e| e.name == "deep" || e.name == "leaf.txt"));
        assert!(listing.entries.iter().find(|e| e.name == "src").unwrap().is_dir);
    }

    #[test]
    fn 文件夹优先_同组内不区分大小写() {
        let dir = fixture();
        let listing = list_dir(dir.path(), "").unwrap();
        // 目录先出来；文件那一段是 alpha < beta < zeta，注意 `Alpha.txt` 的大写 A
        // 没有让它排到小写 b 后面（ASCII 里 'A'=65 < 'a'=97，直接比字节会得到另一个顺序）
        assert_eq!(names(&listing), vec!["src", "Alpha.txt", "beta.txt", "zeta.txt"]);
    }

    /// 排序的三条规则一次钉住。
    ///
    /// 必须用合成的 `DirEntry` 而不是真实文件：平局那一条（只差大小写的名字）在
    /// macOS 默认卷上**造不出来**——`foo` / `Foo` / `FOO` 是同一个文件，三次 `fs::write`
    /// 只留下一个。而 Linux 与 macOS 的「区分大小写」卷上它确实会发生，
    /// 那时少了字节兜底，顺序就跟着 `read_dir` 漂。
    #[test]
    fn 排序是文件夹优先_再按不区分大小写的名字_最后按字节() {
        fn entry(name: &str, is_dir: bool) -> DirEntry {
            DirEntry { name: name.to_owned(), rel: name.to_owned(), path: name.to_owned(), is_dir }
        }
        // 刻意按「最不可能对」的顺序摆：文件在前、大写在小写后、目录垫底
        let mut entries = vec![
            entry("zeta.txt", false),
            entry("foo", false),
            entry("Alpha.txt", false),
            entry("FOO", false),
            entry("src", true),
            entry("Foo", false),
            entry(".git", true),
        ];
        sort_entries(&mut entries);
        let got: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            got,
            // 两个目录先出来（.git < src）；文件那一段不区分大小写地排，
            // 三个 foo 之间再按字节：'F','O' < 'F','o' < 'f'
            vec![".git", "src", "Alpha.txt", "FOO", "Foo", "foo", "zeta.txt"]
        );
    }

    #[test]
    fn 排序对已经有序的输入是幂等的() {
        let dir = fixture();
        let first = list_dir(dir.path(), "").unwrap();
        let mut entries = first.entries.clone();
        sort_entries(&mut entries);
        // 稳定性是「刷新一次树不会自己跳一下」的前提
        assert_eq!(entries, first.entries);
    }

    #[test]
    fn 返回的_rel_可以直接喂回去() {
        let dir = fixture();
        let top = list_dir(dir.path(), "").unwrap();
        let src = top.entries.iter().find(|e| e.name == "src").unwrap();
        assert_eq!(src.rel, "src");

        // rel 是「原样回传就能用」的，这是前端不做路径拼接的前提
        let nested = list_dir(dir.path(), &src.rel).unwrap();
        assert_eq!(nested.rel, "src");
        assert_eq!(names(&nested), vec!["deep"]);
        assert_eq!(nested.entries[0].rel, "src/deep");

        let deepest = list_dir(dir.path(), &nested.entries[0].rel).unwrap();
        assert_eq!(deepest.rel, "src/deep");
        assert_eq!(names(&deepest), vec!["leaf.txt"]);
        assert_eq!(deepest.entries[0].rel, "src/deep/leaf.txt");
    }

    #[test]
    fn 归一化把等价的_rel_收成同一个形式() {
        let dir = fixture();
        let canonical = list_dir(dir.path(), "src").unwrap();
        for variant in ["", "."] {
            assert_eq!(list_dir(dir.path(), variant).unwrap().rel, "", "{variant:?} 应归一化成空");
        }
        // 重复斜杠与末尾斜杠都不该改变结果
        assert_eq!(list_dir(dir.path(), "src//").unwrap(), canonical);
        assert_eq!(list_dir(dir.path(), "./src/").unwrap(), canonical);
        // 空 rel 的 components() 是空的，不会产出一个 CurDir 把 target 顶掉
        assert_eq!(Path::new("").components().count(), 0);
    }

    #[test]
    fn rel_里的越界写法一律拒绝() {
        let dir = fixture();
        for rel in ["..", "../", "src/..", "src/../..", "/etc", "/"] {
            assert_eq!(
                list_dir(dir.path(), rel).unwrap_err(),
                TreeError::Escape { rel: rel.to_owned() },
                "{rel:?} 本该被拒绝"
            );
        }
    }

    #[test]
    fn root_不是绝对路径时报_bad_root() {
        let err = list_dir(Path::new("relative/root"), "").unwrap_err();
        assert_eq!(err, TreeError::BadRoot { path: "relative/root".to_owned() });
    }

    #[test]
    fn 展开一个文件报_not_a_directory() {
        let dir = fixture();
        let err = list_dir(dir.path(), "beta.txt").unwrap_err();
        // 必须是 not_a_directory 而不是 not_found：路径确实存在，说「找不到」会误导排查
        assert_eq!(err, TreeError::NotADirectory { path: dir.path().join("beta.txt").display().to_string() });
    }

    #[test]
    fn 不存在的目录报_not_found() {
        let dir = fixture();
        let missing = dir.path().join("nope");
        assert_eq!(
            list_dir(dir.path(), "nope").unwrap_err(),
            TreeError::NotFound { path: missing.display().to_string() }
        );
    }

    /// 点开头的东西照常列出——树里**没有任何**点文件过滤。
    ///
    /// `.gitignore`、`.env`、`.github/` 是开发者最常要开的几类文件，藏起来只会逼人
    /// 去开终端。Finder 默认藏点文件，但编辑器的文件树不是 Finder。
    #[test]
    fn 隐藏文件不被过滤() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".github")).unwrap();
        fs::write(dir.path().join(".env"), "TOKEN=1").unwrap();
        fs::write(dir.path().join("plain.txt"), "").unwrap();
        assert_eq!(names(&list_dir(dir.path(), "").unwrap()), vec![".github", ".env", "plain.txt"]);
    }

    /// `.gitignore` **不影响树**。这条是 2026-09-17 那个决定的钉子（理由见模块文档）：
    /// 将来谁把过滤加回来，它会当场红。
    ///
    /// ⚠️ 全局搜索侧必须有一条**相反**的测试——那边不过滤就等于 grep 十万个
    /// `node_modules` 里的文件。两条测试方向相反不是写错了，是两处的权衡本来就不同。
    #[test]
    fn gitignore_命中的条目照常列出() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "dist/\n*.log\n").unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::create_dir(dir.path().join("dist")).unwrap();
        fs::write(dir.path().join("dist/bundle.js"), "").unwrap();
        fs::write(dir.path().join("app.log"), "").unwrap();
        fs::write(dir.path().join("main.rs"), "").unwrap();

        // 有 .git、有 .gitignore、规则也确实命中——一个都不滤。
        // `dist` 是目录所以排最前，然后按不区分大小写的名字
        assert_eq!(names(&list_dir(dir.path(), "").unwrap()), vec![".git", "dist", ".gitignore", "app.log", "main.rs"]);
        // 被忽略的目录**里面**也照常列：用户展开 dist 就是为了看构建产物
        assert_eq!(names(&list_dir(dir.path(), "dist").unwrap()), vec!["bundle.js"]);
    }

    /// 符号链接指向目录时 `is_dir` 必须是 true。
    ///
    /// 这不是边角情况：pnpm 的 `node_modules` 整个是符号链接搭起来的，判错的话
    /// 本项目的文件树里所有依赖都会变成「点不开的文件」。
    #[test]
    #[cfg(unix)]
    fn 符号链接指向目录时算目录() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("packages/real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("index.js"), "").unwrap();
        fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join("node_modules/real")).unwrap();
        // 断链：指向一个不存在的地方
        std::os::unix::fs::symlink(dir.path().join("gone"), dir.path().join("node_modules/broken")).unwrap();

        let listing = list_dir(&dir.path().join("node_modules"), "").unwrap();
        // `real` 排在前面：它 is_dir=true（链接那头是目录），而排序是文件夹优先
        assert_eq!(names(&listing), vec!["real", "broken"]);
        let by_name = |n: &str| listing.entries.iter().find(|e| e.name == n).unwrap().clone();
        assert!(by_name("real").is_dir, "指向目录的符号链接被判成了文件");
        assert!(!by_name("broken").is_dir, "断链被判成了目录，展开它只会得到一个空层");

        // 展开它拿到的是链接那头的真实内容——这就是 pnpm 场景要的行为
        assert_eq!(names(&list_dir(&dir.path().join("node_modules"), "real").unwrap()), vec!["index.js"]);
    }

    #[test]
    fn 空目录列出零项而不是报错() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();
        let listing = list_dir(dir.path(), "empty").unwrap();
        assert_eq!(listing.rel, "empty");
        assert!(listing.entries.is_empty());
    }

    #[test]
    fn 中文名与空格在_rel_与_path_里都完好() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("我的 项目")).unwrap();
        fs::write(dir.path().join("我的 项目/说明 文档.md"), "# 标题").unwrap();

        let top = list_dir(dir.path(), "").unwrap();
        assert_eq!(top.entries[0].name, "我的 项目");
        assert_eq!(top.entries[0].rel, "我的 项目");

        let inner = list_dir(dir.path(), &top.entries[0].rel).unwrap();
        assert_eq!(inner.entries[0].name, "说明 文档.md");
        assert_eq!(inner.entries[0].rel, "我的 项目/说明 文档.md");
        assert_eq!(Path::new(&inner.entries[0].path), dir.path().join("我的 项目/说明 文档.md"));
    }
}
