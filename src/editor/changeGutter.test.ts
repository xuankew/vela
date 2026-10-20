import { EditorState, type ChangeSpec, type RangeSet } from '@codemirror/state'
import { GutterMarker } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { ADDED_MARK, changeMarks, DELETED_MARK, MODIFIED_MARK, resetChanges } from './changeGutter'

/**
 * 只测 `changeMarks` 这个字段，不建 `EditorView`：gutter 的渲染是 DOM/CSS，node 环境里量不出，
 * 而「哪一行被标成哪一种」这套逻辑全在字段里，用裸 state 就能钉死。
 */
function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [changeMarks] })
}

/** 把字段里的标记读成 `行号 → kind` 的清单，断言起来比对着 RangeSet 结构清楚 */
function marksByLine(state: EditorState): Array<{ line: number; kind: string }> {
  const out: Array<{ line: number; kind: string }> = []
  const set: RangeSet<GutterMarker> = state.field(changeMarks)
  set.between(0, state.doc.length, (from, _to, value) => {
    const marker = value as { kind?: string }
    out.push({ line: state.doc.lineAt(from).number, kind: marker.kind ?? '?' })
  })
  return out
}

/** 应用一次改动并返回新 state */
function apply(state: EditorState, changes: ChangeSpec): EditorState {
  return state.update({ changes }).state
}

describe('changeMarks：改动形状 → 标记分类', () => {
  it('纯插入一行 → added', () => {
    // "a\nc" 里在 a 之后插入一整行 b：旧侧是空区间（插入），新侧非空
    let s = stateWith('a\nc')
    s = apply(s, { from: 1, to: 1, insert: '\nb' })
    expect(marksByLine(s)).toEqual([{ line: 2, kind: 'added' }])
  })

  it('改写一行 → modified', () => {
    let s = stateWith('a\nb\nc')
    // 把第 2 行整行换掉：两侧都非空 = 替换
    s = apply(s, { from: 2, to: 3, insert: 'B' })
    expect(marksByLine(s)).toEqual([{ line: 2, kind: 'modified' }])
  })

  it('删除一行 → deleted，标记落在删除点所在的那一行', () => {
    let s = stateWith('a\nb\nc')
    // 删掉第 2 行连同它的换行：新侧是空区间
    s = apply(s, { from: 2, to: 4 })
    expect(marksByLine(s)).toEqual([{ line: 2, kind: 'deleted' }])
    expect(s.doc.toString()).toBe('a\nc')
  })

  it('一次插入横跨多行 → 每行各一个 added', () => {
    let s = stateWith('a\nz')
    s = apply(s, { from: 1, to: 1, insert: '\nb\nc\nd' })
    expect(marksByLine(s)).toEqual([
      { line: 2, kind: 'added' },
      { line: 3, kind: 'added' },
      { line: 4, kind: 'added' },
    ])
  })
})

describe('changeMarks：累积、去重、跟随', () => {
  it('多次改动累积在不同行上', () => {
    let s = stateWith('a\nb\nc\nd')
    s = apply(s, { from: 0, to: 1, insert: 'A' }) // 第 1 行 modified
    s = apply(s, { from: 6, to: 7, insert: 'D' }) // 第 4 行 modified
    expect(marksByLine(s)).toEqual([
      { line: 1, kind: 'modified' },
      { line: 4, kind: 'modified' },
    ])
  })

  it('反复编辑同一行只留一个标记——不去重的话一个 gutter 格里会叠一摞', () => {
    let s = stateWith('a\nb\nc')
    s = apply(s, { from: 2, to: 3, insert: 'B1' })
    s = apply(s, { from: 2, to: 4, insert: 'B2' })
    s = apply(s, { from: 2, to: 4, insert: 'B3' })
    expect(marksByLine(s)).toEqual([{ line: 2, kind: 'modified' }])
  })

  it('已有标记跟着正文前移：在上面插一行，标记落到下一行', () => {
    let s = stateWith('a\nb\nc')
    s = apply(s, { from: 2, to: 3, insert: 'B' }) // 先标第 2 行
    expect(marksByLine(s)).toEqual([{ line: 2, kind: 'modified' }])
    // 再在最前面插一整行：原来第 2 行的标记必须移到第 3 行，而不是钉死在行号 2
    s = apply(s, { from: 0, to: 0, insert: 'top\n' })
    expect(marksByLine(s)).toEqual([
      { line: 1, kind: 'added' },
      { line: 3, kind: 'modified' },
    ])
  })

  it('纯选区变化不产生标记', () => {
    let s = stateWith('a\nb\nc')
    s = s.update({ selection: { anchor: 0, head: 3 } }).state
    expect(marksByLine(s)).toEqual([])
  })
})

describe('changeMarks：resetChanges 清空', () => {
  it('存盘信号把累积的标记整体清掉', () => {
    let s = stateWith('a\nb\nc')
    s = apply(s, { from: 0, to: 1, insert: 'A' })
    s = apply(s, { from: 4, to: 5, insert: 'B' })
    expect(marksByLine(s)).toHaveLength(2)

    s = s.update({ effects: resetChanges.of(null) }).state
    expect(marksByLine(s)).toEqual([])
  })

  it('清空之后再改动重新累积——不是一锤子买卖', () => {
    let s = stateWith('a\nb')
    s = apply(s, { from: 0, to: 1, insert: 'A' })
    s = s.update({ effects: resetChanges.of(null) }).state
    s = apply(s, { from: 2, to: 3, insert: 'B' })
    expect(marksByLine(s)).toEqual([{ line: 2, kind: 'modified' }])
  })
})

describe('标记是单例', () => {
  it('三种标记各不相同，且可被身份比较（gutter 靠这个决定要不要重画）', () => {
    expect(ADDED_MARK).not.toBe(MODIFIED_MARK)
    expect(MODIFIED_MARK).not.toBe(DELETED_MARK)
    expect(ADDED_MARK.kind).toBe('added')
    expect(MODIFIED_MARK.kind).toBe('modified')
    expect(DELETED_MARK.kind).toBe('deleted')
  })
})
