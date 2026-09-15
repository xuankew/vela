import { For, onMount, Show } from 'solid-js'
import type { DiscardDecision } from './workspace'

export interface DiscardDialogProps {
  /** 待决文档的显示名。关标签时是一个，关窗口时可能是一串 */
  names: string[]
  onDecide: (decision: DiscardDecision) => void
}

/**
 * 「有未保存的改动」的三选一。
 *
 * **为什么不用原生对话框**：`@tauri-apps/plugin-dialog` 只有 `message` / `ask` / `confirm`，
 * 全是**两个**按钮，而这里必须有三条出路——保存、不保存、取消。少掉「取消」的话，
 * Esc（rfd 上映射到 cancel 那一支）就成了「直接扔掉改动」，那是个数据丢失陷阱。
 * 顺带的好处是这一层能在 jsdom 里测；原生对话框只能 mock 掉，分支覆盖全是假的。
 *
 * 按钮顺序照 macOS 的习惯：破坏性的「不保存」在中间，默认焦点落在安全的「保存」上，
 * 于是「什么都不看直接按回车」= 保存，不是丢数据。
 */
export function DiscardDialog(props: DiscardDialogProps) {
  let saveButton!: HTMLButtonElement

  onMount(() => saveButton.focus())

  const title = () =>
    props.names.length === 1
      ? `「${props.names[0]}」有未保存的改动`
      : `${props.names.length} 个文档有未保存的改动`

  return (
    <div
      class="modal-backdrop"
      onKeyDown={(e) => {
        // Escape 只在这个对话框自己的子树里生效，不注册进命令中心——见 commands/builtins.ts
        // 里「绑 Escape 的命令一律不注册」那条规矩
        if (e.key === 'Escape') {
          e.stopPropagation()
          props.onDecide('cancel')
        }
      }}
    >
      <div class="modal" role="alertdialog" aria-modal="true" aria-label={title()}>
        <p class="modal-title">{title()}</p>
        <Show when={props.names.length > 1}>
          <ul class="modal-list">
            <For each={props.names}>{(name) => <li>{name}</li>}</For>
          </ul>
        </Show>
        <div class="modal-actions">
          <button onClick={() => props.onDecide('cancel')}>取消</button>
          <button onClick={() => props.onDecide('discard')}>不保存</button>
          <button class="primary" ref={saveButton} onClick={() => props.onDecide('save')}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
