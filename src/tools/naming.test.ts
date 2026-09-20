import { describe, expect, it } from 'vitest'
import { NAMING_STYLES, namingReport, renderStyle, splitWords } from './naming'

/**
 * 命名风格转换（M3-B-6）。
 *
 * 这一份的重心在**分词**而不是拼接：拼六种风格是六行 `join`，写错了肉眼一看就知道；
 * 分词错了则六种输出**一起**错，而且错得很像样（`x_m_l_http_request` 是合法蛇形）。
 * ⚠️ 所以断言一律打在 `splitWords` 的**数组**上，而不是打在报告的字串上——
 * 打在字串上的话「切对了但拼错了」与「切错了但碰巧拼成同一串」这两种情况会混在一起
 */

/** 六行报告的形状。⚠️ 全角冒号，⛔ 不做列对齐（PLAN 风险 R10） */
const CAMEL_LINE = '小驼峰（camelCase）：userName'

describe('分词：驼峰的两类边界', () => {
  it('小写 → 大写断开，这是驼峰的定义', () => {
    expect(splitWords('fooBar')).toEqual(['foo', 'bar'])
    expect(splitWords('userName')).toEqual(['user', 'name'])
  })

  it('🔴 大写串 → 大写后跟小写，断在**最后那个大写前面**', () => {
    // naive 的 `/[A-Z]/g` 在这一条上给出 `h_t_t_p_server`，一个合法但没用的蛇形。
    // 判据要看 `s[i + 1]`，所以这一个工具必须能往前读一个字符
    expect(splitWords('HTTPServer')).toEqual(['http', 'server'])
    expect(splitWords('XMLHttpRequest')).toEqual(['xml', 'http', 'request'])
    expect(splitWords('IOSVersion')).toEqual(['ios', 'version'])
    expect(splitWords('AWSRegion')).toEqual(['aws', 'region'])
  })

  it('⚠️ 结尾的缩写不被多切一刀', () => {
    // `parseHTML` 的最后四个字符全是 uppercase，没有「后面跟小写」的那一处，
    // 于是只在 `e` → `H` 断一次。多切的话会得到 ['parse','h','t','m','l']
    expect(splitWords('parseHTML')).toEqual(['parse', 'html'])
    expect(splitWords('A')).toEqual(['a'])
    expect(splitWords('AB')).toEqual(['ab'])
  })

  it('整串全大写只有一个词', () => {
    expect(splitWords('CONSTANT')).toEqual(['constant'])
  })
})

describe('分词：分隔符', () => {
  it('下划线、短横线、点、空格是同一种东西', () => {
    expect(splitWords('user_name')).toEqual(['user', 'name'])
    expect(splitWords('already-kebab')).toEqual(['already', 'kebab'])
    expect(splitWords('dot.case')).toEqual(['dot', 'case'])
    expect(splitWords('two words')).toEqual(['two', 'words'])
  })

  it('🔴 换行也是分隔符，⛔ 这一个工具不是批量转换器', () => {
    // 粘两行进来得到的是**一个**双词短语的六种写法，而不是「两行各转一遍」。
    // 这一条钉住的是那个决定本身：换行走进 `isWordCode` 的假分支
    expect(splitWords('foo\nbar')).toEqual(['foo', 'bar'])
    expect(splitWords('foo\r\nbar')).toEqual(['foo', 'bar'])
  })

  it('连续与首尾的分隔符不产生空词', () => {
    expect(splitWords('__dunder__')).toEqual(['dunder'])
    expect(splitWords('  padded  ')).toEqual(['padded'])
    expect(splitWords('a__b')).toEqual(['a', 'b'])
  })

  it('只有分隔符的时候一个词都没有', () => {
    expect(splitWords('___')).toEqual([])
    expect(splitWords('---')).toEqual([])
    expect(splitWords('')).toEqual([])
  })
})

describe('分词：数字', () => {
  it('🔴 数字与字母之间**不**断词', () => {
    // 断开的症状是 `user2name` → `user_2_name`，而那个 `2` 在蛇形里读起来像版本号分隔
    expect(splitWords('foo2bar')).toEqual(['foo2bar'])
    expect(splitWords('v2')).toEqual(['v2'])
    expect(splitWords('user2name')).toEqual(['user2name'])
  })

  it('数字 → 大写要断，因为那是驼峰', () => {
    expect(splitWords('foo2Bar')).toEqual(['foo2', 'bar'])
    expect(splitWords('utf8Decoder')).toEqual(['utf8', 'decoder'])
  })

  it('纯数字是一个词', () => {
    expect(splitWords('2024')).toEqual(['2024'])
  })
})

describe('分词：非 ASCII', () => {
  it('🔴 中文整串是一个词，⛔ 不是一字一词', () => {
    // 第一版把字符类写成 `/[^\P{L}\P{N}]/`（双重否定）：一个汉字**同时**是 `\P{N}`，
    // 于是被那个 `^` 排除掉，结果是所有中文都成了分隔符、整串被吃光
    expect(splitWords('用户名')).toEqual(['用户名'])
  })

  it('ASCII ↔ 非 ASCII 的边上断开', () => {
    expect(splitWords('用户Name')).toEqual(['用户', 'name'])
    expect(splitWords('foo用户')).toEqual(['foo', '用户'])
  })

  it('非 ASCII 的分隔符（全角空格、中文标点）也算分隔符', () => {
    // 全角空格 U+3001 与顿号都不是 `\p{L}` / `\p{N}`
    expect(splitWords('用户、名字')).toEqual(['用户', '名字'])
  })

  it('🔴 补充平面上的字符不会被丢掉', () => {
    // `𠀀`（U+20000）在 UTF-16 里是两个代理项。按下标走的话游标会停在低代理项上，
    // 而那半个既不是字母也不是数字，于是这个字被当成分隔符**静默吃掉**
    expect(splitWords('𠀀')).toEqual(['𠀀'])
    expect(splitWords('𠀀a')).toEqual(['𠀀', 'a'])
    expect(splitWords('a𠀀b')).toEqual(['a', '𠀀', 'b'])
  })
})

describe('词一律归一成小写', () => {
  it('🔴 大小写信息在分词那一步就被抹平', () => {
    // 后果是 `HTTPServer` 的大驼峰是 `HttpServer` 而**不是** `HTTPServer`。
    // 这不是漏了：保住缩写的全大写要 produces `hTTPServer` 这种东西在小驼峰上
    expect(splitWords('HTTPServer')).toEqual(['http', 'server'])
    expect(renderStyle(splitWords('HTTPServer'), 'pascal')).toBe('HttpServer')
    expect(renderStyle(splitWords('HTTPServer'), 'camel')).toBe('httpServer')
  })
})

describe('六种风格的拼法', () => {
  const WORDS = ['user', 'name', 'id']

  it('🔴 六种各按自己的规则来', () => {
    expect(renderStyle(WORDS, 'camel')).toBe('userNameId')
    expect(renderStyle(WORDS, 'pascal')).toBe('UserNameId')
    expect(renderStyle(WORDS, 'snake')).toBe('user_name_id')
    expect(renderStyle(WORDS, 'constant')).toBe('USER_NAME_ID')
    expect(renderStyle(WORDS, 'kebab')).toBe('user-name-id')
    expect(renderStyle(WORDS, 'dot')).toBe('user.name.id')
  })

  it('只有一个词的时候小驼峰与大驼峰差在首字母', () => {
    expect(renderStyle(['user'], 'camel')).toBe('user')
    expect(renderStyle(['user'], 'pascal')).toBe('User')
  })

  it('没有词的时候六种都是空串，⛔ 不抛', () => {
    for (const style of NAMING_STYLES) expect(renderStyle([], style)).toBe('')
  })

  it('⚠️ 中文词走 `toUpperCase` 是原样，于是六种输出长得一样', () => {
    // 这不是 bug：中文没有大小写，六种风格的**分隔符**才是唯一区别，
    // 而单个词压根没有分隔符。要看得出区别得有两个词（见报告的用例）
    const words = splitWords('用户名')
    for (const style of NAMING_STYLES) expect(renderStyle(words, style)).toBe('用户名')
  })

  it('两个中文词按分隔符分开，这时候六种就有区别了', () => {
    const words = splitWords('用户名字')
    expect(words).toEqual(['用户名字'])
    expect(renderStyle(splitWords('用户_Name'), 'snake')).toBe('用户_name')
    expect(renderStyle(splitWords('用户_Name'), 'constant')).toBe('用户_NAME')
  })
})

describe('报告', () => {
  it('🔴 六行，顺序与标签都是钉死的', () => {
    expect(namingReport('user_name').text.split('\n')).toEqual([
      '小驼峰（camelCase）：userName',
      '大驼峰（PascalCase）：UserName',
      '蛇形（snake_case）：user_name',
      '常量（CONSTANT_CASE）：USER_NAME',
      '短横线（kebab-case）：user-name',
      '点分（dot.case）：user.name',
    ])
  })

  it('顺序与 `NAMING_STYLES` 一致，⛔ 不是碰巧写对的', () => {
    expect(NAMING_STYLES).toEqual(['camel', 'pascal', 'snake', 'constant', 'kebab', 'dot'])
    const lines = namingReport('a_b').text.split('\n')
    expect(lines).toHaveLength(NAMING_STYLES.length)
    // 每一行都以「中文（英文）：」开头，冒号是全角
    for (const line of lines) expect(line).toContain('：')
  })

  it('空输入给 `ok` + 空串，于是输出格显示占位文字而不是六行空标签', () => {
    expect(namingReport('')).toEqual({ kind: 'ok', text: '' })
    expect(namingReport('   ')).toEqual({ kind: 'ok', text: '' })
    expect(namingReport('\n\t ')).toEqual({ kind: 'ok', text: '' })
  })

  it('⚠️ 有输入但切不出词要说一句人话，⛔ 不能静默给空串', () => {
    // 静默空串的话输出格显示的还是「输出会出现在这里」，读起来像是没跑。
    // 🔴 而它是 `ok` 不是 `error`：那一串不是**写错了**，只是里面没有可转换的东西
    const out = namingReport('___')
    expect(out.kind).toBe('ok')
    expect(out.text).toBe('这一串里没有字母或数字，没有可转换的词')
    expect(namingReport('---').text).toBe('这一串里没有字母或数字，没有可转换的词')
  })

  it('🔴 永远不带 `at`：这一个工具不报位置', () => {
    // `at` 的坐标系是输入格，而「哪一种风格写错了」这件事没有位置可指
    expect(namingReport('user_name')).not.toHaveProperty('at')
    expect(namingReport('___')).not.toHaveProperty('at')
    expect(namingReport('')).not.toHaveProperty('at')
  })

  it('幂等：已经是某一种风格的输入转回来还是它自己', () => {
    expect(namingReport('already-kebab').text).toContain('短横线（kebab-case）：already-kebab')
    expect(namingReport('already_kebab').text).toContain('蛇形（snake_case）：already_kebab')
    expect(namingReport('alreadyKebab').text).toContain(CAMEL_LINE.replace('userName', 'alreadyKebab'))
  })

  it('⚠️ `MAX_TOOL_CHARS` 那个量级不炸，而且是单趟线性的', () => {
    // 单趟扫描、不递归、不 `split` 之后再 `flatMap`，所以这里是线性的
    const out = namingReport('a_'.repeat(150_000))
    expect(out.kind).toBe('ok')
    const lines = out.text.split('\n')
    expect(lines).toHaveLength(NAMING_STYLES.length)
    // 🔴 小驼峰 = 第一个词小写 + 其余每个词首字母大写，于是 15 万个 `a` 词出来是 `aAAA…`。
    // ⚠️ 这一条本来是写成 `expect(first).toBe('小驼峰…：' + 'a'.repeat(…))` 的，
    // 而断言失败时 vitest 会把**两份三十万字符**的字串打成 diff——实测一份 979 KB 的日志。
    // ⛔ 巨型字串只断长度与首尾
    expect(lines[0]).toHaveLength('小驼峰（camelCase）：'.length + 150_000)
    expect(lines[0]!.endsWith('a' + 'A'.repeat(149_999))).toBe(true)
    expect(lines[2]!.endsWith('a_'.repeat(149_999) + 'a')).toBe(true)
  })
})
