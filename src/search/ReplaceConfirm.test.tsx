// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 「替换全部」确认单的测试。
 *
 * 清单里的数字怎么算出来的在 `./store.test.ts` 的「确认单」那一组里钉过了，这里只测
 * **说出来的话对不对、点下去调到哪儿、默认焦点落在哪个按钮上**。
 *
 * ⚠️ 措辞是这个组件唯一真正的功能。这一步是整个 Vela 里唯一不可撤销的批量写盘，
 * 而用户批准与否全靠这几句话——数字对了但话说歪了（例如把「删掉命中的那一段」
 * 说成「删掉 12 行」），后果是用户以为要丢掉 12 行代码然后点了「取消」，
 * 或者更糟：以为只是改几个字然后点了「替换」。所以下面一半的用例断言的是文案。
 */

import { ReplaceConfirm } from './ReplaceConfirm'
import type { ConfirmApply } from './store'

function plan(overrides: Partial<ConfirmApply> = {}): ConfirmApply {
  return { files: 3, lines: 7, skipped: 0, deleting: false, truncated: false, ...overrides }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let container: HTMLDivElement
let dispose: (() => void) | undefined
let applied: number
let cancelled: number

function mount(p: ConfirmApply = plan()): void {
  applied = 0
  cancelled = 0
  dispose = render(
    () => (
      <ReplaceConfirm
        plan={p}
        onApply={() => {
          applied += 1
        }}
        onCancel={() => {
          cancelled += 1
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

/** 正文那几段，按渲染顺序。「跳过」与「撞上限」两段是 `<Show>`，不满足条件时不存在 */
function bodies(): string[] {
  return [...container.querySelectorAll('.modal-body')].map((el) => el.textContent ?? '')
}

function warn(): string {
  return container.querySelector('.modal-warn')?.textContent ?? ''
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')]
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
  it('标题与正文报出文件数与行数，而且说清一行里可能有多处', () => {
    mount(plan({ files: 3, lines: 7 }))

    expect(title()).toBe('替换 3 个文件里的 7 行？')
    expect(bodies()[0]).toContain('3 个文件、7 行')
    // ⚠️ 「一行里可能有多处」不能省：`lines` 数的是命中**行**，而 Rust 侧真正替换的
    // 是**处**（`ReplaceSummary.replacements`）。不说的话落盘之后总账里的数字比这里大，
    // 用户会以为多改了东西
    expect(bodies()[0]).toContain('一行里可能有多处')
  })

  it('⚠️ 替换内容是空的时整套措辞换成「删掉」，而且必须说「行本身留着」', () => {
    mount(plan({ files: 2, lines: 5, deleting: true }))

    expect(title()).toBe('删掉 5 行上的命中内容？')
    expect(bodies()[0]).toContain('替换内容是空的')
    // 「删掉 5 行」的字面意思是整行消失。这个操作删的只是命中的那一段，
    // 不把这点说出来，用户要么以为要丢掉 5 行代码而点取消，要么根本没读懂就点了删掉
    expect(bodies()[0]).toContain('行本身留着')
    expect(buttons().map((b) => b.textContent)).toContain('删掉')
  })

  it('skipped 非零时单独一段说清是哪一类文件、下一步怎么办', () => {
    mount(plan({ skipped: 2 }))
    expect(bodies()).toHaveLength(2)
    expect(bodies()[1]).toContain('2 个文件正开着且有未保存的改动')
    expect(bodies()[1]).toContain('保存它们之后再换一遍')
  })

  it('skipped 为 0 时那一段不存在——「另有 0 个文件被跳过」是一句废话', () => {
    mount(plan({ skipped: 0 }))
    expect(bodies()).toHaveLength(1)
  })

  it('⚠️ 撞到上限时说的是「仓库只换了一半」，不是「结果不全」', () => {
    mount(plan({ truncated: true }))
    expect(bodies()).toHaveLength(2)
    // 搜索那边的截断只是少看了一些结果；替换这边的截断意味着磁盘上停在一个
    // 「换了一半」的状态，而那半个状态没法撤销。轻描淡写成「结果不全」是不够的
    expect(bodies()[1]).toContain('仓库只换了一半')
    expect(bodies()[1]).toContain('把搜索词写窄一点')
  })

  it('skipped 与 truncated 同时成立时两段都在，各占一行', () => {
    mount(plan({ skipped: 1, truncated: true }))
    expect(bodies()).toHaveLength(3)
    expect(bodies()[1]).toContain('正开着')
    expect(bodies()[2]).toContain('换了一半')
  })

  it('「没法撤销」那一句永远在，与清单长什么样无关', () => {
    mount(plan())
    expect(warn()).toContain('直接改写磁盘上的文件')
    expect(warn()).toContain('没有跨文件撤销')
    // 给出退路，不然这句话只剩吓人：这个项目面向开发者，git 就是那个退路
    expect(warn()).toContain('git')
  })
})

describe('按钮与焦点', () => {
  it('⚠️ 默认焦点落在「取消」上：什么都不看直接按回车不该是改磁盘', async () => {
    mount()
    await flush()
    expect(document.activeElement).toBe(button('取消'))
  })

  it('「替换」在左边、而且不给 .primary：破坏性靠文字说，不靠一个大彩按钮', () => {
    mount()
    // 与 DiscardDialog「安全动作在最右」的排法一致
    expect(buttons().map((b) => b.textContent)).toEqual(['替换', '取消'])
    expect(button('替换').classList.contains('primary')).toBe(false)
    expect(button('取消').classList.contains('primary')).toBe(false)
  })

  it('点「替换」只调 onApply，点「取消」只调 onCancel', async () => {
    mount()

    button('替换').click()
    await flush()
    expect(applied).toBe(1)
    expect(cancelled).toBe(0)

    button('取消').click()
    await flush()
    expect(cancelled).toBe(1)
    expect(applied).toBe(1)
  })

  it('删除那一版的按钮也叫「删掉」，点它同样是 onApply', async () => {
    mount(plan({ deleting: true }))

    button('删掉').click()
    await flush()
    expect(applied).toBe(1)
  })

  it('按 Escape 等于取消', async () => {
    mount()
    key('Escape')
    await flush()

    expect(cancelled).toBe(1)
    expect(applied).toBe(0)
  })

  it('别的键什么都不做', async () => {
    mount()
    key('Enter')
    await flush()

    // ⚠️ 这里刻意不自己处理 Enter：焦点在哪个按钮上，回车就是那个按钮
    // （浏览器的默认行为）。自己再拦一道的话「回车 = 取消」这条就不成立了
    expect(cancelled).toBe(0)
    expect(applied).toBe(0)
  })
})

describe('无障碍', () => {
  it('是 alertdialog，aria-label 与标题同一句话', () => {
    mount(plan({ files: 4, lines: 9 }))
    expect(modal().getAttribute('role')).toBe('alertdialog')
    expect(modal().getAttribute('aria-modal')).toBe('true')
    expect(modal().getAttribute('aria-label')).toBe(title())
  })

  it('删除那一版的 aria-label 也跟着换', () => {
    mount(plan({ lines: 5, deleting: true }))
    expect(modal().getAttribute('aria-label')).toBe('删掉 5 行上的命中内容？')
  })
})
