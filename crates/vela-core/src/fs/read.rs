//! 读文本文件。

use std::fs;
use std::path::Path;

use serde::Serialize;

use super::encoding::{decode, decode_as};
use super::eol::{detect_eol, normalize_to_lf};
use super::{Encoding, FileFormat, TextFile};

/// 单次 IPC 能传的正文上限（PLAN.md §2.6 定的 4MB）。
///
/// 超过就必须分片或走流式 event——JSON 序列化一个大字符串是 Tauri 编辑器场景的
/// 头号性能陷阱，几十 MB 的文件一次性 invoke 会直接爆内存。
///
/// ⚠️ 口径是**文件字节数**，不是最终 payload：正文经 JSON 转义后可能更大（引号、
/// 反斜杠、控制字符都要转义），而 Tauri 还要在 WKWebView 侧反序列化一次。
/// 真要把这条线卡到字节精确，得在编码后量一次——那要给每个文件多跑一遍编码，
/// 不值当。这里按文件字节数卡，留出转义膨胀的余量由 §2.6 的「4MB」本身承担。
pub const MAX_INLINE_BYTES: u64 = 4 * 1024 * 1024;

/// 读文件失败。
///
/// 用 `#[serde(tag = "kind")]` 而不是把错误压成一个字符串：前端要按类型分支
/// （文件太大 → 提示等待 M2 的只读分片模式；权限不够 → 提示授权；不存在 → 从最近
/// 列表里摘掉）。字符串匹配错误信息是最脆的一类代码。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReadError {
    Io { reason: String, message: String },
    Directory { path: String },
    TooLarge { bytes: u64, limit: u64 },
}

impl ReadError {
    fn io(err: std::io::Error) -> Self {
        ReadError::Io { reason: format!("{:?}", err.kind()), message: err.to_string() }
    }
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Io { message, .. } => f.write_str(message),
            ReadError::Directory { path } => write!(f, "{path} 是目录，不是文件"),
            ReadError::TooLarge { bytes, limit } => {
                write!(f, "文件 {bytes} 字节，超过单次传输上限 {limit} 字节")
            }
        }
    }
}

impl std::error::Error for ReadError {}

/// 读一个文本文件，返回归一化为 LF 的正文 + 还原原格式所需的元信息。
///
/// 先看 metadata 再读内容：这样「文件太大」能在**不把它读进内存**的前提下拒掉。
/// 反过来先 read 再判断大小的话，50MB 的文件已经咬掉一口内存了。
pub fn read_text(path: &Path) -> Result<TextFile, ReadError> {
    read_with(path, None)
}

/// 同 `read_text`，但**跳过编码探测**，用调用方指定的编码解。
///
/// 这是「以某编码重新打开」的实现：探测会静默地错（一份 GBK 文件如果字节恰好是
/// 合法 UTF-8，会被判成 utf8 且 `lossy = false`，UI 无从警告），得留一条让用户
/// 自己改判的路。BOM 与 lossy 的语义见 `encoding::decode_as`。
pub fn read_text_as(path: &Path, encoding: Encoding) -> Result<TextFile, ReadError> {
    read_with(path, Some(encoding))
}

fn read_with(path: &Path, forced: Option<Encoding>) -> Result<TextFile, ReadError> {
    let meta = fs::metadata(path).map_err(ReadError::io)?;
    if meta.is_dir() {
        return Err(ReadError::Directory { path: path.display().to_string() });
    }
    let bytes = meta.len();
    if bytes > MAX_INLINE_BYTES {
        return Err(ReadError::TooLarge { bytes, limit: MAX_INLINE_BYTES });
    }

    let raw = fs::read(path).map_err(ReadError::io)?;
    let decoded = match forced {
        Some(encoding) => decode_as(&raw, encoding),
        None => decode(&raw),
    };
    // 行尾必须在归一化**之前**探测，否则就再也分不出原文件是 LF 还是 CRLF 了
    let eol = detect_eol(&decoded.text);
    let text = normalize_to_lf(&decoded.text).into_owned();

    Ok(TextFile {
        text,
        format: FileFormat { encoding: decoded.encoding, bom: decoded.bom, eol },
        lossy: decoded.lossy,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{write_text_atomic, LineEnding};

    #[test]
    fn 读出一个_crlf_文件时正文是_lf_而元信息记着_crlf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("win.txt");
        fs::write(&path, b"a = 1\r\nb = 2\r\n").unwrap();

        let f = read_text(&path).unwrap();
        assert_eq!(f.text, "a = 1\nb = 2\n");
        assert_eq!(f.format.eol, LineEnding::Crlf);
        assert_eq!(f.format.encoding, Encoding::Utf8);
        assert!(!f.format.bom);
        assert!(!f.lossy);
        assert_eq!(f.bytes, 14);
    }

    #[test]
    fn 目录被明确拒绝() {
        let dir = tempfile::tempdir().unwrap();
        match read_text(dir.path()) {
            Err(ReadError::Directory { .. }) => {}
            other => panic!("期望 Directory 错误，实际 {other:?}"),
        }
    }

    #[test]
    fn 不存在的文件报_io_错误并带上_reason() {
        let dir = tempfile::tempdir().unwrap();
        match read_text(&dir.path().join("nope.txt")) {
            Err(ReadError::Io { reason, .. }) => assert_eq!(reason, "NotFound"),
            other => panic!("期望 Io/NotFound，实际 {other:?}"),
        }
    }

    #[test]
    fn 超过上限的文件在读进内存之前就被拒() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        // 只比上限多一个字节：这条测的是判定边界，不是性能
        let big = vec![b'a'; (MAX_INLINE_BYTES + 1) as usize];
        fs::write(&path, &big).unwrap();

        match read_text(&path) {
            Err(ReadError::TooLarge { bytes, limit }) => {
                assert_eq!(bytes, MAX_INLINE_BYTES + 1);
                assert_eq!(limit, MAX_INLINE_BYTES);
            }
            other => panic!("期望 TooLarge，实际 {other:?}"),
        }
    }

    #[test]
    fn 刚好等于上限的文件可以读() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edge.txt");
        fs::write(&path, vec![b'a'; MAX_INLINE_BYTES as usize]).unwrap();
        assert_eq!(read_text(&path).unwrap().text.len(), MAX_INLINE_BYTES as usize);
    }

    #[test]
    fn 有损解码会被标记出来() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.bin");
        fs::write(&path, &[0x61, 0xFF, 0xFF, 0x62]).unwrap();
        assert!(read_text(&path).unwrap().lossy);
    }

    /// `read_text_as` 存在的理由：探测判错的字节，用户能自己改判。
    #[test]
    fn 显式指定编码时跳过探测() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("misdetected.txt");
        // C4 A3 既是合法 UTF-8（"ģ"）也是合法 GBK（"模"）——探测报 utf8 且 lossy = false，
        // 也就是「看起来完全正常，但正文是错的」，UI 无从警告
        fs::write(&path, &[0xC4u8, 0xA3]).unwrap();

        let guessed = read_text(&path).unwrap();
        assert_eq!(guessed.format.encoding, Encoding::Utf8);
        assert!(!guessed.lossy);

        let forced = read_text_as(&path, Encoding::Gbk).unwrap();
        assert_eq!(forced.format.encoding, Encoding::Gbk);
        assert_eq!(forced.text, "模");
        assert!(!forced.lossy);
        // 字节数与走不走探测无关
        assert_eq!(forced.bytes, guessed.bytes);
    }

    /// 换编码只换「怎么解字节」，行尾那一半规矩一条都不能少。
    #[test]
    fn 显式指定编码时行尾照样探测并归一化() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gbk-crlf.txt");
        write_text_atomic(
            &path,
            "第一行\n第二行\n",
            FileFormat { encoding: Encoding::Gbk, bom: false, eol: LineEnding::Crlf },
        )
        .unwrap();

        let f = read_text_as(&path, Encoding::Gbk).unwrap();
        assert_eq!(f.text, "第一行\n第二行\n");
        assert_eq!(f.format.eol, LineEnding::Crlf);
        assert!(!f.lossy);
        // 原样写回去字节不变，与探测路径同一条不变量
        let original = fs::read(&path).unwrap();
        write_text_atomic(&path, &f.text, f.format).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    /// 两条路径共用同一个 helper，所以「目录」与「太大」这两道闸对显式编码同样生效。
    /// 漏掉的话「以某编码重新打开」就成了绕过 4MB 上限的后门。
    #[test]
    fn 显式指定编码时目录与超大文件照样被拒() {
        let dir = tempfile::tempdir().unwrap();
        match read_text_as(dir.path(), Encoding::Gbk) {
            Err(ReadError::Directory { .. }) => {}
            other => panic!("期望 Directory 错误，实际 {other:?}"),
        }

        let path = dir.path().join("big.txt");
        fs::write(&path, vec![b'a'; (MAX_INLINE_BYTES + 1) as usize]).unwrap();
        match read_text_as(&path, Encoding::Gbk) {
            Err(ReadError::TooLarge { .. }) => {}
            other => panic!("期望 TooLarge 错误，实际 {other:?}"),
        }
    }

    #[test]
    fn 空文件读出来是空的_lf_文档() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.txt");
        fs::write(&path, []).unwrap();
        let f = read_text(&path).unwrap();
        assert_eq!(f.text, "");
        assert_eq!(f.bytes, 0);
    }

    /// 端到端：写 → 读 → 写，字节不变。这条守的是「打开再保存不动用户文件」。
    #[test]
    fn 读写往返后字节一致() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rt.txt");
        write_text_atomic(
            &path,
            "第一行\n第二行\n",
            FileFormat { encoding: Encoding::Gbk, bom: false, eol: LineEnding::Crlf },
        )
        .unwrap();
        let original = fs::read(&path).unwrap();

        let f = read_text(&path).unwrap();
        write_text_atomic(&path, &f.text, f.format).unwrap();

        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn display_给出人能读的错误信息() {
        let msg = ReadError::TooLarge { bytes: 5_000_000, limit: MAX_INLINE_BYTES }.to_string();
        assert!(msg.contains("5000000"), "{msg}");
    }
}
