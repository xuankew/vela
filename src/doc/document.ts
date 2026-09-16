import { createSignal, type Accessor } from 'solid-js'
import { save as pickToSave } from '@tauri-apps/plugin-dialog'
import { describeFsError, ENCODING_LABELS, openFile, saveFile, type EncodingId, type FileFormat } from '../ipc/fs'

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
  /**
   * 路径刚变过（打开文件、另存为）。
   *
   * 路径是语言的唯一依据，而语言槽位归宿主（workspace）管，所以每次 `setPath` 之后
   * 都得说一声。这一层刻意不自己算语言：它连 CM6 都不该知道。
   */
  pathChanged: () => void
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
  /**
   * 会话恢复：把一份完整的文档现场（正文、路径、格式、脏标记、lossy）一次装进来，
   * **不碰磁盘**。
   *
   * 不能复用 `openAt`：那条路走 fs 层并且把 `dirty` 强制设成 false，而恢复出来的草稿
   * 按定义就是脏的——把它标成干净，下一次关窗口的确认就会直接放行，用户的稿子没了。
   */
  restoreDraft: (init: {
    path: string | null
    text: string
    format: FileFormat
    dirty: boolean
    lossy: boolean
  }) => void
  /**
   * 用户在关闭确认里答了「不保存」：把这些改动当成从来没发生过。
   *
   * M1-F 之前这一步是免费的——窗口一关，内存里的东西自然就没了。有了会话存档之后
   * 它变成必须的：存档收草稿的条件是「这个文档是脏的」，不清脏标记，用户刚刚明确
   * 扔掉的稿子下次启动会原样端回来，比一开始不问他还糟。
   */
  discardChanges: () => void
  save: () => Promise<void>
  saveAs: () => Promise<void>
  /**
   * 改「保存时用的格式」（编码 / BOM / 行尾）。**这算一次未保存的改动**，会把文档标脏。
   *
   * 不标脏的后果很实在：用户把编码从 UTF-8 改成 GBK，然后直接关窗——关闭确认看
   * `dirty` 是 false 就放行了，磁盘上还是 UTF-8，那个决定被静默扔掉。
   */
  changeFormat: (patch: Partial<FileFormat>) => void
  /**
   * 用指定编码**重新解码磁盘上的同一份字节**——「以某编码重新打开」。
   *
   * 存在的理由：探测会静默地错。一份 GBK 文件如果字节恰好是合法 UTF-8，读进来是乱码
   * 而 `lossy` 为 false，提示条一个字都不会说（见 `vela-core::fs::encoding::decode_as`）。
   */
  reopenWith: (encoding: EncodingId) => Promise<void>
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
      // 必须在 replaceText 之后：重建 state 会把语言槽位清空，这里再把新语言装进去。
      // 反过来的话语言会装到一个马上被丢弃的 state 上，且静默无报错
      host.pathChanged()
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

  function restoreDraft(init: {
    path: string | null
    text: string
    format: FileFormat
    dirty: boolean
    lossy: boolean
  }) {
    // replaceText 而不是 setText：整篇替换会触发 docChanged，不挡住的话恢复出来的
    // 草稿会被再标一次脏——dirty 该由存档说了算，不该由「装进去」这个动作决定
    replaceText(init.text)
    setPath(init.path)
    // 必须在 replaceText 之后：重建 state 把语言槽位清空了
    host.pathChanged()
    setFormat(init.format)
    setDirty(init.dirty)
    setLossy(init.lossy)
    setNotice(null)
    // 刻意不 host.focus()：恢复好几个标签时，焦点不该落在「恰好最后处理的那个」上。
    // 聚焦哪块分屏是 workspace 在装分屏时决定的
  }

  function discardChanges() {
    // 未命名文档必须连正文一起清掉：磁盘上没有它，正文就是它唯一的副本，
    // 而存档对未命名文档是无条件收草稿的（不收就等于重启后这个标签凭空变空）。
    // 有路径的不用动正文——清了脏标记存档就不收它，下次启动重新读盘
    if (path() === null) replaceText('')
    setDirty(false)
  }

  function changeFormat(patch: Partial<FileFormat>) {
    setFormat({ ...format(), ...patch })
    setDirty(true)
  }

  async function reopenWith(encoding: EncodingId) {
    const target = path()
    if (target === null) return
    if (dirty()) {
      // 不复用 `promptDiscard` 那套：它的语义是「这个文档还要不要」，而这里用户想要的
      // 恰恰是留住文档、只换一种读法。给一句提示让他自己决定先保存还是先撤销，
      // 比弹一个语义不对的模态框诚实
      setNotice({
        level: 'warning',
        text: '有未保存的改动，重新解码会把它们扔掉。先保存，或者撤销到干净状态再换编码。',
      })
      return
    }
    setBusy(true)
    try {
      const file = await openFile(target, encoding)
      // 不调 host.pathChanged()：路径没变，语言也就没变。宿主的 setText 本来就会
      // 重跑一次 syncLanguage（replaceTabText 把标签上的语言清了），不用这里再催
      replaceText(file.text)
      setFormat(file.format)
      setDirty(false)
      setLossy(file.lossy)
      setNotice(null)
      host.focus()
    } catch (err) {
      setNotice({ level: 'error', text: `重新打开失败：${describeFsError(err)}` })
    } finally {
      setBusy(false)
    }
  }

  async function writeTo(target: string) {
    setBusy(true)
    try {
      const report = await saveFile(target, host.getText(), format())
      setPath(target)
      // 另存为会把无名文档（默认当 Markdown）换成别的扩展名，语言得跟着走。
      // 保存不重建 state，所以这里只能靠槽位 reconfigure
      host.pathChanged()
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
    restoreDraft,
    discardChanges,
    save,
    saveAs,
    changeFormat,
    reopenWith,
  }
}
