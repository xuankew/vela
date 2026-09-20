//! 把粘贴进来的图片落到磁盘上（PLAN.md §3.5 M3-A-7）。
//!
//! 这一条路的存在理由是：写 Markdown 的人截一张图、`Cmd+V`，期待的是**正文里出现一个
//! 能用的图片链接**，而不是「先把截图存到某个地方，再拖进来，再手打相对路径」。
//! 三步里每一步都可能出错，而错的方式都是「链接写错了，预览里一个破图标」。
//!
//! ## 🔴 目标路径由文档自己推出来，命令**不收**目标目录参数
//!
//! 落地位置永远是 `<文档所在目录>/assets/<Rust 生成的文件名>`。前端能递进来的只有一个
//! 东西：**当前文档的路径**——而那一个本来就来自 dialog 插件。
//!
//! 不收目录参数不是偷懒，是因为收了就等于开了第十六个「前端可以指定任意绝对路径去写」的
//! 口子。`save_file` 那一个已经有 dialog 兜着（路径由系统选择器给出），
//! 而粘贴图片根本没有「让用户选存哪」这一步，没有任何东西兜。
//! 把目录名写死，可写的范围就收敛成「用户已经打开的那个文档旁边」。
//!
//! ⚠️ 代价要说清楚：**`assets/` 这个名字与命名规则都不可配置**。
//! PLAN.md §2 那一行写的是「可配置路径与命名规则」，这一版没有兑现——配置层
//! （`.vela/settings.json`）被用户明确推到了 M4。等 M4 落地之后再把它变成可配的。
//!
//! ## 🔴 文件名由内容哈希生成，**在 Rust 侧**
//!
//! `pasted-<16 位十六进制>.<ext>`。不用时间戳，两个理由：
//! 1. 本地时间格式化需要引依赖（`chrono`），而 UTC 时间戳对中国用户来说读起来差 8 小时，
//!    两个都比哈希差；
//! 2. 哈希让「同一张截图粘两次」自动去重——第二次压根不写盘（见 `reused`）。
//!
//! ⚠️ 但**正确性不依赖哈希质量**。FNV-1a 64 位不是密码学哈希，理论上能撞；
//! 所以撞名时不是「覆盖」也不是「报错」，而是**先比字节**：完全相同就复用，
//! 不同就换 `-1`、`-2` 后缀。哈希撞了最坏的结果是多一个文件，绝不会写坏一份已有的图。
//!
//! ## ⚠️ 格式白名单靠**魔数**，不靠前端报的 MIME
//!
//! 前端递过来的是字节，`ClipboardEvent` 里那个 `file.type` 是浏览器/系统给的、
//! 可以被文件名影响的东西。认字节不认声明，于是「一个改名叫 `.png` 的 HTML」进不来。
//!
//! ⛔ **SVG 明确不在白名单里**，而且是被**主动识别出来单独报错**的：SVG 是 XML，
//! 能带 `<script>` 与外部实体。M3-A 的预览走的是 `innerHTML`，而 `tauri.conf.json`
//! 的 `csp` 是 `null`——一份别人给的 `.md` 里若能塞进一个可执行的 SVG，
//! 拿到的就是全部命令，包括 `save_file`。
//! ⛔ HEIC / AVIF 同样不在：WKWebView 的支持时有时无，GitHub 也不渲染 HEIC，
//! 落一个到处都显示不出来的文件比直接拒绝更糟。
//!
//! ## ⚠️ 落地的图片在 Vela 自己的预览里**不会显示**
//!
//! 这不是 bug，是 M3-A 那条安全边界的直接后果：`src/md/render.ts` 把本地图片映射成
//! `<span class="md-img-local">` 占位符，从不输出 `<img>`——因为 `file:` 不在允许的
//! scheme 里。要让它显示，得启用 Tauri 的 asset protocol，那是一次**主动扩大攻击面**，
//! M3-A-7 刻意不做。粘完的链接在 GitHub / Typora / 导出的 HTML 里都能用，
//! 在 Vela 里是一个占位符。这句话必须原样告诉用户（见 PLAN.md 的 M3-A-7 实施修正）。

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;

use super::write::{write_bytes_atomic, WriteError};

/// 单张图片的上限。
///
/// 32 MiB 比 `MAX_INLINE_BYTES`（4 MiB，正文能进内存的上限）大得多，比
/// `MAX_SHARD_BYTES`（256 MiB）小得多。理由：截图与照片的现实中位数在几百 KB，
/// 超过 32 MiB 的「一张图」几乎一定是用户粘错了东西（比如一个磁盘镜像的片段），
/// 而这一条路会把字节**整个读进内存再哈希**，不设上限的话一次粘贴就能吃掉几 GB。
pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// 落地目录名。**写死的**，理由见模块文档里「不收目标目录参数」那一段。
pub const ASSET_DIR: &str = "assets";

/// 文件名前缀。
const NAME_PREFIX: &str = "pasted";

/// 撞名时最多试多少个数字后缀。
///
/// 撞满 32 次意味着同一个哈希下有 32 份**字节不同**的图——FNV-1a 64 位在现实中
/// 不可能自然发生，能发生的情形是有人手工在 `assets/` 里摆了一堆同名文件。
/// 那时报一句「名字撞满了」比无限循环下去诚实。
const MAX_SUFFIX: u32 = 32;

/// 认得的图片格式。**不上线**：`StoredImage` 里没有它，前端要的是 `rel` 那个完整相对路径，
/// 单独回一个「格式」只会多一处两边要对齐的枚举值。
///
/// ⚠️ 变体与 `ext` **必须一一对应**：扩展名是从魔数推出来的，不是从文件名或 MIME 抄来的，
/// 所以「认成 PNG 就一定写 `.png`」是这一层的不变量。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Bmp,
}

impl ImageKind {
    fn ext(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Jpeg => "jpg",
            ImageKind::Gif => "gif",
            ImageKind::Webp => "webp",
            ImageKind::Bmp => "bmp",
        }
    }

    /// 只看开头几个字节认格式。认不出来返回 `None`——**不猜**。
    ///
    /// 「猜不出来就当成 PNG」这种写法会在用户粘了个 PDF 的时候安静地写出一份
    /// 后缀是 `.png`、内容是 PDF 的文件，然后预览与 GitHub 都显示破图，
    /// 而没有任何一步报过错。
    fn sniff(bytes: &[u8]) -> Option<Self> {
        if starts_with(bytes, b"\x89PNG\r\n\x1a\n") {
            return Some(ImageKind::Png);
        }
        // JPEG 的第三个字节必须是 `FF`：只有 `FF D8` 的话，一个以这两字节开头的
        // 任意二进制都会被认成照片
        if starts_with(bytes, b"\xff\xd8\xff") {
            return Some(ImageKind::Jpeg);
        }
        if starts_with(bytes, b"GIF87a") || starts_with(bytes, b"GIF89a") {
            return Some(ImageKind::Gif);
        }
        if starts_with(bytes, b"BM") {
            return Some(ImageKind::Bmp);
        }
        // WebP 是 RIFF 容器：`RIFF` + 4 字节长度 + `WEBP`。
        // ⚠️ 只看 `RIFF` 会把 WAV 音频与 AVI 视频一起收进来，所以第 8..12 字节必须也对上
        if bytes.len() >= 12 && starts_with(bytes, b"RIFF") && bytes[8..12] == *b"WEBP" {
            return Some(ImageKind::Webp);
        }
        None
    }
}

fn starts_with(bytes: &[u8], magic: &[u8]) -> bool {
    bytes.len() >= magic.len() && bytes[..magic.len()] == *magic
}

/// 一次落地的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredImage {
    /// 相对**文档所在目录**的路径，用正斜杠，可以直接写进 Markdown 的 `![](...)`。
    ///
    /// ⚠️ 正斜杠是写死的，不是 `PathBuf::display()`：这是**文档里的链接**，
    /// 不是文件系统路径。macOS 上两者恰好一样，但把「恰好」当成「所以可以混用」，
    /// 是将来移植到 Windows 时最难查的一类 bug。
    ///
    /// ⚠️ 相对路径意味着**文档被移动之后链接会断**。这是有意的取舍：绝对路径
    /// （`file:///Users/...`）在别人的机器上、在 git 仓库里、在导出的 HTML 里全都失效，
    /// 比「移动文档时要一起搬 assets」差得多。
    pub rel: String,
    /// 绝对路径。前端只用来在提示语里显示，不用来构造链接
    pub path: String,
    pub bytes: u64,
    /// true = 磁盘上本来就有一份**字节完全相同**的，这次没有写盘。
    ///
    /// 前端不该把它当成失败，也不该因此少插一次链接：用户粘了两次同一张图，
    /// 正文里就该有两个引用同一份文件的链接。
    pub reused: bool,
}

/// 落地失败的原因。
///
/// 与 `ReadError` / `WriteError` 同一套路数：`#[serde(tag = "kind")]` 让前端能按类型
/// 分支，而不是去 `message` 里找关键字。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssetError {
    /// 字节不是一种认得的图片格式。`reason` 是一句给人看的说明（含开头的字节）
    Unsupported {
        reason: String,
    },
    /// 超过 [`MAX_IMAGE_BYTES`]
    TooBig {
        bytes: u64,
        limit: u64,
    },
    /// 粘进来的是空的
    Empty,
    /// 文档路径没有目录部分（裸文件名），推不出 `assets/` 该放哪
    NoParent {
        path: String,
    },
    /// 递进来的**传输编码**坏了。
    ///
    /// ⚠️ 本模块自己**从不**产生这一个——它收的已经是字节了。它存在是因为命令层
    /// （`src-tauri/src/commands.rs` 的 `store_image`）要先解一层 base64，而
    /// 「解不开」与「不是图片」必须是两句话：前者是我们自己的 bug（前端编码写错了），
    /// 后者是用户粘了个不该粘的东西。混成一句的话，第一种永远不会被当成 bug 报上来
    BadData {
        reason: String,
    },
    Io {
        reason: String,
        message: String,
    },
}

impl AssetError {
    fn io(err: std::io::Error) -> Self {
        AssetError::Io { reason: format!("{:?}", err.kind()), message: err.to_string() }
    }

    fn write(err: WriteError) -> Self {
        // 不内嵌 `WriteError`：它自己也是 `tag = "kind"` 的内部标签枚举，
        // 嵌进来会序列化成两个 `kind` 字段，前端拿到的是一团坏 JSON
        match err {
            WriteError::Io { reason, message } => AssetError::Io { reason, message },
            WriteError::NoParent { path } => AssetError::NoParent { path },
        }
    }
}

impl std::fmt::Display for AssetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AssetError::Unsupported { reason } => f.write_str(reason),
            AssetError::TooBig { bytes, limit } => {
                write!(f, "这张图有 {} 字节，超过上限 {limit} 字节", bytes)
            }
            AssetError::Empty => f.write_str("粘进来的是空的"),
            AssetError::NoParent { path } => write!(f, "{path} 没有目录部分，推不出 assets/ 的位置"),
            AssetError::BadData { reason } => write!(f, "递过来的图片数据解不开：{reason}"),
            AssetError::Io { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for AssetError {}

/// 把一张图片落到 `doc_path` 旁边的 `assets/` 里。
///
/// `doc_path` 是**当前文档的路径**，只用来推目录，本身不读不写。
pub fn store_image(doc_path: &Path, bytes: &[u8]) -> Result<StoredImage, AssetError> {
    if bytes.is_empty() {
        return Err(AssetError::Empty);
    }
    // 上限检查放在嗅探之前：一张超限的东西压根不该被逐字节哈希一遍
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AssetError::TooBig { bytes: bytes.len() as u64, limit: MAX_IMAGE_BYTES as u64 });
    }
    let kind = ImageKind::sniff(bytes).ok_or_else(|| AssetError::Unsupported { reason: unsupported_reason(bytes) })?;

    let dir = doc_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AssetError::NoParent { path: doc_path.display().to_string() })?;
    let assets = dir.join(ASSET_DIR);

    // `assets` 这个名字上如果已经有一个**文件**，下面每一个候选名都会被
    // `compare_with_existing` 判成「被占了」，循环转满 32 次之后报出来的是
    // 「同名文件撞满了」——一句完全指不到真问题的话。花一次 metadata 把它挑明
    if let Ok(meta) = fs::metadata(&assets) {
        if !meta.is_dir() {
            return Err(AssetError::Io {
                reason: "NotADirectory".to_owned(),
                message: format!("{} 已经存在，而且不是目录，没法把图片放进去", assets.display()),
            });
        }
    }

    let name = file_stem(bytes);
    for suffix in 0..=MAX_SUFFIX {
        let candidate = candidate_name(&name, kind, suffix);
        let dest = assets.join(&candidate);
        match compare_with_existing(&dest, bytes) {
            Existing::Same => {
                return Ok(StoredImage {
                    rel: rel_of(&candidate),
                    path: dest.display().to_string(),
                    bytes: bytes.len() as u64,
                    reused: true,
                })
            }
            Existing::Different => continue,
            Existing::Absent => {}
        }
        // 只有真的要写盘时才建目录：一张都没粘过的项目里不该凭空多一个空 `assets/`
        fs::create_dir_all(&assets).map_err(AssetError::io)?;
        write_bytes_atomic(&dest, bytes).map_err(AssetError::write)?;
        return Ok(StoredImage {
            rel: rel_of(&candidate),
            path: dest.display().to_string(),
            bytes: bytes.len() as u64,
            reused: false,
        });
    }
    Err(AssetError::Io {
        reason: "NameExhausted".to_owned(),
        message: format!("{} 下同名文件已经撞到 {MAX_SUFFIX} 个，没能给这张图起出名字", assets.display()),
    })
}

/// 文件名主干：`pasted-<16 位十六进制>`，不含扩展名。
///
/// ⚠️ 私有：前端拿到的是 `StoredImage::rel`，已经是完整相对路径了。
/// 留在这一层是因为下面的测试要用它算出「这一次会落到哪个名字」，
/// 从而确定性地造出撞名现场——不然那条测试只能靠碰运气
fn file_stem(bytes: &[u8]) -> String {
    format!("{NAME_PREFIX}-{:016x}", content_hash(bytes))
}

/// 生成一个候选文件名。`suffix = 0` 是不带后缀的那个。
fn candidate_name(stem: &str, kind: ImageKind, suffix: u32) -> String {
    let ext = kind.ext();
    if suffix == 0 {
        format!("{stem}.{ext}")
    } else {
        format!("{stem}-{suffix}.{ext}")
    }
}

/// FNV-1a 64 位。
///
/// 手写 12 行而不引 `fnv` crate：`fnv` 虽然已经在 `Cargo.lock` 里（Tauri 传递依赖），
/// 但「已经在 lock 里」不等于「可以直接用」——它是别人的依赖，版本随时会被上游换掉，
/// 而这一层要的是一个不会变的、跨版本稳定的哈希。12 行常量运算没有维护成本。
fn content_hash(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn rel_of(name: &str) -> String {
    // 正斜杠写死，理由在 `StoredImage::rel` 的文档上
    format!("{ASSET_DIR}/{name}")
}

enum Existing {
    Absent,
    Same,
    Different,
}

/// 看 `dest` 上已经有的东西与 `bytes` 是否相同。
///
/// 先比长度再读内容：长度不等就已经能断定不是同一份，省掉一次可能几十 MB 的读盘。
/// 任何「读不出来」的情形（权限、它是个目录、它是个坏符号链接）一律当成
/// `Different`——即「这个名字被占了，换一个」，而不是当成 `Absent` 去覆盖它。
fn compare_with_existing(dest: &Path, bytes: &[u8]) -> Existing {
    let meta = match fs::metadata(dest) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Existing::Absent,
        Err(_) => return Existing::Different,
    };
    if !meta.is_file() || meta.len() != bytes.len() as u64 {
        return Existing::Different;
    }
    match fs::read(dest) {
        Ok(existing) if existing == bytes => Existing::Same,
        _ => Existing::Different,
    }
}

/// 认不出来时给用户看的一句说明。
///
/// 带上开头的字节，是因为「我粘的明明是一张图」与「Vela 说这不是图」之间
/// 唯一的线索就是那几个字节——是 SVG、是 PDF、还是一个截断的下载。
fn unsupported_reason(bytes: &[u8]) -> String {
    if looks_like_svg(bytes) {
        return "SVG 不支持：它是 XML，能带脚本，而预览走的是 innerHTML".to_owned();
    }
    let head: Vec<String> = bytes.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("开头的字节是 {}，不是认得的图片格式（只收 PNG / JPEG / GIF / WebP / BMP）", head.join(" "))
}

/// 粗略判断「这是一段 XML/标签文本，而且开头就是 `<svg`」。
///
/// ⚠️ 只用来**改善报错文案**，不用来做安全判断——安全那一边靠的是白名单：
/// 认不出来的东西一律拒绝，所以「漏判成 SVG」的后果只是提示语不够准，
/// 而「误判成不是 SVG」的后果也只是提示语不够准。
fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let trimmed = head.trim_start_matches('\u{feff}').trim_start();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("<svg")
        || (lower.starts_with("<?xml") && lower.contains("<svg"))
        || (lower.starts_with("<!--") && lower.contains("<svg"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 一张 1×1 的透明 PNG，字节是真的（从 PNG 规范的最小图手搓）
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
        0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    /// 另一份**字节不同**的「PNG」：魔数一样，正文差一个字节
    fn other_png() -> Vec<u8> {
        let mut v = TINY_PNG.to_vec();
        let last = v.len() - 1;
        v[last] ^= 0xff;
        v
    }

    fn doc_in(dir: &Path) -> PathBuf {
        dir.join("note.md")
    }

    #[test]
    fn 五种格式的魔数都认得() {
        assert_eq!(ImageKind::sniff(b"\x89PNG\r\n\x1a\n...."), Some(ImageKind::Png));
        assert_eq!(ImageKind::sniff(b"\xff\xd8\xff\xe0...."), Some(ImageKind::Jpeg));
        assert_eq!(ImageKind::sniff(b"GIF87a...."), Some(ImageKind::Gif));
        assert_eq!(ImageKind::sniff(b"GIF89a...."), Some(ImageKind::Gif));
        assert_eq!(ImageKind::sniff(b"BM........"), Some(ImageKind::Bmp));
        assert_eq!(ImageKind::sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageKind::Webp));
    }

    #[test]
    fn 扩展名与认出来的格式一一对应() {
        assert_eq!(ImageKind::Png.ext(), "png");
        assert_eq!(ImageKind::Jpeg.ext(), "jpg");
        assert_eq!(ImageKind::Gif.ext(), "gif");
        assert_eq!(ImageKind::Webp.ext(), "webp");
        assert_eq!(ImageKind::Bmp.ext(), "bmp");
    }

    /// 🔴 RIFF 容器不止 WebP 一家。只看 `RIFF` 的话，用户粘一段 WAV 音频
    /// 会得到一个后缀是 `.webp`、内容是音频的文件，而没有任何一步报错
    #[test]
    fn riff_容器里只有_webp_算图片() {
        assert_eq!(ImageKind::sniff(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(ImageKind::sniff(b"RIFF\0\0\0\0AVI LIST"), None);
        // 长度不够也算不出第 8..12 字节
        assert_eq!(ImageKind::sniff(b"RIFF\0\0"), None);
    }

    /// ⛔ JPEG 只认 `FF D8` 是不够的：那两字节在任意二进制里都可能出现
    #[test]
    fn jpeg_必须第三个字节也是_ff() {
        assert_eq!(ImageKind::sniff(b"\xff\xd8\x00\x11"), None);
        assert_eq!(ImageKind::sniff(b"\xff\xd8"), None);
    }

    #[test]
    fn 不是图片的东西一律拒绝() {
        for payload in
            [&b"plain text"[..], b"<!DOCTYPE html><script>alert(1)</script>", b"%PDF-1.7 ...", b"PK\x03\x04 a zip", b""]
        {
            assert!(ImageKind::sniff(payload).is_none(), "被误认成图片：{:?}", String::from_utf8_lossy(payload));
        }
    }

    /// ⛔ SVG 是这一层最该挡住的东西。它是 XML，能带 `<script>`；
    /// 预览走 `innerHTML` 且 `csp` 是 null，一份能执行的 SVG 等于交出全部命令
    #[test]
    fn svg_被拒绝并且报错里说是_svg() {
        let svg = b"<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"><script>x</script></svg>";
        assert_eq!(ImageKind::sniff(svg), None);
        let err = store_image(Path::new("/notes/a.md"), svg).unwrap_err();
        match err {
            AssetError::Unsupported { reason } => assert!(reason.contains("SVG"), "报错没提到 SVG：{reason}"),
            other => panic!("期望 Unsupported，实际 {other:?}"),
        }
    }

    #[test]
    fn svg_的各种开头都认得出来() {
        assert!(looks_like_svg(b"<svg width='1'/>"));
        assert!(looks_like_svg(b"  \n <svg/>"));
        assert!(looks_like_svg(b"\xef\xbb\xbf<svg/>"));
        assert!(looks_like_svg(b"<?xml version='1.0'?><svg/>"));
        assert!(looks_like_svg(b"<!-- c --><svg/>"));
        assert!(!looks_like_svg(b"<html><body>hi</body></html>"));
        assert!(!looks_like_svg(TINY_PNG));
    }

    #[test]
    fn 空的与超限的都拒绝() {
        assert!(matches!(store_image(Path::new("/notes/a.md"), b""), Err(AssetError::Empty)));

        // ⚠️ 这是一次 32 MiB + 1 的**全零**分配：上限检查在嗅探与哈希之前，
        // 所以它既不会被逐字节哈希，也不会碰磁盘。零页在 macOS/Linux 上是惰性映射的
        let too_big = vec![0u8; MAX_IMAGE_BYTES + 1];
        match store_image(Path::new("/notes/a.md"), &too_big) {
            Err(AssetError::TooBig { bytes, limit }) => {
                assert_eq!(bytes, (MAX_IMAGE_BYTES + 1) as u64);
                assert_eq!(limit, MAX_IMAGE_BYTES as u64);
            }
            other => panic!("期望 TooBig，实际 {other:?}"),
        }
    }

    #[test]
    fn 刚好在上限内的不会被上限挡掉() {
        // 只断言错误类型不是 TooBig：这份字节不是图片，会走到 Unsupported
        let exact = vec![0u8; MAX_IMAGE_BYTES];
        assert!(matches!(store_image(Path::new("/notes/a.md"), &exact), Err(AssetError::Unsupported { .. })));
    }

    #[test]
    fn 文档路径没有目录部分时报_noparent() {
        // 先给一份真的 PNG，确保失败的原因是路径而不是格式
        match store_image(Path::new("note.md"), TINY_PNG) {
            Err(AssetError::NoParent { path }) => assert_eq!(path, "note.md"),
            other => panic!("期望 NoParent，实际 {other:?}"),
        }
    }

    #[test]
    fn 落地到文档旁边的_assets_并且字节原样() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        fs::write(&doc, "# 标题\n").unwrap();

        let stored = store_image(&doc, TINY_PNG).unwrap();

        assert!(!stored.reused);
        assert_eq!(stored.bytes, TINY_PNG.len() as u64);
        // rel 用正斜杠，且以固定的目录名开头
        assert!(stored.rel.starts_with("assets/pasted-"), "{}", stored.rel);
        assert!(stored.rel.ends_with(".png"), "{}", stored.rel);
        let landed = dir.path().join(ASSET_DIR).join(stored.rel.strip_prefix("assets/").unwrap());
        assert_eq!(fs::read(&landed).unwrap(), TINY_PNG, "落地的字节被改动了");
        assert_eq!(stored.path, landed.display().to_string());
    }

    /// ⚠️ 一张都没粘过的项目里不该凭空多一个空 `assets/`：
    /// 那会出现在 `git status` 里，而用户完全不知道它是哪来的
    #[test]
    fn 拒绝的时候不会建出空目录() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        fs::write(&doc, "# 标题\n").unwrap();

        assert!(store_image(&doc, b"not an image").is_err());
        assert!(!dir.path().join(ASSET_DIR).exists(), "失败的路径上建出了 assets/");
    }

    #[test]
    fn 同一份字节粘两次会复用而不是多写一个文件() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        let first = store_image(&doc, TINY_PNG).unwrap();
        let second = store_image(&doc, TINY_PNG).unwrap();

        assert!(!first.reused);
        assert!(second.reused, "第二次没有复用");
        assert_eq!(first.rel, second.rel);
        assert_eq!(names_in(dir.path()), vec![first.rel.strip_prefix("assets/").unwrap().to_owned()]);
    }

    /// 🔴 正确性不依赖哈希质量：名字被一份**内容不同**的文件占了，就换后缀，
    /// 绝不覆盖。这一条用 `file_stem` 确定性地造出撞名现场
    #[test]
    fn 撞名但内容不同时换后缀而不覆盖() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        let assets = dir.path().join(ASSET_DIR);
        fs::create_dir_all(&assets).unwrap();

        let occupied = candidate_name(&file_stem(TINY_PNG), ImageKind::Png, 0);
        fs::write(assets.join(&occupied), b"someone else's bytes, same length? no").unwrap();

        let stored = store_image(&doc, TINY_PNG).unwrap();
        assert!(!stored.reused);
        assert_eq!(stored.rel, format!("assets/{}", candidate_name(&file_stem(TINY_PNG), ImageKind::Png, 1)));
        // 原来那份一个字都没动
        assert_eq!(fs::read(assets.join(&occupied)).unwrap(), b"someone else's bytes, same length? no");
        assert_eq!(fs::read(assets.join(stored.rel.strip_prefix("assets/").unwrap())).unwrap(), TINY_PNG);
    }

    /// ⚠️ 少了这一条，用户看到的是「同名文件撞满了 32 个」——一句指不到真问题的话。
    /// 一个项目里恰好有个叫 `assets` 的**文件**是完全可能的（比如一份没有扩展名的清单）
    #[test]
    fn assets_这个名字上是个文件时把话说清楚() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        fs::write(dir.path().join(ASSET_DIR), b"i am a file, not a directory").unwrap();

        match store_image(&doc, TINY_PNG) {
            Err(AssetError::Io { reason, message }) => {
                assert_eq!(reason, "NotADirectory");
                assert!(message.contains("不是目录"), "{message}");
            }
            other => panic!("期望「不是目录」的错误，实际 {other:?}"),
        }
        // 原来那个文件一个字都没动
        assert_eq!(fs::read(dir.path().join(ASSET_DIR)).unwrap(), b"i am a file, not a directory");
    }

    #[test]
    fn 目标名字上是个目录时也会让开() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        let assets = dir.path().join(ASSET_DIR);
        fs::create_dir_all(assets.join(candidate_name(&file_stem(TINY_PNG), ImageKind::Png, 0))).unwrap();

        let stored = store_image(&doc, TINY_PNG).unwrap();
        assert!(stored.rel.ends_with("-1.png"), "{}", stored.rel);
    }

    #[test]
    fn 后缀撞满时报错而不是无限循环() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        let assets = dir.path().join(ASSET_DIR);
        fs::create_dir_all(&assets).unwrap();
        let stem = file_stem(TINY_PNG);
        // 0..=MAX_SUFFIX 一共 MAX_SUFFIX + 1 个名字，全部用**长度不同**的内容占掉，
        // 于是每一个都在长度比较那一步就被判成 Different，一次读盘都不用
        for suffix in 0..=MAX_SUFFIX {
            let name = candidate_name(&stem, ImageKind::Png, suffix);
            let filler = vec![b'x'; 8 + usize::try_from(suffix).unwrap()];
            fs::write(assets.join(name), filler).unwrap();
        }

        match store_image(&doc, TINY_PNG) {
            Err(AssetError::Io { reason, message }) => {
                assert_eq!(reason, "NameExhausted");
                assert!(message.contains(&MAX_SUFFIX.to_string()), "{message}");
            }
            other => panic!("期望名字撞满的错误，实际 {other:?}"),
        }
    }

    #[test]
    fn 不同的图片各自落到各自的名字() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        let a = store_image(&doc, TINY_PNG).unwrap();
        let b = store_image(&doc, &other_png()).unwrap();

        assert_ne!(a.rel, b.rel);
        assert!(!b.reused);
        assert_eq!(names_in(dir.path()).len(), 2);
    }

    #[test]
    fn 落地之后目录里不留临时文件() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        store_image(&doc, TINY_PNG).unwrap();
        let leftovers: Vec<String> = names_in(dir.path());
        assert_eq!(leftovers.len(), 1, "assets/ 里有别的东西：{leftovers:?}");
        assert!(!leftovers[0].contains("vela-tmp"), "{}", leftovers[0]);
    }

    /// 已经存在的 assets/ 里原本有用户的文件，不能被顺手清掉
    #[test]
    fn 已有的_assets_目录内容不受影响() {
        let dir = tempfile::tempdir().unwrap();
        let doc = doc_in(dir.path());
        let assets = dir.path().join(ASSET_DIR);
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("logo.png"), b"the user's own file").unwrap();

        store_image(&doc, TINY_PNG).unwrap();

        assert_eq!(fs::read(assets.join("logo.png")).unwrap(), b"the user's own file");
        assert_eq!(names_in(dir.path()).len(), 2);
    }

    #[test]
    fn 同一份字节在不同文档下各落一份() {
        // 哈希只认内容，不认文档——于是两篇笔记粘同一张图会得到**两个不同目录下的同名文件**。
        // 这是对的：链接是相对路径，共用一份就得有一篇的链接指到别的目录去
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one").join("a.md");
        let two = dir.path().join("two").join("b.md");
        fs::create_dir_all(one.parent().unwrap()).unwrap();
        fs::create_dir_all(two.parent().unwrap()).unwrap();

        let a = store_image(&one, TINY_PNG).unwrap();
        let b = store_image(&two, TINY_PNG).unwrap();

        assert_eq!(a.rel, b.rel, "相对路径本该一样");
        assert_ne!(a.path, b.path, "绝对路径本该不一样");
        assert!(!b.reused);
    }

    #[test]
    fn 目录跟着文档走而不是跟着进程的工作目录走() {
        // 推出来的是 `<文档所在目录>/assets`，不是 `./assets`：Vela 的当前工作目录
        // 是启动它的地方（终端、Finder、`pnpm tauri dev`），跟用户打开的项目毫无关系
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("deep");
        fs::create_dir_all(&nested).unwrap();
        let doc = nested.join("a.md");
        let stored = store_image(&doc, TINY_PNG).unwrap();
        assert!(stored.path.starts_with(nested.to_str().unwrap()), "{}", stored.path);
    }

    #[test]
    fn 哈希对一个字节的改动敏感() {
        assert_ne!(content_hash(TINY_PNG), content_hash(&other_png()));
        // 空输入的哈希是 FNV-1a 的偏移基准，写死下来当回归哨兵
        assert_eq!(content_hash(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(content_hash(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn 文件名主干是十六个十六进制位() {
        let stem = file_stem(TINY_PNG);
        let hex = stem.strip_prefix("pasted-").unwrap();
        assert_eq!(hex.len(), 16, "{stem}");
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{stem}");
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(dir.join(ASSET_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }
}
