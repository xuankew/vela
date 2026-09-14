import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { registerBuiltinCommands } from './commands/builtins'
import { attachKeybindingDispatch } from './commands/dispatch'
import { detectPlatform } from './commands/keybinding'
import { createCommandRegistry, type AppContext } from './commands/registry'
import { createDocumentModel, UNTITLED_LABEL } from './doc/document'
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
  const [docLines, setDocLines] = createSignal(0)
  const [docChars, setDocChars] = createSignal(0)

  /**
   * 文档模型。宿主能力通过闭包**惰性**读 `editor`：模型在组件体里就要建好（渲染要读它的
   * signal），而编辑器实例要到 `EditorPane` 的 onReady 才存在。
   */
  const doc = createDocumentModel({
    getText: () => editor?.doc ?? '',
    setText: (text) => editor?.setDoc(text),
    focus: () => editor?.focus(),
  })

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

  onMount(() => {
    applyFontSize()
    // 字体注入与编辑器挂载并行：编辑器不等字体，到达后浏览器自己用 font-display: swap 重排
    void switchFont(DEFAULT_VARIANT)
    void switchCodeFont(DEFAULT_CODE_FONT)
    disposeCommands = registerBuiltinCommands(registry, {
      newDocument: doc.newDocument,
      openFile: doc.openViaDialog,
      saveFile: doc.save,
      saveFileAs: doc.saveAs,
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
          <button onClick={() => void registry.execute('file.new')} disabled={doc.busy()} title="Mod+N">
            新建
          </button>
          <button
            class="primary"
            onClick={() => void registry.execute('file.open')}
            disabled={doc.busy()}
            title="Mod+O"
          >
            打开…
          </button>
          <button onClick={() => void registry.execute('file.save')} disabled={doc.busy()} title="Mod+S">
            保存
          </button>
          <button onClick={() => void registry.execute('file.saveAs')} disabled={doc.busy()} title="Mod+Shift+S">
            另存为…
          </button>
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
          <span class="badge" title={doc.path() ?? UNTITLED_LABEL}>
            {doc.busy() ? '读写中…' : `${doc.dirty() ? '● ' : ''}${doc.name()}`}
          </span>
          <span class="badge">
            {docLines().toLocaleString()} 行 · {docChars().toLocaleString()} 字符
          </span>
        </div>
      </div>

      {/* 常驻容器：.app 是 grid，行数必须固定。两条提示各自当 grid item 的话，
          出现 0/1/2 条时 1fr 会落到不同的行上，正文区被挤掉 */}
      <div class="notices">
        <Show when={doc.lossy()}>
          <div class="notice warning">
            这个文件没能完整解码，正文里的 U+FFFD 是替换字符。<strong>原样保存会永久损坏它</strong>——请另存为一份新文件。
          </div>
        </Show>
        <Show when={doc.notice()}>
          {(n) => (
            <div class={`notice ${n().level}`}>
              <span>{n().text}</span>
              <button class="notice-close" onClick={() => doc.dismissNotice()} title="关闭">
                ×
              </button>
            </div>
          )}
        </Show>
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
                // 脏标记只认正文变化：光标移动不该让文件变成「未保存」
                if (info.docChanged) doc.markChanged()
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
