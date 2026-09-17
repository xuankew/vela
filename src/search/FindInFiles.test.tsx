// @vitest-environment jsdom
import { createRoot } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 底部搜索面板的测试：DOM 与 `createSearchPanel` 之间的接线。
 *
 * 状态机那一半（什么时候去搜、批次放哪、taskId 怎么认领作废、`stale` 与 `canApply` 怎么算）
 * 在 `./store.test.ts` 里钉过了，行扁平化、键盘落点、总账文案与命中段切分在 `./rows.test.ts`
 * 里钉过了，确认对话框自己在 `./ReplaceConfirm.test.tsx` 里。这里测五件事：
 * **渲染出来的东西对不对**、**点对了地方会不会调到对的方法**、
 * **虚拟滚动是不是真的只渲染看得见的那几十行、并且滚动时复用 DOM**、
 * **那五个键与 Esc 落在输入框和落在列表上分别做什么**，
 * 以及——M2-D 之后——**替换模式下多出来的那一排、命中行上的 `原文 → 预览`、
 * 会被跳过的文件标记**。
 *
 * 虚拟滚动那条是整段设计的承重墙——结果上限是两万条命中，全部渲染出来是四万个 DOM 节点。
 * 它坏掉的方式不报错：滚动时整棵子树被重建，帧率掉到个位数，而所有功能测试照样全绿。
 *
 * ⚠️ 替换那一半有一条边界必须在这里钉：「替换全部」**只摊一张确认单**，
 * 一个字节都不写，而且对话框不由面板渲染（两个遮罩叠着的话两个都能点「替换」）。
 * 落盘那一下的批准在 App 那一层，所以这条只有面板自己的测试说得住。
 *
 * ⚠️ 有些东西这里钉不住，都得在真实窗口里看：面板占掉多少编辑区高度、240px 合不合适、
 * 多出来那一排（26px）值不值、结果行的省略号断在哪儿、`.find-mark` 与 `.find-opt.on`
 * 的对比度、`.find-new` 那个绿与 `.find-mark` 那个蓝分不分得开、`.find-row.skipped`
 * 压暗到什么程度才看得出又不刺眼（jsdom 里没有布局，`getBoundingClientRect()` 全是 0）。
 */

/**
 * ⚠️ 桩写了完整的函数签名，不是裸 `vi.fn()`：裸的话 `.mock.calls` 的元素是 `any`，
 * 于是每一处 `calls[0][1].pattern` 都是一次 unsafe member access，而 `pnpm lint` 是门禁。
 * 签名里直接用 `SearchQuery` 是安全的——类型在编译时被擦掉，`vi.hoisted` 的工厂搬到
 * import 之前也不会引用到任何运行时值。
 */
const { ipc, task, rep } = vi.hoisted(() => ({
  ipc: {
    startSearch: vi.fn<(root: string, query: SearchQuery) => Promise<string>>(),
    describeSearchError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
  },
  task: {
    cancelTask: vi.fn<(taskId: string) => Promise<void>>(),
  },
  rep: {
    startReplace: vi.fn<(root: string, query: SearchQuery, skip: string[]) => Promise<string>>(),
  },
}))

vi.mock('../ipc/search', () => ipc)
vi.mock('../ipc/task', () => task)
vi.mock('../ipc/replace', () => rep)

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

/** 替换模式下的一批结果：`pairs` 的每一项是「原文 / 换完长什么样」 */
function previewFile(rel: string, pairs: [string, string][], truncated = false): SearchFile {
  return {
    rel,
    path: `/repo/${rel}`,
    truncated,
    hits: pairs.map(([text, replaced], i) => ({ ...hit(i + 1, text), replaced })),
  }
}

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
/** 正开着且有未保存改动的那些路径。`mount` 把它接成 `skipPaths`，用例按需填 */
let dirty: string[]
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
    panel = createSearchPanel({
      // root 是常量而不是 signal：这一组的用例里没有一条要改项目根，
      // 而「root 变了 canApply 得跟着变」那条在 store.test.ts 里用真 signal 钉过了
      root: () => '/repo',
      openHit: async (h) => void opened.push(h),
      skipPaths: () => dirty,
    })
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

/**
 * 打开替换模式、填好替换内容、搜一遍，并把带 `replaced` 的那一批结果推完。
 *
 * 走完这一步 `canApply()` 才是真的：它要求「替换模式开着 + 不在跑 + 没过期 + 有命中」，
 * 少一样「替换全部」就是灰的，于是那些用例点的其实是一个按不动的按钮
 */
async function previewOnce(files: SearchFile[], replacement = 'NEEDLE'): Promise<void> {
  modeButton().click()
  await flush()
  type('needle')
  typeReplace(replacement)
  await flush()

  await panel.search()
  await flush()
  const hits = files.reduce((n, f) => n + f.hits.length, 0)
  panel.handlers.onBatch(taskId, { files, filesScanned: files.length })
  panel.handlers.onDone(taskId, sum({ filesWithHits: files.length, hits }))
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

/* ---------- 替换那一排的读取口 ---------- */

/** 模式开关。刻意不用 `.find-opt`：那三个是匹配选项，这一个是模式，class 就该分开 */
function modeButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('.find-mode')
  if (!el) throw new Error('找不到「替换」模式开关')
  return el
}

function replaceRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.find-replace')
}

/**
 * 「替换为」那一格。⚠️ 必须限定在 `.find-replace` 里面找：它也挂着 `.find-input`，
 * 而 `input()` 用的是 `querySelector`（取第一个），少了这个限定就会两个都指到搜索词上
 */
function replaceInput(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('.find-replace .find-input')
  if (!el) throw new Error('找不到「替换为」输入框')
  return el
}

function applyButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('.find-replace button')
  if (!el) throw new Error('找不到「替换全部」')
  return el
}

/** 命中行上的预览那一段（`→` 之后的）。没预览过时一个都不存在 */
function previews(): string[] {
  return [...container.querySelectorAll<HTMLElement>('.find-new')].map((el) => el.textContent ?? '')
}

function arrows(): number {
  return container.querySelectorAll('.find-arrow').length
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

/** 与 `type` 同一条规矩，只是落在「替换为」那一格上 */
function typeReplace(text: string): void {
  const el = replaceInput()
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
  task.cancelTask.mockReset()
  rep.startReplace.mockReset()
  seq = 0
  taskId = 't0'
  ipc.startSearch.mockImplementation(async (): Promise<string> => {
    taskId = `t${String(++seq)}`
    return taskId
  })
  task.cancelTask.mockResolvedValue(undefined)
  // 落盘那一轮的 id 刻意与搜索那一轮不同号：两个 TaskSlot 各有各的 `retired`，
  // 同号也不会互相作废，而写成不同的值能让「认错了 slot」这类失败在断言里现形
  rep.startReplace.mockResolvedValue('r1')
  // 默认没有任何脏标签。⚠️ 不重置的话 `skipPaths()` 交出去的是 undefined，
  // store 那边 `?? []` 会把它咽掉，于是「跳过的文件要标出来」那条用例永远造不出 skipped
  dirty = []
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

  it('正在搜的时候才出现「取消」，点它走 cancelTask', async () => {
    const p = mount()
    await searchOnce()

    mustButton('取消').click()
    await flush()

    expect(task.cancelTask).toHaveBeenCalledWith('t1')
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
    expect(task.cancelTask).not.toHaveBeenCalled()
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

/* ───────────────────────── 替换那一半（M2-D） ───────────────────────── */

describe('替换那一排', () => {
  it('一开始没有那一排，「搜索」就叫搜索；点「替换」之后才出现，按钮改叫「预览」', async () => {
    const p = mount()

    expect(replaceRow()).toBeNull()
    expect(headButton('搜索')).toBeTruthy()
    expect(modeButton().classList.contains('on')).toBe(false)
    expect(modeButton().getAttribute('aria-pressed')).toBe('false')

    modeButton().click()
    await flush()

    expect(p.replaceMode()).toBe(true)
    expect(replaceRow()).toBeTruthy()
    expect(replaceInput()).toBeTruthy()
    expect(applyButton()).toBeTruthy()
    expect(modeButton().classList.contains('on')).toBe(true)
    expect(modeButton().getAttribute('aria-pressed')).toBe('true')
    // 同一个按钮换了名字，不是多出来一个：多一个的话「搜索」在替换模式下仍然可点，
    // 而它按下之后发出去的 query 是带 `replace` 的那一份——两个按钮做同一件事
    expect(headButton('预览')).toBeTruthy()
    expect(headButton('搜索')).toBeUndefined()

    modeButton().click()
    await flush()
    expect(replaceRow()).toBeNull()
    expect(headButton('搜索')).toBeTruthy()
  })

  it('「替换」是模式，不是第四个匹配开关：那三个自己一个都不翻', async () => {
    const p = mount()

    modeButton().click()
    await flush()

    expect(opts().map((b) => b.textContent)).toEqual(['.*', 'Aa', 'ab'])
    expect(opts().some((b) => b.classList.contains('on'))).toBe(false)
    expect(p.literal()).toBe(false)
    expect(p.caseSensitive()).toBe(false)
    expect(p.wholeWord()).toBe(false)
  })

  it('打字改的是 panel.replacement()，反过来 setReplacement 也写回那一格', async () => {
    const p = mount()
    modeButton().click()
    await flush()

    // ⚠️ 不 trim，与搜索词同一条理由：`"  "` 是「把命中换成两个空格」，
    // 前端替用户去掉就等于把一次替换悄悄改成了删除
    typeReplace('  新内容  ')
    await flush()
    expect(p.replacement()).toBe('  新内容  ')

    p.setReplacement('换一个')
    await flush()
    expect(replaceInput().value).toBe('换一个')
  })

  it('⚠️ 预览那一次发出去的 query 多一个 replace 字段，纯搜索时没有', async () => {
    const p = mount()
    type('needle')
    await flush()
    await p.search()
    await flush()

    expect(ipc.startSearch.mock.calls[0]![1]).toEqual({
      pattern: 'needle',
      literal: false,
      caseSensitive: false,
      wholeWord: false,
    })

    modeButton().click()
    typeReplace('NEEDLE')
    await flush()
    await p.search()
    await flush()

    // 同一条 `start_search`，多一个字段：预览不另起一条 IPC，
    // 于是「所见即所做」是结构上成立的，而不是靠两边各写一份模板展开去对齐
    expect(ipc.startSearch.mock.calls[1]![1]).toEqual({
      pattern: 'needle',
      literal: false,
      caseSensitive: false,
      wholeWord: false,
      replace: 'NEEDLE',
    })
  })

  it('「替换为」那一格里按 Enter 也起一次预览，按 Escape 也收起面板', async () => {
    const p = mount()
    modeButton().click()
    await flush()
    type('needle')
    typeReplace('NEEDLE')
    await flush()

    const enter = key(replaceInput(), 'Enter')
    await flush()
    expect(enter.defaultPrevented).toBe(true)
    expect(ipc.startSearch).toHaveBeenCalledTimes(1)
    expect(p.running()).toBe(true)

    const esc = key(replaceInput(), 'Escape')
    await flush()
    expect(esc.defaultPrevented).toBe(true)
    expect(p.visible()).toBe(false)
  })

  it('⚠️ 「替换全部」灰掉的每一种理由都写在 title 上', async () => {
    const p = mount()
    modeButton().click()
    await flush()
    // 一次都没搜过
    expect(applyButton().disabled).toBe(true)
    expect(applyButton().title).toBe('先搜一遍，看看会改到哪些地方')

    // 搜了，一处都没命中
    type('needle')
    await flush()
    await p.search()
    await flush()
    await done({ hits: 0, filesWithHits: 0 })
    expect(applyButton().title).toBe('这一轮一处都没命中')

    // 还在搜
    await p.search()
    await flush()
    expect(applyButton().disabled).toBe(true)
    expect(applyButton().title).toBe('等这一轮搜完')

    // 搜完、有命中：可以按了
    await deliver([previewFile('src/a.ts', [['let a = needle;', 'let a = NEEDLE;']])])
    await done({ hits: 1, filesWithHits: 1 })
    expect(p.canApply()).toBe(true)
    expect(applyButton().disabled).toBe(false)
    expect(applyButton().title).toBe('把命中的地方全换成上面填的内容（会先摊一张确认单）')

    // 条件改过了：预览对不上了。这一条是唯一在面板上别处也说了的（警告行），
    // 两处都得有——按钮离手最近，警告行才是说清「为什么」的那一句
    typeReplace('别的')
    await flush()
    expect(p.stale()).toBe(true)
    expect(applyButton().disabled).toBe(true)
    expect(applyButton().title).toBe('条件改过了：重新搜一遍，让预览对上你批准的那份')
    expect(warningText()).toContain('预览已过期')
  })

  it('正在写盘的时候「替换全部」与「预览」都灰掉，「取消」出现并且停的是落盘那一个', async () => {
    const p = mount()
    await previewOnce([previewFile('src/a.ts', [['let a = needle;', 'let a = NEEDLE;']])])

    void p.confirmApply()
    await flush()

    expect(p.replacing()).toBe(true)
    expect(applyButton().disabled).toBe(true)
    expect(applyButton().title).toBe('正在写盘，等它结束')
    // 「预览」灰掉：那一轮正在改磁盘，而搜完的结果会把它自己的进度挤掉
    expect(mustButton('预览').disabled).toBe(true)
    expect(mustButton('取消')).toBeTruthy()

    mustButton('取消').click()
    await flush()
    // 认的是 applySlot 那个 id，不是刚才搜过的那一个
    expect(task.cancelTask).toHaveBeenCalledWith('r1')
  })

  it('⚠️ 点「替换全部」只摊一张确认单，一个字节都不写；对话框由 App 渲染，不在面板里', async () => {
    const p = mount()
    await previewOnce([
      previewFile('src/a.ts', [
        ['let a = needle;', 'let a = NEEDLE;'],
        ['let b = needle;', 'let b = NEEDLE;'],
      ]),
      previewFile('README.md', [['a needle here', 'a NEEDLE here']]),
    ])
    expect(p.canApply()).toBe(true)

    applyButton().click()
    await flush()

    expect(p.confirm()).toEqual({ files: 2, lines: 3, skipped: 0, deleting: false, truncated: false })
    expect(rep.startReplace).not.toHaveBeenCalled()
    // 面板自己不弹对话框：那张单子是 `ReplaceConfirm`，由 App 渲染在 `.app` 那一层。
    // 在这里也渲染一份的话会有两个遮罩叠着，而两个都能点「替换」
    expect(container.querySelector('.modal-backdrop')).toBeNull()

    p.dismissConfirm()
    await flush()
    expect(p.confirm()).toBeNull()
    expect(rep.startReplace).not.toHaveBeenCalled()
  })

  it('替换内容留空时确认单上 deleting 为真——那是「把命中的那一段删掉」', async () => {
    const p = mount()
    await previewOnce([previewFile('src/a.ts', [['x needle y', 'x  y']])], '')

    applyButton().click()
    await flush()

    expect(p.confirm()).toEqual({ files: 1, lines: 1, skipped: 0, deleting: true, truncated: false })
    expect(rep.startReplace).not.toHaveBeenCalled()
  })

  it('⚠️ 单个文件撞到自己的上限：总账没截断，确认单上也得说「这份清单不完整」', async () => {
    const p = mount()
    await previewOnce([previewFile('src/a.ts', [['let a = needle;', 'let a = NEEDLE;']], true)])

    expect(p.summary()?.truncated).toBe(false)
    expect(rowEls()[0]!.querySelector('.find-count')?.textContent).toBe('1 处（这个文件没搜完）')

    applyButton().click()
    await flush()
    // 落盘那一侧对单文件**没有** 500 条上限，实际会换掉的比预览里显示的多
    expect(p.confirm()).toEqual({ files: 1, lines: 1, skipped: 0, deleting: false, truncated: true })
  })

  it('总条数撞到上限时确认单上 truncated 也为真', async () => {
    const p = mount()
    modeButton().click()
    await flush()
    type('needle')
    typeReplace('NEEDLE')
    await flush()
    await p.search()
    await flush()
    await deliver([previewFile('src/a.ts', [['let a = needle;', 'let a = NEEDLE;']])])
    await done({ hits: 1, filesWithHits: 1, truncated: true })

    applyButton().click()
    await flush()
    expect(p.confirm()).toEqual({ files: 1, lines: 1, skipped: 0, deleting: false, truncated: true })
  })
})

describe('替换预览行', () => {
  it('⚠️ 命中行渲染成「原文 → 预览」，原文那一段照旧打 mark', async () => {
    mount()
    await previewOnce([previewFile('src/a.ts', [['let a = needle;', 'let a = NEEDLE;']])])

    expect(marks()).toEqual(['needle'])
    expect(arrows()).toBe(1)
    expect(previews()).toEqual(['let a = NEEDLE;'])
    // 箭头与预览都在 `.find-text` 里面：整行只有一个省略号，落在预览的尾巴上
    const text = rowEls()[1]!.querySelector('.find-text')!
    expect(text.textContent).toBe('let a = needle;→let a = NEEDLE;')
    expect(text.querySelector('.find-new')).not.toBeNull()
  })

  it('⚠️ replaced 是空串时照样画箭头——真值判断会让它退回纯搜索的样子', async () => {
    mount()
    await previewOnce([previewFile('src/a.ts', [['x needle y', '']])], '')

    expect(arrows()).toBe(1)
    expect(previews()).toEqual([''])
    expect(container.querySelectorAll('.find-new')).toHaveLength(1)
  })

  it('纯搜索的结果一个箭头都没有', async () => {
    mount()
    await searchOnce()
    await deliver()
    await done()

    expect(rowEls().length).toBeGreaterThan(0)
    expect(arrows()).toBe(0)
    expect(previews()).toEqual([])
  })

  it('预览里的换行显示成 ↵：行是定高的，撑开一行窗口算术就废了', async () => {
    mount()
    await previewOnce([previewFile('src/a.ts', [['call(needle)', 'call(\nNEEDLE\n)']])])

    expect(previews()).toEqual(['call(↵NEEDLE↵)'])
  })

  it('预览只挂在命中行上，文件行照旧是「rel + 几处」', async () => {
    mount()
    await previewOnce([
      previewFile('src/a.ts', [
        ['one needle', 'one NEEDLE'],
        ['two needle', 'two NEEDLE'],
      ]),
    ])

    expect(rowEls()[0]!.classList.contains('file')).toBe(true)
    expect(rowEls()[0]!.querySelector('.find-new')).toBeNull()
    expect(rowEls()[0]!.querySelector('.find-count')?.textContent).toBe('2 处')
    expect(arrows()).toBe(2)
    expect(previews()).toEqual(['one NEEDLE', 'two NEEDLE'])
  })
})

describe('会被跳过的文件', () => {
  it('⚠️ 正开着且有未保存改动的那个：整行标 .skipped，计数里带上原因，确认单里也算进 skipped', async () => {
    const p = mount()
    dirty = ['/repo/src/a.ts']
    await previewOnce([
      previewFile('src/a.ts', [['let a = needle;', 'let a = NEEDLE;']]),
      previewFile('README.md', [['a needle here', 'a NEEDLE here']]),
    ])

    const rows = rowEls()
    expect(rows[0]!.classList.contains('skipped')).toBe(true)
    expect(rows[2]!.classList.contains('skipped')).toBe(false)
    // 只压暗是不够的：它与「命中很少的文件」看起来没区别，为什么必须是文字
    expect(rows[0]!.querySelector('.find-count')?.textContent).toBe('1 处（正开着且有未保存的改动，跳过）')
    expect(rows[2]!.querySelector('.find-count')?.textContent).toBe('1 处')

    applyButton().click()
    await flush()
    // 被跳过的那个既不算进 files，它下面那行也不算进 lines：
    // 这两个数字是用户批准落盘的唯一依据，把做不到的那部分算进去就是骗他
    expect(p.confirm()).toEqual({ files: 1, lines: 1, skipped: 1, deleting: false, truncated: false })
  })

  it('没有脏标签时一个 .skipped 都没有', async () => {
    mount()
    await previewOnce([previewFile('src/a.ts', [['let a = needle;', 'let a = NEEDLE;']])])

    expect(container.querySelectorAll('.find-row.skipped')).toHaveLength(0)
    expect(rowEls()[0]!.querySelector('.find-count')?.textContent).toBe('1 处')
  })
})

describe('焦点（替换模式）', () => {
  it('⚠️ 搜索词已经填了才把焦点挪到「替换为」——空着的时候用户要打的第一个东西是搜索词', async () => {
    mount()
    type('needle')
    await flush()

    modeButton().click()
    await flush()
    expect(document.activeElement).toBe(replaceInput())
  })

  it('⚠️ 键盘那条路（showReplace）也得落在「替换为」——它不在 Solid 的事件批里', async () => {
    const p = mount()
    type('needle')
    await flush()

    // 直接调 store 方法，而不是点面板上那个按钮：命令分派挂在 window 的捕获阶段上，
    // 不在 Solid 委托的事件批里，于是 `replaceMode` 与 `focusRequest` 两次写各自跑完
    // 一轮更新，组件里那两个 effect 谁后跑完全由写入顺序决定。
    // 曾经就是靠「后跑的赢」，结果焦点落在搜索词上——一个只在真实按键下才复现的错位
    p.showReplace()
    await flush()
    expect(document.activeElement).toBe(replaceInput())

    // 连按第二次（模式已经开着、`focusRequest` 只加一）也不许把焦点甩回上面那一格
    p.showReplace()
    await flush()
    expect(document.activeElement).toBe(replaceInput())
  })

  it('替换模式里再按 Mod+Shift+F：焦点回搜索词那一格，模式本身留着', async () => {
    const p = mount()
    type('needle')
    await flush()
    p.showReplace()
    await flush()
    expect(document.activeElement).toBe(replaceInput())

    p.show()
    await flush()
    // 那一下表达的是「我要改搜什么」，不是「退出替换模式」——
    // 顺手把模式关掉的话，用户刚填的替换内容与那份预览会一起没了
    expect(document.activeElement).toBe(input())
    expect(p.replaceMode()).toBe(true)
  })

  it('搜索词是空的时候不挪', async () => {
    mount()
    modeButton().click()
    await flush()

    expect(replaceRow()).toBeTruthy()
    expect(document.activeElement).not.toBe(replaceInput())
  })

  it('⚠️ 在替换模式下往搜索词里打字，焦点不许被抢走', async () => {
    mount()
    type('needle')
    await flush()
    modeButton().click()
    await flush()
    expect(document.activeElement).toBe(replaceInput())

    input().focus()
    type('needle2')
    await flush()

    // 写成裸 createEffect 的话它会把 `pattern()` 也当成依赖，于是每打一个字焦点就跳一次——
    // 那种 bug 在 jsdom 里看得见，在真实窗口里的表现是「输入框打着打着就不听话了」
    expect(document.activeElement).toBe(input())
    expect(replaceInput().value).toBe('')
  })
})
