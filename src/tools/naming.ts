/**
 * 命名风格转换（M3-B-6，六个里的最后一个）。
 *
 * ## 🔴 六种风格**一次全给**，⛔ 没有「目标风格」那一格下拉
 *
 * 与 `codec.ts`（一个下拉五选一）相反。理由是这个工具的实际用法：手上有 `user_name`，
 * **要看一眼才知道**自己要的是 `userName` 还是 `UserName`。做成下拉的话用户得先在六个
 * 英文名字里想清楚要哪个，而想清楚的办法正是把它们都看一遍。
 *
 * ⚠️ 代价与 `time.ts` 一样：输出是**报告**不是「一段可以插回编辑器的东西」，
 * 于是「插回编辑器」在这一个工具上插进去的是六行带标签的对照表。真正按得动的是
 * 「复制结果」，或者直接在输出格里选中要的那一段。M3-B-4 已经为时间戳认下了这一条
 *
 * ## 🔴 整个输入被当成**一个**短语，⛔ 它不是批量转换器
 *
 * 换行与空格在这里与 `_`、`-` 是同一类东西：**分词符**。于是粘两行 `foo\nbar` 得到的是
 * `fooBar`，⛔ 不是「两行各转一遍」。要「一列标识符批量换风格」的话那是另一个工具
 * （它的输出形状是 N 行不是 6 行，而且要决定「按列对齐还是按块分组」），推给
 * 「有人真的要再说」
 *
 * ## 🔴 难的那一半是**分词**，不是拼接
 *
 * 拼六种风格是六行 `join`；分词要同时应付四类边界，而 naive 的 `/[A-Z]/g` 一条都不对：
 *
 * | 输入 | naive 的 `/[A-Z]/` 会给出 | 这里给出 |
 * |---|---|---|
 * | `HTTPServer` | `H T T P Server` → `h_t_t_p_server` | `HTTP` `Server` → `http_server` |
 * | `foo2Bar` | `foo2` `Bar`（碰巧对） | `foo2` `Bar` |
 * | `already-kebab` | `already-kebab`（`-` 不是大写，整串当成一个词） | `already` `kebab` |
 * | `__dunder__` | `__dunder__` | `dunder` |
 *
 * ⚠️ 第一行是**真机上最容易撞见**的那一个：`XMLHttpRequest`、`IOSVersion`、`AWSRegion`
 * 到处都是，而把它们转成 `x_m_l_http_request` 的工具是不能用的
 *
 * ## ⚠️ 大小写信息在分词那一步就被**抹平**了
 *
> 词一律归一成小写（`HTTP` → `http`），于是六种风格各按自己的规则重新上大小写。
 * 后果是 `HTTPServer` 的大驼峰是 `HttpServer` 而**不是** `HTTPServer`。
 * ⛔ 这不是漏了：要「保住缩写的全大写」就得在词上多带一份「它原本是不是全大写」的标记，
 * 而那份标记在蛇形与短横线上没有意义、在小驼峰上会产生 `hTTPServer` 这种东西。
 * 只有常量式（全大写）看起来「还原」了缩写，而那也不是还原，是巧合
 */

import type { ToolResult } from './tool'

/** 六种风格。顺序就是报告里那六行的顺序：驼峰两兄弟挨着，全大写的常量式跟在蛇形后面 */
export const NAMING_STYLES = ['camel', 'pascal', 'snake', 'constant', 'kebab', 'dot'] as const

export type NamingStyle = (typeof NAMING_STYLES)[number]

/**
 * 六种风格的中文名 + 英文名。
 *
 * ⚠️ 中文名是给「一眼扫过去」用的，英文名是给「我知道我要 kebab-case 但不知道中文叫什么」
 * 用的——两个都写，因为这一个工具的读者恰好分成这两拨。
 * 🔴 用**全角冒号**结尾而⛔ 不做列对齐：中文在等宽字体里占两格，而对齐要靠补空格，
 * 补出来的列在文楷（比例字体）下必然是歪的（PLAN 风险 R10，与 `time.ts` 同一条口径）
 */
const STYLE_LABELS: Readonly<Record<NamingStyle, string>> = {
  camel: '小驼峰（camelCase）',
  pascal: '大驼峰（PascalCase）',
  snake: '蛇形（snake_case）',
  constant: '常量（CONSTANT_CASE）',
  kebab: '短横线（kebab-case）',
  dot: '点分（dot.case）',
}

/** ASCII 的字母与数字。⛔ 不含非 ASCII：那一部分走 `isWordCode` 的另一半 */
function isAsciiAlnum(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

function isUpper(code: number): boolean {
  return code >= 0x41 && code <= 0x5a
}

function isLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

/**
 * 「这一个码位算不算词的一部分」。
 *
 * 🔴 非 ASCII 的**字母与数字**算（`\p{L}` / `\p{N}`），标点与空白不算。
 * 于是 `用户名` 是一个词、`用户_name` 是两个词，而 `foo bar` 与 `foo-bar` 与 `foo_bar`
 * 三者在分词这一层是同一个东西——那正是「换行也是分词符」那条规矩的实现位置
 *
 * 🔴 那个 `u` 标志是**必需**的：没有它，`\p{L}` 不是 Unicode 属性转义，
 * 而是「`p` 出现 `{L}` 次」——一份能编译、能跑、而结果全错的正则。
 * ⚠️ 写成 `/[^\P{L}\P{N}]/u`（双重否定，读起来像「不是非字母也不是非数字」）也不行：
 * 一个字符**同时**是 `\P{N}`（不是数字）与 `\p{L}`（是字母），于是它被那个 `^` 排除掉了。
 * 这一份的第一版就是这么写的，而它让所有中文都变成了分隔符
 *
 * ⚠️ 收的是**码位**不是下标：补充平面上的字符（`𠀀`）在 UTF-16 里是两个代理项，
 * 按下标取会各拿到半个，而那半个既不是字母也不是数字，于是那个字会被当成分隔符**丢掉**
 */
const WORD_CODE = /[\p{L}\p{N}]/u

function isWordCode(code: number): boolean {
  return isAsciiAlnum(code) || (code > 0x7f && WORD_CODE.test(String.fromCodePoint(code)))
}

/**
 * 把一个标识符（或一个短语）切成词，**并且一律归一成小写**。
 *
 * 🔴 三条断词边界，缺一条就有一类常见输入会转错：
 *
 * 1. **小写或数字 → 大写**：`fooBar`、`foo2Bar`。这是驼峰的定义
 * 2. **大写 → 大写后跟小写**：`HTTPServer` 要在 `S` 前面断，⛔ 不是在 `P` 后面。
 *    判断要看**再后面一个字符**，所以这一条必须能读 `s[i + 1]`
 * 3. **ASCII 字母数字 ↔ 非 ASCII**：`用户Name` 切成 `用户` 与 `Name`。
 *    ⚠️ 这一条是可选的舒适项，但没有它的话中英混排的标识符会整串粘成一个词，
 *    而六种输出全都一样——一个看起来「什么都没做」的工具
 *
 * ⚠️ **数字与字母之间不断词**：`foo2bar` 是一个词、`v2` 是一个词。
 * 断开的症状是 `user2name` → `user_2_name`，而那一个 `2` 在蛇形里读起来像是版本号的分隔
 *
 * 🔴 单趟扫描，不递归、不用 `split` 之后再 `flatMap`：`MAX_TOOL_CHARS` 是一百万，
 * 而「先按分隔符切、再对每段跑一遍驼峰切分」是两趟外加一堆中间数组
 */
export function splitWords(input: string): string[] {
  const words: string[] = []
  let current = ''
  // ⚠️ 另存一份「上一个码位」而⛔ 不用 `current.charCodeAt(current.length - 1)`：
  // 补充平面上的字符在 `current` 里是两个代理项，从尾巴上取会取到**低代理项**那半个
  let lastCode = Number.NaN

  const flush = (): void => {
    if (current !== '') words.push(current.toLowerCase())
    current = ''
    lastCode = Number.NaN
  }

  for (let i = 0; i < input.length;) {
    const code = input.codePointAt(i)!
    // 🔴 码位 > 0xffff 时占**两个** UTF-16 单元，游标必须按这个长度走，
    // 否则下一趟会从低代理项的中间起步，把那个字切成两个「非字母」的分隔符
    const len = code > 0xffff ? 2 : 1

    if (!isWordCode(code)) {
      flush()
      i += len
      continue
    }
    if (current === '') {
      current = String.fromCodePoint(code)
      lastCode = code
      i += len
      continue
    }

    const next = i + len < input.length ? input.codePointAt(i + len)! : Number.NaN

    const lowerToUpper = (isLower(lastCode) || isDigit(lastCode)) && isUpper(code)
    const acronymEnd = isUpper(lastCode) && isUpper(code) && isLower(next)
    const asciiEdge = isAsciiAlnum(lastCode) !== isAsciiAlnum(code)

    if (lowerToUpper || acronymEnd || asciiEdge) flush()
    current += String.fromCodePoint(code)
    lastCode = code
    i += len
  }

  flush()
  return words
}

/** 首字母大写。⚠️ 非 ASCII 的词（`用户`）走 `toUpperCase` 是原样，那正是想要的 */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * 把词拼成某一种风格。
 *
 * ⚠️ 词是**已经小写归一**的（`splitWords` 的契约），所以这里只管大小写的**形状**，
 * 不必再判一次「原本是不是全大写」
 *
 * 🔴 **没有 `default` 那一支**：`NamingStyle` 是六个字面量的联合，六支写全之后
 * TS 自己知道这个 `switch` 是穷尽的（末尾不写 `return` 也不报「可能返回 undefined」）。
 * 加一支「万一不认识就抛」是给一个类型上到不了的情况写代码，
 * 而它会变成一份永远跑不到的分支——⛔ 与 `codec.ts` / `time.ts` 同一条口径
 */
export function renderStyle(words: readonly string[], style: NamingStyle): string {
  if (words.length === 0) return ''
  switch (style) {
    case 'camel':
      return words[0]! + words.slice(1).map(capitalize).join('')
    case 'pascal':
      return words.map(capitalize).join('')
    case 'snake':
      return words.join('_')
    case 'constant':
      return words.join('_').toUpperCase()
    case 'kebab':
      return words.join('-')
    case 'dot':
      return words.join('.')
  }
}

/**
 * 出六行对照表。
 *
 * 🔴 **空输入返回 `ok` + 空串**，与 `runJson` / `regexReport` 同一条理由：
 * 工具箱是「改一个字就重跑一次」的，打开这一个工具的那一瞬间输入格是空的，
 * 那时候给六行空的 `小驼峰（camelCase）：` 是六行噪音。返回空串之后输出格显示的是
 * `OUTPUT_PLACEHOLDER`，那正是「还没东西可跑」该有的样子
 *
 * ⚠️ **「有输入但切不出词」是另一种情况，要说一句**：`___`、`---`、`...` 都不是空的，
 * 静默返回空串的话输出格显示的还是占位文字，读起来像是没跑。于是它给一句人话。
 * 🔴 而它是 `ok` 而不是 `error`：那一串不是**写错了**，只是里面没有可转换的东西
 *
 * ⚠️ 没有 `at`：这一个工具压根不报位置，而 `at` 的坐标系是输入格
 */
export function namingReport(input: string): ToolResult {
  if (input.trim() === '') return { kind: 'ok', text: '' }

  const words = splitWords(input)
  if (words.length === 0) return { kind: 'ok', text: '这一串里没有字母或数字，没有可转换的词' }

  return {
    kind: 'ok',
    text: NAMING_STYLES.map((style) => `${STYLE_LABELS[style]}：${renderStyle(words, style)}`).join('\n'),
  }
}
