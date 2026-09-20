/**
 * 虚拟滚动的窗口算术（M2-E-5 从 `src/project/tree.ts` 抽出来）。
 *
 * 四个消费者，行高各不相同：
 *
 * | 列表 | 行高 | 谁定的 |
 * | --- | --- | --- |
 * | 文件树 | 22 | `project/tree.ts` 的 `ROW_HEIGHT` |
 * | 搜索结果 | 20 | `search/rows.ts` 的 `RESULT_ROW_HEIGHT`（一屏要装的东西更多） |
 * | `Cmd+P` 浮层 | 20 | `goto/QuickOpen.tsx` 的 `QUICK_OPEN_ROW_HEIGHT` |
 * | 大纲 | 20 | `md/outline.ts` 的 `OUTLINE_ROW_HEIGHT` |
 *
 * 后三个都是 20 而**各自定了一份常量**：它们都是「一屏要装尽量多行」的那种列表，
 * 但彼此没有关系——把大纲的行高调成 18 不该顺手把搜索结果也调了。
 *
 * 所以 `rowHeight` 是**必填**的：这个模块不该知道任何一个列表的行高，
 * 抽出来之前它默认成 22 纯粹是「当时只有一个消费者」的历史痕迹。
 *
 * ## 为什么值得抽出来
 *
 * 它原先住在 `project/` 下面，而 `search/rows.ts` 从那里 import——「搜索结果列表」依赖
 * 「文件树」模块，只因为后者先写。`search/rows.ts` 里当时就写明了：M2-E 会是第三个
 * 消费者，到那时再抽。现在就是那时。
 *
 * ## 这一层没有 Solid、没有 DOM
 *
 * 纯函数，于是窗口边界（滚到顶、滚到底、行数为零、可视区高度为零）能被单测直接穷举，
 * 不必挂 jsdom。组件那一半只负责把 `scrollTop` 与 `clientHeight` 读成 signal。
 */

/** `visibleWindow` 的结果：渲染 `[start, end)` 这几行，整列撑多高，往上偏多少 */
export interface VirtualWindow {
  start: number
  /** 不含。等于 `start` 时一行都不渲染 */
  end: number
  /** 这一批行的顶边离列表顶边多少像素 */
  offsetY: number
  /** 滚动容器里那个占位元素的总高度 */
  totalHeight: number
}

/**
 * 可视区上下各多渲染几行。
 *
 * 不设 overscan 的话，快速滚动时新行是「滚进来了才创建」，肉眼能看到一段空白跟着滚。
 * 6 行约 120–132px，比一次惯性滚动的位移小不了多少，而代价只是多 12 个 DOM 节点。
 *
 * 四个列表共用这一个值：它挡的是同一种视觉缺陷，而「多 12 个节点」的代价在四处都一样便宜。
 */
export const OVERSCAN = 6

/**
 * 算出该渲染哪几行。
 *
 * 定高行 + 直接除法，没有累计高度的前缀和数组：一万行和十万行的成本都是 O(1)。
 * 前提是**每行一样高**——任何一处让某一行撑开（换行、两行的副标题、错误提示），
 * 这套算术就当场失准，症状是滚动位置与内容对不上，不报错。
 *
 * ⚠️ `viewportHeight` 为 0 时返回 `overscan` 行而不是 0 行。这不是给 jsdom 开的后门
 * （虽然 jsdom 里 `clientHeight` 恒为 0，组件测试看到的正是头 6 行）：侧边栏被拖到
 * 看不见时多渲染 6 个节点没有任何代价，而返回 0 行会让「刚展开侧栏的那一帧」是空白的。
 */
export function visibleWindow(
  scrollTop: number,
  viewportHeight: number,
  total: number,
  rowHeight: number,
  overscan: number = OVERSCAN,
): VirtualWindow {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0, offsetY: 0, totalHeight: 0 }
  const top = Math.max(0, scrollTop)
  const first = Math.floor(top / rowHeight)
  const start = Math.max(0, Math.min(first - overscan, total))
  const shown = Math.ceil(Math.max(0, viewportHeight) / rowHeight)
  const end = Math.max(start, Math.min(total, first + shown + overscan))
  return { start, end, offsetY: start * rowHeight, totalHeight: total * rowHeight }
}
