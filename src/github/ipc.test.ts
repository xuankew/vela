import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * GitHub 目录同步的「线上契约」前端快照（M8-6b）。
 *
 * Rust 侧的对照分两处：
 *
 * - `src-tauri/src/github.rs` 的 `进度与终止事件的_json_形状被钉住`（三个信封）与
 *   `冲突清单把三边的_sha_都给出来` / `错误_json_形状被钉住且任何一句都不带_token`
 * - `src-tauri/src/lib.rs` 的 `github_events_match_frontend`（三个事件名）
 *
 * 两边各手写一份，没有代码生成。字段名拼错的失败方式与搜索、微信读书同一档安静：
 * Tauri 对 event payload 不做校验，前端只是收到一堆 `undefined`，
 * 而 `{ filesDone: undefined, filesTotal: undefined }` 画出来是「同步中… 0/0」。
 *
 * ⚠️ `cancel_task` 不在这个文件里：它与搜索、替换、微信读书共用 `src/ipc/task.ts`，
 * 参数名的快照在 `task.test.ts`。
 */

const { tauriEvent, tauriCore } = vi.hoisted(() => ({
  tauriEvent: {
    listen: vi.fn<(name: string, cb: (event: { payload: unknown }) => void) => Promise<Mock>>(),
  },
  tauriCore: { invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>() },
}))

vi.mock('@tauri-apps/api/event', () => tauriEvent)
vi.mock('@tauri-apps/api/core', () => tauriCore)

import {
  attachGithubListeners,
  describeGithubError,
  GITHUB_DONE_EVENT,
  GITHUB_FAILED_EVENT,
  GITHUB_PROGRESS_EVENT,
  startGithubSync,
  type GithubError,
} from './ipc'

// ───────────────────────── 黄金字面量 ─────────────────────────
// 每条都与 Rust 侧某个 assert_eq! 里的字符串逐字节相同

/** 对照 `进度与终止事件的_json_形状被钉住` 的第一条 */
const GOLDEN_ENVELOPE_PROGRESS = '{"taskId":"github-0","progress":{"filesDone":2,"filesTotal":7}}'
/** 同一条的第二条。字段顺序跟着 `GithubSummary` 的声明顺序走 */
const GOLDEN_ENVELOPE_DONE =
  '{"taskId":"github-0","summary":{"pulled":1,"pushed":2,"cancelled":false,"stateSaved":true,"elapsedMs":1234}}'
/** 同一条的第三条 */
const GOLDEN_ENVELOPE_FAILED = '{"taskId":"github-0","error":{"kind":"directory","message":"配置与打开的目录不一致"}}'
/** 对照 `冲突清单把三边的_sha_都给出来` */
const GOLDEN_CONFLICT =
  '{"kind":"conflict","message":"有 1 个整理文件需要你决定，这次同步一个字节都没写：a.md（两边都改过）。处理完再点一次同步。","conflicts":[{"path":"a.md","base":"1","local":"2","remote":"3","kind":"both_changed"}]}'

const envelopeOf = <T>(golden: string): { payload: T } => ({ payload: JSON.parse(golden) as T })

let callbacks: Record<string, (event: { payload: unknown }) => void>
let unlistens: Record<string, Mock>

beforeEach(() => {
  tauriEvent.listen.mockReset()
  tauriCore.invoke.mockReset()
  callbacks = {}
  unlistens = {}
  tauriEvent.listen.mockImplementation(async (name, cb) => {
    callbacks[name] = cb
    const off = vi.fn()
    unlistens[name] = off
    return off
  })
})

/** 第 n 次 `invoke` 收到的参数对象。把「可选入参 + `noUncheckedIndexedAccess`」收在一处 */
function sentArgs(call = 0): Record<string, unknown> {
  const args = tauriCore.invoke.mock.calls[call]?.[1]
  if (!args) throw new Error(`第 ${call} 次 invoke 没有带参数对象`)
  return args
}

describe('跨语言契约：事件名、命令名、参数名', () => {
  it('三个事件名与 Rust 侧 lib.rs 的三个常量是同一批字面量', () => {
    // 名字对不上的失败方式是**安静的**：没人监听 Tauri 也不报错，前端只是永远收不到
    // 进度与 done，界面上停在「同步中… 0/0」，而后台其实一个一个文件在拉/推
    expect(GITHUB_PROGRESS_EVENT).toBe('vela://github-progress')
    expect(GITHUB_DONE_EVENT).toBe('vela://github-done')
    expect(GITHUB_FAILED_EVENT).toBe('vela://github-failed')
  })

  it('挂监听器时用的就是这三个名字，一个不多一个不少', async () => {
    await attachGithubListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    expect(tauriEvent.listen.mock.calls.map((c) => c[0]).sort()).toEqual(
      [GITHUB_PROGRESS_EVENT, GITHUB_DONE_EVENT, GITHUB_FAILED_EVENT].sort(),
    )
  })

  it('⚠️ 三个 listen 是一起发出去的，不是逐个 await', async () => {
    // 与搜索、微信读书同一条竞态：注册之前到达的事件永久丢失。串行 await 让
    // 「progress 挂上了而 done 还没挂上」变成一个真实的窗口
    tauriEvent.listen.mockImplementationOnce(() => new Promise(() => {}))
    const pending = attachGithubListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    await Promise.resolve()
    expect(tauriEvent.listen).toHaveBeenCalledTimes(3)
    void pending // 按设计不会结束
  })

  it('返回的注销函数一次注销掉三个', async () => {
    const off = await attachGithubListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    off()
    for (const name of [GITHUB_PROGRESS_EVENT, GITHUB_DONE_EVENT, GITHUB_FAILED_EVENT]) {
      expect(unlistens[name]).toHaveBeenCalledOnce()
    }
  })

  it('命令名是 github_sync_dir，参数只有 dir 一个', async () => {
    tauriCore.invoke.mockResolvedValue('github-0')
    await expect(startGithubSync('/Users/xuanke/Document/readbook')).resolves.toBe('github-0')
    expect(tauriCore.invoke).toHaveBeenCalledWith('github_sync_dir', { dir: '/Users/xuanke/Document/readbook' })
  })

  it('🔴 参数名恰好一个：前端传不了写盘目标、仓库地址与 token', async () => {
    tauriCore.invoke.mockResolvedValue('github-0')
    await startGithubSync('/repo')
    // 真正读写的是用户全局配置里的 `syncLocalDir` / `githubRepo` 与钥匙串里的 token，
    // `dir` 只用来核对。这个口子一开，WebView 就能决定往哪个目录写、往哪个仓库推
    expect(Object.keys(sentArgs())).toEqual(['dir'])
  })

  it('前端不剥尾斜杠：canonicalize 是 Rust 那一侧的唯一口径', async () => {
    tauriCore.invoke.mockResolvedValue('github-0')
    await startGithubSync('/Users/xuanke/Document/readbook/')
    expect(sentArgs().dir).toBe('/Users/xuanke/Document/readbook/')
  })
})

describe('载荷形状', () => {
  it('进度信封是 taskId + progress，单位是文件', async () => {
    const onProgress = vi.fn()
    await attachGithubListeners({ onProgress, onDone: () => {}, onFailed: () => {} })
    const event = envelopeOf<{ taskId: string; progress: unknown }>(GOLDEN_ENVELOPE_PROGRESS)
    expect(Object.keys(event.payload)).toEqual(['taskId', 'progress'])
    expect(event.payload.progress).toEqual({ filesDone: 2, filesTotal: 7 })
    // 第一份进度一定带 filesDone = 0（Rust 侧算完计划先发一次）。`filesTotal` 拼错时
    // 那句「同步中… 0/undefined」就是唯一的线索
    expect(JSON.stringify(event.payload.progress)).toBe('{"filesDone":2,"filesTotal":7}')
  })

  it('总账信封的五个字段名与顺序与 Rust 侧一致', () => {
    const parsed = JSON.parse(GOLDEN_ENVELOPE_DONE) as {
      summary: Record<string, unknown>
    }
    expect(Object.keys(parsed.summary)).toEqual(['pulled', 'pushed', 'cancelled', 'stateSaved', 'elapsedMs'])
    // `cancelled` 是取消时唯一要说的一件事：取消也走 done，没有另一条终止事件
    expect(parsed.summary.cancelled).toBe(false)
    // state 没写成不算同步失败，但界面将来要能说出「这次只是没记住 base」
    expect(parsed.summary.stateSaved).toBe(true)
  })

  it('失败信封是 taskId + error，十三个变体在契约上各有其名', () => {
    const parsed = JSON.parse(GOLDEN_ENVELOPE_FAILED) as { error: GithubError }
    expect(Object.keys(parsed)).toEqual(['taskId', 'error'])
    expect(JSON.stringify(parsed.error)).toBe('{"kind":"directory","message":"配置与打开的目录不一致"}')

    // 穷举就是这条测试的全部内容：Rust 侧加了变体而前端没跟上，这里会少一行。
    // 顺序与 `GithubError` 的声明顺序一致
    const cases: [GithubError, string][] = [
      [
        { kind: 'not_configured', message: 'GitHub 的 token 还没填。' },
        '{"kind":"not_configured","message":"GitHub 的 token 还没填。"}',
      ],
      [
        { kind: 'keychain', message: '钥匙串操作失败（-25300）。' },
        '{"kind":"keychain","message":"钥匙串操作失败（-25300）。"}',
      ],
      [
        { kind: 'directory', message: '配置与打开的目录不一致' },
        '{"kind":"directory","message":"配置与打开的目录不一致"}',
      ],
      [{ kind: 'repo', message: '仓库地址看不懂' }, '{"kind":"repo","message":"仓库地址看不懂"}'],
      [
        { kind: 'network', reason: 'Timeout', message: '30 秒内没等到' },
        '{"kind":"network","reason":"Timeout","message":"30 秒内没等到"}',
      ],
      [{ kind: 'auth', message: 'HTTP 401：Bad credentials' }, '{"kind":"auth","message":"HTTP 401：Bad credentials"}'],
      [
        { kind: 'branch_not_found', message: 'main 与 master 都不存在' },
        '{"kind":"branch_not_found","message":"main 与 master 都不存在"}',
      ],
      [{ kind: 'non_fast_forward', message: 'HTTP 422' }, '{"kind":"non_fast_forward","message":"HTTP 422"}'],
      [
        { kind: 'conflict', message: '有 1 个整理文件需要你决定', conflicts: [] },
        '{"kind":"conflict","message":"有 1 个整理文件需要你决定","conflicts":[]}',
      ],
      [{ kind: 'api', message: 'HTTP 500' }, '{"kind":"api","message":"HTTP 500"}'],
      [{ kind: 'shape', message: 'tree 被截断' }, '{"kind":"shape","message":"tree 被截断"}'],
      [{ kind: 'local_changed', message: 'a.md' }, '{"kind":"local_changed","message":"a.md"}'],
      [{ kind: 'storage', message: 'io' }, '{"kind":"storage","message":"io"}'],
    ]
    for (const [error, golden] of cases) {
      expect(JSON.stringify(error)).toBe(golden)
    }
    expect(cases.map(([e]) => e.kind)).toEqual([
      'not_configured',
      'keychain',
      'directory',
      'repo',
      'network',
      'auth',
      'branch_not_found',
      'non_fast_forward',
      'conflict',
      'api',
      'shape',
      'local_changed',
      'storage',
    ])
    // ⚠️ 只有 `network` 多一个 `reason`（给程序分支的分类），`conflict` 多一个
    // `conflicts`（三份 sha 的清单）。其余十一个变体装的就是那句话本身
  })

  it('冲突那条的完整形状：三份 sha 与机器名 kind', () => {
    const error = JSON.parse(GOLDEN_CONFLICT) as GithubError
    expect(error.kind).toBe('conflict')
    if (error.kind !== 'conflict') throw new Error('应当解析成 conflict')
    expect(error.conflicts).toEqual([{ path: 'a.md', base: '1', local: '2', remote: '3', kind: 'both_changed' }])
    // ⚠️ `kind` 是机器名，⛔ 不要直接贴给用户看；中文那句在 `message` 里
    expect(JSON.stringify(error)).toBe(GOLDEN_CONFLICT)
  })
})

describe('事件分发：信封拆开来交给对应的那个 handler', () => {
  it('progress 把 taskId 与 progress 分开递过去', async () => {
    const onProgress = vi.fn()
    await attachGithubListeners({ onProgress, onDone: () => {}, onFailed: () => {} })
    const event = envelopeOf<{ taskId: string; progress: unknown }>(GOLDEN_ENVELOPE_PROGRESS)
    callbacks[GITHUB_PROGRESS_EVENT]!(event)
    expect(onProgress).toHaveBeenCalledWith('github-0', { filesDone: 2, filesTotal: 7 })
    // 第一份进度是 0/N：`filesDone = 0` 必须**到达**，不能在这一层当成「没有进度」丢掉
  })

  it('done 把 summary 递给 onDone', async () => {
    const onDone = vi.fn()
    await attachGithubListeners({ onProgress: () => {}, onDone, onFailed: () => {} })
    const event = envelopeOf<{ taskId: string; summary: unknown }>(GOLDEN_ENVELOPE_DONE)
    callbacks[GITHUB_DONE_EVENT]!(event)
    expect(onDone).toHaveBeenCalledWith('github-0', event.payload.summary)
  })

  it('failed 把 error 递给 onFailed，原样不动', async () => {
    const onFailed = vi.fn()
    await attachGithubListeners({ onProgress: () => {}, onDone: () => {}, onFailed })
    const event = envelopeOf<{ taskId: string; error: unknown }>(GOLDEN_ENVELOPE_FAILED)
    callbacks[GITHUB_FAILED_EVENT]!(event)
    expect(onFailed).toHaveBeenCalledWith('github-0', event.payload.error)
    expect(event.payload.error).toEqual({ kind: 'directory', message: '配置与打开的目录不一致' })
  })
})

describe('错误落地成人能读的话', () => {
  it('每个变体都直接用 Rust 侧给的 message，一个字都不重写', () => {
    const errors: GithubError[] = [
      { kind: 'not_configured', message: 'GitHub 的 token 还没填。' },
      { kind: 'keychain', message: '钥匙串操作失败（-25300）。' },
      { kind: 'directory', message: '/Users/me/notes 与设置不一致' },
      { kind: 'repo', message: '仓库地址看不懂' },
      { kind: 'network', reason: 'Connect', message: '连不上 api.github.com。检查网络与代理设置。' },
      { kind: 'auth', message: 'HTTP 401：Bad credentials' },
      { kind: 'branch_not_found', message: 'main 与 master 都不存在，先去建一个' },
      { kind: 'non_fast_forward', message: 'HTTP 422：远端在这期间又动了' },
      { kind: 'conflict', message: '有 2 个整理文件需要你决定，这次同步一个字节都没写。', conflicts: [] },
      { kind: 'api', message: 'HTTP 500' },
      { kind: 'shape', message: 'tree 被截断' },
      { kind: 'local_changed', message: 'a.md 在比对之后又被改了' },
      { kind: 'storage', message: '/Users/me/notes 写不进去' },
    ]
    for (const err of errors) {
      // Rust 侧那几句话是按用户处境写好的，这一层再包一层只会把它说糊；
      // `network` 必须取 message 而不是 reason——后者是给程序看的 `Connect`
      expect(describeGithubError(err)).toBe(err.message)
    }
  })

  it('将来加了变体、只要它还带 kind 与 message 就照样能显示', () => {
    expect(describeGithubError({ kind: 'brand_new_variant', message: '新的一句人话' })).toBe('新的一句人话')
  })

  it('不是 IPC 错误时退回 Error / 字符串', () => {
    expect(describeGithubError(new Error('网络断了'))).toBe('网络断了')
    expect(describeGithubError('字符串错误')).toBe('字符串错误')
    expect(describeGithubError(null)).toBe('null')
    // 有 message 没 kind：不是我们的错误形状，不猜
    expect(describeGithubError({ message: 'x' })).toBe('[object Object]')
  })
})
