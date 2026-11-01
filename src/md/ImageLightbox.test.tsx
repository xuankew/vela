// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageLightbox, zoomOf } from './ImageLightbox'

/**
 * `zoomOf`（这一次点击该不该弹大图）与那张遮罩本身。
 *
 * 三条要紧的：
 *
 * 1. 🔴 **`src` 读的是属性而不是 `.src`**。后者会拿文档 base 去解析，`vela-img://…`
 *    在有些实现里会被改写成别的形状，而 Rust 那一边按原样那串校验。
 * 2. 🔴 **被链接包住的图不弹**。`[![x](a.png)](https://e.com)` 在预览里是一个链接，
 *    那一次点击归它。
 * 3. ⚠️ **焦点是自己进来的**：点一张图不会让任何东西可聚焦，所以 `onMount` 里那一句
 *    `dialogEl.focus()` 是 `Esc` 能生效的**前提**，不是礼貌。这一条只有真挂到 DOM 上才测得出来
 */

let container: HTMLElement
let dispose: (() => void) | null = null

function mountLightbox(target: { src: string; label: string }, onClose = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  dispose = render(() => <ImageLightbox target={target} onClose={onClose} />, container)
  return {
    backdrop: () => container.querySelector<HTMLElement>('.img-zoom-backdrop')!,
    dialog: () => container.querySelector<HTMLElement>('.img-zoom-dialog')!,
    img: () => container.querySelector<HTMLImageElement>('.img-zoom')!,
    path: () => container.querySelector<HTMLElement>('.img-zoom-path')!,
    close: () => container.querySelector<HTMLButtonElement>('.img-zoom-close')!,
    onClose,
  }
}

afterEach(() => {
  dispose?.()
  dispose = null
  container?.remove()
  document.body.innerHTML = ''
})

/** 造一张「已经在预览里显示出来」的图，可选地包在一个链接里 */
function imageEl(attrs: Record<string, string>, wrapInLink = false): HTMLElement {
  const img = document.createElement('img')
  Object.entries(attrs).forEach(([k, v]) => img.setAttribute(k, v))
  if (!wrapInLink) return img
  const a = document.createElement('a')
  a.setAttribute('href', 'https://example.com/post')
  a.append(img)
  return a
}

describe('zoomOf：哪一次点击算「点了一张图」', () => {
  it('本地图片给出原样的 vela-img URL，而那一行说明用的是正文里那串引用', () => {
    const url = 'vela-img://localhost/?doc=%2Fnotes%2Fa.md&ref=assets%2Fpasted-0123.png'
    const img = imageEl({ src: url, 'data-path': 'assets/pasted-0123.png' }) as HTMLImageElement
    expect(zoomOf(img)).toEqual({ src: url, label: 'assets/pasted-0123.png' })
  })

  it('⚠️ `src` 读属性不读 `.src`：后者会被文档 base 解析改写', () => {
    const img = imageEl({ src: 'https://e.com/a.png' }) as HTMLImageElement
    // jsdom 会把 `.src` 补成绝对形式；这一条钉子保证代码里用的是属性本身
    expect(img.src).toBe('https://e.com/a.png')
    expect(zoomOf(img)?.src).toBe(img.getAttribute('src'))
    expect(zoomOf(img)?.label).toBe('https://e.com/a.png') // 外链没有 data-path，退回 URL
  })

  it('被链接包住的图归链接，不弹', () => {
    const a = imageEl({ src: 'https://e.com/a.png' }, true)
    const img = a.querySelector('img') as HTMLImageElement
    expect(zoomOf(img)).toBeNull()
  })

  it('占位 `span`、没有 src 的图、以及非元素都不算', () => {
    const span = document.createElement('span')
    span.className = 'md-img-local'
    expect(zoomOf(span)).toBeNull()
    expect(zoomOf(imageEl({}) as HTMLImageElement)).toBeNull()
    expect(zoomOf(document.createTextNode('x'))).toBeNull()
    expect(zoomOf(null)).toBeNull()
  })
})

describe('ImageLightbox：那张遮罩', () => {
  it('图、说明与关闭按钮各就各位', () => {
    const l = mountLightbox({ src: 'vela-img://localhost/?doc=%2Fa.md&ref=b.png', label: 'assets/b.png' })
    expect(l.img().getAttribute('src')).toBe('vela-img://localhost/?doc=%2Fa.md&ref=b.png')
    expect(l.img().alt).toBe('assets/b.png')
    expect(l.path().textContent).toBe('assets/b.png')
    expect(l.dialog().getAttribute('role')).toBe('dialog')
    expect(l.close().textContent).toBe('×')
  })

  it('🔴 挂载即把焦点收进来，否则 `Esc` 压根作用不到这一层', () => {
    const l = mountLightbox({ src: 'https://e.com/a.png', label: 'a.png' })
    expect(document.activeElement).toBe(l.dialog())
  })

  it('按 `Esc` 关', () => {
    const l = mountLightbox({ src: 'https://e.com/a.png', label: 'a.png' })
    l.dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(l.onClose).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 点遮罩本体才算「点外面」；点在图上不关（事件会一路冒泡到遮罩）', () => {
    const l = mountLightbox({ src: 'https://e.com/a.png', label: 'a.png' })
    l.img().click()
    expect(l.onClose).not.toHaveBeenCalled()
    l.backdrop().click()
    expect(l.onClose).toHaveBeenCalledTimes(1)
  })

  it('点 `×` 关', () => {
    const l = mountLightbox({ src: 'https://e.com/a.png', label: 'a.png' })
    l.close().click()
    expect(l.onClose).toHaveBeenCalledTimes(1)
  })

  it('大图没到位时说的是「加载不出来」，而路径还在', () => {
    const l = mountLightbox({ src: 'vela-img://localhost/?doc=%2Fa.md&ref=b.png', label: 'assets/b.png' })
    l.img().dispatchEvent(new Event('error'))
    expect(l.path().textContent).toContain('这张图加载不出来：')
    expect(l.path().textContent).toContain('assets/b.png')
    expect(l.path().classList.contains('failed')).toBe(true)
  })

  it('关掉之后焦点还给打开前那个元素', () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    expect(document.activeElement).toBe(before)
    mountLightbox({ src: 'https://e.com/a.png', label: 'a.png' })
    expect(document.activeElement).not.toBe(before)
    dispose?.()
    dispose = null
    expect(document.activeElement).toBe(before)
    before.remove()
  })
})
