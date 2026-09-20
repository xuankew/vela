import { describe, expect, it } from 'vitest'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  coerceOption,
  defaultOptions,
  describeErrorAt,
  filterTools,
  groupTools,
  lineBoundsAt,
  locate,
  validateTool,
  type NumberOption,
  type SelectOption,
  type TextOption,
  type ToggleOption,
  type ToolDefinition,
} from './tool'

/** 一份**合法**的描述符。每条用例只改它要检查的那一格，于是失败信息指着那一格 */
function def(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: 'tool.json.format',
    name: 'JSON 格式化',
    category: 'format',
    input: 'text',
    side: 'js',
    run: () => ({ kind: 'ok', text: '' }),
    ...overrides,
  }
}

const toggle = (overrides: Partial<ToggleOption> = {}): ToggleOption => ({
  kind: 'toggle',
  key: 'sortKeys',
  label: '排序键',
  default: false,
  ...overrides,
})

const select = (overrides: Partial<SelectOption> = {}): SelectOption => ({
  kind: 'select',
  key: 'indent',
  label: '缩进',
  choices: ['2', '4', 'Tab'],
  default: '2',
  ...overrides,
})

const number = (overrides: Partial<NumberOption> = {}): NumberOption => ({
  kind: 'number',
  key: 'count',
  label: '个数',
  min: 1,
  max: 64,
  default: 1,
  ...overrides,
})

const text = (overrides: Partial<TextOption> = {}): TextOption => ({
  kind: 'text',
  key: 'pattern',
  label: '正则',
  default: '',
  ...overrides,
})

describe('六个分类', () => {
  it('顺序与标签一一对应，没有重复也没有空的', () => {
    expect(CATEGORY_ORDER).toEqual(['format', 'encode', 'generate', 'convert', 'test', 'text'])
    const labels = CATEGORY_ORDER.map((category) => CATEGORY_LABELS[category])
    expect(labels.every((label) => label !== '')).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('defaultOptions', () => {
  it('没有选项时给一个空对象', () => {
    expect(defaultOptions(def())).toEqual({})
  })

  it('四种选项各取自己的默认值', () => {
    expect(defaultOptions(def({ options: [text({ default: 'a+' }), toggle(), select(), number()] }))).toEqual({
      pattern: 'a+',
      sortKeys: false,
      indent: '2',
      count: 1,
    })
  })

  it('🔴 每次调用都返回新对象：改一份不会污染下一份', () => {
    const tool = def({ options: [select()] })
    const first = defaultOptions(tool)
    first.indent = 'Tab'
    expect(defaultOptions(tool)).toEqual({ indent: '2' })
  })
})

describe('coerceOption · text', () => {
  it('任意字符串原样通过，包括空串', () => {
    expect(coerceOption(text(), 'a+')).toBe('a+')
    expect(coerceOption(text(), '')).toBe('')
  })

  it('🔴 不 trim：装的可能是一个正则，而 `\\s` 与 ` \\s` 是两个东西', () => {
    expect(coerceOption(text(), '  a  ')).toBe('  a  ')
    expect(coerceOption(text(), '\\s')).toBe('\\s')
  })

  it('🔴 不像 number 那样拒绝越界值——这一格没有「不合法」这回事，所以 DOM 永远不必被拉回来', () => {
    expect(coerceOption(text(), '999')).toBe('999')
    expect(coerceOption(text(), '((((')).toBe('((((')
  })

  it('boolean 被拒（这一格只可能来自 `<input type="text">`，收到 boolean 就是接线错了）', () => {
    expect(coerceOption(text(), true)).toBeNull()
    expect(coerceOption(text(), false)).toBeNull()
  })
})

describe('coerceOption · toggle', () => {
  it('boolean 原样通过', () => {
    expect(coerceOption(toggle(), true)).toBe(true)
    expect(coerceOption(toggle(), false)).toBe(false)
  })

  it('"true" / "false" 两个字符串也认', () => {
    expect(coerceOption(toggle(), 'true')).toBe(true)
    expect(coerceOption(toggle(), 'false')).toBe(false)
  })

  it('别的字符串一律 null，⛔ 不猜', () => {
    expect(coerceOption(toggle(), 'yes')).toBeNull()
    expect(coerceOption(toggle(), '1')).toBeNull()
    expect(coerceOption(toggle(), '')).toBeNull()
  })
})

describe('coerceOption · select', () => {
  it('候选里的值通过', () => {
    expect(coerceOption(select(), 'Tab')).toBe('Tab')
  })

  it('不在候选里的、以及大小写不对的，一律 null', () => {
    expect(coerceOption(select(), 'tab')).toBeNull()
    expect(coerceOption(select(), '8')).toBeNull()
    expect(coerceOption(select(), '')).toBeNull()
  })

  it('boolean 不接受', () => {
    expect(coerceOption(select(), true)).toBeNull()
  })
})

describe('coerceOption · number', () => {
  it('整数字符串收窄成数字，两侧空白吃掉', () => {
    expect(coerceOption(number(), '3')).toBe(3)
    expect(coerceOption(number(), '  7 ')).toBe(7)
  })

  it('边界上的两个值都合法', () => {
    expect(coerceOption(number(), '1')).toBe(1)
    expect(coerceOption(number(), '64')).toBe(64)
  })

  it('🔴 超出范围返回 null，⛔ 不夹到边界上', () => {
    // 夹到 64 的话屏幕上那个格子写着 999、run 收到 64，两边对不上
    expect(coerceOption(number(), '999')).toBeNull()
    expect(coerceOption(number(), '0')).toBeNull()
    expect(coerceOption(number({ min: 0 }), '-1')).toBeNull()
  })

  it('小数、空串、非数字一律 null', () => {
    // `Number('')` 是 0，不先挡空串的话一个空输入框会变成「生成 0 个」
    expect(coerceOption(number({ min: 0 }), '')).toBeNull()
    expect(coerceOption(number(), '2.5')).toBeNull()
    expect(coerceOption(number(), 'abc')).toBeNull()
    expect(coerceOption(number(), 'NaN')).toBeNull()
    expect(coerceOption(number(), '1e3')).toBeNull()
  })

  it('boolean 不接受', () => {
    expect(coerceOption(number(), true)).toBeNull()
  })
})

describe('validateTool', () => {
  it('一份合法的描述符一条问题都没有', () => {
    expect(validateTool(def({ options: [text({ default: 'a+' }), toggle(), select(), number()] }))).toEqual([])
  })

  it('id 必须 tool. 开头、分层、小写', () => {
    expect(validateTool(def({ id: 'json.format' }))).toHaveLength(1)
    expect(validateTool(def({ id: 'tool.' }))).toHaveLength(1)
    expect(validateTool(def({ id: 'tool.Json.format' }))).toHaveLength(1)
    expect(validateTool(def({ id: 'tool.json_format' }))).toHaveLength(1)
    expect(validateTool(def({ id: 'tool.json' }))).toEqual([])
    expect(validateTool(def({ id: 'tool.json.format.pretty' }))).toEqual([])
  })

  it('空的 name、不认识的 category / input / side 各报一条', () => {
    expect(validateTool(def({ name: '' }))).toEqual(['name 是空的'])
    expect(validateTool(def({ category: 'graphic' as ToolDefinition['category'] }))).toHaveLength(1)
    expect(validateTool(def({ input: 'clipboard' as ToolDefinition['input'] }))).toHaveLength(1)
    expect(validateTool(def({ side: 'wasm' as ToolDefinition['side'] }))).toHaveLength(1)
  })

  it('run 不是函数时报一条', () => {
    const broken = def({ run: 42 as unknown as ToolDefinition['run'] })
    expect(validateTool(broken)).toEqual(['run 不是一个函数'])
  })

  it('选项 key 要小写开头、不能重复', () => {
    expect(validateTool(def({ options: [toggle({ key: 'Indent' })] }))).toHaveLength(1)
    expect(validateTool(def({ options: [toggle({ key: 'a-b' })] }))).toHaveLength(1)
    expect(validateTool(def({ options: [toggle(), toggle()] }))).toEqual(['选项 key "sortKeys" 重复'])
  })

  it('空的 label 报一条', () => {
    expect(validateTool(def({ options: [select({ label: '' })] }))).toEqual(['选项 "indent" 的 label 是空的'])
  })

  it('select：候选不能空、不能重复、默认值必须在候选里', () => {
    expect(validateTool(def({ options: [select({ choices: [] })] }))).toHaveLength(2) // 空候选 + 默认值不在里面
    expect(validateTool(def({ options: [select({ choices: ['2', '2'] })] }))).toEqual(['选项 "indent" 的候选有重复'])
    expect(validateTool(def({ options: [select({ default: '8' })] }))).toEqual([
      '选项 "indent" 的默认值 "8" 不在候选里',
    ])
  })

  it('number：min 不能大于 max，默认值必须是范围内的整数', () => {
    expect(validateTool(def({ options: [number({ min: 9, max: 2 })] }))).toEqual([
      '选项 "count" 的 min 大于 max',
      '选项 "count" 的默认值 1 不在 9…2 里',
    ])
    expect(validateTool(def({ options: [number({ default: 99 })] }))).toHaveLength(1)
    expect(validateTool(def({ options: [number({ default: 1.5, max: 64 })] }))).toHaveLength(1)
  })

  /**
   * 🔴 `text` **一条专属规则都没有**，而这是有意的：`select` 有「默认值必须在候选里」、
   * `number` 有「默认值必须在 min…max 里」，`text` 没有对应的跨字段不变量可查；
   * 至于「default 是字符串」，TS 已经钉住了，再写一遍就是给一个不可能发生的场景加校验。
   * ⚠️ 空默认值也合法——正则测试器就默认给一个空格子，等用户来打
   */
  it('text 没有专属规则，空默认值也算合法', () => {
    expect(validateTool(def({ options: [text()] }))).toEqual([])
    expect(validateTool(def({ options: [text({ default: '' })] }))).toEqual([])
    expect(validateTool(def({ options: [text({ label: '' })] }))).toEqual(['选项 "pattern" 的 label 是空的'])
  })

  it('🔴 一次报出全部问题，不是只报第一个', () => {
    const problems = validateTool(def({ name: '', options: [select({ default: 'nope' })] }))
    expect(problems).toEqual(['name 是空的', '选项 "indent" 的默认值 "nope" 不在候选里'])
  })
})

describe('groupTools', () => {
  const json = def({ id: 'tool.json.format', name: 'JSON 格式化', category: 'format' })
  const minify = def({ id: 'tool.json.minify', name: 'JSON 压缩', category: 'format' })
  const base64 = def({ id: 'tool.base64', name: 'Base64', category: 'encode' })
  const regex = def({ id: 'tool.regex', name: '正则测试器', category: 'test' })

  it('组的顺序跟着 CATEGORY_ORDER，不是跟着注册顺序', () => {
    const groups = groupTools([regex, base64, json])
    expect(groups.map((g) => g.category)).toEqual(['format', 'encode', 'test'])
    expect(groups.map((g) => g.label)).toEqual(['格式化', '编解码', '测试器'])
  })

  it('组内按名字排序，与谁先注册无关', () => {
    const groups = groupTools([json, minify])
    // ⚠️ 码位序而不是拼音序：压 U+538B 在 格 U+683C 前面，所以「JSON 压缩」排第一。
    // 与 `commands/registry.ts` 的 `list()` 同一条口径——`localeCompare` 在有 ICU 与没有 ICU
    // 的两个构建里给出两个顺序，而这一栏的顺序必须在两边一样
    expect(groups[0]?.tools.map((t) => t.id)).toEqual(['tool.json.minify', 'tool.json.format'])
  })

  it('⛔ 空分类不出现在左栏里', () => {
    expect(groupTools([json]).map((g) => g.category)).toEqual(['format'])
    expect(groupTools([])).toEqual([])
  })

  it('不认识的分类被丢掉，不会凭空多出一个空组', () => {
    const odd = def({ id: 'tool.color', name: '颜色', category: 'graphic' as ToolDefinition['category'] })
    expect(groupTools([odd, json]).map((g) => g.category)).toEqual(['format'])
  })
})

describe('filterTools', () => {
  const json = def({ id: 'tool.json.format', name: 'JSON 格式化' })
  const regex = def({ id: 'tool.regex.test', name: '正则测试器' })
  const uuid = def({ id: 'tool.uuid', name: 'UUID 生成' })
  const all = [json, regex, uuid]

  it('空查询与纯空白返回全部', () => {
    expect(filterTools(all, '')).toEqual(all)
    expect(filterTools(all, '   ')).toEqual(all)
  })

  it('按名字子串匹配，大小写不敏感', () => {
    expect(filterTools(all, 'json').map((t) => t.id)).toEqual(['tool.json.format'])
    expect(filterTools(all, 'JSON').map((t) => t.id)).toEqual(['tool.json.format'])
    expect(filterTools(all, '正则').map((t) => t.id)).toEqual(['tool.regex.test'])
  })

  it('也匹配 id：想不起中文名时可以打英文', () => {
    expect(filterTools(all, 'uuid').map((t) => t.id)).toEqual(['tool.uuid'])
    expect(filterTools(all, 'regex').map((t) => t.id)).toEqual(['tool.regex.test'])
  })

  it('⛔ 不是模糊匹配：子序列不算命中', () => {
    // `js` 命中 `json` 是**子串**，那是对的；`jsn` 是 `json` 的子序列而不是子串，
    // 模糊匹配（`goto/query.ts` 那一套打分）会把它捞进来，这里刻意不捞
    expect(filterTools(all, 'js').map((t) => t.id)).toEqual(['tool.json.format'])
    expect(filterTools(all, 'jsn')).toEqual([])
  })

  it('两侧空白被吃掉', () => {
    expect(filterTools(all, '  json  ').map((t) => t.id)).toEqual(['tool.json.format'])
  })
})

describe('lineBoundsAt', () => {
  it('取的是**整行**，不含那个换行符', () => {
    // 单位是「一行」而不是「一个光标位置」：把整行选上之后，那一行在输入格里是亮着的，
    // 与输出格里那个 `^` 说的是同一处。只放一个光标的话用户还得自己找这一行哪里不对
    expect(lineBoundsAt('abc\ndef\nghi', 0)).toEqual({ from: 0, to: 3 })
    expect(lineBoundsAt('abc\ndef\nghi', 5)).toEqual({ from: 4, to: 7 })
    expect(lineBoundsAt('abc\ndef\nghi', 10)).toEqual({ from: 8, to: 11 })
  })

  it('行首与行尾都算在这一行里', () => {
    expect(lineBoundsAt('abc\ndef', 3)).toEqual({ from: 0, to: 3 })
    expect(lineBoundsAt('abc\ndef', 4)).toEqual({ from: 4, to: 7 })
  })

  it('下标越界会夹回来', () => {
    expect(lineBoundsAt('ab', 99)).toEqual({ from: 0, to: 2 })
    expect(lineBoundsAt('ab', -5)).toEqual({ from: 0, to: 2 })
    expect(lineBoundsAt('', 0)).toEqual({ from: 0, to: 0 })
  })

  it('末尾那个换行之后是一行空的', () => {
    expect(lineBoundsAt('a\n', 2)).toEqual({ from: 2, to: 2 })
  })

  it('🔴 CRLF 的 `\\r` 不算在这一行里', () => {
    // 选中它没有任何看得见的效果，而它会让「选中的长度」与「这一行有几个字」差一个
    expect(lineBoundsAt('ab\r\ncd', 0)).toEqual({ from: 0, to: 2 })
    expect(lineBoundsAt('ab\r\ncd', 1)).toEqual({ from: 0, to: 2 })
    expect(lineBoundsAt('ab\r\ncd', 4)).toEqual({ from: 4, to: 6 })
  })

  it('一行十万个字符也是立刻返回——两个方向都是就近扫', () => {
    // ⛔ 不是性能断言（那要跑三次取噪声带），是**结构**断言：
    // 从头数 `\n` 的实现在这份输入上要扫一百万个字符，而这一份只扫「这一行」的长度
    const line = 'x'.repeat(100_000)
    const text = `${line}\n${line}`
    expect(lineBoundsAt(text, 150_000)).toEqual({ from: 100_001, to: 200_001 })
  })
})

describe('locate', () => {
  it('行与列都是 1 起', () => {
    expect(locate('abc\ndef\nghi', 0)).toEqual({ line: 1, column: 1, from: 0, to: 3 })
    expect(locate('abc\ndef\nghi', 5)).toEqual({ line: 2, column: 2, from: 4, to: 7 })
    expect(locate('abc\ndef\nghi', 10)).toEqual({ line: 3, column: 3, from: 8, to: 11 })
  })

  it('下标越界会夹回来，而不是数出一个不存在的行', () => {
    expect(locate('ab', 99)).toEqual({ line: 1, column: 3, from: 0, to: 2 })
    expect(locate('ab', -5)).toEqual({ line: 1, column: 1, from: 0, to: 2 })
  })

  it('空串与只有换行的串', () => {
    expect(locate('', 0)).toEqual({ line: 1, column: 1, from: 0, to: 0 })
    // 末尾那个换行**之后**还有一行（空的），而正文结束的错正落在那里
    expect(locate('a\n', 2)).toEqual({ line: 2, column: 1, from: 2, to: 2 })
  })

  it('CRLF 的行号数得对，而那个 `\\r` 不占一列', () => {
    // `from` 是 `\n` 之后那一格，所以 `\r` 落在**上一行**的尾巴上，被 `to` 排除掉
    expect(locate('ab\r\ncd', 4)).toEqual({ line: 2, column: 1, from: 4, to: 6 })
    expect(locate('ab\r\ncd', 1)).toEqual({ line: 1, column: 2, from: 0, to: 2 })
  })
})

/**
 * ⚠️ 下面这四条用例里的下标都是**手数的常量**，⛔ 不从 `scanJson` 拿。
 *
 * 理由不是省事：`describeErrorAt` 住在 `tool.ts`（最底下那一层），而 `scanJson` 住在
 * `json.ts`（依赖方向是 `json.ts` → `tool.ts`）。为了造一个下标而反过来 import 上层，
 * 会让这一份测试替一条并不存在的依赖背书。
 * 「扫描器报出来的下标喂进渲染器之后 `^` 落对了地方」那一条端到端的验收在
 * `builtin.test.ts` 里，那里本来就要同时拿到两边
 */
describe('describeErrorAt', () => {
  it('三行：一句人话、出错那一行、一个指着的 ^', () => {
    // `{`␤`  "a": 1,`␤`}` —— 尾逗号那一版，错在下标 12 的那个 `}` 上
    const text = '{\n  "a": 1,\n}'
    expect(describeErrorAt(text, 12, '逗号后面该有下一个键，而不是「}」')).toBe(
      '第 3 行第 1 列：逗号后面该有下一个键，而不是「}」\n  }\n  ^',
    )
  })

  it('^ 真的指着出错的那一个字符', () => {
    const text = '{\n  "a" 1\n}'
    const at = 8
    const lines = describeErrorAt(text, at, '键后面该有一个「:」，而不是「1」').split('\n')
    expect(lines).toHaveLength(3)
    const caret = lines[2]!.indexOf('^')
    expect(caret).toBeGreaterThan(0)
    // 🔴 这一句是整条对齐链的验收：示意图那一行与 ^ 那一行必须真的对得上
    expect(lines[1]![caret]).toBe(text[at])
    expect(lines[0]).toBe('第 2 行第 7 列：键后面该有一个「:」，而不是「1」')
  })

  it('长行只截一窗，而 ^ 跟着窗一起挪', () => {
    // 压缩过的 JSON 一行能有十万个字符，⛔ 不能整行倒进输出格
    const text = `{${'{"k":"v"},'.repeat(60)}"a":}`
    const at = 300
    const lines = describeErrorAt(text, at, '这里该有一个值').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]!.startsWith('  …')).toBe(true)
    // 窗宽 160 + 两个空格缩进 + 一个省略号
    expect(lines[1]!.length).toBe(2 + 1 + 160)
    expect(lines[1]![lines[2]!.indexOf('^')]).toBe(text[at])
  })

  it('出错在空行上的时候示意图那两行是空的，但不缺', () => {
    const out = describeErrorAt('1\n\n2', 2, '这里该有一个值')
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toBe('第 2 行第 1 列：这里该有一个值\n  \n  ^')
  })
})
