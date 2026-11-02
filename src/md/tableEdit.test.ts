// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  tableDeleteColumn,
  tableDeleteRow,
  tableEditKeymap,
  tableEnter,
  tableInsertColumnRight,
  tableInsertRowBelow,
  tableNextCell,
  tableLayoutAt,
} from './tableEdit'

/**
 * 与 `table.test.ts` 同一条规矩：用**真的** `markdownLanguage.parser`。
 * 这一层所有会咬人的细节（空单元格没有节点、表头/分隔行的列数必须一致、引用里的
 * `> ` 不在行节点范围里）都出在树的真实形状上，手搓的假树只会证明「实现对了我以为的形状」。
 */
const DOC = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')

function stateOf(doc: string, cursor = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), tableEditKeymap],
  })
}

/** 光标放在某个字符**里面**；找不到字符会让测试在定位这一行就红，不会静默落在 0 */
function at(state: EditorState, needle: string): EditorState {
  const index = state.doc.toString().indexOf(needle)
  if (index < 0) throw new Error(`文档里没有 ${needle}`)
  return state.update({ selection: EditorSelection.cursor(index) }).state
}

function apply(state: EditorState, spec: TransactionSpec | null): EditorState | null {
  return spec === null ? null : state.update(spec).state
}

function selectedText(state: EditorState): string {
  const range = state.selection.main
  return state.sliceDoc(range.from, range.to)
}

describe('Tab / Shift-Tab：按视觉顺序跳格', () => {
  it('往右跳一格，选中整格内容', () => {
    const state = at(stateOf(DOC), 'a')
    const next = apply(state, tableNextCell(state, state.selection.main.head, 1))!
    expect(selectedText(next)).toBe('b')
  })

  it('表头最后一格往右跳进第一条数据行，跳过分隔行', () => {
    const state = at(stateOf(DOC), 'b')
    const next = apply(state, tableNextCell(state, state.selection.main.head, 1))!
    expect(selectedText(next)).toBe('1')
  })

  it('第一格往左绕回最后一格', () => {
    const state = at(stateOf(DOC), 'a')
    const next = apply(state, tableNextCell(state, state.selection.main.head, -1))!
    expect(selectedText(next)).toBe('2')
  })

  it('最后一格再往右补一行，光标落在新行第一格', () => {
    const state = at(stateOf(DOC), '2')
    const next = apply(state, tableNextCell(state, state.selection.main.head, 1))!
    expect(next.doc.toString()).toBe(`${DOC}\n|  |  |`)
    expect(next.selection.main.empty).toBe(true)
    expect(next.selection.main.head).toBe(DOC.length + 1 + 2)
  })

  it('不在表格里就交回默认按键', () => {
    const state = stateOf('普通段落')
    expect(tableNextCell(state, 0, 1)).toBeNull()
  })

  it('光标停在行尾竖线之后也算在表里，往右落到下一行第一格', () => {
    const state = at(stateOf(DOC), 'a')
    const end = state.doc.line(1).to
    const moved = state.update({ selection: EditorSelection.cursor(end) }).state
    const next = apply(moved, tableNextCell(moved, end, 1))!
    expect(selectedText(next)).toBe('1')
  })
})

describe('Enter：加行与离表', () => {
  it('表头上按 Enter 加在分隔行下面——也就是第一条数据行', () => {
    const state = at(stateOf(DOC), 'a')
    const next = apply(state, tableEnter(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe('| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |')
    // 光标已经在新增的那一行里
    expect(next.selection.main.head).toBe(next.doc.toString().indexOf('|  |  |') + 2)
  })

  it('数据行上按 Enter 加在它下面', () => {
    const state = at(stateOf(DOC), '1')
    const next = apply(state, tableEnter(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe(`${DOC}\n|  |  |`)
  })

  it('最后一行整行空着时按 Enter 是离开表格，不是再加一行', () => {
    const doc = `${DOC}\n|  |  |`
    const state = at(stateOf(doc), '|  |  |')
    const next = apply(state, tableEnter(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe(`${DOC}\n`)
    expect(next.selection.main.head).toBe(next.doc.length)
  })

  it('选区非空时 Enter 照样加行——单元格里放不下换行，默认语义只会把表拆坏', () => {
    const state = at(stateOf(DOC), 'a').update({ selection: EditorSelection.range(2, 3) }).state
    const next = apply(state, tableEnter(state, 2))!
    expect(next.doc.toString()).toBe('| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |')
  })

  it('引用里的表格：新行要带上 `> ` 前缀，否则表在新行处断成两块', () => {
    const doc = '> | a | b |\n> | --- | --- |\n> | 1 | 2 |'
    const state = at(stateOf(doc), 'a')
    const next = apply(state, tableEnter(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe('> | a | b |\n> | --- | --- |\n> |  |  |\n> | 1 | 2 |')
  })
})

describe('键位接线', () => {
  /** 在真的 EditorView 上派发一次 keydown：键位表、优先级、处理器返回值都得一起对 */
  function press(view: EditorView, key: string, init: KeyboardEventInit = {}): void {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  }

  it('Tab 跳格、Enter 加行（压过 markdown 自带的 Enter）', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ state: at(stateOf(DOC), 'a'), parent })
    try {
      press(view, 'Tab')
      expect(selectedText(view.state)).toBe('b')

      press(view, 'Enter')
      expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |')
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it('不在表格里时 Tab 与 Enter 照旧交给默认按键', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ state: stateOf('普通段落'), parent })
    try {
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      view.contentDOM.dispatchEvent(tab)
      // 没有一个处理器认领它：CM6 不调 preventDefault，浏览器会去做它原本该做的事
      expect(tab.defaultPrevented).toBe(false)
    } finally {
      view.destroy()
      parent.remove()
    }
  })
})

describe('右键菜单的结构动作', () => {
  it('在下方插入行：表头与分隔行都落到第一条数据行的位置', () => {
    const header = at(stateOf(DOC), 'a')
    expect(apply(header, tableInsertRowBelow(header, header.selection.main.head))!.doc.toString()).toBe(
      '| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |',
    )
    const delimiter = at(stateOf(DOC), '---')
    expect(apply(delimiter, tableInsertRowBelow(delimiter, delimiter.selection.main.head))!.doc.toString()).toBe(
      '| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |',
    )
  })

  it('删除行只认数据行：表头与分隔行拒绝', () => {
    const header = at(stateOf(DOC), 'a')
    expect(tableDeleteRow(header, header.selection.main.head)).toBeNull()
    const delimiter = at(stateOf(DOC), '---')
    expect(tableDeleteRow(delimiter, delimiter.selection.main.head)).toBeNull()
  })

  it('删除数据行：表格末尾那一行连它前面的换行一起删，不留空行', () => {
    const state = at(stateOf(DOC), '1')
    const next = apply(state, tableDeleteRow(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe('| a | b |\n| --- | --- |')
  })

  it('删除数据行：后面还有内容时删掉整行（连行尾换行）', () => {
    const doc = `${DOC}\n\n后面`
    const state = at(stateOf(doc), '1')
    const next = apply(state, tableDeleteRow(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe('| a | b |\n| --- | --- |\n\n后面')
  })

  it('在右侧插入列：表头、分隔行、数据行同时多一列', () => {
    const state = at(stateOf(DOC), 'a')
    const next = apply(state, tableInsertColumnRight(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe('| a | | b |\n| --- | --- | --- |\n| 1 | | 2 |')
    // 语法树还认得它是一张三列的表
    const layout = tableLayoutAt(next, 0)!
    expect(layout.columns).toBe(3)
  })

  it('在最后一列右侧插列：贴着末尾竖线长出一格', () => {
    const state = at(stateOf(DOC), '2')
    const next = apply(state, tableInsertColumnRight(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe('| a | b | |\n| --- | --- | --- |\n| 1 | 2 | |')
    expect(tableLayoutAt(next, 0)!.columns).toBe(3)
  })

  it('没有外侧竖线的表格插列时也给新格补上收尾竖线', () => {
    const doc = 'a | b\n--- | ---\n1 | 2'
    const state = at(stateOf(doc), 'b')
    const next = apply(state, tableInsertColumnRight(state, state.selection.main.head))!
    expect(tableLayoutAt(next, 0)!.columns).toBe(3)
  })

  it('删除列：每一行各少一格，剩下的竖线当新分隔', () => {
    const state = at(stateOf(DOC), 'a')
    const next = apply(state, tableDeleteColumn(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe('| b |\n| --- |\n| 2 |')
    expect(tableLayoutAt(next, 0)!.columns).toBe(1)
  })

  it('只剩一列时拒绝删除', () => {
    const doc = '| a |\n| --- |\n| 1 |'
    const state = at(stateOf(doc), 'a')
    expect(tableDeleteColumn(state, state.selection.main.head)).toBeNull()
  })

  it('行里只剩一格（表格本身多列）时删列只清内容，不能把整行拆成空行', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 |'
    const state = at(stateOf(doc), '1')
    const next = apply(state, tableDeleteColumn(state, state.selection.main.head))!
    expect(next.doc.toString()).toBe('| b |\n| --- |\n|  |')
    // 断成空行的话这里会是 null
    expect(tableLayoutAt(next, 0)).not.toBeNull()
  })
})
