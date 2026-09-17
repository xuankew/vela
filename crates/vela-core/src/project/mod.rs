//! 项目与工作区（PLAN.md §2.5 `project`）。
//!
//! M2-A 落地了目录树的按需列举，M2-B-5 加上了树内的写操作（新建 / 改名 / 解析出
//! 一条确实存在的路径给废纸篓、Finder、剪贴板用）。两者共用 `tree::resolve` 这一个
//! 防逃逸实现处——理由写在 `ops.rs` 的模块文档里。
//!
//! 多根工作区、`.vela/settings.json` 分层合并、最近项目是 M2-F 的事，
//! 等真用到时再加——不预先建空文件当装饰。

mod ops;
mod tree;

pub use ops::{create_entry, rename_entry, resolve_existing, EntryKind};
pub use tree::{list_dir, DirEntry, DirListing, TreeError};
