// @vitest-environment jsdom
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarkdownToolbar } from './MarkdownToolbar'
import type { PreviewMode } from './previewMode'

/**
 * 工具栏的「预览 / 编辑」开关。
 *
 * 钉四件事：**文案跟着形态走**（点下去会到哪儿）、**回调载荷**、
 * **没有预览的文档上禁用它**、**阅读模式里格式按钮全部禁用**。
 * 排版好不好看是 CSS 的账，这里不管。
 */

let container: HTMLDivElement
let dispose: (() => void) | undefined

function mount(initial: PreviewMode, available = true, onToggle?: () => void) {
  const [mode, setMode] = createSignal<PreviewMode>(initial)
  const received: PreviewMode[] = []
  dispose = render(
    () => (
      <MarkdownToolbar
        editor={() => null}
        onToggle={onToggle ?? (() => {})}
        previewMode={mode}
        previewAvailable={() => available}
        onPreviewMode={(m) => {
          received.push(m)
          // 与 App 一样：回调落地之后形态真的变了，按钮文案要跟着变
          setMode(m)
        }}
      />
    ),
    container,
  )
  return { mode, received }
}

function modeBtn(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('.md-toolbar-mode')
  if (!el) throw new Error('工具栏上没有「预览 / 编辑」按钮')
  return el
}

/** 格式化按钮：除了那一个开关之外的全部 `.md-toolbar-btn` */
function formatBtns(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.md-toolbar-btn:not(.md-toolbar-mode)')]
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

describe('预览 / 编辑', () => {
  it('编辑态写着「预览」，点下去进入只预览', () => {
    const { received } = mount('side')
    expect(modeBtn().textContent).toBe('预览')
    expect(modeBtn().disabled).toBe(false)
    expect(modeBtn().getAttribute('aria-pressed')).toBe('false')

    modeBtn().click()

    expect(received).toEqual(['only'])
    // 进来了：按钮反过来写着「编辑」，点它就能回去
    expect(modeBtn().textContent).toBe('编辑')
    expect(modeBtn().getAttribute('aria-pressed')).toBe('true')
  })

  it('只预览时写着「编辑」，点下去回到并排', () => {
    const { received } = mount('only')

    expect(modeBtn().textContent).toBe('编辑')
    modeBtn().click()

    expect(received).toEqual(['side'])
    expect(modeBtn().textContent).toBe('预览')
  })

  it('预览关着也算「编辑」那一侧：从 off 点进去落到只预览', () => {
    const { received } = mount('off')
    expect(modeBtn().textContent).toBe('预览')

    modeBtn().click()

    expect(received).toEqual(['only'])
  })

  it('这个文件没有预览时禁用：按得动就会落到一块空面板上', () => {
    mount('side', false)

    expect(modeBtn().disabled).toBe(true)
    expect(modeBtn().title).toBe('这个文件没有 Markdown 预览')
    // 没有预览可切，但格式化照样能改正文——它们不该陪着一起禁用
    expect(formatBtns().every((b) => !b.disabled)).toBe(true)
  })

  it('只预览里格式按钮全部禁用：它们会改一块看不见的 buffer', () => {
    mount('only')

    expect(formatBtns().length).toBeGreaterThan(0)
    for (const btn of formatBtns()) {
      expect(btn.disabled).toBe(true)
      expect(btn.title).toBe('预览模式下不能编辑，先切回「编辑」')
    }
    // 开关自己当然还是能按的，否则就出不去了
    expect(modeBtn().disabled).toBe(false)
  })

  it('`only` 在没有预览的文档上会降级成并排，那种时候不算阅读模式', () => {
    mount('only', false)

    // 编辑区其实还在（App 的 editorHidden 会放行），所以格式按钮仍可用
    expect(formatBtns().every((b) => !b.disabled)).toBe(true)
    expect(modeBtn().disabled).toBe(true)
  })

  it('开关在工具栏最右，隐藏工具栏的 × 照常工作', () => {
    let toggled = 0
    mount('side', true, () => {
      toggled++
    })

    expect(container.querySelector('.md-toolbar')!.lastElementChild).toBe(modeBtn())

    container.querySelector<HTMLButtonElement>('.md-toolbar-toggle-btn')!.click()
    expect(toggled).toBe(1)
  })
})

describe('两个代码按钮', () => {
  // `</>` / `{ }` 那一对小尺寸下都读成「代码」，用户分不出谁是行内、谁是块。
  // 行内保留尖括号；代码块换成 Markdown 自己的围栏（三反引号）。
  it('图标与提示词能一眼分开：行内是 </>，代码块是 ``` 围栏', () => {
    mount('side')
    const byTitle = (prefix: string) => formatBtns().find((b) => b.title.startsWith(prefix))!

    expect(byTitle('行内代码').textContent).toBe('</>')
    expect(byTitle('行内代码').title).toBe('行内代码（`代码`）')
    expect(byTitle('代码块').textContent).toBe('```')
    expect(byTitle('代码块').title).toBe('代码块（``` 围栏，可多行）')
  })
})
