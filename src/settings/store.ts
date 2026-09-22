/**
 * 字体 / 字号这一层的**持久化状态**（PLAN.md §3.6 M4-A）。
 *
 * 在 M4-A 之前，`fontKey` / `codeFontKey` / `fontSize` 是 `App.tsx` 里三个**只活在内存里**
 * 的信号：调好字号、重启就回到 14px。这一层把它们接到 `vela-core::settings` 的三层配置上，
 * 于是「我设的字号」跟着人走（用户全局层 `~/.vela/settings.json`），换项目也在。
 * M4-B 又加进来两个偏好——**行高**与**字间距**（收进「外观」浮层的那个步进器），
 * 五个值走完全相同的一条路：sanitize → 灌信号 → 应用 CSS 变量 → 写穿用户全局层。
 *
 * ## 这一层管什么、不管什么
 *
 * 管：五个值的**当前状态**、把它们应用到 DOM（CSS 变量 + 注入 webfont）、以及写穿到
 * 用户全局层。还管「从 Rust 读回来的值不一定合法」这件事——配置文件可能被手改成任何
 * 字符串，`fontSize` 可能是 17 这种档外值，`fontVariant` 可能是一个不存在的 ID，
 * `lineHeight` 可能是一个区间外的数或 NaN。**sanitize 归这一层**：读到不认识的字体 ID
 * 回退注册表默认，读到档外字号回退默认档位，读到区间外的行高/字间距夹回区间。
 * （Rust 侧刻意不夹范围、不校验 ID，理由见 `ipc/settings.ts` 的 `Settings` 文档：
 * 合法 ID 清单、档位与区间都是 UI 概念，夹一次就够，夹两次的结果是谁也说不清最终是多少。）
 *
 * 不管：字体注册表本身（`fonts/loader.ts`）、字号档位清单的**语义**（这里只负责夹）。
 *
 * ## 🔴 项目层在 v1 是「接好线但空转」的
 *
 * 五个键全是**个人偏好**，只认「内置默认 + 用户全局」。打开一个带 `.vela/settings.json`
 * 的仓库**不会**改掉你的字号——Rust 的 `resolve` 已经把项目层的偏好键丢进
 * `report.ignoredProjectKeys` 了。这一层把那份 `report` 原样暴露出去（[`SettingsStore.report`]），
 * 由 `App.tsx` 决定要不要据此说一句「这个仓库想改你的字号，但字号只认全局」。
 * ⚠️ 于是 `load` 在 roots 变化时**仍然要重跑**：v1 里合并出的配置不随 roots 变（项目层
 * 不生效），但那份**账单**会变——换一个仓库，它想覆盖的键可能不一样。
 *
 * ## 写穿用一条队列，不用定时器
 *
 * 与 `doc/sessionSync.ts` 同一套做法：所有写挂在一条 promise 链尾巴上，任意时刻最多一个
 * 写在飞，于是「快速连按 `Cmd+=`」不会让两次原子写以乱序 rename 收场（那样盘上可能停在
 * 中间某一档）。再加一个指纹跳过没变化的写。⛔ 不用 `vi.useFakeTimers()`——理由与
 * sessionSync 逐字相同：假表会把 `requestAnimationFrame` 一起冻住，而 CM6 跑在 rAF 上。
 * 这里压根没有定时器，所以那条顾虑不适用，但队列本身是需要的（为了写序）。
 */

import { createSignal, type Accessor } from 'solid-js'
import {
  applyCodeFont,
  applyFontVariant,
  CODE_FONTS,
  DEFAULT_CODE_FONT,
  DEFAULT_VARIANT,
  FONT_VARIANTS,
  type CodeFontId,
  type FontVariantId,
} from '../fonts/loader'
import {
  describeSettingsError,
  loadSettings,
  saveSettings,
  type LoadedSettings,
  type Settings,
  type SettingsReport,
} from '../ipc/settings'
import { applyThemeAttr, DEFAULT_THEME, resolveTheme, sanitizeThemeId, watchSystemTheme, type ThemeId } from './theme'

/**
 * 字号档位。工具栏的 select 直接列这些值，所以冒出一个档外值（17px）会让 select 变空白——
 * 这正是 sanitize 要把档外值打回默认的原因。
 *
 * ⚠️ 这是**纯 UI 概念**，Rust 侧不知道它存在（`Settings.fontSize` 是个裸 `u32`）。
 * 从 `App.tsx` 挪到这一层，是因为夹档位是 sanitize 的一部分，而 sanitize 归这一层。
 */
export const FONT_SIZES: readonly number[] = [12, 13, 14, 15, 16, 18, 20]

/**
 * 内置默认字号。与 Rust `settings::DEFAULT_FONT_SIZE` 同值——两边各写一份、由
 * `wire_contract.rs` 与 `ipc/settings.test.ts` / 本层的 `store.test.ts` 各钉一条，
 * 没有代码生成（与 `MAX_SESSION_TABS` 同一套做法）。
 */
export const DEFAULT_FONT_SIZE = 14

/** 档外字号一律打回默认。`FONT_SIZES` 里没有的值（17、0、负数、NaN）都不该进信号 */
function sanitizeFontSize(n: number): number {
  return FONT_SIZES.includes(n) ? n : DEFAULT_FONT_SIZE
}

/**
 * Cmd+滚轮无级缩放的上下限。比预设档位宽得多，但仍有边界防止失控。
 * 下限 8px 是「勉强可读」的底线，上限 72px 是「标题级别」的极限。
 */
export const ZOOMED_FONT_SIZE_MIN = 8
export const ZOOMED_FONT_SIZE_MAX = 72
export const ZOOMED_FONT_SIZE_STEP = 1

/**
 * 不认识的字体 ID 打回注册表默认。
 *
 * ⚠️ 用 `hasOwnProperty` 而不是 `in`：`in` 会命中原型链，于是 `"toString"` 这种字符串
 * 会被当成合法 ID。配置文件是**不可信输入**（可能被手改、可能来自克隆的仓库），
 * 这类「看起来是键、其实是 Object.prototype 上的东西」正是它该挡的。
 */
function sanitizeFontVariant(id: string): FontVariantId {
  return Object.prototype.hasOwnProperty.call(FONT_VARIANTS, id) ? (id as FontVariantId) : DEFAULT_VARIANT
}

function sanitizeCodeFont(id: string): CodeFontId {
  return Object.prototype.hasOwnProperty.call(CODE_FONTS, id) ? (id as CodeFontId) : DEFAULT_CODE_FONT
}

/**
 * 行高（无单位倍数）的区间、步进与默认值。M4-B 加的，收进「外观」浮层里那个步进器。
 *
 * ⚠️ 与字号档位（`FONT_SIZES`）不同，行高是**连续**的：步进器每次走 `LINE_HEIGHT_STEP`，
 * 但手改配置读进来的值不必落在步进的整数倍上，只要在区间内就照用（sanitize 只夹 + 归一化
 * 到两位小数，不打回默认）。默认 `1.75` 与 Rust `settings::DEFAULT_LINE_HEIGHT` 同值、
 * 也与 `styles.css` 里 `--vela-line-height` 的初值同值——两边各写一份、各钉一条。
 */
export const LINE_HEIGHT_MIN = 1.0
export const LINE_HEIGHT_MAX = 3.0
export const LINE_HEIGHT_STEP = 0.05
export const DEFAULT_LINE_HEIGHT = 1.75

/**
 * 字间距（em）的区间、步进与默认值。默认 `0` = CSS `letter-spacing: normal`。
 *
 * ⚠️ 区间含负值（`-0.05`）：让字挤一点是合法需求。上限 `0.5em` 是「散排标题」那一档，
 * 再大就没意义了。与 Rust `settings::DEFAULT_LETTER_SPACING` 同值。
 */
export const LETTER_SPACING_MIN = -0.05
export const LETTER_SPACING_MAX = 0.5
export const LETTER_SPACING_STEP = 0.01
export const DEFAULT_LETTER_SPACING = 0

/**
 * 连续型偏好（行高 / 字间距）的 sanitize：非有限数打回默认，其余夹进区间 + 归一化到两位小数。
 *
 * 🔴 归一化那一步是**必需的**，不是美化：步进是浮点加法，`1.75 + 0.05` 在 IEEE-754 下是
 * `1.8000000000000003`。不归一化的话这个尾巴会（a）显示在步进器上、（b）存进配置文件、
 * （c）让写队列的指纹比较永远判「变了」（每次步进都产生一个新尾巴），白白多写盘。
 * 两位小数足够：行高步进 0.05、字间距步进 0.01，都比它细不了。
 */
function sanitizeStepper(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100
}

function sanitizeLineHeight(n: number): number {
  return sanitizeStepper(n, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_LINE_HEIGHT)
}

function sanitizeLetterSpacing(n: number): number {
  return sanitizeStepper(n, LETTER_SPACING_MIN, LETTER_SPACING_MAX, DEFAULT_LETTER_SPACING)
}

export interface SettingsStoreOptions {
  /**
   * 出问题时说一句话（配置读不回来、写不下去）。没注入就什么都不说。
   *
   * 与 sessionSync 的 `onWarn` 同一条理由：配置是**偏好**，读不回来最坏是「用默认字号」，
   * 不值得为它拦下启动；但「我设的没记住」这件事该让用户知道一句，而不是静默回退。
   */
  onWarn?: (text: string) => void
  /**
   * 深/浅色生效时的回调（M4-C）。`App.tsx` 注入成 `(dark) => ws.setDarkTheme(dark)`。
   *
   *  为什么是注入而不是 store 直接 import workspace：与 `pasteImage` / `promptDiscard`
   * 同一条理由——store 不该知道宿主长什么样，而且那样会成环。store 只负责「算出当前该是
   * 亮还是暗」（`resolveTheme`）与「把 `data-theme` 写进 `<html>`」（管 `--vela-*` 那套颜色）；
   * CM6 base theme 的 `&dark` facet 归 workspace 的 `setDarkTheme` 管。两件事必须一起做，
   * 少一件就会「颜色换了但光标/选区/弹层底色还是旧的」或反过来。
   *
   * 没注入（测试、首屏还没接 workspace 时）就只写 `data-theme`，CM6 那边保持缺省的暗色。
   */
  applyDark?: (dark: boolean) => void
  /**
   * 字号变化后的回调。`App.tsx` 注入成 `() => ws.notifyFontSizeChanged()`。
   *
   * 🔴 用途：Cmd+滚轮无级缩放后，CSS 变量已更新，但 CM6 的行号 gutter 需要一次 measure
   * 才能重新对齐。dispatch 一个空 transaction 就能触发 measure。
   * 没注入就不做额外操作（档位选择走 setFontSize，本身就会 persist → 下次启动一致）。
   */
  onFontSizeChange?: () => void
}

export interface SettingsStore {
  /** 当前正文字体 ID（已 sanitize，一定是注册表里的合法值） */
  readonly fontKey: Accessor<FontVariantId>
  /** 当前代码区字体 ID（已 sanitize） */
  readonly codeFontKey: Accessor<CodeFontId>
  /** 当前字号（档位选择或滚轮缩放后的实际值） */
  readonly fontSize: Accessor<number>
  /** 当前行高（无单位倍数，已夹到 `LINE_HEIGHT_MIN..=LINE_HEIGHT_MAX`、归一化到两位小数） */
  readonly lineHeight: Accessor<number>
  /** 当前字间距（em，已夹到 `LETTER_SPACING_MIN..=LETTER_SPACING_MAX`；`0` = `normal`） */
  readonly letterSpacing: Accessor<number>
  /**
   * 当前主题选择（`'light'` / `'dark'` / `'system'`，已 sanitize）。
   *
   * ⚠️ 这是**用户选的那个 ID**，不是解析后的亮/暗。选 `'system'` 时它一直是 `'system'`，
   * 实际生效的亮暗由 `resolveTheme` 现算（跟随 `prefers-color-scheme`）。外观浮层的下拉
   * 要显示的是这个 ID（「跟随系统」），不是解析结果。
   */
  readonly theme: Accessor<ThemeId>
  /**
   * 最近一次 [`SettingsStore.load`] 的账单；`null` = 还没 load 过。
   * `report().ignoredProjectKeys` 非空表示当前仓库的 `.vela/settings.json` 试图改偏好键、
   * 已被忽略（v1 里五个键全是偏好类，所以它写的任何键都会落在这儿）。
   */
  readonly report: Accessor<SettingsReport | null>

  /** 用户改了正文字体：更新 + 应用 + 写穿 */
  setFontVariant: (id: FontVariantId) => void
  /** 用户改了代码区字体：更新 + 应用 + 写穿 */
  setCodeFont: (id: CodeFontId) => void
  /** 用户选了字号（会夹到档位）：更新 + 应用 + 写穿 */
  setFontSize: (n: number) => void
  /** `Cmd/Ctrl + =/-`：在档位之间走一步。档外（被手改过）时回到默认档 */
  stepFontSize: (delta: number) => void
  /** `Cmd/Ctrl + 0`：回到默认字号 */
  resetFontSize: () => void
  /** Cmd+滚轮无级缩放：步进 +/- 1px，不写盘，只改 CSS 变量 */
  stepZoomedFontSize: (delta: number) => void
  /** 重置滚轮缩放，回到档位值 */
  resetZoomedFontSize: () => void
  /** 用户设了行高（会夹 + 归一化）：更新 + 应用 + 写穿 */
  setLineHeight: (n: number) => void
  /** 外观浮层里的行高步进器：走一步 `LINE_HEIGHT_STEP` */
  stepLineHeight: (delta: number) => void
  /** 回到默认行高 */
  resetLineHeight: () => void
  /** 用户设了字间距（会夹 + 归一化）：更新 + 应用 + 写穿 */
  setLetterSpacing: (n: number) => void
  /** 外观浮层里的字间距步进器：走一步 `LETTER_SPACING_STEP` */
  stepLetterSpacing: (delta: number) => void
  /** 回到默认字间距 */
  resetLetterSpacing: () => void
  /** 用户选了主题（亮/暗/跟随系统）：更新 + 应用（`data-theme` + CM6 深浅色）+ 写穿 */
  setTheme: (id: ThemeId) => void

  /**
   * 从 Rust 读回合并好的配置，sanitize 后灌进信号并应用。**不写穿**。
   *
   * 启动时调一次（roots 为空），之后每次工作区的根变化再调（多根只认第一个，
   * 由 Rust 侧取 `roots[0]`）。并发安全：用一个代号挡住「迟到的旧 load 盖掉新 load」。
   */
  load: (roots: readonly string[]) => Promise<void>
  /**
   * 立刻把当前信号值应用到 DOM（CSS 变量 + 注入 webfont），不等任何 IPC。
   * 首屏用：在第一次 `load` 回来之前，先让默认字体开始注入，避免一段系统字体的空窗。
   */
  applyNow: () => void
}

export function createSettingsStore(options: SettingsStoreOptions = {}): SettingsStore {
  const warn = options.onWarn ?? (() => {})

  const [fontKey, setFontKey] = createSignal<FontVariantId>(DEFAULT_VARIANT)
  const [codeFontKey, setCodeFontKey] = createSignal<CodeFontId>(DEFAULT_CODE_FONT)
  const [fontSize, setFontSizeSignal] = createSignal(DEFAULT_FONT_SIZE)
  /** Cmd+滚轮缩放后的字号（无级，不写盘）。`null` = 没缩放过，用档位值 */
  const [zoomedFontSize, setZoomedFontSizeSignal] = createSignal<number | null>(null)
  const [lineHeight, setLineHeightSignal] = createSignal(DEFAULT_LINE_HEIGHT)
  const [letterSpacing, setLetterSpacingSignal] = createSignal(DEFAULT_LETTER_SPACING)
  const [theme, setThemeSignal] = createSignal<ThemeId>(DEFAULT_THEME)
  const [report, setReport] = createSignal<SettingsReport | null>(null)

  /** 写队列的尾巴。所有写挂在它后面，于是任意时刻最多一个写在飞（见文件头） */
  let tail: Promise<void> = Promise.resolve()
  /** 上一次**成功写出去**的那份配置的指纹。没变化就跳过，省一次原子写 */
  let lastSent: string | null = null
  /** load 的代号：每次 load 自增，回来时只有「还是最新那次」才允许灌信号 */
  let loadGen = 0
  /**
   * 「跟随系统」时挂着的那个 matchMedia 订阅；`null` = 当前不是 system、没订阅。
   *
   * 只在 `theme() === 'system'` 时存在：OS 切换深浅色要实时反映到应用上。选死亮/暗时
   * 必须退订，否则一次系统主题变化会把用户**明确选的**那一档盖掉。
   */
  let unsubscribeSystem: (() => void) | null = null

  function applyFontSizeVar(n: number): void {
    document.documentElement.style.setProperty('--vela-font-size', `${n}px`)
  }

  function applyLineHeightVar(n: number): void {
    // 无单位倍数：`--vela-line-height` 被 CM6 的 fontTheme 与 `.md-preview-body` 同时消费，
    // 两边都要的是「相对字号的倍数」，写 `String(n)`（不是 `${n}px`）
    document.documentElement.style.setProperty('--vela-line-height', String(n))
  }

  function applyLetterSpacingVar(n: number): void {
    // 🔴 `0` 翻译成 `normal` 而不是 `0em`：默认值下编辑器一个像素都不该动，而 `normal`
    // 与「压根没声明 letter-spacing」是同一件事，`0em` 严格说是另一回事（`normal` 允许
    // 字体自带的字距调整）。非零才用 `em`（相对字号，跟着字号缩放）
    document.documentElement.style.setProperty('--vela-letter-spacing', n === 0 ? 'normal' : `${n}em`)
  }

  /**
   * 把当前主题选择解析成亮/暗，写到两处：`<html data-theme>`（管 `--vela-*` 那套颜色）
   * 与 CM6 的 `darkSlot`（管 base theme 的 `&dark` 规则，经注入的 `applyDark` 回调）。
   *
   * ⚠️ `data-theme` 写的是**原始 ThemeId**（light/dark/system/dracula/nord/solarized），
   * 不是解析后的 ResolvedTheme——CSS 里 `[data-theme='dracula']` 等选择器要靠这个匹配。
   * CM6 那边才用解析后的布尔值（isDark）。
   *
   * 两处必须一起更新，少一处就会「颜色换了但光标/选区/弹层底色还是旧的」或反过来。
   */
  function applyResolvedTheme(): void {
    const id = theme()
    const resolved = resolveTheme(id)
    // data-theme 用原始 ID，让 CSS 选择器能匹配到具体主题
    applyThemeAttr(id as any)
    options.applyDark?.(resolved === 'dark')
  }

  /**
   * 让 matchMedia 订阅与当前选择对齐：选 `system` 才订阅，选死亮/暗就退订。
   * 幂等——`applyNow` 与 `setTheme` 都会调它，重复调不会重复订阅。
   */
  function syncSystemWatch(): void {
    const want = theme() === 'system'
    if (want && unsubscribeSystem === null) {
      // OS 切换深浅色时重算并重应用。只动 DOM 与 CM6，不写穿——这不是用户改动。
      // 这个回调是 matchMedia 的 change 事件处理器（不是响应式追踪范围）：事件触发时现读
      // 一次 theme() 的当前值正是我们要的，不需要它随信号自动重跑
      // eslint-disable-next-line solid/reactivity
      unsubscribeSystem = watchSystemTheme(() => applyResolvedTheme())
    } else if (!want && unsubscribeSystem !== null) {
      unsubscribeSystem()
      unsubscribeSystem = null
    }
  }

  function currentSettings(): Settings {
    return {
      fontSize: fontSize(),
      fontVariant: fontKey(),
      codeFont: codeFontKey(),
      lineHeight: lineHeight(),
      letterSpacing: letterSpacing(),
      theme: theme(),
    }
  }

  async function doWrite(): Promise<void> {
    const settings = currentSettings()
    const fingerprint = JSON.stringify(settings)
    if (fingerprint === lastSent) return
    try {
      await saveSettings(settings)
      // 只在**成功**之后更新指纹：一次瞬时故障不该把这轮改动永久跳过（与 sessionSync 同）
      lastSent = fingerprint
    } catch (err) {
      warn(describeSettingsError(err))
    }
  }

  function persist(): void {
    // doWrite 自己吞掉了所有异常，于是 tail 永远不会 reject，不需要 catch 兜底
    tail = tail.then(doWrite)
  }

  function applyNow(): void {
    applyFontSizeVar(fontSize())
    applyLineHeightVar(lineHeight())
    applyLetterSpacingVar(letterSpacing())
    applyResolvedTheme()
    // 「跟随系统」要把 matchMedia 订阅挂上；选死亮/暗时这一步是 no-op（幂等）
    syncSystemWatch()
    // 字体是动态 import，注入有真实异步成本；`void` 掉——首屏不等它，到达后浏览器自己
    // 用 font-display: swap 重排。两个 family 同时驻留（正文 + 代码区），互不干扰
    void applyFontVariant(fontKey())
    void applyCodeFont(codeFontKey())
  }

  async function load(roots: readonly string[]): Promise<void> {
    const gen = ++loadGen
    let loaded: LoadedSettings
    try {
      // `loadSettings` 几乎不 reject（任何一层坏掉都退化成默认并记进账单）；唯一的 reject
      // 是 Rust 侧算不出主目录——环境问题。退化成「保持当前值」，不拦启动
      loaded = await loadSettings([...roots])
    } catch (err) {
      warn(describeSettingsError(err))
      return
    }
    // 迟到的旧 load 不许盖掉新的：roots 快速连变时会有多个 load 在飞
    if (gen !== loadGen) return

    const s = loaded.settings
    // 直接写信号（不走 mutator）：load 是「把盘上的值装回来」，不是用户改动，**不该写穿**
    setFontSizeSignal(sanitizeFontSize(s.fontSize))
    setFontKey(sanitizeFontVariant(s.fontVariant))
    setCodeFontKey(sanitizeCodeFont(s.codeFont))
    setLineHeightSignal(sanitizeLineHeight(s.lineHeight))
    setLetterSpacingSignal(sanitizeLetterSpacing(s.letterSpacing))
    setThemeSignal(sanitizeThemeId(s.theme))
    setReport(loaded.report)
    applyNow()
  }

  // ⚠️ 这些 mutator 都是**具名函数**而不是对象字面量里的方法：`App.tsx` 会把它们当裸引用
  // 递出去（`adjustFontSize: settings.stepFontSize`），方法里的 `this` 在那种调用下是
  // undefined。互相调用一律走这些局部函数，不碰 `this`
  function setFontVariant(id: FontVariantId): void {
    setFontKey(id)
    void applyFontVariant(id)
    persist()
  }

  function setCodeFont(id: CodeFontId): void {
    setCodeFontKey(id)
    void applyCodeFont(id)
    persist()
  }

  function setFontSize(n: number): void {
    const clamped = sanitizeFontSize(n)
    setFontSizeSignal(clamped)
    // 用户手动选档位时，清除滚轮缩放状态，避免下次打开对话框时 effectiveFontSize 返回旧值
    setZoomedFontSizeSignal(null)
    applyFontSizeVar(clamped)
    persist()
  }

  function stepFontSize(delta: number): void {
    // ⚠️ 必须读原始的 fontSize 信号，而不是 effectiveFontSize()：
    // 如果用户之前用过滚轮缩放，effectiveFontSize() 会返回缩放值（不在 FONT_SIZES 里），
    // 导致 indexOf 永远返回 -1，步进器从默认档起步而不是从当前档
    const index = FONT_SIZES.indexOf(fontSize())
    // 档外（被手改过、或还没 sanitize）时回到默认档，而不是从 -1 起步
    const next =
      index < 0 ? DEFAULT_FONT_SIZE : FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, index + delta))]!
    // next 一定是合法档位，走 setFontSize 会再 sanitize 一次（无副作用），顺带写穿并清除缩放状态
    setFontSize(next)
  }

  function resetFontSize(): void {
    setFontSize(DEFAULT_FONT_SIZE)
  }

  function setLineHeight(n: number): void {
    const clamped = sanitizeLineHeight(n)
    setLineHeightSignal(clamped)
    applyLineHeightVar(clamped)
    persist()
  }

  function stepLineHeight(delta: number): void {
    // 从当前值起步（不是从默认）：连续量没有「档」，每次走一个 STEP，再由 sanitize 夹 + 归一化
    setLineHeight(lineHeight() + delta * LINE_HEIGHT_STEP)
  }

  function resetLineHeight(): void {
    setLineHeight(DEFAULT_LINE_HEIGHT)
  }

  function setLetterSpacing(n: number): void {
    const clamped = sanitizeLetterSpacing(n)
    setLetterSpacingSignal(clamped)
    applyLetterSpacingVar(clamped)
    persist()
  }

  function stepLetterSpacing(delta: number): void {
    setLetterSpacing(letterSpacing() + delta * LETTER_SPACING_STEP)
  }

  function resetLetterSpacing(): void {
    setLetterSpacing(DEFAULT_LETTER_SPACING)
  }

  function setTheme(id: ThemeId): void {
    const next = sanitizeThemeId(id)
    setThemeSignal(next)
    applyResolvedTheme()
    // 选死亮/暗要退订 matchMedia，选 system 要挂上：否则系统主题变化会盖掉用户明确选的那一档
    syncSystemWatch()
    persist()
  }

  /** Cmd+滚轮无级缩放：步进 +/- 1px，不写盘，只改 CSS 变量 */
  function stepZoomedFontSize(delta: number): void {
    const base = zoomedFontSize() ?? fontSize()
    const next = Math.min(ZOOMED_FONT_SIZE_MAX, Math.max(ZOOMED_FONT_SIZE_MIN, base + delta))
    setZoomedFontSizeSignal(next)
    applyFontSizeVar(next)
    options.onFontSizeChange?.()
  }

  /** 重置滚轮缩放，回到档位值 */
  function resetZoomedFontSize(): void {
    setZoomedFontSizeSignal(null)
    applyFontSizeVar(fontSize())
    options.onFontSizeChange?.()
  }

  /**
   * 实际字号的 accessor：优先返回缩放值（如果有），否则返回档位值。
   * 这样外观浮层的下拉菜单仍然显示档位值，但编辑器用的是缩放后的值。
   */
  const effectiveFontSize = (): number => zoomedFontSize() ?? fontSize()

  return {
    fontKey,
    codeFontKey,
    fontSize: effectiveFontSize,
    lineHeight,
    letterSpacing,
    theme,
    report,
    setFontVariant,
    setCodeFont,
    setFontSize,
    stepFontSize,
    resetFontSize,
    stepZoomedFontSize,
    resetZoomedFontSize,
    setLineHeight,
    stepLineHeight,
    resetLineHeight,
    setLetterSpacing,
    stepLetterSpacing,
    resetLetterSpacing,
    setTheme,
    load,
    applyNow,
  }
}
