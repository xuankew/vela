/**
 * **多根工作区**的协调层：N 棵 `RootTree`（`./rootTree.ts`）+ 一份把它们首尾相接的行清单
 * + 一份跨根共享的选中。
 *
 * 这一层自己**不存任何一层目录的内容**。缓存、展开集合、loading、错误全在各个根实例里，
 * 理由见 `./rootTree.ts` 的文件头（一句话：`rel` 只在某一个根的语境里有意义）。
 * 这里剩下的是三件只有站在「整份工作区」的角度才说得清的事：
 *
 * 1. **行的拼接与位次。** 每个根的 `flattenRows` 都以一条 `depth: 0` 的根行开头，
 *    所以按位次首尾相接之后每个根的行仍然连续——`actionForKey` 要的「找父目录不跨根」
 *    与「上下键能跨根」两条性质都是白拿的，不需要为多根写一条分支。
 * 2. **选中。** 同时只有一行是高亮的，而那一行可能属于任何一个根，所以它必须住在这里。
 *    移除一个根时它还要跟着重映射，见 `removeRoot`。
 * 3. **生命周期。** 建实例、扔实例、把位次写回各个实例。
 *
 * 结构性的部分（怎么摊成行、怎么算可视窗口、方向键落到哪）全在 `./tree.ts` 里，是纯函数。
 *
 * ## ⚠️ 「没打开文件夹」只有一种写法
 *
 * `mounted()` 是空数组，`serializeState()` 返回 `null`。存档里**不存在** `roots: []`
 * 这种形状（Rust 的 `validate` 会拒），所以「空工作区」与「一份坏存档」不会混淆。
 *
 * ## 为什么 `openFile` 是注入进来的
 *
 * 与 `workspace.ts` 的 `promptDiscard` 同理：这一层不该知道标签页的存在，
 * 而且直接 import `createWorkspace` 会让两层互相引用成环。
 */

import { createMemo, createRoot, createSignal, type Accessor } from 'solid-js'
import { open as pickDirectory } from '@tauri-apps/plugin-dialog'
import type { EntryKind } from '../ipc/project'
import type { SessionProject, SessionRoot } from '../ipc/session'
import { createRootTree, type OpOutcome, type RootTree } from './rootTree'
import { keyOf, rowKey, sameRow, type RowKey, type TreeAction, type TreeRow } from './tree'

/**
 * 恢复会话时最多摊开多少层。**每个根各算一份**。
 *
 * 与 `MAX_SESSION_TABS` 同一性质：不是产品限制，是**预算限制**。存档是磁盘上的 JSON，
 * 可能被别的版本写过、也可能被手改坏过，而这里每一条 `rel` 都对应一次 `listDir` IPC——
 * 一万条就是一万次往返，启动会被拖死。512 层已经远超任何人手工摊开的规模。
 *
 * 超出部分从**后面**截断：`expanded` 是按摊开顺序存的，越靠后越是刚才顺手点开的。
 */
export const MAX_RESTORED_EXPANDED = 512

/**
 * 恢复会话时最多认几个根。
 *
 * 与 `MAX_RESTORED_EXPANDED` 同一性质，管的是同一笔预算的另一个维度：每个根都要发一次
 * `listDir`（外加它自己摊开着的那些层），而 `Cmd+P` 与全局搜索还会**逐根建索引**。
 * 16 个根已经远超「一个人同时开着几个仓库」的规模。
 *
 * ⚠️ 这条**只在恢复时生效**，`addRoot` 不受它管：存档是不可信输入（可能被手改成几千个根），
 * 而一次点击加一个文件夹是用户自己看着办的动作，成本对他可见。
 *
 * 超出部分从**后面**截断：`roots` 的顺序就是侧边栏从上到下的顺序，越靠后越是刚加进来的。
 */
export const MAX_RESTORED_ROOTS = 16

/**
 * 最近项目清单最多记几条（M2-F-6）。
 *
 * 与 `MAX_RECENT`（`src/doc/workspace.ts`，50 条**文件**）刻意不同值：一份工作区是
 * 「我这几天在哪个项目里干活」，一个人手上同时有十来个就已经很多了，而 `Cmd+Shift+O`
 * 一屏也就显示十来行——记 50 条只是让后面那 38 条永远排在滚动区外面。
 *
 * ⚠️ 上限只归**这里**：Rust 侧的 `Session::validate` 不看 `recentProjects`、也不截断它，
 * 理由与 `recent` 逐字相同（见 `crates/vela-core/src/session/mod.rs`）。
 */
export const MAX_RECENT_PROJECTS = 12

/**
 * 两份根清单是不是**同一个工作区**。
 *
 * 逐个比而不是比 `join('\n')`：路径里可以有换行（APFS 只禁 `/` 与 NUL），
 * 拼接当键会把 `['a\nb']` 与 `['a', 'b']` 认成同一个——于是切一次项目就把另一条
 * 从清单里挤掉，而用户看到的是「我明明开过那个文件夹，它却不见了」
 */
export function sameWorkspace(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((root, i) => root === b[i])
}

/**
 * 把 `entry` 顶到清单最前面，顺手把与它相同的那一份摘掉，再截到 `cap` 条。
 *
 * 「先摘再顶」而不是「先顶再 dedup」：结果一样，但这样写**空清单**这个特例是自然的
 * （`entry` 为空 = 此刻没有工作区，那就什么都不记，见下面的 early return）。
 *
 * ⚠️ 空 `entry` 一律不记。否则「关闭所有文件夹」之后紧接着一次保存，
 * 清单最前面就会多出一条空工作区，而 `Cmd+Shift+O` 会把它画成一行没有名字的候选
 */
export function rememberWorkspace(
  list: readonly (readonly string[])[],
  entry: readonly string[],
  cap: number,
): (readonly string[])[] {
  if (entry.length === 0) return list.slice(0, cap)
  return [[...entry], ...list.filter((each) => !sameWorkspace(each, entry))].slice(0, cap)
}

/**
 * 一个已经挂进工作区的根，连着它自己的反应式所有者。
 *
 * `release` 必须与 `dispose` 成对调用：`dispose` 只是让实例停止影响界面，
 * 而它那个 `rows()` memo 是挂在 `createRoot` 造出来的所有者上的——不 `release`
 * 就永远不会被回收。对一个主打低内存的编辑器来说，「每关一个文件夹漏一个 memo」
 * 正是要防的那种账。
 */
interface Mounted {
  readonly tree: RootTree
  readonly release: () => void
}

export interface ProjectTree {
  /** 工作区里的根，按位次（也就是 `RowKey.rootIndex`）。空数组 = 没打开任何文件夹 */
  readonly roots: Accessor<readonly string[]>
  /** 所有根的行首尾相接，直接喂给虚拟滚动 */
  readonly rows: Accessor<TreeRow[]>
  /**
   * 选中行的身份（第几个根 + rel），null = 没选中。
   *
   * ⚠️ 不是裸 `rel`：多根之下两个根都有一条 `''`。比较一律走 `sameRow`，
   * 因为 `RowKey` 是结构体、`===` 比的是引用
   */
  readonly selected: Accessor<RowKey | null>
  /**
   * 第 `index` 个根的显示名。越界返回空字符串。
   *
   * 是个普通函数而不是访问器数组：读它的人（侧边栏的对话框标题）手上已经有 `rootIndex`，
   * 而它读的 `mounted()` 是信号，在 JSX 里自然是响应式的
   */
  rootName: (index: number) => string
  /** 用 dialog 挑一个文件夹并**替换**整个工作区 */
  openViaDialog: () => Promise<void>
  /**
   * 打开一个已知路径的文件夹，**替换**整个工作区（原有的根全部被扔掉）。
   *
   * 会话恢复不走这里——它走 `restoreState`，那条能一次装回 N 个根，
   * 而且不会把存档里的展开清单丢掉。
   */
  openAt: (root: string) => Promise<void>
  /**
   * 一次装回 N 个根，**整个换掉**当前工作区。`Cmd+Shift+O` 挑中一条最近项目就是走这里。
   *
   * 与 `restoreState` 的区别只有一个：这一条不认存档里的展开清单，每个根都只摊开根层
   * （切到一个几个月没碰的项目时，上次摊到第八层的那些目录只会让人找不到自己在哪）。
   * 清单会去重并截到 `MAX_RESTORED_ROOTS`——它来自磁盘上的 JSON，是不可信输入
   */
  openMany: (roots: readonly string[]) => Promise<void>
  /** 用 dialog 挑文件夹**追加**到工作区（可多选） */
  addViaDialog: () => Promise<void>
  /** 追加一个已知路径的文件夹。已经在工作区里就什么也不做 */
  addRoot: (root: string) => Promise<void>
  /**
   * 把第 `index` 个根移出工作区。**不碰磁盘**，也不动任何标签页——
   * 那个文件夹下已经打开的文件仍然是打开的。
   *
   * 它后面所有根的位次前移一位，选中跟着重映射，见实现里那两条注释。
   */
  removeRoot: (index: number) => void
  /** 关掉所有文件夹。不动任何标签页——已经打开的文件仍然是打开的 */
  close: () => void
  /** 摊开/收起一层。摊开时按需去读 */
  toggle: (key: RowKey) => Promise<void>
  select: (key: RowKey) => void
  /** 执行一个 `actionForKey` 或点击产生的动作 */
  run: (action: TreeAction) => void
  /**
   * 重读所有根里摊开着的层（并行），正在读的跳过。
   *
   * 树外面的世界随时在变（`git checkout`、构建产物、别的编辑器），而 M2-G 的文件监听
   * 还没落地，所以先给一个手动出口。读失败只在那一层留一句错误，不影响别层。
   */
  refresh: () => Promise<void>
  /**
   * 在 `key` 那一层新建一个文件或文件夹。成功后新条目被选中、那一层被摊开。
   *
   * `key` 是**父层**的行（在根层新建就是那个根的根行），名字单独传：
   * 「文件行要落到它的父层」是 `containerRel` 的判断，由 UI 侧做完再递进来。
   * 拼成一条 rel 是 `childRel` 的事，UI 那边不该自己拼。
   */
  create: (key: RowKey, name: string, kind: EntryKind) => OpOutcome
  /** 同层改名。摊开状态与选中都跟着搬到新 rel 上 */
  rename: (key: RowKey, newName: string) => OpOutcome
  /**
   * 移到废纸篓。**不是真删**，能从 Finder 里捞回来。
   *
   * ⚠️ 根行一律被拒：那是把用户整个项目文件夹扔进废纸篓，而右键菜单在根行上本来就
   * 不该出现这一项。那道拦截在 `rootTree.ts` 里（判据是裸 `rel === ''`，与 `rootIndex`
   * 无关，所以 N 个根行一条都跑不掉）
   */
  trash: (key: RowKey) => OpOutcome
  /** 在 Finder 中显示并选中（macOS）。不碰树的状态 */
  reveal: (key: RowKey) => OpOutcome
  /** 把绝对路径放进系统剪贴板（macOS）。不碰树的状态 */
  copyPath: (key: RowKey) => OpOutcome
  /**
   * 当前状态里值得进会话存档的部分。一个根都没有时是 null。
   *
   * ⚠️ 不是 `{ roots: [] }`：那个形状会被 Rust 的 `validate` 拒掉，而「上次没打开文件夹」
   * 是一条完全合法的现场，不该被当成坏存档。
   *
   * 返回类型直接就是**线上契约**那个 `SessionProject`（`src/ipc/session.ts`），
   * 这一层不另定义一个同形接口：两份一样的形状会各自漂移，而漂了也不报错——
   * `workspace.ts` 直接用 `Session` / `SessionTab` 是同一条道理。
   */
  serializeState: () => SessionProject | null
  /**
   * 用存档把工作区整个换掉。`null` = 上次也没打开文件夹。
   *
   * ⚠️ 与 `workspace.restoreSession` 一样**只在启动时用一次**：它会扔掉当前所有的根。
   */
  restoreState: (saved: SessionProject | null) => Promise<void>
  /**
   * 可以切过去的那些工作区，最新的在最前面（M2-F-6，`Cmd+Shift+O` 的数据源）。
   *
   * ⚠️ **当前这一份已经被排掉了**：挑中它会把整棵树重建一遍，摊开着的层全部收起，
   * 而用户看着的正是它——「切到我现在这个项目」唯一的效果是把他刚摊开的目录关掉
   */
  readonly recentProjects: Accessor<readonly (readonly string[])[]>
  /**
   * 存档里「最近项目」那一半。与 `recentProjects()` 差一条：**当前工作区被顶到最前面**。
   *
   * 存档记的是「这个人都在哪些项目里干过活」，那当然包括此刻这一个；
   * 而上面那个访问器服务的是「切到别处去」，那当然不包括此刻这一个。
   * 两个都从同一份内存清单算出来，所以不存在第三份会漂的抄写
   */
  serializeRecent: () => string[][]
  /**
   * 启动时把存档里的最近项目清单装回来。空条目与重复条目在这里被摘掉，
   * 条数截到 `MAX_RECENT_PROJECTS`——与 `restoreState` 对根清单做的事同一套
   */
  restoreRecent: (saved: readonly (readonly string[])[]) => void
}

export interface ProjectTreeOptions {
  /** 点一个文件时要做什么。App 注入 `ws.openAt` */
  openFile?: (path: string) => Promise<void>
}

export function createProjectTree(options: ProjectTreeOptions = {}): ProjectTree {
  const openFileAt = options.openFile ?? (async () => {})

  const [mounted, setMounted] = createSignal<readonly Mounted[]>([])
  const [selected, setSelected] = createSignal<RowKey | null>(null)
  /** 最近项目清单的内存态。写入只走 `rememberOutgoing` 与 `restoreRecent` */
  const [recent, setRecent] = createSignal<readonly (readonly string[])[]>([])

  /**
   * 建一个根实例，连同它自己的反应式所有者。
   *
   * ⚠️ memo 必须建在 `createRoot` 里面：建在外面的话它挂在**调用方**的所有者上，
   * 而 `createProjectTree` 的所有者活得和整个 App 一样久，于是每移除一个根就漏一个 memo。
   */
  function spawn(path: string, index: number, initialExpanded: ReadonlySet<string>): Mounted {
    let release = () => {}
    const tree = createRoot((dispose) => {
      release = dispose
      return createRootTree({ root: path, initialExpanded, onSelect: setSelected })
    })
    tree.setIndex(index)
    return {
      tree,
      release: () => {
        tree.dispose()
        release()
      },
    }
  }

  function at(index: number): RootTree | undefined {
    return mounted()[index]?.tree
  }

  function rootName(index: number): string {
    return at(index)?.rootName ?? ''
  }

  const roots = createMemo(() => mounted().map((m) => m.tree.root))

  /**
   * 换工作区之前，把**正要离开的那一份**记到清单最前面。
   *
   * ## ⚠️ 为什么记在「离开」这一刻，而不是每隔几秒存盘那一刻
   *
   * 存盘那一轮最长要等 5 秒（`SESSION_SYNC_INTERVAL_MS`）。而 `Cmd+Shift+O` 最典型的
   * 用法恰恰是「刚切过来，切错了，马上切回去」——那份清单如果只在存盘时更新，
   * 这几秒里它压根还没有刚离开的那个项目，用户按了键看到的是一个空的浮层。
   *
   * ## ⚠️ 为什么 `addRoot` / `removeRoot` **不**调它
   *
   * 那两条是**增量**：从 `[A]` 加到 `[A, B]`，`[A]` 不是一个用户想切回去的项目，
   * 它是同一个项目攒到一半的样子。记下来的话清单里会全是这种中间态，
   * 而真正想回去的那一份反而被挤到 `MAX_RECENT_PROJECTS` 外面。
   * 只有「整个换掉」与「全部关掉」两种动作才算换了一个项目
   */
  function rememberOutgoing() {
    setRecent((list) => rememberWorkspace(list, roots(), MAX_RECENT_PROJECTS))
  }

  const rows = createMemo(() => mounted().flatMap((m) => m.tree.rows()))

  /** 扔掉所有根。换工作区、关闭文件夹、恢复会话三处共用 */
  function releaseAll() {
    for (const m of mounted()) m.release()
    setMounted([])
    setSelected(null)
  }

  async function openAt(path: string): Promise<void> {
    rememberOutgoing()
    releaseAll()
    // 根默认摊开：打开一个文件夹却只看到一行、还得再点一次才看得见内容，
    // 那一下点击没有任何信息量
    const first = spawn(path, 0, new Set(['']))
    setMounted([first])
    await first.tree.readLayers([''])
  }

  /**
   * 挑文件夹。`directory: true` 是 `root` 唯一可能的来源——前端没有任何输入框能填它，
   * 这是 M2-A 那条「信任面」记录里的前提，见 `src-tauri/src/commands.rs` 的文件头。
   *
   * `multiple` 只在 `addViaDialog` 上开：`Cmd` 多选几个文件夹一起加进工作区
   * 是多根最自然的入口。`openViaDialog` 保持单选，因为它的语义是「换成这一个」。
   */
  async function pick(multiple: boolean): Promise<string[]> {
    const picked = await pickDirectory({ multiple, directory: true })
    if (typeof picked === 'string') return [picked]
    if (Array.isArray(picked)) return picked
    return []
  }

  async function openViaDialog(): Promise<void> {
    const [first] = await pick(false)
    if (first !== undefined) await openAt(first)
  }

  async function addRoot(path: string): Promise<void> {
    const list = mounted()
    // 同一个文件夹加两遍会得到两份各自维护的缓存与两套一模一样的行，
    // 而在第二份里改名不会让第一份跟着变——界面上看起来就是「树坏了」
    if (list.some((m) => m.tree.root === path)) return
    const made = spawn(path, list.length, new Set(['']))
    setMounted([...list, made])
    await made.tree.readLayers([''])
  }

  async function addViaDialog(): Promise<void> {
    // 串行加：`addRoot` 要读「当前有几个根」来定新根的位次，
    // 并行调它会让两个根抢到同一个位次
    for (const path of await pick(true)) await addRoot(path)
  }

  function removeRoot(index: number): void {
    const list = mounted()
    const target = list[index]
    if (!target) return
    target.release()
    const next = list.filter((_, i) => i !== index)
    // 位次必须显式写回：`RowKey.rootIndex` 是行的一部分，而行是 memo 出来的。
    // ⚠️ 刻意**不**做成「每行现算自己在哪个根里」的访问器——那样 `mounted()` 一变，
    // 所有根的 `rows()` 都要重算，`<For>` 赖以复用 DOM 的行对象引用相等就全没了，
    // 表现是「移除一个根，整棵树闪一下」。`setIndex` 在数值没变时不通知（默认 `===`），
    // 所以只有真正前移了的那几个根会重算
    next.forEach((m, i) => m.tree.setIndex(i))
    setMounted(next)
    // 选中跟着搬：被移除那个根里的选中作废，后面的根各前移一位。
    // 不重映射的话高亮会留在一个已经不存在的位次上，而 `actionForKey` 找不到它，
    // 用户按一下方向键会觉得树跳回了第一行
    setSelected((prev) => {
      if (prev === null || prev.rootIndex < index) return prev
      if (prev.rootIndex === index) return null
      return rowKey(prev.rootIndex - 1, prev.rel)
    })
  }

  async function openMany(list: readonly string[]): Promise<void> {
    // 去重再截断，与 `restoreState` 同一套：清单来自磁盘上的 JSON，同一个根写两遍会造出
    // 两份各自维护的缓存（见 `addRoot` 里那条注释），而上限要限的是「多少个**不同的**根」
    const wanted = [...new Set(list)].slice(0, MAX_RESTORED_ROOTS)
    rememberOutgoing()
    releaseAll()
    // 根默认摊开，与 `openAt` 同一条理由：切过来只看到 N 行文件夹名，一下点击的信息量是零
    const spawned = wanted.map((path, i) => spawn(path, i, new Set([''])))
    setMounted(spawned)
    // 并行读，与 `restoreState` 同一条理由：串行读会把切换拖成 N 次往返之和
    await Promise.all(spawned.map((m) => m.tree.readLayers([''])))
  }

  function close() {
    rememberOutgoing()
    releaseAll()
  }

  async function refresh(): Promise<void> {
    await Promise.all(mounted().map((m) => m.tree.refresh()))
  }

  async function toggle(key: RowKey): Promise<void> {
    await at(key.rootIndex)?.toggle(key.rel)
  }

  /**
   * 写操作失败时统一的一句话。
   *
   * `at` 返回 undefined 意味着那个位次上已经没有根了：要么工作区是空的，
   * 要么那个根刚被移出（菜单还开着、用户点了它）。两种都不该抛——理由见 `OpOutcome`
   */
  const NO_FOLDER = '还没打开文件夹'

  async function create(key: RowKey, name: string, kind: EntryKind): Promise<string | null> {
    const tree = at(key.rootIndex)
    if (!tree) return NO_FOLDER
    return tree.create(key.rel, name, kind)
  }

  async function rename(key: RowKey, newName: string): Promise<string | null> {
    const tree = at(key.rootIndex)
    if (!tree) return NO_FOLDER
    return tree.rename(key.rel, newName)
  }

  async function trash(key: RowKey): Promise<string | null> {
    const tree = at(key.rootIndex)
    if (!tree) return NO_FOLDER
    return tree.trash(key.rel)
  }

  async function reveal(key: RowKey): Promise<string | null> {
    const tree = at(key.rootIndex)
    if (!tree) return NO_FOLDER
    return tree.reveal(key.rel)
  }

  async function copyPath(key: RowKey): Promise<string | null> {
    const tree = at(key.rootIndex)
    if (!tree) return NO_FOLDER
    return tree.copyPath(key.rel)
  }

  /**
   * 执行一个动作。
   *
   * ⚠️ `open` 落在这一层而不是根实例里：打开文件是**工作区**的事，
   * 而根实例刻意不知道标签页的存在（见 `./rootTree.ts` 文件头）。
   */
  function run(action: TreeAction) {
    switch (action.kind) {
      case 'none':
        return
      case 'select':
        setSelected(action.key)
        return
      case 'expand':
        // 展开的同时把选中挪过去：方向键的语义是「移动到那里并做这件事」，
        // 只动树不动选中的话，连按两下右键会一直在同一行上打转
        setSelected(action.key)
        void at(action.key.rootIndex)?.expand(action.key.rel)
        return
      case 'collapse':
        setSelected(action.key)
        at(action.key.rootIndex)?.collapse(action.key.rel)
        return
      case 'open': {
        setSelected(action.key)
        const row = rows().find((r) => sameRow(keyOf(r), action.key))
        // 目录走不到这个分支（`actionForKey` 对目录返回 expand/collapse），
        // 但右键菜单与将来的双击都会构造 `open`，所以这里自己再判一次
        if (row && !row.isDir) void openFileAt(row.path)
        return
      }
    }
  }

  function serializeState(): SessionProject | null {
    const list = mounted()
    if (list.length === 0) return null
    return { roots: list.map((m) => m.tree.serialize()) }
  }

  const recentProjects = createMemo(() => {
    const current = roots()
    return rememberWorkspace(recent(), current, MAX_RECENT_PROJECTS).filter((e) => !sameWorkspace(e, current))
  })

  function serializeRecent(): string[][] {
    return rememberWorkspace(recent(), roots(), MAX_RECENT_PROJECTS).map((entry) => [...entry])
  }

  function restoreRecent(saved: readonly (readonly string[])[]): void {
    const seen = new Set<string>()
    const kept: string[][] = []
    for (const entry of saved) {
      if (kept.length >= MAX_RECENT_PROJECTS) break
      // 空条目不认：那是「没有工作区」，切过去等于把当前项目关掉。
      // 存档是磁盘上的 JSON，可能被别的版本写过、也可能被手改坏过
      if (entry.length === 0) continue
      // JSON 当键，理由与 `sameWorkspace` 里那条逐字相同
      const key = JSON.stringify(entry)
      if (seen.has(key)) continue
      seen.add(key)
      kept.push([...entry])
    }
    setRecent(kept)
  }

  async function restoreState(saved: SessionProject | null): Promise<void> {
    // ⚠️ 刻意**不**调 `rememberOutgoing`：这一条只在启动时用一次（见接口文档），
    // 那时工作区本来就是空的，记下来的只会是一条空条目——而 `rememberWorkspace`
    // 对空条目什么都不做。少写一句是对的，但要把「为什么少写」留在原地
    releaseAll()
    if (saved === null) return
    // 先去重再截断：存档是磁盘上的 JSON，同一个根写两遍会造出两份各自维护的缓存
    // （见 `addRoot` 里那条注释），而上限本来要限的是「多少个**不同的**根」。
    // 顺序就是存档里的顺序，也就是侧边栏从上到下的顺序
    const seen = new Set<string>()
    const wanted: SessionRoot[] = []
    for (const entry of saved.roots) {
      if (wanted.length >= MAX_RESTORED_ROOTS) break
      if (seen.has(entry.root)) continue
      seen.add(entry.root)
      // 展开清单同样先去重再截断：重复的 `rel` 会各自发一次 `listDir`。
      // 顺序是 Set 的插入顺序，也就是存档里的顺序
      wanted.push({ root: entry.root, expanded: [...new Set(entry.expanded)].slice(0, MAX_RESTORED_EXPANDED) })
    }
    const spawned = wanted.map((entry, i) => ({
      made: spawn(entry.root, i, new Set(entry.expanded)),
      rels: entry.expanded,
    }))
    setMounted(spawned.map((s) => s.made))
    // 所有根、所有层一起并行读，与 `workspace.restoreSession` 同一条理由：
    // 串行读会把启动拖成好几秒。一个打不开的层（存档之后被删了）只在它自己那一行
    // 留一句错误，不影响别的层，也不影响别的根
    await Promise.all(spawned.map((s) => s.made.tree.readLayers(s.rels)))
  }

  return {
    roots,
    rows,
    selected,
    rootName,
    openViaDialog,
    openAt,
    openMany,
    addViaDialog,
    addRoot,
    removeRoot,
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
    recentProjects,
    serializeRecent,
    restoreRecent,
  }
}
