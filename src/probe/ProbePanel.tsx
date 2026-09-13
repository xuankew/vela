import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { EditorView } from '@codemirror/view'
import { invoke } from '@tauri-apps/api/core'
import {
  CODE_FONTS,
  DEFAULT_CODE_FONT,
  DEFAULT_VARIANT,
  FONT_VARIANTS,
  type CodeFontApplyResult,
  type FontApplyResult,
} from '../fonts/loader'
import { runScrollMatrix, type ScrollSample, type SweepDoc } from './sweep'
import {
  collectFontFaces,
  collectFontShards,
  collectMemory,
  formatBytes,
  FpsSampler,
  measureAlignment,
  measureEditLatency,
  type AlignMetrics,
  type DocStats,
  type FontFaceInfo,
  type FpsStats,
  type MemoryMetrics,
} from './metrics'

interface Props {
  getView: () => EditorView | undefined
  stats: DocStats | null
  fontResult: FontApplyResult | null
  /** 代码区字体的注入结果。#3 判的是这一档，不是正文那档 */
  codeFontResult: CodeFontApplyResult | null
  editorReadyMs: number
  /** Rust 进程启动 → 编辑器就绪，验收 #6 的有效读数；null 表示非 Tauri 环境取不到 */
  processToReadyMs: number | null
  scriptStartMs: number
  /**
   * #1 滚动矩阵的接线。矩阵要自己切文档量与换行开关，这两个能力只有 App 有；
   * 不传则矩阵不跑（纯浏览器下也没有意义）。
   */
  autotest?: {
    load: (doc: SweepDoc) => void
    setWrap: (wrap: boolean) => void
  }
}

/** 验收项 #4 的预算：首屏字体加载 < 2MB */
const FONT_BUDGET_BYTES = 2 * 1024 * 1024
/** 验收项 #6：冷启动 < 1s */
const STARTUP_BUDGET_MS = 1000
/** 验收项 #7：空转内存 < 200MB */
const MEM_BUDGET_KB = 200 * 1024
/** 验收项 #1：滚动帧率不低于此值算通过 */
const FPS_BUDGET = 55

/**
 * 一次帧率采样，连同**采样当时所处的状态**。
 *
 * #1 要测 4 个组合（10k/50k × 换行开/关），而单个 `fps` 信号每次都被覆盖，
 * 导出的报告里只会剩下最后一次，其余三个要靠人抄。本项目前面几次错误归因
 * 都出在「数字和它当时的状态没绑在一起」，所以这里把状态直接钉进样本。
 */
interface FpsSample extends FpsStats {
  visibility: string
  at: string
  doc: string
  lineWrap: boolean
}

/**
 * 一次列对齐测量的多个目标。
 *
 * 按内容分字体（D2）之后，**#3 的判定对象是 `code`**，不再是 `editor`：
 * - `code`：代码区字体（Maple Mono CN）。优先量 CM6 DOM 里真实的 `.vela-code` 行，
 *   这样能端到端验证「语法节点 → 行装饰 → CSS → 解析出的字体 → 字形度量」整条链；
 *   文档里一个代码块都没有时退回测试台 div（`.align-test` 也已指向代码区字体）。
 * - `editor`：CM6 `contentDOM` 的解析字体。Markdown 模式下这是**正文**（文楷），
 *   报 `mono=false` 是**预期结果而不是失败**——文楷本来就只用于正文与 UI。
 * - `bench`：面板里的测试台 div，与 code 同源，用来发现 CM6 theme 覆盖字体栈的情况。
 * - `control`：量具自检，已知等宽的系统字体栈。这一组必须 mono=true，否则全部读数不可信。
 */
interface AlignPair {
  editor: AlignMetrics | null
  bench: AlignMetrics
  code: AlignMetrics | null
  /** code 那一组量的是谁：真实代码行 / 测试台兜底 / 编辑器未挂载 */
  codeTarget: string
  /** 量具自检：已知等宽的系统字体栈。这一组必须 mono=true，否则上面各组读数都不可信 */
  control: AlignMetrics
  at: string
  visibility: string
}

/** 对照组用的字体栈：系统等宽，拉丁必然等宽 */
const MONO_CONTROL = 'ui-monospace, SFMono-Regular, Menlo, monospace'

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
    hint: '已由面板自动量化，判定对象是**代码区**（按内容分字体 D2）：CJK/ASCII 步进比 = 2.0000 且 ASCII 步进极差 ≈ 0 即通过，下面的框线只作肉眼复核。⚠️ 别拿「正文」那一栏判失败——文楷 Screen 拉丁是比例宽度，报不等宽是预期结果，它只用于 Markdown 正文与 UI；代码区默认已换成 Maple Mono CN。要确认分流真的生效：把代码区下拉切到「跟随正文」，判定应立刻变红。',
  },
  {
    id: 'c4',
    label: '#4 字体分片懒加载',
    hint: '⚠️ 只看「已加载 face 数」，别看字节数——resource timing 在 tauri:// 协议下抓不到 woff2，release 构建里恒为 0，所以面板的「分片总字节」在打包后是假读数。分字体之后 face 按 family 分组显示，分母是正文 97 + 代码区 239 = 336；判懒加载看**每组各自的已加载数远小于注册数**。要确认生僻字能触发加载：滚到含（龘靐𠀀）的行后点「刷新字体统计」，对应 family 的已加载数应上升。',
  },
  {
    id: 'c5',
    label: '#5 生产构建正常',
    hint: '跑 pnpm build && pnpm app:build，用打包后的 .app 重复上述所有项。已知有「dev 正常、生产炸」陷阱。',
  },
  {
    id: 'c6',
    label: '#6 冷启动 < 1s',
    hint: '✅ 已实测通过：635ms（预算 1000ms）。看「启动」区的「进程启动 → 可输入（#6 判定）」，这一行是 Rust 进程时钟，端到端。只需完全退出应用后重开确认一次量级没变——别只看前端时钟那一行，它的原点是导航开始，不含进程拉起与 WKWebView 创建。',
  },
  {
    id: 'c7',
    label: '#7 空转内存 < 200MB',
    hint: '✅ 已实测通过：空转均值 104MB / 峰值 109MB（预算 200MB），5 个间隔 15s 的干净点。⛔ 不要用面板里的 Rust RSS 判定——ps 的 RSS 会把 vela 与 3 个 WebKit XPC 进程的共享页重复计数。正确口径是活动监视器「内存」列（phys_footprint），把 vela + WebContent + GPU + Networking 四项相加。复测时注意窗口必须可见，被遮挡时 WebKit 会释放缓存、读数偏低。',
  },
  {
    id: 'c8',
    label: '#8 字重确认',
    hint: '✅ 已结项：文楷 Screen 只有 font-weight 400，无 Bold，粗体靠浏览器合成（faux bold）——已转为 R16。现在 weight 按 family 分组显示，#8 判的是 **LXGW WenKai Screen 那一组**；代码区 Maple Mono CN 的字重是另一件事，不在本项范围。只需肉眼确认合成粗体在标题/UI 上是否可接受。',
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
  const [fps, setFps] = createSignal<FpsSample | null>(null)
  const [fpsHistory, setFpsHistory] = createSignal<FpsSample[]>([])
  const [sampling, setSampling] = createSignal(false)
  const [latency, setLatency] = createSignal<{ avgMs: number; p95Ms: number } | null>(null)
  const [align, setAlign] = createSignal<AlignPair | null>(null)
  const [alignBusy, setAlignBusy] = createSignal(false)
  const [scrollSamples, setScrollSamples] = createSignal<ScrollSample[]>([])
  const [matrixNote, setMatrixNote] = createSignal('')
  const [checked, setChecked] = createSignal<Record<string, boolean>>({})
  const [inTauri, setInTauri] = createSignal(false)
  const [exportState, setExportState] = createSignal('')

  const sampler = new FpsSampler()
  let memTimer = 0
  let alignRef: HTMLDivElement | undefined
  /** 滚动矩阵期间挂起列对齐测量，理由见 runAlign。普通 let 即可——不参与渲染 */
  let alignSuspended = false

  function refreshFonts() {
    // 不过滤 family：按内容分字体（D2）之后正文与代码区各驻留一套 webfont，
    // 只数 'lxgw' 会把代码字体那 239 个分片整块漏掉，#4 的比值就失真了。
    // document.fonts 只含 @font-face 注册项、不含系统字体，所以全量统计是安全的。
    setFontFaces(collectFontFaces())
    const variant = FONT_VARIANTS[props.fontResult?.id ?? DEFAULT_VARIANT]
    const code = CODE_FONTS[props.codeFontResult?.id ?? DEFAULT_CODE_FONT]
    setShards({ ...collectFontShards(variant.shards + code.shards), shardsAvailable: variant.shards + code.shards })
  }

  async function refreshMem() {
    setMem(await collectMemory())
  }

  /**
   * 每 3s 刷一次内存与字体统计。
   *
   * 必须能被暂停：`probe_memory` 在 Rust 侧会 fork 一个 `ps` 子进程，回调里还要遍历
   * 97 个 FontFace。这两件事如果落在 #1 的 5 秒采样窗口里，会在主线程上砸出
   * 超过 33ms 的帧，被 `jankFrames` 记成卡顿——那是探针自己在制造噪声。
   */
  function startPolling() {
    window.clearInterval(memTimer)
    memTimer = window.setInterval(() => {
      void refreshMem()
      refreshFonts()
    }, 3000)
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
    startPolling()
    document.addEventListener('visibilitychange', onVisibility)
    // 仓库根放了 `.m0-autotest` 开关文件才自动跑 #1 的滚动矩阵。
    // 常开会让每次启动都被独占 30 秒并反复重建编辑器，日常使用不可接受。
    if ('__TAURI_INTERNALS__' in window) {
      void invoke<boolean>('autotest_enabled')
        .then((on) => {
          if (on) void runMatrix()
        })
        .catch(() => {
          /* 命令不可用时静默跳过，不影响面板其余功能 */
        })
    }
  })

  onCleanup(() => {
    window.clearInterval(memTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    sampler.stop()
  })

  function startSampling() {
    setSampling(true)
    setFps(null)
    // 采样期间停掉 3s 轮询，理由见 startPolling 的注释：探针自己会制造假卡顿帧
    window.clearInterval(memTimer)
    sampler.start()
    window.setTimeout(() => {
      // 记下采样结束时的可见性。窗口被遮挡时 rAF 冻结、帧数会塌掉，
      // 本项目已经因为漏记这个字段白跑过两轮，必须能事后识别脏样本。
      const sample: FpsSample = {
        ...sampler.stop(),
        visibility: document.visibilityState,
        at: new Date().toISOString(),
        doc: props.stats?.label ?? '(未知)',
        lineWrap: props.stats?.lineWrap ?? false,
      }
      setFps(sample)
      setFpsHistory([...fpsHistory(), sample])
      setSampling(false)
      startPolling()
    }, 5000)
  }

  /**
   * #1 的客观一半：四个组合（10k/50k × 换行开/关）× 两种速度口径 = 八档，自动采齐。
   *
   * 复用面板自己的轮询开关——采样窗口内必须停掉 3s 轮询，否则 `probe_memory`
   * fork 的 `ps` 会在主线程砸出假卡顿帧，理由同 startSampling。
   */
  async function runMatrix() {
    const at = props.autotest
    if (!at) return
    setMatrixNote('滚动矩阵启动中 — 请别操作窗口，八档约 40s')
    alignSuspended = true
    const samples = await runScrollMatrix({
      load: at.load,
      setWrap: at.setWrap,
      scroller: () => props.getView()?.scrollDOM ?? null,
      pausePolling: () => window.clearInterval(memTimer),
      resumePolling: startPolling,
      onSample: (s, i, total) => {
        setScrollSamples((prev) => [...prev, s])
        setMatrixNote(
          `${i}/${total} · ${s.speed === 'realistic' ? '手感档' : '压力档'} ${s.doc} 换行${
            s.lineWrap ? '开' : '关'
          } → ${s.avgFps.toFixed(1)}fps` + (s.aborted ? `（作废：${s.aborted}）` : ''),
        )
      },
    })
    setMatrixNote(
      `完成 ${samples.length} 档 · 有效 ${samples.filter((s) => !s.aborted).length} 档 · 已写 .m0-scroll.json`,
    )
    alignSuspended = false
    // 矩阵结束时文档停在含围栏代码块的 fixture 上，这是唯一能拿到「CM6 里真实
    // .vela-code 行」读数的时机：启动文档是 empty，一个代码块都没有，只能退回测试台 div，
    // 而那条只是间接证据——证明不了语法节点真的把字体换掉了。
    await runAlign()
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

  async function runAlign(force = false) {
    if (alignBusy()) return
    // 挂起期间不测。measureAlignment 会 await document.fonts.load 再往 body 挂隐藏 div
    // 量宽度，主线程上要花几十毫秒；落进滚动矩阵的采样窗口就会砸出 >33ms 的帧被记成
    // 卡顿——与 3s 轮询 fork `ps` 是同一类探针自我污染。
    // force 只豁免单次调用（导出报告），不去动全局标志，否则矩阵会在不知不觉中失去保护。
    if (alignSuspended && !force) return
    setAlignBusy(true)
    try {
      const contentDOM = props.getView()?.contentDOM ?? null
      // 优先量 DOM 里真实的代码行。只量测试台 div 证明不了编辑器里真的换上了等宽字体，
      // 而这一条恰好是「语法节点 → 行装饰 → CSS → 解析字体 → 字形度量」整条链的终点。
      const codeEl = contentDOM?.querySelector<HTMLElement>('.vela-code') ?? null
      const pair: AlignPair = {
        editor: contentDOM ? await measureAlignment(contentDOM) : null,
        bench: await measureAlignment(alignRef ?? null),
        code: await measureAlignment(codeEl ?? alignRef ?? null),
        codeTarget: codeEl
          ? 'CM6 里真实的 .vela-code 代码行'
          : '文档里没有代码块/表格，退回测试台 div',
        control: await measureAlignment(alignRef ?? null, MONO_CONTROL),
        at: new Date().toISOString(),
        visibility: document.visibilityState,
      }
      setAlign(pair)
      await persistAlign(pair)
    } finally {
      setAlignBusy(false)
    }
  }

  /**
   * 量完自动落盘，#3 就不需要人点按钮再念数字了。
   *
   * 这里直接探 `__TAURI_INTERNALS__` 而不用 `inTauri()` 信号：字体注入触发的首次
   * 测量可能早于 onMount 给信号赋值。
   */
  async function persistAlign(pair: AlignPair) {
    if (!('__TAURI_INTERNALS__' in window)) return
    try {
      await invoke('save_probe_slot', {
        slot: 'align',
        json: JSON.stringify(
          {
            measuredAt: new Date().toISOString(),
            fontVariant: props.fontResult?.id ?? null,
            // #3 的判定对象由这一项决定。不记下来，事后就分不清某条读数是
            // Maple Mono CN 量的还是「跟随正文」量的——同一个坑本项目踩过两次。
            codeFontVariant: props.codeFontResult?.id ?? null,
            codeFontStack: props.codeFontResult?.stack ?? null,
            devicePixelRatio: window.devicePixelRatio,
            // pair 里的 at / visibility 是取样状态：hidden 意味着窗口被遮挡、
            // WebKit 挂起了渲染，那一条要按脏样本对待
            ...pair,
          },
          null,
          2,
        ),
      })
    } catch {
      /* 落盘失败不影响面板显示 */
    }
  }

  // #3 的结论由当前字体**和当前文档**共同决定：分字体之后判定对象是代码区，
  // 而 empty 文档里一个代码块都没有，只能退回测试台 div 拿间接证据。
  // 任一下拉切换、或换成含围栏代码块的 fixture，都必须重测，
  // 否则面板会留着上一个状态的比值，而它看起来仍然像是当前读数。
  createEffect(() => {
    props.fontResult?.id
    props.codeFontResult?.id
    props.codeFontResult?.stack
    props.stats?.label
    props.stats?.lineWrap
    void runAlign()
  })

  /**
   * 窗口转为可见时重测一次。
   *
   * 冷启动那一瞬间窗口还没真正显示，`visibilityState` 是 hidden，WebKit 此时挂起渲染，
   * 量出来的字体度量不能代表用户实际看到的状态。本项目已经因为漏看这个字段白跑过
   * 两轮 A/B，所以这里不靠人守窗口，让测量自己等到干净状态。
   */
  function onVisibility() {
    if (document.visibilityState === 'visible') void runAlign()
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

  /**
   * 导出全部实测数据 + 人工勾选结论到 .m0-report.json。
   *
   * 为什么要落盘：这些数字活在 WKWebView 的 DOM 里，从 webview 外部读不到，
   * 靠人逐条念既慢又容易抄错。落盘后可直接进《M0 验证报告》。
   */
  async function exportReport() {
    if (!inTauri()) {
      setExportState('失败：当前不在 Tauri 里，save_probe_report 命令不可用')
      return
    }
    // 导出前强制刷新一次，避免写出 3 秒定时器间隙里的旧值
    refreshFonts()
    await refreshMem()
    // 列对齐同理：重测一次，保证报告里的比值和同批记录的字体变体是同一状态。
    // 导出是显式触发的一次性动作，即使正处矩阵挂起期也强制测——否则报告里会带上
    // 上一个状态的旧比值，而且看不出来它是旧的。
    await runAlign(true)

    const report = {
      measuredAt: new Date().toISOString(),
      env: {
        inTauri: inTauri(),
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      },
      startup: {
        // #6 的判据是这一项；为 null 时本次判定不可信（缺进程拉起与 WKWebView 创建）
        processToReadyMs: props.processToReadyMs,
        judge: props.processToReadyMs === null ? 'frontend-clock (understates)' : 'process-clock (end-to-end)',
        scriptStartMs: props.scriptStartMs,
        editorReadyMs: props.editorReadyMs,
        webviewCreateMs:
          props.processToReadyMs === null ? null : props.processToReadyMs - props.editorReadyMs,
        rustUptimeMs: mem().rustUptimeMs,
        budgetMs: STARTUP_BUDGET_MS,
        passed: startupMs() < STARTUP_BUDGET_MS,
      },
      font: {
        applied: props.fontResult,
        // #3 的判定对象由这一档决定，不导出就无法事后复现结论
        codeApplied: props.codeFontResult,
        shards: shards(),
        faces: fontFaces(),
        facesByFamily: facesByFamily(),
        budgetBytes: FONT_BUDGET_BYTES,
      },
      memory: { ...mem(), budgetKb: MEM_BUDGET_KB },
      scroll: {
        fps: fps(),
        history: fpsHistory(),
        matrix: scrollSamples(),
        budgetFps: FPS_BUDGET,
        sampling: sampling(),
      },
      alignment: align(),
      editLatency: latency(),
      doc: props.stats,
      checklist: CHECKLIST.map((c) => ({
        id: c.id,
        label: c.label,
        passed: !!checked()[c.id],
      })),
      passedCount: doneCount(),
      totalChecks: CHECKLIST.length,
    }

    try {
      const path = await invoke<string>('save_probe_slot', {
        slot: 'report',
        json: JSON.stringify(report, null, 2),
      })
      setExportState(`已导出 → ${path}`)
    } catch (e) {
      setExportState(`失败：${String(e)}`)
    }
  }

  const doneCount = () => CHECKLIST.filter((c) => checked()[c.id]).length
  /**
   * #6 判定优先用进程级读数。非 Tauri 下退化到 performance.now()，
   * 此时只能算参考值——它不含进程拉起与 WKWebView 创建，必然偏小。
   */
  const startupMs = () => props.processToReadyMs ?? props.editorReadyMs
  const readyClass = () => (startupMs() < STARTUP_BUDGET_MS ? 'ok' : 'bad')
  const memClass = () => (mem().rustRssKb > 0 && mem().rustRssKb < MEM_BUDGET_KB ? 'ok' : mem().rustRssKb === 0 ? '' : 'bad')
  const fontClass = () => (shards().totalBytes < FONT_BUDGET_BYTES ? 'ok' : 'warn')
  const fpsClass = () => (fps() && fps()!.avgFps >= FPS_BUDGET ? 'ok' : 'bad')
  /**
   * 按 family 分组统计 face。
   *
   * 分字体之后同时驻留两套 webfont（正文文楷 + 代码区 Maple Mono CN），
   * 混在一个总数里就分不清哪一套真的按需拉了分片——#4 的懒加载结论要分family看。
   */
  const facesByFamily = () => {
    const groups = new Map<string, { family: string; total: number; loaded: number; weights: string[] }>()
    for (const f of fontFaces()) {
      const g = groups.get(f.family) ?? { family: f.family, total: 0, loaded: 0, weights: [] }
      g.total += 1
      if (f.status === 'loaded') {
        g.loaded += 1
        g.weights.push(f.weight)
      }
      groups.set(f.family, g)
    }
    return [...groups.values()].sort((a, b) => b.loaded - a.loaded)
  }
  /**
   * #3 的判定对象是**代码区**。
   *
   * 分字体之后 `editor`（contentDOM）量到的是正文文楷，它报 mono=false 是预期结果，
   * 拿它判定会把「正文本来就不等宽」误读成「#3 失败」。退回顺序 code → editor → bench
   * 只是为了编辑器尚未挂载时面板不至于空白。
   */
  const alignMain = () => {
    const a = align()
    return a ? (a.code ?? a.editor ?? a.bench) : null
  }
  /**
   * 三个目标的比值并排显示。代码区与测试台同源（都走 --vela-font-code），
   * 两者分歧说明 CM6 theme 覆盖了字体栈；正文那栏单独标出来，它不要求 = 2。
   */
  const alignCompare = () => {
    const a = align()
    if (!a) return ''
    const code = a.code ? a.code.cjkOverAscii.toFixed(4) : '未挂载'
    const editor = a.editor ? a.editor.cjkOverAscii.toFixed(4) : '未挂载'
    return `代码区 ${code} · 正文 ${editor}（不要求=2）· 测试台 ${a.bench.cjkOverAscii.toFixed(4)}`
  }

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
          <span class="metric-key">进程启动 → 可输入（#6 判定）</span>
          <span class={`metric-val ${readyClass()}`}>
            {props.processToReadyMs === null
              ? `≈${props.editorReadyMs.toFixed(1)} ms（非 Tauri，偏小）`
              : `${props.processToReadyMs.toLocaleString()} ms`}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-key">导航开始 → 编辑器就绪</span>
          <span class="metric-val">{props.editorReadyMs.toFixed(1)} ms</span>
        </div>
        <div class="metric-row">
          <span class="metric-key">进程拉起 + WKWebView 创建</span>
          <span class="metric-val">
            {props.processToReadyMs === null
              ? '取不到（非 Tauri）'
              : `${(props.processToReadyMs - props.editorReadyMs).toLocaleString()} ms`}
          </span>
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
          第 1 行才是 #6 的判据，它取自 Rust 侧时钟，覆盖「进程拉起 → 创建 WKWebView → 导航 → 前端就绪」
          全链路。第 2 行的 <code>performance.now()</code> 原点是导航开始，单看它必然低估——
          macOS 上 WKWebView 的创建并不便宜，两者之差（第 3 行）就是被漏掉的部分。
          读数含一次 IPC 往返（个位数 ms），相对 1000ms 预算可忽略。
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
        <Show
          when={props.codeFontResult}
          fallback={
            <div class="metric-row">
              <span class="metric-key">代码区字体</span>
              <span class="metric-val">未注入</span>
            </div>
          }
        >
          <div class="metric-row">
            <span class="metric-key">代码区字体（#3 判定对象）</span>
            <span class="metric-val">{CODE_FONTS[props.codeFontResult!.id].label}</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">代码区注入耗时</span>
            <span class="metric-val">
              {props.codeFontResult!.injected
                ? `${props.codeFontResult!.ms.toFixed(1)} ms${props.codeFontResult!.fromCache ? '（chunk 缓存命中）' : ''}`
                : '跳过（未变）'}
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">代码区 CSS / 条数</span>
            <span class="metric-val">
              {formatBytes(props.codeFontResult!.cssBytes)} / {props.codeFontResult!.faces} 条
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">--vela-font-code</span>
            <span class="metric-val">{props.codeFontResult!.stack}</span>
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
        <For each={facesByFamily()}>
          {(g) => (
            <div class="metric-row">
              <span class="metric-key">font-face · {g.family}</span>
              <span class="metric-val">
                已加载 {g.loaded} / 注册 {g.total} · weight {[...new Set(g.weights)].join(', ') || '—'}
              </span>
            </div>
          )}
        </For>
        <div class="metric-row">
          <span class="metric-key">font-face 合计</span>
          <span class="metric-val">
            {fontFaces().filter((f) => f.status === 'loaded').length} / {fontFaces().length}
          </span>
        </div>
        <button onClick={refreshFonts}>刷新字体统计</button>
        <p class="note">
          @font-face 是运行时按需注入的（D7）。按内容分字体（D2）之后**同时驻留两套**：正文文楷走
          <code>vela-font-faces</code>，代码区 Maple Mono CN 走独立的 <code>vela-code-font-faces</code>
          ——两个 style 节点缺一不可，合并会让后注入的把前一套整块冲掉。正文变体内部仍是整块替换，
          避开包内 4 变体 family 同名冲突（R14）。所以上面分片分母是两者之和。
          生僻字（龘靐𠀀）落在不同分片，滚动到含它们的行后刷新，对应 family 的已加载数应上升。
          把正文切到「系统等宽」对照组、代码区切到「跟随正文」，应看到两组 family 都变空。
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
          <Show when={fps()!.visibility !== 'visible' || fps()!.samples < 200}>
            <div class="metric-row">
              <span class="metric-key">⚠️ 这次采样不可信</span>
              <span class="metric-val bad">
                {fps()!.visibility !== 'visible'
                  ? `窗口处于 ${fps()!.visibility}，rAF 被冻结`
                  : `只采到 ${fps()!.samples} 帧（应约 300）`}
              </span>
            </div>
          </Show>
        </Show>
        <p class="note">
          rAF 在窗口隐藏时会被冻结，采样期间务必保持窗口在前台且不被遮挡——帧数应约 300（5s × 60Hz），
          远低于此值说明采样期间窗口被遮挡过，这一轮作废。采样期间 3s 内存轮询会自动暂停，
          避免探针自己 fork 的 <code>ps</code> 制造假卡顿帧。分别测「换行开」与「换行关」两种状态，
          并测 10k / 50k 两档文档量。
        </p>
        <Show when={fpsHistory().length > 1}>
          <div class="probe-title">本轮全部采样（{fpsHistory().length} 次，导出报告时会全部带上）</div>
          <For each={fpsHistory()}>
            {(s) => (
              <div class="metric-row">
                <span class="metric-key">
                  {s.doc} · 换行{s.lineWrap ? '开' : '关'}
                  {s.visibility !== 'visible' || s.samples < 200 ? ' ⚠️不可信' : ''}
                </span>
                <span class={`metric-val ${s.avgFps >= FPS_BUDGET ? 'ok' : 'bad'}`}>
                  {s.avgFps.toFixed(1)} fps · 卡顿 {s.jankFrames}/{s.samples} · p95 {s.p95FrameMs.toFixed(1)}ms
                </span>
              </div>
            )}
          </For>
        </Show>
        <div class="probe-title">自动滚动矩阵 · #1 客观基线</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button onClick={() => void runMatrix()} disabled={!props.autotest}>
            跑八档矩阵（约 40s）
          </button>
          <Show when={matrixNote()}>
            <span class="metric-val">{matrixNote()}</span>
          </Show>
        </div>
        <For each={scrollSamples()}>
          {(s) => (
            <div class="metric-row">
              <span class="metric-key">
                {s.speed === 'realistic' ? '🖐 手感档' : '🔥 压力档'} · {s.doc} · 换行
                {s.lineWrap ? '开' : '关'} · {(s.travelPx / 1000).toFixed(1)}k px @{' '}
                {(s.achievedPxPerS / 1000).toFixed(1)}k px/s · {s.scrollSteps} 帧
              </span>
              <span
                class={`metric-val ${
                  s.aborted
                    ? 'bad'
                    : s.speed === 'realistic'
                      ? s.avgFps >= FPS_BUDGET
                        ? 'ok'
                        : 'bad'
                      : ''
                }`}
              >
                {s.aborted
                  ? `作废：${s.aborted}`
                  : `${s.avgFps.toFixed(1)} fps · 卡顿 ${s.jankFrames}/${s.samples} · p95 ${s.p95FrameMs.toFixed(1)}ms · 最长 ${s.maxFrameMs.toFixed(1)}ms`}
              </span>
            </div>
          )}
        </For>
        <p class="note">
          合成滚动：程序化写 <code>scrollTop</code>，同时采帧计时。每个文档组合跑两种速度口径——
          <strong>手感档</strong> 3000px/s（≈每秒 214 行，触控板正常滑动量级，判 #1 看这一档），
          <strong>压力档</strong> 全范围三角波（10k 换行下高达 12 万 px/s，比人手快两个数量级）。
          压力档跑不满 60fps 是正常结果，别把它读成日常滚动卡顿；它的用途是上界——
          连这一档 p95 都守得住，说明掉帧不是滚动速度造成的。
          ⚠️ 两档都绕开了触控板惯性的原生手势路径，而 discussions#8436 报告的微延迟恰好在那条路径上，
          所以这只是**回归基线**，答不了「手感」——最后仍需人滚一下确认。
          采样期间窗口被遮挡的那一档会自动标作废，不会混进结论。
          仓库根放一个 <code>.m0-autotest</code> 空文件，下次启动会自动跑这套矩阵；
          机器休眠会让窗口变 hidden 从而整轮判废，跑之前用 <code>caffeinate -dimsu</code> 撑住显示器。
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
        <div class="probe-title">列对齐测试台 · 验收 #3（自动量化）</div>
        <Show when={align() && alignMain()}>
          <div class="metric-row">
            <span class="metric-key">量具自检（系统等宽对照）</span>
            <span class={`metric-val ${align()!.control.mono ? 'ok' : 'bad'}`}>
              {align()!.control.mono
                ? `✅ 对照组 ASCII 极差 ${align()!.control.asciiSpreadPx.toFixed(4)}px，量具可信`
                : `❌ 对照组 ASCII 极差 ${align()!.control.asciiSpreadPx.toFixed(4)}px — 量具本身有问题，下面读数全部作废`}
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">判定</span>
            <span class={`metric-val ${alignMain()!.aligned ? 'ok' : 'bad'}`}>
              {alignMain()!.aligned
                ? '✅ 代码区对齐（#3 通过）'
                : `❌ 代码区不对齐 — 当前 ${CODE_FONTS[props.codeFontResult?.id ?? DEFAULT_CODE_FONT].label} 未满足 2:1 等宽，换一档或换字体包`}
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">CJK / ASCII 步进比</span>
            <span class={`metric-val ${Math.abs(alignMain()!.cjkOverAscii - 2) < 0.005 ? 'ok' : 'bad'}`}>
              {alignMain()!.cjkOverAscii.toFixed(4)}（须 = 2.0000）
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">框线 / ASCII 步进比</span>
            <span class={`metric-val ${Math.abs(alignMain()!.boxOverAscii - 1) < 0.005 ? 'ok' : 'bad'}`}>
              {alignMain()!.boxOverAscii.toFixed(4)}（须 = 1.0000）
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">ASCII 步进极差</span>
            <span class={`metric-val ${alignMain()!.mono ? 'ok' : 'bad'}`}>
              {alignMain()!.asciiSpreadPx.toFixed(4)} px
              {alignMain()!.mono ? ' — 拉丁等宽' : ' — 拉丁是比例宽度，不能用于代码区'}
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">逐字符步进</span>
            <span class="metric-val">
              {Object.entries(alignMain()!.asciiSamples)
                .map(([ch, w]) => `${ch}=${w}`)
                .join(' ')}
            </span>
          </div>
          <div class="metric-row">
            <span class="metric-key">50 个中文字累积漂移</span>
            <span class={`metric-val ${alignMain()!.aligned ? 'ok' : 'bad'}`}>{alignMain()!.driftPxPer50Cjk} px</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">三档步进比</span>
            <span class="metric-val">{alignCompare()}</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">代码区量的是</span>
            <span class={`metric-val ${align()!.code ? '' : 'warn'}`}>{align()!.codeTarget}</span>
          </div>
          <div class="metric-row">
            <span class="metric-key">测量对象</span>
            <span class="metric-val">
              {alignMain()!.fontFamily} @ {alignMain()!.fontSizePx}px · woff2 face{' '}
              {alignMain()!.cjkFaceLoaded ? '已加载' : '未加载'}
            </span>
          </div>
          <Show when={align()!.visibility !== 'visible'}>
            <div class="metric-row">
              <span class="metric-key">⚠️ 这次测量不可信</span>
              <span class="metric-val bad">取样时窗口处于 {align()!.visibility}，WebKit 已挂起渲染</span>
            </div>
          </Show>
        </Show>
        <button onClick={() => void runAlign()} disabled={alignBusy()}>
          {alignBusy() ? '测量中…' : align() ? '重测列对齐' : '测量列对齐'}
        </button>
        <div class="align-test" ref={alignRef}>
          {ALIGN_SAMPLE}
        </div>
        <p class="note">
          上面的数字才是 #3 的判据，框线只作肉眼复核：人眼看不出 0.3px 的步进差，但 50 个中文字累积下来
          就是 15px 的错位。按内容分字体（D2）之后判定链是「Markdown 语法节点 → 行装饰 <code>.vela-code</code>
          → <code>--vela-font-code</code> → 解析出的字体 → 字形步进」，优先量 CM6 DOM 里真实的代码行，
          文档里没有代码块/表格时才退回下面的测试台 div（<code>.align-test</code> 也已指向代码区字体）。
          工具栏两个下拉各自触发重测：正文下拉换文楷 Screen GB / R / 系统等宽，代码区下拉换 Maple Mono CN /
          跟随正文——切到「跟随正文」应当立刻看到 #3 变红，这本身就是分流生效的反向证据。
          必须在 Tauri 窗口里读这个数：Chromium 的字体回退与栅格化和 WKWebView 不同。
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
        <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
          <button class="primary" onClick={() => void exportReport()}>
            导出 M0 报告数据
          </button>
          <button onClick={resetChecklist}>清空勾选</button>
        </div>
        <Show when={exportState()}>
          <p class="note">{exportState()}</p>
        </Show>
        <p class="note">
          导出会把上面所有实测数字连同你的勾选一起写到仓库根的 <code>.m0-report.json</code>。
          建议顺序：先做完 #1 滚动手感（含 5 秒帧率采样）和 #2 IME，再逐项勾选，最后导出。
        </p>
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
