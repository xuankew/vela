/**
 * `upload_image` 的前端封装（M7-3，PLAN.md §3.5「图片粘贴自动落地」的云端分支）。
 *
 * ## 🔴 这个模块的参数只有一个：字节
 *
 * 没有 bucket、没有 region、没有 AccessKey ID、没有前缀，也没有密钥。那四格目的地只从
 * **用户全局配置**读（`~/.vela/settings.json`，且项目层写来的这四格会被 Rust 忽略），
 * `AccessKeySecret` 只在进程内从钥匙串取（`src-tauri/src/secrets.rs`）。
 * 完整论证在 `src-tauri/src/commands.rs` 里 `upload_image` 的文档上，一句话版本：
 * 那四格决定「请求打到哪个主机」，而 `Authorization` 是照着主机签的——收了它们，
 * 预览里一个注入的 `<script>` 就能拿着用户的凭证往任意主机发任意字节。
 *
 * ⛔ 也⛔不要在这里加一条能读密钥的函数。本模块唯一的「密钥相关」出口是 `./secrets.ts`
 * 那三条写/删/问配没配的命令。
 *
 * ## 返回的是那一个不带签名的公网 URL
 *
 * 直接写进正文（`![](url)`）。⛔ 不要改成签名地址：签名地址带有效期，把一个有时效的访问
 * 凭证永久写进一份会同步、会备份、会被贴到别处的文档里，等于把访问权固化成漏洞。
 * 预览里要真看见图，走 M7-8 那条临时签名地址。
 *
 * ## 文案全在 Rust，这里只做一件事
 *
 * 七个 `kind` 里只有 `too_big` 需要前端拼句子（数字要格式化成 MB），其余六个原样透传
 * `reason` / `message`。理由与 `describeSecretError` 那一条相同：**同一句话有两个出口**
 * （这里的失败与 M7-7 降级时给用户的那句解释），前端再存一份就是措辞漂移的起点。
 *
 * ## ⚠️ 上限在前端挡一次，是为了不编 base64
 *
 * 与 `./asset.ts` 那一条同种姿势：一张 40 MB 的图先把 base64 编出来（约 53 MB 的字符串）、
 * 再花一次 IPC 往返让 Rust 拒掉，用户看到的是「点了之后卡了一下」。
 * 这一道**不**代替 Rust 那侧的检查——那一个管的是解出来的字节数，仍然是权威。
 */

import { invoke } from '@tauri-apps/api/core'
import { bytesToBase64 } from '../util/base64'
import { tooBigText } from './asset'

/** Rust `oss::MAX_UPLOAD_BYTES`，10 MB。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/**
 * 「测试上传」那一张图：1×1 透明 PNG，67 字节。
 *
 * 与 Rust 侧 `wire_contract.rs` 的 `TINY_PNG`、`src/ipc/asset.test.ts` 里那一份是同一串字节。
 *
 * ⚠️ 名字不是这里定的：Rust 按内容哈希命名，所以这一串字节**永远**落成同一个对象名
 * （`pasted-<hash>.png`）。于是「测试上传」点十次在 bucket 里还是那一个文件，
 * 不会堆出十个没人认领的探测图。这是刻意挑 1×1 固定字节而不是「把用户刚粘贴的那张传上去」
 * 的理由之一——后者会把每次测试的字节都留在 bucket 里。
 */
export const TEST_UPLOAD_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

/** Rust `oss::UploadError`，`#[serde(tag = "kind", rename_all = "snake_case")]` */
export type UploadError =
  /** 那四格里少一项，或 region 填成了访问域名，或钥匙串里根本没有/读不出密钥。`reason` 点名哪一项 */
  | { kind: 'not_configured'; reason: string }
  | { kind: 'too_big'; bytes: number; limit: number }
  /** base64 解不开。⚠️ 永远是我们自己的 bug（编码器只有 `src/util/base64.ts` 一个） */
  | { kind: 'bad_data'; reason: string }
  /** 字节不是认得的图片格式，或者是零字节。`reason` 与本地那条 `asset.ts` 的 `unsupported` 同一句话 */
  | { kind: 'bad_image'; reason: string }
  /**
   * 签名层拒掉了这一条请求。
   *
   * ⚠️ 现实里只可能是「签名时刻的形状不对」，而那个串由 Rust 自己生成、永远合法。
   * 它出现了就是我们自己的 bug，⛔ 不要当兜底文案用
   */
  | { kind: 'bad_sign_time'; reason: string }
  /** OSS 回了非 2xx。`message` 是按服务端错误码翻好的中文，`requestId` 只在报障时带上 */
  | { kind: 'rejected'; status: number; code: string | null; message: string; request_id: string | null }
  /** 请求没走到 OSS。`reason` 是给程序分支的分类（Timeout/Connect/Body/Decode/Other/ClientInit），`message` 给人看 */
  | { kind: 'network'; reason: string; message: string }

function isUploadError(value: unknown): value is UploadError {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

export function describeUploadError(err: unknown): string {
  if (!isUploadError(err)) return err instanceof Error ? err.message : String(err)
  switch (err.kind) {
    // 六条透传：句子在 Rust 那边已经写完了（`oss.rs` 与它转发的 `secrets.rs` / `vela-core::fs`）
    case 'not_configured':
    case 'bad_data':
    case 'bad_image':
    case 'bad_sign_time':
      return err.reason
    case 'rejected':
    case 'network':
      return err.message
    case 'too_big':
      return tooBigText(err.bytes, err.limit)
    default:
      return String(err)
  }
}

/**
 * 把一张图片传进用户配好的那个 bucket，返回**要写进正文的 URL**。
 *
 * @param bytes 图片的原始字节。名字与 `Content-Type` 都由 Rust 按内容哈希与魔数决定，
 *   前端既给不了名字，也给不了 MIME（后者参与签名，两边必须一字不差）
 * @throws 超限的字节在 `invoke` 之前就被拒，**不发出请求**。
 *   ⚠️ 抛的是 `Error` 而不是一个 `{ kind: 'too_big' }` 字面量——与 `storeImage` 同一条理由：
 *   不是 `Error` 的 reject 值在 `catch` 里没有 stack，而 `describeUploadError` 对 `Error`
 *   有兜底路径，正好接住它自己的 message
 */
export async function uploadImage(bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(tooBigText(bytes.length, MAX_UPLOAD_BYTES))
  return invoke<string>('upload_image', { dataBase64: bytesToBase64(bytes) })
}
