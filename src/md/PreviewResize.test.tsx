// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampPreviewWidth, EDITOR_MIN_WIDTH, PREVIEW_MIN_WIDTH, PreviewResize } from './PreviewResize'

/**
 * 编辑区/预览分隔线的测试。
 *
 * 只钉三件事：**夹取的上下限**、**拖拽的位移算术**（含「起点优先量 DOM」这一条）、
 * **监听的生命周期**（松手就摘、拖到一半卸载也摘）。线画得对不对、抓起来顺不顺手是
 * CSS 与真机的账——jsdom 不算布局。
 *
 * ⚠️ 派发的是 `MouseEvent` 而不是 `PointerEvent`：组件只读 `clientX` 与
 * `preventDefault`，而 `PointerEvent` 构造器在 jsdom 里不一定有（与 SidebarResize 同一条）
 */

let container: HTMLDivElement
/** 「夹取」那组是纯函数用例，不挂载组件，所以这里允许是 undefined */
let dispose: (() => void) | undefined
/** `onWidth` 收到的值，按顺序。`null` = 回到等分 */
let widths: (number | null)[]

function mount(width: number | null, total = 1000) {
  widths = []
  dispose = render(
    () => <PreviewResize width={() => width} total={() => total} onWidth={(w) => widths.push(w)} />,
    container,
  )
}

function handle(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.md-preview-resize')
  if (!el) throw new Error('找不到 .md-preview-resize（把手没渲染出来）')
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

function key(name: string, init: KeyboardEventInit = {}) {
  handle().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
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
    expect(clampPreviewWidth(400, 1000)).toBe(400)
    expect(clampPreviewWidth(PREVIEW_MIN_WIDTH, 1000)).toBe(PREVIEW_MIN_WIDTH)
    expect(clampPreviewWidth(1000 - EDITOR_MIN_WIDTH, 1000)).toBe(1000 - EDITOR_MIN_WIDTH)
  })

  it('往下夹到预览下限', () => {
    expect(clampPreviewWidth(1, 1000)).toBe(PREVIEW_MIN_WIDTH)
    expect(clampPreviewWidth(-500, 1000)).toBe(PREVIEW_MIN_WIDTH)
  })

  it('往上夹到「总宽 - 编辑区下限」，编辑区不会被挤到 320 以下', () => {
    expect(clampPreviewWidth(1000 - EDITOR_MIN_WIDTH + 1, 1000)).toBe(1000 - EDITOR_MIN_WIDTH)
    expect(clampPreviewWidth(99999, 1000)).toBe(1000 - EDITOR_MIN_WIDTH)
  })

  it('总宽连两个下限都放不下时各占一半：没有正确答案，平分是唯一说得过去的', () => {
    // 400 < 240 + 320
    expect(clampPreviewWidth(1, 400)).toBe(200)
    expect(clampPreviewWidth(399, 400)).toBe(200)
    expect(clampPreviewWidth(100, 500)).toBe(250)
    // 刚好放得下的那一侧不退化
    expect(clampPreviewWidth(1, PREVIEW_MIN_WIDTH + EDITOR_MIN_WIDTH)).toBe(PREVIEW_MIN_WIDTH)
  })

  it('返回值取整：拖动起点不带半个像素的抖动', () => {
    expect(clampPreviewWidth(300.4, 1000)).toBe(300)
    expect(clampPreviewWidth(300.6, 1000)).toBe(301)
  })
})

describe('拖拽', () => {
  it('按下时的宽度加上位移，就是回写的宽度；往左拖 = 预览变宽', () => {
    mount(400)
    const e = down(500)
    // 不拦的话拖拽会起浏览器的文本选择，一路选中预览里的字
    expect(e.defaultPrevented).toBe(true)

    move(450)
    move(430)

    expect(widths).toEqual([450, 470])
  })

  it('往左拖过头停在「总宽 - 编辑区下限」，往右拖过头停在预览下限', () => {
    mount(400)
    down(500)

    move(-2000)
    move(4000)

    expect(widths).toEqual([1000 - EDITOR_MIN_WIDTH, PREVIEW_MIN_WIDTH])
  })

  it('位移从按下那一拍算，不是从上一次 move 累加', () => {
    mount(400)
    down(100)
    move(110)
    move(90)
    expect(widths).toEqual([390, 410])
  })

  it('还没拖过（等分）时从当前那一半起拖', () => {
    mount(null, 1000)
    down(500)
    move(400)
    expect(widths).toEqual([600])
  })

  it('按下时优先量画出来的宽度：窗口缩过之后不会从存着的旧值跳一下', () => {
    // 总宽放宽到 2000：把夹取的上限移开，让这两种起点算出来的值真的不同
    mount(900, 2000)
    // 假一个预览栏兄弟节点：窗口缩过之后它只有 600，而信号里还存着 900
    const drawn = document.createElement('div')
    drawn.getBoundingClientRect = () =>
      ({ width: 600, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }) as DOMRect
    container.appendChild(drawn)

    down(500)
    move(400)

    // 600 + 100，而不是 900 + 100
    expect(widths).toEqual([700])
  })

  it('松手之后再动指针不再回写', () => {
    mount(400)
    down(500)
    move(490)
    up()

    move(300)

    expect(widths).toEqual([410])
  })

  it('拖到一半组件被卸载（预览被关掉），window 上的监听跟着摘掉', () => {
    mount(400)
    down(500)

    dispose?.()
    // afterEach 还会再 dispose 一次，而 Solid 的 dispose 不保证可以重入
    dispose = undefined
    move(300)

    expect(widths).toEqual([])
  })
})

describe('键盘与双击', () => {
  it('← / → 每次挪 24px，Shift 加速到 4 倍', () => {
    mount(400)
    key('ArrowLeft')
    key('ArrowRight', { shiftKey: true })
    expect(widths).toEqual([424, 304])
  })

  it('Enter / Home 回到等分（null 让 CSS 重新接管）', () => {
    mount(400)
    key('Enter')
    key('Home')
    expect(widths).toEqual([null, null])
  })

  it('双击也回到等分：拖坏了很难瞄准正中间', () => {
    mount(400)
    handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(widths).toEqual([null])
  })
})
