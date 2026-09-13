import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
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
 * 字体分区：编辑器用 Screen Mono（等宽变体），UI 用 Screen。
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
    fontTheme,
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
