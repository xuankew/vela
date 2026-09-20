// @vitest-environment jsdom
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectPlatform } from './commands/keybinding'
import type { TextFile } from './ipc/fs'
import type { FileMatch, FileQuery, IndexStats } from './ipc/project'
import { OUTLINE_ROW_HEIGHT } from './md/outline'

/**
 * App 的接线测试：工具栏 → 命令中心 → 文档模型 → CM6 → signal → DOM 文本，整条链真的跑起来。
 *
 * **只有 IPC 与原生对话框是假的**（jsdom 里没有 Tauri 运行时）。`@tauri-apps/api/core`
 * 与 `@tauri-apps/plugin-dialog` 在没有运行时的环境下可以正常 import，它们只在被调用时
 * 才去摸 `window.__TAURI_INTERNALS__`——所以这里 mock 的是我们自己那一层 `./ipc/fs`，
 * 顺带也验证了「import 这两个包不会炸」这件事。
 *
 * 真·端到端（前端 → IPC → vela-core → 磁盘）只能靠 `pnpm tauri dev` 手工验，
 * 或者等 M1-H 的 CI 里加一个 Tauri driver。
 */

const {
  ipc,
  dialog,
  tauriEvent,
  tauriCore,
  sessionCmd,
  projectCmd,
  searchCmd,
  replaceCmd,
  watchCmd,
  shardCmd,
  assetCmd,
  settingsCmd,
} = vi.hoisted(() => {
  /**
   * 会话存档这一头（M1-F）。App 一挂载就会 `load_session`，关窗放行后会 `save_session`，
   * 所以这两个 command 的返回值必须有明确的形状：`load_session` 答 `undefined` 会被当成
   * 一份存档喂给 restoreSession，然后在提示条上留一句谁也看不懂的「undefined」。
   *
   * 类型写在**注解**上而不是 `null as unknown`：`restartWith()` 之后会往 archive / loadError
   * 里塞任意存档与任意错误，断言只在那一行字面量上把类型撑开，注解才真的把它们钉成可写字段。
   */
  const sessionCmd: { archive: unknown; loadError: unknown; saved: unknown[]; droppedDrafts: number } = {
    archive: null,
    loadError: null,
    saved: [],
    droppedDrafts: 0,
  }
  /**
   * 文件树这一头（M2-B）。`list_dir` 走的是 `tauriCore.invoke`，与 session 同一个入口，
   * 所以这里只放数据：`fs` 是 rel → 条目 的表，`calls` 记录调用顺序（懒加载与缓存命中
   * 都只能从「读了哪几层、读了几次」上看出来）。
   *
   * 跳转浮层那一头（M2-E）也住在这里，因为它调的 `index_project` / `query_project`
   * 与 `list_dir` 同属 `./ipc/project`：`indexed` 是每次建索引收到的那份根清单，
   * `queries` 是查询的三个入参。⚠️ M2-F 起这两条命令收的是 `roots: string[]`，
   * 所以 `indexed` 的元素是一个数组而不是一个字符串——单根时是 `['/repo']`。
   * ⚠️ `stats` 与 `result` 必须是**完整形状**而不是 undefined——
   * `show()` 里那句 `stats.truncated` 在 undefined 上取属性会抛在一条 await 之后，
   * 测试看到的只是「浮层里一个结果都没有」，而真正的原因被吞了。
   * 类型写在注解上，用例才能直接改这两个字段。
   */
  const projectCmd: {
    fs: Record<string, unknown[]>
    calls: string[]
    indexed: string[][]
    queries: { roots: string[]; needle: string; recent: string[] }[]
    stats: IndexStats
    result: FileQuery
  } = {
    fs: {},
    calls: [],
    indexed: [],
    queries: [],
    stats: { files: 3, unreadable: 0, truncated: false, elapsedMs: 12 },
    result: { matches: [], total: 0 },
  }
  /**
   * 全局搜索这一头（M2-C）。`start_search` 与 `cancel_task` 也走 `tauriCore.invoke`。
   *
   * ⚠️ `taskId` 是可写的，因为 store 认任务靠 `adopted`/`starting`/`retired` 三个变量
   * （见 src/search/store.ts 的模块文档）：一个用例里搜两轮时必须让第二轮拿到**不同的** id，
   * 否则它会被当成「已作废任务的迟到批次」整个丢掉，而那种绿是毫无意义的。
   *
   * ⚠️ `cancel_task` 自 M2-D 起是搜索与替换**共用**的一个命令，`cancelled` 因此记的是
   * 「被请求取消过的 taskId」而不是「被取消过的搜索」。区分它们靠 id 本身，
   * 而前端刻意不解析 id 的前缀（见 src/ipc/task.ts）
   */
  const searchCmd: { calls: { roots: string[]; query: unknown }[]; cancelled: string[]; taskId: string } = {
    calls: [],
    cancelled: [],
    taskId: 'task-1',
  }
  /**
   * 全局替换这一头（M2-D）。`start_replace` 也走 `tauriCore.invoke`。
   *
   * ⚠️ `taskId` 刻意与搜索那个**不同号**：Rust 侧是同一个计数器发号、永不重复，
   * 而前端有两个 TaskSlot（见 src/search/store.ts）。写成同一个字符串的话，
   * 「落盘的事件被搜索那个 slot 认下来了」这类接线错误在测试里根本看不出来
   */
  const replaceCmd: { calls: { roots: string[]; request: unknown }[]; taskId: string } = {
    calls: [],
    taskId: 'task-r1',
  }
  /**
   * 文件监听这一头（M2-G）。`set_watched` 也走 `tauriCore.invoke`，`sent` 记的是每次
   * 收到的那份**完整**清单（前端的顺序：去重 + 排序）。
   *
   * ⚠️ `stats` 必须是完整形状而不是 undefined：`describeWatchStats` 要在它上面取三个字段，
   * 而那一句在 `send` 的 try 里——取属性抛出来会被当成「同步失败」咽成提示条上的一句话，
   * 于是用例看到的是「多了一行莫名其妙的警告」，而不是「命令回错了东西」
   */
  const watchCmd: { sent: string[][]; stats: WatchStats } = {
    sent: [],
    stats: { dirs: 1, files: 1, failed: 0, skipped: 0, truncated: false },
  }
  /**
   * 只读分片这一头（M2-H）。三条命令都走 `tauriCore.invoke`，而这一份**刻意不 mock
   * `./ipc/shard`**：`openLarge` / `readLines` / `closeLarge` 的参数名正是那条契约里
   * 最容易漂的一半（漂了的失败方式是「滚不动」，见 `src/ipc/shard.ts` 的模块文档），
   * 让它们真的跑一遍，参数名对不上时这里立刻读不出来。
   *
   * `createShardView` 也是**真的**：App 是在 `render()` 里挂的，Solid 的 root 在，
   * 那个 memo 有地方待。于是这一组用例验的是「打开一个大文件 → 屏幕上出现只读分片」
   * 整条链，而不是各段各自绿。
   *
   * ⚠️ `handle` 从 1 开始，与 Rust 侧一致（0 永远不是合法句柄）；`closed` 记的是
   * 被关过的句柄，读一个已关句柄要回 `null` 而不是回一页——那是「迟到的读请求」
   * 唯一正确的形状
   */
  const shardCmd: { header: ShardHeader; opened: string[]; reads: number[]; closed: number[] } = {
    header: { totalLines: 5_000, bytes: 104_857_600, encoding: 'utf8', bom: false, eol: 'lf', lossy: false },
    opened: [],
    reads: [],
    closed: [],
  }
  /**
   * 图片粘贴落地这一头（M3-A-7）。`store_image` 也走 `tauriCore.invoke`，而这一份
   * **刻意不 mock `./ipc/asset`**：`docPath` / `dataBase64` 这两个参数名正是那条契约里
   * 最容易漂的一半（漂了的失败方式是 Rust 那边收到 `None`，然后回一句「不是图片」，
   * 而真正的图明明在剪贴板里）。让它们真的跑一遍，`calls` 里记下来的就是线上形状
   *
   * ⚠️ `result` 是**整个** StoredImage 而不是只有 `rel`：`landPastedImage` 插进正文的
   * 是 `rel`，而「插的那一行与后端答的那一行是同一个」正是这里要钉的东西
   */
  const assetCmd: { calls: { docPath: string; dataBase64: string }[]; result: StoredImage | null; error: unknown } = {
    calls: [],
    result: null,
    error: null,
  }
  /**
   * 分层配置这一头（M4-A）。`load_settings` / `save_settings` 也走 `tauriCore.invoke`。
   *
   * ⚠️ `loaded` 必须是**完整的 `LoadedSettings` 形状**而不是 undefined：App 一挂载，roots
   * 那个 effect 就会 `settings.load(...)`，而 store 的 `load` 要在返回值上取
   * `.settings.fontSize` —— undefined 上取属性会抛在一条 await 之后，变成一条没人接的
   * rejection，用例看到的只是「字体没生效」，真正的原因被吞了（与 `projectCmd.stats`
   * 那条逐字同一类坑）。默认给一份「两层都 absent、配置是内置默认」的空现场。
   *
   * ⚠️ `saved` 记的是每次 `save_settings` 收到的那份 **settings**（不是整个 args）：
   * 写穿那几条用例要验「改了字号 → 存出去的 settings.fontSize 是新值」，
   * 而参数名 `settings` 漂了的话这里会收到 undefined，断言当场红。
   */
  const settingsCmd: { loaded: unknown; loadError: unknown; saved: unknown[] } = {
    loaded: {
      settings: { fontSize: 14, fontVariant: 'screen-gb', codeFont: 'maple-cn' },
      report: {
        userLayer: { status: 'absent' },
        projectLayer: { status: 'absent' },
        ignoredProjectKeys: [],
      },
    },
    loadError: null,
    saved: [],
  }
  return {
    ipc: {
      openFile: vi.fn<typeof import('./ipc/fs').openFile>(),
      saveFile: vi.fn<typeof import('./ipc/fs').saveFile>(),
      // 换成假的：它自己另有测试，这里只关心错误能落到提示条上（断言里靠 kind 字面量认出来）
      describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    },
    dialog: { open: vi.fn(), save: vi.fn() },
    // 关窗守卫（src/ipc/windowClose.ts）要用的两个 Tauri API。jsdom 里没有运行时，
    // 不 mock 的话 `listen` 会在 onMount 里抛，变成一个没人管的 rejection。
    tauriEvent: { listen: vi.fn() },
    tauriCore: { invoke: vi.fn() },
    sessionCmd,
    projectCmd,
    searchCmd,
    replaceCmd,
    watchCmd,
    shardCmd,
    assetCmd,
    settingsCmd,
  }
})

// 只假掉三个函数，**其余用真的**：状态栏要遍历 ENCODING_CHOICES / ENCODING_IDS /
// LINE_ENDING_IDS 渲染下拉，整体替换成假对象会让它在 render 里就抛（dispose 都不是函数，
// 38 条用例一起挂）。标签表本来也该是真的——那正是要显示给用户看的东西。
vi.mock('./ipc/fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ipc/fs')>()),
  openFile: ipc.openFile,
  saveFile: ipc.saveFile,
  describeFsError: ipc.describeFsError,
}))
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
vi.mock('@tauri-apps/api/event', () => tauriEvent)
vi.mock('@tauri-apps/api/core', () => tauriCore)

import App from './App'
import { MAX_PANES } from './doc/workspace'
import type { StoredImage } from './ipc/asset'
import { REPLACE_DONE_EVENT, REPLACE_FAILED_EVENT, REPLACE_PROGRESS_EVENT, type ReplaceSummary } from './ipc/replace'
import { SEARCH_BATCH_EVENT, SEARCH_DONE_EVENT, SEARCH_FAILED_EVENT } from './ipc/search'
import type { ShardHeader } from './ipc/shard'
import { FILE_CHANGED_EVENT, type FileChangeKind, type WatchStats } from './ipc/watch'
import { REQUEST_CLOSE_EVENT } from './ipc/windowClose'

/**
 * 🔴 预热那几个**按需加载**的模块（M3-C-1 起 `md/MarkdownPreview` 走 Solid 的 `lazy()`，
 * `exportDocument` 走动态 `import('./md/preview')` / `import('./md/export')`；
 * M3-C-2 起两块浮层的 UI 也走 `lazy()`）。
 *
 * ⚠️ 生产里那一次 import 是读一个本地文件，毫秒以下；而在 vitest 里它是 vite-node 去取一份
 * 转换过的模块，**横跨好几个宏任务**。下面那些用例等的是一个 `setTimeout(0)`，
 * 而 `settle` 又必须比 `PANEL_DEBOUNCE_MS`（150ms）短两个数量级——否则「接线接错了」
 * 会退化成「过了 150ms 总归会渲染」，那几条用例就废了。
 *
 * 🔴 于是这里先把模块图焐热：焐热之后 `import()` 只剩微任务，一个 `flush()` 就够。
 * ⛔ 不靠多加几次 `flush()` 蒙过去——那种写法在**冷缓存**那一条上必然偶发失败
 * （实测正是如此：同一个 describe 里第一条红、后面几条绿，因为第一条已经把缓存焐热了，
 * 于是加 flush 只能把偶发挪个位置，治不了）
 */
await Promise.all([
  import('./md/MarkdownPreview'),
  import('./md/preview'),
  import('./md/export'),
  import('./tools/ToolBox'),
  import('./commands/CommandPalette'),
])

/**
 * `Mod` 在不同平台上是不同物理键，而 jsdom 的 UA 不含 "Mac" → detectPlatform() 判成 linux。
 * 所以按被测环境实际检测到的平台发键，而不是写死 metaKey。
 */
const modInit = (): KeyboardEventInit => (detectPlatform() === 'macos' ? { metaKey: true } : { ctrlKey: true })

let container: HTMLDivElement
let dispose: () => void

/** `listen` 收到的回调，按事件名收着。测试里手动触发，等于模拟 Rust 侧发事件 */
const listeners = new Map<string, (payload: unknown) => void>()

/**
 * 从 invoke 的入参里取出那份根清单。
 *
 * ⚠️ 与下面 `recent` 同一条理由：`roots` 是 M2-F 起那四条命令（建索引、查文件、搜索、替换）
 * 唯一的「改哪儿/搜哪儿」的来源，而它现在是一个数组。直接 `args.roots as string[]` 会让
 * 「前端递了个单根字符串上去」这种回归变成断言里的一个字符串——`toEqual(['/repo'])` 会红，
 * 但红得莫名其妙；逐条验类型则让它当场变成 `[]`，一眼看出是形状错了而不是内容错了。
 * 空数组是**合法**的（Rust 侧回一份全零的账），所以这里不补默认值也不拦。
 */
const rootsOf = (args?: Record<string, unknown>): string[] => {
  const raw = args?.roots
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : []
}

/**
 * 从一个 `unknown` 里取一个数：不是数就是 0。
 *
 * ⚠️ 刻意不抛。参数名漂了的时候，正确的症状是「句柄成了 0 → 每页都回 null → 界面
 * 永远加载中」，那正是 `src/ipc/shard.ts` 里点名的那条安静失败；在这儿抛一个
 * TypeError 反而会把线索盖住
 */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * `store_image` 的缺省答复。
 *
 * ⚠️ 是一份**合法**的 StoredImage 而不是 null：`landPastedImage` 跑在一个 `void` 掉的
 * promise 里，`stored.rel` 取在 null 上会变成一条没人接的 rejection，而用例看到的
 * 只是「正文里没多那一行」——线索全被吞掉。名字用的是 Rust 侧 `asset.rs` 里
 * `TINY_PNG` 真实落出来的那一个，所以这一串十六进制与后端对得上，不是随手编的
 */
const STORED: StoredImage = {
  rel: 'assets/pasted-ad48c1765eb1b87d.png',
  path: '/repo/assets/pasted-ad48c1765eb1b87d.png',
  bytes: 67,
  reused: false,
}

/**
 * 「磁盘上现在是什么」，按绝对路径。
 *
 * 全局替换的用例要在**一次跑动中间**改掉它：预览读的是替换之前那一份，
 * 落盘之后的对账重读的必须是替换之后那一份。写成常量就演不出这个先后
 */
let disk: Record<string, string> = {}

beforeEach(async () => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  tauriEvent.listen.mockReset()
  tauriCore.invoke.mockReset()
  listeners.clear()
  ipc.saveFile.mockResolvedValue({ bytesWritten: 6, unmappable: false })
  sessionCmd.archive = null
  sessionCmd.loadError = null
  sessionCmd.saved = []
  sessionCmd.droppedDrafts = 0
  projectCmd.calls = []
  projectCmd.indexed = []
  projectCmd.queries = []
  projectCmd.stats = { files: 3, unreadable: 0, truncated: false, elapsedMs: 12 }
  projectCmd.result = { matches: [], total: 0 }
  searchCmd.calls = []
  searchCmd.cancelled = []
  searchCmd.taskId = 'task-1'
  replaceCmd.calls = []
  replaceCmd.taskId = 'task-r1'
  watchCmd.sent = []
  watchCmd.stats = { dirs: 1, files: 1, failed: 0, skipped: 0, truncated: false }
  // ⚠️ `opened` 一并清掉：句柄是拿它的长度发的号，不清的话第二个用例里的句柄就成了 2，
  // 而「关掉再打开拿到的是新句柄」这类断言会读到一个跨用例漂过来的数
  shardCmd.header = { totalLines: 5_000, bytes: 104_857_600, encoding: 'utf8', bom: false, eol: 'lf', lossy: false }
  shardCmd.opened = []
  shardCmd.reads = []
  shardCmd.closed = []
  assetCmd.calls = []
  assetCmd.result = null
  assetCmd.error = null
  settingsCmd.loaded = {
    settings: { fontSize: 14, fontVariant: 'screen-gb', codeFont: 'maple-cn' },
    report: { userLayer: { status: 'absent' }, projectLayer: { status: 'absent' }, ignoredProjectKeys: [] },
  }
  settingsCmd.loadError = null
  settingsCmd.saved = []
  disk = {}
  projectCmd.fs = {
    '': [dirEntry('src', 'src', true), dirEntry('README.md', 'README.md', false), dirEntry('docs', 'docs', true)],
    src: [dirEntry('a.ts', 'src/a.ts', false), dirEntry('b.ts', 'src/b.ts', false)],
    docs: [dirEntry('intro.md', 'docs/intro.md', false)],
  }
  tauriCore.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'load_session') {
      // 复刻 Tauri IPC 的真实行为：command 返回 Err 时，invoke 的拒绝理由是 Rust 侧序列化出来的
      // 那个值本身（字符串或普通对象），**不是 Error 实例**。这里包一层 new Error，
      // 被测的就变成了另一条错误处理路径。
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (sessionCmd.loadError !== null) throw sessionCmd.loadError
      return sessionCmd.archive
    }
    if (cmd === 'save_session') {
      sessionCmd.saved.push(args?.session)
      return { bytesWritten: 120, droppedDrafts: sessionCmd.droppedDrafts }
    }
    if (cmd === 'load_settings') {
      // 与 load_session 同一条理由：Rust 的 Err 是被序列化后原样抛出的普通对象，
      // 不包 new Error，被测的才是 store 里那条真正的错误处理路径
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (settingsCmd.loadError !== null) throw settingsCmd.loadError
      return settingsCmd.loaded
    }
    if (cmd === 'save_settings') {
      // 🔴 参数名 `settings` 在这儿被真的读一遍：漂了的话这里收到 undefined，
      // 而写穿那几条用例会把它当成「存了个空配置」，红线落在断言上而不是静默通过
      settingsCmd.saved.push(args?.settings)
      return { bytesWritten: 80 }
    }
    if (cmd === 'list_dir') {
      // `args` 的值是 unknown：`String(unknown)` 会走到 Object 的默认字符串化，
      // 出错时给出的是 '[object Object]' 而不是真正的值，等于把线索抹掉
      const rel = typeof args?.rel === 'string' ? args.rel : ''
      const root = typeof args?.root === 'string' ? args.root : ''
      projectCmd.calls.push(rel)
      const entries = projectCmd.fs[rel]
      if (!entries) {
        // 与上面 load_session 同一条理由：Rust 的 Err 是被序列化后原样抛出的普通对象，
        // 包一层 new Error 就会让 describeTreeError 走到「兜底」那条分支上去
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { kind: 'not_found', path: `${root}/${rel}` }
      }
      return { rel, entries: (entries as { rel: string }[]).map((e) => ({ ...e, path: `${root}/${e.rel}` })) }
    }
    if (cmd === 'index_project') {
      projectCmd.indexed.push(rootsOf(args))
      return projectCmd.stats
    }
    if (cmd === 'query_project') {
      const roots = rootsOf(args)
      const needle = typeof args?.needle === 'string' ? args.needle : ''
      // ⚠️ `recent` 必须逐条验类型再收：它是 MRU 清单，「递没递上去」正是几条用例要钉的东西。
      // 直接 `args.recent as string[]` 会让一个漏递的 undefined 变成断言里的 undefined，
      // 而 `toEqual([])` 与 `toBeUndefined()` 都能被人误读成「递了个空清单」
      const raw = args?.recent
      const recent = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : []
      projectCmd.queries.push({ roots, needle, recent })
      return projectCmd.result
    }
    if (cmd === 'start_search') {
      searchCmd.calls.push({ roots: rootsOf(args), query: args?.query })
      // ⚠️ 必须返回一个**字符串** taskId。落到下面那个 `return undefined` 的话，store 会把
      // undefined 认成当前任务，随后每一个事件都对不上号——面板永远停在「正在搜索…」，
      // 而后台其实早就搜完了，没有任何报错可查
      return searchCmd.taskId
    }
    if (cmd === 'start_replace') {
      // 记**整个 request**而不是只记 query：`skip` 那一半（正开着且有未保存改动的路径）
      // 是这条命令唯一由前端递进去的保护，漏递的失败方式是「用户的稿子被落盘盖掉」
      replaceCmd.calls.push({ roots: rootsOf(args), request: args?.request })
      return replaceCmd.taskId
    }
    if (cmd === 'cancel_task') {
      searchCmd.cancelled.push(typeof args?.taskId === 'string' ? args.taskId : '')
      return undefined
    }
    if (cmd === 'set_watched') {
      // ⚠️ 这一条**不能**落到下面那个 `return undefined`：`send` 拿到 undefined 之后
      // 会在 `describeWatchStats` 里取属性，抛出来的错被同一个 try 咽成提示条上一句
      // 「文件监听没能同步：undefined」，于是每条 App 用例都平白多一行警告，
      // 而真正的原因（命令没实现）被藏起来了
      const raw = args?.paths
      watchCmd.sent.push(Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [])
      return watchCmd.stats
    }
    if (cmd === 'open_large') {
      const path = typeof args?.path === 'string' ? args.path : ''
      shardCmd.opened.push(path)
      // 句柄从 1 开始、永不复用（与 Rust 侧同一条规矩）：拿「开过几次」当发号器就够了
      return { handle: shardCmd.opened.length, header: shardCmd.header }
    }
    if (cmd === 'read_lines') {
      // 🔴 三个参数名都在这儿被真的读一遍。`ipc/shard.ts` 那段模块文档说的「安静的漂移」
      // 就是指这一行：名字对不上时 `args.handle` 是 undefined，而下面那个 `num()`
      // 会把它夹成 0——0 不是合法句柄，于是每一页都回 null，界面上是「永远加载中」
      const handle = num(args?.handle)
      const start = num(args?.start)
      const count = num(args?.count)
      shardCmd.reads.push(handle)
      if (shardCmd.closed.includes(handle)) return null
      const total = shardCmd.header.totalLines
      const from = Math.min(start, total)
      const n = Math.max(0, Math.min(count, total - from))
      return {
        start: from,
        lines: Array.from({ length: n }, (_, i) => `第 ${from + i + 1} 行`),
        truncated: false,
        lossy: false,
      }
    }
    if (cmd === 'close_large') {
      shardCmd.closed.push(num(args?.handle))
      return undefined
    }
    if (cmd === 'store_image') {
      // 🔴 两个参数名都在这儿被真的读一遍。`docPath` 漂了的话 Rust 侧推不出目录，
      // 而 `dataBase64` 漂了的话它连一个字节都收不到——两种漂法在真机上都是
      // 「粘了没反应」，只有这一行能把它们变成一条红的断言
      assetCmd.calls.push({
        docPath: typeof args?.docPath === 'string' ? args.docPath : '',
        dataBase64: typeof args?.dataBase64 === 'string' ? args.dataBase64 : '',
      })
      // 与 load_session 同一条理由：Rust 的 Err 是被序列化后原样抛出的普通对象，
      // 包一层 new Error 就会让 describeAssetError 走到「兜底」那条分支上去
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (assetCmd.error !== null) throw assetCmd.error
      return assetCmd.result ?? STORED
    }
    return undefined
  })
  tauriEvent.listen.mockImplementation(async (name: string, handler: (payload: unknown) => void) => {
    listeners.set(name, handler)
    return () => {
      listeners.delete(name)
    }
  })
  mountApp()
  // 关窗守卫的注册要等 `listen` 的 promise 落地，不然 listeners 还是空的
  await flush()
})

function mountApp() {
  container = document.createElement('div')
  document.body.appendChild(container)
  dispose = render(() => <App />, container)
}

/**
 * 换一份存档，重新走一遍启动。
 *
 * 会话只在挂载时读一次，所以改完 mock 必须重挂——直接在跑着的 App 上改
 * `sessionCmd.archive` 什么都不会发生，用例会绿得毫无意义。
 */
async function restartWith(archive: unknown, loadError: unknown = null) {
  dispose()
  container.remove()
  sessionCmd.archive = archive
  sessionCmd.loadError = loadError
  sessionCmd.saved = []
  mountApp()
  await flush()
}

afterEach(() => {
  dispose()
  container.remove()
  document.documentElement.removeAttribute('style')
})

/** 打开/保存是异步的：命令 execute → hook → invoke 有好几层微任务，一个宏任务就能冲干净 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 分屏容器，按屏幕顺序 */
function hosts(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.body > .editor-host')]
}

/** 每块分屏里的编辑器，按屏幕顺序 */
function views(): EditorView[] {
  return [...container.querySelectorAll<HTMLElement>('.editor-host .cm-editor')].map((dom) => {
    const found = EditorView.findFromDOM(dom)
    if (!found) throw new Error('拿不到 EditorView 实例')
    return found
  })
}

/** 第一块分屏的编辑器。多分屏的用例请用 `views()` */
function view(): EditorView {
  const all = views()
  if (all.length === 0) throw new Error('App 没有渲染出编辑器')
  return all[0]!
}

/**
 * 让第 index 块分屏拿到焦点。
 *
 * 不用 `view.focus()`：jsdom 只对带 tabindex / 可编辑表单元素派发 focus 事件，
 * CM6 的 contentDOM 靠 `contenteditable`，在 jsdom 里聚焦是静默无效操作。
 * 直接发一个冒泡的 focusin 更贴近真实链路——`EditorPane` 的 onFocusIn 就挂在容器上。
 */
function focusHost(index: number) {
  const host = hosts()[index]
  if (!host) throw new Error(`没有第 ${index} 块分屏`)
  const target = host.querySelector('.cm-content') ?? host
  target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
}

/**
 * 状态栏的格子。中间那几格（「选中 N 字符」「N 个选区」）是条件渲染的，下标不稳定，
 * 所以文档名取第一格、行数·字符数取最后一格，别按固定下标去数。
 * 顺手把空白归一化：JSX 里跨行写的文本会带缩进换行。
 */
function statusCells(): string[] {
  return [...container.querySelectorAll('.statusbar .status-cell')].map((c) =>
    (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

function statusName(): string {
  return statusCells()[0]!
}

function statusCounts(): string {
  const cells = statusCells()
  return cells[cells.length - 1]!
}

function notices(): { level: string; text: string }[] {
  return [...container.querySelectorAll('.notice')].map((n) => ({
    level: n.classList.contains('error') ? 'error' : n.classList.contains('warning') ? 'warning' : 'plain',
    text: n.textContent ?? '',
  }))
}

function button(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!el) throw new Error(`找不到按钮「${text}」`)
  return el
}

/** 标签条上的标签，按屏幕顺序 */
function tabs(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.tab-strip .tab')]
}

/** 假文件树的一个条目。`path` 一律按 `/repo` 拼，与 `projectCmd.fs` 的 key 对得上 */
/**
 * 一条目录项。`path` 留空，由 `list_dir` 那个假实现按**这次请求的根**填上——
 * 写死 `/repo/` 的话多根用例里两个根会长出一模一样的绝对路径，
 * 而「两个根都有 src」正是 M2-F 要演的那个场面
 */
function dirEntry(name: string, rel: string, isDir: boolean) {
  return { name, rel, path: '', isDir }
}

function sidebar(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.sidebar')
}

function treeRowEls(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.tree-row')]
}

function treeNames(): string[] {
  return treeRowEls().map((el) => el.querySelector('.tree-name')?.textContent ?? '')
}

/**
 * 按 rel 找那一行。根行的 rel 是空字符串，它的 path 就是那个根本身。
 * `root` 默认 `/repo`：绝大多数用例只有一个根，多根的那几条显式递第二个
 */
function treeRow(rel: string, root = '/repo'): HTMLElement {
  const path = rel === '' ? root : `${root}/${rel}`
  const el = treeRowEls().find((e) => e.title === path)
  if (!el) throw new Error(`树里找不到 ${path}（渲染出来的有：${treeNames().join('、')}）`)
  return el
}

/** 「文件夹…」→ 目录对话框选中 /repo → 侧边栏自动显示。在 App 里这是用户的一次点击 */
async function openProject(): Promise<void> {
  dialog.open.mockResolvedValue('/repo')
  button('文件夹…').click()
  await flush()
}

/**
 * 侧边栏头部的 ↻ / ×。只能按 title 认：`×` 这个文本在整份 DOM 里不唯一
 * （标签条的关闭按钮也是它），`button('×')` 会抓到标签上去。
 */
function sidebarAct(titlePrefix: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>('.sidebar-head button')].find((b) =>
    b.title.startsWith(titlePrefix),
  )
  if (!el) throw new Error(`侧边栏头部找不到 title 以「${titlePrefix}」开头的按钮`)
  return el
}

function modal(): HTMLElement | null {
  return container.querySelector('.modal')
}

/** 对话框里的按钮。必须限定在 `.modal-actions` 里找——工具栏上也有一个叫「保存」的 */
function modalButton(label: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(
    (b) => b.textContent === label,
  )
  if (!el) throw new Error(`对话框里找不到按钮「${label}」`)
  return el
}

/** 模拟 Rust 侧拦下 CloseRequested / Cmd+Q 之后发来的那个事件 */
async function rustRequestsClose() {
  const handler = listeners.get(REQUEST_CLOSE_EVENT)
  if (!handler) throw new Error('关窗守卫没挂上')
  handler(undefined)
  await flush()
}

/**
 * 模拟 Rust 侧推来的一个事件（搜索那三个与替换那三个共用一个 `listen` 桩）。
 *
 * ⚠️ handler 收的是 `{ payload }` 那个**信封**而不是 payload 本身：`attachSearchListeners`
 * 里写的是 `(e) => handlers.onBatch(e.payload.taskId, e.payload.batch)`（src/ipc/search.ts），
 * `attachReplaceListeners` 同形。直接把 payload 递进去的话 `.payload` 全是 undefined，
 * 事件被静默吃掉，用例却照样绿——因为「没结果」与「面板刚展开还没搜」在 DOM 上长得一模一样
 */
async function fireEvent(name: string, payload: unknown): Promise<void> {
  const handler = listeners.get(name)
  if (!handler) throw new Error(`监听没挂上：${name}`)
  handler({ payload })
  await flush()
}

function findPanel(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.find-panel')
}

function findInput(): HTMLInputElement {
  const el = findPanel()?.querySelector<HTMLInputElement>('.find-input')
  if (!el) throw new Error('面板里没有搜索词输入框')
  return el
}

/** 往搜索词输入框里敲字。这是一个普通 `<input>`，与 CM6 的 `typeText` 是两条路 */
function typeSearch(text: string): void {
  const el = findInput()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 在面板里按一个键。bubbles 是必需的：Solid 把 keydown 委托在 document 上 */
function pressInFind(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  findInput().dispatchEvent(event)
  return event
}

/** 结果列表里的行，按屏幕顺序。文件行与命中行混在同一个扁平数组里（见 src/search/rows.ts） */
function findRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.find-row')]
}

function findRowTexts(): string[] {
  return findRows().map((el) => el.textContent ?? '')
}

function findStatus(): string {
  return container.querySelector('.find-status-text')?.textContent ?? ''
}

/**
 * 面板头部的按钮。**找不到时返回 null 而不是抛**：
 * 「取消」只在搜索进行中才渲染，而「此刻它不该在」正是几条用例要钉的东西，
 * 用全局的 `button()`（找不到就抛）就没法表达了
 */
function findButton(label: string): HTMLButtonElement | null {
  const all = [...(findPanel()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  return all.find((b) => b.textContent === label) ?? null
}

/**
 * 面板头部那一排的按钮文字，按屏幕顺序。「取消」只在有任务在飞时才渲染，
 * 所以这个数组的长度本身也是一条断言
 */
function headButtonTitles(): string[] {
  const all = [...(findPanel()?.querySelectorAll<HTMLButtonElement>('.find-head button') ?? [])]
  return all.map((b) => b.textContent ?? '')
}

/** 面板最左边那个模式开关。它不是第四个匹配选项，所以 class 也与那三个分开 */
function findMode(): HTMLButtonElement {
  const el = findPanel()?.querySelector<HTMLButtonElement>('.find-mode')
  if (!el) throw new Error('面板里没有「替换」模式开关')
  return el
}

/**
 * 「替换为」那一格。⚠️ 必须限定在 `.find-replace` 里面找：它也挂着 `.find-input`，
 * 而 `findInput()` 用的是 `querySelector`（取第一个），少了这个限定两个都指到搜索词上
 */
function replaceInput(): HTMLInputElement {
  const el = findPanel()?.querySelector<HTMLInputElement>('.find-replace .find-input')
  if (!el) throw new Error('面板里没有「替换为」输入框')
  return el
}

function typeReplace(text: string): void {
  const el = replaceInput()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 一份落盘总账。字段太多，让用例只写它关心的那几个 */
function replaceSummary(overrides: Partial<ReplaceSummary> = {}): ReplaceSummary {
  return {
    filesScanned: 2,
    filesChanged: 1,
    replacements: 1,
    skippedBinary: 0,
    skippedLossy: 0,
    skippedUnmappable: 0,
    skippedTooLarge: 0,
    skippedOpen: 0,
    unreadable: 0,
    writeFailed: 0,
    truncated: false,
    cancelled: false,
    elapsedMs: 40,
    ...overrides,
  }
}

function fontSizeSelect(): HTMLSelectElement {
  const el = [...container.querySelectorAll('select')].find((s) => s.title.startsWith('字号'))
  if (!el) throw new Error('找不到字号 select')
  return el
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

/** 敲字走 CM6 的事务，等于用户在编辑器里真的输入 */
function typeText(text: string) {
  const v = view()
  v.dispatch({ changes: { from: v.state.doc.length, insert: text } })
}

/** 往指定那块分屏敲字。带上 selection：真敲字会把光标落在插入文本之后 */
function typeInto(index: number, text: string) {
  const v = views()[index]
  if (!v) throw new Error(`没有第 ${index} 块分屏`)
  const at = v.state.doc.length
  v.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
}

function textFile(overrides: Partial<{ text: string; lossy: boolean }> = {}) {
  return {
    text: '正文',
    format: { encoding: 'utf8' as const, bom: false, eol: 'lf' as const },
    lossy: false,
    bytes: 6,
    ...overrides,
  }
}

describe('App 接线', () => {
  it('挂载后编辑器就位，状态栏报出空文档的度量', () => {
    expect(container.querySelector('.editor-container .cm-editor')).not.toBeNull()
    expect(statusName()).toBe('空文档')
    // CM6 把空文档算作「一行空行」，所以是 1 行 0 字符，不是 0 行
    expect(statusCounts()).toBe('1 行 · 0 字符')
    // 提示条容器常驻但没有内容：它占着 grid 的第二行，行数必须是固定的
    expect(container.querySelector('.notices')).not.toBeNull()
    expect(container.querySelector('.notice')).toBeNull()
  })

  it('输入会经 onUpdate 推到状态栏（CM6 → signal 的回路在真实 App 里通）', () => {
    typeText('第一行\n第二行\n第三行')
    expect(statusCounts()).toBe('3 行 · 11 字符')
  })

  it('Alt+Z 经命令中心切换换行，按钮标签与编辑器状态同时更新', () => {
    const wrapButton = [...container.querySelectorAll('button')].find((b) => b.title === 'Alt+Z')
    expect(wrapButton?.textContent).toBe('开')

    press('z', { altKey: true })
    expect(wrapButton?.textContent).toBe('关')
    expect(
      view()
        .state.facet(EditorView.contentAttributes)
        .some((a) => typeof a !== 'function' && a.class === 'cm-lineWrapping'),
    ).toBe(false)

    press('z', { altKey: true })
    expect(wrapButton?.textContent).toBe('开')
  })

  it('Mod+= / Mod+- / Mod+0 改字号，CSS 变量与 select 同步', () => {
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')

    press('=', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('15px')
    expect(fontSizeSelect().value).toBe('15')

    press('-', modInit())
    press('-', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('13px')

    press('0', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')
  })

  it('字号只在预设档位间走，不会冒出 select 显示不了的档外值', () => {
    // 从最小档继续缩小应当停在 12px
    press('0', modInit())
    press('-', modInit())
    press('-', modInit())
    press('-', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('12px')
    expect(fontSizeSelect().value).toBe('12')
  })

  it('「新建」另开一个空标签，状态栏与编辑器都跟着换过去', () => {
    typeText('a\nb\nc\nd')
    expect(statusCounts()).toBe('4 行 · 7 字符')

    button('新建').click()

    expect(tabs()).toHaveLength(2)
    expect(view().state.doc.toString()).toBe('')
    expect(statusName()).toBe('空文档')
    expect(statusCounts()).toBe('1 行 · 0 字符')
  })

  /*
   * M1-D 的核心承诺：切标签只换 state，不重建 view。
   *
   * 一旦有人把 `state` 当成响应式 props 传进 EditorPane（或者在 Solid 里给它套上
   * `<Show>`/keyed `<For>`），这个节点就会被换掉——撤销历史、滚动位置、查找面板的
   * 输入框内容全丢，而且每切一次标签都要重跑一遍 CM6 的初始测量。
   */
  it('切换标签时编辑器 DOM 节点是同一个，view 没有被重建', () => {
    const before = container.querySelector('.cm-editor')
    typeText('第一份')

    button('新建').click()
    typeText('第二份')
    tabs()[0]!.click()

    expect(container.querySelector('.cm-editor')).toBe(before)
    expect(view().state.doc.toString()).toBe('第一份')
    expect(statusCounts()).toBe('1 行 · 3 字符')
  })

  it('卸载后全局快捷键监听被摘掉，不会再驱动已销毁的编辑器', () => {
    dispose()
    // 重新挂一个空的，避免 afterEach 再 dispose 一次已卸载的树
    dispose = () => {}
    expect(() => press('z', { altKey: true })).not.toThrow()
    expect(container.querySelector('.cm-editor')).toBeNull()
  })
})

describe('文件生命周期接线', () => {
  it('打开文件：正文进编辑器，徽章换成文件名，度量跟着变，且不显示为脏', async () => {
    dialog.open.mockResolvedValue('/Users/x/notes/win.txt')
    ipc.openFile.mockResolvedValue(textFile({ text: '第一行\n第二行\n' }))

    button('打开…').click()
    await flush()

    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: false })
    expect(view().state.doc.toString()).toBe('第一行\n第二行\n')
    // 状态栏只显示 basename，全路径挂在 title 上
    expect(statusName()).toBe('win.txt')
    expect(container.querySelector<HTMLElement>('.status-path')?.title).toBe('/Users/x/notes/win.txt')
    expect(statusCounts()).toBe('3 行 · 8 字符')
    expect(notices()).toEqual([])
  })

  it('打开后立刻输入才置脏，Mod+S 保存后脏标记消失', async () => {
    dialog.open.mockResolvedValue('/a.txt')
    ipc.openFile.mockResolvedValue(textFile({ text: '原文' }))
    button('打开…').click()
    await flush()
    // 整篇替换正文不算用户改动——这条是 `replacing` 标志存在的全部理由
    expect(statusName()).toBe('a.txt')

    typeText('改')
    expect(statusName()).toBe('● a.txt')

    press('s', modInit())
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '原文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(statusName()).toBe('a.txt')
  })

  it('光标移动不置脏', () => {
    typeText('abc')
    const before = statusName()
    view().dispatch({ selection: { anchor: 0 } })
    expect(statusName()).toBe(before)
  })

  it('无名文档按 Mod+S 会落到另存为，用对话框拿到路径再写', async () => {
    dialog.save.mockResolvedValue('/chosen/new.txt')
    typeText('新内容')
    expect(statusName()).toBe('● 空文档')

    press('s', modInit())
    await flush()

    expect(dialog.save).toHaveBeenCalled()
    expect(ipc.saveFile).toHaveBeenCalledWith('/chosen/new.txt', '新内容', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(statusName()).toBe('new.txt')
  })

  it('另存为用 Mod+Shift+S，不会被 Mod+S 吃掉', async () => {
    dialog.save.mockResolvedValue('/copy.txt')
    typeText('x')

    press('S', { ...modInit(), shiftKey: true })
    await flush()

    expect(dialog.save).toHaveBeenCalledOnce()
    expect(statusName()).toBe('copy.txt')
  })

  it('对话框取消时什么都不动', async () => {
    dialog.open.mockResolvedValue(null)
    button('打开…').click()
    await flush()
    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(statusName()).toBe('空文档')
  })

  it('打开失败时报出错误，并且另开一个干净标签来承载——草稿一动不动', async () => {
    typeText('手稿')
    dialog.open.mockResolvedValue('/gone.txt')
    // ⚠️ 这里刻意**不用** `too_large`：那一条自 M2-H 起不是失败，是「改走只读分片」，
    // 一个字都不该说（那一半在下面那个 describe 里）。拿它当通用失败的样例，
    // 会让这条用例在分片那条路修好之前就红，而红的原因与它要钉的东西无关
    ipc.openFile.mockRejectedValue({ kind: 'io', reason: 'NotFound', message: '文件没了' })

    button('打开…').click()
    await flush()

    // 草稿标签是脏的，所以 openAt 不复用它：错误落在新开的空标签上
    const list = notices()
    expect(list).toHaveLength(1)
    expect(list[0]!.level).toBe('error')
    expect(list[0]!.text).toContain('NotFound')
    expect(view().state.doc.toString()).toBe('')
    expect(statusName()).toBe('空文档')

    container.querySelector<HTMLButtonElement>('.notice-close')?.click()
    expect(notices()).toEqual([])

    // 切回第一个标签，草稿还在，脏标记也还在
    tabs()[0]!.click()
    expect(view().state.doc.toString()).toBe('手稿')
    expect(statusName()).toBe('● 空文档')
    expect(notices()).toEqual([])
  })

  it('有损解码的文件常驻一条警告，关掉提示条也不会消失', async () => {
    dialog.open.mockResolvedValue('/broken.bin')
    ipc.openFile.mockResolvedValue(textFile({ text: 'a\uFFFDb', lossy: true }))

    button('打开…').click()
    await flush()

    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.level).toBe('warning')
    expect(notices()[0]!.text).toContain('永久损坏')
    // 这条不是 notice 而是文档属性，没有关闭按钮
    expect(container.querySelector('.notice-close')).toBeNull()
  })

  it('保存时编码装不下字符会警告，但脏标记照样清零（盘确实写了）', async () => {
    dialog.open.mockResolvedValue('/gbk.txt')
    ipc.openFile.mockResolvedValue({
      text: '中文',
      format: { encoding: 'gbk' as const, bom: false, eol: 'lf' as const },
      lossy: false,
      bytes: 4,
    })
    button('打开…').click()
    await flush()
    typeText('😀')
    ipc.saveFile.mockResolvedValue({ bytesWritten: 12, unmappable: true })

    press('s', modInit())
    await flush()

    const list = notices()
    expect(list).toHaveLength(1)
    expect(list[0]!.level).toBe('warning')
    expect(list[0]!.text).toContain('GBK')
    expect(statusName()).toBe('gbk.txt')
  })

  it('IO 进行中四个文档按钮都是 disabled 的', async () => {
    let release!: (v: TextFile) => void
    dialog.open.mockResolvedValue('/a.txt')
    ipc.openFile.mockReturnValue(new Promise((resolve) => (release = resolve)))

    button('打开…').click()
    await flush()

    for (const label of ['新建', '打开…', '保存', '另存为…']) {
      expect(button(label).disabled, `${label} 在 IO 期间应当禁用`).toBe(true)
    }

    release(textFile())
    await flush()
    expect(button('保存').disabled).toBe(false)
  })
})

describe('关闭确认接线', () => {
  function closeTabButton(index: number): HTMLButtonElement {
    const el = tabs()[index]!.querySelector<HTMLButtonElement>('.tab-close')
    if (!el) throw new Error('标签上找不到关闭按钮')
    return el
  }

  /** 打开一个文件再改一个字，得到一个有路径的脏标签 */
  async function dirtyFileTab(path = '/a.txt', extra = '改') {
    dialog.open.mockResolvedValue(path)
    ipc.openFile.mockResolvedValue(textFile({ text: '正文' }))
    button('打开…').click()
    await flush()
    typeText(extra)
  }

  it('关掉干净标签不弹对话框', async () => {
    closeTabButton(0).click()
    await flush()
    expect(modal()).toBeNull()
    expect(statusName()).toBe('空文档')
  })

  it('关掉脏标签弹出三选一，标题里带文件名', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    expect(modal()?.getAttribute('role')).toBe('alertdialog')
    expect(modal()?.getAttribute('aria-label')).toBe('「a.txt」有未保存的改动')
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')].map((b) => b.textContent),
    ).toEqual(['取消', '不保存', '保存'])
  })

  it('默认焦点落在「保存」上——什么都不看直接按回车不该是丢数据', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()
    expect(document.activeElement).toBe(modalButton('保存'))
  })

  it('点「取消」：对话框消失，标签与脏标记都留着', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    modalButton('取消').click()
    await flush()

    expect(modal()).toBeNull()
    expect(tabs()).toHaveLength(1)
    expect(statusName()).toBe('● a.txt')
    expect(view().state.doc.toString()).toBe('正文改')
  })

  it('按 Escape 等于取消', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    modal()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush()

    expect(modal()).toBeNull()
    expect(tabs()).toHaveLength(1)
  })

  it('点「不保存」：一个字节都不写，标签直接没了', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    modalButton('不保存').click()
    await flush()

    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(modal()).toBeNull()
    // 关掉的是唯一的标签，补进来一个空的
    expect(tabs()).toHaveLength(1)
    expect(statusName()).toBe('空文档')
  })

  it('点「保存」：写盘之后才关', async () => {
    await dirtyFileTab()
    closeTabButton(0).click()
    await flush()

    modalButton('保存').click()
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(modal()).toBeNull()
    expect(statusName()).toBe('空文档')
  })

  it('Rust 发来关窗事件：没有未保存改动时直接关，不弹对话框', async () => {
    await rustRequestsClose()
    expect(modal()).toBeNull()
    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
  })

  it('Rust 发来关窗事件：有未保存改动时先问，答「不保存」才真的关', async () => {
    await dirtyFileTab()

    await rustRequestsClose()
    expect(tauriCore.invoke).not.toHaveBeenCalledWith('close_window')
    expect(modal()?.getAttribute('aria-label')).toBe('「a.txt」有未保存的改动')

    modalButton('不保存').click()
    await flush()

    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
    expect(modal()).toBeNull()
  })

  it('Rust 发来关窗事件：答「取消」就什么都不做，窗口留着', async () => {
    await dirtyFileTab()

    await rustRequestsClose()
    modalButton('取消').click()
    await flush()

    expect(tauriCore.invoke).not.toHaveBeenCalledWith('close_window')
    expect(modal()).toBeNull()
    expect(statusName()).toBe('● a.txt')
  })

  it('多个脏标签时一次列出全部文件名，而不是一个一个弹', async () => {
    await dirtyFileTab('/a.txt', '改')
    button('新建').click()
    await dirtyFileTab('/b.txt', '也改')

    await rustRequestsClose()

    expect(modal()?.getAttribute('aria-label')).toBe('2 个文档有未保存的改动')
    expect([...container.querySelectorAll('.modal-list li')].map((li) => li.textContent)).toEqual(['a.txt', 'b.txt'])

    modalButton('保存').click()
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(ipc.saveFile).toHaveBeenCalledWith('/b.txt', '正文也改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
  })
})

describe('分屏接线', () => {
  /** 聚焦标记。用 class 而不是 document.activeElement：jsdom 里 CM6 的聚焦是无效操作 */
  const focused = () => hosts().findIndex((h) => h.classList.contains('focused'))

  it('点「右分屏」多出一块编辑区，焦点交给新的那块，标签条也多一个标签', () => {
    expect(hosts()).toHaveLength(1)
    expect(button('合并').disabled).toBe(true) // 只剩一块时没得合

    button('右分屏').click()

    expect(hosts()).toHaveLength(2)
    expect(views()).toHaveLength(2)
    // 两块是各自独立的 EditorView，不是同一个实例被引用两次
    expect(views()[0]).not.toBe(views()[1])
    expect(focused()).toBe(1)
    expect(tabs()).toHaveLength(2)
    expect(statusName()).toBe('空文档')
    expect(button('合并').disabled).toBe(false)
    expect(container.querySelector('.body')?.classList.contains('column')).toBe(false)
  })

  it('点「下分屏」把整排改成竖着排', () => {
    button('下分屏').click()
    expect(hosts()).toHaveLength(2)
    expect(container.querySelector('.body')?.classList.contains('column')).toBe(true)
  })

  it('到 MAX_PANES 之后两个分屏按钮都 disabled，再点也不会多出一块', () => {
    for (let n = 2; n <= MAX_PANES; n++) {
      button('右分屏').click()
      expect(hosts()).toHaveLength(n)
    }
    expect(button('右分屏').disabled).toBe(true)
    expect(button('下分屏').disabled).toBe(true)

    button('右分屏').click()
    expect(hosts()).toHaveLength(MAX_PANES)
  })

  it('两块分屏各敲各的，状态栏只报聚焦的那块', () => {
    typeInto(0, 'AAAA')
    button('右分屏').click()
    typeInto(1, 'BBBBBBB')

    expect(views()[0]!.state.doc.toString()).toBe('AAAA')
    expect(views()[1]!.state.doc.toString()).toBe('BBBBBBB')
    expect(statusCounts()).toBe('1 行 · 7 字符')

    // 往没聚焦的那块敲字不该动状态栏——度量是「聚焦分屏的标签」的属性
    typeInto(0, 'CC')
    expect(statusCounts()).toBe('1 行 · 7 字符')

    focusHost(0)
    expect(focused()).toBe(0)
    expect(statusCounts()).toBe('1 行 · 6 字符')
  })

  it('Mod+\\ 与 Mod+Shift+\\ 与按钮走同一条路', () => {
    press('\\', modInit())
    expect(hosts()).toHaveLength(2)
    expect(container.querySelector('.body')?.classList.contains('column')).toBe(false)

    press('\\', { ...modInit(), shiftKey: true })
    expect(hosts()).toHaveLength(3)
    expect(container.querySelector('.body')?.classList.contains('column')).toBe(true)
  })

  it('Mod+Alt+→ 把焦点交给下一块分屏，并回绕', () => {
    button('右分屏').click()
    expect(focused()).toBe(1)

    press('ArrowRight', { ...modInit(), altKey: true })
    expect(focused()).toBe(0)

    press('ArrowLeft', { ...modInit(), altKey: true })
    expect(focused()).toBe(1)
  })

  it('编辑器里聚焦会把那块分屏标成 focused，度量也跟着回去', () => {
    button('右分屏').click()
    typeInto(1, 'BBBBBBB')
    expect(focused()).toBe(1)
    expect(statusCounts()).toBe('1 行 · 7 字符')

    focusHost(0)

    expect(focused()).toBe(0)
    expect(statusCounts()).toBe('1 行 · 0 字符')
  })

  it('合并掉带未保存改动的分屏不丢稿子：标签留在条上，点回去正文还在', () => {
    typeInto(0, '左边')
    button('右分屏').click()
    typeInto(1, '草稿')

    button('合并').click()

    expect(hosts()).toHaveLength(1)
    expect(tabs()).toHaveLength(2)
    expect(tabs()[1]!.textContent).toContain('●')

    tabs()[1]!.click()
    expect(views()[0]!.state.doc.toString()).toBe('草稿')
    expect(statusCounts()).toBe('1 行 · 2 字符')
  })

  it('合并到只剩一块之后「合并」按钮重新 disabled', () => {
    button('右分屏').click()
    button('合并').click()
    expect(hosts()).toHaveLength(1)
    expect(button('合并').disabled).toBe(true)
  })
})

describe('会话恢复接线（M1-F）', () => {
  /**
   * 存档里的一个标签。字段形状由 `src/ipc/session.ts` 与 Rust 侧的契约测试钉住，
   * 这里只负责填内容——重复写全 `SessionTab` 那 9 个字段会让每条用例的重点淹在样板里。
   */
  function savedTab(over: Record<string, unknown> = {}) {
    return {
      path: null,
      format: { encoding: 'utf8', bom: false, eol: 'lf' },
      dirty: false,
      lossy: false,
      draft: null,
      selection: [[0, 0]],
      main: 0,
      scrollTop: 0,
      scrollLeft: 0,
      ...over,
    }
  }

  function savedSession(tabs: unknown[], over: Record<string, unknown> = {}) {
    // `project`、`recent` 与 `recentProjects` 是基底的一部分：Rust 侧那三个字段都带
    // `#[serde(default)]`，于是**线上永远不会缺这三个键**（旧存档在反序列化时就被填成
    // null / 空数组）。这里少写一个，恢复会在读到它时抛，而那个抛被 `sessionSync`
    // 的 catch 咽下去变成一条 warn——另一份现场已经装好了，用例照样绿，
    // 只有「恢复其实失败了一半」这件事没人看见
    return {
      version: 1,
      direction: 'row',
      focused: 0,
      tabs,
      panes: [0],
      project: null,
      recent: [],
      recentProjects: [],
      ...over,
    }
  }

  /** 最近一次写出去的存档 */
  function lastArchive(): {
    tabs: { path: string | null; draft: string | null; dirty: boolean }[]
    panes: number[]
    focused: number
  } {
    const last = sessionCmd.saved[sessionCmd.saved.length - 1]
    if (!last) throw new Error('还没有写过存档')
    return last as {
      tabs: { path: string | null; draft: string | null; dirty: boolean }[]
      panes: number[]
      focused: number
    }
  }

  /** 打开一个文件并把正文改成脏的。关窗确认会拦住它，用例自己决定怎么答 */
  async function dirtyFileTab(path = '/a.txt', extra = '改') {
    dialog.open.mockResolvedValue(path)
    ipc.openFile.mockResolvedValue(textFile({ text: '正文' }))
    button('打开…').click()
    await flush()
    typeText(extra)
  }

  it('启动时把上次的标签读回来：干净的重读磁盘，脏的照抄草稿', async () => {
    // beforeEach 只 reset 了 openFile、没给默认返回值：恢复干净标签走的正是这条路
    ipc.openFile.mockResolvedValue(textFile({ text: '磁盘上的样子' }))
    await restartWith(
      savedSession([savedTab({ path: '/a.txt' }), savedTab({ draft: '没存过的稿子', dirty: true })], {
        focused: 1,
        panes: [0, 1],
      }),
    )

    expect(tabs()).toHaveLength(2)
    expect(tabs()[0]!.textContent).toContain('a.txt')
    expect(tabs()[1]!.textContent).toContain('● 空文档')
    expect(hosts()).toHaveLength(2)
    // 干净又有路径的那个是**重新读盘**的：Vela 关着的时候文件可能被别的程序改过
    expect(views()[0]!.state.doc.toString()).toBe('磁盘上的样子')
    expect(ipc.openFile).toHaveBeenCalledWith('/a.txt')
    expect(views()[1]!.state.doc.toString()).toBe('没存过的稿子')
    // focused: 1 是**分屏**下标，所以状态栏报的是第二个标签
    expect(statusName()).toBe('● 空文档')
    expect(hosts()[1]!.classList.contains('focused')).toBe(true)
  })

  it('存档读不回来：提示条说一句，编辑器照常能用', async () => {
    await restartWith(null, { kind: 'corrupt', message: '第 2 个标签没有选区' })

    const [notice] = notices()
    expect(notice!.level).toBe('warning')
    expect(notice!.text).toContain('上次的会话没能读回来')
    expect(notice!.text).toContain('第 2 个标签没有选区')
    // 关键是应用没死：留着初始那个空标签，还能打字
    expect(tabs()).toHaveLength(1)
    typeText('还能打字')
    expect(statusCounts()).toBe('1 行 · 4 字符')
  })

  it('关窗放行后把会话写下去：分屏布局与聚焦的分屏都进存档', async () => {
    button('右分屏').click()
    expect(hosts()).toHaveLength(2)

    await rustRequestsClose()

    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
    expect(sessionCmd.saved).toHaveLength(1)
    expect(lastArchive().tabs).toHaveLength(2)
    expect(lastArchive().panes).toEqual([0, 1])
    expect(lastArchive().focused).toBe(1)
  })

  it('答「不保存」：被扔掉的稿子不会跟着存档回来', async () => {
    // 这条是 M1-F 与 M1-D 的接缝。有了会话存档之后，「不保存」不再等于「窗口一关就没了」：
    // 存档收草稿的条件就是脏标记，不清掉它，用户刚刚明确扔掉的东西下次启动会原样端回来
    await dirtyFileTab()

    await rustRequestsClose()
    expect(sessionCmd.saved).toHaveLength(0) // 没放行之前一个字节都不写
    modalButton('不保存').click()
    await flush()

    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(lastArchive().tabs[0]!.path).toBe('/a.txt')
    expect(lastArchive().tabs[0]!.dirty).toBe(false)
    expect(lastArchive().tabs[0]!.draft).toBeNull()
  })

  it('答「保存」：先落盘，存档里那个文档是干净的，下次启动重新读盘', async () => {
    await dirtyFileTab()

    await rustRequestsClose()
    modalButton('保存').click()
    await flush()

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
    expect(lastArchive().tabs[0]!.draft).toBeNull()
    expect(lastArchive().tabs[0]!.dirty).toBe(false)
  })

  it('答「取消」时一个字节都不写：用户没同意关，现场不该被当成已经存好了', async () => {
    await dirtyFileTab('/a.txt', '不想丢的稿子')

    await rustRequestsClose()
    modalButton('取消').click()
    await flush()

    expect(tauriCore.invoke).not.toHaveBeenCalledWith('close_window')
    expect(sessionCmd.saved).toHaveLength(0)
    // 稿子还在，脏标记也还在
    expect(statusName()).toBe('● a.txt')
  })

  it('现场没变过就不重复写：关两次也只存一份', async () => {
    await rustRequestsClose()
    await rustRequestsClose()

    expect(sessionCmd.saved).toHaveLength(1)
  })

  it('草稿超预算被丢掉时说出来，而且可以关掉', async () => {
    sessionCmd.droppedDrafts = 2
    button('右分屏').click()

    await rustRequestsClose()

    const [notice] = notices()
    expect(notice!.level).toBe('warning')
    expect(notice!.text).toContain('2 个文档')
    expect(notice!.text).toContain('没能存进会话')

    container.querySelector<HTMLButtonElement>('.notice-close')!.click()
    expect(container.querySelector('.notice')).toBeNull()
  })

  it('卸载时把节流定时器停掉：组件没了它还每 5 秒醒一次就是泄漏', async () => {
    // 这条盯的是 App 有没有接 `stop()`。真的 setInterval 在 jsdom 里是活的，
    // 不停掉的话它会在这个用例结束之后继续跑，把断言写到别的用例的存档里
    const before = sessionCmd.saved.length
    dispose()
    container.remove()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sessionCmd.saved).toHaveLength(before)
    // afterEach 还会 dispose 一次，重复调用必须安全
    mountApp()
  })
})

describe('侧边栏接线（M2-B）', () => {
  it('默认不渲染侧边栏，而 .body 被包在 .body-row → .main 两层里', () => {
    expect(sidebar()).toBeNull()
    const body = container.querySelector('.body')!
    // M2-B 那一层横向 flex：侧边栏与正文区并排
    expect(body.parentElement?.classList.contains('body-row')).toBe(true)
    // M2-C 那一层纵向 flex：正文区在上、全局搜索面板在下。
    // 两层都只是**包在原来那份 1fr 里面**，`.app` 的 grid 一个字没改
    expect(body.parentElement?.parentElement?.classList.contains('main')).toBe(true)
    expect(body.parentElement?.parentElement?.parentElement?.classList.contains('app')).toBe(true)
    expect(container.querySelectorAll('.body > .editor-host')).toHaveLength(1)
  })

  it('⚠️ .app 的 grid 子元素仍然是五个，搜索面板不算第六个', () => {
    // styles.css 里那条注释警告的正是这件事：`.app` 是行数固定的 grid，
    // 多出来的东西一旦成了 grid item，`1fr` 就会落到错误的行上，正文区被挤掉。
    // 所以面板必须住在 `.main` 里面，而不是直接当 `.app` 的孩子
    const app = container.querySelector('.app')!
    expect([...app.children].map((el) => el.className)).toEqual([
      'toolbar',
      'tab-strip',
      'notices',
      'main',
      'statusbar',
    ])
    // 默认没搜过，面板整个不渲染：没开过搜索的用户看到的布局与加这两层之前逐像素相同
    expect(container.querySelector('.find-panel')).toBeNull()
  })

  it('Mod+B 与工具栏按钮走同一条路，按钮标签跟着翻', () => {
    expect(sidebar()).toBeNull()
    // button() 找不到就抛，所以这一句同时钉住了「标签写的是关」
    expect(button('侧边栏关').title).toBe('Mod+B')

    press('b', modInit())
    expect(sidebar()).not.toBeNull()
    expect(button('侧边栏开')).toBeDefined()

    button('侧边栏开').click()
    expect(sidebar()).toBeNull()
    expect(button('侧边栏关')).toBeDefined()
  })

  it('点「文件夹…」弹原生目录对话框，选中之后侧边栏自动显示、树长出根与孩子', async () => {
    await openProject()

    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: true })
    expect(sidebar()).not.toBeNull()
    expect(container.querySelector('.sidebar-title')?.textContent).toBe('repo')
    expect(treeNames()).toEqual(['repo', 'src', 'README.md', 'docs'])
    expect(projectCmd.calls).toEqual([''])
  })

  it('目录对话框取消时侧边栏不显示：用户什么都没选，不该凭空弹出一条空栏', async () => {
    dialog.open.mockResolvedValue(null)
    button('文件夹…').click()
    await flush()

    expect(sidebar()).toBeNull()
    expect(projectCmd.calls).toEqual([])
  })

  it('点 + 把一个文件夹追加到工作区：头部改口报「2 个文件夹」，两个根各读各的盘', async () => {
    await openProject()
    expect(container.querySelector('.sidebar-title')?.textContent).toBe('repo')

    // 一次可以多选：真实对话框收的是 `multiple: true`，挑中的按顺序追加到后面
    dialog.open.mockResolvedValue(['/notes'])
    sidebarAct('添加文件夹').click()
    await flush()

    expect(dialog.open).toHaveBeenLastCalledWith({ multiple: true, directory: true })
    expect(container.querySelector('.sidebar-title')?.textContent).toBe('2 个文件夹')
    // 两个根各自摊开一层，谁也不吃谁的孩子——这是「每个根都是独立一棵树」的可见证据。
    // ⚠️ 只断言到第 5 行：jsdom 里 `clientHeight` 恒为 0，虚拟窗口只渲染 OVERSCAN 那几行，
    // 第 8 行压根没进 DOM。跨根那一条边界（`docs` 紧接着 `notes`）在前 5 行里已经看得见
    expect(treeNames().slice(0, 5)).toEqual(['repo', 'src', 'README.md', 'docs', 'notes'])
    expect(container.querySelector('.sidebar-title')?.getAttribute('title')).toBe('/repo\n/notes')
    // 每个根自己那条根行都是 level 1：`aria-level` 按根重新起算，不是一路数下去
    expect(treeRow('', '/notes').getAttribute('aria-level')).toBe('1')
  })

  it('+ 的对话框取消时工作区一动不动：追加失败不该留下半个根', async () => {
    await openProject()

    dialog.open.mockResolvedValue(null)
    sidebarAct('添加文件夹').click()
    await flush()

    expect(container.querySelector('.sidebar-title')?.textContent).toBe('repo')
    expect(treeNames()).toEqual(['repo', 'src', 'README.md', 'docs'])
    // 只读过最初那一个根的根层：取消之后不该有任何一次「补读」
    expect(projectCmd.calls).toEqual([''])
  })

  it('树是懒加载的：只有点开的那一层才去读盘', async () => {
    await openProject()

    treeRow('src').click()
    await flush()

    expect(treeNames()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
    expect(projectCmd.calls).toEqual(['', 'src'])
    // docs 从没被点开，就一次都不该读——十万行的仓库全靠这条撑着
    expect(projectCmd.calls).not.toContain('docs')
  })

  it('点树里的文件走的是同一套打开流程：正文进编辑器、标签名与状态栏跟着变', async () => {
    await openProject()
    treeRow('src').click()
    await flush()
    ipc.openFile.mockResolvedValue(textFile({ text: '从树里打开的正文' }))

    treeRow('src/a.ts').click()
    await flush()

    expect(ipc.openFile).toHaveBeenCalledWith('/repo/src/a.ts')
    expect(view().state.doc.toString()).toBe('从树里打开的正文')
    expect(statusName()).toBe('a.ts')
    expect(tabs()[0]!.querySelector('.tab-name')?.textContent).toBe('a.ts')
  })

  it('点头部的 × 关掉根：树回到空状态，但侧边栏本身留着', async () => {
    await openProject()

    sidebarAct('关闭所有文件夹').click()

    // 刻意不跟着收起：那条「打开文件夹…」正是用户下一步要点的东西，
    // 顺手把栏藏掉等于把他刚用过的入口拿走
    expect(sidebar()).not.toBeNull()
    expect(container.querySelector('.sidebar-open')?.textContent).toBe('打开文件夹…')
    expect(treeRowEls()).toHaveLength(0)
    expect(statusName()).toBe('空文档') // 已打开的标签一个都没动
  })

  it('点头部的 ↻ 重读所有摊开的层', async () => {
    await openProject()
    treeRow('src').click()
    await flush()

    sidebarAct('重新读取').click()
    await flush()

    expect(projectCmd.calls).toEqual(['', 'src', '', 'src'])
  })

  it('收起再展开侧边栏，树的状态原样还在，而且一次都不重读', async () => {
    await openProject()
    treeRow('src').click()
    await flush()
    expect(projectCmd.calls).toEqual(['', 'src'])

    press('b', modInit())
    expect(sidebar()).toBeNull()
    press('b', modInit())

    // `<Show>` 收起时是真的把组件卸了，重新挂上时读的是 store 里的缓存——
    // 状态在 store 而不在组件里，这正是「收起侧边栏不该丢展开进度」的实现方式
    expect(treeNames()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
    expect(projectCmd.calls).toEqual(['', 'src'])
  })

  it('读不出来的一层把错误挂在行内，不影响别的层', async () => {
    // `locked` 只在根那一层的条目里出现，`projectCmd.fs` 里没有它——
    // 于是 list_dir 会以 not_found 拒绝，正是「目录被外部删掉/权限不够」那个处境
    projectCmd.fs[''] = [...projectCmd.fs['']!, dirEntry('locked', 'locked', true)]
    await openProject()

    treeRow('locked').click()
    await flush()

    const row = treeRow('locked')
    expect(row.classList.contains('failed')).toBe(true)
    expect(row.querySelector('.tree-note.bad')?.textContent).toContain('找不到')
    // 别的层照常渲染，一个都没被牵连
    expect(treeNames()).toEqual(['repo', 'src', 'README.md', 'docs', 'locked'])
  })

  /** 存档里一个标签的形状。只关心 project 那一半，所以标签部分给最简单的干净文件 */
  function archiveWith(project: unknown) {
    return {
      version: 1,
      direction: 'row',
      focused: 0,
      tabs: [
        {
          path: '/a.txt',
          format: { encoding: 'utf8', bom: false, eol: 'lf' },
          dirty: false,
          lossy: false,
          draft: null,
          selection: [[0, 0]],
          main: 0,
          scrollTop: 0,
          scrollLeft: 0,
        },
      ],
      panes: [0],
      project,
      // 与上面 `savedSession` 同一条理由：线上这两个键永远在，缺了恢复只会失败一半
      recent: [],
      recentProjects: [],
    }
  }

  it('上次开着文件夹：启动后侧边栏自己展开，树摊到存档里那一层', async () => {
    ipc.openFile.mockResolvedValue(textFile({ text: '磁盘上的样子' }))
    projectCmd.calls = []

    // ⚠️ 这里是**新形状**：`{root, expanded}` → `{roots:[…]}` 的兼容在 Rust 的
    // `SessionProject::deserialize` 里，而这一层的 `loadSession` 是假的，压根不过 Rust。
    // 前端拿到手的恒为已经归一化过的那一份
    await restartWith(archiveWith({ roots: [{ root: '/repo', expanded: ['', 'src'] }] }))

    // 树恢复好了却看不见，等于没恢复——所以侧边栏要跟着存档一起回来
    expect(sidebar()).not.toBeNull()
    expect(button('侧边栏开')).toBeDefined()
    expect(treeNames()).toEqual(['repo', 'src', 'a.ts', 'b.ts', 'README.md', 'docs'])
    // 只读存档里摊开的那两层，`docs` 一次都没读（懒加载在恢复路径上照样成立）
    expect([...projectCmd.calls].sort()).toEqual(['', 'src'])
    // 标签那一半同时装好了：两半是并行的
    expect(statusName()).toBe('a.txt')
    // 一条 warn 都没有 = 恢复真的走完了。`sessionSync` 的 catch 会把 `restoreSession`
    // 里的任何抛变成一条提示，而那之前标签已经装好了——只看上面两条断言的话，
    // 「恢复失败了一半」与「恢复成功」长得一模一样
    expect(notices()).toEqual([])
  })

  it('上次没开文件夹：侧边栏保持收起，不弹一条空栏出来', async () => {
    ipc.openFile.mockResolvedValue(textFile({ text: '磁盘上的样子' }))
    projectCmd.calls = []

    await restartWith(archiveWith(null))

    expect(sidebar()).toBeNull()
    expect(button('侧边栏关')).toBeDefined()
    expect(projectCmd.calls).toEqual([])
    expect(statusName()).toBe('a.txt')
  })

  it('关掉文件夹之后，写出去的存档里 project 是 null', async () => {
    // 这条走的是「写」的方向：用户开着项目、然后关掉了文件夹，
    // 关窗补存的那一份必须把 project 写成 null，否则下次启动又把他关掉的东西弹回来
    await openProject()
    expect(button('侧边栏开')).toBeDefined()

    sidebarAct('关闭所有文件夹').click()
    await flush()
    // 侧边栏本身留着，显示那个「打开文件夹…」的空状态——那正是用户下一步要点的东西
    expect(sidebar()).not.toBeNull()

    await rustRequestsClose()

    const last = sessionCmd.saved[sessionCmd.saved.length - 1] as { project: unknown }
    expect(last.project).toBeNull()
  })
})

describe('全局搜索接线（M2-C）', () => {
  it('⚠️ 三个搜索事件在挂载时就挂上了，不是每次搜索挂一遍', () => {
    // `listen` 本身是异步的，注册之前到达的事件**永久丢失**。而 `start_search` 是
    // 先 spawn 后台线程再返回 taskId 的，所以「事件已经在路上」与「前端还没挂好」
    // 这两件事会重叠。丢掉的偏偏是最前面那几批，表现是「共 87 处」与列表里的条数对不上——
    // 一个没有任何报错可查的静默漏数
    expect(listeners.has(SEARCH_BATCH_EVENT)).toBe(true)
    expect(listeners.has(SEARCH_DONE_EVENT)).toBe(true)
    expect(listeners.has(SEARCH_FAILED_EVENT)).toBe(true)
    // 关窗守卫那一个也还挂着：两组监听共用同一个 `listen` 桩，
    // 谁把对方顶掉了这里会一起红
    expect(listeners.has(REQUEST_CLOSE_EVENT)).toBe(true)
  })

  it('还没搜过时面板整个不渲染，正文区独占 .main', () => {
    expect(container.querySelector('.find-panel')).toBeNull()
    const main = container.querySelector('.main')!
    expect([...main.children].map((el) => el.className)).toEqual(['body-row'])
  })

  it('Mod+Shift+F 与工具栏那个「搜索…」按钮是两个入口、同一条路', async () => {
    expect(button('搜索…').title).toBe('Mod+Shift+F')

    press('F', { ...modInit(), shiftKey: true })
    await flush()
    // ⚠️ 面板必须是 `.main` 的**第二个孩子**，与 `.body-row` 平级：
    // 它要占的是正文区下方那份高度，而不是 `.app` 的第六个 grid 行
    expect([...container.querySelector('.main')!.children].map((el) => el.className)).toEqual([
      'body-row',
      'find-panel',
    ])
    // 展开就该把焦点放进输入框，否则用户按了快捷键还得去够鼠标
    expect(document.activeElement).toBe(findInput())

    pressInFind('Escape')
    await flush()
    expect(findPanel()).toBeNull()

    button('搜索…').click()
    await flush()
    expect(findPanel()).not.toBeNull()
    // 面板本来就展开着时再按一次也要能把焦点抢回来，所以 store 里那个是自增计数不是布尔
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    expect(document.activeElement).toBe(findInput())
  })

  it('Mod+Shift+H 一步落到替换模式，而连按第二次不许把那一排收掉', async () => {
    press('H', { ...modInit(), shiftKey: true })
    await flush()
    expect(findPanel()).not.toBeNull()
    expect(findMode().classList.contains('on')).toBe(true)
    expect(container.querySelector('.find-replace')).not.toBeNull()
    // 搜索词还是空的：要打的第一个东西是搜索词，所以焦点留在上面那一格
    expect(document.activeElement).toBe(findInput())

    press('H', { ...modInit(), shiftKey: true })
    await flush()
    // 快捷键的语义是「我要替换」，不是「翻一下开关」——翻开关是面板上那个按钮的事。
    // store 里为此单开了一个 `showReplace`，见 src/search/store.ts
    expect(findMode().classList.contains('on')).toBe(true)
    expect(container.querySelector('.find-replace')).not.toBeNull()
  })

  it('先 Mod+Shift+F 搜着再按 Mod+Shift+H，焦点直接落到「替换为」那一格', async () => {
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    // ⚠️ 不能用 `replaceInput()`：那个 helper 在找不到时是**抛错**的，
    // 而这里要断言的恰恰是「还没有那一排」
    expect(container.querySelector('.find-replace')).toBeNull()

    typeSearch('needle')
    press('H', { ...modInit(), shiftKey: true })
    await flush()
    // 搜索词已经有了，下一个要打的正好是替换内容，所以焦点该往下挪一格
    expect(document.activeElement).toBe(replaceInput())
    // 面板还是只有一个：替换那一排是它**内部**的一行，不是 `.main` 的第三个孩子
    expect([...container.querySelector('.main')!.children].map((el) => el.className)).toEqual([
      'body-row',
      'find-panel',
    ])
  })

  it('还没打开文件夹时按 Enter 说「还没打开文件夹」，一次 IPC 都不发', async () => {
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    typeSearch('needle')
    pressInFind('Enter')
    await flush()

    // 与侧边栏那几条项目级动作同一句话：没打开文件夹时说的都是它
    expect(container.querySelector('.find-error')?.textContent).toBe('还没打开文件夹')
    expect(searchCmd.calls).toEqual([])
    expect(findRows()).toHaveLength(0)
  })

  it('⚠️ 端到端：搜一遍 → 批次落成行 → 点一条命中 → 打开那个文件并把选区落在那一段上', async () => {
    await openProject()
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    typeSearch('needle')
    pressInFind('Enter')
    await flush()

    // 发出去的 query **只有四个 key**：include / exclude 刻意不发，Rust 侧容器上有
    // `#[serde(default)]`，缺 key 就是「不限」。前端替它补两个空数组等于把默认值抄两份
    // ⚠️ `roots` 是数组，单根时也是长度为 1 的数组——顺序就是 `rootIndex` 的语义
    expect(searchCmd.calls).toEqual([
      { roots: ['/repo'], query: { pattern: 'needle', literal: false, caseSensitive: false, wholeWord: false } },
    ])
    expect(findStatus()).toBe('正在搜索… 已扫过 0 个文件')

    await fireEvent(SEARCH_BATCH_EVENT, {
      taskId: searchCmd.taskId,
      batch: {
        files: [
          {
            rel: 'src/a.ts',
            path: '/repo/src/a.ts',
            // ⚠️ `rootIndex` 在契约上总是出现（M2-F），单根时恒为 0
            rootIndex: 0,
            // 偏移量是 UTF-16 码元，与 String.prototype.slice、与 CM6 的文档位置同一口径
            hits: [
              { line: 1, text: 'let a = needle;', ranges: [{ start: 8, end: 14 }], truncated: false },
              { line: 2, text: 'let b = needle;', ranges: [{ start: 8, end: 14 }], truncated: false },
            ],
            truncated: false,
          },
        ],
        filesScanned: 7,
      },
    })

    // 一行文件标题 + 两条命中，摊成一个扁平数组（分组只体现在行的顺序上，不建父子指针）
    expect(findRowTexts()).toEqual(['src/a.ts2 处', '1let a = needle;', '2let b = needle;'])
    expect(findRows()[2]!.querySelectorAll('mark.find-mark')).toHaveLength(1)
    expect(findStatus()).toBe('正在搜索… 已扫过 7 个文件')

    // 点第二条命中。打开的正文与搜索结果对得上，于是行号与偏移量都还有效
    ipc.openFile.mockResolvedValue(textFile({ text: 'let a = needle;\nlet b = needle;\n' }))
    findRows()[2]!.click()
    await flush()

    expect(ipc.openFile).toHaveBeenCalledWith('/repo/src/a.ts')
    expect(statusName()).toBe('a.ts')
    // 第 2 行从文档位置 16 起，命中段 8..14 → 24..30。这一条钉的是 revealTarget 与
    // EditorController.reveal 的接线：偏移量算错一个单位的话，含 emoji 的行会选中位置错开
    expect(view().state.sliceDoc(24, 30)).toBe('needle')
    expect(view().state.selection.main.from).toBe(24)
    expect(view().state.selection.main.to).toBe(30)
    // 面板不跟着收起：搜完一处、看一眼、再点下一处是连续动作
    expect(findPanel()).not.toBeNull()
  })

  it('搜索进行中才出现「取消」，点它去作废那个 taskId，已经推来的结果留着', async () => {
    await openProject()
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    expect(findButton('取消')).toBeNull()

    typeSearch('needle')
    pressInFind('Enter')
    await flush()
    expect(findButton('取消')).not.toBeNull()

    await fireEvent(SEARCH_BATCH_EVENT, {
      taskId: searchCmd.taskId,
      batch: {
        files: [{ rel: 'README.md', path: '/repo/README.md', hits: [], truncated: false }],
        filesScanned: 3,
      },
    })

    findButton('取消')!.click()
    await flush()

    expect(searchCmd.cancelled).toEqual([searchCmd.taskId])
    // 取消是协作式的，随后那几批仍然有效：这里自己把结果清掉的话，用户点「取消」
    // 会得到「已经搜到的也没了」，而他表达的只是「别再搜下去了」
    expect(findRows()).toHaveLength(1)
    expect(findButton('取消')).not.toBeNull()
  })

  it('done 事件是唯一的终止信号：总账落地，「取消」按钮消失', async () => {
    await openProject()
    press('F', { ...modInit(), shiftKey: true })
    await flush()
    typeSearch('needle')
    pressInFind('Enter')
    await flush()

    await fireEvent(SEARCH_DONE_EVENT, {
      taskId: searchCmd.taskId,
      summary: {
        filesScanned: 12,
        filesWithHits: 0,
        hits: 0,
        skippedTooLarge: 0,
        // ⚠️ 这一条不是总账的一部分，是单独一行警告色：它说的是「这个 0 可能是假的」
        unreadable: 2,
        truncated: false,
        cancelled: false,
        elapsedMs: 1200,
      },
    })

    expect(findStatus()).toBe('没有找到 · 扫过 12 个文件 · 1.20s')
    expect(container.querySelector('.find-warning')?.textContent).toBe(
      '有 2 个条目读不出来（权限不够、被删或 IO 错误），所以「没有找到」不一定成立',
    )
    expect(findButton('取消')).toBeNull()
  })
})

describe('全局替换接线（M2-D）', () => {
  /**
   * 走一遍完整的用户路径：打开项目 → 一个干净标签 + 一个改脏的标签 → 打开替换模式、
   * 填好替换内容、搜出预览 → 摊开确认单。返回时 `start_replace` **还没**发出去。
   *
   * ⚠️ 这一串必须是一个用例里的连续动作，不能拆成几段分别摆弄：确认单上的数字来自
   * 「预览那一刻的 `rows()`」，`skip` 清单来自「批准那一刻的 `dirtyPaths()`」，
   * 两头都在动。分开造的话每一半都能单独造假，绿了也说明不了接线是对的
   */
  async function previewTwo(): Promise<void> {
    await openProject()
    disk = { '/repo/README.md': 'a needle here', '/repo/src/a.ts': 'let a = needle;\n' }
    ipc.openFile.mockImplementation(async (path: string) => textFile({ text: disk[path] ?? '正文' }))

    // 第一次「打开…」落在启动那个干净的空白标签上（复用它，不新建），
    // 第二次因为活动标签已经有路径了，才另开一个。于是 tabs() = [README.md, a.ts]
    dialog.open.mockResolvedValue('/repo/README.md')
    button('打开…').click()
    await flush()
    dialog.open.mockResolvedValue('/repo/src/a.ts')
    button('打开…').click()
    await flush()
    // ⚠️ 必须真的敲字把它改脏：`skip` 清单来自 `dirtyPaths()`，
    // 一个干净标签压根不在里面，那条「保护未保存的稿子」的断言就会绿得毫无意义
    typeText('改一下')
    await flush()
    expect(statusName()).toBe('● a.ts')

    press('F', { ...modInit(), shiftKey: true })
    await flush()
    typeSearch('needle')
    findMode().click()
    await flush()
    typeReplace('NEEDLE')
    pressInFind('Enter')
    await flush()

    await fireEvent(SEARCH_BATCH_EVENT, {
      taskId: searchCmd.taskId,
      batch: {
        files: [
          {
            rel: 'README.md',
            path: '/repo/README.md',
            rootIndex: 0,
            hits: [
              {
                line: 1,
                text: 'a needle here',
                ranges: [{ start: 2, end: 8 }],
                replaced: 'a NEEDLE here',
                truncated: false,
              },
            ],
            truncated: false,
          },
          {
            rel: 'src/a.ts',
            path: '/repo/src/a.ts',
            rootIndex: 0,
            hits: [
              {
                line: 1,
                text: 'let a = needle;',
                ranges: [{ start: 8, end: 14 }],
                replaced: 'let a = NEEDLE;',
                truncated: false,
              },
            ],
            truncated: false,
          },
        ],
        filesScanned: 2,
      },
    })
    await fireEvent(SEARCH_DONE_EVENT, {
      taskId: searchCmd.taskId,
      summary: {
        filesScanned: 2,
        filesWithHits: 2,
        hits: 2,
        skippedTooLarge: 0,
        unreadable: 0,
        truncated: false,
        cancelled: false,
        elapsedMs: 15,
      },
    })

    findButton('替换全部')!.click()
    await flush()
  }

  it('⚠️ 替换那三个事件与搜索那三个**同时**挂着，不是等到第一次替换才挂', () => {
    // `listen` 是异步的，注册之前到达的事件永久丢失。而 `replace-done` 是唯一能让 UI
    // 停止转圈的东西，它到达时磁盘已经改完了——漏掉它用户面对的是一个
    // 「改完了却显示还在改」的仓库，很可能再按一次替换，而第二次的预览是第一次的结果
    expect(listeners.has(REPLACE_PROGRESS_EVENT)).toBe(true)
    expect(listeners.has(REPLACE_DONE_EVENT)).toBe(true)
    expect(listeners.has(REPLACE_FAILED_EVENT)).toBe(true)
    // 搜索那三个与关窗守卫那一个都还在：六个监听共用同一个 `listen` 桩，
    // 谁把谁顶掉了这里会一起红
    expect(listeners.has(SEARCH_BATCH_EVENT)).toBe(true)
    expect(listeners.has(SEARCH_DONE_EVENT)).toBe(true)
    expect(listeners.has(REQUEST_CLOSE_EVENT)).toBe(true)
  })

  it('卸载时替换那三个监听也一起摘掉', () => {
    dispose()
    // 重新挂一个空的，避免 afterEach 再 dispose 一次已卸载的树
    dispose = () => {}

    expect(listeners.has(REPLACE_PROGRESS_EVENT)).toBe(false)
    expect(listeners.has(REPLACE_DONE_EVENT)).toBe(false)
    expect(listeners.has(REPLACE_FAILED_EVENT)).toBe(false)
    expect(listeners.has(SEARCH_DONE_EVENT)).toBe(false)
  })

  it('「替换」点开之后才多出下面那一排，而它是面板**内部**的一行', async () => {
    await openProject()
    press('F', { ...modInit(), shiftKey: true })
    await flush()

    expect(container.querySelector('.find-replace')).toBeNull()
    expect(headButtonTitles()).toEqual(['替换', '.*', 'Aa', 'ab', '搜索', '⌫', '×'])
    findMode().click()
    await flush()

    expect(container.querySelector('.find-replace')).not.toBeNull()
    expect(headButtonTitles()).toEqual(['替换', '.*', 'Aa', 'ab', '预览', '⌫', '×'])
    // `.main` 的孩子没变：多出来的那一排住在面板里面，不是 grid 的新行。
    // 面板高度是硬约束（styles.css 的 `.find-panel`），所以这一排只能从 240px 里扣
    expect([...container.querySelector('.main')!.children].map((el) => el.className)).toEqual([
      'body-row',
      'find-panel',
    ])
  })

  it('⚠️ 端到端：预览 → 确认单 → 批准 → 落盘 → 开着的干净标签被重读，脏的一个字节都不碰', async () => {
    await previewTwo()

    // 脏的那个文件在**预览**里就标出来了：`start_search` 不知道 `skip` 的存在，
    // 不标的话用户批准的是一份做不到的清单
    expect(findRows()[0]!.classList.contains('skipped')).toBe(false)
    expect(findRows()[2]!.classList.contains('skipped')).toBe(true)
    expect(findRowTexts()[2]).toContain('正开着且有未保存的改动，跳过')
    // 命中行上是「原文 → 预览」，`.find-new` 那一段说的才是换完的样子
    expect(container.querySelector('.find-new')?.textContent).toBe('a NEEDLE here')

    // 确认单渲染在 `.app` 那一层，不在面板里面：`.modal-backdrop` 是 fixed，
    // 挂在 240px 的面板里就只罩得住面板自己，而「批准落盘」这件事该盖住整个窗口
    expect(modal()).not.toBeNull()
    expect(findPanel()!.querySelector('.modal-backdrop')).toBeNull()
    // 数字说的是「行」不是「处」，而且**不含**被跳过的那个文件
    expect(modal()!.getAttribute('aria-label')).toBe('替换 1 个文件里的 1 行？')
    expect(modal()!.textContent).toContain('Vela 没有跨文件撤销')
    expect(replaceCmd.calls).toEqual([])

    modalButton('替换').click()
    await flush()

    // ⚠️ `skip` 里必须带着那个脏标签的绝对路径，原样递：后端逐组件比 Path 相等，
    // 前端自己 normalize 一遍就会「少保护一个文件」，而那意味着用户的稿子被落盘盖掉
    // ⚠️ `roots` 递的是**当前**那份根清单，而 `previewKey` 指纹已经保证它与用户在预览里
    // 看到的那一份逐字段相同——多一个根就是改了用户没批准过的文件夹
    expect(replaceCmd.calls).toEqual([
      {
        roots: ['/repo'],
        request: {
          query: { pattern: 'needle', literal: false, caseSensitive: false, wholeWord: false, replace: 'NEEDLE' },
          skip: ['/repo/src/a.ts'],
        },
      },
    ])
    expect(modal()).toBeNull()
    // 一个快照都没来过是**正常的**（全部文件都没命中时既没有改动触发推送、心跳又远没到），
    // 所以这时说的是不带数字的一句，而不是「已改 0 个文件」假装收到了
    expect(findStatus()).toBe('正在替换…')

    await fireEvent(REPLACE_PROGRESS_EVENT, {
      taskId: replaceCmd.taskId,
      progress: { filesScanned: 1, filesChanged: 1, replacements: 1 },
    })
    expect(findStatus()).toBe('正在替换… 已改 1 个文件、1 处（扫过 1 个）')

    // 磁盘上已经换过了：随后的对账重读到的必须是这一份
    disk['/repo/README.md'] = 'a NEEDLE here'
    ipc.openFile.mockClear()
    await fireEvent(REPLACE_DONE_EVENT, { taskId: replaceCmd.taskId, summary: replaceSummary({ skippedOpen: 1 }) })
    await flush()

    expect(findStatus()).toBe('换了 1 处，写进 1 个文件 · 扫过 2 个文件 · 40ms')
    expect(container.querySelector('.find-warning')?.textContent).toBe(
      '有 1 个文件正开着且有未保存的改动，被跳过了——保存它们之后再换一遍',
    )
    // 不变量 4：预览整个扔掉。留着的话「替换全部」仍然可点，而它显示的仍是写盘之前的样子——
    // 把 `foo` 换成 `foobar` 的人再按一次，第二轮会接着长
    expect(findRows()).toHaveLength(0)
    expect(findButton('替换全部')!.disabled).toBe(true)

    // 对账只碰了那个干净标签：脏的那个连读都没读（读了也是白读，`reload` 会拒绝）
    expect(ipc.openFile.mock.calls.map((c) => c[0])).toEqual(['/repo/README.md'])
    // 而这件事要说一句：编辑器里的正文自己动了、撤销栈也重建了，
    // 不解释的话用户看到的是「我刚在改的文件自己变了」
    expect(
      notices()
        .map((n) => n.text)
        .join(''),
    ).toContain('已把 1 个开着的标签从磁盘重读了一遍')

    // 切回那个干净标签：显示的必须是落盘之后的内容，否则他下一次 ⌘S 又把结果盖回去
    tabs()[0]!.click()
    await flush()
    expect(statusName()).toBe('README.md')
    expect(view().state.doc.toString()).toBe('a NEEDLE here')

    // 脏标签的稿子原样留着：跳过它的**全部理由**就是保住这一份
    tabs()[1]!.click()
    await flush()
    expect(statusName()).toBe('● a.ts')
    expect(view().state.doc.toString()).toBe('let a = needle;\n改一下')
  })

  it('确认单上点「取消」：一个字节都不写，预览原样留着', async () => {
    await previewTwo()
    expect(modal()).not.toBeNull()

    modalButton('取消').click()
    await flush()

    expect(modal()).toBeNull()
    expect(replaceCmd.calls).toEqual([])
    // 预览不清：用户只是还没下决心，不是要重来一遍。清掉的话他得重新搜一次才能再问一遍
    expect(findRows()).toHaveLength(4)
    expect(findButton('替换全部')!.disabled).toBe(false)

    // 再点一次还能再摊开：确认单是可反复的，不是一次性的
    findButton('替换全部')!.click()
    await flush()
    expect(modal()).not.toBeNull()
  })

  it('写盘期间「取消」走 cancel_task，认的是替换那个 taskId', async () => {
    await previewTwo()
    modalButton('替换').click()
    await flush()
    expect(findButton('取消')).not.toBeNull()

    findButton('取消')!.click()
    await flush()

    // ⚠️ 不是搜索那个 id：两个 TaskSlot 各有各的 `retired`，认错的话被取消的是
    // 一个早就结束了的搜索，而真正在改磁盘的那一轮继续跑到底
    expect(searchCmd.cancelled).toEqual([replaceCmd.taskId])
    expect(searchCmd.cancelled).not.toContain(searchCmd.taskId)

    // 取消**不是撤销**：已经写完的文件留在磁盘上，由随后的 done 如实报出
    await fireEvent(REPLACE_DONE_EVENT, {
      taskId: replaceCmd.taskId,
      summary: replaceSummary({ cancelled: true, filesChanged: 1, replacements: 1 }),
    })
    expect(findStatus()).toContain('已取消（改动不会回滚）')
    expect(findButton('取消')).toBeNull()
  })
})

/** 浮层的根节点。没展开时是 null——「此刻它不该在」正是几条用例要钉的东西 */
function palette(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.palette-backdrop')
}

function paletteInput(): HTMLInputElement {
  const el = palette()?.querySelector<HTMLInputElement>('.palette-input')
  if (!el) throw new Error('浮层里没有输入框')
  return el
}

function paletteRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.palette-row')]
}

function paletteRowTexts(): string[] {
  return paletteRows().map((el) => el.querySelector('.palette-text')?.textContent ?? '')
}

function paletteStatus(): string {
  return container.querySelector('.palette-status')?.textContent ?? ''
}

/** 往浮层的输入框里敲字。与 `typeSearch` 同一条路：普通 `<input>`，不是 CM6 的事务 */
function typeGoto(text: string): void {
  const el = paletteInput()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 在浮层里按一个键。bubbles 是必需的：Solid 把 keydown 委托在 document 上 */
function pressInPalette(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  paletteInput().dispatchEvent(event)
  return event
}

/** 一条索引命中。`score` 只影响 Rust 侧的排序，而桩是按数组顺序原样回的 */
function matchOf(rel: string, score = 10): FileMatch {
  // `rootIndex` 在契约上不是可选的（M2-F）。浮层这一层还只画单根的候选
  return { rel, path: `/repo/${rel}`, score, rootIndex: 0 }
}

/** 光标现在在第几行（1 起算）。跳行那两条用例只认这个数 */
function cursorLine(): number {
  const v = view()
  return v.state.doc.lineAt(v.state.selection.main.head).number
}

describe('跳转浮层接线（M2-E）', () => {
  it('默认不渲染浮层；展开时它是 .app 的最后一个孩子，不给那个行数固定的 grid 多加一行', async () => {
    expect(palette()).toBeNull()

    await openProject()
    press('p', modInit())
    await flush()

    const app = container.querySelector('.app')!
    expect([...app.children].map((el) => el.className)).toEqual([
      'toolbar',
      'tab-strip',
      'notices',
      'main',
      'statusbar',
      'palette-backdrop',
    ])
    // ⚠️ 排在最后不是随手放的：它的 z-index 比两个模态都高（styles.css 里写着理由），
    // 于是「DOM 里靠后的在上面」这条直觉在这里也成立。`.palette-backdrop` 是 fixed，
    // 不参与 grid 布局——正文区那一行 `1fr` 一个字都没被它挤走
  })

  it('空窗口里按 Mod+P：浮层展开、一个 IPC 都不发，状态行说清楚缺什么', async () => {
    press('p', modInit())
    await flush()

    expect(palette()).not.toBeNull()
    expect(projectCmd.indexed).toEqual([])
    expect(projectCmd.queries).toEqual([])
    // 「按了没反应」与「按了但缺前提」是两回事：前者用户只会以为快捷键坏了
    expect(paletteStatus()).toBe('先打开一个文件夹，才能按名字找文件')
    expect(paletteInput().value).toBe('')
  })

  it('Mod+P 建一次索引并自动查一遍空词，焦点落在输入框上', async () => {
    await openProject()
    expect(projectCmd.indexed).toEqual([])

    press('p', modInit())
    await flush()

    // ⚠️ 两层方括号：外层是「建过几次索引」，里层是那一次收到的根清单。
    // M2-F 起 `index_project` 收的是 `roots: string[]`，单根时是长度为 1 的数组
    expect(projectCmd.indexed).toEqual([['/repo']])
    // 刚展开时一个字都没打，查的是空词——那一批就是「随便给我最近用过的」
    expect(projectCmd.queries).toEqual([{ roots: ['/repo'], needle: '', recent: [] }])
    expect(document.activeElement).toBe(paletteInput())
  })

  it('Mod+R 进去就是列标题模式：输入框里已经有 @，而且一个字节都不去查索引', async () => {
    typeText('# 一级标题\n\n正文一段\n\n## 二级标题\n')

    press('r', modInit())
    await flush()

    expect(paletteInput().value).toBe('@')
    expect(paletteRowTexts()).toEqual(['一级标题', '二级标题'])
    // 标题级别靠缩进表达，`.symbol` 那个类同时决定它用正文字体而不是代码字体
    expect(paletteRows().every((el) => el.classList.contains('symbol'))).toBe(true)
    expect(projectCmd.indexed).toEqual([])
    expect(projectCmd.queries).toEqual([])
  })

  it('敲字就去查，needle 原样递上去；回车把选中的那个文件真的打开', async () => {
    await openProject()
    projectCmd.result = { matches: [matchOf('src/a.ts'), matchOf('src/b.ts')], total: 2 }
    ipc.openFile.mockResolvedValue(textFile({ text: '从浮层打开的正文' }))

    press('p', modInit())
    await flush()
    typeGoto('a.ts')
    await flush()

    expect(projectCmd.queries.at(-1)).toEqual({ roots: ['/repo'], needle: 'a.ts', recent: [] })
    expect(paletteRowTexts()).toEqual(['src/a.ts', 'src/b.ts'])
    // ⚠️ Rust 侧已经按分数排好序了，前端**不许**再排一遍。桩按数组顺序原样回，
    // 所以这个数组的顺序正是「前端有没有偷偷重排」的照妖镜
    expect(paletteRows()[0]!.title).toBe('/repo/src/a.ts')

    pressInPalette('Enter')
    await flush()

    expect(ipc.openFile).toHaveBeenCalledWith('/repo/src/a.ts')
    expect(palette()).toBeNull()
    expect(view().state.doc.toString()).toBe('从浮层打开的正文')
    expect(statusName()).toBe('a.ts')
  })

  it('落地之后 MRU 记上了，下一次展开浮层就把它递给 Rust 去加分', async () => {
    await openProject()
    projectCmd.result = { matches: [matchOf('src/a.ts')], total: 1 }
    ipc.openFile.mockResolvedValue(textFile())

    press('p', modInit())
    await flush()
    pressInPalette('Enter')
    await flush()

    projectCmd.queries.length = 0
    press('p', modInit())
    await flush()

    // `recent` 是绝对路径，最新的在前。⚠️ 它**只用来加分**：Rust 侧拿它与索引里已有的
    // rel 比对，比不上的直接忽略，不会因为一份伪造的清单去多读一个文件
    expect(projectCmd.queries.at(-1)?.recent).toEqual(['/repo/src/a.ts'])
  })

  /**
   * ⚠️ 光标落点必须在**同步**那一拍上断言，不能等 `flush()`。
   *
   * 这不是偷懒，是 jsdom 的保真度到此为止。实测的事件顺序（探针记录）：
   *
   * 1. `reveal` 派发交易，state 的光标确实到了 278；
   * 2. 紧接着 `view.focus()` → jsdom 把 DOM 选区挪到 `(contentDOM, 0)`，而 CM6 的
   *    `updateSelection()` 那一下 `Selection.collapse()` 在 jsdom 里**没有落住**；
   * 3. jsdom 随后补发 `selectionchange`，CM6 的 `DOMObserver.onSelectionChange`
   *    看见「DOM 选区在编辑器里、且与 state 不一致」，判定成用户拖了光标，
   *    于是 `applyDOMChange` 把 state 的光标**改回 0**。
   *
   * 真浏览器里第 2 步的 `collapse()` 会落住，第 3 步的 `readSelectionRange()`
   * 因为两边一致直接返回 false，不会有这次回改——CM6 自己那条
   * 「浏览器在 focus 时把光标挪到了元素开头」的兜底也正是为这种情形写的。
   *
   * 所以这里断言的是产品真正做的那件事（算出 278 并派发出去），而「落定之后光标
   * 停在第 42 行」由下面那条 `a.ts:42` 用例覆盖——它的 `reveal` 跑在 `openAt` 之后
   * 的微任务里，jsdom 那条 `selectionchange` 早已消化完，全程不回改，
   * `cursorLine()` 稳稳地是 42。两条走的是同一段 `revealTarget` + `controller.reveal`。
   */
  it(':42 回车把当前文档跳到第 42 行，而且不发一次 IPC', async () => {
    typeText(Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行`).join('\n'))
    expect(statusCounts()).toBe('60 行 · 410 字符')
    expect(cursorLine()).toBe(1)

    press('p', modInit())
    await flush()
    expect(paletteInput().value).toBe('')
    typeGoto(':42')
    await flush()
    expect(paletteInput().value).toBe(':42')
    expect(paletteStatus()).toBe('跳到第 42 行（Enter 落地）')

    // 跳行没有候选可列，浮层里是空的——那不是一个错误状态
    expect(paletteRows()).toHaveLength(0)
    expect(projectCmd.queries).toEqual([])

    pressInPalette('Enter')
    // 第 42 行的行首 = 前 9 行各 5 字 + 第 10–41 行各 6 字 + 41 个换行 = 278
    expect(view().state.selection.main.head).toBe(278)
    expect(view().state.selection.main.empty).toBe(true)

    await flush()
    expect(palette()).toBeNull()
    // 跳行只动光标，一个字符都不该改
    expect(statusCounts()).toBe('60 行 · 410 字符')
  })

  it('文件名后面补 :42 与先打 :42 是同一个落点', async () => {
    await openProject()
    projectCmd.result = { matches: [matchOf('src/a.ts')], total: 1 }
    ipc.openFile.mockResolvedValue(
      textFile({ text: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行`).join('\n') }),
    )

    press('p', modInit())
    await flush()
    typeGoto('a.ts:42')
    await flush()

    // ⚠️ 递上去的 needle 里**没有** `:42`：那一截是行号，不是文件名的一部分，
    // 带着它去模糊匹配的话 `src/a.ts` 反而匹配不上
    expect(projectCmd.queries.at(-1)?.needle).toBe('a.ts')

    pressInPalette('Enter')
    await flush()

    expect(statusName()).toBe('a.ts')
    expect(cursorLine()).toBe(42)
  })

  it('Escape 收起浮层，一个文件都不打开', async () => {
    await openProject()
    projectCmd.result = { matches: [matchOf('src/a.ts')], total: 1 }

    press('p', modInit())
    await flush()
    const event = pressInPalette('Escape')
    await flush()

    expect(event.defaultPrevented).toBe(true)
    expect(palette()).toBeNull()
    expect(ipc.openFile).not.toHaveBeenCalled()
  })

  it('点浮层里的行等于选中并落地，不必先按 Enter', async () => {
    await openProject()
    projectCmd.result = { matches: [matchOf('src/a.ts'), matchOf('src/b.ts')], total: 2 }
    ipc.openFile.mockResolvedValue(textFile({ text: '第二份' }))

    press('p', modInit())
    await flush()
    paletteRows()[1]!.click()
    await flush()

    expect(ipc.openFile).toHaveBeenCalledWith('/repo/src/b.ts')
    expect(palette()).toBeNull()
    expect(view().state.doc.toString()).toBe('第二份')
  })
})

describe('最近项目接线（M2-F）', () => {
  /** 候选前面那一格。文件模式里装根名，项目模式里装父目录——同一个节点，两种读法 */
  function paletteRoots(): (string | null)[] {
    return paletteRows().map((el) => el.querySelector('.palette-root')?.textContent ?? null)
  }

  function sidebarTitle(): string {
    return container.querySelector('.sidebar-title')?.textContent ?? ''
  }

  /** 用工具栏的「文件夹…」把整个工作区换成 `path`。在 App 里这是用户的一次点击 */
  async function switchTo(path: string): Promise<void> {
    dialog.open.mockResolvedValue(path)
    button('文件夹…').click()
    await flush()
  }

  it('空窗口里按 Mod+Shift+O：浮层展开、一个 IPC 都不发，状态行说清楚怎么才会有东西', async () => {
    press('O', { ...modInit(), shiftKey: true })
    await flush()

    expect(palette()).not.toBeNull()
    expect(paletteRows()).toHaveLength(0)
    expect(projectCmd.indexed).toEqual([])
    expect(projectCmd.queries).toEqual([])
    // 与 Mod+P 那句同一条理由：「按了没反应」与「按了但还缺前提」是两回事
    expect(paletteStatus()).toBe('还没有别的项目：先用「文件夹…」打开一个，换过一次之后这里就有东西了')
    expect(paletteInput().placeholder).toBe('按名字或路径找最近项目…')
  })

  it('换过一次工作区之后，刚离开的那一个就出现在 Mod+Shift+O 里，点它把整棵树装回来', async () => {
    await openProject()
    expect(sidebarTitle()).toBe('repo')

    await switchTo('/notes')
    expect(sidebarTitle()).toBe('notes')

    press('O', { ...modInit(), shiftKey: true })
    await flush()

    expect(paletteRowTexts()).toEqual(['repo'])
    // ⚠️ 这一格是**父目录**，不是根名：`/repo` 的父目录就是 `/`。
    // 两个同名项目全靠它分开，而这一条也顺带钉住「浮层没有把 rootIndex 那套拿过来用」
    expect(paletteRoots()).toEqual(['/'])
    expect(paletteRows()[0]!.title).toBe('/repo')
    // 项目那一路压根不问索引：那 40–205ms 与它无关
    expect(projectCmd.indexed).toEqual([])
    expect(projectCmd.queries).toEqual([])
    expect(paletteStatus()).toBe('1 个最近项目')

    // 装回来的那一趟真的去读了盘：不然用户看到的是一棵空树
    const before = projectCmd.calls.length
    paletteRows()[0]!.click()
    await flush()

    expect(palette()).toBeNull()
    expect(sidebarTitle()).toBe('repo')
    expect(projectCmd.calls.length).toBeGreaterThan(before)
    // 切项目不动任何标签：那半份现场与树是两套独立状态（M2-B-4 的前提）。
    // 起始那个未保存的空标签还在原位，一次 openFile 都没被顺手发出去
    expect(statusName()).toBe('空文档')
    expect(ipc.openFile).not.toHaveBeenCalled()
  })

  it('⚠️ 多根工作区是**整份**记下来的：候选读作「repo +1」，点它两个根一起回来', async () => {
    await openProject()
    dialog.open.mockResolvedValue(['/notes'])
    sidebarAct('添加文件夹').click()
    await flush()
    expect(sidebarTitle()).toBe('2 个文件夹')

    await switchTo('/scratch')

    press('O', { ...modInit(), shiftKey: true })
    await flush()

    // 记成「一个根一条」的话这里会是两行 `repo` 与 `notes`，而切回去就只剩一个根——
    // 「我刚才那两个文件夹呢」这件事没有任何提示
    expect(paletteRowTexts()).toEqual(['repo +1'])
    expect(paletteRows()[0]!.title).toBe('/repo\n/notes')

    paletteRows()[0]!.click()
    await flush()

    expect(sidebarTitle()).toBe('2 个文件夹')
    expect(treeNames().slice(0, 5)).toEqual(['repo', 'src', 'README.md', 'docs', 'notes'])
  })

  it('从项目模式切到 Mod+P：那一次必须把索引补建上，否则列表空空如也', async () => {
    await openProject()
    await switchTo('/notes')

    press('O', { ...modInit(), shiftKey: true })
    await flush()
    expect(projectCmd.indexed).toEqual([])

    // 浮层已经开着，`show` 走的是「换一个意图」那条分支——它**不**重建索引。
    // 而项目模式压根没建过，所以这里靠 `indexed()` 补一次
    press('p', modInit())
    await flush()

    expect(projectCmd.indexed).toEqual([['/notes']])
    expect(paletteInput().placeholder).toBe('按名字找文件…（:42 跳行，@ 列标题）')
  })

  it('打字就地过滤最近项目，按父目录也认', async () => {
    await openProject()
    await switchTo('/notes')
    await switchTo('/scratch')

    press('O', { ...modInit(), shiftKey: true })
    await flush()
    expect(paletteRowTexts()).toEqual(['notes', 'repo'])

    typeGoto('rep')
    await flush()
    expect(paletteRowTexts()).toEqual(['repo'])
    expect(paletteStatus()).toBe('1 个最近项目')
  })
})

describe('文件监听接线（M2-G）', () => {
  const README = '/repo/README.md'
  const A_TS = '/repo/src/a.ts'

  /**
   * 把「磁盘」换成给定内容，并让 `openFile` 从它上面读。
   *
   * ⚠️ 用例要在**跑动中间**改它：静默重载与「用磁盘上的覆盖」读的都是改动之后那一份，
   * 写成常量的话两者读回来的是同一份内容，断言会绿得毫无意义
   */
  function useDisk(contents: Record<string, string>): void {
    disk = contents
    ipc.openFile.mockImplementation(async (path: string) => textFile({ text: disk[path] ?? '正文' }))
  }

  /** 「打开…」→ 目录对话框选中 path。在 App 里这是用户的一次点击 */
  async function openFromDialog(path: string): Promise<void> {
    dialog.open.mockResolvedValue(path)
    button('打开…').click()
    await flush()
  }

  /** 一个干净的 README 标签（落在启动那个空白标签上，不新建） */
  async function cleanTab(): Promise<void> {
    useDisk({ [README]: 'README 的正文' })
    await openFromDialog(README)
    expect(statusName()).toBe('README.md')
  }

  /** README 干净 + a.ts 被敲脏，活动标签是 a.ts */
  async function twoTabs(): Promise<void> {
    useDisk({ [README]: 'README 的正文', [A_TS]: 'let a = 1;\n' })
    await openFromDialog(README)
    await openFromDialog(A_TS)
    // ⚠️ 必须真的敲字把它改脏：`changed` 事件走静默重载还是走裁决框，判据只有 `dirty()`
    typeText('改一下')
    await flush()
    expect(statusName()).toBe('● a.ts')
  }

  /** 模拟 Rust 侧推来的一条外部改动。走的是与搜索/替换同一个 `listen` 桩 */
  function fireChanged(path: string, kind: FileChangeKind = 'changed'): Promise<void> {
    return fireEvent(FILE_CHANGED_EVENT, { path, kind })
  }

  function labels(): string[] {
    return [...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')].map((b) => b.textContent ?? '')
  }

  it('启动就送一份空清单，之后每次标签变化都送全量', async () => {
    // 挂载那一刻一个文件都没开，但清单**照样要送**：`set_watched([])` 是「把监听整个关掉」，
    // 而不送的话上一次运行留下的订阅状态就没人负责（见 src/ipc/watch.ts 那条注释）
    expect(watchCmd.sent[0]).toEqual([])

    await twoTabs()
    expect(watchCmd.sent[watchCmd.sent.length - 1]).toEqual([README, A_TS])

    const count = watchCmd.sent.length
    typeText('再改一下')
    await flush()
    // 改脏不惊动 IPC：脏标记不是「该盯哪些文件」的一部分，而脏文件恰恰是最该被盯着的
    expect(watchCmd.sent).toHaveLength(count)
  })

  it('⚠️ 干净标签被外部改了：静默读回磁盘那一份，一个字都不问', async () => {
    await cleanTab()
    const opened = ipc.openFile.mock.calls.length

    disk[README] = '别人刚写进去的正文'
    await fireChanged(README)

    expect(ipc.openFile).toHaveBeenCalledTimes(opened + 1)
    // 这一条是整个 M2-G 存在的理由：干净文档没有需要保护的东西，弹个框只是打断用户
    expect(modal()).toBeNull()
    expect(view().state.doc.toString()).toBe('别人刚写进去的正文')
    expect(statusName()).toBe('README.md')
  })

  it('脏标签被外部改了：裁决框出现，而编辑器里的正文一动不动', async () => {
    await twoTabs()
    const before = view().state.doc.toString()

    disk[A_TS] = '别人刚写进去的代码'
    await fireChanged(A_TS)

    expect(modal()?.getAttribute('role')).toBe('alertdialog')
    expect(modal()?.getAttribute('aria-label')).toBe('「a.ts」在 Vela 之外被改过了')
    expect(labels()).toEqual(['用磁盘上的覆盖', '另存为…', '保留我的改动'])
    // 全路径单独一行：两个目录里的同名文件同时出事时，只报文件名认不出来
    expect([...container.querySelectorAll('.modal-body')].map((el) => el.textContent)).toContain(A_TS)
    // ⚠️ 在用户裁决之前一个字节都不许动——这一份稿子只存在于内存里
    expect(view().state.doc.toString()).toBe(before)
    expect(statusName()).toBe('● a.ts')
  })

  it('「用磁盘上的覆盖」：读回磁盘那一份，脏标记跟着没了', async () => {
    await twoTabs()
    disk[A_TS] = '磁盘上换过的那一份'
    await fireChanged(A_TS)

    modalButton('用磁盘上的覆盖').click()
    await flush()

    expect(modal()).toBeNull()
    expect(view().state.doc.toString()).toBe('磁盘上换过的那一份')
    expect(statusName()).toBe('a.ts')
  })

  it('「保留我的改动」：对话框消失，正文与脏标记都留着', async () => {
    await twoTabs()
    disk[A_TS] = '磁盘上换过的那一份'
    await fireChanged(A_TS)
    const before = view().state.doc.toString()

    modalButton('保留我的改动').click()
    await flush()

    expect(modal()).toBeNull()
    expect(view().state.doc.toString()).toBe(before)
    expect(statusName()).toBe('● a.ts')
  })

  it('文件被删了：干净标签也要问，而「关闭标签」直接把它摘掉', async () => {
    await cleanTab()

    await fireChanged(README, 'removed')

    // 干净 + 被删 = 编辑器里这一份是**仅存的副本**，静默重载只会把它读成空
    expect(modal()?.getAttribute('aria-label')).toBe('「README.md」在磁盘上已经没有了')
    expect(labels()).toEqual(['关闭标签', '另存为…', '保留标签'])

    modalButton('关闭标签').click()
    await flush()

    expect(modal()).toBeNull()
    // 干净标签走的是 closeTab 的快路径，一个字节都不写、也不再问一次
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(tabs()).toHaveLength(1)
    expect(statusName()).toBe('空文档')
  })

  it('监听不完整时那句话要让用户看见——「没订上」与「没出事」在界面上长得一样', async () => {
    watchCmd.stats = { dirs: 1, files: 1, failed: 1, skipped: 0, truncated: false }

    await cleanTab()

    // 用 `toContain` 而不是全等：`.notice` 里还有那个 `×` 关闭按钮的文本
    expect(notices().map((n) => n.level)).toContain('warning')
    expect(
      notices()
        .map((n) => n.text)
        .join(''),
    ).toContain('文件监听不完整：有 1 个目录没订上。这些文件被外部改动时 Vela 不会提醒。')
  })

  it('⚠️ 裁决框与关闭确认不同时在场：后者优先，答完才轮到下一个冲突', async () => {
    await twoTabs()
    // 两个都脏、都被删：于是「关闭标签」必然把 DiscardDialog 叫出来
    tabs()[0]!.click()
    await flush()
    typeText('README 也改一下')
    await flush()

    await fireChanged(README, 'removed')
    await fireChanged(A_TS, 'removed')
    expect(modal()?.getAttribute('aria-label')).toBe('「README.md」在磁盘上已经没有了')
    expect([...container.querySelectorAll('.modal-body')].map((el) => el.textContent)).toContain(
      '后面还有 1 个文件要问。',
    )

    modalButton('关闭标签').click()
    await flush()

    // 两层 .modal-backdrop 的 z-index 都是 10，谁在上面只取决于 DOM 顺序，
    // 被压在底下那个点不着——所以同一时刻只许有一层
    expect(container.querySelectorAll('.modal-backdrop')).toHaveLength(1)
    expect(modal()?.getAttribute('aria-label')).toBe('「README.md」有未保存的改动')

    modalButton('不保存').click()
    await flush()

    expect(container.querySelectorAll('.modal-backdrop')).toHaveLength(1)
    expect(modal()?.getAttribute('aria-label')).toBe('「a.ts」在磁盘上已经没有了')
    expect([...container.querySelectorAll('.modal-body')].map((el) => el.textContent)).not.toContain(
      '后面还有 1 个文件要问。',
    )
  })
})

describe('只读分片接线（M2-H）', () => {
  /**
   * 让「打开…」这条路撞一次 `too_large`，于是 `document.ts` 改走 `open_large`。
   *
   * ⚠️ 走的是**真实那条路**，而不是直接给 `shardCmd` 塞一个分片：这一组要验的正是
   * 「4 MiB 那条线之后前端会不会自己换条路」，而那半条判断在 `document.ts` 里
   */
  function hugeFile(path: string): void {
    dialog.open.mockResolvedValue(path)
    ipc.openFile.mockRejectedValue({ kind: 'too_large', bytes: shardCmd.header.bytes, limit: 4_194_304 })
  }

  function shardPane(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.shard-pane')
  }

  function shardRows(): string[] {
    return [...container.querySelectorAll('.shard-row .shard-text')].map((r) => (r.textContent ?? '').trim())
  }

  /** 打开那个大文件并等两趟：`open_large` 一趟，建好视图之后要第一页又一趟 */
  async function openHuge(path = '/var/log/huge.log'): Promise<void> {
    hugeFile(path)
    button('打开…').click()
    await flush()
    await flush()
  }

  it('打开一个超过 4 MiB 的文件：正文区换成只读分片，而且一个字都不抱怨', async () => {
    await openHuge()

    expect(shardCmd.opened).toEqual(['/var/log/huge.log'])
    // 🔴 没有提示条。`too_large` 在这里不是失败，是「换一条路」；说一句「文件太大」
    // 而屏幕上明明显示着内容，是自相矛盾
    expect(notices()).toEqual([])
    expect(shardPane()).not.toBeNull()
    // 🔴 那个 CM6 编辑器**没了**，不是被盖住。留着它的话 `ws.focusedEditor()` 照样
    // 返回那块编辑器，于是 Mod+F、Alt+Z、多光标——所有 `when: ctx.editor !== null`
    // 的命令全部照常可用，而它们改的是那份空 buffer
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(0)
    // 真的读了第一页：`createShardView` 建好就立刻要一页，不等组件量到 clientHeight
    expect(shardCmd.reads.length).toBeGreaterThan(0)
    expect(shardRows()[0]).toBe('第 1 行')
  })

  it('状态栏跟着换成一整排只读的格子', async () => {
    shardCmd.header = { ...shardCmd.header, encoding: 'gbk', bom: true, eol: 'crlf' }
    await openHuge()

    const cells = statusCells()
    expect(cells).toContain('只读分片')
    expect(cells).toContain('5,000 行')
    expect(cells).toContain('100.0 MB')
    expect(cells).toContain('GBK BOM')
    expect(cells).toContain('CRLF')
    // 🔴 编码与换行符那两格压根不渲染。这是「分片标签永远不会变脏」唯一的守卫：
    // 一旦脏了就再也关不掉（关闭确认要保存，而 `save` 在分片上一律拒绝）
    expect(container.querySelectorAll('.statusbar select')).toHaveLength(0)
    expect(cells.join(' ')).not.toContain('行 1，列 1')
  })

  it('🔴 分屏是**每块各判一次**：一块显示分片，另一块还是编辑器', async () => {
    await openHuge()
    expect(container.querySelectorAll('.shard-pane')).toHaveLength(1)

    button('右分屏').click()
    await flush()

    // 新那块分屏显示一个新的空标签，于是它必须是编辑器。写成「全局判断」
    // （`ws.tabs().some(t => t.doc.shard())`）或者把 Accessor 本身递给 `<Show when>`
    // （一个函数引用永远为真）都会让**两块**变成只读分片
    expect(container.querySelectorAll('.shard-pane')).toHaveLength(1)
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(1)

    // 点回第一块：分片还在，而它没有被卸载过一次（`dispose` 只在关标签时调）
    tabs()[0]!.click()
    await flush()
    expect(container.querySelectorAll('.shard-pane')).toHaveLength(1)
    expect(shardCmd.closed).toEqual([])
  })

  it('关掉分片标签把 fd 还回去：这是 Vela 里唯一一个不调就会漏的资源', async () => {
    await openHuge()
    expect(shardCmd.closed).toEqual([])

    button('右分屏').click()
    await flush()
    tabs()[0]!.querySelector<HTMLButtonElement>('.tab-close')!.click()
    await flush()

    expect(shardCmd.closed).toEqual([1])
    expect(shardPane()).toBeNull()
    // 🔴 这里必须是 2 而不是 1：关掉的是**标签**，不是分屏，两块分屏都还在。
    // 而空出来的那块不能没东西显示——`removeFromList` 挑不出一个「没在别的分屏里
    // 显示着的」标签（剩下那个已经被新分屏占了），于是补一个「空文档」进来。
    // 这条对分片和普通标签是同一条路，不是分片特有的例外
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(2)
    expect(tabs()).toHaveLength(2)
  })

  it('⛔ 分片路径不进监听清单，外部改动的事件也不处理', async () => {
    await openHuge()
    expect(watchCmd.sent[watchCmd.sent.length - 1]).toEqual([])

    // 清单里没有它，事件却到了（内联长成分片那一刻最容易撞上：摘订阅那次
    // `set_watched` 还在队列上）。不处理是刻意的：分片「重读一次」是整份文件重扫一遍
    await fireEvent(FILE_CHANGED_EVENT, { path: '/var/log/huge.log', kind: 'changed' satisfies FileChangeKind })
    await flush()

    expect(shardCmd.opened).toEqual(['/var/log/huge.log'])
    expect(shardCmd.closed).toEqual([])
    expect(modal()).toBeNull()
  })
})

describe('Markdown 预览接线（M3-A-3）', () => {
  /**
   * 预览那一栏的工具栏按钮。**只能按 title 认**：它的文本是「开」/「关」，
   * 而上面「换行」那一组的按钮文本逐字相同，`button('开')` 拿到的是文档序里先出现的那一个
   */
  function previewButton(): HTMLButtonElement {
    const el = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.title === 'Mod+Shift+V')
    if (!el) throw new Error('工具栏上找不到预览按钮')
    return el
  }

  function preview(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.md-preview')
  }

  function previewBody(): string {
    return container.querySelector('.md-preview-body')?.innerHTML ?? ''
  }

  /** 面板顶上那句话。null = 没什么要说的（`.md-preview-note` 是 `<Show>` 条件渲染的） */
  function previewNote(): string | null {
    return container.querySelector('.md-preview-note')?.textContent ?? null
  }

  function closePreview(): void {
    const el = container.querySelector<HTMLButtonElement>('.md-preview-close')
    if (!el) throw new Error('预览面板上没有那个 ×')
    el.click()
  }

  const toggle = () => press('v', { ...modInit(), shiftKey: true })

  /**
   * 等一个宏任务。
   *
   * ⚠️ 它比 `PANEL_DEBOUNCE_MS`（150ms）短两个数量级，所以「渲染出来了」这件事
   * 只可能来自 `debounced.now()` 那条**立刻**的路。等防抖的话下面那几条就退化成
   * 「过了 150ms 总归会渲染」，接线接错了也照样绿
   */
  const settle = () => flush()

  it('默认不渲染预览那一栏，按钮写的是「关」', () => {
    expect(preview()).toBeNull()
    expect(previewButton().textContent).toBe('关')
    // 侧边栏也默认收着，所以 `.body-row` 里此刻只有正文区一个孩子
    expect([...container.querySelector('.body-row')!.children].map((el) => el.className)).toEqual(['body'])
  })

  it('Mod+Shift+V 与工具栏按钮走同一条路，而 Mod+V 仍然是空的', async () => {
    toggle()
    await settle()
    expect(preview()).not.toBeNull()
    expect(previewButton().textContent).toBe('开')

    // 🔴 `Mod+V` 刻意不绑：它是系统粘贴，webview 之前就把那一下吃掉了，绑了也拦不到，
    // 而万一在某些输入法下拦到了，症状是「按 Cmd+V 粘贴，预览跟着关了」——用户看不见原因
    press('v', modInit())
    await settle()
    expect(preview()).not.toBeNull()

    toggle()
    await settle()
    expect(preview()).toBeNull()
    expect(previewButton().textContent).toBe('关')

    previewButton().click()
    await settle()
    expect(preview()).not.toBeNull()
  })

  it('那一栏挂在 .body-row 的最后（左边写、右边看），而 .app 的 grid 子元素仍然是五个', async () => {
    toggle()
    await settle()

    // `.body-row` 是横向 flex，孩子的顺序就是屏幕上的顺序：放在 `.body` 之后 = 在右边
    expect([...container.querySelector('.body-row')!.children].map((el) => el.className)).toEqual([
      'body',
      'md-preview',
    ])
    // ⚠️ 它必须住在 `.body-row` **里面**，而不是直接当 `.app` 的孩子：`.app` 的行数固定为五，
    // 多出来的东西一旦成了 grid item，那份 `1fr` 就会落到错误的行上（侧边栏那一组用例钉过同一件事）
    expect([...container.querySelector('.app')!.children].map((el) => el.className)).toEqual([
      'toolbar',
      'tab-strip',
      'notices',
      'main',
      'statusbar',
    ])
  })

  it('点头上的 × 收起那一栏，工具栏按钮跟着翻回「关」', async () => {
    toggle()
    await settle()

    closePreview()
    await settle()

    expect(preview()).toBeNull()
    expect(previewButton().textContent).toBe('关')
  })

  it('未命名文档按 Markdown 处理：空的说一句空状态，写了内容就渲染出带 data-line 的 HTML', async () => {
    toggle()
    await settle()
    expect(previewNote()).toBe('这份文档还是空的')
    expect(previewBody()).toBe('')
    closePreview()

    typeText('# 甲\n\n正文。')
    toggle()
    await settle()

    expect(previewNote()).toBeNull()
    expect(previewBody()).toBe('<h1 data-line="1" id="甲">甲</h1><p data-line="3">正文。</p>')
    // `data-line` 是同步滚动**唯一**的锚：掉一个，整份插值就失序（`md/scrollSync.ts` 文件头）
    expect(
      [...container.querySelectorAll('.md-preview-body [data-line]')].map((el) => el.getAttribute('data-line')),
    ).toEqual(['1', '3'])
  })

  it('非 Markdown 文档：面板照样开，里面如实说这个语言没有预览', async () => {
    dialog.open.mockResolvedValue('/a.ts')
    ipc.openFile.mockResolvedValue(textFile({ text: 'const x = 1' }))
    button('打开…').click()
    await settle()

    toggle()
    await settle()

    // 🔴 命令层刻意**不判语言**（理由写在 `builtins.ts` 的 `BuiltinHooks.togglePreview` 上）：
    // 挂一个 `when` 的话快捷键按下去什么也不发生，用户得到的信息是零。面板开出来写一句
    // 「TypeScript 还没有预览」，至少告诉了他「功能在，只是这个文件不行」
    expect(preview()).not.toBeNull()
    expect(previewNote()).toBe('TypeScript 还没有预览')
    expect(previewBody()).toBe('')
  })

  it('换标签立刻重渲染：正文换了，而那块 CM6 实例是同一个', async () => {
    typeText('# 甲\n')
    toggle()
    await settle()
    expect(previewBody()).toContain('甲')

    button('新建').click()
    await settle()
    expect(previewNote()).toBe('这份文档还是空的')
    expect(previewBody()).toBe('')

    tabs()[0]!.click()
    await settle()
    expect(previewNote()).toBeNull()
    expect(previewBody()).toContain('甲')
  })

  it('🔴 开着预览去分屏：新分屏的编辑器一挂上来预览就跟过去，不停在「没有可预览的正文」', async () => {
    typeText('# 甲\n')
    toggle()
    await settle()
    expect(previewBody()).toContain('甲')

    button('右分屏').click()
    await settle()

    expect(hosts()).toHaveLength(2)
    // 新分屏里是一个空文档，所以该说的是这一句
    expect(previewNote()).toBe('这份文档还是空的')
    // ⛔ 而**不是**这一句。走到它意味着 `previewSource()` 读到的是 null：新分屏的
    // `EditorController` 是在 `EditorPane` 的 `onMount` 里 `attach` 上来的，而那一下写的是
    // `PaneRecord` 上一个普通可变字段，不触发任何信号。所以 `previewSource` 必须走
    // `ws.focusedView()`（它额外读了 `attachedAt`）而不是 `ws.focusedEditor()`——
    // 写成后者的话预览会**一直停在**这句上，直到用户在编辑器里敲一个字
    // （`docChanged` → `revision` → effect 重跑），而「敲一个字就好了」正是最难报的 bug 形状
    expect(previewNote()).not.toBe('这块分屏里没有可预览的正文')
  })

  it('预览跟着聚焦的那块分屏走：焦点换过去它就换文档', async () => {
    typeInto(0, '# 甲\n')
    button('右分屏').click()
    await settle()
    typeInto(1, '# 乙\n')

    toggle()
    await settle()
    expect(previewBody()).toContain('乙')
    expect(previewBody()).not.toContain('甲')

    focusHost(0)
    await settle()
    expect(previewBody()).toContain('甲')
    expect(previewBody()).not.toContain('乙')
  })
})

describe('大纲接线（M3-A-4）', () => {
  /**
   * 大纲那一栏的工具栏按钮。**只能按 title 认**：它的文本是「开」/「关」，
   * 而上面「换行」与「预览」两组的按钮文本逐字相同，`button('开')` 拿到的是
   * 文档序里先出现的那一个
   */
  function outlineButton(): HTMLButtonElement {
    const el = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.title === 'Mod+Shift+M')
    if (!el) throw new Error('工具栏上找不到大纲按钮')
    return el
  }

  function outline(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.outline')
  }

  function outlineRows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('.outline-row')]
  }

  function outlineNames(): string[] {
    return outlineRows().map((el) => el.querySelector('.outline-name')?.textContent ?? '')
  }

  /** 面板顶上那句话。null = 没什么要说的（`.outline-note` 是 `<Show>` 条件渲染的） */
  function outlineNote(): string | null {
    return container.querySelector('.outline-note')?.textContent ?? null
  }

  /** 撑出总滚动高度的那一格。它只由 `rows()` 算，所以是「少掉的行压根没渲染」的证据 */
  function spacerHeight(): string {
    return outline()?.querySelector<HTMLElement>('.outline-spacer')?.style.height ?? ''
  }

  function closeOutline(): void {
    const el = container.querySelector<HTMLButtonElement>('.outline-close')
    if (!el) throw new Error('大纲面板上没有那个 ×')
    el.click()
  }

  /**
   * 点第 index 行的标题名（「跳过去」那一下）。
   *
   * ⚠️ 一行的两个按钮必须分开找：折叠箭头也是 `<button>`，而它在 DOM 里**排在前面**，
   * `querySelector('button')` 抓到的是它，于是用例会在一片绿里把「点箭头」当成「点标题」
   */
  function clickHeading(index: number): void {
    const el = outlineRows()[index]?.querySelector<HTMLButtonElement>('.outline-name')
    if (!el) throw new Error(`大纲里没有第 ${index} 行的标题`)
    el.click()
  }

  /** 点第 index 行的折叠箭头。没有子标题时那一位是个 `<span>`，所以这里只认 `<button>` */
  function foldAt(index: number): void {
    const el = outlineRows()[index]?.querySelector<HTMLButtonElement>('button.outline-twisty')
    if (!el) throw new Error(`第 ${index} 行没有可点的折叠箭头`)
    el.click()
  }

  const toggle = () => press('m', { ...modInit(), shiftKey: true })

  /**
   * 等一个宏任务。与预览那组用例同一条理由：它比 `PANEL_DEBOUNCE_MS`（150ms）
   * 短两个数量级，所以「列出来了」只可能来自 `debounced.now()` 那条**立刻**的路。
   * 等防抖的话下面几条就退化成「过了 150ms 总归会列出来」，接线接错了也照样绿
   */
  const settle = () => flush()

  it('默认不渲染大纲那一栏，按钮写的是「关」', () => {
    expect(outline()).toBeNull()
    expect(outlineButton().textContent).toBe('关')
    // 侧边栏与预览也默认收着，所以 `.body-row` 里此刻只有正文区一个孩子
    expect([...container.querySelector('.body-row')!.children].map((el) => el.className)).toEqual(['body'])
  })

  it('Mod+Shift+M 与工具栏按钮走同一条路，而 Mod+M 仍然是空的', async () => {
    toggle()
    await settle()
    expect(outline()).not.toBeNull()
    expect(outlineButton().textContent).toBe('开')

    // 🔴 `Mod+M` 刻意不绑，而它与 `Mod+V` **不是同一条理由**：`Mod+V` 是系统粘贴，
    // `Mod+M` 在 macOS 上是「最小化窗口」——两者都在事件到达 webview 之前就被吃掉了，
    // 绑在这儿永远收不到按键，而万一收到了，症状是「按 Cmd+M 最小化，大纲跟着关了」
    press('m', modInit())
    await settle()
    expect(outline()).not.toBeNull()

    toggle()
    await settle()
    expect(outline()).toBeNull()
    expect(outlineButton().textContent).toBe('关')

    outlineButton().click()
    await settle()
    expect(outline()).not.toBeNull()
  })

  it('那一栏挂在侧边栏之后、.body 之前，而 .app 的 grid 子元素仍然是五个', async () => {
    await openProject()
    toggle()
    press('v', { ...modInit(), shiftKey: true })
    await settle()

    // `.body-row` 是横向 flex，孩子的顺序就是屏幕上的顺序：左边是「导航」
    // （磁盘上有什么 → 这份文档的结构），中间是「写」，右边是「结果」。
    // 大纲放到右边去的话它会与预览抢同一半宽，而两个同时开着是常态
    expect([...container.querySelector('.body-row')!.children].map((el) => el.className)).toEqual([
      'sidebar',
      'outline',
      'body',
      'md-preview',
    ])
    // ⚠️ 它必须住在 `.body-row` **里面**，而不是直接当 `.app` 的孩子：`.app` 的行数固定为五，
    // 多出来的东西一旦成了 grid item，那份 `1fr` 就会落到错误的行上（侧边栏那组用例钉过同一件事）
    expect([...container.querySelector('.app')!.children].map((el) => el.className)).toEqual([
      'toolbar',
      'tab-strip',
      'notices',
      'main',
      'statusbar',
    ])
  })

  it('🔴 列出来的标题与 Mod+R 浮层里那一份逐字相同', async () => {
    typeText('# 一级标题\n\n正文一段\n\n## 二级标题\n')
    toggle()
    await settle()

    press('r', modInit())
    await settle()

    // 两个入口读的是 `symbolTable` 那**一份**结果，所以这里比的不是「两个解析器凑巧一致」，
    // 而是「谁要是给大纲另写一遍解析，这一条当场就红」。那种分歧没法向用户解释：
    // 浮层里看得见的标题、大纲里没有，而两边都没报错
    expect(paletteRowTexts()).toEqual(['一级标题', '二级标题'])
    expect(outlineNames()).toEqual(paletteRowTexts())
  })

  it('点一行标题：光标落到那个标题的起点，走的是与 Mod+R 同一条 gotoPos', async () => {
    // `# 甲\n\n## 乙\n` → 乙 的节点起点是 5（'#',' ','甲','\n','\n' 五个字符之后），
    // 而它**含 `##` 那两个井号**：`DocSymbol.pos` 是 `node.from`（`goto/symbols.ts:121`）
    typeText('# 甲\n\n## 乙\n')
    toggle()
    await settle()
    expect(outlineNames()).toEqual(['甲', '乙'])

    const nameBefore = statusName()
    clickHeading(1)
    await settle()

    expect(view().state.selection.main.head).toBe(5)
    expect(cursorLine()).toBe(3)
    // 跳过去**没有**动正文：大纲是只读的那一栏，点它不该再多出一个脏标记。
    // ⚠️ 比的是「点击前后同一格」而不是「干净」——这份未命名文档在 `typeText` 那一下
    // 就已经脏了（状态栏那一格前面挂着 `●`），只有拿它当基线，这一条才真的在说
    // 「点标题这一下没改文档」
    expect(view().state.doc.toString()).toBe('# 甲\n\n## 乙\n')
    expect(statusName()).toBe(nameBefore)
  })

  it('点折叠箭头收起一个子树：少掉的那几行是压根没渲染，不是被 CSS 藏起来', async () => {
    typeText('# 甲\n\n## 乙\n\n## 丙\n\n# 丁\n')
    toggle()
    await settle()
    expect(outlineNames()).toEqual(['甲', '乙', '丙', '丁'])
    expect(spacerHeight()).toBe(`${4 * OUTLINE_ROW_HEIGHT}px`)

    foldAt(0)
    await settle()

    expect(outlineNames()).toEqual(['甲', '丁'])
    // ⚠️ 判据是 spacer 的高度，不是行的可见性：虚拟列表里总高与 `translateY` 都由
    // `rows()` 算出来。用 `display:none` 藏行的话总高还是四行那么高，滚到底是一片空白
    expect(spacerHeight()).toBe(`${2 * OUTLINE_ROW_HEIGHT}px`)

    foldAt(0)
    await settle()
    expect(outlineNames()).toEqual(['甲', '乙', '丙', '丁'])
  })

  it('点头上的 × 收起那一栏，工具栏按钮跟着翻回「关」', async () => {
    toggle()
    await settle()

    closeOutline()
    await settle()

    expect(outline()).toBeNull()
    expect(outlineButton().textContent).toBe('关')
  })

  it('🔴 大纲与预览的可见性是独立的：关掉一个不该顺手关掉另一个', async () => {
    toggle()
    press('v', { ...modInit(), shiftKey: true })
    await settle()
    expect(outline()).not.toBeNull()
    expect(container.querySelector('.md-preview')).not.toBeNull()

    closeOutline()
    await settle()
    expect(outline()).toBeNull()
    // 两个开关各管一栏。顺手一起关的话「一边看结构一边看渲染」这个常态就不存在了，
    // 而用户找不到是哪一下把它们绑在一起的
    expect(container.querySelector('.md-preview')).not.toBeNull()
    expect(outlineButton().textContent).toBe('关')
  })

  it('未命名文档按 Markdown 处理：空的说一句空状态，写了标题就列出来', async () => {
    toggle()
    await settle()
    expect(outlineNote()).toBe('这份文档还没有标题')
    expect(outlineNames()).toEqual([])

    typeText('# 甲\n')
    await flush()
    // 敲字走的是防抖那条路，所以这里必须真的走完那 150ms（`panel.test.ts` 钉的是防抖本身）
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(outlineNote()).toBeNull()
    expect(outlineNames()).toEqual(['甲'])
  })

  it('非 Markdown 文档：面板照样开，里面如实说这个语言没有符号表', async () => {
    dialog.open.mockResolvedValue('/a.ts')
    ipc.openFile.mockResolvedValue(textFile({ text: 'const x = 1' }))
    button('打开…').click()
    await settle()

    toggle()
    await settle()

    // 🔴 命令层刻意**不判语言**（理由写在 `builtins.ts` 的 `BuiltinHooks.toggleOutline` 上），
    // 而这句措辞与 `Cmd+R` 浮层那一句**逐字相同**（`goto/store.ts:452`）：
    // 同一个事实两种说法的话，用户会以为浮层与面板答的是两个问题
    expect(outline()).not.toBeNull()
    expect(outlineNote()).toBe('TypeScript 还没有符号表')
    expect(outlineNames()).toEqual([])
  })

  it('换标签立刻重算：标题换了，而那块 CM6 实例是同一个', async () => {
    typeText('# 甲\n')
    toggle()
    await settle()
    expect(outlineNames()).toEqual(['甲'])

    button('新建').click()
    await settle()
    expect(outlineNote()).toBe('这份文档还没有标题')
    expect(outlineNames()).toEqual([])

    tabs()[0]!.click()
    await settle()
    expect(outlineNote()).toBeNull()
    expect(outlineNames()).toEqual(['甲'])
  })

  it('🔴 开着大纲去分屏：新分屏的编辑器一挂上来大纲就跟过去，不停在「没有可列的标题」', async () => {
    typeText('# 甲\n')
    toggle()
    await settle()
    expect(outlineNames()).toEqual(['甲'])

    button('右分屏').click()
    await settle()

    expect(hosts()).toHaveLength(2)
    // 新分屏里是一个空文档，所以该说的是这一句
    expect(outlineNote()).toBe('这份文档还没有标题')
    // ⛔ 而**不是**这一句。走到它意味着 `followedEditor()` 读到的是 null：新分屏的
    // `EditorController` 是在 `EditorPane` 的 `onMount` 里 `attach` 上来的，而那一下写的是
    // `PaneRecord` 上一个普通可变字段，不触发任何信号。所以那个访问器必须走
    // `ws.focusedView()`（它额外读了 `attachedAt`）而不是 `ws.focusedEditor()`——
    // 写成后者的话大纲会**一直停在**这句上，直到用户在编辑器里敲一个字
    expect(outlineNote()).not.toBe('这块分屏里没有可列的标题')
  })

  it('大纲跟着聚焦的那块分屏走：焦点换过去它就换文档', async () => {
    typeInto(0, '# 甲\n')
    button('右分屏').click()
    await settle()
    typeInto(1, '# 乙\n')

    toggle()
    await settle()
    expect(outlineNames()).toEqual(['乙'])

    focusHost(0)
    await settle()
    expect(outlineNames()).toEqual(['甲'])
  })
})

describe('表格对齐接线（M3-A-5）', () => {
  const align = () => press('a', { ...modInit(), shiftKey: true })
  const doc = () => view().state.doc.toString()
  /** 提示条那一个节点。`notices()` 的 `level` 分不出「无色」与 `ok`，所以要自己读 className */
  const noticeEl = () => container.querySelector('.notices .notice')

  /**
   * 往第 index 块分屏敲一份正文，并把光标摆在第 line 行（1 起）的行首。
   *
   * ⚠️ `typeText` 那一条把插入点留在**文档开头**（它不设 selection），而对齐认的是
   * 光标所在的那张表，所以敲完必须自己把光标摆进去
   */
  function typeTable(index: number, text: string, line = 2): void {
    pane(index).dispatch({ changes: { from: pane(index).state.doc.length, insert: text } })
    caretIn(index, line)
  }

  function pane(index: number): EditorView {
    const v = views()[index]
    if (!v) throw new Error(`没有第 ${index} 块分屏`)
    return v
  }

  /** 把第 index 块分屏的光标摆到第 line 行（1 起）的行首。纯选区变更，不进撤销栈、也不置脏 */
  function caretIn(index: number, line: number): void {
    pane(index).dispatch({ selection: { anchor: pane(index).state.doc.line(line).from } })
  }

  /**
   * 从「磁盘」打开一份 Markdown。
   *
   * ⚠️ 要验脏标记就必须走这条路：`typeTable` 那一下自己就把文档置脏了，
   * 于是「对齐之后是脏的」在一份草稿上永远为真，什么也证明不了。
   * 顺带一个好处——`setText` 走的是 `restore` → `view.setState`，撤销栈是空的，
   * 所以「再撤一步该没得撤了」这条断言数得准
   */
  async function openMd(text: string, path = '/notes/t.md'): Promise<void> {
    dialog.open.mockResolvedValue(path)
    ipc.openFile.mockResolvedValue(textFile({ text }))
    button('打开…').click()
    await flush()
  }

  /** 让「打开…」撞一次 `too_large`，于是正文区换成只读分片（与 M2-H 那组同一条路） */
  async function openShard(): Promise<void> {
    dialog.open.mockResolvedValue('/var/log/huge.log')
    ipc.openFile.mockRejectedValue({ kind: 'too_large', bytes: shardCmd.header.bytes, limit: 4_194_304 })
    button('打开…').click()
    await flush()
    await flush()
  }

  it('Mod+Shift+A 把一张歪表重排：改的是真文档，而且**只**动空白', async () => {
    typeTable(0, '| 名字 | 数量 |\n|---|---:|\n| 中文名字很长 | 12 |')
    align()
    await flush()

    const [head, delim, row] = doc().split('\n')
    // 🔴 按**显示宽度**对齐，不是按字符数：`名字` 是两个字符四格宽，所以要补 8 个空格
    // 才与 `中文名字很长`（六个字符十二格）齐。按字符数补的话这张表在等宽字体里还是歪的
    expect(head).toBe(`| 名字${' '.repeat(9)}| 数量 |`)
    expect(delim).toBe('| ------------ | ---: |')
    expect(row).toBe('| 中文名字很长 |   12 |')
    expect(noticeEl(), '对齐成功了就不该说话').toBeNull()
  })

  it('🔴 一次按键 = 一个撤销步，而它把文档标脏（跟着 ⌘S 落盘）', async () => {
    await openMd('| a | bb |\n|---|---|\n| ccc | d |')
    expect(statusName(), '刚从磁盘打开，是干净的').toBe('t.md')
    caretIn(0, 2)

    align()
    await flush()
    expect(doc()).toBe('| a   | bb  |\n| --- | --- |\n| ccc | d   |')
    expect(statusName(), '对齐是一次真的编辑，不是预览里的把戏').toBe('● t.md')

    // 撤**一步**就得整张表回去。撤出「半张表」意味着它按行发了好几个事务，
    // 那用户在真实文档上就得按 N 次 ⌘Z
    expect(undo(view())).toBe(true)
    expect(doc()).toBe('| a | bb |\n|---|---|\n| ccc | d |')
    // 再撤一步该没得撤了：对齐只占了**一部**，而不是每行一部
    expect(undo(view()), '对齐被拆成了好几部').toBe(false)
    // ⚠️ 徽章**不会**跟着撤销回到干净：脏标记只增不减，取舍写在 `doc/document.ts:201`
    expect(statusName()).toBe('● t.md')
  })

  it('光标不在表格里：说一句为什么，一个字都不改，× 能关掉', async () => {
    typeTable(0, '# 标题\n\n正文。', 1)
    align()
    await flush()

    expect(doc()).toBe('# 标题\n\n正文。')
    // 🔴 三句话里没有一件是出错、也没有一件是做成，所以是**无色**的 `.notice`：
    // 染成 `warning` 会让「按错了键」看起来像故障，染成 `ok` 会让它看起来像刚改了什么。
    // ⛔ 而命令本身刻意**不设 `when`**——设了的话这一下按下去什么也不发生，
    // 用户得到的信息是零（与 `togglePreview` 逐字相同的理由）
    expect(noticeEl()!.className).toBe('notice')
    expect(noticeEl()!.textContent).toContain('光标不在表格里')

    container.querySelector<HTMLButtonElement>('.notice-close')!.click()
    expect(notices()).toEqual([])
  })

  it('已经对齐的表：说「已经对齐了」，而徽章不变', async () => {
    const text = '| a   | bb  |\n| --- | --- |\n| ccc | d   |'
    await openMd(text)
    caretIn(0, 2)

    align()
    await flush()

    expect(doc()).toBe(text)
    expect(noticeEl()!.textContent).toContain('这张表已经对齐了')
    expect(statusName(), '一个字节都没改却置了脏，⌘S 就会白写一次盘').toBe('t.md')
  })

  it('分屏时只改**聚焦**那一块，另一块一个字节不动', async () => {
    typeTable(0, '| a | bb |\n|---|---|\n| ccc | d |')
    button('右分屏').click()
    await flush()
    typeTable(1, '| x | y |\n|---|---|\n| 1 | 2 |')

    focusHost(0)
    await flush()
    align()
    await flush()

    expect(views()[0]!.state.doc.toString()).toBe('| a   | bb  |\n| --- | --- |\n| ccc | d   |')
    expect(views()[1]!.state.doc.toString(), '没聚焦的那块被顺手改了').toBe('| x | y |\n|---|---|\n| 1 | 2 |')
  })

  it('聚焦的是一块只读分片时，说的是「这块分屏」，而且不抛错', async () => {
    await openShard()
    // 那块分屏里压根没有 CM6 实例，所以 `ws.focusedEditor()` 是 null。
    // 而这条命令**没有 `when`**（见上面那条 🔴），于是它必须自己把这句话说出来
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(0)
    align()
    await flush()

    expect(noticeEl()!.textContent).toContain('这块分屏里没有可对齐的表格')
    // ⛔ 不是「没有文档」：标签条上明明有一个，说没有会让用户去查自己是不是关错了
    expect(noticeEl()!.textContent).not.toContain('没有文档')
  })

  // ⚠️ 「`Mod+Shift+A` 与 `Alt+Shift+A` 是两条命令、同一个物理键不互相吃」钉在
  // `commands/builtins.test.ts` 里（那边有一个忠实还原 macOS 的 `macOptionEvent`：
  // Option 按下时 `key` 会变成 `Å`，注册表只能靠 `code` 认）。这里不重复——
  // 在 window 上手搓一个 altKey 事件，测的是我搓得像不像，不是接线对不对
})

describe('字数统计与导出 HTML 接线（M3-A-6）', () => {
  const count = () => press('c', { ...modInit(), shiftKey: true })
  const doExport = () => press('e', { ...modInit(), shiftKey: true })
  /** 提示条那一个节点。`notices()` 的 `level` 分不出「无色」与 `ok`，所以要自己读 className */
  const noticeEl = () => container.querySelector('.notices .notice')
  const noticeText = () => noticeEl()?.textContent ?? ''

  /**
   * 从「磁盘」打开一份文档。
   *
   * ⚠️ 导出那几条必须走这条路而不是 `typeText`：`previewHtml` 认语言靠的是
   * `doc.path()`，而草稿的 path 是 null——null 一律当 Markdown（见 `editor/language.ts`），
   * 于是「`.ts` 不能导出」那一支在草稿上永远走不到
   */
  async function openFrom(text: string, path: string): Promise<void> {
    dialog.open.mockResolvedValue(path)
    ipc.openFile.mockResolvedValue(textFile({ text }))
    button('打开…').click()
    await flush()
  }

  /** 让「打开…」撞一次 `too_large`，正文区换成只读分片（与 M2-H / M3-A-5 那两组同一条路） */
  async function openShard(): Promise<void> {
    dialog.open.mockResolvedValue('/var/log/huge.log')
    ipc.openFile.mockRejectedValue({ kind: 'too_large', bytes: shardCmd.header.bytes, limit: 4_194_304 })
    button('打开…').click()
    await flush()
    await flush()
  }

  /** 写进 `saveFile` 的那份 HTML。没有就说明压根没写盘 */
  function savedHtml(): string {
    const call = ipc.saveFile.mock.calls.at(-1)
    if (!call) throw new Error('没有调用过 saveFile')
    return call[1]
  }

  it('Mod+Shift+C 报出真文档的字数，而它是**无色**的一条', () => {
    typeText('你好世界')
    count()

    // 🔴 `plain` 而不是 `ok`：数一遍什么也没改，绿色会让人以为刚才那一下写了什么。
    // 与 M3-A-5「光标不在表格里」同一条纪律
    expect(noticeEl()!.className).toBe('notice')
    // 中文逐字符：4 个字符就是 4 字，而 300 字/分钟 → 1 分钟
    expect(noticeText()).toContain('4 字 · 约 1 分钟读完')
    // 纯中文时不列「西文 0 词」那种没信息量的括注
    expect(noticeText()).not.toContain('西文')
  })

  it('🔴 中英混排时两边各按各的口径数，并说出来', () => {
    typeText('Vela 是一个编辑器')
    count()

    // `Vela` 是 1 个西文词（不是 4 个字），「是一个编辑器」是 6 个中文字
    expect(noticeText()).toContain('7 字（中文 6 · 西文 1 词）')
  })

  it('空文档如实说「没有可数的字」，而不是报一个 0', () => {
    count()
    expect(noticeText()).toContain('这份文档里没有可数的字')
  })

  it('🔴 字数**不进状态栏**', () => {
    typeText('你好世界')
    count()

    // 这条钉的是一个设计决定而不是一个 bug：`syncMetrics` 在每一个事务上跑
    // （包括只动了光标的），而字数是一次全文扫描。塞进状态栏等于每敲一个键就重扫一遍；
    // 防抖能压住频率，压不住「那个数字会自己跳一下」。完整论证在 `src/doc/stats.ts` 文件头
    expect(statusCells().join(' | ')).not.toContain('读完')
    expect(statusCells().join(' | ')).not.toContain('字（')
  })

  it('切标签后这句话消失——它说的永远是「此刻这一块」', () => {
    typeText('你好世界')
    count()
    expect(noticeEl()).not.toBeNull()

    // 🔴 不跟着标签走。让它留着的话屏幕上挂着的是**另一个文档**的字数——
    // 一个自信地错着的数字，比空着更糟（`App.tsx` 里那条 `createEffect(on(…))` 就是为它写的）
    press('n', modInit())
    expect(noticeEl()).toBeNull()
  })

  it('聚焦的是一块只读分片时，说的是「这块分屏」，而且不抛错', async () => {
    await openShard()
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(0)

    count()
    expect(noticeText()).toContain('这块分屏里没有可统计的正文')
    // ⛔ 不是「没有文档」：标签条上明明有一个
    expect(noticeText()).not.toContain('没有文档')
  })

  it('Mod+Shift+E 把一份 Markdown 写成单文件 HTML，默认名剥掉 .md', async () => {
    await openFrom('# 标题\n\n正文一句话。\n', '/notes/t.md')
    dialog.save.mockResolvedValue('/out/t.html')

    doExport()
    await flush()
    await flush()

    expect(dialog.save).toHaveBeenCalledWith({
      defaultPath: 't.html',
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    })
    // 🔴 写盘走的是**已有的** `save_file`，没有为导出新增一个 Tauri 命令；
    // 而那份落盘格式是写死的（utf8 / 无 BOM / LF），⛔ 不继承源文件的编码——
    // 源文件是 GBK 的话，导出件继承过来会让浏览器按 `<meta charset="utf-8">` 读出一堆乱码
    expect(ipc.saveFile).toHaveBeenCalledWith('/out/t.html', expect.stringContaining('<h1'), {
      encoding: 'utf8',
      bom: false,
      eol: 'lf',
    })
    expect(savedHtml()).toContain('<!DOCTYPE html>')
    expect(savedHtml()).toContain('<title>t.md</title>')
    // 🔴 正文那一段来自 `md/render.ts`，所以它的白名单与转义**原样**是导出件的安全边界
    expect(savedHtml()).toContain('正文一句话。')
    // `ok` 而不是无色：这一次**真的写了一个文件**，与上面那几句「没什么可做」不是一类事
    expect(noticeEl()!.className).toBe('notice ok')
    expect(noticeText()).toContain('已导出到 /out/t.html')
  })

  it('🔴 源文档里的裸 HTML 到了导出件里也只是文字', async () => {
    await openFrom('# 标题\n\n<script>alert(document.cookie)</script>\n', '/notes/evil.md')
    dialog.save.mockResolvedValue('/out/evil.html')

    doExport()
    await flush()
    await flush()

    // 导出件是在**浏览器**里打开的，不是在 Vela 的 webview 里——一份带脚本的 HTML
    // 被用户邮件发给别人，那就是一个可执行文件。这条断言钉的是「导出没有把预览的
    // 安全边界放宽」，跨模块的那一半在 `md/export.test.ts`
    expect(savedHtml()).not.toContain('<script')
    expect(savedHtml()).toContain('&lt;script&gt;')
    // ⚠️ 不能写成 `<pre class="md-raw">`：`render.ts` 在同一个标签上还带了一个
    // `data-line`，属性顺序与个数都不是这里该钉的东西，钉「裸 HTML 被降级成了一个
    // `<pre>`」这件事就够了
    expect(savedHtml()).toContain('<pre class="md-raw"')
  })

  it('对话框取消：一个字节都不写，也一句话都不说', async () => {
    await openFrom('# 标题\n', '/notes/t.md')
    dialog.save.mockResolvedValue(null)

    doExport()
    await flush()
    await flush()

    expect(dialog.save).toHaveBeenCalledOnce()
    expect(ipc.saveFile).not.toHaveBeenCalled()
    // 用户自己按了取消，那不是错误也不是成就，说什么都是噪音
    expect(noticeEl()).toBeNull()
  })

  it('未命名草稿也能导出，默认名叫「空文档.html」', async () => {
    typeText('# 随手记\n')
    dialog.save.mockResolvedValue('/out/x.html')

    doExport()
    await flush()
    await flush()

    expect(dialog.save).toHaveBeenCalledWith({
      defaultPath: '空文档.html',
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    })
    expect(savedHtml()).toContain('<title>空文档</title>')
  })

  it('不是 Markdown 时拒绝，并把那个语言名说出来', async () => {
    await openFrom('第一行\n', '/notes/a.txt')

    doExport()
    await flush()

    // 措辞与预览面板那句「X 还没有预览」同一个模子：如实说「这个语言没有」，
    // 而不是让用户去猜快捷键是不是坏了
    expect(noticeText()).toContain('不能导出 HTML，只有 Markdown 有预览')
    expect(noticeText()).toContain('纯文本')
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(dialog.save, '拒绝了就不该弹对话框').not.toHaveBeenCalled()
  })

  it('文档是空的时拒绝，不去写一个只有样式的空壳', async () => {
    doExport()
    await flush()

    expect(noticeText()).toContain('这份文档还是空的，没有什么可导出的')
    expect(dialog.save).not.toHaveBeenCalled()
  })

  it('写盘失败时是 **error** 级，而原因复用 describeFsError', async () => {
    await openFrom('# 标题\n', '/notes/t.md')
    dialog.save.mockResolvedValue('/out/t.html')
    ipc.saveFile.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '没权限' })

    doExport()
    await flush()
    await flush()

    // 🔴 红色是必要的：写盘失败与「光标不在表格里」用同一个灰色的话，
    // 用户会以为那只是一句提示，然后照着一个**不存在**的路径去找文件
    expect(noticeEl()!.className).toBe('notice error')
    expect(noticeText()).toContain('导出失败：')
    expect(noticeText()).toContain('PermissionDenied')
  })

  it('聚焦的是一块只读分片时拒绝导出', async () => {
    await openShard()

    doExport()
    await flush()

    expect(noticeText()).toContain('这块分屏里没有可导出的正文')
    expect(dialog.save).not.toHaveBeenCalled()
  })

  // ⚠️ 「解析超时（`partial`）时拒绝导出」那一支在这儿**测不到**：jsdom 里
  // `ensureSyntaxTree` 总是同步解析完，200ms 那个预算碰不到。它由 `md/preview.ts`
  // 自己的用例钉住（那边能造出超时），这里不假装覆盖了
})

describe('图片粘贴落地接线（M3-A-7）', () => {
  /** 提示条那一个节点。`notices()` 的 `level` 分不出「无色」与 `ok`，所以要自己读 className */
  const noticeEl = () => container.querySelector('.notices .notice')
  const noticeText = () => noticeEl()?.textContent ?? ''

  /**
   * 从「磁盘」打开一份文档到**聚焦的那块分屏**。
   *
   * ⚠️ 必须走这条路而不是 `typeText`：接不接图片认的是 `doc.path()`，而草稿的 path
   * 是 null——null 一律当 Markdown（见 `editor/language.ts`），于是「`.ts` 不接」
   * 那一支在草稿上永远走不到
   */
  async function openFrom(text: string, path: string): Promise<void> {
    dialog.open.mockResolvedValue(path)
    ipc.openFile.mockResolvedValue(textFile({ text }))
    button('打开…').click()
    await flush()
  }

  /** 把光标挪到正文末尾，好让「插在光标处」这件事有一个可断言的落点 */
  function toEnd(index = 0): void {
    const v = views()[index]
    if (!v) throw new Error(`没有第 ${index} 块分屏`)
    v.dispatch({ selection: { anchor: v.state.doc.length } })
  }

  function shot(name = 'shot.png'): File {
    return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
  }

  /**
   * 往指定那块分屏派发一个**真的** paste 事件。
   *
   * ⚠️ 不是 `ClipboardEvent`：jsdom 的构造器不接受 `clipboardData`（那一项被忽略），
   * 而 CM6 只读这一个属性、不检查事件的具体类型（同一条做法在 `src/editor/paste.test.ts`）。
   * 派发在 `contentDOM` 上，于是走的是 CM6 自己的事件分发链，
   * 连带验住「插件的处理器排在内置处理器之前」那半个前提
   */
  function paste(data: { files?: File[]; text?: string }, index = 0): void {
    const v = views()[index]
    if (!v) throw new Error(`没有第 ${index} 块分屏`)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (format: string) => (format === 'text/plain' ? (data.text ?? '') : ''),
        files: data.files ?? [],
        items: [],
      },
    })
    v.contentDOM.dispatchEvent(event)
  }

  it('Markdown 文档里粘一张图：落盘、插一行相对链接、一句话都不说', async () => {
    await openFrom('# 标题\n', '/repo/README.md')
    toEnd()

    paste({ files: [shot()] })
    await flush()
    await flush()

    expect(assetCmd.calls.map((c) => c.docPath)).toEqual(['/repo/README.md'])
    // 🔴 参数名在这儿被真的读了一遍：`dataBase64` 漂了的话 Rust 那侧一个字节都收不到，
    // 而这一格会是空串
    expect(assetCmd.calls[0]?.dataBase64).toBe('iVBORw==')
    expect(view().state.doc.toString()).toBe('# 标题\n![](assets/pasted-ad48c1765eb1b87d.png)')
    // 成功是**静默**的：插进去的那一行就是全部的反馈，与 M3-A-5「对齐成功了就不该说话」同一条口径
    expect(notices()).toEqual([])
    // 正文里多了一行，那份文档就得显示成脏的——它必须跟着 ⌘S 落盘
    expect(statusName()).toBe('● README.md')
  })

  it('🔴 分屏之下跟着**收到事件的那块**走，不是跟着焦点走', async () => {
    await openFrom('let a = 1', '/repo/src/a.ts')
    button('右分屏').click()
    await flush()
    await openFrom('# 笔记\n', '/repo/docs/intro.md')
    // 焦点留在第 0 块（一个 `.ts`）：要是接线读的是 `activeTab()`，这次粘贴会被判成
    // 「不是 Markdown」而整个拒绝，图片一张都落不了地
    focusHost(0)

    toEnd(1)
    paste({ files: [shot()] }, 1)
    await flush()
    await flush()

    expect(assetCmd.calls.map((c) => c.docPath)).toEqual(['/repo/docs/intro.md'])
    expect(views()[1]!.state.doc.toString()).toBe('# 笔记\n![](assets/pasted-ad48c1765eb1b87d.png)')
    expect(views()[0]!.state.doc.toString()).toBe('let a = 1')
  })

  it('不是 Markdown 的文档不接：不发命令、正文不动，但要说清为什么', async () => {
    await openFrom('let a = 1', '/repo/src/a.ts')
    toEnd()

    paste({ files: [shot()] })
    await flush()

    expect(assetCmd.calls).toEqual([])
    expect(view().state.doc.toString()).toBe('let a = 1')
    // `plain`：往 `.rs` 里粘截图不是故障，也不是我们没做成——是这件事本来就不该做。
    // ⚠️ 但它**必须说出口**：CM6 的默认粘贴不认文件，不说的话这就是一次彻底的静默
    expect(noticeEl()!.className).toBe('notice')
    expect(noticeText()).toContain('这份文档不是 Markdown')
  })

  it('未命名草稿不接，并说清下一步是 ⌘S', async () => {
    typeText('# 草稿')
    toEnd()

    paste({ files: [shot()] })
    await flush()

    expect(assetCmd.calls).toEqual([])
    expect(noticeEl()!.className).toBe('notice')
    expect(noticeText()).toContain('先存一次（⌘S）')
    // 正文一个字都没动：链接不能指向一个还不存在的 assets/
    expect(view().state.doc.toString()).toBe('# 草稿')
  })

  it('剪贴板里有正文时不接图，正文照常粘进来', async () => {
    await openFrom('# 标题\n', '/repo/README.md')
    toEnd()

    paste({ text: '一段话', files: [shot()] })
    await flush()

    // 🔴 从网页复制一段带插图的文字，用户要的是文字。接了图就等于把他的复制
    // 凭空吞掉一半，而且没有任何提示
    expect(assetCmd.calls).toEqual([])
    expect(view().state.doc.toString()).toBe('# 标题\n一段话')
  })

  it('后端拒收时那句话落到提示条上，而且是 **error** 级', async () => {
    await openFrom('# 标题\n', '/repo/README.md')
    assetCmd.error = { kind: 'unsupported', reason: 'SVG 是 XML，能带脚本，不收' }
    toEnd()

    paste({ files: [new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })] })
    await flush()
    await flush()

    // 🔴 红色是必要的：这一支是「用户什么都做对了，而我们没做成」，
    // 与「先存一次」那种无色的提示不是一类事
    expect(noticeEl()!.className).toBe('notice error')
    expect(noticeText()).toContain('SVG 是 XML')
    expect(view().state.doc.toString()).toBe('# 标题\n')
  })

  it('图片超过上限时连读都不读', async () => {
    await openFrom('# 标题\n', '/repo/README.md')
    // ⚠️ 只造一个「自称很大」的 File：真的去分配 32MB 以上没有任何额外信息量，
    // 而 `file.size` 是这条判断唯一读的东西。`type` 必须有——挑文件那一步先认 MIME，
    // 少了它这次粘贴会在 jsdom 的事件派发里静默抛掉（jsdom 把监听器的异常转给
    // 虚拟控制台，不往外抛），用例看到的只是「什么都没发生」
    const arrayBuffer = vi.fn()
    const huge = { size: 40 * 1024 * 1024, type: 'image/png', arrayBuffer } as unknown as File
    toEnd()

    paste({ files: [huge] })
    await flush()

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(assetCmd.calls).toEqual([])
    expect(noticeEl()!.className).toBe('notice')
    expect(noticeText()).toContain('40.0 MB')
    expect(noticeText()).toContain('超过上限 32 MB')
  })
})

/**
 * 工具箱与命令面板的接线（M3-B-1e，M3-B-3 又加了两条，M3-B-4 再加一条）。
 *
 * 这一组钉的是**接线本身**，两块浮层内部的行为各有自己的组件测试
 * （`tools/ToolBox.test.tsx`、`commands/CommandPalette.test.tsx`）。
 * 于是在 App 这一层只问七件事：
 * 1. 两个快捷键各自开对了浮层；
 * 2. 🔴 **第一条内置工具真的接上了**，而且在浮层里跑得出来（`BUILTIN_TOOLS` 递没递进去、
 *    `host.readEditor` 接的是不是聚焦那块分屏，都只有这一层看得见）；
 * 3. 🔴 换到第二条工具、动一格选项，重跑用的是新的那一份——左栏点得到、选项条改得动、
 *    输入格与输出格跟着动，这三半只有在真浮层里连起来走一遍才算接上了；
 * 4. 🔴 **纯生成器（`input: 'none'`）那一类也接上了**，而且它的输出格在打开那一刻就有东西——
 *    这一类不吃输入，所以 `prefill` 那条路走不到，工作区只剩输出格与「重新生成」，
 *    少接一步的症状是「点开之后一片空」，那与「输出会出现在这里」是两种不同的空；
 * 5. 🔴 命令面板里**看得见内置命令**——面板是在组件体里建的，而内置命令是在 `onMount`
 *    里注册的，Solid 的 `createMemo` 又是急切求值的，所以少了 `palette.ts` 里那一格
 *    `generation`，这里会是一份永远只有工具的空清单（那个 bug 是量出来的，不是推出来的）；
 * 6. 面板里挑「工具箱…」能把工具箱打开——两扇门通向同一个地方；
 * 7. 置灰状态读的是**聚焦的那块分屏**，也就是 `App.tsx` 里那条挂了三个里程碑的 TODO 的验收。
 */
describe('工具箱与命令面板接线（M3-B-1 / M3-B-2 / M3-B-3 / M3-B-4 / M3-B-5 / M3-B-6）', () => {
  /** 工具箱那块大浮层。⚠️ 与上面 M2-E 那个 `palette()`（跳转浮层）不是一回事 */
  function toolboxEl(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.toolbox-backdrop')
  }

  /** 命令面板本体。⛔ 不能查 `.palette-backdrop`：跳转浮层用的也是那个类名 */
  function commandPaletteEl(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.palette.wide')
  }

  /**
   * 面板里的命令行。
   *
   * ⛔ 不能用上面 M2-E 那个 `paletteRows()`：它查的是 `.palette-row`，
   * 而命令面板每一行的类名是 `.palette-row command`——那个函数会把这边的行一起捞进去
   */
  function commandRows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('.palette-row.command')]
  }

  /** 每一行的 `title` 就是命令 id（`CommandPalette.tsx` 上那句注释解释了为什么要给） */
  function commandRowIds(): string[] {
    return commandRows().map((el) => el.getAttribute('title') ?? '')
  }

  function commandInput(): HTMLInputElement {
    const el = commandPaletteEl()?.querySelector<HTMLInputElement>('.palette-input')
    if (!el) throw new Error('命令面板里没有输入框')
    return el
  }

  function typeCommand(text: string): void {
    const el = commandInput()
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function pressInCommandPalette(key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    commandInput().dispatchEvent(event)
    return event
  }

  /** 在浮层本体上按一个键。bubbles 是必需的：Solid 把 keydown 委托在 document 上 */
  function pressInToolbox(key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    toolboxEl()!.dispatchEvent(event)
    return event
  }

  const shiftMod = (): KeyboardEventInit => ({ ...modInit(), shiftKey: true })

  it('一开始两块浮层都不在', () => {
    expect(toolboxEl()).toBeNull()
    expect(commandPaletteEl()).toBeNull()
  })

  it('Mod+Shift+T 打开工具箱，已经落地的六个工具都接上了', async () => {
    expect(press('t', shiftMod()).defaultPrevented).toBe(true)
    // 🔴 `ToolBox` 走 Solid 的 `lazy()`（M3-C-2），第一次触发要等一个微任务才渲染进 `Suspense`。
    // 顶层预热焐热的是**模块**、不是 `lazy` 自己那份 memo，所以必须 `await flush()`，
    // ⛔ 不能靠「前面的用例先开过一次」——那样单独跑这一条（`-t`）就会红
    await flush()
    expect(toolboxEl()).not.toBeNull()
    expect(commandPaletteEl()).toBeNull()
    expect(toolboxEl()?.querySelector('.toolbox-filter')).not.toBeNull()

    // 🔴 这几行是 M3-B-2 / M3-B-3 / M3-B-4 / M3-B-5 / M3-B-6 的验收：`BUILTIN_TOOLS` 不再是空的，
    // 于是「打开工具箱」之后用户看到的是一块能干活的浮层，而不是「工具箱还是空的」。
    // ⚠️ 顺序跟着 `CATEGORY_ORDER`（format → encode → generate → convert → test → text），⛔ 不是跟着数组顺序
    const rows = [...(toolboxEl()?.querySelectorAll('.toolbox-row') ?? [])]
    expect(rows.map((el) => el.getAttribute('title'))).toEqual([
      'JSON 格式化 / 压缩',
      'Base64 / URL 编解码',
      'UUID 生成（v4）',
      '时间戳互转',
      '正则测试器',
      '命名风格转换',
    ])
    expect([...(toolboxEl()?.querySelectorAll('.toolbox-group') ?? [])].map((el) => el.textContent)).toEqual([
      '格式化',
      '编解码',
      '生成器',
      '转换',
      '测试器',
      '文本',
    ])
    // 而工作区跟着选中了第一个——左栏点得到与工作区能跑是同一件事的两半
    expect(toolboxEl()?.querySelector('.toolbox-current')?.textContent).toBe('JSON 格式化 / 压缩')
  })

  it('🔴 切到纯生成器：没有输入格，而输出格在打开那一刻就有一个 UUID', async () => {
    // `input: 'none'` 这一类走的是与上面两条**完全不同**的一支：`store.ts` 的 `prefill`
    // 只给 `input: 'editor'` 的工具预填，而这一类连输入格都不画（`runNow` 里硬写了 `''`）。
    // ⚠️ 于是这里能看见的错只有一种：**打开之后输出格是空的**。那与 `OUTPUT_PLACEHOLDER`
    // 不一样——占位符说的是「还没东西可跑」，而生成器从来不需要用户先给东西
    press('t', shiftMod())
    await flush()
    const rows = [...toolboxEl()!.querySelectorAll<HTMLElement>('.toolbox-row')]
    rows[2]!.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(toolboxEl()!.querySelector('.toolbox-current')?.textContent).toBe('UUID 生成（v4）')

    expect(toolboxEl()!.querySelector('.toolbox-text.input')).toBeNull()
    const output = toolboxEl()!.querySelector<HTMLTextAreaElement>('.toolbox-text.output')?.value ?? ''
    expect(output).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    // 而「从编辑器取」与「跳到出错处」两个按钮都不该出现——它们对生成器没有意义，
    // 出现的话就是两个按下去什么都不发生的控件（`ToolBox.test.tsx` 里钉过互斥，这里是 App 层）
    const actions = [...toolboxEl()!.querySelectorAll<HTMLButtonElement>('.toolbox-actions button')].map(
      (el) => el.textContent,
    )
    expect(actions).toEqual(['重新生成', '复制结果', '插回编辑器'])
  })

  it('在工具箱里真跑一次：「从编辑器取」→ 输出格里是格式化好的 JSON', async () => {
    // 端到端的一条：命令 → 浮层 → 工具 → 编辑器。上面那几条只证明「画出来了」，
    // 这一条证明**接进去的 `run` 真的是 `builtin.ts` 里那一个**，
    // 而 `host.readEditor` 接的真的是聚焦那块分屏（`input: 'text'` 的工具不自动预填，
    // 所以必须走那一个按钮——见 `store.ts` 的 `prefill`）
    typeText('{"b":1,"a":2}')
    press('t', shiftMod())
    await flush()

    const take = [...toolboxEl()!.querySelectorAll<HTMLButtonElement>('.toolbox-actions button')].find(
      (el) => el.textContent === '从编辑器取',
    )
    take!.click()
    // ⚠️ 那一次运行是**防抖**的（`TOOL_DEBOUNCE_MS` 150ms），所以要等真的过去
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(toolboxEl()!.querySelector<HTMLTextAreaElement>('.toolbox-text.input')?.value).toBe('{"b":1,"a":2}')
    expect(toolboxEl()!.querySelector<HTMLTextAreaElement>('.toolbox-text.output')?.value).toBe(
      '{\n  "b": 1,\n  "a": 2\n}',
    )
  })

  it('在工具箱里切到第二个工具、改一格选项：中文 → base64 → 再解回来', async () => {
    // 🔴 这一条钉的是**选项条**那条线：换工具之后工作区画的是新工具的那一格下拉，
    // 而改了它之后重跑用的是新值。上面那两条只走缺省选项，所以少接一步
    // （比如 `commitText` 没调 `setOption`，或者 `setOption` 没 `scheduleRun`）只有这里能看见
    typeText('中文')
    press('t', shiftMod())
    await flush()
    const rows = [...toolboxEl()!.querySelectorAll<HTMLElement>('.toolbox-row')]
    rows[1]!.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(toolboxEl()!.querySelector('.toolbox-current')?.textContent).toBe('Base64 / URL 编解码')

    const take = [...toolboxEl()!.querySelectorAll<HTMLButtonElement>('.toolbox-actions button')].find(
      (el) => el.textContent === '从编辑器取',
    )
    take!.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
    // 缺省那一格是「Base64 编码」，于是打开工具就能直接粘东西进去
    expect(toolboxEl()!.querySelector<HTMLTextAreaElement>('.toolbox-text.input')?.value).toBe('中文')
    expect(toolboxEl()!.querySelector<HTMLTextAreaElement>('.toolbox-text.output')?.value).toBe('5Lit5paH')

    // ⚠️ Solid 的 `onChange` 对应的是原生 `change`，不是 `input`
    const select = toolboxEl()!.querySelector<HTMLSelectElement>('.toolbox-options select')!
    expect(select.value).toBe('Base64 编码')
    select.value = 'Base64 解码'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    // 🔴 换了模式**立刻拿现在输入格里的那一份重跑**，⛔ 不是把上一次的输出接回来当输入。
    // 于是「中文」被当 base64 去解，报错指到了那个汉字上——这一句钉住的正是这个口径：
    // 悄悄把输出喂回输入的话，用户看到的是「中文」，而他并不知道输入格已经换过了
    expect(toolboxEl()!.querySelector<HTMLTextAreaElement>('.toolbox-text.output')?.value).toBe(
      '第 1 行第 1 列：Base64 的字母表里没有这个字符（U+4E2D）\n  中文\n  ^',
    )

    // 输入格换成刚才编出来的那一串，再跑一次：这一格走的是 `setInput`，上面走的是 `setOption`
    const input = toolboxEl()!.querySelector<HTMLTextAreaElement>('.toolbox-text.input')!
    input.value = '5Lit5paH'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(toolboxEl()!.querySelector<HTMLTextAreaElement>('.toolbox-text.output')?.value).toBe('中文')
  })

  it('Esc 收起工具箱', async () => {
    press('t', shiftMod())
    await flush()
    expect(toolboxEl()).not.toBeNull()
    expect(pressInToolbox('Escape').defaultPrevented).toBe(true)
    expect(toolboxEl()).toBeNull()
  })

  it('🔴 Mod+Shift+P 打开命令面板，里面是**内置命令**而不是空清单', async () => {
    expect(press('p', shiftMod()).defaultPrevented).toBe(true)
    // 🔴 `CommandPalette` 也走 `lazy()`（M3-C-2），理由与上面打开工具箱那条逐字相同
    await flush()
    expect(commandPaletteEl()).not.toBeNull()
    expect(toolboxEl()).toBeNull()

    const ids = commandRowIds()
    // 三条各代表一批：内置命令（onMount 里才注册）、工具投影出来的（组件体里就注册了）、
    // 以及面板自己。少了 `generation` 那一格的话，前两条里只剩「工具」那一批还在
    expect(ids).toContain('file.save')
    expect(ids).toContain('editor.toggleLineWrap')
    expect(ids).toContain('toolbox.open')
    expect(ids).toContain('commandPalette.open')
    // 🔴 PLAN §1.5 那三条触达路径里的**第一条**：工具被投影成了命令，于是在面板里搜得到。
    // 这一条在 `tools/registry.test.ts` 里钉过单元层，这里是 App 层——
    // 少接一步（`App.tsx` 里没调 `installTools`，或者没把 `BUILTIN_TOOLS` 递进去）只有这里能看见
    expect(ids).toContain('tool.json.format')
    // ⚠️ 另外五个也要在：`installTools` 收的是 `BUILTIN_TOOLS` 整个数组，
    // 而「只装了前一个」这种错在上一行是看不出来的
    expect(ids).toContain('tool.codec')
    expect(ids).toContain('tool.uuid')
    expect(ids).toContain('tool.timestamp')
    expect(ids).toContain('tool.regex')
    expect(ids).toContain('tool.naming')
    expect(ids.length).toBeGreaterThan(40)
    expect(commandPaletteEl()?.querySelector('.palette-status')?.textContent).toBe(`共 ${ids.length} 条命令`)
  })

  it('Esc 收起命令面板', async () => {
    press('p', shiftMod())
    await flush()
    expect(commandPaletteEl()).not.toBeNull()
    expect(pressInCommandPalette('Escape').defaultPrevented).toBe(true)
    expect(commandPaletteEl()).toBeNull()
  })

  it('在面板里挑「工具箱…」：面板收起、工具箱展开', async () => {
    press('p', shiftMod())
    await flush()
    typeCommand('工具箱')
    expect(commandRowIds()).toEqual(['toolbox.open'])

    pressInCommandPalette('Enter')
    // 🔴 `commit()` 先收起面板、再执行 `toolbox.open`。面板收起是同步的，而工具箱是一块
    // **冷的** `lazy()`（单独跑这一条时它还没被任何用例焐热过），所以要 `await flush()` 才渲染出来
    await flush()

    // 🔴 `commit()` 是**先收起再执行**的，所以这两个断言不是废话：
    // 顺序反了的话工具箱会先展开、再被面板那一下收起，用户按完什么都没发生
    expect(commandPaletteEl()).toBeNull()
    expect(toolboxEl()).not.toBeNull()
  })

  it('面板里的置灰读的是聚焦的那块分屏，不是建面板那一刻的快照', async () => {
    // `App.tsx` 里那条挂了三个里程碑的 TODO 说的就是这件事：`registry` 的 `getContext`
    // 是「被调用时求值」的，而面板要的是「订阅」。验收的办法是把**同一个** `appContext`
    // 交给两边——于是这里只要证明面板读到的确实是活的 `ws.focusedEditor()`
    typeText('# 标题\n')
    press('p', shiftMod())
    await flush()

    // 空文档也有一块真的 CM6 分屏，所以 `editor.*` 一条都不该置灰。
    // ⛔ 反过来（`context` 被写死成 `{ editor: null }`）的话这里会是一片灰
    expect(commandRows().filter((el) => el.classList.contains('disabled'))).toEqual([])
    const wrap = commandRows().find((el) => el.getAttribute('title') === 'editor.toggleLineWrap')
    expect(wrap?.getAttribute('aria-disabled')).toBe('false')

    // 而「没有编辑器就置灰」这半边在 `commands/palette.test.ts` 里翻着 `setEditor` 钉过：
    // jsdom 里造不出一块「聚焦的只读分片」，硬造等于把 M2-H 那一组重写一遍
  })
})

describe('分层配置接线（M4-A）', () => {
  function selectByTitle(prefix: string): HTMLSelectElement {
    const el = [...container.querySelectorAll('select')].find((s) => s.title.startsWith(prefix))
    if (!el) throw new Error(`找不到 title 以「${prefix}」开头的 select`)
    return el
  }
  const fontSelect = () => selectByTitle('正文与 UI 字体')
  const codeFontSelect = () => selectByTitle('代码区字体')

  /** Solid 的 onChange 直接挂在元素上，dispatch 一个 bubbles 的 change 就能命中 */
  function changeSelect(el: HTMLSelectElement, value: string): void {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * 换一份持久化配置，重走一遍启动。
   *
   * settings 只在挂载时的那个 effect 里 `load` 一次，所以改完 mock 必须重挂——直接在跑着的
   * App 上改 `settingsCmd.loaded` 什么都不会发生，用例会绿得毫无意义（与 `restartWith` 同一条理由）。
   */
  async function restartWithSettings(loaded: unknown, loadError: unknown = null): Promise<void> {
    dispose()
    container.remove()
    settingsCmd.loaded = loaded
    settingsCmd.loadError = loadError
    settingsCmd.saved = []
    mountApp()
    await flush()
  }

  it('挂载后应用的是内置默认配置，CSS 变量与两个字体 select 同步', () => {
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')
    expect(fontSelect().value).toBe('screen-gb')
    expect(codeFontSelect().value).toBe('maple-cn')
    // 装回默认不写盘：load 只读，不该在启动时就产生一次 save_settings
    expect(settingsCmd.saved).toEqual([])
  })

  it('Mod+= 改字号后写穿到 save_settings，存的正是新档位那一整份', async () => {
    press('=', modInit())
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('15px')
    await flush()
    // 写队列是异步的：一次改动最终只落一次盘，且存的是**当前值**（不是旧值）
    expect(settingsCmd.saved).toHaveLength(1)
    expect(settingsCmd.saved[0]).toEqual({ fontSize: 15, fontVariant: 'screen-gb', codeFont: 'maple-cn' })
  })

  it('字号 select 改动同时更新 CSS 变量并写穿', async () => {
    changeSelect(fontSizeSelect(), '18')
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('18px')
    await flush()
    expect(settingsCmd.saved.at(-1)).toEqual({ fontSize: 18, fontVariant: 'screen-gb', codeFont: 'maple-cn' })
  })

  it('正文字体 select 改动写穿到 save_settings', async () => {
    changeSelect(fontSelect(), 'screen-r')
    await flush()
    expect(settingsCmd.saved.at(-1)).toEqual({ fontSize: 14, fontVariant: 'screen-r', codeFont: 'maple-cn' })
  })

  it('代码区字体 select 改动写穿到 save_settings', async () => {
    changeSelect(codeFontSelect(), 'inherit')
    await flush()
    expect(settingsCmd.saved.at(-1)).toEqual({ fontSize: 14, fontVariant: 'screen-gb', codeFont: 'inherit' })
  })

  it('重启后装回持久化的配置，CSS 变量与 select 都反映盘上的值', async () => {
    await restartWithSettings({
      settings: { fontSize: 18, fontVariant: 'system-mono', codeFont: 'inherit' },
      report: { userLayer: { status: 'present' }, projectLayer: { status: 'absent' }, ignoredProjectKeys: [] },
    })
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('18px')
    expect(fontSelect().value).toBe('system-mono')
    expect(codeFontSelect().value).toBe('inherit')
    // 装回只读、不写穿：一次启动不该因为「读到了盘上的值」再存一遍
    expect(settingsCmd.saved).toEqual([])
  })

  it('盘上的字体 ID 不认识时退回注册表默认，档外字号退回默认档', async () => {
    await restartWithSettings({
      settings: { fontSize: 17, fontVariant: 'toString', codeFont: '不存在的字体' },
      report: { userLayer: { status: 'present' }, projectLayer: { status: 'absent' }, ignoredProjectKeys: [] },
    })
    // 17 不在 FONT_SIZES 里、'toString' 命中的是原型链而不是注册表：三个都被 sanitize 打回默认
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')
    expect(fontSelect().value).toBe('screen-gb')
    expect(codeFontSelect().value).toBe('maple-cn')
  })

  it('load_settings 出错时提示条报出来，字体退回内置默认而不拦启动', async () => {
    await restartWithSettings(
      {
        settings: { fontSize: 14, fontVariant: 'screen-gb', codeFont: 'maple-cn' },
        report: { userLayer: { status: 'absent' }, projectLayer: { status: 'absent' }, ignoredProjectKeys: [] },
      },
      { kind: 'io', reason: 'PermissionDenied', message: '读不了配置' },
    )
    // 编辑器照常挂载（启动没被拦下），提示条把那句错误说出来
    expect(container.querySelector('.editor-container .cm-editor')).not.toBeNull()
    expect(notices().map((n) => n.level)).toContain('warning')
    expect(notices().some((n) => n.text.includes('读不了配置'))).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--vela-font-size')).toBe('14px')
  })
})
