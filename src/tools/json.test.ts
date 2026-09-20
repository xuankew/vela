import { describe, expect, it } from 'vitest'
import { blankJsonComments, scanJson, sortKeysDeep } from './json'
// ⚠️ 只为最后那一条「形状」用例引进来。方向是 `json.test.ts` → `tool.ts`，与 `json.ts` → `tool.ts`
// 同向，所以它没有让这一份测试替一条不存在的依赖背书。反过来（`tool.test.ts` 引 `scanJson`）
// 就会了，理由写在那一份的 `describeErrorAt` 上面
import { describeErrorAt } from './tool'

/**
 * `JSON.parse` 会不会抛。对账用例里当「真值」用的那一边。
 *
 * ⚠️ 这一份是**引擎**的口径，而 Vela 真机上的引擎是 JavaScriptCore、跑用例的是 V8。
 * 两者的**判定**（合不合法）是同一套 ECMAScript 规范，会分歧的只有错误**消息**——
 * 而消息正是我们压根不读的东西，理由写在 `json.ts` 的文件头
 */
function parses(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 合法的那些。⚠️ 每一个都真的能过 `JSON.parse`，这一条由下面的对账用例保证，不是假设 */
const VALID: readonly string[] = [
  '{}',
  '[]',
  '[[]]',
  '{"a":{}}',
  'null',
  'true',
  'false',
  '0',
  '-0',
  '1',
  '-1.5',
  '1e5',
  '1E+5',
  '1.5e-3',
  '""',
  '"a"',
  '"\\u0041"',
  '"\\/"',
  '"\\b\\f\\n\\r\\t"',
  '"😀"',
  '{"a":{"b":[1,2,{"c":null}]},"d":[[],{}]}',
  '  \n\t {}  \r\n',
  '[1,\n 2,\n 3]',
]

/** 不合法的那些。每一条都是一种**真实会被打出来**的错，不是为了覆盖率凑的 */
const INVALID: readonly string[] = [
  '',
  '   ',
  '{',
  '[',
  '{"a"',
  '{"a":',
  '{"a":1',
  '[1,2',
  '{a:1}',
  "{'a':1}",
  '{"a" 1}',
  '[1,]',
  '{"a":1,}',
  '[1 2]',
  '{"a":1}}',
  '[1,2]]',
  '{}{}',
  '01',
  '-01',
  '.5',
  '1.',
  '+1',
  '1e',
  '1e+',
  ',',
  ':',
  'tru',
  'nul',
  'NaN',
  'Infinity',
  '-Infinity',
  'undefined',
  '"abc',
  '"a\x01b"',
  '"a\\qb"',
  '"a\\u00"',
  '"a\\u00zz"',
  '"a\nb"',
  "'",
  '/*',
]

describe('scanJson：与 JSON.parse 对账', () => {
  it('🔴 说「没错」当且仅当 JSON.parse 不抛', () => {
    // 这一条是整个模块的地基：扫描器只在解析已经失败之后跑，
    // 而它说「我找不到错」的时候 `runJson` 会退回引擎那句原话。
    // 两边口径不一致的话，那个退路会变成一个说不出位置、也说不出原因的错误
    const wrong: string[] = []
    for (const sample of [...VALID, ...INVALID]) {
      const scan = scanJson(sample)
      if ((scan === null) !== parses(sample)) wrong.push(JSON.stringify(sample))
    }
    expect(wrong).toEqual([])
  })

  it('合法的那些一个都不报', () => {
    for (const sample of VALID) expect(scanJson(sample), JSON.stringify(sample)).toBeNull()
  })

  it('不合法的那些一个都跑不掉', () => {
    for (const sample of INVALID) expect(scanJson(sample), JSON.stringify(sample)).not.toBeNull()
  })
})

describe('scanJson：位置', () => {
  /** 断言「错在哪个下标上」，并且顺手断言那个下标指着的东西是有意义的（不是空白） */
  function offsetOf(text: string): number {
    const found = scanJson(text)
    expect(found, JSON.stringify(text)).not.toBeNull()
    return (found as { offset: number }).offset
  }

  it('尾逗号指着那个收尾括号', () => {
    // `[1,]`：错的是「逗号后面还该有一项」，而能指的地方只有那个 `]`。
    // ⚠️ V8 报的也是 position 3，这不是巧合——两边指的都是「解析不下去的那一个字符」
    expect(offsetOf('[1,]')).toBe(3)
    expect(offsetOf('{"a":1,}')).toBe(7)
    expect(offsetOf('{"a":1,,}')).toBe(7)
  })

  it('没引号的键指着键的第一个字符', () => {
    expect(offsetOf('{a:1}')).toBe(1)
    expect(offsetOf("{'a':1}")).toBe(1)
  })

  it('少冒号指着冒号该在的那一格', () => {
    expect(offsetOf('{"a" 1}')).toBe(5)
    expect(offsetOf('{"a"}')).toBe(4)
  })

  it('少了收尾括号指着正文末尾', () => {
    expect(offsetOf('{"a":1')).toBe(6)
    expect(offsetOf('[1,2')).toBe(4)
    expect(offsetOf('[')).toBe(1)
    expect(offsetOf('{')).toBe(1)
  })

  it('正文结束之后多出来的字符指着它自己', () => {
    expect(offsetOf('{}{}')).toBe(2)
    expect(offsetOf('{"a":1}}')).toBe(7)
    expect(offsetOf('[1,2]]')).toBe(5)
    expect(offsetOf('1 2')).toBe(2)
  })

  it('数字里的错指着出错的那一位', () => {
    expect(offsetOf('01')).toBe(1)
    expect(offsetOf('.5')).toBe(0)
    expect(offsetOf('1.')).toBe(2)
    expect(offsetOf('1e')).toBe(2)
    expect(offsetOf('+1')).toBe(0)
  })

  it('字符串里的错指着那个字符', () => {
    expect(offsetOf('"abc')).toBe(4)
    expect(offsetOf('"a\nb"')).toBe(2)
    expect(offsetOf('"a\\qb"')).toBe(3)
    expect(offsetOf('"a\\u00zz"')).toBe(6)
  })

  it('JS 里有、JSON 里没有的那三个各有自己一句话', () => {
    expect(scanJson('NaN')?.expected).toBe('JSON 里没有 NaN')
    expect(scanJson('Infinity')?.expected).toBe('JSON 里没有 Infinity')
    expect(scanJson('undefined')?.expected).toBe('JSON 里没有 undefined')
    // ⚠️ 小写的 `nul` 走的是另一条：它以 n 开头，于是先撞上 `null` 那句
    expect(scanJson('nul')?.expected).toBe('这里该是 null')
  })

  it('单引号那一句直接说该用什么', () => {
    expect(scanJson("'a'")?.expected).toBe('JSON 的字符串用双引号，不用单引号')
  })

  it('🔴 套两万层不炸栈——扫描器是迭代的', () => {
    const deep = '['.repeat(20_000) + ']'.repeat(20_000)
    // 递归下降在这一份上会 RangeError，而那正是「解析失败之后我们喂给扫描器」的东西。
    // ⛔ 这一条不是性能用例，是**不会崩**用例
    expect(scanJson(deep)).toBeNull()
    expect(scanJson('['.repeat(20_000))).toEqual({ offset: 20_000, expected: '这里该有一个值或者「]」' })
  })

  it('每一条错都能写成三行，而那个 ^ 落在示意图那一行的范围内', () => {
    // 不钉具体措辞（措辞会随哪一种错变），钉的是**形状**：
    // 输出格是个 textarea，少于三行的话那句话与那一行会挤在一起读不出层次，
    // 而 ^ 落到行外就等于指着空气
    for (const sample of INVALID) {
      const found = scanJson(sample)
      if (found === null) continue
      const at = found.offset
      expect(at, sample).toBeGreaterThanOrEqual(0)
      expect(at, sample).toBeLessThanOrEqual(sample.length)
      const lines = describeErrorAt(sample, found.offset, found.expected).split('\n')
      expect(lines, sample).toHaveLength(3)
      expect(lines[0], sample).toMatch(/^第 \d+ 行第 \d+ 列：/)
      const caret = lines[2]!.indexOf('^')
      expect(caret, sample).toBeGreaterThan(1)
      // ⚠️ 是 `<=`：错在正文末尾的时候那个 ^ 就落在行尾**之后**一格，
      // 而那正是「这里少了个东西」该有的画法
      expect(caret, sample).toBeLessThanOrEqual(lines[1]!.length)
      // ^ 底下那一个字符就是出错的那一个。⚠️ 底下**可能没有字符**，见上面那条 `<=`
      const under = lines[1]![caret]
      if (under !== undefined) expect(under, sample).toBe(sample[at])
    }
  })
})

describe('blankJsonComments', () => {
  it('没有注释的时候把原串**原样**还回来（同一个引用）', () => {
    const text = '{"a":1}'
    expect(blankJsonComments(text)).toBe(text)
  })

  it('🔴 长度不变，换行的位置也不变', () => {
    const samples = [
      '{"a":1} // 尾注释',
      '// 头注释\n{"a":1}',
      '/* 块 */{"a":1}',
      '{\n /* 跨\n 三行 */\n "a": 1\n}',
      '{"a":1 /* 没闭合',
      '1 /* a\nb\nc */ 2',
    ]
    for (const text of samples) {
      const out = blankJsonComments(text)
      expect(out.length, text).toBe(text.length)
      // 换行的下标逐个对上：这是「第 N 行第 M 列」还能指对地方的全部理由
      const lines = (value: string): number[] => {
        const at: number[] = []
        for (let i = 0; i < value.length; i++) if (value[i] === '\n') at.push(i)
        return at
      }
      expect(lines(out), text).toEqual(lines(text))
    }
  })

  it('行注释抹到行尾为止，那个换行留着', () => {
    expect(blankJsonComments('{"a":1} // x')).toBe('{"a":1}     ')
    expect(blankJsonComments('// c\n1')).toBe('    \n1')
  })

  it('块注释整段抹掉，里面的换行留着', () => {
    expect(blankJsonComments('1/*a\nb*/2')).toBe('1   \n   2')
    expect(blankJsonComments('1 /* 没闭合')).toBe('1       ')
  })

  it('字符串里的 `//` 与 `/*` 不是注释', () => {
    expect(blankJsonComments('{"u":"http://a/b"}')).toBe('{"u":"http://a/b"}')
    expect(blankJsonComments('{"u":"/*"}')).toBe('{"u":"/*"}')
  })

  it('注释里的引号不开一个字符串', () => {
    // ⛔ 这一条是「状态机反了」的哨兵：把注释里的 `'` 当成字符串开头的话，
    // 后面的 `{"a":1}` 会被整段吞进那个字符串里，于是它不会被抹掉，
    // 而 JSON.parse 照样失败——错却在另一个地方
    expect(blankJsonComments('// don\'t\n{"a":1}')).toBe('        \n{"a":1}')
  })

  it('转义过的引号不会提前结束字符串', () => {
    expect(blankJsonComments('{"a":"x\\"y"} // c')).toBe('{"a":"x\\"y"}     ')
  })

  it('字符串没闭合的时候剩下的原样留着，交给解析器去说', () => {
    const text = '{"a": "x'
    expect(blankJsonComments(text)).toBe(text)
  })

  it('抹完之后那份能解析，而原来那份不能', () => {
    const text = '{\n  // tsconfig 里到处都是这种\n  "a": 1 /* 还有这种 */\n}'
    expect(parses(text)).toBe(false)
    expect(parses(blankJsonComments(text))).toBe(true)
  })
})

describe('sortKeysDeep', () => {
  it('嵌套的对象与数组都排到', () => {
    expect(sortKeysDeep({ b: 1, a: { d: 2, c: [1, { z: 3, y: 4 }] } })).toEqual({
      a: { c: [1, { y: 4, z: 3 }], d: 2 },
      b: 1,
    })
    expect(Object.keys(sortKeysDeep({ b: 1, a: 2 }) as object)).toEqual(['a', 'b'])
  })

  it('不是对象的值原样穿过，`null` 也不会被当成对象', () => {
    expect(sortKeysDeep(null)).toBeNull()
    expect(sortKeysDeep(1)).toBe(1)
    expect(sortKeysDeep('x')).toBe('x')
    expect(sortKeysDeep(true)).toBe(true)
  })

  it('按码位排，不按拼音', () => {
    // 压 U+538B < 格 U+683C。`localeCompare` 在有 ICU 的构建下会给出「格 < 压」，
    // 而 CI 的 ubuntu 与本机 macOS 不一定一致——所以这里用 `<`
    expect(Object.keys(sortKeysDeep({ 格式: 1, 压缩: 2 }) as object)).toEqual(['压缩', '格式'])
  })

  it('🔴 数字形状的键排不动，而这是引擎的规矩不是这里的 bug', () => {
    // JS 对象把「像数组下标的键」永远排在字符串键前面、并按数值升序，赋值顺序改不了它。
    // 钉住这个行为，是为了让哪天有人以为 `sortKeysDeep` 写错了去「修」的时候，
    // 这条用例会告诉他：修不动，该改的是注释
    expect(Object.keys(sortKeysDeep({ b: 1, '10': 2, '2': 3 }) as object)).toEqual(['2', '10', 'b'])
    expect(JSON.stringify(sortKeysDeep({ b: 1, '10': 2, '2': 3 }))).toBe('{"2":3,"10":2,"b":1}')
  })

  it('不改传进来的那一份', () => {
    const source: Record<string, unknown> = { b: { d: 1, c: 2 }, a: 3 }
    sortKeysDeep(source)
    expect(Object.keys(source)).toEqual(['b', 'a'])
    expect(Object.keys(source.b as object)).toEqual(['d', 'c'])
  })
})
