/**
 * 命令面板（`Mod+Shift+P`）的状态机，与它上面那两个纯函数。
 *
 * 分工与 `src/goto/store.ts`、`src/tools/store.ts` 一致：**逻辑住在这里、组件只管画**。
 * 这一层不含 DOM，于是「模糊匹配到底匹不匹得上」「置灰的命令排在哪儿」「翻页翻多少」
 * 都能在 node 环境里被穷举。
 *
 * ## 🔴 这一层补上的是 PLAN 第 77 行那笔 P0 欠账
 *
 * 命令面板从一开始就在核心功能清单里，而 M1-A 只交了「命令面板的数据源」
 * （`registry.list()`）——数据源没有入口，等于没有面板。补上之后，注册表里的每一条
 * 第一次能被看见、被搜到，并且每一行顺带显示它绑在哪个键上。
 * ⚠️ 别把这笔账记成「二十几条命令够不着」：量下来没绑键的只有 7 条，而那几条各有别的入口。
 * 真正的价值是**发现性**：一个只在代码里的注册表，用户不可能猜出它有什么。
 *
 * ## ⚠️ `context` 必须是响应式的
 *
 * `App.tsx` 里那条 TODO 说的正是这件事：`registry` 的 `getContext` 是**被调用时求值**的，
 * 命令的 `when` 在 `execute` 那一刻读一次就够；而面板里的置灰状态要跟着焦点走，
 * 所以这一层把「求值」换成「订阅」——`rows` 是个 memo，它在追踪范围里读 `context()`，
 * 于是 `ws.focusedEditor()` 一变，`enabled` 就重算。
 *
 * ## ⛔ 不虚拟化
 *
 * 50 条命令 + 6 个工具投影出来的那些，一共六十来行，将来上百。
 * `src/ui/virtual.ts` 那套是为「十万个文件」写的；这里挂上它只会换来一个量不到高度的
 * jsdom（`clientHeight` 恒为 0，组件测试永远只看得见头 6 行），
 * 而收益是「少画九十来个节点」——在一个每按一个键都要重算一次的浮层里也量不出来。
 * 与 `src/tools/ToolBox.tsx` 的左栏同一条判断。
 */

import { createMemo, createSignal } from 'solid-js'
import type { AppContext, CommandInfo, CommandRegistry } from './registry'

/** 面板里的一行。`CommandInfo` 是注册表的口径，这一份是**画出来的**口径 */
export interface PaletteRow {
  readonly id: string
  readonly title: string
  readonly category: string
  /** 已按平台格式化好的快捷键标签。没有绑定时是空串，那一格压根不画 */
  readonly keys: string
  readonly enabled: boolean
}

/**
 * 算一个词的边界。命中在这些字符后面的那一个字母，比命中在词中间的那一个值钱：
 * 打 `tsw` 时「**T**oggle**S**ide**W**rap」该排在「las**tsw**itch」前面
 */
const WORD_BREAKS = new Set([' ', '.', '-', '_', '/', ':', '(', ')', '（', '）', '·'])

/** 一次跳跃最多扣多少分。不封顶的话一条长命令永远匹不过一条短的，而那与「更相关」无关 */
const MAX_GAP_PENALTY = 12

/**
 * 子序列模糊匹配 + 打分。匹不上返回 `null`。
 *
 * 与 Rust 侧 `crates/vela-core/src/project/index.rs` 那一份是**两套代码、同一条思路**：
 * 那边要跑在十万个路径上，所以是字节级的；这边一次只跑六十来条命令名，
 * 于是可以写得直白。⛔ 不要为了「统一」把两边并成一份——它们的成本模型差三个数量级。
 *
 * ⚠️ 用的是**最左贪心**：从左到右为每个查询字符找它在文本里最靠前的那一次出现。
 * 这对「匹不匹得上」是精确的（子序列存在性上最左贪心最优），
 * 而对「打多少分」不是——它可能选到一组更差的匹配位置。
 * 换来的是 O(n·m) 而不是回溯的指数级，对一个每按一个键都要跑六十次的函数，这个交换是划算的
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query === '') return 0
  const hay = text.toLowerCase()
  let score = 0
  let from = 0
  let prev = -1
  for (const ch of query.toLowerCase()) {
    const at = hay.indexOf(ch, from)
    if (at === -1) return null
    if (at === prev + 1) score += 6
    else if (at === 0 || WORD_BREAKS.has(hay.charAt(at - 1))) score += 4
    else score += 1
    // 跳过的那些字符要扣分：`tg` 在 `toggle` 里与在 `tarragou` 里不该同分
    if (prev !== -1) score -= Math.min(at - prev - 1, MAX_GAP_PENALTY)
    prev = at
    from = at + 1
  }
  return score
}

export function rowOf(info: CommandInfo): PaletteRow {
  return {
    id: info.id,
    title: info.title,
    category: info.category,
    keys: info.keybindings.join(' '),
    enabled: info.enabled,
  }
}

/**
 * 按查询词过滤并排序。空查询（或只有空格）时**原样返回**注册表的顺序：
 * 那个顺序是 `category → id`，也就是「同一类命令挨在一起」，比按分数排更好读
 */
export function matchCommands(commands: readonly CommandInfo[], query: string): readonly PaletteRow[] {
  const needle = query.trim()
  if (needle === '') return commands.map(rowOf)
  const scored: { row: PaletteRow; score: number }[] = []
  for (const info of commands) {
    // 三个字段里取最高的那一个分：打「工具」要能捞到所有工具（分类名），
    // 打 `wrap` 要能捞到「切换自动换行」（id 里的 `toggleLineWrap`），
    // 打「换行」要能捞到它的标题
    const score = Math.max(
      fuzzyScore(info.title, needle) ?? Number.NEGATIVE_INFINITY,
      fuzzyScore(info.id, needle) ?? Number.NEGATIVE_INFINITY,
      fuzzyScore(info.category, needle) ?? Number.NEGATIVE_INFINITY,
    )
    if (score === Number.NEGATIVE_INFINITY) continue
    scored.push({ row: rowOf(info), score })
  }
  // 分数降序，同分按标题的**码位**升序。⛔ 不用 `localeCompare`：ICU 与非 ICU 的构建
  // 给的不是同一个顺序，而 CI 跑在 ubuntu 上（与 `commands/registry.ts` 的 `list()` 同一条）
  scored.sort((a, b) => b.score - a.score || (a.row.title < b.row.title ? -1 : a.row.title > b.row.title ? 1 : 0))
  return scored.map((entry) => entry.row)
}

/**
 * 算出移动之后的选中下标。两端都**停住不绕回**（理由与 `goto/store.ts` 的 `moveSelection`
 * 逐字相同：按住 ↓ 一路到底之后突然跳回第一行，是列表里最让人失去方向的一件事）。
 *
 * ⚠️ 收的是「移动几行」而不是按键名：一页是多少行只有**组件**知道（它才量得到可视区高度），
 * 而这一层不碰 DOM。于是 `PageDown` 在 jsdom 里只走一行——那不是 bug，是 jsdom 没有布局
 */
export function moveRow(total: number, selected: number, delta: number): number {
  if (total <= 0) return 0
  const at = Math.min(Math.max(0, selected), total - 1)
  return Math.min(total - 1, Math.max(0, at + delta))
}

export interface CommandPaletteOptions {
  registry: CommandRegistry
  /**
   * 🔴 必须是个**响应式**的访问器，`rows` 那个 memo 才有意义。
   * App 那边传的是 `() => ({ editor: ws.focusedEditor() })`
   */
  context: () => AppContext
}

export interface CommandPalette {
  readonly visible: () => boolean
  /** 每加一就 focus 一次。用计数不用布尔，理由与 `goto/store.ts` 的 `focusRequest` 逐字相同 */
  readonly focusRequest: () => number
  readonly query: () => string
  setQuery: (value: string) => void
  readonly rows: () => readonly PaletteRow[]
  /** 命令总数（不受查询词影响），页脚那句「N / 共 M 条」用它 */
  readonly total: () => number
  readonly selected: () => number
  select: (index: number) => void
  moveBy: (delta: number) => void
  /** 执行选中那一条并收起。选中行被置灰时照样执行——`registry.execute` 会返回 false */
  commit: () => void
  readonly footer: () => string
  show: () => void
  hide: () => void
}

export function createCommandPalette(options: CommandPaletteOptions): CommandPalette {
  const registry = options.registry

  const [visible, setVisible] = createSignal(false)
  const [focusRequest, setFocusRequest] = createSignal(0)
  const [query, setQuerySignal] = createSignal('')
  const [selected, setSelected] = createSignal(0)
  const [generation, setGeneration] = createSignal(0)

  /**
   * ⚠️ 这里读的是 `options.context()`，而它是 App 传进来的 `() => ({ editor: ws.focusedEditor() })`。
   * 于是在 memo 的追踪范围里读它，就等于订阅了「哪一块分屏正被聚焦」。
   *
   * 🔴 `generation()` 那一句是**必需的，不是装饰**。`registry.list()` 不是响应式的，
   * 而 `createMemo` 是**急切求值**的——`createCommandPalette` 返回之前它就已经跑过一遍了。
   * App 在组件体里建面板、在 `onMount` 里才注册那四十来条内置命令，所以少了这一格，
   * 面板记住的就是「建它那一刻」的清单（只有工具投影出来的那几条），而且永远不会自己更新。
   *
   * ⚠️ 抬格放在 `show()` 而不是注册表的 `register()` 里：注册表压根没有「命令变了」这个通知，
   * 而面板是**开门那一刻**才需要清单的。这一格同时也把 M5 那笔账还了——插件在运行中增减命令，
   * 下一次 `Mod+Shift+P` 就看得见
   */
  const all = createMemo(() => {
    generation()
    return registry.list(options.context())
  })
  const rows = createMemo(() => matchCommands(all(), query()))

  const footer = createMemo(() => {
    const count = rows().length
    const needle = query().trim()
    if (needle === '') return `共 ${count} 条命令`
    if (count === 0) return `没有匹配「${needle}」的命令`
    return `${count} / 共 ${all().length} 条命令`
  })

  return {
    visible,
    focusRequest,
    query,
    setQuery(value) {
      setQuerySignal(value)
      // ⛔ 不保持下标：`rows` 被换掉之后同一个下标指的是另一条命令，
      // 那时按 Enter 执行的是「排在第 4 位的那条」，而不是用户看着的那一条
      setSelected(0)
    },
    rows,
    total: () => all().length,
    selected,
    select: (index) => setSelected(index),
    moveBy: (delta) => setSelected((at) => moveRow(rows().length, at, delta)),
    commit() {
      const row = rows()[selected()]
      // 先收起再执行：被执行的命令可能自己展开一块浮层（`gotoFile` 就是），
      // 顺序反过来的话那一下会被这次收起盖掉
      setVisible(false)
      if (row === undefined) return
      void registry.execute(row.id)
    },
    footer,
    show() {
      setVisible(true)
      setFocusRequest((n) => n + 1)
      // 🔴 先抬一格再清查询词：两件事都会让 `rows` 重算，而抬格那一次要读到的是
      // **这一刻**的注册表（见上面 `all` 那段注释）
      setGeneration((n) => n + 1)
      // 每次都清空：面板是「按一下、打几个字、Enter、消失」的东西，
      // 留着上一次的查询词等于每次都要先按三下退格
      setQuerySignal('')
      setSelected(0)
    },
    hide() {
      setVisible(false)
    },
  }
}
