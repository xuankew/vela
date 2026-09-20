// @vitest-environment jsdom
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * 只读分片面板的测试：DOM 与 `ShardView` 之间的接线。
 *
 * 「窗口 → 该要哪几页」「迟到的响应」「缓存预算」「缺口怎么算」那一半在
 * `./shardView.test.ts` 里钉过了，这里测四件事：**渲染出来的行对不对**、
 * **滚动与量高有没有真的喂回 store**、**`jumpTo` 有没有落到 DOM 的滚动条上**、
 * 以及 🔴 **卸载时不能 dispose 那个视图**。
 *
 * 最后一条是这一层最容易被「顺手改对」的一条：`EditorPane` 就在 `onCleanup` 里收尾，
 * 照着抄一遍，切一次标签再切回来就只剩一个死视图（fd 已经关了，读页一律回 null），
 * 而所有功能测试照样全绿——因为它只在「切走再切回」这条路上发作。
 *
 * ⚠️ 这里钉不住的：18px 一屏放得下多少行、滚动顺不顺、行号槽在七八位数时对得齐不齐、
 * 长行省略号断在哪儿。jsdom 没有布局引擎，`clientHeight` 恒为 0，于是窗口永远只有
 * `OVERSCAN` 行——那些只能在看得到像素的地方判断。
 */

import type { ShardHeader } from '../ipc/shard'
import { GAP_TEXT, SHARD_ROW_HEIGHT, type ShardRow, type ShardView } from './shardView'
import { ShardPane } from './ShardPane'

const HEADER: ShardHeader = {
  totalLines: 100_000,
  bytes: 12_345_678,
  encoding: 'utf8',
  bom: false,
  eol: 'lf',
  lossy: false,
}

function row(line: number, text: string, overrides: Partial<ShardRow> = {}): ShardRow {
  return { line, kind: 'text', text, clipped: false, lossy: false, ...overrides }
}

interface Fake {
  view: ShardView
  /** 组件**不该**调它。留着就是为了钉住「它没被调」 */
  dispose: Mock<() => void>
  scroll: Mock<(scrollTop: number, viewportHeight: number) => void>
  gotoLine: Mock<(line: number) => number>
  setRows(rows: ShardRow[]): void
  setBusy(busy: boolean): void
  setError(text: string | null): void
  setOffsetY(value: number): void
  setTotalHeight(value: number): void
  setJump(value: { top: number } | null): void
}

/**
 * 假分片视图。
 *
 * ⚠️ 与 `document.test.ts` 里那个只有 `dispose` 的替身不是一回事：这一份要**真的驱动界面**，
 * 所以每个访问器都是一个真信号。`createSignal` 不建 computation，
 * 于是它不需要包在 `createRoot` 里（那条 stderr 警告只针对 `createMemo` / `createEffect`）
 */
function fakeView(overrides: Partial<ShardHeader> = {}): Fake {
  const [rows, setRows] = createSignal<ShardRow[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [offsetY, setOffsetY] = createSignal(0)
  const [totalHeight, setTotalHeight] = createSignal(0)
  const [jumpTo, setJump] = createSignal<{ top: number } | null>(null)
  const dispose = vi.fn<() => void>()
  const scroll = vi.fn<(scrollTop: number, viewportHeight: number) => void>()
  const gotoLine = vi.fn<(line: number) => number>().mockReturnValue(0)
  const view: ShardView = {
    header: { ...HEADER, ...overrides },
    totalLines: overrides.totalLines ?? HEADER.totalLines,
    rows,
    offsetY,
    totalHeight,
    busy,
    error,
    scroll,
    jumpTo,
    gotoLine,
    dispose,
  }
  return { view, dispose, scroll, gotoLine, setRows, setBusy, setError, setOffsetY, setTotalHeight, setJump }
}

let container: HTMLDivElement
let disposeRender: (() => void) | undefined

function mount(view: ShardView, onFocus?: () => void): void {
  disposeRender = render(() => <ShardPane view={view} onFocus={onFocus} />, container)
}

const pane = (): HTMLElement => container.querySelector('.shard-pane') as HTMLElement
const scrollEl = (): HTMLElement => container.querySelector('.shard-scroll') as HTMLElement
const spacer = (): HTMLElement => container.querySelector('.shard-spacer') as HTMLElement
const winEl = (): HTMLElement => container.querySelector('.shard-window') as HTMLElement
const rowEls = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.shard-row')]
const rowTexts = (): string[] => rowEls().map((el) => el.querySelector('.shard-text')?.textContent ?? '')
const lineNos = (): string[] => rowEls().map((el) => el.querySelector('.shard-lineno')?.textContent ?? '')
const head = (): HTMLElement => container.querySelector('.shard-head') as HTMLElement

/** 排空微任务队列（与 FindInFiles.test.tsx 同一套路：`Promise.resolve()` 的次数要靠猜） */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * jsdom 没有布局引擎：`clientHeight` 恒为 0，`scrollTop` 的赋值是空操作。
 * 两个都换成自己的读写口，并把**每一次赋值**按顺序记下来——
 * 「同一个 top 连跳两次也要真的写两次」那条用例只有靠这份流水账才看得见，
 * 而数次数会把「组件写了一次」与「测试自己 scrollTo 写了一次」混成一个数
 */
function fakeBox(el: HTMLElement, height: number): { writes: () => number[] } {
  let top = 0
  const writes: number[] = []
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
      writes.push(v)
    },
  })
  return { writes: () => writes }
}

/** 滚到某个位置并派发事件（`onScroll` 读的是 `currentTarget.scrollTop`） */
function scrollTo(top: number): void {
  const el = scrollEl()
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  disposeRender?.()
  disposeRender = undefined
  container.remove()
})

describe('行渲染', () => {
  it('行号是 1 起的，正文按 rows() 的顺序排', () => {
    const fake = fakeView()
    fake.setRows([row(0, '第一行'), row(1, '第二行'), row(41, '第四十二行')])
    mount(fake.view)

    // 🔴 内部一律 0 起，而人读的行号一律 1 起，换算是渲染这一层做的
    // （与搜索结果、`:42` 那两处同一个口径）。差一位的症状是「跳到 42 行看到的是 43 行」
    expect(lineNos()).toEqual(['1', '2', '42'])
    expect(rowTexts()).toEqual(['第一行', '第二行', '第四十二行'])
  })

  it('剪过的行补一个省略号，没剪过的不补', () => {
    const fake = fakeView()
    fake.setRows([row(0, 'x'.repeat(40), { clipped: true }), row(1, '短行')])
    mount(fake.view)

    expect(rowEls()[0]!.querySelector('.shard-clip')?.textContent).toBe('…')
    expect(rowEls()[1]!.querySelector('.shard-clip')).toBeNull()
  })

  it('缺口行带 .gap，文案就是那句交代', () => {
    const fake = fakeView()
    fake.setRows([row(9, GAP_TEXT, { kind: 'gap' })])
    mount(fake.view)

    expect(rowEls()[0]!.classList.contains('gap')).toBe(true)
    expect(rowTexts()).toEqual([GAP_TEXT])
  })

  it('还没读回来的占位行带 .pending', () => {
    const fake = fakeView()
    fake.setRows([row(9, '', { kind: 'pending' })])
    mount(fake.view)

    expect(rowEls()[0]!.classList.contains('pending')).toBe(true)
  })

  it('这一页解码有损时补一个标记，并且把「显示的不是原样」说清楚', () => {
    const fake = fakeView()
    fake.setRows([row(0, '有损', { lossy: true }), row(1, '完好')])
    mount(fake.view)

    const flag = rowEls()[0]!.querySelector('.shard-flag')
    expect(flag?.textContent).toBe('⚠')
    expect(flag?.getAttribute('title')).toContain('不是这个样子')
    expect(rowEls()[1]!.querySelector('.shard-flag')).toBeNull()
  })

  it('rows() 变了就重渲染', async () => {
    const fake = fakeView()
    fake.setRows([row(0, '第一页')])
    mount(fake.view)
    expect(rowTexts()).toEqual(['第一页'])

    fake.setRows([row(128, '第二页甲'), row(129, '第二页乙')])
    await flush()

    expect(lineNos()).toEqual(['129', '130'])
    expect(rowTexts()).toEqual(['第二页甲', '第二页乙'])
  })

  it('一行都没有时窗口是空的，但占位高度照样撑着滚动条', () => {
    const fake = fakeView()
    fake.setTotalHeight(1_800_000)
    mount(fake.view)

    expect(rowEls()).toEqual([])
    expect(spacer().style.height).toBe('1800000px')
  })
})

describe('窗口算术落到 DOM', () => {
  it('占位高度 = totalHeight()，窗口位移 = translateY(offsetY())', async () => {
    const fake = fakeView()
    fake.setTotalHeight(1_800_000)
    fake.setOffsetY(23_400)
    fake.setRows([row(1300, '第 1301 行')])
    mount(fake.view)

    // 🔴 这两个数必须成对：占位撑出滚动条的总长，位移决定这一窗画在哪一段。
    // 只改一个的症状是「滚动条走到底了内容还没到底」，看起来像读盘读漏了
    expect(spacer().style.height).toBe('1800000px')
    expect(winEl().style.transform).toBe('translateY(23400px)')
  })

  it('🔴 行高只有一个真相：注入的 CSS 变量就是 SHARD_ROW_HEIGHT', () => {
    const fake = fakeView()
    mount(fake.view)

    // 样式表里所有 `.shard-row` 的高度都引用这个变量。这里钉住「注入的那一个」，
    // 于是把它改成别的数会同时红掉这一条与 `shardView.test.ts` 里的窗口算术
    expect(pane().style.getPropertyValue('--vela-shard-row-height')).toBe(`${SHARD_ROW_HEIGHT}px`)
  })

  it('滚动容器报得出总行数，用 toLocaleString 那一套（百万行读成 1,200,000）', () => {
    const fake = fakeView({ totalLines: 1_200_000 })
    mount(fake.view)

    expect(scrollEl().getAttribute('aria-label')).toBe('1,200,000 行的只读视图')
  })
})

describe('滚动与量高', () => {
  it('挂载时量一次', async () => {
    const fake = fakeView()
    mount(fake.view)
    await flush()

    // jsdom 里 clientHeight 是 0，于是这一趟报的是 (0, 0)。要的是「它报了」，不是那个数
    expect(fake.scroll).toHaveBeenCalledTimes(1)
    expect(fake.scroll).toHaveBeenCalledWith(0, 0)
  })

  it('onScroll 把 scrollTop 与 clientHeight **一起**递过去', () => {
    const fake = fakeView()
    mount(fake.view)
    fakeBox(scrollEl(), 540)

    scrollTo(1800)

    // ⚠️ 两个参数一起收是这一层与 FindInFiles 唯一的接线差别：
    // 那边滚动位置与视口高度是两个信号，这边的 `scroll(scrollTop, viewportHeight)`
    // 立刻就要用高度做窗口算术。漏掉高度的话每次滚动都按 0 高的视口算，
    // 于是永远只请求 OVERSCAN 行，滚得越快空得越多
    expect(fake.scroll).toHaveBeenLastCalledWith(1800, 540)
  })

  it('窗口 resize 重量一次；卸载之后不再响应', async () => {
    const fake = fakeView()
    mount(fake.view)
    await flush()
    fakeBox(scrollEl(), 540)

    window.dispatchEvent(new Event('resize'))
    expect(fake.scroll).toHaveBeenLastCalledWith(0, 540)

    disposeRender?.()
    disposeRender = undefined
    const before = fake.scroll.mock.calls.length
    window.dispatchEvent(new Event('resize'))
    expect(fake.scroll.mock.calls.length).toBe(before)
  })
})

describe('jumpTo → 滚动条', () => {
  it('把 store 算出来的 top 写到 DOM 上', async () => {
    const fake = fakeView()
    mount(fake.view)
    await flush()
    const box = fakeBox(scrollEl(), 540)

    fake.setJump({ top: 12_345 })
    await flush()

    expect(box.writes()).toEqual([12_345])
    expect(scrollEl().scrollTop).toBe(12_345)
  })

  it('🔴 同一个 top 连跳两次也要真的写两次', async () => {
    const fake = fakeView()
    mount(fake.view)
    await flush()
    const box = fakeBox(scrollEl(), 540)

    fake.setJump({ top: 900 })
    await flush()
    // 用户手动滚走了
    scrollTo(0)
    fake.setJump({ top: 900 })
    await flush()

    // 靠的是「每次一个新对象」：数字信号在第二次不会变，effect 不跑，
    // 界面就一动不动——症状是「点搜索结果没反应，再点一次才有」。
    // 中间那个 0 是测试自己 scrollTo 写进去的，正是「用户滚走了」那一步
    expect(box.writes()).toEqual([900, 0, 900])
    expect(scrollEl().scrollTop).toBe(900)
  })

  it('还没跳过的时候（jumpTo 是 null）一个字都不写', async () => {
    const fake = fakeView()
    mount(fake.view)
    await flush()
    const box = fakeBox(scrollEl(), 540)

    fake.setJump(null)
    await flush()

    expect(box.writes()).toEqual([])
  })
})

describe('只读提示', () => {
  it('常态下说的是那句常驻的交代', () => {
    const fake = fakeView()
    mount(fake.view)

    expect(head().textContent).toContain('只读')
    expect(head().textContent).toContain('不随外部改动刷新')
    expect(container.querySelector('.shard-error')).toBeNull()
  })

  it('正在读时换成「读取中…」，那句常驻的让位', () => {
    const fake = fakeView()
    fake.setBusy(true)
    mount(fake.view)

    expect(container.querySelector('.shard-tail.busy')?.textContent).toBe('读取中…')
    expect(head().textContent).not.toContain('不随外部改动刷新')
  })

  it('报错时错误最要紧，「读取中…」也压下去', () => {
    const fake = fakeView()
    fake.setBusy(true)
    fake.setError('读页失败：文件没了')
    mount(fake.view)

    // 它解释了为什么下面几行是空的，优先级必须高于「正在读」
    expect(container.querySelector('.shard-error')?.textContent).toBe('读页失败：文件没了')
    expect(container.querySelector('.shard-tail')).toBeNull()
    expect(head().textContent).toContain('只读')
  })

  it('⚠️ 头部**不**重复报行数、字节数、编码、换行符——那是状态栏那一排的活', () => {
    const fake = fakeView({ totalLines: 1_200_000, bytes: 104_857_600, encoding: 'gbk', eol: 'crlf' })
    mount(fake.view)

    // 两处各报一份就是两份会各自漂移的真相。行数只在 aria-label 里出现（那是给读屏软件的）
    expect(head().textContent).not.toContain('1,200,000')
    expect(head().textContent).not.toContain('MB')
    expect(head().textContent).not.toContain('GBK')
    expect(head().textContent).not.toContain('CRLF')
  })
})

describe('生命周期', () => {
  it('🔴 卸载**不** dispose：分片的生命周期属于文档，不属于面板', async () => {
    const fake = fakeView()
    mount(fake.view)
    await flush()

    disposeRender?.()
    disposeRender = undefined
    await flush()

    // 照着 `EditorPane` 的 onCleanup 抄一遍，这里就会红。
    // 而运行时它只在「切走再切回来」那条路上发作：fd 已经关了，读页一律回 null，
    // 面板停在最后一次读到的那一屏上不动，看起来像是卡住了
    expect(fake.dispose).not.toHaveBeenCalled()
  })

  it('容器里任何一处 focusin 都报一次聚焦（挂在最外层，靠冒泡）', async () => {
    const fake = fakeView()
    const onFocus = vi.fn()
    mount(fake.view, onFocus)
    await flush()

    // 从滚动容器上派发并让它冒泡：钉住的是「监听挂在 <section> 上」这件事本身。
    // 挂在滚动容器上的话，从别的子节点收到的焦点就报不上去，
    // 于是状态栏继续报**另一块分屏**的行数与字节数
    scrollEl().dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    expect(onFocus).toHaveBeenCalledTimes(1)
  })

  it('onFocus 是可选的：不传也不该炸', async () => {
    const fake = fakeView()
    mount(fake.view)
    await flush()

    expect(() => scrollEl().dispatchEvent(new FocusEvent('focusin', { bubbles: true }))).not.toThrow()
  })
})
