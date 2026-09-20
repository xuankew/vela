/**
 * 大文件只读分片视图的状态（M2-H-4）。
 *
 * 与 `src/search/store.ts`、`src/goto/store.ts` 同一套分工：**逻辑住在这里、组件只管画**。
 * 这一层不含 DOM、不含 CodeMirror（分片视图压根不用 CM6，理由见文件末尾），
 * 于是「哪一页该去要」「迟到的响应会不会写坏缓存」「缺口怎么显示」这三件最容易出错的事
 * 都能在 node 环境里被单测钉住。
 *
 * ## ⚠️ 窗口算术住在这一层，而不是组件里——与其余三个列表**相反**
 *
 * 文件树、搜索结果、`Cmd+P` 浮层都是组件自己拿 `scrollTop` 算 `visibleWindow`
 * （见 `src/project/Sidebar.tsx` 与 `src/search/FindInFiles.tsx`）。那三处能这么做，
 * 是因为**所有行都已经在内存里了**，窗口纯粹是一件「画哪几行」的事。
 *
 * 分片视图不是：窗口决定**要去磁盘上要哪几页**。把它留在组件里的话，
 * 「该请求什么」这件有副作用的判断就得写在 JSX 的某个 effect 里，
 * 而缓存与淘汰又必须住在这一层——同一件事被劈成两半，两半各持一份窗口。
 * 于是这里收下 `scrollTop` 与 `viewportHeight`，把窗口、缓存、请求收在一处。
 *
 * ## 🔴 这一层**不需要**请求序号，与 `goto/store.ts` 的处境正好相反
 *
 * `goto/store.ts` 里有一个 `let seq = 0`，因为那里同一个键（「列表」）在不同查询下
 * 装的是**不同的内容**，慢的那一次回来会盖掉快的那一次。
 *
 * 这里的缓存是**按行号寻址**的：第 5 页永远是第 640–767 行。而 fd 在 Rust 侧被钉在
 * 建索引时那一个 inode 上（`Shard` 的 `file` 是私有的），所以同一个键的两次响应
 * **必然逐字节相同**——谁先到都一样，「迟到」这件事在这里没有内容可写坏。
 *
 * 于是一个 `disposed` 布尔就够了：它挡的不是「旧内容盖新内容」，
 * 而是「标签已经关了、fd 已经还回去了，响应回来还去写一份没人看的缓存」。
 * ⛔ 不要照抄 `seq`：多一个永远用不上的计数器，下一个人就会以为这里真有时序问题。
 *
 * ## 🔴 页被截断时**不补第二轮**，因为补不回来
 *
 * `ShardPage.truncated` 为真意味着撞了 `MAX_PAGE_BYTES`（1 MiB）。看着像是
 * 「再要一次剩下的行」就行，而实际上那一次请求**一行都拿不回来**：
 * 1 MiB 这个上限卡的是**从锚点起读进来的字节数**，不是「返回的那几行有多少字节」。
 * 于是第二轮从同一个锚点重读，那条超长行又把预算吃光，
 * `read_page` 里 `from == to`，回来一个 `truncated: true` 加一个空 `lines`。
 *
 * 正确做法是**如实画一个缺口**（`ShardRow.kind === 'gap'`）。而它会自愈：
 * 锚点每 `ANCHOR_STRIDE`（1024）行一个，滚进下一段就从新的偏移起读，
 * 那条超长行不再在预算里。所以缺口的最大长度是「1024 行减去已给的那些」，
 * 而不是「一直到文件末尾」。
 */

import { createMemo, createRoot, createSignal, type Accessor } from 'solid-js'
import { describeFsError } from '../ipc/fs'
import { closeLarge, readLines, type ShardHeader, type ShardOpen, type ShardPage } from '../ipc/shard'
import { visibleWindow, type VirtualWindow } from '../ui/virtual'

/**
 * 一行的高度（px）。
 *
 * 🔴 **组件必须 import 这一个常量去写行内高度**，⛔ 不要在 CSS 里另写一份 `18px`。
 * 两处不等的话失败方式是安静的：`visibleWindow` 按 18 算出该画哪几行，
 * 而浏览器按 CSS 那个数排它们，于是滚动位置与内容慢慢错开，
 * 症状是「滚到一半行号对不上」，而两个数各自看都是对的。
 *
 * 比文件树（22）与搜索结果（20）都矮：分片视图的行号栏是等宽数字、正文不换行，
 * 一屏多装几行比行距宽松更值钱——这是唯一一个「看」而不是「读」的列表
 */
export const SHARD_ROW_HEIGHT = 18

/**
 * 一次向 Rust 要多少行。
 *
 * 刻意**远小于** Rust 侧的 `MAX_PAGE_LINES`（1024）。一屏约 57 行，128 行的页
 * 让一次滚动通常只发一个请求、最坏两个；而 1024 行的页虽然请求数一样是 1，
 * 却每次搬 8 倍的字节——那些字节里 94% 用户压根没滚到。
 *
 * ⚠️ 128 与 `ANCHOR_STRIDE`（1024）是整数倍关系，这不是巧合而是前提：
 * 一条超长行毒化的是**整个锚点段**，段长是页长的整数倍时，
 * 缺口才总是从某一页的开头算起，`kind === 'gap'` 的连续段也就总是能被 `rows()` 认出来
 */
export const SHARD_PAGE_LINES = 128

/**
 * 缓存的预算，单位是**字符数**而不是字节数。
 *
 * ⚠️ 这是一个**近似**：一个汉字是一个 UTF-16 单元、却是 3 个 UTF-8 字节，
 * 所以按字符记账最多会把真实占用低估 3 倍。刻意不换算成字节——
 * 这份预算要挡的是「把一个 256 MiB 的 ASCII 日志从头滚到尾」：那是 2680 万行、
 * ~21 万页，正文本身 0.5 GB（UTF-16）再加两千多万个小字符串的对象头。
 * 挡这么一个量级不需要精确到 MB，而为一个粗粒度的闸去算精确的账，
 * 只会让每次插入都多跑一遍编码。
 *
 * 8 MiB 字符在正常日志（一行 ~100 字符）下是 ~8.4 万行、~655 页；
 * 在每行都被 `MAX_ROW_CHARS` 剪过的极端文件下是 32 页——
 * 而后者正是内存最要紧的那种现场，所以「按字符记」在这里偏保守，方向是对的
 */
export const MAX_CACHE_CHARS = 8 * 1024 * 1024

/**
 * 一行最多显示多少字符。
 *
 * 不设这个闸的话，一条 1 MiB 的行（压缩过的 JSON、`tr '\n' ' '` 的产物）
 * 会变成一个 100 万字符的文本节点，而它在 `overflow: hidden` 下**只能看见头 200 个**——
 * 剩下 99.98% 是纯粹的布局开销，每次滚动都重排一遍。
 *
 * ⚠️ 剪掉的部分**不存**在缓存里，所以 `ShardRow.clipped` 说的是「这一行原本更长」，
 * 而不是「往右滚还能看到」。分片视图没有横向滚动
 */
export const MAX_ROW_CHARS = 2000

/** 缺口那一行显示的话。⚠️ 一段连续的缺口只在**第一行**写出来，其余留白 */
export const GAP_TEXT = '这一行太长，取不出来——继续往下滚会重新接上'

/** 视图里的一行。⚠️ 只有 `kind === 'text'` 时 `text` 才是文件内容 */
export interface ShardRow {
  /** 绝对行号，**0 起**。行号栏显示的是它 +1（与 `totalLines` 的 `wc -l` 口径一致） */
  readonly line: number
  /**
   * - `text`：拿到了这一行的正文
   * - `pending`：这一页还在飞（或还没请求），组件画一个占位
   * - `gap`：这一页被字节上限截断了，没盖到这一行。理由与自愈见文件头
   */
  readonly kind: 'text' | 'pending' | 'gap'
  /** 要画出来的字。`pending` 与 `gap` 的非首行是空串 */
  readonly text: string
  /** 这一行被 `MAX_ROW_CHARS` 剪过。组件据此补一个省略号 */
  readonly clipped: boolean
  /** 这一页解码有损，正文里含 U+FFFD。⚠️ 与 `header.lossy` 不是一回事：那个说的是头部 256 KiB */
  readonly lossy: boolean
}

interface CachedLine {
  readonly text: string
  readonly clipped: boolean
}

interface CachedPage {
  /** 🔴 Rust **夹过**的那一个，定位一律用它，⛔ 不用请求时那个 `grid * SHARD_PAGE_LINES` */
  readonly start: number
  readonly lines: CachedLine[]
  readonly lossy: boolean
  /** `lines` 的字符数之和，存下来是为了淘汰时不必重算一遍 */
  readonly chars: number
}

export interface ShardView {
  /** 元信息。**常量**而不是 Accessor：要看新内容只能整个重开一次分片（见 `Shard` 的文档） */
  readonly header: ShardHeader
  /** `header.totalLines` 的别名，为的是调用方不必知道它藏在 header 里 */
  readonly totalLines: number
  readonly rows: Accessor<ShardRow[]>
  /** 这一批行的顶边离列表顶边多少像素 */
  readonly offsetY: Accessor<number>
  /** 滚动容器里那个占位元素的总高度 */
  readonly totalHeight: Accessor<number>
  /** 还有页在飞 */
  readonly busy: Accessor<boolean>
  /** 最近一次读页失败的人话。`null` = 没有 */
  readonly error: Accessor<string | null>
  /**
   * 组件的 `onScroll` 直接转发过来。
   *
   * ⚠️ 它**既改窗口又要页**，所以不能只挂在一个只改 `scrollTop` 信号的 effect 上
   */
  scroll(scrollTop: number, viewportHeight: number): void
  /**
   * 最近一次 `gotoLine` 想让滚动条落在哪儿。`null` = 还没跳过。
   *
   * 组件在自己的 effect 里读它、赋给 `el.scrollTop`——滚动条是 DOM 的东西，
   * 而这一层压根不认识 DOM（见文件头那条分工）。
   *
   * 🔴 **收的是一个新对象而不是一个数字**，与 `goto/store.ts` 的 `focusRequest` 同一套路：
   * 用户手动滚走之后再点同一条搜索结果，`top` 算出来是同一个数，数字信号不会变、
   * effect 不会跑，界面就一动不动。每次一个新引用，「跳」这件事才永远是一次事件
   *
   * ⚠️ 而 `scroll()` 刻意**不**写它：普通滚动是 DOM 告诉这一层位置，反着写回去
   * 等于在每次 scroll 事件里多一次 `el.scrollTop = el.scrollTop`
   */
  readonly jumpTo: Accessor<{ readonly top: number } | null>
  /**
   * 跳到某一行：把那一屏的页要过来，并往 `jumpTo` 上放一个新请求。
   *
   * @param line **1 起**的行号——搜索结果与 `:42` 都是这个口径。内部一律 0 起，
   * 这一处是唯一的换算点
   *
   * ## ⚠️ 为什么分片视图也需要「跳到某一行」
   *
   * 全局搜索收文件的上限是 64 MiB（`crates/vela-core/src/search/run.rs` 的 `MAX_FILE_BYTES`），
   * 而整份进内存的上限是 4 MiB（`fs/read.rs` 的 `MAX_INLINE_BYTES`）。
   * 于是 **4–64 MiB 这一段里的文件搜得到、却是以分片方式打开的**。
   * 没有这一个方法的话，点那样一条搜索结果会安静地停在第 0 行——
   * 那比今天直接报错还糟：用户以为「这个文件里没有我搜的那句话」
   *
   * @returns 算出来的那个 `top`。组件不需要它（它读 `jumpTo`），
   * 留着是为了让「跳到哪儿」这件事在测试里可以直接断言，不必去翻 DOM
   */
  gotoLine(line: number): number
  /**
   * 关掉这个分片。
   *
   * 🔴 **必须调**，而它是 Vela 里唯一一个「不调就会漏」的收尾（理由见 `ipc/shard.ts`
   * 的 `closeLarge`）。三处调用点：标签关闭、窗口关闭、外部改了文件之后重开分片。
   */
  dispose(): void
}

/**
 * 建一个分片视图。`opened` 是 `openLarge` 的返回值——**这一层不发 `open_large`**，
 * 因为「什么时候该走分片而不是内联」是 `document.ts` 的判断（只有它才知道 `openFile`
 * 回的是不是 `too_large`），而两个视图共用一个句柄是 bug 不是优化。
 *
 * ⚠️ 建好之后**立刻**要第一页：组件量到 `clientHeight` 之前用户就该看到内容，
 * 而不是先看一屏占位符再闪一下
 */
export function createShardView(opened: ShardOpen): ShardView {
  const { handle, header } = opened
  const totalLines = header.totalLines

  // 第一帧的窗口：`viewportHeight` 这会儿还给不出来（组件要等挂载之后才量得到
  // `clientHeight`），于是 `visibleWindow` 走它那条「高度为 0 就给 OVERSCAN 行」的分支——
  // 正好是头几行，也正是末尾那一次预热该要的页
  const initial = visibleWindow(0, 0, totalLines, SHARD_ROW_HEIGHT)

  /** 键是**页格下标**（`Math.floor(行号 / SHARD_PAGE_LINES)`），不是行号 */
  const cache = new Map<number, CachedPage>()
  const inflight = new Set<number>()
  let cachedChars = 0
  let disposed = false
  /** 最近一次的可视区高度，只给 `gotoLine` 算居中用。jsdom 里恒为 0 */
  let viewport = 0
  /** 窗口两端，淘汰时用来保住正在看着的那几页 */
  let winStart = initial.start
  let winEnd = initial.end

  /**
   * 缓存变了就加一。
   *
   * `Map` 不是响应式的，而 `rows()` 必须知道「这一页刚刚回来了」。
   * 把整个缓存塞进一个 signal 也行，但那意味着每次插入都拷一份 Map，
   * 而这份缓存最多几千条——一个计数器加一次 `Map.get` 便宜得多
   */
  const [cacheVersion, bumpCache] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [win, setWin] = createSignal<VirtualWindow>(initial)
  const [jumpTo, setJumpTo] = createSignal<{ readonly top: number } | null>(null)

  /**
   * 腾出 `need` 个字符的空间。**FIFO**（Map 的插入顺序），不是 LRU。
   *
   * LRU 要在每次 `rows()` 重算时把当前页「摸一下」提到队尾，而 `rows()` 是个 memo——
   * 在里面改缓存顺序等于在渲染路径上写状态，Solid 的追踪会当场打架。
   * FIFO 的代价是「滚回去要重新读一次盘」，而分片视图的读者本来就在单向滚一个日志
   *
   * ⚠️ **窗口里那几页一律跳过**：淘汰掉用户正看着的页，症状是内容在眼前变回占位符。
   * 于是预算可以被超出，超出的上限正好是一个窗口（≤ 两页）——这是有意的，
   * 「宁可多留两页也不要在眼前闪」
   */
  function evict(need: number) {
    if (cachedChars + need <= MAX_CACHE_CHARS) return
    // 拷一份键：淘汰会改 Map，而「跳过窗口内的页」意味着这一趟不一定删得动
    for (const grid of [...cache.keys()]) {
      if (cachedChars + need <= MAX_CACHE_CHARS) return
      const from = grid * SHARD_PAGE_LINES
      if (from < winEnd && from + SHARD_PAGE_LINES > winStart) continue
      const page = cache.get(grid)
      if (page === undefined) continue
      cache.delete(grid)
      cachedChars -= page.chars
    }
  }

  function store(grid: number, page: ShardPage) {
    const lines: CachedLine[] = page.lines.map((raw) =>
      raw.length > MAX_ROW_CHARS ? { text: raw.slice(0, MAX_ROW_CHARS), clipped: true } : { text: raw, clipped: false },
    )
    const chars = lines.reduce((n, line) => n + line.text.length, 0)
    evict(chars)
    cache.set(grid, { start: page.start, lines, lossy: page.lossy, chars })
    cachedChars += chars
  }

  async function fetchPage(grid: number) {
    try {
      const page = await readLines({ handle, start: grid * SHARD_PAGE_LINES, count: SHARD_PAGE_LINES })
      if (disposed) return
      // `null` = 句柄已经关了（用户关了标签，而这一次请求还在飞）。
      // ⛔ 连一行警告都不要：这是每天都会发生的正常时序，见 `ipc/shard.ts`
      if (page === null) return
      store(grid, page)
      setError(null)
    } catch (err) {
      if (disposed) return
      // ⚠️ **不缓存失败**：网络卷抖一下就报错的话，缓存下来会让那一段永远空白，
      // 而不缓存的话下一次滚动就会重试
      setError(describeFsError(err))
    } finally {
      inflight.delete(grid)
      setBusy(inflight.size > 0)
      bumpCache((n) => n + 1)
    }
  }

  /** 把 `[start, end)` 这几行需要的页要过来。已经缓存的与在飞的一律跳过 */
  function ensure(start: number, end: number) {
    if (disposed || end <= start) return
    const first = Math.floor(start / SHARD_PAGE_LINES)
    const last = Math.floor((end - 1) / SHARD_PAGE_LINES)
    let added = false
    for (let grid = first; grid <= last; grid++) {
      if (cache.has(grid) || inflight.has(grid)) continue
      inflight.add(grid)
      added = true
      void fetchPage(grid)
    }
    if (added) setBusy(true)
  }

  /**
   * 🔴 这个 memo 裹在 `createRoot` 里，因为 `createShardView` 是在**没有 owner** 的时候
   * 被调的：它唯一的调用点是 `document.ts` 的 `openAsShard`，而那已经在
   * `await openLarge(...)` 之后，早脱离了任何组件的 computation。裸建一个 memo 的话
   * Solid 会当场警告「computations created outside a `createRoot` or `render` will never
   * be disposed」，而且警告说的是实情：没有 owner 就没人把它登记进 children 列表，
   * 于是 `dispose()` 也收不到它。
   *
   * 靠 GC 其实收得掉（它与外界只有 signal 那几条边，视图一没人引用就一起走），但那是
   * 「碰巧没事」而不是「被管住了」。`dispose` 已经是这个视图明确的拆解点，让它把 memo
   * 一并拆掉，契约才完整——而这个视图偏偏是 Vela 里唯一一个不调 `dispose` 就会漏 fd 的
   * 东西，它的拆解路径值得写得比别处更实。
   *
   * ⚠️ 只裹 memo，不裹上面那几个 `createSignal`：signal 不是 computation，裸建既不警告
   * 也不需要拆，裹进来只会让整段代码白缩进一层。
   */
  let disposeRows = () => {}
  const rows = createRoot<Accessor<ShardRow[]>>((teardown) => {
    // ⚠️ 参数不叫 `dispose`：这个作用域里已经有一个 `function dispose()`，
    // 遮蔽了虽然也能跑，但读的人会以为是递归
    disposeRows = teardown
    return createMemo<ShardRow[]>(() => {
      cacheVersion()
      const w = win()
      const out: ShardRow[] = []
      let inGap = false
      for (let i = w.start; i < w.end; i++) {
        const page = cache.get(Math.floor(i / SHARD_PAGE_LINES))
        if (page === undefined) {
          inGap = false
          out.push({ line: i, kind: 'pending', text: '', clipped: false, lossy: false })
          continue
        }
        // ⚠️ 用 `page.start` 定位，不用 `grid * SHARD_PAGE_LINES`：前者是 Rust 夹过的
        const line = page.lines[i - page.start]
        if (line !== undefined) {
          inGap = false
          out.push({ line: i, kind: 'text', text: line.text, clipped: line.clipped, lossy: page.lossy })
          continue
        }
        // 页在、这一行不在 → 只可能是字节上限留下的缺口：读到 EOF 不算截断，
        // 而 EOF 之后的行压根不在窗口里（窗口的 total 就是 `totalLines`）
        out.push({ line: i, kind: 'gap', text: inGap ? '' : GAP_TEXT, clipped: false, lossy: page.lossy })
        inGap = true
      }
      return out
    })
  })

  function scroll(scrollTop: number, viewportHeight: number) {
    if (disposed) return
    viewport = viewportHeight
    const next = visibleWindow(scrollTop, viewportHeight, totalLines, SHARD_ROW_HEIGHT)
    winStart = next.start
    winEnd = next.end
    setWin(next)
    ensure(next.start, next.end)
  }

  function gotoLine(line: number): number {
    const target = Math.min(Math.max(0, Math.floor(line) - 1), Math.max(0, totalLines - 1))
    // 目标行放在**半屏**处而不是顶端：跳过去之后用户要看的是上下文，
    // 而「命中的那一行贴在最上面」读起来像是被截断了
    const visibleRows = Math.max(1, Math.floor(viewport / SHARD_ROW_HEIGHT))
    const top = Math.max(0, (target - Math.floor(visibleRows / 2)) * SHARD_ROW_HEIGHT)
    scroll(top, viewport)
    setJumpTo({ top })
    return top
  }

  function dispose() {
    if (disposed) return
    disposed = true
    disposeRows()
    inflight.clear()
    cache.clear()
    cachedChars = 0
    setBusy(false)
    void closeLarge(handle).catch(() => {
      // 关不掉也没有第二条路：进程退出时操作系统会收这个 fd。
      // 让一个未处理的 rejection 冒上去，用户看到的是一行他动不了的英文
    })
  }

  // 预热第一页。⚠️ 排在所有函数定义之后：`ensure` → `fetchPage` 会立刻发一次 IPC，
  // 而它的响应可能在同步代码跑完之前就落地
  ensure(initial.start, initial.end)

  return {
    header,
    totalLines,
    rows,
    offsetY: () => win().offsetY,
    totalHeight: () => win().totalHeight,
    busy,
    error,
    scroll,
    jumpTo,
    gotoLine,
    dispose,
  }
}
