//! 两个文件的**正文**：机器那份（素材）与人那份（整理）。
//!
//! ## 🔴 双文件是 M8 的地基，这一段就是它长什么样
//!
//! `weread.mjs` 当年把两份内容挤进同一个文件，靠 `<!-- weread:begin/end -->` 两行注释划界，
//! 每次同步只替换界内的字。那条路的尽头是「同步」和「用户在 Vela 里编辑」必然撞车，
//! 而撞车的判定还得靠读注释——所以 M8 换成两个文件（PLAN.md §3.22 决定 1）：
//!
//! | 文件 | 谁拥有 | 同步时 | 进不进 git |
//! |---|---|---|---|
//! | `作者 - 书名.md` | **人** | 只在**缺失**时建一份种子，之后一个字都不改 | 进 |
//! | `划线素材/作者 - 书名·划线素材.md` | **机器** | 整份重写 | ⛔ 不进（`.gitignore` 点名） |
//!
//! 素材统一收在 `划线素材/` 子目录里（M8-10）：整理文件那一层只剩书，机器区不会和它
//! 并排出现。两份文件互相给一条相对链接，预览里点一下就跳过去；素材顶部那条
//! `../作者 - 书名.md` 是**每次重写时生成**的，所以永远跟着当前布局。
//!
//! ⚠️ 「素材文件不进 git」不只是版权考虑：那行「同步于 …」的时间戳每次同步都会变，
//! 文件一旦进版本库，每次同步必然产生一次脏改动。**时间戳能留在这份文件里，
//! 前提正是它不进版本库**。
//!
//! ## 这里只产字符串，不碰路径、不碰盘
//!
//! 文件名净化在 [`text::safe_name`]，写盘与越界检查在 `src-tauri`。分成两半之后，
//! 「渲染出来的每个字节」这件事可以在本机一次测完，而「写到哪」这件事留给真机。

use std::collections::BTreeSet;

use super::group::{attach_reviews, group_marks};
use super::model::{Chapter, Mark, ReviewCore};
use super::text::{anchor, day_of, flatten, safe_name, stamp_of};

/// 素材文件名的后缀。⚠️ 用「·」而不是空格连着「划线素材」，是为了在同一堆
/// `作者 - 书名.md` 里一眼分得出来，同时不让两个工具生成同一个文件名。
pub const MATERIAL_SUFFIX: &str = "·划线素材";

/// 素材文件的统一子目录（M8-10）。⛔ 改这个值要同步 `.gitignore` 那条规则：
/// `*·划线素材.md` 没有斜杠，对任意深度的同名文件都生效，所以它不用改。
pub const MATERIAL_DIR: &str = "划线素材";

/// 一次渲染的全部输入。
///
/// `first_time` 与 `seen_ids` 是**两件事**，别合并：`first_time` 是「这台设备的 state 里
/// 还没有这本书」（CLI 判的是 `state[bookId]` 在不在），`seen_ids` 是上次见到的划线 id 集合。
/// 一本「上次同步过但一条划线都没有」的书，`seen_ids` 是空的而 `first_time` 是 `false`。
/// 拿 `seen_ids.is_empty()` 去推首次，会把这种情况写成「首次同步」，用户看到的
/// 就是同一本书两次「首次」。
#[derive(Debug)]
pub struct MaterialInput<'a> {
    pub book_id: &'a str,
    pub title: Option<&'a str>,
    pub author: Option<&'a str>,
    pub marks: &'a [Mark],
    pub chapters: &'a [Chapter],
    pub reviews: &'a [ReviewCore],
    pub seen_ids: &'a BTreeSet<String>,
    pub first_time: bool,
    /// 这次同步发生的时刻（Unix 秒）。⚠️ 由调用方传进来，⛔ 不在这里读系统时间——
    /// 读了就没法用固定黄金值测，而每次同步都变的日期正是「素材文件不该进 git」那条理由。
    pub synced_at: i64,
}

/// 上次同步之后新增的划线。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreshMark {
    pub text: String,
    pub anchor: String,
    pub day: String,
}

/// 相对 `seen_ids` 的新增划线，按回包顺序。
///
/// ⚠️ 排序是**按正文位置**还是**按新增**是两件不同的事：这一节刻意保留回包顺序
/// （≈ 划线时间顺序），因为它回答的是「我上次到现在新划了什么」，不是「正文里的先后」。
pub fn fresh_marks(marks: &[Mark], seen_ids: &BTreeSet<String>) -> Vec<FreshMark> {
    marks
        .iter()
        .filter(|mark| !seen_ids.contains(mark.bookmark_id.as_str()))
        .map(|mark| FreshMark {
            text: flatten(mark.mark_text.as_deref()),
            anchor: anchor(&mark.bookmark_id),
            day: day_of(mark.create_time),
        })
        .collect()
}

/// 一级标题那一行：`# 《书名》— 作者`。
///
/// ⚠️ 作者缺失时不带那个破折号尾巴（CLI 会写出 `undefined`）。书名缺失时用「未命名」，
/// ⛔ 不是空标题——空标题在 Vela 大纲面板里是一格看不见的路标。
fn heading(title: Option<&str>, author: Option<&str>) -> String {
    let name = title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or("未命名");
    match author.map(str::trim).filter(|a| !a.is_empty()) {
        Some(author) => format!("# 《{name}》— {author}"),
        None => format!("# 《{name}》"),
    }
}

/// `作者 - 书名`。与 CLI 同形状，⚠️ 所以旧文件不会被当成另一本书重新生成一遍。
///
/// 净化之后**两侧都空**时回 `未命名 - 未命名`：照字面拼会得到 `" - "`，加上后缀就是一个
/// 名叫 `" - ·划线素材.md"` 的文件——合法，但用户在文件树里看不出那是哪本书。
pub fn file_base_name(author: Option<&str>, title: Option<&str>) -> String {
    let who = safe_name(author, 30);
    let name = safe_name(title, 40);
    if who.is_empty() && name.is_empty() {
        return "未命名 - 未命名".to_owned();
    }
    format!("{who} - {name}")
}

/// 素材文件名（带 `.md`）。
pub fn material_file_name(author: Option<&str>, title: Option<&str>) -> String {
    format!("{}{MATERIAL_SUFFIX}.md", file_base_name(author, title))
}

/// 整理文件名（带 `.md`）。人那份，种子与素材里的返回链接都指向它。
pub fn organize_file_name(author: Option<&str>, title: Option<&str>) -> String {
    format!("{}.md", file_base_name(author, title))
}

/// 从配置目录根看过去的素材相对路径：`划线素材/作者 - 书名·划线素材.md`。
/// 这是种子文件里那条链接的目标，也是 `src-tauri` 写盘时的落点依据。
pub fn material_rel_name(author: Option<&str>, title: Option<&str>) -> String {
    format!("{MATERIAL_DIR}/{}", material_file_name(author, title))
}

/// 相对路径 → Markdown 链接目标里那一串。空格必须写成 `%20`。
///
/// 🔴 不是「为了好看」：Vela 的预览渲染器（`src/md/render.ts` 的 `safeUrl`）会把 `href` 里
/// 所有 U+0000–U+0020 删掉——那一条是防 `java\tscript:` 这类拆协议的绕法，而合法 URL
/// 本就不该有裸空格。我们的文件名来自 [`safe_name`]，空格是**保留**的，所以裸空格在这里
/// 会被渲染成去掉空格的另一个文件名，链接在预览里点了没反应。
///
/// ⚠️ 外层的 `<…>` 仍然要留：书名里可能有成对的半角括号，而 `(…)` 写法会被第一个
/// 右括号截断。`%` 先编，否则一个真的叫 `100%.md` 的文件会被下游解码成别的东西。
fn link_dest(rel: &str) -> String {
    let mut out = String::with_capacity(rel.len());
    for ch in rel.chars() {
        match ch {
            '%' => out.push_str("%25"),
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            _ => out.push(ch),
        }
    }
    out
}

/// 渲染素材文件全文。
///
/// 行形状与 CLI 逐字一致（`- 正文 \`锚点\` · 日期`），差别只在**外层结构**：
/// 顶层是 `# 书名`，章和「正文上的想法」都是 `##`，没有标记区。
/// ⚠️ 一致的对象是**每一条列表项的字节**——那才是锚点能跨工具对上的东西；
/// ⛔ 不是「整个文件形状一致」，形状已经被决定 1 改掉了。
pub fn render_material(input: &MaterialInput) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(heading(input.title, input.author));
    lines.push(String::new());
    // 返回整理文件那条链接：素材在子目录里，所以是 `../`。
    // ⚠️ 目标里的空格编成 `%20`（理由见 `link_dest`），外面再用 `<…>` 包起来
    lines.push(format!(
        "[← 回到整理](<{}>)",
        link_dest(&format!("../{}", organize_file_name(input.author, input.title)))
    ));
    lines.push(String::new());
    lines.push(format!(
        "> 划线 {} · 想法 {} · 同步于 {} · bookId {}",
        input.marks.len(),
        input.reviews.len(),
        stamp_of(input.synced_at),
        input.book_id,
    ));
    lines.push(String::new());

    let mut groups = group_marks(input.marks, input.chapters);
    let loose = attach_reviews(&mut groups, input.reviews);

    if input.first_time {
        lines.push("**首次同步**：下面按章节分组。整理请写到上一层的整理文件，本文件每次同步整份重写。".to_owned());
        lines.push(String::new());
    } else {
        let fresh = fresh_marks(input.marks, input.seen_ids);
        if fresh.is_empty() {
            lines.push("**本次没有新增**。".to_owned());
            lines.push(String::new());
        } else {
            lines.push(format!("## 本次新增 {} 条", fresh.len()));
            lines.push(String::new());
            for mark in fresh {
                lines.push(row(&mark.text, &mark.anchor, &mark.day));
            }
            lines.push(String::new());
        }
    }

    for group in &groups {
        lines.push(format!("## {}", group.title));
        lines.push(String::new());
        for view in &group.marks {
            lines.push(row(
                &flatten(view.mark.mark_text.as_deref()),
                &anchor(&view.mark.bookmark_id),
                &day_of(view.mark.create_time),
            ));
            for review in &view.attached {
                lines.push(nested_row(
                    &flatten(review.content.as_deref()),
                    &anchor(&review.review_id),
                    &day_of(review.create_time),
                ));
            }
        }
        lines.push(String::new());
    }

    if !loose.is_empty() {
        lines.push("## 正文上的想法（没挂在划线下）".to_owned());
        lines.push(String::new());
        for review in loose {
            let id = anchor(&review.review_id);
            let day = day_of(review.create_time);
            match review.abstract_text.as_deref().map(str::trim) {
                // 这类想法带 `abstract`（它针对的那段原文）。不带它就只剩一句感想，
                // 日后对着「今天想到的一句话」根本不知道在说哪一段
                Some(abstract_text) if !abstract_text.is_empty() => {
                    lines.push(row(&flatten(Some(abstract_text)), &id, &day));
                    lines.push(format!("  - 想法：{}", flatten(review.content.as_deref())));
                }
                _ => lines.push(row(&flatten(review.content.as_deref()), &id, &day)),
            }
        }
        lines.push(String::new());
    }

    // ⚠️ 结尾恰好一个换行：每一块后面都跟着一个空行元素，最后那格是多余的。
    // 留着它，文件就永远以两个换行结尾，而每次同步重写整份 → 那一行永远在 diff 里
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

/// 一条列表项：`- 正文 \`锚点\` · 日期`。日期为空时**整段尾巴不带**，
/// ⚠️ 不留一个光秃秃的「· 」。
fn row(text: &str, anchor: &str, day: &str) -> String {
    entry("- ", text, anchor, day)
}

/// 挂在划线**下面**的那条想法：同样的形状，只是缩进两级。
/// ⚠️ 缩进必须是 Markdown 认的两格（四格会被当成代码块，一个空格会续行到上一条）。
fn nested_row(text: &str, anchor: &str, day: &str) -> String {
    entry("  - ", text, anchor, day)
}

fn entry(bullet: &str, text: &str, anchor: &str, day: &str) -> String {
    if day.is_empty() {
        return format!("{bullet}{text} `{anchor}`");
    }
    format!("{bullet}{text} `{anchor}` · {day}")
}

/// 渲染**只在缺失时**写入的整理文件种子。
///
/// 🔴 这一份的内容之后由用户说了算，同步永不改写。种子里那句指向素材文件的说明
/// 是唯一必须存在的字：用户得知道旁边那个文件是什么、以及为什么不要把它并进来。
pub fn render_organize_seed(input: &MaterialInput) -> String {
    format!(
        "{}\n\n[划线素材](<{}>)\n\n`{}` 里那份记录的是微信读书的划线与想法，每次同步整份重写，⛔ 不要把它并进本文件（并进去下次就没了）。整理请写在下面。\n\n## 我的整理\n",
        heading(input.title, input.author),
        link_dest(&material_rel_name(input.author, input.title)),
        MATERIAL_DIR,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::weread::model::{ReviewEntry, ReviewsPage};

    const SYNCED_AT: i64 = 1_740_000_000;

    fn marks() -> Vec<Mark> {
        serde_json::from_str(
            r#"[
              {"bookmarkId":"1001","chapterUid":1,"range":"10-20","markText":"第一条划线","createTime":1740000000},
              {"bookmarkId":"1002","chapterUid":2,"range":"5-9","markText":"第二条划线","createTime":1740000100},
              {"bookmarkId":"1003","chapterUid":2,"range":"30-40","markText":"第三条划线，同步后新增的","createTime":1740000200}
            ]"#,
        )
        .expect("划线夹具")
    }

    fn chapters() -> Vec<Chapter> {
        serde_json::from_str(
            r#"[
              {"title":"第二章 甲","chapterUid":2,"chapterIdx":2},
              {"title":"第一章 起","chapterUid":1,"chapterIdx":1}
            ]"#,
        )
        .expect("章目录夹具")
    }

    fn reviews(json: &str) -> Vec<ReviewCore> {
        serde_json::from_str(&format!(r#"{{"reviews":{json}}}"#))
            .map(|page: ReviewsPage| page.reviews.iter().map(ReviewEntry::core).cloned().collect())
            .expect("想法夹具")
    }

    /// 期望全文：与实现同一个形状（每块之后一个空行、结尾恰好一个换行），
    /// 但**逐行手写在测试里**，不是从实现输出里抄的
    fn expected(lines: &[&str]) -> String {
        format!("{}\n", lines.join("\n"))
    }

    #[test]
    fn 首次同步的全文() {
        let list = marks();
        let chapters = chapters();
        let mine = reviews(
            r#"[{"reviewId":"r1","review":{"reviewId":"r1","chapterUid":1,"range":"10-20","content":"这条挂在第一条下面","createTime":1740000050}}]"#,
        );
        let seen = BTreeSet::new();
        let input = MaterialInput {
            book_id: "bk1",
            title: Some("测试之书"),
            author: Some("某人"),
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: true,
            synced_at: SYNCED_AT,
        };
        assert_eq!(
            render_material(&input),
            expected(&[
                "# 《测试之书》— 某人",
                "",
                "[← 回到整理](<../某人%20-%20测试之书.md>)",
                "",
                "> 划线 3 · 想法 1 · 同步于 2025-02-19 21:20 · bookId bk1",
                "",
                "**首次同步**：下面按章节分组。整理请写到上一层的整理文件，本文件每次同步整份重写。",
                "",
                "## 第一章 起",
                "",
                "- 第一条划线 `1i52kxt` · 2025-02-19",
                "  - 这条挂在第一条下面 `3mefu9` · 2025-02-19",
                "",
                "## 第二章 甲",
                "",
                "- 第二条划线 `p0m43f` · 2025-02-19",
                "- 第三条划线，同步后新增的 `cjboa5` · 2025-02-19",
            ])
        );
    }

    #[test]
    fn 第二次同步只列新增的那几条() {
        let list = marks();
        let chapters = chapters();
        let mine = reviews("[]");
        let seen: BTreeSet<String> = ["1001".to_owned(), "1002".to_owned()].into_iter().collect();
        let input = MaterialInput {
            book_id: "bk1",
            title: Some("测试之书"),
            author: Some("某人"),
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: false,
            synced_at: SYNCED_AT,
        };
        let text = render_material(&input);
        assert!(text.contains("## 本次新增 1 条\n\n- 第三条划线，同步后新增的 `cjboa5` · 2025-02-19\n"), "{text}");
        assert!(!text.contains("首次同步"), "已经同步过的书不该再写「首次」");
        // 新增那一节排在章前面：它回答「我上次到现在新划了什么」，是这次同步的结论
        assert!(text.find("本次新增") < text.find("第一章 起"), "{text}");
    }

    #[test]
    fn 同步过而这次一条都没新增时明说一句() {
        let list = marks();
        let chapters = chapters();
        let mine = reviews("[]");
        let seen: BTreeSet<String> = list.iter().map(|m| m.bookmark_id.clone()).collect();
        let input = MaterialInput {
            book_id: "bk1",
            title: Some("测试之书"),
            author: Some("某人"),
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: false,
            synced_at: SYNCED_AT,
        };
        assert!(render_material(&input).contains("**本次没有新增**。"));
    }

    #[test]
    fn 上次同步过但一条划线都没有时不写成首次() {
        // ⚠️ `first_time` 的判据是「这台设备的 state 里有没有这本书」，不是「seen_ids 空不空」：
        // 拿 `seen_ids.is_empty()` 去推首次，会把这本书写成两次「首次同步」
        let list: Vec<Mark> = Vec::new();
        let chapters = chapters();
        let mine = reviews("[]");
        let seen = BTreeSet::new();
        let input = MaterialInput {
            book_id: "bk1",
            title: Some("测试之书"),
            author: Some("某人"),
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: false,
            synced_at: SYNCED_AT,
        };
        assert!(render_material(&input).contains("**本次没有新增**。"));
    }

    #[test]
    fn 散着的想法带上它针对的那段正文() {
        // 🔴 这一节是三本真书里 4 条想法中 2 条的形态：不带 `abstract` 就只剩一句感想，
        // 日后对着「今天想到的一句话」根本不知道在说哪一段
        let list: Vec<Mark> = Vec::new();
        let chapters = chapters();
        let mine = reviews(
            r#"[{"reviewId":"r9","review":{"reviewId":"r9","chapterUid":7,"content":"这一句是感想","abstract":"这是它针对的那段正文","createTime":1740000000}}]"#,
        );
        let seen = BTreeSet::new();
        let input = MaterialInput {
            book_id: "bk1",
            title: Some("测试之书"),
            author: Some("某人"),
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: true,
            synced_at: SYNCED_AT,
        };
        assert_eq!(
            render_material(&input),
            expected(&[
                "# 《测试之书》— 某人",
                "",
                "[← 回到整理](<../某人%20-%20测试之书.md>)",
                "",
                "> 划线 0 · 想法 1 · 同步于 2025-02-19 21:20 · bookId bk1",
                "",
                "**首次同步**：下面按章节分组。整理请写到上一层的整理文件，本文件每次同步整份重写。",
                "",
                "## 正文上的想法（没挂在划线下）",
                "",
                "- 这是它针对的那段正文 `12aooz` · 2025-02-19",
                "  - 想法：这一句是感想",
            ])
        );
    }

    #[test]
    fn 散着的想法没带正文时退化成只写感想() {
        let list: Vec<Mark> = Vec::new();
        let chapters = chapters();
        let mine = reviews(r#"[{"reviewId":"r8","content":"只有一句感想","createTime":1740000000}]"#);
        let seen = BTreeSet::new();
        let input = MaterialInput {
            book_id: "bk1",
            title: Some("测试之书"),
            author: Some("某人"),
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: true,
            synced_at: SYNCED_AT,
        };
        let text = render_material(&input);
        assert!(text.contains("- 只有一句感想 `wewumt`"), "{text}");
        assert!(!text.contains("想法："), "{text}");
    }

    #[test]
    fn 素材文件里不许有标记区的痕迹() {
        // 🔴 决定 1 把 `<!-- weread:begin/end -->` 那套废掉了：整份重写，界内界外不再是这份文件的概念
        let list = marks();
        let chapters = chapters();
        let mine = reviews("[]");
        let seen = BTreeSet::new();
        let input = MaterialInput {
            book_id: "bk1",
            title: Some("测试之书"),
            author: Some("某人"),
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: true,
            synced_at: SYNCED_AT,
        };
        let text = render_material(&input);
        assert!(!text.contains("weread:"), "标记区已经作废");
        assert!(text.ends_with('\n') && !text.ends_with("\n\n"), "结尾恰好一个换行");
        assert_eq!(text.lines().filter(|line| line.starts_with("# 《")).count(), 1);
    }

    #[test]
    fn 文件名两个工具的形状一致而素材那份多一个后缀() {
        // ⚠️ 少了这个一致性，`weread.mjs` 与 Vela 会在同一目录里各写一份、互不相认
        assert_eq!(file_base_name(Some("某人"), Some("测试之书")), "某人 - 测试之书");
        assert_eq!(material_file_name(Some("某人"), Some("测试之书")), "某人 - 测试之书·划线素材.md");
        assert_eq!(organize_file_name(Some("某人"), Some("测试之书")), "某人 - 测试之书.md");
        // 素材统一在子目录下（M8-10）：种子链接与落盘位置都以这个相对路径为准
        assert_eq!(material_rel_name(Some("某人"), Some("测试之书")), "划线素材/某人 - 测试之书·划线素材.md");
        assert_eq!(file_base_name(Some("a/b"), Some("c:d")), "a·b - c·d");
    }

    #[test]
    fn 种子里指的就是素材那个文件名() {
        // 🔴 两处拼装必须相等：错了的症状是用户点链接、找不到文件
        let list = marks();
        let chapters = chapters();
        let mine = reviews("[]");
        let seen = BTreeSet::new();
        let input = MaterialInput {
            book_id: "bk1",
            title: Some("测试之书"),
            author: Some("某人"),
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: true,
            synced_at: SYNCED_AT,
        };
        let plan = crate::weread::plan_material(&input);
        assert!(
            plan.organize_seed.contains("[划线素材](<划线素材/某人%20-%20测试之书·划线素材.md>)"),
            "{}",
            plan.organize_seed
        );
        assert!(plan.organize_seed.contains(&link_dest(&plan.material_name)), "{}", plan.organize_seed);
        assert!(!plan.organize_seed.contains("<划线素材/某人 - "), "裸空格会被渲染层删掉：{}", plan.organize_seed);
        assert!(!plan.organize_seed.contains("同目录"), "素材已经不在同目录了：{}", plan.organize_seed);
        // 反向那条由素材自己带着，每次重写都重新生成，所以永远跟着当前布局
        assert!(plan.material.contains("[← 回到整理](<../某人%20-%20测试之书.md>)"), "{}", plan.material);
        assert_eq!(plan.organize_name, "某人 - 测试之书.md");
        assert_eq!(plan.ids, vec!["1001".to_owned(), "1002".to_owned(), "1003".to_owned()]);
    }

    #[test]
    fn 时间戳那一行是唯一每次同步都变的地方() {
        // ⚠️ 这一条不是洁癖：素材文件一旦进版本库，每次同步必然产生一次脏改动，
        // 而「不进」正是 §3.22 决定 2 的那一格。除了这一行，其余字节必须逐字稳定，
        // 否则用户没法判断素材文件里到底哪几句变了
        let list = marks();
        let chapters = chapters();
        let mine = reviews("[]");
        let seen = BTreeSet::new();
        let at = |synced_at: i64| {
            let input = MaterialInput {
                book_id: "bk1",
                title: Some("测试之书"),
                author: Some("某人"),
                marks: &list,
                chapters: &chapters,
                reviews: &mine,
                seen_ids: &seen,
                first_time: false,
                synced_at,
            };
            render_material(&input)
        };
        let (a, b) = (at(1_740_000_000), at(1_740_003_600));
        assert_ne!(a, b);
        let diff: Vec<(&str, &str)> = a.lines().zip(b.lines()).filter(|(x, y)| x != y).collect();
        assert_eq!(diff.len(), 1, "变的只该有那一行：{diff:?}");
        assert!(diff[0].0.contains("同步于"), "{}", diff[0].0);
    }

    #[test]
    fn 书名缺失时不写一个空标题() {
        // 空标题在 Vela 的大纲面板里是一格看不见的路标
        let list: Vec<Mark> = Vec::new();
        let chapters = chapters();
        let mine = reviews("[]");
        let seen = BTreeSet::new();
        let input = MaterialInput {
            book_id: "bk1",
            title: None,
            author: None,
            marks: &list,
            chapters: &chapters,
            reviews: &mine,
            seen_ids: &seen,
            first_time: true,
            synced_at: SYNCED_AT,
        };
        assert!(render_material(&input).starts_with("# 《未命名》\n"));
        assert_eq!(material_file_name(None, None), "未命名 - 未命名·划线素材.md");
    }
}
