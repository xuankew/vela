mod commands;

use tauri::{Emitter, RunEvent, WindowEvent};

/// 前端要回答「能不能关」的事件名。另一半在 `src/ipc/windowClose.ts`。
const REQUEST_CLOSE: &str = "vela://request-close";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::close_window,
            commands::load_session,
            commands::save_session
        ])
        // 未保存改动的关闭拦截（PLAN.md M1-D-4）。
        //
        // 两个入口都要拦，只拦第一个在 macOS 上等于没拦：
        // - `CloseRequested`：点窗口红绿灯的关闭键、或前端调 `window.close()`
        // - `ExitRequested`：Cmd+Q 与菜单栏的「退出 Vela」——这两条压根不经过窗口
        //
        // 一律 prevent + 发事件，把决定权整个交给前端（`src/doc/workspace.ts` 的
        // `requestWindowClose`）。前端答「可以关」之后调 `close_window` 真的拆窗口。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit(REQUEST_CLOSE, ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Vela")
        .run(|app, event| {
            if let RunEvent::ExitRequested { code, api, .. } = event {
                // `code` 为 None 表示「最后一个窗口没了」，那是我们自己的 destroy()
                // 引发的正常退场，必须放行——否则应用永远退不出去。
                if code.is_none() {
                    return;
                }
                api.prevent_exit();
                let _ = app.emit(REQUEST_CLOSE, ());
            }
        });
}

#[cfg(test)]
mod tests {
    /// 与 `src/ipc/windowClose.ts` 的 `REQUEST_CLOSE_EVENT` 对照。
    ///
    /// 这是个**契约快照**，和 `crates/vela-core/tests/wire_contract.rs` 同一套路数：
    /// 事件名在 Rust 与 TS 各手写一份，没有代码生成。名字对不上的失败方式是
    /// 「窗口永远关不掉」——不会崩、不报错，只是点关闭毫无反应，极难联想到是字符串拼错。
    /// 改任何一边都必须同时改另一边，并让这两个测试一起过。
    #[test]
    fn request_close_event_matches_frontend() {
        assert_eq!(super::REQUEST_CLOSE, "vela://request-close");
    }
}
