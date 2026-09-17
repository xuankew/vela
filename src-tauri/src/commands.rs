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
//! ## 接受路径的命令，按能力分组（M2-D 之后共十个）
//!
//! | 能力 | 命令 | 参数形状 |
//! |---|---|---|
//! | 读文件内容 | `open_file` | 任意绝对路径 |
//! | 写文件内容 | `save_file` | 任意绝对路径 |
//! | **枚举**目录 | `list_dir` | `(root, rel)` |
//! | **创建** | `create_entry` | `(root, rel, kind)` |
//! | **改名** | `rename_entry` | `(root, rel, new_name)` |
//! | **删除**（移废纸篓） | `trash_entry` | `(root, rel)` |
//! | 交给系统工具 | `reveal_entry` / `copy_entry_path` | `(root, rel)` |
//! | **全文搜索**（读正文） | `start_search` | 任意绝对路径 `root` + 两个 glob 列表 |
//! | **全局替换**（写正文） | `start_replace` | 同上，外加一份要跳过的绝对路径清单 |
//!
//! 另存为没有自己的命令：它是前端先用 dialog 插件拿到新路径，再调同一个 `save_file`。
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
//! 符号链接是**有意放行**的（pnpm 的 `node_modules` 就是符号链接搭的），
//! 理由见 `vela-core/src/project/tree.rs` 的模块文档。⚠️ 注意这句话只适用于**文件树**：
//! 搜索与替换恰恰相反（`follow_links(false)`），见 `vela-core/src/search/mod.rs` 开头那两节。
//!
//! 会话存档那两个命令也写文件，但**路径由 Rust 侧算出来**（`app_data_dir()/session.json`），
//! 前端连传路径的入口都没有。所以它们没有把上面那条信任面扩大一分。
//!
//! ⚠️ 信任边界：这十个命令合起来等于给了 webview 一个「读、写、枚举、创建、改名、
//! 删除、以及**批量改写**本地文件」的原语。这在 Vela 里是可接受的，前提是 webview
//! 只加载第一方打包产物：没有远程内容、没有 `withGlobalTauri`、没有开 remote 域名白名单。
//! 注意 `tauri.conf.json` 目前的 `csp` 仍是 `null`，也就是说这条前提只靠
//! 「我们不加载远程内容」这个约定撑着，没有第二道防线。**如果将来引入任何远程内容或
//! 第三方插件 UI（M5），这十个命令必须改成只接受「用户显式授权过的路径」**——
//! 具体做法是把 dialog 打开过的 root 记在 Tauri managed state 里，命令只收 `rootId`
//! 而不收路径字符串。⚠️ 而 `start_replace` 是这件事变得**紧迫**的那一个：
//! 在它之前，一次 XSS 最坏能改掉用户正在看的文件；在它之后，最坏能改掉整个文件夹。
//! （M2-C 已经有了第一份 managed state，见 [`TaskRegistry`]，但那不是授权表。）

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{command, AppHandle, Emitter, Manager, State};
use vela_core::fs::{
    read_text, read_text_as, write_text_atomic, Encoding, FileFormat, ReadError, TextFile, WriteError, WriteReport,
};
use vela_core::project::{self, DirEntry, DirListing, EntryKind, TreeError};
use vela_core::search::{
    apply, preflight, preflight_apply, search, ReplaceProgress, ReplaceRequest, ReplaceSummary, SearchBatch,
    SearchError, SearchQuery, SearchSummary,
};
use vela_core::session::{self as session_store, Session, SessionError, SessionReport, SESSION_FILE_NAME};

/// 读一个文本文件。
///
/// 声明成 `async fn` 是为了让它在 Tauri 的异步运行时上跑，而不是主线程——
/// 同步 command 会阻塞 UI。函数体本身是阻塞 IO，没有再套 `spawn_blocking`：
/// 上限 4MB 的文件读 + 解码在毫秒量级，而运行时上目前只有这一个来源的活。
///
/// ⚠️ M2-C 的搜索落地之后这句话仍然成立，因为 `start_search` 走的是
/// `spawn_blocking`（见下），它占的是 blocking 池而不是 async worker，
/// 所以并没有给这里添并发负载。真要给 async worker 加压的是 M2-G 的文件监听，
/// 到那时再把这里挪进 blocking 池。
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
/// done 或 failed**。代价是后台线程里 `search()` 会再编一次同样的正则——微秒级。
///
/// 同样声明成 `async fn`：预检要对 root 做一次 `metadata`，而 root 可能在网络卷上。
#[command]
pub async fn start_search(
    app: AppHandle,
    tasks: State<'_, TaskRegistry>,
    root: String,
    query: SearchQuery,
) -> Result<String, SearchError> {
    preflight(Path::new(&root), &query)?;

    let (task_id, cancel) = tasks.register("search");
    let root = PathBuf::from(root);
    // 三样东西都要在批次回调里用、也要在收尾时用，各克隆一份进闭包
    let emitter = app.clone();
    let batch_task_id = task_id.clone();
    let final_task_id = task_id.clone();

    // `spawn_blocking` 而不是 `std::thread::spawn`：搜索是分钟级的阻塞活，
    // 放进运行时的 blocking 池才不会「开十个搜索就起十个 OS 线程」
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = search(&root, &query, &cancel, |batch| {
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
#[command]
pub async fn start_replace(
    app: AppHandle,
    tasks: State<'_, TaskRegistry>,
    root: String,
    request: ReplaceRequest,
) -> Result<String, SearchError> {
    preflight_apply(Path::new(&root), &request)?;

    let (task_id, cancel) = tasks.register("replace");
    let root = PathBuf::from(root);
    let emitter = app.clone();
    let progress_task_id = task_id.clone();
    let final_task_id = task_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let outcome = apply(&root, &request, &cancel, |progress| {
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
    #[test]
    fn 三个搜索事件载荷的线上形状() {
        let batch = SearchBatch {
            files: vec![SearchFile {
                rel: "src/a.ts".to_owned(),
                path: "/repo/src/a.ts".to_owned(),
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
            r#"{"taskId":"search-7","batch":{"files":[{"rel":"src/a.ts","path":"/repo/src/a.ts","hits":[{"line":3,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"truncated":false}],"truncated":false}],"filesScanned":3}}"#
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
            r#"{"taskId":"search-7","batch":{"files":[{"rel":"src/a.ts","path":"/repo/src/a.ts","hits":[{"line":3,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"replaced":"let a = N;","truncated":false}],"truncated":false}],"filesScanned":3}}"#
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

        // 错误变体复用搜索那一个 `SearchError`——两边共享 `prepare`，所以坏正则、
        // 坏 glob、坏 root 三种拒法在两个命令上是同一套。多出来的只有 `bad_replacement`
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
}
