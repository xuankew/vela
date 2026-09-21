# M5 · 插件接口收敛 - 设计方案

## 目标

不开放第三方插件生态，只做**内部重构 + 冻结 API 边界**。把当前散落在 `src/ipc/*` 和 `src-tauri/src/commands.rs` 里的 23 个 Tauri command 收敛到一个带版本号的 `vela.*` 桥对象后面。

**为什么值得做**：用示例插件反向验证是发现 API 设计缺陷的唯一可靠方法。等真有第三方开发者时才发现问题，改起来就是 breaking change。

---

## 1. 当前宿主能力清单（23 个 Tauri command）

### 1.1 文件 IO（4 个）
- `open_file(path, encoding?)` → 读文本文件
- `save_file(path, text, format)` → 写文本文件
- `store_image(doc_path, data_base64)` → 粘贴截图落地
- `open_large(path)` → 大文件分片打开（在 `shard.rs`）

### 1.2 项目树操作（5 个）
- `list_dir(root, rel)` → 枚举目录
- `create_entry(root, rel, kind)` → 创建文件/文件夹
- `rename_entry(root, rel, new_name)` → 改名
- `trash_entry(root, rel)` → 删除到废纸篓
- `reveal_entry(root, rel)` / `copy_entry_path(root, rel)` → 系统工具（Finder / 剪贴板）

### 1.3 搜索与替换（2 个）
- `start_search(query)` → 全文搜索（只读）
- `start_replace(query)` → 全局替换（会写盘）

### 1.4 会话管理（2 个）
- `load_session()` → 恢复标签/光标/滚动位置
- `save_session(session)` → 保存会话快照

### 1.5 配置管理（2 个）
- `load_settings(roots)` → 读三层合并的配置
- `save_settings(settings)` → 写 `~/.vela/settings.json`

### 1.6 窗口控制（1 个）
- `close_window(window)` → 关闭窗口（带未保存确认）

### 1.7 其他（7 个）
- `index_project(roots)` → 建文件索引（只读名字）
- `query_project(roots, needle, mru)` → 模糊匹配文件名
- `set_watched(paths)` → 订阅文件改动（在 `watcher.rs`）
- `close_large(handle)` → 关闭大文件句柄（在 `shard.rs`）
- `read_lines(handle, from, to)` → 读分片行号范围（在 `shard.rs`）
- `cancel_task(task_id)` → 取消后台任务

---

## 2. vela.* 桥对象 v1.0.0 设计

### 2.1 顶层结构

```ts
const vela = {
  version: '1.0.0',
  
  // 编辑器核心
  editor: {
    getActive(): EditorHandle | null,
    getText(handle: EditorHandle): string,
    setText(handle: EditorHandle, text: string),
    replaceSelection(handle: EditorHandle, text: string),
    onDidChange(handle: EditorHandle, cb: () => void): () => void,
  },
  
  // 工作区与文件系统
  workspace: {
    getRoots(): string[],
    readFile(path: string, encoding?: string): Promise<string>,
    writeFile(path: string, text: string, format?: FileFormat): Promise<void>,
    storeImage(docPath: string, base64: string): Promise<{ path: string }>,
    onFileChange(cb: (path: string) => void): () => void,
    
    // 项目树操作
    listDir(root: string, rel: string): Promise<DirListing>,
    createEntry(root: string, rel: string, kind: 'file' | 'dir'): Promise<DirEntry>,
    renameEntry(root: string, rel: string, newName: string): Promise<DirEntry>,
    trashEntry(root: string, rel: string): Promise<void>,
    revealInFinder(root: string, rel: string): Promise<void>,
    copyPath(root: string, rel: string): Promise<void>,
  },
  
  // 搜索
  search: {
    start(query: SearchQuery): Promise<SearchTaskId>,
    cancel(taskId: SearchTaskId): void,
    onResult(taskId: SearchTaskId, cb: (result: SearchResult) => void): () => void,
  },
  
  replace: {
    start(query: ReplaceQuery): Promise<ReplaceTaskId>,
    cancel(taskId: ReplaceTaskId): void,
    onProgress(taskId: ReplaceTaskId, cb: (progress: ReplaceProgress) => void): () => void,
  },
  
  // 会话
  session: {
    load(): Promise<Session | null>,
    save(session: Session): Promise<void>,
  },
  
  // 配置
  settings: {
    load(roots: string[]): Promise<LoadedSettings>,
    save(settings: Settings): Promise<SaveReport>,
  },
  
  // 命令注册（插件扩展点）
  commands: {
    register(id: string, handler: CommandHandler, meta?: CommandMeta): void,
    execute(id: string, args?: unknown): Promise<unknown>,
    list(): CommandInfo[],
  },
  
  // UI 扩展
  ui: {
    showToast(message: string, type?: 'info' | 'warn' | 'error'): void,
    openToolPanel(toolId: string): void,
  },
}
```

### 2.2 关键设计决策

#### ① 版本号语义
- `version: '1.0.0'` 采用 semver，将来加字段只涨 minor，breaking change 涨 major
- 插件 manifest 可声明 `"minVelaVersion": "1.0.0"`

#### ② 路径安全
- 所有收绝对路径的方法（`readFile` / `writeFile`）仍由 Rust 侧做「是不是绝对路径、存不存在」校验
- 相对路径方法（`listDir` / `createEntry` 等）的 containment 不变：第二个参数含 `..` 或本身是绝对路径时直接拒绝

#### ③ 异步模型
- 所有 IPC 调用保持 `Promise` 返回，不暴露 Tauri 的 `invoke` 原语
- 事件订阅统一返回退订函数 `() => void`，与 CM6 Compartment 同一套姿势

#### ④ 错误处理
- 不暴露 Rust 的错误类型（`ReadError` / `WriteError` 等），统一成 `{ code: string, message: string }`
- 示例：`{ code: 'FILE_NOT_FOUND', message: '/path/to/file does not exist' }`

---

## 3. 示例插件设计（反向验证 API）

### 示例 1：字数统计插件（只读型）
**激活时机**：启动时懒加载  
**验证点**：
- `editor.getActive()` + `editor.getText()`
- `ui.showToast()`
- `commands.register()` 注册 `wordCount.show` 命令

```ts
// plugins/word-count/main.js
export function activate(vela) {
  vela.commands.register('wordCount.show', () => {
    const handle = vela.editor.getActive()
    if (!handle) return
    const text = vela.editor.getText(handle)
    const count = text.trim().split(/\s+/).length
    vela.ui.showToast(`当前文档 ${count} 个词`, 'info')
  })
}
```

### 示例 2：自动备份插件（读写型）
**激活时机**：文件保存时触发  
**验证点**：
- `workspace.onFileChange()`
- `workspace.readFile()` / `workspace.writeFile()`
- `settings.load()` / `settings.save()`

```ts
// plugins/auto-backup/main.js
export function activate(vela) {
  const backupDir = '~/.vela/backups'
  
  vela.workspace.onFileChange((path) => {
    const text = await vela.workspace.readFile(path)
    const timestamp = Date.now()
    const backupPath = `${backupDir}/${timestamp}_${path.split('/').pop()}`
    await vela.workspace.writeFile(backupPath, text)
  })
}
```

### 示例 3：快速搜索面板（UI 扩展型）
**激活时机**：命令触发时  
**验证点**：
- `commands.register()` 带元数据（标题/分类/快捷键）
- `ui.openToolPanel()`
- `search.start()` + `search.onResult()`

```ts
// plugins/quick-search/main.js
export function activate(vela) {
  vela.commands.register('quickSearch.open', () => {
    ui.openToolPanel('quickSearch')
  }, {
    title: '快速搜索',
    category: '搜索',
    keybinding: 'Cmd+Shift+F',
  })
}
```

---

## 4. 实施步骤

### 阶段 1：桥对象骨架（1.5 人日）
1. 新建 `src/bridge/index.ts`，定义 `vela` 对象骨架
2. 为每个子模块（`editor` / `workspace` / `search` 等）建独立文件
3. 包装现有 `src/ipc/*` 模块，不改变底层实现

### 阶段 2：示例插件验证（1.5 人日）
1. 建 `plugins/` 目录，放三个示例插件
2. 每个插件一个 `manifest.json` + `main.js`
3. 在 `App.tsx` 里硬编码加载这三个插件（不走动态扫描）

### 阶段 3：懒激活机制（0.5 人日）
1. `manifest.json` 声明 `activationEvents`（如 `onCommand:xxx` / `onStartup`）
2. 命令首次执行时才 `import()` 插件入口
3. 缓存已加载的插件实例

### 阶段 4：API 契约文档（0.5 人日）
1. 写 `docs/plugin-api.md`，列出所有 `vela.*` 方法签名
2. 标注哪些是稳定 API、哪些是实验性 API
3. 附三个示例插件的完整代码

### 阶段 5：审视并砍掉多余 API（1 人日）
1. 对照 23 个 Tauri command，逐个问「插件真的需要这个吗」
2. 砍掉非必要的（如 `close_window` / `cancel_task` 不应暴露给插件）
3. 冻结 v1.0.0 API 清单，之后只能加不能改

---

## 5. 安全边界

### 插件能做的
- 读/写用户已打开的文件
- 监听文件改动
- 注册命令、打开面板、显示提示
- 调用搜索/替换（但结果受 root 限制）

### 插件不能做的
- 访问任意路径（必须通过 `workspace.getRoots()` 拿到的根）
- 执行系统命令
- 修改 Vela 自身配置（`~/.vela/settings.json` 只读）
- 操作窗口（关闭/最小化等）

---

## 6. 验收标准

1. ✅ 三个示例插件都能正常加载并执行各自的功能
2. ✅ `vela.version === '1.0.0'`
3. ✅ 所有 `vela.*` 方法都有 TypeScript 类型定义
4. ✅ `docs/plugin-api.md` 覆盖全部公开 API
5. ✅ 八道门禁测试通过，首屏体积增量 < 5KB（桥对象本身很小）
6. ✅ PLAN.md 补 M5 实施修正块
