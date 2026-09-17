// @vitest-environment jsdom
import { createRoot } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 底部搜索面板的测试：DOM 与 `createSearchPanel` 之间的接线。
 *
 * 状态机那一半（什么时候去搜、批次放哪、taskId 怎么认领作废）在 `./store.test.ts` 里钉过了，
 * 行扁平化、键盘落点、总账文案与命中段切分在 `./rows.test.ts` 里钉过了。这里测四件事：
 * **渲染出来的东西对不对**、**点对了地方会不会调到对的方法**、
 * **虚拟滚动是不是真的只渲染看得见的那几十行、并且滚动时复用 DOM**、
 * 以及**那五个键与 Esc 落在输入框和落在列表上分别做什么**。
 *
 * 虚拟滚动那条是整段设计的承重墙——结果上限是两万条命中，全部渲染出来是四万个 DOM 节点。
 * 它坏掉的方式不报错：滚动时整棵子树被重建，帧率掉到个位数，而所有功能测试照样全绿。
 *
 * ⚠️ 有些东西这里钉不住，都得在真实窗口里看：面板占掉多少编辑区高度、240px 合不合适、
 * 结果行的省略号断在哪儿、`.find-mark` 与 `.find-opt.on` 的对比度（jsdom 里没有布局，
 * `getBoundingClientRect()` 全是 0）。
 */

/**
 * ⚠️ 桩写了完整的函数签名，不是裸 `vi.fn()`：裸的话 `.mock.calls` 的元素是 `any`，
 * 于是每一处 `calls[0][1].pattern` 都是一次 unsafe member access，而 `pnpm lint` 是门禁。
 * 签名里直接用 `SearchQuery` 是安全的——类型在编译时被擦掉，`vi.hoisted` 的工厂搬到
 * import 之前也不会引用到任何运行时值。
 */
const { ipc } = vi.hoisted(() => ({
  ipc: {
    startSearch: vi.fn<(root: string, query: SearchQuery) => Promise<string>>(),
    cancelSearch: vi.fn<(taskId: string) => Promise<void>>(),
    describeSearchError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
  },
}))

vi.mock('../ipc/search', () => ipc)

import type { MatchRange, SearchFile, SearchHit, SearchQuery, SearchSummary } from '../ipc/search'
import { OVERSCAN } from '../project/tree'
import { FindInFiles } from './FindInFiles'
import { RESULT_ROW_HEIGHT, type HitRow } from './rows'
import { createSearchPanel, type SearchPanel } from './store'

function hit(line: number, text: string, word = 'needle'): SearchHit {
  // 把 `word` 的**每一处**出现都收进来（升序、不重叠），与 Rust 侧的契约一致。
  // 只找第一处的话「一行里多处命中」那条用例根本造不出两个 ranges
  const ranges: MatchRange[] = []
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
    ranges.push({ start: at, end: at + word.length })
  }
  return {
    line,
    text,
    // 一处都没有就交一份空 `ranges`——那正是「命中了但说不清在哪儿」那个分支
    ranges,
    truncated: false,
  }
}

function file(rel: string, texts: string[], truncated = false): SearchFile {
  return { rel, path: `/repo/${rel}`, hits: texts.map((t, i) => hit(i + 1, t)), truncated }
}

const TWO_FILES = [file('src/a.ts', ['let a = needle;', 'let b = needle;']), file('README.md', ['a needle here'])]

function sum(overrides: Partial<SearchSummary> = {}): SearchSummary {
  const base: SearchSummary = {
    filesScanned: 12,
    filesWithHits: 2,
    hits: 3,
    skippedTooLarge: 0,
    unreadable: 0,
    truncated: false,
    cancelled: false,
    elapsedMs: 30,
  }
  return { ...base, ...overrides }
}

/**
 * 够长的结果，专门给虚拟滚动用：22 个文件 × 2 行 = 44 行，滚到中间时窗口两头都还在列表里。
 *
 * ⚠️ 正文里带序号：DOM 复用那条用例按 `textContent` 建 Map，
 * 22 条一模一样的命中行会被压成一条，于是「同一批元素对象」根本没被断言到
 */
function manyFiles(): SearchFile[] {
  return Array.from({ length: 22 }, (_, i) => file(`src/f${String(i).padStart(2, '0')}.ts`, [`const needle = ${i};`]))
}

/** 点击与异步的状态更新都要等一轮微任务与宏任务，才谈得上断言后果 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let container: HTMLDivElement
let panel: SearchPanel
let opened: HitRow[]
/**
 * 当前这一轮的 taskId。⚠️ **每轮自增，不能写死 't1'**：store 会把结束过与作废过的 id
 * 放进 `retired`，第二轮再用同一个 id 的话它的批次会被当成「已作废任务的迟到批次」丢掉，
 * 于是失败的原因在测试里而不在产品里。
 */
let taskId = 't1'
/** `createSearchPanel` 里有 `createMemo`；不在 root 里建，它们永远不会被释放 */
let disposePanel: (() => void) | undefined
let disposeRender: (() => void) | undefined

function mount(): SearchPanel {
  opened = []
  disposePanel = createRoot((teardown) => {
    panel = createSearchPanel({ root: () => '/repo', openHit: async (h) => void opened.push(h) })
    return teardown
  })
  disposeRender = render(() => <FindInFiles panel={panel} />, container)
  return panel
}

/** 起一次搜索并让 taskId 落地。之后推事件都拿它说话 */
async function searchOnce(pattern = 'needle'): Promise<void> {
  panel.setPattern(pattern)
  await panel.search()
  await flush()
}

/** 推一批结果。`filesScanned` 与 `files.length` 无关，它是「到这一批为止读了正文的文件数」 */
async function deliver(files: SearchFile[] = TWO_FILES, filesScanned = 12): Promise<void> {
  panel.handlers.onBatch(taskId, { files, filesScanned })
  await flush()
}

async function done(overrides: Partial<SearchSummary> = {}): Promise<void> {
  panel.handlers.onDone(taskId, sum(overrides))
  await flush()
}

/* ---------- DOM 读取口 ---------- */

function panelEl(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.find-panel')
  if (!el) throw new Error('找不到 .find-panel')
  return el
}

function input(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('.find-input')
  if (!el) throw new Error('找不到 .find-input')
  return el
}

function scrollEl(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.find-scroll')
  if (!el) throw new Error('找不到 .find-scroll')
  return el
}

function spacer(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.find-spacer')
  if (!el) throw new Error('找不到 .find-spacer')
  return el
}

function windowEl(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.find-window')
  if (!el) throw new Error('找不到 .find-window')
  return el
}

function rowEls(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.find-row')]
}

/** 渲染出来的那些行的文本。文件行是「rel + 几处」，命中行是「行号 + 正文」 */
function rowTexts(): string[] {
  return rowEls().map((el) => el.textContent ?? '')
}

/**
 * 头部那些按钮。用文本找，不用 class：搜索/取消两个刻意没有自己的 class
 * （它们继承全局 button 外观），清空与收起是 `.find-act`。
 */
function headButton(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.find-head button')].find((b) => b.textContent === text)
}

function mustButton(text: string): HTMLButtonElement {
  const el = headButton(text)
  if (!el) throw new Error(`头部没有「${text}」这个按钮`)
  return el
}

/** 三个开关，按渲染顺序：`.*` / `Aa` / `ab` */
function opts(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.find-opt')]
}

function statusText(): string {
  return container.querySelector('.find-status-text')?.textContent ?? ''
}

function errorText(): string | null {
  return container.querySelector('.find-error')?.textContent ?? null
}

function warningText(): string | null {
  return container.querySelector('.find-warning')?.textContent ?? null
}

function marks(): string[] {
  return [...container.querySelectorAll<HTMLElement>('.find-mark')].map((el) => el.textContent ?? '')
}

/* ---------- 事件派发 ---------- */

/**
 * `bubbles` 与 `cancelable` 都是必需的：Solid 把 keydown 挂在 document 上做委托，
 * 不冒泡就到不了处理器；不 cancelable 的话 `preventDefault()` 是空操作，
 * 断言不出「浏览器默认行为被吃掉了」。
 */
function key(el: HTMLElement, which: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: which, bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return e
}

/** 往输入框里打字。必须派发 `input`：Solid 的 `onInput` 读的是事件，不是赋值这个动作 */
function type(text: string): void {
  const el = input()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * jsdom 没有布局引擎，`clientHeight` 恒为 0，`scrollTop` 的赋值也是空操作。
 * 两个都换成自己的读写口——虚拟滚动这组测试要的就是这两个数。
 */
function fakeBox(el: HTMLElement, height: number): void {
  let top = 0
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
    },
  })
}

/** onMount 时量过一次，之后只有 window resize 会重量——测试里就得走这条路 */
async function fakeViewport(height: number): Promise<void> {
  fakeBox(scrollEl(), height)
  await flush()
  window.dispatchEvent(new Event('resize'))
}

/** 滚到某个位置并派发事件（`onScroll` 读的是 `currentTarget.scrollTop`） */
function scrollTo(top: number): void {
  const el = scrollEl()
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

let seq = 0

beforeEach(() => {
  ipc.startSearch.mockReset()
  ipc.cancelSearch.mockReset()
  seq = 0
  taskId = 't0'
  ipc.startSearch.mockImplementation(async (): Promise<string> => {
    taskId = `t${String(++seq)}`
    return taskId
  })
  ipc.cancelSearch.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  disposeRender?.()
  disposeRender = undefined
  disposePanel?.()
  disposePanel = undefined
  container.remove()
})

describe('面板头部', () => {
  it('渲染出输入框、三个开关、搜索、清空与收起；没在跑的时候没有「取消」', () => {
    mount()

    expect(input()).toBeTruthy()
    expect(opts().map((b) => b.textContent)).toEqual(['.*', 'Aa', 'ab'])
    expect(mustButton('搜索')).toBeTruthy()
    expect(mustButton('⌫')).toBeTruthy()
    expect(mustButton('×')).toBeTruthy()
    expect(headButton('取消')).toBeUndefined()
    // 一行结果都没有的时候列表也得在：收起面板靠的是 `<Show when={visible()}>`
    // 在 App 那一层，面板自己始终渲染完整的骨架
    expect(scrollEl()).toBeTruthy()
  })

  it('三个开关各自独立，点一下翻过来再点一下翻回去', async () => {
    const p = mount()

    opts()[0]!.click()
    await flush()
    expect(p.literal()).toBe(true)
    expect(p.caseSensitive()).toBe(false)
    expect(opts()[0]!.classList.contains('on')).toBe(true)
    expect(opts()[1]!.classList.contains('on')).toBe(false)
    // `aria-pressed` 是读屏软件唯一能拿到的那个状态，与 class 分岔的话
    // 看得见的人和听得见的人会以为开关在两个不同的位置上
    expect(opts()[0]!.getAttribute('aria-pressed')).toBe('true')

    opts()[1]!.click()
    await flush()
    expect(p.literal()).toBe(true)
    expect(p.caseSensitive()).toBe(true)

    opts()[0]!.click()
    await flush()
    expect(p.literal()).toBe(false)
    expect(p.caseSensitive()).toBe(true)
    expect(opts()[0]!.getAttribute('aria-pressed')).toBe('false')
  })

  it('打字改的是 panel.pattern()，反过来 setPattern 也写回输入框', async () => {
    const p = mount()

    type('  带空格的搜索词  ')
    await flush()
    // ⚠️ 不 trim：`"   "` 是一个合法的正则，前端替用户改它就是悄悄改掉他要搜的东西
    expect(p.pattern()).toBe('  带空格的搜索词  ')

    p.setPattern('换一个字')
    await flush()
    expect(input().value).toBe('换一个字')
  })

  it('「搜索」按钮起一次搜索，root 与四个开关原样交给 IPC', async () => {
    const p = mount()
    type('needle')
    opts()[1]!.click() // 区分大小写
    await flush()

    mustButton('搜索').click()
    await flush()

    expect(ipc.startSearch).toHaveBeenCalledTimes(1)
    expect(ipc.startSearch.mock.calls[0]![0]).toBe('/repo')
    expect(ipc.startSearch.mock.calls[0]![1]).toEqual({
      pattern: 'needle',
      literal: false,
      caseSensitive: true,
      wholeWord: false,
    })
    expect(p.running()).toBe(true)
  })

  it('正在搜的时候才出现「取消」，点它走 cancelSearch', async () => {
    const p = mount()
    await searchOnce()

    mustButton('取消').click()
    await flush()

    expect(ipc.cancelSearch).toHaveBeenCalledWith('t1')
    // 状态一律不动：已经推出去的批次仍然有效，收尾由随后的 done 事件做
    expect(p.running()).toBe(true)

    await done({ cancelled: true })
    expect(headButton('取消')).toBeUndefined()
  })

  it('「⌫」清掉结果但留着搜索词与开关', async () => {
    const p = mount()
    await searchOnce()
    await deliver()
    await done()
    expect(rowEls().length).toBeGreaterThan(0)

    mustButton('⌫').click()
    await flush()

    expect(p.rows()).toEqual([])
    expect(p.summary()).toBeNull()
    expect(p.pattern()).toBe('needle')
    expect(rowEls()).toHaveLength(0)
    expect(statusText()).toBe('在项目里搜一遍：输入搜索词，按 Enter')
  })

  it('「×」收起面板，结果与搜索词都留着', async () => {
    const p = mount()
    await searchOnce()
    await deliver()

    mustButton('×').click()
    await flush()

    expect(p.visible()).toBe(false)
    expect(p.rows().length).toBeGreaterThan(0)
    expect(p.pattern()).toBe('needle')
    // 收起不等于取消：重新展开该看到上次那份结果
    expect(ipc.cancelSearch).not.toHaveBeenCalled()
  })

  it('行高只有一个真相：常量被注入成 CSS 变量', () => {
    mount()
    expect(panelEl().style.getPropertyValue('--vela-search-row-height')).toBe(`${RESULT_ROW_HEIGHT}px`)
    // 这个数与文件树的 22 刻意不同。写成两处字面量的话漂移的失败方式是
    // 「行与行之间露出一条缝」，不报错，只是难看
    expect(RESULT_ROW_HEIGHT).not.toBe(22)
  })
})

describe('状态那两行', () => {
  it('还没搜过时说的是「怎么开始」，不是「没有找到」', () => {
    mount()
    expect(statusText()).toBe('在项目里搜一遍：输入搜索词，按 Enter')
    expect(errorText()).toBeNull()
    expect(warningText()).toBeNull()
  })

  it('搜索中显示进度，心跳只动那个数字', async () => {
    mount()
    await searchOnce()
    expect(statusText()).toBe('正在搜索… 已扫过 0 个文件')

    panel.handlers.onBatch('t1', { files: [], filesScanned: 4800 })
    await flush()
    expect(statusText()).toBe('正在搜索… 已扫过 4800 个文件')
    expect(rowEls()).toHaveLength(0)
  })

  it('结束后换成总账那一句话', async () => {
    mount()
    await searchOnce()
    await deliver()
    await done()

    expect(statusText()).toBe('共 3 处，分布在 2 个文件里 · 扫过 12 个文件 · 30ms')
  })

  it('错误单独渲染在 .find-error 里', async () => {
    mount()
    ipc.startSearch.mockRejectedValueOnce({ kind: 'bad_pattern', message: '正则不合法' })
    await searchOnce()

    expect(statusText()).toBe('在项目里搜一遍：输入搜索词，按 Enter')
    expect(errorText()).toContain('正则不合法')
  })

  it('搜索词为空时前端自己拦下来，压根不发 IPC', async () => {
    const p = mount()
    await p.search()
    await flush()

    expect(ipc.startSearch).not.toHaveBeenCalled()
    expect(errorText()).toBe('搜索词不能为空')
  })

  it('⚠️ 「有东西没读成」单独一行、警告色；没有的时候那一行不存在', async () => {
    mount()
    await searchOnce()
    await done({ unreadable: 2, hits: 0, filesWithHits: 0 })

    expect(warningText()).toContain('2 个条目')
    // 这一句限定的是上面那个「没有找到」的效力，混在一行里会被扫过去
    expect(statusText()).toContain('没有找到')
    expect(container.querySelector('.find-warning')).not.toBeNull()
  })

  it('unreadable 为 0 时不渲染警告行', async () => {
    mount()
    await searchOnce()
    await done({ unreadable: 0 })

    expect(warningText()).toBeNull()
    expect(container.querySelector('.find-warning')).toBeNull()
  })
})

describe('键盘', () => {
  it('输入框里按 Enter = 开始搜索', async () => {
    const p = mount()
    type('needle')
    await flush()

    const e = key(input(), 'Enter')
    await flush()

    expect(e.defaultPrevented).toBe(true)
    expect(ipc.startSearch).toHaveBeenCalledTimes(1)
    expect(p.running()).toBe(true)
  })

  it('输入框里按 Escape 收起面板', async () => {
    const p = mount()
    const e = key(input(), 'Escape')
    await flush()

    expect(e.defaultPrevented).toBe(true)
    expect(p.visible()).toBe(false)
  })

  it('列表里按 Escape 也收起', async () => {
    const p = mount()
    const e = key(scrollEl(), 'Escape')
    await flush()

    expect(e.defaultPrevented).toBe(true)
    expect(p.visible()).toBe(false)
  })

  it('⚠️ 输入框里按 ArrowDown 一步走进结果，并把焦点交给列表', async () => {
    const p = mount()
    await searchOnce()
    await deliver()

    const e = key(input(), 'ArrowDown')
    await flush()

    expect(e.defaultPrevented).toBe(true)
    expect(p.selected()).toBe(0)
    // 不交焦点的话下一按方向键又回到输入框里，用户得先点一下列表才能继续走
    expect(document.activeElement).toBe(scrollEl())
  })

  it('没有结果时 ArrowDown 不吃掉这个键——那会儿它该有浏览器自己的含义', async () => {
    const p = mount()
    const e = key(input(), 'ArrowDown')
    await flush()

    expect(e.defaultPrevented).toBe(false)
    expect(p.selected()).toBeNull()
    expect(document.activeElement).not.toBe(scrollEl())
  })

  it('列表里的方向键改选中，选中行拿到 .selected 与 aria-selected', async () => {
    const p = mount()
    await searchOnce()
    await deliver()

    key(scrollEl(), 'ArrowDown')
    await flush()
    expect(p.selected()).toBe(0)
    expect(rowEls()[0]!.classList.contains('selected')).toBe(true)
    expect(rowEls()[0]!.getAttribute('aria-selected')).toBe('true')

    key(scrollEl(), 'ArrowDown')
    await flush()
    expect(p.selected()).toBe(1)
    expect(rowEls()[0]!.classList.contains('selected')).toBe(false)
    expect(rowEls()[1]!.classList.contains('selected')).toBe(true)

    key(scrollEl(), 'ArrowUp')
    await flush()
    expect(p.selected()).toBe(0)
  })

  it('列表里的 Home / End 落到两头', async () => {
    const p = mount()
    await searchOnce()
    await deliver()

    key(scrollEl(), 'End')
    await flush()
    expect(p.selected()).toBe(p.rows().length - 1)

    key(scrollEl(), 'Home')
    await flush()
    expect(p.selected()).toBe(0)
  })

  it('列表里的 Enter 打开选中的那条', async () => {
    mount()
    await searchOnce()
    await deliver()

    key(scrollEl(), 'ArrowDown') // 选中第 0 行（文件行）
    await flush()
    const e = key(scrollEl(), 'Enter')
    await flush()

    expect(e.defaultPrevented).toBe(true)
    // 文件行跳到它的第一个命中：点分组标题打开那个文件是所有人的直觉，
    // 而「打开但不跳行」会让人落在文件开头，再自己在几万行里找刚才那一处
    expect(opened).toHaveLength(1)
    expect(opened[0]!.line).toBe(1)
    expect(opened[0]!.rel).toBe('src/a.ts')
  })

  it('没选中就按 Enter 时什么都不干，也不吃掉这个键', async () => {
    mount()
    await searchOnce()
    await deliver()

    const e = key(scrollEl(), 'Enter')
    await flush()

    expect(e.defaultPrevented).toBe(false)
    expect(opened).toHaveLength(0)
  })

  it('不是结果键的按键被放过（Tab 要能走出列表）', async () => {
    const p = mount()
    await searchOnce()
    await deliver()

    const e = key(scrollEl(), 'Tab')
    await flush()

    expect(e.defaultPrevented).toBe(false)
    expect(p.selected()).toBeNull()
  })

  it('空列表里按方向键什么都不干', async () => {
    const p = mount()
    const e = key(scrollEl(), 'ArrowDown')
    await flush()

    expect(e.defaultPrevented).toBe(false)
    expect(p.selected()).toBeNull()
  })

  it('⚠️ 键盘把选中行带出视口时 scrollTop 跟着走（滚进可视区）', async () => {
    const p = mount()
    await searchOnce()
    await deliver(manyFiles())
    await fakeViewport(RESULT_ROW_HEIGHT * 5)

    key(scrollEl(), 'End') // 最后一行 index 43
    await flush()

    // bottom = 44 * 20 = 880，视口高 100，所以 scrollTop 落到 780
    expect(p.rows()).toHaveLength(44)
    expect(scrollEl().scrollTop).toBe(44 * RESULT_ROW_HEIGHT - RESULT_ROW_HEIGHT * 5)
  })

  it('选中行本来就在视口里时 scrollTop 一动不动', async () => {
    mount()
    await searchOnce()
    await deliver(manyFiles())
    await fakeViewport(RESULT_ROW_HEIGHT * 5)

    panel.select(4)
    scrollTo(RESULT_ROW_HEIGHT * 2) // 视口 = [40, 140)，index 4 的 [80,100) 在里面
    await flush()

    key(scrollEl(), 'ArrowDown') // → index 5，[100,120) 仍然在视口里
    await flush()

    expect(panel.selected()).toBe(5)
    expect(scrollEl().scrollTop).toBe(RESULT_ROW_HEIGHT * 2)
  })
})

describe('结果行', () => {
  it('文件行是分组标题：相对路径 + 几处命中', async () => {
    mount()
    await searchOnce()
    await deliver()

    const first = rowEls()[0]!
    expect(first.classList.contains('file')).toBe(true)
    expect(first.querySelector('.find-rel')?.textContent).toBe('src/a.ts')
    expect(first.querySelector('.find-count')?.textContent).toBe('2 处')
    // 绝对路径挂在 title 上：省略号截断之后这是唯一还能看清是哪一处地方
    expect(first.title).toBe('/repo/src/a.ts')
    expect(first.getAttribute('role')).toBe('option')
  })

  it('命中行是行号 + 正文，缩进那一层由 CSS 表达（行对象里没有父子指针）', async () => {
    mount()
    await searchOnce()
    await deliver()

    const second = rowEls()[1]!
    expect(second.classList.contains('file')).toBe(false)
    expect(second.querySelector('.find-line')?.textContent).toBe('1')
    expect(second.querySelector('.find-text')?.textContent).toBe('let a = needle;')
  })

  it('⚠️ 命中那一段渲染成 mark，整行文本拼回去必须等于原正文', async () => {
    mount()
    await searchOnce()
    // 只送一个文件一条命中：`marks()` 数的是整个容器里的 mark，
    // 默认那批 TWO_FILES 有两个文件各命中一处，断言就说不清是在验哪一行
    await deliver([file('src/a.ts', ['let a = needle;'])])

    expect(marks()).toEqual(['needle'])
    // 少一段的失败方式是那行看起来「少了个字」，而它其实只是没被高亮——
    // 用户会以为搜索把正文改了
    expect(rowEls()[1]!.querySelector('.find-text')?.textContent).toBe('let a = needle;')
  })

  it('一行里多处命中就是多个 mark', async () => {
    mount()
    await searchOnce()
    await deliver([file('a.ts', ['needle and needle'])])

    expect(marks()).toEqual(['needle', 'needle'])
    expect(rowEls()[1]!.querySelector('.find-text')?.textContent).toBe('needle and needle')
  })

  it('ranges 为空时不画 mark，但正文照旧显示（命中了只是说不清在哪儿）', async () => {
    mount()
    await searchOnce()
    // 这一行的正文里刻意没有 "needle"，于是 hit() 交出空 ranges
    await deliver([file('a.ts', ['一行说不清命中在哪儿的正文'])])

    expect(marks()).toEqual([])
    expect(rowEls()[1]!.querySelector('.find-text')?.textContent).toBe('一行说不清命中在哪儿的正文')
    expect(rowEls()[1]!.querySelector('.find-line')?.textContent).toBe('1')
  })

  it('撞到单文件上限时标题要说「没搜完」', async () => {
    mount()
    await searchOnce()
    await deliver([file('big.ts', ['needle one', 'needle two'], true)])

    expect(rowEls()[0]!.querySelector('.find-count')?.textContent).toBe('2 处（这个文件没搜完）')
  })

  it('点一条命中行就跳过去', async () => {
    const p = mount()
    await searchOnce()
    await deliver()

    rowEls()[2]!.click() // src/a.ts 的第二条命中（line 2）
    await flush()

    expect(opened).toHaveLength(1)
    expect(opened[0]!.line).toBe(2)
    expect(opened[0]!.path).toBe('/repo/src/a.ts')
    expect(p.selected()).toBe(2)
  })

  it('点文件行落到它的第一个命中', async () => {
    mount()
    await searchOnce()
    await deliver()

    rowEls()[0]!.click()
    await flush()

    expect(opened).toHaveLength(1)
    expect(opened[0]!.line).toBe(1)
  })

  it('新到的一批接在后面，不重建前面那些行', async () => {
    const p = mount()
    await searchOnce()
    await deliver([TWO_FILES[0]!])
    const before = rowTexts()

    await deliver([TWO_FILES[1]!], 20)
    await flush()

    expect(p.rows()).toHaveLength(5)
    expect(rowTexts().slice(0, before.length)).toEqual(before)
  })
})

describe('虚拟滚动', () => {
  it('jsdom 里 clientHeight 为 0，窗口只给出 OVERSCAN 行', async () => {
    mount()
    await searchOnce()
    await deliver(manyFiles()) // 44 行

    expect(rowEls()).toHaveLength(OVERSCAN)
    expect(rowTexts()[0]).toContain('src/f00.ts')
    expect(spacer().style.height).toBe(`${44 * RESULT_ROW_HEIGHT}px`)
    expect(windowEl().style.transform).toBe('translateY(0px)')
  })

  it('滚到中间时渲染的是中间那一段，窗口层跟着位移', async () => {
    const p = mount()
    await searchOnce()
    await deliver(manyFiles())
    await fakeViewport(RESULT_ROW_HEIGHT * 5)

    scrollTo(RESULT_ROW_HEIGHT * 20) // 第一可见行 = 20
    await flush()

    // start = 20 - 6 = 14，end = 20 + 5 + 6 = 31
    expect(rowEls()).toHaveLength(17)
    const at14 = p.rows()[14]!
    // 取出来再判：`p.rows()[14]!.kind === 'file' ? … : p.rows()[14]!.text` 那两次索引
    // 不会保留类型收窄，TS 会认为 FileRow 上没有 text
    expect(rowTexts()[0]).toContain(at14.kind === 'file' ? at14.rel : at14.text)
    expect(windowEl().style.transform).toBe(`translateY(${14 * RESULT_ROW_HEIGHT}px)`)
    // spacer 的高度不随滚动变：它就是总高，滚动条的长度靠它算
    expect(spacer().style.height).toBe(`${44 * RESULT_ROW_HEIGHT}px`)
  })

  it('⚠️ 滚动复用 DOM：窗口重叠的那几行是**同一批元素对象**', async () => {
    mount()
    await searchOnce()
    await deliver(manyFiles())
    await fakeViewport(RESULT_ROW_HEIGHT * 5)

    const before = new Map(rowEls().map((el) => [el.textContent ?? '', el]))
    scrollTo(RESULT_ROW_HEIGHT) // 只滚一行，窗口从 [0,11) 变成 [0,12)
    await flush()

    const after = new Map(rowEls().map((el) => [el.textContent ?? '', el]))
    let shared = 0
    for (const [text, el] of before) {
      const now = after.get(text)
      if (now === undefined) continue
      shared++
      expect(now, text).toBe(el)
    }
    // 这条断言是整组测试里最重要的一句：`<For>` 靠引用相等复用节点，
    // 而 `panel.rows()` 是 memo、不依赖 scrollTop。哪天有人把 rows 改成
    // 「滚动时重算的普通函数」，节点引用就会全部换新，这里立刻红。
    expect(shared).toBeGreaterThan(0)
    expect(after.size).toBe(before.size + 1)
  })

  it('滚出窗口的那些行被摘掉，DOM 里始终只有那几十行', async () => {
    mount()
    await searchOnce()
    await deliver(manyFiles())
    await fakeViewport(RESULT_ROW_HEIGHT * 5)

    scrollTo(RESULT_ROW_HEIGHT * 30)
    await flush()

    expect(rowTexts().some((t) => t.includes('src/f00.ts'))).toBe(false)
    // 窗口是 [24, 41)：44 行里最后渲染的是 index 40，也就是 f20 的文件行，f21 还在窗口外
    expect(rowTexts().some((t) => t.includes('src/f20.ts'))).toBe(true)
    expect(rowTexts().some((t) => t.includes('src/f21.ts'))).toBe(false)
    expect(rowEls().length).toBeLessThan(44)
  })

  it('⚠️ 结果被清空时 scrollTop 归零，否则下一轮会算出一个空窗口', async () => {
    const p = mount()
    await searchOnce()
    await deliver(manyFiles())
    await fakeViewport(RESULT_ROW_HEIGHT * 5)

    scrollTo(RESULT_ROW_HEIGHT * 30)
    await flush()
    expect(scrollEl().scrollTop).toBe(600)

    // 上一轮滚到了 600px，新一轮只有三行结果，窗口算术会算出 start === end === 3：
    // 面板一片空白，而 rows() 里明明有东西，状态栏还写着「共 3 行」
    p.clear()
    await flush()
    await searchOnce('other')
    await deliver([file('only.ts', ['one other'])])

    expect(p.rows().length).toBeGreaterThan(0)
    expect(scrollEl().scrollTop).toBe(0)
    expect(rowEls().length).toBeGreaterThan(0)
  })

  it('结果还在长的时候不动滚动位置：用户正在看的那一段不该被抽走', async () => {
    mount()
    await searchOnce()
    await deliver(manyFiles())
    await fakeViewport(RESULT_ROW_HEIGHT * 5)

    scrollTo(RESULT_ROW_HEIGHT * 2)
    await deliver([file('late.ts', ['a late needle'])], 60)
    await flush()

    expect(scrollEl().scrollTop).toBe(RESULT_ROW_HEIGHT * 2)
  })
})

describe('焦点', () => {
  it('show() 之后输入框拿到焦点', async () => {
    const p = mount()
    expect(document.activeElement).not.toBe(input())

    p.show()
    await flush()

    expect(p.visible()).toBe(true)
    expect(document.activeElement).toBe(input())
  })

  it('⚠️ 面板本来就展开着的时候再 show() 一次，焦点照样抢得回来', async () => {
    const p = mount()
    p.show()
    await flush()
    scrollEl().focus()
    expect(document.activeElement).toBe(scrollEl())

    // 用计数而不是布尔正是为了这一条：布尔值不变就不会触发 effect
    p.show()
    await flush()

    expect(document.activeElement).toBe(input())
  })
})
