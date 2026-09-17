/**
 * 项目树的状态：打开了哪个文件夹、哪些层摊开着、每层的条目、以及正在读/读失败的那几层。
 *
 * 结构性的部分（怎么摊成行、怎么算可视窗口、方向键落到哪）全在 `./tree.ts` 里，是纯函数。
 * 这一层只剩「异步 + 可变状态」：什么时候去读、读回来放哪、换文件夹时把在飞的请求作废。
 *
 * ## 三条不变量
 *
 * 1. **`listings` 是缓存，不是树。** 只有摊开过的层才在里面，而且只在 `listDir` 回来之后
 *    才有。任何「遍历整棵树」的写法都会击穿 M2-A 的按需列举——Rust 侧压根没有全量树可给。
 * 2. **换文件夹要让在飞的请求作废**（`rootToken`）。旧文件夹的列举结果晚到一步，
 *    会把新文件夹的树污染成两棵树的混合体，而界面上看不出任何异常。
 * 3. **`rel` 是唯一的键。** 缓存、展开集合、loading、错误全部按 `rel` 索引，从不按 `path`：
 *    `path` 里含着 root，换过文件夹之后同一条 `path` 可能指向完全不同的东西，
 *    而 `rel` 只在「当前这个 root」这一个语境里有意义——换 root 时它整个被清空。
 *
 * ## 为什么 `openFile` 是注入进来的
 *
 * 与 `workspace.ts` 的 `promptDiscard` 同理：这一层不该知道标签页的存在，
 * 而且直接 import `createWorkspace` 会让两层互相引用成环。
 */

import { createMemo, createSignal, type Accessor } from 'solid-js'
import { open as pickDirectory } from '@tauri-apps/plugin-dialog'
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
import type { SessionProject } from '../ipc/session'
import { childRel, displayName, flattenRows, parentRel, type TreeAction, type TreeRow } from './tree'

/**
 * 恢复会话时最多摊开多少层。
 *
 * 与 `MAX_SESSION_TABS` 同一性质：不是产品限制，是**预算限制**。存档是磁盘上的 JSON，
 * 可能被别的版本写过、也可能被手改坏过，而这里每一条 `rel` 都对应一次 `listDir` IPC——
 * 一万条就是一万次往返，启动会被拖死。512 层已经远超任何人手工摊开的规模。
 *
 * 超出部分从**后面**截断：`expanded` 是按摊开顺序存的，越靠后越是刚才顺手点开的。
 */
export const MAX_RESTORED_EXPANDED = 512

/**
 * 一次写操作的结果：`null` = 成功，字符串 = **一句可以直接显示的人话**。
 *
 * 不用 throw：这些操作的失败绝大多数是**用户的处境**（名字重了、名字不合法、
 * 文件夹在别处被移走了），不是程序坏了。throw 出去就意味着每个调用点都得写 try/catch，
 * 而漏一处的失败方式是一次未捕获的 promise rejection——在 Tauri 里那只是控制台一行字，
 * 界面上什么也没发生，用户以为自己新建成功了。
 *
 * 与 `load` 把错误塞进 `errors` 映射不是一回事：那一套是给「某一层读不出来」用的，
 * 错误挂在行上；写操作的错误属于**这一次动作**，没有哪一行可以挂它。
 */
export type OpOutcome = Promise<string | null>

export interface ProjectTree {
  /** null = 还没打开任何文件夹 */
  readonly root: Accessor<string | null>
  /** 根行的显示名。没打开文件夹时是空字符串 */
  readonly rootName: Accessor<string>
  /** 扁平化后的可见行，直接喂给虚拟滚动 */
  readonly rows: Accessor<TreeRow[]>
  /** 选中行的 `rel`，null = 没选中 */
  readonly selected: Accessor<string | null>
  /** 用 dialog 挑一个文件夹并打开 */
  openViaDialog: () => Promise<void>
  /** 打开一个已知路径的文件夹。会话恢复走这里 */
  openAt: (root: string) => Promise<void>
  /** 关掉当前文件夹。不动任何标签页——已经打开的文件仍然是打开的 */
  close: () => void
  /** 摊开/收起一层。摊开时按需去读 */
  toggle: (rel: string) => Promise<void>
  select: (rel: string) => void
  /** 执行一个 `actionForKey` 或点击产生的动作 */
  run: (action: TreeAction) => void
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
  /**
   * 当前状态里值得进会话存档的部分。没打开文件夹时是 null。
   *
   * 返回类型直接就是**线上契约**那个 `SessionProject`（`src/ipc/session.ts`），
   * 这一层不另定义一个同形接口：两份一样的形状会各自漂移，而漂了也不报错——
   * `workspace.ts` 直接用 `Session` / `SessionTab` 是同一条道理。
   */
  serializeState: () => SessionProject | null
  /**
   * 用存档把树整个换掉。`null` = 上次也没打开文件夹。
   *
   * ⚠️ 与 `workspace.restoreSession` 一样**只在启动时用一次**：它会扔掉当前的树。
   */
  restoreState: (saved: SessionProject | null) => Promise<void>
}

export interface ProjectTreeOptions {
  /** 点一个文件时要做什么。App 注入 `ws.openAt` */
  openFile?: (path: string) => Promise<void>
}

export function createProjectTree(options: ProjectTreeOptions = {}): ProjectTree {
  const openFileAt = options.openFile ?? (async () => {})

  const [root, setRoot] = createSignal<string | null>(null)
  const [listings, setListings] = createSignal<ReadonlyMap<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = createSignal<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = createSignal<ReadonlyMap<string, string>>(new Map())
  const [selected, setSelected] = createSignal<string | null>(null)

  /**
   * 每换一次文件夹就自增。在飞的 `listDir` 回来时对不上号，结果直接丢掉。
   *
   * 不是 signal：没有任何渲染依赖它，而把它做成 signal 会让每次换文件夹都白跑一遍
   * `rows()` 的重算。`workspace.ts` 里的 `languageToken` 是同一个套路。
   */
  let rootToken = 0

  const rootName = createMemo(() => {
    const at = root()
    return at === null ? '' : displayName(at)
  })

  const rows = createMemo(() => {
    const at = root()
    if (at === null) return []
    return flattenRows({
      rootName: rootName(),
      rootPath: at,
      listings: listings(),
      expanded: expanded(),
      loading: loading(),
      errors: errors(),
    })
  })

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
  async function load(rel: string): Promise<void> {
    const at = root()
    if (at === null) return
    const token = rootToken
    setLoading((prev) => setWith(prev, rel))
    try {
      const listing = await listDir(at, rel)
      if (token !== rootToken) return
      setListings((prev) => mapWith(prev, rel, listing.entries))
      // 上一次读失败留下的错误必须清掉，否则「刷新成功了但错误还挂着」
      setErrors((prev) => mapWithout(prev, rel))
    } catch (err) {
      if (token !== rootToken) return
      setErrors((prev) => mapWith(prev, rel, describeTreeError(err)))
    } finally {
      if (token === rootToken) setLoading((prev) => setWithout(prev, rel))
    }
  }

  async function expand(rel: string): Promise<void> {
    setExpanded((prev) => setWith(prev, rel))
    // 摊开过又收起来的层不重读：缓存还在，重读会让每次点开都闪一下 loading，
    // 而「树外面的文件变了」这件事由刷新（M2-G 之后是文件监听）负责，不该由展开负责
    if (listings().has(rel)) return
    await load(rel)
  }

  function collapse(rel: string) {
    setExpanded((prev) => setWithout(prev, rel))
  }

  async function toggle(rel: string): Promise<void> {
    if (expanded().has(rel)) collapse(rel)
    else await expand(rel)
  }

  /** 换 root 时把所有按 root 才有意义的状态一次性清空 */
  function reset(nextRoot: string | null, nextExpanded: ReadonlySet<string>) {
    // 先自增再改 root：改 root 会触发重渲染，而在飞的旧请求必须在那之前就已作废
    rootToken++
    setRoot(nextRoot)
    setListings(new Map<string, DirEntry[]>())
    setErrors(new Map<string, string>())
    setLoading(new Set<string>())
    setSelected(null)
    setExpanded(nextExpanded)
  }

  async function openAt(next: string): Promise<void> {
    // 根默认摊开：打开一个文件夹却只看到一行、还得再点一次才看得见内容，
    // 那一下点击没有任何信息量
    reset(next, new Set(['']))
    await load('')
  }

  async function openViaDialog(): Promise<void> {
    // `directory: true` 是 `root` 唯一可能的来源。前端没有任何输入框能填它——
    // 这是 M2-A 那条「信任面」记录里的前提，见 `src-tauri/src/commands.rs` 的文件头
    const picked = await pickDirectory({ multiple: false, directory: true })
    if (typeof picked === 'string') await openAt(picked)
  }

  function close() {
    reset(null, new Set())
  }

  async function refresh(): Promise<void> {
    const inFlight = loading()
    // 摊开着的层**全都**重读，只跳过正在读的那些（同一个请求排两遍队没有意义）。
    // ⚠️ 不能按「已经缓存过」来筛：读失败的那一层压根没有缓存，而它恰恰是用户
    // 最想刷新的——筛掉它就等于让那句错误永远挂在行上，怎么点刷新都不动
    const targets = [...expanded()].filter((rel) => !inFlight.has(rel))
    await Promise.all(targets.map((rel) => load(rel)))
  }

  /**
   * 扔掉一棵子树的全部状态：缓存、展开、loading、错误。
   *
   * 改名与移到废纸篓之后，旧 `rel` 下面的每一条键都指向一个不存在的东西了。
   * 不清的话它们**不会立刻出错**——`flattenRows` 只从 `listings` 生成行，孤立的键
   * 产生不了行，界面上看不出异常。但两件事会随后发生：① `expanded` 里那条会被
   * `serializeState` 写进存档，重启时发一次注定失败的 `listDir`；② 用户把同名文件夹
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

  /** 写操作失败时统一的一句话。`root()` 为 null 说明文件夹在操作途中被关掉了 */
  const NO_FOLDER = '还没打开文件夹'

  async function create(parent: string, name: string, kind: EntryKind): Promise<string | null> {
    const at = root()
    if (at === null) return NO_FOLDER
    const token = rootToken
    try {
      const made = await createEntry(at, childRel(parent, name), kind)
      if (token !== rootToken) return null
      // 那一层必须摊开着：右键一个**收起的**文件夹新建，如果不摊开，用户按了确定
      // 之后界面上什么也没多出来，他会以为没成功再按一次，于是撞上一个 already_exists
      setExpanded((prev) => setWith(prev, parent))
      setSelected(made.rel)
      await load(parent)
      return null
    } catch (err) {
      return token === rootToken ? describeTreeError(err) : null
    }
  }

  async function rename(rel: string, newName: string): Promise<string | null> {
    const at = root()
    if (at === null) return NO_FOLDER
    const token = rootToken
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
      const made = await renameEntry(at, rel, newName)
      if (token !== rootToken) return null
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
      setSelected(made.rel)
      await Promise.all([load(parent), ...(wasExpanded ? [load(made.rel)] : []), ...reopened.map((key) => load(key))])
      return null
    } catch (err) {
      return token === rootToken ? describeTreeError(err) : null
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
    const at = root()
    if (at === null) return NO_FOLDER
    const token = rootToken
    const parent = parentRel(rel)
    try {
      await trashEntry(at, rel)
      if (token !== rootToken) return null
      dropSubtree(rel)
      // 选中挪到父层：原来那一行没了，而 `actionForKey` 对「选中的 rel 不在树里」
      // 的处理是从第一行起步——留着它，用户按一下方向键会觉得树跳了一下
      setSelected(parent)
      await load(parent)
      return null
    } catch (err) {
      return token === rootToken ? describeTreeError(err) : null
    }
  }

  async function reveal(rel: string): Promise<string | null> {
    const at = root()
    if (at === null) return NO_FOLDER
    // 不碰 rootToken 也不碰任何状态：`open -R` 只是把 Finder 推到前台，
    // 换过文件夹之后它顶多显示了一个旧位置，没有状态会被污染
    try {
      await revealEntry(at, rel)
      return null
    } catch (err) {
      return describeTreeError(err)
    }
  }

  async function copyPath(rel: string): Promise<string | null> {
    const at = root()
    if (at === null) return NO_FOLDER
    try {
      await copyEntryPath(at, rel)
      return null
    } catch (err) {
      return describeTreeError(err)
    }
  }

  function run(action: TreeAction) {
    switch (action.kind) {
      case 'none':
        return
      case 'select':
        setSelected(action.rel)
        return
      case 'expand':
        // 展开的同时把选中挪过去：方向键的语义是「移动到那里并做这件事」，
        // 只动树不动选中的话，连按两下右键会一直在同一行上打转
        setSelected(action.rel)
        void expand(action.rel)
        return
      case 'collapse':
        setSelected(action.rel)
        collapse(action.rel)
        return
      case 'open': {
        setSelected(action.rel)
        const row = rows().find((r) => r.rel === action.rel)
        // 目录走不到这个分支（`actionForKey` 对目录返回 expand/collapse），
        // 但右键菜单与将来的双击都会构造 `open`，所以这里自己再判一次
        if (row && !row.isDir) void openFileAt(row.path)
        return
      }
    }
  }

  function serializeState(): SessionProject | null {
    const at = root()
    if (at === null) return null
    // Set 的迭代顺序就是插入顺序，也就是用户摊开的先后。截断从后面截（见 MAX_RESTORED_EXPANDED）
    return { root: at, expanded: [...expanded()] }
  }

  async function restoreState(saved: SessionProject | null): Promise<void> {
    if (saved === null) {
      close()
      return
    }
    // 先去重再截断：存档是磁盘上的 JSON，重复的 `rel` 会各自发一次 `listDir`，
    // 而上限本来要限的是「多少个**不同的**层」。顺序是 Set 的插入顺序，也就是存档里的顺序
    const wanted = [...new Set(saved.expanded)].slice(0, MAX_RESTORED_EXPANDED)
    reset(saved.root, new Set(wanted))
    // 并行读，与 `workspace.restoreSession` 同一条理由：几十层串行读会把启动拖成好几秒。
    // 一个打不开的层（存档之后被删了）只在它自己那一行留一句错误，不影响别的层
    await Promise.all(wanted.map((rel) => load(rel)))
  }

  return {
    root,
    rootName,
    rows,
    selected,
    openViaDialog,
    openAt,
    close,
    toggle,
    select: setSelected,
    run,
    refresh,
    create,
    rename,
    trash,
    reveal,
    copyPath,
    serializeState,
    restoreState,
  }
}
