/**
 * **一个根**的全部状态：这个文件夹的绝对路径、哪些层摊开着、每层的条目、
 * 以及正在读/读失败的那几层。
 *
 * 多根工作区（M2-F）把原来的 `createProjectTree` 拆成了两层：这一层是「一棵树」，
 * `./store.ts` 是「N 棵树 + 一份把它们首尾相接的行」。拆开的理由不是代码长度，
 * 而是**三件事天然是按根分的**：
 *
 * 1. 缓存与展开集合的键是裸 `rel`，而 `rel` 只在「某一个 root」这一个语境里有意义。
 *    两个根都有一条 `''`，也都可能有一条 `src/a.ts`。要么给每个键都加上根序号，
 *    要么每个根存自己的一份——后者不用改任何一个 Map 的键。
 * 2. 「作废在飞的请求」这件事的粒度是根。换掉整个工作区时，所有实例一起被扔掉，
 *    而**移除一个根不该让别的根正在读的层白读一遍**。见下面 `disposed` 的文档。
 * 3. 移除一个根时它那份缓存（十万条 `DirEntry` 也不是不可能）该整个交给 GC，
 *    而不是从一个全局大 Map 里按前缀挑出来删。
 *
 * ## 结构性的部分不在这里
 *
 * 怎么摊成行、怎么算可视窗口、方向键落到哪，全在 `./tree.ts` 里，是纯函数。
 * 这一层只剩「异步 + 可变状态」。
 *
 * ## ⚠️ `root` 是构造参数，永不改
 *
 * 「换文件夹」在这一层没有对应操作：协调层的做法是**扔掉这个实例、建一个新的**。
 * 正因为路径定死，原来那个 `rootToken`（每换一次文件夹自增、回来时对不上号就丢弃结果）
 * 整个不需要了——迟到的结果写进的是一个已经被扔掉的实例，谁也读不到它。
 * 那条不变量从「靠一个计数器维持」变成了「靠实例的生命周期维持」，
 * 而后者没法在改代码时被顺手改坏。
 *
 * ## 为什么 `openFile` 不在这里
 *
 * 与 `workspace.ts` 的 `promptDiscard` 同理：这一层不该知道标签页的存在。
 * 打开文件是**协调层**的事（它手上才有跨根的行清单），所以 `run({kind:'open'})`
 * 压根不落在这里。
 */

import { createMemo, createSignal, type Accessor } from 'solid-js'
import {
  copyEntryPath,
  createEntry,
  describeTreeError,
  listDir,
  renameEntry,
  revealEntry,
  trashEntry,
  type DirEntry,
  type EntryKind,
} from '../ipc/project'
import type { SessionRoot } from '../ipc/session'
import { childRel, displayName, flattenRows, parentRel, rowKey, type RowKey, type TreeRow } from './tree'

/**
 * 一次写操作的结果：`null` = 成功，字符串 = **一句可以直接显示的人话**。
 *
 * 不用 throw：这些操作的失败绝大多数是**用户的处境**（名字重了、名字不合法、
 * 文件夹在别处被移走了），不是程序坏了。throw 出去就意味着每个调用点都得写 try/catch，
 * 而漏一处的失败方式是一次未捕获的 promise rejection——在 Tauri 里那只是控制台一行字，
 * 界面上什么也没发生，用户以为自己新建成功了。
 *
 * 与 `read` 把错误塞进 `errors` 映射不是一回事：那一套是给「某一层读不出来」用的，
 * 错误挂在行上；写操作的错误属于**这一次动作**，没有哪一行可以挂它。
 */
export type OpOutcome = Promise<string | null>

export interface RootTree {
  /** 绝对路径。构造时定死，见文件头 */
  readonly root: string
  /** 根行的显示名，也就是路径的最后一段。同样是定死的 */
  readonly rootName: string
  /**
   * 这个根在工作区里排第几，也就是它每一行的 `rootIndex`。
   *
   * 由协调层维护：移除一个根会让它后面所有根的位次前移，那时协调层逐个调 `setIndex`。
   * 做成信号而不是构造参数，是因为它盖在**每一行**上，改了就得重算行。
   */
  readonly index: Accessor<number>
  setIndex: (index: number) => void
  /** 这个根摊出来的行，每一行都盖着 `index()`。协调层把 N 份首尾相接 */
  readonly rows: Accessor<TreeRow[]>
  /** 摊开着的层（裸 `rel`）。协调层序列化时要读它 */
  readonly expanded: Accessor<ReadonlySet<string>>
  /**
   * 并行读这几层，**无条件重读**（不看缓存）。
   *
   * 两个调用点都在「这个实例刚建出来」的时候：打开文件夹读根那一层，
   * 恢复会话读存档里摊开着的那些层。所以缓存必然是空的，查它没有意义。
   */
  readLayers: (rels: readonly string[]) => Promise<void>
  /** 摊开/收起一层。摊开时按需去读 */
  toggle: (rel: string) => Promise<void>
  expand: (rel: string) => Promise<void>
  collapse: (rel: string) => void
  /**
   * 重读所有摊开着的层（并行），正在读的跳过。
   *
   * 树外面的世界随时在变（`git checkout`、构建产物、别的编辑器），而 M2-G 的文件监听
   * 还没落地，所以先给一个手动出口。读失败只在那一层留一句错误，不影响别层。
   */
  refresh: () => Promise<void>
  /**
   * 在 `parentRel` 那一层新建一个文件或文件夹。成功后新条目被选中、那一层被摊开。
   *
   * `parentRel` 是**父层**的 rel（在根层新建就传 `''`），名字单独传：
   * 拼成一条 rel 是 `childRel` 的事，UI 那边不该自己拼。
   */
  create: (parentRel: string, name: string, kind: EntryKind) => OpOutcome
  /** 同层改名。摊开状态与选中都跟着搬到新 rel 上 */
  rename: (rel: string, newName: string) => OpOutcome
  /**
   * 移到废纸篓。**不是真删**，能从 Finder 里捞回来。
   *
   * ⚠️ `rel === ''`（根行）一律拒绝：那是把用户整个项目文件夹扔进废纸篓，
   * 而右键菜单在根行上本来就不该出现这一项。这里再挡一次是因为**这是全前端
   * 唯一一个不可逆的操作**，而「UI 不显示这个菜单项」是一条会被改渲染时改坏的约定。
   */
  trash: (rel: string) => OpOutcome
  /** 在 Finder 中显示并选中（macOS）。不碰树的状态 */
  reveal: (rel: string) => OpOutcome
  /** 把绝对路径放进系统剪贴板（macOS）。不碰树的状态 */
  copyPath: (rel: string) => OpOutcome
  /** 存档里那一条。协调层按 `roots` 的顺序收集 */
  serialize: () => SessionRoot
  /**
   * 告诉这个实例「你已经不在工作区里了」。协调层在移除根与换掉整个工作区时调用。
   *
   * ⚠️ 它**不**取消在飞的请求（前端没有这个能力），只是让回来的结果不再影响界面，
   * 尤其是不再去写协调层那份**跨根共享**的选中。见 `disposed` 的文档。
   */
  dispose: () => void
}

export interface RootTreeOptions {
  root: string
  /** 一开始就摊开的层。恢复会话时直接把存档里的清单递进来，省一次 `setExpanded` */
  initialExpanded?: ReadonlySet<string>
  /**
   * 写操作成功之后要把选中挪到哪一行。`null` = 别动。
   *
   * 选中属于**整个工作区**（同时只有一行是高亮的），所以它住在协调层；
   * 而「新建完了该选中新条目」这条知识住在这里。注入一个回调是最短的桥。
   */
  onSelect?: (key: RowKey | null) => void
}

export function createRootTree(options: RootTreeOptions): RootTree {
  const root = options.root
  const rootName = displayName(root)
  const onSelect = options.onSelect ?? (() => {})

  const [index, setIndex] = createSignal(0)
  const [listings, setListings] = createSignal<ReadonlyMap<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(options.initialExpanded ?? new Set())
  const [loading, setLoading] = createSignal<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = createSignal<ReadonlyMap<string, string>>(new Map())

  /**
   * 这个实例被协调层扔掉了（工作区换掉、或这一个根被移除）。
   *
   * ⚠️ 它替代了原来的 `rootToken`，但作用**不是**「防止旧结果污染新树」——那件事已经由
   * 「路径定死 + 实例不复用」结构性地保证了（见文件头）。它防的是另一件事：
   * 一个已经被移除的根，它的在飞请求回来之后不该再去写选中。写缓存与展开集合是白写
   * （没人读了，GC 会收走），而 `onSelect` 是**协调层的**信号——那一次写入会让
   * 高亮跳到一个界面上已经不存在的根里去。
   */
  let disposed = false

  const rows = createMemo(() =>
    flattenRows(
      { rootName, rootPath: root, listings: listings(), expanded: expanded(), loading: loading(), errors: errors() },
      index(),
    ),
  )

  function mapWith<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
    const next = new Map(map)
    next.set(key, value)
    return next
  }

  function mapWithout<K, V>(map: ReadonlyMap<K, V>, key: K): Map<K, V> {
    const next = new Map(map)
    next.delete(key)
    return next
  }

  function setWith(set: ReadonlySet<string>, value: string): Set<string> {
    const next = new Set(set)
    next.add(value)
    return next
  }

  function setWithout(set: ReadonlySet<string>, value: string): Set<string> {
    const next = new Set(set)
    next.delete(value)
    return next
  }

  /** 按谓词摘掉一批键。与上面四个同一条约定：换一个新引用，Solid 才看得见变化 */
  function filterMap<K, V>(map: ReadonlyMap<K, V>, keep: (key: K) => boolean): Map<K, V> {
    const next = new Map(map)
    for (const key of [...next.keys()]) if (!keep(key)) next.delete(key)
    return next
  }

  function filterSet(set: ReadonlySet<string>, keep: (key: string) => boolean): Set<string> {
    const next = new Set(set)
    for (const key of [...next]) if (!keep(key)) next.delete(key)
    return next
  }

  /**
   * 读一层回来。
   *
   * ⚠️ **缓存键用的是请求时那个 `rel`，不是返回的 `listing.rel`。** 两者在 Rust 侧
   * `resolve()` 的归一化下必然相同（`rel` 只可能来自上一次的 `DirEntry.rel`，那已经是
   * 归一化形式），但这里要的是**自洽**：loading / errors / listings 三个容器必须由同一个
   * 字符串索引，否则一旦哪天两边不等，loading 就永远清不掉，那一层会一直转圈。
   */
  async function read(rel: string): Promise<void> {
    setLoading((prev) => setWith(prev, rel))
    try {
      const listing = await listDir(root, rel)
      if (disposed) return
      setListings((prev) => mapWith(prev, rel, listing.entries))
      // 上一次读失败留下的错误必须清掉，否则「刷新成功了但错误还挂着」
      setErrors((prev) => mapWithout(prev, rel))
    } catch (err) {
      if (disposed) return
      setErrors((prev) => mapWith(prev, rel, describeTreeError(err)))
    } finally {
      if (!disposed) setLoading((prev) => setWithout(prev, rel))
    }
  }

  async function readLayers(rels: readonly string[]): Promise<void> {
    // 并行，与 `workspace.restoreSession` 同一条理由：几十层串行读会把启动拖成好几秒。
    // 一个读不出来的层只在它自己那一行留一句错误，不影响别的层
    await Promise.all(rels.map((rel) => read(rel)))
  }

  async function expand(rel: string): Promise<void> {
    setExpanded((prev) => setWith(prev, rel))
    // 摊开过又收起来的层不重读：缓存还在，重读会让每次点开都闪一下 loading，
    // 而「树外面的文件变了」这件事由刷新（M2-G 之后是文件监听）负责，不该由展开负责
    if (listings().has(rel)) return
    await read(rel)
  }

  function collapse(rel: string) {
    setExpanded((prev) => setWithout(prev, rel))
  }

  async function toggle(rel: string): Promise<void> {
    if (expanded().has(rel)) collapse(rel)
    else await expand(rel)
  }

  async function refresh(): Promise<void> {
    const inFlight = loading()
    // 摊开着的层**全都**重读，只跳过正在读的那些（同一个请求排两遍队没有意义）。
    // ⚠️ 不能按「已经缓存过」来筛：读失败的那一层压根没有缓存，而它恰恰是用户
    // 最想刷新的——筛掉它就等于让那句错误永远挂在行上，怎么点刷新都不动
    const targets = [...expanded()].filter((rel) => !inFlight.has(rel))
    await Promise.all(targets.map((rel) => read(rel)))
  }

  /**
   * 扔掉一棵子树的全部状态：缓存、展开、loading、错误。
   *
   * 改名与移到废纸篓之后，旧 `rel` 下面的每一条键都指向一个不存在的东西了。
   * 不清的话它们**不会立刻出错**——`flattenRows` 只从 `listings` 生成行，孤立的键
   * 产生不了行，界面上看不出异常。但两件事会随后发生：① `expanded` 里那条会被
   * `serialize` 写进存档，重启时发一次注定失败的 `listDir`；② 用户把同名文件夹
   * 建回来时，那份**旧缓存**会直接顶上来，显示的是改名之前的内容。
   * 「不报错但结果是错的」正是这一层最难查的那类 bug。
   */
  function dropSubtree(rel: string) {
    const prefix = `${rel}/`
    const keep = (key: string) => key !== rel && !key.startsWith(prefix)
    setListings((prev) => filterMap(prev, keep))
    setErrors((prev) => filterMap(prev, keep))
    setLoading((prev) => filterSet(prev, keep))
    setExpanded((prev) => filterSet(prev, keep))
  }

  function select(rel: string) {
    if (!disposed) onSelect(rowKey(index(), rel))
  }

  async function create(parent: string, name: string, kind: EntryKind): Promise<string | null> {
    try {
      const made = await createEntry(root, childRel(parent, name), kind)
      if (disposed) return null
      // 那一层必须摊开着：右键一个**收起的**文件夹新建，如果不摊开，用户按了确定
      // 之后界面上什么也没多出来，他会以为没成功再按一次，于是撞上一个 already_exists
      setExpanded((prev) => setWith(prev, parent))
      select(made.rel)
      await read(parent)
      return null
    } catch (err) {
      return disposed ? null : describeTreeError(err)
    }
  }

  async function rename(rel: string, newName: string): Promise<string | null> {
    const parent = parentRel(rel)
    const wasExpanded = expanded().has(rel)
    // 子层里摊开着的那些，记住它们相对 `rel` 的后缀（`/deep`、`/deep/x`）。
    // 只在**这一层本来就摊开着**时才记：收起着的层的子孙压根不可见，把它们搬过去
    // 只会造出「标成摊开、却没有缓存」的状态——那一行既不显示内容也不转圈，
    // 因为 `expand()` 只在 toggle 时才跑，没人会去替它补一次读
    const openBelow = wasExpanded
      ? [...expanded()].filter((key) => key.startsWith(`${rel}/`)).map((key) => key.slice(rel.length))
      : []
    try {
      const made = await renameEntry(root, rel, newName)
      if (disposed) return null
      dropSubtree(rel)
      const reopened = openBelow.map((suffix) => `${made.rel}${suffix}`)
      // 摊开状态跟着搬过去：改名不改「用户想看着它里面」这件事。
      // ⚠️ 缓存不能跟着搬——每条 `DirEntry` 里都写着旧 `rel`，原样留着的话
      // 点一下就会拿一条不存在的路径去 `listDir`
      setExpanded((prev) => {
        let next = wasExpanded ? setWith(prev, made.rel) : prev
        for (const key of reopened) next = setWith(next, key)
        return next
      })
      select(made.rel)
      await Promise.all([read(parent), ...(wasExpanded ? [read(made.rel)] : []), ...reopened.map((key) => read(key))])
      return null
    } catch (err) {
      return disposed ? null : describeTreeError(err)
    }
  }

  /**
   * 移到废纸篓，然后重读父层。
   *
   * ⚠️ 被删的文件如果正开在某个标签里，那个标签**照常留着**：内容在内存里，
   * 用户还能把它保存回来（保存会重建文件）。这与「文件在别处被删掉」是同一种处境，
   * 归 M2-G 的文件监听管，不在这一层做特殊处理。
   */
  async function trash(rel: string): Promise<string | null> {
    // 根行不在这里被拒绝的话，右键项目根目录就能把整个项目文件夹扔进废纸篓。
    // 菜单里不显示这一项是 UI 的约定，而约定会在改渲染时被改坏——所以这里也挡一次
    if (rel === '') return '不能把项目根目录移到废纸篓'
    const parent = parentRel(rel)
    try {
      await trashEntry(root, rel)
      if (disposed) return null
      dropSubtree(rel)
      // 选中挪到父层：原来那一行没了，而 `actionForKey` 对「选中的行不在树里」
      // 的处理是从第一行起步——留着它，用户按一下方向键会觉得树跳了一下
      select(parent)
      await read(parent)
      return null
    } catch (err) {
      return disposed ? null : describeTreeError(err)
    }
  }

  async function reveal(rel: string): Promise<string | null> {
    // 不碰任何状态：`open -R` 只是把 Finder 推到前台。
    // 这个根随后被移除也只是 Finder 里显示了一个不再属于工作区的位置，没有状态会被污染
    try {
      await revealEntry(root, rel)
      return null
    } catch (err) {
      return describeTreeError(err)
    }
  }

  async function copyPath(rel: string): Promise<string | null> {
    try {
      await copyEntryPath(root, rel)
      return null
    } catch (err) {
      return describeTreeError(err)
    }
  }

  function serialize(): SessionRoot {
    // Set 的迭代顺序就是插入顺序，也就是用户摊开的先后。截断从后面截，
    // 由协调层的 `MAX_RESTORED_EXPANDED` 负责（这一层不截：截了 serialize 就不再是原样）
    return { root, expanded: [...expanded()] }
  }

  function dispose() {
    disposed = true
  }

  return {
    root,
    rootName,
    index,
    setIndex,
    rows,
    expanded,
    readLayers,
    toggle,
    expand,
    collapse,
    refresh,
    create,
    rename,
    trash,
    reveal,
    copyPath,
    serialize,
    dispose,
  }
}
