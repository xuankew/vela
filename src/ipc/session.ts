/**
 * `vela-core::session` 的前端镜像 + Tauri command 封装（PLAN.md §2.6）。
 *
 * 与 `./fs.ts` 同一套规矩：**类型手写，没有代码生成**，两边各有一份黄金 JSON 快照
 * （Rust 在 `crates/vela-core/tests/wire_contract.rs`，前端在 `./session.test.ts`），
 * 改一边必须改另一边。
 *
 * 会话比 fs 更需要这道保险：它有 14 个字段、一个枚举、一个嵌套元组数组，而任何一个
 * 名字写错的失败方式都是**「重启后什么都没恢复」**——不崩、不报错，用户只会觉得这功能没做。
 *
 * ⚠️ 注意 `path` 不是这两个 command 的参数。会话文件的位置由 Rust 侧从 `app_data_dir()`
 * 算出来（见 `src-tauri/src/commands.rs` 的 `session_path`）。让它变成参数等于给 webview
 * 再添一个「写任意路径」的原语，而写的内容是用户未保存的草稿。
 */

import { invoke } from '@tauri-apps/api/core'
import type { FileFormat } from './fs'

/** Rust `session::PaneDirection`，`#[serde(rename_all = "snake_case")]` */
export type PaneDirectionId = 'row' | 'column'

/** 存档格式版本。与 Rust 侧 `SESSION_VERSION` 同值，由两边的契约测试钉住 */
export const SESSION_VERSION = 1

/**
 * 一次最多存多少个标签。
 *
 * 这不是产品限制，是**预算限制**：`load_session` 的返回值要整个过一遍 IPC，
 * 上限 4MB（PLAN §2.6 修正 1）。超预算时 Rust 侧会丢草稿，而丢光草稿还超就意味着
 * 元信息本身超了 4MB——那种情况只能报错，整份会话都存不下来。
 *
 * 64 个标签的元信息（路径 + 格式 + 选区）最多几十 KB，离 4MB 有两个数量级，
 * 于是「丢草稿」这条路一定能走通。顺带也保证了启动恢复不会去读两百个文件。
 *
 * 超出部分从**最后**截断：标签条是按最近使用排的，越靠右越可能是刚顺手开一眼的。
 */
export const MAX_SESSION_TABS = 64

/** 一个标签的现场。字段名与 Rust `session::SessionTab` 一一对应 */
export interface SessionTab {
  /** `null` = 未命名文档（还没落过盘）。⚠️ 必须是 `null` 不能是 `undefined`，见文件尾 */
  path: string | null
  /**
   * 该文档的编码/行尾。**不可空**：未命名文档也有一份（默认格式），它是**那个文档**的
   * 属性、决定它的字节怎么写回去，不是「有没有路径」的附属品。前端不解释其内容，原样往返。
   */
  format: FileFormat
  /** 有未保存改动。恢复时照着它把标签标脏，否则关闭确认会漏掉它 */
  dirty: boolean
  /**
   * 解码时有字节没能映射，正文里含 U+FFFD。
   *
   * 必须跟着草稿一起存：这个标志的全部作用是拦住「原样保存会永久损坏原文件」，
   * 重启后把它丢了，等于把那条警告连同它要防的事故一起删掉。
   */
  lossy: boolean
  /**
   * 未保存的正文。非 `null` 的条件是「没法从磁盘读回来」：脏标签或未命名文档。
   *
   * 干净且有路径的标签留 `null`，恢复时重新读盘——Vela 关着的时候文件可能被别的程序
   * 改过，拿存档里的旧正文盖上去等于悄悄回退用户的文件。
   */
  draft: string | null
  /**
   * 全部选区，每项是 `[anchor, head]`（Rust 侧的 `(usize, usize)` 元组）。
   *
   * 存整个数组而不是只存一个光标位置：M1-C 把多光标做成了一等公民，
   * 恢复时把 5 个光标变成 1 个是明显的手感倒退，代价只是一个数组。
   */
  selection: Array<[number, number]>
  /** 主选区在 `selection` 里的下标 */
  main: number
  scrollTop: number
  scrollLeft: number
}

/**
 * 项目树那一头的现场。与 Rust `session::SessionProject` 一一对应。
 *
 * 与标签页是**两套独立的状态**：树管「磁盘上有什么」，标签管「打开了哪些文档」。
 * 关掉文件夹不动任何标签，反过来也一样，所以它在存档里也是一个独立的可选部分。
 */
export interface SessionProject {
  /** 项目根的绝对路径。恢复时原样喂给 `listDir`，前端不做任何路径算术 */
  root: string
  /**
   * 摊开着的层的 `rel`，含 `''`（根那一层）。
   *
   * ⚠️ `''` 不是「没有值」，它就是根。丢了它，恢复出来的树是收起的——用户点开过的
   * 文件夹全缩回去了，而这件事不报错，只会让人觉得「这功能没记住」。
   *
   * 条数上限由 `src/project/store.ts` 的 `MAX_RESTORED_EXPANDED` 负责，Rust 侧不截断
   * （两边各截一次的结果是谁也说不清最终是多少条）。
   */
  expanded: string[]
}

/** 一次完整的会话快照 */
export interface Session {
  /**
   * 存盘时 Rust 会**无视**这个值、强行写成它自己的 `SESSION_VERSION`；
   * 读回来时不认识就整份作废。前端照样要带上——它是必填字段，缺了 serde 直接报错。
   */
  version: number
  direction: PaneDirectionId
  /** 聚焦的分屏在 `panes` 里的下标（**不是标签下标**，两者只有一个标签时才碰巧相同） */
  focused: number
  tabs: SessionTab[]
  /**
   * 每块分屏显示哪个标签，存的是 `tabs` 的下标。
   *
   * 用下标而不是标签 id：id 是前端运行期递增分配的，重启后对不上。
   * **不允许重复**——`workspace.ts` 的不变量 2 规定一个标签同时只显示在一个分屏里，
   * Rust 侧的 `validate` 会直接拒掉重复的下标。
   */
  panes: number[]
  /**
   * 项目树。`null` = 上次没打开任何文件夹。
   *
   * 写成 `| null` 而不是 `?:`，与 `SessionTab.path` 同一条理由：`JSON.stringify` 会把
   * `undefined` 的 key 整个删掉，而这个 key 在 Rust 侧是带 `#[serde(default)]` 的——
   * 删掉恰好也能解析成 `None`，于是「拼错字段名」与「没打开文件夹」两种情况在线上
   * 长得一模一样，错的那一种永远查不出来。永远带上 key，拼错了才会在契约测试里露出来。
   *
   * 加了它 `SESSION_VERSION` 仍然是 1：旧存档缺这个 key 时解析成 `null`（= 当时确实没
   * 打开文件夹），新存档被旧版读到则整个字段被 serde 忽略。两个方向都优雅降级，
   * 没有哪一边会得到半对半错的现场。完整推理见 Rust 侧同名字段的文档。
   */
  project: SessionProject | null
}

/** Rust `session::SessionReport` */
export interface SessionReport {
  bytesWritten: number
  /**
   * 因为超过 4MB 预算而被丢掉的草稿个数。
   *
   * ⚠️ **大于 0 就必须告诉用户。** 用户以为未保存的草稿被存下来了，下次启动发现没了——
   * 这比一开始就不存更糟。
   */
  droppedDrafts: number
}

export type SessionError =
  | { kind: 'io'; reason: string; message: string }
  | { kind: 'no_parent'; path: string }
  | { kind: 'corrupt'; message: string }
  | { kind: 'version'; found: number; expected: number }
  | { kind: 'too_large'; bytes: number; limit: number }

/**
 * `invoke` 的 reject 值是 `unknown`：Tauri 把 Rust 的 `Err` 序列化后原样抛出。
 * 与 `./fs.ts` 的 `isFsError` 同形，但**不共用**——两个模块的错误集合会各自演化，
 * 共用一个守卫等于把两边的 kind 清单混成一个，`switch` 的穷举性检查也就没了。
 */
function isSessionError(value: unknown): value is SessionError {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

export function describeSessionError(err: unknown): string {
  if (!isSessionError(err)) return err instanceof Error ? err.message : String(err)
  switch (err.kind) {
    case 'corrupt':
      return `上次的会话没能读回来（${err.message}）`
    case 'version':
      return `上次的会话是版本 ${err.found} 的 Vela 存的，这个版本（${err.expected}）读不了`
    case 'too_large':
      return `会话有 ${(err.bytes / 1048576).toFixed(1)} MB，超过上限 ${(err.limit / 1048576).toFixed(0)} MB`
    case 'no_parent':
      return `${err.path} 没有目录部分，无法确定临时文件位置`
    case 'io':
      return err.message
    default:
      return String(err)
  }
}

/**
 * 读回上次的会话。
 *
 * `null` = 还没有存档（第一次启动），静默地开一个新文档就行；
 * reject = 存档存在但读不回来，得说一句「上次的会话没能读回来」再照常启动。
 * 两者在 UI 上是完全不同的两件事，所以 Rust 侧没有把它们合并成一个 `Option`。
 */
export function loadSession(): Promise<Session | null> {
  return invoke<Session | null>('load_session')
}

/**
 * 存下当前会话。
 *
 * ⚠️ 参数名 `session` 在契约里：Tauri 按名字去 payload 里取值，拼错的后果是 Rust 报
 * 「invalid args」——这一条**会**报错，不像字段名写错那样静默，但同样会让会话存不下来。
 *
 * ⚠️ 所有可空字段必须显式传 `null`，不能是 `undefined`：`JSON.stringify` 会把值为
 * `undefined` 的 key 整个删掉，而 serde 对「key 缺失」的处理与对 `null` 并不显然一致
 * （`Option<T>` 缺失恰好也是 `None`，但这是实现细节，不该赌）。类型写成 `| null`
 * 而不是 `?:` 就是为了让 TS 在这件事上帮忙。
 */
export function saveSession(session: Session): Promise<SessionReport> {
  return invoke<SessionReport>('save_session', { session })
}
