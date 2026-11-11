/**
 * 微信读书 key 的前端封装（M8-2）。
 *
 * ## 🔴 与 `secrets.ts` 同一条红线：这里没有任何一条命令能拿到 key 的值
 *
 * 三条命令分别是写、删、问「配没配」。`SecretStatus` 里只有一个 bool，⛔ 不要给它加字段，
 * 也不要新写一条 `get_weread_key`：webview 里任何一段脚本都能 `invoke`，而预览一份别人
 * 发来的 Markdown 就足以注入一段。完整论证在 `src-tauri/src/secrets.rs` 的模块文档里。
 *
 * ## 为什么错误类型与状态形状直接复用 `secrets.ts`
 *
 * Rust 那一侧两条凭证共用 `secrets::SecretError` / `SecretStatus`（同一个钥匙串层，
 * 只有 service/account 不同），所以这里也共享同一个类型：再定义一份镜像，等于给
 * 「钥匙串失败的那四句中文」开第二个出处。⚠️ `describeSecretError` 也一律复用，
 * 这两个模块里不该出现任何一个中文字符。
 *
 * ⚠️ 也因为这个，同步（M8-3）那一侧的错误不在这里：它不是钥匙串错误，M8-3 接面板时
 * 再加 `WereadError` 的镜像。
 */

import { invoke } from '@tauri-apps/api/core'
import type { SecretStatus } from './secrets'

export type { SecretStatus }

/**
 * 写入 key（创建或覆盖同一项）。
 *
 * ⚠️ 传之前**不要**在前端 `trim()`：Rust 那一份 `secrets::store` → `clean` 才是唯一口径。
 */
export function setWereadKey(key: string): Promise<void> {
  return invoke<void>('set_weread_key', { key })
}

/**
 * 删掉 key（面板上「清除」那一个按钮）。
 *
 * **幂等**：钥匙串里本来没有这一项也算成功，所以调用方不需要判返回值，
 * 也不该在「清除」之后立刻显示一条红字。
 */
export function deleteWereadKey(): Promise<void> {
  return invoke<void>('delete_weread_key')
}

/**
 * 问「配没配」。
 *
 * ⚠️ 失败**不要**咽成 `{ configured: false }`：「没存过」与「存了但读不出来」对用户是
 * 两句不同的话。正确处置是把 `describeSecretError` 那句话显示出来。
 */
export function wereadKeyStatus(): Promise<SecretStatus> {
  return invoke<SecretStatus>('weread_key_status')
}
