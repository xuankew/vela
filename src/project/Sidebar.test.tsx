// @vitest-environment jsdom
import { createRoot } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 侧边栏的测试：DOM 与 `createProjectTree` 之间的接线。
 *
 * 窗口算术、方向键落点与右键菜单的项目规则（哪些行给哪几项）在 `./tree.test.ts` 里
 * 已经钉过了，读盘时机与写操作改状态的那一半在 `./store.test.ts` 里钉过了。这里测四件事：
 * **渲染出来的东西对不对**、**点对了地方会不会调到对的方法**、
 * **虚拟滚动是不是真的只渲染看得见的那几十行、并且滚动时复用 DOM**、
 * 以及**右键菜单的三条关闭路径与名称对话框的「回车提交 / Escape 取消 / 失败留在原地」**。
 *
 * 虚拟滚动那条是整段设计的承重墙——「十万行的仓库滚起来不卡」全靠 `<For>` 靠引用相等
 * 复用节点。它坏掉的方式不报错：滚动时整棵子树被重建，帧率掉到个位数，而所有功能测试照样全绿。
 *
 * ⚠️ 有些东西这里钉不住，都得在真实窗口里看：`open -R` / `pbcopy` / 移到废纸篓背后的
 * 系统调用（jsdom 里没有 Tauri 运行时，桩只能验「调了没、参数对不对」），
 * 以及菜单贴边时「减去自己宽度」那半个 clamp（`getBoundingClientRect()` 在 jsdom 里全是 0）。
 */

/**
 * ⚠️ 那五个文件操作封装一个都不能少：`store.ts` 是从这个模块**按名字**导入它们的，
 * 少一个就在被调用那一刻变成 `undefined is not a function`——而 vitest 对
 * 「工厂里没这个导出」是不报错的（要等到真去访问那一项才炸），所以漏掉的话
 * 现有用例照样全绿，坑留给下一条用例。
 */
const { ipc, dialog } = vi.hoisted(() => ({
  ipc: {
    listDir: vi.fn(),
    createEntry: vi.fn(),
    renameEntry: vi.fn(),
    trashEntry: vi.fn(),
    revealEntry: vi.fn(),
    copyEntryPath: vi.fn(),
    describeTreeError: (err: unknown) => `读不出来：${JSON.stringify(err)}`,
  },
  dialog: { open: vi.fn() },
}))

vi.mock('../ipc/project', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)

import type { DirEntry, DirListing, EntryKind } from '../ipc/project'
import { Sidebar, type TreeNotice } from './Sidebar'
import { createProjectTree, type ProjectTree } from './store'
import { childRel, OVERSCAN, parentRel, ROW_HEIGHT } from './tree'

/**
 * ⚠️ 与 `store.test.ts` 同一条豁免、同一个理由：Tauri 的 `invoke` 在 Rust 侧返回 `Err` 时，
 * 抛给前端的就是**序列化后的那个对象**，不是 `Error` 实例。桩要是为了满足 lint 改成
 * `new Error(...)`，这组测试就不再描述真实行为了。
 */
function rejected<T>(payload: unknown): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 见上
  return Promise.reject(payload)
}

function f(rel: string, isDir = false): DirEntry {
  return { name: rel.slice(rel.lastIndexOf('/') + 1), rel, path: `/repo/${rel}`, isDir }
}

const FS: Record<string, DirEntry[]> = {
  '': [f('src', true), f('README.md'), f('docs', true)],
  src: [f('src/a.ts'), f('src/b.ts')],
  docs: [f('docs/intro.md')],
}

/**
 * 够长的树，专门给虚拟滚动用：44 行摊在 `src` 下面，
 * 滚到中间时窗口两头都还在树里，才谈得上「只渲染看得见的那一段」。
 */
function bigFs(): Record<string, DirEntry[]> {
  const kids = Array.from({ length: 40 }, (_, i) => f(`src/f${String(i).padStart(2, '0')}.ts`))
  return {
    '': [f('src', true), f('README.md'), f('docs', true)],
    src: kids,
    docs: [f('docs/intro.md')],
  }
}

const calls: Array<[string, string]> = []

/**
 * 当前装着的那份假文件系统。写操作的桩要往里面塞条目、删条目，
 * 之后 store 重读父层时才反映得出「刚才那一下真的改了盘」。
 */
let activeFs: Record<string, DirEntry[]> = {}

function installFs(fs: Record<string, DirEntry[]> = FS) {
  activeFs = fs
  calls.length = 0
  ipc.listDir.mockImplementation((root: string, rel: string): Promise<DirListing> => {
    calls.push([root, rel])
    const entries = fs[rel]
    if (!entries) return rejected<DirListing>({ kind: 'not_found', path: `${root}/${rel}` })
    return Promise.resolve({ rel, entries })
  })
}

/**
 * 装一份深拷贝。
 *
 * 写操作的用例会改这张表，直接改模块级的 `FS` 会漏给后面每一条——漏出来的失败方式是
 * 一条与写操作毫无关系的用例突然多出一行「新建.md」，看起来像虚拟化坏了。
 */
function copyFs(fs: Record<string, DirEntry[]> = FS): Record<string, DirEntry[]> {
  return structuredClone(fs)
}

/** 那一层里 `rel` 对应的那一条。找不到就是 undefined */
function entryAt(rel: string): DirEntry | undefined {
  return activeFs[parentRel(rel)]?.find((e) => e.rel === rel)
}

/**
 * 五个写操作的默认桩：照着 Rust 侧的样子改 `activeFs`，然后 resolve。
 *
 * 桩要是只会 `resolve()` 而不改这张表，用例断言的就变成桩自己的样子——
 * 「新建之后树里多出一行」会失败，而失败的原因在测试里而不在产品里。
 */
function stubOps(): void {
  ipc.createEntry.mockImplementation((_root: string, rel: string, kind: EntryKind): Promise<DirEntry> => {
    const made: DirEntry = { ...f(rel), isDir: kind === 'dir' }
    const parent = parentRel(rel)
    activeFs[parent] = [...(activeFs[parent] ?? []), made]
    // 新目录自己那一层也要有条目：`create` 会把它标成摊开，摊开而没有缓存的话
    // 那一行既不显示内容也不转圈
    if (kind === 'dir') activeFs[rel] = []
    return Promise.resolve(made)
  })

  ipc.renameEntry.mockImplementation((_root: string, rel: string, newName: string): Promise<DirEntry> => {
    const isDir = entryAt(rel)?.isDir ?? false
    const made: DirEntry = { ...f(childRel(parentRel(rel), newName)), isDir }
    activeFs[parentRel(rel)] = (activeFs[parentRel(rel)] ?? []).map((e) => (e.rel === rel ? made : e))
    if (isDir) {
      // 整棵子树一起搬：`fs` 的键、以及里面每条 `DirEntry` 的 rel 与 path。
      // 只搬键是不够的——`flattenRows` 拿 `entry.rel` 当行的 rel，
      // 留着旧值的话断言就是在验桩自己的 bug
      const prefix = `${rel}/`
      for (const key of Object.keys(activeFs)) {
        if (key !== rel && !key.startsWith(prefix)) continue
        const entries = activeFs[key]!
        delete activeFs[key]
        activeFs[`${made.rel}${key.slice(rel.length)}`] = entries.map((e) => {
          const nextRel = `${made.rel}${e.rel.slice(rel.length)}`
          return { ...e, rel: nextRel, path: `/repo/${nextRel}` }
        })
      }
    }
    return Promise.resolve(made)
  })

  ipc.trashEntry.mockImplementation((_root: string, rel: string): Promise<void> => {
    activeFs[parentRel(rel)] = (activeFs[parentRel(rel)] ?? []).filter((e) => e.rel !== rel)
    const prefix = `${rel}/`
    for (const key of Object.keys(activeFs)) {
      if (key === rel || key.startsWith(prefix)) delete activeFs[key]
    }
    return Promise.resolve()
  })

  ipc.revealEntry.mockResolvedValue(undefined)
  ipc.copyEntryPath.mockResolvedValue(undefined)
}

/** 点击与 `run(expand)` 都是**故意**不等异步的，要断言后果得先让微任务与宏任务各跑一轮 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let container: HTMLDivElement
let tree: ProjectTree
let opened: string[]
/**
 * 侧边栏交上来的每一句话（M2-B-5：右键菜单的结果）。
 * 真机上它们落在窗口顶部的提示条里，见 `App.tsx` 的 `treeNotice`
 */
let notices: TreeNotice[]
/** `createProjectTree` 里有两个 `createMemo`；不在 root 里建，它们永远不会被释放 */
let disposeTree: (() => void) | undefined
let disposeRender: (() => void) | undefined

function mount(fs: Record<string, DirEntry[]> = FS): ProjectTree {
  installFs(fs)
  opened = []
  notices = []
  disposeTree = createRoot((teardown) => {
    tree = createProjectTree({ openFile: async (path) => void opened.push(path) })
    return teardown
  })
  disposeRender = render(() => <Sidebar tree={tree} onNotice={(n) => notices.push(n)} />, container)
  return tree
}

/** 打开 `/repo` 并把根那一层读回来 */
async function openRepo(t = tree): Promise<void> {
  await t.openAt('/repo')
  await flush()
}

function aside(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.sidebar')
  if (!el) throw new Error('找不到 .sidebar')
  return el
}

function scrollEl(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.tree-scroll')
  if (!el) throw new Error('找不到 .tree-scroll')
  return el
}

function spacer(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.tree-spacer')
  if (!el) throw new Error('找不到 .tree-spacer')
  return el
}

function windowEl(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.tree-window')
  if (!el) throw new Error('找不到 .tree-window')
  return el
}

function rowEls(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.tree-row')]
}

function rowNames(): string[] {
  return rowEls().map((el) => el.querySelector('.tree-name')?.textContent ?? '')
}

/**
 * 树里**全部**行的名字，与 DOM 无关。
 *
 * 虚拟滚动下 DOM 只是其中一段——jsdom 里 `clientHeight` 恒为 0，窗口只有 `OVERSCAN` 行。
 * 所以「树里有没有这一行」必须问 store，问 DOM 会因为窗口截断而假失败。
 */
function names(): string[] {
  return tree.rows().map((r) => r.name)
}

/** 按 rel 找那一行的 DOM。只找渲染出来的（虚拟滚动下没渲染的就该是 undefined） */
function rowByRel(rel: string): HTMLElement | undefined {
  // 根行的 rel 是空字符串，而它的 path 就是 rootPath 本身——拼上斜杠会得到 `/repo/`
  const path = rel === '' ? '/repo' : `/repo/${rel}`
  return rowEls().find((el) => el.title === path)
}

function headButton(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>('.sidebar-head button')].find(
    (b) => b.textContent === text,
  )
  if (!el) throw new Error(`找不到头部按钮「${text}」`)
  return el
}

/* ---------- 右键菜单 ---------- */

/** 弹着的菜单，没有就是 null。断言「菜单关了」要用这个，不能用会抛的那个 */
function maybeMenu(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.tree-menu')
}

function menuEl(): HTMLElement {
  const el = maybeMenu()
  if (!el) throw new Error('找不到 .tree-menu（菜单没弹出来）')
  return el
}

function menuItems(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.tree-menu-item')]
}

function menuLabels(): string[] {
  return menuItems().map((b) => b.textContent ?? '')
}

function menuItem(label: string): HTMLButtonElement {
  const el = menuItems().find((b) => b.textContent === label)
  if (!el) throw new Error(`菜单里没有「${label}」这一项，实际是 ${JSON.stringify(menuLabels())}`)
  return el
}

/**
 * 在一行上右键。
 *
 * `bubbles` 与 `cancelable` 都是必需的：`contextmenu` 在 Solid 的委托名单里
 * （见 `solid-js/web` 的 `DelegatedEvents`），不冒泡就到不了行上的 `onContextMenu`；
 * 不 cancelable 的话 `preventDefault()` 是空操作，断言不出「原生菜单被拦掉了」。
 * `clientX/clientY` 是菜单的定位来源——不给的话就断不出「弹在光标那儿」。
 */
function rightClick(rel: string, x = 40, y = 60): MouseEvent {
  const row = rowByRel(rel)
  if (!row) throw new Error(`找不到 rel='${rel}' 的那一行（虚拟滚动下它可能没被渲染）`)
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
  row.dispatchEvent(e)
  return e
}

/** 在某个元素上按下鼠标。`TreeMenu` 的「点外面就关」监听在 document 的**捕获**阶段 */
function mouseDown(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

/** 点菜单里的一项。项是靠 `onClick` 触发的，所以直接 `.click()`，中间那次 mousedown 不存在 */
async function pickItem(label: string): Promise<void> {
  menuItem(label).click()
  await flush()
}

/**
 * 右键一行并把菜单弹出来。
 *
 * 中间那个 `flush()` 不是保险起见：菜单那两个「点外面就关 / Escape 就关」的监听器是在
 * `onMount` 里挂的，而 jsdom 下挂载与副作用的落地顺序不该被测试假定。
 */
async function openMenu(rel: string, x = 40, y = 60): Promise<MouseEvent> {
  const e = rightClick(rel, x, y)
  await flush()
  return e
}

/* ---------- 名称对话框 ---------- */

function maybeModal(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.modal')
}

function modalEl(): HTMLElement {
  const el = maybeModal()
  if (!el) throw new Error('找不到 .modal（对话框没弹出来）')
  return el
}

function modalTitle(): string {
  return modalEl().querySelector('.modal-title')?.textContent ?? ''
}

function modalInput(): HTMLInputElement {
  const el = modalEl().querySelector<HTMLInputElement>('.modal-input')
  if (!el) throw new Error('找不到 .modal-input')
  return el
}

function modalError(): string | null {
  return modalEl().querySelector('.modal-error')?.textContent ?? null
}

function submitButton(): HTMLButtonElement {
  const el = modalEl().querySelector<HTMLButtonElement>('.modal-actions .primary')
  if (!el) throw new Error('找不到提交按钮')
  return el
}

function cancelButton(): HTMLButtonElement {
  const el = [...modalEl().querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(
    (b) => b.textContent === '取消',
  )
  if (!el) throw new Error('找不到取消按钮')
  return el
}

/** 往输入框里打字。必须派发 `input`：Solid 的 `onInput` 读的是事件，不是赋值这个动作 */
function type(text: string): void {
  const el = modalInput()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 在输入框里按回车。走的是 `onKeyDown`，所以是键盘事件而不是 `submit()` */
function enter(): void {
  modalInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

/**
 * jsdom 没有布局引擎，`clientHeight` 恒为 0，`scrollTop` 的赋值也是空操作。
 * 两个都换成自己的读写口——虚拟滚动这组测试要的就是这两个数。
 */
function fakeBox(el: HTMLElement, height: number): void {
  let top = 0
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
    },
  })
}

/** 滚到某个位置并派发事件（`onScroll` 读的是 `currentTarget.scrollTop`） */
function scrollTo(top: number): void {
  const el = scrollEl()
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

/** onMount 时量过一次，之后只有 window resize 会重量——测试里就得走这条路 */
function resize(): void {
  window.dispatchEvent(new Event('resize'))
}

/**
 * 伪造可视区高度并让组件重量一次。
 *
 * 中间那个 `flush()` 不是保险起见：`resize` 的监听器是 `onMount` 里挂的，
 * 而 jsdom 下挂载与副作用的落地顺序不该被测试假定。先让副作用跑完再派发事件，
 * 这条测试才在描述「组件的行为」，而不是在描述「Solid 这一版恰好是同步的」。
 */
async function fakeViewport(height: number): Promise<void> {
  fakeBox(scrollEl(), height)
  await flush()
  resize()
}

/**
 * 按一个键并返回事件对象。`bubbles` 是必需的：Solid 把 keydown 挂在 document 上做委托，
 * 不冒泡就到不了处理器（`scroll` 不在委托名单里，所以 `scrollTo` 那边不用冒泡）。
 */
function key(k: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  scrollEl().dispatchEvent(e)
  return e
}

beforeEach(() => {
  ipc.listDir.mockReset()
  // 五个写操作的桩也一并清掉：某条用例为了测失败会 `mockRejectedValue`，
  // 不清的话下一条用例点开菜单就撞上一句莫名其妙的错误
  ipc.createEntry.mockReset()
  ipc.renameEntry.mockReset()
  ipc.trashEntry.mockReset()
  ipc.revealEntry.mockReset()
  ipc.copyEntryPath.mockReset()
  dialog.open.mockReset()
  opened = []
  notices = []
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  disposeRender?.()
  disposeRender = undefined
  disposeTree?.()
  disposeTree = undefined
  container.remove()
})

describe('空状态', () => {
  it('没有项目时只有一条「打开文件夹…」，一行树都没有', () => {
    mount()
    expect(container.querySelector('.sidebar-open')?.textContent).toBe('打开文件夹…')
    expect(container.querySelector('.sidebar-title')).toBeNull()
    expect(rowEls()).toHaveLength(0)
    expect(spacer().style.height).toBe('0px')
  })

  it('点「打开文件夹…」弹原生目录对话框，选中之后树就长出来了', async () => {
    mount()
    dialog.open.mockResolvedValue('/repo')

    container.querySelector<HTMLButtonElement>('.sidebar-open')!.click()
    await flush()

    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: true })
    expect(rowNames()).toEqual(['repo', 'src', 'README.md', 'docs'])
    expect(container.querySelector('.sidebar-title')?.textContent).toBe('repo')
  })

  it('对话框取消时树保持空的——用户什么都没选，不该凭空长出个根', async () => {
    mount()
    dialog.open.mockResolvedValue(null)

    container.querySelector<HTMLButtonElement>('.sidebar-open')!.click()
    await flush()

    expect(rowEls()).toHaveLength(0)
    expect(container.querySelector('.sidebar-open')).not.toBeNull()
  })
})

describe('渲染', () => {
  it('头部显示根目录的 basename，全路径挂在 title 上', async () => {
    mount()
    await openRepo()
    const title = container.querySelector<HTMLElement>('.sidebar-title')!
    expect(title.textContent).toBe('repo')
    expect(title.title).toBe('/repo')
  })

  it('根默认摊开，孩子的顺序原样透传——前端不重排', async () => {
    mount()
    await openRepo()
    // FS 里刻意把 README.md 夹在两个目录中间：前端要是自己排了一次序，
    // 它就会跑到 docs 后面去。「排一次序」意味着有两个真相，而真相在 Rust 那边
    expect(rowNames()).toEqual(['repo', 'src', 'README.md', 'docs'])
    expect(calls).toEqual([['/repo', '']])
  })

  it('缩进按 depth 递进，padding-left 写在行内样式上', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()
    // depth * 12 + 6：根行 6px，它的孩子 18px，孙辈 30px
    expect(rowByRel('')!.style.paddingLeft).toBe('6px')
    expect(rowByRel('src')!.style.paddingLeft).toBe('18px')
    expect(rowByRel('src/a.ts')!.style.paddingLeft).toBe('30px')
  })

  it('目录行有 twisty（摊开 ▾ / 收起 ▸），文件行是空占位', async () => {
    mount()
    await openRepo()
    expect(rowByRel('')!.querySelector('.tree-twisty')!.textContent).toBe('▾')
    expect(rowByRel('src')!.querySelector('.tree-twisty')!.textContent).toBe('▸')
    expect(rowByRel('README.md')!.querySelector('.tree-twisty')!.textContent).toBe('')
  })

  it('摊开一层之后箭头翻向，孩子出现', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()
    expect(rowByRel('src')!.querySelector('.tree-twisty')!.textContent).toBe('▾')
    expect(rowNames()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
  })

  it('aria：树容器 role=tree，每行 role=treeitem 并带层级与展开态', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    expect(scrollEl().getAttribute('role')).toBe('tree')
    expect(scrollEl().getAttribute('aria-label')).toBe('项目文件树')
    expect(scrollEl().getAttribute('tabindex')).toBe('0')

    expect(rowByRel('')!.getAttribute('aria-level')).toBe('1')
    expect(rowByRel('src')!.getAttribute('aria-level')).toBe('2')
    expect(rowByRel('src/a.ts')!.getAttribute('aria-level')).toBe('3')
    expect(rowByRel('src')!.getAttribute('aria-expanded')).toBe('true')
    expect(rowByRel('docs')!.getAttribute('aria-expanded')).toBe('false')
    // 文件不该报 aria-expanded：报了就等于告诉读屏的人「这里能展开」
    expect(rowByRel('README.md')!.hasAttribute('aria-expanded')).toBe(false)
  })

  it('⚠️ 行高由 ROW_HEIGHT 注入成 CSS 变量，样式表不许有第二个字面量', async () => {
    mount()
    await openRepo()
    // 这条钉的是「窗口算术用的那个数」与「CSS 画出来的那个高度」是同一个来源。
    // 两处各写一个 22px 的话，失败方式是行互相压住或者中间露缝——不报错，只是难看
    expect(aside().style.getPropertyValue('--vela-tree-row-height')).toBe(`${ROW_HEIGHT}px`)
  })

  it('每行的 title 挂全路径，选中行带 selected 类与 aria-selected', async () => {
    mount()
    await openRepo()
    expect(rowByRel('src/a.ts')).toBeUndefined() // 还没摊开
    await tree.toggle('src')
    await flush()

    tree.select('src/a.ts')
    expect(rowByRel('src/a.ts')!.title).toBe('/repo/src/a.ts')
    expect(rowByRel('src/a.ts')!.classList.contains('selected')).toBe(true)
    expect(rowByRel('src/a.ts')!.getAttribute('aria-selected')).toBe('true')
    expect(rowByRel('src')!.classList.contains('selected')).toBe(false)
    expect(rowByRel('src')!.getAttribute('aria-selected')).toBe('false')
  })

  it('读失败的那一层把错误文本挂在同一行里，不另起一行', async () => {
    mount({ '': [f('locked', true)] })
    await openRepo()
    // `locked` 不在假文件系统里，listDir 会以 not_found 拒绝
    await tree.toggle('locked')
    await flush()

    const row = rowByRel('locked')!
    expect(row.classList.contains('failed')).toBe(true)
    const note = row.querySelector('.tree-note.bad')
    expect(note?.textContent).toContain('not_found')
    // 关键约束：这一行仍然只有一个 .tree-name，多出一行就不再是 ROW_HEIGHT
    expect(row.querySelectorAll('.tree-name')).toHaveLength(1)
    expect(rowNames()).toEqual(['repo', 'locked'])
  })
})

describe('交互', () => {
  it('点收起的目录行把它摊开，读盘一次', async () => {
    mount()
    await openRepo()

    rowByRel('src')!.click()
    await flush()

    expect(calls.map((c) => c[1])).toEqual(['', 'src'])
    expect(rowNames()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
    expect(tree.selected()).toBe('src')
  })

  it('再点一次收起，且不重读——缓存命中', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    rowByRel('src')!.click()
    await flush()

    expect(rowNames()).toEqual(['repo', 'src', 'README.md', 'docs'])
    expect(calls.map((c) => c[1])).toEqual(['', 'src'])
  })

  it('点文件行把它打开，传的是 path 不是 rel', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    rowByRel('src/a.ts')!.click()
    await flush()

    expect(opened).toEqual(['/repo/src/a.ts'])
    // 点文件不该触发任何读盘
    expect(calls.map((c) => c[1])).toEqual(['', 'src'])
    expect(tree.selected()).toBe('src/a.ts')
  })

  it('点 ↻ 重读所有摊开的层', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    headButton('↻').click()
    await flush()

    expect(calls.map((c) => c[1])).toEqual(['', 'src', '', 'src'])
  })

  it('点 × 关掉根，回到空状态', async () => {
    mount()
    await openRepo()

    headButton('×').click()

    expect(rowEls()).toHaveLength(0)
    expect(container.querySelector('.sidebar-open')).not.toBeNull()
    expect(tree.root()).toBeNull()
  })
})

describe('键盘', () => {
  it('↓ / ↑ 移动选中，并且拦掉浏览器自己的滚动', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    // 没有选中时 ↓ 落到第一行
    expect(key('ArrowDown').defaultPrevented).toBe(true)
    expect(tree.selected()).toBe('')
    expect(key('ArrowDown').defaultPrevented).toBe(true)
    expect(tree.selected()).toBe('src')
    expect(key('ArrowDown').defaultPrevented).toBe(true)
    expect(tree.selected()).toBe('src/a.ts')
    expect(key('ArrowUp').defaultPrevented).toBe(true)
    expect(tree.selected()).toBe('src')
  })

  it('→ 在收起的目录上摊开它，在摊开的目录上移到第一个孩子', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    tree.select('docs')
    key('ArrowRight')
    await flush()
    expect(tree.selected()).toBe('docs')
    expect(names()).toContain('intro.md')

    tree.select('src')
    key('ArrowRight')
    // 已经摊开了：这一次是「进到第一个孩子」，不该再读盘
    expect(tree.selected()).toBe('src/a.ts')
    expect(calls.map((c) => c[1])).toEqual(['', 'src', 'docs'])
  })

  it('← 在摊开的目录上收起它，在文件上移到父目录', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    tree.select('src')
    key('ArrowLeft')
    expect(names()).toEqual(['repo', 'src', 'README.md', 'docs'])
    expect(tree.selected()).toBe('src')

    key('ArrowRight') // 重新摊开
    await flush()
    tree.select('src/b.ts')
    key('ArrowLeft')
    expect(tree.selected()).toBe('src')
  })

  it('← 在根行上把它收起，再按一次无处可去（none 不 preventDefault）', async () => {
    mount()
    await openRepo()

    tree.select('')
    expect(key('ArrowLeft').defaultPrevented).toBe(true)
    expect(names()).toEqual(['repo'])
    expect(key('ArrowLeft').defaultPrevented).toBe(false)
  })

  it('Enter 在文件上打开它，在目录上切换摊开', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    tree.select('src/a.ts')
    key('Enter')
    await flush()
    expect(opened).toEqual(['/repo/src/a.ts'])

    tree.select('docs')
    key('Enter')
    await flush()
    expect(names()).toContain('intro.md')
    key('Enter')
    expect(names()).not.toContain('intro.md')
  })

  it('Home / End 跳到首末行', async () => {
    mount()
    await openRepo()
    await tree.toggle('src')
    await flush()

    key('End')
    expect(tree.selected()).toBe('docs')
    key('Home')
    expect(tree.selected()).toBe('')
  })

  it('不是那七个键的一律放过：不 preventDefault，也不动选中', async () => {
    mount()
    await openRepo()
    tree.select('src')

    for (const k of ['a', 'Escape', 'Tab', 'PageDown', 'Backspace']) {
      expect(key(k).defaultPrevented, k).toBe(false)
    }
    expect(tree.selected()).toBe('src')
  })

  it('树是空的时候按键什么都不做（没有根，连第一行都没有）', () => {
    mount()
    expect(key('ArrowDown').defaultPrevented).toBe(false)
    expect(tree.selected()).toBeNull()
  })
})

describe('虚拟滚动', () => {
  /** 建一棵 44 行的大树并把 `src` 摊开 */
  async function mountBig(): Promise<void> {
    mount(bigFs())
    await openRepo()
    await tree.toggle('src')
    await flush()
    expect(tree.rows()).toHaveLength(44)
  }

  it('spacer 撑出总高，窗口层靠 transform 位移', async () => {
    await mountBig()
    expect(spacer().style.height).toBe(`${44 * ROW_HEIGHT}px`)
    expect(windowEl().style.transform).toBe('translateY(0px)')
  })

  it('jsdom 里 clientHeight 恒为 0，于是只渲染 OVERSCAN 行——这是写明在 visibleWindow 里的行为', async () => {
    await mountBig()
    expect(rowEls()).toHaveLength(OVERSCAN)
    expect(rowNames()[0]).toBe('repo')
  })

  it('量到真实高度之后渲染「可视行数 + 两侧 overscan」', async () => {
    await mountBig()
    await fakeViewport(ROW_HEIGHT * 5)

    // 5 行可视 + 6 行 overscan，末尾那 6 行还没到所以只有 11 行
    expect(rowEls()).toHaveLength(11)
  })

  it('滚到中间时渲染的是中间那一段，窗口层跟着位移', async () => {
    await mountBig()
    await fakeViewport(ROW_HEIGHT * 5)

    scrollTo(ROW_HEIGHT * 20) // 第一可见行 = 20

    // start = 20 - 6 = 14，end = 20 + 5 + 6 = 31
    expect(rowEls()).toHaveLength(17)
    expect(rowNames()[0]).toBe(tree.rows()[14]!.name)
    expect(rowNames().at(-1)).toBe(tree.rows()[30]!.name)
    expect(windowEl().style.transform).toBe(`translateY(${14 * ROW_HEIGHT}px)`)
    // spacer 的高度不随滚动变：它就是总高，滚动条的长度靠它算
    expect(spacer().style.height).toBe(`${44 * ROW_HEIGHT}px`)
  })

  it('⚠️ 滚动复用 DOM：窗口重叠的那几行是**同一批元素对象**', async () => {
    await mountBig()
    await fakeViewport(ROW_HEIGHT * 5)

    const before = new Map(rowEls().map((el) => [el.title, el]))
    scrollTo(ROW_HEIGHT) // 只滚一行，窗口从 [0,11) 变成 [0,12)

    const after = new Map(rowEls().map((el) => [el.title, el]))
    let shared = 0
    for (const [title, el] of before) {
      const now = after.get(title)
      if (now === undefined) continue
      shared++
      expect(now, title).toBe(el)
    }
    // 这条断言是整组测试里最重要的一句：`<For>` 靠引用相等复用节点，
    // 而 `tree.rows()` 是 memo、不依赖 scrollTop。哪天有人把 rows 改成
    // 「滚动时重算的普通函数」，节点引用就会全部换新，这里立刻红。
    expect(shared).toBeGreaterThan(0)
    expect(after.size).toBe(before.size + 1)
  })

  it('滚出窗口的那些行被摘掉，DOM 里始终只有那几十行', async () => {
    await mountBig()
    await fakeViewport(ROW_HEIGHT * 5)

    scrollTo(ROW_HEIGHT * 20)
    // 头几行已经不在窗口里了
    expect(rowByRel('')).toBeUndefined()
    expect(rowByRel('src/f00.ts')).toBeUndefined()
    expect(rowByRel('src/f19.ts')).not.toBeUndefined()
    expect(rowEls().length).toBeLessThan(44)
  })

  it('键盘把选中行带出视口时 scrollTop 跟着走（滚进可视区）', async () => {
    await mountBig()
    await fakeViewport(ROW_HEIGHT * 5)

    tree.select('')
    key('End') // 跳到最后一行（index 43）

    // bottom = 44 * 22 = 968，视口高 110，所以 scrollTop 落到 858
    expect(scrollEl().scrollTop).toBe(44 * ROW_HEIGHT - ROW_HEIGHT * 5)
  })

  it('选中行本来就在视口里时 scrollTop 一动不动——「跳一下」比「不动」更让人失去方向', async () => {
    await mountBig()
    await fakeViewport(ROW_HEIGHT * 5)

    tree.select('src/f02.ts') // index 4
    scrollTo(ROW_HEIGHT * 2) // 视口 = [44, 154)，index 4 的 [88,110) 在里面

    key('ArrowDown') // → index 5，[110,132) 仍然在视口里

    expect(tree.selected()).toBe('src/f03.ts')
    expect(scrollEl().scrollTop).toBe(ROW_HEIGHT * 2)
  })

  it('往上走出视口时 scrollTop 收到那一行的顶端', async () => {
    await mountBig()
    await fakeViewport(ROW_HEIGHT * 5)

    tree.select('src/f02.ts') // index 4
    scrollTo(ROW_HEIGHT * 4) // 视口 = [88, 198)，index 4 的 [88,110) 刚好贴着上沿

    key('ArrowUp') // → index 3（src/f01.ts），它的 [66,88) 在视口上面

    expect(tree.selected()).toBe('src/f01.ts')
    expect(scrollEl().scrollTop).toBe(ROW_HEIGHT * 3)
  })
})

describe('右键菜单', () => {
  /** 打开 `/repo`、摊开 `src`、装好五个写操作的桩。菜单用例的共同起点 */
  async function ready(): Promise<void> {
    mount(copyFs())
    stubOps()
    await openRepo()
    await tree.toggle('src')
    await flush()
  }

  it('右键一行弹出菜单，位置就是光标的 clientX/clientY，顺手选中那一行', async () => {
    await ready()

    const e = await openMenu('src/a.ts', 120, 300)

    // 不拦的话 macOS 会在我们的菜单旁边再弹一个原生的，两个叠在一起
    expect(e.defaultPrevented).toBe(true)
    // 选中是顺手的：菜单弹出来时用户要能看清自己右键的是哪一行，
    // 尤其是名字被省略号截断的那些——菜单里不重复那一行的名字
    expect(tree.selected()).toBe('src/a.ts')
    expect(menuEl().style.left).toBe('120px')
    expect(menuEl().style.top).toBe('300px')
    expect(menuEl().getAttribute('role')).toBe('menu')
    expect(menuItems().every((b) => b.getAttribute('role') === 'menuitem')).toBe(true)
  })

  it('六项按 `menuFor` 给的顺序渲染，分隔线画在「重命名…」与「在 Finder 中显示」上面', async () => {
    await ready()
    await openMenu('src/a.ts')

    // 分隔线是项**上面**的一条，所以直接读子节点的顺序最省事。
    // 分的是「会不会改磁盘」：新建 | 改名/移到废纸篓 | Finder
    const kids = [...menuEl().children].map((el) =>
      el.classList.contains('tree-menu-sep') ? '|' : (el.textContent ?? ''),
    )
    expect(kids).toEqual(['新建文件', '新建文件夹', '|', '重命名…', '移到废纸篓', '|', '在 Finder 中显示', '复制路径'])
  })

  it('⚠️ 根行的菜单里没有「移到废纸篓」，也没有「重命名…」', async () => {
    await ready()
    await openMenu('')

    // 那两项落在根行上的含义是「把用户整个项目文件夹改名」与「把整个项目文件夹扔进废纸篓」。
    // 规则本身在 `menuFor` 里（已单测），这里钉的是**渲染没有把它改掉**
    expect(menuLabels()).toEqual(['新建文件', '新建文件夹', '在 Finder 中显示', '复制路径'])
  })

  it('选「移到废纸篓」调到 store，提示条那句话必须说「已移到废纸篓」', async () => {
    await ready()
    await openMenu('src/a.ts')
    await pickItem('移到废纸篓')

    expect(ipc.trashEntry).toHaveBeenCalledWith('/repo', 'src/a.ts')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.level).toBe('ok')
    expect(notices[0]!.text).toContain('已把「a.ts」移到废纸篓')
    expect(notices[0]!.text).toContain('找回')
    // ⚠️ 措辞是这条用例的全部理由：说「已删除」的话，用户会去找那个不存在的撤销，
    // 或者反过来以为文件真没了、去翻 git
    expect(notices[0]!.text).not.toContain('删除')
    // 菜单选完就关；那一行没了，选中挪到父层
    expect(maybeMenu()).toBeNull()
    expect(names()).toEqual(['repo', 'src', 'b.ts', 'README.md', 'docs'])
    expect(tree.selected()).toBe('src')
  })

  it('⚠️ 移到废纸篓不问「确定吗」：点下去就做完了', async () => {
    await ready()
    await openMenu('src/a.ts')
    await pickItem('移到废纸篓')

    // 这一条钉的是一个**决定**，不是一段代码：能从 Finder 的废纸篓里捞回来的动作不值得再问一句。
    // 问了的代价是每次删文件都多一次点击，而人很快就会开始无脑按回车——
    // 那时候这个确认框既拖慢了操作又没拦住任何误删
    expect(maybeModal()).toBeNull()
    expect(ipc.trashEntry).toHaveBeenCalledTimes(1)
  })

  it('移到废纸篓失败时以 error 级别交上去，那一行还在树里', async () => {
    await ready()
    ipc.trashEntry.mockImplementation(() => rejected<void>({ kind: 'io', message: '权限不够' }))

    await openMenu('src/a.ts')
    await pickItem('移到废纸篓')

    expect(notices).toHaveLength(1)
    expect(notices[0]!.level).toBe('error')
    expect(notices[0]!.text).toContain('权限不够')
    expect(names()).toContain('a.ts')
    expect(maybeMenu()).toBeNull()
  })

  it('复制路径成功时要说一句：剪贴板没有任何可见变化，不说就无从判断成没成', async () => {
    await ready()
    await openMenu('src/a.ts')
    await pickItem('复制路径')

    expect(ipc.copyEntryPath).toHaveBeenCalledWith('/repo', 'src/a.ts')
    expect(notices).toEqual([{ level: 'ok', text: '已复制「a.ts」的路径' }])
  })

  it('复制路径失败时也要说一句——漏掉的话用户以为复制成功了，粘出来是上一条内容', async () => {
    await ready()
    ipc.copyEntryPath.mockImplementation(() => rejected<void>({ kind: 'io', message: 'pbcopy 没跑起来' }))

    await openMenu('src/a.ts')
    await pickItem('复制路径')

    expect(notices).toHaveLength(1)
    expect(notices[0]!.level).toBe('error')
    expect(notices[0]!.text).toContain('pbcopy 没跑起来')
  })

  it('在 Finder 中显示：成功时不说话，Finder 被推到前台本身就是回话', async () => {
    await ready()
    await openMenu('README.md')
    await pickItem('在 Finder 中显示')

    expect(ipc.revealEntry).toHaveBeenCalledWith('/repo', 'README.md')
    expect(notices).toHaveLength(0)
    // 只读的操作不该动树
    expect(names()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
  })

  it('在 Finder 中显示失败时仍然要说一句', async () => {
    await ready()
    ipc.revealEntry.mockImplementation(() => rejected<void>({ kind: 'io', message: 'open 没跑起来' }))

    await openMenu('README.md')
    await pickItem('在 Finder 中显示')

    expect(notices).toHaveLength(1)
    expect(notices[0]!.level).toBe('error')
  })

  it('点菜单外面把它关掉，树不动', async () => {
    await ready()
    await openMenu('src/a.ts')

    mouseDown(scrollEl())

    expect(maybeMenu()).toBeNull()
    expect(tree.selected()).toBe('src/a.ts')
  })

  it('菜单**里面**按下不关：项是靠 click 触发的，先关掉那次 click 就永远等不到', async () => {
    await ready()
    await openMenu('src/a.ts')

    mouseDown(menuItem('复制路径'))

    expect(maybeMenu()).not.toBeNull()
    expect(ipc.copyEntryPath).not.toHaveBeenCalled()
  })

  it('Escape 关掉菜单，并且拦掉不让它继续往下走', async () => {
    await ready()
    await openMenu('src/a.ts')

    const e = key('Escape')

    expect(maybeMenu()).toBeNull()
    // Escape 在编辑器那边还有别的用处（关查找面板、退出多光标），谁在最上面谁说了算。
    // 与 DiscardDialog 同一条理由：绑 Escape 的命令一律不进命令中心
    expect(e.defaultPrevented).toBe(true)
    expect(tree.selected()).toBe('src/a.ts')
  })

  it('⚠️ 右键另一行时菜单换过去，位置与选中都跟着换', async () => {
    await ready()
    await openMenu('src/a.ts', 40, 60)
    await openMenu('src/b.ts', 55, 90)

    expect(maybeMenu()).not.toBeNull()
    expect(menuLabels()).toHaveLength(6)
    // 位置那两行是这条用例的重点：`<Show when={menu()}>` 的 when 前后都是真值，
    // Solid 复用同一个 TreeMenu 实例而不重建它。clamp 只挂在 onMount 上的话，
    // 菜单里的项已经换成新行的了、位置却留在上一个光标的地方，看起来像菜单飘走了。
    // 真机上多数时候会被「右键前先有一次 mousedown → 菜单先关再开」这条顺序掩盖掉，
    // 而 Ctrl+Click 那种只发 contextmenu 的路径上就会露出来
    expect(menuEl().style.left).toBe('55px')
    expect(menuEl().style.top).toBe('90px')
    expect(tree.selected()).toBe('src/b.ts')
  })

  it('⚠️ 树滚动时把菜单关掉：菜单是 fixed，行滚走了它不会跟着走', async () => {
    mount(bigFs())
    stubOps()
    await openRepo()
    await tree.toggle('src')
    await flush()
    await openMenu('src/f02.ts')
    expect(maybeMenu()).not.toBeNull()

    scrollTo(ROW_HEIGHT * 2)

    // 留着的话是一份指着别处的菜单，而用户点下去时已经看不出它原本属于哪一行了
    expect(maybeMenu()).toBeNull()
  })

  it('⚠️ 弹到视口外面时被推回来：jsdom 里只验得出「不超出窗口」这半个', async () => {
    await ready()
    // `getBoundingClientRect()` 在 jsdom 里全是 0，于是 `window.innerWidth - rect.width`
    // 就等于 innerWidth 本身。真机上还要再减去菜单自己的宽度——那一半只能在真实窗口里看
    await openMenu('src/a.ts', window.innerWidth + 200, window.innerHeight + 200)

    expect(menuEl().style.left).toBe(`${window.innerWidth}px`)
    expect(menuEl().style.top).toBe(`${window.innerHeight}px`)
  })
})

describe('名称对话框', () => {
  /** 打开 `/repo`、摊开 `src`、装好五个写操作的桩 */
  async function ready(): Promise<void> {
    mount(copyFs())
    stubOps()
    await openRepo()
    await tree.toggle('src')
    await flush()
  }

  /** 右键一行、点「新建文件」，把对话框弹出来 */
  async function openNewFile(rel: string): Promise<void> {
    await openMenu(rel)
    await pickItem('新建文件')
  }

  it('右键目录选「新建文件」：标题说清在哪一层，输入框是空的，「新建」先灰着', async () => {
    await ready()
    await openNewFile('src')

    expect(modalTitle()).toBe('在「src」里新建文件')
    expect(modalEl().getAttribute('role')).toBe('dialog')
    expect(modalEl().getAttribute('aria-modal')).toBe('true')
    expect(modalInput().value).toBe('')
    // 空名字不该能提交：不挡的话要点下去、走一次 IPC、再等 Rust 回一句 bad_name，慢得多也绕得多
    expect(submitButton().disabled).toBe(true)
    expect(submitButton().textContent).toBe('新建')
  })

  it('对话框弹出来时菜单已经关了：两个浮层不该同时压在树上', async () => {
    await ready()
    await openMenu('src/a.ts')
    await pickItem('重命名…')

    expect(maybeMenu()).toBeNull()
    expect(maybeModal()).not.toBeNull()
  })

  it('⚠️ 根层新建：`create_entry` 收到的 rel 是名字本身，不是以斜杠开头', async () => {
    await ready()
    await openMenu('')
    await pickItem('新建文件')
    // 根层没有名字可抠，标题里用的是项目名
    expect(modalTitle()).toBe('在「repo」里新建文件')

    type('新建.md')
    enter()
    await flush()

    // `childRel('', name)` 少写那个分支的话这里会是 '/新建.md'，而 Rust 侧的 `resolve`
    // 把以 `/` 开头的 rel 当绝对路径拒掉——用户新建一个文件，屏幕上出现的却是「越出了项目根目录」
    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', '新建.md', 'file')
    expect(maybeModal()).toBeNull()
    expect(names()).toContain('新建.md')
    expect(tree.selected()).toBe('新建.md')
    // 成了不用说话：新条目已经被选中，树上看得见
    expect(notices).toHaveLength(0)
  })

  it('右键一个文件新建：新文件建在它旁边，不是「它里面」', async () => {
    await ready()
    await openNewFile('src/a.ts')

    expect(modalTitle()).toBe('在「src」里新建文件')
    type('c.ts')
    enter()
    await flush()

    // 文件没有里面。把文件行自己当目标层的话这里会是 'src/a.ts/c.ts'，
    // Rust 侧回一句 not_a_directory，用户看到的是「新建失败」
    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', 'src/c.ts', 'file')
    expect(names()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'c.ts', 'README.md', 'docs'])
  })

  it('「新建文件夹」传的是 dir，并且当场摊开那一层', async () => {
    await ready()
    await openMenu('src')
    await pickItem('新建文件夹')

    expect(modalTitle()).toBe('在「src」里新建文件夹')
    type('assets')
    enter()
    await flush()

    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', 'src/assets', 'dir')
    expect(names()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'assets', 'README.md', 'docs'])
    // 新文件夹自己是收起的（VS Code / Finder 都一样，里面本来也没东西），
    // 但它得是个**目录行**：有 twisty、有 aria-expanded
    const row = rowByRel('src/assets')!
    expect(row.querySelector('.tree-twisty')!.textContent).toBe('▸')
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('⚠️ 右键一个收起的目录新建：那一层被摊开，用户看得见自己刚建的东西', async () => {
    mount(copyFs())
    stubOps()
    await openRepo()
    // `docs` 此刻是收起的
    expect(names()).toEqual(['repo', 'src', 'README.md', 'docs'])

    await openMenu('docs')
    await pickItem('新建文件')
    type('extra.md')
    enter()
    await flush()

    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', 'docs/extra.md', 'file')
    // 不摊开的话用户按了确定之后界面上什么也没多出来，他会以为没成功再按一次，
    // 于是撞上一个 already_exists
    expect(names()).toEqual(['repo', 'src', 'README.md', 'docs', 'intro.md', 'extra.md'])
  })

  it('Escape 取消：不调 IPC，对话框关掉', async () => {
    await ready()
    await openNewFile('src')
    type('不该被建出来.md')

    // Escape 走的是对话框自己那棵子树上的 onKeyDown，不进命令中心
    modalInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush()

    expect(maybeModal()).toBeNull()
    expect(ipc.createEntry).not.toHaveBeenCalled()
    expect(names()).not.toContain('不该被建出来.md')
  })

  it('点「取消」与 Escape 一样', async () => {
    await ready()
    await openNewFile('src')

    cancelButton().click()
    await flush()

    expect(maybeModal()).toBeNull()
    expect(ipc.createEntry).not.toHaveBeenCalled()
  })

  it('⚠️ 失败时对话框留在原地，那句话显示在输入框下面，输入框里还是刚打的名字', async () => {
    await ready()
    ipc.createEntry.mockImplementation(() => rejected<DirEntry>({ kind: 'already_exists', path: '/repo/src/a.ts' }))

    await openNewFile('src')
    type('a.ts')
    enter()
    await flush()

    // 关掉的话那句话会落到提示条上，而用户得重新右键、重新点「新建文件」、
    // 重新打一遍名字才知道自己错在哪。留在原地，改两个字再按回车
    expect(maybeModal()).not.toBeNull()
    expect(modalInput().value).toBe('a.ts')
    const err = modalEl().querySelector('.modal-error')!
    expect(err.getAttribute('role')).toBe('alert')
    // 真实措辞钉在 `src/ipc/project.test.ts`；这里的 `describeTreeError` 是桩，
    // 这条断言要的是「那句话没被吞成 null、也没被改写成内部错误」
    expect(err.textContent).toContain('already_exists')
    expect(modalInput().getAttribute('aria-invalid')).toBe('true')
    // busy 已经放开，改完名字能立刻再提交一次
    expect(submitButton().disabled).toBe(false)
    // 失败就地说，不再往提示条上重复一遍
    expect(notices).toHaveLength(0)
  })

  it('失败之后改名字：那句话当场消失，再提交成功就把对话框摘掉', async () => {
    await ready()
    ipc.createEntry.mockImplementationOnce(() => rejected<DirEntry>({ kind: 'already_exists', path: '/repo/src/a.ts' }))

    await openNewFile('src')
    type('a.ts')
    enter()
    await flush()
    expect(modalError()).not.toBeNull()

    type('c.ts')
    // 一边打字一边把上一句失败清掉：留着它的话用户会以为改完之后还是不行
    expect(modalError()).toBeNull()

    enter()
    await flush()

    expect(maybeModal()).toBeNull()
    expect(ipc.createEntry).toHaveBeenLastCalledWith('/repo', 'src/c.ts', 'file')
    expect(names()).toContain('c.ts')
  })

  it('⚠️ 提交在飞的时候按第二次回车不会再提交一次', async () => {
    await ready()
    let release: ((entry: DirEntry) => void) | undefined
    ipc.createEntry.mockImplementation(
      () =>
        new Promise<DirEntry>((resolve) => {
          release = resolve
        }),
    )

    await openNewFile('src')
    type('慢.md')
    enter()
    // 第一次还没回来就按第二次：双击回车会变成两次 `create_entry`，第二次撞上 already_exists，
    // 用户看到的是一句「已经存在」——而他刚刚明明成功了
    enter()

    expect(ipc.createEntry).toHaveBeenCalledTimes(1)
    expect(submitButton().disabled).toBe(true)

    release!(f('src/慢.md'))
    await flush()

    expect(maybeModal()).toBeNull()
    expect(tree.selected()).toBe('src/慢.md')
  })

  it('名字全是空格时「新建」是灰的，回车也不提交', async () => {
    await ready()
    await openNewFile('src')

    type('   ')

    expect(submitButton().disabled).toBe(true)
    enter()
    await flush()
    expect(ipc.createEntry).not.toHaveBeenCalled()
    expect(maybeModal()).not.toBeNull()
  })

  it('名字原样送出去，不 trim：替用户去掉那个空格等于悄悄建了一个他没要求的名字', async () => {
    await ready()
    await openNewFile('src')

    type('draft ')
    enter()
    await flush()

    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', 'src/draft ', 'file')
  })

  it('重命名：预填当前名字，只选中主文件名', async () => {
    await ready()
    await openMenu('src/a.ts')
    await pickItem('重命名…')

    expect(modalTitle()).toBe('把「a.ts」改名')
    expect(submitButton().textContent).toBe('改名')
    expect(modalInput().value).toBe('a.ts')
    // 改名 `a.ts` 时用户几乎总是要换掉 `a` 而留下 `.ts`：全选的话他得先删掉扩展名再打回来，
    // 或者打完之后发现文件变成了 `新名字.ts.ts`。这是所有编辑器的默认行为
    expect(modalInput().selectionStart).toBe(0)
    expect(modalInput().selectionEnd).toBe(1)

    type('c.ts')
    enter()
    await flush()

    expect(ipc.renameEntry).toHaveBeenCalledWith('/repo', 'src/a.ts', 'c.ts')
    expect(maybeModal()).toBeNull()
    expect(names()).toEqual(['repo', 'src', 'c.ts', 'b.ts', 'README.md', 'docs'])
    expect(tree.selected()).toBe('src/c.ts')
    expect(notices).toHaveLength(0)
  })

  it('重命名一个文件夹时全选：目录名里的点不是扩展名分隔符', async () => {
    await ready()
    await openMenu('src')
    await pickItem('重命名…')

    expect(modalInput().value).toBe('src')
    expect(modalInput().selectionStart).toBe(0)
    expect(modalInput().selectionEnd).toBe(3)
  })

  it('⚠️ `.gitignore` 这种「整段都是扩展名」的名字全选，不然选区是空的', async () => {
    const fs = copyFs()
    fs[''] = [...fs['']!, f('.gitignore')]
    mount(fs)
    stubOps()
    await openRepo()

    await openMenu('.gitignore')
    await pickItem('重命名…')

    expect(modalInput().value).toBe('.gitignore')
    expect(modalInput().selectionStart).toBe(0)
    // `lastIndexOf('.')` 是 0，于是 `dotAt > 0` 不成立，走 `select()` 全选。
    // 只选前半段会得到一个空选区——用户按下去打字，名字变成 `.gitignore新名字`
    expect(modalInput().selectionEnd).toBe('.gitignore'.length)
  })

  it('重命名失败时对话框留着，名字还在输入框里', async () => {
    await ready()
    ipc.renameEntry.mockImplementationOnce(() => rejected<DirEntry>({ kind: 'already_exists', path: '/repo/src/b.ts' }))

    await openMenu('src/a.ts')
    await pickItem('重命名…')
    type('b.ts')
    enter()
    await flush()

    expect(maybeModal()).not.toBeNull()
    expect(modalInput().value).toBe('b.ts')
    expect(modalError()).toContain('already_exists')
    expect(names()).toContain('a.ts')
    expect(notices).toHaveLength(0)
  })
})
