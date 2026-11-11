//! 微信读书同步的**落地层**：一条出站请求 + 钥匙串里那把 key（M8-2，PLAN.md §3.22）。
//!
//! ## 这一层为什么在 src-tauri
//!
//! 请求体怎么拼、回包算不算成功、翻页游标怎么取，全是 [`vela_core::weread`] 里的纯函数
//! （M8-1，有合成夹具与跨实现黄金值钉着）。这一层只剩两件必须有真东西才做得成的事：
//! 一次真的 HTTPS 请求，和一次真的钥匙串读取。vela-core 的单测既不碰网络、也不碰系统钥匙串。
//!
//! ## 🔴 `gateway` 刻意**不是**一条 command
//!
//! M8-3 的 `weread_sync_dir` 在同一进程里调它，不过 IPC。⛔ 不要因为「想单独测一下 key
//! 有没有配好」把它注册进 `invoke_handler`：那等于给 webview 一个「拿用户的 key 往
//! 微信读书发任意 `api_name`」的原语——一份别人发来的 Markdown 在预览里注入一个
//! `<script>`，就能把用户的整个书架与全部划线读走。key 本身不过 IPC 只是第一道；
//! 第二道是**能拿它做的事只有同步这一件**，而同步的入口（M8-3）由 Rust 决定要问哪几个接口。
//!
//! ## 🔑 key 的走向
//!
//! 它只从钥匙串读到本进程，再进 `Authorization: Bearer …`。三样东西里它一样都不进：
//! [`WereadError`] 的任何一个变体、`Debug` 输出、日志。钥匙串那一层与 OSS 的
//! AccessKeySecret 共用（[`crate::secrets`]），但**槽不同**：`app.vela.weread` /
//! `api-key`，与 OSS 那一对互不相干。⛔ 不要加 `get_weread_key`，理由与
//! `secrets.rs` 文件头那条 🔴 逐字相同。
//!
//! ## 错误文案要带域名与状态码
//!
//! 两条路在用户那里经常一起不通（`i.weread.qq.com` 在境内、`api.github.com` 在境外），
//! 而本机代理按域名重置 TLS 有先例（PLAN.md §3.22 ⑮）。所以：非 2xx 与 `errcode` 的那句话
//! 由 [`classify`] 拼出 `{api} HTTP {status} errcode={code} {errmsg}`；传输层失败的那句话
//! 带 [`HOST`]。⛔ 别把一次超时写成「key 错了」——那会让用户把一把正确的 key 删掉重填。
//! 反方向也一样：`errmsg` 里服务端自己说了「用户不存在」时，那句话原样透出（用户既定偏好）。
//!
//! ## 这一层能测到哪儿
//!
//! 联网那一段（`send()` 与读回包）在本项目的门禁里刻意不测：`reqwest::Error` 没有公开
//! 构造器，测试里造不出一个「超时」；而真打一次网关需要一把真 key（本机那一把只从
//! `.weread-key` 读，不进测试）。所以能在出门前判完的事都收进了同步的 [`prepare`]：
//! 地址只有 `GATEWAY_URL` 一个、授权头只有 `Bearer` 一种形状、请求体平铺且带版本号。
//! 钥匙串那三个调用与 `secrets.rs` 同一条纪律——系统调用不进单测。
//!
//! ## M8-3：一次点击 = 一串请求 + 每本一次原子写盘
//!
//! [`weread_sync_dir`] 的形状与 `start_search` 同一条：**invoke 立刻返回 `taskId`**，
//! 进度与终止全走 `vela://weread-*` 三个事件，取消复用同一份
//! [`TaskRegistry`](crate::commands::TaskRegistry)（`cancel_task` 是唯一的刹车）。
//! 预检（目录闸门、key 在不在）全部在命令线程上做完：**reject = 这次压根没开始，
//! 拿到 taskId = 一定会收到 done 或 failed**。
//!
//! 🔴 **参数只有一个 `dir`，而且它只用来核对**。真正写盘的位置来自用户全局配置里
//! `wereadLocalDir` 那一格；两者 canonicalize 之后必须相等（⑨ 与 ⑥.4 同一个口径，
//! 不是 `startsWith`——子目录打开时不算）。这挡住的正是「一个仓库把配置改成别处，
//! 打开一次就让 Vela 往那儿写几十个文件」。
//!
//! ### 每本书落两份，所有权按文件分
//!
//! `划线素材/作者 - 书名·划线素材.md` 是**机器的**：每次整份重写，时间戳每同步一次就变。
//! `作者 - 书名.md` 是**人的**：只在缺失时写一份种子，之后一个字都不改（决定 1 / ④）。
//! 素材统一收进 [`MATERIAL_DIR`] 子目录（M8-10），配置目录的根上只剩人那份；两份文件
//! 各自在开头放了指向对方的相对链接，用户在预览里点一下就能来回跳。
//! 两份都走 [`write_text_atomic`]（同目录 `.tmp` + rename），所以取消或断电只会
//! 得到「上一份完整的文件」，不会得到半个。
//!
//! ### state 在 `~/.vela/weread-state.json`
//!
//! 它记的是「这台设备上次见到哪些划线」——决定素材文件里「本次新增」列什么。
//! ⛔ **不放进被同步的目录**（PLAN ⑭）：那是每台设备各自的视角，放进版本库就等于
//! 把机器区又挪了回去。每写完一本就落一次盘，于是取消之后已经完成的书不会在下次
//! 被当成「首次同步」再报一遍。
//!
//! ⚠️ **没有 base 是常态**（换一台设备就是）。读不到/读坏了 state 一律退回空表：
//! 代价只是多列几条「本次新增」，而为此拦下一次同步会让用户拿不回笔记——与 CLI
//! `loadState()` 同一个口径。
//!
//! ### 取消语义
//!
//! 在每一条请求之前、每一本之前都看一次标志。取消**不是失败**：已经写完的书留在盘上，
//! 终止事件仍是 `weread-done`，`summary.cancelled = true`（与搜索的收尾同一条规矩）。
//! 失败则是 `weread-failed`，带着 [`WereadError`] 的一句话就地停住——⛔ 不自动重试，
//! 因为下一本大概率会撞同一堵墙，而重复请求只会让用户等更久。

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{command, AppHandle, Emitter, Manager, State};
use vela_core::fs::{write_bytes_atomic, write_text_atomic, Encoding, FileFormat, LineEnding, WriteError};
use vela_core::settings::{self, VELA_DIR_NAME};
use vela_core::weread::gateway::MAX_PAGES;
use vela_core::weread::{
    classify, next_notebook_sort, next_review_synckey, plan_material, request_body, BookNotebook, BookmarkList,
    GatewayError, MaterialInput, NotebooksPage, ReviewCore, ReviewsPage, GATEWAY_URL, MATERIAL_DIR,
};

use crate::commands::TaskRegistry;
use crate::secrets::{self, SecretError, SecretStatus};

/// 钥匙串里微信读书那把 key 的服务名。
///
/// ⚠️ 与 `secrets::SERVICE`（`app.vela.oss`）**必须不同**：同一个 service 下放两把不同用途的
/// 凭证，将来任何一次「按 service 清一遍」都会连坐；而两条凭证的爆炸半径本来就不一样
/// （OSS secret 能往用户的桶里写，微信读书 key 能读用户的全部笔记）。有一条测试钉着。
///
/// 与 `secrets::SERVICE` 同理：⛔ 不要跟着 `tauri.conf.json` 的 `identifier` 走，
/// 也不要把它做成可配置的——钥匙串项按这个字符串寻址，改一次就是升级后一片「未配置」。
pub const SERVICE: &str = "app.vela.weread";

/// 账号名。一条 service 下一个账号，Vela 只用这一个。
pub const ACCOUNT: &str = "api-key";

/// 网关主机名。**只用来拼错误文案**：请求地址只有一个，就是 [`GATEWAY_URL`]。
/// 有一条测试钉住两者的前缀一致，免得文案里说了一个我们其实没打过的域名。
const HOST: &str = "i.weread.qq.com";

/// 「没填 key」那一句。
///
/// ⚠️ 与 `secrets::EMPTY_MESSAGE` 是两件事：那一句说的是「你点保存但框是空的」，
/// 这一句说的是「这条路需要 key，而钥匙串里没有」，落点是设置面板。
const NOT_CONFIGURED: &str = "微信读书的 key 还没填。到「设置 → 微信读书」里填一次。";

/// 「没配同步目录」那一句。与 [`NOT_CONFIGURED`] 分开：用户可能填了 key 却没选目录，
/// 这时候说「key 没填」会让他去翻一个本来就对的输入框。
const DIR_NOT_CONFIGURED: &str = "微信读书的同步目录还没配。到「设置 → 微信读书」里选一个目录。";

/// 机器状态文件名，落在 `~/.vela/` 下（PLAN §3.22 ⑭）。
const STATE_FILE_NAME: &str = "weread-state.json";

/// 书目与想法两页的条数。与 `weread.mjs` 逐字一致。
const NOTEBOOK_PAGE: i64 = 100;
const REVIEW_PAGE: i64 = 50;

/// 素材/整理两个文件一律 UTF-8 + LF：它们是 Vela 自己生成的文本，不继承目录里
/// 别的文件的编码习惯。UTF-8 下 `WriteReport::unmappable` 恒为 false。
const FILE_FORMAT: FileFormat = FileFormat { encoding: Encoding::Utf8, bom: false, eol: LineEnding::Lf };

/// 一次网关调用的失败。
///
/// 与 [`crate::oss::UploadError`] 同一套路数：`#[serde(tag = "kind")]` 让前端按类型分支，
/// 而不是去 `message` 里找关键字。整条同步（M8-3）会带着几种变体之一回到前端，
/// 前端那边只负责显示 `message`。
///
/// 🔴 九个变体里没有任何一个可能带 key。`NotConfigured` 装的是上面那条常量；
/// `Keychain` 装的是 [`SecretError::message`]（钥匙串的错误只带 OSStatus 与苹果对那个码的
/// 描述，输入**只有码本身**）；`Upgrade` / `Api` / `NotJson` 装的是 [`classify`] 拼出来的
/// `api_name` + 状态码 + 服务端 `errmsg`；`Network` 装的是 reqwest 的原话（它只说连接、
/// 超时、读体这几件事，拿不到请求头）；`Directory` / `Shape` / `Storage` 装的是路径、
/// `api_name` 与 serde/io 的原话，这三样都不经过 [`prepare`]。以后要加字段，
/// 先想清楚它会不会经过 `prepare`。
///
/// ⚠️ 派生 `Clone` 是被事件载荷逼出来的：`Emitter::emit` 要求载荷可克隆。
/// 每个变体都只有 `String`，克隆不会把 key 复制到别处——它本来就不在这些变体里。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WereadError {
    /// 钥匙串里没有这一项：`Ok(None)`，不是读失败。
    ///
    /// ⚠️ 与 `Keychain` 分开是硬的：「还没填」与「填了但读不出来」对用户是两句不同的话，
    /// 说成同一句，用户会一遍一遍重填一把本来正确的 key（同 `secrets.rs` 文件头那条 🔴）
    NotConfigured { message: String },
    /// 钥匙串读失败（被锁、授权被拒、别的工具写坏了那一项）。
    /// `message` 是 [`SecretError::message`] 的原话，`kind` 在锁与坏值之间不再细分——
    /// 同步这条路只需要把话原样说出来，细分留给设置面板那三条命令
    Keychain { message: String },
    /// 请求没走到网关，或者回包没读完。
    ///
    /// `reason` 是给程序分支的分类（Timeout/Connect/Body/Decode/Other/ClientInit），
    /// `message` 是一句中文 + 括号里的 reqwest 原话（那一条是唯一能区分 DNS 与 TLS 的信息）
    Network { reason: String, message: String },
    /// 服务端要求升级 Skill（`upgrade_info` 出现）。**这是闸门**：同步必须就地停，
    /// 继续问下去只会拿到更多看不懂的结果
    Upgrade { message: String },
    /// 非 2xx，或回包 200 但 `errcode` 非 0。`message` 已含 `api_name`、状态码与 `errmsg`
    Api { message: String },
    /// 回包压根不是 JSON（网关挂了、代理介入了、登录页把请求劫持了）。`message` 带状态码
    NotJson { message: String },
    /// 同步目录与设置对不上：没配、不存在、不是文件夹，或与当前打开的根**不是同一个**。
    ///
    /// 🔴 这一条只会出现在命令的预检里：它意味着一个字节都还没写。降级成「猜一个目录」
    /// 就等于把「往哪儿写几十个文件」交给调用方，而那正是参数面只留一个核对用 `dir` 的理由
    Directory { message: String },
    /// 网关回包不是这个接口该有的结构（字段类型漂了、少了一整个对象）。
    /// `message` 带 `api_name` 与 serde 的原话；⛔ 不带回包正文（划线原文不落日志）
    Shape { message: String },
    /// 本地写盘失败：素材文件、整理种子、或者 `~/.vela/weread-state.json`。
    /// `message` 带路径与 [`WriteError`] 的原话
    Storage { message: String },
}

impl From<GatewayError> for WereadError {
    /// 内核那三种失败原样搬过来：文案是 [`classify`] 拼的，这一层⛔ 不重写一个字。
    /// 重写一次，同一个 `errcode` 在两处就会有两种说法
    fn from(err: GatewayError) -> Self {
        match err {
            GatewayError::Upgrade { message } => Self::Upgrade { message },
            GatewayError::Api { message } => Self::Api { message },
            GatewayError::NotJson { message } => Self::NotJson { message },
        }
    }
}

/// 一条备好、只差发出去的 POST。
///
/// ⚠️ 没有派生 `Debug`：`authorization` 里就是 key。`{:?}` 一旦写进日志或 panic 文案，
/// 那把 key 就进了崩溃转储。与 `oss::PresignedImage` 同理：**返回值是它唯一的出口**。
struct Prepared {
    url: &'static str,
    authorization: String,
    body: String,
}

/// 拼接请求：地址、授权头、请求体。纯函数，所以能在不联网的单测里钉死。
///
/// `body` 走 [`vela_core::weread::request_body`]——平铺、`skill_version` 最后写，
/// 那两条规矩与它们的理由在 `crates/vela-core/src/weread/gateway.rs` 里。
/// 这里只负责把它序列化：`Value::to_string()` 对任何 `Value` 都不会失败，
/// 所以这一段没有错误分支，也不用为此多一个 `WereadError` 变体。
fn prepare(api_name: &str, params: &[(&str, Value)], key: &str) -> Prepared {
    Prepared {
        url: GATEWAY_URL,
        authorization: format!("Bearer {key}"),
        body: request_body(api_name, params).to_string(),
    }
}

/// 读钥匙串里那把 key。三态与 [`secrets::load`] 一致：
/// `Ok(None)` = 没配过，`Err` = 配了但用不了 / 这个平台没有钥匙串。
fn load_key() -> Result<Option<String>, SecretError> {
    secrets::load(SERVICE, ACCOUNT)
}

/// 打一次网关，回包按 [`classify`] 判成败。
///
/// **这是本模块唯一出站的地方**，也是 M8-3 要复用的那一个函数。`api_name` 与 `params`
/// 只由 Rust 侧决定（见模块文档那条 🔴）。
///
/// 顺序是刻意的：先要 key（没配就一句话都不用发），再拼请求，最后才建 client 发出去。
/// 读钥匙串排在 `net::client()` 之前，所以一个没配 key 的用户不会因为「TLS 没装好」
/// 看到一句与配置无关的失败。
pub async fn gateway(api_name: &str, params: &[(&str, Value)]) -> Result<Value, WereadError> {
    let key = load_key()
        .map_err(|err| WereadError::Keychain { message: err.message().to_owned() })?
        .ok_or_else(|| WereadError::NotConfigured { message: NOT_CONFIGURED.to_owned() })?;
    let prepared = prepare(api_name, params, &key);
    let response = crate::net::client()
        .map_err(|message| WereadError::Network { reason: "ClientInit".to_owned(), message })?
        .post(prepared.url)
        .header("Authorization", prepared.authorization)
        .header("Content-Type", "application/json")
        .body(prepared.body)
        .send()
        .await
        .map_err(network_error)?;
    // 先拿状态码再读体：`bytes()` 会把 response 消耗掉
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(network_error)?;
    // 解析失败传 `None`：`classify` 会把「回包不是 JSON」翻成一句带状态码的话
    // （非 2xx + 一坨 HTML 也走这一格——代理劫持的典型形状）
    let body = serde_json::from_slice::<Value>(&bytes).ok();
    classify(api_name, status, body).map_err(WereadError::from)
}

/// 传输层失败（DNS、连接、TLS、超时、读体）→ [`WereadError::Network`]。
///
/// ⚠️ 这一句没法单测：`reqwest::Error` 没有公开的构造器。所以分支只能靠读——
/// 顺序与 `oss.rs` 的 `network_error` 一致：`is_timeout()` 对「整个调用超了」与
/// 「连接超了」都成立，而这里要的那句人话是「30 秒没等到回应」，必须先判 timeout。
///
/// 🔴 每一条都带 [`HOST`]，而且**都不提 key**：一次代理或 DNS 的失败与凭证无关，
/// 写成「key 错了」会让用户删掉一把正确的 key 去重填
fn network_error(err: reqwest::Error) -> WereadError {
    let (reason, lead) = if err.is_timeout() {
        (
            "Timeout",
            format!("{} 秒内没等到 {HOST} 的回应。检查网络或代理后再试。", crate::net::REQUEST_TIMEOUT.as_secs()),
        )
    } else if err.is_connect() {
        // DNS、拒绝连接、TLS 握手都走这一条：它们在用户那边是同一件事「这条网络不通」
        ("Connect", format!("连不上 {HOST}。检查网络与代理设置。"))
    } else if err.is_body() {
        ("Body", format!("请求体没能发给 {HOST}。"))
    } else if err.is_decode() {
        ("Decode", format!("{HOST} 的响应读不完。"))
    } else {
        ("Other", format!("请求没能走到 {HOST}。"))
    };
    WereadError::Network { reason: reason.to_owned(), message: format!("{lead}（{err}）") }
}

/// 写 key。⛔ 没有配对的读，理由见模块文档那条 🔴。
///
/// 与 `secrets.rs` 那三条同一个姿势：`async fn` 而函数体里一个 `.await` 都没有——
/// 同步 command 跑在主线程上会冻住界面，而 `SecItem*` 是毫秒级的系统调用。
/// 空输入由 [`secrets::store`] 里的 `clean` 在碰钥匙串**之前**挡掉。
#[command]
pub async fn set_weread_key(key: String) -> Result<(), SecretError> {
    secrets::store(SERVICE, ACCOUNT, &key)
}

/// 删 key（面板上「清除」那一个按钮）。不存在也算成功。
#[command]
pub async fn delete_weread_key() -> Result<(), SecretError> {
    secrets::clear(SERVICE, ACCOUNT)
}

/// 只回「配没配」。
///
/// ⚠️ 读失败原样报出去而不是退化成 `configured: false`，理由与 `oss_secret_status` 相同：
/// 「没有这一项」与「有一项但读不出来」是两句不同的话。
#[command]
pub async fn weread_key_status() -> Result<SecretStatus, SecretError> {
    Ok(SecretStatus { configured: load_key()?.is_some() })
}

// ─── M8-3 全量同步：进度 / 取消 / 双文件 ─────────────────────────────────

/// `~/.vela/weread-state.json` 里的一本书。
///
/// 只记「上次见到哪些划线」：`ids` 决定素材文件里「本次新增」列什么，`syncedAt`
/// 是给人看的时间戳。`title` / `file` 那几格 CLI 有、这里刻意不抄——路径由配置推出来，
/// 存一份只会造出第二个真相源。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeenBook {
    ids: Vec<String>,
    synced_at: i64,
}

/// `bookId → 上次见到的状态`。
///
/// 用 `BTreeMap` 而不是 `HashMap`：写出来的字节只随内容变，不随哈希顺序变。
/// 这样同一个世界两次落盘是同一份文件，排查时 `diff` 才有意义。
type WereadState = BTreeMap<String, SeenBook>;

/// 一次全量同步的进度。单位是**书**，不是划线。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WereadProgress {
    pub books_done: usize,
    pub books_total: usize,
}

/// 一次全量同步的总账。`cancelled = true` 时其余数字是**取消为止**的账。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WereadSummary {
    pub books_total: usize,
    pub books_written: usize,
    /// 回包里没有 `bookId`、没法寻址的书。跳过而不中止：一本坏数据不该拦住另外九十本
    pub books_skipped: usize,
    pub marks: usize,
    pub reviews: usize,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

/// `vela://weread-progress` 的载荷。`taskId` 内嵌，与搜索那两套同形。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    task_id: String,
    progress: WereadProgress,
}

/// `vela://weread-done` 的载荷。**这是唯一的正常终止信号**（取消也走它）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    task_id: String,
    summary: WereadSummary,
}

/// `vela://weread-failed` 的载荷。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
    task_id: String,
    error: WereadError,
}

/// 全量同步一个目录，**立刻**返回 `taskId`。
///
/// 进度走 `vela://weread-progress`，终止走 `vela://weread-done` / `vela://weread-failed`，
/// 取消用现有的 `cancel_task`。形状与理由在模块文档「M8-3」那一节。
///
/// `dir` 是前端侧边栏里那个根的原样字符串，**只用来核对**：真正写盘的目标是
/// 用户全局配置里的 `wereadLocalDir`，两者 canonicalize 之后必须相等。
#[command]
pub async fn weread_sync_dir(
    app: AppHandle,
    tasks: State<'_, TaskRegistry>,
    dir: String,
) -> Result<String, WereadError> {
    // 预检全在命令线程上做完，规矩与 start_search 相同：
    // reject = 这次同步压根没开始；拿到 taskId = 一定会收到 done 或 failed。
    // 顺序刻意让目录先判：它不碰钥匙串，而且「点错了那一行」比「没填 key」更常见
    let home = crate::commands::home_dir(&app).map_err(|err| WereadError::Directory { message: err.to_string() })?;
    let configured = settings::load(&home, None).settings.weread_local_dir;
    let root = resolve_sync_root(&configured, Path::new(&dir))?;
    load_key()
        .map_err(|err| WereadError::Keychain { message: err.message().to_owned() })?
        .ok_or_else(|| WereadError::NotConfigured { message: NOT_CONFIGURED.to_owned() })?;

    let state_file = state_path(&home);
    let (task_id, cancel) = tasks.register("weread");
    let started = Instant::now();

    let emitter = app.clone();
    let final_task_id = task_id.clone();
    // 用 spawn 而不是 spawn_blocking：这条路的主成本是等网络，阻塞池是留给
    // 搜索/替换那种 CPU + IO 的分钟级活
    tauri::async_runtime::spawn(async move {
        let outcome = run_sync(&root, &state_file, &final_task_id, &cancel, &emitter, started).await;

        // 先摘注册表再发终止事件（与 start_search 同序）：反过来会让下一次同步
        // 的条目还挂在那里，等着被一次迟到的取消误伤
        emitter.state::<TaskRegistry>().forget(&final_task_id);

        let sent = match outcome {
            Ok(summary) => emitter.emit(crate::WEREAD_DONE, DonePayload { task_id: final_task_id, summary }),
            Err(error) => emitter.emit(crate::WEREAD_FAILED, FailedPayload { task_id: final_task_id, error }),
        };
        if let Err(err) = sent {
            eprintln!("[vela] 微信读书同步的终止事件没能发出去：{err}");
        }
    });

    Ok(task_id)
}

/// 目录闸门：配置是空的、打不开、不是文件夹、或与打开的根不是同一个，一律拒。
///
/// 🔴 相等比较用 canonicalize 之后的结果，**不是 `startsWith`**（PLAN ⑨）：
/// 子目录打开时不算，软链与尾斜杠不该造成两种答案。
fn resolve_sync_root(configured: &str, opened: &Path) -> Result<PathBuf, WereadError> {
    crate::commands::resolve_configured_dir(
        configured,
        opened,
        "设置里的微信读书同步目录",
        "当前打开的目录",
        DIR_NOT_CONFIGURED,
    )
    .map_err(|message| WereadError::Directory { message })
}

/// `~/.vela/weread-state.json`。⛔ 不放进被同步的目录（PLAN ⑭）。
fn state_path(home: &Path) -> PathBuf {
    home.join(VELA_DIR_NAME).join(STATE_FILE_NAME)
}

/// 读 state。缺失或坏掉都退回空表——代价只是多列几条「本次新增」，
/// 而为此拦下一次同步会让用户拿不回笔记（与 CLI `loadState()` 同一个口径）。
fn load_state(path: &Path) -> WereadState {
    fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// 原子写 state。父目录（`~/.vela/`）不存在时先建出来——第一次同步时它可能还没有。
fn save_state(path: &Path, state: &WereadState) -> Result<(), WereadError> {
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|err| WereadError::Storage { message: format!("同步状态序列化失败：{err}") })?;
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).ok_or_else(|| WereadError::Storage {
        message: format!("同步状态的路径没有目录部分：{}", path.display()),
    })?;
    fs::create_dir_all(parent)
        .map_err(|err| WereadError::Storage { message: format!("建不出 {}：{err}", parent.display()) })?;
    write_bytes_atomic(path, &bytes).map_err(|err| storage_error(path, err))
}

fn storage_error(path: &Path, err: WriteError) -> WereadError {
    WereadError::Storage { message: format!("写 {} 失败：{err}", path.display()) }
}

/// 把渲染层给的文件名拼到给定目录上，**只接受一个普通路径段**。
///
/// 素材落 `划线素材/` 那一层，人那份落配置目录的根——两处用同一个把关。
///
/// 名字来自 [`safe_name`](vela_core::weread::safe_name)，本来就不含分隔符；这里再挡一道，
/// 是因为「渲染层保证安全」是一条会在下一次改 render 时悄悄失效的不变式（⑥.4 同一姿势）。
fn material_path(root: &Path, name: &str) -> Result<PathBuf, WereadError> {
    let mut parts = Path::new(name).components();
    match (parts.next(), parts.next()) {
        (Some(Component::Normal(one)), None) if one == OsStr::new(name) => Ok(root.join(one)),
        _ => Err(WereadError::Directory {
            message: format!("同步要写的文件名不是一个普通文件名：{name}")
        }),
    }
}

/// 书目那一页的参数。`lastSort` 只在翻第二页起才带（与 CLI 逐字一致）。
fn notebook_params(last_sort: Option<i64>) -> Vec<(&'static str, Value)> {
    let mut params = vec![("count", json!(NOTEBOOK_PAGE))];
    if let Some(sort) = last_sort {
        params.push(("lastSort", json!(sort)));
    }
    params
}

/// 想法那一页的参数。
///
/// ⚠️ 键名是小写的 `bookid`，与 `/book/bookmarklist` 的 `bookId` 不是同一个写法。
/// 抄错不会报错，只会永远拿到一页空想法。
fn review_params(book_id: &str, synckey: i64) -> Vec<(&'static str, Value)> {
    vec![("bookid", json!(book_id)), ("count", json!(REVIEW_PAGE)), ("synckey", json!(synckey))]
}

fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

fn parse_page<T: DeserializeOwned>(api_name: &str, value: Value) -> Result<T, WereadError> {
    serde_json::from_value(value)
        .map_err(|err| WereadError::Shape { message: format!("{api_name} 的回包结构不对：{err}") })
}

/// 翻完全部书目。`Ok(None)` = 用户取消。
async fn list_notebooks(cancel: &AtomicBool) -> Result<Option<Vec<BookNotebook>>, WereadError> {
    let mut books = Vec::new();
    let mut seen = BTreeSet::new();
    let mut last_sort = None;
    for _ in 0..MAX_PAGES {
        if is_cancelled(cancel) {
            return Ok(None);
        }
        let value = gateway("/user/notebooks", &notebook_params(last_sort)).await?;
        let page: NotebooksPage = parse_page("/user/notebooks", value)?;
        let next = next_notebook_sort(&page);
        for book in page.books {
            // 翻页偶发重叠：同一个 bookId 只留第一份，免得同一本书被写两遍
            match book.book_id.as_deref() {
                Some(id) if !seen.insert(id.to_owned()) => {}
                _ => books.push(book),
            }
        }
        match next {
            Some(sort) => last_sort = Some(sort),
            None => break,
        }
    }
    Ok(Some(books))
}

/// 一本书的划线 + 全部想法。`Ok(None)` = 用户取消。
async fn fetch_book(
    book_id: &str,
    cancel: &AtomicBool,
) -> Result<Option<(BookmarkList, Vec<ReviewCore>)>, WereadError> {
    if is_cancelled(cancel) {
        return Ok(None);
    }
    let value = gateway("/book/bookmarklist", &[("bookId", json!(book_id))]).await?;
    let marks: BookmarkList = parse_page("/book/bookmarklist", value)?;

    let mut reviews = Vec::new();
    let mut synckey = 0;
    for _ in 0..MAX_PAGES {
        if is_cancelled(cancel) {
            return Ok(None);
        }
        let value = gateway("/review/list/mine", &review_params(book_id, synckey)).await?;
        let page: ReviewsPage = parse_page("/review/list/mine", value)?;
        let next = next_review_synckey(Some(synckey), &page);
        reviews.extend(page.reviews.iter().map(|entry| entry.core().clone()));
        match next {
            Some(next) => synckey = next,
            None => break,
        }
    }
    Ok(Some((marks, reviews)))
}

/// 一本书落到盘上的结果（写进总账的那几个数）。
struct BookWrite {
    marks: usize,
    reviews: usize,
}

/// 把一本书写成两份：素材整份重写，整理只在缺失时落种子。
fn write_book(
    dir: &Path,
    book_id: &str,
    entry: &BookNotebook,
    marks: &BookmarkList,
    reviews: &[ReviewCore],
    state: &mut WereadState,
    synced_at: i64,
) -> Result<BookWrite, WereadError> {
    // 书名/作者优先取划线回包里那一份（CLI 同序），缺了再退到书目那一份
    let title = marks
        .book
        .as_ref()
        .and_then(|book| book.title.as_deref())
        .or_else(|| entry.book.as_ref().and_then(|book| book.title.as_deref()));
    let author = marks
        .book
        .as_ref()
        .and_then(|book| book.author.as_deref())
        .or_else(|| entry.book.as_ref().and_then(|book| book.author.as_deref()));

    let seen_ids: BTreeSet<String> =
        state.get(book_id).map(|book| book.ids.iter().cloned().collect()).unwrap_or_default();
    // ⚠️ 首次 = state 里还没有这一本，⛔ 不用 `seen_ids.is_empty()` 推：
    // 「上次同步过但一条划线都没有」也是空集、却不是首次（见 MaterialInput 的文档）
    let first_time = !state.contains_key(book_id);

    let input = MaterialInput {
        book_id,
        title,
        author,
        marks: &marks.updated,
        chapters: &marks.chapters,
        reviews,
        seen_ids: &seen_ids,
        first_time,
        synced_at,
    };
    let plan = plan_material(&input);

    // 素材统一收进子目录（M8-10）：根上只留人那份，用户整理时不会被几十份素材夹住。
    // ⚠️ `write_text_atomic` 只在目标目录里建 `.tmp`，⛔ 不替我们建目录（第一次同步时
    // 这个子目录还不存在），所以先建出来。已存在时 `create_dir_all` 是空操作
    let material_dir = dir.join(MATERIAL_DIR);
    fs::create_dir_all(&material_dir)
        .map_err(|err| WereadError::Storage { message: format!("建不出 {}：{err}", material_dir.display()) })?;
    let material = material_path(&material_dir, &plan.material_name)?;
    write_text_atomic(&material, &plan.material, FILE_FORMAT).map_err(|err| storage_error(&material, err))?;

    // 人那份**只在缺失时**写种子，之后一个字都不改（决定 1 / ④ 的所有权模型）
    let organize = material_path(dir, &plan.organize_name)?;
    if !organize.exists() {
        write_text_atomic(&organize, &plan.organize_seed, FILE_FORMAT).map_err(|err| storage_error(&organize, err))?;
    }

    state.insert(book_id.to_owned(), SeenBook { ids: plan.ids, synced_at });
    Ok(BookWrite { marks: marks.updated.len(), reviews: reviews.len() })
}

/// 一次同步的正文：列书目 → 逐本拉取 + 落盘 → 每本落一次 state。
async fn run_sync(
    root: &Path,
    state_file: &Path,
    task_id: &str,
    cancel: &AtomicBool,
    app: &AppHandle,
    started: Instant,
) -> Result<WereadSummary, WereadError> {
    let mut state = load_state(state_file);
    let mut summary = WereadSummary::default();

    let Some(books) = list_notebooks(cancel).await? else {
        summary.cancelled = true;
        summary.elapsed_ms = elapsed_ms(started);
        return Ok(summary);
    };

    summary.books_total = books.len();
    emit_progress(app, task_id, WereadProgress { books_done: 0, books_total: books.len() });

    // 一次同步只取一次时间：整批素材文件的「同步于」必须是同一刻，
    // 否则用户会以为第 3 本和第 40 本来自两次同步
    let synced_at = now_unix();

    for (index, entry) in books.iter().enumerate() {
        if is_cancelled(cancel) {
            summary.cancelled = true;
            break;
        }
        let Some(book_id) = entry.book_id.as_deref() else {
            summary.books_skipped += 1;
            emit_progress(app, task_id, WereadProgress { books_done: index + 1, books_total: books.len() });
            continue;
        };
        let Some((marks, reviews)) = fetch_book(book_id, cancel).await? else {
            summary.cancelled = true;
            break;
        };
        let written = write_book(root, book_id, entry, &marks, &reviews, &mut state, synced_at)?;
        summary.books_written += 1;
        summary.marks += written.marks;
        summary.reviews += written.reviews;

        // 每本一次 state 落盘：取消/失败时，已经写完的书不会在下次同步里
        // 被当成「首次」再报一遍。多出来的磁盘写次数与书数同阶，可接受
        save_state(state_file, &state)?;

        emit_progress(app, task_id, WereadProgress { books_done: index + 1, books_total: books.len() });
    }

    summary.elapsed_ms = elapsed_ms(started);
    Ok(summary)
}

fn emit_progress(app: &AppHandle, task_id: &str, progress: WereadProgress) {
    let payload = ProgressPayload { task_id: task_id.to_owned(), progress };
    if let Err(err) = app.emit(crate::WEREAD_PROGRESS, payload) {
        eprintln!("[vela] 微信读书同步的进度事件没能发出去：{err}");
    }
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs() as i64).unwrap_or(0)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vela_core::weread::model::{BookInfo, Chapter, Mark};

    /// 测试用的 key。选一个**搜得到**的串，好让「失败文案里没有它」是一条真的断言
    /// （与 `secrets.rs` / `oss.rs` 里那几条同套路数）。
    const KEY: &str = "wrk-SECRET-VALUE-DO-NOT-LEAK";

    #[test]
    fn 请求地址只有网关那一个() {
        // 文案里的域名必须就是我们真的会打的那个：两条各写各的，漂了就会出现
        // 「错误说 i.weread.qq.com，请求其实打到别处」这种没人查得出来的局面
        assert!(GATEWAY_URL.starts_with(&format!("https://{HOST}/")), "{GATEWAY_URL}");
        let prepared = prepare("/user/notebooks", &[], KEY);
        assert_eq!(prepared.url, GATEWAY_URL);
    }

    #[test]
    fn 授权头只有_bearer_一种形状() {
        let prepared = prepare("/user/notebooks", &[], KEY);
        assert_eq!(prepared.authorization, format!("Bearer {KEY}"));
    }

    #[test]
    fn 请求体平铺且带版本号() {
        let prepared = prepare("/book/bookmarklist", &[("bookId", json!("3300000001"))], KEY);
        let body: Value = serde_json::from_str(&prepared.body).unwrap();
        // 🔴 不是 {api_name, params: {...}}：嵌套进去服务端读不到参数
        assert_eq!(body["api_name"], json!("/book/bookmarklist"));
        assert_eq!(body["bookId"], json!("3300000001"));
        assert_eq!(body["skill_version"], json!(vela_core::weread::SKILL_VERSION));
        assert!(body.get("params").is_none());
        // key 只进授权头，⛔ 不进请求体
        assert!(!prepared.body.contains(KEY), "{}", prepared.body);
    }

    #[test]
    fn 服务名不跟_bundle_id_走() {
        assert!(!SERVICE.contains(".m1"), "{SERVICE}");
    }

    #[test]
    fn 与_oss_那把密钥不共用槽() {
        // 同一个 service/account 放两把凭证，将来任何一次「按 service 清一遍」都会连坐
        assert_ne!(SERVICE, crate::secrets::SERVICE);
        assert_ne!(ACCOUNT, crate::secrets::ACCOUNT);
    }

    #[test]
    fn 内核的三种失败原样搬过来() {
        let upgrade = WereadError::from(
            classify("/user/notebooks", 200, Some(json!({"upgrade_info": {"message": "请升级到 1.0.6"}}))).unwrap_err(),
        );
        assert!(matches!(upgrade, WereadError::Upgrade { .. }));
        assert_eq!(
            serde_json::to_string(&upgrade).unwrap(),
            r#"{"kind":"upgrade","message":"服务端要求升级 Skill：请升级到 1.0.6"}"#
        );

        // 服务端 errmsg 是中文人话，原样透出（⛔ 不许压成「服务繁忙」）
        let api = WereadError::from(
            classify("/user/notebooks", 200, Some(json!({"errcode": -2010, "errmsg": "用户不存在"}))).unwrap_err(),
        );
        assert_eq!(
            serde_json::to_string(&api).unwrap(),
            r#"{"kind":"api","message":"/user/notebooks HTTP 200 errcode=-2010 用户不存在"}"#
        );

        let not_json = WereadError::from(classify("/book/bookmarklist", 502, None).unwrap_err());
        assert_eq!(
            serde_json::to_string(&not_json).unwrap(),
            r#"{"kind":"not_json","message":"/book/bookmarklist HTTP 502（回包不是 JSON）"}"#
        );
    }

    #[test]
    fn 另外三种失败的_json_形状被钉住() {
        // 与前端那份手写镜像对照（M8-3 接面板时才有消费者，先把形状定下来）
        let cases = [
            (
                WereadError::NotConfigured { message: NOT_CONFIGURED.to_owned() },
                r#"{"kind":"not_configured","message":"微信读书的 key 还没填。到「设置 → 微信读书」里填一次。"}"#,
            ),
            (
                WereadError::Keychain { message: "钥匙串操作失败（-25300）。".to_owned() },
                r#"{"kind":"keychain","message":"钥匙串操作失败（-25300）。"}"#,
            ),
            (
                WereadError::Network { reason: "Timeout".to_owned(), message: "30 秒内没等到".to_owned() },
                r#"{"kind":"network","reason":"Timeout","message":"30 秒内没等到"}"#,
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(serde_json::to_string(&err).unwrap(), expected);
        }
    }

    #[test]
    fn 调试输出与序列化里都没有_key() {
        // 🔴 整条同步路的错误会一路回到前端；key 一次都不许出现在这些出口里
        let errors = [
            WereadError::NotConfigured { message: NOT_CONFIGURED.to_owned() },
            WereadError::Keychain { message: "钥匙串拒绝了这次读写。".to_owned() },
            WereadError::Network { reason: "Connect".to_owned(), message: "连不上 i.weread.qq.com。".to_owned() },
            WereadError::Upgrade { message: "服务端要求升级 Skill：请升级".to_owned() },
            WereadError::Api { message: "/user/notebooks HTTP 200 errcode=-2010 用户不存在".to_owned() },
            WereadError::NotJson { message: "/user/notebooks HTTP 200（回包不是 JSON）".to_owned() },
            WereadError::Directory { message: "/Users/me/notes 与设置不一致".to_owned() },
            WereadError::Shape { message: "/user/notebooks 的回包结构不对：invalid type".to_owned() },
            WereadError::Storage { message: "写 /Users/me/notes/a.md 失败".to_owned() },
        ];
        for err in &errors {
            let json = serde_json::to_string(err).unwrap();
            assert!(!json.contains(KEY), "失败序列化里带了 key：{json}");
            assert!(!format!("{err:?}").contains(KEY), "失败的 Debug 里带了 key：{err:?}");
        }
    }

    // ─── M8-3：state / 目录闸门 / 翻页参数 / 双文件写盘 / 事件形状 ──────────

    #[test]
    fn state_落在用户主目录的_vela_下面() {
        // PLAN ⑭：机器状态不进被同步的目录——换设备时 base 为空是**预期**的代价
        let home = Path::new("/Users/me");
        assert_eq!(state_path(home), PathBuf::from("/Users/me/.vela/weread-state.json"));
    }

    #[test]
    fn 同步状态往返一致且是_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE_NAME);
        let mut state = WereadState::new();
        state.insert(
            "3300000001".to_owned(),
            SeenBook { ids: vec!["a".to_owned(), "b".to_owned()], synced_at: 1_740_000_000 },
        );
        save_state(&path, &state).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        // 线上名是 camelCase：将来前端那一份镜像与这里同一个口径
        assert!(raw.contains("\"syncedAt\": 1740000000"), "{raw}");
        assert!(raw.contains("\"ids\""), "{raw}");
        assert!(!raw.contains("synced_at"), "{raw}");
        assert_eq!(load_state(&path), state);
    }

    #[test]
    fn 状态文件缺失或坏掉都退回空表() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE_NAME);
        assert!(load_state(&path).is_empty(), "缺失");

        fs::write(&path, b"{ this is not json").unwrap();
        assert!(load_state(&path).is_empty(), "坏 JSON");

        // 旧 CLI 的 syncedAt 是 ISO 字符串。⛔ 不迁移那个文件（家已经搬到 ~/.vela/），
        // 读到它必须退回空表：把「首次」判错成「已同步」会让新划线永远进不了「本次新增」
        fs::write(&path, br#"{"bk1":{"ids":["a"],"syncedAt":"2026-11-10T00:00:00.000Z"}}"#).unwrap();
        assert!(load_state(&path).is_empty(), "旧形状");
    }

    #[test]
    fn 素材与整理文件只能落在配置目录里() {
        let root = Path::new("/Users/me/notes");
        // 素材那一层与根那一层走同一个把关；目录名本身也钉在这儿，
        // 免得改成别处之后种子里的相对链接还指向老名字
        let material_dir = root.join(MATERIAL_DIR);
        assert_eq!(MATERIAL_DIR, "划线素材");
        assert_eq!(
            material_path(&material_dir, "某人 - 合成之书·划线素材.md").unwrap(),
            material_dir.join("某人 - 合成之书·划线素材.md")
        );
        // 绝对路径、`..`、分隔符、空串、以及「带尾斜杠但只有一个 Normal 段」全部拒
        for bad in ["/etc/passwd", "../escape.md", "a/b.md", "..", ".", "", "a/"] {
            match material_path(&material_dir, bad) {
                Err(WereadError::Directory { .. }) => {}
                other => panic!("{bad:?} 不该被接受：{other:?}"),
            }
        }
    }

    #[test]
    fn 同步目录必须是配置的那一个且规范化后相等() {
        let dir = tempfile::tempdir().unwrap();
        let opened = dir.path();
        let canonical = fs::canonicalize(opened).unwrap();

        // 尾斜杠不该造成第二种答案
        let with_slash = format!("{}/", canonical.display());
        assert_eq!(resolve_sync_root(&with_slash, opened).unwrap(), canonical);
        assert_eq!(resolve_sync_root(&canonical.display().to_string(), opened).unwrap(), canonical);

        // 没配
        match resolve_sync_root("  ", opened) {
            Err(WereadError::Directory { message }) => assert!(message.contains("还没配"), "{message}"),
            other => panic!("{other:?}"),
        }

        // 🔴 不是 startsWith：子目录、兄弟目录打开时都不算
        let child = opened.join("child");
        fs::create_dir(&child).unwrap();
        assert!(resolve_sync_root(&canonical.display().to_string(), &child).is_err(), "子目录不算");
        let other = tempfile::tempdir().unwrap();
        assert!(resolve_sync_root(&canonical.display().to_string(), other.path()).is_err(), "别的目录");

        // 配到了一个文件上
        let file = opened.join("a.txt");
        fs::write(&file, b"x").unwrap();
        assert!(resolve_sync_root(&file.display().to_string(), opened).is_err(), "文件不是目录");

        // 配了一个不存在的路径：报错，⛔ 不悄悄建
        let missing = opened.join("nope");
        assert!(resolve_sync_root(&missing.display().to_string(), opened).is_err());

        // 软链指过来也算同一个目录：两边都 canonicalize 到同一个真身
        #[cfg(unix)]
        {
            let link = opened.join("link");
            std::os::unix::fs::symlink(opened, &link).unwrap();
            assert_eq!(resolve_sync_root(&link.display().to_string(), opened).unwrap(), canonical);
        }
    }

    #[test]
    fn 翻页参数与_cli_逐字一致() {
        assert_eq!(notebook_params(None), vec![("count", json!(100))]);
        assert_eq!(
            notebook_params(Some(1_740_000_000)),
            vec![("count", json!(100)), ("lastSort", json!(1_740_000_000))]
        );
        // 🔴 /review/list/mine 的键是小写 bookid；与 /book/bookmarklist 的 bookId 不同。
        // 抄错不会报错，只会永远拿到一页空想法
        assert_eq!(
            review_params("3300000001", 0),
            vec![("bookid", json!("3300000001")), ("count", json!(50)), ("synckey", json!(0))]
        );
        assert_eq!(review_params("3300000001", 77)[2], ("synckey", json!(77)));
    }

    #[test]
    fn 回包结构漂了报_shape_而不是写出空文件() {
        let err = parse_page::<NotebooksPage>("/user/notebooks", json!({"books": "不是数组"})).expect_err("类型不符");
        match err {
            WereadError::Shape { message } => {
                assert!(message.starts_with("/user/notebooks 的回包结构不对："), "{message}");
                assert!(message.contains("books"), "{message}");
            }
            other => panic!("{other:?}"),
        }
        // 前端按 kind 分支，不读 message 里的关键字
        assert_eq!(
            serde_json::to_string(&WereadError::Shape { message: "x".to_owned() }).unwrap(),
            r#"{"kind":"shape","message":"x"}"#
        );
    }

    fn entry_fixture() -> BookNotebook {
        BookNotebook {
            book_id: Some("3300000001".to_owned()),
            sort: Some(1_740_000_000),
            note_count: Some(1),
            review_count: Some(0),
            bookmark_count: Some(0),
            book: Some(BookInfo {
                book_id: Some("3300000001".to_owned()),
                title: Some("合成之书".to_owned()),
                author: Some("某人".to_owned()),
            }),
        }
    }

    /// 合成夹具：形状照真数据，正文一律合成（⛔ 第三方划线原文不进这个仓库）。
    fn marks_fixture() -> BookmarkList {
        BookmarkList {
            book: Some(BookInfo {
                book_id: None, title: Some("合成之书".to_owned()), author: Some("某人".to_owned())
            }),
            chapters: vec![Chapter {
                title: Some("第一章".to_owned()),
                chapter_uid: Some("54".to_owned()),
                chapter_idx: Some(1),
            }],
            updated: vec![Mark {
                bookmark_id: "3300000001_54_515-528".to_owned(),
                chapter_uid: Some("54".to_owned()),
                chapter_idx: Some(1),
                range: Some("515-528".to_owned()),
                mark_text: Some("合成正文甲".to_owned()),
                create_time: Some(1_740_000_000),
            }],
        }
    }

    #[test]
    fn 每本书一份素材且整理文件只在缺失时写种子() {
        let dir = tempfile::tempdir().unwrap();
        let entry = entry_fixture();
        let marks = marks_fixture();
        let mut state = WereadState::new();

        let written = write_book(dir.path(), "3300000001", &entry, &marks, &[], &mut state, 1_740_000_000).unwrap();
        assert_eq!(written.marks, 1);
        assert_eq!(written.reviews, 0);

        let material_dir = dir.path().join(MATERIAL_DIR);
        let material = material_dir.join("某人 - 合成之书·划线素材.md");
        let organize = dir.path().join("某人 - 合成之书.md");
        let material_text = fs::read_to_string(&material).unwrap();
        assert!(material_text.contains("合成正文甲"), "{material_text}");
        assert!(material_text.contains("首次同步"), "{material_text}");
        assert!(material_text.contains("[← 回到整理](<../某人%20-%20合成之书.md>)"), "{material_text}");
        let seed = fs::read_to_string(&organize).unwrap();
        assert!(
            seed.contains("[划线素材](<划线素材/某人%20-%20合成之书·划线素材.md>)"),
            "种子该指向子目录里的素材文件：{seed}"
        );
        assert_eq!(state.get("3300000001").unwrap().ids, vec!["3300000001_54_515-528".to_owned()]);
        assert_eq!(state.get("3300000001").unwrap().synced_at, 1_740_000_000);

        // 用户改了整理文件 → 下一次同步一个字都不许动它；素材则整份重写
        fs::write(&organize, "我自己写的整理\n").unwrap();
        write_book(dir.path(), "3300000001", &entry, &marks, &[], &mut state, 1_800_000_000).unwrap();
        assert_eq!(fs::read_to_string(&organize).unwrap(), "我自己写的整理\n");
        let rewritten = fs::read_to_string(&material).unwrap();
        assert_ne!(rewritten, material_text, "素材该整份重写");
        assert!(rewritten.contains("本次没有新增"), "{rewritten}");
        assert_eq!(state.get("3300000001").unwrap().synced_at, 1_800_000_000);

        // 根上只有人那份与素材子目录；素材目录里只有这一份，临时文件不残留
        let mut names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec![MATERIAL_DIR.to_owned(), "某人 - 合成之书.md".to_owned()], "{names:?}");
        let mut inner: Vec<String> = fs::read_dir(&material_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        inner.sort();
        assert_eq!(inner, vec!["某人 - 合成之书·划线素材.md".to_owned()], "{inner:?}");
    }

    #[test]
    fn 进度与终止事件的_json_形状被钉住() {
        let progress = ProgressPayload {
            task_id: "weread-0".to_owned(),
            progress: WereadProgress { books_done: 2, books_total: 7 },
        };
        assert_eq!(
            serde_json::to_string(&progress).unwrap(),
            r#"{"taskId":"weread-0","progress":{"booksDone":2,"booksTotal":7}}"#
        );

        let done = DonePayload {
            task_id: "weread-0".to_owned(),
            summary: WereadSummary {
                books_total: 3,
                books_written: 2,
                books_skipped: 1,
                marks: 176,
                reviews: 4,
                cancelled: false,
                elapsed_ms: 1234,
            },
        };
        assert_eq!(
            serde_json::to_string(&done).unwrap(),
            r#"{"taskId":"weread-0","summary":{"booksTotal":3,"booksWritten":2,"booksSkipped":1,"marks":176,"reviews":4,"cancelled":false,"elapsedMs":1234}}"#
        );

        let failed = FailedPayload {
            task_id: "weread-0".to_owned(),
            error: WereadError::Directory { message: "配置与打开的目录不一致".to_owned() },
        };
        assert_eq!(
            serde_json::to_string(&failed).unwrap(),
            r#"{"taskId":"weread-0","error":{"kind":"directory","message":"配置与打开的目录不一致"}}"#
        );
    }
}
