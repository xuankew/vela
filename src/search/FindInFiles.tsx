import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { isResultKey, RESULT_ROW_HEIGHT, resultWindow, segmentsOf } from './rows'
import type { SearchPanel } from './store'

/**
 * 全局搜索的底部面板（M2-C，PLAN §3.4「全局搜索」）。
 *
 * ## 名字
 *
 * 叫 `FindInFiles` 而不是 `SearchPanel`：这个项目里已经有一个「搜索面板」了，就是 CM6 的
 * `openSearchPanel` / `closeSearchPanel`——那是**当前文档内**的查找替换（`Mod+F`，
 * 见 `src/editor/findReplace.ts`）。这一个是**整个项目**的搜索（`Mod+Shift+F`）。
 * 两个都叫 SearchPanel 的话，`builtins.ts` 里会同时出现两个意思完全不同的「搜索面板」。
 *
 * ## 虚拟滚动
 *
 * 与侧边栏同一套：定高行 + `resultWindow` 的窗口算术，只渲染看得见的那几十行。
 * 结果上限是 20000 条命中（Rust 侧的 `MAX_HITS`），全部渲染出来是四万个 DOM 节点，
 * 那已经不是一个「滚动卡不卡」的问题，而是标签页会不会被浏览器杀掉的问题。
 *
 * ⚠️ 承重的性质与侧边栏一样：**滚动只改 `scrollTop` 这一个信号**，`panel.rows()` 不依赖它，
 * 所以滚动不会重建行对象，`<For>` 靠引用相等把 DOM 原样复用。改这里之前先想清楚它还在不在。
 *
 * ## 行高只有一个真相
 *
 * `RESULT_ROW_HEIGHT`（20，刻意比文件树的 22 小）同时用于窗口算术与 CSS：组件把它注入成
 * `--vela-search-row-height`，样式表里所有行高都引用那个变量。
 *
 * ## 键盘
 *
 * 五个键（上下 / Home / End / Enter）的落点全在 `rows.ts` 的 `actionForKey` 里，纯函数、已单测。
 * 这一层只做三件事：收窄 `e.key`、`preventDefault`、把选中行滚进可视区。
 * `Escape` 收起面板——它是这里唯一不走 `actionForKey` 的键，因为「收起」不是「在结果里移动」。
 *
 * ⚠️ `preventDefault` 不能省：方向键与 `Home`/`End` 在可滚动容器上有浏览器自己的默认行为，
 * 不拦的话列表会「跳两下」——选中移动一次，滚动自己再走一次。
 *
 * ## ⚠️ 有些东西这里钉不住
 *
 * 面板占掉多少编辑区高度、240px 这个数在真实窗口里合不合适、结果行的省略号断在哪儿——
 * jsdom 里没有布局（`clientHeight` 恒为 0），这些只能在看得到像素的地方判断。
 */

export interface FindInFilesProps {
  /** App 建一次、从不换引用的那份状态，见 `./store.ts` */
  panel: SearchPanel
}

export function FindInFiles(props: FindInFilesProps) {
  // 与 Sidebar / TabStrip / StatusBar 同理：`panel` 是 createSearchPanel() 返回的普通对象，
  // 引用从不变；响应式读取全走 `panel.rows()` 这类访问器。留在 `props.panel` 上现读的话，
  // 每个闭包都会被 lint 当成「在追踪范围外面读响应式值」
  // eslint-disable-next-line solid/reactivity
  const panel = props.panel

  let inputEl: HTMLInputElement | undefined
  let scrollEl: HTMLDivElement | undefined

  const [scrollTop, setScrollTop] = createSignal(0)
  /** jsdom 里恒为 0，那时窗口给出 `OVERSCAN` 行——组件测试看到的正是头几行 */
  const [viewportHeight, setViewportHeight] = createSignal(0)

  const win = createMemo(() => resultWindow(scrollTop(), viewportHeight(), panel.rows().length))
  const visible = createMemo(() => panel.rows().slice(win().start, win().end))

  function measure() {
    if (scrollEl) setViewportHeight(scrollEl.clientHeight)
  }

  onMount(() => {
    measure()
    // 与侧边栏同理不用 ResizeObserver：面板高度是 CSS 定死的（见 .find-panel），
    // 列表高度只跟着窗口走，而 jsdom 里没有 ResizeObserver
    window.addEventListener('resize', measure)
  })
  onCleanup(() => window.removeEventListener('resize', measure))

  /**
   * 每加一就 focus 一次输入框。
   *
   * 用**计数**而不是布尔：面板本来就展开着的时候再按一次 `Mod+Shift+F`，
   * 布尔值不变就不会触发这个 effect，焦点也就抢不回来（见 store.ts 的 `show`）。
   */
  createEffect(() => {
    if (panel.focusRequest() > 0) inputEl?.focus()
  })

  /**
   * 结果被清空时把滚动位置也归零。
   *
   * ⚠️ 不归零是一个看得见却很难联想到原因的 bug：上一轮滚到了第 5000px，
   * 新一轮只有三行结果，窗口算术会算出 `start === end === 3`——面板一片空白，
   * 而 `rows()` 里明明有东西，状态栏还写着「共 3 行」。
   */
  createEffect(() => {
    if (panel.rows().length > 0) return
    setScrollTop(0)
    if (scrollEl) scrollEl.scrollTop = 0
  })

  /** 把某一行滚进可视区。已经在里面时一动不动——「跳一下」比「不动」更让人失去方向 */
  function scrollToIndex(index: number) {
    const el = scrollEl
    if (!el) return
    const top = index * RESULT_ROW_HEIGHT
    const bottom = top + RESULT_ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }

  function onInputKey(e: KeyboardEvent) {
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        void panel.search()
        return
      case 'Escape':
        e.preventDefault()
        panel.hide()
        return
      case 'ArrowDown':
        // 从输入框一步走进结果。不留这条路的话用户得手去够鼠标，
        // 或者按 Tab 穿过三个开关、两个按钮才到列表——而「搜完就想看结果」是紧接着的动作
        if (panel.rows().length === 0) return
        e.preventDefault()
        panel.key('ArrowDown')
        scrollEl?.focus()
        return
      default:
        return
    }
  }

  function onListKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      panel.hide()
      return
    }
    if (!isResultKey(e.key)) return
    // 上面那个类型谓词已经把 `e.key` 收窄成 `ResultKey` 了，不需要再断言一次
    const action = panel.key(e.key)
    // `none` = 这个键此刻什么都不该干（列表是空的，或没选中就按了 Enter）。
    // 那种情况下不吃掉它，浏览器爱怎么处理怎么处理
    if (action.kind === 'none') return
    e.preventDefault()
    if (action.kind === 'select') scrollToIndex(action.index)
  }

  return (
    <section class="find-panel" style={{ '--vela-search-row-height': `${RESULT_ROW_HEIGHT}px` }}>
      <div class="find-head">
        <input
          class="find-input"
          ref={inputEl}
          type="text"
          value={panel.pattern()}
          placeholder="在项目里搜索…（Enter 开始）"
          aria-label="搜索词"
          spellcheck={false}
          onInput={(e) => panel.setPattern(e.currentTarget.value)}
          onKeyDown={onInputKey}
        />

        {/* 三个开关。用文字标记而不是图标：`.*` / `Aa` / `ab` 是 VS Code 与 Sublime
            都在用的那一套，认得的人一眼就认得，不认的人靠 title 也读得懂 */}
        <button
          class="find-opt"
          classList={{ on: panel.literal() }}
          aria-pressed={panel.literal()}
          title="把搜索词当字面串，不当正则"
          onClick={() => panel.toggle('literal')}
        >
          .*
        </button>
        <button
          class="find-opt"
          classList={{ on: panel.caseSensitive() }}
          aria-pressed={panel.caseSensitive()}
          title="区分大小写（默认不区分）"
          onClick={() => panel.toggle('caseSensitive')}
        >
          Aa
        </button>
        <button
          class="find-opt"
          classList={{ on: panel.wholeWord() }}
          aria-pressed={panel.wholeWord()}
          title="整词匹配"
          onClick={() => panel.toggle('wholeWord')}
        >
          ab
        </button>

        {/* 这两个用全局的 button 外观，与工具栏上那几个一模一样：
            「搜索」在这个面板里是主动作，但它不是什么需要特别强调的危险或首次动作 */}
        <button onClick={() => void panel.search()} title="Enter">
          搜索
        </button>
        <Show when={panel.running()}>
          <button onClick={() => void panel.cancel()} title="停下这一次搜索（已经搜到的留着）">
            取消
          </button>
        </Show>

        {/* 清空与收起是两个「反向」动作，所以只做小图标、不给按钮外观。
            包在 `.find-tail` 里一起推到右边：它们与左边的「搜索/取消」不是一组动作，
            挨在一起会被读成同一排功能 */}
        <span class="find-tail">
          <button class="find-act" onClick={() => panel.clear()} title="清掉结果，搜索词留着">
            ⌫
          </button>
          <button class="find-act" onClick={() => panel.hide()} title="收起面板（结果留着，Esc 也一样）">
            ×
          </button>
        </span>
      </div>

      <div class="find-status">
        <span class="find-status-text">{panel.statusLine()}</span>
        <Show when={panel.error()}>{(text) => <span class="find-error">{text()}</span>}</Show>
      </div>

      {/* 单独一行、警告色：这句话限定的是上面那个数字的效力，混在一行里会被扫过去 */}
      <Show when={panel.warning()}>{(text) => <div class="find-warning">{text()}</div>}</Show>

      <div
        class="find-scroll"
        ref={scrollEl}
        tabIndex={0}
        role="listbox"
        aria-label="搜索结果"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onListKey}
      >
        <div class="find-spacer" style={{ height: `${win().totalHeight}px` }}>
          <div class="find-window" style={{ transform: `translateY(${win().offsetY}px)` }}>
            <For each={visible()}>
              {(row, i) => {
                /** 这一行在 `panel.rows()` 里的绝对下标：选中态与点击都要用它 */
                const at = () => win().start + i()
                // 下面三样都在这一次求值，不做成响应式：行对象是不可变的，
                // 而 `<For>` 靠引用相等复用 DOM，所以它们对同一行只会算一次
                const count = row.kind === 'file' ? `${row.hits} 处${row.truncated ? '（这个文件没搜完）' : ''}` : ''
                const segments = row.kind === 'hit' ? segmentsOf(row.text, row.ranges) : []
                const lineNo = row.kind === 'hit' ? row.line : 0

                return (
                  <div
                    class="find-row"
                    classList={{ file: row.kind === 'file', selected: panel.selected() === at() }}
                    role="option"
                    aria-selected={panel.selected() === at()}
                    title={row.path}
                    onClick={() => panel.clickRow(at())}
                  >
                    {row.kind === 'file' ? (
                      <>
                        <span class="find-rel">{row.rel}</span>
                        <span class="find-count">{count}</span>
                      </>
                    ) : (
                      <>
                        <span class="find-line">{lineNo}</span>
                        <span class="find-text">
                          {segments.map((s) => (s.hit ? <mark class="find-mark">{s.text}</mark> : s.text))}
                        </span>
                      </>
                    )}
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </div>
    </section>
  )
}
