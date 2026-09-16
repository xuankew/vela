import type { EditorState } from '@codemirror/state'
import { createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
import { registerBuiltinCommands } from './commands/builtins'
import { attachKeybindingDispatch } from './commands/dispatch'
import { detectPlatform } from './commands/keybinding'
import { createCommandRegistry, type AppContext } from './commands/registry'
import { DiscardDialog } from './doc/DiscardDialog'
import { createSessionSync, type SessionSync } from './doc/sessionSync'
import { StatusBar } from './doc/StatusBar'
import { TabStrip } from './doc/TabStrip'
import { createWorkspace, MAX_PANES, type DiscardDecision, type Pane } from './doc/workspace'
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
import { attachWindowCloseGuard } from './ipc/windowClose'

const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20]
const DEFAULT_FONT_SIZE = 14

export default function App() {
  let disposeCommands: (() => void) | undefined
  let detachKeys: (() => void) | undefined
  let detachCloseGuard: (() => void) | undefined
  /** 卸载比 `listen` 的 promise 先落地时，拿到的注销函数要立刻用掉，见 onMount */
  let tornDown = false
  let sync: SessionSync | undefined

  const [fontKey, setFontKey] = createSignal<FontVariantId>(DEFAULT_VARIANT)
  const [codeFontKey, setCodeFontKey] = createSignal<CodeFontId>(DEFAULT_CODE_FONT)
  const [fontSize, setFontSize] = createSignal(DEFAULT_FONT_SIZE)

  /**
   * 会话这一层的提示：存档读不回来、写不下去、草稿超预算被丢。
   *
   * 不塞进 `doc.notice()`：这些话说的都不是**某一个文档**，挂在活动文档上会在用户
   * 切标签时跟着消失，看起来像那条警告只关乎他刚切走的那个文件。
   */
  const [sessionWarning, setSessionWarning] = createSignal<string | null>(null)

  /**
   * 正在等用户裁决的关闭请求。`null` = 没有对话框。
   *
   * Promise 的 resolve 被存在 signal 里，是「把一次异步询问接到 UI 上」最直接的做法：
   * workspace 只知道自己问了个问题，谁来答、用什么 UI 答，全是 App 的事。
   */
  const [pendingClose, setPendingClose] = createSignal<{
    names: string[]
    resolve: (decision: DiscardDecision) => void
  } | null>(null)

  /**
   * 工作区：所有标签 + 所有分屏 + 「哪个分屏显示哪个标签」。
   *
   * M1-B 时这里是 `createDocumentModel`（单例），M1-D 把它变成「每标签一份」并统一收到
   * workspace 名下——工具栏、状态栏、命令中心要的都不是「某个文档」而是「聚焦分屏里那个文档」。
   */
  const ws = createWorkspace({
    promptDiscard: (names) => new Promise<DiscardDecision>((resolve) => setPendingClose({ names, resolve })),
  })
  const activeDoc = () => ws.activeTab().doc

  /** 先摘对话框再 resolve：裁决之后可能紧接着弹另存为，两个模态不该同时在屏幕上 */
  function decide(decision: DiscardDecision) {
    const pending = pendingClose()
    setPendingClose(null)
    pending?.resolve(decision)
  }

  /**
   * 一块分屏挂载时用的初始 state。
   *
   * `untrack` 是必要的：`<For>` 的回调跑在 owner 的 computation 里，直接读 `pane.tabId()`
   * 会把这段 JSX 订阅到它上面——而 `EditorPane` 的规矩是「props 只在 onMount 读一次」，
   * 两者一撞就会变成「换标签时重建整个编辑器」，正是 ⛔ 那条规则要防的事。
   *
   * 分屏新建时它的标签一定已经在 `tabs()` 里（见 workspace 的 `split`），所以 `!` 是安全的。
   */
  function paneState(pane: Pane): EditorState {
    return untrack(() => ws.tabs().find((t) => t.id === pane.tabId())!.snapshot.state)
  }

  const registry = createCommandRegistry({
    platform: detectPlatform(),
    // 命令永远作用于聚焦的那块分屏。`focusedEditor()` 是被调用时求值的，
    // 不是 signal：命令的 `when` 在 `execute` 的那一刻读一次就够。**命令面板落地时
    // 要改成订阅**，否则面板里 `editor.*` 的置灰状态不会跟着焦点走。
    getContext: (): AppContext => ({ editor: ws.focusedEditor() }),
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
      newDocument: () => {
        ws.newTab()
      },
      openFile: ws.openViaDialog,
      saveFile: ws.save,
      saveFileAs: ws.saveAs,
      applyLineWrap: (on) => ws.setLineWrap(on),
      adjustFontSize: stepFontSize,
      resetFontSize: () => {
        setFontSize(DEFAULT_FONT_SIZE)
        applyFontSize()
      },
      splitRight: () => ws.split('row'),
      splitDown: () => ws.split('column'),
      closePane: () => ws.closePane(ws.focusedPaneId()),
      focusNextPane: () => ws.cyclePane(1),
      focusPreviousPane: () => ws.cyclePane(-1),
    })
    detachKeys = attachKeybindingDispatch(registry)
    sync = createSessionSync({ workspace: ws, onWarn: setSessionWarning })
    // 不 await：读存档与重新读盘可能要几百毫秒，编辑器该先出来给用户看
    void sync.start()
    void attachWindowCloseGuard(async () => {
      const ok = await ws.requestWindowClose()
      // 放行之后必须立刻补一次：节流那一轮最长要等 5 秒，而 close_window 是
      // Window::destroy()，webview 当场就没了，最后 5 秒里敲的字会全丢
      if (ok) await sync?.saveNow()
      return ok
    }).then((unlisten) => {
      if (tornDown) unlisten()
      else detachCloseGuard = unlisten
    })
  })

  onCleanup(() => {
    tornDown = true
    sync?.stop()
    detachCloseGuard?.()
    detachKeys?.()
    disposeCommands?.()
    // 分屏的现场由各自的 EditorPane.onDestroy 存回标签，这里不 detach
  })

  return (
    <div class="app">
      <div class="toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">文档</span>
          <button onClick={() => void registry.execute('file.new')} disabled={activeDoc().busy()} title="Mod+N">
            新建
          </button>
          <button
            class="primary"
            onClick={() => void registry.execute('file.open')}
            disabled={activeDoc().busy()}
            title="Mod+O"
          >
            打开…
          </button>
          <button onClick={() => void registry.execute('file.save')} disabled={activeDoc().busy()} title="Mod+S">
            保存
          </button>
          <button onClick={() => void registry.execute('file.saveAs')} disabled={activeDoc().busy()} title="Mod+Shift+S">
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
            {ws.lineWrap() ? '开' : '关'}
          </button>
        </div>

        <div class="toolbar-group" style="border-right:none">
          <span class="toolbar-label">分屏</span>
          <button
            onClick={() => void registry.execute('editor.splitRight')}
            disabled={ws.panes().length >= MAX_PANES}
            title="Mod+\"
          >
            右分屏
          </button>
          <button
            onClick={() => void registry.execute('editor.splitDown')}
            disabled={ws.panes().length >= MAX_PANES}
            title="Mod+Shift+\"
          >
            下分屏
          </button>
          <button
            onClick={() => void registry.execute('editor.closePane')}
            disabled={ws.panes().length <= 1}
            title="合并到一块"
          >
            合并
          </button>
        </div>
      </div>

      <TabStrip workspace={ws} />

      {/* 常驻容器：.app 是 grid，行数必须固定。两条提示各自当 grid item 的话，
          出现 0/1/2 条时 1fr 会落到不同的行上，正文区被挤掉 */}
      <div class="notices">
        <Show when={sessionWarning()}>
          {(text) => (
            <div class="notice warning">
              <span>{text()}</span>
              <button class="notice-close" onClick={() => setSessionWarning(null)} title="关闭">
                ×
              </button>
            </div>
          )}
        </Show>
        <Show when={activeDoc().lossy()}>
          <div class="notice warning">
            这个文件没能完整解码，正文里的 U+FFFD 是替换字符。<strong>原样保存会永久损坏它</strong>
            ——可以在状态栏的编码菜单里选「以…重新打开」换个编码重读一次，或者另存为一份新文件。
          </div>
        </Show>
        <Show when={activeDoc().notice()}>
          {(n) => (
            <div class={`notice ${n().level}`}>
              <span>{n().text}</span>
              <button class="notice-close" onClick={() => activeDoc().dismissNotice()} title="关闭">
                ×
              </button>
            </div>
          )}
        </Show>
      </div>

      <div class="body" classList={{ column: ws.direction() === 'column' }}>
        <For each={ws.panes()}>
          {(pane) => (
            <div class="editor-host" classList={{ focused: ws.focusedPaneId() === pane.id }}>
              <EditorPane
                state={paneState(pane)}
                onReady={(c) => ws.attach(pane.id, c)}
                onDestroy={() => ws.detach(pane.id)}
                onFocus={() => ws.focusPane(pane.id)}
              />
            </div>
          )}
        </For>
      </div>

      <StatusBar workspace={ws} />

      {/* `.modal-backdrop` 是 position:fixed，脱离 grid 流，所以不会给行数固定的
          `.app` 多加出一行来（绝对定位的子元素不是 grid item） */}
      <Show when={pendingClose()}>
        {(pending) => <DiscardDialog names={pending().names} onDecide={decide} />}
      </Show>
    </div>
  )
}