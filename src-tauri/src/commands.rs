//! Tauri command 适配层（PLAN.md §2.6）。
//!
//! 这一层刻意薄到只有签名转换：真正的实现在框架无关的 `vela-core` 里，
//! 这样单测不需要 `AppHandle`，将来做 CLI 或 headless 工具也能直接复用。
//! **不下沉的例外**是那些「本体就是系统调用」的命令：`close_window`（拆窗口）、
//! `load_session` / `save_session`（解析应用数据目录）、以及 M2-B-5 的
//! `trash_entry` / `reveal_entry` / `copy_entry_path`（废纸篓、`open -R`、`pbcopy`）。
//! 它们没有可以下沉的实现，也没什么可单测的——⚠️ 而 `trash::delete` 还多一条硬理由：
//! 放进 vela-core 就意味着 `cargo test` 会把临时文件真的塞进开发机的废纸篓，
//! 而 CI 的 ubuntu runner 上压根没有废纸篓可用。
//!
//! ## 接受路径的命令，按能力分组（M4-A 之后共十七个）
//!
//! ⚠️ 其中两个**不住在本文件里**：`set_watched` 在 `src/watcher.rs`，
//! `open_large` 在 `src/shard.rs`，理由各写在那儿开头。
//! 它们照样列在下面这张表里：这张表是「谁能碰到磁盘」的账，按文件分家就漏了一笔。
//! （`read_lines` / `close_large` 不在表里——它们收的是一个整数句柄，
//! 而那个句柄只可能来自 `open_large` 的返回值。）
//!
//! | 能力 | 命令 | 参数形状 |
//! |---|---|---|
//! | 读文件内容 | `open_file` | 任意绝对路径 |
//! | 读文件内容（**分片**） | `open_large` | 任意绝对路径 |
//! | 写文件内容 | `save_file` | 任意绝对路径 |
//! | **写图片字节**（粘贴落地） | `store_image` | 文档路径，目录由它推出 |
//! | **枚举**目录 | `list_dir` | `(root, rel)` |
//! | **创建** | `create_entry` | `(root, rel, kind)` |
//! | **改名** | `rename_entry` | `(root, rel, new_name)` |
//! | **删除**（移废纸篓） | `trash_entry` | `(root, rel)` |
//! | 交给系统工具 | `reveal_entry` / `copy_entry_path` | `(root, rel)` |
//! | **全文搜索**（读正文） | `start_search` | `roots` + 两个 glob 列表 |
//! | **全局替换**（写正文） | `start_replace` | 同上，外加一份要跳过的绝对路径清单 |
//! | **建文件索引**（只读名字） | `index_project` | `roots` |
//! | **模糊匹配**（只读名字） | `query_project` | `roots` + needle + 一份最近清单 |
//! | **订阅改动**（只读名字） | `set_watched` | 一组绝对路径（`doc.path()`） |
//! | **读分层配置** | `load_settings` | `roots`（只取第一个根推项目层路径） |
//! | **写分层配置** | `save_settings` | 无路径参数：写 `~/.vela/settings.json`，home 由 Rust 算 |
//!
//! ⚠️ 最后两行（配置）里**只有 `load_settings` 收前端给的路径**（`roots[0]`，dialog 授权过的
//! 目录，与 `index_project` 同一信任面，且只拼写死的 `.vela/settings.json`）；`save_settings`
//! 的落点完全由 Rust 侧 `home_dir()` 算出，前端**无法**影响它写到哪——这正是 `home_dir`
//! 那个 helper 存在的理由，与 `session_path` 同一条安全姿势。
//!
//! 另存为没有自己的命令：它是前端先用 dialog 插件拿到新路径，再调同一个 `save_file`。
//!
//! ⚠️ **M2-F 起，中间那四个（`start_search` / `start_replace` / `index_project` /
//! `query_project`）收的是 `roots: Vec<String>` 而不是一个 `root: String`**——
//! 多根工作区里一次搜索、一次替换、一次 `Cmd+P` 都覆盖**全部**根。信任面没有变宽：
//! 每一个 `root` 仍然只可能来自 dialog 插件（`directory: true`），
//! 而 vela-core 那一侧对每一个根各查一次「是不是绝对路径、存不存在、是不是目录」。
//! 变的是**取舍**：一个根不合法就整次 reject，坏根的路径写在错误里，而不是
//! 「跳过它、搜剩下的」——跳过的话用户看到的是「找不到某个文件」，
//! 而那与「这个文件不存在」在界面上长得一模一样。
//!
//! ⚠️ **前两个与后六个的信任面不是一类东西。** `open_file` / `save_file` 给的是
//! 「读写一个**已知**路径的文件」；`list_dir` 给的是枚举——不知道路径也能一层层翻出来；
//! 而 M2-B-5 这五个给的是**在用户授权的文件夹里创建、改名、删除**。三条缓解：
//!
//! 1. **后六个的第二个参数一律是相对路径**，含 `..` 或本身是绝对路径时 `vela_core::project`
//!    直接拒绝，于是「逃出用户打开的那个文件夹」在结构上不可能，不依赖一次路径检查。
//!    全部解析走 `project::tree::resolve` 这**一个**实现处，没有第二份拼接逻辑；
//! 2. **没有任何递归删除**：删除整个交给 `trash`，最坏结果是「废纸篓里多一个文件夹」，
//!    而不是「一个目录树没了且找不回来」。新建与改名也**都不覆盖**已存在的条目
//!    （`AlreadyExists`），静默覆盖是这一层能造成的唯一不可逆损失，所以被显式挡掉了；
//! 3. `root` 只可能来自 dialog 插件（`directory: true`），前端没有任何输入框能填它。
//!
//! `start_search` 是**第九个**，信任面与 `open_file` 同侧（收的是任意绝对路径），
//! 但只读不写。它的 containment 由三条撑住，全都在 `vela_core::search` 里：
//! ① root 不是绝对路径直接 `BadRoot`（防的是「`.app` 双击启动时 cwd 是 `/`，
//! 于是搜整个磁盘」这个静默错答案）；② `include` / `exclude` 通配**只与 rel 比**，
//! 从不与绝对路径比，所以一条通配无论怎么写都影响不到「走哪些目录」；
//! ③ 遍历 `follow_links(false)`，指向 root 外面的符号链接压根不进去——
//! 这一条同时挡住了 pnpm 的链接农场与「用链接把搜索引出授权范围」。
//!
//! ### ⚠️ `start_replace` 是**第十个，也是第一个会在 `root` 底下写盘的**
//!
//! 前九个里能写文件的只有 `save_file`，而它写的是**用户此刻正看着的那一个**路径，
//! 一次一个、由 ⌘S 触发、编辑器里还有撤销栈。`start_replace` 不一样：
//! 一次调用最多改两万个文件，Vela 没有跨文件撤销，改坏了只能靠 `git checkout`——
//! 而用户搜的很可能正是一个不在 git 里的目录。所以它的 containment 要比上面那三条更硬：
//!
//! 1. **写哪些文件由 `root` 与 `include` / `exclude` 决定，与 `skip` 无关。**
//!    `skip` 只能**减少**集合（`ReplaceRequest` 的文档里写着比对是逐组件的 `Path` 相等），
//!    一个不在遍历集合里的 `skip` 条目不会让任何文件被写。于是「逃出 root」在这条路上
//!    与搜索完全同构，共用 `search::run::walk_files` **同一个函数**——不是两份长得像的代码；
//! 2. **前端拿不到「写任意路径」这个原语。** 命令签名里没有目标路径，只有 `root` +
//!    一个 `SearchQuery`。写哪个文件是遍历的结果，不是入参；
//! 3. **落盘那一层把每个不确定都倒向不写**：二进制（原始字节含 NUL）、有损解码、
//!    编不回原编码，三种各自一个计数器并且**一个字节都不写**。理由与代价写在
//!    `vela-core/src/search/replace.rs` 的模块文档里。写盘一律走 `write_bytes_atomic`
//!    （临时文件 + rename + fsync），所以失败方式是「这个文件没改成」而不是「改了一半」。
//!
//! 唯一一份「前端递进来的绝对路径」是 `skip`，而它的用途恰恰是**保护**用户正在编辑的
//! 那几个脏标签不被落盘盖掉。递错了的后果是「少改一个文件，`skippedOpen` 加一」，
//! 方向是安全的。
//!
//! ### `index_project` / `query_project` 是第十一、十二个，**都不打开任何文件**
//!
//! 信任面与 `start_search` 同侧（收一组任意绝对路径 `roots`）但更窄一档：这两个命令走的是
//! `project::walk::each_file`，那一圈循环只看 `DirEntry::file_type()`，
//! **从头到尾没有一次 `File::open`**。所以它们能泄露的最坏情况是「一棵目录树里有哪些
//! 文件名」，读不到任何一个字节的内容。
//!
//! `query_project` 还收一份 `recent`——那是前端 MRU 里的**绝对路径清单**，
//! ⚠️ 它唯一的用途是**排序加分**：`FileIndex::recent_bonus` 拿它去与索引里已有的 rel
//! 做比对，比不上的（长在 root 外面的、已经不存在的）直接忽略，**不会因为它就去打开
//! 或枚举那个路径**。递一份恶意 `recent` 的最坏结果是「排序乱了」，而不是「多读了一个文件」。
//!
//! 符号链接是**有意放行**的（pnpm 的 `node_modules` 就是符号链接搭的），
//! 理由见 `vela-core/src/project/tree.rs` 的模块文档。⚠️ 注意这句话只适用于**文件树**：
//! 搜索、替换与文件索引恰恰相反（`follow_links(false)`，见 `project::walk`），
//! 见 `vela-core/src/search/mod.rs` 开头那两节。
//!
//! 会话存档那两个命令也写文件，但**路径由 Rust 侧算出来**（`app_data_dir()/session.json`），
//! 前端连传路径的入口都没有。所以它们没有把上面那条信任面扩大一分。
//!
//! ### `set_watched` 是第十三个，**一个字节都不读也不写**
//!
//! 它收一组任意绝对路径，拿去做两件事：订阅它们的**父目录**、把它们记进一张过滤器表。
//! 于是它扩大的是「哪些目录的文件名变动会被推给 webview」，而不是「能读到哪些内容」。
//! 完整论证在 `src/watcher.rs` 开头那一节。
//!
//! ### `open_large` 是第十四个，与 `open_file` **完全同一档**
//!
//! 它收任意绝对路径，并且**真的读内容**——这一点与第十三个（`set_watched`，
//! 一个字节都不读）不一样，所以它不是「信任面又宽了一点」，而是「同一个信任面上
//! 多了一个入口」。三条命令里只有它收路径：`read_lines` 与 `close_large` 收的是
//! 一个整数句柄，而句柄只可能来自 `open_large` 的返回值。
//!
//! ⚠️ 于是「句柄不可猜」在这里**买不到任何东西**：能调 `read_lines(3, …)` 的调用方
//! 本来就能直接 `open_large` 那个路径。论证写在 `src/shard.rs` 开头，
//! 而 M5 开放插件时它要跟着这张表一起重读。
//!
//! ### `store_image` 是第十五个，**收路径但不收「写哪」**
//!
//! 它是第二个会写盘的命令，也是这张表里唯一一个**路径参数不决定写到哪**的：
//! `doc_path` 只用来推出 `<它所在目录>/assets/`，文件名由 Rust 按内容哈希生成。
//! 命令签名里没有目标路径、没有目标目录、也没有文件名——三样都拿不到，
//! 于是「往任意位置写任意名字」这个原语在这一条路上压根不存在。
//!
//! ⚠️ 它也不复用 `save_file`：那一个收的是 dialog 给出的绝对路径，而粘贴图片
//! 没有「让用户选存哪」这一步，没有任何东西兜着。硬把目录名写死，
//! 可写的范围就收敛成「用户已经打开的那个文档旁边」。
//! 完整论证（含 `assets/` 不可配置这条明写的债）在 `vela-core/src/fs/asset.rs` 开头。
//!
//! ⚠️ 信任边界：这十五个命令合起来等于给了 webview 一个「读、写、枚举、创建、改名、
//! 删除、以及**批量改写**本地文件」的原语。这在 Vela 里是可接受的，前提是 webview
//! 只加载第一方打包产物：没有远程内容、没有 `withGlobalTauri`、没有开 remote 域名白名单。
//! 注意 `tauri.conf.json` 目前的 `csp` 仍是 `null`，也就是说这条前提只靠
//! 「我们不加载远程内容」这个约定撑着，没有第二道防线。**如果将来引入任何远程内容或
//! 第三方插件 UI（M5），这十五个命令必须改成只接受「用户显式授权过的路径」**——
//! 具体做法是把 dialog 打开过的 root 记在 Tauri managed state 里，命令只收 `rootId`
//! 而不收路径字符串。⚠️ 而 `start_replace` 是这件事变得**紧迫**的那一个：
//! 在它之前，一次 XSS 最坏能改掉用户正在看的文件；在它之后，最坏能改掉整个文件夹。
//! ⚠️ `store_image` 不改变这个判断：它能写的只有 `assets/pasted-*.{png,jpg,gif,webp,bmp}`
//! 这一种名字，写不进 `.md`、写不进 `.zshrc`，也覆盖不了任何已有文件（撞名就换后缀）。
//! （M2-C 已经有了第一份 managed state，见 [`TaskRegistry`]；M2-E 又加了第二份，
//! 见 [`ProjectIndexCache`]；M2-G 加了第三份，见 `watcher::WatcherState`；
//! M2-H 加了第四份，见 `shard::ShardRegistry`。
//! **四份都不是授权表**——没有一份记着「用户授权过哪些路径」，
//! 它们记的分别是取消标志、索引、当前该盯哪些目录、与当前开着哪几个大文件分片。）

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine as _;
use serde::Serialize;
use tauri::{command, AppHandle, Emitter, Manager, State};
use vela_core::fs::{
    read_text, read_text_as, store_image as store_image_bytes, write_text_atomic, AssetError, Encoding, FileFormat,
    ReadError, StoredImage, TextFile, WriteError, WriteReport, MAX_IMAGE_BYTES,
};
use vela_core::project::{
    self, merge_stats, query_many, DirEntry, DirListing, EntryKind, FileIndex, FileQuery, IndexStats, TreeError,
};
use vela_core::search::{
    apply_roots, preflight_apply_roots, preflight_roots, search_roots, ReplaceProgress, ReplaceRequest, ReplaceSummary,
    SearchBatch, SearchError, SearchQuery, SearchSummary,
};
use vela_core::session::{self as session_store, Session, SessionError, SessionReport, SESSION_FILE_NAME};
use vela_core::settings::{self as settings_store, LoadedSettings, SaveReport, Settings};
use vela_core::keybindings::{self as keybindings_store, UserKeybindings, LoadedKeybindings as LoadedKeybindingsData};

/// 读一个文本文件。
///
/// 声明成 `async fn` 是为了让它在 Tauri 的异步运行时上跑，而不是主线程——
/// 同步 command 会阻塞 UI。函数体本身是阻塞 IO，没有再套 `spawn_blocking`：
/// 上限 4MB 的文件读 + 解码在毫秒量级，而运行时上目前只有这一个来源的活。
///
/// ⚠️ M2-C 的搜索落地之后这句话仍然成立，因为 `start_search` 走的是
/// `spawn_blocking`（见下），它占的是 blocking 池而不是 async worker，
/// 所以并没有给这里添并发负载。M2-G 的文件监听同样走 blocking 池
/// （理由见 `src/watcher.rs` 里 `WatcherState` 的文档），也没有给这里添负载。
///
/// `encoding` 为 `None` 时走探测，`Some` 时**跳过探测**用它解——这是「以某编码重新
/// 打开」。必须有这条路：探测会静默地错，一份 GBK 文件如果字节恰好是合法 UTF-8，
/// 会被判成 utf8 且 `lossy = false`，正文是乱码而 UI 没有任何依据去警告用户。
#[command]
pub async fn open_file(path: String, encoding: Option<Encoding>) -> Result<TextFile, ReadError> {
    match encoding {
        Some(encoding) => read_text_as(Path::new(&path), encoding),
        None => read_text(Path::new(&path)),
    }
}

/// 原子写入一个文本文件，并把编码/行尾还原成 `format` 记录的原样。
///
/// `format` 由前端原样回传——它是 `open_file` 发过去的那一团，前端不解释其内容。
/// 这样「打开 → 不改一个字 → 保存」能产出字节完全相同的文件（见 `vela_core::fs`）。
#[command]
pub async fn save_file(path: String, text: String, format: FileFormat) -> Result<WriteReport, WriteError> {
    write_text_atomic(Path::new(&path), &text, format)
}

/// 把剪贴板里的一张图片落到 `<doc_path 所在目录>/assets/` 里（M3-A-7）。
///
/// 🔴 **签名里没有目标路径、没有目录名、也没有文件名。** `doc_path` 只用来推出落地目录，
/// 名字由 `vela_core::fs::store_image` 按内容哈希生成。理由写在上面模块文档
/// 「`store_image` 是第十五个」那一节，以及 `vela-core/src/fs/asset.rs` 开头。
///
/// ## ⚠️ 图片走 base64 字符串，不走数字数组
///
/// Tauri 的 invoke 载荷是 JSON。一张 1 MB 的截图若编码成 `[137,80,78,…]`，
/// 就是 100 万个 JSON number token、约 4 MB 的文本，两头各解析一次要几百毫秒；
/// 编成一个 base64 字符串只有 1 个 token、约 1.4 MB，几毫秒就过去了。
/// 这不是「差不多」的差别，而是「粘完界面卡一下」与「粘完立刻出现链接」的差别。
///
/// 解码只认**标准字母表 + padding**（`general_purpose::STANDARD`），正是前端 `btoa`
/// 的产物。刻意不放宽成「URL-safe 也收、没 padding 也收」：多认一种写法就多一种
/// 「两边以为在说同一件事、其实在说两件事」的可能，而前端只有一个编码器。
#[command]
pub async fn store_image(doc_path: String, data_base64: String) -> Result<StoredImage, AssetError> {
    // 先按长度挡一道再解码：`store_image_bytes` 的上限管的是**解出来**的字节数，
    // 而解码本身要先把整份数据摊开。用户在 Finder 里复制一个 2 GB 的文件再粘进来
    // 是**会发生**的，那时先吃掉 1.5 GB 内存、再被上限拒绝，界面已经卡过了。
    // 4/3 是 base64 的膨胀率，多留 8 字节给 padding——这一道只防「离谱」，
    // 精确判定在下面那一个里。报出去的 bytes 是按膨胀率估的，
    // 但「已经超限」这件事是确定的，估个近似值比报 0 有用
    const MAX_B64_LEN: usize = MAX_IMAGE_BYTES / 3 * 4 + 8;
    if data_base64.len() > MAX_B64_LEN {
        return Err(AssetError::TooBig { bytes: data_base64.len() as u64 * 3 / 4, limit: MAX_IMAGE_BYTES as u64 });
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| AssetError::BadData { reason: e.to_string() })?;
    // 与 `save_file` 同一档：阻塞 IO 直接跑在异步运行时上。
    // 一次哈希 + 一次原子写入，图片的现实中位数在几百 KB，毫秒量级
    store_image_bytes(Path::new(&doc_path), &bytes)
}

/// 列出 `root` 下 `rel` 这一层的目录内容（**只有一层**，PLAN.md §3.4 M2-A）。
///
/// `root` 来自 dialog 插件的 `directory: true`，前端没有任何输入框能填它；`rel` 来自
/// 上一次列举返回的 `DirEntry::rel`，空字符串表示 root 本身。
///
/// 同样声明成 `async fn`：一次 `read_dir` 在网络卷或外接机械盘上可以到秒级，
/// 而同步 command 跑在主线程上，会把整个 UI 卡住。
#[command]
pub async fn list_dir(root: String, rel: String) -> Result<DirListing, TreeError> {
    project::list_dir(Path::new(&root), &rel)
}

/// 在 `root` 下新建一个文件或文件夹（M2-B-5）。
///
/// `rel` 是**相对 root 的完整路径**（父层 rel + `/` + 名字）——这是全前端唯一一处
/// 路径字符串运算，而它拼的是 `rel` 不是绝对路径：拼错了最坏也就是 `Escape` 或
/// `NotFound`，写不到 root 外面去。已存在时报 `AlreadyExists`，**不覆盖、也不自动加
/// ` (1)` 后缀**（自动改名会让用户以为建好了，实际编辑的是另一个文件）。
#[command]
pub async fn create_entry(root: String, rel: String, kind: EntryKind) -> Result<DirEntry, TreeError> {
    project::create_entry(Path::new(&root), &rel, kind)
}

/// 把 `rel` 这一项改名（M2-B-5）。**只能同层改名**，不能借它移动文件——
/// 移动需要「目标层已经被列举过」这个前提，而树是懒加载的，那个前提不成立。
/// 要移动就用「在 Finder 中显示」然后拖。
#[command]
pub async fn rename_entry(root: String, rel: String, new_name: String) -> Result<DirEntry, TreeError> {
    project::rename_entry(Path::new(&root), &rel, &new_name)
}

/// 移到废纸篓（M2-B-5）。**不是 `remove_file`，也不是递归删除。**
///
/// 用户在「真删 / 移到废纸篓」里选的是后者，理由不是怕误删那么简单：开发者删掉的
/// 常常是 `git` 管不着的东西——`.env`、本地 build 产物、没进版本库的草稿。
/// 真删的话一次手滑就没有第二次机会。
///
/// ⚠️ 前端的提示语必须是「已移到废纸篓」而不是「已删除」：说「已删除」，用户会去找
/// 那个不存在的撤销，或者反过来以为文件真没了。
#[command]
pub async fn trash_entry(root: String, rel: String) -> Result<(), TreeError> {
    let path = project::resolve_existing(Path::new(&root), &rel)?;
    trash::delete(&path).map_err(|e| TreeError::Io {
        // 不是 io::ErrorKind，但前端只把 reason 当日志用，展示的是 message
        reason: "Trash".to_owned(),
        message: format!("没能把 {} 移到废纸篓：{e}", path.display()),
    })
}

/// 在 Finder 中显示并选中这一项（M2-B-5，`open -R`）。
#[command]
pub async fn reveal_entry(root: String, rel: String) -> Result<(), TreeError> {
    let path = project::resolve_existing(Path::new(&root), &rel)?;
    // `-R` = reveal：选中这一项，而不是打开它（对目录来说「打开」是进到里面去）
    run_macos_tool("open", &["-R"], Some(&path), None, "在 Finder 中显示")
}

/// 把这一项的绝对路径放进系统剪贴板（M2-B-5，`pbcopy`）。
///
/// 走 Rust 而不是前端的 `navigator.clipboard.writeText`：后者要求安全上下文，
/// 而 Tauri 在 macOS 上用的是 `tauri://localhost` 这个自定义协议，能不能算安全上下文
/// 取决于 WKWebView 的版本——一条「有时能用有时不能」的剪贴板比一条只能用的更难查。
#[command]
pub async fn copy_entry_path(root: String, rel: String) -> Result<(), TreeError> {
    let path = project::resolve_existing(Path::new(&root), &rel)?;
    // 路径走 stdin，不走参数：`pbcopy` 会把参数当成要读的文件名，而我们要的是**内容**
    run_macos_tool("pbcopy", &[], None, Some(&path.display().to_string()), "复制路径")
}

/// 跑一个 macOS 自带的小工具，只看退出码。
///
/// ⚠️ **参数一律走 `arg()`，从不拼进 `sh -c`。** 文件名里有单引号、空格、`$`、反引号
/// 都是完全正常的（`it's a file.txt`），而这些名字全部来自用户自己的磁盘——
/// 拼进 shell 就是一条货真价实的命令注入。`Command` 直接 `execvp`，没有 shell 参与。
///
/// `subject` 是要传给工具的**路径**参数（`open -R` 用它），`stdin_text` 是要喂给
/// 标准输入的内容（`pbcopy` 用它）。两者都是 `Option`：`open` 不需要 stdin，
/// `pbcopy` 不需要路径参数。
#[cfg(target_os = "macos")]
fn run_macos_tool(
    program: &str,
    args: &[&str],
    subject: Option<&Path>,
    stdin_text: Option<&str>,
    what: &str,
) -> Result<(), TreeError> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let failed = |message: String| TreeError::Io { reason: "ToolFailed".to_owned(), message };

    let mut command = Command::new(program);
    command.args(args);
    if let Some(path) = subject {
        command.arg(path);
    }
    if stdin_text.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|e| failed(format!("{what}失败：起不动 {program}（{e}）")))?;

    // ⚠️ 写完必须**关掉** stdin 再去 `wait()`。让那个 `&mut` 借用离开作用域是不够的：
    // `child.stdin` 这个句柄还活着，管道写端就没关，`pbcopy` 一直等 EOF，而我们在等它
    // 退出——一个死锁，表现是「点了复制路径之后整个界面卡住」。置成 `None` 才会 drop 句柄
    if let Some(text) = stdin_text {
        {
            let stdin =
                child.stdin.as_mut().ok_or_else(|| failed(format!("{what}失败：拿不到 {program} 的标准输入")))?;
            stdin.write_all(text.as_bytes()).map_err(|e| failed(format!("{what}失败：写不进 {program}（{e}）")))?;
        }
        child.stdin = None;
    }

    let status = child.wait().map_err(|e| failed(format!("{what}失败：等不到 {program} 退出（{e}）")))?;
    if !status.success() {
        return Err(failed(format!(
            "{what}失败：{program} 退出码 {}",
            status.code().map_or_else(|| "未知".to_owned(), |c| c.to_string())
        )));
    }
    Ok(())
}

/// 非 macOS：这两条能力**明写地不可用**，而不是悄悄退化成别的行为。
///
/// ⚠️ 不要「找等价命令」填进来：`xdg-open` / `explorer` 的选中语义与 `open -R` 不同，
/// 直接换会把「显示并选中」降级成「打开目录」，而那种降级是不报错的。
/// M2 的目标平台是 macOS 优先（PLAN §1.2），这笔债是明写的。
#[cfg(not(target_os = "macos"))]
fn run_macos_tool(
    _program: &str,
    _args: &[&str],
    _subject: Option<&Path>,
    _stdin_text: Option<&str>,
    what: &str,
) -> Result<(), TreeError> {
    Err(TreeError::Io { reason: "Unsupported".to_owned(), message: format!("{what}目前只支持 macOS") })
}

/// 关窗握手的回执：前端说「可以关了」之后调这个。
///
/// 用 `destroy()` 而不是 `close()`——`close()` 会再触发一次 `CloseRequested`，
/// `lib.rs` 又会 prevent + 发事件，变成「问用户 → 用户同意 → 再问一遍」的死循环。
/// `destroy()` 直接拆窗口，随后 Tauri 以 `ExitRequested { code: None }` 退场，
/// 那一种 `lib.rs` 是放行的。
///
/// 这是本层唯一需要 `Window` 的命令；需要 `AppHandle` 的还有下面两个会话命令。
#[command]
pub fn close_window(window: tauri::Window) {
    let _ = window.destroy();
}

/// 会话文件的位置。
///
/// ⚠️ **只能由这里算出来。** 一旦让它变成命令参数，前端就多了一个「写任意路径」的
/// 入口——而 `save_session` 写的内容里有用户未保存的草稿，等于把任意路径写入原语
/// 从 2 个变成 3 个，文件头那条信任边界也就白写了。
fn session_path(app: &AppHandle) -> Result<PathBuf, SessionError> {
    let dir = app.path().app_data_dir().map_err(|e| SessionError::Io {
        // 不是 io::ErrorKind，但前端只把 reason 当日志用，展示的是 message
        reason: "AppDataDir".to_owned(),
        message: format!("拿不到应用数据目录：{e}"),
    })?;
    Ok(dir.join(SESSION_FILE_NAME))
}

/// 读回上次的会话。
///
/// `Ok(None)` = 还没有存档（第一次启动），前端静默地开一个新文档就行；
/// `Err` = 存档存在但读不回来，前端要说一句「上次的会话没能读回来」再照常启动。
/// 两者在 UI 上是完全不同的两件事，所以没有合并成一个 `Option`。
#[command]
pub async fn load_session(app: AppHandle) -> Result<Option<Session>, SessionError> {
    let path = session_path(&app)?;
    session_store::load_session(&path)
}

/// 存下当前会话。
///
/// `dropped_drafts > 0` 表示有草稿因为超过 4MiB 的 IPC 预算被丢掉了（PLAN §2.6 修正 1），
/// 前端**必须**提示用户——静默丢掉未保存的内容比一开始就不存更糟。
#[command]
pub async fn save_session(app: AppHandle, session: Session) -> Result<SessionReport, SessionError> {
    let path = session_path(&app)?;
    session_store::save_session(&path, session)
}

/// 用户主目录（`~`）。配置的用户全局层 `~/.vela/settings.json` 从这里推出。
///
/// ⚠️ **只能由这里算出来**，与 [`session_path`] 同一条安全姿势：一旦让前端传 `home`，
/// `save_settings` 就成了「往任意目录写一份 `.vela/settings.json`」的原语——而配置是
/// 启动即读、内容会灌进 UI 信号的东西。拿不到主目录时映射成 [`WriteError::Io`]，
/// 前端当日志展示（reason 只是标签，用户看的是 message）。
fn home_dir(app: &AppHandle) -> Result<PathBuf, WriteError> {
    app.path()
        .home_dir()
        .map_err(|e| WriteError::Io {
            reason: "HomeDir".to_owned(), message: format!("拿不到用户主目录：{e}")
        })
}

/// 读回合并好的分层配置（内置默认 → 用户全局 → 项目级）。
///
/// `roots` 是当前工作区的根清单，**只取第一个**推项目层路径（多根裁定见 PLAN §3.6
/// 「M4-A 实施修正」）；空清单 = 没打开文件夹，项目层为 `Absent`。
///
/// ⚠️ 本体 [`settings_store::load`] **不失败**：任何一层坏掉都退化成默认值并记进账单，
/// 配置永远不该拦下启动。这里唯一的 `Err` 来自算不出主目录——那是环境问题，不是配置问题。
#[command]
pub async fn load_settings(app: AppHandle, roots: Vec<String>) -> Result<LoadedSettings, WriteError> {
    let home = home_dir(&app)?;
    // 只认第一个根：`roots` 来自 dialog 授权过的目录（与 index_project 同一信任面），
    // 相对部分 `.vela/settings.json` 是写死的常量，前端没有输入框能改它
    let project_root = roots.first().map(Path::new);
    Ok(settings_store::load(&home, project_root))
}

/// 把配置写进**用户全局层**（`~/.vela/settings.json`），原子。
///
/// 🔴 v1 只写用户全局层：三个键都是偏好类、只认全局，没有需要落到项目层的键
/// （理由见 [`settings_store::save`] 的文档）。`settings` 是前端把三个信号拼成的完整配置。
#[command]
pub async fn save_settings(app: AppHandle, settings: Settings) -> Result<SaveReport, WriteError> {
    let home = home_dir(&app)?;
    settings_store::save(&home, &settings)
}

// ─── M4-E 快捷键配置 ──────────────────────────────────────────────────────

/// 读取用户自定义快捷键配置（`~/.vela/keybindings.json`）。
///
/// 文件不存在或解析失败时返回空配置，不算错误。前端据此显示「无自定义快捷键」。
/// 路径由 Rust 侧从 `home_dir()` 算出，前端无法影响落点——与 `save_settings` 同一条安全姿势。
#[command]
pub async fn load_keybindings(app: AppHandle) -> Result<LoadedKeybindingsData, WriteError> {
    let home = home_dir(&app)?;
    Ok(keybindings_store::load(&home))
}

/// 把用户自定义快捷键原子写入 `~/.vela/keybindings.json`。
///
/// ⚠️ **不校验快捷键串**：这只是个不透明 JSON 对象，前端负责解析与冲突检测。
/// Rust 侧只负责读写文件，像对待 settings 一样把它当成「前端定义的结构」。
#[command]
pub async fn save_keybindings(
    app: AppHandle,
    keybindings: UserKeybindings,
) -> Result<serde_json::Value, WriteError> {
    let home = home_dir(&app)?;
    let report = keybindings_store::save(&home, &keybindings)?;
    // 返回一个通用的成功响应
    Ok(serde_json::json!({ "success": report.success }))
}

// ─── M2-C 全文搜索 / M2-D 全局替换：event 流 + 唯一一份 managed state ────────
//
// PLAN §2.6 约束 3：长任务一律返回 `taskId`，通过 event 推进度，支持前端取消。
// 搜索是第一个真的撞上这条的：实测十万个文件要 6.9s（有命中）到 7.4s（无命中），
// 而一次性回传上万条命中还会撞约束 1 的 4MB payload 上限。
//
// ⚠️ 所以 `start_search` / `start_replace` **都不能**声明成「async 然后 await 到跑完
// 再返回 summary」：那样前端要等结束才拿到 taskId，而拿到 taskId 才能取消——
// 等于取消了个寂寞。替换那一侧这件事更要命：取消是用户在「已经改了几个文件」
// 之后唯一的刹车。于是形状只能是：invoke 立刻返回 taskId，进度与终止信号全走 event。
//
// ⚠️ 两者共用**同一份** [`TaskRegistry`]，也共用同一个 `cancel_task` 命令。
// 不给替换另开一份注册表的理由写在 `TaskRegistry` 的文档上。

/// `vela://search-batch` 的载荷。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchPayload {
    task_id: String,
    /// **内嵌而不是摊平**：`SearchBatch` 自己有 `files` 与 `filesScanned` 两个字段，
    /// 摊到同一层的话前端读起来分不清哪个是路由用的、哪个是内容
    batch: SearchBatch,
}

/// `vela://search-done` 的载荷。**这是唯一的终止信号。**
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    task_id: String,
    summary: SearchSummary,
}

/// `vela://search-failed` 的载荷。
///
/// 与 done 分成两个事件而不是塞进一个 `Option<Summary> + Option<Error>`：
/// 那样会引入一条「两个字段恰好一个非空」的不变式，而它没有类型替我守着。
/// 两个事件各有各的一种载荷形状，前端 switch 事件名就够，不需要再判空。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
    task_id: String,
    error: SearchError,
}

/// `taskId → 取消标志`。注册进 `tauri::Builder::manage`。
///
/// 为什么是 `Arc<AtomicBool>` 而不是一个「已取消的 id 集合」：标志由后台线程在
/// **每两个文件之间、以及每两行之间**读一次（见 `vela_core::search::search`），
/// 一次原子读比每行去锁一次 HashMap 便宜几个数量级。
///
/// ## ⚠️ 搜索与替换共用**这一份**，不各开一份
///
/// 注册表里存的东西只有一种：一个「该不该停」的原子标志。两种任务的停止语义完全相同
/// （置真 → 后台线程在下一次检查时收手 → 已经做完的部分留着）。分成两份的话，
/// `cancel_task` 就得先猜这个 id 属于哪一份，或者前端得记住该调哪个取消命令——
/// 而猜错的失败方式是「点了取消，什么也没发生」，安静得查不出来。
///
/// 计数器也因此是**全局单调**的，不按前缀各数各的：`search-0`、`replace-1`、`search-2`。
/// 按前缀分别计数的话两种任务会发出相同的数字，而「id 永不复用」这条性质就得升级成
/// 「(前缀, 数字) 这个二元组永不复用」——多一个概念，换不来任何东西。
#[derive(Default)]
pub struct TaskRegistry {
    next_id: AtomicU64,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl TaskRegistry {
    /// 登记一个任务，返回它的 id 与取消标志。
    ///
    /// `prefix` 只用来让 id **可读**（`replace-3` 比 `task-3` 好查日志），
    /// 不参与任何路由判断——路由靠的是 id 整体相等。
    ///
    /// ⚠️ **id 永不复用**，这是用单调计数器而不是「找个空位」的全部理由：
    /// 复用的话一次迟到的 `cancel_task("search-3")` 会取消掉**另一个**任务，
    /// 失败方式是「我明明没点取消，结果只出来一半」，而且只在特定时序下出现。
    fn register(&self, prefix: &str) -> (String, Arc<AtomicBool>) {
        let task_id = format!("{prefix}-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let cancel = Arc::new(AtomicBool::new(false));
        self.lock().insert(task_id.clone(), Arc::clone(&cancel));
        (task_id, cancel)
    }

    /// 任务结束了，把条目摘掉。**由后台线程调**，不依赖前端来收尾——
    /// 前端要是在收到 done 之前就崩了或者被刷新了，条目照样会被清掉。
    fn forget(&self, task_id: &str) {
        self.lock().remove(task_id);
    }

    fn cancel(&self, task_id: &str) {
        if let Some(flag) = self.lock().get(task_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// ⚠️ `unwrap_or_else(into_inner)` 而不是 `expect`：release profile 是
    /// `panic = "abort"`（见根 `Cargo.toml`），一次 panic 就是整个应用当场退出。
    /// 而中毒只意味着「有人持锁的时候 panic 了」，那张 HashMap 本身还是完好的——
    /// 为一个可恢复的状态赔掉整个进程不值。
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.running.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// 起一次全文搜索，**立刻**返回 `taskId`。
///
/// 结果通过 `vela://search-batch` 一批一批推过来，终止信号是 `vela://search-done`
/// （或极端情况下的 `vela://search-failed`）。取消用 [`cancel_task`]。
///
/// ⚠️ 起飞前检查在**这个**线程上做，不在后台线程里做。于是「搜索词编不出来」当场
/// reject 掉 invoke，前端不需要先拿到 taskId、再等一个 failed event 绕回来，
/// 规则就只剩一句：**reject = 这次搜索压根没开始；拿到了 taskId = 一定会等到
/// done 或 failed**。代价是后台线程里 `search_roots()` 会再编一次同样的正则——微秒级。
///
/// 同样声明成 `async fn`：预检要对每个 root 做一次 `metadata`，而 root 可能在网络卷上。
///
/// ## ⚠️ 多根（M2-F）：一次搜索**一个** taskId、一个取消标志、一份总账
///
/// `roots` 是工作区里挂着的全部文件夹，顺序就是前端侧边栏里的顺序，而结果里每条
/// `SearchFile::root_index` 是这个数组的下标。刻意不做成「每个根起一次搜索」：
/// 那样前端要自己攒 N 份总账、自己判断 N 个 taskId 都到齐了没有、取消要发 N 次，
/// 而 `MAX_HITS` 那本预算也会变成每个根一份（两个根就是四万条，用户批准的是两万）。
///
/// ⚠️ **有一个根不合法就整次 reject**，报的错里带着那一个根的路径。刻意不「跳过坏根、
/// 搜剩下的」：跳过之后用户看到的是「找不到某个文件」，而那与「这个文件不存在」
/// 在界面上长得一模一样——PLAN §3.4 里 `IndexStats::truncated` 那条讲的就是这个坑。
/// 拔掉的移动硬盘该被说出来，不该被静默忽略。
///
/// `roots` 为空是合法的（得到一份全零总账），而 UI 到不了那个状态：
/// 没有打开任何文件夹时前端压根不让发起搜索，见 `src/search/store.ts`。
#[command]
pub async fn start_search(
    app: AppHandle,
    tasks: State<'_, TaskRegistry>,
    roots: Vec<String>,
    query: SearchQuery,
) -> Result<String, SearchError> {
    let roots = into_paths(&roots);
    preflight_roots(&path_refs(&roots), &query)?;

    let (task_id, cancel) = tasks.register("search");
    // 三样东西都要在批次回调里用、也要在收尾时用，各克隆一份进闭包
    let emitter = app.clone();
    let batch_task_id = task_id.clone();
    let final_task_id = task_id.clone();

    // `spawn_blocking` 而不是 `std::thread::spawn`：搜索是分钟级的阻塞活，
    // 放进运行时的 blocking 池才不会「开十个搜索就起十个 OS 线程」
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = search_roots(&path_refs(&roots), &query, &cancel, |batch| {
            let _ = emitter.emit(crate::SEARCH_BATCH, BatchPayload { task_id: batch_task_id.clone(), batch });
        });

        // ⚠️ 先摘注册表再发终止事件。反过来的话：前端收到 done 立刻发起下一次搜索，
        // 而上一次的条目还挂在表里——那是一份等着被误取消的状态
        app.state::<TaskRegistry>().forget(&final_task_id);

        let sent = match outcome {
            Ok(summary) => app.emit(crate::SEARCH_DONE, DonePayload { task_id: final_task_id, summary }),
            Err(error) => app.emit(crate::SEARCH_FAILED, FailedPayload { task_id: final_task_id, error }),
        };
        // 发不出去只可能是 webview 已经没了（用户关了窗口），那时也没有前端要通知。
        // 记一行比 panic 好：`panic = "abort"`
        if let Err(e) = sent {
            eprintln!("[vela] 搜索的终止事件没能发出去：{e}");
        }
    });

    Ok(task_id)
}

/// 前端递来的 `roots` 落到 `PathBuf` 上。
///
/// ⚠️ 这里**不做任何规范化**（不 canonicalize、不去末尾斜杠）：四个命令收到的路径
/// 与 `list_dir` / `start_search` 一直以来收到的是同一种东西，而 vela-core 那一侧
/// 的相等比较用的是 `Path` 的逐组件语义，`/repo` 与 `/repo/` 本来就算同一个。
/// 在这里多规范一次，反而会造出「同一个文件夹在两个地方是两个键」的第三种写法
fn into_paths(roots: &[String]) -> Vec<PathBuf> {
    roots.iter().map(PathBuf::from).collect()
}

/// `search_roots` / `apply_roots` / `preflight_*_roots` 要的是 `&[&Path]`。
///
/// ⚠️ 每次调用都新分配一个 `Vec`，而这个分配是**必要的**：闭包要 `move` 走 `roots`
/// 本身（`Vec<PathBuf>`），借出来的 `&Path` 不能在闭包外面先算好
fn path_refs(roots: &[PathBuf]) -> Vec<&Path> {
    roots.iter().map(PathBuf::as_path).collect()
}

/// `vela://replace-progress` 的载荷。
///
/// 与搜索的 `BatchPayload` 同样**内嵌而不是摊平**，理由也一样：`ReplaceProgress`
/// 自己有 `filesScanned`，摊到同一层的话前端分不清哪个 `filesScanned` 是路由用的
/// 信封字段、哪个是内容。
///
/// ⚠️ 这个事件**可能一个都不来**：全部文件都没有命中时既没有「改动」触发推送，
/// 心跳阈值又远没到。前端不能把「没收到 progress」当成出错了——终止信号永远是 done
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceProgressPayload {
    task_id: String,
    progress: ReplaceProgress,
}

/// `vela://replace-done` 的载荷。**这是唯一的终止信号**，也是唯一权威的最终数字：
/// progress 里的 `filesScanned` 可以落后于它（`replace.rs` 里 `Sink` 的文档解释了
/// 为什么那边刻意不做收尾 flush）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceDonePayload {
    task_id: String,
    summary: ReplaceSummary,
}

/// `vela://replace-failed` 的载荷。与 done 分成两个事件的理由见 [`FailedPayload`]：
/// 塞进一个 `Option` 会引入一条「两个字段恰好一个非空」的不变式，而没有类型替我守着
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceFailedPayload {
    task_id: String,
    error: SearchError,
}

/// 起一次全局替换，**立刻**返回 `taskId`。
///
/// ⚠️ **这是 Vela 里唯一一处会批量改写用户磁盘上的文件的命令**，信任面与
/// containment 的完整论证写在本文件头部那节「`start_replace` 是第十个」里。
/// 落盘那一层的取舍（哪些情况一个字节都不写、为什么不用 `fs::read_text`）
/// 写在 `vela-core/src/search/replace.rs` 的模块文档里。
///
/// 进度走 `vela://replace-progress`，终止信号是 `vela://replace-done`
/// （或极端情况下的 `vela://replace-failed`）。取消同样用 [`cancel_task`]。
///
/// ⚠️ **取消不是撤销。** 按下去的那一刻已经改完的文件**留在磁盘上**，
/// 而 `ReplaceSummary::cancelled` 为真、`files_changed` 如实报出改了几个。
/// 前端必须把这两个数字说出来：「已取消，改动了 37 个文件」与「已取消」是两句话，
/// 少说后半句的话用户会以为什么都没发生，然后去按 ⌘S 保存一个已经被改过的文件。
///
/// 与 `start_search` 同一条规则：`preflight_apply` 在**这个**线程上做，
/// reject = 一个文件都没动。这条对替换比对搜索重要得多——搜索 reject 了顶多没结果，
/// 替换 reject 了要是已经改了一半，用户手上就是一个谁也不认识的仓库。
///
/// ⚠️ 多根之下这句话只有在**所有根一起查完才开工**时才成立，所以检查是
/// `preflight_apply_roots`：第二个根不合法时，第一个根一个字节都不会被写。
/// 钉住它的是 `vela-core/tests/wire_contract.rs` 里那条
/// `第二个根不合法时第一个根一个文件都没被改`。其余的多根取舍（一个 taskId、
/// 一份总账、坏根整次 reject）与 [`start_search`] 完全相同，不重复
#[command]
pub async fn start_replace(
    app: AppHandle,
    tasks: State<'_, TaskRegistry>,
    roots: Vec<String>,
    request: ReplaceRequest,
) -> Result<String, SearchError> {
    let roots = into_paths(&roots);
    preflight_apply_roots(&path_refs(&roots), &request)?;

    let (task_id, cancel) = tasks.register("replace");
    let emitter = app.clone();
    let progress_task_id = task_id.clone();
    let final_task_id = task_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let outcome = apply_roots(&path_refs(&roots), &request, &cancel, |progress| {
            let _ = emitter
                .emit(crate::REPLACE_PROGRESS, ReplaceProgressPayload { task_id: progress_task_id.clone(), progress });
        });

        // 与搜索同一顺序：先摘注册表再发终止事件
        app.state::<TaskRegistry>().forget(&final_task_id);

        let sent = match outcome {
            Ok(summary) => app.emit(crate::REPLACE_DONE, ReplaceDonePayload { task_id: final_task_id, summary }),
            Err(error) => app.emit(crate::REPLACE_FAILED, ReplaceFailedPayload { task_id: final_task_id, error }),
        };
        if let Err(e) = sent {
            eprintln!("[vela] 替换的终止事件没能发出去：{e}");
        }
    });

    Ok(task_id)
}

/// 取消一个正在跑的任务（搜索或替换）。已经推出去的结果仍然有效
/// （`SearchSummary::cancelled` / `ReplaceSummary::cancelled` 会为真）。
///
/// **幂等**：taskId 不认识就什么也不做，照样返回成功。
/// 「取消一个已经跑完的任务」是正常时序而不是错误——前端点取消的那一刻，
/// 后台线程可能刚好发完 done。报成错误的话前端要多处理一种它无从判断的状态。
///
/// ⚠️ 对替换而言，取消**不是撤销**：见 [`start_replace`] 的文档。
///
/// ⚠️ 这是**同步** command，与本文件其余的都不一样。两个理由：
/// ① Tauri 规定「带引用入参的 async command 必须返回 `Result`」（`State<'_, T>`
/// 就是引用入参），而这个命令压根没有可报的错——为了满足一个宏去造一个
/// 永远不会出现的错误变体，前端还得多写一条分支；
/// ② 同步 command 跑在主线程上，但这里只有一次原子写加一次 HashMap remove。
/// 后台线程持那把锁的时间也是纳秒级（只在 `register` / `forget` 里），
/// 所以主线程等不到它。`close_window` 是同步的同一个道理。
#[command]
pub fn cancel_task(tasks: State<'_, TaskRegistry>, task_id: String) {
    tasks.cancel(&task_id);
}

/// `Cmd+P` 一次回多少条候选。
///
/// ⚠️ **刻意不做成命令参数。** 浮层只有一个，它要的条数永远是这一个数；做成参数的话
/// Rust 侧就必须为「前端递来一个荒唐的 limit」兜底——二十万条 `FileMatch` 每条两个
/// `String`，序列化出来远超 PLAN §2.6 那条「单次 payload ≤ 4MB」。
/// 一个只能在 Rust 侧被夹紧的参数，前端拿到的那份自由是假的，不如压根不给。
const QUERY_LIMIT: usize = 50;

/// 当前建好的那几份文件索引，**一个根一份**。**M2 的第二份 managed state**（第一份是 [`TaskRegistry`]）。
///
/// ## 为什么要缓存：建一次不是免费的
///
/// 实测（合成的 `pkg{i}/src/feature{j}/module{k}.ts` 树，release，外接盘）：
///
/// | 文件数 | 建一次（热） | 查一次（最坏） |
/// |---|---|---|
/// | 2 万 | 40ms | 0.9ms |
/// | 10 万 | 205ms | 12.7ms |
///
/// 于是「每个按键重建一遍」直接出局（12.7ms 能忍，205ms 不能），
/// 而「每个按键查一次」完全站得住。**缓存要挡的是重建，不是查询。**
///
/// ## ⚠️ 什么时候重建：`index_project` 每次都建，`query_project` 只在缺的那一个根上才建
///
/// 这个不对称是全部的要点。浮层展开时调一次 [`index_project`]，于是「上一次开浮层之后
/// 新建的文件」这一次一定找得到——用户在「Rust 建索引并缓存」那一条上原本接受了一项代价
/// （M2-G 的文件监听落地之前，新文件要手动刷新才进得来），上面那两个数字说明
/// **这项代价可以不付**：2 万文件的仓库重建 40ms，低于人能察觉的门槛；10 万文件 205ms，
/// 而浮层展开那一刻前端本来就有 MRU 可以立刻画出来，用户看到的不是白屏。
///
/// 按键那一路则**绝不主动重建**：命中缓存就用。两条命令各自都能独立给出正确答案，
/// 所以「浮层展开的请求还没回来、用户已经打了一个字」这个时序不会给出一个安静的错答案，
/// 最多是那一次慢一点。
///
/// ## ⚠️ 多根（M2-F）：没有 LRU，`retain` 是唯一会拿掉东西的地方
///
/// 缓存从「一份」变成「每个根一份」之后，「换了项目旧的就够不着」这条不再自动成立，
/// 于是 [`ProjectIndexCache::retain`] 在**两条命令的开头**各调一次：把不在当前工作区
/// 里的那些扔掉。放在开头而不是结尾，是因为结尾的话一个刚被移出工作区的根会先被重建
/// 一遍再被扔掉，白付两百毫秒。
#[derive(Default)]
pub struct ProjectIndexCache {
    roots: Mutex<Vec<Arc<FileIndex>>>,
}

impl ProjectIndexCache {
    /// 找 `root` 的那一份。找到就把 `Arc` 克隆出来，**锁立刻放掉**——
    /// 后面那十几毫秒的打分不该占着一把别的查询也要拿的锁。
    ///
    /// ⚠️ 底下是 `Vec` 而不是 `HashMap<PathBuf, _>`：根的数量是个位数，线性扫比哈希快；
    /// 而 `Path` 的相等比的是 components，`/repo` 与 `/repo/` 天然算同一个根，
    /// 于是不需要先把 key 规范化（规范化本身是一次 `canonicalize`，即一次系统调用，
    /// 而且在移动硬盘拔了的情况下会失败）。
    fn get(&self, root: &Path) -> Option<Arc<FileIndex>> {
        self.lock().iter().find(|index| index.root() == root).cloned()
    }

    fn put(&self, index: Arc<FileIndex>) {
        let mut roots = self.lock();
        // ⚠️ 同一个根建了两遍时**顶掉**旧的那一份，而不是在旁边多留一份。
        // 建的时候不持锁（理由见 [`build_index`]），所以「两个请求同时重建同一个根」
        // 是可能的时序；两份内容一样，留哪份都行，留两份则是白占内存
        match roots.iter_mut().find(|old| old.root() == index.root()) {
            Some(slot) => *slot = index,
            None => roots.push(index),
        }
    }

    /// 扔掉不在 `roots` 里的那些。理由与调用时机见 [`ProjectIndexCache`] 的模块文档。
    fn retain(&self, roots: &[String]) {
        self.lock().retain(|index| roots.iter().any(|root| Path::new(root) == index.root()));
    }

    /// ⚠️ `unwrap_or_else(into_inner)` 而不是 `expect`，理由与 [`TaskRegistry::lock`]
    /// 一字不差：release 是 `panic = "abort"`，而中毒只意味着「有人持锁的时候 panic 了」，
    /// 那个 `Vec<Arc<FileIndex>>` 本身还是完好的
    fn lock(&self) -> MutexGuard<'_, Vec<Arc<FileIndex>>> {
        self.roots.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// 在 blocking 池里建一份索引，成功就写进缓存并把 `Arc` 交回来。
///
/// ⚠️ 走 `spawn_blocking` 而不是直接在 async command 里调：建索引是两百毫秒量级的
/// **阻塞**活（表见 [`ProjectIndexCache`]），占着 async worker 就是占着
/// `open_file` / `save_file` / `list_dir` 的执行位。这也是 [`start_search`] 的同一个理由。
///
/// 建的时候**不持锁**：两百毫秒的锁会把并发的查询全串起来，而两个请求同时重建同一个
/// root 的最坏结果只是「后写完的那一份留下」，两份内容一样。
async fn build_index(cache: &ProjectIndexCache, root: &Path) -> Result<Arc<FileIndex>, TreeError> {
    let owned = root.to_path_buf();
    let built = tauri::async_runtime::spawn_blocking(move || FileIndex::build(&owned).map(Arc::new))
        .await
        .map_err(join_failed)??;
    cache.put(Arc::clone(&built));
    Ok(built)
}

/// `spawn_blocking` 的 `JoinError` 翻成 `TreeError::Io`。
///
/// 它只有两个来源：任务被取消，或者任务 panic 了。panic 在 release 下是
/// `panic = "abort"`，进程当场就没了、压根走不到这里，所以能收到这一条的实际只有取消。
///
/// ⚠️ `pub(crate)`：M2-G 的 `watcher::set_watched` 也走 `spawn_blocking`，
/// 而这一条翻译与它要说的话一字不差，没必要写第二份
pub(crate) fn join_failed(error: tauri::Error) -> TreeError {
    TreeError::Io { reason: "Join".to_owned(), message: format!("建索引的任务没能跑完：{error}") }
}

/// 索引这两条命令的预检：**每一个根都合法**。
///
/// ⚠️ 与搜索、替换同一条规则：先把 N 个根全查一遍，再开始干活。于是
/// 「第二个根是拔掉的移动硬盘」不会先在第一个根上白建一份两百毫秒的索引，
/// 也不会把一份没人要的索引留在缓存里；规则也只需要说一次：**reject = 什么都没发生**。
///
/// 放在 `retain` 前面，是为了让上面那句话在缓存这一侧也字面成立。
/// 名字里没有「project」是为了不与 `vela_core::search::preflight_roots` 撞车——
/// 两个函数查的是同一件事，报的是两套错误枚举
fn preflight_index_roots(roots: &[String]) -> Result<(), TreeError> {
    roots.iter().map(Path::new).try_for_each(project::check_root)
}

/// 建**工作区里每一个根**的文件索引（**每次都重建**），回报合并成一份的账（M2-E，PLAN.md §3.4）。
///
/// 前端在 `Cmd+P` 浮层**展开的那一刻**调它，两个用途：① 让第一次按键落在一份热缓存上；
/// ② 拿到 `IndexStats::truncated` ——为真时索引不全，而「找不到某个文件」在界面上与
/// 「这个文件不存在」长得一模一样，不说一句用户无从分辨。
///
/// ⚠️ 报 `TreeError` 而不是造第四个错误枚举：索引的预检与文件树的是同一套
/// （不是绝对路径 / 不存在 / 不是目录 / IO），前端那份 `describeTreeError` 直接就能用。
/// 多一个枚举就多一份要两边同步的分支表，而它一条新信息也带不来。
///
/// ⚠️ 多根之下回来的 `IndexStats` 是 [`merge_stats`] 合出来的：文件数、读不动的个数、
/// 耗时三个都是**加**，而 `truncated` 是**取或**——三个根里有一个撞了 `MAX_INDEX_FILES`
/// 就必须报出来，不能被另外两个「走完了」的根静默掉。
/// 坏根的取舍见 [`preflight_index_roots`]，与 [`start_search`] 那节完全相同
#[command]
pub async fn index_project(cache: State<'_, ProjectIndexCache>, roots: Vec<String>) -> Result<IndexStats, TreeError> {
    rebuild_indexes(&cache, &roots).await
}

/// [`index_project`] 的本体：**逐个无条件重建**，合并成一份账回来。
///
/// 拆出来只有一个理由——`State<'_, T>` 没有公开的构造器，裹着它的命令在单测里
/// 压根调不到，而「每次都建」正是这一层唯一一条需要被钉住的策略。
/// 这也是本文件开头那句「这一层刻意薄到只有签名转换」的延伸：真正的实现能下沉就下沉到
/// vela-core，下不去的（「什么时候该重建」是一个应用级决定）至少退到 `State` 外面来。
async fn rebuild_indexes(cache: &ProjectIndexCache, roots: &[String]) -> Result<IndexStats, TreeError> {
    preflight_index_roots(roots)?;
    cache.retain(roots);
    let mut stats = Vec::with_capacity(roots.len());
    for root in roots {
        // ⚠️ 逐个 `await` 而不是并发建：三个大仓库同时重建会把 blocking 池占满，
        // 而 `open_file` / `save_file` / `list_dir` 也在上面。多花的是「三个 200ms
        // 还是一个 600ms」，而浮层此刻画的是 MRU，用户看不见差别；
        // 抢占编辑器的 IO 则是能看见的
        stats.push(build_index(cache, Path::new(root)).await?.stats());
    }
    Ok(merge_stats(&stats))
}

/// 在**当前工作区的每一个根**上做模糊匹配，合并后只回**前 [`QUERY_LIMIT`] 条**（M2-E）。
///
/// `needle` 为空是**合法的**，意思是「随便给我一批」——浮层刚展开、用户一个字都还没打时
/// 要的就是这个，而 MRU 加分会让最近打开过的那几个排在最前面。
///
/// `recent` 是前端 MRU 里的绝对路径清单，⚠️ **只用来加分**：比不上的（长在 root 外面的、
/// 已经不存在的）直接忽略，不会因为它去打开或枚举任何路径。上限 `MAX_RECENT` 夹在
/// vela-core 那一侧，前端递多少都不会让这边建一张大哈希表。
#[command]
pub async fn query_project(
    cache: State<'_, ProjectIndexCache>,
    roots: Vec<String>,
    needle: String,
    recent: Vec<String>,
) -> Result<FileQuery, TreeError> {
    query_cached(&cache, &roots, needle, recent).await
}

/// [`query_project`] 的本体：**每个根命中缓存就用，缺谁建谁**，最后在结果那一层合并。
///
/// ⚠️ 合并刻意**不**做成「先并成一份大索引再查」：那意味着每加一个根都要把已有的根
/// 全部重走一遍，缓存就白做了。`query_many` 只碰 N × 50 行，理由写在它的文档里。
async fn query_cached(
    cache: &ProjectIndexCache,
    roots: &[String],
    needle: String,
    recent: Vec<String>,
) -> Result<FileQuery, TreeError> {
    preflight_index_roots(roots)?;
    cache.retain(roots);
    let mut indexes: Vec<Arc<FileIndex>> = Vec::with_capacity(roots.len());
    for root in roots {
        let path = Path::new(root);
        // 正常时序下浮层展开时 `index_project` 已经建好了，能走到重建的只有
        // 「换了项目」与「按键比展开的响应先到」两种，两种都该建
        indexes.push(match cache.get(path) {
            Some(index) => index,
            None => build_index(cache, path).await?,
        });
    }
    // 打分是纯 CPU，10 万文件最坏 12.7ms，多根就是各份之和。这个量级按 `open_file`
    // 的先例本来可以留在 async worker 上，但按键是一串连发的，排队会直接变成手感
    tauri::async_runtime::spawn_blocking(move || {
        // ⚠️ 这一行必须在闭包**里面**：它借 `indexes`，而 `indexes` 是被 move 进来的
        let pairs: Vec<(u16, &FileIndex)> = indexes
            .iter()
            .enumerate()
            .map(|(slot, index)| (u16::try_from(slot).unwrap_or(u16::MAX), index.as_ref()))
            .collect();
        query_many(&pairs, &needle, &recent, QUERY_LIMIT)
    })
    .await
    .map_err(join_failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::search::{MatchRange, SearchFile, SearchHit};

    /// 三个事件载荷的黄金 JSON。另一半在 `src/ipc/search.test.ts`。
    ///
    /// ⚠️ `vela-core/tests/wire_contract.rs` 已经钉过 `SearchBatch` / `SearchSummary` /
    /// `SearchError` 自己的形状，这一条钉的是**外面那层信封**：`taskId` 叫什么、
    /// `batch` 是内嵌还是摊平。信封写错的失败方式与内容写错一样安静——
    /// 前端 `payload.taskId` 读到 `undefined`，于是**每一次**搜索的事件都被当成
    /// 「不属于任何一次搜索」丢掉，界面上一片空白，控制台一行错都没有。
    ///
    /// 心跳批（`files` 为空）单独钉一遍：那是前端最容易漏处理的一种，
    /// 漏了的表现是「进度条不动」，而不是报错。
    ///
    /// ⚠️ M2-F 起 `rootIndex` **总是出现**（没挂 `skip_serializing_if`）：它写错名字的
    /// 失败方式与上面两条一样安静——前端读到 `undefined`，于是每一行都被算成第 0 个根，
    /// 多根工作区里点第二条结果会打开第一个根里的同名文件（如果那里面正好有的话）。
    #[test]
    fn 三个搜索事件载荷的线上形状() {
        let batch = SearchBatch {
            files: vec![SearchFile {
                rel: "src/a.ts".to_owned(),
                path: "/repo/src/a.ts".to_owned(),
                root_index: 0,
                hits: vec![SearchHit {
                    line: 3,
                    text: "let a = needle;".to_owned(),
                    ranges: vec![MatchRange { start: 8, end: 14 }],
                    replaced: None,
                    truncated: false,
                }],
                truncated: false,
            }],
            files_scanned: 3,
        };
        assert_eq!(
            serde_json::to_string(&BatchPayload { task_id: "search-7".to_owned(), batch }).unwrap(),
            r#"{"taskId":"search-7","batch":{"files":[{"rel":"src/a.ts","path":"/repo/src/a.ts","rootIndex":0,"hits":[{"line":3,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"truncated":false}],"truncated":false}],"filesScanned":3}}"#
        );

        // M2-D 替换模式下多出来的那一个字段。⚠️ 上面那条期望字符串**一个字都没改**——
        // `SearchHit::replaced` 挂着 `skip_serializing_if`，所以纯搜索的信封与 M2-C 时相同。
        // 这一条单独钉，是因为前端在替换模式里收到的正是这个形状，
        // 而 `replaced` 写成 `replacement` 的失败方式与 `taskId` 写错一样安静：
        // 每一行都读到 `undefined`，界面退回成纯搜索的样子，控制台一行错都没有
        let preview = SearchBatch {
            files: vec![SearchFile {
                rel: "src/a.ts".to_owned(),
                path: "/repo/src/a.ts".to_owned(),
                root_index: 0,
                hits: vec![SearchHit {
                    line: 3,
                    text: "let a = needle;".to_owned(),
                    ranges: vec![MatchRange { start: 8, end: 14 }],
                    replaced: Some("let a = N;".to_owned()),
                    truncated: false,
                }],
                truncated: false,
            }],
            files_scanned: 3,
        };
        assert_eq!(
            serde_json::to_string(&BatchPayload { task_id: "search-7".to_owned(), batch: preview }).unwrap(),
            r#"{"taskId":"search-7","batch":{"files":[{"rel":"src/a.ts","path":"/repo/src/a.ts","rootIndex":0,"hits":[{"line":3,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"replaced":"let a = N;","truncated":false}],"truncated":false}],"filesScanned":3}}"#
        );

        // 心跳：`files` 为空，只有累计的扫描数
        assert_eq!(
            serde_json::to_string(&BatchPayload {
                task_id: "search-7".to_owned(),
                batch: SearchBatch { files: vec![], files_scanned: 512 }
            })
            .unwrap(),
            r#"{"taskId":"search-7","batch":{"files":[],"filesScanned":512}}"#
        );

        let summary = SearchSummary {
            files_scanned: 120,
            files_with_hits: 3,
            hits: 7,
            skipped_too_large: 1,
            unreadable: 2,
            truncated: false,
            cancelled: true,
            elapsed_ms: 45,
        };
        assert_eq!(
            serde_json::to_string(&DonePayload { task_id: "search-7".to_owned(), summary }).unwrap(),
            r#"{"taskId":"search-7","summary":{"filesScanned":120,"filesWithHits":3,"hits":7,"skippedTooLarge":1,"unreadable":2,"truncated":false,"cancelled":true,"elapsedMs":45}}"#
        );

        assert_eq!(
            serde_json::to_string(&FailedPayload {
                task_id: "search-7".to_owned(),
                error: SearchError::NotFound { path: "/repo".to_owned() }
            })
            .unwrap(),
            r#"{"taskId":"search-7","error":{"kind":"not_found","path":"/repo"}}"#
        );
    }

    /// 三个替换事件载荷的黄金 JSON。另一半在 `src/ipc/replace.test.ts`。
    ///
    /// 与上面那条分工相同：`ReplaceProgress` / `ReplaceSummary` / `SearchError` **自己的**
    /// 形状由 `vela-core/tests/wire_contract.rs` 钉，这里钉的是**外面那层信封**。
    ///
    /// ⚠️ 替换的信封写错比搜索的更要命一档：`replace-done` 拼错或者 `taskId` 名字不对，
    /// 前端会永远停在「正在替换…」转圈，而**磁盘上的文件已经全改完了**。
    /// 搜索那边同样的错误只是「界面一片空白」，用户重试一次就好；
    /// 这边用户面对的是一个改完了却不知道改完了的仓库，很可能再按一次替换
    #[test]
    fn 三个替换事件载荷的线上形状() {
        assert_eq!(
            serde_json::to_string(&ReplaceProgressPayload {
                task_id: "replace-7".to_owned(),
                progress: ReplaceProgress { files_scanned: 12, files_changed: 3, replacements: 7 }
            })
            .unwrap(),
            r#"{"taskId":"replace-7","progress":{"filesScanned":12,"filesChanged":3,"replacements":7}}"#
        );

        assert_eq!(
            serde_json::to_string(&ReplaceDonePayload {
                task_id: "replace-7".to_owned(),
                summary: ReplaceSummary {
                    files_scanned: 120,
                    files_changed: 3,
                    replacements: 7,
                    skipped_binary: 1,
                    skipped_lossy: 2,
                    skipped_unmappable: 0,
                    skipped_too_large: 4,
                    skipped_open: 1,
                    unreadable: 2,
                    write_failed: 0,
                    truncated: false,
                    cancelled: true,
                    elapsed_ms: 45,
                }
            })
            .unwrap(),
            r#"{"taskId":"replace-7","summary":{"filesScanned":120,"filesChanged":3,"replacements":7,"skippedBinary":1,"skippedLossy":2,"skippedUnmappable":0,"skippedTooLarge":4,"skippedOpen":1,"unreadable":2,"writeFailed":0,"truncated":false,"cancelled":true,"elapsedMs":45}}"#
        );

        // 错误变体复用搜索那一个 `SearchError`——两边共享 `check_root` + `compile`，
        // 所以坏正则、坏 glob、坏 root 三种拒法在两个命令上是同一套。多出来的只有 `bad_replacement`
        assert_eq!(
            serde_json::to_string(&ReplaceFailedPayload {
                task_id: "replace-7".to_owned(),
                error: SearchError::BadReplacement {
                    message: "缺少替换内容：replace 不能为 null".to_owned()
                }
            })
            .unwrap(),
            r#"{"taskId":"replace-7","error":{"kind":"bad_replacement","message":"缺少替换内容：replace 不能为 null"}}"#
        );
    }

    /// `start_replace` 的入参在命令边界上长什么样。
    ///
    /// ⚠️ 这一条钉的是**反序列化**方向：前端 `invoke('start_replace', { root, request })`
    /// 递过来的 JSON 必须能落到 `ReplaceRequest` 上。`skip` 缺 key 是最容易出事的——
    /// 它落到「不跳过任何文件」是对的，落到「跳过一切」的话用户点了替换而一个文件没改，
    /// 而 summary 里 `skippedOpen` 会等于文件总数，看起来像是有别的 bug
    #[test]
    fn 替换请求从命令边界上解析进来() {
        // 前端在没有任何脏标签时**不发** `skip` 这个 key
        let parsed: ReplaceRequest =
            serde_json::from_str(r#"{"query":{"pattern":"a","replace":"b","caseSensitive":true}}"#).unwrap();
        assert_eq!(parsed.query.pattern, "a");
        assert_eq!(parsed.query.replace.as_deref(), Some("b"));
        assert!(parsed.query.case_sensitive);
        assert!(parsed.skip.is_empty(), "缺 key 必须是「一个都不跳过」");

        // 有脏标签时发一份绝对路径清单
        let parsed: ReplaceRequest =
            serde_json::from_str(r#"{"query":{"pattern":"a","replace":""},"skip":["/repo/src/x.ts"]}"#).unwrap();
        assert_eq!(parsed.query.replace, Some(String::new()), "空模板是「删掉」，不能变成 None");
        assert_eq!(parsed.skip, vec!["/repo/src/x.ts".to_owned()]);
    }

    #[test]
    fn 注册表发出去的_id_不重复() {
        let tasks = TaskRegistry::default();
        let (a, _) = tasks.register("search");
        let (b, _) = tasks.register("replace");
        let (c, _) = tasks.register("search");
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
        assert_eq!(a, "search-0", "前缀要出现在 id 里，那是查日志时唯一能分辨任务种类的线索");
        assert_eq!(b, "replace-1");
        assert_eq!(tasks.lock().len(), 3, "三个都还挂着");
    }

    /// ⚠️ 这一条钉的是「id 永不复用」那个决定的可观察后果。
    ///
    /// 复用 id 的失败方式是：一次迟到的 `cancel_task` 取消掉一个**无辜的**任务，
    /// 用户看到的是「我明明没点取消，结果只出来一半」，而且只在特定时序下出现。
    /// 替换那一侧后果更重：被误取消的替换会留下一个改了一半的仓库
    #[test]
    fn 结束一个任务之后新任务拿到的是另一个_id() {
        let tasks = TaskRegistry::default();
        let (first, first_cancel) = tasks.register("search");
        tasks.forget(&first);
        assert!(tasks.lock().is_empty(), "摘掉了");

        // 迟到的取消够不着已经结束的那一个了
        tasks.cancel(&first);
        assert!(!first_cancel.load(Ordering::Relaxed), "摘掉之后那次取消找不到它");

        let (second, _) = tasks.register("replace");
        assert_ne!(first, second, "id 一旦发出去就不能再发第二次");
    }

    #[test]
    fn 取消把标志置真() {
        let tasks = TaskRegistry::default();
        let (id, cancel) = tasks.register("replace");
        assert!(!cancel.load(Ordering::Relaxed), "刚起的时候没有取消");
        tasks.cancel(&id);
        assert!(cancel.load(Ordering::Relaxed));
    }

    /// 幂等的那一半：不认识的 taskId 不 panic、不报错。
    ///
    /// 前端点取消的那一刻后台线程可能刚好发完 done 并摘掉了条目，
    /// 那是正常时序，不是错误。
    #[test]
    fn 取消一个不认识的_id_什么也不做() {
        let tasks = TaskRegistry::default();
        tasks.cancel("search-9999");
        tasks.cancel("replace-9999");
        tasks.forget("search-9999");
        assert!(tasks.lock().is_empty());
    }

    /// 一棵两文件的小树。⚠️ 刻意**不放** `.gitignore`、不放符号链接、不放读不动的目录：
    /// 那些是遍历规则，由 `vela_core::project::index` 自己那一批测试负责
    /// （其中两条还直接拿搜索对账）。这里只测缓存策略与参数是不是接对了，
    /// 把遍历规则再抄一遍只是多一处会漂的地方
    fn index_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/alpha.ts"), "a\n").unwrap();
        std::fs::write(dir.path().join("src/beta.ts"), "b\n").unwrap();
        dir
    }

    fn root_of(dir: &tempfile::TempDir) -> String {
        dir.path().to_str().expect("tempdir 的路径不是合法 UTF-8").to_owned()
    }

    /// 只有一个根的工作区。
    ///
    /// 写成函数而不是就地 `&[root.clone()]`：那个写法 clippy 会挑
    /// （`cloned_ref_to_slice_refs`），而它挑得对——`from_ref` 之外的克隆在这儿没有意义
    fn one_root(root: &str) -> Vec<String> {
        vec![root.to_owned()]
    }

    /// ⚠️ 这一条钉的是本层唯一一条**策略**：浮层每展开一次就重建一次。
    ///
    /// 它买来的东西很具体——「上一次开浮层之后新建的文件，这一次一定找得到」。
    /// 要是哪天有人把它改成「命中缓存就复用」（看着很合理，还能省掉两百毫秒），
    /// 失败方式是「刚建的文件 `Cmd+P` 找不到，重启 Vela 才有」，而 M2-G 的文件监听
    /// 落地之前压根没有别的东西会去动这份缓存。数字依据见 [`ProjectIndexCache`] 那张表。
    ///
    /// 顺带钉住多根那一半：**两个根都重建**，不是一个建了一个复用
    #[test]
    fn 每次_index_project_都重建() {
        let (dir, other) = (index_fixture(), index_fixture());
        let roots = vec![root_of(&dir), root_of(&other)];
        let cache = ProjectIndexCache::default();
        tauri::async_runtime::block_on(async {
            rebuild_indexes(&cache, &roots).await.unwrap();
            let before: Vec<_> = roots.iter().map(|root| cache.get(Path::new(root)).unwrap()).collect();
            rebuild_indexes(&cache, &roots).await.unwrap();
            for (slot, root) in roots.iter().enumerate() {
                let after = cache.get(Path::new(root)).unwrap();
                assert!(!Arc::ptr_eq(&before[slot], &after), "第 {slot} 个根复用了缓存，新文件就再也进不来了");
            }
        });
    }

    /// 反过来：按键那一路**绝不主动重建**。
    ///
    /// 与上一条合起来才是完整的策略，少任何一条都会退化成另一种错——
    /// 两条都「每次都建」的话第一个按键就要等两百毫秒，两条都「命中就用」的话
    /// 新建的文件永远找不到
    #[test]
    fn 查询复用缓存里的那一份() {
        let (dir, other) = (index_fixture(), index_fixture());
        let roots = vec![root_of(&dir), root_of(&other)];
        let cache = ProjectIndexCache::default();
        tauri::async_runtime::block_on(async {
            rebuild_indexes(&cache, &roots).await.unwrap();
            let before: Vec<_> = roots.iter().map(|root| cache.get(Path::new(root)).unwrap()).collect();
            let got = query_cached(&cache, &roots, "alpha".to_owned(), Vec::new()).await.unwrap();
            for (slot, root) in roots.iter().enumerate() {
                let after = cache.get(Path::new(root)).unwrap();
                assert!(Arc::ptr_eq(&before[slot], &after), "根没变却重建了，那两百毫秒就落在第一个按键上");
            }
            // 两个根里各有一个 `src/alpha.ts`，于是两条都在，`root_index` 把它们分开
            assert_eq!(got.total, 2);
            assert_eq!(got.matches.len(), 2);
            let indexes: Vec<u16> = got.matches.iter().map(|hit| hit.root_index).collect();
            assert_eq!(indexes, vec![0, 1], "{got:?}");
        });
    }

    /// 缓存里**只有当前工作区挂着的那几个根**。
    ///
    /// 这一条在单根时代是自动成立的（同时只有一份，换了就被顶掉），多根之后不再成立：
    /// 往工作区里加了两个文件夹又移掉，`put` 只会往里加，谁都不会往外拿。
    /// 留下来的就是内存里两棵没人看的十万条路径的 `Vec`
    #[test]
    fn 移出工作区的根会被淘汰() {
        let (dir, other, gone) = (index_fixture(), index_fixture(), index_fixture());
        let cache = ProjectIndexCache::default();
        tauri::async_runtime::block_on(async {
            rebuild_indexes(&cache, &[root_of(&dir), root_of(&other), root_of(&gone)]).await.unwrap();
            assert_eq!(cache.lock().len(), 3);

            rebuild_indexes(&cache, &[root_of(&dir), root_of(&other)]).await.unwrap();
            assert!(cache.get(gone.path()).is_none(), "被移出工作区的根还挂在缓存里");
            assert!(cache.get(dir.path()).is_some() && cache.get(other.path()).is_some());
            assert_eq!(cache.lock().len(), 2);

            // ⚠️ 查询那一路也淘汰。少了这一半的话，用户移出文件夹之后只要不再打开
            // `Cmd+P` 浮层，那几份索引就一直在——而「不再打开浮层」正是最常见的情形
            rebuild_indexes(&cache, &[root_of(&other)]).await.unwrap();
            query_cached(&cache, &[root_of(&other)], String::new(), Vec::new()).await.unwrap();
            assert!(cache.get(dir.path()).is_none(), "查询没有淘汰掉已经不在工作区里的根");
            assert_eq!(cache.lock().len(), 1);
        });
    }

    /// `Path` 的相等比的是 components，所以 `/repo` 与 `/repo/` 是同一个 root。
    ///
    /// 值得单钉一条：前端拿到 root 的两个来源（dialog 的返回值、会话存档里读回来的）
    /// 不保证末尾斜杠一致，而比不上的后果是**每次按键都重建一次索引**——
    /// 界面还是对的，只是慢两百毫秒，属于最难被当成 bug 报上来的那一类
    #[test]
    fn 末尾多一个斜杠算同一个_root() {
        let dir = index_fixture();
        let root = root_of(&dir);
        let cache = ProjectIndexCache::default();
        tauri::async_runtime::block_on(async {
            rebuild_indexes(&cache, &one_root(&root)).await.unwrap();
            let before = cache.get(Path::new(&root)).unwrap();
            // ⚠️ 两种写法混着用：建的时候不带斜杠，查的时候带。要是被当成两个根，
            // 缓存里会多出一份，而 `retain` 也认不出它们该合并
            let slashed = format!("{root}/");
            query_cached(&cache, &one_root(&slashed), String::new(), Vec::new()).await.unwrap();
            let after = cache.get(Path::new(&slashed)).unwrap();
            assert!(Arc::ptr_eq(&before, &after), "`{slashed}` 没被认成 `{root}`");
            assert_eq!(cache.lock().len(), 1, "同一个文件夹在缓存里成了两个键");
        });
    }

    /// 兜底那一条：缓存空着的时候查询自己会建。
    ///
    /// 正常时序走不到这里（浮层展开时 `index_project` 先建好了），能走到的只有
    /// 「按键比展开的响应先到」。⚠️ 没有这一条的话那种时序会**安静地**回一个空列表，
    /// 而空列表在界面上与「一个都没匹配上」长得一模一样。
    ///
    /// 多根版本钉的是**缺谁建谁**：只有一个根缺的时候，另一个必须复用
    #[test]
    fn 没有缓存时查询自己会建一份() {
        let (dir, other) = (index_fixture(), index_fixture());
        let cache = ProjectIndexCache::default();
        tauri::async_runtime::block_on(async {
            let roots = [root_of(&dir), root_of(&other)];
            assert!(cache.get(Path::new(&roots[0])).is_none());
            rebuild_indexes(&cache, &roots[..1]).await.unwrap();
            let warm = cache.get(Path::new(&roots[0])).unwrap();

            let got = query_cached(&cache, &roots, "beta".to_owned(), Vec::new()).await.unwrap();
            assert_eq!(got.total, 2, "{got:?}");
            let still_warm = cache.get(Path::new(&roots[0])).unwrap();
            assert!(Arc::ptr_eq(&warm, &still_warm), "已经热着的那个根被重建了");
            assert!(cache.get(Path::new(&roots[1])).is_some(), "建完没写进缓存，下一个按键还得再建一次");
        });
    }

    /// 报 `TreeError`，而不是「一个空结果」。
    ///
    /// 与 [`index_project`] 的文档呼应：复用文件树那一个错误枚举，前端那份
    /// `describeTreeError` 直接就能把它说成人话
    #[test]
    fn root_不存在时报错而不是一个空结果() {
        let dir = index_fixture();
        let missing = dir.path().join("nope").to_string_lossy().into_owned();
        let cache = ProjectIndexCache::default();
        tauri::async_runtime::block_on(async {
            let err = rebuild_indexes(&cache, &one_root(&missing)).await.unwrap_err();
            assert_eq!(err, TreeError::NotFound { path: missing.clone() });
            // 查询那一路也一样：预检就把它挡下来了，不拿一个空索引糊过去
            let err = query_cached(&cache, &one_root(&missing), String::new(), Vec::new()).await.unwrap_err();
            assert_eq!(err, TreeError::NotFound { path: missing });
        });
    }

    /// ⚠️ 与搜索、替换同一条取舍：**第二个根不合法时，第一个根一份索引都不建**。
    ///
    /// 钉的是「不静默跳过」这件事。跳过的话浮层照样出来一批文件、少一个根的那批，
    /// 用户看到的就是「找不到某个文件」——拔掉的移动硬盘该被说出来
    #[test]
    fn 第二个根不合法时整次报错() {
        let dir = index_fixture();
        let missing = dir.path().join("nope").to_string_lossy().into_owned();
        let cache = ProjectIndexCache::default();
        tauri::async_runtime::block_on(async {
            let roots = [root_of(&dir), missing.clone()];
            let err = rebuild_indexes(&cache, &roots).await.unwrap_err();
            assert_eq!(err, TreeError::NotFound { path: missing.clone() });
            assert!(cache.lock().is_empty(), "第一个根已经建进缓存了，于是它下一次会命中一份没人淘汰的索引");

            let err = query_cached(&cache, &roots, String::new(), Vec::new()).await.unwrap_err();
            assert_eq!(err, TreeError::NotFound { path: missing });
            assert!(cache.lock().is_empty());
        });
    }

    /// 两个参数**没接反**。
    ///
    /// `needle` 与 `recent` 都是 `Vec<String>` / `String` 这类形状很宽的东西，
    /// 接反了编译器一句话都不说：空 needle 命中全部，于是界面照样出来一批文件，
    /// 只是顺序不对、打字不过滤——用户看到的是「这个搜索坏了」。
    ///
    /// ⚠️ 多根之后 `roots` 也是 `Vec<String>`，于是「`roots` 与 `recent` 接反」成了
    /// 第三种同样静默的错法。这一条顺手把它钉住：`recent` 里放的是**绝对路径**，
    /// 拿它当根去建索引会直接 `NotFound`，而下面第三条断言要求的是「建得出来且顺序对」
    #[test]
    fn 空_needle_合法_而_recent_真的能改变顺序() {
        let (dir, other) = (index_fixture(), index_fixture());
        let roots = vec![root_of(&dir), root_of(&other)];
        let cache = ProjectIndexCache::default();
        let beta = dir.path().join("src/beta.ts").to_string_lossy().into_owned();
        tauri::async_runtime::block_on(async {
            // 不带 recent：两个根各自按遍历顺序（每层按文件名排），再按根的序号拼接
            let plain = query_cached(&cache, &roots, String::new(), Vec::new()).await.unwrap();
            assert_eq!(plain.total, 4);
            assert_eq!(plain.matches[0].rel, "src/alpha.ts");
            assert_eq!(plain.matches[0].root_index, 0);

            let mru = query_cached(&cache, &roots, String::new(), vec![beta.clone()]).await.unwrap();
            assert_eq!(mru.matches[0].rel, "src/beta.ts", "recent 没被用上");
            assert_eq!(mru.matches[0].root_index, 0, "加分加到了另一个根的同名文件上");

            // needle 还在过滤：recent 只是加分，不是「无视搜索词」
            let filtered = query_cached(&cache, &roots, "alpha".to_owned(), vec![beta]).await.unwrap();
            assert_eq!(filtered.total, 2);
            assert_eq!(filtered.matches[0].rel, "src/alpha.ts");
        });
    }

    /// `QUERY_LIMIT` 在 IPC 这一侧真的生效，而 `total` 报的是**命中总数**不是回来的条数。
    ///
    /// 前端靠这两个数的差说「还有更多，把词写窄一点」。⚠️ 也顺便钉住了 §2.6 那条
    /// 「单次 payload ≤ 4MB」：limit 不做成参数就是为了这里没有一个能被前端撑大的口子。
    ///
    /// ⚠️ 多根之下这一条更重要一档：每个根各回 `QUERY_LIMIT` 条再合并截断，
    /// 于是「三个根」最坏是 150 条进来、50 条出去。要是合并那一步忘了截断，
    /// payload 就随根的个数线性涨，而 §2.6 那条预算是死的
    #[test]
    fn 一次最多回_query_limit_条_但_total_报的是命中总数() {
        let total = QUERY_LIMIT + 10;
        // ⚠️ `TempDir` 必须收着：它一落地就把目录删了，而建索引是异步的
        let mut dirs = Vec::new();
        let mut roots = Vec::new();
        for _ in 0..2 {
            let dir = tempfile::tempdir().unwrap();
            for index in 0..total {
                std::fs::write(dir.path().join(format!("f{index:03}.ts")), "x\n").unwrap();
            }
            roots.push(root_of(&dir));
            dirs.push(dir);
        }
        let cache = ProjectIndexCache::default();
        tauri::async_runtime::block_on(async {
            let got = query_cached(&cache, &roots, String::new(), Vec::new()).await.unwrap();
            assert_eq!(got.matches.len(), QUERY_LIMIT, "两个根各回 50 条，合并之后没有截断");
            assert_eq!(got.total as usize, total * 2, "total 报的是回来的条数，前端就没法说「还有更多」了");
        });
    }
}
