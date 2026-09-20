/**
 * 同步滚动的**纯算术**（M3-A-3）。
 *
 * 这一层不认识 CodeMirror，也不认识那份 HTML 是谁渲染的。它只回答两个问题：
 * 「源文档的某一行在预览里离顶多远」与「编辑器视口顶部现在压在第几行上」。
 * 于是这两件事里唯一容易写错的部分——插值、去重、边界——能在 node 环境里穷举，
 * 不必先挂一个真的编辑器再想办法把它滚到某个位置（jsdom 里 `scrollTop` 赋值是空操作，
 * 那条路压根走不通）。认识 CM6 与 DOM 的那一半在 `./MarkdownPreview.tsx`，薄得只剩几行。
 *
 * ## 靠什么对齐：`data-line`
 *
 * `render.ts` 给每一个块级元素都写了一个 `data-line`（1-based 源行号）。这是唯一的锚：
 * 两边的高度**不可能**成比例——一段散文在编辑器里是一行、在预览里折成三行，
 * 一个代码块的行高也与正文不同。所以「按滚动百分比对齐」是错的，
 * 错得还很隐蔽：文档开头对得上，越往下漂得越多。
 *
 * ## ⚠️ 只做单向：编辑器 → 预览
 *
 * 反向（滚预览带动编辑器）需要一道「谁先动谁说了算」的抑制窗口，否则两边互相触发，
 * 轻则抖动、重则一路滚到底停不下来。所有双向实现里最难查的 bug 都在那道窗口上，
 * 而单向**在结构上不可能**有反馈回路。Vela 的场景是「左边写、右边看」，
 * 用户滚预览通常是想回头找正文里对应的那一段——那一下他自己会在编辑器里做。
 */

/** 源文档的一行 ↔ 预览里那个位置。`top` 是相对滚动容器内容顶部的像素，不是视口坐标 */
export interface LineAnchor {
  readonly line: number
  readonly top: number
}

/**
 * 把 `(data-line 属性值, 相对顶部的像素)` 整理成一张能直接插值的锚点表。
 *
 * 三道处理，每一道都对应一个真实的输入形状：
 *
 * 1. **丢掉读不出来的**。`data-line` 是字符串，`Number.parseInt` 出 NaN 的（空串、`"abc"`）
 *    留着会让后面的排序与插值全部失序，而这种失序不报错，只是预览乱跳。
 * 2. **按 `(line, top)` 排序**。`querySelectorAll` 本来就是文档序，但这份函数不该把正确性
 *    寄在「调用方喂进来的顺序正好是对的」上——插值要求 x 单调，不满足就是静默算错。
 * 3. **同一行只留 top 最小的那一个**。🔴 重复**一定**会出现：`render.ts` 给块级元素
 *    逐个写 `data-line`，而 `<blockquote data-line="3">` 里那个 `<p data-line="3">`
 *    报的是同一行。留最小的那个 = 留外层，也就是「这一行真正开始的地方」。
 */
export function anchorTable(entries: readonly (readonly [line: string, top: number])[]): LineAnchor[] {
  const parsed: { line: number; top: number }[] = []
  for (const [raw, top] of entries) {
    const line = Number.parseInt(raw, 10)
    if (Number.isNaN(line) || !Number.isFinite(top)) continue
    parsed.push({ line, top })
  }
  parsed.sort((a, b) => (a.line === b.line ? a.top - b.top : a.line - b.line))

  const out: LineAnchor[] = []
  for (const item of parsed) {
    // 排序之后同一行的几条必然相邻，而第一条就是 top 最小的那一条
    if (out.length > 0 && out[out.length - 1]!.line === item.line) continue
    out.push(item)
  }
  return out
}

/**
 * 收集一份渲染结果里的所有锚点。
 *
 * `topOf` 是注入的：真正的实现是「元素顶边 − 滚动容器顶边 + 容器当前 scrollTop」，
 * 而那三个数在 jsdom 里全是 0。把量像素这件事推到调用方，这一半就能拿**真的 DOM**
 * （`innerHTML` 灌一份渲染结果进去）测「属性读得对不对、重复行去掉了没有」。
 */
export function collectAnchors(root: ParentNode, topOf: (el: Element) => number): LineAnchor[] {
  const entries: [string, number][] = []
  for (const el of root.querySelectorAll('[data-line]')) {
    const line = el.getAttribute('data-line')
    if (line === null) continue
    entries.push([line, topOf(el)])
  }
  return anchorTable(entries)
}

/**
 * 视口顶部压在「第几行」上，可以是小数。
 *
 * 小数那一半是手感的全部来源：只按整数行跳的话，滚一行预览就跳一整块，
 * 看着像幻灯片。CM6 的 `lineBlockAtHeight` 给的是那个行块的 `top` 与 `height`，
 * 于是「这一行被滚过去了多少」就是一次除法。
 *
 * ⚠️ `blockHeight <= 0` 必须单独挡：jsdom 里没有布局引擎，量出来就是 0，
 * 而除零得 Infinity，`topForLine` 拿到 Infinity 会一路夹到最后一个锚点——
 * 表现是「一打开预览就滚到底了」。真浏览器里不会出现，但测试会，
 * 而这条分支写不写决定了那一批用例是绿的还是莫名其妙地红
 */
export function fractionalLine(lineNumber: number, blockTop: number, blockHeight: number, scrollTop: number): number {
  if (!(blockHeight > 0)) return lineNumber
  const ratio = (scrollTop - blockTop) / blockHeight
  return lineNumber + Math.min(1, Math.max(0, ratio))
}

/**
 * 源文档的（可小数的）行号 → 预览里该滚到哪儿。
 *
 * 两个锚点之间按行号线性插值。⚠️ 这是**近似**：一段散文在预览里的高度与它在源文档里
 * 占的行数不成比例，所以插出来的位置在一个长段落内部会偏。偏的量最多是「一个块的高度」，
 * 而块与块的边界（也就是锚点本身）永远是对的——这是「行号 → 像素」这类映射能做到的上限，
 * 再准就要在预览里逐块量高度、按面积加权，那份复杂度换不来看得出的差别。
 *
 * 落在两端之外时夹到端点，不外推：文档最后一行之后没有内容，外推出来的 `top`
 * 会超出 `scrollHeight`，浏览器自己夹回来，但中间那一帧是肉眼可见的一跳。
 */
export function topForLine(anchors: readonly LineAnchor[], line: number): number {
  const first = anchors[0]
  if (first === undefined) return 0
  if (line <= first.line) return first.top
  const last = anchors[anchors.length - 1]!
  if (line >= last.line) return last.top

  // 找最后一个 `line <= 目标` 的锚点。二分而不是线性扫：一份长文档有上千个块级元素，
  // 而**每一次滚动事件**都要查一遍——线性扫会让滚动手感直接掉帧
  let low = 0
  let high = anchors.length - 1
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if (anchors[mid]!.line <= line) low = mid
    else high = mid - 1
  }
  const from = anchors[low]!
  const to = anchors[low + 1]!
  // `anchorTable` 去过重，所以分母必然 > 0
  return from.top + ((to.top - from.top) * (line - from.line)) / (to.line - from.line)
}

/**
 * 编辑器是不是已经滚到底了。
 *
 * 单独一条规则而不是交给插值：源文档的最后一行往往只是预览里的**中间**位置
 * （后面还有那个段落自己的高度），按行号对齐的话「编辑器到底了、预览还差一屏」。
 * 而「一边到底另一边也到底」是用户对同步滚动最直接的期待。
 *
 * ⚠️ 那 1px 是亚像素取整的余量：`scrollTop` 在 dPR=2 上可以是小数，
 * 而 `scrollHeight` 与 `clientHeight` 是取过整的，两者相减会差出零点几像素。
 * 不留余量的症状是「滚到底了却不认」，而它只在某些缩放比下出现。
 *
 * 内容不超过一屏时（`scrollHeight <= clientHeight`）也回 true——那时两边都只有一个位置，
 * 说是「到底了」与说「到顶了」是同一件事。
 */
export function atBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - clientHeight - scrollTop <= 1
}
