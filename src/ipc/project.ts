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
