import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js'
import { describeTreeError } from '../ipc/project'
import {
  listenFileChanged,
  setWatched,
  type FileChangeKind,
  type FileChangedPayload,
  type WatchStats,
} from '../ipc/watch'
import type { Workspace } from './workspace'

/**
 * 「磁盘上有人动了我打开着的文件」这一层（PLAN.md §3.4「文件监听」，M2-G-4）。
 *
 * 三件事，都不涉及界面长什么样：
 *
 * 1. **清单同步**：把「现在打开着的这些文件的绝对路径」整份递给 `set_watched`。
 *    Rust 侧自己与上一份做 diff、只动变化的那几个目录，所以这里递全量（理由逐字见
 *    `src/ipc/watch.ts` 的 `setWatched`：两边各记一份状态的失败方式是永久性静默失效）。
 * 2. **静默重载**：干净标签的文件被外部改了 → 直接 `doc.reload()`，一个字都不问。
 *    编辑器里显示的就该是磁盘上的东西，这与 M2-D 全局替换之后那次对账是同一个动作。
 * 3. **冲突队列**：脏标签被外部改了、或者文件被外部删了 → 排队问一次，一次只弹一个。
 *    这两种的共同点是「Vela 手里有磁盘上没有的东西」，自动决定就等于替用户扔数据。
 *
 * ⛔ **刻意没有「Vela 自己写的就不算」那张表。** 原子写盘（临时文件 + rename）确实会
 * 让 FSEvents 报一条，于是 ⌘S 之后会收到自己那一次改动的事件。不挡它的理由是三条：
 *
 * - 保存成功的那一刻文档已经干净了，走的是第 2 条路：`reload()` 把同样的字节读回来，
 *   而 `reload` 里那句 `if (changed) replaceText(...)` 让它连撤销栈都不碰——**零可见后果**
 * - 保存失败时脏标记还在（`writeTo` 刻意不清），那时弹一次窗恰恰是对的：盘上真变了
 * - 一张抑制表要记「哪个文件、多久之内、算不算过期」，而它一旦漏掉一条，失败方式是
 *   **那个文件从此再也不提醒**，并且没有任何东西会说出来。用一次多余的空转
 *   换掉一个会静默失效的状态机，这笔账很清楚
 *
 * ⚠️ 这一层只管**打开着的标签**。侧边栏那棵树不跟着刷新（M2-G 的范围之外）：
 * 树说的是「目录里有什么」，刷新它要重列目录，而绝大多数事件与树里看得见的那几行无关。
 *
 * 🔴 **只读分片标签整个不参与这一层**：既不进清单（`currentPaths`），事件到了也扔掉
 * （`onEvent`）。理由与代价逐字写在 `currentPaths` 里，简言之是「重开一次 = 整份文件
 * 重扫一遍，而大文件最常见的改动方式恰恰是追加」。这件事对用户是**说出来**的：
 * 分片面板头部常驻「不随外部改动刷新」（见 `ShardPane.tsx`）。
 */

/** 一次待决的冲突。字段是给对话框直接读的，答完之后靠 `tabId` 找回标签 */
export interface FileConflict {
  readonly tabId: number
  readonly name: string
  readonly path: string
  readonly kind: FileChangeKind
}

/**
 * 用户的答复。四个动作，两种冲突各用其中三个：
 *
 * - `changed` → `overwrite`（用磁盘上的覆盖）/ `keep`（保留我的改动）/ `saveAs`
 * - `removed` → `keep`（保留标签）/ `saveAs` / `closeTab`
 *
 * ⚠️ 「保留我的改动」与「保留标签」是**同一个动作**（什么都不做），所以只有一个 `keep`。
 * 分成两个值的话就多出一条永远与另一条走同一分支的 case，而措辞的差异属于界面，
 * 属于 `FileConflictDialog`
 */
export type ConflictChoice = 'overwrite' | 'keep' | 'saveAs' | 'closeTab'

export interface FileWatchOptions {
  workspace: Workspace
  /**
   * 监听不完整时说一句（有目录订不上、有路径被丢掉、撞了目录数上限）。
   *
   * 没注入就什么都不说——但**必须**有个出口：`WatchStats` 里那三个数字是
   * 「Vela 压根没在盯这个文件」唯一的对外通道，而它与「盯着但没动静」在界面上
   * 长得一模一样（理由与 `IndexStats.truncated` 逐字相同）
   */
  onWarn?: (text: string) => void
}

export interface FileWatch {
  /** 现在该弹的那一个。一次只有一个，其余排队；没有待决冲突时是 null */
  readonly current: Accessor<FileConflict | null>
  /** 队列里还等着几个（不含 `current` 那一个）。给对话框上那句「还有 N 个」用 */
  readonly pending: Accessor<number>
  /** 答复当前这一个。队列为空时什么都不做——于是「连点两下」不会误伤下一个 */
  resolve: (choice: ConflictChoice) => Promise<void>
  /**
   * 挂上事件监听，然后开始跟着标签同步清单。返回注销函数。
   *
   * ⚠️ 顺序是**先挂监听再送清单**：`setWatched` 一返回，Rust 侧就已经在订目录了，
   * 而 `listen` 注册完成之前到达的事件永久丢失。反过来的话「刚打开的文件正好被外部
   * 改了」这一个窗口里的事件就没了——与三组搜索/替换事件同一条纪律
   */
  start: () => Promise<() => void>
  /** 摘掉监听并把监听整个关掉（`setWatched([])`）。注销函数内部走的就是它 */
  stop: () => Promise<void>
}

/**
 * 把一份 `WatchStats` 翻成人话。三格全干净时返回 null（于是调用方不必判空字符串）。
 *
 * 刻意不写「上限是 256」这种数字：那是 Rust 侧的 `MAX_WATCH_DIRS`，两边没有代码生成，
 * 抄一份到文案里就是多一处会分岔的地方。`src/goto/store.ts` 那句索引警告同理
 */
export function describeWatchStats(stats: WatchStats): string | null {
  const parts: string[] = []
  if (stats.failed > 0) parts.push(`有 ${stats.failed} 个目录没订上`)
  if (stats.skipped > 0) parts.push(`有 ${stats.skipped} 条路径不是绝对路径而被丢掉`)
  if (stats.truncated) parts.push('打开的文件太多，监听目录数撞到了上限')
  if (parts.length === 0) return null
  return `文件监听不完整：${parts.join('；')}。这些文件被外部改动时 Vela 不会提醒。`
}

/** 排着队的冲突。只记 `tabId` 与 `kind`：名字与路径每次都从活标签上现读，见 `live` */
interface Queued {
  readonly tabId: number
  readonly kind: FileChangeKind
}

/** 两份已排序去重的清单是否一样。用来挡住「标签重排了一下」这种不该惊动 IPC 的变化 */
function sameList(a: readonly string[], b: readonly string[] | null): boolean {
  if (b === null) return false
  if (a.length !== b.length) return false
  return a.every((path, i) => path === b[i])
}

export function createFileWatch(options: FileWatchOptions): FileWatch {
  const ws = options.workspace
  const warn = options.onWarn ?? (() => {})

  const [queue, setQueue] = createSignal<Queued[]>([])
  /**
   * 监听挂上了没有，也就是「清单同步那个 effect 放不放行」。
   *
   * 必须有这么一个开关：`start()` 里 `await listenFileChanged(...)` 之后已经跨过了一个
   * 异步边界，那时再 `createEffect` 就脱离 owner 了（Solid 的 owner 按创建时的同步栈算），
   * effect 永远不会被 dispose。所以 effect 在工厂里同步建好、由这个信号放行，
   * 而第一次同步正是它翻成 true 的那一下触发的
   */
  const [ready, setReady] = createSignal(false)
  let unlisten: (() => void) | null = null
  /** 上一次**成功送出去**的清单。送失败时不更新，于是下一次标签变化会重试 */
  let lastSent: string[] | null = null
  /** 同步队列的尾巴。任意时刻最多一次 `set_watched` 在飞，而且顺序与调用顺序一致 */
  let tail: Promise<void> = Promise.resolve()

  /**
   * 现在打开着的文件路径，去重 + 排序。
   *
   * 排序是为了让 `sameList` 能逐位比：拖拽重排标签会换掉 `tabs()` 的数组身份、
   * 却一点没改「盯着哪些文件」，不排的话每次重排都白跑一趟 IPC。
   *
   * 去重是因为同一个文件可以在两个标签里出现（两个原样字符串指向同一个 canonical，
   * 见 `src/ipc/watch.ts` 的 `FileChangedPayload.path`），而 Rust 侧的过滤器本来就是
   * 「canonical → 一组原样字符串」，递两遍只是让那边多存一条
   */
  function currentPaths(): string[] {
    const seen = new Set<string>()
    for (const tab of ws.tabs()) {
      const path = tab.doc.path()
      // 未命名文档在磁盘上没有对应物，没什么可盯的
      if (path === null) continue
      // 🔴 只读分片一律**不盯**。
      //
      // 分片标签的「重新读一遍」不是原地换正文，而是**整个重开一次**（那份行索引与
      // 那个 fd 都钉在旧 inode 上，见 `document.ts` 的 `reopenShard`），代价是整份文件
      // 重扫一遍。而大文件最常见的改动方式恰恰是**追加**——构建日志、抓取的数据、
      // 正在写的备份：盯上它等于每追加一次就重扫一次 100 MiB。
      //
      // 代价是外部改了之后 Vela 显示的还是打开那一刻的内容。这件事**说出来**，
      // 不藏在假设里：分片面板头部那一格常驻「不随外部改动刷新」（见 `ShardPane.tsx`）
      if (tab.doc.shard() !== null) continue
      seen.add(path)
    }
    return [...seen].sort()
  }

  async function send(next: readonly string[]): Promise<void> {
    if (sameList(next, lastSent)) return
    try {
      const stats = await setWatched(next)
      // ⚠️ 记的是**送出去的那一份**而不是重算一遍：这两者之间标签可能又变了，
      // 而重算的结果会与「Rust 侧此刻真正盯着的」对不上，于是下一次该送的不送
      lastSent = [...next]
      const note = describeWatchStats(stats)
      if (note !== null) warn(note)
    } catch (err) {
      warn(`文件监听没能同步：${describeTreeError(err)}`)
    }
  }

  function enqueueSend(next: readonly string[]): Promise<void> {
    // send 自己吞掉了所有异常，于是 tail 永远不 reject，不需要 catch 兜底
    tail = tail.then(() => send(next))
    return tail
  }

  /**
   * 队列里那些**标签还在**的条目，带着现读的名字与路径。
   *
   * 现读而不是入队时存一份快照：等用户答复可能已经是几分钟之后，其间这个标签可能
   * 被另存为过（名字与路径都变了），而对话框上显示一个旧名字比不显示更误导。
   * 同一个道理，标签被关掉的条目在这里自然消失，不必等谁来通知
   */
  const live = createMemo((): FileConflict[] => {
    const byId = new Map(ws.tabs().map((t) => [t.id, t]))
    const out: FileConflict[] = []
    for (const item of queue()) {
      const tab = byId.get(item.tabId)
      if (tab === undefined) continue
      const path = tab.doc.path()
      if (path === null) continue
      out.push({ tabId: item.tabId, kind: item.kind, name: tab.doc.name(), path })
    }
    return out
  })

  createEffect(() => {
    if (!ready()) return
    // 依赖是 `tabs()` 的数组身份 + 每个标签的 `doc.path()` 与 `doc.shard()`，
    // **没有** `doc.dirty()`：
    // 这份清单说的是「该盯哪些文件」，与文件脏不脏无关——脏文件恰恰是最需要被盯着的，
    // 因为「盘上被别人改了」这件事只有知道才问得出口。读进来了也不至于多送一次 IPC
    // （`send` 里那句 `sameList` 会挡住），只是每次保存、每次「第一次标脏」都白跑一趟重算。
    // `doc.shard()` 必须在依赖里：一个标签从内联变成分片（文件长过了 4 MiB）时，
    // 这份清单要跟着少一条
    void enqueueSend(currentPaths())
  })

  // 队列的垃圾回收：`live()` 会跳过标签已经不在了的条目，但它们不会自己从数组里消失，
  // 而标签 id 单调递增、永不复用，于是那是一条永远不可能再被答复的死条目
  createEffect(() => {
    const alive = live()
    setQueue((q) => {
      // 没东西可摘时把原数组还回去：Solid 的 setter 对 `===` 相等的值不通知，
      // 于是这个「读 queue 又写 queue」的 effect 不会自己叫醒自己
      if (alive.length === q.length) return q
      return alive.map(({ tabId, kind }) => ({ tabId, kind }))
    })
  })

  function onEvent(change: FileChangedPayload) {
    // 一个路径可能对应**多个**标签（同一文件的两个原样字符串），所以这里不 break
    for (const tab of ws.tabs()) {
      if (tab.doc.path() !== change.path) continue
      // 🔴 分片标签的事件在这里也扔掉，与 `currentPaths` 那条排除是**同一条规矩的两半**。
      //
      // 清单里压根没有它，那事件从哪来？两个来源：一是「内联长成分片」那一刻——
      // `reload` 撞上 too_large 改走分片，而摘掉这条路径的那次 `set_watched` 还排在
      // `tail` 上没落地，Rust 侧仍在盯着；二是 Rust 侧的过滤器按 canonical 挂，
      // 而 `set_watched` 的 diff 与事件到达之间本来就有一段窗口。
      //
      // 不扔的后果不是丢数据（分片永远不脏），而是**一次没人要求的整份重扫**：
      // `reload` 在分片上走 `reopenShard`，那是把 100 MiB 重新扫一遍行索引。
      // 而它与面板头部那句常驻的「不随外部改动刷新」直接矛盾——说了不刷新，
      // 却在一条竞态窗口里悄悄刷新，是最难查的那种不一致
      if (tab.doc.shard() !== null) continue
      if (change.kind === 'changed' && !tab.doc.dirty()) {
        // 干净标签直接对齐磁盘，不问。`reload` 自己会再判一次脏（那条规矩只该有一个
        // 真相来源）、正文一模一样时一个字都不动、也不抢焦点，所以这里不需要任何前置检查。
        // 它把读失败写进 `doc.notice` 而从不 reject，于是 `void` 是安全的
        void tab.doc.reload()
        continue
      }
      // 脏标签被改、或者文件被删（脏不脏都一样）：Vela 手里有磁盘上没有的东西，
      // 自动决定就等于替用户扔数据
      const kind = change.kind
      setQueue((q) =>
        // 同一个标签的同一种冲突只排一次：debouncer 已经把 250ms 内的抖动合掉了，
        // 而用户不答复的那几分钟里同一个文件可能被改很多次，排一队同样的对话框毫无意义
        q.some((c) => c.tabId === tab.id && c.kind === kind) ? q : [...q, { tabId: tab.id, kind }],
      )
    }
  }

  async function resolve(choice: ConflictChoice): Promise<void> {
    const head = live()[0]
    if (head === undefined) return
    // 先出队再动手：答复期间的 `await`（另存为要弹原生对话框）可能长达几十秒，
    // 留在队首的话 `current()` 一直指着它，界面上就是一个关不掉的对话框
    setQueue((q) => q.filter((c) => !(c.tabId === head.tabId && c.kind === head.kind)))
    const tab = ws.tabs().find((t) => t.id === head.tabId)
    // 等答复的期间用户自己把标签关了。那不是错误，也没什么可做
    if (tab === undefined) return
    try {
      switch (choice) {
        case 'overwrite':
          // 顺序是**先扔改动再读**：`reload` 对脏文档一律返回 false 什么都不做
          // （那份未保存的改动是磁盘上没有的唯一副本），而用户刚刚明确说了要覆盖它
          tab.doc.discardChanges()
          await tab.doc.reload()
          break
        case 'saveAs':
          await tab.doc.saveAs()
          break
        case 'closeTab':
          // 复用 workspace 那条路，于是脏标签会**再问一次**「保存 / 不保存 / 取消」。
          // 这是有意的：那是唯一给「保存」留出路的地方，而在这里自己 `discardChanges()`
          // 等于把用户刚打的字直接扔掉——他点的明明是「关闭标签」，不是「丢掉改动」
          await ws.closeTab(tab.id)
          break
        case 'keep':
          break
      }
    } catch (err) {
      // 另存为的原生对话框、关标签的确认都可能抛（IPC 失败）。这一层在启动路径上，
      // 抛出去会变成一个没人接的 rejection，而用户的处境只是「没保存成」
      warn(`没能处理这个文件冲突：${describeTreeError(err)}`)
    }
  }

  async function stop(): Promise<void> {
    // 先停 effect：注销之后标签再变（关窗口那一下会关掉一堆标签）也不该把监听重新订上
    setReady(false)
    unlisten?.()
    unlisten = null
    // 走同一条队列，于是「关掉」必然排在最后一次「订上」之后。反过来的话 Rust 侧
    // 留下的是**订着的状态**，而进程还活着——关窗口不等于退出（见 M1-F 的双向握手）
    await enqueueSend([])
  }

  return {
    current: () => live()[0] ?? null,
    pending: () => Math.max(0, live().length - 1),
    resolve,
    async start() {
      try {
        unlisten = await listenFileChanged(onEvent)
      } catch (err) {
        // 挂不上就整个不启用：清单同步那个 effect 靠 `ready` 放行，于是也不会送。
        // 半启用（订了目录却收不到事件）比不启用更糟——它会让 `WatchStats`
        // 里那三个数字看起来一切正常
        warn(`文件监听没能挂上：${describeTreeError(err)}`)
        return () => {}
      }
      setReady(true)
      return () => {
        void stop()
      }
    },
    stop,
  }
}
