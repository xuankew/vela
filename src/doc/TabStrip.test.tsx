// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 标签条的测试：DOM 与 workspace 之间的接线。
 *
 * 调度逻辑本身（激活谁、关掉之后落到谁、重排后的顺序）在 `workspace.test.ts` 里已经测过了，
 * 这里只测「点对了地方会不会调到对的方法」与「渲染出来的东西对不对」。
 * 所以**不挂编辑器**：标签条读的是 `tab.snapshot` 与 `doc`，不需要 view。
 *
 * 右键菜单那一组测的也是接线，⛔ 不是菜单外壳本身：贴边 clamp、点外面关、Escape 关
 * 那三条在 `Sidebar.test.tsx` 里已经钉过了，共用的是同一个组件（`project/TreeMenu.tsx`）。
 * 这里只钉**这一侧独有的几件事**——弹不弹（未命名文档也弹，只是少一项）、拦没拦原生菜单、
 * 每一项落到哪个 workspace 方法上、选完之后递出去的是哪条路径、以及滚动时关掉。
 *
 * ⚠️ `open -R` 本身钉不住：jsdom 里没有 Tauri 运行时，桩只能验「调了没、参数对不对」，
 * 「Finder 真的打开并选中了那个文件」要在真实窗口里看。
 */

const { ipc, project } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
  },
  /**
   * ⚠️ 与 `Sidebar.test.tsx` 同一条注意：这两个名字是**这个模块图**从 `ipc/project` 里
   * 按名字导入的全部（`TabStrip.tsx` 用两个，`doc/fileWatch.ts` 用 `describeTreeError`）。
   * 少一个不会在 mock 那一刻报错，而是等到真去访问时变成 `undefined is not a function`
   */
  project: {
    revealFile: vi.fn(),
    describeTreeError: (err: unknown) => `打不开：${JSON.stringify(err)}`,
  },
}))

vi.mock('../ipc/fs', () => ipc)
vi.mock('../ipc/project', () => project)
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))

import { TabStrip } from './TabStrip'
import { createWorkspace } from './workspace'
// ⚠️ `?raw` 而不是 `node:fs`：tsconfig 的 `types` 只有 `vite/client`，没有 node 的类型
// （与 `md/render.test.ts` 同一路子）。拿到的是**源码文本**，不是生效的样式——
// jsdom 不做布局，叠放只能靠人眼在真窗口里看，这里钉的是它的前提
import stylesSource from '../styles.css?raw'

let container: HTMLDivElement
let dispose: () => void
/** `onError` 收到的话。App 那边把它接到窗口顶部的提示条上，这里只需要看它说了什么 */
let errors: string[]

function mount(ws: ReturnType<typeof createWorkspace>) {
  errors = []
  dispose = render(() => <TabStrip workspace={ws} onError={(text) => errors.push(text)} />, container)
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
  // ⚠️ 必须 `mockResolvedValue` 而不是让它默认回 `undefined`：组件里是
  // `void revealFile(path).catch(...)`，桩回 undefined 的话这行自己就抛
  // `Cannot read properties of undefined (reading 'catch')`，看起来像组件坏了
  project.revealFile.mockReset()
  project.revealFile.mockResolvedValue(undefined)
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

  it('脏标签在名字右边多一个 ●，干净的没有', () => {
    const ws = mount(createWorkspace())
    ws.newTab()
    ws.tabs()[0]!.doc.markChanged()
    // Sublime 口径：脏点是标题**右边**独立的一格（`.tab-dot`），不是名字的前缀——
    // 悬停时 × 会顶替它，所以它不能混在 `.tab-name` 里跟着名字一起被省略号截断
    expect(names()).toEqual(['空文档', '空文档'])
    expect(tabs()[0]!.querySelector('.tab-dot')?.textContent).toBe('●')
    expect(tabs()[1]!.querySelector('.tab-dot')).toBeNull()
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

  it('双击标签条空白处新建一个标签；双击标签或「+」不会多开', () => {
    const ws = mount(createWorkspace())
    const strip = container.querySelector<HTMLElement>('.tab-strip')!

    // 空白处：事件目标就是标签条自己
    strip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(ws.tabs()).toHaveLength(2)

    // 双击标签：dblclick 会冒泡到标签条，但 target 是那个标签，不该多开
    tabs()[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(ws.tabs()).toHaveLength(2)

    // 双击「+」：真实浏览器里它是两次 click（开两个）加一次 dblclick。这里只派发
    // dblclick 那一下，钉的是「这一下不会再多开一个」——否则连点两下 + 会开出三个
    newTabButton().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(ws.tabs()).toHaveLength(2)
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

describe('右键菜单', () => {
  /** 右键。必须是 `MouseEvent`：组件要读 `clientX/clientY` 当菜单的落点 */
  function rightClick(el: Element, x = 40, y = 12): MouseEvent {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
    el.dispatchEvent(e)
    return e
  }

  /** 菜单项的落点是 workspace 的 async 方法，点完之后要把在飞的 promise 冲干净 */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  function menu(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.tree-menu')
  }

  function menuItems(): string[] {
    return [...container.querySelectorAll<HTMLButtonElement>('.tree-menu-item')].map((b) => b.textContent ?? '')
  }

  function item(label: string): HTMLButtonElement {
    const el = menuItems().indexOf(label)
    if (el < 0) throw new Error(`菜单里没有「${label}」这一项（现有：${menuItems().join('、') || '空'}）`)
    return container.querySelectorAll<HTMLButtonElement>('.tree-menu-item')[el]!
  }

  it('右键一个打开了文件的标签 → 三项：打开所在目录、关闭其它、关闭所有', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/Users/x/notes/win.txt')

    const e = rightClick(tabs()[0]!)

    // 拦下来是必须的：不拦的话 macOS 会在我们的菜单旁边再弹一个原生的，两个叠在一起
    expect(e.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    expect(menuItems()).toEqual(['打开文件所在目录', '关闭其它标签', '关闭所有标签'])
  })

  it('选「打开文件所在目录」→ 递出去的是这个标签的完整路径，菜单随即关掉', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/Users/x/notes/win.txt')
    rightClick(tabs()[0]!)

    item('打开文件所在目录').click()

    expect(project.revealFile).toHaveBeenCalledWith('/Users/x/notes/win.txt')
    expect(menu()).toBeNull()
  })

  it('右键未命名文档也弹菜单：少了「打开所在目录」，两项关闭照常可用', () => {
    mount(createWorkspace())

    // 原来这一档连菜单都不弹——那时菜单里只有「打开文件所在目录」一项，而它对未命名文档
    // 无从谈起。多了两项关闭动作之后这个前提没了：关标签与它在不在磁盘上无关
    const e = rightClick(tabs()[0]!)
    expect(e.defaultPrevented).toBe(true)
    expect(menuItems()).toEqual(['关闭其它标签', '关闭所有标签'])
  })

  it('选「关闭其它标签」→ 只留右键的那一个', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/repo/a.txt')
    await ws.openAt('/repo/b.txt')
    await ws.openAt('/repo/c.txt')

    rightClick(tabs()[1]!)
    item('关闭其它标签').click()
    await flush()

    expect(names()).toEqual(['b.txt'])
    expect(menu()).toBeNull()
  })

  it('选「关闭所有标签」→ 全关，补一个空文档进来', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/repo/a.txt')
    await ws.openAt('/repo/b.txt')

    rightClick(tabs()[0]!)
    item('关闭所有标签').click()
    await flush()

    expect(names()).toEqual(['空文档'])
  })

  it('菜单弹着的时候关掉那个标签，选下去仍然是原来那条路径', async () => {
    /**
     * 菜单里存的是**路径快照**。「打开文件所在目录」要的是用户右键那一刻的那份文档：
     * 标签被关掉之后 `doc.path()` 已经无处可读了，而未命名文档存了盘之后路径还会变
     */
    const ws = mount(createWorkspace())
    await ws.openAt('/repo/a.txt')
    await ws.openAt('/repo/b.txt')
    rightClick(tabs()[0]!)

    tabs()[0]!.querySelector<HTMLButtonElement>('.tab-close')!.click()
    expect(names()).toEqual(['b.txt'])

    item('打开文件所在目录').click()
    expect(project.revealFile).toHaveBeenCalledWith('/repo/a.txt')
  })

  it('菜单弹着的时候那个标签被关掉了，「关闭其它标签」是安全的空操作', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/repo/a.txt')
    await ws.openAt('/repo/b.txt')
    rightClick(tabs()[0]!)

    tabs()[0]!.querySelector<HTMLButtonElement>('.tab-close')!.click()
    item('关闭其它标签').click()
    await flush()

    // 存的是 id，而那个 id 已经不在了：什么都不关（尤其不能顺手把 b 关掉）
    expect(names()).toEqual(['b.txt'])
  })

  it('标签条滚动时关掉菜单：菜单是 fixed，滚走的标签底下留着的是一份指着别处的菜单', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/repo/a.txt')
    rightClick(tabs()[0]!)
    expect(menu()).not.toBeNull()

    fire(container.querySelector('.tab-strip')!, 'scroll')

    expect(menu()).toBeNull()
  })

  it('做成了不说话（Finder 被推到前台本身就是回话），没做成才说一句', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/repo/gone.txt')
    rightClick(tabs()[0]!)
    item('打开文件所在目录').click()
    expect(errors).toEqual([])

    project.revealFile.mockRejectedValue({ kind: 'not_found', path: '/repo/gone.txt' })
    rightClick(tabs()[0]!)
    item('打开文件所在目录').click()
    // `.catch` 里的话是在微任务里说的；等一个宏任务，保证所有微任务都跑完了
    await new Promise((r) => setTimeout(r, 0))

    expect(errors).toEqual(['打不开：{"kind":"not_found","path":"/repo/gone.txt"}'])
  })

  /**
   * 哨兵：钉住「右键菜单不会被编辑器里的浮层盖住」的**前提**，不是叠放本身。
   *
   * 为什么只能钉前提：jsdom 不做布局，测试环境也不加载 `styles.css`，所以「谁盖住谁」
   * 在这里根本无从观测（`getComputedStyle` 拿不到任何数）。能钉的只有源码里那条规则。
   *
   * 少了 `z-index: 0` 会发生什么（2026-10-27 用户报的真实缺陷）：CM6 的 baseTheme 给
   * `.cm-panels`（查找/替换面板）z-index 300、给 `.cm-tooltip`（补全/悬浮）500，而
   * `.editor-host` 只有 `position: relative` 时**不构成层叠上下文**，那两个数会一路逃到
   * 根上下文里跟外部浮层比大小——菜单 `.tree-menu` 是 `position: fixed` + z-index 10，
   * 比不过 300，于是查找框开着时右键标签弹出的菜单被它盖掉一半。
   *
   * ⛔ 也别改成抬 `.tree-menu` 的 z-index：那会让菜单盖到命令面板（20）与模态框之上。
   * ⚠️ 这条哨兵能读到 CSS 源码，靠的是 `vitest.config.ts` 里 `css: { include: [/styles\.css/] }`；
   * 少了那行，`?raw` 会被 vitest 桩成空串，这里就恒红（红的含义是「前提没了」，不是断言写错）。
   */
  it('哨兵：查找面板不能盖住右键菜单——.editor-host 必须自带层叠上下文', () => {
    const block = /\.editor-host\s*\{[^}]*\}/.exec(stylesSource)?.[0] ?? ''
    expect(block).toContain('z-index: 0')
  })
})
