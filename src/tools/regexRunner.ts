/**
 * 正则测试器的**执行外壳**：把 `regex.ts` 那份纯活挪到 UI 线程之外去跑，并且给它一个截止时间。
 *
 * ## 为什么必须有这一层（而不是在 `run` 里加个 `setTimeout`）
 *
 * 灾难性回溯（`(a+)+$` 撞上一长串 `aaaa…X`）的失败方式不是「慢」，是**同步地把 UI 线程占死**：
 * `re.exec` 是一个不让出的循环，主线程上一个 `setTimeout` 回调**永远排不进去**——
 * 于是「加个超时」这件事在主线程上根本写不出来。唯一的解法是把 `exec` 丢到另一个线程，
 * 让主线程始终腾得出手，到点了就 `terminate()` 掉那个 worker。
 *
 * 🔴 所以 worker 与 deadline 是**一体**的：deadline 负责「决定放弃」，worker 负责「使得放弃办得到」。
 * 只有 deadline 没有 worker = 一句永远触发不了的定时器；只有 worker 没有 deadline = 卡死换了个核而已
 * （那一核照样烧到进程结束，用户照样等不到输出）。
 *
 * ## ⛔ 这一层不认识 Solid、不认识面板、也不改 `regex.ts` 一个字
 *
 * `regexReport` 仍是那个能被单测直接钉住的纯函数（`regex.test.ts` 原样不动）。这一层只负责
 * 「在哪个线程上跑它、跑多久放弃、放弃了怎么措辞」。于是三件最容易写错的事——
 * **到点中断**、**换一次输入就掐掉上一次在飞的**、**worker 起不来时如实退回主线程**——
 * 都能在 node 环境里用假的 `spawn` 与假的时钟穷举，不必挂真的 `Worker`（jsdom/node 里它压根不存在）。
 */

import { domTimer, type Timer } from '../ui/timer'
import { regexReport, type RegexMode } from './regex'
import type { ToolResult } from './tool'

/** 一次运行需要的全部输入。⚠️ 是**已经收窄好**的参数，与 `regexReport` 的五个形参逐一对应 */
export interface RegexJob {
  readonly input: string
  readonly pattern: string
  readonly flags: string
  readonly replacement: string
  readonly mode: RegexMode
}

/**
 * 起一个能跑一份 `RegexJob` 的东西。产出一个结果就调 `settle`（**至多一次**），
 * 返回一个「掐掉它」的函数。
 *
 * 🔴 抽成一个函数而不是直接写 `new Worker`：真的 worker 在测试环境里不存在，
 * 而这一层的全部难点（中断 / 取消 / 兜底）都与「worker 具体怎么起」无关。
 * 把它做成注入点，难点就能被单测钉住，真的那一份只剩三行胶水（见文件末尾 `spawnRealWorker`）
 */
export type SpawnRegexWorker = (job: RegexJob, settle: (result: ToolResult) => void) => () => void

/**
 * 一次运行最多等多久。
 *
 * ⚠️ 正常的正则在一份一百万字的输入上也是**几十毫秒**量级（`collectMatches` 走单趟），
 * 所以 2 秒对合法输入宽得用不完；而灾难性回溯是**指数级**的，2 秒足够把它与「合法但重」区分开。
 * 这段时间里 UI 是**responsive** 的（活在别的核上），代价只是用户多等两秒看到一句「已中断」
 */
export const REGEX_DEADLINE_MS = 2000

/** 到点还没出结果时给的那一句。🔴 要说清「很可能是灾难性回溯」并给一个能做的动作，⛔ 不是干巴巴一句 timeout */
export function timeoutResult(deadlineMs: number): ToolResult {
  return {
    kind: 'error',
    text:
      `这个正则跑了超过 ${deadlineMs}ms 还没出结果，已经中断——很可能是灾难性回溯` +
      `（例如 (a+)+$ 撞上一长串相同字符）。试着收紧重复、或给量词加个上界。`,
  }
}

export interface RegexRunner {
  /** 跑一次。⚠️ 总是异步的（哪怕兜底那条同步路径也用 Promise 包起来，好让调用方只有一种口径） */
  run(job: RegexJob): Promise<ToolResult>
  /** 掐掉在飞的那一次（面板关掉、切工具时用）。没有在飞的就是空操作 */
  cancel(): void
}

export interface RegexRunnerDeps {
  readonly spawn: SpawnRegexWorker
  readonly timer: Timer
  /** 缺省 `REGEX_DEADLINE_MS` */
  readonly deadlineMs?: number
  /**
   * `spawn` 抛异常时的兜底：在**当前线程**上直接跑一遍。
   *
   * ⚠️ 这一支会卡（正是这一层想避免的），但它换的是「有没有结果」：某些引擎若不支持 module worker，
   * `new Worker` 会当场抛，那时如实退回主线程跑一次，比让用户看见「点了没反应」强。
   * 生产那一份就是 `regexReport` 本身
   */
  readonly fallback: (job: RegexJob) => ToolResult
}

/** 一次在飞的运行的全部可变态。挂在闭包里，`settle` 靠 `rec.settled` 保证「至多结算一次」 */
interface Active {
  terminate: () => void
  deadlineId: number | null
  settled: boolean
  resolve: (result: ToolResult) => void
}

export function createRegexRunner(deps: RegexRunnerDeps): RegexRunner {
  const timer = deps.timer
  const deadlineMs = deps.deadlineMs ?? REGEX_DEADLINE_MS
  let active: Active | null = null

  /**
   * 结算一次运行：作废它的截止时间、掐掉它的 worker、把结果交出去。
   *
   * 🔴 `rec.settled` 那道闸是**唯一**的真相：worker 的结果、截止时间、以及「被下一次运行顶掉」
   * 三条路都会调它，而它们可能乱序到达（例如 worker 在 `terminate()` 之后还挤进来一条消息）。
   * 少了这道闸，一次运行会 resolve 两次——第二次是静默的，但它会把 `active` 指到别的运行上
   */
  function settle(rec: Active, result: ToolResult): void {
    if (rec.settled) return
    rec.settled = true
    if (rec.deadlineId !== null) timer.cancel(rec.deadlineId)
    if (active === rec) active = null
    rec.terminate()
    rec.resolve(result)
  }

  function run(job: RegexJob): Promise<ToolResult> {
    // 🔴 起新的之前先掐掉在飞的那一个：连着打字时，上一个灾难性回溯的 worker 不该继续占着一个核
    // 跑到它自己的 deadline。store 那边用序号丢弃陈旧结果，但**丢弃**不等于**停止计算**——
    // 那台 worker 还在烧 CPU。这里的取消才真的让它停
    if (active !== null) settle(active, { kind: 'error', text: '已被新的运行取代' })

    return new Promise<ToolResult>((resolve) => {
      // ⚠️ 先把 rec 立起来、`active` 指过去，**再**调 spawn：spawn 允许同步 settle
      // （假的 worker、或缓存命中），那时 `active` 必须已经是这一个 rec，否则结果会被丢弃
      const rec: Active = { terminate: () => {}, deadlineId: null, settled: false, resolve }
      active = rec

      let terminate: () => void
      try {
        terminate = deps.spawn(job, (result) => settle(rec, result))
      } catch {
        // worker 连构造都失败：退回当前线程跑一次。这一支会卡，但它是「有没有结果」的取舍
        settle(rec, deps.fallback(job))
        return
      }
      rec.terminate = terminate
      // spawn 已经同步结算过了（少见但合法）：别再排一个永远用不上的截止时间
      if (rec.settled) {
        terminate()
        return
      }
      rec.deadlineId = timer.after(() => settle(rec, timeoutResult(deadlineMs)), deadlineMs)
    })
  }

  return {
    run,
    cancel() {
      if (active !== null) settle(active, { kind: 'error', text: '已取消' })
    },
  }
}

/**
 * 生产那一份的 spawn：一个 vite 的 module worker。
 *
 * 🔴 `new URL('./regexWorker.ts', import.meta.url)` 是 vite 认得的写法，构建时会把那个文件
 * 单独打成一个 worker chunk。⚠️ worker 里的活是**同一个** `regexReport`——两边跑的是同一份代码，
 * 只是换了个线程，于是「worker 版与主线程版结果不一样」这种事在结构上写不出来
 */
function spawnRealWorker(job: RegexJob, settle: (result: ToolResult) => void): () => void {
  // 🔴 先探 `Worker` 在不在：node 的单测环境里没有 Web Worker（有一个同名的 `worker_threads.Worker`
  // 也不是这个东西，拿它去加载一份 `.ts` 只会以另一种方式炸）。缺它就**抛**，让 `run` 走 `fallback`
  // 那条如实退回主线程的路——于是描述符层的用例在任何环境下都拿到确定的一份结果
  if (typeof Worker !== 'function') throw new Error('这个环境没有 Web Worker')
  const worker = new Worker(new URL('./regexWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent) => settle(event.data as ToolResult)
  // worker 自己出错（脚本加载失败等）：如实报一条，⛔ 不让这次运行永远悬着
  worker.onerror = () => settle({ kind: 'error', text: '正则工作进程出错了' })
  worker.postMessage(job)
  return () => worker.terminate()
}

function fallbackSync(job: RegexJob): ToolResult {
  return regexReport(job.input, job.pattern, job.flags, job.replacement, job.mode)
}

let singleton: RegexRunner | null = null

/**
 * 全应用共用的那一个 runner。
 *
 * ⚠️ 懒建，但**不是**为了躲 `window`：`domTimer` 与 `spawnRealWorker` 里那些引用只在**被调用时**
 * 才碰到 `window` / `Worker`，而构造一个 runner 谁都不调。真正的原因是「只测描述符」的那些用例
 * （`builtin.test.ts` 在 node 环境里跑）压根不该在 import 阶段就建出一个带着 worker 胶水的单例——
 * 建它没有任何坏处，但也没必要。第一次真的跑正则时它必然在有 `window` 与 `Worker` 的环境里
 */
export function regexRunner(): RegexRunner {
  if (singleton === null) {
    singleton = createRegexRunner({ spawn: spawnRealWorker, timer: domTimer, fallback: fallbackSync })
  }
  return singleton
}
