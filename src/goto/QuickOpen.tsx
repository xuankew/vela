import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { visibleWindow } from '../ui/virtual'
import { isQuickOpenKey, QUICK_OPEN_ROW_HEIGHT, type QuickOpen } from './store'

/**
 * `Cmd+P` / `Cmd+R` 的浮层（M2-E-5，PLAN §3.4「Goto Anything」）。
 *
 * ## 为什么是顶部浮层而不是底部面板
 *
 * 底部那一块已经被全局搜索占了（`.find-panel`，240px）。两者同时展开的话编辑区只剩一条缝，
 * 而 `Cmd+P` 的典型用法是「跳过去，浮层立刻消失」——它不是一个会一直开着的面板。
 * 盖在上面、用完就走，是 VS Code 与 Sublime 一致的选择，也是这里唯一不挤占编辑区的选择。
 *
 * `.palette-backdrop` 是 `position: fixed`，脱离 `.app` 的 grid 流，所以不会给那个
 * 「行数必须固定」的 grid（见 `styles.css` 的 `.app`）多加出一行来。
 *
 * ## 虚拟滚动
 *
 * 与侧边栏、搜索结果列表同一套：`src/ui/virtual.ts` 的 `visibleWindow` + 定高行。
 * Rust 侧一次最多回 50 条（`QUERY_LIMIT`），所以文件模式其实用不上虚拟化；
 * 但 `@标题` 那一路没有上限——一份长笔记几百个标题很正常，全部渲染出来就是几百个节点，
 * 而浮层是**每按一个键都要重算一遍**的东西。
 *
 * ⚠️ 承重的性质与那两个列表一样：滚动只改 `scrollTop` 这一个信号，`goto.rows()` 不依赖它，
 * 于是滚动不会重建行对象，`<For>` 靠引用相等把 DOM 原样复用。
 *
 * ## 键盘
 *
 * 落点在 `store.ts` 的 `moveSelection`（纯函数、已单测）。这一层只做三件事：
 * 收窄 `e.key`、`preventDefault`、把选中行滚进可视区。
 *
 * ⚠️ `Escape` 在自己的子树里处理，**不注册成命令**：命令中心的 keybinding 挂在
 * `window` 的**捕获**阶段（见 `src/commands/dispatch.ts`），而捕获阶段跑在冒泡之前——
 * 浮层里的 `stopPropagation` 拦不住它。`builtins.ts` 里那条「绑 Escape 的命令一律不注册」
 * 正是为这种情形立的规矩。
 */

export interface QuickOpenProps {
  /** App 建一次、从不换引用的那份状态，见 `./store.ts` */
  goto: QuickOpen
}

export function QuickOpen(props: QuickOpenProps) {
  // 与 Sidebar / FindInFiles 同理：`goto` 是 `createQuickOpen()` 返回的普通对象，引用从不变；
  // 响应式读取全走 `goto.rows()` 这类访问器。留在 `props.goto` 上现读的话，
  // 每个闭包都会被 lint 当成「在追踪范围外面读响应式值」
  // eslint-disable-next-line solid/reactivity
  const goto = props.goto

  let inputEl: HTMLInputElement | undefined
  let scrollEl: HTMLDivElement | undefined

  const [scrollTop, setScrollTop] = createSignal(0)
  /** jsdom 里恒为 0，那时窗口给出 `OVERSCAN` 行——组件测试看到的正是头几行 */
  const [viewportHeight, setViewportHeight] = createSignal(0)

  const win = createMemo(() => visibleWindow(scrollTop(), viewportHeight(), goto.rows().length, QUICK_OPEN_ROW_HEIGHT))
  const shown = createMemo(() => goto.rows().slice(win().start, win().end))
  /** 一页是多少行。jsdom 里量不到高度，于是这里是 1——`PageDown` 只走一行，不是 bug */
  const pageSize = createMemo(() => Math.max(1, Math.floor(viewportHeight() / QUICK_OPEN_ROW_HEIGHT)))

  function measure() {
    if (scrollEl) setViewportHeight(scrollEl.clientHeight)
  }

  onMount(() => {
    measure()
    // 与侧边栏同理不用 ResizeObserver：浮层宽度是 CSS 定死的，列表高度只跟着窗口走，
    // 而 jsdom 里没有 ResizeObserver
    window.addEventListener('resize', measure)
    // ⚠️ 挂在下一帧而不是当场 focus：这个组件是被 `<Show when={goto.visible()}>` 挂上来的，
    // 而 `visible` 那次写入与 `focusRequest` 那次写入在同一批里——当场 focus 的话
    // 下面那个 effect 还没跑，而 `show()` 里那次 `focusRequest` 自增也就白加了
    inputEl?.focus()
  })
  onCleanup(() => window.removeEventListener('resize', measure))

  /**
   * 每加一就 focus 一次输入框。
   *
   * 用**计数**而不是布尔：浮层已经开着的时候再按一次 `Cmd+P`，布尔值不变就不会触发
   * 这个 effect，焦点也就抢不回来（理由与 `search/store.ts` 的 `focusRequest` 逐字相同）。
   *
   * ⚠️ 这里**不**顺手 `select()` 全选：`show()` 每次都把输入框清空，所以任何一条真实的
   * 路径上都没有「上一次留下的文字」可选。为一种不会发生的情形留一行代码，
   * 只会让下一个人以为它有用途
   */
  createEffect(() => {
    if (goto.focusRequest() === 0) return
    inputEl?.focus()
  })

  /** 把某一行滚进可视区。已经在里面时一动不动——「跳一下」比「不动」更让人失去方向 */
  function scrollToIndex(index: number) {
    const el = scrollEl
    if (!el) return
    const top = index * QUICK_OPEN_ROW_HEIGHT
    const bottom = top + QUICK_OPEN_ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }

  /**
   * 列表被换掉时把滚动位置归零。
   *
   * ⚠️ 不归零是一个看得见却很难联想到原因的 bug：上一次滚到了 800px，这一次只剩三行，
   * 窗口算术会算出 `start === end === 3`——浮层一片空白，而底下那行明明写着「3 个匹配」。
   * 与 `FindInFiles.tsx` 里那个 effect 是同一条理由，那边写得更细
   */
  createEffect(() => {
    if (goto.rows().length > 0) return
    setScrollTop(0)
    if (scrollEl) scrollEl.scrollTop = 0
  })

  function onKeyDown(e: KeyboardEvent) {
    if (!isQuickOpenKey(e.key)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      goto.hide()
      return
    }
    if (e.key === 'Enter') {
      // ⚠️ 必须 preventDefault，即便 store 那边什么都没做（空列表）：
      // 不拦的话浏览器会把它当成表单提交，而浮层里那一格输入框没有 form，
      // 某些内核会顺手把焦点挪走
      e.preventDefault()
      goto.key('Enter', pageSize())
      return
    }
    const next = goto.key(e.key, pageSize())
    // `null` = 列表是空的，这个方向键此刻什么都不该干。那种情况下不吃掉它
    if (next === null) return
    e.preventDefault()
    scrollToIndex(next)
  }

  return (
    <div
      class="palette-backdrop"
      // 行高只有一个真相：这个数字与上面 `visibleWindow` 用的必须是同一个常量，
      // 样式表里所有行高都引用这个变量（与 FindInFiles 注入 `--vela-search-row-height` 同理）
      style={{ '--vela-palette-row-height': `${QUICK_OPEN_ROW_HEIGHT}px` }}
      // 点遮罩空白处收起，点子元素不算：`currentTarget === target` 是判这件事最省的办法，
      // 不必给浮层本体挂一个 stopPropagation
      onClick={(e) => {
        if (e.currentTarget === e.target) goto.hide()
      }}
    >
      {/* 同一个浮层办两件事，于是这两个标签都得跟着 `kind()` 走：
          读屏的人听到的「跳转到」在切项目那一刻是句错话 */}
      <div class="palette" role="dialog" aria-label={goto.kind() === 'project' ? '切换到最近项目' : '跳转到'}>
        <input
          class="palette-input"
          ref={inputEl}
          type="text"
          value={goto.raw()}
          placeholder={goto.kind() === 'project' ? '按名字或路径找最近项目…' : '按名字找文件…（:42 跳行，@ 列标题）'}
          aria-label={goto.kind() === 'project' ? '最近项目' : '跳转'}
          aria-controls="palette-list"
          spellcheck={false}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          onInput={(e) => goto.setRaw(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />

        <Show when={goto.warning()}>{(text) => <div class="palette-warn">{text()}</div>}</Show>

        <div
          class="palette-list"
          id="palette-list"
          ref={scrollEl}
          role="listbox"
          aria-label="候选"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div class="palette-spacer" style={{ height: `${win().totalHeight}px` }}>
            <div class="palette-window" style={{ transform: `translateY(${win().offsetY}px)` }}>
              <For each={shown()}>
                {(row, i) => {
                  /** 这一行在 `goto.rows()` 里的绝对下标：选中态与点击都要用它 */
                  const at = () => win().start + i()
                  // 行对象是不可变的，而 `<For>` 靠引用相等复用 DOM，所以这一次求值就够，
                  // 不必做成响应式。indent 0 = 文件行，1–6 = 标题级别
                  const pad = 10 + Math.max(0, row.indent - 1) * 12
                  return (
                    <div
                      class="palette-row"
                      classList={{ selected: goto.selected() === at(), symbol: row.indent > 0 }}
                      style={{ 'padding-left': `${pad}px` }}
                      role="option"
                      aria-selected={goto.selected() === at()}
                      title={row.title}
                      onClick={() => goto.clickRow(at())}
                      // 鼠标移到哪一行就选中哪一行：浮层是「按 Enter 落地」的东西，
                      // 让悬停与选中不一致的话，用户会以为 Enter 打开的是他指着的那一行
                      onMouseEnter={() => goto.select(at())}
                    >
                      {/* 这一格在两种模式下装的不是同一样东西：文件行是**根名**
                          （单根时恒为空串，见 store.ts 的 `rootLabelOf`），项目行是
                          **父目录**（见 ./projects.ts 的 `projectWhere`）。读法却是同一句：
                          「这个名字在那个地方」。
                          空串时压根不画节点而不是画一个空 span：空 span 也会占掉它自己那份
                          margin，于是两种模式的左边界对不齐 */}
                      {row.root === '' ? null : <span class="palette-root">{row.root}</span>}
                      <span class="palette-text">{row.text}</span>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </div>

        <div class="palette-foot" classList={{ busy: goto.busy() }}>
          <Show when={goto.error()}>{(text) => <span class="palette-error">{text()}</span>}</Show>
          <span class="palette-status">{goto.footer()}</span>
        </div>
      </div>
    </div>
  )
}
