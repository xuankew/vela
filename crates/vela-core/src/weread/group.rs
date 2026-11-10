//! 划线按章分组、想法对位到划线下面。
//!
//! ## 这两件事的顺序不能反，也不能并成一步
//!
//! 分组决定「章与章、条与条的先后」，对位决定「哪条想法挂在哪条划线底下、哪些散着」。
//! 渲染只是把这两步的结果写成行。分开的收益全在可测性：真数据里 4 条想法有 2 条挂在
//! 划线下、2 条直接写在正文上，而**后者带 `abstract`**（它针对的那段原文）——
//! 混在渲染里写，这三种情况里只要有一种回归，症状都是「笔记里少了几条而没人报错」。
//!
//! ## 🔴 对位只做精确匹配
//!
//! 键是 `chapterUid|range` **两个都逐字相等**。⛔ 不做模糊匹配、不做「同一章就算」：
//! 差一个字符就把想法挂到另一句话下面，而那比挂不上更糟——挂不上还会留在
//! 「正文上的想法」那一节里看得见，挂错了就是永久看不见的错位。
//!
//! ## ⚠️ 两处刻意不抄 JS 的地方
//!
//! 1. JS 的章内排序比较器是 `rangeStart(x) - rangeStart(y) || x.createTime - y.createTime`，
//!    其中 `createTime` 缺失时那一步是 **NaN**——排序结果取决于实现的内部行为。
//!    这里把缺时间的那笔**排到最后**（排序键 `NO_TIME`）。⛔ 不是「当相等」：那样
//!    `m1 == m2`、`m2 == m3` 而 `m3 < m1`，比较器就不是弱序，稳定排序的输出同样是
//!    unspecified——正好是我们想避开的东西。真数据每条都带时间，所以两边输出一致；
//!    这条只影响畸形数据。
//! 2. 未对位的判定用**下标**而不是 `reviewId`。JS 拿 id 去重，遇到同一页里重复的
//!    `reviewId` 会把两条都从散着的那一节里抹掉。下标没有这个问题，也不依赖
//!    「id 全局唯一」这个没人保证过的假设。

use std::collections::HashMap;

use super::model::{Chapter, Mark, ReviewCore};
use super::text::{range_start, NO_POSITION, NO_TIME};

/// 一条划线，加上挂在它下面的那些想法。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkView<'a> {
    pub mark: &'a Mark,
    pub attached: Vec<&'a ReviewCore>,
}

/// 一章：标题 + 章内按正文顺序排好的划线。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChapterGroup<'a> {
    /// 章目录里查不到这条 `chapterUid` 时，是给一个占位标题而不是丢掉这条划线。
    /// 🔴 丢掉等于「同步悄悄少了东西」。
    pub title: String,
    pub marks: Vec<MarkView<'a>>,
}

/// 对位键：`chapterUid|range`。⛔ 见模块文档那条「只做精确匹配」。
///
/// 缺失的一侧当空串（JS 是 `undefined` 字面串），两侧都缺时仍然相等——
/// 那与 JS 同判据，实际数据不会走到这一格。
fn attach_key(uid: Option<&str>, range: Option<&str>) -> String {
    format!("{}|{}", uid.unwrap_or_default(), range.unwrap_or_default())
}

/// 分组：按 `chapterUid` 聚，章按 `chapterIdx` 排，章内按正文起点排。
///
/// ⚠️ 章的顺序看的是**章目录里的 `chapterIdx`**，不是划线里那个字段，也不是回包顺序
/// （实测三本里 `updated[]` 的到达顺序就不是正文顺序）。目录里查不到的章按「最后」处理，
/// 与 CLI 的 `?? Number.MAX_SAFE_INTEGER` 同一姿势。
pub fn group_marks<'a>(marks: &'a [Mark], chapters: &'a [Chapter]) -> Vec<ChapterGroup<'a>> {
    let mut index: HashMap<&str, &Chapter> = HashMap::new();
    for chapter in chapters {
        // 同一个 uid 出现两次时后写的算，与 JS 那个 `new Map(entries)` 一致
        if let Some(uid) = chapter.chapter_uid.as_deref() {
            index.insert(uid, chapter);
        }
    }

    // 先用「首次出现的顺序」收集，再稳定排序：章号相同（或都查不到章）时保留原顺序，
    // 这一步与 JS 里 Map 的插入顺序 + 稳定 sort 完全同构
    let mut order: Vec<Option<String>> = Vec::new();
    let mut buckets: HashMap<Option<String>, Vec<&'a Mark>> = HashMap::new();
    for mark in marks {
        let uid = mark.chapter_uid.clone();
        if !buckets.contains_key(&uid) {
            order.push(uid.clone());
        }
        buckets.entry(uid).or_default().push(mark);
    }

    order.sort_by_key(|uid| {
        uid.as_deref().and_then(|key| index.get(key)).and_then(|chapter| chapter.chapter_idx).unwrap_or(NO_POSITION)
    });

    order
        .into_iter()
        .map(|uid| {
            let chapter = uid.as_deref().and_then(|key| index.get(key).copied());
            let title = match (chapter.and_then(|c| c.title.as_deref()), &uid) {
                (Some(title), _) => title.to_owned(),
                (None, Some(uid)) => format!("（章节 {uid}）"),
                (None, None) => "（章节 无编号）".to_owned(),
            };
            let mut marks = buckets.remove(&uid).unwrap_or_default();
            marks.sort_by(|a, b| {
                let (ra, rb) = (range_start(a.range.as_deref()), range_start(b.range.as_deref()));
                ra.cmp(&rb).then_with(|| a.create_time.unwrap_or(NO_TIME).cmp(&b.create_time.unwrap_or(NO_TIME)))
            });
            ChapterGroup {
                title,
                marks: marks.into_iter().map(|mark| MarkView { mark, attached: Vec::new() }).collect(),
            }
        })
        .collect()
}

/// 把想法挂到对应划线下面，回没挂上的那些（按回包原序）。
///
/// 一条想法同时匹配多条划线时（同章同 `range` 的两条划线是可能的），两边都挂、
/// 且**不**出现在散着的那一节里——与 CLI 同判据。
pub fn attach_reviews<'a>(groups: &mut [ChapterGroup<'a>], reviews: &'a [ReviewCore]) -> Vec<&'a ReviewCore> {
    let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, review) in reviews.iter().enumerate() {
        by_key.entry(attach_key(review.chapter_uid.as_deref(), review.range.as_deref())).or_default().push(index);
    }

    let mut hit = vec![false; reviews.len()];
    for group in groups {
        for view in &mut group.marks {
            let key = attach_key(view.mark.chapter_uid.as_deref(), view.mark.range.as_deref());
            let Some(indexes) = by_key.get(&key) else { continue };
            for index in indexes {
                view.attached.push(&reviews[*index]);
                hit[*index] = true;
            }
        }
    }

    reviews.iter().zip(hit).filter(|(_, attached)| !*attached).map(|(review, _)| review).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 章目录**故意倒着写**：真数据里 `updated[]` 的到达顺序就不是正文顺序。
    fn chapters() -> Vec<Chapter> {
        serde_json::from_str(
            r#"[
              {"title":"第二章 甲","chapterUid":2,"chapterIdx":2},
              {"title":"第一章 起","chapterUid":1,"chapterIdx":1}
            ]"#,
        )
        .expect("章目录夹具")
    }

    fn mark(id: &str, uid: Option<i64>, range: Option<&str>, text: &str, time: Option<i64>) -> Mark {
        serde_json::from_str(&format!(
            r#"{{"bookmarkId":"{id}","markText":"{text}","chapterUid":{},"range":{},"createTime":{}}}"#,
            uid.map(|v| v.to_string()).unwrap_or_else(|| "null".to_owned()),
            range.map_or_else(|| "null".to_owned(), |v| format!("\"{v}\"")),
            time.map(|v| v.to_string()).unwrap_or_else(|| "null".to_owned()),
        ))
        .expect("划线夹具")
    }

    fn review(id: &str, uid: Option<i64>, range: Option<&str>, text: &str) -> ReviewCore {
        serde_json::from_str(&format!(
            r#"{{"reviewId":"{id}","content":"{text}","chapterUid":{},"range":{}}}"#,
            uid.map(|v| v.to_string()).unwrap_or_else(|| "null".to_owned()),
            range.map_or_else(|| "null".to_owned(), |v| format!("\"{v}\"")),
        ))
        .expect("想法夹具")
    }

    fn titles<'a>(groups: &'a [ChapterGroup<'_>]) -> Vec<&'a str> {
        groups.iter().map(|group| group.title.as_str()).collect()
    }

    fn ids<'a>(groups: &'a [ChapterGroup<'_>]) -> Vec<&'a str> {
        groups.iter().flat_map(|g| g.marks.iter().map(|v| v.mark.bookmark_id.as_str())).collect()
    }

    #[test]
    fn 章按目录里的章号排而不是到达顺序() {
        let list = vec![
            mark("m1", Some(2), Some("5-9"), "第二章第一笔", Some(100)),
            mark("m2", Some(1), Some("10-20"), "第一章第一笔", Some(200)),
        ];
        assert_eq!(titles(&group_marks(&list, &chapters())), vec!["第一章 起", "第二章 甲"]);
    }

    #[test]
    fn 章内按正文起点排而不是按划线时间() {
        // 同一段书可以今天划后半句、明天划前半句；createTime 记的是「什么时候划的」，
        // range 起点才是「正文里的第几句」
        let list = vec![
            mark("m1", Some(1), Some("100-120"), "晚划的在前面", Some(999)),
            mark("m2", Some(1), Some("5-9"), "早划的在后面", Some(1)),
        ];
        assert_eq!(ids(&group_marks(&list, &chapters())), vec!["m2", "m1"]);
    }

    #[test]
    fn 目录里查不到的章用占位标题而不是丢掉() {
        // 🔴 丢掉等于「同步悄悄少了东西」，那是最难发现的一类回归
        let list = vec![mark("m1", Some(99), Some("1-2"), "没人知道的章", Some(1))];
        let dir = chapters();
        let groups = group_marks(&list, &dir);
        assert_eq!(titles(&groups), vec!["（章节 99）"]);
        assert_eq!(ids(&groups), vec!["m1"]);
    }

    #[test]
    fn 没有章号的划线单独成一格() {
        let list = vec![mark("m1", None, None, "不带归属的一笔", None)];
        let dir = chapters();
        let groups = group_marks(&list, &dir);
        assert_eq!(titles(&groups), vec!["（章节 无编号）"]);
        assert!(groups[0].marks[0].attached.is_empty());
    }

    #[test]
    fn 想法只在章号与区间都逐字相等时挂上() {
        let list = vec![mark("m1", Some(1), Some("10-20"), "第一条划线", Some(1))];
        let reviews = vec![
            review("r3", Some(2), Some("10-20"), "换了章的想法"),
            review("r2", Some(1), Some("10-21"), "差一个字符的想法"),
            review("r1", Some(1), Some("10-20"), "正下方那条"),
        ];
        let dir = chapters();
        let mut groups = group_marks(&list, &dir);
        let loose = attach_reviews(&mut groups, &reviews);

        assert_eq!(groups[0].marks[0].attached.iter().map(|r| r.review_id.as_str()).collect::<Vec<_>>(), vec!["r1"]);
        // ⛔ 模糊匹配在这里被否掉了：差一个字符也算不上，两条都留在散着的那一节里
        assert_eq!(loose.iter().map(|r| r.review_id.as_str()).collect::<Vec<_>>(), vec!["r3", "r2"]);
    }

    #[test]
    fn 一条想法同时匹配两条划线时两边都挂() {
        let list = vec![
            mark("m1", Some(1), Some("10-20"), "上头那条", Some(1)),
            mark("m2", Some(1), Some("10-20"), "底下那条", Some(2)),
        ];
        let reviews = vec![review("r1", Some(1), Some("10-20"), "同一段的两条都该带上它")];
        let dir = chapters();
        let mut groups = group_marks(&list, &dir);
        assert!(attach_reviews(&mut groups, &reviews).is_empty());
        assert_eq!(groups[0].marks[0].attached.len(), 1);
        assert_eq!(groups[0].marks[1].attached.len(), 1);
    }

    #[test]
    fn 同一条的两份拷贝里没挂上的那份仍然看得见() {
        // 🔴 判据用下标而不是 `reviewId`：按 id 去重（`weread.mjs` 的做法）会连没挂上的那份一起藏掉
        let list = vec![mark("m1", Some(1), Some("10-20"), "第一条划线", Some(1))];
        let reviews = vec![
            review("dup", Some(1), Some("10-20"), "挂上了的那条"),
            review("dup", Some(1), Some("88-99"), "同号但没挂上，它必须还在"),
        ];
        let dir = chapters();
        let mut groups = group_marks(&list, &dir);
        let loose = attach_reviews(&mut groups, &reviews);
        assert_eq!(groups[0].marks[0].attached.len(), 1);
        assert_eq!(loose.len(), 1);
        assert!(loose[0].content.as_deref().unwrap_or_default().contains("必须还在"));
    }

    #[test]
    fn 缺时间的那笔排在最后而不是让比较器失去弱序() {
        let list = vec![
            mark("m1", Some(1), Some("5-9"), "有时间", Some(10)),
            mark("m2", Some(1), Some("5-9"), "没时间", None),
            mark("m3", Some(1), Some("5-9"), "有时间更早", Some(1)),
        ];
        // 起点全同：有时间的两笔按时间排（m3 在前），缺时间那笔用 NO_TIME 垫到最后。
        // ⚠️ 不是「算相等」——那样 m1==m2、m2==m3 却 m3<m1，比较器不是弱序，输出又变成
        // 实现内部行为说了算（这一条先前就是这么暴露的）。JS 那版在这里返回 NaN，同样不可复现。
        assert_eq!(ids(&group_marks(&list, &chapters())), vec!["m3", "m1", "m2"]);
    }

    #[test]
    fn 同一个章号出现两次时后写的目录算() {
        // 与 `weread.mjs` 的 `new Map(entries)` 同构：后者覆盖前者
        let chapters = serde_json::from_str::<Vec<Chapter>>(
            r#"[{"title":"旧的","chapterUid":1,"chapterIdx":1},{"title":"新的","chapterUid":1,"chapterIdx":9}]"#,
        )
        .expect("重复章号夹具");
        let list = vec![mark("m1", Some(1), Some("1-2"), "一笔", Some(1))];
        assert_eq!(titles(&group_marks(&list, &chapters)), vec!["新的"]);
    }
}
