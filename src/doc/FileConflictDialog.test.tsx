// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 文件冲突裁决框的测试。
 *
 * 「什么时候该弹」在 `./fileWatch.test.ts` 里钉过了（干净的重载、脏的排队、删掉的一律排队），
 * 这里只测**说出来的话对不对、点下去调到哪儿、默认焦点落在哪个按钮上**。
 *
 * ⚠️ 措辞是这个组件唯一真正的功能。它弹出来的那一刻，用户手里的东西与磁盘上的东西
 * 已经不一致了，而三个按钮里有一个会把其中一份永久扔掉——Vela 没有跨文件撤销，
 * 「另存为」之外也没有第二条退路。话说歪了的后果不是难看，是丢数据。
 */

import type { ConflictChoice, FileConflict } from './fileWatch'
import { FileConflictDialog } from './FileConflictDialog'

function conflict(overrides: Partial<FileConflict> = {}): FileConflict {
  return { tabId: 7, name: 'a.txt', path: '/repo/src/a.txt', kind: 'changed', ...overrides }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let container: HTMLDivElement
let dispose: (() => void) | undefined
let choices: ConflictChoice[]

function mount(c: FileConflict = conflict(), pending = 0): void {
  choices = []
  dispose = render(
    () => (
      <FileConflictDialog
        conflict={c}
        pending={pending}
        onChoose={(choice) => {
          choices.push(choice)
        }}
      />
    ),
    container,
  )
}

function modal(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.modal')
  if (!el) throw new Error('找不到 .modal')
  return el
}

function title(): string {
  return container.querySelector('.modal-title')?.textContent ?? ''
}

/** 正文那几段，按渲染顺序。「后面还有 N 个」是 `<Show>`，队列为空时不存在 */
function bodies(): string[] {
  return [...container.querySelectorAll('.modal-body')].map((el) => el.textContent ?? '')
}

function warn(): string {
  return container.querySelector('.modal-warn')?.textContent ?? ''
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')]
}

function labels(): (string | null)[] {
  return buttons().map((b) => b.textContent)
}

function button(label: string): HTMLButtonElement {
  const el = buttons().find((b) => b.textContent === label)
  if (!el) throw new Error(`对话框里没有「${label}」这个按钮`)
  return el
}

function key(which: string): void {
  modal().dispatchEvent(new KeyboardEvent('keydown', { key: which, bubbles: true, cancelable: true }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  container.remove()
})

describe('措辞', () => {
  it('被改过：标题说清是「在 Vela 之外」，正文说清手里这份没保存过', () => {
    mount()

    expect(title()).toBe('「a.txt」在 Vela 之外被改过了')
    expect(bodies()[0]).toContain('磁盘上那一份已经不是你眼前这些内容')
    expect(bodies()[0]).toContain('没保存的改动')
    expect(warn()).toContain('扔掉')
    // 必须说「没有撤销」：这是用户判断要不要冒险覆盖的唯一依据
    expect(warn()).toContain('没有撤销')
  })

  it('⚠️ 没了：不说死「被删掉了」，因为改名与移走在 FSEvents 上长得一样', () => {
    mount(conflict({ kind: 'removed' }))

    expect(title()).toBe('「a.txt」在磁盘上已经没有了')
    expect(bodies()[0]).toContain('可能被删掉')
    expect(bodies()[0]).toContain('移走或者改了名字')
    // 「仅存的副本」是这一版的重点：盘上已经没有了，所以编辑器里这份不能随手扔
    expect(bodies()[0]).toContain('仅存的副本')
    expect(warn()).toContain('再问一次')
  })

  it('全路径单独一行：两个目录里的同名文件同时被改时，只报文件名认不出来', () => {
    mount(conflict({ name: 'a.txt', path: '/repo/src/a.txt' }))
    expect(bodies()[1]).toBe('/repo/src/a.txt')
  })

  it('队列里还有别的文件时多一行说个数，为 0 时那行不存在', () => {
    mount(conflict(), 0)
    expect(bodies()).toHaveLength(2)

    dispose?.()
    mount(conflict(), 3)
    expect(bodies()).toHaveLength(3)
    expect(bodies()[2]).toContain('后面还有 3 个文件要问')
  })
})

describe('按钮与焦点', () => {
  it('被改过的三条出路，破坏性的在左、安全的在最右', () => {
    mount()
    expect(labels()).toEqual(['用磁盘上的覆盖', '另存为…', '保留我的改动'])
  })

  it('文件没了的三条出路：「保留」在这里叫「保留标签」', () => {
    mount(conflict({ kind: 'removed' }))
    expect(labels()).toEqual(['关闭标签', '另存为…', '保留标签'])
  })

  it('⚠️ 三个按钮一个都没有 .primary：哪个对取决于用户在别的程序里做了什么', () => {
    for (const kind of ['changed', 'removed'] as const) {
      dispose?.()
      mount(conflict({ kind }))
      for (const b of buttons()) expect(b.classList.contains('primary')).toBe(false)
    }
  })

  it('⚠️ 默认焦点落在「保留」上：什么都不看直接按回车不该扔掉任何东西', async () => {
    mount()
    await flush()
    expect(document.activeElement).toBe(button('保留我的改动'))

    dispose?.()
    mount(conflict({ kind: 'removed' }))
    await flush()
    expect(document.activeElement).toBe(button('保留标签'))
  })

  it('每个按钮只调自己那一个动作', async () => {
    mount()

    button('用磁盘上的覆盖').click()
    await flush()
    expect(choices).toEqual(['overwrite'])

    button('另存为…').click()
    await flush()
    expect(choices).toEqual(['overwrite', 'saveAs'])

    button('保留我的改动').click()
    await flush()
    expect(choices).toEqual(['overwrite', 'saveAs', 'keep'])
  })

  it('「关闭标签」与「保留标签」各归各的，不会串到另一版上', async () => {
    mount(conflict({ kind: 'removed' }))

    button('关闭标签').click()
    await flush()
    expect(choices).toEqual(['closeTab'])

    button('保留标签').click()
    await flush()
    expect(choices).toEqual(['closeTab', 'keep'])
  })

  it('⚠️ Escape 是「保留」，不是「关闭标签」：文件已经没了，Esc 不该把仅存那份也带走', async () => {
    mount(conflict({ kind: 'removed' }))

    key('Escape')
    await flush()

    expect(choices).toEqual(['keep'])
  })

  it('别的键什么都不做：回车该由焦点所在的那个按钮接管', async () => {
    mount()

    key('Enter')
    await flush()

    expect(choices).toEqual([])
  })
})

describe('无障碍', () => {
  it('是 alertdialog，aria-label 与标题同一句话', () => {
    mount()
    expect(modal().getAttribute('role')).toBe('alertdialog')
    expect(modal().getAttribute('aria-modal')).toBe('true')
    expect(modal().getAttribute('aria-label')).toBe(title())
  })

  it('文件没了那一版的 aria-label 也跟着换', () => {
    mount(conflict({ kind: 'removed' }))
    expect(modal().getAttribute('aria-label')).toBe('「a.txt」在磁盘上已经没有了')
  })
})
