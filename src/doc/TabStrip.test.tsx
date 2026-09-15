// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 标签条的测试：DOM 与 workspace 之间的接线。
 *
 * 调度逻辑本身（激活谁、关掉之后落到谁、重排后的顺序）在 `workspace.test.ts` 里已经测过了，
 * 这里只测「点对了地方会不会调到对的方法」与「渲染出来的东西对不对」。
 * 所以**不挂编辑器**：标签条读的是 `tab.snapshot` 与 `doc`，不需要 view。
 */

const { ipc } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
  },
}))

vi.mock('../ipc/fs', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))

import { TabStrip } from './TabStrip'
import { createWorkspace } from './workspace'

let container: HTMLDivElement
let dispose: () => void

function mount(ws: ReturnType<typeof createWorkspace>) {
  dispose = render(() => <TabStrip workspace={ws} />, container)
  return ws
}

function tabs(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.tab-strip .tab')]
}

function names(): string[] {
  return tabs().map((t) => t.querySelector('.tab-name')?.textContent ?? '')
}

function newTabButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('.tab-new')
  if (!el) throw new Error('找不到新建标签按钮')
  return el
}

function fire(el: Element, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event
}

/** 拖拽重排：dragstart 在源上，dragover + drop 在目标上 */
function drag(from: number, to: number): Event {
  fire(tabs()[from]!, 'dragstart')
  fire(tabs()[to]!, 'dragover')
  return fire(tabs()[to]!, 'drop')
}

beforeEach(() => {
  ipc.openFile.mockReset()
  ipc.openFile.mockImplementation(async () => ({
    text: '正文',
    format: { encoding: 'utf8', bom: false, eol: 'lf' },
    lossy: false,
    bytes: 6,
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  dispose()
  container.remove()
})

describe('渲染', () => {
  it('一上来就有一个标签，是活动的，带 aria-selected', () => {
    mount(createWorkspace())
    expect(tabs()).toHaveLength(1)
    expect(tabs()[0]!.classList.contains('active')).toBe(true)
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs()[0]!.getAttribute('role')).toBe('tab')
    expect(container.querySelector('.tab-strip')?.getAttribute('role')).toBe('tablist')
  })

  it('无名文档显示「空文档」，title 上没有路径可挂所以也是它', () => {
    mount(createWorkspace())
    expect(names()).toEqual(['空文档'])
    expect(tabs()[0]!.title).toBe('空文档')
  })

  it('打开文件后标签名是 basename，全路径挂在 title 上', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/Users/x/notes/win.txt')
    expect(names()).toEqual(['win.txt'])
    expect(tabs()[0]!.title).toBe('/Users/x/notes/win.txt')
  })

  it('脏标签的名字前面带 ●，干净的没有', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    ws.tabs()[0]!.doc.markChanged()
    expect(names()).toEqual(['● 空文档', '空文档'])
  })

  it('每个标签都 draggable，否则 HTML5 拖放压根不启动', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    ws.newTab()
    expect(tabs().map((t) => t.getAttribute('draggable'))).toEqual(['true', 'true', 'true'])
  })
})

describe('交互', () => {
  it('点标签激活它，active 类跟着走', () => {
    const ws = mount(createWorkspace())
    const second = ws.newTab()
    expect(ws.activeTab()).toBe(second)

    tabs()[0]!.click()

    expect(ws.activeTab().id).not.toBe(second.id)
    expect(tabs()[0]!.classList.contains('active')).toBe(true)
    expect(tabs()[1]!.classList.contains('active')).toBe(false)
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('false')
  })

  it('点「+」新建一个标签并激活它', () => {
    mount(createWorkspace())
    newTabButton().click()
    expect(tabs()).toHaveLength(2)
    expect(tabs()[1]!.classList.contains('active')).toBe(true)
  })

  it('点关闭按钮只摘掉那一个标签，当前激活的不受影响', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    const third = ws.newTab()
    expect(ws.activeTab()).toBe(third)

    tabs()[0]!.querySelector<HTMLButtonElement>('.tab-close')!.click()

    expect(tabs()).toHaveLength(2)
    expect(ws.activeTab()).toBe(third)
  })

  it('关掉最后一个标签会补一个空的进来——标签条永不为空', () => {
    mount(createWorkspace())
    tabs()[0]!.querySelector<HTMLButtonElement>('.tab-close')!.click()
    expect(tabs()).toHaveLength(1)
    expect(names()).toEqual(['空文档'])
    expect(tabs()[0]!.classList.contains('active')).toBe(true)
  })
})

describe('分屏在标签条上的反映', () => {
  it('显示在别的分屏里的标签带 shown，聚焦那块的是 active，两者互斥', () => {
    const ws = mount(createWorkspace())
    ws.split('row')

    expect(tabs()).toHaveLength(2)
    expect(tabs()[0]!.classList.contains('shown')).toBe(true)
    expect(tabs()[0]!.classList.contains('active')).toBe(false)
    expect(tabs()[1]!.classList.contains('active')).toBe(true)
    expect(tabs()[1]!.classList.contains('shown')).toBe(false)
    // aria-selected 只认聚焦那块：读屏的人一次只该听到一个「已选中」
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it('换焦点时两个标记对调', () => {
    const ws = mount(createWorkspace())
    ws.split('row')

    ws.focusPane(ws.panes()[0]!.id)

    expect(tabs()[0]!.classList.contains('active')).toBe(true)
    expect(tabs()[0]!.classList.contains('shown')).toBe(false)
    expect(tabs()[1]!.classList.contains('shown')).toBe(true)
    expect(tabs()[1]!.classList.contains('active')).toBe(false)
  })

  it('合并掉分屏之后 shown 标记消失，但标签还在条上', () => {
    const ws = mount(createWorkspace())
    ws.split('row')
    ws.closePane(ws.panes()[1]!.id)

    expect(tabs()).toHaveLength(2)
    expect(tabs().map((t) => t.classList.contains('shown'))).toEqual([false, false])
    expect(tabs()[0]!.classList.contains('active')).toBe(true)
  })

  it('点 shown 标签是把焦点交给那块分屏，不是把它搬过来', () => {
    const ws = mount(createWorkspace())
    ws.split('row')
    const left = ws.panes()[0]!
    const rightTab = ws.tabs()[1]!
    ws.focusPane(left.id)

    tabs()[1]!.click()

    expect(ws.focusedPaneId()).toBe(ws.panes()[1]!.id)
    expect(ws.activeTab()).toBe(rightTab)
    // 左边那块还显示着它原来的标签：搬走会让它空掉
    expect(left.tabId()).toBe(ws.tabs()[0]!.id)
  })
})

describe('拖拽重排', () => {
  it('把第一个拖到第三个上，顺序变成 [b, c, a]', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    ws.newTab()
    const [a, b, c] = ws.tabs()

    drag(0, 2)

    expect(ws.tabs().map((t) => t.id)).toEqual([b!.id, c!.id, a!.id])
    expect(names()).toHaveLength(3)
  })

  it('dragover 被 preventDefault——不拦的话浏览器认为这里不接受放置，drop 压根不触发', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    fire(tabs()[0]!, 'dragstart')
    expect(fire(tabs()[1]!, 'dragover').defaultPrevented).toBe(true)
  })

  it('拖到自己身上不动', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    const before = ws.tabs().map((t) => t.id)
    drag(1, 1)
    expect(ws.tabs().map((t) => t.id)).toEqual(before)
  })

  it('没有正在拖的标签时，drop 是空操作（比如从窗口外拖进来的文件）', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    const before = ws.tabs().map((t) => t.id)
    fire(tabs()[0]!, 'drop')
    expect(ws.tabs().map((t) => t.id)).toEqual(before)
  })

  it('dragend 之后再 drop 也不动——拖拽被取消（拖出窗口松手）不能留下半个操作', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    const before = ws.tabs().map((t) => t.id)
    fire(tabs()[0]!, 'dragstart')
    fire(tabs()[0]!, 'dragend')
    fire(tabs()[1]!, 'drop')
    expect(ws.tabs().map((t) => t.id)).toEqual(before)
  })
})
