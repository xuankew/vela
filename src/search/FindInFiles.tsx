import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from 'solid-js'
import { isResultKey, oneLine, RESULT_ROW_HEIGHT, resultWindow, segmentsOf } from './rows'
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
 * ## 替换那一排（M2-D）
 *
 * 「替换」是一个**模式**开关而不是第四个匹配选项：它换掉的是整个面板的语义
 * （搜一遍看结果 → 搜一遍看预览、然后落盘），所以视觉上与那三个分开一档（`.find-mode`）。
 * 打开之后才多出下面那一排——面板高度是这个组件的硬约束（见 `styles.css` 的 `.find-panel`），
 * 常显一排用不上的输入框就是白占 26px 编辑区。
 *
 * 落盘那一下不由这里发起：「替换全部」只调 `panel.askApply()` 摊一张确认单，
 * 真正的批准在 `./ReplaceConfirm.tsx` 里，由 App 渲染。
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
  let replaceEl: HTMLInputElement | undefined
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
   * 每加一就 focus 一次输入框。**哪一格**由 `panel.focusTarget()` 说，理由见 store.ts。
   *
   * 用**计数**而不是布尔：面板本来就展开着的时候再按一次 `Mod+Shift+F`，
   * 布尔值不变就不会触发这个 effect，焦点也就抢不回来（见 store.ts 的 `show`）。
   *
   * ⚠️ `pattern()` 只能在 `untrack` 里读：读成依赖的话，替换模式下每打一个字这个 effect
   * 就跑一次，焦点被反复抢走——与下面那个 `on(..., { defer: true })` 是同一条理由。
   *
   * ⚠️ 搜索词还空着时一律留在上面那一格：那是要打的第一个东西，把焦点抢到下面
   * 等于让用户先 Tab 回去。这条规则与下面那个 effect 重复了一次，是**故意的**：
   * 键盘入口走这一个，鼠标点「替换」按钮走那一个，两处必须得出同一个答案
   */
  createEffect(() => {
    if (panel.focusRequest() === 0) return
    if (panel.focusTarget() === 'replacement' && untrack(panel.pattern) !== '') replaceEl?.focus()
    else inputEl?.focus()
  })

  /**
   * 「替换全部」灰掉时说一句为什么。
   *
   * ⚠️ 这不是第二份判断：能不能按由 `canApply` 说了算，这里只把**同一批**状态翻译成
   * 人话。灰掉的按钮不解释自己的话，用户只会反复点它，然后以为这个功能是坏的。
   * 每一条理由都能在 `stale` / `running` / `replacing` / `summary` 上读到，
   * 与 `canApply` 的实现一一对应
   */
  const applyHint = createMemo(() => {
    if (panel.replacing()) return '正在写盘，等它结束'
    if (panel.running()) return '等这一轮搜完'
    if (panel.stale()) return '条件改过了：重新搜一遍，让预览对上你批准的那份'
    const done = panel.summary()
    if (done === null) return '先搜一遍，看看会改到哪些地方'
    if (done.hits === 0) return '这一轮一处都没命中'
    return '把命中的地方全换成上面填的内容（会先摊一张确认单）'
  })

  /**
   * **鼠标**点开替换模式时把焦点挪到「替换为」那一格——**但只在搜索词已经填了的时候**。
   *
   * 与上面那个 effect 是同一件事的两条入口：这一个服务面板上那个「替换」按钮
   * （`toggleReplaceMode` 不碰 `focusRequest`），上面那一个服务 `Mod+Shift+F` / `Mod+Shift+H`。
   * 判断必须一字不差，否则「用键盘进来」与「用鼠标点进来」会落在不同的格子上。
   *
   * 搜索词是空的意味着这是一次从头开始的替换，用户要打的第一个东西是搜索词，
   * 把焦点抢到下面那一格等于让他先 Tab 回去。搜索词已经有了（`Mod+Shift+F` 搜完
   * 再按 `Mod+Shift+H`）时，下一个要打的正好是替换内容。
   *
   * ⚠️ 用 `on` 只跟 `replaceMode` 一个信号，`defer` 掉首次：写成裸 `createEffect`
   * 的话它会把 `panel.pattern()` 也当成依赖，于是在替换模式下每打一个字焦点就被抢走一次
   */
  createEffect(
    on(
      panel.replaceMode,
      (mode) => {
        if (mode && panel.pattern() !== '') replaceEl?.focus()
      },
      { defer: true },
    ),
  )

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
        {/* 模式开关放在最左边：它管的是整个面板的语义，不是这次匹配怎么算。
            与那三个 `.find-opt` 刻意不同 class，好让「哪几个是匹配选项」在 DOM 上就分得清 */}
        <button
          class="find-mode"
          classList={{ on: panel.replaceMode() }}
          aria-pressed={panel.replaceMode()}
          title="在项目里替换：先搜一遍看每一行会变成什么，再决定要不要落盘"
          onClick={() => panel.toggleReplaceMode()}
        >
          替换
        </button>

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
            「搜索」在这个面板里是主动作，但它不是什么需要特别强调的危险或首次动作。
            替换模式下它改叫「预览」——那一次搜索的产物是「每一行会变成什么」，
            叫「搜索」的话用户看不出按下它离落盘还有一步 */}
        <button disabled={panel.replacing()} onClick={() => void panel.search()} title="Enter">
          {panel.replaceMode() ? '预览' : '搜索'}
        </button>
        {/* 搜索与替换各有一个在飞的 taskId，但「取消」只需要一个按钮：
            `panel.cancel()` 自己认得该停哪一个（见 store.ts 的两个 TaskSlot） */}
        <Show when={panel.running() || panel.replacing()}>
          <button onClick={() => void panel.cancel()} title="停下这一次（已经搜到 / 已经改完的留着）">
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

      {/* 替换那一排。只在替换模式下渲染：面板高度是硬约束（见 styles.css 的
          `.find-panel`），常显一排用不上的输入框就是白占一行编辑区 */}
      <Show when={panel.replaceMode()}>
        <div class="find-replace">
          <input
            class="find-input"
            ref={replaceEl}
            type="text"
            value={panel.replacement()}
            placeholder="替换为…（留空 = 把命中的那一段删掉）"
            aria-label="替换为"
            spellcheck={false}
            onInput={(e) => panel.setReplacement(e.currentTarget.value)}
            onKeyDown={onInputKey}
          />
          {/* 灰掉的理由挂在 title 上：每一种灰掉都已经在面板上别处说过一遍
              （stale 是警告行、running/replacing 是状态行），这里只补一句就近的 */}
          <button disabled={!panel.canApply()} title={applyHint()} onClick={() => panel.askApply()}>
            替换全部
          </button>
        </div>
      </Show>

      <div class="find-status">
        <span class="find-status-text">{panel.statusLine()}</span>
        <Show when={panel.error()}>{(text) => <span class="find-error">{text()}</span>}</Show>
      </div>

      {/* 每条单独一行、警告色：这些话限定的是上面那个数字的效力，混在一行里会被扫过去。
          落盘那一轮可以同时有好几条（见 `rows.ts` 的 `replaceWarnings`） */}
      <For each={panel.warnings()}>{(text) => <div class="find-warning">{text}</div>}</For>

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
                // 下面这几样都在这一次求值，不做成响应式：行对象是不可变的，
                // 而 `<For>` 靠引用相等复用 DOM，所以它们对同一行只会算一次
                const skipped = row.kind === 'file' && row.skipped
                const count =
                  row.kind === 'file'
                    ? `${row.hits} 处${row.truncated ? '（这个文件没搜完）' : ''}${
                        skipped ? '（正开着且有未保存的改动，跳过）' : ''
                      }`
                    : ''
                const segments = row.kind === 'hit' ? segmentsOf(row.text, row.ranges) : []
                const lineNo = row.kind === 'hit' ? row.line : 0
                /**
                 * ⚠️ 判它只能用 `=== undefined`，**不能真值判断**：空串是「把命中的那一段
                 * 删光」那个合法操作的预览，真值判断下它与「纯搜索、没预览过」一模一样。
                 * 搞混的后果是那一行退回成纯搜索的样子，用户以为自己刚预览了一次删除
                 */
                const preview = row.kind === 'hit' ? row.replaced : undefined

                return (
                  <div
                    class="find-row"
                    classList={{ file: row.kind === 'file', selected: panel.selected() === at(), skipped }}
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
                          {preview === undefined ? null : (
                            <>
                              {/* 箭头与预览都塞在 `.find-text` 里面而不是做成兄弟格：
                                  行是定高的，两格各自省略的话用户会看到「半行原文 → 半行结果」，
                                  而合成一格只有一个省略号，落在预览的尾巴上 */}
                              <span class="find-arrow">→</span>
                              <span class="find-new">{oneLine(preview)}</span>
                            </>
                          )}
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
