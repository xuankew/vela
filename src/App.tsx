import { createSignal, onCleanup, onMount } from 'solid-js'
import { registerBuiltinCommands } from './commands/builtins'
import { attachKeybindingDispatch } from './commands/dispatch'
import { detectPlatform } from './commands/keybinding'
import { createCommandRegistry, type AppContext } from './commands/registry'
import type { EditorController } from './editor/controller'
import { EditorPane } from './editor/EditorPane'
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

const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20]
const DEFAULT_FONT_SIZE = 14

export default function App() {
  let fileEl!: HTMLInputElement
  let disposeCommands: (() => void) | undefined
  let detachKeys: (() => void) | undefined

  /**
   * 当前编辑器实例。刻意不是 signal：眼下没有任何渲染依赖它，命令的 `when` 在被调用时
   * 读一次就够。**命令面板落地时必须改成 signal**，否则面板里 `editor.*` 的置灰状态
   * 不会跟着焦点走（`list()` 求值 `when` 的时刻比焦点变化早）。
   */
  let editor: EditorController | null = null

  const [fontKey, setFontKey] = createSignal<FontVariantId>(DEFAULT_VARIANT)
  const [codeFontKey, setCodeFontKey] = createSignal<CodeFontId>(DEFAULT_CODE_FONT)
  const [fontSize, setFontSize] = createSignal(DEFAULT_FONT_SIZE)
  const [wrap, setWrap] = createSignal(true)
  const [docLabel, setDocLabel] = createSignal('空文档')
  const [docLines, setDocLines] = createSignal(0)
  const [docChars, setDocChars] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  const registry = createCommandRegistry({
    platform: detectPlatform(),
    getContext: (): AppContext => ({ editor }),
  })

  function applyFontSize() {
    document.documentElement.style.setProperty('--vela-font-size', `${fontSize()}px`)
  }

  /** 只在预设档位之间走：字号同时被工具栏的 select 显示，冒出 17px 这种档外值会让 select 变空白 */
  function stepFontSize(delta: number) {
    const index = FONT_SIZES.indexOf(fontSize())
    const next = index < 0 ? DEFAULT_FONT_SIZE : FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, index + delta))]!
    setFontSize(next)
    applyFontSize()
  }

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

  // 文档生命周期（新建/打开/保存/脏标记）等 M1-B 有了真正的文档模型再统一成命令，
  // 现在只有「打开文件」有后端可接，所以只把它注册成了 file.open。
  function newDocument() {
    editor?.setDoc('')
    setDocLabel('空文档')
    editor?.focus()
  }

  async function onPickFile(files: FileList | null) {
    const file = files?.[0]
    if (!file || !editor) return
    // 先清空 value：否则连续两次选同一个文件不会触发 change
    fileEl.value = ''
    setBusy(true)
    try {
      editor.setDoc(await file.text())
      setDocLabel(file.name)
      editor.focus()
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    applyFontSize()
    // 字体注入与编辑器挂载并行：编辑器不等字体，到达后浏览器自己用 font-display: swap 重排
    void switchFont(DEFAULT_VARIANT)
    void switchCodeFont(DEFAULT_CODE_FONT)
    disposeCommands = registerBuiltinCommands(registry, {
      openFile: () => fileEl.click(),
      applyLineWrap: (on) => {
        setWrap(on)
        editor?.setLineWrap(on)
      },
      adjustFontSize: stepFontSize,
      resetFontSize: () => {
        setFontSize(DEFAULT_FONT_SIZE)
        applyFontSize()
      },
    })
    detachKeys = attachKeybindingDispatch(registry)
  })

  onCleanup(() => {
    detachKeys?.()
    disposeCommands?.()
  })

  return (
    <div class="app">
      <div class="toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">文档</span>
          <button onClick={newDocument} disabled={busy()}>
            空文档
          </button>
          <button class="primary" onClick={() => void registry.execute('file.open')} disabled={busy()}>
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
            title="字号（也可用 Cmd/Ctrl + = / - / 0）"
          >
            {FONT_SIZES.map((s) => (
              <option value={s}>{s}px</option>
            ))}
          </select>
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">换行</span>
          <button onClick={() => void registry.execute('editor.toggleLineWrap')} title="Alt+Z">
            {wrap() ? '开' : '关'}
          </button>
        </div>

        <div class="toolbar-group" style="margin-left:auto;border-right:none">
          <span class="badge">{busy() ? '加载中…' : docLabel()}</span>
          <span class="badge">
            {docLines().toLocaleString()} 行 · {docChars().toLocaleString()} 字符
          </span>
        </div>
      </div>

      <div class="body">
        <div class="editor-host">
          <EditorPane
            options={{
              doc: '',
              lineWrap: true,
              onUpdate: (info) => {
                setDocLines(info.lines)
                setDocChars(info.chars)
              },
            }}
            onReady={(c) => {
              editor = c
              setDocLines(c.lines)
              setDocChars(c.chars)
            }}
          />
        </div>
      </div>
    </div>
  )
}
