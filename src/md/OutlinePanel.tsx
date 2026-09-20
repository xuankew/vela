/**
 * 大纲面板（M3-A-4）。挂在 `.body-row` 里、`.body` 的**左边**。
 *
 * ## 为什么在左边
 *
 * 左边是「导航」（文件树、文档结构），中间是「写」，右边（预览）是「结果」。
 * 放到右边去的话它会与预览抢同一半宽，而**两个同时开着是常态**——一边看结构一边看渲染，
 * 那正是 Markdown 面板该有的样子。
 *
 * ## ⛔ 标题从哪儿来：`Cmd+R` 用的**同一份**符号表
 *
 * `symbolTable(state, path)` → `flattenOutline(items, folded)`，与浮层一字不差。
 * 这不是省事：大纲一旦自己再解析一遍 Markdown，「浮层里看得见的标题、大纲里没有」
 * 就成了迟早会发生的分歧，而那种分歧没法向用户解释。复用之后它在结构上不可能发生。
 *
 * ⚠️ 由此继承的一个缺口，说清楚：`symbolTable` 的解析预算是 **50ms**
 * （`SYMBOL_PARSE_TIMEOUT_MS`，那是**按键**预算，因为 `Cmd+R` 要立刻出浮层），
 * 超时之后退回半截树，而 `SymbolTable` **没有 `partial` 标志**——所以一份很大的
 * Markdown 上，大纲可能少列尾部的标题而一句都不说。预览那边有 `partial`，
 * 因为它自己解析（200ms，跑在防抖之后）。要补齐得给 `SymbolTable` 加一个字段，
 * 顺带动 `goto/symbols.ts`、`goto/store.ts` 与它们的用例；v1 不做，理由记在 PLAN.md。
 * 另外 >4 MiB 的文件走的是只读分片（`MAX_INLINE_BYTES`），压根没有 CM6 state，
 * 那种文档下面板会说「这块分屏里没有可列的标题」。
 *
 * ## 刻意不做 `role="tree"` + 方向键那一套
 *
 * 那要求一份真的键盘导航状态机（`Sidebar.tsx` 有 `actionForKey` 七个键 + 选中行 + 滚进可视区）。
 * 这里每一行是两个真的 `<button>`：**折叠**与**跳过去**，Tab 就能走到、Enter 就能按下。
 * 拿一份假的 `treeitem` 去换一份真的键盘导航，不如老实给两个按钮。
 *
 * ⚠️ 这里钉不住的：缩进与省略号在真实排版下长什么样、行高与 CSS 里那个变量对不对得上、
 * 点一行跳过去之后视口停在哪。jsdom 没有布局引擎（`clientHeight` 恒为 0）。
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
import { symbolTable } from '../goto/syntax'
import type { DocSymbol } from '../goto/symbols'
import { visibleWindow } from '../ui/virtual'
import { flattenOutline, OUTLINE_ROW_HEIGHT, pruneFold, toggleFold, type OutlineRow } from './outline'
import { createPanelRefresh, type PanelRefreshSource } from './panel'

export interface OutlinePanelProps extends PanelRefreshSource {
  /** 点一行标题：把光标放到那个标题的起点。App 那边接的是 `gotoCommit({ kind: 'gotoPos' })` */
  onJump: (pos: number) => void
  onClose: () => void
}

/** 一个标签都没折叠过任何东西时用的那一份。共用一个空集合，别每次 `new Set()` */
const NO_FOLD: ReadonlySet<string> = new Set<string>()

export function OutlinePanel(props: OutlinePanelProps) {
  /** 当前这份文档的标题，按文档顺序。null = 压根没有可列的东西（分片／非 Markdown） */
  const [headings, setHeadings] = createSignal<readonly DocSymbol[] | null>(null)
  /** 面板顶上那句话。null = 没什么要说的 */
  const [note, setNote] = createSignal<string | null>(null)

  /**
   * 折叠状态**按标签存**：切走再切回来，收着的那几格还收着（VS Code 的既有行为）。
   * 只存一份的话，在 A 上收起两格、切到 B、切回来，A 的那两格自己弹开了——
   * 而用户没做过任何可以解释这件事的操作。
   *
   * 🔴 这一份**只有 `toggle` 会写**，重算的时候只读不写。理由很具体：`source` 与 `tabId`
   * 是两个独立的信号，真实链路里它们由 `showIn` 的 `batch` 同时改（所以 effect 只跑一次），
   * 但「只跑一次」是**调用方**的纪律，不是这一层能保证的。要是重算时把对账结果写回去，
   * 那么任何一次「view 已经换了、tabId 还没换」的中间态都会拿**新文档**的标题去对账
   * **旧标签**的折叠集合，把里面的键全判成失效清掉——用户收过的那一格于是自己弹开，
   * 而这一下没有任何日志。改成「对账是一次纯派生」（见下面 `folded`）之后，
   * 中间态最多让面板显示一份摊开的列表，一帧之后自己就对了，**存着的东西不会被毁掉**。
   *
   * ⚠️ 关掉一个标签不会把它的条目摘掉：这一层看不见标签列表。留下的是一份
   * 几十条字符串的 `Set`，量级上无所谓；真正要清就得让 App 把「哪个标签关了」递进来，
   * 为一个不会有人注意到的内存数字加一条接线不值当。
   */
  const [foldedByTab, setFoldedByTab] = createSignal<ReadonlyMap<number, ReadonlySet<string>>>(new Map())

  /**
   * 当前标签**当下有效**的那一份折叠集合。
   *
   * 对账（`pruneFold`）放在这个派生里而不是重算里，理由见上面那条 🔴。
   * 顺带的好处是它没有副作用：重算只写 `headings` 与 `note` 两个信号，
   * 不会在防抖回调里再触发一轮响应式更新。
   *
   * ⚠️ `headings()` 为 null 时**原样返回**，不对账：那一支说的是「这儿压根没有可列的东西」
   * （只读分片／非 Markdown），拿一份空清单去对账会把整个集合判成失效
   */
  const folded = createMemo<ReadonlySet<string>>(() => {
    const stored = foldedByTab().get(props.tabId()) ?? NO_FOLD
    const items = headings()
    return items === null ? stored : pruneFold(stored, items)
  })

  /**
   * 摊成扁平行。
   *
   * 依赖的是 `headings()` 与 `folded()`，**不是**「重算一次」这个动作：
   * 于是点一下折叠箭头只跑一遍 O(标题数) 的摊平，不会顺带再解析一次全文
   */
  const rows = createMemo<OutlineRow[]>(() => {
    const items = headings()
    return items === null ? [] : flattenOutline(items, folded())
  })

  let scrollEl: HTMLDivElement | undefined
  const [scrollTop, setScrollTop] = createSignal(0)
  /** jsdom 里 `clientHeight` 恒为 0，那时窗口给出 `OVERSCAN` 行——组件测试看到的正是头几行 */
  const [viewportHeight, setViewportHeight] = createSignal(0)

  const win = createMemo(() => visibleWindow(scrollTop(), viewportHeight(), rows().length, OUTLINE_ROW_HEIGHT))
  const visible = createMemo(() => rows().slice(win().start, win().end))

  // 「换文档立刻重算、改正文防抖」与卸载时取消在飞的那一次，全在 `./panel.ts` 里，
  // 与预览面板共用同一份——那条规矩的两个方向都错得很难看，见那个模块的文件头
  createPanelRefresh(props, recompute)

  /**
   * 重算一次。
   *
   * ⚠️ 两个 `untrack`：这个函数跑在防抖回调里，要的是「此刻」那份 state，
   * 而不是排队那一刻的那份。150ms 里用户可能又敲了几个字、甚至换了标签，
   * 追踪着读会把一份旧的算进来。
   *
   * ⚠️ 它**只写 `headings` 与 `note`**，不碰折叠集合——理由写在 `foldedByTab` 上
   */
  function recompute() {
    const src = untrack(() => props.source())
    if (src === null) {
      setHeadings(null)
      // 说「这块分屏」而不是「当前文档」：走到这一支的原因是聚焦那块分屏里**没有 CM6 实例**
      // （只读大文件分片，或者刚分出来还没来得及挂上），而文档是存在的。
      // 措辞与预览那一句同一个模子，两个面板并排开着的时候不该各说各话
      setNote('这块分屏里没有可列的标题')
      return
    }
    const table = symbolTable(src.view.state, src.path)
    if (table.kind === 'unsupported') {
      setHeadings(null)
      // 🔴 措辞与 `Cmd+R` 那一句**逐字相同**（`goto/store.ts:452`）。同一个事实两种说法的话，
      // 用户会以为浮层与面板答的是两个问题
      setNote(`${table.label} 还没有符号表`)
      return
    }
    setHeadings(table.items)
    setNote(table.items.length === 0 ? '这份文档还没有标题' : null)
  }

  function toggle(tabId: number, key: string) {
    setFoldedByTab((prev) => {
      const next = new Map(prev)
      next.set(tabId, toggleFold(prev.get(tabId) ?? NO_FOLD, key))
      return next
    })
  }

  function measure() {
    if (scrollEl) setViewportHeight(scrollEl.clientHeight)
  }

  onMount(() => {
    measure()
    // 不用 ResizeObserver：这一栏宽度固定、高度只跟着窗口走（与 `Sidebar.tsx` 同一条理由，
    // 而 jsdom 里没有 ResizeObserver）
    window.addEventListener('resize', measure)
  })
  onCleanup(() => window.removeEventListener('resize', measure))

  return (
    <section class="outline" aria-label="文档大纲" style={{ '--vela-outline-row-height': `${OUTLINE_ROW_HEIGHT}px` }}>
      <div class="outline-head">
        <span class="outline-title">大纲</span>
        <Show when={note()}>{(text) => <span class="outline-note">{text()}</span>}</Show>
        <button class="outline-close" onClick={() => props.onClose()} title="关闭大纲">
          ×
        </button>
      </div>

      <div class="outline-scroll" ref={scrollEl} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div class="outline-spacer" style={{ height: `${win().totalHeight}px` }}>
          <div class="outline-window" style={{ transform: `translateY(${win().offsetY}px)` }}>
            <For each={visible()}>
              {(row) => (
                <div class="outline-row" style={{ 'padding-left': `${row.depth * 12 + 4}px` }}>
                  {/* 没有子标题时留一个同宽的空位：不留的话同层的标题会因为
                      「有没有箭头」而错开一个字宽，而缩进本来是用来说层级的 */}
                  <Show when={row.hasChildren} fallback={<span class="outline-twisty" aria-hidden="true" />}>
                    <button
                      class="outline-twisty"
                      title={row.folded ? '展开' : '折叠'}
                      aria-label={`${row.folded ? '展开' : '折叠'}「${row.name}」`}
                      onClick={() => toggle(props.tabId(), row.key)}
                    >
                      {row.folded ? '▸' : '▾'}
                    </button>
                  </Show>
                  <button class="outline-name" title={row.name} onClick={() => props.onJump(row.pos)}>
                    {row.name}
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </section>
  )
}
