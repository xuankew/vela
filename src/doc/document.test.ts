import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 文档模型的单测。
 *
 * 刻意在 node 环境里跑、刻意把 `../ipc/fs` 与 dialog 插件都 mock 掉：这一层的全部价值
 * 就是「状态机的迁移是否正确」，不需要 CM6、不需要 jsdom、更不需要真的 Tauri 运行时。
 * 真·端到端（前端 → IPC → vela-core → 磁盘）由 Rust 侧的测试覆盖。
 */

const { ipc, dialog } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    // describeFsError 换成假的：它自己另有测试，这里只关心错误能落到 notice 文案里
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
  },
  dialog: { open: vi.fn(), save: vi.fn() },
}))

vi.mock('../ipc/fs', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)

import { createDocumentModel, DEFAULT_FORMAT, UNTITLED_LABEL, type DocumentHost, type DocumentModel } from './document'
import type { TextFile, WriteReport } from '../ipc/fs'

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

/** 假宿主：一个正文字符串 + 一个焦点计数器，不起 CM6 */
function harness() {
  const state = { text: '', focuses: 0 }
  const host: DocumentHost = {
    getText: () => state.text,
    setText: (t) => {
      state.text = t
    },
    focus: () => {
      state.focuses += 1
    },
  }
  return { doc: createDocumentModel(host), state, host }
}

beforeEach(() => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  ipc.saveFile.mockResolvedValue(OK_REPORT)
})

describe('初始状态与新建', () => {
  it('一开始是无名空文档，不脏', () => {
    const { doc } = harness()
    expect(doc.path()).toBeNull()
    expect(doc.name()).toBe(UNTITLED_LABEL)
    expect(doc.dirty()).toBe(false)
    expect(doc.lossy()).toBe(false)
    expect(doc.notice()).toBeNull()
    expect(doc.busy()).toBe(false)
    expect(doc.format()).toEqual(DEFAULT_FORMAT)
  })

  it('新建文档清空正文、路径与所有警告', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile({ lossy: true }))
    await doc.openAt('/a/b.txt')
    state.text = '改过了'
    doc.markChanged()
    ipc.saveFile.mockResolvedValue({ bytesWritten: 1, unmappable: true })
    await doc.save()
    expect(doc.notice()).not.toBeNull()
    expect(doc.dirty()).toBe(false)

    doc.newDocument()
    expect(state.text).toBe('')
    expect(doc.path()).toBeNull()
    expect(doc.name()).toBe(UNTITLED_LABEL)
    expect(doc.dirty()).toBe(false)
    expect(doc.lossy()).toBe(false)
    expect(doc.notice()).toBeNull()
    expect(doc.format()).toEqual(DEFAULT_FORMAT)
  })
})

describe('打开', () => {
  it('正文、路径、格式落地，脏标记清零，编辑器拿到焦点', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(
      textFile({ text: '第一行\n第二行\n', format: { encoding: 'gbk', bom: false, eol: 'crlf' }, bytes: 16 }),
    )
    await doc.openAt('/tmp/win.txt')

    expect(ipc.openFile).toHaveBeenCalledWith('/tmp/win.txt')
    expect(state.text).toBe('第一行\n第二行\n')
    expect(doc.path()).toBe('/tmp/win.txt')
    expect(doc.name()).toBe('win.txt')
    expect(doc.format()).toEqual({ encoding: 'gbk', bom: false, eol: 'crlf' })
    expect(doc.dirty()).toBe(false)
    expect(doc.busy()).toBe(false)
    expect(state.focuses).toBe(1)
  })

  /*
   * 这条是 `replacing` 标志存在的全部理由：`setText` 会让 CM6 回调 `docChanged`，
   * 宿主接着调 `markChanged`。挡不住的话刚打开的文件立刻显示成「未保存」。
   */
  it('整篇替换正文时，即使宿主同步回调 markChanged 也不算用户改动', async () => {
    const state = { text: '', focuses: 0 }
    let doc!: DocumentModel
    const host: DocumentHost = {
      getText: () => state.text,
      setText: (t) => {
        state.text = t
        doc.markChanged()
      },
      focus: () => {
        state.focuses += 1
      },
    }
    doc = createDocumentModel(host)
    ipc.openFile.mockResolvedValue(textFile({ text: '新正文' }))

    await doc.openAt('/a.txt')
    expect(state.text).toBe('新正文')
    expect(doc.dirty()).toBe(false)

    // 用户真的改一下，脏标记立刻生效
    state.text = '改过了'
    doc.markChanged()
    expect(doc.dirty()).toBe(true)
  })

  it('有损解码常驻 lossy，而不是一条会消失的通知', async () => {
    const { doc } = harness()
    ipc.openFile.mockResolvedValue(textFile({ lossy: true, format: { encoding: 'gbk', bom: false, eol: 'lf' } }))
    await doc.openAt('/broken.bin')
    expect(doc.lossy()).toBe(true)
    expect(doc.notice()).toBeNull()

    await doc.save()
    expect(doc.lossy()).toBe(true)
  })

  it('打开失败时报错，且不动当前文档', async () => {
    const { doc, state } = harness()
    state.text = '原内容'
    ipc.openFile.mockRejectedValue({ kind: 'too_large', bytes: 5_000_000, limit: 4_194_304 })

    await doc.openAt('/huge.log')

    expect(doc.notice()?.level).toBe('error')
    expect(doc.notice()?.text).toContain('too_large')
    expect(doc.path()).toBeNull()
    expect(state.text).toBe('原内容')
    expect(doc.busy()).toBe(false)
    expect(state.focuses).toBe(0)
  })

  it('对话框取消时什么都不发生', async () => {
    const { doc, state } = harness()
    dialog.open.mockResolvedValue(null)
    await doc.openViaDialog()
    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(state.focuses).toBe(0)
  })

  it('对话框选中文件后走 openAt', async () => {
    const { doc } = harness()
    dialog.open.mockResolvedValue('/picked/file.md')
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openViaDialog()
    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: false })
    expect(doc.path()).toBe('/picked/file.md')
  })
})

describe('保存与另存为', () => {
  it('有路径时直接写回，不弹对话框，并原样回传打开时收到的 format', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile({ format: { encoding: 'utf16_le', bom: true, eol: 'crlf' } }))
    await doc.openAt('/a/b.txt')
    state.text = '改了'
    doc.markChanged()
    expect(doc.dirty()).toBe(true)

    await doc.save()

    expect(dialog.save).not.toHaveBeenCalled()
    expect(ipc.saveFile).toHaveBeenCalledWith('/a/b.txt', '改了', { encoding: 'utf16_le', bom: true, eol: 'crlf' })
    expect(doc.dirty()).toBe(false)
    expect(doc.notice()).toBeNull()
  })

  it('无路径时 save 落到另存为：用对话框拿路径再写', async () => {
    const { doc, state } = harness()
    state.text = '新内容'
    doc.markChanged()
    dialog.save.mockResolvedValue('/chosen/new.txt')

    await doc.save()

    expect(dialog.save).toHaveBeenCalledWith({ defaultPath: undefined })
    expect(ipc.saveFile).toHaveBeenCalledWith('/chosen/new.txt', '新内容', DEFAULT_FORMAT)
    expect(doc.path()).toBe('/chosen/new.txt')
    expect(doc.name()).toBe('new.txt')
    expect(doc.dirty()).toBe(false)
  })

  it('另存为会把后续 save 指向新路径', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/old/a.txt')
    dialog.save.mockResolvedValue('/new/b.txt')
    state.text = 'v2'

    await doc.saveAs()
    await doc.save()

    expect(ipc.saveFile).toHaveBeenLastCalledWith('/new/b.txt', 'v2', DEFAULT_FORMAT)
  })

  it('另存为取消时不写盘、脏标记保留', async () => {
    const { doc, state } = harness()
    state.text = '内容'
    doc.markChanged()
    dialog.save.mockResolvedValue(null)

    await doc.saveAs()

    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(doc.dirty()).toBe(true)
    expect(doc.path()).toBeNull()
  })

  it('写盘失败时脏标记必须留着，否则用户以为已经保存了', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/a.txt')
    state.text = '改了'
    doc.markChanged()
    ipc.saveFile.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '权限不够' })

    await doc.save()

    expect(doc.dirty()).toBe(true)
    expect(doc.notice()?.level).toBe('error')
    expect(doc.notice()?.text).toContain('权限不够')
    expect(doc.busy()).toBe(false)
  })

  it('目标编码装不下字符时给出可行动的警告', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile({ format: { encoding: 'gbk', bom: false, eol: 'lf' } }))
    await doc.openAt('/a.txt')
    state.text = '中文😀'
    ipc.saveFile.mockResolvedValue({ bytesWritten: 12, unmappable: true })

    await doc.save()

    expect(doc.notice()?.level).toBe('warning')
    expect(doc.notice()?.text).toContain('GBK')
    expect(doc.notice()?.text).toContain('UTF-8')
    // 写盘确实成功了，所以脏标记照样清零——警告说的是「内容已损坏」，不是「没保存」
    expect(doc.dirty()).toBe(false)
  })

  it('dismissNotice 只清通知，不影响 lossy 与脏标记', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile({ lossy: true }))
    await doc.openAt('/broken.bin')
    state.text = 'x'
    doc.markChanged()
    ipc.saveFile.mockRejectedValue({ kind: 'no_parent', path: 'bare.txt' })
    await doc.save()

    doc.dismissNotice()

    expect(doc.notice()).toBeNull()
    expect(doc.lossy()).toBe(true)
    expect(doc.dirty()).toBe(true)
  })
})
