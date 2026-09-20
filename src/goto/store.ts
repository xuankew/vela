/**
 * `Cmd+P` 浮层的状态（M2-E-5）。
 *
 * 与 `src/search/store.ts` 同一套分工：**逻辑住在这里、组件只管画**。这一层不含 DOM、
 * 不含 CodeMirror，于是「四种意图之间切换」「按键比响应先到」这两件最容易出错的事
 * 都能在 node 环境里被单测钉住，不必挂 jsdom、不必造真的 `EditorState`。
 *
 * ## 四种意图共用一个输入框
 *
 * 分派在 `./query.ts`，这一层只消费它的结果：
 *
 * - `file` / `fileLine` → 走 IPC 问 Rust 的索引，**异步**
 * - `symbol` → 问注入进来的 `symbols()`，**同步**（语法树已经在内存里了）
 * - `line` → 没有列表可列，浮层只剩一句「跳到第 N 行」，Enter 直接落地
 *
 * ## ⚠️ 异步那一路必须有请求序号
 *
 * 每个按键都发一次 `query_project`，而 IPC 的返回顺序**不保证**与发出顺序一致
 * （Rust 侧的打分跑在 `spawn_blocking` 上，线程池的调度与搜索词长短都会打乱先后）。
 * 不加序号的话，慢的那一次会盖掉快的那一次，用户看到的是「我删掉了一个字符，
 * 列表却变回了更窄的那个结果」——不报错，只是对不上。
 *
 * 刻意**不做防抖**：`query_project` 在十万文件的索引上最坏 12.7ms（实测数字写在
 * `src-tauri/src/commands.rs` 上），比一帧还短，而防抖换来的是「打了字列表不跟着动」
 * 那种黏滞感。序号已经足够保证正确性，防抖只会再加一个需要调的常数。
 *
 * ## ⚠️ 索引在浮层展开的那一刻重建
 *
 * `index_project` **每次都重建**（Rust 侧那条策略与它的理由见 `src-tauri/src/commands.rs`），
 * 所以「上一次开浮层之后新建的文件这一次一定找得到」——没有陈旧问题，也就不需要
 * 「手动刷新索引」这种入口。代价是展开时有 40ms（两万文件）到 205ms（十万文件）的建索引，
 * 那段时间浮层如实说「正在建索引…」，而不是先给一份旧的列表。
 */

import { createEffect, createMemo, createSignal, on, untrack, type Accessor } from 'solid-js'
import { describeTreeError, indexProject, queryProject, type FileMatch } from '../ipc/project'
// 只借这一个纯函数，理由与 `src/search/store.ts` 那条 import 逐字相同：
// 「怎么从一条绝对路径里抠出最后一段」在 `tree.ts` 里已经把末尾斜杠与根目录 `/` 都处理过了
import { displayName } from '../project/tree'
import { filterProjects, projectLabel, projectWhere } from './projects'
import { filterSymbols, type DocSymbol, type SymbolTable } from './symbols'
import { parseGotoQuery } from './query'

/**
 * 浮层的行高。
 *
 * 与 `search/rows.ts` 的 `RESULT_ROW_HEIGHT` 同值而不是共用一个常量：两者相等是巧合
 * （都是「一屏多装几行」与「一行读得清」之间的取舍），而**共用**会让改一个列表的行高
 * 顺手改掉另一个。行高的唯一真相是「每个列表自己那一个」，见 `src/ui/virtual.ts` 的表
 */
export const QUICK_OPEN_ROW_HEIGHT = 20

/** 选中一行（或在 `:42` 那种没有列表的模式下按 Enter）要做的事 */
export type Commit =
  /** 打开这个文件；`line` 非 null 时再跳到那一行 */
  | { readonly kind: 'openFile'; readonly path: string; readonly line: number | null }
  /** 在**当前**文档里跳到某一行 */
  | { readonly kind: 'gotoLine'; readonly line: number }
  /** 在**当前**文档里跳到某个位置（标题的起点） */
  | { readonly kind: 'gotoPos'; readonly pos: number }
  /**
   * 把整个工作区换成这一份根清单（M2-F-6，`Cmd+Shift+O`）。
   *
   * ⚠️ 是**整份清单**而不是一个路径：多根工作区是用户一个个「添加文件夹」攒出来的，
   * 只递第一个根的话切回来就少几个，而「我刚才那两个文件夹呢」这件事没有任何提示
   */
  | { readonly kind: 'openWorkspace'; readonly roots: readonly string[] }

/** 浮层里的一行。文件与标题共用这一个形状：两者都只有「一行字 + 一个去处」 */
export interface QuickOpenRow {
  /** 显示的文字：文件是 `rel`，标题是标题本身 */
  readonly text: string
  /**
   * 这个候选属于**哪一个根**的显示名，画在 `text` 前面。空串 = 不画。
   *
   * ⚠️ 存的是算好的名字而不是 `rootIndex`，理由与 `search/rows.ts` 的 `FileRow.root`
   * 逐字相同：浮层开着的时候用户可能加一个根或移掉一个，而那之后同一个序号
   * 指的就是另一个文件夹了。标题那一栏永远是**当前文档**里的，所以恒为空串
   */
  readonly root: string
  /** 缩进几格。文件一律 0，标题用它的级别（1–6），于是文档结构一眼看得出层级 */
  readonly indent: number
  /** 鼠标悬停时显示什么。文件是绝对路径，标题是它自己（长标题在行里会被截断） */
  readonly title: string
  readonly action: Commit
}

/** 浮层认的键。用 `e.key` 的字面值，不经过命令中心的 keybinding 解析 */
export type QuickOpenKey = 'ArrowUp' | 'ArrowDown' | 'PageUp' | 'PageDown' | 'Home' | 'End' | 'Enter' | 'Escape'

const QUICK_OPEN_KEYS: ReadonlySet<string> = new Set<QuickOpenKey>([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Enter',
  'Escape',
])

export function isQuickOpenKey(key: string): key is QuickOpenKey {
  return QUICK_OPEN_KEYS.has(key)
}

/**
 * 算出按键之后的选中下标。
 *
 * 纯函数，于是「翻一页到底该翻多少」「在第一行上按上箭头会怎样」这些能直接穷举。
 *
 * ⚠️ `pageSize` 由调用方给：一页是多少行只有**组件**知道（它才量得到可视区高度），
 * 而这一层不碰 DOM。jsdom 里 `clientHeight` 恒为 0，于是组件传进来的是 0，
 * `PageUp`/`PageDown` 在组件测试里一动不动——那不是 bug，是 jsdom 没有布局。
 *
 * 上箭头在第一行、下箭头在最后一行都**停住不动**，不绕回另一头：
 * 绕回去的话「按住下箭头一路翻到底」会在到底之后突然跳回第一行，
 * 而那正是用户最不想在一个 50 行的列表里遇到的事
 */
export function moveSelection(total: number, selected: number, key: QuickOpenKey, pageSize: number): number {
  if (total <= 0) return 0
  const at = Math.min(Math.max(0, selected), total - 1)
  const page = Math.max(1, pageSize)
  switch (key) {
    case 'ArrowUp':
      return Math.max(0, at - 1)
    case 'ArrowDown':
      return Math.min(total - 1, at + 1)
    case 'PageUp':
      return Math.max(0, at - page)
    case 'PageDown':
      return Math.min(total - 1, at + page)
    case 'Home':
      return 0
    case 'End':
      return total - 1
    default:
      // Enter 与 Escape 不改选中：前者落地、后者收起，都由 `key()` 单独处理
      return at
  }
}

/**
 * 浮层此刻在办哪一件事。
 *
 * `goto` 是那四种意图（文件 / 文件+行号 / 行号 / 标题），由输入框里的前后缀分派，
 * 见 `./query.ts`。`project` 是**第五种**，而它刻意**不**做成一个前缀：
 *
 * - 前缀是「在同一个清单里换一种问法」，而最近项目与文件是两份完全不同的清单，
 *   一个前缀会让 `Cmd+P` 里也能切项目——那正是 `Cmd+Shift+O` 这个键要分开的两件事；
 * - 它压根不问索引，所以走前缀的话 `:42`、`@标题` 与它会互相抢同一个输入框的文法。
 *
 * 于是它是 `show()` 的一个参数，由**按键**决定，而不是由输入框里的字决定。
 */
export type OverlayKind = 'goto' | 'project'

export interface QuickOpenOptions {
  /**
   * 工作区的根清单从哪来，顺序就是侧边栏从上到下的顺序。App 注入 `tree.roots`。
   *
   * 注入而不是 import `createProjectTree`：store 不该知道宿主长什么样，
   * 而且直接 import 会让两层互相引用成环（与 `search/store.ts` 同一条道理）
   *
   * ⚠️ 空数组 = 没打开任何文件夹（「没打开」只有这一种写法，见 `project/store.ts` 文件头）
   */
  roots: () => readonly string[]
  /** MRU，最新的在前。App 注入 `workspace.recent`。⚠️ 只用来给匹配分加分，见 `queryProject` */
  recent: () => string[]
  /**
   * 当前文档的符号表。App 注入「读聚焦编辑器的 state，交给 `symbolTable`」。
   *
   * `null` = 现在没有可以列标题的文档（编辑器还没挂上来）。刻意让它可以是 null 而不是
   * 退回一个假的 `unsupported`：那两种情况该说两句话，而 `unsupported` 那句的主语是语言名
   */
  symbols: () => SymbolTable | null
  /**
   * 可以切过去的最近项目，最新的在最前面。App 注入 `tree.recentProjects`。
   *
   * ⚠️ 那一份**已经排掉了当前工作区**（判据与理由都在 store 那一层），
   * 所以这一层拿到什么就画什么，不再自己比一遍
   */
  recentProjects: () => readonly (readonly string[])[]
  /** 落地一个 `Commit`。App 注入「打开文件 / 在当前文档里跳过去 / 换掉整个工作区」 */
  commit: (action: Commit) => void | Promise<void>
}

export interface QuickOpen {
  readonly visible: Accessor<boolean>
  /**
   * 这一次展开在办哪一件事（M2-F-6）。
   *
   * 组件只拿它来换**输入框上的提示语与无障碍标签**：`Cmd+P` 那一格写的是
   * 「按名字找文件…（:42 跳行，@ 列标题）」，而在项目模式里那三个前后缀一个都不认，
   * 照抄等于在教用户一套这一刻压根不成立的文法
   */
  readonly kind: Accessor<OverlayKind>
  /** 输入框里的原文。⚠️ 一个字符都不 trim，理由见 `./query.ts` */
  readonly raw: Accessor<string>
  readonly rows: Accessor<QuickOpenRow[]>
  /** 选中的下标。列表为空时是 0，组件那边靠 `rows().length` 判断有没有东西可选 */
  readonly selected: Accessor<number>
  /** 底部那一行状态文字 */
  readonly footer: Accessor<string>
  /** 需要单独一行、警告色说的话（索引被截断了）。`null` = 没有 */
  readonly warning: Accessor<string | null>
  /** 查询失败时的人话。`null` = 没有 */
  readonly error: Accessor<string | null>
  /** 正在等 IPC。⚠️ 建索引那一段时间里它是 false，那时说话的是 footer */
  readonly busy: Accessor<boolean>
  /**
   * 每加一就 focus 一次输入框。
   *
   * 用**计数**而不是布尔：浮层已经开着的时候再按一次 `Cmd+P`，布尔值不变就不会触发
   * 那个 effect，焦点也就抢不回来（与 `search/store.ts` 的 `focusRequest` 同一条理由）
   */
  readonly focusRequest: Accessor<number>
  /**
   * 展开浮层。`seed` 是输入框里的起始文字：`Cmd+P` 传空串（找文件），
   * `Cmd+R` 传 `'@'`（列标题），`Cmd+Shift+O` 传空串 + `which: 'project'`。
   *
   * ⚠️ 这几个键共用这一个浮层，而「已经开着的时候再按另一个」不重建索引——
   * 理由写在实现上。唯一的例外是从 `project` 切回 `goto`：项目模式压根不建索引，
   * 那一次必须补建，否则文件清单永远是空的而浮层说自己好了
   */
  show(seed?: string, which?: OverlayKind): Promise<void>
  hide(): void
  setRaw(text: string): void
  /** 处理一个按键。回**新的选中下标**，组件据此把它滚进可视区；`null` = 不用滚 */
  key(which: QuickOpenKey, pageSize: number): number | null
  /** 只改选中，不落地。鼠标悬停用它 */
  select(index: number): void
  clickRow(index: number): void
}

export function createQuickOpen(options: QuickOpenOptions): QuickOpen {
  const [visible, setVisible] = createSignal(false)
  const [raw, setRaw] = createSignal('')
  const [rows, setRows] = createSignal<QuickOpenRow[]>([])
  const [selected, setSelected] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [focusRequest, setFocusRequest] = createSignal(0)
  /** 索引是不是被二十万那个上限截断了。见 `IndexStats.truncated` */
  const [truncated, setTruncated] = createSignal(false)
  /** 索引建好了没有。展开那一下是 false，那时 footer 说「正在建索引…」 */
  const [ready, setReady] = createSignal(false)
  /** `:42` 这种没有列表的模式，要跳的行号记在这里 */
  const [lineTarget, setLineTarget] = createSignal<number | null>(null)
  /** 命中总数，**可以大于** `rows().length`（Rust 侧的 `QUERY_LIMIT`） */
  const [total, setTotal] = createSignal(0)
  /** 符号模式下那句「这个语言还没有符号表」的主语 */
  const [symbolNote, setSymbolNote] = createSignal<string | null>(null)
  /** 这一次展开在办哪一件事。由 `show()` 的第二个参数写，输入框里的字改不动它 */
  const [overlay, setOverlay] = createSignal<OverlayKind>('goto')
  /**
   * 这一次展开建过索引没有。
   *
   * 与 `ready` 分开：`ready` 说的是「列表可以算了」，而项目模式**不需要索引**也算得出来。
   * 少了它，「浮层开着的时候从 `Cmd+Shift+O` 切到 `Cmd+P`」会走进一个
   * `ready === true` 却压根没建过索引的现场——文件清单永远是空的，而浮层不报错
   */
  const [indexed, setIndexed] = createSignal(false)

  /**
   * 展开的世代号。
   *
   * `show()` 里有一次 `await indexProject(...)`，而用户完全可能在那 40–205ms 里
   * 按 Escape 再按一次 `Cmd+P`。不加这个号的话，前一次展开的续半截会把 `ready`
   * 打开、把上一次的 `truncated` 写进来——浮层于是显示一份属于**另一次**展开的账
   */
  let epoch = 0
  /** 查询的序号，理由见文件头 */
  let seq = 0

  const mode = createMemo(() => {
    // 项目模式**不看**输入框里的字：那一刻 `:42` 与 `@标题` 都只是在过滤项目名。
    // 判据是按键（`overlay`），不是文法，理由见 `OverlayKind` 的文档
    if (overlay() === 'project') return 'project'
    const q = parseGotoQuery(raw())
    return q.kind === 'symbol' ? 'symbol' : q.kind === 'line' ? 'line' : 'file'
  })

  const footer = createMemo(() => {
    const which = mode()
    if (which === 'project') {
      const n = rows().length
      if (n > 0) return `${n} 个最近项目`
      // 空清单与「过滤到没有」是两句话：前者说的是「你还没换过项目」，
      // 而后者说的是「换个词」。混成一句的话第一次按 Cmd+Shift+O 的用户
      // 会以为这个功能是坏的
      return raw() === '' ? '还没有别的项目：先用「文件夹…」打开一个，换过一次之后这里就有东西了' : '没有匹配的最近项目'
    }
    if (which === 'line') {
      const n = lineTarget()
      return n === null ? '' : `跳到第 ${n} 行（Enter 落地）`
    }
    if (which === 'symbol') {
      const note = symbolNote()
      if (note !== null) return note
      const n = rows().length
      return n === 0 ? '这份文档里没有匹配的标题' : `${n} 个标题`
    }
    if (error() !== null) return ''
    if (!ready()) return '正在建索引…'
    if (options.roots().length === 0) return '先打开一个文件夹，才能按名字找文件'
    const n = rows().length
    if (n === 0) return raw() === '' ? '这个项目里没有文件' : '没有匹配的文件'
    const t = total()
    return t > n ? `共 ${t} 个匹配，显示前 ${n} 个——把词写窄一点` : `${n} 个匹配`
  })

  const warning = createMemo(() => {
    if (!truncated() || mode() !== 'file') return null
    return '文件数撞到上限，这份索引不全：找不到的文件可能只是没被收进来，换个词或去侧边栏翻'
  })

  /**
   * 把一批文件匹配摊成行。
   *
   * `line` 非 null 时（输入是 `store.ts:42` 那种）每一行的落地动作都带上它——
   * 于是「输完文件名再补 `:42`」与「先打 `:42` 再补文件名」得到同一个结果
   */
  function fileRows(matches: readonly FileMatch[], line: number | null, roots: readonly string[]): QuickOpenRow[] {
    return matches.map((m) => ({
      text: m.rel,
      root: rootLabelOf(roots, m.rootIndex),
      indent: 0,
      title: m.path,
      action: { kind: 'openFile', path: m.path, line },
    }))
  }

  /**
   * 把最近项目摊成行。
   *
   * `root` 那一格放的是**父目录**而不是根名：两个都叫 `app` 的项目
   * （`~/work/app` 与 `~/side/app`）只有它能分开，见 `./projects.ts` 的 `projectWhere`。
   * 于是这一格在两种模式下的读法是同一句话：「这个名字在那个地方」
   */
  function projectRows(entries: readonly (readonly string[])[]): QuickOpenRow[] {
    return entries.map((roots) => ({
      text: projectLabel(roots),
      root: projectWhere(roots),
      indent: 0,
      // 悬停时一行一个**完整路径**：多根那条候选在行里只剩 `vela +2`，
      // 不挂 title 的话用户没有任何办法在界面上看清到底是哪几个文件夹
      title: roots.join('\n'),
      action: { kind: 'openWorkspace', roots: [...roots] },
    }))
  }

  function symbolRows(items: readonly DocSymbol[]): QuickOpenRow[] {
    return items.map((s) => ({
      text: s.name,
      root: '',
      indent: s.level,
      title: s.name,
      action: { kind: 'gotoPos', pos: s.pos },
    }))
  }

  /**
   * `FileMatch.rootIndex` → 画在候选前面的那个名字。
   *
   * ⚠️ 收的是**这一次查询起飞时**的那份清单（`queryFiles` 里那个局部量），不是现读的
   * `options.roots()`：`rootIndex` 是 Rust 在它收到的那个数组里的下标，现读的话
   * 「结果还在飞的时候动了工作区」会让每一行的前缀都指错地方——不报错，
   * 而按 Enter 打开的又确实是对的文件，所以用户连怀疑都不会怀疑。
   *
   * 少于两个根一律给空串：单根时每一行前面都挂着同一个项目名，纯噪音。
   * 越界也给空串（画一个 `undefined` 出来更糟）
   */
  function rootLabelOf(roots: readonly string[], rootIndex: number): string {
    if (roots.length < 2) return ''
    const at = roots[rootIndex]
    return at === undefined ? '' : displayName(at)
  }

  async function queryFiles(needle: string, line: number | null) {
    // ⚠️ 拷一份：`tree.roots()` 是 memo，浮层开着的时候用户可能换掉工作区，
    // 而同一次查询里前后两次读到不一样的清单会让「哪些根查过了」这件事说不清
    const roots = [...options.roots()]
    if (roots.length === 0) {
      setRows([])
      setTotal(0)
      return
    }
    const mine = ++seq
    setBusy(true)
    try {
      // ⚠️ `recent` 每次现读：MRU 在浮层开着的时候也可能变（`commit` 会记一笔），
      // 缓存下来就要回答「什么时候失效」，而这一趟只是一次数组拷贝
      const res = await queryProject(roots, needle, options.recent())
      if (mine !== seq) return
      setRows(fileRows(res.matches, line, roots))
      setTotal(res.total)
      setError(null)
    } catch (err) {
      if (mine !== seq) return
      // 查询失败不留一份旧列表：留着的话用户以为看到的是这一次的结果，
      // 而它其实属于上一个搜索词——按 Enter 会打开一个他没选的文件
      setRows([])
      setTotal(0)
      setError(describeTreeError(err))
    } finally {
      if (mine === seq) setBusy(false)
    }
  }

  /** 按当前输入重算一遍列表。同步的那几种模式在这里就地算完，文件那一种发 IPC */
  function apply(text: string) {
    setSelected(0)
    // ⚠️ 这里**不**清 `error`：`show()` 里建索引失败写下的那一句会被紧接着的这一次
    // `apply` 抹掉，而浮层于是变成「什么都没发生」——用户只看到一个空列表。
    // 错误由写它的那两路各自负责：查询成功/失败在 `queryFiles` 里，建索引失败在 `show` 里
    setSymbolNote(null)
    setLineTarget(null)

    if (overlay() === 'project') {
      // `untrack`：与下面 `symbols()` 那一条同理由——清单是 store 里的 memo，
      // 让这个 effect 依赖它的话，切一次工作区就会重算一次浮层，
      // 而浮层开着的时候用户压根碰不到侧边栏
      const entries = untrack(options.recentProjects)
      setTotal(0)
      setRows(projectRows(filterProjects(entries, text)))
      return
    }

    const q = parseGotoQuery(text)
    if (q.kind === 'line') {
      setRows([])
      setTotal(0)
      setLineTarget(q.line)
      return
    }

    if (q.kind === 'symbol') {
      // `untrack`：`symbols()` 是 App 注入的，它读的是 `ws.focusedEditor()` 这类**信号**。
      // 让这个 effect 依赖它们的话，切一次标签就会重算一次浮层——而浮层开着的时候
      // 用户压根碰不到标签。语法树本身不是信号，所以「文档改了要不要重算」这个问题
      // 在这里不存在：浮层是一次性的，展开时算一遍就够
      const table = untrack(options.symbols)
      setTotal(0)
      if (table === null) {
        setRows([])
        setSymbolNote('没有打开的文档')
        return
      }
      if (table.kind === 'unsupported') {
        setRows([])
        // ⛔ 这里绝不能退化成全文搜索：那会让 `Cmd+R` 与 `Cmd+Shift+F` 变成两个入口
        // 一个行为，而用户按 `Cmd+R` 时想要的是**结构**。如实说没有，是唯一诚实的做法
        setSymbolNote(`${table.label} 还没有符号表`)
        return
      }
      const items = filterSymbols(table.items, q.needle)
      setRows(symbolRows(items))
      return
    }

    void queryFiles(q.needle, q.kind === 'fileLine' ? q.line : null)
  }

  /**
   * 输入变了、或索引刚建好时重算列表。
   *
   * `ready` 同时兼任「重新展开」的信号：`show()` 把它按到 false 再抬回 true，
   * 于是即便输入框里还是一个字都没有（`raw()` 没变），这一次展开也会重新查一遍——
   * 少了它的话「关掉浮层 → 在 Finder 里新建一个文件 → 再开浮层」看到的还是旧列表
   */
  createEffect(
    on(
      // `overlay` 也在里面：浮层已经开着的时候从 `Cmd+Shift+O` 切到 `Cmd+P`，
      // 输入框里可能一个字符都没变，少了它这一次切换不会重算列表，
      // 用户看到的是**上一个模式**的那几行
      [raw, ready, visible, overlay],
      ([text, isReady, isVisible]) => {
        if (!isVisible || !isReady) return
        apply(text)
      },
      // 不 defer：`visible` 与 `ready` 的变化本身就是触发条件，首次运行那一下
      // 由 `show()` 负责（它先置 false，effect 那时什么都不会做）
    ),
  )

  /**
   * 建索引，然后把浮层放开。`mine` 是发起它的那一次展开的世代号，见 `show()`。
   *
   * 单独抽出来是因为它有**两个**调用点：一次展开，以及「浮层已经开着、
   * 但这一次是从项目模式切回来的」——那一次没建过索引，见 `indexed` 的文档。
   */
  async function buildIndex(mine: number) {
    const roots = [...options.roots()]
    if (roots.length > 0) {
      try {
        // ⚠️ `indexProject` 在多根之下是**逐个**重建的，所以单根时代量到的耗时
        // （两万文件 40ms / 十万文件 205ms）在多根之下要乘上根的个数。
        // 这笔账还没在真机上复量过——它落在「需要用户跑一次真实 app」那一摞里
        const stats = await indexProject(roots)
        if (mine !== epoch) return
        setTruncated(stats.truncated)
      } catch (err) {
        if (mine !== epoch) return
        // 建索引失败**不**挡住浮层：`:42` 与 `@标题` 两种意图压根不问索引，
        // 而文件那一路的 `query_project` 在缓存空的时候自己会再建一次（见 commands.rs）
        setTruncated(false)
        setError(describeTreeError(err))
      }
    }
    if (mine !== epoch) return
    setIndexed(true)
    setReady(true)
  }

  async function show(seed = '', which: OverlayKind = 'goto') {
    // 已经开着：`Cmd+P` ↔ `Cmd+R` 只是换一个意图，不该把索引重建一遍。
    // ⚠️ 重建的代价不只是那 40–205ms：`show()` 会先把 `ready` 按到 false，
    // 于是符号模式在那段时间里既没有列表可显示、又走不到「正在建索引…」那一句
    // （footer 的 line/symbol 两个分支不看 `ready`），用户读到的是一句假话：
    // 「这份文档里没有匹配的标题」——而它其实还没算。
    // 索引是这一次展开时建的，中间用户碰不到文件系统（浮层盖着），所以复用它是安全的
    if (visible()) {
      setOverlay(which)
      setRaw(seed)
      setFocusRequest((n) => n + 1)
      // 唯一的例外：项目模式压根不建索引，所以从它切回来时手上没有索引可用。
      // 反方向（goto → project）什么都不用补——那一路压根不问索引
      if (which === 'goto' && !indexed()) await buildIndex(epoch)
      return
    }

    const mine = ++epoch
    setOverlay(which)
    setRaw(seed)
    setRows([])
    setTotal(0)
    setSelected(0)
    setError(null)
    setSymbolNote(null)
    setLineTarget(null)
    setTruncated(false)
    setBusy(false)
    setIndexed(false)
    // 让在飞的那一次查询作废：它回来时会发现 `mine !== seq`
    seq++
    setReady(false)
    setVisible(true)
    setFocusRequest((n) => n + 1)

    // 项目模式**不建索引**：它读的是 store 里那份已经在内存里的清单，
    // 一次 IPC 都不用发。于是 `Cmd+Shift+O` 是当场就出东西的，
    // 而 `Cmd+P` 在十万文件的仓库上要等那 205ms——两个键的手感差别正来自这一句
    if (which === 'project') {
      setReady(true)
      return
    }
    await buildIndex(mine)
  }

  function hide() {
    epoch++
    // 作废在飞的查询：它回来时浮层已经关了，写进去只会在下一次展开时闪一下旧结果
    seq++
    setVisible(false)
    setBusy(false)
    setReady(false)
    setIndexed(false)
  }

  function commitSelected() {
    // 项目模式下 `:42` 只是在过滤项目名，不是跳行——那一次 `parseGotoQuery` 压根不该跑。
    // ⚠️ 这里**现读** `raw()` 而不是用 `lineTarget()`：这个 effect 不是同步的，
    // 「`setRaw(':42')` 之后立刻按 Enter」那一下 `lineTarget` 还是 null
    const q = overlay() === 'project' ? null : parseGotoQuery(raw())
    if (q !== null && q.kind === 'line') {
      // 没有列表可挑，Enter 就是全部：这也是 `:42` 唯一的落地方式
      void options.commit({ kind: 'gotoLine', line: q.line })
      hide()
      return
    }
    const row = rows()[selected()]
    // 空列表上按 Enter 什么都不做，也**不收起**：收起的话用户会以为「按了 Enter 就跳过去了」，
    // 而其实一个字符都没动。留着浮层，他会看到底下那句「没有匹配的文件」
    if (row === undefined) return
    void options.commit(row.action)
    hide()
  }

  function key(which: QuickOpenKey, pageSize: number): number | null {
    if (which === 'Escape') {
      hide()
      return null
    }
    if (which === 'Enter') {
      commitSelected()
      return null
    }
    const next = moveSelection(rows().length, selected(), which, pageSize)
    setSelected(next)
    return rows().length === 0 ? null : next
  }

  /**
   * 只把选中挪到某一行，不落地。
   *
   * 越界的下标一律忽略而不是夹紧：调用方只有组件里的 `onMouseEnter`，它能给出的下标
   * 来自 `win().start + i()`，也就是**当前渲染出来的**那一行；真出现越界只可能是
   * 列表在这一次事件之前刚被换短了（异步查询回来了）。那种情况下把选中夹到最后一行，
   * 用户会看到高亮跳到一个他没指着的地方——不如什么都不动
   */
  function select(index: number) {
    if (index < 0 || index >= rows().length) return
    setSelected(index)
  }

  function clickRow(index: number) {
    // 点一下就落地，不分成「先选中再双击」：与搜索结果列表同一条理由——
    // 每一行都是一个明确的去处，多一次点击只会让「明明看见了却跳不过去」显得像坏了
    const row = rows()[index]
    if (row === undefined) return
    void options.commit(row.action)
    hide()
  }

  return {
    visible,
    kind: overlay,
    raw,
    rows,
    selected,
    footer,
    warning,
    error,
    busy,
    focusRequest,
    show,
    hide,
    setRaw,
    key,
    select,
    clickRow,
  }
}
