/**
 * `store_image` 的前端封装（M3-A-7，PLAN.md §3.5「图片粘贴自动落地」）。
 *
 * ⚠️ 类型与字段名同样是**手写**的，与 Rust 侧之间没有代码生成。两边各有一份对照的黄金
 * JSON：Rust 在 `crates/vela-core/tests/wire_contract.rs`（`stored_image_的字段名是_camel_case`
 * 与 `asset_error_用_kind_标签区分变体`），前端在 `./asset.test.ts`。
 *
 * ## 🔴 这一个模块里唯一有性能含义的决定：字节走 base64，不走数字数组
 *
 * Tauri 的 invoke 载荷是 JSON。一张 1 MB 的截图若编码成 `[137,80,78,…]`，就是 100 万个
 * JSON number token、约 4 MB 的文本，两头各解析一次要几百毫秒——用户的体验是
 * 「粘完卡了一下才出现链接」。编成一个 base64 字符串只有 1 个 token、约 1.4 MB，几毫秒。
 *
 * ## 🔴 编码器只有一个，在 `src/util/base64.ts`
 *
 * 它必须**分块**调 `String.fromCharCode`，而 `btoa` 吃的是 Latin-1 不是 UTF-8。
 * 两条理由都写在那一份的模块文档里，⛔ 这里不抄一遍
 */

import { invoke } from '@tauri-apps/api/core'
import { bytesToBase64 } from '../util/base64'

/**
 * 单张图片的上限，与 Rust 侧 `vela_core::fs::MAX_IMAGE_BYTES` 同一个数。
 *
 * ⚠️ 两边各写一份，靠 `wire_contract.rs` 里那个 `"limit":33554432` 字面量对齐。
 * 前端留着它不是为了代替 Rust 的检查，而是为了**在 `file.arrayBuffer()` 之前就拒绝**：
 * 用户在 Finder 里复制一个 2 GB 的文件再粘进来是会发生的事，那时先把 2 GB 读进
 * webview 的内存、再交给 Rust 去拒，界面已经卡死过了。
 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** Rust `fs::StoredImage`，`#[serde(rename_all = "camelCase")]` */
export interface StoredImage {
  /**
   * 相对**文档所在目录**的路径，正斜杠，形如 `assets/pasted-ad48c1765eb1b87d.png`。
   *
   * 🔴 这是唯一一个前端会**拼进文档正文**的字段（`![](<rel>)`）。别的字段读错了顶多
   * 是提示语不对，这一个读错了就是正文里躺着一个坏链接——而且它当时看着是对的，
   * 要等预览或 GitHub 渲染出破图才发现。
   */
  rel: string
  /** 绝对路径，只用来在提示语里显示 */
  path: string
  bytes: number
  /**
   * true = 磁盘上本来就有一份**字节完全相同**的，这次没写盘。
   *
   * ⚠️ 不是失败，也不该因此少插一次链接：用户把同一张图粘了两遍，正文里就该有两个
   * 引用同一份文件的链接。前端唯一该做的区别对待是**别说「已保存」**——它没保存任何东西
   */
  reused: boolean
}

export type AssetError =
  /** 字节不是一种认得的图片格式。`reason` 是 Rust 侧写好的一句话，可以直接显示 */
  | { kind: 'unsupported'; reason: string }
  | { kind: 'too_big'; bytes: number; limit: number }
  | { kind: 'empty' }
  | { kind: 'no_parent'; path: string }
  /**
   * base64 解不开。⚠️ **这一条永远是我们自己的 bug**，不是用户做错了什么：
   * 编码器只有 `src/util/base64.ts` 的 `bytesToBase64` 一个，而 Rust 那侧只认标准字母表 + padding。
   * 它出现了就说明这两句话里有一句被人改了
   */
  | { kind: 'bad_data'; reason: string }
  | { kind: 'io'; reason: string; message: string }

function isAssetError(value: unknown): value is AssetError {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

/** 与 `describeFsError` 的 `too_large` 同一个口径：MB 一位小数，上限取整 */
function tooBigText(bytes: number, limit: number): string {
  return `这张图有 ${(bytes / 1048576).toFixed(1)} MB，超过上限 ${(limit / 1048576).toFixed(0)} MB`
}

export function describeAssetError(err: unknown): string {
  if (!isAssetError(err)) return err instanceof Error ? err.message : String(err)
  switch (err.kind) {
    case 'unsupported':
    case 'bad_data':
      // 两条都直接用 Rust 侧写好的句子：`unsupported` 里带着开头的字节，
      // 那是「我粘的明明是一张图」与「Vela 说这不是图」之间唯一的线索
      return err.reason
    case 'too_big':
      return tooBigText(err.bytes, err.limit)
    case 'empty':
      return '粘进来的图片是空的'
    case 'no_parent':
      return `${err.path} 没有目录部分，推不出 assets/ 该放哪`
    case 'io':
      return err.message
    default:
      return String(err)
  }
}

/**
 * 把一张图片落到 `docPath` 旁边的 `assets/` 里。
 *
 * 🔴 **签名里没有目标目录、也没有文件名。** `docPath` 只用来推出落地位置，
 * 名字由 Rust 按内容哈希生成——「往任意位置写任意名字」这个原语在这一条路上不存在。
 * 完整论证在 `crates/vela-core/src/fs/asset.rs` 的模块文档里。
 *
 * @param docPath **当前文档的绝对路径**。调用方必须先确认它不是 `null`
 *   （未命名草稿没有目录可推，那种情况要在调进来之前就拒掉，见 `src/md/paste.ts`）
 * @throws 超限的字节在 `invoke` 之前就被拒，**不发出请求**：把 33 MB 编成 base64
 *   再让 Rust 拒掉，白花的是一次几十毫秒的编码与一次 IPC 往返。
 *   ⚠️ 抛的是 `Error` 而不是一个 `{ kind: 'too_big' }` 字面量——`prefer-promise-reject-errors`
 *   那条 lint 是对的：一个不是 `Error` 的 reject 值在 `catch` 里没有 stack，
 *   而 `describeAssetError` 对 `Error` 有一条兜底路径，正好接住它自己的 message
 */
export async function storeImage(docPath: string, bytes: Uint8Array): Promise<StoredImage> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(tooBigText(bytes.length, MAX_IMAGE_BYTES))
  return invoke<StoredImage>('store_image', { docPath, dataBase64: bytesToBase64(bytes) })
}
