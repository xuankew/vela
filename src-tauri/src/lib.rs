mod commands;
mod menu;
mod shard;
mod watcher;

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

/// 替换的进度快照。另一半在 `src/ipc/replace.ts`。
///
/// ⚠️ 与 `SEARCH_BATCH` 不同，这一个**可能一个都不来**：全部文件都没有命中时
/// 既没有「改动」触发推送，心跳阈值又远没到（理由见
/// `crates/vela-core/src/search/replace.rs` 里 `Sink` 的文档）。前端不能把
/// 「没收到 progress」当成出错——终止信号永远是 done。
///
/// ⚠️ 而且它里面的 `filesScanned` **可以小于** done 里那个：落盘那一侧刻意不做
/// 收尾 flush。最终数字一律以 `REPLACE_DONE` 的 summary 为准。
const REPLACE_PROGRESS: &str = "vela://replace-progress";

/// 替换结束，载荷里带 `ReplaceSummary`。**这是唯一的终止信号，也是唯一权威的最终数字。**
///
/// ⚠️ 这个名字拼错的后果比搜索那边重一档：前端会永远停在「正在替换…」，
/// 而磁盘上的文件**已经全改完了**。用户面对的是一个改完了却不知道改完了的仓库
const REPLACE_DONE: &str = "vela://replace-done";

/// 替换在 `start_replace` 的预检**之后**才失败，载荷里带 `SearchError`。
/// 与 `SEARCH_FAILED` 同一种罕见情形（root 在两步之间被删掉/被卸载）
const REPLACE_FAILED: &str = "vela://replace-failed";

/// 一个**被打开着的**文件在外部被改了或被删了（M2-G）。另一半在 `src/ipc/watch.ts`。
///
/// ⚠️ 与上面那六个不同，这一个**没有终止信号**，也没有 `taskId`：它是一条条独立的通知，
/// 前端收到一条就处理一条（干净标签静默重载，脏标签进冲突队列）。
///
/// ⚠️ 载荷里的 `path` 是**前端自己递进来的那个原样字符串**，不是 canonical 形式。
/// 前端要拿它与 `doc.path()` 比，而那一个从来没被规范化过。理由与静默失败的形状
/// 写在 `src/watcher.rs` 里 `Filter` 那个类型别名的文档上。
///
/// ⚠️ 收不到这一条**不代表**文件没变：目录订不上（`WatchStats.failed`）、
/// 目录数撞了上限（`truncated`）、路径压根没进计划（`skipped`）三种情况都是静默的。
/// 所以 `set_watched` 的返回值里有那三个数字，前端该说的时候要说一句。
const FILE_CHANGED: &str = "vela://file-changed";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // M2-C 起的 `taskId → 取消标志` 注册表，M2-D 的替换与搜索**共用这一份**。
        // 见 `commands::TaskRegistry`
        .manage(commands::TaskRegistry::default())
        // M2-E 的第二份 managed state：`Cmd+P` 的文件索引缓存。
        // 见 `commands::ProjectIndexCache`（那张实测表说明了为什么必须有缓存）
        .manage(commands::ProjectIndexCache::default())
        // M2-G 的第三份 managed state：外部改动监听。见 `watcher::WatcherState`
        // （⚠️ 它是这三份里唯一一个会自己起线程、自己回调进来的）
        .manage(watcher::WatcherState::default())
        // M2-H 的第四份 managed state：大文件只读分片的句柄表。见 `shard::ShardRegistry`
        // （⚠️ 它是这四份里唯一一个**必须有人来收尾**的：一个条目就是一个 fd，
        // 而 fd 不会因为没人再提它就自己关掉）
        .manage(shard::ShardRegistry::default())
        .menu(|app| menu::build_menu(app))
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::store_image,
            commands::list_dir,
            commands::create_entry,
            commands::rename_entry,
            commands::trash_entry,
            commands::reveal_entry,
            commands::copy_entry_path,
            commands::close_window,
            commands::load_session,
            commands::save_session,
            commands::load_settings,
            commands::save_settings,
            commands::start_search,
            commands::start_replace,
            commands::cancel_task,
            commands::index_project,
            commands::query_project,
            watcher::set_watched,
            shard::open_large,
            shard::read_lines,
            shard::close_large
        ])
        // 菜单项点击事件：全部转发给前端，由前端的命令系统统一处理。
        .on_menu_event(|app, event| {
            let id = event.id().0;
            // 把菜单 ID 作为事件名发给所有窗口，前端监听后走对应的命令
            for window in app.webview_windows() {
                let _ = window.emit("menu-event", id);
            }
        })
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
    /// `src/ipc/search.ts` 的三个 `SEARCH_*_EVENT`、`src/ipc/replace.ts` 的三个
    /// `REPLACE_*_EVENT`、`src/ipc/watch.ts` 的 `FILE_CHANGED_EVENT` 对照。
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

    /// ⚠️ `FILE_CHANGED` 拼错的失败方式与 `SEARCH_DONE` 那一档一样安静，
    /// 但更难联想到是字符串的问题：外部改了文件、Vela 一声不吭，
    /// 用户下一次 ⌘S 就把别人的改动盖掉了。而「Vela 没提醒我」这件事
    /// 从来不会被报成 bug，只会被记成「这编辑器不太行」
    #[test]
    fn file_changed_event_matches_frontend() {
        assert_eq!(super::FILE_CHANGED, "vela://file-changed");
    }

    /// ⚠️ 这一条的分量比上面那条重：`REPLACE_DONE` 拼错的后果不是「界面没反应」，
    /// 而是「界面永远停在正在替换，而磁盘上的两万个文件已经改完了」。
    /// 用户手上是一个改完了却不知道改完了的仓库，很可能再按一次替换
    #[test]
    fn replace_events_match_frontend() {
        assert_eq!(super::REPLACE_PROGRESS, "vela://replace-progress");
        assert_eq!(super::REPLACE_DONE, "vela://replace-done");
        assert_eq!(super::REPLACE_FAILED, "vela://replace-failed");
    }
}
