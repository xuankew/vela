/**
 * JSON 工具的三件纯活（M3-B-2）：**定位**第一个语法错、把两种注释**等长**抹掉、按键排序。
 *
 * ## 🔴 为什么这里有一个 JSON 扫描器，而不是直接读 `JSON.parse` 那句话
 *
 * 因为**运行环境不是 V8**。Vela 跑在 WKWebView 里，那是 JavaScriptCore，
 * 而两个引擎的错误消息是两回事：
 *
 * | 引擎 | `JSON.parse('{"a":1,}')` 的消息 |
 * | --- | --- |
 * | V8（Node 20+） | `Expected double-quoted property name in JSON at position 7 (line 1 column 8)` |
 * | JavaScriptCore | `JSON Parse error: Expected '}'` |
 *
 * JSC **压根不给位置**。而 `ToolResult.text` 那条注释把「要说清哪一行哪一列」写成了
 * 这个工具的契约——靠正则去抠引擎的消息，等于把契约挂在一句随版本变的英文上，
 * 而且在真机上（也就是 JSC 上）必然抠不到。所以位置自己算。
 *
 * ⚠️ 于是分工是：**值由 `JSON.parse` 建**（它比我们快、也比我们准），
 * 扫描器**只在解析已经失败之后跑**去找那个位置。它 bails 在第一个错上，
 * 所以合法输入永远不会走到它，1 MB 的正经 JSON 也只有解析失败时才多扫一小段。
 *
 * ## 🔴 扫描器是**迭代**的，不是递归下降
 *
 * 一份 `[[[[…` 套两万层的输入会把递归下降的栈掀掉——而那正是 `JSON.parse` 失败之后
 * 我们会喂给它的东西（引擎自己的栈也可能已经掀过一次）。改成显式栈之后
 * 「嵌套太深」这件事从「我们的工具崩了」变成「一条如实说出来的错」
 *
 * ## ⚠️ 零新依赖，⛔ 不是 `json5`
 *
 * `json5` 能顺带把注释、尾逗号、单引号全收下来，但那是**换了一门语言**：
 * 输出就不再是合法的 JSON，而「格式化 JSON」这个工具给出一个 `JSON.parse` 读不回去的结果
 * 是错的。要收的只有注释一种（`tsconfig.json` / `.vscode/settings.json` 太常见了），
 * 而它是**可选开关**，默认开、可以关，关掉之后这个工具与 `JSON.parse` 一字不差
 */

import type { LocatedError } from './tool'

/**
 * 扫描一段的小结果。`error === null` 就是扫过去了。
 *
 * ⚠️ `end` 是**一词两用**的：扫成功时它是「下一个 token 从哪儿开始」，
 * 扫失败时它是「错在哪个下标」。两个语义之所以能共用一个字段，是因为它们指的是同一件事——
 * 扫描停下来的地方。分成两个字段的话，每一个 `BAD(...)` 都得填一个没人读的 `end`
 */
interface Scan {
  readonly end: number
  readonly error: string | null
}

const OK = (end: number): Scan => ({ end, error: null })
const BAD = (end: number, error: string): Scan => ({ end, error })

/** 严格 JSON 的空白只有这四个。⛔ 不含 `\f`、`\v`、` `，那些 `JSON.parse` 也一律不收 */
function skipWhitespace(text: string, i: number): number {
  for (;;) {
    const c = text.charCodeAt(i)
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++
    else return i
  }
}

/**
 * 扫一个字符串字面量，`text[at]` 必须已经是那个开头的 `"`。
 *
 * ⚠️ **不建值**，只走到收尾引号之后：值由 `JSON.parse` 建，这里多做一遍就是两遍活
 */
function scanString(text: string, at: number): Scan {
  const n = text.length
  let i = at + 1
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 0x22) return OK(i + 1)
    if (c === 0x5c) {
      const e = text.charCodeAt(i + 1)
      if (
        e === 0x22 || // "
        e === 0x5c || // \
        e === 0x2f || // /
        e === 0x62 || // b
        e === 0x66 || // f
        e === 0x6e || // n
        e === 0x72 || // r
        e === 0x74 // t
      ) {
        i += 2
        continue
      }
      if (e === 0x75) {
        // u
        if (i + 6 > n) return BAD(i, '\\u 后面该有四个十六进制位')
        for (let k = i + 2; k < i + 6; k++) {
          const h = text.charCodeAt(k)
          const isHex = (h >= 0x30 && h <= 0x39) || (h >= 0x41 && h <= 0x46) || (h >= 0x61 && h <= 0x66)
          if (!isHex) return BAD(k, '\\u 后面该有四个十六进制位')
        }
        i += 6
        continue
      }
      if (Number.isNaN(e)) return BAD(i, '字符串在反斜杠后面就结束了')
      return BAD(i + 1, `反斜杠后面不能跟「${text[i + 1] ?? ''}」，能跟的只有 " \\ / b f n r t u`)
    }
    // 🔴 裸的控制字符（含换行）在 JSON 字符串里是不合法的，而这是**最常撞见**的那一种错：
    // 从别处拷了一段多行文本进引号里。说清「要写成 \n」比说「非法字符」有用
    if (c < 0x20) return BAD(i, '字符串里不能有裸的控制字符——换行要写成 \\n')
    i++
  }
  return BAD(n, '这个字符串少了收尾的那个引号')
}

/** 扫一个数字字面量。⛔ 不收 `01`、`.5`、`1.`、`+1`、`Infinity`、`NaN`——`JSON.parse` 也不收 */
function scanNumber(text: string, at: number): Scan {
  const n = text.length
  let i = at
  if (text[i] === '-') i++
  const first = text.charCodeAt(i)
  if (first === 0x30) {
    // 0
    i++
    const next = text.charCodeAt(i)
    if (next >= 0x30 && next <= 0x39) return BAD(i, '数字不能以 0 开头——01 要写成 1')
  } else if (first >= 0x31 && first <= 0x39) {
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c < 0x30 || c > 0x39) break
      i++
    }
  } else {
    return BAD(at, '这里该有一个数字')
  }
  if (text[i] === '.') {
    i++
    const fracStart = i
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c < 0x30 || c > 0x39) break
      i++
    }
    if (i === fracStart) return BAD(i, '小数点后面该有数字')
  }
  if (text[i] === 'e' || text[i] === 'E') {
    i++
    if (text[i] === '+' || text[i] === '-') i++
    const expStart = i
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c < 0x30 || c > 0x39) break
      i++
    }
    if (i === expStart) return BAD(i, 'e 后面该有指数的数字')
  }
  return OK(i)
}

function scanKeyword(text: string, at: number, word: string): Scan {
  return text.startsWith(word, at) ? OK(at + word.length) : BAD(at, `这里该是 ${word}`)
}

/** 扫一个「不是容器开头」的值：字符串 / 数字 / true / false / null */
function scanAtom(text: string, at: number): Scan {
  const ch = text[at] ?? ''
  if (ch === '"') return scanString(text, at)
  if (ch === 't') return scanKeyword(text, at, 'true')
  if (ch === 'f') return scanKeyword(text, at, 'false')
  if (ch === 'n') return scanKeyword(text, at, 'null')
  // JS 里有、JSON 里没有的那三个。单独说一句，因为「我以为 JSON 收 NaN」是个很常见的误会
  if (text.startsWith('NaN', at)) return BAD(at, 'JSON 里没有 NaN')
  if (text.startsWith('Infinity', at)) return BAD(at, 'JSON 里没有 Infinity')
  if (text.startsWith('undefined', at)) return BAD(at, 'JSON 里没有 undefined')
  if (ch === "'") return BAD(at, 'JSON 的字符串用双引号，不用单引号')
  if (ch === '-' || (ch >= '0' && ch <= '9')) return scanNumber(text, at)
  return BAD(at, `这里不该是「${ch}」`)
}

/** 栈里的一层：1 = 数组，2 = 对象 */
const ARRAY = 1
const OBJECT = 2

/** 下一个 token 该是什么 */
type Want = 'value' | 'item' | 'keyFirst' | 'key' | 'colon' | 'after'

/**
 * 找出第一个语法错。返回 `null` = 这一段是合法 JSON。
 *
 * ⚠️ 「合法」的口径就是 `JSON.parse` 的口径：不收注释、不收尾逗号、不收单引号、
 * 不收 `01`。这一条由 `json.test.ts` 里那份**对账**用例钉着——同一批样本上，
 * `scanJson` 说没错当且仅当 `JSON.parse` 不抛
 */
export function scanJson(text: string): LocatedError | null {
  const n = text.length
  const stack: number[] = []
  let want: Want = 'value'
  let i = 0

  for (;;) {
    i = skipWhitespace(text, i)
    const ch = i < n ? (text[i] as string) : ''

    if (want === 'value' || want === 'item') {
      // 空数组那一下：`[` 后面直接跟 `]`
      if (want === 'item' && ch === ']') {
        stack.pop()
        i++
        want = 'after'
        continue
      }
      if (ch === '') {
        // `want === 'item'` 是「数组的第一项」，那里 `]` 是合法的，所以话要说全
        return { offset: n, expected: want === 'item' ? '这里该有一个值或者「]」' : '这里该有一个值' }
      }
      if (ch === '{') {
        i++
        stack.push(OBJECT)
        want = 'keyFirst'
        continue
      }
      if (ch === '[') {
        i++
        stack.push(ARRAY)
        want = 'item'
        continue
      }
      const atom = scanAtom(text, i)
      if (atom.error !== null) return { offset: atom.end, expected: atom.error }
      i = atom.end
      want = 'after'
      continue
    }

    if (want === 'keyFirst' || want === 'key') {
      // 🔴 `}` 只在 `{` 后面那一下合法（空对象）。**逗号后面**再来一个 `}` 是尾逗号，
      // 而那是 JSON 里最常打错的一种——把两个状态合成一个 `key` 的话，
      // `{"a":1,}` 会被扫成合法的，于是 `JSON.parse` 抛了、扫描器却说「我找不到错」，
      // 用户得到的是一句没有位置的英文
      if (want === 'keyFirst' && ch === '}') {
        stack.pop()
        i++
        want = 'after'
        continue
      }
      if (ch === '') {
        return {
          offset: n,
          expected: want === 'keyFirst' ? '这里该有一个键（带双引号的字符串）或者「}」' : '这个对象少了收尾的「}」',
        }
      }
      if (ch !== '"') {
        return {
          offset: i,
          expected: want === 'key' ? `逗号后面该有下一个键，而不是「${ch}」` : '对象的键必须是带双引号的字符串',
        }
      }
      const key = scanString(text, i)
      if (key.error !== null) return { offset: key.end, expected: key.error }
      i = key.end
      want = 'colon'
      continue
    }

    if (want === 'colon') {
      if (ch !== ':') {
        return { offset: i, expected: ch === '' ? '键后面该有一个「:」' : `键后面该有一个「:」，而不是「${ch}」` }
      }
      i++
      want = 'value'
      continue
    }

    // want === 'after'：一个值刚结束
    if (stack.length === 0) {
      if (ch === '') return null
      return { offset: i, expected: '正文到这里已经结束了，后面不该再有字符' }
    }
    const top = stack[stack.length - 1] as number
    if (ch === ',') {
      i++
      want = top === ARRAY ? 'value' : 'key'
      continue
    }
    if (ch === '') {
      return { offset: n, expected: top === ARRAY ? '这个数组少了收尾的「]」' : '这个对象少了收尾的「}」' }
    }
    if (top === ARRAY && ch === ']') {
      stack.pop()
      i++
      want = 'after'
      continue
    }
    if (top === OBJECT && ch === '}') {
      stack.pop()
      i++
      want = 'after'
      continue
    }
    return {
      offset: i,
      expected: top === ARRAY ? '数组里这一项后面该有一个「,」或者「]」' : '对象里这一项后面该有一个「,」或者「}」',
    }
  }
}

/**
 * 把行注释与块注释**换成等长的空白**。
 *
 * 🔴 等长是承重的，不是省事：抹完注释之后解析的是这一份，而报错要指的是
 * **用户在输入格里看得见的那一份**。删掉注释的话两边的下标立刻错位，
 * 「第 3 行第 12 列」会指到另一个地方去——而那正是「跳到出错处」这个功能存在的理由。
 * 等长 + 保住 `\n` 之后，抹掉注释的那一份与原始输入**逐下标对齐**，
 * 于是位置可以直接用，而给用户看的那一行也从原始输入里取（见 `builtin.ts`）
 *
 * ⚠️ 这一步**不报错**，哪怕注释没闭合、哪怕字符串没闭合：报错是扫描器的事，
 * 两个地方都能报错的话，用户会看到一句与另一句对不上的话
 */
export function blankJsonComments(text: string): string {
  const n = text.length
  const out: string[] = []
  let last = 0
  let i = 0

  while (i < n) {
    const ch = text[i] as string
    if (ch === '"') {
      // 字符串整段原样留着。⚠️ 不合法也照样跳过它：`scanString` 返回的 `end`
      // 在这种情况下就是 `n`，于是这一趟到此为止，剩下的交给解析器去说
      i = scanString(text, i).end
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      let end = i + 2
      while (end < n && text.charCodeAt(end) !== 0x0a) end++
      out.push(text.slice(last, i), ' '.repeat(end - i))
      last = end
      i = end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      // 🔴 换行留着，其余一律换成空格：`locate` 数行号数的是 `\n`，
      // 少了它，注释后面每一行的行号都会往上挪
      out.push(text.slice(last, i), text.slice(i, end).replace(/[^\n]/g, ' '))
      last = end
      i = end
      continue
    }
    i++
  }

  // 没有注释的那一条路一个字符都不拷，于是 `last` 还是 0——直接把原串还回去，
  // 不做那一趟 `join`（一百万个字符的输入上这是一次白拷）
  if (last === 0) return text
  out.push(text.slice(last))
  return out.join('')
}

/**
 * 递归地把对象的键按码位排。
 *
 * ⚠️ 排序用 `<` / `>` 而不是 `localeCompare`：中文键在 ICU 下按拼音排、
 * 在没有 ICU 的构建下按码位排，同一份代码在两个环境里给出两个顺序
 * （`tool.ts` 的 `groupTools`、`commands/registry.ts` 的 `list()` 同一条口径）
 *
 * 🔴 **数字形状的键排不动**，而这不是 bug：JS 对象把「像数组下标的键」永远排在
 * 字符串键前面并按数值升序，赋值顺序改变不了它。所以 `{"10":1,"2":2,"b":3}`
 * 排完还是 `2, 10, b`。`json.test.ts` 把这个行为钉住了——哪天有人以为这里写错了
 * 去「修」，那条用例会告诉他修不动，而该改的是文档不是代码
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))) {
      out[key] = sortKeysDeep(source[key])
    }
    return out
  }
  return value
}
