import { onMount, Show } from 'solid-js'
import type { ConflictChoice, FileConflict } from './fileWatch'

export interface FileConflictDialogProps {
  conflict: FileConflict
  /** 队列里还等着几个（不含这一个）。为 0 时那一行不出现 */
  pending: number
  onChoose: (choice: ConflictChoice) => void
}

/**
 * 「磁盘上有人动了我打开着的文件」的裁决框（M2-G-5）。
 *
 * 只在**没法自动决定**的时候弹：脏文档被外部改了、或者文件被外部删了。干净文档被改
 * 走的是静默重载（`src/doc/fileWatch.ts`），一个字都不问——那种情况下磁盘上的那份
 * 就是唯一的真相，问一句只是打断用户。
 *
 * ## 为什么不复用 `DiscardDialog`
 *
 * 它问的是「这个文档还要不要」，三条出路是保存 / 不保存 / 取消；这里问的是
 * 「盘上和手里这份不一致，以哪份为准」，出路是覆盖 / 另存为 / 保留。两组按钮里
 * 没有一个的含义是重合的，而 `DiscardDecision` 与 `ConflictChoice` 一旦混用，
 * 「取消」就会被当成「保留我的改动」——那是一个数据丢失陷阱的反面版本：
 * 用户以为什么都没发生，其实已经决定了。
 *
 * ## ⚠️ 三个按钮一个都不给 `.primary`
 *
 * 与 `DiscardDialog`（`.primary` 落在「保存」上）刻意不同：那里有一条明显更安全的出路，
 * 这里没有——「覆盖」「另存为」「保留」哪个对，取决于用户刚才在别的程序里做了什么，
 * 而 Vela 一点都不知道。给其中一个染上主色等于替用户猜。
 *
 * 默认焦点仍然落在最右那一个安全动作上（保留），于是「什么都不看直接按回车」不会
 * 扔掉任何东西；破坏性那一条靠 `.modal-warn` 那句话说，不靠颜色（与 `ReplaceConfirm`
 * 同一条处理）。
 */
export function FileConflictDialog(props: FileConflictDialogProps) {
  let keepButton!: HTMLButtonElement

  onMount(() => keepButton.focus())

  const changed = () => props.conflict.kind === 'changed'

  const title = () =>
    changed() ? `「${props.conflict.name}」在 Vela 之外被改过了` : `「${props.conflict.name}」在磁盘上已经没有了`

  return (
    <div
      class="modal-backdrop"
      onKeyDown={(e) => {
        // 与 DiscardDialog / ReplaceConfirm 同一条规矩：Escape 只在这个对话框自己的
        // 子树里生效，不注册进命令中心（见 commands/builtins.ts 里那条）
        if (e.key === 'Escape') {
          e.stopPropagation()
          props.onChoose('keep')
        }
      }}
    >
      <div class="modal" role="alertdialog" aria-modal="true" aria-label={title()}>
        <p class="modal-title">{title()}</p>

        <p class="modal-body">
          {changed()
            ? '磁盘上那一份已经不是你眼前这些内容了，而这个文档还有没保存的改动。'
            : // ⚠️ 不说「被删掉了」了事：`removed` 的判据只是「那个路径现在不存在」
              // （见 `vela_core::watcher::classify`），改名与移走在 FSEvents 上长得一样
              '可能被删掉了，也可能被移走或者改了名字。编辑器里这一份是仅存的副本。'}
        </p>

        {/* 全路径单独一行：两个不同目录里的同名文件同时被改时，只报文件名认不出来 */}
        <p class="modal-body">{props.conflict.path}</p>

        <Show when={props.pending > 0}>
          <p class="modal-body">后面还有 {props.pending} 个文件要问。</p>
        </Show>

        <p class="modal-warn">
          {changed()
            ? '用磁盘上的那份覆盖会把你没保存的改动扔掉，而 Vela 里没有撤销。'
            : '「关闭标签」会连编辑器里这一份一起扔掉；它有未保存的改动时 Vela 会再问一次。'}
        </p>

        <div class="modal-actions">
          {/* 破坏性的在左、安全动作在最右并且拿走默认焦点，与另外两个对话框同一套排法 */}
          <Show when={changed()} fallback={<button onClick={() => props.onChoose('closeTab')}>关闭标签</button>}>
            <button onClick={() => props.onChoose('overwrite')}>用磁盘上的覆盖</button>
          </Show>
          <button onClick={() => props.onChoose('saveAs')}>另存为…</button>
          <button ref={keepButton} onClick={() => props.onChoose('keep')}>
            {changed() ? '保留我的改动' : '保留标签'}
          </button>
        </div>
      </div>
    </div>
  )
}
