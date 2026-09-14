/**
 * TODO(M0-自动扫描)：临时实验代码，M0 归因完成后整个文件删除。
 *
 * 存在的理由：webview 内部的探针数据从外面读不到，靠人在 WKWebView 窗口里按时间表
 * 点按钮既慢又测不准——#7「空转内存」的归因就连续几次被人工操作卡住。这个模块把
 * 「切换文档 → 等待稳定 → 采样 → 落盘」全部自动化，承载两组测量：
 *
 * - `runSweep`：#7 的内存扫描，与外部的 `footprint` 采样器按阶段切换对齐。
 * - `runScrollMatrix`：#1 的滚动矩阵，程序化驱动 scrollTop 并采帧计时。
 *
 * **只在窗口可见时推进**：上一轮 8 个样本里有 5 个是 `visibilityState=hidden`，
 * 而 hidden 时 WebKit 不渲染、会释放图层与字形缓存，那种读数不是产品交付形态，
 * 拿它判 #7 会系统性偏乐观。与其事后剔除脏样本，不如让时钟在被遮挡时停走。
 */
import { invoke } from '@tauri-apps/api/core'
import { type FontApplyResult } from '../fonts/loader'
import {
  collectFontFaces,
  collectMemory,
  collectProcessUptime,
  FpsSampler,
  loadShardManifest,
  measureShardBytes,
  type FpsStats,
  type ShardManifest,
} from './metrics'

export type SweepDoc =
  | 'empty'
  | 'mixed-10k'
  | 'mixed-10k-common'
  | 'ascii-10k'
  | 'mixed-20k'
  | 'mixed-50k'

interface Stage {
  doc: SweepDoc
  holdMs: number
  note: string
  /** 设了这个就按该间隔重复采样，而不是只在阶段末尾采一点 */
  everyMs?: number
}

const STAGES: Stage[] = [
  {
    doc: 'empty',
    holdMs: 90_000,
    everyMs: 15_000,
    note: '#7 判据档 · 冷启动后空文档空转。上一轮单点读到 209MB 超标，但 WebContent 在 97~144MB 之间震荡，必须多点采样才能区分瞬态峰值与稳态',
  },
  { doc: 'mixed-10k', holdMs: 30_000, note: '真实负载 · 10k 中英混排，触发 CJK 分片' },
  {
    doc: 'ascii-10k',
    holdMs: 30_000,
    note: '对照组 · 同 10k 行纯 ASCII，不触发 CJK 分片；与上一行之差即字体的净成本',
  },
  { doc: 'empty', holdMs: 30_000, note: '回落 · 验证 CM6 destroy 后内存是否归还' },
]

// 刻意不含 20k / 50k：#7 的判据是空转内存，压力档既非判据所需，
// 且在窗口可见时（真实排版 + 97 个 @font-face）会把机器推进交换态。
// 压力档由下面的 runScrollMatrix 在 #1 里自动覆盖，不需要人手动点。

const SETTLE_MS = 3_000
const TICK_MS = 250
/** 连续被遮挡超过这个时长就放弃本轮，而不是无限期挂着 */
const MAX_HIDDEN_MS = 120_000

/**
 * 只累计「窗口可见」时间的等待。
 *
 * 为什么不用一个长 setTimeout：上一轮实测，窗口被遮挡时 WKWebView 会挂起长定时器，
 * 20s 的 setTimeout 三分钟内一次都没触发，整轮扫描只写出一个样本就卡死。
 * 250ms 步进即使被节流也能恢复；用墙上时钟差值累计则不会因节流而少等。
 *
 * 返回 'aborted' 表示窗口被遮挡太久，本轮数据到此为止。
 */
async function advance(ms: number): Promise<'ok' | 'aborted'> {
  let visible = 0
  let hidden = 0
  let last = Date.now()
  while (visible < ms) {
    await new Promise<void>((r) => window.setTimeout(r, TICK_MS))
    const now = Date.now()
    const dt = now - last
    last = now
    if (document.visibilityState === 'visible') {
      visible += dt
      hidden = 0
    } else {
      hidden += dt
      if (hidden > MAX_HIDDEN_MS) return 'aborted'
    }
  }
  return 'ok'
}

interface Hooks {
  load: (doc: SweepDoc) => void
  stats: () => unknown
  fontResult: () => FontApplyResult | null
  /**
   * 验收项 #6 的端到端读数：Rust 进程启动 → 编辑器可输入。
   * 面板里有这个数，但面板在 webview 内、外面读不到，
   * 所以扫描报告必须自己带一份，否则 #6 只能拿一个上界去推。
   */
  processToReadyMs: () => number | null
}

/** 清单 300KB 且整个扫描期间不变，读一次就够；每个样本都读会把 IPC 开销算进采样窗口 */
let shardManifest: ShardManifest | null = null

async function manifest(): Promise<ShardManifest | null> {
  if (!shardManifest) shardManifest = await loadShardManifest()
  return shardManifest
}

async function sample(hooks: Hooks, phase: string, stage: Stage) {
  const [uptime, mem] = [await collectProcessUptime(), await collectMemory()]
  const mf = await manifest()
  // 不过滤 family：D2 之后代码区是 Maple Mono CN，只数 'lxgw' 会漏掉那 239 个分片
  const faces = collectFontFaces()
  const facesLoaded = faces.filter((f) => f.status === 'loaded').length
  return {
    at: new Date().toISOString(),
    phase,
    doc: stage.doc,
    note: stage.note,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    processUptimeMs: uptime,
    rustRssKb: mem.rustRssKb,
    // 恒为 0：performance.memory 是 Chromium 私有 API，WKWebView 不实现。
    // 留着是为了把这个「探针失效」的事实记进报告，别下次又去读它。
    jsHeapUsedBytes: mem.jsHeapUsedBytes,
    font: {
      applied: hooks.fontResult(),
      // #4 的判据值：查清单得到的真实字节数，不再是「face 数 × 平均体积」的估算
      // （分片大小不均，那个口径能偏 ±50%）。清单没生成时报 null 而不是猜一个数。
      shards: mf ? measureShardBytes(mf) : null,
      facesLoaded,
      facesTotal: faces.length,
    },
    docStats: hooks.stats(),
  }
}

export async function runSweep(hooks: Hooks): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return

  const samples: unknown[] = []
  const startedAt = new Date().toISOString()
  let aborted: string | null = null

  const flush = async () => {
    const payload = {
      kind: 'm0-auto-sweep',
      startedAt,
      updatedAt: new Date().toISOString(),
      aborted,
      processToReadyMs: hooks.processToReadyMs(),
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      samples,
    }
    try {
      await invoke<string>('save_probe_slot', { slot: 'report', json: JSON.stringify(payload, null, 2) })
    } catch {
      // 落盘失败不该中断扫描，数据仍在内存里
    }
  }

  // 先等窗口真的可见再开始。50ms 的可见时间等于「已经可见且没在被遮挡的瞬间」。
  if ((await advance(50)) === 'aborted') {
    aborted = '窗口在扫描开始前被遮挡超过 120s，本轮作废'
    await flush()
    return
  }

  for (const stage of STAGES) {
    hooks.load(stage.doc)
    if ((await advance(SETTLE_MS)) === 'aborted') {
      aborted = `阶段 ${stage.doc} 稳定期被遮挡`
      break
    }
    samples.push(await sample(hooks, 'post-load', stage))
    await flush()

    if (stage.everyMs) {
      const reps = Math.max(1, Math.round((stage.holdMs - SETTLE_MS) / stage.everyMs))
      for (let i = 1; i <= reps; i++) {
        if ((await advance(stage.everyMs)) === 'aborted') {
          aborted = `阶段 ${stage.doc} 第 ${i} 次间隔采样时被遮挡`
          break
        }
        samples.push(await sample(hooks, `idle-${i}`, stage))
        await flush()
      }
    } else if ((await advance(stage.holdMs - SETTLE_MS)) === 'aborted') {
      aborted = `阶段 ${stage.doc} 保持期被遮挡`
    } else {
      samples.push(await sample(hooks, 'settled', stage))
      await flush()
    }

    if (aborted) break
  }

  samples.push({ kind: 'done', at: new Date().toISOString(), aborted })
  await flush()
}

// ─────────────────────────────────────────────────────────────────────────────
// 验收 #1：滚动手感的客观一半
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ 这个矩阵**答不了 #1 的验收问题**，只能给回归基线，别把它当成「手感通过」。
 *
 * 程序化写 `scrollTop` 触发的是 CM6 的 scroll 事件 → 视口重算 → 重绘，
 * 但绕开了触控板惯性滚动经 WKWebView 原生手势路径的那一段，而
 * tauri-apps/discussions#8436 报告的「微延迟」恰好在那条路径上。
 * 所以「手感」仍需人滚 30 秒确认；这里量的是「同样的滚动负载下帧计时有没有退化」，
 * 用途是阶段间回归对比，以及把 4 个组合的客观数字一次性采齐、不靠人抄。
 */

export interface ScrollSample extends FpsStats {
  doc: SweepDoc
  lineWrap: boolean
  /** 速度口径：realistic（贴近人手的恒速）或 extreme（全范围三角波，纯压力测试） */
  speed: 'realistic' | 'extreme'
  visibility: string
  at: string
  /** 可滚动总高度。<= 0 说明文档没撑出滚动条，这一档无效 */
  scrollRangePx: number
  /** 3s 内实际滚过的像素总量。用来证明两档速度确实差了两个数量级 */
  travelPx: number
  /** travelPx / 实际窗口时长，人读的速度口径 */
  achievedPxPerS: number
  /** 实际推进的帧数，3s @60Hz 应约 180；远低于此说明 rAF 被冻结或节流 */
  scrollSteps: number
  /** 非 null 表示这一档没测干净，读数作废 */
  aborted: string | null
}

export interface ScrollMatrixHooks {
  load: (doc: SweepDoc) => void
  setWrap: (wrap: boolean) => void
  /** CM6 的滚动容器，矩阵程序化驱动它的 scrollTop */
  scroller: () => HTMLElement | null
  /**
   * 采样窗口内必须停掉面板的 3s 轮询：`probe_memory` 在 Rust 侧会 fork 一个 `ps`
   * 子进程，回调里还要遍历 97 个 FontFace。落在采样窗口里会在主线程砸出超过 33ms
   * 的帧，被 `jankFrames` 记成卡顿——那是探针自己在制造噪声。
   */
  pausePolling: () => void
  resumePolling: () => void
  /** 每采完一档回调一次。矩阵跑完四档约 30s，没有进度出口时界面看起来像卡死 */
  onSample?: (sample: ScrollSample, index: number, total: number) => void
}

/** #1 要覆盖的四个组合：文档量 × 换行开关 */
const SCROLL_COMBOS: { doc: SweepDoc; lineWrap: boolean }[] = [
  { doc: 'mixed-10k', lineWrap: true },
  { doc: 'mixed-10k', lineWrap: false },
  { doc: 'mixed-50k', lineWrap: true },
  { doc: 'mixed-50k', lineWrap: false },
]

/**
 * 每个组合跑两种速度口径，缺一不可：
 *
 * - `realistic` 3000px/s ≈ 每秒 214 行，是触控板正常滑动的量级，**判「手感」看这一档**。
 * - `extreme` 全范围三角波。10k 换行档范围 19 万 px、3s 跑完一个来回 = **12.7 万 px/s**，
 *   比人手快两个数量级。它不是手感口径，是上界压力测试：这一档都能守住 p95，
 *   说明掉帧不是滚动速度造成的。
 *
 * 只测 extreme 会把「压力测试没跑满 60fps」误读成「日常滚动卡顿」。
 */
const SCROLL_SPEEDS: { id: 'realistic' | 'extreme'; pxPerS: number }[] = [
  { id: 'realistic', pxPerS: 3_000 },
  { id: 'extreme', pxPerS: 0 },
]

const SCROLL_MS = 3_000
/** rAF 被冻结时 tick 不会再被回调，只能靠外部看门狗把 promise 放出来 */
const SCROLL_WALL_CAP_MS = SCROLL_MS * 3
const MIN_STEPS = 100

const EMPTY_STATS: FpsStats = {
  samples: 0,
  avgFps: 0,
  minFps: 0,
  p95FrameMs: 0,
  maxFrameMs: 0,
  jankFrames: 0,
  windowMs: 0,
}

async function sampleScroll(
  hooks: ScrollMatrixHooks,
  combo: { doc: SweepDoc; lineWrap: boolean },
  speed: { id: 'realistic' | 'extreme'; pxPerS: number },
): Promise<ScrollSample> {
  const label = { doc: combo.doc, lineWrap: combo.lineWrap, speed: speed.id }
  const el = hooks.scroller()
  if (!el) {
    return {
      ...EMPTY_STATS,
      ...label,
      visibility: document.visibilityState,
      at: new Date().toISOString(),
      scrollRangePx: 0,
      travelPx: 0,
      achievedPxPerS: 0,
      scrollSteps: 0,
      aborted: 'CM6 滚动容器取不到',
    }
  }

  const range = el.scrollHeight - el.clientHeight
  hooks.pausePolling()
  const sampler = new FpsSampler()
  sampler.start()

  let steps = 0
  let travelPx = 0
  let elapsedMs = 0
  let aborted: string | null = null
  await new Promise<void>((done) => {
    let watchdog = 0
    let finished = false
    const finish = (reason: string | null) => {
      if (finished) return
      finished = true
      window.clearTimeout(watchdog)
      if (reason) aborted = reason
      done()
    }
    watchdog = window.setTimeout(
      () => finish('滚动推进卡死（rAF 长时间未回调），这一档作废'),
      SCROLL_WALL_CAP_MS,
    )
    const t0 = performance.now()
    // realistic 档的状态：恒速推进，撞到上下边界就反弹
    let pos = 0
    let dir = 1
    let last = 0
    const tick = () => {
      if (document.visibilityState !== 'visible') {
        finish('采样途中窗口被遮挡，rAF 冻结')
        return
      }
      const t = performance.now() - t0
      if (t >= SCROLL_MS) {
        elapsedMs = t
        finish(null)
        return
      }
      elapsedMs = t
      if (speed.pxPerS > 0) {
        // 用真实 dt 而不是固定步长：掉帧时固定步长会让速度随帧率一起掉，
        // 等于把「卡」和「慢」混成一个变量，测不出掉帧本身的代价。
        const dt = last === 0 ? 0 : (t - last) / 1000
        last = t
        pos += dir * speed.pxPerS * dt
        if (pos >= range) {
          travelPx += pos - range
          pos = range
          dir = -1
        } else if (pos <= 0) {
          travelPx += -pos
          pos = 0
          dir = 1
        } else {
          travelPx += speed.pxPerS * dt
        }
        el.scrollTop = pos
      } else {
        // 三角波 0 → max → 0：来回滚比单向滚更容易撞上视口回收与重建。
        // 路程恒为 range*2，在返回值里直接算，不在循环里累计。
        const p = t / SCROLL_MS
        el.scrollTop = (p < 0.5 ? p * 2 : (1 - p) * 2) * range
      }
      steps++
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const stats = sampler.stop()
  hooks.resumePolling()

  if (!aborted) {
    if (range <= 0) aborted = '文档没撑出滚动条（scrollHeight == clientHeight），这一档无效'
    else if (steps < MIN_STEPS) aborted = `只推进 ${steps} 帧（应约 180），rAF 被节流`
  }

  return {
    ...stats,
    ...label,
    visibility: document.visibilityState,
    at: new Date().toISOString(),
    scrollRangePx: Math.round(range),
    travelPx: Math.round(speed.pxPerS > 0 ? travelPx : range * 2),
    achievedPxPerS: Math.round((speed.pxPerS > 0 ? travelPx : range * 2) / (elapsedMs / 1000)),
    scrollSteps: steps,
    aborted,
  }
}

export async function runScrollMatrix(hooks: ScrollMatrixHooks): Promise<ScrollSample[]> {
  if (!('__TAURI_INTERNALS__' in window)) return []

  const samples: ScrollSample[] = []
  const startedAt = new Date().toISOString()
  let aborted: string | null = null

  const flush = async () => {
    const payload = {
      kind: 'm0-scroll-matrix',
      startedAt,
      updatedAt: new Date().toISOString(),
      aborted,
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollMs: SCROLL_MS,
      speeds: SCROLL_SPEEDS.map((s) => ({
        id: s.id,
        pxPerS: s.pxPerS,
        note:
          s.pxPerS > 0
            ? `${s.pxPerS}px/s ≈ 每秒 ${Math.round(s.pxPerS / 14)} 行，判手感看这一档`
            : '全范围三角波，速度由文档高度决定，只作上界压力测试',
      })),
      caveat:
        '合成滚动（程序化写 scrollTop），不含触控板惯性的原生手势路径。' +
        '只作帧计时回归基线，#1 的「手感」判定仍需人工确认。' +
        '读 avgFps 前先看 speed 字段：extreme 档在 10k 换行下高达 12 万 px/s，' +
        '跑不满 60fps 是压力测试的正常结果，不等于日常滚动卡顿。',
      samples,
    }
    try {
      await invoke<string>('save_probe_slot', {
        slot: 'scroll',
        json: JSON.stringify(payload, null, 2),
      })
    } catch {
      // 落盘失败不该中断矩阵，数据仍在内存里
    }
  }

  // 先等窗口真的可见再开始，理由同 runSweep
  if ((await advance(50)) === 'aborted') {
    aborted = '窗口在矩阵开始前被遮挡超过 120s，本轮作废'
    await flush()
    return samples
  }

  const total = SCROLL_COMBOS.length * SCROLL_SPEEDS.length
  for (const combo of SCROLL_COMBOS) {
    hooks.setWrap(combo.lineWrap)
    hooks.load(combo.doc)
    if ((await advance(SETTLE_MS)) === 'aborted') {
      aborted = `${combo.doc}/换行${combo.lineWrap ? '开' : '关'} 的稳定期窗口被遮挡`
      break
    }
    // 两种速度共用同一次加载与稳定期：50k 文档灌一次就要 3s，分两轮跑纯属浪费，
    // 而且第二轮会落在 WebKit 已缓存过的状态上，两档不再可比。
    for (const speed of SCROLL_SPEEDS) {
      samples.push(await sampleScroll(hooks, combo, speed))
      hooks.onSample?.(samples[samples.length - 1], samples.length, total)
      await flush()
    }
  }

  await flush()
  return samples
}
