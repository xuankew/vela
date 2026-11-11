//! 微信读书笔记同步的**纯逻辑层**（PLAN.md §3.22 M8-1）。
//!
//! 不发请求、不读钥匙串、不碰文件。四块各管一段，顺序就是数据流的方向：
//!
//! ```text
//! 网关请求体 / 回包成败 / 翻页游标        gateway.rs
//!        ↓  （raw JSON 由 src-tauri 递进来）
//! 回包字段形状                            model.rs
//!        ↓
//! 分组 + 想法对位                          group.rs
//!        ↓
//! 素材文件全文 + 整理文件种子              render.rs
//!        （锚点、日期、文件名净化在 text.rs，被上面三块共用）
//! ```
//!
//! ## ⚠️ 为什么这一层存在，而不是在 `src-tauri` 里顺手写完
//!
//! 参考实现 `weread.mjs` 是一个能跑的 CLI，而它**每次改动只能靠真账号跑一遍才知道有没有坏**
//! ——那正是 M0 定下来的口径：不对称的证据规则。这里把同一条路拆成四个能在本机钉死的纯函数，
//! 于是「分组少一章」「想法挂错」「锚点变值」这三类回归各有一条不用联网、不用钥匙串的测试。
//! `src-tauri` 那一层（M8-2 / M8-3）剩下的只有 HTTP、写盘与进度，那些留给真机。
//!
//! ## 🔴 黄金值的来源
//!
//! [`text`] 里那几组常数是从 `weread.mjs` 的函数**实际跑出来的输出**（同版本、同输入，
//! 本机 `node` 算的），不是照着公式推的。锚点尤其：它是写进笔记、用户拿 `⌘F` 去搜的
//! 那串字符，两台设备两个工具必须算出同一个值。
//!
//! ## ⛔ 划线原文不进这个仓库
//!
//! 素材文件的内容是第三方书的正文。**测试夹具一律合成**（三本真书只贡献**形状**：
//! 哪个字段可缺、`chapterIdx` 有没有出现、想法带不带壳），真数据的对拍靠本机
//! `/Volumes/xuankeData/Document/readbook/.weread/raw-*.json` 那条路，
//! ⛔ 不 copy 进 `tests/`、不进提交。这也是 §3.22 决定 2「素材文件不进版本库」在
//! 这一层的同款理由。

pub mod gateway;
pub mod group;
pub mod model;
pub mod render;
pub mod text;

pub use gateway::{
    classify, next_notebook_sort, next_review_synckey, request_body, GatewayError, GATEWAY_URL, SKILL_VERSION,
};
pub use group::{attach_reviews, group_marks, ChapterGroup, MarkView};
pub use model::{BookNotebook, BookmarkList, Chapter, Mark, NotebooksPage, ReviewCore, ReviewEntry, ReviewsPage};
pub use render::{
    file_base_name, fresh_marks, material_file_name, material_rel_name, organize_file_name, render_material,
    render_organize_seed, FreshMark, MaterialInput, MATERIAL_DIR, MATERIAL_SUFFIX,
};
pub use text::{anchor, crc32, day_of, flatten, range_start, safe_name, stamp_of};

use std::collections::BTreeSet;

/// 一次同步要落下去的东西。
///
/// 名字与内容一起交出去，是为了让 `src-tauri` 那边**没有拼装的机会**：素材文件名和种子文案里
/// 那条链接必须指向同一个名字，分两处拼就会有一处拼错、而错的症状是用户点链接找不到文件。
///
/// ⚠️ `material_name` 是**素材文件名**（不含子目录）；落盘位置由 [`MATERIAL_DIR`] 决定，
/// 种子里的链接目标用 [`material_rel_name`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterialPlan {
    /// `作者 - 书名·划线素材.md`：机器那份，每次整份重写，落在 `划线素材/` 下
    pub material_name: String,
    /// `作者 - 书名.md`：人那份，只在缺失时写 [`render_organize_seed`]
    pub organize_name: String,
    pub material: String,
    pub organize_seed: String,
    /// 这次的全集划线 id，排序后交给 state 当下次的 `seen_ids`
    pub ids: Vec<String>,
}

/// 把 [`MaterialInput`] 走一遍，连文件名一起给出。
pub fn plan_material(input: &MaterialInput) -> MaterialPlan {
    let mut ids: BTreeSet<String> = BTreeSet::new();
    ids.extend(input.marks.iter().map(|mark| mark.bookmark_id.clone()));
    MaterialPlan {
        material_name: material_file_name(input.author, input.title),
        organize_name: organize_file_name(input.author, input.title),
        material: render_material(input),
        organize_seed: render_organize_seed(input),
        ids: ids.into_iter().collect(),
    }
}
