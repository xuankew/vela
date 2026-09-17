import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'solid-js'

/**
 * 搜索面板 store 的单测：异步与可变状态这一半。
 *
 * 结构性的部分（怎么摊成行、方向键落到哪、总账怎么措辞）在 `./rows.test.ts` 里钉过了，
 * 这里只测**什么时候去搜、推回来的批次放哪、哪些 taskId 该被丢掉**。
 *
 * 本文件最要紧的是「taskId 的认领与作废」那一组：`start_search` 先 spawn 后台线程再返回
 * taskId，所以**终止事件可能比 invoke 的返回值先到**。朴素写法（拿一根 `current` 指针比对）
 * 在那种时序下会把整次搜索的结果全丢掉，面板永远停在「正在搜索…」，而且没有任何报错可查。
 * 那几条用例就是用 deferred 把时序掰开来复现的。
 *
 * 假的是 `startSearch`、`cancelSearch` 与 `describeSearchError`——jsdom 里没有 Tauri 运行时。
 * ⚠️ 三个一个都不能少：`store.ts` 是按名字从这个模块导入它们的，少一个就在被调用那一刻变成
 * `undefined is not a function`，而 vitest 对「导入了但没调用」是不报错的。
 * `describeSearchError` 也一并假掉：它自己在 `src/ipc/search.test.ts` 里测过，
 * 这里只关心「错误有没有落到 `error` 上」。
 */

/**
 * ⚠️ 两个桩都写了完整的函数签名，不是裸 `vi.fn()`。
 * 裸的话 `.mock.calls` 的元素是 `any`，于是每一处 `calls[0][1].pattern` 都是一次
 * unsafe member access——`pnpm lint` 是门禁的一部分，这里过不了就提交不了。
 *
 * 签名里直接用 `SearchQuery` 是安全的：类型在编译时被擦掉，`vi.hoisted` 的工厂搬到
 * import 之前也不会引用到任何运行时值。
 */
const { ipc } = vi.hoisted(() => ({
  ipc: {
    startSearch: vi.fn<(root: string, query: SearchQuery) => Promise<string>>(),
    cancelSearch: vi.fn<(taskId: string) => Promise<void>>(),
    describeSearchError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
  },
}))

vi.mock('../ipc/search', () => ipc)

import type { MatchRange, SearchFile, SearchHit, SearchQuery, SearchSummary } from '../ipc/search'
import { createSearchPanel, type SearchPanel } from './store'
import type { HitRow } from './rows'

/**
 * 造一个「拒绝掉、且拒绝值是纯对象」的 promise。
 *
 * ⚠️ 这条 eslint 豁免是必需的，不是偷懒：Tauri 的 `invoke` 在 Rust 侧返回 `Err` 时，
 * 抛给前端的就是**序列化后的那个对象**，不是 `Error` 实例。`describeSearchError` 正是按
 * `{ kind, ... }` 去认它的。桩要是为了满足 lint 而改成 `new Error(...)`，
 * 这组测试就不再描述真实行为了——它们会全绿，而线上照样炸。
 */
function rejected<T>(payload: unknown): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 见上
  return Promise.reject(payload)
}

/** 一个能自己决定什么时候 settle 的 promise，用来把「事件先到 / 返回先到」两种时序分开 */
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

function hitOf(line: number, text: string): SearchHit {
  const ranges: MatchRange[] = [{ start: 0, end: text.length }]
  return { line, text, ranges, truncated: false }
}

/** `texts` 的第 n 条就是第 n+1 行——行号 1 起算，与 `SearchHit.line` 同一套 */
function fileOf(rel: string, texts: string[], truncated = false): SearchFile {
  return { rel, path: `/repo/${rel}`, hits: texts.map((t, i) => hitOf(i + 1, t)), truncated }
}

const GOLDEN_SUMMARY: SearchSummary = {
  filesScanned: 120,
  filesWithHits: 3,
  hits: 7,
  skippedTooLarge: 1,
  unreadable: 2,
  truncated: false,
  cancelled: true,
  elapsedMs: 45,
}

/** 一份「什么都没发生」的总账，按需覆盖。与 `rows.test.ts` 的黄金字面量字段一致 */
function sum(overrides: Partial<SearchSummary> = {}): SearchSummary {
  return {
    filesScanned: 120,
    filesWithHits: 3,
    hits: 7,
    skippedTooLarge: 0,
    unreadable: 0,
    truncated: false,
    cancelled: false,
    elapsedMs: 45,
    ...overrides,
  }
}

let root: string | null
let opened: HitRow[]
let panel: SearchPanel
/** `createSearchPanel` 里有两个 `createMemo`；不在 root 里建，它们永远不会被释放 */
let dispose: (() => void) | undefined

function mount() {
  opened = []
  dispose = createRoot((teardown) => {
    panel = createSearchPanel({ root: () => root, openHit: async (hit) => void opened.push(hit) })
    return teardown
  })
}

beforeEach(() => {
  ipc.startSearch.mockReset()
  ipc.cancelSearch.mockReset()
  ipc.startSearch.mockResolvedValue('t1')
  ipc.cancelSearch.mockResolvedValue(undefined)
  root = '/repo'
  mount()
})

afterEach(() => {
  dispose?.()
  dispose = undefined
})

/** 结果列表的紧凑视图：`F:文件` 与 `H:文件:行号`。断言顺序时比整对象好读 */
function kinds(): string[] {
  return panel.rows().map((r) => (r.kind === 'file' ? `F:${r.rel}` : `H:${r.rel}:${r.line}`))
}

/** 第 n 次 `startSearch` 收到的查询条件 */
function sentQuery(call = 0): SearchQuery {
  const args = ipc.startSearch.mock.calls[call]?.[1]
  if (!args) throw new Error(`第 ${call} 次 startSearch 没有带查询条件`)
  return args
}

/** 被请求取消过的 taskId，按顺序 */
function cancelled(): string[] {
  return ipc.cancelSearch.mock.calls.map((c) => c[0])
}

/** 搜一次并把 taskId 认下来，好让后面的事件有得可发 */
async function searchOnce(pattern = 'needle'): Promise<void> {
  panel.setPattern(pattern)
  await panel.search()
}

describe('初始状态与三个开关', () => {
  it('一开始什么都没有，连 invoke 都没发过', () => {
    expect(panel.visible()).toBe(false)
    expect(panel.pattern()).toBe('')
    expect(panel.literal()).toBe(false)
    expect(panel.caseSensitive()).toBe(false)
    expect(panel.wholeWord()).toBe(false)
    expect(panel.running()).toBe(false)
    expect(panel.error()).toBeNull()
    expect(panel.summary()).toBeNull()
    expect(panel.filesScanned()).toBe(0)
    expect(panel.rows()).toEqual([])
    expect(panel.selected()).toBeNull()
    expect(panel.focusRequest()).toBe(0)
    expect(ipc.startSearch).not.toHaveBeenCalled()
  })

  it('空状态的提示是一句「怎么做」，不是一句「没有结果」', () => {
    // 「没有找到」在还没搜过时是假话，而且会让人以为搜索坏了
    expect(panel.statusLine()).toBe('在项目里搜一遍：输入搜索词，按 Enter')
    expect(panel.warning()).toBeNull()
  })

  it('三个开关各管各的', () => {
    panel.toggle('literal')
    expect([panel.literal(), panel.caseSensitive(), panel.wholeWord()]).toEqual([true, false, false])
    panel.toggle('caseSensitive')
    expect([panel.literal(), panel.caseSensitive(), panel.wholeWord()]).toEqual([true, true, false])
    panel.toggle('wholeWord')
    expect([panel.literal(), panel.caseSensitive(), panel.wholeWord()]).toEqual([true, true, true])
    // 「再按一次取消」——三个都是开关而不是单选
    panel.toggle('literal')
    expect([panel.literal(), panel.caseSensitive(), panel.wholeWord()]).toEqual([false, true, true])
  })
})

describe('起飞前的两道拦截', () => {
  it('没打开文件夹时连搜索词都不看', async () => {
    root = null
    panel.setPattern('needle')
    await panel.search()
    // 顺序有意义：先判文件夹再说搜索词为空，否则用户会先去填一个填了也没用的框
    expect(panel.error()).toBe('还没打开文件夹')
    expect(panel.visible()).toBe(true)
    expect(panel.running()).toBe(false)
    expect(ipc.startSearch).not.toHaveBeenCalled()
  })

  it('空搜索词在前端就拦掉', async () => {
    await panel.search()
    expect(panel.error()).toBe('搜索词不能为空')
    expect(panel.visible()).toBe(true)
    expect(ipc.startSearch).not.toHaveBeenCalled()
  })

  it('全是空格的搜索词照样发出去', async () => {
    // ⚠️ 判的是 `=== ''` 而不是 trim 之后为空：`"   "` 是一个合法的字面串
    //（三个连续空格，缩进过的代码里到处都是）。前端替它 trim 就是把用户真想搜的东西悄悄改掉
    await searchOnce('   ')
    expect(sentQuery().pattern).toBe('   ')
    expect(panel.error()).toBeNull()
    expect(panel.running()).toBe(true)
  })
})

describe('发出去的查询条件', () => {
  it('root 原样交给 Rust，前端不做任何路径算术', async () => {
    await searchOnce()
    expect(ipc.startSearch.mock.calls[0]?.[0]).toBe('/repo')
  })

  it('四个字段，一个不多', async () => {
    panel.setPattern('foo')
    panel.toggle('caseSensitive')
    await panel.search()
    expect(sentQuery()).toEqual({ pattern: 'foo', literal: false, caseSensitive: true, wholeWord: false })
    // include / exclude 刻意不发：Rust 侧容器上有 `#[serde(default)]`，缺 key 就是「不限」。
    // 前端替它补两个空数组等于把默认值抄两份，哪天那边改了默认两边就悄悄分岔了
    expect(Object.keys(sentQuery()).sort()).toEqual(['caseSensitive', 'literal', 'pattern', 'wholeWord'])
  })

  it('一发出去就展开面板、置 running，并把上一轮的 error 清掉', async () => {
    root = null
    await panel.search()
    expect(panel.error()).toBe('还没打开文件夹')

    root = '/repo'
    await searchOnce()
    expect(panel.error()).toBeNull()
    expect(panel.visible()).toBe(true)
    expect(panel.running()).toBe(true)
    expect(panel.statusLine()).toBe('正在搜索… 已扫过 0 个文件')
  })
})

describe('批次与心跳', () => {
  it('一批结果摊成「文件行 + 命中行」，行序就是批次序', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['needle one', 'needle two'])], filesScanned: 4 })
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1', 'H:a.ts:2'])
    expect(panel.filesScanned()).toBe(4)
    // 批次不是终止信号：还在跑
    expect(panel.running()).toBe(true)
    expect(panel.summary()).toBeNull()
    expect(panel.statusLine()).toBe('正在搜索… 已扫过 4 个文件')
  })

  it('第二批往后接，不覆盖前一批', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x'])], filesScanned: 1 })
    panel.handlers.onBatch('t1', { files: [fileOf('b.md', ['y', 'z'])], filesScanned: 2 })
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1', 'F:b.md', 'H:b.md:1', 'H:b.md:2'])
  })

  it('⚠️ 心跳批只更新进度，不动结果列表', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x'])], filesScanned: 3 })
    panel.handlers.onBatch('t1', { files: [], filesScanned: 512 })
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])
    expect(panel.filesScanned()).toBe(512)
    // 把心跳当成「没有结果」的话，十万个文件那 7 秒里面板会先闪一次「没有找到」再出结果；
    // 当成「搜完了」更糟——running 一置假，后面真的批次就落在一个已结束的面板上
    expect(panel.running()).toBe(true)
    expect(panel.summary()).toBeNull()
  })

  it('filesScanned 是累计值，直接赋值不是累加', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [], filesScanned: 10 })
    panel.handlers.onBatch('t1', { files: [], filesScanned: 25 })
    // 当成增量累加的话，十万个文件会显示成「已扫两百万个」
    expect(panel.filesScanned()).toBe(25)
  })

  it('命中行带着原文、偏移量与截断标记', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', {
      files: [{ rel: 'a.ts', path: '/repo/a.ts', hits: [hitOf(7, 'let a = needle;')], truncated: true }],
      filesScanned: 1,
    })
    const row = panel.rows()[1]
    expect(row?.kind).toBe('hit')
    if (row?.kind !== 'hit') throw new Error('第二行应该是命中行')
    expect(row.line).toBe(7)
    expect(row.text).toBe('let a = needle;')
    expect(row.path).toBe('/repo/a.ts')
    expect(row.truncated).toBe(false)
    // 偏移量是 UTF-16 码元，可以直接 slice
    expect(row.text.slice(row.ranges[0]?.start ?? 0, row.ranges[0]?.end ?? 0)).toBe('let a = needle;')
    // 文件级的 truncated 落在文件行上，不是命中行上
    const head = panel.rows()[0]
    expect(head?.kind === 'file' && head.truncated).toBe(true)
  })
})

describe('终止事件', () => {
  it('done 收尾：running 置假、总账落地、进度被总账覆盖', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x'])], filesScanned: 99 })
    panel.handlers.onDone('t1', sum({ filesScanned: 120 }))
    expect(panel.running()).toBe(false)
    expect(panel.summary()?.filesScanned).toBe(120)
    // 总账里的 filesScanned 比最后一个心跳批更准（它含最后那几个文件），所以覆盖一次
    expect(panel.filesScanned()).toBe(120)
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])
  })

  it('statusLine 换成总账那句话', async () => {
    await searchOnce()
    panel.handlers.onDone('t1', GOLDEN_SUMMARY)
    expect(panel.statusLine()).toBe(
      '已取消 · 共 7 处，分布在 3 个文件里 · 扫过 120 个文件 · 45ms · 跳过 1 个过大的文件',
    )
  })

  it('读不出来的条目非零时单独给一句警告', async () => {
    await searchOnce()
    panel.handlers.onDone('t1', sum({ hits: 0, filesWithHits: 0, unreadable: 2 }))
    expect(panel.statusLine()).toContain('没有找到')
    // ⚠️ 这一句不并进 statusLine：它会跟在一串数字后面，用户只会读到「共 0 处」。
    // 而 unreadable 非零意味着「没找到」可能是假的，必须用警告色单独说
    expect(panel.warning()).toBe('有 2 个条目读不出来（权限不够、被删或 IO 错误），所以「没有找到」不一定成立')
  })

  it('一个都没读不出来时不给警告', async () => {
    await searchOnce()
    panel.handlers.onDone('t1', sum())
    expect(panel.warning()).toBeNull()
  })

  it('done 之后同一个 taskId 再来的批次被丢掉', async () => {
    await searchOnce()
    panel.handlers.onDone('t1', sum({ hits: 0, filesWithHits: 0 }))
    panel.handlers.onBatch('t1', { files: [fileOf('late.ts', ['x'])], filesScanned: 999 })
    expect(kinds()).toEqual([])
    expect(panel.filesScanned()).toBe(120)
  })

  it('failed 也当终止处理：running 置假、错误成人话', async () => {
    await searchOnce()
    panel.handlers.onFailed('t1', { kind: 'not_found', path: '/repo' })
    expect(panel.running()).toBe(false)
    expect(panel.summary()).toBeNull()
    expect(panel.error()).toBe('模拟错误：{"kind":"not_found","path":"/repo"}')
  })

  it('failed 之后已经收到的那些行还在，总账换成行数', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x', 'y'])], filesScanned: 1 })
    panel.handlers.onFailed('t1', { kind: 'not_found', path: '/repo/src' })
    // 这是「有行、没总账、不在跑」唯一能到达的路径。此时说「共 3 行」比说「没有找到」诚实：
    // 那三行是真的搜到的，只是搜索半路断了
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1', 'H:a.ts:2'])
    expect(panel.statusLine()).toBe('共 3 行')
    expect(panel.warning()).toBeNull()
  })
})

describe('taskId 的认领与作废', () => {
  it('没有搜索在飞时，陌生 taskId 的事件一律丢掉', async () => {
    panel.handlers.onBatch('stranger', { files: [fileOf('a.ts', ['x'])], filesScanned: 5 })
    expect(kinds()).toEqual([])
    expect(panel.filesScanned()).toBe(0)
    expect(panel.running()).toBe(false)
  })

  it('⚠️ done 比 invoke 的返回值先到：结果一条都不能丢', async () => {
    const gate = deferred<string>()
    ipc.startSearch.mockReturnValue(gate.promise)
    panel.setPattern('needle')
    const pending = panel.search()

    // 后台线程已经在推事件了，而前端手上还没有 taskId。
    // 实测本仓库 107 个文件整次搜索只要 12.7ms，这个窗口是真的会撞上的
    panel.handlers.onBatch('early', { files: [fileOf('a.ts', ['needle'])], filesScanned: 1 })
    panel.handlers.onDone('early', sum({ filesScanned: 1 }))

    gate.resolve('early')
    await pending

    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])
    expect(panel.summary()?.filesScanned).toBe(1)
    expect(panel.running()).toBe(false)
    // 朴素的 `if (taskId !== current()) return` 在这里会把上面两条全丢掉：
    // 面板永远停在「正在搜索…」，而后台其实早就搜完了
    expect(panel.statusLine()).not.toContain('正在搜索')
  })

  it('那一轮已经结束了，cancel 不该再去白跑一趟 IPC', async () => {
    const gate = deferred<string>()
    ipc.startSearch.mockReturnValue(gate.promise)
    panel.setPattern('needle')
    const pending = panel.search()
    panel.handlers.onDone('early', sum())
    gate.resolve('early')
    await pending

    await panel.cancel()
    // adopted 要是被无条件写成 taskId，这里就会去取消一个已经搜完的任务。
    // 不炸，但白跑一趟 IPC，而且读代码的人会以为那一轮还在飞
    expect(cancelled()).toEqual([])
  })

  it('⚠️ 批次比 invoke 的返回值先到：也要认下来', async () => {
    const gate = deferred<string>()
    ipc.startSearch.mockReturnValue(gate.promise)
    panel.setPattern('needle')
    const pending = panel.search()

    panel.handlers.onBatch('early', { files: [fileOf('a.ts', ['one'])], filesScanned: 1 })
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])

    gate.resolve('early')
    await pending
    // 认下来之后仍然是同一个任务，后面的批次接着收
    panel.handlers.onBatch('early', { files: [fileOf('b.md', ['two'])], filesScanned: 2 })
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1', 'F:b.md', 'H:b.md:1'])
    panel.handlers.onDone('early', sum({ filesScanned: 2 }))
    expect(panel.running()).toBe(false)
  })

  it('retired 优先于 starting：上一轮迟到的批次不会被新一轮的窗口认下来', async () => {
    await searchOnce()
    panel.handlers.onDone('t1', sum({ hits: 0, filesWithHits: 0 }))

    const gate = deferred<string>()
    ipc.startSearch.mockReturnValue(gate.promise)
    panel.setPattern('second')
    const pending = panel.search()

    // 取消是协作式的，被作废的旧搜索还会继续推几批。这些必须丢掉，
    // 否则两轮搜索的结果会混在一起
    panel.handlers.onBatch('t1', { files: [fileOf('old.ts', ['x'])], filesScanned: 77 })
    expect(kinds()).toEqual([])
    expect(panel.filesScanned()).toBe(0)

    gate.resolve('t2')
    await pending
    panel.handlers.onBatch('t2', { files: [fileOf('new.ts', ['y'])], filesScanned: 3 })
    expect(kinds()).toEqual(['F:new.ts', 'H:new.ts:1'])
  })

  it('start_search reject = 这次搜索压根没开始，不留任何 taskId', async () => {
    ipc.startSearch.mockImplementation(() => rejected<string>({ kind: 'bad_root', path: 'repo' }))
    panel.setPattern('needle')
    await panel.search()
    expect(panel.running()).toBe(false)
    expect(panel.error()).toBe('模拟错误：{"kind":"bad_root","path":"repo"}')
    expect(kinds()).toEqual([])

    // reject 之后不会有事件来，所以也不需要作废谁；此时来的任何事件都是陌生的
    panel.handlers.onDone('ghost', sum())
    expect(panel.summary()).toBeNull()

    await panel.cancel()
    expect(cancelled()).toEqual([])
  })
})

describe('换一轮、取消与清空', () => {
  it('再搜一次把上一轮整个扔掉，并取消上一个 taskId', async () => {
    await searchOnce('first')
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x'])], filesScanned: 9 })
    panel.select(1)

    ipc.startSearch.mockResolvedValue('t2')
    await searchOnce('second')

    expect(cancelled()).toEqual(['t1'])
    expect(kinds()).toEqual([])
    expect(panel.filesScanned()).toBe(0)
    expect(panel.selected()).toBeNull()
    expect(panel.summary()).toBeNull()
    expect(sentQuery(1).pattern).toBe('second')

    // 旧任务的批次进不了新一轮
    panel.handlers.onBatch('t1', { files: [fileOf('old.ts', ['y'])], filesScanned: 88 })
    expect(kinds()).toEqual([])
  })

  it('cancel 只发请求，状态一律不动', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x'])], filesScanned: 4 })
    await panel.cancel()

    expect(cancelled()).toEqual(['t1'])
    // 已经推出去的批次仍然有效。这里自己把 running 置假的话，那一批迟到的结果会落在一个
    // 「已经结束」的面板上，用户看到的是数字自己在动
    expect(panel.running()).toBe(true)
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])

    panel.handlers.onBatch('t1', { files: [fileOf('b.md', ['y'])], filesScanned: 6 })
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1', 'F:b.md', 'H:b.md:1'])

    panel.handlers.onDone('t1', sum({ cancelled: true }))
    expect(panel.running()).toBe(false)
    expect(panel.statusLine()).toContain('已取消')
  })

  it('没有在飞的搜索时 cancel 是空操作', async () => {
    await panel.cancel()
    expect(cancelled()).toEqual([])
  })

  it('clear 清结果但不清搜索词与开关', async () => {
    panel.setPattern('needle')
    panel.toggle('wholeWord')
    await panel.search()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x'])], filesScanned: 4 })
    panel.handlers.onDone('t1', sum({ unreadable: 1 }))

    panel.clear()
    expect(kinds()).toEqual([])
    expect(panel.summary()).toBeNull()
    expect(panel.warning()).toBeNull()
    expect(panel.filesScanned()).toBe(0)
    expect(panel.selected()).toBeNull()
    expect(panel.running()).toBe(false)
    // 清掉搜索词等于让用户重打一遍，那不是「清结果」的意思
    expect(panel.pattern()).toBe('needle')
    expect(panel.wholeWord()).toBe(true)
    // 那一轮已经结束了，没什么可取消的
    expect(cancelled()).toEqual([])

    panel.handlers.onBatch('t1', { files: [fileOf('late.ts', ['y'])], filesScanned: 9 })
    expect(kinds()).toEqual([])
  })

  it('clear 在搜索还在飞时会取消它', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x'])], filesScanned: 4 })

    panel.clear()
    expect(cancelled()).toEqual(['t1'])
    expect(panel.running()).toBe(false)
    expect(kinds()).toEqual([])

    // 取消是协作式的，被作废的这一次还会继续推几批
    panel.handlers.onBatch('t1', { files: [fileOf('late.ts', ['y'])], filesScanned: 9 })
    panel.handlers.onDone('t1', sum())
    expect(kinds()).toEqual([])
    expect(panel.summary()).toBeNull()
  })

  it('clear 在没搜过时也是安全的', () => {
    panel.clear()
    expect(kinds()).toEqual([])
    expect(cancelled()).toEqual([])
    expect(panel.running()).toBe(false)
  })
})

describe('选中与打开', () => {
  beforeEach(async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', {
      files: [fileOf('a.ts', ['one', 'two']), fileOf('empty.md', [])],
      filesScanned: 2,
    })
    // F:a.ts H:a.ts:1 H:a.ts:2 F:empty.md
  })

  it('方向键一行一行走，越界就停在边上', () => {
    expect(panel.selected()).toBeNull()
    panel.key('ArrowDown')
    expect(panel.selected()).toBe(0)
    panel.key('ArrowDown')
    expect(panel.selected()).toBe(1)
    panel.key('ArrowUp')
    expect(panel.selected()).toBe(0)
    panel.key('ArrowUp')
    expect(panel.selected()).toBe(0)
    panel.key('End')
    expect(panel.selected()).toBe(3)
    panel.key('ArrowDown')
    expect(panel.selected()).toBe(3)
    panel.key('Home')
    expect(panel.selected()).toBe(0)
  })

  it('没选中时按 Enter 什么都不做', () => {
    panel.key('Enter')
    expect(opened).toEqual([])
    expect(panel.selected()).toBeNull()
  })

  it('Enter 打开选中的那条命中', () => {
    panel.key('ArrowDown')
    panel.key('ArrowDown')
    panel.key('Enter')
    expect(opened).toHaveLength(1)
    expect(opened[0]?.line).toBe(1)
    expect(opened[0]?.rel).toBe('a.ts')
    expect(opened[0]?.path).toBe('/repo/a.ts')
  })

  it('点命中行直接跳，不分成「先选中再双击」', () => {
    panel.clickRow(2)
    expect(panel.selected()).toBe(2)
    expect(opened[0]?.line).toBe(2)
    expect(opened[0]?.text).toBe('two')
  })

  it('点文件行落到它的第一个命中', () => {
    panel.clickRow(0)
    expect(opened).toHaveLength(1)
    expect(opened[0]?.line).toBe(1)
    expect(opened[0]?.rel).toBe('a.ts')
  })

  it('一条命中都没有的文件行点了不跳，但选中照旧', () => {
    panel.clickRow(3)
    expect(panel.selected()).toBe(3)
    // 静默不动比报一句「这个文件没有命中」有用——那种行本来也点不出什么
    expect(opened).toEqual([])
    expect(panel.error()).toBeNull()
  })

  it('select 能把光标放到任意一行，随后的方向键从那儿接着走', () => {
    panel.select(2)
    panel.key('ArrowDown')
    expect(panel.selected()).toBe(3)
  })

  it('none 动作什么都不做', () => {
    panel.select(1)
    panel.run({ kind: 'none' })
    expect(panel.selected()).toBe(1)
    expect(opened).toEqual([])
  })

  it('结果被换掉之后选中不会悬在旧下标上', async () => {
    panel.select(3)
    ipc.startSearch.mockResolvedValue('t2')
    await searchOnce('second')
    expect(panel.selected()).toBeNull()
    panel.key('ArrowUp')
    // 列表空了，方向键也不该凭空造出一个下标
    expect(panel.selected()).toBeNull()
    expect(opened).toEqual([])
  })
})

describe('展开与收起', () => {
  it('show 每按一次都要求重新聚焦', () => {
    panel.show()
    expect(panel.visible()).toBe(true)
    expect(panel.focusRequest()).toBe(1)
    // 用自增的计数而不是布尔：面板已经展开时再按一次 Mod+Shift+F，
    // 布尔值不变就不会触发 effect，焦点也就抢不回来
    panel.show()
    expect(panel.focusRequest()).toBe(2)
  })

  it('hide 不取消在飞的搜索，状态全留着', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['x'])], filesScanned: 4 })
    panel.hide()
    expect(panel.visible()).toBe(false)
    // 收起面板只是不看它，重新展开该看到结果。真要不搜了有「取消」按钮，
    // 那才是明确表达意图的动作
    expect(cancelled()).toEqual([])
    expect(panel.running()).toBe(true)

    panel.handlers.onBatch('t1', { files: [fileOf('b.md', ['y'])], filesScanned: 5 })
    panel.show()
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1', 'F:b.md', 'H:b.md:1'])
    expect(panel.filesScanned()).toBe(5)
  })

  it('搜索本身会把面板展开', async () => {
    expect(panel.visible()).toBe(false)
    await searchOnce()
    expect(panel.visible()).toBe(true)
  })

  it('报错也会把面板展开——藏起来的错误等于没有错误', async () => {
    root = null
    await panel.search()
    expect(panel.visible()).toBe(true)
  })
})
