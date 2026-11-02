/**
 * Markdown 表格的编辑动作：跳格、加行、离表、插删行列。
 *
 * `./table` 管「这张表长什么样」（对齐），这里管「用户动它的时候改哪几个字」。
 * 两层共用同一份 `rowParts`：竖线在哪儿、哪一段算一个空格子，两边必须同源，
 * 否则对齐补出来的表格和 Tab 跳过去的格子会对不上。
 *
 * ## ⛔ 函数只认 `EditorState`，不认 `EditorView`
 *
 * 每个动作都是 `(state, pos) => TransactionSpec | null`：算出**要改什么**，不负责派发。
 * 好处是测试在 node 里跑一遍就够了（jsdom 没有排版引擎，见 `src/test/setup.ts`），
 * 而键位那层只是把光标位置喂进来、把 spec 交给 `view.dispatch`。
 *
 * ## 按键语义
 *
 * - `Tab` / `Shift-Tab`：按**视觉顺序**走（表头 → 各行），跳过分隔行。
 *   最后一格再按 Tab 补一行，光标落进新行的第一格；第一格按 Shift-Tab 绕回最后一格。
 *   选中整格内容而不是把光标塞在格首：接着打字就是替换，这是表格里最常见的下一步。
 * - `Enter`：在当前行下面加一行；在表头或分隔行上则加在分隔行下面（也就是第一条数据行）。
 *   **最后一行整行空着时按 Enter = 离开这张表**：清空这一行、光标留在空行上。
 *   少了这一条，键盘用户会被困在表格里——每按一次 Enter 只会多出一行新的空格。
 *   ⚠️ 有选区也照样接管（Tab 跳格后整格是选中的，那一下按 Enter 的意图显然是「加一行」）：
 *   单元格里本来就不能放换行，默认的 Enter 只会把表拆坏，没有一种是用户想要的。
 *   `Shift+Enter` 不在这里——键位表按修饰键分成两条，它落回默认行为。
 *
 * ## 行/列的增删（右键菜单）
 *
 * 表格的列数由**分隔行**决定（GFM 的规矩，`./table` 文件头那段说过），所以：
 *
 * - 插列：贴着点击那一格右侧的竖线下刀，每一行各插一份。行尾没有外侧竖线时，
 *   新格子必须自带一根收尾竖线，否则 GFM 会把末尾的空段当成外侧竖线丢掉，
 *   结果是「分隔行多了一列，数据行没多」。
 * - 删列：从这一格**前面**那根竖线删到**后面**那根竖线，也就是保留后一根当新的分隔。
 *   行里只剩这一格时只清内容——连竖线一起删会把整行变成空行，表格当场断掉。
 * - 删行只认数据行：表头与分隔行删掉表就不成立了（菜单里那两项据此灰掉）。
 *
 * ## 引用与缩进里的表格
 *
 * 行首的 `> ` / 缩进不在 `TableRow` 的范围里（`./table` 文件头有实测记录），
 * 所以插入新行时要从**当前行**里把这段前缀切出来拼到新行前面。只写 `\n` + 新行的话，
 * 引用里的表格会在新行处断成两块。
 *
 * ## 解析预算
 *
 * 与对齐用的是同一个 50ms（`ALIGN_PARSE_TIMEOUT_MS`）：这也是按键预算。
 * 半截树之外的表按「这儿没有表」处理，按键原样交回默认行为。
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState, SelectionRange, TransactionSpec } from '@codemirror/state'
import { EditorSelection, Prec } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { ALIGN_PARSE_TIMEOUT_MS, rowParts, tableAt, type PipeSpan, type RowParts } from './table'

/** 一个单元格的几何：两侧竖线之间的整段，以及 trim 之后真正的内容 */
export interface TableCell {
  /** 与对齐同源的文本（已 trim）；空格子为空串 */
  text: string
  /** 内容（trim 后）的两端。空单元格时 `contentFrom === contentTo` */
  contentFrom: number
  contentTo: number
  /** 两侧竖线之间的整段（含内边距空白） */
  segmentFrom: number
  segmentTo: number
  before: PipeSpan | null
  after: PipeSpan | null
}

export interface TableRow {
  from: number
  to: number
  /** 这一行所在的整行范围（含 `> ` / 缩进前缀），删行与插行都按整行算 */
  lineFrom: number
  lineTo: number
  kind: 'header' | 'delimiter' | 'data'
  leadingPipe: boolean
  trailingPipe: boolean
  cells: TableCell[]
}

export interface TableLayout {
  from: number
  to: number
  rows: TableRow[]
  /** 表头在 `rows` 里的下标；没有表头（分隔行之前没有内容）时为 -1 */
  headerIndex: number
  delimiterIndex: number
  /** 列数，取自分隔行——GFM 的列数就是它 */
  columns: number
}

export interface CellRef {
  row: number
  col: number
}

/** 一行文本按 `|` 切段，顺带记住每段前后那根竖线的位置 */
interface RawSegment {
  from: number
  to: number
  text: string
  before: PipeSpan | null
  after: PipeSpan | null
}

/**
 * 分隔行那一行的切分。
 *
 * 🔴 **分隔行是叶子节点**：`TableDelimiter` 在顶层没有内部子节点（实测，真的
 * `markdownLanguage.parser`），`./table` 的 `rowParts` 拿它只能得到「一整段」。
 * 所以这里自己按 `|` 切，过滤规则与 `parseAlignments` 逐条对齐——外层那个空段
 * 只有**没有外侧竖线**时才不是单元格。
 */
function delimiterRowParts(node: SyntaxNode, slice: (from: number, to: number) => string): RowParts {
  const text = slice(node.from, node.to)
  const raw: RawSegment[] = []
  let from = node.from
  let before: PipeSpan | null = null
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '|') continue
    const pipe = { from: node.from + index, to: node.from + index + 1 }
    raw.push({ from, to: pipe.from, text: slice(from, pipe.from).trim(), before, after: pipe })
    from = pipe.to
    before = pipe
  }
  raw.push({ from, to: node.to, text: slice(from, node.to).trim(), before, after: null })

  const kept = raw.filter((segment, index) => !(segment.text === '' && (index === 0 || index === raw.length - 1)))
  return {
    segments: kept,
    leadingPipe: kept.length > 0 && kept[0]!.before !== null,
    trailingPipe: kept.length > 0 && kept[kept.length - 1]!.after !== null,
  }
}

function rowOf(
  state: EditorState,
  node: SyntaxNode,
  kind: TableRow['kind'],
  slice: (from: number, to: number) => string,
): TableRow {
  const line = state.doc.lineAt(node.from)
  // 分隔行是叶子节点，理由见 `delimiterRowParts`
  const parts = kind === 'delimiter' ? delimiterRowParts(node, slice) : rowParts(node, slice)
  return {
    from: node.from,
    to: node.to,
    lineFrom: line.from,
    lineTo: line.to,
    kind,
    leadingPipe: parts.leadingPipe,
    trailingPipe: parts.trailingPipe,
    cells: parts.segments.map((segment) => {
      const raw = slice(segment.from, segment.to)
      const leading = raw.length - raw.trimStart().length
      const trailing = raw.length - raw.trimEnd().length
      const contentFrom = segment.from + leading
      return {
        text: segment.text,
        contentFrom,
        contentTo: Math.max(contentFrom, segment.to - trailing),
        segmentFrom: segment.from,
        segmentTo: segment.to,
        before: segment.before,
        after: segment.after,
      }
    }),
  }
}

/**
 * 光标/点击位置处那张表的几何。不在表里（或树只解析到一半）回 `null`。
 *
 * ⚠️ 解析预算与对齐同一个数，理由写在文件头「解析预算」那一段
 */
export function tableLayoutAt(state: EditorState, pos: number): TableLayout | null {
  const tree = ensureSyntaxTree(state, state.doc.length, ALIGN_PARSE_TIMEOUT_MS) ?? syntaxTree(state)
  const table = tableAt(tree, pos)
  if (table === null) return null

  const slice = (from: number, to: number) => state.sliceDoc(from, to)
  const rows: TableRow[] = []
  let headerIndex = -1
  let delimiterIndex = -1

  for (let child = table.firstChild; child !== null; child = child.nextSibling) {
    // 🔴 同名的 `TableDelimiter` 在顶层是分隔行、在行内是竖线；这一层只会拿到顶层的
    if (child.name === 'TableDelimiter') {
      delimiterIndex = rows.length
      rows.push(rowOf(state, child, 'delimiter', slice))
    } else if (child.name === 'TableHeader') {
      headerIndex = rows.length
      rows.push(rowOf(state, child, 'header', slice))
    } else if (child.name === 'TableRow') {
      rows.push(rowOf(state, child, 'data', slice))
    }
  }

  if (delimiterIndex < 0) return null
  const columns = rows[delimiterIndex]!.cells.length
  if (columns === 0) return null
  return { from: table.from, to: table.to, rows, headerIndex, delimiterIndex, columns }
}

/** 位置最近的单元格。点在竖线上、行首前缀上都会落到相邻那一格，而不会「找不到」 */
function nearestCell(row: TableRow, pos: number): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  row.cells.forEach((cell, index) => {
    const distance = pos < cell.segmentFrom ? cell.segmentFrom - pos : pos > cell.segmentTo ? pos - cell.segmentTo : 0
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

/** 位置落在哪一行哪一格。⚠️ 行按**整行**算，引用里的 `> ` 前缀也算这一行的 */
export function tableCellAt(layout: TableLayout, pos: number): CellRef {
  let row = layout.rows.findIndex((candidate) => pos >= candidate.lineFrom && pos <= candidate.lineTo)
  if (row < 0) row = pos < layout.rows[0]!.lineFrom ? 0 : layout.rows.length - 1
  const target = layout.rows[row]!
  let col = target.cells.findIndex((cell) => pos >= cell.segmentFrom && pos <= cell.segmentTo)
  if (col < 0) col = nearestCell(target, pos)
  return { row, col }
}

/**
 * 跳进一格时的选区。
 *
 * 有内容就整格选中（接着打字即替换）；空格子没有可选的字符，落在段内第一个位置但不越过
 * 收尾的竖线——`|   |` 里打字会得到 `| x |` 而不是 `| x|`
 */
function cellSelection(cell: TableCell): SelectionRange {
  if (cell.text === '') {
    return EditorSelection.cursor(Math.min(cell.segmentFrom + 1, cell.segmentTo))
  }
  return EditorSelection.range(cell.contentFrom, cell.contentTo)
}

export type CellDirection = 1 | -1

/**
 * Tab / Shift-Tab 的落点。
 *
 * 顺序是**视觉顺序**：表头一格一格往右，然后第一条数据行……分隔行不参与。
 * 越过最后一格就补一行（`Shift-Tab` 越过第一格绕回最后一格）。
 */
export function tableNextCell(state: EditorState, pos: number, direction: CellDirection): TransactionSpec | null {
  const layout = tableLayoutAt(state, pos)
  if (layout === null) return null

  const ref = tableCellAt(layout, pos)
  const flat: CellRef[] = []
  layout.rows.forEach((row, rowIndex) => {
    if (row.kind === 'delimiter') return
    row.cells.forEach((_, col) => flat.push({ row: rowIndex, col }))
  })
  if (flat.length === 0) return null

  const current = flat.findIndex((cell) => cell.row === ref.row && cell.col === ref.col)
  let target = current < 0 ? (direction > 0 ? 0 : flat.length - 1) : current + direction
  if (target < 0) target = flat.length - 1
  // 最后一格再往右：补一行。⚠️ 锚在**最后一行**上，表格只有表头时那就是分隔行——
  // 新行必须落在分隔行之后，落在表头后面会把表的列数弄乱
  if (target >= flat.length) return rowInsertSpec(state, layout, layout.rows[layout.rows.length - 1]!)

  const targetCell = layout.rows[flat[target]!.row]!.cells[flat[target]!.col]!
  return { selection: cellSelection(targetCell), scrollIntoView: true }
}

/** 新行长什么样：列数跟着分隔行，首尾竖线照当前行的习惯 */
function newRowText(columns: number, template: TableRow): string {
  const cells = Array.from({ length: columns }, () => '  ')
  let text = cells.join('|')
  if (template.leadingPipe) text = `|${text}`
  if (template.trailingPipe) text = `${text}|`
  return text
}

/** 在某一行下面插入一条新行，光标落进新行第一格 */
function rowInsertSpec(state: EditorState, layout: TableLayout, anchor: TableRow): TransactionSpec {
  const text = newRowText(layout.columns, anchor)
  const line = state.doc.lineAt(anchor.from)
  // 引用/缩进里的表格：前缀不在行节点里，得从当前行的行首切出来
  const prefix = state.sliceDoc(line.from, anchor.from)
  const lineStart = line.to + 1
  const caret = lineStart + prefix.length + (text.startsWith('|') ? 2 : 1)
  return {
    changes: { from: line.to, insert: `\n${prefix}${text}` },
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
  }
}

/** Enter：加一行，或在最后一行空着时离开表格 */
export function tableEnter(state: EditorState, pos: number): TransactionSpec | null {
  const layout = tableLayoutAt(state, pos)
  if (layout === null) return null
  const ref = tableCellAt(layout, pos)
  const row = layout.rows[ref.row]!
  const last = layout.rows[layout.rows.length - 1]!

  if (row.kind === 'data' && row === last && row.cells.every((cell) => cell.text === '')) {
    // 整行清空而不是连换行一起删：光标留在一条空行上，它就是表格后面的那个段落
    return {
      changes: { from: row.lineFrom, to: row.lineTo, insert: '' },
      selection: EditorSelection.cursor(row.lineFrom),
      scrollIntoView: true,
    }
  }

  // 表头与分隔行上的 Enter 都落到「第一条数据行」的位置
  const anchor = row.kind === 'data' ? row : layout.rows[layout.delimiterIndex]!
  return rowInsertSpec(state, layout, anchor)
}

/** 右键「在下方插入行」：语义与 Enter 的加行分支一致 */
export function tableInsertRowBelow(state: EditorState, pos: number): TransactionSpec | null {
  const layout = tableLayoutAt(state, pos)
  if (layout === null) return null
  const row = layout.rows[tableCellAt(layout, pos).row]!
  const anchor = row.kind === 'data' ? row : layout.rows[layout.delimiterIndex]!
  return rowInsertSpec(state, layout, anchor)
}

/** 右键「删除行」。表头与分隔行删不得：整张表靠它们成立 */
export function tableDeleteRow(state: EditorState, pos: number): TransactionSpec | null {
  const layout = tableLayoutAt(state, pos)
  if (layout === null) return null
  const row = layout.rows[tableCellAt(layout, pos).row]!
  if (row.kind !== 'data') return null

  // 表格末尾那一行没有行尾换行：改删它前面的换行，否则会留下一条空行
  if (row.lineTo < state.doc.length) {
    return {
      changes: { from: row.lineFrom, to: row.lineTo + 1, insert: '' },
      selection: EditorSelection.cursor(row.lineFrom),
      scrollIntoView: true,
    }
  }
  return {
    changes: { from: row.lineFrom - 1, to: row.lineTo, insert: '' },
    selection: EditorSelection.cursor(row.lineFrom - 1),
    scrollIntoView: true,
  }
}

/** 右键「在右侧插入列」 */
export function tableInsertColumnRight(state: EditorState, pos: number): TransactionSpec | null {
  const layout = tableLayoutAt(state, pos)
  if (layout === null) return null
  const column = tableCellAt(layout, pos).col
  const changes: { from: number; insert: string }[] = []

  for (const row of layout.rows) {
    const cell = row.cells[column]
    if (cell === undefined) continue
    const delimiter = row.kind === 'delimiter'
    if (cell.after !== null) {
      // 贴着这一格右侧的竖线插：新格落在它与下一格之间
      changes.push({ from: cell.after.to, insert: delimiter ? ' --- |' : ' |' })
    } else {
      // 行尾没有外侧竖线：新格必须自带收尾竖线，否则末尾空段会被当成外侧竖线丢掉
      changes.push({ from: cell.segmentTo, insert: delimiter ? ' | --- |' : ' |  |' })
    }
  }
  return changes.length === 0 ? null : { changes }
}

/** 右键「删除列」。只剩一列时拒绝：删完表格就不是表格了 */
export function tableDeleteColumn(state: EditorState, pos: number): TransactionSpec | null {
  const layout = tableLayoutAt(state, pos)
  if (layout === null || layout.columns <= 1) return null
  const column = tableCellAt(layout, pos).col
  const changes: { from: number; to: number; insert: '' }[] = []

  for (const row of layout.rows) {
    const cell = row.cells[column]
    if (cell === undefined) continue
    if (row.cells.length === 1) {
      // 这一行只剩一格：连竖线一起删会把整行拆成空行、表格断掉，只清内容
      changes.push({ from: cell.contentFrom, to: cell.contentTo, insert: '' })
      continue
    }
    // 保留后面那根竖线当新的分隔；前面那根随这一格一起走
    changes.push({ from: cell.before?.from ?? row.from, to: cell.after?.from ?? row.to, insert: '' })
  }
  return changes.length === 0 ? null : { changes }
}

/** 把「算出 spec」包成 CM6 的按键处理器：算不出来就交回默认按键 */
function runAtCursor(action: (state: EditorState, pos: number) => TransactionSpec | null) {
  return (view: EditorView): boolean => {
    const spec = action(view.state, view.state.selection.main.head)
    if (spec === null) return false
    view.dispatch(spec)
    return true
  }
}

/**
 * 表格里的 Tab / Shift-Tab / Enter。
 *
 * 🔴 `Prec.highest`：`markdown()` 自己带一条 `Prec.high` 的 Enter（继续列表/引用），
 * 同档时先注册的那条先拿到按键，我们的处理器就永远轮不到。高它一档才压得住；
 * 不在表格里时三个处理器都回 `false`，按键原样落回列表/引用那套默认行为。
 */
export const tableEditKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: runAtCursor((state, pos) => tableNextCell(state, pos, 1)) },
    { key: 'Shift-Tab', run: runAtCursor((state, pos) => tableNextCell(state, pos, -1)) },
    { key: 'Enter', run: runAtCursor(tableEnter) },
  ]),
)
