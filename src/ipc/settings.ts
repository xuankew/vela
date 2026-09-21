/**
 * `vela-core::settings` 的前端镜像 + Tauri command 封装（PLAN.md §3.6 M4-A）。
 *
 * 与 `./session.ts` 同一套规矩：**类型手写，没有代码生成**，两边各有一份黄金 JSON 快照
 * （Rust 在 `crates/vela-core/tests/wire_contract.rs`，前端在 `./settings.test.ts`），
 * 改一边必须改另一边。
 *
 * 配置比会话简单（六个具体键，没有嵌套元组），但失败方式一样安静：字段名写错的后果是
 * **「重启后字号/字体回到默认」**——不崩、不报错，用户只会觉得「我设的没记住」。
 *
 * ## 🔴 六个键在 v1 全是偏好类，项目层写了也忽略
 *
 * 用户裁定：字号 / 正文字体 / 代码字体 / 行高 / 字间距 / 主题是**个人偏好**，只认「内置默认 + 用户全局」两层。
 * 打开一个带 `.vela/settings.json` 的仓库**不会**改掉你的字号。于是项目层被读、被解析、
 * 但**不生效**：它试图写的偏好键落进 `SettingsReport.ignoredProjectKeys`，前端据此说一句
 * 「这个仓库想改你的 <键>，但 <键> 只认用户全局，已忽略」。完整推理见 Rust 侧模块文档
 * 与 PLAN §3.6「M4-A 实施修正」。
 *
 * ## ⚠️ 路径不是这两个 command 的参数
 *
 * 用户全局层 `~/.vela/settings.json` 的位置由 Rust 侧从 `home_dir()` 算出（见
 * `src-tauri/src/commands.rs` 的 `home_dir`），项目层由 `roots[0]` 拼写死的
 * `.vela/settings.json`。`loadSettings` 只收 `roots`（dialog 授权过的目录，与
 * `indexProject` 同一信任面），`saveSettings` **一个路径都不收**——让它变成参数等于给
 * webview 添一个「往任意目录写配置文件」的原语，而配置是启动即读、会灌进 UI 信号的东西。
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * 合并之后的**最终配置**：每个键都是具体值，没有 `undefined`。
 *
 * 这是 `loadSettings` 交出去、`saveSettings` 收进来的形状。字段名与 Rust
 * `settings::Settings` 一一对应（camelCase）。
 *
 * ⚠️ `fontVariant` / `codeFont` 在**线上是 `string` 而不是 `FontVariantId` / `CodeFontId``**：
 * 配置文件可能被手改成任何字符串，Rust 只当它是不透明串原样往返（合法 ID 清单住在
 * `src/fonts/loader.ts`，因为只有前端有字体注册表）。把它们收窄成 ID 是 **store 的职责**
 * （`src/settings/store.ts`：读到不认识的 ID 回退默认），不是这一层的——这一层要诚实地
 * 说「线上可能是任何串」。`fontSize` 同理：Rust 不夹范围，档位（`FONT_SIZES`）是 UI 概念，
 * 夹一次就够，归 store。
 */
export interface Settings {
  /** 编辑器字号（px）。偏好类，只认内置默认 + 用户全局 */
  fontSize: number
  /** 正文字体 ID。偏好类。线上是不透明串，store 负责校验 */
  fontVariant: string
  /** 代码区字体 ID。偏好类。同上 */
  codeFont: string
  /**
   * 行高（无单位倍数）。偏好类。`0` 不会是合法值（前端 `LINE_HEIGHT_MIN..MAX` 夹着），
   * 但线上是不透明数：Rust 不夹范围，读到档外值由 store 回退默认。
   */
  lineHeight: number
  /**
   * 字间距（em）。偏好类。`0` = CSS `letter-spacing: normal`（store 把 `0` 翻译成
   * `normal` 而不是 `0em`，理由见 `store.ts`）。Rust 不夹范围，归 store。
   */
  letterSpacing: number
  /**
   * 主题选择（M4-C）：`'light'` / `'dark'` / `'system'`。偏好类。
   *
   * ⚠️ 线上是**不透明串**而不是 `ThemeId`：与 `fontVariant` 同一条理由——配置文件可能被
   * 手改成任何串，Rust 只当它原样往返，合法 ID 清单（`THEME_IDS`）住在 `src/settings/theme.ts`，
   * 校验/回退是 store 的职责（`sanitizeThemeId`），不是这一层的。
   */
  theme: string
}

/**
 * 一层配置文件在读取时的下场。与 Rust `settings::LayerStatus` 对应，
 * `#[serde(tag = "status", rename_all = "snake_case")]`。
 *
 * ⚠️ `present` 不等于「生效」：项目层的偏好键解析成功后仍会被忽略
 * （见 `SettingsReport.ignoredProjectKeys`）。
 */
export type LayerStatus =
  | { status: 'absent' }
  | { status: 'present' }
  /** 文件存在但读不回来（非法 JSON、类型不对、或超过 `MAX_SETTINGS_BYTES`），已当成「这一层没有配置」 */
  | { status: 'corrupt'; reason: string }

/** `loadSettings` 的附带账单。与 Rust `settings::SettingsReport` 对应 */
export interface SettingsReport {
  userLayer: LayerStatus
  projectLayer: LayerStatus
  /**
   * 项目层试图写「仅全局」的偏好键、因而被忽略的键名（wire 名，可直接引用）。
   * v1 里六个键全是偏好类，所以项目层写的任何键都会落在这里。
   */
  ignoredProjectKeys: string[]
}

/** `loadSettings` 的返回值：合并好的配置 + 那份账单。与 Rust `settings::LoadedSettings` 对应 */
export interface LoadedSettings {
  settings: Settings
  report: SettingsReport
}

/** `saveSettings` 的结果。与 Rust `settings::SaveReport` 对应 */
export interface SaveReport {
  bytesWritten: number
}

/**
 * 两个 settings command 的错误集合。
 *
 * ⚠️ 它**当前**与 Rust 的 `WriteError`（`./fs.ts` 也镜像了它）逐字相同——因为两个 command
 * 返回的就是 `WriteError`。但刻意**不共用** `./fs.ts` 的类型与 `describeFsError`，理由与
 * `./session.ts` 不共用 fs 守卫相同：两边的错误集合会各自演化（settings 将来可能加一个
 * `corrupt` 变体），共用一个 `switch` 等于把 kind 清单混成一团，穷举性检查也就没了。
 */
export type SettingsError = { kind: 'io'; reason: string; message: string } | { kind: 'no_parent'; path: string }

/**
 * `invoke` 的 reject 值是 `unknown`：Tauri 把 Rust 的 `Err` 序列化后原样抛出。
 * 与 `./fs.ts` 的 `isFsError` 同形，但不共用（理由见 `SettingsError`）。
 */
function isSettingsError(value: unknown): value is SettingsError {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

export function describeSettingsError(err: unknown): string {
  if (!isSettingsError(err)) return err instanceof Error ? err.message : String(err)
  switch (err.kind) {
    case 'no_parent':
      return `${err.path} 没有目录部分，无法确定临时文件位置`
    case 'io':
      return err.message
    default:
      return String(err)
  }
}

/**
 * 读回合并好的分层配置（内置默认 → 用户全局 → 项目级）。
 *
 * `roots` 是当前工作区的根清单，Rust 侧**只取第一个**推项目层路径（多根裁定见 PLAN §3.6
 * 「M4-A 实施修正」）；空清单 = 没打开文件夹，项目层为 `absent`。
 *
 * ⚠️ 这个 command **几乎不 reject**：任何一层配置坏掉都退化成默认值并记进 `report`，
 * 配置永远不该拦下启动。唯一的 reject 来自 Rust 侧算不出主目录（环境问题，不是配置问题）。
 * 所以前端拿到结果要看的是 `report` 里两层的 `status`，而不是「有没有抛错」。
 */
export function loadSettings(roots: string[]): Promise<LoadedSettings> {
  return invoke<LoadedSettings>('load_settings', { roots })
}

/**
 * 把配置写进**用户全局层**（`~/.vela/settings.json`），原子。
 *
 * 🔴 v1 只写用户全局层：六个键都是偏好类、只认全局，没有需要落到项目层的键。
 *
 * ⚠️ 参数名 `settings` 在契约里：Tauri 按名字去 payload 里取值，拼错的后果是 Rust 报
 * 「invalid args」——这一条**会**报错，不像字段名写错那样静默。
 *
 * ⚠️ **整份重写，会丢掉本版本不认识的键**（与 `saveSession` 同一条取舍）：升级珍贵、
 * 降级罕见，为一个降级场景去做读-改-写不划算，而且那样会引入两个 Vela 实例并存的写竞态。
 */
export function saveSettings(settings: Settings): Promise<SaveReport> {
  return invoke<SaveReport>('save_settings', { settings })
}
