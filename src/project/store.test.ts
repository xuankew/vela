import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'solid-js'

/**
 * 项目树 store 的单测：异步与可变状态这一半。
 *
 * 结构性的部分（扁平化、窗口算术、方向键落点）在 `./tree.test.ts` 里已经钉过了，
 * 这里只测**什么时候去读、读回来放哪、在飞的请求什么时候该被丢掉**。
 *
 * 假的是 `listDir`、五个文件操作封装与原生目录对话框——jsdom 里没有 Tauri 运行时。
 * `describeTreeError` 也一并假掉：它自己在 `src/ipc/project.test.ts` 里测过，
 * 这里只关心「错误有没有落到对应的那一层上」。
 *
 * ⚠️ 桩里那五个一个都不能少：`store.ts` 是从这个模块**按名字**导入它们的，
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
import { createProjectTree, MAX_RESTORED_EXPANDED, type ProjectTree } from './store'

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

/** `rel` → 条目。`name` 从 `rel` 的最后一段抠出来，`path` 一律按 `/repo` 拼 */
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
    return Promise.resolve({ rel, entries })
  })
}

/**
 * 把在飞的 promise 冲干净。
 *
 * `run({kind:'open'|'expand'})` 是**故意**不等异步的（点一下不该卡住 UI），
 * 所以要断言它的后果就得先让微任务与宏任务各跑一轮。用 `setTimeout` 而不是
 * `await Promise.resolve()`：后者只推进一个微任务，而 `load` 里有两次 await。
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
/** `createProjectTree` 里有两个 `createMemo`；不在 root 里建，它们永远不会被释放 */
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

function row(rel: string) {
  return tree.rows().find((r) => r.rel === rel)
}

beforeEach(() => {
  ipc.listDir.mockReset()
  // 五个写桩也要清：某条用例给 `createEntry` 装了一个「永不 settle」的 promise 来测
  // rootToken，漏到下一条用例里去的话那条会一直挂着，而报错指向的是别的地方
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
    expect(tree.root()).toBeNull()
    expect(tree.rootName()).toBe('')
    expect(tree.rows()).toEqual([])
    expect(calls).toEqual([])
  })

  it('openAt 读根一层，并把根默认摊开', async () => {
    await tree.openAt('/repo')
    expect(tree.root()).toBe('/repo')
    expect(calls).toEqual([['/repo', '']])
    // 根行 + 三个子项。打开一个文件夹却只看到一行、还得再点一次，那一下点击没有信息量
    expect(rels()).toEqual(['', 'src', 'README.md', 'node_modules'])
    expect(row('')?.expanded).toBe(true)
    expect(row('')?.depth).toBe(0)
    expect(row('src')?.depth).toBe(1)
  })

  it('rootName 是路径的最后一段', async () => {
    await tree.openAt('/Volumes/data/dev/Vela')
    expect(tree.rootName()).toBe('Vela')
  })

  it('dialog 要的是目录，给了路径就打开', async () => {
    dialog.open.mockResolvedValue('/repo')
    await tree.openViaDialog()
    // `directory: true` 是 `root` 唯一可能的来源，这两个选项就是那条前提本身
    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: true })
    expect(tree.root()).toBe('/repo')
    expect(calls).toEqual([['/repo', '']])
  })

  it('dialog 取消了就什么都不动', async () => {
    dialog.open.mockResolvedValue(null)
    await tree.openViaDialog()
    expect(tree.root()).toBeNull()
    expect(tree.rows()).toEqual([])
    expect(calls).toEqual([])
  })

  it('换一个文件夹时整棵树被换掉，旧 root 的缓存一条不留', async () => {
    await tree.openAt('/repo')
    await tree.toggle('src')
    expect(rels()).toContain('src/main.rs')

    installFs({ '': [f('other.md')] })
    await tree.openAt('/other')
    expect(tree.root()).toBe('/other')
    expect(calls).toEqual([['/other', '']])
    expect(rels()).toEqual(['', 'other.md'])
    expect(tree.selected()).toBeNull()
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
    // 两棵树的条目混在一起，用户只会觉得这棵树在说谎
    expect(rels()).toEqual(['', 'fresh'])
    expect(row('')?.loading).toBe(false)
  })

  it('close 之后回到「什么都没打开」，但不碰任何标签页', async () => {
    await tree.openAt('/repo')
    tree.close()
    expect(tree.root()).toBeNull()
    expect(tree.rows()).toEqual([])
    expect(opened).toEqual([])
  })
})

describe('按需列举', () => {
  beforeEach(async () => {
    await tree.openAt('/repo')
  })

  it('摊开一层就再发一次 listDir，参数是那一层的 rel', async () => {
    await tree.toggle('src')
    expect(calls).toEqual([
      ['/repo', ''],
      ['/repo', 'src'],
    ])
    expect(rels()).toEqual(['', 'src', 'src/main.rs', 'src/deep', 'README.md', 'node_modules'])
    expect(row('src/main.rs')?.depth).toBe(2)
  })

  it('⚠️ 折叠的层不递归进去：孙子目录压根没被请求过', async () => {
    await tree.toggle('src')
    expect(calls.map((c) => c[1])).toEqual(['', 'src'])
  })

  it('收起再摊开不重读，缓存命中', async () => {
    await tree.toggle('src')
    await tree.toggle('src') // 收起
    expect(row('src')?.expanded).toBe(false)
    await tree.toggle('src') // 再摊开
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

    const pending = tree.toggle('src')
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
    await Promise.all([tree.toggle('src'), tree.toggle('node_modules')])
    expect(rels()).toEqual(['', 'src', 'src/main.rs', 'src/deep', 'README.md', 'node_modules', 'node_modules/.pnpm'])
  })

  it('refresh 重读所有摊开着的层', async () => {
    await tree.toggle('src')
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

    const expanding = tree.toggle('src')
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
    await tree.toggle('src')
    expect(row('src')?.error).toContain('权限不够')
    expect(row('src')?.loading).toBe(false)
    // 别层不受牵连
    expect(row('')?.error).toBeNull()
    expect(row('README.md')?.error).toBeNull()
  })

  it('⚠️ 刷新成功之后上一次的错误必须清掉', async () => {
    await tree.openAt('/repo')
    ipc.listDir.mockRejectedValue({ kind: 'io', reason: 'Uncategorized', message: '磁盘掉了' })
    await tree.toggle('src')
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
    await tree.toggle('src')
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
    tree.select('README.md')
    expect(tree.selected()).toBe('README.md')
    tree.run({ kind: 'select', rel: 'src' })
    expect(tree.selected()).toBe('src')
  })

  it('run(open) 用行的 path 去开文件，不是 rel', async () => {
    tree.run({ kind: 'open', rel: 'README.md' })
    await flush()
    expect(opened).toEqual(['/repo/README.md'])
  })

  it('run(open) 落在目录上时不开文件', async () => {
    tree.run({ kind: 'open', rel: 'src' })
    await flush()
    expect(opened).toEqual([])
  })

  it('run(open) 落在一个已经不在树里的 rel 上时不开文件', async () => {
    // 右键菜单与将来的双击都会直接构造 `open`，绕过了 `actionForKey` 的那层判断
    tree.run({ kind: 'open', rel: 'gone.md' })
    await flush()
    expect(opened).toEqual([])
  })

  it('run(expand) 摊开那一层，同时把选中挪过去', async () => {
    tree.run({ kind: 'expand', rel: 'src' })
    expect(tree.selected()).toBe('src')
    expect(row('src')?.expanded).toBe(true)
    await flush()
    expect(rels()).toContain('src/main.rs')
  })

  it('run(collapse) 收起那一层，同时把选中挪过去', async () => {
    await tree.toggle('src')
    tree.run({ kind: 'collapse', rel: 'src' })
    expect(row('src')?.expanded).toBe(false)
    expect(tree.selected()).toBe('src')
    expect(rels()).not.toContain('src/main.rs')
  })

  it('run(none) 什么都不改', () => {
    const before = rels()
    tree.run({ kind: 'none' })
    expect(rels()).toEqual(before)
    expect(tree.selected()).toBeNull()
  })
})

describe('进会话存档', () => {
  it('没打开文件夹时是 null', () => {
    expect(tree.serializeState()).toBeNull()
  })

  it('摊开的顺序就是用户点开的顺序', async () => {
    await tree.openAt('/repo')
    await tree.toggle('node_modules')
    await tree.toggle('src')
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: ['', 'node_modules', 'src'] })
  })

  it('收起的层不进存档', async () => {
    await tree.openAt('/repo')
    await tree.toggle('src')
    await tree.toggle('src')
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: [''] })
  })

  it('restoreState(null) 等于关掉文件夹', async () => {
    await tree.openAt('/repo')
    await tree.restoreState(null)
    expect(tree.root()).toBeNull()
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

    const pending = tree.restoreState({ root: '/repo', expanded: ['', 'src'] })
    // 两个请求都发出去了而一个都还没回来 —— 串行的话这里只会看到 ['']
    expect(issued).toEqual(['', 'src'])
    for (const release of parked) release()
    await pending

    expect(tree.root()).toBe('/repo')
    expect(rels()).toEqual(['', 'src', 'src/main.rs', 'src/deep'])
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: ['', 'src'] })
  })

  it('存档里有一层已经不在树上时，恢复不崩也不多出孤行', async () => {
    // 存档之后那个目录被删了。错误确实被记下来了，但它的父层没摊开，
    // 所以那一行压根不在 `rows()` 里——不渲染一个用户看不见的错误，也不为它编一行出来
    await tree.restoreState({ root: '/repo', expanded: ['', 'src/gone'] })
    expect(row('')?.error).toBeNull()
    expect(row('src/gone')).toBeUndefined()
    expect(rels()).toEqual(['', 'src', 'README.md', 'node_modules'])
    expect(calls.map((c) => c[1]).sort()).toEqual(['', 'src/gone'])
  })

  it('⚠️ 存档里的重复 rel 只读一次，超出上限的部分被截掉', async () => {
    const many = Array.from({ length: MAX_RESTORED_EXPANDED + 100 }, (_, i) => `d${i}`)
    await tree.restoreState({ root: '/repo', expanded: ['', '', ...many, ...many] })
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
    expect(await tree.create('', '新建.md', 'file')).toBeNull()
    // `childRel('', name)` 必须给出 `name` 而不是 `/name`：后者是一条绝对路径，
    // Rust 侧的 `resolve` 会把它当成逃逸拒掉，而报错说的却是「内部错误」
    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', '新建.md', 'file')
    expect(calls).toEqual([['/repo', '']])
    expect(tree.selected()).toBe('新建.md')
    expect(rels()).toContain('新建.md')
  })

  it('⚠️ 在一个收起的目录里新建，那一层会被摊开', async () => {
    expect(row('src')?.expanded).toBe(false)
    expect(await tree.create('src', 'c.ts', 'file')).toBeNull()
    // 不摊开的话用户按了确定之后界面上什么也没多出来，他会再按一次，
    // 于是撞上一个 already_exists——一次「成功了却看不见」直接变成一次「失败」
    expect(row('src')?.expanded).toBe(true)
    expect(tree.selected()).toBe('src/c.ts')
    expect(rels()).toContain('src/c.ts')
  })

  it('新建文件夹时 kind 传 dir，摊开它是空的而不是读失败', async () => {
    expect(await tree.create('', 'assets', 'dir')).toBeNull()
    expect(ipc.createEntry).toHaveBeenCalledWith('/repo', 'assets', 'dir')
    await tree.toggle('assets')
    expect(row('assets')?.error).toBeNull()
    expect(row('assets')?.expanded).toBe(true)
  })

  it('名字撞了：回一句话，那一层不重读、选中不动', async () => {
    ipc.createEntry.mockImplementation(() => rejected({ kind: 'already_exists', path: '/repo/src/main.rs' }))
    const outcome = await tree.create('src', 'main.rs', 'file')
    expect(outcome).toContain('already_exists')
    expect(calls).toEqual([])
    expect(tree.selected()).toBeNull()
    expect(row('src')?.expanded).toBe(false)
  })

  it('还没打开文件夹时一句话回来，命令压根不发', async () => {
    tree.close()
    expect(await tree.create('', 'x.md', 'file')).toBe('还没打开文件夹')
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
    const pending = tree.create('', 'late.md', 'file')
    installFs({ '': [f('other.md')] })
    await tree.openAt('/other')

    release!()
    expect(await pending).toBeNull()
    // 结果落地时 rootToken 已经变了。要是它照样写状态，新树里会多出一行属于
    // 上一个文件夹的 late.md，而 selected 也停在一条不存在的 rel 上
    expect(rels()).toEqual(['', 'other.md'])
    expect(tree.selected()).toBeNull()
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
    await tree.toggle('src')
    calls.length = 0

    expect(await tree.rename('src/main.rs', 'c.ts')).toBeNull()
    // `newName` 是**单个名字**不是一条 rel：Tauri 2 把 Rust 的 `new_name` 转成驼峰，
    // 这是本项目第一个多单词命令参数，写错了只会得到一句「invalid args」
    expect(ipc.renameEntry).toHaveBeenCalledWith('/repo', 'src/main.rs', 'c.ts')
    expect(calls).toEqual([['/repo', 'src']])
    expect(tree.selected()).toBe('src/c.ts')
    expect(rels()).toEqual(['', 'src', 'src/c.ts', 'src/deep', 'README.md', 'node_modules'])
  })

  it('⚠️ 改一个摊开着的文件夹：整棵子树的摊开状态搬到新前缀上，旧缓存全扔', async () => {
    stubRename(true)
    await tree.toggle('src')
    await tree.toggle('src/deep')
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: ['', 'src', 'src/deep'] })
    calls.length = 0

    expect(await tree.rename('src', 'lib')).toBeNull()
    // 这一条是 `dropSubtree` + 搬迁的合落点。旧键必须走：`src` 与 `src/deep` 指向的
    // 缓存里每条 `DirEntry.rel` 都还是旧的，留着就会被写进存档、下次启动发一次注定失败的
    // listDir，而且用户把 `src` 建回来时会顶上一份改名之前的内容。
    // 但摊开状态得跟着搬，否则改个名字等于把用户摊开的三层全收起来
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: ['', 'lib', 'lib/deep'] })
    expect(calls.map((c) => c[1]).sort()).toEqual(['', 'lib', 'lib/deep'])
    expect(rels()).toEqual(['', 'lib', 'lib/main.rs', 'lib/deep', 'lib/deep/a.ts', 'README.md', 'node_modules'])
  })

  it('改一个收起的文件夹：只重读父层，不去读它里面', async () => {
    stubRename(true)
    calls.length = 0
    expect(await tree.rename('src', 'lib')).toBeNull()
    expect(calls).toEqual([['/repo', '']])
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: [''] })
  })

  it('⚠️ 收起的文件夹改名时，它下面那些看不见的摊开键被扔掉而不是搬成空壳', async () => {
    stubRename(true)
    // 先摊开两层再把外层收起来：`src/deep` 还留在 expanded 里，这是折叠一层时
    // 刻意不清子孙的结果（重新摊开外层时里层的现场还在）
    await tree.toggle('src')
    await tree.toggle('src/deep')
    await tree.toggle('src')
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: ['', 'src/deep'] })
    calls.length = 0

    expect(await tree.rename('src', 'lib')).toBeNull()
    // 搬过去的话 `lib/deep` 会是一个「标成摊开、缓存却被 dropSubtree 扔了」的键：
    // 那一行既不显示内容也不转圈，因为 `expand()` 只在 toggle 时跑，没人替它补读
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: [''] })
    expect(calls).toEqual([['/repo', '']])
  })

  it('撞名：回一句话，摊开状态与缓存都不动', async () => {
    await tree.toggle('src')
    calls.length = 0
    ipc.renameEntry.mockImplementation(() => rejected({ kind: 'already_exists', path: '/repo/src/deep' }))

    expect(await tree.rename('src/main.rs', 'deep')).toContain('already_exists')
    // 失败路径上一个键都不能改：`dropSubtree` 必须在 `renameEntry` **之后**才跑
    expect(calls).toEqual([])
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: ['', 'src'] })
    expect(rels()).toContain('src/main.rs')
  })

  it('还没打开文件夹时一句话回来，命令压根不发', async () => {
    tree.close()
    expect(await tree.rename('src', 'lib')).toBe('还没打开文件夹')
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
    expect(await tree.trash('')).toBe('不能把项目根目录移到废纸篓')
    // 这是全前端唯一一个不可逆的操作，而「菜单里不显示这一项」是一条改渲染时
    // 就会被改坏的约定——所以挡在 store 里，不是挡在 UI 里
    expect(ipc.trashEntry).not.toHaveBeenCalled()
    expect(tree.root()).toBe('/repo')
    expect(rels()).toEqual(['', 'src', 'README.md', 'node_modules'])
  })

  it('删一个摊开着的文件夹：整棵子树的状态一起走，选中落到父层', async () => {
    await tree.toggle('src')
    await tree.toggle('src/deep')
    calls.length = 0

    expect(await tree.trash('src')).toBeNull()
    expect(ipc.trashEntry).toHaveBeenCalledWith('/repo', 'src')
    // 选中挪到父层而不是留在原地：原来那一行没了，而 `actionForKey` 对「选中的 rel
    // 不在树里」的处理是从第一行起步——留着它，用户按一下方向键会觉得树跳了一下
    expect(tree.selected()).toBe('')
    expect(tree.serializeState()).toEqual({ root: '/repo', expanded: [''] })
    expect(rels()).toEqual(['', 'README.md', 'node_modules'])
    expect(calls).toEqual([['/repo', '']])
  })

  it('删一个文件：只有那一行没了，兄弟行原样', async () => {
    await tree.toggle('src')
    expect(await tree.trash('src/main.rs')).toBeNull()
    expect(tree.selected()).toBe('src')
    expect(rels()).toEqual(['', 'src', 'src/deep', 'README.md', 'node_modules'])
  })

  it('失败时一句话回来，那一行还在', async () => {
    ipc.trashEntry.mockImplementation(() =>
      rejected({ kind: 'io', reason: 'Trash', message: '没能把 /repo/README.md 移到废纸篓：权限不够' }),
    )
    expect(await tree.trash('README.md')).toContain('权限不够')
    expect(rels()).toContain('README.md')
    expect(calls.map((c) => c[1])).toEqual([''])
  })

  it('还没打开文件夹时一句话回来，命令压根不发', async () => {
    tree.close()
    expect(await tree.trash('README.md')).toBe('还没打开文件夹')
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
    expect(await tree.reveal('README.md')).toBeNull()
    expect(ipc.revealEntry).toHaveBeenCalledWith('/repo', 'README.md')
    expect(calls).toEqual([])
    expect(tree.selected()).toBeNull()
  })

  it('copyPath 成功回 null，同样不重读', async () => {
    ipc.copyEntryPath.mockResolvedValue(undefined)
    expect(await tree.copyPath('src/main.rs')).toBeNull()
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
    expect(await tree.reveal('README.md')).toContain('只支持 macOS')
    ipc.copyEntryPath.mockImplementation(() =>
      rejected({ kind: 'io', reason: 'Unsupported', message: '复制路径目前只支持 macOS' }),
    )
    expect(await tree.copyPath('README.md')).toContain('只支持 macOS')
  })

  it('目标已经不在了：一句话回来，树不动', async () => {
    ipc.revealEntry.mockImplementation(() => rejected({ kind: 'not_found', path: '/repo/gone.md' }))
    expect(await tree.reveal('gone.md')).toContain('not_found')
    expect(calls).toEqual([])
  })

  it('这两个操作刻意不看 rootToken：它们不改任何状态，没有「晚到污染新树」这回事', async () => {
    let release: (() => void) | undefined
    ipc.revealEntry.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    )
    const pending = tree.reveal('README.md')
    installFs({ '': [f('other.md')] })
    await tree.openAt('/other')
    release!()
    // 与 create/rename/trash 相反：那三个晚到时必须被丢掉，因为要写状态；
    // 这个晚到了顶多是 Finder 里选中了一个旧位置，没有状态可污染
    expect(await pending).toBeNull()
    expect(rels()).toEqual(['', 'other.md'])
  })

  it('还没打开文件夹时一句话回来，命令压根不发', async () => {
    tree.close()
    expect(await tree.reveal('x')).toBe('还没打开文件夹')
    expect(await tree.copyPath('x')).toBe('还没打开文件夹')
    expect(ipc.revealEntry).not.toHaveBeenCalled()
    expect(ipc.copyEntryPath).not.toHaveBeenCalled()
  })
})
