// 本地对拍用的临时用例：把三份真回包按 Rust 侧的口径出一份摘要，与 weread.mjs 的输出逐字比。
// ⛔ 不进提交：它读的是机器上的绝对路径，仓库里也不留任何正文。
use std::collections::BTreeSet;

use serde_json::Value;
use vela_core::weread::{anchor, attach_reviews, group_marks, BookmarkList, ReviewEntry, ReviewsPage};

fn summary(raw: &Value) -> Vec<String> {
    let list: BookmarkList = serde_json::from_value(raw["marks"].clone()).expect("marks 形状");
    let page: ReviewsPage =
        serde_json::from_value(serde_json::json!({ "reviews": raw["reviews"] })).expect("reviews 形状");
    let cores: Vec<_> = page.reviews.iter().map(ReviewEntry::core).cloned().collect();

    let mut out = vec![format!("marks={} reviews={}", list.updated.len(), page.reviews.len(),)];

    let mut groups = group_marks(&list.updated, &list.chapters);
    let loose = attach_reviews(&mut groups, &cores);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for group in &groups {
        for view in &group.marks {
            let att: Vec<String> = view.attached.iter().map(|r| anchor(&r.review_id)).collect();
            out.push(format!("@ {} | {} | {}", anchor(&view.mark.bookmark_id), group.title, att.join(",")));
            seen.insert(anchor(&view.mark.bookmark_id));
        }
    }
    for review in &loose {
        out.push(format!("L {}", anchor(&review.review_id)));
    }
    assert_eq!(seen.len(), list.updated.len(), "同一批锚点不该有两个划线共用");
    out
}

#[test]
fn 真回包的分组与锚点摘要() {
    let Some(dir) = std::env::var_os("WEREAD_RAW_DIR") else {
        eprintln!("跳过：没有 WEREAD_RAW_DIR（本机 raw-*.json 目录，不进仓库）");
        return;
    };
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("读目录")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("raw-") && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    for path in &files {
        let text = std::fs::read_to_string(path).expect("读 raw");
        let raw: Value = serde_json::from_str(&text).expect("raw 是 JSON");
        let name = path.file_name().unwrap().to_str().unwrap().replace("raw-", "").replace(".json", "");
        println!("== {name} {}", summary(&raw).join("\n"));
    }
}
