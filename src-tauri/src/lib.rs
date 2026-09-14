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
    ("shards", ".m0-shards.json"),
    // 启动心跳：只用同步 IPC 落盘，不依赖任何定时器/rAF。
    // 用来区分「页面 hidden 被 WebKit 冻结」与「JS 根本没跑到 onMount」——
    // 这两者在外部是同一个现象（什么都不写），不记一条就无法分辨。
    ("boot", ".m0-boot.json"),
];

/// 可读槽位。**与可写槽位分开列**：清单是 `scripts/font-manifest.mjs` 生成的输入，
/// 不该被前端写覆盖，所以它只出现在这一侧。
const PROBE_INPUT_SLOTS: &[(&str, &str)] = &[("fonts", ".m0-font-manifest.json")];

#[tauri::command]
fn save_probe_slot(slot: String, json: String) -> Result<String, String> {
    let file = PROBE_SLOTS
        .iter()
        .find(|(name, _)| *name == slot)
        .map(|(_, file)| *file)
        .ok_or_else(|| format!("未知槽位 {slot}"))?;
    let path = report_path(file);
    let bytes = json.len();
    // 旁路记一笔：写盘失败时前端只会静默 catch，外部看不到任何迹象，
    // 于是「调用没发生」和「调用发生但被拒」无法区分。
    match std::fs::write(&path, json) {
        Ok(()) => {
            diag_log(&format!("save OK slot={slot} bytes={bytes} path={}", path.display()));
            Ok(path.display().to_string())
        }
        Err(e) => {
            diag_log(&format!("save ERR slot={slot} bytes={bytes} path={} err={e}", path.display()));
            Err(e.to_string())
        }
    }
}

/// 读回探针的离线输入（目前只有 #4 的分片字节清单）。
///
/// 刻意不复用上面的 `read_text_file`：那个收前端传入的任意路径，是个任意文件读取原语
/// （M0 收尾时和其余脚手架一起删）。这一条同样只认白名单槽位名，前端拼不出路径。
#[tauri::command]
fn load_probe_slot(slot: String) -> Result<String, String> {
    let file = PROBE_INPUT_SLOTS
        .iter()
        .find(|(name, _)| *name == slot)
        .map(|(_, file)| *file)
        .ok_or_else(|| format!("未知槽位 {slot}"))?;
    let path = report_path(file);
    // 同样记旁路：这份清单是 #4 唯一的字节来源，前端读不到时只会把 shards 置空，
    // 从外部看不出到底是清单没生成、还是读取被系统拒了。
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            diag_log(&format!("load OK slot={slot} bytes={}", s.len()));
            Ok(s)
        }
        Err(e) => {
            diag_log(&format!("load ERR slot={slot} path={} err={e}", path.display()));
            Err(format!("{} 读取失败：{e}（先跑 node scripts/font-manifest.mjs）", file))
        }
    }
}

/// 自动化测量的开关：仓库根存在 `.m0-autotest` 时，前端启动后自动跑 #1 的滚动矩阵。
///
/// 做成文件开关而不是常开：矩阵会独占窗口十几秒、反复重建编辑器，
/// 日常启动不该被它劫持。
#[tauri::command]
fn autotest_enabled() -> bool {
    report_path(".m0-autotest").exists()
}

/// 诊断日志：往 `~/Library/Logs/vela-m0-boot.log` 追加一行。
///
/// 为什么需要这条独立信道：用 `open` 启动的 `.app` 与从终端直接跑内层二进制，
/// 在 macOS 上是**两个不同的 TCC 身份**。实测后者能往仓库根写 `.m0-*.json`、
/// 前者一个字都写不出来，而前端每条失败分支都是静默 `catch`——
/// 于是「JS 压根没跑」和「写盘被拒」在外部是同一个现象，只能靠猜，白烧了好几轮启动。
/// home 下的 `Library/Logs` 对两种启动方式都可写，拿它当旁路把两者分开。
///
/// 时间戳自己拼 epoch 毫秒：不为此引一个时间库。
/// M0 收尾时和其余脚手架一起删。
fn diag_log(line: &str) {
    use std::io::Write;
    let Some(home) = std::env::var_os("HOME") else { return };
    let path = std::path::Path::new(&home).join("Library/Logs/vela-m0-boot.log");
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{ms} {line}");
    }
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
            diag_log("setup-enter");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(true);
                let _ = w.set_focus();
                // 窗口的真实状态只有这里拿得到：前端在页面 hidden 时连一行都写不出，
                // 所以「窗口有没有建出来、多大、可见吗」必须由 Rust 侧代记。
                let visible = w.is_visible().unwrap_or(false);
                let size = w.outer_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_default();
                let pos = w.outer_position().map(|p| format!("{},{}", p.x, p.y)).unwrap_or_default();
                // URL 是关键：open 启动下窗口 visible、WebContent 占了 84MB（页面确实加载了），
                // 但 save_probe_slot 一次都没被调用过。要判断前端跑的是哪份页面，
                // 只能由 Rust 侧把它加载的地址记下来。
                let url = w.url().map(|u| u.to_string()).unwrap_or_else(|e| format!("<err {e}>"));
                diag_log(&format!("setup-window visible={visible} size={size} pos={pos} url={url}"));
            } else {
                diag_log("setup-window MISSING");
            }
            Ok(())
        })
        // 完全不依赖前端配合的页面加载观测：JS 一行都没跑时这是唯一的信号源。
        .on_page_load(|webview, payload| {
            diag_log(&format!(
                "page-load {:?} url={}",
                payload.event(),
                payload.url()
            ));
            let _ = webview;
        })
        .invoke_handler(tauri::generate_handler![
            probe_memory,
            probe_ready,
            read_text_file,
            save_probe_slot,
            load_probe_slot,
            autotest_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
