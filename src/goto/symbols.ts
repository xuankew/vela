/**
 * 「这份文档里有哪些可以跳的地方」（M2-E-4，`Cmd+R`）。
 *
 * 与 `src/search/reveal.ts` 同一套分工：**这一半刻意不认识 CodeMirror**。入参是只有
 * `sliceString` 的结构类型（CM6 的 `Text` 天然满足），节点是已经摘出来的 `{name, from, to}`。
 * 于是「标题文字抠得对不对」这件全是字符串边界的事能在 node 环境里穷举，
 * 不必先造一个真的 `EditorState`，也不会把「抠错了」与「语法树没解析完」两种失败混在一条用例里。
 * 认识 CM6 的那一半在 `./syntax.ts`，薄得只剩一次 `tree.iterate`。
 *
 * ## 范围只有 Markdown 标题，这是**决定**不是遗漏
 *
 * 其他语言一律回 `unsupported`，由浮层如实说「这个语言还没有符号表」。
 * ⛔ 不能退化成全文搜索：那会让 `Cmd+R` 与 `Cmd+Shift+F` 变成两个入口一个行为，
 * 而用户按 `Cmd+R` 时想要的是**结构**。也 ⛔ 不能就地长出一套代码解析——
 * 那是 LSP 的活，而 v1 的非目标里第一条就是「不做代码智能」。
 */

/** 一个已经从语法树上摘下来的节点。`name` 是 Lezer 的节点名，不是标题文字 */
export interface SymbolNode {
  readonly name: string
  readonly from: number
  readonly to: number
}

/** CM6 `Text` 的一个最小结构子集：只用到「把这段位置读成字符串」 */
export interface SymbolDoc {
  sliceString(from: number, to: number): string
}

/** 符号表里的一行 */
export interface DocSymbol {
  /** 显示用的标题文字，已经去掉井号与首尾空白 */
  readonly name: string
  /** 1–6。浮层按它缩进，让文档结构一眼看得出层级 */
  readonly level: number
  /** 标题**在文档里的起点**，交给 `EditorController.reveal` 用 */
  readonly pos: number
}

/**
 * `Cmd+R` 的两种结局。
 *
 * 刻意是个带 `kind` 的联合而不是 `DocSymbol[] | null`：`null` 说不清是
 * 「这个语言没有符号表」还是「有，但一个标题都没有」——前者该提示、后者该显示空列表，
 * 两种 UI 文案完全不同，合成一个值就只能在调用点靠猜。
 */
export type SymbolTable =
  | { readonly kind: 'headings'; readonly items: readonly DocSymbol[] }
  /** `label` 直接取自 `languageFor(path).label`，也就是状态栏上显示的那个语言名 */
  | { readonly kind: 'unsupported'; readonly label: string }

/**
 * 节点名 → 标题级别。
 *
 * Setext 的级别**已经写在节点名里**了（`@lezer/markdown` 分 `SetextHeading1` / `SetextHeading2`），
 * 所以不用去嗅下划线是 `=` 还是 `-`——那是把解析器已经做过的事再做一遍，而且做得更差
 * （`===` 与 `-` 的判定还要考虑惰性链接 `foo\n- bar`）。
 */
const HEADING_LEVEL: Readonly<Record<string, number>> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
}

/** 这个节点名是不是标题；不是就回 `null`。语法树遍历那一半靠它决定要不要摘 */
export function headingLevel(nodeName: string): number | null {
  const level = HEADING_LEVEL[nodeName]
  return level === undefined ? null : level
}

/**
 * ATX 标题的文字部分。
 *
 * 照着 CommonMark 的两条规则做，而不是「把井号都删了」：
 * - 开井号串后面**可以没有空白**（`#Title` 不是标题，但 `#\tTitle` 是，所以吃 `[ \t]*`）
 * - 闭井号串**必须前面有空白**，所以 `### C#` 的尾巴不是闭合串而是标题内容的一部分。
 *   这条最容易写错：写成 `/#+$/` 会把 `### C#` 抠成 `### C`，而 `C#` 恰好是个真语言名。
 */
function atxTitle(raw: string): string {
  let body = raw.replace(/^#+/, '')
  const closing = body.match(/[ \t]+#+[ \t]*$/)
  if (closing !== null && closing.index !== undefined) body = body.slice(0, closing.index)
  return normalize(body)
}

/**
 * Setext 标题的文字部分。
 *
 * 节点覆盖「正文 + 下划线」**两行**（`Title\n===`），所以标题文字只到最后一个换行之前。
 * 正文本身还可以跨多行（段落式 Setext），那些换行按下面 `normalize` 的规则压成空格。
 */
function setextTitle(raw: string): string {
  const cut = raw.lastIndexOf('\n')
  return normalize(cut < 0 ? raw : raw.slice(0, cut))
}

/** 列表里的一行不能有换行，但标题内部的空格是内容，所以只压换行、不压空格 */
function normalize(text: string): string {
  return text.replace(/\n+/g, ' ').trim()
}

/**
 * 把摘下来的节点翻译成符号表。顺序**就是文档顺序**，不重排：
 * `Cmd+R` 列的是结构，而结构的信息量一半在层级、一半在先后。
 *
 * 空标题（`###` 后面什么都没有）直接跳过——浮层里一行空白既点不出东西也读不出意思。
 */
export function symbolsFrom(nodes: readonly SymbolNode[], doc: SymbolDoc): DocSymbol[] {
  const out: DocSymbol[] = []
  for (const node of nodes) {
    const level = headingLevel(node.name)
    if (level === null) continue
    const raw = doc.sliceString(node.from, node.to)
    const name = node.name.startsWith('ATX') ? atxTitle(raw) : setextTitle(raw)
    if (name === '') continue
    out.push({ name, level, pos: node.from })
  }
  return out
}

/**
 * 按输入过滤符号表。
 *
 * ⚠️ 这里是**大小写不敏感的子串匹配**，刻意不做模糊匹配、也不打分排序。
 * 文件那一半的模糊匹配在 Rust（`vela_core::project::index`），如果这里再写一套 TS 的
 * 打分器，同一个 `Cmd+P` 浮层里切一下前缀就会换一套排序规则——
 * 两边对不上比哪一边不准都难受。子串匹配是「没有第二种解释」的那一个。
 *
 * 空串回全表：`Cmd+R` 刚打开时输入框是空的，那时该列出全部标题。
 */
export function filterSymbols(items: readonly DocSymbol[], needle: string): DocSymbol[] {
  if (needle === '') return [...items]
  const lower = needle.toLowerCase()
  return items.filter((item) => item.name.toLowerCase().includes(lower))
}
