import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * 前后端「线上契约」的前端快照——替换那一半。
 *
 * Rust 侧的对照分两处，两边的字面量必须同时改：
 *
 * - `crates/vela-core/tests/wire_contract.rs` 的「M2-D 全局替换」那一节
 *   （`替换载荷的线上形状` / `替换请求的线上形状` / `真实替换与真实预览在线上对得上`）
 * - `src-tauri/src/commands.rs` 的 `三个替换事件载荷的线上形状`（信封那一层）
 *   与 `替换请求从命令边界上解析进来`
 * - 事件名本身：`src-tauri/src/lib.rs` 的 `replace_events_match_frontend`
 *
 * ⚠️ 这一份的分量比 `search.test.ts` 重一档：搜索的契约漂了最坏是界面显示错，
 * 替换的契约漂了漂的可能是**「哪些文件被拒了」那几个计数器**。
 * 字段名写错的话前端读到 `undefined`，用户看到的是「全部替换完成」，
 * 而磁盘上有几个文件一个字节都没动——控制台一行错都没有。
 */

/**
 * ⚠️ 两个 mock 都写了完整的函数签名，不是裸 `vi.fn()`。
 * 裸的话 `.mock.calls` 的元素是 `any`，于是每一处取值都是一次 unsafe member access——
 * `pnpm lint` 是门禁的一部分，这里过不了就提交不了。
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
  attachReplaceListeners,
  startReplace,
  REPLACE_DONE_EVENT,
  REPLACE_FAILED_EVENT,
  REPLACE_PROGRESS_EVENT,
  type ReplaceDonePayload,
  type ReplaceFailedPayload,
  type ReplaceProgress,
  type ReplaceProgressPayload,
  type ReplaceSummary,
} from './replace'

// ───────────────────────── 黄金字面量 ─────────────────────────
// 每一条都与 Rust 侧某个 assert_eq! 里的字符串逐字节相同

/** 对照 `替换载荷的线上形状` */
const GOLDEN_PROGRESS = '{"filesScanned":12,"filesChanged":3,"replacements":7}'
const GOLDEN_SUMMARY =
  '{"filesScanned":120,"filesChanged":3,"replacements":7,"skippedBinary":1,"skippedLossy":2,"skippedUnmappable":0,"skippedTooLarge":4,"skippedOpen":1,"unreadable":2,"writeFailed":0,"truncated":false,"cancelled":true,"elapsedMs":45}'

/**
 * 对照 `三个替换事件载荷的线上形状`：外面还套了一层 `taskId` 信封。
 *
 * ⚠️ 每一条都写成**完整字面量**，不从内层拼出来。拼出来的话下面那条
 * 「信封 == taskId 加上内层」的断言就成了自己等自己；写成两份独立的字面量，
 * 它才真的在核对 `wire_contract.rs` 与 `commands.rs` 两个文件有没有分岔
 */
const GOLDEN_ENVELOPE_PROGRESS =
  '{"taskId":"replace-7","progress":{"filesScanned":12,"filesChanged":3,"replacements":7}}'
const GOLDEN_ENVELOPE_DONE = `{"taskId":"replace-7","summary":${GOLDEN_SUMMARY}}`
const GOLDEN_BAD_REPLACEMENT = '{"kind":"bad_replacement","message":"缺少替换内容：replace 不能为 null"}'
const GOLDEN_ENVELOPE_FAILED = `{"taskId":"replace-7","error":${GOLDEN_BAD_REPLACEMENT}}`

/**
 * `listen` 的回调收到的东西。从黄金字面量解析而不是手搓对象：手搓的话
 * 「字面量与 Rust 一致」和「回调收到的是这个对象」就成了两件互不相干的事，
 * 中间那一步可以悄悄断开
 */
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

describe('跨语言契约：事件名', () => {
  it('三个事件名与 Rust 侧 lib.rs 的三个常量是同一批字面量', () => {
    // 对照 src-tauri/src/lib.rs 的 `replace_events_match_frontend`。
    // ⚠️ `REPLACE_DONE` 拼错的后果比搜索那边重一档：界面永远停在「正在替换…」，
    // 而磁盘上的文件**已经全改完了**。用户很可能再按一次替换
    expect(REPLACE_PROGRESS_EVENT).toBe('vela://replace-progress')
    expect(REPLACE_DONE_EVENT).toBe('vela://replace-done')
    expect(REPLACE_FAILED_EVENT).toBe('vela://replace-failed')
  })

  it('⚠️ 三个名字与搜索那三个互不相同', async () => {
    // 两组监听器是**同时挂着**的（见 `attachReplaceListeners` 的文档）。
    // 名字撞了的话一次搜索的 done 会跑进替换的 handler，反之亦然——
    // 而两边的 summary 字段名完全不同，于是前端读到一堆 `undefined`
    const { SEARCH_BATCH_EVENT, SEARCH_DONE_EVENT, SEARCH_FAILED_EVENT } = await import('./search')
    const search = [SEARCH_BATCH_EVENT, SEARCH_DONE_EVENT, SEARCH_FAILED_EVENT]
    const replace = [REPLACE_PROGRESS_EVENT, REPLACE_DONE_EVENT, REPLACE_FAILED_EVENT]
    for (const name of replace) expect(search).not.toContain(name)
  })

  it('挂监听器时用的就是这三个名字，一个不多一个不少', async () => {
    await attachReplaceListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    expect(tauriEvent.listen.mock.calls.map((c) => c[0]).sort()).toEqual(
      [REPLACE_PROGRESS_EVENT, REPLACE_DONE_EVENT, REPLACE_FAILED_EVENT].sort(),
    )
  })

  it('⚠️ 三个 listen 是一起发出去的，不是逐个 await', async () => {
    // 逐个 await 的失败方式很隐蔽：第一个 listen 还没落地的时候替换就结束了，
    // 于是「progress 挂上了而 done 没挂上」那个窗口里的终止信号永久丢失，
    // 界面上一直转圈而磁盘已经改完。这里让第一个 listen 永远不 resolve，
    // 断言另外两个照样被调用了——那就是 `Promise.all` 与「串行 await」的可观察区别
    tauriEvent.listen.mockImplementationOnce(() => new Promise(() => {}))
    const pending = attachReplaceListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    await Promise.resolve()
    expect(tauriEvent.listen).toHaveBeenCalledTimes(3)
    void pending // 刻意不 await：它按设计不会结束
  })

  it('返回的注销函数一次注销掉三个', async () => {
    const off = await attachReplaceListeners({ onProgress: () => {}, onDone: () => {}, onFailed: () => {} })
    off()
    for (const name of [REPLACE_PROGRESS_EVENT, REPLACE_DONE_EVENT, REPLACE_FAILED_EVENT]) {
      expect(unlistens[name]).toHaveBeenCalledOnce()
    }
  })
})

describe('Rust → 前端 的字段名', () => {
  it('ReplaceProgress 的三个字段名与顺序与 Rust 侧一致', () => {
    const parsed = JSON.parse(GOLDEN_PROGRESS) as ReplaceProgress
    expect(JSON.stringify(parsed)).toBe(GOLDEN_PROGRESS)
    expect(Object.keys(parsed)).toEqual(['filesScanned', 'filesChanged', 'replacements'])
    // ⚠️ 这三个都是**累计**值。当成增量累加的话，一次替换会显示成
    // 「已改三百个文件」而实际只有三个
    expect(parsed.filesChanged).toBe(3)
  })

  it('⚠️ ReplaceSummary 的十三个字段一个都不能少', () => {
    const parsed = JSON.parse(GOLDEN_SUMMARY) as ReplaceSummary
    expect(JSON.stringify(parsed)).toBe(GOLDEN_SUMMARY)
    expect(Object.keys(parsed)).toEqual([
      'filesScanned',
      'filesChanged',
      'replacements',
      'skippedBinary',
      'skippedLossy',
      'skippedUnmappable',
      'skippedTooLarge',
      'skippedOpen',
      'unreadable',
      'writeFailed',
      'truncated',
      'cancelled',
      'elapsedMs',
    ])
    // 那七个 `skipped*` / `*failed` 是「落盘那一层把每个不确定都倒向不写」这件事
    // **唯一的对外出口**。少一个，那类拒绝就从用户眼前彻底消失了，
    // 而 Rust 侧的测试照样全绿——所以这里穷举，而不是只挑几个断言
    expect(parsed.skippedBinary).toBe(1)
    expect(parsed.skippedLossy).toBe(2)
    expect(parsed.skippedUnmappable).toBe(0)
    expect(parsed.skippedTooLarge).toBe(4)
    expect(parsed.skippedOpen).toBe(1)
    expect(parsed.unreadable).toBe(2)
    expect(parsed.writeFailed).toBe(0)
  })

  it('⚠️ 三个信封都只是把 taskId 与内层载荷并排放，不摊平', () => {
    const progress = JSON.parse(GOLDEN_ENVELOPE_PROGRESS) as ReplaceProgressPayload
    const done = JSON.parse(GOLDEN_ENVELOPE_DONE) as ReplaceDonePayload
    const failed = JSON.parse(GOLDEN_ENVELOPE_FAILED) as ReplaceFailedPayload

    expect(Object.keys(progress)).toEqual(['taskId', 'progress'])
    expect(Object.keys(done)).toEqual(['taskId', 'summary'])
    expect(Object.keys(failed)).toEqual(['taskId', 'error'])

    // 内层就是各自那一条黄金字面量本身——信封没有改动它包着的东西
    expect(JSON.stringify(progress.progress)).toBe(GOLDEN_PROGRESS)
    expect(JSON.stringify(done.summary)).toBe(GOLDEN_SUMMARY)
    expect(JSON.stringify(failed.error)).toBe(GOLDEN_BAD_REPLACEMENT)

    // 再钉一次「信封 == taskId 加上内层」这个组合关系。摊平成
    // `{ taskId, filesScanned, filesChanged, replacements }` 的话上面几条照样全过，
    // 而 Rust 发过来的 `payload.progress` 会是 undefined——
    // 于是进度条永远停在 0，而 done 一来数字突然跳到终值
    expect(JSON.stringify({ taskId: 'replace-7', progress: progress.progress })).toBe(GOLDEN_ENVELOPE_PROGRESS)
    expect(JSON.stringify({ taskId: 'replace-7', summary: done.summary })).toBe(GOLDEN_ENVELOPE_DONE)
    expect(JSON.stringify({ taskId: 'replace-7', error: failed.error })).toBe(GOLDEN_ENVELOPE_FAILED)
  })

  it('替换与搜索共用同一个 SearchError，bad_replacement 是替换独有的那一个', async () => {
    const { describeSearchError } = await import('./search')
    const failed = JSON.parse(GOLDEN_ENVELOPE_FAILED) as ReplaceFailedPayload
    // 没有 `describeReplaceError`：两边共用同一份编译（Rust 侧的 `check_root` + `compile`），
    // 坏正则/坏 glob/坏 root 三种拒法是同一套，多写一份等于多一处会分岔的地方
    expect(describeSearchError(failed.error)).toBe('缺少替换内容：replace 不能为 null')
  })
})

describe('事件分发：信封拆开来交给对应的那个 handler', () => {
  it('progress 事件把 taskId 与 progress 分开递给 onProgress', async () => {
    const onProgress = vi.fn()
    await attachReplaceListeners({ onProgress, onDone: () => {}, onFailed: () => {} })
    const event = envelopeOf<ReplaceProgressPayload>(GOLDEN_ENVELOPE_PROGRESS)
    callbacks[REPLACE_PROGRESS_EVENT]!(event)
    expect(onProgress).toHaveBeenCalledWith('replace-7', event.payload.progress)
  })

  it('done 事件把 summary 递给 onDone', async () => {
    const onDone = vi.fn()
    await attachReplaceListeners({ onProgress: () => {}, onDone, onFailed: () => {} })
    const event = envelopeOf<ReplaceDonePayload>(GOLDEN_ENVELOPE_DONE)
    callbacks[REPLACE_DONE_EVENT]!(event)
    expect(onDone).toHaveBeenCalledWith('replace-7', event.payload.summary)
  })

  it('failed 事件把 error 递给 onFailed', async () => {
    const onFailed = vi.fn()
    await attachReplaceListeners({ onProgress: () => {}, onDone: () => {}, onFailed })
    const event = envelopeOf<ReplaceFailedPayload>(GOLDEN_ENVELOPE_FAILED)
    callbacks[REPLACE_FAILED_EVENT]!(event)
    expect(onFailed).toHaveBeenCalledWith('replace-7', event.payload.error)
  })
})

describe('前端 → Rust 的 command 名与参数名', () => {
  it('start_replace 的参数是 roots 加一整个 request 对象', async () => {
    tauriCore.invoke.mockResolvedValue('replace-7')
    const query = { pattern: 'needle', replace: 'N' }
    const taskId = await startReplace(['/repo'], query, ['/repo/src/dirty.ts'])
    expect(taskId).toBe('replace-7')
    expect(tauriCore.invoke).toHaveBeenCalledWith('start_replace', {
      roots: ['/repo'],
      request: { query, skip: ['/repo/src/dirty.ts'] },
    })
    // ⚠️ `request` 是**内嵌**的，不是摊平成 `{ roots, query, skip }`。
    // 摊平的话 Rust 侧那句「invalid args `request` for command `start_replace`」
    // 至少还会报错；反过来要是 Rust 摊平而前端内嵌，前端拿到的是 undefined
  })

  it('⚠️ 多个根按传进去的顺序发出去，那一份顺序就是用户批准的那一份', async () => {
    tauriCore.invoke.mockResolvedValue('replace-1')
    await startReplace(['/repo/a', '/repo/b'], { pattern: 'needle', replace: 'N' })
    expect(sentArgs().roots).toEqual(['/repo/a', '/repo/b'])
    // 替换这一侧的顺序比搜索更要紧一档：`rootIndex` 只影响显示，而这里的顺序
    // 决定**哪些文件夹会被写**。落盘递的必须与预览那一次内容相同——
    // 保证它的是 `src/search/store.ts` 的 `previewKey` 指纹（根清单也在里面），
    // 工作区一变「替换全部」就灰掉。见 `replace.ts` 文件头最后那条 ⚠️
  })

  it('⚠️ 没有脏标签时 skip 这个 key 整个不发', async () => {
    tauriCore.invoke.mockResolvedValue('replace-1')
    await startReplace(['/repo'], { pattern: 'needle', replace: 'N' })
    const sent = sentArgs().request as Record<string, unknown>
    expect(Object.keys(sent)).toEqual(['query'])
    // 不主动补 `skip: []`：Rust 侧 `#[serde(default)]` 会落到「一个都不跳过」，
    // 与 `[]` 完全等价。替它补默认值等于把默认值抄两份，哪天那边改了这边就悄悄分岔。
    // 对照 `commands.rs` 的 `替换请求从命令边界上解析进来`
  })

  it('空数组也不发 skip，与不传等价', async () => {
    tauriCore.invoke.mockResolvedValue('replace-1')
    await startReplace(['/repo'], { pattern: 'needle', replace: 'N' }, [])
    expect(Object.keys(sentArgs().request as Record<string, unknown>)).toEqual(['query'])
  })

  it('⚠️ replace 为空字符串时照样发出去，那是「删掉」', async () => {
    tauriCore.invoke.mockResolvedValue('replace-1')
    await startReplace(['/repo'], { pattern: 'needle', replace: '' })
    const sent = (sentArgs().request as { query: Record<string, unknown> }).query
    expect(sent.replace).toBe('')
    // 真值判断（`if (query.replace)`）会把「删掉」悄悄变成「不替换」，
    // 而 Rust 侧对 `replace: None` 是**报错**的——所以那种写法连报错都看不到，
    // 用户看到的是「我填了空、按了替换、什么都没发生」
    expect('replace' in sent).toBe(true)
  })

  it('query 原样递过去，前端不补任何默认值', async () => {
    tauriCore.invoke.mockResolvedValue('replace-1')
    await startReplace(['/repo'], { pattern: 'needle', replace: 'N' })
    const sent = sentArgs().request as { query: Record<string, unknown> }
    expect(Object.keys(sent.query)).toEqual(['pattern', 'replace'])
  })
})
