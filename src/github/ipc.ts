/**
 * 目录级 GitHub 同步的 IPC（M8-6b）。
 *
 * ## 与 `src/ipc/github.ts` 的分工
 *
 * `ipc/github.ts` 只管那把 token 的写 / 删 / 问（M8-5），它的用例里有一条护栏钉着
 * 「导出清单就那三个函数、不许出现 get/read/reveal/fetch」。同步是另一条路
 * （起任务 + 三类事件），放进来会把那条护栏的语义冲淡，所以单独一个文件——与
 * `weread/ipc.ts` 和 `ipc/weread.ts` 的分工逐字相同。
 *
 * ## 一条命令 / 三个事件
 *
 * ```
 * github_sync_dir(dir) ──► taskId（立刻返回，预检失败则 reject）
 *     │                         │
 *     │   vela://github-progress └─► { taskId, progress: { filesDone, filesTotal } }
 *     │   vela://github-done         { taskId, summary: GithubSummary }   ← 唯一正常终止
 *     └─► vela://github-failed       { taskId, error: GithubError }      ← 预检之后的失败
 * ```
 *
 * 🔴 **取消也走 `github-done`**，`summary.cancelled = true`。调用方只认这两条终止信号，
 * 不给取消单独设计状态——理由与搜索、微信读书逐字相同。
 *
 * 🔴 **冲突不是第四个事件**：三方比对停下时走 `github-failed`，`error.kind === "conflict"`，
 * `error.conflicts` 里每个文件带三份 sha。⛔ 不要在同步层另起一个「同步冲突」弹窗：
 * 磁盘上的冲突本来就由文件监视器那条队列负责（`src/doc/fileWatch.ts`），这一层只负责
 * 把「哪几条、三边各是什么 sha」交给用户。
 *
 * ⚠️ `GithubError` 的 `message` 是 Rust 侧写好的中文（十三个变体各管一句，见
 * `src-tauri/src/github.rs` 的文件头）。这一层⛔ 不重写那几句话，只负责取出来显示；
 * 也⛔ 不要试图从 `message` 里找关键字分支——分支只看 `kind`。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** `vela://github-progress`：单位是**文件**，不是请求。 */
export const GITHUB_PROGRESS_EVENT = 'vela://github-progress'
/** 唯一的正常终止信号。取消也走它（`summary.cancelled = true`）。 */
export const GITHUB_DONE_EVENT = 'vela://github-done'
/** 预检**之后**的失败（含 `conflict`）。预检失败（目录不对、没配、读 config 失败）走 invoke reject。 */
export const GITHUB_FAILED_EVENT = 'vela://github-failed'

/** Rust `GithubProgress` 的镜像。字段名是 camelCase——Rust 侧 `rename_all` 的同一规矩。 */
export interface GithubProgress {
  filesDone: number
  filesTotal: number
}

/** Rust `GithubSummary` 的镜像。`cancelled = true` 时其余数字是**取消为止**的账。 */
export interface GithubSummary {
  pulled: number
  pushed: number
  cancelled: boolean
  /** state 有没有写成功。失败不影响已经落盘的同步，只是下次退回「无 base」。 */
  stateSaved: boolean
  elapsedMs: number
}

/**
 * 冲突清单里的一条（Rust `ConflictView` 的镜像）。
 *
 * 三个 sha 各自可以是 `null`（那一份不存在）；`kind` 是机器名（`both_changed` 等），
 * 中文那句话在 `message` 里。⛔ 不要拿 `kind` 去直接给用户看。
 */
export interface GithubConflict {
  path: string
  base: string | null
  local: string | null
  remote: string | null
  kind: string
}

/**
 * Rust `GithubError` 的镜像。`kind` 只用来分支（要不要在界面上换个说法），
 * 显示给用户的一律是 `message`。
 */
export type GithubError =
  | { kind: 'not_configured'; message: string }
  | { kind: 'keychain'; message: string }
  | { kind: 'directory'; message: string }
  | { kind: 'repo'; message: string }
  | { kind: 'network'; reason: string; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'branch_not_found'; message: string }
  | { kind: 'non_fast_forward'; message: string }
  | { kind: 'conflict'; message: string; conflicts: GithubConflict[] }
  | { kind: 'api'; message: string }
  | { kind: 'shape'; message: string }
  | { kind: 'local_changed'; message: string }
  | { kind: 'storage'; message: string }

interface ProgressPayload {
  taskId: string
  progress: GithubProgress
}

interface DonePayload {
  taskId: string
  summary: GithubSummary
}

interface FailedPayload {
  taskId: string
  error: GithubError
}

/**
 * 起一次目录同步，**立刻**拿到 `taskId`。
 *
 * `dir` 是侧边栏里那个根的原样字符串，只用来核对「打开的就是配置的那个目录」；
 * 真正读写的是用户全局配置里的 `syncLocalDir`，仓库地址与 token 同理都不过 IPC
 * （理由见 M8-8 决定 8）。
 *
 * ⚠️ **调用之前必须先挂好监听器**，见 [`attachGithubListeners`]。
 */
export function startGithubSync(dir: string): Promise<string> {
  return invoke<string>('github_sync_dir', { dir })
}

/**
 * 把 Rust 侧那个错误形状里的 `message` 取出来。
 *
 * `invoke` 与事件的载荷都是**序列化后的对象**，不是 `Error`。`Error` 那条兜底只是为了
 * 万一（比如接了一条本地抛出的异常），正常情况下走到 `message` 就返回了。
 */
export function describeGithubError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { kind?: unknown; message?: unknown }
    if (typeof maybe.message === 'string' && typeof maybe.kind === 'string') return maybe.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}

export interface GithubHandlers {
  /** 第几个 / 共几个文件。第一份一定带着 `filesDone = 0`。 */
  onProgress: (taskId: string, progress: GithubProgress) => void
  /** 正常结束（含用户取消）。之后这个 taskId 不会再有事件。 */
  onDone: (taskId: string, summary: GithubSummary) => void
  /** 预检之后失败（含冲突）。也要当终止处理。 */
  onFailed: (taskId: string, error: GithubError) => void
}

/**
 * 挂上三个同步事件的监听器，返回一个能一次注销掉三个的函数。
 *
 * ⚠️ **必须在第一次 `startGithubSync` 之前挂好，而且要挂着不放**——`listen` 本身是
 * 异步的，而 `github_sync_dir` 是先 spawn 后台任务再返回 taskId 的。注册之前到达的事件
 * 永久丢失，丢的是最前面那几份进度，表现是「同步中… 一直停在 0/N」，而后台其实已经
 * 拉/推完了好几个文件。与 `attachWereadListeners` 逐字同一条理由。
 */
export async function attachGithubListeners(handlers: GithubHandlers): Promise<UnlistenFn> {
  const [unProgress, unDone, unFailed] = await Promise.all([
    listen<ProgressPayload>(GITHUB_PROGRESS_EVENT, (e) => handlers.onProgress(e.payload.taskId, e.payload.progress)),
    listen<DonePayload>(GITHUB_DONE_EVENT, (e) => handlers.onDone(e.payload.taskId, e.payload.summary)),
    listen<FailedPayload>(GITHUB_FAILED_EVENT, (e) => handlers.onFailed(e.payload.taskId, e.payload.error)),
  ])
  return () => {
    unProgress()
    unDone()
    unFailed()
  }
}
