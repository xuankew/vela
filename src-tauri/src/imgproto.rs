//! 应用自己的 `vela-img` 协议：把预览里的本地图片喂给 `<img>`（M7-9）。
//!
//! ## 为什么是一条自定义协议，而不是 IPC 回 base64
//!
//! 正文里引用二十张图，走 IPC 就是二十次「整个文件读进内存 → 编成 base64 字符串 →
//! 过一遍 JSON 解析」，一张 2 MB 的截图在这条路上会变成 2.7 MB 的字符串两头各解析一次，
//! 而那点钱本来不必花。协议那一边是**一次 `File::open` + 一次响应体**，浏览器拿到的是
//! 原生字节，`loading="lazy"` 与它自己的缓存都还有效。
//!
//! ## 为什么不是 Tauri 自带的 asset 协议
//!
//! 那一个的 `scope` 写在 `tauri.conf.json` 里、**随构建固定**，而 Vela 打开的文档可以在
//! 磁盘任何位置。要让「任意文档旁边的 `assets/`」能显示，scope 就得放开成 `**` / `$HOME/**`
//! 那种宽度——等于把整个磁盘交给预览。这条路上每次请求都带「哪份文档引用了它」，
//! 于是校验是**按文档**的：目标 canonical 之后必须落在那份文档自己那个目录里。
//! 完整的论证与那两条不变量在 `crates/vela-core/src/fs/local_image.rs`。
//!
//! ⚠️ **但这道边界挡的是「正文里写的那个路径」，不是「脚本自己造的 URL」**，这两件事差得很远，
//! 别说反了。`doc` 参数是前端那一段代码（`src/md/localImage.ts`）从**当前文档的真实路径**
//! 填进去的，Markdown 正文里没有任何办法改写它；正文能决定的只有 `ref`。所以一份别人发来的
//! `.md` 里写 `![](/etc/passwd)` 或 `![](../../.ssh/id_rsa)` 都会撞到 403/404——这正是这一层
//! 要挡的东西，也是它挡得住的全部。
//!
//! 而一个**已经能在预览里执行脚本**的攻击者不需要这条路：`csp` 是 `null`，
//! `__TAURI_INTERNALS__.invoke` 对他已经全开（那段威胁的完整描述在
//! `crates/vela-core/src/fs/asset.rs` 的 SVG 一节）。他递一个假的 `doc` 就能读任意目录里的
//! 任意文件——但那时他直接 `invoke("save_file")` 更省事。**这一条没有新增能力，
//! 所以别把它当成 XSS 的缓解措施来引用**；它的价值在于让「读盘」这件事有一个
//! 只看正文、不看脚本的窄口径，而窄口径本来就是 `render.ts` 那条白名单的一部分。
//!
//! ## 🔴 URL 的形状
//!
//! `vela-img://localhost/?doc=<编码过的文档绝对路径>&ref=<编码过的正文引用>`
//!
//! 两个参数都走 query 而不是 URL 的 path 段，是因为 path 段里容不下「两个独立的、
//! 各自可能带 `/` 的字符串」——`assets/a.png` 这种引用自带分隔符，塞进 path 就与
//! 文档目录那一段混成一团，谁也拆不出来。
//!
//! ⚠️ `ref` 是**正文里原样的那个串**（`![](...)` 括号里的内容）经 `encodeURIComponent`
//! 之后的形式，`Url::query_pairs` 读出来时已经解码回原样。解码发生在这一层而不发生在
//! vela-core：「URL 的传输形式」与「文件系统的名字」是两件事，归一化与判定归那边。
//!
//! ## 🔴 这个响应**不带** `Access-Control-Allow-Origin`
//!
//! 这是有意的，而且是一条实打实的边界：预览跑在 `csp: null` 的 webview 里，
//! 而那里 `__TAURI_INTERNALS__.invoke` 对所有注入脚本都可见——但 `fetch()` 要读跨源响应体
//! 就得有 CORS 放行。**不给这个头，`<img>` 照样能显示**（图片是 no-cors 加载），
//! 而脚本想用 `fetch` 把字节读走就会被同源策略挡住。少写一个头，换来的是
//! 「这条路只服务它要服务的那个手势」。
//!
//! ⚠️ 别顺手把它「修好」：加了 `ACAO: *` 的那一刻，这一条就变成了 webview 里任意脚本
//! 可以按任意（文档目录内的）路径读二进制的通道。
//!
//! ## ⚠️ 一个已知会 stale 的地方
//!
//! 响应不带缓存控制头，于是图片被外部替换之后预览可能还显示旧的，直到关掉预览重开。
//! 选这一侧的理由在 `local_image` 模块文档的最后一条。

use std::path::Path;

use tauri::http::{Response, StatusCode, Version};
use tauri::{UriSchemeContext, UriSchemeResponder, Url, Wry};

/// 协议名。**写在这里一次**：前端那份在 `src/md/localImage.ts`，两边拼不上时的症状是
/// 「预览里所有本地图片都加载失败」，而 webview 对失败的 `<img>` 一声不吭。
/// 对它的钉子是 `frontend_shape_matches` 那条测试 + `src/md/localImage.test.ts` 里的黄金 URL
pub const SCHEME: &str = "vela-img";

/// 注册时用的 handler。`lib.rs` 里只有那一行 `.register_asynchronous_uri_scheme_protocol(...)`，
/// 逻辑全在下面的纯函数里，因为它们能不带 webview 测。
pub fn handle(_ctx: UriSchemeContext<'_, Wry>, request: tauri::http::Request<Vec<u8>>, responder: UriSchemeResponder) {
    // 读一条本地图片这件事**不看方法**：GET 与 HEAD 都按 GET 处理，而任何别的方法
    // 也只可能读到同样的字节——这一条路上没有任何写操作，所以不值得为方法分叉
    match normalize_uri(&request) {
        Some(uri) => responder.respond(build_response(&uri)),
        None => responder.respond(text_response(StatusCode::BAD_REQUEST, "这个图片请求的 URI 形状认不出来")),
    }
}

/// 把请求里的 URI 归一成 `vela-img://…` 的绝对形式，认不出来返回 `None`。
///
/// 为什么要认三种形状而不是直接 `Url::parse(request.uri())`：这三个都是**别的平台与别的
/// 版本的 wry 真给得出来**的形态，而认错的失败方式是「预览里每一张本地图都加载不出来」，
/// webview 对一个失败的 `<img>` 一声不吭，用户只会觉得「这功能坏了」。
/// - macOS/Linux（wry 0.57 的 `WKURLSchemeHandler` 那条路）：取的是 `url.absoluteString()`，
///   就是 `vela-img://localhost/?…`
/// - Windows/Android：WebView2 与 Android WebView 都不允许自定义 scheme 直接进网络栈，
///   wry 用 `http://vela-img.localhost/…` 那层 workaround 接住再转回来。转没转干净不由我们赌
/// - 相对形式 `/…?query`：现在两边都不会给，留着是因为它一分钱不花
///
/// ⚠️ 第三种 workaround 必须**宿主名也对上**才算我们的请求。只认 `http` 的话，
/// 这一条就变成「任何指向 `http://anything/` 的图片请求都能让 Rust 去读盘」
fn normalize_uri(request: &tauri::http::Request<Vec<u8>>) -> Option<String> {
    let raw = request.uri().to_string();
    if let Some(rest) =
        raw.strip_prefix("http://vela-img.localhost").or_else(|| raw.strip_prefix("https://vela-img.localhost"))
    {
        return Some(format!("{SCHEME}://localhost{rest}"));
    }
    if raw.starts_with(&format!("{SCHEME}://")) {
        return Some(raw);
    }
    if raw.starts_with('/') {
        return Some(format!("{SCHEME}://localhost{raw}"));
    }
    None
}

/// 一次请求的完整答复。**这是可以脱离 webview 测的那一层**。
pub fn build_response(uri: &str) -> Response<Vec<u8>> {
    let url = match Url::parse(uri) {
        Ok(url) => url,
        // 只有我们自己生成的 URL 会走到这条路上；形状不对说明前端那一半是坏的，
        // 说清楚是好事而不是坏事
        Err(_) => return text_response(StatusCode::BAD_REQUEST, "这个图片请求的 URL 解析不了"),
    };
    if url.scheme() != SCHEME {
        return text_response(StatusCode::BAD_REQUEST, "不是 vela-img 协议的请求");
    }

    let mut doc: Option<String> = None;
    let mut image_ref: Option<String> = None;
    for (key, value) in url.query_pairs() {
        match &*key {
            "doc" => doc = Some(value.into_owned()),
            "ref" => image_ref = Some(value.into_owned()),
            // 多余 parameter 忽略：将来要在 URL 上带尺寸提示之类的东西时，
            // 老版本的这一层不该把请求整个拒掉
            _ => {}
        }
    }
    let (Some(doc), Some(image_ref)) = (doc, image_ref) else {
        return text_response(StatusCode::BAD_REQUEST, "图片请求缺了 doc 或 ref 参数");
    };

    match vela_core::fs::read_local_image(Path::new(&doc), &image_ref) {
        Ok(image) => Response::builder()
            .status(StatusCode::OK)
            // ⚠️ 显式 HTTP/1.1：自定义协议那一边不是一个真的 HTTP 服务器，
            // 而响应体是裸字节，版本号写错不会有谁报错，只会让人查得很费劲
            .version(Version::HTTP_11)
            // 从魔数推出来的那一个，不是从后缀抄的（不变量写在 `fs::asset::ImageKind`）
            .header("content-type", image.mime)
            .body(image.bytes)
            .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR)),
        Err(err) => text_response(status_for(&err), &err.to_string()),
    }
}

/// 错误 → 状态码。
///
/// 🔴 分成六档而不是「全都 404」，是因为 devtools 里那个状态码是排查时唯一的线索。
/// 全用 404 的话，「文档目录被外面的符号链接骗了」（边界在工作）与「这张图真的不存在」
/// 长得一模一样，而那两者的处置完全不同。前端不看这里：`<img>` 只知道成没成
fn status_for(err: &vela_core::fs::LocalImageError) -> StatusCode {
    use vela_core::fs::LocalImageError as E;
    match err {
        E::NoParent { .. } | E::EmptyRef => StatusCode::BAD_REQUEST,
        E::Escaped { .. } => StatusCode::FORBIDDEN,
        E::NotFound { .. } => StatusCode::NOT_FOUND,
        E::NotImage { .. } => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        E::TooBig { .. } => StatusCode::PAYLOAD_TOO_LARGE,
        E::Io { .. } => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn text_response(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .version(Version::HTTP_11)
        .header("content-type", "text/plain; charset=utf-8")
        // ⛔ 这里**不放** `Access-Control-Allow-Origin`，理由在文件头那一条：
        // 少了它，脚本 `fetch` 读不到这句话，而 `<img>` 一点不受影响
        .body(text.as_bytes().to_vec())
        .unwrap_or_else(|_| empty_response(status))
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).version(Version::HTTP_11).body(Vec::new()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
        0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    /// 一个文档 + 旁边一张图的现场，返回「文档绝对路径」
    fn fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("assets")).unwrap();
        fs::write(dir.path().join("assets/a.png"), TINY_PNG).unwrap();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# t\n").unwrap();
        (dir, doc.to_str().unwrap().to_owned())
    }

    /// 前端那一半拼 URL 的等价物：两个参数各自 `encodeURIComponent`
    fn uri(doc: &str, image_ref: &str) -> String {
        use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
        format!(
            "{SCHEME}://localhost/?doc={}&ref={}",
            utf8_percent_encode(doc, NON_ALPHANUMERIC),
            utf8_percent_encode(image_ref, NON_ALPHANUMERIC)
        )
    }

    /// 🔴 与前端 `src/md/localImage.ts` 的 `encodeURIComponent` 对得上：
    /// 两边用的编码集合不同（一边是 JS 内建，一边是 `NON_ALPHANUMERIC` 全转义）时，
    /// 解码那一步仍然对得上——因为 `%2F` 与 `/` 解码后是同一个字节串。
    /// 这一条钉的是「全转义不会把路径转坏」，而不是「两边字节相同」
    #[test]
    fn 全转义的参数能解回原样() {
        let (_dir, doc) = fixture();
        let resp = build_response(&uri(&doc, "assets/a.png"));
        assert_eq!(resp.status(), StatusCode::OK, "文档旁边的图没能读出来");
        assert_eq!(resp.body(), TINY_PNG);
    }

    #[test]
    fn 成功时回的是魔数推出来的_mime_与原样字节() {
        let (_dir, doc) = fixture();
        let resp = build_response(&uri(&doc, "assets/a.png"));
        assert_eq!(resp.headers()["content-type"], "image/png");
        assert_eq!(resp.body().len(), TINY_PNG.len());
    }

    /// ⚠️ 文件头那条边界的钉子：给了 CORS 头，这条路就对任意脚本可读了
    #[test]
    fn 成功与失败的响应都不带_cors_放行头() {
        let (_dir, doc) = fixture();
        let ok = build_response(&uri(&doc, "assets/a.png"));
        assert!(ok.headers().get("access-control-allow-origin").is_none(), "成功响应放了行 CORS");
        let bad = build_response(&uri(&doc, "assets/missing.png"));
        assert!(bad.headers().get("access-control-allow-origin").is_none(), "失败响应放了行 CORS");
    }

    #[test]
    fn 图不存在时是_404_而不是别的() {
        let (_dir, doc) = fixture();
        assert_eq!(build_response(&uri(&doc, "assets/nope.png")).status(), StatusCode::NOT_FOUND);
    }

    /// 边界在工作的那一档必须与「不存在」区分得开——理由在 `status_for` 上
    #[test]
    fn 越界的引用是_403_而不是_404() {
        let parent = tempfile::tempdir().unwrap();
        let inner = parent.path().join("notes");
        fs::create_dir_all(&inner).unwrap();
        let doc = inner.join("note.md");
        fs::write(&doc, "# t\n").unwrap();
        fs::write(parent.path().join("secret.png"), TINY_PNG).unwrap();

        let resp = build_response(&uri(doc.to_str().unwrap(), "../secret.png"));
        assert_eq!(resp.status(), StatusCode::FORBIDDEN, "越界本该 403");
    }

    #[test]
    fn 不是图片的东西是_415() {
        let (dir, doc) = fixture();
        fs::write(dir.path().join("assets/note.txt"), b"just text").unwrap();
        assert_eq!(build_response(&uri(&doc, "assets/note.txt")).status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[test]
    fn 超过上限是_413() {
        let (dir, doc) = fixture();
        let big = dir.path().join("assets/big.png");
        let mut file = fs::File::create(&big).unwrap();
        file.write_all(TINY_PNG).unwrap();
        // 上限 32 MiB；填到刚好越界。零页在 macOS 上是惰性映射的，不真吃内存
        let pad = vec![0u8; 32 * 1024 * 1024 + 2 - TINY_PNG.len()];
        file.write_all(&pad).unwrap();
        drop(file);
        assert_eq!(build_response(&uri(&doc, "assets/big.png")).status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn 缺参数与坏_url_都说一句坏请求() {
        assert_eq!(build_response("vela-img://localhost/").status(), StatusCode::BAD_REQUEST);
        assert_eq!(build_response("vela-img://localhost/?doc=/a/b.md").status(), StatusCode::BAD_REQUEST);
        assert_eq!(build_response("not a url at all").status(), StatusCode::BAD_REQUEST);
        // scheme 不对的不能当成本协议的请求去读盘
        assert_eq!(build_response("https://example.com/?doc=/a/b.md&ref=x").status(), StatusCode::BAD_REQUEST);

        // 🔴 万一将来有人把 URL 改成「路径段」那种更好看的形状（`vela-img://localhost/assets/a.png`），
        // 这里必须**报错**而不是安静地读盘：那种形状拆不出 `doc`，也就没有边界可言了。
        // 这一条不是为现在的前端写的（它只发 `/?doc=…&ref=…`），是为下一个改这里的人写的
        assert_eq!(build_response("vela-img://localhost/assets/a.png").status(), StatusCode::BAD_REQUEST);
        assert_eq!(build_response("vela-img://localhost/?/assets/a.png").status(), StatusCode::BAD_REQUEST);
    }

    fn request(uri: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder().method("GET").uri(uri).body(Vec::new()).expect("构造请求失败")
    }

    /// 🔴 `normalize_uri` 认得的三种形状都要能读出来，而且**只有这三种**。
    /// macOS/Linux 给绝对形式（wry 那一边取的是 `URL.absoluteString()`，不是 `relativeString()`），
    /// Windows/Android 那一侧有没有把 `http://<scheme>.localhost` 的 workaround 还原干净
    /// 不由我们赌，所以两种都得认。见 `normalize_uri` 的文档
    #[test]
    fn 认得出三种_uri_形状_并且拒绝别的() {
        let (_dir, doc) = fixture();
        let full = uri(&doc, "assets/a.png");
        let query = full.strip_prefix(&format!("{SCHEME}://localhost")).unwrap().to_owned();
        assert!(query.starts_with("/?"), "现场造错了：{query}");

        for (label, raw) in [
            ("绝对形式", full.clone()),
            ("相对形式", query.clone()),
            ("Windows 的 workaround 形式", format!("http://vela-img.localhost{query}")),
            ("同一个 workaround 的 https 形式", format!("https://vela-img.localhost{query}")),
        ] {
            let uri = normalize_uri(&request(&raw)).unwrap_or_else(|| panic!("{label} 没被认出来：{raw}"));
            let resp = build_response(&uri);
            assert_eq!(resp.status(), StatusCode::OK, "{label} 读不出图片：{uri}");
            assert_eq!(resp.body(), TINY_PNG, "{label} 读回来的字节不对");
        }

        // ⚠️ 宿主名不对的 workaround 形式必须拒掉：认了就等于「任何 http 请求都能让
        // Rust 按 doc/ref 去读盘」。`http::Uri` 容不下空格，也吃不下 `file:///…`
        // 这种空 authority 的绝对形式，所以这里挑一个**形状完全合法但属于别人**的：
        // 名字里带 `vela-img` 而宿主不是 `localhost`
        assert_eq!(normalize_uri(&request(&format!("http://evil.localhost{query}"))), None);
        assert_eq!(normalize_uri(&request("https://vela-img.example.com/?doc=/a/b.md&ref=x")), None);
        assert_eq!(normalize_uri(&request("https://example.com/?doc=/a/b.md&ref=x")), None);
    }

    #[test]
    fn 协议名与前端那份字符串对得上() {
        // 另一半在 `src/md/localImage.ts` 的 `LOCAL_IMAGE_SCHEME`。这里读不到 TS，
        // 所以钉的是「这个值本身」：改任何一边都必须同时改这一行，
        // 而 `src/md/localImage.test.ts` 的黄金 URL 用例钉的是另一半
        assert_eq!(SCHEME, "vela-img");
    }
}
