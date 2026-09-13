import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { EditorView } from '@codemirror/view'
import { DEFAULT_VARIANT, FONT_VARIANTS, type FontApplyResult } from '../fonts/loader'
import {
  collectFontFaces,
  collectFontShards,
  collectMemory,
  formatBytes,
  FpsSampler,
  measureEditLatency,
  type DocStats,
  type FontFaceInfo,
  type FpsStats,
  type MemoryMetrics,
} from './metrics'

interface Props {
  getView: () => EditorView | undefined
  stats: DocStats | null
  fontResult: FontApplyResult | null
  editorReadyMs: number
  scriptStartMs: number
}

/** 验收项 #4 的预算：首屏字体加载 < 2MB */
const FONT_BUDGET_BYTES = 2 * 1024 * 1024
/** 验收项 #6：冷启动 < 1s */
const STARTUP_BUDGET_MS = 1000
/** 验收项 #7：空转内存 < 200MB */
const MEM_BUDGET_KB = 200 * 1024
/** 验收项 #1：滚动帧率不低于此值算通过 */
const FPS_BUDGET = 55

const CHECKLIST: { id: string; label: string; hint: string }[] = [
  {
    id: 'c1',
    label: '#1 WKWebView 滚动手感',
    hint: '在左侧编辑器里快速滚动/惯性滚动/拖动滚动条。主观无微延迟、无撕裂。参考 tauri-apps/discussions#8436。',
  },
  {
    id: 'c2',
    label: '#2 中文 IME 输入',
    hint: '在左侧编辑器（不是下面的 textarea）里连续输入长句中文。候选框位置正确、无行跳动、不丢字、上屏后光标位置对。',
  },
  {
    id: 'c3',
    label: '#3 字体列对齐',
    hint: '看下方「列对齐测试台」的框线与竖线是否对齐。不对齐则代码区改用 Maple Mono CN。',
  },
  {
    id: 'c4',
    label: '#4 字体分片懒加载',
    hint: '看「字体」区的已加载分片数与总字节，应远小于 97 / 4.33MB。滚动到含生僻字（龘靐𠀀）的行后再刷新，应看到分片数增加。',
  },
  {
    id: 'c5',
    label: '#5 生产构建正常',
    hint: '跑 pnpm build && pnpm app:build，用打包后的 .app 重复上述所有项。已知有「dev 正常、生产炸」陷阱。',
  },
  {
    id: 'c6',
    label: '#6 冷启动 < 1s',
    hint: '看「启动」区的编辑器就绪耗时。完全退出应用后重开测，不是热重载。',
  },
  {
    id: 'c7',
    label: '#7 空转内存 < 200MB',
    hint: '看「内存」区的 Rust RSS。另用活动监视器核对 Vela 全部进程总和。',
  },
  {
    id: 'c8',
    label: '#8 字重确认',
    hint: '看「字体」区列出的 weight。已确认 Screen 版只有 400，粗体靠浏览器合成——判断合成粗体在标题/UI 上是否可接受。',
  },
]

const ALIGN_SAMPLE = `English1234567890abcdefghij
中文中文中文中文中文中文中文
｜全角竖线｜全角竖线｜全角竖线
| 半角 | 半角 | 半角 | 半角 |
┌────────────┬────────────┐
│ 中文对齐测试 │ ascii text │
├────────────┼────────────┤
│ 甲乙丙丁戊己 │ 0123456789 │
│ ABCDEFGHIJKL │ 中文中文中文 │
└────────────┴────────────┘
歧义宽字符: ± × ÷ ≠ ≤ ≥ ≈ ∞ α β γ Δ π σ φ ω
带圈数字: ① ② ③ ④ ⑤   罗马: Ⅰ Ⅱ Ⅲ Ⅳ
生僻字: 龘 靐 齉 爨 驫 麤 㙟 㐀 𠀀 𪜀 𫝆
标点: ，。；：？！“”‘’【】《》、
Emoji: 🚀 ⚡️ 🔥 📦 🧪 ✅ ❌ ⚠️
代码: const x = 1; let 变量 = "值"; // 注释`

export default function ProbePanel(props: Props) {
  const [fontFaces, setFontFaces] = createSignal<FontFaceInfo[]>([])
  const [shards, setShards] = createSignal({
    shardsLoaded: 0,
    totalBytes: 0,
    shardsAvailable: FONT_VARIANTS[DEFAULT_VARIANT].shards,
  })
  const [mem, setMem] = createSignal<MemoryMetrics>({ rustRssKb: 0, rustUptimeMs: 0, jsHeapUsedBytes: 0 })
  const [fps, setFps] = createSignal<FpsStats | null>(null)
  const [sampling, setSampling] = createSignal(false)
  const [latency, setLatency] = createSignal<{ avgMs: number; p95Ms: number } | null>(null)
  const [checked, setChecked] = createSignal<Record<string, boolean>>({})
  const [inTauri, setInTauri] = createSignal(false)

  const sampler = new FpsSampler()
  let memTimer = 0

  function refreshFonts() {
    setFontFaces(collectFontFaces('lxgw'))
    const variant = FONT_VARIANTS[props.fontResult?.id ?? 'screen-gb']
    setShards({ ...collectFontShards(variant.shards), shardsAvailable: variant.shards })
  }

  async function refreshMem() {
    setMem(await collectMemory())
  }

  onMount(() => {
    // 检测是否跑在 Tauri 里（纯浏览器下 Rust 探针取不到值）
    setInTauri('__TAURI_INTERNALS__' in window)
    const saved = localStorage.getItem('vela.m0.checklist')
    if (saved) {
      try {
        setChecked(JSON.parse(saved) as Record<string, boolean>)
      } catch {
        /* 忽略损坏的本地状态 */
      }
    }
    refreshFonts()
    void refreshMem()
    // 字体分片随滚动持续加载，定时刷新才能看到增长曲线
    memTimer = window.setInterval(() => {
      void refreshMem()
      refreshFonts()
    }, 3000)
  })

  onCleanup(() => {
    window.clearInterval(memTimer)
    sampler.stop()
  })

  function startSampling() {
    setSampling(true)
    setFps(null)
    sampler.start()
    window.setTimeout(() => {
      setFps(sampler.stop())
      setSampling(false)
    }, 5000)
  }

  function runLatency() {
    const view = props.getView()
    if (!view) return
    // 插入再删除，保持文档不变
    const r = measureEditLatency(() => {
      view.dispatch({ changes: { from: 0, insert: '測' } })
      view.dispatch({ changes: { from: 0, to: 1 } })
    }, 200)
    setLatency(r)
  }

  function toggle(id: string, value: boolean) {
    const next = { ...checked(), [id]: value }
    setChecked(next)
    localStorage.setItem('vela.m0.checklist', JSON.stringify(next))
  }

  function resetChecklist() {
    setChecked({})
    localStorage.removeItem('vela.m0.checklist')
  }

  const doneCount = () => CHECKLIST.filter((c) => checked()[c.id]).length
  const readyClass = () => (props.editorReadyMs < STARTUP_BUDGET_MS ? 'ok' : 'bad')
  const memClass = () => (mem().rustRssKb > 0 && mem().rustRssKb < MEM_BUDGET_KB ? 'ok' : mem().rustRssKb === 0 ? '' : 'bad')
  const fontClass = () => (shards().totalBytes < FONT_BUDGET_BYTES ? 'ok' : 'warn')
  const fpsClass = () => (fps() && fps()!.avgFps >= FPS_BUDGET ? 'ok' : 'bad')

  return (
    <div class="probe">
      <div class="probe-section">
        <div class="probe-title">M0 探针</div>
        <div class="metric-row">
          <span class="metric-key">运行环境</span>
          <span class="metric-val">{inTauri() ? 'Tauri (WKWebView)' : '纯浏览器 — Rust 探针不可用'}</span>
        </div>
        <Show when={!inTauri()}>
          <p class="note">
            当前跑在浏览器里。滚动手感、IME、内存三项必须在 <code>pnpm app:dev</code> 的 Tauri 窗口中重测，
            WKWebView 与 Chromium 的渲染路径不同。
          </p>
        </Show>
      </div>

      <div class="probe-section">
        <div class="probe-title">启动 · 验收 #6（预算 &lt; {STARTUP_BUDGET_MS}ms）</div>
        <div class="metric-row">
          <span class="metric-key">HTML 内联脚本时刻</span>
          <span class="metric-val">{props.scriptStartMs.toFixed(1)} ms</span>
        </div>
        <div class="metric-row">
          <span class="metric-key">编辑器就绪</span>
          <span class={`metric-val ${readyClass()}`}>{props.editorReadyMs.toFixed(1)} ms</span>
        </div>
        <div class="metric-row">
          <span class="metric-key">文档生成+灌入</span>
          <span class="metric-val">{props.stats ? `${props.stats.loadMs.toFixed(1)} ms` : '—'}</span>
        </div>
        <div class="metric-row">
          <span class="metric-key">Rust 进程已运行</span>
          <span class="metric-val">
            {mem().rustUptimeMs > 0 ? `${mem().rustUptimeMs.toLocaleString()} ms` : '取不到（非 Tauri）'}
          </span>
        </div>
        <p class="note">
          Rust 计时与前端 performance 时钟不同源，不能相减。它的用途是判断冷启动瓶颈在哪一侧：
          若 Rust 已运行很久而编辑器就绪很快，说明开销在进程拉起而非前端资源解析。
        </p>
      </div>

      <div class="probe-section">
        <div class="probe-title">字体 · 验收 #4 #8（预算 &lt; {formatBytes(FONT_BUDGET_BYTES)}）</div>
        <Show
          when={props.fontResult}
          fallback={
            <div class="metric-row">
              <span class="metric-key">按需注入</span>
              <span class="metric-val">未注入</span>
            </div>
          }
        >
          <div class="metric-row">
            <span class="metric-key">当前变体</span>
            <span class="metric-val">{FONT_VARIANTS[props.fontResult!.id].label}</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">注入耗时</span>
            <span class="metric-val">
              {props.fontResult!.injected ? `${props.fontResult!.ms.toFixed(1)} ms` : '跳过（未变）'}
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">注入 CSS / 条数</span>
            <span class="metric-val">
              {formatBytes(props.fontResult!.cssBytes)} / {props.fontResult!.faces} 条
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">chunk 缓存命中</span>
            <span class="metric-val">{props.fontResult!.fromCache ? '是' : '否（首次拉取）'}</span>
          </div>
        </Show>
        <div class="metric-row">
          <span class="metric-key">已加载 woff2 分片</span>
          <span class={`metric-val ${fontClass()}`}>
            {shards().shardsLoaded} / {shards().shardsAvailable}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-key">分片总字节</span>
          <span class={`metric-val ${fontClass()}`}>{formatBytes(shards().totalBytes)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-key">font-face 已加载</span>
          <span class="metric-val">
            {fontFaces().filter((f) => f.status === 'loaded').length} / {fontFaces().length}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-key">实测字重</span>
          <span class="metric-val">
            {[...new Set(fontFaces().filter((f) => f.status === 'loaded').map((f) => f.weight))].join(', ') || '—'}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-key">family</span>
          <span class="metric-val">{[...new Set(fontFaces().map((f) => f.family))].join(' | ') || '—'}</span>
        </div>
        <button onClick={refreshFonts}>刷新字体统计</button>
        <p class="note">
          @font-face 现在是运行时按需注入的（D7），任一时刻只驻留一个变体，避开包内 4 变体的 family
          同名冲突。生僻字（龘靐𠀀）落在不同分片，滚动到含它们的行后刷新，分片数应上升。
          切到「系统等宽」对照组应看到 family 变空、分片停止增长。
        </p>
      </div>

      <div class="probe-section">
        <div class="probe-title">内存 · 验收 #7（预算 &lt; {MEM_BUDGET_KB / 1024}MB）</div>
        <div class="metric-row">
          <span class="metric-key">Rust 进程 RSS</span>
          <span class={`metric-val ${memClass()}`}>
            {mem().rustRssKb > 0 ? `${(mem().rustRssKb / 1024).toFixed(1)} MB` : '取不到（非 Tauri）'}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-key">JS heap</span>
          <span class="metric-val">
            {mem().jsHeapUsedBytes > 0 ? formatBytes(mem().jsHeapUsedBytes) : 'WKWebView 不暴露'}
          </span>
        </div>
        <p class="note">
          Rust RSS 只是主进程，不含 WKWebView 的渲染/网络子进程。最终判定请用活动监视器看 Vela 全部进程之和。
        </p>
      </div>

      <div class="probe-section">
        <div class="probe-title">滚动帧率 · 验收 #1（目标 ≥ {FPS_BUDGET}fps）</div>
        <button class={sampling() ? 'recording' : 'primary'} onClick={startSampling} disabled={sampling()}>
          {sampling() ? '采样中 — 请立刻滚动编辑器 5 秒' : '开始 5s 采样'}
        </button>
        <Show when={fps()}>
          <div class="metric-row">
            <span class="metric-key">平均 fps</span>
            <span class={`metric-val ${fpsClass()}`}>{fps()!.avgFps.toFixed(1)}</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">p95 帧耗时</span>
            <span class="metric-val">{fps()!.p95FrameMs.toFixed(2)} ms</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">最长帧</span>
            <span class="metric-val">{fps()!.maxFrameMs.toFixed(2)} ms</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">卡顿帧 (&gt;33ms)</span>
            <span class={`metric-val ${fps()!.jankFrames > 10 ? 'warn' : 'ok'}`}>
              {fps()!.jankFrames} / {fps()!.samples}
            </span>
          </div>
        </Show>
        <p class="note">
          rAF 在窗口隐藏时会被冻结，采样期间务必保持窗口在前台。分别测「换行开」与「换行关」两种状态，
          并测 10k / 50k 两档文档量。
        </p>
      </div>

      <div class="probe-section">
        <div class="probe-title">编辑延迟（200 次插入+删除）</div>
        <button onClick={runLatency}>测量</button>
        <Show when={latency()}>
          <div class="metric-row">
            <span class="metric-key">平均</span>
            <span class={`metric-val ${latency()!.avgMs < 16 ? 'ok' : 'warn'}`}>
              {latency()!.avgMs.toFixed(3)} ms
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">p95</span>
            <span class="metric-val">{latency()!.p95Ms.toFixed(3)} ms</span>
          </div>
        </Show>
        <p class="note">只测主线程事务派发耗时，不含系统事件投递。用途是阶段间回归对比，不是绝对输入延迟。</p>
      </div>

      <div class="probe-section">
        <div class="probe-title">列对齐测试台 · 验收 #3</div>
        <div class="align-test">{ALIGN_SAMPLE}</div>
        <p class="note">
          框线竖线应上下对齐。若中文与英文宽度不是严格 2:1，方框会错位——这就是 PLAN.md 风险 R4。
          切换工具栏的字体下拉对比 Screen GB / Screen R / 系统等宽三者。
        </p>
      </div>

      <div class="probe-section">
        <div class="probe-title">IME 对照组 · 验收 #2</div>
        <textarea class="ime-test" placeholder="在这里打一段中文作为原生 textarea 对照组…" />
        <p class="note">
          在**左侧编辑器**里打同样的中文，对比这个原生 textarea。若编辑器有行跳动/候选框错位而 textarea 正常，
          说明是 CM6 的 contenteditable 输入路径问题，可调 EditorView.inputStyle。
        </p>
      </div>

      <div class="probe-section">
        <div class="probe-title">
          人工验收清单 · {doneCount()} / {CHECKLIST.length}
        </div>
        <div class="checklist">
          <For each={CHECKLIST}>
            {(item) => (
              <div class={`check-item${checked()[item.id] ? ' done' : ''}`}>
                <input
                  type="checkbox"
                  id={item.id}
                  checked={!!checked()[item.id]}
                  onChange={(e) => toggle(item.id, e.currentTarget.checked)}
                />
                <label for={item.id}>
                  {item.label}
                  <span class="hint">{item.hint}</span>
                </label>
              </div>
            )}
          </For>
        </div>
        <button onClick={resetChecklist} style="margin-top:8px">
          清空勾选
        </button>
      </div>

      <div class="probe-section">
        <div class="probe-title">当前文档</div>
        <Show when={props.stats} fallback={<div class="metric-row"><span class="metric-key">空</span></div>}>
          <div class="metric-row">
            <span class="metric-key">来源</span>
            <span class="metric-val">{props.stats?.label}</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">行数</span>
            <span class="metric-val">{props.stats?.lines.toLocaleString()}</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">体积</span>
            <span class="metric-val">{formatBytes(props.stats?.bytes ?? 0)}</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">最长行</span>
            <span class="metric-val">{props.stats?.longestLine} 字符</span>
          </div>
        </Show>
      </div>
    </div>
  )
}
