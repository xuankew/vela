//! 阿里云 OSS 的 AccessKeySecret 存在 macOS 钥匙串里，**不存在配置文件里**（M7-4）。
//!
//! ## 为什么这一格必须与另外四格分开存
//!
//! 另外四格（bucket / region / AccessKey ID / prefix）是**位置**，泄露了最多让别人知道
//! 「这个人的图往哪个桶传」。secret 是**凭证**，泄露了别人就能往那个桶里写任何东西。
//! 而 `~/.vela/settings.json` 的处境对凭证来说正好是最坏的那一种：
//!
//! 1. 它是纯文本，而 iCloud / Dropbox / 时间机器 / 那些「备份我的整个家目录」的脚本
//!    默认就会把它带走——用户从来没有决定过要备份自己的密钥，它还是被备份了；
//! 2. `load_settings` 会把整个文件原样交给 webview。多一个键，密钥就多一次「进 JS 堆、
//!    进崩溃转储、进某个调试面板」的机会，而前端**根本用不上**它：上传与签名都在 Rust
//!    （[`crate::oss`]，M7-2 与 M7-3）。
//!
//! ## 🔴 这三条命令里没有任何一条能把密钥读出来
//!
//! [`set_oss_secret`] 写、[`delete_oss_secret`] 删、[`oss_secret_status`] 只回一个 bool。
//! ⛔ **不要加 `get_oss_secret`**：那一条命令的存在本身就是漏洞——webview 里任何一段脚本
//! （预览的 Markdown 注入一个 `<script>` 就够了）都能把它读走再发到任意地址。
//! 前端要的只是「该显示「已配置」还是「未配置」」，那一个 bool 就是它需要的全部信息量。
//!
//! 那 M7-3 的 `upload_image` 怎么拿到密钥？走 [`load_access_key_secret`]：同一个进程里的
//! 一次函数调用，不过 IPC。
//!
//! ## 这一层能测到哪儿
//!
//! 钥匙串那三个调用是**系统调用**，单测里不能真跑：CI 的 rust job 在 ubuntu 上（压根没有
//! 钥匙串），而在本机跑就等于往开发机的真实钥匙串里写一项、第一次还可能弹一个模态框把
//! 门禁挂住。与 `trash::delete`、`watcher` 不进 vela-core 是同一条纪律（见 `commands.rs`
//! 开头那段）。所以进测试的是这四件纯的事：[`clean`]、码表、错误枚举的 JSON 形状，
//! 以及「密钥不可能出现在这些形状里」。真正没测到的只有 `SecItem*` 那三行——
//! 它们薄到只有一句调用与一次状态码分派。

use serde::Serialize;
use tauri::command;

/// 钥匙串里那一项的服务名。
///
/// ⚠️ 刻意**不是** `tauri.conf.json` 里那个 `identifier`（当前是 `app.vela.m1`）：那一个
/// 带着里程碑后缀，将来换成正式 bundle id 是计划里写了的事，而钥匙串项按这个字符串寻址。
/// 跟着改的失败方式很安静——用户升级完，OSS 全挂，而界面只会显示「未配置」。
pub const SERVICE: &str = "app.vela.oss";

/// 账号名。一个 service 下可以有多个账号，Vela 只用这一个。
///
/// 与 [`SERVICE`] 同理：**⛔ 不要把它做成可配置的**。M7-3 的安全论证里有一条是「固定账号名」——
/// `upload_image` 那一侧取密钥时不给任何参数，能被前端影响的只有那四格位置，
/// 而那四格进不了钥匙串的寻址。
pub const ACCOUNT: &str = "access-key-secret";

/// 「没填」那一句。
const EMPTY_MESSAGE: &str = "这里要填密钥。要清掉已经存着的那一份，请点「清除」。";
/// 「存了但读不出可用密钥」那一句。
const CORRUPT_MESSAGE: &str = "钥匙串里那一项读不出可用的密钥（可能被别的工具改过）。点「清除」，再重新填一次。";
/// 「这个平台没有钥匙串」那一句。
const UNSUPPORTED_MESSAGE: &str = "当前系统还没有可用的钥匙串：密钥目前只能存在 macOS 的登录钥匙串里。";

/// 一次钥匙串操作的失败。
///
/// 与 [`crate::oss::UploadError`] 同一套路数：`#[serde(tag = "kind")]` 让前端按类型分支，
/// 而不是去 `message` 里找关键字。
///
/// ## 🔴 四句文案为什么在 Rust 而不是在前端
///
/// `src/ipc/asset.ts` 那一种「静态句子归前端」的写法在这里会漂：同一句「拿不到密钥」有
/// **两个出口**——`oss_secret_status` 的失败，以及 `upload_image` 把它塞进
/// [`crate::oss::UploadError::NotConfigured`] 的 `reason`。前端写一份、Rust 再写一份，
/// 漂移的症状只是措辞不一样，没人会当 bug 报上来。所以一整组句子只留这一处，
/// 前端那个 `describeSecretError` 只做透传。
///
/// 🔴 四个变体里没有任何一个可能带密钥。[`Keychain`](SecretError::Keychain) 只装 OSStatus
/// 与苹果自己对那一个码的描述（`SecCopyErrorMessageString` 的输入**只有码本身**，它拿不到
/// 密钥），另外三条装的是上面那三个常量。以后要加字段，先想清楚它的来源是谁。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SecretError {
    /// 传进来一句空的、或全是空白的密钥。
    ///
    /// ⚠️ 前端该把它显示成「这里要填」，**不该**显示成一次写入失败：
    /// 用户确实没填，而不是系统没存住
    Empty { message: String },
    /// 钥匙串回了一个非 0 的状态码。`code` 是 OSStatus 原值（报障时唯一有用的数字），
    /// `message` 是按码翻出的一句中文
    Keychain { code: i32, message: String },
    /// 存着的那一项读不出能用的密钥：零字节，或者不是合法 UTF-8。
    ///
    /// ⚠️ 我们的写入路径产不出这两种东西（[`clean`] 挡掉空，存的又是 `&str` 的字节），
    /// 所以走到这里只可能是**别的工具**往同一个 service/account 写了东西
    /// ——`security(1)` 就能写。处置与「没配」一样（清除后重填），但**不能说成没配**：
    /// 用户会问「我明明配过」，而那一方他是对的
    Corrupt { message: String },
    /// 当前平台没有钥匙串。只有 macOS 实现了读写，另外两个平台上这三条命令一律回这一条
    /// （与 `reveal_entry` / `copy_entry_path` 同一种「明写地不可用」，见 `commands.rs`
    /// 里 `run_macos_tool` 的非 macOS 分支）
    Unsupported { message: String },
}

impl SecretError {
    /// 这一条失败该对用户说的那句话。[`crate::oss::UploadError::NotConfigured`] 的
    /// `reason` 用它填——同一句话的第二个出口，见上面那一节
    pub fn message(&self) -> &str {
        match self {
            SecretError::Empty { message }
            | SecretError::Keychain { message, .. }
            | SecretError::Corrupt { message }
            | SecretError::Unsupported { message } => message,
        }
    }

    /// 下面三个构造器是这三条变体**唯一**的来路：句子写在这里一次，调用点只挑变体。
    ///
    /// ⚠️ `pub` 不只是给外面用的：`unsupported()` 只由非 macOS 那一份后端调用，
    /// 私有版本会在 macOS 上被 `dead_code` 判成死代码，而门禁是 `-D warnings`。
    /// 这三个句子本来就打算只有一处，公开出来正好当那个「只有一处」的落点。
    pub fn empty() -> Self {
        Self::Empty { message: EMPTY_MESSAGE.to_owned() }
    }

    pub fn corrupt() -> Self {
        Self::Corrupt { message: CORRUPT_MESSAGE.to_owned() }
    }

    pub fn unsupported() -> Self {
        Self::Unsupported { message: UNSUPPORTED_MESSAGE.to_owned() }
    }
}

/// [`oss_secret_status`] 的返回：**只有一个 bool**。
///
/// 🔴 这里刻意不多返回任何一个字段。将来有人想加 `maskedValue`（`STS****abcd`）时，
/// 请连本模块那条 🔴 一起重读一遍：打了码的尾巴也是尾巴，够用来确认「配的是哪一个账号」，
/// 也就够用来做撞库的第一步。
#[derive(Debug, Serialize)]
pub struct SecretStatus {
    /// true = 钥匙串里有一项，且它读得出、能当密钥用
    pub configured: bool,
}

/// 把用户粘进来的那一段清成可以存的形式：只去首尾空白，中间一个字节不动。
///
/// 为什么必须去首尾空白：从控制台那一行复制很容易顺手带上一个换行或空格，而它会一路进到
/// HMAC 的密钥里。失败的表现是 OSS 回 `SignatureDoesNotMatch`，我们的文案说的是
/// 「Secret 填错了或已经轮换过」——一句指向密钥的错话，真正多出来的只是一个 `\n`。
///
/// 为什么**不做格式校验**：阿里云没有承诺过 AccessKeySecret 的长度与字母表，
/// 任何校验都会先把某一天换了格式的合法密钥拒掉，而那一种失败用户完全无从下手。
fn clean(input: &str) -> Option<&str> {
    let trimmed = input.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// 读出来那一段字节 → 可以签名的字符串。
///
/// 为什么单独一个函数：[`load_access_key_secret`]（M7-3 要调的那一个）与
/// [`oss_secret_status`] 判的是同一件事「这一项到底能不能用」。两份判定迟早会漂，
/// 而漂了的症状是「面板说已配置，上传却说没配」。
fn decode(bytes: Vec<u8>) -> Result<String, SecretError> {
    if bytes.is_empty() {
        return Err(SecretError::corrupt());
    }
    String::from_utf8(bytes).map_err(|_| SecretError::corrupt())
}

/// 取回密钥本身。**只在进程内用**，⛔ 永远不要把它变成一条 command 的返回值。
///
/// 三态分开的理由：`Ok(None)` = 没配过（不是失败，要说「还没填」）；`Err` = 配了但用不了，
/// 或者这个平台压根没有钥匙串（要说「填的读不出来」）。把第二种说成第一种，
/// 用户会一遍一遍重填同一个本来正确的密钥。
pub fn load_access_key_secret() -> Result<Option<String>, SecretError> {
    match backend::read()? {
        Some(bytes) => decode(bytes).map(Some),
        None => Ok(None),
    }
}

/// 平台相关的三件事：写、读、删。两份实现签名一致，由 cfg 选一份。
///
/// 为什么错误文案在这一个模块里而不是在外面：文案要 OSStatus，而只有 macOS 那一份拿得到码。
#[cfg(target_os = "macos")]
mod backend {
    use super::{SecretError, ACCOUNT, SERVICE};
    use security_framework::passwords::{
        delete_generic_password, generic_password, set_generic_password, PasswordOptions,
    };

    /// `errSecItemNotFound`：`SecItemCopyMatching` 没找到条目时回的那一个码。
    ///
    /// ⚠️ 这三条码是手写的数字而不是 `security_framework_sys::base::*`，因为那一个 crate
    /// 只收录了 `errSec*` 那一族，`userCanceled` 属于更老的 Mac OS 错误码族、它没有。
    /// 一半来自常量、一半来自字面量的写法比三条都写在一处更难读，所以这里统一写字面量，
    /// 再让下面那一条单测去和 sys 常量对两次（那是补上的那道闸）。
    const ITEM_NOT_FOUND: i32 = -25300;
    /// `errSecAuthFailed`
    const AUTH_FAILED: i32 = -25293;
    /// `MacErrors.h` 里的 `userCanceled`（sys 那一条单测盖不到它，只能靠注释与
    /// 「这一句文案永远出现在点了取消之后」这条人工回归）
    const USER_CANCELED: i32 = -128;

    /// OSStatus → 一句确定的话。
    ///
    /// 顺序与 `oss.rs` 的 `message_for` 一样：认得的码 → 苹果自己对那个码的描述 → 只有数字。
    /// 认得的码**不把苹果的原话带进文案**：那一句是英文的，而它是 Vela 里唯一一个用户会
    /// 看到的、关于钥匙串的说明——两种语言混在一个设置面板里比一句英文更难读。
    pub fn message_for(code: i32, apple: Option<&str>) -> String {
        let known = match code {
            AUTH_FAILED => Some(
                "钥匙串拒绝了这次读写。可能是你在那一个「Vela 想使用钥匙串中的信息」的弹窗里点了「拒绝」，\
                 也可能是登录钥匙串被锁着。先确认登录钥匙串没有锁上，再回来重填一次。",
            ),
            USER_CANCELED => Some("在钥匙串的授权弹窗里点了取消。要保存密钥，需要在下一次弹窗里点「允许」。"),
            _ => None,
        };
        if let Some(message) = known {
            return message.to_owned();
        }
        match apple {
            Some(message) => format!("钥匙串操作失败（{code}）：{message}"),
            None => format!("钥匙串操作失败（{code}）。"),
        }
    }

    fn to_failure(err: security_framework::base::Error) -> SecretError {
        let code = err.code();
        SecretError::Keychain { code, message: message_for(code, err.message().as_deref()) }
    }

    pub fn write(secret: &str) -> Result<(), SecretError> {
        // `set_generic_password` 自己处理 `errSecDuplicateItem`（先 Add，撞了就 Update），
        // 所以这里不需要「先判存在再决定走哪一条」——那种两步之间也没有竞态可言
        match set_generic_password(SERVICE, ACCOUNT, secret.as_bytes()) {
            Ok(()) => Ok(()),
            Err(err) => Err(to_failure(err)),
        }
    }

    pub fn read() -> Result<Option<Vec<u8>>, SecretError> {
        match generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT)) {
            Ok(bytes) => Ok(Some(bytes)),
            // 「没存过」不是一种失败：它是初始状态，前端要据此显示「未配置」
            Err(err) if err.code() == ITEM_NOT_FOUND => Ok(None),
            Err(err) => Err(to_failure(err)),
        }
    }

    pub fn delete() -> Result<(), SecretError> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            // 删一项不存在的东西 = 想要的那个状态已经达成。幂等，所以「清除」多点一次
            // 不该弹一条红字
            Ok(()) => Ok(()),
            Err(err) if err.code() == ITEM_NOT_FOUND => Ok(()),
            Err(err) => Err(to_failure(err)),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 上面那些字面量写错的话，症状是某一句中文文案永远不出现、或者「没配」被报成失败——
        /// 都只在真机上看得见。这一条把它们钉在 sys 那一份权威定义上。
        ///
        /// 只作为**测试依赖**声明 `security-framework-sys`（见 `src-tauri/Cargo.toml`）：
        /// 生产代码用不上的那一份定义，正好适合待在只测一次的角落里。
        #[test]
        fn 手写的码与_sys_里的常量一致() {
            use security_framework_sys::base::{errSecAuthFailed, errSecItemNotFound};
            assert_eq!(ITEM_NOT_FOUND, errSecItemNotFound);
            assert_eq!(AUTH_FAILED, errSecAuthFailed);
        }
    }
}

/// 非 macOS：这三条能力**明写地不可用**，而不是悄悄退化成「存进了某个文件」。
///
/// ⛔ 不要拿 settings.json 或一个 0600 的临时文件填进来：本模块开头那两条理由在 Linux 上
/// 一条都不少，而那种退化是不报错的——用户会以为自己的密钥进了钥匙串。这笔债与
/// `run_macos_tool` 那一条同性质。
#[cfg(not(target_os = "macos"))]
mod backend {
    use super::SecretError;

    pub fn write(_secret: &str) -> Result<(), SecretError> {
        Err(SecretError::unsupported())
    }

    pub fn read() -> Result<Option<Vec<u8>>, SecretError> {
        Err(SecretError::unsupported())
    }

    pub fn delete() -> Result<(), SecretError> {
        Err(SecretError::unsupported())
    }
}

/// 写。⛔ 没有配对的读，理由见模块文档那条 🔴。
///
/// 三个命令都是 `async fn` 而函数体里一个 `.await` 都没有，这是有意的：同步 command 跑在
/// 主线程上会冻住界面，而 `SecItem*` 是毫秒级的系统调用——与 `open_file` / `save_file`
/// 同一档（那条说明写在 `commands.rs` 里 `open_file` 的文档上）。唯一可能慢的是第一次
/// 那一个授权弹窗，而那一刻用户在看弹窗，不在敲键盘。
#[command]
pub async fn set_oss_secret(secret: String) -> Result<(), SecretError> {
    let value = clean(&secret).ok_or_else(SecretError::empty)?;
    backend::write(value)
}

/// 删（面板上「清除」那一个按钮）。不存在也算成功。
#[command]
pub async fn delete_oss_secret() -> Result<(), SecretError> {
    backend::delete()
}

/// 只回「配没配」。
///
/// ⚠️ 这一条**会**把读失败原样报出去，而不是退化成 `configured: false`：一项读不出文本的密钥
/// 与一项不存在的密钥，对用户是两句不同的话（见 [`SecretError::Corrupt`]）。
/// 「没有这一项」显示成「未配置」，`keychain` 与 `corrupt` 显示成失败，才是对的。
#[command]
pub async fn oss_secret_status() -> Result<SecretStatus, SecretError> {
    Ok(SecretStatus { configured: load_access_key_secret()?.is_some() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的密钥值。刻意选一个**搜得到**的串，好让「文案里没有它」是一条真的断言
    /// （与 `oss.rs` 里那条同套路数）。
    const SECRET: &str = "SECRET-VALUE-DO-NOT-LEAK";

    #[test]
    fn 首尾空白去掉而中间不动() {
        // 从控制台那一行复制时带上的就是首尾这些；中间的空白是用户真填错了，不该替他改
        assert_eq!(clean(&format!("  \n{SECRET}\n ")), Some(SECRET));
        assert_eq!(clean(SECRET), Some(SECRET));
        assert_eq!(clean("AB CD"), Some("AB CD"), "只去首尾，不压缩中间");
    }

    #[test]
    fn 全空白等于没填() {
        assert_eq!(clean(""), None);
        assert_eq!(clean("   \t\n "), None);
    }

    #[test]
    fn 零字节与非文本都算用不了() {
        // 空字节：`generic_password` 对一个存了空值的项回的是 `Ok(vec![])`，
        // 而我们的写入路径产不出它，所以只能是外部写的
        assert!(matches!(decode(Vec::new()), Err(SecretError::Corrupt { .. })));
        assert!(matches!(decode(vec![0xFF, 0xFE]), Err(SecretError::Corrupt { .. })));
        assert_eq!(decode(SECRET.as_bytes().to_vec()).unwrap(), SECRET);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn 授权被拒与点取消各有一句中文() {
        // 这两个码是用户第一次配 OSS 时最可能撞上的：一个模态框，两个按钮。
        // 这里用字面量而不是码表里的常量，是为了让「码表写错一个数字」在这条上就红
        // （`AUTH_FAILED` 另有 `backend::tests` 里那条与 sys 常量对的用例兜底，
        // `USER_CANCELED` 没有权威出处可对，只能钉在这个值上）
        for code in [-25293, -128] {
            let text = backend::message_for(code, Some("Apple 那句英文原话"));
            assert!(text.contains("弹窗"), "{text}");
            assert!(!text.contains("Apple"), "{text}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn 认不出的码退回苹果的原话与数字() {
        assert_eq!(
            backend::message_for(-36, Some("A client error has occurred.")),
            "钥匙串操作失败（-36）：A client error has occurred."
        );
        assert_eq!(backend::message_for(-36, None), "钥匙串操作失败（-36）。");
    }

    #[test]
    fn 状态的_json_形状被钉住() {
        // 与 `src/ipc/secrets.ts` 的 `SecretStatus` 对照（手写镜像，没有代码生成）
        assert_eq!(serde_json::to_string(&SecretStatus { configured: true }).unwrap(), r#"{"configured":true}"#);
    }

    #[test]
    fn 四种失败的_json_形状被钉住() {
        // 四句都上线路（`{kind, message}`），因为 `src/ipc/secrets.ts` 只透传不重写：
        // 句子在前端再写一份，就是上面那一节说的漂移
        let cases = [
            (
                SecretError::empty(),
                r#"{"kind":"empty","message":"这里要填密钥。要清掉已经存着的那一份，请点「清除」。"}"#,
            ),
            (
                SecretError::corrupt(),
                r#"{"kind":"corrupt","message":"钥匙串里那一项读不出可用的密钥（可能被别的工具改过）。点「清除」，再重新填一次。"}"#,
            ),
            (
                SecretError::unsupported(),
                r#"{"kind":"unsupported","message":"当前系统还没有可用的钥匙串：密钥目前只能存在 macOS 的登录钥匙串里。"}"#,
            ),
            (
                SecretError::Keychain { code: -25293, message: "钥匙串拒绝了这次读写。".to_owned() },
                r#"{"kind":"keychain","code":-25293,"message":"钥匙串拒绝了这次读写。"}"#,
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(serde_json::to_string(&err).unwrap(), expected);
        }
    }

    #[test]
    fn 每一条失败都读得回那同一句话() {
        // `message()` 是 `upload_image` 拿它填 `NotConfigured.reason` 的那一条路。
        // 句子读不回来的话，第二个出口只能自己编一句——那正是漂的起点
        assert_eq!(SecretError::empty().message(), EMPTY_MESSAGE);
        assert_eq!(SecretError::corrupt().message(), CORRUPT_MESSAGE);
        assert_eq!(SecretError::unsupported().message(), UNSUPPORTED_MESSAGE);
        let keychain = SecretError::Keychain { code: -1, message: "钥匙串操作失败（-1）。".to_owned() };
        assert_eq!(keychain.message(), "钥匙串操作失败（-1）。");
    }

    #[test]
    fn 调试输出与序列化里都没有密钥() {
        // 🔴 这一条是整个模块的立身之本：四条失败路径加一个状态，全都不带值
        let errors = [
            SecretError::empty(),
            SecretError::corrupt(),
            SecretError::unsupported(),
            SecretError::Keychain { code: -25293, message: "钥匙串拒绝了这次读写。".to_owned() },
        ];
        for err in &errors {
            let json = serde_json::to_string(err).unwrap();
            assert!(!json.contains(SECRET), "失败序列化里带了密钥：{json}");
            assert!(!format!("{err:?}").contains(SECRET), "失败的 Debug 里带了密钥：{err:?}");
        }
        let status = format!("{:?}", SecretStatus { configured: true });
        assert!(!status.contains(SECRET), "状态里带了密钥：{status}");
    }

    #[test]
    fn 服务名不跟着_bundle_id_走() {
        // `tauri.conf.json` 的 identifier 是 `app.vela.m1`（带里程碑后缀）。
        // 钥匙串项按 SERVICE 寻址，跟错它的后果是升级之后一片「未配置」
        assert_ne!(SERVICE, "app.vela.m1");
        assert!(!SERVICE.contains(".m1"), "{SERVICE}");
    }
}
