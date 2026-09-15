// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * workspace 的单测：标签之间怎么调度。
 *
 * **假的只有 IPC 与原生对话框**（jsdom 里没有 Tauri 运行时）。那一块可见编辑区用的是
 * 真的 `EditorController`：`onUpdate` 是 view 插件，只有真 view 会触发它，
 * 拿替身的话「输入 → 度量 → 脏标记」这条链就全是假象。
 */

const { ipc, dialog } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
  },
  dialog: { open: vi.fn(), save: vi.fn() },
}))

vi.mock('../ipc/fs', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)

import type { EditorState } from '@codemirror/state'
import { EditorController } from '../editor/controller'
import { lineWrapEnabled } from '../editor/setup'
import type { TextFile, WriteReport } from '../ipc/fs'
import { tabText } from './tab'
import {
  createWorkspace,
  MAX_PANES,
  type DiscardDecision,
  type DiscardPrompt,
  type SplitDirection,
  type Workspace,
} from './workspace'

function textFile(overrides: Partial<TextFile> = {}): TextFile {
  return {
    text: '正文',
    format: { encoding: 'utf8', bom: false, eol: 'lf' },
    lossy: false,
    bytes: 6,
    ...overrides,
  }
}

const OK_REPORT: WriteReport = { bytesWritten: 6, unmappable: false }

/** 建过的真编辑器，测试结束后统一 destroy。不叫 panes：那是 workspace 里「分屏」的名字 */
const liveEditors: { controller: EditorController; host: HTMLElement }[] = []

/**
 * 一块分屏的夹具。
 *
 * 分屏测试必须挂**真的** controller：`setLineWrap` 要 dispatch 到每块分屏的 view、
 * `detach` 要趁 view 还活着 capture 现场，拿替身这两条都验不出来。
 */
interface PaneFixture {
  readonly id: number
  readonly controller: EditorController
  readonly text: string
  type(text: string): void
}

/** 建一个 workspace 并把真的编辑区挂上去 */
function mounted(options: { lineWrap?: boolean; promptDiscard?: DiscardPrompt } = {}) {
  const ws = createWorkspace({
    lineWrap: options.lineWrap,
    // 默认答「不保存」：本文件里绝大多数用例测的是调度，不是确认流程。
    // 确认流程在「关闭确认」那个 describe 里逐个决策地测。
    promptDiscard: options.promptDiscard ?? (async () => 'discard'),
  })

  function spawn(paneId: number, state: EditorState): EditorController {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = new EditorController(host, state)
    liveEditors.push({ controller, host })
    ws.attach(paneId, controller)
    return controller
  }

  const controller = spawn(ws.panes()[0]!.id, ws.activeTab().snapshot.state)
  return {
    ws,
    controller,
    get doc() {
      return controller.doc
    },
    get state() {
      return controller.view.state
    },
    get scrollTop() {
      return controller.view.scrollDOM.scrollTop
    },
    type(text: string) {
      const at = controller.view.state.doc.length
      // 带上 selection：真实敲字会把光标落在插入的文本之后，只发 changes 的话光标停在 0，
      // 「光标位置跟着标签走」这条就没得测了
      controller.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
    },
    setScroll(top: number, left = 0) {
      controller.view.scrollDOM.scrollTop = top
      controller.view.scrollDOM.scrollLeft = left
    },
    /** 加一块分屏并给它挂上真编辑器。已到 `MAX_PANES` 时 `split` 只改方向，这里会抛 */
    splitPane(direction: SplitDirection = 'row'): PaneFixture {
      const before = new Set(ws.panes().map((p) => p.id))
      ws.split(direction)
      const fresh = ws.panes().find((p) => !before.has(p.id))
      if (!fresh) throw new Error('分屏数已到上限，没有新分屏可挂')
      const next = spawn(fresh.id, ws.tabs().find((t) => t.id === fresh.tabId())!.snapshot.state)
      return {
        id: fresh.id,
        controller: next,
        get text() {
          return next.doc
        },
        type(text: string) {
          const at = next.view.state.doc.length
          next.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
        },
      }
    },
  }
}

beforeEach(() => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  ipc.openFile.mockResolvedValue(textFile())
  ipc.saveFile.mockResolvedValue(OK_REPORT)
})

afterEach(() => {
  for (const { controller, host } of liveEditors.splice(0)) {
    controller.destroy()
    host.remove()
  }
})

describe('起始状态', () => {
  it('一上来就有一个空标签，activeTab 永远有值', () => {
    const ws = createWorkspace()
    expect(ws.tabs()).toHaveLength(1)
    expect(ws.activeTab()).toBe(ws.tabs()[0])
    expect(ws.activeIndex()).toBe(0)
    expect(ws.activeTab().doc.name()).toBe('空文档')
  })

  it('度量报的是空文档：1 行 0 字符（CM6 把空文档算作一行空行）', () => {
    const ws = createWorkspace()
    expect(ws.metrics()).toEqual({ lines: 1, chars: 0 })
  })

  it('换行偏好取自构造参数，并且真的落进了 state', () => {
    expect(lineWrapEnabled(createWorkspace({ lineWrap: true }).activeTab().snapshot.state)).toBe(true)
    expect(lineWrapEnabled(createWorkspace({ lineWrap: false }).activeTab().snapshot.state)).toBe(false)
  })
})

describe('newTab / activateTab：现场存取', () => {
  it('新建标签会激活它，原来那份正文留在自己的 snapshot 里', () => {
    const pane = mounted()
    pane.type('第一份')

    const second = pane.ws.newTab()

    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.activeTab()).toBe(second)
    expect(pane.doc).toBe('')
    expect(tabText(pane.ws.tabs()[0]!)).toBe('第一份')
  })

  it('来回切换：正文、光标位置、滚动位置各自跟着自己的标签走', () => {
    const pane = mounted()
    pane.type('AAA')
    pane.setScroll(120, 5)
    const first = pane.ws.activeTab()

    const second = pane.ws.newTab()
    pane.type('BBBBB')
    pane.setScroll(40)

    pane.ws.activateTab(first.id)
    expect(pane.doc).toBe('AAA')
    expect(pane.scrollTop).toBe(120)
    expect(pane.state.selection.main.head).toBe(3)

    pane.ws.activateTab(second.id)
    expect(pane.doc).toBe('BBBBB')
    expect(pane.scrollTop).toBe(40)
    expect(pane.state.selection.main.head).toBe(5)
  })

  it('激活已经活动的标签不做任何事（不白重建一次视图）', () => {
    const pane = mounted()
    const before = pane.state
    pane.ws.activateTab(pane.ws.activeTab().id)
    expect(pane.state).toBe(before)
  })

  it('激活一个不存在的 id 是安全的空操作', () => {
    const pane = mounted()
    const before = pane.state
    pane.ws.activateTab(9999)
    expect(pane.state).toBe(before)
    expect(pane.ws.tabs()).toHaveLength(1)
  })
})

describe('closeTab', () => {
  it('关掉非活动标签：列表少一个，显示的东西不变', async () => {
    const pane = mounted()
    const second = pane.ws.newTab()
    pane.type('留在屏幕上')
    const before = pane.state

    await pane.ws.closeTab(pane.ws.tabs()[0]!.id)

    expect(pane.ws.tabs()).toEqual([second])
    expect(pane.ws.activeTab()).toBe(second)
    expect(pane.state).toBe(before)
  })

  it('关掉活动标签：激活右邻居', async () => {
    const pane = mounted()
    const a = pane.ws.tabs()[0]!
    const b = pane.ws.newTab()
    const c = pane.ws.newTab()
    pane.ws.activateTab(b.id)
    pane.type('B 的正文')

    await pane.ws.closeTab(b.id)

    expect(pane.ws.tabs().map((t) => t.id)).toEqual([a.id, c.id])
    expect(pane.ws.activeTab()).toBe(c)
    expect(pane.doc).toBe('')
  })

  it('关掉末尾的活动标签：退回新的末尾', async () => {
    const pane = mounted()
    const a = pane.ws.tabs()[0]!
    const b = pane.ws.newTab()
    pane.type('B 的正文')

    await pane.ws.closeTab(b.id)

    expect(pane.ws.tabs().map((t) => t.id)).toEqual([a.id])
    expect(pane.ws.activeTab()).toBe(a)
    expect(pane.doc).toBe('')
  })

  it('关掉最后一个标签会补一个空标签进来——tabs 永远非空', async () => {
    // 允许「零标签」的话所有 editor.* 命令的 when 会同时失效、状态栏没有可显示的对象、
    // activeTab() 变成 nullable 并传染给每一个调用点
    const pane = mounted()
    pane.type('要被关掉的')
    const doomed = pane.ws.activeTab()

    await pane.ws.closeTab(doomed.id)

    expect(pane.ws.tabs()).toHaveLength(1)
    expect(pane.ws.activeTab().id).not.toBe(doomed.id)
    expect(pane.doc).toBe('')
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 0 })
  })

  it('关掉一个不存在的 id 是安全的空操作', async () => {
    const pane = mounted()
    await pane.ws.closeTab(4242)
    expect(pane.ws.tabs()).toHaveLength(1)
  })
})

describe('reorder（拖拽重排）', () => {
  it('往右拖：dragged 落到 target 后面', () => {
    const ws = createWorkspace()
    const a = ws.tabs()[0]!
    const b = ws.newTab()
    const c = ws.newTab()

    ws.reorder(a.id, c.id)

    expect(ws.tabs().map((t) => t.id)).toEqual([b.id, c.id, a.id])
  })

  it('往左拖：dragged 落到 target 前面', () => {
    const ws = createWorkspace()
    const a = ws.tabs()[0]!
    const b = ws.newTab()
    const c = ws.newTab()

    ws.reorder(c.id, a.id)

    expect(ws.tabs().map((t) => t.id)).toEqual([c.id, a.id, b.id])
  })

  it('拖到自己身上、或拖一个不存在的 id，都不改顺序', () => {
    const ws = createWorkspace()
    const b = ws.newTab()
    const before = ws.tabs()

    ws.reorder(b.id, b.id)
    ws.reorder(9999, b.id)
    ws.reorder(b.id, 9999)

    expect(ws.tabs()).toEqual(before)
  })

  it('重排不改变活动标签', () => {
    const pane = mounted()
    pane.ws.newTab()
    const active = pane.ws.activeTab()
    pane.ws.reorder(pane.ws.tabs()[0]!.id, active.id)
    expect(pane.ws.activeTab()).toBe(active)
  })
})

describe('openAt：文件落到哪个标签', () => {
  it('干净的无名活动标签就地复用，不新增标签', async () => {
    const pane = mounted()
    const before = pane.ws.activeTab()

    await pane.ws.openAt('/a.txt')

    expect(pane.ws.tabs()).toHaveLength(1)
    expect(pane.ws.activeTab()).toBe(before)
    expect(before.doc.path()).toBe('/a.txt')
    expect(pane.doc).toBe('正文')
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 2 })
  })

  it('活动标签已经脏了就新建一个，不动用户手上的东西', async () => {
    const pane = mounted()
    pane.type('手稿')
    const draft = pane.ws.activeTab()

    await pane.ws.openAt('/a.txt')

    expect(pane.ws.tabs()).toHaveLength(2)
    expect(tabText(draft)).toBe('手稿')
    expect(pane.ws.activeTab().doc.path()).toBe('/a.txt')
    expect(pane.doc).toBe('正文')
  })

  it('活动标签已经有别的路径时也新建一个', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    await pane.ws.openAt('/b.txt')
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.tabs().map((t) => t.doc.path())).toEqual(['/a.txt', '/b.txt'])
  })

  it('同一个文件只开一个标签：第二次只激活，不重读', async () => {
    // 再读一次不但会丢掉已有的未保存改动，还会让用户在两份内容里猜哪份是真的
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    pane.type('改过了')
    const opened = pane.ws.activeTab()
    pane.ws.newTab()

    await pane.ws.openAt('/a.txt')

    expect(ipc.openFile).toHaveBeenCalledTimes(1)
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.activeTab()).toBe(opened)
    expect(pane.doc).toBe('正文改过了')
    expect(opened.doc.dirty()).toBe(true)
  })

  it('读取失败时报错落在被打开的那个标签上，原文完好', async () => {
    const pane = mounted()
    pane.type('手稿')
    ipc.openFile.mockRejectedValue({ kind: 'too_large', bytes: 5_000_000, limit: 4_194_304 })

    await pane.ws.openAt('/huge.log')

    // 新标签是空的，错误提示在它身上；手稿在它自己那个标签里完好无损
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.activeTab().doc.notice()?.level).toBe('error')
    expect(pane.doc).toBe('')
    expect(tabText(pane.ws.tabs()[0]!)).toBe('手稿')
  })
})

describe('openViaDialog', () => {
  it('对话框取消时什么都不动', async () => {
    const pane = mounted()
    dialog.open.mockResolvedValue(null)

    await pane.ws.openViaDialog()

    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(pane.ws.tabs()).toHaveLength(1)
    expect(pane.doc).toBe('')
  })

  it('不设扩展名过滤器：编辑器要能打开 LICENSE、Makefile、无后缀的配置文件', async () => {
    const pane = mounted()
    dialog.open.mockResolvedValue('/proj/Makefile')

    await pane.ws.openViaDialog()

    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: false })
    expect(pane.ws.activeTab().doc.name()).toBe('Makefile')
  })
})

describe('setLineWrap：全局设置要落到每一个标签', () => {
  it('显示中的那个走 dispatch，其余的走 state.update', () => {
    const pane = mounted()
    const second = pane.ws.newTab()
    pane.ws.activateTab(pane.ws.tabs()[0]!.id)

    pane.ws.setLineWrap(false)

    expect(pane.ws.lineWrap()).toBe(false)
    expect(lineWrapEnabled(pane.state)).toBe(false)
    expect(lineWrapEnabled(second.snapshot.state)).toBe(false)
  })

  it('切到后台标签，它的换行状态也是对的', () => {
    const pane = mounted()
    const second = pane.ws.newTab()
    pane.ws.setLineWrap(false)

    pane.ws.activateTab(second.id)

    expect(lineWrapEnabled(pane.state)).toBe(false)
  })

  it('传入相同值时什么都不做（不白重建一次视图）', () => {
    const pane = mounted()
    const before = pane.state
    pane.ws.setLineWrap(true)
    expect(pane.state).toBe(before)
  })

  it('toggleLineWrap 来回翻', () => {
    const ws = createWorkspace()
    expect(ws.lineWrap()).toBe(true)
    ws.toggleLineWrap()
    expect(ws.lineWrap()).toBe(false)
    ws.toggleLineWrap()
    expect(ws.lineWrap()).toBe(true)
  })

  it('关着换行时新建的标签也是关的', () => {
    const ws = createWorkspace()
    ws.setLineWrap(false)
    expect(lineWrapEnabled(ws.newTab().snapshot.state)).toBe(false)
  })

  it('关掉换行之后打开文件，新正文仍然是关的', async () => {
    const pane = mounted()
    pane.ws.setLineWrap(false)
    await pane.ws.openAt('/a.txt')
    expect(lineWrapEnabled(pane.ws.activeTab().snapshot.state)).toBe(false)
  })
})

describe('度量与脏标记', () => {
  it('输入经 state 里的 onUpdate 推到 metrics，并且只脏自己', () => {
    const pane = mounted()
    pane.type('三行\n第二\n第三')
    expect(pane.ws.metrics()).toEqual({ lines: 3, chars: 8 })
    expect(pane.ws.activeTab().doc.dirty()).toBe(true)
  })

  it('整篇替换正文（打开文件）不算用户改动，敲一个字才算', async () => {
    // 这条是 document.ts 里 `replacing` 标志存在的全部理由：替换正文会让 CM6 回调
    // docChanged，挡不住的话刚打开的文件立刻显示成「未保存」
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    expect(pane.ws.activeTab().doc.dirty()).toBe(false)
    expect(pane.ws.anyDirty()).toBe(false)

    pane.type('改')
    expect(pane.ws.activeTab().doc.dirty()).toBe(true)
  })

  it('切标签时 metrics 换成新标签的', async () => {
    const pane = mounted()
    pane.type('aaaa')
    const first = pane.ws.activeTab()
    const second = pane.ws.newTab()
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 0 })

    pane.ws.activateTab(first.id)
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 4 })

    pane.ws.activateTab(second.id)
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 0 })
  })

  it('后台标签的 state 变了也不会污染 metrics（状态栏只显示最新那个）', () => {
    const pane = mounted()
    const first = pane.ws.activeTab()
    pane.ws.newTab()
    first.snapshot = {
      ...first.snapshot,
      state: first.snapshot.state.update({ changes: { from: 0, insert: '偷偷改的' } }).state,
    }
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 0 })
    expect(pane.doc).toBe('')
  })

  it('anyDirty 只要有任意一个标签没落盘就是真', async () => {
    const pane = mounted()
    expect(pane.ws.anyDirty()).toBe(false)

    await pane.ws.openAt('/a.txt')
    expect(pane.ws.anyDirty()).toBe(false)

    pane.type('x')
    expect(pane.ws.anyDirty()).toBe(true)

    const second = pane.ws.newTab()
    expect(second.doc.dirty()).toBe(false)
    expect(pane.ws.anyDirty()).toBe(true)
  })

  it('光标移动不置脏：脏标记只认正文变化', () => {
    const pane = mounted()
    pane.controller.view.dispatch({ selection: { anchor: 0 } })
    expect(pane.ws.activeTab().doc.dirty()).toBe(false)
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 0 })
  })
})

describe('host 路由：显示中与未显示的标签读到的正文不一样', () => {
  it('显示中的标签 getText 读 view.state，不是过期的 snapshot', async () => {
    // snapshot 只在切走时更新，显示期间它一直是旧的。读错来源会让「保存」写出旧内容
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    pane.type('追加')

    expect(tabText(pane.ws.activeTab())).toBe('正文') // snapshot 还是打开那一刻的

    await pane.ws.save()
    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文追加', { encoding: 'utf8', bom: false, eol: 'lf' })
  })

  it('save / saveAs 都作用于活动标签', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    const first = pane.ws.activeTab()
    pane.ws.newTab()
    pane.type('第二份')

    dialog.save.mockResolvedValue('/b.txt')
    await pane.ws.save()

    expect(ipc.saveFile).toHaveBeenCalledWith('/b.txt', '第二份', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(first.doc.path()).toBe('/a.txt')
    expect(pane.ws.activeTab().doc.path()).toBe('/b.txt')
  })

  it('detach 之后 host 退回到读 snapshot，不炸', () => {
    const pane = mounted()
    const first = pane.ws.activeTab()
    pane.type('存着')
    pane.ws.newTab()
    pane.ws.activateTab(first.id) // 这一下把「存着」装回分屏，也把它 capture 回 first.snapshot

    pane.ws.detach(pane.ws.panes()[0]!.id)

    expect(pane.ws.activeTab()).toBe(first)
    expect(tabText(first)).toBe('存着')
    // detach 之后不该再有人往已交出的 controller 上写东西
    expect(() => pane.ws.newTab()).not.toThrow()
  })
})

describe('未挂编辑器时也能工作（挂载前的那一小段时间）', () => {
  it('newTab / closeTab / reorder 都不需要 controller 在场', async () => {
    const ws: Workspace = createWorkspace()
    const a = ws.tabs()[0]!
    const b = ws.newTab()
    const c = ws.newTab()
    expect(ws.tabs()).toHaveLength(3)

    ws.reorder(a.id, c.id)
    expect(ws.tabs().map((t) => t.id)).toEqual([b.id, c.id, a.id])
    expect(ws.activeTab()).toBe(c)

    await ws.closeTab(b.id)
    expect(ws.tabs().map((t) => t.id)).toEqual([c.id, a.id])
    expect(ws.activeTab()).toBe(c)
  })

  it('attach 之后度量对上，不需要额外 restore', () => {
    const ws = createWorkspace()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = new EditorController(host, ws.activeTab().snapshot.state)
    liveEditors.push({ controller, host })
    controller.view.dispatch({ changes: { from: 0, insert: '挂载前的内容' } })

    ws.attach(ws.panes()[0]!.id, controller)

    expect(ws.metrics()).toEqual({ lines: 1, chars: 6 })
  })

  it('分屏的增删与聚焦也不需要 controller 在场', () => {
    const ws: Workspace = createWorkspace()
    const first = ws.panes()[0]!

    ws.split('row')
    expect(ws.panes()).toHaveLength(2)
    expect(ws.focusedPaneId()).not.toBe(first.id)

    ws.cyclePane(-1)
    expect(ws.focusedPaneId()).toBe(first.id)

    ws.closePane(ws.panes()[1]!.id)
    expect(ws.panes()).toEqual([first])
    expect(ws.focusedPaneId()).toBe(first.id)
    expect(ws.focusedEditor()).toBeNull()
  })
})

describe('M1-D-5：分屏', () => {
  it('一块分屏时的行为与加分屏之前完全一致', () => {
    const pane = mounted()
    expect(pane.ws.panes()).toHaveLength(1)
    expect(pane.ws.direction()).toBe('row')
    expect(pane.ws.focusedPaneId()).toBe(pane.ws.panes()[0]!.id)
    expect(pane.ws.focusedEditor()).toBe(pane.controller)
    expect(pane.ws.panes()[0]!.tabId()).toBe(pane.ws.activeTab().id)
  })

  it('split 加一块分屏、装一个新空标签，并把焦点交给它', () => {
    const pane = mounted()
    pane.type('左边')
    const leftTab = pane.ws.activeTab()

    const right = pane.splitPane('row')

    expect(pane.ws.panes()).toHaveLength(2)
    expect(pane.ws.direction()).toBe('row')
    // 新分屏装的是**新标签**，不是把左边那个复制过去：一个标签只能显示在一个分屏里
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.focusedPaneId()).toBe(right.id)
    expect(pane.ws.activeTab()).not.toBe(leftTab)
    expect(right.text).toBe('')
    // 左边那份正文一动没动
    expect(pane.controller.doc).toBe('左边')
    // 度量跟着焦点走，焦点在新分屏上，所以是空文档的度量
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 0 })
  })

  it('direction 由最后一次 split 决定，且到 MAX_PANES 之后只改方向不再加分屏', () => {
    const pane = mounted()
    pane.splitPane('column')
    expect(pane.ws.direction()).toBe('column')
    expect(pane.ws.panes()).toHaveLength(2)

    for (let i = 2; i < MAX_PANES; i++) {
      pane.splitPane('column')
      expect(pane.ws.panes()).toHaveLength(i + 1)
    }
    expect(pane.ws.direction()).toBe('column')

    pane.ws.split('row')
    expect(pane.ws.panes()).toHaveLength(MAX_PANES)
    expect(pane.ws.direction()).toBe('row')
    expect(pane.ws.tabs()).toHaveLength(MAX_PANES)
  })

  it('两块分屏各有各的正文与光标，互不串台', () => {
    const pane = mounted()
    pane.type('AAA')
    const right = pane.splitPane('row')
    right.type('BBBBB')

    expect(pane.controller.doc).toBe('AAA')
    expect(right.text).toBe('BBBBB')
    // 光标位置也是各自的：右边敲了 5 个字，左边停在 3
    expect(right.controller.view.state.selection.main.head).toBe(5)
    expect(pane.controller.view.state.selection.main.head).toBe(3)
    // 两块都是脏的
    expect(pane.ws.anyDirty()).toBe(true)
    expect(pane.ws.tabs().filter((t) => t.doc.dirty())).toHaveLength(2)
  })

  it('焦点决定度量与「活动标签」，focusPane 换焦点不换正文', () => {
    const pane = mounted()
    pane.type('AAA')
    const leftTab = pane.ws.activeTab()
    const right = pane.splitPane('row')
    right.type('BBBBB')
    const leftId = pane.ws.panes()[0]!.id

    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 5 })

    pane.ws.focusPane(leftId)
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 3 })
    expect(pane.ws.activeTab()).toBe(leftTab)
    expect(right.controller.doc).toBe('BBBBB')

    // 幂等：重复聚焦同一块不该把正文或度量搅乱
    pane.ws.focusPane(leftId)
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 3 })
  })

  it('cyclePane 两个方向都回绕', () => {
    const pane = mounted()
    const ids = [pane.ws.panes()[0]!.id]
    ids.push(pane.splitPane('row').id)
    ids.push(pane.splitPane('row').id)
    expect(pane.ws.focusedPaneId()).toBe(ids[2])

    pane.ws.cyclePane(1)
    expect(pane.ws.focusedPaneId()).toBe(ids[0]) // 末尾往后绕回开头
    pane.ws.cyclePane(-1)
    expect(pane.ws.focusedPaneId()).toBe(ids[2]) // 开头往前绕到末尾
    pane.ws.cyclePane(-1)
    expect(pane.ws.focusedPaneId()).toBe(ids[1]) // 普通的往前一步
    pane.ws.cyclePane(1)
    expect(pane.ws.focusedPaneId()).toBe(ids[2]) // 普通的往后一步
  })

  it('只有一块分屏时 cyclePane 是空操作，不会把焦点丢成 -1', () => {
    const pane = mounted()
    const only = pane.ws.panes()[0]!.id
    pane.ws.cyclePane(1)
    pane.ws.cyclePane(-1)
    expect(pane.ws.focusedPaneId()).toBe(only)
  })

  it('closePane 合掉分屏，它显示的标签留在标签条上、现场也存了回去', () => {
    const pane = mounted()
    pane.type('左边')
    const leftTab = pane.ws.activeTab()
    const right = pane.splitPane('row')
    right.type('右边')
    const rightTab = pane.ws.activeTab()
    const leftId = pane.ws.panes()[0]!.id

    pane.ws.closePane(right.id)

    expect(pane.ws.panes()).toHaveLength(1)
    // 合并分屏不是关标签：两个标签都还在条上
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(tabText(rightTab)).toBe('右边')
    expect(rightTab.doc.dirty()).toBe(true)
    // 焦点落回剩下那块，活动标签也跟着回去
    expect(pane.ws.focusedPaneId()).toBe(leftId)
    expect(pane.ws.activeTab()).toBe(leftTab)
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 2 })
    expect(pane.ws.focusedEditor()).toBe(pane.controller)
  })

  it('合掉聚焦的分屏之后焦点落到剩下的最后一块；只剩一块时是空操作', () => {
    const pane = mounted()
    const a = pane.ws.panes()[0]!.id
    const b = pane.splitPane('row').id
    const c = pane.splitPane('row').id
    expect(pane.ws.focusedPaneId()).toBe(c)

    pane.ws.closePane(c)
    expect(pane.ws.focusedPaneId()).toBe(b)

    pane.ws.closePane(b)
    expect(pane.ws.panes().map((p) => p.id)).toEqual([a])

    pane.ws.closePane(a)
    expect(pane.ws.panes()).toHaveLength(1)
    expect(pane.ws.focusedPaneId()).toBe(a)
  })

  it('activateTab 命中别的分屏里显示着的标签时聚焦那块，而不是把它搬过来', () => {
    const pane = mounted()
    const right = pane.splitPane('row')
    const rightTab = pane.ws.activeTab()
    pane.ws.focusPane(pane.ws.panes()[0]!.id)
    const third = pane.ws.newTab() // 装进左边那块

    pane.ws.activateTab(rightTab.id)

    expect(pane.ws.focusedPaneId()).toBe(right.id)
    expect(pane.ws.activeTab()).toBe(rightTab)
    // 左边那块还显示着 third：搬走会让它空掉，而一个标签也不能同时显示在两处
    expect(pane.ws.panes()[0]!.tabId()).toBe(third.id)
  })

  it('activateTab 命中谁都没显示的标签时，把它装进聚焦的那块分屏', () => {
    const pane = mounted()
    const right = pane.splitPane('row')
    right.type('孤儿')
    const orphan = pane.ws.activeTab()
    pane.ws.closePane(right.id) // 标签留下，分屏没了
    expect(pane.ws.panes()[0]!.tabId()).not.toBe(orphan.id)

    pane.ws.activateTab(orphan.id)

    expect(pane.ws.panes()[0]!.tabId()).toBe(orphan.id)
    expect(pane.controller.doc).toBe('孤儿')
    expect(pane.ws.metrics()).toEqual({ lines: 1, chars: 2 })
  })

  it('setLineWrap 落到每一块分屏的 view 上，也落到没显示着的标签上', () => {
    const pane = mounted({ lineWrap: true })
    const right = pane.splitPane('row')
    const leftTab = pane.ws.tabs()[0]!

    pane.ws.focusPane(pane.ws.panes()[0]!.id)
    pane.ws.newTab() // 左边那块改显示这个新标签，leftTab 就谁都没显示了

    pane.ws.setLineWrap(false)

    // 显示中的标签看 view（snapshot 只在切走时更新，这会儿还是旧的）
    expect(lineWrapEnabled(pane.controller.view.state)).toBe(false)
    expect(lineWrapEnabled(right.controller.view.state)).toBe(false)
    // 没显示在任何分屏里的标签没有 view 可 dispatch，只能就地 update 出一个新 state
    expect(lineWrapEnabled(leftTab.snapshot.state)).toBe(false)
    expect(pane.ws.lineWrap()).toBe(false)
  })

  it('openAt 与 save 都落在聚焦的那块分屏上', async () => {
    const pane = mounted()
    pane.type('左边')
    const right = pane.splitPane('row')

    await pane.ws.openAt('/a.txt')

    // 复用「干净的无名标签」这条规则只看聚焦分屏的那个标签，所以落到了右边
    expect(right.text).toBe('正文')
    expect(pane.controller.doc).toBe('左边')
    expect(pane.ws.activeTab().doc.path()).toBe('/a.txt')

    right.type('追加')
    await pane.ws.save()
    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文追加', { encoding: 'utf8', bom: false, eol: 'lf' })

    // 焦点换到左边那块之后，保存的是左边那个标签——它没有路径，于是落到另存为
    pane.ws.focusPane(pane.ws.panes()[0]!.id)
    dialog.save.mockResolvedValue('/left.txt')
    await pane.ws.save()
    expect(ipc.saveFile).toHaveBeenCalledWith('/left.txt', '左边', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(right.controller.doc).toBe('正文追加')
  })

  it('closeTab 不会让两块分屏显示同一个标签', async () => {
    const pane = mounted()
    pane.type('左边')
    const leftTab = pane.ws.activeTab()
    const right = pane.splitPane('row')
    right.type('右边')

    pane.ws.focusPane(pane.ws.panes()[0]!.id)
    await pane.ws.closeTab(leftTab.id)

    // 右邻居（右边那个标签）正在另一块分屏里显示着，不能搬过来——补一个空标签
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.tabs()).not.toContain(leftTab)
    expect(pane.ws.panes()[0]!.tabId()).not.toBe(pane.ws.panes()[1]!.tabId())
    expect(pane.controller.doc).toBe('')
    expect(right.controller.doc).toBe('右边')
  })

  it('关掉没被任何分屏显示的标签，只是从条上摘掉', async () => {
    const pane = mounted()
    const right = pane.splitPane('row')
    right.type('孤儿')
    const orphan = pane.ws.activeTab()
    pane.ws.closePane(right.id)
    const leftId = pane.ws.panes()[0]!.id
    const shownBefore = pane.ws.panes()[0]!.tabId()

    await pane.ws.closeTab(orphan.id)

    expect(pane.ws.tabs()).not.toContain(orphan)
    expect(pane.ws.panes()).toHaveLength(1)
    expect(pane.ws.panes()[0]!.tabId()).toBe(shownBefore)
    expect(pane.ws.focusedPaneId()).toBe(leftId)
  })
})

describe('关闭确认', () => {
  /** 记下问过什么、并一律答同一个决策 */
  function recorder(decision: DiscardDecision) {
    const calls: string[][] = []
    const promptDiscard: DiscardPrompt = async (names) => {
      calls.push(names)
      return decision
    }
    return { calls, promptDiscard }
  }

  it('干净标签压根不问', async () => {
    const prompt = recorder('discard')
    const pane = mounted({ promptDiscard: prompt.promptDiscard })
    await pane.ws.closeTab(pane.ws.activeTab().id)
    expect(prompt.calls).toEqual([])
  })

  it('答「取消」：标签留着，脏标记也留着', async () => {
    const prompt = recorder('cancel')
    const pane = mounted({ promptDiscard: prompt.promptDiscard })
    await pane.ws.openAt('/a.txt')
    pane.type('改')
    const tab = pane.ws.activeTab()

    await pane.ws.closeTab(tab.id)

    expect(prompt.calls).toEqual([['a.txt']])
    expect(pane.ws.tabs()).toEqual([tab])
    expect(tab.doc.dirty()).toBe(true)
    expect(ipc.saveFile).not.toHaveBeenCalled()
  })

  it('答「不保存」：直接摘掉，一个字节都不写', async () => {
    const pane = mounted({ promptDiscard: async () => 'discard' })
    await pane.ws.openAt('/a.txt')
    pane.type('改')

    await pane.ws.closeTab(pane.ws.activeTab().id)

    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(pane.ws.tabs()).toHaveLength(1) // 补进来的那个空标签
    expect(pane.ws.activeTab().doc.path()).toBeNull()
  })

  it('答「保存」：先写盘再关', async () => {
    const pane = mounted({ promptDiscard: async () => 'save' })
    await pane.ws.openAt('/a.txt')
    pane.type('改')

    await pane.ws.closeTab(pane.ws.activeTab().id)

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(pane.ws.activeTab().doc.path()).toBeNull()
  })

  it('答「保存」但写盘失败：标签必须留着，否则用户以为已经保存了', async () => {
    const pane = mounted({ promptDiscard: async () => 'save' })
    await pane.ws.openAt('/a.txt')
    pane.type('改')
    const tab = pane.ws.activeTab()
    ipc.saveFile.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '权限不够' })

    await pane.ws.closeTab(tab.id)

    expect(pane.ws.tabs()).toEqual([tab])
    expect(tab.doc.dirty()).toBe(true)
    expect(tab.doc.notice()?.level).toBe('error')
  })

  it('无名文档答「保存」会落到另存为；那个对话框被取消时同样中止关闭', async () => {
    const pane = mounted({ promptDiscard: async () => 'save' })
    pane.type('没名字的稿子')
    const tab = pane.ws.activeTab()
    dialog.save.mockResolvedValue(null)

    await pane.ws.closeTab(tab.id)

    expect(dialog.save).toHaveBeenCalled()
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(pane.ws.tabs()).toEqual([tab])

    // 这次给个路径，就该写盘并关掉
    dialog.save.mockResolvedValue('/chosen.txt')
    await pane.ws.closeTab(tab.id)
    expect(ipc.saveFile).toHaveBeenCalledWith('/chosen.txt', '没名字的稿子', {
      encoding: 'utf8',
      bom: false,
      eol: 'lf',
    })
    expect(pane.ws.tabs()).not.toContain(tab)
  })

  it('没注入 promptDiscard 时默认答「取消」——静默丢数据是不可接受的缺省值', async () => {
    const bare = createWorkspace()
    const tab = bare.tabs()[0]!
    tab.doc.markChanged()

    await bare.closeTab(tab.id)

    expect(bare.tabs()).toEqual([tab])
    expect(tab.doc.dirty()).toBe(true)
  })

  describe('requestWindowClose（窗口级总闸）', () => {
    it('全干净：直接放行，不问', async () => {
      const prompt = recorder('cancel')
      const pane = mounted({ promptDiscard: prompt.promptDiscard })
      await pane.ws.openAt('/a.txt')
      pane.ws.newTab()

      expect(await pane.ws.requestWindowClose()).toBe(true)
      expect(prompt.calls).toEqual([])
    })

    it('多个脏标签一次问完，而不是一个一个弹', async () => {
      const prompt = recorder('discard')
      const pane = mounted({ promptDiscard: prompt.promptDiscard })
      await pane.ws.openAt('/a.txt')
      pane.type('改')
      pane.ws.newTab()
      await pane.ws.openAt('/b.txt')
      pane.type('也改')

      expect(await pane.ws.requestWindowClose()).toBe(true)
      expect(prompt.calls).toEqual([['a.txt', 'b.txt']])
    })

    it('答「取消」：返回 false，一个标签都不动', async () => {
      const pane = mounted({ promptDiscard: async () => 'cancel' })
      await pane.ws.openAt('/a.txt')
      pane.type('改')

      expect(await pane.ws.requestWindowClose()).toBe(false)
      expect(pane.ws.tabs()).toHaveLength(1)
      expect(pane.ws.activeTab().doc.dirty()).toBe(true)
    })

    it('答「保存」：全部落盘之后才放行', async () => {
      const pane = mounted({ promptDiscard: async () => 'save' })
      await pane.ws.openAt('/a.txt')
      pane.type('改')
      pane.ws.newTab()
      await pane.ws.openAt('/b.txt')
      pane.type('也改')

      expect(await pane.ws.requestWindowClose()).toBe(true)
      expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
      expect(ipc.saveFile).toHaveBeenCalledWith('/b.txt', '正文也改', { encoding: 'utf8', bom: false, eol: 'lf' })
      expect(pane.ws.anyDirty()).toBe(false)
    })

    it('答「保存」但其中一个写不下去：不放行——半关状态比不关更糟', async () => {
      const pane = mounted({ promptDiscard: async () => 'save' })
      await pane.ws.openAt('/a.txt')
      pane.type('改')
      pane.ws.newTab()
      await pane.ws.openAt('/b.txt')
      pane.type('也改')
      ipc.saveFile.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '权限不够' })

      expect(await pane.ws.requestWindowClose()).toBe(false)
      expect(pane.ws.tabs()).toHaveLength(2)
      expect(pane.ws.anyDirty()).toBe(true)
    })
  })
})
