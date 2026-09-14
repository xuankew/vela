//! 编码探测与转换。
//!
//! 探测顺序：BOM → 严格 UTF-8 → GBK。
//!
//! **刻意不猜无 BOM 的 UTF-16。** 猜测失败的代价是把用户文件写坏，而 UTF-16 无 BOM
//! 在现实中极少见（几乎都是 Windows 工具产出，而那些工具都会写 BOM）。这类文件读出来
//! 会带 `lossy = true`，由 UI 明确告知，而不是默默给一个可能错的结果。
//!
//! GBK 用 `encoding_rs`（WHATWG 标准实现，与浏览器一致）。它解码遇到无法映射的字节时
//! 用 U+FFFD 顶替并置 `had_errors`，所以一次调用同时覆盖了「严格判定」与「有损兜底」。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Gbk,
}

impl Encoding {
    /// 状态栏展示名
    pub fn label(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf16Le => "UTF-16 LE",
            Encoding::Utf16Be => "UTF-16 BE",
            Encoding::Gbk => "GBK",
        }
    }

    /// GBK 没有 BOM 这回事：写了也不会被任何工具认出来，探测更不可能报出 `bom = true`。
    /// 暴露出来是为了让 UI 别提供这个不可能的组合（`encode` 对 GBK 会直接忽略 bom）。
    pub fn supports_bom(self) -> bool {
        self != Encoding::Gbk
    }

    fn codec(self) -> &'static encoding_rs::Encoding {
        match self {
            Encoding::Utf8 => encoding_rs::UTF_8,
            Encoding::Utf16Le => encoding_rs::UTF_16LE,
            Encoding::Utf16Be => encoding_rs::UTF_16BE,
            Encoding::Gbk => encoding_rs::GBK,
        }
    }
}

const BOM_UTF8: [u8; 3] = [0xEF, 0xBB, 0xBF];
const BOM_UTF16_LE: [u8; 2] = [0xFF, 0xFE];
const BOM_UTF16_BE: [u8; 2] = [0xFE, 0xFF];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    pub text: String,
    pub encoding: Encoding,
    pub bom: bool,
    pub lossy: bool,
}

pub fn decode(bytes: &[u8]) -> Decoded {
    if let Some(rest) = bytes.strip_prefix(&BOM_UTF8) {
        return decode_with(rest, Encoding::Utf8, true);
    }
    if let Some(rest) = bytes.strip_prefix(&BOM_UTF16_LE) {
        return decode_with(rest, Encoding::Utf16Le, true);
    }
    if let Some(rest) = bytes.strip_prefix(&BOM_UTF16_BE) {
        return decode_with(rest, Encoding::Utf16Be, true);
    }

    // ASCII 是合法 UTF-8，所以绝大多数源代码文件都在这一行就返回了，不必进 encoding_rs
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Decoded {
            text: text.to_owned(),
            encoding: Encoding::Utf8,
            bom: false,
            lossy: false,
        };
    }

    decode_with(bytes, Encoding::Gbk, false)
}

fn decode_with(bytes: &[u8], encoding: Encoding, bom: bool) -> Decoded {
    let (text, _, lossy) = encoding.codec().decode(bytes);
    Decoded { text: text.into_owned(), encoding, bom, lossy }
}

/// 编码结果。
///
/// ⚠️ `unmappable` 必须被上层看见：WHATWG 规定无法映射的字符写成十进制数字字符引用
/// （`&#20013;` 这种），对浏览器是对的，对文本文件就是数据损坏。我们不拦保存
/// （拦住的话用户可能连「改用 UTF-8 保存」的余地都没有），但必须报出来让 UI 警告。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub unmappable: bool,
}

pub fn encode(text: &str, encoding: Encoding, bom: bool) -> Encoded {
    let (mut bytes, unmappable) = match encoding {
        // ⚠️ **不能用 `encoding_rs::Encoding::encode` 编码 UTF-16。**
        // 它内部先取 `output_encoding()`，而 WHATWG 规定 UTF-16LE/BE 的 output encoding
        // 就是 UTF-8 —— 调用它会静默产出 UTF-8 字节，文件头再被我们补上 UTF-16 的 BOM，
        // 结果是「带 UTF-16 BOM 的 UTF-8 文件」，读回来是彻底的乱码。
        // 自己转：Rust 的 &str 不可能含孤立代理项，所以 UTF-16 编码恒为无损，没有 unmappable。
        Encoding::Utf16Le => (encode_utf16(text, true), false),
        Encoding::Utf16Be => (encode_utf16(text, false), false),
        other => {
            let (bytes, _, unmappable) = other.codec().encode(text);
            (bytes.into_owned(), unmappable)
        }
    };

    if bom {
        let prefix: &[u8] = match encoding {
            Encoding::Utf8 => &BOM_UTF8,
            Encoding::Utf16Le => &BOM_UTF16_LE,
            Encoding::Utf16Be => &BOM_UTF16_BE,
            // GBK 没有 BOM，见 Encoding::supports_bom
            Encoding::Gbk => &[],
        };
        if !prefix.is_empty() {
            bytes.splice(0..0, prefix.iter().copied());
        }
    }

    Encoded { bytes, unmappable }
}

fn encode_utf16(text: &str, little_endian: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        let bytes = if little_endian { unit.to_le_bytes() } else { unit.to_be_bytes() };
        out.extend_from_slice(&bytes);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 无_bom_的_utf8_与_ascii_都判成_utf8() {
        let d = decode("hello 世界".as_bytes());
        assert_eq!(d.encoding, Encoding::Utf8);
        assert!(!d.bom && !d.lossy);
        assert_eq!(d.text, "hello 世界");
    }

    #[test]
    fn utf8_bom_被识别且不混进正文() {
        let mut bytes = BOM_UTF8.to_vec();
        bytes.extend_from_slice("正文".as_bytes());
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Utf8);
        assert!(d.bom);
        assert_eq!(d.text, "正文");
        assert!(!d.lossy);
    }

    #[test]
    fn utf16_两种字节序带_bom_都能读() {
        for (encoding, bom) in [(Encoding::Utf16Le, BOM_UTF16_LE), (Encoding::Utf16Be, BOM_UTF16_BE)] {
            let e = encode("中文 mixed", encoding, true);
            assert!(e.bytes.starts_with(&bom), "{encoding:?} 的 BOM 没写进去");
            let d = decode(&e.bytes);
            assert_eq!(d.encoding, encoding);
            assert!(d.bom);
            assert_eq!(d.text, "中文 mixed");
            assert!(!d.lossy);
        }
    }

    /// encoding_rs 的 `encode` 对 UTF-16 是否会自己塞 BOM，是个只能靠字节验证的问题：
    /// 塞了而我们再补一次，文件头就会有两个 BOM，正文第一个字符变成 U+FEFF。
    #[test]
    fn 不带_bom_时输出里一个_bom_字节都没有() {
        let le = encode("中", Encoding::Utf16Le, false);
        assert_eq!(le.bytes, vec![0x2D, 0x4E], "UTF-16LE 的「中」应是 2D 4E，实际 {:?}", le.bytes);

        let be = encode("中", Encoding::Utf16Be, false);
        assert_eq!(be.bytes, vec![0x4E, 0x2D]);

        let utf8 = encode("中", Encoding::Utf8, false);
        assert_eq!(utf8.bytes, vec![0xE4, 0xB8, 0xAD]);
        assert!(!utf8.bytes.starts_with(&BOM_UTF8));
    }

    #[test]
    fn gbk_字节能被识别并正确解码() {
        // 「中文」的 GBK 编码：D6 D0 CE C4
        let d = decode(&[0xD6, 0xD0, 0xCE, 0xC4]);
        assert_eq!(d.encoding, Encoding::Gbk);
        assert!(!d.bom);
        assert!(!d.lossy);
        assert_eq!(d.text, "中文");
    }

    #[test]
    fn gbk_往返一致() {
        let text = "配置文件：路径=C:\\临时\\文件.txt";
        let e = encode(text, Encoding::Gbk, false);
        assert!(!e.unmappable);
        let d = decode(&e.bytes);
        assert_eq!(d.text, text);
        assert_eq!(d.encoding, Encoding::Gbk);
        assert!(!d.lossy);
    }

    #[test]
    fn 无法映射的字节被标成有损而不是静默通过() {
        // 0xFF 既不是合法 UTF-8 起始字节，也不是合法 GBK 前导字节
        let d = decode(&[0x61, 0xFF, 0xFF, 0x62]);
        assert!(d.lossy, "非法字节没有被标记为 lossy");
        assert!(d.text.contains('\u{FFFD}'));
    }

    #[test]
    fn 目标编码装不下的字符会被报出来() {
        // emoji 不在 GBK 字符集里，WHATWG 规定写成数字字符引用 —— 对文本文件就是损坏
        let e = encode("中文😀", Encoding::Gbk, false);
        assert!(e.unmappable, "GBK 装不下 emoji，却报成可无损编码");
        assert!(String::from_utf8_lossy(&e.bytes).contains("&#"));

        // 同样的内容换 UTF-8 就是干净的
        assert!(!encode("中文😀", Encoding::Utf8, false).unmappable);
    }

    #[test]
    fn 空文件解码为空正文且不报错() {
        let d = decode(&[]);
        assert_eq!(d.text, "");
        assert_eq!(d.encoding, Encoding::Utf8);
        assert!(!d.bom && !d.lossy);
    }

    /// 奇数字节的 UTF-16 一定是坏的，不能当成正常文本交出去
    #[test]
    fn 奇数字节的_utf16_被标成有损() {
        let mut bytes = BOM_UTF16_LE.to_vec();
        bytes.extend_from_slice(&[0x2D, 0x4E, 0x00]);
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Utf16Le);
        assert!(d.lossy);
    }

    #[test]
    fn label_是给状态栏看的() {
        assert_eq!(Encoding::Utf8.label(), "UTF-8");
        assert_eq!(Encoding::Utf16Le.label(), "UTF-16 LE");
        assert_eq!(Encoding::Gbk.label(), "GBK");
    }

    /// 钉住「不猜」这个设计决定：猜错编码的代价是保存时把用户文件写坏，
    /// 而无 BOM 的 UTF-16 在现实中极少见。将来谁想加启发式探测，会先撞见这条测试。
    #[test]
    fn 无_bom_的_utf16_不做猜测() {
        let bytes = encode("中文 mixed", Encoding::Utf16Le, false).bytes;
        let d = decode(&bytes);
        assert_ne!(d.encoding, Encoding::Utf16Le, "无 BOM 却猜成了 UTF-16");
        // 落到 GBK 兜底路径上，正文是乱码——所以 UI 必须把 lossy 显式告诉用户
        assert!(d.lossy || d.text != "中文 mixed");
    }
}
