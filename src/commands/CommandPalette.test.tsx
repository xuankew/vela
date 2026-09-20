// @vitest-environment jsdom
import { createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorController } from '../editor/controller'
import { CommandPalette } from './CommandPalette'
import { createCommandRegistry, type AppContext, type CommandDefinition } from './registry'
import { createCommandPalette, type CommandPalette as Panel } from './palette'

/**
 * 命令面板浮层的测试：DOM 与 `createCommandPalette` 之间的接线。
 *
 * 模糊匹配的打分与排序、`moveRow` 的两端停住、`context` 有没有被订阅，都在 `./palette.test.ts`
 * 里钉过了。这里只测**画出来的东西对不对**与**那六个键落在浮层上分别做什么**。
 *
 * 🔴 本文件最要紧的两条：
 * 1. **没有快捷键的那一行压根不画 `.palette-keys` 节点**。画一个空 span 的话它照样吃掉
 *    自己那份 `margin-left`，于是有键与没键的两行右边界对不齐——那只在 DOM 层看得出来。
 * 2. **键盘处理挂在遮罩上，不是挂在输入框上**。点过某一行之后焦点可能已经不在输入框里，
 *    而那一下 Escape 也该收起浮层。
 *
 * ⚠️ 这里钉不住的：`.palette.wide` 的 600px 够不够同时装下标题、分类与 `⇧⌘P`、
 * `.palette-row.command` 换成 UI 字体之后是什么样子、`opacity: 0.45` 的置灰够不够看得清、
 * `PageDown` 一页到底走几行（jsdom 量不到 `clientHeight`，于是这里恒为 1 行）。都得在真实窗口里看。
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** `AppContext.editor` 只被用来判空，一个空壳就够；真的 `EditorController` 要一块 CodeMirror */
const SOME_EDITOR = {} as EditorController

const NEEDS_EDITOR = (ctx: AppContext) => ctx.editor !== null

function def(id: string, overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return { id, title: id, category: 'misc', run: () => {}, ...overrides }
}

/** 一批固定的命令：分类与快捷键都齐，好把三格都画出来 */
const DEFS: readonly CommandDefinition[] = [
  def('file.save', { title: '保存', category: '文件', keybinding: 'Mod+S' }),
  def('file.open', { title: '打开文件', category: '文件', keybinding: ['Mod+O', 'Mod+Shift+O'] }),
  def('editor.toggleLineWrap', { title: '切换自动换行', category: '编辑器' }),
  def('editor.bold', { title: '加粗', category: '编辑器', keybinding: 'Mod+B', when: NEEDS_EDITOR }),
]

let container: HTMLDivElement
let palette: Panel
let editor: () => EditorController | null
let setEditor: (value: EditorController | null) => void
let disposePalette: (() => void) | undefined
let disposeRender: (() => void) | undefined

function mount(defs: readonly CommandDefinition[] = DEFS): Panel {
  const [signal, setter] = createSignal<EditorController | null>(null)
  editor = signal
  setEditor = setter
  const registry = createCommandRegistry({ getContext: () => ({ editor: editor() }) })
  for (const one of defs) registry.register(one)
  disposePalette = createRoot((teardown) => {
    palette = createCommandPalette({ registry, context: () => ({ editor: editor() }) })
    return teardown
  })
  disposeRender = render(() => <CommandPalette palette={palette} />, container)
  return palette
}

/** 建好并展开。`await` 是给 `focusRequest` 那个 effect 与 `Show` 的子树留时间 */
async function open(defs: readonly CommandDefinition[] = DEFS): Promise<Panel> {
  const panel = mount(defs)
  panel.show()
  await flush()
  return panel
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  disposeRender?.()
  disposePalette?.()
  disposeRender = undefined
  disposePalette = undefined
  container.remove()
})

/* ---------- DOM 读取口 ---------- */

function must<T extends Element>(selector: string): T {
  const el = container.querySelector<T>(selector)
  if (!el) throw new Error(`找不到 ${selector}`)
  return el
}

const backdrop = () => must<HTMLElement>('.palette-backdrop')
const dialog = () => must<HTMLElement>('.palette.wide')
const inputEl = () => must<HTMLInputElement>('.palette-input')
const listEl = () => must<HTMLElement>('.palette-list')
const rows = () => [...container.querySelectorAll<HTMLElement>('.palette-row.command')]
const foot = () => must<HTMLElement>('.palette-foot')
const status = () => must<HTMLElement>('.palette-status')

/** 第 `i` 行里那三格。`keys` 用 `querySelector` 而不是 `must`：没有绑定时它压根不存在 */
const textOf = (i: number) => rows()[i]?.querySelector<HTMLElement>('.palette-text')?.textContent ?? null
const catOf = (i: number) => rows()[i]?.querySelector<HTMLElement>('.palette-cat')?.textContent ?? null
const keysOf = (i: number) => rows()[i]?.querySelector<HTMLElement>('.palette-keys')?.textContent ?? null

/* ---------- 事件口 ---------- */

/** ⚠️ `onInput` 在 Solid 里对应原生 `input`（`onChange` 对应的才是 `change`） */
function typeIn(el: HTMLInputElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

/* ---------- 画出来什么 ---------- */

describe('画出来什么', () => {
  it('收着的时候一个节点都不画', () => {
    mount()
    expect(container.querySelector('.palette-backdrop')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('展开之后画出遮罩、对话框、输入框、列表与页脚', async () => {
    await open()
    expect(backdrop()).toBeTruthy()
    expect(dialog().getAttribute('role')).toBe('dialog')
    expect(dialog().getAttribute('aria-label')).toBe('命令面板')
    expect(inputEl()).toBeTruthy()
    expect(listEl().getAttribute('role')).toBe('listbox')
    expect(foot()).toBeTruthy()
  })

  it('输入框用 aria-controls 指向列表', async () => {
    await open()
    const controls = inputEl().getAttribute('aria-controls')
    expect(controls).toBe('command-palette-list')
    expect(listEl().id).toBe(controls)
  })

  it('输入框关掉拼写检查与三种自动纠正', async () => {
    await open()
    const el = inputEl()
    expect(el.getAttribute('spellcheck')).toBe('false')
    expect(el.getAttribute('autocomplete')).toBe('off')
    expect(el.getAttribute('autocorrect')).toBe('off')
    expect(el.getAttribute('autocapitalize')).toBe('off')
  })

  it('每一行画出标题、分类与快捷键三格', async () => {
    await open()
    expect(rows()).toHaveLength(4)
    // 注册表的顺序是 category → id，而「文」U+6587 < 「编」U+7F16，于是「文件」那一组排在前
    expect(textOf(0)).toBe('打开文件')
    expect(catOf(0)).toBe('文件')
    expect(keysOf(0)).toBe(palette.rows()[0]?.keys)
    expect(keysOf(0)).not.toBe('')
    expect(textOf(2)).toBe('加粗')
    expect(catOf(2)).toBe('编辑器')
  })

  it('两个绑定时 keys 是空格连起来的', async () => {
    await open()
    expect(keysOf(0)).toContain(' ')
    expect(keysOf(1)).not.toContain(' ')
  })

  it('🔴 没有绑定的那一行压根不画 .palette-keys 节点，⛔ 不是画一个空 span', async () => {
    await open()
    const plain = rows().find((row) => row.querySelector('.palette-text')?.textContent === '切换自动换行')
    expect(plain).toBeTruthy()
    expect(plain?.querySelector('.palette-keys')).toBeNull()
    // 空 span 也会占掉 margin-left，于是有键与没键的两行右边界对不齐
    expect(plain?.children).toHaveLength(2)
  })

  it('行的 title 是命令 id', async () => {
    await open()
    expect(rows().map((row) => row.getAttribute('title'))).toContain('editor.toggleLineWrap')
  })

  it('每一行都是 role=option，只有选中那一条 aria-selected 为真', async () => {
    await open()
    const flags = rows().map((row) => row.getAttribute('aria-selected'))
    expect(flags).toEqual(['true', 'false', 'false', 'false'])
    expect(rows().every((row) => row.getAttribute('role') === 'option')).toBe(true)
  })

  it('when 不满足的那一条画成置灰，⛔ 但它照样在列表里', async () => {
    await open()
    const disabled = rows().filter((row) => row.classList.contains('disabled'))
    expect(disabled).toHaveLength(1)
    expect(disabled[0]?.querySelector('.palette-text')?.textContent).toBe('加粗')
    expect(disabled[0]?.getAttribute('aria-disabled')).toBe('true')
    // 用的是 aria-disabled 而不是 disabled：这一行是个 div，没有 disabled 可言
    expect(disabled[0]?.hasAttribute('disabled')).toBe(false)
  })

  it('🔴 焦点一变，置灰当场就跟着变——context 是被订阅的', async () => {
    await open()
    expect(rows().filter((row) => row.classList.contains('disabled'))).toHaveLength(1)
    setEditor(SOME_EDITOR)
    await flush()
    expect(rows().filter((row) => row.classList.contains('disabled'))).toHaveLength(0)
    setEditor(null)
    await flush()
    expect(rows().filter((row) => row.classList.contains('disabled'))).toHaveLength(1)
  })

  it('一条命令都没有时列表是空的，页脚如实说', async () => {
    await open([])
    expect(rows()).toHaveLength(0)
    expect(status().textContent).toBe('共 0 条命令')
  })
})

/* ---------- 打字与按键 ---------- */

describe('打字与按键', () => {
  it('打字过滤列表，并把输入框的值同步出去', async () => {
    await open()
    typeIn(inputEl(), '换行')
    await flush()
    expect(rows()).toHaveLength(1)
    expect(textOf(0)).toBe('切换自动换行')
    expect(palette.query()).toBe('换行')
  })

  it('一条都不匹配时列表空掉，页脚把查询词说出来', async () => {
    await open()
    typeIn(inputEl(), 'zzz')
    await flush()
    expect(rows()).toHaveLength(0)
    expect(status().textContent).toBe('没有匹配「zzz」的命令')
  })

  it('清空查询词就全回来了', async () => {
    await open()
    typeIn(inputEl(), 'zzz')
    await flush()
    typeIn(inputEl(), '')
    await flush()
    expect(rows()).toHaveLength(4)
  })

  it('Escape 收起浮层，并 preventDefault', async () => {
    await open()
    const event = key(backdrop(), { key: 'Escape' })
    expect(event.defaultPrevented).toBe(true)
    expect(palette.visible()).toBe(false)
    await flush()
    expect(container.querySelector('.palette-backdrop')).toBeNull()
  })

  it('🔴 Escape 从输入框里冒泡上来也收得掉——处理挂在遮罩上', async () => {
    await open()
    key(inputEl(), { key: 'Escape' })
    expect(palette.visible()).toBe(false)
  })

  it('Enter 执行选中那一条并收起', async () => {
    const run = vi.fn<(ctx: AppContext) => void>()
    await open([def('a.one', { run }), def('b.two')])
    const event = key(backdrop(), { key: 'Enter' })
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(palette.visible()).toBe(false)
  })

  it('Enter 在一条都没匹配上时也 preventDefault（不拦的话内核会当成表单提交）', async () => {
    await open()
    typeIn(inputEl(), 'zzz')
    await flush()
    const event = key(backdrop(), { key: 'Enter' })
    expect(event.defaultPrevented).toBe(true)
    expect(palette.visible()).toBe(false)
  })

  it('↓↑ 各走一行，两端停住', async () => {
    await open()
    expect(palette.selected()).toBe(0)
    key(backdrop(), { key: 'ArrowDown' })
    expect(palette.selected()).toBe(1)
    key(backdrop(), { key: 'ArrowDown' })
    expect(palette.selected()).toBe(2)
    key(backdrop(), { key: 'ArrowUp' })
    expect(palette.selected()).toBe(1)
    key(backdrop(), { key: 'ArrowUp' })
    key(backdrop(), { key: 'ArrowUp' })
    expect(palette.selected()).toBe(0)
  })

  it('↓↑ 从输入框里冒泡上来也一样走', async () => {
    await open()
    key(inputEl(), { key: 'ArrowDown' })
    expect(palette.selected()).toBe(1)
    expect(rows()[1]?.classList.contains('selected')).toBe(true)
  })

  it('←→ 一律放行给输入框，⛔ 不 preventDefault', async () => {
    await open()
    const before = palette.selected()
    expect(key(backdrop(), { key: 'ArrowLeft' }).defaultPrevented).toBe(false)
    expect(key(backdrop(), { key: 'ArrowRight' }).defaultPrevented).toBe(false)
    expect(palette.selected()).toBe(before)
  })

  it('PageDown/PageUp 也走，而 jsdom 里一页恒为一行（量不到 clientHeight）', async () => {
    await open()
    key(backdrop(), { key: 'PageDown' })
    expect(palette.selected()).toBe(1)
    key(backdrop(), { key: 'PageUp' })
    expect(palette.selected()).toBe(0)
  })

  it('.selected 跟着 store 走', async () => {
    await open()
    palette.select(2)
    await flush()
    expect(rows().map((row) => row.classList.contains('selected'))).toEqual([false, false, true, false])
    expect(rows().map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false'])
  })
})

/* ---------- 点哪儿调什么 ---------- */

describe('点哪儿调什么', () => {
  it('点某一行：先选中再执行，然后收起', async () => {
    const run = vi.fn<(ctx: AppContext) => void>()
    await open([def('a.one'), def('b.two', { run })])
    rows()[1]?.click()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(palette.visible()).toBe(false)
  })

  it('鼠标移到哪一行就选中哪一行', async () => {
    await open()
    rows()[2]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    expect(palette.selected()).toBe(2)
  })

  it('点遮罩空白处收起', async () => {
    await open()
    backdrop().click()
    expect(palette.visible()).toBe(false)
  })

  it('点浮层自己不收起', async () => {
    await open()
    dialog().click()
    expect(palette.visible()).toBe(true)
  })

  it('点列表里也不收起', async () => {
    await open()
    listEl().click()
    expect(palette.visible()).toBe(true)
  })

  it('点置灰的那一行照样调 execute，而 execute 自己返回 false', async () => {
    const run = vi.fn<(ctx: AppContext) => void>()
    await open([def('editor.save', { run, when: NEEDS_EDITOR })])
    expect(rows()[0]?.classList.contains('disabled')).toBe(true)
    rows()[0]?.click()
    await flush()
    expect(run).not.toHaveBeenCalled()
    // ⛔ 不加 cursor:not-allowed：这一行是**点得动**的，只是那一下什么都不发生
    expect(palette.visible()).toBe(false)
  })
})

/* ---------- 焦点与页脚 ---------- */

describe('焦点与页脚', () => {
  it('展开时焦点落在输入框', async () => {
    await open()
    expect(document.activeElement).toBe(inputEl())
  })

  it('浮层已经开着时再展开一次，焦点也抢得回来', async () => {
    await open()
    inputEl().blur()
    expect(document.activeElement).not.toBe(inputEl())
    palette.show()
    await flush()
    expect(document.activeElement).toBe(inputEl())
  })

  it('页脚在没有查询词时只报总数', async () => {
    await open()
    expect(status().textContent).toBe('共 4 条命令')
  })

  it('页脚在有查询词时报「命中 / 总数」', async () => {
    await open()
    typeIn(inputEl(), '文件')
    await flush()
    expect(status().textContent).toBe('2 / 共 4 条命令')
  })
})
