//! 网关的**请求体**与**回包判定**：不发请求、不读钥匙串、不碰网络。
//!
//! ## 为什么这一段也留在内核
//!
//! 「发一次 HTTP」显然是 `src-tauri` 的活，但「这一次调用到底该不该算失败」是纯判断，
//! 而且它是整条同步路上最容易写错、又最难在真机上复现的一段：服务端要求升级 Skill
//! 只在 key 过期的那一类账号上出现，HTTP 200 里夹 `errcode` 是这套 API 的常态。
//! 把判据写成 `classify(status, body)` 这样一个函数，就能在本机把五种失败全测一遍，
//! 而 `src-tauri` 那一层只剩「拿到 `(status, bytes)`，交给这里」。
//!
//! ## 🔴 回包 200 不等于成功
//!
//! `errcode` 缺失或为 0 才算成功，其余全部失败——**而 `errmsg` 本来就是中文人话**
//! （实测 `errcode=-2010` 配「用户不存在」）。⛔ 不许把它压成「服务繁忙」一类硬编码
//! 通用文案，那句是照用户的既定要求写的。
//!
//! ## ⚠️ `upgrade_info` 是一条闸门，不是警告
//!
//! 出现就**停**：服务端认为这个 Skill 版本已经不能用，继续发后面的请求只会拿到更多
//! 看不懂的结果。这一条排在 `errcode` 判定**之前**（CLI 同序），因为要求升级时回包里
//! 往往同时带非零 `errcode`，先报哪个决定用户看到的一句话。

use serde_json::{Map, Value};

/// 网关地址。放在内核是为了让「只允许打这一个 host」这件事有一条测试可钉。
pub const GATEWAY_URL: &str = "https://i.weread.qq.com/api/agent/gateway";

/// Skill 版本。⚠️ 官方 Skill 仓库用它来做兼容闸门，写死在这里、由 [`request_body`] 最后写进
/// 请求体——**顺序有意**：业务参数是平铺在同一层的，先写版本就会被同名参数盖掉。
pub const SKILL_VERSION: &str = "1.0.5";

/// 列表接口的翻页硬上限。
///
/// 🔴 有上限**不是因为页多**（几十本书两页就完了），而是因为游标判据一旦不成立——
/// 服务端一直回 `hasMore=1` 却不推进 `lastSort`——一个 `while` 就是不终止的死循环，
/// 而循环的另一头是真实网络请求。CLI 当年写的是 `page < 40` / `page < 60`，这里合成一条。
pub const MAX_PAGES: usize = 60;

/// 一次网关调用的业务参数。
pub type Params<'a> = &'a [(&'a str, Value)];

/// 拼出请求体：`{api_name, …业务参数平铺…, skill_version}`。
///
/// ⚠️ **平铺，不嵌套**。官方的写法是 `body: { api_name: '/book/bookmarklist', bookId: '…' }`，
/// 而不是 `{api_name, params: {…}}`。嵌套进去服务端读不到参数，症状是一个看不懂的
/// `errcode`——所以这一条有专门的测试。
pub fn request_body(api_name: &str, params: Params<'_>) -> Value {
    let mut body = Map::new();
    body.insert("api_name".to_owned(), Value::String(api_name.to_owned()));
    for (key, value) in params {
        body.insert((*key).to_owned(), value.clone());
    }
    // 最后写：业务参数与它同层，先写就可能被同名键盖掉
    body.insert("skill_version".to_owned(), Value::String(SKILL_VERSION.to_owned()));
    Value::Object(body)
}

/// 一次调用的失败原因。每个变体带的都是**可以直接给用户看的一句中文**。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayError {
    /// 服务端要求升级 Skill：继续问下去也不会得到可信结果
    Upgrade { message: String },
    /// 非 2xx，或回包 200 但 `errcode` 非 0
    Api { message: String },
    /// 回包压根不是 JSON（网关挂了、代理介入了、登录页把请求劫持了）
    NotJson { message: String },
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GatewayError::Upgrade { message } | GatewayError::Api { message } | GatewayError::NotJson { message } => {
                f.write_str(message)
            }
        }
    }
}

impl std::error::Error for GatewayError {}

/// 判定一次调用的成败。
///
/// - `api_name`：只为拼出可读的失败文案，判定本身不看它
/// - `status`：HTTP 状态码
/// - `body`：已经把字节解析成 JSON 的结果；解析失败一律传 `None`
///   ⚠️ 「回包不是 JSON」这件事**不能在这一层里去 parse 一遍**——那是 `src-tauri` 的活，
///   这里只负责「有了 `(status, Option<Value>)` 之后算什么成败」，两层各测各的。
///
/// 成功时回整个 JSON 值，由调用方按各自的接口形状反序列化。
pub fn classify(api_name: &str, status: u16, body: Option<Value>) -> Result<Value, GatewayError> {
    let Some(json) = body else {
        return Err(GatewayError::NotJson { message: format!("{api_name} HTTP {status}（回包不是 JSON）") });
    };

    // 闸门排在 errcode 之前：要求升级时这两个常常同时成立，先报能行动的那一个
    if let Some(upgrade) = json.get("upgrade_info").filter(|v| !v.is_null()) {
        let detail =
            upgrade.get("message").and_then(Value::as_str).unwrap_or("见官方 Skill 仓库 Tencent/WeChatReading");
        return Err(GatewayError::Upgrade { message: format!("服务端要求升级 Skill：{detail}") });
    }

    let errcode = json.get("errcode").and_then(Value::as_i64);
    let ok = (200..300).contains(&status) && matches!(errcode, None | Some(0));
    if ok {
        return Ok(json);
    }

    // 文案与 CLI 同构：`{api} HTTP {status} errcode={code} {errmsg}` 再去尾部空白。
    // ⚠️ 三个片段都可能缺席（网关直接回 502 就没有 errcode），所以是拼片段而不是套模板。
    let mut parts = vec![format!("{api_name} HTTP {status}")];
    if let Some(code) = errcode {
        parts.push(format!("errcode={code}"));
    }
    if let Some(msg) = json.get("errmsg").and_then(Value::as_str) {
        if !msg.is_empty() {
            parts.push(msg.to_owned());
        }
    }
    Err(GatewayError::Api { message: parts.join(" ") })
}

/// 下一页「我的想法」要带的 `synckey`；`None` = 到此为止。
///
/// 三条停止条件全是 CLI 逐字搬过来的：`hasMore != 1` 停；`synckey` 缺失或为 0 停；
/// 服务端回的游标**和刚发出去的那个一样**也停。第三条是防死循环的关键——
/// 游标不推进却一直说「还有」，就永远在重复拉同一页。
pub fn next_review_synckey(sent: Option<i64>, page: &super::model::ReviewsPage) -> Option<i64> {
    if page.has_more != Some(1) {
        return None;
    }
    page.synckey.filter(|key| *key != 0 && Some(*key) != sent)
}

/// 下一页书目要带的 `lastSort`；`None` = 到此为止（或这一页没法继续）。
///
/// ⚠️ 判据取**最后一条的 `sort`**，而不是「翻到第 N 页」。列表是按笔记时间倒序排的，
/// 游标就是那个时间。如果最后一条不带 `sort`，这里回 `None` 直接停——
/// 宁可少列几本，也不要拿一个空游标重头再列一遍（那会变成同一批书无限重复）。
pub fn next_notebook_sort(page: &super::model::NotebooksPage) -> Option<i64> {
    if page.has_more != Some(1) || page.books.is_empty() {
        return None;
    }
    page.books.last().and_then(|book| book.sort)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::weread::model::{BookNotebook, NotebooksPage, ReviewsPage};
    use serde_json::json;

    fn params<'a>(items: &[(&'a str, i64)]) -> Vec<(&'a str, Value)> {
        items.iter().map(|(k, v)| (*k, json!(v))).collect()
    }

    #[test]
    fn 请求体把业务参数平铺在同一层() {
        let body = request_body("/book/bookmarklist", &[("bookId", Value::String("3300000001".to_owned()))]);
        // 🔴 不是 {api_name, params: {…}}：嵌套进去服务端读不到参数，症状是一个看不懂的 errcode
        assert_eq!(body["bookId"], json!("3300000001"));
        assert!(body.get("params").is_none());
        assert_eq!(body["api_name"], json!("/book/bookmarklist"));
        assert_eq!(body["skill_version"], json!(SKILL_VERSION));
    }

    #[test]
    fn 版本号不会被同名参数盖掉() {
        let list = params(&[("skill_version", 9), ("count", 100)]);
        let body = request_body("/user/notebooks", &list);
        // 顺序有意：业务参数先插、版本最后插（见 request_body 的注释）
        assert_eq!(body["skill_version"], json!(SKILL_VERSION));
        assert_eq!(body["count"], json!(100));
    }

    #[test]
    fn 只允许打网关那一个主机() {
        // 这条不是给 HTTP 层看的，是给「将来有人加第二个 base」那一次看的
        assert!(GATEWAY_URL.starts_with("https://i.weread.qq.com/api/agent/gateway"));
    }

    #[test]
    fn 回包成功时把整个递出去() {
        let body = json!({"errcode": 0, "errmsg": "ok", "books": []});
        let ok = classify("/user/notebooks", 200, Some(body.clone())).expect("errcode=0 是成功");
        assert_eq!(ok, body);
        // errcode 缺席也算成功（这套接口不是每个接口都带）
        assert!(classify("/user/notebooks", 200, Some(json!({"books": []}))).is_ok());
    }

    #[test]
    fn 后端的人话文案原样透出() {
        let err = classify("/user/notebooks", 200, Some(json!({"errcode": -2010, "errmsg": "用户不存在"})))
            .expect_err("非零 errcode 是失败");
        assert_eq!(err.to_string(), "/user/notebooks HTTP 200 errcode=-2010 用户不存在");
        // 🔴 ⛔ 不许压成「服务繁忙」：后端已经给了可读的一句，盖掉它就是丢信息
        assert!(err.to_string().contains("用户不存在"));
    }

    #[test]
    fn 三个片段各自缺席时文案都还读得通() {
        let only_status = classify("/book/bookmarklist", 502, Some(json!({}))).expect_err("非 2xx 是失败");
        assert_eq!(only_status.to_string(), "/book/bookmarklist HTTP 502");
        let code_only = classify("/book/bookmarklist", 200, Some(json!({"errcode": 1}))).expect_err("失败");
        assert_eq!(code_only.to_string(), "/book/bookmarklist HTTP 200 errcode=1");
        let empty_msg =
            classify("/book/bookmarklist", 200, Some(json!({"errcode": 1, "errmsg": ""}))).expect_err("失败");
        assert_eq!(empty_msg.to_string(), "/book/bookmarklist HTTP 200 errcode=1");
    }

    #[test]
    fn 回包解析不出来时报一句能行动的话() {
        let err = classify("/book/bookmarklist", 200, None).expect_err("解析失败");
        assert!(matches!(err, GatewayError::NotJson { .. }));
        assert_eq!(err.to_string(), "/book/bookmarklist HTTP 200（回包不是 JSON）");
        // 代理把请求劫持到登录页时就是这个形状：200 + 一坨 HTML
        assert!(classify("/book/bookmarklist", 401, None).unwrap_err().to_string().contains("HTTP 401"));
    }

    #[test]
    fn 要求升级时先报闸门且文案取自回包() {
        let err = classify(
            "/user/notebooks",
            200,
            Some(json!({
                "upgrade_info": {"message": "请升级到 1.0.6"},
                "errcode": -4001,
                "errmsg": "版本过低",
            })),
        )
        .expect_err("闸门");
        assert!(matches!(err, GatewayError::Upgrade { .. }));
        assert_eq!(err.to_string(), "服务端要求升级 Skill：请升级到 1.0.6");
    }

    #[test]
    fn 没带那一句时给一个能去的地方() {
        let err = classify("/user/notebooks", 200, Some(json!({"upgrade_info": {"code": 1}}))).expect_err("闸门");
        assert!(err.to_string().contains("Tencent/WeChatReading"), "{err}");
        // 显式的 null 不是「要求升级」
        assert!(classify("/user/notebooks", 200, Some(json!({"upgrade_info": null, "books": []}))).is_ok());
    }

    #[test]
    fn 想法翻页的三条停止条件() {
        let page = |has_more: Option<i64>, synckey: Option<i64>| ReviewsPage { reviews: Vec::new(), has_more, synckey };
        assert_eq!(next_review_synckey(Some(0), &page(Some(1), Some(500))), Some(500));
        assert_eq!(next_review_synckey(Some(0), &page(Some(0), Some(500))), None, "没有还有下一页");
        assert_eq!(next_review_synckey(Some(0), &page(Some(1), Some(0))), None, "游标为 0");
        assert_eq!(next_review_synckey(Some(0), &page(Some(1), None)), None, "游标缺席");
        // 🔴 游标不推进却一直说「还有」：不停就是同一页无限重复拉
        assert_eq!(next_review_synckey(Some(500), &page(Some(1), Some(500))), None);
        // 判据是 == 1，不是非零
        assert_eq!(next_review_synckey(Some(0), &page(Some(2), Some(500))), None);
    }

    #[test]
    fn 书目翻页取最后一条的游标() {
        let page = |sorts: &[Option<i64>], has_more: Option<i64>| NotebooksPage {
            books: sorts
                .iter()
                .map(|sort| BookNotebook {
                    book_id: None,
                    sort: *sort,
                    note_count: None,
                    review_count: None,
                    bookmark_count: None,
                    book: None,
                })
                .collect(),
            has_more,
        };
        assert_eq!(next_notebook_sort(&page(&[Some(10), Some(7)], Some(1))), Some(7));
        assert_eq!(next_notebook_sort(&page(&[Some(10), Some(7)], Some(0))), None);
        assert_eq!(next_notebook_sort(&page(&[], Some(1))), None, "空页停，否则永远翻不到东西");
        // ⚠️ 最后一条不带游标 → 宁可少列几本，也不拿空游标从头再列一遍（那会无限重复）
        assert_eq!(next_notebook_sort(&page(&[Some(10), None], Some(1))), None);
    }
}
