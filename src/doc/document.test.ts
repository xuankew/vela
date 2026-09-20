import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 文档模型的单测。
 *
 * 刻意在 node 环境里跑、刻意把 `../ipc/fs` 与 dialog 插件都 mock 掉：这一层的全部价值
 * 就是「状态机的迁移是否正确」，不需要 CM6、不需要 jsdom、更不需要真的 Tauri 运行时。
 * 真·端到端（前端 → IPC → vela-core → 磁盘）由 Rust 侧的测试覆盖。
 */

const { ipc, dialog, shardIpc, shardFactory } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    // describeFsError 换成假的：它自己另有测试，这里只关心错误能落到 notice 文案里
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
  },
  dialog: { open: vi.fn(), save: vi.fn() },
  shardIpc: { openLarge: vi.fn(), closeLarge: vi.fn() },
  // 🔴 `createShardView` 要 mock 掉，理由不是它「不纯」（它内部那个 memo 自己裹在
  // `createRoot` 里，见 shardView.ts），而是它建好就**立刻**要第一页，而上面那个
  // `shardIpc` 替身里没有 `readLines`——真跑起来是一条没人接的 rejection。
  // 而 `document.ts` 对它的用法只有「存下来 + 调 dispose」，替身足够
  shardFactory: { createShardView: vi.fn() },
}))

vi.mock('../ipc/fs', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
vi.mock('../ipc/shard', () => shardIpc)
vi.mock('./shardView', () => shardFactory)

import { createDocumentModel, DEFAULT_FORMAT, UNTITLED_LABEL, type DocumentHost, type DocumentModel } from './document'
import type { TextFile, WriteReport } from '../ipc/fs'
import type { ShardOpen } from '../ipc/shard'
import type { ShardView } from './shardView'
import type { Mock } from 'vitest'

function textFile(overrides: Partial<TextFile> = {}): TextFile {
  return {
    text: '正文',
    format: { encoding: 'utf8', bom: false, eol: 'lf' },
    lossy: false,
    bytes: 6,
    ...overrides,
  }
}

/** `open_file` 撞 4 MiB 时后端给的形状（见 `ipc/fs.ts` 的 `ReadError`） */
const TOO_LARGE_INLINE = { kind: 'too_large', bytes: 5_000_000, limit: 4_194_304 }

function shardOpen(overrides: Partial<ShardOpen['header']> = {}): ShardOpen {
  return {
    handle: 7,
    header: {
      totalLines: 1_200_000,
      bytes: 104_857_600,
      encoding: 'utf8',
      bom: false,
      eol: 'lf',
      lossy: false,
      ...overrides,
    },
  }
}

/**
 * 假分片视图。`document.ts` 只碰它两个地方：`createShardView` 的返回值本身，
 * 和它的 `dispose`——所以替身只需要把 `dispose` 交出来给断言用
 */
function fakeView(): { view: ShardView; dispose: Mock } {
  const dispose = vi.fn()
  return { view: { dispose } as unknown as ShardView, dispose }
}

/** 让下一次 `openLarge` 装出一个新分片，并把它交回来 */
function nextShard(overrides: Partial<ShardOpen['header']> = {}) {
  const fake = fakeView()
  shardIpc.openLarge.mockResolvedValueOnce(shardOpen(overrides))
  shardFactory.createShardView.mockReturnValueOnce(fake.view)
  return fake
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
  shardIpc.openLarge.mockReset()
  shardIpc.closeLarge.mockReset()
  shardFactory.createShardView.mockReset()
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
    expect(doc.shard()).toBeNull()
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
    // ⚠️ 这里刻意**不用** `too_large`：那一条在 M2-H 之后不是失败，是「改走分片」，
    // 一个字都不该说（用例在下面「只读分片」那一组里）
    ipc.openFile.mockRejectedValue({ kind: 'io', reason: 'NotFound', message: '文件没了' })

    await doc.openAt('/huge.log')

    expect(doc.notice()?.level).toBe('error')
    expect(doc.notice()?.text).toContain('文件没了')
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

describe('reload（M2-D 全局替换之后对账）', () => {
  /**
   * 宿主上比 `harness()` 多两样东西：一个 setText 计数器，以及「正文一落地就同步回调
   * markChanged」。两样都不是装饰：
   *
   * ⚠️ 计数器不能省。正文没变时 `state.text` 前后是同一个字符串，于是「压根没动」与
   * 「动了、又写回同样的内容」在结果上不可区分。差别在**撤销栈**：setText 会重建 CM6
   * 的 state，重建一次历史就没了——而全局替换压根没碰到的那些标签，凭什么丢历史。
   *
   * ⚠️ eager 回调也不能省。真实宿主（CM6 的 onUpdate）就是这么调的，靠 `replacing`
   * 标志挡住；挡不住的话对账会把每一个被重读的标签都标脏，关窗时的「有未保存的改动」
   * 就会凭空弹出来，而用户明明什么都没改
   */
  function eagerHarness() {
    const state = { text: '', focuses: 0, pathChanges: 0, sets: 0 }
    let doc!: DocumentModel
    const host: DocumentHost = {
      getText: () => state.text,
      setText: (t) => {
        state.sets += 1
        state.text = t
        doc.markChanged()
      },
      focus: () => {
        state.focuses += 1
      },
      pathChanged: () => {
        state.pathChanges += 1
      },
    }
    doc = createDocumentModel(host)
    return { doc, state, host }
  }

  it('磁盘上变了：采纳新正文与格式，返回 true', async () => {
    const { doc, state } = eagerHarness()
    ipc.openFile.mockResolvedValueOnce(textFile())
    await doc.openAt('/a.txt')
    expect(state.sets).toBe(1)

    ipc.openFile.mockResolvedValueOnce(
      textFile({ text: '换过了', format: { encoding: 'utf8', bom: true, eol: 'crlf' }, lossy: true }),
    )
    await expect(doc.reload()).resolves.toBe(true)

    expect(state.text).toBe('换过了')
    expect(doc.format()).toEqual({ encoding: 'utf8', bom: true, eol: 'crlf' })
    expect(doc.lossy()).toBe(true)
    expect(doc.busy()).toBe(false)
    // 换正文不是用户的改动，eager 宿主回调了 markChanged 也得被 `replacing` 挡住
    expect(doc.dirty()).toBe(false)
  })

  it('⚠️ 正文一模一样时一次 setText 都不发，返回 false', async () => {
    const { doc, state } = eagerHarness()
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/a.txt')
    expect(state.sets).toBe(1)

    await expect(doc.reload()).resolves.toBe(false)

    // 全局替换没碰到的那些标签走的正是这条路；撤销栈就是这么保住的
    expect(state.sets).toBe(1)
    expect(state.text).toBe('正文')
    expect(doc.dirty()).toBe(false)
  })

  it('正文没变但行尾在盘上变过：正文一个字不动，格式照样对齐', async () => {
    const { doc, state } = eagerHarness()
    ipc.openFile.mockResolvedValueOnce(textFile())
    await doc.openAt('/a.txt')

    ipc.openFile.mockResolvedValueOnce(textFile({ format: { encoding: 'utf8', bom: false, eol: 'crlf' } }))
    await expect(doc.reload()).resolves.toBe(false)

    expect(state.sets).toBe(1)
    // 状态栏显示一个过时的行尾比显示过时的正文更难察觉：那个数字没人会去核对
    expect(doc.format()).toEqual({ encoding: 'utf8', bom: false, eol: 'crlf' })
    expect(doc.dirty()).toBe(false)
  })

  it('脏文档一律不碰：一次 IO 都不发，返回 false', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/a.txt')
    state.text = '改过了'
    doc.markChanged()

    await expect(doc.reload()).resolves.toBe(false)

    // 那份改动是磁盘上没有的唯一副本。而全局替换本来就把这个路径列进了 skip
    // （见 ReplaceRequest.skip），两边必须说法一致：一边跳过一边覆盖的话，
    // 用户看到的是「明明说跳过了，怎么内容还是变了」
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
    expect(state.text).toBe('改过了')
    expect(doc.dirty()).toBe(true)
    expect(doc.busy()).toBe(false)
    // 连提示都不给：对账是几十个标签批量跑的，每条都弹一句警告只会让人以为出了事。
    // 真正要说的那句在替换总账里（`ReplaceSummary.skippedOpen`）
    expect(doc.notice()).toBeNull()
  })

  it('未命名文档上是空操作：磁盘上没有它', async () => {
    const { doc, state } = harness()
    state.text = '从没落过盘的稿子'

    await expect(doc.reload()).resolves.toBe(false)

    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(state.text).toBe('从没落过盘的稿子')
    expect(doc.notice()).toBeNull()
  })

  it('用**当前**编码重读，不让后端重新探测', async () => {
    const { doc } = harness()
    ipc.openFile.mockResolvedValue(textFile({ text: '模', format: { encoding: 'gbk', bom: false, eol: 'lf' } }))
    await doc.openAt('/misdetected.txt')

    await doc.reload()

    // 第二个参数就是这一条的全部内容：漏了它后端收到 None，会再探测一次，
    // 于是「以 GBK 打开」那个用户刚刚做过的决定被悄悄扔掉
    expect(ipc.openFile).toHaveBeenLastCalledWith('/misdetected.txt', 'gbk')
  })

  it('既不抢焦点也不重装语言槽位', async () => {
    const { doc, state } = eagerHarness()
    ipc.openFile.mockResolvedValueOnce(textFile())
    await doc.openAt('/a.txt')
    expect(state.focuses).toBe(1)

    ipc.openFile.mockResolvedValueOnce(textFile({ text: '换过了' }))
    await doc.reload()

    // 对账是后台发生的：抢焦点的话用户正在打的字会跑到别的标签上去
    expect(state.focuses).toBe(1)
    // 路径没变 → 语言没变，报了宿主就白重装一次槽位
    expect(state.pathChanges).toBe(1)
  })

  it('读失败时报错，正文与格式都保持原样，返回 false', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValueOnce(textFile())
    await doc.openAt('/a.txt')
    ipc.openFile.mockRejectedValueOnce({ kind: 'io', reason: 'NotFound', message: '文件没了' })

    await expect(doc.reload()).resolves.toBe(false)

    expect(state.text).toBe('正文')
    expect(doc.format()).toEqual({ encoding: 'utf8', bom: false, eol: 'lf' })
    expect(doc.notice()?.level).toBe('error')
    expect(doc.notice()?.text).toContain('文件没了')
    expect(doc.busy()).toBe(false)
  })

  it('对账成功之后上一轮那条提示消失', async () => {
    const { doc } = harness()
    ipc.openFile.mockResolvedValueOnce(textFile())
    await doc.openAt('/a.txt')
    ipc.openFile.mockRejectedValueOnce({ kind: 'io', reason: 'Io', message: '外接盘掉线了' })
    await doc.reload()
    expect(doc.notice()?.level).toBe('error')

    ipc.openFile.mockResolvedValueOnce(textFile({ text: '回来了' }))
    await expect(doc.reload()).resolves.toBe(true)

    // 留着的话用户会一直看着一句已经不成立的报错，而它没有任何可操作的动作
    expect(doc.notice()).toBeNull()
  })
})

describe('只读分片（M2-H）', () => {
  /*
   * 这一组的全部要点是「换一条路」与「失败」必须分得开：`open_file` 撞 4 MiB 不是
   * 错误，是路由信号。判错方向的两种症状都很难查——当成失败的话用户看到一句红字，
   * 而那个文件明明打得开；当成成功的话文档会停在一个空 buffer 上，看起来像是文件是空的
   */
  it('open_file 撞 4 MiB 时改走 open_large，一个字都不说', async () => {
    const { doc, state } = harness()
    // 上一个文件留下的正文。🔴 分片落地时必须清掉：留着的话 `host.getText()`
    // 会把它当成这个大文件的内容，而分片模式下唯一读正文的地方就是它
    state.text = '上一个文件的正文'
    ipc.openFile.mockRejectedValue(TOO_LARGE_INLINE)
    const fake = nextShard({ totalLines: 900_000, bytes: 52_428_800, encoding: 'gbk', bom: true, eol: 'crlf' })

    await doc.openAt('/var/log/huge.log')

    expect(shardIpc.openLarge).toHaveBeenCalledWith('/var/log/huge.log')
    expect(shardFactory.createShardView).toHaveBeenCalledTimes(1)
    expect(doc.shard()).toBe(fake.view)
    expect(doc.notice()).toBeNull()
    expect(doc.path()).toBe('/var/log/huge.log')
    expect(doc.name()).toBe('huge.log')
    expect(state.text).toBe('')
    // 头部那个 encoding/eol 只为状态栏那两格（它们在分片模式下不渲染成 <select>）
    expect(doc.format()).toEqual({ encoding: 'gbk', bom: true, eol: 'crlf' })
    expect(doc.dirty()).toBe(false)
    expect(doc.busy()).toBe(false)
    expect(state.focuses).toBe(1)
    expect(state.pathChanges).toBe(1)
  })

  it('刻意不采纳 header.lossy：那条提示讲的是「原样保存会损坏它」，而分片压根不能保存', async () => {
    const { doc } = harness()
    ipc.openFile.mockRejectedValue(TOO_LARGE_INLINE)
    nextShard({ lossy: true })

    await doc.openAt('/h.log')

    expect(doc.lossy()).toBe(false)
    expect(doc.notice()).toBeNull()
  })

  it('open_large 也接不住时才报错，且不动当前文档', async () => {
    const { doc, state } = harness()
    state.text = '原内容'
    ipc.openFile.mockRejectedValue(TOO_LARGE_INLINE)
    shardIpc.openLarge.mockRejectedValue({ kind: 'unsupported_encoding', path: '/h.txt', encoding: 'utf16_le' })

    await doc.openAt('/h.txt')

    expect(doc.notice()?.level).toBe('error')
    expect(doc.notice()?.text).toContain('unsupported_encoding')
    expect(doc.shard()).toBeNull()
    expect(doc.path()).toBeNull()
    expect(state.text).toBe('原内容')
    expect(state.focuses).toBe(0)
    expect(doc.busy()).toBe(false)
  })

  /*
   * 「先拿到新句柄再关旧的」那一行的用例。反过来的顺序下，一次失败的 open_large
   * 会把好端端一个能看的分片拆掉，只留一个空 buffer 加一句红字
   */
  it('新分片打开失败时，旧的那个留着不动', async () => {
    const { doc } = harness()
    ipc.openFile.mockRejectedValue(TOO_LARGE_INLINE)
    const first = nextShard()
    await doc.openAt('/a.log')

    shardIpc.openLarge.mockRejectedValueOnce({ kind: 'too_large', bytes: 300_000_000, limit: 268_435_456 })
    await doc.openAt('/b.log')

    expect(doc.shard()).toBe(first.view)
    expect(first.dispose).not.toHaveBeenCalled()
    // 新视图压根没被造出来，所以也就没有第二个 fd 需要收
    expect(shardFactory.createShardView).toHaveBeenCalledTimes(1)
    expect(doc.notice()?.level).toBe('error')
  })

  it('从分片切回内联：旧 fd 还回去，正文换掉', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockRejectedValueOnce(TOO_LARGE_INLINE)
    const fake = nextShard()
    await doc.openAt('/huge.log')

    ipc.openFile.mockResolvedValueOnce(textFile({ text: '小文件的正文' }))
    await doc.openAt('/small.txt')

    // fd 泄漏是这条路上唯一「不报错但资源没了」的失败方式（见 ipc/shard.ts 的 closeLarge）
    expect(fake.dispose).toHaveBeenCalledTimes(1)
    expect(doc.shard()).toBeNull()
    expect(state.text).toBe('小文件的正文')
    expect(doc.path()).toBe('/small.txt')
    expect(doc.dirty()).toBe(false)
    expect(doc.notice()).toBeNull()
  })

  it('分片换分片：上一个照样收掉', async () => {
    const { doc } = harness()
    ipc.openFile.mockRejectedValue(TOO_LARGE_INLINE)
    const first = nextShard()
    await doc.openAt('/a.log')
    const second = nextShard()

    await doc.openAt('/b.log')

    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(doc.shard()).toBe(second.view)
    expect(doc.path()).toBe('/b.log')
  })

  /*
   * 🔴 `saveAs` 这一条比 `save` 要紧：它不问后端、直接拿 `host.getText()` 去写盘，
   * 而分片模式下那个 buffer 是**空的**。没有这道守卫的话，用户在一个 100 MB 的日志上
   * 按一次 ⌘⇧S 就会在磁盘上留下一个 0 字节的同名文件
   */
  it('save 与 saveAs 一律拒绝：一次写盘都不发，也不弹对话框', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockRejectedValue(TOO_LARGE_INLINE)
    nextShard()
    await doc.openAt('/huge.log')

    await doc.save()

    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(dialog.save).not.toHaveBeenCalled()
    expect(doc.notice()?.level).toBe('warning')
    expect(doc.notice()?.text).toContain('不能保存')
    expect(state.text).toBe('')

    await doc.saveAs()

    expect(dialog.save).not.toHaveBeenCalled()
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(doc.notice()?.text).toContain('不能另存为')
    // 永远不脏 → 关闭确认压根不会为它弹一次，也就不会出现「问你要不要保存一个
    // 保存不了的文件」那个死循环
    expect(doc.dirty()).toBe(false)
  })

  it('releaseShard 幂等：连调两次只 dispose 一次', async () => {
    const { doc } = harness()
    ipc.openFile.mockRejectedValue(TOO_LARGE_INLINE)
    const fake = nextShard()
    await doc.openAt('/huge.log')

    doc.releaseShard()
    doc.releaseShard()

    expect(fake.dispose).toHaveBeenCalledTimes(1)
    expect(doc.shard()).toBeNull()
    expect(doc.notice()).toBeNull()
  })

  it('内联文档上 releaseShard 是空操作', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValue(textFile())
    await doc.openAt('/a.txt')

    doc.releaseShard()

    expect(doc.shard()).toBeNull()
    expect(state.text).toBe('正文')
    expect(doc.path()).toBe('/a.txt')
    expect(shardIpc.closeLarge).not.toHaveBeenCalled()
  })

  it('reload 在分片上是整个重开：新视图换上、旧的收掉、一律返回 true', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockRejectedValueOnce(TOO_LARGE_INLINE)
    const first = nextShard()
    await doc.openAt('/huge.log')

    const second = nextShard()
    await expect(doc.reload()).resolves.toBe(true)

    expect(shardIpc.openLarge).toHaveBeenCalledTimes(2)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(doc.shard()).toBe(second.view)
    expect(doc.notice()).toBeNull()
    expect(doc.busy()).toBe(false)
    // 这条路上压根不该碰内联那一套：正文、语言槽位、焦点都不动
    expect(ipc.openFile).toHaveBeenCalledTimes(1) // 只有最初那次撞上限
    expect(state.text).toBe('')
    expect(state.pathChanges).toBe(1)
    expect(state.focuses).toBe(1)
  })

  it('重开失败时旧视图留着，返回 false', async () => {
    const { doc } = harness()
    ipc.openFile.mockRejectedValueOnce(TOO_LARGE_INLINE)
    const first = nextShard()
    await doc.openAt('/huge.log')

    shardIpc.openLarge.mockRejectedValueOnce({ kind: 'io', reason: 'NotFound', message: '文件没了' })
    await expect(doc.reload()).resolves.toBe(false)

    // 旧视图虽然是打开那一刻的内容，但至少还能看，比一个空面板加一句红字有用
    expect(doc.shard()).toBe(first.view)
    expect(first.dispose).not.toHaveBeenCalled()
    expect(doc.notice()?.level).toBe('error')
    expect(doc.busy()).toBe(false)
  })

  /*
   * 同一个「正在被追加的日志」，从另一个方向来：打开时还不到 4 MiB，
   * 在 Vela 开着的时候长过去了。少了这条分支的话 reload 会以一句红字收场，
   * 而这个文件明明有办法打开
   */
  it('reload 撞上「文件长过了 4 MiB」：改走分片，返回 true', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValueOnce(textFile())
    await doc.openAt('/var/log/app.log')
    expect(doc.shard()).toBeNull()

    ipc.openFile.mockRejectedValueOnce(TOO_LARGE_INLINE)
    const fake = nextShard()
    await expect(doc.reload()).resolves.toBe(true)

    expect(doc.shard()).toBe(fake.view)
    expect(state.text).toBe('')
    expect(doc.path()).toBe('/var/log/app.log')
    expect(doc.notice()).toBeNull()
    expect(doc.busy()).toBe(false)
  })

  it('长过 4 MiB 又撞了分片自己的上限：报错，而内联那份正文留着', async () => {
    const { doc, state } = harness()
    ipc.openFile.mockResolvedValueOnce(textFile())
    await doc.openAt('/var/log/app.log')

    ipc.openFile.mockRejectedValueOnce(TOO_LARGE_INLINE)
    shardIpc.openLarge.mockRejectedValueOnce({ kind: 'too_large', bytes: 300_000_000, limit: 268_435_456 })
    await expect(doc.reload()).resolves.toBe(false)

    expect(doc.shard()).toBeNull()
    expect(state.text).toBe('正文')
    expect(doc.notice()?.level).toBe('error')
    expect(doc.busy()).toBe(false)
  })
})
