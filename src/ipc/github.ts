/**
 * GitHub token 的前端封装（M8-5）。
 *
 * ## 🔴 与 `secrets.ts` / `weread.ts` 同一条红线：这里没有任何一条命令能拿到 token 的值
 *
 * 三条命令分别是写、删、问「配没配」。`SecretStatus` 里只有一个 bool，⛔ 不要给它加字段，
 * 也不要新写一条 `get_github_token`：webview 里任何一段脚本都能 `invoke`，而预览一份别人
 * 发来的 Markdown 就足以注入一段。完整论证在 `src-tauri/src/secrets.rs` 的模块文档里；
 * 专属那一段在 `src-tauri/src/github.rs` 的文件头。
 *
 * ## 仓库地址不在这里
 *
 * `owner/repo` 是**地址**，进 `~/.vela/settings.json`，走 `./settings.ts` 的 `githubRepo`；
 * token 是**凭证**，进钥匙串，只走这三条命令。理由与 OSS 那四格 + secret 的分法逐字相同：
 * 放在一起，下一个改面板的人会以为它们是一套的。
 *
 * ## 为什么错误类型与状态形状直接复用 `secrets.ts`
 *
 * Rust 那一侧三把凭证共用 `secrets::SecretError` / `SecretStatus`（同一个钥匙串层，
 * 只有 service/account 不同），所以这里也共享同一个类型：再定义一份镜像，等于给
 * 「钥匙串失败的那四句中文」开第二个出处。⚠️ `describeSecretError` 也一律复用，
 * 这个模块里不该出现任何一个中文字符。
 */

import { invoke } from '@tauri-apps/api/core'
import type { SecretStatus } from './secrets'

export type { SecretStatus }

/**
 * 写入 token（创建或覆盖同一项）。
 *
 * ⚠️ 传之前**不要**在前端 `trim()`：Rust 那一份 `secrets::store` → `clean` 才是唯一口径。
 */
export function setGithubToken(token: string): Promise<void> {
  return invoke<void>('set_github_token', { token })
}

/**
 * 删掉 token（面板上「清除」那一个按钮）。
 *
 * **幂等**：钥匙串里本来没有这一项也算成功，所以调用方不需要判返回值，
 * 也不该在「清除」之后立刻显示一条红字。
 */
export function deleteGithubToken(): Promise<void> {
  return invoke<void>('delete_github_token')
}

/**
 * 问「配没配」。
 *
 * ⚠️ 失败**不要**咽成 `{ configured: false }`：「没存过」与「存了但读不出来」对用户是
 * 两句不同的话。正确处置是把 `describeSecretError` 那句话显示出来。
 */
export function githubTokenStatus(): Promise<SecretStatus> {
  return invoke<SecretStatus>('github_token_status')
}
