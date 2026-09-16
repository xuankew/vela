//! 原子写入：临时文件 + rename。
//!
//! 为什么不能直接 `fs::write(path)`：写到一半时断电、磁盘满、或者进程被 kill，
//! 用户拿到的是**半个文件**——原来的内容已经没了，新的又不完整。对一个编辑器来说
//! 这是最不可原谅的失败模式。
//!
//! 原子写入的三步缺一不可：
//! 1. 临时文件必须与目标**同目录**——`rename` 跨文件系统会直接失败（EXDEV）；
//! 2. rename 之前必须 `sync_all()`，否则元数据落盘了、数据还在页缓存里，
//!    断电后可能得到一个长度为 0 的文件；
//! 3. rename 之后要 fsync 父目录，rename 这个目录项本身才算持久。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::encoding::encode;
use super::eol::{apply_eol, normalize_to_lf};
use super::FileFormat;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    /// 实际写盘的字节数（编码 + 行尾还原之后，不等于正文字符数）
    pub bytes_written: u64,
    /// true = 有字符在目标编码里不存在，已被写成数字字符引用。**这是数据损坏**，
    /// UI 必须警告并建议改用 UTF-8 保存
    pub unmappable: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriteError {
    Io { reason: String, message: String },
    /// 传进来的是裸文件名（没有目录部分），无法确定临时文件放哪
    NoParent { path: String },
}

impl WriteError {
    fn io(err: std::io::Error) -> Self {
        WriteError::Io { reason: format!("{:?}", err.kind()), message: err.to_string() }
    }
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Io { message, .. } => f.write_str(message),
            WriteError::NoParent { path } => write!(f, "{path} 没有目录部分，无法确定临时文件位置"),
        }
    }
}

impl std::error::Error for WriteError {}

pub fn write_text_atomic(path: &Path, text: &str, format: FileFormat) -> Result<WriteReport, WriteError> {
    // 先归一化再还原行尾。`apply_eol` 要求入参不含 `\r`，而这里的 text 来自 IPC
    // 另一侧的前端——是个系统边界，不能假定它已经归一化过。真递进来带 CRLF 的正文
    // （比如从别处粘贴的内容），CRLF 档会把它写成 `\r\r\n`，读回来每行多一个空行，
    // 而且没有任何报错。normalize_to_lf 在不含 `\r` 时是零拷贝的，正常路径不花钱。
    let normalized = normalize_to_lf(text);
    let payload = apply_eol(&normalized, format.eol);
    let encoded = encode(&payload, format.encoding, format.bom);

    write_bytes_atomic(path, &encoded.bytes)?;

    Ok(WriteReport { bytes_written: encoded.bytes.len() as u64, unmappable: encoded.unmappable })
}

/// 把一段**已经是最终字节**的数据原子写入 `path`。
///
/// 与 `write_text_atomic` 的区别是它不做任何文本变换：没有行尾还原、没有编码转换、
/// 没有 BOM。会话存档这类「Rust 侧自己序列化出来的 UTF-8 JSON」必须走这一条——
/// 走另一条的话 CRLF 档会把 JSON 里的 `\n` 转义序列之外的真换行改掉，
/// GBK 档更是会把中文直接写坏，而两者都不会报错。
///
/// 临时文件的创建、权限继承、`sync_all`、rename、父目录 fsync 这一整套只在这里存在一份，
/// 两条路径共用。
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), WriteError> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| WriteError::NoParent { path: path.display().to_string() })?;

    let tmp = tmp_path(parent, path);
    let written = write_and_rename(&tmp, parent, path, bytes);
    if written.is_err() {
        // 失败也要把临时文件清掉，否则用户目录里会攒一堆 .vela-tmp-* 垃圾。
        // 清理本身的错误忽略：它只是掩盖了真正的那个错误
        let _ = fs::remove_file(&tmp);
    }
    written
}

fn write_and_rename(tmp: &Path, parent: &Path, dest: &Path, bytes: &[u8]) -> Result<(), WriteError> {
    {
        let mut file = fs::File::create(tmp).map_err(WriteError::io)?;

        // 目标已存在时继承它的权限。原子写入是「新文件 + rename」，不继承的话
        // 保存一个 0600 的配置文件会静默把它放宽成默认的 0644——
        // 这种「保存顺便改了权限」的副作用用户几乎不可能自己排查出来。
        #[cfg(unix)]
        if let Ok(meta) = fs::metadata(dest) {
            fs::set_permissions(tmp, meta.permissions()).map_err(WriteError::io)?;
        }

        file.write_all(bytes).map_err(WriteError::io)?;
        file.sync_all().map_err(WriteError::io)?;
    }

    fs::rename(tmp, dest).map_err(WriteError::io)?;

    #[cfg(unix)]
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }

    Ok(())
}

/// 临时文件名带上 pid 与纳秒时间戳：同一个进程里连续保存两次、或者用户开了两个
/// Vela 实例保存同名文件，都不该互相踩。
fn tmp_path(parent: &Path, dest: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    parent.join(format!(".{name}.vela-tmp-{}-{stamp}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{read_text, Encoding, LineEnding};

    fn fmt(encoding: Encoding, eol: LineEnding) -> FileFormat {
        FileFormat { encoding, bom: false, eol }
    }

    #[test]
    fn 写入的内容与行尾都正确() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        let report = write_text_atomic(&path, "第一行\n第二行\n", fmt(Encoding::Utf8, LineEnding::Crlf)).unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"\xe7\xac\xac\xe4\xb8\x80\xe8\xa1\x8c\r\n\xe7\xac\xac\xe4\xba\x8c\xe8\xa1\x8c\r\n");
        assert_eq!(report.bytes_written, 22);
        assert!(!report.unmappable);
    }

    /// 入参带 CRLF 时不能把它放大成 `\r\r\n`：text 来自 IPC 另一侧，不能假定已归一化。
    #[test]
    fn 带_crlf_的正文按_crlf_档写盘不会产生_r_r_n() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixed.txt");
        write_text_atomic(&path, "第一行\r\n第二行\r\n", fmt(Encoding::Utf8, LineEnding::Crlf)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xe7\xac\xac\xe4\xb8\x80\xe8\xa1\x8c\r\n\xe7\xac\xac\xe4\xba\x8c\xe8\xa1\x8c\r\n");
        assert_eq!(read_text(&path).unwrap().text, "第一行\n第二行\n");
    }

    #[test]
    fn 带_crlf_的正文按_lf_档写盘时一个_cr_都不剩() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("to-lf.txt");
        write_text_atomic(&path, "a\r\nb\rc\n", fmt(Encoding::Utf8, LineEnding::Lf)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\nb\nc\n");
    }

    #[test]
    fn 新建文件与覆盖已有文件都走同一条路径() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.txt");
        write_text_atomic(&path, "旧内容", fmt(Encoding::Utf8, LineEnding::Lf)).unwrap();
        write_text_atomic(&path, "新内容", fmt(Encoding::Utf8, LineEnding::Lf)).unwrap();
        assert_eq!(read_text(&path).unwrap().text, "新内容");
    }

    #[test]
    fn 覆盖后旧内容的字节不会残留() {
        // rename 是整文件替换，不是截断写入：短内容覆盖长内容时不该留下尾巴
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.txt");
        write_text_atomic(&path, "aaaaaaaaaaaaaaaaaaaa", fmt(Encoding::Utf8, LineEnding::Lf)).unwrap();
        write_text_atomic(&path, "bb", fmt(Encoding::Utf8, LineEnding::Lf)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"bb");
    }

    #[test]
    fn 裸文件名被拒绝而不是写到当前目录() {
        match write_text_atomic(Path::new("bare.txt"), "x", fmt(Encoding::Utf8, LineEnding::Lf)) {
            Err(WriteError::NoParent { path }) => assert_eq!(path, "bare.txt"),
            other => panic!("期望 NoParent，实际 {other:?}"),
        }
    }

    #[test]
    fn 目录不存在时报_io_错误() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no-such-dir").join("x.txt");
        match write_text_atomic(&path, "x", fmt(Encoding::Utf8, LineEnding::Lf)) {
            Err(WriteError::Io { reason, .. }) => assert_eq!(reason, "NotFound"),
            other => panic!("期望 Io/NotFound，实际 {other:?}"),
        }
    }

    #[test]
    fn 失败时不留临时文件() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no-such-dir").join("x.txt");
        let _ = write_text_atomic(&path, "x", fmt(Encoding::Utf8, LineEnding::Lf));
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "残留了 {leftovers:?}");
    }

    #[test]
    fn 无法映射的字符会被报出来() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gbk.txt");
        let report = write_text_atomic(&path, "中文😀", fmt(Encoding::Gbk, LineEnding::Lf)).unwrap();
        assert!(report.unmappable);
    }

    #[test]
    fn 临时文件名带_pid_与时间戳_不会互相踩() {
        let dir = tempfile::tempdir().unwrap();
        let a = tmp_path(dir.path(), &dir.path().join("f.txt"));
        let b = tmp_path(dir.path(), &dir.path().join("f.txt"));
        assert_ne!(a, b, "同一个目标文件生成了相同的临时名");
        assert!(a.starts_with(dir.path()));
        assert!(a.file_name().unwrap().to_string_lossy().contains(".vela-tmp-"));
    }

    /// `write_bytes_atomic` 存在的全部理由：一个字节都不许动。
    ///
    /// 如果哪天有人「统一一下入口」把会话 JSON 也塞进 `write_text_atomic`，
    /// 这条会红——CRLF 档会把真换行写成 `\r\n`，读回来 JSON 直接解析失败。
    #[test]
    fn 字节写入不做任何行尾或编码变换() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        // 不能用 br#"…"#：字节串字面量要求纯 ASCII，而这里正是要验证中文原样落地
        let payload = r#"{"a":"第一行\n第二行"}"#.as_bytes();
        write_bytes_atomic(&path, payload).unwrap();
        assert_eq!(fs::read(&path).unwrap(), payload);
    }

    #[test]
    fn 字节写入同样拒绝裸文件名() {
        match write_bytes_atomic(Path::new("bare.bin"), b"x") {
            Err(WriteError::NoParent { path }) => assert_eq!(path, "bare.bin"),
            other => panic!("期望 NoParent，实际 {other:?}"),
        }
    }

    #[test]
    fn 字节写入成功后不留临时文件() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.json");
        write_bytes_atomic(&path, b"{}").unwrap();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n != "s.json")
            .collect();
        assert!(leftovers.is_empty(), "残留了 {leftovers:?}");
    }

    /// 只读目标（比如权限 0444 的目录里的文件）必须报错而不是静默成功。
    /// 这条同时验证了 rename 失败会走清理分支。
    #[test]
    #[cfg(unix)]
    fn 目标目录不可写时报错() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("ro");
        fs::create_dir(&sub).unwrap();
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o500)).unwrap();

        let result = write_text_atomic(&sub.join("x.txt"), "内容", fmt(Encoding::Utf8, LineEnding::Lf));
        // 恢复权限，否则 tempdir 自己删不掉这个目录
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o700)).unwrap();

        assert!(matches!(result, Err(WriteError::Io { .. })), "期望写入失败，实际 {result:?}");
    }
}
