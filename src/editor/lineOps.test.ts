import { EditorSelection, EditorState, type StateCommand, type Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { removeDuplicateLines, sortLinesAscending, sortLinesDescending } from './lineOps'

/**
 * 跑一个 StateCommand 并返回结果文档。
 *
 * 刻意不用 EditorView：lineOps 只碰 EditorState，node 环境就够，也就完全绕开了
 * jsdom 没有布局引擎这件事（见 src/test/setup.ts）。
 * 返回 null 表示命令拒绝了（no-op），用来区分「没改」和「改成了同样的内容」。
 */
function run(command: StateCommand, doc: string, ranges?: [number, number][]): string | null {
  const state = EditorState.create({
    doc,
    selection: ranges ? EditorSelection.create(ranges.map(([from, to]) => EditorSelection.range(from, to))) : undefined,
    // ⚠️ 必须显式打开：`allowMultipleSelections` 默认是 false，多选区会被**静默塌成主选区**
    // （不报错，只是少排了几块）。真实编辑器在 setup.ts 里开着这一条，测试 state 是另建的，
    // 漏掉就等于在测一个产品里不存在的行为。
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  // 用 holder 对象而不是捕获的 let：TS 看不出 dispatch 闭包是同步跑的，
  // 会把 `next` 收窄成 null，到 `next?.toString()` 就变成 never 上的属性访问。
  const out: { doc: Text | null } = { doc: null }
  const accepted = command({ state, dispatch: (tr) => { out.doc = tr.state.doc } })
  expect(accepted).toBe(out.doc !== null)
  return out.doc?.toString() ?? null
}

describe('排序的作用范围', () => {
  it('没有选区时排整个文档——「打开词表直接排序」才是工具箱想要的动作', () => {
    expect(run(sortLinesAscending, 'banana\napple\ncherry')).toBe('apple\nbanana\ncherry')
  })

  it('只有光标（空选区）也算「没有选区」，同样排全文', () => {
    // 光标停在 'banana' 里
    expect(run(sortLinesAscending, 'banana\napple', [[2, 2]])).toBe('apple\nbanana')
  })

  it('有选区时只排选区覆盖的整行，前后文不动', () => {
    // 文档: "头\nbanana\napple\n尾"，选中 'banana\napple' 这段
    const doc = '头\nbanana\napple\n尾'
    const from = doc.indexOf('banana')
    const to = doc.indexOf('apple') + 'apple'.length
    expect(run(sortLinesAscending, doc, [[from, to]])).toBe('头\napple\nbanana\n尾')
  })

  it('选区横跨两行但每行都只选到一部分，仍然按整行排', () => {
    const doc = 'zzz\nbanana\napple'
    // [6,14] = 'nana\napp'：两行各只选到一半
    expect(run(sortLinesAscending, doc, [[6, 14]])).toBe('zzz\napple\nbanana')
  })

  it('选区完全落在一行内时无事可做：排一行等于没排，不该下发变更', () => {
    expect(run(sortLinesAscending, 'zzz\nbanana\napple', [[4, 7]])).toBeNull()
  })

  it('选区正好停在某行行首时，那一行一个字都没选中，不该被排进来', () => {
    const doc = 'banana\napple\ncherry'
    // 选 'banana\n'：to=7 落在 'apple' 的行首。若误把 apple 算进来，块就是两行、会被排成
    // 'apple\nbanana'；正确行为是块里只有 banana 一行 → 无事可做 → null。
    // 所以这里的 null 正是区分两种实现的证据。
    expect(run(sortLinesAscending, doc, [[0, 7]])).toBeNull()
  })

  it('多个选区各自排序，互不干扰', () => {
    // 两块：'b\na' 与 'd\nc'，中间的 '---' 不属于任何选区
    const doc = 'b\na\n---\nd\nc'
    const result = run(sortLinesAscending, doc, [
      [0, 3],
      [8, 11],
    ])
    expect(result).toBe('a\nb\n---\nc\nd')
  })

  it('选区行范围重叠时合并成一块，而不是下发 CM6 会拒绝的重叠变更', () => {
    // 两个选区都覆盖 'b\na' 这一段
    const doc = 'b\na\nc'
    expect(run(sortLinesAscending, doc, [[0, 3], [2, 5]])).toBe('a\nb\nc')
  })

  it('相邻两行的选区合并成一块（跨过中间那个换行符）', () => {
    const doc = 'c\nb\na'
    // [0,1]='c' 与 [2,3]='b' 相邻 → 合成 c/b 一块，'a' 不参与
    expect(run(sortLinesAscending, doc, [[0, 1], [2, 3]])).toBe('b\nc\na')
  })

  it('末尾换行符原样保留：CM6 把它算作一个空行，排序后空行落到最前', () => {
    expect(run(sortLinesAscending, 'b\na\n')).toBe('\na\nb')
  })

  it('文档没有末尾换行时，排完也不会凭空多一个', () => {
    expect(run(sortLinesAscending, 'b\na')).toBe('a\nb')
  })
})

describe('排序口径', () => {
  it('按码点排：大写整体在小写之前（不是字典序的忽略大小写）', () => {
    expect(run(sortLinesAscending, 'apple\nZebra\nBanana')).toBe('Banana\nZebra\napple')
  })

  it('降序是升序的严格反转', () => {
    expect(run(sortLinesDescending, 'apple\nbanana\ncherry')).toBe('cherry\nbanana\napple')
  })

  it('空行是最小值，升序时全部聚到开头', () => {
    expect(run(sortLinesAscending, 'b\n\na\n')).toBe('\n\na\nb')
  })

  it('重复行保持重复，排序不去重', () => {
    expect(run(sortLinesAscending, 'b\na\nb')).toBe('a\nb\nb')
  })

  it('已经有序时返回 false 且不下发变更——不给撤销历史塞空记录', () => {
    expect(run(sortLinesAscending, 'a\nb\nc')).toBeNull()
  })

  it('降序时已经有序同样拒绝', () => {
    expect(run(sortLinesDescending, 'c\nb\na')).toBeNull()
  })

  it('多块里只要有一块需要改就下发；两块都没变才拒绝', () => {
    const doc = 'a\nb\n---\nd\nc'
    expect(run(sortLinesAscending, doc, [[0, 3], [8, 11]])).toBe('a\nb\n---\nc\nd')
    expect(run(sortLinesAscending, doc, [[0, 3]])).toBeNull()
  })

  it('多块合并成**一个**事务，Cmd+Z 一次就能整体撤销', () => {
    const doc = 'b\na\n---\nd\nc'
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 11)]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })
    let count = 0
    sortLinesAscending({ state, dispatch: () => { count += 1 } })
    expect(count).toBe(1)
  })
})

describe('去重', () => {
  it('保留首次出现的那一行，顺序不变', () => {
    expect(run(removeDuplicateLines, 'b\na\nb\nc\na')).toBe('b\na\nc')
  })

  it('刻意不先排序：去重不会悄悄改掉用户的行序', () => {
    expect(run(removeDuplicateLines, 'c\nb\nc\na\nb')).toBe('c\nb\na')
  })

  it('大小写敏感：Foo / foo / FOO 是三行，一个都不该被去掉', () => {
    expect(run(removeDuplicateLines, 'Foo\nfoo\nFOO')).toBeNull()
  })

  it('行首尾空格参与比较：a / " a" / "a " 是三行', () => {
    expect(run(removeDuplicateLines, 'a\n a\na ')).toBeNull()
  })

  it('空行也去重，只留一个', () => {
    expect(run(removeDuplicateLines, 'a\n\n\nb')).toBe('a\n\nb')
  })

  it('没有重复时返回 false，不下发空变更', () => {
    expect(run(removeDuplicateLines, 'a\nb\nc')).toBeNull()
  })

  it('只作用于选区覆盖的行', () => {
    const doc = '头\na\na\n尾\na'
    const from = doc.indexOf('a')
    const to = from + 4 // 'a\na'
    expect(run(removeDuplicateLines, doc, [[from, to]])).toBe('头\na\n尾\na')
  })

  it('全篇都是同一行时只剩一行', () => {
    expect(run(removeDuplicateLines, 'x\nx\nx\nx')).toBe('x')
  })
})
