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
  type CodeFontId,
  type FontVariantId,
} from './fonts/loader'

interface DocStats {
  label: string
  lines: number
  bytes: number
  longestLine: number
}

export default function App() {
  let containerEl!: HTMLDivElement
  let fileEl!: HTMLInputElement
  let view: EditorView | undefined

  const [fontKey, setFontKey] = createSignal<FontVariantId>(DEFAULT_VARIANT)
  const [codeFontKey, setCodeFontKey] = createSignal<CodeFontId>(DEFAULT_CODE_FONT)
  const [fontSize, setFontSize] = createSignal(14)
  const [wrap, setWrap] = createSignal(true)
  const [stats, setStats] = createSignal<DocStats | null>(null)
  const [busy, setBusy] = createSignal(false)

  /** 字体是动态 import，切换有真实异步成本，所以要 await 完再让 UI 认为切换结束 */
  async function switchFont(id: FontVariantId) {
    setFontKey(id)
    await applyFontVariant(id)
  }

  /** 代码区字体与正文字体正交，独立切换、独立注入，两个 family 同时驻留 */
  async function switchCodeFont(id: CodeFontId) {
    setCodeFontKey(id)
    await applyCodeFont(id)
  }

  function applyFontSize() {
    document.documentElement.style.setProperty('--vela-font-size', `${fontSize()}px`)
  }

  function mount(text: string, label: string) {
    view?.destroy()
    view = createEditor(containerEl, { doc: text, lineWrap: wrap() })
    let longest = 0
    for (const line of text.split('\n')) if (line.length > longest) longest = line.length
    setStats({
      label,
      lines: text === '' ? 0 : text.split('\n').length,
      bytes: text.length,
      longestLine: longest,
    })
  }

  /** lineWrapping 是 extension，切换必须重建视图；重建前抓走文档与滚动位置 */
  function remountWithWrap(next: boolean) {
    if (!view) return
    const doc = view.state.doc.toString()
    const scrollTop = view.scrollDOM.scrollTop
    view.destroy()
    view = createEditor(containerEl, { doc, lineWrap: next })
    view.scrollDOM.scrollTop = scrollTop
  }

  async function onPickFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    mount(await file.text(), file.name)
    setBusy(false)
  }

  onMount(() => {
    applyFontSize()
    // 字体注入与编辑器挂载并行：编辑器不等字体，到达后浏览器自己用 font-display: swap 重排。
    void switchFont(DEFAULT_VARIANT)
    void switchCodeFont(DEFAULT_CODE_FONT)
    mount('', '空文档')
  })

  onCleanup(() => view?.destroy())

  return (
    <div class="app">
      <div class="toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">文档</span>
          <button onClick={() => mount('', '空文档')} disabled={busy()}>
            空文档
          </button>
          <button class="primary" onClick={() => fileEl.click()} disabled={busy()}>
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
              remountWithWrap(next)
            }}
          >
            {wrap() ? '开' : '关'}
          </button>
        </div>

        <div class="toolbar-group" style="margin-left:auto;border-right:none">
          <span class="badge">{busy() ? '加载中…' : (stats()?.label ?? '空')}</span>
          {stats() && (
            <span class="badge">
              {stats()!.lines.toLocaleString()} 行 · {(stats()!.bytes / 1024).toFixed(0)} KB · 最长{' '}
              {stats()!.longestLine} 字符
            </span>
          )}
        </div>
      </div>

      <div class="body">
        <div class="editor-host">
          <div class="editor-container" ref={containerEl} />
        </div>
      </div>
    </div>
  )
}
