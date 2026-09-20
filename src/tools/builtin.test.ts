import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOLS, CODEC_TOOL, JSON_TOOL, NAMING_TOOL, REGEX_TOOL, TIME_TOOL, UUID_TOOL } from './builtin'
import { NAMING_STYLES } from './naming'
import { MAX_REGEX_HITS } from './regex'
import { defaultOptions, lineBoundsAt, validateTool, type ToolOptions, type ToolResult } from './tool'
import { UUID_BYTES } from './uuid'

/**
 * 内置工具清单与那六个已经落地的工具（M3-B-2 / M3-B-3 / M3-B-4 / M3-B-5 / M3-B-6）。
 *
 * 分工：算法那一半（扫描器怎么定位、注释怎么等长抹掉、键怎么排、字节怎么变 base64、
 * 版本位怎么改、日期怎么解析、`$&` 怎么展开）在 `json.test.ts` / `codec.test.ts` /
 * `uuid.test.ts` / `time.test.ts` / `regex.test.ts` / `naming.test.ts`，这一份钉的是**描述符**与
 * **选项怎么翻成算法的调用**——也就是「用户在那一格里选的东西，最后真的变成了输出里的样子」这条线。
 *
 * ⚠️ 于是这里**故意**不重测算法：`uuid.test.ts` 里那一份注入了假随机源的版本位断言，
 * 在这一层是复现不出来的（这一层拿的是真随机），只能量形状
 */

/**
 * 一份带全部三个选项默认值的 `run` 调用。
 *
 * ⚠️ `overrides` 的型是 `ToolOptions` 而不是 `Partial<ToolOptions>`：`ToolOptions` 本身
 * 就是 `Record<string, …>`，套一层 `Partial` 只会把值变成 `… | undefined`，
 * 于是展开之后**不再**是一个 `ToolOptions`
 */
function run(input: string, overrides: ToolOptions = {}): ToolResult {
  const out = JSON_TOOL.run(input, { ...defaultOptions(JSON_TOOL), ...overrides })
  // ⚠️ 描述符允许 `run` 返回 Promise（Rust 侧的工具必然是），这一份是同步的。
  // 不 `await` 是为了让用例读起来就是「给一份输入、拿一份输出」；这一句保证它确实是同步的
  expect(out).not.toBeInstanceOf(Promise)
  return out as ToolResult
}

/** 编解码那一个：只有一个选项，所以直接收那个模式串比收一个 overrides 袋子好读 */
function codec(input: string, mode: string): ToolResult {
  const out = CODEC_TOOL.run(input, { ...defaultOptions(CODEC_TOOL), mode })
  expect(out).not.toBeInstanceOf(Promise)
  return out as ToolResult
}

/**
 * UUID 那一个。
 *
 * ⚠️ 第一个参数**写死成空串**：它是 `input: 'none'`，而 `store.ts` 的 `runNow`
 * 对那一类压根不去读输入格，直接递一个 `''`。用例照那一份口径来
 */
function uuid(overrides: ToolOptions = {}): ToolResult {
  const out = UUID_TOOL.run('', { ...defaultOptions(UUID_TOOL), ...overrides })
  expect(out).not.toBeInstanceOf(Promise)
  return out as ToolResult
}

/** 时间戳与命名风格那**两个**：一个选项都没有，所以没有 overrides 袋子 */
function time(input: string): ToolResult {
  const out = TIME_TOOL.run(input, defaultOptions(TIME_TOOL))
  expect(out).not.toBeInstanceOf(Promise)
  return out as ToolResult
}

/** 正则那一个：三个文字格 + 一个下拉，所以也是 overrides 袋子 */
function regex(input: string, overrides: ToolOptions = {}): ToolResult {
  const out = REGEX_TOOL.run(input, { ...defaultOptions(REGEX_TOOL), ...overrides })
  expect(out).not.toBeInstanceOf(Promise)
  return out as ToolResult
}

/** RFC 4122 v4 的形状。⚠️ 与 `uuid.test.ts` 里那一份逐字相同——它钉的是同一条规则 */
const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('清单本身', () => {
  it('每一个都过 validateTool，id 不重复', () => {
    // 🔴 这一条是 `installTools` 那道启动自检的**提前量**：那边不合法会整批不装并抛，
    // 而抛在启动路径上的症状是「工具箱压根没出现」。让它在用例里先炸一次
    expect(BUILTIN_TOOLS.length).toBeGreaterThan(0)
    const problems = BUILTIN_TOOLS.flatMap((tool) => validateTool(tool).map((p) => `${tool.id}：${p}`))
    expect(problems).toEqual([])
    expect(new Set(BUILTIN_TOOLS.map((tool) => tool.id)).size).toBe(BUILTIN_TOOLS.length)
  })

  it('已经落地的六个都在清单里', () => {
    expect(BUILTIN_TOOLS.map((tool) => tool.id)).toEqual([
      'tool.json.format',
      'tool.codec',
      'tool.uuid',
      'tool.timestamp',
      'tool.regex',
      'tool.naming',
    ])
  })
})

describe('JSON 工具的描述符', () => {
  it('名字里两个词都写着，于是左栏的过滤框打「压缩」也捞得到它', () => {
    expect(JSON_TOOL.id).toBe('tool.json.format')
    expect(JSON_TOOL.name).toBe('JSON 格式化 / 压缩')
    expect(JSON_TOOL.name).toContain('格式化')
    expect(JSON_TOOL.name).toContain('压缩')
    expect(JSON_TOOL.category).toBe('format')
    expect(JSON_TOOL.input).toBe('text')
    expect(JSON_TOOL.side).toBe('js')
  })

  it('三个选项，默认值是「缩进 2 / 不排序 / 去注释」', () => {
    expect(defaultOptions(JSON_TOOL)).toEqual({ indent: '2', sortKeys: false, stripComments: true })
    const indent = JSON_TOOL.options?.find((option) => option.key === 'indent')
    expect(indent?.kind).toBe('select')
    // ⚠️ 候选值就是显示文字（`tool.ts` 的 `SelectOption` 上写着为什么），
    // 所以这四个串**同时**是屏幕上那四格与 `run` 收到的值——钉住它就是钉住两头对得上
    expect((indent as { choices: readonly string[] }).choices).toEqual(['2', '4', 'Tab', '无（压缩）'])
  })
})

describe('缩进', () => {
  const source = '{"b":1,"a":2}'

  it('2 / 4 / Tab / 压缩四挡各是各的样子', () => {
    expect(run(source).text).toBe('{\n  "b": 1,\n  "a": 2\n}')
    expect(run(source, { indent: '4' }).text).toBe('{\n    "b": 1,\n    "a": 2\n}')
    expect(run(source, { indent: 'Tab' }).text).toBe('{\n\t"b": 1,\n\t"a": 2\n}')
    expect(run(source, { indent: '无（压缩）' }).text).toBe('{"b":1,"a":2}')
  })

  it('⚠️ 一个没人认识的缩进值落到缺省的 2，而不是抛', () => {
    // `coerceOption` 保证这一支到不了（不在候选里的值根本写不进选项），
    // 但 `run` 是个能被任何人调的函数，而它抛出来的话面板上是一句英文的 TypeError
    expect(run(source, { indent: '8' }).text).toBe('{\n  "b": 1,\n  "a": 2\n}')
  })

  it('数组与顶层标量也照着缩进走', () => {
    expect(run('[1,[2,3]]').text).toBe('[\n  1,\n  [\n    2,\n    3\n  ]\n]')
    expect(run('"x"').text).toBe('"x"')
    expect(run('1.5').text).toBe('1.5')
  })
})

describe('排序键', () => {
  it('关掉的时候键序是原来那一份', () => {
    expect(run('{"b":1,"a":2}').text).toBe('{\n  "b": 1,\n  "a": 2\n}')
  })

  it('打开的时候排到，而且嵌套的也排到', () => {
    expect(run('{"b":1,"a":2}', { sortKeys: true }).text).toBe('{\n  "a": 2,\n  "b": 1\n}')
    expect(run('{"z":{"y":1,"x":2}}', { sortKeys: true }).text).toBe('{\n  "z": {\n    "x": 2,\n    "y": 1\n  }\n}')
  })
})

describe('去注释', () => {
  const jsonc = '{\n  // tsconfig 里到处都是这种\n  "a": 1 /* 还有这种 */\n}'

  it('默认开：JSONC 能跑通', () => {
    expect(run(jsonc).text).toBe('{\n  "a": 1\n}')
  })

  it('关掉之后与 JSON.parse 一字不差——它就不认注释了', () => {
    const out = run(jsonc, { stripComments: false })
    expect(out.kind).toBe('error')
    expect(out.at).toBe(4)
    expect(jsonc[4]).toBe('/')
    // 而那句话是中文的、带行列的，⛔ 不是引擎那句 `Unexpected token '/' ...`
    // （真机上的引擎是 JavaScriptCore，它给的是 `JSON Parse error: ...`，连位置都没有）
    expect(out.text).toBe('第 2 行第 3 列：对象的键必须是带双引号的字符串\n    // tsconfig 里到处都是这种\n    ^')
  })

  it('🔴 抹掉注释之后，位置指的还是**用户在输入格里看得见的那一行**', () => {
    // 这一条是「等长抹注释」那个设计的全部理由。删掉注释的话下标立刻错位，
    // 报出来的行列会指到另一个地方去，而「跳到出错处」会把选区放到错的一行上
    const input = '{\n  // note\n  "a" 1\n}'
    const out = run(input)
    expect(out.kind).toBe('error')
    expect(out.at).toBe(18)
    expect(input[out.at!]).toBe('1')
    expect(out.text).toBe('第 3 行第 7 列：键后面该有一个「:」，而不是「1」\n    "a" 1\n        ^')
    // 面板那一下用的就是 `lineBoundsAt`：选中的是**这一整行**
    expect(lineBoundsAt(input, out.at!)).toEqual({ from: 12, to: 19 })
    expect(input.slice(12, 19)).toBe('  "a" 1')
  })
})

describe('错误', () => {
  it('🔴 空输入不是错误，而是一份空输出', () => {
    // 工具箱是「改一个字就重跑一次」的，于是打开这个工具的那一瞬间输入格是空的。
    // 那时候报错会让输出格在用户还没粘东西之前就红一次；返回空串之后它显示的是
    // 「输出会出现在这里」，那正是「还没东西可跑」该有的样子
    expect(run('')).toEqual({ kind: 'ok', text: '' })
    expect(run('   \n\t ')).toEqual({ kind: 'ok', text: '' })
  })

  it('错误带着位置，而那一句里有行有列', () => {
    const out = run('{"a":1,}')
    expect(out.kind).toBe('error')
    expect(out.at).toBe(7)
    expect(out.text).toMatch(/^第 1 行第 8 列：/)
    expect(out.text).toContain('逗号后面该有下一个键')
  })

  it('🔴 两个已知的失真：大整数与 -0', () => {
    // 这不是这里写错了，是**用 `JSON.parse` 建值**这条路的固有代价：值一旦进了 double，
    // 超过 2^53 的整数与负零就回不去了。⚠️ 记在这里是为了让下一个人不必重新发现一次，
    // 也是为了提醒「格式化 JSON」这个工具在极端输入上不是无损的
    expect(run('{"big":12345678901234567890}').text).toContain('12345678901234567000')
    expect(run('-0').text).toBe('0')
  })

  it('输出永远能被 JSON.parse 读回去', () => {
    const samples = [
      '{"a":[1,2,{"b":null}]}',
      '[1,2,3]',
      '{"中文":"值","emoji":"😀"}',
      '{"esc":"a\\"b\\\\c\\nd\\u0041"}',
      '1e400',
    ]
    for (const sample of samples) {
      for (const indent of ['2', '4', 'Tab', '无（压缩）']) {
        const out = run(sample, { indent, sortKeys: true })
        expect(out.kind, `${sample} / ${indent}`).toBe('ok')
        // ⛔ 不能写成 `() => JSON.parse(...)`：那个箭头函数的返回型是 `any`，
        // eslint 的 `no-unsafe-return` 会拦下来，而它拦得对——这里要的是「不抛」，不是那个值
        expect(() => {
          JSON.parse(out.text)
        }, `${sample} / ${indent}`).not.toThrow()
      }
    }
  })
})

describe('输出里不转义非 ASCII', () => {
  it('中文与 emoji 原样出去', () => {
    // ⚠️ 有些格式化工具会把非 ASCII 转成 `\uXXXX`（那是合法的，但没人想读）。
    // 这个工具的默认字体是文楷，中文正是要**看得见**的那一类内容
    expect(run('{"名字":"玄柯","emoji":"😀"}').text).toBe('{\n  "名字": "玄柯",\n  "emoji": "😀"\n}')
  })
})

describe('Base64 / URL 编解码工具的描述符', () => {
  it('名字里两个词都写着，于是过滤框打「base64」或「url」都捞得到它', () => {
    expect(CODEC_TOOL.id).toBe('tool.codec')
    expect(CODEC_TOOL.name).toBe('Base64 / URL 编解码')
    expect(CODEC_TOOL.name.toLowerCase()).toContain('base64')
    expect(CODEC_TOOL.name.toLowerCase()).toContain('url')
    expect(CODEC_TOOL.category).toBe('encode')
    expect(CODEC_TOOL.input).toBe('text')
    expect(CODEC_TOOL.side).toBe('js')
  })

  it('🔴 只有一个选项，而它有五个候选——⛔ 不是两个工具各带一个方向开关', () => {
    // 拆成「Base64」与「URL」两个工具的话还得再各配一个「编码 / 解码」的下拉，
    // 而那个下拉在只有一种方向的工具里是**点了没反应的**
    expect(CODEC_TOOL.options).toHaveLength(1)
    expect(defaultOptions(CODEC_TOOL)).toEqual({ mode: 'Base64 编码' })
    const mode = CODEC_TOOL.options?.[0]
    expect(mode?.kind).toBe('select')
    // ⚠️ 候选值就是显示文字，所以这五个串**同时**是屏幕上那五格与 `run` 收到的值
    expect((mode as { choices: readonly string[] }).choices).toEqual([
      'Base64 编码',
      'Base64 解码',
      'URL 编码（值）',
      'URL 编码（整条）',
      'URL 解码',
    ])
  })
})

describe('模式那一格确实换得动算法', () => {
  it('Base64 编过来再解回去是原样，中文与 emoji 也在内', () => {
    expect(codec('中文😀', 'Base64 编码')).toEqual({ kind: 'ok', text: '5Lit5paH8J+YgA==' })
    expect(codec('5Lit5paH8J+YgA==', 'Base64 解码')).toEqual({ kind: 'ok', text: '中文😀' })
  })

  it('URL 的两格差别正是那几个结构字符，解码那一格把它们还原', () => {
    expect(codec('a&b/c?d=e', 'URL 编码（值）')).toEqual({ kind: 'ok', text: 'a%26b%2Fc%3Fd%3De' })
    // 「整条」那一格里 `& / ? =` **是**这条 URL 的结构，编掉就换了一个意思
    expect(codec('a&b/c?d=e', 'URL 编码（整条）')).toEqual({ kind: 'ok', text: 'a&b/c?d=e' })
    expect(codec('a%26b%2Fc%3Fd%3De', 'URL 解码')).toEqual({ kind: 'ok', text: 'a&b/c?d=e' })
  })

  it('缺省那一格是 Base64 编码，于是打开工具就能直接粘东西进去', () => {
    expect(CODEC_TOOL.run('abc', defaultOptions(CODEC_TOOL))).toEqual({ kind: 'ok', text: 'YWJj' })
  })

  it('⚠️ 一个没人认识的模式给一条中文的错，⛔ 不悄悄退化成某一个模式', () => {
    // `coerceOption` 保证这一支到不了，但 `run` 是个能被任何人调的函数。
    // 悄悄退化的症状是「选了 A、跑出 B 的结果」，比一条错难查得多
    const out = codec('abc', 'Base64 解压')
    expect(out.kind).toBe('error')
    expect(out.text).toBe('不认识的模式「Base64 解压」')
    expect(out.at).toBeUndefined()
  })

  it('🔴 解码失败时那个下标一路带到面板上，指的是**输入格**里的那一行', () => {
    const input = 'YWJj\na*bc'
    const out = codec(input, 'Base64 解码')
    expect(out.kind).toBe('error')
    expect(out.at).toBe(6)
    expect(input[out.at!]).toBe('*')
    // 面板那一下用的就是 `lineBoundsAt`：选中的是**这一整行**
    expect(lineBoundsAt(input, out.at!)).toEqual({ from: 5, to: 9 })
    expect(out.text.split('\n')[0]).toBe('第 2 行第 2 列：Base64 的字母表里没有「*」')
  })

  it('🔴 空输入在五个模式上都不是错误', () => {
    // 与 JSON 工具同一条理由：打开工具那一刻输入格是空的，红一次是白红。
    // ⚠️ 但这里**没有** `runJson` 那个短路——五个模式在空串上本来就都给出空串。
    // ⛔ 只钉 `kind`，不钉输出文字：「URL 编码（值）」把空白编成 `%20%20…` 是对的，
    // 那份输入并不「空」，只有 `trim()` 之后才空
    for (const mode of ['Base64 编码', 'Base64 解码', 'URL 编码（值）', 'URL 编码（整条）', 'URL 解码']) {
      expect(codec('', mode), mode).toEqual({ kind: 'ok', text: '' })
      expect(codec('   \n\t ', mode).kind, mode).toBe('ok')
    }
  })
})

describe('UUID 工具的描述符', () => {
  it('名字里带着「v4」，因为输出要原样插回编辑器，版本这句话没有别的地方可放', () => {
    expect(UUID_TOOL.id).toBe('tool.uuid')
    expect(UUID_TOOL.name).toBe('UUID 生成（v4）')
    expect(UUID_TOOL.name.toLowerCase()).toContain('uuid')
    expect(UUID_TOOL.name).toContain('v4')
    expect(UUID_TOOL.category).toBe('generate')
    // 🔴 这一格是「重新生成」那个按钮的开关：`ToolBox.tsx` 拿 `!wantsInput()` 门着它
    expect(UUID_TOOL.input).toBe('none')
    expect(UUID_TOOL.side).toBe('js')
  })

  it('三个选项，默认是「1 个 / 小写 / 带连字符」', () => {
    expect(defaultOptions(UUID_TOOL)).toEqual({ count: 1, uppercase: false, hyphens: true })
    expect(UUID_TOOL.options?.map((option) => option.kind)).toEqual(['number', 'toggle', 'toggle'])
  })

  it('🔴 「个数」的上限与平台那一条 65536 字节的闸对得上', () => {
    // `crypto.getRandomValues` 一次最多收 65536 个字节，超了抛 `QuotaExceededError`。
    // `uuidList` 刻意**一次**填满整批，于是这一条乘法就是那个工具唯一的越界风险。
    // ⚠️ 用 `UUID_BYTES` 而不是写死 16：哪天改成别的形状，这一条会跟着算
    const count = UUID_TOOL.options?.find((option) => option.key === 'count')
    expect(count?.kind).toBe('number')
    const { max } = count as { max: number }
    expect(max).toBe(1000)
    expect(max * UUID_BYTES).toBeLessThanOrEqual(65536)
  })

  it('跑一次给出一个合法的 v4，而且末尾没有换行', () => {
    const out = uuid()
    expect(out.kind).toBe('ok')
    expect(out.text).toMatch(V4_RE)
    // 🔴 没有末尾换行：「插回编辑器」是把输出格里的文字**整份**写进文档，
    // 一个多出来的 `\n` 会凭空插一个空行
    expect(out.text).not.toContain('\n')
  })

  it('「个数」那一格确实翻成了几行', () => {
    const lines = uuid({ count: 3 }).text.split('\n')
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line).toMatch(V4_RE)
    expect(new Set(lines).size).toBe(3)
  })

  it('两个开关各管各的：大写换字形，连字符换形状', () => {
    const upper = uuid({ uppercase: true }).text
    expect(upper).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/)
    const bare = uuid({ hyphens: false }).text
    expect(bare).toMatch(/^[0-9a-f]{32}$/)
    expect(bare[12]).toBe('4')
  })

  it('⚠️ 一个没人认识的「个数」落到 1，而不是抛、也不是生成 0 个', () => {
    // `coerceOption` 对数字那一格返回 `null`（于是面板保持原值），所以这一支结构上到不了。
    // 但 `Number('')` 是 `0`——一个空输入框会变成「生成 0 个 UUID」，也就是一份空输出，
    // 而空输出在输出格里显示的是「输出会出现在这里」，读起来像是没跑
    expect(uuid({ count: 'abc' }).text).toMatch(V4_RE)
    expect(uuid({ count: true }).text).toMatch(V4_RE)
  })

  it('它压根不读输入格，所以 `input: none` 那一格的空串是真的够用', () => {
    const withJunk = UUID_TOOL.run('这一串不该有任何影响', defaultOptions(UUID_TOOL)) as ToolResult
    expect(withJunk.text).toMatch(V4_RE)
  })

  it('生成到上限那一批也不炸，而且一千个各不相同', () => {
    const lines = uuid({ count: 1000 }).text.split('\n')
    expect(lines).toHaveLength(1000)
    expect(new Set(lines).size).toBe(1000)
  })
})

describe('时间戳工具的描述符', () => {
  it('一个选项都没有，于是面板不画选项条', () => {
    expect(TIME_TOOL.id).toBe('tool.timestamp')
    expect(TIME_TOOL.name).toBe('时间戳互转')
    expect(TIME_TOOL.name).toContain('时间戳')
    expect(TIME_TOOL.category).toBe('convert')
    expect(TIME_TOOL.input).toBe('text')
    expect(TIME_TOOL.side).toBe('js')
    // 🔴 单位是按位数**猜**的，而猜成了哪一种写在输出的披露那一句里。
    // 做成下拉的话就有两处真相，而「下拉写着毫秒、输出说是秒」这种对不上没法查
    expect(TIME_TOOL.options).toBeUndefined()
    expect(defaultOptions(TIME_TOOL)).toEqual({})
  })

  it('报告那五行是描述符这一层交出去的，不是面板拼的', () => {
    const out = time('1700000000')
    expect(out.kind).toBe('ok')
    expect(out.text.split('\n').slice(0, 5)).toEqual([
      expect.stringMatching(/^本地：/),
      'UTC：2023-11-14 22:13:20 星期二',
      'ISO：2023-11-14T22:13:20Z',
      '秒：1700000000',
      '毫秒：1700000000000',
    ])
    expect(out.text).toContain('（输入读成「秒」）')
    expect(out.at).toBeUndefined()
  })

  it('🔴 空输入给「现在这一刻」，而 `Date.now()` 是在**这一层**读的', () => {
    // `timeReport` 收一个 `now` 参数，所以它是纯的、用例能钉死字符串；
    // 不纯的那一半留在描述符这一侧。这一条量的是那根线接没接上
    const before = Date.now()
    const out = time('')
    const after = Date.now()
    expect(out.kind).toBe('ok')
    expect(out.text).toContain('（这一格是空的，给的是现在这一刻）')
    const millis = Number(out.text.split('\n')[4]?.slice('毫秒：'.length))
    expect(millis).toBeGreaterThanOrEqual(before)
    expect(millis).toBeLessThanOrEqual(after)
  })

  it('🔴 出错时那个下标一路带到面板上，指的是**输入格**里的那一处', () => {
    // 这一个下标是「跳到出错处」那一个按钮唯一的信息来源，而它必须是**输入串**里的
    const input = '2024-02-30'
    const out = time(input)
    expect(out.kind).toBe('error')
    expect(out.at).toBe(8)
    expect(input[out.at!]).toBe('3')
    // 面板那一下用的就是 `lineBoundsAt`：选中的是**这一整行**
    expect(lineBoundsAt(input, out.at!)).toEqual({ from: 0, to: 10 })
    expect(out.text.split('\n')[0]).toBe('第 1 行第 9 列：2024 年 2 月只有 29 天，没有 30 日')
  })
})

describe('正则工具的描述符', () => {
  it('四个选项：三个文字格 + 一个下拉，缺省是「匹配清单」', () => {
    expect(REGEX_TOOL.id).toBe('tool.regex')
    expect(REGEX_TOOL.name).toBe('正则测试器')
    expect(REGEX_TOOL.name).toContain('正则')
    expect(REGEX_TOOL.category).toBe('test')
    expect(REGEX_TOOL.input).toBe('text')
    expect(REGEX_TOOL.side).toBe('js')
    expect(REGEX_TOOL.options?.map((option) => option.kind)).toEqual(['text', 'text', 'text', 'select'])
    // ⚠️ 候选值就是显示文字，所以这两个串**同时**是屏幕上那两格与 `runRegex` 判的那一个
    expect(defaultOptions(REGEX_TOOL)).toEqual({ pattern: '', flags: '', replacement: '', mode: '匹配清单' })
  })

  it('🔴 三个文字格默认都是空串，于是打开工具那一刻输出格是占位文字而不是一片红', () => {
    // 空模式**匹配每一处**（零长），不短路的话那一下会列出 200 处空匹配
    expect(regex('abc')).toEqual({ kind: 'ok', text: '' })
  })

  it('⚠️ 一个不是字符串的模式落到空串，也就是「还没东西可跑」', () => {
    // `coerceOption` 对 `text` 那一格只收字符串，所以这一支结构上到不了
    expect(regex('abc', { pattern: true })).toEqual({ kind: 'ok', text: '' })
  })

  it('「输出」那一格确实换得动算法：清单 vs 纯替换后文本', () => {
    const listed = regex('a1b2', { pattern: '\\d' })
    expect(listed.kind).toBe('ok')
    expect(listed.text.split('\n')[0]).toBe('匹配 2 处')
    // 🔴 替换那一档交出去的是**纯**替换后的文本，⛔ 没有抬头——
    // 「插回编辑器」把输出格里的文字整份写进文档，一行抬头就是一行要手动删的东西
    expect(regex('a1b2', { pattern: '\\d', replacement: '#', mode: '替换结果' })).toEqual({
      kind: 'ok',
      text: 'a#b#',
    })
  })

  it('🔴 清单那一份带 at，指的是**第一处**——「跳到第一处」那个按钮靠它', () => {
    const input = 'xx a1 b2'
    const out = regex(input, { pattern: '\\d' })
    expect(out.at).toBe(4)
    expect(input[out.at!]).toBe('1')
    // 面板那一下用的就是 `lineBoundsAt`：选中的是**这一整行**
    expect(lineBoundsAt(input, out.at!)).toEqual({ from: 0, to: 8 })
  })

  it('🔴 模式写错时报一条中文的错，而那一份错**不带 at**', () => {
    // `at` 的坐标系是输入格，而模式住在选项格里；指过去只会指到一个无关的地方
    const out = regex('abc', { pattern: '(a' })
    expect(out.kind).toBe('error')
    expect(out.at).toBeUndefined()
    expect(out.text).toContain('左括号')
  })

  it('标志那一格直接透传，而 `g` 是白给的', () => {
    expect(regex('aA', { pattern: 'a' }).text.split('\n')[0]).toBe('匹配 1 处')
    const insensitive = regex('aA', { pattern: 'a', flags: 'i' })
    expect(insensitive.text.split('\n')[0]).toBe('匹配 2 处')
    // 抬头里那一串是归一化之后的（补上 g、去重、保序），不是用户打的那一份原样
    expect(insensitive.text).toContain('正则：/a/ig')
  })

  it('⚠️ 一个没人认识的「输出」值落到清单那一档，⛔ 不落到替换', () => {
    // `coerceOption` 保证这一支到不了，但 `run` 是个能被任何人调的函数。
    // 🔴 落到 `list` 是有意的：清单**不会改用户的文字**，而替换那一档的输出
    // 是能被「插回编辑器」整份写进文档的
    const out = regex('a1', { pattern: '\\d', replacement: '@', mode: '别的' })
    expect(out.text.split('\n')[0]).toBe('匹配 1 处')
    // ⚠️ 这里不能拿 `#` 当哨兵：清单自己就用 `#1` `#2` 编号
    expect(out.text).not.toContain('@')
  })

  it('🔴 上限只砍**清单**，⛔ 不砍替换结果', () => {
    const text = 'a'.repeat(MAX_REGEX_HITS + 5)
    const listed = regex(text, { pattern: 'a' })
    expect(listed.text.split('\n')[0]).toBe(`匹配 ${MAX_REGEX_HITS} 处以上`)
    // 砍掉一半的替换结果会被「插回编辑器」当成一份完整的文档写回去，那是一次静默的数据损坏
    expect(regex(text, { pattern: 'a', replacement: 'b', mode: '替换结果' }).text).toBe('b'.repeat(MAX_REGEX_HITS + 5))
  })
})

describe('命名风格工具的描述符', () => {
  /**
   * ⚠️ 这一个工具**没有选项**，所以 `run` 的第二个参数是 `defaultOptions` 给出的空袋子。
   * 与 `time()` 同一条口径，而它同时钉住了「没有选项格」这件事：
   * `defaultOptions` 对 `options` 缺省的描述符返回 `{}`
   */
  function naming(input: string): ToolResult {
    const out = NAMING_TOOL.run(input, defaultOptions(NAMING_TOOL))
    expect(out).not.toBeInstanceOf(Promise)
    return out as ToolResult
  }

  it('🔴 描述符上压根没有 options 那一格，于是右栏不画选项条', () => {
    expect(NAMING_TOOL.id).toBe('tool.naming')
    expect(NAMING_TOOL.name).toBe('命名风格转换')
    expect(NAMING_TOOL.name).toContain('命名')
    expect(NAMING_TOOL.category).toBe('text')
    expect(NAMING_TOOL.input).toBe('text')
    expect(NAMING_TOOL.side).toBe('js')
    // ⚠️ 断 `undefined` 而⛔ 不断 `[]`：`ToolBox.tsx` 判的是 `(tool.options ?? []).length > 0`，
    // 两种写法在面板上表现一样，但「缺省」与「空清单」是两件事，这里如实钉住缺省
    expect(NAMING_TOOL.options).toBeUndefined()
    expect(defaultOptions(NAMING_TOOL)).toEqual({})
  })

  it('六种风格一次全给，⛔ 没有「目标风格」那一格下拉', () => {
    // 这一条钉的是那个**决定**：做成下拉的话这里只有一行，而用户得先想清楚要哪个英文名字
    const lines = naming('user_name').text.split('\n')
    expect(lines).toHaveLength(NAMING_STYLES.length)
    expect(lines[0]).toBe('小驼峰（camelCase）：userName')
    expect(lines[1]).toBe('大驼峰（PascalCase）：UserName')
  })

  it('🔴 空输入给 ok + 空串，于是打开工具那一刻输出格是占位文字', () => {
    // 与 `runJson` / 正则那一个同一条口径：不短路的话会得到六行空的 `小驼峰（camelCase）：`
    expect(naming('')).toEqual({ kind: 'ok', text: '' })
    expect(naming('   ')).toEqual({ kind: 'ok', text: '' })
  })

  it('⚠️ 只有分隔符的时候说一句人话，而它是 ok 不是 error', () => {
    const out = naming('___')
    expect(out.kind).toBe('ok')
    expect(out.text).toBe('这一串里没有字母或数字，没有可转换的词')
  })

  it('🔴 永远不带 at：这一个工具不报位置', () => {
    // `at` 的坐标系是输入格。正则那一个能带是因为它指的是**第一处匹配**，
    // 而「哪一种风格写错了」这件事没有位置可指
    expect(naming('HTTPServer')).not.toHaveProperty('at')
    expect(naming('___')).not.toHaveProperty('at')
  })

  it('🔴 缩写串不会被切成一字一词——真机上最容易撞见的那一个输入', () => {
    // naive 的 `/[A-Z]/` 在这里给出 `x_m_l_http_request`，一个合法但没用的蛇形
    const text = naming('XMLHttpRequest').text
    expect(text).toContain('蛇形（snake_case）：xml_http_request')
    expect(text).toContain('短横线（kebab-case）：xml-http-request')
    expect(text).not.toContain('x_m_l')
  })
})
