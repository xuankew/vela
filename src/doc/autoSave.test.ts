// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `autoSave` 的单测：什么时候写、写谁、谁不能写。
 *
 * **假的只有 IPC、原生对话框与定时器**。workspace、文档模型、编辑器都是真的：
 * 这一层的全部价值就是「用户敲完字之后，磁盘上到底有没有那几个字」，拿替身文档的话，
 * 测的就变成自己跟自己玩了。
 *
 * 定时器必须换成手动挡：真的等 1.5 秒 × 八九条用例，测试跑起来就没法用了
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

import { createRoot } from 'solid-js'
import type { EditorState } from '@codemirror/state'
import { EditorController } from '../editor/controller'
import type { TextFile, WriteReport } from '../ipc/fs'
import { createAutoSave } from './autoSave'
import { DEFAULT_FORMAT } from './document'
import { createWorkspace, type Workspace } from './workspace'
import type { Timer } from '../ui/timer'

function textFile(overrides: Partial<TextFile> = {}): TextFile {
  return {
    text: '正文',
    format: { encoding: 'utf8', bom: false, eol: 'lf' },
    lossy: false,
    bytes: 6,
    ...overrides,
  }
}

const OK_WRITE: WriteReport = { bytesWritten: 6, unmappable: false }

/** 让在飞的 promise 链落地。`saveFile` 是 mock，一轮宏任务足够 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * 手动挡定时器：同一时刻只有一个待跑的（`createDebounced` 的语义就是这样，
 * 重复排期会先把上一个取消掉）
 */
function fakeTimer() {
  let pending: { id: number; fn: () => void } | null = null
  let nextId = 1
  const timer: Timer = {
    after: (fn) => {
      const id = nextId++
      pending = { id, fn }
      return id
    },
    cancel: (id) => {
      if (pending?.id === id) pending = null
    },
  }
  return {
    timer,
    get armed() {
      return pending !== null
    },
    async fire() {
      const item = pending
      pending = null
      item?.fn()
      await flush()
    },
  }
}

const liveEditors: { controller: EditorController; host: HTMLElement }[] = []
const disposers: (() => void)[] = []

function attachEditor(ws: Workspace, paneId: number, state: EditorState): EditorController {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const controller = new EditorController(host, state)
  liveEditors.push({ controller, host })
  ws.attach(paneId, controller)
  return controller
}

function harness() {
  return createRoot((dispose) => {
    disposers.push(dispose)
    const ws = createWorkspace({ promptDiscard: async () => 'cancel' })
    const editor = attachEditor(ws, ws.panes()[0]!.id, ws.activeTab().snapshot.state)
    const clock = fakeTimer()
    /** 接的是 `fileWatch.hasConflict` 的位置：测试里直接点名哪个标签「排着冲突」 */
    const blocked = new Set<number>()
    createAutoSave({ workspace: ws, timer: clock.timer, blocked: (id) => blocked.has(id) })
    return {
      ws,
      editor,
      clock,
      blocked,
      type(text: string) {
        const at = editor.view.state.doc.length
        editor.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
      },
    }
  })
}

beforeEach(() => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  ipc.openFile.mockResolvedValue(textFile())
  ipc.saveFile.mockResolvedValue(OK_WRITE)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const { controller, host } of liveEditors.splice(0)) {
    controller.destroy()
    host.remove()
  }
})

describe('自动存盘：停手之后把该落的盘落掉', () => {
  it('连续打字只写一次，写回原路径，脏标记随后清掉', async () => {
    const h = harness()
    ipc.openFile.mockResolvedValue(textFile({ text: '原文' }))
    await h.ws.openAt('/a.txt')

    h.type('加几个字')
    h.type('，再一句')
    await h.clock.fire()

    expect(ipc.saveFile).toHaveBeenCalledTimes(1)
    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '原文加几个字，再一句', DEFAULT_FORMAT)
    expect(h.ws.activeTab().doc.dirty()).toBe(false)
  })

  it('打开文件本身不算改动，一个字都不会写', async () => {
    const h = harness()
    await h.ws.openAt('/a.txt')
    await h.clock.fire()

    expect(ipc.saveFile).not.toHaveBeenCalled()
  })

  it('未命名的脏文档不自动存：那条路会弹「另存为」，定时器不能弹它', async () => {
    const h = harness()
    h.type('还没起名字的稿子')
    await h.clock.fire()

    expect(dialog.save).not.toHaveBeenCalled()
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(h.ws.activeTab().doc.dirty()).toBe(true)
  })

  it('恢复出来的草稿不会自动覆盖磁盘，直到用户真的改过它', async () => {
    const h = harness()
    ipc.openFile.mockResolvedValue(textFile({ text: '盘上的正文' }))
    await h.ws.openAt('/a.txt')
    h.ws.activeTab().doc.restoreDraft({
      path: '/a.txt',
      text: '上次没存上的草稿',
      format: DEFAULT_FORMAT,
      dirty: true,
      lossy: false,
    })

    await h.clock.fire()
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(h.ws.activeTab().doc.dirty()).toBe(true)

    h.type('！')
    await h.clock.fire()
    expect(ipc.saveFile).toHaveBeenCalledTimes(1)
    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '上次没存上的草稿！', DEFAULT_FORMAT)
    expect(h.ws.activeTab().doc.dirty()).toBe(false)
  })

  it('有损解码的文档不自动写回：原样保存就是拿替换字符覆盖原文件', async () => {
    const h = harness()
    ipc.openFile.mockResolvedValue(textFile({ text: '有\uFFFD的正文', lossy: true }))
    await h.ws.openAt('/bad.txt')

    h.type('x')
    await h.clock.fire()

    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(h.ws.activeTab().doc.dirty()).toBe(true)
  })

  it('还排着文件冲突的标签不写：写下去等于替用户选「覆盖」', async () => {
    const h = harness()
    await h.ws.openAt('/a.txt')
    h.blocked.add(h.ws.activeTab().id)

    h.type('改')
    await h.clock.fire()
    expect(ipc.saveFile).not.toHaveBeenCalled()

    // 冲突问完（用户选了「保留我的改动」）之后接着编辑，才重新进入自动存盘的范围
    h.blocked.delete(h.ws.activeTab().id)
    h.type('再改')
    await h.clock.fire()
    expect(ipc.saveFile).toHaveBeenCalledTimes(1)
  })

  it('手动保存正在飞的时候敲的字不会永远悬着：那一轮落定之后自动补存', async () => {
    const h = harness()
    ipc.openFile.mockResolvedValue(textFile({ text: '原文' }))
    await h.ws.openAt('/a.txt')

    let finish: (report: WriteReport) => void = () => {}
    ipc.saveFile.mockReturnValueOnce(
      new Promise<WriteReport>((resolve) => {
        finish = resolve
      }),
    )
    h.type('第一笔')
    const saving = h.ws.activeTab().doc.save()
    // 手动那次还悬着，用户又敲了字；自动存盘这一轮撞上 `busy`，只能让路
    h.type('第二笔')
    await h.clock.fire()
    expect(ipc.saveFile).toHaveBeenCalledTimes(1)
    expect(h.clock.armed, '让路之后必须再排一次，否则第二笔没人存').toBe(true)

    finish(OK_WRITE)
    await saving
    await h.clock.fire()

    expect(ipc.saveFile).toHaveBeenCalledTimes(2)
    expect(ipc.saveFile).toHaveBeenLastCalledWith('/a.txt', '原文第一笔第二笔', DEFAULT_FORMAT)
    expect(h.ws.activeTab().doc.dirty()).toBe(false)
  })
})
