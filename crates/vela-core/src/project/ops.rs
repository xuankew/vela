//! 文件树上的写操作：新建、重命名，以及给「移到废纸篓 / 在 Finder 中显示 / 复制路径」
//! 用的路径解析（PLAN.md §3.4 M2-B-5）。
//!
//! ## 与列举共用同一条防逃逸形状
//!
//! 三个公开函数**一律**通过 `tree::resolve` 拿路径，没有一处自己写 `root.join(rel)`。
//! 这不是代码复用洁癖：`(root, rel)` 的全部价值在于「逃逸在结构上不可能，因此不需要
//! 逐次审计」（`tree.rs` 模块文档第 2 条）。一旦出现第二份拼接逻辑，那条保证就退化成
//! 「有两处需要审计」——而写操作比读操作更经不起审计漏一处。
//!
//! ## ⚠️ 信任面：M2-B-5 把「读 + 枚举」升级成了「改 + 删」
//!
//! 到 M2-A 为止，webview 拿到的是「读一个已知路径的文件」与「枚举一个已授权文件夹」。
//! 这一层加进去的是**创建、改名，以及（经由 Tauri 层）移到废纸篓**。三条缓解：
//!
//! 1. 解析仍然只走 `resolve`，所以所有写操作都落在 root 里面（`..` 与绝对路径当场拒绝）；
//! 2. **不做递归删除**：这里连 `remove_file` 都没有，删除整个交给 Tauri 层调 `trash`，
//!    于是「删掉一整个目录树」这个最坏情况的最坏结果是「废纸篓里多一个文件夹」；
//! 3. 新建不覆盖、重命名不覆盖（见下面各自的注释）——静默覆盖别人的文件是这一层
//!    能造成的唯一不可逆损失，所以它在两个函数里都被显式挡掉了。
//!
//! M5 开放插件时，这一层的命令必须与 `list_dir` 一起换成 `rootId` + managed state
//! （`src-tauri/src/commands.rs` 文件头那条）。
//!
//! ## 为什么 `trash::delete` 不在这一侧
//!
//! `resolve_existing` 只解析路径，真正把东西扔进废纸篓的是 `src-tauri/src/commands.rs`。
//! 理由与 `close_window` / `save_session` 不下沉是同一条（那一层的文件头写着「本体就是
//! 框架调用」），但这里还多一条更硬的原因：**`cargo test` 会真的把临时文件塞进用户的
//! 废纸篓**。一个单元测试在开发机上留下几十个待清空的条目，而 CI 的 ubuntu runner 上
//! 根本没有废纸篓可用（`trash` 会走 D-Bus，容器里没有），测试必然红。
//! 系统调用不进 vela-core，于是这一层的每个分支都能用 `tempfile` 干净地测完。

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::tree::{entry_for, exists, missing_or_io, resolve, DirEntry, TreeError};

/// 新建的是文件还是文件夹。
///
/// 做成枚举而不是 `bool`：命令签名里的 `is_dir: bool` 在调用点是
/// `create_entry(root, rel, false)`——一个光秃秃的 `false`，读的人得翻回签名才知道
/// 它是哪个方向，而这两个方向搞反的失败方式是「建出来一个空文件夹」或「建出来一个
/// 零字节文件」，两者都不报错。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

/// 在 `root` 下新建一个文件或文件夹，返回它自己的条目。
///
/// `rel` 是**相对 root 的完整路径**（父层 rel + `/` + 名字），由前端拼好后传进来——
/// 这是唯一一处前端做路径字符串运算的地方，而它拼的是 `rel` 不是绝对路径，
/// 拼错了最坏也就是 `Escape` 或 `NotFound`，不会写到 root 外面去。
///
/// ⚠️ **已存在时报错，不覆盖，也不自动加 ` (1)` 后缀。** 自动改名会让「新建 README.md」
/// 在一个已有 README.md 的目录里静默产出 `README.md (1)`，用户以为建好了，
/// 接下来的编辑全写进了另一个文件。Finder 与 VS Code 都是当场报错让用户自己决定。
pub fn create_entry(root: &Path, rel: &str, kind: EntryKind) -> Result<DirEntry, TreeError> {
    let (target, rel) = resolve(root, rel)?;
    // 空 rel 说的是 root 本身。「在 root 上新建」不是新建，是换一个文件夹
    if rel.is_empty() {
        return Err(TreeError::BadName { name: String::new() });
    }
    if exists(&target) {
        return Err(TreeError::AlreadyExists { path: target.display().to_string() });
    }

    match kind {
        // `map(drop)`：新建出来的是**空**文件，句柄当场关掉。内容随后由编辑器
        // 走 `save_file` 那条原子写入的路径来，这里拿着一个句柄没有任何用处
        EntryKind::File => std::fs::File::create(&target).map(drop).map_err(|e| missing_or_io(e, &target))?,
        // 刻意用 `create_dir` 而不是 `create_dir_all`：中间层不存在，说明用户把一整条
        // 路径打进了「名字」输入框。`create_dir_all` 会一声不响地把那条路径整个建出来，
        // 于是一次输入错误在磁盘上留下几个没人要的目录，而界面上只显示「新建成功」
        EntryKind::Dir => std::fs::create_dir(&target).map_err(|e| missing_or_io(e, &target))?,
    }

    Ok(entry_for(&rel, &target, kind == EntryKind::Dir))
}

/// 把 `rel` 这一项改名为 `new_name`。**只能在同一层里改名**，不能借它移动文件。
///
/// `new_name` 是**单个名字**而不是一条 rel：移动文件需要「目标层可能还没列举过」
/// 这个前提，而树是懒加载的，那个前提不成立。要移动就用 Finder 拖——右键菜单里
/// 「在 Finder 中显示」正是为这种情况留的出口。
///
/// ⚠️ **目标已存在时报错，不覆盖。** POSIX 的 `rename` 会静默替换掉同名文件，
/// 那是这个函数能造成的唯一不可逆损失，所以存在性检查是显式的一步。
pub fn rename_entry(root: &Path, rel: &str, new_name: &str) -> Result<DirEntry, TreeError> {
    let (from, from_rel) = resolve(root, rel)?;
    if from_rel.is_empty() {
        // root 没有父层，改它的名等于把它从它自己的父目录里挪走
        return Err(TreeError::BadName { name: String::new() });
    }
    check_name(new_name)?;
    if !exists(&from) {
        return Err(TreeError::NotFound { path: from.display().to_string() });
    }

    let (parent_rel, old_name) = match from_rel.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => ("", from_rel.as_str()),
    };
    if old_name == new_name {
        // 名字没变：不碰磁盘。让 `rename` 自己去跑一趟的话，在只读卷上会得到一个
        // 莫名其妙的 io 错误，而用户其实什么也没要求
        return Ok(entry_for(&from_rel, &from, from.is_dir()));
    }

    let to_rel = if parent_rel.is_empty() { new_name.to_owned() } else { format!("{parent_rel}/{new_name}") };
    let (to, to_rel) = resolve(root, &to_rel)?;
    // `same_file` 那一支不是多余的：**只改大小写**（`Foo` → `foo`）在 macOS 默认卷上
    // 指的是同一个文件，`exists(&to)` 必然为真，而这恰恰是用户想做的事。
    // 换成「名字只差大小写就跳过检查」在区分大小写的卷上会踩空——那里 `foo` 可能是
    // 另一个真实存在的文件，跳过检查就等于让 `rename` 把它覆盖掉。
    // 比 inode 才是两种卷上都对的那条判据
    if exists(&to) && !same_file(&from, &to) {
        return Err(TreeError::AlreadyExists { path: to.display().to_string() });
    }

    std::fs::rename(&from, &to).map_err(|e| missing_or_io(e, &from))?;
    // 改名之后 `to.is_dir()` 要重新问一次：改名不改类型，但这里手上的 `from` 已经
    // 不存在了，而 `is_dir` 跟着符号链接走的那条语义（见 `tree::entry_is_dir`）
    // 对新路径同样成立
    Ok(entry_for(&to_rel, &to, to.is_dir()))
}

/// 解析出**确实存在**的那条绝对路径，给移到废纸篓 / 在 Finder 中显示 / 复制路径用。
///
/// 与 `create_entry` / `rename_entry` 相反，这里**允许 `rel` 为空**：空 rel 说的就是
/// root 本身，而「在 Finder 中显示项目根目录」是右键菜单里最常用的一项。
///
/// 返回 `PathBuf` 而不是 `DirEntry`：三个调用方要的都是那条绝对路径，
/// 而 `is_dir` 之类它们本来就知道（右键的那一行就在树上摆着）。
pub fn resolve_existing(root: &Path, rel: &str) -> Result<PathBuf, TreeError> {
    let (target, _) = resolve(root, rel)?;
    if !exists(&target) {
        return Err(TreeError::NotFound { path: target.display().to_string() });
    }
    Ok(target)
}

/// 一个「名字」必须恰好是**一个**普通路径组件。
///
/// 一条 match 挡住四种情况：含 `/`（两个以上组件）、绝对路径（`RootDir`）、
/// `.` / `..`（`CurDir` / `ParentDir`）、空字符串（零个组件）。
/// 写成「逐条 if 检查非法字符」会漏掉 `..` 这种「字符都合法、含义不合法」的东西——
/// 而漏掉它的后果是改名变成了往上一层移动。
fn check_name(name: &str) -> Result<(), TreeError> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(TreeError::BadName { name: name.to_owned() }),
    }
}

/// `from` 与 `to` 是不是同一个文件（同一个卷上的同一个 inode）。
///
/// 用 `symlink_metadata` 而不是 `metadata`：改名改的是**目录项**，一个指向目录的
/// 符号链接被改大小写时，`metadata` 跟着链接走到那头，拿到的 inode 与「这个链接本身」
/// 无关——两个指向同一处的不同链接会被判成「同一个文件」，于是覆盖检查被跳过。
/// 副作用是断链也能正常比（`symlink_metadata` stat 的是链接自己，不跟着走），
/// 这正是想要的：把一个断链改成另一个大小写，改的还是那一条目录项。
#[cfg(unix)]
fn same_file(from: &Path, to: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::symlink_metadata(from), std::fs::symlink_metadata(to)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        // 任一侧压根不存在就判成「不是同一个文件」，让存在性检查照常报错。
        // 生产路径上走不到这一支（`rename_entry` 两侧都先过了 `exists`），
        // 留着只是保守：判错的后果是「多报一次已存在」，而不是「覆盖掉一个文件」
        _ => false,
    }
}

/// 非 unix 上没有 inode 可比。退化成路径相等，也就是**放弃**「只改大小写」这个特例：
/// 那种情况下用户会看到一句「已存在」，需要自己先改成别的名字再改回来。
///
/// ⚠️ 这是一笔明写的债，不是被忽略的：M2 的目标平台是 macOS 优先（PLAN §1.2），
/// Windows 侧的 `FILE_ID_INFO` 要等真的上那个平台时再补。
#[cfg(not(unix))]
fn same_file(from: &Path, to: &Path) -> bool {
    from == to
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{list_dir, DirListing};
    use std::fs;

    fn names(listing: &DirListing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    /// 一棵有内容的树：新建/改名/存在性检查都要在有邻居的情况下测，
    /// 空目录里什么都撞不上，恰好漏掉这一层最该挡的东西
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "旧的 a").unwrap();
        fs::write(root.join("README.md"), "# 标题").unwrap();
        dir
    }

    // ── 新建 ────────────────────────────────────────────────────────────────

    #[test]
    fn 新建文件与文件夹都返回可以直接回传的条目() {
        let dir = fixture();
        let root = dir.path();

        let file = create_entry(root, "src/b.ts", EntryKind::File).unwrap();
        assert_eq!(file.name, "b.ts");
        assert_eq!(file.rel, "src/b.ts");
        assert_eq!(Path::new(&file.path), root.join("src/b.ts"));
        assert!(!file.is_dir);

        let folder = create_entry(root, "src/assets", EntryKind::Dir).unwrap();
        assert_eq!(folder.rel, "src/assets");
        assert!(folder.is_dir);

        // 返回的 rel 必须能直接喂回去——这是「前端不做路径拼接」那条约定的另一半
        assert!(list_dir(root, &folder.rel).unwrap().entries.is_empty());
        assert_eq!(names(&list_dir(root, "src").unwrap()), vec!["assets", "a.ts", "b.ts"]);
        assert_eq!(fs::read_to_string(root.join("src/b.ts")).unwrap(), "");
    }

    /// 这一条是「新建不覆盖」的钉子。
    ///
    /// 光断言报错还不够：`File::create` 的语义就是**截断**，如果存在性检查漏了，
    /// 错误照样会报（比如权限），而文件已经空了。所以必须连内容一起断言。
    #[test]
    fn 目标已存在时报_already_exists_并且原内容一个字节都没动() {
        let dir = fixture();
        let root = dir.path();

        assert_eq!(
            create_entry(root, "README.md", EntryKind::File).unwrap_err(),
            TreeError::AlreadyExists { path: root.join("README.md").display().to_string() }
        );
        assert_eq!(
            create_entry(root, "src", EntryKind::Dir).unwrap_err(),
            TreeError::AlreadyExists { path: root.join("src").display().to_string() }
        );
        // 文件没被截断，文件夹里的东西也没被动
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "# 标题");
        assert_eq!(names(&list_dir(root, "src").unwrap()), vec!["a.ts"]);
    }

    /// 断链的符号链接**算存在**。
    ///
    /// `Path::exists()` 会跟着链接走，于是「这里有一个指向不存在处的链接」被判成
    /// 「这里什么都没有」，新建就成功了——磁盘上从此有两条同名条目，
    /// 而树里只显示一行（`read_dir` 会给出其中一个，具体哪个取决于文件系统）。
    #[test]
    #[cfg(unix)]
    fn 断链的符号链接算已存在() {
        let dir = fixture();
        let root = dir.path();
        std::os::unix::fs::symlink(root.join("早就没了"), root.join("src/broken")).unwrap();
        assert!(!root.join("src/broken").exists(), "Path::exists 跟着链接走，这条前提不成立的话本测试就没意义");

        let err = create_entry(root, "src/broken", EntryKind::File).unwrap_err();
        assert_eq!(err, TreeError::AlreadyExists { path: root.join("src/broken").display().to_string() });
    }

    /// 中间层不存在时**不顺手创建**。
    ///
    /// `create_dir_all` 会把「用户在名字框里打了一整条路径」这个输入错误，
    /// 变成磁盘上几个没人要的目录，而界面上只显示「新建成功」。
    #[test]
    fn 新建不会顺手创建中间层() {
        let dir = fixture();
        let root = dir.path();

        assert!(matches!(
            create_entry(root, "nope/deep/c.txt", EntryKind::File).unwrap_err(),
            TreeError::NotFound { .. }
        ));
        assert!(matches!(create_entry(root, "nope/deep", EntryKind::Dir).unwrap_err(), TreeError::NotFound { .. }));
        // `nope` 压根没被建出来
        assert!(!root.join("nope").exists());
        assert_eq!(names(&list_dir(root, "").unwrap()), vec!["src", "README.md"]);
    }

    #[test]
    fn 在_root_本身上新建被拒() {
        let dir = fixture();
        assert_eq!(
            create_entry(dir.path(), "", EntryKind::File).unwrap_err(),
            TreeError::BadName { name: String::new() }
        );
        // `.` 归一化之后也是空 rel，同样要挡住
        assert_eq!(
            create_entry(dir.path(), ".", EntryKind::Dir).unwrap_err(),
            TreeError::BadName { name: String::new() }
        );
    }

    /// 写操作**不削弱** M2-A 那条结构性保证。
    ///
    /// 这一条比新建/改名本身更重要：读操作逃出 root 顶多泄露信息，
    /// 写操作逃出 root 就是在用户没授权的目录里建东西、改名字。
    #[test]
    fn 越界的_rel_在写操作上一律被拒() {
        let dir = fixture();
        let root = dir.path();
        for rel in ["..", "../x.txt", "src/..", "src/../../y.txt", "/tmp"] {
            assert_eq!(
                create_entry(root, rel, EntryKind::File).unwrap_err(),
                TreeError::Escape { rel: rel.to_owned() },
                "create {rel:?}"
            );
            assert_eq!(
                rename_entry(root, rel, "z.txt").unwrap_err(),
                // `..` 先被 resolve 拒掉，所以是 Escape 而不是 BadName——
                // 顺序很要紧：先验名字的话，「逃出去 + 名字合法」会被说成一次输入错误
                TreeError::Escape { rel: rel.to_owned() },
                "rename {rel:?}"
            );
            assert!(matches!(resolve_existing(root, rel).unwrap_err(), TreeError::Escape { .. }), "resolve {rel:?}");
        }
        assert!(!root.parent().unwrap().join("x.txt").exists());
    }

    #[test]
    fn 中文名与空格在新建里完好() {
        let dir = fixture();
        let root = dir.path();
        let made = create_entry(root, "我的 文件.md", EntryKind::File).unwrap();
        assert_eq!(made.name, "我的 文件.md");
        assert_eq!(made.rel, "我的 文件.md");
        assert_eq!(Path::new(&made.path), root.join("我的 文件.md"));
        assert!(root.join("我的 文件.md").exists());
    }

    // ── 重命名 ──────────────────────────────────────────────────────────────

    #[test]
    fn 重命名之后旧路径没了新路径在_内容跟着走() {
        let dir = fixture();
        let root = dir.path();

        let renamed = rename_entry(root, "src/a.ts", "b.ts").unwrap();
        assert_eq!(renamed.name, "b.ts");
        assert_eq!(renamed.rel, "src/b.ts");
        assert_eq!(Path::new(&renamed.path), root.join("src/b.ts"));
        assert!(!renamed.is_dir);

        assert!(!root.join("src/a.ts").exists());
        // 内容跟着目录项走，不是「新建一个空的再把旧的删掉」
        assert_eq!(fs::read_to_string(root.join("src/b.ts")).unwrap(), "旧的 a");
        assert_eq!(names(&list_dir(root, "src").unwrap()), vec!["b.ts"]);
    }

    /// 改名一个**摊开着的目录**：子树整个跟着走，一个条目都不少。
    ///
    /// 前端在改名之后会扔掉旧 rel 的缓存并重读父层，但它必须能重读到一个完整的子树，
    /// 否则用户看到的是「改个名把文件夹里的东西弄丢了」。
    #[test]
    fn 重命名一个目录之后它下面的东西还在() {
        let dir = fixture();
        let root = dir.path();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::write(root.join("src/deep/leaf.txt"), "叶子").unwrap();

        let renamed = rename_entry(root, "src", "lib").unwrap();
        assert_eq!(renamed.rel, "lib");
        assert!(renamed.is_dir, "改名不改类型");

        assert_eq!(names(&list_dir(root, &renamed.rel).unwrap()), vec!["deep", "a.ts"]);
        assert_eq!(names(&list_dir(root, "lib/deep").unwrap()), vec!["leaf.txt"]);
        assert_eq!(fs::read_to_string(root.join("lib/deep/leaf.txt")).unwrap(), "叶子");
        assert!(!root.join("src").exists());
    }

    /// 这一条是「重命名不覆盖」的钉子，与新建那条同一条理由。
    ///
    /// POSIX 的 `rename` **会**静默替换同名文件，所以这个检查一旦漏掉，
    /// 后果是用户的一个文件消失了，而且没有任何提示、没有任何地方能找回来
    /// （连废纸篓都没有——`rename` 不走废纸篓）。
    #[test]
    fn 重命名到已存在的名字被拒_两个文件都原样不动() {
        let dir = fixture();
        let root = dir.path();
        fs::write(root.join("src/b.ts"), "这是 b").unwrap();

        let err = rename_entry(root, "src/a.ts", "b.ts").unwrap_err();
        assert_eq!(err, TreeError::AlreadyExists { path: root.join("src/b.ts").display().to_string() });
        assert_eq!(fs::read_to_string(root.join("src/a.ts")).unwrap(), "旧的 a");
        assert_eq!(fs::read_to_string(root.join("src/b.ts")).unwrap(), "这是 b");
        assert_eq!(names(&list_dir(root, "src").unwrap()), vec!["a.ts", "b.ts"]);
    }

    /// **只改大小写**在 macOS 默认卷上是同一个文件，必须成功。
    ///
    /// 挡掉它的失败方式很难看：用户把 `readme.md` 改成 `README.md`，
    /// 界面说「README.md 已经存在」——而那个「已经存在的」正是他自己刚点的那一行。
    #[test]
    fn 只改大小写的重命名是改名不是冲突() {
        let dir = fixture();
        let root = dir.path();

        let renamed = rename_entry(root, "README.md", "readme.md").unwrap();
        assert_eq!(renamed.rel, "readme.md");
        assert_eq!(fs::read_to_string(root.join("readme.md")).unwrap(), "# 标题");
        // 仍然只有一个文件
        assert_eq!(names(&list_dir(root, "").unwrap()), vec!["src", "readme.md"]);
    }

    /// 名字没变：不碰磁盘，直接返回原条目。
    ///
    /// 用户在输入框里没改任何东西就按了确定，这在右键重命名里非常常见
    /// （点开一看名字没问题就关掉）。让它跑一趟 `rename` 的话，在只读卷上
    /// 会得到一个 io 错误，而用户其实什么也没要求。
    #[test]
    fn 名字没变时什么也不做() {
        let dir = fixture();
        let root = dir.path();
        let before = fs::metadata(root.join("src/a.ts")).unwrap().modified().unwrap();

        let same = rename_entry(root, "src/a.ts", "a.ts").unwrap();
        assert_eq!(same.rel, "src/a.ts");
        assert!(!same.is_dir);
        assert_eq!(fs::metadata(root.join("src/a.ts")).unwrap().modified().unwrap(), before);

        let dir_row = rename_entry(root, "src", "src").unwrap();
        assert!(dir_row.is_dir, "目录那一支要报出 is_dir=true，前端靠它决定要不要保留摊开状态");
    }

    /// 一个「名字」不是一个 rel：带斜杠就是往别的层移动，而那需要目标层已被列举过。
    #[test]
    fn 新名字里带斜杠被拒_文件没有移动() {
        let dir = fixture();
        let root = dir.path();
        fs::create_dir(root.join("docs")).unwrap();

        for name in ["docs/x.md", "/x.md", "a/b"] {
            assert_eq!(
                rename_entry(root, "src/a.ts", name).unwrap_err(),
                TreeError::BadName { name: name.to_owned() },
                "{name:?}"
            );
        }
        assert!(!root.join("docs/x.md").exists());
        assert_eq!(fs::read_to_string(root.join("src/a.ts")).unwrap(), "旧的 a");
    }

    /// `.` 与 `..` 的字符都合法，含义不合法：`..` 会让「改名」变成「往上一层移动」，
    /// 而 `.` 归一化之后是空名字，等于把这一项改成它自己的父目录。
    /// 「逐条 if 检查非法字符」挡不住这两个，所以 `check_name` 数的是路径组件。
    #[test]
    fn 空名字与点被拒() {
        let dir = fixture();
        let root = dir.path();
        for name in ["", ".", "..", "./"] {
            assert_eq!(
                rename_entry(root, "src/a.ts", name).unwrap_err(),
                TreeError::BadName { name: name.to_owned() },
                "{name:?}"
            );
        }
        assert_eq!(fs::read_to_string(root.join("src/a.ts")).unwrap(), "旧的 a");
    }

    #[test]
    fn 重命名_root_本身被拒() {
        let dir = fixture();
        assert_eq!(rename_entry(dir.path(), "", "别的名字").unwrap_err(), TreeError::BadName { name: String::new() });
        // root 还在原地
        assert!(dir.path().exists());
    }

    #[test]
    fn 改名一个不存在的东西报_not_found() {
        let dir = fixture();
        let root = dir.path();
        let missing = root.join("src/nope.ts").display().to_string();
        assert_eq!(rename_entry(root, "src/nope.ts", "x.ts").unwrap_err(), TreeError::NotFound { path: missing });
    }

    #[test]
    fn 中文名与空格在重命名里完好() {
        let dir = fixture();
        let root = dir.path();
        let renamed = rename_entry(root, "src/a.ts", "我的 文件.ts").unwrap();
        assert_eq!(renamed.name, "我的 文件.ts");
        assert_eq!(renamed.rel, "src/我的 文件.ts");
        assert_eq!(Path::new(&renamed.path), root.join("src/我的 文件.ts"));
        assert_eq!(fs::read_to_string(root.join("src/我的 文件.ts")).unwrap(), "旧的 a");
    }

    // ── resolve_existing ────────────────────────────────────────────────────

    /// 空 rel 说的是 root 本身，而「在 Finder 中显示项目根目录」是最常用的一项。
    ///
    /// 这一条与新建/改名**相反**：那两个传空 rel 没有意义，这一个有。
    #[test]
    fn resolve_existing_接受空_rel_也就是_root_本身() {
        let dir = fixture();
        assert_eq!(resolve_existing(dir.path(), "").unwrap(), dir.path());
        assert_eq!(resolve_existing(dir.path(), ".").unwrap(), dir.path());
        assert_eq!(resolve_existing(dir.path(), "src/a.ts").unwrap(), dir.path().join("src/a.ts"));
        assert_eq!(resolve_existing(dir.path(), "src").unwrap(), dir.path().join("src"));
    }

    #[test]
    fn resolve_existing_对不存在的路径报_not_found() {
        let dir = fixture();
        let missing = dir.path().join("src/nope.ts").display().to_string();
        assert_eq!(resolve_existing(dir.path(), "src/nope.ts").unwrap_err(), TreeError::NotFound { path: missing });
    }

    /// 断链也算「存在」：在 Finder 中显示一个断链是合理的（用户正要看它为什么断了），
    /// 而复制它的路径更是完全无害。
    #[test]
    #[cfg(unix)]
    fn resolve_existing_接受断链的符号链接() {
        let dir = fixture();
        let root = dir.path();
        std::os::unix::fs::symlink(root.join("早就没了"), root.join("src/broken")).unwrap();
        assert_eq!(resolve_existing(root, "src/broken").unwrap(), root.join("src/broken"));
    }

    /// `same_file` 是「只改大小写」那条判据的本体，单独钉一次。
    ///
    /// 必须直接测它而不是只靠 `只改大小写的重命名是改名不是冲突`：那条在
    /// **区分大小写**的卷上走的是另一个分支（`foo` 与 `Foo` 是两个文件，
    /// 存在性检查照常生效），于是同一个测试在两种卷上测的是两件不同的事。
    #[test]
    #[cfg(unix)]
    fn same_file_比的是_inode_不是路径() {
        let dir = fixture();
        let root = dir.path();
        assert!(same_file(&root.join("src/a.ts"), &root.join("src/a.ts")));
        assert!(!same_file(&root.join("src/a.ts"), &root.join("README.md")));
        // 同一个文件的两个硬链接：路径不同，文件相同
        fs::hard_link(root.join("README.md"), root.join("README-hard.md")).unwrap();
        assert!(same_file(&root.join("README.md"), &root.join("README-hard.md")));

        // ⚠️ 两个**不同的**符号链接指向同一处：必须判成「不是同一个文件」。
        // 换成 `metadata`（跟着链接走）这一条就会反过来，于是「把链接 A 改名成
        // 链接 B 的名字」会跳过存在性检查，`rename` 直接把 B 覆盖掉
        std::os::unix::fs::symlink(root.join("README.md"), root.join("link-a")).unwrap();
        std::os::unix::fs::symlink(root.join("README.md"), root.join("link-b")).unwrap();
        assert!(!same_file(&root.join("link-a"), &root.join("link-b")));
        assert!(same_file(&root.join("link-a"), &root.join("link-a")));

        // 断链与自己比仍然是同一个文件：`symlink_metadata` stat 的是链接本身，不跟着走
        std::os::unix::fs::symlink(root.join("早就没了"), root.join("broken")).unwrap();
        assert!(same_file(&root.join("broken"), &root.join("broken")));
        assert!(!same_file(&root.join("broken"), &root.join("README.md")));

        // 不存在的路径落到保守那一支：哪怕两边字符串一样也判「不是同一个」
        assert!(!same_file(&root.join("nope"), &root.join("nope")));
    }

    #[test]
    fn entry_kind_的线上写法是两个小写单词() {
        // 前端发的是 'file' / 'dir'，不是 'File' / 'Dir'，也不是 true / false
        assert_eq!(serde_json::from_str::<EntryKind>(r#""file""#).unwrap(), EntryKind::File);
        assert_eq!(serde_json::from_str::<EntryKind>(r#""dir""#).unwrap(), EntryKind::Dir);
        assert!(serde_json::from_str::<EntryKind>(r#""File""#).is_err());
        assert!(serde_json::from_str::<EntryKind>("true").is_err());
        assert_eq!(serde_json::to_string(&EntryKind::Dir).unwrap(), r#""dir""#);
    }
}
