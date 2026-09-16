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
  const state = { text: '', focuses: 0, pathChanges: 0 }
  const host: DocumentHost = {
    getText: () => state.text,
    setText: (t) => {
      state.text = t
    },
    focus: () => {
      state.focuses += 1
    },
    pathChanged: () => {
      state.pathChanges += 1
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

describe('初始状态', () => {
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
      pathChanged: () => {},
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

  // 「弹对话框选文件」的两条用例（取消 / 选中后走 openAt）在 workspace.test.ts 里：
  // 打开一个文件先要决定它落到哪个标签，那是 workspace 的职责，不再是文档模型的。
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

describe('编码与换行符切换（M1-E-2b）', () => {
  it('changeFormat 合并进现有格式，并且**算一次未保存的改动**', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile({ format: { encoding: 'utf8', bom: false, eol: 'lf' } }))
    await doc.openAt('/a.txt')
    expect(doc.dirty()).toBe(false)

    doc.changeFormat({ encoding: 'gbk', bom: false })

    expect(doc.format()).toEqual({ encoding: 'gbk', bom: false, eol: 'lf' })
    // 不标脏的话：用户改成 GBK 之后直接关窗，关闭确认看 dirty 是 false 就放行，
    // 磁盘上还是 UTF-8——这个决定被静默扔掉
    expect(doc.dirty()).toBe(true)
    // 改的是「怎么写出去」，正文一个字节都不该动
    expect(state.text).toBe('正文')
  })

  it('只改换行符时编码与 BOM 保持原样', async () => {
    const { doc } = harness()
    ipc.openFile.mockResolvedValue(textFile({ format: { encoding: 'utf16_le', bom: true, eol: 'lf' } }))
    await doc.openAt('/a.txt')

    doc.changeFormat({ eol: 'crlf' })

    expect(doc.format()).toEqual({ encoding: 'utf16_le', bom: true, eol: 'crlf' })
  })

  it('改过的格式会被 save 原样传下去', async () => {
    const { doc } = harness()
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/a.txt')

    doc.changeFormat({ encoding: 'gbk', bom: false })
    doc.changeFormat({ eol: 'crlf' })
    await doc.save()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文', { encoding: 'gbk', bom: false, eol: 'crlf' })
    expect(doc.dirty()).toBe(false)
  })

  it('reopenWith 把编码传给 openFile，并采纳后端给的正文与格式', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValueOnce(textFile({ lossy: true }))
    await doc.openAt('/misdetected.txt')
    expect(state.text).toBe('正文')
    expect(doc.lossy()).toBe(true)

    ipc.openFile.mockResolvedValueOnce(
      textFile({ text: '模', format: { encoding: 'gbk', bom: false, eol: 'lf' }, lossy: false }),
    )
    await doc.reopenWith('gbk')

    // 第二个参数就是这条方法的全部内容：漏了它后端收到 None，「重新打开」静默退化成
    // 「再探测一次」，用户看到的还是同一屏乱码
    expect(ipc.openFile).toHaveBeenLastCalledWith('/misdetected.txt', 'gbk')
    expect(state.text).toBe('模')
    expect(doc.format()).toEqual({ encoding: 'gbk', bom: false, eol: 'lf' })
    // 重读一遍不算用户的改动；lossy 也跟着后端重算，原来那条警告该消失
    expect(doc.dirty()).toBe(false)
    expect(doc.lossy()).toBe(false)
    expect(doc.notice()).toBeNull()
    expect(doc.busy()).toBe(false)
    // 路径没变 → 语言没变，不该报 pathChanged（那会让宿主白重装一次语言槽位）
    expect(state.pathChanges).toBe(1) // 只有最初那次 openAt 报过
    expect(state.focuses).toBe(2)
  })

  it('有未保存的改动时拒绝重开：一次 IO 都不发', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/a.txt')
    state.text = '改过了'
    doc.markChanged()

    await doc.reopenWith('gbk')

    // 重新解码是从磁盘重读，会把改动整个扔掉，所以这里必须什么都不做
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
    expect(state.text).toBe('改过了')
    expect(doc.dirty()).toBe(true)
    expect(doc.notice()?.level).toBe('warning')
    expect(doc.notice()?.text).toContain('未保存的改动')
    expect(doc.busy()).toBe(false)
  })

  it('无名文档上 reopenWith 是空操作：磁盘上没有字节可重读', async () => {
    const { doc } = harness()

    await expect(doc.reopenWith('gbk')).resolves.toBeUndefined()

    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(doc.notice()).toBeNull()
  })

  it('重开失败时报错，正文与格式都保持原样', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValueOnce(textFile())
    await doc.openAt('/a.txt')
    ipc.openFile.mockRejectedValueOnce({ kind: 'io', reason: 'PermissionDenied', message: '权限不够' })

    await doc.reopenWith('gbk')

    expect(state.text).toBe('正文')
    expect(doc.format()).toEqual({ encoding: 'utf8', bom: false, eol: 'lf' })
    expect(doc.notice()?.level).toBe('error')
    expect(doc.notice()?.text).toContain('权限不够')
    expect(doc.busy()).toBe(false)
  })
})

describe('restoreDraft（M1-F 会话恢复）', () => {
  /** 正文一落地就同步回调 markChanged 的宿主：`replacing` 标志只有在这种宿主下才真的被考验 */
  function eagerHarness() {
    const state = { text: '', focuses: 0, pathChanges: 0, textAtPathChange: [] as string[] }
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
      pathChanged: () => {
        state.pathChanges += 1
        // 记下这一刻的正文，用来验证「先换正文，再报路径变了」这个顺序
        state.textAtPathChange.push(state.text)
      },
    }
    doc = createDocumentModel(host)
    return { doc, state }
  }

  it('整份现场来自入参，一次磁盘都不碰', () => {
    const { doc, state } = eagerHarness()

    doc.restoreDraft({
      path: '/notes/draft.md',
      text: '恢复出来的正文',
      format: { encoding: 'gbk', bom: false, eol: 'crlf' },
      dirty: true,
      lossy: false,
    })

    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(state.text).toBe('恢复出来的正文')
    expect(doc.path()).toBe('/notes/draft.md')
    expect(doc.name()).toBe('draft.md')
    expect(doc.format()).toEqual({ encoding: 'gbk', bom: false, eol: 'crlf' })
    expect(doc.busy()).toBe(false)
  })

  it('dirty 由存档说了算：true 保得住，false 也不会被替换动作弄脏', () => {
    const dirtyOne = eagerHarness()
    dirtyOne.doc.restoreDraft({ path: '/a.txt', text: 'x', format: DEFAULT_FORMAT, dirty: true, lossy: false })
    expect(dirtyOne.doc.dirty()).toBe(true)

    // 干净的存档（有路径、内容能从磁盘读回来）恢复出来必须还是干净的，
    // 否则下次关窗口的确认会为一个其实没改过的文件弹一次
    const cleanOne = eagerHarness()
    cleanOne.doc.restoreDraft({ path: '/a.txt', text: 'x', format: DEFAULT_FORMAT, dirty: false, lossy: false })
    expect(cleanOne.doc.dirty()).toBe(false)
    // 而宿主确实回调过 markChanged：挡住它的是 replacing 标志，不是「没人调」
    expect(cleanOne.state.text).toBe('x')
  })

  it('未命名文档也恢复得回来：path 是 null，正文与格式照旧落地', () => {
    const { doc, state } = eagerHarness()

    doc.restoreDraft({
      path: null,
      text: '还没落过盘的稿子',
      format: { encoding: 'utf16_le', bom: true, eol: 'lf' },
      dirty: true,
      lossy: false,
    })

    expect(doc.path()).toBeNull()
    expect(doc.name()).toBe(UNTITLED_LABEL)
    expect(state.text).toBe('还没落过盘的稿子')
    // 未命名文档的格式决定只能存在会话里，丢了就等于把用户选的编码扔了
    expect(doc.format()).toEqual({ encoding: 'utf16_le', bom: true, eol: 'lf' })
  })

  it('pathChanged 报一次，而且是在正文已经就位之后', () => {
    const { doc, state } = eagerHarness()

    doc.restoreDraft({ path: '/a.ts', text: 'const a = 1', format: DEFAULT_FORMAT, dirty: true, lossy: false })

    // 重建 state 会把语言槽位清空，所以必须报；报两次会让宿主白重装一次语言
    expect(state.pathChanges).toBe(1)
    // 反过来的话语言会装到一个马上被丢弃的 state 上，而且静默无报错
    expect(state.textAtPathChange).toEqual(['const a = 1'])
  })

  it('lossy 跟着存档走：丢了它就等于把「原样保存会损坏这个文件」的警告删掉', () => {
    const { doc } = eagerHarness()

    doc.restoreDraft({ path: '/broken.bin', text: '有\uFFFD', format: DEFAULT_FORMAT, dirty: false, lossy: true })

    expect(doc.lossy()).toBe(true)
    expect(doc.notice()).toBeNull()
  })

  it('不抢焦点：恢复好几个标签时，焦点不该落在恰好最后处理的那个上', () => {
    const { doc, state } = eagerHarness()

    doc.restoreDraft({ path: '/a.txt', text: 'x', format: DEFAULT_FORMAT, dirty: false, lossy: false })

    // openAt 会 host.focus()，restoreDraft 刻意不会——聚焦哪块分屏是 workspace 的事
    expect(state.focuses).toBe(0)
  })

  it('覆盖掉原来那份文档，连通知一起清掉', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockRejectedValue({ kind: 'io', reason: 'NotFound', message: '没了' })
    await doc.openAt('/gone.txt')
    expect(doc.notice()?.level).toBe('error')

    doc.restoreDraft({ path: '/real.txt', text: '真的', format: DEFAULT_FORMAT, dirty: true, lossy: false })

    expect(doc.notice()).toBeNull()
    expect(state.text).toBe('真的')
    expect(doc.path()).toBe('/real.txt')
  })
})

describe('discardChanges（M1-F：答了「不保存」之后）', () => {
  /** 正文一落地就同步回调 markChanged 的宿主：`replacing` 标志只有在这种宿主下才真的被考验 */
  function eagerHarness() {
    const state = { text: '' }
    let doc!: DocumentModel
    const host: DocumentHost = {
      getText: () => state.text,
      setText: (t) => {
        state.text = t
        doc.markChanged()
      },
      focus: () => {},
      pathChanged: () => {},
    }
    doc = createDocumentModel(host)
    return { doc, state }
  }

  it('有路径的：清脏标记，正文与路径都不动，也不去重读磁盘', async () => {
    const { doc, state } = harness()
    // beforeEach 只 reset 了 openFile、没给默认返回值，不补的话 openAt 会静默失败、路径留在 null
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/a.txt')
    state.text = '正文改'
    doc.markChanged()
    expect(doc.dirty()).toBe(true)

    doc.discardChanges()

    expect(doc.dirty()).toBe(false)
    // 刻意不回滚正文：真回滚要重新读一次盘，而这条路跑在关窗/关标签的半路上，
    // 读失败会把一个已经放行了的关闭又卡住。调用方紧接着就把窗口拆了
    expect(state.text).toBe('正文改')
    expect(doc.path()).toBe('/a.txt')
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
    expect(ipc.saveFile).not.toHaveBeenCalled()
  })

  it('未命名的：正文一起清空——磁盘上没有它，正文就是唯一的副本', () => {
    const { doc, state } = harness()
    state.text = '从没落过盘的稿子'
    doc.markChanged()

    doc.discardChanges()

    expect(doc.dirty()).toBe(false)
    expect(state.text).toBe('')
    expect(doc.path()).toBeNull()
  })

  it('清正文这个动作本身不会又把文档标脏', () => {
    const { doc, state } = eagerHarness()
    state.text = '稿子'
    doc.markChanged()
    expect(doc.dirty()).toBe(true)

    doc.discardChanges()

    // setText 同步回调了 markChanged，靠 `replacing` 标志挡住；挡不住的话
    // 「不保存」就变成了「把文档标脏再清空」，存档照样会收下这个空草稿
    expect(doc.dirty()).toBe(false)
    expect(state.text).toBe('')
  })

  it('本来就干净的文档上是空操作', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/a.txt')

    doc.discardChanges()

    expect(doc.dirty()).toBe(false)
    expect(state.text).toBe('正文')
    expect(doc.notice()).toBeNull()
  })
})
