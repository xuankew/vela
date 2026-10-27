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
import { createWorkspace, MAX_PANES } from './workspace'
// ⚠️ `?raw` 而不是 `node:fs`：tsconfig 的 `types` 只有 `vite/client`，没有 node 的类型
// （与 `md/render.test.ts` 同一路子）。拿到的是**源码文本**，不是生效的样式——
// jsdom 不做布局，叠放只能靠人眼在真窗口里看，这里钉的是它的前提
import stylesSource from '../styles.css?raw'

let container: HTMLDivElement
let dispose: () => void
/** `onError` 收到的话。App 那边把它接到窗口顶部的提示条上，这里只需要看它说了什么 */
let errors: string[]

/**
 * 挂**一条**标签条（第 `paneIndex` 块分屏的那一条）。
 *
 * M4-R 起每屏一条，于是「标签条」这个概念必须带一个 paneId：`paneId` 是普通 prop
 * 而不是响应式的，所以要先 `split` 再挂第二条（见 `mountPair`）
 */
function mount(ws: ReturnType<typeof createWorkspace>, paneIndex = 0) {
  errors = []
  const paneId = ws.panes()[paneIndex]!.id
  dispose = render(() => <TabStrip workspace={ws} paneId={paneId} onError={(text) => errors.push(text)} />, container)
  return ws
}

/**
 * 两块分屏各挂一条：跨屏拖拽与「每屏只展示自己的标签」这两件事要同时看得见两条。
 *
 * ⚠️ 传进来的 `ws` **必须已经有两块分屏**：`paneId` 是普通 prop，挂上去之后再 `split`
 * 出来的那一屏不会有条（真窗口里那一条由 App 的 `<For each={ws.panes()}>` 建）
 */
function mountPair(ws: ReturnType<typeof createWorkspace>) {
  errors = []
  const [a, b] = [ws.panes()[0]!.id, ws.panes()[1]!.id]
  dispose = render(
    () => (
      <>
        <TabStrip workspace={ws} paneId={a} onError={(text) => errors.push(text)} />
        <TabStrip workspace={ws} paneId={b} onError={(text) => errors.push(text)} />
      </>
    ),
    container,
  )
  return ws
}

/** 第 n 条标签条 */
function strip(n = 0): HTMLElement {
  const el = container.querySelectorAll<HTMLElement>('.tab-strip')[n]
  if (!el) throw new Error(`找不到第 ${n} 条标签条`)
  return el
}

/**
 * 第 n 条标签条里的标签。
 *
 * ⚠️ 必须从**那一条**里查，不能从 `container` 里查：两条标签条同时在 DOM 里的时候，
 * `container.querySelectorAll('.tab')` 会把两屏的标签混成一排，
 * 于是「每屏只展示自己的标签」这条断言会自己骗自己
 */
function tabs(n = 0): HTMLElement[] {
  return [...strip(n).querySelectorAll<HTMLElement>('.tab')]
}

function names(n = 0): string[] {
  return tabs(n).map((t) => t.querySelector('.tab-name')?.textContent ?? '')
}

function newTabButton(n = 0): HTMLButtonElement {
  const el = strip(n).querySelector<HTMLButtonElement>('.tab-new')
  if (!el) throw new Error('找不到新建标签按钮')
  return el
}

function fire(el: Element, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event
}

/** 同一屏里重排：dragstart 在源上，dragover + drop 在目标上 */
function drag(from: number, to: number, pane = 0): Event {
  fire(tabs(pane)[from]!, 'dragstart')
  fire(tabs(pane)[to]!, 'dragover')
  return fire(tabs(pane)[to]!, 'drop')
}

/**
 * 跨屏搬：源与目标在**不同的组件实例**里。
 *
 * 🔴 这正是 `draggedTabId` 必须是模块级变量的原因：放在组件内的话，目标那一屏的
 * `onDrop` 读到的永远是它自己那一份 `null`，手势就成了「拖过去什么也没发生」
 */
function dragAcross(fromPane: number, fromIndex: number, toPane: number, toIndex: number | 'blank'): Event {
  fire(tabs(fromPane)[fromIndex]!, 'dragstart')
  const target = toIndex === 'blank' ? strip(toPane) : tabs(toPane)[toIndex]!
  fire(target, 'dragover')
  return fire(target, 'drop')
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

describe('每屏一条标签条（M4-R）', () => {
  /**
   * 2026-10-27 用户报的现场就是这一条：分屏之后右边那一屏头顶上什么标签都没有。
   * 旧模型只有一条全局标签条，`.shown` 那个类是「它显示在别的分屏里」的唯一提示，
   * 而右边那一屏自己有哪些标签、正看着哪一个，界面上无处可看
   */
  it('两块分屏 = 两条标签条，各自只显示自己那一屏的标签', () => {
    const ws = createWorkspace()
    ws.newTab() // 左边那屏两个标签
    ws.split('row') // 右边那屏一个新空标签
    mountPair(ws)

    expect(container.querySelectorAll('.tab-strip')).toHaveLength(2)
    expect(names(0)).toEqual(['空文档', '空文档'])
    expect(names(1)).toEqual(['空文档'])
    // 每条标签条各有**一个** active：自己那一屏正在显示的那一个
    expect(tabs(0).map((t) => t.classList.contains('active'))).toEqual([false, true])
    expect(tabs(1).map((t) => t.classList.contains('active'))).toEqual([true])
    // aria-selected 在每条标签条内部自洽：读屏的人听到的是「这一屏里选中的是哪一个」
    expect(tabs(0).map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it('换焦点不改每条标签条显示的标签，只改哪一条是聚焦的（那条由 CSS 弱显）', () => {
    const ws = createWorkspace()
    ws.split('row')
    mountPair(ws)
    const [leftTab, rightTab] = [ws.panes()[0]!.activeTabId(), ws.panes()[1]!.activeTabId()]

    ws.focusPane(ws.panes()[0]!.id)

    // 两条标签条的内容一个字都没变——「哪一屏是活动的」不靠标签条上的类来表达，
    // 而靠 `.editor-host:not(.focused) .tab.active` 把没聚焦那一屏的活动标签弱显一档
    expect(ws.panes()[0]!.activeTabId()).toBe(leftTab)
    expect(ws.panes()[1]!.activeTabId()).toBe(rightTab)
    expect(tabs(0)[0]!.classList.contains('active')).toBe(true)
    expect(tabs(1)[0]!.classList.contains('active')).toBe(true)
  })

  it('哨兵：没聚焦那一屏的活动标签弱显一档——不然用户看不出焦点在哪一屏', () => {
    // `.shown` 那个类随着「每屏一条标签条」一起删掉了：它表达的是「这个标签显示在
    // 别的分屏里」，而现在别的分屏有它自己的标签条。可焦点总得看得出来，
    // 于是换成「没聚焦那一屏的活动标签弱一档」。jsdom 不做布局、测试也不加载
    // `styles.css`，能钉的只有源码里那条规则（与下面 z-index 那条哨兵同一路子）
    expect(stylesSource).toMatch(/\.editor-host:not\(\.focused\)\s+\.tab\.active\s*\{/)
  })

  it('点另一屏的标签是把焦点交给那一屏，不是把它搬过来', () => {
    const ws = createWorkspace()
    ws.split('row')
    mountPair(ws)
    const left = ws.panes()[0]!
    const rightTab = ws.tabs()[1]!
    ws.focusPane(left.id)

    tabs(1)[0]!.click()

    expect(ws.focusedPaneId()).toBe(ws.panes()[1]!.id)
    expect(ws.activeTab()).toBe(rightTab)
    // 左边那一屏还显示着它自己的标签：搬走会让它空掉（不变量 1）
    expect(left.activeTabId()).toBe(ws.tabs()[0]!.id)
    expect(left.tabs()).toHaveLength(1)
  })

  it('合并掉一块分屏之后，那一条标签条空了（分屏没了它也就没了）', () => {
    const ws = createWorkspace()
    ws.split('row')
    mountPair(ws)

    ws.mergePane(ws.panes()[1]!.id)

    // 标签一个都没少：合并是版面收拢，不是关文档
    expect(ws.tabs()).toHaveLength(2)
    expect(names(0)).toEqual(['空文档', '空文档'])
    // 第二条标签条所属的分屏已经不在了。`<For>` 会把它卸载，而卸载前的那一次渲染
    // 读到的是 `undefined`——组件必须自己兜住（`pane()?.`），否则这里会抛
    expect(tabs(1)).toHaveLength(0)
  })

  it('关掉一块分屏则连它那一排标签一起没了——「关闭就是关掉了」', async () => {
    const ws = createWorkspace()
    ws.split('row')
    mountPair(ws)

    await ws.closePane(ws.panes()[1]!.id)

    expect(ws.tabs()).toHaveLength(1)
    expect(names(0)).toEqual(['空文档'])
    expect(tabs(0)[0]!.classList.contains('active')).toBe(true)
    expect(tabs(1)).toHaveLength(0)
  })

  it('「+」与双击空白处都只作用在自己那一屏', () => {
    const ws = createWorkspace()
    ws.split('row') // 聚焦在右边那屏
    mountPair(ws)

    newTabButton(0).click()
    expect(ws.panes()[0]!.tabs()).toHaveLength(2)
    expect(ws.panes()[1]!.tabs()).toHaveLength(1)
    // 新标签成了左边那屏显示着的那个，而**焦点不动**：用户点的是左边那屏的「+」，
    // 不是「把焦点搬过来」
    expect(ws.panes()[0]!.activeTabId()).toBe(ws.panes()[0]!.tabs()[1]!.id)
    expect(ws.focusedPaneId()).toBe(ws.panes()[1]!.id)

    strip(1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(ws.panes()[1]!.tabs()).toHaveLength(2)
    expect(ws.panes()[0]!.tabs()).toHaveLength(2)
  })

  it('右键标签条不往上冒：`.editor-host` 那一层的正文菜单不会跟着弹', () => {
    const ws = createWorkspace()
    // App 把「正文右键菜单」挂在 `.editor-host` 上，而标签条现在住在它**里面**。
    // 不拦的话右键一个标签会同时弹出两份菜单，而编辑器那一份的六个动作作用在正文上
    const reached: string[] = []
    const paneId = ws.panes()[0]!.id
    dispose = render(
      () => (
        <div class="editor-host" onContextMenu={() => reached.push('host')}>
          <TabStrip workspace={ws} paneId={paneId} onError={(text) => errors.push(text)} />
        </div>
      ),
      container,
    )

    const onBlank = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    strip().dispatchEvent(onBlank)
    const onTab = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 12 })
    tabs()[0]!.dispatchEvent(onTab)

    expect(onBlank.defaultPrevented).toBe(true)
    expect(onTab.defaultPrevented).toBe(true)
    // 🔴 外层那一份必须写成 JSX 里的 `onContextMenu` 而不是 `container.addEventListener`：
    // Solid 把 `contextmenu` 收进了委托事件表，`stopPropagation` 拦住的是**委托链**，
    // 而原生冒泡早在事件到 document 之前就走过 container 了——挂 addEventListener 的话
    // 这条断言恒红，红的原因与被测的那件事无关
    expect(reached).toEqual([])
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

describe('跨屏拖拽（M4-R）', () => {
  /**
   * 用户要的第三条：「两边的文件可以拖动到对方屏幕中，但是屏幕上面要展示各自的标签页」。
   *
   * ⚠️ jsdom 里这些是**合成事件**：`dragstart`/`dragover`/`drop` 三下都是手派的，
   * 而真窗口里那三下由系统的拖拽会话驱动（还带 dataTransfer、自动滚动、拖出窗口取消）。
   * 这里钉的是接线（哪个 handler 调到哪个 workspace 方法），真手势要在真窗口里看
   */
  it('放到另一屏的空白处 = 搬进那一屏的末尾', () => {
    const ws = createWorkspace()
    const a = ws.activeTab()
    ws.newTab()
    const b = ws.activeTab()
    ws.split('row')
    const c = ws.activeTab()
    mountPair(ws)
    expect(names(0)).toEqual(['空文档', '空文档'])

    dragAcross(0, 0, 1, 'blank')

    // 搬过去的是**同一个标签**，不是复制一份：左边少一格、右边多一格，总数不变
    expect(ws.tabs()).toHaveLength(3)
    expect(
      ws
        .panes()[0]!
        .tabs()
        .map((t) => t.id),
    ).toEqual([b.id])
    expect(
      ws
        .panes()[1]!
        .tabs()
        .map((t) => t.id),
    ).toEqual([c.id, a.id])
    expect(names(0)).toEqual(['空文档'])
    expect(names(1)).toEqual(['空文档', '空文档'])
    // 焦点跟着搬过去的标签走：用户把它扔进那一屏，下一步就是要在那儿打字
    expect(ws.focusedPaneId()).toBe(ws.panes()[1]!.id)
    expect(ws.activeTab()).toBe(a)
    expect(tabs(1)[1]!.classList.contains('active')).toBe(true)
  })

  it('放到另一屏的某个标签上 = 搬进那一屏、落在被压住的那一格', () => {
    const ws = createWorkspace()
    const a = ws.activeTab()
    ws.split('row')
    ws.newTab() // 右边那屏两格
    const target = ws.panes()[1]!
    const right = target.tabs().map((t) => t.id)
    mountPair(ws)

    dragAcross(0, 0, 1, 0)

    // ⚠️ 拿**分屏对象**而不是 `ws.panes()[1]`：左边那屏唯一的标签被搬走之后就空了，
    // 而空屏会被收掉（`detachFromPane` 的 `'close'`），下标于是整体前移一位
    expect(target.tabs().map((t) => t.id)).toEqual([a.id, right[0]!, right[1]!])
    expect(target.activeTabId()).toBe(a.id)
  })

  it('把一屏里唯一的标签拖走：那一屏跟着收掉，它的标签条也就空了', () => {
    const ws = createWorkspace()
    const a = ws.activeTab()
    ws.split('row')
    const survivor = ws.panes()[1]!
    mountPair(ws)

    dragAcross(0, 0, 1, 'blank')

    expect(ws.panes()).toHaveLength(1)
    expect(ws.panes()[0]!.id).toBe(survivor.id)
    expect(ws.tabs().map((t) => t.id)).toEqual([survivor.tabs()[0]!.id, a.id])
    // 第一条标签条所属的分屏没了：真窗口里 `<For>` 会把它整个卸载，而卸载前的那一次
    // 渲染读到的是 `undefined`——组件必须自己兜住（`ownTabs()` 回空数组），否则这里会抛
    expect(tabs(0)).toHaveLength(0)
    expect(names(1)).toEqual(['空文档', '空文档'])
    expect(ws.focusedPaneId()).toBe(survivor.id)
    expect(ws.activeTab()).toBe(a)
  })

  it('dragover 在标签条空白处也被 preventDefault——不然放到空白处 drop 压根不触发', () => {
    const ws = createWorkspace()
    ws.split('row')
    mountPair(ws)
    fire(tabs(0)[0]!, 'dragstart')
    expect(fire(strip(1), 'dragover').defaultPrevented).toBe(true)
  })

  it('落到某个标签上时不会再冒到标签条那一份：落点不会被改成「末尾」', () => {
    const ws = createWorkspace()
    const a = ws.activeTab()
    ws.split('row')
    ws.newTab()
    const target = ws.panes()[1]!
    const right = target.tabs().map((t) => t.id)
    mountPair(ws)

    const e = dragAcross(0, 0, 1, 0)

    // 🔴 标签自己的 `onDrop` 必须 `stopPropagation()`：不拦的话同一次 drop 还会走到
    // 标签条那一份上去，于是「放到第一格」变成「搬过来又挪到末尾」——落点被悄悄改掉，
    // 而用户看到的是标签总是落在最后
    expect(e.defaultPrevented).toBe(true)
    expect(target.tabs().map((t) => t.id)).toEqual([a.id, right[0]!, right[1]!])
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

  it('右键一个打开了文件的标签 → 六项：所在目录、分屏三项、关闭两项', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/Users/x/notes/win.txt')

    const e = rightClick(tabs()[0]!)

    // 拦下来是必须的：不拦的话 macOS 会在我们的菜单旁边再弹一个原生的，两个叠在一起
    expect(e.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    expect(menuItems()).toEqual(['打开文件所在目录', '右分屏', '下分屏', '关闭分屏', '关闭其它标签', '关闭所有标签'])
  })

  it('选「右分屏」→ 把活动标签搬进新分屏，原来那块改显示右邻居', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/repo/a.txt')
    await ws.openAt('/repo/b.txt')
    expect(names()).toEqual(['a.txt', 'b.txt'])

    rightClick(tabs()[1]!) // b 是活动的那个
    item('右分屏').click()

    expect(ws.panes()).toHaveLength(2)
    expect(ws.direction()).toBe('row')
    // 搬过去的是**同一个标签**（不是复制一份）：焦点跟着它到新分屏上
    expect(ws.activeTab().doc.name()).toBe('b.txt')
    // 原来那一屏改显示右邻居 a——⛔ 不是「两块分屏显示同一个标签」，那会让撤销历史分叉
    expect(ws.panes()[0]!.activeTabId()).toBe(ws.tabs()[0]!.id)
    expect(ws.panes()[1]!.activeTabId()).toBe(ws.tabs()[1]!.id)
    // 标签总数一个都没多：搬走 + 原地换一个，而不是新开一份。
    // ⚠️ 这一条只挂了左边那一条标签条，所以看到的只有留在左屏的 a——b 在右边那条上，
    // 而它没被渲染。要看两条并排的效果去「每屏一条标签条」那一组
    expect(ws.tabs()).toHaveLength(2)
    expect(names()).toEqual(['a.txt'])
    expect(menu()).toBeNull()
  })

  it('右键的那一屏只有这一个标签时，「右分屏」把它搬走、原地补一个空标签', () => {
    const ws = mount(createWorkspace())
    ws.split('row') // 第二块分屏装一个新空标签
    const first = ws.panes()[0]!.tabs()[0]!
    const second = ws.panes()[1]!.tabs()[0]!

    rightClick(tabs()[0]!)
    item('右分屏').click()

    expect(ws.panes()).toHaveLength(3)
    // 搬进新分屏的是它本人，焦点也跟过去
    expect(
      ws
        .panes()[2]!
        .tabs()
        .map((t) => t.id),
    ).toEqual([first.id])
    expect(ws.panes()[2]!.activeTabId()).toBe(first.id)
    expect(ws.activeTab()).toBe(first)
    // 原来那一屏（左边）空了，而「零标签的一屏」不允许存在（不变量 1），于是补一个空标签。
    // ⛔ 不是把右边那一屏的标签抢过来：一屏只能显示一屏自己的标签
    expect(ws.tabs()).toHaveLength(3)
    expect(ws.panes()[0]!.tabs()).toHaveLength(1)
    expect(ws.panes()[0]!.tabs()[0]!.id).not.toBe(first.id)
    expect(ws.panes()[0]!.activeTabId()).toBe(ws.panes()[0]!.tabs()[0]!.id)
    // 中间那一屏与它的标签一动不动
    expect(
      ws
        .panes()[1]!
        .tabs()
        .map((t) => t.id),
    ).toEqual([second.id])
    expect(ws.panes()[1]!.activeTabId()).toBe(second.id)
  })

  it('选「下分屏」→ 同一个搬法，只是整排改成竖着', () => {
    const ws = mount(createWorkspace())
    rightClick(tabs()[0]!)

    item('下分屏').click()

    expect(ws.panes()).toHaveLength(2)
    expect(ws.direction()).toBe('column')
  })

  it('选「关闭分屏」→ 菜单所在那一屏与它自己的标签一起没了，别屏一个不碰', async () => {
    const ws = createWorkspace()
    await ws.openAt('/repo/a.txt') // 左屏
    ws.split('row') // 焦点跟着到新分屏上，后面两个都落在右屏
    mountPair(ws)
    await ws.openAt('/repo/b.txt')
    await ws.openAt('/repo/c.txt')
    expect(names(0)).toEqual(['a.txt'])
    expect(names(1)).toEqual(['b.txt', 'c.txt'])

    // 🔴 关的是**这一条标签条所属的那一屏**，不是「右键的那个标签」：同屏里的 c 也一起走。
    // 与「关闭其它标签」的区别就落在这里，两项挨着放容易被读成一回事
    rightClick(tabs(1)[0]!)
    item('关闭分屏').click()
    await flush()

    expect(ws.panes()).toHaveLength(1)
    expect(names(0)).toEqual(['a.txt'])
    // 真窗口里那一条标签条会被 App 的 `<For each={ws.panes()}>` 整个卸载；这个夹具是自己
    // 挂的两条，所以它还在 DOM 里，只是空了——⛔ 别去数 `.tab-strip` 的个数，那数的是夹具
    expect(tabs(1)).toHaveLength(0)
    expect(menu()).toBeNull()
  })

  it('做不成的分屏项置灰而不是摘掉：只剩一块时关不了，到上限时加不了', () => {
    const ws = mount(createWorkspace())
    rightClick(tabs()[0]!)
    // 只有一块分屏：「关闭分屏」是空操作（`closePane` 的第一道守卫），灰掉比点了不说话好
    expect(item('关闭分屏').disabled).toBe(true)
    expect(item('右分屏').disabled).toBe(false)

    for (let i = 1; i < MAX_PANES; i++) ws.split('row')
    rightClick(tabs()[0]!)
    expect(item('右分屏').disabled).toBe(true)
    expect(item('下分屏').disabled).toBe(true)
    expect(item('关闭分屏').disabled).toBe(false)
  })

  it('右键的是同屏里的后台标签时，「关闭分屏」照样可用——它关的是整屏，不是这一个标签', () => {
    const ws = mount(createWorkspace())
    ws.split('row') // 两屏，焦点在右边那一屏
    ws.newTab(ws.panes()[0]!.id) // 左屏多一个后台标签；焦点不动
    expect(names()).toHaveLength(2)

    // ⛔ 别把这一项写成「右键的不是显示中的标签就灰掉」：菜单是从**左屏那一条**弹出来的，
    // `closePane` 关的是那一屏，与右键的是不是它的活动标签无关
    rightClick(tabs()[1]!)
    expect(item('关闭分屏').disabled).toBe(false)
    expect(item('关闭其它标签').disabled).toBe(false)
  })

  it('选「打开文件所在目录」→ 递出去的是这个标签的完整路径，菜单随即关掉', async () => {
    const ws = mount(createWorkspace())
    await ws.openAt('/Users/x/notes/win.txt')
    rightClick(tabs()[0]!)

    item('打开文件所在目录').click()

    expect(project.revealFile).toHaveBeenCalledWith('/Users/x/notes/win.txt')
    expect(menu()).toBeNull()
  })

  it('右键未命名文档也弹菜单：少了「打开所在目录」，其余五项照常可用', () => {
    mount(createWorkspace())

    // 原来这一档连菜单都不弹——那时菜单里只有「打开文件所在目录」一项，而它对未命名文档
    // 无从谈起。多了分屏与关闭那五项之后这个前提没了：它们与这个文档在不在磁盘上无关
    const e = rightClick(tabs()[0]!)
    expect(e.defaultPrevented).toBe(true)
    expect(menuItems()).toEqual(['右分屏', '下分屏', '关闭分屏', '关闭其它标签', '关闭所有标签'])
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

  it('选「关闭所有标签」只清这一屏：别屏的一个都不碰', async () => {
    const ws = createWorkspace()
    await ws.openAt('/repo/a.txt') // 左屏
    ws.split('row') // 焦点跟着到新分屏上，后面两个都落在右屏
    mountPair(ws)
    await ws.openAt('/repo/b.txt')
    await ws.openAt('/repo/c.txt')
    expect(names(0)).toEqual(['a.txt'])
    expect(names(1)).toEqual(['b.txt', 'c.txt'])

    rightClick(tabs(1)[0]!)
    item('关闭所有标签').click()
    await flush()

    // 「所有」= 这一屏的所有。清空之后那一屏自己也没了（与 VS Code 的
    // 「关闭组内所有编辑器」同一条：还剩别的组就把这组收掉），左边一动不动
    expect(ws.panes()).toHaveLength(1)
    expect(names(0)).toEqual(['a.txt'])
    expect(tabs(1)).toHaveLength(0)
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
