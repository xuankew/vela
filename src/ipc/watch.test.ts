import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * 前后端「线上契约」的前端快照——文件监听那一半（M2-G）。
 *
 * Rust 侧的对照分三处，三处的字面量必须同时改：
 *
 * - `src-tauri/src/watcher.rs` 的 `监听总账的线上形状` 与 `文件改动载荷的线上形状`
 * - `crates/vela-core/tests/wire_contract.rs` 的 `file_change_是两个小写单词`
 * - 事件名本身：`src-tauri/src/lib.rs` 的 `file_changed_event_matches_frontend`
 *
 * ⚠️ 这一份钉的是**全 Vela 最安静的失败方式**。搜索的契约漂了界面会显示错，
 * 替换的契约漂了那几个计数器会读不到；而这一份漂了的话，事件照样送到、
 * `listen` 照样回调，只是前端认不出 `kind`——于是「外部改了文件而 Vela 一声不吭」，
 * 用户下一次 ⌘S 把别人的改动盖掉，而控制台一行错都没有。
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
  FILE_CHANGED_EVENT,
  listenFileChanged,
  setWatched,
  type FileChangeKind,
  type FileChangedPayload,
  type WatchStats,
} from './watch'

// ───────────────────────── 黄金字面量 ─────────────────────────
// 每一条都与 Rust 侧某个 assert_eq! 里的字符串逐字节相同

/** 对照 `监听总账的线上形状` */
const GOLDEN_STATS = '{"dirs":3,"files":5,"failed":1,"skipped":2,"truncated":false}'
/** 对照 `文件改动载荷的线上形状` */
const GOLDEN_CHANGED = '{"path":"/repo/a.txt","kind":"changed"}'
const GOLDEN_REMOVED = '{"path":"/repo/a.txt","kind":"removed"}'

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
  it('事件名与 Rust 侧 lib.rs 的那个常量是同一个字面量', () => {
    // 对照 src-tauri/src/lib.rs 的 `file_changed_event_matches_frontend`
    expect(FILE_CHANGED_EVENT).toBe('vela://file-changed')
  })

  it('⚠️ 与其余七个事件名互不相同', async () => {
    // 四组监听器是**同时挂着**的（见 `listenFileChanged` 的文档）。
    // 名字撞了的话一条文件改动会跑进搜索的 handler，反之亦然——
    // 而两边的载荷字段完全不同，于是前端读到一堆 `undefined`
    const { SEARCH_BATCH_EVENT, SEARCH_DONE_EVENT, SEARCH_FAILED_EVENT } = await import('./search')
    const { REPLACE_PROGRESS_EVENT, REPLACE_DONE_EVENT, REPLACE_FAILED_EVENT } = await import('./replace')
    const { REQUEST_CLOSE_EVENT } = await import('./windowClose')
    const others = [
      SEARCH_BATCH_EVENT,
      SEARCH_DONE_EVENT,
      SEARCH_FAILED_EVENT,
      REPLACE_PROGRESS_EVENT,
      REPLACE_DONE_EVENT,
      REPLACE_FAILED_EVENT,
      REQUEST_CLOSE_EVENT,
    ]
    expect(others).not.toContain(FILE_CHANGED_EVENT)
  })

  it('挂监听器时用的就是这一个名字', async () => {
    await listenFileChanged(() => {})
    expect(tauriEvent.listen.mock.calls.map((c) => c[0])).toEqual([FILE_CHANGED_EVENT])
  })

  it('返回的注销函数注销掉的就是它', async () => {
    const off = await listenFileChanged(() => {})
    off()
    expect(unlistens[FILE_CHANGED_EVENT]).toHaveBeenCalledOnce()
  })
})

describe('Rust → 前端 的字段名', () => {
  it('⚠️ WatchStats 的五个字段名与顺序与 Rust 侧一致', () => {
    const parsed = JSON.parse(GOLDEN_STATS) as WatchStats
    expect(JSON.stringify(parsed)).toBe(GOLDEN_STATS)
    expect(Object.keys(parsed)).toEqual(['dirs', 'files', 'failed', 'skipped', 'truncated'])
    expect(parsed.dirs).toBe(3)
    expect(parsed.files).toBe(5)
  })

  it('⚠️ 那三个「Vela 没在盯它」的数字要能被读出来', () => {
    // `failed` / `skipped` / `truncated` 是「某个文件外部改了而 Vela 没吭声」
    // 与「Vela 压根没在盯它」这两件事**唯一的分界线**。
    // 名字漂成 undefined 的话下面三条会变成 `expect(undefined).toBe(1)` 那样一眼能看出，
    // 而真正危险的是「字段在、但前端没人读」——那一条只能在 UI 层钉
    const parsed = JSON.parse(GOLDEN_STATS) as WatchStats
    expect(parsed.failed).toBe(1)
    expect(parsed.skipped).toBe(2)
    expect(parsed.truncated).toBe(false)
  })

  it('⚠️ 载荷只有 path 与 kind 两个字段，没有信封', () => {
    // 与搜索/替换那三个不同：这一条不是「一次操作的进度」，没有 taskId、
    // 也没有终止信号。摊平在这里不是取舍，是它本来的形状
    const changed = JSON.parse(GOLDEN_CHANGED) as FileChangedPayload
    const removed = JSON.parse(GOLDEN_REMOVED) as FileChangedPayload
    expect(Object.keys(changed)).toEqual(['path', 'kind'])
    expect(Object.keys(removed)).toEqual(['path', 'kind'])
    expect(changed.path).toBe('/repo/a.txt')
  })

  it('⚠️ kind 是两个**小写**单词', () => {
    // 对照 `file_change_是两个小写单词`。
    // 🔴 serde 对一个无字段枚举的默认写法是 `"Changed"`，而 Rust 侧那个
    // `#[serde(rename_all = "camelCase")]` 就是这一条契约的全部实现——
    // 谁把它删了，两边各自的测试都会红，但**运行时**一声不吭
    const kinds: FileChangeKind[] = ['changed', 'removed']
    expect(kinds).toContain((JSON.parse(GOLDEN_CHANGED) as FileChangedPayload).kind)
    expect(kinds).toContain((JSON.parse(GOLDEN_REMOVED) as FileChangedPayload).kind)
    expect(GOLDEN_CHANGED).toContain('"changed"')
    expect(GOLDEN_REMOVED).toContain('"removed"')
  })
})

describe('事件分发', () => {
  it('回调收到的是 payload 本体', async () => {
    // 从黄金字面量解析而不是手搓对象：手搓的话「字面量与 Rust 一致」和
    // 「回调收到的是这个对象」就成了两件互不相干的事，中间那一步可以悄悄断开
    const got: FileChangedPayload[] = []
    await listenFileChanged((change) => got.push(change))

    callbacks[FILE_CHANGED_EVENT]?.({ payload: JSON.parse(GOLDEN_CHANGED) })
    callbacks[FILE_CHANGED_EVENT]?.({ payload: JSON.parse(GOLDEN_REMOVED) })

    expect(got).toEqual([
      { path: '/repo/a.txt', kind: 'changed' },
      { path: '/repo/a.txt', kind: 'removed' },
    ])
  })

  it('同一个文件的 changed 与 removed 都会送上来，不去重也不合并', async () => {
    // 「建了又删」在 debouncer 那儿可能被合并掉，也可能漏出两条。
    // 这一层**刻意不做任何合并**：两条各自的含义都是清楚的
    // （「内容变了」与「文件没了」），而合并要在知道标签脏不脏之后才做得对，
    // 那是 `src/doc/fileWatch.ts` 的事
    const got: FileChangeKind[] = []
    await listenFileChanged((change) => got.push(change.kind))

    callbacks[FILE_CHANGED_EVENT]?.({ payload: JSON.parse(GOLDEN_CHANGED) })
    callbacks[FILE_CHANGED_EVENT]?.({ payload: JSON.parse(GOLDEN_REMOVED) })
    callbacks[FILE_CHANGED_EVENT]?.({ payload: JSON.parse(GOLDEN_CHANGED) })

    expect(got).toEqual(['changed', 'removed', 'changed'])
  })
})

describe('前端 → Rust 的命令边界', () => {
  it('命令名与参数名', async () => {
    tauriCore.invoke.mockResolvedValue(JSON.parse(GOLDEN_STATS))
    const stats = await setWatched(['/repo/a.txt'])

    expect(tauriCore.invoke.mock.calls[0]?.[0]).toBe('set_watched')
    expect(sentArgs()).toEqual({ paths: ['/repo/a.txt'] })
    // 返回值原样透传，不补默认值、不改字段名
    expect(JSON.stringify(stats)).toBe(GOLDEN_STATS)
  })

  it('⚠️ 路径**原样**递过去，一个字符都不动', async () => {
    // Rust 侧自己 canonicalize 去订阅，同时把原样字符串记进过滤器，
    // 事件回来时给的还是原样那一份。前端要是先 normalize 一遍，
    // 「递什么就收到什么」这条就断了——而断掉的失败方式是**匹配不上任何标签**，
    // 也就是彻底静默。所以这一条钉的是「不许动」，不是「动得对」
    tauriCore.invoke.mockResolvedValue(JSON.parse(GOLDEN_STATS))
    const paths = ['/tmp/a.txt', '/repo/./b.txt', 'relative/c.txt', '/repo/ünïcode.txt']
    await setWatched(paths)

    expect(sentArgs()['paths']).toEqual(paths)
  })

  it('⚠️ 空数组照样发出去，那是「把监听整个关掉」', async () => {
    // 替它省掉这次调用的后果是：关掉最后一个标签之后 Rust 还盯着那个目录，
    // 而过滤器表也还留着那个文件——于是外部改一个已经关掉的标签，
    // 前端收到一条它不认得的事件
    tauriCore.invoke.mockResolvedValue(JSON.parse('{"dirs":0,"files":0,"failed":0,"skipped":0,"truncated":false}'))
    const stats = await setWatched([])

    expect(tauriCore.invoke).toHaveBeenCalledOnce()
    expect(sentArgs()).toEqual({ paths: [] })
    expect(stats.dirs).toBe(0)
  })

  it('递进去的是数组而不是一个字符串', async () => {
    // `paths` 收的是**完整清单**。写成单数（一次一个路径）的话，
    // Rust 侧那份「上一次的计划」就永远是「最后一个」，
    // 而 diff 会每次都得出「全变了」——每开一个标签就重订一遍所有目录
    tauriCore.invoke.mockResolvedValue(JSON.parse(GOLDEN_STATS))
    await setWatched(['/repo/a.txt', '/repo/b.txt'])

    const sent = sentArgs()['paths']
    expect(Array.isArray(sent)).toBe(true)
    expect(sent).toHaveLength(2)
  })
})
