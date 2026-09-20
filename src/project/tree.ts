/**
 * 文件树的**纯逻辑**：把「按需列举回来的一层层条目」摊成可以直接虚拟化渲染的扁平行数组，
 * 再从这个数组上算出可视窗口与键盘落点。
 *
 * 这一层刻意不含 signal、不含 IPC、不含 DOM——全是纯函数，于是每一件都能被单测
 * 直接钉住，不必挂 jsdom、不必假装 `invoke`：
 *
 * - `flattenRows`：树的结构（哪些层摊开了、哪层还在读、哪层读失败了）
 * - `actionForKey`：方向键在一棵树上到底该干什么
 * - `displayName` / `childRel` / `parentRel`：rel 与显示名的拆与拼（M2-B-5）
 * - `containerRel` / `menuFor`：右键一行该给出哪些菜单项（M2-B-5）
 *
 * 状态本身（root 是哪个、展开过哪些层）住在 `./store.ts`。
 *
 * ## 为什么要有根行
 *
 * VS Code 把项目名放在侧边栏标题里、根的直接子项算第 0 层；Sublime 把项目文件夹本身
 * 当成树里的第一行。这里选 Sublime 那种，理由不是审美而是**齐一性**：有了根行，
 * 「这一层正在读 / 这一层读失败了」对所有层都是同一条规则（按 `row.rel` 去查），
 * 根层不必单独在标题上开一块地方显示错误。M2-F 的多根工作区也正好落在这个形状上——
 * 一个根一行。
 *
 * ## 多根之下「哪一行」怎么说（M2-F）
 *
 * 单根时代 `rel` 就是一行的身份。多根之后不成立了：两个根都有一条 `''`（各自的根行），
 * 也可能都有一条 `src/a.ts`。于是身份变成**「第几个根 + 那个根里的 rel」**，即 `RowKey`。
 *
 * ⚠️ 只有「跨根」的那几件事需要它：选中、方向键的落点。根**内部**的一切（缓存、展开集合、
 * loading、错误、`listDir` 的入参）照旧按裸 `rel` 索引——每个根有自己的一份状态，
 * 见 `./store.ts`。把 `RowKey` 渗进那一层只会让每个 Map 的键都长一截而什么都没解决。
 */

import type { DirEntry } from '../ipc/project'

/** 树里的一行。扁平化之后只有「第几行、缩进多深」，没有父子指针 */
export interface TreeRow {
  /**
   * 这一行属于工作区里第几个根，从 0 起。
   *
   * ⚠️ 与 `SearchFile.rootIndex` / `FileMatch.rootIndex` 同一个口径，也同一条来源：
   * 顺序就是那份根清单的顺序。前端**从不**用「把 `rel` 从 `path` 头上剥掉」来反推它
   * ——那是路径算术，M2-A 就把它赶出前端了。
   */
  rootIndex: number
  /**
   * 相对**它那个根**的路径，与 `listDir` 的 `rel` 同一个口径：**根行是空字符串**。
   * 展开一行就是拿它的 `rel` 再调一次 `listDir`，前端从不自己拼路径。
   *
   * ⚠️ 多根之下它不再全局唯一（两个根都有一条 `''`）。要唯一就用 `keyOf(row)`
   */
  rel: string
  name: string
  /** 绝对路径。点文件时原样交给 `openFile` */
  path: string
  isDir: boolean
  /** 缩进层级。每个根的根行都是 0，根的直接子项 1 */
  depth: number
  /** 只对目录有意义。文件恒为 false，读它之前先看 `isDir` */
  expanded: boolean
  /** 这一层的子项正在读回来。渲染成行内的一句「读取中…」 */
  loading: boolean
  /** 这一层读失败的原因（已经落地成人话），null = 没出错 */
  error: string | null
}

/**
 * 一行在**整份工作区**里的身份：第几个根 + 那个根里的 rel。
 *
 * 做成结构体而不是一条拼出来的字符串（`"0:src/a.ts"`），有两个理由：
 *
 * 1. **拿得出 `rootIndex`。** 方向键跨根之后，「摊开这一层」必须知道去哪个根上摊——
 *    字符串形式就得在每个用到的地方再解析一遍，而解析函数是又一处会漂的约定。
 * 2. **类型挡得住混淆。** `selected()` 是 `RowKey | null`，写成 `selected() === row.rel`
 *    当场就是编译错误。若两边都是 `string`，那一行编译得过、跑起来永远不相等，
 *    表现是「选中高亮没了、方向键每次都从第一行起步」——不报错，只是行为莫名其妙。
 */
export interface RowKey {
  readonly rootIndex: number
  readonly rel: string
}

/** `RowKey` 唯一的构造入口。字段是 `readonly`，所以拿到之后不会被就地改掉 */
export function rowKey(rootIndex: number, rel: string): RowKey {
  return { rootIndex, rel }
}

/** 一行的身份。`TreeRow` 上那两个字段就是它，这里只是免掉每次手写两遍 */
export function keyOf(row: TreeRow): RowKey {
  return { rootIndex: row.rootIndex, rel: row.rel }
}

/**
 * 两个身份指的是不是同一行。
 *
 * 不能拿 `===` 比：`keyOf` 每次都新建一个对象，而 `rows()` 是 memo、一摊一收就整个重算，
 * 引用相等永远为假。所有「这一行是不是选中的那一行」的判断都必须走这里
 */
export function sameRow(a: RowKey | null, b: RowKey | null): boolean {
  if (a === null || b === null) return a === b
  return a.rootIndex === b.rootIndex && a.rel === b.rel
}

/** `flattenRows` 要的全部输入。全是只读容器：store 每次改状态都换一个新引用 */
export interface TreeSnapshot {
  /** 根行的显示名，一般是项目文件夹的名字 */
  rootName: string
  /** 根目录的绝对路径，当根行的 `path` 用 */
  rootPath: string
  /** `rel` → 该层条目。**只有展开过的目录才在里面**：Rust 侧按需列举，绝不建全量树 */
  listings: ReadonlyMap<string, DirEntry[]>
  /** 摊开着的目录的 `rel`。含 `''` 表示根摊开了 */
  expanded: ReadonlySet<string>
  /** 正在读的层的 `rel` */
  loading: ReadonlySet<string>
  /** 读失败的层：`rel` → 人话 */
  errors: ReadonlyMap<string, string>
}

/**
 * 树的行高。
 *
 * 定高行是虚拟滚动那套 O(1) 窗口算术（`src/ui/virtual.ts` 的 `visibleWindow`）的前提，
 * 而且**只有一个真相**：`Sidebar.tsx` 把它注入成 CSS 变量 `--vela-tree-row-height`，
 * 样式表里不许出现第二个 `22px` 字面量——漂移的失败方式是「行与行之间露出一条缝」，
 * 不报错，只是难看。
 */
export const ROW_HEIGHT = 22

/**
 * 把**一个根**的树摊成扁平行数组。
 *
 * 只走**摊开且已经取回来**的层：没摊开的目录不递归进去（那会逼着 Rust 建全量树），
 * 摊开了但条目还没回来的目录只产出它自己那一行 + `loading: true`。
 * 所以这个函数的成本只与「用户看得见多少行」有关，与仓库有多少文件无关——
 * PLAN §3.4 的验收判据（10 万+ 文件秒开）就是靠这条撑着的。
 *
 * `rootIndex` 是这一份快照在工作区里的位次，原样盖到它产出的**每一行**上。
 * 多根时把 N 份结果按位次首尾相接就是整棵树，而接完仍然满足 `actionForKey` 要的两条：
 * 同一根的行连续（所以「找父目录」只要不跨根就是对的），根行在每个根的开头（所以
 * 上下键跨根时落到的正是另一个根的根行或其最后一个子项）。
 */
export function flattenRows(snapshot: TreeSnapshot, rootIndex: number): TreeRow[] {
  const rows: TreeRow[] = []
  appendDir(rows, snapshot, rootIndex, '', snapshot.rootName, snapshot.rootPath, 0)
  return rows
}

function appendDir(
  rows: TreeRow[],
  snapshot: TreeSnapshot,
  rootIndex: number,
  rel: string,
  name: string,
  path: string,
  depth: number,
) {
  rows.push({
    rootIndex,
    rel,
    name,
    path,
    isDir: true,
    depth,
    expanded: snapshot.expanded.has(rel),
    loading: snapshot.loading.has(rel),
    error: snapshot.errors.get(rel) ?? null,
  })
  if (!snapshot.expanded.has(rel)) return
  // 摊开了但还没取回来：上面那行的 loading 已经把这件事说清楚了，不补占位行。
  // 补一行「读取中…」会让行高在数据到达时跳一下，滚动位置跟着漂
  const entries = snapshot.listings.get(rel)
  if (!entries) return
  for (const entry of entries) {
    if (entry.isDir) {
      // 递归深度等于用户摊开的层数，而层数被真实目录深度挡着（本仓库最深 6 层）。
      // 没有「一键全部展开」，所以不存在被 node_modules 那种深度炸栈的路径
      appendDir(rows, snapshot, rootIndex, entry.rel, entry.name, entry.path, depth + 1)
    } else {
      rows.push({
        rootIndex,
        rel: entry.rel,
        name: entry.name,
        path: entry.path,
        isDir: false,
        depth: depth + 1,
        expanded: false,
        loading: false,
        error: null,
      })
    }
  }
}

/**
 * 从绝对路径里抠出给人看的名字。
 *
 * ⚠️ **这是全前端唯一一处「拆」绝对路径的地方**，与 `childRel` 的「拼」正好是一对，
 * 而且它只产出一个标签：结果不参与任何路径构造，也不会被回传给 Rust。
 * M2-A 特意让 `DirEntry` 同时带 `rel` 与 `path`，就是为了把「拼绝对路径」这件事从前端
 * 彻底赶走——这里做的是它的反面（拆开取最后一段），而且只用来显示。
 *
 * 为什么不让 Rust 一并返回根目录的名字：那要改 `DirListing` 的线上契约（两边各有一份黄金
 * JSON 要同步改），换来的只是省掉一个 `lastIndexOf('/')`。不划算。
 */
export function displayName(rootPath: string): string {
  // 剥掉**所有**末尾斜杠，不是只剥一个：`/a/b///` 的最后一段是空字符串。
  // 停在 1 是为了让 '/' 保住自己那一个斜杠——根目录没有名字可抠，只能拿路径当名字
  let end = rootPath.length
  while (end > 1 && rootPath.charAt(end - 1) === '/') end--
  const trimmed = rootPath.slice(0, end)
  const at = trimmed.lastIndexOf('/')
  const name = at < 0 ? trimmed : trimmed.slice(at + 1)
  return name.length > 0 ? name : trimmed
}

/**
 * 把父层的 `rel` 与一个名字拼成子项的 `rel`。根层（`''`）直接就是名字本身。
 *
 * ⚠️ **这是前端唯一一处「拼」路径的地方**，与 `displayName` 的「拆」正好是一对。
 * 拼的是 `rel` 而不是绝对路径，所以拼错的后果被 Rust 侧的 `resolve` 兜住：
 * 名字里带 `/` 会得到 `bad_name`，带 `..` 会得到 `escape`，两者都写不到 root 外面去。
 * 换成拼绝对路径的话，同样的错误就变成「在用户没授权的地方建了个文件」。
 *
 * 放在纯函数层是为了能被单测直接钉住——`''` 那一个分支尤其要测：
 * 少写它的话根层新建会得到 `"/foo.txt"`，一个以斜杠开头的 rel，
 * 而 `resolve` 会把它当绝对路径拒掉，用户看到的是「内部错误」。
 */
export function childRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

/** 一条 `rel` 的父层。根层（`''`）与根的直接子项都得到 `''` */
export function parentRel(rel: string): string {
  const at = rel.lastIndexOf('/')
  return at < 0 ? '' : rel.slice(0, at)
}

/** 右键菜单里的一项动作。七个都是 store 上已有的方法，一一对应 */
export type TreeMenuAction = 'newFile' | 'newFolder' | 'rename' | 'trash' | 'reveal' | 'copyPath' | 'removeRoot'

export interface TreeMenuItem {
  action: TreeMenuAction
  label: string
  /**
   * 在这一项**上面**画一条分隔线。
   *
   * 分组按「会不会改磁盘」：新建是一组，改名与移到废纸篓是一组，
   * 「在 Finder 中显示」与「复制路径」压根不碰文件（只是把 Finder 推到前台 / 写剪贴板）。
   * 混在一起的话「复制路径」与「移到废纸篓」隔着一次误点，而前者是每天用几十次的动作。
   *
   * 「从工作区移除」自己一组、排在最后：它也不碰磁盘，但**整个根连同它下面所有行都会
   * 从树上消失**，与「复制路径」之间必须隔着一次误点的距离。
   */
  separator?: boolean
}

/**
 * 新建类动作的目标层：目录行是它自己，文件行是它的父层。
 *
 * 右键一个文件选「新建文件」，新文件应该出现在**它旁边**而不是它里面——
 * 文件没有里面，而把它当成目标层的话 `childRel` 会拼出一条 `a.ts/b.ts`，
 * Rust 侧回一句 `not_a_directory`，用户看到的是一个他没法理解的失败。
 */
export function containerRel(row: TreeRow): string {
  return row.isDir ? row.rel : parentRel(row.rel)
}

/**
 * 一行该给出哪些菜单项。
 *
 * ⚠️ **根行不给「重命名」与「移到废纸篓」**：那是把用户整个项目文件夹改名或扔进废纸篓。
 * 这条规则放在纯函数层而不是渲染时写个 `Show when`，是因为它必须在测试里被钉住——
 * 「菜单里不显示这一项」是一条改渲染时就会被改坏的约定，而 `store.trash` 里那道
 * `rel === ''` 的拦截只是最后一道网，网住了也只来得及在用户点下去之后说一句不行。
 *
 * 判据是 `rel === ''` 而**不看 `rootIndex`**：多根之下每个根都有一条根行，
 * 而那 N 条一条都不许改名或扔进废纸篓。所以「是不是根行」在每个根内部是同一个问题。
 *
 * @param rootCount 工作区里现在有几个根。只用来**给根行那一项挑措辞**：
 *   一个根时说「关闭文件夹」（与头部那个 × 的 title 同一句话），多个根时说
 *   「从工作区移除」。两句话背后是同一个动作，而说反了会让用户以为要丢东西——
 *   只有一个根的时候「工作区」这个词在界面上压根没出现过
 */
export function menuFor(row: TreeRow, rootCount: number): TreeMenuItem[] {
  const isRoot = row.rel === ''
  const items: TreeMenuItem[] = [
    { action: 'newFile', label: '新建文件' },
    { action: 'newFolder', label: '新建文件夹' },
  ]
  if (!isRoot) {
    items.push({ action: 'rename', label: '重命名…', separator: true })
    // 没有省略号：它不打开对话框，当场就做完。也刻意不做成红色——
    // 移到废纸篓是能从 Finder 里捞回来的，把它画成危险动作会让人不敢用
    items.push({ action: 'trash', label: '移到废纸篓' })
  }
  items.push({ action: 'reveal', label: '在 Finder 中显示', separator: true })
  items.push({ action: 'copyPath', label: '复制路径' })
  // 只在根行上出现，理由与「不给移到废纸篓」是同一条的两半：
  // 根文件夹本身不许扔，但「我不再在这个项目里干活了」必须有个出口
  if (isRoot) {
    items.push({ action: 'removeRoot', label: rootCount > 1 ? '从工作区移除' : '关闭文件夹', separator: true })
  }
  return items
}

/**
 * 一次按键要做的动作。`none` = 这个键在这棵树此刻的状态下什么都不该干。
 *
 * ⚠️ 每个动作都带一份 `RowKey` 而不是裸 `rel`：多根之下「摊开 src」这句话是不完整的，
 * 得说清是**哪个根**的 src。少带 `rootIndex` 的失败方式不是报错，而是操作落到
 * 另一个根的同名目录上——两个根都有 `src` 是极常见的事。
 */
export type TreeAction =
  | { kind: 'select'; key: RowKey }
  | { kind: 'expand'; key: RowKey }
  | { kind: 'collapse'; key: RowKey }
  | { kind: 'open'; key: RowKey }
  | { kind: 'none' }

/** `actionForKey` 认的键。用 `e.key` 的字面值，不经过命令中心的 keybinding 解析 */
export type TreeKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Enter'

const TREE_KEYS: ReadonlySet<string> = new Set<TreeKey>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Enter',
])

/**
 * 把 `KeyboardEvent.key` 收窄成 `TreeKey`。
 *
 * 侧边栏的 onKeyDown 收得到**所有**按键，而 `actionForKey` 只认这七个。
 * 收窄放在这里而不是让调用方写一串 `||`：漏一个键的失败方式是「按了没反应」，
 * 而这七个键与那份 switch 的分支必须一起改。
 */
export function isTreeKey(key: string): key is TreeKey {
  return TREE_KEYS.has(key)
}

const NONE: TreeAction = { kind: 'none' }

/**
 * 方向键在一棵树上的落点。规则与 Finder / VS Code 的列表一致：
 *
 * - 上下：在**可见行**里前后移动一行（扁平数组已经把「可见」算好了，所以是 ±1）
 * - 右：目录没摊开就摊开；已经摊开就下移到第一个子项；文件不动
 * - 左：目录摊开着就收起；没摊开就跳到父目录；文件跳到父目录
 * - Home / End：第一行 / 最后一行
 * - Enter：文件 → 打开；目录 → 切换摊开
 *
 * 之所以做成纯函数而不是写在组件的 onKeyDown 里：这九条分支是整棵树里最容易写错、
 * 也最容易在改渲染时改坏的部分，而它对 DOM 的要求只是「给我一个 RowKey」。
 *
 * ⚠️ `rows` 在多根之下是**所有根首尾相接**的那一份，所以上下键自然会跨根：
 * 在根 A 的最后一行按下键就落到根 B 的根行。这正是 VS Code 的行为，也正是
 * 「一份扁平数组 + ±1」这个实现能白拿到的东西——不需要为跨根写任何一条分支。
 * 反过来说，左键**必须**拦住跨根，见 `parentOf`。
 */
export function actionForKey(rows: readonly TreeRow[], current: RowKey | null, key: TreeKey): TreeAction {
  if (rows.length === 0) return NONE
  const at = current === null ? -1 : rows.findIndex((r) => sameRow(keyOf(r), current))
  const row = at < 0 ? undefined : rows[at]

  switch (key) {
    case 'Home':
      return select(rows[0]!)
    case 'End':
      return select(rows[rows.length - 1]!)
    case 'ArrowUp':
      // 没选中过（或选中的那行已经不在树里）时，上下键从边缘起步，而不是从中间某处
      return select(rows[at < 0 ? 0 : Math.max(0, at - 1)]!)
    case 'ArrowDown':
      return select(rows[at < 0 ? 0 : Math.min(rows.length - 1, at + 1)]!)
    case 'ArrowRight': {
      if (!row) return select(rows[0]!)
      if (!row.isDir) return NONE
      if (!row.expanded) return { kind: 'expand', key: keyOf(row) }
      const child = rows[at + 1]
      // 摊开了但没有下一行 = 空目录，无处可去
      return child ? select(child) : NONE
    }
    case 'ArrowLeft': {
      if (!row) return select(rows[0]!)
      if (row.isDir && row.expanded) return { kind: 'collapse', key: keyOf(row) }
      const parent = parentOf(rows, at)
      return parent ? select(parent) : NONE
    }
    case 'Enter': {
      if (!row) return NONE
      const target = keyOf(row)
      if (!row.isDir) return { kind: 'open', key: target }
      return row.expanded ? { kind: 'collapse', key: target } : { kind: 'expand', key: target }
    }
  }
}

function select(row: TreeRow): TreeAction {
  return { kind: 'select', key: keyOf(row) }
}

/**
 * 往上找**同一个根里**第一个缩进比 `at` 浅的行。找不到（`at` 已经是根行）返回 undefined。
 *
 * 父目录按定义就在同一个根里，所以那道 `rootIndex` 检查是这个函数**定义的一部分**，
 * 不是一道兜底：它让「不跨根」这件事在本函数内成立，而不是依赖一条外部性质
 * （`flattenRows` 每次都先产出一条 depth 0 的根行，所以往回扫总会先撞上它）。
 * 少了这条检查，本函数在今天的调用方式下结果一样——但正确性就寄在了另一个函数
 * 的实现细节上，而那个细节改起来不会有测试变红。
 */
function parentOf(rows: readonly TreeRow[], at: number): TreeRow | undefined {
  const row = rows[at]
  if (!row) return undefined
  for (let i = at - 1; i >= 0; i--) {
    const above = rows[i]!
    if (above.rootIndex !== row.rootIndex) return undefined
    if (above.depth < row.depth) return above
  }
  return undefined
}
