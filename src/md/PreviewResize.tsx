import { onCleanup, type Accessor } from 'solid-js'

/**
 * 预览栏的下限。
 *
 * 再窄的话正文就放不下了：一段话每行只剩三四个字，表格、代码块、图片全部横向挤成一条。
 * 这个数不是排版理论算出来的，是「Markdown 正文还剩多少可用列」的常识值——
 * 与侧边栏的 40px 不同，那边窄了只是按钮被裁，这边窄了是**内容不可读**。
 */
export const PREVIEW_MIN_WIDTH = 240

/**
 * 编辑区的下限。
 *
 * 大概是一个「能看见一段 Markdown 的全貌」的宽度：行号槽 + 正文 + 右侧留白。
 * 比它更窄时 CM6 仍能编辑（`min-width: 0` 在 `.body` 上），但写起来只剩回到上一行的
 * 半句话，用户会开始横向滚动——那不是编辑，是受罪。
 */
export const EDITOR_MIN_WIDTH = 320

/** 键盘每按一次挪多少 */
const KEY_STEP = 24

/**
 * 把预览栏宽度夹进安全范围。
 *
 * `total` 是编辑区与预览栏此刻能分到的**总**宽度（别的面板不算）。
 * 窗口窄到连两个下限都放不下时直接回到等分：那种宽度下没有正确答案，
 * 平分是唯一还说得过去的答案，而不是让一侧先被吃光。
 *
 * ⚠️ 返回值一律取整：分屏那一侧的真实宽度可能是 380.5，存回信号再写进 CSS
 * 只会让下一次拖动的起点带上半个像素的抖动
 */
export function clampPreviewWidth(desired: number, total: number): number {
  if (total < PREVIEW_MIN_WIDTH + EDITOR_MIN_WIDTH) return Math.floor(total / 2)
  return Math.max(PREVIEW_MIN_WIDTH, Math.min(total - EDITOR_MIN_WIDTH, Math.round(desired)))
}

export interface PreviewResizeProps {
  /** 预览栏当前宽度；`null` = 还没拖过，两栏等分 */
  width: Accessor<number | null>
  /**
   * 编辑区 + 预览栏此刻的总宽度（px）。
   *
   * 由 App 从 DOM 上量：别的面板（大纲、JSON 预览）占掉的部分不能算进可分配空间。
   * 是普通函数而不是访问器——只在按下与按键那一拍读一次，不需要响应式
   */
  total: () => number
  /** 拖出（或键盘挪出）新宽度；`null` = 恢复等分 */
  onWidth: (width: number | null) => void
}

/**
 * 编辑区与预览之间那条分隔线，同时是拖拽改宽度的把手。
 *
 * ## 与 `project/SidebarResize` 同一套做法
 *
 * - 自己画出同色的 1px，`::after` 向两边各扩 3px 才算命中区；1px 宽的线没人点得中；
 * - 监听挂 window 而不是 pointer capture：按下之后指针可能甩出窗口，捕获版收不到
 *   松手，window 版永远收得到；拖到一半预览被关掉（组件卸载）时监听跟着摘；
 * - 拖动是「按下时的宽度 + 位移」，不是按 move 累加——累加会把每一拍的取整误差攒起来。
 *
 * ## 起点优先量「画出来的宽度」
 *
 * 预览栏存的是用户上一次拖出来的宽度，但窗口缩小时 CSS 会先把它压回下限
 * （见 `styles.css` 的 `.body-row.preview-resized`）。这时存着的 600px 与画出来的
 * 400px 不是一回事，从 600 起拖会让分隔线在第一次 move 时跳一下。所以按下那一拍
 * 先量 DOM，量不到（jsdom、或者结构变了）才退回存着的值 / 等分。
 *
 * ## 双击与 Enter 回到等分
 *
 * 「我刚才把它拖坏了」是这类把手的常见现场，而拖回正中间很难瞄准。
 * 双击与 Home/Enter 给一条一步到位的退路；`previewWidth` 的 `null` 就是这个含义。
 */
export function PreviewResize(props: PreviewResizeProps) {
  // 与 SidebarResize 同一条：App 传下来的 setter 引用从不变，而 `move` 这个闭包里
  // 现读 `props.onWidth` 会被 lint 当成「在追踪范围外面读响应式值」
  // eslint-disable-next-line solid/reactivity
  const onWidth = props.onWidth
  let handleEl: HTMLDivElement | undefined
  let stopDrag: (() => void) | null = null

  /** 预览栏此刻画出来的宽度；量不到就退回信号里的值，再退回等分 */
  function currentWidth(): number {
    const drawn = handleEl?.nextElementSibling?.getBoundingClientRect().width ?? 0
    if (drawn > 0) return drawn
    return props.width() ?? Math.floor(props.total() / 2)
  }

  function onResizeDown(e: PointerEvent) {
    // 不拦的话拖拽会起浏览器的文本选择，一路选中预览里的字
    e.preventDefault()
    const startX = e.clientX
    const startWidth = currentWidth()
    // 拖动期间总宽不变，量一次就够
    const total = props.total()
    const move = (ev: PointerEvent) => onWidth(clampPreviewWidth(startWidth + startX - ev.clientX, total))
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === 'Home') {
      e.preventDefault()
      onWidth(null)
      return
    }
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP
    // 把手往左 = 预览变宽：与鼠标拖拽同一个方向感
    const delta = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : null
    if (delta === null) return
    e.preventDefault()
    onWidth(clampPreviewWidth(currentWidth() + delta, props.total()))
  }

  onCleanup(() => stopDrag?.())

  // ARIA 的上下限用与实际夹取同一套边界：窗口窄到退化时，下限也跟着变成等分值，
  // 否则 valuenow 会落在 valuemin 外面
  const ariaMin = () =>
    props.total() < PREVIEW_MIN_WIDTH + EDITOR_MIN_WIDTH ? Math.floor(props.total() / 2) : PREVIEW_MIN_WIDTH
  const ariaMax = () => Math.max(ariaMin(), props.total() - EDITOR_MIN_WIDTH)

  return (
    <div
      ref={handleEl}
      class="md-preview-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整预览宽度"
      // 报「夹取之后」的值：窗口缩小后存着的宽度可能已经越界，直接读信号会让
      // valuenow 落到 valuemax 外面
      aria-valuenow={Math.round(clampPreviewWidth(props.width() ?? props.total() / 2, props.total()))}
      aria-valuemin={ariaMin()}
      aria-valuemax={ariaMax()}
      tabIndex={0}
      title="拖动改变宽度，双击恢复等分"
      onPointerDown={onResizeDown}
      onDblClick={() => onWidth(null)}
      onKeyDown={onKeyDown}
    />
  )
}
