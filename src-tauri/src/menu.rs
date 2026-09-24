use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

/// 构建应用的主菜单栏。
///
/// 分类遵循标准桌面编辑器惯例：File / Edit / View / Window / Help，
/// 把原本挤在工具栏上的所有操作收进菜单，保持主界面简洁。
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ── File ───────────────────────────────────────────────
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "file.new", "新建文档", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "file.open", "打开文件...", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(app, "file.open_folder", "打开文件夹...", true, Option::<&str>::None)?,
            &MenuItem::with_id(app, "file.recent", "最近项目", true, Option::<&str>::None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "file.save", "保存", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(app, "file.save_as", "另存为...", true, Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "file.close_folder", "关闭文件夹", true, Option::<&str>::None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("退出 Vela"))?,
        ],
    )?;

    // ─ Edit ────────────────────────────────────────────────
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "edit.find_in_files", "在文件中查找...", true, Some("CmdOrCtrl+Shift+F"))?,
            &MenuItem::with_id(app, "edit.replace_in_files", "在文件中替换...", true, Some("CmdOrCtrl+Shift+H"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "edit.format_json", "格式化 JSON", true, Some("CmdOrCtrl+Shift+J"))?,
            &MenuItem::with_id(app, "edit.minify_json", "压缩 JSON", true, Some("CmdOrCtrl+Alt+J"))?,
            &MenuItem::with_id(app, "edit.align_table", "对齐表格", true, Some("CmdOrCtrl+Shift+A"))?,
            &MenuItem::with_id(app, "edit.word_count", "字数统计", true, Some("CmdOrCtrl+Shift+C"))?,
        ],
    )?;

    // ── View ────────────────────────────────────────────────
    let view_menu = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &MenuItem::with_id(app, "view.toggle_sidebar", "切换侧边栏", true, Some("CmdOrCtrl+B"))?,
            &MenuItem::with_id(app, "view.toggle_preview", "切换预览", true, Some("CmdOrCtrl+Shift+V"))?,
            &MenuItem::with_id(app, "view.toggle_outline", "切换大纲", true, Some("CmdOrCtrl+Shift+M"))?,
            &MenuItem::with_id(app, "view.toggle_json_preview", "切换 JSON 预览", true, Some("CmdOrCtrl+Alt+V"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view.zoom_in", "放大", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "view.zoom_out", "缩小", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(app, "view.reset_zoom", "重置缩放", true, Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view.toggle_line_wrap", "切换换行", true, Some("Alt+Z"))?,
            &MenuItem::with_id(app, "view.command_palette", "命令面板...", true, Some("CmdOrCtrl+Shift+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view.toggle_md_toolbar", "Markdown 工具栏", true, Option::<&str>::None)?,
            &MenuItem::with_id(app, "view.settings", "设置...", true, Some("CmdOrCtrl+,"))?,
        ],
    )?;

    // ── Window ──────────────────────────────────────────────
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &MenuItem::with_id(app, "window.split_right", "右分屏", true, Some("CmdOrCtrl+\\"))?,
            &MenuItem::with_id(app, "window.split_down", "下分屏", true, Some("CmdOrCtrl+Shift+\\"))?,
            &MenuItem::with_id(app, "window.merge_panes", "合并分屏", true, Option::<&str>::None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "window.focus_next", "聚焦下一个分屏", true, Some("CmdOrCtrl+Alt+Right"))?,
            &MenuItem::with_id(app, "window.focus_prev", "聚焦上一个分屏", true, Some("CmdOrCtrl+Alt+Left"))?,
            &MenuItem::with_id(app, "window.close_pane", "关闭分屏", true, Option::<&str>::None)?,
        ],
    )?;

    // ── Help ────────────────────────────────────────────────
    let help_menu = Submenu::with_items(
        app,
        "帮助",
        true,
        &[
            &MenuItem::with_id(app, "help.about", "关于 Vela", true, Option::<&str>::None)?,
        ],
    )?;

    Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
}
