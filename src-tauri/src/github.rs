//! GitHub 目录同步的落地层（M8-5 钥匙串 → M8-8 REST 六条，PLAN.md §3.22）。
//!
//! 纯逻辑在 [`vela_core::sync`]（M8-7）：blob sha 怎么算、哪个路径算整理文件、三张
//! `path → sha` 表怎么比成计划、state 长什么样。这一层只剩必须有真东西才做得到的三件事：
//! 一次真的 HTTPS 请求、一次真的钥匙串读取、一次真的写盘。
//!
//! ## 🔴 这里没有一条命令能拿到 token 的值
//!
//! 三条钥匙串命令分别是写、删、问「配没配」。`SecretStatus` 里只有一个 bool，⛔ 不要给它加字段，
//! 也不要新写一条 `get_github_token`：webview 里任何一段脚本都能 `invoke`，而预览一份
//! 别人发来的 Markdown 就足以注入一段。完整论证在 [`crate::secrets`] 的模块文档里。
//!
//! 同样地，REST 六条**不是** command：前端对 GitHub 只有一条能力——`github_sync_dir`。
//! 要问哪个接口、推哪些文件、提交信息写什么，全部由 Rust 决定。⛔ 别为「调试方便」
//! 补一条 `github_probe`，那等于把用户的 token 变成 webview 手里的通用凭据。
//!
//! token 只从钥匙串读到本进程，再进 `Authorization: Bearer …`。它不进 [`GithubError`]
//! 的任何变体、不进 `Debug`、不进日志、不进请求体。错误文案里那条带状态的句子只会有
//! HTTP 码与 GitHub 自己返回的 `message`。
//!
//! ## 槽位为什么单独一格
//!
//! `app.vela.github` / `token`，与 OSS 的 `app.vela.oss` 和微信读书的 `app.vela.weread`
//! 都不共用：同一个 service 下放两条用途不同的凭证，将来任何一次「按 service 清一遍」
//! 都会连坐。而这三把凭证的爆炸半径本来就不一样——OSS secret 能往用户的桶里写，
//! 微信读书 key 能读用户的全部笔记，GitHub token 能往用户的仓库里推。
//!
//! ## 六条 REST（⛔ 不加第七条）
//!
//! 1. `GET /git/ref/heads/{branch}` → HEAD commit。
//! 2. `GET /git/trees/{commit}?recursive=1` → 远端快照（`type == "blob"` 且过
//!    [`is_managed_path`]）。⚠️ **`truncated: true` 一律停**：拿半棵树比对，会把
//!    没读到的文件当成「远端删了」。
//! 3. `GET /git/blobs/{sha}` → 只拉真正要写回本地的那些文件，一次一个。
//! 4. `POST /git/blobs` → 每个要推的文件一次。
//! 5. `POST /git/trees` → ⚠️ **`base_tree` 必填**（[`tree_request`] 的文档）。
//! 6. `POST /git/commits`（`parents` 只有一个）+ `PATCH /git/refs/heads/{branch}`
//!    （`force: false`）。非快进由服务端 422 拒掉，形成 [`GithubError::NonFastForward`]。
//!
//! ## 分支名：先 `main` 再 `master`
//!
//! 没有第三个配置键（PLAN M8-7 留下的口子）。同一条 `GET ref` 打两次，404 就换下一个；
//! 两个都 404 → [`GithubError::BranchNotFound`]，⛔ 不查默认分支（那是第 7 条调用），
//! 也⛔ 不自动建分支。解析出来的分支名会写进 `~/.vela/sync-state.json`，换分支时
//! base 自动退回空表。
//!
//! ## 四条必须停
//!
//! 无快进、双边改动、`upgrade_info`（微信读书那边）、目录越界。这里负责三条：
//! 计划里出现任何冲突就在**写任何文件之前**返回 [`GithubError::Conflict`]（带完整清单）；
//! 写回本地的路径先过 [`safe_rel`]，拼上根之后 canonicalize 父目录、再判前缀；
//! 推的时候若本地文件在同步途中被改了，直接 [`GithubError::LocalChanged`] 停住。
//!
//! ## state 与 `.gitignore`
//!
//! `~/.vela/sync-state.json`（PLAN ⑭），只在**整份计划全部做完**之后写：取消、冲突、
//! 中途失败都不前移 base，否则下一次就查不出这次没处理的那一格。写 state 失败**不算同步失败**
//! （`summary.stateSaved` 会是 `false`，下次退回「无 base」的保守分支）。
//!
//! `.gitignore` 只维护配置目录根上那一个文件、只补一行 `*·划线素材.md`，⛔ 不同步到远端：
//! 它不是整理文件，远端那份是用户自己的事。行尾跟随文件现状，已有就一个字都不改。
//!
//! ## 这一层测到哪儿
//!
//! 联网那一段不测（`reqwest::Error` 没有公开构造器；真打一次需要真 token）。能在出门前
//! 判完的都收进纯函数：仓库地址解析、远端树过滤、`base_tree` / `parents` / `force:false`
//! 三个请求体、拉取路径闸门、本地快照的集合与 sha。⚠️ 首轮真机（M8-9）要把
//! `/git/trees` 的回包、token 权限面的实际报错、以及 91 个文件级别的耗时记下来。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{command, AppHandle, Emitter, Manager, State};
use vela_core::fs::write_bytes_atomic;
use vela_core::settings::{self, VELA_DIR_NAME};
use vela_core::sync::{
    blob_sha, compare, is_managed_path, load_state, safe_rel, save_state, with_material_ignore, Conflict, ConflictKind,
    Snapshot, GITIGNORE_FILE,
};
use vela_core::weread::stamp_of;

use crate::commands::TaskRegistry;
use crate::secrets::{self, SecretError, SecretStatus};

/// 钥匙串里 GitHub token 的服务名。
///
/// ⚠️ 与另外两把**必须不同**（见模块文档）。⛔ 不要跟着 `tauri.conf.json` 的 `identifier`
/// 走，也不要把它做成可配置的——钥匙串项按这个字符串寻址，改一次就是升级后一片「未配置」。
pub const SERVICE: &str = "app.vela.github";

/// 账号名。一条 service 下一个账号，Vela 只用这一个。
pub const ACCOUNT: &str = "token";

/// GitHub API 的主机名。**只用来拼地址与错误文案**：地址前缀只有 [`API_BASE`] 一个。
const API_HOST: &str = "api.github.com";
const API_BASE: &str = "https://api.github.com";

/// GitHub 要求每个请求都有 `User-Agent`；没有的那一份是 403，而不是 400。
const USER_AGENT: &str = "Vela";

/// 机器状态文件名，落在 `~/.vela/` 下（PLAN §3.22 ⑭）。
const STATE_FILE_NAME: &str = "sync-state.json";

/// 「没填 token」那一句。
const NOT_CONFIGURED: &str = "GitHub 的 token 还没填。到「设置 → 文件同步」里填一次。";

/// 「没配仓库」那一句。与 [`NOT_CONFIGURED`] 分开：填了 token 却没填仓库时，
/// 说「token 没填」会让他去翻一个本来就对的输入框。
const REPO_NOT_CONFIGURED: &str = "还没配置 GitHub 仓库。到「设置 → 文件同步」里填 owner/repo。";

/// 「没配同步目录」那一句。
const DIR_NOT_CONFIGURED: &str = "文件同步的本地目录还没配。到「设置 → 文件同步」里选一个目录。";

/// 分支候选，按顺序试。⚠️ 只有这两个：⛔ 不查默认分支（第 7 条 REST）。
const BRANCH_CANDIDATES: [&str; 2] = ["main", "master"];

/// 一次同步的失败。
///
/// 与 [`crate::weread::WereadError`] 同一套路数：`#[serde(tag = "kind")]` 让前端按类型
/// 分支，而不是去 `message` 里找关键字。🔴 十三个变体里没有任何一个可能带 token。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GithubError {
    /// 必需项没配（token 或仓库地址）。`message` 指向具体的设置分组与输入框。
    NotConfigured { message: String },
    /// 钥匙串读失败。`message` 是 [`SecretError::message`] 的原话——「没配」与
    /// 「配了但读不出」对用户是两句不同的话，不能吞成同一种。
    Keychain { message: String },
    /// 同步目录与设置对不上：没配、不存在、不是文件夹，或与当前打开的根**不是同一个**。
    /// 🔴 只出现在预检里：意味着一个字节都还没写。
    Directory { message: String },
    /// 仓库地址解析不了（`owner/repo` 之外的形状、多了一层路径、非法字符）。
    Repo { message: String },
    /// 请求没走到 GitHub，或者回包没读完。`reason` 同微信读书那一套分类。
    Network { reason: String, message: String },
    /// 401 / 403：token 无效、没有这个仓库的权限、或者被限流。`message` 带 GitHub 的原话。
    Auth { message: String },
    /// `main` 与 `master` 两条 ref 都是 404。⛔ 不自动建分支。
    BranchNotFound { message: String },
    /// `PATCH ref` 返回 422/409：读快照之后远端又动了。⛔ 不重试、不 force。
    NonFastForward { message: String },
    /// 三方比对出了需要人处理的路径。**一个字节都没写**，state 也没有前移。
    Conflict { message: String, conflicts: Vec<ConflictView> },
    /// 其它非 2xx。`message` 带方法、路径、状态码与 GitHub 的 `message`。
    Api { message: String },
    /// 回包不是这个接口该有的结构（字段漂了、树被截断、blob 内容对不上 sha）。
    /// ⛔ 不带回包正文（笔记原文不落日志）。
    Shape { message: String },
    /// 本地文件在读出快照之后、推上去之前被改了。推旧内容会让 base 记错 sha，
    /// 所以停在这一次，让用户再点一次。
    LocalChanged { message: String },
    /// 本地读写失败：扫目录、`.gitignore`、写回远端的文件。
    Storage { message: String },
}

/// 冲突清单里的一条，直接给界面展示。三个 `Option` 是三张表里各自的值（缺失 = 没有这一份）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConflictView {
    pub path: String,
    pub base: Option<String>,
    pub local: Option<String>,
    pub remote: Option<String>,
    pub kind: String,
}

/// 仓库坐标：`owner/repo` 拆开之后的两段。两端都只保留 GitHub 允许的字符。
#[derive(Debug, Clone, PartialEq, Eq)]
struct RepoSpec {
    owner: String,
    repo: String,
}

impl RepoSpec {
    /// 解析 `owner/repo` 或 `https://github.com/owner/repo`（可带 `.git` 与尾斜杠）。
    ///
    /// 🔴 只认 GitHub 主站。别的域名（包括企业版）会被路径段数量挡掉，而不是被猜成
    /// 「owner 叫 https:」——那会打出一个 404，用户却在设置里看到一个像对的地址。
    fn parse(raw: &str) -> Result<Self, GithubError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(GithubError::NotConfigured { message: REPO_NOT_CONFIGURED.to_owned() });
        }
        let mut text = trimmed;
        for prefix in ["https://github.com/", "http://github.com/", "github.com/"] {
            if let Some(rest) = text.strip_prefix(prefix) {
                text = rest;
                break;
            }
        }
        let text = text.trim_end_matches('/');
        let text = text.strip_suffix(".git").unwrap_or(text);
        if text.contains('?') || text.contains('#') {
            return Err(repo_error(raw));
        }
        let mut parts = text.split('/');
        let owner = parts.next().unwrap_or("");
        let repo = parts.next().unwrap_or("");
        if parts.next().is_some() || !valid_owner(owner) || !valid_repo(repo) {
            return Err(repo_error(raw));
        }
        Ok(Self { owner: owner.to_owned(), repo: repo.to_owned() })
    }

    /// 写进 state 的仓库标识。与配置原样对应的那一段，不做大小写归一。
    fn full(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// `/repos/{owner}/{repo}` 后面接一段路径。
    fn api(&self, suffix: &str) -> String {
        format!("/repos/{}/{}{suffix}", self.owner, self.repo)
    }
}

fn repo_error(raw: &str) -> GithubError {
    GithubError::Repo {
        message: format!("仓库地址看不懂：{raw}。请填 owner/repo 或 https://github.com/owner/repo。")
    }
}

/// owner 只允许字母数字与连字符（GitHub 的规则；`-` 不能打头，这里不细究——
/// 那种名字 GitHub 自己也不会有，打过去是 404，用户看得到）。
fn valid_owner(owner: &str) -> bool {
    !owner.is_empty() && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// repo 允许字母数字与 `- . _`，但整段不能是 `.` / `..`（那会让拼出来的 URL 爬路径）。
fn valid_repo(repo: &str) -> bool {
    !repo.is_empty()
        && repo != "."
        && repo != ".."
        && repo.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// 一次同步的进度。单位是**文件**，不是请求（一次推送还有一个 commit + ref，不计数）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubProgress {
    pub files_done: usize,
    pub files_total: usize,
}

/// 一次同步的总账。`cancelled = true` 时其余数字是**取消为止**的账。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSummary {
    pub pulled: usize,
    pub pushed: usize,
    pub cancelled: bool,
    /// state 有没有写成功。失败不影响已经落盘的同步，只是下次退回「无 base」。
    pub state_saved: bool,
    pub elapsed_ms: u64,
}

/// `vela://github-progress` 的载荷。`taskId` 内嵌，与搜索/微信读书同形。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    task_id: String,
    progress: GithubProgress,
}

/// `vela://github-done` 的载荷。**这是唯一的正常终止信号**（取消也走它）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    task_id: String,
    summary: GithubSummary,
}

/// `vela://github-failed` 的载荷。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
    task_id: String,
    error: GithubError,
}

// ─── 纯函数：请求体与回包 ─────────────────────────────────────────────

/// `GET ref` 的回包：`{"object":{"sha":"…"}}`。
#[derive(Debug, Deserialize)]
struct RefResponse {
    object: RefObject,
}

#[derive(Debug, Deserialize)]
struct RefObject {
    sha: String,
}

/// `GET tree?recursive=1` 的回包。
#[derive(Debug, Deserialize)]
struct TreeResponse {
    sha: String,
    #[serde(default)]
    tree: Vec<TreeEntry>,
    /// GitHub 对超大仓库会截断。⚠️ 截断的树不能当远端快照（见模块文档）。
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

/// `GET blob` 的回包。
#[derive(Debug, Deserialize)]
struct BlobResponse {
    content: String,
    encoding: String,
}

/// 创建类接口（blob / tree / commit）的回包都只有这一个字段有用。
#[derive(Debug, Deserialize)]
struct ShaResponse {
    sha: String,
}

fn shape_error(message: String) -> GithubError {
    GithubError::Shape { message }
}

/// 读 ref 里的 commit sha。
fn parse_ref_sha(value: &Value) -> Result<String, GithubError> {
    let parsed: RefResponse = serde_json::from_value(value.clone())
        .map_err(|err| shape_error(format!("GitHub 的 ref 回包结构不对：{err}")))?;
    Ok(parsed.object.sha)
}

/// 远端树 → `(root tree sha, 快照, truncated)`。
///
/// 只收 `type == "blob"` 且 [`is_managed_path`] 的条目：目录、子模块、素材文件都不进
/// 同步集合。⚠️ 截断的树整份拒——拿半棵树比对会把没读到的文件当成「远端删了」。
fn parse_tree(value: &Value) -> Result<(String, Snapshot, bool), GithubError> {
    let parsed: TreeResponse = serde_json::from_value(value.clone())
        .map_err(|err| shape_error(format!("GitHub 的文件树回包结构不对：{err}")))?;
    if parsed.truncated {
        return Err(shape_error(
            "GitHub 说这个仓库的文件树太大、回包被截断了。Vela 不能拿半棵树做同步比对。".to_owned(),
        ));
    }
    let mut snapshot = Snapshot::new();
    for entry in parsed.tree {
        if entry.kind != "blob" || !is_managed_path(&entry.path) {
            continue;
        }
        snapshot.insert(entry.path, entry.sha);
    }
    Ok((parsed.sha, snapshot, parsed.truncated))
}

/// blob 回包里 base64 那一格 → 原始字节。
///
/// GitHub 会在 base64 里每 60 个字符插一个换行，`STANDARD` 解码器不吃空白；所以先
/// 把空白全部去掉再解。编码不是 `base64` 直接拒，⛔ 不猜别的编码。
fn parse_blob(value: &Value) -> Result<Vec<u8>, GithubError> {
    let parsed: BlobResponse = serde_json::from_value(value.clone())
        .map_err(|err| shape_error(format!("GitHub 的 blob 回包结构不对：{err}")))?;
    if parsed.encoding != "base64" {
        return Err(shape_error(format!("GitHub 的 blob 编码不是 base64：{}", parsed.encoding)));
    }
    let compact: String = parsed.content.split_whitespace().collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|err| shape_error(format!("GitHub 的 blob 内容解不开：{err}")))
}

/// 读创建类接口的 `sha`。
fn parse_created_sha(value: &Value, what: &str) -> Result<String, GithubError> {
    let parsed: ShaResponse = serde_json::from_value(value.clone())
        .map_err(|err| shape_error(format!("GitHub 的{what}回包结构不对：{err}")))?;
    Ok(parsed.sha)
}

/// `POST /git/trees` 的请求体。
///
/// 🔴 **`base_tree` 必填**：不带它（或写成 `null`）时，GitHub 会创建一棵**只含你点名的
/// 那几个文件**的树——推上去等于把仓库里其余文件在这一次提交里全删了。参数是 `&str`
/// 而不是 `Option`，于是「漏传」在类型层面就写不出来；这一条是本模块最重要的用例。
///
/// `mode` 固定 `100644`（普通文件）：同步集合里只有 `.md`，没有可执行位也没有子模块。
fn tree_request(base_tree: &str, entries: &[(String, String)]) -> Value {
    let tree: Vec<Value> = entries
        .iter()
        .map(|(path, sha)| {
            json!({
                "path": path,
                "mode": "100644",
                "type": "blob",
                "sha": sha,
            })
        })
        .collect();
    json!({ "base_tree": base_tree, "tree": tree })
}

/// `POST /git/commits` 的请求体。`parents` 只有一个（读快照时的 HEAD）。
/// `message` 只由调用方按「固定前缀 + 时间戳」拼，⛔ 不加别的可变内容（决定 2）。
fn commit_request(message: &str, tree: &str, parent: &str) -> Value {
    json!({ "message": message, "tree": tree, "parents": [parent] })
}

/// `PATCH /git/refs/heads/{branch}` 的请求体。
/// 🔴 `force: false` 是「⛔ 不 force push」的技术实现：非快进由服务端直接 422 拒掉。
fn ref_update_request(commit: &str) -> Value {
    json!({ "sha": commit, "force": false })
}

/// 冲突清单一句话，给 [`GithubError::Conflict`] 的 `message`。
fn describe_conflicts(conflicts: &[Conflict]) -> String {
    let mut shown: Vec<String> = conflicts
        .iter()
        .take(5)
        .map(|conflict| format!("{}（{}）", conflict.path, kind_label(conflict.kind)))
        .collect();
    if conflicts.len() > shown.len() {
        shown.push(format!("…另有 {} 个", conflicts.len() - shown.len()));
    }
    format!(
        "有 {} 个整理文件需要你决定，这次同步一个字节都没写：{}。处理完再点一次同步。",
        conflicts.len(),
        shown.join("；")
    )
}

fn conflict_views(conflicts: &[Conflict]) -> Vec<ConflictView> {
    conflicts
        .iter()
        .map(|conflict| ConflictView {
            path: conflict.path.clone(),
            base: conflict.base.clone(),
            local: conflict.local.clone(),
            remote: conflict.remote.clone(),
            kind: kind_name(conflict.kind).to_owned(),
        })
        .collect()
}

fn kind_name(kind: ConflictKind) -> &'static str {
    match kind {
        ConflictKind::BothChanged => "both_changed",
        ConflictKind::NoBase => "no_base",
        ConflictKind::LocalDeleted => "local_deleted",
        ConflictKind::RemoteDeleted => "remote_deleted",
    }
}

fn kind_label(kind: ConflictKind) -> &'static str {
    match kind {
        ConflictKind::BothChanged => "两边都改过",
        ConflictKind::NoBase => "没有上次同步记录、两边不同",
        ConflictKind::LocalDeleted => "本地删了、远端还在",
        ConflictKind::RemoteDeleted => "远端删了、本地还在",
    }
}

// ─── REST ────────────────────────────────────────────────────────────

/// 非 2xx 与网络失败分开：分支探测要把 404 当作「换下一个分支」，别的状态才是失败。
enum RestError {
    Fatal(GithubError),
    Status { status: u16, message: String },
}

/// 一次请求。`method` 与 `path` 只由 Rust 侧决定，⛔ 不接受 webview 输入。
async fn rest(method: reqwest::Method, path: &str, token: &str, body: Option<&Value>) -> Result<Value, RestError> {
    let client = crate::net::client()
        .map_err(|message| RestError::Fatal(GithubError::Network { reason: "ClientInit".to_owned(), message }))?;
    let mut request = client
        .request(method.clone(), format!("{API_BASE}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(body) = body {
        // `.json()` 要 reqwest 的 `json` feature，而我们的依赖刻意只有 `rustls-no-provider`。
        // `Value::to_string()` 对任何 Value 都不会失败，所以这一段没有错误分支
        request = request.header("Content-Type", "application/json").body(body.to_string());
    }
    let response = request.send().await.map_err(|err| RestError::Fatal(network_error(err)))?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(|err| RestError::Fatal(network_error(err)))?;
    let parsed = serde_json::from_slice::<Value>(&bytes).ok();
    if (200..300).contains(&status) {
        return parsed
            .ok_or_else(|| RestError::Fatal(shape_error(format!("{method} {path} 的回包不是 JSON（HTTP {status}）"))));
    }
    let detail =
        parsed.as_ref().and_then(|value| value.get("message")).and_then(Value::as_str).unwrap_or("回包不是 JSON");
    Err(RestError::Status { status, message: format!("{method} {path} HTTP {status}：{detail}") })
}

/// 把状态码翻成错误面。401/403 统一说「token 无效或没权限」，其余原样报 GitHub 的话。
fn status_error(err: RestError) -> GithubError {
    match err {
        RestError::Fatal(error) => error,
        RestError::Status { status: 401 | 403, message } => GithubError::Auth {
            message: format!("{message}。检查 token 是否有效、是否授权了这个仓库。"),
        },
        RestError::Status { message, .. } => GithubError::Api { message },
    }
}

/// 成功路径的快捷方式：状态码按 [`status_error`] 翻。
async fn rest_json(
    method: reqwest::Method,
    path: &str,
    token: &str,
    body: Option<&Value>,
) -> Result<Value, GithubError> {
    rest(method, path, token, body).await.map_err(status_error)
}

/// 传输层失败（DNS、连接、TLS、超时、读体）→ [`GithubError::Network`]。
///
/// 🔴 每一条都带 [`API_HOST`]，而且都不提 token：一次代理或 DNS 的失败与凭证无关。
/// PLAN ⑮ 有先例：本机代理按域名重置 TLS，境内/境外两条路经常一条通一条不通。
fn network_error(err: reqwest::Error) -> GithubError {
    let (reason, lead) = if err.is_timeout() {
        (
            "Timeout",
            format!("{} 秒内没等到 {API_HOST} 的回应。检查网络或代理后再试。", crate::net::REQUEST_TIMEOUT.as_secs()),
        )
    } else if err.is_connect() {
        ("Connect", format!("连不上 {API_HOST}。检查网络与代理设置。"))
    } else if err.is_body() {
        ("Body", format!("请求体没能发给 {API_HOST}。"))
    } else if err.is_decode() {
        ("Decode", format!("{API_HOST} 的响应读不完。"))
    } else {
        ("Other", format!("请求没能走到 {API_HOST}。"))
    };
    GithubError::Network { reason: reason.to_owned(), message: format!("{lead}（{err}）") }
}

/// 远端此刻的样子：HEAD commit、根 tree sha、解析出来的分支、整理文件快照。
struct RemoteHead {
    commit: String,
    tree: String,
    branch: String,
    snapshot: Snapshot,
}

/// 读 HEAD：`main` 404 就试 `master`，两个都 404 才报分支不存在。
async fn read_head(repo: &RepoSpec, token: &str) -> Result<(String, String), GithubError> {
    for branch in BRANCH_CANDIDATES {
        let path = repo.api(&format!("/git/ref/heads/{branch}"));
        match rest(reqwest::Method::GET, &path, token, None).await {
            Ok(value) => return Ok((parse_ref_sha(&value)?, branch.to_owned())),
            Err(RestError::Status { status: 404, .. }) => continue,
            Err(err) => return Err(status_error(err)),
        }
    }
    Err(GithubError::BranchNotFound {
        message: format!(
            "在 {} 里找不到 main 或 master 分支。确认仓库存在、token 有权访问，并且分支已经建好——Vela 不自动建分支。",
            repo.full()
        ),
    })
}

/// 读远端快照（ref → 全树）。
async fn read_remote(repo: &RepoSpec, token: &str) -> Result<RemoteHead, GithubError> {
    let (commit, branch) = read_head(repo, token).await?;
    let path = repo.api(&format!("/git/trees/{commit}?recursive=1"));
    let value = rest_json(reqwest::Method::GET, &path, token, None).await?;
    let (tree, snapshot, _truncated) = parse_tree(&value)?;
    Ok(RemoteHead { commit, tree, branch, snapshot })
}

/// 新建一个 blob，返回 GitHub 回报的 sha。
async fn create_blob(repo: &RepoSpec, token: &str, bytes: &[u8]) -> Result<String, GithubError> {
    let body = json!({
        "content": base64::engine::general_purpose::STANDARD.encode(bytes),
        "encoding": "base64",
    });
    let value = rest_json(reqwest::Method::POST, &repo.api("/git/blobs"), token, Some(&body)).await?;
    parse_created_sha(&value, " blob ")
}

/// 新建一棵树，返回新 tree sha。
async fn create_tree(
    repo: &RepoSpec,
    token: &str,
    base_tree: &str,
    entries: &[(String, String)],
) -> Result<String, GithubError> {
    let body = tree_request(base_tree, entries);
    let value = rest_json(reqwest::Method::POST, &repo.api("/git/trees"), token, Some(&body)).await?;
    parse_created_sha(&value, " tree ")
}

/// 新建一次提交，返回 commit sha。
async fn create_commit(
    repo: &RepoSpec,
    token: &str,
    message: &str,
    tree: &str,
    parent: &str,
) -> Result<String, GithubError> {
    let body = commit_request(message, tree, parent);
    let value = rest_json(reqwest::Method::POST, &repo.api("/git/commits"), token, Some(&body)).await?;
    parse_created_sha(&value, " commit ")
}

/// 更新分支 ref。`force: false`，非快进由服务端 422/409 拒掉。
async fn update_ref(repo: &RepoSpec, token: &str, branch: &str, commit: &str) -> Result<(), GithubError> {
    let path = repo.api(&format!("/git/refs/heads/{branch}"));
    let body = ref_update_request(commit);
    match rest(reqwest::Method::PATCH, &path, token, Some(&body)).await {
        Ok(_) => Ok(()),
        Err(RestError::Status { status: 422 | 409, message }) => Err(GithubError::NonFastForward {
            message: format!("{message}。远端在你读完之后又有了新提交，这次同步没有写入任何东西。"),
        }),
        Err(err) => Err(status_error(err)),
    }
}

// ─── 本地快照与写盘 ───────────────────────────────────────────────────

/// 扫配置目录，得到「整理文件 → blob sha」。
///
/// 🔴 只收 [`is_managed_path`]：素材文件不进版本库，也不进比对。软链整个跳过——
/// 跟随它就会把目录外面的内容推上去；`.git` 目录跳过（那不是用户的笔记）。
fn local_snapshot(root: &Path) -> Result<Snapshot, GithubError> {
    let mut snapshot = Snapshot::new();
    walk_local(root, root, &mut snapshot)?;
    Ok(snapshot)
}

fn walk_local(root: &Path, dir: &Path, snapshot: &mut Snapshot) -> Result<(), GithubError> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)
        .map_err(|err| GithubError::Storage { message: format!("读目录 {} 失败：{err}", dir.display()) })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| GithubError::Storage { message: format!("读目录 {} 失败：{err}", dir.display()) })?;
    // 固定顺序：失败时先报到哪一个文件名不随文件系统枚举顺序变
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|err| GithubError::Storage {
            message: format!("看 {} 的类型失败：{err}", path.display()),
        })?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if entry.file_name() == std::ffi::OsStr::new(".git") {
                continue;
            }
            walk_local(root, &path, snapshot)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = path.strip_prefix(root).ok().and_then(Path::to_str).ok_or_else(|| GithubError::Storage {
            message: format!("文件名不是 UTF-8，没法作为 GitHub 路径：{}", path.display()),
        })?;
        if !is_managed_path(relative) {
            continue;
        }
        let bytes = fs::read(&path)
            .map_err(|err| GithubError::Storage { message: format!("读 {} 失败：{err}", path.display()) })?;
        snapshot.insert(relative.to_owned(), blob_sha(&bytes));
    }
    Ok(())
}

/// 在配置目录根上维护 `.gitignore` 的那一行素材忽略。返回是否真的改过。
///
/// 只在**本地**维护、⛔ 不同步到远端（模块文档）。读不到文件才是失败：文件不存在
/// 是第一次同步的正常形状。
fn ensure_material_ignore(root: &Path) -> Result<bool, GithubError> {
    let path = root.join(GITIGNORE_FILE);
    let existing = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(GithubError::Storage { message: format!("读 {} 失败：{err}", path.display()) }),
    };
    let Some(updated) = with_material_ignore(&existing) else {
        return Ok(false);
    };
    write_bytes_atomic(&path, updated.as_bytes())
        .map_err(|err| GithubError::Storage { message: format!("写 {} 失败：{err}", path.display()) })?;
    Ok(true)
}

/// 把远端这一份写到本地。
///
/// 两道闸：路径本身过 [`safe_rel`]；拼上根之后把**父目录** canonicalize 再判前缀——
/// 软链与 `..` 都会在第二道现形。原子写（同目录 `.tmp` + rename）意味着目标若是一个
/// 软链，被替换的是软链本身，而不是它指向的文件。
fn write_pulled(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), GithubError> {
    let relative = safe_rel(relative).ok_or_else(|| GithubError::Directory {
        message: format!("远端给的路径不在配置目录内：{relative}"),
    })?;
    let target = root.join(relative);
    let parent = target.parent().ok_or_else(|| GithubError::Directory {
        message: format!("远端给的路径没有目录部分：{relative}"),
    })?;
    fs::create_dir_all(parent)
        .map_err(|err| GithubError::Storage { message: format!("建不出 {}：{err}", parent.display()) })?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|err| GithubError::Storage { message: format!("打不开 {}：{err}", parent.display()) })?;
    if !canonical_parent.starts_with(root) {
        return Err(GithubError::Directory {
            message: format!("远端给的路径经软链跑出了配置目录：{relative} → {}", canonical_parent.display()),
        });
    }
    write_bytes_atomic(&target, bytes)
        .map_err(|err| GithubError::Storage { message: format!("写 {} 失败：{err}", target.display()) })
}

/// 推之前再读一遍本地文件，并确认它还是快照里那一份。
///
/// 用户可能在这几秒里改了文件；拿新内容推上去、却把旧 sha 记进 base，下一次比对
/// 就会把这份改动当成「远端改的、本地没动」。所以这里对不上就停在这一次。
fn read_for_push(root: &Path, relative: &str, expected: &str) -> Result<Vec<u8>, GithubError> {
    let relative = safe_rel(relative).ok_or_else(|| GithubError::Directory {
        message: format!("本地快照里的路径不在配置目录内：{relative}"),
    })?;
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|err| GithubError::Storage { message: format!("看 {} 失败：{err}", path.display()) })?;
    if metadata.file_type().is_symlink() {
        return Err(GithubError::LocalChanged {
            message: format!("{relative} 在同步过程中变成了软链，这次同步已停。再点一次同步。"),
        });
    }
    let bytes = fs::read(&path)
        .map_err(|err| GithubError::Storage { message: format!("读 {} 失败：{err}", path.display()) })?;
    if blob_sha(&bytes) != expected {
        return Err(GithubError::LocalChanged {
            message: format!("{relative} 在同步过程中被改动了，这次同步已停。再点一次同步。"),
        });
    }
    Ok(bytes)
}

// ─── 一次同步 ─────────────────────────────────────────────────────────

fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

/// `~/.vela/sync-state.json`。⛔ 不放进被同步的目录（PLAN ⑭）。
fn state_path(home: &Path) -> PathBuf {
    home.join(VELA_DIR_NAME).join(STATE_FILE_NAME)
}

fn emit_progress(app: &AppHandle, task_id: &str, progress: GithubProgress) {
    let payload = ProgressPayload { task_id: task_id.to_owned(), progress };
    if let Err(err) = app.emit(crate::GITHUB_PROGRESS, payload) {
        eprintln!("[vela] GitHub 同步的进度事件没能发出去：{err}");
    }
}

/// 一次同步要用的全部长期引用。打成一包是为了让 [`run_github_sync`] 的签名不膨胀成
/// 八个参数（clippy 的上限是七个），取消标志单独走。
#[derive(Clone, Copy)]
struct SyncJob<'a> {
    root: &'a Path,
    repo: &'a RepoSpec,
    token: &'a str,
    state_file: &'a Path,
    task_id: &'a str,
    app: &'a AppHandle,
    started: Instant,
}

/// 一次同步的正文：读两边 → 比对 → 拉 → 推 → 落 state。
///
/// 顺序是硬的（PLAN ⑤）：**先把远端读下来比完再写盘**，state 最后写。冲突在写任何
/// 文件之前就返回；取消只会在文件之间发生，已经写完的留在盘上。
async fn run_github_sync(job: SyncJob<'_>, cancel: &AtomicBool) -> Result<GithubSummary, GithubError> {
    let SyncJob { root, repo, token, state_file, task_id, app, started } = job;
    let mut summary = GithubSummary::default();

    if is_cancelled(cancel) {
        summary.cancelled = true;
        summary.elapsed_ms = elapsed_ms(started);
        return Ok(summary);
    }

    let local = local_snapshot(root)?;
    if is_cancelled(cancel) {
        summary.cancelled = true;
        summary.elapsed_ms = elapsed_ms(started);
        return Ok(summary);
    }

    let remote = read_remote(repo, token).await?;
    let base = load_state(state_file).base_for(&repo.full(), &remote.branch);
    let plan =
        compare(&base, &local, &remote.snapshot).map_err(|err| GithubError::Directory { message: err.to_string() })?;

    // 🔴 四条必须停里的「双边改动」：一个字节都不写，state 也不动
    if plan.has_conflicts() {
        return Err(GithubError::Conflict {
            message: describe_conflicts(&plan.conflicts),
            conflicts: conflict_views(&plan.conflicts),
        });
    }

    let total = plan.action_count();
    emit_progress(app, task_id, GithubProgress { files_done: 0, files_total: total });
    let mut done = 0usize;

    // 冲突之后才维护它：冲突那一句说「一个字节都没写」，必须是真的。
    // 在写回远端文件之前补上，防的是用户自己在这个目录里 `git add .` 把划线原文收走
    ensure_material_ignore(root)?;

    // ① 拉：只拉真正要写回本地的那些 blob
    for action in &plan.pull {
        if is_cancelled(cancel) {
            summary.cancelled = true;
            summary.elapsed_ms = elapsed_ms(started);
            return Ok(summary);
        }
        let path = repo.api(&format!("/git/blobs/{}", action.sha));
        let value = rest_json(reqwest::Method::GET, &path, token, None).await?;
        let bytes = parse_blob(&value)?;
        // 内容寻址的自检：代理/中间人换过内容的话，这里必须响
        if blob_sha(&bytes) != action.sha {
            return Err(shape_error(format!("远端 blob {} 的内容与它的 sha 对不上", action.sha)));
        }
        write_pulled(root, &action.path, &bytes)?;
        summary.pulled += 1;
        done += 1;
        emit_progress(app, task_id, GithubProgress { files_done: done, files_total: total });
    }

    // ② 推：每个文件一个 blob，攒齐之后一次 tree + 一次 commit + 一次 ref
    let mut created: Vec<(String, String)> = Vec::new();
    for action in &plan.push {
        if is_cancelled(cancel) {
            summary.cancelled = true;
            summary.elapsed_ms = elapsed_ms(started);
            return Ok(summary);
        }
        let bytes = read_for_push(root, &action.path, &action.sha)?;
        let sha = create_blob(repo, token, &bytes).await?;
        if sha != action.sha {
            return Err(shape_error(format!(
                "GitHub 回报的 blob sha 与本地算出来的不一致：{}（本地 {}，远端 {sha}）",
                action.path, action.sha
            )));
        }
        created.push((action.path.clone(), sha));
        summary.pushed += 1;
        done += 1;
        emit_progress(app, task_id, GithubProgress { files_done: done, files_total: total });
    }

    if !created.is_empty() {
        if is_cancelled(cancel) {
            // 已经建好的 blob 是悬空的（GitHub 会回收），ref 没动、state 也不动
            summary.cancelled = true;
            summary.elapsed_ms = elapsed_ms(started);
            return Ok(summary);
        }
        let tree = create_tree(repo, token, &remote.tree, &created).await?;
        let message = format!("Vela 同步 {}", stamp_of(now_unix()));
        let commit = create_commit(repo, token, &message, &tree, &remote.commit).await?;
        update_ref(repo, token, &remote.branch, &commit).await?;
    }

    // ③ 整份计划做完才前移 base。写失败不算同步失败：下次退回「无 base」的保守分支
    if let Some(base) = plan.next_base {
        let mut state = load_state(state_file);
        state.record(&repo.full(), &remote.branch, base);
        match save_state(state_file, &state) {
            Ok(()) => summary.state_saved = true,
            Err(err) => eprintln!("[vela] GitHub 同步的状态没能落盘（下次走无 base）：{err}"),
        }
    }

    summary.elapsed_ms = elapsed_ms(started);
    Ok(summary)
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs() as i64).unwrap_or(0)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

// ─── 命令 ────────────────────────────────────────────────────────────

/// 读钥匙串里那把 token。三态与 [`secrets::load`] 一致：
/// `Ok(None)` = 没配过，`Err` = 配了但用不了 / 这个平台没有钥匙串。
fn load_token() -> Result<Option<String>, SecretError> {
    secrets::load(SERVICE, ACCOUNT)
}

/// 写 token。⛔ 没有配对的读，理由见模块文档那条 🔴。
///
/// 与 `secrets.rs` / `weread.rs` 那几条同一个姿势：`async fn` 而函数体里一个 `.await`
/// 都没有——同步 command 跑在主线程上会冻住界面，而 `SecItem*` 是毫秒级的系统调用。
/// 空输入由 [`secrets::store`] 里的 `clean` 在碰钥匙串**之前**挡掉。
#[command]
pub async fn set_github_token(token: String) -> Result<(), SecretError> {
    secrets::store(SERVICE, ACCOUNT, &token)
}

/// 删 token（面板上「清除」那一个按钮）。不存在也算成功。
#[command]
pub async fn delete_github_token() -> Result<(), SecretError> {
    secrets::clear(SERVICE, ACCOUNT)
}

/// 只回「配没配」。
///
/// ⚠️ 读失败原样报出去而不是退化成 `configured: false`，理由与 `oss_secret_status` 相同：
/// 「没有这一项」与「有一项但读不出来」是两句不同的话。
#[command]
pub async fn github_token_status() -> Result<SecretStatus, SecretError> {
    Ok(SecretStatus { configured: load_token()?.is_some() })
}

/// 同步一次配置目录（M8-8），**立刻**返回 `taskId`。
///
/// 进度走 `vela://github-progress`，终止走 `vela://github-done` / `vela://github-failed`，
/// 取消复用同一份 [`TaskRegistry`]（`cancel_task` 是唯一的刹车）。
///
/// `dir` 是侧栏里那个根的原样字符串，**只用来核对**：真正读写的是用户全局配置里的
/// `syncLocalDir`，两者 canonicalize 之后必须相等。仓库地址与 token 同理，都不过 IPC。
#[command]
pub async fn github_sync_dir(
    app: AppHandle,
    tasks: State<'_, TaskRegistry>,
    dir: String,
) -> Result<String, GithubError> {
    // 预检全在命令线程上做完，规矩与 weread_sync_dir 相同：
    // reject = 这次同步压根没开始；拿到 taskId = 一定会收到 done 或 failed。
    let home = crate::commands::home_dir(&app).map_err(|err| GithubError::Directory { message: err.to_string() })?;
    let loaded = settings::load(&home, None).settings;
    let root = crate::commands::resolve_configured_dir(
        &loaded.sync_local_dir,
        Path::new(&dir),
        "设置里的文件同步目录",
        "当前打开的目录",
        DIR_NOT_CONFIGURED,
    )
    .map_err(|message| GithubError::Directory { message })?;
    let repo = RepoSpec::parse(&loaded.github_repo)?;
    let token = load_token()
        .map_err(|err| GithubError::Keychain { message: err.message().to_owned() })?
        .ok_or_else(|| GithubError::NotConfigured { message: NOT_CONFIGURED.to_owned() })?;

    let state_file = state_path(&home);
    let (task_id, cancel) = tasks.register("github");
    let started = Instant::now();

    let emitter = app.clone();
    let final_task_id = task_id.clone();
    // 主成本是等网络，用 spawn 而不是 spawn_blocking（与 weread 同一条理由）
    tauri::async_runtime::spawn(async move {
        let outcome = run_github_sync(
            SyncJob {
                root: &root,
                repo: &repo,
                token: &token,
                state_file: &state_file,
                task_id: &final_task_id,
                app: &emitter,
                started,
            },
            &cancel,
        )
        .await;

        // 先摘注册表再发终止事件（与 start_search 同序）
        emitter.state::<TaskRegistry>().forget(&final_task_id);

        let sent = match outcome {
            Ok(summary) => emitter.emit(crate::GITHUB_DONE, DonePayload { task_id: final_task_id, summary }),
            Err(error) => emitter.emit(crate::GITHUB_FAILED, FailedPayload { task_id: final_task_id, error }),
        };
        if let Err(err) = sent {
            eprintln!("[vela] GitHub 同步的终止事件没能发出去：{err}");
        }
    });

    Ok(task_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN: &str = "ghp_SECRET-TOKEN-DO-NOT-LEAK";

    // ─── 仓库地址 ──────────────────────────────────────────────────

    #[test]
    fn 仓库地址两种写法都能解析() {
        for raw in [
            "owner/repo",
            "  owner/repo  ",
            "owner/repo/",
            "https://github.com/owner/repo",
            "https://github.com/owner/repo/",
            "https://github.com/owner/repo.git",
            "http://github.com/owner/repo.git/",
            "github.com/owner/repo",
            "My-Org/my.repo_name-2",
        ] {
            let parsed = RepoSpec::parse(raw).unwrap_or_else(|err| panic!("{raw}: {err:?}"));
            assert_eq!(
                parsed.full(),
                if raw.contains("My-Org") { "My-Org/my.repo_name-2" } else { "owner/repo" },
                "{raw}"
            );
        }
    }

    #[test]
    fn 仓库地址的歪写法一律拒() {
        for raw in [
            "owner",
            "owner//repo",
            "owner/repo/extra",
            "https://gitlab.com/owner/repo",
            "owner/repo?tab=readme",
            "owner/repo#readme",
            "own er/repo",
            "owner/re po",
            "owner/..",
            "./repo",
            "owner/r%20repo",
        ] {
            assert!(matches!(RepoSpec::parse(raw), Err(GithubError::Repo { .. })), "{raw}");
        }
        assert!(matches!(RepoSpec::parse("  "), Err(GithubError::NotConfigured { .. })));
    }

    #[test]
    fn 分支候选只有_main_和_master() {
        // ⛔ 不加第 7 条「查默认分支」的调用；这两个名字是唯一的候选
        assert_eq!(BRANCH_CANDIDATES, ["main", "master"]);
    }

    #[test]
    fn 请求地址只有_api_github_com_那一个() {
        // 文案里的域名必须就是我们真的会打的那个（与 weread 那条同一个理由）
        assert!(API_BASE.starts_with(&format!("https://{API_HOST}")), "{API_BASE}");
        let path = RepoSpec::parse("owner/repo").unwrap().api("/git/ref/heads/main");
        assert_eq!(path, "/repos/owner/repo/git/ref/heads/main");
    }

    // ─── 请求体：base_tree / parents / force ───────────────────────

    #[test]
    fn 建树请求必须带_base_tree_否则会删掉仓库里别的文件() {
        // 🔴 本模块最重要的用例：`base_tree` 缺失时 GitHub 只会建一棵只含点名文件的树，
        // 推上去等于在这一次提交里把仓库其余文件全删了
        let entries = vec![("a.md".to_owned(), "sha-a".to_owned()), ("子目录/b.md".to_owned(), "sha-b".to_owned())];
        let body = tree_request("head-tree-sha", &entries);
        assert_eq!(body["base_tree"], json!("head-tree-sha"));
        let tree = body["tree"].as_array().unwrap();
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0]["path"], json!("a.md"));
        assert_eq!(tree[0]["mode"], json!("100644"));
        assert_eq!(tree[0]["type"], json!("blob"));
        assert_eq!(tree[0]["sha"], json!("sha-a"));
        assert_eq!(tree[1]["path"], json!("子目录/b.md"));
        // 序列化出来也必须是那个键，不是 null / 缺失
        let text = serde_json::to_string(&body).unwrap();
        assert!(text.contains(r#""base_tree":"head-tree-sha""#), "{text}");
    }

    #[test]
    fn 提交只有一个_parent_且信息只有固定前缀加时间戳() {
        let body = commit_request("Vela 同步 2025-02-19 21:20", "new-tree", "head-commit");
        assert_eq!(body["tree"], json!("new-tree"));
        assert_eq!(body["parents"], json!(["head-commit"]));
        assert_eq!(body["message"], json!("Vela 同步 2025-02-19 21:20"));
    }

    #[test]
    fn 更新_ref_永远不带_force() {
        let body = ref_update_request("new-commit");
        assert_eq!(body["sha"], json!("new-commit"));
        assert_eq!(body["force"], json!(false));
    }

    // ─── 回包：树 / blob / ref ─────────────────────────────────────

    #[test]
    fn 远端树只收_blob_且只收整理文件() {
        let value = json!({
            "sha": "root-tree",
            "truncated": false,
            "tree": [
                {"path": "笔记.md", "type": "blob", "sha": "a"},
                {"path": "子目录/第二章.MARKDOWN", "type": "blob", "sha": "b"},
                {"path": "某人 - 某书·划线素材.md", "type": "blob", "sha": "c"},
                {"path": "图.png", "type": "blob", "sha": "d"},
                {"path": "子目录", "type": "tree", "sha": "e"},
                {"path": "vendor", "type": "commit", "sha": "f"},
                {"path": ".gitignore", "type": "blob", "sha": "g"}
            ]
        });
        let (tree, snapshot, truncated) = parse_tree(&value).unwrap();
        assert_eq!(tree, "root-tree");
        assert!(!truncated);
        let expected: Snapshot =
            [("子目录/第二章.MARKDOWN".to_owned(), "b".to_owned()), ("笔记.md".to_owned(), "a".to_owned())]
                .into_iter()
                .collect();
        assert_eq!(snapshot, expected);
    }

    #[test]
    fn 截断的树整份拒() {
        let value = json!({"sha": "root-tree", "truncated": true, "tree": [
            {"path": "笔记.md", "type": "blob", "sha": "a"}
        ]});
        assert!(matches!(parse_tree(&value), Err(GithubError::Shape { .. })));
    }

    #[test]
    fn ref_与_blob_回包按各自形状解析() {
        assert_eq!(parse_ref_sha(&json!({"object": {"sha": "head"}})).unwrap(), "head");
        // GitHub 的 base64 每 60 个字符插一个换行
        let blob = parse_blob(&json!({"content": "aGVs\nbG8=\n", "encoding": "base64"})).unwrap();
        assert_eq!(blob, b"hello");
        assert!(matches!(
            parse_blob(&json!({"content": "aGVsbG8=", "encoding": "utf-8"})),
            Err(GithubError::Shape { .. })
        ));
    }

    // ─── 本地快照 ──────────────────────────────────────────────────

    #[test]
    fn 本地快照只收整理文件且_sha_是_git_blob_id() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("笔记.md"), "hello\n").unwrap();
        fs::write(dir.path().join("素材 - 某书·划线素材.md"), "原文").unwrap();
        fs::write(dir.path().join("图.png"), b"\x89PNG").unwrap();
        fs::create_dir_all(dir.path().join("子目录")).unwrap();
        fs::write(dir.path().join("子目录/下.md"), "b").unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/hidden.md"), "x").unwrap();

        let snapshot = local_snapshot(dir.path()).unwrap();
        assert_eq!(snapshot.keys().cloned().collect::<Vec<_>>(), vec!["子目录/下.md".to_owned(), "笔记.md".to_owned()]);
        // 与 `git hash-object` 的黄金值逐字相同（`sync/blob.rs` 那一组）
        assert_eq!(snapshot["笔记.md"], "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_eq!(snapshot["子目录/下.md"], blob_sha(b"b"));
    }

    #[cfg(unix)]
    #[test]
    fn 本地快照跳过软链() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.md"), "x").unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path().join("outside.md"), dir.path().join("link.md")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linkdir")).unwrap();
        fs::write(dir.path().join("real.md"), "r").unwrap();

        let snapshot = local_snapshot(dir.path()).unwrap();
        assert_eq!(snapshot.keys().cloned().collect::<Vec<_>>(), vec!["real.md".to_owned()]);
    }

    // ─── 写盘闸门与 .gitignore ─────────────────────────────────────

    #[test]
    fn 拉取写盘建目录且写对内容() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        write_pulled(&root, "子目录/一层/笔记.md", "正文".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(root.join("子目录/一层/笔记.md")).unwrap(), "正文");
        // 清理临时文件之后目录里只剩那一份
        let names: Vec<String> = fs::read_dir(root.join("子目录/一层"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["笔记.md".to_owned()]);
    }

    #[cfg(unix)]
    #[test]
    fn 拉取路径经软链跑出根就拒() {
        let outside = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        std::os::unix::fs::symlink(fs::canonicalize(outside.path()).unwrap(), root.join("escape")).unwrap();

        let err = write_pulled(&root, "escape/偷渡.md", b"x").unwrap_err();
        assert!(matches!(err, GithubError::Directory { .. }), "{err:?}");
        assert!(!outside.path().join("偷渡.md").exists());
    }

    #[test]
    fn 拉取路径本身不干净就拒() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        for bad in ["../x.md", "/etc/passwd", "a/../../b.md", "a\\b.md"] {
            assert!(matches!(write_pulled(&root, bad, b"x"), Err(GithubError::Directory { .. })));
        }
    }

    #[test]
    fn 推之前本地变了就停() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("a.md"), "old").unwrap();
        let expected = blob_sha(b"old");
        // 还没变：读得出
        assert_eq!(read_for_push(&root, "a.md", &expected).unwrap(), b"old");
        // 变了：停
        fs::write(root.join("a.md"), "new").unwrap();
        assert!(matches!(read_for_push(&root, "a.md", &expected), Err(GithubError::LocalChanged { .. })));
    }

    #[test]
    fn gitignore_只补一次且保留用户自己的规则() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(GITIGNORE_FILE), "node_modules/\n").unwrap();
        assert!(ensure_material_ignore(dir.path()).unwrap());
        let first = fs::read_to_string(dir.path().join(GITIGNORE_FILE)).unwrap();
        assert_eq!(first, "node_modules/\n*·划线素材.md\n");
        // 第二次一个字都不改
        assert!(!ensure_material_ignore(dir.path()).unwrap());
        assert_eq!(fs::read_to_string(dir.path().join(GITIGNORE_FILE)).unwrap(), first);
    }

    #[test]
    fn 空目录第一次同步才建_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure_material_ignore(dir.path()).unwrap());
        assert_eq!(fs::read_to_string(dir.path().join(GITIGNORE_FILE)).unwrap(), "*·划线素材.md\n");
    }

    // ─── 冲突文案 / 错误面 ────────────────────────────────────────

    #[test]
    fn 冲突清单把三边的_sha_都给出来() {
        let conflict = Conflict {
            path: "a.md".to_owned(),
            base: Some("1".to_owned()),
            local: Some("2".to_owned()),
            remote: Some("3".to_owned()),
            kind: ConflictKind::BothChanged,
        };
        let error = GithubError::Conflict {
            message: describe_conflicts(std::slice::from_ref(&conflict)),
            conflicts: conflict_views(std::slice::from_ref(&conflict)),
        };
        let text = serde_json::to_string(&error).unwrap();
        assert!(text.contains(r#""kind":"conflict""#), "{text}");
        assert!(text.contains(r#""kind":"both_changed""#), "{text}");
        assert!(text.contains(r#""base":"1""#), "{text}");
        assert!(text.contains(r#""local":"2""#), "{text}");
        assert!(text.contains(r#""remote":"3""#), "{text}");
        assert!(text.contains("一个字节都没写"), "{text}");
        // 前端 `src/github/ipc.test.ts` 的金色字面量与这一条逐字节相同
        assert_eq!(
            text,
            r#"{"kind":"conflict","message":"有 1 个整理文件需要你决定，这次同步一个字节都没写：a.md（两边都改过）。处理完再点一次同步。","conflicts":[{"path":"a.md","base":"1","local":"2","remote":"3","kind":"both_changed"}]}"#
        );
    }

    #[test]
    fn 五种一边删一边改的说法各自一句人话() {
        assert_eq!(kind_name(ConflictKind::NoBase), "no_base");
        assert_eq!(kind_label(ConflictKind::LocalDeleted), "本地删了、远端还在");
        assert_eq!(kind_label(ConflictKind::RemoteDeleted), "远端删了、本地还在");
    }

    /// 三个事件信封的**逐字节**形状。前端 `src/github/ipc.test.ts` 里有一份同样的
    /// 黄金字面量；字段名漂了的失败方式与搜索那边同一条：Tauri 不校验 payload，
    /// 前端只是收到一堆 `undefined`，界面上停在「同步中… 0/0」。
    #[test]
    fn 进度与终止事件的_json_形状被钉住() {
        let progress = ProgressPayload {
            task_id: "github-0".to_owned(),
            progress: GithubProgress { files_done: 2, files_total: 7 },
        };
        assert_eq!(
            serde_json::to_string(&progress).unwrap(),
            r#"{"taskId":"github-0","progress":{"filesDone":2,"filesTotal":7}}"#
        );

        let done = DonePayload {
            task_id: "github-0".to_owned(),
            summary: GithubSummary { pulled: 1, pushed: 2, cancelled: false, state_saved: true, elapsed_ms: 1234 },
        };
        assert_eq!(
            serde_json::to_string(&done).unwrap(),
            r#"{"taskId":"github-0","summary":{"pulled":1,"pushed":2,"cancelled":false,"stateSaved":true,"elapsedMs":1234}}"#
        );

        let failed = FailedPayload {
            task_id: "github-0".to_owned(),
            error: GithubError::Directory { message: "配置与打开的目录不一致".to_owned() },
        };
        assert_eq!(
            serde_json::to_string(&failed).unwrap(),
            r#"{"taskId":"github-0","error":{"kind":"directory","message":"配置与打开的目录不一致"}}"#
        );
    }

    #[test]
    fn 错误_json_形状被钉住且任何一句都不带_token() {
        let errors = [
            GithubError::NotConfigured { message: NOT_CONFIGURED.to_owned() },
            GithubError::Repo { message: "仓库地址看不懂".to_owned() },
            GithubError::Auth { message: "GET /repos/o/r/git/ref/heads/main HTTP 401：Bad credentials".to_owned() },
            GithubError::NonFastForward { message: "HTTP 422".to_owned() },
            GithubError::Api { message: "HTTP 500".to_owned() },
            GithubError::Shape { message: "tree".to_owned() },
            GithubError::LocalChanged { message: "a.md".to_owned() },
            GithubError::Storage { message: "io".to_owned() },
        ];
        for (error, kind) in errors.iter().zip([
            "not_configured",
            "repo",
            "auth",
            "non_fast_forward",
            "api",
            "shape",
            "local_changed",
            "storage",
        ]) {
            let text = serde_json::to_string(error).unwrap();
            assert!(text.contains(&format!(r#""kind":"{kind}""#)), "{text}");
            assert!(!text.contains(TOKEN), "{text}");
            assert!(!format!("{error:?}").contains(TOKEN));
        }
    }

    #[test]
    fn 状态文件落在_vela_目录() {
        assert_eq!(state_path(Path::new("/Users/someone")), PathBuf::from("/Users/someone/.vela/sync-state.json"));
    }

    // ─── 钥匙串 ───────────────────────────────────────────────────

    #[test]
    fn 钥匙串槽位被钉住() {
        // 改这两个字符串等于让所有已配置的用户在升级后看到「未配置」
        assert_eq!(SERVICE, "app.vela.github");
        assert_eq!(ACCOUNT, "token");
    }

    #[test]
    fn 与另外两把凭证不共用槽() {
        // 同一个 service/account 放两把凭证，将来任何一次「按 service 清一遍」都会连坐
        assert_ne!(SERVICE, crate::secrets::SERVICE);
        assert_ne!(SERVICE, crate::weread::SERVICE);
        assert_ne!(ACCOUNT, crate::secrets::ACCOUNT);
        assert_ne!(ACCOUNT, crate::weread::ACCOUNT);
    }
}
