import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { iconForPath } from '../editor/language'
import type { GithubSync } from '../github/store'
import { visibleWindow } from '../ui/virtual'
import type { WereadSync } from '../weread/store'
import { TreeGlyphIcon } from './icons'
import type { ProjectTree } from './store'
import { NameDialog, type NameDialogProps } from './NameDialog'
import { TreeMenu } from './TreeMenu'
import {
  actionForKey,
  containerRel,
  displayName,
  isMutedRow,
  isTreeKey,
  keyOf,
  menuFor,
  ROW_HEIGHT,
  rowKey,
  sameDir,
  sameRow,
  type RowKey,
  type TreeMenuAction,
  type TreeRow,
} from './tree'

/**
 * 文件树要说给**整个窗口**听的一句话。
 *
 * 不显示在侧边栏里：那一条只有 220px 宽，一句「/Users/…/README.md 已经存在，换一个名字」
 * 在里面会折成四五行的窄条，把树挤下去。提示条是横贯窗口的，而且它本来就是
 * 「不属于某一个文档的话」的落脚点（会话警告也在那里）。
 */
export interface TreeNotice {
  /** `ok` = 一次做完了的回话（已移到废纸篓 / 已复制路径），`error` = 没做成 */
  level: 'ok' | 'error'
  text: string
}

export interface SidebarProps {
  tree: ProjectTree
  onNotice?: (notice: TreeNotice) => void
  /**
   * 侧边栏宽（px）。信号在 App 那边：收起再展开不该回到默认值，那是用户调过的现场；
   * 窗口 resize 时还要把它重新夹进上下限（见 `project/SidebarResize.tsx`）
   */
  width: number
  /**
   * 微信读书全量同步的状态机（M8-6a）。不传 = 这一轮没有同步入口：
   * 根行尾部不长图标，右键菜单也不出那一项。测试里四十多个挂载点都是这样，
   * 所以它必须是可选的——不给它也能编译，而且渲染结果与 M8-5 时逐字一致。
   */
  sync?: WereadSync
  /**
   * 「同步目录」配置（`settings.json` 的 `wereadLocalDir`）。空串 = 没配。
   * 与 `sync` 同时给、且某个根恰好就是这个目录时，那一行才长出图标。
   *
   * ⚠️ 单独成一个 prop 而不是塞进 `sync`：配置的真相在 settings store 里，
   * 同步的状态机不该再存一份副本——两份的话开关设置之后图标会晚一拍才消失
   */
  wereadDir?: string
  /**
   * GitHub 目录同步的状态机（M8-6b）。不传 = 这一轮没有云图标：
   * 根行尾部少一枚，渲染结果与 M8-6a 逐字一致。
   */
  githubSync?: GithubSync
  /**
   * 「文件同步」配置（`settings.json` 的 `syncLocalDir`）。空串 = 没配。
   * 判据与 `wereadDir` 同一条 `sameDir`，只判相等不判前缀。
   */
  githubDir?: string
}

/**
 * 侧边栏：项目文件树。
 *
 * ## 虚拟滚动
 *
 * 定高行 + `visibleWindow` 的窗口算术，只渲染看得见的那几十行。滚动时变的只有
 * `scrollTop` 这一个信号，而 `tree.rows()` 是 memo、不依赖它——所以**滚动不会重建行对象**，
 * `<For>` 靠引用相等把 DOM 原样复用，只是把窗口挪一挪。展开/折叠才会真的重算 `rows()`。
 * 这条性质是「十万行的仓库滚起来不卡」的全部依据，改这里之前先想清楚它还在不在。
 *
 * ## 行高只有一个真相
 *
 * `ROW_HEIGHT` 同时用于窗口算术与 CSS：组件把它注入成 `--vela-tree-row-height`，
 * 样式表里所有行高都引用那个变量。写成两处字面量的话，漂移的失败方式是
 * 「行与行之间露出一条缝」或「互相压住半个字」——不报错，只是难看，而且很难联想到
 * 是 TS 里一个常量与 CSS 里一个数字对不上。
 *
 * ## 键盘
 *
 * 七个键的落点全在 `actionForKey` 里（纯函数，已单测）。这一层只做三件事：收窄 `e.key`、
 * `preventDefault`、以及把选中的那一行滚进可视区。
 *
 * ⚠️ `preventDefault` 不能省：`Home`/`End`/方向键在可滚动容器上有浏览器自己的默认行为
 * （滚到顶/底、滚一行），不拦的话树会「跳两下」——选中移动一次，滚动自己再走一次。
 *
 * ## 右键菜单（M2-B-5）
 *
 * 这一层只做三件事：**弹在哪**（光标位置）、**弹什么**（`menuFor(row)`，纯函数，已单测）、
 * **选完之后调谁**（store 上那五个方法）。所有「行不行、成没成」的判断都在下游——
 * 根行不给「移到废纸篓」是 `menuFor` 的事，`rootTree.trash` 里那道 `rel === ''` 的拦截
 * 再挡一道，名字合不合法是 Rust 侧的事。这一层不重复任何一条。
 *
 * 结果一律走 `onNotice` 交到窗口顶部的提示条上，理由见 `TreeNotice`。
 */
export function Sidebar(props: SidebarProps) {
  // 与 TabStrip / StatusBar 同理：`tree` 是 createProjectTree() 返回的普通对象，
  // App 只建一次也从不换引用；响应式读取全走 `tree.rows()` 这类访问器。
  // eslint-disable-next-line solid/reactivity
  const tree = props.tree
  // `onNotice` 也一样：App 传下来的是 `setTreeNotice` 这个 signal setter，引用从不变。
  // 留在 `props.onNotice` 上现读的话，每个调 `say` 的闭包都会被 lint 当成
  // 「在追踪范围外面读响应式值」——而它们读的其实是一个固定不变的回调
  // eslint-disable-next-line solid/reactivity
  const onNotice = props.onNotice

  let scrollEl: HTMLDivElement | undefined

  const [scrollTop, setScrollTop] = createSignal(0)
  /**
   * 可视区高度。jsdom 里 `clientHeight` 恒为 0，那时窗口给出 `OVERSCAN` 行——
   * 组件测试看到的正是头几行，这不是巧合而是 `visibleWindow` 里写明的行为。
   */
  const [viewportHeight, setViewportHeight] = createSignal(0)

  /**
   * 正弹着的右键菜单。`null` = 没有。
   *
   * 存的是**那一行的快照**而不是 `rel`：菜单是短命的（一次点击就没了），而快照里已经带着
   * `name` / `isDir` / `path`，用 rel 的话每次要回到 `rows()` 里再找一遍，还得处理
   * 「找不到了怎么办」——那只会发生在树刚好在这一瞬间被重读的场合，为它写一条分支不值当。
   */
  const [menu, setMenu] = createSignal<{ x: number; y: number; row: TreeRow } | null>(null)

  /**
   * 正等用户起名字的对话框。`null` = 没有。新建文件/新建文件夹/重命名三个动作共用。
   *
   * `onCancel` 不在里面：它就是 `setPrompt(null)`，三个动作一模一样，存进去只是多一处
   * 会漂移的重复。`onSubmit` 存进来时已经被 `closing` 包过一层了，JSX 那边原样交给对话框。
   */
  const [prompt, setPrompt] = createSignal<Omit<NameDialogProps, 'onCancel'> | null>(null)

  const win = createMemo(() => visibleWindow(scrollTop(), viewportHeight(), tree.rows().length, ROW_HEIGHT))
  const visible = createMemo(() => tree.rows().slice(win().start, win().end))

  /**
   * 头部那一格显示什么。
   *
   * 它是**栏目题头**（「文件夹」），不是根的名字：根名在它自己那条根行上已经写了一遍，
   * 题头再重复一次只是让同一屏上出现两个一模一样的词。多根时报个数——
   * 写着 `vela` 而工作区里还有 `notes` 的话，用户在 `notes` 里搜不到东西只会以为搜索坏了。
   * 每个根自己的名字在它自己那条根行上，头部这一格不重复。
   */
  const headLabel = createMemo(() => {
    const list = tree.roots()
    if (list.length === 0) return ''
    if (list.length === 1) return '文件夹'
    return `${list.length} 个文件夹`
  })

  function measure() {
    if (scrollEl) setViewportHeight(scrollEl.clientHeight)
  }

  onMount(() => {
    measure()
    // 窗口缩放会改可视区高度。不用 ResizeObserver：侧边栏宽度是固定的（见 CSS），
    // 高度只跟着窗口走，而 jsdom 里没有 ResizeObserver，为一个用不上的能力加一层 mock 不值当
    window.addEventListener('resize', measure)
  })
  onCleanup(() => window.removeEventListener('resize', measure))

  /** 把某一行滚进可视区。已经在里面时一动不动——「跳一下」比「不动」更让人失去方向 */
  function scrollToRow(key: RowKey) {
    const el = scrollEl
    if (!el) return
    const index = tree.rows().findIndex((r) => sameRow(keyOf(r), key))
    if (index < 0) return
    const top = index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!isTreeKey(e.key)) return
    const action = actionForKey(tree.rows(), tree.selected(), e.key)
    if (action.kind === 'none') return
    e.preventDefault()
    tree.run(action)
    if (action.kind !== 'open') scrollToRow(action.key)
  }

  function onRowClick(row: TreeRow) {
    const key = keyOf(row)
    tree.select(key)
    if (row.isDir) void tree.toggle(key)
    else tree.run({ kind: 'open', key })
  }

  function onRowContextMenu(e: MouseEvent, row: TreeRow) {
    // 不拦的话 macOS 会在我们的菜单旁边再弹一个原生的，两个叠在一起
    e.preventDefault()
    // 顺手选中：菜单弹出来时用户要能看清自己右键的是哪一行，
    // 尤其是名字被省略号截断的那些——菜单里不重复那一行的名字
    tree.select(keyOf(row))
    setMenu({ x: e.clientX, y: e.clientY, row })
  }

  function say(level: TreeNotice['level'], text: string) {
    onNotice?.({ level, text })
  }

  /**
   * 跑一个「一步做完」的动作：成了就说一句好话（`okText` 不传就是不说），没成就把那句话交上去。
   *
   * 三个动作共用它是为了让**失败一定被说出来**：漏掉一次 `say('error', …)` 的失败方式是
   * 用户点了「复制路径」、什么也没发生、剪贴板里还是上一条内容，而他没有任何办法知道。
   *
   * 成功那句话是**参数**而不是回调：它只取决于点的是哪一行，在调进来之前就算得出来。
   */
  async function runOp(op: () => Promise<string | null>, okText?: string) {
    const outcome = await op()
    if (outcome === null) {
      if (okText !== undefined) say('ok', okText)
    } else {
      say('error', outcome)
    }
  }

  /**
   * 把「成功才摘掉对话框」这一层包在外面，新建文件/新建文件夹/重命名三个动作共用。
   *
   * ⚠️ 失败时对话框得留在原地、把那句话显示在输入框下面：关掉的话用户要重新右键、
   * 重新点一次、重新打一遍名字，才知道自己错在哪。
   *
   * 包在这里而不是写在 JSX 里，是为了让 `NameDialog` 拿到的是一个普通函数——
   * JSX 属性上挂一个 async 箭头函数，Solid 的 lint 会当成「异步的追踪范围」报警，
   * 而它其实压根不需要追踪任何东西。
   */
  function closing(op: (name: string) => Promise<string | null>): NameDialogProps['onSubmit'] {
    return async (name) => {
      const outcome = await op(name)
      if (outcome === null) setPrompt(null)
      return outcome
    }
  }

  /**
   * 一层 rel 的显示名。根层用**那个根**的项目名——`displayName('')` 只会得到空字符串，
   * 而多根之下「根层」有 N 个，得说清是哪一个。
   */
  function labelOf(rootIndex: number, rel: string): string {
    return rel === '' ? tree.rootName(rootIndex) : displayName(rel)
  }

  /** 第几个根的绝对路径。位次越界只可能是树在这一瞬间被重读了，调用方一律当作「没有」 */
  function rootPathOf(rootIndex: number): string | undefined {
    return tree.roots()[rootIndex]
  }

  /**
   * 这一行该不该出现微信读书入口（M8-6a）：**根行**，且这个根就是配置的那个目录。
   *
   * 判的是相等不是前缀（`sameDir`）：打开的是同步目录的子目录时不算——
   * 同步状态属于那个目录本身，而图标与右键项都只挂在根行上。
   * 也没配（空串）时 `sameDir` 直接为假，所以不配就一个都不出现。
   */
  function isWereadRoot(row: TreeRow): boolean {
    return row.rel === '' && sameDir(rootPathOf(row.rootIndex), props.wereadDir ?? '')
  }

  /** 云图标（M8-6b）：同一条判据，条件换成「文件同步」的目录 */
  function isGithubRoot(row: TreeRow): boolean {
    return row.rel === '' && sameDir(rootPathOf(row.rootIndex), props.githubDir ?? '')
  }

  /**
   * 这一行有没有任何一个同步入口。
   *
   * ⚠️ 用它来决定要不要落那个包装 `<span>`：包装带 `margin-left: auto`，无条件渲染的话
   * 每一行都会多出一个吃掉剩余空间的空元素（视觉上看不出来，但下一枚想贴着行尾的东西
   * 会被顶到中间去）。条件与下面两个 `<Show>` 的判据逐字一致。
   */
  function hasSyncEntry(row: TreeRow): boolean {
    return (props.sync !== undefined && isWereadRoot(row)) || (props.githubSync !== undefined && isGithubRoot(row))
  }

  /**
   * 两把同步同时跑是界面层要避免的事：一个根只有一行，塞不下两句「同步中…」，
   * 而且它们会各自往同一个目录写盘。所以**一边在跑时，另一枚图标先收起来**——
   * 不是变灰（灰的会被读成「这里本来有东西，只是暂时点不了」）。
   * store 那一层的单飞只看自己，跨 store 的这道闸在这里。
   */
  const wereadRunning = () => props.sync?.running() ?? false
  const githubRunning = () => props.githubSync?.running() ?? false

  /**
   * 菜单里选了一项。
   *
   * `row` 是**参数**而不是从 `menu()` 里现读的：这个函数只会被 TreeMenu 的 onClick 调到，
   * 那一刻菜单马上就要关了，行也就定死了。写成 `menu()?.row` 的话下面每个闭包都会被
   * 当成「在追踪范围外面读响应式值」——而它们读的其实是一份快照。
   *
   * ⚠️ 递给 store 的一律是 `keyOf(row)` 而不是 `row.rel`：两个根都有一条 `src/a.ts`，
   * 少了 `rootIndex` 的那一句会在**另一个根**里改名/删文件，而且不报错。
   */
  function pick(action: TreeMenuAction, row: TreeRow) {
    switch (action) {
      case 'newFile':
      case 'newFolder': {
        const kind = action === 'newFile' ? 'file' : 'dir'
        const parent = rowKey(row.rootIndex, containerRel(row))
        setPrompt({
          title: `在「${labelOf(parent.rootIndex, parent.rel)}」里新建${kind === 'file' ? '文件' : '文件夹'}`,
          initialValue: '',
          submitLabel: '新建',
          // 成了不用说话：新条目已经被选中，树上看得见
          onSubmit: closing((name) => tree.create(parent, name, kind)),
        })
        return
      }
      case 'rename':
        setPrompt({
          title: `把「${row.name}」改名`,
          initialValue: row.name,
          selectBasename: !row.isDir,
          submitLabel: '改名',
          onSubmit: closing((name) => tree.rename(keyOf(row), name)),
        })
        return
      case 'trash':
        // ⚠️ 措辞必须是「移到废纸篓」，不能说「已删除」。说「已删除」，用户会去找那个
        // 不存在的撤销，或者反过来以为文件真没了、去翻 git
        void runOp(() => tree.trash(keyOf(row)), `已把「${row.name}」移到废纸篓，可以在 Finder 的废纸篓里找回`)
        return
      case 'reveal':
        // 成了不说话：Finder 被推到前台本身就是回话，再说一句是重复
        void runOp(() => tree.reveal(keyOf(row)))
        return
      case 'copyPath':
        // 成了要说：剪贴板没有任何可见变化，不说的话「复制成功了没有」无从判断
        void runOp(() => tree.copyPath(keyOf(row)), `已复制「${row.name}」的路径`)
        return
      case 'removeRoot':
        // ⚠️ 这一句必须说清「磁盘上什么都没动」：整个根连同它下面所有行一起从树上消失，
        // 看上去与「把那个文件夹删了」一模一样，而那正是用户此刻最怕的事。
        // 它是同步的（不发 IPC），所以走不了 `runOp`——那条通道收的是 Promise
        tree.removeRoot(row.rootIndex)
        say('ok', `已把「${row.name}」移出工作区，磁盘上的文件一个都没动`)
        return
      case 'syncWeread': {
        // 不 `await`、也不在这里等结果：进度与失败都走同步 store 的事件与 `onError`，
        // 这一层只负责把那一下点下去（与图标那一条是同一个入口、同一句话）。
        // 位次越界/同步没接上时安静地不动——菜单项本来就不会出现在那种场合
        const sync = props.sync
        const rootPath = rootPathOf(row.rootIndex)
        if (sync === undefined || rootPath === undefined) return
        void sync.start(rootPath)
        return
      }
    }
  }

  return (
    <aside class="sidebar" style={{ width: `${props.width}px`, '--vela-tree-row-height': `${ROW_HEIGHT}px` }}>
      <div class="sidebar-head">
        <Show
          when={tree.roots().length > 0}
          fallback={
            <button class="sidebar-open" onClick={() => void tree.openViaDialog()}>
              打开文件夹…
            </button>
          }
        >
          {/* title 挂**全部**根的路径（一行一个）：多根时头部那一格只剩「3 个文件夹」，
              不挂 title 的话用户没有任何办法在界面上看清到底是哪三个 */}
          <span class="sidebar-title" title={tree.roots().join('\n')}>
            {headLabel()}
          </span>
          {/* 三个动作按「加 / 重读 / 全关」排：加是最常用的那个，全关排在最右边
              与 macOS 的习惯一致，也离「＋」最远——一次误点不该直接把整个工作区关掉 */}
          <button
            class="sidebar-act"
            title="添加文件夹到工作区…（可以一次多选）"
            onClick={() => void tree.addViaDialog()}
          >
            +
          </button>
          <button class="sidebar-act" title="重新读取所有摊开的层" onClick={() => void tree.refresh()}>
            ↻
          </button>
          <button class="sidebar-act" title="关闭所有文件夹（不动已打开的标签）" onClick={() => tree.close()}>
            ×
          </button>
        </Show>
      </div>

      <div
        class="tree-scroll"
        ref={scrollEl}
        tabIndex={0}
        role="tree"
        aria-label="项目文件树"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop)
          // 菜单是 `position: fixed`，行滚走了它不会跟着走。留着的是一份指着别处的菜单，
          // 而用户点下去时已经看不出它原本属于哪一行了
          if (menu() !== null) setMenu(null)
        }}
        onKeyDown={onKeyDown}
      >
        <div class="tree-spacer" style={{ height: `${win().totalHeight}px` }}>
          <div class="tree-window" style={{ transform: `translateY(${win().offsetY}px)` }}>
            <For each={visible()}>
              {(row) => {
                // 一行里要读三次「是不是选中的那一行」，抽出来免得写三遍 `sameRow(…)`。
                // ⚠️ 必须走 `sameRow`：`RowKey` 是结构体，`keyOf` 每次都新建对象，
                // 而 `rows()` 一摊一收就整个重算，`===` 比引用永远是假
                const selected = () => sameRow(tree.selected(), keyOf(row))
                return (
                  <div
                    class="tree-row"
                    classList={{
                      selected: selected(),
                      failed: row.error !== null,
                      muted: isMutedRow(row),
                    }}
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-expanded={row.isDir ? row.expanded : undefined}
                    aria-selected={selected()}
                    title={row.path}
                    style={{ 'padding-left': `${row.depth * 14 + 8}px` }}
                    onClick={() => onRowClick(row)}
                    onContextMenu={(e) => onRowContextMenu(e, row)}
                  >
                    <span class="tree-twisty">{row.isDir ? (row.expanded ? '▾' : '▸') : ''}</span>
                    {/* 图形紧跟箭头、名字在它右边。目录一律 folder 而**不看名字**：
                        `iconForPath` 只按路径猜，而 `row.isDir` 是磁盘上问回来的真话 */}
                    <TreeGlyphIcon glyph={row.isDir ? 'folder' : iconForPath(row.path)} />
                    <span class="tree-name">{row.name}</span>
                    {/* loading 与 error 都占同一行的剩余空间，不另起一行：
                        多出一行会让这一行的高度不再是 ROW_HEIGHT，窗口算术立刻失准 */}
                    <Show when={row.loading}>
                      <span class="tree-note">读取中…</span>
                    </Show>
                    <Show when={row.error}>{(text) => <span class="tree-note bad">{text()}</span>}</Show>
                    {/* 同步入口（M8-6a / M8-6b）。条件成立才渲染：接了那个同步状态机，
                        且这一行就是配置的那个目录。⛔ 不满足时连一个 `<Show>` 都不落 DOM，
                        不是画成灰色不可点——灰图标会被读成「这里本来有东西，只是暂时点不了」。
                        点与取消都 `stopPropagation`：根行自己的 `onClick` 会收起这棵树，
                        而用户此刻要的只是同步。
                        ⚠️ 两枚图标共用行尾那一格（`.tree-sync-actions`，只有一个 `auto` 外边距），
                        否则两个 `margin-left: auto` 会把剩余空间对半分、图标被顶到行中间 */}
                    <Show when={hasSyncEntry(row)}>
                      <span class="tree-sync-actions">
                        <Show when={props.sync}>
                          {(sync) => (
                            <Show when={isWereadRoot(row)}>
                              <Show
                                when={sync().running()}
                                fallback={
                                  <Show when={!githubRunning()}>
                                    <button
                                      class="tree-sync"
                                      title="同步微信读书笔记到这里"
                                      aria-label="同步微信读书笔记"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        void sync().start(row.path)
                                      }}
                                    >
                                      <TreeGlyphIcon glyph="weread" />
                                    </button>
                                  </Show>
                                }
                              >
                                <span class="tree-sync-running">
                                  <span class="tree-sync-label">
                                    {sync().progress() === null
                                      ? '同步中…'
                                      : `同步中… ${sync().progress()!.booksDone}/${sync().progress()!.booksTotal}`}
                                  </span>
                                  <button
                                    class="tree-sync-cancel"
                                    title="取消这次同步（已经写完的不会回滚）"
                                    aria-label="取消微信读书同步"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void sync().cancel()
                                    }}
                                  >
                                    取消
                                  </button>
                                </span>
                              </Show>
                            </Show>
                          )}
                        </Show>
                        <Show when={props.githubSync}>
                          {(sync) => (
                            <Show when={isGithubRoot(row)}>
                              <Show
                                when={sync().running()}
                                fallback={
                                  <Show when={!wereadRunning()}>
                                    <button
                                      class="tree-sync"
                                      title="把笔记同步到这个 GitHub 仓库"
                                      aria-label="同步到 GitHub"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        void sync().start(row.path)
                                      }}
                                    >
                                      <TreeGlyphIcon glyph="cloud" />
                                    </button>
                                  </Show>
                                }
                              >
                                <span class="tree-sync-running">
                                  <span class="tree-sync-label">
                                    {sync().progress() === null
                                      ? '同步中…'
                                      : `同步中… ${sync().progress()!.filesDone}/${sync().progress()!.filesTotal}`}
                                  </span>
                                  <button
                                    class="tree-sync-cancel"
                                    title="取消这次同步（已经拉下来/推上去的不会回滚）"
                                    aria-label="取消 GitHub 同步"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void sync().cancel()
                                    }}
                                  >
                                    取消
                                  </button>
                                </span>
                              </Show>
                            </Show>
                          )}
                        </Show>
                      </span>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </div>

      {/* 两个浮层都是 fixed，脱离 `.sidebar` 的 flex 流，所以不会把树挤窄。
          刻意不放进 `.tree-window` 里面：那一层带 `transform`，会成为 fixed 子元素的
          包含块，菜单的定位就会跟着滚动跑 */}
      <Show when={menu()}>
        {(m) => (
          <TreeMenu
            x={m().x}
            y={m().y}
            items={menuFor(
              m().row,
              tree.roots().length,
              // 同步没接上就传 undefined：于是 `menuFor` 的行为与 M8-5 逐字一致，
              // 四十多个没接同步的挂载点（含全部旧测试）都不必改
              props.sync ? { rootPath: rootPathOf(m().row.rootIndex), wereadDir: props.wereadDir ?? '' } : undefined,
            )}
            onPick={(action) => pick(action, m().row)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>

      {/* `keyed`：`prompt()` 只会被整个换掉（或者换成 null），从不原地改，
          所以拿到的就该是那份配置本身，而不是一个每次都要再读一遍的访问器 */}
      <Show when={prompt()} keyed>
        {(cfg) => (
          <NameDialog
            title={cfg.title}
            initialValue={cfg.initialValue}
            selectBasename={cfg.selectBasename}
            submitLabel={cfg.submitLabel}
            onCancel={() => setPrompt(null)}
            onSubmit={cfg.onSubmit}
          />
        )}
      </Show>
    </aside>
  )
}
