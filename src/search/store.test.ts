import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, createSignal } from 'solid-js'

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
 * 假的是 `startSearch`、`describeSearchError`（都在 `../ipc/search`）、`cancelTask`
 * （在 `../ipc/task`，M2-D 之后搜索与替换共用一个取消命令）与 `startReplace`
 * （在 `../ipc/replace`）——jsdom 里没有 Tauri 运行时。
 * ⚠️ 一个都不能少：`store.ts` 是按名字从这三个模块导入它们的，少一个就在被调用那一刻变成
 * `undefined is not a function`，而 vitest 对「导入了但没调用」是不报错的。
 * `describeSearchError` 也一并假掉：它自己在 `src/ipc/search.test.ts` 里测过，
 * 这里只关心「错误有没有落到 `error` 上」。
 *
 * ⚠️ 两组事件监听器本身（`attachSearchListeners` / `attachReplaceListeners`）不在这里：
 * store 只交出 `handlers` / `replaceHandlers` 两组回调，测试直接调它们，
 * 于是「事件到达的顺序」变成一个可以随手编排的普通函数调用。
 */

/**
 * ⚠️ 桩都写了完整的函数签名，不是裸 `vi.fn()`。
 * 裸的话 `.mock.calls` 的元素是 `any`，于是每一处 `calls[0][1].pattern` 都是一次
 * unsafe member access——`pnpm lint` 是门禁的一部分，这里过不了就提交不了。
 *
 * 签名里直接用 `SearchQuery` 是安全的：类型在编译时被擦掉，`vi.hoisted` 的工厂搬到
 * import 之前也不会引用到任何运行时值。
 */
const { ipc, task, rep } = vi.hoisted(() => ({
  ipc: {
    startSearch: vi.fn<(roots: string[], query: SearchQuery) => Promise<string>>(),
    describeSearchError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
  },
  task: {
    cancelTask: vi.fn<(taskId: string) => Promise<void>>(),
  },
  rep: {
    startReplace: vi.fn<(roots: string[], query: SearchQuery, skip: string[]) => Promise<string>>(),
  },
}))

vi.mock('../ipc/search', () => ipc)
vi.mock('../ipc/task', () => task)
vi.mock('../ipc/replace', () => rep)

import type { MatchRange, SearchFile, SearchHit, SearchQuery, SearchSummary } from '../ipc/search'
import type { ReplaceSummary } from '../ipc/replace'
import { createSearchPanel, type SearchPanel, type SearchPanelOptions } from './store'
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
function fileOf(rel: string, texts: string[], truncated = false, rootIndex = 0): SearchFile {
  return { rel, path: `/repo/${rel}`, rootIndex, hits: texts.map((t, i) => hitOf(i + 1, t)), truncated }
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

/** 替换模式下的一条命中：比纯搜索多一个 `replaced` 预览 */
function previewOf(line: number, text: string, replaced: string): SearchHit {
  return { ...hitOf(line, text), replaced }
}

/** 一个文件的全部预览命中。`pairs` 的每一项是 `[原文, 换完之后]` */
function previewFile(rel: string, pairs: [string, string][], truncated = false): SearchFile {
  return {
    rel,
    path: `/repo/${rel}`,
    rootIndex: 0,
    truncated,
    hits: pairs.map(([text, replaced], i) => previewOf(i + 1, text, replaced)),
  }
}

/**
 * 一份**干净**的替换总账：换了 3 个文件 7 处，一处保留都没有。
 *
 * ⚠️ 不叫 `rep`——那是 `startReplace` 的 mock 对象。字段与 `rows.test.ts` 的 `CLEAN` 一致，
 * 两边措辞用例才能对着读
 */
function rsum(overrides: Partial<ReplaceSummary> = {}): ReplaceSummary {
  return {
    filesScanned: 120,
    filesChanged: 3,
    replacements: 7,
    skippedBinary: 0,
    skippedLossy: 0,
    skippedUnmappable: 0,
    skippedTooLarge: 0,
    skippedOpen: 0,
    unreadable: 0,
    writeFailed: 0,
    truncated: false,
    cancelled: false,
    elapsedMs: 45,
    ...overrides,
  }
}

let root: string | null
/** 根清单那个 signal 的写入端，由 `mount` 赋值。用例一律走 `setRootAt`，不直接碰它 */
let setRoot: (value: readonly string[]) => void
let opened: HitRow[]
let panel: SearchPanel
/** `skipPaths` 的返回值：正开着且有未保存改动的那些绝对路径。默认一个都没有 */
let dirty: string[]
/** `onApplied` 收到的总账，按顺序。空 = 落盘那一轮一个文件都没改（或压根没落盘） */
let applied: ReplaceSummary[]
/** `createSearchPanel` 里有四个 `createMemo`；不在 root 里建，它们永远不会被释放 */
let dispose: (() => void) | undefined

function mount(extra: Partial<SearchPanelOptions> = {}) {
  opened = []
  applied = []
  dispose = createRoot((teardown) => {
    // ⚠️ 根清单走 signal 而不是直接读那个模块变量：`canApply` 与 `stale` 都是 `createMemo`，
    // 而 memo 只在**响应式**依赖变化时重算。真实宿主注入的是 `tree.roots`（memo），
    // 脚手架里用普通变量的话「工作区被换掉」这件事就测不出来
    const [rootsSignal, setRootsSignal] = createSignal<readonly string[]>(root === null ? [] : [root])
    setRoot = setRootsSignal
    panel = createSearchPanel({
      roots: rootsSignal,
      openHit: async (hit) => void opened.push(hit),
      skipPaths: () => dirty,
      onApplied: async (s) => void applied.push(s),
      ...extra,
    })
    return teardown
  })
}

/**
 * 换工作区。⚠️ 一律走这个函数，别直接给 `root` 赋值——见 `mount` 里那条注释。
 *
 * `null` = 一个文件夹都没打开（对应 `tree.roots()` 是空数组），字符串 = 就这一个根。
 * 多根的那些用例直接给 `setRoot(['a','b'])`，这条签名两种都收
 */
function setRootAt(value: string | readonly string[] | null) {
  const list = value === null ? [] : typeof value === 'string' ? [value] : value
  root = typeof value === 'string' ? value : null
  setRoot(list)
}

beforeEach(() => {
  ipc.startSearch.mockReset()
  task.cancelTask.mockReset()
  rep.startReplace.mockReset()
  ipc.startSearch.mockResolvedValue('t1')
  task.cancelTask.mockResolvedValue(undefined)
  // 替换的 taskId 与搜索的刻意不同：Rust 侧是同一个计数器发号，两边永不重复，
  // 桩要是都用 't1' 就测不出「两个 slot 各认各的」这件事
  rep.startReplace.mockResolvedValue('r1')
  root = '/repo'
  dirty = []
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

/**
 * 被请求取消过的 taskId，按顺序。
 *
 * ⚠️ `cancel_task` 是搜索与替换**共用**的一个命令，而这里挂的是同一个 store，
 * 所以这个列表可能混着两种 id。分辨靠 id 本身：桩给搜索发的是 `t*`，给替换发的是 `r*`
 * （与 Rust 侧一致——同一个计数器发号，两类任务永不重号）
 */
function cancelled(): string[] {
  return task.cancelTask.mock.calls.map((c) => c[0])
}

/** 第 n 次 `startReplace` 收到的三样东西。没发过就抛，不用非空断言 */
function sentReplace(call = 0): { roots: string[]; query: SearchQuery; skip: string[] } {
  const args = rep.startReplace.mock.calls[call]
  if (!args) throw new Error(`第 ${call} 次 startReplace 没有发出去`)
  return { roots: args[0], query: args[1], skip: args[2] }
}

/** 搜一次并把 taskId 认下来，好让后面的事件有得可发 */
async function searchOnce(pattern = 'needle'): Promise<void> {
  panel.setPattern(pattern)
  await panel.search()
}

/**
 * 起一次**替换预览**并把它跑完：开替换模式 → 搜 → 摊好行 → 填上搜索总账。
 * 之后 `canApply()` 为真，可以直接 `askApply()` / `confirmApply()`。
 *
 * `hits` 从 `files` 上数出来，不写死：`canApply` 看的就是它，
 * 而对不上的话「搜到 0 处不能落盘」那类用例会莫名其妙地过或莫名其妙地挂
 */
async function previewOnce(files: SearchFile[], summaryOverrides: Partial<SearchSummary> = {}): Promise<void> {
  panel.toggleReplaceMode()
  panel.setPattern('needle')
  panel.setReplacement('NEEDLE')
  await panel.search()
  const hits = files.reduce((n, f) => n + f.hits.length, 0)
  panel.handlers.onBatch('t1', { files, filesScanned: files.length })
  panel.handlers.onDone('t1', sum({ filesWithHits: files.length, hits, ...summaryOverrides }))
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
    // 替换那一半也一律是「关着、没跑过、没得可批」
    expect(panel.replaceMode()).toBe(false)
    expect(panel.replacement()).toBe('')
    expect(panel.replacing()).toBe(false)
    expect(panel.replaceSummary()).toBeNull()
    expect(panel.replaceProgress()).toBeNull()
    expect(panel.confirm()).toBeNull()
    expect(panel.stale()).toBe(false)
    expect(panel.canApply()).toBe(false)
    expect(rep.startReplace).not.toHaveBeenCalled()
  })

  it('空状态的提示是一句「怎么做」，不是一句「没有结果」', () => {
    // 「没有找到」在还没搜过时是假话，而且会让人以为搜索坏了
    expect(panel.statusLine()).toBe('在项目里搜一遍：输入搜索词，按 Enter')
    expect(panel.warnings()).toEqual([])
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
    setRootAt(null)
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
  it('⚠️ roots 就是注入进来的那份根清单，前端不做任何路径算术', async () => {
    await searchOnce()
    expect(ipc.startSearch.mock.calls[0]?.[0]).toEqual(['/repo'])
    // M2-F 起 `start_search` 收的是 `roots`，store 原样把注入进来的那份清单递过去。
    // ⚠️ 「原样」是这条用例的全部内容：前端一旦自己拼路径或剥前缀，两边就会各自漂移
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
    setRootAt(null)
    await panel.search()
    expect(panel.error()).toBe('还没打开文件夹')

    setRootAt('/repo')
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
      files: [{ rel: 'a.ts', path: '/repo/a.ts', rootIndex: 0, hits: [hitOf(7, 'let a = needle;')], truncated: true }],
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
    expect(panel.warnings()).toEqual(['有 2 个条目读不出来（权限不够、被删或 IO 错误），所以「没有找到」不一定成立'])
  })

  it('一个都没读不出来时不给警告', async () => {
    await searchOnce()
    panel.handlers.onDone('t1', sum())
    expect(panel.warnings()).toEqual([])
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
    expect(panel.warnings()).toEqual([])
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
    expect(panel.warnings()).toEqual([])
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

  it('showReplace 一次到位：面板展开、替换模式已经开着、焦点也要求过一次', () => {
    panel.showReplace()
    expect(panel.visible()).toBe(true)
    expect(panel.replaceMode()).toBe(true)
    expect(panel.focusRequest()).toBe(1)
    expect(panel.focusTarget()).toBe('replacement')
  })

  it('⚠️ 两个入口对「焦点该去哪一格」各执一词，而且是**说出来的**，不是靠 effect 谁后跑', () => {
    panel.show()
    expect(panel.focusTarget()).toBe('pattern')
    panel.showReplace()
    expect(panel.focusTarget()).toBe('replacement')
    // 已经在替换模式里了，再按 Mod+Shift+F 仍然要回到搜索词那一格：
    // 那一下表达的是「我要改搜什么」，模式不该被它顺手改掉，焦点也不该赖在下面
    panel.show()
    expect(panel.replaceMode()).toBe(true)
    expect(panel.focusTarget()).toBe('pattern')
  })

  it('⚠️ 已经在替换模式时再按一次，模式不许被翻回去', () => {
    panel.showReplace()
    panel.showReplace()
    // 这就是它不复用 `toggleReplaceMode` 的全部理由：那个在已经开着的时候会**关掉**。
    // 于是连按两次 Mod+Shift+H 的用户会看到「面板还在、下面那一排没了」——
    // 快捷键的语义是「我要替换」，不是「翻一下开关」
    expect(panel.replaceMode()).toBe(true)
    // 但焦点照旧要抢回来：与 `show` 同一条道理，面板本来就展开着时也得能把光标放回输入框
    expect(panel.focusRequest()).toBe(2)
  })

  it('⚠️ 确认单摊着的时候按它，单子不会被收掉', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.askApply()
    expect(panel.confirm()).not.toBeNull()

    panel.showReplace()
    // 键位分派挂在 window 的**捕获阶段**，模态框拦不住它，所以这条路是真的能走到的。
    // 能走到的前提下，正确的行为是什么都不动：`canApply` 要求 replaceMode，
    // 于是「单子摊着」⇒「模式开着」⇒ showReplace 走的是不碰任何模式信号的那一支。
    // 收掉的话用户按下批准键之前先丢了刚批准过的那份清单
    expect(panel.confirm()).not.toBeNull()
    expect(panel.replaceMode()).toBe(true)
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
    setRootAt(null)
    await panel.search()
    expect(panel.visible()).toBe(true)
  })
})

// ───────────────────────── 替换那一半（M2-D） ─────────────────────────

describe('替换模式：query 上多一个 replace', () => {
  it('纯搜索时连这个 key 都没有', async () => {
    await searchOnce('foo')
    expect('replace' in sentQuery()).toBe(false)
  })

  it('开了替换模式之后 replace 就是输入框里那串', async () => {
    panel.toggleReplaceMode()
    panel.setPattern('foo')
    panel.setReplacement('bar')
    await panel.search()
    expect(sentQuery()).toEqual({
      pattern: 'foo',
      literal: false,
      caseSensitive: false,
      wholeWord: false,
      replace: 'bar',
    })
    expect(Object.keys(sentQuery()).sort()).toEqual(['caseSensitive', 'literal', 'pattern', 'replace', 'wholeWord'])
  })

  it('⚠️ 替换内容是空串时照样带 replace——那是「把每一处命中删掉」', async () => {
    panel.toggleReplaceMode()
    panel.setPattern('foo')
    await panel.search()
    expect(sentQuery().replace).toBe('')
    // 挂在「非空」上的话这里会变成 undefined，Rust 侧回 bad_replacement：
    // 一个用户真想做的操作报了一个错，而面板看起来一切正常
  })

  it('关掉替换模式之后 replace 又不见了，行还留着', async () => {
    await previewOnce([previewFile('a.ts', [['let a = needle;', 'let a = NEEDLE;']])])
    panel.toggleReplaceMode()
    expect(panel.replaceMode()).toBe(false)
    // 刻意不清结果：上一轮的预览行照样能看，而 `stale` 会如实说出「条件变了」。
    // 清掉的话「切一下模式就丢结果」很难联想到原因
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])

    ipc.startSearch.mockResolvedValue('t2')
    await panel.search()
    expect('replace' in sentQuery(1)).toBe(false)
  })

  it('预览行带着 replaced，摊到行上原样不动', async () => {
    await previewOnce([previewFile('a.ts', [['let a = needle;', 'let a = NEEDLE;']])])
    const row = panel.rows()[1]
    expect(row?.kind === 'hit' ? row.replaced : 'not-a-hit-row').toBe('let a = NEEDLE;')
  })
})

describe('stale：预览与当前条件是否还一致', () => {
  it('刚搜完不算过期', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    expect(panel.stale()).toBe(false)
    expect(panel.warnings()).toEqual([])
    expect(panel.canApply()).toBe(true)
  })

  it('搜完之后动了搜索词就过期', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.setPattern('other')
    expect(panel.stale()).toBe(true)
    expect(panel.canApply()).toBe(false)
    expect(panel.warnings()).toEqual(['预览已过期：条件或工作区改过了，重新搜一遍再替换'])
  })

  it('⚠️ 搜完之后换了工作区也过期——批准的那份清单已经不是在说这些文件夹了', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    expect(panel.canApply()).toBe(true)
    setRootAt('/other')
    expect(panel.stale()).toBe(true)
    expect(panel.canApply()).toBe(false)
    expect(panel.warnings()[0]).toContain('预览已过期')
    // 这一条是 M2-F 补上的一个**单根时代就存在的洞**：根清单原来不在指纹里，
    // 于是「在 A 里预览 → 打开 B → 点替换全部」会改掉 B，而按钮是可点的。
    // 多根之后「往工作区加/减一个文件夹」成了一个日常操作，洞也就从一个边角变成了一条主路
  })

  it('工作区换回原来那一个又不算过期：指纹比的是内容，不是「动过没有」', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    setRootAt('/other')
    expect(panel.stale()).toBe(true)
    setRootAt('/repo')
    expect(panel.stale()).toBe(false)
    expect(panel.canApply()).toBe(true)
    // 存一个「脏了没有」的布尔而不是比指纹的话，这一条就得额外写一句「什么时候清回来」，
    // 而那句规则漏写的失败方式是**替换全部永久灰掉**——一个查不出原因的禁用按钮
  })

  it('⚠️ 往工作区里加一个文件夹也算换过：那份预览没搜过它', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    expect(panel.canApply()).toBe(true)
    setRootAt(['/repo', '/extra'])
    // 指纹比的是**整份清单的内容**，所以「多了一个根」与「换了一个根」同样算过期。
    // 只比第 0 个根的话，用户往工作区里加了 B、点替换全部，而批准的那份清单里
    // 压根没有 B 的命中——落下去的却是一次跨 A 与 B 的替换
    expect(panel.stale()).toBe(true)
    expect(panel.canApply()).toBe(false)
    setRootAt(['/repo'])
    expect(panel.stale()).toBe(false)
  })

  it('多根之下 roots 原样递过去，顺序就是侧边栏里的顺序', async () => {
    setRootAt(['/repo', '/notes', '/docs'])
    await searchOnce()
    expect(ipc.startSearch.mock.calls[0]?.[0]).toEqual(['/repo', '/notes', '/docs'])
  })

  it('动了替换内容也过期——批准的与发生的必须是同一份条件', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.setReplacement('OTHER')
    expect(panel.stale()).toBe(true)
    expect(panel.canApply()).toBe(false)
  })

  it('动了三个开关里任何一个都过期', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.toggle('wholeWord')
    expect(panel.stale()).toBe(true)
  })

  it('切一下替换模式也算改了条件', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.toggleReplaceMode()
    expect(panel.stale()).toBe(true)
  })

  it('⚠️ 过期只是把「替换全部」灰掉，行一行都不清', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.setPattern('other')
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])
    expect(panel.summary()).not.toBeNull()
    // 清掉的话用户看到的是「刚搜出来的结果凭空没了」，而那不是他做的任何一件事
  })

  it('重新搜一遍就不算过期了', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.setPattern('other')
    expect(panel.stale()).toBe(true)

    ipc.startSearch.mockResolvedValue('t2')
    await panel.search()
    expect(panel.stale()).toBe(false)
    // 新一轮还没有总账，所以还是不能落盘——不是靠 stale 挡的
    expect(panel.canApply()).toBe(false)
    panel.handlers.onDone('t2', sum({ hits: 3, filesWithHits: 1 }))
    expect(panel.canApply()).toBe(true)
  })

  it('没搜过时改了搜索词不叫过期', () => {
    panel.toggleReplaceMode()
    panel.setPattern('anything')
    expect(panel.stale()).toBe(false)
    expect(panel.warnings()).toEqual([])
  })

  it('纯搜索模式下不说这句话——它只对「替换全部」有意义', async () => {
    await searchOnce('needle')
    panel.handlers.onDone('t1', sum())
    panel.setPattern('other')
    expect(panel.stale()).toBe(true)
    expect(panel.warnings()).toEqual([])
  })

  it('过期与「读不出来」可以同时说，各占一行', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])], { unreadable: 1 })
    expect(panel.warnings()).toHaveLength(1)
    panel.setReplacement('X')
    expect(panel.warnings()).toHaveLength(2)
    expect(panel.warnings()[0]).toContain('预览已过期')
    expect(panel.warnings()[1]).toContain('读不出来')
  })

  it('clear 之后手上没有预览，也就不存在过期', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.setPattern('other')
    expect(panel.stale()).toBe(true)
    panel.clear()
    expect(panel.stale()).toBe(false)
    expect(panel.warnings()).toEqual([])
  })
})

describe('canApply：「替换全部」此刻能不能按', () => {
  it('纯搜索模式下不能', async () => {
    await searchOnce('needle')
    panel.handlers.onDone('t1', sum({ hits: 3, filesWithHits: 1 }))
    expect(panel.canApply()).toBe(false)
  })

  it('没搜过不能', () => {
    panel.toggleReplaceMode()
    panel.setReplacement('X')
    expect(panel.canApply()).toBe(false)
  })

  it('搜到 0 处不能——没有东西可换，落盘一趟只是白跑一遍仓库', async () => {
    await previewOnce([])
    expect(panel.summary()?.hits).toBe(0)
    expect(panel.canApply()).toBe(false)
  })

  it('搜索还在飞时不能：手上那份结果是部分的', async () => {
    panel.toggleReplaceMode()
    panel.setPattern('needle')
    panel.setReplacement('NEEDLE')
    await panel.search()
    panel.handlers.onBatch('t1', {
      files: [previewFile('a.ts', [['needle', 'NEEDLE']])],
      filesScanned: 1,
    })
    expect(kinds()).not.toEqual([])
    expect(panel.canApply()).toBe(false)

    panel.handlers.onDone('t1', sum({ hits: 1, filesWithHits: 1 }))
    expect(panel.canApply()).toBe(true)
  })

  it('没打开文件夹时不能', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    setRootAt(null)
    expect(panel.canApply()).toBe(false)
  })

  it('过期时不能', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.toggle('caseSensitive')
    expect(panel.canApply()).toBe(false)
  })
})

describe('确认单', () => {
  it('askApply 摊出文件数与命中行数', async () => {
    await previewOnce([
      previewFile('a.ts', [
        ['needle one', 'NEEDLE one'],
        ['needle two', 'NEEDLE two'],
      ]),
      previewFile('b.md', [['needle', 'NEEDLE']]),
    ])
    panel.askApply()
    expect(panel.confirm()).toEqual({ files: 2, lines: 3, skipped: 0, deleting: false, truncated: false })
  })

  it('⚠️ 数的是行不是处——处在预览这一层根本数不出来', async () => {
    // `ranges` 有 32 段的上限，而且可能是空数组，所以拿它去数「一共多少处」会得到
    // 一个偏小的数，而那个数字是用户批准落盘的唯一依据
    await previewOnce([previewFile('a.ts', [['needle needle needle', 'x']])])
    panel.askApply()
    expect(panel.confirm()?.lines).toBe(1)
  })

  it('⚠️ 正开着且有未保存改动的文件不计入「会被改」，单独一个数', async () => {
    dirty = ['/repo/a.ts']
    await previewOnce([
      previewFile('a.ts', [['needle', 'NEEDLE']]),
      previewFile('b.md', [
        ['needle', 'NEEDLE'],
        ['needle 2', 'NEEDLE 2'],
      ]),
    ])
    panel.askApply()
    expect(panel.confirm()).toEqual({ files: 1, lines: 2, skipped: 1, deleting: false, truncated: false })
    // 行上也标着：预览走的是 start_search，它不知道 skip 的存在，
    // 不标的话用户批准的是一份**做不到**的清单
    const head = panel.rows()[0]
    expect(head?.kind === 'file' && head.skipped).toBe(true)
    const second = panel.rows()[2]
    expect(second?.kind === 'file' && second.skipped).toBe(false)
  })

  it('替换内容为空串时确认单说这是「删掉」', async () => {
    panel.toggleReplaceMode()
    panel.setPattern('needle')
    await panel.search()
    panel.handlers.onBatch('t1', { files: [previewFile('a.ts', [['needle', '']])], filesScanned: 1 })
    panel.handlers.onDone('t1', sum({ hits: 1, filesWithHits: 1 }))
    panel.askApply()
    expect(panel.confirm()?.deleting).toBe(true)
  })

  it('某个文件撞到单文件上限 = 这份清单不完整', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']], true)])
    panel.askApply()
    expect(panel.confirm()?.truncated).toBe(true)
  })

  it('整轮撞到总条数上限也算不完整', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])], { truncated: true })
    panel.askApply()
    expect(panel.confirm()?.truncated).toBe(true)
  })

  it('条件不满足时 askApply 什么都不做（按钮本来就是灰的，这只是第二道）', async () => {
    await searchOnce('needle')
    panel.handlers.onDone('t1', sum({ hits: 3, filesWithHits: 1 }))
    panel.askApply()
    expect(panel.confirm()).toBeNull()
    expect(rep.startReplace).not.toHaveBeenCalled()
  })

  it('dismissConfirm 收起，落盘一步都没走，预览还在', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.askApply()
    expect(panel.confirm()).not.toBeNull()
    panel.dismissConfirm()
    expect(panel.confirm()).toBeNull()
    expect(rep.startReplace).not.toHaveBeenCalled()
    expect(panel.canApply()).toBe(true)
  })

  it('切替换模式会把摊开的确认单收起来', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.askApply()
    panel.toggleReplaceMode()
    expect(panel.confirm()).toBeNull()
  })
})

describe('落盘', () => {
  it('confirmApply 递的是与预览同一份条件、同一份根清单、一份空 skip', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.askApply()
    await panel.confirmApply()
    expect(sentReplace()).toEqual({
      roots: ['/repo'],
      query: { pattern: 'needle', literal: false, caseSensitive: false, wholeWord: false, replace: 'NEEDLE' },
      skip: [],
    })
    // 确认单收起来了，否则它会在落盘期间一直摊在屏幕上
    expect(panel.confirm()).toBeNull()
  })

  it('⚠️ 确认单摊开之后条件又变了：一个字节都不落盘，改说「预览已过期」', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.askApply()
    expect(panel.confirm()).not.toBeNull()
    // `askApply` 那一次 `canApply()` 检查已经过去了。确认单虽然盖着面板，
    // 但「变了」这件事不需要经过它：工作区可以在别处被换掉，
    // 而这一条挡的是全 Vela 唯一一处批量写盘
    panel.setReplacement('OTHER')
    await panel.confirmApply()
    expect(rep.startReplace).not.toHaveBeenCalled()
    expect(panel.error()).toBe('预览已过期：条件或工作区改过了，重新搜一遍再替换')
    expect(panel.replacing()).toBe(false)
    expect(panel.confirm()).toBeNull()
  })

  it('⚠️ 确认单摊开之后换了工作区：同样不落盘', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.askApply()
    setRootAt('/other')
    await panel.confirmApply()
    expect(rep.startReplace).not.toHaveBeenCalled()
    expect(panel.error()).toContain('预览已过期')
    // 落盘递的是**当前**的根清单，所以这一步不是「多查一次冗余的检查」：
    // 少了它，用户批准的是 A 而写下去的是 B——两边各自的实现都是对的，
    // 没有任何一边的测试能发现
  })

  it('⚠️ skip 是落盘那一刻求值的，不是预览那一刻', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    // 用户看完预览之后才去改了 b.md，没保存
    dirty = ['/repo/b.md']
    await panel.confirmApply()
    expect(sentReplace().skip).toEqual(['/repo/b.md'])
    // 缓存下来的话这个文件会被落盘盖掉，编辑器里那份未保存的改动就成了孤儿，
    // 而他下一次 ⌘S 又把刚落盘的结果盖回去
  })

  it('飞行途中说进度；一个快照都没来时说「正在替换…」而不是编数字', async () => {
    const gate = deferred<string>()
    rep.startReplace.mockReturnValue(gate.promise)
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.askApply()
    const pending = panel.confirmApply()

    expect(panel.replacing()).toBe(true)
    expect(panel.canApply()).toBe(false)
    // 一个快照都没来是**正常的**（全部文件都没命中时既没有改动触发推送，心跳又远没到），
    // 所以这里给一句不带数字的，而不是显示「已改 0 个文件」假装收到了
    expect(panel.replaceProgress()).toBeNull()
    expect(panel.statusLine()).toBe('正在替换…')

    panel.replaceHandlers.onProgress('r1', { filesScanned: 10, filesChanged: 2, replacements: 5 })
    expect(panel.statusLine()).toBe('正在替换… 已改 2 个文件、5 处（扫过 10 个）')

    gate.resolve('r1')
    await pending
  })

  it('progress 是累计值，直接赋值不是累加', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    const pending = panel.confirmApply()
    panel.replaceHandlers.onProgress('r1', { filesScanned: 10, filesChanged: 1, replacements: 2 })
    panel.replaceHandlers.onProgress('r1', { filesScanned: 40, filesChanged: 3, replacements: 9 })
    expect(panel.replaceProgress()).toEqual({ filesScanned: 40, filesChanged: 3, replacements: 9 })
    panel.replaceHandlers.onDone('r1', rsum())
    await pending
  })

  it('⚠️ done 把预览整个扔掉：留着的话「替换全部」还能再按一次', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE needle']])])
    panel.askApply()
    await panel.confirmApply()
    panel.replaceHandlers.onDone('r1', rsum({ filesScanned: 1, filesChanged: 1, replacements: 2 }))

    expect(panel.replacing()).toBe(false)
    expect(kinds()).toEqual([])
    expect(panel.summary()).toBeNull()
    expect(panel.canApply()).toBe(false)
    expect(panel.statusLine()).toBe('换了 2 处，写进 1 个文件 · 扫过 1 个文件 · 45ms')
    // 行上的 replaced 说的是**写盘之前**的样子，而条件没变、stale 为假，
    // 所以留着的话「替换全部」此刻仍然可点：把 foo 换成 foobar 的人再按一次，
    // 第二轮会接着长——而他看到的预览还是第一轮那份
  })

  it('真的改了东西才通知宿主去对账', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    await panel.confirmApply()
    panel.replaceHandlers.onDone('r1', rsum({ filesChanged: 2 }))
    expect(applied).toHaveLength(1)
    expect(applied[0]?.filesChanged).toBe(2)
  })

  it('一个文件都没改时不打扰宿主', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    await panel.confirmApply()
    panel.replaceHandlers.onDone('r1', rsum({ filesChanged: 0, replacements: 0 }))
    expect(applied).toEqual([])
    expect(panel.statusLine()).toContain('一处都没换')
  })

  it('保留意见换成落盘那一份，每条一行', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])], { unreadable: 1 })
    expect(panel.warnings()).toHaveLength(1)
    await panel.confirmApply()
    panel.replaceHandlers.onDone('r1', rsum({ writeFailed: 2, skippedOpen: 1 }))
    expect(panel.warnings()).toHaveLength(2)
    expect(panel.warnings()[0]).toContain('没写成')
    expect(panel.warnings()[1]).toContain('未保存')
    // 搜索那一份「读不出来」被顶掉了：resetResults 已经清掉搜索总账，
    // 而落盘的 `unreadable` 说的是同一件事，两句一起出现只会让人以为是两个问题
  })

  it('failed 当终止处理，但预览留着（磁盘上一个字节都没动）', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    await panel.confirmApply()
    panel.replaceHandlers.onFailed('r1', { kind: 'not_found', path: '/repo' })
    expect(panel.replacing()).toBe(false)
    expect(panel.error()).toBe('模拟错误：{"kind":"not_found","path":"/repo"}')
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])
    expect(applied).toEqual([])
    expect(panel.canApply()).toBe(true)
  })

  it('startReplace reject = 压根没起飞，磁盘没动，预览留着', async () => {
    rep.startReplace.mockImplementation(() =>
      rejected<string>({ kind: 'bad_replacement', message: '替换模板里的 $ 用法不支持' }),
    )
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    await panel.confirmApply()
    expect(panel.replacing()).toBe(false)
    expect(panel.error()).toBe('模拟错误：{"kind":"bad_replacement","message":"替换模板里的 $ 用法不支持"}')
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])

    // reject 之后不会有事件来，所以此时来的任何事件都是陌生的
    panel.replaceHandlers.onDone('ghost', rsum())
    expect(panel.replaceSummary()).toBeNull()
    await panel.cancel()
    expect(cancelled()).toEqual([])
  })

  it('取消是取消，不是撤销：done 里的 cancelled 与 filesChanged 一起说出来', async () => {
    const gate = deferred<string>()
    rep.startReplace.mockReturnValue(gate.promise)
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    const pending = panel.confirmApply()
    gate.resolve('r1')
    await pending

    await panel.cancel()
    expect(cancelled()).toEqual(['r1'])
    // 状态一律不动：已经推出去的进度仍然有效，由 done 来收尾
    expect(panel.replacing()).toBe(true)

    panel.replaceHandlers.onDone('r1', rsum({ cancelled: true, filesChanged: 2, replacements: 4 }))
    expect(panel.replacing()).toBe(false)
    expect(panel.statusLine()).toContain('已取消（改动不会回滚）')
    expect(panel.statusLine()).toContain('换了 4 处，写进 2 个文件')
    expect(applied).toHaveLength(1)
  })
})

describe('替换在飞时的互斥', () => {
  it('不接新的搜索：那一轮正在改磁盘', async () => {
    const gate = deferred<string>()
    rep.startReplace.mockReturnValue(gate.promise)
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.askApply()
    const pending = panel.confirmApply()
    expect(panel.replacing()).toBe(true)

    await panel.search()
    expect(ipc.startSearch).toHaveBeenCalledTimes(1)
    // 两个「在跑」的信号同时为真时状态栏只能说一句，而那句该说的是正在改磁盘
    expect(panel.statusLine()).toBe('正在替换…')
    expect(kinds()).toEqual(['F:a.ts', 'H:a.ts:1'])

    gate.resolve('r1')
    await pending
  })

  it('cancel 取消在飞的替换', async () => {
    const gate = deferred<string>()
    rep.startReplace.mockReturnValue(gate.promise)
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    const pending = panel.confirmApply()
    // ⚠️ 必须先让 taskId 到手：`cancel_task` 是按 id 取消的，而 `starting` 窗口里
    // 前端手上还没有 id，那一刻「取消」在物理上无从下手（搜索那一边同理）
    gate.resolve('r1')
    await pending

    await panel.cancel()
    expect(cancelled()).toEqual(['r1'])
    // 状态一律不动，由随后的 done 收尾
    expect(panel.replacing()).toBe(true)
  })

  it('clear 会取消在飞的替换，迟到的 done 进不来', async () => {
    const gate = deferred<string>()
    rep.startReplace.mockReturnValue(gate.promise)
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    const pending = panel.confirmApply()
    gate.resolve('r1')
    await pending

    panel.clear()
    expect(cancelled()).toEqual(['r1'])
    expect(panel.replacing()).toBe(false)
    expect(kinds()).toEqual([])

    panel.replaceHandlers.onDone('r1', rsum())
    expect(panel.replaceSummary()).toBeNull()
  })

  it('hide 不打断落盘——它改的是磁盘，收不收起面板都得跑完', async () => {
    const gate = deferred<string>()
    rep.startReplace.mockReturnValue(gate.promise)
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    const pending = panel.confirmApply()
    panel.hide()
    expect(panel.visible()).toBe(false)
    expect(cancelled()).toEqual([])
    expect(panel.replacing()).toBe(true)
    gate.resolve('r1')
    await pending
  })
})

describe('两个 slot 各认各的 taskId', () => {
  it('搜索的 id 拿去发替换事件没有用，反之也一样', async () => {
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    panel.replaceHandlers.onDone('t1', rsum())
    expect(panel.replaceSummary()).toBeNull()
    expect(panel.replacing()).toBe(false)

    panel.handlers.onDone('r1', sum())
    expect(panel.summary()?.hits).toBe(1)
    expect(panel.running()).toBe(false)
  })

  it('⚠️ 替换的 done 比 startReplace 的返回值先到也认得', async () => {
    const gate = deferred<string>()
    rep.startReplace.mockReturnValue(gate.promise)
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    const pending = panel.confirmApply()

    panel.replaceHandlers.onProgress('early', { filesScanned: 3, filesChanged: 1, replacements: 1 })
    panel.replaceHandlers.onDone('early', rsum({ filesScanned: 3, filesChanged: 1, replacements: 1 }))

    gate.resolve('early')
    await pending

    expect(panel.replacing()).toBe(false)
    expect(panel.replaceSummary()?.filesChanged).toBe(1)
    expect(applied).toHaveLength(1)
    // 朴素的「等 invoke 回来再认 id」在这里会让面板永远停在「正在替换…」，
    // 而磁盘其实早改完了——用户很可能再按一次
    await panel.cancel()
    expect(cancelled()).toEqual([])
  })

  it('作废过的替换任务，迟到的进度进不来', async () => {
    const gate = deferred<string>()
    rep.startReplace.mockReturnValue(gate.promise)
    await previewOnce([previewFile('a.ts', [['needle', 'NEEDLE']])])
    const pending = panel.confirmApply()
    gate.resolve('r1')
    await pending

    panel.clear()
    panel.replaceHandlers.onProgress('r1', { filesScanned: 99, filesChanged: 9, replacements: 99 })
    panel.replaceHandlers.onDone('r1', rsum({ filesChanged: 9 }))
    expect(panel.replaceProgress()).toBeNull()
    expect(panel.replaceSummary()).toBeNull()
    expect(applied).toEqual([])
  })
})

describe('结果行上的根名（多根）', () => {
  /** 摊好的那些文件行上的 `root` 字段，按顺序 */
  function rootLabels(): string[] {
    return panel
      .rows()
      .filter((r) => r.kind === 'file')
      .map((r) => r.root)
  }

  it('单根时一律空串：那时每一行前面都挂着同一个项目名，纯噪音', async () => {
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('src/a.ts', ['needle'])], filesScanned: 1 })

    expect(rootLabels()).toEqual([''])
  })

  it('多根时把 rootIndex 换成那个根的显示名', async () => {
    setRootAt(['/repo', '/notes'])
    await searchOnce()
    panel.handlers.onBatch('t1', {
      files: [fileOf('src/a.ts', ['needle']), fileOf('README.md', ['needle'], false, 1)],
      filesScanned: 2,
    })

    expect(rootLabels()).toEqual(['repo', 'notes'])
  })

  it('⚠️ 按**起飞那一刻**的清单解释：结果还在飞的时候移掉一个根，已经摊出来的行不改口', async () => {
    setRootAt(['/repo', '/notes'])
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('README.md', ['needle'], false, 1)], filesScanned: 1 })
    // `stale()` 要求手上先有一份总账（没有总账 = 压根没有预览，说「过期」是无中生有），
    // 所以这一轮要跑完
    panel.handlers.onDone('t1', sum())

    // 用户此刻把 `/notes` 移出了工作区。`rootIndex: 1` 在**新**清单里已经越界了，
    // 现读的话这一行会被标成空串（或者更糟：标成后来加进来的那个根）
    setRootAt(['/repo'])

    expect(rootLabels()).toEqual(['notes'])
    // 而「这份结果不是现在这个工作区的」这件事由 `stale()` 说，不是靠改前缀暗示
    expect(panel.stale()).toBe(true)
  })

  it('越界的 rootIndex 给空串，而不是把 undefined 画到界面上', async () => {
    setRootAt(['/repo', '/notes'])
    await searchOnce()
    panel.handlers.onBatch('t1', { files: [fileOf('a.ts', ['needle'], false, 7)], filesScanned: 1 })

    expect(rootLabels()).toEqual([''])
  })
})
