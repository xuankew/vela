import { createSignal, type Accessor } from 'solid-js'
import { save as pickToSave } from '@tauri-apps/plugin-dialog'
import { describeFsError, ENCODING_LABELS, openFile, saveFile, type EncodingId, type FileFormat } from '../ipc/fs'
import { openLarge } from '../ipc/shard'
import { createShardView, type ShardView } from './shardView'

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
  /**
   * 只读分片（M2-H）。`null` = 这个文档的正文**就在内存里**，CM6 那份 buffer 是真的。
   *
   * 非 `null` 时相反：正文在 Rust 那边按页取，内存里的 buffer 是**空的**。于是四件事
   * 跟着变，每一件都有它自己的守卫：
   *
   * - 编辑：`EditorPane` 压根不渲染（见 `App.tsx`），`ws.focusedEditor()` 是 null，
   *   所有 `editor.*` 命令的 `when` 一起失效——不是「禁用」，是**不存在**
   * - 保存：`save` / `saveAs` 在这一层拒掉。🔴 尤其是 `saveAs`：它写的是
   *   `host.getText()`，那份空 buffer 落盘就是一个**零字节文件**，把原文件覆盖掉
   * - 脏标记：永远不会脏（没人能改那份空 buffer），所以关闭确认压根不会问
   * - 状态栏：`ws.metrics()` 报的是上一个标签的数，所以 `StatusBar` 自己分叉，
   *   改报「只读 · N 行 · X MB」
   *
   * ⚠️ `format()` 在分片模式下**只为显示**（状态栏那两格读它，而它们会被禁用）。
   * ⛔ 不要拿它去调 `saveFile`
   */
  readonly shard: Accessor<ShardView | null>
  /** 编辑器正文变化时由宿主调用 */
  markChanged: () => void
  dismissNotice: () => void
  /** 打开一个已知路径。将来的「最近文件」与拖拽落文件都走这里 */
  openAt: (path: string) => Promise<void>
  /**
   * 关掉分片、把那个 fd 还回去（`ipc/shard.ts` 的 `closeLarge`：Vela 里唯一一个
   * 「不调就会漏」的 IPC）。**幂等**，没有分片时什么都不做。
   *
   * 两处调用点，都在 `workspace.ts`：标签关闭（`dropTab`）与窗口关闭
   * （`requestWindowClose`）。第三处——「外部改了文件之后重开分片」——是这一层
   * 自己的 `reload`，不经过这个方法
   */
  releaseShard: () => void
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
  /**
   * 磁盘上的这个文件可能已经被别人改过了，重新读一遍（M2-D 全局替换之后对账用）。
   *
   * 与 `reopenWith` 的差别有三处，每一处都是有理由的：
   *
   * - 用**当前**编码，不让后端重新探测。用户可能刚刚「以 GBK 重新打开」过，
   *   重新探测会把这个决定悄悄扔掉
   * - **正文一模一样时一个字都不动**。`setText` 会重建 CM6 的 state，撤销栈跟着一起没——
   *   全局替换压根没碰到的那些标签，凭什么丢掉自己的撤销历史
   * - **不抢焦点**。对账是后台发生的，抢焦点的话用户正在打的字会跑到别的标签上去
   *
   * 脏文档一律不碰：那份未保存的改动是磁盘上没有的唯一副本。而全局替换本来就把它
   * 列进了 `skip`（见 `ReplaceRequest.skip`），两边必须说法一致——一边跳过一边覆盖
   * 的话，用户看到的是「明明跳过了，怎么内容还是变了」
   *
   * @returns 正文有没有真的换过。未命名、脏、读失败、以及内容没变都是 false
   *
   * ⚠️ 分片标签走的是**另一条实现**（整个重开一次分片），返回值一律 true：
   * 那份正文不在内存里，没法逐字比对，而能走到这一步说明磁盘上刚刚发生过一次写
   */
  reload: () => Promise<boolean>
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * `open_file` 撞了 4 MiB 的内联上限（`vela_core::fs::read` 的 `MAX_INLINE_BYTES`）。
 *
 * 收 `unknown` 是因为 `invoke` 的 reject 值就是它，而这一层只认**一个** kind：
 * 别的错误照原样冒上去，由调用点那句统一的 `describeFsError` 兜住。
 *
 * ⚠️ 这里判的是「该换一条路」，**不是**「打开失败」——所以命中它的时候一个字都不能
 * 说，改走分片。只有分片自己也接不住（超过 256 MiB、UTF-16）才轮得到报错
 */
function isTooLarge(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { kind?: unknown }).kind === 'too_large'
}

export function createDocumentModel(host: DocumentHost): DocumentModel {
  const [path, setPath] = createSignal<string | null>(null)
  const [format, setFormat] = createSignal<FileFormat>(DEFAULT_FORMAT)
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [lossy, setLossy] = createSignal(false)
  const [notice, setNotice] = createSignal<Notice | null>(null)
  const [shard, setShard] = createSignal<ShardView | null>(null)

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
      try {
        await openInline(target)
      } catch (err) {
        // 4 MiB 以上改走只读分片：这不是失败，是换一条路，所以一个字都不说
        if (!isTooLarge(err)) throw err
        await openAsShard(target)
      }
    } catch (err) {
      // 两条路的失败汇到同一句文案：分片自己也有上限（256 MiB）与接不住的编码（UTF-16），
      // 而用户不关心是哪一条路拒的，只关心为什么打不开
      setNotice({ level: 'error', text: `打不开：${describeFsError(err)}` })
    } finally {
      setBusy(false)
    }
  }

  async function openInline(target: string) {
    const file = await openFile(target)
    // 从分片切回内联时那个 fd 不会自己消失。⚠️ 这是**资源**收尾而不是状态校验：
    // 判错一次的后果是漏一个 fd（见 `ipc/shard.ts` 的 `closeLarge`）
    releaseShard()
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
  }

  /**
   * 只读分片这条路。⚠️ 抛出去的错误由 `openAt` 那句统一文案接住，这里**不**自己写 notice。
   *
   * `open_large` 会**整份扫一遍**文件建行索引，所以它自己可能失败也可能慢；
   * 慢的时候 `busy` 已经在 `openAt` 里置上了，状态栏那一格会显示「读写中…」
   */
  async function openAsShard(target: string) {
    const opened = await openLarge(target)
    // 先拿到新句柄再关旧的：反过来一旦 `open_large` 失败，这个文档就只剩一个空 buffer
    releaseShard()
    setShard(createShardView(opened))
    // 正文清空。分片的行在 Rust 那边按页取，CM6 这份 buffer 只是个占位；
    // 🔴 留着上一个文件的正文的话，`host.getText()` 会把它当成这个文件的内容
    replaceText('')
    setPath(target)
    host.pathChanged()
    const { encoding, bom, eol } = opened.header
    // ⚠️ 只为状态栏那两格（它们在分片模式下是禁用的）。⛔ 不要拿它去调 saveFile
    setFormat({ encoding, bom, eol })
    setDirty(false)
    // 刻意**不**采纳 `header.lossy`：App 那条 lossy 提示讲的是「原样保存会永久损坏它」，
    // 而分片模式压根不能保存，那句话在这儿没有对象。头部解码有损这件事改由分片面板
    // 自己在只读提示里说（见 `ShardPane.tsx`）
    setLossy(false)
    setNotice(null)
    host.focus()
  }

  function releaseShard() {
    const current = shard()
    if (current === null) return
    // 先摘再 dispose：`dispose` 会调 `closeLarge`，那之后迟到的读页响应回来是 `null`，
    // 而 `shardView` 对 `null` 的处理是**安静忽略**——顺序反了也不会出错，
    // 但「屏幕上还挂着一个已经关掉的视图」这件事本身就不该发生
    setShard(null)
    current.dispose()
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

  async function reload(): Promise<boolean> {
    const target = path()
    // 未命名文档在磁盘上没有对应物；脏文档的理由见接口上那段
    // ⚠️ 两道都排在 `setBusy` 之前：它们是「压根不去读」，不是「读了但没用」
    if (target === null || dirty()) return false
    if (shard() !== null) return await reopenShard(target)
    setBusy(true)
    try {
      const file = await openFile(target, format().encoding)
      const changed = file.text !== host.getText()
      // 正文没变就一个字都不动，理由见接口上那段（撤销栈）
      if (changed) replaceText(file.text)
      // 格式与 lossy 一律对齐磁盘：行尾或 BOM 在盘上变过而正文没变是可能的
      // （外部工具改写了行尾），而状态栏显示一个过时的行尾比显示过时的正文更难察觉
      setFormat(file.format)
      setLossy(file.lossy)
      setNotice(null)
      return changed
    } catch (err) {
      // 文件在 Vela 开着的时候长过了 4 MiB（一个正在被追加的日志正是这个样子）：
      // 这条路本来是内联的，现在只能改走分片。⚠️ 脏文档在上面就已经返回了，
      // 所以这里换掉正文不会吃掉任何未保存的改动
      if (isTooLarge(err)) {
        try {
          await openAsShard(target)
          return true
        } catch (again) {
          setNotice({ level: 'error', text: `重新读取失败：${describeFsError(again)}` })
          return false
        }
      }
      setNotice({ level: 'error', text: `重新读取失败：${describeFsError(err)}` })
      return false
    } finally {
      setBusy(false)
    }
  }

  /**
   * 分片标签的「重新读一遍」= **整个重开一次**。
   *
   * 那份行索引与那个 fd 都钉在旧 inode 上（见 `ipc/shard.ts` 的 `closeLarge`），
   * 而分片模式压根没有「正文」可以原地换掉，所以看得见新内容的唯一办法是重开。
   *
   * 🔴 代价是**整份文件重扫一遍**。这正是 `fileWatch` 刻意不盯分片标签的理由：
   * 大文件最常见的改动方式是**追加**（构建日志、抓取的数据），
   * 每追加一次就重扫一遍 100 MiB 是不能接受的。于是只有用户刚刚亲手批准过的那一次
   * 写盘（全局替换，见 `workspace.ts` 的 `reloadUnder`）会走到这里
   *
   * @returns 一律 true。正文不在内存里，没法逐字比对；而能走到这一步说明盘上刚写过
   */
  async function reopenShard(target: string): Promise<boolean> {
    setBusy(true)
    try {
      const opened = await openLarge(target)
      releaseShard()
      setShard(createShardView(opened))
      setNotice(null)
      return true
    } catch (err) {
      // 旧的那个视图留着不动：它虽然是打开那一刻的内容，但至少还能看，
      // 比一个空面板加一句报错有用
      setNotice({ level: 'error', text: `重新读取失败：${describeFsError(err)}` })
      return false
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

  /**
   * 分片标签上任何写动作的统一答复。
   *
   * ⚠️ 这不是「不该发生的场景」的防御：⌘S 与工具栏上那两个按钮在分片标签下**都是可点的**，
   * 用户按下它们是完全正常的一次尝试。而沉默地什么都不做是最坏的回答——
   * 他刚刚按了保存，然后什么反馈都没有
   */
  function refuseReadOnly(what: string) {
    setNotice({ level: 'warning', text: `这个文件太大，Vela 以只读方式打开它，${what}。` })
  }

  async function saveAs() {
    if (shard() !== null) {
      refuseReadOnly('不能另存为')
      return
    }
    const picked = await pickToSave({ defaultPath: path() ?? undefined })
    if (typeof picked === 'string') await writeTo(picked)
  }

  // 具名函数而不是对象方法里的 `this.saveAs()`：JSX 里 `onClick={doc.save}` 这种
  // 解绑调用会让 `this` 变成 undefined
  async function save() {
    // 🔴 这一道必须在这儿，不能只靠「分片标签不会脏」：`save` 还有第二个调用点是
    // 工具栏与 ⌘S，而它们不看脏标记。真的走下去的话 `writeTo` 会拿 `host.getText()`
    // ——那份**空** buffer——把原文件覆盖成一个零字节文件
    if (shard() !== null) {
      refuseReadOnly('不能保存')
      return
    }
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
    shard,
    markChanged,
    dismissNotice: () => setNotice(null),
    openAt,
    releaseShard,
    restoreDraft,
    discardChanges,
    save,
    saveAs,
    changeFormat,
    reopenWith,
    reload,
  }
}
