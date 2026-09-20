import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * 前后端「线上契约」的前端快照。搜索的契约比 fs / project 更容易漂：它一次要走
 * **五个**类型，而且其中四个是通过 event 推过去的，不是命令的返回值——Tauri 对
 * event payload 不做任何参数校验，所以字段名写错的失败方式连一句「invalid args」
 * 都没有，前端只是收到一堆 `undefined`。
 *
 * Rust 侧的对照分两处，两边的字面量必须同时改：
 *
 * - `crates/vela-core/tests/wire_contract.rs` 的「M2-C 全文搜索」那一节
 *   （`search_query_的线上形状` / `搜索结果的线上形状` / `search_error_的五个变体在契约上各有其名`）
 * - `src-tauri/src/commands.rs` 的 `三个搜索事件载荷的线上形状`（信封那一层，
 *   里面还顺带钉了替换模式下 `replaced` 上线时的信封形状）
 * - 事件名本身：`src-tauri/src/lib.rs` 的 `search_events_match_frontend`
 *
 * ⚠️ 取消不在这个文件里测：M2-D 之后搜索与替换共用同一个 `cancel_task` 命令，
 * 它的前端封装与快照在 `src/ipc/task.ts` / `task.test.ts`。
 * 替换那一半（`start_replace` 与三个 `vela://replace-*`）在 `replace.test.ts`
 */

/**
 * ⚠️ 两个 mock 都写了完整的函数签名，不是裸 `vi.fn()`。
 * 裸的话 `.mock.calls` 的元素是 `any`，于是每一处 `calls[0][1].query` 都是一次
 * unsafe member access——`pnpm lint` 是门禁的一部分，这里过不了就提交不了。
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
  attachSearchListeners,
  describeSearchError,
  startSearch,
  SEARCH_BATCH_EVENT,
  SEARCH_DONE_EVENT,
  SEARCH_FAILED_EVENT,
  type SearchBatch,
  type SearchBatchPayload,
  type SearchDonePayload,
  type SearchError,
  type SearchFailedPayload,
  type SearchFile,
  type SearchHit,
  type SearchQuery,
  type SearchSummary,
  type MatchRange,
} from './search'

// ───────────────────────── 黄金字面量 ─────────────────────────
// 每一条都与 Rust 侧某个 assert_eq! 里的字符串逐字节相同

/** 对照 `search_query_的线上形状` */
const GOLDEN_QUERY =
  '{"pattern":"foo","literal":true,"caseSensitive":true,"wholeWord":false,"include":["*.ts"],"exclude":[],"replace":"bar"}'
/**
 * 同一个测试里的第二条：Rust 侧**序列化**一个默认 query 时 `replace` 上线的是 `null`，
 * 不是缺席。⚠️ 前端从来不发这个 key（靠 `#[serde(default)]` 落到 `None`），
 * 所以这一条对前端只有阅读价值——它把「`null` 与缺 key 在 Rust 侧是同一个意思」
 * 写在这儿，免得哪天有人在前端补一句 `replace: null` 时以为自己在做一件新的事
 */
const GOLDEN_QUERY_DEFAULT =
  '{"pattern":"foo","literal":false,"caseSensitive":false,"wholeWord":false,"include":[],"exclude":[],"replace":null}'

/** 对照 `搜索结果的线上形状` */
const GOLDEN_MATCH_RANGE = '{"start":4,"end":10}'
const GOLDEN_HIT = '{"line":12,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"truncated":false}'
/**
 * 替换模式下才上线的那一条：`replaced` 夹在 `ranges` 与 `truncated` 之间，
 * 跟着 Rust 侧的字段声明顺序走
 */
const GOLDEN_HIT_REPLACED =
  '{"line":12,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"replaced":"let a = haystack;","truncated":false}'
/**
 * ⚠️ `replaced` 为空串时**照样上线**：那是「把命中的地方删掉」这个合法操作。
 * 它要是被跳过去，前端读到 `undefined`，那一行会安静地退回成纯搜索的样子，
 * 而用户以为自己刚刚预览了一次删除
 */
const GOLDEN_HIT_DELETED = '{"line":1,"text":"needle","ranges":[],"replaced":"","truncated":false}'
const GOLDEN_FILE = '{"rel":"src/main.rs","path":"/repo/src/main.rs","rootIndex":0,"hits":[],"truncated":true}'
/** ⚠️ `files` 为空的这一个不是「没有结果」，是一次**心跳** */
const GOLDEN_HEARTBEAT = '{"files":[],"filesScanned":512}'
const GOLDEN_BATCH =
  '{"files":[{"rel":"b.md","path":"/repo/b.md","rootIndex":0,"hits":[{"line":1,"text":"needle","ranges":[{"start":0,"end":6}],"truncated":false}],"truncated":false}],"filesScanned":3}'
const GOLDEN_SUMMARY =
  '{"filesScanned":120,"filesWithHits":3,"hits":7,"skippedTooLarge":1,"unreadable":2,"truncated":false,"cancelled":true,"elapsedMs":45}'

/**
 * 对照 `三个搜索事件载荷的线上形状`：外面还套了一层 `taskId` 信封。
 *
 * ⚠️ 每一条都写成**完整字面量**，不从内层拼出来。拼出来的话下面那条
 * 「信封 == taskId 加上内层」的断言就成了自己等自己；写成两份独立的字面量，
 * 它才真的在核对 `wire_contract.rs` 与 `commands.rs` 两个文件有没有分岔。
 * 注意内层的批次与上面 `GOLDEN_BATCH` **不是同一条**（那边是 `b.md`，这边是 `src/a.ts`），
 * 与 Rust 侧两个测试各自的字面量一一对应
 */
const GOLDEN_ENVELOPE_INNER_BATCH =
  '{"files":[{"rel":"src/a.ts","path":"/repo/src/a.ts","rootIndex":0,"hits":[{"line":3,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"truncated":false}],"truncated":false}],"filesScanned":3}'
const GOLDEN_ENVELOPE_BATCH =
  '{"taskId":"search-7","batch":{"files":[{"rel":"src/a.ts","path":"/repo/src/a.ts","rootIndex":0,"hits":[{"line":3,"text":"let a = needle;","ranges":[{"start":8,"end":14}],"truncated":false}],"truncated":false}],"filesScanned":3}}'
const GOLDEN_ENVELOPE_HEARTBEAT = '{"taskId":"search-7","batch":{"files":[],"filesScanned":512}}'
const GOLDEN_ENVELOPE_DONE =
  '{"taskId":"search-7","summary":{"filesScanned":120,"filesWithHits":3,"hits":7,"skippedTooLarge":1,"unreadable":2,"truncated":false,"cancelled":true,"elapsedMs":45}}'
const GOLDEN_NOT_FOUND = '{"kind":"not_found","path":"/repo"}'
const GOLDEN_ENVELOPE_FAILED = '{"taskId":"search-7","error":{"kind":"not_found","path":"/repo"}}'

/**
 * `listen` 的回调收到的东西。Tauri 的事件对象上除了 `payload` 还有 `event` / `id`，
 * 但前端只读 `payload`，所以测试也只造 `payload`——多造字段等于假装我们依赖了它们。
 *
 * 从黄金字面量解析而不是手搓对象：手搓的话「字面量与 Rust 一致」和「回调收到的是这个
 * 对象」就成了两件互不相干的事，中间那一步可以悄悄断开
 */
const envelopeOf = <T>(golden: string): { payload: T } => ({ payload: JSON.parse(golden) as T })

/** 按事件名把 `listen` 注册到的回调抓出来，供后面手动触发 */
let callbacks: Record<string, (event: { payload: unknown }) => void>
/** 三个 listen 各自返回的注销函数，用来断言「一次注销掉三个」 */
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

describe('跨语言契约：事件名与命令名', () => {
  it('三个事件名与 Rust 侧 lib.rs 的三个常量是同一批字面量', () => {
    // 对照 src-tauri/src/lib.rs 的 `search_events_match_frontend`。
    // 名字对不上的失败方式是**安静的**：Tauri 不会因为没人监听而报错，
    // 前端只会一个结果都收不到，而 done 也永远不来，界面上就一直是「搜索中…」
    expect(SEARCH_BATCH_EVENT).toBe('vela://search-batch')
    expect(SEARCH_DONE_EVENT).toBe('vela://search-done')
    expect(SEARCH_FAILED_EVENT).toBe('vela://search-failed')
  })

  it('挂监听器时用的就是这三个名字，一个不多一个不少', async () => {
    await attachSearchListeners({ onBatch: () => {}, onDone: () => {}, onFailed: () => {} })
    expect(tauriEvent.listen.mock.calls.map((c) => c[0]).sort()).toEqual(
      [SEARCH_BATCH_EVENT, SEARCH_DONE_EVENT, SEARCH_FAILED_EVENT].sort(),
    )
  })

  it('⚠️ 三个 listen 是一起发出去的，不是逐个 await', async () => {
    // 逐个 await 的失败方式很隐蔽：第一个 listen 还没落地的时候搜索就结束了，
    // 于是「batch 挂上了而 done 没挂上」那个窗口里的终止信号永久丢失，
    // 界面上一直转圈。这里让第一个 listen 永远不 resolve，
    // 断言另外两个照样被调用了——那就是 `Promise.all` 与「串行 await」的可观察区别
    tauriEvent.listen.mockImplementationOnce(() => new Promise(() => {}))
    const pending = attachSearchListeners({ onBatch: () => {}, onDone: () => {}, onFailed: () => {} })
    await Promise.resolve()
    expect(tauriEvent.listen).toHaveBeenCalledTimes(3)
    void pending // 刻意不 await：它按设计不会结束
  })

  it('返回的注销函数一次注销掉三个', async () => {
    const off = await attachSearchListeners({ onBatch: () => {}, onDone: () => {}, onFailed: () => {} })
    off()
    for (const name of [SEARCH_BATCH_EVENT, SEARCH_DONE_EVENT, SEARCH_FAILED_EVENT]) {
      expect(unlistens[name]).toHaveBeenCalledOnce()
    }
  })
})

describe('Rust → 前端 的字段名', () => {
  it('SearchQuery 的七个字段名与顺序与 Rust 侧序列化结果一致', () => {
    const parsed = JSON.parse(GOLDEN_QUERY) as Required<SearchQuery>
    // 键顺序就是 JSON.parse 的插入顺序，所以 stringify 相等 == 字段集合与顺序都相等
    expect(JSON.stringify(parsed)).toBe(GOLDEN_QUERY)
    expect(Object.keys(parsed)).toEqual([
      'pattern',
      'literal',
      'caseSensitive',
      'wholeWord',
      'include',
      'exclude',
      'replace',
    ])
    // `caseSensitive` 是最容易写成 `case_sensitive` 的一个。写错的失败方式是**静默的**：
    // Rust 侧 `#[serde(default)]` 会安静地拿到 false，于是「我明明勾了区分大小写」
    // 变成「结果里全是不想要的东西」，控制台一行错都没有
    expect(parsed.caseSensitive).toBe(true)
    expect(parsed.wholeWord).toBe(false)
    // ⚠️ `replace` 是最末一个，M2-D 加的。它写错的失败方式比上面那个更贵：
    // Rust 侧落到 `None`，于是「预览」面板照常出结果（纯搜索也是这条路），
    // 只是每处命中都不带 `replaced`，而点「替换全部」会被 preflight 拒成
    // `bad_replacement`——用户看到的是「明明搜到了却换不了」
    expect(parsed.replace).toBe('bar')
  })

  it('Rust 侧序列化默认 query 时 replace 是 null 而不是缺席', () => {
    const parsed = JSON.parse(GOLDEN_QUERY_DEFAULT) as SearchQuery
    expect(JSON.stringify(parsed)).toBe(GOLDEN_QUERY_DEFAULT)
    expect(parsed.replace ?? null).toBeNull()
    // 前端不发这个 key（见下面 `只填搜索词时只发 pattern 这一个 key`），
    // 所以这一条对前端只是阅读材料：它把「null 与缺 key 在 Rust 侧同义」写在这儿
  })

  it('命中那一层的四个类型字段都在', () => {
    const range = JSON.parse(GOLDEN_MATCH_RANGE) as MatchRange
    expect(Object.keys(range)).toEqual(['start', 'end'])
    expect(range).toEqual({ start: 4, end: 10 })

    const hit = JSON.parse(GOLDEN_HIT) as SearchHit
    expect(Object.keys(hit)).toEqual(['line', 'text', 'ranges', 'truncated'])
    expect(hit.line).toBe(12)
    expect(hit.text).toBe('let a = needle;')
    expect(hit.ranges).toEqual([{ start: 8, end: 14 }])
    // 偏移量数的是 UTF-16 码元，也就是 `String.prototype.slice` 用的那套。
    // 这一条把「可以直接切、不用先换算」钉成可执行的：切出来正好是 `needle`
    for (const r of hit.ranges) {
      expect(hit.text.slice(r.start, r.end)).toBe('needle')
    }
    // ⚠️ 纯搜索时 `replaced` **整个 key 都不在**（Rust 侧挂了 `skip_serializing_if`）。
    // 判它必须用 `'replaced' in hit` 或 `=== undefined`，不能用真值判断——
    // 下一段那个空串预览在真值判断下与「纯搜索」长得一模一样
    expect('replaced' in hit).toBe(false)

    const file = JSON.parse(GOLDEN_FILE) as SearchFile
    expect(JSON.stringify(file)).toBe(GOLDEN_FILE)
    expect(Object.keys(file)).toEqual(['rel', 'path', 'rootIndex', 'hits', 'truncated'])
    expect(file.rel).toBe('src/main.rs')
    expect(file.path).toBe('/repo/src/main.rs')
    // ⚠️ `rootIndex` 在 `path` **后面**、`hits` 前面，跟着 Rust 侧的字段声明顺序走。
    // 它写错名字的失败方式与上面 `caseSensitive` 那条一样安静——前端读到 `undefined`，
    // 于是每一行都被算成第 0 个根，多根工作区里点结果打开的是另一个根里的同名文件。
    // 而且它**没有** `skip_serializing_if`，所以「单根时缺席」这种情况不存在
    expect(file.rootIndex).toBe(0)
  })

  it('替换模式下 replaced 夹在 ranges 与 truncated 之间', () => {
    const hit = JSON.parse(GOLDEN_HIT_REPLACED) as SearchHit
    expect(JSON.stringify(hit)).toBe(GOLDEN_HIT_REPLACED)
    expect(Object.keys(hit)).toEqual(['line', 'text', 'ranges', 'replaced', 'truncated'])
    expect(hit.replaced).toBe('let a = haystack;')

    // ⚠️ `ranges` 数的是 `text` 里的位置，**不是** `replaced` 里的。
    // 拿它去切 `replaced` 会安静地切错：`haystack` 在 `replaced` 里是 8..16，
    // 而 ranges 说的是 8..14，于是切出来是半个词。替换之后长度会变，
    // 这一条错的话高亮会画在错的地方，而且只在「替换串比原串长/短」时才看得出来
    expect(hit.text.slice(8, 14)).toBe('needle')
    expect(hit.replaced?.slice(8, 14)).toBe('haysta')
    expect(hit.replaced?.slice(8, 16)).toBe('haystack')
  })

  it('⚠️ 替换成空串时 replaced 照样上线，那是「删掉」而不是「没预览」', () => {
    const hit = JSON.parse(GOLDEN_HIT_DELETED) as SearchHit
    expect(JSON.stringify(hit)).toBe(GOLDEN_HIT_DELETED)
    expect(hit.replaced).toBe('')
    expect('replaced' in hit).toBe(true)
    // 与上面那条纯搜索的 `'replaced' in hit === false` 合起来才是完整的两句话：
    // 「这一行没被预览过」与「这一行预览的结果是删光」在契约上是两种东西
  })

  it('⚠️ SearchBatch 上那个累计计数叫 filesScanned，不是 files_scanned', () => {
    const heartbeat = JSON.parse(GOLDEN_HEARTBEAT) as SearchBatch
    expect(Object.keys(heartbeat)).toEqual(['files', 'filesScanned'])
    expect(heartbeat.files).toEqual([])
    expect(heartbeat.filesScanned).toBe(512)

    const full = JSON.parse(GOLDEN_BATCH) as SearchBatch
    expect(JSON.stringify(full)).toBe(GOLDEN_BATCH)
    expect(full.files).toHaveLength(1)
    expect(full.filesScanned).toBe(3)
    // 写错这一个字母的失败方式是**进度条永远停在 0**（`undefined` 参与运算得 NaN），
    // 而结果列表照常出东西，所以看起来「搜索是好的，就是没有进度」
  })

  it('心跳与结果批在契约上是同一个形状，区分它们的只有 files 空不空', () => {
    const heartbeat = JSON.parse(GOLDEN_HEARTBEAT) as SearchBatch
    const full = JSON.parse(GOLDEN_BATCH) as SearchBatch
    expect(Object.keys(heartbeat)).toEqual(Object.keys(full))
    // 这不是巧合而是刻意的：多加一个 `isHeartbeat` 字段就等于引入一个可以与
    // `files.length` 互相矛盾的真相来源。前端的规则只有一条——files 为空时只更新进度
    expect(heartbeat.files).toHaveLength(0)
    expect(full.files.length).toBeGreaterThan(0)
  })

  it('SearchSummary 的八个字段名与顺序与 Rust 侧一致', () => {
    const parsed = JSON.parse(GOLDEN_SUMMARY) as SearchSummary
    expect(JSON.stringify(parsed)).toBe(GOLDEN_SUMMARY)
    expect(Object.keys(parsed)).toEqual([
      'filesScanned',
      'filesWithHits',
      'hits',
      'skippedTooLarge',
      'unreadable',
      'truncated',
      'cancelled',
      'elapsedMs',
    ])
    // 「太大而跳过」与「想读而读不动」必须是两个数：前者是我们主动的决定，
    // 后者意味着「没找到」可能是假的。合成一个数的话这两句话就说不出来了
    expect(parsed.skippedTooLarge).toBe(1)
    expect(parsed.unreadable).toBe(2)
  })

  it('五个错误变体在契约上各有其名', () => {
    // 穷举就是这条测试的全部内容：Rust 侧加了变体而前端没跟上，这里会少一行。
    // 顺序与 Rust 侧 `search_error_的五个变体在契约上各有其名` 一一对应
    const cases: [SearchError, string][] = [
      [{ kind: 'bad_pattern', message: '搜索词不能为空' }, '{"kind":"bad_pattern","message":"搜索词不能为空"}'],
      [{ kind: 'bad_glob', glob: '[', message: '炸了' }, '{"kind":"bad_glob","glob":"[","message":"炸了"}'],
      [
        { kind: 'bad_replacement', message: '认不出 $x 这种写法' },
        '{"kind":"bad_replacement","message":"认不出 $x 这种写法"}',
      ],
      [{ kind: 'bad_root', path: 'repo' }, '{"kind":"bad_root","path":"repo"}'],
      [{ kind: 'not_found', path: '/repo' }, '{"kind":"not_found","path":"/repo"}'],
    ]
    for (const [error, golden] of cases) {
      expect(JSON.stringify(error)).toBe(golden)
    }
    expect(cases.map(([e]) => e.kind)).toEqual(['bad_pattern', 'bad_glob', 'bad_replacement', 'bad_root', 'not_found'])
    // ⚠️ `bad_replacement` 与 `bad_pattern` 是**两个 kind 而不是一个**（M2-D 加的）：
    // 前端要把出错的那个输入框标红，而搜索词框与替换框是两个框。
    // 合成一个的话界面上只能说「你填的东西不对」
    //
    // ⚠️ 这里**没有 `io`**，与 `TreeError` 的七个变体不同：遍历途中读不动某个文件
    // 不是「搜索失败」，它计入 `SearchSummary.unreadable` 而搜索继续。
    // 于是「这次搜索失败了」与「这次搜索有几个文件没读成」在契约上就是两种东西
  })

  it('三个信封都只是把 taskId 与内层载荷并排放，不摊平', async () => {
    const batch = JSON.parse(GOLDEN_ENVELOPE_BATCH) as SearchBatchPayload
    const heartbeat = JSON.parse(GOLDEN_ENVELOPE_HEARTBEAT) as SearchBatchPayload
    const done = JSON.parse(GOLDEN_ENVELOPE_DONE) as SearchDonePayload
    const failed = JSON.parse(GOLDEN_ENVELOPE_FAILED) as SearchFailedPayload

    expect(Object.keys(batch)).toEqual(['taskId', 'batch'])
    expect(Object.keys(heartbeat)).toEqual(['taskId', 'batch'])
    expect(Object.keys(done)).toEqual(['taskId', 'summary'])
    expect(Object.keys(failed)).toEqual(['taskId', 'error'])

    // 内层就是各自那一条黄金字面量本身——信封没有改动它包着的东西
    expect(JSON.stringify(batch.batch)).toBe(GOLDEN_ENVELOPE_INNER_BATCH)
    expect(JSON.stringify(heartbeat.batch)).toBe(GOLDEN_HEARTBEAT)
    expect(JSON.stringify(done.summary)).toBe(GOLDEN_SUMMARY)
    expect(JSON.stringify(failed.error)).toBe(GOLDEN_NOT_FOUND)

    // 再钉一次「信封 == taskId 加上内层」这个组合关系。上面那几条只说了内层没被改动，
    // 这一条说的是外面那一层的键名与嵌套位置：摊平成 `{ taskId, files, filesScanned }`
    // 的话上面几条照样全过，而 Rust 发过来的 `payload.batch` 会是 undefined
    expect(JSON.stringify({ taskId: 'search-7', batch: batch.batch })).toBe(GOLDEN_ENVELOPE_BATCH)
    expect(JSON.stringify({ taskId: 'search-7', batch: heartbeat.batch })).toBe(GOLDEN_ENVELOPE_HEARTBEAT)
    expect(JSON.stringify({ taskId: 'search-7', summary: done.summary })).toBe(GOLDEN_ENVELOPE_DONE)
    expect(JSON.stringify({ taskId: 'search-7', error: failed.error })).toBe(GOLDEN_ENVELOPE_FAILED)
  })
})

describe('事件分发：信封拆开来交给对应的那个 handler', () => {
  it('batch 事件把 taskId 与 batch 分开递给 onBatch', async () => {
    const onBatch = vi.fn()
    await attachSearchListeners({ onBatch, onDone: () => {}, onFailed: () => {} })
    const event = envelopeOf<SearchBatchPayload>(GOLDEN_ENVELOPE_BATCH)
    callbacks[SEARCH_BATCH_EVENT]!(event)
    expect(onBatch).toHaveBeenCalledWith('search-7', event.payload.batch)
  })

  it('⚠️ 心跳也走 onBatch，而且原样递过去——不在这一层被过滤掉', async () => {
    const onBatch = vi.fn()
    await attachSearchListeners({ onBatch, onDone: () => {}, onFailed: () => {} })
    callbacks[SEARCH_BATCH_EVENT]!(envelopeOf<SearchBatchPayload>(GOLDEN_ENVELOPE_HEARTBEAT))
    expect(onBatch).toHaveBeenCalledWith('search-7', { files: [], filesScanned: 512 })
    // 在这一层「帮忙」把空批次丢掉是很自然的一个念头，但那样调用方就再也分不清
    // 「后台还在跑，只是没命中」与「一个事件都没来过」了——那正是心跳要解决的问题。
    // 判断留给 UI：它才知道进度条该怎么画
  })

  it('done 事件把 summary 递给 onDone', async () => {
    const onDone = vi.fn()
    await attachSearchListeners({ onBatch: () => {}, onDone, onFailed: () => {} })
    const event = envelopeOf<SearchDonePayload>(GOLDEN_ENVELOPE_DONE)
    callbacks[SEARCH_DONE_EVENT]!(event)
    expect(onDone).toHaveBeenCalledWith('search-7', event.payload.summary)
  })

  it('failed 事件把 error 递给 onFailed', async () => {
    const onFailed = vi.fn()
    await attachSearchListeners({ onBatch: () => {}, onDone: () => {}, onFailed })
    const event = envelopeOf<SearchFailedPayload>(GOLDEN_ENVELOPE_FAILED)
    callbacks[SEARCH_FAILED_EVENT]!(event)
    expect(onFailed).toHaveBeenCalledWith('search-7', event.payload.error)
    expect(event.payload.error).toEqual({ kind: 'not_found', path: '/repo' })
  })
})

describe('前端 → Rust 的 command 名与参数名', () => {
  it('start_search 的 query 整个对象原样递过去，字段名就是黄金字面量里那一套', async () => {
    tauriCore.invoke.mockResolvedValue('search-7')
    const query = JSON.parse(GOLDEN_QUERY) as SearchQuery
    const taskId = await startSearch(['/repo'], query)
    expect(taskId).toBe('search-7')
    expect(tauriCore.invoke).toHaveBeenCalledWith('start_search', { roots: ['/repo'], query })
    // 发出去的字节与 Rust 侧序列化出来的字节相同，这才是「两边对得上」的强说法
    expect(JSON.stringify(sentArgs().query)).toBe(GOLDEN_QUERY)
  })

  it('只填搜索词时只发 pattern 这一个 key，其余六个交给 Rust 侧的默认值', async () => {
    tauriCore.invoke.mockResolvedValue('search-1')
    await startSearch(['/repo'], { pattern: 'needle' })
    const sent = sentArgs().query as Record<string, unknown>
    expect(Object.keys(sent)).toEqual(['pattern'])
    // 不主动补 `literal: false` 之类：Rust 侧容器上有 `#[serde(default)]`，
    // 由 `只发_pattern_的搜索条件也能解析` 钉住。前端替它补默认值等于把默认值抄两份，
    // 哪天 Rust 侧改了默认，两边就悄悄分岔了
    //
    // ⚠️ M2-D 之后这一条还多担一件事：**不发 `replace` 这个 key == 纯搜索**。
    // 补成 `replace: ''` 的话那是一次「把每处命中都删掉」的合法请求，
    // 而两个值在 Rust 侧只差一个 `Option` 的默认实现
    expect('replace' in sent).toBe(false)
  })

  // 取消不在这个文件里：M2-D 之后搜索与替换共用 `cancel_task` 一个命令，
  // 它的参数名（`taskId`，本项目第二个多单词命令参数）由 `src/ipc/task.test.ts` 钉住

  it('⚠️ roots 永远是数组，单根时也是长度为 1 的数组', async () => {
    tauriCore.invoke.mockResolvedValue('search-1')
    await startSearch(['/Users/xuanke/repo'], { pattern: 'needle' })
    expect(sentArgs().roots).toEqual(['/Users/xuanke/repo'])
    // 参数名是**复数**的 `roots`，M2-F 起改的。写成 `root` 的失败方式是一句
    // Tauri 的「invalid args」，还算好查；而递一个字符串过去（`roots: '/repo'`）
    // 在 Rust 侧是 `Vec<String>` 反序列化失败，也是一句报错——两条都不安静，
    // 所以这里钉的是**前端封装自己不把数组降级成字符串**这一条
  })

  it('多个根按传进去的顺序发出去，顺序就是 rootIndex 的语义', async () => {
    tauriCore.invoke.mockResolvedValue('search-1')
    await startSearch(['/repo/a', '/repo/b'], { pattern: 'needle' })
    expect(sentArgs().roots).toEqual(['/repo/a', '/repo/b'])
    // ⚠️ 顺序不是无关紧要的：Rust 侧 `search_roots` 按下标给 `SearchFile.root_index`
    // 盖章，而前端拿 `roots[rootIndex]` 去显示「这一条来自哪个文件夹」。
    // 前端要是在发之前排个序（或去重时打乱了顺序），面板上写着 A 根、
    // 而结果其实来自 B 根——两边各自都「看起来对」
  })

  it('⚠️ 空数组照样发出去，不拦也不补默认值', async () => {
    tauriCore.invoke.mockResolvedValue('search-1')
    await startSearch([], { pattern: 'needle' })
    expect(sentArgs().roots).toEqual([])
    // Rust 侧把 `roots: []` 当**合法**输入，回的是一份全零的 summary 而不是错误
    // （少一个错误变体，前端的分支表就少一行）。「没有打开文件夹」这句话
    // 由 UI 自己说：`src/search/store.ts` 的 `search()` 在发之前就拦掉了
  })
})

describe('错误落地成人能读的话', () => {
  it('bad_pattern 直接用 Rust 侧给的 message', () => {
    expect(describeSearchError({ kind: 'bad_pattern', message: '搜索词不能为空' })).toBe('搜索词不能为空')
    // 搜索词是用户打的，Rust 侧那句已经是中文的人话，再包一层只会把它说糊
  })

  it('bad_glob 点名是哪一条通配，并带上原因', () => {
    const text = describeSearchError({ kind: 'bad_glob', glob: '[', message: '炸了' })
    expect(text).toContain('"["')
    expect(text).toContain('炸了')
    expect(text).toContain('通配')
    // 必须点名：`include` 里可以有好几条，只说「通配写错了」等于让用户挨个试
  })

  it('⚠️ 通配是空字符串时那句话仍然有主语', () => {
    const text = describeSearchError({ kind: 'bad_glob', glob: '', message: '炸了' })
    expect(text.startsWith('""')).toBe(true)
    // 直接内插会得到「 不是合法的通配：炸了」——一句没有主语的话，看着像文案坏了
  })

  it('bad_replacement 也直接用 Rust 侧给的 message', () => {
    expect(describeSearchError({ kind: 'bad_replacement', message: '认不出 $x 这种写法' })).toBe('认不出 $x 这种写法')
    // 与 `bad_pattern` 同一条道理：替换模板也是用户打的，Rust 侧那句已经是人话。
    // ⚠️ 而且这一条**不能**被包成「替换内容不能为空」之类——空串是合法的删除操作，
    // Rust 侧只拒 `null`（前端不发 key）与编不出来的 `$` 转义
  })

  it('not_found 是用户的处境，不说「内部错误」', () => {
    const text = describeSearchError({ kind: 'not_found', path: '/Volumes/外接盘/repo' })
    expect(text).toContain('/Volumes/外接盘/repo')
    expect(text).toContain('找不到')
    expect(text).not.toContain('内部错误')
    // 与 `TreeError.escape` 刻意不同：打开的文件夹在外接盘上、盘被拔了，
    // 这是**真的会发生**的用户处境，不是我们的 bug
  })

  it('bad_root 说成内部错误，不伪装成用户的处境', () => {
    const text = describeSearchError({ kind: 'bad_root', path: 'repo' })
    expect(text).toContain('内部错误')
    expect(text).toContain('"repo"')
    // root 只可能来自 dialog，前端没有任何输入框能填它，所以走到这里就是我们的 bug
  })

  it('Rust 侧将来加了变体而前端没跟上时，不会抛', () => {
    expect(describeSearchError({ kind: 'brand_new_variant' })).toBe('[object Object]')
  })

  it('不是 IPC 错误时退回 Error / 字符串', () => {
    expect(describeSearchError(new Error('网络断了'))).toBe('网络断了')
    expect(describeSearchError('字符串错误')).toBe('字符串错误')
    expect(describeSearchError(null)).toBe('null')
  })
})
