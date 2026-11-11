import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GitHub 同步 store 的单测：异步与可变状态这一半（M8-6b）。
 *
 * 认账逻辑与 `weread/store.ts` 是同一份，理由也一样：`github_sync_dir` 先 spawn 后台任务、
 * 再返回 taskId，所以**终止事件可能比 invoke 的返回值先到**。一次几千个文件的同步撞不上
 * 这个窗口，但**一次立刻就失败的同步**可以（`main` 与 `master` 都不存在，或者 token 401）。
 *
 * 假的是 `startGithubSync` / `describeGithubError`（都在 `./ipc`）与 `cancelTask`
 * （在 `../ipc/task`）——jsdom 里没有 Tauri 运行时。`describeGithubError` 也假掉：
 * 它自己的形状在 `ipc.test.ts` 里钉过，这里只关心「错误有没有落到 `onError` 上」。
 */

const { ipc, task } = vi.hoisted(() => ({
  ipc: {
    startGithubSync: vi.fn<(dir: string) => Promise<string>>(),
    describeGithubError: vi.fn<(err: unknown) => string>(),
  },
  task: {
    cancelTask: vi.fn<(taskId: string) => Promise<void>>(),
  },
}))

vi.mock('./ipc', () => ipc)
vi.mock('../ipc/task', () => task)

import type { GithubError, GithubProgress, GithubSummary } from './ipc'
import { createGithubSync, type GithubSync } from './store'

/**
 * 造一个「拒绝掉、且拒绝值是纯对象」的 promise。
 *
 * ⚠️ 这条 eslint 豁免是必需的：`invoke` 在 Rust 侧返回 `Err` 时抛给前端的就是
 * 序列化后的那个对象，不是 `Error` 实例。
 */
function rejected<T>(payload: unknown): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 见上
  return Promise.reject(payload)
}

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

function progressAt(filesDone: number, filesTotal: number): GithubProgress {
  return { filesDone, filesTotal }
}

function summary(overrides: Partial<GithubSummary> = {}): GithubSummary {
  return { pulled: 1, pushed: 2, cancelled: false, stateSaved: true, elapsedMs: 12_345, ...overrides }
}

/** `onError` 收到的那些话，按顺序。空 = 这一轮没报错 */
let errors: string[]
let sync: GithubSync

beforeEach(() => {
  ipc.startGithubSync.mockReset()
  ipc.describeGithubError.mockReset()
  task.cancelTask.mockReset()
  ipc.startGithubSync.mockResolvedValue('g1')
  ipc.describeGithubError.mockImplementation((err) => `模拟错误：${JSON.stringify(err)}`)
  task.cancelTask.mockResolvedValue(undefined)
  errors = []
  sync = createGithubSync({ onError: (text) => void errors.push(text) })
})

/** 被请求取消过的 taskId，按顺序 */
function cancelled(): string[] {
  return task.cancelTask.mock.calls.map((c) => c[0])
}

async function startOnce(dir = '/Users/xuanke/Document/readbook'): Promise<void> {
  await sync.start(dir)
}

describe('初始状态', () => {
  it('没在跑、没有进度、什么都没发出去', () => {
    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    expect(ipc.startGithubSync).not.toHaveBeenCalled()
  })

  it('没在跑时 cancel 是空操作', async () => {
    await sync.cancel()
    expect(cancelled()).toEqual([])
  })

  it('没在跑时陌生 taskId 的事件一律丢掉', () => {
    sync.handlers.onProgress('stranger', progressAt(0, 9))
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
    expect(ipc.startGithubSync).toHaveBeenCalledWith('/Users/xuanke/Document/readbook/')
    expect(sync.running()).toBe(true)
    // 第一份进度要等后台读完远端树并算完计划才来，这个窗口里界面上说的是「同步中…」
    expect(sync.progress()).toBeNull()
  })

  it('⚠️ 已经在跑时第二次 start 被忽略', async () => {
    const gate = deferred<string>()
    ipc.startGithubSync.mockReturnValue(gate.promise)
    const first = sync.start('/repo')
    await Promise.resolve()
    expect(sync.running()).toBe(true)

    // 图标那边本来也会隐藏自己，这里是第二道
    await sync.start('/other')
    expect(ipc.startGithubSync).toHaveBeenCalledTimes(1)

    gate.resolve('g1')
    await first
  })

  it('预检失败：running 复位、那句话走 onError、不留 taskId', async () => {
    ipc.startGithubSync.mockImplementation(() =>
      rejected<string>({ kind: 'repo', message: '仓库地址看不懂。到「设置 → 文件同步」里填 owner/repo。' }),
    )
    await startOnce()

    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    expect(ipc.describeGithubError).toHaveBeenCalledWith({
      kind: 'repo',
      message: '仓库地址看不懂。到「设置 → 文件同步」里填 owner/repo。',
    })
    expect(errors).toEqual([
      '模拟错误：{"kind":"repo","message":"仓库地址看不懂。到「设置 → 文件同步」里填 owner/repo。"}',
    ])

    // reject = 这次同步压根没开始，之后不会再有事件；此时 cancel 也没得可取消
    await sync.cancel()
    expect(cancelled()).toEqual([])
  })
})

describe('进度', () => {
  it('认下来的 taskId 的进度落到信号上', async () => {
    await startOnce()
    sync.handlers.onProgress('g1', progressAt(0, 9))
    expect(sync.progress()).toEqual({ filesDone: 0, filesTotal: 9 })

    sync.handlers.onProgress('g1', progressAt(1, 9))
    expect(sync.progress()).toEqual({ filesDone: 1, filesTotal: 9 })
    // 进度不是终止信号：还在跑
    expect(sync.running()).toBe(true)
  })

  it('⚠️ 是「第几个」，直接赋值不是累加', async () => {
    await startOnce()
    sync.handlers.onProgress('g1', progressAt(1, 9))
    sync.handlers.onProgress('g1', progressAt(8, 9))
    expect(sync.progress()).toEqual({ filesDone: 8, filesTotal: 9 })
  })

  it('done 之后迟到的进度进不来', async () => {
    await startOnce()
    sync.handlers.onProgress('g1', progressAt(9, 9))
    sync.handlers.onDone('g1', summary())
    sync.handlers.onProgress('g1', progressAt(9, 9))
    expect(sync.progress()).toBeNull()
    expect(sync.running()).toBe(false)
  })
})

describe('终止', () => {
  it('done 收尾：running 复位、进度清空，而且不弹提示', async () => {
    await startOnce()
    sync.handlers.onProgress('g1', progressAt(5, 9))
    sync.handlers.onDone('g1', summary())

    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    // 结果写在磁盘与远端上，再弹一句只是噪声
    expect(errors).toEqual([])
  })

  it('failed 也是终止：running 复位、Rust 那句话走 onError', async () => {
    const error: GithubError = { kind: 'auth', message: 'HTTP 401：Bad credentials' }
    await startOnce()
    sync.handlers.onProgress('g1', progressAt(3, 9))
    sync.handlers.onFailed('g1', error)

    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    expect(ipc.describeGithubError).toHaveBeenCalledWith(error)
    expect(errors).toEqual([`模拟错误：${JSON.stringify(error)}`])
  })

  it('冲突走同一条 failed：message 里那句人话原样落到提示条', async () => {
    const error: GithubError = {
      kind: 'conflict',
      message: '有 1 个整理文件需要你决定，这次同步一个字节都没写：a.md（两边都改过）。处理完再点一次同步。',
      conflicts: [{ path: 'a.md', base: '1', local: '2', remote: '3', kind: 'both_changed' }],
    }
    await startOnce()
    sync.handlers.onFailed('g1', error)

    expect(sync.running()).toBe(false)
    // ⛔ 这里不另起一个「同步冲突」弹窗：冲突清单由文件监视器那条队列去处理，
    // 同步层只把「哪几条、三边各是什么 sha」交出去（前端拿到的是 error.conflicts）
    expect(errors).toEqual([
      '模拟错误：{"kind":"conflict","message":"有 1 个整理文件需要你决定，这次同步一个字节都没写：a.md（两边都改过）。处理完再点一次同步。","conflicts":[{"path":"a.md","base":"1","local":"2","remote":"3","kind":"both_changed"}]}',
    ])
  })

  it('failed 之后同一个 taskId 的迟到进度不落进来', async () => {
    await startOnce()
    sync.handlers.onFailed('g1', { kind: 'directory', message: '目录不一致' })
    sync.handlers.onProgress('g1', progressAt(7, 9))
    expect(sync.progress()).toBeNull()
  })
})

describe('取消', () => {
  it('cancel 只发请求，状态一律不动', async () => {
    await startOnce()
    sync.handlers.onProgress('g1', progressAt(4, 9))
    await sync.cancel()

    expect(cancelled()).toEqual(['g1'])
    // 后台是协作式取消，它跑到下一次检查标志才知道。这里自己把 running 置假的话，
    // 取消之后迟到的进度会落在一个「已经结束」的界面上
    expect(sync.running()).toBe(true)
    expect(sync.progress()).toEqual({ filesDone: 4, filesTotal: 9 })

    // 唯一的终止信号仍是 done——取消也走它
    sync.handlers.onDone('g1', summary({ cancelled: true, pulled: 4 }))
    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
  })
})

describe('taskId 的认领与作废', () => {
  it('⚠️ done 比 invoke 的返回值先到：认下来、收尾，而且不留下一个可取消的 id', async () => {
    const gate = deferred<string>()
    ipc.startGithubSync.mockReturnValue(gate.promise)
    const pending = sync.start('/repo')

    sync.handlers.onProgress('early', progressAt(0, 0))
    sync.handlers.onDone('early', summary({ pulled: 0, pushed: 0, cancelled: true }))

    gate.resolve('early')
    await pending

    expect(sync.running()).toBe(false)
    expect(sync.progress()).toBeNull()
    expect(errors).toEqual([])

    await sync.cancel()
    expect(cancelled()).toEqual([])
  })

  it('⚠️ failed 比 invoke 的返回值先到：那句话不能丢', async () => {
    const gate = deferred<string>()
    ipc.startGithubSync.mockReturnValue(gate.promise)
    const pending = sync.start('/repo')

    sync.handlers.onFailed('early', { kind: 'branch_not_found', message: 'main 与 master 都不存在，先去建一个' })

    gate.resolve('early')
    await pending

    expect(sync.running()).toBe(false)
    // 朴素写法在这里会把 failed 丢掉，界面永远停在「同步中…」
    expect(errors).toEqual(['模拟错误：{"kind":"branch_not_found","message":"main 与 master 都不存在，先去建一个"}'])
    await sync.cancel()
    expect(cancelled()).toEqual([])
  })

  it('retired 优先于 starting：上一轮迟到的进度不会被新一轮的窗口认下来', async () => {
    await startOnce()
    sync.handlers.onDone('g1', summary())

    const gate = deferred<string>()
    ipc.startGithubSync.mockReturnValue(gate.promise)
    const pending = sync.start('/repo')

    sync.handlers.onProgress('g1', progressAt(8, 9))
    expect(sync.progress()).toBeNull()

    gate.resolve('g2')
    await pending
    sync.handlers.onProgress('g2', progressAt(1, 9))
    expect(sync.progress()).toEqual({ filesDone: 1, filesTotal: 9 })
  })
})
