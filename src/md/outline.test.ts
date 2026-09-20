import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { symbolTable } from '../goto/syntax'
import type { DocSymbol } from '../goto/symbols'
import { OUTLINE_ROW_HEIGHT, flattenOutline, pruneFold, toggleFold } from './outline'

/** `DocSymbol` 只要三样东西，手写比造文档直观；造文档那条路留给最后一组用例 */
function h(level: number, name: string, pos = 0): DocSymbol {
  return { level, name, pos }
}

/** 与 `src/goto/syntax.test.ts` 同一个办法：真的 `EditorState`，node 环境里跑得起来 */
function fromMarkdown(source: string): DocSymbol[] {
  const state = EditorState.create({
    doc: source,
    extensions: markdown({ base: markdownLanguage, codeLanguages: languages }),
  })
  const table = symbolTable(state, 'a.md')
  if (table.kind !== 'headings') throw new Error('不是 Markdown')
  return [...table.items]
}

const NO_FOLD: ReadonlySet<string> = new Set()

/** 把行数组压成 `名字@深度` 的串，断言起来一眼看得出形状 */
function shape(headings: readonly DocSymbol[], folded: ReadonlySet<string> = NO_FOLD): string {
  return flattenOutline(headings, folded)
    .map((row) => `${row.name}@${row.depth}${row.folded ? '(收起)' : ''}`)
    .join(' ')
}

describe('层级', () => {
  it('空文档 → 空数组，不是一行占位', () => {
    expect(flattenOutline([], NO_FOLD)).toEqual([])
  })

  it('同级的是兄弟，都在第 0 层', () => {
    expect(shape([h(1, '甲'), h(1, '乙')])).toBe('甲@0 乙@0')
  })

  it('父子按级别缩进', () => {
    expect(shape([h(1, 'A'), h(2, 'B'), h(2, 'C'), h(1, 'D')])).toBe('A@0 B@1 C@1 D@0')
  })

  it('🔴 跳级不会空出一格：`# 甲` 后面直接跟 `### 丙`，丙是甲的第一个子项', () => {
    // 按级别缩进的话这里会是 `丙@2`，面板上左边空一格什么都没有
    expect(shape([h(1, '甲'), h(3, '丙')])).toBe('甲@0 丙@1')
  })

  it('整篇只用 ## / ### 时从第 0 层起步', () => {
    expect(shape([h(2, '甲'), h(3, '乙')])).toBe('甲@0 乙@1')
  })

  it('⚠️ 跳级之后回到中间级别：`### 丙` 与 `## 乙` 是兄弟，不是父子', () => {
    expect(shape([h(1, 'A'), h(3, 'C'), h(2, 'B')])).toBe('A@0 C@1 B@1')
  })

  it('从第 6 级直接回到第 1 级', () => {
    expect(shape([h(6, '深'), h(1, '浅')])).toBe('深@0 浅@0')
  })

  it('level 保留作者写的那个，⛔ 不被 depth 覆盖', () => {
    const rows = flattenOutline([h(1, 'A'), h(3, 'C')], NO_FOLD)
    expect(rows.map((row) => row.level)).toEqual([1, 3])
    expect(rows.map((row) => row.depth)).toEqual([0, 1])
  })

  it('文档顺序原样保留，pos 一并带过来', () => {
    const rows = flattenOutline([h(1, '甲', 40), h(2, '乙', 7), h(1, '丙', 99)], NO_FOLD)
    expect(rows.map((row) => row.pos)).toEqual([40, 7, 99])
  })
})

describe('hasChildren', () => {
  it('只有真有子标题的行才画箭头', () => {
    const rows = flattenOutline([h(1, 'A'), h(2, 'B'), h(2, 'C'), h(1, 'D')], NO_FOLD)
    expect(rows.map((row) => row.hasChildren)).toEqual([true, false, false, false])
  })

  it('跳级也算有子项', () => {
    const rows = flattenOutline([h(1, 'A'), h(4, 'D')], NO_FOLD)
    expect(rows.map((row) => row.hasChildren)).toEqual([true, false])
  })

  it('🔴 收起之后 hasChildren 仍然是 true，否则箭头消失、再也展不开', () => {
    const headings = [h(1, 'A'), h(2, 'B')]
    const folded = new Set(flattenOutline(headings, NO_FOLD)[0]!.key)
    const rows = flattenOutline(headings, folded)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.hasChildren).toBe(true)
    expect(rows[0]?.folded).toBe(true)
  })

  it('最后一个标题不会有子项', () => {
    const rows = flattenOutline([h(1, 'A'), h(2, 'B'), h(1, 'Z')], NO_FOLD)
    expect(rows[rows.length - 1]?.hasChildren).toBe(false)
  })
})

describe('折叠', () => {
  const HEADINGS = [h(1, 'A'), h(2, 'B'), h(3, 'C'), h(2, 'E'), h(1, 'D')]

  function keys(headings: readonly DocSymbol[] = HEADINGS): string[] {
    return flattenOutline(headings, NO_FOLD).map((row) => row.key)
  }

  it('收起一个父项，整个子树消失，兄弟还在', () => {
    expect(shape(HEADINGS, new Set(['A']))).toBe('A@0(收起) D@0')
  })

  it('收起中间一层，只吞它自己那棵子树', () => {
    expect(shape(HEADINGS, new Set(['A\nB']))).toBe('A@0 B@1(收起) E@1 D@0')
  })

  it('🔴 父项与子项都收着时，只展开父项，子项**仍然**是收起的', () => {
    // 这条钉的是「嵌套折叠不能被展开父项这个动作顺手清掉」。
    // 清了的话用户的表现是：我明明收着 C，展开 A 之后 C 自己摊开了
    expect(shape(HEADINGS, new Set(['A', 'A\nB']))).toBe('A@0(收起) D@0')
    expect(shape(HEADINGS, new Set(['A\nB']))).toBe('A@0 B@1(收起) E@1 D@0')
  })

  it('折叠状态认的是 key，不是行号：文档前面插一个标题，收起的还是原来那一节', () => {
    const shifted = [h(1, '新的'), ...HEADINGS]
    expect(shape(shifted, new Set(['A']))).toBe('新的@0 A@0(收起) D@0')
    expect(keys(shifted)).toContain('A')
  })

  it('⚠️ 收起的键不存在时不报错，也不影响别的行', () => {
    expect(shape(HEADINGS, new Set(['没有这个标题']))).toBe('A@0 B@1 C@2 E@1 D@0')
  })
})

describe('key', () => {
  it('根层的键就是标题名，子项的键带上祖先链', () => {
    const rows = flattenOutline([h(1, 'A'), h(2, 'B'), h(3, 'C')], NO_FOLD)
    expect(rows.map((row) => row.key)).toEqual(['A', 'A\nB', 'A\nB\nC'])
  })

  it('🔴 同名兄弟各自唯一，折叠一个不会带走另一个', () => {
    // `## 用法` 出现在每个章节下面是极常见的写法。共用一个键的话收起其中一个
    // 会把所有同名的兄弟一起收起来，而用户看不出这是怎么发生的
    const headings = [h(1, 'A'), h(2, '用法'), h(1, 'B'), h(2, '用法')]
    const rows = flattenOutline(headings, NO_FOLD)
    expect(rows.map((row) => row.key)).toEqual(['A', 'A\n用法', 'B', 'B\n用法'])
    // ⚠️ 收起的那一行**自己还在**（不然就再也展不开了），消失的是它的子树。
    // 这条用例真正要证的是最后那个 `B\n用法`：它没被 A 下面那个同名兄弟带走
    expect(shape(headings, new Set(['A\n用法']))).toBe('A@0 用法@1(收起) B@0 用法@1')
  })

  it('同一个父项下连着三个同名兄弟也分得开', () => {
    const rows = flattenOutline([h(1, 'A'), h(2, 'X'), h(2, 'X'), h(2, 'X')], NO_FOLD)
    expect(rows.map((row) => row.key)).toEqual(['A', 'A\nX', 'A\nX\n#1', 'A\nX\n#2'])
    expect(new Set(rows.map((row) => row.key)).size).toBe(4)
  })

  it('键与 pos 无关：整篇偏移量都变了，键一个都没变', () => {
    // 这是「拿 pos 当键会在打字时把折叠状态全丢掉」那个决定的正面版本
    const before = flattenOutline([h(1, 'A', 0), h(2, 'B', 4)], NO_FOLD)
    const after = flattenOutline([h(1, 'A', 100), h(2, 'B', 104)], NO_FOLD)
    expect(after.map((row) => row.key)).toEqual(before.map((row) => row.key))
  })

  it('整份大纲的键互不相同', () => {
    const rows = flattenOutline([h(1, 'A'), h(2, 'X'), h(1, 'B'), h(2, 'X'), h(2, 'X'), h(3, 'A'), h(1, 'A')], NO_FOLD)
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })
})

describe('toggleFold', () => {
  it('🔴 返回的是**新** Set，不是原来那个引用', () => {
    // Solid 的 memo 靠引用相等判断要不要重算。就地改再传回同一个引用的表现是
    // 「状态改了、界面没动」，而这类 bug 不会报错
    const before: ReadonlySet<string> = new Set(['A'])
    const after = toggleFold(before, 'B')
    expect(after).not.toBe(before)
    expect([...after].sort()).toEqual(['A', 'B'])
  })

  it('不改传进来的那一份', () => {
    const before = new Set(['A'])
    toggleFold(before, 'A')
    expect([...before]).toEqual(['A'])
  })

  it('再按一次就展开，回到原样', () => {
    const once = toggleFold(NO_FOLD, 'A')
    expect(once.has('A')).toBe(true)
    expect(toggleFold(once, 'A').size).toBe(0)
  })

  it('toggle 之后接 flatten，行数组真的少了一截', () => {
    const headings = [h(1, 'A'), h(2, 'B')]
    const folded = toggleFold(NO_FOLD, 'A')
    expect(shape(headings, folded)).toBe('A@0(收起)')
    expect(shape(headings, toggleFold(folded, 'A'))).toBe('A@0 B@1')
  })
})

describe('pruneFold', () => {
  const HEADINGS = [h(1, 'A'), h(2, 'B'), h(1, 'D')]

  it('没有失效键时返回**原来那个引用**，调用方可以拿 === 判断要不要更新', () => {
    const folded: ReadonlySet<string> = new Set(['A'])
    expect(pruneFold(folded, HEADINGS)).toBe(folded)
  })

  it('标题被改名之后，旧键被清掉', () => {
    const folded: ReadonlySet<string> = new Set(['A', '改名前'])
    const pruned = pruneFold(folded, HEADINGS)
    expect([...pruned]).toEqual(['A'])
  })

  it('🔴 收在**收起的子树里**的键不会被当成失效清掉', () => {
    // 这条是 pruneFold 收 headings 而不收 flattenOutline 输出的全部理由：
    // 后者已经跳过了收起的子树，拿它对账就会把 B 的键误判成失效
    const folded: ReadonlySet<string> = new Set(['A', 'A\nB'])
    expect(pruneFold(folded, HEADINGS)).toBe(folded)
    // 展开 A 之后 B 仍然是收起的
    expect(shape(HEADINGS, prunedAfter(folded, HEADINGS, 'A'))).toBe('A@0 B@1(收起) D@0')
  })

  it('空集合进去还是空集合', () => {
    expect(pruneFold(NO_FOLD, HEADINGS).size).toBe(0)
    expect(pruneFold(new Set(['什么都']), []).size).toBe(0)
  })
})

/** 「清一遍 → 展开一个」这个组合动作，只为上面那条用例读起来像人话 */
function prunedAfter(folded: ReadonlySet<string>, headings: readonly DocSymbol[], key: string): ReadonlySet<string> {
  return toggleFold(pruneFold(folded, headings), key)
}

describe('与真解析器接上', () => {
  it('一份真 Markdown 文档走完整条链路', () => {
    const source = ['# 甲', '', '正文。', '', '## 乙', '', '### 丙', '', '## 丁', '', '# 戊'].join('\n')
    const rows = flattenOutline(fromMarkdown(source), NO_FOLD)
    expect(rows.map((row) => [row.name, row.level, row.depth])).toEqual([
      ['甲', 1, 0],
      ['乙', 2, 1],
      ['丙', 3, 2],
      ['丁', 2, 1],
      ['戊', 1, 0],
    ])
    // pos 是**能直接交给 reveal 的**偏移量：从它切出去就是那个标题
    for (const row of rows) {
      expect(source.slice(row.pos, row.pos + 1)).toBe('#')
    }
  })

  it('⚠️ 大纲与 `Cmd+R` 用的是同一份符号表，所以两边不可能对不上', () => {
    // 这条钉的是「outline.ts 不自己解析 Markdown」这个决定。哪天有人在这里加了
    // 一套正则标题提取，fromMarkdown 那条链路就不再是唯一的来源，而表现是
    // 「浮层里有的标题大纲里没有」——没法解释的那种分歧
    const source = '# 甲\n\n```\n# 围栏里的假标题\n```\n\n乙\n---\n'
    const items = fromMarkdown(source)
    expect(items.map((item) => item.name)).toEqual(['甲', '乙'])
    expect(flattenOutline(items, NO_FOLD).map((row) => row.name)).toEqual(['甲', '乙'])
  })

  it('Setext 与 ATX 混着也一致', () => {
    const rows = flattenOutline(fromMarkdown('甲\n===\n\n## 乙\n'), NO_FOLD)
    expect(rows.map((row) => [row.name, row.level, row.depth])).toEqual([
      ['甲', 1, 0],
      ['乙', 2, 1],
    ])
  })
})

describe('行高', () => {
  it('是正整数，虚拟滚动那套除法才成立', () => {
    expect(OUTLINE_ROW_HEIGHT).toBeGreaterThan(0)
    expect(Number.isInteger(OUTLINE_ROW_HEIGHT)).toBe(true)
  })
})
