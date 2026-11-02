//! 系统打印窗口（M7-15）。
//!
//! 「导出 PDF」没有另造一条 PDF 生成链路：macOS 打印面板左下角就有一个
//! 「PDF ▾ → 存储为 PDF」，而 wry 暴露的原生出口正是这个面板
//! （`WKWebView.printOperationWithPrintInfo`）。前端先把正文放进一块只在打印媒体里
//! 出现的快照（`src/md/print.ts`），这一层只负责把面板叫出来。
//!
//! 🔴 macOS 上不能改用页面里的 `window.print()`：WKWebView 没有浏览器外壳，
//! 那个调用是一个**静默的空操作**——按了之后什么都不发生，也没有任何报错可查。
//! 其余平台反过来：wry 的 `print()` 只有 macOS 实现，页面自己的 `window.print()`
//! 才是 WebView2 / WebKitGTK 上的那条路。
//!
//! ⚠️ 这个命令**不收正文**。正文早已在主窗口的 DOM 里，再经 IPC 递一遍只会多出一份
//! 要审的载荷；权限面因此与「读当前窗口」一样宽，不比 `save_file` 多。

use tauri::WebviewWindow;

/// 把当前窗口交给系统打印面板。
#[tauri::command]
pub fn print_window(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window.print().map_err(|err| err.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.eval("window.print()").map_err(|err| err.to_string())
    }
}
