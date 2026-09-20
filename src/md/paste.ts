import { languageFor } from '../editor/language'
import { describeAssetError, MAX_IMAGE_BYTES, storeImage, type StoredImage } from '../ipc/asset'

/**
 * 把一张粘贴进来的图片落到文档旁边，并在光标处插入 Markdown 链接（M3-A-7）。
 *
 * 这一层是「剪贴板里的图片」与「正文里的一行 `![](assets/…)`」之间的全部逻辑，
 * 而它刻意**不认识 CM6**：`insert` 与 `notify` 都是注入的回调，所以整条路能在
 * node 环境里用两个假函数测出来，不需要 jsdom、不需要 view、也不需要 Tauri。
 * CM6 那一侧的接线在 `src/editor/paste.ts`（挑文件）与 `src/App.tsx`（组装回调）。
 *
 * ## 🔴 只在 Markdown 文档里接
 *
 * 往一个 `.rs` 文件里插一行 `![](assets/x.png)` 是纯粹的破坏。判断走的是
 * `languageFor(path).kind`，也就是**语言分派那一个真相来源**——⛔ 不要在这里
 * 重新写一遍扩展名正则：`MARKDOWN_EXT` 将来加上 `.mdx` 的时候，
 * 只改一处的结果是「高亮认它、粘贴不认它」，而那是一条没人会想到去查的不一致。
 *
 * ⚠️ 未命名草稿的 `path` 是 `null`，而 `languageFor(null)` 答 Markdown（M1-E 起就是这个
 * 行为）。所以草稿会**被接住**，然后在下面第一条拒绝里说清「先存一次」——
 * 静默什么都不做是这里最坏的结局：用户按了 ⌘V，光标闪了一下，没有任何解释。
 *
 * ## ⚠️ 落地的图片在 Vela 自己的预览里**不会显示**
 *
 * 这是 M3-A 那条安全边界的直接后果，不是这一层的 bug：`src/md/render.ts` 把本地图片
 * 映射成 `<span class="md-img-local">` 占位符，从不输出 `<img>`——因为 `file:` 不在
 * 允许的 scheme 里，而 `tauri.conf.json` 的 `csp` 是 `null`。要让它显示得启用 Tauri 的
 * asset protocol，那是一次主动扩大攻击面，M3-A-7 刻意不做。
 * 链接在 GitHub / Typora / 任何别的渲染器里都能用。**这句话必须原样告诉用户**
 * （见 PLAN.md 的 M3-A-7 实施修正）。
 */

/** 落地成功后要插进正文的那一行 */
export function imageMarkdown(rel: string): string {
  // 空的 alt 文本是有意的：粘进来的截图没有名字可言，而 `![](...)` 与 `![描述](...)`
  // 在渲染上没有区别，占位符反而会让人以为「Vela 替我写了个描述」。
  // ⚠️ rel 是 Rust 生成的 `assets/pasted-<16 位十六进制>.<ext>`，不含空格、括号或引号，
  // 所以不需要 `<>` 包裹也不需要转义。**如果将来命名规则变成可配置的，这句话就不成立了**
  return `![](${rel})`
}

export interface PasteTarget {
  /** 目标文档的绝对路径。`null` = 未命名草稿 */
  path: string | null
  /** 在光标处插入一段文字。必须是一次**可撤销**的普通编辑事务 */
  insert: (text: string) => void
  /**
   * 拒绝或失败时说一句话。
   *
   * 🔴 带档位，而不是让宿主一律染成红色：「先存一次」与「磁盘写不进去」在用户眼里
   * 不是一类事——前者什么都没坏，只是他还没做那一步，染成故障色会让一次正常的
   * 粘贴看起来像 Vela 出了问题（M3-A-5 立下的同一条口径）。宿主决定这两档长什么样
   */
  notify: (text: string, level: PasteNoticeLevel) => void
}

/** `notify` 的两档。`ok` 不在里面：落地成功时**一句话都不说**，插进去的链接就是回话 */
export type PasteNoticeLevel = 'plain' | 'error'

/**
 * 这个文档该不该接住粘贴进来的图片。
 *
 * 同步的，因为 paste 处理器的返回值决定 CM6 要不要 `preventDefault`，
 * 那一刻之后的任何异步都来不及。
 */
export function acceptsPastedImage(path: string | null): boolean {
  return languageFor(path).kind === 'markdown'
}

/**
 * 落地一张图片。成功时**不说话**：插进正文的那行链接就是全部的反馈，
 * 与 M3-A-5「对齐成功了就不该说话」同一条口径。
 *
 * ⚠️ 这个函数**不抛**：所有失败都翻译成一句人话交给 `notify`。
 * 调用它的那一侧在一个 CM6 事件处理器里，抛出去的异常会被 CM6 吞掉
 * （它给 DOM handler 包了 try/catch），用户看到的是「什么都没发生」。
 */
export async function landPastedImage(file: File, target: PasteTarget): Promise<void> {
  const { path, insert, notify } = target

  if (path === null) {
    // 图片要落在「文档所在目录的 assets/」里，而一份没存过的草稿没有目录可推。
    // 这不是偷懒：让它落到工作区根、或落到临时目录，都会产出一个
    // 「用户存了文档之后链接就断了」的坑，而那时他已经写了一整篇了
    notify('这份文档还没有路径。先存一次（⌘S），图片要落在它旁边的 assets/ 里', 'plain')
    return
  }

  // 🔴 在 `arrayBuffer()` **之前**查大小：用户在 Finder 里复制一个 2 GB 的文件再粘进来
  // 是会发生的事，那时先把 2 GB 读进 webview 内存、再交给 Rust 去拒，界面已经卡死过了。
  // `storeImage` 里还有一道同样的检查，那一道管的是「字节真的超了」，这一道管的是
  // 「连读都别读」
  if (file.size > MAX_IMAGE_BYTES) {
    notify(
      `这张图有 ${(file.size / 1048576).toFixed(1)} MB，超过上限 ${(MAX_IMAGE_BYTES / 1048576).toFixed(0)} MB`,
      'plain',
    )
    return
  }

  let stored: StoredImage
  try {
    stored = await storeImage(path, new Uint8Array(await file.arrayBuffer()))
  } catch (err) {
    // `error`：这一支是「用户什么都做对了，而我们没做成」——格式不收、目录写不进去、
    // 磁盘满了。与上面两支「你还没做那一步」不是一类事
    notify(describeAssetError(err), 'error')
    return
  }
  insert(imageMarkdown(stored.rel))
}
