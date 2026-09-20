// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebounced, domTimer, type Timer } from './timer'

/**
 * 手动挡的时钟：`Timer` 本来就是注入点，不必去改全局（改了还得记得改回来）。
 *
 * ⚠️ 只有最后那一组 `domTimer` 用例真的冻了 `window.setTimeout`——那是线上走的那一条路，
 * 而它一共两行，值得两条用例把它与「注入的假时钟」区分开
 */
function fakeTimer() {
  let nextId = 1
  const scheduled = new Map<number, () => void>()
  const timer: Timer = {
    after: (fn) => {
      const id = nextId++
      scheduled.set(id, fn)
      return id
    },
    cancel: (id) => {
      scheduled.delete(id)
    },
  }
  return {
    timer,
    /** 把在飞的那一次全部放掉，按排队顺序 */
    fire() {
      const due = [...scheduled.entries()]
      scheduled.clear()
      for (const [, fn] of due) fn()
    },
    pending: () => scheduled.size,
  }
}

describe('createDebounced', () => {
  it('连着排三次只跑一次，而且跑在最后那一次之后', () => {
    const clock = fakeTimer()
    const run = vi.fn()
    const d = createDebounced(clock.timer, 150, run)
    d.schedule()
    d.schedule()
    d.schedule()
    // 防抖与节流的分界就在这儿：节流会跑第一次，防抖一次都不跑
    expect(run).not.toHaveBeenCalled()
    expect(clock.pending()).toBe(1)
    clock.fire()
    expect(run).toHaveBeenCalledOnce()
  })

  it('now() 立刻跑，并丢掉在飞的那一次', () => {
    const clock = fakeTimer()
    const run = vi.fn()
    const d = createDebounced(clock.timer, 150, run)
    d.schedule()
    d.now()
    expect(run).toHaveBeenCalledOnce()
    clock.fire()
    // 换标签时走的是这一条：先立刻渲染新的，再把那次防抖作废。
    // 漏掉「作废」的症状是切过去 150ms 之后又渲染了一遍——同一份内容，
    // 但预览那边 `measure()` 会重量一次锚点表，那一下正好撞上用户开始滚动
    expect(run).toHaveBeenCalledOnce()
  })

  it('cancel() 之后那一次永远不会跑', () => {
    const clock = fakeTimer()
    const run = vi.fn()
    const d = createDebounced(clock.timer, 150, run)
    d.schedule()
    d.cancel()
    clock.fire()
    expect(run).not.toHaveBeenCalled()
  })

  it('没有东西在飞时 cancel() 不去碰时钟', () => {
    const clock = fakeTimer()
    const cancel = vi.fn(clock.timer.cancel)
    const d = createDebounced({ after: clock.timer.after, cancel }, 150, vi.fn())
    d.cancel()
    d.cancel()
    expect(cancel).not.toHaveBeenCalled()
    // 🔴 跑过一次之后再 cancel 也不该碰时钟：那一个 id 已经被 `fire` 消费掉了。
    // 真实的 `clearTimeout` 拿到一个已回收的 id 是静默无害，而拿到一个被复用给
    // 别人的 id 就是取消掉一个完全无关的定时器
    d.schedule()
    clock.fire()
    d.cancel()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('排下去的延时就是传进来的那个数', () => {
    const seen: number[] = []
    const timer: Timer = {
      after: (_fn, ms) => {
        seen.push(ms)
        return seen.length
      },
      cancel: () => {},
    }
    // ⚠️ 42 而不是 150：这一层不认识任何调用方的窗口，用一个个位数一眼看得出它是**穿透**的
    const d = createDebounced(timer, 42, vi.fn())
    d.schedule()
    d.schedule()
    expect(seen).toEqual([42, 42])
  })
})

describe('domTimer', () => {
  beforeEach(() => {
    // ⚠️ 必须窄化 `toFake`：整个冻住的话连 `requestAnimationFrame` 一起没了
    // （同 `src/doc/sessionSync.ts` 那条注释）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('after 真的排到 window.setTimeout 上，到点就跑', () => {
    const run = vi.fn()
    domTimer.after(run, 150)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(run).toHaveBeenCalledOnce()
  })

  it('🔴 cancel 真的把在飞的那一次取消掉', () => {
    const run = vi.fn()
    domTimer.cancel(domTimer.after(run, 150))
    vi.advanceTimersByTime(300)
    expect(run).not.toHaveBeenCalled()
  })
})
