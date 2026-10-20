import type { EditorView } from '@codemirror/view'

/**
 * 剪贴板的三个编辑器动作，与它们共用的两个原语。
 *
 * 🔴 全应用**只有这一个文件**碰 `navigator.clipboard`。另一条「复制路径」走的是 Rust 的
 * `pbcopy`（`ipc/project.ts` 的 `copy_entry_path`），因为它收的是 `(root, rel)`——
 * 那是要复制**一个磁盘条目的路径**，与这里要复制「内存里的一段正文」不是一回事。
 *
 * ⚠️ `writeText` / `readText` 都要求安全上下文，而 Tauri 在 macOS 上跑的是
 * `tauri://localhost` 这个自定义协议，算不算安全上下文取决于 WKWebView 的版本——
 * 这正是 `copy_entry_path` 当初绕开它、改走 Rust 的理由。这里绕不开，所以三个动作一律
 * **如实返回 false**，由调用方把失败说出来：「点了没反应」与「点了但做不到」在用户那边
 * 长得一样，只有后者能被修。
 *
 * 🔴 真机待验：如果在 WKWebView 里它确实抛了，补一对 Rust 命令就是解法
 * （写的一侧照 `copy_entry_path` 用 `pbcopy`，读的一侧是 `pbpaste`，
 * `run_macos_tool` 已经把管道与超时都写好了），而要改的只有这一个文件。
 */

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 读不到（权限、非安全上下文、剪贴板是空的）一律返回 null——调用方分不清也不需要分清 */
export async function readClipboard(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText()
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * 多光标的选区文本。用换行连起来是**浏览器原生的口径**（Cmd+C 就是这么干的），
 * 只取 `selection.main` 的话，用户明明选了五处、复制出来的却只有一处。
 */
function selectedText(view: EditorView): string {
  const { state } = view
  return state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join('\n')
}

/** 没有选区时返回 false：没什么可复制的，与「复制失败」在用户那边是同一句回话 */
export async function copySelection(view: EditorView): Promise<boolean> {
  const text = selectedText(view)
  if (text === '') return false
  return writeClipboard(text)
}

/**
 * 剪切 = 复制 + 删掉选区。
 *
 * 🔴 顺序不能反，而且**写剪贴板没成功就一个字都不删**：反过来的失败方式是
 * 「内容从文档里没了、剪贴板里也没有」——那是丢稿子，比剪切不动严重得多。
 * 不显式给 selection，让 CM6 按 changes 自己映射：被删掉的那几段会各自塌到起点上，
 * 正是原生剪切之后的光标位置。
 */
export async function cutSelection(view: EditorView): Promise<boolean> {
  const { state } = view
  const text = selectedText(view)
  if (text === '') return false
  if (!(await writeClipboard(text))) return false
  view.dispatch({
    changes: state.selection.ranges.filter((range) => !range.empty).map(({ from, to }) => ({ from, to })),
    scrollIntoView: true,
    userEvent: 'delete.cut',
  })
  return true
}

/**
 * 把剪贴板里的文字插到每个光标处（`replaceSelection` 自己就是按多选区做的，与原生同口径）。
 *
 * ⚠️ 只有**文字**：图片粘贴那条路走的是 DOM 的 paste 事件（`editor/paste.ts`），
 * 菜单里这一下没有事件可借，落地图片不在它的能力范围内。
 */
export async function pasteInto(view: EditorView): Promise<boolean> {
  const text = await readClipboard()
  if (text === null) return false
  view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true })
  return true
}
