/**
 * 搜索面板的状态：搜什么、搜到哪了、结果有哪些行、选中哪一行。
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
 * 所以认任务用的是三个变量而不是一根指针：
 *
 * - `adopted`：当前认下来的 taskId。事件到了先看它
 * - `starting`：`start_search` 已发出、还没回。这个窗口里到达的**任何**未作废的
 *   taskId 都被认下来（`adopt`）——那一刻在飞的只可能是它
 * - `retired`：明确作废过的 taskId。被取消的旧搜索还会继续推几批（取消是协作式的，
 *   后台线程要跑到下一次检查标志才知道），这些必须丢掉，否则两轮搜索的结果会混在一起
 *
 * 只有 `retired` 能挡住旧批次，只有 `starting` 能接住早到的批次，两条缺一条都是错的。
 *
 * ## 三条不变量
 *
 * 1. **心跳批不动结果列表。** `batch.files` 为空时只更新 `filesScanned`。
 *    把它当成「没有结果」的话，十万个文件那 7 秒里面板会先闪一次「没有找到」再出结果。
 * 2. **`filesScanned` 是累计值**，直接赋值，不是累加。
 * 3. **换一次搜索就把上一轮整个扔掉**（行、总账、选中、进度），并作废上一个 taskId。
 */

import { createMemo, createSignal, type Accessor } from 'solid-js'
import {
  cancelSearch,
  describeSearchError,
  startSearch,
  type SearchBatch,
  type SearchError,
  type SearchHandlers,
  type SearchQuery,
  type SearchSummary,
} from '../ipc/search'
import {
  actionForKey,
  describeProgress,
  describeSummary,
  flattenFiles,
  openTarget,
  unreadableWarning,
  type HitRow,
  type ResultAction,
  type ResultKey,
  type ResultRow,
} from './rows'

/** 搜索词为空时前端自己说的那一句。与 Rust 侧 `build_matcher` 的 `bad_pattern` 文案相同 */
const EMPTY_PATTERN = '搜索词不能为空'

export interface SearchPanel {
  /** 面板展开着没有。收起时状态一律留着：重新展开该看到上次那份结果 */
  readonly visible: Accessor<boolean>
  /** 展开面板并把焦点放到输入框上（`Mod+Shift+F` 走这里） */
  show: () => void
  hide: () => void

  readonly pattern: Accessor<string>
  setPattern: (value: string) => void
  readonly literal: Accessor<boolean>
  readonly caseSensitive: Accessor<boolean>
  readonly wholeWord: Accessor<boolean>
  /** 三个开关都是「再按一次取消」，所以只有一个 toggle */
  toggle: (which: 'literal' | 'caseSensitive' | 'wholeWord') => void

  /** 后台还在跑。⚠️ 为真时 `rows()` 是**部分**结果，不是最终结果 */
  readonly running: Accessor<boolean>
  /** 一句可以直接显示的人话。null = 没出错 */
  readonly error: Accessor<string | null>
  /** 终止事件带来的总账。null = 还没结束过，或者刚换了一轮 */
  readonly summary: Accessor<SearchSummary | null>
  /** 心跳与结果批一路带上来的累计扫描数，进度就靠它 */
  readonly filesScanned: Accessor<number>
  readonly rows: Accessor<ResultRow[]>
  /** 选中行的**下标**。null = 没选中，见 `rows.ts` 的 `actionForKey` */
  readonly selected: Accessor<number | null>

  /** 面板底部那一句：进度 / 总账 / 空状态 */
  readonly statusLine: Accessor<string>
  /** 「有东西没读成」那一句，要用警告色单独渲染。null = 没有 */
  readonly warning: Accessor<string | null>
  /** 每加一就意味着「请再 focus 一次输入框」。已经是展开状态时也要能把焦点抢回来 */
  readonly focusRequest: Accessor<number>

  /** 按当前输入起一次搜索。上一轮还在飞就先作废它 */
  search: () => Promise<void>
  /** 请求取消在飞的那一次。结果与总账由随后的 done 事件收尾，这里不自己改状态 */
  cancel: () => Promise<void>
  /** 把结果、总账、错误一次清干净。不动搜索词与三个开关 */
  clear: () => void

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
}

export interface SearchPanelOptions {
  /**
   * 项目根从哪来。App 注入 `tree.root`。
   *
   * 注入而不是让这一层 import `createProjectTree`：与 `project/store.ts` 的 `openFile`
   * 同一条道理——store 不该知道宿主长什么样，而且直接 import 会让两层互相引用成环。
   */
  root: () => string | null
  /** 点一条命中时做什么。App 注入「打开这个文件并跳到那一行、选中那一段」 */
  openHit?: (hit: HitRow) => void | Promise<void>
}

export function createSearchPanel(options: SearchPanelOptions): SearchPanel {
  const [visible, setVisible] = createSignal(false)
  const [focusRequest, setFocusRequest] = createSignal(0)

  const [pattern, setPattern] = createSignal('')
  const [literal, setLiteral] = createSignal(false)
  const [caseSensitive, setCaseSensitive] = createSignal(false)
  const [wholeWord, setWholeWord] = createSignal(false)

  const [running, setRunning] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [summary, setSummary] = createSignal<SearchSummary | null>(null)
  const [filesScanned, setFilesScanned] = createSignal(0)
  const [rows, setRows] = createSignal<ResultRow[]>([])
  const [selected, setSelected] = createSignal<number | null>(null)

  /** 见模块文档那条竞态。三个都不是 signal：没有任何渲染依赖它们 */
  let adopted: string | null = null
  let starting = false
  /**
   * 作废过的 taskId。一次搜索一条，而搜索是用户一下一下按出来的，
   * 所以它的增长速度与人的手速同级——不为它设上限。
   */
  const retired = new Set<string>()

  const query = (): SearchQuery => ({
    pattern: pattern(),
    literal: literal(),
    caseSensitive: caseSensitive(),
    wholeWord: wholeWord(),
    // include / exclude 刻意不发：Rust 侧容器上有 `#[serde(default)]`，缺 key 就是「不限」。
    // 前端替它补两个空数组等于把默认值抄两份，哪天那边改了默认两边就悄悄分岔了
  })

  const statusLine = createMemo(() => {
    const done = summary()
    if (done !== null) return describeSummary(done)
    if (running()) return describeProgress(filesScanned())
    if (rows().length > 0) return `共 ${rows().length} 行`
    return '在项目里搜一遍：输入搜索词，按 Enter'
  })

  const warning = createMemo(() => {
    const done = summary()
    return done === null ? null : unreadableWarning(done)
  })

  /** 这个 taskId 的事件该不该收。收的话顺手把它认下来 */
  function accept(taskId: string): boolean {
    if (retired.has(taskId)) return false
    if (adopted === taskId) return true
    // `starting` 窗口里到达的、又没被作废过的，只可能是刚发出去的那一次
    if (starting) {
      adopted = taskId
      return true
    }
    return false
  }

  /** 一次搜索结束了：作废它，免得它迟到的批次被下一轮的 `starting` 窗口认下来 */
  function finish(taskId: string) {
    retired.add(taskId)
    if (adopted === taskId) adopted = null
    starting = false
    setRunning(false)
  }

  function resetResults() {
    setRows([])
    setSummary(null)
    setError(null)
    setFilesScanned(0)
    setSelected(null)
  }

  async function search(): Promise<void> {
    const at = options.root()
    if (at === null) {
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
    if (adopted !== null) {
      retired.add(adopted)
      // 不 await：取消只是置一个原子标志，而我们要的是新一轮**立刻**开始。
      // 幂等，taskId 不认识也照样成功，所以没有失败分支要处理
      void cancelSearch(adopted)
      adopted = null
    }
    resetResults()
    setRunning(true)
    setVisible(true)
    starting = true

    try {
      const taskId = await startSearch(at, query())
      // 返回值是权威的：即使 `starting` 窗口里已经认下了同一个 id，这里也只是再写一遍。
      // 两个不同的 id 是不可能的——同一时刻只有一次 `start_search` 在飞。
      //
      // ⚠️ 但**可能这一轮在 invoke 回来之前就结束了**（done 早到，见模块文档那条竞态）。
      // 那时 `finish` 已经把它作废掉了，这里再认下来会让 `adopted` 指着一个已经搜完的任务：
      // `cancel()` 会去取消它，下一次 `search()` 会再作废它一次。两件事都不炸，
      // 但都是白跑一趟 IPC，而且读代码的人会以为那一轮还在飞
      starting = false
      if (!retired.has(taskId)) adopted = taskId
    } catch (err) {
      // reject = 这次搜索压根没开始（起飞前检查没过），所以没有任何事件会来，
      // 也不需要作废谁。这条规则由 `run.rs` 的 `preflight` 与 `search` 共用一份实现钉住
      starting = false
      setRunning(false)
      setError(describeSearchError(err))
    }
  }

  async function cancel(): Promise<void> {
    const taskId = adopted
    if (taskId === null) return
    // 状态一律不动：已经推出去的批次仍然有效，随后的 done 里 `cancelled` 为真，
    // 由它来收尾。这里自己把 running 置假的话，那一批迟到的结果会落在一个
    // 「已经结束」的面板上，用户看到的是数字自己在动
    await cancelSearch(taskId)
  }

  function clear() {
    if (adopted !== null) {
      retired.add(adopted)
      void cancelSearch(adopted)
      adopted = null
    }
    starting = false
    setRunning(false)
    resetResults()
  }

  function show() {
    setVisible(true)
    // 用自增的计数而不是布尔：面板已经展开时再按一次 `Mod+Shift+F`，
    // 布尔值不变就不会触发 effect，焦点也就抢不回来
    setFocusRequest((n) => n + 1)
  }

  function hide() {
    setVisible(false)
    // 刻意不取消在飞的搜索：收起面板只是不看它，重新展开该看到结果。
    // 真要不搜了有「取消」按钮，那才是明确表达意图的动作
  }

  const handlers: SearchHandlers = {
    onBatch(taskId: string, batch: SearchBatch) {
      if (!accept(taskId)) return
      // 心跳批：只更新进度。⚠️ 不能顺手把 running 置假或把 summary 填上——
      // 结束的唯一信号是 done
      setFilesScanned(batch.filesScanned)
      if (batch.files.length === 0) return
      // 增量拼接，理由见 `rows.ts` 的 `flattenFiles`
      setRows((prev) => (prev.length === 0 ? flattenFiles(batch.files) : [...prev, ...flattenFiles(batch.files)]))
    },
    onDone(taskId: string, next: SearchSummary) {
      if (!accept(taskId)) return
      finish(taskId)
      // 总账里的 `filesScanned` 比最后一个心跳批更准（它含最后那几个文件），所以覆盖一次
      setFilesScanned(next.filesScanned)
      setSummary(next)
    },
    onFailed(taskId: string, err: SearchError) {
      if (!accept(taskId)) return
      finish(taskId)
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

  return {
    visible,
    show,
    hide,
    pattern,
    setPattern,
    literal,
    caseSensitive,
    wholeWord,
    toggle,
    running,
    error,
    summary,
    filesScanned,
    rows,
    selected,
    statusLine,
    warning,
    focusRequest,
    search,
    cancel,
    clear,
    select: setSelected,
    run,
    key,
    clickRow,
    handlers,
  }
}
