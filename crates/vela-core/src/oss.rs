//! 阿里云 OSS 的 V4 签名（`OSS4-HMAC-SHA256`）：纯计算，不发请求、不读配置、不碰钥匙串。
//!
//! ## 为什么住在 vela-core
//!
//! 签名是「给定输入 → 一个确定的字符串」，是整个 OSS 那条路上唯一**能在单测里钉死**的一段；
//! 而发请求那一段（`reqwest`、超时、403 的文案）跟运行时绑在一起。分层的理由与 `watcher`、
//! `trash` 那两条一样：能同步跑完的留在内核，落在系统调用上的留在 `src-tauri`。
//!
//! ## 🔴 规矩的来源是官方 SDK 与官方文档，不是记忆
//!
//! 这一层逐条对照 `alibabacloud-oss-go-sdk-v2` 的 `signer/v4.go` 写。黄金值有两个来源，
//! 而且**各管各的段落**：
//!
//! - **规范化请求与它的哈希**：官方文档「V4 签名」那页的完整示例（bucket `examplebucket`、
//!   object `exampleobject`、时刻 `20250411T064124Z`），文档直接给出哈希
//!   `c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca`。
//! - **五个最终签名**：官方 SDK `signer/v4_test.go` 的断言原文（固定的 ak/sk/region/bucket/key，
//!   时间戳按它自己的 `signTime` 换算成 UTC）。头鉴权三条、预签名两条。
//!
//! ⚠️ 文档那页还给了 `SigningKey = 3543b768…` 与 `Signature = 053edbf5…`，**这两值复现不出来**：
//! 它的 AccessKeySecret 写的是 `yourAccessKeySecret`（打码的占位），拿它算不出文档自己那两串。
//! 所以文档只用来钉「规范化请求与哈希」这一段，密钥派生与最终签名一律以 SDK 的断言为准。
//! 别照着文档那两串写测试——那等于把一层永远复现不了的期望钉进代码里，之后每次改签名都会
//! 先撞上它、再被误读成「我把签名改坏了」。
//!
//! ## 三条与 AWS SigV4 不一样、很容易签错的地方
//!
//! 1. 🔴 **`host` 不进签名**。V4 默认参与签名的请求头只有 `x-oss-*`、`content-type`、
//!    `content-md5` 三类，外加显式声明的 additional headers。照 AWS 的习惯把 `host` 放进去，
//!    服务端复现出来的规范化请求就多一行，症状是永远对不上的 403。
//! 2. 🔴 **规范化 URI 里带 bucket**（`/examplebucket/exampleobject`），哪怕请求发的是虚拟主机
//!    风格的 `https://examplebucket.oss-cn-hangzhou.aliyuncs.com/exampleobject`。bucket 在 URL
//!    里只出现在主机名，在签名里却是路径的第一段。
//! 3. 🔴 **`Authorization` 里没有 `SignedHeaders=`**。声明了 additional headers 时那一段叫
//!    `AdditionalHeaders=a;b`，而默认那三类**根本不声明**——服务端自己按同一套规则挑出来。
//!    逗号后面不带空格：文档的模板写法带（`…, AdditionalHeaders=…, Signature=…`），但 SDK
//!    与文档自己的 PutObject 示例发的都是不带空格的形，按实际发出去的那一份来。
//!
//! ## ⚠️ 两个当初挂着「待核实」的问题，答案是文档给的
//!
//! - **payload 要不要算 sha256？** 不要。`x-oss-content-sha256` 目前只支持 `UNSIGNED-PAYLOAD`
//!   这一个值（文档原话「目前只支持该值」），于是规范化请求最后一行恒为那串字面量，
//!   上传多大的字节都不用先哈希一遍。这一层因此压根不接 body。
//! - **预签名有没有 `CanonicalizedResource`？** V4 没有这个概念（那是 V1 的）。预签名把
//!   `x-oss-signature-version` / `x-oss-date` / `x-oss-expires` / `x-oss-credential`
//!   （以及有 token 时的 `x-oss-security-token`、声明了时的 `x-oss-additional-headers`）
//!   当普通查询参数拼进去，**这些全都参与规范化查询串的构造**；`x-oss-signature` 最后追加，
//!   它自己不参与。所以「先算签名再拼参数」是错的：先拼参数、再算签名、最后追加。
//!
//! ## ⚠️ 签名日期是 `datetime` 的前八位，不是第二个入参
//!
//! 两处各自读一次系统时间就会在跨午夜时给出不一致的一对，服务端回 `0002-00000223`；
//! 切成前缀之后这一对**不可能**不一致。同理 `region` 只有一个入参：写进 scope 的是
//! `cn-hangzhou`，endpoint 里那一个是 `oss-cn-hangzhou`，抄错会得到 `0002-00000226`。
//!
//! ## ⛔ 密钥不进返回值、不进 `Debug`
//!
//! `Credentials` 借的是钥匙串里那一份，`Debug` 是手写的、把 secret 隐去；两条签名路径的
//! 返回值里都只有请求头名值与那串签名，任何一路都不带 secret。⚠ 但头鉴权那条返回的
//! 请求头**可能带 `x-oss-security-token`**（STS 临时密钥），它与密钥同级别：别把返回值整个
//! `println!`，也别塞进失败文案里。
//!
//! ## ⚠️ 已知不在这一层
//!
//! `datetime` 那一形字符串由调用方产出（`src-tauri` 那边一次读时间、一次格式化）。
//! 这一层只校验它的**形状**，校验不了它是不是真的「现在」——时钟漂 15 分钟以上服务端会拒
//! （`0002-00000235`），那是发请求那一条要处理的事。

use std::fmt::{self, Write as _};

use hmac::{Hmac, Mac};
use sha2::Digest as _;
use sha2::Sha256;

/// 签名算法名：同时是 `Authorization` 的前缀与 `x-oss-signature-version` 的值
pub const ALGORITHM: &str = "OSS4-HMAC-SHA256";
/// scope 里那一段产品名。OSS 恒为 `oss`（云盒才是 `oss-cloudbox`）
pub const PRODUCT: &str = "oss";
/// 规范化请求的最后一行。文档明确目前只支持这一个值
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

/// scope 末尾那段固定后缀，也是密钥派生的第四层输入
const SCOPE_TAIL: &str = "aliyun_v4_request";

/// 签名用的密钥。只借不存：拿到的应该是钥匙串里那一份，签完就散。
pub struct Credentials<'a> {
    pub access_key_id: &'a str,
    pub access_key_secret: &'a str,
    /// STS 临时凭证才有；长期 AK 传 `None`
    pub security_token: Option<&'a str>,
}

/// 🔴 手写的 `Debug`：`{creds:?}` 出现在任何一条日志或 panic 里都不能把 secret 带出去
impl fmt::Debug for Credentials<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &self.access_key_id)
            .field("access_key_secret", &"[已隐去]")
            .field("security_token", &self.security_token.map(|_| "[已隐去]"))
            .finish()
    }
}

/// 一次要签名的请求。
///
/// ⚠️ `headers` 是**实际会发出去**的那一份（鉴权头不用写，见 [`authorization_headers`]），
/// `query` 与 `key` 都是**原文**、还没编码的那一份。编码在这一层做：调用方预先编一遍会得到
/// `%2520` 这种双重编码，而它的症状是「签名与服务端算的不一致」，跟真正的原因隔着三层。
#[derive(Debug, Clone, Copy)]
pub struct SignContext<'a> {
    /// 全大写的 HTTP 方法（`PUT` / `GET`），原样进规范化请求
    pub method: &'a str,
    pub bucket: &'a str,
    /// object key，**原文**、不带前导 `/`，例如 `notes/pasted-8f3a.png`
    pub key: &'a str,
    /// `cn-hangzhou` 这一形，⛔ 不是 endpoint 里的 `oss-cn-hangzhou`
    pub region: &'a str,
    /// UTC 时刻，`20250411T064124Z` 那一形；签名日期由它的前八位切出来
    pub datetime: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub query: &'a [(&'a str, &'a str)],
    /// 额外声明进签名的请求头名。默认那三类写在这儿也会被剔除——它们本来就在签名里，
    /// 重复声明会改变 `Authorization` 的形状（SDK 同一条规则）
    pub additional_headers: &'a [&'a str],
    pub credentials: &'a Credentials<'a>,
}

/// `datetime` 不是 `YYYYMMDDTHHMMSSZ` 那一形
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidSignTime;

impl fmt::Display for InvalidSignTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("签名时刻不是 YYYYMMDDTHHMMSSZ 那一形")
    }
}

impl std::error::Error for InvalidSignTime {}

/// unreserved 字符集，与 SDK 里那张 `noEscape` 表逐个字节对过：英文数字加 `- . _ ~`
fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

/// RFC 3986 意义上的 percent-encode；`keep_slash` 决定 `/` 是原样还是 `%2F`。
///
/// ⚠️ 按**字节**遍历：非 ASCII 的 object key（中文文件名很常见）要编成 UTF-8 那三个字节
/// `%E4%B8%AD`，按 `char` 编会得到一个四位的 `%U4E2D` 之类的东西，服务端认不出。
pub fn uri_encode(raw: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        if is_unreserved(*byte) || (keep_slash && *byte == b'/') {
            out.push(*byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// 是不是「不声明也参与签名」的那三类头。名字大小写不敏感，`x-oss-` 前缀同理
pub fn is_default_signed_header(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    low.starts_with("x-oss-") || low == "content-type" || low == "content-md5"
}

/// 参与签名的那一份请求头：名字已转小写、同名已并值、已按名字排序，
/// 外加**有效**的 additional 声明（默认三类与不存在的头都被剔掉了）。
///
/// 这一步不是形式主义：SDK 里那三条黄金向量的差别全在「哪些头进了签名」上，
/// 而它恰好是签名最容易错的一段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedHeaders {
    entries: Vec<(String, String)>,
    declared: Vec<String>,
}

impl SignedHeaders {
    /// `extras` 是鉴权层自己要补的那几条，按**覆盖**语义合并（SDK 用的是 Go `Header.Set`）：
    /// 调用方完全可能已经写过一条 `x-oss-content-sha256`（官方 SDK 的用例里就有），
    /// 并成 `UNSIGNED-PAYLOAD,UNSIGNED-PAYLOAD` 服务端不认。
    ///
    /// ⚠️ 同名多条（非 extras）按 `,` 并成一行，且**每条值各自 trim**——顺序是「先各自 trim
    /// 再 join」，先 join 再整体 trim 会把夹在中间的那个空格留下。
    pub fn build(headers: &[(&str, &str)], extras: &[(&str, &str)], additional: &[&str]) -> Self {
        let mut merged: Vec<(String, Vec<String>)> = Vec::new();
        for (name, value) in headers {
            let low = name.to_ascii_lowercase();
            match merged.iter_mut().find(|(k, _)| *k == low) {
                Some(slot) => slot.1.push(value.trim().to_string()),
                None => merged.push((low, vec![value.trim().to_string()])),
            }
        }
        for (name, value) in extras {
            let low = name.to_ascii_lowercase();
            let values = vec![value.trim().to_string()];
            match merged.iter_mut().find(|(k, _)| *k == low) {
                Some(slot) => slot.1 = values,
                None => merged.push((low, values)),
            }
        }
        let declared = {
            let mut kept: Vec<String> = additional
                .iter()
                .map(|k| k.to_ascii_lowercase())
                .filter(|low| !is_default_signed_header(low))
                .filter(|low| merged.iter().any(|(k, values)| k == low && !values.join(",").is_empty()))
                .collect();
            kept.sort();
            kept.dedup();
            kept
        };
        let mut entries: Vec<(String, String)> = merged
            .into_iter()
            .filter(|(low, _)| is_default_signed_header(low) || declared.contains(low))
            .map(|(low, values)| (low, values.join(",")))
            .collect();
        entries.sort();
        Self { entries, declared }
    }

    /// 规范化请求的第四段：每行 `名字:值`，**自带结尾换行**（那一段与第五段之间的空行
    /// 就是这么来的，不是排版写错了）
    pub fn canonical_block(&self) -> String {
        let mut out = String::new();
        for (name, value) in &self.entries {
            out.push_str(name);
            out.push(':');
            out.push_str(value);
            out.push('\n');
        }
        out
    }

    /// `Authorization` 里 `AdditionalHeaders=` 后面那一段，以及规范化请求的第五段
    pub fn declared_joined(&self) -> String {
        self.declared.join(";")
    }

    /// 参与签名的头名字（已排序）。给调用方核对「到底哪些头进了签名」用
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(name, _)| name.as_str())
    }
}

/// 编码 + 同名后写覆盖 + 按编码后的键名排序那一份。
///
/// 规范化的那串与真拼进 URL 的那一串共用它（区别只是空值要不要带 `=`），否则「签的是一份、
/// 发出去的是另一份」这种缝就一直在那儿。
fn sorted_query(query: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::with_capacity(query.len());
    for (key, value) in query {
        let pair = (uri_encode(key, false), uri_encode(value, false));
        match pairs.iter_mut().find(|(existing, _)| *existing == pair.0) {
            Some(slot) => slot.1 = pair.1,
            None => pairs.push(pair),
        }
    }
    pairs.sort();
    pairs
}

/// 规范化的那一段：空值的键**不带** `=`
fn canonical_from(pairs: &[(String, String)]) -> String {
    pairs.iter().map(|(k, v)| if v.is_empty() { k.clone() } else { format!("{k}={v}") }).collect::<Vec<_>>().join("&")
}

/// 真拼进 URL 的那一串：空值的键也带 `=`（与 SDK 的 `Encode()` 一致）。
///
/// ⚠️ 两处只差这一个 `=`，共用同一份排好序的对，于是「签的是一份、发出去的是另一份」
/// 这种缝压根不存在。
fn url_from(pairs: &[(String, String)]) -> String {
    pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
}

/// 规范化查询串：按键名**编码之后**排序，空值的键不带 `=`。
///
/// ⚠️ 排序在编码之后（`%2Bparam1` 排在 `param1` 前面），与 SDK 一致；编码前排序结果不同，
/// 而那一份不是服务端要复现的形。
pub fn canonical_query(query: &[(&str, &str)]) -> String {
    canonical_from(&sorted_query(query))
}

/// scope：`20250411/cn-hangzhou/oss/aliyun_v4_request`
pub fn scope(date: &str, region: &str) -> String {
    format!("{date}/{region}/{PRODUCT}/{SCOPE_TAIL}")
}

/// `datetime` 的前八位，也就是签名日期
pub fn sign_date(datetime: &str) -> Result<&str, InvalidSignTime> {
    match datetime.get(..8) {
        Some(date) if date.bytes().all(|b| b.is_ascii_digit()) => Ok(date),
        _ => Err(InvalidSignTime),
    }
}

/// 规范化请求那六段。`payload` 恒为 [`UNSIGNED_PAYLOAD`]，所以这一层压根不接 body。
pub fn canonical_request(ctx: &SignContext<'_>, query: &str, headers_block: &str, declared: &str) -> String {
    let path = format!("/{}/{}", ctx.bucket, ctx.key);
    [ctx.method, &uri_encode(&path, true), query, headers_block, declared, UNSIGNED_PAYLOAD].join("\n")
}

/// 待签字符串：算法名、时间戳、scope、规范化请求的哈希（小写 hex）
pub fn string_to_sign(datetime: &str, scope: &str, canonical_request: &str) -> String {
    let digest = Sha256::digest(canonical_request.as_bytes());
    format!("{ALGORITHM}\n{datetime}\n{scope}\n{}", hex::encode(digest))
}

/// 四层密钥派生：`aliyun_v4` + secret 起手，依次用日期、region、产品、固定后缀压下去。
///
/// 🔴 第一层的输入是**拼出来的字符串** `"aliyun_v4" + secret`，不是它的哈希。少写那五个字符
/// 得到的是一串看着同样合理的十六进制，只有黄金向量能发现。
pub fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
    let mut key = hmac_sha256(format!("aliyun_v4{secret}").as_bytes(), date);
    for step in [region, PRODUCT, SCOPE_TAIL] {
        key = hmac_sha256(&key, step);
    }
    key
}

/// 小写 hex 的最终签名
pub fn signature(secret: &str, date: &str, region: &str, string_to_sign: &str) -> String {
    hex::encode(hmac_sha256(&signing_key(secret, date, region), string_to_sign))
}

fn hmac_sha256(key: &[u8], message: &str) -> Vec<u8> {
    // HMAC 的密钥长度任意，那个 Err 分支走不到
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC 接受任意长度的密钥");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// 头鉴权要补的那几条请求头：[`authorization_headers`] 会签它，调用方也必须原样发它，
/// 所以单独露出来给两边共用一份，省掉「签的是一组、发的是另一组」那种缝。
fn auth_extras(ctx: &SignContext<'_>) -> Vec<(&'static str, String)> {
    let mut out =
        vec![("x-oss-date", ctx.datetime.to_string()), ("x-oss-content-sha256", UNSIGNED_PAYLOAD.to_string())];
    if let Some(token) = ctx.credentials.security_token {
        out.push(("x-oss-security-token", token.to_string()));
    }
    out
}

/// 头鉴权那一条路的中间值与最终签名。
///
/// ⚠️ 这一层存在的理由有两个：`authorization_headers` 要用它，而真机上一次 403 只能靠把
/// 规范化请求逐行与服务端复现的那一份比对才查得出来错在哪（少了一行头、某个参数没编码）。
/// 只把最后那串签名交回去的话，那条排查路就没有工具。
///
/// ⛔ 别把这几串整个写进日志或失败文案：里面有签名，虽然推不出密钥，但足够让同一条请求被重放。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderSignature {
    pub canonical_request: String,
    pub string_to_sign: String,
    /// `Credential=` 里斜杠后面那一段：`20250411/cn-hangzhou/oss/aliyun_v4_request`
    pub scope: String,
    /// `AdditionalHeaders=` 那一段；没有额外声明时是空串
    pub declared: String,
    pub signature: String,
}

/// 头鉴权的签名那一段。⚠️ 只算签名，不产出 `Authorization`，也不管要发哪几条头
pub fn sign_header_request(ctx: &SignContext<'_>) -> Result<HeaderSignature, InvalidSignTime> {
    let date = sign_date(ctx.datetime)?;
    let extras = auth_extras(ctx);
    let extras_ref: Vec<(&str, &str)> = extras.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let signed = SignedHeaders::build(ctx.headers, &extras_ref, ctx.additional_headers);
    let declared = signed.declared_joined();
    let canonical_request = canonical_request(ctx, &canonical_query(ctx.query), &signed.canonical_block(), &declared);
    let scope = scope(date, ctx.region);
    let string_to_sign = string_to_sign(ctx.datetime, &scope, &canonical_request);
    let signature = signature(ctx.credentials.access_key_secret, date, ctx.region, &string_to_sign);
    Ok(HeaderSignature { canonical_request, string_to_sign, scope, declared, signature })
}

/// 头鉴权：返回**要原样发出去**的那几条请求头，末尾是 `Authorization`。
///
/// 每一条都被签进过规范化请求，改一个字符等于换签名。⚠️ 交回的是「这一层新补的」那几条，
/// 调用方本来就要发的（`content-type` 之类）不在里面——别把它们当全量。
///
/// ⛔ 不含旧的 `Date`（GMT）头。SDK 会顺手设一条，但它不参与签名，而 V4 服务端认的是
/// `x-oss-date`；真要补，让调用方自己加，加在这一层会让「返回值就是要发的头」那句承诺变虚。
///
/// ⚠️ 有 token 时返回里带 `x-oss-security-token`，那条头与密钥同级别敏感。
pub fn authorization_headers(ctx: &SignContext<'_>) -> Result<Vec<(&'static str, String)>, InvalidSignTime> {
    let prepared = sign_header_request(ctx)?;
    // 逗号后面不带空格：文档的模板写法带（`…, Signature=…`），但 SDK 与文档自己的 PutObject
    // 示例发的都是不带的形，按实际发出去那一份来
    let extra =
        if prepared.declared.is_empty() { String::new() } else { format!(",AdditionalHeaders={}", prepared.declared) };
    let auth = format!(
        "{ALGORITHM} Credential={}/{scope}{extra},Signature={signature}",
        ctx.credentials.access_key_id,
        scope = prepared.scope,
        signature = prepared.signature
    );
    let mut out = auth_extras(ctx);
    out.push(("Authorization", auth));
    Ok(out)
}

/// 预签名 URL 上那一整串查询参数，末尾是 `x-oss-signature`。
///
/// 与头鉴权那条的关键区别：这一条**不补任何请求头**，token 是查询参数而不是头，
/// `x-oss-date` 也只在参数里。⚠️ 但「签名时的那组头要和实际发出去的一致」这条约束还在：
/// 浏览器 `<img>` 的 GET 不带 `content-type` / `x-oss-*`，所以预览那一路应当传**空** headers。
///
/// `expires_seconds` 是从 `ctx.datetime` 起算的有效期，不是绝对到期时刻。
pub fn presigned_query(ctx: &SignContext<'_>, expires_seconds: i64) -> Result<String, InvalidSignTime> {
    let date = sign_date(ctx.datetime)?;
    let scope = scope(date, ctx.region);
    let signed = SignedHeaders::build(ctx.headers, &[], ctx.additional_headers);
    let mut params: Vec<(&str, String)> = ctx.query.iter().map(|(k, v)| (*k, v.to_string())).collect();
    params.push(("x-oss-signature-version", ALGORITHM.to_string()));
    params.push(("x-oss-date", ctx.datetime.to_string()));
    params.push(("x-oss-expires", expires_seconds.to_string()));
    params.push(("x-oss-credential", format!("{}/{}", ctx.credentials.access_key_id, scope)));
    let declared = signed.declared_joined();
    if !declared.is_empty() {
        params.push(("x-oss-additional-headers", declared.clone()));
    }
    if let Some(token) = ctx.credentials.security_token {
        params.push(("x-oss-security-token", token.to_string()));
    }
    let borrowed: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let mut encoded = sorted_query(&borrowed);
    let canonical = canonical_request(ctx, &canonical_from(&encoded), &signed.canonical_block(), &declared);
    let to_sign = string_to_sign(ctx.datetime, &scope, &canonical);
    // 🔴 签名自己是最后追加的：它不参与刚算出来的那一份规范化查询串
    encoded.push((
        "x-oss-signature".to_string(),
        signature(ctx.credentials.access_key_secret, date, ctx.region, &to_sign),
    ));
    Ok(url_from(&encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 官方 SDK 的测试输入
    const SDK_AK: &str = "ak";
    const SDK_SK: &str = "sk";
    const SDK_KEY: &str = "1234+-/123/1.txt";
    /// SDK `TestV4AuthHeader` case 1：`signTime = 1702743657`
    const TS_PLAIN: &str = "20231216T162057Z";
    const SIGN_PLAIN: &str = "e21d18daa82167720f9b1047ae7e7f1ce7cb77a31e8203a7d5f4624fa0284afe";
    /// SDK `TestV4AuthHeaderToken`：`signTime = 1702784856`
    const TS_TOKEN: &str = "20231217T034736Z";
    const SIGN_TOKEN: &str = "b94a3f999cf85bcdc00d332fbd3734ba03e48382c36fa4d5af5df817395bd9ea";
    /// SDK `TestV4AuthHeaderWithAdditionalHeaders`：`signTime = 1702747512`
    const TS_EXTRA: &str = "20231216T172512Z";
    const SIGN_EXTRA: &str = "4a4183c187c07c8947db7620deb0a6b38d9fbdd34187b6dbaccb316fa251212f";
    /// SDK `TestV4AuthQuery`：`signTime = 1702781677`，`expires = 599`
    const TS_PRESIGN: &str = "20231217T025437Z";
    const SIGN_PRESIGN: &str = "a39966c61718be0d5b14e668088b3fa07601033f6518ac7b523100014269c0fe";
    /// SDK `TestV4AuthQueryToken`：`signTime = 1702785388`，`expires = 599`
    const TS_PRESIGN_TOKEN: &str = "20231217T035628Z";
    const SIGN_PRESIGN_TOKEN: &str = "3817ac9d206cd6dfc90f1c09c00be45005602e55898f26f5ddb06d7892e1f8b5";

    /// SDK 那六个参数：键名带 `+` 与 `|`，同时考编码与排序；两个空值考「不带 `=`」
    fn sdk_query() -> Vec<(&'static str, &'static str)> {
        vec![
            ("param1", "value1"),
            ("+param1", "value3"),
            ("|param1", "value4"),
            ("+param2", ""),
            ("|param2", ""),
            ("param2", ""),
        ]
    }

    /// 头鉴权那两条用例里调用方自己写的五条（第六条 `x-oss-content-sha256` 由这一层补）
    fn sdk_headers() -> Vec<(&'static str, &'static str)> {
        sdk_headers_with("text/plain")
    }

    /// ⚠️ 预签名那两条用例的 `content-type` 是 `application/octet-stream`，与头鉴权那两条
    /// 不一样。这是从 SDK 测试里逐字抄来的差别，不是笔误：抄错一份输入，黄金值就整个作废
    fn sdk_headers_octet() -> Vec<(&'static str, &'static str)> {
        sdk_headers_with("application/octet-stream")
    }

    fn sdk_headers_with(content_type: &'static str) -> Vec<(&'static str, &'static str)> {
        vec![
            ("x-oss-head1", "value"),
            ("abc", "value"),
            ("ZAbc", "value"),
            ("XYZ", "value"),
            ("content-type", content_type),
        ]
    }

    fn creds(token: Option<&'static str>) -> Credentials<'static> {
        Credentials { access_key_id: SDK_AK, access_key_secret: SDK_SK, security_token: token }
    }

    fn sdk_ctx<'a>(
        headers: &'a [(&'a str, &'a str)],
        query: &'a [(&'a str, &'a str)],
        datetime: &'a str,
        additional: &'a [&'a str],
        cred: &'a Credentials<'a>,
    ) -> SignContext<'a> {
        SignContext {
            method: "PUT",
            bucket: "bucket",
            key: SDK_KEY,
            region: "cn-hangzhou",
            datetime,
            headers,
            query,
            additional_headers: additional,
            credentials: cred,
        }
    }

    fn signature_of(authorization: &str) -> &str {
        authorization.rsplit(',').next().unwrap().strip_prefix("Signature=").unwrap()
    }

    fn auth_of<'a>(headers: &'a [(&'static str, String)]) -> &'a str {
        &headers.iter().find(|(k, _)| *k == "Authorization").unwrap().1
    }

    fn param<'a>(url_query: &'a str, name: &str) -> Option<&'a str> {
        url_query
            .split('&')
            .find(|pair| pair.split('=').next() == Some(name))
            .and_then(|pair| pair.split_once('=').map(|(_, v)| v))
    }

    // ===== 编码与形状：规范化请求的零件 =====

    #[test]
    fn 编码只放行_unreserved_而斜杠两处规则相反() {
        assert_eq!(uri_encode("a-b.c_d~e", false), "a-b.c_d~e");
        assert_eq!(uri_encode("中/文 a+b|c", true), "%E4%B8%AD/%E6%96%87%20a%2Bb%7Cc");
        // 🔴 规范化 URI 里斜杠原样，查询参数里的斜杠必须编成 %2F：两处规则相反
        assert_eq!(uri_encode("ak/20250411/cn-hangzhou", false), "ak%2F20250411%2Fcn-hangzhou");
        assert_eq!(uri_encode("notes/pasted-0123.png", true), "notes/pasted-0123.png");
    }

    #[test]
    fn 查询串按编码后的键名排序且空值不带等号() {
        assert_eq!(
            canonical_query(&sdk_query()),
            "%2Bparam1=value3&%2Bparam2&%7Cparam1=value4&%7Cparam2&param1=value1&param2"
        );
        assert_eq!(canonical_query(&[]), "");
    }

    #[test]
    fn 默认签名的头只有三类_host_不在内() {
        assert!(is_default_signed_header("X-OSS-Meta-A"));
        assert!(is_default_signed_header("Content-Type"));
        assert!(is_default_signed_header("content-md5"));
        // 🔴 与 AWS SigV4 相反：照习惯把 host 加进去，服务端复现时就多出一行
        assert!(!is_default_signed_header("host"));
        assert!(!is_default_signed_header("content-length"));
    }

    #[test]
    fn 有效声明里默认三类与不存在的头都被剔掉() {
        let headers = sdk_headers();
        let additional = vec!["ZAbc", "abc", "x-oss-head1", "x-oss-no-exist"];
        let signed = SignedHeaders::build(&headers, &[], &additional);
        assert_eq!(signed.declared_joined(), "abc;zabc");
        // `XYZ` 既不属于默认三类也没声明 → 压根不进签名
        assert_eq!(signed.names().collect::<Vec<_>>(), vec!["abc", "content-type", "x-oss-head1", "zabc"]);
    }

    #[test]
    fn 空值的声明不算声明而空值的默认头照样进签名() {
        let headers = vec![("content-type", ""), ("abc", "")];
        let signed = SignedHeaders::build(&headers, &[], &["content-type", "abc"]);
        assert_eq!(signed.declared_joined(), "");
        // 那行 `content-type:` 是空的，但它**在**——SDK 同一条规则
        assert_eq!(signed.canonical_block(), "content-type:\n");
    }

    #[test]
    fn 同名多条并成一行而每条值各自_trim() {
        let headers = vec![("x-oss-meta-a", " 一 "), ("X-OSS-META-A", "二 ")];
        let signed = SignedHeaders::build(&headers, &[], &[]);
        assert_eq!(signed.canonical_block(), "x-oss-meta-a:一,二\n");
    }

    #[test]
    fn 鉴权头是覆盖而不是追加() {
        // SDK 里那条「调用方已经写了 x-oss-content-sha256」的用例签出来的与没写时完全一致
        let mut headers = sdk_headers();
        headers.push(("x-oss-content-sha256", "UNSIGNED-PAYLOAD"));
        let query = sdk_query();
        let cred = creds(None);
        let out = authorization_headers(&sdk_ctx(&headers, &query, TS_PLAIN, &[], &cred)).unwrap();
        assert_eq!(signature_of(auth_of(&out)), SIGN_PLAIN);
        // 而且交回的只有一条 x-oss-content-sha256，不是并了值的第二条
        assert_eq!(out.iter().filter(|(k, _)| *k == "x-oss-content-sha256").count(), 1);
    }

    #[test]
    fn 签名日期取前八位_形状不对就报错() {
        assert_eq!(sign_date("20250411T064124Z"), Ok("20250411"));
        for bad in ["2025-04-11T06:41:24Z", "2025041T064124Z", "2025041", ""] {
            assert_eq!(sign_date(bad), Err(InvalidSignTime), "{bad}");
        }
        let cred = creds(None);
        let headers: Vec<(&str, &str)> = vec![];
        let query: Vec<(&str, &str)> = vec![];
        let e = authorization_headers(&sdk_ctx(&headers, &query, "2025-04-11T06:41:24Z", &[], &cred)).unwrap_err();
        assert_eq!(e.to_string(), "签名时刻不是 YYYYMMDDTHHMMSSZ 那一形");
        assert!(presigned_query(&sdk_ctx(&headers, &query, "2025-04-11T06:41:24Z", &[], &cred), 900).is_err());
    }

    #[test]
    fn 区域只有一个入参且原样进_scope() {
        assert_eq!(scope("20250411", "cn-hangzhou"), "20250411/cn-hangzhou/oss/aliyun_v4_request");
        // 🔴 0002-00000226 的成因就是把 endpoint 里那个 `oss-cn-hangzhou` 抄了进来
        assert_ne!(scope("20250411", "oss-cn-hangzhou"), scope("20250411", "cn-hangzhou"));
    }

    #[test]
    fn 调试输出里看不见密钥() {
        let line = format!("{:?}", creds(Some("临时密钥值")));
        assert!(!line.contains(SDK_SK), "{line}");
        // ⚠️ 字段名就叫 `security_token`，所以这一条盯的是**值**没漏出去，而不是整串里没有 token 这个词
        assert!(!line.contains("临时密钥值"), "{line}");
        assert!(line.contains(SDK_AK), "{line}");
    }

    // ===== 官方文档的完整示例：规范化请求与哈希 =====

    /// 文档示例的那四条头与那两条声明，逐字抄自官方文档「V4 签名」页
    const DOC_HEADERS: [(&str, &str); 4] = [
        ("content-disposition", "attachment"),
        ("content-length", "3"),
        ("content-md5", "ICy5YqxZB1uWSwcVLSNLcA=="),
        ("content-type", "text/plain"),
    ];
    const DOC_ADDITIONAL: [&str; 2] = ["content-disposition", "content-length"];

    /// ⚠️ 文档那把 AccessKeySecret 是打码的占位（`yourAccessKeySecret`），于是它给出的
    /// `SigningKey` 与 `Signature` **复现不出来**。这一份输入只用来钉规范化请求与它的哈希，
    /// 数值层面的黄金向量是下面那五条 SDK 的断言
    fn doc_ctx<'a>(cred: &'a Credentials<'a>) -> SignContext<'a> {
        SignContext {
            method: "PUT",
            bucket: "examplebucket",
            key: "exampleobject",
            region: "cn-hangzhou",
            datetime: "20250411T064124Z",
            headers: &DOC_HEADERS,
            query: &[],
            additional_headers: &DOC_ADDITIONAL,
            credentials: cred,
        }
    }

    fn doc_creds() -> Credentials<'static> {
        Credentials {
            access_key_id: "LTAI****************",
            access_key_secret: "yourAccessKeySecret",
            security_token: None,
        }
    }

    #[test]
    fn 文档示例的规范化请求逐字对上() {
        let cred = doc_creds();
        let prepared = sign_header_request(&doc_ctx(&cred)).unwrap();
        // 第四段自带结尾换行，所以 `x-oss-date` 与 `content-disposition;content-length`
        // 之间那个空行是规范的形状，不是排版写错了
        assert_eq!(
            prepared.canonical_request,
            "PUT\n\
             /examplebucket/exampleobject\n\
             \n\
             content-disposition:attachment\n\
             content-length:3\n\
             content-md5:ICy5YqxZB1uWSwcVLSNLcA==\n\
             content-type:text/plain\n\
             x-oss-content-sha256:UNSIGNED-PAYLOAD\n\
             x-oss-date:20250411T064124Z\n\
             \n\
             content-disposition;content-length\n\
             UNSIGNED-PAYLOAD"
        );
        assert_eq!(
            prepared.string_to_sign,
            "OSS4-HMAC-SHA256\n20250411T064124Z\n20250411/cn-hangzhou/oss/aliyun_v4_request\n\
             c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca"
        );
        assert_eq!(prepared.declared, "content-disposition;content-length");
    }

    #[test]
    fn 文档示例的_authorization_钉形状而不钉签名() {
        let cred = doc_creds();
        let out = authorization_headers(&doc_ctx(&cred)).unwrap();
        let auth = auth_of(&out);
        assert!(
            auth.starts_with(
                "OSS4-HMAC-SHA256 Credential=LTAI****************/20250411/cn-hangzhou/oss/aliyun_v4_request,AdditionalHeaders=content-disposition;content-length,Signature="
            ),
            "{auth}"
        );
        // 🔴 `Authorization` 里没有 `SignedHeaders=`，而逗号后面不带空格
        assert!(!auth.contains("SignedHeaders"), "{auth}");
        assert_eq!(auth.matches(' ').count(), 1, "{auth}");
        let value = auth.rsplit(',').next().unwrap().strip_prefix("Signature=").unwrap();
        assert_eq!(value.len(), 64, "{value}");
        assert!(value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')), "{value}");
    }

    // ===== 官方 Go SDK 的五个签名黄金值 =====

    #[test]
    fn 头鉴权黄金_无_token_无额外声明() {
        let cred = creds(None);
        let headers = sdk_headers();
        let query = sdk_query();
        let out = authorization_headers(&sdk_ctx(&headers, &query, TS_PLAIN, &[], &cred)).unwrap();
        assert_eq!(
            auth_of(&out),
            format!("OSS4-HMAC-SHA256 Credential=ak/20231216/cn-hangzhou/oss/aliyun_v4_request,Signature={SIGN_PLAIN}")
        );
    }

    #[test]
    fn 头鉴权黄金_带_sts_token_那条头也进签名() {
        let cred = creds(Some("token"));
        let headers = sdk_headers();
        let query = sdk_query();
        let out = authorization_headers(&sdk_ctx(&headers, &query, TS_TOKEN, &[], &cred)).unwrap();
        assert_eq!(
            auth_of(&out),
            format!("OSS4-HMAC-SHA256 Credential=ak/20231217/cn-hangzhou/oss/aliyun_v4_request,Signature={SIGN_TOKEN}")
        );
        assert!(out.iter().any(|(k, v)| *k == "x-oss-security-token" && v == "token"));
    }

    #[test]
    fn 头鉴权黄金_声明了额外请求头() {
        let cred = creds(None);
        let headers = sdk_headers();
        let query = sdk_query();
        let additional = vec!["ZAbc", "abc"];
        let out = authorization_headers(&sdk_ctx(&headers, &query, TS_EXTRA, &additional, &cred)).unwrap();
        assert_eq!(
            auth_of(&out),
            format!("OSS4-HMAC-SHA256 Credential=ak/20231216/cn-hangzhou/oss/aliyun_v4_request,AdditionalHeaders=abc;zabc,Signature={SIGN_EXTRA}")
        );
    }

    #[test]
    fn 头鉴权交回的只有新补的那几条() {
        let cred = creds(Some("token"));
        let headers = sdk_headers();
        let query = sdk_query();
        let out = authorization_headers(&sdk_ctx(&headers, &query, TS_TOKEN, &[], &cred)).unwrap();
        let names: Vec<&str> = out.iter().map(|(k, _)| *k).collect();
        assert_eq!(names, vec!["x-oss-date", "x-oss-content-sha256", "x-oss-security-token", "Authorization"]);
        assert_eq!(out[1].1, UNSIGNED_PAYLOAD);
        assert_eq!(out[0].1, TS_TOKEN);
        // ⚠️ `content-type` 是调用方自己发的，不在交回这份里——签的与发的必须是同一条，
        // 这条承诺由「调用方发自己那一份」实现，而不是由这里复读一遍
        assert!(!names.contains(&"content-type"));
    }

    #[test]
    fn 预签名黄金_url_参数() {
        let cred = creds(None);
        let headers = sdk_headers_octet();
        let query = sdk_query();
        let url_query = presigned_query(&sdk_ctx(&headers, &query, TS_PRESIGN, &[], &cred), 599).unwrap();
        assert_eq!(param(&url_query, "x-oss-signature"), Some(SIGN_PRESIGN));
        assert_eq!(param(&url_query, "x-oss-date"), Some(TS_PRESIGN));
        assert_eq!(param(&url_query, "x-oss-expires"), Some("599"));
        assert_eq!(param(&url_query, "x-oss-signature-version"), Some(ALGORITHM));
        // ⚠️ 参数里的 `/` 全被编码：这一串是直接拼进 URL 的
        assert_eq!(
            param(&url_query, "x-oss-credential"),
            Some("ak%2F20231217%2Fcn-hangzhou%2Foss%2Faliyun_v4_request")
        );
        assert_eq!(param(&url_query, "x-oss-additional-headers"), None);
        assert_eq!(param(&url_query, "x-oss-security-token"), None);
        // 🔴 原始查询参数也在：预签名的那几条一起进规范化查询串（V4 没有 CanonicalizedResource）
        assert_eq!(param(&url_query, "%2Bparam1"), Some("value3"));
        assert_eq!(param(&url_query, "param2"), Some(""));
    }

    #[test]
    fn 预签名黄金_token_是查询参数而不是请求头() {
        let cred = creds(Some("token"));
        let headers = sdk_headers_octet();
        let query = sdk_query();
        let url_query = presigned_query(&sdk_ctx(&headers, &query, TS_PRESIGN_TOKEN, &[], &cred), 599).unwrap();
        assert_eq!(param(&url_query, "x-oss-security-token"), Some("token"));
        assert_eq!(param(&url_query, "x-oss-signature"), Some(SIGN_PRESIGN_TOKEN));
    }

    #[test]
    fn 预签名不补请求头而头鉴权补() {
        let cred = creds(Some("临时密钥值"));
        let headers = sdk_headers_octet();
        let query: Vec<(&str, &str)> = vec![];
        let c = sdk_ctx(&headers, &query, TS_PRESIGN_TOKEN, &[], &cred);
        let url_query = presigned_query(&c, 599).unwrap();
        // 这一条路上 `x-oss-date` 只在参数里；签名时那组头就是调用方那五条里的默认三类
        let signed = SignedHeaders::build(&headers, &[], &[]);
        assert_eq!(signed.names().collect::<Vec<_>>(), vec!["content-type", "x-oss-head1"]);
        // 🔴 预签名压根不碰请求头：那两条鉴权头只存在于头鉴权那一路
        assert!(!url_query.contains("content-sha256"), "{url_query}");
        // ⚠️ 参数是**编码之后**的形式（这一条用中文值就是专门钉它），而头鉴权那条交回的是原文
        assert_eq!(param(&url_query, "x-oss-security-token"), Some("%E4%B8%B4%E6%97%B6%E5%AF%86%E9%92%A5%E5%80%BC"));
        let out = authorization_headers(&c).unwrap();
        assert_eq!(out[1].1, UNSIGNED_PAYLOAD);
        assert!(out.iter().any(|(k, v)| *k == "x-oss-security-token" && v == "临时密钥值"));
    }

    #[test]
    fn 预览那一路空请求头也签得出东西() {
        // 🔴 浏览器 `<img>` 的 GET 不带 `content-type` / `x-oss-*`，所以 M7-8 那一路传空 headers
        // 才是对的；这条钉的是「空头不会退化成一条都不签」以及那段是空的
        let cred = creds(None);
        let headers: Vec<(&str, &str)> = vec![];
        let query: Vec<(&str, &str)> = vec![];
        let ctx = SignContext {
            method: "GET",
            bucket: "vela-img",
            key: "notes/a.png",
            region: "cn-hangzhou",
            datetime: "20250411T064124Z",
            headers: &headers,
            query: &query,
            additional_headers: &[],
            credentials: &cred,
        };
        let signed = SignedHeaders::build(&headers, &[], &[]);
        assert_eq!(signed.canonical_block(), "");
        assert_eq!(canonical_request(&ctx, "", "", ""), "GET\n/vela-img/notes/a.png\n\n\n\nUNSIGNED-PAYLOAD");
        let url_query = presigned_query(&ctx, 900).unwrap();
        assert_eq!(param(&url_query, "x-oss-expires"), Some("900"));
        assert_eq!(param(&url_query, "x-oss-signature").map(|s| s.len()), Some(64));
    }

    #[test]
    fn 密钥派生四层_第一层的输入是拼出来的字符串() {
        let key = signing_key(SDK_SK, "20231216", "cn-hangzhou");
        assert_eq!(key.len(), 32);
        let round1 = hmac_sha256(b"aliyun_v4sk", "20231216");
        let round2 = hmac_sha256(&round1, "cn-hangzhou");
        let round3 = hmac_sha256(&round2, PRODUCT);
        assert_eq!(hex::encode(hmac_sha256(&round3, SCOPE_TAIL)), hex::encode(&key));
        // ⚠️ 起手那五个字符少了就是另一串同样合理的十六进制
        assert_ne!(hex::encode(hmac_sha256(b"sk", "20231216")), hex::encode(round1));
    }
}
