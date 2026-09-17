import { EditorView } from '@codemirror/view'

/**
 * 视口装饰的公共记账。
 *
 * 抽出来的原因不是「少写几行」，而是**两个装饰插件必须用同一套余量策略**：
 * `codeFontBySyntax`（代码区换字体）与 `indentGuides`（缩进引导线）都在滚动时重建
 * DecorationSet，而滚动是 M0 #1 的验收项。余量算法要是各写一份，将来调一个忘了另一个，
 * 就会出现「滚动手感时好时坏、取决于哪个插件先重建」这种查不动的问题。
 */

/**
 * 装饰范围向视口外扩的余量（像素）。
 *
 * 滚动时 `viewportChanged` **每帧都触发**，没有余量就得每帧重走一遍、重建整个
 * DecorationSet。有余量后视口在余量内移动一次都不重算，3000px/s 下约每滚过 4000px
 * 才重建一次（每档 ~5 次而不是 ~180 次）——每帧重建一份用完就扔的 DecorationSet 是纯浪费。
 */
export const DECO_MARGIN_PX = 2000

/** 当前视口在文档里覆盖的区间。visibleRanges 可能分段（有折叠时），取首尾即可 */
export function visibleSpan(view: EditorView): { from: number; to: number } | null {
  const ranges = view.visibleRanges
  if (ranges.length === 0) return null
  return { from: ranges[0]!.from, to: ranges[ranges.length - 1]!.to }
}

export interface CoveredRange {
  /** 余量内的首行行号（>= 1） */
  first: number
  /** 余量内的末行行号（<= doc.lines） */
  last: number
  /** 首行起点 */
  from: number
  /** 末行终点 */
  to: number
}

/** 视口 ± 余量对应的行区间。文档不可见时返回 null（调用方应清空装饰） */
export function coveredRange(view: EditorView): CoveredRange | null {
  const doc = view.state.doc
  const span = visibleSpan(view)
  if (!span) return null
  const margin = Math.ceil(DECO_MARGIN_PX / Math.max(1, view.defaultLineHeight))
  const first = Math.max(1, doc.lineAt(span.from).number - margin)
  const last = Math.min(doc.lines, doc.lineAt(span.to).number + margin)
  return { first, last, from: doc.line(first).from, to: doc.line(last).to }
}

/**
 * 已覆盖区间是否已经兜不住当前视口。
 *
 * 只有越界才重建——这是上面那段余量策略真正省钱的地方，重建条件写宽了就等于白留余量。
 */
export function escapesCoverage(view: EditorView, coveredFrom: number, coveredTo: number): boolean {
  const span = visibleSpan(view)
  return !!span && (span.from < coveredFrom || span.to > coveredTo)
}
