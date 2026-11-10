//! 微信读书网关回包的**数据结构**：只描述这一层认得的字段，其余全部忽略。
//!
//! ## 字段形状是真数据量出来的，不是文档写的
//!
//! 三本真书的原始回包（`/Volumes/xuankeData/Document/readbook/.weread/raw-*.json`）里：
//!
//! | 事实 | 证据 | 于是这一层怎么写 |
//! |---|---|---|
//! | `updated[]` 的 `bookmarkId`、`bookId` 是**字符串** | 三本逐条一致 | id 一律按字符串收；[`flexible_id`] 额外容忍数字，见下面那条 ⚠️ |
//! | `updated[]` **不一定带 `chapterIdx`** | 第三本（`912425`）首条就没有，前两本有 | 全部可选。当成必填会在真数据上直接解析失败 |
//! | 想法套在 `{reviewId, review: {…}}` 里，内层**又**有一个 `reviewId` | 两本的每一条都如此 | [`ReviewEntry`] 的 untagged 两个分支，取内层那份（与 `r.review ?? r` 同） |
//! | 不带 `synckey` 请求 `/book/bookmarklist` 时 `updated` 就是**全集**，`removed` 恒为空 | 三本分别 37 / 69 / 70 条，与笔记文件里的计数一致 | 这一层不建模 `removed`，⛔ 不做增量删除 |
//! | `errcode` / `errmsg` / `hasMore` / `synckey` 是**数字** | CLI 里 `hasMore !== 1`、`synckey === 0` 那两处判据都成立 | 用 `i64`，判据在 [`gateway`](super::gateway) |
//!
//! ⚠️ **`/user/notebooks` 那一格没有留原始回包**（CLI 只在 `--pick` 时 dump）。它的 `bookId`
//! 到底是字符串还是数字**没验过**，所以 [`BookNotebook`] 的 id 走 [`flexible_id`] 两种都收。
//! 这不是「防御性编程」，是**承认有一格证据缺口**；M8-3 首轮真跑要用它兜住，
//! 跑完就该把真实回包 dump 下来，把这条 ⚠️ 换成实测结论。
//!
//! 🔴 **`abstract` 是 Rust 关键字**，字段叫 `abstract_text` 并用 `rename` 指回线上名。
//! 这类想法带 `abstract`（它针对的那段正文），不带就只剩一句感想、日后回不到上下文。

use serde::Deserialize;

/// `String` 或数字都收，统一成字符串。见模块开头那条 ⚠️ 证据缺口。
fn flexible_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error as _;
    match Option::<serde_json::Value>::deserialize(deserializer)? {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Bool(_)) | Some(serde_json::Value::Array(_)) | Some(serde_json::Value::Object(_)) => {
            Err(D::Error::custom("id 字段只接受字符串或数字"))
        }
        Some(serde_json::Value::String(text)) => Ok(Some(text)),
        Some(serde_json::Value::Number(number)) => Ok(Some(number.to_string())),
    }
}

/// 书的标题与作者。回包里这一坨字段很多（封面、blurhash、状态码……），只收三个。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookInfo {
    #[serde(default, deserialize_with = "flexible_id")]
    pub book_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
}

/// 章目录里的一条。`chapter_uid` 是划线的归属键，`chapter_idx` 只用来**排序**。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "flexible_id")]
    pub chapter_uid: Option<String>,
    #[serde(default)]
    pub chapter_idx: Option<i64>,
}

/// 一条划线。
///
/// ⚠️ 除 `bookmark_id` 之外**全部可选**，这是真数据逼出来的形状（见模块表格第二行），
/// 不是偷懒。`bookmark_id` 保持必填：它是锚点的唯一来源，缺了就没有「这一条」的地址，
/// 那比显示不出正文更严重——宁可在解析这一步就失败，也不要在笔记里静默写一串空锚点。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub bookmark_id: String,
    #[serde(default, deserialize_with = "flexible_id")]
    pub chapter_uid: Option<String>,
    #[serde(default)]
    pub chapter_idx: Option<i64>,
    /// 正文位置，形如 `"2959-3007"`。排序与想法对位都靠它。
    #[serde(default)]
    pub range: Option<String>,
    #[serde(default)]
    pub mark_text: Option<String>,
    #[serde(default)]
    pub create_time: Option<i64>,
}

/// `/book/bookmarklist` 的回包。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkList {
    #[serde(default)]
    pub book: Option<BookInfo>,
    #[serde(default)]
    pub chapters: Vec<Chapter>,
    /// 🔴 全集，不是增量（模块表格第四行）。
    #[serde(default)]
    pub updated: Vec<Mark>,
}

/// 一条想法的正文。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCore {
    pub review_id: String,
    #[serde(default, deserialize_with = "flexible_id")]
    pub chapter_uid: Option<String>,
    #[serde(default)]
    pub range: Option<String>,
    /// 用户写的那句话
    #[serde(default)]
    pub content: Option<String>,
    /// 这条想法针对的那段正文。挂在划线下面的想法通常不用它（原文就是那条划线），
    /// 散在正文上的想法**只有靠它**才回得去上下文。
    #[serde(rename = "abstract", default)]
    pub abstract_text: Option<String>,
    #[serde(default)]
    pub create_time: Option<i64>,
}

/// `/review/list/mine` 回包里的一个条目。
///
/// 🔴 真数据是**外面一层 `{reviewId, review: {…}}`**，而 CLI 写的是 `r.review ?? r`
/// ——那个 `?? r` 说明平铺的形态也可能出现。untagged 两个分支都收：先试带壳的，
/// 试不上再按平铺的收。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum ReviewEntry {
    Wrapped { review: ReviewCore },
    Flat(ReviewCore),
}

impl ReviewEntry {
    /// 取真正带正文的那一份（外层那个重复的 `reviewId` 丢掉）。
    pub fn core(&self) -> &ReviewCore {
        match self {
            ReviewEntry::Wrapped { review } | ReviewEntry::Flat(review) => review,
        }
    }
}

/// 一页「我的想法」。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewsPage {
    #[serde(default)]
    pub reviews: Vec<ReviewEntry>,
    /// ⚠️ 判据是 `== 1`，不是「非零」——CLI 逐字如此，本层保持同判据。
    #[serde(default)]
    pub has_more: Option<i64>,
    #[serde(default)]
    pub synckey: Option<i64>,
}

/// `/user/notebooks` 里的一本书（笔记计数那一层）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookNotebook {
    #[serde(default, deserialize_with = "flexible_id")]
    pub book_id: Option<String>,
    /// 排序游标，`lastSort` 就是它。
    #[serde(default)]
    pub sort: Option<i64>,
    #[serde(default)]
    pub note_count: Option<i64>,
    #[serde(default)]
    pub review_count: Option<i64>,
    #[serde(default)]
    pub bookmark_count: Option<i64>,
    #[serde(default)]
    pub book: Option<BookInfo>,
}

/// 一页书目。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebooksPage {
    #[serde(default)]
    pub books: Vec<BookNotebook>,
    #[serde(default)]
    pub has_more: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前两本真书的**形状**（字段名、可缺性、嵌套层级），正文一律换成合成内容。
    /// 🔴 真数据里那是第三方书的原文，⛔ 不进这个仓库。
    const BOOKMARK_LIST: &str = r##"{
      "synckey": 1730000000,
      "updated": [
        {"bookId":"3300000001","chapterIdx":1,"chapterUid":54,"range":"515-528",
         "markText":"合成正文甲","bookmarkId":"3300000001_54_515-528","type":4,"createTime":1740000000},
        {"bookId":"3300000001","chapterUid":54,"range":"60-72",
         "markText":"合成正文乙","bookmarkId":"3300000001_54_60-72","type":4,"createTime":1740000100}
      ],
      "removed": [],
      "chapters": [
        {"title":"第一章","chapterUid":54,"chapterIdx":1},
        {"title":"第二章","chapterUid":77,"chapterIdx":2}
      ],
      "book": {"bookId":"3300000001","title":"合成之书","author":"某人","cover":"x.jpg","soldout":0,
               "coverBoxInfo":{"blurhash":"abc","colors":[["#fff"]]}}
    }"##;

    #[test]
    fn 划线记录里的章号不是必填() {
        let list: BookmarkList = serde_json::from_str(BOOKMARK_LIST).expect("可缺字段不该让解析失败");
        assert_eq!(list.updated.len(), 2);
        assert_eq!(list.book.as_ref().and_then(|b| b.title.as_deref()), Some("合成之书"));
        assert_eq!(list.chapters.len(), 2);
        // 第二笔没有 chapterIdx —— 第三本真书的首条就是这个形状，当必填会直接解析失败
        assert_eq!(list.updated[0].chapter_idx, Some(1));
        assert_eq!(list.updated[1].chapter_idx, None);
        assert_eq!(list.updated[0].bookmark_id, "3300000001_54_515-528");
        // 数字的 chapterUid 收进来统一成字符串，与章目录那侧同一个键
        assert_eq!(list.updated[0].chapter_uid.as_deref(), Some("54"));
        assert_eq!(list.chapters[0].chapter_uid.as_deref(), Some("54"));
    }

    #[test]
    fn 未知的字段不影响解析() {
        // 回包里的 cover / soldout / type / synckey 这一层全都不建模，多一个字都不该炸
        let list: BookmarkList = serde_json::from_str(BOOKMARK_LIST).expect("未知字段该被忽略");
        assert_eq!(list.updated[0].range.as_deref(), Some("515-528"));
    }

    #[test]
    fn 想法的两种包装都能收到正文() {
        let pages: ReviewsPage = serde_json::from_str(
            r#"{
              "hasMore": 1,
              "synckey": 12345,
              "reviews": [
                {"reviewId":"r1","likesCount":0,
                 "review":{"reviewId":"r1","chapterUid":54,"range":"515-528",
                           "content":"合成想法甲","createTime":1740000050,"htmlContent":"<p/>","topics":[]}},
                {"reviewId":"r2","chapterUid":54,"content":"合成想法乙","createTime":1740000060,
                 "abstract":"合成的一段正文"}
              ]
            }"#,
        )
        .expect("带壳与平铺都该解析出来");
        assert_eq!(pages.has_more, Some(1));
        assert_eq!(pages.synckey, Some(12_345));
        let cores: Vec<&ReviewCore> = pages.reviews.iter().map(ReviewEntry::core).collect();
        assert_eq!(cores[0].review_id, "r1");
        assert_eq!(cores[0].range.as_deref(), Some("515-528"));
        assert_eq!(cores[0].abstract_text.as_deref(), None);
        assert_eq!(cores[1].review_id, "r2");
        // 🔴 `abstract` 是 Rust 关键字，靠 rename 指回线上那个键名
        assert_eq!(cores[1].abstract_text.as_deref(), Some("合成的一段正文"));
    }

    #[test]
    fn 缺正文的划线仍然解析得动() {
        // markText 缺失时渲染成空正文，而不是整次同步失败——少一行比整本拿不到有用
        let list: BookmarkList = serde_json::from_str(
            r#"{"updated":[{"bookmarkId":"bk_1_1-2","chapterUid":1,"range":"1-2","createTime":1}]}"#,
        )
        .expect("正文可缺");
        assert_eq!(list.updated[0].mark_text, None);
    }

    #[test]
    fn 没有标识的划线在解析这一步就失败() {
        // ⛔ 不要在笔记里静默写一串空锚点：bookmarkId 是那一行的地址
        assert!(serde_json::from_str::<BookmarkList>(r#"{"updated":[{"chapterUid":1,"markText":"x"}]}"#).is_err());
        assert!(serde_json::from_str::<ReviewsPage>(r#"{"reviews":[{"content":"x"}]}"#).is_err());
    }

    #[test]
    fn 数字与字符串的两种都收但布尔值报错() {
        // ⚠️ 数字那一支是**证据缺口**：/user/notebooks 没留原始回包，所以两种都兜住。
        // 布尔/数组/对象不是任何一种可能的 id，那种情况要报错而不是猜。
        let page: NotebooksPage = serde_json::from_str(
            r#"{"books":[{"bookId":123,"sort":1740000000,"noteCount":37,"book":{"title":"甲"}},
                         {"bookId":"3300000001","sort":1740000100,"reviewCount":1},
                         {"bookId":null}],"hasMore":1}"#,
        )
        .expect("id 字符串或数字都该收");
        assert_eq!(page.books[0].book_id.as_deref(), Some("123"));
        assert_eq!(page.books[1].book_id.as_deref(), Some("3300000001"));
        assert_eq!(page.books[2].book_id, None);
        assert_eq!(page.books[0].note_count, Some(37));
        assert_eq!(page.books[0].book.as_ref().and_then(|b| b.title.as_deref()), Some("甲"));
        assert!(serde_json::from_str::<NotebooksPage>(r#"{"books":[{"bookId":true}]}"#).is_err());
    }
}
