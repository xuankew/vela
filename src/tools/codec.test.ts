import { describe, expect, it } from 'vitest'
import { base64Decode, base64Encode, findLoneSurrogate, scanBase64, scanPercent, urlDecode, urlEncode } from './codec'
import { describeErrorAt } from './tool'

/**
 * `atob` 会不会抛。对账用例里当「真值」用的那一边。
 *
 * ⚠️ 与 `json.test.ts` 里那一份同样的口径说明：这一份是**引擎**的判定，而 Vela 真机上的
 * 引擎是 JavaScriptCore。两者的判定都来自同一份 WHATWG「forgiving-base64」规范，
 * 会分歧的只有错误**消息**——而消息正是我们压根不读的东西
 */
function atobFails(text: string): boolean {
  try {
    atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    return false
  } catch {
    return true
  }
}

/**
 * `atob` 收的。⚠️ 这一份里刻意混着三种「看着像错、其实引擎收」的写法：
 * 缺 padding 的（`YWJjZA`）、base64url 字母表的（`YW-_AA`）、夹着各种空白的（PEM 那种折行）。
 * 少任何一种，扫描器就可能被写成「比引擎严」的样子而没人发现——那会让工具在一份
 * 能解的输入上报错，而用户手里那份 base64 明明是好的
 */
const B64_VALID = [
  '',
  'YWJj',
  'AQ==',
  'AQI=',
  'AQID',
  'YWJjZA',
  'YWJjZGE=',
  'Y W J j',
  'Y\nW\tJ\rj',
  'YW-_AA',
  'iVBORw==',
  '5Lit5paH8J+YgA==',
]

/** `atob` 抛的 */
const B64_INVALID = [
  'Y',
  'YWJjZ',
  'YWJjZA=',
  'YWJj=',
  'Y===',
  '====',
  'a*bc',
  'a b\u00a0c',
  'YWJjZA===',
  'YWJj=AAA',
  'Y=Jj',
  '中文',
  'ZW5k\u200b',
]

describe('scanBase64 ↔ atob 对账', () => {
  it('🔴 扫描器说没错当且仅当 atob 不抛', () => {
    for (const sample of [...B64_VALID, ...B64_INVALID]) {
      const found = scanBase64(sample)
      expect(found === null, JSON.stringify(sample)).toBe(!atobFails(sample))
    }
  })

  it('报出来的下标永远落在串里，而 ^ 也落在示意图那一行的范围内', () => {
    for (const sample of B64_INVALID) {
      const found = scanBase64(sample)
      if (found === null) continue
      expect(found.offset, JSON.stringify(sample)).toBeGreaterThanOrEqual(0)
      expect(found.offset, JSON.stringify(sample)).toBeLessThanOrEqual(sample.length)
      const lines = describeErrorAt(sample, found.offset, found.expected).split('\n')
      expect(lines, JSON.stringify(sample)).toHaveLength(3)
      const caret = lines[2]!.indexOf('^')
      expect(caret, JSON.stringify(sample)).toBeGreaterThan(1)
      expect(caret, JSON.stringify(sample)).toBeLessThanOrEqual(lines[1]!.length)
      const under = lines[1]![caret]
      if (under !== undefined) expect(under, JSON.stringify(sample)).toBe(sample[found.offset])
    }
  })

  it('非法字符指的是**那一个字符**，而长度不对指的是串尾', () => {
    expect(scanBase64('a*bc')).toEqual({ offset: 1, expected: 'Base64 的字母表里没有「*」' })
    // 长度这一类错在末尾之后一格：那里正是「少了东西」该指的地方
    expect(scanBase64('Y')?.offset).toBe(1)
    expect(scanBase64('YWJjZA=')?.offset).toBe(7)
    expect(scanBase64('Y')?.expected).toBe('去掉空白之后这里有 1 个字符，而 Base64 的长度必须是 4 的倍数')
  })

  it('看不见的字符报码位，⛔ 不报一个与真空格长得一样的字形', () => {
    // 从网页与聊天窗口复制 base64 时，不换行空格与零宽空格都会混进来。
    // 指着一个看不见的东西说「这里不对」，用户只会以为工具坏了
    expect(scanBase64('a b\u00a0c')?.expected).toBe('Base64 的字母表里没有这个字符（U+00A0）')
    expect(scanBase64('ZW5k\u200b')?.expected).toBe('Base64 的字母表里没有这个字符（U+200B）')
    expect(scanBase64('中文')?.expected).toBe('Base64 的字母表里没有这个字符（U+4E2D）')
  })

  it('「=」的个数取决于它前面有几个正文字符', () => {
    expect(scanBase64('YWJj=')?.expected).toBe('这里不该有「=」：它前面有 4 个字符，而 4 个字符后面最多补 0 个「=」')
    expect(scanBase64('Y=Jj')?.offset).toBe(1)
    expect(scanBase64('YWJjZA===')?.offset).toBe(8)
    expect(scanBase64('YWJj=AAA')).toEqual({
      offset: 4,
      expected: '这里不该有「=」：它前面有 4 个字符，而 4 个字符后面最多补 0 个「=」',
    })
  })

  it('空白被跳过，而它不占正文的计数', () => {
    expect(scanBase64('Y W J j')).toBeNull()
    // ⚠️ 但**不换行空格**不是空白：`atob` 也拒它，所以这一份必须报错
    expect(scanBase64('Y W\u00a0J j')).not.toBeNull()
  })
})

describe('base64Encode', () => {
  it('🔴 中文与 emoji 走的是 TextEncoder，⛔ 不是把字符串直接交给 btoa', () => {
    // `btoa('中文')` 是 InvalidCharacterError——`btoa` 要求每个码元都 < 256。
    // 这一条钉住的是「我们绕开了它」，而绕开的方式是编成 UTF-8 字节再逐字节当 Latin-1 码元
    expect(() => btoa('中文')).toThrow()
    expect(base64Encode('中文😀')).toEqual({ kind: 'ok', text: '5Lit5paH8J+YgA==' })
  })

  it('空输入给空串', () => {
    expect(base64Encode('')).toEqual({ kind: 'ok', text: '' })
  })

  it('ASCII 的编码结果与 btoa 一致', () => {
    expect(base64Encode('abc')).toEqual({ kind: 'ok', text: 'YWJj' })
    expect(base64Encode('abcd')).toEqual({ kind: 'ok', text: 'YWJjZA==' })
  })

  it('🔴 编出来的一定解得回去，包括换行与制表符', () => {
    for (const text of ['', 'a', 'ab', 'abc', '中文😀', 'a\nb\tc\r\nd', '\u0000\u0001\uffff']) {
      const encoded = base64Encode(text)
      expect(encoded.kind, JSON.stringify(text)).toBe('ok')
      expect(base64Decode(encoded.text), JSON.stringify(text)).toEqual({ kind: 'ok', text })
    }
  })
})

describe('base64Decode', () => {
  it('标准的、缺 padding 的、base64url 的都收', () => {
    expect(base64Decode('YWJj')).toEqual({ kind: 'ok', text: 'abc' })
    expect(base64Decode('YWJjZA')).toEqual({ kind: 'ok', text: 'abcd' })
    // JWT 的三段就是这个字母表。放宽它是刻意的：一对一替换，下标一个都不动
    expect(base64Decode('YW-_AA')).toEqual(base64Decode('YW+/AA'))
    expect(base64Decode('Y W J j')).toEqual({ kind: 'ok', text: 'abc' })
    expect(base64Decode('5Lit5paH8J+YgA==')).toEqual({ kind: 'ok', text: '中文😀' })
  })

  it('出错时给三行文案**和**那个下标', () => {
    const out = base64Decode('a*bc')
    expect(out.kind).toBe('error')
    expect(out.at).toBe(1)
    expect(out.text).toBe('第 1 行第 2 列：Base64 的字母表里没有「*」\n  a*bc\n   ^')
  })

  it('第二行上的错，行号与列号都对', () => {
    const out = base64Decode('YWJj\na*bc')
    expect(out.at).toBe(6)
    expect(out.text.split('\n')[0]).toBe('第 2 行第 2 列：Base64 的字母表里没有「*」')
  })

  it('🔴 解出来的字节不是 UTF-8 时**不给** `at`，只说清是什么情况', () => {
    // `iVBORw==` 是 PNG 头那四个字节，它们不是合法的 UTF-8。
    // 那个「第几个字节坏了」是**字节**流里的下标，而 `at` 是输入格里的**字符**下标，
    // 中间隔着「4 个字符变 3 个字节」和「被 atob 吃掉的空白」两层换算——
    // 差一格就是一个指错地方的按钮，比没有这个按钮更坏
    const out = base64Decode('iVBORw==')
    expect(out.kind).toBe('error')
    expect(out.at).toBeUndefined()
    expect(out.text).toContain('4 个字节')
    expect(out.text).toContain('不是合法的 UTF-8')
  })
})

describe('findLoneSurrogate', () => {
  it('没有代理项的串返回 -1', () => {
    expect(findLoneSurrogate('abc 中文')).toBe(-1)
    expect(findLoneSurrogate('')).toBe(-1)
  })

  it('成对的代理项不算落单', () => {
    expect(findLoneSurrogate('a😀b')).toBe(-1)
    expect(findLoneSurrogate('😀😀')).toBe(-1)
  })

  it('落单的高代理项与低代理项都找得出来', () => {
    expect(findLoneSurrogate('a\ud800b')).toBe(1)
    expect(findLoneSurrogate('a\udc00b')).toBe(1)
    // 串尾那一个：`charCodeAt` 越界给 NaN，而 `NaN >= 0xdc00` 是 false，所以它也落在「落单」那一支
    expect(findLoneSurrogate('ab\ud800')).toBe(2)
  })

  it('🔴 找出来的下标正是引擎编不动的那一个', () => {
    for (const sample of ['a\ud800b', 'a\udc00b', 'ab\ud800', '\ud800']) {
      const at = findLoneSurrogate(sample)
      expect(() => encodeURIComponent(sample)).toThrow()
      expect(sample.charCodeAt(at)).toBeGreaterThanOrEqual(0xd800)
      expect(sample.charCodeAt(at)).toBeLessThanOrEqual(0xdfff)
    }
  })
})

describe('urlEncode', () => {
  it('两种口径的差别正是那几个结构字符', () => {
    // 「值」用 encodeURIComponent：整段都要进 query 的一个值里，`&` 与 `=` 必须编掉
    expect(urlEncode('a b&c=d/e?f#g', false)).toEqual({ kind: 'ok', text: 'a%20b%26c%3Dd%2Fe%3Ff%23g' })
    // 「整条」用 encodeURI：那些字符**是**这条 URL 的结构，编掉就换了一个意思
    expect(urlEncode('a b&c=d/e?f#g', true)).toEqual({ kind: 'ok', text: 'a%20b&c=d/e?f#g' })
  })

  it('中文两种口径下都编成 UTF-8 百分号', () => {
    expect(urlEncode('中', false)).toEqual({ kind: 'ok', text: '%E4%B8%AD' })
    expect(urlEncode('中', true)).toEqual({ kind: 'ok', text: '%E4%B8%AD' })
  })

  it('空输入给空串', () => {
    expect(urlEncode('', false)).toEqual({ kind: 'ok', text: '' })
    expect(urlEncode('', true)).toEqual({ kind: 'ok', text: '' })
  })

  it('落单代理项：三行文案 + 那个下标', () => {
    const out = urlEncode('ab\ud800cd', false)
    expect(out.kind).toBe('error')
    expect(out.at).toBe(2)
    expect(out.text.split('\n')[0]).toBe('第 1 行第 3 列：这里是一个落单的代理项（半个字符），编不出 UTF-8 字节来')
  })
})

describe('scanPercent', () => {
  it('合法的百分号语法一律 null', () => {
    for (const sample of ['', 'abc', 'a%20b', '%E4%B8%AD', '100%25', 'a+b', '%ff', '%Ff']) {
      expect(scanPercent(sample), JSON.stringify(sample)).toBeNull()
    }
  })

  it('缺位、非十六进制各指在自己那一个字符上', () => {
    expect(scanPercent('%')).toEqual({ offset: 0, expected: '「%」后面该跟着两个十六进制位，这里已经到了末尾' })
    expect(scanPercent('%2')).toEqual({ offset: 0, expected: '「%」后面该跟着两个十六进制位，这里只有一个' })
    expect(scanPercent('%zz')).toEqual({ offset: 1, expected: '「%」后面该是十六进制位，而不是「z」' })
    expect(scanPercent('%2z')).toEqual({ offset: 2, expected: '「%」后面该是十六进制位，而不是「z」' })
    expect(scanPercent('a%2')).toEqual({ offset: 1, expected: '「%」后面该跟着两个十六进制位，这里只有一个' })
    expect(scanPercent('a%zz')?.offset).toBe(2)
  })

  it('🔴 与 decodeURIComponent 对账：语法全对而引擎抛了，就一定是字节不是 UTF-8', () => {
    // 这一条钉的是 `urlDecode` 那句没有位置的文案**为什么可以写得那么确定**：
    // `decodeURIComponent` 抛 URIError 只有两种原因，排掉一种就只剩另一种
    const badSyntax = ['%', '%2', '%zz', '%2z', 'a%2', 'a%zz', '%%20']
    for (const sample of badSyntax) {
      expect(() => decodeURIComponent(sample), JSON.stringify(sample)).toThrow()
      expect(scanPercent(sample), JSON.stringify(sample)).not.toBeNull()
    }
    const badBytes = ['%E4%B8', '%FF%FF', '%80', '%C0%80']
    for (const sample of badBytes) {
      expect(() => decodeURIComponent(sample), JSON.stringify(sample)).toThrow()
      expect(scanPercent(sample), JSON.stringify(sample)).toBeNull()
    }
  })

  it('跳过一整组 `%XX`，不把里面那两位又当成新的开头', () => {
    expect(scanPercent('%25%25')).toBeNull()
    expect(scanPercent('%25%2')).toEqual({ offset: 3, expected: '「%」后面该跟着两个十六进制位，这里只有一个' })
  })
})

describe('urlDecode', () => {
  it('百分号解回文字', () => {
    expect(urlDecode('%E4%B8%AD')).toEqual({ kind: 'ok', text: '中' })
    expect(urlDecode('a%20b')).toEqual({ kind: 'ok', text: 'a b' })
    expect(urlDecode('100%25')).toEqual({ kind: 'ok', text: '100%' })
    expect(urlDecode('')).toEqual({ kind: 'ok', text: '' })
  })

  it('🔴 `+` 原样留着——把它当空格是表单编码的规矩，不是 URI 的', () => {
    // 一个「URL 解码」按钮悄悄改掉数据里的加号，是那种当时看着对、回头才发现少了东西的错
    expect(urlDecode('a+b')).toEqual({ kind: 'ok', text: 'a+b' })
    expect(urlDecode('1%2B2')).toEqual({ kind: 'ok', text: '1+2' })
  })

  it('语法坏了给三行文案 + 那个下标', () => {
    const out = urlDecode('a%zz')
    expect(out.kind).toBe('error')
    expect(out.at).toBe(2)
    expect(out.text).toBe('第 1 行第 3 列：「%」后面该是十六进制位，而不是「z」\n  a%zz\n    ^')
  })

  it('语法对而字节不是 UTF-8 时不给 `at`，但那句话说清了原因', () => {
    const out = urlDecode('%E4%B8')
    expect(out.kind).toBe('error')
    expect(out.at).toBeUndefined()
    expect(out.text).toContain('不是合法的 UTF-8')
    expect(out.text).toContain('截断')
  })

  it('🔴 编过来再解回去是原样，两种口径都试', () => {
    for (const text of ['', 'abc', 'a b&c=d', '中文😀', '100%', 'a+b', '<script>alert(1)</script>']) {
      expect(urlDecode(urlEncode(text, false).text), JSON.stringify(text)).toEqual({ kind: 'ok', text })
    }
  })
})
