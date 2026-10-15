import { ensureSyntaxTree } from '@codemirror/language'
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint'
import type { EditorState, Extension, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * JSON 的格式校验：出错的那一段画波浪线、行号槽里一个红点标记、鼠标悬浮给出原因。
 *
 * 只有 JSON 文档挂它（判据与挂载点都在 `./setup` 的 `languageExtensions`），
 * 其余语言连 lint 的 state field 都不会有。
 *
 * 🔴 **位置来自 Lezer 语法树的 error 节点，不是 `JSON.parse` 的报错文本**——
 * 后者在 Tauri 用的 JavaScriptCore 上压根不带位置（它的报错是
 * `JSON Parse error: Property name must be a string literal`，没有 `at position N`），
 * `@codemirror/lang-json` 的 `jsonParseLinter` 抠不到位置就回落到 0，
 * 于是任何错误都钉在第一行。这是真机截图暴露的，V8 环境（node / Chromium）里验不出来。
 * 语法树与引擎无关，而且本来就要为高亮解析一遍，位置是白拿的。
 */

/**
 * 超过这个长度就不校验，直接返回空。
 *
 * `JSON.parse` 是**整篇同步**解析，而校验在每次停手 750ms 后跑一遍：几 MB 的 JSON 上
 * 就是「每停一下卡一下」。Vela 里能进编辑器的文档最多 4 MiB——再大走只读分片，
 * 压根没有 CM6 state（`fs/read.rs` 的 `MAX_INLINE_BYTES`），所以这条闸拦的是 2~4 MiB 那一段。
 *
 * ⚠️ 跳过是**静默**的：大文件上既不标错也不说「太大没校验」。当时的取舍是不值得为它
 * 再加一条状态栏文案——手写几 MB JSON 的场景基本不存在，而那一段还是只读的居多。
 */
export const MAX_LINT_LENGTH = 2 * 1024 * 1024

/**
 * `ensureSyntaxTree` 的同步解析预算（毫秒）。
 *
 * 校验在停手 750ms 后才跑，语法树的后台增量解析通常早就追上了，这个预算基本是白给的；
 * 给它是为了兜住「刚粘贴进一大份 JSON、树还没解析完」那一下——超时就拿当前解析到的
 * 部分，最坏情况是漏掉还没解析到的尾部错误，等下一次停手再补。
 */
const PARSE_BUDGET_MS = 100

/**
 * 整篇是不是只有空白（含完全空）。
 *
 * 🔴 这条**不是**洁癖：`JSON.parse('')` 与 `JSON.parse('\n')` 都抛
 * 「Unexpected end of JSON input」，于是新建一个空 `config.json`、或者把内容全删光的
 * 那一刻，编辑器立刻在位置 0 挂一个红点——用户什么都还没写就先被骂一句。
 *
 * 按行扫而不是 `doc.toString().trim()`：第一个非空行就返回，真的 JSON 文件只扫一行；
 * 而 `toString()` 会把整篇拷成一个字符串，`JSON.parse` 本来就要拷一次，
 * 不必为这条判断再多拷一遍。
 */
function isBlank(doc: Text): boolean {
  for (const line of doc.iterLines()) {
    if (line.trim() !== '') return false
  }
  return true
}

/**
 * 第一处语法错误的区间。
 *
 * 只取**第一处**：Lezer 的错误恢复会在后面再插几个 error 节点（对象里套一个裸对象时，
 * 文件末尾还会多两个零宽的），全标出来就是一片红，而 `JSON.parse` 报的也从来只有第一处。
 * 相邻或重叠的 error 节点并成一簇（`{'a': 1}` 会连出三个挨着的节点）。
 */
function firstErrorRange(state: EditorState): { from: number; to: number } | null {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS)
  if (tree === null) return null
  let range: { from: number; to: number } | null = null
  tree.iterate({
    enter: (node) => {
      if (!node.type.isError) return
      if (range === null) {
        range = { from: node.from, to: node.to }
        return
      }
      if (node.from <= range.to) range.to = Math.max(range.to, node.to)
    },
  })
  return range
}

/**
 * 校验源。导出是为了能脱离 `linter()` 直接测（见 ./jsonLint.test.ts）：
 * 体积闸那一条要构造一个 2 MiB 的文档，走 view 太贵。
 *
 * `JSON.parse` 只当**判官**（这份内容到底合不合法、报错原文说什么），位置一律听语法树的：
 * 理由见文件头。
 *
 * 🔴 返回类型刻意写成窄的那个 `readonly Diagnostic[]`，而不是 `LintSource` 那个联合
 * （它还允许返回 Promise 与 null）：源是同步的，写成联合会让调用方（含测试）每次都得先
 * 判空/await 才能读字段。窄类型照样能交给 `linter()`。
 */
export function jsonLintSource(view: EditorView): readonly Diagnostic[] {
  const { state } = view
  const { doc } = state
  if (doc.length > MAX_LINT_LENGTH) return []
  if (isBlank(doc)) return []
  let message: string
  try {
    JSON.parse(doc.toString())
    return []
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  const range = firstErrorRange(state)
  // 语法树也没说出位置（树还没解析到、或引擎与文法罕见地不一致）：退到位置 0。
  // 有错却什么都不标比标错地方更糟，而这两种情形都极罕见
  const from = range === null ? 0 : range.from
  // 零宽的 error 节点（错误落在两个 token 之间，如多余的逗号）扩到那一个字符上，
  // 否则 CM6 画的是 6×4 的小三角而不是波浪线；文件末尾扩不出去就保持零宽
  const to = range === null ? 0 : Math.min(Math.max(range.to, range.from + 1), doc.length)
  const diagnostic: Diagnostic = { from, to, severity: 'error', message }
  return [diagnostic]
}

/**
 * 提示气泡的皮肤。理由与 `setup.ts` 的 `completionTheme` 同一条：CM6 base theme 给的是
 * 写死的灰底（亮 `#f5f5f5` + `1px solid #bbb` / 暗 `#333338`），与本应用其余每一处浮层
 * 都不是一套。
 *
 * 🔴 选择器必须落在**外层那个 div** 上。lint 的气泡走 `hoverTooltip`，真浏览器里量到的
 * DOM 是 `div.cm-tooltip.cm-tooltip-hover > ul.cm-tooltip-lint.cm-tooltip-section`：
 * `cm-tooltip-lint` 在**子元素**上，而底色与边框都在外层。autocomplete 的气泡是同一个
 * 元素带两个类，所以 `completionTheme` 那种 `.cm-tooltip.cm-tooltip-xxx` 的写法搬过来
 * 一个元素都命中不了——规则照样注进样式表，只是永远不生效，jsdom 与单测都看不出来，
 * 只有在真浏览器里量计算样式才露馅（写错的那一版就是这么发现的）。
 *
 * `:has()` 从 safari16 起支持，正是 vite.config.ts 里 `build.target` 那一档；
 * Tauri 在 macOS 13+ 上用的就是 WKWebView 16+。
 *
 * ⚠️ **只**改气泡与红点。行号槽那个圆点是 `content: url('data:image/svg+xml…')`，
 * 波浪线是 `background-image` 的同款 data URI——data URI 里的 SVG 读不到文档的 CSS 变量，
 * 跟不了主题，所以那两处留着 CM6 自己的红（`#f43` / `#f11`），亮暗底上都看得清。
 */
const lintTooltipTheme = EditorView.theme({
  '.cm-tooltip-hover:has(> .cm-tooltip-lint)': {
    background: 'var(--vela-bg-panel)',
    border: '1px solid var(--vela-border)',
    color: 'var(--vela-fg)',
  },
  // 报错原文是引擎给的英文（V8：`Expected double-quoted property name in JSON at
  // position 68 (line 6 column 3)`；JSC：`JSON Parse error: Property name must be a
  // string literal`），按代码字体渲染。字号刻意**不写**：继承编辑器的 `--vela-font-size`，
  // 用户放大字号时提示跟着放大
  '.cm-diagnostic': { fontFamily: 'var(--vela-font-code)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--vela-bad)' },
  '.cm-lintPoint:after': { borderBottomColor: 'var(--vela-bad)' },
})

/**
 * 🔴 模块级**共享一份实例**，不是每次调用都新建。
 *
 * 语言槽位不止 reconfigure 一次（`doc/workspace.ts` 的 `installLanguage`：先装同步部分，
 * 子语言懒加载回来再装一次；改名、内容变化触发语言重判时还会再来）。`linter()` 每次调用
 * 都产出一个新的 `lintConfig` provider，而 lint 那个 ViewPlugin 恰恰把「配置变了」当成
 * 「该重新校验一次」——新建实例的话，打开一个 JSON 文件就白跑一遍 `JSON.parse`
 * 外加一次全树遍历。共享同一份实例时 provider 数组按 `===` 相同，facet 值不变，
 * 后续 reconfigure 什么都不触发。
 *
 * 诊断结果本身不会因此丢：`lintState` 是 lint 包里的模块级 StateField，
 * reconfigure 按 field id 认出「同一个字段」，值原样带过来。
 */
const EXTENSIONS: readonly Extension[] = [linter(jsonLintSource), lintGutter(), lintTooltipTheme]

/** JSON 文档要挂的那几样。返回值是只读的——调用方一律 spread 进自己的数组 */
export function jsonLint(): readonly Extension[] {
  return EXTENSIONS
}
