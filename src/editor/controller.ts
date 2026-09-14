import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { buildExtensions } from './setup'

export interface EditorUpdateInfo {
  docChanged: boolean
  selectionChanged: boolean
  lines: number
  chars: number
}

export interface EditorOptions {
  doc?: string
  lineWrap?: boolean
  markdownMode?: boolean
  /** CM6 → 外部的唯一出口。Solid 侧只在这里把状态推进 signal */
  onUpdate?: (info: EditorUpdateInfo) => void
}

/**
 * 一个编辑器实例的生命周期持有者。
 *
 * 存在的理由是把 CM6 的两条硬约束关在一个地方：
 * 1. **扩展是 state 的一部分**，改扩展要么 reconfigure（Compartment）要么换 state，
 *    不能像改 DOM 属性那样随手赋值；
 * 2. **`view.destroy()` 必须被调用**，否则 ResizeObserver 与 DOM 事件监听会跟着
 *    标签页一起泄漏——M1-D 的多标签/分屏会反复创建销毁实例，这条是硬要求。
 */
export class EditorController {
  view: EditorView

  private readonly onUpdate?: (info: EditorUpdateInfo) => void
  /** 自动换行的开关槽位。用 Compartment 才能不重建视图就切换，选区与滚动位置都不丢 */
  private readonly lineWrapSlot = new Compartment()
  private wrap: boolean
  private markdown: boolean
  private disposed = false

  constructor(host: HTMLElement, options: EditorOptions = {}) {
    this.onUpdate = options.onUpdate
    this.wrap = options.lineWrap ?? true
    this.markdown = options.markdownMode ?? true
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: options.doc ?? '', extensions: this.assemble() }),
    })
  }

  private assemble(): Extension[] {
    const exts = buildExtensions({
      lineWrap: this.wrap,
      markdownMode: this.markdown,
      lineWrapSlot: this.lineWrapSlot,
    })
    if (this.onUpdate) {
      const notify = this.onUpdate
      exts.push(
        EditorView.updateListener.of((u) => {
          // 视口/几何变化也会触发 updateListener，只在真正关心的两类变化上回调
          if (!u.docChanged && !u.selectionSet) return
          notify({
            docChanged: u.docChanged,
            selectionChanged: u.selectionSet,
            lines: u.state.doc.lines,
            chars: u.state.doc.length,
          })
        }),
      )
    }
    return exts
  }

  private assertAlive() {
    if (this.disposed) throw new Error('编辑器实例已销毁')
  }

  get doc(): string {
    return this.view.state.doc.toString()
  }

  get lines(): number {
    return this.view.state.doc.lines
  }

  get chars(): number {
    return this.view.state.doc.length
  }

  get lineWrap(): boolean {
    return this.wrap
  }

  setLineWrap(on: boolean) {
    this.assertAlive()
    if (on === this.wrap) return
    this.wrap = on
    this.view.dispatch({
      effects: this.lineWrapSlot.reconfigure(on ? [EditorView.lineWrapping] : []),
    })
  }

  /**
   * 整篇换文档（打开文件、切换标签）。
   *
   * 走 `setState` 换掉整个 state 而不是 dispatch 一个覆盖全文的变更：撤销历史属于
   * state，dispatch 会让 Cmd+Z 把**上一个文件**的内容拉回来。换文档就该是新文档。
   */
  setDoc(text: string) {
    this.assertAlive()
    this.view.setState(EditorState.create({ doc: text, extensions: this.assemble() }))
    // setState 不产生事务，updateListener 收到的 docChanged / selectionSet 都是 false，
    // 会被守卫挡掉。但换文档正是状态栏最该知道的事，所以这里显式补一次回调。
    this.onUpdate?.({
      docChanged: true,
      selectionChanged: true,
      lines: this.lines,
      chars: this.chars,
    })
  }

  focus() {
    this.assertAlive()
    this.view.focus()
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    this.view.destroy()
  }
}
