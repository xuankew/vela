import type { EditorController } from '../editor/controller'
import {
  canonicalKeybinding,
  formatKeybinding,
  matchesKeybinding,
  parseKeybinding,
  type KeyEventLike,
  type Keybinding,
  type Platform,
} from './keybinding'

/**
 * 命令的执行上下文。
 *
 * 目前只有一个字段是刻意的：命令中心的地基价值在于「所有功能走同一个注册表」，
 * 不在于上下文有多大。等 M1-B 的文件 IO、M1-D 的分屏落地时再按需加字段——
 * 加字段是兼容的，一开始塞一堆 null 占位则会让每个 `when` 都得先想清楚它到底是哪种 null。
 */
export interface AppContext {
  /** 当前聚焦的编辑器；没有编辑器聚焦时为 null，`editor.*` 命令据此自动禁用 */
  editor: EditorController | null
}

export interface CommandDefinition {
  /** 分层命名：`editor.foldAll` / `tool.json.format` / `view.toggleSidebar` */
  id: string
  title: string
  category: string
  icon?: string
  /** 声明串，`Mod` 按平台解析。同一命令可绑多个 */
  keybinding?: string | string[]
  /** 上下文条件。返回 false 时命令在面板里置灰、执行直接 no-op */
  when?: (ctx: AppContext) => boolean
  run: (ctx: AppContext) => void | Promise<void>
}

export interface CommandInfo {
  id: string
  title: string
  category: string
  icon?: string
  enabled: boolean
  /** 展示用的快捷键标签，已按平台格式化 */
  keybindings: string[]
}

export interface KeybindingConflict {
  keybinding: string
  ids: string[]
}

export interface CommandRegistry {
  readonly platform: Platform
  /** 返回注销函数 */
  register(def: CommandDefinition): () => void
  has(id: string): boolean
  get(id: string): CommandDefinition | undefined
  /** 命令不存在时抛错；`when` 不满足时返回 false（不是错误，面板本来就会置灰） */
  execute(id: string, ctx?: AppContext): Promise<boolean>
  /** 命令面板的数据源。按 category → id 排序（id 是 ASCII，排序稳定，不受 locale 影响） */
  list(ctx?: AppContext): CommandInfo[]
  /** 按键 → 命令。没有匹配或匹配到的命令被 `when` 挡住时返回 null */
  findForKey(event: KeyEventLike, ctx?: AppContext): CommandDefinition | null
  /** 同一快捷键被多个命令声明。注册时不拦（`when` 可以让它们互斥），但要能被审查 */
  conflicts(): KeybindingConflict[]
}

export interface CommandRegistryOptions {
  platform?: Platform
  /** 取当前上下文。`execute` / `findForKey` 不传 ctx 时用它 */
  getContext: () => AppContext
}

/** 命名空间小写开头，段内允许 camelCase：`editor.foldAll` / `tool.json.format` */
const ID_RE = /^[a-z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+$/

interface Entry {
  def: CommandDefinition
  bindings: Keybinding[]
  /**
   * 注册序号，冲突时的裁决依据。
   *
   * 用显式计数器而不是 Map 的插入顺序：注销再注册会改变插入顺序的语义，
   * 而「后注册者胜」必须是可预期的——它让后面的模块能有意覆盖前面的绑定。
   */
  order: number
}

export function createCommandRegistry(options: CommandRegistryOptions): CommandRegistry {
  const platform = options.platform ?? 'macos'
  const entries = new Map<string, Entry>()
  let nextOrder = 0

  function contextFor(ctx?: AppContext): AppContext {
    return ctx ?? options.getContext()
  }

  function isEnabled(entry: Entry, ctx: AppContext): boolean {
    return entry.def.when ? entry.def.when(ctx) : true
  }

  return {
    platform,

    register(def) {
      if (!ID_RE.test(def.id)) {
        throw new Error(`命令 id "${def.id}" 不合法：必须是分层命名（小写开头，段内可 camelCase），如 editor.foldAll`)
      }
      if (entries.has(def.id)) throw new Error(`命令 id "${def.id}" 重复注册`)
      // 解析放在注册时而不是首次按键时：声明写错要立刻炸，而不是等到用户按下才发现
      const declared = def.keybinding === undefined ? [] : Array.isArray(def.keybinding) ? def.keybinding : [def.keybinding]
      const bindings = declared.map((source) => parseKeybinding(source, platform))
      entries.set(def.id, { def, bindings, order: nextOrder++ })
      return () => {
        entries.delete(def.id)
      }
    },

    has: (id) => entries.has(id),
    get: (id) => entries.get(id)?.def,

    async execute(id, ctx) {
      const entry = entries.get(id)
      if (!entry) throw new Error(`未注册的命令 "${id}"`)
      const context = contextFor(ctx)
      if (!isEnabled(entry, context)) return false
      await entry.def.run(context)
      return true
    },

    list(ctx) {
      const context = contextFor(ctx)
      return [...entries.values()]
        .map((entry) => ({
          id: entry.def.id,
          title: entry.def.title,
          category: entry.def.category,
          icon: entry.def.icon,
          enabled: isEnabled(entry, context),
          keybindings: entry.bindings.map((b) => formatKeybinding(b, platform)),
        }))
        .sort((a, b) => (a.category === b.category ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.category < b.category ? -1 : 1))
    },

    findForKey(event, ctx) {
      const context = contextFor(ctx)
      let winner: Entry | null = null
      for (const entry of entries.values()) {
        if (!entry.bindings.some((b) => matchesKeybinding(event, b))) continue
        if (!isEnabled(entry, context)) continue
        if (!winner || entry.order > winner.order) winner = entry
      }
      return winner?.def ?? null
    },

    conflicts() {
      const byBinding = new Map<string, string[]>()
      for (const entry of entries.values()) {
        for (const binding of entry.bindings) {
          const key = canonicalKeybinding(binding)
          const ids = byBinding.get(key)
          if (ids) ids.push(entry.def.id)
          else byBinding.set(key, [entry.def.id])
        }
      }
      return [...byBinding.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([keybinding, ids]) => ({ keybinding, ids: [...ids].sort() }))
        .sort((a, b) => (a.keybinding < b.keybinding ? -1 : 1))
    },
  }
}
