// @vitest-environment jsdom

/**
 * `src/md/print.ts` 的用例（M7-15）。jsdom 环境——这一层只碰 DOM。
 *
 * 盯三件事：快照长成 `styles.css` 那几条 `@media print` 规则认得的样子、样式表只在该
 * 打印媒体里生效、以及**重复挂载是替换而不是叠加**。
 *
 * ⚠️ 最后一条是最重要的：叠加的失败方式是「第二次导出打印出来是第一份文档」，
 * 而这件事在屏幕上永远看不见，只有纸上才现形。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { EXPORT_STYLE } from './export'
import { PRINT_ROOT_ID, PRINT_STYLE_ID, mountPrintSnapshot } from './print'

function root(): HTMLElement | null {
  const el = document.getElementById(PRINT_ROOT_ID)
  return el instanceof HTMLElement ? el : null
}

function style(): HTMLStyleElement | null {
  const el = document.getElementById(PRINT_STYLE_ID)
  return el instanceof HTMLStyleElement ? el : null
}

/** 与 `mountPrintSnapshot` 侧的效果一一对应，只用于用例之间互相隔离 */
function reset(): void {
  root()?.remove()
  style()?.remove()
  delete document.documentElement.dataset.printSnapshot
  document.body.innerHTML = ''
}

afterEach(reset)

describe('mountPrintSnapshot：快照的形状', () => {
  it('根节点是 <main class="md-doc">，正文原样进去', () => {
    mountPrintSnapshot('<h1>标题</h1><p>正文</p>')

    const el = root()
    expect(el).not.toBeNull()
    // 标签名与 class 必须与 `exportHtml` 的 <main class="md-doc"> 一致：
    // EXPORT_STYLE 的每一条排版规则都挂在 `.md-doc` 下，换一个外壳就没有排版
    expect(el!.tagName).toBe('MAIN')
    expect(el!.className).toBe('md-doc')
    expect(el!.innerHTML).toBe('<h1>标题</h1><p>正文</p>')
  })

  it('带 aria-hidden：屏幕上看不见，也不该进无障碍树与 Tab 顺序', () => {
    mountPrintSnapshot('<p>正文</p>')

    expect(root()!.getAttribute('aria-hidden')).toBe('true')
  })

  it('在 <html> 上打开关，交给 styles.css 的 @media print 规则', () => {
    expect(document.documentElement.hasAttribute('data-print-snapshot')).toBe(false)

    mountPrintSnapshot('<p>正文</p>')

    // 开关必须落在 <html> 而不是根节点自己身上：body 的 overflow/height 是全局布局
    expect(document.documentElement.hasAttribute('data-print-snapshot')).toBe(true)
  })
})

describe('mountPrintSnapshot：样式表', () => {
  it('一份 media="print" 的 <style>，内容就是 EXPORT_STYLE', () => {
    mountPrintSnapshot('<p>正文</p>')

    const el = style()
    expect(el).not.toBeNull()
    // media 属性而不是在内容外面再包一层 @media：EXPORT_STYLE 自己已经有打印段
    expect(el!.media).toBe('print')
    // 与导出 HTML 共用同一段常量，纸面与网页因此是同一个观感
    expect(el!.textContent).toBe(EXPORT_STYLE)
    expect(document.querySelectorAll(`#${PRINT_STYLE_ID}`)).toHaveLength(1)
  })
})

describe('mountPrintSnapshot：重复挂载是替换', () => {
  it('第二次挂载换掉正文，不新增根节点、不新增样式表', () => {
    mountPrintSnapshot('<p>第一份</p>')
    mountPrintSnapshot('<p>第二份</p>')

    expect(root()!.innerHTML).toBe('<p>第二份</p>')
    // ⛔ 叠加的失败方式是「第二次导出打印出来是第一份」，纸上才看得见
    expect(document.querySelectorAll(`#${PRINT_ROOT_ID}`)).toHaveLength(1)
    expect(document.querySelectorAll(`#${PRINT_STYLE_ID}`)).toHaveLength(1)
    expect(document.body.children).toHaveLength(1)
  })

  it('不动应用自己的 DOM 树', () => {
    const app = document.createElement('div')
    app.id = 'root'
    app.innerHTML = '<p>应用界面</p>'
    document.body.appendChild(app)

    mountPrintSnapshot('<p>正文</p>')

    expect(app.innerHTML).toBe('<p>应用界面</p>')
    // 快照挂在 body 下、与应用根节点平级：打印时由 CSS 把其余兄弟节点藏掉
    expect(root()!.parentElement).toBe(document.body)
    expect(root()!.previousElementSibling).toBe(app)
  })
})
