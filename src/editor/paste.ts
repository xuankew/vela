import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * 剪贴板里的图片（M3-A-7，PLAN.md §3.5「图片粘贴自动落地」；M7-13 起多一条兜底）。
 *
 * 这一层只做三件事：**从一次 paste 事件里挑出图片文件**、**挑不出来时判断剪贴板里
 * 到底有没有图**（有就走异步兜底）、**把它交给宿主**。「落到哪个目录、叫什么名字、
 * 正文里插什么」全都不在这里——那是 `src/md/paste.ts` 与 `vela-core::fs::asset` 的事，
 * 而这一层刻意不认识它们。
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
 *
 * ## 🔴 有一条路是「引擎压根没把图交给我们」（M7-13）
 *
 * 2026-11-02 用户在真机上粘一张 macOS 截图（剪贴板里九种图像 flavor、**零个文本 flavor**，
 * 用 `osascript -e 'clipboard info'` 当场读出来的），结果是**完全静默**：正文没多一行、
 * `assets/` 没建、提示条一个字都没有。逐条排除之后只剩下一个可能——
 * `pickPastedImage` 一个文件都没拿到，于是钩子回 `false`、CM6 走默认粘贴，
 * 而剪贴板里只有图，默认粘贴什么都插不进去。这正是上面那条「静默」的最坏实例。
 *
 * ⚠️ **jsdom 钉不住这一条**：`paste.test.ts` 里那个 `transfer()` 是手造的假 `DataTransfer`，
 * 它只能验「给了 files/items 时我们挑不挑得出来」，验不了「真引擎给不给」。所以这一支
 * 在测试里全部靠注入（`readClipboardImage` 收一个 reader），真机行为仍然只能真机看。
 *
 * 于是这一层多认一种归宿：**`files` 与 `items` 都空、但 `types` 里有 `image/*` 或 `Files`**
 * ⇒ 剪贴板里确实有一张图，只是这个引擎没把它包成 `File`。那一刻钩子仍然回 `true`
 * （拦下默认粘贴，反正它也插不出东西），但递过去的是 `null` + 原始 `types`，
 * 由宿主改走 `navigator.clipboard.read()` 再读一次；再读不到就**说一句话**，
 * 那句话里带着 `types` 原文——它是「WebKit 到底交成了什么形状」唯一的取证入口。
 */

/**
 * 这一层真正会用到的 `DataTransfer` 成员，⚠️ 四个全是**可选**的。
 *
 * 🔴 这不是洁癖：paste 事件递过来的对象由引擎造，而「某个成员在某个引擎上是 undefined」
 * 正是本轮要查的那一类事。`Array.from(undefined)` 抛 `TypeError`，而它抛在 CM6 的
 * DOM 处理器里会被 CM6 吞掉（它给 handler 包了 try/catch），用户看到的又是「什么都没发生」。
 * 收成结构化类型之后，测试里那个假对象也不再需要 `as unknown as DataTransfer` 双重转换
 */
export interface PasteData {
  getData(format: string): string
  readonly files?: FileList
  readonly items?: DataTransferItemList
  readonly types?: readonly string[]
}

/** 把「可能不存在的 ArrayLike」摊成数组。引擎少给一个成员时得到空数组，而不是一次抛 */
function listOf<T>(value: ArrayLike<T> | undefined): T[] {
  return value === undefined ? [] : Array.from(value)
}

/**
 * 挑出图片文件。返回 `null` 表示「这次粘贴里没有该接的图片」，CM6 会走默认路径。
 *
 * ⚠️ `null` 现在有两种含义，宿主要靠 [`clipboardHoldsAnImage`] 分辨：
 * 「本来就只有文字」（该走默认粘贴）与「有图但引擎没交出来」（该走异步兜底）。
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
export function pickPastedImage(data: PasteData | null): File | null {
  if (data === null) return null
  if (data.getData('text/plain') !== '') return null
  // `files` 是主路径：截图、以及从 Finder 复制的图片文件都在这里
  for (const file of listOf(data.files)) {
    if (isImageMime(file.type)) return file
  }
  // `items` 是兜底：有些引擎在 paste 事件里只把文件挂在 items 上（`kind === 'file'`），
  // `files` 是空的。`getAsFile()` 可能返回 null——那一刻数据已经被取走了，没有第二次机会，
  // 所以这里只能放弃这次粘贴，让 CM6 走默认路径
  for (const item of listOf(data.items)) {
    if (item.kind !== 'file' || !isImageMime(item.type)) continue
    const file = item.getAsFile()
    if (file !== null) return file
  }
  return null
}

/**
 * 剪贴板里**声称**有一张图片，而 [`pickPastedImage`] 一个文件都没挑出来。
 *
 * `types` 是引擎报的类型清单，截图那一份在 WebKit 上应该是 `image/png` 一类；
 * `'Files'` 也认，那是「有文件项、但 `files`/`items` 没给出来」的另一种形状。
 *
 * 🔴 **调用方必须先确认 `text/plain` 是空的**（`pickPastedImage` 返回 `null` 有两种原因，
 * 这一条分不出来）：有正文时用户的意图是文字，那一次粘贴**必须**原样交给 CM6，
 * 这是上面那条 🔴 规则，⛔ 不要为了「多接一张图」把它绕过。
 */
export function clipboardHoldsAnImage(data: PasteData): boolean {
  return listOf(data.types).some((type) => {
    const lower = type.toLowerCase()
    return lower.startsWith('image/') || lower === 'files'
  })
}

/** 我们用到的 `ClipboardItem` 那两个成员。⚠️ 不引全局 `ClipboardItem` 类型：node 里没有它 */
interface ClipboardItemLike {
  readonly types: readonly string[]
  getType(type: string): Promise<Blob>
}

/** 从 `navigator.clipboard` 上取那个读取器。取不到就是 `undefined`（这个 webview 没开放） */
function clipboardReader(): (() => Promise<readonly ClipboardItemLike[]>) | undefined {
  const clipboard = globalThis.navigator?.clipboard as
    { read?: () => Promise<readonly ClipboardItemLike[]> } | undefined
  const read = clipboard?.read
  return read === undefined ? undefined : read.bind(clipboard)
}

export type ClipboardImageRead =
  | { kind: 'file'; file: File }
  /** 读成功了，但剪贴板里没有一项是图 */
  | { kind: 'no_image' }
  /** 读不了：这个 webview 没开放这个 API，或者开放了但拒绝了（`NotAllowedError`） */
  | { kind: 'unavailable'; reason: string }

/**
 * 绕开 paste 事件，直接向系统剪贴板要那张图（M7-13 的兜底）。
 *
 * 🔴 **只能在一次真实的 paste 手势里调**：`navigator.clipboard.read()` 在 WebKit 上
 * 要用户授权，脱离了手势就是 `NotAllowedError`。调用点在 `App.tsx` 的 paste 钩子里，
 * ⛔ 不要把它接到命令面板或任何异步延迟之后。
 *
 * @param read 注入点。缺省读 `navigator.clipboard`；测试里传一个假的，
 *   因为 jsdom 既没有 `navigator.clipboard`，也没有真的系统剪贴板
 */
export async function readClipboardImage(
  read: (() => Promise<readonly ClipboardItemLike[]>) | undefined = clipboardReader(),
): Promise<ClipboardImageRead> {
  if (read === undefined) {
    return { kind: 'unavailable', reason: '这个 webview 没有开放 navigator.clipboard.read()' }
  }
  let items: readonly ClipboardItemLike[]
  try {
    items = await read()
  } catch (err) {
    // 常见的是 `NotAllowedError`（授权被拒）。原文照抄进 reason：它是英文的，
    // 但它是「为什么读不到」唯一的线索，⛔ 不要翻译成一句更含糊的中文
    const name = err instanceof Error && err.name !== 'Error' ? `${err.name} ` : ''
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'unavailable', reason: `${name}${message}`.trim() }
  }
  for (const item of items) {
    const type = listOf(item.types).find((candidate) => isImageMime(candidate))
    if (type === undefined) continue
    try {
      const blob = await item.getType(type)
      // ⚠️ 名字与 MIME 都是装饰性的：`landPastedImage` 只用 `size` 与 `arrayBuffer()`，
      // 落地名由 Rust 按**内容哈希**生成、格式由 Rust **嗅魔数**判定（`fs/asset.rs`）。
      // 所以这里 ⛔ 不需要一份「MIME → 扩展名」的映射表，加一份就是加一处会漂的口径
      return { kind: 'file', file: new File([blob], 'pasted', { type }) }
    } catch {
      // 单项取不出来就试下一项：剪贴板里同时有 image/png 与 image/tiff 时，
      // 有一项读不动不构成「读不到图」
      continue
    }
  }
  return { kind: 'no_image' }
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
 *
 * @param file `null` = 剪贴板里有图但这个引擎没把它包成 `File`，宿主要自己再读一次
 *   （[`readClipboardImage`]）。⚠️ 那一刻**默认粘贴必须被拦下**：剪贴板里没有正文，
 *   放它过去也插不出任何东西，而拦住才有机会说那句解释
 * @param types `file` 为 `null` 时是引擎报的原始类型清单，用来把失败说具体；
 *   其余情况是空数组
 */
export type PasteImageHook = (file: File | null, view: EditorView, types: readonly string[]) => boolean

/**
 * 装上粘贴图片的拦截。宿主没给钩子时压根不装，CM6 的默认粘贴一点不受影响。
 *
 * ## ⚠️ 用的是 `domEventHandlers`，因为 `EditorView.handlePaste` **不存在**
 *
 * CM6 没有给 paste 单独开一个 facet（有 `clipboardInputFilter`，但那是改文本的，
 * 拿不到文件）。而 `domEventHandlers` 恰好够用，靠的是它的两条语义：
 *
 * 1. **插件提供的处理器排在 CM6 内置的那个之前**（`computeHandlers` 先遍历插件、
 *    后追加内置表，`@codemirror/view@6.43.11` 的 `index.js:4716`），所以「返回 true」
 *    真的能拦下默认粘贴，不是拦完之后它又粘一遍；
 * 2. 返回 true 时 CM6 自己调 `event.preventDefault()` 并**停止**后续处理器
 *    （`index.js:4567-4574` 那个 `runHandlers` 循环）。
 *
 * 这两条都是实现细节，不是文档承诺的契约。所以 `paste.test.ts` 里那组用例是
 * **真的派发 DOM 事件**、然后看正文有没有被插入——哪天 CM6 改了顺序，
 * 那组用例会当场红，而不是等到用户的截图变成一串文件名
 */
export function imagePaste(onImage: PasteImageHook): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData
      const file = pickPastedImage(data)
      if (file !== null) return onImage(file, view, [])
      // 有正文时 `pickPastedImage` 也回 null，那一支**必须**原样让给 CM6：
      // 用户要的是文字（文件头那条 🔴）。所以这里再问一次 text/plain
      if (data !== null && data.getData('text/plain') === '' && clipboardHoldsAnImage(data)) {
        return onImage(null, view, listOf(data.types))
      }
      return false
    },
  })
}
