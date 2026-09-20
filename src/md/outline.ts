/**
 * 大纲面板的**纯逻辑**（M3-A-2）：把一串平的标题摊成带缩进与折叠状态的行数组。
 *
 * 与 `src/project/tree.ts` 同一套分工：这一层不含 signal、不含 IPC、不含 DOM，
 * 状态（折叠了哪几行）住在 store 里、每次改都换一个新 `Set` 传进来。于是「层级算错了」
 * 「折叠之后少了一行」这类全是边界的事能在 node 环境里穷举。
 *
 * ## ⛔ 这里不解析 Markdown
 *
 * 入参是 `src/goto/symbols.ts` 的 `DocSymbol[]`，也就是 `Cmd+R` 用的**同一份**符号表。
 * 这不是省事：大纲与 `Cmd+R` 一旦各有各的标题提取，「浮层里看得见的标题、大纲里没有」
 * 就成了必然会出现的分歧，而那种分歧没法解释。复用之后它在结构上不可能发生。
 * 认识 CodeMirror 的那一半在 `src/goto/syntax.ts` 的 `symbolTable`，这里连它都不认识。
 *
 * ## 缩进按**树的深度**，不按标题级别
 *
 * `# 甲` 后面直接跟 `### 丙` 是常见写法（作者跳了级）。按级别缩进的话丙会空出一格
 * 什么都没有的缩进；按树深度它是甲的第一个子项，缩进一格。整篇只用 `##` / `###`
 * 的文档同理——按级别缩进会让整个面板白空两格。级别本身仍然留在 `level` 字段里，
 * 要显示「H2」这种标记的时候用它。
 */

import type { DocSymbol } from '../goto/symbols'

/**
 * 大纲里的一行。扁平化之后只有「第几行、缩进多深」，没有父子指针——
 * 与 `TreeRow` 同一个形状，理由也同一个：虚拟滚动要的是一个数组。
 */
export interface OutlineRow {
  /**
   * 这一行的身份，折叠状态就挂在它上面。
   *
   * 🔴 **不是偏移量**：大纲跟着文档改而重算，用户每敲一个字，后面所有标题的 `pos` 都会变。
   * 拿 `pos` 当键的话折叠状态活不过一次输入——面板会在打字时自己展开。
   *
   * 用的是「从根到这一行的标题名链」，于是普通编辑（改正文、改代码块）动不了它。
   * ⚠️ 代价说清楚：**改一个标题的文字，它自己与它整个子树的折叠状态都会丢**，
   * 因为键就是那些文字拼出来的。这是刻意接受的——比「打一个字就全展开」便宜得多。
   *
   * 分隔符是 `\n`，而它是安全的：`symbolsFrom` 里的 `normalize` 已经把标题内部的
   * 换行全压成空格了，所以名字里不可能出现 `\n`。
   * ⛔ 别换成 `/` 或 `·`——标题里那些字符太常见，换上去就等于给键开了碰撞的口子。
   */
  readonly key: string
  readonly name: string
  /** 1–6，作者在源文档里写的那个级别 */
  readonly level: number
  /** 缩进层级，0 起。⚠️ 与 `level` 不是一回事，见文件头 */
  readonly depth: number
  /** 标题在文档里的起点，点击跳转交给 `EditorController.reveal` */
  readonly pos: number
  /** 下面有没有子标题。没有就不画折叠箭头——画了也点不出东西 */
  readonly hasChildren: boolean
  /** 这一行是不是收起的。只对 `hasChildren` 为真的行有意义 */
  readonly folded: boolean
}

/**
 * 大纲的行高。
 *
 * 定高行是 `src/ui/virtual.ts` 那套 O(1) 窗口算术的前提，而且**只有一个真相**：
 * 面板把它注入成 CSS 变量，样式表里不许出现第二个字面量。
 * 取 20 与搜索结果、`Cmd+P` 浮层一致：大纲也是「一屏要装尽量多行」的那种列表。
 */
export const OUTLINE_ROW_HEIGHT = 20

/**
 * 摊成扁平行数组。**收起的子树整个不出现**在结果里——虚拟滚动的窗口算术建立在
 * 「数组长度就是总行数」上，把隐藏行留在数组里再靠渲染时跳过，会让滚动条高度对不上。
 *
 * @param headings `symbolsFrom` 的输出，文档顺序，⛔ 不要重排：大纲列的是结构，
 *   而结构的信息量一半在层级、一半在先后
 * @param folded 收起的那些行的 `key`
 */
export function flattenOutline(headings: readonly DocSymbol[], folded: ReadonlySet<string>): OutlineRow[] {
  const all = nest(headings)
  const rows: OutlineRow[] = []
  // 最近一个「被收起的祖先」的深度。null = 当前没有任何一行的祖先处于收起状态
  let hiddenBelow: number | null = null
  for (const item of all) {
    if (hiddenBelow !== null) {
      if (item.depth > hiddenBelow) continue
      hiddenBelow = null
    }
    const isFolded = folded.has(item.key)
    rows.push({ ...item, folded: isFolded })
    if (isFolded) hiddenBelow = item.depth
  }
  return rows
}

/** 摊平之前的中间形状：`hasChildren` 已经算好，`folded` 还没有 */
type Nested = Omit<OutlineRow, 'folded'>

/**
 * 建层级 + 算 `hasChildren`。
 *
 * `hasChildren` 的判据是「**下一行**的深度比我大」，而不是「我下面有没有东西」：
 * 子项紧跟在父项后面、且深度只可能比父项大 1，所以扫一遍相邻两行就够了，
 * 不必先建一棵真的树再回头遍历。
 */
function nest(headings: readonly DocSymbol[]): Nested[] {
  const out: Nested[] = []
  /** 祖先链。栈顶就是当前父项；`level` 用来决定弹到哪儿 */
  const stack: { level: number; key: string }[] = []
  /** 同一个父项下的同名标题计数，用来把键做唯一 */
  const seen = new Map<string, number>()

  for (const heading of headings) {
    // `>=`：同级的是**兄弟**不是子项，所以要先弹掉
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) stack.pop()
    const parent = stack[stack.length - 1]
    const key = uniqueKey(parent === undefined ? '' : parent.key, heading.name, seen)
    stack.push({ level: heading.level, key })
    out.push({
      key,
      name: heading.name,
      level: heading.level,
      depth: stack.length - 1,
      pos: heading.pos,
      hasChildren: false,
    })
  }

  for (let i = 0; i < out.length; i++) {
    const row = out[i]
    const next = out[i + 1]
    if (row !== undefined && next !== undefined && next.depth > row.depth) {
      // 就地替换而不是重建整个数组：`out` 是本函数的私产，还没交出去
      out[i] = { ...row, hasChildren: true }
    }
  }
  return out
}

/**
 * 一行在**它那个父项下**的唯一键。
 *
 * 为什么要带计数：同名兄弟极常见（`## 用法` 出现在每个章节下面）。不加区分的话
 * 它们共用一个键，折叠其中一个会把所有同名的兄弟一起收起来——而用户看不到这件事
 * 是怎么发生的，只会觉得面板抽风。
 */
function uniqueKey(parentKey: string, name: string, seen: Map<string, number>): string {
  const base = parentKey === '' ? name : `${parentKey}\n${name}`
  const nth = seen.get(base) ?? 0
  seen.set(base, nth + 1)
  return nth === 0 ? base : `${base}\n#${nth}`
}

/**
 * 切换一行的折叠状态，返回**新的** `Set`。
 *
 * ⚠️ 就地 `add` / `delete` 再传回同一个引用，在 Solid 里等于什么都没变——
 * 依赖它的 memo 不会重算，面板不刷新，而状态其实已经改了。这种「状态对了、界面没动」
 * 是最难查的一类。所以这个函数存在的理由一半是集中口径、一半是逼出一次换引用。
 */
export function toggleFold(folded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(folded)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/**
 * 把折叠集合里**已经不存在**的键清掉。
 *
 * 为什么要这一步：键是标题名链，改标题就会留下一批再也匹配不上的旧键。
 * 不清的话它们只是白占内存（一份笔记里几十条，量级上无所谓），真正的问题是
 * 「全部展开」这种动作会变得说不清——用户按下去之后集合里还有东西，
 * 而面板上看不出区别。所以清理的时机是**重算之后**，让集合始终只含当下有效的键。
 *
 * 🔴 收的是 `headings` 而**不是** `flattenOutline` 的输出：后者已经跳过了收起的子树，
 * 拿它对账会把「父项收着、子项也收着」里那个子项的键当成失效清掉，
 * 于是展开父项之后子项莫名其妙是摊开的——用户收过的那一格自己弹回去了。
 *
 * ⚠️ 没有变化时返回**原来那个引用**，这样调用方可以拿 `===` 判断要不要触发更新。
 */
export function pruneFold(folded: ReadonlySet<string>, headings: readonly DocSymbol[]): ReadonlySet<string> {
  const live = new Set(nest(headings).map((row) => row.key))
  let stale = false
  for (const key of folded) {
    if (!live.has(key)) {
      stale = true
      break
    }
  }
  if (!stale) return folded
  const next = new Set<string>()
  for (const key of folded) {
    if (live.has(key)) next.add(key)
  }
  return next
}
