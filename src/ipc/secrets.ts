/**
 * OSS AccessKeySecret 的前端封装（M7-4）。
 *
 * ## 🔴 这一个模块里没有任何一条命令能拿到密钥的值
 *
 * 三条命令分别是写、删、问「配没配」。`SecretStatus` 里只有一个 bool，⛔ 不要给它加字段，
 * 也不要新写一条 `get_oss_secret`：完整论证在 `src-tauri/src/secrets.rs` 的模块文档里
 * （一句话版本：webview 里任何一段脚本都能 `invoke`，而预览一份别人发来的 Markdown
 * 就足以注入一段）。
 *
 * ## 为什么它不住在 `settings.ts` 里
 *
 * 那四格（bucket / region / AccessKey ID / prefix）是**位置**，进 `~/.vela/settings.json`，
 * 由 store 带着写穿。密钥是**凭证**，进钥匙串，`save_settings` 的那份 JSON 里永远没有它。
 * 分开两个模块不是整理癖：把它们放在一起，下一个改设置面板的人会以为六格是一套的。
 *
 * ⚠️ 也因为这个，`src/settings/store.ts` 的 OSS 信号里**没有** secret 那一项，
 * 面板上那个「已配置」是这里的一次异步查询，不是一个持久化的字段。
 */

import { invoke } from '@tauri-apps/api/core'

/** Rust `secrets::SecretStatus` */
export interface SecretStatus {
  /** true = 钥匙串里有一项，且它读得出、能当密钥用（与「存过但不合法」是两回事） */
  configured: boolean
}

/** Rust `secrets::SecretError`，`#[serde(tag = "kind", rename_all = "snake_case")]`
 *
 * 🔴 四条变体**都带 `message`**，而且都是 Rust 那边写好的整句中文。这一份镜像里不写文案：
 * 同一句「拿不到密钥」有两个出口（这里的失败，与 `upload_image` 把它填进
 * `UploadError::NotConfigured.reason`），前端再存一份就是措辞漂移的起点。
 * 完整论证在 `src-tauri/src/secrets.rs` 的 `SecretError` 文档里。
 */
export type SecretError =
  /** 传进去一句空的或全是空白的。⚠️ 这不是写入失败，处置是「填」或「清除」 */
  | { kind: 'empty'; message: string }
  /** 钥匙串回了非 0 的状态码。`code` 是 OSStatus 原值，报障时唯一有用的数字 */
  | { kind: 'keychain'; code: number; message: string }
  /** 存着的那一项读不出可用密钥（多半是别的工具写的）。处置与「没配」相同，但文案不能说成没配 */
  | { kind: 'corrupt'; message: string }
  /** 当前平台没有钥匙串：只有 macOS 实现了这三条命令的读写 */
  | { kind: 'unsupported'; message: string }

function isSecretError(value: unknown): value is SecretError {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

/**
 * 把一次失败翻成给用户看的那一句话——**这里是纯透传**。
 *
 * `kind` 留着是有用的：面板要按类型决定「该把输入框标红，还是整块禁用」时读它。
 * 但文案只有一个出处，所以下面这个 switch 里不该出现任何一个中文字符。
 */
export function describeSecretError(err: unknown): string {
  if (!isSecretError(err)) return err instanceof Error ? err.message : String(err)
  switch (err.kind) {
    // `code` 不拼进这一句：它是给人报障用的，而那一句中文已经把「为什么」说清了。
    // 面板要展示诊断信息时自己带上它
    case 'empty':
    case 'keychain':
    case 'corrupt':
    case 'unsupported':
      return err.message
    default:
      return String(err)
  }
}

/**
 * 写入密钥（创建或覆盖同一项）。
 *
 * ⚠️ 传之前**不要**在前端 `trim()`：Rust 那一份 `clean` 才是唯一口径，去的是首尾空白、
 * 中间一位不动。两边各 trim 一次，将来其中一边改了规则，就会出现
 * 「面板以为存的是 A、钥匙串里其实是 B」。
 */
export function setOssSecret(secret: string): Promise<void> {
  return invoke<void>('set_oss_secret', { secret })
}

/**
 * 删掉密钥（面板上「清除」那一个按钮）。
 *
 * **幂等**：钥匙串里本来没有这一项也算成功，所以调用方不需要判返回值，
 * 也不该在「清除」之后立刻显示一条红字。
 */
export function deleteOssSecret(): Promise<void> {
  return invoke<void>('delete_oss_secret')
}

/**
 * 问「配没配」。
 *
 * ⚠️ 失败**不要**咽成 `{ configured: false }`：「没存过」与「存了但读不出来」对用户是两句
 * 不同的话，后者说成前者，用户会一遍一遍重填同一个本来正确的密钥。
 * 正确处置是把 `describeSecretError` 那句话显示出来。
 */
export function ossSecretStatus(): Promise<SecretStatus> {
  return invoke<SecretStatus>('oss_secret_status')
}
