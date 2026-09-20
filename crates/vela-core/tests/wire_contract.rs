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
    open_shard, read_text, store_image, write_text_atomic, AssetError, Encoding, FileFormat, LineEnding, ReadError,
    TextFile, WriteReport, MAX_IMAGE_BYTES, MAX_INLINE_BYTES, MAX_SHARD_BYTES,
};
use vela_core::project::{
    create_entry, list_dir, merge_stats, query_many, rename_entry, DirEntry, DirListing, EntryKind, FileIndex,
    FileMatch, FileQuery, IndexStats, TreeError,
};
use vela_core::search::{
    apply, apply_roots, preflight_apply, preflight_apply_roots, preflight_roots, search, search_roots, MatchRange,
    ReplaceProgress, ReplaceRequest, ReplaceSummary, SearchBatch, SearchError, SearchFile, SearchHit, SearchQuery,
    SearchSummary,
};
use vela_core::session::{
    load_session, save_session, PaneDirection, Session, SessionError, SessionProject, SessionReport, SessionRoot,
    SessionTab, MAX_SESSION_BYTES, SESSION_FILE_NAME, SESSION_VERSION,
};
use vela_core::settings::{
    load as load_settings, save as save_settings, user_settings_path, LayerStatus, LoadedSettings, SaveReport,
    Settings, SettingsReport, DEFAULT_CODE_FONT, DEFAULT_FONT_SIZE, DEFAULT_FONT_VARIANT, DEFAULT_LETTER_SPACING,
    DEFAULT_LINE_HEIGHT,
};
use vela_core::watcher::FileChange;

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

// ─────────────────────────── M3-A-7 图片粘贴落地 ───────────────────────────
//
// 前端那一份在 `src/ipc/asset.ts` + `src/ipc/asset.test.ts`。
//
// ⚠️ 这一组契约里**最容易漂移的是 `rel`**：它是唯一一个前端会拿去**拼进文档正文**的字段
// （`![](assets/pasted-xxx.png)`）。别的字段读错了顶多是提示语不对，`rel` 读错了
// 就是正文里躺着一个坏链接——而且它当时看着是对的，要等预览或 GitHub 渲染出破图才发现。

/// 一张 1×1 的透明 PNG，与 `src/fs/asset.rs` 单测里那一份是同一串字节
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

#[test]
fn stored_image_的字段名是_camel_case() {
    let dir = tempfile::tempdir().unwrap();
    let stored = store_image(&dir.path().join("note.md"), TINY_PNG).unwrap();
    let json = serde_json::to_string(&stored).unwrap();

    // 四个字段一个都不能少、一个都不能改名。`path` 含临时目录所以只钉前缀与后缀
    assert!(json.starts_with(r#"{"rel":"assets/pasted-"#), "{json}");
    assert!(json.contains(r#".png","path":"/"#), "{json}");
    assert!(json.contains(&format!(r#""bytes":{},"reused":false}}"#, TINY_PNG.len())), "{json}");

    // rel 里的分隔符**写死是正斜杠**：它是 Markdown 链接，不是文件系统路径。
    // 这一条在 macOS 上与 `Path::display()` 恰好一样，所以只有显式钉住才不会在
    // 将来移植到 Windows 时静默变成反斜杠
    assert!(stored.rel.starts_with("assets/") && !stored.rel.contains('\\'), "{}", stored.rel);

    // 再存一次同一份字节：reused 翻成 true，rel 不变
    let again = store_image(&dir.path().join("note.md"), TINY_PNG).unwrap();
    assert_eq!(again.rel, stored.rel);
    let again_json = serde_json::to_string(&again).unwrap();
    assert!(again_json.ends_with(r#""reused":true}"#), "{again_json}");
}

#[test]
fn asset_error_用_kind_标签区分变体() {
    assert_eq!(serde_json::to_string(&AssetError::Empty).unwrap(), r#"{"kind":"empty"}"#);
    assert_eq!(
        serde_json::to_string(&AssetError::Unsupported { reason: "x".into() }).unwrap(),
        r#"{"kind":"unsupported","reason":"x"}"#
    );
    assert_eq!(
        serde_json::to_string(&AssetError::BadData { reason: "y".into() }).unwrap(),
        r#"{"kind":"bad_data","reason":"y"}"#
    );
    assert_eq!(
        serde_json::to_string(&AssetError::NoParent { path: "note.md".into() }).unwrap(),
        r#"{"kind":"no_parent","path":"note.md"}"#
    );
    // 这两个数字前端要拿去拼「这张图有多大 / 上限多大」，写死了才好对照
    assert_eq!(
        serde_json::to_string(&AssetError::TooBig { bytes: 5, limit: MAX_IMAGE_BYTES as u64 }).unwrap(),
        r#"{"kind":"too_big","bytes":5,"limit":33554432}"#
    );

    // `io` 与 `WriteError` 同形状。用「`assets` 是个文件」这一条真实路径来取样本：
    // reason 是稳定的字面量，message 含临时目录所以只钉前缀
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("assets"), b"not a directory").unwrap();
    let io = serde_json::to_string(&match store_image(&dir.path().join("a.md"), TINY_PNG) {
        Err(e) => e,
        Ok(_) => panic!("期望落地失败"),
    })
    .unwrap();
    assert!(io.starts_with(r#"{"kind":"io","reason":"NotADirectory","message":""#), "{io}");
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
        //
        // 两个根：M2-F 起这是数组，而**顺序就是 `rootIndex`**（侧边栏里第几个项目，
        // 也是行的身份 `RowKey` 的前一半）。只放一个根的话「顺序被排了」这种错
        // 在契约里根本看不出来
        project: Some(SessionProject {
            roots: vec![
                SessionRoot { root: "/Users/me/code/vela".into(), expanded: vec!["".into(), "src/doc".into()] },
                SessionRoot { root: "/Users/me/notes".into(), expanded: vec!["".into()] },
            ],
        }),
        // MRU：最新的在最前面。顺序**就是**这份清单的全部信息量——`Cmd+P` 按位置给
        // 前几名加分（`FileIndex::recent_bonus` 的 `RECENT_TOP - rank`），一次排序失误
        // 的后果是「上周那个文件顶在刚才那个上面」，而这同样不报错。
        // 这里刻意放两条：一条是标签页里的（`/tmp/a.txt`），一条不是——最近打开过又
        // 关掉的才是这份清单的主要价值，只存开着的标签它就没意义了
        recent: vec!["/tmp/a.txt".into(), "/Users/me/code/vela/src/doc/tab.ts".into()],
        // 最近项目（M2-F-6）。一条是**一个根清单**而不是一个路径：多根工作区是用户
        // 一个个「添加文件夹」攒出来的，只记单个文件夹的话切回来就少两个根，
        // 而那件事没有任何提示。两条刻意一条单根、一条多根——嵌套层级写错（少一层数组）
        // 在只放单根时是看不出来的，而它的失败方式同样是静默的
        recent_projects: vec![vec!["/Users/me/code/vela".into(), "/Users/me/notes".into()], vec!["/tmp/a.txt".into()]],
    }
}

#[test]
fn session_的线上形状() {
    let json = serde_json::to_string(&sample_session()).unwrap();

    // 字段顺序 = 结构体声明顺序（serde 的默认行为，前端不依赖它，但钉住能发现重排）；
    // direction 是 snake_case 枚举；selection 的 (usize, usize) 元组落成嵌套数组；
    // f64 永远带小数点（serde_json 的行为，前端 `number` 无所谓，但 0 与 0.0 要一致）；
    // `project`、`recent` 与 `recentProjects` **永远出现**（刻意不用 `skip_serializing_if`，
    // 理由见字段文档），空的时候分别是 `"project":null`、`"recent":[]`、`"recentProjects":[]`
    assert_eq!(
        json,
        r#"{"version":1,"direction":"column","focused":1,"tabs":[{"path":"/tmp/a.txt","format":{"encoding":"utf8","bom":false,"eol":"lf"},"dirty":false,"lossy":false,"draft":null,"selection":[[0,0]],"main":0,"scrollTop":0.0,"scrollLeft":0.0},{"path":null,"format":{"encoding":"gbk","bom":false,"eol":"crlf"},"dirty":true,"lossy":true,"draft":"未保存\n草稿","selection":[[0,3],[4,4]],"main":1,"scrollTop":120.5,"scrollLeft":0.0}],"panes":[0,1],"project":{"roots":[{"root":"/Users/me/code/vela","expanded":["","src/doc"]},{"root":"/Users/me/notes","expanded":[""]}]},"recent":["/tmp/a.txt","/Users/me/code/vela/src/doc/tab.ts"],"recentProjects":[["/Users/me/code/vela","/Users/me/notes"],["/tmp/a.txt"]]}"#
    );
}

/// `SessionProject` 单独钉一份：它是**唯一一个两边都可能写错、而错法又完全静默**的
/// 嵌套结构。`expanded` 里那个空字符串尤其要命——它表示「根那一层摊开着」，
/// 名字或位置写错的后果是重启后树整个收起，用户只会觉得「上次点开的都没了」。
///
/// ⚠️ 这一条**只钉新形状**。旧形状（`{root, expanded}`）能不能读回来钉在
/// `crates/vela-core/src/session/mod.rs` 的 `单根形状的旧_project_读成一个元素的数组` 里：
/// 那是「上一版的格式」，不属于线上契约——线上契约只有当前版本会写的这一种。
#[test]
fn session_project_的线上形状() {
    let sample = SessionProject {
        roots: vec![
            SessionRoot {
                root: "/Users/me/code/vela".into(),
                expanded: vec!["".into(), "src".into(), "src/doc".into()],
            },
            SessionRoot { root: "/Users/me/notes".into(), expanded: vec![] },
        ],
    };
    let json = serde_json::to_string(&sample).unwrap();
    assert_eq!(
        json,
        r#"{"roots":[{"root":"/Users/me/code/vela","expanded":["","src","src/doc"]},{"root":"/Users/me/notes","expanded":[]}]}"#
    );
    assert_eq!(serde_json::from_str::<SessionProject>(&json).unwrap(), sample);

    // `expanded` 空数组是合法的：文件夹打开了但一层都没摊开（用户手动收起了根）。
    // 这与「没打开文件夹」（`project: null`）是两种不同的现场，不能混为一谈。
    // ⚠️ 而 `roots` 空数组**不**合法：同一个事实只留一种写法，见 `validate`
    assert_eq!(
        serde_json::to_string(&SessionProject { roots: vec![SessionRoot { root: "/r".into(), expanded: vec![] }] })
            .unwrap(),
        r#"{"roots":[{"root":"/r","expanded":[]}]}"#
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
        replace: Some("bar".to_owned()),
    })
    .unwrap();
    assert_eq!(
        json,
        r#"{"pattern":"foo","literal":true,"caseSensitive":true,"wholeWord":false,"include":["*.ts"],"exclude":[],"replace":"bar"}"#
    );
    // `replace` 为 None 时上线的是 `null`。⚠️ 但前端**根本不发这个 key**（与 include /
    // exclude 同一条路数，靠容器上的 `#[serde(default)]` 落到 None），所以两种写法都要钉
    assert_eq!(
        serde_json::to_string(&SearchQuery { pattern: "foo".to_owned(), ..SearchQuery::default() }).unwrap(),
        r#"{"pattern":"foo","literal":false,"caseSensitive":false,"wholeWord":false,"include":[],"exclude":[],"replace":null}"#
    );
}

/// 前端可以只发 `pattern`：其余六个字段缺 key 时落到默认值。
///
/// 这一条钉的是**宽容**本身。要是哪天有人把容器上的 `#[serde(default)]` 摘掉，
/// 前端那句 `invoke('start_search', { root, query: { pattern } })` 就会当场变成
/// 「invalid args」，而那个改动的动机看起来只是「收紧一下类型」。
///
/// ⚠️ M2-D 之后这一条还多担一件事：**`replace` 缺 key 必须是 `None`（纯搜索）而不是
/// `Some("")`（把每处命中删掉）**。这两个值的差别是「什么都不改」与「改坏两万个文件」，
/// 而它们只差一个 `Option` 的默认实现
#[test]
fn 只发_pattern_的搜索条件也能解析() {
    let parsed: SearchQuery = serde_json::from_str(r#"{"pattern":"foo"}"#).unwrap();
    assert_eq!(parsed, SearchQuery { pattern: "foo".to_owned(), ..SearchQuery::default() });
    assert!(!parsed.literal && !parsed.case_sensitive && !parsed.whole_word);
    assert!(parsed.include.is_empty() && parsed.exclude.is_empty());
    assert_eq!(parsed.replace, None, "缺 key 必须是「不替换」，不能是「替换成空串」");
    // `Some("")` 是合法的**删除**操作，不能被上面那条顺手拒掉
    assert_eq!(
        serde_json::from_str::<SearchQuery>(r#"{"pattern":"foo","replace":""}"#).unwrap().replace,
        Some(String::new())
    );
}

#[test]
fn search_error_的五个变体在契约上各有其名() {
    // 只有五个，而且**没有 `io`**：单个文件读不动不是失败，它计入 `SearchSummary::unreadable`。
    // 于是「这次搜索失败了」与「这次搜索有几个文件没读成」在契约上就是两种不同的东西。
    //
    // ⚠️ M2-D 加的 `bad_replacement` 与 `bad_pattern` 是**两个 kind 而不是一个**：
    // 前端要把出错的那个输入框标红，搜索词框与替换框是两个框
    let cases = [
        (
            SearchError::BadPattern { message: "搜索词不能为空".to_owned() },
            r#"{"kind":"bad_pattern","message":"搜索词不能为空"}"#,
        ),
        (
            SearchError::BadGlob { glob: "[".to_owned(), message: "炸了".to_owned() },
            r#"{"kind":"bad_glob","glob":"[","message":"炸了"}"#,
        ),
        (
            SearchError::BadReplacement { message: "认不出 $x 这种写法".to_owned() },
            r#"{"kind":"bad_replacement","message":"认不出 $x 这种写法"}"#,
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
///
/// ⚠️ `replaced: None` 那两处**没有改变下面任何一条期望字符串**——M2-D 给
/// `SearchHit` 加字段时挂了 `skip_serializing_if`，所以纯搜索的线上形状与 M2-C 时
/// 一字不差。这件事值得单独说一句：加一个字段而不动既有契约，靠的是那个 attribute，
/// 不是靠运气
#[test]
fn 搜索结果的线上形状() {
    assert_eq!(serde_json::to_string(&MatchRange { start: 4, end: 10 }).unwrap(), r#"{"start":4,"end":10}"#);
    assert_eq!(
        serde_json::to_string(&SearchHit {
            line: 12,
            text: "let a = needle;".to_owned(),
            ranges: vec![MatchRange { start: 8, end: 14 }],
            replaced: None,
            truncated: false,
        })
        .unwrap(),
        r#"{"line":12,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"truncated":false}"#
    );
    // 替换模式下 `replaced` 才上线，位置在 `ranges` 与 `truncated` 之间（跟着字段声明顺序走）
    assert_eq!(
        serde_json::to_string(&SearchHit {
            line: 12,
            text: "let a = needle;".to_owned(),
            ranges: vec![MatchRange { start: 8, end: 14 }],
            replaced: Some("let a = haystack;".to_owned()),
            truncated: false,
        })
        .unwrap(),
        r#"{"line":12,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"replaced":"let a = haystack;","truncated":false}"#
    );
    // ⚠️ `Some("")` 必须**照样序列化出去**，它是「把命中的地方删掉」那个合法操作。
    // `skip_serializing_if` 只跳 `None`，不跳空串——但这条断言存在的全部意义是：
    // 哪天有人把条件改成 `Option::is_none` 之外的东西（比如「空就跳」），
    // 前端读到 `undefined`，那一行会安静地退回成纯搜索的样子，
    // 而用户以为自己刚刚预览了一次删除
    assert_eq!(
        serde_json::to_string(&SearchHit {
            line: 1,
            text: "needle".to_owned(),
            ranges: vec![],
            replaced: Some(String::new()),
            truncated: false,
        })
        .unwrap(),
        r#"{"line":1,"text":"needle","ranges":[],"replaced":"","truncated":false}"#
    );
    assert_eq!(
        serde_json::to_string(&SearchFile {
            rel: "src/main.rs".to_owned(),
            path: "/repo/src/main.rs".to_owned(),
            root_index: 0,
            hits: vec![],
            truncated: true,
        })
        .unwrap(),
        r#"{"rel":"src/main.rs","path":"/repo/src/main.rs","rootIndex":0,"hits":[],"truncated":true}"#
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
                root_index: 0,
                hits: vec![SearchHit {
                    line: 1,
                    text: "needle".to_owned(),
                    ranges: vec![MatchRange { start: 0, end: 6 }],
                    replaced: None,
                    truncated: false,
                }],
                truncated: false,
            }],
            files_scanned: 3,
        })
        .unwrap(),
        r#"{"files":[{"rel":"b.md","path":"/repo/b.md","rootIndex":0,"hits":[{"line":1,"text":"needle","ranges":[{"start":0,"end":6}],"truncated":false}],"truncated":false}],"filesScanned":3}"#
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
            // 纯搜索（query 里没有 `replace`）时这个字段必须整个不存在。
            // 上面那条黄金 JSON 钉的是**形状**，这一条钉的是**真实输出也是那个形状**：
            // 少了它，`skip_serializing_if` 被摘掉的话黄金 JSON 会跟着改，两边一起漂
            assert!(h.replaced.is_none(), "纯搜索不该带替换预览：{:?}", h.replaced);
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

// ────────────────────────────── M2-D 全局替换 ──────────────────────────────
//
// 前端那一份在 `src/ipc/replace.ts` + `src/ipc/replace.test.ts`。
//
// ⚠️ 这一节的分量比上面那节重：搜索的契约漂了，最坏是界面显示错；替换的契约漂了，
// 漂的可能是**「哪些文件被拒了」那几个计数器**。前端要靠它们告诉用户
// 「有 3 个文件没改，因为是二进制」，字段名写错的话它读到 `undefined`，
// 用户看到的是「全部替换完成」——而磁盘上有三个文件一个字节都没动。

/// `ReplaceProgress` / `ReplaceSummary` 的黄金 JSON。
///
/// ⚠️ 十三个字段一个都不能少：`ReplaceSummary` 里那七个 `skipped*` / `*failed`
/// 是「这一层把每一个不确定都倒向不写」这件事**唯一的对外出口**。
/// 少序列化一个，那类拒绝就从用户眼前彻底消失了，而 Rust 侧的测试全绿
#[test]
fn 替换载荷的线上形状() {
    assert_eq!(
        serde_json::to_string(&ReplaceProgress { files_scanned: 12, files_changed: 3, replacements: 7 }).unwrap(),
        r#"{"filesScanned":12,"filesChanged":3,"replacements":7}"#
    );
    assert_eq!(
        serde_json::to_string(&ReplaceSummary {
            files_scanned: 120,
            files_changed: 3,
            replacements: 7,
            skipped_binary: 1,
            skipped_lossy: 2,
            skipped_unmappable: 0,
            skipped_too_large: 4,
            skipped_open: 1,
            unreadable: 2,
            write_failed: 0,
            truncated: false,
            cancelled: true,
            elapsed_ms: 45,
        })
        .unwrap(),
        r#"{"filesScanned":120,"filesChanged":3,"replacements":7,"skippedBinary":1,"skippedLossy":2,"skippedUnmappable":0,"skippedTooLarge":4,"skippedOpen":1,"unreadable":2,"writeFailed":0,"truncated":false,"cancelled":true,"elapsedMs":45}"#
    );
}

/// `ReplaceRequest` 的解析：`skip` 缺 key 必须是「不跳过任何文件」，
/// `query.replace` 缺 key 必须是 `None`（那会被 preflight 拒掉）——
/// 两件事都不能悄悄变成「跳过一切」或「替换成空串」
#[test]
fn 替换请求的线上形状() {
    let parsed: ReplaceRequest = serde_json::from_str(r#"{"query":{"pattern":"a","replace":"b"}}"#).unwrap();
    assert_eq!(parsed.query.pattern, "a");
    assert_eq!(parsed.query.replace.as_deref(), Some("b"));
    assert!(parsed.skip.is_empty(), "缺 key 时 skip 必须是空的");

    let parsed: ReplaceRequest =
        serde_json::from_str(r#"{"query":{"pattern":"a","replace":""},"skip":["/repo/x.ts"]}"#).unwrap();
    assert_eq!(parsed.query.replace, Some(String::new()), "空串是「删掉」，不能变成 None");
    assert_eq!(parsed.skip, vec!["/repo/x.ts".to_owned()]);

    let parsed: ReplaceRequest = serde_json::from_str(r#"{"query":{"pattern":"a"}}"#).unwrap();
    assert!(parsed.query.replace.is_none(), "缺 key 必须是「不替换」，那会被 preflight 拒掉");
}

/// 把「手搓的字面量」与「真实替换」连起来的那一条。
///
/// 上面两条钉的是形状，这一条钉的是**内容**，而且钉的是 M2-D 全部设计里最要命的那个
/// 不变量：**用户在预览里批准的那份清单，就是落盘时改的那份**。`replace.rs` 内部
/// 已经有两条测试从实现侧断言这件事，这里从**线上字段**再断言一次——差别在于
/// 内部测试可以看到私有计数器，而前端只能看到这几个字段。前端能看到的对不上，
/// 内部对得再上也没用。
///
/// ⚠️ 关键手法是 `SearchHit::ranges`：它本来是给前端画高亮用的（一段命中一个 range），
/// 于是 `ranges.len()` 恰好就是「这一行有几处命中」。而 `ReplaceSummary::replacements`
/// 数的也是**处**，不是行。两边因此可以在线上直接对账，不需要任何新增字段
#[test]
fn 真实替换与真实预览在线上对得上() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("src")).unwrap();
    // 一行一处、一行三处、一行没有、一个文件整个没有命中——四种都摆上
    fs::write(root.join("src/a.ts"), "let needle = 1;\nlet other = 2;\nneedle needle needle\n").unwrap();
    fs::write(root.join("src/b.md"), "nothing here\n").unwrap();
    fs::write(root.join("c.txt"), "needle\n").unwrap();

    let query = SearchQuery { pattern: "needle".to_owned(), replace: Some("NEEDLE".to_owned()), ..Default::default() };

    // 先预览。⚠️ 顺序不能反：apply 会把文件改掉，之后再 search 就是另一份结果了
    let mut previewed: Vec<(String, String)> = Vec::new();
    let mut ranges_per_line: Vec<usize> = Vec::new();
    let preview = search(root, &query, &AtomicBool::new(false), |batch| {
        for f in &batch.files {
            for h in &f.hits {
                let replaced = h.replaced.clone().expect("替换模式下每条命中都该带预览");
                previewed.push((f.rel.clone(), replaced));
                ranges_per_line.push(h.ranges.len());
            }
        }
    })
    .unwrap();

    let matches: usize = ranges_per_line.iter().sum();
    assert!(ranges_per_line.iter().any(|&n| n > 1), "前提：得有「一行多处」，否则下面那条区分是空的");

    preflight_apply(root, &ReplaceRequest { query: query.clone(), skip: Vec::new() }).unwrap();
    let mut progress: Vec<ReplaceProgress> = Vec::new();
    let applied =
        apply(root, &ReplaceRequest { query: query.clone(), skip: Vec::new() }, &AtomicBool::new(false), |p| {
            progress.push(p)
        })
        .unwrap();

    // ① 走过同一批文件
    assert_eq!(
        applied.files_scanned, preview.files_scanned,
        "两边扫过的文件数不一致：{} vs {}",
        applied.files_scanned, preview.files_scanned
    );
    assert_eq!(applied.files_scanned, 3, "没命中的那个也算扫过");
    // ② 改的就是预览说有命中的那些
    assert_eq!(applied.files_changed, preview.files_with_hits);
    assert_eq!(applied.files_changed, 2);
    // ③ 换掉的处数 = 预览里所有 range 的个数。⚠️ **不等于** `preview.hits`：
    // 后者数的是命中**行**，一行里可以有多处
    assert_eq!(applied.replacements as usize, matches);
    assert_eq!(applied.replacements, 5);
    assert!(
        preview.hits < applied.replacements,
        "前提：行数与处数在这个 fixture 上确实不同（{} vs {}）",
        preview.hits,
        applied.replacements
    );
    // ④ 一个都没被拒。这条不能省：上面三条在「全部被跳过」时也成立
    // （files_changed = 0 = files_with_hits），而那是完全相反的情形
    assert_eq!(
        (
            applied.skipped_binary,
            applied.skipped_lossy,
            applied.skipped_unmappable,
            applied.skipped_too_large,
            applied.skipped_open,
            applied.unreadable,
            applied.write_failed
        ),
        (0, 0, 0, 0, 0, 0, 0),
        "有文件被静默跳过了"
    );
    assert!(!applied.truncated && !applied.cancelled);

    // ⑤ 磁盘上每一行与预览里那条 `replaced` 逐字相同——这是「所见即所做」的字面意思
    for (rel, replaced) in &previewed {
        let on_disk = fs::read_to_string(root.join(rel)).unwrap();
        assert!(
            on_disk.lines().any(|l| l == replaced),
            "预览说 {rel} 里会出现 {replaced:?}，磁盘上没有。实际内容：{on_disk:?}"
        );
    }
    assert_eq!(previewed.len(), preview.hits as usize);
    assert!(!fs::read_to_string(root.join("src/b.md")).unwrap().contains("NEEDLE"), "没命中的文件被改了");

    // ⑥ 进度快照累计、单调，最后一个与总账对得上。前端拿它画进度条
    assert!(!progress.is_empty(), "一次进度都没推");
    for w in progress.windows(2) {
        assert!(w[1].files_scanned >= w[0].files_scanned, "{progress:?} 扫描数倒退");
        assert!(w[1].files_changed >= w[0].files_changed, "{progress:?} 改动数倒退");
        assert!(w[1].replacements >= w[0].replacements, "{progress:?} 处数倒退");
    }
    let last = *progress.last().unwrap();
    // ⚠️ `files_scanned` 是**不超过**，不是相等。落盘那一侧刻意不做搜索侧那种收尾
    // flush（理由写在 `replace.rs` 里 `Sink` 的文档上），于是最后一个被改动的文件之后
    // 扫过的那些没命中的文件不进快照。这个 fixture 上正好差一个：`src/b.md` 排在最后且没命中
    assert_eq!(last.files_changed, applied.files_changed, "改动数与总账不一致");
    assert_eq!(last.replacements, applied.replacements, "处数与总账不一致");
    assert!(last.files_scanned <= applied.files_scanned, "{last:?} 越过了总账");
    assert_eq!(last.files_scanned, applied.files_scanned - 1, "这个 fixture 上差的就是那个没命中的文件");
}

/// 起飞前检查用的也是同一批线上类型，所以它的拒绝理由也归契约管。
///
/// 前端在按下「替换全部」之前先调一次它，为的是**把一个文件都没动**这件事
/// 摆在写盘之前。这里钉住三种拒法各自的名字：前端要按名字给不同的文案
/// （搜索词写坏了 → 指到搜索框；模板写坏了 → 指到替换框），
/// 全部压成一个字符串的话它只能原样弹出来
#[test]
fn 起飞前检查在线上给出可分支的拒绝理由() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("a.txt"), "needle\n").unwrap();

    // 缺 replace：形状上是合法的 `SearchQuery`，但替换必须有替换内容
    let no_replace =
        ReplaceRequest { query: SearchQuery { pattern: "needle".to_owned(), ..Default::default() }, skip: Vec::new() };
    match preflight_apply(root, &no_replace) {
        Err(SearchError::BadReplacement { message }) => assert!(message.contains("replace"), "{message}"),
        other => panic!("期望 BadReplacement，实际 {other:?}"),
    }
    // 搜索词编不出来
    let bad_pattern = ReplaceRequest {
        query: SearchQuery { pattern: "(".to_owned(), replace: Some("x".to_owned()), ..Default::default() },
        skip: Vec::new(),
    };
    assert!(matches!(preflight_apply(root, &bad_pattern), Err(SearchError::BadPattern { .. })));
    // 模板里的 `$` 用法不支持
    let bad_template = ReplaceRequest {
        query: SearchQuery { pattern: "needle".to_owned(), replace: Some("$-".to_owned()), ..Default::default() },
        skip: Vec::new(),
    };
    assert!(matches!(preflight_apply(root, &bad_template), Err(SearchError::BadReplacement { .. })));

    // ⚠️ 三种都被拒了，而那个文件必须还是原样。这条断言是「检查发生在写盘之前」
    // 唯一的证据——没有它，一个「先改完再报错」的实现同样能让上面三条通过
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "needle\n");
}

/// `Cmd+P` 那两个命令的线上形状（M2-E）。另一半在 `src/ipc/project.test.ts`。
///
/// 与 `dir_listing_的线上形状` 同一个手法：手搓而不是序列化真实输出，因为 `path` 是
/// 落在 `tempfile` 每次都不一样的随机目录里的绝对路径。真实输出对不对由下面
/// `索引查询的_path_就是_root_拼上_rel` 负责
#[test]
fn 文件查询结果的线上形状() {
    let query = FileQuery {
        matches: vec![
            FileMatch {
                rel: "src/store.ts".to_owned(),
                path: "/repo/src/store.ts".to_owned(),
                score: 35,
                root_index: 0,
            },
            FileMatch {
                rel: "docs/about/store-history.md".to_owned(),
                path: "/repo/docs/about/store-history.md".to_owned(),
                score: 23,
                root_index: 1,
            },
        ],
        total: 17,
    };
    // ⚠️ M2-F 之前那五个字段名（rel / path / score / matches / total）没有一个双词的，
    // 所以 `rename_all = "camelCase"` 在这个类型上是恒等的，这一条钉不住大小写漂移。
    // 加进 `root_index` 之后**它能钉住了**：`rootIndex` 写成 `root_index` 的话前端读到
    // `undefined`，浮层里那一行「来自哪个根」就变成空白，而控制台一行错都没有。
    //
    // 两条 `root_index` 刻意写成 0 与 1：字面量里全是 0 的话，看不出这个字段是**每条各自带**
    // 而不是整份查询带一个
    //
    // `total` 刻意写成 17 而不是 2：它与 `matches.len()` **可以不相等**，
    // 那个差值就是前端「还有更多没显示，把词写窄一点」那句话的依据。
    // 字面量里两者相等的话这条契约就看不出形状允许不等了
    assert_eq!(
        serde_json::to_string(&query).unwrap(),
        r#"{"matches":[{"rel":"src/store.ts","path":"/repo/src/store.ts","score":35,"rootIndex":0},{"rel":"docs/about/store-history.md","path":"/repo/docs/about/store-history.md","score":23,"rootIndex":1}],"total":17}"#
    );
}

/// ⚠️ M2-F 之前 `IndexStats` 是这三个类型里**唯一**一个 camelCase 改名真的会生效的：
/// `elapsed_ms` → `elapsedMs`。前端读成 `elapsed_ms` 拿到的是 `undefined`，
/// 而 `undefined` 参与算术是 `NaN`、参与比较是 `false`，两种都不报错。
/// 现在 `FileMatch::root_index` 也成了一个双词字段，于是这一类漂移有了两个可能的落点
/// ——两边各有一条断言，见上面 `文件查询结果的线上形状`
#[test]
fn 索引统计的线上形状() {
    let stats = IndexStats { files: 1234, unreadable: 2, truncated: true, elapsed_ms: 40 };
    assert_eq!(
        serde_json::to_string(&stats).unwrap(),
        r#"{"files":1234,"unreadable":2,"truncated":true,"elapsedMs":40}"#
    );
}

/// 真实索引在线上给出的东西**自洽**：`path` 就是 `root` 拼上 `rel`，
/// `matches` 已经按 `score` 降序排好了。
///
/// 第二条是前端能不能直接画的关键：浮层拿到就渲染，**不再排一次**。
/// 排序规则住在 vela-core 里（那套权重是产品决定，见 `project/index.rs` 的模块文档），
/// 前端要是自己再排一遍就等于把那个决定抄了一份到 TypeScript 里
#[test]
fn 索引查询的_path_就是_root_拼上_rel() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("docs/about")).unwrap();
    fs::write(root.join("docs/about/store-history.md"), "x\n").unwrap();
    fs::write(root.join("store.ts"), "x\n").unwrap();

    let index = FileIndex::build(root).unwrap();
    let got = index.query("store", &[], 10);
    assert_eq!(got.total, 2);
    assert_eq!(got.matches.len(), 2);
    for hit in &got.matches {
        assert_eq!(Path::new(&hit.path), root.join(&hit.rel), "{hit:?}");
        // 单份索引不知道自己是工作区里的第几个，所以恒为 0（多根由 `query_many` 重盖）
        assert_eq!(hit.root_index, 0, "{hit:?}");
    }

    let scores: Vec<u32> = got.matches.iter().map(|hit| hit.score).collect();
    let mut sorted = scores.clone();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(scores, sorted, "线上顺序不是降序，前端就得自己再排一次");

    // ⚠️ 第一条**不是**遍历顺序里的那一条：`docs/` 排在 `store.ts` 前面，
    // 而 `BASENAME` 那条权重把 basename 里命中的这一个顶到了第一位。
    // 这一条断言同时证明「打分在线上也是生效的」，不只是内部测试里的数字
    assert_eq!(got.matches[0].rel, "store.ts");
    assert_eq!(got.matches[1].rel, "docs/about/store-history.md");
    assert!(got.matches[0].score > got.matches[1].score);
}

// ── M2-F 多根工作区 ────────────────────────────────────────────────────────

/// 多根索引：合并出来的那一份在线上仍然满足前端依赖的两条规矩
/// （**降序**、`path` 就是那一个根拼上 `rel`），并且每条都带对根序号。
///
/// ⚠️ 两个根里刻意各放一个同名的 `store.ts`：多根之下 `rel` 不再唯一，
/// 这正是 `rootIndex` 存在的全部理由
#[test]
fn 多根索引合并后仍按分降序且带对根序号() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    fs::write(first.path().join("store.ts"), "x\n").unwrap();
    fs::create_dir_all(second.path().join("docs/about")).unwrap();
    fs::write(second.path().join("docs/about/store-history.md"), "x\n").unwrap();
    fs::write(second.path().join("store.ts"), "x\n").unwrap();

    let index_first = FileIndex::build(first.path()).unwrap();
    let index_second = FileIndex::build(second.path()).unwrap();
    let got = query_many(&[(0, &index_first), (1, &index_second)], "store", &[], 10);

    // `total` 是各根之和（1 + 2），前端「还有更多，把词写窄一点」那句话在多根下照样成立
    assert_eq!(got.total, 3);
    assert_eq!(got.matches.len(), 3);

    let scores: Vec<u32> = got.matches.iter().map(|m| m.score).collect();
    let mut sorted = scores.clone();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(scores, sorted, "合并之后不是降序，前端就得自己再排一次");

    for m in &got.matches {
        // ⚠️ 用**它自己报的那个**根去拼，而不是挨个试哪个能拼上：
        // 「root_index 与 path 对不上」是最难查的一种漂移——浮层上写着 A 根，
        // 回车打开的却是 B 根里的同名文件，而两边都「看起来对」
        let root = if m.root_index == 0 { first.path() } else { second.path() };
        assert_eq!(Path::new(&m.path), root.join(&m.rel), "{m:?}");
    }

    // 同分时按根的顺序。这一条钉的是**稳定**排序：换成 `sort_unstable_by` 的话
    // 两次按键之间同分的两条会互换位置，而浮层里「上一条候选变了」是看得见的抖动
    let ties: Vec<&FileMatch> = got.matches.iter().filter(|m| m.rel == "store.ts").collect();
    assert_eq!(ties.len(), 2);
    assert_eq!(ties[0].score, ties[1].score, "分数不相等的话下面那条断言什么也没钉住");
    assert_eq!((ties[0].root_index, ties[1].root_index), (0, 1));
}

/// `merge_stats`：三个数相加、`truncated` 取**或**。
///
/// ⚠️ 取或是这一条的全部意义：`truncated` 的用途是让 UI 说一句「索引不全，
/// 找不到的文件可能其实存在」。写成「取最后一个」的话，一个走完的根会把
/// 一个没走完的根的那句话**盖掉**，而用户看到的就是一次安静的漏报
#[test]
fn 索引统计合并时_truncated_取或() {
    let merged = merge_stats(&[
        IndexStats { files: 10, unreadable: 1, truncated: false, elapsed_ms: 5 },
        IndexStats { files: 20, unreadable: 0, truncated: true, elapsed_ms: 7 },
    ]);
    assert_eq!(merged, IndexStats { files: 30, unreadable: 1, truncated: true, elapsed_ms: 12 });
    // 反过来的顺序也要给出同一份：合并不能依赖根的排列
    let backwards = merge_stats(&[
        IndexStats { files: 20, unreadable: 0, truncated: true, elapsed_ms: 7 },
        IndexStats { files: 10, unreadable: 1, truncated: false, elapsed_ms: 5 },
    ]);
    assert_eq!(backwards, merged);
    // 空的那一份是全零，而 `truncated` **不是**真：一个根都没有不等于「没走完」
    assert_eq!(merge_stats(&[]), IndexStats { files: 0, unreadable: 0, truncated: false, elapsed_ms: 0 });
}

/// 多根搜索：`rootIndex` 一路传到线上，而 `filesScanned` 是**跨根累计**的。
///
/// 第二条钉的是共用一本账：每个根各记各的话，进度条会在根之间**倒退**，
/// 而倒退的进度条比没有进度条更让人以为卡住了
#[test]
fn 多根搜索的批次里根序号对而扫描数是跨根累计的() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    fs::write(first.path().join("a.txt"), "needle\n").unwrap();
    // 一个没有命中的文件：它必须照样计入 `files_scanned`，否则那个数就不是「扫过多少」
    fs::write(first.path().join("filler.txt"), "nothing\n").unwrap();
    fs::write(second.path().join("a.txt"), "needle\n").unwrap();

    let mut batches = Vec::new();
    let summary = search_roots(
        &[first.path(), second.path()],
        &SearchQuery { pattern: "needle".to_owned(), ..SearchQuery::default() },
        &AtomicBool::new(false),
        |b| batches.push(b),
    )
    .unwrap();

    let files: Vec<&SearchFile> = batches.iter().flat_map(|b| b.files.iter()).collect();
    assert_eq!(files.len(), 2);
    // ⚠️ 两条的 `rel` **完全相同**，靠 `root_index` 才分得开
    assert!(files.iter().all(|f| f.rel == "a.txt"), "{files:?}");
    assert_eq!((files[0].root_index, files[1].root_index), (0, 1), "{files:?}");
    assert_eq!(Path::new(&files[0].path), first.path().join("a.txt"));
    assert_eq!(Path::new(&files[1].path), second.path().join("a.txt"));

    assert_eq!(summary.files_scanned, 3, "两个根加起来");
    assert_eq!(summary.files_with_hits, 2);
    let scanned: Vec<u32> = batches.iter().map(|b| b.files_scanned).collect();
    assert!(scanned.windows(2).all(|w| w[0] <= w[1]), "{scanned:?} 该单调不减");
    assert_eq!(*scanned.last().unwrap(), summary.files_scanned, "最后一个批次的累计数就是总账上那个数");
}

/// 多根替换：两个根都被改到，而总账只有**一份**（`MAX_HITS` 是整次替换的预算，
/// 不是每个根一份——两个根各换两万处等于换掉四万处，而用户批准的是两万）
#[test]
fn 多根替换把两个根都改了而总账是一份() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    fs::write(first.path().join("a.txt"), "needle one\n").unwrap();
    fs::write(second.path().join("b.txt"), "needle two\nneedle three\n").unwrap();
    // 一个读不动的二进制文件：它要被计入 `skipped_binary`，而不是让整次替换失败
    fs::write(second.path().join("c.bin"), b"\x00needle").unwrap();

    let request = ReplaceRequest {
        query: SearchQuery { pattern: "needle".to_owned(), replace: Some("haystack".to_owned()), ..Default::default() },
        skip: Vec::new(),
    };
    preflight_apply_roots(&[first.path(), second.path()], &request).unwrap();

    let mut last = ReplaceProgress { files_scanned: 0, files_changed: 0, replacements: 0 };
    let summary: ReplaceSummary = apply_roots(&[first.path(), second.path()], &request, &AtomicBool::new(false), |p| {
        // 进度也是跨根累计的，理由与搜索那条相同
        assert!(p.files_scanned >= last.files_scanned, "{p:?} 退回了 {last:?}");
        last = p;
    })
    .unwrap();

    assert_eq!(fs::read_to_string(first.path().join("a.txt")).unwrap(), "haystack one\n");
    assert_eq!(fs::read_to_string(second.path().join("b.txt")).unwrap(), "haystack two\nhaystack three\n");
    assert_eq!(summary.files_changed, 2);
    assert_eq!(summary.replacements, 3);
    assert_eq!(summary.skipped_binary, 1);
    assert!(!summary.truncated && !summary.cancelled);
}

/// ⚠️ 所有根**一起查完**才开工。这一条是多根之下「reject = 什么都没发生」唯一的证据。
///
/// 「边查边走」的实现能让单根的所有测试照样通过，而它会在第二个根不合法时留下
/// 「第一个根已经被改过了」这个中间状态——那个状态既没有 UI 也没有别的测试，
/// 而它是**不可撤销**的（Vela 没有跨文件撤销）
#[test]
fn 第二个根不合法时第一个根一个文件都没被改() {
    let good = tempfile::tempdir().unwrap();
    fs::write(good.path().join("a.txt"), "needle\n").unwrap();
    let missing = good.path().join("不存在的根");
    let request = ReplaceRequest {
        query: SearchQuery { pattern: "needle".to_owned(), replace: Some("haystack".to_owned()), ..Default::default() },
        skip: Vec::new(),
    };

    let err = preflight_apply_roots(&[good.path(), &missing], &request).unwrap_err();
    assert!(matches!(err, SearchError::NotFound { .. }), "{err}");
    // `apply_roots` 自己**也**查，不依赖调用方先跑一遍 preflight
    let err = apply_roots(&[good.path(), &missing], &request, &AtomicBool::new(false), |_| unreachable!()).unwrap_err();
    assert!(matches!(err, SearchError::NotFound { .. }), "{err}");
    assert_eq!(fs::read_to_string(good.path().join("a.txt")).unwrap(), "needle\n");

    // 搜索侧同一条规矩：出错时**一个批次都没推出去**
    let query = SearchQuery { pattern: "needle".to_owned(), ..Default::default() };
    assert!(matches!(preflight_roots(&[good.path(), &missing], &query), Err(SearchError::NotFound { .. })));
    let mut batches = 0;
    let err = search_roots(&[good.path(), &missing], &query, &AtomicBool::new(false), |_| batches += 1).unwrap_err();
    assert_eq!(batches, 0, "{err}");
}

/// `vela://file-changed` 载荷里那个 `kind` 的两个取值（M2-G）。
///
/// ⚠️ 这一条钉的是**全 Vela 最安静的失败方式**：`FileChange` 是个无字段枚举，
/// serde 对它的默认写法是 `"Changed"`，而前端那份 `FileChangeKind` 写的是 `"changed"`。
/// 对不上的话事件照样送到、`listen` 照样回调，只是前端 `switch` 走完 default 分支——
/// 于是「外部改了文件而 Vela 一声不吭」，界面上没有任何东西可看，日志里也没有一行。
/// 对照的另一半在 `src/ipc/watch.test.ts`。
#[test]
fn file_change_是两个小写单词() {
    assert_eq!(serde_json::to_string(&FileChange::Changed).unwrap(), r#""changed""#);
    assert_eq!(serde_json::to_string(&FileChange::Removed).unwrap(), r#""removed""#);
}

// ────────────────────────────── M2-H 大文件只读分片 ──────────────────────────────
//
// 前端那一份在 `src/ipc/shard.ts` + `src/ipc/shard.test.ts`，而 src-tauri 那一层
// （`open_large` 的 `{ handle, header }` 信封、以及 `read_lines` 的 `Option` → `null`）
// 的黄金 JSON 在 `src-tauri/src/shard.rs` 的 `线上形状`。
//
// ⚠️ 这一节与本文件其余各节有一处不同：它**跑真的 `open_shard`**，不手搓结构体。
// 理由是这一层的公开边界比别处窄——`Shard` 里的 fd 是私有的，正文只能靠
// `Shard::read_page` 拿到（见 `fs::shard::Shard` 的文档：那是「索引与内容必须来自
// 同一个 inode」这条不变量的**结构性**保证）。手搓一个 `ShardPage` 断言它的字段名
// 压根证明不了「外面的人能不能读到一页」，而那正是这个类型存在的全部理由。
//
// ⚠️ 于是下面两个字面量的**值**与前端那份不同（这里是真文件算出来的），
// 但**字段名与顺序必须逐字相同**。

/// 「第一行\r\nsecond\r\n」：9 + 2 + 6 + 2 = 19 字节、2 行、CRLF、无 BOM、纯 UTF-8。
///
/// ⚠️ 刻意混中文与 ASCII：字节数（19）与字符数（12）不同，于是 `bytes` 与
/// `totalLines` 谁被写成谁的口径都会当场露出来。全 ASCII 的样本查不出这一类错
const SHARD_SAMPLE: &str = "第一行\r\nsecond\r\n";

#[test]
fn 分片元信息与分页的线上形状() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.txt");
    fs::write(&path, SHARD_SAMPLE).unwrap();
    assert_eq!(SHARD_SAMPLE.len(), 19, "样本被改过了，下面那个 19 就不再是它算出来的");

    let mut shard = open_shard(&path).unwrap();
    assert_eq!(
        serde_json::to_string(&shard.header).unwrap(),
        r#"{"totalLines":2,"bytes":19,"encoding":"utf8","bom":false,"eol":"crlf","lossy":false}"#
    );

    // 🔴 CRLF 的那个 `\r` 必须在**线上**就没有：前端把 `lines` 一行一条直接画出来，
    // 而行尾带一个 `\r` 的话每行末尾会多一个看不见的字符，
    // 于是「这一行有多长」的列对齐会差一格——不报错，只是对不上
    let page = shard.read_page(0, 2).unwrap();
    assert_eq!(
        serde_json::to_string(&page).unwrap(),
        r#"{"start":0,"lines":["第一行","second"],"truncated":false,"lossy":false}"#
    );
}

/// ⛔ UTF-16 在分片模式下打不开，理由见 `fs::shard` 模块文档最后一节。
///
/// ⚠️ 这条与 `read_error_用_kind_标签区分变体` 刻意分开：上面那个测的是**内联路径**
/// 能产出的三种，而这一种**只有** `open_shard` 会产出。前端 `ReadError` 那个 union
/// 少一个 arm 的话，`describeFsError` 的 `default` 分支会把它悄悄吞成 `[object Object]`
#[test]
fn 分片接不住的编码在契约上有其名() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("le.txt");
    // BOM(2) + 一个 UTF-16LE 的 "a\n"(4) = 6 字节。`0A` 与 `00` 的相对位置随端序变，
    // 于是「数 `0x0A` 的个数」在它上面压根不是行数
    fs::write(&path, [0xFFu8, 0xFE, 0x61, 0x00, 0x0A, 0x00]).unwrap();

    let err = match open_shard(&path) {
        Err(err) => err,
        Ok(_) => panic!("期望 UTF-16 被明确拒绝"),
    };
    assert_eq!(
        serde_json::to_string(&err).unwrap(),
        r#"{"kind":"unsupported_encoding","encoding":"utf16_le","bytes":6}"#
    );

    // 而 256 MiB 那一道闸报的是 `too_large`，与内联路径**同一个 kind**、只是 limit 不同。
    // 前端靠 `limit` 那个数区分「4 MiB，该改走分片」与「256 MiB，真的打不开」，
    // 所以这一条不许被换成一个新 kind
    let huge = dir.path().join("huge.bin");
    fs::File::create(&huge).unwrap().set_len(MAX_SHARD_BYTES + 1).unwrap();
    match open_shard(&huge) {
        Err(ReadError::TooLarge { limit, .. }) => assert_eq!(limit, MAX_SHARD_BYTES),
        other => panic!("期望 TooLarge，实际 {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 分层配置（M4-A）。与 session 同一套钉法：合并后的最终配置是**具体的三键对象**
// （没有 Option），账单（report）里的两层状态用 snake_case 的 `status` 打标签。
// 前端 `src/ipc/settings.ts` 的镜像类型与 `src/ipc/settings.test.ts` 的黄金 JSON 是另一半。
// ─────────────────────────────────────────────────────────────────────────────

/// `Settings`（合并后的最终配置）的线上形状：紧凑、camelCase、字段顺序 = 声明顺序。
///
/// 这个类型同时是 `save` 命令的**入参**（前端把信号拼成它发回来），所以它必须能
/// 反序列化——下面紧跟一条 `from_str` 钉住这一点。
///
/// ⚠️ `letterSpacing` 的默认值在线上是 `0.0` 而不是 `0`：serde_json 对 `f64` 永远带小数点，
/// 而 JS 那边 `JSON.stringify(0)` 写的是 `0`。两者是**同一个 JSON number**，
/// `JSON.parse("0.0") === JSON.parse("0")`、Rust 侧 `from_str` 也一样，所以两边都能读回来；
/// 只是「落盘字节」这一层不同——前端存的是 `0`，Rust 存的是 `0.0`。与 session 的
/// `scrollTop: 0.0` 同一条取舍（见上面 `session_的线上形状` 的注释）。前端的黄金字面量
/// 因此写 `0`，这里写 `0.0`，各自钉住自己那一侧的输出。
#[test]
fn settings_的线上形状() {
    let json = serde_json::to_string(&Settings::default()).unwrap();
    assert_eq!(
        json,
        r#"{"fontSize":14,"fontVariant":"screen-gb","codeFont":"maple-cn","lineHeight":1.75,"letterSpacing":0.0}"#
    );

    // save 命令收的就是这个形状，必须能原样读回来（含 JS 那侧会发的整数字面量 `0`）
    let parsed: Settings = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, Settings::default());
    assert_eq!(
        serde_json::from_str::<Settings>(
            r#"{"fontSize":14,"fontVariant":"screen-gb","codeFont":"maple-cn","lineHeight":1.75,"letterSpacing":0}"#
        )
        .unwrap(),
        Settings::default(),
        "JS 发的整数 0 必须读成 0.0"
    );

    // 非默认值也一样：字段是具体值不是 Option，任何一档都走同一条反序列化路径
    let custom =
        r#"{"fontSize":16,"fontVariant":"screen-r","codeFont":"inherit","lineHeight":2.0,"letterSpacing":0.05}"#;
    let parsed: Settings = serde_json::from_str(custom).unwrap();
    assert_eq!(
        (parsed.font_size, parsed.font_variant.as_str(), parsed.code_font.as_str()),
        (16, "screen-r", "inherit")
    );
    assert_eq!((parsed.line_height, parsed.letter_spacing), (2.0, 0.05));
}

/// 内置默认值两边各钉一条：这五个常量前端也各写一份（`App.tsx` 的 `DEFAULT_FONT_SIZE`、
/// `fonts/loader.ts` 的 `DEFAULT_VARIANT` / `DEFAULT_CODE_FONT`、`settings/store.ts` 的
/// `DEFAULT_LINE_HEIGHT` / `DEFAULT_LETTER_SPACING`），没有代码生成，与 `MAX_SESSION_TABS`
/// 同一套做法。漂了这条就红。
#[test]
fn 内置默认配置被钉住() {
    assert_eq!(DEFAULT_FONT_SIZE, 14);
    assert_eq!(DEFAULT_FONT_VARIANT, "screen-gb");
    assert_eq!(DEFAULT_CODE_FONT, "maple-cn");
    assert_eq!(DEFAULT_LINE_HEIGHT, 1.75);
    assert_eq!(DEFAULT_LETTER_SPACING, 0.0);
    assert_eq!(Settings::default().font_size, DEFAULT_FONT_SIZE);
    assert_eq!(Settings::default().line_height, DEFAULT_LINE_HEIGHT);
    assert_eq!(Settings::default().letter_spacing, DEFAULT_LETTER_SPACING);
}

/// `LayerStatus` 的三种线上形状。`status` 是标签字段（snake_case），
/// 只有 `corrupt` 带一个 `reason`（事实，文案归前端）。
#[test]
fn layer_status_的三种线上形状() {
    assert_eq!(serde_json::to_string(&LayerStatus::Absent).unwrap(), r#"{"status":"absent"}"#);
    assert_eq!(serde_json::to_string(&LayerStatus::Present).unwrap(), r#"{"status":"present"}"#);
    assert_eq!(
        serde_json::to_string(&LayerStatus::Corrupt { reason: "坏".into() }).unwrap(),
        r#"{"status":"corrupt","reason":"坏"}"#
    );
}

/// `LoadedSettings`（`load` 命令的返回值）的完整线上形状。
///
/// 这里刻意让**两层各走一条不同的下场**：用户层 `present`、项目层 `corrupt`，
/// 再让项目层试图写一个偏好键（`fontSize`）落进 `ignoredProjectKeys`——
/// 把「一层坏掉不拦另一层」「项目层的偏好键被忽略并记账」两件事一次钉住。
#[test]
fn loaded_settings_的线上形状() {
    let loaded = LoadedSettings {
        settings: Settings {
            font_size: 16,
            font_variant: "screen-r".into(),
            code_font: "inherit".into(),
            line_height: 2.0,
            letter_spacing: 0.05,
        },
        report: SettingsReport {
            user_layer: LayerStatus::Present,
            project_layer: LayerStatus::Corrupt { reason: "坏".into() },
            ignored_project_keys: vec!["fontSize".into()],
        },
    };
    assert_eq!(
        serde_json::to_string(&loaded).unwrap(),
        r#"{"settings":{"fontSize":16,"fontVariant":"screen-r","codeFont":"inherit","lineHeight":2.0,"letterSpacing":0.05},"report":{"userLayer":{"status":"present"},"projectLayer":{"status":"corrupt","reason":"坏"},"ignoredProjectKeys":["fontSize"]}}"#
    );
}

/// `SaveReport` 的线上形状：只有一个 camelCase 的 `bytesWritten`。
#[test]
fn save_report_的线上形状() {
    assert_eq!(serde_json::to_string(&SaveReport { bytes_written: 42 }).unwrap(), r#"{"bytesWritten":42}"#);
}

/// 端到端：`load` 在两层都不存在时给出内置默认 + 两层 `absent`，
/// 且这份返回值的线上形状与前端镜像类型对得上。
///
/// 走的是真实的 `load`（真读磁盘），不是手搓结构体——钉住「空现场」这条最常见路径
/// 的**线上字节**，前端启动时第一次调 `load_settings` 收到的就是这个。
#[test]
fn 空现场下_load_的线上形状() {
    let home = tempfile::tempdir().unwrap();
    let loaded = load_settings(home.path(), None);
    assert_eq!(
        serde_json::to_string(&loaded).unwrap(),
        r#"{"settings":{"fontSize":14,"fontVariant":"screen-gb","codeFont":"maple-cn","lineHeight":1.75,"letterSpacing":0.0},"report":{"userLayer":{"status":"absent"},"projectLayer":{"status":"absent"},"ignoredProjectKeys":[]}}"#
    );
}

/// `save` 落盘的是**紧凑契约的 pretty 版**，读回来与 `load` 合并出的配置一致，
/// 且 `bytesWritten` 等于文件真实字节数（与 session 的 `落盘字节与契约字面量一致` 同一姿势）。
///
/// ⚠️ 存的是 pretty JSON（用户会手改这个 dotfile），所以这里的字面量带缩进和换行；
/// 但 `Settings` 的**字段集合与顺序**与上面紧凑那条完全一致，只是排版不同。
/// ⚠️ `letterSpacing` 在 pretty 输出里同样是 `0.0`（带小数点）——前端存这一份时写的是 `0`，
/// 两种写法读回来都是同一个数（见 `settings_的线上形状` 的注释）。
#[test]
fn save_落盘再_load_回来一致() {
    let home = tempfile::tempdir().unwrap();
    let settings = Settings {
        font_size: 18,
        font_variant: "system-mono".into(),
        code_font: "inherit".into(),
        line_height: 2.0,
        letter_spacing: 0.0,
    };

    let report = save_settings(home.path(), &settings).unwrap();
    let path = user_settings_path(home.path());
    assert_eq!(report.bytes_written, fs::read(&path).unwrap().len() as u64);

    // pretty 排版：五键各占一行，两空格缩进（serde_json::to_vec_pretty 的默认）
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\n  \"fontSize\": 18,\n  \"fontVariant\": \"system-mono\",\n  \"codeFont\": \"inherit\",\n  \"lineHeight\": 2.0,\n  \"letterSpacing\": 0.0\n}"
    );

    // 读回来：用户层生效，项目层 absent
    let loaded = load_settings(home.path(), None);
    assert_eq!(loaded.settings, settings);
    assert_eq!(loaded.report.user_layer, LayerStatus::Present);
    assert_eq!(loaded.report.project_layer, LayerStatus::Absent);
}
