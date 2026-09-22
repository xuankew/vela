import { Facet, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type PluginValue } from '@codemirror/view'

/**
 * Cmd+鼠标滚轮动态调整编辑器字体大小（macOS: Cmd, Windows/Linux: Ctrl）。
 *
 * 与 `Mod+=` / `Mod+-` 走同一条路：调用注入的回调，由 settings store 统一管
 * sanitize + CSS 变量 + 写穿。这个插件只负责「识别手势 + 把方向翻译成步进」。
 */

const fontSizeZoomFacet = Facet.define<(delta: number) => void>()

class FontSizeZoomPlugin implements PluginValue {
  private view: EditorView
  private handler: (e: WheelEvent) => void

  constructor(view: EditorView) {
    this.view = view
    const dom = view.dom as HTMLElement
    this.handler = (e: WheelEvent) => {
      // macOS: metaKey (Cmd), Windows/Linux: ctrlKey (Ctrl)
      if (!e.metaKey && !e.ctrlKey) return
      // 按住 Shift 滚轮通常是横向滚动，不该触发字号调整
      if (e.shiftKey) return

      e.preventDefault()
      // deltaY > 0 = 向下滚（缩小），< 0 = 向上滚（放大）
      const delta = e.deltaY < 0 ? 1 : -1

      // 从 state 的 facet 里取所有注册的回调并依次调用
      const callbacks = view.state.facet(fontSizeZoomFacet)
      for (const cb of callbacks) {
        cb(delta)
      }
    }

    dom.addEventListener('wheel', this.handler, { passive: false })
  }

  update() {
    // 不需要响应状态变化，只是监听 DOM 事件
  }

  destroy() {
    const dom = this.view.dom as HTMLElement
    dom.removeEventListener('wheel', this.handler)
  }
}

export const fontSizeZoomPlugin = ViewPlugin.fromClass(FontSizeZoomPlugin)

/**
 * 注册一个字号调整回调到当前编辑器。
 *
 * @param onStep - 步进回调，参数是方向（+1 = 放大，-1 = 缩小）
 * @returns CM6 扩展，需要装进编辑器的扩展集
 */
export function fontSizeZoom(onStep: (delta: number) => void): Extension {
  return [fontSizeZoomFacet.of(onStep), fontSizeZoomPlugin]
}
