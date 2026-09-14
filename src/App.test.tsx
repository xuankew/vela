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

const { ipc, dialog } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    // 换成假的：它自己另有测试，这里只关心错误能落到提示条上
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
    LINE_ENDING_LABELS: { lf: 'LF', crlf: 'CRLF' },
  },
  dialog: { open: vi.fn(), save: vi.fn() },
}))

vi.mock('./ipc/fs', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)

import App from './App'

/**
 * `Mod` 在不同平台上是不同物理键，而 jsdom 的 UA 不含 "Mac" → detectPlatform() 判成 linux。
 * 所以按被测环境实际检测到的平台发键，而不是写死 metaKey。
 */
const modInit = (): KeyboardEventInit => (detectPlatform() === 'macos' ? { metaKey: true } : { ctrlKey: true })

let container: HTMLDivElement
let dispose: () => void

beforeEach(() => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  ipc.saveFile.mockResolvedValue({ bytesWritten: 6, unmappable: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  dispose = render(() => <App />, container)
})

afterEach(() => {
  dispose()
  container.remove()
  document.documentElement.removeAttribute('style')
})

/** 打开/保存是异步的：命令 execute → hook → invoke 有好几层微任务，一个宏任务就能冲干净 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function view(): EditorView {
  const dom = container.querySelector<HTMLElement>('.cm-editor')
  if (!dom) throw new Error('App 没有渲染出编辑器')
  const found = EditorView.findFromDOM(dom)
  if (!found) throw new Error('拿不到 EditorView 实例')
  return found
}

function badges(): string[] {
  return [...container.querySelectorAll('.badge')].map((b) => b.textContent ?? '')
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
    expect(badges()[0]).toBe('空文档')
    // CM6 把空文档算作「一行空行」，所以是 1 行 0 字符，不是 0 行
    expect(badges()[1]).toBe('1 行 · 0 字符')
    // 提示条容器常驻但没有内容：它占着 grid 的第二行，行数必须是固定的
    expect(container.querySelector('.notices')).not.toBeNull()
    expect(container.querySelector('.notice')).toBeNull()
  })

  it('输入会经 onUpdate 推到状态栏（CM6 → signal 的回路在真实 App 里通）', () => {
    typeText('第一行\n第二行\n第三行')
    expect(badges()[1]).toBe('3 行 · 11 字符')
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

  it('「新建」清空编辑器，状态栏回到空文档的度量（setDoc 必须触发 onUpdate）', () => {
    typeText('a\nb\nc\nd')
    expect(badges()[1]).toBe('4 行 · 7 字符')

    button('新建').click()

    expect(view().state.doc.toString()).toBe('')
    expect(badges()[0]).toBe('空文档')
    expect(badges()[1]).toBe('1 行 · 0 字符')
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
    // 徽章只显示 basename，全路径挂在 title 上
    expect(badges()[0]).toBe('win.txt')
    expect(container.querySelector<HTMLElement>('.badge')?.title).toBe('/Users/x/notes/win.txt')
    expect(badges()[1]).toBe('3 行 · 8 字符')
    expect(notices()).toEqual([])
  })

  it('打开后立刻输入才置脏，Mod+S 保存后脏标记消失', async () => {
    dialog.open.mockResolvedValue('/a.txt')
    ipc.openFile.mockResolvedValue(textFile({ text: '原文' }))
    button('打开…').click()
    await flush()
    // 整篇替换正文不算用户改动——这条是 `replacing` 标志存在的全部理由
    expect(badges()[0]).toBe('a.txt')

    typeText('改')
    expect(badges()[0]).toBe('● a.txt')

    press('s', modInit())
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '原文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(badges()[0]).toBe('a.txt')
  })

  it('光标移动不置脏', () => {
    typeText('abc')
    const before = badges()[0]
    view().dispatch({ selection: { anchor: 0 } })
    expect(badges()[0]).toBe(before)
  })

  it('无名文档按 Mod+S 会落到另存为，用对话框拿到路径再写', async () => {
    dialog.save.mockResolvedValue('/chosen/new.txt')
    typeText('新内容')
    expect(badges()[0]).toBe('● 空文档')

    press('s', modInit())
    await flush()

    expect(dialog.save).toHaveBeenCalled()
    expect(ipc.saveFile).toHaveBeenCalledWith('/chosen/new.txt', '新内容', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(badges()[0]).toBe('new.txt')
  })

  it('另存为用 Mod+Shift+S，不会被 Mod+S 吃掉', async () => {
    dialog.save.mockResolvedValue('/copy.txt')
    typeText('x')

    press('S', { ...modInit(), shiftKey: true })
    await flush()

    expect(dialog.save).toHaveBeenCalledOnce()
    expect(badges()[0]).toBe('copy.txt')
  })

  it('对话框取消时什么都不动', async () => {
    dialog.open.mockResolvedValue(null)
    button('打开…').click()
    await flush()
    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(badges()[0]).toBe('空文档')
  })

  it('打开失败时提示条报出错误，编辑器内容不受影响', async () => {
    typeText('手稿')
    dialog.open.mockResolvedValue('/huge.log')
    ipc.openFile.mockRejectedValue({ kind: 'too_large', bytes: 5_000_000, limit: 4_194_304 })

    button('打开…').click()
    await flush()

    const list = notices()
    expect(list).toHaveLength(1)
    expect(list[0]!.level).toBe('error')
    expect(list[0]!.text).toContain('too_large')
    expect(view().state.doc.toString()).toBe('手稿')
    expect(badges()[0]).toBe('● 空文档')

    container.querySelector<HTMLButtonElement>('.notice-close')?.click()
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
    expect(badges()[0]).toBe('gbk.txt')
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
