/**
 * 微信读书全量同步的 IPC（M8-6）。
 *
 * ## 与 `src/ipc/weread.ts` 的分工
 *
 * `ipc/weread.ts` 只管那把 key 的写 / 删 / 问（M8-2），它的用例里有一条护栏钉着
 * 「导出清单就那三个函数、不许出现 get/read/reveal/fetch」。同步是另一条路
 * （起任务 + 三类事件），放进来会把那条护栏的语义冲淡，所以单独一个文件。
 *
 * ## 三条命令 / 三个事件
 *
 * ```
 * weread_sync_dir(dir) ──► taskId（立刻返回，预检失败则 reject）
 *     │                         │
 *     │   vela://weread-progress └─► { taskId, progress: { booksDone, booksTotal } }
 *     │   vela://weread-done         { taskId, summary: WereadSummary }   ← 唯一正常终止
 *     └─► vela://weread-failed       { taskId, error: WereadError }       ← 预检之后的失败
 * ```
 *
 * 🔴 **取消也走 `weread-done`**，`summary.cancelled = true`。所以调用方只认这两条终止信号，
 * 不要给取消单独设计一条「已停」的状态——那会让「取消之后还没停」与「已经停稳」变成两种
 * 需要自己分辨的世界。
 *
 * ⚠️ `WereadError` 的 `message` 是 Rust 侧写好的中文（六种失败各管一句，见
 * `src-tauri/src/weread.rs` 的文件头）。这一层⛔ 不重写那几句话，只负责取出来显示。
 *
 * ⚠️ 与 `attachSearchListeners` 同一条竞态：`weread_sync_dir` 也是先 spawn 再返回 taskId，
 * 所以监听器必须**在第一次同步之前挂好、挂着不放**，见 [`attachWereadListeners`]。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** `vela://weread-progress`：单位是**书**，不是划线。 */
export const WEREAD_PROGRESS_EVENT = 'vela://weread-progress'
/** 唯一的正常终止信号。取消也走它（`summary.cancelled = true`）。 */
export const WEREAD_DONE_EVENT = 'vela://weread-done'
/** 预检**之后**的失败。预检失败（目录不对、key 没配）走的是 invoke reject。 */
export const WEREAD_FAILED_EVENT = 'vela://weread-failed'

/**
 * Rust `WereadProgress` 的镜像。字段名是 camelCase——Rust 侧那条 `rename_all` 与
 * 搜索的两个载荷同一条规矩。
 */
export interface WereadProgress {
  booksDone: number
  booksTotal: number
}

/** Rust `WereadSummary` 的镜像。`cancelled = true` 时其余数字是**取消为止**的账。 */
export interface WereadSummary {
  booksTotal: number
  booksWritten: number
  /** 回包里没有 `bookId` 的书。跳过而不中止：一本坏数据不该拦住另外九十本 */
  booksSkipped: number
  marks: number
  reviews: number
  cancelled: boolean
  elapsedMs: number
}

/**
 * Rust `WereadError` 的镜像。`kind` 只用来分支（要不要在界面上换个说法），
 * 显示给用户的一律是 `message`。
 */
export type WereadError =
  | { kind: 'not_configured'; message: string }
  | { kind: 'keychain'; message: string }
  | { kind: 'network'; reason: string; message: string }
  | { kind: 'upgrade'; message: string }
  | { kind: 'api'; message: string }
  | { kind: 'not_json'; message: string }
  | { kind: 'directory'; message: string }
  | { kind: 'shape'; message: string }
  | { kind: 'storage'; message: string }

interface ProgressPayload {
  taskId: string
  progress: WereadProgress
}

interface DonePayload {
  taskId: string
  summary: WereadSummary
}

interface FailedPayload {
  taskId: string
  error: WereadError
}

/**
 * 起一次全量同步，**立刻**拿到 `taskId`。
 *
 * `dir` 是侧边栏里那个根的原样字符串，只用来核对「打开的就是配置的那个目录」；
 * 真正写盘的是用户全局配置里的 `wereadLocalDir`（理由见 M8-3 决定 2）。
 *
 * ⚠️ **调用之前必须先挂好监听器**，见 [`attachWereadListeners`]。
 */
export function startWereadSync(dir: string): Promise<string> {
  return invoke<string>('weread_sync_dir', { dir })
}

/**
 * 把 Rust 侧那个错误形状里的 `message` 取出来。
 *
 * `invoke` 与事件的载荷都是**序列化后的对象**，不是 `Error`。`Error` 那条兜底只是为了
 * 万一（比如接了一条本地抛出的异常），正常情况下走到 `message` 就返回了。
 */
export function describeWereadError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { kind?: unknown; message?: unknown }
    if (typeof maybe.message === 'string' && typeof maybe.kind === 'string') return maybe.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}

export interface WereadHandlers {
  /** 第几本 / 共几本。第一份一定带着 `booksDone = 0`。 */
  onProgress: (taskId: string, progress: WereadProgress) => void
  /** 正常结束（含用户取消）。之后这个 taskId 不会再有事件。 */
  onDone: (taskId: string, summary: WereadSummary) => void
  /** 预检之后失败。也要当终止处理。 */
  onFailed: (taskId: string, error: WereadError) => void
}

/**
 * 挂上三个同步事件的监听器，返回一个能一次注销掉三个的函数。
 *
 * ⚠️ **必须在第一次 `startWereadSync` 之前挂好，而且要挂着不放**——`listen` 本身是
 * 异步的，而 `weread_sync_dir` 是先 spawn 后台任务再返回 taskId 的。注册之前到达的事件
 * 永久丢失，丢的是最前面那几份进度，表现是「同步中… 一直停在 0/N」，而后台其实已经
 * 写完了好几本。与 `ipc/search.ts` 的 `attachSearchListeners` 逐字同一条理由。
 */
export async function attachWereadListeners(handlers: WereadHandlers): Promise<UnlistenFn> {
  const [unProgress, unDone, unFailed] = await Promise.all([
    listen<ProgressPayload>(WEREAD_PROGRESS_EVENT, (e) => handlers.onProgress(e.payload.taskId, e.payload.progress)),
    listen<DonePayload>(WEREAD_DONE_EVENT, (e) => handlers.onDone(e.payload.taskId, e.payload.summary)),
    listen<FailedPayload>(WEREAD_FAILED_EVENT, (e) => handlers.onFailed(e.payload.taskId, e.payload.error)),
  ])
  return () => {
    unProgress()
    unDone()
    unFailed()
  }
}
