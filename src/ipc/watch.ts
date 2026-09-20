/**
 * `vela_core::watcher` + `src-tauri/src/watcher.rs` 的前端镜像（PLAN.md §3.4「文件监听」，M2-G）。
 *
 * ⚠️ **与 `src/ipc/fs.ts` 同样的处境：类型是手写的，两边没有代码生成。** 而这一份的
 * 漂移失败方式是 Vela 里最安静的一种：`kind` 写成 `"Changed"`（serde 对无字段枚举的
 * 默认写法）的话，事件照样送到、`listen` 照样回调，只是前端 `switch` 走完 default 分支。
 * 于是「外部改了文件而 Vela 一声不吭」，界面上没有任何东西可看，控制台一行错都没有。
 * 两侧各有一份对照的黄金 JSON：
 *
 * - Rust：`src-tauri/src/watcher.rs` 的 `监听总账的线上形状` / `文件改动载荷的线上形状`，
 *   以及 `crates/vela-core/tests/wire_contract.rs` 的 `file_change_是两个小写单词`
 * - 前端：`src/ipc/watch.test.ts`
 * - 事件名本身：`src-tauri/src/lib.rs` 的 `file_changed_event_matches_frontend`
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Rust `watcher::WatchStats`，`#[serde(rename_all = "camelCase")]` */
export interface WatchStats {
  /** 现在订阅着几个目录（**不是**几个文件：一个目录能装下几十个打开的文件） */
  dirs: number
  /** 过滤器里有几个文件。等于「现在盯着几个标签」，减去下面那三个漏掉的 */
  files: number
  /**
   * 这一次 `watch` / `unwatch` 失败的个数（目录不存在、权限不够、inotify 配额满了）。
   *
   * ⚠️ **它非零不会让这次调用 reject**——Rust 侧刻意如此：为了一个订不上的目录
   * 把整件事关掉，赔上的是其余十几个目录。代价是这份失败**不会自愈**，
   * 所以这个数字要让用户看见，别咽下去
   */
  failed: number
  /** 计划阶段就被丢掉的输入条数：不是绝对路径、或者长在 `/` 底下（盯 `/` 等于盯整台机器） */
  skipped: number
  /**
   * 目录数撞了 `MAX_WATCH_DIRS`（256），`files` 也跟着少。
   *
   * ⚠️ 与 `IndexStats.truncated` 是同一条道理：「某个文件外部改了而 Vela 没吭声」
   * 与「Vela 压根没在盯它」在界面上长得一模一样，不说一句用户无从分辨
   */
  truncated: boolean
}

/**
 * Rust `watcher::FileChange`。只有两种。
 *
 * ⚠️ 刻意**没有**第三种「被重命名了」：改名在 FSEvents 上是一对 `From` / `To`，
 * debouncer 合并它们的结果取决于时序，而「文件还在不在」才是唯一可靠的结论。
 * 于是「改个名字」会按「还在 → changed」或「没了 → removed」报上来，
 * 前端两种都已经会处理，不需要第三个分支
 */
export type FileChangeKind = 'changed' | 'removed'

/** Rust `FileChangedPayload`（`src-tauri/src/watcher.rs`） */
export interface FileChangedPayload {
  /**
   * 🔴 **前端自己递进 `setWatched` 的那个原样字符串**，不是 canonical 形式。
   *
   * 所以它可以（也应该）直接与 `doc.path()` 比——那一个同样从来没被规范化过
   * （理由与 `workspace.dirtyPaths` 上那条逐字相同）。Rust 侧维护着一张
   * 「canonical → 原样」的表来做这次翻译，见 `src-tauri/src/watcher.rs` 的 `Filter`。
   *
   * ⚠️ 一个 canonical 路径可以对应**多个**原样字符串（一个符号链接与它的目标），
   * 那种现场会收到**两条**事件、指向两个不同的标签。前端按标签处理，所以是对的
   */
  path: string
  kind: FileChangeKind
}

/** Rust `src-tauri/src/lib.rs` 的 `FILE_CHANGED` */
export const FILE_CHANGED_EVENT = 'vela://file-changed'

/**
 * 把「现在打开着的这些文件」整份同步给 Rust，让它去调整监听。
 *
 * ⚠️ 递的是**完整清单**而不是增量：Rust 侧自己与上一次那份做 diff，只动变化的那几个
 * 目录。刻意不让前端递增量——两边各记一份状态的话，「谁漏了一次调用」的失败方式是
 * **永久性的静默失效**（那个文件从此再也不会被盯上，而且没有任何东西会说出来），
 * 而整份清单的最坏结果只是「多订阅一个目录」。
 *
 * ⚠️ 路径一律原样递（`doc.path()`），不要自己 normalize、不要解析符号链接。
 * Rust 侧会 canonicalize 一次去订阅，同时把原样字符串记进过滤器，
 * 事件回来时给的还是原样那一份——所以「递什么就收到什么」这条对得上。
 *
 * 递空数组 = **把监听整个关掉**（线程与订阅一起放掉），不是「什么都不改」。
 *
 * reject 只有一种情形：debouncer 起不来（`TreeError` 的 `io` 变体，`reason: "Notify"`）。
 * 那时说人话用 `describeTreeError`（`./project`）就够了，不必为它多写一份分支表。
 */
export function setWatched(paths: readonly string[]): Promise<WatchStats> {
  return invoke<WatchStats>('set_watched', { paths })
}

/**
 * 挂上 `vela://file-changed` 的监听器。
 *
 * ⚠️ **启动时挂一次，然后挂着不放**，与 `attachSearchListeners` /
 * `attachReplaceListeners` 同一条理由：`listen` 本身是异步的，注册完成之前到达的
 * 事件**永久丢失**。而这一条比那两个更要紧——那两个是「一次操作的进度」，
 * 漏了顶多是界面转圈不停；这一条是「磁盘上发生的事」，漏了用户会在不知情的情况下
 * 用 ⌘S 把别人的改动盖掉。
 *
 * ⚠️ 与另外两组监听器**同时挂着**互不干扰：事件名不同，而且这一条压根没有 taskId
 * （它不是「一次操作」的流，是一条条独立的通知，也没有终止信号）。
 */
export function listenFileChanged(onChange: (change: FileChangedPayload) => void): Promise<UnlistenFn> {
  return listen<FileChangedPayload>(FILE_CHANGED_EVENT, (event) => onChange(event.payload))
}
