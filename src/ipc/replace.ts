/**
 * `vela-core::search::replace` 的前端镜像 + `start_replace` 封装（PLAN.md §3.4 M2-D）。
 *
 * ## ⚠️ 这是 Vela 里唯一一处「按下就不可撤销地改用户磁盘上的东西」
 *
 * 保存文件也是写盘，但那是用户自己按的 ⌘S，改的是他正在看的那一个文件，
 * 编辑器里还有撤销栈。这里是**一次按键改两万个文件**，Vela 没有跨文件撤销，
 * 改坏了只能靠 `git checkout`——而用户搜的很可能正是一个不在 git 里的目录。
 *
 * 所以这个模块的每一处取舍都倒向「宁可少改，也不要静默改坏」，
 * 而 `ReplaceSummary` 里那七个计数器就是这件事的对外出口。
 * **UI 必须把非零的那些说出来**，否则用户看到的是「全部替换完成」，
 * 而磁盘上有三个文件一个字节都没动。
 *
 * ## 与预览的关系：预览走 `search.ts`，落盘走这里
 *
 * ```text
 * start_search(root, { ...query, replace })  ──► 预览：每条命中多一个 replaced
 *                    │  用户在面板里看到「a.ts:12  let a = needle;  →  let a = N;」
 *                    ▼  按下「替换全部」+ 确认
 * start_replace(root, { query, skip })       ──► 落盘，本文件
 * ```
 *
 * ⚠️ **两边必须是同一个 `query` 对象**。Rust 侧靠「共用同一个遍历函数、同一个匹配机、
 * 同一个模板展开」保证「所见即所做」（见 `vela-core/src/search/mod.rs`），
 * 但那条保证的前提是**前端递过去的是同一份条件**。前端要是在两步之间偷偷改了
 * `caseSensitive`，用户批准的就不是实际发生的那份了——而没有任何测试能发现，
 * 因为两边各自的实现都是对的。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { SearchError, SearchQuery } from './search'

/** Rust `search::ReplaceRequest`，`#[serde(rename_all = "camelCase")]` */
export interface ReplaceRequest {
  /**
   * 与预览那次**同一个** query，`replace` 必须非 `undefined`。
   *
   * ⚠️ `replace` 缺失时 Rust 侧回 `bad_replacement`（「缺少替换内容」）而不是
   * 静默地什么都不做。这是刻意的：静默无操作会让用户以为替换成功了
   */
  query: SearchQuery
  /**
   * **不要碰**的文件，绝对路径。用来保护用户正在编辑、还没保存的那几个标签：
   * 落盘把它们盖掉的话，编辑器里那份未保存的改动就成了「与磁盘不一致的孤儿」，
   * 而用户下一次 ⌘S 又会把刚落盘的结果盖回去。
   *
   * ⚠️ 比对是逐组件的 `Path` 相等：**不**解析符号链接、**不**化简 `..`、**不**管大小写。
   * 所以这里必须递 Rust 侧给过的**原样**绝对路径（`SearchFile.path`、`DirEntry.path`），
   * 不要自己拼、不要 `normalize`。递错了的后果是「少改一个文件、`skippedOpen` 加一」，
   * 方向是安全的——但用户会看到那个数字而不知道是为什么
   *
   * 空/缺省 = 一个都不跳过
   */
  skip?: string[]
}

/**
 * Rust `search::ReplaceProgress`。飞行途中的快照。
 *
 * ⚠️ **累计值，不是增量**——与 `SearchBatch.filesScanned` 同一条规矩
 */
export interface ReplaceProgress {
  filesScanned: number
  filesChanged: number
  replacements: number
}

/** Rust `search::ReplaceSummary`。一次替换结束时的总账，**唯一权威的最终数字** */
export interface ReplaceSummary {
  /**
   * 读过并尝试替换的文件数。`skip` 里的、太大的、读不动的都**不算**——
   * 那三类各有各的计数器，混进这一个的话「扫了多少」就说不清了
   */
  filesScanned: number
  /** 真的写了盘的文件数 */
  filesChanged: number
  /**
   * 真的换掉的**处**数。⚠️ 不是行数：一行里可以有多处命中。
   *
   * ⚠️ 而且它**可以大于预览里显示的条数**：预览对单个文件有 500 条的上限
   * （`MAX_HITS_PER_FILE`），落盘没有——一个有 600 处命中的文件，600 处全换。
   * 半份替换的文件比「一个都没换」和「全换了」都糟。所以 UI 在两个数字不一致时
   * 要说清「预览里显示 500 处，实际换了 600 处」，而不是当成 bug 藏起来
   */
  replacements: number
  /**
   * 原始字节里含 NUL 而整个跳过的文件数。那是 `.png` / `.woff2` / `pack-*.idx`，
   * 正则在上面命中的是一段碰巧相同的字节，写回去等于把二进制文件按文本重排一遍。
   *
   * ⚠️ 这一条比搜索侧**更严**（搜索见到很后面的 NUL 时还留着前面的命中），
   * 而方向是安全的：预览里出现、落盘时跳过，最坏结果是「少改一个文件」并且被报出来
   */
  skippedBinary: number
  /**
   * 解码有损而整个跳过的文件数。解码时已经有字节被换成 U+FFFD 了，
   * 写回去就是把那个替换字符**永久焊进**用户的文件。
   *
   * ⚠️ 对用户这句话要说成「这个文件的编码认不准，没敢改」，
   * 并指到状态栏那个「以某编码重新打开」——那是他唯一能自己解决的路
   */
  skippedLossy: number
  /**
   * 替换结果编不回原编码而整个跳过的文件数（往 GBK 文件里换进一个 emoji）。
   * 这时文件还没写，拦住是零成本的
   */
  skippedUnmappable: number
  /** 因为太大（> 10 MiB）被整个跳过的文件数。**我们主动决定不改** */
  skippedTooLarge: number
  /** 因为在 `skip` 清单里而跳过的文件数——也就是用户自己开着、还没保存的那些 */
  skippedOpen: number
  /**
   * 读不动的文件数（权限不够、被删、IO 错误）。
   *
   * ⚠️ **这个数非零意味着「替换完成」可能是假的**，UI 必须说出来，
   * 与 `SearchSummary.unreadable` 同一条理由
   */
  unreadable: number
  /**
   * 尝试写盘但没写成的文件数。⚠️ 与其它六个 `skipped*` 不是一类东西：
   * 那些是「我们决定不写」，这一个是「想写而写不成」（磁盘满了、文件只读、
   * 目录被卸载）。对用户是最要紧的一条，因为它意味着**这个文件现在与预览不一致**
   */
  writeFailed: number
  /** 撞到总处数上限（20000），剩下的没换。⚠️ 这意味着仓库现在处于「换了一半」的状态 */
  truncated: boolean
  /**
   * 被取消了。⚠️ **取消不是撤销**：`filesChanged` 个文件已经改完并留在磁盘上。
   * UI 必须把那个数字一起说出来
   */
  cancelled: boolean
  elapsedMs: number
}

/** Rust `src-tauri/src/lib.rs` 的 `REPLACE_PROGRESS`。⚠️ **可能一个都不来**，见下 */
export const REPLACE_PROGRESS_EVENT = 'vela://replace-progress'
/** Rust `src-tauri/src/lib.rs` 的 `REPLACE_DONE`。**唯一的终止信号** */
export const REPLACE_DONE_EVENT = 'vela://replace-done'
/** Rust `src-tauri/src/lib.rs` 的 `REPLACE_FAILED`。正常情况收不到，见那边的注释 */
export const REPLACE_FAILED_EVENT = 'vela://replace-failed'

/** 三个事件载荷的信封形状。与 `src-tauri/src/commands.rs` 里那三个 `Replace*Payload` 对照 */
export interface ReplaceProgressPayload {
  taskId: string
  /** 内嵌而不是摊平：`ReplaceProgress` 自己就有 `filesScanned`，摊平的话两个同名字段会撞 */
  progress: ReplaceProgress
}
export interface ReplaceDonePayload {
  taskId: string
  summary: ReplaceSummary
}
export interface ReplaceFailedPayload {
  taskId: string
  error: SearchError
}

/**
 * 起一次全局替换（**落盘**），**立刻**拿到 `taskId`。进度与终止信号走 event。
 *
 * @param root dialog（`directory: true`）给的绝对路径，与预览那次同一个
 * @param query 与预览那次**同一个对象**，`replace` 必须非 `undefined`
 * @param skip 用户正开着、还没保存的那些文件的绝对路径（原样递，见 `ReplaceRequest.skip`）
 *
 * ⚠️ **调用之前必须先挂上监听器**，见 [`attachReplaceListeners`]。
 * 这条对替换比对搜索更要紧：`replace-done` 是唯一能让 UI 停止转圈的东西，
 * 而它到达时磁盘已经改完了——漏掉它的话用户面对的是一个
 * 「改完了却显示还在改」的仓库，很可能再按一次替换。
 */
export function startReplace(root: string, query: SearchQuery, skip: string[] = []): Promise<string> {
  const request: ReplaceRequest = { query }
  // 空清单不发这个 key：Rust 侧 `#[serde(default)]` 会落到「一个都不跳过」，
  // 与 `[]` 完全等价。替它补默认值等于把默认值抄两份，哪天那边改了这边就悄悄分岔
  if (skip.length > 0) request.skip = skip
  return invoke<string>('start_replace', { root, request })
}

export interface ReplaceHandlers {
  /**
   * 一次进度快照。
   *
   * ⚠️ **可能一次都不来**：全部文件都没有命中时，既没有「改动」触发推送，
   * 心跳阈值又远没到。所以 UI 不能把「没收到 progress」当成出错或当成卡死——
   * 终止信号永远是 done
   *
   * ⚠️ 而且这里的 `filesScanned` **可以小于** done 里那个（落盘那一侧刻意不做收尾
   * flush）。最终数字一律以 summary 为准，progress 只用于飞行途中
   */
  onProgress(taskId: string, progress: ReplaceProgress): void
  /** 替换结束。这是唯一的终止信号，之后这个 taskId 不会再有事件 */
  onDone(taskId: string, summary: ReplaceSummary): void
  /** 起飞前检查过了之后才失败（几乎只有「root 在两步之间被删掉」一种）。也要当终止处理 */
  onFailed(taskId: string, error: SearchError): void
}

/**
 * 挂上三个替换事件的监听器，返回一个能一次注销掉三个的函数。
 *
 * ⚠️ **必须在第一次 `startReplace` 之前挂好，而且要挂着不放**——不是每次替换挂一遍。
 * 理由与 `attachSearchListeners` 完全相同：`start_replace` 返回 taskId 的那一刻
 * 后台线程已经在跑了，而 `listen` 本身是异步的，中间到达的事件**永久丢失**。
 *
 * ⚠️ 可以与 `attachSearchListeners` **同时挂着**，两者互不干扰：
 * 事件名不同，而 taskId 也永不重复（同一个计数器发的号）。
 * 所以启动时把两组监听器一起挂上就好，不需要「进替换模式时切换」这种状态机
 */
export async function attachReplaceListeners(handlers: ReplaceHandlers): Promise<UnlistenFn> {
  // `Promise.all` 而不是逐个 await：三个 listen 之间不该有时间差，
  // 否则「progress 挂上了而 done 还没挂上」那个窗口里结束的替换会永远等不到终止信号
  const [unProgress, unDone, unFailed] = await Promise.all([
    listen<ReplaceProgressPayload>(REPLACE_PROGRESS_EVENT, (e) =>
      handlers.onProgress(e.payload.taskId, e.payload.progress),
    ),
    listen<ReplaceDonePayload>(REPLACE_DONE_EVENT, (e) => handlers.onDone(e.payload.taskId, e.payload.summary)),
    listen<ReplaceFailedPayload>(REPLACE_FAILED_EVENT, (e) => handlers.onFailed(e.payload.taskId, e.payload.error)),
  ])
  return () => {
    unProgress()
    unDone()
    unFailed()
  }
}
