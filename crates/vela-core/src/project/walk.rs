//! 「哪些文件算这个项目的一部分」——遍历器、rel 换算、逐文件的循环，全 crate 只此一份。
//!
//! ## 为什么从 `search/run.rs` 挪出来
//!
//! M2-C 写下这个函数时的说法是「**搜索与替换必须共用这一个函数**」，那是「所见即所做」
//! 在文件集合那一半的依据。M2-E 的 `Cmd+P` 成了**第三个**消费者，而它要的东西与前两个
//! 又不完全一样：它不读正文，所以不需要 `Filters`、不需要 `MAX_FILE_BYTES`、不需要
//! 取消标志——它只要那份**文件清单**。
//!
//! 于是共用点从 `walk_files`（带搜索专属规则的那一圈循环）下沉到 [`each_file`]：
//! 只留下三个功能都要的那部分，把各自专属的规则（过滤器、大小上限、取消、条数上限）
//! 留给调用方的闭包。留在 `search/run.rs` 里意味着 `project::index` 要么够不着它
//! （`mod run` 是私有的），要么把那几条规则**抄一份**——而抄的那一份会漂，
//! 漂的方向是「`Cmd+P` 里跳得到的文件与搜索搜得到的文件不是同一批」，
//! 一个用户没法自己发现、也没法自己绕过的分岔。
//!
//! ## ⚠️ 因此这条不变量是买来的，不是碰巧的
//!
//! **`Cmd+P` 列出的文件集合 === 搜索能搜到的文件集合**（差别只在搜索还会按大小与
//! include/exclude 再筛一遍）。两侧共用 [`each_file`]，所以 gitignore、`.git`、
//! 符号链接、隐藏文件这四件事在两个功能上的答案永远一致。要改其中任何一条，改这一个文件。
//!
//! ⚠️ 但这句话成立的前提是**共用点必须包含那一圈循环**，不能只共用 `WalkBuilder`。
//! 第一版就是这么写的：`walker()` 只有一份，而「`depth() == 0` 要跳过」「`file_type`
//! 必须是普通文件」「读不动的目录记一笔继续」这三条在两侧各写了一遍。三份规则抄成六份，
//! 而它们全都不会被任何一条测试发现漂了——两侧的测试各自都还是绿的。

use std::ops::ControlFlow;
use std::path::Path;

use ignore::{DirEntry, WalkBuilder};

/// 一趟遍历的账。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct FileWalk {
    /// 读不动的目录数（权限不够、遍历途中被删）。
    ///
    /// ⚠️ 这个数非零意味着「没找到」可能是假的，所以两侧都得把它一路报给 UI
    pub(crate) unreadable: u32,
    /// `visit` 返回过 `Break`，也就是这一趟**没有走完**。
    /// 索引用它填 `IndexStats::truncated`；搜索不看它（它自己知道是被取消还是撞了上限）
    pub(crate) stopped: bool,
}

/// 走一遍 `root` 下所有**该看的**文件，对每一个调 `visit(entry, rel)`。
///
/// 「该看」= 不是 root 自己、是普通文件（目录与符号链接都不算）、算得出 rel。
/// 这三条规则只在这里写一次。
///
/// `rel` 的规矩与 `DirEntry.rel`（树那边）完全一致，见 [`rel_of`]。
/// `visit` 返回 `Break` 就当场收手——「走到哪儿停到哪儿」，
/// 十万个文件的仓库上取消与截断都必须在一帧内生效。
pub(crate) fn each_file<V>(root: &Path, mut visit: V) -> FileWalk
where
    V: FnMut(&DirEntry, &str) -> ControlFlow<()>,
{
    let mut tally = FileWalk::default();
    for item in walker(root).build() {
        let entry = match item {
            Ok(entry) => entry,
            // 某个目录读不动：记一笔继续。整趟作废比少一个目录糟得多，
            // 但**必须记下来**——不记的话「没找到」就成了一个看起来很确定的错答案
            Err(_) => {
                tally.unreadable += 1;
                continue;
            }
        };
        // depth 0 是 root 自己。链接的 `file_type` 既不是 file 也不是 dir
        //（`follow_links(false)`），所以这一条把「目录」与「链接」一起挡掉了
        if entry.depth() == 0 || !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        // `rel_of` 返回 None 只可能是路径没长在 root 下面，而 `walker` 从 root 出发，
        // 正常走不到这一支。真走到了就跳过：一个算不出 rel 的文件在 UI 上无处可挂
        let Some(rel) = rel_of(root, entry.path()) else { continue };
        if visit(&entry, &rel).is_break() {
            tally.stopped = true;
            break;
        }
    }
    tally
}

/// 配好五个设置的遍历器。
///
/// 这五条设置各自的理由都记在对应那行上，它们不是可以「顺手统一一下」的东西
fn walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        // 点开头的目录要搜：`.github/workflows/ci.yml`、`.vscode/settings.json`
        // 都是用户真会去搜的东西。代价是 `.git` 不再被「隐藏文件」那条规则顺带挡掉，
        // 所以下面显式挡一次
        .hidden(false)
        // 一个光秃秃的 `.gitignore`（没有 `.git` 目录）也算数。默认值是 true，
        // 那意味着「不在 git 仓库里就完全不过滤」——而用户打开的文件夹是不是一个
        // 仓库，与他要不要跳过 `build/` 里的产物没有任何关系
        .require_git(false)
        // ⚠️ 与文件树相反：**不跟随符号链接**。树放行链接是因为「展开一层」的成本有限，
        // 而搜索要读正文——跟着 pnpm 的符号链接农场走会把同一个包读几十遍，
        // 还可能成环。`follow_links(false)` 之下链接自己的 `file_type` 既不是 file
        // 也不是 dir，于是 `each_file` 那条 `is_file()` 把「目录」与「链接」一起挡掉了
        .follow_links(false)
        // `.git` 里面是几万条对象文件与 reflog，搜它们从来不是用户的意思
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git")
        // 顺序确定，同一棵树搜两次长得一样。并行遍历做不到这一点，
        // 而测试与 UI 都依赖顺序稳定（见 `search/mod.rs`「为什么是单线程遍历」）。
        // 参数类型必须写出来：这里传的是 `impl Fn`，编译器没有位置可以反推
        .sort_by_file_name(|a: &std::ffi::OsStr, b: &std::ffi::OsStr| a.cmp(b));
    builder
}

/// `path` 相对 `root` 的那条 rel，规矩与 `DirEntry.rel` 完全一致。
pub(crate) fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    // 逐组件用 `/` 拼，而不是 `replace('\\', "/")`：后者是「假设分隔符是反斜杠」，
    // 前者是「不假设任何平台的分隔符」
    Some(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
}
