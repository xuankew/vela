/**
 * vela.* 桥对象 v1.0.0（M5 插件接口收敛）。
 *
 * 这一层把所有宿主能力收敛到一个带版本号的单一对象后面，
 * 不暴露 Tauri 的 `invoke` 原语，也不暴露 Rust 的错误类型。
 */

import type { VelaBridge, CommandRegistry } from './types'

// 导入现有的 IPC 模块
import * as ipcFs from '../ipc/fs'
import * as ipcProject from '../ipc/project'
import * as ipcAsset from '../ipc/asset'
import * as ipcSession from '../ipc/session'
import * as ipcSettings from '../ipc/settings'

// ─── 桥对象工厂（需要 App 传入依赖）───

export interface BridgeDeps {
  getActiveEditorHandle: () => number | null
  getEditorText: (handle: number) => string
  setEditorText: (handle: number, text: string) => void
  replaceEditorSelection: (handle: number, text: string) => void
  onEditorChange: (handle: number, cb: () => void) => () => void
  getWorkspaceRoots: () => string[]
  commandRegistry: CommandRegistry
}

export function createVelaBridge(deps: BridgeDeps): VelaBridge {
  // ─── 编辑器核心 ─────────────────────────────────────────────

  const editor: VelaBridge['editor'] = {
    getActive() {
      return deps.getActiveEditorHandle()
    },
    getText(handle) {
      return deps.getEditorText(handle)
    },
    setText(handle, text) {
      deps.setEditorText(handle, text)
    },
    replaceSelection(handle, text) {
      deps.replaceEditorSelection(handle, text)
    },
    onDidChange(handle, cb) {
      return deps.onEditorChange(handle, cb)
    },
  }

  // ─── 工作区与文件系统 ───────────────────────────────────────

  const workspace: VelaBridge['workspace'] = {
    getRoots() {
      return deps.getWorkspaceRoots()
    },
    readFile(path, encoding) {
      // encoding 是 string | undefined，但 ipcFs.openFile 要 EncodingId | undefined
      // 这里直接传 undefined，让底层用默认编码
      return ipcFs.openFile(path, encoding as any).then((f) => f.text)
    },
    writeFile(path, text, format) {
      // format 在桥对象里是可选的，但 ipcFs.saveFile 要求必填
      return ipcFs.saveFile(path, text, (format ?? 'lf') as any).then(() => {})
    },
    storeImage(docPath, base64) {
      // ipcAsset.storeImage 收的是 Uint8Array，需要把 base64 转成字节数组
      const binaryString = atob(base64)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      return ipcAsset.storeImage(docPath, bytes)
    },
    onFileChange(_cb) {
      // TODO: 订阅文件改动事件（需要 watch 模块的事件发射器）
      return () => {}
    },
    listDir(root, rel) {
      return ipcProject.listDir(root, rel) as any
    },
    createEntry(root, rel, kind) {
      return ipcProject.createEntry(root, rel, kind) as any
    },
    renameEntry(root, rel, newName) {
      return ipcProject.renameEntry(root, rel, newName) as any
    },
    trashEntry(root, rel) {
      return ipcProject.trashEntry(root, rel)
    },
    revealInFinder(root, rel) {
      return ipcProject.revealEntry(root, rel)
    },
    copyPath(root, rel) {
      return ipcProject.copyEntryPath(root, rel)
    },
  }

  // ─── 搜索 ───────────────────────────────────────────────────

  const searchTasks = new Map<string, Array<(result: any) => void>>()

  const search: VelaBridge['search'] = {
    async start(_query) {
      const taskId = crypto.randomUUID()
      searchTasks.set(taskId, [])
      
      // TODO: 调用实际的搜索命令，并在收到结果时分发给监听器
      
      return taskId
    },
    cancel(taskId) {
      searchTasks.delete(taskId)
      // TODO: 调用实际的取消命令
    },
    onResult(taskId, cb) {
      if (!searchTasks.has(taskId)) {
        searchTasks.set(taskId, [])
      }
      const listeners = searchTasks.get(taskId)!
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  }

  // ─── 替换 ───────────────────────────────────────────────────

  const replaceTasks = new Map<string, Array<(progress: any) => void>>()

  const replace: VelaBridge['replace'] = {
    async start(_query) {
      const taskId = crypto.randomUUID()
      replaceTasks.set(taskId, [])
      
      // TODO: 调用实际的替换命令
      
      return taskId
    },
    cancel(taskId) {
      replaceTasks.delete(taskId)
      // TODO: 调用实际的取消命令
    },
    onProgress(taskId, cb) {
      if (!replaceTasks.has(taskId)) {
        replaceTasks.set(taskId, [])
      }
      const listeners = replaceTasks.get(taskId)!
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  }

  // ─── 会话 ───────────────────────────────────────────────────

  const session: VelaBridge['session'] = {
    load(): Promise<any> {
      return ipcSession.loadSession()
    },
    save(sess: any): Promise<any> {
      return ipcSession.saveSession(sess)
    },
  }

  // ─── 配置 ───────────────────────────────────────────────────

  const settings: VelaBridge['settings'] = {
    load(roots: string[]): Promise<any> {
      return ipcSettings.loadSettings(roots)
    },
    save(s: any): Promise<any> {
      return ipcSettings.saveSettings(s)
    },
  }

  // ─── 命令注册 ───────────────────────────────────────────────

  const commands: VelaBridge['commands'] = {
    register(id, handler, meta) {
      // 把桥接的 handler 包装成 registry 需要的格式
      deps.commandRegistry.register({
        id,
        title: meta?.title ?? id,
        category: meta?.category,
        keybinding: meta?.keybinding,
        when: meta?.when ? () => true : undefined, // TODO: 解析 when 表达式
        run: () => {
          const result = handler()
          // handler 可能返回 Promise，但 registry 期望 void | Promise<void>
          if (result && typeof (result as any).then === 'function') {
            return result as Promise<void>
          }
        },
      })
    },
    execute(id, _args) {
      return deps.commandRegistry.execute(id)
    },
    list() {
      return deps.commandRegistry.list().map((cmd) => ({
        id: cmd.id,
        title: cmd.title,
        category: cmd.category,
        keybindings: [], // TODO: 从 registry 拿键绑定
        enabled: true, // TODO: 根据 when 条件计算
      }))
    },
  }

  // ─── UI 扩展 ────────────────────────────────────────────────

  const ui: VelaBridge['ui'] = {
    showToast(message, type = 'info') {
      // TODO: 调用实际的 toast 显示逻辑
      console.log(`[${type}] ${message}`)
    },
    openToolPanel(toolId) {
      // TODO: 打开工具箱面板
      console.log(`Opening tool panel: ${toolId}`)
    },
  }

  // ─── 返回桥对象 ─────────────────────────────────────────────

  return {
    version: '1.0.0',
    editor,
    workspace,
    search,
    replace,
    session,
    settings,
    commands,
    ui,
  }
}
