//! base / local / remote 三方比对（PLAN.md §3.22 M8-7，⑥ ④）。
//!
//! 输入是三张 `path → blob sha` 表，输出是「拉哪些、推哪些、停在哪」。全部是纯函数：
//! 不读盘、不发请求、不看配置。M8-8 拿到计划之后才去碰 blobs / tree / commit。
//!
//! ## 判定表
//!
//! 记 `B` / `L` / `R` 分别是 base / local / remote 里这个路径的值（缺失 = `None`）：
//!
//! | 条件 | 结果 |
//! |---|---|
//! | `L == R` | 无事（两边已经一致，含「两边都没有」） |
//! | `L == B`、`R` 有值 | 拉（远端这一份是唯一改动） |
//! | `L == B`、`R` 缺失 | 停（远端删了、本地没动） |
//! | `R == B`、`L` 有值 | 推（本地这一份是唯一改动） |
//! | `R == B`、`L` 缺失 | 停（本地删了、远端没动） |
//! | 其余：两边都偏离 base | 停（双边改动；无 base 时更保守） |
//!
//! 第一行比第二/四行先判，所以「base 里有、两边都变了但变得一样」也是无事——
//! 两边的 sha 都是内容寻址的，内容一样 sha 必然一样。
//!
//! ## 为什么冲突时 `next_base` 是 `None`
//!
//! 计划第 5 步是「state 最后写」。一旦有冲突，这次同步停在第 2 步，一个字节都没写，
//! state 当然也不该动。把它做成 `Option` 而不是「让调用方记得别看」，是因为
//! 忘记看它的后果很重：state 前移之后，这次没处理的冲突就永远查不出来了。
//!
//! ## 删除为什么不自动传播
//!
//! 见模块 [`crate::sync`] 的文档。一句话：删远端是硬禁令，删本地是数据损失，
//! 两个方向都没有安全的自动答案，所以交给用户。

use std::collections::BTreeSet;

use super::paths::safe_rel;

/// 一张 `path → blob sha` 表。三个来源（base / local / remote）共用这一种形状。
pub type Snapshot = std::collections::BTreeMap<String, String>;

/// 「把远端这一份写到本地」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullAction {
    pub path: String,
    /// 远端当前的 blob sha；M8-8 用它去 `GET blobs/{sha}`。
    pub sha: String,
}

/// 「把本地这一份推到远端」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushAction {
    pub path: String,
    /// 本地算出来的 blob sha；推完远端应当回报同一个值。
    pub sha: String,
}

/// 冲突的类型。只影响文案，不改变「一律停」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictKind {
    /// 有 base，两边都相对它变过。
    BothChanged,
    /// 没有 base（首次/换设备/换仓库），两边都有且不同——保守地当作冲突。
    NoBase,
    /// 本地删了、远端没动。
    LocalDeleted,
    /// 远端删了、本地没动。
    RemoteDeleted,
}

/// 一个需要人处理的路径。三个 `Option` 直接给界面展示，⛔ 不做真三方合并。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub path: String,
    pub base: Option<String>,
    pub local: Option<String>,
    pub remote: Option<String>,
    pub kind: ConflictKind,
}

/// 一次比对的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncPlan {
    pub pull: Vec<PullAction>,
    pub push: Vec<PushAction>,
    pub conflicts: Vec<Conflict>,
    /// 没有冲突时才有的「这次同步成功后应当写进 state 的 base」。
    ///
    /// 冲突时为 `None`（见模块文档）。有值时它就是「同步完两边一致」的那张表：
    /// 拉的那份记远端 sha，推的那份记本地 sha（内容寻址保证远端回报同一个），
    /// 没动的那份原样保留，两边都删了的那份不在表里。
    pub next_base: Option<Snapshot>,
}

impl SyncPlan {
    pub fn has_conflicts(&self) -> bool {
        !self.conflicts.is_empty()
    }

    /// 这次一次要动的文件数（不含冲突）。用于进度分母与「没有可同步的东西」文案。
    pub fn action_count(&self) -> usize {
        self.pull.len() + self.push.len()
    }
}

/// 比对本身能出的错。路径不干净是唯一一种——那是「一个字都不许写」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    UnsafePath { path: String },
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsafePath { path } => write!(f, "同步路径不在配置目录内：{path}"),
        }
    }
}

impl std::error::Error for SyncError {}

/// 三张表比成一个计划。
///
/// `base` 用 [`crate::sync::SyncState::base_for`] 取（目标失配时是空表）；
/// `local` / `remote` 由 M8-8 用 [`crate::sync::is_managed_path`] 过滤后递进来。
pub fn compare(base: &Snapshot, local: &Snapshot, remote: &Snapshot) -> Result<SyncPlan, SyncError> {
    // 先整体过一遍闸门：任何一张表里有不安全路径就整个计划作废。
    // ⛔ 不要「跳过这一条继续比」——路径越界说明输入本身不可信，静默跳过等于
    // 把一次攻击/一次配置错误藏起来
    for snapshot in [base, local, remote] {
        for path in snapshot.keys() {
            if safe_rel(path).is_none() {
                return Err(SyncError::UnsafePath { path: path.clone() });
            }
        }
    }

    let mut paths: BTreeSet<&str> = BTreeSet::new();
    paths.extend(base.keys().map(String::as_str));
    paths.extend(local.keys().map(String::as_str));
    paths.extend(remote.keys().map(String::as_str));

    let mut pull = Vec::new();
    let mut push = Vec::new();
    let mut conflicts = Vec::new();
    let mut merged = Snapshot::new();

    for path in paths {
        let b = base.get(path);
        let l = local.get(path);
        let r = remote.get(path);

        // 两边一致（含都没了）：base 跟上，别的什么都不做
        if l == r {
            if let Some(sha) = l {
                merged.insert(path.to_owned(), sha.clone());
            }
            continue;
        }

        // 本地没动，只有远端变了
        if l == b {
            match r {
                Some(sha) => {
                    pull.push(PullAction { path: path.to_owned(), sha: sha.clone() });
                    merged.insert(path.to_owned(), sha.clone());
                }
                None => conflicts.push(conflict(path, b, l, r, ConflictKind::RemoteDeleted)),
            }
            continue;
        }

        // 远端没动，只有本地变了
        if r == b {
            match l {
                Some(sha) => {
                    push.push(PushAction { path: path.to_owned(), sha: sha.clone() });
                    merged.insert(path.to_owned(), sha.clone());
                }
                None => conflicts.push(conflict(path, b, l, r, ConflictKind::LocalDeleted)),
            }
            continue;
        }

        // 两边都偏离 base
        let kind = if b.is_none() { ConflictKind::NoBase } else { ConflictKind::BothChanged };
        conflicts.push(conflict(path, b, l, r, kind));
    }

    let next_base = if conflicts.is_empty() { Some(merged) } else { None };
    Ok(SyncPlan { pull, push, conflicts, next_base })
}

fn conflict(
    path: &str,
    base: Option<&String>,
    local: Option<&String>,
    remote: Option<&String>,
    kind: ConflictKind,
) -> Conflict {
    Conflict { path: path.to_owned(), base: base.cloned(), local: local.cloned(), remote: remote.cloned(), kind }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(entries: &[(&str, &str)]) -> Snapshot {
        entries.iter().map(|(path, sha)| ((*path).to_owned(), (*sha).to_owned())).collect()
    }

    fn kinds(plan: &SyncPlan) -> Vec<(&str, ConflictKind)> {
        plan.conflicts.iter().map(|c| (c.path.as_str(), c.kind)).collect()
    }

    // ─── 六条必须覆盖的情形 ─────────────────────────────────────────────

    #[test]
    fn 两边同就什么都不做() {
        let table = snap(&[("a.md", "1")]);
        let plan = compare(&table, &table, &table).unwrap();
        assert!(plan.pull.is_empty());
        assert!(plan.push.is_empty());
        assert!(!plan.has_conflicts());
        assert_eq!(plan.action_count(), 0);
        assert_eq!(plan.next_base, Some(table));
    }

    #[test]
    fn 只本地变就推() {
        let base = snap(&[("a.md", "1")]);
        let local = snap(&[("a.md", "2")]);
        let plan = compare(&base, &local, &base).unwrap();
        assert_eq!(plan.push, vec![PushAction { path: "a.md".to_owned(), sha: "2".to_owned() }]);
        assert!(plan.pull.is_empty());
        assert!(!plan.has_conflicts());
        assert_eq!(plan.next_base, Some(local));
    }

    #[test]
    fn 只远端变就拉() {
        let base = snap(&[("a.md", "1")]);
        let remote = snap(&[("a.md", "2")]);
        let plan = compare(&base, &base, &remote).unwrap();
        assert_eq!(plan.pull, vec![PullAction { path: "a.md".to_owned(), sha: "2".to_owned() }]);
        assert!(plan.push.is_empty());
        assert!(!plan.has_conflicts());
        assert_eq!(plan.next_base, Some(remote));
    }

    #[test]
    fn 双边都变必须停() {
        let base = snap(&[("a.md", "1")]);
        let local = snap(&[("a.md", "2")]);
        let remote = snap(&[("a.md", "3")]);
        let plan = compare(&base, &local, &remote).unwrap();
        assert!(plan.pull.is_empty());
        assert!(plan.push.is_empty());
        assert_eq!(kinds(&plan), vec![("a.md", ConflictKind::BothChanged)]);
        // 🔴 冲突时 state 绝不许前移：下一次还要能查出这一格
        assert_eq!(plan.next_base, None);
        assert_eq!(
            plan.conflicts[0],
            Conflict {
                path: "a.md".to_owned(),
                base: Some("1".to_owned()),
                local: Some("2".to_owned()),
                remote: Some("3".to_owned()),
                kind: ConflictKind::BothChanged,
            }
        );
    }

    #[test]
    fn 无_base_时只有单边存在才敢动() {
        let local = snap(&[("new-local.md", "l"), ("same.md", "s")]);
        let remote = snap(&[("new-remote.md", "r"), ("same.md", "s")]);

        // 各有一份对方没有的：推 / 拉都安全（创建，不覆盖任何东西）
        let plan = compare(&Snapshot::new(), &local, &remote).unwrap();
        assert_eq!(plan.push, vec![PushAction { path: "new-local.md".to_owned(), sha: "l".to_owned() }]);
        assert_eq!(plan.pull, vec![PullAction { path: "new-remote.md".to_owned(), sha: "r".to_owned() }]);
        assert!(!plan.has_conflicts());
        assert_eq!(plan.next_base, Some(snap(&[("new-local.md", "l"), ("new-remote.md", "r"), ("same.md", "s")])));
    }

    #[test]
    fn 无_base_且两边都有但不同就停() {
        let local = snap(&[("a.md", "2")]);
        let remote = snap(&[("a.md", "3")]);
        let plan = compare(&Snapshot::new(), &local, &remote).unwrap();
        assert_eq!(kinds(&plan), vec![("a.md", ConflictKind::NoBase)]);
        assert_eq!(plan.next_base, None);
        // 界面要能看见两边各是什么
        assert_eq!(plan.conflicts[0].base, None);
        assert_eq!(plan.conflicts[0].local.as_deref(), Some("2"));
        assert_eq!(plan.conflicts[0].remote.as_deref(), Some("3"));
    }

    #[test]
    fn 越界路径让整个计划作废() {
        for bad in ["../evil.md", "/etc/passwd", "a/../../b.md", "a\\b.md"] {
            let input = snap(&[(bad, "x")]);
            assert_eq!(
                compare(&input, &Snapshot::new(), &Snapshot::new()),
                Err(SyncError::UnsafePath { path: bad.to_owned() }),
                "base: {bad}"
            );
            assert_eq!(
                compare(&Snapshot::new(), &input, &Snapshot::new()),
                Err(SyncError::UnsafePath { path: bad.to_owned() }),
                "local: {bad}"
            );
            assert_eq!(
                compare(&Snapshot::new(), &Snapshot::new(), &input),
                Err(SyncError::UnsafePath { path: bad.to_owned() }),
                "remote: {bad}"
            );
        }
    }

    // ─── 删除：一律停，不传播也不复活 ───────────────────────────────────

    #[test]
    fn 远端删了本地没动要停() {
        let base = snap(&[("a.md", "1")]);
        let plan = compare(&base, &base, &Snapshot::new()).unwrap();
        assert_eq!(kinds(&plan), vec![("a.md", ConflictKind::RemoteDeleted)]);
        assert_eq!(plan.next_base, None);
    }

    #[test]
    fn 本地删了远端没动要停() {
        let base = snap(&[("a.md", "1")]);
        let plan = compare(&base, &Snapshot::new(), &base).unwrap();
        assert_eq!(kinds(&plan), vec![("a.md", ConflictKind::LocalDeleted)]);
        assert_eq!(plan.next_base, None);
    }

    #[test]
    fn 一边删了另一边还改了也是停() {
        let base = snap(&[("a.md", "1")]);
        let plan = compare(&base, &snap(&[("a.md", "2")]), &Snapshot::new()).unwrap();
        assert_eq!(kinds(&plan), vec![("a.md", ConflictKind::BothChanged)]);
        assert_eq!(plan.conflicts[0].remote, None);
        assert_eq!(plan.next_base, None);
    }

    #[test]
    fn 两边都删了就无事并从_base_里去掉() {
        let base = snap(&[("a.md", "1"), ("b.md", "2")]);
        let plan = compare(&base, &snap(&[("b.md", "2")]), &snap(&[("b.md", "2")])).unwrap();
        assert!(!plan.has_conflicts());
        assert_eq!(plan.next_base, Some(snap(&[("b.md", "2")])));
    }

    // ─── 组合与边界 ─────────────────────────────────────────────────────

    #[test]
    fn 一份计划里可以同时有推拉而互不影响() {
        let base = snap(&[("push.md", "p1"), ("pull.md", "r1"), ("same.md", "s")]);
        let local = snap(&[("push.md", "p2"), ("pull.md", "r1"), ("same.md", "s"), ("new.md", "n")]);
        let remote = snap(&[("push.md", "p1"), ("pull.md", "r2"), ("same.md", "s")]);
        let plan = compare(&base, &local, &remote).unwrap();
        assert_eq!(plan.pull, vec![PullAction { path: "pull.md".to_owned(), sha: "r2".to_owned() }]);
        assert_eq!(
            plan.push,
            vec![
                PushAction { path: "new.md".to_owned(), sha: "n".to_owned() },
                PushAction { path: "push.md".to_owned(), sha: "p2".to_owned() },
            ]
        );
        assert!(!plan.has_conflicts());
        assert_eq!(plan.action_count(), 3);
        assert_eq!(
            plan.next_base,
            Some(snap(&[("new.md", "n"), ("pull.md", "r2"), ("push.md", "p2"), ("same.md", "s"),]))
        );
    }

    #[test]
    fn 两边都变但变得一样就无事() {
        // base 落后、两边各自改成了同一份内容：内容寻址让 sha 相等，不该报冲突
        let base = snap(&[("a.md", "1")]);
        let both = snap(&[("a.md", "2")]);
        let plan = compare(&base, &both, &both).unwrap();
        assert!(!plan.has_conflicts());
        assert_eq!(plan.next_base, Some(both));
    }

    #[test]
    fn 子目录路径照常比() {
        let base = snap(&[("子目录/a.md", "1")]);
        let local = snap(&[("子目录/a.md", "2")]);
        let plan = compare(&base, &local, &base).unwrap();
        assert_eq!(plan.push[0].path, "子目录/a.md");
    }

    #[test]
    fn 一份空的表之间比出空计划() {
        let plan = compare(&Snapshot::new(), &Snapshot::new(), &Snapshot::new()).unwrap();
        assert_eq!(plan.action_count(), 0);
        assert!(!plan.has_conflicts());
        assert_eq!(plan.next_base, Some(Snapshot::new()));
    }
}
