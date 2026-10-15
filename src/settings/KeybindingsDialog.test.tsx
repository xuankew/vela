// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * 快捷键配置对话框的组件测试（M4-E 接线回归）。
 *
 * 钉两件事：**点「修改」后录制框必须立刻拿到焦点**（否则第一次按键落在 body 上，
 * 就是「第一次输入没反应」那个 bug）、**第一次按键就要录到并应用**。
 * 展示串/声明串的分流在 `handleKeyInput` 里，这里用 setKeybinding 收到的声明串钉住。
 */

import type { CommandInfo } from '../commands/registry'
import { KeybindingsDialog, type KeybindingsDialogProps } from './KeybindingsDialog'

const COMMANDS: CommandInfo[] = [
  { id: 'editor.save', title: '保存', category: '编辑器', enabled: true, keybindings: ['⌘S'] },
  { id: 'file.open', title: '打开文件', category: '文件', enabled: true, keybindings: [] },
]

let dispose: () => void
let container: HTMLDivElement
let setKeybinding: Mock<(id: string, kb: string) => boolean>
let resetKeybinding: Mock<(id: string) => void>

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  setKeybinding = vi.fn((_id: string, _kb: string) => true)
  resetKeybinding = vi.fn((_id: string) => {})
  const props: KeybindingsDialogProps = {
    visible: true,
    onClose: vi.fn(),
    commands: COMMANDS,
    platform: 'macos',
    setKeybinding,
    resetKeybinding,
  }
  dispose = render(() => <KeybindingsDialog {...props} />, container)
}

const flush = (ms = 350): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** 往当前焦点元素上按键——和真用户一样，不指定目标 */
function pressKey(init: KeyboardEventInit): void {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

const editButton = (id: string): HTMLButtonElement => {
  const rows = [...container.querySelectorAll<HTMLElement>('.keybinding-row')]
  const row = rows.find((r) => r.querySelector('.keybinding-id')?.textContent === id)!
  return row.querySelector<HTMLButtonElement>('.keybinding-btn')!
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  dispose()
})

describe('录制交互', () => {
  it('点「修改」后录制框立刻拿到焦点，第一次按键就落在录制框里', async () => {
    mount()
    click(editButton('editor.save'))
    await flush(0)
    const input = container.querySelector<HTMLElement>('.keybinding-input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('第一次按键就录到并应用，声明串能被 parseKeybinding 吃回去', async () => {
    mount()
    click(editButton('editor.save'))
    await flush(0)
    pressKey({ key: 'k', code: 'KeyK', metaKey: true })
    await flush()
    expect(setKeybinding).toHaveBeenCalledTimes(1)
    expect(setKeybinding).toHaveBeenCalledWith('editor.save', 'Cmd+k')
  })

  it('录制态按 Esc 是取消，不会把 Esc 绑上去', async () => {
    mount()
    click(editButton('file.open'))
    await flush(0)
    pressKey({ key: 'Escape', code: 'Escape' })
    await flush()
    expect(setKeybinding).not.toHaveBeenCalled()
    expect(container.querySelector('.keybinding-input')).toBeNull()
  })

  it('setKeybinding 拒收时留在录制态，用户可以重试', async () => {
    mount()
    setKeybinding.mockReturnValue(false)
    click(editButton('file.open'))
    await flush(0)
    pressKey({ key: 'k', code: 'KeyK' })
    await flush()
    expect(container.querySelector('.keybinding-input')).not.toBeNull()
  })
})
