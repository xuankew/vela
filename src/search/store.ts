/**
 * 搜索面板的状态：搜什么、搜到哪了、结果有哪些行、选中哪一行，以及——M2-D 之后——
 * 换成什么、预览过没有、批准了没有、落盘的总账怎么说。
 *
 * 结构性的部分（怎么摊成行、方向键落到哪、总账怎么说）全在 `./rows.ts` 里，是纯函数。
 * 这一层只剩「异步 + 可变状态」，与 `project/store.ts` 是同一个分层。
 *
 * ## ⚠️ 一条真实的竞态：终止事件可能比 `start_search` 的返回值先到
 *
 * `start_search` 是先把后台线程 spawn 出去、再返回 taskId 的（见 `src-tauri/src/commands.rs`）。
 * 所以「后台已经在推事件」与「invoke 的 promise 还没 resolve」这两件事会重叠，
 * 而 IPC 上这两条消息谁先到**没有保证**。实测本仓库 107 个文件整次搜索只要 12.7ms——
 * 完全可能 `search-done` 已经躺在事件队列里了，而前端手上还没有 taskId 可以拿它去对。
 *
 * 朴素的写法（`if (taskId !== current()) return`）在这里会**把整次搜索的结果全丢掉**：
 * 面板永远停在「正在搜索…」，而后台其实早就搜完了。这种卡死没有任何报错可查。
 *
 * 所以认任务用的是三个变量而不是一根指针，见 [`createTaskSlot`]：
 *
 * - `adopted`：当前认下来的 taskId。事件到了先看它
 * - `starting`：invoke 已发出、还没回。这个窗口里到达的**任何**未作废的
 *   taskId 都被认下来——那一刻在飞的只可能是它
 * - `retired`：明确作废过的 taskId。被取消的旧任务还会继续推几批（取消是协作式的，
 *   后台线程要跑到下一次检查标志才知道），这些必须丢掉，否则两轮的结果会混在一起
 *
 * 只有 `retired` 能挡住旧批次，只有 `starting` 能接住早到的批次，两条缺一条都是错的。
 * `start_replace` 是同一种命令（同样先 spawn 再返回 id），所以那一份认账逻辑原样复用。
 *
 * ## 四条不变量
 *
 * 1. **心跳批不动结果列表。** `batch.files` 为空时只更新 `filesScanned`。
 *    把它当成「没有结果」的话，十万个文件那 7 秒里面板会先闪一次「没有找到」再出结果。
 * 2. **`filesScanned` 是累计值**，直接赋值，不是累加。
 * 3. **换一次搜索就把上一轮整个扔掉**（行、总账、选中、进度），并作废上一个 taskId。
 * 4. **落盘成功之后预览也整个扔掉。** 见 `replaceHandlers.onDone` 里那条注释。
 */

import { createMemo, createSignal, type Accessor } from 'solid-js'
import {
  describeSearchError,
  startSearch,
  type SearchBatch,
  type SearchError,
  type SearchHandlers,
  type SearchQuery,
  type SearchSummary,
} from '../ipc/search'
import { startReplace, type ReplaceHandlers, type ReplaceProgress, type ReplaceSummary } from '../ipc/replace'
// 取消走的是搜索与替换共用的那一个命令，所以它的封装不挂在 `ipc/search.ts` 上
import { cancelTask } from '../ipc/task'
// 只借这一个纯函数：根的显示名就是路径的最后一段，而「怎么从一条绝对路径里抠出最后一段」
// 这件事在 `tree.ts` 里已经把末尾斜杠、根目录 `/` 这些边界都处理过了（见那边的注释）。
// 自己再写一遍的失败方式是两处对 `/repo/` 这种路径给出不同的名字
import { displayName } from '../project/tree'
import {
  actionForKey,
  describeProgress,
  describeReplaceProgress,
  describeReplaceSummary,
  describeSummary,
  flattenFiles,
  openTarget,
  replaceWarnings,
  unreadableWarning,
  type HitRow,
  type ResultAction,
  type ResultKey,
  type ResultRow,
} from './rows'

/** 搜索词为空时前端自己说的那一句。与 Rust 侧 `build_matcher` 的 `bad_pattern` 文案相同 */
const EMPTY_PATTERN = '搜索词不能为空'

/**
 * 预览与当前条件不一致时那一句。它是唯一会让「替换全部」灰掉而又看不出原因的情况。
 *
 * ⚠️ 措辞里带「工作区」是 M2-F 加的：根清单也在预览指纹里，所以「搜完之后往工作区
 * 添了一个文件夹」与「搜完之后改了搜索词」是同一件事——用户批准的那份清单
 * 已经不是在说当前这些文件夹了
 */
const STALE_PREVIEW = '预览已过期：条件或工作区改过了，重新搜一遍再替换'

/**
 * 「在飞的那一个任务」的认账逻辑，见模块文档那条竞态。
 *
 * 搜索与替换**各一份**：两边各有各的事件流（`vela://search-*` / `vela://replace-*`）、
 * 各有各的「在跑」信号，认账也就各一份。于是搜索那个 slot 的 `starting` 窗口
 * 永远不会看见替换的 id，反之亦然——`accept` 里那条「窗口里到达的就认下来」
 * 的宽松规则，只有在「这个 slot 只可能收到这一类事件」的前提下才是安全的。
 *
 * `retired` 同样各一份：taskId 由 Rust 侧同一个计数器发号、永不重复，
 * 所以两边不可能需要作废对方的 id。
 */
interface TaskSlot {
  /** 这个 taskId 的事件该不该收。收的话顺手把它认下来 */
  accept: (taskId: string) => boolean
  /** invoke 已发出、还没回 */
  begin: () => void
  /** invoke 回来了。`null` = 它 reject 了，压根没起飞，没有任何事件会来 */
  settle: (taskId: string | null) => void
  /** 一次任务结束了：作废它，免得它迟到的批次被下一轮的 `starting` 窗口认下来 */
  finish: (taskId: string) => void
  /** 当前认下来的 taskId。null = 没有在飞的 */
  current: () => string | null
  /** 作废在飞的那一个，并请求取消（换一轮搜索 / 清空结果都走这里） */
  retire: () => void
}

function createTaskSlot(): TaskSlot {
  let adopted: string | null = null
  let starting = false
  /**
   * 作废过的 taskId。一次任务一条，而任务是用户一下一下按出来的，
   * 所以它的增长速度与人的手速同级——不为它设上限。
   */
  const retired = new Set<string>()

  return {
    accept(taskId: string): boolean {
      if (retired.has(taskId)) return false
      if (adopted === taskId) return true
      // `starting` 窗口里到达的、又没被作废过的，只可能是刚发出去的那一次
      if (starting) {
        adopted = taskId
        return true
      }
      return false
    },
    begin() {
      starting = true
    },
    settle(taskId: string | null) {
      starting = false
      // ⚠️ **可能这一轮在 invoke 回来之前就结束了**（done 早到，见模块文档那条竞态）。
      // 那时 `finish` 已经把它作废掉了，这里再认下来会让 `current()` 指着一个已经结束的
      // 任务：`cancel()` 会去取消它，下一轮会再作废它一次。两件事都不炸，但都是白跑一趟
      // IPC，而且读代码的人会以为那一轮还在飞
      if (taskId !== null && !retired.has(taskId)) adopted = taskId
    },
    finish(taskId: string) {
      retired.add(taskId)
      if (adopted === taskId) adopted = null
      starting = false
    },
    current() {
      return adopted
    },
    retire() {
      if (adopted !== null) {
        retired.add(adopted)
        // 不 await：取消只是置一个原子标志，而我们要的是下一轮**立刻**开始。
        // 幂等，taskId 不认识也照样成功，所以没有失败分支要处理
        void cancelTask(adopted)
        adopted = null
      }
      starting = false
    },
  }
}

/**
 * 「替换全部」按下之后弹出来的那张确认单上要写的数字。
 *
 * ⚠️ 数的是**文件数与命中行数**，不是处数。处数在这一层根本算不出来：
 * `SearchHit.ranges` 有 32 段的上限（`MAX_RANGES_PER_HIT`），而且可能是空数组
 * （见 `rows.ts` 的 `HitRow.ranges`）。拿它去数「一共多少处」会得到一个偏小的数，
 * 而那个数字是用户批准落盘的唯一依据——偏小比不给还糟。
 *
 * ⚠️ 而且落盘那一侧真的换掉的处数**可以大于**这里显示的行数：预览对单个文件有 500 条
 * 上限（`MAX_HITS_PER_FILE`），落盘没有。所以 `truncated` 非假时这句话必须出现在确认单上。
 */
export interface ConfirmApply {
  /** 会被改写的文件数。不含 `skipped` 那些 */
  files: number
  /** 预览里数出来的命中**行**数（同上，不含被跳过的文件下的那些） */
  lines: number
  /** 正开着一个标签、且有未保存改动，因而会被跳过的文件数 */
  skipped: number
  /**
   * 替换内容是空串——这一轮是把每一处命中**删掉**。
   *
   * 单独一个字段而不是让对话框自己去读 `replacement()`：那张单子必须自成一体，
   * 而「删掉」与「换成某个词」在措辞上不是同一句话能说完的
   */
  deleting: boolean
  /** 预览不完整：撞到了总条数上限，或某个文件撞到了单文件上限 */
  truncated: boolean
}

/** 面板上那两格文本框。`focusTarget` 用的就是它 */
export type FocusTarget = 'pattern' | 'replacement'

export interface SearchPanel {
  /** 面板展开着没有。收起时状态一律留着：重新展开该看到上次那份结果 */
  readonly visible: Accessor<boolean>
  /** 展开面板并把焦点放到输入框上（`Mod+Shift+F` 走这里） */
  show: () => void
  hide: () => void
  /**
   * 展开面板并**确保**处在替换模式（`Mod+Shift+H` 走这里）。
   *
   * ⚠️ 不复用 `toggleReplaceMode`：那个在已经开着的时候会把模式**关掉**，于是连按两次
   * `Mod+Shift+H` 会看到「面板还在、下面那一排没了」。快捷键的语义是「我要替换」，
   * 不是「翻一下开关」——面板上那个「替换」按钮才是开关。
   */
  showReplace: () => void

  readonly pattern: Accessor<string>
  setPattern: (value: string) => void
  readonly literal: Accessor<boolean>
  readonly caseSensitive: Accessor<boolean>
  readonly wholeWord: Accessor<boolean>
  /** 三个开关都是「再按一次取消」，所以只有一个 toggle */
  toggle: (which: 'literal' | 'caseSensitive' | 'wholeWord') => void

  /**
   * 替换模式开着没有。翻它的是面板上那个「替换」按钮；`Mod+Shift+H` 走 `showReplace`。
   *
   * 开着时 `query()` 会带上 `replace`，于是**同一条** `start_search` 回来的命中里
   * 多一个 `replaced` 预览。这是刻意的：预览不另起一条 IPC，Rust 侧也就只有一份
   * 匹配与模板展开实现，「所见即所做」才是结构上成立的而不是靠两边对齐
   */
  readonly replaceMode: Accessor<boolean>
  toggleReplaceMode: () => void
  readonly replacement: Accessor<string>
  setReplacement: (value: string) => void

  /** 后台还在搜。⚠️ 为真时 `rows()` 是**部分**结果，不是最终结果 */
  readonly running: Accessor<boolean>
  /** 后台还在写盘。⚠️ 与 `running` 分开：两者的进度口径完全不同，合成一个信号就得再带一个「是哪种」 */
  readonly replacing: Accessor<boolean>
  /** 一句可以直接显示的人话。null = 没出错 */
  readonly error: Accessor<string | null>
  /** 搜索的终止事件带来的总账。null = 还没结束过，或者刚换了一轮 */
  readonly summary: Accessor<SearchSummary | null>
  /** 替换的终止事件带来的总账。**落盘那一轮唯一权威的最终数字** */
  readonly replaceSummary: Accessor<ReplaceSummary | null>
  /** 替换飞行途中的快照。⚠️ 可能一次都不来（见 `ReplaceHandlers.onProgress`） */
  readonly replaceProgress: Accessor<ReplaceProgress | null>
  /** 心跳与结果批一路带上来的累计扫描数，进度就靠它 */
  readonly filesScanned: Accessor<number>
  readonly rows: Accessor<ResultRow[]>
  /** 选中行的**下标**。null = 没选中，见 `rows.ts` 的 `actionForKey` */
  readonly selected: Accessor<number | null>

  /**
   * 手上这份预览还与当前条件一致吗。**假 = 已经过期**。
   *
   * 过期的唯一来源是用户在搜完之后动了条件（搜索词、三个开关、替换内容、或替换模式本身）。
   * 那时 `rows()` 里的 `replaced` 说的是**上一份**条件下的结果，而 `confirmApply` 发出去的
   * 是**当前**条件——批准的和发生的不是同一件事。
   *
   * ⚠️ 落盘本身不会因此写错东西（`start_replace` 拿着当前 query 从头再走一遍），
   * 所以这不是数据安全问题，而是**人批准了一份他没看到的清单**。
   * 处理办法是把「替换全部」灰掉并说清为什么，而不是悄悄把行清掉：
   * 清掉的话用户看到的是「刚搜出来的结果凭空没了」
   */
  readonly stale: Accessor<boolean>
  /** 「替换全部」此刻能不能按。灰掉的每一个理由都必须能从 `stale` / `running` / `replacing` 读出来 */
  readonly canApply: Accessor<boolean>
  /** 非 null = 确认单正摊在屏幕上。形状见 `ConfirmApply` */
  readonly confirm: Accessor<ConfirmApply | null>

  /** 面板底部那一句：进度 / 总账 / 空状态 */
  readonly statusLine: Accessor<string>
  /**
   * 「这份总账得打个折扣」的那些话，要用警告色**逐行**渲染。空数组 = 没有任何保留。
   *
   * ⚠️ 是数组而不是一句：落盘那一轮可以同时「有 2 个文件没写成」+「有 1 个文件正开着被跳过」，
   * 把它们拼成一句用逗号隔开的话，用户只会读到前半句
   */
  readonly warnings: Accessor<string[]>
  /** 每加一就意味着「请再 focus 一次输入框」。已经是展开状态时也要能把焦点抢回来 */
  readonly focusRequest: Accessor<number>
  /**
   * 最近一次 `show` / `showReplace` 要把焦点放进哪一格。
   *
   * ⚠️ 存在的唯一理由是**批处理顺序不可靠**：`showReplace` 连着写 `replaceMode` 与
   * `focusRequest` 两个信号，而命令分派挂在 window 上、不在 Solid 的事件批里，
   * 于是两次写各自跑完一轮更新——组件里那两个 effect 谁后跑完全由写入顺序决定。
   * 靠「后跑的赢」来定焦点，等价于把行为交给一个看不见的时序。
   * 有了这一个字段，两条路都指向同一格，顺序就不再有意义
   */
  readonly focusTarget: Accessor<FocusTarget>

  /** 按当前输入起一次搜索（替换模式下就是起一次**预览**）。上一轮还在飞就先作废它 */
  search: () => Promise<void>
  /**
   * 请求取消在飞的那一次。
   *
   * 搜索与替换按构造不会同时在飞（`search()` 在替换期间直接返回，`canApply` 要求搜索已经结束），
   * 所以一个方法就够了，不需要调用方说清「取消哪一个」——那种参数存在的唯一效果是
   * 让人以为可以同时开着两次
   *
   * ⚠️ 取消**不是撤销**：已经写完的文件留在磁盘上，由随后的 done 事件如实报出
   */
  cancel: () => Promise<void>
  /** 把结果、两份总账、错误一次清干净。不动搜索词、三个开关与替换内容 */
  clear: () => void

  /** 摊开确认单。条件不满足时什么都不做（按钮本来就是灰的，这只是第二道） */
  askApply: () => void
  dismissConfirm: () => void
  /** 用户批准了：落盘。⚠️ 这一步之后磁盘上的东西就变了，Vela 没有跨文件撤销 */
  confirmApply: () => Promise<void>

  select: (index: number) => void
  /** 执行一个 `actionForKey` 或点击产生的动作 */
  run: (action: ResultAction) => void
  /**
   * 键盘入口：收窄 `e.key` 之后交给 `actionForKey`。
   *
   * 返回**执行掉的那个动作**，好让调用方决定要不要 `preventDefault`、要不要把选中行滚进
   * 可视区。不返回的话组件就得自己再算一次 `actionForKey`——同一个纯函数在两个地方各算
   * 一遍，而两边读的是同一份状态，那种重复只会漂移
   */
  key: (key: ResultKey) => ResultAction
  /** 点一行。文件行也会跳，落到它的第一个命中（见 `openTarget`） */
  clickRow: (index: number) => void

  /**
   * 交给 `attachSearchListeners` 的三个回调。
   *
   * ⚠️ **必须在第一次 `search()` 之前就挂好，而且挂着不放**——`listen` 本身是异步的，
   * 注册之前到达的事件永久丢失。所以这一份是 App 在 `onMount` 里挂一次的，
   * 不是每次搜索挂一遍，见 `src/ipc/search.ts` 的 `attachSearchListeners`。
   */
  readonly handlers: SearchHandlers
  /** 交给 `attachReplaceListeners` 的三个回调。同一条规矩：启动时挂一次，与上面那组**同时挂着** */
  readonly replaceHandlers: ReplaceHandlers
}

export interface SearchPanelOptions {
  /**
   * 工作区的根清单从哪来，顺序就是侧边栏从上到下的顺序。App 注入 `tree.roots`。
   *
   * 注入而不是让这一层 import `createProjectTree`：与 `project/store.ts` 的 `openFile`
   * 同一条道理——store 不该知道宿主长什么样，而且直接 import 会让两层互相引用成环。
   *
   * ⚠️ 空数组 = 没打开任何文件夹（「没打开」只有这一种写法，见 `project/store.ts` 文件头）。
   * 这一层拿到空数组就报一句「还没打开文件夹」，绝不发一次 `start_search`——
   * Rust 侧的 `validate` 也会拒掉空的 `roots`，两边各挡一次
   */
  roots: () => readonly string[]
  /** 点一条命中时做什么。App 注入「打开这个文件并跳到那一行、选中那一段」 */
  openHit?: (hit: HitRow) => void | Promise<void>
  /**
   * 正开着且有未保存改动的那些文件的**绝对路径**，原样递（见 `ReplaceRequest.skip`）。
   * App 注入 `workspace.dirtyPaths`。
   *
   * 两个用途，缺一不可：
   *
   * 1. 落盘时递进 `skip`，让 Rust 侧别碰它们。不递的话用户编辑器里那份未保存的改动
   *    会变成「与磁盘不一致的孤儿」，而他下一次 ⌘S 又把刚落盘的结果盖回去
   * 2. 摊行时标出 `FileRow.skipped`，让**预览**就说清这几个文件不会被改。
   *    `start_search` 不知道 `skip` 的存在，不标的话用户批准的是一份做不到的清单
   *
   * ⚠️ 每次调用都重新求值（不缓存成 Set）：这两处调用点分别在「一批结果到达」与
   * 「用户按下替换全部」，都是低频，而缓存下来就要回答「什么时候失效」——
   * 那份复杂度换来的是一次几十元素的数组遍历
   */
  skipPaths?: () => string[]
  /**
   * 落盘真的改了东西之后做什么。App 注入「把工作区里那些**干净的**标签重新读一遍」。
   *
   * `filesChanged === 0` 时不调用：一个文件都没动，重新读盘是白跑，
   * 而且「读回来发现内容一样就什么都不做」那条判断（见 `DocumentModel.reload`）
   * 会替我们把这件事变成空操作——但空操作也是要付 IPC 的
   */
  onApplied?: (summary: ReplaceSummary) => void | Promise<void>
}

export function createSearchPanel(options: SearchPanelOptions): SearchPanel {
  const [visible, setVisible] = createSignal(false)
  const [focusRequest, setFocusRequest] = createSignal(0)
  const [focusTarget, setFocusTarget] = createSignal<FocusTarget>('pattern')

  const [pattern, setPattern] = createSignal('')
  const [literal, setLiteral] = createSignal(false)
  const [caseSensitive, setCaseSensitive] = createSignal(false)
  const [wholeWord, setWholeWord] = createSignal(false)
  const [replaceMode, setReplaceMode] = createSignal(false)
  const [replacement, setReplacement] = createSignal('')

  const [running, setRunning] = createSignal(false)
  const [replacing, setReplacing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [summary, setSummary] = createSignal<SearchSummary | null>(null)
  const [replaceSummary, setReplaceSummary] = createSignal<ReplaceSummary | null>(null)
  const [replaceProgress, setReplaceProgress] = createSignal<ReplaceProgress | null>(null)
  const [filesScanned, setFilesScanned] = createSignal(0)
  const [rows, setRows] = createSignal<ResultRow[]>([])
  const [selected, setSelected] = createSignal<number | null>(null)
  const [confirm, setConfirm] = createSignal<ConfirmApply | null>(null)
  /**
   * 这一份预览是在什么条件下搜出来的（**根清单 + `query()`** 的序列化）。null = 手上没有预览。
   *
   * 存**序列化结果**而不是逐个比对六个字段：字段会加（`include`/`exclude` 哪天进 UI 就是两个），
   * 而漏比一个的失败方式是「用户批准了一份他没看到的清单」——那正是 `stale` 存在的理由。
   * `JSON.stringify` 的键顺序由对象字面量的书写顺序决定，是稳定的。
   *
   * ⚠️ 根清单也在里面（M2-F）。少了它的话「在文件夹 A 里预览、然后打开文件夹 B、
   * 再点替换全部」会改掉 B——用户批准的清单在 A 里，而按钮是可点的。
   * 单根时代这一条已经是个洞，多根之后「工作区变了」成了一个日常操作
   * （添加/移除文件夹），于是它必须堵上
   */
  const [previewKey, setPreviewKey] = createSignal<string | null>(null)

  /**
   * 那一轮搜索**起飞时**的根清单。
   *
   * ⚠️ 结果行上的根名只能按这一份解释：Rust 推回来的 `rootIndex` 是它在
   * `start_search` 收到的那个数组里的下标，而用户完全可能在结果还在飞的时候加一个根、
   * 或者移掉一个。拿**当时现读**的 `options.roots()` 去解，第二个根里的命中就会被标成
   * 第三个根的名字——不报错，只是每一行前面的那个名字都指错了地方，
   * 而点下去打开的又确实是对的文件，所以用户连怀疑都不会怀疑。
   * `stale()` 会同时亮起，但亮起之前那几批已经画出来了
   */
  const [sentRoots, setSentRoots] = createSignal<readonly string[]>([])

  /**
   * `SearchFile.rootIndex` → 画在 `rel` 前面的那个名字。
   *
   * 少于两个根一律给空串：单根时每一行前面都挂着同一个项目名，那是纯噪音，
   * 而侧边栏与窗口标题已经说过一次「现在在哪个项目里」了。
   * 越界也给空串（手改过的存档之外不会发生，但画一个 `undefined` 出来更糟）
   */
  const rootLabelOf = (rootIndex: number): string => {
    const list = sentRoots()
    if (list.length < 2) return ''
    const at = list[rootIndex]
    return at === undefined ? '' : displayName(at)
  }

  const searchSlot = createTaskSlot()
  const applySlot = createTaskSlot()

  /**
   * 当前工作区的根清单。
   *
   * ⚠️ 每次都现读，不缓存：`stale()` 是一条 memo，它要靠读这个信号才能在
   * 「用户换掉了工作区」时重新求值——缓存下来就等于告诉用户「这份预览还新鲜」，
   * 而它其实是照着另一批文件夹搜出来的
   */
  const currentRoots = (): string[] => [...options.roots()]

  /** 预览指纹：根清单与查询条件一起序列化，`stale()` 拿它与当前状态比 */
  const fingerprint = (roots: readonly string[], sent: SearchQuery): string => JSON.stringify({ roots, query: sent })

  const query = (): SearchQuery => ({
    pattern: pattern(),
    literal: literal(),
    caseSensitive: caseSensitive(),
    wholeWord: wholeWord(),
    // include / exclude 刻意不发：Rust 侧容器上有 `#[serde(default)]`，缺 key 就是「不限」。
    // 前端替它补两个空数组等于把默认值抄两份，哪天那边改了默认两边就悄悄分岔了
    //
    // ⚠️ `replace` 挂在**模式开关**上，不挂在「替换内容非空」上：空串是「把每一处命中删掉」
    // 那个合法操作。挂错条件的后果是删不掉任何东西，而面板看起来一切正常
    ...(replaceMode() ? { replace: replacement() } : {}),
  })

  const stale = createMemo(() => {
    const key = previewKey()
    // 没有搜索总账 = 手上根本没有一份预览（没搜过，或那一轮起飞就失败了），
    // 那时说「预览已过期」是无中生有
    if (key === null || summary() === null) return false
    return key !== fingerprint(currentRoots(), query())
  })

  const canApply = createMemo(() => {
    if (!replaceMode() || running() || replacing() || stale()) return false
    // 没打开文件夹时连预览都搜不出来，这一条只是把「还没打开文件夹」那句留给 `search()` 说
    if (options.roots().length === 0) return false
    const done = summary()
    return done !== null && done.hits > 0
  })

  const statusLine = createMemo(() => {
    // 替换的总账压过搜索的总账：`resetResults` 已经把搜索那一份清掉了（见不变量 4），
    // 这里排一下序只是为了让「先看哪个」这件事写在明面上
    const applied = replaceSummary()
    if (applied !== null) return describeReplaceSummary(applied)
    if (replacing()) {
      const snapshot = replaceProgress()
      // 一个快照都没来过是**正常的**（见 `ReplaceHandlers.onProgress`），
      // 所以这里给一句不带数字的，而不是显示「已改 0 个文件」假装收到了
      return snapshot === null ? '正在替换…' : describeReplaceProgress(snapshot)
    }
    const done = summary()
    if (done !== null) return describeSummary(done)
    if (running()) return describeProgress(filesScanned())
    if (rows().length > 0) return `共 ${rows().length} 行`
    return '在项目里搜一遍：输入搜索词，按 Enter'
  })

  const warnings = createMemo<string[]>(() => {
    const applied = replaceSummary()
    // 落盘那一轮的保留意见。与下面那份搜索的**互斥**：`resetResults` 清掉了 `summary`
    if (applied !== null) return replaceWarnings(applied)
    const out: string[] = []
    if (replaceMode() && stale()) out.push(STALE_PREVIEW)
    const done = summary()
    if (done !== null) {
      const text = unreadableWarning(done)
      if (text !== null) out.push(text)
    }
    return out
  })

  /**
   * 从当前的 `rows()` 上数出确认单要写的数字。
   *
   * 一趟扫完：文件行决定「它下面那些命中行算不算」，所以顺手记一个 `skipping` 游标，
   * 而不是给每行都去查一次它属于哪个文件——扁平数组里没有回指的指针（见 `rows.ts` 模块文档）
   */
  function countPreview(): ConfirmApply {
    let files = 0
    let lines = 0
    let skipped = 0
    let truncated = summary()?.truncated ?? false
    let skipping = false
    for (const row of rows()) {
      if (row.kind === 'file') {
        skipping = row.skipped
        if (row.skipped) skipped += 1
        else files += 1
        // 单文件撞上限与总条数撞上限是两回事，但对用户是同一句话：这份清单不完整
        if (row.truncated) truncated = true
      } else if (!skipping) {
        lines += 1
      }
    }
    return { files, lines, skipped, deleting: replacement() === '', truncated }
  }

  function resetResults() {
    setRows([])
    setSummary(null)
    setReplaceSummary(null)
    setReplaceProgress(null)
    setPreviewKey(null)
    setSentRoots([])
    setError(null)
    setFilesScanned(0)
    setSelected(null)
  }

  async function search(): Promise<void> {
    // 替换在飞时不接新的搜索：那一轮正在改磁盘，而搜完的结果会把它自己的进度挤掉
    // （两个 `running` 语义的信号同时为真，状态栏只能说一句）。UI 那边搜索键也是灰的
    if (replacing()) return
    const roots = currentRoots()
    if (roots.length === 0) {
      // 与 `project/store.ts` 的 `NO_FOLDER` 同一句话：没打开文件夹时所有项目级动作都说它
      setError('还没打开文件夹')
      setVisible(true)
      return
    }
    if (pattern() === '') {
      // ⚠️ 判的是 `=== ''` 而不是 trim 之后为空：`"   "` 是一个合法的正则
      // （匹配三个连续空格），Rust 侧也只拒真的空串。前端替它 trim 就是把
      // 一个用户真想搜的东西悄悄改掉
      setError(EMPTY_PATTERN)
      setVisible(true)
      return
    }

    // 上一轮还在飞：作废它。取消是协作式的，它的批次还会再来几批，
    // 所以光靠「换了 adopted」挡不住，必须进 retired
    searchSlot.retire()
    resetResults()
    setRunning(true)
    setVisible(true)

    const sent = query()
    // 在 await 之前就记下条件：done 可能比返回值先到（见模块文档），
    // 那时 `summary` 已经填上了，而 `stale` 得能立刻得出「一致」
    setPreviewKey(fingerprint(roots, sent))
    setSentRoots(roots)
    searchSlot.begin()

    try {
      const taskId = await startSearch(roots, sent)
      // 返回值是权威的：即使 `starting` 窗口里已经认下了同一个 id，这里也只是再写一遍。
      // 两个不同的 id 是不可能的——同一时刻只有一次 `start_search` 在飞
      searchSlot.settle(taskId)
    } catch (err) {
      // reject = 这次搜索压根没开始（起飞前检查没过），所以没有任何事件会来，
      // 也不需要作废谁。这条规则由 `run.rs` 的 `preflight_roots` 与 `search_roots`
      // 共用 `check_root` + `compile` 钉住——⚠️ 多根之下「所有根都查完了才开工」，
      // 于是第二个根不合法时第一个根一个文件都不会被读
      searchSlot.settle(null)
      setRunning(false)
      setError(describeSearchError(err))
    }
  }

  async function cancel(): Promise<void> {
    // 两个 slot 按构造不会同时在飞（`search()` 在替换期间直接返回，`canApply` 要求搜索已结束），
    // 所以这个 `??` 读作「在飞的那一个」就好
    const taskId = applySlot.current() ?? searchSlot.current()
    if (taskId === null) return
    // 状态一律不动：已经推出去的批次仍然有效，随后的 done 里 `cancelled` 为真，
    // 由它来收尾。这里自己把 running 置假的话，那一批迟到的结果会落在一个
    // 「已经结束」的面板上，用户看到的是数字自己在动
    await cancelTask(taskId)
  }

  function clear() {
    searchSlot.retire()
    applySlot.retire()
    setRunning(false)
    setReplacing(false)
    setConfirm(null)
    resetResults()
  }

  /**
   * 展开面板并要求把焦点放进 `target` 那一格。两个公开入口只差这一个参数。
   *
   * ⚠️ `setFocusTarget` 必须写在 `setFocusRequest` **之前**：命令分派不在 Solid 的事件批里，
   * 每次写各自跑完一轮更新，所以组件那个 effect 被触发时读到的必须是**已经换好**的目标。
   * 反过来写的话 `Mod+Shift+H` 会把焦点留在搜索词那一格——而这正是它当初坏掉的方式
   */
  function requestFocus(target: FocusTarget) {
    setFocusTarget(target)
    setVisible(true)
    // 用自增的计数而不是布尔：面板已经展开时再按一次 `Mod+Shift+F`，
    // 布尔值不变就不会触发 effect，焦点也就抢不回来
    setFocusRequest((n) => n + 1)
  }

  function show() {
    requestFocus('pattern')
  }

  function showReplace() {
    // 已经开着时一个信号都不动：`toggleReplaceMode` 会把它关掉，而 `Mod+Shift+H`
    // 连按两次的语义是「我要替换」，不是「翻一下开关」。理由见接口上那段
    if (!replaceMode()) toggleReplaceMode()
    // 这里一律说要「替换为」那一格；搜索词还空着时该留在上面那一格，
    // 那条判断在组件里（它才看得到 `replaceEl` 有没有被渲染出来）
    requestFocus('replacement')
  }

  function hide() {
    setVisible(false)
    // 刻意不取消在飞的任务：收起面板只是不看它，重新展开该看到结果。
    // 真要不搜了有「取消」按钮，那才是明确表达意图的动作。
    // ⚠️ 替换在飞时也一样——它改的是磁盘，收不收起面板都得让它跑完或被人明确取消
  }

  function askApply() {
    if (!canApply()) return
    setConfirm(countPreview())
  }

  function dismissConfirm() {
    setConfirm(null)
  }

  async function confirmApply(): Promise<void> {
    setConfirm(null)
    const roots = currentRoots()
    if (roots.length === 0) {
      setError('还没打开文件夹')
      return
    }
    // ⚠️ 再查一次 `stale()`：确认对话框开着的那一会儿里，用户完全可能改了搜索词、
    // 改了替换内容、或者动了工作区（`askApply` 那一次检查已经过去了）。
    // 这一条挡的是「用户批准的清单与实际落盘的清单不是同一份」，
    // 而它是全 Vela 唯一一处批量写盘，所以宁可多问一次也不要猜
    if (stale()) {
      setError(STALE_PREVIEW)
      return
    }
    setReplacing(true)
    setError(null)
    applySlot.begin()
    try {
      // ⚠️ 这里递的是**当前**的 `query()` 与**当前**的根清单，与预览那一次是同一个函数
      // 产出的同一个形状。上面那条 `stale()` 检查保证了两份指纹逐字段相同，
      // 所以用户批准的那份清单与实际发生的条件一致——这正是 `previewKey` 存在的全部理由
      const skip = options.skipPaths?.() ?? []
      const taskId = await startReplace(roots, query(), skip)
      applySlot.settle(taskId)
    } catch (err) {
      // 起飞前检查没过（`bad_replacement` 之类），磁盘上一个字节都没动
      applySlot.settle(null)
      setReplacing(false)
      setError(describeSearchError(err))
    }
  }

  const handlers: SearchHandlers = {
    onBatch(taskId: string, batch: SearchBatch) {
      if (!searchSlot.accept(taskId)) return
      // 心跳批：只更新进度。⚠️ 不能顺手把 running 置假或把 summary 填上——
      // 结束的唯一信号是 done
      setFilesScanned(batch.filesScanned)
      if (batch.files.length === 0) return
      // 增量拼接，理由见 `rows.ts` 的 `flattenFiles`
      const skip = new Set(options.skipPaths?.() ?? [])
      setRows((prev) => {
        const next = flattenFiles(batch.files, (path) => skip.has(path), rootLabelOf)
        return prev.length === 0 ? next : [...prev, ...next]
      })
    },
    onDone(taskId: string, next: SearchSummary) {
      if (!searchSlot.accept(taskId)) return
      searchSlot.finish(taskId)
      setRunning(false)
      // 总账里的 `filesScanned` 比最后一个心跳批更准（它含最后那几个文件），所以覆盖一次
      setFilesScanned(next.filesScanned)
      setSummary(next)
    },
    onFailed(taskId: string, err: SearchError) {
      if (!searchSlot.accept(taskId)) return
      searchSlot.finish(taskId)
      setRunning(false)
      setError(describeSearchError(err))
    },
  }

  const replaceHandlers: ReplaceHandlers = {
    onProgress(taskId: string, progress: ReplaceProgress) {
      if (!applySlot.accept(taskId)) return
      setReplaceProgress(progress)
    },
    onDone(taskId: string, next: ReplaceSummary) {
      if (!applySlot.accept(taskId)) return
      applySlot.finish(taskId)
      setReplacing(false)
      // ⚠️ 不变量 4：先把预览整个扔掉，再把落盘的总账填上（顺序不能反，
      // `resetResults` 会连 `replaceSummary` 一起清）。
      //
      // 留着那些行的后果不是「多显示一点东西」，而是一个能改坏磁盘的坑：
      // 行上的 `replaced` 说的是**写盘之前**的样子，而「替换全部」此刻仍然可点
      // （条件没变，`stale` 为假）。把 `foo` 换成 `foobar` 的人再按一次，
      // 第二轮会接着长——而他看到的预览还是第一轮那份。
      // 清掉之后 `summary` 为 null，`canApply` 随之为假，必须重新搜一遍才能再换
      resetResults()
      setReplaceSummary(next)
      if (next.filesChanged > 0) void options.onApplied?.(next)
    },
    onFailed(taskId: string, err: SearchError) {
      if (!applySlot.accept(taskId)) return
      applySlot.finish(taskId)
      setReplacing(false)
      // 这一支几乎只有「root 在预览与落盘之间被删掉」一种，磁盘上没动过东西，
      // 所以预览可以留着——用户修好根目录之后重新搜一遍就行
      setError(describeSearchError(err))
    },
  }

  function run(action: ResultAction) {
    switch (action.kind) {
      case 'none':
        return
      case 'select':
        setSelected(action.index)
        return
      case 'open': {
        setSelected(action.index)
        const hit = openTarget(rows(), action.index)
        // 文件行一条命中都没有时给出 null（见 `openTarget`）。那种行本来也点不出什么，
        // 静默不动比报一句「这个文件没有命中」有用——它压根不该出现在结果里
        if (hit !== null) void options.openHit?.(hit)
        return
      }
    }
  }

  function key(which: ResultKey): ResultAction {
    const action = actionForKey(rows().length, selected(), which)
    run(action)
    return action
  }

  function clickRow(index: number) {
    // 点一下就跳，不分成「先选中再双击打开」：结果列表不是文件树，
    // 每一行都是一个明确的去处，而多一次点击只会让「搜到了却跳不过去」显得像坏了
    run({ kind: 'open', index })
  }

  function toggle(which: 'literal' | 'caseSensitive' | 'wholeWord') {
    if (which === 'literal') setLiteral((v) => !v)
    else if (which === 'caseSensitive') setCaseSensitive((v) => !v)
    else setWholeWord((v) => !v)
  }

  function toggleReplaceMode() {
    setReplaceMode((v) => !v)
    // 刻意不清结果：切回纯搜索时上一轮的预览行照样能看（它们只是不再带 `replaced`），
    // 而 `stale` 会如实说出「条件变了」。清掉的话「切一下模式就丢结果」很难联想到原因
    setConfirm(null)
  }

  return {
    visible,
    show,
    showReplace,
    hide,
    pattern,
    setPattern,
    literal,
    caseSensitive,
    wholeWord,
    toggle,
    replaceMode,
    toggleReplaceMode,
    replacement,
    setReplacement,
    running,
    replacing,
    error,
    summary,
    replaceSummary,
    replaceProgress,
    filesScanned,
    rows,
    selected,
    stale,
    canApply,
    confirm,
    statusLine,
    warnings,
    focusRequest,
    focusTarget,
    search,
    cancel,
    clear,
    askApply,
    dismissConfirm,
    confirmApply,
    select: setSelected,
    run,
    key,
    clickRow,
    handlers,
    replaceHandlers,
  }
}
