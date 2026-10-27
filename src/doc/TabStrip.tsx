import { createSignal, For, Show } from 'solid-js'
import { describeTreeError, revealFile } from '../ipc/project'
import { TreeMenu, type ContextMenuItem } from '../project/TreeMenu'
import { MAX_PANES, type Workspace } from './workspace'
import { UNTITLED_LABEL } from './document'

/**
 * 标签右键菜单的动作。
 *
 * 🔴 `onPick` 里必须有 switch：六项各有各的落点，而「加了第七项却忘了处理」的失败方式
 * 是点下去什么也没发生（类型只在 `action` 上帮忙，不会替你写分支）
 */
type TabMenuAction = 'reveal' | 'splitRight' | 'splitDown' | 'closePane' | 'closeOthers' | 'closeAll'

/**
 * 「打开文件所在目录」这一项。
 *
 * ⚠️ 措辞与树菜单那一项（「在 Finder 中显示」）**刻意不同**：
 * 树上右键的是磁盘里的一个条目，「显示」说的就是它；标签上右键的是一份**打开着的文档**，
 * 用户想知道的是「这个文件到底躺在哪儿」。两句背后是同一个 `open -R`，
 * 而后者不要求用户先知道 Finder 这个词。
 *
 * 未命名文档没有磁盘上的位置，所以那一项由 `itemsFor` 摘掉，其余各项照常可用。
 */
const REVEAL_ITEM: ContextMenuItem<TabMenuAction> = { action: 'reveal', label: '打开文件所在目录' }

/**
 * 正在被拖的那个标签的 id。
 *
 * 🔴 **模块级**而不是组件内：拖拽的两个端点在 M4-R 之后常常不是同一个组件实例——
 * 从左边那屏的标签条拖到右边那屏的标签条上，`dragstart` 在一个实例里、`drop` 在另一个里。
 * 放在组件内的话目标那一屏永远读到 `null`，跨屏拖拽就成了「拖过去什么也没发生」。
 *
 * 不是 signal：拖拽过程中没有任何渲染依赖它。
 * ⚠️ 同一时刻只可能有一次拖拽（浏览器保证），所以一个变量就够，不需要按实例分开
 */
let draggedTabId: number | null = null

export interface TabStripProps {
  workspace: Workspace
  /**
   * 这一条标签条属于哪一块分屏。
   *
   * M4-R 起标签条是**每屏一条**：这一屏有哪些标签、正在显示哪一个，全从
   * `pane.tabs()` / `pane.activeTabId()` 读，而「+」、右键那五项、拖拽的落点
   * 也全都作用在这一屏上。
   */
  paneId: number
  /**
   * 没做成时要说给整个窗口听的一句话（App 那边接到提示条上）。
   *
   * **成功刻意不说话**：Finder 被推到前台本身就是回话，再说一句是重复——与树菜单的
   * 「在 Finder 中显示」同一条。要说的只有失败：文件在磁盘上被移走或删除了，
   * 或者不在 macOS 上（`reveal_entry` 只实现了 `open -R`，见 `ipc/project.ts`）
   */
  onError?: (text: string) => void
}

/**
 * 一块分屏的标签条。
 *
 * 重排与跨屏搬动用 HTML5 拖放（`draggable` + dragstart/dragover/drop）而不是自己监听鼠标：
 * 自己实现要处理自动滚动、拖出窗口取消、以及 macOS 上拖拽与文本选择的抢占，
 * 而这里只需要「放下时换个位置」，浏览器已经全做完了。
 *
 * ⚠️ `dragover` 必须 `preventDefault()`，否则浏览器认为这里不接受放置，`drop` 压根不触发。
 * 这是拖放 API 最常被踩的一条。标签条自己那一份也要（放到空白处 = 搬到这一屏的末尾）。
 *
 * ## 放下时的三种落点
 *
 * - **同屏的另一个标签上** = 换顺序（`workspace.reorder`）；
 * - **别屏的标签上** = 搬进那一屏、落在被压住的那一格（`reorder` 自己认跨屏，
 *   手势只有一个，用户不知道也不该需要知道两者是否同屏）；
 * - **一条标签条的空白处** = 搬到那一屏的末尾（`workspace.moveTab`）。
 *
 * ## 右键菜单
 *
 * 复用文件树那一个外壳（`project/TreeMenu.tsx`，泛型参数就是为此加的）：贴边 clamp、
 * 点外面关、Escape 关这三段是「改坏了不报错、只是菜单赖着或飘走」的微妙逻辑，
 * 写第二份一定会漂移。
 *
 * ⚠️ 菜单渲染在 `.tab-strip` **里面**：`.editor-host` 是纵向 flex，多一个兄弟元素就会
 * 变成编辑器旁边的一列。在里面也不参与 flex 布局——`.tree-menu` 是 `position: fixed`，
 * 脱离文档流。
 *
 * ## 双击空白处新建标签
 *
 * 与 VS Code 同一条手势。认它的判据是「事件目标就是标签条自己」：标签与「+」都是它的
 * 子元素，双击它们时 `target` 是子元素而不是标签条，于是「双击标签」不会顺手多开一个
 * 空标签，「双击 +」也不会一次开两个。标签多到横向溢出时没有空白处可点，手势自然失效
 */
export function TabStrip(props: TabStripProps) {
  // 与 StatusBar 同理：`workspace` 是 createWorkspace() 返回的普通对象，不是 signal，
  // App 只建一次也从不换引用；响应式读取全走 `ws.panes()` 这类访问器。
  // eslint-disable-next-line solid/reactivity
  const ws = props.workspace
  // `onError` 与 Sidebar 的 `onNotice` 同一条：App 传下来的是一个引用从不变的回调，
  // 留在 `props.onError` 上现读的话，`.catch` 里那个闭包会被 lint 当成
  // 「在追踪范围外面读响应式值」
  // eslint-disable-next-line solid/reactivity
  const onError = props.onError

  /**
   * 这一条标签条所属的那块分屏。
   *
   * ⚠️ 现查而不是在组件开头存一份：分屏会被关掉、被合并掉，`<For>` 卸载这个组件之前
   * 有一次渲染会读到 `undefined`。所有读取都写成 `pane()?.…`，落空就是空清单
   */
  const pane = () => ws.panes().find((p) => p.id === props.paneId)

  /** 这一屏的标签，屏幕顺序。分屏已经不在了就是空数组 */
  const ownTabs = () => pane()?.tabs() ?? []

  /** 这一屏正在显示的那一个（每屏只有一个活标签，见 workspace 的不变量 3） */
  const shownId = () => pane()?.activeTabId() ?? -1

  /**
   * 右键弹出来的那一份菜单。
   *
   * 🔴 存**路径 + 标签 id**：`reveal` 用路径，其余五项都用 id（workspace 那边只认 id）。
   * 菜单弹着的时候那个标签可能已经被关掉了（Mod+W、点 ×），所以两边都自带兜底——
   * 路径是快照，而 workspace 那五个方法对不存在的 id 一律是空操作。
   *
   * id 不会被复用（`nextTabId` 只增），于是「存 id 会查到另一份文档」这件事在这里不成立；
   * 真正需要快照的是路径：未命名文档存了盘之后 `doc.path()` 就变了，
   * 而用户右键的是**弹出菜单那一刻**的那份文档。与 Sidebar 把整行 `row` 存成快照同一条理由
   */
  const [menu, setMenu] = createSignal<{ x: number; y: number; tabId: number; path: string | null } | null>(null)

  /**
   * 菜单里那几项，按「这一个标签自己的事 / 分屏 / 一批标签的事」分成三组，组间一条分隔线。
   *
   * 🔴 读的是**活的** `ws.panes()`（菜单弹着的时候分屏可能已经被关掉），所以它是组件内的
   * 函数而不是模块级的常量：置灰与否要现算。
   *
   * ⚠️ 做不成的两项一律**置灰而不是摘掉**，与编辑器那份菜单的「剪切／复制」同一条：
   * 灰掉看得见、摘掉像是菜单坏了。
   * - 「右分屏／下分屏」到 `MAX_PANES` 就到顶了，`split` 那时只改排列方向、不加新分屏；
   * - 「关闭分屏」要有别的分屏可退——只剩一块时它是空操作（`closePane` 的第一道守卫），
   *   因为那一屏空了整个现场就没了（workspace 的不变量 1 不许「零分屏」）。
   */
  function itemsFor(m: { tabId: number; path: string | null }): ContextMenuItem<TabMenuAction>[] {
    const splittable = ws.panes().length < MAX_PANES
    const closable = ws.panes().length > 1
    return [
      ...(m.path === null ? [] : [REVEAL_ITEM]),
      { action: 'splitRight', label: '右分屏', separator: true, disabled: !splittable },
      { action: 'splitDown', label: '下分屏', disabled: !splittable },
      { action: 'closePane', label: '关闭分屏', disabled: !closable },
      { action: 'closeOthers', label: '关闭其它标签', separator: true },
      { action: 'closeAll', label: '关闭所有标签' },
    ]
  }

  /**
   * ⛔ 右键**不**顺手激活那个标签：树那边右键会选中行，因为一行可能被省略号截断、
   * 用户需要确认自己点的是哪一个；标签不会——它就摆在光标底下，而且 `title` 挂着完整路径。
   * 在这里激活等于「右键一下，正文换了」，那是用户没要求的副作用。
   *
   * ⚠️ 未命名文档也弹菜单（原来不弹）：那时菜单里只有「打开文件所在目录」一项，
   * 而它对未命名文档无从谈起，弹一份空的／灰的出来只是让用户多点一次关闭。
   * 现在多了分屏与关闭那五项，它们对未命名文档一样成立，于是这一档不再例外——
   * 只是把 `reveal` 那一项摘掉（见 `itemsFor`）
   */
  function onTabContextMenu(e: MouseEvent, tab: { id: number; path: string | null }) {
    // 不拦的话 macOS 会在我们的菜单旁边再弹一个原生的，两个叠在一起（与 Sidebar 同一条）
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id, path: tab.path })
  }

  /** 成了不说话（Finder 被推到前台本身就是回话），没做成才把那句话交给提示条 */
  function reveal(path: string) {
    void revealFile(path).catch((err: unknown) => onError?.(describeTreeError(err)))
  }

  function onPick(action: TabMenuAction, m: { tabId: number; path: string | null }) {
    switch (action) {
      case 'reveal':
        // path 为 null 时这一项压根不在菜单里，兜一句只是为了让 `reveal` 收到 string
        if (m.path !== null) reveal(m.path)
        return
      // 「右分屏／下分屏」= 把**被右键的这个标签**搬进新分屏（它原来那一屏改显示右邻居）。
      // 与命令面板／「窗口」菜单里同名那两项是同一个 `ws.split(direction, tabId)`，
      // 只是那边搬的是活动标签。⛔ 不是「同一份文件两边各显示一次」，理由写在 `split` 上
      case 'splitRight':
        ws.split('row', m.tabId)
        return
      case 'splitDown':
        ws.split('column', m.tabId)
        return
      // 「关闭分屏」关的是**这一条标签条所属的那一块**，连带里面所有标签一起关
      // （脏的先弹确认）。菜单弹着的时候那块分屏可能已经被合并掉了，
      // `closePane` 对不存在的 id 是空操作
      case 'closePane':
        void ws.closePane(props.paneId)
        return
      // 作用域是**这一屏**：菜单是从这一屏的标签条上弹出来的，「其它」就是同屏的其它
      case 'closeOthers':
        void ws.closeOtherTabs(m.tabId)
        return
      case 'closeAll':
        void ws.closeAllTabs(props.paneId)
        return
    }
  }

  return (
    <div
      class="tab-strip"
      role="tablist"
      onContextMenu={(e) => {
        // 🔴 拦住冒泡：标签条现在住在 `.editor-host` **里面**（M4-R 起每屏一条），
        // 而 App 在那一层挂了「正文右键菜单」。不拦的话右键一个标签会同时弹出两份菜单
        // （标签那一份 + 编辑器那一份），而编辑器那一份的六个动作作用在正文上，
        // 用户点的却是标签条。空白处与「+」一并拦掉：那里既没有正文也没有标签，
        // 弹原生菜单只会让人以为点错了地方
        e.preventDefault()
        e.stopPropagation()
      }}
      onScroll={() => {
        // 标签多到横向滚动时，滚走的标签底下留着一份指着别处的菜单（`.tree-menu` 是 fixed，
        // 不跟着滚）。这是 TreeMenu 文档里那条「第四条关闭路径归宿主」的落点
        if (menu() !== null) setMenu(null)
      }}
      onDblClick={(e) => {
        // 双击空白处 = 在**这一屏**新建标签（与 VS Code 同一条手势）。判据是「事件目标就是
        // 标签条自己」：标签、「+」都是它的子元素，双击它们时 target 是子元素，不会走到这里
        if (e.target === e.currentTarget) ws.newTab(props.paneId)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        // 放到空白处 = 搬到这一屏的末尾。落在某个标签上的那一次由标签自己
        // `stopPropagation()` 拦掉，不会走到这里（否则会变成「搬过来又挪到末尾」）
        e.preventDefault()
        if (draggedTabId !== null) ws.moveTab(draggedTabId, props.paneId)
        draggedTabId = null
      }}
    >
      <For each={ownTabs()}>
        {(tab) => (
          <div
            class="tab"
            classList={{ active: shownId() === tab.id }}
            role="tab"
            aria-selected={shownId() === tab.id}
            title={tab.doc.path() ?? UNTITLED_LABEL}
            draggable={true}
            onClick={() => ws.activateTab(tab.id)}
            onContextMenu={(e) => onTabContextMenu(e, { id: tab.id, path: tab.doc.path() })}
            onDragStart={() => {
              draggedTabId = tab.id
            }}
            onDragEnd={() => {
              draggedTabId = null
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              // 🔴 `stopPropagation` 是必须的：不拦的话这一次 drop 还会冒到标签条自己那一份
              // 上去，于是「放到某一格上」变成「搬到这一屏的末尾」，落点被悄悄改掉
              e.stopPropagation()
              e.preventDefault()
              if (draggedTabId !== null) ws.reorder(draggedTabId, tab.id)
              draggedTabId = null
            }}
          >
            <span class="tab-name">{tab.doc.name()}</span>
            {/* 脏点与 × 共用右边**同一格**（CSS 里叠在同一个 grid 位）：Sublime 的口径是
                「脏了显示点、悬停时 × 把点换掉」——一格装两个信号，悬停时标签宽度不跳 */}
            <span class="tab-slot">
              <Show when={tab.doc.dirty()}>
                <span class="tab-dot">●</span>
              </Show>
              <button
                class="tab-close"
                title="关闭标签"
                onClick={(e) => {
                  // 点子元素不等于点标签。眼下不拦也没事——`activateTab` 对已关闭的 id 是空操作，
                  // 但等它以后有了「id 不存在就新建」之类的行为，漏掉这行就会变成 bug。
                  e.stopPropagation()
                  void ws.closeTab(tab.id)
                }}
              >
                ×
              </button>
            </span>
          </div>
        )}
      </For>
      <button class="tab-new" title="新建标签（Mod+N）" onClick={() => ws.newTab(props.paneId)}>
        +
      </button>

      <Show when={menu()}>
        {(m) => (
          <TreeMenu
            x={m().x}
            y={m().y}
            items={itemsFor(m())}
            onPick={(action) => onPick(action, { tabId: m().tabId, path: m().path })}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </div>
  )
}
