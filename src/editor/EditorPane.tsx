import type { EditorState } from '@codemirror/state'
import { onCleanup, onMount } from 'solid-js'
import { EditorController } from './controller'

export interface EditorPaneProps {
  /**
   * 挂载时显示的那个 state。只在 `onMount` 读一次——之后换标签、换文档一律走
   * `EditorController.restore`，不重读 props。
   */
  state: EditorState
  onReady: (controller: EditorController) => void
  /** 视图被销毁时通知宿主，让 workspace 把对应分屏的现场存回标签 */
  onDestroy?: () => void
  /**
   * 这块分屏拿到焦点时通知宿主。
   *
   * 挂在容器上而不是 `.cm-content` 上：`.cm-content` 是 CM6 自己造的，外面碰不到它，
   * 而 focusin 会冒泡，容器能收到里面任何元素的聚焦（包括查找面板的输入框——
   * 那也算「焦点在这块分屏里」，是对的）。
   */
  onFocus?: () => void
}

/**
 * Solid 与 CM6 的边界。
 *
 * ⛔ **Solid 的响应式绝不能碰 CM6 的 DOM。** props 只在 `onMount` 读一次，之后改文档、
 * 换标签都走 `EditorController` 的方法；反方向只能经 `onUpdate` 回调把状态推给 signal。
 *
 * 为什么这条是硬规则：CM6 自己用 measure / read 两阶段调度管理 DOM，外部在它两次
 * 测量之间改动 DOM，会让它的行高缓存与滚动位置全部失准——表现是光标错位、滚动跳动，
 * 而且只在特定时序下复现。用 JSX 绑定 `{text}` 之类的写法看着无害，实际就是在制造这个竞态。
 *
 * 一条不变量：**一个 EditorPane = 一个 EditorController = 一个 EditorView**。
 * 多标签换的是里面的 state，不是这里的实例；分屏才会多渲染几个 EditorPane。
 */
export function EditorPane(props: EditorPaneProps) {
  let host!: HTMLDivElement
  let controller: EditorController | undefined

  onMount(() => {
    controller = new EditorController(host, props.state)
    props.onReady(controller)
  })

  onCleanup(() => {
    // 先通知再销毁：宿主要趁 view 还活着把现场存回标签，反过来就只剩一个空壳了
    props.onDestroy?.()
    controller?.destroy()
    controller = undefined
  })

  return <div class="editor-container" ref={host} onFocusIn={() => props.onFocus?.()} />
}
