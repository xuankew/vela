import { Compartment, type EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { EditorSnapshot } from '../editor/controller'
import { createEditorState, lineWrapEnabled, type EditorUpdateInfo } from '../editor/setup'
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
 * `markdownMode` 眼下也是全局的：M1-E 做「按扩展名分语言」时它要变成每标签一个，
 * 到那时这个字段从 ViewConfig 挪到 Tab 上。
 */
export interface ViewConfig {
  lineWrap: boolean
  markdownMode: boolean
  readonly lineWrapSlot: Compartment
}

export function createViewConfig(lineWrap = true, markdownMode = true): ViewConfig {
  return { lineWrap, markdownMode, lineWrapSlot: new Compartment() }
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
}

export interface CreateTabInit {
  id: number
  text?: string
  config: ViewConfig
  host: TabHost
  onUpdate?: (info: EditorUpdateInfo) => void
}

export function buildState(text: string, config: ViewConfig, onUpdate?: (info: EditorUpdateInfo) => void): EditorState {
  return createEditorState({
    doc: text,
    lineWrap: config.lineWrap,
    markdownMode: config.markdownMode,
    lineWrapSlot: config.lineWrapSlot,
    onUpdate,
  })
}

export function createTab(init: CreateTabInit): Tab {
  // `tab` 在自己的初始化表达式里被三个闭包引用。闭包只会在 createTab 返回之后被调用，
  // 所以这不是 TDZ 问题；写成两段赋值只是为了让 host 能拿到标签自己。
  let tab: Tab
  tab = {
    id: init.id,
    snapshot: { state: buildState(init.text ?? '', init.config, init.onUpdate), scrollTop: 0, scrollLeft: 0 },
    ...(init.onUpdate ? { onUpdate: init.onUpdate } : {}),
    doc: createDocumentModel({
      getText: () => init.host.getText(tab),
      setText: (text) => init.host.setText(tab, text),
      focus: () => init.host.focus(tab),
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
  tab.snapshot = { state: buildState(text, config, tab.onUpdate), scrollTop: 0, scrollLeft: 0 }
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
  if (lineWrapEnabled(tab.snapshot.state) === config.lineWrap) return
  const effects = config.lineWrapSlot.reconfigure(config.lineWrap ? [EditorView.lineWrapping] : [])
  tab.snapshot = { ...tab.snapshot, state: tab.snapshot.state.update({ effects }).state }
}
