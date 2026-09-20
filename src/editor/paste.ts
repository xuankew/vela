import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * 剪贴板里的图片（M3-A-7，PLAN.md §3.5「图片粘贴自动落地」）。
 *
 * 这一层只做两件事：**从一次 paste 事件里挑出图片文件**、**把它交给宿主**。
 * 「落到哪个目录、叫什么名字、正文里插什么」全都不在这里——那是 `src/md/paste.ts`
 * 与 `vela-core::fs::asset` 的事，而这一层刻意不认识它们。
 *
 * ## 🔴 只有**粘贴**，没有拖放
 *
 * `EditorView.handleDrop` 刻意不接。理由不是偷懒：拖一个文件进编辑器，用户的意图
 * 有「把这张图插进来」也有「打开这个文件」两种，而 Vela 的拖放语义（`openAt`）
 * 已经是后者了。两种意图撞在同一个手势上，猜错的那一半是静默的。
 * 截图粘贴没有这个歧义——剪贴板里除了那张图什么都没有。
 *
 * ## ⚠️ 判断「是不是图片」只看 MIME 前缀，格式白名单在 Rust 侧
 *
 * 前端**不复制**那份白名单。复制一份的话，「Rust 收了但前端没接」与「前端接了但
 * Rust 拒了」两种不一致都会出现，而前一种的失败方式是**粘贴什么都没发生**——
 * 没有报错、没有提示、光标闪一下，用户完全不知道发生了什么。
 *
 * 于是这里放得很宽（`image/*` 全接），把判断整个交给 Rust 的魔数嗅探：
 * 一张 SVG 会被接住、被拒绝、然后**在通知里说清是为什么**（「SVG 是 XML，能带脚本」）。
 * 一句解释永远好过一次静默。
 */

/**
 * 挑出图片文件。返回 `null` 表示「这次粘贴里没有该接的图片」，CM6 会走默认路径。
 *
 * ## 🔴 剪贴板里**有正文**的时候一律不接
 *
 * 从网页上复制一段带插图的文字，剪贴板里同时有 `text/plain` 与一个图片文件。
 * 那时用户要的是文字。而如果我们把图接了，paste 处理器返回 true，CM6 就不再插
 * 那段文字了——用户的复制**凭空少了一半内容**，而且没有任何提示。
 *
 * 反过来（只接「没有正文」的粘贴）的失败方式是安全的：从 Finder 复制一个文件时
 * 有些系统会把路径也放进 `text/plain`，那次粘贴会退化成「插入一段路径文字」，
 * 内容是少了图，但一个字都没丢，而且看得见。
 */
export function pickPastedImage(data: DataTransfer | null): File | null {
  if (data === null) return null
  if (data.getData('text/plain') !== '') return null
  // `files` 是主路径：截图、以及从 Finder 复制的图片文件都在这里
  for (const file of Array.from(data.files)) {
    if (isImageMime(file.type)) return file
  }
  // `items` 是兜底：有些引擎在 paste 事件里只把文件挂在 items 上（`kind === 'file'`），
  // `files` 是空的。`getAsFile()` 可能返回 null——那一刻数据已经被取走了，没有第二次机会，
  // 所以这里只能放弃这次粘贴，让 CM6 走默认路径
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !isImageMime(item.type)) continue
    const file = item.getAsFile()
    if (file !== null) return file
  }
  return null
}

function isImageMime(type: string): boolean {
  return type.toLowerCase().startsWith('image/')
}

/**
 * 宿主对「剪贴板里有一张图片」的答复。
 *
 * 🔴 **必须同步返回**：`domEventHandlers` 的返回值决定 CM6 要不要 `preventDefault`
 * 并**跳过它自己那个 paste 处理器**，而那一刻之后的任何异步都来不及。
 * 返回 true 之后再去 `await file.arrayBuffer()` 是完全正常的——那时默认粘贴已经被拦下了，
 * 落地成功与否只影响「插不插那行链接」。
 *
 * 返回 false 表示「我不接」（比如这不是 Markdown 文档），CM6 继续走默认路径。
 */
export type PasteImageHook = (file: File, view: EditorView) => boolean

/**
 * 装上粘贴图片的拦截。宿主没给钩子时压根不装，CM6 的默认粘贴一点不受影响。
 *
 * ## ⚠️ 用的是 `domEventHandlers`，因为 `EditorView.handlePaste` **不存在**
 *
 * CM6 没有给 paste 单独开一个 facet（有 `clipboardInputFilter`，但那是改文本的，
 * 拿不到文件）。而 `domEventHandlers` 恰好够用，靠的是它的两条语义：
 *
 * 1. **插件提供的处理器排在 CM6 内置的那个之前**（`computeHandlers` 先遍历插件、
 *    后追加内置表），所以「返回 true」真的能拦下默认粘贴，不是拦完之后它又粘一遍；
 * 2. 返回 true 时 CM6 自己调 `event.preventDefault()` 并**停止**后续处理器。
 *
 * 这两条都是 `@codemirror/view@6.43.11` 的实现细节，不是文档承诺的契约。
 * 所以 `paste.test.ts` 里那组用例是**真的派发 DOM 事件**、然后看正文有没有被插入——
 * 哪天 CM6 改了顺序，那组用例会当场红，而不是等到用户的截图变成一串文件名
 */
export function imagePaste(onImage: PasteImageHook): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const file = pickPastedImage(event.clipboardData)
      if (file === null) return false
      return onImage(file, view)
    },
  })
}
