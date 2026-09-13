import { createSignal, onCleanup, onMount } from 'solid-js'
import { EditorView } from '@codemirror/view'
import { createEditor } from './editor/setup'
import {
  applyFontVariant,
  DEFAULT_VARIANT,
  FONT_VARIANTS,
  type FontApplyResult,
  type FontVariantId,
} from './fonts/loader'
import { generateAsciiFixture, generateFixture, type Fixture } from './probe/fixtures'
import type { DocStats } from './probe/metrics'
import ProbePanel from './probe/ProbePanel'

/** M0 主壳：一个编辑器 + 一个探针面板，不做任何业务功能。 */
export default function App() {
  let containerEl!: HTMLDivElement
  let fileEl!: HTMLInputElement
  let view: EditorView | undefined

  const [fontKey, setFontKey] = createSignal<FontVariantId>(DEFAULT_VARIANT)
  const [fontResult, setFontResult] = createSignal<FontApplyResult | null>(null)
  const [fontSize, setFontSize] = createSignal(14)
  const [wrap, setWrap] = createSignal(true)
  const [panelOpen, setPanelOpen] = createSignal(true)
  const [stats, setStats] = createSignal<DocStats | null>(null)
  const [editorReadyMs, setEditorReadyMs] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  /** 供探针面板做编辑延迟测量 */
  const getView = () => view

  /** 字体是动态 import，切换有真实异步成本；探针面板需要看到这个数字 */
  async function switchFont(id: FontVariantId) {
    setFontKey(id)
    setFontResult(await applyFontVariant(id))
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
    })
    // 首次挂载的时间才是「冷启动到可交互」
    if (editorReadyMs() === 0) setEditorReadyMs(done)
  }

  function load(kind: 'mixed-10k' | 'ascii-10k' | 'mixed-20k' | 'mixed-50k') {
    setBusy(true)
    // 让 UI 有机会先重绘，避免长时间同步生成阻塞按钮反馈
    requestAnimationFrame(() => {
      const t0 = performance.now()
      const fixture =
        kind === 'ascii-10k'
          ? generateAsciiFixture(10_000)
          : generateFixture({ lines: kind === 'mixed-10k' ? 10_000 : kind === 'mixed-20k' ? 20_000 : 50_000 })
      mount(fixture, kind, t0)
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
    // 冷启动计时（验收项 #6）不该被 30KB 的 CSS chunk 拖住，
    // 字体到达后浏览器自己会用 font-display: swap 重排。
    void switchFont(DEFAULT_VARIANT)
    load('mixed-10k')
  })

  onCleanup(() => view?.destroy())

  return (
    <div class="app">
      <div class="toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">文档</span>
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
          >
            {Object.values(FONT_VARIANTS).map((v) => (
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
                setStats({ ...prev, loadMs: performance.now() - t0 })
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
            editorReadyMs={editorReadyMs()}
            scriptStartMs={window.__VELA_T0 ?? 0}
          />
        )}
      </div>
    </div>
  )
}
