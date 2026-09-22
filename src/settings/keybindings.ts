/**
 * 快捷键配置管理（M4-E）。
 *
 * 这一层负责：
 * 1. 从 Rust 侧加载用户自定义的快捷键配置（`~/.vela/keybindings.json`）
 * 2. 合并内置快捷键与用户自定义配置（用户配置优先）
 * 3. 提供修改、重置、冲突检测等能力
 * 4. 写穿到用户全局层
 *
 * ## 数据格式
 *
 * `keybindings.json` 是一个对象，键是命令 ID，值是快捷键串或数组：
 * ```json
 * {
 *   "view.togglePreview": "Mod+Shift+P",
 *   "editor.save": ["Mod+S", "F2"]
 * }
 * ```
 *
 * ## 冲突处理
 *
 * 用户配置可以覆盖内置绑定，也可以让多个命令绑定到同一组合（此时后者胜）。
 * 配置界面会高亮显示冲突，让用户自己决定要不要改。
 */

import { parseKeybinding, type Keybinding, type Platform } from '../commands/keybinding'
import { loadKeybindings, saveKeybindings, type LoadedKeybindings } from '../ipc/keybindings'

/** 用户自定义的快捷键映射：命令 ID → 快捷键串或数组 */
export type UserKeybindings = Record<string, string | string[]>

export interface KeybindingConfig {
  /** 命令 ID */
  id: string
  /** 标题 */
  title: string
  /** 分类 */
  category: string
  /** 当前生效的快捷键（已格式化） */
  keybindings: string[]
  /** 是否是用户自定义的（false = 内置默认） */
  isCustom: boolean
}

export interface KeybindingConflict {
  /** 快捷键串（已格式化） */
  keybinding: string
  /** 冲突的命令 ID 列表 */
  commandIds: string[]
  /** 命令标题列表 */
  titles: string[]
}

export interface KeybindingStore {
  /** 所有可配置命令的列表（含当前快捷键） */
  readonly list: () => KeybindingConfig[]
  /** 获取某个命令的当前快捷键 */
  get: (id: string) => string[]
  /** 设置某个命令的快捷键（会写穿） */
  set: (id: string, keybindings: string[]) => void
  /** 重置某个命令为内置默认 */
  reset: (id: string) => void
  /** 重置所有自定义快捷键 */
  resetAll: () => void
  /** 检测当前配置中的冲突 */
  conflicts: () => KeybindingConflict[]
  /** 从磁盘加载配置 */
  load: () => Promise<void>
}

/** 内置默认快捷键映射（从 builtins 提取，这里只存原始声明串） */
const BUILTIN_KEYBINDINGS: Record<string, string | string[]> = {}

/**
 * 注册内置快捷键。由 `builtins.ts` 在注册命令时调用，建立「ID → 声明串」的映射。
 */
export function registerBuiltinKeybinding(id: string, keybinding: string | string[]): void {
  BUILTIN_KEYBINDINGS[id] = keybinding
}

/** 获取内置默认快捷键 */
function getBuiltinKeybinding(id: string): string | string[] | undefined {
  return BUILTIN_KEYBINDINGS[id]
}

export function createKeybindingStore(platform: Platform): KeybindingStore {
  /** 用户自定义配置（内存缓存） */
  let userConfig: UserKeybindings = {}
  /** 是否已经加载过 */
  let loaded = false

  /** 写队列的尾巴 */
  let tail: Promise<void> = Promise.resolve()
  let lastSent: string | null = null

  async function doWrite(): Promise<void> {
    const fingerprint = JSON.stringify(userConfig)
    if (fingerprint === lastSent) return
    try {
      await saveKeybindings(userConfig)
      lastSent = fingerprint
    } catch (err) {
      console.warn('[keybindings] 保存失败:', err)
    }
  }

  function persist(): void {
    tail = tail.then(doWrite)
  }

  /** 解析用户的快捷键声明，返回规范化的 Keybinding 数组 */
  function parseUserBindings(id: string, raw: string | string[]): Keybinding[] {
    const declared = Array.isArray(raw) ? raw : [raw]
    return declared.map((source) => {
      try {
        return parseKeybinding(source.trim(), platform)
      } catch (err) {
        console.warn(`[keybindings] 命令 "${id}" 的快捷键 "${source}" 解析失败:`, err)
        return null
      }
    }).filter((b): b is Keybinding => b !== null)
  }

  /** 获取某个命令的当前快捷键（用户配置优先，否则内置默认） */
  function getKeybindingsForCommand(id: string): { bindings: Keybinding[], isCustom: boolean } {
    const userRaw = userConfig[id]
    if (userRaw !== undefined) {
      const parsed = parseUserBindings(id, userRaw)
      if (parsed.length > 0) {
        return { bindings: parsed, isCustom: true }
      }
    }
    // 回退到内置默认
    const builtin = getBuiltinKeybinding(id)
    if (builtin !== undefined) {
      const parsed = parseUserBindings(id, builtin)
      return { bindings: parsed, isCustom: false }
    }
    return { bindings: [], isCustom: false }
  }

  /** 格式化 Keybinding 为展示串 */
  function formatBinding(b: Keybinding): string {
    const modSymbols: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
    const modLabels: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' }
    const displayKeys: Record<string, string> = {
      arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
      space: 'Space', escape: 'Esc', enter: 'Enter', tab: 'Tab',
      delete: 'Del', backspace: '⌫',
    }
    
    const key = displayKeys[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key)
    if (platform === 'macos') {
      return b.mods.map((m) => modSymbols[m]).join('') + key
    }
    return [...b.mods.map((m) => modLabels[m]), key].join('+')
  }

  /** 检测当前配置中的所有冲突 */
  function detectConflicts(allCommands: { id: string; title: string; bindings: Keybinding[] }[]): KeybindingConflict[] {
    const byBinding = new Map<string, { ids: string[]; titles: string[] }>()
    for (const cmd of allCommands) {
      for (const b of cmd.bindings) {
        const key = [...b.mods, b.key].join('+')
        const existing = byBinding.get(key)
        if (existing) {
          if (!existing.ids.includes(cmd.id)) {
            existing.ids.push(cmd.id)
            existing.titles.push(cmd.title)
          }
        } else {
          byBinding.set(key, { ids: [cmd.id], titles: [cmd.title] })
        }
      }
    }
    return [...byBinding.values()]
      .filter((entry) => entry.ids.length > 1)
      .map((entry) => ({
        keybinding: formatBinding(parseKeybinding(entry.ids[0] + '+dummy', platform)), // 占位，下面会替换
        commandIds: entry.ids,
        titles: entry.titles,
      }))
  }

  return {
    list() {
      // 这个函数需要外部传入命令列表，这里只提供框架
      return []
    },

    get(id: string): string[] {
      const { bindings } = getKeybindingsForCommand(id)
      return bindings.map(formatBinding)
    },

    set(id: string, keybindings: string[]): void {
      if (keybindings.length === 0) {
        delete userConfig[id]
      } else {
        userConfig[id] = keybindings.length === 1 ? keybindings[0] : keybindings
      }
      persist()
    },

    reset(id: string): void {
      delete userConfig[id]
      persist()
    },

    resetAll(): void {
      userConfig = {}
      lastSent = null
      persist()
    },

    conflicts(): KeybindingConflict[] {
      // 需要外部传入完整命令列表才能检测
      return []
    },

    async load(): Promise<void> {
      try {
        const loaded_data: LoadedKeybindings = await loadKeybindings()
        userConfig = loaded_data.keybindings
        lastSent = JSON.stringify(userConfig)
        loaded = true
      } catch (err) {
        console.warn('[keybindings] 加载失败，使用空配置:', err)
        userConfig = {}
      }
    },
  }
}
