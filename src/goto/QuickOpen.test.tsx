// @vitest-environment jsdom
import { createRoot, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `Cmd+P` 浮层的测试：DOM 与 `createQuickOpen` 之间的接线。
 *
 * 状态机那一半（什么时候去问索引、`seq` 与 `epoch` 怎么作废在飞的那一次、四种意图各自的
 * 措辞）在 `./store.test.ts` 里钉过了，输入的语法在 `./query.test.ts`，标题怎么从语法树里
 * 抠出来在 `./symbols.test.ts` 与 `./syntax.test.ts`。这里测四件事：
 * **渲染出来的东西对不对**、**点对了地方会不会调到对的方法**、
 * **虚拟滚动是不是真的只渲染看得见的那几行、并且滚动时复用 DOM**、
 * **那八个键落在输入框上分别做什么**。
 *
 * 虚拟滚动那条是承重墙，但它在这里挡的与搜索结果那一边不同：文件模式一次最多 50 条
 * （Rust 侧的 `QUERY_LIMIT`），而 `@标题` 没有上限——一份长笔记几百个标题很正常，
 * 而浮层是**每按一个键都要重算一遍**的东西。
 *
 * ⚠️ 有些东西这里钉不住，都得在真实窗口里看：浮层该多宽（520px）、离顶多远（72px）、
 * 不压暗背景时它与编辑区分不分得开、标题行的缩进一档 12px 够不够读出层级、
 * 代码字体与 UI 字体在同一个位置上切换时会不会跳。jsdom 里没有布局，
 * `clientHeight` 要用 `Object.defineProperty` 假造（见 `setViewport`）。
 */

/**
 * ⚠️ 桩写了完整的函数签名，不是裸 `vi.fn()`：裸的话 `.mock.calls` 的元素是 `any`，
 * 于是每一处下标访问都是一次 unsafe member access，而 `pnpm lint` 是门禁。
 */
const { ipc } = vi.hoisted(() => ({
  ipc: {
    indexProject: vi.fn<(roots: readonly string[]) => Promise<IndexStats>>(),
    queryProject: vi.fn<(roots: readonly string[], needle: string, recent: string[]) => Promise<FileQuery>>(),
    describeTreeError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
  },
}))

vi.mock('../ipc/project', () => ipc)

import type { FileQuery, IndexStats } from '../ipc/project'
import { OVERSCAN } from '../ui/virtual'
import { QuickOpen } from './QuickOpen'
import type { SymbolTable } from './symbols'
import { createQuickOpen, QUICK_OPEN_ROW_HEIGHT, type Commit, type QuickOpen as Panel } from './store'

function rejected<T>(payload: unknown): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri 抛的是序列化后的对象
  return Promise.reject(payload)
}

/** 点击与异步的状态更新都要等一轮微任务与宏任务，才谈得上断言后果 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function queryOf(rels: string[], total?: number, rootIndex = 0): FileQuery {
  const matches = rels.map((rel) => ({ rel, path: `/repo/${rel}`, score: 7, rootIndex }))
  return { matches, total: total ?? matches.length }
}

function stats(overrides: Partial<IndexStats> = {}): IndexStats {
  return { files: 120, unreadable: 0, truncated: false, elapsedMs: 3, ...overrides }
}

/** 造 n 条互不相同的候选。⚠️ 文本必须两两不同：滚动那几条用例靠「第一行是谁」认窗口 */
function many(n: number): FileQuery {
  return queryOf(Array.from({ length: n }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`))
}

/** 最近项目清单。这一组用例大多与它无关，所以默认是空的 */
let projects: (readonly string[])[]
let container: HTMLDivElement
let panel: Panel
let committed: Commit[]
let table: SymbolTable | null
/** `createQuickOpen` 里有 `createMemo`；不在 root 里建，它们永远不会被释放 */
let disposePanel: (() => void) | undefined
let disposeRender: (() => void) | undefined

function mount(roots: readonly string[] = ['/repo']): Panel {
  committed = []
  disposePanel = createRoot((teardown) => {
    panel = createQuickOpen({
      // 根清单是常量而不是 signal：这一组用例没有一条要改工作区，
      // 「工作区变了措辞得跟着变」在 store.test.ts 里用真 signal 钉过了
      roots: () => roots,
      recent: () => [],
      recentProjects: () => projects,
      symbols: () => table,
      commit: async (action) => void committed.push(action),
    })
    return teardown
  })
  // 与 App 里逐字相同的挂法：浮层是 `<Show>` 出来的，于是「收起」等于「卸载」，
  // 挂载/卸载这条路径本身也是被测对象
  disposeRender = render(
    () => (
      <Show when={panel.visible()}>
        <QuickOpen goto={panel} />
      </Show>
    ),
    container,
  )
  return panel
}

/** 展开并等在飞的 IPC 落地 */
async function open(seed?: string): Promise<void> {
  await panel.show(seed)
  await flush()
}

/** 以「切最近项目」的意图展开。这一路压根不问索引，所以没有 IPC 要等——`flush` 只为渲染 */
async function openProjects(seed = ''): Promise<void> {
  await panel.show(seed, 'project')
  await flush()
}

/* ---------- DOM 读取口 ---------- */

function backdrop(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.palette-backdrop')
  if (!el) throw new Error('找不到 .palette-backdrop')
  return el
}

function input(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('.palette-input')
  if (!el) throw new Error('找不到 .palette-input')
  return el
}

function scrollEl(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.palette-list')
  if (!el) throw new Error('找不到 .palette-list')
  return el
}

function spacer(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.palette-spacer')
  if (!el) throw new Error('找不到 .palette-spacer')
  return el
}

function windowEl(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.palette-window')
  if (!el) throw new Error('找不到 .palette-window')
  return el
}

function rowEls(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.palette-row')]
}

function rowTexts(): string[] {
  return rowEls().map((el) => el.textContent ?? '')
}

function statusText(): string {
  return container.querySelector('.palette-status')?.textContent ?? ''
}

function errorText(): string | null {
  return container.querySelector('.palette-error')?.textContent ?? null
}

function warningText(): string | null {
  return container.querySelector('.palette-warn')?.textContent ?? null
}

function foot(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.palette-foot')
  if (!el) throw new Error('找不到 .palette-foot')
  return el
}

function selectedIndex(): number {
  return rowEls().findIndex((el) => el.classList.contains('selected'))
}

/* ---------- 事件派发 ---------- */

/**
 * `bubbles` 与 `cancelable` 都是必需的：Solid 把 keydown 挂在 document 上做委托，
 * 不冒泡就到不了处理器；不 cancelable 的话 `preventDefault()` 是空操作，
 * 断言不出「浏览器默认行为被吃掉了」。
 */
function key(el: HTMLElement, which: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: which, bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return e
}

/** 往输入框里打字。必须派发 `input`：Solid 的 `onInput` 读的是事件，不是赋值这个动作 */
function type(text: string): void {
  const el = input()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * `mouseenter` 不在 Solid 的委托名单里（它压根不冒泡），所以这一个走的是元素上的原生监听，
 * 派发时**不需要** `bubbles`——写 `bubbles: true` 反而与真实浏览器不一致
 */
function hover(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('mouseenter'))
}

/**
 * 假造一个有高度的可视区。
 *
 * jsdom 没有布局，`clientHeight` 恒为 0，于是窗口算术只给出 `OVERSCAN` 行、
 * `pageSize` 退化成 1。要测「翻一页翻多少」「已经在可视区里就一动不动」这两条，
 * 只能自己把这个数字塞进去，再派发一次 `resize` 让组件重新量。
 */
function setViewport(height: number): void {
  Object.defineProperty(scrollEl(), 'clientHeight', { value: height, configurable: true })
  window.dispatchEvent(new Event('resize'))
}

function scrollList(top: number): void {
  const el = scrollEl()
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll', { bubbles: true }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  ipc.indexProject.mockReset()
  ipc.queryProject.mockReset()
  ipc.indexProject.mockResolvedValue(stats())
  ipc.queryProject.mockResolvedValue(queryOf([]))
  table = { kind: 'headings', items: [] }
  projects = []
  mount()
})

afterEach(() => {
  disposeRender?.()
  disposePanel?.()
  disposeRender = undefined
  disposePanel = undefined
  container.remove()
})

describe('挂载与结构', () => {
  it('展开时挂上来，收起时整个摘掉', async () => {
    expect(container.querySelector('.palette-backdrop')).toBeNull()
    await open()
    expect(container.querySelector('.palette-backdrop')).not.toBeNull()
    panel.hide()
    await flush()
    expect(container.querySelector('.palette-backdrop')).toBeNull()
  })

  it('行高只有一个真相：注入到 backdrop 上的那个变量与窗口算术用的是同一个常量', async () => {
    await open()
    expect(backdrop().style.getPropertyValue('--vela-palette-row-height')).toBe(`${QUICK_OPEN_ROW_HEIGHT}px`)
  })

  it('角色与 aria：一个对话框、一格输入框、一个列表框、若干选项', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()

    expect(container.querySelector('.palette')?.getAttribute('role')).toBe('dialog')
    expect(scrollEl().getAttribute('role')).toBe('listbox')
    // ⚠️ 输入框用 `aria-controls` 指着列表，屏幕阅读器才知道它改的是哪一块
    expect(input().getAttribute('aria-controls')).toBe('palette-list')
    expect(scrollEl().id).toBe('palette-list')

    const rows = rowEls()
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.getAttribute('role')).toBe('option')
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true')
    expect(rows[1]?.getAttribute('aria-selected')).toBe('false')
  })

  it('placeholder 把三种用法一次说完：不知道 `:42` 与 `@` 的人根本不会去试', async () => {
    await open()
    expect(input().placeholder).toBe('按名字找文件…（:42 跳行，@ 列标题）')
  })

  it('列表上没有 tabIndex：焦点必须留在输入框上', async () => {
    await open()
    // 与 `.find-scroll` 刻意相反：那边「按 ArrowDown 从输入框走进结果」要把焦点交给列表，
    // 而这里每敲一个字符都要重算列表，焦点一旦被挪走就再也打不了字
    expect(scrollEl().getAttribute('tabindex')).toBeNull()
  })
})

describe('虚拟滚动', () => {
  it('只渲染看得见的那几行，占位元素撑满总高', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    expect(panel.rows()).toHaveLength(60)
    // jsdom 里 clientHeight 是 0，于是窗口就是 OVERSCAN 行（见 ui/virtual.ts）
    expect(rowEls()).toHaveLength(OVERSCAN)
    expect(spacer().style.height).toBe(`${60 * QUICK_OPEN_ROW_HEIGHT}px`)
    expect(rowTexts()[0]).toBe('src/f000.ts')
  })

  it('滚动时窗口平移：渲染的行换一批，整块用 transform 偏移', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    scrollList(400) // 第 20 行顶上
    await flush()

    expect(rowTexts()[0]).toBe('src/f014.ts') // start = 20 - OVERSCAN
    expect(windowEl().style.transform).toBe(`translateY(${14 * QUICK_OPEN_ROW_HEIGHT}px)`)
  })

  it('⚠️ 滚动复用同一批 DOM 元素对象，不重建子树', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    const before = rowEls()
    expect(before).toHaveLength(OVERSCAN)

    // 滚两行：窗口从 [0,6) 变成 [0,8)，头六个应当是**同一批对象**
    scrollList(2 * QUICK_OPEN_ROW_HEIGHT)
    await flush()
    const after = rowEls()

    expect(after).toHaveLength(OVERSCAN + 2)
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i])
  })

  it('有了真实高度就渲染「一屏 + 两头各 OVERSCAN」行', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    setViewport(100) // 5 行
    await flush()
    expect(rowEls()).toHaveLength(5 + OVERSCAN)
  })

  it('列表变空时把滚动位置归零：不归零的话新一轮会是一片空白', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    scrollList(800)
    await flush()
    expect(scrollEl().scrollTop).toBe(800)

    // 上一轮滚到了 800px，这一轮一处都没命中：窗口算术会算出 start === end === 0，
    // 而 `scrollTop` 还停在 800——浮层一片空白，底下那行却写着「没有匹配的文件」
    ipc.queryProject.mockResolvedValue(queryOf([]))
    type('zzz')
    await flush()
    expect(scrollEl().scrollTop).toBe(0)
    expect(rowTexts()).toEqual([])
  })
})

describe('列表的样子', () => {
  it('文件行不缩进、不带 .symbol', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['src/a.ts']))
    await open()
    const row = rowEls()[0]
    if (!row) throw new Error('一行都没渲染')
    expect(row.style.paddingLeft).toBe('10px')
    expect(row.classList.contains('symbol')).toBe(false)
    expect(row.getAttribute('title')).toBe('/repo/src/a.ts')
  })

  it('⚠️ 多根时候选前面画一个根名，单根时那个节点压根不存在', async () => {
    mount(['/repo', '/notes'])
    ipc.queryProject.mockResolvedValue({
      matches: [
        { rel: 'src/a.ts', path: '/repo/src/a.ts', score: 7, rootIndex: 0 },
        { rel: 'note.md', path: '/notes/note.md', score: 6, rootIndex: 1 },
      ],
      total: 2,
    })
    await open()

    expect(rowEls().map((r) => r.querySelector('.palette-root')?.textContent)).toEqual(['repo', 'notes'])
    // `.palette-text` 里只有路径：根名是它前面**另一个**节点，
    // 于是「哪一段是项目、哪一段是路径」在 DOM 里就分得开，省略号也只会截掉路径那一段
    expect(rowEls().map((r) => r.querySelector('.palette-text')?.textContent)).toEqual(['src/a.ts', 'note.md'])
  })

  it('单根时一个 .palette-root 都不渲染——不是渲染成空的那一个', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['src/a.ts', 'README.md']))
    await open()

    // 空 span 也会占掉它自己那份 margin-right，于是单根与多根的左边界对不齐。
    // 判据是「节点不存在」而不是「文本是空的」
    expect(container.querySelectorAll('.palette-root')).toHaveLength(0)
    expect(rowTexts()).toEqual(['src/a.ts', 'README.md'])
  })

  it('标题行按级别缩进，一档 12px，并带 .symbol', async () => {
    table = {
      kind: 'headings',
      items: [
        { name: '一级', level: 1, pos: 0 },
        { name: '三级', level: 3, pos: 30 },
        { name: '六级', level: 6, pos: 60 },
      ],
    }
    await open('@')

    const rows = rowEls()
    expect(rows.map((r) => r.style.paddingLeft)).toEqual(['10px', '34px', '70px'])
    for (const row of rows) expect(row.classList.contains('symbol')).toBe(true)
    expect(rowTexts()).toEqual(['一级', '三级', '六级'])
  })

  it('索引被截断时多一行警告，而它不在状态那一行里', async () => {
    ipc.indexProject.mockResolvedValue(stats({ truncated: true, files: 200000 }))
    await open()
    expect(warningText()).toMatch(/这份索引不全/)
    expect(statusText()).toBe('这个项目里没有文件')
  })

  it('没有截断时一行警告都不渲染', async () => {
    await open()
    expect(container.querySelector('.palette-warn')).toBeNull()
  })

  it('查询失败时错误与状态是两格，各自说各自的', async () => {
    ipc.queryProject.mockReturnValueOnce(rejected<FileQuery>({ kind: 'BadRoot', path: '/repo' }))
    await open()
    await flush()
    expect(errorText()).toBe('模拟错误：{"kind":"BadRoot","path":"/repo"}')
    expect(statusText()).toBe('')
  })

  it('查询在飞的那一段时间脚上挂着 .busy', async () => {
    await open()
    // 索引已经建完了，此刻没有在飞的查询
    expect(foot().classList.contains('busy')).toBe(false)
    expect(statusText()).toBe('这个项目里没有文件')

    let release: (value: FileQuery) => void = () => {}
    const pending = new Promise<FileQuery>((r) => {
      release = r
    })
    ipc.queryProject.mockReturnValueOnce(pending)

    type('x')
    await flush()
    expect(foot().classList.contains('busy')).toBe(true)

    release(queryOf([]))
    await flush()
    expect(foot().classList.contains('busy')).toBe(false)
  })

  it('状态那一行说出「还有更多没显示」', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md'], 137))
    await open()
    expect(statusText()).toBe('共 137 个匹配，显示前 1 个——把词写窄一点')
  })
})

describe('打字与选中', () => {
  it('打字就重查，行跟着换', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    expect(rowTexts()).toEqual(['a.md', 'b.md'])

    ipc.queryProject.mockResolvedValue(queryOf(['c.md']))
    type('c')
    await flush()
    expect(rowTexts()).toEqual(['c.md'])
    expect(input().value).toBe('c')
  })

  it('选中的那一行有 .selected，换列表时回到第一行', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md', 'c.md']))
    await open()
    expect(selectedIndex()).toBe(0)

    key(input(), 'ArrowDown')
    await flush()
    expect(selectedIndex()).toBe(1)

    type('zz')
    await flush()
    expect(selectedIndex()).toBe(0)
  })

  it('鼠标悬停就选中：Enter 落地的必须是他指着的那一行', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md', 'c.md']))
    await open()
    const rows = rowEls()
    hover(rows[2]!)
    await flush()
    expect(selectedIndex()).toBe(2)
    expect(committed).toEqual([])

    key(input(), 'Enter')
    await flush()
    expect(committed).toEqual([{ kind: 'openFile', path: '/repo/c.md', line: null }])
  })

  it('点一行就落地并收起，不需要先选中', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    rowEls()[1]!.click()
    await flush()
    expect(committed).toEqual([{ kind: 'openFile', path: '/repo/b.md', line: null }])
    expect(container.querySelector('.palette-backdrop')).toBeNull()
  })

  it('点遮罩空白处收起，点浮层本体不收', async () => {
    await open()
    const dialog = container.querySelector<HTMLElement>('.palette')
    dialog?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(panel.visible()).toBe(true)

    // 点在遮罩自己身上：`target` 与 `currentTarget` 是同一个元素，组件据此才收起。
    // ⚠️ 必须 `bubbles: true`——Solid 把 click 委托到 document 上，不冒泡就到不了处理器
    backdrop().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(panel.visible()).toBe(false)
  })
})

describe('键盘', () => {
  it('Escape 收起浮层，并吃掉那个键', async () => {
    await open()
    const e = key(input(), 'Escape')
    expect(e.defaultPrevented).toBe(true)
    expect(panel.visible()).toBe(false)
    expect(committed).toEqual([])
  })

  it('Enter 落地选中的那一行，并吃掉那个键', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    key(input(), 'ArrowDown')
    const e = key(input(), 'Enter')
    expect(e.defaultPrevented).toBe(true)
    expect(committed).toEqual([{ kind: 'openFile', path: '/repo/b.md', line: null }])
  })

  it('空列表上按 Enter 也吃掉那个键：不拦的话某些内核会顺手把焦点挪走', async () => {
    await open()
    expect(rowEls()).toHaveLength(0)
    const e = key(input(), 'Enter')
    expect(e.defaultPrevented).toBe(true)
    expect(committed).toEqual([])
    // 也不收起：收起的话用户会以为「按了 Enter 就跳过去了」，而其实一个字符都没动
    expect(panel.visible()).toBe(true)
  })

  it('方向键移动选中并吃掉那个键', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md', 'c.md']))
    await open()
    expect(key(input(), 'ArrowDown').defaultPrevented).toBe(true)
    expect(selectedIndex()).toBe(1)
    expect(key(input(), 'ArrowUp').defaultPrevented).toBe(true)
    expect(selectedIndex()).toBe(0)
    expect(key(input(), 'End').defaultPrevented).toBe(true)
    expect(selectedIndex()).toBe(2)
    expect(key(input(), 'Home').defaultPrevented).toBe(true)
    expect(selectedIndex()).toBe(0)
  })

  it('空列表上按方向键不吃掉那个键，让浏览器自己处理', async () => {
    await open()
    expect(rowEls()).toHaveLength(0)
    expect(key(input(), 'ArrowDown').defaultPrevented).toBe(false)
    expect(key(input(), 'Home').defaultPrevented).toBe(false)
  })

  it('不认的键既不移动选中也不吃掉', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    for (const which of ['a', 'Tab', 'ArrowLeft', 'Backspace']) {
      expect(key(input(), which).defaultPrevented).toBe(false)
    }
    expect(selectedIndex()).toBe(0)
  })

  it('翻页翻多少由量到的可视区决定', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    setViewport(100) // 5 行
    await flush()

    key(input(), 'PageDown')
    await flush()
    expect(panel.selected()).toBe(5)
    key(input(), 'PageUp')
    await flush()
    expect(panel.selected()).toBe(0)
  })

  it('量不到高度时翻页按一行算：那不是 bug，是 jsdom 没有布局', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    key(input(), 'PageDown')
    await flush()
    expect(panel.selected()).toBe(1)
  })

  it('选中移到可视区外面时把它滚进来', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    key(input(), 'ArrowDown')
    await flush()
    // clientHeight 是 0，于是「滚进来」就是把这一行的底边对齐到顶边
    expect(scrollEl().scrollTop).toBe(2 * QUICK_OPEN_ROW_HEIGHT)
  })

  it('已经在可视区里就一动不动：跳一下比不动更让人失去方向', async () => {
    ipc.queryProject.mockResolvedValue(many(60))
    await open()
    setViewport(100)
    await flush()
    scrollList(0)
    await flush()

    key(input(), 'ArrowDown')
    key(input(), 'ArrowDown')
    await flush()
    expect(panel.selected()).toBe(2)
    expect(scrollEl().scrollTop).toBe(0)
  })
})

describe('焦点', () => {
  it('挂上来时焦点就在输入框', async () => {
    await open()
    expect(document.activeElement).toBe(input())
  })

  it('浮层已经开着再按一次 Cmd+P，焦点被抢回来', async () => {
    await open()
    input().blur()
    expect(document.activeElement).not.toBe(input())

    await panel.show()
    await flush()
    expect(document.activeElement).toBe(input())
    // 而且不重建索引：那只是换一个意图，见 store.test.ts
    expect(ipc.indexProject).toHaveBeenCalledTimes(1)
  })

  it('换成 `@` 意图时焦点仍在输入框，于是接着打字改的是搜索词', async () => {
    await open()
    input().blur()
    await panel.show('@')
    await flush()
    expect(document.activeElement).toBe(input())
    expect(input().value).toBe('@')

    type('@安装')
    await flush()
    expect(input().value).toBe('@安装')
  })
})

describe('最近项目（Cmd+Shift+O）', () => {
  it('标签跟着意图走：同一个浮层办两件事，读屏的人不该听到一句错话', async () => {
    await openProjects()
    expect(container.querySelector('.palette')?.getAttribute('aria-label')).toBe('切换到最近项目')
    expect(input().getAttribute('aria-label')).toBe('最近项目')
    expect(input().placeholder).toBe('按名字或路径找最近项目…')
  })

  it('⚠️ 项目模式里一次 IPC 都不发：那 40–205ms 的建索引与它无关', async () => {
    await openProjects()
    expect(ipc.indexProject).not.toHaveBeenCalled()
    expect(ipc.queryProject).not.toHaveBeenCalled()
    expect(foot().classList.contains('busy')).toBe(false)
  })

  it('一行三段：项目名、它所在的地方、悬停时整份根清单', async () => {
    projects = [['/Users/me/code/vela', '/Users/me/notes'], ['/Users/me/scratch']]
    await openProjects()

    // `.palette-root` 这一格在文件模式下装的是**根名**，在这里装的是**父目录**——
    // 同一句读法（「这个名字在那个地方」），而两个同名项目就靠它分开
    expect(rowEls().map((r) => r.querySelector('.palette-root')?.textContent)).toEqual(['/Users/me/code', '/Users/me'])
    expect(rowEls().map((r) => r.querySelector('.palette-text')?.textContent)).toEqual(['vela +1', 'scratch'])
    expect(rowEls()[0]?.getAttribute('title')).toBe('/Users/me/code/vela\n/Users/me/notes')
  })

  it('项目行不缩进、不带 .symbol：它不是一个标题', async () => {
    projects = [['/Users/me/code/vela']]
    await openProjects()
    const row = rowEls()[0]
    if (!row) throw new Error('一行都没渲染')
    expect(row.style.paddingLeft).toBe('10px')
    expect(row.classList.contains('symbol')).toBe(false)
  })

  it('打字就地过滤，按名字与按路径都认', async () => {
    projects = [['/Users/me/code/vela'], ['/Users/me/scratch']]
    await openProjects()
    const names = () => rowEls().map((r) => r.querySelector('.palette-text')?.textContent)
    expect(names()).toEqual(['vela', 'scratch'])

    // 过滤跑在**完整路径**上而不是只在名字上：两个同名项目靠父目录分开，
    // 而「我记得它在 code 底下」是一条同样合法的找法
    type('code')
    await flush()
    expect(names()).toEqual(['vela'])
    expect(statusText()).toBe('1 个最近项目')
  })

  it('点一行就把**整份**根清单交出去，然后收起', async () => {
    projects = [['/Users/me/code/vela', '/Users/me/notes'], ['/Users/me/scratch']]
    await openProjects()
    rowEls()[0]!.click()
    await flush()

    // 落地的是 `openWorkspace` 而不是 `openFile`：切项目换掉的是整棵树，不是开一个标签
    expect(committed).toEqual([{ kind: 'openWorkspace', roots: ['/Users/me/code/vela', '/Users/me/notes'] }])
    expect(container.querySelector('.palette-backdrop')).toBeNull()
  })

  it('空清单时说的是「怎么才会有东西」，不是「没有匹配」', async () => {
    await openProjects()
    expect(rowEls()).toHaveLength(0)
    expect(statusText()).toBe('还没有别的项目：先用「文件夹…」打开一个，换过一次之后这里就有东西了')

    type('zzz')
    await flush()
    expect(statusText()).toBe('没有匹配的最近项目')
  })

  it('从项目切到 Cmd+P：那一次必须把索引补建上', async () => {
    await openProjects()
    expect(ipc.indexProject).not.toHaveBeenCalled()

    // 浮层已经开着，`show` 走的是「换一个意图」那条分支——它不重建索引，
    // 但项目模式压根没建过，所以这里靠 `indexed()` 补一次，否则列表空空如也
    await panel.show()
    await flush()
    expect(ipc.indexProject).toHaveBeenCalledTimes(1)
    expect(input().placeholder).toBe('按名字找文件…（:42 跳行，@ 列标题）')
  })
})
