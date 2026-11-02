/**
 * Markdown 预览面板（M3-A-3）。挂在 `.body-row` 里，与 `.body`（编辑区）左右并排。
 *
 * ## 为什么不是「再开一块分屏」
 *
 * 一块分屏显示的永远是**一个文档标签**（`ws.split()` 不给 tabId 时建一个新的空标签，
 * 给了就是把那个标签搬过去；一个标签只能显示在一块分屏里，见 `workspace.ts`
 * 文件头的不变量 2）。拿它装预览的话，那个标签会出现在标签条上、能被关掉、能被切走，
 * 而它其实不是一个文档。所以预览走的是侧边栏那条路：一个独立的可见性 signal +
 * `.body-row` 里的一栏，`.body` 与它各占一半宽（阅读模式那一档下它独占，见下面）。
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
 * ⚠️ M7-9 把那一条边界**擦得更清楚**而不是放宽了：本地图片换成的那个 `<img>` 是
 * `./localImage.ts` 用 `createElement` + 赋属性造出来的，一个 HTML 字符串都没拼，
 * 所以「谁负责转义」这件事仍然只由 `render.ts` 一处回答。
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
 * ## ⚠️ 点图看大图：这块面板上的第二个手势，但它一个字都不写（M7-11）
 *
 * 勾选框改正文，大图只读。它把**同一份 `src`** 交给一个全屏的 `<img>`，走的还是 M7-9
 * 那条 `vela-img` 校验，不新增任何图片来源。判断「这一次点击该不该弹」全在
 * `./imageActions.ts` 的 `zoomOf` 里（被链接包住的图归链接，占位 `span` 压根不是图），
 * 这一层只负责把命中的那一份记下来，并在**换文档**时把它关掉。
 *
 * 🔴 大图渲染在 `<section class="md-preview">` 里面，于是它跟着这一栏活：关预览、关标签、
 * 组件被换掉，遮罩一起没了。⛔ 别把它挪到 App 顶层「让它更稳」——那样每一处会关掉文档的
 * 地方都得负责关它，漏一处的症状是「屏幕上一张不属于当前文档的图」
 *
 * ⚠️ 键盘也能开：`markZoomableImages`（`./imageActions.ts`）给点得开的那一些图加 `tabindex`，
 * `onBodyKeyDown` 上的 Enter / 空格与鼠标那一下共用 `zoomOf` 与 `openZoom`。代价是明写的——
 * 一篇贴了二十张图的笔记多出二十次 `Tab`；换的是键盘用户此前**完全看不到图**。
 * 这一层依旧不给别的键：预览里能按的仍然只有勾选框与图片上的那两个
 *
 * ## ⚠️ 右键那张图：第三个手势，同样一个字都不写（M7-12）
 *
 * 一项菜单：本地图片是「复制路径」（正文 `![](...)` 里那串引用），外链图是「复制链接」。
 * 判据与大图共用 `./imageActions.ts`，但**不共用「在不在链接里」那一条**——右键不导航，
 * 没得抢，理由写在那儿。菜单本体是 `../project/TreeMenu.tsx`，四个宿主共用一份关闭路径。
 *
 * 🔴 为什么不用 webview 原生的那一份：它在图上给的是「拷贝图像地址」，而本地图片的地址是
 * `vela-img://…`——复制出去是一条**谁都打不开**的死链，粘进正文还能把文档弄坏。
 * 认不出来的那种图（`data:`、没有 `data-path` 的奇形怪状）**不调 `preventDefault`**，
 * 把原生的留给用户，比弹一份空的或全灰的诚实
 *
 * ⚠️ 这一层也不给「打开链接」「在 Finder 里显示」：前者点在图外面的链接文字上就能做，
 * 后者需要绝对路径，而绝对路径的归一化只有一个权威（见 `./imageActions.ts` 最后那一节）
 *
 * ## ⚠️ 阅读模式：这一栏可能是屏幕上唯一的一栏
 *
 * `previewMode.ts` 的 `only` 档把 `.body` 藏起来，于是这块面板吃掉整个正文区。
 * 这一层对此只做两件事，都不涉及布局：把标题从「预览」换成「阅读模式」（那是用户唯一能拿到的
 * 「我不在编辑态」的信号，因为 `Mod+F` 那类命令还在往看不见的编辑器上作用），
 * 以及在没有别的限定可说时补一句怎么退出。
 *
 * 🔴 真正会坏的是 `follow()`：编辑区 `display: none` 之后 `scrollDOM` 的几何量全是 0，
 * 而 `atBottom(0,0,0)` 恒为真，于是每一次重画都把预览甩到文末。守卫在那个函数里。
 *
 * ## ⚠️ 这里钉不住的东西
 *
 * 滚动跟得准不准、`data-line` 的插值在真实排版下偏多少、外链点下去 WKWebView 怎么反应、
 * 在预览里选中一段文字再回编辑器打字焦点在不在——jsdom 没有布局引擎
 * （`clientHeight` / `scrollHeight` 恒为 0，`scrollTop` 赋值是空操作），
 * 这些只能在看得到像素的地方判断。
 */

import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js'
import { writeClipboard } from '../editor/clipboard'
import { TreeMenu } from '../project/TreeMenu'
import { createPanelRefresh, type FollowedEditor, type PanelRefreshSource } from './panel'
import { copyTargetOf, markZoomableImages, zoomOf, type CopyTarget, type ZoomTarget } from './imageActions'
import { ImageLightbox } from './ImageLightbox'
import { restorePlaceholder, rewriteLocalImages } from './localImage'
import { resignAfterError, rewriteCloudImages } from './ossImage'
import { previewHtml } from './preview'
import { atBottom, collectAnchors, fractionalLine, topForLine, type LineAnchor } from './scrollSync'

export interface MarkdownPreviewProps extends PanelRefreshSource {
  onClose: () => void
  /**
   * 编辑区此刻是不是被藏起来了（`previewMode.ts` 的 `only` 档）。
   *
   * ⚠️ 这是宿主算好递进来的一个**结论**，不是那一档本身：宿主还要判断「这份文档到底有没有
   * 预览可看」，没有的话即使是 `only` 档也不会藏编辑器（判据在 App 的 `editorHidden()`）。
   * 做成必选而不是可选，就是为了不让「忘了传」与「确实没藏」共用同一个 `undefined`
   *
   * 🔴 这一层不认识 `PreviewMode`：它只回答「标题该写『预览』还是『阅读模式』」，
   * 以及要不要补一句怎么退出。藏编辑区是宿主的事（`.body.preview-only`），
   * 而**为什么必须藏而不能卸载**写在 `previewMode.ts` 的文件头
   */
  alone: () => boolean
}

/**
 * 一个 GFM 勾选框在源文档里占的那三个字符（`[ ]` / `[x]` / `[X]`）。
 * 回写前拿它核对 `data-pos` 还指不指得准，见 `toggleTask`
 */
const TASK_MARKER = /^\[[ xX]\]$/

export function MarkdownPreview(props: MarkdownPreviewProps) {
  /** 面板顶上那句话。null = 没什么要说的 */
  const [note, setNote] = createSignal<string | null>(null)

  /**
   * 云端图片签不出来时的那句话（M7-8）。null = 没什么要说的
   *
   * 它与 `note` 分开存，因为两者**可以同时成立**：一份「只预览了前面一部分」的长文档里
   * 也有一张没配上密钥的图。分开存才能让 `headNote` 那一句真话优先的排序说清楚谁先谁后，
   * 合成一个信号就要在写的时候决定丢哪一句
   *
   * 🔴 这一句是 Rust 的原话（`src-tauri/src/oss.rs` 的 `reason`），前端一个字都不改写。
   * 落点选头部那一行而不是 toast：预览每改一次正文就重问一次，toast 会被刷成一串
   */
  const [cloudNote, setCloudNote] = createSignal<string | null>(null)

  /**
   * 点开的那张大图，连同它属于**哪一份文档**（`path`；还没落盘的那份是空串）。
   *
   * 🔴 那个 `path` 不是装饰：大图是一块盖住整个正文区的遮罩，而切标签、切分屏都不会
   * 让这一层以外的任何东西重画。不带归属的话用户体验是「我换了文件，屏幕上还挂着
   * 上一份文档的一张图」——而那张图的 URL 在新文档里很可能指到另一个文件
   * （`assets/pasted-<哈希>.png` 不会撞，但 `img/logo.png` 这种名字两个目录里都可以有）。
   * 所以 `render()` 每次比一次，不是同一份文档就直接关
   */
  const [zoom, setZoom] = createSignal<{ target: ZoomTarget; path: string } | null>(null)

  /**
   * 右键一张图弹出来的那份菜单：复制什么、在哪儿弹、以及它属于**哪一份文档**。
   *
   * 这一份是**那一次右键的快照**，三个都得存着：坐标是当时光标的位置（菜单不能跟着重画飘），
   * `path` 用来在换文档时把它关掉——那份 DOM 已经整块没了，菜单还指着上一份文档的一张图。
   * ⛔ 不存 `TreeMenu` 自己算出来的 clamp 结果，那一个是它内部的事
   */
  const [imgMenu, setImgMenu] = createSignal<{ target: CopyTarget; x: number; y: number; path: string } | null>(null)

  const alone = () => props.alone()

  /**
   * 头部实际显示的那一句限定。
   *
   * **真话优先**：文档级的那一句（「只预览了前面一部分」「X 还没有预览」）比「怎么退出阅读模式」
   * 更该说——前者说的是他正在看的这份文档出了什么状况，后者随时能从 View 菜单里找到。
   * 所以阅读模式那句只在没有别的可说时才出现。
   *
   * ⚠️ 刻意不写键名：菜单里那一项是 `CmdOrCtrl+Shift+V`，写死「Cmd」在 Windows 上就是错的，
   * 而为了一个提示把 `commands/keybinding.ts` 拽进这个懒加载块也不划算（理由见 `./panel.ts`
   * 文件头那条「不要为了借一层包装去依赖别的层」）。所以这里说的是**菜单项的名字**
   */
  const headNote = () => note() ?? cloudNote() ?? (alone() ? '再按一次切换预览可回到编辑' : null)
  let scrollEl: HTMLDivElement | undefined
  let bodyEl: HTMLDivElement | undefined
  /** 当前这份渲染结果的行号锚点。每次改 `bodyEl.innerHTML` 之后重量一遍 */
  let anchors: LineAnchor[] = []
  /** 上一次真的写进 DOM 的那份 HTML。null = 还没写过 */
  let rendered: string | null = null
  /**
   * 第几次重画。云端图片那一次签名是**异步**回来的，而防抖窗口里可能已经又画了一次
   *
   * 🔴 回调里比一次号，是因为过期那一次写回来的不只是「一句已经不该存在的话」，
   * 还有**上一份文档里那张图的签名地址**——DOM 元素早被 `innerHTML` 换掉了，
   * 而那一句限定会一直挂到下一次重画。`onCleanup` 里也加一，是为了让卸载后回来的那一次同样作废
   */
  let paintSeq = 0

  // 「换文档立刻渲染、改正文防抖」与卸载时取消在飞的那一次，全在 `./panel.ts` 里，
  // 与大纲面板共用同一份——那条规矩的两个方向都错得很难看，见那个模块的文件头。
  // ⚠️ 递整个 `props` 而不是拆成三个访问器，理由写在 `PanelRefreshSource` 上
  createPanelRefresh(props, render)

  /**
   * 大图认的那份「文档身份」：这份文档的绝对路径，没落盘的缓冲区是空串。
   *
   * 用路径而不是标签 id，是因为 `props.source()` 递过来的就只有这一份可比的标量；而它的
   * 目的只是「换了一份就关」，两个未落盘的草稿共用一个空串不算错——那种文档里压根没有
   * 本地图片（`localImage.ts` 对 `path: null` 一张都不换）。
   *
   * 🔴 这一句是 `render()` 与点击处**共用**的：两处各写一遍 `?? ''` 迟早一边算成空串、
   * 另一边算成 `undefined`，于是「换文档就关」会安静地失效
   */
  function pathOf(src: FollowedEditor | null): string {
    return src?.path ?? ''
  }

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

    // M7-11：不是同一份文档了就把大图关掉。⚠️ `untrack` 不是防循环，是防「点开大图」
    // 这一次 `setZoom` 反过来把整个重画流程再触发一遍（见 `./panel.ts` 那份调度）
    // M7-12 同一句管着右键菜单：它指着的是**上一份文档里的一张图**，那份 DOM 已经被
    // `innerHTML` 整块换掉了。⚠️ 不能只靠 `TreeMenu` 自己那条「宿主滚动就关」——
    // 真实窗口里 `follow()` 会滚，但没到文末的那次换文档可能一像素都不动
    const open = untrack(zoom)
    if (open !== null && open.path !== pathOf(src)) setZoom(null)
    const menu = untrack(imgMenu)
    if (menu !== null && menu.path !== pathOf(src)) setImgMenu(null)

    setNote(text)
    if (html !== rendered) {
      rendered = html
      bodyEl.innerHTML = html
      // M7-9：`render.ts` 给本地图片出的是占位 `span`，这里换成走 `vela-img` 协议的 `<img>`。
      // ⚠️ 必须在 `measure()` **之前**换：那一张表量的是每个 `data-line` 元素离内容顶部多远，
      // 换在之后就会量出一份没有算进图片那部分高度的表
      rewriteLocalImages(bodyEl, src?.path ?? null)
      // M7-11 欠账一：把点得开大图的那一些图标成键盘也停得下来。⚠️ 必须在
      // `rewriteLocalImages` **之后**——本地图片在那一步之前还是占位 `span`，早一步扫一张都扫不到。
      // 判据是 `zoomOf` 本身，所以「能 Tab 停下来的」与「点得开的」是同一批图（见 `./imageActions.ts`）
      markZoomableImages(bodyEl)
      measure()
    }
    // M7-8：用户自己 bucket 里那几张图的 `src` 换成 15 分钟的临时签名地址。
    //
    // 🔴 这一层是那句「不许拼 HTML」的**有界例外**，而界就在 `./ossImage.ts` 的文件头里：
    // `render.ts` 出来的 HTML 一个字不改，只动 `img.src` 这一个 DOM 属性（外加对位用的
    // `data-oss-src`）。⛔ 签名地址不许往 `html` 那一步走，也⛔不许写进 `props.source()`
    // 那一份正文——它是一份有有效期的读取凭证，正文会跟着文档同步、备份、被贴到别处
    //
    // ⚠️ 放在 `if` **外面**，而且每次重画都问一次：缓存命中时它是一个纯同步的属性赋值，
    // 不发请求。放里面会漏掉「HTML 没变但签名过期了」那一种（一份挂着不动的长文档，
    // 十几分钟后往下滚），而那一种的形态是裂图
    const seq = ++paintSeq
    void rewriteCloudImages(bodyEl).then((cloud) => {
      // 过期那一次重画的结果连一句话都不该写回来，理由见 `paintSeq` 那一条
      if (seq === paintSeq) setCloudNote(cloud)
    })
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
    // 🔴 源编辑器**没有布局**时不同步：阅读模式（`previewMode.ts` 的 `only` 档）把 `.body`
    // 整个 `display: none` 掉了，于是这三个几何量全是 0，而 `atBottom(0, 0, 0)` 恒为真
    // （`./scrollSync.ts:145`）——不拦的话每一次防抖重画都会走「直接到底」那一支，
    // 症状是「阅读模式里预览永远停在文末」。
    // ⚠️ 这道守卫不是为阅读模式特设的：任何「面板活着而源还没排版」的瞬时态都该走它，
    // 而同步滚动是单向的（见 `./scrollSync.ts` 文件头），少同步一次的代价只是不动，
    // 按一份退化的几何去对齐的代价是把用户正在读的地方甩走
    if (el.clientHeight === 0) return
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
    relayout()
  }

  /**
   * 图片是**异步**到位的：它一落地，刚才那份锚点表就整体偏移了——占位 `span` 只有一行字高，
   * 而一张图可能是半屏。所以每次加载完成都重量一遍再对齐一次。
   *
   * ⚠️ 监听挂在容器上、走**捕获相**：`load` 与 `error` 都不冒泡，但都会经过捕获路径，
   * 于是容器上一个监听就够。不给每张 `<img>` 各挂一个的理由与勾选框那条一样——
   * 那些元素每次重画都会被整体换掉，挂上去的没人负责重挂
   */
  function relayout() {
    measure()
    const src = untrack(() => props.source())
    if (src !== null) follow(src)
  }

  function onImgError(event: Event) {
    // 换回占位（那张裂图会让用户以为文件丢了，而原因可能只是它不在文档目录里），
    // 换成了才算数：不是本地图的 `error` 不触发重量
    if (restorePlaceholder(event.target)) {
      relayout()
      return
    }
    // M7-8：云端那张失败通常是签名过期（`loading="lazy"` 的图可能十几分钟后才发请求）。
    // 重签一次，每个元素只有一次，上限在 `resignAfterError` 里
    const img = event.target
    if (img instanceof HTMLImageElement) {
      void resignAfterError(img).then((retried) => {
        if (retried) relayout()
      })
    }
  }

  onMount(() => {
    bodyEl?.addEventListener('load', relayout, true)
    bodyEl?.addEventListener('error', onImgError, true)
    window.addEventListener('resize', onResize)
  })
  onCleanup(() => {
    // 让任何还在飞的签名结果作废：DOM 马上就没有了，而那次 `.then` 里只有一个信号写
    paintSeq++
    bodyEl?.removeEventListener('load', relayout, true)
    bodyEl?.removeEventListener('error', onImgError, true)
    window.removeEventListener('resize', onResize)
  })

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

  /**
   * 把命中的那一张记下来，`<Show keyed>` 于是挂载一块大图。
   *
   * ⚠️ 鼠标与键盘走的是同一个函数：那一份 `path`（归属，见 `zoom` 那条）漏掉一处的症状是
   * 「换了文件，屏幕上还挂着上一份文档的一张图」
   */
  function openZoom(target: ZoomTarget) {
    setZoom({ target, path: pathOf(untrack(() => props.source())) })
  }

  function onBodyClick(event: MouseEvent) {
    const box = taskBoxOf(event.target)
    if (box !== null) {
      toggleTask(box)
      return
    }
    // M7-11：点一张已经显示出来的图 → 看大图。判断「该不该弹」全在 `zoomOf` 里
    // （被链接包住的图归链接、占位 `span` 不算图），这里只管把命中的那一份记下来
    const target = zoomOf(event.target)
    if (target !== null) openZoom(target)
  }

  /**
   * 右键一张图 → 那份只有一项的菜单（M7-12）。
   *
   * 🔴 认不出来的那张图**不调 `preventDefault`**：`copyTargetOf` 返回 null 意味着
   * 「这一层不知道该复制什么」，那就把 webview 自己的那份菜单留给用户，而不是弹一份空的或全灰的。
   * 与 `App.tsx` 那条「只读大文件分片不接编辑器菜单，留原生的比弹一份全灰的好」同一条判断
   *
   * ⚠️ 挂在 `.md-preview` 这一层而不是 `.md-preview-body`：大图（`ImageLightbox`）是这一栏的
   * 子节点，右键它靠冒泡走到同一个处理里，用户不需要知道那两个是两层
   */
  function onImageContextMenu(event: MouseEvent) {
    const target = copyTargetOf(event.target)
    if (target === null) return
    event.preventDefault()
    setImgMenu({ target, x: event.clientX, y: event.clientY, path: pathOf(untrack(() => props.source())) })
  }

  /**
   * 复制那一路。成功**不说话**：文件树那条「复制路径」也是这个口径（`rootTree.ts` 的
   * `copyPath` 成功返回 `null`），而剪贴板里的东西用户自己 ⌘V 就能验，多一行提示只会让那一栏变响。
   *
   * 🔴 失败必须说：`navigator.clipboard` 在非安全上下文里直接抛，症状是「点了没反应」。
   * 头部那一行本来就是警告色，正好用它
   */
  function copyImageTarget(text: string) {
    void writeClipboard(text).then((ok) => {
      if (!ok) setNote('复制不了——拿不到系统剪贴板')
    })
  }

  function onBodyKeyDown(event: KeyboardEvent) {
    if (event.key !== ' ' && event.key !== 'Enter') return
    const box = taskBoxOf(event.target)
    if (box !== null) {
      // 🔴 空格对一个 `tabindex` 元素的默认行为是**滚动页面**：不拦的话「打勾」与「滚一屏」
      // 同时发生，而滚完那一屏之后用户已经找不到刚才点的是哪一条了
      event.preventDefault()
      toggleTask(box)
      return
    }
    // M7-11 欠账一：键盘走到一张图上按 Enter / 空格 → 看大图，与鼠标那一下同一个判据、
    // 同一个函数。⛔ 别在这儿重写一遍「在不在链接里」：链接里的图压根没有 `tabindex`
    // （`markZoomableImages` 用的就是 `zoomOf`），于是 `zoomOf` 在这儿也一定回 null——
    // 那一次按键什么都不做，链接自己的 Enter 由 webview 处理
    const target = zoomOf(event.target)
    if (target === null) return
    // 与上面那一条同一个理由：空格不拦就滚一屏，而大图正好盖在那一屏上面
    event.preventDefault()
    openZoom(target)
  }

  return (
    <section class="md-preview" aria-label="Markdown 预览" onContextMenu={onImageContextMenu}>
      <div class="md-preview-head">
        {/* 「阅读模式」而不只是「预览」：这一档下编辑区被藏起来了，而 `Mod+F` 那类命令
            还在往那块看不见的编辑器上作用。标题是用户唯一能拿到的「我不在编辑态」的信号，
            所以它必须换一个字，而不是只把提示塞进右边那句限定里 */}
        <span class="md-preview-title">{alone() ? '阅读模式' : '预览'}</span>
        {/* ⚠️ `hint` 那一档是「怎么退出阅读模式」那一种**可有可无**的话，浅一号。
            M7-8 那句「云端图片签不出来」不是：它说的是用户正在看的这份文档有点事没成，
            与文档级的那几句同一档——所以判据是「两个真话都没说」，不是「`note` 是空」 */}
        <Show when={headNote()}>
          {(text) => (
            <span class="md-preview-note" classList={{ hint: note() === null && cloudNote() === null }}>
              {text()}
            </span>
          )}
        </Show>
        <button class="md-preview-close" onClick={() => props.onClose()} title="关闭预览">
          ×
        </button>
      </div>
      {/* ⚠️ 这一层刻意**不可聚焦**（没有 tabindex）：点一下预览之后焦点会掉到 body 上，
          接着打字打进了空气里。真做成可聚焦的话就得回答「预览里能按哪些键」，
          而这一栏的答案是「只有勾选框与图片上的空格与回车」——那两处的 `tabindex`
          是给具体控件的（勾选框见 `render.ts` 的 `taskMarker`，图片见 `markZoomableImages`），
          不是给这一层的。要选中预览里的文字复制是另一回事，那个不受影响 */}
      <div class="md-preview-scroll" ref={scrollEl}>
        <div class="md-preview-body" ref={bodyEl} onClick={onBodyClick} onKeyDown={onBodyKeyDown} />
      </div>
      {/* M7-11：大图。渲染在这一栏里面（`.md-preview` 带 `overflow: hidden`，但那一条裁不到它——
          `position: fixed` 的包含块是视口，只有带 transform / filter / contain 的祖先才会改写
          包含块，这一条链上没有：见 `src/styles.css` 那一段与 M4-P 那条 `z-index: 0`）。
          做成这样而不是 Portal 的理由与 `.modal-backdrop` 一样：它跟着这一栏活——
          关预览、关标签、组件被换掉，大图一起没了，没有一个地方需要负责去「顺手关掉它」。
          ⚠️ `keyed` 是为了让「一次打开 = 一次挂载」这件事由结构保证：`ImageLightbox` 在挂载
          那一刻记下「该把焦点还给谁」，而那张图没到位时才会亮出红色那句——两张不同的图之间
          不换节点的话，这两份状态都会跟着上一张图 */}
      <Show when={zoom()} keyed>
        {(open) => <ImageLightbox target={open.target} onClose={() => setZoom(null)} />}
      </Show>
      {/* M7-12：右键那张图的那一项菜单。宿主用 `../project/TreeMenu.tsx`（第四个宿主），
          四条关闭路径与贴边 clamp 都在那一层，⛔ 这里不再自己写一份。
          ⚠️ 一项菜单看着多余，但**不用 webview 原生的那一份**是有理由的：它在图上给的是
          「拷贝图像地址」，而本地图片的地址是 `vela-img://…`——复制出去是一条谁都打不开的死链
          （`./imageActions.ts` 那条红字）。`z-index` 10 也正好盖住上面那张遮罩（9）
          ⚠️ `keyed`：一次右键 = 一次挂载，菜单项的文字与坐标都由那一次右键决定，
          不会出现「内容换成了另一张图的，位置还留在上一个光标上」 */}
      <Show when={imgMenu()} keyed>
        {(menu) => (
          <TreeMenu
            x={menu.x}
            y={menu.y}
            items={[{ action: 'copy', label: menu.target.label }]}
            onPick={() => copyImageTarget(menu.target.text)}
            onClose={() => setImgMenu(null)}
            keepFocus
          />
        )}
      </Show>
    </section>
  )
}
