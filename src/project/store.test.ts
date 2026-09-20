import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'solid-js'

/**
 * 项目树的单测：协调层（`./store.ts`）+ 每根实例（`./rootTree.ts`）合起来的
 * 「异步与可变状态」这一半。
 *
 * 结构性的部分（扁平化、窗口算术、方向键落点）在 `./tree.test.ts` 里已经钉过了，
 * 这里只测**什么时候去读、读回来放哪、在飞的请求什么时候该被丢掉**。
 * 两层不分开测：`createRootTree` 只被协调层用，用例一律从 `createProjectTree` 打进去，
 * 于是「协调层派活派错了根」与「实例自己读错了层」会在同一条用例里一起变红。
 *
 * 假的是 `listDir`、五个文件操作封装与原生目录对话框——jsdom 里没有 Tauri 运行时。
 * `describeTreeError` 也一并假掉：它自己在 `src/ipc/project.test.ts` 里测过，
 * 这里只关心「错误有没有落到对应的那一层上」。
 *
 * ⚠️ 桩里那五个一个都不能少：`rootTree.ts` 是从这个模块**按名字**导入它们的，
 * 少一个就在被调用那一刻变成 `undefined is not a function`——而 vitest 对
 * 「导入了但没调用」是不报错的，所以漏掉的话现有用例照样全绿，坑留给下一条用例。
 */

const { ipc, dialog } = vi.hoisted(() => ({
  ipc: {
    listDir: vi.fn(),
    createEntry: vi.fn(),
    renameEntry: vi.fn(),
    trashEntry: vi.fn(),
    revealEntry: vi.fn(),
    copyEntryPath: vi.fn(),
    describeTreeError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
  },
  dialog: { open: vi.fn() },
}))

vi.mock('../ipc/project', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)

import type { DirEntry, DirListing, EntryKind } from '../ipc/project'
import type { SessionProject } from '../ipc/session'
import {
  createProjectTree,
  MAX_RECENT_PROJECTS,
  MAX_RESTORED_EXPANDED,
  MAX_RESTORED_ROOTS,
  rememberWorkspace,
  sameWorkspace,
  type ProjectTree,
} from './store'
import { rowKey, type RowKey } from './tree'

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

/**
 * `rel` → 条目。`name` 从 `rel` 的最后一段抠出来。
 *
 * ⚠️ `path` 这里随手按 `/repo` 拼，**但 `installFs` 的桩会按当次请求的 `root` 重写它**。
 * 假文件系统表是按 `rel` 索引的（同一个 `src/main.rs` 在两个根里都存在），而 `path` 必须
 * 跟着根走：Rust 侧 `list_dir` 返回的 `DirEntry.path` 永远是 `root/rel`，
 * 而 `run({kind:'open'})` 用的正是这个 `path`——两个根里都写 `/repo/…` 的话，
 * 「点第二个根里的文件」会去开第一个根的文件
 */
function f(rel: string, isDir = false): DirEntry {
  return { name: rel.slice(rel.lastIndexOf('/') + 1), rel, path: `/repo/${rel}`, isDir }
}

const FS: Record<string, DirEntry[]> = {
  '': [f('src', true), f('README.md'), f('node_modules', true)],
  src: [f('src/main.rs'), f('src/deep', true)],
  'src/deep': [f('src/deep/a.ts')],
  node_modules: [f('node_modules/.pnpm', true)],
}

/** 每次 `listDir` 的 `(root, rel)`，按调用顺序 */
const calls: Array<[string, string]> = []

/** 装一个假文件系统。顺带清空 `calls` */
function installFs(fs: Record<string, DirEntry[]> = FS) {
  calls.length = 0
  ipc.listDir.mockImplementation((root: string, rel: string): Promise<DirListing> => {
    calls.push([root, rel])
    const entries = fs[rel]
    if (!entries) return rejected<DirListing>({ kind: 'not_found', path: `${root}/${rel}` })
    return Promise.resolve({ rel, entries: entries.map((e) => ({ ...e, path: `${root}/${e.rel}` })) })
  })
}

/**
 * 把在飞的 promise 冲干净。
 *
 * `run({kind:'open'|'expand'})` 是**故意**不等异步的（点一下不该卡住 UI），
 * 所以要断言它的后果就得先让微任务与宏任务各跑一轮。用 `setTimeout` 而不是
 * `await Promise.resolve()`：后者只推进一个微任务，而 `read` 里有两次 await。
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * 装一份 `FS` 的深拷贝。
 *
 * 写操作的用例要在「重读回来的结果」里反映自己刚造成的变化，也就是要往这个表里塞条目。
 * 直接改模块级的 `FS` 会漏给后面每一条用例——而漏出来的失败方式是一条与写操作无关的
 * 用例突然多出一行 `新建.md`，看起来像虚拟化坏了。
 */
function copyFs(fs: Record<string, DirEntry[]> = FS): Record<string, DirEntry[]> {
  return structuredClone(fs)
}

let opened: string[]
let tree: ProjectTree
/**
 * 协调层里那几个 `createMemo`（`roots`、`rows`）挂在这个所有者上；不在 root 里建，
 * 它们永远不会被释放。每个根实例的 memo 由协调层自己的 `createRoot` 管，
 * 移除根时连带释放——那件事在下面的多根用例里钉。
 */
let dispose: (() => void) | undefined

function mount() {
  opened = []
  dispose = createRoot((teardown) => {
    tree = createProjectTree({ openFile: async (path) => void opened.push(path) })
    return teardown
  })
}

function rels(): string[] {
  return tree.rows().map((r) => r.rel)
}

/** 第 `rootIndex` 个根的行。默认第 0 个，多根的用例显式传 */
function rowsOf(rootIndex = 0) {
  return tree.rows().filter((r) => r.rootIndex === rootIndex)
}

function row(rel: string, rootIndex = 0) {
  return tree.rows().find((r) => r.rel === rel && r.rootIndex === rootIndex)
}

/**
 * 第 0 个根里的一条身份。绝大多数用例只开一个根，`k('src')` 比每处都写
 * `rowKey(0, 'src')` 短；多根的用例（`describe('多根')`）一律把根序号写全。
 */
const k = (rel: string): RowKey => rowKey(0, rel)

/**
 * 第 0 个根的路径，没打开任何文件夹时是 null。
 *
 * ⚠️ 协调层上已经没有「当前那个 root」的访问器了（多根之下那句话不完整）。
 * 原来「root 是不是 null」说的是「有没有打开文件夹」，现在的说法是 `roots()` 是不是空数组，
 * 而这个 helper 把它收敛回一个可以和 `toBeNull()` / `toBe('/repo')` 直接比的值
 */
const firstRoot = (): string | null => tree.roots()[0] ?? null

/**
 * 选中那一行的 rel。
 *
 * ⚠️ 顺手把 `rootIndex` 钉在 0 上，而不是直接 `tree.selected()?.rel`：
 * 少盖一个根序号的回归在 rel 上完全看不出来，而它会让多根之下的选中落到另一个项目里。
 * 多根的用例要断言选中落在**哪个根**，那里直接读 `tree.selected()`
 */
function selectedRel(): string | null {
  const key = tree.selected()
  if (key === null) return null
  expect(key.rootIndex).toBe(0)
  return key.rel
}

/**
 * 存档里那一条。少写一层 `roots` 包装的用例会**编译不过**，所以这个 helper 的价值不在省事，
 * 而在让每条断言读起来仍然是「一个根、摊开了这几层」
 */
const saved = (root: string, expanded: string[]): SessionProject => ({ roots: [{ root, expanded }] })

beforeEach(() => {
  ipc.listDir.mockReset()
  // 五个写桩也要清：某条用例给 `createEntry` 装了一个「永不 settle」的 promise 来测
  // 「操作途中换掉工作区」，漏到下一条用例里去的话那条会一直挂着，而报错指向的是别的地方
  ipc.createEntry.mockReset()
  ipc.renameEntry.mockReset()
  ipc.trashEntry.mockReset()
  ipc.revealEntry.mockReset()
  ipc.copyEntryPath.mockReset()
  dialog.open.mockReset()
  installFs()
  mount()
})

afterEach(() => {
  dispose?.()
  dispose = undefined
})

describe('打开文件夹', () => {
  it('一开始什么都没有：没有 root、没有行', () => {
    expect(tree.roots()).toEqual([])
    expect(firstRoot()).toBeNull()
    expect(tree.rootName(0)).toBe('')
    // 越界不抛：侧边栏的标题与对话框文案都是「先算好字符串再决定显示什么」，
    // 让它抛就等于要求每个调用点自己先数一遍有几个根
    expect(tree.rootName(9)).toBe('')
    expect(tree.rows()).toEqual([])
    expect(calls).toEqual([])
  })

  it('openAt 读根一层，并把根默认摊开', async () => {
    await tree.openAt('/repo')
    expect(tree.roots()).toEqual(['/repo'])
    expect(firstRoot()).toBe('/repo')
    expect(calls).toEqual([['/repo', '']])
    // 根行 + 三个子项。打开一个文件夹却只看到一行、还得再点一次，那一下点击没有信息量
    expect(rels()).toEqual(['', 'src', 'README.md', 'node_modules'])
    expect(row('')?.expanded).toBe(true)
    expect(row('')?.depth).toBe(0)
    expect(row('src')?.depth).toBe(1)
  })

  it('rootName 是路径的最后一段', async () => {
    await tree.openAt('/Volumes/data/dev/Vela')
    expect(tree.rootName(0)).toBe('Vela')
  })

  it('dialog 要的是目录，给了路径就打开', async () => {
    dialog.open.mockResolvedValue('/repo')
    await tree.openViaDialog()
    // `directory: true` 是 `root` 唯一可能的来源，这两个选项就是那条前提本身
    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: true })
    expect(firstRoot()).toBe('/repo')
    expect(calls).toEqual([['/repo', '']])
  })

  it('dialog 取消了就什么都不动', async () => {
    dialog.open.mockResolvedValue(null)
    await tree.openViaDialog()
    expect(firstRoot()).toBeNull()
    expect(tree.rows()).toEqual([])
    expect(calls).toEqual([])
  })

  it('换一个文件夹时整个工作区被换掉，旧根的缓存一条不留', async () => {
    await tree.openAt('/repo')
    await tree.addRoot('/extra')
    await tree.toggle(k('src'))
    expect(tree.roots()).toEqual(['/repo', '/extra'])
    expect(rels()).toContain('src/main.rs')

    installFs({ '': [f('other.md')] })
    await tree.openAt('/other')
    // `openAt` 的语义是「换成这一个」而不是「追加」：两个旧根都得走。
    // 少扔一个的话侧边栏会同时显示三棵树，而用户的意图只是打开一个新文件夹
    expect(tree.roots()).toEqual(['/other'])
    expect(firstRoot()).toBe('/other')
    expect(calls).toEqual([['/other', '']])
    expect(rels()).toEqual(['', 'other.md'])
    expect(selectedRel()).toBeNull()
  })

  it('⚠️ 旧文件夹在飞的请求晚到时被丢掉，不会污染新树', async () => {
    let release: (() => void) | undefined
    ipc.listDir.mockImplementation((root: string, rel: string): Promise<DirListing> => {
      if (root === '/old') {
        return new Promise<DirListing>((resolve) => {
          release = () => resolve({ rel, entries: [f('stale-from-old-root')] })
        })
      }
      return Promise.resolve({ rel, entries: [f('fresh')] })
    })

    const pending = tree.openAt('/old')
    await tree.openAt('/new')
    expect(rels()).toEqual(['', 'fresh'])

    release!()
    await pending
    // 旧结果要是落地了，这里会多出一行 stale-from-old-root，而界面上看不出任何异常——
    // 两棵树的条目混在一起，用户只会觉得这棵树在说谎。
    // ⚠️ 挡住它的机制换过一次：原来是 `rootToken` 计数器对不上号就丢弃，现在是
    // 「旧根实例整个被扔掉、它那份 memo 不再挂在协调层上」。后者不依赖任何一处
    // 记得去比对计数器。这条用例与下面那条「晚到的成功不改新树」合起来钉住两个方向：
    // 读的结果污染不了行，写的结果也污染不了那份**跨根共享**的选中
    expect(rels()).toEqual(['', 'fresh'])
    expect(row('')?.loading).toBe(false)
  })

  it('close 之后回到「什么都没打开」，但不碰任何标签页', async () => {
    await tree.openAt('/repo')
    tree.close()
    expect(firstRoot()).toBeNull()
    expect(tree.rows()).toEqual([])
    expect(opened).toEqual([])
  })
})

describe('按需列举', () => {
  beforeEach(async () => {
    await tree.openAt('/repo')
  })

  it('摊开一层就再发一次 listDir，参数是那一层的 rel', async () => {
    await tree.toggle(k('src'))
    expect(calls).toEqual([
      ['/repo', ''],
      ['/repo', 'src'],
    ])
    expect(rels()).toEqual(['', 'src', 'src/main.rs', 'src/deep', 'README.md', 'node_modules'])
    expect(row('src/main.rs')?.depth).toBe(2)
  })

  it('⚠️ 折叠的层不递归进去：孙子目录压根没被请求过', async () => {
    await tree.toggle(k('src'))
    expect(calls.map((c) => c[1])).toEqual(['', 'src'])
  })

  it('收起再摊开不重读，缓存命中', async () => {
    await tree.toggle(k('src'))
    await tree.toggle(k('src')) // 收起
    expect(row('src')?.expanded).toBe(false)
    await tree.toggle(k('src')) // 再摊开
    expect(calls).toHaveLength(2)
    expect(rels()).toContain('src/main.rs')
  })

  it('摊开一个还没读回来的层时，那一行立刻标成 loading', async () => {
    let release: (() => void) | undefined
    ipc.listDir.mockImplementation((_root: string, rel: string): Promise<DirListing> => {
      if (rel !== 'src') return Promise.resolve({ rel, entries: [] })
      return new Promise<DirListing>((resolve) => {
        release = () => resolve({ rel, entries: FS['src']! })
      })
    })

    const pending = tree.toggle(k('src'))
    // toggle 的同步部分已经把 expanded 与 loading 都推上去了，不必等一个微任务
    expect(row('src')?.expanded).toBe(true)
    expect(row('src')?.loading).toBe(true)
    // 不补「读取中…」占位行：行数在数据到达前后不该跳，否则滚动条会抽动
    expect(rels()).toEqual(['', 'src', 'README.md', 'node_modules'])

    release!()
    await pending
    expect(row('src')?.loading).toBe(false)
    expect(rels()).toEqual(['', 'src', 'src/main.rs', 'src/deep', 'README.md', 'node_modules'])
  })

  it('两层同时摊开，两个结果各归各位', async () => {
    await Promise.all([tree.toggle(k('src')), tree.toggle(k('node_modules'))])
    expect(rels()).toEqual(['', 'src', 'src/main.rs', 'src/deep', 'README.md', 'node_modules', 'node_modules/.pnpm'])
  })

  it('refresh 重读所有摊开着的层', async () => {
    await tree.toggle(k('src'))
    calls.length = 0
    await tree.refresh()
    expect(calls.map((c) => c[1]).sort()).toEqual(['', 'src'])
  })

  it('refresh 跳过正在读的层，不把同一个请求排两遍队', async () => {
    let release: (() => void) | undefined
    ipc.listDir.mockImplementation((_root: string, rel: string): Promise<DirListing> => {
      // 换掉了 installFs 装的实现，就得自己记一笔，否则下面的断言看的是空数组
      calls.push([_root, rel])
      if (rel !== 'src') return Promise.resolve({ rel, entries: FS[rel] ?? [] })
      return new Promise<DirListing>((resolve) => {
        release = () => resolve({ rel, entries: FS['src']! })
      })
    })

    const expanding = tree.toggle(k('src'))
    const refreshing = tree.refresh()
    expect(calls.filter((c) => c[1] === 'src')).toHaveLength(1)
    release!()
    await Promise.all([expanding, refreshing])
    expect(rels()).toContain('src/main.rs')
  })

  it('refresh 会把树外面的改动带进来', async () => {
    installFs({ '': [f('src', true), f('README.md'), f('新文件.md')] })
    await tree.refresh()
    expect(rels()).toEqual(['', 'src', 'README.md', '新文件.md'])
  })
})

describe('读失败', () => {
  it('根读不出来时错误落在根行上', async () => {
    installFs({})
    await tree.openAt('/repo')
    expect(row('')?.error).toContain('not_found')
    expect(rels()).toEqual([''])
  })

  it('子层读不出来时只影响那一行', async () => {
    await tree.openAt('/repo')
    ipc.listDir.mockImplementation((_root: string, rel: string): Promise<DirListing> => {
      if (rel === 'src') return rejected<DirListing>({ kind: 'io', reason: 'PermissionDenied', message: '权限不够' })
      return Promise.resolve({ rel, entries: FS[rel] ?? [] })
    })
    await tree.toggle(k('src'))
    expect(row('src')?.error).toContain('权限不够')
    expect(row('src')?.loading).toBe(false)
    // 别层不受牵连
    expect(row('')?.error).toBeNull()
    expect(row('README.md')?.error).toBeNull()
  })

  it('⚠️ 刷新成功之后上一次的错误必须清掉', async () => {
    await tree.openAt('/repo')
    ipc.listDir.mockRejectedValue({ kind: 'io', reason: 'Uncategorized', message: '磁盘掉了' })
    await tree.toggle(k('src'))
    expect(row('src')?.error).toContain('磁盘掉了')

    installFs()
    await tree.refresh()
    // 错误要是不清，屏幕上会同时出现「这一层的内容」和「这一层读失败了」，
    // 用户没法判断到底哪个是真的
    expect(row('src')?.error).toBeNull()
    expect(rels()).toContain('src/main.rs')
  })

  it('一层读失败不影响其它层已经读到的内容', async () => {
    await tree.openAt('/repo')
    await tree.toggle(k('src'))
    ipc.listDir.mockRejectedValue({ kind: 'io', reason: 'Uncategorized', message: '坏了' })
    await tree.refresh()
    expect(row('')?.error).toContain('坏了')
    expect(row('src')?.error).toContain('坏了')
    expect(rels()).toContain('src/main.rs')
  })
})

describe('点与键', () => {
  beforeEach(async () => {
    await tree.openAt('/repo')
  })

  it('select 记下选中的 rel', () => {
    tree.select(k('README.md'))
    expect(selectedRel()).toBe('README.md')
    tree.run({ kind: 'select', key: k('src') })
    expect(selectedRel()).toBe('src')
  })

  it('run(open) 用行的 path 去开文件，不是 rel', async () => {
    tree.run({ kind: 'open', key: k('README.md') })
    await flush()
    expect(opened).toEqual(['/repo/README.md'])
  })

  it('run(open) 落在目录上时不开文件', async () => {
    tree.run({ kind: 'open', key: k('src') })
    await flush()
    expect(opened).toEqual([])
  })

  it('run(open) 落在一个已经不在树里的 rel 上时不开文件', async () => {
    // 右键菜单与将来的双击都会直接构造 `open`，绕过了 `actionForKey` 的那层判断
    tree.run({ kind: 'open', key: k('gone.md') })
    await flush()
    expect(opened).toEqual([])
  })

  it('run(expand) 摊开那一层，同时把选中挪过去', async () => {
    tree.run({ kind: 'expand', key: k('src') })
    expect(selectedRel()).toBe('src')
    expect(row('src')?.expanded).toBe(true)
    await flush()
    expect(rels()).toContain('src/main.rs')
  })

  it('run(collapse) 收起那一层，同时把选中挪过去', async () => {
    await tree.toggle(k('src'))
    tree.run({ kind: 'collapse', key: k('src') })
    expect(row('src')?.expanded).toBe(false)
    expect(selectedRel()).toBe('src')
    expect(rels()).not.toContain('src/main.rs')
  })

  it('run(none) 什么都不改', () => {
    const before = rels()
    tree.run({ kind: 'none' })
    expect(rels()).toEqual(before)
    expect(selectedRel()).toBeNull()
  })
})

describe('进会话存档', () => {
  it('没打开文件夹时是 null', () => {
    expect(tree.serializeState()).toBeNull()
  })

  it('摊开的顺序就是用户点开的顺序', async () => {
    await tree.openAt('/repo')
    await tree.toggle(k('node_modules'))
    await tree.toggle(k('src'))
    expect(tree.serializeState()).toEqual(saved('/repo', ['', 'node_modules', 'src']))
  })

  it('收起的层不进存档', async () => {
    await tree.openAt('/repo')
    await tree.toggle(k('src'))
    await tree.toggle(k('src'))
    expect(tree.serializeState()).toEqual(saved('/repo', ['']))
  })

  it('restoreState(null) 等于关掉文件夹', async () => {
    await tree.openAt('/repo')
    await tree.restoreState(null)
    expect(tree.roots()).toEqual([])
    expect(firstRoot()).toBeNull()
    expect(tree.rows()).toEqual([])
  })

  it('恢复时并行读所有摊开的层，不是串行', async () => {
    const issued: string[] = []
    const parked: Array<() => void> = []
    ipc.listDir.mockImplementation((_root: string, rel: string): Promise<DirListing> => {
      issued.push(rel)
      return new Promise<DirListing>((resolve) => {
        parked.push(() => resolve({ rel, entries: rel === '' ? [f('src', true)] : (FS[rel] ?? []) }))
      })
    })

    const pending = tree.restoreState(saved('/repo', ['', 'src']))
    // 两个请求都发出去了而一个都还没回来 —— 串行的话这里只会看到 ['']
    expect(issued).toEqual(['', 'src'])
    for (const release of parked) release()
    await pending

    expect(firstRoot()).toBe('/repo')
    expect(rels()).toEqual(['', 'src', 'src/main.rs', 'src/deep'])
    expect(tree.serializeState()).toEqual(saved('/repo', ['', 'src']))
  })

  it('存档里有一层已经不在树上时，恢复不崩也不多出孤行', async () => {
    // 存档之后那个目录被删了。错误确实被记下来了，但它的父层没摊开，
    // 所以那一行压根不在 `rows()` 里——不渲染一个用户看不见的错误，也不为它编一行出来
    await tree.restoreState(saved('/repo', ['', 'src/gone']))
    expect(row('')?.error).toBeNull()
    expect(row('src/gone')).toBeUndefined()
    expect(rels()).toEqual(['', 'src', 'README.md', 'node_modules'])
    expect(calls.map((c) => c[1]).sort()).toEqual(['', 'src/gone'])
  })

  it('⚠️ 存档里的重复 rel 只读一次，超出上限的部分被截掉', async () => {
    const many = Array.from({ length: MAX_RESTORED_EXPANDED + 100 }, (_, i) => `d${i}`)
    await tree.restoreState(saved('/repo', ['', '', ...many, ...many]))
    // 去重发生在截断之前：上限数的是「多少个**不同的**层」，不是数组长度。
    // 反过来的话一份重复的存档能用 512 个名额只换来 256 层
    expect(calls).toHaveLength(MAX_RESTORED_EXPANDED)
    expect(new Set(calls.map((c) => c[1])).size).toBe(MAX_RESTORED_EXPANDED)
  })
})

/**
 * 下面四个 describe 是 M2-B-5 的写操作。
 *
 * 与上面那些「读」的用例相比，这里多一条要钉的东西：**失败长什么样**。
 * 这些操作全是 `OpOutcome`——成功回 `null`，失败回一句能直接显示的人话，从不 reject。
 * 每条失败用例都断言「拿到的是字符串」而不只是「拿到了内容」，因为一旦哪天改回 throw，
 * `await tree.create(...)` 会把用例炸成一个未捕获的 rejection，而报错指向的是 vitest 内部。
 */

/** 一条 rel 的父层。桩里用来把新条目塞进假文件系统的对应那一层 */
function parentOf(rel: string): string {
  const at = rel.lastIndexOf('/')
  return at < 0 ? '' : rel.slice(0, at)
}

describe('新建', () => {
  let fs: Record<string, DirEntry[]>

  beforeEach(async () => {
    fs = copyFs()
    installFs(fs)
    await tree.openAt('/repo')
    calls.length = 0
    // 桩模仿 Rust 侧 `create_entry`：真的往假文件系统里塞一条，之后的重读才看得见它。
    // 不塞的话每条用例都得手工改 `fs`，而漏改的失败方式是「新建成功了但那一行没出现」——
    // 与被测的 bug 长得一模一样
    ipc.createEntry.mockImplementation((_root: string, rel: string, kind: EntryKind) => {
      const made = f(rel, kind === 'dir')
      fs[parentOf(rel)]!.push(made)
      if (kind === 'dir') fs[rel] = []
      return Promise.resolve(made)
    })
  })

  it('在根层新建：命令收到拼好的 rel，新条目被选中，那一层被重读', async () => {
    expect(await tree.create(k(''), '新建.md', 'file')).toBeNull()
    // `childRel('', name)` 必须给出 `name` 而不是 `/name`：后者是一条绝对路径，
    // Rust 侧的 `resolve` 会把它当成逃逸拒掉，而报错说的却是「内部错误」
    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', '新建.md', 'file')
    expect(calls).toEqual([['/repo', '']])
    expect(selectedRel()).toBe('新建.md')
    expect(rels()).toContain('新建.md')
  })

  it('⚠️ 在一个收起的目录里新建，那一层会被摊开', async () => {
    expect(row('src')?.expanded).toBe(false)
    expect(await tree.create(k('src'), 'c.ts', 'file')).toBeNull()
    // 不摊开的话用户按了确定之后界面上什么也没多出来，他会再按一次，
    // 于是撞上一个 already_exists——一次「成功了却看不见」直接变成一次「失败」
    expect(row('src')?.expanded).toBe(true)
    expect(selectedRel()).toBe('src/c.ts')
    expect(rels()).toContain('src/c.ts')
  })

  it('新建文件夹时 kind 传 dir，摊开它是空的而不是读失败', async () => {
    expect(await tree.create(k(''), 'assets', 'dir')).toBeNull()
    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', 'assets', 'dir')
    await tree.toggle(k('assets'))
    expect(row('assets')?.error).toBeNull()
    expect(row('assets')?.expanded).toBe(true)
  })

  it('名字撞了：回一句话，那一层不重读、选中不动', async () => {
    ipc.createEntry.mockImplementation(() => rejected({ kind: 'already_exists', path: '/repo/src/main.rs' }))
    const outcome = await tree.create(k('src'), 'main.rs', 'file')
    expect(outcome).toContain('already_exists')
    expect(calls).toEqual([])
    expect(selectedRel()).toBeNull()
    expect(row('src')?.expanded).toBe(false)
  })

  it('还没打开文件夹时一句话回来，命令压根不发', async () => {
    tree.close()
    expect(await tree.create(k(''), 'x.md', 'file')).toBe('还没打开文件夹')
    expect(ipc.createEntry).not.toHaveBeenCalled()
  })

  it('⚠️ 操作途中换了文件夹，晚到的成功不改新树', async () => {
    let release: (() => void) | undefined
    ipc.createEntry.mockImplementation(
      () =>
        new Promise<DirEntry>((resolve) => {
          release = () => resolve(f('late.md'))
        }),
    )
    const pending = tree.create(k(''), 'late.md', 'file')
    installFs({ '': [f('other.md')] })
    await tree.openAt('/other')

    release!()
    expect(await pending).toBeNull()
    // 结果落地时那个根实例已经被扔掉了。要是它照样写状态，新树里会多出一行属于
    // 上一个文件夹的 late.md，而 selected 也停在一条不存在的 rel 上。
    // ⚠️ 这里断言的是**选中**，不是行：行由「实例的 memo 不再挂在协调层上」挡着，
    // 而选中是协调层那份跨根共享的信号，只能靠实例自己记得它已被 dispose
    expect(rels()).toEqual(['', 'other.md'])
    expect(selectedRel()).toBeNull()
  })
})

describe('改名', () => {
  let fs: Record<string, DirEntry[]>

  beforeEach(async () => {
    fs = copyFs()
    installFs(fs)
    await tree.openAt('/repo')
  })

  /**
   * 桩模仿 Rust 侧 `rename_entry`：真的把假文件系统里那一条换掉，之后的重读才看得见新名字。
   * `isDir` 要传对——目录还得把 `fs` 里那一层的键一起搬过去，否则摊开状态搬到了新 rel
   * 上却没有缓存可读，用例看到的会是「改名成功了但里面空了」。
   */
  function stubRename(isDir = false) {
    ipc.renameEntry.mockImplementation((_root: string, rel: string, newName: string) => {
      const made = f(`${parentOf(rel) === '' ? '' : `${parentOf(rel)}/`}${newName}`, isDir)
      const list = fs[parentOf(rel)]!
      const at = list.findIndex((e) => e.rel === rel)
      if (at >= 0) list[at] = made
      if (isDir) {
        // 整棵子树一起重写：`fs` 的键、以及里面每条 `DirEntry` 的 rel 与 path。
        // 只搬键是不够的——`flattenRows` 拿 `entry.rel` 当行的 rel，漏改的话摊开的子层
        // 重读回来显示的还是旧前缀，而用例分不清那是桩的问题还是 store 的问题
        const prefix = `${rel}/`
        for (const key of Object.keys(fs)) {
          if (key !== rel && !key.startsWith(prefix)) continue
          const entries = fs[key]!
          delete fs[key]
          fs[`${made.rel}${key.slice(rel.length)}`] = entries.map((e) => {
            const nextRel = `${made.rel}${e.rel.slice(rel.length)}`
            return { ...e, rel: nextRel, path: `/repo/${nextRel}` }
          })
        }
      }
      return Promise.resolve(made)
    })
  }

  it('同层改名：三个参数各归各位，父层被重读，选中搬到新 rel', async () => {
    stubRename()
    await tree.toggle(k('src'))
    calls.length = 0

    expect(await tree.rename(k('src/main.rs'), 'c.ts')).toBeNull()
    // `newName` 是**单个名字**不是一条 rel：Tauri 2 把 Rust 的 `new_name` 转成驼峰，
    // 这是本项目第一个多单词命令参数，写错了只会得到一句「invalid args」
    expect(ipc.renameEntry).toHaveBeenCalledWith('/repo', 'src/main.rs', 'c.ts')
    expect(calls).toEqual([['/repo', 'src']])
    expect(selectedRel()).toBe('src/c.ts')
    expect(rels()).toEqual(['', 'src', 'src/c.ts', 'src/deep', 'README.md', 'node_modules'])
  })

  it('⚠️ 改一个摊开着的文件夹：整棵子树的摊开状态搬到新前缀上，旧缓存全扔', async () => {
    stubRename(true)
    await tree.toggle(k('src'))
    await tree.toggle(k('src/deep'))
    expect(tree.serializeState()).toEqual(saved('/repo', ['', 'src', 'src/deep']))
    calls.length = 0

    expect(await tree.rename(k('src'), 'lib')).toBeNull()
    // 这一条是 `dropSubtree` + 搬迁的合落点。旧键必须走：`src` 与 `src/deep` 指向的
    // 缓存里每条 `DirEntry.rel` 都还是旧的，留着就会被写进存档、下次启动发一次注定失败的
    // listDir，而且用户把 `src` 建回来时会顶上一份改名之前的内容。
    // 但摊开状态得跟着搬，否则改个名字等于把用户摊开的三层全收起来
    expect(tree.serializeState()).toEqual(saved('/repo', ['', 'lib', 'lib/deep']))
    expect(calls.map((c) => c[1]).sort()).toEqual(['', 'lib', 'lib/deep'])
    expect(rels()).toEqual(['', 'lib', 'lib/main.rs', 'lib/deep', 'lib/deep/a.ts', 'README.md', 'node_modules'])
  })

  it('改一个收起的文件夹：只重读父层，不去读它里面', async () => {
    stubRename(true)
    calls.length = 0
    expect(await tree.rename(k('src'), 'lib')).toBeNull()
    expect(calls).toEqual([['/repo', '']])
    expect(tree.serializeState()).toEqual(saved('/repo', ['']))
  })

  it('⚠️ 收起的文件夹改名时，它下面那些看不见的摊开键被扔掉而不是搬成空壳', async () => {
    stubRename(true)
    // 先摊开两层再把外层收起来：`src/deep` 还留在 expanded 里，这是折叠一层时
    // 刻意不清子孙的结果（重新摊开外层时里层的现场还在）
    await tree.toggle(k('src'))
    await tree.toggle(k('src/deep'))
    await tree.toggle(k('src'))
    expect(tree.serializeState()).toEqual(saved('/repo', ['', 'src/deep']))
    calls.length = 0

    expect(await tree.rename(k('src'), 'lib')).toBeNull()
    // 搬过去的话 `lib/deep` 会是一个「标成摊开、缓存却被 dropSubtree 扔了」的键：
    // 那一行既不显示内容也不转圈，因为 `expand()` 只在 toggle 时跑，没人替它补读
    expect(tree.serializeState()).toEqual(saved('/repo', ['']))
    expect(calls).toEqual([['/repo', '']])
  })

  it('撞名：回一句话，摊开状态与缓存都不动', async () => {
    await tree.toggle(k('src'))
    calls.length = 0
    ipc.renameEntry.mockImplementation(() => rejected({ kind: 'already_exists', path: '/repo/src/deep' }))

    expect(await tree.rename(k('src/main.rs'), 'deep')).toContain('already_exists')
    // 失败路径上一个键都不能改：`dropSubtree` 必须在 `renameEntry` **之后**才跑
    expect(calls).toEqual([])
    expect(tree.serializeState()).toEqual(saved('/repo', ['', 'src']))
    expect(rels()).toContain('src/main.rs')
  })

  it('还没打开文件夹时一句话回来，命令压根不发', async () => {
    tree.close()
    expect(await tree.rename(k('src'), 'lib')).toBe('还没打开文件夹')
    expect(ipc.renameEntry).not.toHaveBeenCalled()
  })
})

describe('移到废纸篓', () => {
  let fs: Record<string, DirEntry[]>

  beforeEach(async () => {
    fs = copyFs()
    installFs(fs)
    await tree.openAt('/repo')
    ipc.trashEntry.mockImplementation((_root: string, rel: string) => {
      const list = fs[parentOf(rel)]!
      const at = list.findIndex((e) => e.rel === rel)
      if (at >= 0) list.splice(at, 1)
      delete fs[rel]
      return Promise.resolve()
    })
  })

  it('⚠️ 根行一律拒绝，命令压根不发', async () => {
    expect(await tree.trash(k(''))).toBe('不能把项目根目录移到废纸篓')
    // 这是全前端唯一一个不可逆的操作，而「菜单里不显示这一项」是一条改渲染时
    // 就会被改坏的约定——所以挡在根实例里（判据是裸 `rel === ''`，与根序号无关，
    // 于是 N 个根行一条都跑不掉），不是挡在 UI 里
    expect(ipc.trashEntry).not.toHaveBeenCalled()
    expect(firstRoot()).toBe('/repo')
    expect(rels()).toEqual(['', 'src', 'README.md', 'node_modules'])
  })

  it('删一个摊开着的文件夹：整棵子树的状态一起走，选中落到父层', async () => {
    await tree.toggle(k('src'))
    await tree.toggle(k('src/deep'))
    calls.length = 0

    expect(await tree.trash(k('src'))).toBeNull()
    expect(ipc.trashEntry).toHaveBeenCalledWith('/repo', 'src')
    // 选中挪到父层而不是留在原地：原来那一行没了，而 `actionForKey` 对「选中的 rel
    // 不在树里」的处理是从第一行起步——留着它，用户按一下方向键会觉得树跳了一下
    expect(selectedRel()).toBe('')
    expect(tree.serializeState()).toEqual(saved('/repo', ['']))
    expect(rels()).toEqual(['', 'README.md', 'node_modules'])
    expect(calls).toEqual([['/repo', '']])
  })

  it('删一个文件：只有那一行没了，兄弟行原样', async () => {
    await tree.toggle(k('src'))
    expect(await tree.trash(k('src/main.rs'))).toBeNull()
    expect(selectedRel()).toBe('src')
    expect(rels()).toEqual(['', 'src', 'src/deep', 'README.md', 'node_modules'])
  })

  it('失败时一句话回来，那一行还在', async () => {
    ipc.trashEntry.mockImplementation(() =>
      rejected({ kind: 'io', reason: 'Trash', message: '没能把 /repo/README.md 移到废纸篓：权限不够' }),
    )
    expect(await tree.trash(k('README.md'))).toContain('权限不够')
    expect(rels()).toContain('README.md')
    expect(calls.map((c) => c[1])).toEqual([''])
  })

  it('还没打开文件夹时一句话回来，命令压根不发', async () => {
    tree.close()
    expect(await tree.trash(k('README.md'))).toBe('还没打开文件夹')
    expect(ipc.trashEntry).not.toHaveBeenCalled()
  })
})

describe('在 Finder 中显示 / 复制路径', () => {
  beforeEach(async () => {
    await tree.openAt('/repo')
    calls.length = 0
  })

  it('reveal 成功回 null，不碰树的状态', async () => {
    ipc.revealEntry.mockResolvedValue(undefined)
    expect(await tree.reveal(k('README.md'))).toBeNull()
    expect(ipc.revealEntry).toHaveBeenCalledWith('/repo', 'README.md')
    expect(calls).toEqual([])
    expect(selectedRel()).toBeNull()
  })

  it('copyPath 成功回 null，同样不重读', async () => {
    ipc.copyEntryPath.mockResolvedValue(undefined)
    expect(await tree.copyPath(k('src/main.rs'))).toBeNull()
    expect(ipc.copyEntryPath).toHaveBeenCalledWith('/repo', 'src/main.rs')
    expect(calls).toEqual([])
  })

  it('⚠️ 非 macOS 上那句 Unsupported 会原样回到用户面前', async () => {
    // Rust 侧对 `#[cfg(not(target_os = "macos"))]` 回的是这一句。前端不该把它咽掉
    // （回 null 等于告诉 UI「成功了」），也不该改写成「内部错误」——用户需要知道的
    // 是这个功能在他这台机器上没有。成品文案本身在 `src/ipc/project.test.ts` 里钉，
    // 这里 `describeTreeError` 是假的，只看「话有没有被带回来」
    ipc.revealEntry.mockImplementation(() =>
      rejected({ kind: 'io', reason: 'Unsupported', message: '在 Finder 中显示目前只支持 macOS' }),
    )
    expect(await tree.reveal(k('README.md'))).toContain('只支持 macOS')
    ipc.copyEntryPath.mockImplementation(() =>
      rejected({ kind: 'io', reason: 'Unsupported', message: '复制路径目前只支持 macOS' }),
    )
    expect(await tree.copyPath(k('README.md'))).toContain('只支持 macOS')
  })

  it('目标已经不在了：一句话回来，树不动', async () => {
    ipc.revealEntry.mockImplementation(() => rejected({ kind: 'not_found', path: '/repo/gone.md' }))
    expect(await tree.reveal(k('gone.md'))).toContain('not_found')
    expect(calls).toEqual([])
  })

  it('这两个操作不查「实例还在不在」：它们不改任何状态，没有「晚到污染新树」这回事', async () => {
    let release: (() => void) | undefined
    ipc.revealEntry.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    )
    const pending = tree.reveal(k('README.md'))
    installFs({ '': [f('other.md')] })
    await tree.openAt('/other')
    release!()
    // 与 create/rename/trash 相反：那三个晚到时必须被丢掉，因为要写状态；
    // 这个晚到了顶多是 Finder 里选中了一个旧位置，没有状态可污染。
    // 所以它连 `disposed` 都不看——回一句「成功了」比回一句「你刚才那次点击作废了」诚实
    expect(await pending).toBeNull()
    expect(rels()).toEqual(['', 'other.md'])
  })

  it('还没打开文件夹时一句话回来，命令压根不发', async () => {
    tree.close()
    expect(await tree.reveal(k('x'))).toBe('还没打开文件夹')
    expect(await tree.copyPath(k('x'))).toBe('还没打开文件夹')
    expect(ipc.revealEntry).not.toHaveBeenCalled()
    expect(ipc.copyEntryPath).not.toHaveBeenCalled()
  })
})

/**
 * 多根工作区（M2-F）。
 *
 * 上面那些用例全在「一个根」的语境里说话，`k(rel)` 把根序号钉在 0 上。这里要钉的是
 * **只有站在整份工作区的角度才存在的那几件事**：
 *
 * - 行按位次首尾相接，每个根的行**连续**（这是方向键能跨根、而「找父目录」又不跨根的全部依据）
 * - 每个操作落到**它那个根**上，而不是第 0 个
 * - 移除一个根时位次前移、选中重映射，而**别的根不该被白读一遍**
 * - 恢复时根与层各有自己的预算，且都先去重再截断
 *
 * ⚠️ 假文件系统是**按 `rel` 索引、两个根共用**的，所以 `/repo` 与 `/notes` 长得一模一样。
 * 这是刻意的：`calls` 记的是 `[root, rel]`，靠 `root` 就能分清是谁读的；而共用一份表
 * 让「两个根都有一条 `src`」这个多根最典型的处境天然成立——正是它逼出了 `RowKey`。
 */
describe('多根工作区', () => {
  /** 装两个根。`restoreState` 是唯一能一次装回 N 个根的入口，`openAt` 只会替换成一个 */
  async function mountTwo(): Promise<void> {
    await tree.restoreState({
      roots: [
        { root: '/repo', expanded: [''] },
        { root: '/notes', expanded: [''] },
      ],
    })
  }

  /** 三个根。位次前移与选中重映射至少要有「中间那个被移除」的场合才说得清 */
  async function mountThree(): Promise<void> {
    await tree.restoreState({
      roots: [
        { root: '/repo', expanded: [''] },
        { root: '/notes', expanded: [''] },
        { root: '/docs', expanded: [''] },
      ],
    })
  }

  it('恢复两个根：行首尾相接，每个根的行连续，rootIndex 盖在每一行上', async () => {
    await mountTwo()
    expect(tree.roots()).toEqual(['/repo', '/notes'])
    // 每个根各 4 行（根行 + 三个子项），前 4 行全是 0、后 4 行全是 1。
    // ⚠️ 「连续」不是一个顺带的性质：`actionForKey` 的上下键是扁平数组上的 ±1，
    // 而行与行交错的话「按一下落到另一个项目里」会变成常事，且看不出规律
    expect(tree.rows().map((r) => r.rootIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    expect(rowsOf(0).map((r) => r.rel)).toEqual(['', 'src', 'README.md', 'node_modules'])
    expect(rowsOf(1).map((r) => r.rel)).toEqual(['', 'src', 'README.md', 'node_modules'])
    // 两个根都读了一次，各归各的 root
    expect(calls).toEqual([
      ['/repo', ''],
      ['/notes', ''],
    ])
  })

  it('两个根的根行各显示自己的名字，depth 都从 0 起', async () => {
    await mountTwo()
    expect(tree.rootName(0)).toBe('repo')
    expect(tree.rootName(1)).toBe('notes')
    expect(rowsOf(0)[0]?.name).toBe('repo')
    expect(rowsOf(1)[0]?.name).toBe('notes')
    // 缩进按根各自算：第二个根的行不接着第一个根往下缩
    expect(rowsOf(1)[0]?.depth).toBe(0)
    expect(rowsOf(1)[1]?.depth).toBe(1)
  })

  it('摊开落在那一个根上，另一个根一动不动', async () => {
    await mountTwo()
    calls.length = 0
    await tree.toggle(rowKey(1, 'src'))
    expect(calls).toEqual([['/notes', 'src']])
    expect(rowsOf(1).map((r) => r.rel)).toEqual(['', 'src', 'src/main.rs', 'src/deep', 'README.md', 'node_modules'])
    // 少盖根序号的回归在这里现形：两个根都有 `src`，派错了根的话被摊开的是第 0 个
    expect(rowsOf(0).map((r) => r.rel)).toEqual(['', 'src', 'README.md', 'node_modules'])
  })

  it('refresh 把所有根里摊开着的层都重读一遍', async () => {
    await mountTwo()
    await tree.toggle(rowKey(0, 'src'))
    await tree.toggle(rowKey(1, 'node_modules'))
    calls.length = 0
    await tree.refresh()
    expect(calls).toEqual([
      ['/repo', ''],
      ['/repo', 'src'],
      ['/notes', ''],
      ['/notes', 'node_modules'],
    ])
  })

  it('写操作落到那一个根上，选中盖着它的根序号', async () => {
    // 桩不往假文件系统里塞条目：这条用例要钉的是「命令收到了哪个 root」与「选中盖着哪个
    // 根序号」，重读回来的内容长什么样在上面的「新建」那一组里已经钉过了
    ipc.createEntry.mockImplementation((_root: string, rel: string, kind: EntryKind) =>
      Promise.resolve(f(rel, kind === 'dir')),
    )
    await mountTwo()
    calls.length = 0

    expect(await tree.create(rowKey(1, ''), 'note.md', 'file')).toBeNull()
    expect(ipc.createEntry).toHaveBeenCalledWith('/notes', 'note.md', 'file')
    // 选中是**跨根共享**的那一份信号，所以它必须带着根序号——
    // 少了它，「新建完选中新条目」会在另一个根的同名 rel 上点一盏高亮
    expect(tree.selected()).toEqual(rowKey(1, 'note.md'))
    expect(calls).toEqual([['/notes', '']])
  })

  it('addRoot 追加到末尾并读它自己的根层', async () => {
    await tree.openAt('/repo')
    calls.length = 0
    await tree.addRoot('/notes')
    expect(tree.roots()).toEqual(['/repo', '/notes'])
    expect(calls).toEqual([['/notes', '']])
    expect(tree.rows().map((r) => r.rootIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
  })

  it('⚠️ addRoot 撞上已在工作区里的路径时什么也不做', async () => {
    await tree.openAt('/repo')
    calls.length = 0
    await tree.addRoot('/repo')
    // 同一个文件夹加两遍会得到两份各自维护的缓存与两套一模一样的行，
    // 而在第二份里改名不会让第一份跟着变——界面上看起来就是「树坏了」
    expect(tree.roots()).toEqual(['/repo'])
    expect(calls).toEqual([])
    expect(tree.rows()).toHaveLength(4)
  })

  it('addViaDialog 可以多选，按挑中的顺序追加', async () => {
    dialog.open.mockResolvedValue(['/notes', '/docs'])
    await tree.openAt('/repo')
    calls.length = 0
    await tree.addViaDialog()
    // `multiple: true` 只在这里开：`openViaDialog` 的语义是「换成这一个」，得保持单选
    expect(dialog.open).toHaveBeenCalledWith({ multiple: true, directory: true })
    expect(tree.roots()).toEqual(['/repo', '/notes', '/docs'])
    // 串行加：`addRoot` 要读「当前有几个根」来定新根的位次，
    // 并行的话两个新根会抢到同一个位次，而行上盖的 rootIndex 就重了
    expect(calls).toEqual([
      ['/notes', ''],
      ['/docs', ''],
    ])
    expect(rowsOf(2)[0]?.name).toBe('docs')
  })

  it('removeRoot 把后面所有根的位次前移，行上的 rootIndex 跟着改', async () => {
    await mountThree()
    tree.removeRoot(0)
    expect(tree.roots()).toEqual(['/notes', '/docs'])
    // 原来 `/docs` 的行盖着 2，现在盖着 1。不改的话点它一下会派到已经不存在的第 2 个根上，
    // 而协调层的 `at(2)` 返回 undefined——用户的点击悄无声息地什么也没发生
    expect(tree.rows().map((r) => r.rootIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    expect(rowsOf(0)[0]?.name).toBe('notes')
    expect(rowsOf(1)[0]?.name).toBe('docs')
  })

  it('⚠️ removeRoot 不重读任何一层：别的根不该被白读一遍', async () => {
    await mountThree()
    await tree.toggle(rowKey(2, 'src'))
    calls.length = 0
    tree.removeRoot(0)
    // 这是「每个根存自己一份状态」换来的东西：移除一个根只是把它那份交给 GC。
    // 若缓存是一个全局大 Map，这里就得按前缀挑出剩下的键、并且很难不去重读一遍
    expect(calls).toEqual([])
    expect(rowsOf(1).map((r) => r.rel)).toEqual(['', 'src', 'src/main.rs', 'src/deep', 'README.md', 'node_modules'])
  })

  it('⚠️ removeRoot 重映射选中：被移除那个根里的作废，后面的各前移一位', async () => {
    await mountThree()
    tree.select(rowKey(2, 'README.md'))
    tree.removeRoot(0)
    expect(tree.selected()).toEqual(rowKey(1, 'README.md'))

    tree.select(rowKey(0, 'README.md'))
    tree.removeRoot(1)
    // 前面的根不受影响
    expect(tree.selected()).toEqual(rowKey(0, 'README.md'))

    tree.removeRoot(0)
    // 不重映射的话高亮会留在一个已经不存在的位次上，而 `actionForKey` 找不到它，
    // 用户按一下方向键会觉得树跳回了第一行
    expect(tree.selected()).toBeNull()
  })

  it('移除一个不存在的位次什么也不改', async () => {
    await mountTwo()
    const before = tree.rows()
    tree.removeRoot(9)
    tree.removeRoot(-1)
    expect(tree.roots()).toEqual(['/repo', '/notes'])
    expect(tree.rows()).toEqual(before)
  })

  it('⚠️ 被移除的根上晚到的写操作不碰那份跨根共享的选中', async () => {
    let release: (() => void) | undefined
    ipc.createEntry.mockImplementation(
      () =>
        new Promise<DirEntry>((resolve) => {
          release = () => resolve(f('late.md'))
        }),
    )
    await mountTwo()
    tree.select(rowKey(0, 'README.md'))

    const pending = tree.create(rowKey(1, ''), 'late.md', 'file')
    tree.removeRoot(1)
    release!()
    expect(await pending).toBeNull()
    // 实例被 dispose 之后就不该再调 `onSelect`。写自己的缓存是白写（没人读了），
    // 而选中是**协调层的**信号——那一次写入会让高亮跳到一个界面上已经不存在的根里去
    expect(tree.selected()).toEqual(rowKey(0, 'README.md'))
    expect(tree.roots()).toEqual(['/repo'])
  })

  it('⚠️ 没被碰过的根，行对象引用不变（虚拟滚动靠这个复用 DOM）', async () => {
    await mountThree()
    const before = rowsOf(0)
    tree.removeRoot(2)
    const after = rowsOf(0)
    // `<For>` 按引用相等复用 DOM。位次改成「每行现算自己在哪个根里」的访问器的话，
    // `mounted()` 一变所有根的 `rows()` 都要重算，表现是「移除一个根，整棵树闪一下」。
    // `setIndex` 在数值没变时不通知（默认 `===`），所以第 0 个根的 memo 压根没跑
    expect(after[0]).toBe(before[0])
    expect(after[3]).toBe(before[3])
  })

  it('close 扔掉所有根，选中一起清掉', async () => {
    await mountTwo()
    tree.select(rowKey(1, 'README.md'))
    tree.close()
    expect(tree.roots()).toEqual([])
    expect(tree.rows()).toEqual([])
    expect(tree.selected()).toBeNull()
    expect(opened).toEqual([])
  })

  it('存档里每个根各带自己的展开清单', async () => {
    await mountTwo()
    await tree.toggle(rowKey(1, 'src'))
    expect(tree.serializeState()).toEqual({
      roots: [
        { root: '/repo', expanded: [''] },
        { root: '/notes', expanded: ['', 'src'] },
      ],
    })
  })

  it('⚠️ 存档里重复的根只认一次，超出上限的部分被截掉', async () => {
    const many = Array.from({ length: MAX_RESTORED_ROOTS + 5 }, (_, i) => `/r${i}`)
    await tree.restoreState({ roots: [...many, ...many].map((root) => ({ root, expanded: [''] })) })
    // 去重在截断之前：上限数的是「多少个**不同的**根」。反过来的话一份重复的存档
    // 能用 32 个名额只换来 16 个根，而用户其实开着 21 个
    expect(tree.roots()).toEqual(many.slice(0, MAX_RESTORED_ROOTS))
    expect(new Set(calls.map((c) => c[0])).size).toBe(MAX_RESTORED_ROOTS)
  })

  it('⚠️ 恢复层的上限是每个根各一份，不是所有根加起来', async () => {
    const many = Array.from({ length: MAX_RESTORED_EXPANDED + 10 }, (_, i) => `d${i}`)
    await tree.restoreState({
      roots: [
        { root: '/repo', expanded: many },
        { root: '/notes', expanded: many },
      ],
    })
    // 写成一份总预算的话，先恢复的那个根会把名额吃光，第二个根一层都摊不开——
    // 而存档里那两个根在用户眼里是完全平等的
    expect(calls.filter((c) => c[0] === '/repo')).toHaveLength(MAX_RESTORED_EXPANDED)
    expect(calls.filter((c) => c[0] === '/notes')).toHaveLength(MAX_RESTORED_EXPANDED)
  })

  it('派到一个不存在的根上时不抛：读操作静默返回，写操作回一句话', async () => {
    await tree.openAt('/repo')
    calls.length = 0
    // 右键菜单还开着、用户已经按 Cmd+Shift+O 换掉了工作区——这一串调用就落在这里。
    // 抛出去的失败方式是一次未捕获的 rejection，界面上什么也没发生
    await expect(tree.toggle(rowKey(3, 'src'))).resolves.toBeUndefined()
    expect(await tree.create(rowKey(3, ''), 'x.md', 'file')).toBe('还没打开文件夹')
    expect(await tree.rename(rowKey(3, 'src'), 'lib')).toBe('还没打开文件夹')
    expect(await tree.trash(rowKey(3, 'src'))).toBe('还没打开文件夹')
    expect(await tree.reveal(rowKey(3, 'src'))).toBe('还没打开文件夹')
    expect(await tree.copyPath(rowKey(3, 'src'))).toBe('还没打开文件夹')
    expect(calls).toEqual([])
    expect(ipc.createEntry).not.toHaveBeenCalled()
    expect(ipc.trashEntry).not.toHaveBeenCalled()
  })

  it('run(open) 用那一行自己的 path：两个根里的同名文件各开各的', async () => {
    await mountTwo()
    tree.run({ kind: 'open', key: rowKey(1, 'README.md') })
    await flush()
    // `path` 来自 `listDir` 的返回，而桩是按当次请求的 root 拼的（与 Rust 侧一致）。
    // 派错根的话这里会是 `/repo/README.md`——打开的是另一个项目里的同名文件
    expect(opened).toEqual(['/notes/README.md'])
    expect(tree.selected()).toEqual(rowKey(1, 'README.md'))
  })

  it('run(expand) / run(collapse) 落在那一个根上', async () => {
    await mountTwo()
    calls.length = 0
    tree.run({ kind: 'expand', key: rowKey(1, 'src') })
    await flush()
    expect(calls).toEqual([['/notes', 'src']])
    expect(tree.selected()).toEqual(rowKey(1, 'src'))
    expect(row('src', 1)?.expanded).toBe(true)
    expect(row('src', 0)?.expanded).toBe(false)

    tree.run({ kind: 'collapse', key: rowKey(1, 'src') })
    expect(row('src', 1)?.expanded).toBe(false)
    expect(rowsOf(1).map((r) => r.rel)).toEqual(['', 'src', 'README.md', 'node_modules'])
  })
})

describe('最近项目：两个纯函数', () => {
  it('sameWorkspace 逐个比，路径里的换行不会把两条不同的清单混成一条', () => {
    expect(sameWorkspace(['/a'], ['/a'])).toBe(true)
    expect(sameWorkspace(['/a', '/b'], ['/a', '/b'])).toBe(true)
    // 顺序就是 rootIndex，所以换了顺序是**另一个**工作区
    expect(sameWorkspace(['/a', '/b'], ['/b', '/a'])).toBe(false)
    expect(sameWorkspace(['/a'], ['/a', '/b'])).toBe(false)
    expect(sameWorkspace([], [])).toBe(true)
    // ⚠️ 这一条是「不许用 join 当键」的全部理由：APFS 只禁 `/` 与 NUL，
    // 换行是合法字符，而拼接会把这两种完全不同的工作区算出同一个键
    expect(sameWorkspace(['/a\n/b'], ['/a', '/b'])).toBe(false)
  })

  it('rememberWorkspace 把新的顶到最前面，顺手摘掉重复的那一份', () => {
    expect(rememberWorkspace([], ['/a'], 12)).toEqual([['/a']])
    expect(rememberWorkspace([['/a']], ['/b'], 12)).toEqual([['/b'], ['/a']])
    // 不摘的话同一条会出现两次，而 Cmd+Shift+O 会画两行一模一样的候选
    expect(rememberWorkspace([['/b'], ['/a']], ['/a'], 12)).toEqual([['/a'], ['/b']])
  })

  it('⚠️ 空清单一律不记：否则「关闭所有文件夹」会在最前面留一行没有名字的候选', () => {
    expect(rememberWorkspace([['/a']], [], 12)).toEqual([['/a']])
    expect(rememberWorkspace([], [], 12)).toEqual([])
  })

  it('超出上限时最老的那一条被挤掉，而且原来的清单没被就地改掉', () => {
    const before: (readonly string[])[] = [['/a'], ['/b'], ['/c']]
    const after = rememberWorkspace(before, ['/d'], 3)
    expect(after).toEqual([['/d'], ['/a'], ['/b']])
    expect(before).toEqual([['/a'], ['/b'], ['/c']])
  })

  it('上限是 12：一屏放得下，而记 50 条只是让后面那几十条永远排在滚动区外面', () => {
    expect(MAX_RECENT_PROJECTS).toBe(12)
  })
})

describe('最近项目', () => {
  it('换掉工作区时，刚离开的那一份被记到最前面', async () => {
    await tree.openAt('/repo')
    expect(tree.recentProjects()).toEqual([]) // 还没离开过任何地方

    await tree.openAt('/notes')
    expect(tree.roots()).toEqual(['/notes'])
    expect(tree.recentProjects()).toEqual([['/repo']])
  })

  it('「关闭所有文件夹」也算离开：那一份留在候选里，此刻没有当前工作区', async () => {
    await tree.openAt('/repo')
    tree.close()

    expect(tree.roots()).toEqual([])
    expect(tree.recentProjects()).toEqual([['/repo']])
    // 存档里此刻没有「当前工作区」可顶，所以两份是一样的
    expect(tree.serializeRecent()).toEqual([['/repo']])
  })

  it('⚠️ 多根工作区是**整份**记下来的，不是一个根一条', async () => {
    await tree.restoreState({
      roots: [
        { root: '/repo', expanded: [''] },
        { root: '/notes', expanded: [''] },
      ],
    })
    await tree.openAt('/docs')

    // 只记单个路径的话这里会是 [['/repo'], ['/notes']]，切回去就只剩一个根，
    // 而「我刚才那两个文件夹呢」这件事没有任何提示
    expect(tree.recentProjects()).toEqual([['/repo', '/notes']])
  })

  it('⚠️ 加一个根 / 移掉一个根都不记：那是同一个项目攒到一半的样子', async () => {
    await tree.openAt('/repo')
    await tree.addRoot('/notes')
    expect(tree.recentProjects()).toEqual([])

    tree.removeRoot(1)
    expect(tree.recentProjects()).toEqual([])
    // 但整份换掉仍然记：判据是「换没换」，不是「动没动」
    await tree.openAt('/docs')
    expect(tree.recentProjects()).toEqual([['/repo']])
  })

  it('同一条再切回来时只留最新的那一份，清单不会被来回切撑满', async () => {
    await tree.openAt('/repo')
    await tree.openAt('/notes')
    await tree.openAt('/repo')

    expect(tree.recentProjects()).toEqual([['/notes']])
    // 存档那一份把当前工作区顶回最前面：它记的是「都在哪些项目里干过活」，
    // 当然包括此刻这一个
    expect(tree.serializeRecent()).toEqual([['/repo'], ['/notes']])
  })

  it('serializeRecent 截到上限，最老的那一条被挤掉', async () => {
    for (let i = 0; i < MAX_RECENT_PROJECTS + 2; i++) await tree.openAt(`/p${i}`)
    const list = tree.serializeRecent()
    expect(list).toHaveLength(MAX_RECENT_PROJECTS)
    // 最新的在最前面，包括此刻开着的那一个
    expect(list[0]).toEqual([`/p${MAX_RECENT_PROJECTS + 1}`])
    expect(list.at(-1)).toEqual(['/p2'])
  })

  it('openMany 一次装回 N 个根：位次从头排，每个根只摊开根层', async () => {
    await tree.openAt('/docs')
    calls.length = 0

    await tree.openMany(['/repo', '/notes'])

    expect(tree.roots()).toEqual(['/repo', '/notes'])
    expect(tree.rows().map((r) => r.rootIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    // 只读根层：切到一个几个月没碰的项目时，上次摊到第八层的那些目录
    // 只会让人找不到自己在哪
    expect(calls).toEqual([
      ['/repo', ''],
      ['/notes', ''],
    ])
    expect(tree.recentProjects()).toEqual([['/docs']])
  })

  it('⚠️ openMany 去重并截到 MAX_RESTORED_ROOTS：清单来自磁盘上的 JSON', async () => {
    const many = Array.from({ length: MAX_RESTORED_ROOTS + 5 }, (_, i) => `/p${i}`)
    await tree.openMany([...many, many[0]!])

    expect(tree.roots()).toEqual(many.slice(0, MAX_RESTORED_ROOTS))
    // 重复的那个根只会有一份缓存：两份各自维护的缓存里改名不会让另一份跟着变
    expect(calls.filter(([, rel]) => rel === '')).toHaveLength(MAX_RESTORED_ROOTS)
  })

  it('restoreRecent 把存档装回来，空条目与重复条目被摘掉', async () => {
    tree.restoreRecent([
      ['/repo', '/notes'],
      [], // 空条目 = 切过去等于把当前项目关掉，不认
      ['/repo', '/notes'], // 与第一条是同一个工作区
      ['/docs'],
    ])

    expect(tree.recentProjects()).toEqual([['/repo', '/notes'], ['/docs']])
    expect(tree.serializeRecent()).toEqual([['/repo', '/notes'], ['/docs']])
  })

  it('restoreRecent 也截到上限，而且 restoreState 不会把它抹掉', async () => {
    const many = Array.from({ length: MAX_RECENT_PROJECTS + 3 }, (_, i) => [`/p${i}`])
    tree.restoreRecent(many)

    await tree.restoreState({ roots: [{ root: '/repo', expanded: [''] }] })

    // 候选里少一条：当前工作区（`/repo`）被排掉了，见 `recentProjects` 的接口文档
    const list = tree.recentProjects()
    expect(list).toHaveLength(MAX_RECENT_PROJECTS - 1)
    expect(list[0]).toEqual(['/p0'])

    // 存档那一份把当前工作区顶回最前面，于是最老的 `/p11` 被挤出上限——
    // 「顶到最前」与「截到上限」是同一次调用里做的，先后顺序写反的结果是丢掉最新的那一条
    const archived = tree.serializeRecent()
    expect(archived).toHaveLength(MAX_RECENT_PROJECTS)
    expect(archived[0]).toEqual(['/repo'])
    expect(archived.at(-1)).toEqual([`/p${MAX_RECENT_PROJECTS - 2}`])
  })

  it('存档往返：serializeRecent 写出去的，restoreRecent 原样装回来', async () => {
    await tree.openAt('/repo')
    await tree.openAt('/notes')
    await tree.openMany(['/docs', '/repo'])
    const archived = tree.serializeRecent()
    expect(archived).toEqual([['/docs', '/repo'], ['/notes'], ['/repo']])

    tree.restoreRecent(archived)
    expect(tree.serializeRecent()).toEqual(archived)
  })

  it('当前工作区不出现在候选里：挑中它只会把摊开着的层全部收起', async () => {
    await tree.restoreState({ roots: [{ root: '/repo', expanded: ['', 'src'] }] })
    tree.restoreRecent([['/repo'], ['/notes']])

    expect(tree.recentProjects()).toEqual([['/notes']])
    // 存档里它照样在最前面：两份清单服务的不是同一个问题
    expect(tree.serializeRecent()).toEqual([['/repo'], ['/notes']])
  })
})
