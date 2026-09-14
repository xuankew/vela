import { createSignal, onCleanup, onMount } from 'solid-js'
import { EditorView } from '@codemirror/view'
import { createEditor } from './editor/setup'
import {
  applyCodeFont,
  applyFontVariant,
  CODE_FONTS,
  DEFAULT_CODE_FONT,
  DEFAULT_VARIANT,
  FONT_VARIANTS,
  type CodeFontApplyResult,
  type CodeFontId,
  type FontApplyResult,
  type FontVariantId,
} from './fonts/loader'
import { generateAsciiFixture, generateFixture, type Fixture } from './probe/fixtures'
import { collectProcessUptime, type DocStats } from './probe/metrics'
import ProbePanel from './probe/ProbePanel'
// TODO(M0-自动扫描): src/probe/sweep.ts 是 M0 的自动化测量模块，验收收尾时整个删除。
// 现在由 ProbePanel 调用：runScrollMatrix 跑 #1 的滚动矩阵（仓库根放 .m0-autotest 开关
// 文件则启动时自动跑），runSweep 暂未接线但保留——#7 还需在 dPR=2 的显示器上复测一次。

/** M0 主壳：一个编辑器 + 一个探针面板，不做任何业务功能。 */
export default function App() {
  let containerEl!: HTMLDivElement
  let fileEl!: HTMLInputElement
  let view: EditorView | undefined

  const [fontKey, setFontKey] = createSignal<FontVariantId>(DEFAULT_VARIANT)
  const [fontResult, setFontResult] = createSignal<FontApplyResult | null>(null)
  const [codeFontKey, setCodeFontKey] = createSignal<CodeFontId>(DEFAULT_CODE_FONT)
  const [codeFontResult, setCodeFontResult] = createSignal<CodeFontApplyResult | null>(null)
  const [fontSize, setFontSize] = createSignal(14)
  const [wrap, setWrap] = createSignal(true)
  const [panelOpen, setPanelOpen] = createSignal(true)
  const [stats, setStats] = createSignal<DocStats | null>(null)
  const [editorReadyMs, setEditorReadyMs] = createSignal(0)
  /**
   * 验收项 #6 的有效读数：Rust 进程启动 → 编辑器可输入，端到端。
   * editorReadyMs 是 performance.now()，原点为导航开始，不含进程拉起与
   * WKWebView 创建，会系统性低估真实冷启动。null 表示非 Tauri 环境取不到。
   */
  const [processToReadyMs, setProcessToReadyMs] = createSignal<number | null>(null)
  const [busy, setBusy] = createSignal(false)

  /** 供探针面板做编辑延迟测量 */
  const getView = () => view

  /** 字体是动态 import，切换有真实异步成本；探针面板需要看到这个数字 */
  async function switchFont(id: FontVariantId) {
    setFontKey(id)
    setFontResult(await applyFontVariant(id))
  }

  /** 代码区字体与正文字体正交，独立切换、独立注入，两个 family 同时驻留 */
  async function switchCodeFont(id: CodeFontId) {
    setCodeFontKey(id)
    setCodeFontResult(await applyCodeFont(id))
  }

  function applyFontSize() {
    document.documentElement.style.setProperty('--vela-font-size', `${fontSize()}px`)
  }

  function mount(fixture: Fixture, label: string, t0: number) {
    view?.destroy()
    view = createEditor(containerEl, {
      doc: fixture.text,
      lineWrap: wrap(),
      markdownMode: !label.includes('ASCII'),
    })
    const done = performance.now()
    setStats({
      label,
      lines: fixture.lineCount,
      bytes: fixture.byteLength,
      longestLine: fixture.longestLine,
      loadMs: done - t0,
      lineWrap: wrap(),
    })
    // 首次挂载的时间才是「冷启动到可交互」
    if (editorReadyMs() === 0) {
      setEditorReadyMs(done)
      // 同步发起、不 await：多等一拍就把后续渲染算进冷启动了
      void collectProcessUptime().then((ms) => {
        if (ms > 0) setProcessToReadyMs(ms)
      })
    }
  }

  type DocKind = 'empty' | 'mixed-10k' | 'mixed-10k-common' | 'ascii-10k' | 'mixed-20k' | 'mixed-50k'

  function loadSync(kind: DocKind) {
    const t0 = performance.now()
    // 空文档是验收项 #7「空转常驻内存」的判据前提。
    // 没有它就只能测到「已加载万行文档」，而预算参照的是 Tauri 空壳 ~172MB。
    const fixture: Fixture =
      kind === 'empty'
        ? { text: '', lineCount: 0, byteLength: 0, longestLine: 0 }
        : kind === 'ascii-10k'
          ? generateAsciiFixture(10_000)
          : kind === 'mixed-10k-common'
            ? // #4 判预算专用：mixed-10k 刻意塞了 30 个跨区块生僻字（一字一分片）来压
              // 懒加载，那是机制样本、不是用户会打开的文档，拿它判 2MB 必然超标。
              generateFixture({ lines: 10_000, rareHan: false })
            : generateFixture({
                lines: kind === 'mixed-10k' ? 10_000 : kind === 'mixed-20k' ? 20_000 : 50_000,
              })
    mount(fixture, kind, t0)
  }

  function load(kind: DocKind) {
    setBusy(true)
    // 让 UI 有机会先重绘，避免长时间同步生成阻塞按钮反馈。
    // 注意：自动扫描走 loadSync 而非这里——窗口被遮挡时 rAF 会冻结，扫描会卡死。
    requestAnimationFrame(() => {
      loadSync(kind)
      setBusy(false)
    })
  }

  async function onPickFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    const t0 = performance.now()
    const text = await file.text()
    const lines = text.split('\n').length
    let longest = 0
    for (const line of text.split('\n')) if (line.length > longest) longest = line.length
    mount(
      { text, lineCount: lines, byteLength: text.length, longestLine: longest },
      `file:${file.name}`,
      t0,
    )
    setBusy(false)
  }

  onMount(() => {
    applyFontSize()
    // 字体注入与编辑器挂载并行。编辑器不等字体：
    // 冷启动计时（验收项 #6）不该被 CSS chunk 拖住，
    // 字体到达后浏览器自己会用 font-display: swap 重排。
    // 代码区字体（Maple Mono CN，@font-face 声明 156KB）比正文的还大，同理走并行注入。
    void switchFont(DEFAULT_VARIANT)
    void switchCodeFont(DEFAULT_CODE_FONT)
    load('empty')
  })

  onCleanup(() => view?.destroy())

  return (
    <div class="app">
      <div class="toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">文档</span>
          <button onClick={() => load('empty')} disabled={busy()}>
            空文档
          </button>
          <button class="primary" onClick={() => load('mixed-10k')} disabled={busy()}>
            10k 混排
          </button>
          <button onClick={() => load('ascii-10k')} disabled={busy()}>
            10k ASCII
          </button>
          <button onClick={() => load('mixed-20k')} disabled={busy()}>
            20k
          </button>
          <button onClick={() => load('mixed-50k')} disabled={busy()}>
            50k
          </button>
          <button onClick={() => fileEl.click()} disabled={busy()}>
            打开文件…
          </button>
          <input
            ref={fileEl}
            type="file"
            style="display:none"
            onChange={(e) => void onPickFile(e.currentTarget.files)}
          />
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">字体</span>
          <select
            value={fontKey()}
            onChange={(e) => void switchFont(e.currentTarget.value as FontVariantId)}
            title="正文与 UI 字体"
          >
            {Object.values(FONT_VARIANTS).map((v) => (
              <option value={v.id}>{v.label}</option>
            ))}
          </select>
          <select
            value={codeFontKey()}
            onChange={(e) => void switchCodeFont(e.currentTarget.value as CodeFontId)}
            title="代码区字体（代码块 / 表格）"
          >
            {Object.values(CODE_FONTS).map((v) => (
              <option value={v.id}>{v.label}</option>
            ))}
          </select>
          <select
            value={fontSize()}
            onChange={(e) => {
              setFontSize(Number(e.currentTarget.value))
              applyFontSize()
            }}
          >
            {[12, 13, 14, 15, 16, 18, 20].map((s) => (
              <option value={s}>{s}px</option>
            ))}
          </select>
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">换行</span>
          <button
            onClick={() => {
              const next = !wrap()
              setWrap(next)
              const prev = stats()
              if (prev && view) {
                // lineWrapping 是 extension，切换必须重建视图。
                // 重建前抓走文档与滚动位置，否则切完就变空白，且测不到真实负载下的重建耗时。
                const doc = view.state.doc.toString()
                const scrollTop = view.scrollDOM.scrollTop
                const t0 = performance.now()
                view.destroy()
                view = createEditor(containerEl, {
                  doc,
                  lineWrap: next,
                  markdownMode: !prev.label.includes('ASCII'),
                })
                view.scrollDOM.scrollTop = scrollTop
                setStats({ ...prev, lineWrap: next, loadMs: performance.now() - t0 })
              }
            }}
          >
            {wrap() ? '开' : '关'}
          </button>
        </div>

        <div class="toolbar-group">
          <span class="badge">{busy() ? '加载中…' : (stats()?.label ?? '空')}</span>
          {stats() && (
            <span class="badge">
              {stats()!.lines.toLocaleString()} 行 · {(stats()!.bytes / 1024).toFixed(0)} KB · 最长{' '}
              {stats()!.longestLine} 字符
            </span>
          )}
        </div>

        <div class="toolbar-group" style="margin-left:auto;border-right:none">
          <button onClick={() => setPanelOpen(!panelOpen())}>
            {panelOpen() ? '隐藏探针' : '显示探针'}
          </button>
        </div>
      </div>

      <div class={`body${panelOpen() ? '' : ' panel-closed'}`}>
        <div class="editor-host">
          <div class="editor-container" ref={containerEl} />
        </div>
        {panelOpen() && (
          <ProbePanel
            getView={getView}
            stats={stats()}
            fontResult={fontResult()}
            codeFontResult={codeFontResult()}
            editorReadyMs={editorReadyMs()}
            processToReadyMs={processToReadyMs()}
            scriptStartMs={window.__VELA_T0 ?? 0}
            // #1 滚动矩阵要自己切文档量与换行开关，这两个能力只有这里有
            autotest={{ load: loadSync, setWrap: (v: boolean) => setWrap(v) }}
          />
        )}
      </div>
    </div>
  )
}
