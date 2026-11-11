//! 同步集合与路径闸门（PLAN.md §3.22 M8-7）。
//!
//! 三件事挤在一块是有理由的：它们都由「哪些文件算整理文件」这一条派生出来。
//!
//! - [`is_managed_path`]：进同步集合的唯一判据。M8-8 扫本地目录、过滤远端树都走它。
//! - [`safe_rel`]：交给写盘之前的最后一道闸门。`..`、绝对路径、反斜杠一律拒。
//! - [`with_material_ignore`]：`.gitignore` 里那一行的追加逻辑（只维护、不同步）。
//!
//! ## 为什么扩展名表与前端共用同一份口径
//!
//! `src/editor/language.ts` 的 `MARKDOWN_EXT` 认 `.md` / `.markdown` / `.mdown` / `.mkd`，
//! 编辑器、工具栏、右键菜单都读它。同步这边若只认 `.md`，用户的 `.markdown` 笔记就会
//! 「在 Vela 里能编辑、但永远同步不上去」，而症状只在换设备时出现。所以这里铺开同一组
//! 扩展名；两边的一致性由本文件的一条测试钉住。
//!
//! ## 为什么 `safe_rel` 是拒而不是归一化
//!
//! 归一化（把 `a/../b` 收成 `b`）看起来更宽容，但它正是路径穿越的经典误区：
//! 你必须在**拼上配置目录之后**再判前缀，而软链又会让「看起来在里面」变成「其实在
//! 外面」。这一层拿不到配置目录，也不该拿：它只回答「这个相对路径本身是不是干净的」，
//! 干净的定义是每段都是普通名字。真正的「拼完再 canonicalize、再判前缀」在 M8-8 写盘前，
//! 两处都要过。

use crate::weread::render::MATERIAL_SUFFIX;

/// 配置目录根上那个忽略文件的文件名（只维护、不同步）。
pub const GITIGNORE_FILE: &str = ".gitignore";

/// 素材文件在 `.gitignore` 里的那一行。
///
/// ⚠️ 与 [`MATERIAL_SUFFIX`] 是同一件事的两处拼写，有一条测试钉着它们不许漂。
/// 带头 `*` 是因为素材文件名前面还有「作者 - 书名」，而 Git 的忽略规则对含 `/`
/// 与否的匹配范围不同——`*` 让它在任意层级的目录里都命中。
pub const MATERIAL_IGNORE_LINE: &str = "*·划线素材.md";

/// 与前端 `MARKDOWN_EXT` 同一组扩展名（大小写不敏感）。
const NOTE_EXTENSIONS: [&str; 4] = [".md", ".markdown", ".mdown", ".mkd"];

/// 这个相对路径本身干不干净。
///
/// 干净 = 非空、不含 NUL、不以 `/` 开头、不含反斜杠、不是盘符前缀、
/// 每一段都不是空、`.`、`..`。返回原始字符串（不重写），所以调用方拿到的
/// 还是 GitHub 上那个名字。
pub fn safe_rel(path: &str) -> Option<&str> {
    if path.is_empty() || path.contains('\0') || path.contains('\\') || path.starts_with('/') {
        return None;
    }
    // `C:` / `c:`：GitHub 的树路径里不该出现，但在 Windows 上拼出来就是绝对路径
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return None;
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
    }
    Some(path)
}

/// 是不是一份 Markdown 笔记（只看扩展名，不看路径安全性）。
pub fn is_note_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    NOTE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// 是不是微信读书生成的素材文件。
///
/// 用 `to_ascii_lowercase` 是为了容忍 macOS 上改名时把 `.md` 变成 `.MD`——
/// 它仍然是同一份划线原文，⛔ 不能因为大小写就漏进 git。
pub fn is_material_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(&format!("{}.md", MATERIAL_SUFFIX.to_ascii_lowercase()))
}

/// 进同步集合的唯一判据：Markdown 笔记，且不是素材文件。
///
/// ⚠️ 这里**不判** [`safe_rel`]：调用方先筛集合、再由 [`crate::sync::compare`]
/// 统一判越界——两处各判一次会让「被过滤掉的不安全路径」连错误都报不出来。
/// 远端树里一个 `../x.md` 应该是一次响亮的失败，不是静默忽略。
pub fn is_managed_path(path: &str) -> bool {
    is_note_path(path) && !is_material_path(path)
}

/// 给 `.gitignore` 的现有内容补上素材那一行；已经有了就返回 `None`。
///
/// 追加而不是重写：这个文件可能还有用户自己的规则。行尾跟随文件现状
/// （CRLF 文件追加 CRLF），去重按「忽略首尾空白后的整行相等」，所以
/// `# *·划线素材.md` 这种被注释掉的写法不算数。
pub fn with_material_ignore(existing: &str) -> Option<String> {
    if existing.lines().any(|line| line.trim() == MATERIAL_IGNORE_LINE) {
        return None;
    }
    let eol = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(existing.len() + MATERIAL_IGNORE_LINE.len() + 2);
    out.push_str(existing);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str(eol);
    }
    out.push_str(MATERIAL_IGNORE_LINE);
    out.push_str(eol);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 干净路径照常通过() {
        for path in ["a.md", "笔记.md", "子目录/第一章.md", "a b/c.d.md"] {
            assert_eq!(safe_rel(path), Some(path), "{path}");
        }
    }

    #[test]
    fn 绝对路径与上跳一律拒() {
        for path in [
            "",
            "/etc/passwd",
            "../x.md",
            "a/../../b.md",
            "./a.md",
            "a/./b.md",
            "a//b.md",
            "a/",
            "C:/x.md",
            "c:notes/a.md",
            "a\\b.md",
        ] {
            assert_eq!(safe_rel(path), None, "{path}");
        }
    }

    #[test]
    fn 空字符拒() {
        assert_eq!(safe_rel("a\0b.md"), None);
    }

    #[test]
    fn 扩展名与前端_一条表() {
        for path in ["a.md", "a.MD", "a.markdown", "a.Mdown", "a.mkd"] {
            assert!(is_note_path(path), "{path}");
        }
        for path in ["a.txt", "a.mdx", "a.md.bak", "md", ""] {
            assert!(!is_note_path(path), "{path}");
        }
    }

    #[test]
    fn 素材文件不进同步集合() {
        assert!(is_material_path("某人 - 某书·划线素材.md"));
        assert!(is_material_path("某人 - 某书·划线素材.MD"));
        assert!(is_managed_path("某人 - 某书.md"));
        assert!(!is_managed_path("某人 - 某书·划线素材.md"));
        // 不是素材，但也不是笔记
        assert!(!is_managed_path(".gitignore"));
        assert!(!is_managed_path("图.png"));
        // 名字里带「划线素材」却不是那个后缀，照常同步
        assert!(is_managed_path("划线素材整理.md"));
    }

    #[test]
    fn 忽略行与素材后缀不许漂() {
        assert_eq!(MATERIAL_IGNORE_LINE, format!("*{MATERIAL_SUFFIX}.md"));
    }

    #[test]
    fn 空的忽略文件直接写那一行() {
        assert_eq!(with_material_ignore(""), Some("*·划线素材.md\n".to_owned()));
    }

    #[test]
    fn 已有别的规则就追加在后面() {
        let existing = "node_modules/\n.DS_Store\n";
        let out = with_material_ignore(existing).unwrap();
        assert_eq!(out, "node_modules/\n.DS_Store\n*·划线素材.md\n");
    }

    #[test]
    fn 最后一行没有换行时先补一个() {
        assert_eq!(with_material_ignore("node_modules/"), Some("node_modules/\n*·划线素材.md\n".to_owned()));
    }

    #[test]
    fn 已经有了就一个字都不改() {
        assert_eq!(with_material_ignore("*·划线素材.md\n"), None);
        assert_eq!(with_material_ignore("  *·划线素材.md  \r\n"), None);
        assert_eq!(with_material_ignore("a\n*·划线素材.md"), None);
    }

    #[test]
    fn 注释掉的那一行不算数() {
        let out = with_material_ignore("# *·划线素材.md\n").unwrap();
        assert_eq!(out, "# *·划线素材.md\n*·划线素材.md\n");
    }

    #[test]
    fn 行尾跟随文件现状() {
        assert_eq!(with_material_ignore("a\r\nb\r\n"), Some("a\r\nb\r\n*·划线素材.md\r\n".to_owned()));
    }
}
