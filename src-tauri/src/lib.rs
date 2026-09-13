use serde::Serialize;
use std::time::Instant;

/// Rust 进程启动时刻，用于测量「进程启动 → 前端可交互」的分段耗时。
static PROCESS_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn process_start() -> &'static Instant {
    PROCESS_START.get_or_init(Instant::now)
}

#[derive(Serialize)]
pub struct MemInfo {
    /// 当前进程 RSS（KB），来自 `ps -o rss=`
    pub rust_rss_kb: u64,
    /// Rust 侧自启动以来的毫秒数
    pub rust_uptime_ms: u128,
}

#[derive(Serialize)]
pub struct FilePayload {
    pub path: String,
    pub bytes: usize,
    pub lines: usize,
    pub content: String,
}

/// M0 探针：读取进程内存与运行时长。
///
/// 走 `ps` 而非引入 sysinfo，是为了不给 M0 增加编译负担；
/// 仅 macOS/Linux 可用，属探针临时代码。
#[tauri::command]
fn probe_memory() -> Result<MemInfo, String> {
    let pid = std::process::id();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let rss: u64 = text.parse().unwrap_or(0);
    Ok(MemInfo {
        rust_rss_kb: rss,
        rust_uptime_ms: process_start().elapsed().as_millis(),
    })
}

/// M0 探针：只返回 Rust 进程自启动以来的毫秒数。
///
/// 单独开一个命令而不复用 `probe_memory`，是因为后者会 fork 一个 `ps` 子进程。
/// 验收项 #6 要在「编辑器就绪」那一刻打点，预算只有 1000ms，
/// 十几毫秒的 fork 噪声会直接污染读数。这个命令里不做任何系统调用。
#[tauri::command]
fn probe_ready() -> u128 {
    process_start().elapsed().as_millis()
}

/// M0 探针：从磁盘读取真实文件，用于验证「打开本地文件」路径与 IPC payload 规模。
#[tauri::command]
fn read_text_file(path: String) -> Result<FilePayload, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let lines = content.lines().count();
    Ok(FilePayload {
        path,
        bytes: bytes.len(),
        lines,
        content,
    })
}

/// 报告落盘位置。
///
/// 用编译期的 CARGO_MANIFEST_DIR 推出仓库根，文件名也由 Rust 侧写死，
/// **不接受前端传入路径**——那会把它变成任意文件写入的原语。探针只需要固定出口。
fn report_path(file: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(file)
}

/// M0 探针落盘的固定出口。
///
/// 存在的理由：探针的数字活在 WKWebView 的 DOM 里，从 webview 外部读不到，
/// 靠人逐条念给工具既慢又容易抄错。落盘后可以直接进《M0 验证报告》。
///
/// 槽位名在 Rust 侧写死成白名单，前端**只能选不能拼路径**——
/// 否则这就成了任意文件写入的原语。
const PROBE_SLOTS: &[(&str, &str)] = &[
    ("report", ".m0-report.json"),
    ("align", ".m0-align.json"),
    ("scroll", ".m0-scroll.json"),
];

#[tauri::command]
fn save_probe_slot(slot: String, json: String) -> Result<String, String> {
    let file = PROBE_SLOTS
        .iter()
        .find(|(name, _)| *name == slot)
        .map(|(_, file)| *file)
        .ok_or_else(|| format!("未知槽位 {slot}"))?;
    let path = report_path(file);
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// 自动化测量的开关：仓库根存在 `.m0-autotest` 时，前端启动后自动跑 #1 的滚动矩阵。
///
/// 做成文件开关而不是常开：矩阵会独占窗口十几秒、反复重建编辑器，
/// 日常启动不该被它劫持。
#[tauri::command]
fn autotest_enabled() -> bool {
    report_path(".m0-autotest").exists()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = process_start();
    tauri::Builder::default()
        .setup(|app| {
            // TODO(M0-自动扫描): 临时测量代码，#7 归因完成后必须删除。
            //
            // 实测踩到的坑：窗口被其他应用完全遮挡时，WKWebView 的
            // `document.visibilityState` 变成 `hidden`，WebKit 随即挂起渲染、
            // 停止下载字体分片、并冻结长 setTimeout。上一轮扫描因此在第一个
            // 样本后就卡死，内存曲线全程平直，测出来的全是「未渲染」状态。
            // 依赖真实渲染的验收项（#1 滚动、#4 字体分片、#7 内存）必须在
            // 窗口可见时测。测量期间强制置顶，扫描就不需要人守着窗口。
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(true);
                let _ = w.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_memory,
            probe_ready,
            read_text_file,
            save_probe_slot,
            autotest_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
