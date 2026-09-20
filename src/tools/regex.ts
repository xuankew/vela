import { describeErrorAt, type LocatedError, type ToolResult } from './tool'

/**
 * 正则测试器的纯活（M3-B-5）。
 *
 * 分工与 `json.ts` / `codec.ts` 一致：**这一份不知道「描述符」是什么**，它只有几个能被
 * 单测直接钉住的纯函数；「模式那一格选了替换结果」这种只有面板才关心的事，翻译工作留在
 * `builtin.ts`。于是算法层收的是已经收窄好的 `mode: 'list' | 'replace'`，⛔ 不是中文串。
 *
 * ## 🔴 实时高亮**没做**（用户拍的板）
 *
 * PLAN 的 P0 表里那一格写的是「实时高亮 + 分组捕获 + 替换预览」，交付的是后两样。
 * 高亮要一份匹配区间清单，而 `ToolResult` 只有 `text` 与 `at`（一个下标），装不下；
 * 装得下它的那个改法是把输出格换成一块只读的 CM6 并给 `ToolResult` 加一个 `ranges` 数组，
 * 那是**所有**工具的公共型与状态机都要跟着动。清单模式里逐处给出的行列与命中片段
 * 是同一个信息的文字版，代价是眼睛得在两个格子之间来回一次。
 *
 * ## 🔴 灾难性回溯会**卡死**这一块浮层，没有超时中断
 *
 * `(a+)+$` 配上一串 `aaaaaaaaaaaaaaaaaaaaaX` 就是经典的那一例。真正的解法是把 `exec`
 * 丢进一个 Worker 并给它一个截止时间——那是一份真机器：一个 worker 分包、一层异步管道、
 * 以及在「每打一个字就重跑一次」的防抖底下把在飞的那一次取消掉。
 * ⚠️ `ToolDefinition.run` 本来就允许返回 Promise（`store.ts` 一律包一层 `Promise.resolve`），
 * 所以那条路**没有被关闭**，只是 v1 不走。输入长度的上限是 `store.ts` 的 `MAX_TOOL_CHARS`，
 * 它拦的是「输入太大」，⛔ 拦不住「模式太坏」。
 *
 * ## ⛔ 模式或标志写错时**不带** `at`
 *
 * `ToolResult.at` 的坐标系是**输入格**里的 UTF-16 下标，而正则本身住在选项条的一格里。
 * 把一个「模式里的下标」填进 `at`，「跳到第一处」就会去选输入格里同样下标的那一行——
 * 一个指错地方的跳转按钮比没有这个按钮更坏。位置信息改成把示意图画在**模式串自己身上**
 * （`describeErrorAt(pattern, …)`），于是那一行 ASCII 与用户格子里的字逐字对得上。
 */

/**
 * 匹配清单最多列多少处。
 *
 * ⚠️ 只限**清单**，⛔ 不限替换：`replaceWith` 会走完整份输入，
 * 因为「替换结果」那一格的输出是要能原样插回编辑器的，截断它等于交出一份坏文件。
 * 于是这一个数影响的是「看得见多少」，不是「改得对不对」
 */
export const MAX_REGEX_HITS = 200

/** 命中片段最多显示多少个码元。一个 `[\s\S]{5000}` 的匹配整段倒进输出格没有意义 */
const SNIPPET_CHARS = 80

/**
 * 「标志」那一格认的字符。
 *
 * ⚠️ **不含 `y`**：黏性要求匹配必须从 `lastIndex` 上开始，而「列出全部匹配」是一路往后走的，
 * 两者互斥——带上它的话第一处之后就再也不会有匹配，而那是个安静地什么都不报的结果。
 * ⛔ 也不含 `d`（`hasIndices`）与 `v`（`unicodeSets`）：这一份压根不读它们给的东西，
 * 收下来就是一个「点了没反应」的选项，正是这个代码库一路在躲的那种失败
 *
 * 🔴 `g` 在这一份里，因为用户可以打它（不该报「不认识」）；而 `normalizeFlags` 无论如何
 * 都会补上它，因为「列出全部」与「替换全部」这两件事都要求它是全局的
 */
const FLAG_CHARS = 'gimsu'

/** 报错那句话里列出来的合法标志。从 `FLAG_CHARS` 派生，⛔ 不另写一份（两份会对不上） */
const FLAG_HINT = [...FLAG_CHARS].join(' ')

/** 编译成功了：正则 + 归一化之后**真的**用在 `new RegExp` 上的那一串标志 */
export interface RegexCompiled {
  readonly ok: true
  readonly re: RegExp
  readonly flags: string
}

/** 编译失败了：`error` 已经是**画好给人看的**那几行，不是引擎那句原话 */
export interface RegexRejected {
  readonly ok: false
  readonly error: string
}

export type RegexCompile = RegexCompiled | RegexRejected

/**
 * 标志那一格里的第一个问题。返回 `null` = 没有。
 *
 * ⚠️ 下标是**原串**里的，不是 trim 之后的：报错要用 `describeErrorAt` 把那一行画出来，
 * 而用户格子里躺着的是原串。于是空白字符是**跳过**而不是**剪掉**的——剪掉的话
 * 后面每个下标都要加上「剪掉了几个」才能对回去，而跳过不需要
 *
 * ⚠️ 空白允许出现在任何位置（`i m` 与 `im` 一样），因为那一格是手打的，
 * 而「打了个空格」不该是一次报错
 */
export function scanFlags(raw: string): LocatedError | null {
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (char === ' ' || char === '\t') continue
    if (char === 'y') {
      return { offset: i, expected: '黏性标志 `y` 与「列出全部匹配」互斥（它会让匹配停在第一处之后）' }
    }
    if (!FLAG_CHARS.includes(char)) {
      return { offset: i, expected: `不认识的正则标志（这一格只认 ${FLAG_HINT}）` }
    }
  }
  return null
}

/**
 * 归一化标志：去重、去空白、并且**一定**带上 `g`。
 *
 * 🔴 顺序是「用户打的顺序 + `g` 兜在最后」，⛔ 不是排序：报告里那一句 `正则：/…/gi`
 * 要能与他格子里打的字对上，而排了序之后 `mi` 会变成 `im`，读起来像是工具改了他的东西
 */
export function normalizeFlags(raw: string): string {
  const seen: string[] = []
  for (const char of raw) {
    if (char === ' ' || char === '\t') continue
    if (!seen.includes(char)) seen.push(char)
  }
  if (!seen.includes('g')) seen.push('g')
  return seen.join('')
}

/**
 * 编译。失败时 `error` 里已经带着示意图，调用方**原样交出去**就行。
 *
 * 🔴 扫描器只在 `new RegExp` **抛了之后**才跑，与 `json.ts` / `codec.ts` 同一条纪律：
 * 引擎是权威，扫描器只是「引擎那句话没有位置，所以自己找一个」。
 * 反过来（先扫再编译）的话扫描器就成了权威，而它对 `{2,1}`、`(?=a)*` 这一类
 * 压根不置一词——那些时候如实把引擎的原话交出去才是对的
 */
export function compileRegex(pattern: string, rawFlags: string): RegexCompile {
  const flagProblem = scanFlags(rawFlags)
  if (flagProblem !== null) {
    return { ok: false, error: describeErrorAt(rawFlags, flagProblem.offset, flagProblem.expected) }
  }
  const flags = normalizeFlags(rawFlags)
  try {
    return { ok: true, re: new RegExp(pattern, flags), flags }
  } catch (err) {
    const found = scanPattern(pattern)
    // 扫描器说没错、引擎说有问题：如实把引擎那句原话交出去，⛔ 不编一个位置
    if (found === null) return { ok: false, error: err instanceof Error ? err.message : String(err) }
    return { ok: false, error: describeErrorAt(pattern, found.offset, found.expected) }
  }
}

/**
 * 模式串上的扫描器：给 `new RegExp` 抛出来的那句**没有位置**的话补一个位置。
 *
 * 🔴 是**迭代**的（一个显式的 `stack: number[]`），与 `scanJson` 同一条理由：
 * `('(.')repeat(20000)` 这种输入不该把栈掀了。
 *
 * ⚠️ 只查五件事：落单的 `\`、没配对的 `(`、没配对的 `)`、没结束的 `[`、以及
 * 「量词前面没有东西」。其余的一律返回 `null` 让引擎的原话过去——
 * **少报**是安全的（用户还能读到引擎那句），**报错**才是不安全的
 * （指着第 3 列说不对，而问题在第 30 列）
 */
export function scanPattern(pattern: string): LocatedError | null {
  /**
   * 上一个东西能不能被量词修饰。`a**` 与 `(*` 都是「Nothing to repeat」，而两者靠的是这一个状态。
   * 🔴 `quantified` 单列一档是为了惰性量词：`a+?` 与 `a??` 合法，而 `a+*` 与 `a???` 不是。
   * 于是 `*` / `+` 只认 `atom`，`?` 认 `atom` 与 `quantified`——挂在 `quantified` 上那一个
   * 是**惰性修饰**，用完就把状态推到 `open`（等价于「这儿不能再挂东西了」）
   */
  let prev: 'start' | 'open' | 'alt' | 'atom' | 'quantified' = 'start'
  const stack: number[] = []
  let inClass = false
  let classStart = 0

  for (let i = 0; i < pattern.length;) {
    const char = pattern[i]!
    if (char === '\\') {
      if (i + 1 >= pattern.length) return { offset: i, expected: '这个反斜杠后面该有一个字符' }
      i += 2
      prev = 'atom'
      continue
    }
    if (inClass) {
      if (char === ']') {
        inClass = false
        prev = 'atom'
      }
      i++
      continue
    }
    if (char === '[') {
      inClass = true
      classStart = i
      prev = 'atom'
      i++
      continue
    }
    if (char === '(') {
      stack.push(i)
      // 🔴 `(?:` `(?=` `(?<name>` 里那个 `?` 是**分组的一部分**，不是量词。
      // 不当特殊处理的话 `(?:a)` 会被报成「这个量词前面没有可以重复的东西」——
      // 一个指着完全合法的模式说不对的扫描器，比一个什么都不报的更坏
      i += pattern[i + 1] === '?' ? 2 : 1
      prev = 'open'
      continue
    }
    if (char === ')') {
      if (stack.length === 0) return { offset: i, expected: '这个右括号没有配对的左括号' }
      stack.pop()
      prev = 'atom'
      i++
      continue
    }
    if (char === '|') {
      prev = 'alt'
      i++
      continue
    }
    if (char === '?') {
      if (prev !== 'atom' && prev !== 'quantified') {
        return { offset: i, expected: '这个量词前面没有可以重复的东西' }
      }
      // 🔴 `a?` 之后还允许**一个**惰性 `?`（`a??` 是合法的），而 `a??` 之后什么都不允许。
      // 于是这一支落在 `quantified` 上、下一支落在 `open` 上，两者相差的就是「还能不能再挂一个」
      prev = prev === 'quantified' ? 'open' : 'quantified'
      i++
      continue
    }
    if (char === '*' || char === '+') {
      if (prev !== 'atom') return { offset: i, expected: '这个量词前面没有可以重复的东西' }
      prev = 'quantified'
      i++
      continue
    }
    prev = 'atom'
    i++
  }

  if (inClass) return { offset: classStart, expected: '这个字符类没有结束的 `]`' }
  // 报**最里面**那一个：`(a(b` 少的那个 `)` 通常是最后打的那个
  const unclosed = stack[stack.length - 1]
  if (unclosed !== undefined) return { offset: unclosed, expected: '这个左括号没有配对的右括号' }
  return null
}

/** 一处匹配。「行列」是给人读的，`index` 是给「跳到第一处」用的 */
export interface RegexHit {
  readonly index: number
  readonly text: string
  readonly groups: readonly (string | undefined)[]
  readonly named: Readonly<Record<string, string | undefined>> | undefined
  readonly line: number
  readonly column: number
}

/**
 * 「扫到哪儿了」的行游标。
 *
 * 🔴 这是本仓库里**第三份**行列实现（另外两份是 `tool.ts` 的 `lineBoundsAt` 与 `locate`），
 * 而那两份都用不了：`locate` 每次都从 0 数一遍 `\n`，于是「200 处匹配 × 一份一百万字的输入」
 * 是 2×10⁸ 次 `charCodeAt`。这一份带着游标**只往前走**，整份输入一共扫一遍。
 * ⚠️ 前提是调用方按**递增**的下标来问——`exec` 天然就是这个顺序
 */
interface LineCursor {
  lineStart: number
  line: number
}

function locateWith(text: string, cursor: LineCursor, offset: number): { line: number; column: number } {
  for (;;) {
    const newline = text.indexOf('\n', cursor.lineStart)
    if (newline === -1 || newline >= offset) break
    cursor.lineStart = newline + 1
    cursor.line++
  }
  return { line: cursor.line, column: offset - cursor.lineStart + 1 }
}

export interface MatchList {
  readonly hits: readonly RegexHit[]
  /**
   * 撞上 `MAX_REGEX_HITS` 了，后面还有。
   * ⚠️ **不给总数**：数完它就要把整份输入再走一遍，而那一遍可能正是会卡死的那一遍
   */
  readonly more: boolean
}

/**
 * 列出匹配。`re` 必须带 `g`（`compileRegex` 保证），`lastIndex` 由这一份自己归零——
 * ⛔ 不假设调用方给的是一个干净的 `RegExp`，因为同一个 `re` 会被同一个 store 反复用
 */
export function collectMatches(re: RegExp, text: string): MatchList {
  const hits: RegexHit[] = []
  const cursor: LineCursor = { lineStart: 0, line: 1 }
  let more = false
  re.lastIndex = 0
  for (;;) {
    const match = re.exec(text)
    if (match === null) break
    if (hits.length >= MAX_REGEX_HITS) {
      more = true
      break
    }
    const at = locateWith(text, cursor, match.index)
    hits.push({
      index: match.index,
      text: match[0],
      groups: match.slice(1),
      named: match.groups,
      line: at.line,
      column: at.column,
    })
    // 🔴 零长匹配必须自己往前挪一格：`x*` 在 `abc` 上每处都匹配一个空串，
    // 而 `lastIndex` 不动的话 `exec` 每次都返回同一个匹配，这是一个转不出来的循环
    if (match.index === re.lastIndex) re.lastIndex++
  }
  return { hits, more }
}

/** `expandReplacement` 需要的那一份上下文：`$&` `$`` `$'` `$n` `$<name>` 全靠它 */
export interface ReplacementContext {
  /** 这一处匹配到的原文（`$&`） */
  readonly match: string
  readonly groups: readonly (string | undefined)[]
  readonly named: Readonly<Record<string, string | undefined>> | undefined
  readonly offset: number
  /** 整份被替换的输入（`` $` `` 与 `$'` 要它） */
  readonly text: string
}

/**
 * 把替换模板里的 `$…` 展开一次。**与 `String.prototype.replace` 的字符串模板同口径。**
 *
 * 🔴 既然同口径，为什么不直接调 `text.replace(re, template)`？因为那样就数不出**替换了几处**，
 * 而「替换了 3 处」是替换预览里最有用的一句话。走自己的循环，两处都拿到。
 * ⚠️ 代价是这一份必须**逐条对上**引擎的行为，于是 `regex.test.ts` 里有一张差分表：
 * 同一组（输入 / 模式 / 模板）既跑这一份、也跑原生的 `replace`，两边必须逐字相等。
 * 那张表是这一份唯一的凭据——它写的时候参照的是规范里的 `GetSubstitution`，
 * 而规范这种东西记不准，⛔ 不能靠记忆
 *
 * ⚠️ 认的是 `$$` `$&` `` $` `` `$'` `$n` `$nn` `$<name>`，其余的 `$` 一律原样输出。
 * 🔴 `$0` **不是**「整个匹配」，它就是一个字面上的 `$0`（规范里 `$n` 的 n 必须非零）；
 * 而 `$12` 在有 12 个分组时是第 12 组、只有 3 个分组时是「第 1 组 + 字面 2」
 */
export function expandReplacement(template: string, ctx: ReplacementContext): string {
  let out = ''
  for (let i = 0; i < template.length;) {
    const char = template[i]!
    if (char !== '$') {
      out += char
      i++
      continue
    }
    const next = template[i + 1]
    if (next === undefined) {
      // 末尾一个落单的 `$`：原样输出（规范也是这么说的）
      out += '$'
      i++
      continue
    }
    if (next === '$' || next === '&') {
      out += next === '$' ? '$' : ctx.match
      i += 2
      continue
    }
    if (next === '`' || next === "'") {
      out += next === '`' ? ctx.text.slice(0, ctx.offset) : ctx.text.slice(ctx.offset + ctx.match.length)
      i += 2
      continue
    }
    if (next === '<') {
      const close = template.indexOf('>', i + 2)
      /**
       * 🔴 两条都是**实测**出来的，⛔ 不是从规范推的：
       * ① 没有 `>` → 那个 `$` 原样输出，后面那些字符留给下一轮；
       * ② `ctx.named` 是 `undefined`（这个正则压根没有具名分组）→ `$<` 也是**字面的 `$`**，
       *    于是 `$<x>` 整串原样留在输出里；
       * ③ 有具名分组、只是名字对不上 → 展开成**空串**，⛔ 不是原样吐出来。
       *
       * ⚠️ ② 与 ③ 的区别看着没道理，而它正是 `String.prototype.replace` 的行为，差分表钉住了。
       * ② 对用户其实更友好：`$<x>` 留在输出里能看见「它没生效」，而悄悄变成空串看不出来
       *
       * ⚠️ 差分表只能在 **V8** 上跑（vitest = Node），而真机是 **JavaScriptCore**。
       * 这一格进了真机待验清单——它与 M3-B-2 那条「JSC 的 `JSON.parse` 不给位置」是同一类风险
       */
      if (close === -1 || ctx.named === undefined) {
        out += '$'
        i++
        continue
      }
      const value = ctx.named[template.slice(i + 2, close)]
      if (value === undefined) {
        i = close + 1
        continue
      }
      out += value
      i = close + 1
      continue
    }
    if (next < '1' || next > '9') {
      // `$0`、`$x`、`$-` ……：`$` 原样输出，后面那个字符留给下一轮
      out += '$'
      i++
      continue
    }
    const one = Number(next)
    if (one > ctx.groups.length) {
      out += '$'
      i++
      continue
    }
    const after = template[i + 2]
    if (after !== undefined && after >= '0' && after <= '9' && one * 10 + Number(after) <= ctx.groups.length) {
      out += ctx.groups[one * 10 + Number(after) - 1] ?? ''
      i += 3
      continue
    }
    // 未参与的分组是 `undefined`，原生输出一个空串——跟着它
    out += ctx.groups[one - 1] ?? ''
    i += 2
  }
  return out
}

export interface ReplaceOutcome {
  readonly text: string
  readonly count: number
}

/** 全量替换。**不受 `MAX_REGEX_HITS` 限制**，理由写在那一个常量的文档上 */
export function replaceWith(re: RegExp, text: string, template: string): ReplaceOutcome {
  const parts: string[] = []
  let last = 0
  let count = 0
  re.lastIndex = 0
  for (;;) {
    const match = re.exec(text)
    if (match === null) break
    parts.push(text.slice(last, match.index))
    parts.push(
      expandReplacement(template, {
        match: match[0],
        groups: match.slice(1),
        named: match.groups,
        offset: match.index,
        text,
      }),
    )
    // 零长匹配时 `last` 不动，于是下一轮 `slice(last, index)` 会把中间那一个字符带上——
    // 这正是原生的行为（`'abc'.replace(/x*/g, '-')` 是 `-a-b-c-`）
    last = match.index + match[0].length
    count++
    if (match.index === re.lastIndex) re.lastIndex++
  }
  parts.push(text.slice(last))
  return { text: parts.join(''), count }
}

/** 面板那一个「输出」下拉的两档。⚠️ 中文候选值住在 `builtin.ts`，这一层只认这两个词 */
export type RegexMode = 'list' | 'replace'

/** 把命中片段压成一行：截断 + 把换行与制表符画成转义，⛔ 不原样倒进去 */
function showPiece(text: string): string {
  const piece = text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text
  return `「${piece.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}」`
}

/**
 * 出一份报告。
 *
 * 🔴 **空模式返回 `ok` + 空串**，与 `runJson` 的空输入同一条理由：这一格是
 * 「改一个字就重跑一次」的，打开工具那一瞬间它是空的，而空模式**匹配每一处**
 * （零长），于是那一下会列出 200 处空匹配。返回空串之后输出格显示的是
 * `OUTPUT_PLACEHOLDER`，那正是「还没东西可跑」该有的样子
 *
 * 🔴 `replace` 那一档的输出是**纯的**：整份就是替换之后的文字，⛔ 不带任何抬头。
 * 因为「插回编辑器」是把输出格里的文字原样写进文档，加一句「替换了 3 处」
 * 就等于让用户自己再删一行。想知道替换了几处，去看默认的「匹配清单」那一档
 *
 * ⚠️ `list` 那一档反过来是**报告**（与 `time.ts` 同一种），所以它的输出插回编辑器
 * 是没意义的——那一档给的是行列、命中片段与各分组，而跳转靠的是返回的那个 `at`
 */
export function regexReport(
  input: string,
  pattern: string,
  rawFlags: string,
  template: string,
  mode: RegexMode,
): ToolResult {
  if (pattern === '') return { kind: 'ok', text: '' }

  const compiled = compileRegex(pattern, rawFlags)
  if (!compiled.ok) return { kind: 'error', text: compiled.error }
  const { re, flags } = compiled

  if (mode === 'replace') return { kind: 'ok', text: replaceWith(re, input, template).text }

  const { hits, more } = collectMatches(re, input)
  const header = `正则：/${pattern}/${flags}`
  if (hits.length === 0) return { kind: 'ok', text: `没有匹配\n${header}` }

  /**
   * 🔴 被截断的那一份写「以上」，⛔ 不写 `匹配 200 处`：`hits.length` 是**列出来的**条数，
   * 而「匹配 N 处」读起来是总数。一份写着 200、实际上是 5000 的报告，
   * 用户会拿那个数去判断「这个正则在这份文件里常不常见」——那是一次安静的误导。
   *
   * ⚠️ 末尾那一句「只列出前 200 处」还留着：它在 200 条之后，正是读者停下来的地方，
   * 而抬头那一句已经被滚出屏幕了
   */
  const lines: string[] = [more ? `匹配 ${hits.length} 处以上` : `匹配 ${hits.length} 处`, header]
  hits.forEach((hit, i) => {
    lines.push(`#${i + 1}  第 ${hit.line} 行第 ${hit.column} 列 · 下标 ${hit.index}`)
    lines.push(`  命中：${showPiece(hit.text)}`)
    hit.groups.forEach((group, n) => {
      lines.push(`  $${n + 1}：${group === undefined ? '（未参与）' : showPiece(group)}`)
    })
    for (const [name, value] of Object.entries(hit.named ?? {})) {
      lines.push(`  $<${name}>：${value === undefined ? '（未参与）' : showPiece(value)}`)
    }
  })
  // ⚠️ 具名分组会**同时**出现在上面 `$n` 那一份里（它们在 `groups` 里也占一个位置）。
  // 这不是重复计算的 bug，是同一个分组的两种叫法；要把两者合并就得从模式串里
  // 反推「第几个分组叫什么名字」，那是第二个扫描器
  if (more) lines.push(`…只列出前 ${MAX_REGEX_HITS} 处，后面还有更多`)

  return { kind: 'ok', text: lines.join('\n'), at: hits[0]!.index }
}
