// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampSidebarWidth, SidebarResize, SIDEBAR_MIN_WIDTH } from './SidebarResize'

/**
 * 侧边栏宽度把手的测试。
 *
 * 只钉三件事：**夹取的上下限**、**拖拽的位移算术**、**监听的生命周期**（松手就摘、
 * 拖到一半卸载也摘）。把手画出来的那条线与分屏分隔线逐像素相同这件事是 CSS 的账，
 * 这里钉不住——jsdom 不算布局。
 *
 * ⚠️ jsdom 的 `window.innerWidth` 是 1024，所以上限在这组用例里恒为 512。
 * 派发的是 `MouseEvent` 而不是 `PointerEvent`：jsdom 里两者都没有布局含义，
 * 组件只读 `clientX` 与 `preventDefault`，而 `PointerEvent` 构造器在 jsdom 里不一定有
 */

let container: HTMLDivElement
/** 「夹取」那组是纯函数用例，不挂载组件，所以这里允许是 undefined */
let dispose: (() => void) | undefined
/** `onWidth` 收到的宽度，按顺序 */
let widths: number[]

function mount(width: number) {
  widths = []
  dispose = render(() => <SidebarResize width={() => width} onWidth={(w) => widths.push(w)} />, container)
}

function handle(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.sidebar-resize')
  if (!el) throw new Error('找不到 .sidebar-resize（把手没渲染出来）')
  return el
}

function down(x: number): MouseEvent {
  const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x })
  handle().dispatchEvent(e)
  return e
}

function move(x: number) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x }))
}

function up() {
  window.dispatchEvent(new MouseEvent('pointerup'))
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

describe('夹取', () => {
  it('上下限之间原样通过', () => {
    expect(clampSidebarWidth(220)).toBe(220)
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(512)).toBe(512)
  })

  it('往下夹到下限：再窄头部按钮开始被裁，但不会溢到正文区上', () => {
    expect(clampSidebarWidth(1)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(-500)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('往上夹到窗口的一半（jsdom 里 innerWidth = 1024）', () => {
    expect(clampSidebarWidth(513)).toBe(512)
    expect(clampSidebarWidth(99999)).toBe(512)
  })
})

describe('拖拽', () => {
  it('按下时的宽度加上位移，就是回写的宽度', () => {
    mount(220)
    const e = down(300)
    // 不拦的话拖拽会起浏览器的文本选择，一路选中标签条上的字
    expect(e.defaultPrevented).toBe(true)

    move(350)
    move(340)

    expect(widths).toEqual([270, 260])
  })

  it('往左拖过头停在下限，往右拖过头停在窗口一半', () => {
    mount(220)
    down(300)

    move(-2000)
    move(4000)

    expect(widths).toEqual([SIDEBAR_MIN_WIDTH, 512])
  })

  it('位移从按下那一拍算，不是从上一次 move 累加', () => {
    mount(400)
    down(100)
    move(110)
    move(90)
    expect(widths).toEqual([410, 390])
  })

  it('松手之后再动指针不再回写', () => {
    mount(220)
    down(300)
    move(310)
    up()

    move(400)

    expect(widths).toEqual([230])
  })

  it('拖到一半组件被卸载（Mod+B 收起侧边栏），window 上的监听跟着摘掉', () => {
    mount(220)
    down(300)

    dispose?.()
    // afterEach 还会再 dispose 一次，而 Solid 的 dispose 不保证可以重入
    dispose = undefined
    move(400)

    expect(widths).toEqual([])
  })
})
