import { onMount, Show } from 'solid-js'
import type { ConfirmApply } from './store'

export interface ReplaceConfirmProps {
  /** 摊在屏幕上的那份清单。数字由 store 的 `countPreview` 算，这里只负责说成人话 */
  plan: ConfirmApply
  onApply: () => void
  onCancel: () => void
}

/**
 * 「替换全部」的确认单（M2-D）。
 *
 * ## 为什么必须弹这一下
 *
 * 这是整个 Vela 里**唯一一处不可撤销的批量写盘**：`start_replace` 逐个文件原子写，
 * 写完就是磁盘上的新内容，而编辑器的撤销栈只存在于单个文档里——跨文件没有 undo。
 * 搜索面板上点一条命中只是跳过去，落盘这一步是「几十个文件同时变」。
 *
 * ## 为什么不用原生对话框
 *
 * 与 `DiscardDialog` / `NameDialog` 同一条理由：`@tauri-apps/plugin-dialog` 的 `confirm`
 * 只有「是 / 否」两个按钮和一行文字，装不下「几个文件、几行、几个被跳过、有没有撞上限」
 * 这四件事。而这四件事恰恰是用户批准与否的全部依据。
 *
 * ## ⚠️ 破坏性靠**文字**说，不靠视觉
 *
 * 没有红色按钮、没有加粗的「危险」标记、默认焦点也**不**落在「替换」上。
 * 一个红底白字的大按钮在一天点五十次的动作里只会变成噪声，而「这一步没法撤销」
 * 这句话每次都得读一遍。这也是本项目对反向/破坏性动作的一贯处理（见 `.find-act`
 * 那两个只做小图标的按钮）。
 *
 * ## 数字说的是「行」不是「处」
 *
 * `plan.lines` 数的是命中**行**，而一行里可以有多处命中。`SearchHit.ranges` 上限是
 * 32 段而且可能为空（见 `ipc/search.ts`），所以「处」这个数在前端算不准——
 * 报一个偏小的数字比报一个口径不同但准确的数字更坏：用户会以为动的地方比实际少。
 */
export function ReplaceConfirm(props: ReplaceConfirmProps) {
  let cancelButton!: HTMLButtonElement

  // 默认焦点落在安全的那一个上：「什么都不看直接按回车」= 取消，不是改磁盘
  onMount(() => cancelButton.focus())

  const title = () =>
    props.plan.deleting
      ? `删掉 ${props.plan.lines} 行上的命中内容？`
      : `替换 ${props.plan.files} 个文件里的 ${props.plan.lines} 行？`

  return (
    <div
      class="modal-backdrop"
      onKeyDown={(e) => {
        // 与 DiscardDialog / NameDialog 同一条规矩：Escape 只在这个对话框自己的子树里生效，
        // 不注册进命令中心（见 commands/builtins.ts 里「绑 Escape 的命令一律不注册」那条）
        if (e.key === 'Escape') {
          e.stopPropagation()
          props.onCancel()
        }
      }}
    >
      <div class="modal" role="alertdialog" aria-modal="true" aria-label={title()}>
        <p class="modal-title">{title()}</p>

        <p class="modal-body">
          {props.plan.deleting
            ? // ⚠️ 必须把「行本身留着」说出来：「删掉 12 行」的字面意思是整行消失，
              // 而这个操作删的只是命中的那一段。理解错了的用户会以为要丢掉 12 行代码
              `替换内容是空的，所以命中的那一段会被删掉——行本身留着。涉及 ${props.plan.files} 个文件、${props.plan.lines} 行（一行里可能有多处）。`
            : `把命中的那一段换成你填的内容。涉及 ${props.plan.files} 个文件、${props.plan.lines} 行（一行里可能有多处）。`}
        </p>

        <Show when={props.plan.skipped > 0}>
          <p class="modal-body">
            另有 {props.plan.skipped} 个文件正开着且有未保存的改动，会被跳过——保存它们之后再换一遍。
          </p>
        </Show>

        <Show when={props.plan.truncated}>
          {/* 这一条比搜索那边的截断严重得多：搜索截断只是少看了一些结果，
              替换截断意味着**仓库停在「换了一半」的状态**，而那半个状态没法撤销 */}
          <p class="modal-body">
            上一轮撞到了结果条数上限，剩下的没搜。换完之后仓库只换了一半，把搜索词写窄一点再换一遍。
          </p>
        </Show>

        <p class="modal-warn">这一步直接改写磁盘上的文件，Vela 没有跨文件撤销；要退回去只能靠 git。</p>

        <div class="modal-actions">
          {/* 「替换」在左边、刻意不给 `.primary`：右边那一个是默认焦点，
              与 DiscardDialog「安全动作在最右」的排法一致 */}
          <button onClick={() => props.onApply()}>{props.plan.deleting ? '删掉' : '替换'}</button>
          <button ref={cancelButton} onClick={() => props.onCancel()}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
