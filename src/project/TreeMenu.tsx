import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
import type { TreeMenuAction } from './tree'

/**
 * 菜单里的一项。`A` 是「用户选了之后要告诉宿主的动作」，由宿主自己定义。
 *
 * 🔴 刻意**不复用** `tree.ts` 的 `TreeMenuItem`：那一个的 `action` 是 `TreeMenuAction`，
 * 七个值全是文件树的动作。让它泛化的话就得动 `tree.ts` 与 `menuFor` 的签名，而这个组件
 * 要的其实只是「一个标签 + 一个动作 + 上面要不要分隔线」这个形状——结构上兼容就够了，
 * `TreeMenuItem[]` 原样能递给 `ContextMenuItem<TreeMenuAction>[]`
 */
export interface ContextMenuItem<A> {
  action: A
  label: string
  /** 在这一项**上面**画一条分隔线（分组理由见 `tree.ts` 的 `TreeMenuItem.separator`） */
  separator?: boolean
  /**
   * 灰掉这一项（不响应点击，样式由全局那条 `button:disabled` 给）。
   *
   * 加它是为了堵住「点了没反应」这种失败方式：编辑器那份菜单里的「剪切／复制」在
   * 没有选区时本来就做不成事，灰掉比让用户点一下、然后什么都不发生要好——
   * 后者看起来像界面卡住了，而它没卡。
   */
  disabled?: boolean
}

export interface TreeMenuProps<A = TreeMenuAction> {
  /** 视口坐标，来自 `contextmenu` 事件的 clientX / clientY */
  x: number
  y: number
  items: ContextMenuItem<A>[]
  onPick: (action: A) => void
  onClose: () => void
  /**
   * 菜单项被按下时**不把焦点抢过来**。
   *
   * 编辑器那一份必须开：焦点一旦落到菜单按钮上，动作跑完就得再把焦点还给编辑器，
   * 而那一下 `contentDOM.focus()` 会让浏览器按 DOM 里的旧选区去滚——表现是「折完了，
   * 视图却跳到文件开头」。这与查找面板那条链路上踩过的坑是同一个（理由写在
   * `doc/workspace.ts` 的 `notePaneFocus` 上）。按下时就 preventDefault，焦点压根没离开
   * 编辑器，也就不存在「还回去」这一步。
   *
   * 默认关：文件树与标签条那两个宿主的焦点本来就落在被右键的那一行上，抢不抢都一样，
   * 而它们已经上线了，不顺手改行为。
   */
  keepFocus?: boolean
}

/**
 * 跟着光标弹出的上下文菜单。
 *
 * **为什么自己写而不用原生菜单**：Tauri 2 的 `menu` API 建的是**应用菜单**（挂在窗口上、
 * 有固定的层级与生命周期），不是一个跟着光标弹出的上下文菜单；而 Web 这一侧没有
 * 任何原生的「弹一个自定义菜单」的东西。菜单一共几项、形状固定，自己写只是几十行。
 *
 * ## 三个宿主
 *
 * 文件树（`Sidebar.tsx`，`A = TreeMenuAction`）、标签条（`doc/TabStrip.tsx`）与
 * 编辑器正文（`App.tsx`，剪切/复制/粘贴/全选 + 折叠全部/展开全部），各自定义自己那一个
 * 动作联合。共用的是这一层**唯一有价值的那部分**：贴边 clamp、四条关闭路径、
 * 分隔线与灰项——都是「改坏了不报错、只是菜单赖在屏幕上或飘走」的微妙逻辑，
 * 写第二份就会漂移。
 *
 * ⚠️ 名字里的 `Tree` 与 CSS 类名 `.tree-menu*` 都是历史遗留：改成中性的名字要动
 * 5 条 CSS 规则与 `Sidebar.test.tsx` 的 4 处查询，而那两处都在已上线的功能上。
 * 泛型参数默认值 `TreeMenuAction` 同理——它让文件树那一侧一行都不用改。
 *
 * ## 四条关闭路径
 *
 * 点菜单外面、按 Escape、宿主滚动、以及**选了一项**——四条都归到 `onClose`。少掉任何一条
 * 的失败方式都是「菜单赖在屏幕上」，而它赖着的时候底下那一行点不到，用户会以为界面卡死了。
 *
 * ⚠️ 「宿主滚动」那一条原先留在宿主自己手里（Sidebar 的 onScroll）。现在收进这一层，
 * 理由写在下面 `onDocScroll` 上：编辑器这个宿主的滚动容器是 CM6 自己造的，外面拿不到。
 *
 * ## ⚠️ 分隔线与危险动作
 *
 * 「移到废纸篓」刻意不做成红色、也不缩小成页脚文本：菜单里的每一项都是用户主动叫出来的，
 * 把其中一项画成危险会让整条菜单看起来不可信。它的可挽回性由提示条上那句
 * 「已移到废纸篓，可以在 Finder 里找回」来说，而不是由颜色来说。
 */
export function TreeMenu<A = TreeMenuAction>(props: TreeMenuProps<A>) {
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

  /**
   * 宿主一滚就把菜单收掉——上面那条「第四条关闭路径」，从宿主搬进这一层。
   *
   * 搬进来的理由是编辑器这个宿主**替不了自己**：CM6 的滚动容器是它自己造的
   * `.cm-scroller`，外面拿不到，而滚动的来源还不止滚轮（折叠、跳转、粘贴都会
   * `scrollIntoView`）。用 `document` 上**捕获**阶段的 scroll 就一网打尽：
   * scroll 不冒泡，但捕获看得到任何后代元素的滚动。
   *
   * 对原来两个宿主是净收益：文件树自己那条 onScroll 成了冗余（留着也无害，
   * 两个都只会调同一个 onClose），标签条那一排会横向滚，滚了菜单同样该走。
   */
  function onDocScroll() {
    props.onClose()
  }

  onMount(() => {
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onDocKey, true)
    document.addEventListener('scroll', onDocScroll, true)
  })
  onCleanup(() => {
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onDocKey, true)
    document.removeEventListener('scroll', onDocScroll, true)
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
              disabled={item.disabled}
              onMouseDown={props.keepFocus ? (e: MouseEvent) => e.preventDefault() : undefined}
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
