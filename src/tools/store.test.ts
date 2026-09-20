import { createRoot } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createCommandRegistry, type CommandRegistry } from '../commands/registry'
import type { Timer } from '../ui/timer'
import type { ToolDefinition, ToolOptions, ToolResult } from './tool'
import {
  createToolBox,
  groupDigits,
  MAX_TOOL_CHARS,
  moveRowSelection,
  OUTPUT_PLACEHOLDER,
  toolRows,
  TOOL_DEBOUNCE_MS,
  type ToolBox,
  type ToolBoxHost,
} from './store'

/**
 * 工具箱状态机的单测。
 *
 * 本文件钉的是那一层最容易写反、而写反了**不报错**的东西：换工具时清什么留什么、
 * 在飞的那一次 `run` 什么时候该被丢掉、防抖窗口有没有真的挡住连打。
 * 组件那一半（画什么、焦点落在哪一格）在 `./ToolBox.test.tsx` 里。
 *
 * ⚠️ 时钟是**手动挡**：`ToolBoxInit.timer` 本来就是注入点，所以这里不去 `vi.useFakeTimers`。
 * 改了全局时钟就得记得改回来，而 `flush` 用的那个 `setTimeout` 正好是被冻住的那一个——
 * 两个坑一次踩完。理由与 `src/ui/timer.test.ts` 逐字相同。
 */

/** 手动挡的时钟：`Timer` 是注入点，不必碰全局 */
function fakeTimer() {
  let nextId = 1
  const scheduled = new Map<number, () => void>()
  const timer: Timer = {
    after: (fn) => {
      const id = nextId++
      scheduled.set(id, fn)
      return id
    },
    cancel: (id) => {
      scheduled.delete(id)
    },
  }
  return {
    timer,
    /** 把在飞的那一次全部放掉，按排队顺序 */
    fire() {
      const due = [...scheduled.entries()]
      scheduled.clear()
      for (const [, fn] of due) fn()
    },
    pending: () => scheduled.size,
  }
}

/**
 * 等微任务排空。
 *
 * `runNow` 里那层 `Promise.resolve().then(...)` 意味着**同步工具的结果也是异步落地的**，
 * 所以每一条跑完工具的用例都得等一下。用 `setTimeout` 而不是 `await Promise.resolve()`：
 * 后者只推进一个微任务，而这里至少有两层 `.then`（同 `src/goto/store.test.ts`）
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * 放掉在飞的防抖，**并等 `run` 真的被调到**。
 *
 * ⚠️ 两步不是一步：`runNow` 把工具包在 `Promise.resolve().then(...)` 里，
 * 所以 `clock.fire()` 返回的那一刻 `tool.manual` 的 resolver 还没进 `pending`
 */
async function fire() {
  clock.fire()
  await flush()
}

function def(id: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id,
    name: id,
    category: 'text',
    input: 'text',
    side: 'js',
    run: (text) => ({ kind: 'ok', text }),
    ...overrides,
  }
}

const UPPER = def('tool.upper', {
  name: 'Upper',
  category: 'format',
  run: (text) => ({ kind: 'ok', text: text.toUpperCase() }),
})
const ECHO = def('tool.echo', { name: 'Echo' })
/** 分类顺序是 `CATEGORY_ORDER`，于是 `format` 那一组排在 `text` 前面 */
const CATALOG = [ECHO, UPPER]

function makeHost(overrides: Partial<ToolBoxHost> = {}): ToolBoxHost {
  /** `null` = 没有打开的文档。用例用 `overrides` 就能切两种世界 */
  const doc: { text: string | null } = { text: '正文' }
  return { readEditor: () => doc.text, writeEditor: () => true, copy: () => true, ...overrides }
}

let box: ToolBox
let clock: ReturnType<typeof fakeTimer>
let registry: CommandRegistry
let readEditor: Mock<() => string | null>
let writeEditor: Mock<(text: string) => boolean>
let copy: Mock<(text: string) => boolean | Promise<boolean>>
/** `createToolBox` 里有四个 `createMemo`；不在 root 里建，它们永远不会被释放 */
let dispose: (() => void) | undefined
/** `tool.manual` 那一路攒下的 resolver，用例自己决定什么时候放它落地 */
let pending: ((value: ToolResult) => void)[]
let manualRun: Mock<(text: string, options: ToolOptions) => Promise<ToolResult>>

/** 一个永远不自己落地的工具，用来把「在飞的那一次」掰开看 */
const MANUAL = def('tool.manual', {
  name: 'Manual',
  run: (text, options) => manualRun(text, options),
})

function mount(tools: readonly ToolDefinition[] = CATALOG, overrides: Partial<ToolBoxHost> = {}) {
  const made = makeHost(overrides)
  readEditor = vi.fn(made.readEditor)
  writeEditor = vi.fn(made.writeEditor)
  copy = vi.fn(made.copy)
  clock = fakeTimer()
  registry = createCommandRegistry({ getContext: () => ({ editor: null }) })
  dispose = createRoot((teardown) => {
    box = createToolBox({
      commands: registry,
      tools,
      host: { readEditor, writeEditor, copy },
      timer: clock.timer,
    })
    return teardown
  })
}

beforeEach(() => {
  pending = []
  manualRun = vi.fn<(text: string, options: ToolOptions) => Promise<ToolResult>>(
    () => new Promise<ToolResult>((resolve) => void pending.push(resolve)),
  )
})

afterEach(() => {
  dispose?.()
  dispose = undefined
})

describe('常量', () => {
  it('防抖窗口是 150ms', () => {
    // 与 `md/panel.ts` 的 `PANEL_DEBOUNCE_MS` 分开钉：今天同值，而两个数答的不是同一个问题
    expect(TOOL_DEBOUNCE_MS).toBe(150)
  })

  it('输入上限是一百万字符', () => {
    expect(MAX_TOOL_CHARS).toBe(1_000_000)
  })

  it('占位句不是空串', () => {
    // 空串的话「还没跑」与「跑出来是空的」在屏幕上长得一模一样
    expect(OUTPUT_PLACEHOLDER.length).toBeGreaterThan(0)
  })
})

describe('groupDigits', () => {
  it('千分位用空格，不用 toLocaleString', () => {
    // 🔴 `toLocaleString` 在 CI 的 ubuntu 与本机的 macOS 上给的不是同一个字符串
    expect(groupDigits(1000)).toBe('1 000')
    expect(groupDigits(1234567)).toBe('1 234 567')
  })

  it('0、三位以内、负数', () => {
    expect(groupDigits(0)).toBe('0')
    expect(groupDigits(999)).toBe('999')
    expect(groupDigits(-1234567)).toBe('-1 234 567')
  })
})

describe('toolRows', () => {
  it('标题与工具交替，顺序就是分组的顺序', () => {
    const rows = toolRows([
      { category: 'format', label: '格式化', tools: [{ id: 'tool.a', name: 'A', category: 'format' }] },
      { category: 'text', label: '文本', tools: [{ id: 'tool.b', name: 'B', category: 'text' }] },
    ])
    expect(rows).toEqual([
      { kind: 'header', label: '格式化' },
      { kind: 'tool', id: 'tool.a', name: 'A' },
      { kind: 'header', label: '文本' },
      { kind: 'tool', id: 'tool.b', name: 'B' },
    ])
  })

  it('目录是空的时候一行都没有', () => {
    expect(toolRows([])).toEqual([])
  })
})

describe('moveRowSelection', () => {
  const rows = toolRows([
    { category: 'format', label: '格式化', tools: [{ id: 'a', name: 'A', category: 'format' }] },
    {
      category: 'text',
      label: '文本',
      tools: [
        { id: 'b', name: 'B', category: 'text' },
        { id: 'c', name: 'C', category: 'text' },
      ],
    },
  ])
  // 行下标：0 标题 / 1 a / 2 标题 / 3 b / 4 c

  it('跳过分类标题', () => {
    expect(moveRowSelection(rows, 1, 1)).toBe(3)
    expect(moveRowSelection(rows, 3, -1)).toBe(1)
  })

  it('两端都停住，不绕回', () => {
    expect(moveRowSelection(rows, 4, 1)).toBe(4)
    expect(moveRowSelection(rows, 1, -1)).toBe(1)
    expect(moveRowSelection(rows, 4, 9)).toBe(4)
  })

  it('一个工具都没有时返回 -1', () => {
    expect(moveRowSelection([], 0, 1)).toBe(-1)
    expect(moveRowSelection([{ kind: 'header', label: '格式化' }], 0, 1)).toBe(-1)
  })

  it('没有高亮时往下取第一个、往上取最后一个', () => {
    expect(moveRowSelection(rows, -1, 1)).toBe(1)
    expect(moveRowSelection(rows, -1, -1)).toBe(4)
  })

  it('高亮落在标题上时同样按「没有高亮」处理', () => {
    // 过滤之后 `rows` 被换掉，原来那个下标可能指到一个标题上
    expect(moveRowSelection(rows, 2, 1)).toBe(1)
    expect(moveRowSelection(rows, 0, -1)).toBe(4)
  })
})

describe('createToolBox · 展开与目录', () => {
  it('目录是空的：没有工具，页脚如实说一句', () => {
    mount([])
    expect(box.tool()).toBeNull()
    expect(box.rows()).toEqual([])
    expect(box.footer()).toBe('工具箱还是空的')
    box.show()
    expect(box.visible()).toBe(true)
    expect(box.tool()).toBeNull()
    // 空目录上按 ↑↓ 与「立刻跑一次」都不该炸
    box.moveCursor(1)
    expect(box.cursor()).toBe(-1)
    box.runNow()
    box.commitCursor()
    expect(box.tool()).toBeNull()
  })

  it('show() 选中第一个工具行，不是第一个分类标题', () => {
    mount()
    box.show()
    expect(box.rows().map((row) => row.kind)).toEqual(['header', 'tool', 'header', 'tool'])
    expect(box.tool()?.id).toBe('tool.upper')
    expect(box.cursor()).toBe(1)
  })

  it('show(id) 直接选中那一个', () => {
    mount()
    box.show('tool.echo')
    expect(box.tool()?.id).toBe('tool.echo')
    expect(box.cursor()).toBe(3)
  })

  it('show() 一个不存在的 id 什么都不改', () => {
    mount()
    box.show()
    box.show('tool.nope')
    expect(box.tool()?.id).toBe('tool.upper')
  })

  it('focusRequest 是计数：关掉再展开也自增', () => {
    mount()
    expect(box.focusRequest()).toBe(0)
    box.show()
    const after = box.focusRequest()
    expect(after).toBe(1)
    box.hide()
    box.show()
    // 布尔值的话第二次 show 不会触发组件里那个 focus 的 effect
    expect(box.focusRequest()).toBe(after + 1)
  })

  it('左栏的行跟着过滤词走，高亮回到第一个**工具**行', () => {
    mount()
    box.show('tool.echo')
    box.setFilter('Echo')
    expect(box.rows()).toEqual([
      { kind: 'header', label: '文本' },
      { kind: 'tool', id: 'tool.echo', name: 'Echo' },
    ])
    // ⛔ 不是 0：那是标题行
    expect(box.cursor()).toBe(1)
    box.setFilter('zzz')
    expect(box.rows()).toEqual([])
    expect(box.cursor()).toBe(-1)
    box.setFilter('')
    expect(box.cursor()).toBe(1)
  })

  it('moveCursor 跳过标题，commitCursor 打开高亮那一个', () => {
    mount()
    box.show()
    expect(box.tool()?.id).toBe('tool.upper')
    box.moveCursor(1)
    expect(box.cursor()).toBe(3)
    box.commitCursor()
    expect(box.tool()?.id).toBe('tool.echo')
  })

  it('高亮永远指不到标题行', () => {
    mount()
    box.show()
    for (let i = 0; i < 6; i++) box.moveCursor(1)
    expect(box.rows()[box.cursor()]?.kind).toBe('tool')
    for (let i = 0; i < 6; i++) box.moveCursor(-1)
    expect(box.rows()[box.cursor()]?.kind).toBe('tool')
  })

  it('一行都不剩的时候 commitCursor 不去猜一个工具', () => {
    mount()
    box.setFilter('zzz')
    expect(box.cursor()).toBe(-1)
    box.commitCursor()
    // 屏幕上什么都没有，这时打开随便一个工具是替用户做了他没要求的决定
    expect(box.tool()).toBeNull()
  })
})

describe('createToolBox · 命令投影', () => {
  it('每个工具都是一条命令，执行它就展开面板', async () => {
    mount()
    expect(registry.has('tool.echo')).toBe(true)
    expect(box.visible()).toBe(false)
    await registry.execute('tool.echo')
    expect(box.visible()).toBe(true)
    expect(box.tool()?.id).toBe('tool.echo')
  })

  it('openTool 与 show(id) 是同一条路', () => {
    mount()
    box.openTool('tool.upper')
    expect(box.visible()).toBe(true)
    expect(box.tool()?.id).toBe('tool.upper')
  })

  it('dispose 把命令一并反注册', () => {
    mount()
    expect(registry.has('tool.echo')).toBe(true)
    box.dispose()
    expect(registry.has('tool.echo')).toBe(false)
    expect(box.catalog.all()).toEqual([])
  })
})

describe('createToolBox · 🔴 换工具时清什么、留什么', () => {
  const WITH_OPTIONS = def('tool.opts', {
    name: 'Opts',
    category: 'format',
    options: [
      { kind: 'toggle', key: 'flag', label: '开关', default: true },
      { kind: 'select', key: 'mode', label: '模式', choices: ['a', 'b'], default: 'a' },
    ],
  })
  const OTHER_OPTIONS = def('tool.other', {
    name: 'Other',
    options: [{ kind: 'number', key: 'indent', label: '缩进', min: 1, max: 8, default: 2 }],
  })

  it('选项重置成新工具的默认值', () => {
    mount([WITH_OPTIONS, OTHER_OPTIONS])
    box.show('tool.opts')
    expect(box.options()).toEqual({ flag: true, mode: 'a' })
    box.setOption('mode', 'b')
    expect(box.options()).toEqual({ flag: true, mode: 'b' })
    box.show('tool.other')
    // 🔴 留着的话上一个工具的 `mode: 'b'` 会塞进一个没有 `mode` 的工具
    expect(box.options()).toEqual({ indent: 2 })
    box.show('tool.opts')
    expect(box.options()).toEqual({ flag: true, mode: 'a' })
  })

  it('输出清空', async () => {
    mount()
    box.show('tool.echo')
    box.setInput('hi')
    clock.fire()
    await flush()
    expect(box.result()).toEqual({ kind: 'ok', text: 'hi' })
    box.show('tool.upper')
    // 留着的话「Upper」底下显示的是刚才 echo 的结果，而它长得完全像一份合法输出
    expect(box.result()).toBeNull()
    expect(box.optionError()).toBeNull()
    expect(box.notice()).toBeNull()
  })

  it('输入留着，于是切工具不必重新粘一遍', async () => {
    mount()
    box.show('tool.echo')
    box.setInput('hi')
    clock.fire()
    await flush()
    expect(box.result()).toEqual({ kind: 'ok', text: 'hi' })
    box.show('tool.upper')
    expect(box.input()).toBe('hi')
    clock.fire()
    await flush()
    expect(box.result()).toEqual({ kind: 'ok', text: 'HI' })
  })

  it('同一个工具再点一次不动任何东西', async () => {
    mount()
    box.show('tool.echo')
    box.setInput('hi')
    clock.fire()
    await flush()
    const before = box.result()
    const options = box.options()
    box.openTool('tool.echo')
    // 少了这一支的话，用户每点一次左栏就丢一次刚跑出来的结果
    expect(box.result()).toBe(before)
    expect(box.options()).toBe(options)
    // ⚠️ 但面板要是关着的，这一下得把它打开
    box.hide()
    box.openTool('tool.echo')
    expect(box.visible()).toBe(true)
  })

  it('新工具是 input: editor 而输入格是空的，就从文档预填一次', () => {
    mount([def('tool.from-editor', { input: 'editor' })])
    box.show()
    expect(box.input()).toBe('正文')
    expect(readEditor).toHaveBeenCalled()
  })

  it('预填只在输入格空的时候发生，⛔ 不覆盖用户打进去的字', () => {
    mount([ECHO, def('tool.from-editor', { input: 'editor' })])
    box.show('tool.echo')
    box.setInput('我打的')
    box.show('tool.from-editor')
    expect(box.input()).toBe('我打的')
  })

  it('input: editor 而没有文档时如实说一句，不静默留空', () => {
    mount([def('tool.from-editor', { input: 'editor' })], { readEditor: () => null })
    box.show()
    expect(box.input()).toBe('')
    expect(box.notice()).toBe('现在没有打开的文档，输入格是空的')
  })

  it('input: none 的工具跑的时候拿到的是空串', async () => {
    const run = vi.fn<(text: string, options: ToolOptions) => ToolResult>(() => ({ kind: 'ok', text: 'ran' }))
    mount([def('tool.no-input', { input: 'none', run })])
    box.show()
    box.setInput('这些字不该被看见')
    clock.fire()
    await flush()
    expect(run).toHaveBeenCalledWith('', {})
  })
})

describe('createToolBox · 跑一次', () => {
  it('连打三次只跑一次，而且跑在最后那一次之后', async () => {
    mount([MANUAL])
    box.show()
    box.setInput('a')
    box.setInput('ab')
    box.setInput('abc')
    // 防抖与节流的分界：节流会跑第一次，防抖一次都不跑
    expect(manualRun).not.toHaveBeenCalled()
    expect(clock.pending()).toBe(1)
    clock.fire()
    await flush()
    expect(manualRun).toHaveBeenCalledOnce()
    expect(manualRun).toHaveBeenLastCalledWith('abc', {})
  })

  it('runNow 立刻跑，并丢掉在飞的那一次', async () => {
    mount([MANUAL])
    box.show()
    box.setInput('a')
    expect(clock.pending()).toBe(1)
    box.runNow()
    expect(clock.pending()).toBe(0)
    await flush()
    expect(manualRun).toHaveBeenCalledOnce()
  })

  it('跑的时候 busy 是 true，落地之后回到 false 并写进 result', async () => {
    mount([MANUAL])
    box.show()
    box.setInput('x')
    clock.fire()
    expect(box.busy()).toBe(true)
    expect(box.footer()).toBe('正在运行…')
    await flush()
    pending[0]?.({ kind: 'ok', text: '好了' })
    await flush()
    expect(box.busy()).toBe(false)
    expect(box.result()).toEqual({ kind: 'ok', text: '好了' })
    expect(box.footer()).toContain('1 → 2 字符')
    expect(box.footer()).toContain('ms')
  })

  it('错误结果也落地，页脚说「没跑出结果」', async () => {
    mount([MANUAL])
    box.show()
    await fire()
    pending[0]?.({ kind: 'error', text: '第 3 行第 7 列多了一个逗号' })
    await flush()
    expect(box.result()).toEqual({ kind: 'error', text: '第 3 行第 7 列多了一个逗号' })
    expect(box.footer()).toContain('没跑出结果')
  })

  it('ok 而文字是空的，页脚照实算字符数', async () => {
    mount([MANUAL])
    box.show()
    await fire()
    pending[0]?.({ kind: 'ok', text: '' })
    await flush()
    // 这一格由组件换成 `OUTPUT_PLACEHOLDER`；store 只负责不撒谎
    expect(box.result()).toEqual({ kind: 'ok', text: '' })
    expect(box.footer()).toContain('→ 0 字符')
  })

  it('🔴 同步抛出来的异常也落到 error，不是一条没人接的 rejection', async () => {
    mount([
      def('tool.boom', {
        run: () => {
          throw new Error('炸了')
        },
      }),
    ])
    box.show()
    clock.fire()
    await flush()
    expect(box.busy()).toBe(false)
    expect(box.result()).toEqual({ kind: 'error', text: '炸了' })
  })

  it('异步 reject 落到 error，非 Error 的值转成字符串', async () => {
    mount([
      def('tool.reject-error', { run: () => Promise.reject(new Error('异步炸了')) }),
      def('tool.reject-plain', {
        run: () => {
          // ⚠️ 豁免是必需的，不是偷懒：Tauri 的 `invoke` 在 Rust 侧返回 `Err` 时抛给前端的
          // 就是序列化后的那个对象，不是 `Error` 实例（同 `src/goto/store.test.ts`）
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw { code: 7 }
        },
      }),
    ])
    box.show('tool.reject-error')
    clock.fire()
    await flush()
    expect(box.result()).toEqual({ kind: 'error', text: '异步炸了' })
    box.show('tool.reject-plain')
    await fire()
    // 🔴 这一条钉的是**兜底有多粗糙**：不是 Error 就只能 `String()`，于是用户看见
    // `[object Object]`。描述符的约定正是为此而立——工具自己 `try/catch`，
    // 返回 `{ kind: 'error', text }`，那样它能说清是哪一行哪一列
    expect(box.result()).toEqual({ kind: 'error', text: '[object Object]' })
  })

  it('超过上限就在跑之前拦下，并把两个数都说出来', async () => {
    mount([MANUAL])
    box.show()
    box.setInput('a'.repeat(MAX_TOOL_CHARS + 1))
    clock.fire()
    await flush()
    expect(manualRun).not.toHaveBeenCalled()
    expect(box.result()).toBeNull()
    expect(box.notice()).toContain('1 000 000')
    expect(box.notice()).toContain('1 000 001')
  })

  it('刚好在上限内不拦', async () => {
    mount([MANUAL])
    box.show()
    box.setInput('a'.repeat(MAX_TOOL_CHARS))
    clock.fire()
    await flush()
    expect(manualRun).toHaveBeenCalledOnce()
    expect(box.notice()).toBeNull()
  })
})

describe('createToolBox · 🔴 请求序号', () => {
  it('慢的那一次盖不掉快的那一次', async () => {
    mount([MANUAL])
    box.show()
    box.setInput('a')
    await fire()
    box.setInput('ab')
    await fire()
    expect(pending).toHaveLength(2)
    // 返回顺序与发出顺序无关，这正是线上会发生的事
    pending[1]?.({ kind: 'ok', text: '新的' })
    await flush()
    pending[0]?.({ kind: 'ok', text: '旧的' })
    await flush()
    // 不加序号的话用户会看见输出**退回到上一个键的状态**
    expect(box.result()).toEqual({ kind: 'ok', text: '新的' })
  })

  it('换工具作废在飞的那一次', async () => {
    mount([MANUAL, ECHO])
    box.show('tool.manual')
    box.setInput('x')
    await fire()
    expect(pending).toHaveLength(1)
    box.show('tool.echo')
    clock.fire()
    await flush()
    expect(box.result()).toEqual({ kind: 'ok', text: 'x' })
    pending[0]?.({ kind: 'ok', text: '上一个工具的' })
    await flush()
    expect(box.result()).toEqual({ kind: 'ok', text: 'x' })
  })

  it('关掉面板作废在飞的那一次', async () => {
    mount([MANUAL])
    box.show()
    await fire()
    box.hide()
    pending[0]?.({ kind: 'ok', text: '迟到的' })
    await flush()
    // 面板已经关掉了，回调照样会跑，往一组没人看的信号里写值
    expect(box.result()).toBeNull()
    expect(box.busy()).toBe(false)
  })

  it('关掉面板时把在飞的防抖也取消掉', () => {
    mount([MANUAL])
    box.show()
    box.setInput('x')
    expect(clock.pending()).toBe(1)
    box.hide()
    expect(clock.pending()).toBe(0)
    clock.fire()
    expect(manualRun).not.toHaveBeenCalled()
  })
})

describe('createToolBox · hide 保留现场', () => {
  it('输入、选项与选中的工具都留着', async () => {
    mount([
      def('tool.opts', { name: 'Opts', options: [{ kind: 'toggle', key: 'flag', label: '开关', default: false }] }),
    ])
    box.show()
    box.setInput('留着')
    box.setOption('flag', true)
    clock.fire()
    await flush()
    expect(box.result()).toEqual({ kind: 'ok', text: '留着' })
    box.hide()
    expect(box.visible()).toBe(false)
    expect(box.input()).toBe('留着')
    expect(box.options()).toEqual({ flag: true })
    expect(box.tool()?.id).toBe('tool.opts')
    // 再打开还是原来那一格，这是「工具抽屉」与「一次性对话框」的区别
    box.show()
    expect(box.tool()?.id).toBe('tool.opts')
    expect(box.input()).toBe('留着')
  })

  it('show() 停在上次那个工具上并重跑一次', async () => {
    mount([MANUAL])
    box.show()
    clock.fire()
    await flush()
    expect(manualRun).toHaveBeenCalledOnce()
    box.hide()
    box.show()
    // ⚠️ 重跑是**排一次防抖**，不是当场跑
    expect(manualRun).toHaveBeenCalledOnce()
    clock.fire()
    await flush()
    // 文档可能已经改了，所以重跑
    expect(manualRun).toHaveBeenCalledTimes(2)
  })
})

describe('createToolBox · 选项', () => {
  const OPTS = def('tool.opts', {
    name: 'Opts',
    options: [
      { kind: 'toggle', key: 'flag', label: '开关', default: true },
      { kind: 'select', key: 'mode', label: '模式', choices: ['a', 'b'], default: 'a' },
      { kind: 'number', key: 'indent', label: '缩进', min: 2, max: 8, default: 2 },
    ],
    run: (_text, options) => ({ kind: 'ok', text: JSON.stringify(options) }),
  })

  it('改一个选项就排一次跑，并把值传进去', async () => {
    mount([OPTS])
    box.show()
    clock.fire()
    await flush()
    box.setOption('indent', '4')
    expect(clock.pending()).toBe(1)
    clock.fire()
    await flush()
    expect(box.options()).toEqual({ flag: true, mode: 'a', indent: 4 })
    expect(box.result()?.text).toContain('"indent":4')
  })

  it('🔴 收窄失败时保持原值，只说一句话', () => {
    mount([OPTS])
    box.show()
    box.setOption('indent', '999')
    // 悄悄夹到边界上的话，屏幕上那个格子写着 999、`run` 收到的是 8
    expect(box.options().indent).toBe(2)
    expect(box.optionError()).toBe('缩进要在 2…8 之间')
    box.setOption('mode', 'zzz')
    expect(box.options().mode).toBe('a')
    expect(box.optionError()).toBe('模式的值不合法')
    box.setOption('flag', 'maybe')
    expect(box.options().flag).toBe(true)
    expect(box.optionError()).toBe('开关的值不合法')
  })

  it('成功一次就把上一句错话清掉', () => {
    mount([OPTS])
    box.show()
    box.setOption('indent', '999')
    expect(box.optionError()).not.toBeNull()
    box.setOption('indent', '4')
    expect(box.optionError()).toBeNull()
  })

  it('没声明过的 key 什么都不改', async () => {
    mount([OPTS])
    box.show()
    clock.fire()
    await flush()
    const before = box.options()
    box.setOption('nope', 'x')
    expect(box.options()).toBe(before)
    expect(box.optionError()).toBeNull()
  })

  it('目录是空的时候 setOption 不炸', () => {
    mount([])
    box.setOption('indent', '4')
    expect(box.options()).toEqual({})
  })
})

describe('createToolBox · 与编辑器/剪贴板的三个动作', () => {
  it('takeFromEditor 把正文写进输入格', async () => {
    mount([MANUAL])
    box.show()
    box.takeFromEditor()
    expect(box.input()).toBe('正文')
    expect(clock.pending()).toBe(1)
    clock.fire()
    await flush()
    expect(manualRun).toHaveBeenLastCalledWith('正文', {})
  })

  it('takeFromEditor 在没有文档时如实说一句', () => {
    mount([ECHO], { readEditor: () => null })
    box.show()
    box.takeFromEditor()
    expect(box.input()).toBe('')
    expect(box.notice()).toBe('现在没有打开的文档')
  })

  it('copyResult 等真的复制完才说「已复制」', async () => {
    const slowCopy = vi.fn<(text: string) => Promise<boolean>>(() => Promise.resolve(true))
    mount([MANUAL], { copy: slowCopy })
    box.show()
    await fire()
    pending[0]?.({ kind: 'ok', text: 'abc' })
    await flush()
    box.copyResult()
    // ⚠️ `navigator.clipboard.writeText` 是异步的，那一句「已复制」不能抢在它前面
    expect(box.notice()).toBeNull()
    await flush()
    expect(slowCopy).toHaveBeenCalledWith('abc')
    expect(box.notice()).toBe('已复制 3 个字符')
  })

  it('copyResult 在复制失败时说清还有别的办法', async () => {
    mount([MANUAL], { copy: () => false })
    box.show()
    await fire()
    pending[0]?.({ kind: 'ok', text: 'abc' })
    await flush()
    box.copyResult()
    await flush()
    expect(box.notice()).toBe('复制不了——输出格里的文字是可以自己选中的')
  })

  it('没有可复制的输出时不去碰剪贴板', async () => {
    mount([MANUAL])
    box.show()
    box.copyResult()
    expect(copy).not.toHaveBeenCalled()
    expect(box.notice()).toBe('现在没有可复制的输出')

    box.setInput('y')
    pending.length = 0
    await fire()
    pending[0]?.({ kind: 'error', text: '炸了' })
    await flush()
    box.copyResult()
    expect(copy).not.toHaveBeenCalled()

    // 空输出同样不复制：那一下会把剪贴板里的东西换成什么都没有
    box.setInput('z')
    pending.length = 0
    await fire()
    pending[0]?.({ kind: 'ok', text: '' })
    await flush()
    box.copyResult()
    expect(copy).not.toHaveBeenCalled()
  })

  it('insertIntoEditor 插完就把浮层关掉', async () => {
    mount([MANUAL])
    box.show()
    await fire()
    pending[0]?.({ kind: 'ok', text: '结果' })
    await flush()
    box.insertIntoEditor()
    expect(writeEditor).toHaveBeenCalledWith('结果')
    // ⚠️ 那块浮层盖住的正是刚插进去的那些字
    expect(box.visible()).toBe(false)
  })

  it('insertIntoEditor 在没有编辑器时留着浮层并说一句', async () => {
    mount([MANUAL], { writeEditor: () => false })
    box.show()
    await fire()
    pending[0]?.({ kind: 'ok', text: '结果' })
    await flush()
    box.insertIntoEditor()
    expect(box.visible()).toBe(true)
    expect(box.notice()).toBe('现在没有可插入的编辑器')
  })

  it('没有可插入的输出时不去碰编辑器', () => {
    mount([MANUAL])
    box.show()
    box.insertIntoEditor()
    expect(writeEditor).not.toHaveBeenCalled()
    expect(box.notice()).toBe('现在没有可插入的输出')
  })

  it('跑一次成功就把上一句提示清掉', async () => {
    mount([MANUAL], { readEditor: () => null })
    box.show()
    box.takeFromEditor()
    expect(box.notice()).toBe('现在没有打开的文档')
    box.setInput('x')
    clock.fire()
    await flush()
    expect(box.notice()).toBeNull()
  })
})
