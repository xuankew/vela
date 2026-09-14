//! 文本文件的读写（PLAN.md §2.5 `fs`）。
//!
//! **贯穿整个模块的一条规则：编辑器内部永远是 LF + Rust `String`，编码与行尾只活在
//! IO 边界上。** 读进来时归一化，写出去时还原。
//!
//! 为什么必须这样：CM6 把 `\r` 当成普通字符，文档里混着 CRLF 会让光标定位、
//! 选区、列对齐全部算错一格；而编码更是只有 Rust 侧的 `encoding_rs` 能正确处理。
//! 把两件事都关在边界上，中间层就可以假装世界上只有 UTF-8 + LF。
//!
//! ⚠️ 还原用的元信息（`FileFormat`）**不是可选装饰**：「打开 → 不改一个字 → 保存」
//! 必须产出字节完全相同的文件。悄悄把用户的 CRLF 改成 LF、把 GBK 转成 UTF-8，
//! 是编辑器最招骂的一类 bug，而且用户往往要到 git diff 炸开一片时才发现。

mod encoding;
mod eol;
mod read;
mod write;

use serde::{Deserialize, Serialize};

pub use encoding::{decode, encode, Decoded, Encoding};
pub use eol::{apply_eol, detect_eol, normalize_to_lf, LineEnding};
pub use read::{read_text, ReadError, MAX_INLINE_BYTES};
pub use write::{write_text_atomic, WriteError, WriteReport};

/// 把一个文档还原成原样所需的全部格式信息。
///
/// 前端把它当成不透明的一团数据存着，保存时原样传回来即可——这样「读」与「写」
/// 共用同一个类型，前后端都不需要各自维护一份字段清单。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFormat {
    pub encoding: Encoding,
    /// 原文件是否带 BOM。带就必须写回去，否则 Windows 上的 Excel / 记事本会认错编码
    pub bom: bool,
    pub eol: LineEnding,
}

/// 读一个文本文件的结果：正文 + 还原它所需的元信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    /// 已归一化为 LF 的正文，可以直接交给 CM6
    pub text: String,
    pub format: FileFormat,
    /// true = 解码时有字节无法映射，已用 U+FFFD 顶替。
    /// **这种文档原样写回会损坏原文件**，UI 必须拦一道（见 `read::read_text`）
    pub lossy: bool,
    /// 原文件的字节数，状态栏要显示；不能用 `text.len()` 代替，那是归一化后的
    pub bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const SAMPLE: &str = "第一行\nsecond line\n\tindented\n最后一行";

    fn all_formats() -> Vec<FileFormat> {
        let mut out = Vec::new();
        for encoding in [Encoding::Utf8, Encoding::Utf16Le, Encoding::Utf16Be, Encoding::Gbk] {
            for bom in [false, true] {
                // GBK 没有 BOM，这个组合不存在，枚举它只会让断言因为「本来就不可能」而失败
                if bom && !encoding.supports_bom() {
                    continue;
                }
                // 无 BOM 的 UTF-16 探测不出来（刻意不猜，理由见 encoding::decode 的文档），
                // 所以它不在「读进来再写回去字节不变」这条不变量的覆盖范围内。
                // 该行为由 encoding 模块的「无_bom_的_utf16_不做猜测」单独钉住。
                if !bom && !matches!(encoding, Encoding::Utf8 | Encoding::Gbk) {
                    continue;
                }
                for eol in [LineEnding::Lf, LineEnding::Crlf] {
                    out.push(FileFormat { encoding, bom, eol })
                }
            }
        }
        out
    }

    /// 矩阵大小的哨兵：跳过条件改错了会让上面那几条往返测试变成空转，
    /// 而空转的测试是绿的，看不出来。
    #[test]
    fn 格式矩阵覆盖_10_种组合() {
        // UTF-8: 2 种 BOM × 2 种行尾 = 4；UTF-16LE/BE 各只有带 BOM 的 2 种；GBK 只有不带 BOM 的 2 种
        assert_eq!(all_formats().len(), 10);
    }

    /// 整个 fs 模块最该守住的一条：读进来再原样写回去，字节必须完全一致。
    #[test]
    fn 写回读出的字节与原文件完全一致() {
        let dir = tempfile::tempdir().unwrap();
        for format in all_formats() {
            let path = dir.path().join(format!("sample-{:?}-{}.txt", format.encoding, format.bom));
            let payload = encode(&apply_eol(SAMPLE, format.eol), format.encoding, format.bom).bytes;
            fs::write(&path, &payload).unwrap();

            let read_back = read_text(&path).unwrap();
            assert_eq!(read_back.text, SAMPLE, "正文被改动：{format:?}");
            assert!(!read_back.lossy, "被判成有损解码：{format:?}");

            let report = write_text_atomic(&path, &read_back.text, read_back.format).unwrap();
            assert!(!report.unmappable, "有字符无法映射：{format:?}");
            assert_eq!(
                fs::read(&path).unwrap(),
                payload,
                "「打开→保存」改动了文件字节：{format:?}"
            );
        }
    }

    #[test]
    fn 读出的格式元信息与文件实际格式一致() {
        let dir = tempfile::tempdir().unwrap();
        for format in all_formats() {
            let path = dir.path().join("f.txt");
            let payload = encode(&apply_eol(SAMPLE, format.eol), format.encoding, format.bom).bytes;
            fs::write(&path, &payload).unwrap();
            let got = read_text(&path).unwrap();
            assert_eq!(got.format, format, "探测结果不符：{format:?}");
            assert_eq!(got.bytes, payload.len() as u64);
        }
    }

    #[test]
    fn 中文与制表符在各编码下都能往返() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cjk.txt");
        for format in all_formats() {
            write_text_atomic(&path, SAMPLE, format).unwrap();
            assert_eq!(read_text(&path).unwrap().text, SAMPLE);
        }
    }

    #[test]
    fn 保存不会把目标文件的权限改掉() {
        // 编辑一个 0600 的配置文件，保存后仍是 0600——原子写入走的是「新文件 + rename」，
        // 不继承权限的话会静默把它放宽成 0644
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("secret.conf");
            fs::write(&path, b"token=1").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

            write_text_atomic(&path, "token=2", FileFormat {
                encoding: Encoding::Utf8,
                bom: false,
                eol: LineEnding::Lf,
            })
            .unwrap();

            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "保存把权限改成了 {mode:o}");
            assert_eq!(fs::read_to_string(&path).unwrap(), "token=2");
        }
    }

    #[test]
    fn 保存后目录里不留临时文件() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        write_text_atomic(
            &path,
            "内容",
            FileFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf },
        )
        .unwrap();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n != "a.txt")
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }
}
