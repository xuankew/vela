// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「外观」浮层的组件测试：DOM 与 `createSettingsStore` 之间的接线。
 *
 * sanitize / 写穿队列 / CSS 变量那一半在 `./store.test.ts` 里钉过了。这里测五件事：
 * **打开与关闭**（按钮 toggle、Esc、点外面）、**画出来的读数对不对得上 store**、
 * **步进器与 select 落到对的 mutator 上**、**恢复默认把六项都打回内置默认**、
 * **a11y 属性**（aria-haspopup / aria-expanded / role=dialog）。
 *
 * ⚠️ 用**真的** store（只 mock IPC 与字体注入），不用手搓的假对象：这一层的全部职责就是
 * 「把 DOM 事件翻译成 store 的 mutator 调用」，用假 store 就只剩下「调了个函数」可验，
 * 而真 store 能让「点了 + 之后读数变成 1.8、CSS 变量也写了」这条端到端在 jsdom 里跑通。
 *
 * ⚠️ jsdom 里没有布局：浮层该多大、锚在按钮下方哪一处、box-shadow 长什么样，
 * 这里都量不出来，得在真机上看。
 */

// `vi.hoisted`：mock 工厂在被 mock 模块首次 import 时就执行，那时普通 const 还在 TDZ 里
const { settingsIpc, fontLoader } = vi.hoisted(() => ({
  settingsIpc: { loadSettings: vi.fn(), saveSettings: vi.fn() },
  fontLoader: { applyFontVariant: vi.fn(), applyCodeFont: vi.fn() },
}))

vi.mock('../ipc/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/settings')>()),
  loadSettings: settingsIpc.loadSettings,
  saveSettings: settingsIpc.saveSettings,
}))

vi.mock('../fonts/loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fonts/loader')>()),
  applyFontVariant: fontLoader.applyFontVariant,
  applyCodeFont: fontLoader.applyCodeFont,
}))

import { DEFAULT_CODE_FONT, DEFAULT_VARIANT } from '../fonts/loader'
import { AppearancePopover } from './AppearancePopover'
import { createSettingsStore, DEFAULT_FONT_SIZE, type SettingsStore } from './store'
import { DEFAULT_THEME } from './theme'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let store: SettingsStore
let dispose: () => void
let container: HTMLDivElement

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  dispose = render(() => <AppearancePopover settings={store} />, container)
}

const toggle = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('.appearance-toggle')!
const pop = (): HTMLElement | null => container.querySelector<HTMLElement>('.appearance-pop')
const row = (label: string): HTMLElement => {
  const rows = [...container.querySelectorAll<HTMLElement>('.appearance-row')]
  return rows.find((r) => r.querySelector('.appearance-label')?.textContent === label)!
}
const stepperValue = (label: string): string => row(label).querySelector('.appearance-value')!.textContent
const stepperButtons = (label: string): NodeListOf<HTMLButtonElement> =>
  row(label).querySelectorAll<HTMLButtonElement>('.appearance-stepper button')
const selectByTitle = (prefix: string): HTMLSelectElement =>
  container.querySelector<HTMLSelectElement>(`select[title^="${prefix}"]`)!

function changeSelect(el: HTMLSelectElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  settingsIpc.loadSettings.mockReset()
  settingsIpc.saveSettings.mockReset()
  settingsIpc.saveSettings.mockResolvedValue({ bytesWritten: 80 })
  fontLoader.applyFontVariant.mockReset()
  fontLoader.applyCodeFont.mockReset()
  fontLoader.applyFontVariant.mockResolvedValue({})
  fontLoader.applyCodeFont.mockResolvedValue({})
  store = createSettingsStore()
  mount()
})

afterEach(() => {
  dispose()
  container.remove()
})

describe('打开与关闭', () => {
  it('默认关着，面板不在 DOM 里', () => {
    expect(pop()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('点按钮打开，再点一次关闭', () => {
    click(toggle())
    expect(pop()).not.toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    click(toggle())
    expect(pop()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('Esc 关闭并 preventDefault', () => {
    click(toggle())
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    pop()!.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(pop()).toBeNull()
  })

  it('🔴 点浮层外面关闭（document pointerdown），点里面不关', async () => {
    click(toggle())
    await flush() // 让「延迟一帧再挂监听」的那个 setTimeout 跑掉
    expect(pop()).not.toBeNull()

    // 点浮层内部：冒泡到 document，但 target 在 rootEl 里，不关
    pop()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(pop()).not.toBeNull()

    // 点浮层外面（document.body）：关
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(pop()).toBeNull()
  })

  it('打开时焦点落到第一个控件（主题 select）', async () => {
    click(toggle())
    await flush()
    expect(document.activeElement).toBe(row('主题').querySelector('select'))
  })
})

describe('a11y', () => {
  it('按钮有 aria-haspopup，面板有 role=dialog 与 aria-label', () => {
    expect(toggle().getAttribute('aria-haspopup')).toBe('dialog')
    click(toggle())
    expect(pop()!.getAttribute('role')).toBe('dialog')
    expect(pop()!.getAttribute('aria-label')).toBe('外观')
  })
})

describe('读数对得上 store', () => {
  it('行高与字间距的初始读数就是内置默认；字间距 0 显示「正常」', () => {
    click(toggle())
    expect(stepperValue('行高')).toBe(String(store.lineHeight()))
    expect(stepperValue('字间距')).toBe('正常')
  })

  it('字号 select 的初值与三个 select 的选项来自注册表', () => {
    click(toggle())
    expect(selectByTitle('字号').value).toBe(String(DEFAULT_FONT_SIZE))
    expect(selectByTitle('正文与 UI 字体').value).toBe(DEFAULT_VARIANT)
    expect(selectByTitle('代码区字体').value).toBe(DEFAULT_CODE_FONT)
  })

  it('主题 select 的初值是内置默认，三个选项来自 THEME_LABELS', () => {
    click(toggle())
    const sel = row('主题').querySelector<HTMLSelectElement>('select')!
    expect(sel.value).toBe(DEFAULT_THEME)
    expect([...sel.options].map((o) => o.textContent)).toEqual(['亮色', '暗色', '跟随系统'])
  })
})

describe('控件落到对的 mutator', () => {
  it('行高 + / − 走 stepLineHeight，读数与 CSS 变量都跟着变', async () => {
    click(toggle())
    const [minus, plus] = stepperButtons('行高')
    click(plus!)
    expect(store.lineHeight()).toBe(1.8)
    expect(stepperValue('行高')).toBe('1.8')
    expect(document.documentElement.style.getPropertyValue('--vela-line-height')).toBe('1.8')
    click(minus!)
    expect(store.lineHeight()).toBe(1.75)
    await flush()
    expect(settingsIpc.saveSettings).toHaveBeenCalled()
  })

  it('字间距 + 走 stepLetterSpacing，读数从「正常」变成 em', () => {
    click(toggle())
    const [, plus] = stepperButtons('字间距')
    click(plus!)
    expect(store.letterSpacing()).toBe(0.01)
    expect(stepperValue('字间距')).toBe('0.01em')
    expect(document.documentElement.style.getPropertyValue('--vela-letter-spacing')).toBe('0.01em')
  })

  it('字号 select 走 setFontSize', () => {
    click(toggle())
    changeSelect(selectByTitle('字号'), '18')
    expect(store.fontSize()).toBe(18)
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('18px')
  })

  it('正文字体 select 走 setFontVariant，代码字体 select 走 setCodeFont', () => {
    click(toggle())
    changeSelect(selectByTitle('正文与 UI 字体'), 'screen-r')
    expect(store.fontKey()).toBe('screen-r')
    changeSelect(selectByTitle('代码区字体'), 'inherit')
    expect(store.codeFontKey()).toBe('inherit')
  })

  it('主题 select 走 setTheme，data-theme 属性跟着写', () => {
    click(toggle())
    const sel = row('主题').querySelector<HTMLSelectElement>('select')!
    changeSelect(sel, 'light')
    expect(store.theme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    changeSelect(sel, 'dark')
    expect(store.theme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('恢复默认', () => {
  it('把六项都打回内置默认', () => {
    click(toggle())
    store.setTheme('light')
    store.setFontSize(20)
    store.setFontVariant('screen-r')
    store.setCodeFont('inherit')
    store.setLineHeight(2.5)
    store.setLetterSpacing(0.3)

    click(container.querySelector('.appearance-reset')!)
    expect(store.theme()).toBe(DEFAULT_THEME)
    expect(store.fontSize()).toBe(DEFAULT_FONT_SIZE)
    expect(store.fontKey()).toBe(DEFAULT_VARIANT)
    expect(store.codeFontKey()).toBe(DEFAULT_CODE_FONT)
    expect(store.lineHeight()).toBe(1.75)
    expect(store.letterSpacing()).toBe(0)
    expect(stepperValue('字间距')).toBe('正常')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
