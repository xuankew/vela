import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
import type { TreeMenuAction, TreeMenuItem } from './tree'

export interface TreeMenuProps {
  /** 视口坐标，来自 `contextmenu` 事件的 clientX / clientY */
  x: number
  y: number
  items: TreeMenuItem[]
  onPick: (action: TreeMenuAction) => void
  onClose: () => void
}

/**
 * 文件树的右键菜单。
 *
 * **为什么自己写而不用原生菜单**：Tauri 2 的 `menu` API 建的是**应用菜单**（挂在窗口上、
 * 有固定的层级与生命周期），不是一个跟着光标弹出的上下文菜单；而 Web 这一侧没有
 * 任何原生的「弹一个自定义菜单」的东西。菜单一共六项、形状固定，自己写只是几十行。
 *
 * ## 三条关闭路径
 *
 * 点菜单外面、按 Escape、以及**选了一项**——三条都归到 `onClose`。少掉任何一条的失败
 * 方式都是「菜单赖在屏幕上」，而它赖着的时候底下那一行点不到，用户会以为树卡死了。
 * 树滚动时也关（见 Sidebar 的 onScroll）：菜单是 `position: fixed`，行滚走了它不会跟着走，
 * 留着的是一份指着别处的菜单。
 *
 * ## ⚠️ 分隔线与危险动作
 *
 * 「移到废纸篓」刻意不做成红色、也不缩小成页脚文本：菜单里的每一项都是用户主动叫出来的，
 * 把其中一项画成危险会让整条菜单看起来不可信。它的可挽回性由提示条上那句
 * 「已移到废纸篓，可以在 Finder 里找回」来说，而不是由颜色来说。
 */
export function TreeMenu(props: TreeMenuProps) {
  let el: HTMLDivElement | undefined

  /**
   * 贴边时把菜单推回视口里。
   *
   * 必须在渲染之后算（见下面那个 `createEffect`）：菜单的宽高只有真的渲染出来才知道，
   * 而 `props.x/y` 是光标的位置——在右下角右键时照原样定位会让菜单有一半在窗口外面，
   * 那半里的项点不到。
   *
   * ⚠️ jsdom 里 `getBoundingClientRect()` 全是 0，所以组件测试只能钉住「不超出窗口」这半个；
   * 「减去菜单自己的宽度」那半个要在真实窗口里看。
   */
  // `untrack`：这是一次性的**初始值**，不是要跟着 props 变的推导——跟着变是下面那个
  // `createEffect` 的事。不写 untrack 的话 lint 会以为这里想要响应式而写漏了追踪
  const [pos, setPos] = createSignal(untrack(() => ({ x: props.x, y: props.y })))

  function clamp(x: number, y: number) {
    const rect = el?.getBoundingClientRect()
    if (!rect) return
    setPos({
      x: Math.max(0, Math.min(x, window.innerWidth - rect.width)),
      y: Math.max(0, Math.min(y, window.innerHeight - rect.height)),
    })
  }

  /**
   * 菜单外面按下就关。用**捕获**阶段的 `mousedown` 而不是 `click`：
   * 右键另一行时顺序是 mousedown → contextmenu，用 click 的话新菜单先开、随后又被
   * 那次 click 关掉，看起来像「右键第二次没反应」。
   *
   * 菜单**里面**的按下要放过：项是靠 `onClick` 触发的，在这里关掉的话那次 click
   * 永远等不到——菜单已经不在 DOM 里了。
   */
  function onDocDown(e: MouseEvent) {
    if (el?.contains(e.target as Node)) return
    props.onClose()
  }

  function onDocKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    // 拦住不让它继续往下走：Escape 在编辑器那边还有别的用处（关查找面板、退出多光标），
    // 而用户此刻要关的是这个菜单。与 DiscardDialog 同一条理由——绑 Escape 的命令
    // 一律不进命令中心，就是为了这种「谁在最上面谁说了算」的场合
    e.stopPropagation()
    e.preventDefault()
    props.onClose()
  }

  onMount(() => {
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onDocKey, true)
  })
  onCleanup(() => {
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onDocKey, true)
  })

  /**
   * ⚠️ 必须是 `createEffect` 而不是 `onMount`：右键第二行时 Sidebar 那边
   * `<Show when={menu()}>` 的 when 前后都是真值，**这个组件不会被重建**，
   * `onMount` 也就不会再跑一次。只在挂载时算的话菜单会留在上一个光标的位置上——
   * 内容换成了新行的，位置却没动，看起来像菜单飘走了。
   *
   * 坐标写成参数而不是让 `clamp` 自己去读 `props`：读要发生在这个追踪范围**里面**。
   */
  createEffect(() => clamp(props.x, props.y))

  return (
    <div class="tree-menu" ref={el} role="menu" style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
      <For each={props.items}>
        {(item) => (
          <>
            <Show when={item.separator}>
              <div class="tree-menu-sep" />
            </Show>
            <button
              class="tree-menu-item"
              role="menuitem"
              onClick={() => {
                props.onPick(item.action)
                props.onClose()
              }}
            >
              {item.label}
            </button>
          </>
        )}
      </For>
    </div>
  )
}
