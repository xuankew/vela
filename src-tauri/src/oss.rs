//! 阿里云 OSS 的上传落地层（M7-2，PLAN.md §3.5「图片粘贴自动落地」的 OSS 分支）。
//!
//! ## 这层为什么在 src-tauri 而不在 vela-core
//! 签名本身是纯函数，已经在 [`vela_core::oss`] 里（M7-1）。这层只多出两件**必须有真东西**
//! 才做得成的事：一次真的 HTTPS 请求、一个真的钟。vela-core 的单测跑在临时目录里，
//! 既不该碰网络，也不该读系统时间——那两条都会让用例变成「在这台机器上是这个结果」。
//!
//! ## 🔴 AccessKeySecret 的走向
//! 它只从调用方（`commands.rs` 的 `upload_image`，M7-3）过到这层，再进 `Authorization` 头。
//! 它不进返回值、不进 [`OssTarget`] 的 `Debug`（手写脱敏）、不进任何我们能编出来的错误文案，
//! 也因此不进日志、不进会话存档。
//!
//! ⚠️ 同理 [`put_headers`] 的返回里可能带一条 `x-oss-security-token`（用了 STS 临时令牌时）。
//! 那一条与 secret 同级敏感：别打日志，更别原样回给前端。
//!
//! ## 为什么刻意不跟跳转
//! bucket 与 region 不是同一对时，OSS 回的是**跳转**（`PermanentRedirect`）而不是一个错误码。
//! 默认策略会跟着跳，于是两件坏事同时发生：`Authorization` 被原样发给跳转目标，而用户最后
//! 看到的是 `SignatureDoesNotMatch`——一句指向密钥的错话，真正错的却是 region。
//! 关掉跟随之后，这层自己把 3xx 翻成「bucket 与 region 不是同一对」。
//!
//! ## 为什么超时 30 秒、且不重试
//! 用户明确说了不要进度与取消（PLAN.md 决策 4），所以这层唯一的「停下来」就是
//! [`UPLOAD_TIMEOUT`] 这一个数字。不重试：一次 30 秒没走完的 PUT，更可能是没网或配错，
//! 而不是值得再赌一次的瞬时抖动；而在一个没有取消入口的界面上，重试等于把「毫无反馈」翻倍。
//!
//! ## TLS：为什么这层必须自己装一个 crypto provider
//! 走 reqwest 的 `rustls-no-provider`，也就是 rustls + `rustls-platform-verifier`
//! （**系统信任库**），与 M6 自动更新同一套：不引入第二套 CA，也不往锁文件里加任何东西
//! （依赖声明的理由与许可证核实见根 `Cargo.toml` 的 M7-2 那段）。
//!
//! 🔴 但 `rustls-no-provider` 这个名字是字面意思：reqwest 在 `build()` 时会取
//! `CryptoProvider::get_default()`，取不到就**当场 panic**（`async_impl/client.rs` 里那句
//! "No rustls crypto provider is configured"）。而 panic 在 `async fn` 的 command 里是最坏
//! 的一种失败——前端那个 `invoke` 的 Promise 永远不会 resolve，用户看到的是「点了没反应」。
//! tauri 核心与 updater 各自在某条路径上 `install_default()` 过，但那两条都是**按需**触发的，
//! 第一次粘贴完全可能走在它们前面。所以 [`client`] 自己先装（ring，就是它们装的那一个），
//! 让这一刻不依赖任何别的东西是否先跑过。
//!
//! ## 这一层能测到哪儿
//! 联网那一段（[`put_object`] 发请求与收响应）在本项目的门禁里刻意不测：`reqwest::Error`
//! 没有公开构造器，测试里造不出一个「超时」，而真打一次 OSS 需要一份真密钥。
//! 因此所有能在出门前判完的事都收进了同步的 [`preflight`] 与 [`put_headers`]，
//! 它们覆盖了 403 的头两个嫌疑（签名用的头与发出去的头不一致、`Authorization` 的形状）。

use std::fmt::{self, Debug};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use vela_core::oss::{self, Credentials, SignContext};

/// 一次 PUT 的总超时，含把整个 body 发完。
///
/// 30 秒是按「用户在等一次粘贴」定的上限，不是按 OSS 的能力定的：一张 5 MB 的截图在
/// 家用宽带上一两秒就完，走到 30 秒说明这条路本来就不通。
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// 上传正文的上限：10 MB。
///
/// ⚠️ 与本地那条 [`vela_core::fs::MAX_IMAGE_BYTES`]（32 MB）是两个数，不是写岔了：
/// 那一个管「剪贴板里的东西别把内存吃掉」，这一个管「30 秒内传得完」。
/// 超过它的图在 OSS 分支会降级成本地 `assets/`（M7-7 的决定），所以这一个上限
/// **不该**让用户看到「传不上去就没图了」。
pub const MAX_UPLOAD_BYTES: u64 = 10 * 1024 * 1024;

/// 一次上传所需的全部配置。
///
/// 四个值都由调用方从 settings（M7-5）与钥匙串（M7-4）拼出来。这层不读盘、不读钥匙串：
/// 这样「配置不齐」能说清缺哪一项，而测试不用建一个真 home 目录。
pub struct OssTarget<'a> {
    pub bucket: &'a str,
    /// 只写 `cn-hangzhou` 那一段。带 `oss-` 前缀或带域名会被 [`normalize`] 当场拒掉，
    /// 理由就是服务端那个 `0002-00000226` 错误码。
    pub region: &'a str,
    pub access_key_id: &'a str,
    pub access_key_secret: &'a str,
    /// STS 临时令牌。签名层支持它（`vela_core::oss` 里那两条带令牌的黄金向量就是它），
    /// 目前 Vela 只走长期 AK，所以现实里通常是 `None`。
    pub security_token: Option<&'a str>,
}

impl Debug for OssTarget<'_> {
    /// 🔴 手写：`access_key_secret` 与 `security_token` 都只打「[已隐去]」。
    /// 密钥值一旦进了 `Debug`，就可能经由 `{:?}` 的日志与 panic 文案泄出去。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OssTarget")
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("access_key_id", &self.access_key_id)
            .field("access_key_secret", &"[已隐去]")
            .field("security_token", &self.security_token.map(|_| "[已隐去]"))
            .finish()
    }
}

/// [`normalize`] 通过后那一组**去掉两端空格**的值。
///
/// 为什么单独一个类型，而不是各处就地 `trim()`：签名算的是 `/{bucket}/{key}`，
/// 请求打的是 `https://{bucket}.oss-{region}.aliyuncs.com/…`，两处必须是**同一份**字符串。
/// 把 trim 收在 [`normalize`] 一处，两边就自动共用它。
struct Normalized<'a> {
    bucket: &'a str,
    region: &'a str,
    access_key_id: &'a str,
    access_key_secret: &'a str,
    security_token: Option<&'a str>,
}

/// 检查配置齐不齐，并把值定形成 [`Normalized`]。失败返回一句中文，直接进错误里给前端。
///
/// 顺序是「先缺不缺，再填得对不对」：空的那一项在设置里就能看出来，而 region 的形状
/// 只有真去签名才会炸。
fn normalize<'a>(target: &OssTarget<'a>) -> Result<Normalized<'a>, String> {
    let bucket = target.bucket.trim();
    if bucket.is_empty() {
        return Err("设置里没有填 bucket。".to_owned());
    }
    let access_key_id = target.access_key_id.trim();
    if access_key_id.is_empty() {
        return Err("设置里没有填 AccessKey ID。".to_owned());
    }
    let access_key_secret = target.access_key_secret.trim();
    if access_key_secret.is_empty() {
        return Err("没有拿到 AccessKey Secret，请在设置里填一次。".to_owned());
    }
    let region = target.region.trim();
    if region.is_empty() {
        return Err("设置里没有填 region。".to_owned());
    }
    // 这两条挡的是同一种手滑：把控制台上的「访问域名」整串粘进 region 那一格
    if region.starts_with("oss-") || region.contains('.') {
        return Err(format!(
            "region 填的是「{region}」，但那一格只要中间那一段，例如 cn-hangzhou：不带 `oss-` 前缀，也不带域名。"
        ));
    }
    // 空字符串的令牌比 None 更坏：它会签出一个值为空的 `x-oss-security-token`，
    // 服务端按「带了令牌但令牌是空的」判，回一句与真实原因无关的话
    let security_token = target.security_token.map(str::trim).filter(|token| !token.is_empty());
    Ok(Normalized { bucket, region, access_key_id, access_key_secret, security_token })
}

/// 对象在公网上的地址，也是**成功时要写进正文的那一串**。
///
/// 只有 `https://{bucket}.oss-{region}.aliyuncs.com` 一种形式：自定义域名（CNAME）与
/// 内网 endpoint（`-internal`）都不支持。真要加，得给 [`OssTarget`] 添一个显式的 host
/// 字段，而不是在这里多拼几个 `if`。
///
/// ⚠️ `key` 走 [`oss::uri_encode`] 且**保留 `/`**——这与签名层的 canonical URI 用的是
/// 同一个函数，所以不会出现「签的是 `%20`，发出去的是 `+`」这种只在真机炸的错。
fn object_url(target: &Normalized<'_>, key: &str) -> String {
    format!("https://{}.oss-{}.aliyuncs.com/{}", target.bucket, target.region, oss::uri_encode(key, true))
}

/// 现在这一刻的 UTC 时刻串：`20231216T162057Z`。
///
/// 为什么是 UTC、为什么自己拼六个字段：文档里那两个错误码——`0002-00000223`（SignDate
/// 格式不合）与 `0002-00000235`（与服务器相差超过 15 分钟）——都是本地时区和格式串
/// 拼出来的。这里取 `now_utc()`，六个字段各按各的宽度补零，`Z` 是写死的字面量，
/// 于是第一个码构造不出来；第二个码只剩「本机钟真的不对」一种来源。
///
/// ⛔ 不要在这里加小数秒、偏移量或空格：[`vela_core::oss::sign_date`] 只认这一形，
/// 而它拒掉之后用户看到的是一句「签名时刻不是 YYYYMMDDTHHMMSSZ 那一形」。
pub fn datetime_now() -> String {
    datetime_of(time::OffsetDateTime::now_utc())
}

fn datetime_of(dt: time::OffsetDateTime) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        dt.year(),
        u8::from(dt.month()),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second()
    )
}

/// 这一条 PUT 要发的**全部**请求头：调用方那几条 + 签名层补的那几条。
///
/// 单独抽出来（而不是直接发请求）是为了能在不联网的单测里钉死它。它钉的两件事正是
/// 真机上 403 的头两个嫌疑：
/// 1. `content-type` 既进了签名也进了请求，两边一字不差（它是默认参与签名的头）；
/// 2. `Authorization` 的形状——`Credential={AK}/{date}/{region}/oss/aliyun_v4_request`
///    加一段 64 位十六进制，中间没有 `SignedHeaders=`。
fn put_headers(
    target: &Normalized<'_>,
    key: &str,
    content_type: &str,
    datetime: &str,
) -> Result<Vec<(String, String)>, String> {
    let creds = Credentials {
        access_key_id: target.access_key_id,
        access_key_secret: target.access_key_secret,
        security_token: target.security_token,
    };
    // 实际会发出去的那份请求头，不含鉴权头。签名层从这里挑出默认参与签名的三类，
    // 所以这一个数组就是「签名看到的」，不能多也不能少
    let plain: [(&str, &str); 1] = [("content-type", content_type)];
    let ctx = SignContext {
        method: "PUT",
        bucket: target.bucket,
        key,
        region: target.region,
        datetime,
        headers: &plain,
        query: &[],
        additional_headers: &[],
        credentials: &creds,
    };
    let auth = oss::authorization_headers(&ctx).map_err(|e| e.to_string())?;
    let mut out = vec![("content-type".to_owned(), content_type.to_owned())];
    out.extend(auth.into_iter().map(|(name, value)| (name.to_owned(), value)));
    Ok(out)
}

/// 一条已经备好、只差发出去的 PUT。
struct Prepared {
    url: String,
    headers: Vec<(String, String)>,
}

/// 联网之前能判完的事，一次判完：大小、配置、时刻、签名头、地址。
///
/// 为什么要有这一个函数，而不是把这些都写在 [`put_object`] 里：`put_object` 是 `async`，
/// 而本项目的门禁里没有异步测试运行时（也不该为五条断言加一个依赖）。把同步的部分收进
/// 这里，真机上最先炸的那几类失败就全都能在上架前被测出来。
fn preflight(target: &OssTarget<'_>, key: &str, content_type: &str) -> Result<Prepared, UploadError> {
    let prepared = normalize(target).map_err(|reason| UploadError::NotConfigured { reason })?;
    let datetime = datetime_now();
    let headers =
        put_headers(&prepared, key, content_type, &datetime).map_err(|reason| UploadError::BadSignTime { reason })?;
    Ok(Prepared { url: object_url(&prepared, key), headers })
}

/// 上限检查。`put_object` 的第一件事就是它：先算体积再签名，
/// 一件注定要被拒的事不该先做一遍 HMAC。
///
/// 为什么单独一个同步函数：它是 async 之前的一步，因此能在没有异步测试运行时的门禁里
/// 被直接钉住（`put_object` 那一段就只剩「发请求」这一件测不了的事）。
fn check_size(len: usize) -> Result<(), UploadError> {
    if len as u64 > MAX_UPLOAD_BYTES {
        return Err(UploadError::TooBig { bytes: len as u64, limit: MAX_UPLOAD_BYTES });
    }
    Ok(())
}

/// 共用一个 client：连接池与 TLS 配置都复用，第二次粘贴不用再付一次握手。
///
/// 为什么是 `OnceLock` 而不是 `tauri::State`：这层没有要注入的依赖，也不需要按窗口区分；
/// 而 `upload_image` 是 `async fn`，两次粘贴可能同时在两个 worker 上进来，`get_or_init`
/// 会把后到的那个挡住等前一个建完——只可能建一个，不可能建两个。
///
/// ⚠️ 建不出来时把错误**存起来**而不是 panic：command 里 panic 会让前端那个 `invoke` 的
/// Promise 永远挂着，用户看到的是「点了没反应」，而这本来只是一句能显示的失败。
/// 这种失败也不会自愈，所以只建一次就够。
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // 🔴 顺序是硬要求：reqwest 在 `build()` 里取 `CryptoProvider::get_default()`，
            // 取不到就直接 panic（见模块文档「TLS」那一节）。这一个 client 是全 App 第一条
            // 真的走 rustls 的请求，所以没有任何人替我们保证这一刻已经装好了
            ensure_crypto_provider()?;
            reqwest::Client::builder()
                .timeout(UPLOAD_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(String::clone)
}

/// 保证进程里有一个可用的 rustls crypto provider（ring —— tauri 与 updater 装的那一个）。
///
/// 幂等，所以放在 [`client`] 的 `get_or_init` 里而不是模块加载时：这一句与 reqwest 那句
/// panic 是同一件事的两半，隔开了就没人会想起它们必须挨着。
fn ensure_crypto_provider() -> Result<(), String> {
    // `let _ =` 不是敷衍：已经装过（tauri 或 updater 先跑了那一条）时这里返回 Err，
    // 而那正是要的状态——有一个可用的 provider 就行，不必是我们装的这一个
    let _ = rustls::crypto::ring::default_provider().install_default();
    // 装完再确认一次，把「ring 这一份到底在不在」变成一条能看见的失败，而不是一句 panic
    rustls::crypto::CryptoProvider::get_default()
        .map(|_| ())
        .ok_or_else(|| "rustls 没装上一个可用的 crypto provider".to_owned())
}

/// 把 `bytes` 作为 `key` 传进 `target` 那个 bucket，成功返回**正文里要写的那个 URL**。
///
/// 返回的是不带签名的标准 OSS 地址。这是刻意的：bucket 是私读的，那个地址在浏览器里直接
/// 打开会 403，但它是**稳定的**，能写进 Markdown 也能被别的工具认出来。预览里要真看见图，
/// 走 M7-8 那条临时签名地址（与 `vela-img` 同一个「只在 Vela 里能用」的思路）。
///
/// ⛔ 不要改成返回签名地址：那一个带有效期，把这种串钉进正文，等于把一个有时效的访问凭证
/// 永久写进一份会同步、会备份、会被贴到别处的文档里。
///
/// `content_type` 必须是前端那个真实 MIME（`image/png` 一类）：它是默认参与签名的头，
/// 传 `application/octet-stream` 也能签出一个自洽的请求，但 bucket 里存下来的类型就错了，
/// 以后任何直接打开它的地方都要靠猜。
///
/// 上限由 [`check_size`] 在签名**之前**挡：一件注定要拒的事不该先做一遍 HMAC。
pub async fn put_object(
    target: &OssTarget<'_>,
    key: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> Result<String, UploadError> {
    check_size(bytes.len())?;
    let Prepared { url, headers } = preflight(target, key, content_type)?;
    let mut req = client()
        .map_err(|message| UploadError::Network { reason: "ClientInit".to_owned(), message })?
        .put(url.as_str());
    for (name, value) in headers {
        req = req.header(name, value);
    }
    let resp = req.body(bytes).send().await.map_err(network_error)?;
    let status = resp.status();
    if status.is_success() {
        return Ok(url);
    }
    // 先取头再读体：`text()` 会把 resp 消耗掉。
    // `x-oss-request-id` 优先于错误体里的 `<RequestId>`：请求被中间的设备改写时，
    // 头还在而体已经不是 OSS 那五行了——而那正是最需要 request id 的场合
    let header_id = resp.headers().get("x-oss-request-id").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let body = resp.text().await.unwrap_or_default();
    Err(rejected(status.as_u16(), header_id, &body))
}

/// 一次非 2xx 的响应 → 给人看的失败。
fn rejected(status: u16, request_id: Option<String>, body: &str) -> UploadError {
    let code = xml_field(body, "Code");
    let server_message = xml_field(body, "Message");
    let request_id = request_id.or_else(|| xml_field(body, "RequestId"));
    UploadError::Rejected {
        status,
        message: message_for(status, code.as_deref(), server_message.as_deref()),
        code,
        request_id,
    }
}

/// 按服务端的错误码给一句确定的话；认不出来的才退回去拼一句。
///
/// 这些码是公开且稳定的，比我们对「为什么失败」的猜测准。顺序：认得的码 → 跳转 →
/// 未知码（带上服务端原话）→ 没有码。
fn message_for(status: u16, code: Option<&str>, server_message: Option<&str>) -> String {
    let known = match code {
        Some("InvalidAccessKeyId") => Some(
            "AccessKey ID 不存在或已被禁用。检查设置里那一串是否填对，以及它所属的 RAM 账号还在不在。",
        ),
        Some("SignatureDoesNotMatch") => Some(
            "签名对不上。绝大多数情况是 AccessKey Secret 填错了或已在控制台轮换过；少数情况是 region 与 bucket 不是同一个。",
        ),
        Some("AccessDenied") => Some("这个 AccessKey 没有往该 bucket 写入的权限。用 RAM 子账号的话，策略里要放行 oss:PutObject。"),
        Some("NoSuchBucket") => Some("bucket 不存在：要么名字填错，要么它不在你填的那个 region 里。"),
        Some("InvalidBucketName") => Some("bucket 名字不合规矩：3–63 位，只能是小写字母、数字与连字符，且不能以连字符开头或结尾。"),
        Some("RequestTimeTooSkewed") => Some("本机时间与 OSS 服务器相差超过 15 分钟。打开系统的「自动设置日期与时间」再试。"),
        Some("InvalidArgument") => Some("请求参数被服务端拒绝。最常见的是 region 填成了访问域名（应只写 cn-hangzhou 这样一段）。"),
        _ => None,
    };
    if let Some(message) = known {
        return message.to_owned();
    }
    // bucket 与 region 不配对时 OSS 不给错误码，给跳转（见模块文档「为什么刻意不跟跳转」）
    if (300..400).contains(&status) || code == Some("PermanentRedirect") {
        return "OSS 把这个请求跳到了别的域名，基本可以确定 bucket 与 region 不是同一对。".to_owned();
    }
    match (code, server_message) {
        (Some(code), Some(message)) => format!("OSS 拒绝了这次上传（{code}）：{message}"),
        (Some(code), None) => format!("OSS 拒绝了这次上传（{code}）。"),
        (None, Some(message)) => format!("OSS 回了 HTTP {status}：{message}"),
        // 非 2xx 却没有 `<Code>`：多半是请求被中间的设备改写，或者压根没走到 OSS
        (None, None) => format!("OSS 回了 HTTP {status}，但响应体不是它的错误格式（可能被代理或网关改写了）。"),
    }
}

/// 从 OSS 的错误体里抠一个标签的内容。
///
/// 为什么不引 XML 解析器：只为读三个扁平标签，而任何一家都要新进锁文件（闭源硬约束，
/// 见 PLAN.md）。OSS 的错误体就是那五个扁平标签，没有属性、命名空间和嵌套，
/// 所以这一份只认 `<Tag>内容</Tag>`。自闭合 `<Tag/>` 与不存在的标签一样返回 `None`。
fn xml_field(body: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let start = body.find(&open)? + open.len();
    let rest = &body[start..];
    let end = rest.find(&format!("</{tag}>"))?;
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// 传输层失败（DNS、连接、TLS、超时）→ [`UploadError::Network`]。
///
/// ⚠️ 这一句没法单测：`reqwest::Error` 没有公开的构造器，测试里造不出一个「超时」。
/// 所以它的分支只能靠读——分类顺序是有意的：`is_timeout()` 对「整个调用超了」和
/// 「连接超了」都成立，而这里要的那句人话是「30 秒没传完」，必须先判 timeout。
fn network_error(err: reqwest::Error) -> UploadError {
    let reason = if err.is_timeout() {
        "Timeout"
    } else if err.is_connect() {
        "Connect"
    } else if err.is_body() {
        "Body"
    } else if err.is_decode() {
        "Decode"
    } else {
        "Other"
    };
    UploadError::Network { reason: reason.to_owned(), message: err.to_string() }
}

/// 上传失败的原因。
///
/// 与 [`vela_core::fs::AssetError`] 同一套路数：`#[serde(tag = "kind")]` 让前端按类型分支，
/// 而不是去 `message` 里找关键字。
///
/// 🔴 五个变体里没有任何一个可能带 AccessKeySecret：`Rejected` 只装服务端回的那几样，
/// `Network` 只装 reqwest 的原话（URL 与 errno 一类），`BadSignTime` 只装一句形状抱怨。
/// 以后要加字段，先想清楚它会不会经过签名那一段。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UploadError {
    /// 四项配置里少了一项，或者 region 填成了访问域名的样子。`reason` 直接点名哪一项，
    /// 前端原样显示即可（用户能在设置里改的东西，不该转述成一句通用文案）
    NotConfigured { reason: String },
    /// 超过 [`MAX_UPLOAD_BYTES`]。与本地那条 `TooBig` 同形（`bytes`/`limit`），
    /// 所以前端已有的那句「这张图有 X，超过上限 Y」能直接复用
    TooBig { bytes: u64, limit: u64 },
    /// 签名层拒掉了这一条请求。
    ///
    /// ⚠️ 现实里只可能是「签名时刻的形状不对」，而 [`datetime_now`] 生成的串永远合法，
    /// 所以这一条留着是因为 [`put_headers`] 的失败路径得有个去处——
    /// 不要把它当兜底文案用
    BadSignTime { reason: String },
    /// OSS 回了非 2xx。`code` 是服务端的 `<Code>`（解析不出来时是 `None`），
    /// `message` 是按 code 翻出的一句中文，`request_id` 用于报障
    Rejected { status: u16, code: Option<String>, message: String, request_id: Option<String> },
    /// 请求没走到 OSS。`reason` 是给程序分支的分类（Timeout/Connect/Body/Decode/Other/ClientInit），
    /// `message` 是 reqwest 的原话
    Network { reason: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一组「什么都不缺」的配置，测试只在它上面逐项改坏。
    /// secret 用这个值是为了 `调试输出里看不见密钥` 与 `我们编的失败文案里没有密钥` 能真的搜它。
    fn base() -> OssTarget<'static> {
        OssTarget {
            bucket: "vela-img",
            region: "cn-hangzhou",
            access_key_id: "LTAI5tExampleId",
            access_key_secret: "SECRET-VALUE-DO-NOT-LEAK",
            security_token: None,
        }
    }

    /// M7-1 那六条黄金向量的 datetime 之一。签名与这条时刻必须逐字节相同，
    /// 所以两边共用一个常量，测试里出现的时刻也就是黄金向量里那个。
    const TS: &str = "20231216T162057Z";
    const AK: &str = "LTAI5tExampleId";

    fn prepared() -> Normalized<'static> {
        normalize(&base()).unwrap()
    }

    /// `Authorization` 头里那一段固定前缀；后面的 64 位由密钥与请求内容决定
    const AUTH_PREFIX: &str =
        "OSS4-HMAC-SHA256 Credential=LTAI5tExampleId/20231216/cn-hangzhou/oss/aliyun_v4_request,Signature=";

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
        headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str()).unwrap_or_else(|| panic!("少了 {name} 这一条"))
    }

    #[test]
    fn 时刻串与黄金向量的_datetime_同形() {
        let dt = time::OffsetDateTime::from_unix_timestamp(1_702_743_657).unwrap();
        assert_eq!(datetime_of(dt), TS);
        // 闰日 + 补零：2000-02-29T00:01:24Z。这一条是历法换算最容易错的两处，
        // 拿它当钉子是因为它由 node 的 Date 独立算出来的（与 M7-1 用 Python 复现同理）
        let dt = time::OffsetDateTime::from_unix_timestamp(951_782_484).unwrap();
        assert_eq!(datetime_of(dt), "20000229T000124Z");
    }

    #[test]
    fn 现在的时刻串过得了签名层的形状校验() {
        let now = datetime_now();
        assert_eq!(now.len(), TS.len(), "{now}");
        assert_eq!(&now[8..9], "T", "{now}");
        assert!(now.ends_with('Z'), "{now}");
        assert!(oss::sign_date(&now).is_ok(), "{now}");
    }

    #[test]
    fn 地址按_bucket_与_region_拼并且_key_保留斜杠() {
        assert_eq!(
            object_url(&prepared(), "assets/2026/截 图 1.png"),
            "https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/2026/%E6%88%AA%20%E5%9B%BE%201.png"
        );
    }

    #[test]
    fn 地址里的编码与签名用同一个函数() {
        // canonical URI 是 `/{bucket}/{key}`（见 `vela_core::oss` 的模块文档），
        // 而请求 URL 的路径必须与它编码一致。两边都调 `oss::uri_encode`，
        // 这一条钉的是「别在 URL 那侧另写一个 encode」
        let key = "a b+c/d.png";
        assert_eq!(oss::uri_encode(key, true), "a%20b%2Bc/d.png");
        assert_eq!(
            object_url(&prepared(), key),
            format!("https://vela-img.oss-cn-hangzhou.aliyuncs.com/{}", oss::uri_encode(key, true))
        );
    }

    #[test]
    fn 缺哪一项就说哪一项() {
        for (name, broken) in [
            ("bucket", OssTarget { bucket: "   ", ..base() }),
            ("AccessKey ID", OssTarget { access_key_id: "", ..base() }),
            ("AccessKey Secret", OssTarget { access_key_secret: " ", ..base() }),
            ("region", OssTarget { region: "", ..base() }),
        ] {
            // `let-else` 而不是 `unwrap_err()`：`Normalized` 里揣着 secret 和 token，
            // 它不能派生 Debug，而 `unwrap_err()` 正是要 `Ok` 那一侧的 Debug
            let Err(err) = normalize(&broken) else { panic!("{name} 那一条居然过了") };
            assert!(err.contains(name), "{name} 那一条说的是：{err}");
        }
    }

    #[test]
    fn region_带前缀或域名当场拒绝() {
        // 服务端那两个码（`0002-00000226` 与 InvalidArgument）说的就是这件事，
        // 但那是 403 之后才回来的；这里在出门前挡住
        for bad in ["oss-cn-hangzhou", "cn-hangzhou.oss.aliyuncs.com", " oss-cn-hangzhou.aliyuncs.com "] {
            let broken = OssTarget { region: bad, ..base() };
            let Err(err) = normalize(&broken) else { panic!("{bad} 居然没被挡住") };
            assert!(err.contains("region"), "{bad} → {err}");
            // 提示里必须有一个能照着抄的例子，否则用户只会照着报错再填一次错的
            assert!(err.contains("cn-hangzhou"), "{bad} 的提示里没有例子：{err}");
        }
    }

    #[test]
    fn 两端空格去掉后签名与地址用的是同一份() {
        let messy = OssTarget { bucket: "  vela-img\n", region: " cn-hangzhou ", ..base() };
        let p = normalize(&messy).unwrap();
        assert_eq!(object_url(&p, "a.png"), "https://vela-img.oss-cn-hangzhou.aliyuncs.com/a.png");
        let headers = put_headers(&p, "a.png", "image/png", TS).unwrap();
        let auth = header(&headers, "Authorization");
        assert!(auth.starts_with(AUTH_PREFIX), "{auth}");
    }

    #[test]
    fn 空令牌按没填处理() {
        // 一个空的 `x-oss-security-token` 会被服务端当成「带了令牌但令牌为空」，
        // 回的错话与真实原因无关，所以在定形阶段就归一成 None
        assert_eq!(normalize(&OssTarget { security_token: Some("   "), ..base() }).unwrap().security_token, None);
        assert_eq!(
            normalize(&OssTarget { security_token: Some("  值  "), ..base() }).unwrap().security_token,
            Some("值")
        );
    }

    #[test]
    fn 请求头里签名看到的就是要发出去的() {
        let headers = put_headers(&prepared(), "assets/a.png", "image/png", TS).unwrap();
        let names: Vec<&str> = headers.iter().map(|(n, _)| n.as_str()).collect();
        // content-type 只有一条，且值就是传进来的那个（它是默认参与签名的头）
        assert_eq!(names.iter().filter(|n| **n == "content-type").count(), 1, "{names:?}");
        assert_eq!(header(&headers, "content-type"), "image/png");
        // 签名层补的那两条
        assert_eq!(header(&headers, "x-oss-date"), TS);
        assert_eq!(header(&headers, "x-oss-content-sha256"), oss::UNSIGNED_PAYLOAD);
        assert!(!names.contains(&"x-oss-security-token"), "没填令牌却发出了这一条：{names:?}");
        // host 在 V4 下不参与签名，也不该由我们发（reqwest 自己会带）
        assert!(!names.contains(&"host"), "{names:?}");
    }

    #[test]
    fn authorization_的形状钉死() {
        let auth =
            header(&put_headers(&prepared(), "assets/a.png", "image/png", TS).unwrap(), "Authorization").to_owned();
        assert!(auth.starts_with(AUTH_PREFIX), "{auth}");
        let sig = &auth[AUTH_PREFIX.len()..];
        assert_eq!(sig.len(), 64, "签名该是 64 位十六进制：{sig}");
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{sig}");
        // ⛔ V4 没有 `SignedHeaders=`（AWS SigV4 有，最容易凭印象多写的一条）
        assert!(!auth.contains("SignedHeaders"), "{auth}");
        // 整个值里只允许前缀那一个空格：多一个空格就是 403
        assert_eq!(auth.matches(' ').count(), 1, "{auth}");
    }

    #[test]
    fn 临时令牌进请求头但不进_additional_headers() {
        let p = normalize(&OssTarget { security_token: Some(" sts-token "), ..base() }).unwrap();
        let headers = put_headers(&p, "assets/a.png", "image/png", TS).unwrap();
        assert_eq!(header(&headers, "x-oss-security-token"), "sts-token");
        // `x-oss-*` 本来就在默认参与签名的三类里，不需要也不该再声明进 AdditionalHeaders
        assert!(!header(&headers, "Authorization").contains("AdditionalHeaders"));
    }

    #[test]
    fn 同一份配置两次签出的签名只差在时刻() {
        // 这一条是给「签名是不是把不该进的东西签进去了」兜底的：换一个时刻，
        // 除了 Authorization 的尾巴与 x-oss-date，其余头必须一模一样
        let one = put_headers(&prepared(), "assets/a.png", "image/png", TS).unwrap();
        let two = put_headers(&prepared(), "assets/a.png", "image/png", "20231217T034736Z").unwrap();
        assert_eq!(header(&one, "content-type"), header(&two, "content-type"));
        assert_eq!(header(&one, "x-oss-content-sha256"), header(&two, "x-oss-content-sha256"));
        assert_ne!(header(&one, "Authorization"), header(&two, "Authorization"));
        assert_eq!(header(&two, "Authorization").split_once("Signature=").unwrap().1.len(), 64);
    }

    #[test]
    fn 时刻形状不对时报错而不是签出一个错的() {
        let err = put_headers(&prepared(), "assets/a.png", "image/png", "2023-12-16 16:20:57").unwrap_err();
        assert!(err.contains("YYYYMMDDTHHMMSSZ"), "{err}");
    }

    #[test]
    fn 超限的图不签名也不出门() {
        assert!(check_size(0).is_ok());
        assert!(check_size(MAX_UPLOAD_BYTES as usize).is_ok(), "刚好到上限的要能传——上限是「超过」不是「达到」");
        match check_size(MAX_UPLOAD_BYTES as usize + 1).unwrap_err() {
            UploadError::TooBig { bytes, limit } => {
                assert_eq!(bytes, MAX_UPLOAD_BYTES + 1);
                assert_eq!(limit, MAX_UPLOAD_BYTES);
            }
            other => panic!("应该是 TooBig，实际是 {other:?}"),
        }
    }

    #[test]
    fn preflight_把该挡的都挡在联网前() {
        // 配置不齐 → NotConfigured。⚠️ 这里刻意不 `unwrap_err()`：`Prepared` 里没有
        // 派生 Debug，因为它的 `headers` 里可能躺着一条 `x-oss-security-token`，
        // 而 `{:?}` 一旦写进 panic 文案就没人再管它去哪了
        let empty = OssTarget { bucket: "", ..base() };
        match preflight(&empty, "assets/a.png", "image/png") {
            Err(UploadError::NotConfigured { reason }) => assert!(reason.contains("bucket"), "{reason}"),
            Err(other) => panic!("应该是 NotConfigured，实际是 {other:?}"),
            Ok(_) => panic!("bucket 是空的，不该备出一条请求"),
        }
        // 一切正常时给出地址与四条头（content-type + 签名补的三条）
        let ok = preflight(&base(), "assets/a.png", "image/png").unwrap();
        assert_eq!(ok.url, "https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/a.png");
        assert_eq!(ok.headers.len(), 4, "头的条数不对：content-type、x-oss-date、x-oss-content-sha256、Authorization");
    }

    #[test]
    fn 调试输出里看不见密钥() {
        let text = format!("{:?}", base());
        assert!(!text.contains("SECRET-VALUE-DO-NOT-LEAK"), "secret 漏进 Debug：{text}");
        assert!(text.contains("[已隐去]"), "{text}");
        // access_key_id 是可以露的（它本身不是凭证），bucket 与 region 更要露，
        // 否则真机排查时看不见配的是什么
        assert!(text.contains(AK), "{text}");
        assert!(text.contains("vela-img"), "{text}");
        let with_token = OssTarget { security_token: Some("临时密钥值"), ..base() };
        assert!(!format!("{:?}", with_token).contains("临时密钥值"), "令牌漏进 Debug");
    }

    #[test]
    fn 我们编的失败文案里没有密钥() {
        // 🔴 这两条是模块那个硬约束的可执行版本：凡是**我们自己**拼出来的文案，
        // 都不许把已经拿在手里的密钥值带出去
        let secret = "SECRET-VALUE-DO-NOT-LEAK";
        let token = "STS-VALUE-DO-NOT-LEAK";
        // 这一条手里同时有 secret 和 token，但它只会说缺了 AccessKey ID
        let not_configured = match preflight(
            &OssTarget { access_key_id: "", security_token: Some(token), ..base() },
            "k",
            "image/png",
        ) {
            Err(err) => err,
            // 刻意的 `match` 而不是 `unwrap_err()`：`Prepared` 没有派生 Debug（它的头里
            // 可能躺着一条 `x-oss-security-token`），而 `unwrap_err()` 要的是 `Ok` 那一侧的 Debug
            Ok(_) => panic!("AccessKey ID 是空的，不该备出一条请求"),
        };
        let bad_time =
            UploadError::BadSignTime { reason: put_headers(&prepared(), "k", "image/png", "坏时刻").unwrap_err() };
        for err in [not_configured, bad_time] {
            let text = serde_json::to_string(&err).unwrap();
            assert!(!text.contains(secret), "{text}");
            assert!(!text.contains(token), "{text}");
        }
    }

    #[test]
    fn 错误码翻成中文() {
        let cases = [
            ("SignatureDoesNotMatch", "AccessKey Secret"),
            ("InvalidAccessKeyId", "AccessKey ID"),
            ("AccessDenied", "oss:PutObject"),
            ("NoSuchBucket", "bucket 不存在"),
            ("RequestTimeTooSkewed", "15 分钟"),
            ("InvalidBucketName", "3–63"),
            ("InvalidArgument", "region"),
        ];
        for (code, needle) in cases {
            let body = format!("<Error><Code>{code}</Code><Message>whatever the server said</Message></Error>");
            let err = rejected(403, None, &body);
            let UploadError::Rejected { message, code: got, .. } = err else {
                panic!("应该是 Rejected，实际是 {err:?}");
            };
            assert_eq!(got.as_deref(), Some(code));
            assert!(message.contains(needle), "{code} 的那句里没有「{needle}」：{message}");
            // 服务端的英文原话不该盖掉我们能修的那句话
            assert!(!message.contains("whatever the server said"), "{code} 走了兜底拼装：{message}");
        }
    }

    #[test]
    fn 跳转说_bucket_与_region_不是同一对() {
        let body = "<Error><Code>PermanentRedirect</Code><Message>must be addressed using the specified endpoint</Message></Error>";
        let UploadError::Rejected { message, .. } = rejected(302, None, body) else {
            panic!("302 也该是一个 Rejected");
        };
        assert!(message.contains("bucket 与 region 不是同一对"), "{message}");
        // 没有错误码、只有 3xx 状态也一样：跳转本身就是那一件事
        let UploadError::Rejected { message, .. } = rejected(301, None, "") else { panic!("应该是 Rejected") };
        assert!(message.contains("bucket 与 region 不是同一对"), "{message}");
    }

    #[test]
    fn 未知错误码保留服务端原话() {
        let body = "<Error><Code>QpsLimitExceeded</Code><Message>Please reduce your request rate.</Message></Error>";
        let UploadError::Rejected { message, code, .. } = rejected(503, None, body) else {
            panic!("应该是 Rejected");
        };
        assert_eq!(code.as_deref(), Some("QpsLimitExceeded"));
        // 认不出的码就别说自己懂——把服务端那句带上，比编一句猜测有用
        assert_eq!(message, "OSS 拒绝了这次上传（QpsLimitExceeded）：Please reduce your request rate.");
    }

    #[test]
    fn 非_2xx_且不是错误格式() {
        let err = rejected(502, Some("REQ-1".to_owned()), "<html><body>Bad Gateway</body></html>");
        let UploadError::Rejected { status, code, message, request_id, .. } = err else {
            panic!("应该是 Rejected，实际是 {err:?}");
        };
        assert_eq!(status, 502);
        assert_eq!(code, None);
        assert_eq!(request_id.as_deref(), Some("REQ-1"));
        assert!(message.contains("HTTP 502"), "{message}");
        assert!(message.contains("代理"), "{message}");
    }

    #[test]
    fn request_id_优先取头其次取体() {
        let body = "<Error><Code>AccessDenied</Code><RequestId>BODY-2</RequestId></Error>";
        let from_header = rejected(403, Some("HEAD-1".to_owned()), body);
        let UploadError::Rejected { request_id, .. } = &from_header else {
            panic!("应该是 Rejected，实际是 {from_header:?}");
        };
        assert_eq!(request_id.as_deref(), Some("HEAD-1"), "头的 request id 该优先：请求被改写时体已经不像 OSS 的");
        let from_body = rejected(403, None, body);
        let UploadError::Rejected { request_id, .. } = &from_body else {
            panic!("应该是 Rejected，实际是 {from_body:?}");
        };
        assert_eq!(request_id.as_deref(), Some("BODY-2"), "没有头时该退到错误体里那一个");
    }

    #[test]
    fn 抠标签只认扁平那一种形状() {
        assert_eq!(xml_field("<Error><Code>A</Code></Error>", "Code").as_deref(), Some("A"));
        assert_eq!(xml_field("<Code>  带空白  </Code>", "Code").as_deref(), Some("带空白"));
        assert_eq!(xml_field("<Code></Code>", "Code"), None, "空值等于没有");
        assert_eq!(xml_field("<Code/>", "Code"), None);
        assert_eq!(xml_field("<Error><Code>A</Code></Error>", "Message"), None);
        // 只有开始没有结束的一律当没有：宁可少一句诊断，也不要抠出半篇文章
        assert_eq!(xml_field("<Code>A", "Code"), None);
    }

    #[test]
    fn 错误序列化成前端认的形状() {
        let json = serde_json::to_string(&rejected(403, None, "<Error><Code>AccessDenied</Code></Error>")).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"rejected","status":403,"code":"AccessDenied","message":"这个 AccessKey 没有往该 bucket 写入的权限。用 RAM 子账号的话，策略里要放行 oss:PutObject。","request_id":null}"#
        );
    }

    #[test]
    fn 超时的上限就是那条常量的三十秒() {
        // 前端 M7-7 那句「30 秒没传完」是从这里念出去的，所以数字不许只写在一边
        assert_eq!(UPLOAD_TIMEOUT, Duration::from_secs(30));
        assert_eq!(MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
    }

    #[test]
    fn 建得出_client_且不_panic_也只建一个() {
        // 这一条是真的走一遍 `reqwest::Client::builder().build()`。
        // 它存在的唯一理由是那句 "No rustls crypto provider is configured"：
        // `rustls-no-provider` feature 下 reqwest 取不到进程默认 provider 就 panic，
        // 而 panic 在这层是最坏的失败（前端的 Promise 永远挂着）。除了真的建一次，
        // 没有任何静态检查能告诉我们 ring 那一份到底在不在
        let first = client().unwrap();
        // 第二次拿到的必须是同一个：连接池复用这件事不许靠调用方记得传
        let second = client().unwrap();
        assert!(std::ptr::eq(first, second), "两次 build 出了两个 client");
    }
}
