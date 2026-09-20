//! `Cmd+P` 的文件索引与模糊匹配（PLAN.md §3.4 M2-E）。
//!
//! ## 形状：一次遍历，多次查询
//!
//! [`FileIndex::build`] 走一遍 root 把相对路径收进一个 `Vec`，[`FileIndex::query`] 在这份
//! 清单上做子序列匹配 + 打分，只回**前 N 条**。这是用户在「Rust 建索引并缓存 /
//! 全量路径清单拉到前端 / 每个按键问一次 Rust」三选一里选的第一项，理由三条都实：
//!
//! 十万条路径拉到前端会撞 §2.6 那条「单次 payload ≤ 4MB」，而且常驻内存与
//! 「占用内存低」那条要求直接对着干；每个按键重新遍历一遍更不行——M2-C 实测
//! 走完一棵合成的十万文件树要 6.7 秒，那不是按键级的速度。
//!
//! 缓存本身（`Mutex<Vec<Arc<FileIndex>>>`，M2-F 起**每个根一份**）住在
//! `src-tauri` 的 managed state 里，不住在本 crate：vela-core 不认识 Tauri，而
//! 「什么时候该重建」是一个应用级的决定。本模块只保证**建一次与查一次都是纯的**，
//! 于是两边都能用 `tempfile` 在当前线程上测完。
//!
//! ## ⚠️ 多根：一份索引一个根，合并只发生在结果那一层
//!
//! [`query_many`] 拿 N 份索引各查一遍，再把结果拼起来重排。为什么不是「合成一份大索引」，
//! 以及为什么同分时按根的顺序——理由都写在那个函数上。
//! 与它配套的 [`merge_stats`] 把 N 份账合成一份，`truncated` 取或：
//! 「有一个根没走完」就足以让「找不到的文件可能其实存在」这句话成立。
//!
//! ## ⚠️ 文件集合与搜索**完全相同**，这是买来的
//!
//! 遍历走的是 `super::walk::each_file`——与搜索、与替换同一个函数，而且共用的是
//! **那一圈循环**，不只是底下那个 `WalkBuilder`。于是
//! 「`Cmd+P` 跳得到的文件」与「搜索搜得到的文件」在结构上是同一批，gitignore、`.git`、
//! 符号链接、隐藏文件这四件事在两个功能上永远给出同一个答案。抄第二份的话它们会漂，
//! 而漂的失败方式是用户没法自己发现也没法自己绕过的那种。
//!
//! 代价要说清：被 gitignore 挡掉的东西（`dist/`、`node_modules/`）在 `Cmd+P` 里**搜不到**。
//! 这与侧边栏相反（树刻意不过滤，见 §3.4「M2-A 实施修正」1），而那个不一致是有意留的：
//! 树的第一职责是「把磁盘上的东西如实列出来」，`Cmd+P` 的第一职责是「在我自己的代码里
//! 找一个文件」。真要去 `node_modules` 里翻一个类型声明，树还在那儿。
//!
//! ## 打分：能自己控制才自己写
//!
//! ⛔ 没有引入任何模糊匹配库。不是嫌依赖重，是**这套权重是产品决定**：
//! 「连续命中比分散命中好」「basename 里的命中比路径中间的命中好」「短路径优先」
//! 「最近打开过的略微加分但压不过强命中」——这四条哪一条要调，都得改代码，
//! 而借来的库只会给一个不可解释的分数。零依赖也让「为什么这个文件排在第一个」
//! 这个问题在本文件里就有答案。

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use super::tree::TreeError;
// ⚠️ 遍历那一圈循环必须与搜索共用同一个函数，不能在这里抄第二份。
// 抄的那一份会漂，而漂的方向是「`Cmd+P` 跳得到的文件与搜索搜得到的文件不是同一批」
use super::walk::{each_file, rel_of};

/// 一份索引最多收多少个文件。撞到就**停下来**，`IndexStats::truncated` 为真。
///
/// 与搜索的 `MAX_HITS` 同一条理由的另一个方向：那边管的是「结果多到没有价值」，
/// 这边管的是**内存**——十万条相对路径按平均 40 字节算是 4MB，再加 `Vec` 的头部
/// 就是 8MB 常驻。二十万是「比验收判据（10 万+）高一倍」的地方划线，
/// 再往上就该换成按需分片，而不是把整棵树背在身上。
pub const MAX_INDEX_FILES: usize = 200_000;

/// `recent` 最多认多少条。前端那份 MRU 的上限是同一个数，两处要一起改。
///
/// ⚠️ 这是 IPC 边界上的一个上限，不是内部约定：`recent` 由前端递进来，
/// 不设上限的话一次调用就能让本模块建一张任意大的哈希表
pub const MAX_RECENT: usize = 50;

/// 一个字符命中给这么多分。
const HIT: i64 = 1;

/// 命中紧挨着上一个命中时，每一个额外给这么多。
///
/// 四条权重里这一条最重，因为「连续」最接近用户脑子里那个词的样子：
/// 打 `store` 想找的是 `store.ts`，不是 `s…t…o…r…e` 散布在一条长路径上的那种巧合
const RUN: i64 = 4;

/// 命中落在一个路径段的开头（`/` 之后，或者整个 rel 的第 0 个字符）。
const SEGMENT_START: i64 = 6;

/// 命中落在一个「词」的开头：前一个字符是 `.` `_` `-` 或空格，或者是驼峰的凸起处。
const WORD_START: i64 = 3;

/// **第一个**命中就落在 basename 里。
///
/// 只给第一个命中：`src/search/store.ts` 与 `src/search/store.test.ts` 打 `store` 时
/// 都该排在前头，而 `docs/about/store-history.md` 该排在它们后面
const BASENAME: i64 = 8;

/// 两个命中之间每跳过一个字符扣这么多。
const GAP: i64 = 1;

/// 路径每这么多个字符扣一分。
///
/// 按**字符**数不是字节数：中文文件名一个字符三个字节，按字节算的话同样的路径深度
/// 会被扣三倍，而 Vela 的默认字体就是中文字体，中文文件名不是边缘情况
const LENGTH_DIVISOR: usize = 24;

/// MRU 里第 0 位给这么多分，往后每一位减一，减到 0 为止。
///
/// ⚠️ 这个数**刻意小**：一次像样的命中（五个字符连续 + 段首 + basename）能到 35 分左右，
/// 而 12 分只够让「最近开过的弱命中」压过「更早的同样弱的命中」。
/// MRU 是平局的裁判，不是否决权——把刚开过的文件顶到一个明显更匹配的候选前面，
/// 用户看到的是「我打对了词，它却给我另一个文件」
const RECENT_TOP: i64 = 12;

/// 一次索引的账。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    /// 收进索引的文件数（= `FileIndex::len`）
    pub files: u32,
    /// 遍历途中读不动的目录数（权限不够、途中被删）
    pub unreadable: u32,
    /// 撞到 `MAX_INDEX_FILES` 停下了。⚠️ 为真时这份索引**不是全的**，
    /// 而「找不到某个文件」这件事在 UI 上与「这个文件不存在」长得一模一样，
    /// 所以这个标志必须一路传到前端去说一句话
    pub truncated: bool,
    /// 建这一份索引花了多少毫秒。它不是给用户看的性能指标，是给「索引要不要重建」
    /// 这个决定看的：几十毫秒的重建可以每次展开浮层都做，几秒的就必须缓存
    pub elapsed_ms: u64,
}

/// 一条候选。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    /// 相对 root 的路径，`/` 分隔，规矩与 `DirEntry.rel` / `SearchFile.rel` 完全一致
    pub rel: String,
    /// 绝对路径，直接交给 `open_file`。与 `rel` 冗余是**刻意买的**，
    /// 与 M2-A 那条同一个理由：前端永远不需要做路径拼接，也就不会在分隔符、
    /// 大小写、末尾斜杠上犯错。只对回来的这 N 条冗余，不对索引里那二十万条冗余
    pub path: String,
    /// 模糊匹配分，降序排好了。⚠️ 它只在**同一次查询内部**有意义：
    /// 权重是相对值，换一个 needle 就没有可比性。前端拿它排序可以，
    /// 拿它做「够不够像」的阈值判断不行
    pub score: u32,
    /// 这一条来自 `roots` 里的第几个根（M2-F 多根工作区）。单根时恒为 0。
    ///
    /// 与 `SearchFile::root_index` 同一个理由：多根之下 `rel` 不再唯一，
    /// 而浮层要显示「哪个根下面的」，前端查一次 `roots[i]` 就拿到根名，
    /// 不必从 `path` 里剥——那是 M2-A 就禁掉的路径运算
    pub root_index: u16,
}

/// 一次查询的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuery {
    /// 排好序的前 N 条（N = 调用方给的 `limit`）
    pub matches: Vec<FileMatch>,
    /// 命中总数，**可以大于** `matches.len()`。差值的意思是「还有更多，把词写窄一点」。
    /// ⚠️ 多根时它是**各根之和**（[`query_many`]），于是「total=50 而 matches 也是 50」
    /// 在多根下不再意味着「全给你了」——两个根各命中 25 条与一个根命中 50 条长得一样，
    /// 而这句话本来也只是个提示，不是契约
    pub total: u32,
}

/// 一份建好的文件索引。
#[derive(Debug)]
pub struct FileIndex {
    root: PathBuf,
    /// 相对 root 的路径，顺序是遍历顺序（每层按文件名排）。
    ///
    /// ⚠️ 用 `Box<str>` 而不是 `String`：`String` 多带一个 capacity 字段，
    /// 二十万条就是 1.6MB 纯头部。这里从不原地改，也不需要那个容量
    rels: Vec<Box<str>>,
    stats: IndexStats,
}

impl FileIndex {
    /// 走一遍 root，把所有该看的文件的相对路径收进来。
    ///
    /// 三条起飞前检查见 [`check_root`]，报的是与文件树同一套 `TreeError`——
    /// 前端已经有一套把 `TreeError` 翻译成人话的实现（`src/ipc/project.ts`），
    /// 另开一个只有四个变体的错误枚举等于逼它抄第二份
    pub fn build(root: &Path) -> Result<Self, TreeError> {
        Self::build_with_limit(root, MAX_INDEX_FILES)
    }

    /// 上限可以调的那一半。`build` 用它，测试也用它——
    /// 二十万个真实文件测不动，而「撞到上限会停下来并如实报」这条规则值得一条测试
    fn build_with_limit(root: &Path, limit: usize) -> Result<Self, TreeError> {
        check_root(root)?;

        let started = Instant::now();
        let mut rels: Vec<Box<str>> = Vec::new();
        // 闭包里只有**索引专属**的那一条规则：撞到上限就收手。
        // 「什么算一个文件」与「读不动的目录记一笔」都在 `each_file` 里，与搜索共用
        let tally = each_file(root, |_entry, rel| {
            if rels.len() >= limit {
                return ControlFlow::Break(());
            }
            rels.push(rel.into());
            ControlFlow::Continue(())
        });

        let files = u32::try_from(rels.len()).unwrap_or(u32::MAX);
        Ok(Self {
            root: root.to_path_buf(),
            rels,
            stats: IndexStats {
                files,
                unreadable: tally.unreadable,
                // `stopped` 只可能是上面那个 `Break`：`each_file` 没有别的收手理由
                truncated: tally.stopped,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        })
    }

    /// 这份索引是哪个 root 的。缓存要靠它判断「root 换了没有」
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 收了多少个文件
    pub fn len(&self) -> usize {
        self.rels.len()
    }

    /// 空索引（root 下面一个文件都没有）。⚠️ 与 clippy 的 `len_without_is_empty` 配套
    pub fn is_empty(&self) -> bool {
        self.rels.is_empty()
    }

    pub fn stats(&self) -> IndexStats {
        self.stats
    }

    /// 在索引里模糊找 `needle`，回排好序的前 `limit` 条。
    ///
    /// `recent` 是**绝对路径**的 MRU 清单（最近的在前），用来加权；它可以是空的。
    /// ⚠️ 这里的 `recent` 只用于比路径，**一个字节都不会去读**——它的用途是排序，
    /// 不是授权（与 M2-D 的 `skip` 那条同一个形状，方向相反：`skip` 是「别碰这些」，
    /// `recent` 是「这些排前面」）
    ///
    /// ⚠️ 回来的每一条 `root_index` 都盖成 **0**：一份索引只认识自己的 root，
    /// 它不知道自己是工作区里的第几个。多根时由 [`query_many`] 重盖
    pub fn query(&self, needle: &str, recent: &[String], limit: usize) -> FileQuery {
        if limit == 0 || self.rels.is_empty() {
            return FileQuery { matches: Vec::new(), total: 0 };
        }
        let bonus = self.recent_bonus(recent);
        // 命中数在最坏情况下等于索引大小（needle 是一个字母），所以先按
        // `(分数, 下标)` 收起来，再做部分选择——两个 u32 一条，二十万条是 1.6MB，
        // 比「每条都拼出一个 FileMatch」省一个数量级
        let mut scored: Vec<(u32, u32)> = Vec::new();
        for (index, rel) in self.rels.iter().enumerate() {
            let Some(base) = score_of(needle, rel) else { continue };
            let weight = bonus.get(rel.as_ref()).copied().unwrap_or(0);
            scored.push((base.saturating_add(weight), u32::try_from(index).unwrap_or(u32::MAX)));
        }
        let total = u32::try_from(scored.len()).unwrap_or(u32::MAX);

        // 降序按分、同分按下标升序（= 遍历顺序，稳定）。
        // `select_nth_unstable_by` 只把前 limit 条挑出来，不全排：二十万条全排是
        // O(n log n)，而用户只看前五十条
        let take = limit.min(scored.len());
        let by_rank = |a: &(u32, u32), b: &(u32, u32)| b.0.cmp(&a.0).then(a.1.cmp(&b.1));
        if take < scored.len() {
            scored.select_nth_unstable_by(take - 1, by_rank);
        }
        scored.truncate(take);
        scored.sort_unstable_by(by_rank);

        let matches = scored
            .into_iter()
            .map(|(score, index)| {
                let rel = &self.rels[index as usize];
                FileMatch {
                    // `root.join(rel)`：rel 是逐组件用 `/` 拼出来的，
                    // macOS 与 Windows 都把 `/` 当分隔符，所以这一趟能原样还原
                    path: self.root.join(rel.as_ref()).to_string_lossy().into_owned(),
                    rel: rel.to_string(),
                    score,
                    root_index: 0,
                }
            })
            .collect();
        FileQuery { matches, total }
    }

    /// 把 `recent`（绝对路径）翻成 `rel → 加分`。
    ///
    /// ⚠️ 只有**词法上**长在 root 下面的那些能翻出来（`rel_of` 用的是 `strip_prefix`）。
    /// macOS 上 `/tmp` 与 `/private/tmp` 这类差别会让同一个文件比不出来，
    /// 那种情况下它就是拿不到加分——与 M2-D 的 `skip` 相反，这里比不出来的后果是
    /// 「排序差一点」，不是「用户的稿子被盖掉」，所以不 normalize 是可以接受的
    fn recent_bonus(&self, recent: &[String]) -> HashMap<Box<str>, u32> {
        let mut bonus: HashMap<Box<str>, u32> = HashMap::new();
        for (rank, path) in recent.iter().take(MAX_RECENT).enumerate() {
            // `take(MAX_RECENT)` 管的是「前端递进来多长都不许全走一遍」，
            // 下面这个 break 管的是「加分归零之后再比也没意义」。
            // 两个界限不是一回事，虽然在本例里 break 先到（12 < 50）
            let weight = RECENT_TOP - rank as i64;
            if weight <= 0 {
                break;
            }
            let Some(rel) = rel_of(&self.root, Path::new(path)) else { continue };
            // `weight` 在 1..=RECENT_TOP 之间，`try_from` 一定成功；
            // 写成 `unwrap_or(0)` 是为了不把一个不可能的分支变成 panic——
            // release 配置里 `panic = "abort"`，而这条路径根本不该能被触发
            let weight = u32::try_from(weight).unwrap_or(0);
            bonus.insert(rel.into_boxed_str(), weight);
        }
        bonus
    }
}

/// root 的三条起飞前检查：是绝对路径、存在、是个目录。
///
/// 与搜索侧 `search::run::check_root` 逐条相同，只是报的错误枚举不同
/// （那边是 `SearchError`，这边是 `TreeError`）——刻意不合成一个：前端两套面板
/// 各有一套把错误翻成人话的实现，共用一个枚举等于逼它们对齐一张谁也不需要的分支表。
///
/// ## ⚠️ 为什么单独拿出来：多根之下要**先把所有根都查一遍**
///
/// [`FileIndex::build`] 自己就会调它，所以单根时代它压根不需要是公开的。
/// M2-F 之后 `index_project` / `query_project` 收的是一组根，而取舍与搜索、替换一致：
/// **有一个根不合法就整次 reject**，前一个根一份索引都不建。不先把 N 个根查一遍的话，
/// 「第二个根是拔掉的移动硬盘」这个场景会先在第一个根上白走两百毫秒，
/// 然后把一份没人要的索引留在缓存里。
pub fn check_root(root: &Path) -> Result<(), TreeError> {
    if !root.is_absolute() {
        return Err(TreeError::BadRoot { path: root.display().to_string() });
    }
    // 用 `metadata` 而不是 `exists` + `is_dir` 两次 stat，与搜索侧同一条理由：
    // `metadata` 跟着符号链接走，指向目录的链接是一个合法的 root
    match std::fs::metadata(root) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(TreeError::NotADirectory { path: root.display().to_string() }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Err(TreeError::NotFound { path: root.display().to_string() })
        }
        Err(err) => Err(TreeError::Io { reason: format!("{err:?}"), message: err.to_string() }),
    }
}

/// 多根工作区下把 N 份索引的查询结果合成一份（M2-F）。
///
/// `indexes` 的每一项是「这是工作区里的第几个根」＋那份索引，**顺序就是根的排序**，
/// 而同分时的先后完全由这个顺序决定（见下面那条 `sort_by_key`）。
///
/// ## 为什么是「各查一遍再合」而不是「合成一份大索引再查」
///
/// 后者听起来更对——一份索引、一次遍历、一套排序。但它要求**每加一个根就把
/// 全部根重走一遍**：`FileIndex` 是一整个 `Vec<Box<str>>`，两个 `Vec` 拼起来是
/// 一次全量复制，而缓存的意义正是「只在 root 换了才重建」。分开建、分开查、
/// 只在结果那一层合并，于是「添加第二个根」的成本只是走第二个根。
///
/// 代价是每次按键多做 N-1 次部分选择。实测口径（M2-E 那张表）：两万条一次查询
/// 0.9ms、十万条 12.7ms，而**每个根都只挑自己的前 `limit` 条**，所以合并那一步
/// 处理的是 N×50 条，与索引大小无关。
///
/// ## ⚠️ 同分时按根的顺序，不是按路径
///
/// `sort_by_key` 是**稳定**排序，而每一份内部已经按 `(分数降序, 遍历序升序)` 排好了。
/// 于是同分时的次序是「先根的顺序，再根内的遍历序」——与单根时的
/// `(分数降序, 遍历序升序)` 在 N=1 时逐条相同。刻意不用 `sort_unstable_by_key`：
/// 不稳定排序会让同一个 needle 在两次按键之间给出不同的顺序，
/// 而浮层里「上一条候选变了」是用户看得见的抖动
pub fn query_many(indexes: &[(u16, &FileIndex)], needle: &str, recent: &[String], limit: usize) -> FileQuery {
    if limit == 0 {
        return FileQuery { matches: Vec::new(), total: 0 };
    }
    let mut matches: Vec<FileMatch> = Vec::new();
    let mut total: u32 = 0;
    for (root_index, index) in indexes {
        let mut part = index.query(needle, recent, limit);
        total = total.saturating_add(part.total);
        for m in &mut part.matches {
            m.root_index = *root_index;
        }
        matches.append(&mut part.matches);
    }
    // 上面各查各的时候每份都只留了 `limit` 条，合起来最多 N×limit 条；
    // 排完再截一次，于是「前 limit 条」这个语义在多根下与单根一致
    matches.sort_by_key(|hit| std::cmp::Reverse(hit.score));
    matches.truncate(limit);
    FileQuery { matches, total }
}

/// 多根之下把 N 份 `IndexStats` 合成一份。
///
/// 三个数相加、`truncated` 取或。⚠️ `truncated` **必须**取或而不是取最后一个：
/// 它的用途是让 UI 说一句「索引不全，找不到的文件可能其实存在」，
/// 而「有一个根没走完」就足以让这句话成立
pub fn merge_stats(stats: &[IndexStats]) -> IndexStats {
    let mut merged = IndexStats { files: 0, unreadable: 0, truncated: false, elapsed_ms: 0 };
    for s in stats {
        merged.files = merged.files.saturating_add(s.files);
        merged.unreadable = merged.unreadable.saturating_add(s.unreadable);
        merged.truncated |= s.truncated;
        merged.elapsed_ms = merged.elapsed_ms.saturating_add(s.elapsed_ms);
    }
    merged
}

/// 空 needle 的语义是「每个文件都算命中，分数只有 MRU 那一份」。
///
/// 于是同一个排序函数天然给出「最近开过的在前、其余按遍历顺序」——不需要为
/// 「浮层刚展开、一个字还没打」这个最常见的情况单开一条代码路径
fn score_of(needle: &str, rel: &str) -> Option<u32> {
    if needle.is_empty() {
        return Some(0);
    }
    fuzzy_score(needle, rel)
}

/// 子序列匹配 + 打分。`None` = `needle` 不是 `rel` 的子序列（大小写不敏感）。
///
/// ⚠️ `needle` 必须非空（空的由 `score_of` 拦掉）：`want.next()?` 在空 needle 上
/// 会返回 `None`，那会被读成「一个都不匹配」，而正确语义是「全都匹配」
fn fuzzy_score(needle: &str, rel: &str) -> Option<u32> {
    // basename 的起点。没有 `/` 时整个 rel 就是 basename
    let base_at = rel.rfind('/').map_or(0, |cut| cut + 1);

    // `flat_map(to_lowercase)` 而不是先整体小写化：整体那一下要为每个文件分配一个
    // String，二十万个文件就是二十万次分配。逐字符比较一个都不分配
    let mut want = needle.chars().flat_map(|c| c.to_lowercase());
    let mut next = want.next()?;

    let mut score: i64 = 0;
    // 上一个命中字符**结束**的字节下标。用它而不是「上一个命中的下标 + 1」，
    // 是因为多字节字符的宽度不是 1
    let mut prev_end: Option<usize> = None;
    let mut first_in_basename = false;
    let mut consumed_all = false;

    for (index, c) in rel.char_indices() {
        // ⚠️ 一对多的小写映射（`'İ'` → `'i'` + 组合点）只取第一个字符。
        // 文件名里出现这种字符的概率极低，而为它把整条比较改成迭代器对迭代器，
        // 代价是每一个字符都要多一层状态机——不值得，写在这里当已知的近似
        let lowered = c.to_lowercase().next().unwrap_or(c);
        if lowered != next {
            continue;
        }

        score += HIT;
        let contiguous = prev_end == Some(index);
        if contiguous {
            score += RUN;
        }
        match prev_char_before(rel, index) {
            None => score += SEGMENT_START,
            Some('/') => score += SEGMENT_START,
            Some('.') | Some('_') | Some('-') | Some(' ') => score += WORD_START,
            Some(p) if p.is_lowercase() && c.is_uppercase() => score += WORD_START,
            _ => {}
        }
        match prev_end {
            // 第一个命中之前跳过的那些字符也算间隔：`a/b/c/needle` 与 `needle`
            // 打同一个词时，后者该排在前面。
            // ⚠️ 数的是**字符**不是字节，与 `LENGTH_DIVISOR` 同一个理由：
            // 按字节算的话中文路径的间隔惩罚是三倍，而间隔想表达的是「看起来隔了多远」。
            // 两个切片都落在字符边界上（`index` 来自 `char_indices`，`end` 是 `index + len_utf8`）
            None => score -= rel[..index].chars().count() as i64 * GAP,
            Some(end) => score -= rel[end..index].chars().count() as i64 * GAP,
        }
        if prev_end.is_none() {
            first_in_basename = index >= base_at;
        }
        prev_end = Some(index + c.len_utf8());

        match want.next() {
            Some(n) => next = n,
            None => {
                consumed_all = true;
                break;
            }
        }
    }

    if !consumed_all {
        return None;
    }
    if first_in_basename {
        score += BASENAME;
    }
    score -= (rel.chars().count() / LENGTH_DIVISOR) as i64;
    // 命中了就不给负分：分数只在一次查询内部可比，而负分与 0 分在 UI 上没有区别，
    // 留着负数只会让「为什么这条排在前面」这个问题多一个答案
    Some(u32::try_from(score.max(0)).unwrap_or(u32::MAX))
}

/// `rel` 里字节下标 `index` 那个字符的**前一个字符**。`index == 0` 时返回 `None`。
///
/// ⚠️ 用 `get(..index)` 拿字节切片再取最后一个字符，而不是在循环里维护一个变量：
/// 维护变量的写法要在 `continue` 之前赋值，而 `continue` 有两条（命中与不命中），
/// 漏掉任何一条的后果是「驼峰加分加到了错误的字符上」——一个只会让排序差一点、
/// 测不出来的错。切片那一支只在命中时走，成本可以忽略
fn prev_char_before(rel: &str, index: usize) -> Option<char> {
    if index == 0 {
        return None;
    }
    rel.get(..index)?.chars().next_back()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::TreeError;
    use std::fs;
    use std::path::Path;

    /// 一棵固定的树，遍历那一半的测试共用它。
    ///
    /// ```text
    /// root/
    /// ├── .git/config                     ← 显式挡掉
    /// ├── .github/workflows/ci.yml        ← 点开头的目录要收
    /// ├── .gitignore                      build/ 与 *.log
    /// ├── README.md
    /// ├── build/out.js                    ← gitignore 挡掉
    /// ├── notes.log                       ← gitignore 挡掉
    /// └── src/{main.rs, util.rs}
    /// ```
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n").unwrap();
        fs::create_dir_all(root.join(".github/workflows")).unwrap();
        fs::write(root.join(".github/workflows/ci.yml"), "name: ci\n").unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join("build/out.js"), "产物\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("src/util.rs"), "pub fn util() {}\n").unwrap();
        fs::write(root.join("notes.log"), "日志\n").unwrap();
        fs::write(root.join("README.md"), "# Vela\n").unwrap();
        dir
    }

    /// 索引里收进来的东西，按遍历顺序。
    fn rels(index: &FileIndex) -> Vec<String> {
        index.rels.iter().map(|r| r.to_string()).collect()
    }

    /// 一次查询回来的 rel，按名次。
    fn hits(result: &FileQuery) -> Vec<&str> {
        result.matches.iter().map(|m| m.rel.as_str()).collect()
    }

    /// 一个 rel 的绝对路径，喂给 `recent` 用。
    fn abs(root: &Path, rel: &str) -> String {
        root.join(rel).to_string_lossy().into_owned()
    }

    // ── 建索引：收什么 ──────────────────────────────────────────────────────

    /// 顺序也一起钉住：`walk.rs` 那个遍历器配了 `sort_by_file_name`，为的就是
    /// 「同一棵树索引两次长得一样」，而顺序漂了会让同分时的名次跟着漂
    #[test]
    fn 索引收普通文件_顺序确定() {
        let dir = fixture();
        let index = FileIndex::build(dir.path()).unwrap();
        assert_eq!(
            rels(&index),
            vec![".github/workflows/ci.yml", ".gitignore", "README.md", "src/main.rs", "src/util.rs"]
        );
        assert_eq!(index.len(), 5);
        assert!(!index.is_empty());
        assert_eq!(index.root(), dir.path());
    }

    #[test]
    fn 空目录建出来是一份空索引而不是一个错() {
        let dir = tempfile::tempdir().unwrap();
        let index = FileIndex::build(dir.path()).unwrap();
        assert!(index.is_empty());
        assert_eq!(index.len(), 0);
        assert_eq!(index.stats().files, 0);
        assert!(!index.stats().truncated);
        // 空索引上查询不 panic，回一个空结果——浮层刚展开时这就是真实情况
        assert!(index.query("", &[], 50).matches.is_empty());
    }

    /// ⚠️ **这一条与 `project::tree` 的 `gitignore_命中的条目照常列出` 方向相反，
    /// 不是写错了。** 树不过滤是因为「如实列出磁盘上的东西」；索引与搜索共用
    /// `each_file`，所以「`Cmd+P` 跳得到的」与「搜索搜得到的」永远是同一批。
    /// 两条测试方向相反正是两处权衡不同的证据
    #[test]
    fn gitignore_命中的文件不进索引() {
        let dir = fixture();
        let got = rels(&FileIndex::build(dir.path()).unwrap());
        assert!(!got.iter().any(|r| r.starts_with("build/")), "build/ 在 .gitignore 里：{got:?}");
        assert!(!got.contains(&"notes.log".to_owned()), "*.log 在 .gitignore 里：{got:?}");
        // 而点开头的目录照收：`.github/workflows/ci.yml` 是真会去开的东西
        assert!(got.contains(&".github/workflows/ci.yml".to_owned()), "{got:?}");
    }

    #[test]
    fn 点git_里的文件不进索引() {
        let dir = fixture();
        let got = rels(&FileIndex::build(dir.path()).unwrap());
        assert!(!got.iter().any(|r| r.starts_with(".git/")), "{got:?}");
    }

    #[test]
    fn rel_的规矩与树的_rel_一致() {
        let dir = fixture();
        let got = rels(&FileIndex::build(dir.path()).unwrap());
        // 逐组件用 `/` 拼，深层文件不带前导斜杠也不带盘符
        assert!(got.contains(&".github/workflows/ci.yml".to_owned()));
        assert!(got.contains(&"src/main.rs".to_owned()));
        assert!(got.iter().all(|r| !r.starts_with('/') && !r.contains('\\')));
    }

    /// 链接既不进索引也不被跟进去。与树相反（树放行链接），理由写在 `walk.rs`：
    /// 索引与搜索同源，而搜索跟着 pnpm 的链接农场走会把同一个包收几十遍
    #[cfg(unix)]
    #[test]
    fn 符号链接不进索引_也不被跟进去() {
        let dir = fixture();
        let root = dir.path();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "外面的").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("link-file.txt")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("link-dir")).unwrap();

        let got = rels(&FileIndex::build(root).unwrap());
        assert!(!got.contains(&"link-file.txt".to_owned()), "{got:?}");
        assert!(!got.iter().any(|r| r.starts_with("link-dir")), "{got:?}");
        assert!(!got.iter().any(|r| r.contains("secret.txt")), "跟着链接走出去了：{got:?}");
    }

    /// 指向目录的符号链接可以当 root：`metadata` 跟着链接走，与搜索侧同一条规则
    #[cfg(unix)]
    #[test]
    fn 指向目录的符号链接可以当_root() {
        let dir = fixture();
        let holder = tempfile::tempdir().unwrap();
        let link = holder.path().join("to-repo");
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        assert_eq!(FileIndex::build(&link).unwrap().len(), 5);
    }

    /// 前提断言（`read_dir` 确实失败）是这条测试的一半价值：以 root 身份跑的话
    /// `chmod 000` 挡不住任何人，少了这句它会**静默地什么也没测**
    #[cfg(unix)]
    #[test]
    fn 读不动的目录计入_unreadable_而索引继续() {
        use std::os::unix::fs::PermissionsExt;

        let dir = fixture();
        let root = dir.path();
        fs::create_dir_all(root.join("locked")).unwrap();
        fs::write(root.join("locked/inside.txt"), "里面的").unwrap();
        let locked = root.join("locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        assert!(fs::read_dir(&locked).is_err(), "本测试的前提：这个目录当前用户列不动");

        let index = FileIndex::build(root).unwrap();
        assert_eq!(index.stats().unreadable, 1);
        let got = rels(&index);
        assert!(!got.iter().any(|r| r.starts_with("locked/")), "{got:?}");
        // 关键的一半：**别的文件照常收进来了**。整份索引作废比少一个目录糟得多
        assert!(got.contains(&"README.md".to_owned()), "{got:?}");

        // 收尾：把权限还回去，否则 TempDir 删不掉自己
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    }

    // ── 建索引：上限与账 ────────────────────────────────────────────────────

    /// 二十万个真实文件测不动，所以这一条走 `build_with_limit` 那个可调的上限。
    /// `truncated` 必须为真：「找不到某个文件」在 UI 上与「这个文件不存在」
    /// 长得一模一样，不报出来就成了一个看起来很确定的错答案
    #[test]
    fn 撞到上限时停下来并如实报_truncated() {
        let dir = fixture();
        let small = FileIndex::build_with_limit(dir.path(), 2).unwrap();
        assert_eq!(small.len(), 2);
        assert!(small.stats().truncated);
        assert_eq!(small.stats().files, 2);

        let big = FileIndex::build_with_limit(dir.path(), MAX_INDEX_FILES).unwrap();
        assert_eq!(big.len(), 5);
        assert!(!big.stats().truncated);
        assert_eq!(big.stats().files, 5);
    }

    #[test]
    fn 上限为零时一条都不收() {
        let dir = fixture();
        let index = FileIndex::build_with_limit(dir.path(), 0).unwrap();
        assert!(index.is_empty());
        assert!(index.stats().truncated);
    }

    // ── 建索引：root 检查 ───────────────────────────────────────────────────

    /// 三条与搜索侧 `check_root` 一模一样，报的也是同一套 `TreeError`——
    /// 前端已经有一套把它翻成人话的实现，另开一个错误枚举等于逼它抄第二份
    #[test]
    fn root_不是绝对路径被拒() {
        // 防的是**静默的错答案**：相对路径按进程的 cwd 解析，
        // 而 `.app` 双击启动时 cwd 是 `/`，于是索引的是整个磁盘
        assert_eq!(FileIndex::build(Path::new("repo")).unwrap_err(), TreeError::BadRoot { path: "repo".to_owned() });
    }

    #[test]
    fn root_不存在或者不是目录都被拒() {
        let dir = fixture();
        let missing = dir.path().join("nope");
        assert_eq!(
            FileIndex::build(&missing).unwrap_err(),
            TreeError::NotFound { path: missing.display().to_string() }
        );
        let file = dir.path().join("README.md");
        assert_eq!(FileIndex::build(&file).unwrap_err(), TreeError::NotADirectory { path: file.display().to_string() });
    }

    // ── 查询：形状 ──────────────────────────────────────────────────────────

    /// `path` 与 `rel` 冗余是刻意买的（前端永不做路径拼接），
    /// 于是「两边对不上」这种失败必须被钉住——那正是前端把 `path` 交给
    /// `open_file` 时会炸的形状
    #[test]
    fn 回来的_path_就是_root_拼上_rel() {
        let dir = fixture();
        let index = FileIndex::build(dir.path()).unwrap();
        let result = index.query("", &[], 50);
        assert!(!result.matches.is_empty());
        for m in &result.matches {
            assert_eq!(m.path, abs(dir.path(), &m.rel), "rel {:?} 与 path 对不上", m.rel);
            assert!(Path::new(&m.path).is_file(), "{} 不是一个真实存在的文件", m.path);
        }
    }

    /// ⚠️ 这条是 `query` 里那个「分数跟着下标一起走完选择与排序」的钉子。
    /// 曾经有一版把分数在 `map` 里丢掉、事后另起一趟重算再 zip 回去，
    /// 而重算那趟为了省内存提前收手——名次是对的，分数却配错了人。
    /// 断言「每条的分数就是它自己那条 rel 的分数」直接堵死这个形状
    #[test]
    fn 回来的分数就是那一条自己的分数() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // 二十条同分的弱命中 + 一条强命中，`limit` 只取三条：
        // 必须走 `select_nth_unstable_by` 那条分支才测得到
        for i in 0..20 {
            fs::write(root.join(format!("f{i:02}.ts")), "x").unwrap();
        }
        fs::write(root.join("store.ts"), "x").unwrap();

        let index = FileIndex::build(root).unwrap();
        let result = index.query("s", &[], 3);
        assert_eq!(result.total, 21, "命中总数不受 limit 影响");
        assert_eq!(result.matches.len(), 3);
        assert_eq!(result.matches[0].rel, "store.ts");
        for m in &result.matches {
            assert_eq!(m.score, fuzzy_score("s", &m.rel).unwrap(), "{:?} 的分数配错了", m.rel);
        }
    }

    #[test]
    fn limit_截断时_total_报的是命中总数() {
        let dir = fixture();
        let index = FileIndex::build(dir.path()).unwrap();
        let result = index.query("", &[], 2);
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.total, 5, "差值的意思是「还有更多，把词写窄一点」");
    }

    #[test]
    fn limit_比命中数大时全给() {
        let dir = fixture();
        let index = FileIndex::build(dir.path()).unwrap();
        let result = index.query("", &[], 500);
        assert_eq!(result.matches.len(), 5);
        assert_eq!(result.total, 5);
    }

    /// 浮层不会这么调，但 `limit == 0` 会让下面那句 `take - 1` 下溢。
    /// 与其靠调用方保证，不如在这里就回空
    #[test]
    fn limit_为零时什么都不回() {
        let dir = fixture();
        let index = FileIndex::build(dir.path()).unwrap();
        let result = index.query("", &[], 0);
        assert!(result.matches.is_empty());
        assert_eq!(result.total, 0);
    }

    #[test]
    fn 空_needle_命中全部_并按遍历顺序排() {
        let dir = fixture();
        let index = FileIndex::build(dir.path()).unwrap();
        // 浮层刚展开、一个字还没打就是这个情况：列出全部（截到 limit），
        // 同分于是回落到遍历顺序——不需要为它单开一条代码路径
        assert_eq!(hits(&index.query("", &[], 50)), rels(&index));
    }

    // ── 查询：四条权重 ──────────────────────────────────────────────────────

    /// 下面这些直接调 `fuzzy_score`，不建索引：权重是纯算术，
    /// 让文件系统待在链路里只会让失败信息变成「顺序不对」而看不出是哪一条权重
    #[test]
    fn 连续命中好过分散命中() {
        let tight = fuzzy_score("store", "store.ts").unwrap();
        let spread = fuzzy_score("store", "s-t-o-r-e.ts").unwrap();
        assert!(tight > spread, "连续 {tight} 应高于分散 {spread}");
    }

    #[test]
    fn 段首命中好过段中命中() {
        let at_start = fuzzy_score("main", "src/main.rs").unwrap();
        let mid = fuzzy_score("main", "src/xmain.rs").unwrap();
        assert!(at_start > mid, "段首 {at_start} 应高于段中 {mid}");
    }

    #[test]
    fn basename_里的命中好过路径中间的命中() {
        let in_base = fuzzy_score("main", "main.rs").unwrap();
        let in_dir = fuzzy_score("main", "main-docs/other.rs").unwrap();
        assert!(in_base > in_dir, "basename {in_base} 应高于目录名 {in_dir}");
    }

    #[test]
    fn 短路径好过长路径() {
        let short = fuzzy_score("main", "main.rs").unwrap();
        let deep = fuzzy_score("main", "a/b/c/d/main.rs").unwrap();
        assert!(short > deep, "短 {short} 应高于深 {deep}");
    }

    /// 驼峰那一条能算出**确切的差**：两个 rel 除了那个大写字母以外逐字符对齐，
    /// 所以差值只可能是 `WORD_START`
    #[test]
    fn 驼峰的凸起处算词首() {
        let camel = fuzzy_score("fif", "src/findInFiles.ts").unwrap();
        let flat = fuzzy_score("fif", "src/findxnfiles.ts").unwrap();
        assert_eq!(camel - flat, WORD_START as u32);
    }

    #[test]
    fn 分隔符处算词首() {
        let after_dot = fuzzy_score("ts", "ab.test.ts").unwrap();
        let after_letter = fuzzy_score("ts", "ab.xest.ts").unwrap();
        assert!(after_dot > after_letter, "{after_dot} 应高于 {after_letter}");
    }

    #[test]
    fn 匹配不区分大小写() {
        let lower = fuzzy_score("main", "src/main.rs").unwrap();
        assert_eq!(fuzzy_score("MAIN", "src/main.rs").unwrap(), lower);
        assert_eq!(fuzzy_score("main", "SRC/MAIN.RS").unwrap(), lower);
        assert_eq!(fuzzy_score("MaIn", "src/main.rs").unwrap(), lower);
    }

    #[test]
    fn 不是子序列的一个都不回() {
        // `stroe` 里 `o` 在 `r` 前面，`store` 不是它的子序列。
        // ⛔ 不做「编辑距离」：那会把用户打错的词悄悄换成一个不相干的文件，
        // 而浮层里没有任何地方能看出这个替换发生过
        assert_eq!(fuzzy_score("store", "stroe.ts"), None);
        assert_eq!(fuzzy_score("store", "sto.ts"), None);
    }

    /// 间隔按**字符**数算，与 `LENGTH_DIVISOR` 同一个理由。
    /// 按字节算的话中文路径的间隔惩罚是三倍，而 Vela 的默认字体就是中文字体，
    /// 中文文件名不是边缘情况
    #[test]
    fn 中文路径的间隔按字符算不按字节算() {
        let cn = fuzzy_score("t", "中文中文/t.rs").unwrap();
        let en = fuzzy_score("t", "abcd/t.rs").unwrap();
        assert_eq!(cn, en, "同样五个字符的前缀该扣同样的分（中文 {cn} / 英文 {en}）");
        // 搜索词换成一个只出现在斜杠后面的中文字也一样：两串逐字符对齐，
        // 于是唯一的差别只可能是「间隔按字节算还是按字符算」
        assert_eq!(fuzzy_score("文", "中目中目/文.ts").unwrap(), en);
    }

    #[test]
    fn 命中了就不给负分() {
        // 二十六个字符的间隔足以把分数打成负的，而负分与零分在 UI 上没有区别
        let far = "x".repeat(26) + "a";
        assert_eq!(fuzzy_score("a", &far), Some(0));
    }

    /// ⚠️ `fuzzy_score` 在空 needle 上会返回 `None`（`want.next()?`），
    /// 而正确语义是「全都命中」。空的那一支由 `score_of` 拦住，
    /// 这条测试钉的就是那个分工，别把两个函数当成一个用
    #[test]
    fn 空_needle_由_score_of_拦_而不是由模糊匹配拦() {
        assert_eq!(score_of("", "src/main.rs"), Some(0));
        assert_eq!(fuzzy_score("", "src/main.rs"), None);
    }

    // ── 查询：最近打开过的加权 ──────────────────────────────────────────────

    /// `recent` 是平局的裁判。两个 rel 原始分完全相同，
    /// 于是名次只可能由加权决定——这正是「刚开过的那个排前面」要的语义
    #[test]
    fn 同分时最近打开过的排在前面() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/store.ts"), "x").unwrap();
        fs::write(root.join("b/store.ts"), "x").unwrap();
        let index = FileIndex::build(root).unwrap();

        // 没有加权时按遍历顺序：a 在 b 前面
        assert_eq!(hits(&index.query("store", &[], 10)), vec!["a/store.ts", "b/store.ts"]);
        // 把 b 放进最近打开过的清单，名次就翻过来
        let recent = vec![abs(root, "b/store.ts")];
        assert_eq!(hits(&index.query("store", &recent, 10)), vec!["b/store.ts", "a/store.ts"]);
    }

    #[test]
    fn 最近打开过的越靠前加分越多() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for name in ["a", "b", "c"] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("store.ts"), "x").unwrap();
        }
        let index = FileIndex::build(root).unwrap();
        // 三条原始分一样，recent 的顺序就是名次的顺序（c 最近，b 其次，a 没开过）
        let recent = vec![abs(root, "c/store.ts"), abs(root, "b/store.ts")];
        assert_eq!(hits(&index.query("store", &recent, 10)), vec!["c/store.ts", "b/store.ts", "a/store.ts"]);
    }

    /// 加权**刻意小**（`RECENT_TOP` 那条常量的文档）：把刚开过的文件顶到一个
    /// 明显更匹配的候选前面，用户看到的是「我打对了词，它却给我另一个文件」
    #[test]
    fn 最近打开过的压不过明显更强的命中() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("store.ts"), "x").unwrap();
        fs::create_dir_all(root.join("deep/deeper/deepest")).unwrap();
        fs::write(root.join("deep/deeper/deepest/store.ts"), "x").unwrap();
        let index = FileIndex::build(root).unwrap();

        let strong = fuzzy_score("store", "store.ts").unwrap();
        let weak = fuzzy_score("store", "deep/deeper/deepest/store.ts").unwrap();
        // 前提断言：原始分差确实大于 `RECENT_TOP`，否则这条测试什么也没证
        assert!(strong - weak > RECENT_TOP as u32, "前提不成立：{strong} - {weak} ≤ {RECENT_TOP}");

        let recent = vec![abs(root, "deep/deeper/deepest/store.ts")];
        assert_eq!(hits(&index.query("store", &recent, 10))[0], "store.ts");
    }

    /// `recent` 是前端递进来的**绝对路径**，里面可以有任何东西。
    /// 长在 root 外面的那些比不出 rel，于是拿不到加分——而这是可接受的：
    /// 与 M2-D 的 `skip` 相反，这里比不出来的后果是「排序差一点」，不是「稿子被盖掉」
    #[test]
    fn 最近清单里长在_root_外面的路径被忽略() {
        let dir = fixture();
        let root = dir.path();
        let index = FileIndex::build(root).unwrap();
        let outside = vec!["/elsewhere/README.md".to_owned(), "README.md".to_owned(), "".to_owned()];
        // 相对路径与空串也一并忽略：`rel_of` 的 `strip_prefix` 对它们都返回 None
        assert_eq!(hits(&index.query("", &outside, 50)), rels(&index));
        // 而真的长在 root 下面的那条照常生效
        let inside = vec![abs(root, "README.md")];
        assert_eq!(hits(&index.query("", &inside, 50))[0], "README.md");
    }

    /// `MAX_RECENT` 与前端 `src/doc/workspace.ts` 的同名常量是**同一个决定**的两半：
    /// 前端按它裁清单，这里按它兜住「前端没裁」。两边各钉一次这个数字，改一边不改
    /// 另一边就会有一侧变红——比在一处写注释指着另一处可靠。
    ///
    /// ⚠️ 这个数字**没有行为可测**：`recent_bonus` 里 `RECENT_TOP - rank` 的加分在
    /// rank 12 就归零并 break，于是 `take(MAX_RECENT)` 那道界限永远轮不到。
    /// 它纯粹是一道兜底，兜的是「前端递进来一份几万条的手改清单」时的遍历成本。
    #[test]
    fn 最近清单的长度上限与前端同值() {
        assert_eq!(MAX_RECENT, 50);
    }

    /// ⚠️ 这条是「共用同一个遍历」这件事**唯一能被测出来**的地方。
    ///
    /// 上面那些 gitignore / `.git` / 符号链接的断言全都只看索引这一侧——哪天有人把
    /// 那圈循环重新抄回 `index.rs`（比如嫌跨模块调用绕），它们照样全绿，
    /// 而「`Cmd+P` 跳得到的」与「搜索搜得到的」就已经分岔了。
    /// 所以这里真的跑一次搜索，然后断言两侧的文件清单**逐条相同、连顺序都相同**。
    /// 与 `replace.rs` 的 `预览与落盘走过同一个文件集` 是同一个套路。
    #[test]
    fn 索引与搜索给出同一个文件清单() {
        use crate::search::{search, SearchQuery};
        use std::sync::atomic::AtomicBool;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // 每个**该被看到的**文件都写上搜索词，于是「搜索报出来的文件」就等于
        // 「搜索走过的文件」——否则没命中的文件不进批次，两侧根本没法比。
        // `.gitignore` 自己也要写上一个，它是这棵树里唯一容易被漏掉的普通文件
        fs::write(root.join(".gitignore"), "build/\n# needle\n").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "needle\n").unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join("build/out.js"), "needle\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "needle\n").unwrap();
        fs::write(root.join("src/b.ts"), "needle\n").unwrap();
        fs::write(root.join("README.md"), "needle\n").unwrap();

        let mut found: Vec<String> = Vec::new();
        let query = SearchQuery { pattern: "needle".to_owned(), ..SearchQuery::default() };
        let summary =
            search(root, &query, &AtomicBool::new(false), |batch| found.extend(batch.files.into_iter().map(|f| f.rel)))
                .unwrap();
        assert_eq!(summary.unreadable, 0);
        assert!(!found.is_empty(), "前提不成立：这次搜索一个文件都没报");

        let indexed = rels(&FileIndex::build(root).unwrap());
        assert_eq!(indexed, found, "索引与搜索走过的是两批文件");
        // 三条规则各留一个痕迹，否则「两侧相等」也可能只是因为两侧都空
        assert!(indexed.contains(&".gitignore".to_owned()), "{indexed:?}");
        assert!(!indexed.iter().any(|r| r.starts_with("build/") || r.starts_with(".git/")), "{indexed:?}");
    }

    /// 符号链接那一半单独测：链接指向的文件里也写着搜索词，
    /// 所以只要**任何一侧**跟着链接走了，两份清单就会各多出条目来
    #[cfg(unix)]
    #[test]
    fn 索引与搜索都不跟随符号链接() {
        use crate::search::{search, SearchQuery};
        use std::sync::atomic::AtomicBool;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "needle\n").unwrap();
        fs::write(root.join("real.txt"), "needle\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("link-file.txt")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("link-dir")).unwrap();

        let mut found: Vec<String> = Vec::new();
        let query = SearchQuery { pattern: "needle".to_owned(), ..SearchQuery::default() };
        search(root, &query, &AtomicBool::new(false), |batch| found.extend(batch.files.into_iter().map(|f| f.rel)))
            .unwrap();

        let indexed = rels(&FileIndex::build(root).unwrap());
        assert_eq!(indexed, vec!["real.txt".to_owned()]);
        assert_eq!(indexed, found, "索引与搜索走过的是两批文件");
    }
}
