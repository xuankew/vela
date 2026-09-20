/**
 * Markdown → **白名单 HTML**（M3-A-1）。
 *
 * ## 为什么自己写，而不是引 `markdown-it`
 *
 * 两个理由，第二个才是决定性的：
 *
 * 1. **解析器已经付过钱了。** `markdownLanguage`（`@codemirror/lang-markdown`）是首屏静态依赖，
 *    编辑器的高亮、`Cmd+R` 的标题表（`src/goto/syntax.ts`）用的都是它这一棵树。再引一个
 *    markdown-it 等于同一个文档在内存里被解析两遍，两棵树的边角规则还可能不一致——
 *    于是「高亮说这是标题、预览说不是」这种没法解释的分歧就有了生存空间。
 *    复用同一棵树，这类分歧**在结构上不可能发生**。
 *
 * 2. 🔴 **不支持内联 HTML 是安全边界，不是功能缺失。** 预览的 HTML 会进 `innerHTML`，
 *    而 Tauri 的 webview 里 `__TAURI_INTERNALS__.invoke` 对任何注入脚本都是可见的，
 *    `tauri.conf.json` 的 `csp` 又还是 `null`——也就是说「打开一个别人给的 `.md`」
 *    只要能执行一行脚本，就等于把 Vela 那 20 条命令的整个能力面交出去（含 `save_file`
 *    这条写任意路径的）。自写渲染器把这条通道**从结构上焊死**：能输出的标签是一个写死的
 *    白名单，文本一律转义，`HTMLTag` / `HTMLBlock` / `CommentBlock` 一律当**文字**渲染。
 *    引第三方渲染器的话，这份保证就变成「我相信它转义干净了」+ 一个 sanitizer 依赖。
 *
 * ⛔ 所以这里有一条不可协商的规则：**任何新增的输出都必须经过 [`escapeHtml`] 或 [`safeUrl`]**，
 * 没有第三条路。`src/md/render.test.ts` 里有一组「敌意输入 → 输出里不许出现 `<script` /
 * ` on` / `javascript:`」的用例守着它，改这个文件时那组用例必须还是绿的。
 *
 * ## 三条口径，每一条都是刻意选的
 *
 * - **文本靠「走子节点 + 填空隙」得到，⛔ 绝不整段 slice。** 实测的树里
 *   `> 引用\n> 第二行` 那个 `Paragraph` 覆盖 `[114,122)`，**把第二行的 `>` 也包在里面**，
 *   而那个 `>` 是它的一个 `QuoteMark` 子节点。整段 slice 就会把引用符号渲染成正文。
 *   同理 `### C#` 的闭合井号串是独立的 `HeaderMark`——`src/goto/symbols.ts` 用正则重新
 *   判了一遍这件事，这里不用：树已经判过了，而且判得比正则准。
 * - **软换行输出成 `\n`，不是 `<br>`。** HTML 自己会把它折叠成空格，这正是 CommonMark 的
 *   要求。只有 `HardBreak`（行尾两个空格或反斜杠）才出 `<br>`。
 * - **未知节点一律转义输出，不猜结构。** 语法升级多出一个节点名时，最坏结果是那段文字
 *   长得朴素一点；猜错结构的最坏结果是标签不配对，而不配对的 HTML 进 `innerHTML`
 *   会被浏览器**自动补全**，补出来的形状没人能预测。
 *
 * ## 这一层不认识 CodeMirror
 *
 * 入参是 `@lezer/common` 的 `Tree` 加一份源文本，跟 `src/goto/symbols.ts` 的分工一样：
 * 纯字符串活在这一半，认识 CM6 的那一半（`ensureSyntaxTree` + 防抖）在 `./preview.ts`。
 * 好处是这一份能在 node 环境里拿**真的解析器**穷举，不用先造 `EditorState`。
 * ⚠️ `@lezer/common` 在 package.json 里是直接依赖，但它本来就作为 `@lezer/markdown` 的
 * 传递依赖进了包——提为直接依赖**一个字节都没加**（MIT，已在 `pnpm-lock.yaml`）。
 */

import type { SyntaxNode, Tree } from '@lezer/common'
// 🔴 方向是 render → table，⛔ 不能反过来：对齐表格是**首屏命令**（`Mod+Shift+A`），
// 而这一份渲染器在 M3-C 里要变成预览专用的懒加载块。让 table 反过来 import render 的话，
// 按一下对齐就把 41 kB 的渲染器拖进首屏
import { parseAlignments, type Align } from './table'

/**
 * 能输出的标签白名单。
 *
 * 这份表的作用不是运行时过滤（渲染器只输出自己写的标签，没有「过滤」这一步），
 * 而是**给人看的合同**：新增一种输出就得先在这里加一行，于是「顺手多输出一个标签」
 * 这个动作会在表上留下痕迹。`render.test.ts` 里有一条用例把这张表与源码里出现的
 * 每一个 `<xxx` 对账，漏加会当场红。
 */
export const ALLOWED_TAGS: readonly string[] = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'del',
  'sub',
  'sup',
  'br',
  'hr',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
]

/** 协议不在白名单里的链接目标用这个类名，理由见 [`safeUrl`] */
export const UNSAFE_LINK_CLASS = 'md-unsafe-link'

/** 那条链接被拦下来时 `title` 里写什么。⛔ 不写原始目标，理由见 [`Renderer.prototype.link`] */
export const UNSAFE_LINK_TITLE = '链接目标的协议不被允许，已阻止'

/** 本地图片（相对路径 / `file:` / `data:`）的占位类名，理由见 [`Renderer.prototype.image`] */
export const LOCAL_IMAGE_CLASS = 'md-img-local'

/**
 * `scheme:` 的形状。RFC 3986 是 `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"`。
 *
 * 🔴 这个正则**必须**在「去掉所有空白与控制字符之后」的串上跑，见 [`safeUrl`]。
 */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/

/** 允许的协议。`file:` 与 `data:` 都不在内，理由写在 [`safeUrl`] 里 */
const ALLOWED_SCHEMES: readonly string[] = ['http', 'https', 'mailto']

/**
 * `Entity` 节点能解的那些。
 *
 * ⚠️ 这是一份**刻意的子集**，不是 HTML 实体全表（两千多条，为一个预览不值当）。
 * 解不出来的按原样转义输出——于是 `&notanentity;` 显示成它自己，与浏览器行为一致，
 * 而高频的这几个加上数字实体覆盖了实际会遇到的绝大多数。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

const ESCAPE_RE = /[&<>"']/g
const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * 文本与属性值共用的转义。`'` 也转，这样将来有人改用单引号写属性也不会出事。
 *
 * ⚠️ 用 `replace` 而不是逐字符循环：一份几万字的文档里这个函数会被调用几万次，
 * 逐字符 `for...of` 会按**码点**切字符串，每次迭代都新分配一个单字符 string。
 */
export function escapeHtml(text: string): string {
  return text.replace(ESCAPE_RE, (ch) => ESCAPES[ch] ?? ch)
}

/**
 * 链接目标能不能进 `href` / `src`。能就回**清理过**的那个串，不能就回 `null`。
 *
 * 🔴 清理只做一件事但必须做：**删掉所有 U+0000–U+0020**。经典的绕法是把协议拆开——
 * `java\tscript:alert(1)` 里的制表符让「开头是不是协议」这个判断落空，于是它被当成
 * 相对路径放行，而浏览器**会**把 `href="java\tscript:..."` 当脚本执行。先删空白再判协议，
 * 这条路就断了。合法 URL 里本来就不该有裸空格（该写 `%20`），所以这一步不损失什么。
 *
 * ⛔ `file:` 不放行：它能读到整个磁盘，而预览里点一下链接就能触发——那等于给
 * 「打开一个别人给的 `.md`」再开一条读任意文件的通道。
 * ⛔ `data:` 也不放行：`data:text/html` 能执行脚本，而为了放行图片去区分
 * `data:image/svg+xml`（**同样能执行脚本**）与 `data:image/png`，换来的是一份
 * 必须永远维护正确的名单。本地图片走 [`LOCAL_IMAGE_CLASS`]，由组件层用 asset 协议解析。
 */
export function safeUrl(raw: string): string | null {
  const url = raw.replace(CONTROL_AND_SPACE, '')
  if (url === '') return null
  const scheme = SCHEME.exec(url)
  if (scheme === null) return url // 没有协议 = 相对路径
  return ALLOWED_SCHEMES.includes((scheme[1] ?? '').toLowerCase()) ? url : null
}

/**
 * U+0000–U+0020：控制字符 + 空格。
 *
 * ⚠️ 写成 `\u0000-\u0020` 转义而不是字面控制字符，因为字面的会被 prettier 与编辑器
 * 各自处理一遍，谁也说不清最后文件里到底是哪个字节。
 */
const CONTROL_AND_SPACE = /[\u0000-\u0020]/g

/**
 * 实体解码。数字实体（`&#65;` / `&#x41;`）+ [`NAMED_ENTITIES`]，解不出来就原样返回。
 *
 * 🔴 返回值随后**还要再过一次 [`escapeHtml`]**：解出 `<` 之后必须重新转义，
 * 否则 `&lt;script&gt;` 会被解码成真的标签。「解码 → 再转义」这个顺序不能反也不能省。
 */
export function decodeEntity(raw: string): string {
  if (raw.length < 3 || raw[0] !== '&' || raw[raw.length - 1] !== ';') return raw
  const body = raw.slice(1, -1)
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X'
    const digits = hex ? body.slice(2) : body.slice(1)
    // 🔴 字符集必须跟着进制走：十进制实体只认 `[0-9]`。
    // 无脑用 `[0-9a-fA-F]` 的话 `&#12ab;` 会过校验，再被 `parseInt(…, 10)` 静默截成
    // 12（换页符），后面的 `ab;` 直接消失——不报错，只是少了一段字
    const valid = hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/
    if (!valid.test(digits)) return raw
    const code = Number.parseInt(digits, hex ? 16 : 10)
    // 0xD800–0xDFFF 是代理区，单独一个不成字；> 0x10FFFF 根本不是码点。
    // 两者都会让 String.fromCodePoint 抛 RangeError，而渲染一份文档不能抛
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return raw
    return String.fromCodePoint(code)
  }
  return NAMED_ENTITIES[body] ?? raw
}

/**
 * 标题的锚点名（GitHub 那套口径的近似）。
 *
 * 保留字母/数字/标记/下划线/连字符，空格换成 `-`，其余标点删掉，整体小写。
 * CJK 属于 `\p{L}`，所以中文标题能正常生成锚点。
 * 重名靠 `seen` 追加 `-1` / `-2`——与 GitHub 一致，也让「同一个文档里两个同名小节」
 * 不至于让第二个锚点静默指向第一个。
 */
export function slugify(text: string, seen: Map<string, number>): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '')
    .replace(/ +/g, '-')
  const base = slug === '' ? 'section' : slug
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

/** 每个块级元素上的源行号属性，1-based。同步滚动靠它把预览对齐到编辑器 */
function lineAttr(line: number): string {
  return ` data-line="${line}"`
}

/**
 * 行首偏移表。
 *
 * 为什么要建表：每个块级元素都要带 `data-line`，而「数从头到这个偏移有几个 `\n`」
 * 是 O(n)，逐块做就是 O(n²)——一份一万行的文档有一万个块，那是 10⁸ 次比较。
 * 建一次表是 O(n)，之后每次查找 O(log n)。
 *
 * ⚠️ 用 `Uint32Array`：偏移量最大就是文档长度，而内联阈值（`MAX_INLINE_BYTES` 4 MiB）
 * 之下远不到 2³²。超过的话这一层压根不会被调用——4 MiB 以上走 M2-H 的只读分片，
 * 那边没有预览。
 */
function buildLineStarts(source: string): Uint32Array {
  const starts: number[] = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) starts.push(i + 1)
  }
  return Uint32Array.from(starts)
}

/** `pos` 落在第几行，1-based。`starts` 由 [`buildLineStarts`] 给出 */
function lineOf(starts: Uint32Array, pos: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if ((starts[mid] ?? 0) <= pos) low = mid
    else high = mid - 1
  }
  return low + 1
}

/** 引用式链接的定义：标签（已归一化）→ 目标与标题 */
interface LinkDef {
  readonly url: string
  readonly title: string
}

/**
 * 标签归一化。CommonMark 的口径：大小写不敏感、内部空白折叠成一个空格、首尾去空白、
 * 外层的方括号去掉。于是 `[Foo Bar]` 与 `[foo   bar]` 是同一条定义。
 */
function normalizeLabel(label: string): string {
  const inner = label.startsWith('[') && label.endsWith(']') ? label.slice(1, -1) : label
  return inner.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 代码围栏后面那个语言标记。`js title=x` 只取第一个词 */
function firstWord(text: string): string {
  const cut = text.search(/\s/)
  return cut < 0 ? text : text.slice(0, cut)
}

/** 语法记号节点：树里存在，但预览里一个字符都不该有 */
const MARK_NODES: ReadonlySet<string> = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'EmphasisMark',
  'StrikethroughMark',
  'SubscriptMark',
  'SuperscriptMark',
  'CodeMark',
  'LinkMark',
  'TableDelimiter',
  'CodeInfo',
])

/**
 * 算「一个列表项里有几个块级子节点」时认哪些名字（紧/松列表的判据）。
 *
 * ⚠️ 这份表**不是**输出白名单——输出的标签由 [`ALLOWED_TAGS`] 管，两者职责不同：
 * 这一份说的是「什么算一个块」，那一份说的是「什么能进 HTML」。
 */
const BLOCK_NODES: ReadonlySet<string> = new Set([
  'Paragraph',
  'Blockquote',
  'BulletList',
  'OrderedList',
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'CommentBlock',
  'ProcessingInstructionBlock',
  'Table',
  'HorizontalRule',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
])

/**
 * 渲染器。一次 [`renderMarkdown`] 一个实例，⛔ 不要跨文档复用——`slugs`（锚点重名计数）
 * 与 `refs`（引用定义）都是**单份文档**的状态。
 */
class Renderer {
  private readonly starts: Uint32Array
  private readonly refs = new Map<string, LinkDef>()
  private readonly slugs = new Map<string, number>()

  constructor(
    private readonly source: string,
    tree: Tree,
  ) {
    this.starts = buildLineStarts(source)
    this.collectRefs(tree)
  }

  render(tree: Tree): string {
    return this.blocks(tree.topNode)
  }

  // ───────────────────────── 通用遍历 ─────────────────────────

  /** 直接子节点，按顺序。`getChildren` 要传节点名，这里要的是「全部」 */
  private children(node: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = []
    const cursor = node.cursor()
    if (cursor.firstChild()) {
      do {
        out.push(cursor.node)
      } while (cursor.nextSibling())
    }
    return out
  }

  /**
   * 走 `node` 的子节点，**同时把子节点之间没人认领的文本交给 `onGap`**。
   *
   * 这是整个渲染器的地基，理由写在文件头：语法记号（`#`、`>`、`|`、`**`）在树里都是
   * 独立节点，正文是它们之间的空隙。整段 slice 会把记号当正文渲染出来。
   */
  private walk(node: SyntaxNode, onGap: (text: string) => void, onChild: (child: SyntaxNode) => void): void {
    let pos = node.from
    for (const child of this.children(node)) {
      if (child.from > pos) onGap(this.source.slice(pos, child.from))
      onChild(child)
      pos = child.to
    }
    if (node.to > pos) onGap(this.source.slice(pos, node.to))
  }

  /** 一个节点内部的正文（跳过所有子节点，只取空隙）。`InlineCode` 与引用标签用得上 */
  private gapsOf(node: SyntaxNode): string {
    let out = ''
    this.walk(
      node,
      (gap) => {
        out += gap
      },
      () => {},
    )
    return out
  }

  private text(node: SyntaxNode): string {
    return this.source.slice(node.from, node.to)
  }

  private line(node: SyntaxNode): number {
    return lineOf(this.starts, node.from)
  }

  /**
   * 先扫一遍收集 `[label]: url` 定义。
   *
   * 必须是**独立的一趟**：CommonMark 允许定义出现在引用**之后**（甚至文档末尾），
   * 边渲染边收集的话 `[foo]` 在前、`[foo]: /bar` 在后就解析不出来。
   */
  private collectRefs(tree: Tree): void {
    for (const node of this.children(tree.topNode)) {
      if (node.name !== 'LinkReference') continue
      const label = node.getChild('LinkLabel')
      const url = node.getChild('URL')
      const title = node.getChild('LinkTitle')
      if (label === null) continue
      const key = normalizeLabel(this.gapsOf(label))
      if (key === '') continue
      // `[ref]: <>` 这种空目标也建一条：不建的话后面查不到，会退化成「原样显示方括号」
      this.refs.set(key, {
        url: url === null ? '' : this.text(url),
        title: title === null ? '' : this.titleText(title),
      })
    }
  }

  // ───────────────────────── 块级 ─────────────────────────

  /** 渲染 `node` 的所有块级子节点 */
  private blocks(node: SyntaxNode): string {
    let out = ''
    this.walk(
      node,
      (gap) => {
        // 块级空隙只可能是空白（段落之间、引用符号周围）。真出现正文说明树的形状
        // 与预期不符，那就原样转义吐出来——⛔ 不猜它该包在什么标签里
        const text = gap.trim()
        if (text !== '') out += escapeHtml(text)
      },
      (child) => {
        out += this.block(child)
      },
    )
    return out
  }

  private block(node: SyntaxNode): string {
    // 🔴 记号节点必须在这里就拦掉。`blocks` 把**每一个**子节点都交给 `block`，
    // 而 `Blockquote` 的直接子节点里就有 `QuoteMark`（实测：`> 引用\n> 第二行` 的
    // Blockquote 子节点是 QuoteMark + Paragraph）——落到下面的 default 分支就会被
    // 当「未知块级节点」转义输出，预览里于是多出一个 `&gt;`
    if (MARK_NODES.has(node.name)) return ''
    const line = lineAttr(this.line(node))
    const level = HEADING_LEVELS[node.name]
    if (level !== undefined) return this.heading(node, level)

    switch (node.name) {
      case 'Paragraph':
        return `<p${line}>${this.inline(node)}</p>`
      case 'Blockquote':
        return `<blockquote${line}>${this.blocks(node)}</blockquote>`
      case 'BulletList':
        return this.list(node, 'ul')
      case 'OrderedList':
        return this.list(node, 'ol')
      case 'FencedCode':
        return this.fencedCode(node)
      case 'CodeBlock':
        return `<pre${line}><code>${escapeHtml(this.codeBody(node))}</code></pre>`
      case 'HorizontalRule':
        return `<hr${line}>`
      case 'Table':
        return this.table(node)
      case 'HTMLBlock':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
        // 🔴 原样**转义**，用 <pre> 保住换行。见文件头第 2 条：这是安全边界
        return `<pre class="md-raw"${line}>${escapeHtml(this.text(node))}</pre>`
      case 'LinkReference':
        // 定义不是内容。渲染出来会在文档末尾多出一行 `[ref]: https://…`
        return ''
      default:
        // 未知块级节点：转义输出，不猜结构。理由见文件头「三条口径」最后一条
        return escapeHtml(this.text(node).trim())
    }
  }

  /**
   * 标题。`HeaderMark`（井号串 / Setext 下划线）在 `inline` 里被跳过。
   *
   * ⚠️ 那个 `.trim()` 不是美容：`inline` 走的是「子节点 + 空隙」，而记号两侧的空隙
   * 会被如实收进来——ATX 的 `# 标题` 收进 `#` 后面那个空格，Setext 的 `标题\n===`
   * 收进下划线前面那个换行。CommonMark 要求标题内容首尾去空白，这里就是在实现它。
   */
  private heading(node: SyntaxNode, level: number): string {
    const id = slugify(this.plainText(node), this.slugs)
    return `<h${level}${lineAttr(this.line(node))} id="${escapeHtml(id)}">${this.inline(node).trim()}</h${level}>`
  }

  /**
   * 一个节点的**纯文本**（标签全部剥掉）。只用来算锚点名与图片的替代文字，
   * ⛔ 不要拿它的返回值去拼 HTML：它不做转义，因为调用方会单独过一遍 [`escapeHtml`]。
   */
  private plainText(node: SyntaxNode): string {
    let out = ''
    this.walk(
      node,
      (gap) => {
        out += gap
      },
      (child) => {
        if (MARK_NODES.has(child.name)) return
        out += this.plainText(child)
      },
    )
    return out.replace(/\s+/g, ' ').trim()
  }

  /**
   * 列表。
   *
   * **紧列表（tight）不包 `<p>`**，松列表包——这是 CommonMark 的规定，也是「列表项之间
   * 空一行」在预览里看起来段落分明的原因。判据用的是「有没有列表项含多个块级子节点」。
   * ⚠️ 这是个**近似**：严格的 CommonMark 判据是「列表项之间有没有空行」，而空行在树里
   * 不产生节点，要判准得回到源文本上找。近似版覆盖了绝大多数真实文档，判错的表现是
   * 列表项多一层 `<p>` 的上下边距——难看但不出错，所以先这么办。
   */
  private list(node: SyntaxNode, tag: 'ul' | 'ol'): string {
    const items = this.children(node).filter((child) => child.name === 'ListItem')
    const tight = items.every((item) => this.blockChildCount(item) <= 1)

    let attrs = lineAttr(this.line(node))
    if (tag === 'ol') {
      const start = this.orderedStart(items)
      if (start !== null && start !== 1) attrs += ` start="${start}"`
    }
    const body = items.map((item) => this.listItem(item, tight)).join('')
    return `<${tag}${attrs}>${body}</${tag}>`
  }

  /** `ListItem` 底下有几个块级子节点。`ListMark` 与 `Task` 不算 */
  private blockChildCount(item: SyntaxNode): number {
    return this.children(item).filter((child) => BLOCK_NODES.has(child.name)).length
  }

  /**
   * 有序列表的起始编号，取**第一个**列表项的 `ListMark`（`3.` → 3）。
   *
   * CommonMark 只用第一项决定 `<ol start>`，后面写什么编号都不影响渲染——
   * `3. a\n7. b` 渲染出来是 3、4，不是 3、7。取不到就回 `null`，让 `<ol>` 用默认值。
   */
  private orderedStart(items: readonly SyntaxNode[]): number | null {
    const first = items[0]
    if (first === undefined) return null
    const mark = first.getChild('ListMark')
    if (mark === null) return null
    const digits = /^\d+/.exec(this.text(mark))
    return digits === null ? null : Number.parseInt(digits[0], 10)
  }

  private listItem(item: SyntaxNode, tight: boolean): string {
    let body = ''
    for (const child of this.children(item)) {
      switch (child.name) {
        case 'ListMark':
          break
        case 'Task':
          // 🔴 `Task` 覆盖 `[ ] 待办` **整段**，`TaskMarker` 只是它开头那三个字符，
          // 正文「待办」是它俩之间的空隙。所以这里必须**既**渲染勾选框**又**递归进去，
          // 只跳过 `Task` 的话待办事项的文字会整个消失（实测树的形状见 render.test.ts）
          body += `${this.taskMarker(child)}${this.inline(child)}`
          break
        case 'Paragraph':
          // 紧列表里列表项的那个段落不包 <p>，直接出行内内容
          body += tight ? this.inline(child) : this.block(child)
          break
        default:
          body += this.block(child)
      }
    }
    const className = item.getChild('Task') === null ? '' : ' class="md-task-item"'
    return `<li${lineAttr(this.line(item))}${className}>${body}</li>`
  }

  /**
   * GFM 任务列表的勾选框。
   *
   * ⛔ **不是 `<input type="checkbox">`**：那东西要「可点击回写源文档」（M3-A-5），
   * 而 `disabled` 的 input 点不动、不加 `disabled` 又会被浏览器自己改状态——
   * 于是「界面上打了勾但文档里还是 `[ ]`」这种两边不一致就有机会出现。
   * 用一个带 `role="checkbox"` 的 `span`，状态完全由源文档决定，点击只发一次编辑事务。
   *
   * `data-pos` 是 `TaskMarker` 的**起始偏移**，回写时替换 `[pos, pos+3)` 这三个字符，
   * 不用再去搜——搜的话一篇文档里几十个 `[ ]` 根本分不清点的是哪一个。
   */
  private taskMarker(task: SyntaxNode): string {
    const marker = task.getChild('TaskMarker')
    if (marker === null) return ''
    const checked = this.text(marker).toLowerCase().includes('x')
    return (
      `<span class="md-task" role="checkbox" aria-checked="${checked}" tabindex="0"` +
      ` data-pos="${marker.from}" data-checked="${checked}"></span>`
    )
  }

  private fencedCode(node: SyntaxNode): string {
    const info = node.getChild('CodeInfo')
    const language = info === null ? '' : firstWord(this.text(info).trim())
    // ⚠️ 语言标记是**用户写的**字符串，进 class 属性前必须转义——
    // 一个 ``` 后面跟 `"><img src=x onerror=…` 是最直接的注入点
    const lang = language === '' ? '' : ` class="language-${escapeHtml(language)}"`
    return `<pre${lineAttr(this.line(node))}><code${lang}>${escapeHtml(this.codeBody(node))}</code></pre>`
  }

  /** 代码块的正文。`CodeText` 是它的子节点；空围栏没有 `CodeText`，正文就是记号之间的空隙 */
  private codeBody(node: SyntaxNode): string {
    const texts = this.children(node)
      .filter((child) => child.name === 'CodeText')
      .map((child) => this.text(child))
    const body = texts.length > 0 ? texts.join('') : this.gapsOf(node)
    return body.replace(/^\n/, '').replace(/\n$/, '')
  }

  /**
   * GFM 表格。
   *
   * 树的形状（实测）：`Table` 的子节点是 `TableHeader`、**一个 `TableDelimiter`（分隔行
   * `|---|---|`）**、若干 `TableRow`；而行**内部**的 `TableDelimiter` 是竖线分隔符。
   * 同一个节点名在两层里意思完全不同，所以对齐信息只能从「`Table` 的直接子节点里那个
   * `TableDelimiter`」取，⛔ 不能从行里取。
   */
  private table(node: SyntaxNode): string {
    let aligns: readonly Align[] = []
    let header: SyntaxNode | null = null
    const rows: SyntaxNode[] = []
    const stray: string[] = []

    // ⚠️ 先收集、后渲染。对齐信息在**分隔行**里，而分隔行排在表头**之后**——
    // 边遍历边渲染的话表头那一趟拿到的 aligns 还是空的，于是对齐只对数据行生效
    for (const child of this.children(node)) {
      switch (child.name) {
        case 'TableDelimiter':
          aligns = parseAlignments(this.text(child))
          break
        case 'TableHeader':
          header = child
          break
        case 'TableRow':
          rows.push(child)
          break
        default:
          stray.push(this.block(child))
      }
    }

    const head = header === null ? '' : `<thead>${this.tableRow(header, 'th', aligns)}</thead>`
    const cells = rows.map((row) => this.tableRow(row, 'td', aligns)).join('')
    const body = cells === '' ? '' : `<tbody>${cells}</tbody>`
    // `stray` 放在 `</table>` **外面**：表格里出现 `<p>` 是非法嵌套，
    // 浏览器会把它挪到表格前面去，而挪到哪儿没人说得准
    return `<table${lineAttr(this.line(node))}>${head}${body}</table>${stray.join('')}`
  }

  private tableRow(row: SyntaxNode, tag: 'th' | 'td', aligns: readonly Align[]): string {
    const cells: string[] = []
    for (const child of this.children(row)) {
      if (child.name !== 'TableCell') continue
      const align = aligns[cells.length]
      const attr = align === undefined || align === 'none' ? '' : ` class="md-${align}"`
      cells.push(`<${tag}${attr}>${this.inline(child)}</${tag}>`)
    }
    return `<tr>${cells.join('')}</tr>`
  }

  // ───────────────────────── 行内 ─────────────────────────

  /**
   * 行内内容。
   *
   * ⚠️ 这里没用 [`Renderer.prototype.walk`]，因为它要多带一个状态：紧跟在 `QuoteMark`
   * 后面的那**一个**空格是引用前缀的一部分，不是正文。`> 引用\n> 第二行` 里第二个 `>`
   * 是那个 `Paragraph` 的子节点，跳过它之后剩下的空格如果不一起吞掉，正文就成了
   * `引用\n 第二行`——预览里看不出来（HTML 会把换行加空格折叠成一个空格），
   * 但**从预览里选中复制**出来的文本会多一个空格。
   */
  private inline(node: SyntaxNode): string {
    let out = ''
    let pos = node.from
    let afterQuote = false
    const gap = (from: number, to: number): string => {
      const raw = this.source.slice(from, to)
      return escapeHtml(afterQuote && raw.startsWith(' ') ? raw.slice(1) : raw)
    }
    for (const child of this.children(node)) {
      if (child.from > pos) out += gap(pos, child.from)
      afterQuote = child.name === 'QuoteMark'
      pos = child.to
      out += this.inlineNode(child)
    }
    // ⚠️ 末尾这段空隙同样要过一遍：`> 引用\n> 第二行` 里那个 `>` 是**最后一个**子节点，
    // 它后面的空格落在循环外。漏掉这一处的表现是复制出来的文本每行开头多一个空格
    if (node.to > pos) out += gap(pos, node.to)
    return out
  }

  private inlineNode(node: SyntaxNode): string {
    switch (node.name) {
      case 'StrongEmphasis':
        return `<strong>${this.inline(node)}</strong>`
      case 'Emphasis':
        return `<em>${this.inline(node)}</em>`
      case 'Strikethrough':
        return `<del>${this.inline(node)}</del>`
      case 'Subscript':
        return `<sub>${this.inline(node)}</sub>`
      case 'Superscript':
        return `<sup>${this.inline(node)}</sup>`
      case 'InlineCode':
        // 反引号串是 CodeMark 子节点，正文是它俩之间的空隙
        return `<code>${escapeHtml(this.gapsOf(node))}</code>`
      case 'HardBreak':
        return '<br>'
      case 'Escape': {
        // `\*` → `*`。第二个字符一定存在（Lezer 只在真能转义时才产生这个节点），
        // 但 slice 越界会静默给出空串，所以显式判一下
        const raw = this.text(node)
        return escapeHtml(raw.length > 1 ? raw.slice(1) : raw)
      }
      case 'Entity':
        return escapeHtml(decodeEntity(this.text(node)))
      case 'Link':
        return this.link(node)
      case 'Autolink':
        return this.autolink(node)
      case 'Image':
        return this.image(node)
      case 'Emoji':
        // `:smile:` 原样输出。⛔ 不做「短名 → 码点」的替换：那要一份上千条的表，
        // 而 Vela 的定位是编辑器不是聊天软件
        return escapeHtml(this.text(node))
      case 'HTMLTag':
      case 'Comment':
      case 'ProcessingInstruction':
        // 🔴 内联 HTML 当**文字**渲染。见文件头第 2 条
        return escapeHtml(this.text(node))
      case 'Task':
        // 走到这里说明 `Task` 出现在了列表项之外（形状与预期不符）。
        // 渲染成「勾选框 + 正文」，⛔ 不要把内容吞掉
        return `${this.taskMarker(node)}${escapeHtml(this.gapsOf(node))}`
      default:
        if (MARK_NODES.has(node.name)) return ''
        // 未知行内节点：递归进去，让它的空隙与子节点各自按规则输出
        return this.inline(node)
    }
  }

  /**
   * `[文字](目标 "标题")`、`[文字][标签]` 与 `[文字]`（快捷引用）三种形状。
   *
   * 🔴 走子节点时一旦撞到 `URL` / `LinkTitle` / `LinkLabel` 就**停止收集标签内容**。
   * 不停的话 `[a](u "t")` 里 `u` 与 `"t"` 之间那个空格会被当成正文，
   * 而更糟的是目标串本身会被拼进 `<a>` 的内容里显示成一段乱码。
   */
  private link(node: SyntaxNode): string {
    let html = ''
    let plain = ''
    let url: string | null = null
    let title = ''
    let refLabel: string | null = null
    let seenTarget = false

    // ⚠️ 这里是**直线循环**而不是 `walk` 的回调：`url` 要在循环里赋值、循环后判断，
    // 而 TS 的控制流分析看不进回调——写在回调里它会把 `url` 一路收窄成 `null`。
    // 「先收集再判断」这件事本身也更清楚：链接的三种形状只在收集完之后才分得开。
    let pos = node.from
    for (const child of this.children(node)) {
      if (!seenTarget && child.from > pos) {
        const gap = this.source.slice(pos, child.from)
        html += escapeHtml(gap)
        plain += gap
      }
      pos = child.to
      switch (child.name) {
        case 'URL':
          url = this.text(child)
          seenTarget = true
          break
        case 'LinkTitle':
          title = this.titleText(child)
          seenTarget = true
          break
        case 'LinkLabel':
          refLabel = this.gapsOf(child)
          seenTarget = true
          break
        default:
          if (seenTarget || MARK_NODES.has(child.name)) break
          html += this.inlineNode(child)
          plain += this.plainText(child)
      }
    }

    if (url === null) {
      // 引用式：显式 `[a][ref]` 用 ref，快捷式 `[a]` 用标签文字本身
      const def = this.refs.get(normalizeLabel(refLabel ?? plain))
      // 🔴 没有对应定义就退回**原始字面量**（连方括号一起），不是「已经收集好的内容」。
      // CommonMark 就是这么规定的：`[孤立的]` 显示成 `[孤立的]`。只回 `html` 的话方括号
      // 会静默消失——用户看到的正文比自己写的少两个字符，而这种「少东西」最难查
      if (def === undefined) return escapeHtml(this.text(node))
      url = def.url
      if (title === '') title = def.title
    }

    const safe = safeUrl(url)
    if (safe === null) {
      // ⛔ title 里**不放**那个原始目标。它虽然是转义过的、执行不了，但把
      // `javascript:alert(1)` 原样搬进 DOM 没有必要——用户要的信息是「这条被拦了」，
      // 不是「被拦的那串长什么样」
      return `<span class="${UNSAFE_LINK_CLASS}" title="${UNSAFE_LINK_TITLE}">${html}</span>`
    }
    const titleAttr = title === '' ? '' : ` title="${escapeHtml(title)}"`
    // 站外链接开新窗口并切断 opener。⚠️ `noopener` 在预览里不是安全必需
    // （那份 HTML 没有同源内容可偷），但它是免费的，而且**导出的 HTML**（M3-A-6）
    // 离开 Vela 之后就需要了
    const external = !safe.startsWith('#') && !safe.startsWith('/')
    const target = external ? ' target="_blank" rel="noopener noreferrer"' : ''
    return `<a href="${escapeHtml(safe)}"${titleAttr}${target}>${html}</a>`
  }

  /** `<https://auto.link>`。文字就是目标本身 */
  private autolink(node: SyntaxNode): string {
    const url = node.getChild('URL')
    if (url === null) return escapeHtml(this.text(node))
    const raw = this.text(url)
    const text = escapeHtml(raw)
    const safe = safeUrl(raw)
    if (safe === null) return `<span class="${UNSAFE_LINK_CLASS}">${text}</span>`
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`
  }

  /**
   * `![替代文字](目标)`。
   *
   * ⚠️ **只有 `http(s)` 的目标才真的出 `<img>`。** 本地路径出不了，原因不在这一层：
   * webview 的 base URL 是应用自己的源（`tauri://localhost` / `http://tauri.localhost`），
   * 不是文档所在目录，所以 `src="assets/a.png"` 会 404。要让它工作得走 Tauri 的 asset
   * 协议并在 `tauri.conf.json` 里开 scope——那是 M3-A-7（图片粘贴落地）要一并解决的事。
   * 在那之前这里输出一个带 `data-path` 的占位 `span`，组件层可以据实说「本地图片还没接上」，
   * ⛔ 而不是画一个裂图图标让用户以为是文件丢了。
   */
  private image(node: SyntaxNode): string {
    const url = node.getChild('URL')
    const title = node.getChild('LinkTitle')
    const titleText = title === null ? '' : this.titleText(title)
    const alt = this.altText(node)
    const altText = escapeHtml(alt === '' ? '图片' : alt)

    const raw = url === null ? '' : this.text(url)
    const safe = safeUrl(raw)
    if (safe === null || !/^https?:/i.test(safe)) {
      // ⚠️ title 里放的是路径本身（用户要的就是「哪张图没出来」），但 `data:` 那种
      // 动辄几 KB 的串不能整个塞进 tooltip，截断
      const shown = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
      return `<span class="${LOCAL_IMAGE_CLASS}" data-path="${escapeHtml(raw)}" title="${escapeHtml(shown)}">${altText}</span>`
    }
    const titleAttr = titleText === '' ? '' : ` title="${escapeHtml(titleText)}"`
    // loading=lazy：一篇贴图很多的笔记一次性发几十个请求会把预览卡住
    return `<img src="${escapeHtml(safe)}" alt="${altText}"${titleAttr} loading="lazy">`
  }

  /**
   * `![替代文字](…)` 里的替代文字。
   *
   * 🔴 它是**空隙**，不是子节点。实测树的形状：`Image` 的直接子节点只有
   * `LinkMark`(`![`) / `LinkMark`(`]`) / `LinkMark`(`(`) / `URL` / `LinkMark`(`)`)——
   * `![图](a.png)` 里那个「图」谁都没认领。所以「过滤掉记号再把子节点拼起来」
   * 这种写法必然得到空串，alt 会一律退化成占位词。
   *
   * 取法是「第 1 个 `LinkMark` 的末尾 → 第 2 个 `LinkMark` 的开头」这一段，
   * 段内的子节点照常递归（于是 `![**粗**图](…)` 的 alt 是 `粗图`）。
   */
  private altText(node: SyntaxNode): string {
    const marks = this.children(node).filter((child) => child.name === 'LinkMark')
    const open = marks[0]
    const close = marks[1]
    if (open === undefined || close === undefined || close.from <= open.to) return ''

    let out = ''
    let pos = open.to
    for (const child of this.children(node)) {
      if (child.from < open.to || child.to > close.from) continue
      if (child.from > pos) out += this.source.slice(pos, child.from)
      if (!MARK_NODES.has(child.name)) out += this.plainText(child)
      pos = child.to
    }
    if (close.from > pos) out += this.source.slice(pos, close.from)
    return out.replace(/\s+/g, ' ').trim()
  }

  /**
   * `"标题"` / `'标题'` / `(标题)` 三种写法都要把外层那对符号去掉。
   * Lezer 的 `LinkTitle` 节点**包含**它们。
   */
  private titleText(node: SyntaxNode): string {
    const raw = this.text(node)
    if (raw.length < 2) return raw
    const first = raw[0]
    const last = raw[raw.length - 1]
    const quoted = first === last && (first === '"' || first === "'")
    const paren = first === '(' && last === ')'
    return quoted || paren ? raw.slice(1, -1) : raw
  }
}

/**
 * 标题级别查表。与 `src/goto/symbols.ts` 的 `HEADING_LEVEL` 是同一份知识，
 * 但**刻意没有共享**：那边要的是「这个节点是不是标题」并对外导出 `headingLevel`，
 * 这边要的是「是几级」并只在 `block` 里用一次。为一个 8 行的字面量表拉一条模块依赖，
 * 换来的是两个模块的改动互相牵连——不划算。
 * ⚠️ 代价是**改一处要记得改另一处**，`render.test.ts` 里有一条用例钉住这件事。
 */
const HEADING_LEVELS: Readonly<Record<string, number>> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
}

/**
 * 把一棵 Markdown 语法树渲染成 HTML 字符串。
 *
 * `tree` 必须是用 `markdownLanguage.parser` 解析 `source` 得到的那棵——两者的偏移量
 * 是同一套坐标系，`data-line` 与 `data-pos` 才有意义。⛔ 不要拿编辑器里一棵解析到
 * 一半的树配一份已经改过的文本：那会让所有偏移量指向错误的位置，而错得很安静
 * （就是 `src/goto/syntax.ts` 里说的那种「残缺但看不出来残缺」）。
 *
 * 返回值可以**直接**进 `innerHTML`：所有文本都过了 [`escapeHtml`]，所有目标都过了
 * [`safeUrl`]，输出的标签只可能是 [`ALLOWED_TAGS`] 里那些。
 */
export function renderMarkdown(tree: Tree, source: string): string {
  return new Renderer(source, tree).render(tree)
}
