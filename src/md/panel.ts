/**
 * 两个 Markdown 面板（预览 M3-A-3、大纲 M3-A-4）**共用的那一半**：
 * 跟着哪一块编辑器、什么时候重算、以及一个可注入的定时器。
 *
 * ## 为什么值得抽出来
 *
 * 不是「代码重复了」这么抽象。那个 effect 里藏着一条很容易写错的规矩：
 * **换文档要立刻重算，改正文要防抖**。写反的两个方向都难看，而且都不是报错：
 *
 * - 全都立刻 → 打字时每个键都重解析一遍全文，而中间那些状态没人看得见，纯浪费；
 * - 全都防抖 → 切了标签，旁边那块面板还显示着**上一份**文档。这一下用户是看得见的
 *   （他刚刚点了另一个标签），所以他会认为面板坏了。
 *
 * 两处各写一遍的话，迟早有一处只改对一半。
 *
 * ⛔ 这一层不认识 `./render.ts` 也不认识 `../goto/symbols.ts`：它只决定「什么时候叫 `run`」，
 * 叫到了算出什么由两个面板各自负责。
 */

import { createEffect, onCleanup } from 'solid-js'
import type { EditorView } from '@codemirror/view'
import { createDebounced, domTimer } from '../ui/timer'

/**
 * 面板此刻要跟着走的那一块编辑器。
 *
 * 带 `view` 而不只带 `state`：预览的同步滚动要读 `scrollDOM` 的几何与 `lineBlockAtHeight`，
 * 那两个都只在 view 上。⚠️ 这一层自己**只读不写**它——单向同步的理由见 `./scrollSync.ts`
 * 文件头（单向在结构上不可能有反馈回路），大纲更是连滚动都不碰。
 * 唯一的写入者是预览里那个勾选框（M3-A-5 的 `toggleTask`）：它是**用户点出来的**一次编辑，
 * 不是面板自己对文档做的事，边界写在 `MarkdownPreview.tsx` 的文件头
 */
export interface FollowedEditor {
  readonly view: EditorView
  /** 用来判语言。null = 未命名文档，按 Markdown 处理（`editor/language.ts` 那条默认值） */
  readonly path: string | null
}

/**
 * 重算的防抖窗口（毫秒）。
 *
 * 它只在用户**停下来之后**跑一次：每个键都重算的话，一份几千行的文档会让每一次按键
 * 都背上一次全量解析 + 全量重建，而这活儿是白做的——中间那些状态没人看得见。
 * 150ms 大约是「一句话打完的间隔」，比它长会让人觉得面板跟不上手，比它短就挡不住连打。
 *
 * ⚠️ 两个面板共用这一个数，而它们各自的**解析**预算是分开的（`PREVIEW_PARSE_TIMEOUT_MS`
 * 200ms / `SYMBOL_PARSE_TIMEOUT_MS` 50ms）。防抖窗口共用是对的：它答的是「用户停下来多久」，
 * 与算多重没关系；解析预算分开也是对的：`Cmd+R` 那个跑在按键处理里，这一个不是。
 *
 * ⚠️ 防抖器**本身**（`createDebounced` / `Timer` / `domTimer`）住在 `src/ui/timer.ts`，
 * 这里只留下那个 150：工具箱（`tools/store.ts`）也要一个防抖器，而它不该为了借一层
 * `setTimeout` 包装去依赖 Markdown 这一层——M3-C 把 `md/*` 圈进懒加载块时，
 * 那条 import 还会把它拽回首屏
 */
export const PANEL_DEBOUNCE_MS = 150

/**
 * 一个面板要跟着走的那三样东西。
 *
 * 两个面板的 `props` 都**长这样**（各自再带上自己的 `onClose` / `onJump`），
 * 所以调用点是 `createPanelRefresh(props, run)`——整个 `props` 递进来，而不是把三个访问器
 * 拆出来递。拆开的话每一次访问都发生在**组件函数体**里，而 `solid/reactivity` 那条规则
 * 只认「JSX 里／被追踪的作用域里／事件处理里」，于是它会在两个面板上各报三条警告。
 * 递整个 `props` 才是诚实的：真正读那三个访问器的地方是下面 `createEffect` 的回调里
 */
export interface PanelRefreshSource {
  /** 聚焦那块分屏的编辑器实例。只读分片／还没有实例时是 null */
  source: () => FollowedEditor | null
  /** `workspace.revision`：正文变更计数。⚠️ 不能换成 `metrics`，理由写在 `workspace.ts` 那儿 */
  revision: () => number
  /** 当前标签的 id。换标签必须**立刻**重算，不等防抖 */
  tabId: () => number
}

/**
 * 建一条「什么时候重算」的 effect。**必须在一个组件（或 `createRoot`）里调**：
 * 它用 `createEffect` 订阅那三个访问器，用 `onCleanup` 取消在飞的防抖。
 *
 * `onCleanup` 那一条不是可有可无的收尾：不取消的话，面板关掉 150ms 之后回调照样跑，
 * 而那时组件已经 dispose、它持有的 DOM 引用指向一个从文档上摘下来的节点。
 * 写进去不报错，只是白写；真正难看的是它顺带 `setNote`，往一个没人看的 signal 里推值。
 */
export function createPanelRefresh(source: PanelRefreshSource, run: () => void): void {
  const debounced = createDebounced(domTimer, PANEL_DEBOUNCE_MS, run)
  onCleanup(debounced.cancel)

  let lastView: EditorView | null = null
  let lastTabId: number | null = null
  createEffect(() => {
    const src = source.source()
    const tabId = source.tabId()
    // 读了不用：订阅的就是「正文变了」这件事本身
    source.revision()
    const view = src?.view ?? null
    // 🔴 判据是**实例**与**标签 id**，不是内容：`showIn` 走 `capture` + `restore`，
    // 同一块分屏换标签时 view 是同一个实例，所以少了 `tabId` 这一半就永远走不到 `now()`
    const immediate = view !== lastView || tabId !== lastTabId
    lastView = view
    lastTabId = tabId
    if (immediate) debounced.now()
    else debounced.schedule()
  })
}
