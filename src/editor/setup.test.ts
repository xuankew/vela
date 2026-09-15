import { Compartment, EditorState } from '@codemirror/state'
import { getSearchQuery } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { buildExtensions, createEditorState } from './setup'

/**
 * 扩展集的几条「错了也不会报错，只会让功能静默失效」的不变式。
 *
 * 只建 `EditorState` 不建 `EditorView`：这些断言读的都是 facet，视图插件在 state 阶段
 * 不会被实例化，所以 node 环境就够（不必拖 jsdom 进来）。
 */
function stateFor(lineWrap = true) {
  return EditorState.create({
    doc: '',
    extensions: buildExtensions({ lineWrap, markdownMode: true, lineWrapSlot: new Compartment() }),
  })
}

/**
 * 换行是否生效，读 state 上的 facet 而不是 `view.lineWrapping`：
 * 后者读的是 heightOracle，只在 measure 阶段刷新，而这里压根没有 view。
 */
function wrapEnabled(state: EditorState): boolean {
  return state
    .facet(EditorView.contentAttributes)
    .some((attrs) => typeof attrs !== 'function' && attrs.class === 'cm-lineWrapping')
}

describe('buildExtensions：静默失效类的不变式', () => {
  it('search() 挂上了——少了它 searchState 字段不存在，getSearchQuery 直接抛', () => {
    // 这不是假想：M1-C 之前扩展集里只有 searchKeymap 而没有 search()，查找替换整条是坏的，
    // 只是当时没有任何入口能触发到它，所以既没报错也没被发现。
    expect(() => getSearchQuery(stateFor())).not.toThrow()
    expect(getSearchQuery(stateFor()).valid).toBe(false) // 空查询本来就是无效的
  })

  it('声明为暗色主题——否则 CM6 base theme 的 &dark 规则一条都不生效', () => {
    // 应用整体是暗色的（styles.css：color-scheme: dark、--vela-bg: #1a1b26）。
    // 漏掉这一条不会抛错，只会让光标变黑、gutters 变 #f5f5f5、补全 tooltip 与查找面板变浅底。
    expect(stateFor().facet(EditorView.darkTheme)).toBe(true)
  })

  it('允许多选区——默认是 false，关掉时多光标会被静默塌成主选区', () => {
    expect(stateFor().facet(EditorState.allowMultipleSelections)).toBe(true)
  })
})

describe('createEditorState（M1-D：state 要能脱离 view 独立存活）', () => {
  it('造出来的 state 与 buildExtensions 手工组装的等价：facet 一样齐', () => {
    const slot = new Compartment()
    const state = createEditorState({ doc: '正文', lineWrap: true, markdownMode: true, lineWrapSlot: slot })
    expect(state.doc.toString()).toBe('正文')
    expect(state.facet(EditorView.darkTheme)).toBe(true)
    expect(() => getSearchQuery(state)).not.toThrow()
    expect(wrapEnabled(state)).toBe(true)
  })

  it('调用方的 lineWrapSlot 能在没有 view 的 state 上 reconfigure', () => {
    // 这条是硬前提：标签没被任何分屏显示时，它的换行偏好也得能改，
    // 否则「关掉换行」只对当前看得见的那个标签生效，切过去才发现另一个还是开的。
    const slot = new Compartment()
    const on = createEditorState({ doc: 'x', lineWrap: true, markdownMode: true, lineWrapSlot: slot })
    expect(wrapEnabled(on)).toBe(true)

    const off = on.update({ effects: slot.reconfigure([]) }).state
    expect(wrapEnabled(off)).toBe(false)
    // 只有槽位变了，正文与选区不该被 reconfigure 顺手带走
    expect(off.doc.toString()).toBe('x')

    const backOn = off.update({ effects: slot.reconfigure([EditorView.lineWrapping]) }).state
    expect(wrapEnabled(backOn)).toBe(true)
  })

  it('两个标签各持一个 Compartment 也不会串：槽位是自己的 StateField', () => {
    const slotA = new Compartment()
    const slotB = new Compartment()
    const a = createEditorState({ doc: 'A', lineWrap: true, markdownMode: true, lineWrapSlot: slotA })
    const b = createEditorState({ doc: 'B', lineWrap: true, markdownMode: true, lineWrapSlot: slotB })

    const aOff = a.update({ effects: slotA.reconfigure([]) }).state
    expect(wrapEnabled(aOff)).toBe(false)
    // A 关掉了，B 必须还是开的：串了的话「关换行」会变成全局开关
    expect(wrapEnabled(b)).toBe(true)

    const bOff = b.update({ effects: slotB.reconfigure([]) }).state
    expect(wrapEnabled(bOff)).toBe(false)
    expect(wrapEnabled(aOff)).toBe(false)
    // 各自还能独立打开
    expect(wrapEnabled(aOff.update({ effects: slotA.reconfigure([EditorView.lineWrapping]) }).state)).toBe(true)
    expect(wrapEnabled(bOff)).toBe(false)
  })
})
