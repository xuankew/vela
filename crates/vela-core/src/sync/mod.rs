//! GitHub 目录同步的**纯逻辑层**（PLAN.md §3.22 M8-7）。
//!
//! 这一层只做四件事：算 Git 对象 id、判路径能不能落盘、维护 `~/.vela/sync-state.json`、
//! 把 base/local/remote 三张 `path → blob sha` 表比成一个计划。⛔ 不发请求、不读钥匙串、
//! 不碰配置：REST 六条在 M8-8 的 `src-tauri/src/github.rs`，这里只给它在动手之前
//! 一个「拉哪些、推哪些、停在哪」的答案。
//!
//! ## 为什么三方比对只有整理文件这一格
//!
//! 素材文件（`…·划线素材.md`）是机器的地盘，而且不进版本库（§3.22 决定 2），所以它
//! 根本不在快照里；整理文件是用户的地盘，本地与远端各有一份真相，只有相对 base
//! 两边都变了才需要人。`is_managed_path` 是「进同步集合」的唯一判据，M8-8 扫目录与
//! 过滤远端树都必须用它，⛔ 不要各写一张扩展名表。
//!
//! ## 本地 sha 为什么必须是 Git 的 blob id
//!
//! 远端与 base 两列是 GitHub 给的 blob sha；本地这一列如果用自己的哈希（哪怕更强的
//! SHA-256），三列就永远不相等，比对退化成「每个文件都变过」。所以 [`blob_sha`] 算的是
//! Git 的对象口径：`sha1("blob " + 字节数 + "\0" + 正文)`。这样推上去的内容 sha 与本地
//! 算出来的一模一样，[`SyncPlan::next_base`] 不必等远端回话就能先记下来。
//!
//! ## 删除不传播
//!
//! 计划里的「四条必须停」没有覆盖「一边删了、另一边还在」。这一层的选择是更保守的
//! 那一侧：**任何删除都不自动传播，也不自动复活**——远端删了本地没动的、本地删了
//! 远端没动的，都进 [`Conflict`] 让用户处理。只有「两边都删了」才是无事发生。
//! 理由：⛔ 不删远端文件是硬约束；而按「远端没了就删本地」自动决策，用户的一条笔记
//! 在一次误操作或一次错的 token 之后就会消失，且没有第二份可回滚。
//!
//! ## state 的家与「换仓库」
//!
//! `~/.vela/sync-state.json`（PLAN ⑭），只放 `repo` / `branch` / `path → sha`。state 里
//! 记着它属于哪个仓库与分支：配置改到别的仓库时 [`SyncState::base_for`] 直接退回空表，
//! 于是下一次比对走「无 base」那条保守分支，⛔ 不会拿旧仓库的 sha 去判新仓库的文件。
//!
//! ## `.gitignore` 只维护，不同步
//!
//! [`with_material_ignore`] 给 M8-8 在**本地**配置目录根上补那一行（`*·划线素材.md`），
//! 防的是用户自己在这个目录里跑 `git add .` 时把划线原文提交上去。它不是整理文件，
//! 所以不进快照、不参与比对：远端那份 `.gitignore` 是用户自己的事，⛔ 不替它做主。

pub mod blob;
pub mod compare;
pub mod paths;
pub mod state;

pub use blob::blob_sha;
pub use compare::{compare, Conflict, ConflictKind, PullAction, PushAction, Snapshot, SyncError, SyncPlan};
pub use paths::{
    is_managed_path, is_material_path, is_note_path, safe_rel, with_material_ignore, GITIGNORE_FILE,
    MATERIAL_IGNORE_LINE,
};
pub use state::{load_state, save_state, StateError, SyncState, STATE_VERSION};
