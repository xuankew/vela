// @vitest-environment jsdom
import { undo } from '@codemirror/commands'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorController, type EditorUpdateInfo } from './controller'

let host: HTMLElement

/**
 * 换行是否生效，读 state 上的 facet 而不是 `view.lineWrapping`：
 * 后者读的是 heightOracle，只在 measure 阶段刷新，而 jsdom 没有真实布局、measure 跑不动。
 */
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
    const c = new EditorController(host, { doc: '第一行\n第二行\n第三行' })
    expect(c.doc).toBe('第一行\n第二行\n第三行')
    expect(c.lines).toBe(3)
    expect(c.chars).toBe(11)
    c.destroy()
  })

  it('lineWrap 选项真的落到视图，而不只是缓存字段', () => {
    const on = new EditorController(host, { lineWrap: true })
    expect(wrapEnabled(on.view)).toBe(true)
    on.destroy()

    const off = new EditorController(host, { lineWrap: false })
    expect(wrapEnabled(off.view)).toBe(false)
    off.destroy()
  })
})

describe('setLineWrap（Compartment 重配）', () => {
  it('切换后 view.lineWrapping 跟着变，选区不丢', () => {
    const c = new EditorController(host, { doc: 'alpha\nbeta\ngamma', lineWrap: true })
    c.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(7)]) })

    c.setLineWrap(false)
    expect(c.lineWrap).toBe(false)
    expect(wrapEnabled(c.view)).toBe(false)
    expect(c.view.state.selection.main.head).toBe(7)

    c.setLineWrap(true)
    expect(wrapEnabled(c.view)).toBe(true)
    expect(c.view.state.selection.main.head).toBe(7)
    c.destroy()
  })

  it('传入相同值时不派发事务（state 对象保持同一个）', () => {
    const c = new EditorController(host, { lineWrap: true })
    const before = c.view.state
    c.setLineWrap(true)
    expect(c.view.state).toBe(before)
    c.destroy()
  })

  it('setDoc 之后仍保留当前换行设置', () => {
    const c = new EditorController(host, { doc: 'a', lineWrap: true })
    c.setLineWrap(false)
    c.setDoc('换了一篇文档')
    expect(c.lineWrap).toBe(false)
    expect(wrapEnabled(c.view)).toBe(false)
    c.destroy()
  })
})

describe('setDoc（换文档）', () => {
  it('整篇替换，并且不带入上一篇的撤销历史', () => {
    const c = new EditorController(host, { doc: '旧文档' })
    c.view.dispatch({ changes: { from: 0, to: 3, insert: '改过的旧文档' } })
    expect(undo(c.view)).toBe(true)
    expect(c.doc).toBe('旧文档')

    c.setDoc('新文档\n第二行')
    expect(c.doc).toBe('新文档\n第二行')
    expect(c.lines).toBe(2)
    // 关键不变量：Cmd+Z 不能把上一个文件的内容拉回来
    expect(undo(c.view)).toBe(false)
    expect(c.doc).toBe('新文档\n第二行')
    c.destroy()
  })

  it('换文档后 onUpdate 报告新的行数与字符数（否则状态栏会停在上一个文件）', () => {
    const onUpdate = vi.fn()
    const c = new EditorController(host, { doc: 'a', onUpdate })
    onUpdate.mockClear()

    c.setDoc('一二三\n四五六\n七八九')
    const last = onUpdate.mock.calls.at(-1)?.[0] as EditorUpdateInfo | undefined
    expect(last).toBeDefined()
    expect(last?.lines).toBe(3)
    expect(last?.chars).toBe(11)
    c.destroy()
  })
})

describe('onUpdate 回调边界', () => {
  it('文档变更时回调，带上新的度量', () => {
    const onUpdate = vi.fn()
    const c = new EditorController(host, { doc: 'abc', onUpdate })
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
    const c = new EditorController(host, { doc: 'abc', onUpdate })
    c.view.dispatch({})
    expect(onUpdate).not.toHaveBeenCalled()
    c.destroy()
  })

  it('选区变化也回调，因为状态栏要显示行列', () => {
    const onUpdate = vi.fn()
    const c = new EditorController(host, { doc: 'abc', onUpdate })
    c.view.dispatch({ selection: EditorSelection.cursor(2) })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ docChanged: false, selectionChanged: true })
    c.destroy()
  })
})

describe('destroy', () => {
  it('销毁后再操作会抛错，且重复销毁是安全的', () => {
    const c = new EditorController(host, { doc: 'x' })
    c.destroy()
    expect(() => c.destroy()).not.toThrow()
    expect(() => c.setDoc('y')).toThrow(/已销毁/)
    expect(() => c.setLineWrap(false)).toThrow(/已销毁/)
    expect(() => c.focus()).toThrow(/已销毁/)
  })

  it('销毁后 DOM 里的编辑器被摘掉', () => {
    const c = new EditorController(host, { doc: 'x' })
    expect(host.querySelector('.cm-editor')).not.toBeNull()
    c.destroy()
    expect(host.querySelector('.cm-editor')).toBeNull()
  })
})
