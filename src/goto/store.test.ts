import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, createSignal } from 'solid-js'

/**
 * `Cmd+P` 浮层 store 的单测：异步与四种意图这一半。
 *
 * 结构性的部分（输入怎么解析成意图、标题怎么从语法树里抠出来、方向键落到哪一行）分别在
 * `./query.test.ts`、`./symbols.test.ts` 里钉过了。这里测的是**什么时候去问索引、
 * 回来的结果放哪、哪一次的结果该被丢掉**。
 *
 * 本文件最要紧的是两组序号：
 *
 * - `seq`（查询序号）：每个按键都发一次 `query_project`，而 IPC 的返回顺序不保证与
 *   发出顺序一致。慢的那一次盖掉快的那一次，表现是「删掉一个字符，列表却变回了更窄的
 *   那个结果」——不报错，只是对不上。那几条用例用 deferred 把时序掰开来复现。
 * - `epoch`（展开世代号）：`show()` 里有一次 `await indexProject`，用户完全可能在那
 *   40–205ms 里 Escape 再按一次 `Cmd+P`。前一次展开的续半截要是写进了后一次，
 *   浮层显示的是一份属于**另一次**展开的账。
 *
 * 假掉的是 `indexProject` / `queryProject` / `describeTreeError`（都在 `../ipc/project`）
 * ——node 环境里没有 Tauri 运行时。`describeTreeError` 也一并假掉：它自己在
 * `src/ipc/project.test.ts` 里测过，这里只关心「错误有没有落到 `error` 上」。
 */

/**
 * ⚠️ 桩都写了完整的函数签名，不是裸 `vi.fn()`。
 * 裸的话 `.mock.calls` 的元素是 `any`，于是每一处 `calls[0][1]` 都是一次
 * unsafe member access——`pnpm lint` 是门禁的一部分，这里过不了就提交不了。
 *
 * 签名里直接用 `IndexStats` / `FileQuery` 是安全的：类型在编译时被擦掉，
 * `vi.hoisted` 的工厂搬到 import 之前也不会引用到任何运行时值。
 */
const { ipc } = vi.hoisted(() => ({
  ipc: {
    indexProject: vi.fn<(roots: readonly string[]) => Promise<IndexStats>>(),
    queryProject: vi.fn<(roots: readonly string[], needle: string, recent: string[]) => Promise<FileQuery>>(),
    describeTreeError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
  },
}))

vi.mock('../ipc/project', () => ipc)

import type { FileMatch, FileQuery, IndexStats } from '../ipc/project'
import type { SymbolTable } from './symbols'
import {
  createQuickOpen,
  isQuickOpenKey,
  moveSelection,
  QUICK_OPEN_ROW_HEIGHT,
  type Commit,
  type QuickOpen,
  type QuickOpenOptions,
} from './store'

/**
 * 造一个「拒绝掉、且拒绝值是纯对象」的 promise。
 *
 * ⚠️ 这条 eslint 豁免是必需的，不是偷懒：Tauri 的 `invoke` 在 Rust 侧返回 `Err` 时，
 * 抛给前端的就是**序列化后的那个对象**，不是 `Error` 实例。`describeTreeError` 正是按
 * `{ kind, ... }` 去认它的。桩要是为了满足 lint 而改成 `new Error(...)`，
 * 这组测试就不再描述真实行为了——它们会全绿，而线上照样炸。
 */
function rejected<T>(payload: unknown): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 见上
  return Promise.reject(payload)
}

/** 一个能自己决定什么时候 settle 的 promise，用来把「谁先回来」两种时序分开 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * 把在飞的 promise 冲干净。
 *
 * `show()` 之后的那一次查询是 effect 里 `void queryFiles(...)` 发出去的，
 * 谁都不等它。用 `setTimeout` 而不是 `await Promise.resolve()`：后者只推进一个微任务，
 * 而「`show` → `setReady` → effect → `queryProject` → 写回信号」这条链上有好几拍。
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function stats(overrides: Partial<IndexStats> = {}): IndexStats {
  return { files: 120, unreadable: 0, truncated: false, elapsedMs: 3, ...overrides }
}

function match(rel: string, rootIndex = 0): FileMatch {
  return { rel, path: `/repo/${rel}`, score: 7, rootIndex }
}

/** `total` 刻意可以大于 `matches.length`：那正是「还有更多没显示」的线上形状 */
function queryOf(rels: string[], total?: number): FileQuery {
  const matches = rels.map(match)
  return { matches, total: total ?? matches.length }
}

let root: string | null
/** 根清单那个 signal 的写入端，由 `mount` 赋值。用例一律走 `setRootAt`，不直接碰它 */
let setRoot: (value: readonly string[]) => void
/**
 * 最近项目清单（`Cmd+Shift+O` 的数据源）。
 *
 * 刻意是普通变量而不是 signal：store 那一边读它的时候包了 `untrack`
 * （理由写在 `apply()` 里），所以响应式对它没有任何作用，用 signal 只是多一层噪音
 */
let projects: (readonly string[])[]
let recent: string[]
/** `symbols()` 的返回值。默认是「一份没有标题的 Markdown」 */
let table: SymbolTable | null
let committed: Commit[]
let panel: QuickOpen
/** `createQuickOpen` 里有三个 `createMemo`；不在 root 里建，它们永远不会被释放 */
let dispose: (() => void) | undefined

function mount(extra: Partial<QuickOpenOptions> = {}) {
  committed = []
  dispose = createRoot((teardown) => {
    // ⚠️ 根清单走 signal 而不是直接读那个模块变量：`footer` / `warning` 是 `createMemo`，
    // 而 memo 只在**响应式**依赖变化时重算。真实宿主注入的是 `tree.roots`（memo），
    // 脚手架里用普通变量的话「文件夹被关掉」这件事就测不出来
    const [rootsSignal, setRootsSignal] = createSignal<readonly string[]>(root === null ? [] : [root])
    setRoot = setRootsSignal
    panel = createQuickOpen({
      roots: rootsSignal,
      recent: () => recent,
      recentProjects: () => projects,
      symbols: () => table,
      commit: async (action) => void committed.push(action),
      ...extra,
    })
    return teardown
  })
}

/**
 * 换工作区。⚠️ 一律走这个函数，别直接给 `root` 赋值——见 `mount` 里那条注释。
 * 收单个字符串是为了让绝大多数用例不必改写；收数组的那些用例在验多根
 */
function setRootAt(value: string | readonly string[] | null) {
  const list = value === null ? [] : typeof value === 'string' ? [value] : value
  root = typeof value === 'string' ? value : null
  setRoot(list)
}

beforeEach(() => {
  ipc.indexProject.mockReset()
  ipc.queryProject.mockReset()
  ipc.indexProject.mockResolvedValue(stats())
  ipc.queryProject.mockResolvedValue(queryOf([]))
  root = '/repo'
  recent = []
  projects = []
  table = { kind: 'headings', items: [] }
  mount()
})

afterEach(() => {
  dispose?.()
  dispose = undefined
})

/** 展开并等在飞的 IPC 落地 */
async function open(seed?: string) {
  await panel.show(seed)
  await flush()
}

/** 改输入框并等在飞的 IPC 落地 */
async function type(text: string) {
  panel.setRaw(text)
  await flush()
}

/** 列表的紧凑视图。断言顺序时比整对象好读 */
function texts(): string[] {
  return panel.rows().map((r) => r.text)
}

/** 第 n 次 `queryProject` 收到的搜索词 */
function sentNeedle(call = -1): string {
  const calls = ipc.queryProject.mock.calls
  const at = call < 0 ? calls.length + call : call
  const needle = calls[at]?.[1]
  if (needle === undefined) throw new Error(`第 ${at} 次 queryProject 没有带搜索词`)
  return needle
}

describe('展开与建索引', () => {
  it('展开时建一次索引，建好之后自动拿空搜索词查一遍', async () => {
    await open()
    // ⚠️ M2-F 起两个命令收的都是 `roots` **数组**，单根时是长度为 1 的数组。
    // 于是 `mock.calls` 多套了一层方括号——`[['/repo']]` 而不是 `['/repo']`
    expect(ipc.indexProject.mock.calls).toEqual([[['/repo']]])
    expect(ipc.queryProject.mock.calls).toEqual([[['/repo'], '', []]])
    expect(panel.visible()).toBe(true)
  })

  it('多根工作区：整份根清单原样递过去，一次展开只建一次索引', async () => {
    setRootAt(['/repo', '/notes', '/docs'])
    await open()
    // ⚠️ Rust 侧收 `roots: Vec<String>` 之后是**逐个根**建索引再合并的，
    // 所以前端必须一次把全清单发过去；发三次 `indexProject` 会得到三份互不相干的缓存
    expect(ipc.indexProject).toHaveBeenCalledTimes(1)
    expect(ipc.indexProject.mock.calls).toEqual([[['/repo', '/notes', '/docs']]])
    expect(ipc.queryProject.mock.calls).toEqual([[['/repo', '/notes', '/docs'], '', []]])
  })

  it('索引在建的那一段时间如实说「正在建索引…」，并且不去查', async () => {
    const building = deferred<IndexStats>()
    ipc.indexProject.mockReturnValue(building.promise)
    const shown = panel.show()

    expect(panel.visible()).toBe(true)
    expect(panel.footer()).toBe('正在建索引…')
    expect(panel.rows()).toEqual([])
    expect(ipc.queryProject).not.toHaveBeenCalled()
    // ⚠️ `busy` 在这段里是 false：它说的是「查询在飞」，而「索引在建」由 footer 说。
    // 两个都亮的话组件那边就得分清谁是谁，而它们本来就是两件事
    expect(panel.busy()).toBe(false)

    building.resolve(stats())
    await shown
    await flush()
    expect(panel.footer()).toBe('这个项目里没有文件')
  })

  it('MRU 每次现读，不是展开那一刻缓存下来的', async () => {
    await open()
    expect(ipc.queryProject.mock.calls[0]?.[2]).toEqual([])
    recent = ['/repo/a.md']
    await type('a')
    expect(sentNeedle()).toBe('a')
    expect(ipc.queryProject.mock.calls.at(-1)?.[2]).toEqual(['/repo/a.md'])
  })

  it('没有项目根：不建索引、不查询，只说该先打开一个文件夹', async () => {
    setRootAt(null)
    await open()
    expect(ipc.indexProject).not.toHaveBeenCalled()
    expect(ipc.queryProject).not.toHaveBeenCalled()
    expect(panel.footer()).toBe('先打开一个文件夹，才能按名字找文件')
  })

  it('浮层开着的时候关掉文件夹，脚上那一句跟着换', async () => {
    await open()
    setRootAt(null)
    await type('a')
    expect(ipc.queryProject).toHaveBeenCalledTimes(1)
    expect(panel.rows()).toEqual([])
    expect(panel.footer()).toBe('先打开一个文件夹，才能按名字找文件')
  })

  it('索引被二十万那个上限截断时单独一行警告', async () => {
    ipc.indexProject.mockResolvedValue(stats({ truncated: true, files: 200000 }))
    await open()
    expect(panel.warning()).toBe('文件数撞到上限，这份索引不全：找不到的文件可能只是没被收进来，换个词或去侧边栏翻')
  })

  it('那句警告只在文件模式下出现：`:42` 与 `@标题` 压根不问索引', async () => {
    ipc.indexProject.mockResolvedValue(stats({ truncated: true }))
    await open()
    expect(panel.warning()).not.toBeNull()

    await type(':12')
    expect(panel.warning()).toBeNull()

    await type('@')
    expect(panel.warning()).toBeNull()

    await type('a')
    expect(panel.warning()).not.toBeNull()
  })

  it('关掉浮层再展开会重新查一遍，即便输入框里还是一个字都没有', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md']))
    await open()
    expect(texts()).toEqual(['a.md'])

    panel.hide()
    // 模拟「在 Finder 里新建了一个文件」：索引重建，于是这一次多出一条
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    expect(texts()).toEqual(['a.md', 'b.md'])
    expect(ipc.indexProject).toHaveBeenCalledTimes(2)
  })

  it('浮层已经开着时再按一次只是换意图，不重建索引', async () => {
    await open()
    const before = panel.focusRequest()
    await panel.show('@')
    await flush()

    expect(ipc.indexProject).toHaveBeenCalledTimes(1)
    expect(panel.raw()).toBe('@')
    // 焦点那一下必须再触发一次，否则「浮层开着但焦点在编辑器里」时就抢不回来
    expect(panel.focusRequest()).toBe(before + 1)
  })

  it('展开时把上一次的现场清干净', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md', 'c.md']))
    await open()
    expect(panel.key('ArrowDown', 10)).toBe(1)
    expect(panel.key('ArrowDown', 10)).toBe(2)
    panel.hide()

    await open()
    expect(panel.raw()).toBe('')
    expect(panel.selected()).toBe(0)
    expect(panel.error()).toBeNull()
    expect(panel.busy()).toBe(false)
  })

  it('建索引途中关掉再展开：前一次的续半截不会写进后一次', async () => {
    const first = deferred<IndexStats>()
    const second = deferred<IndexStats>()
    ipc.indexProject.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const firstShow = panel.show()
    panel.hide()
    const secondShow = panel.show()
    expect(ipc.indexProject).toHaveBeenCalledTimes(2)

    // 先让**作废的那一次**回来，还带着一份「被截断了」的账
    first.resolve(stats({ truncated: true, files: 200000 }))
    await firstShow
    await flush()
    expect(panel.footer()).toBe('正在建索引…')
    expect(panel.warning()).toBeNull()

    second.resolve(stats({ truncated: false }))
    await secondShow
    await flush()
    expect(panel.footer()).toBe('这个项目里没有文件')
    expect(panel.warning()).toBeNull()
  })

  it('建索引失败不挡住浮层：`@标题` 那一路照样能用，那句错误留着', async () => {
    ipc.indexProject.mockReturnValue(rejected<IndexStats>({ kind: 'BadRoot', path: '/repo' }))
    table = { kind: 'headings', items: [{ name: '安装', level: 1, pos: 0 }] }

    await open('@')
    expect(panel.error()).toBe('模拟错误：{"kind":"BadRoot","path":"/repo"}')
    expect(panel.footer()).toBe('1 个标题')
    expect(texts()).toEqual(['安装'])
    expect(panel.visible()).toBe(true)
  })

  it('建索引失败之后查询自己会再建一次：它成功了就把那句错误换掉', async () => {
    ipc.indexProject.mockReturnValue(rejected<IndexStats>({ kind: 'BadRoot', path: '/repo' }))
    ipc.queryProject.mockResolvedValue(queryOf(['a.md']))

    await open()
    // `query_project` 在缓存空的时候会自己建一次（见 src-tauri/src/commands.rs 的
    // `query_cached`），所以它成功就意味着索引其实是好的——那句错误已经过期了
    expect(panel.error()).toBeNull()
    expect(texts()).toEqual(['a.md'])
  })
})

describe('四种意图', () => {
  it('文件模式：一行一条路径，落地动作带着绝对路径', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['src/a.ts']))
    await open()
    expect(panel.rows()).toEqual([
      {
        text: 'src/a.ts',
        root: '',
        indent: 0,
        title: '/repo/src/a.ts',
        action: { kind: 'openFile', path: '/repo/src/a.ts', line: null },
      },
    ])
  })

  it('⚠️ 多根：候选前面挂上它属于哪个根，而且是按起飞那一刻的清单解释的', async () => {
    setRootAt(['/repo', '/notes'])
    ipc.queryProject.mockResolvedValue({ matches: [match('src/a.ts'), match('README.md', 1)], total: 2 })
    await open()

    expect(panel.rows().map((r) => r.root)).toEqual(['repo', 'notes'])

    // 结果已经在手上了，用户此刻换掉工作区。`rootIndex: 1` 在新清单里已经越界，
    // 现读的话这两行的前缀会变成空串（或者更糟：变成后来加进来的那个根），
    // 而按 Enter 打开的又确实是对的文件——所以用户连怀疑都不会怀疑
    setRootAt(['/repo'])
    expect(panel.rows().map((r) => r.root)).toEqual(['repo', 'notes'])
  })

  it('单根时 root 恒为空串：那时每一行前面都挂着同一个项目名，纯噪音', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['src/a.ts', 'README.md']))
    await open()

    expect(panel.rows().map((r) => r.root)).toEqual(['', ''])
  })

  it('`file.ts:42`：搜索词砍掉行号，而每一行都带上那个行号', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['src/a.ts', 'src/b.ts']))
    await open()
    await type('src/a.ts:42')

    expect(sentNeedle()).toBe('src/a.ts')
    expect(panel.rows()).toHaveLength(2)
    for (const row of panel.rows()) {
      expect(row.action).toEqual({ kind: 'openFile', path: `/repo/${row.text}`, line: 42 })
    }
  })

  it('`:42` 没有列表，footer 就是全部，Enter 直接落地', async () => {
    await open()
    expect(ipc.queryProject).toHaveBeenCalledTimes(1)

    await type(':42')
    expect(panel.rows()).toEqual([])
    expect(panel.footer()).toBe('跳到第 42 行（Enter 落地）')
    // ⛔ 行号模式一次 IPC 都不该发：它要的东西（当前文档的行）已经在内存里了
    expect(ipc.queryProject).toHaveBeenCalledTimes(1)

    expect(panel.key('Enter', 10)).toBeNull()
    expect(committed).toEqual([{ kind: 'gotoLine', line: 42 }])
    expect(panel.visible()).toBe(false)
  })

  it('`@` 列标题：缩进就是级别，落点是标题起点', async () => {
    table = {
      kind: 'headings',
      items: [
        { name: '安装', level: 1, pos: 0 },
        { name: '用法', level: 3, pos: 40 },
      ],
    }
    await open('@')

    // 标题那一栏的 `root` 恒为空串：它列的是**当前文档**里的标题，与项目根无关
    expect(panel.rows()).toEqual([
      { text: '安装', root: '', indent: 1, title: '安装', action: { kind: 'gotoPos', pos: 0 } },
      { text: '用法', root: '', indent: 3, title: '用法', action: { kind: 'gotoPos', pos: 40 } },
    ])
    expect(panel.footer()).toBe('2 个标题')
    expect(ipc.queryProject).not.toHaveBeenCalled()
  })

  it('`@` 后面接着打字就地过滤，一次 IPC 都不发', async () => {
    table = {
      kind: 'headings',
      items: [
        { name: '安装', level: 1, pos: 0 },
        { name: '升级', level: 2, pos: 10 },
      ],
    }
    await open('@')
    expect(texts()).toEqual(['安装', '升级'])

    await type('@安')
    expect(texts()).toEqual(['安装'])
    expect(panel.footer()).toBe('1 个标题')
    expect(ipc.queryProject).not.toHaveBeenCalled()
  })

  it('一个标题都没匹配上时说的是「没有匹配的标题」，不是「没有符号表」', async () => {
    table = { kind: 'headings', items: [{ name: '安装', level: 1, pos: 0 }] }
    await open('@zzz')
    expect(panel.rows()).toEqual([])
    expect(panel.footer()).toBe('这份文档里没有匹配的标题')
  })

  it('一份没有标题的 Markdown 不等于「这个语言没有符号表」', async () => {
    table = { kind: 'headings', items: [] }
    await open('@')
    expect(panel.footer()).toBe('这份文档里没有匹配的标题')
  })

  it('编辑器还没挂上来时说的是「没有打开的文档」', async () => {
    table = null
    await open('@')
    expect(panel.rows()).toEqual([])
    expect(panel.footer()).toBe('没有打开的文档')
  })

  it('⛔ 非 Markdown 如实说没有符号表，绝不退化成全文搜索', async () => {
    table = { kind: 'unsupported', label: 'TypeScript' }
    await open('@')
    expect(panel.rows()).toEqual([])
    expect(panel.footer()).toBe('TypeScript 还没有符号表')
    // 退化成搜索的话这里会有一次调用，而用户按 `Cmd+R` 想要的是**结构**，
    // 两个入口一个行为是最难发现的那种坏
    expect(ipc.queryProject).not.toHaveBeenCalled()
  })

  it('从 `@` 退回到空输入会回到文件模式', async () => {
    table = { kind: 'headings', items: [{ name: '安装', level: 1, pos: 0 }] }
    ipc.queryProject.mockResolvedValue(queryOf(['a.md']))
    await open('@')
    expect(texts()).toEqual(['安装'])

    await type('')
    expect(texts()).toEqual(['a.md'])
    expect(sentNeedle()).toBe('')
  })
})

describe('命中总数与措辞', () => {
  it('总数多于显示条数时，脚上那一句让人知道该把词写窄一点', async () => {
    ipc.queryProject.mockResolvedValue({ matches: [match('a.md'), match('b.md')], total: 137 })
    await open()
    expect(panel.footer()).toBe('共 137 个匹配，显示前 2 个——把词写窄一点')
  })

  it('没超过上限时只报个数', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    expect(panel.footer()).toBe('2 个匹配')
  })

  it('一个都没命中时，空搜索词与有搜索词说两句不同的话', async () => {
    await open()
    expect(panel.footer()).toBe('这个项目里没有文件')
    await type('zzz')
    expect(panel.footer()).toBe('没有匹配的文件')
  })
})

describe('查询的序号', () => {
  it('慢的响应不能盖掉快的', async () => {
    await open()
    const slow = deferred<FileQuery>()
    const fast = deferred<FileQuery>()
    ipc.queryProject.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)

    panel.setRaw('ab')
    panel.setRaw('abc')
    await flush()

    fast.resolve(queryOf(['new.md']))
    await flush()
    expect(texts()).toEqual(['new.md'])

    slow.resolve(queryOf(['old.md']))
    await flush()
    expect(texts()).toEqual(['new.md'])
    // 作废的那一次回来时不许再把 `busy` 拨回去：快的那一次已经把它关了
    expect(panel.busy()).toBe(false)
  })

  it('关掉浮层作废在飞的查询', async () => {
    await open()
    const late = deferred<FileQuery>()
    ipc.queryProject.mockReturnValueOnce(late.promise)

    panel.setRaw('x')
    await flush()
    expect(panel.busy()).toBe(true)

    panel.hide()
    late.resolve(queryOf(['late.md']))
    await flush()
    expect(panel.rows()).toEqual([])
    expect(panel.busy()).toBe(false)
  })

  it('查询失败清空列表并说人话：留着旧列表的话 Enter 会打开一个没选的文件', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    expect(texts()).toEqual(['a.md', 'b.md'])

    ipc.queryProject.mockReturnValueOnce(rejected<FileQuery>({ kind: 'BadRoot', path: '/repo' }))
    await type('zzz')
    expect(panel.rows()).toEqual([])
    expect(panel.error()).toBe('模拟错误：{"kind":"BadRoot","path":"/repo"}')
    // 错误已经就地说了一句，footer 再重复一遍「没有匹配的文件」就是撒谎
    expect(panel.footer()).toBe('')
  })

  it('`busy` 只在查询在飞的那一段时间为真', async () => {
    await open()
    expect(panel.busy()).toBe(false)

    const pending = deferred<FileQuery>()
    ipc.queryProject.mockReturnValueOnce(pending.promise)
    panel.setRaw('x')
    await flush()
    expect(panel.busy()).toBe(true)

    pending.resolve(queryOf([]))
    await flush()
    expect(panel.busy()).toBe(false)
  })
})

describe('落地', () => {
  it('Enter 打开选中的那一行并收起浮层', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    expect(panel.key('ArrowDown', 10)).toBe(1)
    expect(panel.key('Enter', 10)).toBeNull()
    expect(committed).toEqual([{ kind: 'openFile', path: '/repo/b.md', line: null }])
    expect(panel.visible()).toBe(false)
  })

  it('空列表上按 Enter 什么都不做，也不收起浮层', async () => {
    await open()
    expect(panel.rows()).toEqual([])
    expect(panel.key('Enter', 10)).toBeNull()
    expect(committed).toEqual([])
    // 收起的话用户会以为「按了 Enter 就跳过去了」，而其实一个字符都没动
    expect(panel.visible()).toBe(true)
    expect(panel.footer()).toBe('这个项目里没有文件')
  })

  it('点一行就落地，不需要先选中', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    expect(panel.selected()).toBe(0)
    panel.clickRow(1)
    expect(committed).toEqual([{ kind: 'openFile', path: '/repo/b.md', line: null }])
    expect(panel.visible()).toBe(false)
  })

  it('点越界的下标什么都不做', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md']))
    await open()
    panel.clickRow(99)
    expect(committed).toEqual([])
    expect(panel.visible()).toBe(true)
  })

  it('标题行落地成 `gotoPos`，行号模式落地成 `gotoLine`', async () => {
    table = { kind: 'headings', items: [{ name: '安装', level: 1, pos: 128 }] }
    await open('@')
    panel.clickRow(0)
    expect(committed).toEqual([{ kind: 'gotoPos', pos: 128 }])

    await open()
    await type(':7')
    panel.key('Enter', 10)
    expect(committed).toEqual([
      { kind: 'gotoPos', pos: 128 },
      { kind: 'gotoLine', line: 7 },
    ])
  })
})

describe('选中', () => {
  it('方向键回新的下标，好让组件把它滚进可视区', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md', 'c.md']))
    await open()
    expect(panel.key('ArrowDown', 10)).toBe(1)
    expect(panel.selected()).toBe(1)
    expect(panel.key('End', 10)).toBe(2)
    expect(panel.key('ArrowUp', 10)).toBe(1)
    expect(panel.key('Home', 10)).toBe(0)
  })

  it('列表为空时方向键回 null，组件据此不吃掉那个键', async () => {
    await open()
    expect(panel.key('ArrowDown', 10)).toBeNull()
    expect(panel.key('ArrowUp', 10)).toBeNull()
    expect(panel.key('Home', 10)).toBeNull()
  })

  it('Escape 收起浮层，不落地任何东西', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md']))
    await open()
    expect(panel.key('Escape', 10)).toBeNull()
    expect(panel.visible()).toBe(false)
    expect(committed).toEqual([])
  })

  it('`select` 只改选中，不落地也不收起', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md', 'c.md']))
    await open()
    panel.select(2)
    expect(panel.selected()).toBe(2)
    expect(committed).toEqual([])
    expect(panel.visible()).toBe(true)
  })

  it('`select` 越界一律忽略，不夹到最后一行', async () => {
    ipc.queryProject.mockResolvedValue(queryOf(['a.md', 'b.md']))
    await open()
    panel.select(1)
    panel.select(99)
    panel.select(-1)
    // 夹到最后一行的话，高亮会跳到一个用户没指着的地方；而越界只可能是列表刚被换短了
    expect(panel.selected()).toBe(1)
  })
})

describe('moveSelection：纯函数', () => {
  it('上箭头在第一行停住，下箭头在最后一行停住，都不绕回另一头', () => {
    expect(moveSelection(5, 0, 'ArrowUp', 10)).toBe(0)
    expect(moveSelection(5, 4, 'ArrowDown', 10)).toBe(4)
    expect(moveSelection(5, 2, 'ArrowUp', 10)).toBe(1)
    expect(moveSelection(5, 2, 'ArrowDown', 10)).toBe(3)
  })

  it('Home 与 End 落在两端', () => {
    expect(moveSelection(5, 2, 'Home', 10)).toBe(0)
    expect(moveSelection(5, 2, 'End', 10)).toBe(4)
  })

  it('翻页用调用方给的 pageSize，并且夹在两端', () => {
    expect(moveSelection(50, 20, 'PageDown', 12)).toBe(32)
    expect(moveSelection(50, 20, 'PageUp', 12)).toBe(8)
    expect(moveSelection(50, 45, 'PageDown', 12)).toBe(49)
    expect(moveSelection(50, 3, 'PageUp', 12)).toBe(0)
  })

  it('pageSize 是 0 或负数时按一页一行算：jsdom 里量不到高度，那不是 bug', () => {
    expect(moveSelection(10, 5, 'PageDown', 0)).toBe(6)
    expect(moveSelection(10, 5, 'PageUp', -8)).toBe(4)
  })

  it('零行时一律回 0，不出现 -1 这种下标', () => {
    expect(moveSelection(0, 0, 'ArrowDown', 10)).toBe(0)
    expect(moveSelection(0, 3, 'End', 10)).toBe(0)
  })

  it('传进来的选中先夹回范围：列表刚被换短时不该算出越界的下标', () => {
    expect(moveSelection(3, 99, 'ArrowDown', 10)).toBe(2)
    expect(moveSelection(3, -4, 'ArrowUp', 10)).toBe(0)
  })

  it('Enter 与 Escape 不改选中：前者落地、后者收起，都由 `key()` 单独处理', () => {
    expect(moveSelection(5, 2, 'Enter', 10)).toBe(2)
    expect(moveSelection(5, 2, 'Escape', 10)).toBe(2)
  })
})

describe('isQuickOpenKey', () => {
  it('认那八个键', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Enter', 'Escape']) {
      expect(isQuickOpenKey(key)).toBe(true)
    }
  })

  it('不认的键放回去给浏览器/编辑器', () => {
    // ⚠️ `Tab` 不在里面是刻意的：浮层里只有一格输入框，Tab 该走浏览器自己的焦点顺序
    for (const key of ['a', 'Tab', 'ArrowLeft', 'ArrowRight', 'enter', 'Backspace', '']) {
      expect(isQuickOpenKey(key)).toBe(false)
    }
  })
})

describe('行高', () => {
  it('浮层的行高是 20，样式表里只许引用 `--vela-palette-row-height`', () => {
    // 与 `RESULT_ROW_HEIGHT` 同值而不是共用一个常量：两者相等是巧合，
    // 共用会让「改一个列表的行高」顺手改掉另一个（见 store.ts 上那条注释）
    expect(QUICK_OPEN_ROW_HEIGHT).toBe(20)
  })
})

describe('最近项目（Cmd+Shift+O）', () => {
  /** 展开项目模式。刻意与 `open()` 分开：那一个是为「要等索引」的那一路写的 */
  async function openProjects(seed = '') {
    await panel.show(seed, 'project')
    await flush()
  }

  it('⚠️ 一次 IPC 都不发：清单本来就在内存里，于是这个键是当场出东西的', async () => {
    projects = [['/Users/me/code/vela']]
    await openProjects()

    expect(ipc.indexProject).not.toHaveBeenCalled()
    expect(ipc.queryProject).not.toHaveBeenCalled()
    expect(panel.rows()).toHaveLength(1)
    expect(panel.footer()).toBe('1 个最近项目')
  })

  it('候选那几格：名字、父目录、悬停时一行一个完整路径', async () => {
    projects = [['/Users/me/code/vela', '/Users/me/notes']]
    await openProjects()

    expect(panel.rows()[0]).toEqual({
      text: 'vela +1',
      // 这一格放的是**父目录**：两个都叫 app 的项目只有它能分开
      root: '/Users/me/code',
      indent: 0,
      title: '/Users/me/code/vela\n/Users/me/notes',
      action: { kind: 'openWorkspace', roots: ['/Users/me/code/vela', '/Users/me/notes'] },
    })
  })

  it('打字过滤的是完整路径，大小写不敏感', async () => {
    projects = [['/Users/me/work/app'], ['/Users/me/code/vela']]
    await openProjects()
    expect(texts()).toEqual(['app', 'vela'])

    await type('WORK')
    expect(texts()).toEqual(['app'])
    expect(panel.footer()).toBe('1 个最近项目')
  })

  it('⚠️ 项目模式里 `:42` 与 `@` 都只是过滤词：那一刻跳行与列标题的文法压根不成立', async () => {
    projects = [['/Users/me/code/vela']]
    await openProjects()

    await type(':42')
    expect(panel.footer()).toBe('没有匹配的最近项目')
    expect(panel.rows()).toEqual([])
    // 空列表上按 Enter 什么都不做，也**不收起**——与文件模式同一条规矩
    expect(panel.key('Enter', 1)).toBeNull()
    expect(committed).toEqual([])
    expect(panel.visible()).toBe(true)

    await type('@')
    expect(panel.footer()).toBe('没有匹配的最近项目')
  })

  it('Enter 落地的是**整份**根清单，多根一条都不少', async () => {
    projects = [['/Users/me/code/vela', '/Users/me/notes'], ['/Users/me/docs']]
    await openProjects()

    panel.select(0)
    expect(panel.key('Enter', 1)).toBeNull()

    // 只递第一个根的话切回来就少一个，而「我刚才那个 notes 呢」这件事没有任何提示
    expect(committed).toEqual([{ kind: 'openWorkspace', roots: ['/Users/me/code/vela', '/Users/me/notes'] }])
    expect(panel.visible()).toBe(false)
  })

  it('点一行与按 Enter 是同一件事', async () => {
    projects = [['/Users/me/docs']]
    await openProjects()

    panel.clickRow(0)
    expect(committed).toEqual([{ kind: 'openWorkspace', roots: ['/Users/me/docs'] }])
    expect(panel.visible()).toBe(false)
  })

  it('空清单与「过滤到没有」是两句话', async () => {
    projects = []
    await openProjects()
    expect(panel.footer()).toBe('还没有别的项目：先用「文件夹…」打开一个，换过一次之后这里就有东西了')

    projects = [['/Users/me/code/vela']]
    await type('zzz')
    expect(panel.footer()).toBe('没有匹配的最近项目')
  })

  it('⚠️ 浮层开着的时候从项目切到 Cmd+P：那一次必须补建索引', async () => {
    projects = [['/Users/me/docs']]
    await openProjects()
    expect(ipc.indexProject).not.toHaveBeenCalled()

    ipc.queryProject.mockResolvedValue(queryOf(['src/a.ts']))
    await panel.show()
    await flush()

    expect(ipc.indexProject).toHaveBeenCalledTimes(1)
    // 少了那一次补建，这里会是空的而浮层不报错——`ready` 早在项目模式里就是 true 了
    expect(texts()).toEqual(['src/a.ts'])
    expect(panel.kind()).toBe('goto')
  })

  it('反方向（Cmd+P → 项目）不重建索引：那一路压根不问索引', async () => {
    await open()
    expect(ipc.indexProject).toHaveBeenCalledTimes(1)

    projects = [['/Users/me/docs']]
    await openProjects()
    expect(ipc.indexProject).toHaveBeenCalledTimes(1)
    expect(texts()).toEqual(['docs'])
  })

  it('kind() 跟着**按键**走，输入框里的字改不动它', async () => {
    await openProjects('@')
    expect(panel.kind()).toBe('project')
    expect(panel.footer()).not.toContain('标题')

    await open()
    expect(panel.kind()).toBe('goto')
  })

  it('切一次模式就重算一次列表，哪怕输入框里一个字符都没变', async () => {
    projects = [['/Users/me/docs']]
    ipc.queryProject.mockResolvedValue(queryOf(['src/a.ts']))

    await openProjects()
    expect(texts()).toEqual(['docs'])

    await panel.show('')
    await flush()
    // `raw` 前后都是空串，只有 `overlay` 变了：少了那一个依赖，
    // 用户看到的就是**上一个模式**的那几行
    expect(texts()).toEqual(['src/a.ts'])
  })
})
