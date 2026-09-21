/**
 * vela.* 桥对象 v1.0.0 的类型定义（M5 插件接口收敛）。
 *
 * 这一层不暴露 Tauri 的 `invoke` 原语，也不暴露 Rust 的错误类型。
 * 所有 IPC 调用包装成 Promise，错误统一成 `{ code, message }`。
 */

// ─── 编辑器核心 ───────────────────────────────────────────────

export type EditorHandle = number

export interface EditorAPI {
  getActive(): EditorHandle | null
  getText(handle: EditorHandle): string
  setText(handle: EditorHandle, text: string): void
  replaceSelection(handle: EditorHandle, text: string): void
  onDidChange(handle: EditorHandle, cb: () => void): () => void
}

// ─── 工作区与文件系统 ─────────────────────────────────────────

export type EntryKind = 'file' | 'dir'

export interface DirEntry {
  name: string
  path: string
  kind: EntryKind
  size?: number
  modified?: number
}

export interface DirListing {
  root: string
  rel: string
  entries: DirEntry[]
}

export type FileFormat = 'lf' | 'crlf' | 'cr'

export interface StoredImage {
  path: string
}

export interface WorkspaceAPI {
  getRoots(): string[]
  readFile(path: string, encoding?: string): Promise<string>
  writeFile(path: string, text: string, format?: FileFormat): Promise<void>
  storeImage(docPath: string, base64: string): Promise<StoredImage>
  onFileChange(cb: (path: string) => void): () => void

  // 项目树操作
  listDir(root: string, rel: string): Promise<DirListing>
  createEntry(root: string, rel: string, kind: EntryKind): Promise<DirEntry>
  renameEntry(root: string, rel: string, newName: string): Promise<DirEntry>
  trashEntry(root: string, rel: string): Promise<void>
  revealInFinder(root: string, rel: string): Promise<void>
  copyPath(root: string, rel: string): Promise<void>
}

// ─── 搜索 ─────────────────────────────────────────────────────

export interface SearchQuery {
  roots: string[]
  pattern: string
  caseSensitive?: boolean
  wholeWord?: boolean
  isRegex?: boolean
  include?: string[]
  exclude?: string[]
}

export interface SearchResult {
  path: string
  line: number
  column: number
  match: string
  contextBefore?: string[]
  contextAfter?: string[]
}

export type SearchTaskId = string

export interface SearchAPI {
  start(query: SearchQuery): Promise<SearchTaskId>
  cancel(taskId: SearchTaskId): void
  onResult(taskId: SearchTaskId, cb: (result: SearchResult) => void): () => void
}

// ─── 替换 ─────────────────────────────────────────────────────

export interface ReplaceQuery extends SearchQuery {
  replacement: string
  preserveCase?: boolean
}

export interface ReplaceProgress {
  total: number
  processed: number
  replaced: number
  skipped: number
  errors: number
}

export type ReplaceTaskId = string

export interface ReplaceAPI {
  start(query: ReplaceQuery): Promise<ReplaceTaskId>
  cancel(taskId: ReplaceTaskId): void
  onProgress(taskId: ReplaceTaskId, cb: (progress: ReplaceProgress) => void): () => void
}

// ─── 会话 ─────────────────────────────────────────────────────

/** 会话类型直接使用 ipc/session 的定义，这里只声明接口签名 */
export interface SessionAPI {
  load(): Promise<any> // 实际返回 ipc/session.Session | null
  save(session: any): Promise<any> // 实际返回 ipc/session.SessionReport
}

// ─── 配置 ─────────────────────────────────────────────────────

export interface SettingsAPI {
  load(roots: string[]): Promise<any> // 实际返回 ipc/settings.LoadedSettings
  save(settings: any): Promise<any> // 实际返回 ipc/settings.SaveReport
}

// ─── 命令注册 ─────────────────────────────────────────────────

export type CommandHandler = (args?: unknown) => Promise<unknown> | unknown

export interface CommandMeta {
  title?: string
  category?: string
  keybinding?: string
  when?: string
}

export interface CommandInfo {
  id: string
  title?: string
  category?: string
  keybindings?: string[]
  enabled: boolean
}

/** 简化的命令定义（桥对象内部使用） */
export interface CommandDef {
  id: string
  title?: string
  category?: string
  keybinding?: string | string[]
  when?: () => boolean
  run: () => void | Promise<void>
}

/** 命令注册表接口（从 commands/registry 抽象出来） */
export interface CommandRegistry {
  register(def: CommandDef): () => void
  execute(id: string): Promise<boolean>
  list(): Array<{ id: string; title?: string; category?: string }>
}

export interface CommandsAPI {
  register(id: string, handler: CommandHandler, meta?: CommandMeta): void
  execute(id: string, args?: unknown): Promise<unknown>
  list(): CommandInfo[]
}

// ─── UI 扩展 ──────────────────────────────────────────────────

export type ToastType = 'info' | 'warn' | 'error'

export interface UiAPI {
  showToast(message: string, type?: ToastType): void
  openToolPanel(toolId: string): void
}

// ─── 顶层桥对象 ───────────────────────────────────────────────

export interface VelaBridge {
  version: string
  editor: EditorAPI
  workspace: WorkspaceAPI
  search: SearchAPI
  replace: ReplaceAPI
  session: SessionAPI
  settings: SettingsAPI
  commands: CommandsAPI
  ui: UiAPI
}
