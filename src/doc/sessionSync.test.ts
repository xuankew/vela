// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `sessionSync` 的单测：什么时候读、什么时候写、写砸了说什么。
 *
 * **假的是 IPC 与定时器**：jsdom 里没有 Tauri 运行时；而 `setInterval` 用真的话，
 * 每条用例都得等 5 秒，或者靠 sleep 猜——猜短了用例就是空跑。
 *
 * workspace 与编辑器是**真的**。这一层的全部价值就在于它读写的是真现场：拿替身
 * workspace 的话，「敲了字之后存档里到底有没有那个字」这条最关键的断言就成了自己
 * 跟自己玩。项目树同理（M2-B-4）：要测的正是「摊开一层会不会触发一次写」，
 * 拿替身树等于把被测的那条链路自己先短路掉。
 */

const { session, ipc, dialog, project } = vi.hoisted(() => ({
  session: { loadSession: vi.fn(), saveSession: vi.fn() },
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
  },
  dialog: { open: vi.fn(), save: vi.fn() },
  project: { listDir: vi.fn(), describeTreeError: (err: unknown) => `模拟树错误：${JSON.stringify(err)}` },
}))

// 只盖掉两个 command。`describeSessionError` 用真的：提示文案本身就是要断言的东西
vi.mock('../ipc/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/session')>()),
  ...session,
}))
vi.mock('../ipc/fs', () => ipc)
vi.mock('../ipc/project', () => project)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)

import type { EditorState } from '@codemirror/state'
import { createRoot } from 'solid-js'
import { EditorController } from '../editor/controller'
import type { TextFile, WriteReport } from '../ipc/fs'
import type { DirEntry } from '../ipc/project'
import {
  SESSION_VERSION,
  describeSessionError,
  type Session,
  type SessionProject,
  type SessionReport,
  type SessionTab,
} from '../ipc/session'
import { createProjectTree, type ProjectTree } from '../project/store'
import { rowKey } from '../project/tree'
import { createSessionSync, SESSION_SYNC_INTERVAL_MS, type Scheduler, type SessionSync } from './sessionSync'
import { createWorkspace, type Workspace } from './workspace'

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
const OK_REPORT: SessionReport = { bytesWritten: 120, droppedDrafts: 0 }

function sessionTab(overrides: Partial<SessionTab> = {}): SessionTab {
  return {
    path: '/a.txt',
    format: { encoding: 'utf8', bom: false, eol: 'lf' },
    dirty: false,
    lossy: false,
    draft: null,
    selection: [[0, 0]],
    main: 0,
    scrollTop: 0,
    scrollLeft: 0,
    ...overrides,
  }
}

function sessionOf(tabs: SessionTab[], overrides: Partial<Session> = {}): Session {
  // `project: null` 与 `recent: []` 属于基底：`Partial<Session>` 里它们是可选的，
  // 不写死一个值，展开之后类型就成了 `| undefined`，而线上的 `Session.project`
  // 只能是值或 null、`Session.recent` 只能是数组
  return {
    version: SESSION_VERSION,
    direction: 'row',
    focused: 0,
    tabs,
    panes: [0],
    project: null,
    recent: [],
    recentProjects: [],
    ...overrides,
  }
}

/**
 * 手动挡的定时器。`fire()` 跑一轮并把在飞的写等到落地——
 * 不等的话断言就是在跟 promise 赛跑。
 */
function fakeClock() {
  const ticks: (() => void)[] = []
  let scheduled = 0
  let cancelled = 0
  let lastInterval = -1
  let live: (() => void) | null = null

  const schedule: Scheduler = (tick, intervalMs) => {
    ticks.push(tick)
    scheduled++
    lastInterval = intervalMs
    live = tick
    return () => {
      cancelled++
      live = null
    }
  }

  return {
    schedule,
    get scheduled() {
      return scheduled
    },
    get cancelled() {
      return cancelled
    },
    get lastInterval() {
      return lastInterval
    },
    get running() {
      return live !== null
    },
    async fire() {
      const tick = live
      if (!tick) throw new Error('定时器没在跑')
      tick()
      await flush()
    },
  }
}

/** 让在飞的 promise 链落地。saveSession 是 mock，一轮宏任务足够 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 只让一次微任务落地：用在「那一轮的写故意悬着不完成」的用例里 */
async function yieldMicro() {
  await Promise.resolve()
}

const liveEditors: { controller: EditorController; host: HTMLElement }[] = []

function attachEditor(ws: Workspace, paneId: number, state: EditorState): EditorController {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const controller = new EditorController(host, state)
  liveEditors.push({ controller, host })
  ws.attach(paneId, controller)
  return controller
}

/** 给所有还没有编辑器的分屏挂上。`restoreSession` 换掉分屏记录之后要重来一遍 */
function remountAll(ws: Workspace) {
  for (const p of ws.panes()) {
    if (p.controller) continue
    const tab = ws.tabs().find((t) => t.id === p.tabId())!
    attachEditor(ws, p.id, tab.snapshot.state)
  }
}

/** 待回收的 Solid 计算作用域 */
const disposers: (() => void)[] = []

/** 表驱动的假目录：rel → 条目。表里没有的 rel 一律 `not_found` */
type FakeFs = Record<string, DirEntry[]>

function dirEntry(rel: string, isDir = false): DirEntry {
  return { name: rel.slice(rel.lastIndexOf('/') + 1), rel, path: `/repo/${rel}`, isDir }
}

/**
 * 一棵**真的**项目树，只有 `list_dir` 是假的。
 *
 * 必须建在 `createRoot` 里：store 用了 `createMemo`，在作用域外建的话 Solid 会打印
 * 「computations created outside a `createRoot` or `render` will never be disposed」，
 * 而那条警告会把真正要看的东西淹掉。
 */
function makeTree(fs: FakeFs = {}): ProjectTree {
  project.listDir.mockImplementation(async (root: string, rel: string) => {
    const entries = fs[rel]
    if (!entries) {
      // Rust 的 Err 是被序列化后原样抛出的普通对象，包一层 Error 会让
      // describeTreeError 走到兜底分支上去（这里那个函数也是假的，但形状要保持一致）
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { kind: 'not_found', path: `${root}/${rel}` }
    }
    // ⚠️ `path` 按**这次请求的那个根**重算，不用 `dirEntry` 里写死的那份：
    // 多根的用例共用同一个 `fs`（按 rel 取），而 `DirEntry.path` 是绝对路径，
    // Rust 的 `list_dir` 也是这么发的。写死的话第二个根里的条目会指着第一个根
    return { rel, entries: entries.map((e) => ({ ...e, path: `${root}/${e.rel}` })) }
  })
  return createRoot((teardown) => {
    disposers.push(teardown)
    return createProjectTree({})
  })
}

/** 第 0 个根里的 `rel` 行键。这一层的用例都只有一个根 */
const k = (rel: string) => rowKey(0, rel)

/** 存档里 project 那一半的形状：M2-F 起是**根清单**，每个根自己带一份展开状态 */
const archived = (root: string, expanded: string[]): SessionProject => ({ roots: [{ root, expanded }] })

function harness(tree?: ProjectTree) {
  const ws = createWorkspace({ promptDiscard: async () => 'cancel' })
  const editor = attachEditor(ws, ws.panes()[0]!.id, ws.activeTab().snapshot.state)
  const clock = fakeClock()
  const warnings: string[] = []
  const sync: SessionSync = createSessionSync({
    workspace: ws,
    // 不注入树的老调用方也必须照常工作（`project` 恒为 null），所以这里是可选的
    project: tree,
    onWarn: (text) => warnings.push(text),
    schedule: clock.schedule,
  })
  return {
    ws,
    editor,
    clock,
    warnings,
    sync,
    type(text: string) {
      const at = editor.view.state.doc.length
      editor.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
    },
  }
}

/** 最近一次写出去的会话 */
function lastSaved(): Session {
  const calls = session.saveSession.mock.calls
  return calls[calls.length - 1]![0] as Session
}

beforeEach(() => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  project.listDir.mockReset()
  session.loadSession.mockReset()
  session.saveSession.mockReset()
  ipc.openFile.mockResolvedValue(textFile())
  ipc.saveFile.mockResolvedValue(OK_WRITE)
  session.loadSession.mockResolvedValue(null)
  session.saveSession.mockResolvedValue(OK_REPORT)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const { controller, host } of liveEditors.splice(0)) {
    controller.destroy()
    host.remove()
  }
})

describe('start：启动时读回上次的会话', () => {
  it('没有存档（第一次启动）：现场不动，定时器照样起来', async () => {
    const h = harness()

    await h.sync.start()

    expect(h.ws.tabs()).toHaveLength(1)
    expect(h.ws.activeTab().doc.path()).toBeNull()
    expect(h.ws.activeTab().doc.dirty()).toBe(false)
    expect(h.clock.scheduled).toBe(1)
    expect(h.clock.lastInterval).toBe(SESSION_SYNC_INTERVAL_MS)
    expect(h.warnings).toEqual([])
  })

  it('有存档就整个装进来：正文、脏标记、分屏布局、方向、聚焦一样不少', async () => {
    const h = harness()
    session.loadSession.mockResolvedValue(
      sessionOf(
        [
          sessionTab({ path: '/a.txt' }),
          sessionTab({ path: null, draft: '没存过的稿子', dirty: true, selection: [[3, 3]], scrollTop: 90 }),
        ],
        { direction: 'column', focused: 1, panes: [0, 1] },
      ),
    )

    await h.sync.start()
    remountAll(h.ws)

    expect(h.ws.tabs().map((t) => t.doc.path())).toEqual(['/a.txt', null])
    expect(h.ws.tabs()[0]!.doc.dirty()).toBe(false)
    expect(h.ws.tabs()[1]!.doc.dirty()).toBe(true)
    expect(h.ws.panes()).toHaveLength(2)
    expect(h.ws.direction()).toBe('column')
    // focused 是**分屏**下标，指向第二个标签
    expect(h.ws.activeTab().doc.path()).toBeNull()
    expect(h.ws.panes()[1]!.controller!.doc).toBe('没存过的稿子')
    expect(h.ws.panes()[1]!.controller!.view.scrollDOM.scrollTop).toBe(90)
    // 干净又有路径的那个是重新读盘的，不是照抄存档
    expect(ipc.openFile).toHaveBeenCalledWith('/a.txt')
  })

  it('存档读不回来：说一句「上次的会话没能读回来」，然后照常启动', async () => {
    const h = harness()
    const err = { kind: 'corrupt', message: '第 3 个标签的选区是空的' }
    session.loadSession.mockRejectedValue(err)

    await h.sync.start()

    expect(h.warnings).toEqual([describeSessionError(err)])
    expect(h.warnings[0]).toContain('上次的会话没能读回来')
    // 关键是应用还得能跑：留着那个初始空标签，定时器也起来了
    expect(h.ws.tabs()).toHaveLength(1)
    expect(h.clock.running).toBe(true)
  })

  it('恢复过程本身炸了也是同一待遇：不能让启动挂在半路', async () => {
    const ws = createWorkspace()
    const boom = new Error('装不进去')
    const restoreSession = vi.fn().mockRejectedValue(boom)
    const warnings: string[] = []
    const clock = fakeClock()
    const sync = createSessionSync({
      workspace: { ...ws, restoreSession },
      onWarn: (t) => warnings.push(t),
      schedule: clock.schedule,
    })
    session.loadSession.mockResolvedValue(sessionOf([sessionTab()]))

    await sync.start()

    expect(restoreSession).toHaveBeenCalledTimes(1)
    expect(warnings).toEqual([boom.message])
    expect(clock.running).toBe(true)
  })

  it('start 两次只留一个定时器：旧的必须先注销', async () => {
    const h = harness()

    await h.sync.start()
    await h.sync.start()

    expect(h.clock.scheduled).toBe(2)
    expect(h.clock.cancelled).toBe(1)
    expect(h.clock.running).toBe(true)
  })
})

describe('节流自动保存：轮询 + 比对内容', () => {
  it('第一轮把现状写下去，之后现场没变就一个字节都不写', async () => {
    const h = harness()
    await h.sync.start()

    await h.clock.fire()
    expect(session.saveSession).toHaveBeenCalledTimes(1)
    expect(lastSaved().version).toBe(SESSION_VERSION)

    await h.clock.fire()
    await h.clock.fire()
    expect(session.saveSession).toHaveBeenCalledTimes(1)
  })

  it('敲了字，下一轮写下去的就是新正文', async () => {
    const h = harness()
    await h.sync.start()
    await h.clock.fire()

    h.type('刚敲进去的')
    await h.clock.fire()

    expect(session.saveSession).toHaveBeenCalledTimes(2)
    expect(lastSaved().tabs[0]!.draft).toBe('刚敲进去的')
    expect(lastSaved().tabs[0]!.dirty).toBe(true)
  })

  it('只移了光标也要写：光标位置是会话的一部分', async () => {
    const h = harness()
    h.type('abc')
    await h.sync.start()
    await h.clock.fire()
    expect(lastSaved().tabs[0]!.selection).toEqual([[3, 3]])

    h.editor.view.dispatch({ selection: { anchor: 1 } })
    await h.clock.fire()

    expect(session.saveSession).toHaveBeenCalledTimes(2)
    expect(lastSaved().tabs[0]!.selection).toEqual([[1, 1]])
  })

  it('只滚了一下也要写——这条正是「打标记式」节流会漏掉的', async () => {
    // 滚动不经过 workspace 的任何 setter，也没有 onUpdate（那是纯视口更新）。
    // 靠比对序列化结果就不会漏；靠在每个改动点打标记的话，这里必然漏一个
    const h = harness()
    await h.sync.start()
    await h.clock.fire()

    h.editor.view.scrollDOM.scrollTop = 240
    await h.clock.fire()

    expect(session.saveSession).toHaveBeenCalledTimes(2)
    expect(lastSaved().tabs[0]!.scrollTop).toBe(240)
  })

  it('加了分屏、切了聚焦都算变了', async () => {
    const h = harness()
    await h.sync.start()
    await h.clock.fire()
    expect(lastSaved().panes).toEqual([0])

    h.ws.split('column')
    remountAll(h.ws)
    await h.clock.fire()

    expect(session.saveSession).toHaveBeenCalledTimes(2)
    expect(lastSaved().panes).toEqual([0, 1])
    expect(lastSaved().direction).toBe('column')
    expect(lastSaved().focused).toBe(1)
  })

  it('写失败：说一句，而且下一轮会重试——失败不能把 lastSent 顶上去', async () => {
    const h = harness()
    await h.sync.start()
    const err = { kind: 'io', reason: 'DiskFull', message: '磁盘满了' }
    session.saveSession.mockRejectedValueOnce(err)

    await h.clock.fire()
    expect(h.warnings).toEqual([describeSessionError(err)])

    h.type('又敲了点')
    await h.clock.fire()
    // 重试成功了，而且写下去的是最新现场，不是失败那一轮的
    expect(session.saveSession).toHaveBeenCalledTimes(2)
    expect(lastSaved().tabs[0]!.draft).toBe('又敲了点')
    expect(h.warnings).toHaveLength(1)
  })

  it('草稿被丢掉时必须告诉用户：他以为稿子存下来了', async () => {
    const h = harness()
    await h.sync.start()
    session.saveSession.mockResolvedValue({ bytesWritten: 4194304, droppedDrafts: 2 })

    await h.clock.fire()

    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('2 个文档')
    expect(h.warnings[0]).toContain('没能存进会话')
  })

  it('一个草稿都没丢就别吵', async () => {
    const h = harness()
    await h.sync.start()

    await h.clock.fire()

    expect(h.warnings).toEqual([])
  })
})

describe('saveNow：关窗放行前的那一次', () => {
  it('不等定时器，立刻把最后几秒的改动写下去', async () => {
    const h = harness()
    await h.sync.start()
    h.type('关窗前敲的')

    await h.sync.saveNow()

    expect(session.saveSession).toHaveBeenCalledTimes(1)
    expect(lastSaved().tabs[0]!.draft).toBe('关窗前敲的')
  })

  it('盘上已经是最新的就不重复写', async () => {
    const h = harness()
    await h.sync.start()
    await h.clock.fire()

    await h.sync.saveNow()

    expect(session.saveSession).toHaveBeenCalledTimes(1)
  })

  it('与在飞的那一轮串行，不并发两个写', async () => {
    const h = harness()
    await h.sync.start()
    let release!: (report: SessionReport) => void
    const gate = new Promise<SessionReport>((resolve) => {
      release = resolve
    })
    session.saveSession.mockReturnValueOnce(gate)

    const inflight = h.sync.saveNow()
    // saveNow 是把这一轮挂在队列尾巴上（`tail.then(...)`），不是同步开跑：
    // 让一次微任务落地它就开始了，而 gate 那个 promise 故意悬着，写不会完成
    await yieldMicro()
    expect(session.saveSession).toHaveBeenCalledTimes(1)

    h.type('第一轮还在飞的时候敲的')
    const quit = h.sync.saveNow()
    // 第一轮没落地之前，第二轮压根没开始
    expect(session.saveSession).toHaveBeenCalledTimes(1)

    release(OK_REPORT)
    await inflight
    await quit

    expect(session.saveSession).toHaveBeenCalledTimes(2)
    expect(lastSaved().tabs[0]!.draft).toBe('第一轮还在飞的时候敲的')
  })

  it('写不下去也不往上抛：窗口必须关得掉', async () => {
    // 抛出去的后果是 `attachWindowCloseGuard` 那条 promise 链 reject，
    // 于是 `close_window` 永远不被调用——应用变成一个关不掉的窗口。
    // 会话存档是尽力而为的，用户的**文档**已经由 requestWindowClose 那一步保住了
    const h = harness()
    await h.sync.start()
    session.saveSession.mockRejectedValue({ kind: 'io', reason: 'DiskFull', message: '磁盘满了' })

    await expect(h.sync.saveNow()).resolves.toBeUndefined()
    expect(h.warnings).toEqual(['磁盘满了'])
  })

  it('关窗握手：放行才存，不放行一个字节都不写', async () => {
    const h = harness()
    await h.sync.start()
    const handshake = async () => {
      const ok = await h.ws.requestWindowClose()
      if (ok) await h.sync.saveNow()
      return ok
    }

    // 全干净 → 放行 → 存
    expect(await handshake()).toBe(true)
    expect(session.saveSession).toHaveBeenCalledTimes(1)

    // 脏了，而 promptDiscard 答「取消」→ 不放行 → 不存
    h.type('不想丢的稿子')
    expect(await handshake()).toBe(false)
    expect(session.saveSession).toHaveBeenCalledTimes(1)
  })
})

describe('stop', () => {
  it('停掉之后不再有新的轮次，重复 stop 是安全的', async () => {
    const h = harness()
    await h.sync.start()
    await h.clock.fire()

    h.sync.stop()
    expect(h.clock.running).toBe(false)
    expect(h.clock.cancelled).toBe(1)

    h.sync.stop()
    expect(h.clock.cancelled).toBe(1)
  })

  it('没 start 就 stop 也不会炸', () => {
    const h = harness()
    expect(() => h.sync.stop()).not.toThrow()
    expect(h.clock.cancelled).toBe(0)
  })
})

describe('项目树那一半（M2-B-4）', () => {
  /** 一个两层的小仓库：根下有 src 与 README.md，src 下有 a.ts */
  const FS: FakeFs = {
    '': [dirEntry('src', true), dirEntry('README.md')],
    src: [dirEntry('src/a.ts')],
  }

  /** `list_dir` 收到的 (root, rel) 序列。并行读回来的顺序不保证，所以断言前先排序 */
  function listed(): string[] {
    return project.listDir.mock.calls.map((c) => `${c[0] as string}|${c[1] as string}`).sort()
  }

  it('没打开文件夹时 project 是 null，而不是整个键消失', async () => {
    const h = harness(makeTree(FS))
    await h.sync.start()
    await h.clock.fire()

    expect(lastSaved().project).toBeNull()
    // 键必须在：`JSON.stringify` 删掉 undefined 的键，而「缺键」与「字段名拼错」
    // 在线上长得一模一样
    expect(session.saveSession.mock.calls[0]![0] as Record<string, unknown>).toHaveProperty('project', null)
  })

  it('没注入树的老调用方照常工作，project 也是 null', async () => {
    const h = harness()
    await h.sync.start()
    await h.clock.fire()

    expect(lastSaved().project).toBeNull()
    expect(h.warnings).toEqual([])
  })

  it('打开文件夹之后，那一半被拼进存档；标签那一半一个字不变', async () => {
    const tree = makeTree(FS)
    const h = harness(tree)
    await h.sync.start()

    await tree.openAt('/repo')
    await h.clock.fire()

    const saved = lastSaved()
    expect(saved.project).toEqual(archived('/repo', ['']))
    // 拼的是**同一个对象**，不是把 workspace 那半覆盖掉：
    // `serializeSession` 返回的 project 恒为 null，展开顺序错了就会是这样
    expect(saved.tabs).toHaveLength(1)
    expect(saved.panes).toEqual([0])
    expect(saved.version).toBe(SESSION_VERSION)
  })

  it('只摊开一层（不动任何标签）也会触发一次写', async () => {
    // ⚠️ 这条钉的是「指纹在拼接**之后**算」。算早了的话，摊开/收起文件夹永远不会
    // 被认成改动，存档就悄悄停在旧的展开状态——不报错，用户重启后发现树缩回去了
    const tree = makeTree(FS)
    const h = harness(tree)
    await h.sync.start()
    await tree.openAt('/repo')
    await h.clock.fire()
    expect(session.saveSession).toHaveBeenCalledTimes(1)

    await tree.toggle(k('src'))
    await h.clock.fire()
    expect(session.saveSession).toHaveBeenCalledTimes(2)
    expect(lastSaved().project).toEqual(archived('/repo', ['', 'src']))
  })

  it('收起之后要再写一次：比对的对象是「上次写出去的」，不是「以前写过没有」', async () => {
    // 摊开 → 收起，序列化结果回到了最初那份，但**盘上那份还停在摊开的状态**。
    // 所以这里必须再写一次。要是 `lastSent` 记的是「见过的所有指纹」，
    // 这一下就会被跳过，重启后树是摊开的——正是用户刚才亲手收起的那一层。
    const tree = makeTree(FS)
    const h = harness(tree)
    await h.sync.start()
    await tree.openAt('/repo')
    await h.clock.fire()
    await tree.toggle(k('src'))
    await h.clock.fire()
    expect(session.saveSession).toHaveBeenCalledTimes(2)

    await tree.toggle(k('src'))
    await h.clock.fire()
    expect(session.saveSession).toHaveBeenCalledTimes(3)
    expect(lastSaved().project).toEqual(archived('/repo', ['']))

    // 现场没再动过，这一轮就该什么都不写
    await h.clock.fire()
    expect(session.saveSession).toHaveBeenCalledTimes(3)
  })

  it('start 把 project 交回给树，并按 expanded 逐层读回来', async () => {
    const tree = makeTree(FS)
    const h = harness(tree)
    session.loadSession.mockResolvedValue(
      sessionOf([sessionTab({ path: '/a.txt' })], { project: archived('/repo', ['', 'src']) }),
    )

    await h.sync.start()

    expect(tree.roots()).toEqual(['/repo'])
    // 两层都读了，而且是并行发出的（顺序不保证，所以排序后比）
    expect(listed()).toEqual(['/repo|', '/repo|src'])
    // 标签那一半同时装好了：两半是并行的，不是「先标签，成了才轮到树」
    expect(h.ws.tabs()).toHaveLength(1)
    expect(h.ws.activeTab().doc.path()).toBe('/a.txt')
    expect(h.warnings).toEqual([])
  })

  it('存档里有多个根时逐个装回来，每个根读自己的展开清单', async () => {
    const tree = makeTree(FS)
    const h = harness(tree)
    session.loadSession.mockResolvedValue(
      sessionOf([sessionTab({ path: '/a.txt' })], {
        project: {
          roots: [
            { root: '/repo', expanded: ['', 'src'] },
            { root: '/notes', expanded: [''] },
          ],
        },
      }),
    )

    await h.sync.start()

    expect(tree.roots()).toEqual(['/repo', '/notes'])
    // 两个根的层**一起**并行读出去，不是「读完第一个根再读第二个」
    expect(listed()).toEqual(['/notes|', '/repo|', '/repo|src'])
    expect(h.ws.tabs()).toHaveLength(1)
    expect(h.warnings).toEqual([])

    // 再写一轮，两个根都原样回到存档里
    await h.clock.fire()
    expect(lastSaved().project).toEqual({
      roots: [
        { root: '/repo', expanded: ['', 'src'] },
        { root: '/notes', expanded: [''] },
      ],
    })
  })

  it('存档里 project 是 null 时树保持空，标签照常恢复', async () => {
    const tree = makeTree(FS)
    const h = harness(tree)
    session.loadSession.mockResolvedValue(sessionOf([sessionTab({ path: '/a.txt' })]))

    await h.sync.start()

    expect(tree.roots()).toEqual([])
    expect(project.listDir).not.toHaveBeenCalled()
    expect(h.ws.tabs()).toHaveLength(1)
  })

  it('存档里那一层已经不存在时，别的层照常恢复，不牵连标签也不报警', async () => {
    // 文件夹被移动/删除是常态（换机器、外挂盘没插）。为它赔掉整个会话是错的，
    // 所以这条路径既不该抛，也不该走 onWarn。
    //
    // 而那一层自己也**画不出错误行**：行是从 listings 摊出来的，一个磁盘上已经不存在的
    // `rel` 压根不在任何 listing 里，没有行可挂。错误只是记在 store 的 errors 表里。
    // 这是对的——那个文件夹没了，树上就该什么都不显示，而不是凭空多出一行红字。
    const tree = makeTree({ '': [dirEntry('src', true)] })
    const h = harness(tree)
    session.loadSession.mockResolvedValue(
      sessionOf([sessionTab({ path: '/a.txt' })], { project: archived('/repo', ['', '已经没了']) }),
    )

    await h.sync.start()

    expect(tree.roots()).toEqual(['/repo'])
    expect(tree.rows().map((r) => r.name)).toEqual(['repo', 'src'])
    expect(h.ws.tabs()).toHaveLength(1)
    expect(h.warnings).toEqual([])
  })

  it('saveNow（关窗放行前那一次）也带上树那一半', async () => {
    const tree = makeTree(FS)
    const h = harness(tree)
    await h.sync.start()
    await tree.openAt('/repo')
    await tree.toggle(k('src'))

    await h.sync.saveNow()

    expect(lastSaved().project).toEqual(archived('/repo', ['', 'src']))
  })
})

describe('最近项目那一格（M2-F-6）', () => {
  const FS: FakeFs = { '': [dirEntry('src', true)] }

  it('键必须在，而且没打开过任何文件夹时它就是空数组', async () => {
    const h = harness(makeTree(FS))
    await h.sync.start()
    await h.clock.fire()

    // 与 `project: null` 同一条理由：`JSON.stringify` 会删掉 undefined 的键，
    // 而「缺键」与「字段名拼错」在线上长得一模一样
    expect(session.saveSession.mock.calls[0]![0] as Record<string, unknown>).toHaveProperty('recentProjects', [])
  })

  it('没注入树的老调用方照常工作，recentProjects 也是空数组', async () => {
    const h = harness()
    await h.sync.start()
    await h.clock.fire()

    expect(lastSaved().recentProjects).toEqual([])
    expect(h.warnings).toEqual([])
  })

  it('换一次工作区，刚离开的那一个就进存档；当前这个也在最前面', async () => {
    const tree = makeTree(FS)
    const h = harness(tree)
    await h.sync.start()

    await tree.openAt('/repo')
    await h.clock.fire()
    // 只开过一个：没有「刚离开的」，于是清单里只有当前这一个
    expect(lastSaved().recentProjects).toEqual([['/repo']])

    await tree.openAt('/notes')
    await h.clock.fire()
    expect(lastSaved().recentProjects).toEqual([['/notes'], ['/repo']])
  })

  it('⚠️ 换工作区必须**当轮**就写下去：等下一轮的话「刚切过去又切回来」会丢一个', async () => {
    // 这条钉的是「记录发生在替换的那一刻」而不是「轮询时才去看现在是什么」。
    // 记晚了的失败方式是静默的：用户切到 B、五秒内切回 A，存档里从头到尾只有 A，
    // 而 B 一次都没被记下来——他下次按 Cmd+Shift+O 找不到 B，也想不到为什么
    const tree = makeTree(FS)
    const h = harness(tree)
    await h.sync.start()
    await tree.openAt('/repo')
    await h.clock.fire()

    await tree.openAt('/notes')
    await tree.openAt('/repo')
    await h.clock.fire()

    expect(lastSaved().recentProjects).toEqual([['/repo'], ['/notes']])
  })

  it('start 把清单交回给树，而当前工作区不出现在候选里', async () => {
    const tree = makeTree(FS)
    const h = harness(tree)
    session.loadSession.mockResolvedValue(
      sessionOf([sessionTab({ path: '/a.txt' })], {
        project: archived('/repo', ['']),
        recentProjects: [['/repo'], ['/notes'], ['/scratch', '/docs']],
      }),
    )

    await h.sync.start()

    // `/repo` 是恢复出来的当前工作区，浮层里不该再列它一次（选了它等于把树重建一遍、
    // 摊开着的层全缩回去，见 goto/store.ts）
    expect(tree.recentProjects()).toEqual([['/notes'], ['/scratch', '/docs']])
    expect(tree.roots()).toEqual(['/repo'])
    expect(h.ws.tabs()).toHaveLength(1)
    expect(h.warnings).toEqual([])

    // 再写一轮，当前那个回到最前面，其余原样跟着
    await h.clock.fire()
    expect(lastSaved().recentProjects).toEqual([['/repo'], ['/notes'], ['/scratch', '/docs']])
  })
})
