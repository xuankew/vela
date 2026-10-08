import { onCleanup, type Accessor } from 'solid-js'

/**
 * 拖得动的下限。
 *
 * 低于它**不会崩**：宽度存在 App 的信号里，分隔线也还在，随时能拖回来。窄到这个程度时
 * 两栏各自的表现：树那边没事——`.tree-scroll` 是 `overflow-x: hidden`，行自己裁；
 * 头部那三个按钮（＋ ↻ ×，不收缩，加内边距约 79px）会被 `.sidebar-head` 的
 * `overflow: hidden` 裁掉一部分（× 可能点不到，但 Mod+B 与状态栏都能收起/展开侧边栏）。
 * ⚠️ 那道 `overflow: hidden` 是这条下限能存在的前提：没有它，按钮会溢出头部、
 * 盖到右边的正文区上面去
 */
export const SIDEBAR_MIN_WIDTH = 40

/**
 * 把宽度夹进 `[SIDEBAR_MIN_WIDTH, 窗口的一半]`。
 *
 * 上限是「窗口的一半」：拖过一半之后正文区比侧边栏还窄，「编辑」这件事就不成立了。
 *
 * ⚠️ 上限是**跟着窗口走**的值，而宽度是存下来的值：窗口缩过之后存着的宽度可能越界，
 * 所以 App 在 window resize 时把它重新夹一次，而不是只在拖的时候夹
 */
export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(Math.floor(window.innerWidth / 2), width))
}

export interface SidebarResizeProps {
  /** 当前宽度。是访问器而不是值：只有按下那一拍需要读它，不值得为此重渲染 */
  width: Accessor<number>
  onWidth: (width: number) => void
}

/**
 * 侧边栏右缘那条分隔线，同时是拖拽改宽度的把手。
 *
 * ## 它在布局上等于没发生
 *
 * `.body-row` 的分隔线靠 `gap: 1px` 露出底色（见 styles.css 那一整段的理由：border 参与
 * 盒模型，而 CM6 靠父容器的 clientHeight 算可视行数）。这个把手自己画出同色的 1px，
 * 再用 `-1px` 外边距吃掉两侧各 1px 的 gap——于是这条线与分屏之间那条逐像素相同。
 * 真正能抓的地方是 `::after` 向两边各扩的 3px：1px 宽的命中区没人点得中。
 *
 * ## 监听挂 window 而不是 pointer capture
 *
 * 按下之后指针可能甩到窗口外面去：捕获版在那期间收不到 move、松手也收不到 up，
 * 得再补一套兜底；window 版松手永远收得到。与 TreeMenu 把 mousedown 挂 document 同一条取舍。
 *
 * ⚠️ 拖到一半侧边栏被收起（Mod+B）的话组件会卸载，那两个 window 监听必须跟着走，
 * 否则下一次指针移动会去改一个已经不存在的侧边栏的宽度
 */
export function SidebarResize(props: SidebarResizeProps) {
  // `onWidth` 与 Sidebar 的 `onNotice` 同一条：App 传下来的是 signal setter，引用从不变。
  // 留在 `props.onWidth` 上现读的话，`move` 那个闭包会被 lint 当成「在追踪范围外面读响应式值」
  // eslint-disable-next-line solid/reactivity
  const onWidth = props.onWidth
  let stopDrag: (() => void) | null = null

  function onResizeDown(e: PointerEvent) {
    // 不拦的话拖拽会起浏览器的文本选择，一路选中标签条上的字
    e.preventDefault()
    const startX = e.clientX
    const startWidth = props.width()
    const move = (ev: PointerEvent) => onWidth(clampSidebarWidth(startWidth + ev.clientX - startX))
    const up = () => stopDrag?.()
    stopDrag = () => {
      stopDrag = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  onCleanup(() => stopDrag?.())

  return <div class="sidebar-resize" onPointerDown={onResizeDown} />
}
