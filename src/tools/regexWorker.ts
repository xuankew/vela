/**
 * 正则测试器的 worker 入口（由 `regexRunner.ts` 的 `spawnRealWorker` 起）。
 *
 * 🔴 里面**只有胶水**：收一份 `RegexJob`、调**同一个** `regexReport`、把结果发回去。
 * 算法一个字都不在这里——它与主线程兜底那条路（`fallbackSync`）跑的是同一份纯函数，
 * 于是「换到 worker 上结果就变了」这种事在结构上写不出来。
 *
 * ⚠️ 这一份在**另一个全局**里：没有 `window`、没有 DOM，`self` 是 `DedicatedWorkerGlobalScope`。
 * tsconfig 的 lib 里没有 `WebWorker`，所以这里把 `self` 收窄成一个只含用得到的两件事的形状，
 * 而不是去引一份新 lib（那会让主线程那半边也能 accidentally 摸到 worker-only 的 API）
 */

import { regexReport } from './regex'
import type { RegexJob } from './regexRunner'
import type { ToolResult } from './tool'

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<RegexJob>) => void) | null
  postMessage: (result: ToolResult) => void
}

ctx.onmessage = (event) => {
  const job = event.data
  // ⚠️ `regexReport` 按约定不抛（它把语法错、坏标志都返回成 `{ kind: 'error' }`）。
  // 真抛了也不能让 worker 静默死掉——那会表现为「主线程永远等不到消息，直到 deadline」。
  // 兜一层，把意外如实报回去，主线程立刻结算，不必白等两秒
  let result: ToolResult
  try {
    result = regexReport(job.input, job.pattern, job.flags, job.replacement, job.mode)
  } catch (err) {
    result = { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
  ctx.postMessage(result)
}
