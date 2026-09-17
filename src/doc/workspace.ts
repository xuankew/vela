import { EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { indentUnit, type LanguageSupport } from '@codemirror/language'
import { createSignal, type Accessor, type Setter } from 'solid-js'
import { open as pickToOpen } from '@tauri-apps/plugin-dialog'
import type { EditorController } from '../editor/controller'
import { languageFor, loadSupport, sameLanguage, type LanguageChoice } from '../editor/language'
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
  /** 状态栏要的度量。只反映**聚焦分屏**显示的那个标签 */
  readonly metrics: Accessor<DocMetrics>
  /** 命令中心的 `ctx.editor` 就是这个。没有分屏挂着编辑器时是 null */
  focusedEditor: () => EditorController | null
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
  /** 有没有任何标签还没落盘 */
  anyDirty: () => boolean
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
  /**
   * 缺省时一律答「取消」。
   *
   * 这个默认值看着反常（关不掉标签），但另一头是**静默丢数据**：没接 UI 的时候
   * 宁可什么都别关，也不能让用户的一次点击把没存盘的稿子扔掉。
   */
  promptDiscard?: DiscardPrompt
}

export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  // liveStates 声明在后面，但这里只是把引用存进 config，真正调用发生在补全请求时——
  // 那时 tabs 信号早就建好了，不会撞上 TDZ
  const config: ViewConfig = createViewConfig(options.lineWrap ?? true, liveStates)
  const promptDiscard: DiscardPrompt = options.promptDiscard ?? (async () => 'cancel')

  const [tabs, setTabs] = createSignal<Tab[]>([])
  const [panes, setPanes] = createSignal<PaneRecord[]>([])
  const [focusedPaneId, setFocusedPaneId] = createSignal(-1)
  const [direction, setDirection] = createSignal<SplitDirection>('row')
  const [wrap, setWrap] = createSignal(config.lineWrap)
  const [metrics, setMetrics] = createSignal<DocMetrics>(EMPTY_METRICS)

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
   * 按标签当前的路径把语言装进它自己的槽位。
   *
   * 三个调用点：标签刚建好、`setText` 重建了 state（新 state 的槽位是空的）、
   * 路径变了（打开文件、另存为）。语言没变时直接返回——否则每次保存都会把所有
   * 标签的 state 对象换一遍，内容虽然没变，但靠 `===` 判断「state 没动过」的地方会失准。
   */
  function syncLanguage(tab: Tab) {
    const choice = languageFor(tab.doc.path())
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
        // 脏标记只认正文变化：光标移动不该让文件变成「未保存」
        if (info.docChanged) tab.doc.markChanged()
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
   */
  function showIn(pane: PaneRecord, next: Tab) {
    if (pane.tabId() === next.id) return
    capture(pane)
    pane.setTabId(next.id)
    pane.controller?.restore(next.snapshot)
    if (pane.id === focusedPaneId()) syncMetrics(next)
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
  }

  function detach(paneId: number) {
    const pane = paneById(paneId)
    if (!pane) return
    // 现场先存回标签：controller 马上就要被 destroy，之后 snapshot 是唯一的真相
    capture(pane)
    pane.controller = null
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

  function activateTab(id: number) {
    const tab = tabById(id)
    if (!tab) return
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

  /**
   * 真正把标签摘掉，并给显示着它的那块分屏换一个标签显示。
   *
   * 换谁：右邻居优先，但**只能挑一个没在别的分屏里显示着的**——否则两块分屏会显示同一个
   * 标签，正是文件头不变量 2 排除的情况（`snapshot` 不再是「没显示时的唯一真相」）。
   * 一个都挑不出来时就补一个空标签：宁可标签条上多一个「空文档」，也不能让现场分叉。
   */
  function dropTab(id: number) {
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
      return
    }
    const tab = newTab()
    await tab.doc.openAt(path)
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
    setTabs(fresh)
    // 旧的那批分屏由 Solid 卸载 EditorPane 时自己收尾：`detach` 在 panes() 里找不到
    // 旧记录会直接返回，controller 由 EditorPane 的 onCleanup 销毁，不会泄漏
    setPanes(freshPanes)
    setFocusedPaneId(freshPanes[session.focused]!.id)
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

  return {
    tabs,
    panes,
    direction,
    focusedPaneId,
    activeTab,
    activeIndex: () => tabs().findIndex((t) => t.id === activeTab().id),
    lineWrap: wrap,
    metrics,
    focusedEditor: () => focusedPane().controller,
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
    save: () => activeTab().doc.save(),
    saveAs: () => activeTab().doc.saveAs(),
    setLineWrap,
    toggleLineWrap: () => setLineWrap(!config.lineWrap),
    anyDirty: () => tabs().some((t) => t.doc.dirty()),
    // 一次问完所有脏标签，而不是一个一个弹：关窗口时弹五次对话框没人受得了
    requestWindowClose: () => settle(tabs().filter((t) => t.doc.dirty())),
    serializeSession,
    restoreSession,
  }
}
