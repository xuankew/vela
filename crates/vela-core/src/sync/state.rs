//! `~/.vela/sync-state.json` 的形状与读写（PLAN.md §3.22 M8-7 / ⑭）。
//!
//! 文件里只有三样东西：它属于哪个 `repo` / `branch`，以及对每个整理文件
//! 「上次同步时两边一致的 blob sha」。
//!
//! ## 为什么记 repo / branch
//!
//! base 的含义是「我上次看到的世界」；换一个仓库或换一个分支，那份世界就不成立了。
//! 不记这两格的话，把配置从 A 仓库改到 B 仓库，比对会拿 A 的 sha 去判 B 的文件：
//! 结果是**看起来每个文件都变过**，轻则全量重推，重则把 A 的内容当冲突拦下。
//! 失配时退回空表（[`SyncState::base_for`]），下一次走「无 base」的保守分支。
//!
//! ## 为什么坏掉不拦同步
//!
//! 与微信读书的 `weread-state.json` 同一条口径：state 是**优化**，不是真相。
//! 读不到、读坏了、版本不认识，最坏只是把「相对 base 两边都变」退化成「没有 base」，
//! 而那条分支本来就必须是安全的。为一份缓存拦下整个同步，用户会连笔记都拿不到。
//!
//! ## 为什么用 `BTreeMap`
//!
//! 同一份内容写出来的字节必须稳定：state 在 `~/.vela/` 下，不进 git，但用户可能拿
//! 它做对比或备份；随哈希顺序抖动的文件会制造没有意义的差异。`BTreeMap` 按 key 排序，
//! `serde_json::to_vec_pretty` 输出固定。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::compare::Snapshot;
use super::paths::safe_rel;
use crate::fs::write_bytes_atomic;

/// 当前 state 版本。不认识的版本整份当空表（与 `session` 的严格相反，理由见模块文档）。
pub const STATE_VERSION: u32 = 1;

/// `~/.vela/sync-state.json` 的内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncState {
    pub version: u32,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub files: Snapshot,
}

impl Default for SyncState {
    fn default() -> Self {
        Self { version: STATE_VERSION, repo: String::new(), branch: String::new(), files: Snapshot::new() }
    }
}

impl SyncState {
    /// 空表：没有 base、也没有目标信息。
    pub fn empty() -> Self {
        Self::default()
    }

    /// 从字节解析。任何不认识的东西都退化成空表，⛔ 不返回错误。
    ///
    /// 危险路径（`..`、绝对路径等）逐条丢掉而不是整份作废：一份被手工改坏的 state
    /// 不该连带把其余几十个文件的 base 一起清掉。清掉之后那条路径按「无 base」处理。
    pub fn parse(bytes: &[u8]) -> Self {
        let Ok(mut parsed) = serde_json::from_slice::<Self>(bytes) else {
            return Self::empty();
        };
        if parsed.version != STATE_VERSION {
            return Self::empty();
        }
        parsed.files.retain(|path, _| safe_rel(path).is_some());
        parsed
    }

    /// 这份 state 对当前目标是不是可用作 base。
    ///
    /// 目标为空（没配仓库/分支）或与 state 记录的不同，一律当空表——
    /// 这就是「换仓库不能拿旧 sha 判新文件」那条的实现。
    pub fn base_for(&self, repo: &str, branch: &str) -> Snapshot {
        let usable = self.version == STATE_VERSION
            && !repo.is_empty()
            && !branch.is_empty()
            && self.repo == repo
            && self.branch == branch;
        if usable {
            self.files.clone()
        } else {
            Snapshot::new()
        }
    }

    /// 一次同步成功后整份换掉：目标与 base 一起写。
    pub fn record(&mut self, repo: &str, branch: &str, base: Snapshot) {
        self.version = STATE_VERSION;
        self.repo = repo.to_owned();
        self.branch = branch.to_owned();
        self.files = base;
    }
}

/// state 写盘失败。读永远不失败（见模块文档）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    Io { path: String, message: String },
    Encode { message: String },
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, message } => write!(f, "写同步状态 {path} 失败：{message}"),
            Self::Encode { message } => write!(f, "同步状态序列化失败：{message}"),
        }
    }
}

impl std::error::Error for StateError {}

/// 读 state。缺失、读不出、内容坏了都回空表。
pub fn load_state(path: &Path) -> SyncState {
    fs::read(path).map(|bytes| SyncState::parse(&bytes)).unwrap_or_default()
}

/// 原子写 state；`~/.vela/` 不存在时先建出来（第一次同步时它可能还没有）。
pub fn save_state(path: &Path, state: &SyncState) -> Result<(), StateError> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .map_err(|err| StateError::Io { path: parent.display().to_string(), message: err.to_string() })?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|err| StateError::Encode { message: err.to_string() })?;
    write_bytes_atomic(path, &bytes)
        .map_err(|err| StateError::Io { path: path.display().to_string(), message: err.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(entries: &[(&str, &str)]) -> Snapshot {
        entries.iter().map(|(path, sha)| ((*path).to_owned(), (*sha).to_owned())).collect()
    }

    #[test]
    fn 缺失文件读成空表() {
        let dir = tempfile::tempdir().unwrap();
        let state = load_state(&dir.path().join("nope.json"));
        assert_eq!(state, SyncState::empty());
        assert!(state.base_for("owner/repo", "main").is_empty());
    }

    #[test]
    fn 坏了或不认识的版本都退成空表() {
        assert_eq!(SyncState::parse(b"not json"), SyncState::empty());
        assert_eq!(SyncState::parse(b"[]"), SyncState::empty());
        assert_eq!(SyncState::parse(br#"{"version":99,"files":{"a.md":"x"}}"#), SyncState::empty());
        assert_eq!(SyncState::parse(br#"{"repo":"o/r","files":{"a.md":"x"}}"#), SyncState::empty());
    }

    #[test]
    fn 往返字节稳定且按路径排序() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".vela/sync-state.json");
        let mut state = SyncState::empty();
        state.record("o/r", "main", snap(&[("b.md", "2"), ("a.md", "1")]));
        save_state(&path, &state).unwrap();
        let first = fs::read(&path).unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded, state);
        assert_eq!(loaded.base_for("o/r", "main"), snap(&[("a.md", "1"), ("b.md", "2")]));
        // 同一份内容再写一次，字节必须一字不差（BTreeMap 的排序在这里兑现）
        save_state(&path, &loaded).unwrap();
        assert_eq!(fs::read(&path).unwrap(), first);
        // 顺带钉住「第一次同步时 ~/.vela 还不存在」
        assert!(path.exists());
    }

    #[test]
    fn 目标失配退回空_base() {
        let mut state = SyncState::empty();
        state.record("owner/a", "main", snap(&[("a.md", "1")]));
        assert!(state.base_for("owner/b", "main").is_empty());
        assert!(state.base_for("owner/a", "dev").is_empty());
        assert!(state.base_for("", "main").is_empty());
        assert!(state.base_for("owner/a", "").is_empty());
        assert_eq!(state.base_for("owner/a", "main"), snap(&[("a.md", "1")]));
    }

    #[test]
    fn 危险路径逐条丢掉而不是整份作废() {
        let bytes = br#"{
            "version": 1,
            "repo": "o/r",
            "branch": "main",
            "files": {
                "a.md": "1",
                "../evil.md": "2",
                "/etc/passwd": "3"
            }
        }"#;
        let state = SyncState::parse(bytes);
        assert_eq!(state.base_for("o/r", "main"), snap(&[("a.md", "1")]));
    }
}
