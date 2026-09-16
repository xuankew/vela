// @vitest-environment jsdom
import { EditorView } from '@codemirror/view'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectPlatform } from './commands/keybinding'

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

const { ipc, dialog, tauriEvent, tauriCore } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    // 换成假的：它自己另有测试，这里只关心错误能落到提示条上（断言里靠 kind 字面量认出来）
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
  },
  dialog: { open: vi.fn(), save: vi.fn() },
  // 关窗守卫（src/ipc/windowClose.ts）要用的两个 Tauri API。jsdom 里没有运行时，
  // 不 mock 的话 `listen` 会在 onMount 里抛，变成一个没人管的 rejection。
  tauriEvent: { listen: vi.fn() },
  tauriCore: { invoke: vi.fn() },
}))

// 只假掉三个函数，**其余用真的**：状态栏要遍历 ENCODING_CHOICES / ENCODING_IDS /
// LINE_ENDING_IDS 渲染下拉，整体替换成假对象会让它在 render 里就抛（dispose 都不是函数，
// 38 条用例一起挂）。标签表本来也该是真的——那正是要显示给用户看的东西。
vi.mock('./ipc/fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ipc/fs')>()),
  openFile: (...args: unknown[]) => ipc.openFile(...args),
  saveFile: (...args: unknown[]) => ipc.saveFile(...args),
  describeFsError: (err: unknown) => ipc.describeFsError(err),
}))
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
vi.mock('@tauri-apps/api/event', () => tauriEvent)
vi.mock('@tauri-apps/api/core', () => tauriCore)

import App from './App'
import { MAX_PANES } from './doc/workspace'
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
  tauriCore.invoke.mockResolvedValue(undefined)
  tauriEvent.listen.mockImplementation(async (name: string, handler: (payload: unknown) => void) => {
    listeners.set(name, handler)
    return () => {
      listeners.delete(name)
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  dispose = render(() => <App />, container)
  // 关窗守卫的注册要等 `listen` 的 promise 落地，不然 listeners 还是空的
  await flush()
})

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
    let release!: (v: unknown) => void
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
    expect([...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')].map((b) => b.textContent)).toEqual(
      ['取消', '不保存', '保存'],
    )
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
