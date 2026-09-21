# Vela 插件 API v1.0.0

> **状态**：实验性（M5 阶段，尚未冻结）  
> **最后更新**：2026-09-22

本文档列出 `vela.*` 桥对象的所有公开 API。插件通过 `activate(vela)` 函数接收这个对象。

---

## 顶层结构

```ts
const vela = {
  version: '1.0.0',    // semver，用于版本协商
  editor: { ... },     // 编辑器核心
  workspace: { ... },  // 工作区与文件系统
  search: { ... },     // 全文搜索
  replace: { ... },    // 全局替换
  session: { ... },    // 会话管理
  settings: { ... },   // 配置管理
  commands: { ... },   // 命令注册
  ui: { ... },         // UI 扩展
}
```

---

## 1. vela.editor（编辑器核心）

### `getActive(): number | null`
返回当前聚焦的编辑器句柄。没有打开的文档时返回 `null`。

### `getText(handle: number): string`
获取指定编辑器的完整文本内容。

### `setText(handle: number, text: string): void`
替换指定编辑器的完整文本内容。

### `replaceSelection(handle: number, text: string): void`
在指定编辑器中替换当前选区的文本。

### `onDidChange(handle: number, cb: () => void): () => void`
订阅指定编辑器的内容变化事件。返回退订函数。

---

## 2. vela.workspace（工作区与文件系统）

### `getRoots(): string[]`
返回当前工作区的所有根路径（多根工作区支持）。

### `readFile(path: string, encoding?: string): Promise<string>`
读取指定路径的文本文件内容。编码默认为 UTF-8。

### `writeFile(path: string, text: string, format?: 'lf' | 'crlf' | 'cr'): Promise<void>`
写入文本文件。换行符格式默认为 `lf`。

### `storeImage(docPath: string, base64: string): Promise<{ path: string }>`
将 base64 编码的图片保存到文档所在目录。返回保存后的相对路径。

### `onFileChange(cb: (path: string) => void): () => void`
订阅工作区内文件的改动事件。**当前未实现**，返回空退订函数。

### `listDir(root: string, rel: string): Promise<DirListing>`
枚举指定相对路径下的目录内容。`rel` 为空字符串时列举根目录。

### `createEntry(root: string, rel: string, kind: 'file' | 'dir'): Promise<DirEntry>`
在工作区内创建文件或目录。`rel` 是相对于 `root` 的路径。

### `renameEntry(root: string, rel: string, newName: string): Promise<DirEntry>`
重命名工作区内的文件或目录。

### `trashEntry(root: string, rel: string): Promise<void>`
将工作区内的文件或目录移动到废纸篓。

### `revealInFinder(root: string, rel: string): Promise<void>`
在 macOS Finder 中显示指定的文件或目录。

### `copyPath(root: string, rel: string): Promise<void>`
将指定文件或目录的绝对路径复制到剪贴板。

---

## 3. vela.search（全文搜索）

### `start(query: SearchQuery): Promise<string>`
启动全文搜索任务。返回任务 ID。

```ts
interface SearchQuery {
  roots: string[]        // 搜索根路径列表
  pattern: string        // 搜索模式（文本或正则）
  caseSensitive?: boolean
  wholeWord?: boolean
  isRegex?: boolean
  include?: string[]     // 包含的通配符列表
  exclude?: string[]     // 排除的通配符列表
}
```

### `cancel(taskId: string): void`
取消正在进行的搜索任务。

### `onResult(taskId: string, cb: (result: SearchResult) => void): () => void`
订阅搜索结果。**当前未实现实际的事件分发**。

```ts
interface SearchResult {
  path: string
  line: number
  column: number
  match: string
  contextBefore?: string[]
  contextAfter?: string[]
}
```

---

## 4. vela.replace（全局替换）

### `start(query: ReplaceQuery): Promise<string>`
启动全局替换任务。返回任务 ID。

```ts
interface ReplaceQuery extends SearchQuery {
  replacement: string
  preserveCase?: boolean
}
```

### `cancel(taskId: string): void`
取消正在进行的替换任务。

### `onProgress(taskId: string, cb: (progress: ReplaceProgress) => void): () => void`
订阅替换进度。**当前未实现实际的事件分发**。

```ts
interface ReplaceProgress {
  total: number
  processed: number
  replaced: number
  skipped: number
  errors: number
}
```

---

## 5. vela.session（会话管理）

### `load(): Promise<Session | null>`
加载上次保存的会话（标签、光标位置、滚动位置等）。

### `save(session: Session): Promise<SessionReport>`
保存当前会话。

> **注意**：这两个方法直接透传 `ipc/session` 的类型，具体字段见 `src/ipc/session.ts`。

---

## 6. vela.settings（配置管理）

### `load(roots: string[]): Promise<LoadedSettings>`
加载三层合并的配置（全局 + 项目 + 本地）。

### `save(settings: Settings): Promise<SaveReport>`
保存配置到 `~/.vela/settings.json`。

> **注意**：这两个方法直接透传 `ipc/settings` 的类型，具体字段见 `src/ipc/settings.ts`。

---

## 7. vela.commands（命令注册）

### `register(id: string, handler: () => void | Promise<void>, meta?: CommandMeta): void`
注册一个新命令。

```ts
interface CommandMeta {
  title?: string       // 命令显示名称
  category?: string    // 命令分类
  keybinding?: string  // 快捷键绑定（如 "Cmd+Shift+P"）
  when?: string        // 启用条件表达式（当前未实现解析）
}
```

### `execute(id: string, args?: unknown): Promise<unknown>`
执行指定命令。

### `list(): CommandInfo[]`
列出所有已注册的命令。

```ts
interface CommandInfo {
  id: string
  title?: string
  category?: string
  keybindings?: string[]
  enabled: boolean
}
```

---

## 8. vela.ui（UI 扩展）

### `showToast(message: string, type?: 'info' | 'warn' | 'error'): void`
显示一条 toast 提示。**当前只输出到 console**。

### `openToolPanel(toolId: string): void`
打开指定的工具箱面板。**当前只输出到 console**。

---

## 安全边界

### 插件能做的
- ✅ 读/写用户已打开的文件（通过 `workspace.getRoots()` 拿到的根路径下）
- ✅ 监听文件改动（待实现）
- ✅ 注册命令、打开面板、显示提示
- ✅ 调用搜索/替换（但结果受 root 限制）
- ✅ 读写配置（`~/.vela/settings.json`）

### 插件不能做的
- ❌ 访问任意路径（必须通过工作区根路径）
- ❌ 执行系统命令
- ❌ 修改 Vela 自身二进制或前端代码
- ❌ 操作窗口（关闭/最小化等）
- ❌ 访问网络（当前无网络 API）

---

## 版本协商

插件的 `manifest.json` 应声明 `"minVelaVersion"` 字段：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "minVelaVersion": "1.0.0",
  ...
}
```

加载器会用简单的 semver 比较检查兼容性。不满足最低版本的插件会被跳过并记录警告。

---

## 激活时机

插件在 `manifest.json` 中声明 `activationEvents`：

```json
{
  "activationEvents": [
    "onStartup",           // 启动时立即激活
    "onCommand:myCommand"  // 命令首次执行时激活
  ]
}
```

当前支持的激活事件：
- `onStartup`：应用启动后立即激活
- `onCommand:<id>`：指定命令首次被触发时激活（懒加载）

---

## 已知限制（v1.0.0）

1. **搜索/替换的事件订阅未实现**：`search.onResult()` 和 `replace.onProgress()` 目前只是占位，不会收到实际事件。
2. **文件改动监听未实现**：`workspace.onFileChange()` 返回空退订函数。
3. **UI 方法只有 console 输出**：`showToast()` 和 `openToolPanel()` 尚未接入实际的 UI 组件。
4. **when 表达式未解析**：`commands.register()` 的 `meta.when` 字段目前只接受布尔函数，不支持表达式字符串。
5. **键绑定未暴露**：`commands.list()` 返回的 `keybindings` 始终为空数组。

这些限制将在后续版本中逐步解除。
