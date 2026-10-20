import { createSignal, For, Show } from 'solid-js'
import { describeTreeError, revealFile } from '../ipc/project'
import { TreeMenu, type ContextMenuItem } from '../project/TreeMenu'
import type { Workspace } from './workspace'
import { UNTITLED_LABEL } from './document'

/**
 * 标签右键菜单的动作。
 *
 * 🔴 `onPick` 里必须有 switch：三项各有各的落点，而「加了第四项却忘了处理」的失败方式
 * 是点下去什么也没发生（类型只在 `action` 上帮忙，不会替你写分支）
 */
type TabMenuAction = 'reveal' | 'closeOthers' | 'closeAll'

/**
 * 菜单里那几项，按「这一个标签自己的事 / 一批标签的事」分成两组，中间一条分隔线。
 *
 * ⚠️ 「打开文件所在目录」的措辞与树菜单那一项（「在 Finder 中显示」）**刻意不同**：
 * 树上右键的是磁盘里的一个条目，「显示」说的就是它；标签上右键的是一份**打开着的文档**，
 * 用户想知道的是「这个文件到底躺在哪儿」。两句背后是同一个 `open -R`，
 * 而后者不要求用户先知道 Finder 这个词。
 *
 * 未命名文档没有磁盘上的位置，所以那一项由 `itemsFor` 摘掉，剩下两项照常可用。
 */
const REVEAL_ITEM: ContextMenuItem<TabMenuAction> = { action: 'reveal', label: '打开文件所在目录' }
const CLOSE_ITEMS: ContextMenuItem<TabMenuAction>[] = [
  { action: 'closeOthers', label: '关闭其它标签', separator: true },
  { action: 'closeAll', label: '关闭所有标签' },
]

const itemsFor = (path: string | null): ContextMenuItem<TabMenuAction>[] =>
  path === null ? CLOSE_ITEMS : [REVEAL_ITEM, ...CLOSE_ITEMS]

export interface TabStripProps {
  workspace: Workspace
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
 * 标签条。
 *
 * 重排用 HTML5 拖放（`draggable` + dragstart/dragover/drop）而不是自己监听鼠标：
 * 自己实现要处理自动滚动、拖出窗口取消、以及 macOS 上拖拽与文本选择的抢占，
 * 而这里只需要「放下时换个顺序」，浏览器已经全做完了。
 *
 * ⚠️ `dragover` 必须 `preventDefault()`，否则浏览器认为这里不接受放置，`drop` 压根不触发。
 * 这是拖放 API 最常被踩的一条。
 *
 * **只有一条标签条，分屏可以有多块。** 所以标签分三种：活动（聚焦分屏显示的那个）、
 * 在别的分屏里显示着、以及纯后台。中间那种必须看得出来——点它是把焦点交给那块分屏，
 * 不是把它搬到当前分屏来（见 `workspace.activateTab`），长得和后台标签一样就无从解释。
 *
 * ## 右键菜单
 *
 * 复用文件树那一个外壳（`project/TreeMenu.tsx`，泛型参数就是为此加的）：贴边 clamp、
 * 点外面关、Escape 关这三段是「改坏了不报错、只是菜单赖着或飘走」的微妙逻辑，
 * 写第二份一定会漂移。
 *
 * ⚠️ 菜单渲染在 `.tab-strip` **里面**而不是它旁边：`.app` 是固定五行的 grid，
 * 多一个兄弟元素就把下面三行全推错位（那条 grid 的注释里写明了行数为什么必须固定）。
 * 在里面也不参与 flex 布局——`.tree-menu` 是 `position: fixed`，脱离文档流。
 *
 * ## 双击空白处新建标签
 *
 * 与 VS Code 同一条手势。认它的判据是「事件目标就是标签条自己」：标签与「+」都是它的
 * 子元素，双击它们时 `target` 是子元素而不是标签条，于是「双击标签」不会顺手多开一个
 * 空标签，「双击 +」也不会一次开两个。标签多到横向溢出时没有空白处可点，手势自然失效
 */
export function TabStrip(props: TabStripProps) {
  // 与 StatusBar 同理：`workspace` 是 createWorkspace() 返回的普通对象，不是 signal，
  // App 只建一次也从不换引用；响应式读取全走 `ws.tabs()` 这类访问器。
  // eslint-disable-next-line solid/reactivity
  const ws = props.workspace
  // `onError` 与 Sidebar 的 `onNotice` 同一条：App 传下来的是一个引用从不变的回调，
  // 留在 `props.onError` 上现读的话，`.catch` 里那个闭包会被 lint 当成
  // 「在追踪范围外面读响应式值」
  // eslint-disable-next-line solid/reactivity
  const onError = props.onError
  /** 正在被拖的标签。不是 signal：拖拽过程中没有任何渲染依赖它 */
  let draggedId: number | null = null

  /**
   * 右键弹出来的那一份菜单。
   *
   * 🔴 存**路径 + 标签 id**，两者各管一项动作：`reveal` 用路径，「关闭其它标签」用 id
   * （workspace 那边只认 id）。菜单弹着的时候那个标签可能已经被关掉了（Mod+W、点 ×），
   * 所以两项都自带兜底——路径是快照，`closeOtherTabs` 对不存在的 id 是空操作。
   *
   * id 不会被复用（`nextTabId` 只增），于是「存 id 会查到另一份文档」这件事在这里不成立；
   * 真正需要快照的是路径：未命名文档存了盘之后 `doc.path()` 就变了，
   * 而用户右键的是**弹出菜单那一刻**的那份文档。与 Sidebar 把整行 `row` 存成快照同一条理由
   */
  const [menu, setMenu] = createSignal<{ x: number; y: number; tabId: number; path: string | null } | null>(null)

  /** 显示在别的分屏里（聚焦那块不算，那是 active） */
  function shownElsewhere(tabId: number): boolean {
    return ws.panes().some((p) => p.id !== ws.focusedPaneId() && p.tabId() === tabId)
  }

  /**
   * ⛔ 右键**不**顺手激活那个标签：树那边右键会选中行，因为一行可能被省略号截断、
   * 用户需要确认自己点的是哪一个；标签不会——它就摆在光标底下，而且 `title` 挂着完整路径。
   * 在这里激活等于「右键一下，正文换了」，那是用户没要求的副作用。
   *
   * ⚠️ 未命名文档也弹菜单（原来不弹）：那时菜单里只有「打开文件所在目录」一项，
   * 而它对未命名文档无从谈起，弹一份空的／灰的出来只是让用户多点一次关闭。
   * 现在多了两项关闭动作，它们对未命名文档一样成立，于是这一档不再例外——
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
      case 'closeOthers':
        void ws.closeOtherTabs(m.tabId)
        return
      case 'closeAll':
        void ws.closeAllTabs()
        return
    }
  }

  return (
    <div
      class="tab-strip"
      role="tablist"
      onScroll={() => {
        // 标签多到横向滚动时，滚走的标签底下留着一份指着别处的菜单（`.tree-menu` 是 fixed，
        // 不跟着滚）。这是 TreeMenu 文档里那条「第四条关闭路径归宿主」的落点
        if (menu() !== null) setMenu(null)
      }}
      onDblClick={(e) => {
        // 双击空白处 = 新建标签（与 VS Code 同一条手势）。判据是「事件目标就是标签条
        // 自己」：标签、「+」都是它的子元素，双击它们时 target 是子元素，不会走到这里——
        // 于是「双击标签」不会顺手多开一个空标签，「双击 +」也不会一次开两个
        if (e.target === e.currentTarget) ws.newTab()
      }}
    >
      <For each={ws.tabs()}>
        {(tab) => (
          <div
            class="tab"
            classList={{ active: ws.activeTab().id === tab.id, shown: shownElsewhere(tab.id) }}
            role="tab"
            aria-selected={ws.activeTab().id === tab.id}
            title={tab.doc.path() ?? UNTITLED_LABEL}
            draggable={true}
            onClick={() => ws.activateTab(tab.id)}
            onContextMenu={(e) => onTabContextMenu(e, { id: tab.id, path: tab.doc.path() })}
            onDragStart={() => {
              draggedId = tab.id
            }}
            onDragEnd={() => {
              draggedId = null
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (draggedId !== null) ws.reorder(draggedId, tab.id)
              draggedId = null
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
      <button class="tab-new" title="新建标签（Mod+N）" onClick={() => ws.newTab()}>
        +
      </button>

      <Show when={menu()}>
        {(m) => (
          <TreeMenu
            x={m().x}
            y={m().y}
            items={itemsFor(m().path)}
            onPick={(action) => onPick(action, { tabId: m().tabId, path: m().path })}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </div>
  )
}
