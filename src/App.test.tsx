// @vitest-environment jsdom
import { EditorView } from '@codemirror/view'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'
import { detectPlatform } from './commands/keybinding'

/**
 * `Mod` 在不同平台上是不同物理键，而 jsdom 的 UA 不含 "Mac" → detectPlatform() 判成 linux。
 * 所以按被测环境实际检测到的平台发键，而不是写死 metaKey。
 */
const modInit = (): KeyboardEventInit => (detectPlatform() === 'macos' ? { metaKey: true } : { ctrlKey: true })

let container: HTMLDivElement
let dispose: () => void

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  dispose = render(() => <App />, container)
})

afterEach(() => {
  dispose()
  container.remove()
  document.documentElement.removeAttribute('style')
})

function view(): EditorView {
  const dom = container.querySelector<HTMLElement>('.cm-editor')
  if (!dom) throw new Error('App 没有渲染出编辑器')
  const found = EditorView.findFromDOM(dom)
  if (!found) throw new Error('拿不到 EditorView 实例')
  return found
}

function badges(): string[] {
  return [...container.querySelectorAll('.badge')].map((b) => b.textContent ?? '')
}

function fontSizeSelect(): HTMLSelectElement {
  const el = [...container.querySelectorAll('select')].find((s) => s.title.startsWith('字号'))
  if (!el) throw new Error('找不到字号 select')
  return el
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

/** 敲字走 CM6 的事务，等于用户在编辑器里真的输入 */
function typeText(text: string) {
  const v = view()
  v.dispatch({ changes: { from: v.state.doc.length, insert: text } })
}

describe('App 接线', () => {
  it('挂载后编辑器就位，状态栏报出空文档的度量', () => {
    expect(container.querySelector('.editor-container .cm-editor')).not.toBeNull()
    expect(badges()[0]).toBe('空文档')
    // CM6 把空文档算作「一行空行」，所以是 1 行 0 字符，不是 0 行
    expect(badges()[1]).toBe('1 行 · 0 字符')
  })

  it('输入会经 onUpdate 推到状态栏（CM6 → signal 的回路在真实 App 里通）', () => {
    typeText('第一行\n第二行\n第三行')
    expect(badges()[1]).toBe('3 行 · 11 字符')
  })

  it('Alt+Z 经命令中心切换换行，按钮标签与编辑器状态同时更新', () => {
    const button = [...container.querySelectorAll('button')].find((b) => b.title === 'Alt+Z')
    expect(button?.textContent).toBe('开')

    press('z', { altKey: true })
    expect(button?.textContent).toBe('关')
    expect(
      view()
        .state.facet(EditorView.contentAttributes)
        .some((a) => typeof a !== 'function' && a.class === 'cm-lineWrapping'),
    ).toBe(false)

    press('z', { altKey: true })
    expect(button?.textContent).toBe('开')
  })

  it('Mod+= / Mod+- / Mod+0 改字号，CSS 变量与 select 同步', () => {
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')

    press('=', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('15px')
    expect(fontSizeSelect().value).toBe('15')

    press('-', modInit())
    press('-', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('13px')

    press('0', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')
  })

  it('字号只在预设档位间走，不会冒出 select 显示不了的档外值', () => {
    // 从最小档继续缩小应当停在 12px
    press('0', modInit())
    press('-', modInit())
    press('-', modInit())
    press('-', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('12px')
    expect(fontSizeSelect().value).toBe('12')
  })

  it('「空文档」清空编辑器，状态栏回到空文档的度量（setDoc 必须触发 onUpdate）', () => {
    typeText('a\nb\nc\nd')
    expect(badges()[1]).toBe('4 行 · 7 字符')

    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === '空文档')
    button?.click()

    expect(view().state.doc.toString()).toBe('')
    expect(badges()[1]).toBe('1 行 · 0 字符')
  })

  it('卸载后全局快捷键监听被摘掉，不会再驱动已销毁的编辑器', () => {
    dispose()
    // 重新挂一个空的，避免 afterEach 再 dispose 一次已卸载的树
    dispose = () => {}
    expect(() => press('z', { altKey: true })).not.toThrow()
    expect(container.querySelector('.cm-editor')).toBeNull()
  })
})
