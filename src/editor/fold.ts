import {
  codeFolding,
  foldEffect,
  foldNodeProp,
  foldState,
  forceParsing,
  language,
  syntaxTree,
  syntaxTreeAvailable,
} from '@codemirror/language'
import { StateEffect, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * 「折叠全部」——有两个坑要补，而且都正好落在用户最在意的那一档上：
 *
 * 1. **折不到没解析的地方**：`syntaxFolding` 的第一句是 `if (tree.length < end) return null`
 *    （`@codemirror/language/dist/index.js:1242`）——**语法树没解析到那一行就折不起来**；
 *    而 CM6 的后台解析是**视口驱动**的（`parseWorker` 解析到 viewport 外一段就停手）。
 *    于是一份超过一屏的 JSON 上，折叠只覆盖光标附近那一段，其余照旧摊着。
 * 2. **漏掉嵌套的层**：`foldAll` 的扫描在撞到一个可折区间后把扫描位置直接跳到区间末尾
 *    （同文件 :1447），嵌套在最外层里面的区间一个都扫不到——折完只有最外层一层，
 *    用户再展开根节点，里面全摊着。「一键折叠所有节点」的期望（与 VS Code 的 Fold All
 *    同一条）是展开一层之后里面还是折着的。
 *
 * 第 1 个的补法是先把语法树推到文末再折。`forceParsing` 正是干这个的，但它默认只推到
 * `viewport.to`、且一次最多干 100ms，所以要**循环**：`upto` 显式给成 `doc.length`，
 * 每轮一小片预算，轮与轮之间让出主线程——`forceParsing` 是同步的，连着跑会把界面冻住，
 * 而会走到这里的文档恰恰可能很大（Vela 的内联上限是 4 MiB）。
 *
 * 第 2 个的补法是不用 `foldAll`，自己走树把每一层的折叠区间都取出来（`foldRanges`）。
 *
 * 预算耗尽还推不完就**认了**，只折叠已解析的那一部分：折了一半是看得见的
 * （下面还摊着），比把整个窗口卡住几秒好。
 */

/** 一轮 `forceParsing` 的时间片：够推进几万行，也短到界面不会看着像卡死 */
const PARSE_STEP_MS = 25

/** 总预算。4 MiB 的 JSON 用 lezer 解析远用不到这么多，它是兜底不是常态 */
const PARSE_BUDGET_MS = 2000

/**
 * 整篇里所有可折叠的区间，**含每一层嵌套**。
 *
 * `foldNodeProp` 的值就是库自己给节点算折叠区间的那个函数（`syntaxFolding` 在同文件 :1252
 * 也是这么问的），于是逐节点问一遍就等于把每一层都取出来——语言各自把哪些节点
 * 认作可折（JSON 的对象/数组、Markdown 的标题块……）全在那张 prop 表里，这里不抄第二份。
 * foldState 本来只是一个区间集合，嵌套的折叠区间在外层展开后**不会被丢掉**——
 * 本文件要的那条保证就落在这里。
 *
 * ⚠️ 中间那三个条件是照抄 `syntaxFolding` 自己的守卫（:1249）：语法树末尾的节点可能还是
 * 「未完成」的（最后一个孩子是 error 节点），把它们折起来等于把半截语法藏掉。
 * 树推完整（`tree.length === doc.length`）之后这个守卫恒真，不影响常态。
 */
function foldRanges(state: EditorState): { from: number; to: number }[] {
  const tree = syntaxTree(state)
  const ranges: { from: number; to: number }[] = []
  const cursor = tree.cursor()
  do {
    const fold = cursor.type.prop(foldNodeProp)
    if (!fold) continue
    const node = cursor.node
    const last = node.lastChild
    const unfinished = last !== null && last.to === node.to && last.type.isError
    if (node.to >= tree.length - 50 && tree.length !== state.doc.length && unfinished) continue
    const range = fold(node, state)
    if (range) ranges.push(range)
  } while (cursor.next())
  return ranges
}

/** 折起来了没有（一个可折区间都没找到时是 false，与 `foldAll` 同义） */
export async function foldWholeDocument(view: EditorView): Promise<boolean> {
  // 没挂语言（纯文本）就没有语法树可推，那个循环只会白跑到预算耗尽
  if (view.state.facet(language)) {
    const length = view.state.doc.length
    const deadline = performance.now() + PARSE_BUDGET_MS
    let parsedTo = syntaxTree(view.state).length
    while (!syntaxTreeAvailable(view.state, length) && performance.now() < deadline) {
      forceParsing(view, length, PARSE_STEP_MS)
      const now = syntaxTree(view.state).length
      // 这一轮没往前走就别再等：等下去也不会走完，而预算是会被耗光的
      if (now <= parsedTo) break
      parsedTo = now
      // 让出主线程。等待期间用户完全可能改文档、甚至关掉这个标签——两种都要停下来：
      // 前者会让「折的是用户没点的那份」，后者会往一个已销毁的 view 上 dispatch
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!view.dom.isConnected || view.state.doc.length !== length) break
    }
  }
  const ranges = foldRanges(view.state)
  if (ranges.length === 0) return false
  const effects: StateEffect<unknown>[] = ranges.map((range) => foldEffect.of(range))
  // 与库自己那几条命令（`foldAll` 的 `maybeEnable`）同一条路：折叠字段没挂时顺带 appendConfig。
  // 不补的话 `foldEffect` dispatch 进去没人接——这边还返回 true，折没折却什么都没发生
  if (!view.state.field(foldState, false)) effects.push(StateEffect.appendConfig.of(codeFolding()))
  view.dispatch({ effects })
  return true
}
