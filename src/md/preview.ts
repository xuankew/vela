/**
 * 认识 CodeMirror 的那一半（M3-A-3）。
 *
 * `./render.ts` 收一棵 `Tree` 加一份源文本，纯字符串活；这一层只负责两件事：
 * **判语言**（不是 Markdown 就一个字都不猜）与**把树解析完整**。
 * 分工与 `src/goto/{symbols,syntax}.ts` 那一对逐字相同——纯的那一半能在 node 环境里穷举，
 * 认识 CM6 的这一半薄得只剩几行。
 * 「什么时候重渲染」不在这里：那是 `./panel.ts` 的活，预览与大纲共用一份。
 *
 * ## 为什么解析超时是 200ms 而不是 `goto/syntax.ts` 的 50ms
 *
 * 那 50ms 是**按键预算**：`Cmd+R` 按下到浮层出现之间不能有可感知的停顿，所以宁可少列几个标题。
 * 这一层跑在防抖之后，用户已经停下来 `PANEL_DEBOUNCE_MS`（150ms）了，
 * 多等一会儿换一份完整的预览是划算的。
 * 200ms 仍然是个上限而不是「等到解析完」——一份几十 MB 的单文件能把 `ensureSyntaxTree`
 * 拖到秒级，而那段时间里主线程是**同步占用**的，打字会整个卡住。
 *
 * ## ⚠️ 超时之后退回半截树，但必须把这件事说出来
 *
 * `ensureSyntaxTree` 回 `null` 时退回 `syntaxTree(state)`——那是「解析器到目前为止建出来的
 * 那棵树」，覆盖的往往只有视口附近。宁可按它渲染（预览出前半截）也不要整个空着，
 * 但**不能装作完整**：`partial: true` 会让面板上出现一句「文档太大，只预览了前面一部分」。
 * 少了这一句，用户看到的是一个「渲染出来但结尾莫名其妙没了」的预览，
 * 而他会去怀疑自己的文档写坏了。
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { languageFor } from '../editor/language'
import { renderMarkdown } from './render'

/** 同步解析的时间预算（毫秒）。与 `SYMBOL_PARSE_TIMEOUT_MS` 的差别及理由见文件头 */
export const PREVIEW_PARSE_TIMEOUT_MS = 200

/**
 * 两种结局。
 *
 * 刻意是个带 `kind` 的联合而不是 `string | null`：`null` 说不清是「这个语言没有预览」
 * 还是「有，但文档是空的」——前者该提示、后者该显示一句空状态，两种文案完全不同。
 * 与 `src/goto/symbols.ts` 的 `SymbolTable` 是同一条道理、同一种形状。
 */
export type PreviewResult =
  | { readonly kind: 'html'; readonly html: string; readonly partial: boolean }
  /** `label` 直接取自 `languageFor(path).label`，也就是状态栏上显示的那个语言名 */
  | { readonly kind: 'unsupported'; readonly label: string }

/**
 * 渲染这份文档。
 *
 * `path` 为 `null` 时 `languageFor` 回 Markdown（未命名文档按笔记处理），所以
 * 「新建标签随手写几句再打开预览」是有结果的——与 `src/editor/language.ts` 那条默认值、
 * 以及 `src/goto/syntax.ts` 的 `symbolTable` 是同一个决定，这里只是第三次继承它。
 */
export function previewHtml(state: EditorState, path: string | null): PreviewResult {
  const choice = languageFor(path)
  if (choice.kind !== 'markdown') return { kind: 'unsupported', label: choice.label }

  const source = state.doc.toString()
  const ensured = ensureSyntaxTree(state, state.doc.length, PREVIEW_PARSE_TIMEOUT_MS)
  const tree = ensured ?? syntaxTree(state)
  return { kind: 'html', html: renderMarkdown(tree, source), partial: ensured === null }
}
