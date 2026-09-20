import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'solid-js'

/**
 * 分片视图状态层的单测。
 *
 * 与 `document.test.ts` 同一套路子：node 环境、把 IPC 整个 mock 掉。这一层的全部价值是
 * 「窗口 → 该要哪几页」「迟到的响应会不会写坏东西」「缺口怎么显示」，
 * 这三件事都不需要 DOM、不需要真的 Rust，也不需要磁盘上真有一个 200 MB 的文件。
 * 真·端到端（读页的字节算术、夹取、锚点）由 `crates/vela-core/src/fs/shard.rs` 的
 * 23 个测试覆盖，两边各钉一半。
 *
 * ⚠️ 这一份里最贵的两个用例是「缓存预算」那一组：它们要真的把 8 MiB 字符的缓存填满，
 * 也就是 33 页 × 128 行 × 2000 字符。做法是**让 128 行共用同一个字符串引用**
 * （`Array.from({length:128}, () => LONG)`），于是填满预算只花 33 个数组，
 * 而不是 33 × 256 KB 的真实内存。⛔ 别把它改成每行一个新字符串——那会变成一个
 * 每次跑 20 MB 分配的测试，而它想钉的东西一个字都不会多钉住
 */

const { shard, fs } = vi.hoisted(() => ({
  shard: {
    readLines: vi.fn<(args: { handle: number; start: number; count: number }) => Promise<ShardPage | null>>(),
    closeLarge: vi.fn<(handle: number) => Promise<void>>(),
  },
  // describeFsError 换成假的：它自己另有一份测试（`src/ipc/fs.test.ts`），
  // 这里只关心「错误有没有落到 error 里」
  fs: { describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}` },
}))

vi.mock('../ipc/shard', () => shard)
vi.mock('../ipc/fs', () => fs)

import {
  createShardView,
  GAP_TEXT,
  MAX_CACHE_CHARS,
  MAX_ROW_CHARS,
  SHARD_PAGE_LINES,
  SHARD_ROW_HEIGHT,
  type ShardView,
} from './shardView'
import type { ShardHeader, ShardOpen, ShardPage } from '../ipc/shard'
import { OVERSCAN } from '../ui/virtual'

/** Rust 侧的 `ANCHOR_STRIDE`。前端没有它的镜像，这里只是把那条整除关系钉住 */
const ANCHOR_STRIDE = 1024
/** Rust 侧的 `MAX_PAGE_LINES`。同上 */
const MAX_PAGE_LINES = 1024

const HEADER: ShardHeader = {
  totalLines: 100_000,
  bytes: 12_345_678,
  encoding: 'utf8',
  bom: false,
  eol: 'lf',
  lossy: false,
}

function opened(overrides: Partial<ShardOpen> = {}): ShardOpen {
  return { handle: 7, header: HEADER, ...overrides }
}

function pageOf(start: number, lines: string[], overrides: Partial<ShardPage> = {}): ShardPage {
  return { start, lines, truncated: false, lossy: false, ...overrides }
}

/** 默认实现：按请求的 `start` 造一页 `L<行号>`，行号直接写在正文里，串位一眼看得出 */
function autoPage(args: { handle: number; start: number; count: number }): ShardPage {
  return pageOf(
    args.start,
    Array.from({ length: args.count }, (_, i) => `L${args.start + i}`),
  )
}

/** 排空微任务队列。`setTimeout(0)` 而不是 `Promise.resolve()`：后者的次数要靠猜 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 滚到「窗口正好落在第 `grid` 页上」的位置。
 *
 * ⚠️ `viewportHeight` 给 0 时窗口是 `[first - OVERSCAN, first + OVERSCAN)`，
 * 也就是 12 行；这里让 `first` 落在页内第 6 行，于是这 12 行全在同一页里
 */
function topOfGrid(grid: number): number {
  return (grid * SHARD_PAGE_LINES + OVERSCAN) * SHARD_ROW_HEIGHT
}

/**
 * `createShardView` 里有一个 `createMemo`；不在 root 里建，它永远不会被释放，
 * 而 Solid 会往 stderr 上抱怨一句（与 `goto/store.test.ts` 同一条处理）
 */
let teardownRoot: (() => void) | undefined

function harness(init: Partial<ShardOpen> = {}): ShardView {
  let view!: ShardView
  teardownRoot = createRoot((teardown) => {
    view = createShardView(opened(init))
    return teardown
  })
  return view
}

/** 每一次 `readLines` 收到的 `start`，按发出顺序 */
function requestedStarts(): number[] {
  return shard.readLines.mock.calls.map((c) => c[0].start)
}

beforeEach(() => {
  shard.readLines.mockReset()
  shard.closeLarge.mockReset()
  shard.readLines.mockImplementation(async (args) => autoPage(args))
  shard.closeLarge.mockResolvedValue(undefined)
})

afterEach(() => {
  teardownRoot?.()
  teardownRoot = undefined
})

describe('常量之间的关系', () => {
  it('⚠️ 一页的行数远小于 Rust 的上限，而且是锚点步长的整因数', () => {
    // 两条都是**前提**而不是巧合，理由写在 `shardView.ts` 的 `SHARD_PAGE_LINES` 上：
    // 前者是「一次滚动搬多少字节」的取舍，后者让缺口总从某一页的开头算起
    expect(SHARD_PAGE_LINES).toBeLessThan(MAX_PAGE_LINES)
    expect(ANCHOR_STRIDE % SHARD_PAGE_LINES).toBe(0)
  })

  it('缓存预算装得下几十页正常日志，而不是几页', () => {
    // 这一条钉的是量级：预算要是被写成 8 KiB，滚两屏就开始反复读盘，
    // 而「反复读盘」在界面上的样子是「滚回去要等一下」——很难被报成 bug，只会被报成慢
    const normalPageChars = SHARD_PAGE_LINES * 100
    expect(MAX_CACHE_CHARS / normalPageChars).toBeGreaterThan(600)
    // 而每行都被剪到上限的极端文件，也至少装得下几十页
    expect(MAX_CACHE_CHARS / (SHARD_PAGE_LINES * MAX_ROW_CHARS)).toBeGreaterThan(30)
  })
})

describe('预热与基本形状', () => {
  it('建好之后立刻要第一页，不等组件量到 clientHeight', () => {
    harness()
    expect(shard.readLines).toHaveBeenCalledOnce()
    expect(shard.readLines.mock.calls[0]?.[0]).toEqual({ handle: 7, start: 0, count: SHARD_PAGE_LINES })
  })

  it('header 与 totalLines 原样交出来，一个字段都不改', () => {
    const view = harness()
    expect(view.header).toBe(HEADER)
    expect(view.totalLines).toBe(100_000)
  })

  it('totalHeight 只跟总行数走：滚动条长度在建索引那一下就是定的', async () => {
    const view = harness()
    expect(view.totalHeight()).toBe(100_000 * SHARD_ROW_HEIGHT)
    view.scroll(topOfGrid(5), 0)
    await flush()
    // 滚到哪里都不变——它就是那个占位元素的高度
    expect(view.totalHeight()).toBe(100_000 * SHARD_ROW_HEIGHT)
  })

  it('第一页回来之前，窗口里每一行都是 pending', () => {
    shard.readLines.mockReturnValue(new Promise(() => {}))
    const view = harness()
    // jsdom/node 里没有布局，`viewportHeight` 是 0，于是窗口就是 OVERSCAN 行
    expect(view.rows()).toHaveLength(OVERSCAN)
    expect(view.rows().every((r) => r.kind === 'pending')).toBe(true)
    expect(view.rows().every((r) => r.text === '')).toBe(true)
    expect(view.rows().map((r) => r.line)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('第一页回来之后同样的行变成 text，行号是 0 起的', async () => {
    const view = harness()
    expect(view.busy()).toBe(true)
    await flush()
    expect(view.busy()).toBe(false)
    expect(view.error()).toBeNull()
    expect(view.rows()[0]).toEqual({ line: 0, kind: 'text', text: 'L0', clipped: false, lossy: false })
    expect(view.rows().map((r) => r.text)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])
  })

  it('offsetY 是这一批行的顶边，不是滚动位置本身', async () => {
    const view = harness()
    await flush()
    view.scroll(topOfGrid(3), 0)
    await flush()
    // first = 3*128+6，start = first - OVERSCAN = 3*128
    expect(view.rows()[0]?.line).toBe(3 * SHARD_PAGE_LINES)
    expect(view.offsetY()).toBe(3 * SHARD_PAGE_LINES * SHARD_ROW_HEIGHT)
  })
})

describe('窗口 → 请求调度', () => {
  it('滚动跨页时按**页格下标**请求，而不是按行号', async () => {
    const view = harness()
    await flush()
    view.scroll(topOfGrid(3), 0)
    await flush()
    expect(requestedStarts()).toEqual([0, 3 * SHARD_PAGE_LINES])
  })

  it('同一页不重复请求：在同一个位置反复滚动只发一次', async () => {
    const view = harness()
    await flush()
    for (let i = 0; i < 5; i++) view.scroll(topOfGrid(2), 0)
    await flush()
    expect(requestedStarts().filter((s) => s === 2 * SHARD_PAGE_LINES)).toHaveLength(1)
  })

  it('每一页都要 128 行，不多要', () => {
    const view = harness()
    view.scroll(topOfGrid(1), 0)
    view.scroll(topOfGrid(2), 0)
    expect(shard.readLines.mock.calls.every((c) => c[0].count === SHARD_PAGE_LINES)).toBe(true)
  })

  it('🔴 响应乱序回来也不串位——这一层刻意没有请求序号', async () => {
    // 钉的是 `shardView.ts` 文件头那条：缓存按行号寻址 + fd 钉在一个 inode 上，
    // 所以同一个键的两次响应必然相同，「谁先到」没有内容可写坏。
    // ⛔ 哪天有人照着 `goto/store.ts` 补一个 `seq` 进来，这一条会照样绿——
    // 它证明的是「不需要」，不是「不能有」
    const first = deferredPage()
    const second = deferredPage()
    shard.readLines.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const view = harness()
    // 一屏 130 行 → 窗口跨页格 0 与 1
    view.scroll(0, 130 * SHARD_ROW_HEIGHT)
    expect(shard.readLines).toHaveBeenCalledTimes(2)

    // 后发的那一个先回来
    second.resolve(
      pageOf(
        SHARD_PAGE_LINES,
        Array.from({ length: 10 }, (_, i) => `L${SHARD_PAGE_LINES + i}`),
      ),
    )
    await flush()
    first.resolve(
      pageOf(
        0,
        Array.from({ length: SHARD_PAGE_LINES }, (_, i) => `L${i}`),
      ),
    )
    await flush()

    const rows = view.rows()
    expect(rows[0]?.text).toBe('L0')
    expect(rows[SHARD_PAGE_LINES - 1]?.text).toBe(`L${SHARD_PAGE_LINES - 1}`)
    expect(rows[SHARD_PAGE_LINES]?.text).toBe(`L${SHARD_PAGE_LINES}`)
    expect(rows.every((r) => r.kind === 'text')).toBe(true)
  })

  it('⛔ 被字节上限截断的那一页**不补第二轮**', async () => {
    // 补也补不回来：1 MiB 卡的是「从锚点起读了多少字节」，第二轮从同一个锚点重读，
    // 那条超长行又把预算吃光。理由与推演写在 `shardView.ts` 的文件头
    shard.readLines.mockImplementation(async (args) =>
      args.start === 0 ? pageOf(0, ['一条长得离谱的行', '第二条'], { truncated: true }) : autoPage(args),
    )
    const view = harness()
    await flush()
    view.scroll(0, 0)
    await flush()
    view.scroll(0, 0)
    await flush()
    expect(requestedStarts().filter((s) => s === 0)).toHaveLength(1)
  })
})

describe('缺口', () => {
  it('截断页没盖到的行画成 gap，说明只写在第一行', async () => {
    shard.readLines.mockImplementation(async (args) =>
      args.start === 0 ? pageOf(0, ['头一行', '第二行'], { truncated: true }) : autoPage(args),
    )
    const view = harness()
    await flush()
    const rows = view.rows()
    expect(rows.map((r) => r.kind)).toEqual(['text', 'text', 'gap', 'gap', 'gap', 'gap'])
    expect(rows[2]?.text).toBe(GAP_TEXT)
    // 一段连续的缺口只在第一行说话：每行都写一遍的话那六行会变成一片同样的字，
    // 而「一片同样的字」读起来像界面坏了，不像一句解释
    expect(rows[3]?.text).toBe('')
    expect(rows[5]?.text).toBe('')
  })

  it('gap 行不是 pending：它不会被再请求一次', async () => {
    shard.readLines.mockImplementation(async (args) =>
      args.start === 0 ? pageOf(0, ['只有一行'], { truncated: true }) : autoPage(args),
    )
    const view = harness()
    await flush()
    expect(view.rows().some((r) => r.kind === 'gap')).toBe(true)
    expect(view.busy()).toBe(false)
    view.scroll(1, 0)
    await flush()
    expect(requestedStarts().filter((s) => s === 0)).toHaveLength(1)
  })

  it('gap 行的 lossy 跟着**那一页**走，不跟 header', async () => {
    // header.lossy 说的是头部 256 KiB，逐页那个说的是这一页。两者不是一回事，
    // 而「正文里有替换字符」这件事只有逐页那一个知道
    shard.readLines.mockImplementation(async (args) =>
      args.start === 0 ? pageOf(0, ['一行'], { truncated: true, lossy: true }) : autoPage(args),
    )
    const view = harness({ header: { ...HEADER, lossy: false } })
    await flush()
    expect(view.rows().every((r) => r.lossy)).toBe(true)
    expect(view.header.lossy).toBe(false)
  })
})

describe('定位以回来的 page.start 为准', () => {
  it('🔴 页里的行按 page.start 摆，不按自己请求时那个数', async () => {
    // 正常路径下两者相等（`read_page` 只在 `start > total_lines` 时往后夹，
    // 而 `ensure` 压根不会请求超过总行数的页）。这一条钉的是那句文档承诺本身：
    // 万一不等，**以回来的那个为准**。写反的失败方式是安静的——
    // 行号栏显示 128 而正文其实是第 200 行，两个数各自看都对
    shard.readLines.mockImplementation(async (args) =>
      args.start === 0 ? pageOf(3, ['其实是第 3 行', '其实是第 4 行']) : autoPage(args),
    )
    const view = harness()
    await flush()
    const rows = view.rows()
    expect(rows[0]?.kind).toBe('gap')
    expect(rows[1]?.kind).toBe('gap')
    expect(rows[2]?.kind).toBe('gap')
    expect(rows[3]).toEqual({ line: 3, kind: 'text', text: '其实是第 3 行', clipped: false, lossy: false })
    expect(rows[4]?.text).toBe('其实是第 4 行')
    // ⚠️ 第 5 行也画成 gap 而不是 pending：这一层认的规矩是「页在、这一行不在」，
    // 它不去猜为什么不在。正常路径下唯一的原因是字节上限（见上一条用例），
    // 而这里是我们硬造的一个不可能现场——两种画法都不会出现在用户眼前
    expect(rows[5]?.kind).toBe('gap')
  })

  it('滚到文件末尾那一段时，最后一行拿得到', async () => {
    const view = harness({ header: { ...HEADER, totalLines: 130 } })
    await flush()
    // 视口 180px = 10 行，滚到 scrollTop = 120*18 → first = 120，窗口 [114, 130)
    view.scroll(120 * SHARD_ROW_HEIGHT, 10 * SHARD_ROW_HEIGHT)
    await flush()
    const rows = view.rows()
    expect(rows.at(-1)?.line).toBe(129)
    expect(rows.at(-1)?.text).toBe('L129')
    expect(rows.every((r) => r.kind === 'text')).toBe(true)
  })
})

describe('长行', () => {
  it('超过 MAX_ROW_CHARS 的行被剪掉并标 clipped', async () => {
    const long = 'x'.repeat(MAX_ROW_CHARS + 500)
    shard.readLines.mockResolvedValue(pageOf(0, [long]))
    const view = harness()
    await flush()
    const row = view.rows()[0]
    expect(row?.text).toHaveLength(MAX_ROW_CHARS)
    expect(row?.clipped).toBe(true)
  })

  it('正好 MAX_ROW_CHARS 不算剪——闸是「超过」不是「达到」', async () => {
    shard.readLines.mockResolvedValue(pageOf(0, ['y'.repeat(MAX_ROW_CHARS)]))
    const view = harness()
    await flush()
    expect(view.rows()[0]?.clipped).toBe(false)
  })
})

describe('gotoLine', () => {
  it('收 1 起的行号，返回让那一行半屏居中的 scrollTop', () => {
    const view = harness()
    // 先给一个真的视口高度：10 行
    view.scroll(0, 10 * SHARD_ROW_HEIGHT)
    const top = view.gotoLine(1001)
    // 1001（1 起）→ 行下标 1000；居中 = 1000 - 5 = 995
    expect(top).toBe(995 * SHARD_ROW_HEIGHT)
  })

  it('把那一屏的页要过来，而不是只算一个数', async () => {
    const view = harness()
    view.scroll(0, 10 * SHARD_ROW_HEIGHT)
    view.gotoLine(5000)
    await flush()
    // 行下标 4999 落在页格 39（4999 / 128 = 39.05）
    expect(requestedStarts()).toContain(39 * SHARD_PAGE_LINES)
    expect(view.rows().some((r) => r.line === 4999)).toBe(true)
  })

  it('超过总行数落到最后一行，0 与负数落到第一行', () => {
    const view = harness({ header: { ...HEADER, totalLines: 130 } })
    view.scroll(0, 10 * SHARD_ROW_HEIGHT)
    // 最后一行 = 下标 129，居中 = 129 - 5 = 124
    expect(view.gotoLine(99_999)).toBe(124 * SHARD_ROW_HEIGHT)
    expect(view.gotoLine(0)).toBe(0)
    expect(view.gotoLine(-5)).toBe(0)
    expect(view.gotoLine(1)).toBe(0)
  })

  it('⚠️ 视口高度还是 0 时（组件没量到）也不炸，只是不居中', () => {
    const view = harness()
    // jsdom 里 clientHeight 恒为 0，于是 visibleRows 退化成 1、居中量是 0
    expect(view.gotoLine(129)).toBe(128 * SHARD_ROW_HEIGHT)
  })
})

describe('缓存预算', () => {
  /** 一整页都剪到上限：128 × 2000 = 256 000 字符。⚠️ 128 行共用同一个字符串引用 */
  function bigPage(args: { handle: number; start: number; count: number }): ShardPage {
    const long = 'x'.repeat(MAX_ROW_CHARS)
    return pageOf(
      args.start,
      Array.from({ length: args.count }, () => long),
    )
  }

  /** 灌满预算：33 页大页之后，缓存里剩下的是页格 1..32，队首是 1 */
  async function fill(view: ShardView, grids: number[]): Promise<void> {
    for (const grid of grids) {
      view.scroll(topOfGrid(grid), 0)
      await flush()
    }
  }

  it('要灌 33 页才撞预算——这条自己就是量级断言', () => {
    expect(MAX_CACHE_CHARS).toBe(8 * 1024 * 1024)
    expect(Math.floor(MAX_CACHE_CHARS / (SHARD_PAGE_LINES * MAX_ROW_CHARS))).toBe(32)
  })

  it('滚完全程不会把每一页都留着：被淘汰的页再滚回去要重新读盘', async () => {
    shard.readLines.mockImplementation(async (args) => bigPage(args))
    const view = harness()
    await fill(
      view,
      Array.from({ length: 33 }, (_, i) => i),
    )
    const before = requestedStarts().filter((s) => s === 0).length
    expect(before).toBe(1)

    // 页格 0 已经在灌第 33 页时被 FIFO 淘汰了
    view.scroll(topOfGrid(0), 0)
    await flush()
    expect(requestedStarts().filter((s) => s === 0).length).toBe(2)
  })

  it('⚠️ 正在看着的那一页不会被淘汰，哪怕它是队首', async () => {
    // 这一条是整组里唯一能**从外部看出**窗口保护的构造：灌满之后缓存是页格 1..32、
    // 队首是 1，然后把窗口挪到「跨页格 0 与 1」的位置——0 已被淘汰要重读，
    // 1 是队首。存 0 的那一下会触发淘汰，若不看窗口，1 会当场被扔掉，
    // 用户看到的是**眼前的内容变回占位符**
    shard.readLines.mockImplementation(async (args) => bigPage(args))
    const view = harness()
    await fill(
      view,
      Array.from({ length: 33 }, (_, i) => i),
    )

    // first = 129 → 窗口 [123, 135)：上下各 OVERSCAN 行，跨页格 0（123–127）与 1（128–134）
    view.scroll(129 * SHARD_ROW_HEIGHT, 0)
    await flush()

    const rows = view.rows()
    expect(rows.map((r) => r.line)).toEqual([123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134])
    expect(rows.every((r) => r.kind === 'text')).toBe(true)
  })
})

describe('错误与生命周期', () => {
  it('读页失败落进 error，行留成 pending', async () => {
    shard.readLines.mockRejectedValue({ kind: 'io', reason: 'TimedOut', message: '网络卷超时' })
    const view = harness()
    await flush()
    expect(view.error()).toContain('网络卷超时')
    expect(view.busy()).toBe(false)
    expect(view.rows().every((r) => r.kind === 'pending')).toBe(true)
  })

  it('⚠️ 不缓存失败：下一次滚动就重试', async () => {
    // 缓存下来的话，网络卷抖一下会让那一段**永远**空白，而重新滚动也救不回来
    shard.readLines.mockRejectedValueOnce({ kind: 'io', reason: 'TimedOut', message: '第一次失败' })
    const view = harness()
    await flush()
    expect(view.error()).not.toBeNull()

    view.scroll(0, 0)
    await flush()
    expect(requestedStarts().filter((s) => s === 0)).toHaveLength(2)
    expect(view.rows()[0]?.kind).toBe('text')
  })

  it('成功的一页把 error 清掉', async () => {
    shard.readLines.mockRejectedValueOnce({ kind: 'io', reason: 'TimedOut', message: '抖了一下' })
    const view = harness()
    await flush()
    expect(view.error()).not.toBeNull()
    view.scroll(topOfGrid(1), 0)
    await flush()
    expect(view.error()).toBeNull()
  })

  it('🔴 null（句柄已关）被安静忽略：不报错、不缓存、不当成空页', async () => {
    // 这是每天都会发生的时序：滚动 → 请求发出 → 用户关标签 → close_large 先到。
    // ⛔ 连一行警告都不要，而把它当成「有页但零行」会让那几行变成 gap，
    // 于是用户读到一个假的「这一行太长」
    shard.readLines.mockResolvedValue(null)
    const view = harness()
    await flush()
    expect(view.error()).toBeNull()
    expect(view.busy()).toBe(false)
    expect(view.rows().every((r) => r.kind === 'pending')).toBe(true)
  })

  it('dispose 调一次 close_large，而且幂等', () => {
    const view = harness()
    view.dispose()
    view.dispose()
    expect(shard.closeLarge).toHaveBeenCalledOnce()
    expect(shard.closeLarge).toHaveBeenCalledWith(7)
  })

  it('dispose 之后再滚动一个请求都不发', () => {
    const view = harness()
    view.dispose()
    shard.readLines.mockClear()
    view.scroll(topOfGrid(9), 0)
    view.gotoLine(5000)
    expect(shard.readLines).not.toHaveBeenCalled()
  })

  it('dispose 之后迟到的响应不写缓存', async () => {
    const pending = deferredPage()
    shard.readLines.mockReturnValueOnce(pending.promise)
    const view = harness()
    view.dispose()
    pending.resolve(pageOf(0, ['迟到的正文']))
    await flush()
    expect(view.rows().every((r) => r.kind === 'pending')).toBe(true)
    expect(view.busy()).toBe(false)
  })

  it('dispose 之后 close_large 自己失败也不冒出来', async () => {
    // 关不掉没有第二条路（进程退出时操作系统会收 fd），而未处理的 rejection
    // 会在控制台留一行用户动不了的英文
    shard.closeLarge.mockRejectedValue(new Error('通道已断'))
    const view = harness()
    view.dispose()
    await flush()
    expect(shard.closeLarge).toHaveBeenCalledOnce()
  })
})

function deferredPage(): { promise: Promise<ShardPage | null>; resolve: (page: ShardPage | null) => void } {
  let resolve!: (page: ShardPage | null) => void
  const promise = new Promise<ShardPage | null>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
