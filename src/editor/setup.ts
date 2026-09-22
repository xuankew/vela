import { Compartment, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
  dropCursor,
  scrollPastEnd,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, indentMore, indentLess } from '@codemirror/commands'
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
  type LanguageSupport,
} from '@codemirror/language'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import { createFindReplacePanel, preserveCase } from './findReplace'
import { fontSizeZoom } from './fontSizeZoom'
import { indentGuides } from './indentGuides'
import type { LanguageChoice } from './language'
import { mouseGestures } from './multiCursor'
import { imagePaste, type PasteImageHook } from './paste'
import { coveredRange, escapesCoverage } from './viewport'
import { wordCompletions, wordPeers } from './wordSource'

/**
 * 连字在 contenteditable 语境下会导致光标定位错乱（PLAN.md R11），属浏览器级问题，
 * 无法在编辑器层修，因此默认关闭。
 */
const noLigatures = EditorView.theme({
  '&': {
    fontVariantLigatures: 'none',
    fontFeatureSettings: '"liga" 0, "calt" 0',
  },
})

/**
 * 词补全的弹出列表。
 *
 * `darkTheme.of(true)` 已经让 CM6 的 `&dark` 规则生效了，弹层不是浅底——但它用的是
 * **写死的** `#333338`、没有边框、选中行是 `#347`，列表字体是笼统的 `monospace`，
 * 与这个应用里其余每一处面板（`--vela-bg-panel` + `--vela-border`）都不是一回事。
 *
 * 用 `EditorView.theme` 而不是写进 styles.css：theme 模块的优先级天然高于 baseTheme，
 * 而 styles.css 里同等特异度的选择器会被 CM6 运行时注入的样式表按顺序压过去。
 * M4 做主题系统时这一条跟着 CSS 变量一起换，不需要动。
 */
const completionTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--vela-bg-panel)',
    border: '1px solid var(--vela-border)',
    color: 'var(--vela-fg)',
    '& > ul': {
      // 列表里是标识符，按「代码」渲染（D2 按内容分字体），与它来自的那段正文一致
      fontFamily: 'var(--vela-font-code)',
      fontSize: 'var(--vela-font-size, 14px)',
    },
    '& > ul > li[aria-selected]': {
      background: 'var(--vela-border)',
      color: 'var(--vela-fg)',
    },
    // 分组分隔线原本是 `1px solid silver`，在暗底上是一道亮边
    '& > ul > completion-section': {
      borderBottomColor: 'var(--vela-border)',
    },
  },
})

/**
 * 字体分区（PLAN.md D2「按内容分字体」）：
 * - Markdown 正文 → `--vela-font-editor`（霞鹜文楷 Screen）
 * - 代码块 / 表格 → `--vela-font-code`（Maple Mono CN，等宽 2:1）
 * - UI → `--vela-font-ui`
 *
 * 通过 CSS variable 暴露，M4 做主题系统时直接接管这里。
 *
 * 🔴 `letterSpacing` 挂在 `&`（整个编辑器根）上，与 `.md-preview-body` 用的是同一个
 * `--vela-letter-spacing`。⚠️ **真机待验**：CM6 的光标坐标靠 DOM 测量算出来，字间距非
 * `normal` 时字符前进宽度变了，光标落点与选区高亮的横向对齐是否仍逐像素准确，jsdom 量
 * 不出来（没有真实布局），得在真机上确认。默认值是 `normal`，所以不改字间距的用户不受影响。
 */
const fontTheme = EditorView.theme({
  '&': {
    fontFamily: 'var(--vela-font-editor)',
    fontSize: 'var(--vela-font-size, 14px)',
    lineHeight: 'var(--vela-line-height, 1.7)',
    letterSpacing: 'var(--vela-letter-spacing, normal)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--vela-font-editor)',
  },
  '.cm-content': {
    caretColor: 'var(--vela-accent)',
  },
  // 🔴 行号 gutter 必须跟随字号，否则放大时行号会重叠（PLAN.md R11）
  '.cm-gutters': {
    fontSize: 'var(--vela-font-size, 14px)',
  },
})

/**
 * 非 Markdown 文档（.ts / .json / 纯文本…）整篇都是代码，不需要按节点分流。
 *
 * 刻意写成 fontTheme 的**完整替代**而不是只覆盖 fontFamily：两个主题同时挂载时
 * 谁生效取决于 CM6 的样式模块顺序，那是个隐式契约，不如让调用方二选一。
 * ⚠️ 于是 `letterSpacing` 也得在这里再写一遍——它是 fontTheme 的完整替代，少一条就少了字间距。
 */
const codeDocFontTheme = EditorView.theme({
  '&': {
    fontFamily: 'var(--vela-font-code)',
    fontSize: 'var(--vela-font-size, 14px)',
    lineHeight: 'var(--vela-line-height, 1.7)',
    letterSpacing: 'var(--vela-letter-spacing, normal)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--vela-font-code)',
  },
  '.cm-content': {
    caretColor: 'var(--vela-accent)',
  },
  // 🔴 行号 gutter 必须跟随字号，否则放大时行号会重叠（PLAN.md R11）
  '.cm-gutters': {
    fontSize: 'var(--vela-font-size, 14px)',
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
      for (let pos = node.from; pos <= node.to;) {
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
      if (u.viewportChanged && escapesCoverage(u.view, this.coveredFrom, this.coveredTo)) {
        this.rebuild(u.view)
        return
      }
      // 语法树是后台增量解析的：重建那一刻可能还没解析到 coveredTo，那次装饰是残缺的。
      // 视口不动也得等解析追上后补一次，否则用户停在一个没解析完的位置上，
      // 代码块会一直显示成正文字体，直到他滚动才纠正。
      if (this.parsePending && syntaxTreeAvailable(u.state, this.coveredTo)) this.rebuild(u.view)
    }

    private rebuild(view: EditorView) {
      const covered = coveredRange(view)
      if (!covered) {
        this.coveredFrom = 0
        this.coveredTo = -1
        this.parsePending = false
        this.decorations = Decoration.none
        return
      }
      this.coveredFrom = covered.from
      this.coveredTo = covered.to
      this.decorations = buildCodeDecorations(view, covered.from, covered.to)
      this.parsePending = !syntaxTreeAvailable(view.state, covered.to)
    }
  },
  { decorations: (v) => v.decorations },
)

/** 当前的 token 配色。正式主题系统在 M4 接管，这里只求能看清 token 边界。 */
const tokenHighlight = HighlightStyle.define([
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

/**
 * 缩进单位。导出成常量而不是内联字面量：状态栏要把它报出来，两处各写一份迟早分叉。
 */
export const INDENT_UNIT = '  '

/** 缩进设置的展示名。含 Tab 就报「Tab」，否则报空格数 */
export function indentLabel(unit: string): string {
  return unit.includes('\t') ? 'Tab' : `${unit.length} 空格`
}

export interface EditorSetupOptions {
  /** 是否开启自动换行 */
  lineWrap?: boolean
  /**
   * 这个文档的语言。决定语法树与字体分区，由 `./language` 从路径算出来。
   *
   * 可选：`tab.ts` 建 state 时**刻意不传**，让槽位空着、随后由 workspace 的 syncLanguage
   * 统一装。语言只有一条安装路径，子语言懒加载回来时就不必再判断「这个 state 是哪条路建的」。
   */
  language?: LanguageChoice
  /**
   * 自动换行的开关槽位，由调用方（`EditorController`）持有。
   *
   * 用 Compartment 而不是「改选项再重建视图」：重建会丢掉选区、滚动位置与撤销历史，
   * 而 `lineWrapping` 只是众多扩展里的一个，reconfigure 就够了。
   */
  lineWrapSlot: Compartment
  /**
   * 深/浅色的开关槽位（M4-C 主题系统），装的是 `EditorView.darkTheme` facet。
   *
   * 与 `lineWrapSlot` 是**同一类东西**：全局视图设置、共享一个实例、一次 reconfigure
   * 拨动所有标签。理由是主题不由单个标签决定，而由「现在这套配色是亮还是暗」决定，
   * 那是工作区的知识（与 `languageSlot` 每标签一个实例正好相反）。
   *
   * 🔴 必须是槽位而不是写死：M4-C 之前这里写的是 `EditorView.darkTheme.of(true)`（应用只有暗色）。
   * 这个 facet 控制 CM6 base theme 里所有 `&dark` 规则——光标色、选区色、gutter 底、
   * 自动补全 tooltip 与查找面板的底。亮色主题下还写死 true 的话，这些内部件会整个用反
   * （浅底应用里弹出一个深灰 tooltip），而 `--vela-*` 那套 CSS 变量管不到 CM6 的 base theme。
   */
  darkSlot: Compartment
  /** 初始是否暗色。缺省 `true` = 与 M4-C 之前逐像素一致（应用一直是暗色的） */
  dark?: boolean
  /**
   * 语言的开关槽位，**每标签一个实例**。
   *
   * 与 `lineWrapSlot` 正好相反：换行是全局视图设置，共享一个实例才能一次 reconfigure
   * 拨动所有标签；语言是标签自己的属性（由它的路径决定），共享实例会让改一个标签的
   * 语言波及全部。Compartment 按实例寻址，所以「每标签一个」就是「每标签独立」。
   *
   * 必须是槽位而不是重建 state：`language-data` 的子语言靠动态 import 懒加载，
   * 建 state 那一刻拿不到 `LanguageSupport`，只能先装上同步部分、等 import 落地再补。
   */
  languageSlot: Compartment
  /**
   * 词补全的「其他文档」来源，由 workspace 注入所有标签的活 state。
   *
   * M1 没有项目概念（文件树是 M2 的事），所以 PLAN.md §2 那句「项目词典」在这一版
   * 落地成**所有打开的标签**。缺省为空——`createEditorState` 被单独调用时（测试、
   * 将来的复用）就只有当前文档自己那份词典，行为完全可预期。
   *
   * 注入而不是让 `wordSource` 直接 import workspace：那一层不该知道标签与分屏的存在，
   * 而且注入之后「跨文档取词」能在 node 环境里拿两个裸 state 测出来。
   */
  peerStates?: () => Iterable<EditorState>
  /**
   * 剪贴板里有一张图片时问谁（M3-A-7）。缺省 = 不装这条扩展，粘贴走 CM6 的默认路径。
   *
   * 🔴 钩子必须**同步**回答接不接：paste 处理器的返回值决定 CM6 要不要 `preventDefault`
   * 并跳过它自己那个默认粘贴。落地本身是异步的，那部分由钩子内部自己管（见 `src/md/paste.ts`）。
   */
  pasteImage?: PasteImageHook
  /**
   * Cmd/Ctrl+鼠标滚轮调整字号的回调。没传就不装这条扩展。
   *
   * 参数是步进方向：`+1` = 放大（向上滚），`-1` = 缩小（向下滚）。
   * 由 settings store 统一管 sanitize + CSS 变量 + 写穿。
   */
  onFontSizeZoom?: (delta: number) => void
}

/**
 * 一种语言对应的扩展：语法 + 字体分区。
 *
 * `support` 为 null 表示懒加载还没落地，此时只有字体分区生效——字体不能等，
 * 否则用户会先看到一屏正文字体的代码，再闪一下变成等宽。
 */
export function languageExtensions(choice: LanguageChoice, support: LanguageSupport | null): Extension[] {
  switch (choice.kind) {
    case 'markdown':
      // markdown 是静态依赖，不走 language-data 的懒加载。codeLanguages 让围栏里的
      // ts/rust/json 按需解析；正文用文楷，代码块与表格行由装饰换成等宽字体
      return [markdown({ base: markdownLanguage, codeLanguages: languages }), fontTheme, codeFontBySyntax]
    case 'code':
      return [...(support === null ? [] : [support]), codeDocFontTheme]
    case 'plain':
      // 没匹配上的扩展名一律等宽且不挂语言：等宽对日志与表格的列对齐是刚需
      return [codeDocFontTheme]
  }
}

/**
 * 组装编辑器扩展集。
 *
 * 刻意不使用 `basicSetup`：要精确知道每一个扩展的成本，而且 basicSetup 里含不需要的
 * 部分（如 lint gutter）。
 */
export function buildExtensions(options: EditorSetupOptions): Extension[] {
  const {
    lineWrap = true,
    dark = true,
    language,
    lineWrapSlot,
    darkSlot,
    languageSlot,
    peerStates,
    pasteImage,
    onFontSizeZoom,
  } = options

  const exts: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    // 多光标与列块选择的总开关。默认是 false，关掉时多选区会被**静默塌成主选区**——
    // 不报错，只是光标少了一堆，所以 Option+Click / Option+Shift+拖拽 全指着这一条。
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of(INDENT_UNIT),
    bracketMatching(),
    closeBrackets(),
    // 补全面板与键位。⚠️ 光有 autocompletion() 是**一个词源都没有**的：completeAnyWord
    // 不是默认装的，我们接的语言包也都不带词源，所以 M1-E-3 之前打字从来不会弹补全。
    autocompletion(),
    // 词补全的词典（StateField，增量维护）与词源。词源注册进语言数据而不是 override，
    // 免得把语言包自带的那些源顶掉——理由写在 ./wordSource 的模块末尾
    wordCompletions,
    // 弹层的外观：CM6 的 &dark 基础主题给的是写死的灰底无边框，与本应用的面板不是一套
    completionTheme,
    // 列块选择改绑 Option+Shift+拖拽，Option+Click 让给「加光标」，十字提示也跟着只认这两个键。
    // 手势矩阵与「facet 一注册就完全接管」这个坑记在 ./multiCursor
    mouseGestures,
    highlightActiveLine(),
    // 查找替换。`search()` 注册的是 searchState 字段与匹配高亮——只有 searchKeymap 而没有它时
    // 字段压根不存在，`getSearchQuery` 会直接抛。`createPanel` 是官方扩展点，面板换成自己的
    // （多一个「保留大小写」开关），缘由见 ./findReplace 的模块文档。
    // 刻意不传 `top`：面板自己声明了 `readonly top = true`，两处都写只会让配置与实现分叉。
    search({ createPanel: createFindReplacePanel }),
    preserveCase,
    highlightSelectionMatches(),
    // 缩进引导线对正文与代码都生效，所以放在基础列表里而不是 markdownMode 分支内
    indentGuides,
    syntaxHighlighting(tokenHighlight),
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

  // 语言槽位必须始终在扩展集里，与换行槽位同一条理由。缺省时装空数组：
  // 语言由 workspace 的 syncLanguage 随后 reconfigure 进来，槽位不存在就无处生效
  exts.push(languageSlot.of(language === undefined ? [] : languageExtensions(language, null)))
  // 换行槽位同理：关闭换行时塞空数组，否则之后 reconfigure 无处生效
  exts.push(lineWrapSlot.of(lineWrap ? [EditorView.lineWrapping] : []))
  // 深浅色槽位（M4-C）：始终在扩展集里，装的恒是 `EditorView.darkTheme.of(dark)`。
  // 与换行槽位同一条理由——槽位不存在就无处 reconfigure，切主题时对显示中的 view 那一下
  // dispatch 会静默落空。切换由 workspace 的 `setDarkTheme` 拨动（见 `doc/workspace.ts`）
  exts.push(darkSlot.of(EditorView.darkTheme.of(dark)))
  // 词补全的「其他文档」。没传就不装：facet 缺省是空的，词典退化成只有当前文档那一份
  if (peerStates !== undefined) exts.push(wordPeers.of(peerStates))
  // 粘贴图片。没传就不装：CM6 内置的 paste 处理器照旧跑，行为与 M3-A-7 之前一模一样
  if (pasteImage !== undefined) exts.push(imagePaste(pasteImage))
  // Cmd/Ctrl+鼠标滚轮调整字号。没传就不装：保持与 Mod+=/- 同一套步进逻辑
  if (onFontSizeZoom !== undefined) exts.push(fontSizeZoom(onFontSizeZoom))

  return exts
}

export interface EditorUpdateInfo {
  docChanged: boolean
  selectionChanged: boolean
  lines: number
  chars: number
}

export interface EditorStateOptions extends EditorSetupOptions {
  doc?: string
  /** state → 外部的唯一出口。回调闭包被烘进 state，所以「哪个 state 在变」天然不会串 */
  onUpdate?: (info: EditorUpdateInfo) => void
}

/**
 * 造一个可独立存活的编辑器状态。
 *
 * M1-D 的多标签是「一个标签一份 state、一个分屏一个 view」：标签切走时它的 state 被
 * 存起来，切回来时 `view.setState` 塞回去。所以「组装 state」必须是能脱离 view 调用的
 * 一步，而不是 `EditorController` 的私有方法。
 *
 * onUpdate 烘进 state 而不是挂在 view 上，是这套架构成立的关键：切换标签只换 state，
 * 换完之后触发更新的监听器就是新标签自己那个，路由不需要任何额外的判断。
 */
export function createEditorState(options: EditorStateOptions): EditorState {
  const { doc = '', onUpdate, ...setup } = options
  const extensions = buildExtensions(setup)
  if (onUpdate) {
    extensions.push(
      EditorView.updateListener.of((u) => {
        // 视口/几何变化也会触发 updateListener，只在真正关心的两类变化上回调
        if (!u.docChanged && !u.selectionSet) return
        onUpdate({
          docChanged: u.docChanged,
          selectionChanged: u.selectionSet,
          lines: u.state.doc.lines,
          chars: u.state.doc.length,
        })
      }),
    )
  }
  return EditorState.create({ doc, extensions })
}

/**
 * 换行当前是否生效。
 *
 * 读 state 上的 facet 而不是 `view.lineWrapping`：后者读的是 heightOracle，只在 measure
 * 阶段刷新——没有真实布局时（jsdom）压根不更新，刚 `setState` 完时也是过期的。
 * facet 是 state 的一部分，与配置永远同步。
 */
export function lineWrapEnabled(state: EditorState): boolean {
  return state
    .facet(EditorView.contentAttributes)
    .some((attrs) => typeof attrs !== 'function' && attrs.class === 'cm-lineWrapping')
}

/**
 * 这套 state 当前是不是暗色（M4-C）。
 *
 * 与 `lineWrapEnabled` 同一个用途：`applyViewConfig` 靠它做「已经一致就什么都不做」的
 * 早退，免得切一次换行顺手把所有标签的 state 对象都换掉（那些靠 `===` 判断 state 没动过
 * 的地方会失准）。`EditorView.darkTheme` 是个布尔 facet，`state.facet` 直接给出合并后的值。
 */
export function darkThemeEnabled(state: EditorState): boolean {
  return state.facet(EditorView.darkTheme)
}
