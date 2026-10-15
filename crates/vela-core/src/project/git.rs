//! 只读地回答一个问题：这个项目根现在在哪个分支上（状态栏右下角那一格）。
//!
//! ## 为什么是读文件而不是跑 `git`
//!
//! `git rev-parse --abbrev-ref HEAD` 是「标准答案」，这里刻意不用它，三条理由：
//!
//! 1. **一次 refresh 就是一个子进程。** 这一格在窗口每次重新获得焦点时都要重读一遍
//!    （用户在终端里 `git checkout` 完切回来，看到的必须是新分支）。fork + exec 一次
//!    git 在 macOS 上是几十毫秒起，而读一个 40 字节的文件是几微秒——差四个数量级，
//!    而换来的信息**一模一样**。
//! 2. **`git` 不一定在 PATH 上。** `.app` 双击启动时进程的环境不是用户 shell 的环境
//!    （同一条约束已经在 `commands.rs` 的 `BadRoot` 上出现过一次：cwd 也不是）。
//!    拿 `Command::new("git")` 去问，失败方式是「装了 git 的人有时也问不到」，最难查。
//! 3. **`git2` 那条路更贵。** 链一份 libgit2 换「读一行文本」，构建时间与二进制体积
//!    都要涨，而本模块一个 libgit2 的 API 都用不上。
//!
//! 代价是这一格**只知道 HEAD 指向哪儿**，不知道工作区脏不脏、领先落后几个提交——
//! 那两样要读对象库与 index，是真要 libgit2 的活儿。取舍写在 `GitHead` 的文档上。
//!
//! ## HEAD 那两种内容
//!
//! `.git/HEAD` 是一个纯文本文件，只有两种写法：
//!
//! - `ref: refs/heads/main\n` —— 在分支上（**刚 `git init` 还没有任何提交也是这一种**，
//!   那个分支叫「未出生」，但名字已经写在这儿了，报出来正是用户想看的）
//! - `6a1b2c3...\n` —— 游离 HEAD（`git checkout <sha>` / `git rebase` 中途 /
//!   `git worktree add --detach`），40 位十六进制，没有分支名可报
//!
//! ## `.git` 不一定是目录
//!
//! worktree 与 submodule 的 `.git` 是一个**文件**，内容形如
//! `gitdir: /path/to/main-repo/.git/worktrees/feature\n`（相对路径则相对这个文件自己
//! 所在的目录）。真 HEAD 在它指过去的那个目录里。漏掉这一支的后果是「用 worktree 的
//! 人永远看不到分支」，而 worktree 恰好是同时在两个分支上干活的人最常用的工具。
//!
//! ## 只认根目录自己那一个 `.git`
//!
//! **不往祖先目录找。** 打开 `repo/src` 时这一格是空的，而不是 `repo` 的分支。
//! 这是刻意的：往上走会在用户没同意的情况下报出一个「不属于他打开的那个文件夹」的答案，
//! 而根目录本身不是仓库时，「没有分支」是唯一诚实的回答。（真要往上找，还得决定
//! 走到哪儿停——文件系统根？家目录？每一条都是产品决定，而不是一次目录遍历。）
//!
//! ## 为什么返回 `Option` 而不是 `Result`
//!
//! 这一格是**装饰**，不是功能：读不到就该什么都不显示。给它一条错误通道，前端就得
//! 决定「把 `io: permission denied` 说给一个只想知道自己在哪个分支上的人听」——
//! 那句话对他没有任何可做的动作。所以「不是仓库」「HEAD 读不动」「内容认不出来」
//! 三种处境一律压成 `None`，前端一律渲染成「没有这一格」。
//! ⚠️ 这条口径与 `tree.rs` 的 `TreeError` 相反，那边每一种错都对应一个用户能做的动作。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 一个项目根的 HEAD 指向。
///
/// `name` 在两种情况下含义不同，`detached` 就是那把区分它们的钥匙：
///
/// - `detached: false` → `name` 是**分支名**（`main`），ref 前缀已经剥掉了
/// - `detached: true` → `name` 是**短 sha**（`6a1b2c3`），压根没有分支名可给
///
/// 🔴 前端**必须**看 `detached` 再决定怎么措辞：把短 sha 当分支名显示成 `⎇ 6a1b2c3`
/// 是一句假话——`git checkout 6a1b2c3` 与「在分支 6a1b2c3 上」是两件不同的事，
/// 而用户会照着这一格去理解自己的提交会落到哪儿。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHead {
    pub name: String,
    pub detached: bool,
}

/// 游离 HEAD 报几位。与 git 自己的默认 `core.abbrev` 一致：够在一屏 log 里认出来，
/// 又不会把 22px 高的状态栏撑成一行路径。
///
/// ⚠️ 短 sha 有撞车的可能，git 会在真撞上的时候自己加长——我们不查对象库，
/// 所以这里报的那 7 位**理论上**可能是歧义的。状态栏上这不构成问题（它只用来认，
/// 不用来 checkout），但要拿它去做任何解析就必须先想清楚这一点。
const SHORT_SHA: usize = 7;

/// 读 `root` 这个工作副本的 HEAD。`None` = 「这一格不该出现」，理由见模块文档最后一段。
pub fn read_head(root: &Path) -> Option<GitHead> {
    let git_dir = git_dir(root)?;
    // `read_to_string` 顺带挡掉了非 UTF-8 的 HEAD：那种文件是被人手工写坏的，
    // 报出来只会是一屏乱码
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    parse_head(&head)
}

/// `root/.git` 指向的那个**真**目录。worktree / submodule 的那一支要多跳一次。
fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot = root.join(".git");
    // `symlink_metadata` 而不是 `metadata`：`.git` 是个符号链接时（少见但合法，
    // 有人把仓库的元数据放到别处）`metadata` 会跟过去，于是 `is_dir` 与 `is_file`
    // 说的都是链接另一头的东西。跟过去在这里恰好也是对的行为——所以这条用哪个都行，
    // 但**必须固定一个**，否则「.git 是链接」这一种在两个实现下的答案会不一样
    let meta = fs::symlink_metadata(&dot).ok()?;
    if meta.is_dir() {
        return Some(dot);
    }
    if !meta.is_file() {
        return None;
    }
    let text = fs::read_to_string(&dot).ok()?;
    let target = text.strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    let target = Path::new(target);
    // 相对路径相对**这个 `.git` 文件自己**所在的目录，不是相对 root，也不是相对 cwd。
    // git 自己就是这么解的（`setup.c` 的 `resolve_gitfile`）
    Some(if target.is_absolute() { target.to_path_buf() } else { dot.parent()?.join(target) })
}

/// HEAD 的文本 → 一个 `GitHead`。拆出来是为了能被单测直接喂字符串，不用先造目录。
fn parse_head(text: &str) -> Option<GitHead> {
    let line = text.trim();
    if line.is_empty() {
        return None;
    }
    if let Some(rest) = line.strip_prefix("ref:") {
        let target = rest.trim();
        // `refs/heads/x` → `x`。别的 ref（`refs/remotes/origin/x`，出现在手工把 HEAD
        // 写成远端跟踪分支的仓库里）只剥掉 `refs/`：全名太长会把状态栏撑破，
        // 而剩下的 `remotes/origin/x` 已经读得出来了
        let name = target.strip_prefix("refs/heads/").or_else(|| target.strip_prefix("refs/")).unwrap_or(target);
        return (!name.is_empty()).then(|| GitHead { name: name.to_owned(), detached: false });
    }
    // 到这里就是游离 HEAD 那一支：一整行 sha。
    // ⚠️ 先验字符再截断——不是防攻击（HEAD 是我们自己读的文本），是防**假答案**：
    // 一个被写坏的 HEAD 里的第一个词看着就像个 sha，截 7 位报出去，用户会以为
    // 自己在一个其实不存在的提交上
    let sha = line;
    if sha.len() < SHORT_SHA || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(GitHead { name: sha[..SHORT_SHA].to_owned(), detached: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个 `root/.git/HEAD`，返回 root（`TempDir` 必须被调用方拿着，否则立刻被删）
    fn repo_with_head(content: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), content).unwrap();
        (dir, root)
    }

    // ── 在分支上 ─────────────────────────────────────────────────────────────

    #[test]
    fn 分支名从_ref_里剥出来() {
        let (_dir, root) = repo_with_head("ref: refs/heads/main\n");
        assert_eq!(read_head(&root), Some(GitHead { name: "main".to_owned(), detached: false }));
    }

    #[test]
    fn 分支名里的斜杠原样留着() {
        // `feature/m5-git` 是合法的分支名，剥到第一个 `/` 就停会把它报成 `feature`
        let (_dir, root) = repo_with_head("ref: refs/heads/feature/m5-git\n");
        assert_eq!(read_head(&root).unwrap().name, "feature/m5-git");
    }

    #[test]
    fn 没有末尾换行也认() {
        // git 自己总会写那个 `\n`，但手工改过的 HEAD 不一定有
        let (_dir, root) = repo_with_head("ref: refs/heads/dev");
        assert_eq!(read_head(&root).unwrap().name, "dev");
    }

    #[test]
    fn 未出生的分支也报分支名() {
        // `git init` 之后一个提交都没有：HEAD 里已经写着名字了，而 index 与对象库都是空的。
        // 这一种必须报成「在 main 上」——报「没有分支」会让用户以为 init 失败了
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();

        assert_eq!(read_head(root), Some(GitHead { name: "main".to_owned(), detached: false }));
    }

    #[test]
    fn 远端跟踪分支只剥_refs_那一层() {
        let (_dir, root) = repo_with_head("ref: refs/remotes/origin/main\n");
        let head = read_head(&root).unwrap();
        assert_eq!(head.name, "remotes/origin/main");
        assert!(!head.detached);
    }

    // ── 游离 HEAD ────────────────────────────────────────────────────────────

    #[test]
    fn 游离_head_报短_sha_并标记_detached() {
        let (_dir, root) = repo_with_head("6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b\n");
        assert_eq!(read_head(&root), Some(GitHead { name: "6a1b2c3".to_owned(), detached: true }));
    }

    #[test]
    fn 认不出来的_head_内容一律_none() {
        // 三种都要挡住：空的、`ref:` 后面什么都没有的、以及一个不像 sha 的词。
        // 最后那一种最要紧——它是「把假答案报出去」与「不报」之间的那条线
        for bad in ["", "\n", "   ", "ref:\n", "ref: \n", "hello\n", "6a1b2c\n", "zzzzzzzzzz\n"] {
            let (_dir, root) = repo_with_head(bad);
            assert_eq!(read_head(&root), None, "HEAD = {bad:?} 不该报出任何分支");
        }
    }

    // ── 不是仓库 / 读不动 ─────────────────────────────────────────────────────

    #[test]
    fn 没有_git_的目录是_none() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "# 标题").unwrap();
        assert_eq!(read_head(dir.path()), None);
    }

    #[test]
    fn 有_git_目录但没有_head_文件是_none() {
        // 半个仓库：`.git` 存在（于是侧边栏里看得见它），HEAD 却没有
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        assert_eq!(read_head(dir.path()), None);
    }

    #[test]
    fn 不往祖先目录找() {
        // 模块文档里那条「只认根自己那一个 .git」。打开 `repo/src` 时必须什么都没有，
        // 而不是把 `repo` 的分支报出来——那不是他打开的那个文件夹的答案
        let (_dir, root) = repo_with_head("ref: refs/heads/main\n");
        let nested = root.join("src");
        fs::create_dir_all(&nested).unwrap();

        assert_eq!(read_head(&nested), None);
        assert_eq!(read_head(&root).unwrap().name, "main");
    }

    // ── worktree / submodule：`.git` 是个文件 ────────────────────────────────

    /// 造一个「主仓库 + 一个 worktree」的最小现场：worktree 的 `.git` 是文件，
    /// 内容指回主仓库 `.git/worktrees/<name>`，真 HEAD 在那一头
    fn worktree(gitdir_line: &str, head: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let real = root.join("real-git-dir");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("HEAD"), head).unwrap();
        let work = root.join("work");
        fs::create_dir_all(&work).unwrap();
        // gitdir_line 里的 `{{REAL}}` 换成真目录，方便一条用例造绝对与相对两种写法
        fs::write(work.join(".git"), gitdir_line.replace("{{REAL}}", &real.display().to_string())).unwrap();
        (dir, work)
    }

    #[test]
    fn git_是文件时按_gitdir_跳过去读() {
        let (_dir, work) = worktree("gitdir: {{REAL}}\n", "ref: refs/heads/feature\n");
        assert_eq!(read_head(&work), Some(GitHead { name: "feature".to_owned(), detached: false }));
    }

    #[test]
    fn 相对的_gitdir_相对那个文件自己解析() {
        // git 允许写相对路径。基准是 `.git` 文件所在的目录（也就是 work），不是 root，
        // 更不是进程 cwd——按 cwd 解的话答案会跟着「Vela 是怎么被启动的」变。
        // ⚠️ fixture 里那个 `../` 因此是必需的：`real-git-dir` 与 `work` 是兄弟，
        // 写成不带 `../` 的形式就等于要求「相对 work 的上一层」，那是 root
        let (_dir, work) = worktree("gitdir: ../real-git-dir\n", "ref: refs/heads/rel-branch\n");
        assert_eq!(read_head(&work).unwrap().name, "rel-branch");
    }

    #[test]
    fn gitdir_那一行认不出来时是_none() {
        for bad in ["", "\n", "gitdir:\n", "not-a-gitdir-line\n", "/no/such/dir\n"] {
            let (_dir, work) = worktree(bad, "ref: refs/heads/main\n");
            assert_eq!(read_head(&work), None, "`.git` 文件内容 = {bad:?} 不该报出任何分支");
        }
    }

    #[test]
    fn gitdir_指过去的那一头没有_head_也是_none() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join(".git"), format!("gitdir: {}\n", dir.path().join("empty").display())).unwrap();
        assert_eq!(read_head(&work), None);
    }

    // ── 线上契约 ─────────────────────────────────────────────────────────────

    /// 形状钉死在 `crates/vela-core/tests/wire_contract.rs`；这一条只钉字段名的口径
    /// （`detached` 而不是 `is_detached`——前端读成 `undefined` 是不报错的）
    #[test]
    fn 序列化出来是_camel_case_的扁平结构() {
        let json = serde_json::to_string(&GitHead { name: "main".to_owned(), detached: false }).unwrap();
        assert_eq!(json, r#"{"name":"main","detached":false}"#);
    }
}
