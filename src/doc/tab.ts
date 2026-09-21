import { Compartment, type EditorState, type StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { EditorSnapshot } from '../editor/controller'
import type { LanguageChoice } from '../editor/language'
import type { PasteImageHook } from '../editor/paste'
import { createEditorState, darkThemeEnabled, lineWrapEnabled, type EditorUpdateInfo } from '../editor/setup'
import { createDocumentModel, type DocumentModel } from './document'

/**
 * 一个标签 = 一份文档模型 + 一份可独立存活的编辑器状态。
 *
 * 为什么状态属于标签而不属于视图：撤销历史、选区、滚动位置都是「这个文件读到哪儿了」的
 * 一部分，切换标签时必须整体存取。CM6 的 `EditorState` 正好是不可变的、可以脱离
 * `EditorView` 存在的对象——所以「一个标签一份 state、一个分屏一个 view，切换时
 * `view.setState`」是最省事也最不会出错的形态，不需要任何自己写的位置映射。
 */

/**
 * 视图级设置：所有标签共用。
 *
 * `lineWrapSlot` 必须是**同一个 Compartment 实例**。Compartment 的 reconfigure 按实例寻址
 * （state 内部有一张 Compartment → 内容的表），换一个新实例就等于换了一个开关，
 * 之前那个再也拨不动。共享一个实例，一次 reconfigure 才能同时作用于「正在显示的那个 view」
 * 与「存着的所有 state」。
 *
 * 语言不在这儿：它由每个标签自己的路径决定，槽位因此是**每标签一个实例**（见 `Tab`）。
 * 同一个 Compartment 实例被多个 state 共享时，reconfigure 会一次拨动全部——那正是换行
 * 想要的、也正是语言不想要的。
 */
export interface ViewConfig {
  lineWrap: boolean
  readonly lineWrapSlot: Compartment
  /**
   * 当前是不是暗色（M4-C 主题系统）。与 `lineWrap` 同为**全局视图设置**：不由单个标签决定，
   * 而由「现在这套配色是亮还是暗」决定，所以共享一个 `darkSlot` 实例，一次 reconfigure
   * 拨动所有标签。由 workspace 的 `setDarkTheme` 改写（见 `doc/workspace.ts`）。
   */
  dark: boolean
  /** 深浅色的开关槽位，共享一个实例。理由与 `lineWrapSlot` 逐字相同，见 `editor/setup.ts` 的 `darkSlot` */
  readonly darkSlot: Compartment
  /**
   * 词补全的「其他文档」来源，工作区内所有标签共用同一个 getter。
   *
   * 放在这儿而不是每标签一个：同伴关系是**工作区**的性质（每个标签都该看到同一批
   * 别的标签），跟 `lineWrapSlot` 同一条理由。缺省返回空，于是没有工作区兜着的时候
   * 词补全只用当前文档自己那份词典。
   */
  readonly peerStates: () => Iterable<EditorState>
  /**
   * 粘贴图片的处理者，工作区内所有标签共用同一个（M3-A-7）。
   *
   * 与 `peerStates` 同一条理由放在这儿而不是每标签一个：「粘进来的图落到哪个目录」
   * 由**收到事件的那个 view 正在显示的文档**决定，那是工作区的知识；一个标签自己
   * 答不上来，而且每标签复制一份闭包只会让「谁说了算」这件事变模糊。
   *
   * 缺省 = 不接，粘贴走 CM6 的默认路径（`createEditorState` 被单独调用时，比如测试）。
   */
  readonly pasteImage?: PasteImageHook
}

export function createViewConfig(
  lineWrap = true,
  peerStates: () => Iterable<EditorState> = () => [],
  pasteImage?: PasteImageHook,
  dark = true,
): ViewConfig {
  // `pasteImage` 是可选的，所以只能条件展开：`exactOptionalPropertyTypes` 虽然没开，
  // 但显式写一个 `pasteImage: undefined` 会让「缺省」与「传了个 undefined」在
  // 序列化与 `in` 判断上分岔，而这一份 config 是要进 state 的
  return {
    lineWrap,
    dark,
    lineWrapSlot: new Compartment(),
    darkSlot: new Compartment(),
    peerStates,
    ...(pasteImage ? { pasteImage } : {}),
  }
}

export interface Tab {
  readonly id: number
  readonly doc: DocumentModel
  /**
   * 这个标签的权威编辑器状态。
   *
   * 显示期间以 `view.state` 为准（每次按键都在那边产生新 state），切走前 capture 回来；
   * 没被任何分屏显示时，这里就是唯一的真相。
   */
  snapshot: EditorSnapshot
  /** 重建 state 时要原样带上的回调。存在标签上而不是每次由调用方传，否则换文档会顺手换掉监听器 */
  readonly onUpdate?: (info: EditorUpdateInfo) => void
  /** 语言槽位，每标签一个实例。理由见 `ViewConfig` 的注释 */
  readonly languageSlot: Compartment
  /** 当前装着的语言。`null` = 槽位还是空的（刚重建完 state，还没装） */
  language: LanguageChoice | null
  /** 异步子语言加载的代号。加载回来时若已不等于当前值，说明期间又换过语言，结果要丢掉 */
  languageToken: number
}

/**
 * 标签反过来向 workspace 要的宿主能力。
 *
 * 三个方法都需要知道「这个标签此刻显示在哪个分屏里」，那是 workspace 的知识；
 * 而 `DocumentModel` 又必须是标签的一部分。所以只能这样双向注入：workspace 造 TabHost，
 * createTab 把它接到 DocumentHost 上。
 */
export interface TabHost {
  getText(tab: Tab): string
  setText(tab: Tab, text: string): void
  focus(tab: Tab): void
  /** 路径变了（打开文件、另存为）。跟着路径走的东西——眼下只有语言——由宿主重算 */
  pathChanged(tab: Tab): void
}

export interface CreateTabInit {
  id: number
  text?: string
  config: ViewConfig
  host: TabHost
  onUpdate?: (info: EditorUpdateInfo) => void
}

export function buildState(
  text: string,
  config: ViewConfig,
  languageSlot: Compartment,
  onUpdate?: (info: EditorUpdateInfo) => void,
): EditorState {
  // 刻意不传 language：建出来的槽位是空的，语言一律由 workspace 的 syncLanguage 装。
  // 留两条安装路径的话，子语言懒加载回来的那一刻就得再判断一次「这个 state 是哪条路建的」
  return createEditorState({
    doc: text,
    lineWrap: config.lineWrap,
    lineWrapSlot: config.lineWrapSlot,
    dark: config.dark,
    darkSlot: config.darkSlot,
    languageSlot,
    peerStates: config.peerStates,
    ...(config.pasteImage ? { pasteImage: config.pasteImage } : {}),
    onUpdate,
  })
}

export function createTab(init: CreateTabInit): Tab {
  // 每标签一个实例：语言是标签的属性，共享实例会让改一个标签的语言波及全部
  const languageSlot = new Compartment()
  // `tab` 在自己的初始化表达式里被三个闭包引用。闭包捕获的是绑定而不是值，
  // 而且只会在 createTab 返回之后才被调用，所以写成 const 也撞不上 TDZ。
  const tab: Tab = {
    id: init.id,
    snapshot: {
      state: buildState(init.text ?? '', init.config, languageSlot, init.onUpdate),
      scrollTop: 0,
      scrollLeft: 0,
    },
    ...(init.onUpdate ? { onUpdate: init.onUpdate } : {}),
    languageSlot,
    language: null,
    languageToken: 0,
    doc: createDocumentModel({
      getText: () => init.host.getText(tab),
      setText: (text) => init.host.setText(tab, text),
      focus: () => init.host.focus(tab),
      pathChanged: () => init.host.pathChanged(tab),
    }),
  }
  return tab
}

/** 标签存着的正文。显示中的标签请先 capture，否则读到的是切走那一刻的旧值 */
export function tabText(tab: Tab): string {
  return tab.snapshot.state.doc.toString()
}

export function tabLines(tab: Tab): number {
  return tab.snapshot.state.doc.lines
}

export function tabChars(tab: Tab): number {
  return tab.snapshot.state.doc.length
}

/**
 * 整篇换正文（打开文件、新建标签）。
 *
 * 新建 state 而不是 dispatch 一个覆盖全文的变更：撤销历史属于 state，dispatch 会让
 * Cmd+Z 把**上一个文件**的内容拉回来。换文档就该是新文档。滚动位置一并归零。
 */
export function replaceTabText(tab: Tab, text: string, config: ViewConfig) {
  tab.snapshot = {
    state: buildState(text, config, tab.languageSlot, tab.onUpdate),
    scrollTop: 0,
    scrollLeft: 0,
  }
  // 新 state 的语言槽位是空的。不归零的话 syncLanguage 会认为「语言没变」直接跳过，
  // 于是打开文件之后既没有语法高亮也没有字体分区，而且静默无报错
  tab.language = null
}

/**
 * 把当前视图配置落到一个**没有显示在任何分屏里**的标签上。
 *
 * 显示中的那个必须走 `view.dispatch`：`setState` 会销毁并重建所有视图插件、
 * 重排整个 docView，焦点与滚动位置都会丢。而没在显示的标签没有 view 可 dispatch，
 * `state.update(...).state` 是唯一的路——这也正是「state 能脱离 view 存活」的用处。
 */
export function applyViewConfig(tab: Tab, config: ViewConfig) {
  // 已经一致就什么都不做：不这样的话，切一次换行会把**所有**标签的 state 对象都换掉，
  // 内容虽然没变，但任何靠 `===` 判断「state 没动过」的地方都会失准。
  // 换行与深浅色是两个独立的槽位，各自比对、各自补一条 reconfigure，都一致时才整个跳过
  const state = tab.snapshot.state
  const effects: StateEffect<unknown>[] = []
  if (lineWrapEnabled(state) !== config.lineWrap) {
    effects.push(config.lineWrapSlot.reconfigure(config.lineWrap ? [EditorView.lineWrapping] : []))
  }
  if (darkThemeEnabled(state) !== config.dark) {
    effects.push(config.darkSlot.reconfigure(EditorView.darkTheme.of(config.dark)))
  }
  if (effects.length === 0) return
  tab.snapshot = { ...tab.snapshot, state: state.update({ effects }).state }
}
