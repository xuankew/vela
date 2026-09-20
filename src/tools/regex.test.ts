import { describe, expect, it } from 'vitest'
import {
  collectMatches,
  compileRegex,
  expandReplacement,
  MAX_REGEX_HITS,
  normalizeFlags,
  regexReport,
  replaceWith,
  scanFlags,
  scanPattern,
} from './regex'

/** 编译一个正则，编译不了就把错误原话抛出来——用例里不想每处都判一次 `ok` */
function mustCompile(pattern: string, flags = ''): RegExp {
  const compiled = compileRegex(pattern, flags)
  if (!compiled.ok) throw new Error(`模式 /${pattern}/${flags} 编不出来：${compiled.error}`)
  return compiled.re
}

/**
 * `expect.stringContaining` 的返回型在 vitest 的类型里是 `any`，
 * 直接写进 `toEqual` 的对象字面量会撞 eslint 的 `no-unsafe-assignment`（16 处）。
 *
 * ⚠️ 用一层壳把它标成 `string`，而不是改成 `expect(found?.expected).toContain(…)`：
 * 那样每处要拆成两行，而「下标 + 那句话」本来是**一个**期望，
 * 拆开了就可能出现「下标对了、文案错了」却只红一行、看不出这一处到底断言了什么
 */
function containing(text: string): string {
  // ⚠️ 只断言一次（`as string`）：`any` 本来就能赋给 `unknown`，多写一层会撞
  // eslint 的 `no-unnecessary-type-assertion`
  return expect.stringContaining(text) as string
}

/** 只取编译失败那一支的文案；编译成功了就抛，于是「本该失败」写错的时候会红在这里 */
function compileError(pattern: string, flags = ''): string {
  const compiled = compileRegex(pattern, flags)
  if (compiled.ok) throw new Error(`模式 /${pattern}/${flags} 本该编不出来`)
  return compiled.error
}

describe('scanFlags', () => {
  it('合法的一串返回 null，空串也合法', () => {
    expect(scanFlags('')).toBeNull()
    expect(scanFlags('gimsu')).toBeNull()
    expect(scanFlags('i')).toBeNull()
  })

  it('空白在任何位置都被跳过，⛔ 不算一次报错', () => {
    expect(scanFlags(' i ')).toBeNull()
    expect(scanFlags('i m')).toBeNull()
    expect(scanFlags('\ti')).toBeNull()
  })

  it('🔴 y 单独一句话，因为它不是「不认识」而是「与列出全部互斥」', () => {
    expect(scanFlags('iy')).toEqual({ offset: 1, expected: containing('互斥') })
  })

  it('🔴 下标是**原串**里的，不是 trim 之后的', () => {
    // 报在 `  x` 的第 3 个字符上；剪掉前导空白的话这个 2 会变成 0，示意图就指错地方了
    expect(scanFlags('  x')).toEqual({ offset: 2, expected: containing('g i m s u') })
  })

  it('只报第一个问题', () => {
    expect(scanFlags('xy')).toEqual({ offset: 0, expected: containing('不认识') })
  })
})

describe('normalizeFlags', () => {
  it('一定带上 g，即使一个字都没打', () => {
    expect(normalizeFlags('')).toBe('g')
    expect(normalizeFlags('i')).toBe('ig')
  })

  it('去重、去空白', () => {
    expect(normalizeFlags('i i')).toBe('ig')
    expect(normalizeFlags('gi')).toBe('gi')
    expect(normalizeFlags(' m\ti ')).toBe('mig')
  })

  it('🔴 不排序：报告里那一句要能与用户格子里打的字对上', () => {
    expect(normalizeFlags('mi')).toBe('mig')
    expect(normalizeFlags('im')).toBe('img')
  })
})

describe('scanPattern', () => {
  it('合法的模式一条问题都没有', () => {
    for (const pattern of [
      'a',
      'a+',
      '(?:a|b)',
      '(?<year>\\d{4})',
      '(?=a)b',
      '(?<=a)b',
      '[a-z]+',
      'a\\*',
      '\\\\',
      // ⚠️ 「量词修饰环视」在 JS 里是**合法**的（实测 V8 编得出来），别把它当错例
      '(?=a)*',
    ]) {
      expect(scanPattern(pattern), pattern).toBeNull()
    }
  })

  it('落单的 \\ 报在末尾那一个上', () => {
    expect(scanPattern('ab\\')).toEqual({ offset: 2, expected: containing('反斜杠') })
  })

  it('没配对的 ( 报在**最里面**那一个上', () => {
    expect(scanPattern('(a(b')).toEqual({ offset: 2, expected: containing('左括号') })
    expect(scanPattern('(a|b')).toEqual({ offset: 0, expected: containing('左括号') })
  })

  it('没配对的 ) 报在它身上', () => {
    expect(scanPattern('a)b')).toEqual({ offset: 1, expected: containing('右括号') })
  })

  it('没结束的字符类报在 [ 上，不是报在末尾', () => {
    expect(scanPattern('x[a-z')).toEqual({ offset: 1, expected: containing('字符类') })
  })

  it('🔴 量词前面没有东西：开头、| 之后、( 之后、以及连续两个量词', () => {
    expect(scanPattern('*a')).toEqual({ offset: 0, expected: containing('量词') })
    expect(scanPattern('a|*b')).toEqual({ offset: 2, expected: containing('量词') })
    expect(scanPattern('(*a)')).toEqual({ offset: 1, expected: containing('量词') })
    expect(scanPattern('a**')).toEqual({ offset: 2, expected: containing('量词') })
    expect(scanPattern('a+?b')).toBeNull() // `+?` 是「惰性」，第二个 ? 跟在**原子**后面
  })

  it('🔴 惰性那个 ? 挂在量词后面是合法的，挂第二个不是', () => {
    expect(scanPattern('a+?')).toBeNull()
    expect(scanPattern('a*?b')).toBeNull()
    expect(scanPattern('a??')).toBeNull()
    expect(scanPattern('a{2,3}?')).toBeNull()
    expect(scanPattern('a+??')).toEqual({ offset: 3, expected: containing('量词') })
    expect(scanPattern('a???')).toEqual({ offset: 3, expected: containing('量词') })
    expect(scanPattern('a+*')).toEqual({ offset: 2, expected: containing('量词') })
  })

  it('🔴 `(?:` `(?=` `(?<name>` 里那个 ? 不是量词', () => {
    expect(scanPattern('(?:a)*')).toBeNull()
    expect(scanPattern('(?=a)')).toBeNull()
    expect(scanPattern('(?!a)')).toBeNull()
    expect(scanPattern('(?<=a)')).toBeNull()
    expect(scanPattern('(?<n>a)')).toBeNull()
  })

  it('🔴 字符类里面的东西一律不当语法看', () => {
    // `]` 结束它，`(` `)` `*` 在里面都是字面字符；转义要先走一步，于是 `[\]]` 是对的
    expect(scanPattern('[()]')).toBeNull()
    expect(scanPattern('[*+]')).toBeNull()
    expect(scanPattern('[\\]]')).toBeNull()
    expect(scanPattern('[]]')).toBeNull() // JS 里 `[]` 是空类、后面那个 `]` 是字面字符
  })

  it('⚠️ 它**少报**：查不出来的那些一律返回 null，把引擎的原话放过去', () => {
    // `a{2,1}`（区间写反了）与重复的具名分组，都不是这一份扫描器管的事
    expect(scanPattern('a{2,1}')).toBeNull()
    expect(scanPattern('(?<a>x)(?<a>y)')).toBeNull()
    expect(compileError('a{2,1}')).not.toContain('第 1 行')
    expect(compileError('(?<a>x)(?<a>y)')).not.toContain('第 1 行')
  })

  it('🔴 两万层不炸栈（扫描器是迭代的）', () => {
    expect(scanPattern('(a'.repeat(20_000))).toEqual({
      offset: 2 * 20_000 - 2,
      expected: containing('左括号'),
    })
  })
})

describe('compileRegex', () => {
  it('成功时把归一化之后的标志一起交出来', () => {
    const compiled = compileRegex('a+', 'i ')
    expect(compiled.ok).toBe(true)
    if (compiled.ok) {
      expect(compiled.flags).toBe('ig')
      expect(compiled.re.global).toBe(true)
      expect(compiled.re.ignoreCase).toBe(true)
    }
  })

  it('标志那一格的错画在**标志串**自己身上', () => {
    expect(compileError('a', 'iy')).toBe(
      '第 1 行第 2 列：黏性标志 `y` 与「列出全部匹配」互斥（它会让匹配停在第一处之后）\n  iy\n   ^',
    )
  })

  it('模式那一格的错画在**模式串**自己身上', () => {
    expect(compileError('(a')).toBe('第 1 行第 1 列：这个左括号没有配对的右括号\n  (a\n  ^')
  })

  it('🔴 引擎说错、扫描器说不出位置时，如实交出引擎那句原话', () => {
    // ⚠️ **不断言措辞**：vitest 跑在 Node（V8）上，而真机跑在 WKWebView（JavaScriptCore）上，
    // 两边的原话逐字不同（M3-B-2 在 `JSON.parse` 上已经踩过一次）。
    // 能钉住的是「交出去的是引擎那句、⛔ 不是我们自己画的那三行」——判据就是没有 `第 N 行第 N 列`
    expect(compileError('a{2,1}')).not.toContain('第 1 行')
    expect(compileError('a{2,1}')).not.toBe('')
  })
})

describe('collectMatches', () => {
  it('列出全部匹配，带行列与下标', () => {
    const { hits, more } = collectMatches(mustCompile('(\\w)(\\d)'), 'ab\nc1d2')
    expect(more).toBe(false)
    expect(hits.map((hit) => [hit.index, hit.text, hit.line, hit.column])).toEqual([
      [3, 'c1', 2, 1],
      [5, 'd2', 2, 3],
    ])
    expect(hits[0]!.groups).toEqual(['c', '1'])
  })

  it('跨多行时行号是累加出来的，⛔ 不是每处都从 0 数一遍', () => {
    const { hits } = collectMatches(mustCompile('x'), 'x\n\nx\nx')
    expect(hits.map((hit) => [hit.line, hit.column])).toEqual([
      [1, 1],
      [3, 1],
      [4, 1],
    ])
  })

  it('具名分组既在 groups 里占一个位置，也在 named 里', () => {
    const { hits } = collectMatches(mustCompile('(?<y>\\d+)'), 'x2024')
    expect(hits[0]!.groups).toEqual(['2024'])
    expect(hits[0]!.named).toEqual({ y: '2024' })
  })

  it('🔴 零长匹配自己往前挪一格，不会转不出来', () => {
    const { hits } = collectMatches(mustCompile('x*'), 'abc')
    expect(hits.map((hit) => [hit.index, hit.text])).toEqual([
      [0, ''],
      [1, ''],
      [2, ''],
      [3, ''],
    ])
  })

  it('🔴 撞上上限就停，并且只说「还有更多」不说总数', () => {
    const text = 'a'.repeat(MAX_REGEX_HITS + 1)
    const { hits, more } = collectMatches(mustCompile('a'), text)
    expect(hits).toHaveLength(MAX_REGEX_HITS)
    expect(more).toBe(true)
  })

  it('刚好在上限上时不算「还有更多」', () => {
    const { hits, more } = collectMatches(mustCompile('a'), 'a'.repeat(MAX_REGEX_HITS))
    expect(hits).toHaveLength(MAX_REGEX_HITS)
    expect(more).toBe(false)
  })

  it('🔴 自己归零 lastIndex：同一个 re 连跑两次结果一样', () => {
    const re = mustCompile('a')
    re.lastIndex = 99
    const first = collectMatches(re, 'aaa')
    const second = collectMatches(re, 'aaa')
    expect(first.hits).toHaveLength(3)
    expect(second.hits).toHaveLength(3)
  })
})

describe('replaceWith', () => {
  it('替换全部并数出几处', () => {
    const outcome = replaceWith(mustCompile('a'), 'banana', '-')
    expect(outcome).toEqual({ text: 'b-n-n-', count: 3 })
  })

  it('零长匹配也要替，与原生一致', () => {
    expect(replaceWith(mustCompile('x*'), 'abc', '-')).toEqual({ text: '-a-b-c-', count: 4 })
  })

  it('没有匹配时原样交回，count 是 0', () => {
    expect(replaceWith(mustCompile('z'), 'abc', '-')).toEqual({ text: 'abc', count: 0 })
  })
})

describe('expandReplacement', () => {
  /**
   * 🔴 差分表：同一组（输入 / 模式 / 模板）既跑这一份、也跑原生的 `String.prototype.replace`，
   * 两边必须逐字相等。
   *
   * 这一张表是 `expandReplacement` **唯一的凭据**。它写的时候参照的是规范里的
   * `GetSubstitution`，而规范这种东西记不准——尤其 `$12` 到底吃一个数字还是两个、
   * `$0` 算不算「整个匹配」、`$<名字>` 不存在时输出什么。⛔ 不靠记忆，靠对拍
   */
  const CASES: readonly (readonly [text: string, pattern: string, template: string])[] = [
    ['abc', 'b', '[$&]'],
    ['abc', 'b', '[$`]'],
    ['abc', 'b', "[$']"],
    ['abc', 'b', '[$$]'],
    ['abc', 'b', '[$]'],
    ['abc', 'b', '[$x]'],
    ['abc', 'b', '[$0]'],
    ['2024-03', '(\\d+)-(\\d+)', '$2/$1'],
    ['2024-03', '(\\d+)-(\\d+)', '$1$2'],
    ['abcdef', '(a)(b)(c)(d)(e)(f)', '$6$5$4'],
    ['abcdef', '(a)(b)(c)(d)(e)(f)(g)?(h)?(i)?(j)?(k)?(l)?', '$12'],
    ['abcdef', '(a)(b)(c)(d)(e)(f)(g)?(h)?(i)?(j)?(k)?(l)?', '$11'],
    ['abcdef', '(a)(b)(c)', '$9'],
    ['abcdef', '(a)(b)(c)', '$3x'],
    ['x=1', '(?<k>\\w)=(?<v>\\d)', '$<v>:$<k>'],
    ['x=1', '(?<k>\\w)=(?<v>\\d)', '$<nope>'],
    ['x=1', '(?<k>\\w)=(?<v>\\d)', '$<'],
    // 🔴 正则压根没有具名分组时，`$<x>` 同样展开成**空串**（规范：namedCaptures 是 undefined）
    ['abc', 'b', '$<x>'],
    ['x=1', '(a)|(b)', '[$1][$2]'], // 未参与的分组：原生给空串
    ['aaa', 'a', '$&$&'],
    ['a1b2', '\\d', '<$&>'],
    ['abc', 'b', '前$`后'],
    ['abc', 'b', '$&$'],
  ]

  for (const [text, pattern, template] of CASES) {
    it(`与原生 replace 逐字相等：${JSON.stringify([text, pattern, template])}`, () => {
      const re = new RegExp(pattern, 'g')
      const mine = replaceWith(new RegExp(pattern, 'g'), text, template)
      const native = text.replace(re, template)
      expect(mine.text).toBe(native)
      // 次数用另一条路核对：`matchAll` 数出来的匹配数
      expect(mine.count).toBe([...text.matchAll(new RegExp(pattern, 'g'))].length)
    })
  }

  it('具名分组在原生里也走 $<name>，两边一致', () => {
    const text = '2024-03-05'
    const pattern = '(?<y>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})'
    const template = '$<d>/$<m>/$<y>'
    expect(replaceWith(mustCompile(pattern), text, template).text).toBe(
      text.replace(new RegExp(pattern, 'g'), template),
    )
  })

  it('单独调 expandReplacement 时收的是那一份上下文', () => {
    expect(
      expandReplacement("[$&|$`|$'|$$|$1|$0|$<n>]", {
        match: 'B',
        groups: ['x'],
        named: { n: 'N' },
        offset: 1,
        text: 'ABC',
      }),
    ).toBe('[B|A|C|$|x|$0|N]')
  })
})

describe('regexReport', () => {
  it('🔴 空模式给 ok + 空串，⛔ 不是 200 处空匹配', () => {
    expect(regexReport('abc', '', '', '', 'list')).toEqual({ kind: 'ok', text: '' })
    expect(regexReport('abc', '', '', '', 'replace')).toEqual({ kind: 'ok', text: '' })
  })

  it('🔴 模式或标志写错时**不带** at：那两格不在输入格里，跳过去就是跳错地方', () => {
    const bad = regexReport('abc', '(a', '', '', 'list')
    expect(bad.kind).toBe('error')
    expect(bad.at).toBeUndefined()
    expect(regexReport('abc', 'a', 'y', '', 'list').at).toBeUndefined()
  })

  it('没有匹配时如实说一句，并且把正则回显出来', () => {
    expect(regexReport('abc', 'z', '', '', 'list')).toEqual({ kind: 'ok', text: '没有匹配\n正则：/z/g' })
  })

  it('匹配清单：抬头两行 + 每处三行起', () => {
    const result = regexReport('ab\nc1d2', '(\\w)(\\d)', '', '', 'list')
    expect(result.kind).toBe('ok')
    expect(result.text).toBe(
      [
        '匹配 2 处',
        '正则：/(\\w)(\\d)/g',
        '#1  第 2 行第 1 列 · 下标 3',
        '  命中：「c1」',
        '  $1：「c」',
        '  $2：「1」',
        '#2  第 2 行第 3 列 · 下标 5',
        '  命中：「d2」',
        '  $1：「d」',
        '  $2：「2」',
      ].join('\n'),
    )
  })

  it('🔴 跑成功也带 at = 第一处匹配的下标，于是「跳到第一处」按得动', () => {
    expect(regexReport('ab\nc1d2', '\\d', '', '', 'list').at).toBe(4)
  })

  it('没有分组时不多画那两行', () => {
    expect(regexReport('aa', 'a', '', '', 'list').text).toBe(
      [
        '匹配 2 处',
        '正则：/a/g',
        '#1  第 1 行第 1 列 · 下标 0',
        '  命中：「a」',
        '#2  第 1 行第 2 列 · 下标 1',
        '  命中：「a」',
      ].join('\n'),
    )
  })

  it('命中片段里的换行画成转义，⛔ 不真的换行（一处匹配必须还是一行）', () => {
    expect(regexReport('a\nb', '[\\s\\S]+', '', '', 'list').text).toContain('命中：「a\\nb」')
  })

  it('🔴 撞上上限时抬头写「以上」、末尾加一句「还有更多」，⛔ 不给一个假的总数', () => {
    const text = regexReport('a'.repeat(MAX_REGEX_HITS + 5), 'a', '', '', 'list').text
    // `hits.length` 是**列出来的**条数；写成 `匹配 200 处` 会被读成总数，而实际是 205
    expect(text.split('\n')[0]).toBe(`匹配 ${MAX_REGEX_HITS} 处以上`)
    expect(text).toContain(`…只列出前 ${MAX_REGEX_HITS} 处，后面还有更多`)
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(MAX_REGEX_HITS)
  })

  it('没撞上限的时候抬头就是一个准数，不带「以上」', () => {
    expect(regexReport('aaa', 'a', '', '', 'list').text.split('\n')[0]).toBe('匹配 3 处')
  })

  it('🔴 替换那一档的输出是**纯的**：没有抬头，于是可以原样插回编辑器', () => {
    const result = regexReport('banana', 'a', '', '-', 'replace')
    expect(result).toEqual({ kind: 'ok', text: 'b-n-n-' })
  })

  it('替换那一档不受清单上限影响：整份都会被替换', () => {
    const text = 'a'.repeat(MAX_REGEX_HITS + 5)
    expect(regexReport(text, 'a', '', '-', 'replace').text).toBe('-'.repeat(MAX_REGEX_HITS + 5))
  })

  it('替换那一档里「替换成」空着 = 全部删掉（这是原生的语义，跟着它）', () => {
    expect(regexReport('a1b2', '\\d', '', '', 'replace')).toEqual({ kind: 'ok', text: 'ab' })
  })

  it('标志会显示在抬头里，并且是归一化之后的那一串', () => {
    expect(regexReport('A', 'a', 'i ', '', 'list').text).toBe(
      '匹配 1 处\n正则：/a/ig\n#1  第 1 行第 1 列 · 下标 0\n  命中：「A」',
    )
  })
})
