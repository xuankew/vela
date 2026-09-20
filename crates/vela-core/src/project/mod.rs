//! 项目与工作区（PLAN.md §2.5 `project`）。
//!
//! M2-A 落地了目录树的按需列举，M2-B-5 加上了树内的写操作（新建 / 改名 / 解析出
//! 一条确实存在的路径给废纸篓、Finder、剪贴板用）。两者共用 `tree::resolve` 这一个
//! 防逃逸实现处——理由写在 `ops.rs` 的模块文档里。
//!
//! M2-E 加了两样东西：`walk`（遍历器与 rel 换算，从 `search/run.rs` 挪过来，
//! 因为 `Cmd+P` 是它的第三个消费者）与 `index`（文件索引 + 模糊匹配 + MRU 加权）。
//! `walk` 住在 `project` 而不是 `search` 底下，是因为「哪些文件算这个项目的一部分」
//! 是一个项目的属性，不是搜索的属性——搜索与 `Cmd+P` 都只是它的消费者。
//!
//! ⚠️ 多根工作区（M2-F）**没有给这个模块添任何文件**：落地面全在前端
//! （`src/project/rootTree.ts` + `store.ts`），这一侧只是让 `index` 那几条查询
//! 与 `search` 那几条命令从收一个根改成收一组根。「最近项目」同样在前端，
//! 它记的是「换过哪些工作区」，这一层只把它当加分权重。
//! `.vela/settings.json` 分层合并**推到了 M4**（PLAN.md §3.4「M2-F 实施修正」1）。

mod index;
mod ops;
mod tree;
pub(crate) mod walk;

pub use index::{
    check_root, merge_stats, query_many, FileIndex, FileMatch, FileQuery, IndexStats, MAX_INDEX_FILES, MAX_RECENT,
};
pub use ops::{create_entry, rename_entry, resolve_existing, EntryKind};
pub use tree::{list_dir, DirEntry, DirListing, TreeError};
