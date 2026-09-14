import { onCleanup, onMount } from 'solid-js'
import { EditorController, type EditorOptions } from './controller'

export interface EditorPaneProps {
  /** 只在挂载时读一次。之后的变更一律走 controller 的方法，不重读 props */
  options: EditorOptions
  onReady: (controller: EditorController) => void
}

/**
 * Solid 与 CM6 的边界。
 *
 * ⛔ **Solid 的响应式绝不能碰 CM6 的 DOM。** props 只在 `onMount` 读一次，之后改文档、
 * 改换行都走 `EditorController` 的方法；反方向只能经 `onUpdate` 回调把状态推给 signal。
 *
 * 为什么这条是硬规则：CM6 自己用 measure / read 两阶段调度管理 DOM，外部在它两次
 * 测量之间改动 DOM，会让它的行高缓存与滚动位置全部失准——表现是光标错位、滚动跳动，
 * 而且只在特定时序下复现。用 JSX 绑定 `{text}` 之类的写法看着无害，实际就是在制造这个竞态。
 */
export function EditorPane(props: EditorPaneProps) {
  let host!: HTMLDivElement
  let controller: EditorController | undefined

  onMount(() => {
    controller = new EditorController(host, props.options)
    props.onReady(controller)
  })

  onCleanup(() => {
    controller?.destroy()
    controller = undefined
  })

  return <div class="editor-container" ref={host} />
}
