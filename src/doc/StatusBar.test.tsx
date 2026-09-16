// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 状态栏的测试：格子渲染得对不对、跟不跟着 signal 走，以及 M1-E-2b 那两格**可写**的下拉。
 *
 * 度量本身怎么算（行列、选区、缩进）在 `workspace.test.ts` 里测过了，这里不重复。
 * 但**语言那一格必须在这儿测**：它刻意不复用 `tab.language`（那是个普通字段，改了不触发
 * 重渲染），而是 `languageFor(doc.path())`——这条只有真渲染出来才验得到。
 *
 * 「以某编码重新打开」的模型层行为（脏的时候拒绝、成功后采纳新格式）在
 * `document.test.ts` 里，这里测的是**下拉到模型之间的那一段接线**：`save:` / `reopen:`
 * 两种 value 的分派、`-bom` 后缀的拆装、以及第二个参数有没有真的传下去。这一段最容易
 * 静默出错——漏传编码时 Rust 收到 `None`，「重新打开」会退化成「再探测一次」，
 * 用户看到的还是同一屏乱码。
 *
 * ipc 只假掉两个读写函数，**标签表用真的**：`ENCODING_LABELS` / `LINE_ENDING_LABELS`
 * 正是要显示给用户看的东西，把它也 mock 掉等于自己给自己判卷。
 */

const { ipc, dialog } = vi.hoisted(() => ({
  ipc: { openFile: vi.fn(), saveFile: vi.fn() },
  dialog: { open: vi.fn(), save: vi.fn() },
}))

vi.mock('../ipc/fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/fs')>()),
  openFile: (...args: unknown[]) => ipc.openFile(...args),
  saveFile: (...args: unknown[]) => ipc.saveFile(...args),
}))
vi.mock('@tauri-apps/plugin-dialog', () => dialog)

import { EditorSelection } from '@codemirror/state'
import { EditorController } from '../editor/controller'
import type { FileFormat, TextFile } from '../ipc/fs'
import { StatusBar } from './StatusBar'
import { createWorkspace, type Workspace } from './workspace'

let container: HTMLDivElement
let dispose: () => void
/** 建过的真编辑器，测完统一 destroy */
const liveEditors: { controller: EditorController; host: HTMLElement }[] = []

function textFile(overrides: Partial<TextFile> = {}): TextFile {
  return {
    text: '正文',
    format: { encoding: 'utf8', bom: false, eol: 'lf' } as FileFormat,
    lossy: false,
    bytes: 6,
    ...overrides,
  }
}

function mount(): Workspace {
  const ws = createWorkspace()
  dispose = render(() => <StatusBar workspace={ws} />, container)
  return ws
}

/** 挂一个真编辑器上去：选区与脏标记只有真 view 才推得动 */
function attachEditor(ws: Workspace): EditorController {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const controller = new EditorController(host, ws.activeTab().snapshot.state)
  liveEditors.push({ controller, host })
  ws.attach(ws.panes()[0]!.id, controller)
  return controller
}

/**
 * 格子的显示值。
 *
 * `<select>` 那两格（编码、换行符）必须读**选中项**：整个 `textContent` 会把所有 option
 * 的文字拼在一起，读出来是「UTF-8UTF-8 BOMUTF-16 LE…」这种东西。
 */
function cellText(el: Element): string {
  const select = el.querySelector('select')
  if (select) return select.selectedOptions[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function cellElements(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.statusbar .status-cell')]
}

function cells(): string[] {
  return cellElements().map(cellText)
}

/**
 * 按 title 取格子：下标会被条件渲染的「选中 / 选区」两格推来推去，title 是稳定的。
 * ⚠️ 代价是 title 文案成了契约——改组件里的提示文字要同时改这里。
 */
function cell(titled: string): string | undefined {
  const found = cellElements().find((c) => c.title === titled)
  return found === undefined ? undefined : cellText(found)
}

/** 像用户那样拨一下下拉：先设 value，再派发 change（Solid 的 onChange 收的就是这个） */
function pick(titled: string, value: string) {
  const select = cellElements().find((c) => c.title === titled)?.querySelector('select')
  if (!select) throw new Error(`「${titled}」那一格里没有下拉`)
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.save.mockReset()
  ipc.openFile.mockResolvedValue(textFile())
})

afterEach(() => {
  for (const { controller, host } of liveEditors.splice(0)) {
    controller.destroy()
    host.remove()
  }
  dispose()
  container.remove()
})

describe('StatusBar', () => {
  it('空文档：七格齐全，语言是 Markdown，选区那两格不出现', () => {
    mount()

    expect(cells()).toEqual([
      '空文档',
      '行 1，列 1',
      '2 空格',
      'UTF-8',
      'LF',
      'Markdown',
      '1 行 · 0 字符',
    ])
  })

  it('编码、BOM 与换行符照文件原样报出来，不美化', async () => {
    const ws = mount()
    ipc.openFile.mockResolvedValue(
      textFile({ format: { encoding: 'utf16_le', bom: true, eol: 'crlf' }, lossy: true }),
    )

    await ws.openAt('/x/win.txt')

    expect(cell('编码')).toBe('UTF-16 LE BOM')
    expect(cell('换行符')).toBe('CRLF')
    expect(cell('语言')).toBe('纯文本')
    expect(cells()[0]).toBe('win.txt')
  })

  it('GBK 只有不带 BOM 的那一种——下拉里压根没有「GBK BOM」这个选项', async () => {
    // Rust 侧 `Encoding::supports_bom` 排除了这个组合：写了也没工具认，encode 还会忽略它。
    // UI 不提供不可能的组合，比提供了再在下游兜住便宜
    const ws = mount()
    ipc.openFile.mockResolvedValue(textFile({ format: { encoding: 'gbk', bom: false, eol: 'lf' } }))

    await ws.openAt('/x/legacy.txt')

    expect(cell('编码')).toBe('GBK')
    const encodingCell = cellElements().find((c) => c.title === '编码')!
    const labels = [...encodingCell.querySelectorAll<HTMLOptionElement>('option')].map((o) => o.textContent?.trim())
    expect(labels).not.toContain('GBK BOM')
    // 保存那组七个合法组合（UTF-8 / UTF-16 LE / UTF-16 BE 各带不带 BOM 两种，GBK 一种），
    // 重新打开那组四个编码——BOM 在重开时是从字节里读的，不由用户选
    expect(labels).toEqual([
      'UTF-8',
      'UTF-8 BOM',
      'UTF-16 LE',
      'UTF-16 LE BOM',
      'UTF-16 BE',
      'UTF-16 BE BOM',
      'GBK',
      'UTF-8',
      'UTF-16 LE',
      'UTF-16 BE',
      'GBK',
    ])
  })

  it('语言格跟着扩展名变：打开 .log 之后不再是 Markdown', async () => {
    // M1-E 之前 markdownMode 是全局默认开的，任何文件都报 Markdown。这条钉住显示层也跟着改了
    const ws = mount()
    expect(cell('语言')).toBe('Markdown')

    await ws.openAt('/var/app.log')

    expect(cell('语言')).toBe('纯文本')
  })

  it('语言格在语法树落地之前就先报出来，落地之后也不跳', async () => {
    const ws = mount()

    await ws.openAt('/out/pkg.json')

    // 子语言是动态 import，语法树可能还没到，但状态栏不该显示空白等它
    expect(cell('语言')).toBe('JSON')
    await flush()
    expect(cell('语言')).toBe('JSON')
  })

  it('另存为换了扩展名，语言格立刻跟着换（读的是 path 这个 signal）', async () => {
    const ws = mount()
    await ws.openAt('/var/app.log')
    expect(cell('语言')).toBe('纯文本')
    dialog.save.mockResolvedValue('/out/notes.md')

    await ws.saveAs()

    expect(cell('语言')).toBe('Markdown')
  })

  it('选中与多光标时才多出那两格', () => {
    const ws = mount()
    const controller = attachEditor(ws)
    controller.view.dispatch({ changes: { from: 0, insert: 'abcdef' } })
    expect(cell('语言')).toBeDefined()
    expect(cells()).not.toContain('选中 3 字符')

    controller.view.dispatch({ selection: { anchor: 1, head: 4 } })
    expect(cells()).toContain('选中 3 字符')
    expect(cells()).not.toContain('1 个选区') // 单光标不值得占一格

    // ⛔ 不能写成 `selection: { ranges: [...] }`：TransactionSpec 只认 `EditorSelection`
    // 或**单个** `{anchor, head}`。写错不会当场报错，而是变成 anchor/head 都为 undefined，
    // 一路走到 closeBrackets 的 `doc.lineAt(NaN)` 才炸，栈里全是第三方的帧。
    // 而且区间必须用 `EditorSelection.range` 造，字面量过不了类型（TS2740）。
    // create 的 mainIndex 默认 0，所以主光标是**第一个**区间——列报的是 3 不是 7。
    controller.view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 6)]),
    })
    expect(cells()).toContain('2 个选区')
    expect(cells()).toContain('选中 5 字符')
    expect(cell('主光标的行与列')).toBe('行 1，列 3')
  })

  it('敲了字就在名字前面加脏标记', () => {
    const ws = mount()
    const controller = attachEditor(ws)
    expect(cells()[0]).toBe('空文档')

    controller.view.dispatch({ changes: { from: 0, insert: 'x' } })

    expect(cells()[0]).toBe('● 空文档')
    expect(cell('全文行数与字符数')).toBe('1 行 · 1 字符')
  })

  it('IO 进行中第一格报「读写中…」，结束后回到文件名', async () => {
    const ws = mount()
    let release!: (file: TextFile) => void
    ipc.openFile.mockReturnValue(new Promise<TextFile>((resolve) => (release = resolve)))
    dialog.open.mockResolvedValue('/x/a.txt')

    const opening = ws.openAt('/x/a.txt')
    await flush()
    expect(cells()[0]).toBe('读写中…')

    release(textFile())
    await opening
    expect(cells()[0]).toBe('a.txt')
  })

  it('路径格挂全路径当 title，正文只显示 basename', async () => {
    const ws = mount()

    await ws.openAt('/Users/x/notes/win.txt')

    expect(cells()[0]).toBe('win.txt')
    expect(container.querySelector<HTMLElement>('.status-path')?.title).toBe('/Users/x/notes/win.txt')
  })
})

describe('StatusBar：M1-E-2b 可写的两格', () => {
  /** 打开一个文件并挂上真编辑器，返回它。多数用例的起点都一样 */
  async function opened(): Promise<{ ws: Workspace; controller: EditorController }> {
    const ws = mount()
    const controller = attachEditor(ws)
    await ws.openAt('/x/a.txt')
    return { ws, controller }
  }

  it('换编码是**未保存的改动**：标脏，而且新格式真的传给了后端', async () => {
    const { ws } = await opened()
    expect(ws.activeTab().doc.dirty()).toBe(false)

    pick('编码', 'save:gbk')

    expect(ws.activeTab().doc.dirty()).toBe(true)
    expect(cell('编码')).toBe('GBK')
    expect(cells()[0]).toBe('● a.txt')

    ipc.saveFile.mockResolvedValue({ bytesWritten: 4, unmappable: false })
    await ws.save()
    expect(ipc.saveFile).toHaveBeenCalledWith('/x/a.txt', '正文', { encoding: 'gbk', bom: false, eol: 'lf' })
  })

  it('带 BOM 的那一项把 encoding 与 bom 一起改掉', async () => {
    const { ws } = await opened()

    pick('编码', 'save:utf16_le-bom')

    expect(ws.activeTab().doc.format()).toEqual({ encoding: 'utf16_le', bom: true, eol: 'lf' })
    expect(cell('编码')).toBe('UTF-16 LE BOM')
  })

  it('换行符同理：改的是保存时写回磁盘用的那种', async () => {
    const { ws, controller } = await opened()

    pick('换行符', 'crlf')

    expect(ws.activeTab().doc.format().eol).toBe('crlf')
    expect(cell('换行符')).toBe('CRLF')
    expect(ws.activeTab().doc.dirty()).toBe(true)
    // 正文里一个 \r 都不该有：CRLF 只活在 IO 边界上，编辑器内部永远是 LF
    expect(controller.doc).toBe('正文')
  })

  it('选「以…重新打开」把编码一路传到 openFile，正文与格式换成后端给的', async () => {
    const ws = mount()
    const controller = attachEditor(ws)
    ipc.openFile.mockReset()
    ipc.openFile
      .mockResolvedValueOnce(textFile())
      .mockResolvedValueOnce(textFile({ text: '模', format: { encoding: 'gbk', bom: false, eol: 'lf' } }))

    await ws.openAt('/x/a.txt')
    expect(controller.doc).toBe('正文')

    pick('编码', 'reopen:gbk')
    await flush()

    // ⚠️ 第二个参数必须真的发出去：漏了它 Rust 那边收到 None，「重新打开」就静默退化成
    // 「再探测一次」，用户看到的还是同一屏乱码，而且没有任何提示说刚才那下没生效
    expect(ipc.openFile).toHaveBeenLastCalledWith('/x/a.txt', 'gbk')
    expect(controller.doc).toBe('模')
    // 下拉停在新的保存格式上，而不是刚才那个一次性的「以…重新打开」
    expect(cell('编码')).toBe('GBK')
    expect(ws.activeTab().doc.dirty()).toBe(false)
  })

  it('无名文档没有「以…重新打开」那组——磁盘上没有字节可重读', () => {
    mount()

    const groups = [...container.querySelectorAll('optgroup')].map((g) => g.label)
    expect(groups).toEqual(['以…保存'])
  })

  it('有未保存的改动时拒绝重新解码：不发第二次 IO，给提示，下拉复位', async () => {
    const { ws, controller } = await opened()
    controller.view.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(ws.activeTab().doc.dirty()).toBe(true)
    expect(ipc.openFile).toHaveBeenCalledTimes(1)

    pick('编码', 'reopen:gbk')
    await flush()

    // 重新解码是从磁盘重读，会把改动整个扔掉，所以这里必须什么都不做
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
    expect(controller.doc).toBe('x正文')
    const notice = ws.activeTab().doc.notice()
    expect(notice?.level).toBe('warning')
    expect(notice?.text).toContain('未保存的改动')
    // 下拉得回到当前保存格式上：停在「以 GBK 重新打开」看起来像已经生效了
    expect(cell('编码')).toBe('UTF-8')
  })

  it('IO 进行中两格都禁用，免得与正在落地的那次读写打架', async () => {
    const ws = mount()
    let release!: (file: TextFile) => void
    ipc.openFile.mockReturnValue(new Promise<TextFile>((resolve) => (release = resolve)))

    const opening = ws.openAt('/x/a.txt')
    await flush()
    const selects = [...container.querySelectorAll<HTMLSelectElement>('.statusbar select')]
    expect(selects.length).toBe(2)
    expect(selects.every((s) => s.disabled)).toBe(true)

    release(textFile())
    await opening
    expect(selects.every((s) => !s.disabled)).toBe(true)
  })
})
