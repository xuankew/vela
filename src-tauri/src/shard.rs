//! 大文件只读分片的命令层（M2-H-2，PLAN.md §2.4 / §3.4「大文件」）。
//!
//! 判断全在 `vela_core::fs::shard`：怎么数行、锚点隔多远、一页最多几行几字节、
//! UTF-16 为什么打不开。这一层只有三件下沉不下去的事：**句柄表**、
//! **哪一步该进 blocking 池**、以及 `Result` 到线上的形状。
//!
//! ## 为什么这一个模块不在 `commands.rs` 里
//!
//! 与 `src/watcher.rs` 同一条理由的变体。那儿的模块文档是一整篇「谁接受了路径、
//! 拿它能干什么」的账；这一层要记的是另一种东西——它是 Vela 到目前为止
//! **第一份必须有人来收尾的资源**。
//!
//! 另外三份 managed state 都不需要：`TaskRegistry` 的条目由后台线程自己摘掉，
//! `ProjectIndexCache` 由 `retain` 在每次命令开头顺手淘汰，`WatcherState` 的订阅
//! 跟着标签集合整张换掉。只有句柄表里的一个条目对应**一个操作系统的 fd**，
//! 而 fd 不会因为「没人再提它」就自己关掉。
//!
//! ## ⚠️ 句柄**刻意不需要**不可猜
//!
//! 单调递增的 `u64` 就够，不做随机化、不做签名。理由是「猜中别人的句柄」
//! 在 Vela 里压根不越权：[`open_large`] 收的是**任意绝对路径**（第十四条这样的命令，
//! 与 `open_file` 同一档），能调 `read_lines(3, …)` 的调用方本来就能直接
//! `open_large("/etc/passwd")`。给一个不越权的整数加密码学强度，只会让人
//! 误以为这里有一道本来不存在的边界。
//!
//! 🔴 M5 开放插件时这句话要重读一遍：那时 `open_large` 会改成只收 `rootId`，
//! 句柄也就跟着变成**唯一**的入口，届时它必须不可猜。
//!
//! ## ⚠️ 漏关的后果是 fd 泄漏，而它是安静的
//!
//! 没有上限、没有 LRU、没有超时回收——唯一会关掉一个分片的地方是 [`close_large`]，
//! 而前端在标签关闭时调它。刻意不加淘汰策略：悄悄关掉一个**还开着的**标签的分片，
//! 症状是用户滚到一半正文变成「读不到」，那比泄漏难查得多。
//! 真的漏到 fd 用尽时，失败方式是 `open_large` 回一条
//! `Io { reason: "TooManyOpenFiles" }`，前端会把它显示出来，不会崩。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{command, State};
use vela_core::fs::{open_shard, ReadError, Shard, ShardHeader, ShardPage};

/// 第四份 managed state（前三份是 `TaskRegistry`、`ProjectIndexCache`、`WatcherState`）。
///
/// ⚠️ **⛔ 它不是授权表**，与前三份一样：它不记「用户授权过哪些路径」，
/// 只记「现在开着哪几个分片」。`commands.rs` 结尾那段关于 M5 要换成 `rootId`
/// 的论证，这一份同样适用。
///
/// ## 为什么值是 `Arc<Mutex<Shard>>` 而不是 `Shard`
///
/// 两层锁各管一件事，缺一不可：
///
/// - **表锁**（外面那把 `Mutex<HashMap<…>>`）只保护「有哪些句柄」。
///   查一下就放掉，绝不拿着它去读正文——一页最坏 1 MiB，
///   占着表锁的话两个**不同**的大文件标签会互相等，而它们之间毫无关系；
/// - **分片锁**（里面那把）保护「这一个 fd 的读写位置」。
///   `Shard::read_page` 是 seek + read 两步，同一个分片上的两个并发请求
///   交错的话第二个会从第一个停下的地方接着读，出来的正文是两次读的拼接。
///   这一把必须持锁持到底，而它天然只影响同一个文件。
///
/// `Arc` 就是为了能在放掉表锁之后继续持有里层那一个。
#[derive(Default)]
pub struct ShardRegistry {
    next_handle: AtomicU64,
    open: Mutex<HashMap<u64, Arc<Mutex<Shard>>>>,
}

impl ShardRegistry {
    /// 登记一个分片，返回它的句柄。
    ///
    /// ⚠️ **从 1 开始，0 永远不是合法句柄**：`AtomicU64::default()` 是 0，
    /// 而前端一个没初始化好的 `number` 字段也是 0。让第一个真句柄是 1，
    /// 「0」就永远只可能是一个 bug，而不可能与一个真分片撞上。
    ///
    /// ⚠️ **句柄永不复用**，与 `TaskRegistry::register` 同一条理由：复用的话
    /// 一个迟到的 `read_lines(3, …)` 会读到**另一个**文件的正文。
    /// 那不是崩溃，是安静地把 A 文件的内容画在 B 文件的标签里。
    fn insert(&self, shard: Shard) -> u64 {
        let handle = self.next_handle.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock().insert(handle, Arc::new(Mutex::new(shard)));
        handle
    }

    /// 找到就把 `Arc` 克隆出来，**表锁立刻放掉**（理由见 [`ShardRegistry`] 的文档）。
    fn get(&self, handle: u64) -> Option<Arc<Mutex<Shard>>> {
        self.lock().get(&handle).cloned()
    }

    /// 摘掉一个句柄，fd 跟着 `Shard` 一起 drop。
    ///
    /// ⚠️ **不存在时什么都不做，不报错**：关掉同一个标签两次是正常时序
    /// （标签级关闭 + 窗口级关闭各来一次），报错的话前端就得先记住自己关过没有。
    fn remove(&self, handle: u64) {
        self.lock().remove(&handle);
    }

    /// ⚠️ `unwrap_or_else(into_inner)` 而不是 `expect`，理由与 `TaskRegistry::lock`
    /// 一字不差：release 是 `panic = "abort"`，而中毒只意味着「有人持锁的时候 panic 了」，
    /// 那张 `HashMap` 本身还是完好的
    fn lock(&self) -> MutexGuard<'_, HashMap<u64, Arc<Mutex<Shard>>>> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

/// `open_large` 的返回值：句柄 + 元信息。
///
/// ⚠️ 句柄与元信息**必须在同一条返回值里**。分成两条命令（先 open 再 stat）的话，
/// 前端就得在两步之间存一个没有总行数的状态，而总行数正是滚动条高度的依据——
/// 缺它的那一帧只能画一个错的滚动条，然后再跳一下。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardOpen {
    /// 之后 `read_lines` / `close_large` 都用它
    pub handle: u64,
    pub header: ShardHeader,
}

/// 打开一个大文件的只读分片（**第十四条**接受路径的命令，与 `open_file` 同一档）。
///
/// 前端只在 `open_file` 回了 `too_large` 之后才调过来，所以这里⛔不检查下限：
/// 一个 3 字节的文件也能开成分片，只是没人会那么做。
///
/// ⚠️ **走 `spawn_blocking`**：建索引是**整整一遍顺序读**，上限 256 MiB
/// （实测 release ≈ 0.06s、debug ≈ 1s，数字与那个上限的理由都在
/// `vela_core::fs::shard::MAX_SHARD_BYTES` 的文档里）。直接放在 async command 里
/// 就是占着 `open_file` / `save_file` / `list_dir` 的执行位——
/// 用户点开一个大日志的那一秒里，敲 ⌘S 会没反应。
///
/// ⚠️ 同一个路径**开两次就是两个句柄、两个 fd**，刻意不去重：两个标签各自滚动
/// 是正常用法，而「复用同一个分片」要么让两个标签的滚动互相干扰，
/// 要么得加一层引用计数——那正是本模块开头说的「必须有人来收尾」的复杂度加倍版。
#[command]
pub async fn open_large(shards: State<'_, ShardRegistry>, path: String) -> Result<ShardOpen, ReadError> {
    open_large_at(&shards, &path).await
}

/// [`open_large`] 的本体。拆出来只有一个理由——`State<'_, T>` 没有公开的构造器，
/// 裹着它的命令在单测里压根调不到。与 `commands.rs` 里 `rebuild_indexes` 同一条做法。
async fn open_large_at(shards: &ShardRegistry, path: &str) -> Result<ShardOpen, ReadError> {
    let owned = path.to_owned();
    let shard =
        tauri::async_runtime::spawn_blocking(move || open_shard(Path::new(&owned))).await.map_err(join_failed)??;
    let header = shard.header.clone();
    Ok(ShardOpen { handle: shards.insert(shard), header })
}

/// 读 `[start, start + count)` 这几行。
///
/// ⚠️ **返回 `Option`：`None` = 这个句柄已经关了**，而不是错误。
///
/// 这不是理论上的边界，是一个**每天都会发生**的时序：用户滚动 → 前端发出
/// `read_lines` → 用户立刻关掉标签 → `close_large` 先到 → 那个读请求回来时句柄没了。
/// 把它报成错误的话，前端会在「用户自己关了个标签」这个完全正常的动作之后
/// 弹一条红色提示，而那条提示说的还是一个用户从来没听说过的句柄号。
/// 前端的正确处理只有一个字：忽略。
///
/// ⚠️ **声明成 `async fn` 但函数体里一个 `.await` 都没有**，这是有意的：
/// 同步 command 跑在主线程上，而一次读页最坏 1 MiB，在网络卷上能到秒级。
/// 放进 async worker 就够了，⛔不必再套 `spawn_blocking`——一页最多 1 MiB，
/// 严格小于 `open_file` 那条已经判过可接受的内联 4 MiB；而滚动时这个命令
/// 一秒能来好几次，每次都绕一趟 blocking 池是纯开销。
///
/// `start` 与 `count` 原样透传，夹取与两道安全阀（`MAX_PAGE_LINES` / `MAX_PAGE_BYTES`）
/// 全在 `vela_core::fs::shard::LineIndex::read_page` 里。⛔ 这一层**不**再夹一遍：
/// 两份夹取逻辑迟早会漂，而漂了的症状是「滚动条到底了但最后几行出不来」。
#[command]
pub async fn read_lines(
    shards: State<'_, ShardRegistry>,
    handle: u64,
    start: u64,
    count: u64,
) -> Result<Option<ShardPage>, ReadError> {
    read_lines_at(&shards, handle, start, count)
}

/// [`read_lines`] 的本体，理由同 [`open_large_at`]。
fn read_lines_at(shards: &ShardRegistry, handle: u64, start: u64, count: u64) -> Result<Option<ShardPage>, ReadError> {
    let Some(slot) = shards.get(handle) else { return Ok(None) };
    // ⚠️ 这把锁**持到底**：seek 与 read 是两步，见 [`ShardRegistry`] 的文档
    let mut shard = slot.lock().unwrap_or_else(PoisonError::into_inner);
    shard.read_page(start, count).map(Some).map_err(ReadError::io)
}

/// 关掉一个分片，fd 与索引一起释放。
///
/// 同步 command 就够：一次 `HashMap::remove`，与 `cancel_task` 同一档。
/// ⚠️ 而它**必须**由前端调——见本模块开头「第一份必须有人来收尾的资源」那一节。
/// 标签关掉、窗口关掉、以及外部改了文件之后重开分片，三处都要调。
#[command]
pub fn close_large(shards: State<'_, ShardRegistry>, handle: u64) {
    shards.remove(handle);
}

/// `spawn_blocking` 的 `JoinError` 翻成 `ReadError::Io`。
///
/// ⚠️ 与 `commands::join_failed` **刻意不共用**：那一个翻成 `TreeError::Io`
/// （索引那两条命令的错误枚举），这一个翻成 `ReadError::Io`。两个枚举没有共同祖先，
/// 而为了让一句文案只写一遍去引一个 trait，代价比收益大。
///
/// 它只有两个来源：任务被取消，或者任务 panic 了。panic 在 release 下是
/// `panic = "abort"`，进程当场就没了、压根走不到这里，所以能收到这一条的实际只有取消。
fn join_failed(error: tauri::Error) -> ReadError {
    ReadError::Io { reason: "Join".to_owned(), message: format!("建分片索引的任务没能跑完：{error}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use vela_core::fs::{Encoding, LineEnding};

    fn fixture(lines: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let text: String = (0..lines).map(|i| format!("第 {i} 行\n")).collect();
        fs::write(dir.path().join("big.txt"), text.as_bytes()).unwrap();
        dir
    }

    fn path_of(dir: &tempfile::TempDir) -> String {
        dir.path().join("big.txt").to_string_lossy().into_owned()
    }

    /// 一整圈：开 → 读 → 关 → 再读。
    ///
    /// ⚠️ 最后那一步是本模块存在的理由：`close_large` 之后表里必须真的空了，
    /// 否则「关掉标签」只是把 fd 藏起来，用户开一整天大文件就把系统的 fd 用完了
    #[test]
    fn 打开_读页_关掉_一整圈() {
        let dir = fixture(10);
        let registry = ShardRegistry::default();
        tauri::async_runtime::block_on(async {
            let opened = open_large_at(&registry, &path_of(&dir)).await.unwrap();
            assert_eq!(opened.header.total_lines, 10);
            assert_eq!(registry.len(), 1);

            let page = read_lines_at(&registry, opened.handle, 2, 3).unwrap().expect("句柄刚开就没了");
            assert_eq!(page.start, 2);
            assert_eq!(page.lines, vec!["第 2 行".to_owned(), "第 3 行".into(), "第 4 行".into()]);

            registry.remove(opened.handle);
            assert_eq!(registry.len(), 0, "close 之后 fd 还挂在表里");
            assert!(read_lines_at(&registry, opened.handle, 0, 1).unwrap().is_none());
        });
    }

    /// 🔴 句柄**永不复用**。复用的话一个迟到的 `read_lines` 会读到另一个文件的正文——
    /// 不崩、不报错，只是把 A 的内容画在 B 的标签里
    #[test]
    fn 句柄从_1_开始_而且永不复用() {
        let dir = fixture(3);
        let registry = ShardRegistry::default();
        tauri::async_runtime::block_on(async {
            let path = path_of(&dir);
            let first = open_large_at(&registry, &path).await.unwrap().handle;
            let second = open_large_at(&registry, &path).await.unwrap().handle;
            assert_eq!((first, second), (1, 2), "0 被留作「永远不合法」，所以第一个是 1");

            registry.remove(first);
            let third = open_large_at(&registry, &path).await.unwrap().handle;
            assert_eq!(third, 3, "句柄被复用了：{third}");
            assert_eq!(registry.len(), 2);
        });
    }

    /// 同一个路径开两次是两个独立分片：关掉一个，另一个照常读。
    ///
    /// 去重的话两个标签的滚动会互相干扰（共用一个 fd = 共用一个读写位置），
    /// 理由写在 [`open_large`] 的文档里
    #[test]
    fn 同一个路径开两次互不影响() {
        let dir = fixture(6);
        let registry = ShardRegistry::default();
        tauri::async_runtime::block_on(async {
            let path = path_of(&dir);
            let a = open_large_at(&registry, &path).await.unwrap().handle;
            let b = open_large_at(&registry, &path).await.unwrap().handle;
            assert_ne!(a, b);

            registry.remove(a);
            let page = read_lines_at(&registry, b, 4, 2).unwrap().expect("关掉另一个标签把我这个也关了");
            assert_eq!(page.lines, vec!["第 4 行".to_owned(), "第 5 行".into()]);
        });
    }

    /// ⚠️ 未知句柄回来的是 `None`，**不是错误**。
    ///
    /// 这条钉的是一个每天都会发生的时序：滚动发出的读请求还在路上，用户关了标签。
    /// 报成错误的话前端会在用户自己关标签之后弹一条红提示
    #[test]
    fn 未知句柄是_none_而不是错误() {
        let registry = ShardRegistry::default();
        assert!(read_lines_at(&registry, 0, 0, 10).unwrap().is_none(), "0 被当成合法句柄了");
        assert!(read_lines_at(&registry, 9999, 0, 10).unwrap().is_none());
        // 而关掉它也不是错误：标签级与窗口级各关一次是正常时序
        registry.remove(9999);
        registry.remove(9999);
        assert_eq!(registry.len(), 0);
    }

    /// `open_shard` 那几条闸原样透传，这一层一条都不重造。
    ///
    /// ⚠️ 值得单钉一条：前端靠 `kind` 分支（`describeFsError`），
    /// 在这一层把错误压成字符串的话那套分支就全废了
    #[test]
    fn 目录与不存在的文件报的是_read_error() {
        let dir = tempfile::tempdir().unwrap();
        let registry = ShardRegistry::default();
        tauri::async_runtime::block_on(async {
            let got = open_large_at(&registry, &dir.path().to_string_lossy()).await;
            assert!(matches!(got, Err(ReadError::Directory { .. })), "{got:?}");

            let gone = dir.path().join("nope.txt").to_string_lossy().into_owned();
            let got = open_large_at(&registry, &gone).await;
            match got {
                Err(ReadError::Io { reason, .. }) => assert_eq!(reason, "NotFound"),
                other => panic!("期望 Io/NotFound，实际 {other:?}"),
            }
            // 失败一次都不该在表里留下条目
            assert_eq!(registry.len(), 0);
        });
    }

    /// 契约快照：与 `src/ipc/shard.test.ts` 是同一条契约的两半，改一边必须改另一边。
    ///
    /// ⚠️ `read_lines` 那两条**都要**钉：`Some` 的形状前端要解，`None` 的形状
    /// （线上就是一个 `null`）前端要能认出来并忽略。少钉后者的话，
    /// 「句柄已关」这个每天都会走到的分支在前端就是未测代码
    #[test]
    fn 线上形状() {
        let opened = ShardOpen {
            handle: 7,
            header: ShardHeader {
                total_lines: 12,
                bytes: 34,
                encoding: Encoding::Gbk,
                bom: true,
                eol: LineEnding::Crlf,
                lossy: false,
            },
        };
        assert_eq!(
            serde_json::to_string(&opened).unwrap(),
            r#"{"handle":7,"header":{"totalLines":12,"bytes":34,"encoding":"gbk","bom":true,"eol":"crlf","lossy":false}}"#
        );

        let page = ShardPage { start: 3, lines: vec!["a".to_owned(), "b".into()], truncated: true, lossy: true };
        assert_eq!(
            serde_json::to_string(&Some(page)).unwrap(),
            r#"{"start":3,"lines":["a","b"],"truncated":true,"lossy":true}"#
        );
        assert_eq!(serde_json::to_string(&None::<ShardPage>).unwrap(), "null");
    }
}
