import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  dropCursor,
  scrollPastEnd,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  indentMore,
  indentLess,
} from '@codemirror/commands'
import {
  foldGutter,
  foldKeymap,
  indentOnInput,
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
  syntaxTree,
  syntaxTreeAvailable,
  HighlightStyle,
  indentUnit,
} from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'

/**
 * PLAN.md R11：连字在 contenteditable 语境下会导致光标定位错乱，属浏览器级问题。
 * 默认关闭，M0 需要验证这一点是否真的复现。
 */
const noLigatures = EditorView.theme({
  '&': {
    fontVariantLigatures: 'none',
    fontFeatureSettings: '"liga" 0, "calt" 0',
  },
})

/**
 * 字体分区（PLAN.md D2「按内容分字体」）：
 * - Markdown 正文 → `--vela-font-editor`（霞鹜文楷 Screen）
 * - 代码块 / 表格 → `--vela-font-code`（Maple Mono CN，等宽 2:1）
 * - UI → `--vela-font-ui`
 *
 * 通过 CSS variable 暴露，M4 做主题系统时直接接管这里。
 */
const fontTheme = EditorView.theme({
  '&': {
    fontFamily: 'var(--vela-font-editor)',
    fontSize: 'var(--vela-font-size, 14px)',
    lineHeight: 'var(--vela-line-height, 1.7)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--vela-font-editor)',
  },
  '.cm-content': {
    caretColor: 'var(--vela-accent)',
  },
})

/**
 * 非 Markdown 文档（.ts / .json / 纯文本…）整篇都是代码，不需要按节点分流。
 *
 * 刻意写成 fontTheme 的**完整替代**而不是只覆盖 fontFamily：两个主题同时挂载时
 * 谁生效取决于 CM6 的样式模块顺序，那是个隐式契约，不如让调用方二选一。
 */
const codeDocFontTheme = EditorView.theme({
  '&': {
    fontFamily: 'var(--vela-font-code)',
    fontSize: 'var(--vela-font-size, 14px)',
    lineHeight: 'var(--vela-line-height, 1.7)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--vela-font-code)',
  },
  '.cm-content': {
    caretColor: 'var(--vela-accent)',
  },
})

/**
 * 这些语法节点的内容按「代码」渲染。
 *
 * ⛔ 不能改用 CSS 按 token 分流：`@lezer/markdown` **没有任何 monospace 标签映射**
 * （实测其 dist 里搜不到 `tags.monospace`），而且带语言标签的围栏会被 `codeLanguages`
 * 嵌套子语言接管，内部 token 变成 keyword/string，`.tok-monospace` 压根不会出现。
 * 唯一可靠的办法是按节点名匹配、给整行打装饰。
 */
const CODE_BLOCK_NODES = new Set(['FencedCode', 'CodeBlock', 'Table'])

const codeLineDeco = Decoration.line({ class: 'vela-code' })

/**
 * 装饰范围向视口外扩的余量（像素）。
 *
 * 滚动时 `viewportChanged` **每帧都触发**，没有余量就得每帧重走一遍语法树、重建整个
 * DecorationSet。有余量后视口在余量内移动一次都不重算，3000px/s 下约每滚过 4000px
 * 才重建一次（每档 ~5 次而不是 ~180 次）。
 *
 * ⚠️ 别把这条当成 M0 #1 那个 60fps→55fps 退化的修复——它不是。节流把重建削掉了一个
 * 数量级，帧率**一位小数都没动**（55.7/54.5/56.1/55.3 → 55.6/55.2/55.8/54.1）；再把本
 * 插件整个摘掉也还是 55.70fps。两个组件都已排除，那次退化另有原因，见 PLAN.md §3.2 #1。
 * 余量本身仍然该留：每帧重建一份用完就扔的 DecorationSet 是纯浪费。
 */
const DECO_MARGIN_PX = 2000

/** 当前视口在文档里覆盖的区间。visibleRanges 可能分段（有折叠时），取首尾即可 */
function visibleSpan(view: EditorView): { from: number; to: number } | null {
  const ranges = view.visibleRanges
  if (ranges.length === 0) return null
  return { from: ranges[0].from, to: ranges[ranges.length - 1].to }
}

function buildCodeDecorations(view: EditorView, from: number, to: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const marked = new Set<number>()
  // 单个连续区间，而不是逐段遍历 visibleRanges：iterate 按文档顺序访问，
  // 行号天然递增，RangeSetBuilder「必须升序 add」的要求自动满足，
  // 不用再依赖「多段之间不会乱序」这个隐含前提。
  syntaxTree(view.state).iterate({
    from,
    to,
    enter: (node) => {
      if (!CODE_BLOCK_NODES.has(node.name)) return
      // 逐行盖过去而不是只标节点首行：代码块跨多行，每行都要换字体
      for (let pos = node.from; pos <= node.to; ) {
        const line = view.state.doc.lineAt(pos)
        if (!marked.has(line.number)) {
          marked.add(line.number)
          builder.add(line.from, line.from, codeLineDeco)
        }
        pos = line.to + 1
      }
      // 子节点交给嵌套的子语言树，再往里走没有意义
      return false
    },
  })
  return builder.finish()
}

export const codeFontBySyntax = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    /** 已装饰的文档区间。视口仍在其中且文档没变时不重算 */
    private coveredFrom = 0
    private coveredTo = -1
    /** 上次重建时语法树还没解析完，装饰是残缺的，等解析追上后要补一次 */
    private parsePending = false

    constructor(view: EditorView) {
      this.rebuild(view)
    }

    update(u: ViewUpdate) {
      if (u.docChanged) {
        this.rebuild(u.view)
        return
      }
      const span = visibleSpan(u.view)
      if (u.viewportChanged && span && (span.from < this.coveredFrom || span.to > this.coveredTo)) {
        this.rebuild(u.view)
        return
      }
      // 语法树是后台增量解析的：重建那一刻可能还没解析到 coveredTo，那次装饰是残缺的。
      // 视口不动也得等解析追上后补一次，否则用户停在一个没解析完的位置上，
      // 代码块会一直显示成正文字体，直到他滚动才纠正。
      if (this.parsePending && syntaxTreeAvailable(u.state, this.coveredTo)) this.rebuild(u.view)
    }

    private rebuild(view: EditorView) {
      const doc = view.state.doc
      const span = visibleSpan(view)
      if (!span) {
        this.coveredFrom = 0
        this.coveredTo = -1
        this.parsePending = false
        this.decorations = Decoration.none
        return
      }
      const margin = Math.ceil(DECO_MARGIN_PX / Math.max(1, view.defaultLineHeight))
      const first = Math.max(1, doc.lineAt(span.from).number - margin)
      const last = Math.min(doc.lines, doc.lineAt(span.to).number + margin)
      this.coveredFrom = doc.line(first).from
      this.coveredTo = doc.line(last).to
      this.decorations = buildCodeDecorations(view, this.coveredFrom, this.coveredTo)
      this.parsePending = !syntaxTreeAvailable(view.state, this.coveredTo)
    }
  },
  { decorations: (v) => v.decorations },
)

/** M0 用的高亮配色。正式主题系统在 M4，这里只求能看清 token 边界。 */
const m0Highlight = HighlightStyle.define([
  { tag: tags.heading, color: '#7aa2f7', fontWeight: '700' },
  { tag: tags.heading1, fontSize: '1.4em' },
  { tag: tags.heading2, fontSize: '1.25em' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#7dcfff', textDecoration: 'underline' },
  { tag: tags.url, color: '#9ece6a' },
  { tag: tags.monospace, color: '#bb9af7' },
  { tag: tags.quote, color: '#565f89', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#bb9af7' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.string, color: '#9ece6a' },
  { tag: tags.number, color: '#ff9e64' },
  { tag: tags.bool, color: '#ff9e64' },
  { tag: tags.comment, color: '#565f89', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#7aa2f7' },
  { tag: tags.typeName, color: '#2ac3de' },
  { tag: tags.propertyName, color: '#73daca' },
  { tag: tags.definition(tags.variableName), color: '#c0caf5' },
  { tag: tags.variableName, color: '#c0caf5' },
  { tag: tags.contentSeparator, color: '#565f89' },
  { tag: tags.list, color: '#e0af68' },
  { tag: tags.processingInstruction, color: '#565f89' },
])

export interface EditorSetupOptions {
  /** 是否开启自动换行。M0 需要分别在开/关两种状态下测滚动抖动（风险 R9） */
  lineWrap?: boolean
  /** 是否启用 Markdown + 子语言懒加载 */
  markdownMode?: boolean
  doc?: string
}

/**
 * 组装 M0 的编辑器扩展集。
 *
 * 刻意不使用 `basicSetup`：M0 要精确知道每一个扩展的成本，
 * 而且 basicSetup 里含 M0 不需要的部分（如 lint gutter）。
 */
export function buildExtensions(options: EditorSetupOptions = {}): Extension[] {
  const { lineWrap = true, markdownMode = true } = options

  const exts: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    syntaxHighlighting(m0Highlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    noLigatures,
    scrollPastEnd(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
      { key: 'Tab', run: indentMore },
      { key: 'Shift-Tab', run: indentLess },
    ]),
  ]

  if (markdownMode) {
    // languages 提供子语言懒加载：代码块内的 ts/rust/json 按需解析
    exts.push(markdown({ base: markdownLanguage, codeLanguages: languages }))
    // 正文用文楷，代码块/表格行由装饰换成等宽字体
    exts.push(fontTheme, codeFontBySyntax)
  } else {
    exts.push(codeDocFontTheme)
  }

  if (lineWrap) {
    exts.push(EditorView.lineWrapping)
  }

  return exts
}

export function createEditor(parent: HTMLElement, options: EditorSetupOptions = {}): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc ?? '',
      extensions: buildExtensions(options),
    }),
  })
}
