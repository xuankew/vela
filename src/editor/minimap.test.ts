import { Compartment, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  minimapEnabled,
  minimapExtension,
  minimapLayout,
  minimapViewport,
  paintMinimap,
  planBars,
  type MinimapBar,
  type MinimapViewport,
  type PaintSink,
} from './minimap'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc })
}

/** 记录调用顺序与参数的假壳：node 环境里没有 canvas，绘制决策只能这样钉 */
function recordingSink(): PaintSink & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    clear: () => calls.push('clear'),
    barStyle: (c) => calls.push(`barStyle:${c}`),
    viewportStyle: (c) => calls.push(`viewportStyle:${c}`),
    bar: (b) => calls.push(`bar:${b.y},${b.h},${b.w}`),
    viewport: (vp) => calls.push(`viewport:${vp.top},${vp.height}`),
  }
}

describe('minimapLayout', () => {
  it('没有行或没有画布时回 1，不除零', () => {
    expect(minimapLayout(0, 300)).toBe(1)
    expect(minimapLayout(10, 0)).toBe(1)
  })

  it('文档比画布矮时封顶 3px 一行', () => {
    expect(minimapLayout(10, 300)).toBe(3)
  })

  it('文档比画布高时一行不足 1px（进聚合模式）', () => {
    expect(minimapLayout(1000, 500)).toBe(0.5)
  })
})

describe('planBars', () => {
  it('空文档没有条形', () => {
    expect(planBars(stateWith(''), 3, 300)).toEqual([])
  })

  it('空白行不画，宽度按字符数占满比例', () => {
    const bars = planBars(stateWith('aaaa\n\nbb'), 3, 300)
    expect(bars).toEqual([
      { y: 0, h: 3, w: 4 / 100 },
      { y: 6, h: 3, w: 2 / 100 },
    ])
  })

  it('超长行封顶 1，不把比例尺压扁', () => {
    const bars = planBars(stateWith('x'.repeat(500)), 3, 300)
    expect(bars[0]!.w).toBe(1)
  })

  it('聚合模式：同一个像素行收多行、宽度取最大', () => {
    const bars = planBars(stateWith('aa\nbbbbbb\n\ncc'), 0.5, 2)
    expect(bars).toEqual([
      { y: 0, h: 1, w: 6 / 100 },
      { y: 1, h: 1, w: 2 / 100 },
    ])
  })

  it('落在画布外的行不画', () => {
    const bars = planBars(stateWith('a\nb\nc\nd'), 3, 6)
    expect(bars.map((b) => b.y)).toEqual([0, 3])
  })
})

describe('minimapViewport', () => {
  it('还没布局时铺满整块画布', () => {
    expect(minimapViewport(0, 100, 0, 50)).toEqual({ top: 0, height: 50 })
  })

  it('视口比画布还高时封顶', () => {
    expect(minimapViewport(0, 900, 100, 50)).toEqual({ top: 0, height: 50 })
  })

  it('顶边夹在画布内：滚到底时矩形底边贴着画布底', () => {
    const vp = minimapViewport(900, 100, 1000, 50)
    expect(vp).toEqual({ top: 45, height: 5 })
  })
})

describe('paintMinimap', () => {
  it('调用顺序是 clear → 条形 → 视口，颜色各设一次', () => {
    const sink = recordingSink()
    const bars: MinimapBar[] = [{ y: 0, h: 3, w: 0.5 }]
    const vp: MinimapViewport = { top: 10, height: 20 }
    paintMinimap(bars, vp, '#aaa', '#bbb', sink)
    expect(sink.calls).toEqual(['clear', 'barStyle:#aaa', 'bar:0,3,0.5', 'viewportStyle:#bbb', 'viewport:10,20'])
  })
})

describe('minimapEnabled 与槽位', () => {
  it('没装扩展时为 false', () => {
    expect(minimapEnabled(stateWith('x'))).toBe(false)
  })

  it('装了 minimapExtension 为 true，槽位换成空数组回 false', () => {
    const slot = new Compartment()
    const state = EditorState.create({ doc: 'x', extensions: [slot.of(minimapExtension())] })
    expect(minimapEnabled(state)).toBe(true)
    const off = state.update({ effects: slot.reconfigure([]) }).state
    expect(minimapEnabled(off)).toBe(false)
    const on = off.update({ effects: slot.reconfigure(minimapExtension()) }).state
    expect(minimapEnabled(on)).toBe(true)
  })
})
