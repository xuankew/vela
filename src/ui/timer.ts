/**
 * 一个可注入的定时器 + 它上面那个防抖器（M3-B-1 从 `src/md/panel.ts` 搬过来）。
 *
 * ## 为什么搬
 *
 * 它原先住在 `md/panel.ts`，而那时只有一个消费者家族（Markdown 的预览与大纲）。
 * 工具箱是第二个：改一个字要防抖 150ms 再跑一次，与「改一段正文要防抖 150ms 再重解析」
 * 是同一件事。让 `tools/store.ts` 从 `md/panel.ts` import 一个防抖器，等于让**工具**这一层
 * 依赖 **Markdown** 那一层，而它们毫无关系；更要紧的是 M3-C 要把 `md/*` 圈进懒加载块，
 * 那条 import 会把 `md/panel.ts` 拽回首屏，而理由只是「借一个 setTimeout 包装」。
 *
 * ⛔ 搬完**不在 `md/panel.ts` 里留 re-export**：留一份的话「哪一个才是真的」就有两个答案，
 * 而下一个人会照着近的那一个 import，于是这条边又长回来了。
 *
 * ## 这一层没有 Solid、没有 DOM（除了 `domTimer` 那两行）
 *
 * 于是「连着排三次只跑一次」「cancel 之后那一次永远不跑」这些能被单测直接穷举，
 * 不必挂 jsdom、也不必去冻全局时钟。
 */

/** 定时器可注入。与 `src/doc/sessionSync.ts` 的 `Scheduler` 同一条理由：测试不碰真时钟 */
export interface Timer {
  readonly after: (fn: () => void, ms: number) => number
  readonly cancel: (id: number) => void
}

/** 浏览器里的那一份。`window.` 前缀是必要的：不带它拿到的是 node 的全局，类型也对不上 */
export const domTimer: Timer = {
  after: (fn, ms) => window.setTimeout(fn, ms),
  cancel: (id) => window.clearTimeout(id),
}

export interface Debounced {
  /**
   * 排一次。已经有在飞的那一次就把定时器**重置**——这是「防抖」与「节流」的分界，
   * 而这里要的是防抖：连续打字时一次都不该跑，停下来才跑
   */
  schedule: () => void
  /** 立刻跑，并丢掉在飞的那一次。面板刚打开／切了文档时用，见 `md/panel.ts` 的 `createPanelRefresh` */
  now: () => void
  cancel: () => void
}

/**
 * 一个防抖器。
 *
 * 写成独立的一小块而不是在调用方直接 `setTimeout` / `clearTimeout`：那两行散在 effect 里
 * 的话，「卸载时要把在飞的定时器取消掉」这件事就没有一个地方负责了——
 * 而漏掉它的症状很具体：面板关掉 150ms 之后那个回调还在跑，往一个已经从 DOM 上
 * 摘下来的节点里写东西，Solid 那边的 owner 也早就 dispose 了。
 *
 * ⚠️ 延时是**参数**，不是常量：`md/panel.ts` 用 150ms（`PANEL_DEBOUNCE_MS`），
 * `tools/store.ts` 用它自己那一个。两个数今天相等，而它们答的是两个不同的问题
 * （「重解析一次多贵」与「跑一次工具多贵」），共用一个常量的话改一个会顺手改掉另一个
 */
export function createDebounced(timer: Timer, delayMs: number, run: () => void): Debounced {
  let pending: number | null = null

  function clear() {
    if (pending !== null) timer.cancel(pending)
    pending = null
  }

  return {
    schedule() {
      clear()
      pending = timer.after(() => {
        pending = null
        run()
      }, delayMs)
    },
    now() {
      clear()
      run()
    },
    cancel: clear,
  }
}
