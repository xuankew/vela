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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = process_start();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe_memory, read_text_file])
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
