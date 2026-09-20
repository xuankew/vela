/**
 * Markdown 预览面板（M3-A-3）。挂在 `.body-row` 里，与 `.body`（编辑区）左右并排。
 *
 * ## 为什么不是「再开一块分屏」
 *
 * `ws.split()` 建的是**一个新的空标签**（一个标签只能显示在一块分屏里，见 `workspace.ts`
 * 文件头的不变量 2）。拿它装预览的话，那个空标签会出现在标签条上、能被关掉、能被切走，
 * 而它其实不是一个文档。所以预览走的是侧边栏那条路：一个独立的可见性 signal +
 * `.body-row` 里的一栏，`.body` 与它各占一半宽。
 *
 * ⚠️ 代价说清楚：**只有一个预览，跟着聚焦的那块分屏走**。分屏看两个文件时，
 * 预览显示的是聚焦那一个。要做「每块分屏一个预览」得先让分屏能装非文档内容，
 * 那是布局模型的事，不是这一层能顺手带出来的。
 *
 * ## 🔴 `innerHTML` 是**命令式**写的，不走 Solid 的响应式
 *
 * 三个理由，第一个是硬的：写完必须**立刻**量一遍每个 `data-line` 元素的位置，
 * 而同步滚动要用这份测量结果。走 `innerHTML={html()}` 的话，DOM 什么时候被改由 Solid 的
 * 调度决定，量早了拿到的还是上一份文档的坐标——症状是「改一个字，预览跳到别的地方」。
 * 第二个：这是一整块**外来的** HTML，让响应式系统去 diff 它没有任何好处。
 * 第三个：`EditorPane.tsx` 里那条「⛔ Solid 的响应式不许碰 CM6 的 DOM」是同一种纪律。
 *
 * ## 🔴 安全
 *
 * 这里写进 `innerHTML` 的每一个字节都出自 `./render.ts`，而那个模块的白名单与转义
 * 是整个预览的安全边界（`csp` 还是 `null`，webview 里 `__TAURI_INTERNALS__.invoke`
 * 对任何注入脚本都可见）。⛔ **不要在这里拼接任何额外的 HTML**，也不要为了「让它更好看」
 * 把某个字符串原样塞进去——要加东西就去 `render.ts` 加，那边有一整套用例看着。
 *
 * ## ⚠️ 这一块不再是纯只读的（M3-A-5）
 *
 * 点预览里的勾选框会把 `[ ]` ↔ `[x]` **写回源文档**：走的是一次普通编辑事务，
 * 所以它进撤销栈、会把文档标脏、跟着 ⌘S 落盘。它**只读 `render.ts` 早就写好的
 * `data-pos` / `data-checked` 两个属性**，一个字节的新 HTML 都不加，所以上面那条安全边界
 * 一点没动。
 *
 * ⛔ 但不要顺着这条先例再加别的「在预览里直接改正文」的入口：预览里没有光标、没有选区、
 * 也不画改动边界，用户在那儿做的编辑很难与他在编辑器里做的那些区分开。勾选框是唯一的例外，
 * 因为它的语义与文档位置是**一对一**的（一个 `data-pos` 就是那三个字符），
 * 而「点一下把这条打勾」在纯文本编辑器里做起来反而难得多
 *
 * ## ⚠️ 这里钉不住的东西
 *
 * 滚动跟得准不准、`data-line` 的插值在真实排版下偏多少、外链点下去 WKWebView 怎么反应、
 * 在预览里选中一段文字再回编辑器打字焦点在不在——jsdom 没有布局引擎
 * （`clientHeight` / `scrollHeight` 恒为 0，`scrollTop` 赋值是空操作），
 * 这些只能在看得到像素的地方判断。
 */

import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js'
import { createPanelRefresh, type FollowedEditor, type PanelRefreshSource } from './panel'
import { previewHtml } from './preview'
import { atBottom, collectAnchors, fractionalLine, topForLine, type LineAnchor } from './scrollSync'

export interface MarkdownPreviewProps extends PanelRefreshSource {
  onClose: () => void
}

/**
 * 一个 GFM 勾选框在源文档里占的那三个字符（`[ ]` / `[x]` / `[X]`）。
 * 回写前拿它核对 `data-pos` 还指不指得准，见 `toggleTask`
 */
const TASK_MARKER = /^\[[ xX]\]$/

export function MarkdownPreview(props: MarkdownPreviewProps) {
  /** 面板顶上那句话。null = 没什么要说的 */
  const [note, setNote] = createSignal<string | null>(null)

  let scrollEl: HTMLDivElement | undefined
  let bodyEl: HTMLDivElement | undefined
  /** 当前这份渲染结果的行号锚点。每次改 `bodyEl.innerHTML` 之后重量一遍 */
  let anchors: LineAnchor[] = []
  /** 上一次真的写进 DOM 的那份 HTML。null = 还没写过 */
  let rendered: string | null = null

  // 「换文档立刻渲染、改正文防抖」与卸载时取消在飞的那一次，全在 `./panel.ts` 里，
  // 与大纲面板共用同一份——那条规矩的两个方向都错得很难看，见那个模块的文件头。
  // ⚠️ 递整个 `props` 而不是拆成三个访问器，理由写在 `PanelRefreshSource` 上
  createPanelRefresh(props, render)

  /**
   * 算一遍、按需写 DOM、然后把预览滚到编辑器现在的位置。
   *
   * ⚠️ 它读 `props.source()` 是**不追踪**的：这个函数跑在防抖回调里，
   * 要的是「此刻」那份 state，而不是排队那一刻的那份。150ms 里用户可能又敲了几个字，
   * 追踪着读会渲染出一份旧的
   */
  function render() {
    if (bodyEl === undefined) return
    const src = untrack(() => props.source())
    const result = src === null ? null : previewHtml(src.view.state, src.path)

    let html = ''
    let text: string | null
    if (result === null) {
      // 说「这块分屏」而不是「当前文档」：走到这一支的原因是聚焦那块分屏里**没有 CM6 实例**
      // （只读大文件分片，或者刚分出来还没来得及挂上），而文档是存在的。说「没有文档」
      // 会让用户去看标签条——那儿明明有一个
      text = '这块分屏里没有可预览的正文'
    } else if (result.kind === 'unsupported') {
      // 措辞与 `Cmd+R` 那句「X 还没有符号表」同一个模子：都是如实说「这个语言没有」，
      // 而不是让用户去猜按钮是不是坏了
      text = `${result.label} 还没有预览`
    } else {
      html = result.html
      text = result.partial ? '文档太大，只预览了前面一部分' : html === '' ? '这份文档还是空的' : null
    }

    setNote(text)
    if (html !== rendered) {
      rendered = html
      bodyEl.innerHTML = html
      measure()
    }
    if (src !== null) follow(src)
  }

  /**
   * 量一遍每个 `data-line` 元素离内容顶部多远。
   *
   * 减掉的那个 `base` 把「视口坐标」换成「内容坐标」：`getBoundingClientRect` 给的是
   * 相对视口的，而预览此刻可能已经滚了一段。不减的话每次滚动之后重量都会得到一份
   * 整体偏移过的表，而症状是「滚得越多，同步越不准」
   */
  function measure() {
    if (scrollEl === undefined || bodyEl === undefined) {
      anchors = []
      return
    }
    const base = scrollEl.getBoundingClientRect().top - scrollEl.scrollTop
    anchors = collectAnchors(bodyEl, (el) => el.getBoundingClientRect().top - base)
  }

  /** 把预览滚到编辑器视口顶部对应的位置 */
  function follow(src: FollowedEditor) {
    if (scrollEl === undefined) return
    const el = src.view.scrollDOM
    // 到底了就直接到底：源文档最后一行往往只是预览的中间位置，按行号对齐会差出一屏
    if (atBottom(el.scrollTop, el.clientHeight, el.scrollHeight)) {
      scrollEl.scrollTop = scrollEl.scrollHeight
      return
    }
    const block = src.view.lineBlockAtHeight(el.scrollTop)
    const line = src.view.state.doc.lineAt(block.from).number
    scrollEl.scrollTop = topForLine(anchors, fractionalLine(line, block.top, block.height, el.scrollTop))
  }

  /**
   * 跟编辑器一起滚。
   *
   * `passive: true` 是必要的：这个回调里只写**预览**的 `scrollTop`，不 `preventDefault`，
   * 而不声明 passive 的话浏览器要等回调跑完才敢滚编辑器——一次 `querySelectorAll` 级别的
   * 工作量就够让滚动手感掉帧。M0 那一轮专门量过滚动，这里不给自己挖坑
   */
  createEffect(() => {
    const src = props.source()
    if (src === null) return
    const el = src.view.scrollDOM
    const onScroll = () => follow(src)
    el.addEventListener('scroll', onScroll, { passive: true })
    onCleanup(() => el.removeEventListener('scroll', onScroll))
  })

  /**
   * 窗口／分屏尺寸变了：锚点表里的像素全部作废，重量一遍再对齐一次。
   *
   * 不用 ResizeObserver：jsdom 里没有（与 `ShardPane` / `FindInFiles` 同一条理由），
   * 而这一栏的宽度只跟着窗口与分屏数走，`resize` 已经够
   */
  function onResize() {
    measure()
    const src = untrack(() => props.source())
    if (src !== null) follow(src)
  }

  onMount(() => window.addEventListener('resize', onResize))
  onCleanup(() => window.removeEventListener('resize', onResize))

  // ───────────────────────── 点勾选框回写源文档（M3-A-5）─────────────────────────

  /**
   * 这次点击／按键命中的那个勾选框；不是就 null。
   *
   * 挂在 `.md-preview-body` 上做**事件委托**，⛔ 不给每个勾选框各挂一个监听：
   * 那些元素是 `innerHTML` 一次性换掉的，挂上去的监听会随 DOM 一起消失，
   * 而重画之后谁负责重挂就没有一个地方说了。委托在容器上则天然跟着 `render()` 活
   */
  function taskBoxOf(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null
    return target.closest<HTMLElement>('.md-task[data-pos]')
  }

  /**
   * 把 `[ ]` ↔ `[x]` 写回源文档。
   *
   * 🔴 `data-pos` 是**渲染那一刻**的偏移，而预览有 150ms 防抖：这中间用户完全可能在
   * 待办事项前面又敲了一段，那个 pos 就指向别的字符了。所以回写之前必须核对
   * `[pos, pos+3)` 现在还是一个勾选框——不是就说明这份渲染结果过期了，此时
   * **丢掉这次点击**并立刻重画一遍。不核对的症状是「点一下勾选框，文档里另一个地方的
   * 三个字符被换成了 `[x]`」，那属于看着像随机损坏的一类 bug，而且撤销栈里还留着证据
   *
   * ⚠️ 走普通编辑事务：点勾选框**是**在改文档，所以它要进撤销栈、要标脏、要跟着 ⌘S 落盘。
   * `[ ]` 与 `[x]` 等长，于是全文偏移一个都不动——下面按同一个 `data-pos` 找回焦点靠的就是这一点
   */
  function toggleTask(box: HTMLElement) {
    const raw = box.dataset.pos
    const src = untrack(() => props.source())
    if (raw === undefined || src === null) return
    const pos = Number.parseInt(raw, 10)
    const state = src.view.state
    const fresh =
      Number.isInteger(pos) && pos >= 0 && pos + 3 <= state.doc.length && TASK_MARKER.test(state.sliceDoc(pos, pos + 3))
    if (!fresh) {
      render()
      return
    }
    const hadFocus = document.activeElement === box
    const checked = state.sliceDoc(pos + 1, pos + 2).toLowerCase() === 'x'
    src.view.dispatch({ changes: { from: pos, to: pos + 3, insert: checked ? '[ ]' : '[x]' } })
    // ⚠️ 立刻重画，而不是等那 150ms：等的话勾选框在点下去之后**看着没变**，用户会再点一次，
    // 而那一下是真的（它读的是已经改过的文档），于是一来一回等于没点
    render()
    // `render()` 换掉了整块 `innerHTML`，被点的那个元素已经不在文档里了。键盘用户
    // （`role="checkbox"` + `tabindex="0"`，见 `render.ts` 的 `taskMarker`）会把焦点掉到 body 上，
    // 于是「空格连打三个待办」变成「空格打一个，然后什么都没有了」
    if (hadFocus) bodyEl?.querySelector<HTMLElement>(`.md-task[data-pos="${pos}"]`)?.focus()
  }

  function onBodyClick(event: MouseEvent) {
    const box = taskBoxOf(event.target)
    if (box !== null) toggleTask(box)
  }

  function onBodyKeyDown(event: KeyboardEvent) {
    if (event.key !== ' ' && event.key !== 'Enter') return
    const box = taskBoxOf(event.target)
    if (box === null) return
    // 🔴 空格对一个 `tabindex` 元素的默认行为是**滚动页面**：不拦的话「打勾」与「滚一屏」
    // 同时发生，而滚完那一屏之后用户已经找不到刚才点的是哪一条了
    event.preventDefault()
    toggleTask(box)
  }

  return (
    <section class="md-preview" aria-label="Markdown 预览">
      <div class="md-preview-head">
        <span class="md-preview-title">预览</span>
        <Show when={note()}>{(text) => <span class="md-preview-note">{text()}</span>}</Show>
        <button class="md-preview-close" onClick={() => props.onClose()} title="关闭预览">
          ×
        </button>
      </div>
      {/* ⚠️ 这一层刻意**不可聚焦**（没有 tabindex）：点一下预览之后焦点会掉到 body 上，
          接着打字打进了空气里。真做成可聚焦的话就得回答「预览里能按哪些键」，
          而 v1 的答案是「除了勾选框上的空格与回车，一个都不能」。
          要选中预览里的文字复制是另一回事，那个不受影响 */}
      <div class="md-preview-scroll" ref={scrollEl}>
        <div class="md-preview-body" ref={bodyEl} onClick={onBodyClick} onKeyDown={onBodyKeyDown} />
      </div>
    </section>
  )
}
