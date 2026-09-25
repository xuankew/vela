/**
 * 认识 CodeMirror 的那一半（M2-E-4）。
 *
 * `./symbols.ts` 是纯字符串活，这一层只负责三件事：把语法树上候选的名字节点摘下来（连它们的
 * 直系父节点一起），**决定要不要摘**（没有规则表的语言一个字都不猜），以及替纯层问一句
 * 「这门语言的语法包到底装上没有」。
 *
 * ## 为什么要 `ensureSyntaxTree` 而不是直接 `syntaxTree`
 *
 * `syntaxTree(state)` 回的是「解析器**到目前为止**建出来的那棵树」，而 CM6 的解析是
 * 跟着视口走的增量过程：一个一万行的文档刚打开时，树可能只覆盖了前几十行。
 * 直接读它会得到一份**残缺但看不出来残缺**的清单——`Cmd+R` 里少几个符号不会报错，
 * 用户只会以为文档就这么长。`src/editor/setup.ts` 的 `codeFontBySyntax` 用 `parsePending`
 * 标记来补装饰，是同一个问题的另一种解法（那边可以等下一帧，这边不能：用户已经按了键）。
 *
 * `ensureSyntaxTree(state, upto, timeout)` 会**同步**把解析推到 `upto`，推不完就回 `null`。
 * 回 `null` 时退回 `syntaxTree(state)` 拿那棵半截的树：宁可列出前一半符号，
 * 也不要因为一个超大文档而让整个浮层空着。
 */

import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { languageFor } from '../editor/language'
import {
  codeRulesFor,
  codeSymbolsFrom,
  headingLevel,
  symbolsFrom,
  type CodeRule,
  type CodeSymbolNode,
  type SymbolNode,
  type SymbolTable,
} from './symbols'

/**
 * 同步解析的时间预算（毫秒）。
 *
 * 按键到出结果之间不能有可感知的停顿，而这个调用**跑在按键处理里**。50ms 大约是
 * 「一帧半」：正常文档远在它之前就解析完了（Markdown 的解析器每行只做常量工作），
 * 真撞到上限的只有几十 MB 的单文件——那种文档在 M2-H 的只读分片里另有安排。
 */
export const SYMBOL_PARSE_TIMEOUT_MS = 50

/** 见文件头：先要一棵尽量完整的树，撞穿预算就退回手头那棵半截的 */
function parseTree(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, SYMBOL_PARSE_TIMEOUT_MS) ?? syntaxTree(state)
}

/**
 * 取这份文档的符号表。
 *
 * `path` 为 `null` 时 `languageFor` 回 Markdown（未命名文档按笔记处理），
 * 所以「新建标签随手写几个标题再按 `Cmd+R`」是有结果的——与 `src/editor/language.ts` 的
 * 那条默认值是同一个决定，这里只是继承它。
 */
export function symbolTable(state: EditorState, path: string | null): SymbolTable {
  const choice = languageFor(path)
  if (choice.kind === 'markdown') {
    return { kind: 'headings', items: symbolsFrom(headingNodes(state), state.doc) }
  }

  const rules = choice.kind === 'code' ? codeRulesFor(choice.label) : null
  if (rules === null) return { kind: 'unsupported', label: choice.label }
  // 语法包还没懒加载到位：那一刻 `languageExtensions` 只装了字体分区（setup.ts 里
  // `support === null` 那一条），树是空的，一个节点都摘不到。
  // 🔴 回的必须是 `unsupported` 而不是空清单：「TypeScript 还没有符号表」此刻是实话
  // （现在确实没有），而「这份文档里没有匹配的符号」会把「还没装上」说成「这份文件里没有」
  if (state.facet(language) === null) return { kind: 'unsupported', label: choice.label }
  return { kind: 'code', items: codeSymbolsFrom(codeNodes(state, rules), state.doc, rules) }
}

/**
 * `pos` **正指着**的那个词。`Mod+Alt+D` 传的是光标位，`Cmd+Click` 传的是
 * `view.posAtCoords(...)` 那个点击位（view 的方法，它要量排版，state 上没有）——
 * 同一个函数，两种触发源，
 * ⛔ 不是两份取词逻辑（否则「点击能跳而快捷键跳不了」这类不一致没有地方拦住它）。
 *
 * 只用 `state.wordAt(pos)` 一个调用，⛔ 不再补 `wordAt(pos - 1)`：CM6 的实现
 * （`@codemirror/state` 的 `wordAt`）从 `pos` **同时向左向右**扫同一行的字类，
 * 所以停在 `helper|` 的右边界时它回的就是 `helper`。多退一格反而会踩到一个
 * 真实的新问题——`pos - 1` 可能落到上一行，那一行的词不是用户指着的那个。
 *
 * ⚠️ 回 `null` 的两种情况都是实话，不是失败：`pos` 停在**空白或标点**上，以及文档是空的。
 * 所以每一个调用方都要决定「不接的时候说什么」——快捷键要说什么，见下面那段字类表
 *
 * ⚠️ 字类表是 `@codemirror/state` 的 `/[\p{Alphabetic}\p{Number}_]/u`，**CJK 算字母**，
 * 所以在中文里拿到的是**整串连续的中文**（`# 项目结构` 里回 `项目结构`），
 * 而不是那个位置上的一个字。这对「按词搜索」是好事（中文笔记里不用先选中），
 * 对「跳到定义」则是拿到一个必然不存在的符号名——`CODE_RULES` 里没有中文标识符
 */
export function wordAt(state: EditorState, pos: number): string | null {
  const at = state.wordAt(pos)
  if (at === null) return null
  return state.sliceDoc(at.from, at.to)
}

/** 光标**正指着**的那个词，见 `wordAt` */
export function wordUnderCaret(state: EditorState): string | null {
  return wordAt(state, state.selection.main.head)
}

/** 语法树上叫得出名字的标题节点 */
function headingNodes(state: EditorState): SymbolNode[] {
  const nodes: SymbolNode[] = []
  parseTree(state).iterate({
    enter: (node) => {
      if (headingLevel(node.name) === null) return
      nodes.push({ name: node.name, from: node.from, to: node.to })
    },
  })
  return nodes
}

/**
 * 语法树上的候选名字节点，**连直系父节点名一起**摘下来。
 *
 * `wanted` 是规则表里出现过的节点名——先按名字筛掉绝大多数节点，才去碰 `node.node.parent`。
 * 那一步不是可有可无的优化：`SyntaxNodeRef.node` 会为游标当前位置造一个节点对象，
 * 而遍历整棵一万行的树意味着几万次这样的构造。
 *
 * 真正的「这条算不算一个符号」判断（父节点比名单）留在 `codeSymbolsFrom` 里做，
 * 所以这里多摘的、以及父节点不在名单上的，都会在纯层那一步被挑出去。
 */
function codeNodes(state: EditorState, rules: readonly CodeRule[]): CodeSymbolNode[] {
  const wanted = new Set(rules.map((rule) => rule.node))
  const nodes: CodeSymbolNode[] = []
  parseTree(state).iterate({
    enter: (node) => {
      if (!wanted.has(node.name)) return
      nodes.push({ name: node.name, from: node.from, to: node.to, parent: node.node.parent?.name ?? '' })
    },
  })
  return nodes
}
