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
use vela_core::session::{
    load_session, save_session, PaneDirection, Session, SessionError, SessionReport, SessionTab,
    MAX_SESSION_BYTES, SESSION_FILE_NAME, SESSION_VERSION,
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

/// `open_file` 的第二个参数是 `Option<Encoding>`：`null` 走探测，字符串则跳过探测。
///
/// 前端**总是**带上这个 key（不覆写时传 `null`），所以「key 整个缺失」不在契约里——
/// Tauri 对缺失参数与 `null` 的处理并不显然一致，不依赖它就不必去赌。
#[test]
fn 编码覆写参数用_null_表示走探测() {
    assert_eq!(serde_json::from_str::<Option<Encoding>>("null").unwrap(), None);
    assert_eq!(serde_json::from_str::<Option<Encoding>>(r#""gbk""#).unwrap(), Some(Encoding::Gbk));
    assert_eq!(
        serde_json::from_str::<Option<Encoding>>(r#""utf16_le""#).unwrap(),
        Some(Encoding::Utf16Le)
    );

    // 前端只可能发那四个值。拼错了必须**报错**而不是静默当成 None：
    // 后者会让「以 GBK 重新打开」变成「再探测一次」，用户看到的还是同一屏乱码，
    // 而且没有任何提示告诉他刚才那一下没生效
    assert!(serde_json::from_str::<Option<Encoding>>(r#""gb2312""#).is_err());
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

// ────────────────────────────── M1-F 会话存档 ──────────────────────────────
//
// 前端那一份在 `src/ipc/session.ts` + `src/ipc/session.test.ts`。会话比 fs 更容易漂移：
// 它有 14 个字段、一个枚举、一个嵌套元组数组，而**任何一个名字写错的失败方式都是
// 「重启后什么都没恢复」——不崩、不报错，用户只会觉得这功能没做**。

fn sample_tab() -> SessionTab {
    SessionTab {
        path: Some("/tmp/a.txt".into()),
        format: FileFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf },
        dirty: false,
        lossy: false,
        draft: None,
        selection: vec![(0, 0)],
        main: 0,
        scroll_top: 0.0,
        scroll_left: 0.0,
    }
}

fn draft_tab() -> SessionTab {
    SessionTab {
        path: None,
        // 未命名文档也带一份格式，而且是非默认的：用户在没落过盘的文档上选了 GBK+CRLF，
        // 这个决定只能存在这里
        format: FileFormat { encoding: Encoding::Gbk, bom: false, eol: LineEnding::Crlf },
        dirty: true,
        lossy: true,
        draft: Some("未保存\n草稿".into()),
        selection: vec![(0, 3), (4, 4)],
        main: 1,
        scroll_top: 120.5,
        scroll_left: 0.0,
    }
}

fn sample_session() -> Session {
    Session {
        version: SESSION_VERSION,
        direction: PaneDirection::Column,
        focused: 1,
        tabs: vec![sample_tab(), draft_tab()],
        panes: vec![0, 1],
    }
}

#[test]
fn session_的线上形状() {
    let json = serde_json::to_string(&sample_session()).unwrap();

    // 字段顺序 = 结构体声明顺序（serde 的默认行为，前端不依赖它，但钉住能发现重排）；
    // direction 是 snake_case 枚举；selection 的 (usize, usize) 元组落成嵌套数组；
    // f64 永远带小数点（serde_json 的行为，前端 `number` 无所谓，但 0 与 0.0 要一致）
    assert_eq!(
        json,
        r#"{"version":1,"direction":"column","focused":1,"tabs":[{"path":"/tmp/a.txt","format":{"encoding":"utf8","bom":false,"eol":"lf"},"dirty":false,"lossy":false,"draft":null,"selection":[[0,0]],"main":0,"scrollTop":0.0,"scrollLeft":0.0},{"path":null,"format":{"encoding":"gbk","bom":false,"eol":"crlf"},"dirty":true,"lossy":true,"draft":"未保存\n草稿","selection":[[0,3],[4,4]],"main":1,"scrollTop":120.5,"scrollLeft":0.0}],"panes":[0,1]}"#
    );
}

/// 落盘的字节必须与上面那个字面量完全一致——中间没有第二层变换。
///
/// 这条同时钉住了「会话走 `write_bytes_atomic` 而不是 `write_text_atomic`」：
/// 后者会按 format 还原行尾、转编码，那样这里读回来的就不是这个字符串了。
#[test]
fn 落盘字节与契约字面量一致() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SESSION_FILE_NAME);
    let report: SessionReport = save_session(&path, sample_session()).unwrap();

    let on_disk = fs::read_to_string(&path).unwrap();
    assert_eq!(on_disk, serde_json::to_string(&sample_session()).unwrap());
    assert_eq!(report.bytes_written, on_disk.len() as u64);
    assert_eq!(report.dropped_drafts, 0);

    assert_eq!(
        serde_json::to_string(&report).unwrap(),
        format!(r#"{{"bytesWritten":{},"droppedDrafts":0}}"#, on_disk.len())
    );
}

#[test]
fn session_能原样解析回来() {
    let json = serde_json::to_string(&sample_session()).unwrap();
    assert_eq!(serde_json::from_str::<Session>(&json).unwrap(), sample_session());
}

#[test]
fn pane_direction_的枚举值() {
    assert_eq!(serde_json::to_string(&PaneDirection::Row).unwrap(), r#""row""#);
    assert_eq!(serde_json::to_string(&PaneDirection::Column).unwrap(), r#""column""#);
    assert_eq!(serde_json::from_str::<PaneDirection>(r#""row""#).unwrap(), PaneDirection::Row);
    assert_eq!(serde_json::from_str::<PaneDirection>(r#""column""#).unwrap(), PaneDirection::Column);

    // 拼错了必须报错。静默当成 Row 会让上下分屏恢复成左右分屏，
    // 而用户看不出这是 bug 还是自己记错了
    assert!(serde_json::from_str::<PaneDirection>(r#""horizontal""#).is_err());
}

/// 下标越界的会话必须在 Rust 侧被拒，不能送到前端去崩。
#[test]
fn 越界的分屏下标在解析阶段就被拒() {
    let bad = r#"{"version":1,"direction":"row","focused":0,"tabs":[{"path":null,"format":{"encoding":"utf8","bom":false,"eol":"lf"},"dirty":false,"lossy":false,"draft":null,"selection":[[0,0]],"main":0,"scrollTop":0,"scrollLeft":0}],"panes":[3]}"#;
    let err = serde_json::from_str::<Session>(bad).unwrap_err().to_string();
    assert!(err.contains("panes[0]=3"), "{err}");

    // 文件形态也要走同一条路：load_session 把它翻译成 Corrupt
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SESSION_FILE_NAME);
    fs::write(&path, bad).unwrap();
    let json = serde_json::to_string(&match load_session(&path) {
        Err(e) => e,
        Ok(other) => panic!("期望解析失败，实际 {other:?}"),
    })
    .unwrap();
    assert!(json.starts_with(r#"{"kind":"corrupt","message":""#), "{json}");
}

#[test]
fn session_error_用_kind_标签区分变体() {
    assert_eq!(
        serde_json::to_string(&SessionError::Corrupt { message: "坏的".into() }).unwrap(),
        r#"{"kind":"corrupt","message":"坏的"}"#
    );
    assert_eq!(
        serde_json::to_string(&SessionError::Version { found: 2, expected: SESSION_VERSION }).unwrap(),
        r#"{"kind":"version","found":2,"expected":1}"#
    );
    assert_eq!(
        serde_json::to_string(&SessionError::NoParent { path: SESSION_FILE_NAME.into() }).unwrap(),
        r#"{"kind":"no_parent","path":"session.json"}"#
    );
    assert_eq!(
        serde_json::to_string(&SessionError::TooLarge {
            bytes: MAX_SESSION_BYTES + 1,
            limit: MAX_SESSION_BYTES
        })
        .unwrap(),
        r#"{"kind":"too_large","bytes":4194305,"limit":4194304}"#
    );
    assert_eq!(
        serde_json::to_string(&SessionError::Io { reason: "NotFound".into(), message: "没了".into() })
            .unwrap(),
        r#"{"kind":"io","reason":"NotFound","message":"没了"}"#
    );
}

/// 「没有会话文件」与「会话文件坏了」是两件不同的事，前端要分别处理：
/// 前者静默地开一个新的，后者得告诉用户「上次没能读回来」。
#[test]
fn 缺失与损坏在契约上是两种结果() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SESSION_FILE_NAME);

    assert_eq!(load_session(&path).unwrap(), None);

    fs::write(&path, b"{").unwrap();
    assert!(matches!(load_session(&path), Err(SessionError::Corrupt { .. })));
}

/// `lossy` 与 `format` 都**没有** serde 默认值：缺一个就整份拒。
///
/// 拦的是那个看起来无害的「向前兼容」修法——给它们加 `#[serde(default)]`。
/// 加了之后旧文件会被解析成 `lossy: false` + UTF-8/LF，于是一个原本会警告
/// 「原样保存会永久损坏这个文件」的文档，重启后安安静静地按 UTF-8 写回去。
/// 会话格式有 `version` 兜着，不认识的整份作废，用不着靠默认值硬吃旧文件。
#[test]
fn lossy_与_format_缺失时整份作废() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SESSION_FILE_NAME);
    let full = serde_json::to_string(&sample_session()).unwrap();

    for key in [r#","lossy":false"#, r#","lossy":true"#, r#","format":{"encoding":"utf8","bom":false,"eol":"lf"}"#] {
        let stripped = full.replacen(key, "", 1);
        assert_ne!(stripped, full, "没找到要摘掉的片段：{key}");
        fs::write(&path, &stripped).unwrap();
        assert!(
            matches!(load_session(&path), Err(SessionError::Corrupt { .. })),
            "缺 {key} 的会话被接受了"
        );
    }
}
