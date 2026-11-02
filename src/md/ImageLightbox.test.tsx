// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageLightbox } from './ImageLightbox'
import type { ZoomTarget } from './imageActions'

/**
 * 那张遮罩本身。判断「这一次点击该不该弹」的用例在 `./imageActions.test.ts`——
 * 那个函数现在不属于这一层，两个手势的判据住在一起才比「谁用到大图谁自己写一份」好。
 *
 * 四条要紧的：
 *
 * 1. 🔴 **`src` 原样传进去，一个字节都不改**。这一层不碰字节（不读文件、不换 URL、
 *    不拼 HTML），所以大图天然继承 M7-9 那条 `vela-img` 校验边界。
 * 2. ⚠️ **焦点是自己进来的，而且进来之后出不去**：`onMount` 里那一句 `dialogEl.focus()`
 *    是 `Esc` 能生效的**前提**，不是礼貌；`Tab` 那一条陷阱是 `aria-modal="true"` 的另一半
 *    （声明了模态却守不住焦点比不声明更误导读屏器）。两条都只有真挂到 DOM 上才测得出来。
 * 3. ⚠️ **大图要把正文那串引用挂回自己的 `data-path`**，宿主那份右键菜单靠它认图
 *    （下面那一条用例钉的是「别把 `vela-img:` 留给 webview 原生菜单」）
 * 4. 🔴 **M7-8 起大图还要挂 `data-oss-src`**：云端那一张在预览里的 `src` 是一份 15 分钟的
 *    读取凭证，会走出应用外面的那两样（剪贴板与底部那一行）只许用不带签名的地址
 */

let container: HTMLElement
let dispose: (() => void) | null = null

function mountLightbox(target: ZoomTarget, onClose = vi.fn()) {
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

const LOCAL: ZoomTarget = {
  src: 'vela-img://localhost/?doc=%2Fa.md&ref=b.png',
  label: 'assets/b.png',
  ref: 'assets/b.png',
  unsigned: null,
}
const EXTERNAL: ZoomTarget = { src: 'https://e.com/a.png', label: 'a.png', ref: null, unsigned: null }
/** M7-8：预览里那张云端图的 `src` 是签名地址，而 `label` 与复制出去的都是无签名那一条 */
const CLOUD: ZoomTarget = {
  src: 'https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/pasted-1.png?x-oss-date=20231216T162057Z&x-oss-signature=abc',
  label: 'https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/pasted-1.png',
  ref: null,
  unsigned: 'https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/pasted-1.png',
}

describe('ImageLightbox：那张遮罩', () => {
  it('图、说明与关闭按钮各就各位', () => {
    const l = mountLightbox(LOCAL)
    expect(l.img().getAttribute('src')).toBe(LOCAL.src)
    expect(l.img().alt).toBe('assets/b.png')
    expect(l.path().textContent).toBe('assets/b.png')
    expect(l.dialog().getAttribute('role')).toBe('dialog')
    expect(l.close().textContent).toBe('×')
  })

  it('⚠️ 本地图把正文那串引用挂在自己的 `data-path` 上——右键大图才认得它是哪张图', () => {
    const l = mountLightbox(LOCAL)
    expect(l.img().dataset.path).toBe('assets/b.png')
  })

  it('🔴 云端那张把**不带签名**的地址挂在 `data-oss-src` 上，底部那一行显示的也是它', () => {
    // 剪贴板与那一行都会走到应用外面，而 `src` 里那一份是 15 分钟的读取凭证。
    // ⛔ 这条挂了之后 `copyTargetOf` 就只可能读到 `data-oss-src`（对照 imageActions.test.ts）
    const l = mountLightbox(CLOUD)
    expect(l.img().dataset.ossSrc).toBe(CLOUD.unsigned)
    expect(l.path().textContent).toBe('https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/pasted-1.png')
    expect(l.path().textContent).not.toContain('x-oss-signature')
    // 显示用的还是预览里那一个地址：换掉就等于对同一张图再发一次请求
    expect(l.img().getAttribute('src')).toBe(CLOUD.src)
  })

  it('外链大图不带 `data-path`：那一串冒充成文档内的引用就会把「复制链接」说成「复制路径」', () => {
    const l = mountLightbox(EXTERNAL)
    expect(l.img().hasAttribute('data-path')).toBe(false)
  })

  it('🔴 挂载即把焦点收进来，否则 `Esc` 压根作用不到这一层', () => {
    const l = mountLightbox(EXTERNAL)
    expect(document.activeElement).toBe(l.dialog())
  })

  it('🔴 `aria-modal` 与焦点陷阱一起上：`Tab` 走不出去，落在 `×` 上', () => {
    const l = mountLightbox(EXTERNAL)
    expect(l.dialog().getAttribute('aria-modal')).toBe('true')
    l.dialog().focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    l.dialog().dispatchEvent(tab)
    expect(tab.defaultPrevented, '不拦的话浏览器接着就把焦点送到遮罩后面那一堆界面里去了').toBe(true)
    expect(document.activeElement).toBe(l.close())
    // 已经在唯一那一格上时再按也出不去：这一层只有 `×` 一个可聚焦控件
    const again = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    l.close().dispatchEvent(again)
    expect(again.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(l.close())
  })

  it('`Shift+Tab` 同一个结果：只有一格，没有「上一格」可去', () => {
    const l = mountLightbox(EXTERNAL)
    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    l.dialog().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(l.close())
  })

  it('按 `Esc` 关', () => {
    const l = mountLightbox(EXTERNAL)
    l.dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(l.onClose).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 点遮罩本体才算「点外面」；点在图上不关（事件会一路冒泡到遮罩）', () => {
    const l = mountLightbox(EXTERNAL)
    l.img().click()
    expect(l.onClose).not.toHaveBeenCalled()
    l.backdrop().click()
    expect(l.onClose).toHaveBeenCalledTimes(1)
  })

  it('点 `×` 关', () => {
    const l = mountLightbox(EXTERNAL)
    l.close().click()
    expect(l.onClose).toHaveBeenCalledTimes(1)
  })

  it('大图没到位时说的是「加载不出来」，而路径还在', () => {
    const l = mountLightbox(LOCAL)
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
    mountLightbox(EXTERNAL)
    expect(document.activeElement).not.toBe(before)
    dispose?.()
    dispose = null
    expect(document.activeElement).toBe(before)
    before.remove()
  })
})
