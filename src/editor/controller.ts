import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { lineWrapEnabled } from './setup'

/**
 * 一个标签的完整可复原状态。
 *
 * state 本身不含滚动位置——那是 view 的几何属性，不是文档的属性。切换标签时两样都得
 * 存，否则切回来视口跳回顶部：文档没变，但用户「读到哪儿了」丢了。
 */
export interface EditorSnapshot {
  state: EditorState
  scrollTop: number
  scrollLeft: number
}

/**
 * 一块可见编辑区（分屏）的生命周期持有者。
 *
 * 存在的理由是把 CM6 的两条硬约束关在一个地方：
 * 1. **扩展是 state 的一部分**，改扩展要么 reconfigure（Compartment）要么换 state，
 *    不能像改 DOM 属性那样随手赋值；
 * 2. **`view.destroy()` 必须被调用**，否则 ResizeObserver 与 DOM 事件监听会跟着
 *    标签页一起泄漏——多标签/分屏会反复创建销毁实例，这条是硬要求。
 *
 * ⛔ **这里刻意不持有「当前文档」的概念。** 正文、撤销历史、换行偏好都属于**标签**
 * （见 `src/doc/tab.ts`），一个分屏只是轮流显示它们。把 setDoc / setLineWrap 放在这里
 * 是 M1-C 之前的单文档形态留下的形状：多标签下它无处安放——「改文档」要先回答
 * 「改哪个标签的」，而这个问题只有 workspace 答得上来。
 */
export class EditorController {
  view: EditorView

  private disposed = false

  constructor(host: HTMLElement, state: EditorState) {
    this.view = new EditorView({ parent: host, state })
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
    return lineWrapEnabled(this.view.state)
  }

  /** 把当前显示的 state 与滚动位置取走，好让 view 去显示别的东西 */
  capture(): EditorSnapshot {
    this.assertAlive()
    const { scrollDOM } = this.view
    return { state: this.view.state, scrollTop: scrollDOM.scrollTop, scrollLeft: scrollDOM.scrollLeft }
  }

  /**
   * `capture` 的逆操作：把某个标签的 state 装回 view，并复原视口。
   *
   * 滚动位置在 `setState` **之后**赋值：setState 会重建整个 docView，先赋的值会被新内容的
   * 布局冲掉。
   */
  restore(snapshot: EditorSnapshot) {
    this.assertAlive()
    this.view.setState(snapshot.state)
    this.view.scrollDOM.scrollTop = snapshot.scrollTop
    this.view.scrollDOM.scrollLeft = snapshot.scrollLeft
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
