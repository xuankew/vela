// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * `fileWatch` 的单测：清单什么时候送、事件怎么分流、冲突队列怎么排怎么答。
 *
 * **假的只有 IPC**（`open_file` / `save_file` / 原生对话框 / `set_watched` /
 * `listenFileChanged`）：jsdom 里没有 Tauri 运行时，而「外部改了一个文件」这件事
 * 本来也只能靠递一条假事件进来模拟。
 *
 * workspace 与文档模型是**真的**。这一层要断言的正是「干净标签被静默重载了而脏标签
 * 没有被碰」——那两条都发生在真文档模型里（`reload` 的脏检查、`discardChanges` 的
 * 清标记、`saveAs` 换路径之后清单跟着变）。拿替身文档的话，被测的整条链路都是自己画的。
 *
 * ⚠️ 只读分片那几条也走**真实那条路**（`open_file` 撞 `too_large` → `open_large`），
 * 而不是直接塞一个 `shard()` signal：要钉的正是「分片标签不进清单」这条判断读的是
 * `doc.shard()`，而它只有在真开出一个分片之后才非 null。`createShardView` 本身是替身
 * （🔴 它内部有 `createMemo`，替身之外还省不掉「dispose 被调了几次」这类断言的干扰），
 * 而 `ipc/shard` 的两个函数也是替身——jsdom 里没有 Tauri 运行时。
 */

const { ipc, dialog, watch, shardIpc, shardFactory } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
  },
  dialog: { open: vi.fn(), save: vi.fn() },
  watch: { setWatched: vi.fn(), listenFileChanged: vi.fn() },
  shardIpc: { openLarge: vi.fn(), closeLarge: vi.fn() },
  shardFactory: { createShardView: vi.fn() },
}))

vi.mock('../ipc/fs', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
// 只盖掉两个函数，`FILE_CHANGED_EVENT` 之类的常量用真的：那一层有 `watch.test.ts` 管
vi.mock('../ipc/watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/watch')>()),
  ...watch,
}))
vi.mock('../ipc/shard', () => shardIpc)
vi.mock('./shardView', () => shardFactory)

import { createRoot } from 'solid-js'
import type { TextFile, WriteReport } from '../ipc/fs'
import type { ShardHeader } from '../ipc/shard'
import type { FileChangeKind, FileChangedPayload, WatchStats } from '../ipc/watch'
import { createFileWatch, describeWatchStats, type FileWatch } from './fileWatch'
// `ShardView` 只是个类型，`vi.mock('./shardView')` 盖的是运行时那一半，两者不打架
import type { ShardView } from './shardView'
import { tabText } from './tab'
import { createWorkspace, type DiscardPrompt, type Workspace } from './workspace'

function textFile(overrides: Partial<TextFile> = {}): TextFile {
  return { text: '旧正文', format: { encoding: 'utf8', bom: false, eol: 'lf' }, lossy: false, bytes: 9, ...overrides }
}

const SHARD_HEADER: ShardHeader = {
  totalLines: 1_200_000,
  bytes: 104_857_600,
  encoding: 'utf8',
  bom: false,
  eol: 'lf',
  lossy: false,
}

/** 100 MiB 撞的是内联那条 4 MiB 的线（`fs/read.rs` 的 `MAX_INLINE_BYTES`） */
const TOO_LARGE = { kind: 'too_large' as const, bytes: SHARD_HEADER.bytes, limit: 4_194_304 }

const OK_WRITE: WriteReport = { bytesWritten: 9, unmappable: false }
const OK_STATS: WatchStats = { dirs: 1, files: 1, failed: 0, skipped: 0, truncated: false }

/** 让 Solid 的 effect 队列与在飞的 promise 都落地 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 待回收的 Solid 作用域。`createFileWatch` 里有 memo 与 effect，必须建在 root 里 */
const disposers: (() => void)[] = []

/** 已经调用过的东西的顺序，用来钉「先挂监听再送清单」 */
let calls: string[] = []
/** 假的事件发射口。`listenFileChanged` 挂上之后就有值 */
let emit: ((change: FileChangedPayload) => void) | null = null
let unlistens = 0

interface Harness {
  ws: Workspace
  fw: FileWatch
  warnings: string[]
}

function harness(promptDiscard: DiscardPrompt = async () => 'cancel'): Harness {
  const ws = createWorkspace({ promptDiscard })
  const warnings: string[] = []
  const fw = createRoot<FileWatch>((teardown) => {
    disposers.push(teardown)
    return createFileWatch({ workspace: ws, onWarn: (text) => warnings.push(text) })
  })
  return { ws, fw, warnings }
}

/** 递一条「磁盘上动了」的事件。默认是「改了」 */
function fire(path: string, kind: FileChangeKind = 'changed') {
  if (emit === null) throw new Error('监听还没挂上')
  emit({ path, kind })
}

/** 送到 Rust 侧的每一份清单，按调用顺序 */
function sent(): string[][] {
  return watch.setWatched.mock.calls.map((c: unknown[]) => c[0] as string[])
}

/** 最后送出去的那一份 */
function lastSent(): string[] {
  const list = sent()
  return list[list.length - 1]!
}

/** 装上分片那一半的替身（`open_large` + `createShardView`），并把替身视图交回来 */
function stubShard(): { view: ShardView; dispose: Mock } {
  const dispose = vi.fn()
  const view = { dispose } as unknown as ShardView
  shardIpc.openLarge.mockResolvedValue({ handle: 3, header: SHARD_HEADER })
  shardFactory.createShardView.mockReturnValue(view)
  return { view, dispose }
}

/**
 * 让**指定路径**在 `openAt` 里走真实那条分片路（`open_file` 撞 `too_large` →
 * `open_large`），其余路径照旧走内联——于是同一个用例里可以既有分片标签又有普通标签。
 */
function shardPath(path: string): { view: ShardView; dispose: Mock } {
  const shard = stubShard()
  ipc.openFile.mockImplementation(async (target: string) => {
    // 抛的**就是**那个普通对象，不是 Error 实例：Tauri 的 invoke 在 Rust command
    // 返回 Err 时拒绝的正是这个序列化结果，`document.ts` 也靠 `kind` 字面量认它
    // （同一份理由在 workspace.test.ts 里写过一遍）
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (target === path) throw { ...TOO_LARGE }
    return textFile()
  })
  return shard
}

beforeEach(() => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  watch.setWatched.mockReset()
  watch.listenFileChanged.mockReset()
  shardIpc.openLarge.mockReset()
  shardIpc.closeLarge.mockReset()
  shardFactory.createShardView.mockReset()
  calls = []
  emit = null
  unlistens = 0

  ipc.openFile.mockResolvedValue(textFile())
  ipc.saveFile.mockResolvedValue(OK_WRITE)
  watch.setWatched.mockImplementation(async (paths: readonly string[]) => {
    calls.push(`setWatched(${paths.length})`)
    return OK_STATS
  })
  watch.listenFileChanged.mockImplementation(async (onChange: (change: FileChangedPayload) => void) => {
    calls.push('listen')
    emit = onChange
    return () => {
      unlistens += 1
      emit = null
    }
  })
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

describe('清单同步：把打开着的文件整份递给 set_watched', () => {
  it('启动时就把已经打开的那个文件送出去', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')

    await h.fw.start()
    await flush()

    expect(sent()).toEqual([['/repo/a.txt']])
    expect(h.warnings).toEqual([])
  })

  it('⚠️ 先挂监听，再送清单：反过来的话中间那条事件永久丢失', async () => {
    const h = harness()

    await h.fw.start()
    await flush()

    expect(calls[0]).toBe('listen')
    expect(calls[1]).toBe('setWatched(0)')
  })

  it('没有路径的标签不进去：未命名文档在磁盘上没有对应物', async () => {
    const h = harness()

    await h.fw.start()
    await flush()

    expect(lastSent()).toEqual([])
  })

  it('再开一个文件就送一份**全量**清单，不是只送新增的那一个', async () => {
    const h = harness()
    await h.ws.openAt('/repo/b.txt')
    await h.fw.start()
    await flush()
    await h.ws.openAt('/repo/a.txt')
    await flush()

    // 排过序的：Rust 侧自己会排，而这边排序是为了让「清单没变」能被认出来
    expect(lastSent()).toEqual(['/repo/a.txt', '/repo/b.txt'])
  })

  it('关掉标签也重送，于是那个文件不再被盯着', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.ws.openAt('/repo/b.txt')
    await h.fw.start()
    await flush()

    const b = h.ws.tabs().find((t) => t.doc.path() === '/repo/b.txt')!
    await h.ws.closeTab(b.id)
    await flush()

    expect(lastSent()).toEqual(['/repo/a.txt'])
  })

  it('另存为之后按**新**路径重送', async () => {
    const h = harness()
    dialog.save.mockResolvedValue('/repo/c.txt')
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()

    await h.ws.saveAs()
    await flush()

    expect(lastSent()).toEqual(['/repo/c.txt'])
  })

  it('标脏之后那个文件照样在清单里：脏文件才是最需要被盯着的', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()

    h.ws.activeTab().doc.markChanged()
    await flush()

    // 把脏文件从清单里摘掉看着像是一种优化（「反正我也不会自动覆盖它」），其实正好反了：
    // 那份未保存的改动是磁盘上没有的唯一副本，而「盘上被别人改了」这件事只有盯着才知道，
    // 不知道就没法去问用户——`overwrite` 与 `saveAs` 两条出路都建立在这条事件上
    expect(lastSent()).toEqual(['/repo/a.txt'])
    expect(sent()).toHaveLength(1)
  })

  it('拖拽重排标签不重送：清单排序之后一模一样', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.ws.openAt('/repo/b.txt')
    await h.fw.start()
    await flush()

    const [first, second] = h.ws.tabs()
    h.ws.reorder(first!.id, second!.id)
    await flush()

    expect(sent()).toHaveLength(1)
  })

  it('同一个路径开在两个标签里也只送一条（Rust 侧的过滤器本来就按 canonical 挂）', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    // `openAt` 会激活已有同路径的标签，所以这里直接走文档模型开第二次
    await h.ws.newTab().doc.openAt('/repo/a.txt')
    await flush()

    expect(lastSent()).toEqual(['/repo/a.txt'])
  })

  it('没 start 就一个字节都不送', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await flush()

    expect(watch.setWatched).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 只读分片（M2-H）整个不参与这一层：**不进清单**，事件到了也**扔掉**。
 *
 * 不进清单那一半的理由写在 `fileWatch.ts` 的 `currentPaths` 里，一句话是「重开一次 =
 * 整份文件重扫一遍，而大文件最常见的改动方式恰恰是追加」。这一组钉的是**行为**，
 * 尤其是那两件很容易在重构里被「顺手统一」掉的事：
 *
 * - 「分片标签也算打开着的文件」——那会让追加一次日志就重扫一次 100 MiB
 * - 「事件既然来了就处理」——`onEvent` 那半条守卫看着像多余（清单里没有它，
 *   哪来的事件？），去掉它一切测试照样绿，而真实世界里那条窗口天天在开
 */
describe('只读分片：不进清单，事件也不处理', () => {
  it('只开着一个分片时清单是空的——不是「打开失败所以没路径」', async () => {
    const h = harness()
    const shard = shardPath('/repo/huge.log')
    await h.ws.openAt('/repo/huge.log')
    expect(h.ws.activeTab().doc.shard()).toBe(shard.view)

    await h.fw.start()
    await flush()

    expect(lastSent()).toEqual([])
  })

  it('混着开时只送内联那一条：分片标签不把它的路径带进去', async () => {
    const h = harness()
    shardPath('/repo/huge.log')
    await h.ws.openAt('/repo/huge.log')
    await h.ws.openAt('/repo/a.txt')

    await h.fw.start()
    await flush()

    expect(lastSent()).toEqual(['/repo/a.txt'])
  })

  it('内联长成分片（`reload` 撞上 too_large）→ 清单跟着少一条', async () => {
    const h = harness()
    await h.ws.openAt('/repo/grow.log')
    await h.fw.start()
    await flush()
    expect(lastSent()).toEqual(['/repo/grow.log'])

    // 文件在 Vela 开着的时候长过了 4 MiB：`reload` 自己改走分片
    stubShard()
    ipc.openFile.mockRejectedValueOnce({ ...TOO_LARGE })
    expect(await h.ws.activeTab().doc.reload()).toBe(true)
    await flush()

    expect(h.ws.activeTab().doc.shard()).not.toBeNull()
    // ⚠️ 空清单是真的送出去了，不是「没变化所以没送」：`sameList` 逐位比，
    // 少了一条就是不一样。不送的话 Rust 侧会一直盯着这个已经变成分片的文件
    expect(lastSent()).toEqual([])
  })

  it('⛔ 分片路径的事件：既不静默重载，也不排队问', async () => {
    const h = harness()
    shardPath('/repo/huge.log')
    await h.ws.openAt('/repo/huge.log')
    await h.fw.start()
    await flush()
    expect(lastSent()).toEqual([])

    // 清单里没有它，事件从哪来？两个真实来源：一是上面那条「内联长成分片」之后、
    // 摘订阅那次 `set_watched` 还在 `tail` 上排队时到达的事件；二是 Rust 侧
    // 「订目录 → 按 canonical 过滤」与前端清单之间本来就有的那段窗口。
    // 直接 `emit` 就是在模拟那个窗口——它不是造一个不可能的输入，而是把一段
    // 没法在单测里等出来的时序压缩成一行
    fire('/repo/huge.log')
    fire('/repo/huge.log', 'removed')
    await flush()

    expect(h.fw.current()).toBeNull()
    expect(h.fw.pending()).toBe(0)
    // 没重开：`reopenShard` 会再调一次 `open_large`，而那是整份文件重扫一遍行索引
    expect(shardIpc.openLarge).toHaveBeenCalledTimes(1)
    // 也没去读内联那条路（`reload` 的第一步是 `open_file`）
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
  })

  it('关掉分片标签不动清单：它本来就不在里面', async () => {
    const h = harness()
    const shard = shardPath('/repo/huge.log')
    await h.ws.openAt('/repo/huge.log')
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    expect(lastSent()).toEqual(['/repo/a.txt'])

    const huge = h.ws.tabs().find((t) => t.doc.path() === '/repo/huge.log')!
    await h.ws.closeTab(huge.id)
    await flush()

    // fd 是 workspace 收的（那半边在 `workspace.test.ts` 里钉过），这里只看清单没被惊动
    expect(shard.dispose).toHaveBeenCalledTimes(1)
    expect(lastSent()).toEqual(['/repo/a.txt'])
    // 🔴 只送过一份。`dropTab` 里「先摘标签、再还 fd」那个顺序是这条断言的唯一保障：
    // 反过来的话 `releaseShard()` 会把 `shard()` 置回 null 而标签还在表里，
    // 于是清单会先多出这条分片路径再少掉它——两次白跑的 `set_watched`，
    // 中间那一段还真在 Rust 侧订着这个 100 MB 文件的目录
    expect(sent()).toHaveLength(1)
  })
})

describe('总账不干净时要让用户看见', () => {
  it('三格全干净就一句话都不说', () => {
    expect(describeWatchStats(OK_STATS)).toBeNull()
  })

  it('有目录没订上：说个数，并说清后果是「不会提醒」', () => {
    const note = describeWatchStats({ ...OK_STATS, failed: 2 })!
    expect(note).toMatch(/2 个目录没订上/)
    expect(note).toMatch(/不会提醒/)
  })

  it('有路径被丢掉与撞了上限各说一句，三样一起来就都说', () => {
    expect(describeWatchStats({ ...OK_STATS, skipped: 1 })!).toMatch(/不是绝对路径/)
    expect(describeWatchStats({ ...OK_STATS, truncated: true })!).toMatch(/上限/)
    const all = describeWatchStats({ ...OK_STATS, failed: 1, skipped: 2, truncated: true })!
    expect(all).toMatch(/1 个目录没订上/)
    expect(all).toMatch(/2 条路径/)
    expect(all).toMatch(/上限/)
  })

  it('那句话经 onWarn 出去，而不是被咽下去', async () => {
    const h = harness()
    watch.setWatched.mockResolvedValue({ ...OK_STATS, failed: 1 })
    await h.ws.openAt('/repo/a.txt')

    await h.fw.start()
    await flush()

    expect(h.warnings.join('\n')).toMatch(/文件监听不完整：有 1 个目录没订上/)
  })

  it('送失败（debouncer 起不来）说人话，而且下一次标签变化会重试', async () => {
    const h = harness()
    watch.setWatched.mockRejectedValueOnce({ kind: 'io', reason: 'Notify', message: '起不了文件监听：炸了' })
    await h.fw.start()
    await flush()
    expect(h.warnings.join('\n')).toMatch(/文件监听没能同步：起不了文件监听：炸了/)

    await h.ws.openAt('/repo/a.txt')
    await flush()

    // 失败那一次没有记下「已经送过了」，所以这一趟真的又送了一次
    expect(sent()).toHaveLength(2)
    expect(lastSent()).toEqual(['/repo/a.txt'])
  })

  it('监听压根挂不上就整个不启用：订了目录却收不到事件比不订更糟', async () => {
    const h = harness()
    watch.listenFileChanged.mockRejectedValueOnce({ kind: 'io', reason: 'Notify', message: '炸了' })
    await h.ws.openAt('/repo/a.txt')

    const dispose = await h.fw.start()
    await flush()
    dispose()
    await flush()

    expect(h.warnings.join('\n')).toMatch(/文件监听没能挂上：炸了/)
    expect(watch.setWatched).not.toHaveBeenCalled()
  })
})

describe('事件分流：干净的静默重载，其余排队问', () => {
  it('干净标签收到「改了」→ 直接对齐磁盘，一个字都不问', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    ipc.openFile.mockResolvedValueOnce(textFile({ text: '新正文' }))

    fire('/repo/a.txt')
    await flush()

    const tab = h.ws.activeTab()
    expect(tabText(tab)).toBe('新正文')
    expect(tab.doc.dirty()).toBe(false)
    expect(h.fw.current()).toBeNull()
    expect(h.fw.pending()).toBe(0)
  })

  it('脏标签收到「改了」→ 排队问，正文一个字节都不动', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    const tab = h.ws.activeTab()
    tab.doc.markChanged()
    ipc.openFile.mockResolvedValueOnce(textFile({ text: '新正文' }))

    fire('/repo/a.txt')
    await flush()

    expect(h.fw.current()).toEqual({ tabId: tab.id, kind: 'changed', name: 'a.txt', path: '/repo/a.txt' })
    expect(tabText(tab)).toBe('旧正文')
    // 没排到队里去读盘：那份未保存的改动是磁盘上没有的唯一副本
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
  })

  it('「删了」对干净标签也一样要问：Vela 手里那份是仅存的副本', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()

    fire('/repo/a.txt', 'removed')
    await flush()

    expect(h.fw.current()).toMatchObject({ kind: 'removed', path: '/repo/a.txt' })
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
  })

  it('不属于任何标签的路径：什么都不发生', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()

    fire('/repo/别的.txt')
    fire('/repo/别的.txt', 'removed')
    await flush()

    expect(h.fw.current()).toBeNull()
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
  })

  it('同一个标签的同一种冲突排两次只留一条：用户没答复的那几分钟里文件可能被改很多次', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    h.ws.activeTab().doc.markChanged()

    fire('/repo/a.txt')
    fire('/repo/a.txt')
    fire('/repo/a.txt', 'removed')
    await flush()

    // 「改了」一条 + 「删了」一条：它们是两种不同的处境，各问一次
    expect(h.fw.pending()).toBe(1)
  })

  it('一次只弹一个，剩下的排在后面', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.ws.openAt('/repo/b.txt')
    await h.fw.start()
    await flush()
    for (const tab of h.ws.tabs()) tab.doc.markChanged()

    fire('/repo/a.txt')
    fire('/repo/b.txt')
    await flush()

    expect(h.fw.current()!.name).toBe('a.txt')
    expect(h.fw.pending()).toBe(1)

    await h.fw.resolve('keep')
    await flush()

    expect(h.fw.current()!.name).toBe('b.txt')
    expect(h.fw.pending()).toBe(0)
  })

  it('⛔ Vela 自己保存之后收到的那条事件不弹对话框，而且连撤销栈都不碰', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    const tab = h.ws.activeTab()
    tab.doc.markChanged()
    await h.ws.save()
    expect(tab.doc.dirty()).toBe(false)
    // 原子写盘（临时文件 + rename）在 FSEvents 上是一条真事件，躲不掉。
    // 读回来的是同样的字节，而 `reload` 里那句 `if (changed)` 让 state 原地不动
    ipc.openFile.mockResolvedValueOnce(textFile())
    const before = tab.snapshot.state

    fire('/repo/a.txt')
    await flush()

    // 真的去读了一次盘（不是「压根没触发」而蒙对的），而读回来的字节一模一样，
    // 于是 `reload` 里那句 `if (changed)` 让它连 state 都没重建
    expect(ipc.openFile).toHaveBeenCalledTimes(2)
    expect(h.fw.current()).toBeNull()
    expect(tab.snapshot.state).toBe(before)
  })

  it('保存失败时脏标记还在，那一次弹窗是该弹的：盘上真的变了', async () => {
    const h = harness()
    ipc.saveFile.mockRejectedValueOnce({ kind: 'io', message: '磁盘满了' })
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    const tab = h.ws.activeTab()
    tab.doc.markChanged()
    await h.ws.save()
    expect(tab.doc.dirty()).toBe(true)
    ipc.openFile.mockResolvedValueOnce(textFile({ text: '新正文' }))

    fire('/repo/a.txt')
    await flush()

    expect(h.fw.current()).toMatchObject({ kind: 'changed' })
    expect(tabText(tab)).toBe('旧正文')
  })
})

describe('答复：四个动作', () => {
  it('用磁盘上的覆盖 = 先扔改动再读（`reload` 对脏文档一律什么都不做）', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    const tab = h.ws.activeTab()
    tab.doc.markChanged()
    ipc.openFile.mockResolvedValueOnce(textFile({ text: '新正文' }))
    fire('/repo/a.txt')
    await flush()

    await h.fw.resolve('overwrite')
    await flush()

    expect(tabText(tab)).toBe('新正文')
    expect(tab.doc.dirty()).toBe(false)
    expect(h.fw.current()).toBeNull()
  })

  it('保留我的改动 = 什么都不做，正文与脏标记都原样', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    const tab = h.ws.activeTab()
    tab.doc.markChanged()
    fire('/repo/a.txt')
    await flush()

    await h.fw.resolve('keep')
    await flush()

    expect(tabText(tab)).toBe('旧正文')
    expect(tab.doc.dirty()).toBe(true)
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
  })

  it('另存为 = 写到一个新路径，标签跟着搬过去，清单也重送', async () => {
    const h = harness()
    dialog.save.mockResolvedValue('/repo/c.txt')
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    const tab = h.ws.activeTab()
    tab.doc.markChanged()
    fire('/repo/a.txt', 'removed')
    await flush()

    await h.fw.resolve('saveAs')
    await flush()

    expect(ipc.saveFile.mock.calls[0]![0]).toBe('/repo/c.txt')
    expect(tab.doc.path()).toBe('/repo/c.txt')
    expect(tab.doc.dirty()).toBe(false)
    expect(lastSent()).toEqual(['/repo/c.txt'])
  })

  it('关闭标签走 workspace 那条路，于是脏标签会**再问一次**「保存 / 不保存 / 取消」', async () => {
    const asked: string[][] = []
    const h = harness(async (names) => {
      asked.push(names)
      return 'discard'
    })
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    const tab = h.ws.activeTab()
    tab.doc.markChanged()
    fire('/repo/a.txt', 'removed')
    await flush()

    await h.fw.resolve('closeTab')
    await flush()

    // ⚠️ 这一条钉的是「不在这里自己 discardChanges」：他点的是「关闭标签」，
    // 不是「丢掉改动」，而那次追问是唯一给「保存」留出路的地方
    expect(asked).toEqual([['a.txt']])
    expect(h.ws.tabs().some((t) => t.id === tab.id)).toBe(false)
    expect(lastSent()).toEqual([])
  })

  it('那次追问答「取消」时标签留着，而冲突已经出队（对话框不会关不掉）', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    const tab = h.ws.activeTab()
    tab.doc.markChanged()
    fire('/repo/a.txt', 'removed')
    await flush()

    await h.fw.resolve('closeTab')
    await flush()

    expect(h.ws.tabs().some((t) => t.id === tab.id)).toBe(true)
    expect(h.fw.current()).toBeNull()
  })

  it('空队列上答复什么都不做：连点两下不会误伤下一个', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()

    await h.fw.resolve('overwrite')
    await h.fw.resolve('closeTab')
    await flush()

    expect(h.ws.tabs()).toHaveLength(1)
    expect(ipc.openFile).toHaveBeenCalledTimes(1)
  })

  it('等答复的期间用户自己把标签关了，那一条自动消失', async () => {
    const h = harness(async () => 'discard')
    await h.ws.openAt('/repo/a.txt')
    await h.ws.openAt('/repo/b.txt')
    await h.fw.start()
    await flush()
    for (const tab of h.ws.tabs()) tab.doc.markChanged()
    fire('/repo/a.txt')
    fire('/repo/b.txt')
    await flush()
    expect(h.fw.current()!.name).toBe('a.txt')

    const a = h.ws.tabs().find((t) => t.doc.path() === '/repo/a.txt')!
    await h.ws.closeTab(a.id)
    await flush()

    // 死条目不会挡在队首，也不会被算进「还有几个」
    expect(h.fw.current()!.name).toBe('b.txt')
    expect(h.fw.pending()).toBe(0)
  })

  it('答复期间抛出来的是「没保存成」，不是一个没人接的 rejection', async () => {
    const h = harness()
    dialog.save.mockRejectedValue(new Error('对话框炸了'))
    await h.ws.openAt('/repo/a.txt')
    await h.fw.start()
    await flush()
    h.ws.activeTab().doc.markChanged()
    fire('/repo/a.txt')
    await flush()

    await h.fw.resolve('saveAs')
    await flush()

    expect(h.warnings.join('\n')).toMatch(/没能处理这个文件冲突：对话框炸了/)
    expect(h.fw.current()).toBeNull()
  })
})

describe('注销', () => {
  it('摘掉监听，并把监听整个关掉（空清单，不是「什么都不改」）', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    const dispose = await h.fw.start()
    await flush()

    dispose()
    await flush()

    expect(unlistens).toBe(1)
    expect(lastSent()).toEqual([])
  })

  it('「关掉」必然排在最后一次「订上」之后', async () => {
    const h = harness()
    await h.ws.openAt('/repo/a.txt')
    const dispose = await h.fw.start()
    await flush()
    // 关窗口那一下会同时关掉一堆标签：不排队的话「订上」可能落在「关掉」之后，
    // 而进程还活着（关窗口不等于退出），Rust 侧就留下一堆没人管的订阅
    await h.ws.openAt('/repo/b.txt')
    dispose()
    await flush()

    expect(calls.filter((c) => c.startsWith('setWatched'))).toEqual(['setWatched(1)', 'setWatched(2)', 'setWatched(0)'])
  })

  it('注销之后标签再变也不会把监听重新订上', async () => {
    const h = harness()
    await h.fw.stop()
    await flush()
    const count = sent().length

    await h.ws.openAt('/repo/a.txt')
    await flush()

    expect(sent()).toHaveLength(count)
  })

  it('stop 可以重复调，第二次不会再摘一遍监听', async () => {
    const h = harness()
    await h.fw.start()
    await flush()

    await h.fw.stop()
    await h.fw.stop()
    await flush()

    expect(unlistens).toBe(1)
  })
})
