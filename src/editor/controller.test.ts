// @vitest-environment jsdom
import { undo } from '@codemirror/commands'
import { Compartment, EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorController } from './controller'
import { createEditorState, type EditorUpdateInfo } from './setup'

let host: HTMLElement

/**
 * 一个可复用的换行槽位。
 *
 * 真实应用里它由 workspace 持有、被所有标签共享（见 src/doc/tab.ts 的 ViewConfig）；
 * 这里每个用例自己造一个就够。
 */
function makeSlot() {
  return new Compartment()
}

function stateFor(doc = '', lineWrap = true, slot = makeSlot(), onUpdate?: (info: EditorUpdateInfo) => void) {
  return createEditorState({ doc, lineWrap, markdownMode: true, lineWrapSlot: slot, onUpdate })
}

function wrapEnabled(view: EditorView): boolean {
  return view.state
    .facet(EditorView.contentAttributes)
    .some((attrs) => typeof attrs !== 'function' && attrs.class === 'cm-lineWrapping')
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

describe('EditorController 文档度量', () => {
  it('构造后暴露 doc / lines / chars', () => {
    const c = new EditorController(host, stateFor('第一行\n第二行\n第三行'))
    expect(c.doc).toBe('第一行\n第二行\n第三行')
    expect(c.lines).toBe(3)
    expect(c.chars).toBe(11)
    c.destroy()
  })

  it('传进来的 state 原样成为 view.state，中间不做任何加工', () => {
    const state = stateFor('alpha')
    const c = new EditorController(host, state)
    expect(c.view.state).toBe(state)
    c.destroy()
  })

  it('lineWrap 读的是当前 state 的 facet，而不是构造时的缓存', () => {
    const on = new EditorController(host, stateFor('', true))
    expect(on.lineWrap).toBe(true)
    expect(wrapEnabled(on.view)).toBe(true)
    on.destroy()

    const off = new EditorController(host, stateFor('', false))
    expect(off.lineWrap).toBe(false)
    expect(wrapEnabled(off.view)).toBe(false)
    off.destroy()
  })

  it('restore 之后 lineWrap 跟着新 state 走——它是查询，不是设置', () => {
    // 这条是 M1-D 的硬要求：换行偏好属于标签，切换标签时读到的必须是**新标签**的值。
    // 之前 controller 自己缓存一个 wrap 字段，restore 之后缓存就成了谎话，
    // 而 editor.toggleLineWrap 正是拿它决定往哪边切。
    const slot = makeSlot()
    const c = new EditorController(host, stateFor('', true, slot))
    const wrapped = c.capture()

    c.view.dispatch({ effects: slot.reconfigure([]) })
    expect(c.lineWrap).toBe(false)

    c.restore(wrapped)
    expect(c.lineWrap).toBe(true)
    c.destroy()
  })
})

describe('capture / restore（标签切换的地基）', () => {
  it('取走的快照装回去，正文、选区、滚动位置一样不少', () => {
    const c = new EditorController(host, stateFor('alpha\nbeta\ngamma'))
    c.view.dispatch({ selection: EditorSelection.cursor(9) })
    c.view.scrollDOM.scrollTop = 42
    c.view.scrollDOM.scrollLeft = 7

    const snap = c.capture()
    expect(snap.state.doc.toString()).toBe('alpha\nbeta\ngamma')
    expect(snap.scrollTop).toBe(42)
    expect(snap.scrollLeft).toBe(7)

    c.restore({ state: stateFor('别的文档'), scrollTop: 0, scrollLeft: 0 })
    c.restore(snap)
    expect(c.doc).toBe('alpha\nbeta\ngamma')
    expect(c.view.state.selection.main.head).toBe(9)
    expect(c.view.scrollDOM.scrollTop).toBe(42)
    expect(c.view.scrollDOM.scrollLeft).toBe(7)
    c.destroy()
  })

  it('装回的是快照里那个 state 对象本身，不是内容相同的新 state', () => {
    const c = new EditorController(host, stateFor('x'))
    const snap = c.capture()
    c.restore({ state: stateFor('y'), scrollTop: 0, scrollLeft: 0 })
    c.restore(snap)
    expect(c.view.state).toBe(snap.state)
    c.destroy()
  })

  it('两个标签来回切，各自的正文与撤销历史互不污染', () => {
    const c = new EditorController(host, stateFor('A 的正文'))
    c.view.dispatch({ changes: { from: 0, to: 0, insert: 'A 加的' } })
    const tabA = c.capture()

    c.restore({ state: stateFor('B 的正文'), scrollTop: 0, scrollLeft: 0 })
    c.view.dispatch({ changes: { from: 0, to: 0, insert: 'B 加的' } })
    const tabB = c.capture()
    expect(c.doc).toBe('B 加的B 的正文')

    c.restore(tabA)
    expect(c.doc).toBe('A 加的A 的正文')
    // 撤销历史属于 state：切到 A 时 Cmd+Z 只能撤 A 自己的改动
    expect(undo(c.view)).toBe(true)
    expect(c.doc).toBe('A 的正文')

    c.restore(tabB)
    expect(c.doc).toBe('B 加的B 的正文')
    expect(undo(c.view)).toBe(true)
    expect(c.doc).toBe('B 的正文')
    c.destroy()
  })

  it('快照是那一瞬间的 state：capture 之后继续编辑不会反过来改掉它', () => {
    const c = new EditorController(host, stateFor('原文'))
    const snap = c.capture()
    c.view.dispatch({ changes: { from: 2, insert: '追加' } })
    expect(snap.state.doc.toString()).toBe('原文')
    expect(c.doc).toBe('原文追加')
    c.destroy()
  })

  it('销毁后 capture / restore 都抛错', () => {
    const c = new EditorController(host, stateFor('x'))
    const snap = c.capture()
    c.destroy()
    expect(() => c.capture()).toThrow(/已销毁/)
    expect(() => c.restore(snap)).toThrow(/已销毁/)
  })
})

describe('state 里的 onUpdate 是 CM6 → 外部的唯一回路', () => {
  it('文档变更时回调，带上新的度量', () => {
    const onUpdate = vi.fn()
    const c = new EditorController(host, stateFor('abc', true, makeSlot(), onUpdate))
    c.view.dispatch({ changes: { from: 3, insert: '\ndef' } })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toEqual({
      docChanged: true,
      selectionChanged: false,
      lines: 2,
      chars: 7,
    })
    c.destroy()
  })

  it('纯视口/几何类更新不回调（否则每次滚动都会刷状态栏）', () => {
    const onUpdate = vi.fn()
    const c = new EditorController(host, stateFor('abc', true, makeSlot(), onUpdate))
    c.view.dispatch({})
    expect(onUpdate).not.toHaveBeenCalled()
    c.destroy()
  })

  it('选区变化也回调，因为状态栏要显示行列', () => {
    const onUpdate = vi.fn()
    const c = new EditorController(host, stateFor('abc', true, makeSlot(), onUpdate))
    c.view.dispatch({ selection: EditorSelection.cursor(2) })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ docChanged: false, selectionChanged: true })
    c.destroy()
  })

  it('回调属于 state，所以 restore 之后收到通知的是**新标签**的那个', () => {
    // 多标签下这条最容易被忽略：监听器如果挂在 view 上，切标签就得手动改路由。
    // 烘进 state 之后，换 state 就等于换了监听器，压根不存在「通知发错标签」这条路。
    const onA = vi.fn()
    const onB = vi.fn()
    const a = new EditorController(host, stateFor('A', true, makeSlot(), onA))
    const stateB: EditorState = stateFor('B', true, makeSlot(), onB)

    a.restore({ state: stateB, scrollTop: 0, scrollLeft: 0 })
    a.view.dispatch({ changes: { from: 1, insert: '改' } })

    expect(onB).toHaveBeenCalledTimes(1)
    expect(onA).not.toHaveBeenCalled()
    a.destroy()
  })
})

describe('destroy', () => {
  it('销毁后再操作会抛错，且重复销毁是安全的', () => {
    const c = new EditorController(host, stateFor('x'))
    const snap = c.capture()
    c.destroy()
    expect(() => c.destroy()).not.toThrow()
    expect(() => c.restore(snap)).toThrow(/已销毁/)
    expect(() => c.focus()).toThrow(/已销毁/)
  })

  it('销毁后 DOM 里的编辑器被摘掉', () => {
    const c = new EditorController(host, stateFor('x'))
    expect(host.querySelector('.cm-editor')).not.toBeNull()
    c.destroy()
    expect(host.querySelector('.cm-editor')).toBeNull()
  })
})
