/**
 * `vela-core::search` 的前端镜像 + `start_search` / `cancel_search` 封装
 * （PLAN.md §2.6 约束 3、§3.4 M2-C）。
 *
 * ⚠️ **与 `src/ipc/fs.ts`、`src/ipc/project.ts` 同样的处境：类型是手写的，两边没有
 * 代码生成。** 漂移的失败方式是 `undefined` 而不是异常——`caseSensitive` 写成
 * `case_sensitive`，Rust 那边靠 `#[serde(default)]` 安静地拿到 `false`，于是
 * 「我明明勾了区分大小写」变成「结果里全是不想要的东西」，控制台一行错都没有。
 * 两侧各有一份对照的黄金 JSON：
 *
 * - Rust：`crates/vela-core/tests/wire_contract.rs` 的「M2-C 全文搜索」那一节，
 *   加上 `src-tauri/src/commands.rs` 的 `三个搜索事件载荷的线上形状`
 * - 前端：`src/ipc/search.test.ts`
 *
 * ## 这是本项目第一个 event 流，形状与前面那些命令都不一样
 *
 * 前面的命令都是「invoke → 等 → 拿到结果」。搜索不行：实测十万个文件要 6.9s，
 * 而一次搜索能产出上万条命中，一次性回传既撞 §2.6 的 4MB payload 上限，
 * 也撞「首批结果 < 2s」那条验收。所以它的形状是：
 *
 * ```text
 * invoke('start_search') ──► 立刻返回 taskId（起飞前检查没过则直接 reject）
 *                    │
 *                    ├──► vela://search-batch   ×N   一批结果，或一次心跳
 *                    └──► vela://search-done        唯一的终止信号，带 SearchSummary
 *                        vela://search-failed       几乎收不到，见 lib.rs
 * ```
 *
 * 前端的规则因此只有一句：**`start_search` reject 了 = 这次搜索压根没开始；
 * 拿到了 taskId = 一定会等到 done 或 failed，中间可能来任意多个 batch。**
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Rust `search::SearchQuery`，`#[serde(rename_all = "camelCase", default)]` */
export interface SearchQuery {
  /**
   * 要搜的东西。⚠️ **空字符串会被 reject**（`bad_pattern`）：空正则匹配每一行，
   * 于是用户会收到两万条与他的意图毫无关系的结果。前端应该在发之前就拦掉
   */
  pattern: string
  /** 把 `pattern` 当字面串而不是正则（就是 VS Code 那个「.*」开关）。默认关 */
  literal?: boolean
  /** 区分大小写。默认**不**区分 */
  caseSensitive?: boolean
  /** 整词匹配。可以与 `literal` 同时开 */
  wholeWord?: boolean
  /** 只搜匹配这些通配的路径（相对 root，例如 `*.ts`、`src/**`）。空/缺省 = 不限 */
  include?: string[]
  /** 排除匹配这些通配的路径。⚠️ 优先级**高于** `include` */
  exclude?: string[]
}

/**
 * Rust `search::MatchRange`。一行里的一个命中段。
 *
 * ⚠️ `start` / `end` 数的是 **UTF-16 码元**，也就是 JS 的
 * `String.prototype.slice` / CodeMirror 的位置用的那套。可以直接切、直接交给编辑器，
 * **不要**先按 `Array.from(text)` 或字符数换算——那会把含 emoji / CJK 扩展区的行
 * 高亮画错一个字，而且只在那些行上错，安静得几乎查不到。
 */
export interface MatchRange {
  start: number
  end: number
}

/** Rust `search::SearchHit`。命中的一行 */
export interface SearchHit {
  /** 1 起算的行号——编辑器与 `Cmd+Alt+G` 跳行用的都是 1 起算 */
  line: number
  /**
   * 这一行的正文，**不含**行终止符，也**没有 trim**。
   * ⚠️ 不要 trim：`ranges` 里的偏移量是按这个字符串算的，一 trim 就全错了。
   * 缩进深的话让它自己横向溢出
   */
  text: string
  /**
   * 这一行里的命中段，升序、不重叠。
   *
   * ⚠️ **可能是空的**，且空不等于「这行没命中」——它的意思是「这行确实命中了，
   * 只是没能告诉你命中在哪儿」（正文被预览上限截断、或命中段数撞了上限）。
   * 行号照样能跳，只是高亮画不出来
   */
  ranges: MatchRange[]
  /** 正文被截断了（原文比 `text` 长） */
  truncated: boolean
}

/** Rust `search::SearchFile`。一个文件的全部命中——批次以它为单位 */
export interface SearchFile {
  /**
   * 相对 root 的路径，与 `DirEntry.rel` 同一套规矩：`/` 分隔、不以 `/` 开头或结尾。
   * 拿它去树上定位，也拿它当分组标题
   */
  rel: string
  /** 绝对路径，交给 `openFile` 用。⚠️ 不要自己用 root + rel 拼，这一份就是拼好的 */
  path: string
  hits: SearchHit[]
  /** 这个文件的命中被单文件上限截断了：UI 要说「还有更多」 */
  truncated: boolean
}

/** Rust `search::SearchBatch`。推过来的一批 */
export interface SearchBatch {
  /**
   * ⚠️ **可能是空的，那是一次心跳而不是「没有结果」。**
   *
   * 实测：十万个文件、一个都不命中时，第一个**结果**要 7.14s 才到。没有心跳的话
   * 那 7 秒里 UI 手上什么都没有——既不能显示进度也不能说「没找到」，看起来就是卡死了。
   *
   * 所以规则是：**`files` 为空时只更新进度，不要动结果列表，更不要把它当成
   * 「搜索结束了」**。结束的唯一信号是 `vela://search-done`
   */
  files: SearchFile[]
  /**
   * 到这一批推出去为止一共读了多少个文件的正文。
   * ⚠️ **累计值，不是增量**：当成增量累加的话，十万个文件会显示成「已扫两百万个」
   */
  filesScanned: number
}

/** Rust `search::SearchSummary`。一次搜索结束时的总账 */
export interface SearchSummary {
  /** 真的读了正文的文件数。**不含**被跳过的与被取消打断的 */
  filesScanned: number
  filesWithHits: number
  hits: number
  /**
   * 因为太大被整个跳过的文件数。与 `unreadable` 分成两个数：这一条是
   * **我们主动决定不搜**，那一条是**想搜而搜不动**，对用户是两句话
   */
  skippedTooLarge: number
  /**
   * 读不动的条目数（权限不够、文件被删、IO 错误）。
   *
   * ⚠️ **这个数非零意味着「没找到」可能是假的**，UI 必须说出来，
   * 否则用户会得到一个看起来很确定的错答案
   */
  unreadable: number
  /** 撞到总命中上限，剩下的没搜 */
  truncated: boolean
  /** 被取消了。已经推出去的批次仍然有效 */
  cancelled: boolean
  elapsedMs: number
}

/**
 * Rust `search::SearchError`，`#[serde(tag = "kind", rename_all = "snake_case")]`。
 *
 * ⚠️ **没有 `io` 变体**，这是刻意的：遍历途中读不动某个文件不是「搜索失败」，
 * 它计入 `SearchSummary.unreadable` 而搜索继续。少搜一个目录比整次搜索报错有用得多
 */
export type SearchError =
  | { kind: 'bad_pattern'; message: string }
  /** `include` / `exclude` 里某一条通配编不出来。带上那条 `glob`：一个列表里可能有好几条，只说「通配写错了」等于让用户挨个试 */
  | { kind: 'bad_glob'; glob: string; message: string }
  | { kind: 'bad_root'; path: string }
  | { kind: 'not_found'; path: string }

/** Rust `src-tauri/src/lib.rs` 的 `SEARCH_BATCH` */
export const SEARCH_BATCH_EVENT = 'vela://search-batch'
/** Rust `src-tauri/src/lib.rs` 的 `SEARCH_DONE`。**唯一的终止信号** */
export const SEARCH_DONE_EVENT = 'vela://search-done'
/** Rust `src-tauri/src/lib.rs` 的 `SEARCH_FAILED`。正常情况收不到，见那边的注释 */
export const SEARCH_FAILED_EVENT = 'vela://search-failed'

/** 三个事件载荷的信封形状。与 `src-tauri/src/commands.rs` 里那三个 `*Payload` 对照 */
export interface SearchBatchPayload {
  taskId: string
  /** 内嵌而不是摊平：`SearchBatch` 自己就有 `files` 与 `filesScanned` */
  batch: SearchBatch
}
export interface SearchDonePayload {
  taskId: string
  summary: SearchSummary
}
export interface SearchFailedPayload {
  taskId: string
  error: SearchError
}

/** `invoke` 的 reject 值是 `unknown`：Tauri 把 Rust 的 `Err` 序列化后原样抛出 */
function isSearchError(value: unknown): value is SearchError {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

export function describeSearchError(err: unknown): string {
  if (!isSearchError(err)) return err instanceof Error ? err.message : String(err)
  switch (err.kind) {
    // 搜索词是用户打的，Rust 侧给的 message 已经是中文的人话，原样用
    case 'bad_pattern':
      return err.message
    // glob 用 JSON.stringify 而不是直接内插：它可能是空字符串，也可能含空格与引号。
    // 必须点名是哪一条——`include` 里可以有好几条，只说「通配写错了」等于让用户挨个试
    case 'bad_glob':
      return `${JSON.stringify(err.glob)} 不是合法的通配：${err.message}`
    // 这一条对用户是**真的会发生**的：他打开的文件夹在外接盘上，盘被拔了。
    // 与 `TreeError.escape` 不同，那不是我们的 bug，所以不说「内部错误」
    case 'not_found':
      return `找不到 ${err.path}（可能被移动、删除或弹出了）`
    // root 只可能来自 dialog，前端没有任何输入框能填它，所以走到这里就是我们的 bug。
    // 把它说成用户能做的事，等于给一条断言套上提示的皮
    case 'bad_root':
      return `内部错误：项目根目录 ${JSON.stringify(err.path)} 不是绝对路径`
    default:
      return String(err)
  }
}

/**
 * 起一次全文搜索，**立刻**拿到 `taskId`。结果走 event，见文件头那张图。
 *
 * @param root dialog（`directory: true`）给的绝对路径
 * @param query 只有 `pattern` 是必填的，其余五个字段缺 key 时 Rust 侧落到默认值
 *   （那边有一条 `只发_pattern_的搜索条件也能解析` 钉住这份宽容）
 *
 * ⚠️ **调用之前必须先挂上监听器**，见 [`attachSearchListeners`]。
 */
export function startSearch(root: string, query: SearchQuery): Promise<string> {
  return invoke<string>('start_search', { root, query })
}

/**
 * 取消一次搜索。已经推出去的批次仍然有效，随后的 done 里 `cancelled` 为真。
 *
 * **幂等**：taskId 不认识也照样成功。「取消一个已经搜完的搜索」是正常时序——
 * 点取消的那一刻后台线程可能刚好发完 done。所以这里不需要判返回值，也没有失败分支。
 *
 * ⚠️ Rust 侧是 `task_id: String`，Tauri 2 在命令边界上转成驼峰，所以这里写 `taskId`。
 * 这是本项目第二个多单词命令参数（第一个是 `rename_entry` 的 `newName`）
 */
export function cancelSearch(taskId: string): Promise<void> {
  return invoke<void>('cancel_search', { taskId })
}

export interface SearchHandlers {
  /**
   * 一批结果，或一次心跳。
   * ⚠️ `batch.files` 为空时**只更新进度**，不要动结果列表——那是心跳
   */
  onBatch(taskId: string, batch: SearchBatch): void
  /** 搜完了。这是唯一的终止信号，之后这个 taskId 不会再有事件 */
  onDone(taskId: string, summary: SearchSummary): void
  /** 起飞前检查过了之后才失败（几乎只有「root 在两步之间被删掉」一种）。也要当终止处理 */
  onFailed(taskId: string, error: SearchError): void
}

/**
 * 挂上三个搜索事件的监听器，返回一个能一次注销掉三个的函数。
 *
 * ⚠️ **必须在第一次 `startSearch` 之前挂好，而且要挂着不放**——不是每次搜索挂一遍。
 * 原因是一条真实的竞态：`start_search` 返回 taskId 的那一刻后台线程已经在跑了，
 * 而 `listen` 本身是异步的。要是写成
 *
 * ```ts
 * const id = await startSearch(root, query)   // 事件从这一刻就开始发
 * await listen(SEARCH_BATCH_EVENT, …)         // 这中间到达的批次**永久丢失**
 * ```
 *
 * 丢掉的是**最前面**那几批，也就是用户最先看到的那些结果——表现是「搜索结果少了开头
 * 几个文件」，而 done 里的总账是对的，于是界面上「共 87 处」与列表里的条数对不上。
 * 那种不一致比一个都没有更难查。
 *
 * 与 `attachWindowCloseGuard` 是同一条规矩：注册之前到达的事件会丢掉。
 */
export async function attachSearchListeners(handlers: SearchHandlers): Promise<UnlistenFn> {
  // `Promise.all` 而不是逐个 await：三个 listen 之间不该有时间差，
  // 否则「batch 挂上了而 done 还没挂上」那个窗口里结束的搜索会永远等不到终止信号
  const [unBatch, unDone, unFailed] = await Promise.all([
    listen<SearchBatchPayload>(SEARCH_BATCH_EVENT, (e) => handlers.onBatch(e.payload.taskId, e.payload.batch)),
    listen<SearchDonePayload>(SEARCH_DONE_EVENT, (e) => handlers.onDone(e.payload.taskId, e.payload.summary)),
    listen<SearchFailedPayload>(SEARCH_FAILED_EVENT, (e) => handlers.onFailed(e.payload.taskId, e.payload.error)),
  ])
  return () => {
    unBatch()
    unDone()
    unFailed()
  }
}
