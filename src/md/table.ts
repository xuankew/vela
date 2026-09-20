/**
 * Markdown 表格的形状与对齐（M3-A-5）。
 *
 * 干的事只有一件：把光标所在的那张表**只改空白**地重排成
 *
 * ```
 * | 名字 | 数量 |
 * | ---- | ---: |
 * | 中文 |   12 |
 * ```
 *
 * ——补齐两侧缺的 `|`、按每列的**显示宽度**补空格、分隔行的 `-` 拉到同宽，
 * 并且原样保留 `:---` / `---:` / `:-:` 那三种对齐。
 *
 * ## 🔴 显示宽度：CJK 算两格
 *
 * 「补齐空格」在中文表格上只有一个难点：`甲` 与 `a` 在等宽字体里不是一样宽。
 * 代码区用的 Maple Mono CN 官方声明 CJK:拉丁 = **2:1**，M0 #3 在真 CM6 行上量到
 * **2.0000**（PLAN.md §3.2），所以这里按同一个口径算：East Asian Width 的 **W/F 算 2**、
 * 组合符号与零宽算 **0**、其余算 **1**。算错一格整张表就歪一格，
 * 而那正是这个功能唯一的存在理由。
 *
 * ⚠️ **Ambiguous 一律算 1**：`±` `×` `①`、希腊与西里尔字母、制表符 `─│┼` 在 CJK 字体里
 * 常常画成两格。这是行业公认的老问题（PLAN.md R10），CM6 与 Monaco 的单值 `charWidth`
 * 模型同样解不了，接受。所以一张混着 `─` 的表**可能**对不齐——那是字体口径的分歧，
 * 不是这里的算法错。
 *
 * ## ⛔ 只改空白：绝不增删单元格
 *
 * 分隔行的列数**就是**这张表在 GFM 里的列数，而数据行里多出来的单元格渲染时会被丢掉。
 * 于是「把每行都补成 N 列」这种看着更整齐的做法会**改文档的意思**：
 *
 * ```
 * | a | b | c |        | a   | b   | c   |
 * |---|---|     →      | --- | --- | --- |   ← c 从「被丢掉」变成「渲染出来」
 * | 1 | 2 | 3 |        | 1   | 2   | 3   |
 * ```
 *
 * 一个「格式化」命令不该干这种事。所以：**分隔行照它自己的列数重排**，
 * 数据行只在**少**于分隔行时补空格单元（那几格 GFM 本来就渲染成空 `<td>`，
 * 补出来不改变任何意思），多出来的单元格**一个都不删**。
 *
 * ## 单元格边界取自语法树，⛔ 不是自己按 `|` 切
 *
 * `| a \| b |` 与 <code>| `x|y` |</code> 里的竖线不是分隔符。更要紧的是：预览
 * （`./render.ts`）用的就是这棵树，两边对「这张表有几列、每格是什么」的理解必须同源——
 * 不一致的话「对齐」就会顺手改掉渲染结果，而那是用户最不可能联想到的一步。
 *
 * ## 🔴 依赖「缓冲区里只有 `\n`」这条不变量
 *
 * 读盘时 `normalize_to_lf`、写盘时 `apply_eol`（`crates/vela-core/src/fs/eol.rs`），
 * 所以 CM6 缓冲区里永远只有 `\n`，CRLF 是**存盘那一刻**才回去的。
 *
 * 实测（拿真的 `markdownLanguage.parser` 打出来看过）：喂一份 `\r\n` 的表格进去，
 * 树是**乱的**——分隔行会把 `\n` 吞进自己的范围、数据行里的竖线被当成了单元格内容。
 * 照着那样的树重写，不是崩，是**把一张好好的表改坏**。所以这条不变量一旦破了
 * （比如哪天为了「原样保留换行符」改成不归一化），这里必须跟着改。
 *
 * ## ⚠️ 逐行替换，而不是一整块替换
 *
 * 解析超时拿到半截树时（`ALIGN_PARSE_TIMEOUT_MS`），最坏的结果是「只对齐了看得见的那几行」，
 * ⛔ 不会把没解析到的行删掉。整块替换 `[table.from, table.to]` 就没有这个性质了。
 * 顺带的好处是光标由 CM6 逐条映射过去，落在原来那个字符后面。
 *
 * 由此继承的缺口与大纲面板那条一样：一份很大的 Markdown 上，这张表可能在半截树之外，
 * 那时命令如实回「光标不在表格里」。
 *
 * 逐行替换还顺手解决了一件事：表嵌在引用或列表里时，行首的 `> ` / 缩进**在行的范围之外**
 * （实测它们是 `Table` 自己的 `QuoteMark` 子节点，或者压根在 `Table.from` 之前），
 * 所以只换 `[row.from, row.to]` 天然把前缀留在原处。整块替换就得自己把每一行的前缀拼回去。
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'

/**
 * 同步解析的预算。与 `SYMBOL_PARSE_TIMEOUT_MS`（`goto/syntax.ts:32`）同一个数、
 * 同一条理由：这是**按键**预算，按下去要立刻有结果。
 *
 * ⚠️ 刻意各留一份常量而不是共用：两个数都叫「毫秒」，共用一个会让人以为它们是一对，
 * 于是要调其中一个时顺手动了另一个（`ui/virtual.ts` 文件头那条说的是同一件事）
 */
export const ALIGN_PARSE_TIMEOUT_MS = 50

/** 一列最少三格：分隔行要放得下 `:-:` */
const MIN_CELL_WIDTH = 3

/** 单元格对齐。来自分隔行里冒号的位置：`:--` 左、`--:` 右、`:-:` 居中 */
export type Align = 'none' | 'left' | 'right' | 'center'

/** 一条替换。逐行一条，理由见文件头「逐行替换」那一段 */
export interface TableChange {
  from: number
  to: number
  insert: string
}

/**
 * 对齐的结果。三态而不是「改动列表，可能是空的」：
 * `noTable` 与 `aligned` 在调用方要说的是**两句话**，而 `null` 与 `[]` 这种区分
 * 迟早会被谁写反——写反了的症状是「光标明明在表格里，却说这儿没有表格」
 */
export type AlignResult =
  /** 光标这儿没有表格（或者树只解析到一半，表格还在半截之外） */
  | { kind: 'noTable' }
  /** 有表格，而且已经齐了：一个字节都不用改 */
  | { kind: 'aligned' }
  | { kind: 'changes'; changes: readonly TableChange[] }

/**
 * 解析表格分隔行 `|:---|---:|:-:|`。
 *
 * ⚠️ 分隔行**不一定合法**（`|---|` 少一列、`|:|` 只有冒号）。这里不做校验，
 * 有几个算几个，多出来的单元格对齐方式就是 `none`——表格少一列时预览应该照常渲染，
 * 而不是整张表消失。
 */
export function parseAlignments(delimiterRow: string): Align[] {
  const parts = delimiterRow.split('|')
  return (
    parts
      // 首尾两个空串是 `|…|` 外侧的那两段。⚠️ 但不能无脑 slice(1,-1)：
      // 省略竖线的写法（`---|---`）没有它们，切掉就少两列
      .filter((part, index) => !(part.trim() === '' && (index === 0 || index === parts.length - 1)))
      .map((part) => {
        const cell = part.trim()
        const left = cell.startsWith(':')
        const right = cell.endsWith(':') && cell.length > 1
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return 'none'
      })
  )
}

/**
 * East Asian Width 的 **W**（Wide）与 **F**（Fullwidth）区间，都算两格。
 *
 * 口径说明：emoji 那几块按 Unicode 的 `Emoji_Presentation` 归进来（它们在终端与
 * WKWebView 里都画成两格）；**Ambiguous 不在这里**，理由见文件头。
 * 区间按起点升序排，`isWide` 靠这一点提前退出
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // 谚文字母 Jamo 初声
  [0x2e80, 0x303e], // CJK 部首、康熙部首、CJK 符号与标点（含 U+3000 全角空格）
  [0x3041, 0x33ff], // 平假名、片假名、注音、谚文兼容字母、CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f], // 谚文字母 Jamo 扩展 A
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe10, 0xfe19], // 竖排形式
  [0xfe30, 0xfe6f], // CJK 兼容形式、小写变体
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角符号
  [0x16fe0, 0x16fe4], // 表意文字描述字符
  [0x17000, 0x18cff], // 西夏文、契丹小字
  [0x1b000, 0x1b2ff], // 假名补充与扩展
  [0x1f004, 0x1f004], // 麻将牌 中
  [0x1f0cf, 0x1f0cf], // 扑克牌 小丑
  [0x1f18e, 0x1f18e], // 带圈 AB
  [0x1f191, 0x1f19a], // 带圈 Squared 系列
  [0x1f200, 0x1f320], // 带圈表意文字补充、杂项符号与象形文字
  [0x1f32d, 0x1f335], // 热狗、仙人掌那一小段
  [0x1f337, 0x1f37c], // 郁金香到奶瓶
  [0x1f37e, 0x1f393], // 香槟到草莓
  [0x1f3a0, 0x1f3ca], // 旋转木马到游泳
  [0x1f3cf, 0x1f3d3], // 板球到乒乓
  [0x1f3e0, 0x1f3f0], // 房子到城堡
  [0x1f3f4, 0x1f3f4], // 黑旗
  [0x1f3f8, 0x1f43e], // 羽毛球到爪印
  [0x1f440, 0x1f440], // 眼睛
  [0x1f442, 0x1f4fc], // 耳朵到录像带
  [0x1f4ff, 0x1f53d], // 念珠到向下小三角
  [0x1f54b, 0x1f54e], // 卡巴到梅诺拉
  [0x1f550, 0x1f567], // 钟面
  [0x1f57a, 0x1f57a], // 跳舞的男人
  [0x1f595, 0x1f596], // 中指、瓦肯举手礼
  [0x1f5a4, 0x1f5a4], // 黑心
  [0x1f5fb, 0x1f64f], // 富士山到双手合十
  [0x1f680, 0x1f6c5], // 火箭到行李
  [0x1f6cc, 0x1f6cc], // 床上的人
  [0x1f6d0, 0x1f6d2], // 礼拜处到购物车
  [0x1f6d5, 0x1f6d7], // 印度教神庙到电梯
  [0x1f6eb, 0x1f6ec], // 起飞、降落
  [0x1f6f4, 0x1f6fc], // 滑板到轮滑鞋
  [0x1f7e0, 0x1f7eb], // 彩色几何块
  [0x1f90c, 0x1f93a], // 捏手指到击剑
  [0x1f93c, 0x1f945], // 摔跤到球门
  [0x1f947, 0x1f9ff], // 奖牌到护身符
  [0x1fa70, 0x1faff], // 芭蕾鞋到最后一个象形文字
  [0x20000, 0x3fffd], // CJK 扩展 B 及以后
]

/**
 * 宽度为 **0** 的码位：组合符号、零宽字符、变体选择符。
 *
 * 🔴 `U+FE00–U+FE0F`（变体选择符）必须在这里：它**修饰**前一个字符，自己不占格。
 * `❤️` 是 `U+2764 U+FE0F` 两个码位而屏幕上只有一个字形，漏了这一段就会算成两格
 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // 软连字符
  [0x0300, 0x036f], // 组合用变音符号
  [0x0483, 0x0489], // 西里尔组合符号
  [0x0591, 0x05bd], // 希伯来文点
  [0x1160, 0x11ff], // 谚文字母 Jamo 中声与终声
  [0x1ab0, 0x1aff], // 组合用变音符号补充
  [0x1dc0, 0x1dff], // 组合用变音符号补充
  [0x200b, 0x200f], // 零宽空格/连接符、方向标记
  [0x2060, 0x2064], // 词连接符、不可见运算符
  [0x20d0, 0x20f0], // 组合用变音符号（符号那一类）
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfe20, 0xfe2f], // 组合用半符号
  [0xfeff, 0xfeff], // 零宽不换行空格
  [0xe0100, 0xe01ef], // 变体选择符补充
]

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [from, to] of ranges) {
    if (code < from) return false
    if (code <= to) return true
  }
  return false
}

/**
 * 一段文本占几个字符格。
 *
 * ⚠️ 用 `for…of` 而不是下标遍历：那才会按**码位**走，一个代理对算一个字符。
 * 按下标走的话 `𠀀`（U+20000）会被当成两个各占两格的字符，算出四格
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === undefined) continue
    if (inRanges(code, ZERO_WIDTH_RANGES)) continue
    width += inRanges(code, WIDE_RANGES) ? 2 : 1
  }
  return width
}

/** 把单元格补到 `width` 格。多出来的那一格给右边（居中时 `extra` 为奇数才会遇到） */
export function padCell(text: string, width: number, align: Align): string {
  const extra = width - displayWidth(text)
  if (extra <= 0) return text
  switch (align) {
    case 'right':
      return ' '.repeat(extra) + text
    case 'center': {
      const left = Math.floor(extra / 2)
      return ' '.repeat(left) + text + ' '.repeat(extra - left)
    }
    case 'none':
    case 'left':
      return text + ' '.repeat(extra)
  }
}

/** 分隔行的一格：把 `-` 拉到同宽，冒号留在它原来那一侧 */
export function delimiterCell(width: number, align: Align): string {
  const total = Math.max(width, MIN_CELL_WIDTH)
  switch (align) {
    case 'left':
      return ':' + '-'.repeat(total - 1)
    case 'right':
      return '-'.repeat(total - 1) + ':'
    case 'center':
      return ':' + '-'.repeat(total - 2) + ':'
    case 'none':
      return '-'.repeat(total)
  }
}

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let child = node.firstChild; child !== null; child = child.nextSibling) out.push(child)
  return out
}

/**
 * 一行里的那些单元格文本，**已经 trim 过**。
 *
 * 🔴 不能数 `TableCell` 子节点的个数：实测（真的 `markdownLanguage.parser`）
 * `|  甲  |   |` 这一行只有一个 `TableCell`——**空单元格压根没有节点**。
 * 所以要以行内的 `TableDelimiter`（竖线）为界切段，一段里有没有 `TableCell`
 * 决定它是空格子还是有内容
 *
 * ⚠️ 首尾那两段只有在**没有**外侧竖线时才是单元格：`a|b` 是两格，`| a | b |` 也是两格，
 * 而 `| a | b |` 的首尾各有一个空段，留着的话每行都会多出两列
 */
function cellsOf(row: SyntaxNode, slice: (from: number, to: number) => string): string[] {
  const kids = childrenOf(row)
  const segments: SyntaxNode[][] = [[]]
  let leadingPipe = false
  let trailingPipe = false
  kids.forEach((kid, index) => {
    if (kid.name !== 'TableDelimiter') {
      segments[segments.length - 1]!.push(kid)
      return
    }
    if (index === 0) leadingPipe = true
    if (index === kids.length - 1) trailingPipe = true
    segments.push([])
  })
  const inner = leadingPipe ? segments.slice(1) : segments
  const kept = trailingPipe ? inner.slice(0, -1) : inner
  return kept.map((segment) =>
    segment
      .filter((node) => node.name === 'TableCell')
      .map((node) => slice(node.from, node.to).trim())
      .join(''),
  )
}

/**
 * 光标处那张表的节点。找不到回 `null`。
 *
 * ⚠️ 两个方向都试一次：光标常常正好停在表格最后一个 `|` **之后**（刚敲完一行就按对齐）。
 * 实测（真的 `markdownLanguage.parser`）那一下 `resolveInner(pos, 1)` 给的是 `Document`，
 * 只有 `-1` 那侧才落在 `TableDelimiter > TableRow > Table` 上。只查一边的症状是
 * 「明明在表格里，却说这儿没有」，而且偏偏出在这个最常见的时机
 */
export function tableAt(tree: Tree, pos: number): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node !== null; node = node.parent) {
      if (node.name === 'Table') return node
    }
  }
  return null
}

/** 表里的一部分：一行（`cells` 是它的单元格），或者分隔行（`cells` 为 `null`） */
interface TablePart {
  node: SyntaxNode
  cells: string[] | null
}

/**
 * 对齐一张表（纯函数：认 Lezer 的树与一份取文本的函数，⛔ 不认识 CM6）。
 *
 * 认 CM6 的那一半是下面的 `alignTableAt`，分工与 `render.ts` / `preview.ts` 一样
 */
export function alignTable(table: SyntaxNode, slice: (from: number, to: number) => string): AlignResult {
  const parts: TablePart[] = []
  let aligns: Align[] | null = null

  // ⚠️ 先收齐再算宽度：每一列要多宽取决于**所有**行，边遍历边重排的话
  // 头几行用的是只看过自己那一行的宽度
  for (const child of childrenOf(table)) {
    // 🔴 同一个节点名在两层里意思完全不同：**顶层**的 `TableDelimiter` 是分隔行
    // （`|---|---|`），而**行内**的 `TableDelimiter` 是竖线。这里只会拿到顶层的
    if (child.name === 'TableDelimiter') {
      if (aligns === null) aligns = parseAlignments(slice(child.from, child.to))
      parts.push({ node: child, cells: null })
      continue
    }
    if (child.name === 'TableHeader' || child.name === 'TableRow') {
      parts.push({ node: child, cells: cellsOf(child, slice) })
    }
  }

  // 分隔行是 GFM 表格的必要条件，而它的列数**就是**这张表的列数（理由见文件头 ⛔ 那一段）
  if (aligns === null || aligns.length === 0) return { kind: 'noTable' }
  const columns = aligns.length

  const cellCount = parts.reduce((max, part) => Math.max(max, part.cells?.length ?? 0), columns)
  const widths: number[] = Array.from({ length: cellCount }, () => MIN_CELL_WIDTH)
  for (const part of parts) {
    part.cells?.forEach((cell, index) => {
      const width = displayWidth(cell)
      if (index < widths.length && width > (widths[index] ?? MIN_CELL_WIDTH)) widths[index] = width
    })
  }

  const changes: TableChange[] = []
  for (const part of parts) {
    const insert =
      part.cells === null ? renderDelimiter(aligns, widths) : renderRow(part.cells, widths, aligns, columns)
    if (insert !== slice(part.node.from, part.node.to)) {
      changes.push({ from: part.node.from, to: part.node.to, insert })
    }
  }
  return changes.length === 0 ? { kind: 'aligned' } : { kind: 'changes', changes }
}

function renderRow(
  cells: readonly string[],
  widths: readonly number[],
  aligns: readonly Align[],
  columns: number,
): string {
  // 少于分隔行就补空格单元（GFM 本来也渲染成空 `<td>`）；多出来的**一个都不删**
  const count = Math.max(cells.length, columns)
  const rendered: string[] = []
  for (let index = 0; index < count; index++) {
    const text = cells[index] ?? ''
    rendered.push(padCell(text, Math.max(widths[index] ?? MIN_CELL_WIDTH, displayWidth(text)), aligns[index] ?? 'none'))
  }
  return `| ${rendered.join(' | ')} |`
}

function renderDelimiter(aligns: readonly Align[], widths: readonly number[]): string {
  return `| ${aligns.map((align, index) => delimiterCell(widths[index] ?? MIN_CELL_WIDTH, align)).join(' | ')} |`
}

/**
 * 对齐 `state` 里 `pos` 处那张表。
 *
 * ⚠️ 解析预算用完时退回半截树（与 `goto/syntax.ts` 同一条取舍）：宁可少对齐几行，
 * 也不能让「按了一下什么都没发生」成为大文件上的常态
 */
export function alignTableAt(state: EditorState, pos: number): AlignResult {
  const tree = ensureSyntaxTree(state, state.doc.length, ALIGN_PARSE_TIMEOUT_MS) ?? syntaxTree(state)
  const table = tableAt(tree, pos)
  if (table === null) return { kind: 'noTable' }
  return alignTable(table, (from, to) => state.sliceDoc(from, to))
}
