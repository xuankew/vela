import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { indentUnit } from '@codemirror/language'
import { coveredRange, escapesCoverage } from './viewport'

/**
 * 缩进引导线。
 *
 * **为什么用 mark 装饰而不是按像素画线**：正文字体是霞鹜文楷 Screen，它的拉丁部分**不是
 * 等宽字体**（PLAN.md D2 / 项目硬约束），任何「列号 × 字符宽」的换算在它上面都是错的，
 * 而 `view.defaultCharacterWidth` 只是个平均值。mark 包住行首真实的空白字符、由浏览器
 * 定位边框，天然跟着字体走；顺带的好处是它在 jsdom 里可断言（像素方案在 jsdom 里连
 * 字符宽都拿不到，等于不可测）。
 *
 * **画线规则**：把行首空白按 `indentUnit` 切成若干档，每档一个 `border-left`，于是
 * N 档缩进得到 N 条线，分别落在第 0、1…N-1 档的左边缘。一个 tab 算一整档；凑不满一档的
 * 零头不画——混合缩进的行本来就没有稳定的「档」可言，硬画出来的线会随字体宽度漂。
 */
const guideMark = Decoration.mark({ class: 'vela-indent-guide' })

/** 行首空白的长度（只数空格与 tab，其余字符一律算正文起点） */
function indentWidth(text: string): number {
  let i = 0
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  return i
}

/** 导出只为单测：分档规则（tab、凑不满一档的零头）是这里唯一有逻辑的部分，
 *  而它只依赖 EditorState，不需要 view，也就不需要 jsdom 的布局。 */
export function buildGuides(state: EditorState, firstLine: number, lastLine: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const unit = state.facet(indentUnit)
  // indentUnit 是 tab 时「一档 = 一个字符」；否则一档就是它的长度（本项目是两空格）
  const spacesPerLevel = unit.startsWith('\t') ? 1 : Math.max(1, unit.length)

  for (let n = firstLine; n <= lastLine; n++) {
    const line = state.doc.line(n)
    const text = line.text
    const wsEnd = indentWidth(text)
    // 逐档推进。RangeSetBuilder 要求 from 升序、同 from 时 to 升序，
    // 外层按行号递增、内层按 offset 递增，两个条件自动满足。
    for (let offset = 0; offset < wsEnd;) {
      const step = text[offset] === '\t' ? 1 : spacesPerLevel
      if (offset + step > wsEnd) break
      builder.add(line.from + offset, line.from + offset + step, guideMark)
      offset += step
    }
  }
  return builder.finish()
}

export const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    private coveredFrom = 0
    private coveredTo = -1

    constructor(view: EditorView) {
      this.rebuild(view)
    }

    update(u: ViewUpdate) {
      if (u.docChanged) {
        this.rebuild(u.view)
        return
      }
      // 只在视口越出余量时重建：viewportChanged 每帧都触发，无条件重建等于把余量白留。
      // 与 codeFontBySyntax 用同一套余量策略（见 ./viewport 的模块注释）。
      if (u.viewportChanged && escapesCoverage(u.view, this.coveredFrom, this.coveredTo)) this.rebuild(u.view)
    }

    private rebuild(view: EditorView) {
      const covered = coveredRange(view)
      if (!covered) {
        this.coveredFrom = 0
        this.coveredTo = -1
        this.decorations = Decoration.none
        return
      }
      this.coveredFrom = covered.from
      this.coveredTo = covered.to
      this.decorations = buildGuides(view.state, covered.first, covered.last)
    }
  },
  { decorations: (v) => v.decorations },
)
