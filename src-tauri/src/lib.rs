mod commands;

use tauri::{Emitter, RunEvent, WindowEvent};

/// 前端要回答「能不能关」的事件名。另一半在 `src/ipc/windowClose.ts`。
const REQUEST_CLOSE: &str = "vela://request-close";

/// 搜索的一批结果（或一次心跳）。另一半在 `src/ipc/search.ts`。
///
/// ⚠️ 载荷里的 `batch.files` **可能是空的**，那是一次心跳而不是「搜完了」
/// （理由与实测数字见 `vela_core::search` 的模块文档）。
const SEARCH_BATCH: &str = "vela://search-batch";

/// 搜索正常结束，载荷里带 `SearchSummary`。**这是唯一的终止信号。**
const SEARCH_DONE: &str = "vela://search-done";

/// 搜索在 `start_search` 的预检**之后**才失败，载荷里带 `SearchError`。
///
/// 正常情况收不到这一个：预检在开线程之前就做完了，编不出来的正则与不对的 root
/// 会让 `start_search` 当场 reject。它能发生的唯一情形是 root 在预检与后台线程
/// 自己那次检查之间被删掉/被卸载——罕见，但不处理的话前端会永远等不到 done。
const SEARCH_FAILED: &str = "vela://search-failed";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // M2-C：`taskId → 取消标志`的注册表。见 `commands::SearchTasks`
        .manage(commands::SearchTasks::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::list_dir,
            commands::create_entry,
            commands::rename_entry,
            commands::trash_entry,
            commands::reveal_entry,
            commands::copy_entry_path,
            commands::close_window,
            commands::load_session,
            commands::save_session,
            commands::start_search,
            commands::cancel_search
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
    /// 与 `src/ipc/windowClose.ts` 的 `REQUEST_CLOSE_EVENT`、
    /// `src/ipc/search.ts` 的三个 `SEARCH_*_EVENT` 对照。
    ///
    /// 这是个**契约快照**，和 `crates/vela-core/tests/wire_contract.rs` 同一套路数：
    /// 事件名在 Rust 与 TS 各手写一份，没有代码生成。名字对不上的失败方式很安静——
    /// `REQUEST_CLOSE` 拼错是「窗口永远关不掉」，`SEARCH_DONE` 拼错是
    /// 「搜索进度条转到底也不停」：都不崩、都不报错，只是毫无反应，
    /// 极难联想到是字符串拼错。改任何一边都必须同时改另一边，并让这两边的测试一起过。
    #[test]
    fn request_close_event_matches_frontend() {
        assert_eq!(super::REQUEST_CLOSE, "vela://request-close");
    }

    #[test]
    fn search_events_match_frontend() {
        assert_eq!(super::SEARCH_BATCH, "vela://search-batch");
        assert_eq!(super::SEARCH_DONE, "vela://search-done");
        assert_eq!(super::SEARCH_FAILED, "vela://search-failed");
    }
}
