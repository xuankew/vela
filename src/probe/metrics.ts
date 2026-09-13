/**
 * M0 验收指标采集。
 *
 * 这一层刻意与 UI 解耦：所有探针都是纯函数，验证结束后可以整体保留为
 * 性能回归工具（PLAN.md §2.9 要求每阶段末回归测量）。
 */
import { invoke } from '@tauri-apps/api/core'

export interface FontShardMetrics {
  /** 实际发起请求的 woff2 分片数 */
  shardsLoaded: number
  /** 分片总传输字节 */
  totalBytes: number
  /** 字体包内可用分片总数（由调用方注入，用于对比） */
  shardsAvailable: number
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
}

/**
 * 统计已加载的 woff2 分片。
 * 这是 M0 验收项 #4（首屏字体加载 < 2MB）的量化手段。
 */
export function collectFontShards(shardsAvailable: number): FontShardMetrics {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const shards = entries.filter((e) => e.name.includes('.woff2'))
  const totalBytes = shards.reduce((sum, e) => sum + (e.transferSize || e.encodedBodySize || 0), 0)
  return {
    shardsLoaded: shards.length,
    totalBytes,
    shardsAvailable,
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
