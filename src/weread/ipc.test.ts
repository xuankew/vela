import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * 微信读书全量同步的「线上契约」前端快照（M8-6a）。
 *
 * Rust 侧的对照分两处：
 *
 * - `src-tauri/src/weread.rs` 的 `进度与终止事件的_json_形状被钉住`（三个信封）、
 *   `内核的三种失败原样搬过来` 与 `另外三种失败的_json_形状被钉住`（错误变体）
 * - `src-tauri/src/lib.rs` 的 `..._events_match_frontend`（三个事件名）
 *
 * 两边各手写一份，没有代码生成。字段名拼错的失败方式与搜索那边同一档安静：
 * Tauri 对 event payload 不做校验，前端只是收到一堆 `undefined`，
 * 而 `{ booksDone: undefined, booksTotal: undefined }` 画出来是「同步中… 0/0」。
 *
 * ⚠️ `cancel_task` 不在这个文件里：它与搜索、替换共用 `src/ipc/task.ts`，
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
  attachWereadListeners,
  describeWereadError,
  startWereadSync,
  WEREAD_DONE_EVENT,
  WEREAD_FAILED_EVENT,
  WEREAD_PROGRESS_EVENT,
  type WereadError,
} from './ipc'

// ───────────────────────── 黄金字面量 ─────────────────────────
// 每条都与 Rust 侧某个 assert_eq! 里的字符串逐字节相同

/** 对照 `进度与终止事件的_json_形状被钉住` 的第一条 */
const GOLDEN_ENVELOPE_PROGRESS = '{"taskId":"weread-0","progress":{"booksDone":2,"booksTotal":7}}'
/** 同一条的第二条。字段顺序跟着 `WereadSummary` 的声明顺序走 */
const GOLDEN_ENVELOPE_DONE =
  '{"taskId":"weread-0","summary":{"booksTotal":3,"booksWritten":2,"booksSkipped":1,"marks":176,"reviews":4,"cancelled":false,"elapsedMs":1234}}'
/** 同一条的第三条 */
const GOLDEN_ENVELOPE_FAILED = '{"taskId":"weread-0","error":{"kind":"directory","message":"配置与打开的目录不一致"}}'

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
    // 进度与 done，界面上停在「同步中… 0/0」，而后台其实一本一本在写盘
    expect(WEREAD_PROGRESS_EVENT).toBe('vela://weread-progress')
    expect(WEREAD_DONE_EVENT).toBe('vela://weread-done')
    expect(WEREAD_FAILED_EVENT).toBe('vela://weread-failed')
  })

  it('挂监听器时用的就是这三个名字，一个不多一个不少', async () => {
    await attachWereadListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    expect(tauriEvent.listen.mock.calls.map((c) => c[0]).sort()).toEqual(
      [WEREAD_PROGRESS_EVENT, WEREAD_DONE_EVENT, WEREAD_FAILED_EVENT].sort(),
    )
  })

  it('⚠️ 三个 listen 是一起发出去的，不是逐个 await', async () => {
    // 与搜索同一条竞态：注册之前到达的事件永久丢失。串行 await 让「progress 挂上了
    // 而 done 还没挂上」变成一个真实的窗口，落进去的终止信号会让界面一直转圈。
    // 这里让第一个 listen 永远不 resolve，断言另外两个照样被调用
    tauriEvent.listen.mockImplementationOnce(() => new Promise(() => {}))
    const pending = attachWereadListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    await Promise.resolve()
    expect(tauriEvent.listen).toHaveBeenCalledTimes(3)
    void pending // 按设计不会结束
  })

  it('返回的注销函数一次注销掉三个', async () => {
    const off = await attachWereadListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    off()
    for (const name of [WEREAD_PROGRESS_EVENT, WEREAD_DONE_EVENT, WEREAD_FAILED_EVENT]) {
      expect(unlistens[name]).toHaveBeenCalledOnce()
    }
  })

  it('命令名是 weread_sync_dir，参数只有 dir 一个', async () => {
    tauriCore.invoke.mockResolvedValue('weread-0')
    await expect(startWereadSync('/Users/xuanke/Document/readbook')).resolves.toBe('weread-0')
    expect(tauriCore.invoke).toHaveBeenCalledWith('weread_sync_dir', { dir: '/Users/xuanke/Document/readbook' })
  })

  it('🔴 参数名恰好一个：前端传不了写盘目标', async () => {
    tauriCore.invoke.mockResolvedValue('weread-0')
    await startWereadSync('/repo')
    // 真正写盘的是用户全局配置里的 `wereadLocalDir`，`dir` 只用来核对。
    // 这个口子一开，WebView 就能决定往哪个目录写几十个文件——Rust 侧那条
    // canonicalize 预检也就白设了
    expect(Object.keys(sentArgs())).toEqual(['dir'])
  })

  it('前端不剥尾斜杠：canonicalize 是 Rust 那一侧的唯一口径', async () => {
    tauriCore.invoke.mockResolvedValue('weread-0')
    await startWereadSync('/Users/xuanke/Document/readbook/')
    // 与 `src/ipc/weread.ts` 不 trim key 同一条：前端替它归一化，等于在 Rust 的
    // 路径比较之外再立一个口径，两边哪天对不上就是一个「明明是这个目录却说不是」
    expect(sentArgs().dir).toBe('/Users/xuanke/Document/readbook/')
  })
})

describe('载荷形状', () => {
  it('进度信封是 taskId + progress，单位是书', async () => {
    const onProgress = vi.fn()
    await attachWereadListeners({ onProgress, onDone: () => {}, onFailed: () => {} })
    const event = envelopeOf<{ taskId: string; progress: unknown }>(GOLDEN_ENVELOPE_PROGRESS)
    expect(Object.keys(event.payload)).toEqual(['taskId', 'progress'])
    expect(event.payload.progress).toEqual({ booksDone: 2, booksTotal: 7 })
    // 第一份进度一定带 booksDone = 0（Rust 侧列完书单先发一次）。前端拿它当
    // 「总数已知」的唯一来源，所以 `booksTotal` 拼错时那句「同步中… 0/undefined」
    // 就是唯一的线索
    expect(JSON.stringify(event.payload.progress)).toBe('{"booksDone":2,"booksTotal":7}')
  })

  it('总账信封的七个字段名与顺序与 Rust 侧一致', () => {
    const parsed = JSON.parse(GOLDEN_ENVELOPE_DONE) as {
      summary: Record<string, unknown>
    }
    expect(Object.keys(parsed.summary)).toEqual([
      'booksTotal',
      'booksWritten',
      'booksSkipped',
      'marks',
      'reviews',
      'cancelled',
      'elapsedMs',
    ])
    // `cancelled` 是取消时唯一要说的一件事：取消也走 done，没有另一条终止事件
    expect(parsed.summary.cancelled).toBe(false)
  })

  it('失败信封是 taskId + error，九个变体在契约上各有其名', () => {
    const parsed = JSON.parse(GOLDEN_ENVELOPE_FAILED) as { error: WereadError }
    expect(Object.keys(parsed)).toEqual(['taskId', 'error'])
    expect(JSON.stringify(parsed.error)).toBe('{"kind":"directory","message":"配置与打开的目录不一致"}')

    // 穷举就是这条测试的全部内容：Rust 侧加了变体而前端没跟上，这里会少一行。
    // 顺序与 `WereadError` 的声明顺序一致
    const cases: [WereadError, string][] = [
      [
        { kind: 'not_configured', message: '微信读书的 key 还没填。到「设置 → 微信读书」里填一次。' },
        '{"kind":"not_configured","message":"微信读书的 key 还没填。到「设置 → 微信读书」里填一次。"}',
      ],
      [
        { kind: 'keychain', message: '钥匙串操作失败（-25300）。' },
        '{"kind":"keychain","message":"钥匙串操作失败（-25300）。"}',
      ],
      [
        { kind: 'network', reason: 'Timeout', message: '30 秒内没等到' },
        '{"kind":"network","reason":"Timeout","message":"30 秒内没等到"}',
      ],
      [
        { kind: 'upgrade', message: '服务端要求升级 Skill：请升级到 1.0.6' },
        '{"kind":"upgrade","message":"服务端要求升级 Skill：请升级到 1.0.6"}',
      ],
      [
        { kind: 'api', message: '/user/notebooks HTTP 200 errcode=-2010 用户不存在' },
        '{"kind":"api","message":"/user/notebooks HTTP 200 errcode=-2010 用户不存在"}',
      ],
      [
        { kind: 'not_json', message: '/book/bookmarklist HTTP 502（回包不是 JSON）' },
        '{"kind":"not_json","message":"/book/bookmarklist HTTP 502（回包不是 JSON）"}',
      ],
      [
        { kind: 'directory', message: '配置与打开的目录不一致' },
        '{"kind":"directory","message":"配置与打开的目录不一致"}',
      ],
      [
        { kind: 'shape', message: '/user/notebooks 回包少了 bookId' },
        '{"kind":"shape","message":"/user/notebooks 回包少了 bookId"}',
      ],
      [
        { kind: 'storage', message: '/Users/me/notes 写不进去' },
        '{"kind":"storage","message":"/Users/me/notes 写不进去"}',
      ],
    ]
    for (const [error, golden] of cases) {
      expect(JSON.stringify(error)).toBe(golden)
    }
    expect(cases.map(([e]) => e.kind)).toEqual([
      'not_configured',
      'keychain',
      'network',
      'upgrade',
      'api',
      'not_json',
      'directory',
      'shape',
      'storage',
    ])
    // ⚠️ 只有 `network` 多一个 `reason`：它是给程序分支的分类（Timeout/Connect/…），
    // 显示给用户的一律是 `message`。其余八个变体装的就是那句话本身
  })
})

describe('事件分发：信封拆开来交给对应的那个 handler', () => {
  it('progress 把 taskId 与 progress 分开递过去', async () => {
    const onProgress = vi.fn()
    await attachWereadListeners({ onProgress, onDone: () => {}, onFailed: () => {} })
    const event = envelopeOf<{ taskId: string; progress: unknown }>(GOLDEN_ENVELOPE_PROGRESS)
    callbacks[WEREAD_PROGRESS_EVENT]!(event)
    expect(onProgress).toHaveBeenCalledWith('weread-0', { booksDone: 2, booksTotal: 7 })
    // 第一份进度是 0/N：`booksDone = 0` 必须**到达**，不能在这一层当成「没有进度」丢掉
  })

  it('done 把 summary 递给 onDone', async () => {
    const onDone = vi.fn()
    await attachWereadListeners({ onProgress: () => {}, onDone, onFailed: () => {} })
    const event = envelopeOf<{ taskId: string; summary: unknown }>(GOLDEN_ENVELOPE_DONE)
    callbacks[WEREAD_DONE_EVENT]!(event)
    expect(onDone).toHaveBeenCalledWith('weread-0', event.payload.summary)
  })

  it('failed 把 error 递给 onFailed，原样不动', async () => {
    const onFailed = vi.fn()
    await attachWereadListeners({ onProgress: () => {}, onDone: () => {}, onFailed })
    const event = envelopeOf<{ taskId: string; error: unknown }>(GOLDEN_ENVELOPE_FAILED)
    callbacks[WEREAD_FAILED_EVENT]!(event)
    expect(onFailed).toHaveBeenCalledWith('weread-0', event.payload.error)
    expect(event.payload.error).toEqual({ kind: 'directory', message: '配置与打开的目录不一致' })
  })
})

describe('错误落地成人能读的话', () => {
  it('每个变体都直接用 Rust 侧给的 message，一个字都不重写', () => {
    const errors: WereadError[] = [
      { kind: 'not_configured', message: '微信读书的 key 还没填。' },
      { kind: 'keychain', message: '钥匙串操作失败（-25300）。' },
      { kind: 'network', reason: 'Connect', message: '连不上 i.weread.qq.com。检查网络与代理设置。' },
      { kind: 'upgrade', message: '服务端要求升级 Skill：请升级到 1.0.6' },
      { kind: 'api', message: '/user/notebooks HTTP 200 errcode=-2010 用户不存在' },
      { kind: 'not_json', message: '/book/bookmarklist HTTP 502（回包不是 JSON）' },
      { kind: 'directory', message: '/Users/me/notes 与设置不一致' },
      { kind: 'shape', message: '/user/notebooks 回包少了 bookId' },
      { kind: 'storage', message: '/Users/me/notes 写不进去' },
    ]
    for (const err of errors) {
      // Rust 侧那几句话是按用户处境写好的（服务端 errmsg 也是中文人话），
      // 这一层再包一层只会把它说糊，而 `network` 必须取 message 而不是 reason——
      // 后者是给程序看的 `Connect`，给用户看等于什么也没说
      expect(describeWereadError(err)).toBe(err.message)
    }
  })

  it('将来加了变体、只要它还带 kind 与 message 就照样能显示', () => {
    expect(describeWereadError({ kind: 'brand_new_variant', message: '新的一句人话' })).toBe('新的一句人话')
  })

  it('不是 IPC 错误时退回 Error / 字符串', () => {
    // invoke 与事件载荷都是序列化后的对象，正常走不到这几格；兜底只是为了
    // 万一接了一条本地抛出的异常时界面上不是 `[object Object]`
    expect(describeWereadError(new Error('网络断了'))).toBe('网络断了')
    expect(describeWereadError('字符串错误')).toBe('字符串错误')
    expect(describeWereadError(null)).toBe('null')
    // 有 message 没 kind：不是我们的错误形状，不猜
    expect(describeWereadError({ message: 'x' })).toBe('[object Object]')
  })
})
