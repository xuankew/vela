import { For } from 'solid-js'
import type { Workspace } from './workspace'
import { UNTITLED_LABEL } from './document'

export interface TabStripProps {
  workspace: Workspace
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
 */
export function TabStrip(props: TabStripProps) {
  // 与 StatusBar 同理：`workspace` 是 createWorkspace() 返回的普通对象，不是 signal，
  // App 只建一次也从不换引用；响应式读取全走 `ws.tabs()` 这类访问器。
  // eslint-disable-next-line solid/reactivity
  const ws = props.workspace
  /** 正在被拖的标签。不是 signal：拖拽过程中没有任何渲染依赖它 */
  let draggedId: number | null = null

  /** 显示在别的分屏里（聚焦那块不算，那是 active） */
  function shownElsewhere(tabId: number): boolean {
    return ws.panes().some((p) => p.id !== ws.focusedPaneId() && p.tabId() === tabId)
  }

  return (
    <div class="tab-strip" role="tablist">
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
            <span class="tab-name">
              {tab.doc.dirty() ? '● ' : ''}
              {tab.doc.name()}
            </span>
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
          </div>
        )}
      </For>
      <button class="tab-new" title="新建标签（Mod+N）" onClick={() => ws.newTab()}>
        +
      </button>
    </div>
  )
}
