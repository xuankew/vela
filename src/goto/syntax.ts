/**
 * 认识 CodeMirror 的那一半（M2-E-4）。
 *
 * `./symbols.ts` 是纯字符串活，这一层只负责两件事：把语法树上叫得出名字的标题节点摘下来，
 * 以及**决定要不要摘**——不是 Markdown 的文档一律回 `unsupported`，一个字都不猜。
 *
 * ## 为什么要 `ensureSyntaxTree` 而不是直接 `syntaxTree`
 *
 * `syntaxTree(state)` 回的是「解析器**到目前为止**建出来的那棵树」，而 CM6 的解析是
 * 跟着视口走的增量过程：一个一万行的文档刚打开时，树可能只覆盖了前几十行。
 * 直接读它会得到一份**残缺但看不出来残缺**的标题表——`Cmd+R` 里少几个标题不会报错，
 * 用户只会以为文档就这么长。`src/editor/setup.ts` 的 `codeFontBySyntax` 用 `parsePending`
 * 标记来补装饰，是同一个问题的另一种解法（那边可以等下一帧，这边不能：用户已经按了键）。
 *
 * `ensureSyntaxTree(state, upto, timeout)` 会**同步**把解析推到 `upto`，推不完就回 `null`。
 * 回 `null` 时退回 `syntaxTree(state)` 拿那棵半截的树：宁可列出前一半标题，
 * 也不要因为一个超大文档而让整个浮层空着。
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { languageFor } from '../editor/language'
import { headingLevel, symbolsFrom, type SymbolNode, type SymbolTable } from './symbols'

/**
 * 同步解析的时间预算（毫秒）。
 *
 * 按键到出结果之间不能有可感知的停顿，而这个调用**跑在按键处理里**。50ms 大约是
 * 「一帧半」：正常文档远在它之前就解析完了（Markdown 的解析器每行只做常量工作），
 * 真撞到上限的只有几十 MB 的单文件——那种文档在 M2-H 的只读分片里另有安排。
 */
export const SYMBOL_PARSE_TIMEOUT_MS = 50

/**
 * 取这份文档的符号表。
 *
 * `path` 为 `null` 时 `languageFor` 回 Markdown（未命名文档按笔记处理），
 * 所以「新建标签随手写几个标题再按 `Cmd+R`」是有结果的——与 `src/editor/language.ts` 的
 * 那条默认值是同一个决定，这里只是继承它。
 */
export function symbolTable(state: EditorState, path: string | null): SymbolTable {
  const choice = languageFor(path)
  if (choice.kind !== 'markdown') return { kind: 'unsupported', label: choice.label }

  const tree = ensureSyntaxTree(state, state.doc.length, SYMBOL_PARSE_TIMEOUT_MS) ?? syntaxTree(state)
  const nodes: SymbolNode[] = []
  tree.iterate({
    enter: (node) => {
      if (headingLevel(node.name) === null) return
      nodes.push({ name: node.name, from: node.from, to: node.to })
    },
  })
  return { kind: 'headings', items: symbolsFrom(nodes, state.doc) }
}
