// @vitest-environment jsdom
import { createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createCommandRegistry } from '../commands/registry'
import type { Timer } from '../ui/timer'
import { ToolBox } from './ToolBox'
import type { ToolDefinition, ToolOptions, ToolResult } from './tool'
import { createToolBox, OUTPUT_PLACEHOLDER, type ToolBox as Panel, type ToolBoxHost } from './store'

/**
 * 工具箱浮层的测试：DOM 与 `createToolBox` 之间的接线。
 *
 * 状态机那一半（换工具时清什么留什么、`seq` 怎么作废在飞的那一次、防抖、上限）在
 * `./store.test.ts` 里钉过了，描述符的收窄与分组在 `./tool.test.ts`。这里测六件事：
 * **画出来的东西对不对**、**点对了地方会不会调到对的方法**、
 * **那五个键落在浮层上分别做什么**、**焦点落在哪一格**、
 * **纯生成器那一个「重新生成」按钮会不会真的再跑一次**、
 * **文字格为什么用 `input` 事件而初值是非响应式的**。
 *
 * 🔴 本文件最要紧的一条是「选项格被拒绝之后 DOM 会不会被拉回来」。那不是一个样式问题：
 * `setOption` 收窄失败时故意不动 signal，而 signal 不动就意味着 Solid 不重渲染，
 * 于是格子会停在用户刚打的 `999` 上——屏幕上 999、`run` 收到 8。这一条只能在 DOM 层钉。
 *
 * ⚠️ 有些东西这里钉不住，都得在真实窗口里看：浮层该多大（880×560）、左栏 190px 够不够放
 * 「JSON 格式化」这一类名字、两格并排时各自多宽、选项条换行之后头部会不会被推下去、
 * 压暗背景之后与 `.modal-backdrop` 叠在一起是什么样子。jsdom 里没有布局。
 */

/** 手动挡的时钟：`ToolBoxInit.timer` 是注入点，所以不碰全局时钟（同 `./store.test.ts`） */
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
    fire() {
      const due = [...scheduled.entries()]
      scheduled.clear()
      for (const [, fn] of due) fn()
    },
    pending: () => scheduled.size,
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 放掉在飞的防抖，并等 `run` 真的被调到（它包在一层 `Promise.resolve` 里） */
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

const ECHO = def('tool.echo', { name: 'Echo' })
const UPPER = def('tool.upper', {
  name: 'Upper',
  category: 'format',
  run: (t) => ({ kind: 'ok', text: t.toUpperCase() }),
})
const OPTS = def('tool.opts', {
  name: 'Opts',
  category: 'encode',
  options: [
    { kind: 'toggle', key: 'flag', label: '开关', default: true },
    { kind: 'select', key: 'mode', label: '模式', choices: ['a', 'b'], default: 'a' },
    { kind: 'number', key: 'indent', label: '缩进', min: 2, max: 8, default: 2 },
  ],
  run: (_text, options) => ({ kind: 'ok', text: JSON.stringify(options) }),
})
/** 没有输入格的那一类（UUID 生成器）。它同时也是「焦点该落到过滤框」的那一类 */
const NONE = def('tool.gen', {
  name: 'Gen',
  category: 'generate',
  input: 'none',
  run: () => ({ kind: 'ok', text: '生成好了' }),
})

/**
 * 带一个**文字格**的工具（M3-B-5 的正则测试器就是这一类）。`run` 把收到的值原样回显，
 * 于是「打进去的字有没有真的传到 `run`」这一件事能直接看输出格
 */
const TXT = def('tool.txt', {
  name: 'Txt',
  options: [{ kind: 'text', key: 'pat', label: '正则', default: 'ab?' }],
  run: (_t, o) => ({ kind: 'ok', text: `[${String(o.pat ?? '')}]` }),
})

let container: HTMLDivElement
let panel: Panel
let clock: ReturnType<typeof fakeTimer>
let readEditor: Mock<() => string | null>
let writeEditor: Mock<(text: string) => boolean>
let copy: Mock<(text: string) => boolean | Promise<boolean>>
/** `createToolBox` 里有 `createMemo`；不在 root 里建，它们永远不会被释放 */
let disposePanel: (() => void) | undefined
let disposeRender: (() => void) | undefined

function mount(tools: readonly ToolDefinition[] = [ECHO, UPPER], overrides: Partial<ToolBoxHost> = {}): Panel {
  const host: ToolBoxHost = { readEditor: () => '正文', writeEditor: () => true, copy: () => true, ...overrides }
  readEditor = vi.fn(host.readEditor)
  writeEditor = vi.fn(host.writeEditor)
  copy = vi.fn(host.copy)
  clock = fakeTimer()
  const commands = createCommandRegistry({ getContext: () => ({ editor: null }) })
  disposePanel = createRoot((teardown) => {
    panel = createToolBox({
      commands,
      tools,
      host: { readEditor, writeEditor, copy },
      timer: clock.timer,
    })
    return teardown
  })
  disposeRender = render(() => <ToolBox box={panel} />, container)
  return panel
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  disposeRender?.()
  disposePanel?.()
  disposeRender = undefined
  disposePanel = undefined
  container.remove()
})

/* ---------- DOM 读取口 ---------- */

function must<T extends Element>(selector: string): T {
  const el = container.querySelector<T>(selector)
  if (!el) throw new Error(`找不到 ${selector}`)
  return el
}

const backdrop = () => must<HTMLElement>('.toolbox-backdrop')
const filterEl = () => must<HTMLInputElement>('.toolbox-filter')
const rowEls = () => [...container.querySelectorAll<HTMLElement>('.toolbox-row')]
const groupEls = () => [...container.querySelectorAll<HTMLElement>('.toolbox-group')]
const current = () => must<HTMLElement>('.toolbox-current')
const foot = () => must<HTMLElement>('.toolbox-foot')
const status = () => must<HTMLElement>('.toolbox-status')
const notice = () => container.querySelector<HTMLElement>('.toolbox-notice')
const badEl = () => container.querySelector<HTMLElement>('.toolbox-bad')
const emptyEls = () => [...container.querySelectorAll<HTMLElement>('.toolbox-empty')]

/** 输入格。`input: 'none'` 的工具没有这一格，那时它返回 null。
 *  ⚠️ 靠 `.input` 这一档认它，不靠「第一个 pane」：没有输入格时输出格就成了第一个 */
function inputEl(): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>('.toolbox-text.input')
}

function outputEl(): HTMLTextAreaElement {
  return must<HTMLTextAreaElement>('.toolbox-text.output')
}

function optionEls(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.toolbox-option')]
}

/**
 * 那一排动作按钮，顺序就是画出来的顺序：
 * 重新生成（只在 `input: 'none'` 的时候出现）/ 跳到出错处（只在报了位置的时候出现）/
 * 从编辑器取 / 复制结果 / 插回编辑器。
 *
 * ⚠️ 所以按下标取的那几条用例必须先确认这一次的工具**吃输入**、并且结果里没有位置可跳，
 * 否则 `[0]` 拿到的是那两个之一而不是「从编辑器取」。
 * 前两个是互斥的（一个要 `input: 'none'`、一个要输入格），所以最多只会出现一个
 */
function actionEls(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.toolbox-actions button')]
}

/* ---------- 事件口 ---------- */

/** ⚠️ `onChange` 在 Solid 里对应的是原生 `change`，不是 `input`（实测，见文件头那条 🔴） */
function typeIn(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function changeTo(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function check(el: HTMLInputElement, checked: boolean) {
  el.checked = checked
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function key(el: Element, init: KeyboardEventInit) {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

/** 展开并等在飞的渲染与首跑落地 */
async function open(id?: string) {
  panel.show(id)
  await flush()
}

describe('画出来什么', () => {
  it('收起时整块都不在 DOM 上', () => {
    mount()
    expect(container.querySelector('.toolbox-backdrop')).toBeNull()
    expect(panel.visible()).toBe(false)
  })

  it('左栏按分类分组，标题与工具都在', async () => {
    mount([ECHO, UPPER])
    await open()
    expect(groupEls().map((el) => el.textContent)).toEqual(['格式化', '文本'])
    expect(rowEls().map((el) => el.textContent)).toEqual(['Upper', 'Echo'])
  })

  it('分类标题不是候选，所以没有 option 语义', async () => {
    mount()
    await open()
    expect(groupEls()[0]?.getAttribute('role')).toBe('presentation')
    expect(rowEls()[0]?.getAttribute('role')).toBe('option')
    expect(rowEls()[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('选中行只有一个，就是 store 里那个 cursor', async () => {
    mount()
    await open()
    expect(
      rowEls()
        .filter((el) => el.classList.contains('selected'))
        .map((el) => el.textContent),
    ).toEqual(['Upper'])
    panel.moveCursor(1)
    await flush()
    expect(
      rowEls()
        .filter((el) => el.classList.contains('selected'))
        .map((el) => el.textContent),
    ).toEqual(['Echo'])
  })

  it('头部说出当前工作台上的工具名', async () => {
    mount()
    await open()
    expect(current().textContent).toBe('Upper')
    expect(must<HTMLElement>('.toolbox-title').textContent).toBe('工具箱')
    expect(must<HTMLElement>('.toolbox').getAttribute('role')).toBe('dialog')
  })

  it('页脚是 store 那一句', async () => {
    mount()
    await open()
    expect(status().textContent).toBe('还没跑')
  })

  it('输出格没跑过时显示占位句，并带上 placeholder 那一档', async () => {
    mount()
    await open()
    expect(outputEl().value).toBe(OUTPUT_PLACEHOLDER)
    expect(outputEl().classList.contains('placeholder')).toBe(true)
    // ⚠️ 占位句与真结果必须不是一个颜色：一块空白看不出是「还没跑」还是「跑出来是空的」
    expect(outputEl().readOnly).toBe(true)
  })

  it('输入格显示 store 里的输入', async () => {
    mount()
    await open()
    panel.setInput('一段文字')
    await flush()
    expect(inputEl()?.value).toBe('一段文字')
  })

  it('目录是空的：左右两栏都如实说一句', async () => {
    mount([])
    await open()
    expect(rowEls()).toEqual([])
    expect(emptyEls().map((el) => el.textContent)).toEqual(['工具箱还是空的', '还没有工具'])
    expect(status().textContent).toBe('工具箱还是空的')
    expect(inputEl()).toBeNull()
    expect(container.querySelector('.toolbox-text.output')).toBeNull()
  })

  it('过滤没有匹配时说的是「没有匹配」，不是「工具箱是空的」', async () => {
    mount()
    await open()
    panel.setFilter('zzz')
    await flush()
    expect(emptyEls().map((el) => el.textContent)).toEqual(['没有匹配「zzz」的工具'])
  })
})

describe('点哪儿调什么', () => {
  it('点一行就把那个工具搬上工作台', async () => {
    mount()
    await open()
    rowEls()[1]?.click()
    await flush()
    expect(current().textContent).toBe('Echo')
  })

  it('🔴 悬停只挪高亮，不换工作台上的工具', async () => {
    mount()
    await open()
    rowEls()[1]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await flush()
    // 悬停就换工具的话，鼠标扫过左栏一路会把每个工具都跑一遍
    expect(rowEls()[1]?.classList.contains('selected')).toBe(true)
    expect(current().textContent).toBe('Upper')
  })

  it('点遮罩空白处收起，点浮层内部不收起', async () => {
    mount()
    await open()
    must<HTMLElement>('.toolbox').click()
    await flush()
    expect(panel.visible()).toBe(true)
    backdrop().click()
    await flush()
    expect(panel.visible()).toBe(false)
    expect(container.querySelector('.toolbox-backdrop')).toBeNull()
  })

  it('× 收起', async () => {
    mount()
    await open()
    const close = must<HTMLButtonElement>('.toolbox-close')
    expect(close.getAttribute('aria-label')).toBe('关闭工具箱')
    close.click()
    await flush()
    expect(panel.visible()).toBe(false)
  })

  it('三个动作按钮各调 store 里对应的那一个', async () => {
    mount([UPPER])
    await open()
    panel.setInput('hi')
    await fire()
    await flush()
    const [take, copyBtn, insert] = actionEls()
    take?.click()
    await flush()
    expect(readEditor).toHaveBeenCalled()
    copyBtn?.click()
    await flush()
    expect(copy).toHaveBeenCalledWith('HI')
    insert?.click()
    await flush()
    expect(writeEditor).toHaveBeenCalledWith('HI')
    // 插完就关：那块浮层盖住的正是刚插进去的那些字
    expect(panel.visible()).toBe(false)
  })

  it('没有可复制的输出时那两个按钮是 disabled 的', async () => {
    mount()
    await open()
    const [, copyBtn, insert] = actionEls()
    expect(copyBtn?.disabled).toBe(true)
    expect(insert?.disabled).toBe(true)
    copyBtn?.click()
    expect(copy).not.toHaveBeenCalled()
  })

  it('input: none 的工具不画输入格，也不画「从编辑器取」', async () => {
    mount([NONE])
    await open()
    expect(inputEl()).toBeNull()
    expect(outputEl()).not.toBeNull()
    expect(actionEls().map((el) => el.textContent)).toEqual(['重新生成', '复制结果', '插回编辑器'])
    expect(readEditor).not.toHaveBeenCalled()
  })
})

describe('打字与按键', () => {
  it('输入格里打字会跑到工具那儿', async () => {
    const run = vi.fn<(text: string, options: ToolOptions) => ToolResult>((text) => ({
      kind: 'ok',
      text: `《${text}》`,
    }))
    mount([def('tool.run', { name: 'Run', run })])
    await open()
    typeIn(inputEl() as HTMLTextAreaElement, 'abc')
    // 防抖：连着打不该每键都跑
    expect(run).not.toHaveBeenCalled()
    await fire()
    expect(run).toHaveBeenLastCalledWith('abc', {})
    expect(outputEl().value).toBe('《abc》')
    expect(outputEl().classList.contains('placeholder')).toBe(false)
  })

  it('过滤框里打字只改左栏', async () => {
    mount()
    await open()
    typeIn(filterEl(), 'Echo')
    await flush()
    expect(rowEls().map((el) => el.textContent)).toEqual(['Echo'])
    expect(groupEls().map((el) => el.textContent)).toEqual(['文本'])
    // ⛔ 过滤不该动工作台上的工具
    expect(current().textContent).toBe('Upper')
  })

  it('过滤框上 ↑↓ 移动高亮，Enter 打开', async () => {
    mount()
    await open()
    key(filterEl(), { key: 'ArrowDown' })
    await flush()
    expect(rowEls()[1]?.classList.contains('selected')).toBe(true)
    expect(current().textContent).toBe('Upper')
    key(filterEl(), { key: 'Enter' })
    await flush()
    expect(current().textContent).toBe('Echo')
  })

  it('↑↓ 在输入格里是文本光标的事，不改高亮', async () => {
    mount()
    await open()
    key(inputEl() as HTMLTextAreaElement, { key: 'ArrowDown' })
    await flush()
    expect(rowEls()[0]?.classList.contains('selected')).toBe(true)
  })

  it('Escape 收起，不管焦点在哪一格', async () => {
    mount()
    await open()
    key(inputEl() as HTMLTextAreaElement, { key: 'Escape' })
    await flush()
    expect(panel.visible()).toBe(false)
  })

  it('Cmd+Enter 立刻跑一次，丢掉在飞的防抖', async () => {
    const run = vi.fn<(text: string, options: ToolOptions) => ToolResult>((text) => ({ kind: 'ok', text }))
    mount([def('tool.run', { name: 'Run', run })])
    await open()
    typeIn(inputEl() as HTMLTextAreaElement, 'x')
    expect(clock.pending()).toBe(1)
    key(backdrop(), { key: 'Enter', metaKey: true })
    expect(clock.pending()).toBe(0)
    await flush()
    expect(run).toHaveBeenLastCalledWith('x', {})
  })

  it('光按 Enter 不跑工具，也不收起浮层', async () => {
    mount()
    await open()
    key(backdrop(), { key: 'Enter' })
    await flush()
    expect(panel.visible()).toBe(true)
  })
})

describe('选项条', () => {
  it('三种选项各画成对应的控件', async () => {
    mount([OPTS])
    await open()
    const [toggle, select, number] = optionEls()
    expect(toggle?.querySelector('input')?.type).toBe('checkbox')
    expect(toggle?.querySelector('input')?.checked).toBe(true)
    expect(toggle?.textContent).toBe('开关')
    const choices = [...(select?.querySelectorAll('option') ?? [])]
    expect(choices.map((el) => el.textContent)).toEqual(['a', 'b'])
    expect((select?.querySelector('select') as HTMLSelectElement).value).toBe('a')
    const num = number?.querySelector('input') as HTMLInputElement
    expect(num.type).toBe('number')
    expect(num.min).toBe('2')
    expect(num.max).toBe('8')
    expect(num.value).toBe('2')
  })

  it('改选项会跑到工具那儿，值也真的传进去了', async () => {
    mount([OPTS])
    await open()
    const num = optionEls()[2]?.querySelector('input') as HTMLInputElement
    changeTo(num, '4')
    await fire()
    expect(outputEl().value).toContain('"indent":4')
    expect(num.value).toBe('4')
    expect(badEl()).toBeNull()
  })

  it('🔴 被拒绝的值不会留在格子里', async () => {
    mount([OPTS])
    await open()
    const num = optionEls()[2]?.querySelector('input') as HTMLInputElement
    changeTo(num, '999')
    await flush()
    // signal 不动 → Solid 不重渲染 → 不拉回来的话屏幕上会一直写着 999，而 `run` 收到 8
    expect(num.value).toBe('2')
    expect(badEl()?.textContent).toBe('缩进要在 2…8 之间')
    expect(panel.options().indent).toBe(2)
  })

  it('select 与 checkbox 同样被拉回来', async () => {
    mount([OPTS])
    await open()
    const sel = optionEls()[1]?.querySelector('select') as HTMLSelectElement
    changeTo(sel, 'b')
    await flush()
    expect(sel.value).toBe('b')
    const box = optionEls()[0]?.querySelector('input') as HTMLInputElement
    check(box, false)
    await flush()
    expect(box.checked).toBe(false)
    expect(panel.options()).toEqual({ flag: false, mode: 'b', indent: 2 })
  })

  it('换工具之后选项条换成新工具的那一套', async () => {
    mount([OPTS, ECHO])
    await open('tool.opts')
    expect(optionEls()).toHaveLength(3)
    panel.openTool('tool.echo')
    await flush()
    expect(optionEls()).toEqual([])
    expect(container.querySelector('.toolbox-options')).toBeNull()
  })
})

/**
 * 文字格（`kind: 'text'`，M3-B-5a 新加的那一种）。
 *
 * 🔴 这一组里最要紧的是「Solid 一次都不碰 `.value`」那一条，而它**不能**写成插入点断言。
 * 实测 jsdom 的行为是：给 `.value` 写一个**不同**的串会把插入点甩到末尾（`1,1` → `3,3`），
 * 写一个**相同**的串则一动不动。而响应式绑定恰恰会写相同的那一串（store 刚收下用户打的字），
 * 所以「插入点没动」在 jsdom 里无论怎么写都是绿的——一条钉不住任何东西的断言。
 * 换成数 setter 的调用次数就分得开了，实测：`value={sig()}` → **1** 次，
 * `value={option.default}`（现在这一份）→ **0** 次。
 *
 * ⚠️ 真机上要验的是 WebKit 给一个正在打字的格子写**相同**的 `.value` 会不会也甩插入点。
 * 那正是 `ToolBox.tsx` 里 `commitInput` 只在**被拒绝**时才写回、而初值不读 store 的原因
 */
describe('文字格（kind: text）', () => {
  /** 那一格的 `<input>`。M3-B-5 的正则测试器有**三**个文字格，这里只有第一个 */
  function patEl(): HTMLInputElement {
    return optionEls()[0]?.querySelector('input') as HTMLInputElement
  }

  it('画成 <input type="text">，初值是描述符里的 default，并且关掉拼写检查', async () => {
    mount([TXT])
    await open()
    const el = patEl()
    expect(el.type).toBe('text')
    expect(el.value).toBe('ab?')
    // ⚠️ 断言的是**属性**而不是 `el.spellcheck`：jsdom 没实现那个 IDL 属性（实测读出来是
    // `undefined`），而属性确实是 `"false"`。真机上要看的是有没有红色波浪线，那是人工项
    expect(el.getAttribute('spellcheck')).toBe('false')
  })

  it('🔴 走 input 事件：不用失焦就重跑', async () => {
    mount([TXT])
    await open()
    typeIn(patEl(), 'a+')
    await fire()
    expect(outputEl().value).toBe('[a+]')
    expect(panel.options()).toEqual({ pat: 'a+' })
  })

  it('🔴 只发 change 的话 store 一个字都不动——这一格靠的不是失焦', async () => {
    mount([TXT])
    await open()
    changeTo(patEl(), 'a+')
    await fire()
    expect(outputEl().value).toBe('[ab?]')
    expect(panel.options()).toEqual({ pat: 'ab?' })
    // ⚠️ 这一条里 DOM 的 `.value` 会停在测试刚写进去的 `a+` 上，看着像没被拉回来。
    // 浏览器里到不了这一幕：`change` 永远跟在 `input` 后面，而 `input` 已经把它收下了
  })

  it('清空也算一次合法输入（不像 number 那一格：空串会被拒）', async () => {
    mount([TXT])
    await open()
    typeIn(patEl(), '')
    await fire()
    expect(panel.options()).toEqual({ pat: '' })
    expect(outputEl().value).toBe('[]')
    expect(badEl()).toBeNull()
  })

  it('🔴 打字期间 Solid 一次都不碰 .value', async () => {
    mount([TXT])
    await open()
    const el = patEl()
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    let writes = 0
    Object.defineProperty(el, 'value', {
      get: () => proto.get!.call(el) as string,
      set: (v: string) => {
        writes++
        proto.set!.call(el, v)
      },
    })
    // ⚠️ 测试自己那一下写值要绕过计数器，否则数到的是自己
    proto.set!.call(el, 'axb?')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await fire()
    expect(outputEl().value).toBe('[axb?]')
    expect(writes).toBe(0)

    // 🔴 对照组：同一套探针钉在一个**响应式**绑定上，必须数到 1 次。少了这一半，
    // 上面那个 `0` 也可能只是探针压根没接上——那这条用例就绿得毫无意义
    const [sig, setSig] = createSignal('x')
    const control = document.createElement('div')
    document.body.appendChild(control)
    const disposeControl = render(() => <input type="text" value={sig()} />, control)
    const controlEl = control.querySelector('input')!
    let controlWrites = 0
    Object.defineProperty(controlEl, 'value', {
      get: () => proto.get!.call(controlEl) as string,
      set: (v: string) => {
        controlWrites++
        proto.set!.call(controlEl, v)
      },
    })
    setSig('y')
    expect(controlWrites).toBe(1)
    disposeControl()
    control.remove()
  })

  it('🔴 切走再切回来，格子回到 default —— 这正是「初值可以非响应式」的前提', async () => {
    mount([TXT, ECHO])
    await open('tool.txt')
    typeIn(patEl(), 'zzz')
    await fire()
    panel.openTool('tool.echo')
    await flush()
    panel.openTool('tool.txt')
    await flush()
    expect(patEl().value).toBe('ab?')
    expect(panel.options()).toEqual({ pat: 'ab?' })
  })
})

describe('页脚与提示', () => {
  it('跑的时候页脚带上 busy 那一档', async () => {
    let release: ((value: ToolResult) => void) | undefined
    const run = vi.fn<(text: string, options: ToolOptions) => Promise<ToolResult>>(
      () => new Promise<ToolResult>((resolve) => void (release = resolve)),
    )
    mount([def('tool.slow', { name: 'Slow', run })])
    await open()
    await fire()
    expect(foot().classList.contains('busy')).toBe(true)
    expect(status().textContent).toBe('正在运行…')
    release?.({ kind: 'ok', text: '好了' })
    await flush()
    expect(foot().classList.contains('busy')).toBe(false)
    expect(status().textContent).toContain('→ 2 字符')
  })

  it('错误落在输出格里而不是页脚上，并带上 error 那一档', async () => {
    mount([def('tool.bad', { name: 'Bad', run: () => ({ kind: 'error', text: '第 3 行第 7 列多了一个逗号' }) })])
    await open()
    await fire()
    // JSON 的报错要说清是哪一行哪一列，那是一段要读的文字，不是一句提示
    expect(outputEl().value).toBe('第 3 行第 7 列多了一个逗号')
    expect(outputEl().classList.contains('error')).toBe(true)
    expect(outputEl().classList.contains('placeholder')).toBe(false)
    expect(notice()).toBeNull()
    expect(status().textContent).toContain('没跑出结果')
  })

  it('面板自己的一句话与选项错话是两个槽位', async () => {
    mount([OPTS], { readEditor: () => null })
    await open()
    actionEls()[0]?.click()
    await flush()
    expect(notice()?.textContent).toBe('现在没有打开的文档')
    const num = optionEls()[2]?.querySelector('input') as HTMLInputElement
    changeTo(num, '999')
    await flush()
    // 混成一句的话，这两条会互相盖掉
    expect(badEl()?.textContent).toBe('缩进要在 2…8 之间')
    expect(notice()?.textContent).toBe('现在没有打开的文档')
  })

  it('复制成功之后页脚说复制了多少个字符', async () => {
    mount([UPPER])
    await open()
    panel.setInput('abc')
    await fire()
    await flush()
    actionEls()[1]?.click()
    await flush()
    expect(notice()?.textContent).toBe('已复制 3 个字符')
  })
})

describe('焦点', () => {
  it('有输入格的工具，焦点落在输入格', async () => {
    mount()
    await open()
    expect(document.activeElement).toBe(inputEl())
  })

  it('没有输入格的工具，焦点落在过滤框', async () => {
    mount([NONE])
    await open()
    expect(document.activeElement).toBe(filterEl())
  })

  it('浮层已经开着时再展开一次，焦点也抢得回来', async () => {
    mount()
    await open()
    filterEl().focus()
    expect(document.activeElement).toBe(filterEl())
    await open()
    expect(document.activeElement).toBe(inputEl())
  })

  it('点了左栏另一个工具，焦点跟着走进输入格', async () => {
    mount()
    await open()
    filterEl().focus()
    rowEls()[1]?.click()
    await flush()
    expect(document.activeElement).toBe(inputEl())
  })
})

/**
 * 「跳到出错处」（M3-B-2）。
 *
 * 这一组钉的是 `ToolResult.at` 那一个可选字段与 DOM 之间的接线：给了它才画按钮、
 * 点它才把选区落到**出错那一行**、焦点交回输入格。位置怎么算出来的在 `json.test.ts`，
 * 一整行的范围怎么取的在 `tool.test.ts` 的 `lineBoundsAt`——这一层只管那根线接没接上。
 */
describe('跳到出错处', () => {
  /** 一个**总会**报错、并且报出位置的工具。JSON 工具就是这么报的 */
  const POS = def('tool.pos', {
    name: 'Pos',
    run: (text) => ({ kind: 'error', text: `错在 ${text.length}`, at: Math.max(0, text.length - 1) }),
  })
  /** 报错但**不报位置**：面板不该凭空画一个按了没反应的按钮 */
  const NOPOS = def('tool.nopos', { name: 'NoPos', run: () => ({ kind: 'error', text: '出错了' }) })
  /** `input: 'none'` 的那一类。它压根没有输入格，于是那个按钮也无从谈起 */
  const NONEPOS = def('tool.gen2', {
    name: 'GenPos',
    category: 'generate',
    input: 'none',
    run: () => ({ kind: 'error', text: '出错了', at: 0 }),
  })

  const jumpBtn = (): HTMLButtonElement | null => actionEls().find((el) => el.textContent === '跳到出错处') ?? null

  it('成功而**没给位置**的时候不画——那一排里「复制结果」与「插回编辑器」才是按得动的', async () => {
    // ⚠️ 只装 ECHO 一个：默认的 `[ECHO, UPPER]` 里先被选中的其实是 UPPER，
    // 因为左栏按分类排而 `format` 在 `text` 前面（`tool.ts` 的 `CATEGORY_ORDER`）
    // 🔴 「成功的时候不画」这句话在 M3-B-5 之后**不再成立**：正则测试器成功时也带 `at`，
    // 那一份见下面「跳到第一处」那一组。这一条钉的只是「没给 `at` 就不画」
    mount([ECHO])
    await open()
    typeIn(inputEl()!, 'x')
    await fire()
    expect(outputEl().value).toBe('x')
    expect(outputEl().classList.contains('error')).toBe(false)
    expect(jumpBtn()).toBeNull()
  })

  it('🔴 报错了但工具没给位置，也不画', async () => {
    // ⛔ 不从错误那句话里用正则抠一个行号出来：那句话是给人读的，措辞随工具变。
    // 画一个按钮、点下去发现算不出位置，就是这个代码库一路在躲的「点了没反应」
    mount([NOPOS])
    await open()
    await fire()
    expect(outputEl().classList.contains('error')).toBe(true)
    expect(jumpBtn()).toBeNull()
  })

  it('工具给了位置就画，而且排在最前面', async () => {
    mount([POS])
    await open()
    typeIn(inputEl()!, 'abc')
    await fire()
    expect(outputEl().classList.contains('error')).toBe(true)
    expect(actionEls().map((el) => el.textContent)).toEqual(['跳到出错处', '从编辑器取', '复制结果', '插回编辑器'])
  })

  it('点它把输入格的选区落到出错那一行，焦点也交回去', async () => {
    mount([POS])
    await open()
    typeIn(inputEl()!, 'abc\ndef\nghi')
    await fire()
    // `at` = 长度减一 = 10，落在第三行（`ghi`）上
    expect(jumpBtn()).not.toBeNull()
    filterEl().focus()

    jumpBtn()!.click()
    await flush()

    expect(document.activeElement).toBe(inputEl())
    // 选的是**一整行**，不是一个光标位置：选中之后那一行在格子里是亮着的
    expect(inputEl()!.selectionStart).toBe(8)
    expect(inputEl()!.selectionEnd).toBe(11)
  })

  it('没有输入格的工具即使带了位置也不画', async () => {
    mount([NONEPOS])
    await open()
    await fire()
    expect(inputEl()).toBeNull()
    expect(jumpBtn()).toBeNull()
  })

  it('输入改了之后位置跟着改，⛔ 不停在上一次那一行', async () => {
    // `jumpTarget` 读的是 `box.input()` 与 `box.result()` 两个信号，
    // 于是它跟着最新那一次的结果走。少了这个依赖的话，第二次点会把选区放回第一次那一行
    mount([POS])
    await open()
    typeIn(inputEl()!, 'abc\ndef\nghi')
    await fire()
    typeIn(inputEl()!, 'x')
    await fire()

    jumpBtn()!.click()
    await flush()

    expect(inputEl()!.selectionStart).toBe(0)
    expect(inputEl()!.selectionEnd).toBe(1)
  })
})

/**
 * 「跳到第一处」（M3-B-5）。
 *
 * 🔴 `ToolResult.at` 在 M3-B-2 时是**错误专属**的，那一份假设在这一里程碑被拆掉了：
 * 正则测试器成功的时候也要给一个下标（第一处匹配），否则那份「匹配 N 处」的报告
 * 只能靠用户自己在输入格里翻。于是 `ToolBox.tsx` 里那一个 memo 从 `errorSelection`
 * 改名叫 `jumpTarget`，而按钮的文字跟着 `kind` 走。
 *
 * ⛔ 成功的结果上不能写「跳到出错处」——那是一句自相矛盾的话，而它正是
 * 「画一个按下去与屏幕上写的不是同一件事的按钮」那一类失败
 */
describe('跳到第一处（成功的结果也能带位置）', () => {
  /**
   * 一个**成功**、并且给出一个下标的工具。正则测试器就是这么给的。
   *
   * ⚠️ 用 `lastIndexOf` 而不是 `indexOf`：那样位置会落到多行输入的**后面几行**上，
   * 于是「选中的是那一整行」这件事才真的被验到（`indexOf` 在 `ab…` 上恒等于 1，
   * 而第 1 行的范围与「从头选到第一个换行」长得一样，看不出是算出来的还是碰上的）
   */
  const HIT = def('tool.hit', {
    name: 'Hit',
    category: 'test',
    run: (text) => ({ kind: 'ok', text: `找到 ${text.length}`, at: text.lastIndexOf('b') }),
  })

  const firstBtn = (): HTMLButtonElement | null => actionEls().find((el) => el.textContent === '跳到第一处') ?? null

  it('画的是「跳到第一处」，⛔ 不是「跳到出错处」，而输出格不红', async () => {
    mount([HIT])
    await open()
    typeIn(inputEl()!, 'xx b')
    await fire()
    expect(outputEl().classList.contains('error')).toBe(false)
    expect(actionEls().map((el) => el.textContent)).toEqual(['跳到第一处', '从编辑器取', '复制结果', '插回编辑器'])
    expect(firstBtn()).not.toBeNull()
  })

  it('点它把选区落到那一处所在的**一整行**，焦点也交回输入格', async () => {
    mount([HIT])
    await open()
    typeIn(inputEl()!, 'ab\ncd\nbe')
    await fire()
    filterEl().focus()

    // `at` = `lastIndexOf('b')` = 7，落在第三行（`be`）上
    firstBtn()!.click()
    await flush()

    expect(document.activeElement).toBe(inputEl())
    expect(inputEl()!.selectionStart).toBe(6)
    expect(inputEl()!.selectionEnd).toBe(8)
  })
})

/**
 * 「重新生成」那一个按钮（M3-B-4）。
 *
 * 这一组钉的是**它只在纯生成器上出现**。理由与「跳到出错处」那条门控一模一样，
 * 只是方向相反：吃输入的工具输出是**确定的**，给它一个刷新键就是画一个按下去
 * 什么都不会变的按钮。而 UUID 那一类每按一次都该给出新的一批，
 * 没有这个按钮的话用户唯一的办法是关掉浮层再打开一次。
 *
 * ⚠️ 状态机那一半（`runNow` 绕过防抖、`seq` 作废在飞的那一次）在 `./store.test.ts` 里，
 * 这里只问接线：画没画、点了有没有真的再跑一次
 */
describe('重新生成（只给纯生成器）', () => {
  /** 每按一次给出不一样的东西：不这样的话「重跑了」与「没重跑」在输出格上是同一个样子 */
  let rolls = 0
  const DICE = def('tool.dice', {
    name: 'Dice',
    category: 'generate',
    input: 'none',
    run: () => {
      rolls++
      return { kind: 'ok', text: `第 ${rolls} 次` }
    },
  })

  const regenBtn = (): HTMLButtonElement | null => actionEls().find((el) => el.textContent === '重新生成') ?? null

  beforeEach(() => {
    rolls = 0
  })

  it('纯生成器画它，而且排在最前面', async () => {
    mount([DICE])
    await open()
    await fire()
    expect(outputEl().value).toBe('第 1 次')
    expect(actionEls().map((el) => el.textContent)).toEqual(['重新生成', '复制结果', '插回编辑器'])
  })

  it('🔴 吃输入的工具**不**画它', async () => {
    mount([UPPER])
    await open()
    expect(regenBtn()).toBeNull()
  })

  it('点它立刻再跑一次，⛔ 不等那 150 毫秒的防抖', async () => {
    mount([DICE])
    await open()
    await fire()
    expect(outputEl().value).toBe('第 1 次')

    regenBtn()!.click()
    // ⚠️ 这里**没有** `clock.fire()`：`runNow` 走的是 `debounced.now()`，
    // 而那一个绕过定时器。要是接成了普通的 `setInput` 那一条路，这一句就永远等不到
    await flush()
    expect(outputEl().value).toBe('第 2 次')
    expect(rolls).toBe(2)
  })

  it('连着点三次就是三批，⛔ 不会被在飞的那一次盖掉', async () => {
    mount([DICE])
    await open()
    await fire()
    for (let i = 0; i < 3; i++) {
      regenBtn()!.click()
      await flush()
    }
    expect(outputEl().value).toBe('第 4 次')
  })
})
