/**
 * JSON 可视化预览面板。类似 MarkdownPreview，显示当前编辑器内容的 JSON 树形视图。
 *
 * ## 使用方式
 *
 * - 快捷键 `Cmd+Shift+K` 切换显示/隐藏
 * - 点击节点前的 ▾/ 按钮展开/收起子节点
 * - 自动跟随编辑器内容更新（防抖）
 */

import { createSignal, onCleanup, onMount, Show, untrack } from 'solid-js'
import { renderJson, jsonTreeScript } from './render'
import type { PanelRefreshSource } from '../md/panel'
import { createPanelRefresh } from '../md/panel'

export interface JsonPreviewProps extends PanelRefreshSource {
  onClose: () => void
}

export function JsonPreview(props: JsonPreviewProps) {
  /** 面板顶部提示消息 */
  const [note, setNote] = createSignal<string | null>(null)
  let scrollEl: HTMLDivElement | undefined
  let bodyEl: HTMLDivElement | undefined

  // 「换文档立刻渲染、改正文防抖」与卸载时取消在飞的那一次
  createPanelRefresh(props, render)

  function render() {
    if (!bodyEl) return

    const source = untrack(() => props.source())

    if (!source) {
      bodyEl.innerHTML = ''
      setNote('没有打开的文档')
      return
    }

    const doc = source.view.state.doc
    if (!doc) {
      bodyEl.innerHTML = ''
      setNote('没有打开的文档')
      return
    }

    const text = doc.toString().trim()
    if (!text) {
      bodyEl.innerHTML = ''
      setNote('文档内容为空')
      return
    }

    try {
      const value = JSON.parse(text)
      const html = renderJson(value, { defaultExpanded: true })
      bodyEl.innerHTML = html

      // 注入交互脚本
      const script = document.createElement('script')
      script.textContent = jsonTreeScript()
      bodyEl.appendChild(script)

      setNote(null)
    } catch (err) {
      bodyEl.innerHTML = ''
      const msg = err instanceof Error ? err.message : String(err)
      setNote(`JSON 解析失败：${msg}`)
    }
  }

  onMount(() => {
    // 初始渲染
    if (props.source()) render()
  })

  onCleanup(() => {
    // 清理资源
  })

  return (
    <div class="json-preview-panel">
      <div class="json-preview-header">
        <span class="json-preview-title">JSON 预览</span>
        <button class="json-preview-close" onClick={props.onClose} title="关闭预览">
          ✕
        </button>
      </div>

      <Show when={note()}>
        <div class="json-preview-note">{note()}</div>
      </Show>

      <div class="json-preview-scroll" ref={scrollEl}>
        <div class="json-preview-body" ref={bodyEl} />
      </div>
    </div>
  )
}
