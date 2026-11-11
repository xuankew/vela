//! 全 App 唯一一处建 `reqwest::Client` 的地方：OSS 上传（M7-2）与微信读书网关（M8-2）共用。
//!
//! ## 为什么不能各建一个
//!
//! 建 client 之前有一句 `rustls::crypto::ring::default_provider().install_default()`，而漏掉它
//! 的失败方式是**进程里第一次 HTTPS 请求当场 panic**（见下面「TLS」）。两个模块各写一遍，
//! 就是两个「将来只有一处被改对」的机会；而第二处漏掉时的症状与第一处一模一样地难查。
//!
//! ## TLS：为什么必须自己装一个 crypto provider
//!
//! 走 reqwest 的 `rustls-no-provider`，也就是 rustls + `rustls-platform-verifier`
//! （**系统信任库**），与 M6 自动更新同一套：不引入第二套 CA，也不往锁文件里加任何东西
//! （依赖声明的理由与许可证核实见根 `Cargo.toml` 的 M7-2 那段）。
//!
//! 🔴 但 `rustls-no-provider` 这个名字是字面意思：reqwest 在 `build()` 时会取
//! `CryptoProvider::get_default()`，取不到就**当场 panic**（`async_impl/client.rs` 里那句
//! "No rustls crypto provider is configured"）。而 panic 在 `async fn` 的 command 里是最坏
//! 的一种失败——前端那个 `invoke` 的 Promise 永远不会 resolve，用户看到的是「点了没反应」。
//! tauri 核心与 updater 各自在某条路径上 `install_default()` 过，但那两条都是**按需**触发的，
//! 第一次出站完全可能走在它们前面。所以 [`client`] 自己先装（ring，就是它们装的那一个），
//! 让这一刻不依赖任何别的东西是否先跑过。
//!
//! ## 为什么关掉跳转
//!
//! 两条路都带着凭证（OSS 的 `Authorization`、微信读书的 `Authorization: Bearer`）。跟随跳转
//! 等于把凭证原样发给跳转目标；而用户最后看到的会是目标站点的一句错话，真正错的是地址。
//! OSS 那一条还把 3xx 翻成「bucket 与 region 不是同一对」（`oss::message_for`），
//! 微信读书那一条则由 `weread::classify` 把非 2xx 原样报出来。
//!
//! ## 超时是**单次请求**的上限
//!
//! 不是一整次同步的上限：M8-3 一本书一次请求，几十本加起来可以是几分钟，而这几分钟里
//! 每一次请求都应该有自己的 30 秒。取消走 `TaskRegistry`，不靠这个数字。

use std::sync::OnceLock;
use std::time::Duration;

/// 单次请求的总超时，含把整个 body 发完/收完。
///
/// 30 秒是按「用户在等一次粘贴 / 一次翻页」定的上限，不是按服务端能力定的：
/// 一张 5 MB 的截图在家里宽带上也一两秒就完，走到 30 秒说明这条路本来就不通。
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 共用一个 client：连接池与 TLS 配置都复用，第二次请求不用再付一次握手。
///
/// 为什么是 `OnceLock` 而不是 `tauri::State`：这层没有要注入的依赖，也不需要按窗口区分；
/// 而调用方全是 `async fn`，两次请求可能同时在两个 worker 上进来，`get_or_init`
/// 会把后到的那个挡住等前一个建完——只可能建一个，不可能建两个。
///
/// ⚠️ 建不出来时把错误**存起来**而不是 panic：command 里 panic 会让前端那个 `invoke` 的
/// Promise 永远挂着，用户看到的是「点了没反应」，而这本来只是一句能显示的失败。
/// 这种失败也不会自愈，所以只建一次就够。
pub(crate) fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // 🔴 顺序是硬要求：reqwest 在 `build()` 里取 `CryptoProvider::get_default()`，
            // 取不到就直接 panic（见模块文档「TLS」）。这里先装，让这一刻不依赖
            // tauri / updater 是否恰好在这之前跑过它们各自那一条
            ensure_crypto_provider()?;
            reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 建得出_client_且不_panic_也只建一个() {
        // 这一条是真的走一遍 `reqwest::Client::builder().build()`。
        // 它存在的唯一理由是那句 "No rustls crypto provider is configured"：
        // `rustls-no-provider` feature 下 reqwest 取不到进程默认 provider 就 panic，
        // 而 panic 在这层是最坏的失败（前端的 Promise 永远挂着）。除了真的建一次，
        // 没有任何静态检查能告诉我们 ring 那一份到底在不在。
        // ⚠️ 从 `oss.rs` 搬到这里的：现在两条出站路共用这一个 client，
        // 所以「建得出来」属于这一层，而不是某一条业务路
        let first = client().unwrap();
        // 第二次拿到的必须是同一个：连接池复用这件事不许靠调用方记得传
        let second = client().unwrap();
        assert!(std::ptr::eq(first, second), "两次 build 出了两个 client");
    }

    #[test]
    fn 单次请求的上限是三十秒() {
        // `oss::UPLOAD_TIMEOUT` 与微信读书的错误文案都从这一个数念出去
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(30));
    }
}
