// @vitest-environment jsdom
import { EditorView } from '@codemirror/view'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectPlatform } from './commands/keybinding'
import type { TextFile } from './ipc/fs'

/**
 * App 的接线测试：工具栏 → 命令中心 → 文档模型 → CM6 → signal → DOM 文本，整条链真的跑起来。
 *
 * **只有 IPC 与原生对话框是假的**（jsdom 里没有 Tauri 运行时）。`@tauri-apps/api/core`
 * 与 `@tauri-apps/plugin-dialog` 在没有运行时的环境下可以正常 import，它们只在被调用时
 * 才去摸 `window.__TAURI_INTERNALS__`——所以这里 mock 的是我们自己那一层 `./ipc/fs`，
 * 顺带也验证了「import 这两个包不会炸」这件事。
 *
 * 真·端到端（前端 → IPC → vela-core → 磁盘）只能靠 `pnpm tauri dev` 手工验，
 * 或者等 M1-H 的 CI 里加一个 Tauri driver。
 */

const { ipc, dialog, tauriEvent, tauriCore, sessionCmd, projectCmd, searchCmd } = vi.hoisted(() => {
  /**
   * 会话存档这一头（M1-F）。App 一挂载就会 `load_session`，关窗放行后会 `save_session`，
   * 所以这两个 command 的返回值必须有明确的形状：`load_session` 答 `undefined` 会被当成
   * 一份存档喂给 restoreSession，然后在提示条上留一句谁也看不懂的「undefined」。
   *
   * 类型写在**注解**上而不是 `null as unknown`：`restartWith()` 之后会往 archive / loadError
   * 里塞任意存档与任意错误，断言只在那一行字面量上把类型撑开，注解才真的把它们钉成可写字段。
   */
  const sessionCmd: { archive: unknown; loadError: unknown; saved: unknown[]; droppedDrafts: number } = {
    archive: null,
    loadError: null,
    saved: [],
    droppedDrafts: 0,
  }
  /**
   * 文件树这一头（M2-B）。`list_dir` 走的是 `tauriCore.invoke`，与 session 同一个入口，
   * 所以这里只放数据：`fs` 是 rel → 条目 的表，`calls` 记录调用顺序（懒加载与缓存命中
   * 都只能从「读了哪几层、读了几次」上看出来）。
   */
  const projectCmd: { fs: Record<string, unknown[]>; calls: string[] } = { fs: {}, calls: [] }
  /**
   * 全局搜索这一头（M2-C）。`start_search` 与 `cancel_search` 也走 `tauriCore.invoke`。
   *
   * ⚠️ `taskId` 是可写的，因为 store 认任务靠 `adopted`/`starting`/`retired` 三个变量
   * （见 src/search/store.ts 的模块文档）：一个用例里搜两轮时必须让第二轮拿到**不同的** id，
   * 否则它会被当成「已作废任务的迟到批次」整个丢掉，而那种绿是毫无意义的。
   */
  const searchCmd: { calls: { root: string; query: unknown }[]; cancelled: string[]; taskId: string } = {
    calls: [],
    cancelled: [],
    taskId: 'task-1',
  }
  return {
    ipc: {
      openFile: vi.fn<typeof import('./ipc/fs').openFile>(),
      saveFile: vi.fn<typeof import('./ipc/fs').saveFile>(),
      // 换成假的：它自己另有测试，这里只关心错误能落到提示条上（断言里靠 kind 字面量认出来）
      describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    },
    dialog: { open: vi.fn(), save: vi.fn() },
    // 关窗守卫（src/ipc/windowClose.ts）要用的两个 Tauri API。jsdom 里没有运行时，
    // 不 mock 的话 `listen` 会在 onMount 里抛，变成一个没人管的 rejection。
    tauriEvent: { listen: vi.fn() },
    tauriCore: { invoke: vi.fn() },
    sessionCmd,
    projectCmd,
    searchCmd,
  }
})

// 只假掉三个函数，**其余用真的**：状态栏要遍历 ENCODING_CHOICES / ENCODING_IDS /
// LINE_ENDING_IDS 渲染下拉，整体替换成假对象会让它在 render 里就抛（dispose 都不是函数，
// 38 条用例一起挂）。标签表本来也该是真的——那正是要显示给用户看的东西。
vi.mock('./ipc/fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ipc/fs')>()),
  openFile: ipc.openFile,
  saveFile: ipc.saveFile,
  describeFsError: ipc.describeFsError,
}))
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
vi.mock('@tauri-apps/api/event', () => tauriEvent)
vi.mock('@tauri-apps/api/core', () => tauriCore)

import App from './App'
import { MAX_PANES } from './doc/workspace'
import { SEARCH_BATCH_EVENT, SEARCH_DONE_EVENT, SEARCH_FAILED_EVENT } from './ipc/search'
import { REQUEST_CLOSE_EVENT } from './ipc/windowClose'

/**
 * `Mod` 在不同平台上是不同物理键，而 jsdom 的 UA 不含 "Mac" → detectPlatform() 判成 linux。
 * 所以按被测环境实际检测到的平台发键，而不是写死 metaKey。
 */
const modInit = (): KeyboardEventInit => (detectPlatform() === 'macos' ? { metaKey: true } : { ctrlKey: true })

let container: HTMLDivElement
let dispose: () => void

/** `listen` 收到的回调，按事件名收着。测试里手动触发，等于模拟 Rust 侧发事件 */
const listeners = new Map<string, (payload: unknown) => void>()

beforeEach(async () => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  tauriEvent.listen.mockReset()
  tauriCore.invoke.mockReset()
  listeners.clear()
  ipc.saveFile.mockResolvedValue({ bytesWritten: 6, unmappable: false })
  sessionCmd.archive = null
  sessionCmd.loadError = null
  sessionCmd.saved = []
  sessionCmd.droppedDrafts = 0
  projectCmd.calls = []
  searchCmd.calls = []
  searchCmd.cancelled = []
  searchCmd.taskId = 'task-1'
  projectCmd.fs = {
    '': [dirEntry('src', 'src', true), dirEntry('README.md', 'README.md', false), dirEntry('docs', 'docs', true)],
    src: [dirEntry('a.ts', 'src/a.ts', false), dirEntry('b.ts', 'src/b.ts', false)],
    docs: [dirEntry('intro.md', 'docs/intro.md', false)],
  }
  tauriCore.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'load_session') {
      // 复刻 Tauri IPC 的真实行为：command 返回 Err 时，invoke 的拒绝理由是 Rust 侧序列化出来的
      // 那个值本身（字符串或普通对象），**不是 Error 实例**。这里包一层 new Error，
      // 被测的就变成了另一条错误处理路径。
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (sessionCmd.loadError !== null) throw sessionCmd.loadError
      return sessionCmd.archive
    }
    if (cmd === 'save_session') {
      sessionCmd.saved.push(args?.session)
      return { bytesWritten: 120, droppedDrafts: sessionCmd.droppedDrafts }
    }
    if (cmd === 'list_dir') {
      // `args` 的值是 unknown：`String(unknown)` 会走到 Object 的默认字符串化，
      // 出错时给出的是 '[object Object]' 而不是真正的值，等于把线索抹掉
      const rel = typeof args?.rel === 'string' ? args.rel : ''
      const root = typeof args?.root === 'string' ? args.root : ''
      projectCmd.calls.push(rel)
      const entries = projectCmd.fs[rel]
      if (!entries) {
        // 与上面 load_session 同一条理由：Rust 的 Err 是被序列化后原样抛出的普通对象，
        // 包一层 new Error 就会让 describeTreeError 走到「兜底」那条分支上去
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { kind: 'not_found', path: `${root}/${rel}` }
      }
      return { rel, entries }
    }
    if (cmd === 'start_search') {
      searchCmd.calls.push({ root: typeof args?.root === 'string' ? args.root : '', query: args?.query })
      // ⚠️ 必须返回一个**字符串** taskId。落到下面那个 `return undefined` 的话，store 会把
      // undefined 认成当前任务，随后每一个事件都对不上号——面板永远停在「正在搜索…」，
      // 而后台其实早就搜完了，没有任何报错可查
      return searchCmd.taskId
    }
    if (cmd === 'cancel_search') {
      searchCmd.cancelled.push(typeof args?.taskId === 'string' ? args.taskId : '')
      return undefined
    }
    return undefined
  })
  tauriEvent.listen.mockImplementation(async (name: string, handler: (payload: unknown) => void) => {
    listeners.set(name, handler)
    return () => {
      listeners.delete(name)
    }
  })
  mountApp()
  // 关窗守卫的注册要等 `listen` 的 promise 落地，不然 listeners 还是空的
  await flush()
})

function mountApp() {
  container = document.createElement('div')
  document.body.appendChild(container)
  dispose = render(() => <App />, container)
}

/**
 * 换一份存档，重新走一遍启动。
 *
 * 会话只在挂载时读一次，所以改完 mock 必须重挂——直接在跑着的 App 上改
 * `sessionCmd.archive` 什么都不会发生，用例会绿得毫无意义。
 */
async function restartWith(archive: unknown, loadError: unknown = null) {
  dispose()
  container.remove()
  sessionCmd.archive = archive
  sessionCmd.loadError = loadError
  sessionCmd.saved = []
  mountApp()
  await flush()
}

afterEach(() => {
  dispose()
  container.remove()
  document.documentElement.removeAttribute('style')
})

/** 打开/保存是异步的：命令 execute → hook → invoke 有好几层微任务，一个宏任务就能冲干净 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 分屏容器，按屏幕顺序 */
function hosts(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.body > .editor-host')]
}

/** 每块分屏里的编辑器，按屏幕顺序 */
function views(): EditorView[] {
  return [...container.querySelectorAll<HTMLElement>('.editor-host .cm-editor')].map((dom) => {
    const found = EditorView.findFromDOM(dom)
    if (!found) throw new Error('拿不到 EditorView 实例')
    return found
  })
}

/** 第一块分屏的编辑器。多分屏的用例请用 `views()` */
function view(): EditorView {
  const all = views()
  if (all.length === 0) throw new Error('App 没有渲染出编辑器')
  return all[0]!
}

/**
 * 让第 index 块分屏拿到焦点。
 *
 * 不用 `view.focus()`：jsdom 只对带 tabindex / 可编辑表单元素派发 focus 事件，
 * CM6 的 contentDOM 靠 `contenteditable`，在 jsdom 里聚焦是静默无效操作。
 * 直接发一个冒泡的 focusin 更贴近真实链路——`EditorPane` 的 onFocusIn 就挂在容器上。
 */
function focusHost(index: number) {
  const host = hosts()[index]
  if (!host) throw new Error(`没有第 ${index} 块分屏`)
  const target = host.querySelector('.cm-content') ?? host
  target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
}

/**
 * 状态栏的格子。中间那几格（「选中 N 字符」「N 个选区」）是条件渲染的，下标不稳定，
 * 所以文档名取第一格、行数·字符数取最后一格，别按固定下标去数。
 * 顺手把空白归一化：JSX 里跨行写的文本会带缩进换行。
 */
function statusCells(): string[] {
  return [...container.querySelectorAll('.statusbar .status-cell')].map((c) =>
    (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

function statusName(): string {
  return statusCells()[0]!
}

function statusCounts(): string {
  const cells = statusCells()
  return cells[cells.length - 1]!
}

function notices(): { level: string; text: string }[] {
  return [...container.querySelectorAll('.notice')].map((n) => ({
    level: n.classList.contains('error') ? 'error' : n.classList.contains('warning') ? 'warning' : 'plain',
    text: n.textContent ?? '',
  }))
}

function button(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!el) throw new Error(`找不到按钮「${text}」`)
  return el
}

/** 标签条上的标签，按屏幕顺序 */
function tabs(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.tab-strip .tab')]
}

/** 假文件树的一个条目。`path` 一律按 `/repo` 拼，与 `projectCmd.fs` 的 key 对得上 */
function dirEntry(name: string, rel: string, isDir: boolean) {
  return { name, rel, path: `/repo/${rel}`, isDir }
}

function sidebar(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.sidebar')
}

function treeRowEls(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.tree-row')]
}

function treeNames(): string[] {
  return treeRowEls().map((el) => el.querySelector('.tree-name')?.textContent ?? '')
}

/** 按 rel 找那一行。根行的 rel 是空字符串，它的 path 就是 rootPath 本身 */
function treeRow(rel: string): HTMLElement {
  const path = rel === '' ? '/repo' : `/repo/${rel}`
  const el = treeRowEls().find((e) => e.title === path)
  if (!el) throw new Error(`树里找不到 ${rel}（渲染出来的有：${treeNames().join('、')}）`)
  return el
}

/** 「文件夹…」→ 目录对话框选中 /repo → 侧边栏自动显示。在 App 里这是用户的一次点击 */
async function openProject(): Promise<void> {
  dialog.open.mockResolvedValue('/repo')
  button('文件夹…').click()
  await flush()
}

/**
 * 侧边栏头部的 ↻ / ×。只能按 title 认：`×` 这个文本在整份 DOM 里不唯一
 * （标签条的关闭按钮也是它），`button('×')` 会抓到标签上去。
 */
function sidebarAct(titlePrefix: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>('.sidebar-head button')].find((b) =>
    b.title.startsWith(titlePrefix),
  )
  if (!el) throw new Error(`侧边栏头部找不到 title 以「${titlePrefix}」开头的按钮`)
  return el
}

function modal(): HTMLElement | null {
  return container.querySelector('.modal')
}

/** 对话框里的按钮。必须限定在 `.modal-actions` 里找——工具栏上也有一个叫「保存」的 */
function modalButton(label: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(
    (b) => b.textContent === label,
  )
  if (!el) throw new Error(`对话框里找不到按钮「${label}」`)
  return el
}

/** 模拟 Rust 侧拦下 CloseRequested / Cmd+Q 之后发来的那个事件 */
async function rustRequestsClose() {
  const handler = listeners.get(REQUEST_CLOSE_EVENT)
  if (!handler) throw new Error('关窗守卫没挂上')
  handler(undefined)
  await flush()
}

/**
 * 模拟 Rust 侧推来的一个搜索事件。
 *
 * ⚠️ handler 收的是 `{ payload }` 那个**信封**而不是 payload 本身：`attachSearchListeners`
 * 里写的是 `(e) => handlers.onBatch(e.payload.taskId, e.payload.batch)`（src/ipc/search.ts）。
 * 直接把 payload 递进去的话三处 `.payload` 全是 undefined，事件被静默吃掉，用例却照样绿——
 * 因为「没结果」与「面板刚展开还没搜」在 DOM 上长得一模一样
 */
async function fireSearch(name: string, payload: unknown): Promise<void> {
  const handler = listeners.get(name)
  if (!handler) throw new Error(`搜索监听没挂上：${name}`)
  handler({ payload })
  await flush()
}

function findPanel(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.find-panel')
}

function findInput(): HTMLInputElement {
  const el = findPanel()?.querySelector<HTMLInputElement>('.find-input')
  if (!el) throw new Error('面板里没有搜索词输入框')
  return el
}

/** 往搜索词输入框里敲字。这是一个普通 `<input>`，与 CM6 的 `typeText` 是两条路 */
function typeSearch(text: string): void {
  const el = findInput()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 在面板里按一个键。bubbles 是必需的：Solid 把 keydown 委托在 document 上 */
function pressInFind(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  findInput().dispatchEvent(event)
  return event
}

/** 结果列表里的行，按屏幕顺序。文件行与命中行混在同一个扁平数组里（见 src/search/rows.ts） */
function findRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.find-row')]
}

function findRowTexts(): string[] {
  return findRows().map((el) => el.textContent ?? '')
}

function findStatus(): string {
  return container.querySelector('.find-status-text')?.textContent ?? ''
}

/**
 * 面板头部的按钮。**找不到时返回 null 而不是抛**：
 * 「取消」只在搜索进行中才渲染，而「此刻它不该在」正是几条用例要钉的东西，
 * 用全局的 `button()`（找不到就抛）就没法表达了
 */
function findButton(label: string): HTMLButtonElement | null {
  const all = [...(findPanel()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  return all.find((b) => b.textContent === label) ?? null
}

function fontSizeSelect(): HTMLSelectElement {
  const el = [...container.querySelectorAll('select')].find((s) => s.title.startsWith('字号'))
  if (!el) throw new Error('找不到字号 select')
  return el
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

/** 敲字走 CM6 的事务，等于用户在编辑器里真的输入 */
function typeText(text: string) {
  const v = view()
  v.dispatch({ changes: { from: v.state.doc.length, insert: text } })
}

/** 往指定那块分屏敲字。带上 selection：真敲字会把光标落在插入文本之后 */
function typeInto(index: number, text: string) {
  const v = views()[index]
  if (!v) throw new Error(`没有第 ${index} 块分屏`)
  const at = v.state.doc.length
  v.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
}

function textFile(overrides: Partial<{ text: string; lossy: boolean }> = {}) {
  return {
    text: '正文',
    format: { encoding: 'utf8' as const, bom: false, eol: 'lf' as const },
    lossy: false,
    bytes: 6,
    ...overrides,
  }
}

describe('App 接线', () => {
  it('挂载后编辑器就位，状态栏报出空文档的度量', () => {
    expect(container.querySelector('.editor-container .cm-editor')).not.toBeNull()
    expect(statusName()).toBe('空文档')
    // CM6 把空文档算作「一行空行」，所以是 1 行 0 字符，不是 0 行
    expect(statusCounts()).toBe('1 行 · 0 字符')
    // 提示条容器常驻但没有内容：它占着 grid 的第二行，行数必须是固定的
    expect(container.querySelector('.notices')).not.toBeNull()
    expect(container.querySelector('.notice')).toBeNull()
  })

  it('输入会经 onUpdate 推到状态栏（CM6 → signal 的回路在真实 App 里通）', () => {
    typeText('第一行\n第二行\n第三行')
    expect(statusCounts()).toBe('3 行 · 11 字符')
  })

  it('Alt+Z 经命令中心切换换行，按钮标签与编辑器状态同时更新', () => {
    const wrapButton = [...container.querySelectorAll('button')].find((b) => b.title === 'Alt+Z')
    expect(wrapButton?.textContent).toBe('开')

    press('z', { altKey: true })
    expect(wrapButton?.textContent).toBe('关')
    expect(
      view()
        .state.facet(EditorView.contentAttributes)
        .some((a) => typeof a !== 'function' && a.class === 'cm-lineWrapping'),
    ).toBe(false)

    press('z', { altKey: true })
    expect(wrapButton?.textContent).toBe('开')
  })

  it('Mod+= / Mod+- / Mod+0 改字号，CSS 变量与 select 同步', () => {
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')

    press('=', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('15px')
    expect(fontSizeSelect().value).toBe('15')

    press('-', modInit())
    press('-', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('13px')

    press('0', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')
  })

  it('字号只在预设档位间走，不会冒出 select 显示不了的档外值', () => {
    // 从最小档继续缩小应当停在 12px
    press('0', modInit())
    press('-', modInit())
    press('-', modInit())
    press('-', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('12px')
    expect(fontSizeSelect().value).toBe('12')
  })

  it('「新建」另开一个空标签，状态栏与编辑器都跟着换过去', () => {
    typeText('a\nb\nc\nd')
    expect(statusCounts()).toBe('4 行 · 7 字符')

    button('新建').click()

    expect(tabs()).toHaveLength(2)
    expect(view().state.doc.toString()).toBe('')
    expect(statusName()).toBe('空文档')
    expect(statusCounts()).toBe('1 行 · 0 字符')
  })

  /*
   * M1-D 的核心承诺：切标签只换 state，不重建 view。
   *
   * 一旦有人把 `state` 当成响应式 props 传进 EditorPane（或者在 Solid 里给它套上
   * `<Show>`/keyed `<For>`），这个节点就会被换掉——撤销历史、滚动位置、查找面板的
   * 输入框内容全丢，而且每切一次标签都要重跑一遍 CM6 的初始测量。
   */
  it('切换标签时编辑器 DOM 节点是同一个，view 没有被重建', () => {
    const before = container.querySelector('.cm-editor')
    typeText('第一份')

    button('新建').click()
    typeText('第二份')
    tabs()[0]!.click()

    expect(container.querySelector('.cm-editor')).toBe(before)
    expect(view().state.doc.toString()).toBe('第一份')
    expect(statusCounts()).toBe('1 行 · 3 字符')
  })

  it('卸载后全局快捷键监听被摘掉，不会再驱动已销毁的编辑器', () => {
    dispose()
    // 重新挂一个空的，避免 afterEach 再 dispose 一次已卸载的树
    dispose = () => {}
    expect(() => press('z', { altKey: true })).not.toThrow()
    expect(container.querySelector('.cm-editor')).toBeNull()
  })
})

describe('文件生命周期接线', () => {
  it('打开文件：正文进编辑器，徽章换成文件名，度量跟着变，且不显示为脏', async () => {
    dialog.open.mockResolvedValue('/Users/x/notes/win.txt')
    ipc.openFile.mockResolvedValue(textFile({ text: '第一行\n第二行\n' }))

    button('打开…').click()
    await flush()

    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: false })
    expect(view().state.doc.toString()).toBe('第一行\n第二行\n')
    // 状态栏只显示 basename，全路径挂在 title 上
    expect(statusName()).toBe('win.txt')
    expect(container.querySelector<HTMLElement>('.status-path')?.title).toBe('/Users/x/notes/win.txt')
    expect(statusCounts()).toBe('3 行 · 8 字符')
    expect(notices()).toEqual([])
  })

  it('打开后立刻输入才置脏，Mod+S 保存后脏标记消失', async () => {
    dialog.open.mockResolvedValue('/a.txt')
    ipc.openFile.mockResolvedValue(textFile({ text: '原文' }))
    button('打开…').click()
    await flush()
    // 整篇替换正文不算用户改动——这条是 `replacing` 标志存在的全部理由
    expect(statusName()).toBe('a.txt')

    typeText('改')
    expect(statusName()).toBe('● a.txt')

    press('s', modInit())
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '原文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(statusName()).toBe('a.txt')
  })

  it('光标移动不置脏', () => {
    typeText('abc')
    const before = statusName()
    view().dispatch({ selection: { anchor: 0 } })
    expect(statusName()).toBe(before)
  })

  it('无名文档按 Mod+S 会落到另存为，用对话框拿到路径再写', async () => {
    dialog.save.mockResolvedValue('/chosen/new.txt')
    typeText('新内容')
    expect(statusName()).toBe('● 空文档')

    press('s', modInit())
    await flush()

    expect(dialog.save).toHaveBeenCalled()
    expect(ipc.saveFile).toHaveBeenCalledWith('/chosen/new.txt', '新内容', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(statusName()).toBe('new.txt')
  })

  it('另存为用 Mod+Shift+S，不会被 Mod+S 吃掉', async () => {
    dialog.save.mockResolvedValue('/copy.txt')
    typeText('x')

    press('S', { ...modInit(), shiftKey: true })
    await flush()

    expect(dialog.save).toHaveBeenCalledOnce()
    expect(statusName()).toBe('copy.txt')
  })

  it('对话框取消时什么都不动', async () => {
    dialog.open.mockResolvedValue(null)
    button('打开…').click()
    await flush()
    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(statusName()).toBe('空文档')
  })

  it('打开失败时报出错误，并且另开一个干净标签来承载——草稿一动不动', async () => {
    typeText('手稿')
    dialog.open.mockResolvedValue('/huge.log')
    ipc.openFile.mockRejectedValue({ kind: 'too_large', bytes: 5_000_000, limit: 4_194_304 })

    button('打开…').click()
    await flush()

    // 草稿标签是脏的，所以 openAt 不复用它：错误落在新开的空标签上
    const list = notices()
    expect(list).toHaveLength(1)
    expect(list[0]!.level).toBe('error')
    expect(list[0]!.text).toContain('too_large')
    expect(view().state.doc.toString()).toBe('')
    expect(statusName()).toBe('空文档')

    container.querySelector<HTMLButtonElement>('.notice-close')?.click()
    expect(notices()).toEqual([])

    // 切回第一个标签，草稿还在，脏标记也还在
    tabs()[0]!.click()
    expect(view().state.doc.toString()).toBe('手稿')
    expect(statusName()).toBe('● 空文档')
    expect(notices()).toEqual([])
  })

  it('有损解码的文件常驻一条警告，关掉提示条也不会消失', async () => {
    dialog.open.mockResolvedValue('/broken.bin')
    ipc.openFile.mockResolvedValue(textFile({ text: 'a\uFFFDb', lossy: true }))

    button('打开…').click()
    await flush()

    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.level).toBe('warning')
    expect(notices()[0]!.text).toContain('永久损坏')
    // 这条不是 notice 而是文档属性，没有关闭按钮
    expect(container.querySelector('.notice-close')).toBeNull()
  })

  it('保存时编码装不下字符会警告，但脏标记照样清零（盘确实写了）', async () => {
    dialog.open.mockResolvedValue('/gbk.txt')
    ipc.openFile.mockResolvedValue({
      text: '中文',
      format: { encoding: 'gbk' as const, bom: false, eol: 'lf' as const },
      lossy: false,
      bytes: 4,
    })
    button('打开…').click()
    await flush()
    typeText('😀')
    ipc.saveFile.mockResolvedValue({ bytesWritten: 12, unmappable: true })

    press('s', modInit())
    await flush()

    const list = notices()
    expect(list).toHaveLength(1)
    expect(list[0]!.level).toBe('warning')
    expect(list[0]!.text).toContain('GBK')
    expect(statusName()).toBe('gbk.txt')
  })

  it('IO 进行中四个文档按钮都是 disabled 的', async () => {
    let release!: (v: TextFile) => void
    dialog.open.mockResolvedValue('/a.txt')
    ipc.openFile.mockReturnValue(new Promise((resolve) => (release = resolve)))

    button('打开…').click()
    await flush()

    for (const label of ['新建', '打开…', '保存', '另存为…']) {
      expect(button(label).disabled, `${label} 在 IO 期间应当禁用`).toBe(true)
    }

    release(textFile())
    await flush()
    expect(button('保存').disabled).toBe(false)
  })
})

describe('关闭确认接线', () => {
  function closeTabButton(index: number): HTMLButtonElement {
    const el = tabs()[index]!.querySelector<HTMLButtonElement>('.tab-close')
    if (!el) throw new Error('标签上找不到关闭按钮')
    return el
  }

  /** 打开一个文件再改一个字，得到一个有路径的脏标签 */
  async function dirtyFileTab(path = '/a.txt', extra = '改') {
    dialog.open.mockResolvedValue(path)
    ipc.openFile.mockResolvedValue(textFile({ text: '正文' }))
    button('打开…').click()
    await flush()
    typeText(extra)
  }

  it('关掉干净标签不弹对话框', async () => {
    closeTabButton(0).click()
    await flush()
    expect(modal()).toBeNull()
    expect(statusName()).toBe('空文档')
  })

  it('关掉脏标签弹出三选一，标题里带文件名', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    expect(modal()?.getAttribute('role')).toBe('alertdialog')
    expect(modal()?.getAttribute('aria-label')).toBe('「a.txt」有未保存的改动')
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')].map((b) => b.textContent),
    ).toEqual(['取消', '不保存', '保存'])
  })

  it('默认焦点落在「保存」上——什么都不看直接按回车不该是丢数据', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()
    expect(document.activeElement).toBe(modalButton('保存'))
  })

  it('点「取消」：对话框消失，标签与脏标记都留着', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    modalButton('取消').click()
    await flush()

    expect(modal()).toBeNull()
    expect(tabs()).toHaveLength(1)
    expect(statusName()).toBe('● a.txt')
    expect(view().state.doc.toString()).toBe('正文改')
  })

  it('按 Escape 等于取消', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    modal()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush()

    expect(modal()).toBeNull()
    expect(tabs()).toHaveLength(1)
  })

  it('点「不保存」：一个字节都不写，标签直接没了', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    modalButton('不保存').click()
    await flush()

    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(modal()).toBeNull()
    // 关掉的是唯一的标签，补进来一个空的
    expect(tabs()).toHaveLength(1)
    expect(statusName()).toBe('空文档')
  })

  it('点「保存」：写盘之后才关', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    modalButton('保存').click()
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(modal()).toBeNull()
    expect(statusName()).toBe('空文档')
  })

  it('Rust 发来关窗事件：没有未保存改动时直接关，不弹对话框', async () => {
    await rustRequestsClose()
    expect(modal()).toBeNull()
    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
  })

  it('Rust 发来关窗事件：有未保存改动时先问，答「不保存」才真的关', async () => {
    await dirtyFileTab()

    await rustRequestsClose()
    expect(tauriCore.invoke).not.toHaveBeenCalledWith('close_window')
    expect(modal()?.getAttribute('aria-label')).toBe('「a.txt」有未保存的改动')

    modalButton('不保存').click()
    await flush()

    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
    expect(modal()).toBeNull()
  })

  it('Rust 发来关窗事件：答「取消」就什么都不做，窗口留着', async () => {
    await dirtyFileTab()

    await rustRequestsClose()
    modalButton('取消').click()
    await flush()

    expect(tauriCore.invoke).not.toHaveBeenCalledWith('close_window')
    expect(modal()).toBeNull()
    expect(statusName()).toBe('● a.txt')
  })

  it('多个脏标签时一次列出全部文件名，而不是一个一个弹', async () => {
    await dirtyFileTab('/a.txt', '改')
    button('新建').click()
    await dirtyFileTab('/b.txt', '也改')

    await rustRequestsClose()

    expect(modal()?.getAttribute('aria-label')).toBe('2 个文档有未保存的改动')
    expect([...container.querySelectorAll('.modal-list li')].map((li) => li.textContent)).toEqual(['a.txt', 'b.txt'])

    modalButton('保存').click()
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(ipc.saveFile).toHaveBeenCalledWith('/b.txt', '正文也改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
  })
})

describe('分屏接线', () => {
  /** 聚焦标记。用 class 而不是 document.activeElement：jsdom 里 CM6 的聚焦是无效操作 */
  const focused = () => hosts().findIndex((h) => h.classList.contains('focused'))

  it('点「右分屏」多出一块编辑区，焦点交给新的那块，标签条也多一个标签', () => {
    expect(hosts()).toHaveLength(1)
    expect(button('合并').disabled).toBe(true) // 只剩一块时没得合

    button('右分屏').click()

    expect(hosts()).toHaveLength(2)
    expect(views()).toHaveLength(2)
    // 两块是各自独立的 EditorView，不是同一个实例被引用两次
    expect(views()[0]).not.toBe(views()[1])
    expect(focused()).toBe(1)
    expect(tabs()).toHaveLength(2)
    expect(statusName()).toBe('空文档')
    expect(button('合并').disabled).toBe(false)
    expect(container.querySelector('.body')?.classList.contains('column')).toBe(false)
  })

  it('点「下分屏」把整排改成竖着排', () => {
    button('下分屏').click()
    expect(hosts()).toHaveLength(2)
    expect(container.querySelector('.body')?.classList.contains('column')).toBe(true)
  })

  it('到 MAX_PANES 之后两个分屏按钮都 disabled，再点也不会多出一块', () => {
    for (let n = 2; n <= MAX_PANES; n++) {
      button('右分屏').click()
      expect(hosts()).toHaveLength(n)
    }
    expect(button('右分屏').disabled).toBe(true)
    expect(button('下分屏').disabled).toBe(true)

    button('右分屏').click()
    expect(hosts()).toHaveLength(MAX_PANES)
  })

  it('两块分屏各敲各的，状态栏只报聚焦的那块', () => {
    typeInto(0, 'AAAA')
    button('右分屏').click()
    typeInto(1, 'BBBBBBB')

    expect(views()[0]!.state.doc.toString()).toBe('AAAA')
    expect(views()[1]!.state.doc.toString()).toBe('BBBBBBB')
    expect(statusCounts()).toBe('1 行 · 7 字符')

    // 往没聚焦的那块敲字不该动状态栏——度量是「聚焦分屏的标签」的属性
    typeInto(0, 'CC')
    expect(statusCounts()).toBe('1 行 · 7 字符')

    focusHost(0)
    expect(focused()).toBe(0)
    expect(statusCounts()).toBe('1 行 · 6 字符')
  })

  it('Mod+\\ 与 Mod+Shift+\\ 与按钮走同一条路', () => {
    press('\\', modInit())
    expect(hosts()).toHaveLength(2)
    expect(container.querySelector('.body')?.classList.contains('column')).toBe(false)

    press('\\', { ...modInit(), shiftKey: true })
    expect(hosts()).toHaveLength(3)
    expect(container.querySelector('.body')?.classList.contains('column')).toBe(true)
  })

  it('Mod+Alt+→ 把焦点交给下一块分屏，并回绕', () => {
    button('右分屏').click()
    expect(focused()).toBe(1)

    press('ArrowRight', { ...modInit(), altKey: true })
    expect(focused()).toBe(0)

    press('ArrowLeft', { ...modInit(), altKey: true })
    expect(focused()).toBe(1)
  })

  it('编辑器里聚焦会把那块分屏标成 focused，度量也跟着回去', () => {
    button('右分屏').click()
    typeInto(1, 'BBBBBBB')
    expect(focused()).toBe(1)
    expect(statusCounts()).toBe('1 行 · 7 字符')

    focusHost(0)

    expect(focused()).toBe(0)
    expect(statusCounts()).toBe('1 行 · 0 字符')
  })

  it('合并掉带未保存改动的分屏不丢稿子：标签留在条上，点回去正文还在', () => {
    typeInto(0, '左边')
    button('右分屏').click()
    typeInto(1, '草稿')

    button('合并').click()

    expect(hosts()).toHaveLength(1)
    expect(tabs()).toHaveLength(2)
    expect(tabs()[1]!.textContent).toContain('●')

    tabs()[1]!.click()
    expect(views()[0]!.state.doc.toString()).toBe('草稿')
    expect(statusCounts()).toBe('1 行 · 2 字符')
  })

  it('合并到只剩一块之后「合并」按钮重新 disabled', () => {
    button('右分屏').click()
    button('合并').click()
    expect(hosts()).toHaveLength(1)
    expect(button('合并').disabled).toBe(true)
  })
})

describe('会话恢复接线（M1-F）', () => {
  /**
   * 存档里的一个标签。字段形状由 `src/ipc/session.ts` 与 Rust 侧的契约测试钉住，
   * 这里只负责填内容——重复写全 14 个字段会让每条用例的重点淹在样板里。
   */
  function savedTab(over: Record<string, unknown> = {}) {
    return {
      path: null,
      format: { encoding: 'utf8', bom: false, eol: 'lf' },
      dirty: false,
      lossy: false,
      draft: null,
      selection: [[0, 0]],
      main: 0,
      scrollTop: 0,
      scrollLeft: 0,
      ...over,
    }
  }

  function savedSession(tabs: unknown[], over: Record<string, unknown> = {}) {
    return { version: 1, direction: 'row', focused: 0, tabs, panes: [0], ...over }
  }

  /** 最近一次写出去的存档 */
  function lastArchive(): {
    tabs: { path: string | null; draft: string | null; dirty: boolean }[]
    panes: number[]
    focused: number
  } {
    const last = sessionCmd.saved[sessionCmd.saved.length - 1]
    if (!last) throw new Error('还没有写过存档')
    return last as {
      tabs: { path: string | null; draft: string | null; dirty: boolean }[]
      panes: number[]
      focused: number
    }
  }

  /** 打开一个文件并把正文改成脏的。关窗确认会拦住它，用例自己决定怎么答 */
  async function dirtyFileTab(path = '/a.txt', extra = '改') {
    dialog.open.mockResolvedValue(path)
    ipc.openFile.mockResolvedValue(textFile({ text: '正文' }))
    button('打开…').click()
    await flush()
    typeText(extra)
  }

  it('启动时把上次的标签读回来：干净的重读磁盘，脏的照抄草稿', async () => {
    // beforeEach 只 reset 了 openFile、没给默认返回值：恢复干净标签走的正是这条路
    ipc.openFile.mockResolvedValue(textFile({ text: '磁盘上的样子' }))
    await restartWith(
      savedSession([savedTab({ path: '/a.txt' }), savedTab({ draft: '没存过的稿子', dirty: true })], {
        focused: 1,
        panes: [0, 1],
      }),
    )

    expect(tabs()).toHaveLength(2)
    expect(tabs()[0]!.textContent).toContain('a.txt')
    expect(tabs()[1]!.textContent).toContain('● 空文档')
    expect(hosts()).toHaveLength(2)
    // 干净又有路径的那个是**重新读盘**的：Vela 关着的时候文件可能被别的程序改过
    expect(views()[0]!.state.doc.toString()).toBe('磁盘上的样子')
    expect(ipc.openFile).toHaveBeenCalledWith('/a.txt')
    expect(views()[1]!.state.doc.toString()).toBe('没存过的稿子')
    // focused: 1 是**分屏**下标，所以状态栏报的是第二个标签
    expect(statusName()).toBe('● 空文档')
    expect(hosts()[1]!.classList.contains('focused')).toBe(true)
  })

  it('存档读不回来：提示条说一句，编辑器照常能用', async () => {
    await restartWith(null, { kind: 'corrupt', message: '第 2 个标签没有选区' })

    const [notice] = notices()
    expect(notice!.level).toBe('warning')
    expect(notice!.text).toContain('上次的会话没能读回来')
    expect(notice!.text).toContain('第 2 个标签没有选区')
    // 关键是应用没死：留着初始那个空标签，还能打字
    expect(tabs()).toHaveLength(1)
    typeText('还能打字')
    expect(statusCounts()).toBe('1 行 · 4 字符')
  })

  it('关窗放行后把会话写下去：分屏布局与聚焦的分屏都进存档', async () => {
    button('右分屏').click()
    expect(hosts()).toHaveLength(2)

    await rustRequestsClose()

    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
    expect(sessionCmd.saved).toHaveLength(1)
    expect(lastArchive().tabs).toHaveLength(2)
    expect(lastArchive().panes).toEqual([0, 1])
    expect(lastArchive().focused).toBe(1)
  })

  it('答「不保存」：被扔掉的稿子不会跟着存档回来', async () => {
    // 这条是 M1-F 与 M1-D 的接缝。有了会话存档之后，「不保存」不再等于「窗口一关就没了」：
    // 存档收草稿的条件就是脏标记，不清掉它，用户刚刚明确扔掉的东西下次启动会原样端回来
    await dirtyFileTab()

    await rustRequestsClose()
    expect(sessionCmd.saved).toHaveLength(0) // 没放行之前一个字节都不写
    modalButton('不保存').click()
    await flush()

    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(lastArchive().tabs[0]!.path).toBe('/a.txt')
    expect(lastArchive().tabs[0]!.dirty).toBe(false)
    expect(lastArchive().tabs[0]!.draft).toBeNull()
  })

  it('答「保存」：先落盘，存档里那个文档是干净的，下次启动重新读盘', async () => {
    await dirtyFileTab()

    await rustRequestsClose()
    modalButton('保存').click()
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
    expect(lastArchive().tabs[0]!.draft).toBeNull()
    expect(lastArchive().tabs[0]!.dirty).toBe(false)
  })

  it('答「取消」时一个字节都不写：用户没同意关，现场不该被当成已经存好了', async () => {
    await dirtyFileTab('/a.txt', '不想丢的稿子')

    await rustRequestsClose()
    modalButton('取消').click()
    await flush()

    expect(tauriCore.invoke).not.toHaveBeenCalledWith('close_window')
    expect(sessionCmd.saved).toHaveLength(0)
    // 稿子还在，脏标记也还在
    expect(statusName()).toBe('● a.txt')
  })

  it('现场没变过就不重复写：关两次也只存一份', async () => {
    await rustRequestsClose()
    await rustRequestsClose()

    expect(sessionCmd.saved).toHaveLength(1)
  })

  it('草稿超预算被丢掉时说出来，而且可以关掉', async () => {
    sessionCmd.droppedDrafts = 2
    button('右分屏').click()

    await rustRequestsClose()

    const [notice] = notices()
    expect(notice!.level).toBe('warning')
    expect(notice!.text).toContain('2 个文档')
    expect(notice!.text).toContain('没能存进会话')

    container.querySelector<HTMLButtonElement>('.notice-close')!.click()
    expect(container.querySelector('.notice')).toBeNull()
  })

  it('卸载时把节流定时器停掉：组件没了它还每 5 秒醒一次就是泄漏', async () => {
    // 这条盯的是 App 有没有接 `stop()`。真的 setInterval 在 jsdom 里是活的，
    // 不停掉的话它会在这个用例结束之后继续跑，把断言写到别的用例的存档里
    const before = sessionCmd.saved.length
    dispose()
    container.remove()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sessionCmd.saved).toHaveLength(before)
    // afterEach 还会 dispose 一次，重复调用必须安全
    mountApp()
  })
})

describe('侧边栏接线（M2-B）', () => {
  it('默认不渲染侧边栏，而 .body 被包在 .body-row → .main 两层里', () => {
    expect(sidebar()).toBeNull()
    const body = container.querySelector('.body')!
    // M2-B 那一层横向 flex：侧边栏与正文区并排
    expect(body.parentElement?.classList.contains('body-row')).toBe(true)
    // M2-C 那一层纵向 flex：正文区在上、全局搜索面板在下。
    // 两层都只是**包在原来那份 1fr 里面**，`.app` 的 grid 一个字没改
    expect(body.parentElement?.parentElement?.classList.contains('main')).toBe(true)
    expect(body.parentElement?.parentElement?.parentElement?.classList.contains('app')).toBe(true)
    expect(container.querySelectorAll('.body > .editor-host')).toHaveLength(1)
  })

  it('⚠️ .app 的 grid 子元素仍然是五个，搜索面板不算第六个', () => {
    // styles.css 里那条注释警告的正是这件事：`.app` 是行数固定的 grid，
    // 多出来的东西一旦成了 grid item，`1fr` 就会落到错误的行上，正文区被挤掉。
    // 所以面板必须住在 `.main` 里面，而不是直接当 `.app` 的孩子
    const app = container.querySelector('.app')!
    expect([...app.children].map((el) => el.className)).toEqual([
      'toolbar',
      'tab-strip',
      'notices',
      'main',
      'statusbar',
    ])
    // 默认没搜过，面板整个不渲染：没开过搜索的用户看到的布局与加这两层之前逐像素相同
    expect(container.querySelector('.find-panel')).toBeNull()
  })

  it('Mod+B 与工具栏按钮走同一条路，按钮标签跟着翻', () => {
    expect(sidebar()).toBeNull()
    // button() 找不到就抛，所以这一句同时钉住了「标签写的是关」
    expect(button('侧边栏关').title).toBe('Mod+B')

    press('b', modInit())
    expect(sidebar()).not.toBeNull()
    expect(button('侧边栏开')).toBeDefined()

    button('侧边栏开').click()
    expect(sidebar()).toBeNull()
    expect(button('侧边栏关')).toBeDefined()
  })

  it('点「文件夹…」弹原生目录对话框，选中之后侧边栏自动显示、树长出根与孩子', async () => {
    await openProject()

    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: true })
    expect(sidebar()).not.toBeNull()
    expect(container.querySelector('.sidebar-title')?.textContent).toBe('repo')
    expect(treeNames()).toEqual(['repo', 'src', 'README.md', 'docs'])
    expect(projectCmd.calls).toEqual([''])
  })

  it('目录对话框取消时侧边栏不显示：用户什么都没选，不该凭空弹出一条空栏', async () => {
    dialog.open.mockResolvedValue(null)
    button('文件夹…').click()
    await flush()

    expect(sidebar()).toBeNull()
    expect(projectCmd.calls).toEqual([])
  })

  it('树是懒加载的：只有点开的那一层才去读盘', async () => {
    await openProject()

    treeRow('src').click()
    await flush()

    expect(treeNames()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
    expect(projectCmd.calls).toEqual(['', 'src'])
    // docs 从没被点开，就一次都不该读——十万行的仓库全靠这条撑着
    expect(projectCmd.calls).not.toContain('docs')
  })

  it('点树里的文件走的是同一套打开流程：正文进编辑器、标签名与状态栏跟着变', async () => {
    await openProject()
    treeRow('src').click()
    await flush()
    ipc.openFile.mockResolvedValue(textFile({ text: '从树里打开的正文' }))

    treeRow('src/a.ts').click()
    await flush()

    expect(ipc.openFile).toHaveBeenCalledWith('/repo/src/a.ts')
    expect(view().state.doc.toString()).toBe('从树里打开的正文')
    expect(statusName()).toBe('a.ts')
    expect(tabs()[0]!.querySelector('.tab-name')?.textContent).toBe('a.ts')
  })

  it('点头部的 × 关掉根：树回到空状态，但侧边栏本身留着', async () => {
    await openProject()

    sidebarAct('关闭文件夹').click()

    // 刻意不跟着收起：那条「打开文件夹…」正是用户下一步要点的东西，
    // 顺手把栏藏掉等于把他刚用过的入口拿走
    expect(sidebar()).not.toBeNull()
    expect(container.querySelector('.sidebar-open')?.textContent).toBe('打开文件夹…')
    expect(treeRowEls()).toHaveLength(0)
    expect(statusName()).toBe('空文档') // 已打开的标签一个都没动
  })

  it('点头部的 ↻ 重读所有摊开的层', async () => {
    await openProject()
    treeRow('src').click()
    await flush()

    sidebarAct('重新读取').click()
    await flush()

    expect(projectCmd.calls).toEqual(['', 'src', '', 'src'])
  })

  it('收起再展开侧边栏，树的状态原样还在，而且一次都不重读', async () => {
    await openProject()
    treeRow('src').click()
    await flush()
    expect(projectCmd.calls).toEqual(['', 'src'])

    press('b', modInit())
    expect(sidebar()).toBeNull()
    press('b', modInit())

    // `<Show>` 收起时是真的把组件卸了，重新挂上时读的是 store 里的缓存——
    // 状态在 store 而不在组件里，这正是「收起侧边栏不该丢展开进度」的实现方式
    expect(treeNames()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
    expect(projectCmd.calls).toEqual(['', 'src'])
  })

  it('读不出来的一层把错误挂在行内，不影响别的层', async () => {
    // `locked` 只在根那一层的条目里出现，`projectCmd.fs` 里没有它——
    // 于是 list_dir 会以 not_found 拒绝，正是「目录被外部删掉/权限不够」那个处境
    projectCmd.fs[''] = [...projectCmd.fs['']!, dirEntry('locked', 'locked', true)]
    await openProject()

    treeRow('locked').click()
    await flush()

    const row = treeRow('locked')
    expect(row.classList.contains('failed')).toBe(true)
    expect(row.querySelector('.tree-note.bad')?.textContent).toContain('找不到')
    // 别的层照常渲染，一个都没被牵连
    expect(treeNames()).toEqual(['repo', 'src', 'README.md', 'docs', 'locked'])
  })

  /** 存档里一个标签的形状。只关心 project 那一半，所以标签部分给最简单的干净文件 */
  function archiveWith(project: unknown) {
    return {
      version: 1,
      direction: 'row',
      focused: 0,
      tabs: [
        {
          path: '/a.txt',
          format: { encoding: 'utf8', bom: false, eol: 'lf' },
          dirty: false,
          lossy: false,
          draft: null,
          selection: [[0, 0]],
          main: 0,
          scrollTop: 0,
          scrollLeft: 0,
        },
      ],
      panes: [0],
      project,
    }
  }

  it('上次开着文件夹：启动后侧边栏自己展开，树摊到存档里那一层', async () => {
    ipc.openFile.mockResolvedValue(textFile({ text: '磁盘上的样子' }))
    projectCmd.calls = []

    await restartWith(archiveWith({ root: '/repo', expanded: ['', 'src'] }))

    // 树恢复好了却看不见，等于没恢复——所以侧边栏要跟着存档一起回来
    expect(sidebar()).not.toBeNull()
    expect(button('侧边栏开')).toBeDefined()
    expect(treeNames()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
    // 只读存档里摊开的那两层，`docs` 一次都没读（懒加载在恢复路径上照样成立）
    expect([...projectCmd.calls].sort()).toEqual(['', 'src'])
    // 标签那一半同时装好了：两半是并行的
    expect(statusName()).toBe('a.txt')
  })

  it('上次没开文件夹：侧边栏保持收起，不弹一条空栏出来', async () => {
    ipc.openFile.mockResolvedValue(textFile({ text: '磁盘上的样子' }))
    projectCmd.calls = []

    await restartWith(archiveWith(null))

    expect(sidebar()).toBeNull()
    expect(button('侧边栏关')).toBeDefined()
    expect(projectCmd.calls).toEqual([])
    expect(statusName()).toBe('a.txt')
  })

  it('关掉文件夹之后，写出去的存档里 project 是 null', async () => {
    // 这条走的是「写」的方向：用户开着项目、然后关掉了文件夹，
    // 关窗补存的那一份必须把 project 写成 null，否则下次启动又把他关掉的东西弹回来
    await openProject()
    expect(button('侧边栏开')).toBeDefined()

    sidebarAct('关闭文件夹').click()
    await flush()
    // 侧边栏本身留着，显示那个「打开文件夹…」的空状态——那正是用户下一步要点的东西
    expect(sidebar()).not.toBeNull()

    await rustRequestsClose()

    const last = sessionCmd.saved[sessionCmd.saved.length - 1] as { project: unknown }
    expect(last.project).toBeNull()
  })
})

describe('全局搜索接线（M2-C）', () => {
  it('⚠️ 三个搜索事件在挂载时就挂上了，不是每次搜索挂一遍', () => {
    // `listen` 本身是异步的，注册之前到达的事件**永久丢失**。而 `start_search` 是
    // 先 spawn 后台线程再返回 taskId 的，所以「事件已经在路上」与「前端还没挂好」
    // 这两件事会重叠。丢掉的偏偏是最前面那几批，表现是「共 87 处」与列表里的条数对不上——
    // 一个没有任何报错可查的静默漏数
    expect(listeners.has(SEARCH_BATCH_EVENT)).toBe(true)
    expect(listeners.has(SEARCH_DONE_EVENT)).toBe(true)
    expect(listeners.has(SEARCH_FAILED_EVENT)).toBe(true)
    // 关窗守卫那一个也还挂着：两组监听共用同一个 `listen` 桩，
    // 谁把对方顶掉了这里会一起红
    expect(listeners.has(REQUEST_CLOSE_EVENT)).toBe(true)
  })

  it('还没搜过时面板整个不渲染，正文区独占 .main', () => {
    expect(container.querySelector('.find-panel')).toBeNull()
    const main = container.querySelector('.main')!
    expect([...main.children].map((el) => el.className)).toEqual(['body-row'])
  })

  it('Mod+Shift+F 与工具栏那个「搜索…」按钮是两个入口、同一条路', async () => {
    expect(button('搜索…').title).toBe('Mod+Shift+F')

    press('F', { ...modInit(), shiftKey: true })
    await flush()
    // ⚠️ 面板必须是 `.main` 的**第二个孩子**，与 `.body-row` 平级：
    // 它要占的是正文区下方那份高度，而不是 `.app` 的第六个 grid 行
    expect([...container.querySelector('.main')!.children].map((el) => el.className)).toEqual([
      'body-row',
      'find-panel',
    ])
    // 展开就该把焦点放进输入框，否则用户按了快捷键还得去够鼠标
    expect(document.activeElement).toBe(findInput())

    pressInFind('Escape')
    await flush()
    expect(findPanel()).toBeNull()

    button('搜索…').click()
    await flush()
    expect(findPanel()).not.toBeNull()
    // 面板本来就展开着时再按一次也要能把焦点抢回来，所以 store 里那个是自增计数不是布尔
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    expect(document.activeElement).toBe(findInput())
  })

  it('还没打开文件夹时按 Enter 说「还没打开文件夹」，一次 IPC 都不发', async () => {
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    typeSearch('needle')
    pressInFind('Enter')
    await flush()

    // 与侧边栏那几条项目级动作同一句话：没打开文件夹时说的都是它
    expect(container.querySelector('.find-error')?.textContent).toBe('还没打开文件夹')
    expect(searchCmd.calls).toEqual([])
    expect(findRows()).toHaveLength(0)
  })

  it('⚠️ 端到端：搜一遍 → 批次落成行 → 点一条命中 → 打开那个文件并把选区落在那一段上', async () => {
    await openProject()
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    typeSearch('needle')
    pressInFind('Enter')
    await flush()

    // 发出去的 query **只有四个 key**：include / exclude 刻意不发，Rust 侧容器上有
    // `#[serde(default)]`，缺 key 就是「不限」。前端替它补两个空数组等于把默认值抄两份
    expect(searchCmd.calls).toEqual([
      { root: '/repo', query: { pattern: 'needle', literal: false, caseSensitive: false, wholeWord: false } },
    ])
    expect(findStatus()).toBe('正在搜索… 已扫过 0 个文件')

    await fireSearch(SEARCH_BATCH_EVENT, {
      taskId: searchCmd.taskId,
      batch: {
        files: [
          {
            rel: 'src/a.ts',
            path: '/repo/src/a.ts',
            // 偏移量是 UTF-16 码元，与 String.prototype.slice、与 CM6 的文档位置同一口径
            hits: [
              { line: 1, text: 'let a = needle;', ranges: [{ start: 8, end: 14 }], truncated: false },
              { line: 2, text: 'let b = needle;', ranges: [{ start: 8, end: 14 }], truncated: false },
            ],
            truncated: false,
          },
        ],
        filesScanned: 7,
      },
    })

    // 一行文件标题 + 两条命中，摊成一个扁平数组（分组只体现在行的顺序上，不建父子指针）
    expect(findRowTexts()).toEqual(['src/a.ts2 处', '1let a = needle;', '2let b = needle;'])
    expect(findRows()[2]!.querySelectorAll('mark.find-mark')).toHaveLength(1)
    expect(findStatus()).toBe('正在搜索… 已扫过 7 个文件')

    // 点第二条命中。打开的正文与搜索结果对得上，于是行号与偏移量都还有效
    ipc.openFile.mockResolvedValue(textFile({ text: 'let a = needle;\nlet b = needle;\n' }))
    findRows()[2]!.click()
    await flush()

    expect(ipc.openFile).toHaveBeenCalledWith('/repo/src/a.ts')
    expect(statusName()).toBe('a.ts')
    // 第 2 行从文档位置 16 起，命中段 8..14 → 24..30。这一条钉的是 revealTarget 与
    // EditorController.reveal 的接线：偏移量算错一个单位的话，含 emoji 的行会选中位置错开
    expect(view().state.sliceDoc(24, 30)).toBe('needle')
    expect(view().state.selection.main.from).toBe(24)
    expect(view().state.selection.main.to).toBe(30)
    // 面板不跟着收起：搜完一处、看一眼、再点下一处是连续动作
    expect(findPanel()).not.toBeNull()
  })

  it('搜索进行中才出现「取消」，点它去作废那个 taskId，已经推来的结果留着', async () => {
    await openProject()
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    expect(findButton('取消')).toBeNull()

    typeSearch('needle')
    pressInFind('Enter')
    await flush()
    expect(findButton('取消')).not.toBeNull()

    await fireSearch(SEARCH_BATCH_EVENT, {
      taskId: searchCmd.taskId,
      batch: {
        files: [{ rel: 'README.md', path: '/repo/README.md', hits: [], truncated: false }],
        filesScanned: 3,
      },
    })

    findButton('取消')!.click()
    await flush()

    expect(searchCmd.cancelled).toEqual([searchCmd.taskId])
    // 取消是协作式的，随后那几批仍然有效：这里自己把结果清掉的话，用户点「取消」
    // 会得到「已经搜到的也没了」，而他表达的只是「别再搜下去了」
    expect(findRows()).toHaveLength(1)
    expect(findButton('取消')).not.toBeNull()
  })

  it('done 事件是唯一的终止信号：总账落地，「取消」按钮消失', async () => {
    await openProject()
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    typeSearch('needle')
    pressInFind('Enter')
    await flush()

    await fireSearch(SEARCH_DONE_EVENT, {
      taskId: searchCmd.taskId,
      summary: {
        filesScanned: 12,
        filesWithHits: 0,
        hits: 0,
        skippedTooLarge: 0,
        // ⚠️ 这一条不是总账的一部分，是单独一行警告色：它说的是「这个 0 可能是假的」
        unreadable: 2,
        truncated: false,
        cancelled: false,
        elapsedMs: 1200,
      },
    })

    expect(findStatus()).toBe('没有找到 · 扫过 12 个文件 · 1.20s')
    expect(container.querySelector('.find-warning')?.textContent).toBe(
      '有 2 个条目读不出来（权限不够、被删或 IO 错误），所以「没有找到」不一定成立',
    )
    expect(findButton('取消')).toBeNull()
  })
})
