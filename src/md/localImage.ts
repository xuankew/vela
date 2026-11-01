/**
 * 把预览里那些「本地图片占位」换成真的 `<img>`（PLAN.md §3.7 M7-9）。
 *
 * ## 为什么 `render.ts` 自己不出 `<img>`，要由这一层事后换
 *
 * 因为 URL 里必须带**当前文档的绝对路径**（`?doc=…`），而 `render.ts` 只管
 * 「一段正文 → 一块 HTML」，它压根不知道文档存在哪儿——那个路径在 `props.source().path` 上，
 * 属于组件层。把路径一路透传进渲染器要动 `renderMarkdown` 的签名，而那一层是整条预览
 * 安全边界的看守（见 `./render.ts` 文件头），为了一个它自己用不上的参数去改它的入口不值。
 *
 * ## 🔴 这里只用 DOM API 造元素，不拼 HTML 字符串
 *
 * `document.createElement` + 赋属性意味着**没有任何一段用户可控的文本会经过解析器**。
 * 换成 `span.outerHTML = '<img src="…"'` 的话，转义就变成这一层的责任，而 `./render.ts`
 * 那条「任何新增的输出都必须经过 escapeHtml 或 safeUrl」的规矩就得在这儿复刻一遍——
 * 两处规矩的地方就是两处会漏的地方。
 *
 * ## ⚠️ 为什么 `encodeURIComponent` 就够，不用自己的白名单
 *
 * 它不转义 `A-Za-z0-9-._!~*'()`，**其余全转**，其中包括 `&` `=` `?` `#` `/` `%`。
 * 于是正文里那个引用不可能伪造出第二个查询参数，也不可能逃出查询段。
 * Rust 那一边（`src-tauri/src/imgproto.rs`）解完码拿到的就是原样的字符串，
 * 归一化与「有没有跑出文档目录」全部由它判定。
 *
 * ## ⚠️ 加载失败要换回占位，而不是让图消失
 *
 * 这一层的产物只有两种可信结局：显示出来，或者回到 `render.ts` 那个带 `title=路径` 的占位。
 * 留一张裂图等于告诉用户「文件丢了」，而真实原因可能是它压根不在文档目录里（403）、
 * 太大（413）或者不是一种图片（415）——那些都只在 devtools 里看得到。
 * 占位那句 `title` 是他唯一的线索，所以它必须回来。
 */
import { LOCAL_IMAGE_CLASS } from './render'

/**
 * 协议名。另一半在 `src-tauri/src/imgproto.rs` 的 `SCHEME`。
 *
 * 🔴 两边拼不上的失败方式是「预览里每一张本地图都不显示」，而且一声不吭：
 * webview 对一个加载失败的 `<img>` 不报任何控制台错误。钉子是
 * `imgproto::tests::协议名与前端那份字符串对得上` 与本模块的黄金 URL 用例
 */
export const LOCAL_IMAGE_SCHEME = 'vela-img'

/**
 * 一条本地图片的 URL。
 *
 * `doc` 是**文档的绝对路径**，`ref` 是正文 `![](...)` 括号里那个**原样字符串**。
 * 两个都整段编码，所以 Rust 那边读出来的键只有这两个
 */
export function localImageUrl(docPath: string, ref: string): string {
  return `${LOCAL_IMAGE_SCHEME}://localhost/?doc=${encodeURIComponent(docPath)}&ref=${encodeURIComponent(ref)}`
}

/**
 * 把 `body` 里的本地图片占位换成 `<img>`，返回换掉了几张。
 *
 * ⚠️ `docPath` 为空（没目录，比如一个还没落盘的缓冲区）时**一张都不换**。
 * 不换不是偷懒：那种情况下 Rust 一定回 400，于是每张图都会走一遍
 * 「加载 → 失败 → 换回占位」，白闪一下还占一次请求
 *
 * 🔴 只认 `data-path`，不认 `src`：占位是 `<span>`，它身上那个 `data-path`
 * 是 `render.ts` 用 `escapeHtml` 写进去的原始引用，DOM 读出来时已经解好码
 */
export function rewriteLocalImages(body: Element, docPath: string | null): number {
  if (docPath === null || docPath === '') return 0
  const spans = body.querySelectorAll<HTMLElement>(`.${LOCAL_IMAGE_CLASS}[data-path]`)
  let count = 0
  spans.forEach((span) => {
    const ref = span.dataset.path
    if (ref === undefined || ref === '') return
    const img = document.createElement('img')
    img.src = localImageUrl(docPath, ref)
    // `alt` 与 `title` 从占位上原样搬过来：前者是用户写的替代文字，
    // 后者是那句「哪张图没出来」的路径——失败换回占位时要靠它重建 tooltip
    img.alt = span.textContent ?? ''
    img.title = span.title
    img.dataset.path = ref
    // 与 `render.ts` 给外链 `<img>` 的那一条一致：一篇贴图很多的笔记不该一次发几十个请求。
    // ⚠️ 用 `setAttribute` 而不是 `img.loading = …`，是为了让**写出去的那串字符**与读回来的
    // 那一个是同一个东西：用例断言的是 `getAttribute('loading')`，也就是真要交给网络栈的形式
    img.setAttribute('loading', 'lazy')
    span.replaceWith(img)
    count++
  })
  return count
}

/**
 * 一张加载失败的 `<img>` 换回占位；换回了返回 `true`。
 *
 * 由 `MarkdownPreview` 挂在 `.md-preview-body` 上的**捕获** `error` 监听调用：
 * `error` 与 `load` 都不冒泡，但都会走捕获相，所以容器上一个监听就够，
 * 不必给每张图各挂一个（那些元素每次重画都会被整体换掉）
 */
export function restorePlaceholder(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLImageElement)) return false
  const ref = target.dataset.path
  if (ref === undefined) return false
  const span = document.createElement('span')
  span.className = LOCAL_IMAGE_CLASS
  span.dataset.path = ref
  span.title = target.title
  span.textContent = target.alt === '' ? '图片' : target.alt
  target.replaceWith(span)
  return true
}
