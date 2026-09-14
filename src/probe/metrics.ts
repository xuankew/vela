/**
 * M0 验收指标采集。
 *
 * 这一层刻意与 UI 解耦：所有探针都是纯函数，验证结束后可以整体保留为
 * 性能回归工具（PLAN.md §2.9 要求每阶段末回归测量）。
 */
import { invoke } from '@tauri-apps/api/core'

/**
 * 构建期清单里的一条：某个 family 的某个 unicode-range 分片实际有多少字节。
 * 由 `scripts/font-manifest.mjs` 生成，字节数取自 node_modules 源文件
 * （vite 只给资源改名加 hash、内容逐字节复制，脚本已核对 433/433 一致）。
 */
export interface ShardManifestEntry {
  family: string
  /** 已归一化的 unicode-range，与 `normRange(face.unicodeRange)` 同规则 */
  range: string
  name: string
  bytes: number
  weight: string
}

export interface ShardManifest {
  generatedAt: string
  note: string
  families: Record<string, { shards: number; bytes: number }>
  entries: ShardManifestEntry[]
}

export interface FamilyShardMeasure {
  family: string
  loaded: number
  /** 该 family 在清单里的分片总数 */
  shards: number
  bytes: number
}

export interface ShardMeasure {
  /** `document.fonts` 里 status === 'loaded' 的 face 数 */
  loadedFaces: number
  registeredFaces: number
  /** 查表求和得到的真实字节数 —— 验收 #4 的判据值 */
  totalBytes: number
  byFamily: FamilyShardMeasure[]
  /**
   * 已加载但在清单里找不到对应 family 的 face 数。
   * 非 0 通常意味着注入了清单没覆盖的字体（例如切到对照组），不是错误。
   */
  familyNotInManifest: number
  /**
   * ⛔ 关键自检项：已加载 face 的 `unicodeRange` 归一化后与清单对不上的条数。
   * **非 0 就说明 WebKit 的序列化与 CSS 源文本不一致，此时 totalBytes 已退化为
   * index-join 的结果**，必须连带 `indexDisagreements` 一起看才能判断可不可信。
   */
  rangeUnmatched: number
  /**
   * 两条独立连接方式（按 range 查 vs 按 family 内出现顺序对齐）给出不同分片的条数。
   * 0 = 两种方式互相印证，读数可信；非 0 = 至少有一条连接是错的，**数字不能用**。
   */
  indexDisagreements: number
  manifestAt: string
}

export interface FontFaceInfo {
  family: string
  weight: string
  style: string
  status: string
}

export interface MemoryMetrics {
  rustRssKb: number
  /**
   * Rust 进程自启动到现在的毫秒数。与前端时钟不同源，不能相减，
   * 但可用于判断冷启动瓶颈在 Rust 进程侧还是 webview 侧。
   */
  rustUptimeMs: number
  /** Chromium 专有；WKWebView 下通常不可用，为 0 表示取不到 */
  jsHeapUsedBytes: number
}

/** 当前灌入编辑器的测试文档的元信息 */
export interface DocStats {
  label: string
  lines: number
  bytes: number
  longestLine: number
  /** 生成 + 灌入 CM6 的总耗时 */
  loadMs: number
  /**
   * 测量时的换行状态。
   *
   * #1 要求换行开/关各测一轮，两条是完全不同的排版路径。不把这个状态记进样本，
   * 导出的报告里两组数据就无法区分——本项目已经因为「样本没带上当时的状态」
   * 白跑过两轮 A/B，不能在这里再犯一次。
   */
  lineWrap: boolean
}

/**
 * unicode-range 归一化。
 *
 * ⚠️ 必须与 `scripts/font-manifest.mjs` 里的 `normRange` **逐字一致**：
 * 那边归一化 CSS 源文本，这边归一化 WebKit 从 CSSOM 回读的值，规则差一点就全部匹配不上。
 * WebKit 会把 `U+1f300` 序列化成 `U+1F300`，所以大小写这一条不是可选的。
 */
export function normRange(s: string): string {
  return s.toUpperCase().replace(/\s+/g, '').replace(/;+$/, '')
}

/** CSSOM 回读的 family 可能带引号，清单里的不带 */
function normFamily(s: string): string {
  return s.replace(/^['"]+|['"]+$/g, '').trim()
}

/**
 * 从 Rust 侧读回分片清单。走白名单槽位而不是让前端传路径。
 * 非 Tauri 环境（`pnpm dev`）或清单未生成时返回 null，调用方要能优雅降级。
 */
export async function loadShardManifest(): Promise<ShardManifest | null> {
  try {
    const json = await invoke<string>('load_probe_slot', { slot: 'fonts' })
    return JSON.parse(json) as ShardManifest
  } catch {
    return null
  }
}

/**
 * 验收项 #4（首屏字体加载 < 2MB）的量化手段。
 *
 * ⛔ **为什么不是 resource timing**：`performance.getEntriesByType('resource')` 在
 * `tauri://` 协议下抓不到任何 woff2，release 构建里恒为 0 条——#4 原先打的 ✅ 是在
 * dev 模式下测的，口径根本不同。前端唯一可靠的信号是 `document.fonts` 里哪些 face
 * 的 status 变成了 `loaded`，但 FontFace 不暴露 URL，所以字节数只能离线查表。
 *
 * 连接方式有两条，**互为校验**：
 *   1. 按 `family + 归一化 unicode-range` 查表（主）；
 *   2. 按 face 在同 family 内的出现顺序对齐清单顺序（`document.fonts` 的迭代顺序
 *      就是 @font-face 的注册顺序，而每个 family 只由一个 style 节点注入）。
 * 两者给出的分片不一致时计入 `indexDisagreements`。**这个数非 0 就说明连接错了，
 * 求和结果不能用** —— 宁可报「测不准」，也不要报一个看着合理的错数字。
 */
export function measureShardBytes(manifest: ShardManifest): ShardMeasure {
  const entriesByFamily = new Map<string, ShardManifestEntry[]>()
  const byRange = new Map<string, ShardManifestEntry>()
  for (const e of manifest.entries) {
    const arr = entriesByFamily.get(e.family)
    if (arr) arr.push(e)
    else entriesByFamily.set(e.family, [e])
    byRange.set(`${e.family}\u0000${e.range}`, e)
  }

  let loadedFaces = 0
  let registeredFaces = 0
  let totalBytes = 0
  let familyNotInManifest = 0
  let rangeUnmatched = 0
  let indexDisagreements = 0
  const seenPerFamily = new Map<string, number>()
  const acc = new Map<string, FamilyShardMeasure>()

  document.fonts.forEach((face) => {
    registeredFaces++

    const family = normFamily(face.family)
    // 顺序对齐的下标必须覆盖**全部已注册** face，不能只数 loaded 的：
    // 清单里 `known[]` 是整个 family 的 97/239 片，而 loaded 只有几十片，
    // 在 status 检查之后才自增会让下标指向错误的那一段——之前 70 个 face 里
    // 报出 67 个「分歧」纯粹是这个错位，不是 WebKit 的迭代顺序有问题。
    const idx = seenPerFamily.get(family) ?? 0
    seenPerFamily.set(family, idx + 1)

    if (face.status !== 'loaded') return
    loadedFaces++

    const known = entriesByFamily.get(family)
    if (!known) {
      familyNotInManifest++
      return
    }

    const hitByRange = byRange.get(`${family}\u0000${normRange(face.unicodeRange ?? '')}`)
    if (!hitByRange) rangeUnmatched++
    const hitByIndex = known[idx]
    if (hitByRange && hitByIndex && hitByRange.name !== hitByIndex.name) indexDisagreements++

    const hit = hitByRange ?? hitByIndex
    if (!hit) return
    totalBytes += hit.bytes
    const a = acc.get(family)
    if (a) {
      a.loaded++
      a.bytes += hit.bytes
    } else {
      acc.set(family, { family, loaded: 1, shards: known.length, bytes: hit.bytes })
    }
  })

  return {
    loadedFaces,
    registeredFaces,
    totalBytes,
    byFamily: [...acc.values()],
    familyNotInManifest,
    rangeUnmatched,
    indexDisagreements,
    manifestAt: manifest.generatedAt,
  }
}

/**
 * 列出 document.fonts 中已注册的 face。
 * 用于 M0 验收项 #8：确认霞鹜文楷 Screen 实际提供几档字重。
 */
export function collectFontFaces(filter?: string): FontFaceInfo[] {
  const out: FontFaceInfo[] = []
  document.fonts.forEach((face) => {
    if (filter && !face.family.toLowerCase().includes(filter.toLowerCase())) return
    out.push({
      family: face.family,
      weight: String(face.weight),
      style: face.style,
      status: face.status,
    })
  })
  return out
}

export async function collectMemory(): Promise<MemoryMetrics> {
  let rustRssKb = 0
  let rustUptimeMs = 0
  try {
    const info = await invoke<{ rust_rss_kb: number; rust_uptime_ms: number }>('probe_memory')
    rustRssKb = info.rust_rss_kb
    rustUptimeMs = info.rust_uptime_ms
  } catch {
    // 在纯浏览器里跑（pnpm dev）时没有 Rust 侧，静默降级
  }
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return {
    rustRssKb,
    rustUptimeMs,
    jsHeapUsedBytes: mem?.usedJSHeapSize ?? 0,
  }
}

/**
 * Rust 进程自启动以来的毫秒数，用于验收项 #6（冷启动 < 1s）。
 *
 * 为什么不能直接用 `performance.now()`：它的原点是**页面导航开始**，
 * 而 macOS 上「进程拉起 → 创建 WKWebView → 开始导航」这一段并不便宜。
 * 只用前端时钟会系统性低估真实冷启动，可能把一个不达标的数据读成达标。
 * 这个函数走 IPC 拿 Rust 侧时钟，起点是 `run()` 里的第一行，
 * 覆盖了上述全部区间。代价是读数含一次 IPC 往返（个位数毫秒），
 * 相对 1000ms 预算可忽略，但报告里应当注明是「约等于」。
 */
export async function collectProcessUptime(): Promise<number> {
  try {
    return await invoke<number>('probe_ready')
  } catch {
    // 纯浏览器里跑（pnpm dev）时没有 Rust 侧，静默降级
    return 0
  }
}

/**
 * 帧率采样器。M0 验收项 #1（WKWebView 滚动手感）的量化手段。
 *
 * 用法：start() 开始采样，在采样窗口内滚动编辑器，stop() 返回统计。
 * 注意：窗口隐藏或最小化时 rAF 会被冻结，采样结果会失真——测量时必须保持窗口可见。
 */
export class FpsSampler {
  private frames: number[] = []
  private rafId = 0
  private last = 0
  private running = false

  start(): void {
    if (this.running) return
    this.running = true
    this.frames = []
    this.last = performance.now()
    const tick = (now: number) => {
      if (!this.running) return
      const delta = now - this.last
      this.last = now
      // 过滤掉标签页切换等造成的极端值
      if (delta > 0 && delta < 1000) this.frames.push(delta)
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  stop(): FpsStats {
    this.running = false
    cancelAnimationFrame(this.rafId)
    return summarize(this.frames)
  }
}

export interface FpsStats {
  samples: number
  avgFps: number
  minFps: number
  p95FrameMs: number
  maxFrameMs: number
  /** 超过 2 倍帧预算（33ms）的帧数，即肉眼可感的卡顿次数 */
  jankFrames: number
  windowMs: number
}

function summarize(frames: number[]): FpsStats {
  if (frames.length === 0) {
    return { samples: 0, avgFps: 0, minFps: 0, p95FrameMs: 0, maxFrameMs: 0, jankFrames: 0, windowMs: 0 }
  }
  const sorted = [...frames].sort((a, b) => a - b)
  const total = frames.reduce((s, f) => s + f, 0)
  const avgFrame = total / frames.length
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const max = sorted[sorted.length - 1]
  return {
    samples: frames.length,
    avgFps: 1000 / avgFrame,
    minFps: 1000 / max,
    p95FrameMs: p95,
    maxFrameMs: max,
    jankFrames: frames.filter((f) => f > 33).length,
    windowMs: total,
  }
}

/**
 * 按键到屏幕的延迟：往 CM6 派发一次事务，测量主线程完成布局的耗时。
 * 这不是完整的输入延迟（少了系统事件投递），但足以做阶段间回归对比。
 */
export function measureEditLatency(probe: () => void, iterations = 200): { avgMs: number; p95Ms: number } {
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    probe()
    const t1 = performance.now()
    samples.push(t1 - t0)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    avgMs: samples.reduce((s, v) => s + v, 0) / samples.length,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export interface AlignMetrics {
  fontFamily: string
  fontSizePx: number
  /** 单个 ASCII 字符的步进宽度 */
  asciiAdvancePx: number
  cjkAdvancePx: number
  boxAdvancePx: number
  /** 表格 / ASCII art 对齐的充要条件：这个比值必须是 2.000 */
  cjkOverAscii: number
  boxOverAscii: number
  /**
   * 多个不同 ASCII 字符的步进极差。
   *
   * 如果这个值明显大于 0，说明该字体的拉丁字形是**比例宽度**而非等宽——
   * 那么 cjkOverAscii 这个比值本身就没有意义，字体根本不能用于代码区。
   * 这比比值偏离 2 更致命，必须先排除。
   */
  asciiSpreadPx: number
  asciiSamples: Record<string, number>
  /** 50 个中文字符排下来累积的像素漂移，这是人眼实际能看到的错位量 */
  driftPxPer50Cjk: number
  mono: boolean
  aligned: boolean
  fontsReady: boolean
  cjkFaceLoaded: boolean
}

const REPEAT = 100

/**
 * 验收项 #3：直接量字形步进宽度，替代「人眼看框线对不对齐」。
 *
 * 为什么能自动化：列对齐是个纯粹的字体度量问题——中文步进是否恰好等于
 * 2 倍 ASCII 步进。人眼看框线只能给出"好像有点歪"，量 advance width
 * 能给出"每 50 个中文字漂移 3.7px"。这一项不需要人参与。
 *
 * 必须在真实 WKWebView 里跑：Chromium 与 WebKit 的字体回退与栅格化不同，
 * 浏览器侧量出来的比值不能代表 Tauri 里的表现。
 */
export async function measureAlignment(
  ref: HTMLElement | null,
  overrideFamily?: string,
): Promise<AlignMetrics> {
  const target = ref ?? document.body
  const cs = getComputedStyle(target)
  // overrideFamily 用于量对照组：拿一个必然等宽的字体栈跑同一套量具，
  // 若对照组也报「比例宽度」，说明坏的是量具而不是被测字体。
  const fontFamily = overrideFamily ?? cs.fontFamily
  const fontSizePx = parseFloat(cs.fontSize)

  // D7 的 face 是按需拉取的，只在真有字形用到时才下载。若不等这一步，
  // 切换字体后的第一次测量读到的是回退字体的步进，会给出错误的「不对齐」。
  const probeText = '0中文│iWm.@'
  try {
    await document.fonts.load(`${cs.fontStyle} ${cs.fontWeight} ${fontSizePx}px ${fontFamily}`, probeText)
  } catch {
    /* 字体简写不被接受时忽略，下面的 fonts.ready 兜底 */
  }
  await document.fonts.ready

  const host = document.createElement('div')
  host.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre;' +
    `font-family:${fontFamily};font-size:${fontSizePx}px;` +
    `letter-spacing:${cs.letterSpacing};font-weight:${cs.fontWeight};` +
    'font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;'

  // 每个 span 放 REPEAT 个同字符，用总宽除以次数来摊掉亚像素舍入
  const widths = new Map<string, number>()
  const probes: [string, string][] = [
    ['ascii', '0'.repeat(REPEAT)],
    ['cjk', '中'.repeat(REPEAT)],
    ['box', '│'.repeat(REPEAT)],
  ]
  // 拉丁是否等宽：取形状差异最大的几个字符分别量
  for (const ch of ['0', 'i', 'l', 'W', 'm', '.', '@']) {
    probes.push([`ascii:${ch}`, ch.repeat(REPEAT)])
  }

  const spans = new Map<string, HTMLSpanElement>()
  for (const [key, text] of probes) {
    const s = document.createElement('span')
    s.textContent = text
    host.appendChild(s)
    spans.set(key, s)
  }
  document.body.appendChild(host)

  try {
    for (const [key, s] of spans) widths.set(key, s.getBoundingClientRect().width / REPEAT)
  } finally {
    host.remove()
  }

  const asciiSamples: Record<string, number> = {}
  for (const [key, w] of widths) {
    if (key.startsWith('ascii:')) asciiSamples[key.slice(6)] = Number(w.toFixed(4))
  }
  const vals = Object.values(asciiSamples)
  const asciiSpreadPx = vals.length ? Math.max(...vals) - Math.min(...vals) : 0

  const asciiAdvancePx = widths.get('ascii') ?? 0
  const cjkAdvancePx = widths.get('cjk') ?? 0
  const boxAdvancePx = widths.get('box') ?? 0
  const cjkOverAscii = asciiAdvancePx ? cjkAdvancePx / asciiAdvancePx : 0
  const boxOverAscii = asciiAdvancePx ? boxAdvancePx / asciiAdvancePx : 0

  // 等宽容差：亚像素舍入 + 栅格化差异，0.01px 以内视为同一步进
  const mono = asciiSpreadPx < 0.01
  const aligned = mono && Math.abs(cjkOverAscii - 2) < 0.005

  return {
    fontFamily,
    fontSizePx,
    asciiAdvancePx: Number(asciiAdvancePx.toFixed(4)),
    cjkAdvancePx: Number(cjkAdvancePx.toFixed(4)),
    boxAdvancePx: Number(boxAdvancePx.toFixed(4)),
    cjkOverAscii: Number(cjkOverAscii.toFixed(5)),
    boxOverAscii: Number(boxOverAscii.toFixed(5)),
    asciiSpreadPx: Number(asciiSpreadPx.toFixed(4)),
    asciiSamples,
    driftPxPer50Cjk: Number((50 * Math.abs(cjkAdvancePx - 2 * asciiAdvancePx)).toFixed(3)),
    mono,
    aligned,
    fontsReady: document.fonts.status === 'loaded',
    cjkFaceLoaded: document.fonts.check(`${fontSizePx}px ${fontFamily}`, '中文对齐'),
  }
}
