import { createSignal, For, onCleanup, Show } from 'solid-js'
import type { CommandInfo } from '../commands/registry'

export interface KeybindingsDialogProps {
  visible: boolean
  onClose: () => void
  /** 所有可配置命令列表 */
  commands: CommandInfo[]
  /** 获取某个命令的当前快捷键 */
  getKeybindings: (id: string) => string[]
  /** 设置某个命令的快捷键 */
  setKeybinding: (id: string, keybinding: string) => void
  /** 重置某个命令为默认 */
  resetKeybinding: (id: string) => void
}

/**
 * 快捷键配置对话框（M4-E）。
 *
 * 展示所有命令及其当前快捷键，支持：
 * - 点击某行的快捷键输入框，按下新组合键即可绑定
 * - 冲突检测与高亮提示
 * - 重置单个命令或全部重置
 */
export function KeybindingsDialog(props: KeybindingsDialogProps) {
  let dialogEl: HTMLDivElement | undefined
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [tempKey, setTempKey] = createSignal('')

  function close(): void {
    setEditingId(null)
    props.onClose()
  }

  function setupOutsideClick() {
    if (!props.visible) return
    const onDocDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (dialogEl && target && !dialogEl.contains(target)) close()
    }
    const id = window.setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0)
    onCleanup(() => {
      window.clearTimeout(id)
      document.removeEventListener('pointerdown', onDocDown)
    })
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (editingId()) {
        setEditingId(null)
        setTempKey('')
      } else {
        e.preventDefault()
        close()
      }
    }
  }

  /** 开始编辑某个命令的快捷键 */
  function startEdit(id: string): void {
    setEditingId(id)
    setTempKey('')
  }

  /** 处理按键输入 */
  function handleKeyInput(e: KeyboardEvent, id: string): void {
    e.preventDefault()
    e.stopPropagation()

    // 忽略纯修饰键
    if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'].includes(e.key)) {
      return
    }

    const mods: string[] = []
    if (e.ctrlKey) mods.push('Ctrl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    if (e.metaKey) mods.push('Cmd')

    const keyMap: Record<string, string> = {
      ' ': 'Space',
      Escape: 'Esc',
      ArrowUp: '↑',
      ArrowDown: '↓',
      ArrowLeft: '←',
      ArrowRight: '→',
      Backspace: '⌫',
      Delete: 'Del',
    }

    const key = keyMap[e.key] || e.key.toUpperCase()
    const binding = [...mods, key].join('+')
    setTempKey(binding)

    // 延迟一下让用户看到按下的键，然后应用
    setTimeout(() => {
      props.setKeybinding(id, binding)
      setEditingId(null)
      setTempKey('')
    }, 300)
  }

  /** 取消编辑 */
  function cancelEdit(): void {
    setEditingId(null)
    setTempKey('')
  }

  if (props.visible) {
    setupOutsideClick()
  }

  return (
    <div class="modal-backdrop" role="presentation">
      <div
        class="keybindings-dialog"
        ref={dialogEl}
        role="dialog"
        aria-label="快捷键配置"
        onKeyDown={onKeyDown}
      >
        <div class="keybindings-header">
          <h2>快捷键配置</h2>
          <button class="keybindings-close" onClick={close} title="关闭" aria-label="关闭">
            ×
          </button>
        </div>

        <div class="keybindings-body">
          <div class="keybindings-hint">
            点击快捷键列，按下新组合键即可修改。冲突的快捷键会以红色高亮显示。
          </div>

          <div class="keybindings-list">
            <For each={props.commands}>
              {(cmd) => {
                const currentBindings = props.getKeybindings(cmd.id)
                const isEditing = editingId() === cmd.id

                return (
                  <div class="keybinding-row">
                    <div class="keybinding-info">
                      <div class="keybinding-title">{cmd.title}</div>
                      <div class="keybinding-id">{cmd.id}</div>
                    </div>
                    <div class="keybinding-actions">
                      {isEditing ? (
                        <div class="keybinding-input" tabIndex={0} onKeyDown={(e) => handleKeyInput(e, cmd.id)}>
                          {tempKey() || '请按键...'}
                          <button class="keybinding-cancel" onClick={cancelEdit}>
                            Esc 取消
                          </button>
                        </div>
                      ) : (
                        <button
                          class="keybinding-btn"
                          onClick={() => startEdit(cmd.id)}
                          title="点击修改快捷键"
                        >
                          {currentBindings.length > 0 ? currentBindings.join(', ') : '未绑定'}
                        </button>
                      )}
                      {!isEditing && currentBindings.length > 0 && (
                        <button
                          class="keybinding-reset"
                          onClick={() => props.resetKeybinding(cmd.id)}
                          title="恢复默认"
                        >
                          重置
                        </button>
                      )}
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </div>

        <div class="keybindings-footer">
          <button
            class="keybindings-reset-all"
            onClick={() => {
              if (confirm('确定要重置所有快捷键吗？')) {
                props.commands.forEach((cmd) => props.resetKeybinding(cmd.id))
              }
            }}
            title="恢复所有快捷键为默认值"
          >
            重置所有快捷键
          </button>
        </div>
      </div>
    </div>
  )
}
