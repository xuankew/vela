//! 前后端「线上契约」的黄金 JSON。
//!
//! Vela 没有用 tauri-specta 之类的代码生成（多一个 build 步骤、多一层宏展开的调试成本），
//! 前端类型是手写在 `src/ipc/fs.ts` 里的。手写就意味着会漂移，而漂移的失败方式极其难查：
//! 字段名大小写不对，Tauri 那边只会得到一个 `undefined`，不报错。
//!
//! 所以这里把序列化后的**确切 JSON 字面量**钉死。前端有一份对照的快照测试
//! （`src/ipc/fs.test.ts`），两边都留了指向对方的注释。改任何一边的 serde 属性，
//! 都必须同时改另一边的字面量——这就是这个机制的全部作用。
//!
//! 放在 `tests/` 而不是 `src/` 里：契约是关于**公开 API** 的，integration test 只能用
//! pub 的东西，正好逼着这条边界保持干净。

use std::fs;
use std::path::Path;

use vela_core::fs::{
    read_text, write_text_atomic, Encoding, FileFormat, LineEnding, ReadError, TextFile, WriteReport,
    MAX_INLINE_BYTES,
};

#[test]
fn file_format_的字段名与枚举值() {
    let json = serde_json::to_string(&FileFormat {
        encoding: Encoding::Utf16Le,
        bom: true,
        eol: LineEnding::Crlf,
    })
    .unwrap();
    // encoding / eol 是 snake_case 枚举（注意 Utf16Le → utf16_le），外层结构体是 camelCase
    assert_eq!(json, r#"{"encoding":"utf16_le","bom":true,"eol":"crlf"}"#);

    assert_eq!(
        serde_json::to_string(&FileFormat {
            encoding: Encoding::Utf8,
            bom: false,
            eol: LineEnding::Lf,
        })
        .unwrap(),
        r#"{"encoding":"utf8","bom":false,"eol":"lf"}"#
    );
    assert_eq!(
        serde_json::to_string(&Encoding::Utf16Be).unwrap(),
        r#""utf16_be""#
    );
    assert_eq!(serde_json::to_string(&Encoding::Gbk).unwrap(), r#""gbk""#);
}

/// 用真实文件产出 `TextFile`，而不是手搓一个：这样钉住的是产品真正会发出去的字节。
#[test]
fn text_file_的线上形状() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("win-gbk.txt");
    // GBK + CRLF：一次覆盖「非 UTF-8 编码」与「非 LF 行尾」两个最容易写错的分支。
    // 正文按规矩给 LF，CRLF 由 format.eol 决定（入参带 \r 的情况由 write.rs 的测试覆盖）
    write_text_atomic(
        &path,
        "第一行\n第二行\n",
        FileFormat { encoding: Encoding::Gbk, bom: false, eol: LineEnding::Crlf },
    )
    .unwrap();

    let got: TextFile = read_text(&path).unwrap();
    let json = serde_json::to_string(&got).unwrap();

    // 正文里的换行被 JSON 转义成 \n（Rust 源码里要写 \\n）；中文不转义，serde_json 直接输出 UTF-8
    assert_eq!(
        json,
        r#"{"text":"第一行\n第二行\n","format":{"encoding":"gbk","bom":false,"eol":"crlf"},"lossy":false,"bytes":16}"#
    );
    // bytes 是**原文件字节数**（GBK 下每个汉字 2 字节，每行 2 字节行尾），不是正文字符数
    assert_eq!(got.bytes, fs::read(&path).unwrap().len() as u64);
}

#[test]
fn write_report_的字段名是_camel_case() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.txt");
    let report: WriteReport =
        write_text_atomic(&path, "x", FileFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf })
            .unwrap();
    assert_eq!(
        serde_json::to_string(&report).unwrap(),
        r#"{"bytesWritten":1,"unmappable":false}"#
    );
}

#[test]
fn read_error_用_kind_标签区分变体() {
    let too_large = serde_json::to_string(&ReadError::TooLarge {
        bytes: MAX_INLINE_BYTES + 1,
        limit: MAX_INLINE_BYTES,
    })
    .unwrap();
    assert_eq!(
        too_large,
        r#"{"kind":"too_large","bytes":4194305,"limit":4194304}"#
    );

    let dir = tempfile::tempdir().unwrap();
    let io = serde_json::to_string(&match read_text(&dir.path().join("nope.txt")) {
        Err(e) => e,
        Ok(_) => panic!("期望读取失败"),
    })
    .unwrap();
    // reason 是 std::io::ErrorKind 的 Debug 形式；message 含临时目录路径，不稳定，所以只查前缀
    assert!(io.starts_with(r#"{"kind":"io","reason":"NotFound","message":""#), "{io}");

    let directory = serde_json::to_string(&match read_text(dir.path()) {
        Err(e) => e,
        Ok(_) => panic!("期望读取失败"),
    })
    .unwrap();
    assert!(directory.starts_with(r#"{"kind":"directory","path":""#), "{directory}");
}

#[test]
fn write_error_用_kind_标签区分变体() {
    let no_parent = serde_json::to_string(&match write_text_atomic(
        Path::new("bare.txt"),
        "x",
        FileFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf },
    ) {
        Err(e) => e,
        Ok(_) => panic!("期望写入失败"),
    })
    .unwrap();
    assert_eq!(no_parent, r#"{"kind":"no_parent","path":"bare.txt"}"#);

    let dir = tempfile::tempdir().unwrap();
    let io = serde_json::to_string(&match write_text_atomic(
        &dir.path().join("no-such-dir").join("x.txt"),
        "x",
        FileFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf },
    ) {
        Err(e) => e,
        Ok(_) => panic!("期望写入失败"),
    })
    .unwrap();
    assert!(io.starts_with(r#"{"kind":"io","reason":"NotFound","message":""#), "{io}");
}
