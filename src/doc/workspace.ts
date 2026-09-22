import { EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { indentUnit, type LanguageSupport } from '@codemirror/language'
import { batch, createSignal, type Accessor, type Setter } from 'solid-js'
import { open as pickToOpen } from '@tauri-apps/plugin-dialog'
import type { EditorController } from '../editor/controller'
import { languageFor, loadSupport, sameLanguage, type LanguageChoice } from '../editor/language'
import type { PasteImageHook } from '../editor/paste'
import { INDENT_UNIT, indentLabel, languageExtensions } from '../editor/setup'
import { MAX_SESSION_TABS, SESSION_VERSION, type Session, type SessionTab } from '../ipc/session'
import {
  applyViewConfig,
  createTab,
  createViewConfig,
  replaceTabText,
  tabText,
  type Tab,
  type TabHost,
  type ViewConfig,
} from './tab'

/**
 * 工作区：标签的集合 + 分屏的集合 + 两者之间「谁显示谁」的关系。
 *
 * **模型是扁平的**：`panes` 是一排分屏，`direction` 决定它们横着排还是竖着排，
 * 最多 `MAX_PANES` 个。刻意不做 VS Code 那种嵌套分组（左右各再上下分）——
 * 那要求一棵布局树、每个节点各自的方向与比例，而轻量编辑器里真正高频的只有
 * 「左右并排看两个文件」与「上下对照」。扁平模型下这两个都是一次点击。
 *
 * **两条不变量**：
 * 1. `tabs()` 永远非空，`panes()` 也永远非空。允许「零」的话所有 `editor.*` 命令的 `when`
 *    会同时失效、状态栏没有可显示的对象、`activeTab()` 变成 nullable 并传染给每一个调用点。
 * 2. **一个标签同时只显示在一个分屏里**（可以有标签谁都不显示，比如它的分屏被合并掉了）。
 *    允许两个分屏显示同一个标签的话，`Tab.snapshot` 就不再是「没显示时的唯一真相」，
 *    撤销历史与滚动位置也会分叉成两份。
 *
 * **为什么用 `createSignal` 而不是 `createStore`**：Tab 里揣着 CM6 的 `EditorState` 与
 * `Compartment`。store 会把嵌套的普通对象包成代理，而 CM6 到处靠 `===` 比较 state 与
 * 扩展对象（`Compartment` 的寻址、`updateListener` 的去重）。signal 只替换数组本身、
 * 不动元素，是这里唯一安全的选择。分屏同理，而且 `<For>` 要靠元素引用稳定来决定
 * 「哪一行是新增的」——引用一换，整块编辑器就会被重建。
 */

/**
 * 状态栏要报的度量。**只反映聚焦分屏显示的那个标签**，不是全文档的汇总。
 *
 * 行列从 1 开始（这是给人看的，不是给算法用的），列按**字符**计而不是按字素：
 * 与 CM6 自己的 `lineAt`/偏移量口径一致，一个 emoji 会算成 2 列。要按字素就得
 * 引入 grapheme 分段，而状态栏的列号没人拿它做精确排版。
 */
export interface DocMetrics {
  lines: number
  chars: number
  /** 主光标所在行 */
  line: number
  /** 主光标所在列 */
  col: number
  /** 选区个数。1 = 只有一个光标、没选中任何内容 */
  selections: number
  /** 所有选区加起来的字符数 */
  selectedChars: number
  /** 缩进设置的展示名，如「2 空格」/「Tab」 */
  indent: string
}

/** 还没有任何编辑器挂上来时的度量：空文档 = 1 行 0 字符，光标在 1:1 */
const EMPTY_METRICS: DocMetrics = {
  lines: 1,
  chars: 0,
  line: 1,
  col: 1,
  selections: 1,
  selectedChars: 0,
  indent: indentLabel(INDENT_UNIT),
}

/** 面对「有未保存的改动」时的三条出路 */
export type DiscardDecision = 'save' | 'discard' | 'cancel'

/**
 * 问用户怎么处理未保存的改动。`names` 是待决文档的显示名，一个（关标签）或多个（关窗口）。
 *
 * 由宿主注入而不是在这里直接调对话框：这一层不该知道 UI 长什么样，而且原生对话框
 * 在 jsdom 里只能被 mock 掉——注入之后整条「保存 / 不保存 / 取消」的分支才真的可测。
 */
export type DiscardPrompt = (names: string[]) => Promise<DiscardDecision>

/** `row` = 左右并排，`column` = 上下堆叠 */
export type SplitDirection = 'row' | 'column'

/** 分屏数量的上限。再多每块都窄得没法用，而扁平模型也没有嵌套的余地 */
export const MAX_PANES = 4

/**
 * MRU（最近打开过的文件）最多记多少条。与 `vela_core::project::index::MAX_RECENT`
 * **同值**，两边各有一条测试钉住那个数字（那边是 `最近清单的长度上限与前端同值`）。
 *
 * 50 条的依据是 `Cmd+P` 一次只回 50 条（Rust 侧的 `QUERY_LIMIT`）：MRU 的用途就是在
 * 空查询与短查询里把「刚才那几个」顶上来，超过一屏的部分永远排不进结果，记了也白带。
 *
 * ⚠️ 上限只归**这里**：Rust 侧的 `Session::validate` 不看 `recent`、也不截断它，
 * 与 `SessionRoot.expanded` 的 `MAX_RESTORED_EXPANDED` 同一套分工——
 * 两边各截一次的结果是谁也说不清最终有多少条。
 */
export const MAX_RECENT = 50

/**
 * 一块可见编辑区。
 *
 * `tabId` 是 Accessor 而不是普通字段：标签条要拿它判断「哪个标签是活动的」，
 * 而活动标签正是聚焦分屏显示的那个。用普通字段的话这次变更不会触发任何重渲染。
 */
export interface Pane {
  readonly id: number
  readonly tabId: Accessor<number>
  /** 编辑器实例。挂载前与销毁后是 null */
  readonly controller: EditorController | null
}

/** Pane 的可写形态，只在 workspace 内部流转 */
interface PaneRecord extends Pane {
  readonly setTabId: Setter<number>
  controller: EditorController | null
}

export interface Workspace {
  readonly tabs: Accessor<Tab[]>
  readonly panes: Accessor<Pane[]>
  readonly direction: Accessor<SplitDirection>
  readonly focusedPaneId: Accessor<number>
  /** 永远有值（见上面的不变量）：聚焦分屏正在显示的那个标签 */
  readonly activeTab: Accessor<Tab>
  readonly activeIndex: Accessor<number>
  readonly lineWrap: Accessor<boolean>
  /** 当前 CM6 是不是暗色（M4-C）。与 `lineWrap` 同为全局视图设置的响应式镜像 */
  readonly dark: Accessor<boolean>
  /** 状态栏要的度量。只反映**聚焦分屏**显示的那个标签 */
  readonly metrics: Accessor<DocMetrics>
  /**
   * 正文改了几次。单调递增，只涨不落，数值本身没有意义——它是一个**变更信号**（M3-A）。
   *
   * 为什么不是复用 `metrics`：那个信号在**光标移动**时也会换引用（行列与选区在它上面），
   * 而它的消费者是「正文变了就得重算」的那些东西——Markdown 预览、将来的字数统计。
   * 拿 `metrics` 当触发器的后果是每按一下方向键就把整份文档重新解析渲染一遍，
   * 而这类退化的表现是「打字还行，挪光标就卡」，很难往「触发条件太宽」上想。
   *
   * ⚠️ 口径是**任何标签**的正文变化都涨，不只是聚焦那个。多算的那几次由消费方自己挡：
   * 正文没变时渲染结果逐字节相同，而预览那边有一道「HTML 一样就不碰 DOM」的闸
   * （见 `src/md/MarkdownPreview.tsx`），代价只是一次解析。收窄成「只涨聚焦那个」的话，
   * 外部改动静默重载了一个**没在看的**标签、用户随后切过去——那一路计数器一次都没动过，
   * 而预览必须重算。少涨一次的失败方式是「切过去看到的还是上一份文档的渲染结果」，
   * 而这恰好也是这个信号最难查的一种错：它不报错，只是旧
   */
  readonly revision: Accessor<number>
  /**
   * 最近打开过的文件的**绝对路径**，最新的在最前面，最多 `MAX_RECENT` 条（M2-E）。
   *
   * 给 `Cmd+P` 用：`query_project` 把它整份递给 Rust，那边按位置给前几名加分。
   * 前端自己不拿它做任何过滤或排序。
   *
   * ⚠️ 记的是「成为用户正在看的那一个」，不是「还开着」——关掉的也算，
   * 否则这份清单就退化成 `tabs` 的第二份抄写，而那种情况 `Cmd+P` 用不着它。
   */
  readonly recent: Accessor<string[]>
  /** 命令中心的 `ctx.editor` 就是这个。没有分屏挂着编辑器时是 null */
  focusedEditor: () => EditorController | null
  /**
   * 反查：这个编辑器实例此刻显示的是哪个标签（M3-A-7）。
   *
   * 存在的理由是「**谁收到事件，就改谁**」：CM6 的 paste 处理器递过来的是那个 view，
   * 而粘贴落地要的是它正在显示的那份文档的路径。用 `activeTab()` 代替是一次
   * 跨信号的间接推断，在分屏 + 焦点切换的时序下并不总与事件目标一致。
   *
   * 返回 `null` 表示这个实例已经不属于任何分屏（正在被 destroy），那时什么都不该做。
   */
  tabOfView: (view: EditorView) => Tab | null
  /**
   * `focusedEditor()` 的**响应式**孪生（M3-A-3）。
   *
   * 🔴 差别只有一件事：这一个额外读了 `attachedAt()` 与那块分屏的 `tabId()`，于是在
   * `createEffect` / JSX 里读它**会订阅**「编辑器实例挂上来了／摘下去了」与
   * 「这块分屏换了标签」两件事。`focusedEditor()` 两个都不读——`attach` 把实例写进的是
   * `PaneRecord` 上一个普通可变字段，那一下不触发任何信号，所以在 effect 里读它
   * 什么都等不到。`registry` 那条注释里「命令面板落地时要改成订阅」指的就是这件事。
   *
   * ⛔ 别把两个合并成一个。它们现在长得几乎一样，差别全在「读了哪些信号」上，
   * 而合并之后命令中心每次 `execute` 都会顺手订阅一遍 `attachedAt`，
   * 命令面板算 `enabled` 时也一样。多出来的重跑不报错、结果也对，只是白跑——
   * 而「这个 effect 为什么又跑了一遍」是这类代码里最难查的一种问题。
   */
  readonly focusedView: Accessor<EditorController | null>
  /** 编辑器实例挂上来时由 `EditorPane` 的 onReady 调用 */
  attach: (paneId: number, controller: EditorController) => void
  detach: (paneId: number) => void
  focusPane: (paneId: number) => void
  /** 加一块分屏并把整排的方向定成 `direction`。已到上限时只改方向 */
  split: (direction: SplitDirection) => void
  /** 合并掉一块分屏。它显示的标签留在标签条上，只是不再被任何分屏显示 */
  closePane: (paneId: number) => void
  /** 循环聚焦：n 为正往后、为负往前 */
  cyclePane: (step: number) => void
  newTab: () => Tab
  openViaDialog: () => Promise<void>
  /** 打开一个已知路径。「最近文件」与拖拽落文件都走这里 */
  openAt: (path: string) => Promise<void>
  /** 脏标签会先弹确认；用户选「取消」或保存没成功时，标签留在原处 */
  closeTab: (id: number) => Promise<void>
  /** 标签已经在某个分屏里显示时聚焦那个分屏，否则把它装进聚焦的分屏 */
  activateTab: (id: number) => void
  /** 拖拽重排：把 dragged 挪到 target 原来的位置上 */
  reorder: (draggedId: number, targetId: number) => void
  save: () => Promise<void>
  saveAs: () => Promise<void>
  setLineWrap: (on: boolean) => void
  toggleLineWrap: () => void
  /** 切换 CM6 的深/浅色 facet（M4-C）。颜色的 `data-theme` 由 store 负责，两者要一起做 */
  setDarkTheme: (on: boolean) => void
  /** Cmd+滚轮缩放后通知所有显示中的 view dispatch 空 transaction，触发 measure 对齐行号 */
  notifyFontSizeChanged: () => void
  /** 有没有任何标签还没落盘 */
  anyDirty: () => boolean
  /**
   * 脏标签的**绝对路径**，原样：不 normalize、不解析符号链接、不管大小写。
   *
   * M2-D 全局替换把它递进 `ReplaceRequest.skip`，那里逐组件比 `Path` 相等，
   * 所以这里递的必须是后端给过的原样字符串（`doc.path()` 就是 `openFile` 收到的那个）。
   * 自己拼一个的后果是「少保护一个文件」——用户的未保存改动被落盘盖掉
   */
  dirtyPaths: () => string[]
  /**
   * 全局替换落盘之后的对账：把 `root` 底下那些标签重新读一遍。
   *
   * 不做这一步的话，编辑器里显示的仍是**替换之前**的内容，而用户下一次 ⌘S
   * 会把刚落盘的结果又盖回去——一次替换等于没发生过，还搭进去一个新写入。
   *
   * @returns 正文真的换过了的标签数（脏的、内容没变的都不算）
   */
  reloadUnder: (root: string) => Promise<number>
  /**
   * 窗口级关闭的总闸：Rust 侧拦下 CloseRequested / Cmd+Q 之后问这里。
   * 返回 true 表示「可以真的关了」，调用方负责去拆窗口（见 `src/ipc/windowClose.ts`）。
   */
  requestWindowClose: () => Promise<boolean>
  /** 把当前现场写成一份会话存档（M1-F）。**纯读**，不改任何状态 */
  serializeSession: () => Session
  /**
   * 用一份存档整个换掉当前现场。
   *
   * ⚠️ **只在启动时用一次**：它会扔掉现在开着的所有标签，而且不问未保存的改动。
   * 运行期「换一个会话」是另一件事（得先走 `requestWindowClose` 那套确认），不在这里做。
   */
  restoreSession: (session: Session) => Promise<void>
}

export interface WorkspaceOptions {
  lineWrap?: boolean
  /** 初始是不是暗色（M4-C）。缺省 `true` = 与 M4-C 之前逐像素一致 */
  dark?: boolean
  /**
   * 缺省时一律答「取消」。
   *
   * 这个默认值看着反常（关不掉标签），但另一头是**静默丢数据**：没接 UI 的时候
   * 宁可什么都别关，也不能让用户的一次点击把没存盘的稿子扔掉。
   */
  promptDiscard?: DiscardPrompt
  /**
   * 剪贴板里有一张图片时问谁（M3-A-7）。
   *
   * ⚠️ 钩子拿到的是**收到 paste 事件的那个 view**，而不是「当前活动标签」。
   * 要把它换回文档请用 [`Workspace.tabOfView`]，⛔ 不要用 `activeTab()`：
   * 后者读的是焦点跟踪的结果，两者在「焦点还没跟上」的时序下会不是同一个标签，
   * 于是图片落到隔壁文档的目录里，而链接插在另一个文档里——两边都错，而且错得对不上。
   */
  pasteImage?: PasteImageHook
  /**
   * Cmd/Ctrl+鼠标滚轮调整字号的回调。
   *
   * 参数是步进方向：`+1` = 放大（向上滚），`-1` = 缩小（向下滚）。
   * 由 settings store 统一管 sanitize + CSS 变量 + 写穿。
   */
  onFontSizeZoom?: (delta: number) => void
}

export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  // liveStates 声明在后面，但这里只是把引用存进 config，真正调用发生在补全请求时——
  // 那时 tabs 信号早就建好了，不会撞上 TDZ
  const config: ViewConfig = createViewConfig(
    options.lineWrap ?? true,
    liveStates,
    options.pasteImage,
    options.dark ?? true,
    options.onFontSizeZoom,
  )
  const promptDiscard: DiscardPrompt = options.promptDiscard ?? (async () => 'cancel')

  const [tabs, setTabs] = createSignal<Tab[]>([])
  const [panes, setPanes] = createSignal<PaneRecord[]>([])
  const [focusedPaneId, setFocusedPaneId] = createSignal(-1)
  const [direction, setDirection] = createSignal<SplitDirection>('row')
  const [wrap, setWrap] = createSignal(config.lineWrap)
  const [dark, setDark] = createSignal(config.dark)
  const [metrics, setMetrics] = createSignal<DocMetrics>(EMPTY_METRICS)
  const [revision, setRevision] = createSignal(0)
  /**
   * 「某块分屏的编辑器实例挂上来了／摘下去了」的痕迹。值没有意义，只是一个订阅点，
   * 存在的理由写在下面 `focusedView` 上。
   */
  const [attachedAt, setAttachedAt] = createSignal(0)
  /** MRU。写入只走 `remember`，恢复时被 `restoreSession` 整个换掉 */
  const [recent, setRecent] = createSignal<string[]>([])

  let nextTabId = 1
  let nextPaneId = 1

  function paneById(id: number): PaneRecord | undefined {
    return panes().find((p) => p.id === id)
  }

  /** 聚焦的那个分屏。永远有值，见文件头的不变量 */
  function focusedPane(): PaneRecord {
    const list = panes()
    return paneById(focusedPaneId()) ?? list[0]!
  }

  function paneOfTab(tabId: number): PaneRecord | undefined {
    return panes().find((p) => p.tabId() === tabId)
  }

  function tabById(id: number): Tab | undefined {
    return tabs().find((t) => t.id === id)
  }

  function activeTab(): Tab {
    return tabById(focusedPane().tabId()) ?? tabs()[0]!
  }

  /**
   * 显示某个标签的那个分屏的编辑器实例。
   *
   * 存在时 `view.state` 才是这个标签的最新状态——`snapshot` 只在切走的那一刻更新，
   * 显示期间它一直是旧的。读错来源会让「保存」写出旧内容。
   */
  function viewOf(tab: Tab): EditorController | null {
    return paneOfTab(tab.id)?.controller ?? null
  }

  /**
   * 所有标签**活的** state，给词补全当「其他打开的文档」。
   *
   * 口径与 `syncMetrics` / `host.getText` 是同一条：显示中的标签读 `view.state`，
   * 没显示的读 `snapshot.state`。读错来源的后果在这里是「补全给出的是切走那一刻的
   * 旧词」——不致命，但正打字的那份文档如果读成 snapshot，刚敲进去的词一个都补不出来。
   */
  function liveStates(): EditorState[] {
    return tabs().map((tab) => viewOf(tab)?.view.state ?? tab.snapshot.state)
  }

  /**
   * 涨一次正文变更计数。两个调用点：CM6 的事务（`makeTab` 的 `onUpdate`）与
   * 整个换掉正文的那一条（`host.setText`）。后者为什么必须单独涨，理由写在那里。
   */
  function bumpRevision() {
    setRevision((n) => n + 1)
  }

  function syncMetrics(tab: Tab) {
    const view = viewOf(tab)
    const state = view ? view.view.state : tab.snapshot.state
    const { main, ranges } = state.selection
    const line = state.doc.lineAt(main.head)
    let selectedChars = 0
    for (const range of ranges) selectedChars += range.to - range.from
    setMetrics({
      lines: state.doc.lines,
      chars: state.doc.length,
      line: line.number,
      col: main.head - line.from + 1,
      selections: ranges.length,
      selectedChars,
      indent: indentLabel(state.facet(indentUnit)),
    })
  }

  /**
   * 按标签当前的路径（以及必要时的内容）把语言装进它自己的槽位。
   *
   * 三个调用点：标签刚建好、`setText` 重建了 state（新 state 的槽位是空的）、
   * 路径变了（打开文件、另存为）。语言没变时直接返回——否则每次保存都会把所有
   * 标签的 state 对象换一遍，内容虽然没变，但靠 `===` 判断「state 没动过」的地方会失准。
   */
  function syncLanguage(tab: Tab) {
    // 取当前内容，供 languageFor 做内容检测（无扩展名时判断是否像 JSON）
    // ⚠️ 显示中的标签内容在 view.state.doc 里，不在 snapshot 里
    const content = viewOf(tab)?.view.state.doc.toString() ?? tabText(tab)
    const choice = languageFor(tab.doc.path(), content)
    if (tab.language !== null && sameLanguage(tab.language, choice)) return
    tab.language = choice
    // 代号先自增再发请求：加载回来时对不上就说明期间又换过语言，那次结果必须丢掉。
    // 不丢的话，快速连开两个文件会让前一个文件的语法树盖到后一个上
    const token = ++tab.languageToken
    installLanguage(tab, choice, null)
    if (choice.description === null) return
    void loadSupport(choice).then((support) => {
      if (support === null || token !== tab.languageToken) return
      installLanguage(tab, choice, support)
    })
  }

  /** 显示中的走 dispatch，没显示的走 state.update——与 `setLineWrap` 同一套路 */
  function installLanguage(tab: Tab, choice: LanguageChoice, support: LanguageSupport | null) {
    const effects = tab.languageSlot.reconfigure(languageExtensions(choice, support))
    const view = viewOf(tab)
    if (view) view.view.dispatch({ effects })
    else tab.snapshot = { ...tab.snapshot, state: tab.snapshot.state.update({ effects }).state }
  }

  /**
   * 标签要的四个宿主能力。全都要先回答「这个标签此刻显示在哪个分屏里」，
   * 所以只能由 workspace 来实现、再反向注入给 `createTab`。
   */
  const host: TabHost = {
    getText: (tab) => viewOf(tab)?.view.state.doc.toString() ?? tabText(tab),
    setText: (tab, text) => {
      replaceTabText(tab, text, config)
      // 显示中的标签光改 snapshot 没用：屏幕上是 view 的 state，得整个换掉
      viewOf(tab)?.restore(tab.snapshot)
      // 必须在 restore 之后：重建把语言槽位清空了（见 replaceTabText），而显示中的标签
      // 走 dispatch、dispatch 不回写 snapshot。先装语言再 restore 的话，restore 用的
      // 还是那个没装语言的 snapshot，语言会被整个冲掉
      syncLanguage(tab)
      if (tab.id === activeTab().id) syncMetrics(tab)
      // 🔴 这一路**必须**手动涨一次。`replaceTabText` 之后走的是 `restore` → `view.setState`，
      // 而 CM6 的 `setState` 不经过 dispatch，**不触发 updateListener**——下面 `makeTab`
      // 里那一次自动涨不会发生。漏掉它的症状是「外部改了文件，编辑器里的正文换了，
      // 旁边的预览还是旧的」，而那正是 M2-G 静默重载最常走的一条路
      bumpRevision()
    },
    focus: (tab) => {
      viewOf(tab)?.focus()
    },
    pathChanged: (tab) => {
      syncLanguage(tab)
    },
  }

  function makeTab(text = ''): Tab {
    const tab: Tab = createTab({
      id: nextTabId++,
      text,
      config,
      host,
      onUpdate: (info) => {
        if (info.docChanged) {
          // 脏标记只认正文变化：光标移动不该让文件变成「未保存」
          tab.doc.markChanged()
          // 变更计数同一条口径。⚠️ 它必须只认 `docChanged`：跟着选区一起涨的话，
          // 这个信号就退化成 `metrics` 了，而 M3-A 加它的全部理由就是不要那样
          bumpRevision()
          // 无路径的新建标签：如果内容现在看起来像 JSON，尝试切换语言
          if (tab.doc.path() === null) {
            syncLanguage(tab)
          }
        }
        // 只有正在显示的那个标签会收到事务（没显示在任何分屏里的标签没有 view，
        // 压根不产生 update），但度量属于状态栏，状态栏只跟着聚焦的分屏走，所以还是要判一次。
        // 走 syncMetrics 而不是直接用 info 带的那两个数：行列与选区只有 state 上有
        if (tab.id === activeTab().id) syncMetrics(tab)
      },
    })
    // 新标签没有路径 → Markdown（M1-E 之前全局 markdownMode = true 就是这个行为）
    syncLanguage(tab)
    return tab
  }

  function makePane(tabId: number): PaneRecord {
    const [id, setId] = createSignal(tabId)
    return { id: nextPaneId++, tabId: id, setTabId: setId, controller: null }
  }

  /** 把分屏里那份现场存回标签，之后 view 就可以去显示别的东西了 */
  function capture(pane: PaneRecord) {
    const tab = tabById(pane.tabId())
    if (tab && pane.controller) tab.snapshot = pane.controller.capture()
  }

  /**
   * 让一个分屏改显示另一个标签：先把当前标签的现场存回去，再把目标标签装进来。
   *
   * `capture` 必须在 `restore` 之前——反过来就是拿目标标签的 state 覆盖掉当前标签
   * 还没存盘的最后一次编辑。
   *
   * 🔴 整段包在 `batch` 里，因为 `pane.setTabId` 是一次**信号写入**：不包的话它当场就把
   * 订阅者刷一遍，而那时 `restore` 还没跑，订阅者看到的是「新标签 id + 上一份文档的正文」
   * 这么一个撕裂的现场。预览面板正好踩在这一条上——它的 effect 读 `tabId()` 判定
   * 「换标签了，立刻重渲染」，然后从 `view.state` 里读出**上一个**标签的正文渲染出来；
   * 而 `restore` 走的是 `view.setState`，不触发 CM6 的 updateListener（同 `host.setText`
   * 里那条注释），于是没有任何东西会再叫它一遍，预览就永远停在上一份文档上。
   * 度量那一路看不见这个 bug：`syncMetrics(next)` 是把 `next` **显式**递进去的。
   */
  function showIn(pane: PaneRecord, next: Tab) {
    if (pane.tabId() === next.id) return
    batch(() => {
      capture(pane)
      pane.setTabId(next.id)
      pane.controller?.restore(next.snapshot)
      if (pane.id === focusedPaneId()) syncMetrics(next)
    })
  }

  function attach(paneId: number, controller: EditorController) {
    const pane = paneById(paneId)
    if (!pane) return
    pane.controller = controller
    // 视图就是用这个标签的 state 挂起来的，不需要 restore（那会把一个全新视图的 docView
    // 拆了重建）；但滚动位置得补上——会话恢复出来的标签带着非零滚动，新 view 是从 0 起的
    const tab = tabById(pane.tabId())
    if (tab) controller.applyScroll(tab.snapshot)
    if (paneId === focusedPaneId()) {
      syncMetrics(activeTab())
      // 聚焦的那块要真的能打字。`split` 里的 `focusPane` 跑的时候新分屏的 controller
      // 还是 null，那一次 `controller?.focus()` 是静默空操作——不补这一下，
      // 启动、恢复、新建分屏之后都得让用户先点一下编辑器才能开始打字
      controller.focus()
    }
    // ⚠️ 放在最后：这一下会让所有订阅 `focusedView` 的东西同步重跑，而它们要读的是
    // 一个**已经装好滚动位置、已经拿到焦点**的实例。放在赋值那一行后面的话，
    // 预览会先按 `scrollTop = 0` 对齐一次，紧接着又被 applyScroll 触发的滚动事件拉回来
    setAttachedAt((n) => n + 1)
  }

  function detach(paneId: number) {
    const pane = paneById(paneId)
    if (!pane) return
    // 现场先存回标签：controller 马上就要被 destroy，之后 snapshot 是唯一的真相
    capture(pane)
    pane.controller = null
    setAttachedAt((n) => n + 1)
  }

  function focusPane(paneId: number) {
    const pane = paneById(paneId)
    if (!pane) return
    // 幂等：点一下已经聚焦的分屏也会走到这里（DOM 的 focusin），不该白刷一遍度量
    if (paneId !== focusedPaneId()) {
      setFocusedPaneId(paneId)
      syncMetrics(activeTab())
    }
    pane.controller?.focus()
  }

  function cyclePane(step: number) {
    const list = panes()
    if (list.length < 2) return
    const at = list.findIndex((p) => p.id === focusedPaneId())
    const next = list[(at + step + list.length * 2) % list.length]!
    focusPane(next.id)
  }

  function split(splitDirection: SplitDirection) {
    setDirection(splitDirection)
    if (panes().length >= MAX_PANES) return
    // 新分屏装一个新空标签，而不是把当前标签复制过去：一个标签只能显示在一个分屏里
    // （见文件头的不变量 2）。要对照两个文件的话，在新分屏里打开另一个就是。
    const tab = makeTab()
    setTabs([...tabs(), tab])
    const pane = makePane(tab.id)
    setPanes([...panes(), pane])
    focusPane(pane.id)
  }

  function closePane(paneId: number) {
    if (panes().length <= 1) return
    const victim = paneById(paneId)
    if (!victim) return
    // 现场先存回标签：分屏一没，Solid 就会卸载 EditorPane 并 destroy 掉那个 view
    capture(victim)
    const rest = panes().filter((p) => p.id !== paneId)
    setPanes(rest)
    if (paneId === focusedPaneId()) focusPane(rest[rest.length - 1]!.id)
  }

  function newTab(): Tab {
    const tab = makeTab()
    setTabs([...tabs(), tab])
    showIn(focusedPane(), tab)
    return tab
  }

  /**
   * 记一笔 MRU。规矩是「**一个带路径的文档成为用户正在看的那一个**」，
   * 于是四个地方调它：`openAt` 的两条真开分支、`activateTab`、`save` / `saveAs`。
   *
   * 收 `string | null` 而不是 `string`：调用点手上拿着的是 `doc.path()`，
   * 而它**就是**「打开成功了没有」的判据——`document.ts` 的 `openAt` 失败时不抛，
   * 只把错误挂在那个标签自己的 notice 上。让调用点先判一次 null 等于把这条判据
   * 抄四份，哪天有一处忘了，MRU 里就会多出一个打不开的路径。
   */
  function remember(path: string | null) {
    if (path === null) return
    const list = recent()
    // 已经排在第一就一个字都不写。⌘S 是个高频动作，而每次写 signal 都会捅一下
    // 会话自动保存的节流器（`sessionSync`）——为一个没有变化的清单触发一轮序列化不值
    if (list[0] === path) return
    setRecent([path, ...list.filter((p) => p !== path)].slice(0, MAX_RECENT))
  }

  function activateTab(id: number) {
    const tab = tabById(id)
    if (!tab) return
    // 放在两条分支**之前**：「聚焦那个已经在显示它的分屏」与「把它装进聚焦的分屏」
    // 在 MRU 看来是同一件事——用户现在看的是它
    remember(tab.doc.path())
    // 已经在某个分屏里显示 → 聚焦那个分屏，而不是把它从那边搬过来：
    // 搬走会让那个分屏空掉，而「一个标签只能显示在一个分屏里」也不允许它同时留在两处
    const owner = paneOfTab(id)
    if (owner) {
      focusPane(owner.id)
      return
    }
    showIn(focusedPane(), tab)
  }

  /**
   * 对一批脏文档跑一遍「保存 / 不保存 / 取消」，返回 true 表示可以继续关闭。
   *
   * `save` 分支里逐个检查脏标记：写盘失败会让 `document.ts` 把脏标记留着，
   * 无名文档的 `save` 还会落到另存为、而用户可能取消那个对话框。两种情况都必须
   * 中止关闭——否则「点了保存」和「没保存」在用户眼里是同一件事。
   */
  async function settle(dirty: Tab[]): Promise<boolean> {
    if (dirty.length === 0) return true
    const decision = await promptDiscard(dirty.map((t) => t.doc.name()))
    if (decision === 'cancel') return false
    if (decision === 'discard') {
      // 「不保存」= 这些改动不要了。M1-F 之后光放着不管是不够的：会话存档收草稿的
      // 条件就是「脏」，不把它们清干净，用户刚刚明确扔掉的稿子下次启动会原样回来
      for (const tab of dirty) tab.doc.discardChanges()
      return true
    }
    for (const tab of dirty) {
      await tab.doc.save()
      if (tab.doc.dirty()) return false
    }
    return true
  }

  /** 真正把标签摘掉：先从标签条上拿掉并给空出来的分屏换一个标签，最后还 fd */
  function dropTab(id: number) {
    const doomed = tabById(id)
    if (!doomed) return
    removeFromList(id)
    // 🔴 分片的 fd 在这儿还回去，而顺序必须是**先从标签表里摘掉，再还**。反过来的话
    // `releaseShard()` 把 `doc.shard()` 置回 null 的那一刻，这个标签**还在** `tabs()` 里，
    // 于是 `fileWatch.currentPaths()` 会把它当成一个普通内联标签送进清单——
    // Rust 侧白白订一次目录又立刻退订。更要紧的是同一段窗口里真来了一条外部改动事件的话，
    // `onEvent` 看见的是「干净的内联标签」，于是 `reload` → 撞 too_large → **再开一个分片**，
    // 而那个新 fd 挂在一个已经被摘掉的标签上，永远没人 dispose。
    //
    // 这个标签从此再没有任何引用，而 Rust 侧那个句柄不会因为没人再提它就自己关掉
    // （见 `ipc/shard.ts` 的 `closeLarge`）。
    // ⚠️ 刻意放在 `dropTab` 而不是 `ShardPane` 的 onCleanup：换标签也会卸载那个组件，
    // 而分片必须活到标签真的关掉为止（理由写在 `ShardPane.tsx` 的模块文档里）
    doomed.doc.releaseShard()
  }

  /**
   * 把标签从标签条上摘掉，并给显示着它的那块分屏换一个标签显示。不碰任何 fd。
   *
   * 换谁：右邻居优先，但**只能挑一个没在别的分屏里显示着的**——否则两块分屏会显示同一个
   * 标签，正是文件头不变量 2 排除的情况（`snapshot` 不再是「没显示时的唯一真相」）。
   * 一个都挑不出来时就补一个空标签：宁可标签条上多一个「空文档」，也不能让现场分叉。
   */
  function removeFromList(id: number) {
    // 🔴 整个函数体裹在 `batch` 里，因为中间那几步会短暂造出「某块分屏显示的标签不在
    // `tabs()` 里」的状态：`setTabs` 已经把它摘掉了，而 `showIn` 还没给那块分屏换上新标签。
    //
    // 这个窗口从前没人看得见——`EditorPane` 只在 `onMount` 读一次 props，换标签不重挂。
    // 但 M2-H 之后 `App.tsx` 在每块分屏外面套了一层 `<Show when={shardOf(pane)}>`：
    // `shardOf` 查不到标签就返回 null，于是关掉一个**分片**标签的那一瞬间，那块分屏从
    // 「只读分片」翻成 fallback，真的去挂一个新的 `EditorPane`，而 `paneState` 里那句
    // `tabs().find(...)!` 当场炸——`!` 的前提是「分屏新建时它的标签一定已经在 `tabs()` 里」
    // （见 workspace 的 `split`），中间态正好破坏这条前提。
    //
    // 而炸点在 `closeTab` 这个 async 函数体内，所以它变成一个没人接的 rejected promise：
    // `dropTab` 后半句的 `releaseShard()` 再也跑不到，那个 fd 就这么漏了，一点声音都没有。
    batch(() => {
      const list = tabs()
      const index = list.findIndex((t) => t.id === id)
      if (index < 0) return
      const rest = list.filter((t) => t.id !== id)

      // 关掉最后一个 = 换一个空标签进来（见文件头的不变量）。
      // 此时必然只剩一块分屏：分屏数永远 ≤ 标签数（split 一次同时加一个标签和一块分屏，
      // closePane 只减分屏不减标签），所以标签只剩一个时分屏也只剩一块。
      if (rest.length === 0) {
        const fresh = makeTab()
        setTabs([fresh])
        const only = panes()[0]!
        showIn(only, fresh)
        focusPane(only.id)
        return
      }

      const victim = paneOfTab(id)
      // 这个标签谁都没显示（比如它的分屏刚被合并掉），那就只是从标签条上摘掉
      if (!victim) {
        setTabs(rest)
        return
      }

      const elsewhere = new Set(
        panes()
          .filter((p) => p.id !== victim.id)
          .map((p) => p.tabId()),
      )
      const free = rest.filter((t) => !elsewhere.has(t.id))
      if (free.length === 0) {
        const fresh = makeTab()
        setTabs([...rest, fresh])
        showIn(victim, fresh)
        return
      }
      setTabs(rest)
      // 摘掉第 i 个之后，原来的第 i+1 个正好落到 `free` 的下标 i 上；
      // 关掉的是最后一个（或右邻居都被别的分屏占着）时退回末尾
      showIn(victim, free[Math.min(index, free.length - 1)]!)
    })
  }

  async function closeTab(id: number) {
    const tab = tabById(id)
    if (!tab) return
    // 干净标签的快路径。写成同步不是为了省那点开销，而是为了让「点一下 × 标签就没了」
    // 这件事在一次事件循环里完成——异步的话调用方全都要 await，测试也一样。
    if (!tab.doc.dirty()) {
      dropTab(id)
      return
    }
    if (await settle([tab])) dropTab(id)
  }

  function reorder(draggedId: number, targetId: number) {
    if (draggedId === targetId) return
    const list = [...tabs()]
    const from = list.findIndex((t) => t.id === draggedId)
    const to = list.findIndex((t) => t.id === targetId)
    if (from < 0 || to < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved!)
    setTabs(list)
  }

  async function openAt(path: string) {
    // 同一个文件只开一个标签：再开一次不但会丢掉已有的未保存改动，
    // 还会让用户在两份内容里猜哪份是真的
    const existing = tabs().find((t) => t.doc.path() === path)
    if (existing) {
      activateTab(existing.id)
      return
    }
    const active = activeTab()
    // 干净的无名标签就地复用：不然「新建 → 打开」这套动作每来一次就多一个空标签，
    // 标签条很快全是没用的「空文档」
    if (active.doc.path() === null && !active.doc.dirty()) {
      await active.doc.openAt(path)
      // 递 `doc.path()` 而不是形参 `path`：打开失败时前者是 null，`remember` 自己就不动。
      // 这条分支不经过 `activateTab`（标签本来就是活动的那个），所以得自己记一笔
      remember(active.doc.path())
      return
    }
    const tab = newTab()
    await tab.doc.openAt(path)
    remember(tab.doc.path())
  }

  async function openViaDialog() {
    // 不设扩展名过滤器：编辑器要能打开 LICENSE、Makefile、无后缀的配置文件，
    // 过滤器只会让人以为文件不存在
    const picked = await pickToOpen({ multiple: false, directory: false })
    if (typeof picked === 'string') await openAt(picked)
  }

  function setLineWrap(on: boolean) {
    if (on === config.lineWrap) return
    config.lineWrap = on
    setWrap(on)
    const effects = config.lineWrapSlot.reconfigure(on ? [EditorView.lineWrapping] : [])
    // 显示中的那些走 dispatch：setState 会销毁并重建所有视图插件，焦点与滚动位置都会丢。
    // 其余标签没有 view 可 dispatch，只能就地 update 出一个新 state——
    // 这正是「state 能脱离 view 存活」换来的好处。
    for (const pane of panes()) pane.controller?.view.dispatch({ effects })
    for (const tab of tabs()) {
      if (!viewOf(tab)) applyViewConfig(tab, config)
    }
  }

  /**
   * 切换 CM6 的深/浅色 facet（M4-C）。与 `setLineWrap` 是同一个模子：改 `config.dark`、
   * 拨共享的 `darkSlot`、显示中的分屏走 dispatch、没在显示的标签就地 update。
   *
   * 🔴 这一条只管 CM6 base theme 里那些 `&dark` 规则（光标色、选区色、gutter 底、补全/查找
   * 面板底）。`--vela-*` 那套颜色由 `settings/store.ts` 写 `<html data-theme>` 属性来切，
   * 两件事**必须一起做**（见 `App.tsx` 的接线）：少了 `data-theme` 这一步，颜色还是旧的；
   * 少了这一步，CM6 的内部件会用反。
   */
  function setDarkTheme(on: boolean) {
    if (on === config.dark) return
    config.dark = on
    setDark(on)
    const effects = config.darkSlot.reconfigure(EditorView.darkTheme.of(on))
    for (const pane of panes()) pane.controller?.view.dispatch({ effects })
    for (const tab of tabs()) {
      if (!viewOf(tab)) applyViewConfig(tab, config)
    }
  }

  /**
   * Cmd+滚轮缩放后通知所有显示中的 view 重新测量行号 gutter。
   *
   * CSS 变量已更新，但 CM6 的行号 gutter 需要一次 measure 才能重新对齐字号。
   * 用 requestAnimationFrame 等一帧，确保 CSS 变量已经应用到 DOM（浏览器完成样式计算），
   * 再 dispatch 空 transaction 触发 measure。没显示中的 tab 下次切回来时 applyViewConfig 会自然对齐。
   */
  function notifyFontSizeChanged(): void {
    // 等一帧让 CSS 变量生效，再触发 CM6 measure
    window.requestAnimationFrame(() => {
      for (const pane of panes()) {
        pane.controller?.view.dispatch({})
      }
    })
  }

  /**
   * 要存进会话的标签。超出 `MAX_SESSION_TABS` 时从后面截断，但**正在显示的标签一个都不丢**。
   *
   * 丢一个显示中的标签会让 `panes` 里的一个下标悬空，而 Rust 侧的 `validate` 会因此
   * 拒掉**整份**存档——为了少存几个标签把整个会话弄没了，是最坏的一笔交换。
   */
  function tabsForSession(): Tab[] {
    const list = tabs()
    if (list.length <= MAX_SESSION_TABS) return list
    const shown = new Set(panes().map((p) => p.tabId()))
    const budget = MAX_SESSION_TABS - shown.size
    const kept: Tab[] = []
    // 按原顺序遍历，于是 kept 也是原顺序：截断不该把标签条的顺序打乱
    for (const tab of list) {
      if (shown.has(tab.id) || kept.length < budget) kept.push(tab)
    }
    return kept
  }

  function serializeTab(tab: Tab): SessionTab {
    // 活的现场。显示中的标签 `snapshot` 是**旧的**（只在切走那一刻更新），必须读 view
    const live = viewOf(tab)?.capture() ?? tab.snapshot
    const { state } = live
    const path = tab.doc.path()
    const dirty = tab.doc.dirty()
    // ⚠️ 只读分片标签**不需要任何特殊处理**，这是 M2-H 特意换来的：它干净、有路径、
    // 正文是空的 → `draft` 落成 null → 恢复时走「干净又有路径就重新读盘」那一条 →
    // `doc.openAt` 再撞一次 `too_large` → 自动改走分片。存档格式一个字都没改。
    // 代价是滚动位置与选区恢复不回来（那份 `snapshot` 属于那个空 buffer，
    // 而分片的滚动条压根不在 CM6 手里）——一个 100 MB 的日志重开在第 1 行是可以接受的
    return {
      path,
      format: tab.doc.format(),
      dirty,
      lossy: tab.doc.lossy(),
      // 干净且有路径的标签不存正文：Vela 关着的时候文件可能被别的程序改过，
      // 恢复时重新读盘才是对的。存了反而会在恢复时把用户的文件悄悄回退
      draft: dirty || path === null ? state.doc.toString() : null,
      // 存整个选区数组而不是一个光标：M1-C 把多光标做成了一等公民，
      // 恢复时把 5 个光标变成 1 个是明显的手感倒退
      selection: state.selection.ranges.map((r): [number, number] => [r.anchor, r.head]),
      main: state.selection.mainIndex,
      scrollTop: live.scrollTop,
      scrollLeft: live.scrollLeft,
    }
  }

  function serializeSession(): Session {
    const list = tabsForSession()
    const indexOf = new Map<number, number>()
    list.forEach((tab, i) => indexOf.set(tab.id, i))
    const paneList = panes()
    return {
      version: SESSION_VERSION,
      direction: direction(),
      // 夹到 0：`findIndex` 落空时返回 -1，而 -1 对 serde 的 `usize` 是非法值，
      // 整份存档会解析失败。`focusedPane()` 本来也是「找不到就退回第一块」这个口径
      focused: Math.max(
        0,
        paneList.findIndex((p) => p.id === focusedPaneId()),
      ),
      tabs: list.map(serializeTab),
      // 下标一定取得到：tabsForSession 保证了显示中的标签一个都没被截掉
      panes: paneList.map((p) => indexOf.get(p.tabId())!),
      // 这一格永远是 null，由 `sessionSync` 从项目树那边覆盖掉。
      //
      // 不在这里填是因为 workspace **不知道项目树存在**：树管「磁盘上有什么」，
      // 这里管「打开了哪些标签」，两层是独立状态（`src/project/store.ts` 也不 import
      // 本模块，否则两边成环）。返回类型仍然是完整的 `Session` 而不是 `Omit<…,'project'>`：
      // `project: null` 本身就是一个合法的会话（= 没打开文件夹），而且
      // `restoreSession(serializeSession())` 这条往返在测试里用了七次，
      // 缺一个字段就得处处补，换来的只是把一句注释换成一个类型体操。
      project: null,
      // 与 `project` 相反，这一格**就是这里的真相**：MRU 记的是「看过哪些文档」，
      // 与项目树无关（关掉文件夹它照样留着），所以 `sessionSync` 不会来覆盖它
      recent: recent(),
      // 这一格与 `project` 同属「项目树那一半」，永远是空数组，由 `sessionSync` 覆盖掉。
      // 理由逐字同上：workspace 不知道文件夹的存在，而「最近项目」记的正是文件夹
      recentProjects: [],
    }
  }

  /**
   * 把存档里的光标与滚动位置装回一个标签的 snapshot。
   *
   * 只写 snapshot、不走 dispatch：调用它的时候这些标签**还没被任何分屏显示**
   * （`panes()` 里还是旧的那批记录），压根没有 view 可 dispatch。
   */
  function applyRestoredPosition(tab: Tab, saved: SessionTab) {
    const state = tab.snapshot.state
    const len = state.doc.length
    // 必须夹到文档长度以内：CM6 的 checkSelection 对越界位置直接抛 RangeError，
    // 而 Vela 关着的时候磁盘上的文件可能被截短了，存档里的光标位置就成了非法值。
    // 夹是单调的，所以选区之间的先后顺序不会被打乱
    const clamp = (n: number) => Math.min(Math.max(0, n), len)
    const ranges = saved.selection.map(([anchor, head]) => EditorSelection.range(clamp(anchor), clamp(head)))
    tab.snapshot = {
      // main 也夹一次：Rust 侧校验过，但 restoreSession 是公开方法，
      // 测试与将来的调用方都可能递进来一份手搓的存档
      state: state.update({ selection: EditorSelection.create(ranges, Math.min(saved.main, ranges.length - 1)) }).state,
      scrollTop: saved.scrollTop,
      scrollLeft: saved.scrollLeft,
    }
  }

  /**
   * 把所有还开着的分片关掉。两处调用：换掉整批标签之前（`restoreSession`），
   * 以及确认可以关窗之后（`requestWindowClose`）。
   *
   * 关窗那一处是 `ipc/shard.ts` 的 `closeLarge` 点名要的三处之一（另两处是标签关闭
   * 与「外部改了之后重开分片」，分别在 `dropTab` 与 `document.ts` 的 `reload`）。
   * 进程退出时操作系统本来也会收走 fd，但那条兜底不该是代码依赖的东西
   */
  function releaseAllShards() {
    for (const tab of tabs()) tab.doc.releaseShard()
  }

  async function restoreSession(session: Session): Promise<void> {
    // 先一次建好所有标签，再灌内容：panes 用的是 session 里的下标，靠 `fresh[i]` 对齐，
    // 边建边插会让下标错位
    const fresh = session.tabs.map(() => makeTab())

    // 有草稿的同步装进来；干净又有路径的**重新读盘**。并行读——
    // 几十个文件串行读会把启动拖成好几秒，而它们之间没有任何依赖
    await Promise.all(
      session.tabs.map(async (saved, i) => {
        const tab = fresh[i]!
        if (saved.draft !== null) {
          tab.doc.restoreDraft({
            path: saved.path,
            text: saved.draft,
            format: saved.format,
            dirty: saved.dirty,
            lossy: saved.lossy,
          })
          return
        }
        // 干净又没路径 = 一个空文档，没什么可恢复的
        if (saved.path === null) return
        // 读失败不往上抛：`document.ts` 已经把错误落在这个标签自己的 notice 上了，
        // 一个打不开的文件不该让整份会话恢复失败
        await tab.doc.openAt(saved.path)
      }),
    )

    session.tabs.forEach((saved, i) => applyRestoredPosition(fresh[i]!, saved))

    const freshPanes = session.panes.map((tabIndex) => makePane(fresh[tabIndex]!.id))
    setDirection(session.direction)
    // 🔴 旧的那批标签整个被扔掉，它们身上的分片得还回去（理由见 `dropTab` 里那一段）。
    //
    // 位置是**紧贴着 `setTabs(fresh)`**，不是这个方法开头。放在开头的话，从这里到
    // `setTabs` 之间隔着上面那一整段 `await Promise.all`——几十个文件的并行读盘，
    // 几百毫秒起步。那段时间里旧标签还在 `tabs()` 上、而 `shard()` 已经是 null，
    // 于是 `fileWatch` 会把它们当成普通内联标签送进清单；真来一条外部改动事件的话，
    // `reload` → 撞 too_large → 再开一个分片，而那个 fd 挂在一个马上就要被扔掉的
    // 标签上，`dispose` 永远不会被调到。
    //
    // 紧贴着就没有这个问题：两行之间没有 `await`，Solid 的 effect 要等到这一批更新
    // 落地之后才跑，那时它看见的已经是 `fresh`。
    //
    // ⚠️ 这个方法只在启动时用一次，那时通常一个分片都没有——但「只用在启动时」
    // 是文档里的一句话而不是类型系统里的一条约束，而漏一个 fd 是没有声音的
    releaseAllShards()
    setTabs(fresh)
    // 旧的那批分屏由 Solid 卸载 EditorPane 时自己收尾：`detach` 在 panes() 里找不到
    // 旧记录会直接返回，controller 由 EditorPane 的 onCleanup 销毁，不会泄漏
    setPanes(freshPanes)
    setFocusedPaneId(freshPanes[session.focused]!.id)
    // 只夹长度，**不去重也不校验路径**：
    // - 夹是必须的，因为 Rust 侧刻意不截断（见 `Session::recent` 的文档），
    //   一份手改过的存档能塞进来几万条，全背着就是白占内存；
    // - 去重是 `remember` 在写入侧维护的不变量，在这里再实现一遍就是第二份会漂的抄写；
    // - 路径存不存在更不该问：MRU 里的文件被删掉/移走是常态，`Cmd+P` 那边
    //   索引里没有它就自然不会出现，多问一次磁盘只是拖慢启动
    setRecent(session.recent.slice(0, MAX_RECENT))
    syncMetrics(activeTab())
  }

  // 起始的那一个空标签与那一块分屏。放在所有函数声明之后：
  // makeTab 要用 host，host 要用 activeTab，activeTab 要用 focusedPane
  const firstTab = makeTab()
  const firstPane = makePane(firstTab.id)
  setTabs([firstTab])
  setPanes([firstPane])
  setFocusedPaneId(firstPane.id)
  // `syncMetrics` 是普通函数（声明见上），读一次编辑器状态就把度量推进 signal。
  // 插件把「读 signal 的函数」一律当成响应式变量、要求它待在 tracked scope 里，
  // 但这里要的正是恢复完之后的**一次性**推送；套 createEffect 反而会让它跟着无关的 signal 重跑。
  // eslint-disable-next-line solid/reactivity
  syncMetrics(firstTab)

  /**
   * 见 `Workspace.focusedView` 上的说明。
   *
   * 🔴 刻意是普通箭头函数而不是 `createMemo`，两条理由，第二条是要紧的那条：
   *
   * 1. memo 在这里换不来任何东西。唯一的消费者（预览面板）自己就是防抖的，
   *    而这一层做的事只有「查一个字段」，比 memo 的比较还便宜。
   * 2. **memo 会把「同一块分屏换标签」整个吞掉。** `showIn` 走的是 `capture` + `restore`，
   *    不重建 view，于是换标签前后 `controller` 是**同一个实例**——`===` 相等，memo 不通知，
   *    订阅者收不到任何信号。少这一下的症状是「切了标签，旁边的预览还停在上一份文档」，
   *    而它只在「换标签但没换分屏」这条路上发作，分屏之间切反倒是对的。
   *
   * 顺带省掉一条排序约束：`createMemo` 是**立刻**求值的，建在上面那批初始状态之前就会
   * 因为 `panes()` 还是空数组而抛；普通箭头函数是被调用时才跑，没有这个坑。
   */
  const focusedView = (): EditorController | null => {
    // `attachedAt()` 的返回值不用，读它就是**为了订阅**：`attach` / `detach` 改的是
    // `PaneRecord` 上一个普通可变字段，那一下不触发任何信号，不留这个痕迹就没人知道
    attachedAt()
    const pane = focusedPane()
    // `tabById(...)` 那一次读同样是为了订阅（理由见上面第 2 条）。
    // 返回 `null` 而不是直接 `pane.controller`：一个标签都不在 `tabs()` 里的分屏
    // 没有「当前文档」可言，那时说「没有可预览的正文」比递一个显示着幽灵文档的实例诚实
    return tabById(pane.tabId()) === undefined ? null : pane.controller
  }

  return {
    tabs,
    panes,
    direction,
    focusedPaneId,
    activeTab,
    activeIndex: () => tabs().findIndex((t) => t.id === activeTab().id),
    lineWrap: wrap,
    dark,
    metrics,
    revision,
    recent,
    focusedEditor: () => focusedPane().controller,
    tabOfView(view) {
      const pane = panes().find((p) => p.controller?.view === view)
      // `?? null` 那一半是「分屏还在、但它显示的标签已经被关掉了」：
      // 与 `focusedView` 返回 null 的理由同一条——没有「当前文档」就别假装有
      return pane === undefined ? null : (tabById(pane.tabId()) ?? null)
    },
    focusedView,
    attach,
    detach,
    focusPane,
    split,
    closePane,
    cyclePane,
    newTab,
    openViaDialog,
    openAt,
    closeTab,
    activateTab,
    reorder,
    async save() {
      const doc = activeTab().doc
      await doc.save()
      // 未命名文档的 `save` 会落到另存为，于是路径是在这一趟里**才出现的**。
      // 那时标签早就是活动的那个，`activateTab` 不会再被调用——不在这里补一笔，
      // 「新建 → ⌘S → 另存为」这个文件就永远进不了 MRU
      remember(doc.path())
    },
    async saveAs() {
      const doc = activeTab().doc
      await doc.saveAs()
      remember(doc.path())
    },
    setLineWrap,
    toggleLineWrap: () => setLineWrap(!config.lineWrap),
    setDarkTheme,
    notifyFontSizeChanged,
    anyDirty: () => tabs().some((t) => t.doc.dirty()),
    dirtyPaths: () =>
      tabs().flatMap((t) => {
        const at = t.doc.path()
        // 未命名的脏标签没有路径可递，而它也不需要保护：磁盘上没有它，落盘碰不到
        return t.doc.dirty() && at !== null ? [at] : []
      }),
    async reloadUnder(root) {
      // 只碰 root 底下的：替换只可能改到那些文件，而 root 之外的标签重读一遍
      // 是白花一次 IPC——正文一样时 `reload` 什么都不做，但那一趟读盘已经发生了
      const prefix = root.endsWith('/') ? root : `${root}/`
      let changed = 0
      for (const tab of tabs()) {
        const at = tab.doc.path()
        if (at === null || !at.startsWith(prefix)) continue
        // 脏不脏由 `reload` 自己判：那条规矩只该有一个真相来源，
        // 在这里再写一遍的话两边哪天分岔，失败方式是「用户的稿子被覆盖」
        if (await tab.doc.reload()) changed += 1
      }
      return changed
    },
    // 一次问完所有脏标签，而不是一个一个弹：关窗口时弹五次对话框没人受得了
    requestWindowClose: async () => {
      const ok = await settle(tabs().filter((t) => t.doc.dirty()))
      // 只在真的要关的时候收：用户答了「取消」，那些分片还得继续用
      if (ok) releaseAllShards()
      return ok
    },
    serializeSession,
    restoreSession,
  }
}
