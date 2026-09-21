/**
 * 主题注册表（PLAN.md §3.6 M4-C 主题系统，v1 的第一步）。
 *
 * 这一层只管三件事：**有哪些主题**、**把用户选的 ID 解析成一套具体的亮/暗**、
 * **把那套结果写到 DOM（`<html data-theme>`）**。颜色的具体值不在这里——它们住在
 * `styles.css` 的 `:root`（暗，兜底）与 `:root[data-theme='light']`（亮）两块里，
 * 由 CSS 级联按 `data-theme` 属性挑。这一层只负责把属性设对。
 *
 * 与 `fonts/loader.ts` 同一套「注册表 + DEFAULT + sanitize」的形状，理由也相同：
 * 配置文件（`~/.vela/settings.json`）是**不可信输入**，可能被手改成任何字符串，
 * 于是「读到不认识的 ID 回退默认」必须有一个唯一的落点——就是这里的 `sanitizeThemeId`。
 * Rust 侧把 `theme` 当**不透明串**原样往返（合法 ID 清单只有前端有，见 `settings/mod.rs`），
 * 校验全归这一层，与字号档位、字体 ID 的分派完全一致。
 *
 * ## 为什么默认是 'dark' 而不是 'system'
 *
 * 项目在 M4-C 之前一直是暗色的。默认取 `'dark'` 于是「从没存过配置的老用户升级后
 * 一个像素都不动」——与 `DEFAULT_LINE_HEIGHT` / `DEFAULT_LETTER_SPACING` 那条
 * 「默认值下渲染与这一轮之前逐像素一致」的取舍同源。`'system'` 是一个**要用户主动选**
 * 的模式，不做缺省，免得一个用浅色系统的用户升级后界面突然翻白。
 *
 * ## 'system' 的解析与订阅分开
 *
 * `resolveTheme` 把 `'system'` 就地解析成 `'light'` / `'dark'`（一次性，用于「现在该显示哪套」）；
 * `watchSystemTheme` 订阅系统偏好的**变化**（用户在 macOS 里切了深浅色，Vela 要跟着变）。
 * 两者分开是因为订阅需要一个能退订的生命周期，而那归 store 管（见 `store.ts`）。
 */

/** 用户能选的主题 ID。`'system'` 是一个**模式**而不是第三套配色，它解析成下面两个之一；
 * dracula / nord / solarized 是三套流行配色（MIT License），见 §3.6「M4-C 实施修正」 */
export type ThemeId = 'light' | 'dark' | 'system' | 'dracula' | 'nord' | 'solarized'

/** 解析之后的具体主题：没有 `'system'`，因为那已经被 `resolveTheme` 拆掉了 */
export type ResolvedTheme = 'light' | 'dark'

/** 合法 ID 清单。选择器直接列这些值，冒出一个清单外的串（手改配置）会让 select 变空白——
 * 这正是 `sanitizeThemeId` 要把它打回默认的原因。用**数组**而不是 `Record` + `in`：
 * `Array.includes` 只匹配真实元素，天然不碰原型链，于是 `"toString"` 这种串不会被当成合法 ID */
export const THEME_IDS: readonly ThemeId[] = ['light', 'dark', 'system', 'dracula', 'nord', 'solarized']

/** 内置默认主题。与 Rust `settings::DEFAULT_THEME` 同值——两边各写一份、由
 * `wire_contract.rs` 与 `theme.test.ts` 各钉一条，没有代码生成（与 `DEFAULT_FONT_SIZE` 同一套做法） */
export const DEFAULT_THEME: ThemeId = 'dark'

/** 选择器里每一项的中文标签。顺序与 `THEME_IDS` 一致 */
export const THEME_LABELS: Record<ThemeId, string> = {
  light: '亮色',
  dark: '暗色',
  system: '跟随系统',
  dracula: 'Dracula',
  nord: 'Nord',
  solarized: 'Solarized',
}

/** 探测系统深浅色用的媒体查询。`watchSystemTheme` 与 `systemTheme` 共用这一条字面量，
 * 免得两处的查询串各自漂移 */
export const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 不认识的 ID 打回默认。与 `store.ts` 的 `sanitizeFontVariant` 同一条姿势，
 * 只是这里查的是数组而不是对象（理由见 `THEME_IDS`）。
 */
export function sanitizeThemeId(id: string): ThemeId {
  return (THEME_IDS as readonly string[]).includes(id) ? (id as ThemeId) : DEFAULT_THEME
}

/**
 * 当前系统偏好解析出的具体主题。
 *
 * 没有 `matchMedia` 的环境（jsdom 的某些版本、任何非浏览器上下文）探测不到，退回 `'dark'`
 * ——与 `DEFAULT_THEME` 同值，也就是这个应用在 M4-C 之前一直是的样子。真机 WKWebView 有
 * `matchMedia`，走的是正常分支。
 */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/** 把用户选的 ID 解析成一套具体的亮/暗：`'system'` 就地探测，其余原样。
 * dracula / nord / solarized 都是暗色主题，所以也映射到 `'dark'`（用于 CM6 darkTheme facet） */
export function resolveTheme(id: ThemeId): ResolvedTheme {
  if (id === 'system') return systemTheme()
  // dracula/nord/solarized 都是暗色主题
  if (id === 'dracula' || id === 'nord' || id === 'solarized') return 'dark'
  return id
}

/** 这套主题是不是暗色。CM6 的 `EditorView.darkTheme` facet 要的就是这个布尔 */
export function isDarkTheme(id: ThemeId): boolean {
  return resolveTheme(id) === 'dark'
}

/**
 * 把解析好的具体主题写到 `<html data-theme>`，CSS 级联据此挑那块颜色 token。
 *
 * 收的是 `ResolvedTheme` 而不是 `ThemeId`：`data-theme` 只有 'light' / 'dark' 两个合法值，
 * `'system'` 必须先经 `resolveTheme` 拆掉。让类型来挡「把 'system' 直接写进属性」这个错，
 * 比在函数体里再判断一次更省事。
 */
export function applyThemeAttr(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
}

/**
 * 订阅系统深浅色的变化。返回一个退订函数。
 *
 * 只有 `'system'` 模式需要它：用户在 macOS 里把外观从深切到浅，Vela 要跟着翻。
 * store 在 theme === 'system' 时挂上、切走或卸载时退订（见 `store.ts`）。
 *
 * ⚠️ 探测不到 `matchMedia` 或其 `addEventListener` 时返回一个**空退订**，不抛错：
 * 「跟随系统」在缺失环境下就退化成「保持当前解析结果」，不值得为它拦下启动。
 */
export function watchSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mql = window.matchMedia(DARK_QUERY)
  if (typeof mql.addEventListener !== 'function') return () => {}
  const handler = (): void => onChange(mql.matches ? 'dark' : 'light')
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
