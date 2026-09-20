import { describe, expect, it } from 'vitest'
import { OVERSCAN, visibleWindow } from './virtual'

/**
 * 任取一个行高。
 *
 * ⚠️ 刻意**不**从 `project/tree.ts` import `ROW_HEIGHT`：`visibleWindow` 不认识任何一个
 * 列表的行高，它是必填参数。这里若去 import 树的 22，就会把「共享模块」与「文件树」
 * 重新绑在一起——而那条依赖正是这次抽出来要断掉的
 */
const ROW = 22

describe('visibleWindow：虚拟滚动的窗口算术', () => {
  const VIEWPORT = ROW * 20 // 正好 20 行

  it('零行时什么都不渲染', () => {
    expect(visibleWindow(0, VIEWPORT, 0, ROW)).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 })
  })

  it('停在顶部时从头开始，多渲染 overscan 行', () => {
    const w = visibleWindow(0, VIEWPORT, 500, ROW)
    expect(w.start).toBe(0)
    expect(w.end).toBe(20 + OVERSCAN)
    expect(w.offsetY).toBe(0)
    expect(w.totalHeight).toBe(500 * ROW)
  })

  it('滚到中间：上下各留出 overscan', () => {
    const w = visibleWindow(100 * ROW, VIEWPORT, 500, ROW)
    expect(w.start).toBe(100 - OVERSCAN)
    expect(w.end).toBe(100 + 20 + OVERSCAN)
    expect(w.offsetY).toBe((100 - OVERSCAN) * ROW)
  })

  it('滚到底部时 end 夹到 total', () => {
    const w = visibleWindow((500 - 20) * ROW, VIEWPORT, 500, ROW)
    expect(w.start).toBe(500 - 20 - OVERSCAN)
    expect(w.end).toBe(500)
  })

  it('总行数比一屏还少时全渲染', () => {
    const w = visibleWindow(0, VIEWPORT, 5, ROW)
    expect(w.start).toBe(0)
    expect(w.end).toBe(5)
  })

  it('viewportHeight 为 0 时给出 overscan 行，不是 0 行', () => {
    // jsdom 的 clientHeight 恒为 0，三个组件测试看到的正是这批行；
    // 真实场景是侧边栏被拖到看不见——多 6 个节点没有代价，空白一帧有
    const w = visibleWindow(0, 0, 500, ROW)
    expect(w.start).toBe(0)
    expect(w.end).toBe(OVERSCAN)
  })

  it('负的 scrollTop 与超界的 scrollTop 都夹得住', () => {
    expect(visibleWindow(-1000, VIEWPORT, 500, ROW).start).toBe(0)
    const beyond = visibleWindow(100000 * ROW, VIEWPORT, 500, ROW)
    expect(beyond.start).toBeLessThanOrEqual(500)
    expect(beyond.end).toBeLessThanOrEqual(500)
    expect(beyond.start).toBeLessThanOrEqual(beyond.end)
  })

  it('不整除的视口高度往上取整，不会露出半行空白', () => {
    const w = visibleWindow(0, ROW * 20.5, 500, ROW)
    expect(w.end - w.start).toBe(21 + OVERSCAN)
  })

  it('任意参数下都满足 start ≤ end ≤ total 且 offsetY = start × rowHeight', () => {
    for (const scrollTop of [0, 7, 22, 2199, 2200, 10978, 999999]) {
      for (const total of [0, 1, 19, 20, 21, 500, 100000]) {
        const w = visibleWindow(scrollTop, VIEWPORT, total, ROW)
        expect(w.start).toBeGreaterThanOrEqual(0)
        expect(w.start).toBeLessThanOrEqual(w.end)
        expect(w.end).toBeLessThanOrEqual(total)
        expect(w.offsetY).toBe(w.start * ROW)
        expect(w.totalHeight).toBe(total * ROW)
      }
    }
  })
})

describe('visibleWindow：行高是个参数，不是常量', () => {
  it('同一个滚动位置在 20px 行高下落到另一行', () => {
    // 抽出共享模块的**全部意义**就在这条上：文件树 22、搜索结果 20、`Cmd+P` 浮层 20，
    // 三处各传各的。行高若还是模块里的默认值，第二与第三个消费者就只能迁就第一个
    const at22 = visibleWindow(220, 200, 500, 22) // 第 10 行
    const at20 = visibleWindow(220, 200, 500, 20) // 第 11 行
    expect(at22.start).toBe(10 - OVERSCAN)
    expect(at20.start).toBe(11 - OVERSCAN)
    expect(at22.totalHeight).toBe(500 * 22)
    expect(at20.totalHeight).toBe(500 * 20)
  })

  it('行高为 0 或负数时什么都不渲染，不除零', () => {
    expect(visibleWindow(0, 200, 500, 0)).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 })
    expect(visibleWindow(0, 200, 500, -22)).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 })
  })

  it('overscan 可以覆盖，默认是 OVERSCAN', () => {
    expect(OVERSCAN).toBe(6)
    expect(visibleWindow(0, 0, 500, ROW, 0).end).toBe(0)
    expect(visibleWindow(0, 0, 500, ROW, 20).end).toBe(20)
  })
})
