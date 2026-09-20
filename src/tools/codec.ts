/**
 * Base64 与 URL 编解码的**纯活**（M3-B-3，PLAN §3.5）。
 *
 * 这一层只认字符串、只返回 `ToolResult`，⛔ 不认识描述符、不认识选项条、也不认识 Solid。
 * 「模式」那五个中文名与 `switch` 住在 `builtin.ts`，与 JSON 那一个工具同一条口径。
 *
 * ## 🔴 为什么这里也有自己的扫描器
 *
 * 与 `json.ts` 一模一样的理由：**引擎的错误消息里没有位置**。Vela 真机上的引擎是
 * JavaScriptCore，实测这一份 jsdom 环境里四条失败路径的消息是：
 *
 * | 调用 | 失败时 |
 * |---|---|
 * | `atob('Y')` | `InvalidCharacterError: The string to be decoded is not correctly encoded.` |
 * | `atob('a*')` | `InvalidCharacterError: Invalid character` |
 * | `new TextDecoder('utf-8', {fatal:true}).decode(坏字节)` | `TypeError: The encoded data was not valid for encoding utf-8` |
 * | `decodeURIComponent('%zz')` | `URIError: URI malformed` |
 *
 * 四句里**一个下标都没有**。于是与 JSON 同一条决定：引擎负责判定，我们自己负责说清
 * 「错在第几行第几列」。扫描器**只在引擎已经抛了之后**才跑，所以它不需要与引擎在
 * 「什么算合法」上一字不差——它只需要在这段已经被判死的文字里**找出一处能指的地方**。
 * 找不到（返回 `null`）就如实把一句没有位置的话交出去，⛔ 不编一个下标。
 *
 * ## ⚠️ `atob` 的三个脾气，都实测过
 *
 * 1. **吃掉所有 ASCII 空白**（空格、`\t`、`\n`、`\r` 都收），所以从 PEM 证书里连着
 *    `-----BEGIN-----` 一起复制过来的那种 64 字符一折行的 base64 是能直接解的。
 *    但**不换行空格 ` ` 不算空白**，会被当成非法字符——而从网页上复制过来的
 *    base64 里它相当常见，所以扫描器对不可打印字符报的是码位而不是那个看不见的字形
 * 2. **不收 base64url 的 `-` 与 `_`**。这一条我们**放宽**了：JWT 的三段就是 base64url，
 *    粘进来是高频场景，而 `-`→`+`、`_`→`/` 是一对一替换，下标一个都不动
 * 3. **收缺 padding 的**（`atob('YWJjZA')` 给出 `abcd`），所以「少一个 `=`」⛔ 不算错；
 *    但**写了却写错个数**（`YWJjZA=`）算错，因为引擎在那一份上确实抛
 *
 * ## ⚠️ 解出来的字节不是 UTF-8 时，**不给** `at`
 *
 * 那个下标是**字节**流里的，而 `ToolResult.at` 与「跳到出错处」用的是**输入格里的字符**
 * 下标。两者之间要隔一层「base64 每 4 个字符变 3 个字节」的换算，而输入里还可能夹着
 * 被 `atob` 吃掉的空白——换算出来的位置差一格，就是一个指错地方的按钮，比没有这个按钮更坏
 * （同一条理由见 §3.5「M3-B-2 实施修正」8）。所以这一条只说清「它是二进制或别的编码」
 *
 * ## ⚠️ URL 解码**不**把 `+` 当空格
 *
 * 实测 `decodeURIComponent('a+b') === 'a+b'`。把 `+` 当空格是
 * `application/x-www-form-urlencoded` 那一种编码的规矩，不是 URI 的。
 * 一个「URL 解码」按钮悄悄改掉数据里的加号，是那种当时看着对、回头才发现少了东西的错
 *
 * ## ⚠️ 零新依赖
 *
 * `TextEncoder` / `TextDecoder` / `btoa` / `atob` / `encodeURIComponent` 全是平台自带的。
 * 字节与 base64 之间那两个原语来自 `src/util/base64.ts`（`ipc/asset.ts` 也用同一份）
 */

import { base64ToBytes, bytesToBase64 } from '../util/base64'
import { describeCharAt, describeErrorAt, type LocatedError, type ToolResult } from './tool'

/** 文字 → 标准 base64。先 `TextEncoder` 编成 UTF-8 字节，⛔ 不能直接 `btoa(text)` */
export function base64Encode(text: string): ToolResult {
  return { kind: 'ok', text: bytesToBase64(new TextEncoder().encode(text)) }
}

function isAsciiSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

/** base64 的正文字母表。⚠️ 含 base64url 的 `-` 与 `_`，理由见模块文档 */
function isBase64Body(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x2d ||
    code === 0x5f
  )
}

/**
 * 在这段已经被 `atob` 判死的文字里找一处能指的地方。返回 `null` = 看不出来。
 *
 * 🔴 `body` 数的是**正文字符**，`pads` 数的是 `=`，两者分开数是因为 `=` 的合法性
 * 取决于它前面有几个正文字符：`body % 4 === 3` 时只允许一个 `=`，`=== 2` 时允许两个，
 * 其余时候一个都不允许。合并成一个「长度」的话这三种情况就分不开了
 */
export function scanBase64(text: string): LocatedError | null {
  let body = 0
  let pads = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (isAsciiSpace(code)) continue

    if (code === 0x3d) {
      pads++
      const allowed = body % 4 === 2 ? 2 : body % 4 === 3 ? 1 : 0
      if (pads > allowed) {
        return {
          offset: i,
          expected: `这里不该有「=」：它前面有 ${body} 个字符，而 ${body} 个字符后面最多补 ${allowed} 个「=」`,
        }
      }
      continue
    }

    if (pads > 0) return { offset: i, expected: '「=」后面不该再有内容' }
    if (!isBase64Body(code)) return { offset: i, expected: notInAlphabet(text, i) }
    body++
  }

  const total = body + pads
  // ⚠️ `pads === 0` 时只有 `body % 4 === 1` 才算错：`=== 2` 与 `=== 3` 是**缺 padding**，
  // 而 `atob` 收（见模块文档第 3 条）。既然引擎收，我们就不能说它错
  if ((pads === 0 && body % 4 === 1) || (pads > 0 && total % 4 !== 0)) {
    return { offset: text.length, expected: `去掉空白之后这里有 ${total} 个字符，而 Base64 的长度必须是 4 的倍数` }
  }
  return null
}

/**
 * 「这个字符不在字母表里」那一句。
 *
 * ⚠️ 怎么说那个字符是 `tool.ts` 的 `describeCharAt` 的事（不可打印的报码位，
 * 越界的说「末尾」），这一层只负责把「Base64 的字母表里没有」接在前面
 */
function notInAlphabet(text: string, at: number): string {
  return `Base64 的字母表里没有${describeCharAt(text, at)}`
}

/** base64 → 文字。base64url 也收，缺 padding 也收，理由见模块文档 */
export function base64Decode(text: string): ToolResult {
  // 🔴 一对一替换，所以 `normalized` 与 `text` 逐下标对齐——扫描器报出来的 `offset`
  // 因此能直接拿去选**输入格**里的那一行，而示意图那一行也是从 `text` 取的
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')

  let binary: string
  try {
    binary = atob(normalized)
  } catch (err) {
    const found = scanBase64(text)
    if (found === null) return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
    return { kind: 'error', text: describeErrorAt(text, found.offset, found.expected), at: found.offset }
  }

  const bytes = base64ToBytes(binary)
  try {
    return { kind: 'ok', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    // ⛔ 不给 `at`，理由见模块文档
    return {
      kind: 'error',
      text: `解出来的是 ${bytes.length} 个字节，而它们不是合法的 UTF-8——多半是二进制（图片、压缩包…），或者是别的编码（GBK 之类）的文字。这个工具只输出文字`,
    }
  }
}

/**
 * 第一个落单的代理项在哪个下标，找不到返回 `-1`。
 *
 * ⚠️ `encodeURI` / `encodeURIComponent` 遇到落单代理项一律抛 `URIError: URI malformed`，
 * 消息里没有位置。而在 UTF-16 里「半个字符」是能从网页、从 JSON 的 `\ud800` 转义、
 * 从被截断的字符串里混进来的，指出来是有用的
 */
export function findLoneSurrogate(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      // 末尾的 `charCodeAt` 给 NaN，而 `NaN >= 0xdc00` 是 false，所以「串尾一个高代理项」也落在这一支
      if (next >= 0xdc00 && next <= 0xdfff) i++
      else return i
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return i
    }
  }
  return -1
}

/** 文字 → 百分号编码。`whole` 为真时用 `encodeURI`（保留 `/ ? # & =` 这些结构字符） */
export function urlEncode(text: string, whole: boolean): ToolResult {
  try {
    return { kind: 'ok', text: whole ? encodeURI(text) : encodeURIComponent(text) }
  } catch (err) {
    const at = findLoneSurrogate(text)
    if (at < 0) return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
    return {
      kind: 'error',
      text: describeErrorAt(text, at, '这里是一个落单的代理项（半个字符），编不出 UTF-8 字节来'),
      at,
    }
  }
}

function isHexDigit(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)
}

/**
 * 第一个写坏了的 `%XX` 在哪儿。返回 `null` = 百分号的**语法**全都合法。
 *
 * 🔴 `null` 这个返回值是有含义的，不只是「没找到」：`decodeURIComponent` 抛 `URIError`
 * 只有两种原因——百分号语法坏了，或者解出来的字节不是合法 UTF-8。所以「语法全对但引擎抛了」
 * 就等于「是后一种」，那一句没有位置的话因此可以写得很确定，而不是一句「不知道哪里错了」
 */
export function scanPercent(text: string): LocatedError | null {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 0x25) continue
    // ⚠️ 越界的 `charCodeAt` 给 NaN，而 `isHexDigit(NaN)` 也是 false。
    // 不先分开这两种情况的话，消息会变成「而不是「undefined」」
    const first = text.charCodeAt(i + 1)
    if (Number.isNaN(first)) return { offset: i, expected: '「%」后面该跟着两个十六进制位，这里已经到了末尾' }
    if (!isHexDigit(first))
      return { offset: i + 1, expected: `「%」后面该是十六进制位，而不是${describeCharAt(text, i + 1)}` }
    const second = text.charCodeAt(i + 2)
    if (Number.isNaN(second)) return { offset: i, expected: '「%」后面该跟着两个十六进制位，这里只有一个' }
    if (!isHexDigit(second))
      return { offset: i + 2, expected: `「%」后面该是十六进制位，而不是${describeCharAt(text, i + 2)}` }
    i += 2
  }
  return null
}

/** 百分号编码 → 文字。⛔ 不把 `+` 当空格，理由见模块文档 */
export function urlDecode(text: string): ToolResult {
  try {
    return { kind: 'ok', text: decodeURIComponent(text) }
  } catch {
    const found = scanPercent(text)
    if (found === null) {
      return {
        kind: 'error',
        text: '每一个「%」后面都是两位合法的十六进制，可解出来的字节不是合法的 UTF-8——常见的原因是把一个汉字（三个字节）截断了，或者这一段本来就不是 UTF-8 编的',
      }
    }
    return { kind: 'error', text: describeErrorAt(text, found.offset, found.expected), at: found.offset }
  }
}
