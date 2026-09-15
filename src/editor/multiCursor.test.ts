import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Platform } from '../commands/keybinding'
import { clickAddsCursor, isColumnSelectDrag, selectAllOccurrences, type MouseButtonFields } from './multiCursor'

/** 四个修饰键与按键号都必须显式给值：`undefined` 参与 `&&` 会得到 undefined 而不是 false */
function mouse(button = 0, mods: Partial<Omit<MouseButtonFields, 'button'>> = {}): MouseButtonFields {
  return { button, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods }
}

describe('列块选择的触发条件', () => {
  it('必须 Option+Shift+左键三者齐备', () => {
    expect(isColumnSelectDrag(mouse(0, { altKey: true, shiftKey: true }))).toBe(true)
  })

  it('只有 Option 不算——那一下是「加光标」', () => {
    expect(isColumnSelectDrag(mouse(0, { altKey: true }))).toBe(false)
  })

  it('只有 Shift 不算——那一下是「扩展当前选区」', () => {
    expect(isColumnSelectDrag(mouse(0, { shiftKey: true }))).toBe(false)
  })

  it('右键与中键不算，右键要留给上下文菜单', () => {
    expect(isColumnSelectDrag(mouse(2, { altKey: true, shiftKey: true }))).toBe(false)
    expect(isColumnSelectDrag(mouse(1, { altKey: true, shiftKey: true }))).toBe(false)
  })
})

describe('Option+Click 加光标', () => {
  it('macOS：Option+单击加光标，Option+Shift+单击让给列块选择', () => {
    expect(clickAddsCursor(mouse(0, { altKey: true }), 'macos')).toBe(true)
    expect(clickAddsCursor(mouse(0, { altKey: true, shiftKey: true }), 'macos')).toBe(false)
  })

  it('macOS：Cmd+单击仍然加光标——facet 一注册就完全接管，这条默认必须自己实现', () => {
    expect(clickAddsCursor(mouse(0, { metaKey: true }), 'macos')).toBe(true)
    // Ctrl 在 macOS 上不是 CM6 的默认加光标键（那是留给右键语义的）
    expect(clickAddsCursor(mouse(0, { ctrlKey: true }), 'macos')).toBe(false)
  })

  it('非 macOS：Ctrl+单击加光标，Win 键不算', () => {
    for (const platform of ['linux', 'windows'] as Platform[]) {
      expect(clickAddsCursor(mouse(0, { ctrlKey: true }), platform)).toBe(true)
      expect(clickAddsCursor(mouse(0, { metaKey: true }), platform)).toBe(false)
      expect(clickAddsCursor(mouse(0, { altKey: true }), platform)).toBe(true)
      expect(clickAddsCursor(mouse(0, { altKey: true, shiftKey: true }), platform)).toBe(false)
    }
  })

  it('不带任何修饰键的普通单击绝不加光标，否则点一下就多一个光标', () => {
    for (const platform of ['macos', 'linux', 'windows'] as Platform[]) {
      expect(clickAddsCursor(mouse(0), platform)).toBe(false)
    }
  })

  it('不变式：命中列块选择的那一下必然不是「加光标」，两个手势不可能同时抢一次按下', () => {
    for (const platform of ['macos', 'linux', 'windows'] as Platform[]) {
      for (const button of [0, 1, 2]) {
        const e = mouse(button, { altKey: true, shiftKey: true })
        if (isColumnSelectDrag(e)) expect(clickAddsCursor(e, platform)).toBe(false)
      }
    }
  })
})

describe('selectAllOccurrences', () => {
  /**
   * 最小假 view。`selectAllOccurrences` 与 CM6 的 `selectSelectionMatches` 都只用
   * `{ state, dispatch }`，而 `EditorState.update()` 同时接受 TransactionSpec 与 Transaction，
   * 所以一个 `current.update(spec)` 就把两种 dispatch 都接住了，不需要 jsdom。
   */
  function editor(doc: string, ranges: [number, number][]) {
    let current = EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.map(([from, to]) => EditorSelection.range(from, to))),
      // 同 lineOps.test.ts：不给这一条，多选区会被静默塌成主选区，下面几个用例全会假通过
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })
    const view = {
      get state() {
        return current
      },
      dispatch: (spec: TransactionSpec) => {
        // update() 返回 Transaction，不是新 state
        current = current.update(spec).state
      },
    } as unknown as EditorView
    return {
      view,
      run: () => selectAllOccurrences(view),
      selected: () => current.selection.ranges.map((r) => current.sliceDoc(r.from, r.to)),
    }
  }

  //  'foo bar foo baz foo'
  //   0123456789…  三处 foo 分别在 0 / 8 / 16
  const DOC = 'foo bar foo baz foo'

  it('单一非空选区：一次选中全部三处', () => {
    const e = editor(DOC, [[0, 3]])
    expect(e.run()).toBe(true)
    expect(e.selected()).toEqual(['foo', 'foo', 'foo'])
  })

  it('Cmd+D 按过几下之后再按，仍然能一次全要——这正是 CM6 原生会拒绝的死路', () => {
    const e = editor(DOC, [
      [0, 3],
      [8, 11],
    ])
    expect(e.run()).toBe(true)
    expect(e.selected()).toEqual(['foo', 'foo', 'foo'])
  })

  it('各选区文本不同时拒绝：不能悄悄按其中一个把用户其余光标全替换掉', () => {
    const e = editor(DOC, [
      [0, 3],
      [4, 7],
    ])
    expect(e.run()).toBe(false)
    expect(e.selected()).toEqual(['foo', 'bar'])
  })

  it('多光标但都是空选区时拒绝——没有「相同内容」可言', () => {
    const e = editor(DOC, [
      [0, 0],
      [4, 4],
    ])
    expect(e.run()).toBe(false)
    expect(e.selected()).toEqual(['', ''])
  })

  it('单一空选区时拒绝，不会把整篇文档选中', () => {
    const e = editor(DOC, [[0, 0]])
    expect(e.run()).toBe(false)
    expect(e.selected()).toEqual([''])
  })
})
