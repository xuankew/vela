/**
 * 工具箱的状态机（M3-B-1，PLAN §1.5「配一个通用 `ToolPanel` 组件」）。
 *
 * 与 `src/search/store.ts`、`src/goto/store.ts` 同一套分工：**逻辑住在这里、组件只管画**。
 * 这一层不含 DOM、不含 CodeMirror、不含 Solid 组件，于是「换工具时哪些状态该清、哪些该留」
 * 「异步的 `run` 回来时用户已经换了工具」这两件最容易错的事都能在 node 环境里被单测钉住。
 *
 * ## 一块浮层，两栏
 *
 * 左栏是**目录**（按分类分组 + 一个子串过滤框），右栏是**工作台**（选项条 + 输入格 + 输出格）。
 * 两栏常驻，⛔ 没有「先浏览、再进去」的两屏：那块浮层是居中的一大块，
 * 一屏里同时看得见「还有什么工具」与「这个工具跑出来是什么」，比来回切两屏有用得多。
 *
 * ## 🔴 换工具时**清什么、留什么**
 *
 * 这三条是这一层最容易写反的地方，写反了都不报错：
 *
 * | 状态 | 换工具时 | 为什么 |
 * | --- | --- | --- |
 * | 选项值 | **重置**成新工具的默认值 | 留着的话上一个工具的 `indent: '4'` 会塞进一个没有 `indent` 的工具，`run` 收到一份它没声明过的选项 |
 * | 输出 | **清空** | 留着的话「Base64」那一栏底下显示的是刚才 JSON 格式化的结果，而它长得完全像一份合法输出 |
 * | 输入 | **留着** | 粘一段 JSON、切到「JSON 压缩」、输入还在——这正是切工具的理由。清掉等于每换一个工具都要重新粘一遍 |
 *
 * ⚠️ 「输入留着」有一条例外：新工具是 `input: 'editor'` 而输入格**是空的**，
 * 那就从当前文档预填一次。只在空的时候填，⛔ 不覆盖用户打进去的东西。
 *
 * ## 🔴 `run` 一律按异步处理，而且带请求序号
 *
 * 描述符允许返回 `Promise`（`side: 'rust'` 的工具必然是），所以同步工具也走同一条管线。
 * 序号挡的是「慢的那一次盖掉快的那一次」：改一个字排一次防抖，而 Rust 那一次的返回顺序
 * 与发出顺序无关，不加序号的话用户会看见输出**退回到上一个键的状态**。
 * 与 `goto/store.ts` 那条注释同一个病，同一个药。
 */

import { createMemo, createSignal } from 'solid-js'
import { createDebounced, domTimer, type Timer } from '../ui/timer'
import { installTools, type ToolCatalog, type ToolHost } from './registry'
import type { CommandRegistry } from '../commands/registry'
import {
  coerceOption,
  defaultOptions,
  filterTools,
  groupTools,
  type ToolDefinition,
  type ToolGroup,
  type ToolOptions,
  type ToolResult,
} from './tool'

/**
 * 改一个字之后等多久再跑一次。
 *
 * 与 `md/panel.ts` 的 `PANEL_DEBOUNCE_MS` **同值不同物**：那一个答「重解析一份 Markdown
 * 多贵」，这一个答「跑一次工具多贵」。今天两个都是 150ms，而它们各自该跟着自己的成本走，
 * 所以是两个常量而不是一个（`src/ui/timer.ts` 的 `createDebounced` 因此把延时做成参数）
 */
export const TOOL_DEBOUNCE_MS = 150

/**
 * 输入格最多接多少个字符。
 *
 * 🔴 这不是「反正跑不动」的兜底，而是一条**如实拒绝**：工具跑在 UI 线程上，
 * 一份 50 MB 的文本喂给 `JSON.parse` 会让整个窗口僵住几十秒，而用户看不到任何进度——
 * 那不是慢，是像崩了。所以在跑之前就拦下，并说清上限是多少、现在有多少。
 *
 * ⚠️ 一百万字符 ≈ 一份 1 MB 的 UTF-8 英文文本 / 半个汉字的三百万字节那一边，
 * 对「手粘一段 JSON 进来格式化」这个场景宽得用不完，而对「把整个日志文件拖进来」
 * 又刚好挡住——那种活该走全局搜索（`Cmd+Shift+F`），不是工具
 */
export const MAX_TOOL_CHARS = 1_000_000

/** 左栏的一行：分类标题，或者一个工具 */
export type ToolRow =
  | { readonly kind: 'header'; readonly label: string }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string }

/**
 * 把分好组的目录拍平成左栏要画的行。
 *
 * ⚠️ **不虚拟化**：P0 是 17 个工具、P1 再加十来个，连标题一起也就三十几行，
 * 而 `src/ui/virtual.ts` 那套是为「十万个文件」写的。三十行上挂虚拟滚动只会换来
 * 一个量不到高度的 jsdom（`clientHeight` 恒为 0，于是组件测试永远只看得见头 6 行）
 */
export function toolRows(groups: readonly ToolGroup[]): readonly ToolRow[] {
  const rows: ToolRow[] = []
  for (const group of groups) {
    rows.push({ kind: 'header', label: group.label })
    for (const tool of group.tools) rows.push({ kind: 'tool', id: tool.id, name: tool.name })
  }
  return rows
}

/**
 * 在左栏里上下移动，**跳过分类标题**，两端都停住不绕回。
 *
 * 返回的是 `rows` 里的下标；一个工具都没有时返回 `-1`。
 *
 * ⚠️ `selected` 不是工具行（`-1`，或者过滤之后它指到了一个标题上）时，
 * 往下走取第一个、往上走取最后一个——那正是「刚打完一个过滤词就按 ↓」的情形，
 * 而它该落在第一个匹配上，不是落在一个标题上
 *
 * ⛔ 不绕回：按住 ↓ 一路到底之后突然跳回第一行，是列表里最让人失去方向的一件事
 * （与 `goto/store.ts` 的 `moveSelection` 同一条）
 */
export function moveRowSelection(rows: readonly ToolRow[], selected: number, delta: number): number {
  const indexes: number[] = []
  for (let i = 0; i < rows.length; i++) if (rows[i]?.kind === 'tool') indexes.push(i)
  if (indexes.length === 0) return -1
  const at = indexes.indexOf(selected)
  if (at === -1) return delta >= 0 ? (indexes[0] as number) : (indexes[indexes.length - 1] as number)
  const next = Math.min(indexes.length - 1, Math.max(0, at + delta))
  return indexes[next] as number
}

/** 宿主能力。三条，全是「工具箱自己做不了、只有 App 知道」的事 */
export interface ToolBoxHost {
  /**
   * 取当前文档的正文。`null` = 没有文档（空窗口，或聚焦的是一份只读大文件分片）。
   *
   * ⚠️ 是**快照**而不是活引用：工具跑的是「按下那一刻的正文」，
   * 让它在跑的过程中跟着文档变的话，输出会与输入对不上，而用户看不出是哪一版
   */
  readEditor: () => string | null
  /** 把结果插到光标处。`false` = 此刻没有可插的地方，面板会如实说一句 */
  writeEditor: (text: string) => boolean
  /**
   * 复制一段文字到剪贴板。`false` = 失败了。
   *
   * ⚠️ 允许返回 Promise（`navigator.clipboard.writeText` 就是），
   * 所以面板上那一下「已复制」是**等真的复制完**才说的
   */
  copy: (text: string) => boolean | Promise<boolean>
}

export interface ToolBoxInit {
  /** M1-A 那**一个**命令注册表。工具会被投影成命令，见 `./registry.ts` */
  commands: CommandRegistry
  /** 要装的工具。M3-B-1 交的是框架，所以这里可以是空的（面板会如实说「还没有工具」） */
  tools: readonly ToolDefinition[]
  host: ToolBoxHost
  /** 测试注入点。缺省是 `domTimer` */
  timer?: Timer
}

export interface ToolBox extends ToolHost {
  readonly visible: () => boolean
  /** 每加一就 focus 一次，理由与 `goto/store.ts` 的 `focusRequest` 逐字相同（用计数不用布尔） */
  readonly focusRequest: () => number
  readonly catalog: ToolCatalog
  /** 左栏的行（已过滤、已分组、已拍平） */
  readonly rows: () => readonly ToolRow[]
  readonly filter: () => string
  setFilter: (value: string) => void
  /** 左栏高亮的那一行的下标；`-1` = 没有高亮 */
  readonly cursor: () => number
  moveCursor: (delta: number) => void
  /**
   * 把高亮挪到某一行（鼠标悬停用）。
   *
   * ⚠️ 只挪高亮，**不换工作台上的工具**：悬停就换工具的话，鼠标扫过左栏一路会把
   * 每个工具都跑一遍。落地是 `commitCursor`（Enter）或点一下（`openTool`）的事
   */
  selectRow: (index: number) => void
  /** 把高亮那一行的工具打开。高亮在标题上或没有高亮时打开第一个匹配 */
  commitCursor: () => void
  /** 当前工作台上的工具。`null` = 目录是空的 */
  readonly tool: () => ToolDefinition | null
  readonly input: () => string
  setInput: (value: string) => void
  readonly options: () => ToolOptions
  /** 收窄失败的选项值不会写进去，而是变成一句话 */
  setOption: (key: string, raw: string | boolean) => void
  readonly optionError: () => string | null
  readonly result: () => ToolResult | null
  readonly busy: () => boolean
  /** 面板自己的一句话（复制成功、插回编辑器、超过上限…），与工具的输出是两个槽位 */
  readonly notice: () => string | null
  readonly footer: () => string
  /** 立刻跑一次，丢掉在飞的那一次防抖 */
  runNow: () => void
  copyResult: () => void
  takeFromEditor: () => void
  insertIntoEditor: () => void
  /** 展开工具箱。不给 id 就停在上次那个工具上（第一次是目录里的第一个） */
  show: (id?: string) => void
  hide: () => void
  dispose: () => void
}

/** 输出格里什么都没跑出来时显示的那一句。⛔ 不是空串：一块空白看不出是「还没跑」还是「跑出来是空的」 */
export const OUTPUT_PLACEHOLDER = '输出会出现在这里'

/** 数字里插千分位。⚠️ 用 `toLocaleString` 的话 CI 的 ubuntu 与本机的 macOS 会给出两个字符串 */
export function groupDigits(value: number): string {
  const text = String(Math.abs(value))
  const out: string[] = []
  for (let i = text.length; i > 0; i -= 3) out.unshift(text.slice(Math.max(0, i - 3), i))
  return (value < 0 ? '-' : '') + out.join(' ')
}

export function createToolBox(init: ToolBoxInit): ToolBox {
  const host = init.host
  const timer = init.timer ?? domTimer

  const [visible, setVisible] = createSignal(false)
  const [focusRequest, setFocusRequest] = createSignal(0)
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [filter, setFilterSignal] = createSignal('')
  const [cursor, setCursor] = createSignal(-1)
  const [input, setInputSignal] = createSignal('')
  const [options, setOptions] = createSignal<ToolOptions>({})
  const [optionError, setOptionError] = createSignal<string | null>(null)
  const [result, setResult] = createSignal<ToolResult | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [elapsedMs, setElapsedMs] = createSignal(0)

  /**
   * 在飞的那一次 `run` 的序号。
   *
   * ⚠️ 换工具、关掉面板都要把它抬一格：抬格本身就是作废，
   * 于是「上一个工具的输出落进新工具的工作台」这件事在结构上写不出来
   */
  let seq = 0

  // 🔴 这两句的顺序是承重的：`installTools` 要一个 `openTool`，而 `open` 是下面那个函数声明
  // （靠提升才拿得到）。反过来写的话 `open` 会读到还没赋值的 `catalog`
  const installed = installTools(init.commands, { openTool: (id) => open(id) }, init.tools)
  const catalog = installed.catalog

  const groups = createMemo(() => groupTools(filterTools(catalog.all(), filter())))
  const rows = createMemo(() => toolRows(groups()))
  const tool = createMemo(() => {
    const id = selectedId()
    return id === null ? null : (catalog.get(id) ?? null)
  })

  const debounced = createDebounced(timer, TOOL_DEBOUNCE_MS, () => void runNow())

  const footer = createMemo(() => {
    if (tool() === null) return '工具箱还是空的'
    if (busy()) return '正在运行…'
    const current = result()
    if (current === null) return '还没跑'
    if (current.kind === 'error') return `跑了 ${groupDigits(elapsedMs())}ms，没跑出结果`
    return `${groupDigits(input().length)} → ${groupDigits(current.text.length)} 字符 · ${groupDigits(elapsedMs())}ms`
  })

  /** 从当前文档预填输入格。⚠️ 只在**空**的时候填，⛔ 不覆盖用户打进去的东西 */
  function prefill(): void {
    const current = tool()
    if (current === null || current.input !== 'editor') return
    if (input() !== '') return
    const text = host.readEditor()
    if (text === null) {
      // 说出口而不是静默留空：`input: 'editor'` 的工具打开时输入格是空的，
      // 而「空」与「这份文档本来就是空的」在屏幕上长得一模一样
      setNotice('现在没有打开的文档，输入格是空的')
      return
    }
    setInputSignal(text)
    setNotice(null)
  }

  function runNow(): void {
    const current = tool()
    if (current === null) {
      seq++
      setBusy(false)
      setResult(null)
      return
    }
    const text = current.input === 'none' ? '' : input()
    /**
     * 选项与输入一样是**发出那一刻的快照**。
     *
     * ⚠️ 挪到微任务里读的话，用户在等待期间改的选项会被算进这一次的输出，
     * 而那一次的序号还是旧的——输出与选项条对不上，而且看不出是哪一版
     */
    const snapshot = options()
    if (text.length > MAX_TOOL_CHARS) {
      seq++
      setBusy(false)
      setResult(null)
      setNotice(
        `这一格最多接 ${groupDigits(MAX_TOOL_CHARS)} 个字符，现在有 ${groupDigits(text.length)} 个——先剪一段再跑`,
      )
      return
    }
    setNotice(null)
    setBusy(true)
    const mine = ++seq
    const startedAt = Date.now()
    // 🔴 一律 `Promise.resolve(...)` 包一层：同步工具抛出来的异常也要落到下面那个
    // rejection 分支里去。裸调 `current.run(...)` 的话，一个抛异常的工具会把整条
    // 事件处理器掀掉，而用户看到的是「输出格停在上一份结果」——一条静默
    void Promise.resolve()
      .then(() => current.run(text, snapshot))
      .then(
        (value) => {
          if (mine !== seq) return
          setBusy(false)
          setElapsedMs(Date.now() - startedAt)
          setResult(value)
        },
        (err: unknown) => {
          if (mine !== seq) return
          setBusy(false)
          setElapsedMs(Date.now() - startedAt)
          // ⚠️ 工具**不该**抛（描述符的约定是返回 `{ kind: 'error' }`，那样它能说清
          // 是哪一行哪一列），但真抛了也不能变成一条没人接的 rejection：
          // 那种失败在界面上的样子是「点了没反应」
          setResult({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
        },
      )
  }

  /** 排一次防抖。⚠️ 用 `schedule` 而不是 `now`：连续打字时一次都不该跑 */
  function scheduleRun(): void {
    debounced.schedule()
  }

  function select(id: string): void {
    if (selectedId() === id && result() !== null) {
      // 同一个工具再点一次：不重置选项也不清输出，那一下什么都该不变。
      // 少了这一支的话，用户每点一次左栏就丢一次刚跑出来的结果
      return
    }
    const next = catalog.get(id)
    if (next === undefined) return
    seq++
    debounced.cancel()
    setSelectedId(id)
    setOptions(defaultOptions(next))
    setOptionError(null)
    setResult(null)
    setBusy(false)
    setNotice(null)
    setCursor(rows().findIndex((row) => row.kind === 'tool' && row.id === id))
    prefill()
    scheduleRun()
  }

  function open(id: string): void {
    setVisible(true)
    setFocusRequest((n) => n + 1)
    select(id)
  }

  function show(id?: string): void {
    setVisible(true)
    setFocusRequest((n) => n + 1)
    if (id !== undefined) {
      select(id)
      return
    }
    const current = selectedId()
    if (current !== null && catalog.has(current)) {
      // 停在上次那个工具上，但**重跑一次**：`input: 'editor'` 的工具上次跑的是
      // 那一份正文，而文档可能已经改了。⚠️ 只在输入格空的时候重填（见 `prefill`）
      prefill()
      scheduleRun()
      return
    }
    const first = rows().find((row) => row.kind === 'tool')
    if (first?.kind === 'tool') select(first.id)
  }

  function hide(): void {
    setVisible(false)
    // ⚠️ 在飞的那一次要作废：面板已经关掉了，150ms 之后回调照样会跑，
    // 往一组没人看的信号里写值（`md/panel.ts` 的 `onCleanup` 那一条同一个理由）
    seq++
    debounced.cancel()
    setBusy(false)
    // 🔴 输入、选项与选中的工具**都留着**：关掉再打开还在原来那一格，
    // 是「工具抽屉」与「一次性的对话框」的区别。清掉的话用户每关一次都要重粘一遍
  }

  function setFilter(value: string): void {
    setFilterSignal(value)
    // 过滤之后原来那一行可能已经不在了，于是高亮回到第一个匹配。
    // ⛔ 不保持下标：`rows` 被换掉之后同一个下标指的是另一个工具，
    // 那时按 Enter 打开的是「排在第 4 位的那个」，而不是用户看着的那一个
    setCursor(rows().findIndex((row) => row.kind === 'tool'))
  }

  function moveCursor(delta: number): void {
    setCursor(moveRowSelection(rows(), cursor(), delta))
  }

  function commitCursor(): void {
    const at = cursor()
    const row = at >= 0 ? rows()[at] : undefined
    if (row?.kind === 'tool') {
      select(row.id)
      return
    }
    const first = rows().find((candidate) => candidate.kind === 'tool')
    if (first?.kind === 'tool') select(first.id)
  }

  function setInput(value: string): void {
    setInputSignal(value)
    scheduleRun()
  }

  function setOption(key: string, raw: string | boolean): void {
    const current = tool()
    if (current === null) return
    const option = (current.options ?? []).find((candidate) => candidate.key === key)
    if (option === undefined) return
    const value = coerceOption(option, raw)
    if (value === null) {
      // 🔴 保持原值不动，只说一句话。悄悄夹到边界上的话，屏幕上那个格子写着 999、
      // `run` 收到的是 64，而用户看不出这两者不是同一个数
      setOptionError(
        option.kind === 'number' ? `${option.label}要在 ${option.min}…${option.max} 之间` : `${option.label}的值不合法`,
      )
      return
    }
    setOptionError(null)
    setOptions({ ...options(), [key]: value })
    scheduleRun()
  }

  function copyResult(): void {
    const current = result()
    if (current === null || current.kind !== 'ok' || current.text === '') {
      setNotice('现在没有可复制的输出')
      return
    }
    const text = current.text
    void Promise.resolve(host.copy(text)).then((ok) => {
      setNotice(ok ? `已复制 ${groupDigits(text.length)} 个字符` : '复制不了——输出格里的文字是可以自己选中的')
    })
  }

  function takeFromEditor(): void {
    const text = host.readEditor()
    if (text === null) {
      setNotice('现在没有打开的文档')
      return
    }
    setNotice(null)
    setInput(text)
  }

  function insertIntoEditor(): void {
    const current = result()
    if (current === null || current.kind !== 'ok' || current.text === '') {
      setNotice('现在没有可插入的输出')
      return
    }
    if (!host.writeEditor(current.text)) {
      setNotice('现在没有可插入的编辑器')
      return
    }
    // ⚠️ 插完就关：那块浮层是居中的一大块，盖住的正是刚插进去的那些字。
    // 留着不关的话用户看不见自己那一下有没有成，而他下一个动作是再点一次
    hide()
  }

  return {
    visible,
    focusRequest,
    catalog,
    rows,
    filter,
    setFilter,
    cursor,
    moveCursor,
    selectRow: (index) => setCursor(index),
    commitCursor,
    tool,
    input,
    setInput,
    options,
    setOption,
    optionError,
    result,
    busy,
    notice,
    footer,
    runNow: () => {
      debounced.now()
    },
    copyResult,
    takeFromEditor,
    insertIntoEditor,
    openTool: open,
    show,
    hide,
    dispose: installed.dispose,
  }
}
