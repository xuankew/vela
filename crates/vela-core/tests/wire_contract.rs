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
use std::sync::atomic::AtomicBool;

use vela_core::fs::{
    read_text, write_text_atomic, Encoding, FileFormat, LineEnding, ReadError, TextFile, WriteReport, MAX_INLINE_BYTES,
};
use vela_core::project::{create_entry, list_dir, rename_entry, DirEntry, DirListing, EntryKind, TreeError};
use vela_core::search::{
    search, MatchRange, SearchBatch, SearchError, SearchFile, SearchHit, SearchQuery, SearchSummary,
};
use vela_core::session::{
    load_session, save_session, PaneDirection, Session, SessionError, SessionProject, SessionReport, SessionTab,
    MAX_SESSION_BYTES, SESSION_FILE_NAME, SESSION_VERSION,
};

#[test]
fn file_format_的字段名与枚举值() {
    let json =
        serde_json::to_string(&FileFormat { encoding: Encoding::Utf16Le, bom: true, eol: LineEnding::Crlf }).unwrap();
    // encoding / eol 是 snake_case 枚举（注意 Utf16Le → utf16_le），外层结构体是 camelCase
    assert_eq!(json, r#"{"encoding":"utf16_le","bom":true,"eol":"crlf"}"#);

    assert_eq!(
        serde_json::to_string(&FileFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf }).unwrap(),
        r#"{"encoding":"utf8","bom":false,"eol":"lf"}"#
    );
    assert_eq!(serde_json::to_string(&Encoding::Utf16Be).unwrap(), r#""utf16_be""#);
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
    assert_eq!(serde_json::from_str::<Option<Encoding>>(r#""utf16_le""#).unwrap(), Some(Encoding::Utf16Le));

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
    assert_eq!(serde_json::to_string(&report).unwrap(), r#"{"bytesWritten":1,"unmappable":false}"#);
}

#[test]
fn read_error_用_kind_标签区分变体() {
    let too_large =
        serde_json::to_string(&ReadError::TooLarge { bytes: MAX_INLINE_BYTES + 1, limit: MAX_INLINE_BYTES }).unwrap();
    assert_eq!(too_large, r#"{"kind":"too_large","bytes":4194305,"limit":4194304}"#);

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
// 它的字段比 fs 多好几倍，还有一个枚举、一个嵌套元组数组、一个嵌套结构体，而**任何一个
// 名字写错的失败方式都是「重启后什么都没恢复」——不崩、不报错，用户只会觉得这功能没做**。

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
        // 空字符串是**根**那一层的 rel，不是「没有值」。它必须在契约里出现：
        // 前端 `src/project/store.ts` 用它索引缓存与展开集合，两边对「根怎么表示」
        // 的理解一旦分叉，恢复出来的树就是收起的，而且不报错
        project: Some(SessionProject {
            root: "/Users/me/code/vela".into(),
            expanded: vec!["".into(), "src/doc".into()],
        }),
    }
}

#[test]
fn session_的线上形状() {
    let json = serde_json::to_string(&sample_session()).unwrap();

    // 字段顺序 = 结构体声明顺序（serde 的默认行为，前端不依赖它，但钉住能发现重排）；
    // direction 是 snake_case 枚举；selection 的 (usize, usize) 元组落成嵌套数组；
    // f64 永远带小数点（serde_json 的行为，前端 `number` 无所谓，但 0 与 0.0 要一致）；
    // `project` **永远出现**（刻意不用 `skip_serializing_if`，理由见字段文档），
    // 没开文件夹时是 `"project":null`
    assert_eq!(
        json,
        r#"{"version":1,"direction":"column","focused":1,"tabs":[{"path":"/tmp/a.txt","format":{"encoding":"utf8","bom":false,"eol":"lf"},"dirty":false,"lossy":false,"draft":null,"selection":[[0,0]],"main":0,"scrollTop":0.0,"scrollLeft":0.0},{"path":null,"format":{"encoding":"gbk","bom":false,"eol":"crlf"},"dirty":true,"lossy":true,"draft":"未保存\n草稿","selection":[[0,3],[4,4]],"main":1,"scrollTop":120.5,"scrollLeft":0.0}],"panes":[0,1],"project":{"root":"/Users/me/code/vela","expanded":["","src/doc"]}}"#
    );
}

/// `SessionProject` 单独钉一份：它是**唯一一个两边都可能写错、而错法又完全静默**的
/// 嵌套结构。`expanded` 里那个空字符串尤其要命——它表示「根那一层摊开着」，
/// 名字或位置写错的后果是重启后树整个收起，用户只会觉得「上次点开的都没了」。
#[test]
fn session_project_的线上形状() {
    let json = serde_json::to_string(&SessionProject {
        root: "/Users/me/code/vela".into(),
        expanded: vec!["".into(), "src".into(), "src/doc".into()],
    })
    .unwrap();
    assert_eq!(json, r#"{"root":"/Users/me/code/vela","expanded":["","src","src/doc"]}"#);
    assert_eq!(
        serde_json::from_str::<SessionProject>(&json).unwrap(),
        SessionProject {
            root: "/Users/me/code/vela".into(),
            expanded: vec!["".into(), "src".into(), "src/doc".into()]
        }
    );

    // `expanded` 空数组是合法的：文件夹打开了但一层都没摊开（用户手动收起了根）。
    // 这与「没打开文件夹」（`project: null`）是两种不同的现场，不能混为一谈
    assert_eq!(
        serde_json::to_string(&SessionProject { root: "/r".into(), expanded: vec![] }).unwrap(),
        r#"{"root":"/r","expanded":[]}"#
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
        serde_json::to_string(&SessionError::TooLarge { bytes: MAX_SESSION_BYTES + 1, limit: MAX_SESSION_BYTES })
            .unwrap(),
        r#"{"kind":"too_large","bytes":4194305,"limit":4194304}"#
    );
    assert_eq!(
        serde_json::to_string(&SessionError::Io { reason: "NotFound".into(), message: "没了".into() }).unwrap(),
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
        assert!(matches!(load_session(&path), Err(SessionError::Corrupt { .. })), "缺 {key} 的会话被接受了");
    }
}

/// `DirListing` / `DirEntry` 的线上形状。
///
/// 手搓一个而不是序列化 `list_dir` 的真实输出：`path` 是绝对路径，落在 `tempfile`
/// 每次都不一样的随机目录里，做成字面量的话这个测试自己就会漂。真实输出的四个字段
/// 有没有填对，由下面 `列举结果的_path_与_rel_都以_name_结尾` 负责——两条测试合起来
/// 才等于契约：这一条钉**字段名与顺序**，那一条钉**字段之间的关系**。
#[test]
fn dir_listing_的线上形状() {
    let listing = DirListing {
        rel: "src/doc".to_owned(),
        entries: vec![
            DirEntry {
                name: "tab.ts".to_owned(),
                rel: "src/doc/tab.ts".to_owned(),
                path: "/repo/src/doc/tab.ts".to_owned(),
                is_dir: false,
            },
            DirEntry {
                name: "assets".to_owned(),
                rel: "src/doc/assets".to_owned(),
                path: "/repo/src/doc/assets".to_owned(),
                is_dir: true,
            },
        ],
    };
    // 注意 isDir 而不是 is_dir：结构体是 camelCase。前端 `src/ipc/project.ts` 有一份
    // 对照的字面量，改这里的 serde 属性必须同时改那边
    assert_eq!(
        serde_json::to_string(&listing).unwrap(),
        r#"{"rel":"src/doc","entries":[{"name":"tab.ts","rel":"src/doc/tab.ts","path":"/repo/src/doc/tab.ts","isDir":false},{"name":"assets","rel":"src/doc/assets","path":"/repo/src/doc/assets","isDir":true}]}"#
    );
}

#[test]
fn tree_error_的七个变体在契约上各有其名() {
    let cases = [
        (
            TreeError::Io { reason: "PermissionDenied".to_owned(), message: "没权限".to_owned() },
            r#"{"kind":"io","reason":"PermissionDenied","message":"没权限"}"#,
        ),
        (TreeError::NotFound { path: "/repo/x".to_owned() }, r#"{"kind":"not_found","path":"/repo/x"}"#),
        (
            TreeError::NotADirectory { path: "/repo/a.ts".to_owned() },
            r#"{"kind":"not_a_directory","path":"/repo/a.ts"}"#,
        ),
        // M2-B-5 的两个：新建/改名撞上已有条目，与用户打了一个不能当文件名的东西。
        // 前端要对这两句说不同的话——前者是「换个名字」，后者是「这个名字不行」，
        // 压成一条就只能说「出错了」
        (
            TreeError::AlreadyExists { path: "/repo/README.md".to_owned() },
            r#"{"kind":"already_exists","path":"/repo/README.md"}"#,
        ),
        (TreeError::BadName { name: "a/b".to_owned() }, r#"{"kind":"bad_name","name":"a/b"}"#),
        (TreeError::Escape { rel: "../x".to_owned() }, r#"{"kind":"escape","rel":"../x"}"#),
        (TreeError::BadRoot { path: "repo".to_owned() }, r#"{"kind":"bad_root","path":"repo"}"#),
    ];
    for (error, expected) in cases {
        assert_eq!(serde_json::to_string(&error).unwrap(), expected);
    }
}

/// `create_entry` 的第三个参数：前端发的是 `"file"` / `"dir"` 两个小写单词。
///
/// 单独钉一条的理由是它**两个方向都要过**：既作为命令参数被反序列化，
/// 也在测试里被序列化回来。写成 `"File"` / `true` 的失败方式是 Tauri 报一句
/// 「invalid type」，而前端只会看到一次静默失败的右键菜单。
#[test]
fn entry_kind_是两个小写单词而不是布尔() {
    assert_eq!(serde_json::to_string(&EntryKind::File).unwrap(), r#""file""#);
    assert_eq!(serde_json::to_string(&EntryKind::Dir).unwrap(), r#""dir""#);
    assert_eq!(serde_json::from_str::<EntryKind>(r#""file""#).unwrap(), EntryKind::File);
    assert_eq!(serde_json::from_str::<EntryKind>(r#""dir""#).unwrap(), EntryKind::Dir);
    for bad in [r#""File""#, r#""DIR""#, "true", "false", "null", r#""folder""#] {
        assert!(serde_json::from_str::<EntryKind>(bad).is_err(), "{bad} 本该被拒");
    }
}

/// 新建与改名返回的 `DirEntry`，与 `list_dir` 返回的遵守**同一组字段关系**。
///
/// 这是上一条（`列举结果的_path_与_rel_都以_name_结尾`）在写操作那一侧的对照：
/// 前端拿到返回值之后要立刻把它当普通条目用——喂给下一次 `listDir`、交给 `openFile`。
/// 两边关系不一致的话，失败方式是「刚建出来的文件点不开」，而重读一层就好了，
/// 于是这个 bug 看起来像是偶发的。
#[test]
fn 新建与改名返回的条目与列举结果同形() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("src")).unwrap();

    fn check(entry: &DirEntry, root: &Path) {
        assert!(!entry.name.is_empty());
        assert_eq!(Path::new(&entry.rel).file_name().unwrap().to_string_lossy(), entry.name);
        assert_eq!(Path::new(&entry.path).file_name().unwrap().to_string_lossy(), entry.name);
        assert!(Path::new(&entry.path).is_absolute(), "path 必须是绝对的，前端要拿它去 open_file");
        assert!(entry.rel.ends_with(&entry.name) && !entry.rel.starts_with('/'), "rel 必须是相对形式：{:?}", entry.rel);
        assert_eq!(Path::new(&entry.path), root.join(&entry.rel), "path 必须是 root + rel，前端不做拼接全靠这一条");
        assert_eq!(entry.is_dir, Path::new(&entry.path).is_dir());
    }

    let file = create_entry(root, "src/说明 文档.md", EntryKind::File).unwrap();
    check(&file, root);
    let folder = create_entry(root, "src/assets", EntryKind::Dir).unwrap();
    check(&folder, root);

    let renamed_file = rename_entry(root, &file.rel, "读我.md").unwrap();
    check(&renamed_file, root);
    let renamed_dir = rename_entry(root, &folder.rel, "图片").unwrap();
    check(&renamed_dir, root);

    // 返回的 rel 原样喂回去就能列举——「前端不做路径拼接」那条约定的另一半
    assert!(list_dir(root, &renamed_dir.rel).unwrap().entries.is_empty());
    assert_eq!(
        list_dir(root, "src").unwrap().entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
        vec!["图片", "读我.md"]
    );
}

/// 把「手搓的字面量」与「真实列举」连起来的那一条。
///
/// 没有它，上面两个测试可以全绿而 `list_dir` 依然能发出 `path` 与 `name` 对不上的
/// 数据——那正是前端把 `path` 交给 `open_file` 时会炸的形状。
#[test]
fn 列举结果的_path_与_rel_都以_name_结尾() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/说明 文档.md"), "# 标题").unwrap();

    for rel in ["", "src"] {
        let listing = list_dir(dir.path(), rel).unwrap();
        assert_eq!(listing.rel, rel, "归一化后的 rel 与原样传进来的不一致");
        assert!(!listing.entries.is_empty(), "{rel:?} 这一层本该有条目");
        for entry in &listing.entries {
            assert!(!entry.name.is_empty());
            assert_eq!(Path::new(&entry.rel).file_name().unwrap().to_string_lossy(), entry.name);
            assert_eq!(Path::new(&entry.path).file_name().unwrap().to_string_lossy(), entry.name);
            assert!(Path::new(&entry.path).is_absolute(), "path 必须是绝对的，前端要拿它去 open_file");
            assert!(
                entry.rel.ends_with(&entry.name) && !entry.rel.starts_with('/'),
                "rel 必须是相对形式：{:?}",
                entry.rel
            );
            assert_eq!(entry.is_dir, Path::new(&entry.path).is_dir());
        }
    }
}

// ────────────────────────────── M2-C 全文搜索 ──────────────────────────────
//
// 前端那一份在 `src/ipc/search.ts` + `src/ipc/search.test.ts`。搜索的契约比 fs / project
// 更容易漂：它一次要走**五个**类型（query、hit、file、batch、summary），而且其中四个是
// 通过 event 推过去的，不是命令的返回值——Tauri 对 event payload 不做任何参数校验，
// 所以字段名写错的失败方式连一句「invalid args」都没有，前端只是收到一堆 `undefined`。

/// ⚠️ 改任何一边都必须同时改另一边：字段名对不上的失败方式是 `undefined`
/// 而不是异常——`caseSensitive` 写成 `case_sensitive`，Rust 那边靠
/// `#[serde(default)]` 安静地拿到 `false`，于是「我明明勾了区分大小写」变成
/// 「搜索结果里全是不想要的东西」，控制台一行错都没有。
#[test]
fn search_query_的线上形状() {
    let json = serde_json::to_string(&SearchQuery {
        pattern: "foo".to_owned(),
        literal: true,
        case_sensitive: true,
        whole_word: false,
        include: vec!["*.ts".to_owned()],
        exclude: vec![],
    })
    .unwrap();
    assert_eq!(
        json,
        r#"{"pattern":"foo","literal":true,"caseSensitive":true,"wholeWord":false,"include":["*.ts"],"exclude":[]}"#
    );
}

/// 前端可以只发 `pattern`：其余五个字段缺 key 时落到默认值。
///
/// 这一条钉的是**宽容**本身。要是哪天有人把容器上的 `#[serde(default)]` 摘掉，
/// 前端那句 `invoke('start_search', { root, query: { pattern } })` 就会当场变成
/// 「invalid args」，而那个改动的动机看起来只是「收紧一下类型」。
#[test]
fn 只发_pattern_的搜索条件也能解析() {
    let parsed: SearchQuery = serde_json::from_str(r#"{"pattern":"foo"}"#).unwrap();
    assert_eq!(parsed, SearchQuery { pattern: "foo".to_owned(), ..SearchQuery::default() });
    assert!(!parsed.literal && !parsed.case_sensitive && !parsed.whole_word);
    assert!(parsed.include.is_empty() && parsed.exclude.is_empty());
}

#[test]
fn search_error_的四个变体在契约上各有其名() {
    // 只有四个，而且**没有 `io`**：单个文件读不动不是失败，它计入 `SearchSummary::unreadable`。
    // 于是「这次搜索失败了」与「这次搜索有几个文件没读成」在契约上就是两种不同的东西
    let cases = [
        (
            SearchError::BadPattern { message: "搜索词不能为空".to_owned() },
            r#"{"kind":"bad_pattern","message":"搜索词不能为空"}"#,
        ),
        (
            SearchError::BadGlob { glob: "[".to_owned(), message: "炸了".to_owned() },
            r#"{"kind":"bad_glob","glob":"[","message":"炸了"}"#,
        ),
        (SearchError::BadRoot { path: "repo".to_owned() }, r#"{"kind":"bad_root","path":"repo"}"#),
        (SearchError::NotFound { path: "/repo".to_owned() }, r#"{"kind":"not_found","path":"/repo"}"#),
    ];
    for (error, expected) in cases {
        assert_eq!(serde_json::to_string(&error).unwrap(), expected);
    }
}

/// 五个结果类型的形状。
///
/// ⚠️ 手搓字面量，不用真实搜索的输出：`path` 落在 `tempfile` 的随机目录里、
/// `elapsed_ms` 每次都不同，做成字面量这个测试自己就会漂。
/// 真实输出与字段**之间的关系**（`rel` 与 `path` 指向同一个文件、偏移量按码元数）
/// 由 `search/run.rs` 里那些跑真实目录的测试钉住。
#[test]
fn 搜索结果的线上形状() {
    assert_eq!(serde_json::to_string(&MatchRange { start: 4, end: 10 }).unwrap(), r#"{"start":4,"end":10}"#);
    assert_eq!(
        serde_json::to_string(&SearchHit {
            line: 12,
            text: "let a = needle;".to_owned(),
            ranges: vec![MatchRange { start: 8, end: 14 }],
            truncated: false,
        })
        .unwrap(),
        r#"{"line":12,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"truncated":false}"#
    );
    assert_eq!(
        serde_json::to_string(&SearchFile {
            rel: "src/main.rs".to_owned(),
            path: "/repo/src/main.rs".to_owned(),
            hits: vec![],
            truncated: true,
        })
        .unwrap(),
        r#"{"rel":"src/main.rs","path":"/repo/src/main.rs","hits":[],"truncated":true}"#
    );
    // ⚠️ 两种形状都钉：`files` 为空的那一个不是「没有结果」，是一次**心跳**
    // （理由与前端该怎么处理它，写在 `SearchBatch` 的文档里）。
    // 新加的 `filesScanned` 是 camelCase——写成 `files_scanned` 的话前端读到 `undefined`，
    // 进度条永远停在 0，而控制台一行错都没有
    assert_eq!(
        serde_json::to_string(&SearchBatch { files: vec![], files_scanned: 512 }).unwrap(),
        r#"{"files":[],"filesScanned":512}"#
    );
    assert_eq!(
        serde_json::to_string(&SearchBatch {
            files: vec![SearchFile {
                rel: "b.md".to_owned(),
                path: "/repo/b.md".to_owned(),
                hits: vec![SearchHit {
                    line: 1,
                    text: "needle".to_owned(),
                    ranges: vec![MatchRange { start: 0, end: 6 }],
                    truncated: false,
                }],
                truncated: false,
            }],
            files_scanned: 3,
        })
        .unwrap(),
        r#"{"files":[{"rel":"b.md","path":"/repo/b.md","hits":[{"line":1,"text":"needle","ranges":[{"start":0,"end":6}],"truncated":false}],"truncated":false}],"filesScanned":3}"#
    );
    assert_eq!(
        serde_json::to_string(&SearchSummary {
            files_scanned: 120,
            files_with_hits: 3,
            hits: 7,
            skipped_too_large: 1,
            unreadable: 2,
            truncated: false,
            cancelled: true,
            elapsed_ms: 45,
        })
        .unwrap(),
        r#"{"filesScanned":120,"filesWithHits":3,"hits":7,"skippedTooLarge":1,"unreadable":2,"truncated":false,"cancelled":true,"elapsedMs":45}"#
    );
}

/// 把「手搓的字面量」与「真实搜索」连起来的那一条，作用与上面
/// `列举结果的_path_与_rel_都以_name_结尾` 完全相同：没有它，形状对了而内容可以是空的。
///
/// 这里额外钉一件事——**event 推出去的批次与命令返回的总账必须对得上**。
/// 前端是拿 `SearchSummary::hits` 去核对它自己攒了多少条的，两边不一致的失败方式是
/// 界面上写「共 7 处」而列表里只有 5 处，用户会以为有结果没加载出来。
#[test]
fn 真实搜索的批次与总账互相对得上() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("src")).unwrap();
    fs::write(root.join("src/a.ts"), "needle one\nneedle two\n").unwrap();
    fs::write(root.join("b.md"), "needle\n").unwrap();
    fs::write(root.join("c.md"), "nothing\n").unwrap();

    let mut batches = Vec::new();
    let summary = search(
        root,
        &SearchQuery { pattern: "needle".to_owned(), ..SearchQuery::default() },
        &AtomicBool::new(false),
        |b| {
            batches.push(b);
        },
    )
    .unwrap();

    let files: Vec<&SearchFile> = batches.iter().flat_map(|b| b.files.iter()).collect();
    assert_eq!(files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), ["b.md", "src/a.ts"]);
    for f in &files {
        assert!(!f.rel.starts_with('/') && !f.rel.contains('\\'), "{}", f.rel);
        assert_eq!(Path::new(&f.path), root.join(&f.rel), "{}", f.rel);
        assert!(!f.hits.is_empty(), "推进批次的文件一定有命中");
        for h in &f.hits {
            assert!(h.line >= 1, "行号是 1 起的");
            assert!(!h.text.ends_with('\n') && !h.text.ends_with('\r'), "text 不带行终止符：{:?}", h.text);
            // 偏移量是**码元**，所以校验也要按码元切，不能按字节或字符
            let units: Vec<u16> = h.text.encode_utf16().collect();
            for r in &h.ranges {
                assert!(r.start <= r.end && (r.end as usize) <= units.len(), "{:?} 越出了 {:?}", r, h.text);
                assert_eq!(String::from_utf16_lossy(&units[r.start as usize..r.end as usize]), "needle");
            }
        }
    }

    assert_eq!(summary.files_with_hits as usize, files.len());
    assert_eq!(summary.hits as usize, files.iter().map(|f| f.hits.len()).sum::<usize>());
    assert_eq!(summary.files_scanned, 3, "没命中的那个也算扫过");
    assert!(!summary.truncated && !summary.cancelled);

    // 批次上的 `filesScanned` 是**累计**值，不是增量。前端拿它当进度显示之前得先知道这一点：
    // 当成增量的话十万个文件会显示成「已扫两百万个」
    let scanned: Vec<u32> = batches.iter().map(|b| b.files_scanned).collect();
    assert!(scanned.windows(2).all(|w| w[0] <= w[1]), "{scanned:?} 应该单调不减");
    assert!(*scanned.last().unwrap() <= summary.files_scanned, "{scanned:?} 越过了总账");
}
