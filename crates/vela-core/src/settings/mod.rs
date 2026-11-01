//! 分层配置（PLAN.md §3.6 M4「项目级配置」）：**内置默认 → 用户全局 → 项目级**，三层合并。
//!
//! ## 三层分别住哪、谁说了算
//!
//! - **内置默认**：本文件的 `Default for Settings`。最底层，永远存在，不落盘。
//! - **用户全局**：`~/.vela/settings.json`。跟着**人**走，换项目也在。
//! - **项目级**：`<root>/.vela/settings.json`。跟着**仓库**走，可以提交进 git 与同事共享。
//!   多根工作区下只认**第一个根**（`roots[0]`）——用户裁定见 PLAN §3.6「M4-A 实施修正」。
//!
//! 合并顺序是「后一层盖前一层」，但 🔴 **不是每一层都能写每一个键**，见下面「可写层」。
//!
//! ## 🔴「哪一层能改哪些键」：十个键**全都**只认用户全局
//!
//! 用户裁定：字号 / 正文字体 / 代码字体 / 行高 / 字间距 / 主题是**个人偏好**，只认「内置默认 + 用户全局」两层。
//! 打开一个带 `.vela/settings.json` 的仓库**不会**突然改掉你的字号——那样太突兀，
//! 而且一个克隆来的仓库不该有这种权力（它连你的磁盘都能碰到，见 `commands.rs` 的信任面那张表）。
//!
//! M7-5 加进来的四格 OSS 配置（`ossBucket` / `ossRegion` / `ossAccessKeyId` / `ossPrefix`）
//! **不是**偏好类，却落在同一扇门后面，动机换成更硬的一条：仓库若能改这四格，它就能把你
//! 粘贴的图**改道到别人的 bucket**。签名在 Rust 侧算、`Authorization` 里带着我们的 AccessKey ID，
//! 改道至少泄露一次派生签名。于是「项目层写了也忽略」这一条对两种动机都成立，
//! 记账也共用同一个 [`SettingsReport::ignored_project_keys`]。
//!
//! ⚠️ 这意味着 v1 的项目层是**接好线但空转**的——它要等第一个 project-safe 键进来才真的有
//! 东西可配（`resolve` 里那条分支就是给它留的）。这道门现在就搭好、现在就测，
//! 免得到时候临时加、加错。
//!
//! ## 与 `session` 的存储为什么分开放
//!
//! 会话存档住在 `app_data_dir()`（`~/Library/Application Support/<bundle>/session.json`），
//! 而用户全局配置住在 `~/.vela/settings.json`——两者不一致，是**有意**的：
//! session 是应用自己管理的**现场快照**（上次开着哪些文档），用户没有理由去手改它；
//! settings 与将来的 `~/.vela/themes/`（M4 主题系统）是**用户会亲手编辑**的 dotfile，
//! 放在 `~/.vela/` 下与主题做邻居，符合 Unix 习惯，也让用户找得到。
//!
//! ## 韧性：一层坏掉不等于启动失败
//!
//! 与 `session`「版本号不认识就整份作废」的严格相反，配置走**宽松**路线：
//! 某一层文件不是合法 JSON、类型不对、或超过 [`MAX_SETTINGS_BYTES`]，都只让**那一层**
//! 退化成「没有配置」（[`LayerStatus::Corrupt`]），其余层照常合并，应用照常启动。
//! 理由：配置是**偏好**，读不回来最坏是「用默认字号」，不值得为它拦下整个启动；
//! 而会话读不回来是「上次的未保存草稿可能没了」，两者的严重性差一档。
//! 未知键一律**忽略**（不是 `deny_unknown_fields`）：新版本写下的键不该让旧版本读不动整份文件。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fs::{write_bytes_atomic, WriteError};

/// 用户全局配置与项目级配置共用的目录名：`~/.vela/` 与 `<root>/.vela/`。
pub const VELA_DIR_NAME: &str = ".vela";

/// 配置文件名。用户全局与项目级同名，只是所在目录不同。
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// 单层配置文件的大小上限。
///
/// 配置本该是几百字节的 JSON。设这道闸是为了「一个克隆来的仓库塞一个 2GB 的
/// `.vela/settings.json`」不会在读取时把内存咬掉一口——项目层是**不可信输入**
/// （与 `Session.recentProjects` 同一档：磁盘上读回来的、可能被手改过的东西）。
/// 超限就当这一层损坏，退化成默认值。
pub const MAX_SETTINGS_BYTES: usize = 64 * 1024;

/// 内置默认字号。与前端 `src/App.tsx` 的 `DEFAULT_FONT_SIZE` 同值——
/// 两边各写一份、由 `wire_contract.rs` 与 `src/ipc/settings.test.ts` 各钉一条，
/// 没有代码生成（与 `MAX_SESSION_TABS` 同一套做法）。
pub const DEFAULT_FONT_SIZE: u32 = 14;

/// 内置默认正文字体 ID。与前端 `src/fonts/loader.ts` 的 `DEFAULT_VARIANT` 同值，同上一条的钉法。
///
/// ⚠️ Rust 这边只当它是**不透明字符串**：合法 ID 的清单（`FontVariantId`）住在前端，
/// 因为只有前端有字体注册表。Rust 不校验它，前端读到不认识的 ID 自己回退默认。
pub const DEFAULT_FONT_VARIANT: &str = "screen-gb";

/// 内置默认代码区字体 ID。与前端 `src/fonts/loader.ts` 的 `DEFAULT_CODE_FONT` 同值。
pub const DEFAULT_CODE_FONT: &str = "maple-cn";

/// 内置默认行高（无单位倍数）。与前端 `src/settings/store.ts` 的 `DEFAULT_LINE_HEIGHT` 同值，
/// 两边各写一份、各钉一条（同 `DEFAULT_FONT_SIZE` 的做法）。
///
/// ⚠️ Rust 不夹范围：合法区间（前端 `LINE_HEIGHT_MIN..=LINE_HEIGHT_MAX`）是 UI 概念，
/// 夹一次就够，归前端。`1.75` 与 `styles.css` 里 `--vela-line-height` 的初值同值，
/// 于是「没存过配置」与「这一轮之前」渲染逐像素一致。
pub const DEFAULT_LINE_HEIGHT: f64 = 1.75;

/// 内置默认字间距（em）。`0.0` = 不额外加间距，对应 CSS 的 `letter-spacing: normal`。
///
/// ⚠️ 前端把 `0` 翻译成 `normal` 而不是 `0em`：默认值下编辑器一个像素都不该动，
/// 而 `normal` 与「压根没声明 letter-spacing」是同一件事，`0em` 严格说是另一回事
/// （`normal` 允许字体自带的字距调整）。区间与步进同样是 UI 概念，归前端夹。
pub const DEFAULT_LETTER_SPACING: f64 = 0.0;

/// 内置默认主题（M4-C）。与前端 `src/settings/theme.ts` 的 `DEFAULT_THEME` 同值，
/// 两边各写一份、各钉一条（同 `DEFAULT_FONT_SIZE` 的做法）。
///
/// ⚠️ Rust 这边只当它是**不透明字符串**：合法 ID 清单（`'light' | 'dark' | 'system'`）
/// 住在前端，Rust 不校验，前端读到不认识的串自己回退默认（`sanitizeThemeId`）。
///
/// 🔴 默认是 `'dark'` 而不是 `'system'`：M4-C 之前应用**只有暗色**，默认暗色保证老用户
/// 升级后逐像素不变。选 `'system'` 会让「系统是亮色」的用户一升级就突然变亮——那是
/// 一次没人要求的改动。想要跟随系统的用户自己选。
pub const DEFAULT_THEME: &str = "dark";

/// 内置默认的 OSS 对象名前缀：`assets`。
///
/// 与本地那一份的落地目录同名（[`crate::fs::asset::ASSET_DIR`]），于是一篇文章的图在
/// 本地镜像里叫 `assets/pasted-<hash>.png`、在 bucket 里叫 `assets/<hash>.png`，
/// 人在 bucket 管理器里看见的层级与在磁盘上看见的是同一层。
///
/// 留一个可改的默认值而不是写死：一个 bucket 常常服务多个用途（站点图、附件、备份），
/// 用户要的是「Vela 传的图都在我自己那一个前缀下」，这只需要改这一格。
pub const DEFAULT_OSS_PREFIX: &str = "assets";

/// 合并之后的**最终配置**：每个键都是具体值，没有 `Option`。
///
/// 这是 `load` 交出去、`save` 收进来的形状。前端拿到它直接往信号里灌，
/// 不需要再处理「这个键有没有值」——所有缺口都已经被下面两层填上了。
///
/// ⚠️ 只派生 `PartialEq` 不派生 `Eq`：`line_height` / `letter_spacing` 是 `f64`，
/// 而 `f64` 没有 `Eq`（NaN != 自身）。这两个值由前端夹在有限区间里、不会是 NaN，
/// 但类型上拿不到 `Eq`，于是整个结构体也只能到 `PartialEq` 为止。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 编辑器字号（px）。**偏好类**，只认内置默认 + 用户全局。
    ///
    /// ⚠️ Rust 不夹范围：具体档位（前端 `FONT_SIZES`）是 UI 概念，夹一次就够，
    /// 归前端（读到档外值回退默认）。与 `Session.recent` 的「两边各截一次不如只截一次」同理。
    pub font_size: u32,
    /// 正文字体 ID（`FontVariantId`）。**偏好类**。Rust 视为不透明字符串，前端校验。
    pub font_variant: String,
    /// 代码区字体 ID（`CodeFontId`）。**偏好类**。同上。
    pub code_font: String,
    /// 行高（无单位倍数）。**偏好类**。Rust 不夹范围，归前端（同 `font_size`）。
    pub line_height: f64,
    /// 字间距（em）。**偏好类**。`0.0` = `normal`。Rust 不夹范围，归前端。
    pub letter_spacing: f64,
    /// 主题选择（`'light' | 'dark' | 'system'`，M4-C）。**偏好类**。
    /// Rust 视为不透明字符串，前端校验（同 `font_variant`）。
    pub theme: String,
    /// OSS bucket 名（M7-5，PLAN.md §3.5「图片粘贴自动落地」的云端分支）。
    ///
    /// 🔴 **不是偏好类，但同样只认用户全局**：理由与偏好类相反却更硬——一个克隆来的
    /// 仓库如果能改这一格，它就能把你粘贴的图**改道到别人的 bucket**。签名在 Rust 侧算、
    /// `Authorization` 里带着我们的 AccessKey ID，改道至少泄露一次派生签名。所以这四格
    /// OSS 键与六个偏好键走同一条「项目层写了也忽略」的门（见 [`resolve`]）。
    ///
    /// 空 = 没配。`src-tauri/src/commands.rs` 的 `upload_image` 与前端 `src/md/paste.ts` 的
    /// `landPastedImage` 都用「四格齐不齐 + 钥匙串里有没有 secret」判断走不走云端，**没有**一个
    /// `enabled` 开关：用户裁定是「配了就走阿里云，没配就走本地」（PLAN.md 决策 2），多一个开关
    /// 只会让「配了但开关是关的」成为一种需要解释的状态。
    pub oss_bucket: String,
    /// OSS 地域，只写 `cn-hangzhou` 那一段（不带 `oss-` 前缀、不带域名）。
    ///
    /// ⚠️ Rust 这一层**不校验形状**：粘进整串访问域名是常见手滑，但拒绝它是落地层的活
    /// （`src-tauri/src/oss.rs` 的 `normalize`），那里失败会明确说哪一格不对。配置文件是
    /// 用户可以手改的东西，读它的时候把内容改「对」会让用户以为程序在瞎猜；照原样存回去、
    /// 在真要用它的那一步报错，才是这条路的形状。
    pub oss_region: String,
    /// AccessKey ID（RAM 子账号的那一串）。
    ///
    /// 🔴 这一格**可以**明文存在配置文件里，`access_key_secret` 不行——ID 不是凭证，
    /// 它只指明「用哪对密钥签名」，拿到它什么也做不了（阿里云的鉴权要的是 HMAC 结果，
    /// 而算那个结果需要 secret）。完整推理与「为什么没有 `oss_access_key_secret` 这个字段」
    /// 写在 `src-tauri/src/oss.rs` 的模块文档「AccessKeySecret 的走向」一节。
    pub oss_access_key_id: String,
    /// 对象名前缀（`assets` 那一段，不带首尾斜杠）。见 [`DEFAULT_OSS_PREFIX`]。
    pub oss_prefix: String,
}

impl Default for Settings {
    /// 内置默认层——三层合并的最底层。
    fn default() -> Self {
        Settings {
            font_size: DEFAULT_FONT_SIZE,
            font_variant: DEFAULT_FONT_VARIANT.to_owned(),
            code_font: DEFAULT_CODE_FONT.to_owned(),
            line_height: DEFAULT_LINE_HEIGHT,
            letter_spacing: DEFAULT_LETTER_SPACING,
            theme: DEFAULT_THEME.to_owned(),
            oss_bucket: String::new(),
            oss_region: String::new(),
            oss_access_key_id: String::new(),
            oss_prefix: DEFAULT_OSS_PREFIX.to_owned(),
        }
    }
}

/// **一层**配置文件的内容：每个键都是可选的，缺哪个就由更底层补。
///
/// 与 [`Settings`] 的区别正是这个 `Option`：一个层文件通常只写用户改动过的那几个键，
/// 读进来时缺的键解析成 `None`，合并时跳过、留给下一层。
///
/// 只派生 `Deserialize`：写盘走的是具体的 [`Settings`]（整份重写用户全局层），
/// 这个类型只是**读**的形状。`#[serde(default)]` 让缺键 = `None`，
/// 未知键被 serde 默认忽略（forward-compat，见模块文档）。
///
/// ⚠️ 同 [`Settings`]：含 `f64`，只到 `PartialEq` 为止，没有 `Eq`。
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsLayer {
    pub font_size: Option<u32>,
    pub font_variant: Option<String>,
    pub code_font: Option<String>,
    pub line_height: Option<f64>,
    pub letter_spacing: Option<f64>,
    pub theme: Option<String>,
    /// M7-5 那四格 OSS 配置。与上面六个键同一条规则：**只有用户全局层能写**。
    /// `None` = 这一层没写这一格，留给下一层（最终落到内置默认，见 [`Settings::default`]）。
    pub oss_bucket: Option<String>,
    pub oss_region: Option<String>,
    pub oss_access_key_id: Option<String>,
    pub oss_prefix: Option<String>,
}

/// 一层配置文件在读取时的下场。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LayerStatus {
    /// 这一层的文件不存在。
    Absent,
    /// 文件存在且解析成功。⚠️ 「解析成功」不等于「生效」：项目层的偏好键解析成功后
    /// 仍会被忽略（见 [`SettingsReport::ignored_project_keys`]）。
    Present,
    /// 文件存在但读不回来（不是合法 JSON、类型不对、或超过 [`MAX_SETTINGS_BYTES`]），
    /// 已当成「这一层没有配置」。`reason` 是事实（serde 的错或 IO 的错），文案归前端。
    Corrupt { reason: String },
}

/// `load` 的附带账单：两层各自的下场，以及项目层被忽略掉的键。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsReport {
    pub user_layer: LayerStatus,
    pub project_layer: LayerStatus,
    /// 项目层试图写「仅全局」的键、因而被忽略的键名（wire 名，前端可直接引用）。
    ///
    /// v1 里十个键全是仅全局类（六个偏好 + 四格 OSS 账号配置），所以项目层写的任何键
    /// 都会落在这里。前端可以据此说一句
    /// 「这个仓库的 `.vela/settings.json` 想改你的 <键>，但 <键> 只认用户全局，已忽略」。
    pub ignored_project_keys: Vec<String>,
}

/// `load` 的返回值：合并好的配置 + 那份账单。
///
/// ⚠️ 只到 `PartialEq`：内含 [`Settings`]，而 `Settings` 带 `f64`、拿不到 `Eq`。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSettings {
    pub settings: Settings,
    pub report: SettingsReport,
}

/// `save` 的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub bytes_written: u64,
}

/// 用户全局配置的路径：`~/.vela/settings.json`。
///
/// ⚠️ `home` 由 Tauri 侧 `app.path().home_dir()` 算出后传进来，**绝不**做成命令参数——
/// 与 `commands.rs` 的 `session_path` 同一条安全姿势：一旦让前端传路径，
/// 它就有了「往任意位置写任意文件」的原语，而配置文件是启动即读、内容会灌进 UI 的东西。
#[must_use]
pub fn user_settings_path(home: &Path) -> PathBuf {
    home.join(VELA_DIR_NAME).join(SETTINGS_FILE_NAME)
}

/// 项目级配置的路径：`<root>/.vela/settings.json`。
///
/// `root` 来自 dialog 插件授权过的目录（多根时的第一个根），相对部分是**写死的常量**，
/// 前端没有任何输入框能改它，于是「用配置路径逃出 root」在结构上不可能。
#[must_use]
pub fn project_settings_path(root: &Path) -> PathBuf {
    root.join(VELA_DIR_NAME).join(SETTINGS_FILE_NAME)
}

/// 读一层配置文件。三种下场：不存在 / 解析成功 / 损坏（含超限、IO 错、非法 JSON）。
///
/// **不向上抛错**：配置读不回来是「用默认值」，不是「启动失败」。
fn read_layer(path: &Path) -> (Option<SettingsLayer>, LayerStatus) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return (None, LayerStatus::Absent),
        // 权限不够、是个目录、磁盘错误……一律当这一层不可用，不拦启动
        Err(err) => {
            return (None, LayerStatus::Corrupt { reason: format!("读不了：{err}") });
        }
    };
    if bytes.len() > MAX_SETTINGS_BYTES {
        return (None, LayerStatus::Corrupt { reason: format!("{} 字节，超过上限 {MAX_SETTINGS_BYTES}", bytes.len()) });
    }
    match serde_json::from_slice::<SettingsLayer>(&bytes) {
        Ok(layer) => (Some(layer), LayerStatus::Present),
        Err(err) => (None, LayerStatus::Corrupt { reason: format!("不是合法配置：{err}") }),
    }
}

/// 把两层文件内容合并成最终配置，并记账项目层被忽略的键。
///
/// 🔴 **可写层门在这里**：v1 十个键都只认全局，只有 `user`（用户全局）能盖过内置默认；
/// `project`（项目级）里的同名键一律**丢弃并记账**。将来第一个 project-safe 键进来时，
/// 就在这个函数里给它加一条「也接受 project」的分支——门已经在这儿了，不用临时搭。
pub fn resolve(user: SettingsLayer, project: SettingsLayer) -> (Settings, Vec<String>) {
    // 内置默认层
    let mut settings = Settings::default();

    // 用户全局层：偏好类键可写，直接盖
    if let Some(v) = user.font_size {
        settings.font_size = v;
    }
    if let Some(v) = user.font_variant {
        settings.font_variant = v;
    }
    if let Some(v) = user.code_font {
        settings.code_font = v;
    }
    if let Some(v) = user.line_height {
        settings.line_height = v;
    }
    if let Some(v) = user.letter_spacing {
        settings.letter_spacing = v;
    }
    if let Some(v) = user.theme {
        settings.theme = v;
    }
    if let Some(v) = user.oss_bucket {
        settings.oss_bucket = v;
    }
    if let Some(v) = user.oss_region {
        settings.oss_region = v;
    }
    if let Some(v) = user.oss_access_key_id {
        settings.oss_access_key_id = v;
    }
    if let Some(v) = user.oss_prefix {
        settings.oss_prefix = v;
    }

    // 项目层：v1 没有 project-safe 键，十个键写了都忽略，只记账给前端一句话。
    // 前六个是偏好（「别改我的字号」），后四格是账号配置（「别把我的图改道到别人的 bucket」）
    let mut ignored_project_keys = Vec::new();
    if project.font_size.is_some() {
        ignored_project_keys.push("fontSize".to_owned());
    }
    if project.font_variant.is_some() {
        ignored_project_keys.push("fontVariant".to_owned());
    }
    if project.code_font.is_some() {
        ignored_project_keys.push("codeFont".to_owned());
    }
    if project.line_height.is_some() {
        ignored_project_keys.push("lineHeight".to_owned());
    }
    if project.letter_spacing.is_some() {
        ignored_project_keys.push("letterSpacing".to_owned());
    }
    if project.theme.is_some() {
        ignored_project_keys.push("theme".to_owned());
    }
    // M7-5 那四格同样只认用户全局，但**理由与上面六个不同**：六个是「别让仓库改你的偏好」，
    // 这四格是「别让仓库把你的图改道到别人的 bucket」。同一个门，两种动机，
    // 所以记账用的还是同一个 `ignoredProjectKeys`（前端的文案会说「只认用户全局」，两句都成立）
    if project.oss_bucket.is_some() {
        ignored_project_keys.push("ossBucket".to_owned());
    }
    if project.oss_region.is_some() {
        ignored_project_keys.push("ossRegion".to_owned());
    }
    if project.oss_access_key_id.is_some() {
        ignored_project_keys.push("ossAccessKeyId".to_owned());
    }
    if project.oss_prefix.is_some() {
        ignored_project_keys.push("ossPrefix".to_owned());
    }

    (settings, ignored_project_keys)
}

/// 读回合并好的配置。
///
/// - `home`：用户主目录（`~/.vela/settings.json` 从这里推出）。
/// - `project_root`：多根工作区的**第一个根**；`None` = 没打开任何文件夹，项目层为 `Absent`。
///
/// **不返回 `Result`**：任何一层坏掉都退化成默认值并记进账单，配置永远不该拦下启动。
pub fn load(home: &Path, project_root: Option<&Path>) -> LoadedSettings {
    let (user_layer, user_status) = read_layer(&user_settings_path(home));
    let (project_layer, project_status) = match project_root {
        Some(root) => read_layer(&project_settings_path(root)),
        None => (None, LayerStatus::Absent),
    };

    let (settings, ignored_project_keys) = resolve(user_layer.unwrap_or_default(), project_layer.unwrap_or_default());

    LoadedSettings {
        settings,
        report: SettingsReport { user_layer: user_status, project_layer: project_status, ignored_project_keys },
    }
}

/// 把配置写进**用户全局层**（`~/.vela/settings.json`），原子。
///
/// 🔴 v1 只写用户全局层：偏好键只认全局，没有需要落到项目层的键。将来第一个 project-safe
/// 键进来时，这里要能按「这个键该写哪一层」分流——那时再改签名，现在不预设。
///
/// ⚠️ **整份重写，会丢掉本版本不认识的键**（与 `save_session` 同一条取舍）：升级珍贵、
/// 降级罕见，为一个降级场景去做「读回 JSON map 再只覆盖已知键」的读-改-写不划算，
/// 而且那样会引入两个 Vela 实例并存的写竞态。真要支持用户在全局层存第三方键，再改这里。
///
/// 父目录（`~/.vela/`）不存在时先建出来——第一次改配置时它还不存在。
pub fn save(home: &Path, settings: &Settings) -> Result<SaveReport, WriteError> {
    let path = user_settings_path(home);
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| WriteError::Io {
        // 序列化一个具体 Settings 实际上不会失败，留这条只为类型完整；reason 借用 Io
        reason: "Serialize".to_owned(),
        message: format!("配置序列化失败：{e}"),
    })?;

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| WriteError::NoParent { path: path.display().to_string() })?;
    fs::create_dir_all(parent).map_err(|e| WriteError::Io {
        reason: format!("{:?}", e.kind()),
        message: format!("建不出 {}：{e}", parent.display()),
    })?;

    write_bytes_atomic(&path, &bytes)?;
    Ok(SaveReport { bytes_written: bytes.len() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把一份层文件写进「假装的主目录」`~/.vela/settings.json`。
    fn write_user(home: &Path, json: &str) {
        let path = user_settings_path(home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, json).unwrap();
    }

    /// 把一份层文件写进「假装的项目根」`<root>/.vela/settings.json`。
    fn write_project(root: &Path, json: &str) {
        let path = project_settings_path(root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, json).unwrap();
    }

    #[test]
    fn 两层都不存在时给出内置默认() {
        let home = tempfile::tempdir().unwrap();
        let loaded = load(home.path(), None);
        assert_eq!(loaded.settings, Settings::default());
        assert_eq!(loaded.report.user_layer, LayerStatus::Absent);
        assert_eq!(loaded.report.project_layer, LayerStatus::Absent);
        assert!(loaded.report.ignored_project_keys.is_empty());
    }

    #[test]
    fn 用户全局层盖过内置默认() {
        let home = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"fontSize":18,"codeFont":"inherit"}"#);
        let loaded = load(home.path(), None);
        // 写了的两个键生效，没写的（fontVariant）留给内置默认
        assert_eq!(loaded.settings.font_size, 18);
        assert_eq!(loaded.settings.code_font, "inherit");
        assert_eq!(loaded.settings.font_variant, DEFAULT_FONT_VARIANT);
        assert_eq!(loaded.report.user_layer, LayerStatus::Present);
    }

    #[test]
    fn 项目层的偏好键被忽略并记账() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"fontSize":16}"#);
        // 仓库想改字号与正文字体：两个都该被丢弃，用户全局的 16 胜出
        write_project(root.path(), r#"{"fontSize":20,"fontVariant":"system-mono"}"#);

        let loaded = load(home.path(), Some(root.path()));
        assert_eq!(loaded.settings.font_size, 16, "项目层不该盖掉用户全局的字号");
        assert_eq!(loaded.settings.font_variant, DEFAULT_FONT_VARIANT, "项目层不该改正文字体");
        assert_eq!(loaded.report.project_layer, LayerStatus::Present, "文件读到了，只是键被忽略");
        assert_eq!(loaded.report.ignored_project_keys, vec!["fontSize".to_owned(), "fontVariant".to_owned()]);
    }

    #[test]
    fn 没有项目根时项目层是_absent() {
        let home = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"fontSize":15}"#);
        let loaded = load(home.path(), None);
        assert_eq!(loaded.report.project_layer, LayerStatus::Absent);
    }

    #[test]
    fn 项目根存在但没有配置文件时也是_absent() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let loaded = load(home.path(), Some(root.path()));
        assert_eq!(loaded.report.project_layer, LayerStatus::Absent);
    }

    #[test]
    fn 非法_json_的用户层退化成默认并记_corrupt() {
        let home = tempfile::tempdir().unwrap();
        write_user(home.path(), "这不是 json");
        let loaded = load(home.path(), None);
        assert_eq!(loaded.settings, Settings::default(), "坏配置不该把启动带下水");
        assert!(matches!(loaded.report.user_layer, LayerStatus::Corrupt { .. }));
    }

    #[test]
    fn 类型不对的键也让整层退化() {
        // fontSize 是字符串而不是数字：serde 解析整层失败，退化成默认。
        // v1 不做「逐键容错」——一个键类型不对说明这份文件被改坏了，整层不信任比半信任好排查。
        let home = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"fontSize":"大","codeFont":"inherit"}"#);
        let loaded = load(home.path(), None);
        assert!(matches!(loaded.report.user_layer, LayerStatus::Corrupt { .. }));
        assert_eq!(loaded.settings, Settings::default(), "整层作废，连合法的 codeFont 也不生效");
    }

    #[test]
    fn 超过大小上限的用户层被当成损坏() {
        let home = tempfile::tempdir().unwrap();
        // 一个键撑过 64KB：值本身合法，但文件超限
        let big = "x".repeat(MAX_SETTINGS_BYTES + 1);
        write_user(home.path(), &format!(r#"{{"fontVariant":"{big}"}}"#));
        let loaded = load(home.path(), None);
        assert!(matches!(loaded.report.user_layer, LayerStatus::Corrupt { .. }));
        assert_eq!(loaded.settings, Settings::default());
    }

    #[test]
    fn 未知键被忽略而不让整层作废() {
        // forward-compat：将来才有的键不该让只认十个键的这一版读不动。
        // theme 在 M4-C 之后已是**已知**键，正好顺带钉住「用户层写的 theme 生效」
        let home = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"fontSize":18,"theme":"light","将来才有的键":123}"#);
        let loaded = load(home.path(), None);
        assert_eq!(loaded.report.user_layer, LayerStatus::Present);
        assert_eq!(loaded.settings.font_size, 18);
        assert_eq!(loaded.settings.theme, "light", "用户层写的 theme 是已知键，该生效");
    }

    #[test]
    fn 存下来再读回来一致() {
        let home = tempfile::tempdir().unwrap();
        let settings = Settings {
            font_size: 20,
            font_variant: "screen-r".into(),
            code_font: "inherit".into(),
            line_height: 2.0,
            letter_spacing: 0.05,
            theme: "light".into(),
            oss_bucket: "vela-img".into(),
            oss_region: "cn-hangzhou".into(),
            oss_access_key_id: "LTAI5tExampleId".into(),
            oss_prefix: "docs/notes".into(),
        };
        let report = save(home.path(), &settings).unwrap();
        assert_eq!(report.bytes_written, fs::read(user_settings_path(home.path())).unwrap().len() as u64);

        let loaded = load(home.path(), None);
        assert_eq!(loaded.settings, settings, "往返之后配置变了");
    }

    #[test]
    fn 行高与字间距能存回来() {
        // 专门钉住两个 f64 键的往返：`1.75` 与 `0.05` 在 JSON 里都能精确表示，
        // serde 写回来再读回来必须逐位相等（不是「差不多」）
        let home = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"lineHeight":2.0,"letterSpacing":0.05}"#);
        let loaded = load(home.path(), None);
        assert_eq!(loaded.settings.line_height, 2.0);
        assert_eq!(loaded.settings.letter_spacing, 0.05);
        // 没写的键留给内置默认
        assert_eq!(loaded.settings.font_size, DEFAULT_FONT_SIZE);
    }

    #[test]
    fn 项目层写行高与字间距也被忽略并记账() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_project(root.path(), r#"{"lineHeight":2.5,"letterSpacing":0.2}"#);
        let loaded = load(home.path(), Some(root.path()));
        assert_eq!(loaded.settings.line_height, DEFAULT_LINE_HEIGHT, "项目层不该改行高");
        assert_eq!(loaded.settings.letter_spacing, DEFAULT_LETTER_SPACING, "项目层不该改字间距");
        assert_eq!(loaded.report.ignored_project_keys, vec!["lineHeight".to_owned(), "letterSpacing".to_owned()]);
    }

    #[test]
    fn 项目层写主题也被忽略并记账() {
        // 主题是偏好类（M4-C）：一个克隆来的仓库不该有「把你整个应用切成亮色」的权力
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"theme":"light"}"#);
        write_project(root.path(), r#"{"theme":"dark"}"#);
        let loaded = load(home.path(), Some(root.path()));
        assert_eq!(loaded.settings.theme, "light", "用户全局的 light 胜出，项目层不该盖");
        assert_eq!(loaded.report.ignored_project_keys, vec!["theme".to_owned()]);
    }

    #[test]
    fn 主题能存回来并走用户全局层() {
        let home = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"theme":"system"}"#);
        let loaded = load(home.path(), None);
        assert_eq!(loaded.settings.theme, "system");
        // 没写的键留给内置默认
        assert_eq!(loaded.settings.font_size, DEFAULT_FONT_SIZE);
    }

    #[test]
    fn 存的时候会建出_dot_vela_目录() {
        // 第一次改配置时 ~/.vela 还不存在
        let home = tempfile::tempdir().unwrap();
        assert!(!home.path().join(VELA_DIR_NAME).exists());
        save(home.path(), &Settings::default()).unwrap();
        assert!(user_settings_path(home.path()).exists());
    }

    #[test]
    fn 存下来的文件是干净的十个键_json() {
        // 整份重写：只含这十个键，没有 null、没有多余字段。pretty 是为了用户手改时读得下去
        let home = tempfile::tempdir().unwrap();
        save(home.path(), &Settings::default()).unwrap();
        let text = fs::read_to_string(user_settings_path(home.path())).unwrap();
        assert!(text.contains("\"fontSize\": 14"), "{text}");
        assert!(text.contains("\"fontVariant\": \"screen-gb\""), "{text}");
        assert!(text.contains("\"codeFont\": \"maple-cn\""), "{text}");
        assert!(text.contains("\"lineHeight\": 1.75"), "{text}");
        assert!(text.contains("\"letterSpacing\": 0.0"), "{text}");
        assert!(text.contains("\"theme\": \"dark\""), "{text}");
        assert!(text.contains("\"ossBucket\": \"\""), "{text}");
        assert!(text.contains("\"ossRegion\": \"\""), "{text}");
        assert!(text.contains("\"ossAccessKeyId\": \"\""), "{text}");
        // 前缀不是空串：空前缀等于把对象堆在 bucket 根上，默认值替用户做了那个选择
        assert!(text.contains("\"ossPrefix\": \"assets\""), "{text}");
        assert!(!text.contains("null"), "不该写 null 键：{text}");
        // 🔴 这一条是「secret 不进配置文件」那条硬约束的可执行版本：整份文件里
        // 不许出现任何长得像 secret 的键。`ossAccessKeyId` 里有 "AccessKey" 但没有 "Secret"，
        // 所以搜 "Secret" 不会被它误命中
        assert!(!text.contains("Secret"), "配置文件里出现了 secret：{text}");
    }

    #[test]
    fn oss_四格走用户全局层并能往返() {
        // 用户配好阿里云 = 这四格齐了。Rust 侧**不校验形状**（region 填成域名也照原样存回来），
        // 拒绝它的活儿在落地层（`src-tauri/src/oss.rs` 的 `normalize`）
        let home = tempfile::tempdir().unwrap();
        write_user(
            home.path(),
            r#"{"ossBucket":"vela-img","ossRegion":"cn-hangzhou","ossAccessKeyId":"LTAI5tExampleId","ossPrefix":"docs"}"#,
        );
        let loaded = load(home.path(), None);
        assert_eq!(loaded.settings.oss_bucket, "vela-img");
        assert_eq!(loaded.settings.oss_region, "cn-hangzhou");
        assert_eq!(loaded.settings.oss_access_key_id, "LTAI5tExampleId");
        assert_eq!(loaded.settings.oss_prefix, "docs");
        // 没写的偏好键仍留给内置默认：四格 OSS 不该顺手改动别的键
        assert_eq!(loaded.settings.font_size, DEFAULT_FONT_SIZE);
    }

    #[test]
    fn 没配_oss_时给出空三格与_assets_前缀() {
        // 「配了就走云端，没配就走本地」那个二态判定的下侧就是这三格空串。
        // 前端与 Rust 都靠它，所以把它钉死——默认值一旦改成非空，
        // 「没配」就再也判不出来，粘贴会去尝试一条注定失败的上传
        let home = tempfile::tempdir().unwrap();
        let loaded = load(home.path(), None);
        assert_eq!(loaded.settings.oss_bucket, "");
        assert_eq!(loaded.settings.oss_region, "");
        assert_eq!(loaded.settings.oss_access_key_id, "");
        assert_eq!(loaded.settings.oss_prefix, DEFAULT_OSS_PREFIX);
    }

    #[test]
    fn 项目层想改_bucket_也被忽略并记账() {
        // 🔴 这一条守的不是「别改我的偏好」，而是「别把我粘贴的图改道到别人的 bucket」：
        // 克隆一个仓库、打开它、然后每次粘贴都往陌生人的 bucket 传——签名里带着我们的
        // AccessKey ID，至少泄露一次派生签名。与主题那条同一个门，两种动机
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_user(home.path(), r#"{"ossBucket":"mine"}"#);
        write_project(root.path(), r#"{"ossBucket":"someone-else","ossAccessKeyId":"LTAI5tAttackerId"}"#);
        let loaded = load(home.path(), Some(root.path()));
        assert_eq!(loaded.settings.oss_bucket, "mine", "项目层不该把上传目标换掉");
        assert_eq!(loaded.settings.oss_access_key_id, "", "项目层写的 AccessKey ID 不该生效");
        assert_eq!(loaded.report.ignored_project_keys, vec!["ossBucket".to_owned(), "ossAccessKeyId".to_owned()]);
    }

    #[test]
    fn resolve_从空层给出默认() {
        let (settings, ignored) = resolve(SettingsLayer::default(), SettingsLayer::default());
        assert_eq!(settings, Settings::default());
        assert!(ignored.is_empty());
    }

    #[test]
    fn 路径拼接的形状() {
        assert_eq!(user_settings_path(Path::new("/home/me")), PathBuf::from("/home/me/.vela/settings.json"));
        assert_eq!(project_settings_path(Path::new("/repo")), PathBuf::from("/repo/.vela/settings.json"));
    }
}
