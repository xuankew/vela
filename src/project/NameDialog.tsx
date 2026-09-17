import { createSignal, onMount, Show } from 'solid-js'

export interface NameDialogProps {
  /** 一句话说清「在改什么」，例如 `在「src」里新建文件` */
  title: string
  /** 输入框里预填的内容。新建时是空字符串，改名时是当前名字 */
  initialValue: string
  /**
   * 预填时只选中主文件名（不含扩展名）。
   *
   * 改名 `README.md` 时用户几乎总是要换掉 `README` 而留下 `.md`：全选的话他得先删掉
   * 扩展名再打回来，或者打完之后发现文件变成了 `新名字.md.md`。这是所有编辑器的默认行为。
   */
  selectBasename?: boolean
  submitLabel: string
  /**
   * 返回 `null` = 成功（由调用方关掉对话框），返回一句话 = **失败，就地显示并留着对话框**。
   *
   * ⚠️ 失败时不能关：关掉之后那句话会落到提示条上，而用户得重新右键、重新点「重命名…」、
   * 重新打一遍名字才知道自己错在哪。留在原地，输入框里还是他刚打的那个名字，改两个字再按回车。
   */
  onSubmit: (name: string) => Promise<string | null>
  onCancel: () => void
}

/**
 * 「起个名字」的输入框：新建文件、新建文件夹、重命名三个动作共用一个。
 *
 * 三者只在标题、预填值与提交之后调哪个 store 方法上不同，形状完全一样——
 * 分成三个组件的话，「回车提交 / Escape 取消 / 失败留在原地」这三条要各写一遍，
 * 而漂移的失败方式是其中一个对话框回车没反应，用户以为键盘坏了。
 *
 * 与 `DiscardDialog` 同一套外观（`.modal-backdrop` / `.modal` / `.modal-actions`），
 * 也同一条理由不用原生对话框：`@tauri-apps/plugin-dialog` 没有「带输入框」的那一种。
 */
export function NameDialog(props: NameDialogProps) {
  let input: HTMLInputElement | undefined

  const [name, setName] = createSignal(props.initialValue)
  /** 提交在飞的时候不许再提交一次：双击回车会变成两次 `create_entry`，第二次撞上 already_exists */
  const [busy, setBusy] = createSignal(false)
  /** 上一次失败的这句话。成功时对话框已经被卸掉了，所以它只在失败时非空 */
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => {
    input?.focus()
    // 主文件名选上、扩展名留着。`dotAt > 0` 排除 `.gitignore` 这种「整段都是扩展名」的名字：
    // 那种文件全选才是对的，只选前半段会得到一个空选区
    const dotAt = props.initialValue.lastIndexOf('.')
    if (props.selectBasename && dotAt > 0) input?.setSelectionRange(0, dotAt)
    else input?.select()
  })

  /** 名字只有一个空格也不算名字。这里挡一道，是为了让「确定」按钮当场灰掉——
   *  不挡的话要点下去、走一次 IPC、再等 Rust 回一句 bad_name，慢得多也绕得多 */
  const canSubmit = () => !busy() && name().trim().length > 0

  async function submit() {
    if (!canSubmit()) return
    setBusy(true)
    // 名字原样送出去，不 trim：`"draft "` 是一个合法（虽然讨厌）的文件名，
    // 替用户去掉那个空格等于悄悄建了一个他没要求的名字。合法性由 Rust 侧判
    const outcome = await props.onSubmit(name())
    setBusy(false)
    if (outcome === null) return
    setError(outcome)
    // 全选，让他直接打新的名字覆盖掉——比把光标放到末尾更省一次操作
    input?.select()
    input?.focus()
  }

  return (
    <div
      class="modal-backdrop"
      onKeyDown={(e) => {
        // 与 DiscardDialog 同一条规矩：Escape 只在这个对话框自己的子树里生效，不进命令中心
        if (e.key === 'Escape') {
          e.stopPropagation()
          props.onCancel()
        }
      }}
    >
      <div class="modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <p class="modal-title">{props.title}</p>
        <input
          class="modal-input"
          ref={input}
          value={name()}
          placeholder="名字"
          aria-invalid={error() !== null}
          onInput={(e) => {
            setName(e.currentTarget.value)
            // 一边打字一边把上一句失败清掉：留着它的话用户会以为改完之后还是不行
            if (error() !== null) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <Show when={error()}>
          {(text) => (
            <p class="modal-error" role="alert">
              {text()}
            </p>
          )}
        </Show>
        <div class="modal-actions">
          <button onClick={() => props.onCancel()}>取消</button>
          <button class="primary" disabled={!canSubmit()} onClick={() => void submit()}>
            {props.submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
