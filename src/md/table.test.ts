import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { describe, expect, it } from 'vitest'
import {
  ALIGN_PARSE_TIMEOUT_MS,
  alignTable,
  alignTableAt,
  delimiterCell,
  displayWidth,
  padCell,
  parseAlignments,
  type AlignResult,
  type TableChange,
} from './table'

/**
 * 用的是**真的** `markdownLanguage.parser`，⛔ 不是手搓的假树（与 `render.test.ts` 同一条规矩）。
 *
 * 这一层每一个会咬人的细节都出在「树的真实形状与我以为的不一样」，而且都是打出来才看见的：
 * 空单元格**没有** `TableCell` 节点、表头比分隔行宽时压根不是 `Table`（是 `Paragraph`）、
 * 引用里的 `QuoteMark` 是 `Table` 的直接子节点、光标停在最后一个 `|` 之后时
 * `resolveInner(pos, 1)` 给的是 `Document`。假树只会证明「实现对了我以为的形状」。
 */

function parse(source: string) {
  return markdownLanguage.parser.parse(source)
}

/** 文档里第一张 `Table`（不管它嵌在引用、列表还是缩进里） */
function firstTable(source: string): SyntaxNode | null {
  const tree = parse(source)
  if (tree.topNode.name === 'Table') return tree.topNode
  const cursor = tree.cursor()
  while (cursor.next()) {
    if (cursor.name === 'Table') return cursor.node
  }
  return null
}

function alignFirst(source: string): AlignResult {
  const table = firstTable(source)
  if (table === null) return { kind: 'noTable' }
  return alignTable(table, (from, to) => source.slice(from, to))
}

/**
 * 把改动应用回源文本。**从后往前**：`TableChange` 的偏移是原文里的，
 * 先改前面的话后面几条的 `from`/`to` 就全错位了（CM6 自己会做这个映射，这里得手动）
 */
function applyChanges(source: string, changes: readonly TableChange[]): string {
  let out = source
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to)
  }
  return out
}

/** 对齐 + 应用。⚠️ 调用前必须先断言 `kind`，否则 `noTable` 会静默变成「原样返回」 */
function aligned(source: string): string {
  const result = alignFirst(source)
  return result.kind === 'changes' ? applyChanges(source, result.changes) : source
}

/** 一行里每根竖线落在第几个**显示列**上 */
function pipeColumns(line: string): number[] {
  const out: number[] = []
  let width = 0
  for (const char of line) {
    if (char === '|') out.push(width)
    width += displayWidth(char)
  }
  return out
}

/**
 * 「对齐了」的判定：每行显示宽度相同，而且竖线落在同一批显示列上。
 *
 * ⚠️ 这比逐字比对期望字符串强，也比它弱——强在「期望值也是我用同一套算法手推的」
 * 这种错会一起错，弱在它认的是 `displayWidth` 自己。所以 `displayWidth` 另有一组
 * **写死数字**的用例（下面第一个 describe），那组是地基，这一组是地基之上的形状
 */
function expectRectangular(table: string): void {
  const lines = table.replace(/\n$/, '').split('\n')
  const widths = lines.map(displayWidth)
  expect(new Set(widths).size, `每行显示宽度应当一致，实际是 ${JSON.stringify(widths)}`).toBe(1)
  const columns = lines.map(pipeColumns)
  for (const line of columns) expect(line).toEqual(columns[0])
}

function stateOf(source: string): EditorState {
  return EditorState.create({ doc: source, extensions: [markdown({ base: markdownLanguage })] })
}

// ───────────────────────── displayWidth ─────────────────────────

describe('displayWidth', () => {
  it('ASCII 一格，汉字两格', () => {
    expect(displayWidth('')).toBe(0)
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('甲乙')).toBe(4)
    expect(displayWidth('a甲b')).toBe(4)
  })

  it('全角标点、假名、谚文都是两格', () => {
    expect(displayWidth('，。！')).toBe(6)
    expect(displayWidth('　')).toBe(2) // 全角空格 U+3000
    expect(displayWidth('あア')).toBe(4)
    expect(displayWidth('한글')).toBe(4)
  })

  it('组合符号与零宽字符算 0', () => {
    expect(displayWidth('e\u0301')).toBe(1) // é 拆成 e + 组合重音
    expect(displayWidth('\u200b')).toBe(0)
    expect(displayWidth('\ufeff')).toBe(0)
    expect(displayWidth('\u200d')).toBe(0)
  })

  it('🔴 变体选择符算 0：`❤️` 是两个码位一个字形', () => {
    expect(displayWidth('\ufe0f')).toBe(0)
    expect(displayWidth('\u2764\ufe0f')).toBe(displayWidth('\u2764'))
  })

  it('emoji 两格', () => {
    expect(displayWidth('🎉')).toBe(2)
    expect(displayWidth('😀')).toBe(2)
    expect(displayWidth('👍')).toBe(2)
  })

  it('⚠️ Ambiguous 一律算一格（PLAN.md R10 那个已知取舍）', () => {
    expect(displayWidth('±')).toBe(1)
    expect(displayWidth('×')).toBe(1)
    expect(displayWidth('─')).toBe(1) // 制表符：在 CJK 字体里常常画成两格，这里不认
    expect(displayWidth('①')).toBe(1)
    expect(displayWidth('α')).toBe(1)
  })

  it('🔴 代理对按码位走，不是按 UTF-16 单元', () => {
    expect('𠀀'.length).toBe(2) // 下标遍历会把它当成两个字符，于是算出四格
    expect(displayWidth('𠀀')).toBe(2)
  })
})

// ───────────────────────── parseAlignments ─────────────────────────

describe('parseAlignments', () => {
  it('冒号位置决定对齐', () => {
    expect(parseAlignments('|:---|---:|:---:|---|')).toEqual(['left', 'right', 'center', 'none'])
  })

  it('⚠️ 省略首尾竖线的写法也能解析', () => {
    // 无脑 slice(1,-1) 的话这里会少两列
    expect(parseAlignments('---|:--:')).toEqual(['none', 'center'])
  })

  it('畸形分隔行不炸，有几个算几个', () => {
    expect(parseAlignments('|:|')).toEqual(['left'])
    expect(parseAlignments('')).toEqual([])
    expect(parseAlignments('|')).toEqual([])
  })
})

// ───────────────────────── padCell / delimiterCell ─────────────────────────

describe('padCell', () => {
  it('按对齐方式把空格放到对应那一侧', () => {
    expect(padCell('甲', 6, 'left')).toBe('甲    ')
    expect(padCell('甲', 6, 'none')).toBe('甲    ')
    expect(padCell('甲', 6, 'right')).toBe('    甲')
  })

  it('居中时多出来的那一格给右边', () => {
    // extra = 7 - 2 = 5，左边 floor(5/2)=2、右边 3
    expect(padCell('甲', 7, 'center')).toBe('  甲   ')
    expect(displayWidth(padCell('甲', 7, 'center'))).toBe(7)
  })

  it('已经够宽就一个字符都不动（⛔ 绝不截断）', () => {
    expect(padCell('abc', 2, 'left')).toBe('abc')
    expect(padCell('中文名字很长', 3, 'right')).toBe('中文名字很长')
  })
})

describe('delimiterCell', () => {
  it('把 `-` 拉到同宽，冒号留在原来那一侧', () => {
    expect(delimiterCell(5, 'none')).toBe('-----')
    expect(delimiterCell(5, 'left')).toBe(':----')
    expect(delimiterCell(5, 'right')).toBe('----:')
    expect(delimiterCell(5, 'center')).toBe(':---:')
  })

  it('窄到放不下 `:-:` 时钳到三格', () => {
    // 🔴 不钳的话 `'-'.repeat(-1)` 会抛 RangeError，而 release 下 Rust 那边的口径是
    // 「任何越界都带走整个进程」——前端这条同样不能让一次按键炸掉
    expect(delimiterCell(1, 'center')).toBe(':-:')
    expect(delimiterCell(0, 'left')).toBe(':--')
    expect(delimiterCell(2, 'none')).toBe('---')
  })
})

// ───────────────────────── alignTable ─────────────────────────

describe('alignTable', () => {
  it('按每列最宽的那一格补齐，分隔行同宽', () => {
    const source = '| a | bb |\n|---|---|\n| ccc | d |\n'
    expect(aligned(source)).toBe('| a   | bb  |\n| --- | --- |\n| ccc | d   |\n')
  })

  it('🔴 中文表格按**显示宽度**对齐，不是按字符数', () => {
    const source = '| 名字 | 数量 |\n|---|---:|\n| 中文名字很长 | 12 |\n'
    const out = aligned(source)
    expect(out).toContain('| 中文名字很长 |')
    expect(out).toContain('| ---: |') // 右对齐的冒号留在右边
    expect(out).toContain('| ------------ |') // 12 格，与「中文名字很长」同宽
    expectRectangular(out)
    // 按字符数对齐的话会是这样：三行分别是 13/11/15 个字符，看着「齐」其实歪了 4 格
    expect(
      new Set(
        out
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => line.length),
      ).size,
    ).toBeGreaterThan(1)
  })

  it('三种对齐各自保留', () => {
    const source = '|甲|乙|丙|\n|:-|:-:|-:|\n|1|22|333|\n'
    expect(aligned(source)).toBe('| 甲  | 乙  |  丙 |\n| :-- | :-: | --: |\n| 1   | 22  | 333 |\n')
  })

  it('🔴 空单元格也算一列（它没有 `TableCell` 节点）', () => {
    // 数节点个数的话这张表会被当成只有一列，于是第二列整个消失
    const source = '| 甲 |   |\n|---|---|\n| 1 | 22 |\n'
    expect(aligned(source)).toBe('| 甲  |     |\n| --- | --- |\n| 1   | 22  |\n')
  })

  it('⚠️ 省略外侧竖线的写法：补齐竖线', () => {
    // 第二列是 `:-:`（居中），所以 `2` 两边各一格；`乙` 是两格宽，多出来的那一格给右边
    const source = '甲|乙\n---|:-:\n1|2\n'
    expect(aligned(source)).toBe('| 甲  | 乙  |\n| --- | :-: |\n| 1   |  2  |\n')
  })

  it('⛔ 数据行比分隔行**少**：补空格单元（GFM 本来也渲染成空 `<td>`）', () => {
    const source = '| a | b |\n|---|---|\n| 1 |\n'
    expect(aligned(source)).toBe('| a   | b   |\n| --- | --- |\n| 1   |     |\n')
  })

  it('⛔ 数据行比分隔行**多**：一格都不删，分隔行照它自己的列数', () => {
    /**
     * 这条是文件头那个 ⛔ 的验收：分隔行只有两列，GFM 渲染时会把 `c` / `3` **丢掉**。
     * 「顺手补成三列」看着更整齐，但那会让本来不显示的内容显示出来——
     * 一个格式化命令不该改文档的意思
     */
    const source = '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n'
    expect(aligned(source)).toBe('| a   | b   |\n| --- | --- |\n| 1   | 2   | 3   |\n')
    expect(pipeColumns(aligned(source).split('\n')[1] ?? '')).toHaveLength(3) // 分隔行还是两根竖线
  })

  it('已经对齐的表回 `aligned`，一个字节都不改', () => {
    const done = '| a   | bb  |\n| --- | --- |\n| ccc | d   |\n'
    expect(alignFirst(done)).toEqual({ kind: 'aligned' })
    expect(aligned(done)).toBe(done)
  })

  it('对齐是幂等的：再来一次什么也不做', () => {
    const once = aligned('| 名字 | 数量 |\n|---|---:|\n| 中文名字很长 | 12 |\n')
    expect(alignFirst(once)).toEqual({ kind: 'aligned' })
    expect(aligned(once)).toBe(once)
  })

  it('引用里的表：行首的 `> ` 留在原处', () => {
    const source = '> | a | b |\n> |---|---|\n> | 1 | 22 |\n'
    expect(aligned(source)).toBe('> | a   | b   |\n> | --- | --- |\n> | 1   | 22  |\n')
  })

  it('列表项里的表：两格缩进留在原处', () => {
    const source = '- 项目\n\n  | a | b |\n  |---|---|\n  | 1 | 22 |\n'
    expect(aligned(source)).toBe('- 项目\n\n  | a   | b   |\n  | --- | --- |\n  | 1   | 22  |\n')
  })

  it('表外的正文一个字符都不动', () => {
    const source = '# 标题\n\n前言。\n\n| a | bb |\n|---|---|\n\n后记。\n'
    const out = aligned(source)
    expect(out.startsWith('# 标题\n\n前言。\n\n')).toBe(true)
    expect(out.endsWith('\n\n后记。\n')).toBe(true)
  })

  it('表头比分隔行宽 → 那压根不是表格，回 `noTable`', () => {
    // 实测：GFM 要求分隔行不少于表头的列数，不满足时 Lezer 给的是 `Paragraph`。
    // 于是「对齐」不会去修一张坏表——修它就得增删单元格，正是上面那条 ⛔
    const source = '| a | b | c |\n|---|---|\n'
    expect(firstTable(source)).toBeNull()
    expect(alignFirst(source)).toEqual({ kind: 'noTable' })
  })

  it('正文里没有表 → `noTable`', () => {
    expect(alignFirst('# 标题\n\n正文，带一根竖线 | 就这样。\n')).toEqual({ kind: 'noTable' })
    expect(alignFirst('')).toEqual({ kind: 'noTable' })
  })
})

// ───────────────────────── alignTableAt ─────────────────────────

describe('alignTableAt', () => {
  const source = '# 标题\n\n| a | bb |\n|---|---|\n| ccc | d |\n'
  const tableStart = source.indexOf('| a')

  it('光标在表里 → 改动，偏移是**整篇文档**里的绝对偏移', () => {
    const result = alignTableAt(stateOf(source), tableStart + 3)
    expect(result.kind).toBe('changes')
    if (result.kind !== 'changes') return
    // App 是拿这些偏移直接 `view.dispatch` 的，差一个 `tableStart` 就会改到别的行上去
    expect(result.changes[0]?.from).toBe(tableStart)
    expect(applyChanges(source, result.changes)).toBe('# 标题\n\n| a   | bb  |\n| --- | --- |\n| ccc | d   |\n')
  })

  it('光标在标题上 → `noTable`', () => {
    expect(alignTableAt(stateOf(source), 2)).toEqual({ kind: 'noTable' })
  })

  it('🔴 光标停在最后一个 `|` 之后（刚敲完一行）也认得出来', () => {
    const bare = '| a | bb |\n|---|---|\n| ccc | d |'
    // `resolveInner(pos, 1)` 在这儿给的是 `Document`，只有 `-1` 那侧进得去（见 tableAt 的注释）
    expect(alignTableAt(stateOf(bare), bare.length).kind).toBe('changes')
  })

  it('光标在表格后面那个空行上 → `noTable`', () => {
    expect(alignTableAt(stateOf(`${source}\n后记。\n`), source.length + 1)).toEqual({ kind: 'noTable' })
  })

  it('文档里只有一张表时，光标在哪一行都指向它', () => {
    const state = stateOf(source)
    for (const offset of [0, 1, 2]) {
      const pos = tableStart + offset
      expect(alignTableAt(state, pos).kind).toBe('changes')
    }
  })
})

describe('常量', () => {
  it('解析预算与 `Cmd+R` 的符号表同一个数（按键级预算，不是防抖）', () => {
    expect(ALIGN_PARSE_TIMEOUT_MS).toBe(50)
  })
})
