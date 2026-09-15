import { EditorState, type Extension } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { buildGuides } from './indentGuides'

/**
 * 只测 `buildGuides`，不测那个 ViewPlugin。
 *
 * 分档规则（tab 算一档、凑不满一档的零头不画、按 indentUnit 切）是这个模块里唯一有逻辑的
 * 部分，而它只依赖 EditorState；视口/余量那套记账住在 ./viewport，已经被 codeFontBySyntax
 * 在真实滚动下验过一遍了。这样切分还顺带绕开了 jsdom 没有布局引擎、`view.visibleRanges`
 * 不可信这件事——node 环境就够，测试也就快。
 */
function ranges(doc: string, unit = '  ', firstLine = 1, lastLine?: number): [number, number][] {
  const extensions: Extension[] = [indentUnit.of(unit)]
  const state = EditorState.create({ doc, extensions })
  const set = buildGuides(state, firstLine, lastLine ?? state.doc.lines)
  const out: [number, number][] = []
  for (const cursor = set.iter(); cursor.value; cursor.next()) out.push([cursor.from, cursor.to])
  return out
}

describe('缩进引导线的分档', () => {
  it('没有缩进的行一条线都不画', () => {
    expect(ranges('正文\n另一行')).toEqual([])
  })

  it('空文档不画', () => {
    expect(ranges('')).toEqual([])
  })

  it('两空格缩进（默认档宽）画一条，落在行首', () => {
    expect(ranges('  正文')).toEqual([[0, 2]])
  })

  it('四空格缩进画两条，分别在第 0 档与第 1 档的左边缘', () => {
    expect(ranges('    正文')).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it('只数行首空白，正文中间的空格不算缩进', () => {
    // '  a  b' → 只有开头两空格
    expect(ranges('  a  b')).toEqual([[0, 2]])
  })

  it('一个 tab 就是一整档，与档宽无关', () => {
    expect(ranges('\t正文')).toEqual([[0, 1]])
    expect(ranges('\t\t正文')).toEqual([
      [0, 1],
      [1, 2],
    ])
  })

  it('tab 与空格混排时各自成档', () => {
    expect(ranges('\t  正文')).toEqual([
      [0, 1],
      [1, 3],
    ])
  })

  it('凑不满一档的零头不画：3 空格 + 档宽 2 → 只有一档', () => {
    // 硬画出来的线会随字体宽度漂，不如不画
    expect(ranges('   正文')).toEqual([[0, 2]])
  })

  it('1 空格 + 档宽 2 → 一条都不画', () => {
    expect(ranges(' 正文')).toEqual([])
  })

  it('档宽改成 4 空格时按 4 切', () => {
    expect(ranges('        正文', '    ')).toEqual([
      [0, 4],
      [4, 8],
    ])
    expect(ranges('      正文', '    ')).toEqual([[0, 4]])
  })

  it('整行都是空白时照样画（引导线要能穿过空行连起来）', () => {
    expect(ranges('a\n    \nb')).toEqual([
      [2, 4],
      [4, 6],
    ])
  })

  it('多行时范围严格升序——RangeSetBuilder 要求，违反会直接抛', () => {
    // 行起点：第 1 行 0、第 2 行 4、第 3 行 10（无缩进）、第 4 行 12
    const result = ranges('  a\n    b\nc\n      d')
    expect(result).toEqual([
      [0, 2],
      [4, 6],
      [6, 8],
      [12, 14],
      [14, 16],
      [16, 18],
    ])
    const sorted = [...result].sort((x, y) => x[0] - y[0] || x[1] - y[1])
    expect(result).toEqual(sorted)
  })

  it('firstLine / lastLine 界定作用范围，范围外的行不画', () => {
    // 三行都缩进两格，只要第 2 行
    expect(ranges('  a\n  b\n  c', '  ', 2, 2)).toEqual([[4, 6]])
  })

  it('indentUnit 是 tab 时，tab 与空格都按「一个字符一档」处理', () => {
    // 这是个退化配置，规则本身自洽即可：不崩、不乱序
    expect(ranges('\t \t正文', '\t')).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
  })
})
