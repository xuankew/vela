import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { ProjectTree } from './store'
import { NameDialog, type NameDialogProps } from './NameDialog'
import { TreeMenu } from './TreeMenu'
import {
  actionForKey,
  containerRel,
  displayName,
  isTreeKey,
  menuFor,
  ROW_HEIGHT,
  visibleWindow,
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
 * 根行不给「移到废纸篓」是 `menuFor` 的事，`trash('')` 再挡一道是 store 的事，
 * 名字合不合法是 Rust 侧的事。这一层不重复任何一条。
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

  const win = createMemo(() => visibleWindow(scrollTop(), viewportHeight(), tree.rows().length))
  const visible = createMemo(() => tree.rows().slice(win().start, win().end))

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
  function scrollToRow(rel: string) {
    const el = scrollEl
    if (!el) return
    const index = tree.rows().findIndex((r) => r.rel === rel)
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
    if (action.kind !== 'open') scrollToRow(action.rel)
  }

  function onRowClick(row: TreeRow) {
    tree.select(row.rel)
    if (row.isDir) void tree.toggle(row.rel)
    else tree.run({ kind: 'open', rel: row.rel })
  }

  function onRowContextMenu(e: MouseEvent, row: TreeRow) {
    // 不拦的话 macOS 会在我们的菜单旁边再弹一个原生的，两个叠在一起
    e.preventDefault()
    // 顺手选中：菜单弹出来时用户要能看清自己右键的是哪一行，
    // 尤其是名字被省略号截断的那些——菜单里不重复那一行的名字
    tree.select(row.rel)
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

  /** 一层 rel 的显示名。根层用项目名——`displayName('')` 只会得到空字符串 */
  function labelOf(rel: string): string {
    return rel === '' ? tree.rootName() : displayName(rel)
  }

  /**
   * 菜单里选了一项。
   *
   * `row` 是**参数**而不是从 `menu()` 里现读的：这个函数只会被 TreeMenu 的 onClick 调到，
   * 那一刻菜单马上就要关了，行也就定死了。写成 `menu()?.row` 的话下面每个闭包都会被
   * 当成「在追踪范围外面读响应式值」——而它们读的其实是一份快照。
   */
  function pick(action: TreeMenuAction, row: TreeRow) {
    switch (action) {
      case 'newFile':
      case 'newFolder': {
        const kind = action === 'newFile' ? 'file' : 'dir'
        const parent = containerRel(row)
        setPrompt({
          title: `在「${labelOf(parent)}」里新建${kind === 'file' ? '文件' : '文件夹'}`,
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
          onSubmit: closing((name) => tree.rename(row.rel, name)),
        })
        return
      case 'trash':
        // ⚠️ 措辞必须是「移到废纸篓」，不能说「已删除」。说「已删除」，用户会去找那个
        // 不存在的撤销，或者反过来以为文件真没了、去翻 git
        void runOp(() => tree.trash(row.rel), `已把「${row.name}」移到废纸篓，可以在 Finder 的废纸篓里找回`)
        return
      case 'reveal':
        // 成了不说话：Finder 被推到前台本身就是回话，再说一句是重复
        void runOp(() => tree.reveal(row.rel))
        return
      case 'copyPath':
        // 成了要说：剪贴板没有任何可见变化，不说的话「复制成功了没有」无从判断
        void runOp(() => tree.copyPath(row.rel), `已复制「${row.name}」的路径`)
        return
    }
  }

  return (
    <aside class="sidebar" style={{ '--vela-tree-row-height': `${ROW_HEIGHT}px` }}>
      <div class="sidebar-head">
        <Show
          when={tree.root()}
          fallback={
            <button class="sidebar-open" onClick={() => void tree.openViaDialog()}>
              打开文件夹…
            </button>
          }
        >
          {(root) => (
            <>
              <span class="sidebar-title" title={root()}>
                {tree.rootName()}
              </span>
              <button class="sidebar-act" title="重新读取所有摊开的层" onClick={() => void tree.refresh()}>
                ↻
              </button>
              <button class="sidebar-act" title="关闭文件夹（不动已打开的标签）" onClick={() => tree.close()}>
                ×
              </button>
            </>
          )}
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
              {(row) => (
                <div
                  class="tree-row"
                  classList={{
                    selected: tree.selected() === row.rel,
                    failed: row.error !== null,
                  }}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={row.isDir ? row.expanded : undefined}
                  aria-selected={tree.selected() === row.rel}
                  title={row.path}
                  style={{ 'padding-left': `${row.depth * 12 + 6}px` }}
                  onClick={() => onRowClick(row)}
                  onContextMenu={(e) => onRowContextMenu(e, row)}
                >
                  <span class="tree-twisty">{row.isDir ? (row.expanded ? '▾' : '▸') : ''}</span>
                  <span class="tree-name">{row.name}</span>
                  {/* loading 与 error 都占同一行的剩余空间，不另起一行：
                      多出一行会让这一行的高度不再是 ROW_HEIGHT，窗口算术立刻失准 */}
                  <Show when={row.loading}>
                    <span class="tree-note">读取中…</span>
                  </Show>
                  <Show when={row.error}>{(text) => <span class="tree-note bad">{text()}</span>}</Show>
                </div>
              )}
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
            items={menuFor(m().row)}
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
