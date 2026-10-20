// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TreeMenu, type ContextMenuItem } from './TreeMenu'

/**
 * 上下文菜单那个外壳。三个宿主（文件树、标签条、编辑器正文）共用它，而共用的正好是
 * 「改坏了不报错、只是菜单赖在屏幕上或飘走」的那部分：贴边 clamp、四条关闭路径、
 * 分隔线、灰项、以及编辑器那一份独有的 `keepFocus`。
 *
 * ⚠️ 位置只钉得住「不超出窗口」这半个：jsdom 里 `getBoundingClientRect()` 全是 0，
 * 「减去菜单自己的宽高」那半个要在真窗口里看（理由写在组件的 `clamp` 上）。
 */

type Action = 'a' | 'b' | 'c'

let container: HTMLDivElement
let dispose: (() => void) | undefined
let picked: Action[]
let closes: number

function mount(items: ContextMenuItem<Action>[], extra: { x?: number; y?: number; keepFocus?: boolean } = {}) {
  picked = []
  closes = 0
  dispose = render(
    () => (
      <TreeMenu<Action>
        x={extra.x ?? 100}
        y={extra.y ?? 100}
        items={items}
        onPick={(action) => picked.push(action)}
        onClose={() => closes++}
        keepFocus={extra.keepFocus}
      />
    ),
    container,
  )
}

function menu(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.tree-menu')
  if (!el) throw new Error('找不到 .tree-menu（菜单没渲染出来）')
  return el
}

function itemButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.tree-menu-item')]
}

/** 按标签找那一项（用例里说的是人话，不是下标） */
function item(label: string): HTMLButtonElement {
  const found = itemButtons().find((b) => b.textContent === label)
  if (!found) throw new Error(`菜单里没有「${label}」这一项`)
  return found
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

describe('画出来的形状', () => {
  it('按给定顺序画每一项，选了就把动作交回宿主', () => {
    mount([
      { action: 'a', label: '第一项' },
      { action: 'b', label: '第二项' },
    ])
    expect(itemButtons().map((b) => b.textContent)).toEqual(['第一项', '第二项'])

    item('第二项').click()
    expect(picked).toEqual(['b'])
    // 「选了一项」是四条关闭路径之一
    expect(closes).toBe(1)
  })

  it('separator 在那一项**上面**画一条分隔线', () => {
    mount([
      { action: 'a', label: '第一项' },
      { action: 'b', label: '第二项', separator: true },
    ])
    const seps = [...container.querySelectorAll('.tree-menu-sep')]
    expect(seps).toHaveLength(1)
    // 分隔线是第二项的前一个兄弟，不是后一个
    expect(seps[0]!.nextElementSibling?.textContent).toBe('第二项')
  })

  it('disabled 的那一项按不动：点下去既不动作也不关菜单', () => {
    mount([
      { action: 'a', label: '灰的', disabled: true },
      { action: 'b', label: '亮的' },
    ])
    expect(item('灰的').disabled).toBe(true)
    expect(item('亮的').disabled).toBe(false)

    item('灰的').click()
    expect(picked).toEqual([])
    expect(closes).toBe(0)

    item('亮的').click()
    expect(picked).toEqual(['b'])
  })

  it('坐标超出窗口时推回视口里', () => {
    mount([{ action: 'a', label: '第一项' }], { x: 99999, y: 99999 })
    const style = menu().style
    expect(Number.parseFloat(style.left)).toBeLessThanOrEqual(window.innerWidth)
    expect(Number.parseFloat(style.top)).toBeLessThanOrEqual(window.innerHeight)
    expect(Number.parseFloat(style.left)).toBeGreaterThanOrEqual(0)
  })
})

describe('四条关闭路径', () => {
  it('点菜单外面（捕获阶段的 mousedown）', () => {
    mount([{ action: 'a', label: '第一项' }])
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(closes).toBe(1)
  })

  it('菜单**里面**的 mousedown 不关：否则那一次 click 永远等不到', () => {
    mount([{ action: 'a', label: '第一项' }])
    item('第一项').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(closes).toBe(0)
  })

  it('Escape，并且拦住不让它继续往下走', () => {
    mount([{ action: 'a', label: '第一项' }])
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(e)
    expect(closes).toBe(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('宿主滚动——哪怕滚的是文档里某个不冒泡的后代（CM6 的 .cm-scroller 正是这一种）', () => {
    mount([{ action: 'a', label: '第一项' }])
    const deep = document.createElement('div')
    deep.append(document.createElement('div'))
    container.append(deep)

    // scroll 不冒泡，但捕获阶段的监听器在 document 上照样看得到后代元素的滚动
    deep.firstElementChild!.dispatchEvent(new Event('scroll'))
    expect(closes).toBe(1)
  })
})

describe('keepFocus', () => {
  it('开着的时候按下菜单项不把焦点抢过来（preventDefault）', () => {
    mount([{ action: 'a', label: '第一项' }], { keepFocus: true })
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    item('第一项').dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('默认关着：原来那两个宿主的行为一个字都没变', () => {
    mount([{ action: 'a', label: '第一项' }])
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    item('第一项').dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('监听的生命周期', () => {
  it('卸载之后 Escape、滚动与外面的按下都不再触发 onClose', () => {
    mount([{ action: 'a', label: '第一项' }])
    dispose!()
    dispose = undefined

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new Event('scroll'))
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(closes).toBe(0)
  })
})
