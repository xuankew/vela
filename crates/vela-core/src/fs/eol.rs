//! 行尾符的探测、归一化与还原。
//!
//! 规则：**文档在编辑器里永远是 LF**，CRLF 只在写盘的那一刻还原回去。
//! CM6 把 `\r` 当普通字符，文档里混着 CRLF 会让光标定位与列对齐算错一格。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    /// 状态栏展示名
    pub fn label(self) -> &'static str {
        match self {
            LineEnding::Lf => "LF",
            LineEnding::Crlf => "CRLF",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
        }
    }
}

/// 多数票判定。没有换行符、或票数相同时默认 LF（macOS/Linux 的主流，也是 git 的默认）。
///
/// 混合行尾的文件很常见（跨平台仓库、手工拼接的日志），按多数票走能保证
/// 「保存后大多数行不变」，而按第一行走会让一个开头的 CRLF 把整篇改掉。
pub fn detect_eol(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    // matches('\n') 把 CRLF 里的 \n 也算进去了，减掉才是裸 LF 的数量
    let bare_lf = text.matches('\n').count() - crlf;
    if crlf > bare_lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

/// CRLF 与裸 CR（老 Mac）统一折成 LF。
///
/// 没有 `\r` 时零拷贝返回借用值——绝大多数 macOS/Linux 文件走这条路。
pub fn normalize_to_lf(text: &str) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    if !text.contains('\r') {
        return Cow::Borrowed(text);
    }

    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            out.push(b'\n');
            // \r\n 算一个换行；裸 \r 也算一个
            i += usize::from(bytes.get(i + 1) == Some(&b'\n')) + 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }

    // \r 与 \n 都是 ASCII 单字节，逐字节搬运不可能切碎多字节序列，所以这里是真不会失败
    Cow::Owned(String::from_utf8(out).expect("只替换 ASCII 字节，不可能产生非法 UTF-8"))
}

/// LF → 目标行尾。
///
/// **前置条件：入参必须已经过 `normalize_to_lf`**（即不含任何 `\r`）。
/// 否则 CRLF 档会把已有的 `\r\n` 变成 `\r\r\n`。两个调用方都显式做了归一化：
/// `read_text` 在探测完行尾之后归一化，`write_text_atomic` 在还原行尾之前归一化
/// （它的入参来自 IPC 另一侧，不能假定干净）。
pub fn apply_eol(text: &str, eol: LineEnding) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    if eol == LineEnding::Lf || !text.contains('\n') {
        return Cow::Borrowed(text);
    }

    let mut out = Vec::with_capacity(text.len() + text.len() / 16);
    for &b in text.as_bytes() {
        if b == b'\n' {
            out.push(b'\r');
        }
        out.push(b);
    }
    Cow::Owned(String::from_utf8(out).expect("只插入 ASCII 字节，不可能产生非法 UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 多数票决定行尾() {
        assert_eq!(detect_eol("a\r\nb\r\nc\n"), LineEnding::Crlf);
        assert_eq!(detect_eol("a\nb\nc\r\n"), LineEnding::Lf);
        assert_eq!(detect_eol("a\r\nb\n"), LineEnding::Lf, "平票时应当默认 LF");
    }

    #[test]
    fn 没有换行符时默认_lf() {
        assert_eq!(detect_eol("单行"), LineEnding::Lf);
        assert_eq!(detect_eol(""), LineEnding::Lf);
    }

    #[test]
    fn crlf_与裸_cr_都折成_lf() {
        assert_eq!(normalize_to_lf("a\r\nb\r\nc"), "a\nb\nc");
        assert_eq!(normalize_to_lf("a\rb\rc"), "a\nb\nc");
        assert_eq!(normalize_to_lf("a\r\n\rb"), "a\n\nb");
    }

    #[test]
    fn 不含_cr_时归一化是零拷贝的() {
        let text = String::from("a\nb\nc");
        assert!(matches!(normalize_to_lf(&text), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn 中文与多字节字符不会被行尾处理切碎() {
        let text = "第一行\r\n第二行：中文，标点。\r\n";
        assert_eq!(normalize_to_lf(text), "第一行\n第二行：中文，标点。\n");
        assert_eq!(apply_eol("第一行\n第二行\n", LineEnding::Crlf), "第一行\r\n第二行\r\n");
    }

    #[test]
    fn lf_档归还原样不动() {
        let text = "a\nb\n";
        assert!(matches!(apply_eol(text, LineEnding::Lf), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn 归一化与还原互为逆运算() {
        for eol in [LineEnding::Lf, LineEnding::Crlf] {
            let original = "line1\r\nline2\r\n\r\nline4\r\n";
            let normalized = normalize_to_lf(original);
            assert_eq!(apply_eol(&normalized, eol), original.replace("\r\n", eol.as_str()));
        }
    }

    #[test]
    fn label_与_as_str_对得上() {
        assert_eq!(LineEnding::Crlf.label(), "CRLF");
        assert_eq!(LineEnding::Crlf.as_str(), "\r\n");
        assert_eq!(LineEnding::Lf.as_str(), "\n");
    }
}
