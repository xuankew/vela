//! Git 的 blob 对象 id（PLAN.md §3.22 M8-7）。
//!
//! ## 为什么不是 SHA-256
//!
//! 远端那一列是 GitHub 回的 blob sha，GitHub 的仓库对象格式就是 SHA-1；本地这一列
//! 必须与它同口径，否则三张表没有一格能相等。这不是安全用途——它只是内容寻址的
//! 名字，碰撞在这里的后果是「少推一个文件」，而不是签名被伪造。
//!
//! ## 依赖为什么是 `sha1` 而不是自己写
//!
//! 本仓库有过「crc32 自带一张 const 表、日期手写 `civil_from_days`」的先例，但那两条
//! 的算法短到能一眼看完。SHA-1 的压缩函数不是，手写一份换不来任何东西，而写错时的
//! 症状是「每个文件都算出一个错的 sha」——它不会崩，只会让同步每次全量重推。
//! `sha1` 0.10.7 与本仓库已有的 `sha2` 同属 RustCrypto，许可证 MIT OR Apache-2.0
//! （根 `Cargo.toml` 有核实记录），且只新增这一个包。

use sha1::{Digest, Sha1};

/// 一段内容作为 Git blob 的 sha：40 位小写十六进制。
///
/// 口径与 `git hash-object` 逐字一致：`sha1("blob " + 十进制字节数 + "\x00" + 正文)`。
/// 注意长度是**字节数**，不是字符数——一条满是中文的笔记按字符数算会得到一个
/// 与 GitHub 永远对不上的 sha。
pub fn blob_sha(content: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(b"blob ");
    hasher.update(content.len().to_string().as_bytes());
    hasher.update([0u8]);
    hasher.update(content);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期望值全部来自本机 `git hash-object --stdin`，不是照公式推的。
    // 这条测试存在的唯一理由：本地与 GitHub 必须算出同一串，否则比对永远不相等。
    #[test]
    fn 与_git_的黄金值逐字一致() {
        assert_eq!(blob_sha(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        assert_eq!(blob_sha(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_eq!(blob_sha(b"hello"), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
        assert_eq!(blob_sha("读书笔记\n".as_bytes()), "fa267efe07d32e569d86136e94f00d7ccbccd0b7");
        assert_eq!(blob_sha(b"a\0b"), "20b5be91886d0b6f26dc98a225c0dac05fe2c86e");
    }

    #[test]
    fn 长度前缀按字节数不按字符数() {
        // 「读书笔记」四个字是 12 字节；前缀写成 4 的那一版算不出这一串
        assert_eq!(blob_sha("读书笔记".as_bytes()), "436e2f277884a55f6fb2d19dacdf2b39a7402d78");
    }

    #[test]
    fn 一字节之差就是另一串() {
        assert_ne!(blob_sha("笔记\n".as_bytes()), blob_sha("笔记\r\n".as_bytes()));
    }
}
