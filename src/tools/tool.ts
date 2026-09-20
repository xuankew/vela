/**
 * 内置工具的**描述符**与它上面那几个纯函数（M3-B-1，PLAN §1.5「架构杠杆点」）。
 *
 * 这一层的存在理由是那句「新增一个工具的边际成本 ≈ 写一个纯函数」：`run` 是纯函数，
 * 而**其余部分全是数据**。数据能被检查，于是「缩进的默认值不在候选里」这种错在
 * `installTools` 那一刻就炸出来，而不是等到用户点开工具看见一个空的选项条。
 *
 * ## ⛔ 这里不认识 Solid、不认识 DOM、也不认识命令注册表
 *
 * 描述符是**被两方消费**的：`tools/store.ts` 拿它决定画什么、怎么跑，
 * `tools/registry.ts` 拿它投影出一条命令。让 `tool.ts` 反过来 import 任何一方，
 * 都会把「一个工具是什么」与「它此刻怎么显示」缠在一起——而那正是 M3-B 要拆开的东西。
 *
 * ## ⚠️ `category` 是联合类型，而 `CommandDefinition.category` 是普通 `string`
 *
 * 两边**刻意不一样**。工具的六个分类是**封闭**的：左栏要按它们分组并给出中文标题，
 * 多出一个没人认识的分类就会在左栏凭空多出一个空组。而命令的分类是**开放**的
 * （M2-E 加「跳转」时一个字节的类型声明都没改，见 §3.4「M2-E 实施修正」7）。
 * 工具投影成命令时分类**换成** `'工具'`，不是把 `format` 直接塞过去：命令面板里
 * 挨着「文件」「编辑器」出现六个英文小写分类名，读起来像是没写完。
 */

/** 六个分类，顺序就是工具箱左栏从上到下的顺序 */
export const CATEGORY_ORDER = ['format', 'encode', 'generate', 'convert', 'test', 'text'] as const

export type ToolCategory = (typeof CATEGORY_ORDER)[number]

/** 左栏的组标题。⛔ 不要在组件里现拼中文：分类与标题的对应关系只有一个真相 */
export const CATEGORY_LABELS: Readonly<Record<ToolCategory, string>> = {
  format: '格式化',
  encode: '编解码',
  generate: '生成器',
  convert: '转换',
  test: '测试器',
  text: '文本',
}

/**
 * 一行文字。DOM 那一边是 `<input type="text">`，值是字符串。
 *
 * 🔴 **与 `select` / `number` 不同，这一格用 `input` 事件而不是 `change`**：
 * 「改一个字就重跑一次」是整个工具箱的手感，而 `<input type="text">` 的 `change`
 * **要等到失焦**才发——用 `change` 的话用户打完一个正则得先点一下别处才看得见结果。
 * 见 `ToolBox.tsx` 的 `commitInput`（那里还写着为什么只在**被拒绝**时才写回 `el.value`）
 *
 * ⚠️ M3-B-5 的正则测试器是第一个用它的（「正则」「替换成」两格）。它**不收多行**：
 * 要一段多行文字，那正是输入格（`ToolInput`）的活，⛔ 不要在这一格里塞 textarea
 */
export interface TextOption {
  readonly kind: 'text'
  readonly key: string
  readonly label: string
  readonly default: string
}

/** 一个开关。DOM 那一边是 checkbox，值是 boolean */
export interface ToggleOption {
  readonly kind: 'toggle'
  readonly key: string
  readonly label: string
  readonly default: boolean
}

/**
 * 一组互斥的候选。DOM 那一边是 `<select>`，值是字符串。
 *
 * ⚠️ 候选值就是**显示文字**，没有另配一份 label：JSON 的缩进要显示的是 `2` `4` `Tab`，
 * 而 `run` 拿到的也正是这三个字符串之一——由工具自己解释。多一层「值 → 文字」的映射
 * 只会让「选项条上写着 A、`run` 收到 B」这种错有地方藏
 */
export interface SelectOption {
  readonly kind: 'select'
  readonly key: string
  readonly label: string
  readonly choices: readonly string[]
  readonly default: string
}

/**
 * 一个整数。DOM 那一边是 `<input type="number">`，值是字符串，这一层负责收窄。
 *
 * 🔴 **只收整数**，所以没有 `step`（`<input type="number">` 缺省就是 1）。
 * M3-B 那六个工具里唯一的数字选项是「UUID 生成几个」，而「生成 2.5 个」不是一个
 * 需要支持的语义。哪天真的要小数，那时候再加 `step`，⛔ 不要现在留一个没人用的字段
 */
export interface NumberOption {
  readonly kind: 'number'
  readonly key: string
  readonly label: string
  readonly min: number
  readonly max: number
  readonly default: number
}

export type ToolOption = TextOption | ToggleOption | SelectOption | NumberOption

export type ToolOptionValue = boolean | string | number

/** 一次运行的全部选项值。键来自描述符，所以它是**每个工具自己的形状** */
export type ToolOptions = Record<string, ToolOptionValue>

/**
 * 一次运行的结果。
 *
 * 🔴 **正文只有文字**，没有富结构。M3-B 那六个工具的输出都能写成一段文字（正则测试器的
 * 分组捕获与替换预览是一份多行报告），而给这一层加「高亮区间」「匹配列表」这类字段
 * 等于让**通用面板**认识某一个具体工具——那正是它不该认识的东西。
 * 哪天真有一个工具非富输出不可，它该有自己的面板，不是把 `ToolResult` 撑大。
 *
 * ⚠️ 唯一的例外是 `at`，而它是**反着**那个方向的：它不让面板认识 JSON，
 * 它让「哪一处出错了」这件事对**每一个**吃文字的工具都表达得出来
 * （正则的匹配位置、命名转换里那个不合法的字符，都是同一个形状）。
 * 面板拿到它只会做一件事——把输入格的选区挪过去，见 `ToolBox.tsx` 的「跳到出错处」
 */
export interface ToolResult {
  readonly kind: 'ok' | 'error'
  /** `ok` 时是输出正文，`error` 时是一句人话（要说清哪一行哪一列，见 M3-B-2 的要求） */
  readonly text: string
  /**
   * `error` 时可选：**输入串**里出错那处的字符下标（0 起）。
   *
   * ⚠️ 口径是 UTF-16 码元，与 `textarea.selectionStart` 逐字相同——这不是随便挑的，
   * 是这个数唯一的用途决定的。给了它面板才画「跳到出错处」，不给就只有那句话
   */
  readonly at?: number
}

/** 输入从哪来 */
export type ToolInput =
  /** 取当前文档的正文。没有文档时面板会说一句，⛔ 不是静默给一个空串 */
  | 'editor'
  /** 面板自带一个输入格。六个工具全都是这一种 */
  | 'text'
  /** 没有输入（纯生成器）。面板不画输入格 */
  | 'none'

export interface ToolDefinition {
  /**
   * 分层命名，`tool.` 开头：`tool.json.format`。
   *
   * 🔴 它**同时就是命令 id**——工具投影进命令注册表时原样用它（`tools/registry.ts`），
   * 所以它必须过得 `commands/registry.ts` 那条 `ID_RE`。前缀写死成 `tool.` 是为了让
   * 「这是一条工具命令」在命令面板的 id 上一眼可见，也是为了让 `validateTool` 能在
   * 注册之前就拦下 `json.format` 这种漏了前缀的写法
   */
  readonly id: string
  readonly name: string
  readonly category: ToolCategory
  readonly input: ToolInput
  /** 缺省 = 没有选项条 */
  readonly options?: readonly ToolOption[]
  /**
   * 轻计算走前端，重计算（哈希、图片、转码）走 Rust。
   *
   * ⚠️ M3-B 六个全是 `'js'`。这个字段**不是装饰**：它是面板决定「要不要显示忙碌态」
   * 的依据之一，也是将来给 Rust 侧工具加超时与取消时的分派点
   */
  readonly side: 'js' | 'rust'
  /**
   * 跑一次。
   *
   * ⚠️ 允许返回 Promise（Rust 侧工具必然是），所以 `store.ts` 那边**一律按异步处理**
   * 并且带请求序号——同步工具混进异步管线是安全的，反过来不成立
   */
  readonly run: (input: string, options: ToolOptions) => ToolResult | Promise<ToolResult>
}

/** 一个工具在左栏里的样子 */
export interface ToolInfo {
  readonly id: string
  readonly name: string
  readonly category: ToolCategory
}

/** 按分类分好组的左栏。空组**不会出现** */
export interface ToolGroup {
  readonly category: ToolCategory
  readonly label: string
  readonly tools: readonly ToolInfo[]
}

/**
 * 描述符的默认选项值。
 *
 * 每次调用都返回**新对象**：选项值是可变的（用户会改），而六个工具的描述符是模块级常量，
 * 让它们共享一份默认值等于让「上一次改的缩进」泄漏到下一次打开
 */
export function defaultOptions(tool: Pick<ToolDefinition, 'options'>): ToolOptions {
  const out: ToolOptions = {}
  for (const option of tool.options ?? []) out[option.key] = option.default
  return out
}

/**
 * 把 DOM 递过来的原始值收窄成选项值。**不合法就返回 `null`**，调用方保持原值不动。
 *
 * 🔴 返回 `null` 而不是「夹到边界上」：`<input type="number">` 允许用户手打一个 999，
 * 而把它悄悄改成 64 的话，屏幕上那个格子写着 999、`run` 收到的是 64——一个自信地错着的
 * 数字比一个不动的旧值更糟。保持原值 + 面板如实说「超出范围」才是能对上的
 *
 * ⚠️ `boolean` 只被 toggle 接受，`number` 一个都不接受：数字那一格来自 DOM，
 * 拿到的永远是字符串，而 `Number('')` 是 `0`——一个空输入框会变成「生成 0 个 UUID」
 *
 * ⚠️ `text` 那一格**不 trim**：它装的可能是一个正则，而 `\s` 与 ` \s` 是两个东西。
 * 要 trim 的话由工具自己 trim（`regex.ts` 对「标志」那一格就是这么做的），
 * ⛔ 别在这一层悄悄改掉用户打的字
 */
export function coerceOption(option: ToolOption, raw: string | boolean): ToolOptionValue | null {
  switch (option.kind) {
    case 'text':
      return typeof raw === 'string' ? raw : null
    case 'toggle': {
      if (typeof raw === 'boolean') return raw
      if (raw === 'true') return true
      if (raw === 'false') return false
      return null
    }
    case 'select':
      return typeof raw === 'string' && option.choices.includes(raw) ? raw : null
    case 'number': {
      if (typeof raw !== 'string') return null
      const trimmed = raw.trim()
      if (trimmed === '') return null
      const value = Number(trimmed)
      if (!Number.isInteger(value)) return null
      if (value < option.min || value > option.max) return null
      return value
    }
  }
}

const ID_RE = /^tool\.[a-z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)*$/
const KEY_RE = /^[a-z][a-zA-Z0-9]*$/
const CATEGORIES: ReadonlySet<string> = new Set<ToolCategory>(CATEGORY_ORDER)

/**
 * 检查一份描述符。返回**全部**问题而不是第一个：一次只报一条的话，
 * 修完再跑一遍才知道还有没有，而这份检查是启动时跑的，来回一趟就是一整次重启。
 *
 * 返回空数组 = 合法。
 */
export function validateTool(tool: ToolDefinition): readonly string[] {
  const problems: string[] = []
  if (!ID_RE.test(tool.id)) {
    problems.push(`id "${tool.id}" 不合法：必须是 tool. 开头的分层命名，如 tool.json.format`)
  }
  if (tool.name === '') problems.push('name 是空的')
  if (!CATEGORIES.has(tool.category)) problems.push(`category "${String(tool.category)}" 不在六个分类里`)
  if (tool.input !== 'editor' && tool.input !== 'text' && tool.input !== 'none') {
    problems.push(`input "${String(tool.input)}" 不是 editor / text / none 之一`)
  }
  if (tool.side !== 'js' && tool.side !== 'rust') problems.push(`side "${String(tool.side)}" 不是 js / rust`)
  if (typeof tool.run !== 'function') problems.push('run 不是一个函数')

  const seen = new Set<string>()
  for (const option of tool.options ?? []) {
    if (!KEY_RE.test(option.key)) {
      problems.push(`选项 key "${option.key}" 不合法：小写字母开头，只允许字母与数字`)
    }
    if (seen.has(option.key)) problems.push(`选项 key "${option.key}" 重复`)
    seen.add(option.key)
    if (option.label === '') problems.push(`选项 "${option.key}" 的 label 是空的`)
    if (option.kind === 'select') {
      if (option.choices.length === 0) problems.push(`选项 "${option.key}" 一个候选都没有`)
      if (new Set(option.choices).size !== option.choices.length) {
        problems.push(`选项 "${option.key}" 的候选有重复`)
      }
      if (!option.choices.includes(option.default)) {
        problems.push(`选项 "${option.key}" 的默认值 "${option.default}" 不在候选里`)
      }
    }
    if (option.kind === 'number') {
      if (option.min > option.max) problems.push(`选项 "${option.key}" 的 min 大于 max`)
      if (!Number.isInteger(option.default) || option.default < option.min || option.default > option.max) {
        problems.push(`选项 "${option.key}" 的默认值 ${String(option.default)} 不在 ${option.min}…${option.max} 里`)
      }
    }
  }
  return problems
}

/**
 * 把一批工具按分类分组，供左栏画。
 *
 * 组内按 `name` 排序而不是按注册顺序：注册顺序是**代码里 import 的顺序**，
 * 而它随着 M3-B-2…6 一个个落地会变；按名字排的话同一组里的两个工具永远挨着同样的次序，
 * 与谁先写进 `index.ts` 无关。
 *
 * ⚠️ 排序用码位（`<` / `>`）而不是 `localeCompare`：中文在 ICU 下按拼音排，
 * 而没有 ICU 的构建按码位排，同一份代码在两个环境里给出两个顺序。
 * `commands/registry.ts` 的 `list()` 用的是同一条口径。
 * 代价是这一栏**不是拼音序**（「JSON 压缩」排在「JSON 格式化」前面，因为 压 U+538B
 * 在 格 U+683C 前），而六个工具里同组的最多两三个，读起来不像一本字典也够用了
 */
export function groupTools(tools: readonly ToolDefinition[]): readonly ToolGroup[] {
  const groups: ToolGroup[] = []
  for (const category of CATEGORY_ORDER) {
    const members = tools
      .filter((tool) => tool.category === category)
      .map((tool): ToolInfo => ({ id: tool.id, name: tool.name, category: tool.category }))
      .sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1))
    // 空组不画：左栏里一个「转换」标题底下什么都没有，读起来像是没加载完
    if (members.length > 0) groups.push({ category, label: CATEGORY_LABELS[category], tools: members })
  }
  return groups
}

/**
 * 左栏的过滤。
 *
 * 匹配 `name` 与 `id` 两段，大小写不敏感，⛔ **不是模糊匹配**：
 * 工具一共六个，而模糊匹配（`goto/query.ts` 那一套子序列打分）是为「两万个文件名里
 * 找出你想的那一个」设计的。六个条目上它只会带来坏处——子序列命中意味着打三个字母
 * 能捞出五个工具，而用户看不出它们凭什么在列表里。子串匹配的行为是可以预期的：
 * 打进去的那几个字**连在一起**出现在名字或 id 里，它才在
 */
export function filterTools(tools: readonly ToolDefinition[], query: string): readonly ToolDefinition[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return tools
  return tools.filter((tool) => tool.name.toLowerCase().includes(needle) || tool.id.toLowerCase().includes(needle))
}

/** 一整行的范围，`to` 不含换行符 */
export interface LineBounds {
  readonly from: number
  readonly to: number
}

/**
 * `offset` 落在哪一行，那一行的范围是什么。
 *
 * 存在这里的理由是 `ToolResult.at`：工具报一个下标，而**面板**要把输入格的选区挪过去，
 * 挪的单位是「一整行」——只把光标放进去的话用户得自己看清这一行哪里不对，
 * 而选中整行之后那一行在格子里是亮着的。这一层与是哪个工具无关，所以不住在 `json.ts` 里。
 *
 * ⚠️ 收尾那个 `\r` **不算**在这一行里：CRLF 的文档里选中它没有任何看得见的效果，
 * 而它会让「选中的长度」与「这一行有几个字」差一个
 *
 * 🔴 两个方向都是**就近扫**，不是从头数：往前找上一个 `\n` 是 O(列号)，
 * 往后找下一个 `\n` 是 O(这一行剩下的长度)。一行十万个字符的压缩 JSON 上
 * 这个差别是「立刻」与「卡一下」的区别
 */
export function lineBoundsAt(text: string, offset: number): LineBounds {
  const at = Math.min(Math.max(0, offset), text.length)
  let from = 0
  for (let i = at - 1; i >= 0; i--) {
    if (text.charCodeAt(i) === 0x0a) {
      from = i + 1
      break
    }
  }
  let to = text.length
  for (let i = at; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      to = i
      break
    }
  }
  if (to > from && text.charCodeAt(to - 1) === 0x0d) to--
  return { from, to }
}

/** 位置 + 那一行的范围 */
export interface Located {
  readonly line: number
  readonly column: number
  readonly from: number
  readonly to: number
}

/**
 * 下标 → 第几行第几列（都是 1 起），顺带把那一行的范围带出来。
 *
 * ⚠️ `column` 数的是 **UTF-16 码元**，不是「眼睛看见的第几格」：一行里出错处之前
 * 若有汉字，汉字在等宽字体里占两格而只算一个码元，于是那个 `^` 会偏。
 * 偏移量本身是对的（「跳到出错处」用它），偏的只是这一行 ASCII 画的示意图
 */
export function locate(text: string, offset: number): Located {
  const at = Math.min(Math.max(0, offset), text.length)
  const { from, to } = lineBoundsAt(text, at)
  let line = 1
  for (let i = 0; i < from; i++) if (text.charCodeAt(i) === 0x0a) line++
  return { line, column: at - from + 1, from, to }
}

/**
 * 一处可定位的错：下标 + 一句「这里该有什么」。
 *
 * 🔴 这一份型是**扫描器的返回口径**，而 `describeErrorAt` 的两个参数就是它的两个字段——
 * 两者同形不是巧合，是同一件事的两端。JSON 与 Base64 / URL 各有自己的扫描器，
 * 都返回它（M3-B-2 时它还叫 `JsonSyntaxError` 并住在 `json.ts`，第二个扫描器一出现就搬了上来）
 */
export interface LocatedError {
  /** 输入串里的字符下标（0 起，UTF-16 码元）。⚠️ 与 `ToolResult.at` 同口径，因为它就是要填进那里 */
  readonly offset: number
  readonly expected: string
}

/** 出错那一行最多画多少个字符。压缩过的 JSON 一行能有十万个，⛔ 不能整行倒进输出格 */
const SNIPPET_WIDTH = 160
/** 出错处之前留多少个字符当上下文 */
const SNIPPET_BEFORE = 40

/**
 * 把「某个下标 + 一句该有什么」写成三行：一句人话、出错那一行、以及一个指着的 `^`。
 *
 * 🔴 **这一层是所有吃文字的工具共用的**，所以住在描述符这一层而不是某一个工具里
 * （M3-B-2 时它还叫 `describeJsonError` 并住在 `json.ts`，M3-B-3 的 Base64 / URL
 * 要一模一样的三行，于是搬了上来，⛔ 不留 re-export）。
 * 依赖方向因此一直是 `json.ts` / `codec.ts` → `tool.ts`，反过来不行。
 *
 * ⚠️ 那两行 ASCII 示意图是**用两个空格缩进**的：输出格是个 textarea，
 * 没有缩进的话第二三行会与第一行齐平，读起来像是三句独立的话
 */
export function describeErrorAt(text: string, offset: number, expected: string): string {
  const { line, column, from, to } = locate(text, offset)
  const raw = text.slice(from, to)
  const at = Math.min(Math.max(0, offset - from), raw.length)
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const piece = raw.slice(start, start + SNIPPET_WIDTH)
  const ellipsis = start > 0 ? '…' : ''
  const caret = ' '.repeat(at - start + ellipsis.length)
  return `第 ${line} 行第 ${column} 列：${expected}\n  ${ellipsis}${piece}\n  ${caret}^`
}

/**
 * 「下标 `at` 上那个字符」的人话说法：`「*」` / `这个字符（U+00A0）` / `末尾`。
 *
 * 🔴 不可打印的字符报**码位**而不是字形：不换行空格、零宽空格、BOM 都会从网页与
 * 聊天窗口里被复制进来，而在等宽的示意图那一行里它们与真正的空格长得一模一样。
 * 指着一个看不见的东西说「这里不对」，用户只会以为工具坏了。
 *
 * ⚠️ 越界（含 `at === text.length`）统一说「末尾」，⛔ 不说「undefined」——
 * 这一层就是为了让调用方不必自己先判一次 `Number.isNaN(charCodeAt(…))`。
 * 第三个消费者是 `time.ts`（M3-B-4），前两个是 `codec.ts` 的 base64 字母表与 `%XX`
 */
export function describeCharAt(text: string, at: number): string {
  const code = text.charCodeAt(at)
  if (Number.isNaN(code)) return '末尾'
  if (code >= 0x21 && code <= 0x7e) return `「${text[at]}」`
  return `这个字符（U+${code.toString(16).toUpperCase().padStart(4, '0')}）`
}
