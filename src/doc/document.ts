import { createSignal, type Accessor } from 'solid-js'
import { save as pickToSave } from '@tauri-apps/plugin-dialog'
import { describeFsError, ENCODING_LABELS, openFile, saveFile, type FileFormat } from '../ipc/fs'

/**
 * 单个文档的生命周期：路径、格式、脏标记，以及打开/保存/另存为。
 *
 * M1-D 之后这是**每个标签一份**：`src/doc/workspace.ts` 为每个标签调一次这个工厂，
 * 标签条上的名字、脏标记、提示条都直接读它。
 *
 * **刻意不包含**：
 * - 「弹对话框选文件」与「新建文档」。两者都要先回答「落到哪个标签上」——复用当前
 *   干净的空标签、激活已打开同路径的标签、还是新建一个——那是 workspace 的知识。
 *   这里只保留 `openAt(path)`：给我一个路径，我负责读进来。
 * - 未保存改动的关闭拦截。这一层只负责**如实报告** `dirty`，拦不拦、怎么问都不归它：
 *   标签级在 `workspace.ts` 的 `closeTab`，窗口级在 `workspace.ts` 的 `requestWindowClose`
 *   + `ipc/windowClose.ts` + Rust 侧 `src-tauri/src/lib.rs` 的双向握手。
 */

/** 文档模型需要的宿主能力。注入而不是直接持有 `EditorController`，这样单测不用起 CM6 */
export interface DocumentHost {
  getText: () => string
  setText: (text: string) => void
  focus: () => void
}

/** 新建文档的默认格式：macOS 上最不可能出错的组合 */
export const DEFAULT_FORMAT: FileFormat = { encoding: 'utf8', bom: false, eol: 'lf' }

export const UNTITLED_LABEL = '空文档'

export interface Notice {
  level: 'warning' | 'error'
  text: string
}

export interface DocumentModel {
  readonly path: Accessor<string | null>
  /** 展示名：有路径时是文件名，没有时是「空文档」 */
  readonly name: Accessor<string>
  readonly format: Accessor<FileFormat>
  readonly dirty: Accessor<boolean>
  readonly busy: Accessor<boolean>
  /**
   * 解码时有字节无法映射，正文里已含替换字符 U+FFFD。
   *
   * 这是**文档的属性**而不是一次性事件，所以单独一个 signal 常驻，不塞进 notice：
   * 只要这个文档还开着，「原样保存会损坏原文件」这件事就一直成立。
   */
  readonly lossy: Accessor<boolean>
  readonly notice: Accessor<Notice | null>
  /** 编辑器正文变化时由宿主调用 */
  markChanged: () => void
  dismissNotice: () => void
  /** 打开一个已知路径。将来的「最近文件」与拖拽落文件都走这里 */
  openAt: (path: string) => Promise<void>
  save: () => Promise<void>
  saveAs: () => Promise<void>
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

export function createDocumentModel(host: DocumentHost): DocumentModel {
  const [path, setPath] = createSignal<string | null>(null)
  const [format, setFormat] = createSignal<FileFormat>(DEFAULT_FORMAT)
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [lossy, setLossy] = createSignal(false)
  const [notice, setNotice] = createSignal<Notice | null>(null)

  /**
   * 正在用后端的正文整篇替换编辑器内容。
   *
   * 替换会触发 `onUpdate(docChanged: true)`，如果不挡住，刚打开的文件立刻就是「脏」的。
   * 用显式标志而不是依赖「setDoc 之后再把 dirty 设回 false」的顺序：那个顺序成立与否
   * 取决于 CM6 的回调是同步还是异步，不该赌。
   */
  let replacing = false

  function replaceText(text: string) {
    replacing = true
    try {
      host.setText(text)
    } finally {
      replacing = false
    }
  }

  function markChanged() {
    if (replacing) return
    // 脏标记只增不减：撤销回到已保存状态时它仍然是脏的。
    // 这是有意的取舍——反向的错误（明明有改动却显示干净）会让人丢数据，
    // 而这一侧的错误只是多一次无意义的保存。要精确就得每次按键比对全文，不值当。
    if (!dirty()) setDirty(true)
  }

  async function openAt(target: string) {
    setBusy(true)
    try {
      const file = await openFile(target)
      replaceText(file.text)
      setPath(target)
      setFormat(file.format)
      setDirty(false)
      setLossy(file.lossy)
      setNotice(null)
      host.focus()
    } catch (err) {
      setNotice({ level: 'error', text: `打不开：${describeFsError(err)}` })
    } finally {
      setBusy(false)
    }
  }

  async function writeTo(target: string) {
    setBusy(true)
    try {
      const report = await saveFile(target, host.getText(), format())
      setPath(target)
      setDirty(false)
      setNotice(
        report.unmappable
          ? {
              level: 'warning',
              text: `有字符在 ${ENCODING_LABELS[format().encoding]} 里不存在，已被写成数字字符引用——这就是数据损坏。建议另存为 UTF-8。`,
            }
          : null,
      )
    } catch (err) {
      // 保存失败时脏标记必须留着：它是唯一提示用户「内容还没落盘」的地方
      setNotice({ level: 'error', text: `保存失败：${describeFsError(err)}` })
    } finally {
      setBusy(false)
    }
  }

  async function saveAs() {
    const picked = await pickToSave({ defaultPath: path() ?? undefined })
    if (typeof picked === 'string') await writeTo(picked)
  }

  // 具名函数而不是对象方法里的 `this.saveAs()`：JSX 里 `onClick={doc.save}` 这种
  // 解绑调用会让 `this` 变成 undefined
  async function save() {
    const current = path()
    if (current === null) await saveAs()
    else await writeTo(current)
  }

  return {
    path,
    name: () => {
      const p = path()
      return p === null ? UNTITLED_LABEL : baseName(p)
    },
    format,
    dirty,
    busy,
    lossy,
    notice,
    markChanged,
    dismissNotice: () => setNotice(null),
    openAt,
    save,
    saveAs,
  }
}
