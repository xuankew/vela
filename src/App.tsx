import { selectAll } from '@codemirror/commands'
import { language } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { save as pickToSave } from '@tauri-apps/plugin-dialog'
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  untrack,
} from 'solid-js'
import { registerBuiltinCommands } from './commands/builtins'
import { attachKeybindingDispatch } from './commands/dispatch'
import { detectPlatform } from './commands/keybinding'
import { createCommandPalette } from './commands/palette'
import { createCommandRegistry, type AppContext } from './commands/registry'
import { DiscardDialog } from './doc/DiscardDialog'
import { FileConflictDialog } from './doc/FileConflictDialog'
import { createFileWatch } from './doc/fileWatch'
import { createSessionSync, type SessionSync } from './doc/sessionSync'
import { ShardPane } from './doc/ShardPane'
import type { ShardView } from './doc/shardView'
import { describeStats, textStats } from './doc/stats'
import { StatusBar } from './doc/StatusBar'
import { TabStrip } from './doc/TabStrip'
import { createWorkspace, type DiscardDecision, type Pane } from './doc/workspace'
import { copySelection, cutSelection, pasteInto, writeClipboard } from './editor/clipboard'
import { EditorPane } from './editor/EditorPane'
import { languageFor } from './editor/language'
import { clickAction, definitionAt } from './goto/definition'
import { createQuickOpen, type Commit } from './goto/store'
import { symbolTable, wordUnderCaret } from './goto/syntax'
import { attachFileDrop, handleDroppedPaths } from './ipc/dragDrop'
import { describeFsError, saveFile } from './ipc/fs'
import { queryProject } from './ipc/project'
import { attachReplaceListeners } from './ipc/replace'
import { attachSearchListeners } from './ipc/search'
import { attachWindowCloseGuard } from './ipc/windowClose'
import { linkNeedle, linkTargets } from './md/linkPath'
import { acceptsPastedImage, landPastedImage } from './md/paste'
import { MarkdownToolbar } from './md/MarkdownToolbar'
import type { FollowedEditor } from './md/panel'
import { nextPreviewMode, type PreviewMode } from './md/previewMode'
import { alignTableAt } from './md/table'
import { createProjectTree } from './project/store'
import { Sidebar, type TreeNotice } from './project/Sidebar'
import { clampSidebarWidth, SidebarResize } from './project/SidebarResize'
import { TreeMenu, type ContextMenuItem } from './project/TreeMenu'
import { ReplaceConfirm } from './search/ReplaceConfirm'
import { revealTarget } from './search/reveal'
import type { HitRow } from './search/rows'
import { createSearchPanel } from './search/store'
// import { AppearancePopover } from './settings/AppearancePopover' // 工具栏隐藏后暂时不用，保留导入以备将来恢复
import { SettingsDialog } from './settings/SettingsDialog'
import { KeybindingsDialog } from './settings/KeybindingsDialog'
import { createKeybindingStore } from './settings/keybindings'
import { createSettingsStore } from './settings/store'
import { BUILTIN_TOOLS } from './tools/builtin'
import { createToolBox } from './tools/store'

/**
 * Markdown 预览那一栏改成**按需加载**（M3-C-1）。
 *
 * 🔴 这一条是 M3-C 里最值钱的一条，而值钱的不是 `MarkdownPreview.tsx` 自己（5.1KB 净代码），
 * 是它身后那条链：`MarkdownPreview` → `md/preview` → **`md/render`（18.1KB 净代码，
 * 全仓最大的一个前端模块）**。三者只要有一个还在首屏里静态引用，那个 41KB 的渲染器
 * 就一个字节都省不掉。
 *
 * ⚠️ 于是 `md/table.ts`（`alignTableAt`，`Mod+Shift+A`）与 `md/outline.ts` / `md/panel.ts`
 * 必须**留在首屏**——表格对齐是一条随时可能按的命令，而 M3-A-5 修正 3 已经把依赖方向
 * 钉成 `render` → `table`（不是反过来），正是为了让这一条成立。
 *
 * 🔴 代价是**第一次**打开预览要多一跳动态 import。在 Tauri 里那是读一个本地文件，
 * 量级是毫秒以下；⛔ 而它换来的是一整个渲染器不进首屏。这笔账划得来。
 *
 * ⚠️ Solid 的 `lazy` 要的是 `{ default: Component }`，而 `MarkdownPreview` 是具名导出，
 * 所以这里手动包一层。用 `<Suspense>` 兜住：Solid 的 `Suspense` **不产生 DOM 节点**，
 * 于是 `.body-row` 那个横向 flex 的子元素顺序与个数一个都没变
 */
const MarkdownPreview = lazy(() => import('./md/MarkdownPreview').then((m) => ({ default: m.MarkdownPreview })))

/**
 * JSON 预览面板也改成**按需加载**（M4-D）。与 MarkdownPreview 同一条理由：
 * 只有用户按了 `Mod+Shift+K` 才需要这份代码，启动时不该为它付下载费。
 */
const JsonPreview = lazy(() => import('./json/JsonPreview').then((m) => ({ default: m.JsonPreview })))

/**
 * 两块浮层的 UI 也改成**按需加载**（M3-C-2）：工具箱 12.3KB 净代码、命令面板 4.1KB。
 *
 * 🔴 挪走的只有**组件**，⛔ 不是它们身后那套状态：`createToolBox`（`tools/store.ts`）与
 * `createCommandPalette`（`commands/palette.ts`）都还在首屏里**同步**跑——前者把六个工具
 * 投影成命令塞进注册表，后者把命令清单读进一个 memo，而注册表在启动那一刻就要是全的
 * （`Mod+Shift+T` / `Mod+Shift+P` 本身是注册表里的命令，键绑定挂在 `window` 的捕获阶段，
 * 与浮层画没画出来无关）。同理 `tools/registry.ts` + `builtin.ts` + 六个工具实现
 * + `util/base64.ts` 那九个模块一个都不能挪：它们是「按 `Mod+Shift+T` 就有东西可跑」的内容。
 *
 * ⚠️ 于是这一条省下的是**画浮层的那份 JSX 与它自己的 CSS 类名**，而工具的纯活照旧常驻。
 * M3-C-4 报体积时这两个数要**分开**报，⛔ 不能笼统说「工具箱挪出了首屏」
 *
 * 🔴 与 `MarkdownPreview` 不同的地方：那一栏的可见性归 App 管，而这两个组件**内部**各自
 * 已经包了 `<Show when={…visible()}>`。要懒加载就得在**外面**再套一层同条件的 `Show`——
 * 否则组件在启动时就挂载了（只是渲染成空），`lazy` 那一次 import 也就跟着提前到了首屏。
 * ⚠️ 里面那一层因此看着冗余，但**不删**：chunk 什么时候回来是不受控的，
 * 「按下 `Mod+Shift+T` 又立刻 Esc」那一下会让组件在 `visible()` 已经是 false 之后才挂载，
 * 那时兜住它的正是里面那一层
 */
const CommandPalette = lazy(() => import('./commands/CommandPalette').then((m) => ({ default: m.CommandPalette })))
const ToolBox = lazy(() => import('./tools/ToolBox').then((m) => ({ default: m.ToolBox })))

/**
 * 三块**面板/浮层**的 UI 也改成按需加载（M4-I 首屏瘦身）。与上面两块同一条理由、同一套切法：
 * 组件只有在用户打开它时才需要，而启动那一刻需要的是它们的 **store**（命令注册表与 Rust 事件
 * 都要在 boot 时接上，见 M3-C-2 那条注释里「⛔ 不是它们身后那套状态」），于是这一刀只切组件。
 *
 * 🔴 三个渲染点**本来就已经**包在同条件的 `<Show>` 里（大纲那一栏、搜索面板、跳转浮层），
 * 所以不必像 ToolBox / CommandPalette 那样再补一层外框——那两位是因为组件**内部**自带 `Show`
 * 才需要外面再套一个。
 *
 * ⚠️ `<Suspense>` **不产生 DOM 节点**，于是大纲那一栏在 `.body-row` 这个横向 flex 里的
 * **顺序**（大纲 → 正文 → 预览）与个数一个都没变；跳转浮层那条「DOM 顺序即层叠顺序」
 * 的直觉同样照旧成立（`z-index` 相同时后出现的在上面）。
 */
const OutlinePanel = lazy(() => import('./md/OutlinePanel').then((m) => ({ default: m.OutlinePanel })))
const FindInFiles = lazy(() => import('./search/FindInFiles').then((m) => ({ default: m.FindInFiles })))
const QuickOpen = lazy(() => import('./goto/QuickOpen').then((m) => ({ default: m.QuickOpen })))

/**
 * 编辑器那一层要说的话（见下面 `editorNotice` 那条注释）。
 *
 * 与 `project/Sidebar.tsx` 的 `TreeNotice` 形状一致，只多一档 `plain`——
 * 树那一边说的每一句都是「做成了」或「没做成」，而这一边多出来的是「没什么可做，
 * 但你该知道为什么」，那一档**不该有颜色**
 */
interface EditorNotice {
  level: 'plain' | 'ok' | 'error'
  text: string
}

/**
 * 编辑器正文那份右键菜单里的动作（落点见下面的 `onEditorMenuPick`）。
 *
 * 🔴 剪切／复制／粘贴／全选**刻意不注册成命令**：浏览器早就把 `Mod+C/X/V/A` 这四个键
 * 接在 contenteditable 上了，注册一遍只是往命令面板里塞四个谁都知道的条目，
 * 而「注册表里有、行为却是浏览器给的那一份」以后还得防两边漂开。
 * 折叠那两项相反——它们本来就已经是命令（`commands/builtins.ts` 的 `editor.foldAll` /
 * `editor.unfoldAll`），菜单这一条是**调用**它们，不是第二份实现
 */
type EditorMenuAction = 'cut' | 'copy' | 'paste' | 'selectAll' | 'foldAll' | 'unfoldAll'

/**
 * 菜单事件路由：把 Rust 侧转发的菜单 ID 映射到前端的命令执行。
 *
 * 所有菜单项的快捷键已经在 builtins.ts 里注册过了，这里只是把菜单点击
 * 翻译成对应的命令调用，保持单一入口。
 */
function routeMenuEvent(
  id: string,
  actions: {
    newTab: () => void
    openViaDialog: () => void
    openFolder: () => void
    openRecentProject: () => void
    closeFolder: () => void
    save: (ctx: { editor: any }) => void
    saveAs: (ctx: { editor: any }) => void
    findInFiles: () => void
    replaceInFiles: () => void
    formatJson: (ctx: { editor: any }) => void
    minifyJson: (ctx: { editor: any }) => void
    alignTable: () => void
    wordCount: () => void
    toggleSidebar: () => void
    togglePreview: () => void
    toggleOutline: () => void
    toggleJsonPreview: () => void
    zoomIn: () => void
    zoomOut: () => void
    resetZoom: () => void
    toggleLineWrap: () => void
    toggleMinimap: () => void
    openCommandPalette: () => void
    showSettings: () => void
    toggleMdToolbar: () => void
    splitRight: () => void
    splitDown: () => void
    mergePanes: () => void
    focusNextPane: () => void
    focusPrevPane: () => void
    closePane: () => void
  },
  ctx: { editor: any },
): void {
  // File
  if (id === 'file.new') actions.newTab()
  else if (id === 'file.open') actions.openViaDialog()
  else if (id === 'file.open_folder') actions.openFolder()
  else if (id === 'file.recent') actions.openRecentProject()
  else if (id === 'file.save') actions.save(ctx)
  else if (id === 'file.save_as') actions.saveAs(ctx)
  else if (id === 'file.close_folder') actions.closeFolder()
  // Edit
  else if (id === 'edit.find_in_files') actions.findInFiles()
  else if (id === 'edit.replace_in_files') actions.replaceInFiles()
  else if (id === 'edit.format_json') actions.formatJson(ctx)
  else if (id === 'edit.minify_json') actions.minifyJson(ctx)
  else if (id === 'edit.align_table') actions.alignTable()
  else if (id === 'edit.word_count') actions.wordCount()
  // View
  else if (id === 'view.toggle_sidebar') actions.toggleSidebar()
  else if (id === 'view.toggle_preview') actions.togglePreview()
  else if (id === 'view.toggle_outline') actions.toggleOutline()
  else if (id === 'view.toggle_json_preview') actions.toggleJsonPreview()
  else if (id === 'view.zoom_in') actions.zoomIn()
  else if (id === 'view.zoom_out') actions.zoomOut()
  else if (id === 'view.reset_zoom') actions.resetZoom()
  else if (id === 'view.toggle_line_wrap') actions.toggleLineWrap()
  else if (id === 'view.toggle_minimap') actions.toggleMinimap()
  else if (id === 'view.command_palette') actions.openCommandPalette()
  else if (id === 'view.toggle_md_toolbar') actions.toggleMdToolbar()
  else if (id === 'view.settings') actions.showSettings()
  // Window
  else if (id === 'window.split_right') actions.splitRight()
  else if (id === 'window.split_down') actions.splitDown()
  else if (id === 'window.merge_panes') actions.mergePanes()
  else if (id === 'window.focus_next') actions.focusNextPane()
  else if (id === 'window.focus_prev') actions.focusPrevPane()
  else if (id === 'window.close_pane') actions.closePane()
  // Help
  else if (id === 'help.about') {
    // TODO: 打开关于对话框
    console.log('About Vela')
  }
}

export default function App() {
  let disposeCommands: (() => void) | undefined
  let detachKeys: (() => void) | undefined
  let detachCloseGuard: (() => void) | undefined
  let detachSearch: (() => void) | undefined
  let detachReplace: (() => void) | undefined
  let detachFileWatch: (() => void) | undefined
  let detachDrop: (() => void) | undefined
  let detachMenu: (() => void) | undefined
  /** 卸载比 `listen` 的 promise 先落地时，拿到的注销函数要立刻用掉，见 onMount */
  let tornDown = false
  let sync: SessionSync | undefined

  /**
   * 配置这一层的提示（M4-A）：配置读不回来、写不下去。
   *
   * 与 `sessionWarning` 同一类——说的不是**某一个文档**，所以不塞进 `doc.notice()`。
   * 它是 `createSettingsStore` 的 `onWarn` 落点：配置是偏好，读不回来最坏是「用默认字号」，
   * 不该拦启动，但「我设的没记住」这件事得让用户看见一句，而不是静默回退。
   */
  const [settingsNotice, setSettingsNotice] = createSignal<string | null>(null)

  /**
   * 字体 / 字号 / 行高 / 字间距 / 主题的持久化状态（M4-A 起，M4-C 加进主题）。六个值都跟着
   * **人**走（用户全局层 `~/.vela/settings.json`），换项目也在。sanitize（档外字号、不认识的
   * 字体/主题 ID）与写穿都在这一层里，理由见 `src/settings/store.ts` 的模块文档。
   *
   * 🔴 `applyDark` 把「当前该是亮还是暗」接到 workspace 的 `setDarkTheme`（CM6 的 `darkSlot`）。
   * store 自己只写 `<html data-theme>`（管 `--vela-*` 颜色），CM6 base theme 的 `&dark` facet
   * 归 workspace——两件事必须一起做，少一件就会「颜色换了但光标/弹层底色还是旧的」。
   * 闭包引用 `ws`（声明在后面）是安全的：它只在 `load`/`applyNow`/`setTheme` 时被调，
   * 那都在组件体跑完之后，`ws` 早已初始化。
   */
  const settings = createSettingsStore({
    onWarn: setSettingsNotice,
    applyDark: (dark) => ws.setDarkTheme(dark),
    onFontSizeChange: () => ws.notifyFontSizeChanged(),
  })

  /**
   * 会话这一层的提示：存档读不回来、写不下去、草稿超预算被丢。
   *
   * 不塞进 `doc.notice()`：这些话说的都不是**某一个文档**，挂在活动文档上会在用户
   * 切标签时跟着消失，看起来像那条警告只关乎他刚切走的那个文件。
   */
  const [sessionWarning, setSessionWarning] = createSignal<string | null>(null)

  /**
   * 文件树要说的一句话（M2-B-5）：右键菜单的结果。
   *
   * 与 `sessionWarning` 同一类东西——说的都不是**某一个文档**，所以不塞进 `doc.notice()`。
   * 也不塞进侧边栏自己：那一条只有 220px 宽，一句带完整路径的错误在里面会折成窄窄的
   * 四五行的竖条，把树挤下去。
   */
  const [treeNotice, setTreeNotice] = createSignal<TreeNotice | null>(null)

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
    pasteImage: pasteImageInto,
    clickDefinition: definitionFromClick,
    onFontSizeZoom: settings.stepZoomedFontSize,
    linkFiles: linkFilesFor,
  })
  const activeDoc = () => ws.activeTab().doc

  /**
   * 项目树（M2-B）。与 `ws` 是两套完全独立的状态：树管「磁盘上有什么」，
   * workspace 管「打开了哪些标签」。两者只在 `openFile` 这一个点上相接——
   * 点树里的文件就走 `ws.openAt`，与普通「打开文件」共用同一套脏检查、编码探测与标签复用。
   *
   * 注入而不是让 store 直接 import `createWorkspace`：那会造成循环依赖，
   * 也和 workspace 的 `promptDiscard` 同一条道理——store 不该知道宿主长什么样。
   */
  const tree = createProjectTree({ openFile: (path) => ws.openAt(path) })

  /**
   * 工作区的根一变就重读分层配置（M4-A）。
   *
   * 多根只认**第一个**（Rust 侧取 `roots[0]` 推项目层路径，裁定见 PLAN §3.6「M4-A 实施修正」）。
   * 🔴 v1 里三个键全是个人偏好、项目层不生效，所以重读**不会改变**合并出的配置——
   * 重跑的唯一理由是刷新那份账单（`settings.report()` 里的 `ignoredProjectKeys`），
   * 以及为「第一个 project-safe 键」（M3-A-7 推来的 asset 落地目录）提前把线接好。
   *
   * 建在组件体内而不是 `onMount` 里：`createEffect` 要跟着组件的 owner 一起 dispose，
   * 理由与下面 `fileWatch` 那条逐字相同。第一次跑时 roots 还是空的（会话尚未恢复），
   * 于是先按「没有项目层」读一遍用户全局；恢复出根之后这个 effect 自己会再跑一次。
   */
  createEffect(() => {
    void settings.load(tree.roots())
  })

  /**
   * 外部改动监听（M2-G）。盯的是**打开着的文件**，与上面两套状态都不重叠：
   * 树管「目录里有什么」（所以它不跟着刷新，见 `doc/fileWatch.ts` 文件头），
   * workspace 管「打开了哪些标签」，这一层管「那些标签对应的磁盘文件有没有被人动过」。
   *
   * 建在组件体内而不是 `onMount` 里：它内部有 memo 与 effect，而 Solid 的 owner
   * 按创建时的同步栈算——在体内建才会跟着组件一起 dispose。
   * 真正挂监听与送第一份清单是 `onMount` 里的 `start()`，见那里那段注释。
   *
   * `onWarn` 与 `sessionSync` 共用窗口顶上那一条：监听不完整（有目录订不上、撞了上限）
   * 说的不是某一个文档，塞进 `doc.notice()` 会在用户切标签时跟着消失。
   */
  const fileWatch = createFileWatch({ workspace: ws, onWarn: setSessionWarning })

  /**
   * 侧边栏可见性。默认关：空窗口里多一条 220px 的竖栏只会把正文区挤窄，
   * 而「还没有项目」时它里面什么也没有。
   *
   * 刻意不与 `tree.roots()` 合并成一个状态：关闭文件夹之后侧边栏应该**留着**，
   * 显示那个「打开文件夹…」的空状态——那正是用户下一步要点的东西，
   * 顺手把栏收掉等于把他刚用的入口藏起来。
   */
  const [sidebarVisible, setSidebarVisible] = createSignal(false)

  /**
   * 侧边栏宽（px）。与 `sidebarVisible` 同一条理由放在这里：收起再展开、窗口 resize 时
   * 重新夹取，都要它活着——放进 `Sidebar` 里的话收起一次就回到默认值，用户调过的现场没了
   */
  const [sidebarWidth, setSidebarWidth] = createSignal(220)
  onMount(() => {
    // 上限是「窗口的一半」，跟着窗口走：窗口缩过之后存着的宽度可能越界，不重新夹一次的话
    // 正文区会被挤到比侧边栏还窄，而用户这一次什么都没拖
    const onResize = () => setSidebarWidth((w) => clampSidebarWidth(w))
    window.addEventListener('resize', onResize)
    onCleanup(() => window.removeEventListener('resize', onResize))
  })

  /** 对话框取消时不显示侧边栏：用户什么都没选，弹出一条空栏是净损失 */
  async function openFolder() {
    await tree.openViaDialog()
    if (tree.roots().length > 0) setSidebarVisible(true)
  }

  /**
   * 追加一个（或几个）文件夹到工作区（M2-F）。
   *
   * 判据是「比刚才多了」而不是「现在不是空的」：这一条从命令面板也能调，
   * 而那时侧边栏可能正被用户刻意收着。他取消了对话框，工作区里那两个根还在，
   * 用「不是空的」当判据就会把他刚收起来的那一栏又弹出来
   */
  async function addFolder() {
    const before = tree.roots().length
    await tree.addViaDialog()
    if (tree.roots().length > before) setSidebarVisible(true)
  }

  /**
   * Markdown 预览那一栏的形态（M3-A-3，`only` 一档是后来加的）。默认关，与侧边栏同一条理由：
   * 空窗口里多一栏只会把正文区挤窄，而「还没有文档」时它里面什么也没有。
   *
   * ⚠️ 刻意不进会话存档：存了的话每次启动都得先渲染一份预览，而「上次开着」
   * 与「这次要看」是两件事——他可能只是想接着改一段代码。这一条对 `only` 更要紧：
   * 存档里带回来一个「编辑区是藏着的」现场，用户启动看到的第一眼就是找不到自己在哪儿。
   *
   * 侧边栏那一栏在存档里也没有自己的字段，但它是**搭 `project.roots` 的便车回来的**
   * （见下面 `sync.start().then(...)` 里那句 `if (tree.roots().length > 0)`）：
   * 「这个项目长什么样」每次启动都成立，所以有根就该看得见根。预览没有这么一件能搭车的事实——
   * 它答的是「这份文档长什么样」，而那份文档下次可能压根没打开
   */
  const [previewMode, setPreviewMode] = createSignal<PreviewMode>('off')

  /**
   * JSON 预览那一栏的可见性（M4-D）。默认关，与 Markdown 预览同一条理由：
   * 一份不是 JSON 的文档，旁边挂一条报错的面板只是把正文区挤窄。
   *
   * ️ 与 Markdown 预览**互相独立**：两个都开、只开一个、都不关，四种组合都成立。
   * Markdown 预览答「这份文档渲染出来什么样」，JSON 预览答「这段文本解析成 JSON 后的树形结构」。
   *
   * 同样刻意不进会话存档，理由写在上面 `previewMode` 那条注释里
   */
  const [jsonPreviewVisible, setJsonPreviewVisible] = createSignal(false)

  /**
   * Markdown 工具栏的可见性（M4-F）。默认关，用户可通过 View 菜单或编辑器上方的按钮切换。
   *
   * 与预览面板独立：工具栏答「编辑时有没有快捷按钮」，预览答「渲染出来是什么样」。
   */
  const [mdToolbarVisible, setMdToolbarVisible] = createSignal(false)

  /**
   * 设置对话框的可见性（菜单触发，见 `view.settings`）。
   *
   * 与 AppearancePopover 不同：那个是锚定在工具栏按钮下的下拉，而这个是居中模态对话框。
   * 两者共用同一套配置状态（`settings`），只是呈现方式不同——工具栏隐藏后需要这个入口
   */
  const [settingsDialogVisible, setSettingsDialogVisible] = createSignal(false)

  /**
   * 快捷键配置对话框的可见性（M4-E）。
   *
   * 从设置对话框中的"快捷键配置"按钮打开，独立于设置对话框。
   */
  const [keybindingsDialogVisible, setKeybindingsDialogVisible] = createSignal(false)

  /**
   * 大纲那一栏的可见性（M3-A-4）。默认关，与预览同一条理由：
   * 一份没有标题的文档，旁边挂一条空栏只是把正文区挤窄。
   *
   * ⚠️ 与预览**互相独立**：两个都开、只开一个、都不关，四种组合都成立。
   * 大纲答「这份文档的结构」，预览答「它渲染出来什么样」，关掉一个不该顺手关掉另一个。
   *
   * 同样刻意不进会话存档，理由写在上面 `previewMode` 那条注释里
   */
  const [outlineVisible, setOutlineVisible] = createSignal(false)

  /**
   * 两个 Markdown 面板（预览、大纲）**此刻跟着走的那一块编辑器**。
   *
   * 一个访问器喂两个面板，而不是各写一份：两者的「跟着谁走」必须是同一个答案，
   * 否则并排开着的时候预览显示 A 文档、大纲显示 B 文档的标题，而用户看不出这是怎么发生的。
   *
   * 🔴 读的是 `ws.focusedView()`（响应式那个）而不是 `ws.focusedEditor()`：后者每次调用
   * 返回的值都对，但在 `createEffect` 里读它什么都等不到——`attach` 把实例写进的是
   * `PaneRecord` 的一个普通可变字段，那一下不触发任何信号。少这一层的症状很具体：
   * 开着面板去分屏，新分屏的 controller 还不存在，面板说「没有可列的标题」，
   * 然后**一直停在那儿**，直到用户在编辑器里敲一个字
   *
   * 只读分片（>4 MiB 的只读大文件）没有 CM6 实例，所以这里也是 null——两个面板
   * 都会如实说一句话。要在那种文件上看结构得先把分片模型接进来，那是另一件事
   */
  const followedEditor = (): FollowedEditor | null => {
    const controller = ws.focusedView()
    if (controller === null) return null
    return { view: controller.view, path: ws.activeTab().doc.path() }
  }

  /**
   * 阅读模式（`previewMode` 的 `only` 档）**此刻真的把编辑区藏起来了吗**。
   *
   * 🔴 三个条件缺一不可，后两个是「不许出现死胡同」：`.ts` 文件与只读大文件分片都没有预览
   * 可看，那种时候藏掉编辑器，等于把整块屏幕让给一句「TypeScript 还没有预览」——
   * 用户既看不到正文也看不到编辑区，而他想不明白是怎么走到这一步的。所以 `only` 档在这两种
   * 文档上**降级成并排**：那一档说的其实是「让预览独占」，而没有预览可独占时这句话不成立。
   *
   * ⚠️ 判据是 `followedEditor() !== null` 而不是「路径以 .md 结尾」：前者正是预览自己
   * 决定「有没有正文可渲染」用的那一个（`MarkdownPreview` 的 `src === null` 那一支），
   * 两边同源才不会说出两种答案。语言那一半同样取自 `languageFor`，与 `md/preview.ts`
   * 判 `unsupported` 用的是同一个函数
   */
  const editorHidden = () =>
    previewMode() === 'only' && followedEditor() !== null && languageFor(ws.activeTab().doc.path()).kind === 'markdown'

  /**
   * 全局替换落盘之后的一句回话（M2-D）：几个开着的标签被从磁盘重读了一遍。
   *
   * 不并进面板底部那行总账：那一行说的是**磁盘上**发生了什么，这一句说的是**编辑器里**
   * 跟着发生了什么——正文换了，撤销栈也重建了。不说一句的话用户看到的是
   * 「我刚在改的文件自己动了」，而那正是他最不知道该往哪儿想的一种变化
   */
  const [reloadedNotice, setReloadedNotice] = createSignal<string | null>(null)

  /**
   * 编辑器这一层的**回话**（M3-A-5，M3-A-6 起也管导出）：一次按键下去没什么可做的，
   * 但要说一句为什么；或者做成了／没做成，也得说一句。
   *
   * 与上面三条同一类东西——说的都不是**某一个文档**：「光标不在表格里」讲的是光标此刻
   * 在哪儿，切个标签这句话就该消失，挂在 `doc.notice()` 上反而会跟着文档跑。
   *
   * 🔴 `level` 有三档，而 M3-A-5 那三条一律是 `plain`（**无色**的 `.notice`）：
   * 那几句里没有一件事出错，也没有一件事做成。染成警告色会让「按错了键」看起来像故障，
   * 染成 `ok` 会让「这张表已经对齐了」看起来像刚改了什么——而它一个字节都没改。
   * M3-A-6 加进来的两句不一样：「已导出到 …」确实做成了（`ok`），
   * 「导出失败：…」确实出错了（`error`），一次写盘不给颜色的话，用户看不出它成没成
   */
  const [editorNotice, setEditorNotice] = createSignal<EditorNotice | null>(null)

  /**
   * 换标签／换分屏就把上一句回话抹掉。
   *
   * 这不是收尾式的清理：`editorNotice` 里说的**全是此刻这一块**的事——「光标不在表格里」
   * 讲的是光标在哪儿，「1234 字 · 约 5 分钟读完」讲的是那份文档有多少字。跟着标签跑的话，
   * 切走之后屏幕上留着的是**另一份**文档的字数，而那是一个错数——比留白糟得多，
   * 因为留白什么也没说，错数说得理直气壮。
   *
   * ⚠️ `defer: true`：挂载时它本来就是 null，白跑一次没有意义，而这一条要表达的是「**变化**时清掉」
   */
  createEffect(
    on(
      () => ws.activeTab().id,
      () => setEditorNotice(null),
      { defer: true },
    ),
  )

  /**
   * 全局搜索面板的状态（M2-C，M2-D 之后也管替换）。
   *
   * 四个注入点都是同一个道理：store 不该知道宿主长什么样，而直接 import
   * `createWorkspace` / `createProjectTree` 会让两层互相引用成环。
   * 函数声明会提升，所以 `jumpToHit` 写在下面也接得上。
   */
  const search = createSearchPanel({
    roots: () => tree.roots(),
    openHit: jumpToHit,
    // 正开着且有未保存改动的那些绝对路径：落盘时递进 `skip` 让 Rust 别碰它们，
    // 预览时也据此标出「这个文件会被跳过」。原样递，不 normalize——后端逐组件比 Path 相等
    skipPaths: () => ws.dirtyPaths(),
    // ⚠️ 不接 summary 这个参数：接了又不用，`noUnusedParameters` 当场报错，
    // 而这一句要说的是「重读了几个标签」，那个数只有 `reloadUnder` 知道
    onApplied: async () => {
      // 理论上工作区可以在写盘途中被换掉（`closeFolder` 是命令）。那时重读的是新根
      // 底下的标签——白跑几趟 IPC，正文一样时 `reload` 什么都不做，不会改坏任何东西。
      // ⚠️ 多根之下**每个根都要问一遍**：`start_replace` 是跨所有根落盘的，
      // 只重读第 0 个根的话另一个根里那些被改过的标签会留在旧正文上，
      // 而用户下一次 ⌘S 就把刚落盘的结果盖回去了
      const roots = tree.roots()
      if (roots.length === 0) return
      let reloaded = 0
      for (const at of roots) reloaded += await ws.reloadUnder(at)
      setReloadedNotice(reloaded > 0 ? `已把 ${reloaded} 个开着的标签从磁盘重读了一遍（它们的撤销历史到此为止）` : null)
    },
  })

  /** 点一条搜索结果：打开那个文件、跳到那一行、选中那一段 */
  async function jumpToHit(hit: HitRow) {
    await ws.openAt(hit.path)
    // ⚠️ 打开可能没成：文件在搜完之后被删了、外接盘掉了、权限变了。那种情况下聚焦的
    // 编辑器里是**别的**文档，照着搜索结果里的行号跳过去就是在改一个无关文件的光标位置。
    // 失败本身文档已经说在提示条上了，这里只需要不动
    if (ws.activeTab().doc.path() !== hit.path) return
    // 🔴 分片标签没有编辑器实例，`focusedEditor()` 是 null。这一支**必须排在它前面**：
    // 搜索收文件的上限（64 MiB）比整份进内存的上限（4 MiB）宽，所以 4–64 MiB 这一段
    // 里的文件**搜得到、却是以分片方式打开的**。漏掉它的症状是「点了搜索结果，
    // 安静地停在第 1 行」——用户会以为这个文件里没有他搜的那句话
    const shard = ws.activeTab().doc.shard()
    if (shard !== null) {
      shard.gotoLine(hit.line)
      return
    }
    const controller = ws.focusedEditor()
    if (controller === null) return
    // `openAt` 之后 `focusedEditor()` 拿着的就是新文档：activateTab → showIn →
    // `controller.restore()` 全是同步的，所以这里可以直接算位置，不需要再等一拍
    const target = revealTarget(controller.view.state.doc, hit.line, hit.ranges)
    controller.reveal(target.anchor, target.head)
  }

  /**
   * `Cmd+P` / `Cmd+R` 浮层的状态（M2-E）。
   *
   * 四个注入点与 `search` 那四个是同一条道理。`symbols` 那一个是**现读**的：
   * 它要的是「按 `@` 那一刻聚焦的那块分屏里那份文档」的语法树，而语法树不是信号，
   * 所以这里既不订阅也订阅不到——浮层每次展开算一遍就够（见 `goto/store.ts` 的 `untrack`）。
   */
  const goto = createQuickOpen({
    roots: () => tree.roots(),
    recent: () => ws.recent(),
    recentProjects: () => tree.recentProjects(),
    symbols: () => {
      const controller = ws.focusedEditor()
      if (controller === null) return null
      return symbolTable(controller.view.state, ws.activeTab().doc.path())
    },
    commit: gotoCommit,
  })

  /**
   * 落地浮层里选中的一行。
   *
   * `openFile` 与 `jumpToHit` 走的是同一套「先打开、再核对、再跳」，只差最后一步：
   * 搜索结果的落点是**一段**（`hit.ranges`），这里的落点是**一个位置**
   * （`:42` 只要光标在那一行开头，标题只要光标在标题起点）。
   * 空 ranges 交给 `revealTarget` 正是这个意思——它回 `{anchor: line.from, head: line.from}`。
   */
  async function gotoCommit(action: Commit) {
    if (action.kind === 'openWorkspace') {
      // 换工作区不动任何标签：树管「磁盘上有什么」，标签管「打开了哪些文档」，
      // 两层是独立状态（见 `src/project/store.ts` 文件头）。刚才那个项目里开着的文件
      // 照样开着，⌘S 照样存得回去
      await tree.openMany(action.roots)
      // 与 `openFolder` 同一条判断：切成功了才把侧边栏推出来。
      // 判据是「真的有根」而不是「比刚才多」——这一条永远是**替换**，
      // 而切过去之后树里什么都没有的话，用户需要一个能看见的出口去打开文件夹
      if (tree.roots().length > 0) setSidebarVisible(true)
      return
    }
    if (action.kind === 'openFile') {
      await ws.openAt(action.path)
      // 与 `jumpToHit` 同一条核对：打开失败时聚焦的是别的文档，不该动它的光标
      if (ws.activeTab().doc.path() !== action.path) return
      // 分片标签先接一手（理由与 `jumpToHit` 里那一段逐字相同）。
      // ⚠️ 没有行号时这里**什么都不做**：分片面板没有可聚焦的编辑器，
      // 而一份只读文本也没什么可打的——要键盘滚动的话在面板里点一下就有了
      // （`tabIndex={0}`，见 `ShardPane.tsx`）
      const shard = ws.activeTab().doc.shard()
      if (shard !== null) {
        if (action.line !== null) shard.gotoLine(action.line)
        return
      }
      const controller = ws.focusedEditor()
      if (controller === null) return
      // 没有行号就只是「打开这个文件」：浮层收起后焦点会掉到 body 上，
      // 用户接着打字打进了空气里。补一次 focus，但**不** reveal——
      // 那会把视口重新居中，而 `openAt` 刚刚复原的是他上次读到哪儿
      if (action.line === null) {
        controller.focus()
        return
      }
      const target = revealTarget(controller.view.state.doc, action.line, [])
      controller.reveal(target.anchor, target.head)
      return
    }
    // 剩下两种都作用于**当前**文档：`:42` 与 `@标题`。浮层盖着的时候换不了标签，
    // 所以「当前」在这一次按键里是确定的
    const shard = ws.activeTab().doc.shard()
    if (shard !== null) {
      // `:42` 在一个几百万行的日志上恰恰是最常用的那一下，所以它必须能用。
      // `gotoPos` 只可能来自 `@标题`，而标题清单要有语法树；分片标签没有 CM6 state，
      // `symbols()` 上面早就返回 null 了，浮层里压根不会出现这一项
      if (action.kind === 'gotoLine') shard.gotoLine(action.line)
      return
    }
    const controller = ws.focusedEditor()
    if (controller === null) return
    if (action.kind === 'gotoLine') {
      const target = revealTarget(controller.view.state.doc, action.line, [])
      controller.reveal(target.anchor, target.head)
      return
    }
    // `gotoPos` 的 pos 来自语法树的节点起点，本来就在这个文档的范围内，不需要夹
    controller.reveal(action.pos, action.pos)
  }

  /**
   * 大纲里点一行标题（M3-A-4）。
   *
   * 复用 `gotoCommit` 的 `gotoPos` 那一条，而不是另写一个「跳到 pos」：与 `Cmd+R` 浮层里
   * 选一个标题**走的是同一段代码**，于是「浮层里跳得对、大纲里跳得不对」在结构上不可能发生
   * ——与 `outline.ts` 文件头那条「标题提取必须同源」是同一个道理，只是换到了跳转这一半。
   *
   * `reveal` 自己会 `view.focus()`（`editor/controller.ts:109`），所以点完之后焦点回到编辑器，
   * 用户接着打字不会打进空气里
   */
  function outlineJump(pos: number) {
    void gotoCommit({ kind: 'gotoPos', pos })
  }

  /**
   * 对齐光标所在的那张 Markdown 表格（M3-A-5，`Mod+Shift+A`）。
   *
   * 🔴 一次 `dispatch` 带上所有改动，⛔ 不是一行一个事务：一来「对齐一张表」在用户眼里
   * 是**一件事**，撤销要一下退回去；二来 `TableChange` 的偏移是**原文**里的，
   * 分成 N 个事务的话第一条改完后面几条就全错位了（同一个事务里 CM6 自己做这个映射）。
   *
   * ⚠️ 走普通编辑事务，所以它进撤销栈、会把文档标脏。这是对的：对齐**改了正文**
   * （补了几十个空格），而这些空格必须跟着 ⌘S 落盘——否则用户看到的与他存下来的不是一份东西
   */
  function alignTable() {
    const controller = ws.focusedEditor()
    if (controller === null) {
      // 只读分片没有 CM6 实例（理由见 `followedEditor` 那段），空窗口也没有。
      // 那种文件是几百万行的日志，里面不会有 Markdown 表格，但按下去总得回一句话
      setEditorNotice({ level: 'plain', text: '这块分屏里没有可对齐的表格' })
      return
    }
    const view = controller.view
    const result = alignTableAt(view.state, view.state.selection.main.head)
    if (result.kind === 'noTable') {
      setEditorNotice({ level: 'plain', text: '光标不在表格里' })
      return
    }
    if (result.kind === 'aligned') {
      setEditorNotice({ level: 'plain', text: '这张表已经对齐了' })
      return
    }
    // 🔴 `batch`：一次裸的信号写在事件处理器里会**同步**冲掉所有 user effect，
    // 而下一行就要拿 `view.dispatch` 改文档（`doc/workspace.ts` 文件头那条规矩）
    batch(() => {
      setEditorNotice(null)
      view.dispatch({ changes: result.changes })
    })
  }

  /**
   * 数一遍聚焦那块分屏里的字数与阅读时长（M3-A-6，`Mod+Shift+C`）。
   *
   * ⚠️ `doc.toString()` 是一次全文拷贝，加上 `textStats` 那两趟扫描，这一条是 O(n) 的。
   * 而它**只在这里**跑——⛔ 不要搬进 `syncMetrics`，那个函数在每一个事务上跑
   * （包括只动了光标的），完整论证在 `src/doc/stats.ts` 的文件头
   */
  function wordCount() {
    const controller = ws.focusedEditor()
    if (controller === null) {
      // 走到这一支的通常是只读大文件分片。那种文件是几百万行的日志，
      // 数一遍要几秒而且那个数没有意义，所以这里如实拒绝而不是硬数
      setEditorNotice({ level: 'plain', text: '这块分屏里没有可统计的正文' })
      return
    }
    // ⚠️ `plain` 而不是 `ok`：数一遍没有改任何东西，绿色会让人以为刚才那一下写了什么
    setEditorNotice({
      level: 'plain',
      text: describeStats(textStats(controller.view.state.doc.toString())),
    })
  }

  /**
   * 跳到这份文件里那个符号的声明（M5-1，`Mod+Alt+D`）。
   *
   * 🔴 查的是 `symbolTable`，也就是 `Cmd+R` 那份清单**本身**，⛔ 不是另算一遍：
   * 两边同源之后，「浮层里列着却跳不过去」在结构上不可能发生——与 `outlineJump`
   * 复用 `gotoCommit` 的 `gotoPos` 是同一条道理，只是这一次是查的那一半共用。
   *
   * 落点也复用同一段代码（`gotoCommit`），于是分片标签、`reveal` 顺带 `focus`、
   * 「打开失败就别动光标」那几条判断一处都不必重写。
   *
   * ⚠️ 四种拒绝一种都不沉默，理由与 `alignTable` / `wordCount` 逐字相同。
   * 「这份文件里没有」那一句额外指了一条出路（`Mod+Alt+F`），因为那恰恰是用户
   * 按下一个「跳到定义」之后真正想要的事——**别的地方**有没有这个东西
   */
  function gotoDefinition() {
    const controller = ws.focusedEditor()
    if (controller === null) {
      setEditorNotice({ level: 'plain', text: '这块分屏里没有可跳转的符号' })
      return
    }
    const { state } = controller.view
    const result = definitionAt(state, ws.activeTab().doc.path(), state.selection.main.head)
    if (result.kind === 'noWord') {
      setEditorNotice({ level: 'plain', text: '光标处没有一个词可跳（停在空白或标点了）' })
      return
    }
    if (result.kind === 'noTable') {
      // 措辞与 `Cmd+R` 浮层底下那一句逐字相同：同一个事实两种说法的话，
      // 用户会以为是两个不同的功能坏了
      setEditorNotice({ level: 'plain', text: `${result.label} 还没有符号表` })
      return
    }
    if (result.kind === 'notFound') {
      setEditorNotice({
        level: 'plain',
        text: `这份文件里没有叫 ${result.word} 的符号，试试 Mod+Alt+F 在项目里搜`,
      })
      return
    }
    // ⛔ 不 `reveal` 之后再 `focus`：`reveal` 自己会 focus（`editor/controller.ts:109`），
    // 而这一条链路里 `gotoCommit` 已经替我们走了一遍分片判断
    void gotoCommit({ kind: 'gotoPos', pos: result.pos })
  }

  /**
   * `Cmd+Click`（macOS）/ `Ctrl+Click`（其余）跳到定义（M5-2）。
   *
   * 🔴 与 `⌥⌘D` 共用 [`definitionAt`]，但**反应是相反的**：快捷键查不到要说出口，
   * 点击查不到要么改去搜项目、要么一个字都不说（那一下退回「加一个光标」）。
   * 那三路分流是 [`clickAction`]——单独一个纯函数，因为它会改掉一个既有手势，
   * 改坏了只会表现为「加光标莫名其妙不灵了」，必须有用例钉住。
   *
   * ⚠️ 路径与落点都从 `view` 反查，⛔ 都不碰 `activeTab()` / `focusedEditor()`：
   * 处理器跑在 CM6 自己的 mousedown **之前**，那一刻焦点还在用户上一碰的分屏上。
   * 于是也不能复用 `gotoCommit`——它那条 `gotoPos` 分支跳的是**聚焦**那块，
   * 在未聚焦的分屏里 Cmd+点击会跳错文档，所以这里直接拿本分屏的控制器 `reveal`
   */
  function definitionFromClick(view: EditorView, pos: number): boolean {
    const tab = ws.tabOfView(view)
    const controller = ws.controllerOfView(view)
    // 两者取其一为 null 就什么都不做：与 `pasteImageInto` 同一条兜法（类型收窄为主）
    if (tab === null || controller === null) return false
    const action = clickAction(definitionAt(view.state, tab.doc.path(), pos), tree.roots().length > 0)
    if (action.kind === 'jump') {
      // `reveal` 自带 `focus` 与居中滚动，正是「在点的那块分屏里跳过去」的完整语义。
      // 走它而不是 `gotoCommit`：后者只认聚焦分屏，而这一条链路的定义就在**这一块**里
      controller.reveal(action.pos, action.pos)
      return true
    }
    if (action.kind === 'search') {
      // 跨文件那一跳：不建索引，把词交给已有的全局搜索（口径见 `clickAction`）
      runWordSearch(action.word)
      return true
    }
    return false
  }

  /**
   * 拿光标处那个词到项目里搜（M5-1，`Mod+Alt+F`）。
   *
   * 🔴 复用 `search` 那一份状态，⛔ 不新写一套「跨文件找符号」：后者要一份常驻的跨文件
   * 索引，而那份索引正是这个编辑器不内存化的东西（口径见 `goto/symbols.ts` 文件头）。
   * 全局搜索已经会做「给一个词、列出所有命中并且点一行就跳过去」，这一条命令的全部
   * 新增内容就是**把那个词填进去并按下回车**。
   *
   * ⚠️ 拿不到词也照样展开面板（搜索框是空的）再说一句为什么：一个按下去没反应的
   * 快捷键信息是零，与 `togglePreview` / `alignTable` 同一条理由
   */
  function searchWordInFiles() {
    const controller = ws.focusedEditor()
    const word = controller === null ? null : wordUnderCaret(controller.view.state)
    if (word === null) {
      search.show()
      setEditorNotice({ level: 'plain', text: '光标处没有一个词，搜索框是空的（自己输）' })
      return
    }
    runWordSearch(word)
  }

  /**
   * 「给一个词，展开搜索面板并起搜」。两个入口共用：`⌥⌘F`（光标处那个词）与
   * `Cmd+Click`（点着的那个词在这份文件里没有声明时，见 [`clickAction`]）。
   *
   * ⚠️ 顺序是先填词与开关，再 `show()`（那一下只是写两个信号：可见 + 请求焦点），
   * 最后起搜。反过来先 `show()` 会让面板带着**上一轮**的词闪一帧
   *
   * ⚠️ 整词开关只在关着的时候打开，不主动关：用户自己开着整词搜过一轮的话，
   * 这里不该替他改回去——那会让「上一次搜 `get` 看到了 `getName`」这件事
   * 变成他下一次没看到 `getName` 的原因，一个开关两副面孔
   */
  function runWordSearch(word: string) {
    search.setPattern(word)
    if (!search.wholeWord()) search.toggle('wholeWord')
    search.show()
    void search.search()
  }

  /**
   * ⌘V 进来一张图（M3-A-7）：把它落到文档旁边的 `assets/` 里，光标处插一行相对链接。
   *
   * 🔴 返回值必须是同步的，而落地是异步的：paste 处理器的返回值决定 CM6 要不要
   * `preventDefault`，那一刻之后再想说「我接了」已经来不及。于是这里答的只是
   * **「这份文档该不该接」**，答完 true 就把剩下的交给 fire-and-forget 的那半截，
   * 成没成通过 `editorNotice` 说回话。
   *
   * ⚠️ 答 false 会让 CM6 走默认粘贴，而它的默认路径**不认文件**：剪贴板里只有那张图时，
   * 什么都不会插进去。那是一次静默，所以「不是 Markdown」这一支要说出口
   *
   * ⚠️ 目标文档从 `tabOfView(view)` 推，⛔ 不从 `activeTab()` 推：钩子拿到的是
   * **收到 paste 事件的那块分屏**，而 `activeTab()` 读的是焦点跟踪的结果，
   * 两者在「焦点还没跟上」的时序下会不是同一个标签——图片落到隔壁文档的目录里，
   * 链接插在另一份文档里，两边都错而且错得对不上
   */
  function pasteImageInto(file: File, view: EditorView): boolean {
    const tab = ws.tabOfView(view)
    // 找不到对应标签只可能是分片只读视图（它没有 CM6 实例，压根不会发 paste 事件），
    // 兜住是为了类型收窄，不是为了兜某个真实场景
    if (tab === null) return false
    const path = tab.doc.path()
    if (!acceptsPastedImage(path)) {
      // `plain`：往一个 `.rs` 里粘截图不是故障，也不是我们没做成——是这件事本来就不该做
      setEditorNotice({ level: 'plain', text: '这份文档不是 Markdown，图片不会落地成 assets/' })
      return false
    }
    void landPastedImage(file, {
      path,
      // `replaceSelection` 而不是手拼 `changes`：多光标时每个光标各插一份链接，
      // 而那正是按 ⌘V 的预期。它是一次普通编辑事务，进撤销栈、把文档标脏——
      // 都对：正文里多了一行，那一行必须跟着 ⌘S 落盘
      insert: (text) => view.dispatch(view.state.replaceSelection(text)),
      notify: (text, level) => setEditorNotice({ level, text }),
    })
    return true
  }

  /**
   * Markdown 里打完 `](` 之后要的那批候选（M3-A-6）。
   *
   * 🔴 走的是 `Cmd+P` 同一个 `query_project`，⛔ 没有新建一条命令、也没有新索引：
   * 那条命令在缓存是空的时候**自己会建**（`commands.rs` 的 `query_cached`），
   * 所以这里不需要先 `indexProject` 预热。第一次触发要付一次建索引的钱
   * （两万文件 40ms、十万文件 205ms，数字取自那条命令的注释），之后命中缓存。
   *
   * ⚠️ 慢与失败都不用在这一层兜：慢由 CM6 自己处理（结果落地前查 `context.aborted`，
   * 没作废的再拿 `validFor` 对当前那段文字重过一遍）；失败由 `editor/linkSource.ts`
   * 那个源吃掉——reject 冒到 CM6 的后果是「浮层被关掉 + 控制台一条异常」。
   *
   * ⚠️ 与 `pasteImageInto` / `definitionFromClick` 不同，这里**不需要** `tabOfView`：
   * 补全源拿到的只有 `CompletionContext`（有 state、没有 view），所以「相对哪份文档算路径」
   * 是 `doc/tab.ts` 在建 state 时按标签闭包好递进来的，没有「焦点还没跟上」那条竞态。
   *
   * 两种情况回 `null`（= 这一轮不参与，浮层里只剩词补全）：文档还没存过（没有基准可推），
   * 以及还没打开文件夹（没有项目可查）。都不说出口——补全浮层不是一个能挂通知的地方，
   * 而这两种情况用户自己看得见（标签上写着「空文档」、侧栏是空的）。
   */
  async function linkFilesFor(typed: string, docPath: string | null): Promise<string[] | null> {
    const roots = tree.roots()
    if (docPath === null || roots.length === 0) return null
    const found = await queryProject(roots, linkNeedle(typed), ws.recent())
    return linkTargets(
      docPath,
      found.matches.map((match) => match.path),
    )
  }

  /**
   * 把聚焦那份 Markdown 导出成单文件 HTML（M3-A-6，`Mod+Shift+E`）。
   *
   * 刻意叫 `exportDocument` 而不是 `exportHtml`：后者是从 `./md/export` 引进来的那个纯函数，
   * 同名会让「拼字符串的那一半」与「弹对话框、写盘、说回话的那一半」在读起来变成一个东西，
   * 而它们的可测性差着一整个数量级——前者在 node 环境里能穷举，后者只能靠接线用例
   *
   * 🔴 四种拒绝**全都要说出口**，一种都不能沉默：按了 `Mod+Shift+E` 之后什么都没发生，
   * 用户得到的信息是零，而他下一个动作是再按一次
   */
  async function exportDocument() {
    const controller = ws.focusedEditor()
    if (controller === null) {
      setEditorNotice({ level: 'plain', text: '这块分屏里没有可导出的正文' })
      return
    }
    const doc = ws.activeTab().doc
    /**
     * 🔴 两个 `import()` 都是**动态**的（M3-C-1）：`md/preview` 身后是 `md/render`，
     * `md/export` 身后同样是 `md/render`（它 import 那个 `escapeHtml`），
     * 于是这两个模块一起把那个 18.1KB 的渲染器挡在首屏外面。
     *
     * ⚠️ 放在弹对话框**之前**：那一次 import 在 Tauri 里是读本地文件，毫秒以下，
     * 但把它放在 `pickToSave` 之后就变成「用户选完了路径，界面才卡一下」——
     * 同一毫秒，位置不同，读起来完全不同
     *
     * ⚠️ `Promise.all` 而不是两次 `await`：两个 chunk 没有先后关系，
     * 串起来是把一次并行的读盘变成两次
     */
    const [{ previewHtml }, exported] = await Promise.all([import('./md/preview'), import('./md/export')])
    const result = previewHtml(controller.view.state, doc.path())
    if (result.kind === 'unsupported') {
      setEditorNotice({ level: 'plain', text: `${result.label} 不能导出 HTML，只有 Markdown 有预览` })
      return
    }
    // 🔴 `partial` 一律拒绝，⛔ 不「先导出前半截」。那个标志的意思是 `ensureSyntaxTree`
    // 在 200ms 内没解析完，渲染出来的是**半截树**（见 `md/preview.ts` 的文件头）。
    // 预览里出半截是可以的——旁边就是源文件，用户看得见少了什么；而导出件是要发出去的，
    // 收到它的人手上没有源文件，他看到的是一个「结尾莫名其妙没了」的网页，
    // 并且会认为这就是这份文档的全部
    if (result.partial) {
      setEditorNotice({ level: 'plain', text: '这份文档太大，解析没能在限定时间内跑完——导出会缺后半截，所以先不导' })
      return
    }
    if (result.html === '') {
      setEditorNotice({ level: 'plain', text: '这份文档还是空的，没有什么可导出的' })
      return
    }
    // `defaultPath` 只带文件名，不带目录：交给系统对话框去决定落在哪儿。
    // ⚠️ 拼一个「源文件旁边的 t.html」听起来更贴心，但那等于替用户猜了一个目录，
    // 而猜错时他会把导出件写进一个他没打算写的地方
    const picked = await pickToSave({
      defaultPath: exported.exportFileName(doc.path(), doc.name()),
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    })
    if (typeof picked !== 'string') return
    try {
      await saveFile(picked, exported.exportHtml(doc.name(), result.html), exported.EXPORT_FILE_FORMAT)
      // `ok`：这一次**真的写了一个文件**，与上面那几句「没什么可做」不是一类事
      setEditorNotice({ level: 'ok', text: `已导出到 ${picked}` })
    } catch (err) {
      // 复用 `describeFsError`：写盘失败的原因（没有目录部分、权限、磁盘满）与保存失败
      // 是同一批，那边已经把它们说成人话了，这里再写一份只会写出不一样的一句
      setEditorNotice({ level: 'error', text: `导出失败：${describeFsError(err)}` })
    }
  }

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

  /**
   * 这块分屏现在显示的那个标签的**只读分片**；没有就是 null。
   *
   * 🔴 返回值**不是** Accessor，而调用点必须写成 `when={shardOf(pane)}`——就在 JSX 里
   * 当场调。Solid 的 `<Show>` 只把 `when` 当普通值做真值判断，一个函数引用**永远为真**，
   * 于是 `when={shardOf}`（漏了括号）会让每一块分屏都渲染成 `<ShardPane>`，
   * 而且 TypeScript 会顺着 `NonNullable<T>` 把回调参数推成那个 Accessor 本身，
   * 报错报到 `view={…}` 那一行上去，离真正的错处隔了一层
   *
   * JSX 编译器把 `when={…}` 包成 getter，所以当场调**就是**响应式的：
   * 它读的 `pane.tabId()`（这块分屏换了标签）与 `doc.shard()`（同一个标签从内联变成了
   * 分片——文件在 Vela 开着的时候长过了 4 MiB）任一变化都会重跑这个 getter，
   * 把 `<EditorPane>` 换成 `<ShardPane>`。少了订阅的症状是「内容明明是新的，编辑器却还空着」
   *
   * 与 `paneState` 相反，这里**不**用 `untrack`：要的正是订阅
   */
  function shardOf(pane: Pane): ShardView | null {
    return (
      ws
        .tabs()
        .find((t) => t.id === pane.tabId())
        ?.doc.shard() ?? null
    )
  }

  /**
   * 正文右键菜单那一份现场。存**这块分屏**，⛔ 不存它的 controller：
   * 菜单弹着的时候用户可能 ⌘W 把这一块关掉（`detach` 会把 `controller` 置 null
   * 并 destroy 那个 view），而 pane 这个对象本身还活着——于是「哪一块」由它答，
   * 「还在不在」由 `controller === null` 答，两件事分开
   */
  const [editorMenu, setEditorMenu] = createSignal<{ x: number; y: number; pane: Pane } | null>(null)

  /**
   * 右键编辑器正文。
   *
   * 🔴 只读大文件分片**不接**（`shardOf`，与下面 JSX 里那个 `<Show>` 同一条判据）：
   * 它没有 CM6 实例，六项一项也做不成，而 macOS 那份原生菜单至少还能选中文字复制——
   * 留原生的比弹一份全灰的好，所以那一支连 `preventDefault` 都不调
   *
   * ⛔ 这里**不**替分屏记焦点：浏览器真的把焦点移进来了，`EditorPane` 的 `onFocus`
   * 会自己记（DOM 才是这件事的真相来源）；没移进来而我们记了一笔，状态栏就会开始
   * 显示一块打不进字的分屏。所以下面所有动作一律走 `pane.controller`，
   * ⛔ 不走 `ws.focusedEditor()`——菜单该作用在**被右键的那一块**上，与焦点在哪无关
   */
  function onEditorContextMenu(e: MouseEvent, pane: Pane) {
    if (shardOf(pane) !== null) return
    e.preventDefault()
    setEditorMenu({ x: e.clientX, y: e.clientY, pane })
  }

  /**
   * 菜单里那六项，与它们各自灰不灰。
   *
   * ⚠️ 读的是**右键那一刻**的选区与语言，不订阅：菜单是个快照，而它开着的时候选区
   * 不会再变（任何一次 mousedown 都会先把它关掉，见 `TreeMenu` 的四条关闭路径）
   *
   * 🔴 剪切／复制在没有选区时灰掉，⛔ 不是「点了不说话」：那看起来像菜单坏了。
   * 粘贴与全选**恒可用**——剪贴板里有没有东西这一层不知道（读它要一次异步 IPC），
   * 而全选在空文档上也只是个空操作，都不值得为它去猜
   *
   * ⚠️ 折叠那两项的判据是「有没有语言」而不是「有没有可折叠的语法节点」：后者要扫一遍
   * 语法树，而纯文本连语言都没有，`foldAll` 在它上面恒为空操作。判粗一点的代价是
   * 「一份没有任何块的 JSON 上这两项是亮的、点了什么也没发生」，比每弹一次菜单扫一遍
   * 全文便宜得多
   */
  function editorMenuItems(pane: Pane): ContextMenuItem<EditorMenuAction>[] {
    const view = pane.controller?.view
    const hasSelection = view !== undefined && view.state.selection.ranges.some((range) => !range.empty)
    const foldable = view !== undefined && view.state.facet(language) !== null
    return [
      { action: 'cut', label: '剪切', disabled: !hasSelection },
      { action: 'copy', label: '复制', disabled: !hasSelection },
      { action: 'paste', label: '粘贴' },
      { action: 'selectAll', label: '全选' },
      { action: 'foldAll', label: '折叠全部', separator: true, disabled: !foldable },
      { action: 'unfoldAll', label: '展开全部', disabled: !foldable },
    ]
  }

  /**
   * 剪贴板那三项做不到时说一句话。⛔ 不静默：`navigator.clipboard` 要安全上下文，
   * 而 Tauri 跑的是 `tauri://localhost`（完整论证与补救方案写在 `editor/clipboard.ts`
   * 的文件头）——「点了没反应」与「点了但做不到」在用户那边长得一样，只有后者能被修
   */
  function clipboardFailed(verb: string) {
    setEditorNotice({ level: 'error', text: `${verb}不了——拿不到系统剪贴板，请用 Cmd+C / Cmd+X / Cmd+V` })
  }

  /**
   * 🔴 必须有 switch：六项各有各的落点，而「加了第七项却忘了处理」的失败方式是
   * 点下去什么也没发生（类型只在 `action` 上帮忙，不会替你写分支）
   * ——与 `doc/TabStrip.tsx` 的 `onPick` 同一条纪律
   */
  function onEditorMenuPick(pane: Pane, action: EditorMenuAction) {
    const controller = pane.controller
    // 菜单弹着的时候这块分屏被关掉了：view 已经 destroy，往上 dispatch 是未定义行为
    if (controller === null) return
    const view = controller.view
    switch (action) {
      case 'cut':
        void cutSelection(view).then((ok) => {
          if (!ok) clipboardFailed('剪切')
        })
        return
      case 'copy':
        void copySelection(view).then((ok) => {
          if (!ok) clipboardFailed('复制')
        })
        return
      case 'paste':
        void pasteInto(view).then((ok) => {
          if (!ok) clipboardFailed('粘贴')
        })
        return
      case 'selectAll':
        selectAll(view)
        return
      // 折叠走注册表那两条命令，⛔ 不在这里重实现：命令面板、将来的键绑定与这个菜单
      // 从此是同一份行为。递显式 ctx 是为了作用在**被右键的那一块**上（理由见上面）
      case 'foldAll':
        void registry.execute('editor.foldAll', { editor: controller })
        return
      case 'unfoldAll':
        void registry.execute('editor.unfoldAll', { editor: controller })
        return
    }
  }

  /**
   * 命令的上下文。⚠️ 这一份被**两处**读，而它们要的求值时机不同，所以它是一个函数、
   * 不是一个存下来的快照：
   *
   * - 注册表：命令的 `when` 在 `execute` 那一刻读一次就够，所以「被调用时求值」正是它要的；
   * - 命令面板：置灰状态要跟着焦点走，于是 `createCommandPalette` 把它读进一个 memo 的
   *   追踪范围里（`commands/palette.ts` 的 `all`）——同一次调用，那一下就从「求值」变成了「订阅」。
   *
   * 🔴 M3-B-1 之前这里挂着一句「命令面板落地时要改成订阅」的 TODO。改法不是把这一行改掉，
   * 而是把**这个函数本身**交给面板：注册表那一边一个字都不用动
   */
  const appContext = (): AppContext => ({ editor: ws.focusedEditor() })

  const registry = createCommandRegistry({
    platform: detectPlatform(),
    getContext: appContext,
  })

  /**
   * 用户自定义快捷键（M4-E）。store 只管「覆盖配置」的内存缓存与写穿，
   * 运行时生效靠把它 rebind 进上面那个注册表——dispatch 与命令面板读的都是注册表。
   */
  const keybindingStore = createKeybindingStore(registry.platform)
  /** rebind 不是信号，注册表变了靠这个版本号让命令清单重算 */
  const [kbVersion, setKbVersion] = createSignal(0)
  const commandList = createMemo(() => {
    kbVersion()
    return registry.list(appContext())
  })

  /**
   * 工具箱（M3-B-1）。宿主能力只有三条，全是「工具箱自己不知道、只有 App 知道」的事：
   * 哪一块分屏正被聚焦、怎么改它、剪贴板在哪儿。
   *
   * 🔴 **建在 `registerBuiltinCommands` 之前**（那一条在下面的 `onMount` 里）：
   * `createToolBox` 会把工具投影成命令塞进同一个注册表，而它是**同步**做的。
   * 反过来的顺序也不会坏——`palette` 的 `all` memo 每次 `show()` 都重抓一遍清单
   * （理由写在 `commands/palette.ts`）——但把「先有工具、后有内置命令」写死在这里，
   * 读代码的人就不必去推那一格 `generation` 到底救没救回来
   */
  const toolbox = createToolBox({
    commands: registry,
    tools: BUILTIN_TOOLS,
    host: {
      // ⚠️ 是快照：`doc.toString()` 拷一份，工具跑的是「按下那一刻的正文」
      readEditor: () => ws.focusedEditor()?.view.state.doc.toString() ?? null,
      /**
       * 插到聚焦那块分屏的光标处（有选区就连选区一起换掉）。
       *
       * 🔴 **不需要 `batch`**：这里只碰 CM6，一个信号都不写。危险的顺序是「先写信号、
       * 再改 CM6」——裸的信号写在事件处理器里会同步冲掉所有 user effect，
       * 见 `doc/workspace.ts` 的文件头与上面 `alignTable`。工具箱里调这一条的
       * `insertIntoEditor` 是**先** `host.writeEditor(...)`、返回之后才写 `notice` / `visible`，
       * 正好是安全的那一边
       */
      writeEditor(text: string): boolean {
        const controller = ws.focusedEditor()
        if (controller === null) return false
        const selection = controller.view.state.selection.main
        controller.view.dispatch({ changes: { from: selection.from, to: selection.to, insert: text } })
        return true
      },
      copy: writeClipboard,
    },
  })

  /** 命令面板（M3-B-1d）。它自己也出现在自己那份清单里，理由与安全性见 `commands/palette.ts` */
  const palette = createCommandPalette({ registry, context: appContext })

  onMount(() => {
    // 首屏先把**默认**字体注入起来，不等配置那次 IPC 回来；随后上面 roots 那个 effect
    // 会 `settings.load(...)` 把持久化的值装回来并覆盖。字体注入与编辑器挂载并行：
    // 编辑器不等字体，到达后浏览器自己用 font-display: swap 重排
    settings.applyNow()
    // 「合并分屏」= 把除聚焦那块以外的分屏一次全合掉，塌回单栏。与「关闭分屏」
    // （只关聚焦的那一块）共用同一个 `ws.closePane`：它会先把现场 capture 回标签，
    // 所以合掉的分屏里没存盘的正文不会丢，标签也留在条上。遍历的是快照，
    // 而 closePane 每次读的是活的 `panes()`，于是逐块收缩、聚焦那块自始至终不动。
    // 🔴 命令面板的 `editor.mergePanes` 与「窗口」菜单的 `window.merge_panes` 共用这一份，
    // 于是两个入口的「合并分屏」是**同一个行为**，不会再出现同名不同事
    const mergeAllPanes = () => {
      const keep = ws.focusedPaneId()
      for (const pane of [...ws.panes()]) if (pane.id !== keep) ws.closePane(pane.id)
    }
    disposeCommands = registerBuiltinCommands(registry, {
      newDocument: () => {
        ws.newTab()
      },
      openFile: ws.openViaDialog,
      saveFile: ws.save,
      saveFileAs: ws.saveAs,
      applyLineWrap: (on) => ws.setLineWrap(on),
      toggleMinimap: () => ws.setMinimap(!ws.minimap()),
      // 字号的档位夹取与写穿都在 store 里，这里只把命令接到 store 的方法上。
      // ⚠️ 递的是**裸引用**（`settings.stepFontSize` 而不是 `(d) => settings.stepFontSize(d)`）：
      // store 里这些是具名函数、不依赖 `this`，正是为了能被这样递出去
      adjustFontSize: settings.stepFontSize,
      resetFontSize: settings.resetFontSize,
      splitRight: () => ws.split('row'),
      splitDown: () => ws.split('column'),
      closePane: () => ws.closePane(ws.focusedPaneId()),
      mergePanes: mergeAllPanes,
      focusNextPane: () => ws.cyclePane(1),
      focusPreviousPane: () => ws.cyclePane(-1),
      // ⚠️ 「其它」的参照物是**活动标签**（`activeTab()`），不是右键菜单里那个被点的标签：
      // 按键时用户看着的就是活动的那个。语义差一个字，理由写在 `BuiltinHooks.closeOtherTabs` 上
      closeOtherTabs: () => void ws.closeOtherTabs(ws.activeTab().id),
      closeAllTabs: () => void ws.closeAllTabs(),
      openFolder,
      addFolder,
      // 与上面两条不同：它不弹系统对话框，而是把那个跳转浮层以「最近项目」的意图展开。
      // 落地在下面的 `gotoCommit`——`openWorkspace` 那一支调 `tree.openMany`，
      // 于是「切项目」与「打开文件夹」共用同一条「装回 N 个根」的路径
      openRecentProject: () => void goto.show('', 'project'),
      closeFolder: () => tree.close(),
      toggleSidebar: () => setSidebarVisible((v) => !v),
      togglePreview: () => setPreviewMode((m) => nextPreviewMode(m)),
      toggleJsonPreview: () => setJsonPreviewVisible((v) => !v),
      toggleOutline: () => setOutlineVisible((v) => !v),
      alignTable,
      wordCount,
      exportHtml: exportDocument,
      findInFiles: () => search.show(),
      replaceInFiles: () => search.showReplace(),
      searchWordInFiles,
      gotoFile: () => void goto.show(),
      gotoSymbol: () => void goto.show('@'),
      gotoDefinition,
      // 两条都**不带参数**：`toolbox.show()` 停在上次那个工具上，`palette.show()` 清空查询词。
      // 「从命令面板里挑一个工具」那条路径不走这里——`tools/registry.ts` 的 `openTool(id)`
      // 是工具箱自己投影进注册表的那一条命令，与 `toolbox.open` 是两扇门，理由写在那儿
      openToolBox: () => toolbox.show(),
      openCommandPalette: () => palette.show(),
    })
    detachKeys = attachKeybindingDispatch(registry)
    // 装回用户自定义快捷键。必须排在 registerBuiltinCommands 之后（rebind 对未注册命令抛错）；
    // load 是异步的，回来时注册早已完成。磁盘上解析不了的条目跳过而不是炸启动
    void keybindingStore.load().then((overrides) => {
      for (const [id, sources] of Object.entries(overrides)) {
        try {
          registry.rebind(id, sources)
        } catch (err) {
          console.warn(`[keybindings] 跳过磁盘上无效的绑定 "${id}":`, err)
        }
      }
      setKbVersion((v) => v + 1)
    })
    sync = createSessionSync({ workspace: ws, project: tree, onWarn: setSessionWarning })
    // 不 await：读存档与重新读盘可能要几百毫秒，编辑器该先出来给用户看
    void sync.start().then(() => {
      // 上次开着文件夹就把侧边栏打开。树已经恢复好了却看不见，等于没恢复；
      // 而 `openFolder` 里那条「对话框取消就不显示」的判断在这儿不适用——
      // 这次不是用户刚点了什么，是他上次的现场
      if (tree.roots().length > 0) setSidebarVisible(true)
    })
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
    // 菜单事件监听：Rust 侧把所有菜单项点击转发成 `menu-event` 事件，
    // 载荷是菜单 ID（如 "file.new"）。这里路由到对应的命令。
    import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<string>('menu-event', ({ payload: id }) => {
        const ctx = appContext()
        routeMenuEvent(
          id,
          {
            newTab: () => ws.newTab(),
            openViaDialog: ws.openViaDialog,
            openFolder,
            openRecentProject: () => void goto.show('', 'project'),
            closeFolder: () => tree.close(),
            save: (c) => void registry.execute('editor.save', c),
            saveAs: (c) => void registry.execute('editor.saveAs', c),
            findInFiles: () => search.show(),
            replaceInFiles: () => search.showReplace(),
            formatJson: (c) => void registry.execute('editor.formatJson', c),
            minifyJson: (c) => void registry.execute('editor.minifyJson', c),
            alignTable,
            wordCount,
            toggleSidebar: () => setSidebarVisible((v) => !v),
            togglePreview: () => setPreviewMode((m) => nextPreviewMode(m)),
            toggleOutline: () => setOutlineVisible((v) => !v),
            toggleJsonPreview: () => setJsonPreviewVisible((v) => !v),
            zoomIn: () => settings.stepFontSize(1),
            zoomOut: () => settings.stepFontSize(-1),
            resetZoom: settings.resetFontSize,
            toggleLineWrap: () => ws.setLineWrap(!ws.lineWrap()),
            // 与命令面板的 `view.toggleMinimap` 共用同一个翻转：两个入口必须是同一个行为
            toggleMinimap: () => ws.setMinimap(!ws.minimap()),
            openCommandPalette: () => palette.show(),
            showSettings: () => setSettingsDialogVisible(true),
            toggleMdToolbar: () => setMdToolbarVisible((v) => !v),
            splitRight: () => ws.split('row'),
            splitDown: () => ws.split('column'),
            // 与命令面板的 `editor.mergePanes` 共用同一份 `mergeAllPanes`（定义在 onMount 顶部）：
            // 「合并分屏」在这两个入口必须是同一个行为，理由写在那一份定义上
            mergePanes: mergeAllPanes,
            focusNextPane: () => ws.cyclePane(1),
            focusPrevPane: () => ws.cyclePane(-1),
            closePane: () => ws.closePane(ws.focusedPaneId()),
          },
          ctx,
        )
      }).then((unlisten) => {
        if (tornDown) unlisten()
        else detachMenu = unlisten
      })
    })
    // ⚠️ 三个搜索事件在**启动时挂一次、挂着不放**，不是每次搜索挂一遍：`listen` 本身是
    // 异步的，注册之前到达的事件永久丢失。而 `start_search` 是先 spawn 后台线程再返回
    // taskId 的，所以「事件已经在路上」与「前端还没挂好」这两件事会重叠——
    // 丢掉的是最前面那几批，表现是「共 87 处」与列表里的条数对不上，见 ipc/search.ts
    void attachSearchListeners(search.handlers).then((unlisten) => {
      if (tornDown) unlisten()
      else detachSearch = unlisten
    })
    // 替换那三个与搜索那三个**同时挂着**：事件名不同（`vela://replace-*`），taskId 由
    // Rust 侧同一个计数器发号、永不重复，所以两组监听与两个 TaskSlot 互不干扰。
    // 同一条规矩：启动时挂一次、挂着不放——`replace-done` 是唯一能让 UI 停止转圈的东西，
    // 而它到达时磁盘已经改完了，漏掉它用户面对的是一个「改完了却显示还在改」的仓库
    void attachReplaceListeners(search.replaceHandlers).then((unlisten) => {
      if (tornDown) unlisten()
      else detachReplace = unlisten
    })
    // 文件监听同样是**启动时挂一次、挂着不放**，而且比上面两组更要紧：那两组漏了
    // 顶多是界面转圈不停，这一组漏了用户会在不知情的情况下用 ⌘S 把别人的改动盖掉。
    // `start()` 内部先挂 `listen` 再送第一份清单，顺序的理由写在 `doc/fileWatch.ts`。
    //
    // ⚠️ 与 `sync.start()` 谁先谁后无所谓：会话恢复会换掉整批标签，而那一下会让
    // 这边的 effect 重跑、把恢复出来的路径重新送一遍。清单是**全量**的，
    // 所以「先送了一份空的」不会留下任何需要清理的状态
    void fileWatch.start().then((dispose) => {
      if (tornDown) dispose()
      else detachFileWatch = dispose
    })
    // 拖文件进窗口打开（M4-G）。与关窗守卫同一条要求：启动第一时间挂上，
    // 挂上之前到达的 drop 事件会丢——而那一下就发生在窗口刚出现的时候
    void attachFileDrop((paths) => {
      void handleDroppedPaths(paths, {
        openAt: (p) => ws.openAt(p),
        notify: (text) => setEditorNotice({ level: 'error', text }),
      })
    }).then((unlisten) => {
      if (tornDown) unlisten()
      else detachDrop = unlisten
    })
  })

  onCleanup(() => {
    tornDown = true
    sync?.stop()
    detachCloseGuard?.()
    detachMenu?.()
    detachSearch?.()
    detachReplace?.()
    detachFileWatch?.()
    detachDrop?.()
    detachKeys?.()
    disposeCommands?.()
    // 与上面那一条是两笔账：`disposeCommands` 注销的是内置命令，这一条注销的是
    // **工具投影出来的**那一批（`tools/registry.ts` 的 `installTools`）。
    // ⚠️ 注册表是每个 App 实例自己建的，所以少调它不会在真机上留下什么——写在这里是为了对称：
    // 「谁装的谁卸」，读的人不必去推哪个 dispose 覆盖了哪一批命令
    toolbox.dispose()
    // 分屏的现场由各自的 EditorPane.onDestroy 存回标签，这里不 detach
  })

  return (
    <div class="app">
      {/* Sublime 排布：侧边栏是 `.app` 的**左列**（`.sidebar-col`，grid 上跨 1~4 行通顶到底），
          标签条 / 工具栏 / 提示条 / 正文区都在右列。于是侧栏打开时标签条让到侧栏右边、
          只盖在编辑器上方；侧栏收起时左列没有 grid item、`auto` 塌成 0，标签条回到整窗通栏。
          把手是 `.sidebar-col` 的 flex 子项，必须紧跟侧边栏：它画的就是左列与右列之间那条线 */}
      <Show when={sidebarVisible()}>
        <div class="sidebar-col">
          <Sidebar tree={tree} onNotice={setTreeNotice} width={sidebarWidth()} />
          <SidebarResize width={sidebarWidth} onWidth={setSidebarWidth} />
        </div>
      </Show>

      {/* 工具栏已移入标准桌面菜单（File/Edit/View/Window/Help），保持界面简洁 */}
      {/* <div class="toolbar"> ... </div> */}

      {/* 标签右键菜单的失败一句话接到 `treeNotice` 那一条上：提示条是横贯窗口的，
          而「在 Finder 里显示不出来」既不专属某一块分屏（那是 `editorNotice`，切分屏就清），
          也不是设置对话框的事。成功不说话，理由在 TabStripProps.onError 上 */}
      <TabStrip workspace={ws} onError={(text) => setTreeNotice({ level: 'error', text })} />

      {/* Markdown 工具栏（M4-F）*/}
      <Show when={mdToolbarVisible()}>
        <MarkdownToolbar editor={() => ws.focusedEditor()} onToggle={() => setMdToolbarVisible(false)} />
      </Show>

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
        <Show when={settingsNotice()}>
          {(text) => (
            <div class="notice warning">
              <span>{text()}</span>
              <button class="notice-close" onClick={() => setSettingsNotice(null)} title="关闭">
                ×
              </button>
            </div>
          )}
        </Show>
        <Show when={treeNotice()}>
          {(n) => (
            <div class={`notice ${n().level}`}>
              <span>{n().text}</span>
              <button class="notice-close" onClick={() => setTreeNotice(null)} title="关闭">
                ×
              </button>
            </div>
          )}
        </Show>
        <Show when={reloadedNotice()}>
          {(text) => (
            <div class="notice ok">
              <span>{text()}</span>
              <button class="notice-close" onClick={() => setReloadedNotice(null)} title="关闭">
                ×
              </button>
            </div>
          )}
        </Show>
        <Show when={editorNotice()}>
          {(n) => (
            // ⚠️ `plain` 那一档必须渲染成光秃秃的 `notice`，而不是 `notice plain`：
            // `.notice.plain` 在 `styles.css` 里没有规则，多写一个类名不会报错，
            // 但「无色」这件事就从「没有修饰类」变成了「有一个没人实现的修饰类」——
            // 而 M3-A-5 那条用例钉的正是 `className === 'notice'`
            <div class={n().level === 'plain' ? 'notice' : `notice ${n().level}`}>
              <span>{n().text}</span>
              <button class="notice-close" onClick={() => setEditorNotice(null)} title="关闭">
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

      {/* `.main` 是新增的一层纵向 flex，整个占住 `.app` 第四行那份 1fr：上面是正文区，
          下面是全局搜索的结果面板。刻意不给 `.app` 的 grid 加第六行——那里行数固定为五行
          （工具栏/标签条/提示条/正文/状态栏），多插一行就会把 `1fr` 挤到错误的行上，
          styles.css 里那条注释正是在警告这件事。

          `.body-row` 跟着降级成 `.main` 的 flex 子项：大纲 / 正文区 / 预览横向并排
          （侧边栏不在这儿——它是 `.app` 的左列 `.sidebar-col`）。
          两层收起时都是 `<Show>` 直接不渲染，不留任何占位——没开过搜索的用户看到的
          布局与加这两层之前逐像素相同。 */}
      <div class="main">
        <div class="body-row">
          {/* 大纲那一栏（M3-A-4）。放在 `.body` **之前**：
              `.body-row` 是横向 flex，顺序就是屏幕顺序，而左边是这份文档的结构（大纲），
              中间是「写」，右边（预览）是「结果」。
              放到右边去的话它会与预览抢同一半宽，而两个同时开着是常态。
              分隔线同样沿用「gap 露出底色」，所以这一栏也**不加 border** */}
          <Show when={outlineVisible()}>
            <Suspense>
              <OutlinePanel
                source={followedEditor}
                revision={ws.revision}
                tabId={() => ws.activeTab().id}
                onJump={outlineJump}
                onClose={() => setOutlineVisible(false)}
              />
            </Suspense>
          </Show>

          {/* 阅读模式（`previewMode` 的 `only` 档）：`.preview-only` 把这一整块 `display: none`。
              🔴 是**藏**不是卸载——预览的数据源 `followedEditor` 拿的是一个活的 CM6 view，
              卸载的话 `ws.focusedView()` 变 null，预览跟着就空了。完整理由与两笔认了的债
              写在 `md/previewMode.ts` 的文件头。
              ⚠️ 判据是 `editorHidden()` 而不是 `previewMode() === 'only'`：没有预览可看的文档
              （`.ts`、只读大文件分片）会降级成并排，理由在它自己的注释里 */}
          <div class="body" classList={{ column: ws.direction() === 'column', 'preview-only': editorHidden() }}>
            <For each={ws.panes()}>
              {(pane) => (
                <div
                  class="editor-host"
                  classList={{ focused: ws.focusedPaneId() === pane.id }}
                  onContextMenu={(e) => onEditorContextMenu(e, pane)}
                >
                  {/* 🔴 **替换**而不是在编辑器上叠一层：留着 `EditorPane` 的话
                      `ws.focusedEditor()` 照样返回那块编辑器，于是 `Mod+F`、`Alt+Z`、
                      多光标——所有 `when: (ctx) => ctx.editor !== null` 的命令全部照常可用，
                      而它们改的是那份空 buffer。完整理由在 `ShardPane.tsx` 的模块文档里 */}
                  <Show
                    when={shardOf(pane)}
                    fallback={
                      <EditorPane
                        state={paneState(pane)}
                        onReady={(c) => ws.attach(pane.id, c)}
                        onDestroy={() => ws.detach(pane.id)}
                        onFocus={() => ws.notePaneFocus(pane.id)}
                      />
                    }
                  >
                    {(shard) => <ShardPane view={shard()} onFocus={() => ws.notePaneFocus(pane.id)} />}
                  </Show>
                </div>
              )}
            </For>
          </div>

          {/* Markdown 预览那一栏（M3-A-3）。放在 `.body` **之后**：`.body-row` 是横向 flex，
              顺序就是屏幕顺序，而「左边写、右边看」是这类面板的通用约定（VS Code / Obsidian
              都是）。分隔线沿用 `.body-row` 那套「gap 露出底色」，所以这一栏**不加 border**——
              border 参与盒模型，而旁边 CM6 靠父容器的 clientHeight 算可视行数

              ⚠️ `tabId` 传的是**当前活动标签**：预览跟着聚焦的那块分屏走，
              而 `activeTab()` 定义就是「聚焦分屏显示的那个标签」，两者天然对得上。
              ⚠️ `source` 与大纲那一栏是**同一个访问器**，理由写在 `followedEditor` 上。
              ⚠️ 可见性是三档而不是布尔（`md/previewMode.ts`），所以这里判的是 `!== 'off'`；
              阅读模式**不需要**给这一栏另加宽度——`.body` 一 `display: none` 就不再是 flex 子项，
              而它是 `flex: 1 1 0%`，剩下的宽度自然全归它。
              ⚠️ 面板上的 × 直接回 `off` 而不是退一档：× 的语义是「关掉这一栏」，
              用户点它的时候要的就是预览消失，不是换一个形态 */}
          <Show when={previewMode() !== 'off'}>
            <Suspense>
              <MarkdownPreview
                source={followedEditor}
                revision={ws.revision}
                tabId={() => ws.activeTab().id}
                alone={editorHidden}
                onClose={() => setPreviewMode('off')}
              />
            </Suspense>
          </Show>

          {/* JSON 预览那一栏（M4-D）。放在 Markdown 预览**之后**：两个都开时，
              JSON 预览在最右边。顺序是「编辑器 → Markdown 预览 → JSON 预览」，
              与「写 → 看渲染 → 看结构」的工作流一致。
              
              ️ 与 Markdown 预览共用同一个 `source` / `revision` / `tabId`，
              因为两个面板都跟着聚焦的那块分屏走 */}
          <Show when={jsonPreviewVisible()}>
            <Suspense>
              <JsonPreview
                source={followedEditor}
                revision={ws.revision}
                tabId={() => ws.activeTab().id}
                onClose={() => setJsonPreviewVisible(false)}
              />
            </Suspense>
          </Show>
        </div>

        <Show when={search.visible()}>
          <Suspense>
            <FindInFiles panel={search} />
          </Suspense>
        </Show>
      </div>

      <StatusBar
        workspace={ws}
        sidebar={{ open: sidebarVisible, toggle: () => setSidebarVisible((v) => !v) }}
        roots={tree.roots}
      />

      {/* `.modal-backdrop` 是 position:fixed，脱离 grid 流，所以不会给行数固定的
          `.app` 多加出一行来（绝对定位的子元素不是 grid item） */}
      <Show when={pendingClose()}>{(pending) => <DiscardDialog names={pending().names} onDecide={decide} />}</Show>

      {/* 外部改动的裁决框（M2-G）。⚠️ 与上面那个关闭确认**互斥**：`resolve('closeTab')`
          自己就会把 DiscardDialog 叫出来（脏标签要再问一次），而两个 `.modal-backdrop`
          同时在场会叠成两层遮罩——z-index 同为 10，谁在上面只取决于 DOM 顺序，
          被压在底下那个点不着。所以让关闭确认优先：它是用户刚刚亲手点出来的那一个，
          而冲突队列会一直等着（`fileWatch.current()` 不会因为没人看就丢掉） */}
      <Show when={pendingClose() === null && fileWatch.current()}>
        {(conflict) => (
          <FileConflictDialog
            conflict={conflict()}
            pending={fileWatch.pending()}
            onChoose={(choice) => void fileWatch.resolve(choice)}
          />
        )}
      </Show>

      {/* 全局替换的确认单（M2-D）。渲染在这里而不是面板自己里面：它是 `.modal-backdrop`，
          要盖住整个窗口，而面板只是 `.main` 底下那 240px——挂在里面的话遮罩只罩住面板自己。
          批准它是 Vela 里唯一一处批量写盘，也是唯一一处没有跨文件撤销的操作 */}
      <Show when={search.confirm()}>
        {(plan) => (
          <ReplaceConfirm plan={plan()} onApply={() => void search.confirmApply()} onCancel={search.dismissConfirm} />
        )}
      </Show>

      {/* 跳转浮层（M2-E，Cmd+P / Cmd+R）。`.palette-backdrop` 同样是 position:fixed，
          不给行数固定的 `.app` 多加一行。放在最后面是让 DOM 顺序与层叠顺序一致：
          它的 z-index 比上面两个模态都高（理由写在 styles.css 那一段上），
          于是「后面的在上面」这条直觉在这里也成立，读代码的人不必回头去查 z-index */}
      <Show when={goto.visible()}>
        <Suspense>
          <QuickOpen goto={goto} />
        </Suspense>
      </Show>

      {/* 命令面板（M3-B-1d，Cmd+Shift+P）与工具箱（M3-B-1，Cmd+Shift+T）。
          🔴 外面这一层 `<Show>` 是 M3-C-2 加的：两个组件都走 `lazy()`，
          而 `lazy` 那一次 import 是在**组件被创建时**发出的，不是在这个文件被求值时——
          所以只要这里无条件写着 `<CommandPalette …/>`，它就跟静态 import 一样在启动时进来了。
          ⚠️ 组件内部各自还包了一层同条件的 `<Show>`，理由见上面那两个 `lazy()` 的注释

          🔴 顺序是「面板在前、工具箱在后」：`.palette-backdrop` 与 `.toolbox-backdrop`
          的 z-index 都是 20，同值时**后出现在 DOM 里的在上面**。而唯一会同时开着两个的
          情形正是「在命令面板里挑了一个工具」——那一下要看见的是工具箱，不是面板
          （面板自己会先收起，见 `commands/palette.ts` 的 `commit()`，但收起与展开
          在同一个 tick 里，谁在上面还是得由 DOM 顺序兜住）。
          ⚠️ 两个 `<Suspense>` 都**不产生 DOM 节点**，于是这条顺序在懒加载之后照旧成立 */}
      <Show when={palette.visible()}>
        <Suspense>
          <CommandPalette palette={palette} />
        </Suspense>
      </Show>
      <Show when={toolbox.visible()}>
        <Suspense>
          <ToolBox box={toolbox} />
        </Suspense>
      </Show>

      {/* 设置对话框（菜单触发，View → 设置... / Cmd+,）*/}
      <Show when={settingsDialogVisible()}>
        <SettingsDialog
          settings={settings}
          visible={settingsDialogVisible()}
          onClose={() => setSettingsDialogVisible(false)}
          onOpenKeybindings={() => {
            setSettingsDialogVisible(false)
            setKeybindingsDialogVisible(true)
          }}
        />
      </Show>

      {/* 快捷键配置对话框（M4-E）*/}
      <Show when={keybindingsDialogVisible()}>
        <KeybindingsDialog
          visible={keybindingsDialogVisible()}
          onClose={() => setKeybindingsDialogVisible(false)}
          commands={commandList()}
          platform={registry.platform}
          setKeybinding={(id, keybinding) => {
            try {
              registry.rebind(id, keybinding)
            } catch (err) {
              console.warn(`[keybindings] 命令 "${id}" 的绑定 "${keybinding}" 无效:`, err)
              return false
            }
            keybindingStore.set(id, [keybinding])
            setKbVersion((v) => v + 1)
            return true
          }}
          resetKeybinding={(id) => {
            // def.keybinding 永远是内置默认（rebind 不动 def），递回去就是重置
            registry.rebind(id, registry.get(id)?.keybinding)
            keybindingStore.reset(id)
            setKbVersion((v) => v + 1)
          }}
        />
      </Show>

      {/* 正文的右键菜单。挂在 `.app` 这一层而不是 `.editor-host` 里面：`.tree-menu` 是
          `position: fixed`（脱离文档流，不给 grid 多添一行），而挂在外面的话它就不会被
          编辑器的 `overflow: hidden` 裁掉——菜单在窗口右下角弹出时正是这一条兜住它。
          ⚠️ 复用文件树那一个外壳（第三个宿主，理由见 `project/TreeMenu.tsx` 的文件头），
          `keepFocus` 是编辑器独有的要求：焦点落到菜单按钮上再还回去，那一下
          `contentDOM.focus()` 会让浏览器按旧选区滚动，表现是「折完了，视图跳到文件开头」 */}
      <Show when={editorMenu()}>
        {(m) => (
          <TreeMenu
            x={m().x}
            y={m().y}
            items={editorMenuItems(m().pane)}
            onPick={(action) => onEditorMenuPick(m().pane, action)}
            onClose={() => setEditorMenu(null)}
            keepFocus
          />
        )}
      </Show>
    </div>
  )
}
