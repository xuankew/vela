import { createSignal, For, onCleanup, Show } from 'solid-js'
import { formatKeybinding, keyFromEvent, type Modifier, type Platform } from '../commands/keybinding'
import type { CommandInfo } from '../commands/registry'

export interface KeybindingsDialogProps {
  visible: boolean
  onClose: () => void
  /** 所有可配置命令列表 */
  commands: CommandInfo[]
  platform: Platform
  /** 设置某个命令的快捷键（声明串）。声明不合法返回 false，该行留在录制态 */
  setKeybinding: (id: string, keybinding: string) => boolean
  /** 重置某个命令为默认 */
  resetKeybinding: (id: string) => void
}

/** 录制时拼声明串用的修饰键名字，全是 parseKeybinding 认的别名 */
const MOD_TOKENS: Record<Modifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Cmd' }

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

  /**
   * 处理按键输入。录下来的是**声明串**（`Cmd+K` / `Ctrl+Alt+Up` 这一档），
   * 主键取 `keyFromEvent` 的规范化值——保证 `parseKeybinding` 吃得回去，
   * 展示串另用 `formatKeybinding` 现算，两边不会漂移。
   */
  function handleKeyInput(e: KeyboardEvent, id: string): void {
    e.preventDefault()
    e.stopPropagation()

    // Esc 是取消录制，不是把 Esc 绑上去
    if (e.key === 'Escape') {
      cancelEdit()
      return
    }

    // 纯修饰键（还没按主键）与输入法接管中的键返回 null，继续等
    const key = keyFromEvent(e)
    if (key === null) return

    const mods: Modifier[] = []
    if (e.ctrlKey) mods.push('ctrl')
    if (e.altKey) mods.push('alt')
    if (e.shiftKey) mods.push('shift')
    if (e.metaKey) mods.push('meta')

    const decl = [...mods.map((m) => MOD_TOKENS[m]), key].join('+')
    setTempKey(formatKeybinding({ mods, key, source: decl }, props.platform))

    // 延迟一下让用户看到按下的键，然后应用
    setTimeout(() => {
      const ok = props.setKeybinding(id, decl)
      setTempKey('')
      if (ok) setEditingId(null)
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
      <div class="keybindings-dialog" ref={dialogEl} role="dialog" aria-label="快捷键配置" onKeyDown={onKeyDown}>
        <div class="keybindings-header">
          <h2>快捷键配置</h2>
          <button class="keybindings-close" onClick={close} title="关闭" aria-label="关闭">
            ×
          </button>
        </div>

        <div class="keybindings-body">
          <div class="keybindings-hint">点击快捷键列，按下新组合键即可修改。冲突的快捷键会以红色高亮显示。</div>

          <div class="keybindings-list">
            <For each={props.commands}>
              {(cmd) => (
                <div class="keybinding-row">
                  <div class="keybinding-info">
                    <div class="keybinding-title">{cmd.title}</div>
                    <div class="keybinding-id">{cmd.id}</div>
                  </div>
                  <div class="keybinding-actions">
                    {/*
                      录制态与否必须走响应式分支（Show 的 when 读 editingId）。
                      写成 For 回调里的普通 const 只会在行创建时求值一次，
                      点「修改」改了信号行也不重渲染——就是「点了没反应」那个 bug。
                    */}
                    <Show
                      when={editingId() === cmd.id}
                      fallback={
                        <>
                          <button class="keybinding-btn" onClick={() => startEdit(cmd.id)} title="点击修改快捷键">
                            {cmd.keybindings.length > 0 ? cmd.keybindings.join(', ') : '未绑定'}
                          </button>
                          {cmd.keybindings.length > 0 && (
                            <button
                              class="keybinding-reset"
                              onClick={() => props.resetKeybinding(cmd.id)}
                              title="恢复默认"
                            >
                              重置
                            </button>
                          )}
                        </>
                      }
                    >
                      <div
                        class="keybinding-input"
                        tabIndex={0}
                        // ref 回调跑在元素创建时、插入文档之前，那时 focus() 是空操作——
                        // 焦点留在 body 上，第一次按键就丢了（「第一次输入没反应」）。
                        // 延一个宏任务，等插入落地再 focus。
                        ref={(el) => window.setTimeout(() => el.focus(), 0)}
                        onKeyDown={(e) => handleKeyInput(e, cmd.id)}
                      >
                        {tempKey() || '请按键...'}
                        <button class="keybinding-cancel" onClick={cancelEdit}>
                          Esc 取消
                        </button>
                      </div>
                    </Show>
                  </div>
                </div>
              )}
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
