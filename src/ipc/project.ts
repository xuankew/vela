/**
 * `vela-core::project` 的前端镜像 + Tauri command 封装（PLAN.md §2.6、§3.4 M2-A）。
 *
 * ⚠️ **与 `src/ipc/fs.ts` 同样的处境：类型是手写的，两边没有代码生成。** 漂移的失败
 * 方式是 `undefined` 而不是异常——`isDir` 写成 `is_dir`，每一项都会被当成文件，
 * 于是整棵树展开不了，而控制台一行错都没有。两侧各有一份对照的黄金 JSON：
 *
 * - Rust：`crates/vela-core/tests/wire_contract.rs` 的 `dir_listing_的线上形状`
 * - 前端：`src/ipc/project.test.ts`
 */

import { invoke } from '@tauri-apps/api/core'

/** Rust `project::DirEntry`，`#[serde(rename_all = "camelCase")]` */
export interface DirEntry {
  name: string
  /**
   * 相对 root 的路径，永远用 `/` 分隔、永远不以 `/` 开头或结尾。
   * **展开子目录时原样回传这个值**，不要自己拼路径——前端做路径算术就等于把
   * 「不会逃出项目根」这条结构性保证换成一次需要逐处审计的检查。
   */
  rel: string
  /** 绝对路径，交给 `openFile` 用 */
  path: string
  isDir: boolean
}

/** Rust `project::DirListing` */
export interface DirListing {
  /** 归一化后的 rel。要存就存这一份，不要存自己传进去的那个字符串 */
  rel: string
  /**
   * 已排好序：文件夹优先，同组内按不区分大小写的名字。
   *
   * ⚠️ **树不按 .gitignore 过滤**，所以 `node_modules` / `dist` / `target` 都会出现在
   * 结果里（三条理由与实测数据见 `vela-core/src/project/tree.rs` 的模块文档）。
   *
   * 前端也**不做**「默认折叠某些目录」的特殊处理：树是完全懒加载的，每一层都收起着、
   * 只有用户点开的那一层才会去读，所以那些目录压根不会被自动摊开——一份写死的目录名单
   * 在这里没有任何作用点。全局搜索是另一回事，那边一律过滤。
   */
  entries: DirEntry[]
}

export type TreeError =
  | { kind: 'io'; reason: string; message: string }
  | { kind: 'not_found'; path: string }
  | { kind: 'not_a_directory'; path: string }
  /** 新建/改名撞上已有条目（M2-B-5）。Rust 侧**不覆盖也不自动加 ` (1)` 后缀** */
  | { kind: 'already_exists'; path: string }
  /** 名字本身不合法（M2-B-5）：空、含 `/`、或者就是 `.` / `..` */
  | { kind: 'bad_name'; name: string }
  | { kind: 'escape'; rel: string }
  | { kind: 'bad_root'; path: string }

/** `invoke` 的 reject 值是 `unknown`：Tauri 把 Rust 的 `Err` 序列化后原样抛出 */
function isTreeError(value: unknown): value is TreeError {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

export function describeTreeError(err: unknown): string {
  if (!isTreeError(err)) return err instanceof Error ? err.message : String(err)
  switch (err.kind) {
    case 'not_found':
      return `找不到 ${err.path}（可能被移动或删除了）`
    case 'not_a_directory':
      return `${err.path} 是文件，不是文件夹`
    case 'io':
      return err.message
    // 下面两条是**用户的处境**，要说的是「你可以怎么办」
    case 'already_exists':
      return `${err.path} 已经存在，换一个名字`
    case 'bad_name':
      // 名字里带斜杠是这里最常见的一种：用户把整条路径打进了「名字」输入框。
      // 不能默默替他移动文件——移动需要目标层已经被列举过，而树是懒加载的
      // 名字用 JSON.stringify 而不是直接内插：它可能是空字符串（内插出来是一句
      // 没有主语的话），也可能含引号或空格
      return `${JSON.stringify(err.name)} 不能用作文件名（不能为空，也不能含 / 或只是 . / ..）`
    // 下面两条都是**我们的 bug**，不是用户的处境：rel 只可能来自上一次列举的返回值，
    // root 只可能来自 dialog。把它们说成用户能做的事，等于把一条断言伪装成一次提示
    case 'escape':
      return `内部错误：相对路径 ${JSON.stringify(err.rel)} 越出了项目根目录`
    case 'bad_root':
      return `内部错误：项目根目录 ${JSON.stringify(err.path)} 不是绝对路径`
    default:
      return String(err)
  }
}

/**
 * 列出 `root` 下 `rel` 这一层的条目。**只有一层**——Rust 侧绝不建全量树，
 * 所以「展开」永远是再发一次这个调用。
 *
 * @param root dialog（`directory: true`）给的绝对路径
 * @param rel 上一次返回的 `DirListing.rel` / `DirEntry.rel`；空字符串表示 root 本身
 */
export function listDir(root: string, rel = ''): Promise<DirListing> {
  // 两个形参都是单个单词，Tauri 2 的 snake_case → camelCase 转换在这里是恒等的。
  // 但 `rel` 不能省：Rust 侧是 `String` 而不是 `Option<String>`，缺 key 会直接反序列化失败
  return invoke<DirListing>('list_dir', { root, rel })
}

/** Rust `project::EntryKind`，`#[serde(rename_all = "lowercase")]`。⚠️ 不是布尔 */
export type EntryKind = 'file' | 'dir'

/**
 * 在 `root` 下新建一个文件或文件夹，返回它自己的条目。
 *
 * @param rel **相对 root 的完整路径**（父层 rel + `/` + 名字）。
 *   ⚠️ 这是全前端唯一一处路径字符串运算（`tree.ts` 的 `displayName` 只做反向的拆开）。
 *   拼的是 `rel` 而不是绝对路径，所以拼错了最坏也就是 `escape` 或 `not_found`——
 *   写不到 root 外面去，那条保证由 Rust 侧的 `resolve` 一个人守着。
 *
 * 已存在时 reject `already_exists`：**不覆盖，也不会自动改成 `xxx (1)`**。
 */
export function createEntry(root: string, rel: string, kind: EntryKind): Promise<DirEntry> {
  return invoke<DirEntry>('create_entry', { root, rel, kind })
}

/**
 * 把 `rel` 这一项改名为 `newName`。**只能同层改名**。
 *
 * @param newName **单个名字**，不是一条 rel。含 `/` 会被 Rust 侧拒成 `bad_name`——
 *   那不是偷懒：移动文件需要「目标层已经被列举过」这个前提，而树是懒加载的，
 *   前提不成立。要移动就用「在 Finder 中显示」然后拖。
 *
 * ⚠️ 这是本项目第一个**多单词**的命令参数，Tauri 2 在这里把 Rust 的 `new_name`
 * 转成 JS 的 `newName`。写成 `new_name` 的失败方式是 Tauri 报一句
 * 「invalid args `newName` for command `rename_entry`」，还算好查；
 * 但如果哪天给命令加了 `rename_all = "snake_case"`，这一处必须跟着改回去。
 */
export function renameEntry(root: string, rel: string, newName: string): Promise<DirEntry> {
  return invoke<DirEntry>('rename_entry', { root, rel, newName })
}

/**
 * 移到废纸篓。**不是真删，也没有递归删除这回事**：一个文件夹整个进废纸篓，
 * 能从 Finder 里捞回来。
 *
 * 返回 void：删掉之后前端要做的就是重读父层，Rust 侧没有什么值得回传的。
 *
 * ⚠️ **UI 的措辞必须是「已移到废纸篓」而不是「已删除」**：说「已删除」，用户会去找
 * 那个不存在的撤销，或者反过来以为文件真没了、去翻 git。
 */
export function trashEntry(root: string, rel: string): Promise<void> {
  return invoke<void>('trash_entry', { root, rel })
}

/**
 * 在 Finder 中显示并选中这一项（macOS 的 `open -R`）。
 *
 * ⚠️ **只在 macOS 上真的能用**，别的平台 reject 一句 `io`（reason `Unsupported`）。
 * 这是明写的债不是被忽略的：`xdg-open` / `explorer` 的选中语义与 `open -R` 不同，
 * 「找等价命令」填进去会把「显示并选中」悄悄降级成「打开目录」。
 */
export function revealEntry(root: string, rel: string): Promise<void> {
  return invoke<void>('reveal_entry', { root, rel })
}

/**
 * 把这一项的绝对路径放进系统剪贴板（macOS 的 `pbcopy`）。
 *
 * 走 Rust 而不是 `navigator.clipboard.writeText`：后者要求安全上下文，而 Tauri 在
 * macOS 上用的是 `tauri://localhost` 这个自定义协议，算不算安全上下文取决于 WKWebView
 * 的版本——一条「有时能用有时不能」的剪贴板比一条只能用的更难查。
 */
export function copyEntryPath(root: string, rel: string): Promise<void> {
  return invoke<void>('copy_entry_path', { root, rel })
}

/**
 * Rust `project::IndexStats`，`#[serde(rename_all = "camelCase")]`。
 *
 * ⚠️ 读成 `elapsed_ms` 拿到的是 `undefined`，而 `undefined` 参与算术是 `NaN`、参与比较是
 * `false`，两种都不报错。两边各有一份对照的黄金 JSON：
 * Rust 侧 `wire_contract.rs` 的 `索引统计的线上形状`，前端 `project.test.ts`
 */
export interface IndexStats {
  /** 收进索引的文件数 */
  files: number
  /** 遍历途中读不动的目录数（权限不够、途中被删） */
  unreadable: number
  /**
   * 撞到 Rust 侧那个二十万的上限停下了，⚠️ 这份索引**不是全的**。
   *
   * 这个标志必须显示出来：为真时「找不到某个文件」与「这个文件不存在」在界面上
   * 长得一模一样，用户无从分辨，而他能做的两件事（换个词 / 去侧边栏翻）方向完全相反。
   *
   * ⚠️ 多根之下它是各根的**逻辑或**：三个根里有一个撞了上限，这一条就是真的。
   * 前端说不出是哪一个（那需要每条根一份账，而用户能做的事与是哪个根无关：
   * 都是「把词写窄一点，或者去侧边栏翻」）
   */
  truncated: boolean
  /**
   * 建索引花了多少毫秒。⚠️ 只在日志里有意义，别拿它当性能指标显示给用户。
   * 多根之下是各根**之和**（Rust 侧逐个建，不并发），所以它比单根时大是正常的
   */
  elapsedMs: number
}

/** Rust `project::FileMatch` */
export interface FileMatch {
  /**
   * 相对 root 的路径，规矩与 `DirEntry.rel` 完全一致。
   * ⚠️ 多根之下**不再唯一**，行键要带上 `rootIndex`
   */
  rel: string
  /** 绝对路径，直接交给 `openFile`。⚠️ 前端永远不需要拿 `rel` 自己拼 */
  path: string
  /**
   * 模糊匹配分。⚠️ 只在**同一次查询内部**有意义：那套权重是相对值，
   * 换一个搜索词就没有可比性。拿它排序可以，拿它做「够不够像」的阈值判断不行
   */
  score: number
  /**
   * 这一条属于 `roots` 里的第几个根（M2-F）。**总是存在**，单根时恒为 `0`，
   * 所以浮层里可以无条件地在路径前面加上根的名字。
   *
   * ⚠️ 与 `SearchFile.rootIndex` 同一条理由不给 `?`，也**不要**拿 `path` 反推
   */
  rootIndex: number
}

/** Rust `project::FileQuery` */
export interface FileQuery {
  /**
   * 排好序的前一小批。**Rust 侧已经按 `score` 降序排完了，前端不要再排一次**——
   * 排序规则（连续命中 > 分散命中、basename 里的命中 > 路径中间的命中、短路径优先、
   * 最近打开过的略微加分）住在 `vela-core/src/project/index.rs` 里，
   * 前端抄一份到 TypeScript 就等于把一个产品决定分成两处维护。
   *
   * ⚠️ 多根之下这一条更要紧一档：那一批是**跨根合并**过的，同分时按根的顺序。
   * 前端再排一次的话用的是 JS 的排序稳定性与自己的比较函数，
   * 于是「同分的两条谁在前」会与 Rust 侧不一致，浮层里候选的顺序就会抖
   */
  matches: FileMatch[]
  /**
   * 命中总数，**可以大于** `matches.length`。差值就是「还有更多没显示，把词写窄一点」，
   * 条数上限定在 Rust 侧的 `QUERY_LIMIT`，前端不对它做任何假设。
   *
   * ⚠️ 多根之下它是**各根之和**，而 `matches` 是合并后截断到 `QUERY_LIMIT` 条的：
   * 三个大仓库一起搜的时候「共 4 万条、显示 50 条」是常态，不是 bug
   */
  total: number
}

/**
 * 建**工作区里每一个根**的文件索引（**每次都重建**），回报合并成一份的账（M2-E）。
 *
 * 在 `Cmd+P` 浮层**展开的那一刻**调它，两个用途：① 让第一个按键落在一份热缓存上
 * （建索引在两万文件的仓库上是 40ms、十万文件上 205ms，那个数字与「为什么不能
 * 每个按键都建」的推理都写在 `src-tauri/src/commands.rs` 的 `ProjectIndexCache` 上）；
 * ② 拿到 `truncated`。
 *
 * ⚠️ 「每次都重建」是**买来的**，不是懒得做失效：M2-G 的文件监听落地之前没有别的
 * 东西会去动这份缓存，重建一次就等于「上一次开浮层之后新建的文件这一次一定找得到」。
 * 那条测试在 `src-tauri/src/commands.rs` 的 `每次_index_project_都重建`。
 *
 * ⚠️ 多根之下 Rust 侧是**逐个**重建（不并发），所以三个大仓库的浮层展开要等三份之和。
 * 这是刻意的：并发建会把 blocking 池占满，而 `open_file` / `list_dir` 也在上面，
 * 抢占编辑器的 IO 是用户看得见的。等的那一会儿浮层画的是 MRU，不是白屏。
 *
 * 报 `TreeError`，前端已有的 `describeTreeError` 直接就能用。
 * ⚠️ 有一个根不合法就**整次 reject**，`path` 是那一个根
 */
export function indexProject(roots: readonly string[]): Promise<IndexStats> {
  return invoke<IndexStats>('index_project', { roots })
}

/**
 * 在**当前工作区的每一个根**上做一次模糊匹配，合并后回一小批（M2-E）。
 *
 * @param roots 与 [`indexProject`] 那一次同一个数组。⚠️ 顺序就是浮层里同分候选的顺序
 * @param needle 空字符串是**合法的**，意思是「随便给我一批」——浮层刚展开、
 *   一个字都还没打时要的就是这个，而 `recent` 的加分会让最近打开过的排在最前面。
 *   ⚠️ 不要 trim：`"  "` 是两个空格，那是用户真的打了两个空格，替他改掉等于
 *   让输入框显示的东西与查询用的东西不是同一个
 * @param recent 前端 MRU 里的绝对路径清单，最新的在前。⚠️ **只用来加分**：
 *   Rust 侧拿它与索引里已有的 rel 比对，比不上的（长在 root 外面的、已经不存在的）
 *   直接忽略，不会因为它去打开或枚举任何路径。超过 50 条的部分同样被忽略
 *   （`vela_core::project::MAX_RECENT`），所以前端不需要先截一刀。
 *   ⚠️ 多根之下它是**一份跨根的清单**，不是每个根一份：MRU 记的是用户打开过的文件，
 *   那些文件可以分布在任何一个根里
 */
export function queryProject(
  roots: readonly string[],
  needle: string,
  recent: readonly string[] = [],
): Promise<FileQuery> {
  // `recent` 不能省：Rust 侧是 `Vec<String>` 而不是 `Option<...>`，缺 key 会直接反序列化失败
  return invoke<FileQuery>('query_project', { roots, needle, recent })
}
