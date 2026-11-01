//! 把**文档自己引用的**本地图片读出来，给预览用（PLAN.md §3.5 M7-9）。
//!
//! ## 为什么这一条路存在
//!
//! `src/md/render.ts` 从来不给本地路径出 `<img>`：webview 的 base 是应用自己的源
//! （`tauri://localhost`），`src="assets/a.png"` 必然 404，所以它输出一个
//! `<span class="md-img-local">` 占位。M3-A-7 把图片落到 `<文档目录>/assets/` 之后，
//! 用户看到的是「我粘的图在 Vela 里只有一个虚线下边框」，而 Typora / GitHub 反而能显示。
//! 这一层补的就是那一句「组件层可以据实解析」里的「解析」。
//!
//! ## ⚠️ 正文里那层百分号编码是**文件名的一部分**还是**传输形式**？
//!
//! 是传输形式，所以进这一层之前要解掉——`clean_ref` 干的就是这件事，完整理由在它的文档上。
//! 一句话版本：`src/md/linkPath.ts` 生成链接时对空格写 `%20`，而 Markdown 的
//! `![](...)` 括号里压根容不下一个裸空格，所以不解这一层码的话，
//! 「Vela 自己写进正文的链接指向的那张图」在预览里永远是个占位。
//!
//! ⚠️ 解码发生在**剥掉 `#`/`?` 之后**、`join` 之前。那个顺序不是风格问题：
//! 一个真叫 `a#b.png` 的文件写成 `a%23b.png`，先解码就会让后面的片段剥离把它拦腰截断。
//! 也正因为这里会解出 `..`（`%2e%2e`），下面那条「先 join 再 canonicalize」才是**唯一**
//! 站得住的做法——任何字符串层面的 `..` 检查都晚了。
//!
//! ## 🔴 唯一的边界：目标必须落在**文档自己所在的那个目录**里面
//! 调用方递进来的是「当前显示的那份文档的路径」＋「正文里写的那个引用」，
//! 而返回的字节只会进 `<img>`。放开的范围是「这篇文档旁边的文件」，
//! 不是「磁盘」。实现上靠两步：`doc` 的目录与解析后的目标都 `canonicalize`（顺带把
//! 符号链接、`..`、重复分隔符全部消化掉），然后要求目标 `starts_with` 那个目录。
//!
//! ⚠️ **先 join 再 canonicalize，而不是先检查字符串里有没有 `..`**：后者挡不住
//! `a/%2e%2e/b`（解码之后才是 `..`）、挡不住符号链接，而只要 canonicalize 在后面，
//! 这两种都在比较那一步露出来。字符串检查一种都不用。
//!
//! 🔴 **认魔数，不认扩展名**。正文里写着 `![](notes.txt)` 也照样会被当成图片引用递过来，
//! 而它不是图片——被拒掉不是因为后缀，是因为开头的字节不对。这与 `super::asset`
//! 拒绝「改名叫 `.png` 的 HTML」用的是同一条理由：⛔ 尤其不放行 SVG，
//! 它是 XML、能带 `<script>`，而预览走 `innerHTML` 且 `csp` 是 `null`。
//!
//! ## 与 `super::asset`（落地那一条）的分工
//!
//! 那边管**写**：目录写死成 `assets/`、名字由内容哈希生成、不收目标路径参数。
//! 这一边管**读**：目标由文档正文决定，所以必须自己把范围钉住。
//! 两条路共用同一套魔数白名单（`ImageKind`），于是「能粘进来的格式」与
//! 「能显示出来的格式」天然是同一个集合，不会出现「落得进去、显示不出来」这种
//! 需要用户去猜的缝。
//!
//! ## ⚠️ 已知会 stale
//!
//! 响应刻意不带缓存控制头（见 `src-tauri/src/imgproto.rs`），于是同一篇文档里的
//! 图片被外部替换掉之后，预览可能还显示旧的那一份，直到预览关掉重开。
//! 选这一侧是因为另一侧更糟：一次防抖重画就把二十张图重新读盘 + 重新解码。
//! 真机上如果这条咬人，加 `?v=<mtime>` 是正解，而 `mtime` 这一层已经拿得到。

use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

use super::asset::{unsupported_reason, ImageKind, MAX_IMAGE_BYTES};

/// 一次成功读取的结果。
///
/// ⚠️ 这个类型**不经过 serde**：它的字节是走自定义协议直接当响应体发出去的
/// （`src-tauri/src/imgproto.rs`），不走 invoke、不进 JSON。这正是选协议而不是
/// 选「IPC 回 base64」的原因——一份 32 MB 的图编成 base64 会多出约 11 MB 的字符串，
/// 两头各解析一次，而那点钱本来不必花。
#[derive(Debug)]
pub struct LocalImage {
    /// 原始字节，一个都不改
    pub bytes: Vec<u8>,
    /// 从魔数推出来的 MIME
    pub mime: &'static str,
    /// canonical 之后的绝对路径。只用来在 devtools 里对账，不进响应头
    pub path: String,
}

/// 读不出来的原因。
///
/// 与 `AssetError` / `ReadError` 同一套路数：变体就是「该说哪句话」，
/// 调用方不许去 `message` 里找关键字。
#[derive(Debug)]
pub enum LocalImageError {
    /// 文档路径没有目录部分（裸文件名，或还没存过的草稿）——推不出「哪个目录算文档自己」
    NoParent {
        path: String,
    },
    /// 正文里的引用是空的，像 `![]()`
    EmptyRef,
    /// 解析之后跑到了文档目录外面
    Escaped {
        dir: String,
    },
    /// 那个位置上没有文件，或者它是个目录
    NotFound {
        path: String,
    },
    /// 开头字节不是一种认得的图片格式。`reason` 给人看（含开头的字节）
    NotImage {
        reason: String,
    },
    /// 超过 [`MAX_IMAGE_BYTES`]
    TooBig {
        bytes: u64,
        limit: u64,
    },
    Io {
        reason: String,
        message: String,
    },
}

impl LocalImageError {
    fn io(err: std::io::Error) -> Self {
        LocalImageError::Io { reason: format!("{:?}", err.kind()), message: err.to_string() }
    }
}

impl std::fmt::Display for LocalImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LocalImageError::NoParent { path } => write!(f, "{path} 没有目录部分，推不出图片该在哪个目录里找"),
            LocalImageError::EmptyRef => f.write_str("图片引用是空的"),
            LocalImageError::Escaped { dir } => write!(f, "这个引用指到了文档目录（{dir}）外面，不予读取"),
            LocalImageError::NotFound { path } => write!(f, "{path} 不存在"),
            LocalImageError::NotImage { reason } => f.write_str(reason),
            LocalImageError::TooBig { bytes, limit } => {
                write!(f, "这张图有 {bytes} 字节，超过上限 {limit} 字节")
            }
            LocalImageError::Io { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for LocalImageError {}

/// 读 `doc_path` 那篇文档引用的本地图片 `ref_raw`。
///
/// `ref_raw` 是**已经解码过**的那个引用（`%20` 已经变成空格），因为「URL 传输形式」
/// 与「文件系统的名字」是两件事，解码归协议层（`imgproto.rs`），归一化与判定归这里。
pub fn read_local_image(doc_path: &Path, ref_raw: &str) -> Result<LocalImage, LocalImageError> {
    let dir = doc_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| LocalImageError::NoParent { path: doc_path.display().to_string() })?;

    let cleaned = clean_ref(ref_raw);
    if cleaned.is_empty() {
        return Err(LocalImageError::EmptyRef);
    }

    // `dir.join(absolute)` 会**整段替换**成那个绝对路径——这里要的就是这个行为：
    // 正文写 `![](/Users/me/notes/a.png)` 也算文档目录里的引用，判据在下一步而不是这一步
    let joined = dir.join(cleaned);
    let canon_dir = canonicalize(dir).ok_or_else(|| LocalImageError::NotFound { path: dir.display().to_string() })?;
    let canon = match joined.canonicalize() {
        Ok(canon) => canon,
        // 只把「确实不存在」翻译成 NotFound；权限、不是目录这些另有其话
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Err(LocalImageError::NotFound { path: joined.display().to_string() })
        }
        Err(err) => return Err(LocalImageError::io(err)),
    };
    if !canon.starts_with(&canon_dir) {
        return Err(LocalImageError::Escaped { dir: canon_dir.display().to_string() });
    }

    let bytes = read_capped(&canon)?;
    if bytes.is_empty() {
        return Err(LocalImageError::NotFound { path: canon.display().to_string() });
    }
    // 上限在嗅探**之前**：`read_capped` 最多只会读回 `MAX + 1` 个字节，
    // 所以「2 GB 的一张假图」在这里已经只是一次 33 MB 的读，而下面的判定会当场拒掉它
    if bytes.len() > MAX_IMAGE_BYTES {
        // ⚠️ 报出去的大小取 `metadata`，不是取读回来的长度。读回来的那一串是被 `take`
        // 截断过的，它恒等于 `MAX + 1`，直接 -1 就得到「这张图有 33554432 字节，
        // 超过上限 33554432 字节」这种自相矛盾的话。**判定**仍然只依据截断后的那次读
        // （那才是 TOCTOU 安全的），`metadata` 只服务于这句文案
        let real = fs::metadata(&canon).map(|m| m.len()).unwrap_or(bytes.len() as u64);
        return Err(LocalImageError::TooBig { bytes: real, limit: MAX_IMAGE_BYTES as u64 });
    }
    let kind =
        ImageKind::sniff(&bytes).ok_or_else(|| LocalImageError::NotImage { reason: unsupported_reason(&bytes) })?;

    Ok(LocalImage { bytes, mime: kind.mime(), path: canon.display().to_string() })
}

/// 把正文里那个引用收拾成一个可以用来 join 的名字。
///
/// 去掉的只有 `?` / `#` 之后的那一段：`![](a.png#wide)` 指的是同一张图，
/// 而磁盘上没有哪个文件叫 `a.png#wide`。**不去反斜杠、不去 `..`、不做大小写折叠**——
/// 那些要么是该报错的（`..` 由目录比较那一处负责），要么是平台语义（反斜杠在
/// macOS 上就是文件名里的一个字符）。
///
/// ⚠️ 代价：一个**名字里真带 `#` 或 `?`** 的文件在这里会被读不到。那是可接受的一侧，
/// 因为 Markdown 本来要求那种写法转义；反过来如果不去，每一个带锚点的引用都会 miss。
fn clean_ref(raw: &str) -> String {
    let cut = raw.find(['?', '#']).unwrap_or(raw.len());
    percent_decode(raw[..cut].trim())
}

/// 把 Markdown 里那层百分号编码解回真实的文件名。
///
/// 🔴 必须解，因为**我们自己的链接生成器就在写编码后的目标**：`src/md/linkPath.ts`
/// 对空格、括号、`#` 一律转成 `%20` 那类（那是 CommonMark 的语法要求——`(...)` 里不能有空格）。
/// 不解的话，`![](assets/截图%201.png)` 会去找一个名字里真带 `%20` 的文件，而 GitHub、
/// Typora 与浏览器都找对那一张。症状是「在别的编辑器里能显示的图，在 Vela 里是个占位」。
///
/// ⚠️ 顺序是**先剥 `#`/`?` 与空白，再解码**，反过来会解错：一个真叫 `a#b.png` 的文件
/// 写进正文是 `a%23b.png`，先解码就变成 `a#b.png`，再剥片段只剩 `a`
///
/// 只把**合法的** `%XX` 当转义，其余原样留着。这不是宽容，是正确：一个真叫 `100%.png`
/// 的文件写成 `100%25.png` 或直接写 `100%.png` 都能落到磁盘上那个名字，
/// 而「看见 `%` 就报错」会让前者压根显示不出来
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    if !bytes.contains(&b'%') {
        return input.to_owned();
    }
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // ⚠️ 解码之后可能不再是合法的 UTF-8（`%FF%FE` 那种），而后面要拿它当路径名。
    // `from_utf8_lossy` 会把坏字节换成 U+FFFD——名字就变了。所以这里只在**解出来是
    // 合法 UTF-8** 时才采用结果，否则退回原样：宁可少显示一张图，也不要静默改名字
    String::from_utf8(out).unwrap_or_else(|_| input.to_owned())
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// canonicalize 但容忍「这个目录不存在」之外的错误——调用方只需要一个比较基准。
///
/// ⚠️ 不直接吃 `Path::canonicalize` 的错误，是因为文档目录在极窄的窗口里可能被删
/// （外部改动监听那条链上真会发生），那时要说的是「这份文档的目录没了」而不是
/// 一次 panic。翻译成 `None` 之后由调用方给一句 `NotFound`
fn canonicalize(path: &Path) -> Option<PathBuf> {
    path.canonicalize().ok()
}

/// 读最多 `MAX_IMAGE_BYTES + 1` 个字节。
///
/// 🔴 用 `take()` 而不是「先 `metadata()` 看长度、再 `fs::read`」：那两步之间文件可以被
/// 换成一个 2 GB 的，于是检查形同虚设而内存已经吃进去了。`take` 是**读的时候**截断，
/// 多读那一个字节就足以判定「超了」。
fn read_capped(path: &Path) -> Result<Vec<u8>, LocalImageError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Err(LocalImageError::NotFound { path: path.display().to_string() })
        }
        Err(err) => return Err(LocalImageError::io(err)),
    };
    let mut buf = Vec::new();
    file.by_ref().take(MAX_IMAGE_BYTES as u64 + 1).read_to_end(&mut buf).map_err(LocalImageError::io)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    /// 与 `asset.rs` 里那张同一份：1×1 透明 PNG
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
        0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    /// 造一个「文档在 `dir/note.md`，`dir/assets/a.png` 是真图」的现场
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("a.png"), TINY_PNG).unwrap();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# 标题\n").unwrap();
        (dir, doc)
    }

    #[test]
    fn 文档旁边的图能读出来并且字节原样() {
        let (_dir, doc) = fixture();
        let got = read_local_image(&doc, "assets/a.png").unwrap();
        assert_eq!(got.bytes, TINY_PNG, "读回来的字节被改动了");
        assert_eq!(got.mime, "image/png");
    }

    #[test]
    fn 五种格式都能认出来并给出_mime() {
        let cases: [(&[u8], &str); 5] = [
            (b"\x89PNG\r\n\x1a\n....", "image/png"),
            (b"\xff\xd8\xff\xe0....", "image/jpeg"),
            (b"GIF89a....", "image/gif"),
            (b"BM........", "image/bmp"),
            (b"RIFF\0\0\0\0WEBPVP8 ", "image/webp"),
        ];
        for (bytes, want) in cases {
            assert_eq!(ImageKind::sniff(bytes).unwrap().mime(), want);
        }
    }

    /// 🔴 这一条是整个模块的存在理由：正文里写 `![](../../.ssh/id_rsa)` 不能读到东西。
    /// 而且它**不是**靠字符串里找 `..` 挡的——把 `..` 写成编码形式也一样挡不住，
    /// 而这里挡它的是「canonical 之后比对目录」那一步
    #[test]
    fn 跑到文档外面去的引用一律拒绝() {
        // 现场：parent/secret.png 与 parent/notes/note.md。文档目录是 `notes/`，
        // 于是那张图在**外面**，任何形式的相对写法都读不到它
        let parent = tempfile::tempdir().unwrap();
        let inner = parent.path().join("notes");
        fs::create_dir_all(inner.join("assets")).unwrap();
        fs::write(inner.join("note.md"), "# t\n").unwrap();
        fs::write(inner.join("assets/a.png"), TINY_PNG).unwrap();
        fs::write(parent.path().join("secret.png"), TINY_PNG).unwrap();

        let doc = inner.join("note.md");
        // 这几种写法指的都是**确实存在**的那张外面的图，所以必须先过 canonicalize、
        // 再被目录比较拒掉——拿到的错误必须是 Escaped，这是「边界真的在工作」的证据
        for evil in [
            "../secret.png",
            "assets/../../secret.png",
            // 绝对形式：路径本身在文档目录外面，那也一样是外面
            parent.path().join("secret.png").to_str().unwrap(),
        ] {
            match read_local_image(&doc, evil) {
                Err(LocalImageError::Escaped { .. }) => {}
                other => panic!("{evil} 本该被拒成 Escaped，实际 {other:?}"),
            }
        }

        // ⚠️ 这一种是**两种拒绝里的一种**，不是漏网：`../../../` 一路走到 tempdir
        // 顶上去了，那个位置压根没有文件，于是 `canonicalize` 先失败在「不存在」上，
        // 根本走不到比较那一步。两条路的共同点是**一个字节都没读**。
        // 刻意不把「先判越界」做在前面：那要先对字符串做词法归一，
        // 而词法归一处理不了符号链接，等于多写一份与 canonicalize 平行、但更弱的实现，
        // 只为了让报错文案更准
        match read_local_image(&doc, "./assets/../../../secret.png") {
            Err(LocalImageError::Escaped { .. }) | Err(LocalImageError::NotFound { .. }) => {}
            other => panic!("越界又不存在的路径本该被拒，实际 {other:?}"),
        }
    }

    /// 🔴 符号链接是字符串检查那一类做法唯一挡不住的一种，所以单独钉一条：
    /// 目录里躺着一个指向目录外的符号链接，也不算「在这个目录里」
    #[test]
    fn 符号链接指到外面去也拒绝() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("real.png"), TINY_PNG).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# t\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("real.png"), dir.path().join("link.png")).unwrap();

        match read_local_image(&doc, "link.png") {
            Err(LocalImageError::Escaped { .. }) => {}
            other => panic!("符号链接本该被拒，实际 {other:?}"),
        }
    }

    #[test]
    fn 绝对路径的引用只要落在文档目录里就允许() {
        // `![](/Users/me/notes/a.png)` 是同一张图，不该因为写成绝对形式就拒绝：
        // 判据只有一条——canonical 之后在不在文档目录里
        let (_dir, doc) = fixture();
        let abs = doc.parent().unwrap().join("assets/a.png");
        let abs_ref = abs.to_str().unwrap();
        // ⚠️ tempfile 给的路径本身可能带 `/private` 前缀差异，所以只断言「不是 Escaped」
        let got = read_local_image(&doc, abs_ref);
        assert!(got.is_ok(), "文档目录内的绝对引用被拒了：{got:?}");
    }

    #[test]
    fn 不是图片的东西拒绝而不是当成图片回() {
        let (dir, doc) = fixture();
        let assets = dir.path().join("assets");
        fs::write(assets.join("note.txt"), b"just text").unwrap();
        fs::write(assets.join("evil.html"), b"<script>alert(1)</script>").unwrap();

        for name in ["note.txt", "evil.html"] {
            match read_local_image(&doc, &format!("assets/{name}")) {
                Err(LocalImageError::NotImage { .. }) => {}
                other => panic!("{name} 本该被拒成 NotImage，实际 {other:?}"),
            }
        }
    }

    /// ⛔ SVG 与落地那一条同一个口径：它是 XML、能带脚本，而预览是 `innerHTML`
    #[test]
    fn svg_读不出来并且报错里说是_svg() {
        let (dir, doc) = fixture();
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>x</script></svg>";
        fs::write(dir.path().join("assets/icon.svg"), svg).unwrap();

        match read_local_image(&doc, "assets/icon.svg") {
            Err(LocalImageError::NotImage { reason }) => assert!(reason.contains("SVG"), "{reason}"),
            other => panic!("期望 NotImage，实际 {other:?}"),
        }
    }

    #[test]
    fn 不存在的与空引用各说一句话() {
        let (_dir, doc) = fixture();
        assert!(matches!(read_local_image(&doc, "assets/missing.png"), Err(LocalImageError::NotFound { .. })));
        assert!(matches!(read_local_image(&doc, ""), Err(LocalImageError::EmptyRef)));
        // 只剩锚点那一段的引用，收拾完就是空的
        assert!(matches!(read_local_image(&doc, "#wide"), Err(LocalImageError::EmptyRef)));
    }

    #[test]
    fn 文档路径没有目录部分时报_noparent() {
        match read_local_image(Path::new("note.md"), "assets/a.png") {
            Err(LocalImageError::NoParent { path }) => assert_eq!(path, "note.md"),
            other => panic!("期望 NoParent，实际 {other:?}"),
        }
    }

    #[test]
    fn 去掉锚点与查询那一段再去文件系统找() {
        let (dir, doc) = fixture();
        fs::write(dir.path().join("assets/b.png"), TINY_PNG).unwrap();
        for ref_raw in ["assets/b.png#wide", "assets/b.png?v=2", "assets/b.png?a=1#x"] {
            assert!(read_local_image(&doc, ref_raw).is_ok(), "{ref_raw} 本该命中");
        }
    }

    #[test]
    fn 名字里带空格的引用照常能读() {
        let (dir, doc) = fixture();
        fs::write(dir.path().join("assets/my pic.png"), TINY_PNG).unwrap();
        assert!(read_local_image(&doc, "assets/my pic.png").is_ok());
    }

    /// 🔴 这一条钉的是与本仓库**自己的**链接生成器互通：`src/md/linkPath.ts` 对空格与
    /// 非 ASCII 一律写成 `%20` 那种形式（CommonMark 的语法要求：`(...)` 里不能有空格）。
    /// 不解这一层的码，「Vela 自己生成的链接指向的那张图」在预览里就是个占位，
    /// 而 GitHub、Typora 与浏览器都显示得出来
    #[test]
    fn 正文里的百分号编码先解回文件名再找() {
        let (dir, doc) = fixture();
        fs::write(dir.path().join("assets/截图 1.png"), TINY_PNG).unwrap();
        assert!(read_local_image(&doc, "assets/截图%201.png").is_ok(), "空格没解码");
        assert!(read_local_image(&doc, "assets/%E6%88%AA%E5%9B%BE%201.png").is_ok(), "非 ASCII 没解码");
    }

    /// ⚠️ 一个真叫 `100%.png` 的文件在正文里可以直接那么写：`%.p` 不是合法转义，
    /// 所以那个 `%` 必须原样留着。「看见 `%` 就报错」会让这张图压根显示不出来
    #[test]
    fn 不是合法转义的百分号原样留着() {
        let (dir, doc) = fixture();
        fs::write(dir.path().join("assets/100%.png"), TINY_PNG).unwrap();
        assert!(read_local_image(&doc, "assets/100%.png").is_ok(), "把没转义的 `%` 解坏了");
        assert!(read_local_image(&doc, "assets/100%25.png").is_ok(), "`%25` 没解成一个百分号");
    }

    /// 🔴 顺序错了就解不开这一条：`a%23b.png` 先解码会变成 `a#b.png`，
    /// 而剥片段那一步只看**编码之后**的串，于是剩下的 `#b.png` 被当片段扔掉，
    /// 找的是 `assets/a`。所以必须「先剥、后解」
    #[test]
    fn 先剥片段再解码_所以名字里的井号能用() {
        let (dir, doc) = fixture();
        fs::write(dir.path().join("assets/a#b.png"), TINY_PNG).unwrap();
        assert!(read_local_image(&doc, "assets/a%23b.png").is_ok(), "名字里的井号被当成片段剥掉了");
    }

    #[test]
    fn percent_decode_只认合法的转义() {
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("a%25b"), "a%b");
        assert_eq!(percent_decode("%E6%88%AA"), "截");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("a%2"), "a%2", "结尾不完整的转义不该吃掉尾巴");
        assert_eq!(percent_decode("a%"), "a%");
        // 解出来不是合法 UTF-8 的整套退回原样，而不是 lossy 换成 U+FFFD 去改名字
        assert_eq!(percent_decode("a%FFb"), "a%FFb");
    }

    /// `%FF%FE` 解不出合法的 UTF-8 → 原样去找那个名字 → 磁盘上没有 → `NotFound`。
    /// 这一条钉的是「宁可说这张图找不到，也不要静默改文件名」
    #[test]
    fn 解出坏_utf8_的引用说的是找不到而不是名字被改了() {
        let (_dir, doc) = fixture();
        assert!(matches!(read_local_image(&doc, "assets/%FF%FE.png"), Err(LocalImageError::NotFound { .. })));
    }

    /// 🔴 超限的东西**不会**被整个读进内存：`take` 在流上截断，
    /// 所以这一条造一个 32 MiB + 2 的文件，而断言只看错误类型。
    /// 多留一个字节是因为读回来的长度是「截断后」的，那一个字节就是「超了」的证据
    #[test]
    fn 超过上限的图拒绝而不返回字节() {
        let (dir, doc) = fixture();
        let big = dir.path().join("assets/big.png");
        let mut file = fs::File::create(&big).unwrap();
        // 前面是真的 PNG 魔数，后面填零到超限
        file.write_all(TINY_PNG).unwrap();
        let pad = vec![0u8; MAX_IMAGE_BYTES + 2 - TINY_PNG.len()];
        file.write_all(&pad).unwrap();
        drop(file);

        match read_local_image(&doc, "assets/big.png") {
            Err(LocalImageError::TooBig { bytes, limit }) => {
                assert_eq!(limit, MAX_IMAGE_BYTES as u64);
                // ⚠️ 钉的是「报出去的大小必须**大于**上限」：读回来的那一串被 `take` 截断成
                // `MAX + 1`，拿它 -1 会得到一个正好等于上限的数字，于是提示语变成
                // 「有 33554432 字节，超过上限 33554432 字节」——用户看到的是没超
                assert!(bytes > limit, "报出去的大小是 {bytes}，上限 {limit}：这句话自相矛盾");
                assert_eq!(bytes, (MAX_IMAGE_BYTES + 2) as u64);
            }
            other => panic!("期望 TooBig，实际 {other:?}"),
        }
    }

    #[test]
    fn 目标是目录时报_notoftype_而不是_panic() {
        let (_dir, doc) = fixture();
        // `assets/` 自己就是个目录：能 canonicalize、能 starts_with，但读不出来
        match read_local_image(&doc, "assets") {
            Err(LocalImageError::NotFound { .. }) | Err(LocalImageError::Io { .. }) => {}
            other => panic!("目录不该被当成图片读出来：{other:?}"),
        }
    }

    #[test]
    fn 文档目录不存在时也说一句人话() {
        let dir = tempfile::tempdir().unwrap();
        let ghost = dir.path().join("gone").join("note.md");
        match read_local_image(&ghost, "assets/a.png") {
            Err(LocalImageError::NotFound { .. }) | Err(LocalImageError::Io { .. }) => {}
            other => panic!("期望「目录没了」那两句之一，实际 {other:?}"),
        }
    }

    #[test]
    fn 错误都能显示成一句非空的话() {
        let errs: Vec<LocalImageError> = vec![
            LocalImageError::NoParent { path: "note.md".into() },
            LocalImageError::EmptyRef,
            LocalImageError::Escaped { dir: "/notes".into() },
            LocalImageError::NotFound { path: "/notes/assets/a.png".into() },
            LocalImageError::NotImage { reason: "不是图片".into() },
            LocalImageError::TooBig { bytes: 99, limit: 10 },
            LocalImageError::Io { reason: "PermissionDenied".into(), message: "权限不够".into() },
        ];
        for err in errs {
            assert!(!err.to_string().is_empty(), "{err:?} 显示出来是空的");
        }
    }
}
