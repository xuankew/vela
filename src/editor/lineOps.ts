import type { ChangeSpec, EditorState, StateCommand, Transaction } from '@codemirror/state'

/**
 * 行级重排：排序 / 去重。
 *
 * CM6 没有内置这类命令（`@codemirror/commands` 只有移动、复制、删除行），而它们是
 * 「文本工具箱」定位下最常用的几个动作，所以自己实现。
 *
 * **排序口径刻意用码点，不用 `localeCompare`**：后者依赖运行环境的 ICU 数据，同一份文档在
 * 不同机器上可能排出不同结果，测试也就钉不住。代价是中文按 Unicode 顺序（≈部首笔画）而不是
 * 拼音排——真要拼音序得另配排序表，不值当，等有人提再加。
 */

interface LineBlock {
  from: number
  to: number
}

/**
 * 作用范围：**所有选区都为空 → 整个文档**；否则**每个选区各自展开成整行**，
 * 重叠或相邻的合并成一块。
 *
 * 「无选区就整篇」是刻意的：Sublime 在无选区时只排当前一行（几乎没有意义），而 Vela 的
 * 定位是文本工具箱，「打开一个词表 → Cmd+A 都不用按 → 排序」才是想要的动作。
 * 合并重叠块是因为 CM6 的 dispatch 不接受重叠变更，而多光标下两个选区落在同一行很常见。
 */
function targetBlocks(state: EditorState): LineBlock[] {
  const doc = state.doc
  const ranges = state.selection.ranges
  if (ranges.every((r) => r.empty)) return [{ from: 0, to: doc.length }]

  const blocks: LineBlock[] = []
  for (const r of ranges) {
    // 选区正好停在某行行首时，那一行一个字都没被选中，不该被算进来
    let end = r.to
    if (end > r.from && end === doc.lineAt(end).from) end -= 1
    blocks.push({ from: doc.lineAt(r.from).from, to: doc.lineAt(end).to })
  }
  blocks.sort((a, b) => a.from - b.from)

  const merged: LineBlock[] = []
  for (const block of blocks) {
    const last = merged[merged.length - 1]
    // `+1` 是两块之间那个换行符：跨过它就说明是相邻行，合成一块更连续
    if (last && block.from <= last.to + 1) last.to = Math.max(last.to, block.to)
    else merged.push({ from: block.from, to: block.to })
  }
  return merged
}

function rewriteLines(
  target: { state: EditorState; dispatch: (tr: Transaction) => void },
  transform: (lines: string[]) => string[],
): boolean {
  const { state } = target
  const changes: ChangeSpec[] = []

  for (const block of targetBlocks(state)) {
    const first = state.doc.lineAt(block.from).number
    const last = state.doc.lineAt(block.to).number
    const lines: string[] = []
    for (let n = first; n <= last; n++) lines.push(state.doc.line(n).text)
    const before = lines.join('\n')
    const after = transform(lines).join('\n')
    // 内容没变就不下发变更：否则每次「已经有序了还按一遍」都会往撤销历史里塞一条空记录
    if (after !== before) changes.push({ from: block.from, to: block.to, insert: after })
  }

  if (changes.length === 0) return false
  target.dispatch(state.update({ changes }))
  return true
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export const sortLinesAscending: StateCommand = (target) =>
  rewriteLines(target, (lines) => [...lines].sort(byCodePoint))

export const sortLinesDescending: StateCommand = (target) =>
  rewriteLines(target, (lines) => [...lines].sort((a, b) => byCodePoint(b, a)))

/**
 * 去重：保留**首次**出现的那一行，其余删掉，整体顺序不变。
 *
 * 刻意不先排序——「排好序再去重」会悄悄改掉用户的行序，而按原序去重的结果永远可预期。
 * 比较是大小写敏感的精确匹配：`Foo` 与 `foo` 算两行。要模糊去重就该用查找替换而不是这个命令。
 */
export const removeDuplicateLines: StateCommand = (target) =>
  rewriteLines(target, (lines) => {
    const seen = new Set<string>()
    return lines.filter((line) => (seen.has(line) ? false : (seen.add(line), true)))
  })
