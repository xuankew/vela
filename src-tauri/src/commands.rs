//! Tauri command 适配层（PLAN.md §2.6）。
//!
//! 这一层刻意薄到只有签名转换：真正的实现在框架无关的 `vela-core` 里，
//! 这样单测不需要 `AppHandle`，将来做 CLI 或 headless 工具也能直接复用。
//!
//! **文件系统命令只有两个**，因为编辑器对文件系统的需求就只有「读一个文本文件」和
//! 「把一个文本文件写回去」。另存为不是第三个命令——它是前端先用 dialog 插件
//! 拿到新路径，再调同一个 `save_file`。命令越多，权限面越大，越难审计。
//! 第三个命令 `close_window` 不碰文件系统，只是关窗握手的回执（见 `lib.rs`）。
//!
//! ⚠️ 信任边界：这两个命令接受**任意路径**，等于给了 webview 一个读写本地文件的
//! 原语。这在 Vela 里是可接受的，前提是 webview 只加载第一方打包产物：没有远程
//! 内容、没有 `withGlobalTauri`、没有开 remote 域名白名单。注意 `tauri.conf.json`
//! 目前的 `csp` 是 `null`（补齐推迟到 M1-H），也就是说这条前提现在只靠「我们不加载
//! 远程内容」这个约定撑着，没有第二道防线。如果将来引入任何远程内容或第三方插件 UI，
//! 这两个命令必须改成只接受「用户显式授权过的路径」，而不是任意字符串。

use std::path::Path;

use tauri::command;
use vela_core::fs::{
    read_text, read_text_as, write_text_atomic, Encoding, FileFormat, ReadError, TextFile, WriteError, WriteReport,
};

/// 读一个文本文件。
///
/// 声明成 `async fn` 是为了让它在 Tauri 的异步运行时上跑，而不是主线程——
/// 同步 command 会阻塞 UI。函数体本身是阻塞 IO，没有再套 `spawn_blocking`：
/// 上限 4MB 的文件读 + 解码在毫秒量级，而运行时上目前只有这一个来源的活。
/// 等 M1 的搜索与文件监听落地、运行时真有了并发负载，再把这里挪进 blocking 池。
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

/// 关窗握手的回执：前端说「可以关了」之后调这个。
///
/// 用 `destroy()` 而不是 `close()`——`close()` 会再触发一次 `CloseRequested`，
/// `lib.rs` 又会 prevent + 发事件，变成「问用户 → 用户同意 → 再问一遍」的死循环。
/// `destroy()` 直接拆窗口，随后 Tauri 以 `ExitRequested { code: None }` 退场，
/// 那一种 `lib.rs` 是放行的。
///
/// 这是本层唯一需要 `Window` 的命令，也就是文件头「单测不需要 AppHandle」那条的例外：
/// 它没有可以下沉到 `vela-core` 的实现，本体就是框架调用，也没什么可单测的。
#[command]
pub fn close_window(window: tauri::Window) {
    let _ = window.destroy();
}
