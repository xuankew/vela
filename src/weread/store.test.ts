import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 微信读书同步 store 的单测：异步与可变状态这一半（M8-6a）。
 *
 * 认账逻辑与 `src/search/store.test.ts` 是同一份，理由也一样：`weread_sync_dir`
 * 先 spawn 后台任务、再返回 taskId，所以**终止事件可能比 invoke 的返回值先到**。
 * 一次几千本书的同步撞不上这个窗口，但**一次立刻就失败的同步**可以（列书单那一步
 * 就撞上 `upgrade_info`）。朴素写法会把那条 failed 丢掉，界面永远停在「同步中…」。
 *
 * 假的是 `startWereadSync` / `describeWereadError`（都在 `./ipc`）与 `cancelTask`
 * （在 `../ipc/task`）——jsdom 里没有 Tauri 运行时。`describeWereadError` 也假掉：
 * 它自己的形状在 `ipc.test.ts` 里钉过，这里只关心「错误有没有落到 `onError` 上」。
 *
 * 事件监听器本身不在这里：store 只交出 `handlers` 三个回调，测试直接调它们，
 * 于是「事件到达的顺序」变成一串可以随手编排的普通函数调用。
 */

const { ipc, task } = vi.hoisted(() => ({
  ipc: {
    startWereadSync: vi.fn<(dir: string) => Promise<string>>(),
    describeWereadError: vi.fn<(err: unknown) => string>(),
  },
  task: {
    cancelTask: vi.fn<(taskId: string) => Promise<void>>(),
  },
}))

vi.mock('./ipc', () => ipc)
vi.mock('../ipc/task', () => task)

import type { WereadError, WereadProgress, WereadSummary } from './ipc'
import { createWereadSync, type WereadSync } from './store'

/**
 * 造一个「拒绝掉、且拒绝值是纯对象」的 promise。
 *
 * ⚠️ 这条 eslint 豁免是必需的：`invoke` 在 Rust 侧返回 `Err` 时抛给前端的就是
 * 序列化后的那个对象，不是 `Error` 实例。改成 `new Error(...)` 的话这组用例会全绿，
 * 而线上照样炸
 */
function rejected<T>(payload: unknown): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 见上
  return Promise.reject(payload)
}

/** 一个能自己决定什么时候 settle 的 promise，用来把「事件先到 / 返回先到」掰开 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function progressAt(booksDone: number, booksTotal: number): WereadProgress {
  return { booksDone, booksTotal }
}

/** 一份「一本都没写」的总账，按需覆盖 */
function summary(overrides: Partial<WereadSummary> = {}): WereadSummary {
  return {
    booksTotal: 90,
    booksWritten: 90,
    booksSkipped: 0,
    marks: 1760,
    reviews: 42,
    cancelled: false,
    elapsedMs: 12_345,
    ...overrides,
  }
}

/** `onError` 收到的那些话，按顺序。空 = 这一轮没报错 */
let errors: string[]
let sync: WereadSync

beforeEach(() => {
  ipc.startWereadSync.mockReset()
  ipc.describeWereadError.mockReset()
  task.cancelTask.mockReset()
  ipc.startWereadSync.mockResolvedValue('w1')
  ipc.describeWereadError.mockImplementation((err) => `模拟错误：${JSON.stringify(err)}`)
  task.cancelTask.mockResolvedValue(undefined)
  errors = []
  sync = createWereadSync({ onError: (text) => void errors.push(text) })
})

/** 被请求取消过的 taskId，按顺序 */
function cancelled(): string[] {
  return task.cancelTask.mock.calls.map((c) => c[0])
}

/** 起一次同步并把 taskId 认下来，好让后面的事件有得可发 */
async function startOnce(dir = '/Users/xuanke/Document/readbook'): Promise<void> {
  await sync.start(dir)
}

describe('初始状态', () => {
  it('没在跑、没有进度、什么都没发出去', () => {
    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    expect(ipc.startWereadSync).not.toHaveBeenCalled()
  })

  it('没在跑时 cancel 是空操作', async () => {
    await sync.cancel()
    expect(cancelled()).toEqual([])
  })

  it('没在跑时陌生 taskId 的事件一律丢掉', () => {
    sync.handlers.onProgress('stranger', progressAt(0, 90))
    sync.handlers.onDone('stranger', summary())
    sync.handlers.onFailed('stranger', { kind: 'api', message: '不认识' })
    expect(sync.progress()).toBeNull()
    expect(sync.running()).toBe(false)
    expect(errors).toEqual([])
  })
})

describe('起飞', () => {
  it('目录原样递过去，running 立刻置真，进度还是空', async () => {
    await startOnce('/Users/xuanke/Document/readbook/')
    // 前端不做路径算术：归一化是 Rust 侧 canonicalize 那一份的唯一口径
    expect(ipc.startWereadSync).toHaveBeenCalledWith('/Users/xuanke/Document/readbook/')
    expect(sync.running()).toBe(true)
    // 第一份进度要等后台列完书单才来，这个窗口里界面上说的是「同步中…」
    expect(sync.progress()).toBeNull()
  })

  it('⚠️ 已经在跑时第二次 start 被忽略', async () => {
    const gate = deferred<string>()
    ipc.startWereadSync.mockReturnValue(gate.promise)
    const first = sync.start('/repo')
    await Promise.resolve()
    expect(sync.running()).toBe(true)

    // 图标那边本来也会禁用自己，这里是第二道。两道都没有的话，连按两下会起两个
    // 后台任务往同一个目录写同一批文件
    await sync.start('/other')
    expect(ipc.startWereadSync).toHaveBeenCalledTimes(1)

    gate.resolve('w1')
    await first
  })

  it('预检失败：running 复位、那句话走 onError、不留 taskId', async () => {
    ipc.startWereadSync.mockImplementation(() =>
      rejected<string>({
        kind: 'not_configured',
        message: '微信读书的 key 还没填。到「设置 → 微信读书」里填一次。',
      }),
    )
    await startOnce()

    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    expect(ipc.describeWereadError).toHaveBeenCalledWith({
      kind: 'not_configured',
      message: '微信读书的 key 还没填。到「设置 → 微信读书」里填一次。',
    })
    expect(errors).toEqual([
      '模拟错误：{"kind":"not_configured","message":"微信读书的 key 还没填。到「设置 → 微信读书」里填一次。"}',
    ])

    // reject = 这次同步压根没开始，之后不会再有事件；此时 cancel 也没得可取消
    await sync.cancel()
    expect(cancelled()).toEqual([])
  })
})

describe('进度', () => {
  it('认下来的 taskId 的进度落到信号上', async () => {
    await startOnce()
    sync.handlers.onProgress('w1', progressAt(0, 90))
    expect(sync.progress()).toEqual({ booksDone: 0, booksTotal: 90 })

    sync.handlers.onProgress('w1', progressAt(1, 90))
    expect(sync.progress()).toEqual({ booksDone: 1, booksTotal: 90 })
    // 进度不是终止信号：还在跑
    expect(sync.running()).toBe(true)
  })

  it('⚠️ 是「第几本」，直接赋值不是累加', async () => {
    await startOnce()
    sync.handlers.onProgress('w1', progressAt(1, 90))
    sync.handlers.onProgress('w1', progressAt(89, 90))
    // 当成增量累加的话，九十本书会显示成「同步中… 九十/九十」之后继续涨
    expect(sync.progress()).toEqual({ booksDone: 89, booksTotal: 90 })
  })

  it('done 之后迟到的进度进不来', async () => {
    await startOnce()
    sync.handlers.onProgress('w1', progressAt(90, 90))
    sync.handlers.onDone('w1', summary())
    sync.handlers.onProgress('w1', progressAt(90, 90))
    expect(sync.progress()).toBeNull()
    expect(sync.running()).toBe(false)
  })
})

describe('终止', () => {
  it('done 收尾：running 复位、进度清空，而且不弹提示', async () => {
    await startOnce()
    sync.handlers.onProgress('w1', progressAt(45, 90))
    sync.handlers.onDone('w1', summary())

    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    // 结果就写在磁盘上（新素材文件 + 整理文件），再弹一句只是噪声。
    // 这里同时钉住「完成不弹 toast」：想加提示的人得先删掉这一条
    expect(errors).toEqual([])
  })

  it('failed 也是终止：running 复位、Rust 那句话走 onError', async () => {
    const error: WereadError = { kind: 'network', reason: 'Connect', message: '连不上 i.weread.qq.com。' }
    await startOnce()
    sync.handlers.onProgress('w1', progressAt(3, 90))
    sync.handlers.onFailed('w1', error)

    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    expect(ipc.describeWereadError).toHaveBeenCalledWith(error)
    expect(errors).toEqual([`模拟错误：${JSON.stringify(error)}`])
  })

  it('failed 之后同一个 taskId 的迟到进度不落进来', async () => {
    await startOnce()
    sync.handlers.onFailed('w1', { kind: 'directory', message: '目录不一致' })
    sync.handlers.onProgress('w1', progressAt(7, 90))
    expect(sync.progress()).toBeNull()
  })
})

describe('取消', () => {
  it('cancel 只发请求，状态一律不动', async () => {
    await startOnce()
    sync.handlers.onProgress('w1', progressAt(4, 90))
    await sync.cancel()

    expect(cancelled()).toEqual(['w1'])
    // 后台是协作式取消，它跑到下一次检查标志才知道。这里自己把 running 置假的话，
    // 取消之后迟到的进度会落在一个「已经结束」的界面上
    expect(sync.running()).toBe(true)
    expect(sync.progress()).toEqual({ booksDone: 4, booksTotal: 90 })

    // 唯一的终止信号仍是 done——取消也走它
    sync.handlers.onDone('w1', summary({ cancelled: true, booksWritten: 4 }))
    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
  })
})

describe('taskId 的认领与作废', () => {
  it('⚠️ done 比 invoke 的返回值先到：认下来、收尾，而且不留下一个可取消的 id', async () => {
    const gate = deferred<string>()
    ipc.startWereadSync.mockReturnValue(gate.promise)
    const pending = sync.start('/repo')

    // 列书单那一步就撞上 upgrade_info：后台在 invoke 回来之前就发了 done
    sync.handlers.onProgress('early', progressAt(0, 0))
    sync.handlers.onDone('early', summary({ booksTotal: 0, booksWritten: 0, cancelled: true }))

    gate.resolve('early')
    await pending

    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    expect(errors).toEqual([])

    await sync.cancel()
    // adopted 要是被无条件写成 taskId，这里会去取消一个已经结束的任务：
    // 不炸，但白跑一趟 IPC，而且读代码的人会以为那一轮还在飞
    expect(cancelled()).toEqual([])
  })

  it('⚠️ failed 比 invoke 的返回值先到：那句话不能丢', async () => {
    const gate = deferred<string>()
    ipc.startWereadSync.mockReturnValue(gate.promise)
    const pending = sync.start('/repo')

    sync.handlers.onFailed('early', { kind: 'upgrade', message: '服务端要求升级 Skill：请升级到 1.0.6' })

    gate.resolve('early')
    await pending

    expect(sync.running()).toBe(false)
    // 朴素写法在这里会把 failed 丢掉，界面永远停在「同步中…」
    expect(errors).toEqual(['模拟错误：{"kind":"upgrade","message":"服务端要求升级 Skill：请升级到 1.0.6"}'])
    await sync.cancel()
    expect(cancelled()).toEqual([])
  })

  it('retired 优先于 starting：上一轮迟到的进度不会被新一轮的窗口认下来', async () => {
    await startOnce()
    sync.handlers.onDone('w1', summary())

    const gate = deferred<string>()
    ipc.startWereadSync.mockReturnValue(gate.promise)
    const pending = sync.start('/repo')

    // 取消是协作式的，被作废的旧同步还会再推几份进度。认下来的话两轮的进度会混在一起
    sync.handlers.onProgress('w1', progressAt(88, 90))
    expect(sync.progress()).toBeNull()

    gate.resolve('w2')
    await pending
    sync.handlers.onProgress('w2', progressAt(1, 90))
    expect(sync.progress()).toEqual({ booksDone: 1, booksTotal: 90 })
  })
})
