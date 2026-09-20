/**
 * `vela_core::fs::shard` + `src-tauri/src/shard.rs` 的前端镜像（PLAN.md §2.4「大文件」，M2-H）。
 *
 * ⚠️ **与 `src/ipc/fs.ts` 同样的处境：类型是手写的，两边没有代码生成。** 这一份的
 * 漂移失败方式有两档，一档吵一档安静：
 *
 * - **吵的**：`ShardHeader` 的字段名漂了，状态栏显示 `undefined`，一眼能看见；
 * - 🔴 **安静的**：`readLines` 的**参数名**漂了。Tauri 按名字去 payload 里取值，
 *   `start` 写成 `from` 的话 Rust 那边拿到的是 `0`——于是每一次读页都从文件开头
 *   返回同样那几十行。界面不报错、不空白，只是**滚不动**，而「滚不动」
 *   最容易被报成「这编辑器卡」，压根不会有人联想到是一个参数名。
 *
 * 所以两侧各有一份对照的黄金 JSON，**命令的参数名也在契约里**：
 *
 * - Rust（vela-core 那两个类型）：`crates/vela-core/src/fs/shard.rs` 的 `元信息的线上形状`、
 *   `crates/vela-core/tests/wire_contract.rs` 的 `分片元信息与分页的线上形状`
 * - Rust（src-tauri 那层信封）：`src-tauri/src/shard.rs` 的 `线上形状`
 * - 前端：`src/ipc/shard.test.ts`
 */

import { invoke } from '@tauri-apps/api/core'
import type { EncodingId, LineEndingId } from './fs'

/**
 * Rust `fs::ShardHeader`，`#[serde(rename_all = "camelCase")]`。
 *
 * ⚠️ **刻意没有 `FileFormat`**，而 `fs.ts` 的 `TextFile` 有。不是漏了：
 * 分片模式**永远不写盘**，所以「怎么还原原样」这份信息在这儿没有用途，
 * 而带着它只会让人以为这个标签能保存。理由写在 `crates/vela-core/src/fs/mod.rs`
 * 那一节「`shard` 是这一层里唯一只读的一条路」。
 *
 * 于是下面的 `encoding` 与 `eol` 是**只用于显示**的两个字段，⛔ 不要把它们
 * 拼回一个 `FileFormat` 去调 `saveFile`。
 */
export interface ShardHeader {
  /**
   * 总行数。滚动条高度就靠它，所以它必须在 `openLarge` 那一下就有——
   * 这也是「建索引没法懒」的全部理由。
   *
   * ⚠️ 口径是 `wc -l` 那一套（`\n` 的个数，末尾没有 `\n` 才补一行），
   * **与 CM6 差一行**：CM6 认为 `"a\n"` 有两行。分片视图不用 CM6，所以不跟
   */
  totalLines: number
  bytes: number
  encoding: EncodingId
  bom: boolean
  /** ⚠️ 只从头部 256 KiB 判出来的，**只用于状态栏显示**（见上面那段） */
  eol: LineEndingId
  /** 头部那一段解码就有损。逐页还有一个 `ShardPage.lossy`，两者不是一回事 */
  lossy: boolean
}

/** Rust `shard::ShardOpen`（`src-tauri/src/shard.rs`）：`open_large` 的返回值 */
export interface ShardOpen {
  /**
   * 之后 `readLines` / `closeLarge` 都用它。
   *
   * ⚠️ **从 1 开始，0 永远不是合法句柄**（Rust 侧刻意留的：前端一个没初始化好的
   * `number` 字段也是 0，让它永远只可能是 bug 而不可能与真分片撞上）。
   *
   * ⚠️ **永不复用**。所以「关掉再打开同一个文件」拿到的是**新**句柄，
   * 而一个迟到的旧句柄的读请求会回来一个 `null`——见 [`readLines`]
   */
  handle: number
  header: ShardHeader
}

/** Rust `fs::ShardPage`，`#[serde(rename_all = "camelCase")]` */
export interface ShardPage {
  /**
   * 🔴 这一页第一条行的行号，**是 Rust 侧夹过的那一个**，不是你递进去的 `start`。
   *
   * 于是前端**必须**拿它去定位，⛔ 不能拿自己请求时用的那个数：请求第 9999 行
   * 而文件只有 10 行时，回来的是 `start: 10` 加一个空 `lines`。
   * 用自己的数去算的话，滚动到底那一下会把空页画在错误的位置上
   */
  start: number
  /**
   * 每行一条，**不含**行尾。CRLF 文件里那个 `\r` 已经剥掉了。
   *
   * ⚠️ 一行一条而不是拼成一个大字符串，是为了让「末尾那个空行到底是一行还是分隔符」
   * 不必靠猜——`lines.length` 就是行数
   */
  lines: string[]
  /**
   * true = 撞了字节上限（1 MiB），`lines` 的最后一条**不完整**、后面还有行没给。
   *
   * 🔴 只有一种情况会为真：某一行长得离谱（压缩过的 JSON、`tr '\\n' ' '` 的产物）。
   * ⛔ **读到文件末尾不算截断**，所以正常文件的最后一页这里是 false——
   * UI 别把它当成「还有更多」的提示
   */
  truncated: boolean
  /** true = 这一页解码时有字节无法映射，正文里含 U+FFFD。逐页报，理由见 Rust 侧 */
  lossy: boolean
}

/**
 * 打开一个大文件的只读分片。
 *
 * ⚠️ **只在 `openFile` 回了 `too_large` 之后才调**（4 MiB 与 256 MiB 之间的那一段）。
 * 不要拿它当「打开文件」的另一条路：它建索引要**整整扫一遍**文件，
 * 一个小文件走这条路是白付一次全文件读。
 *
 * ⚠️ 同一个路径开两次就是**两个句柄、两个 fd**，Rust 侧刻意不去重。
 * 前端也不该自己去重：两个标签各自滚动是正常用法。
 *
 * reject 的值是 `ReadError`（见 `./fs`），说人话用 `describeFsError` 就够了，
 * ⛔ 不必为分片另写一份分支表。四个 `kind` 里 `too_large`（超过 256 MiB）与
 * `unsupported_encoding`（UTF-16）是这一条**独有**的出口。
 */
export function openLarge(path: string): Promise<ShardOpen> {
  return invoke<ShardOpen>('open_large', { path })
}

/**
 * 读 `[start, start + count)` 这几行。
 *
 * ## 🔴 为什么参数是一个对象而不是三个位置参数
 *
 * 三个都是 `number`，写反了 TypeScript 一个字都不会说。而 `handle` 与 `start`
 * 写反的失败方式是**安静的**：那个句柄不存在 → 回来一个 `null` → 视图空白，
 * 或者更糟——碰巧存在，于是把**另一个文件**的行号当句柄用。
 * 收成对象之后，交换在语法上就写不出来。
 *
 * ## ⚠️ `null` 是正常返回值，不是错误
 *
 * 它只有一个意思：**这个句柄已经关了**。而这是一个每天都会发生的时序——
 * 用户滚动 → 请求发出 → 用户关掉标签 → `closeLarge` 先到 → 请求回来时句柄没了。
 * 前端的正确处理只有一个字：**忽略**（连一行警告都不要）。
 *
 * ## ⚠️ 夹取是 Rust 侧的事，前端**不要**再夹一遍
 *
 * `count` 会被夹到 1024 行与 1 MiB 两道闸里，`start` 会被夹到总行数。
 * 前端夹一遍的话就有两份夹取逻辑，而它们迟早会漂——漂了的症状是
 * 「滚动条到底了但最后几行出不来」。正确做法是**读返回值**：
 * 用 `page.start` 定位、用 `page.lines.length` 当行数，别信自己发出去的那两个数。
 */
export function readLines(args: { handle: number; start: number; count: number }): Promise<ShardPage | null> {
  return invoke<ShardPage | null>('read_lines', args)
}

/**
 * 关掉一个分片，fd 与索引一起释放。
 *
 * 🔴 **这是 Vela 里唯一一个「不调就会漏」的 IPC。** 另外三份 Rust 侧状态都不需要
 * 前端收尾：任务注册表由后台线程自己摘、索引缓存由 `retain` 顺手淘汰、
 * 监听订阅跟着标签集合整张换掉。只有句柄表里的一个条目对应**一个操作系统的 fd**，
 * 而 fd 不会因为没人再提它就自己关掉。
 *
 * ⚠️ 于是三处都必须调：标签关闭、窗口关闭、以及**外部改了文件之后重开分片**
 * （旧 fd 指的是旧 inode，索引与内容一起旧下去、彼此自洽，所以看得见新内容的
 * 唯一办法是整个重开一次——重开前先关掉旧的那个）。
 *
 * ⚠️ 关一个不存在的句柄**不是错误**（Rust 侧直接什么都不做）：
 * 标签级与窗口级各关一次是正常时序，报错的话前端就得先记住自己关过没有。
 * 所以这一条**不需要** try/catch，也不要在它前面加「关过了吗」的判断。
 */
export function closeLarge(handle: number): Promise<void> {
  return invoke<void>('close_large', { handle })
}
