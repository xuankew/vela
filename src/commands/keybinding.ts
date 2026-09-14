/**
 * 快捷键声明的解析、规范化与匹配。
 *
 * 平台差异只在这一层消化：声明里写 `Mod` 这个可移植修饰键，macOS 解析成 Cmd、
 * 其余平台解析成 Ctrl，命令定义就不用为每个平台各写一份。
 */

export type Platform = 'macos' | 'windows' | 'linux'

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta'

/**
 * 结构化按键事件。
 *
 * 刻意不直接收 `KeyboardEvent`：单测跑在 node 环境里没有 DOM，
 * 而匹配逻辑只需要这五个字段。真实的 `KeyboardEvent` 结构上兼容它。
 */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export interface Keybinding {
  /** 规范化后的修饰键，固定顺序 ctrl → alt → shift → meta */
  mods: readonly Modifier[]
  /** 规范化后的主键，全小写 */
  key: string
  /** 原始声明串，用于报错信息与展示 */
  source: string
}

const MOD_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta']

const MOD_ALIASES: Record<string, Modifier | 'mod'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
  windows: 'meta',
  mod: 'mod',
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  ' ': 'space',
  space: 'space',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  return: 'enter',
  enter: 'enter',
  tab: 'tab',
  del: 'delete',
  delete: 'delete',
  backspace: 'backspace',
  pageup: 'pageup',
  pagedown: 'pagedown',
  home: 'home',
  end: 'end',
  insert: 'insert',
  plus: '+',
  minus: '-',
  equals: '=',
}

/** 单独按下也允许绑定的键。其余无修饰键的绑定一律拒绝，见 parseKeybinding */
const BARE_KEY_RE = /^(escape|f([1-9]|1[0-9]|2[0-4]))$/

const PURE_MODIFIER_KEYS = new Set(['control', 'alt', 'shift', 'meta', 'capslock', 'fn'])

export function detectPlatform(): Platform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'macos'
  if (/Win/.test(ua)) return 'windows'
  return 'linux'
}

/**
 * 把声明串解析成规范化的 Keybinding。
 *
 * 两条刻意收紧的规则：
 * 1. **无修饰键的绑定只允许 `Escape` 与 `F1~F24`。** 允许裸字母意味着一处笔误
 *    （`'p'` 而不是 `'Mod+p'`）就会吞掉用户在编辑器里的正常输入，而且极难察觉。
 * 2. **不支持绑定字面量 `+` 键。** `'Mod++'` 按 `+` 切分会得到空 token，
 *    歧义无法消解；要绑加号用 `'Mod+='`（配合 Shift 即 `+`）。
 */
export function parseKeybinding(source: string, platform: Platform): Keybinding {
  const tokens = source.trim().split('+')
  const keyToken = tokens[tokens.length - 1]!.trim()
  const key = normalizeKey(keyToken, source)

  const mods = new Set<Modifier>()
  for (const token of tokens.slice(0, -1)) {
    const alias = MOD_ALIASES[token.trim().toLowerCase()]
    if (!alias) throw new Error(`快捷键 "${source}" 含未知修饰键 "${token}"`)
    mods.add(alias === 'mod' ? (platform === 'macos' ? 'meta' : 'ctrl') : alias)
  }
  if (mods.size === 0 && !BARE_KEY_RE.test(key)) {
    throw new Error(`快捷键 "${source}" 缺少修饰键（只有 Escape 与 F1~F24 允许单独绑定）`)
  }

  return { mods: MOD_ORDER.filter((m) => mods.has(m)), key, source }
}

function normalizeKey(token: string, source: string): string {
  if (token === '') throw new Error(`快捷键 "${source}" 缺少主键`)
  const lower = token.toLowerCase()
  const mapped = KEY_ALIASES[lower]
  if (mapped !== undefined) return mapped
  if (lower.length === 1) return lower
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower
  throw new Error(`快捷键 "${source}" 含无法识别的主键 "${token}"`)
}

/** 规范化串，冲突检测的键。同一组合的不同写法（`Cmd+P` / `Mod+P`）会收敛到同一个串 */
export function canonicalKeybinding(binding: Keybinding): string {
  return [...binding.mods, binding.key].join('+')
}

/**
 * 从事件里取出规范化主键；纯修饰键按下（还没按主键）返回 null。
 *
 * `event.key` 已经是「按下 Shift 后的大写字母」，所以单字符一律转小写：
 * `Shift+P` 的 `event.key` 是 `'P'`，规范化成 `'p'`，与声明里的 `'Mod+Shift+P'` 对齐。
 */
export function keyFromEvent(event: KeyEventLike): string | null {
  const raw = event.key
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (PURE_MODIFIER_KEYS.has(lower)) return null
  if (raw === ' ') return 'space'
  if (raw.length === 1) return lower
  return KEY_ALIASES[lower] ?? lower
}

export function matchesKeybinding(event: KeyEventLike, binding: Keybinding): boolean {
  const key = keyFromEvent(event)
  if (key !== binding.key) return false
  return (
    event.ctrlKey === binding.mods.includes('ctrl') &&
    event.altKey === binding.mods.includes('alt') &&
    event.shiftKey === binding.mods.includes('shift') &&
    event.metaKey === binding.mods.includes('meta')
  )
}

const MAC_SYMBOLS: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
const OTHER_LABELS: Record<Modifier, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Win',
}

const DISPLAY_KEYS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  space: 'Space',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  delete: 'Del',
  backspace: '⌫',
}

/** 展示用。macOS 出符号（⌘⇧P），其余平台出文字（Ctrl+Shift+P） */
export function formatKeybinding(binding: Keybinding, platform: Platform): string {
  const key = DISPLAY_KEYS[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  if (platform === 'macos') return binding.mods.map((m) => MAC_SYMBOLS[m]).join('') + key
  return [...binding.mods.map((m) => OTHER_LABELS[m]), key].join('+')
}
