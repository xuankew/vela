# M5 · API 面审视与冻结决策

> **日期**：2026-09-22  
> **状态**：待用户确认

## 审查原则

1. **最小权限**：插件只应获得完成其功能所需的最小能力集
2. **安全隔离**：能写盘、能执行系统命令的能力必须严格限制
3. **发布即冻结**：v1.0.0 之后只能加不能改，现在是最便宜的砍掉时机

---

## 23 个 Tauri Command 逐一审查

### ✅ 应该暴露给插件（14 个）

| # | 命令 | 桥对象方法 | 理由 |
|---|---|---|---|
| 1 | `open_file` | `workspace.readFile()` | 只读文件内容，插件基本需求 |
| 2 | `save_file` | `workspace.writeFile()` | 写文本文件，但限制在工作区根下 |
| 3 | `store_image` | `workspace.storeImage()` | 粘贴截图落地，Markdown 插件需要 |
| 4 | `list_dir` | `workspace.listDir()` | 枚举目录，文件管理插件需要 |
| 5 | `create_entry` | `workspace.createEntry()` | 创建文件/文件夹，同上 |
| 6 | `rename_entry` | `workspace.renameEntry()` | 改名，同上 |
| 7 | `trash_entry` | `workspace.trashEntry()` | 删除到废纸篓（非永久删除），可逆操作 |
| 8 | `reveal_entry` | `workspace.revealInFinder()` | 在 Finder 中显示，用户体验增强 |
| 9 | `copy_entry_path` | `workspace.copyPath()` | 复制路径到剪贴板，同上 |
| 10 | `start_search` | `search.start()` | 全文搜索，只读不写 |
| 11 | `load_session` | `session.load()` | 读会话，只读 |
| 12 | `save_session` | `session.save()` | 写会话，但只写 Vela 自己的会话文件 |
| 13 | `load_settings` | `settings.load()` | 读配置，只读 |
| 14 | `save_settings` | `settings.save()` | 写配置，但只写 `~/.vela/settings.json` |

### ❌ 不应暴露给插件（9 个）

| # | 命令 | 理由 | 替代方案 |
|---|---|---|---|
| 1 | `open_large` | 大文件分片打开是 Vela 内部优化，插件不需要直接操作分片 | 插件用 `readFile()` 读完整内容即可 |
| 2 | `close_large` | 同上，内部管理分片句柄 | 自动管理，无需暴露 |
| 3 | `read_lines` | 同上，按行号范围读分片 | 插件用 `readFile()` 后自己 split |
| 4 | `start_replace` | **会批量写盘**，一次改两万个文件，Vela 没有跨文件撤销 | 不提供全局替换 API，插件如需此能力应走 L2/L3 沙箱 |
| 5 | `cancel_task` | 取消后台任务是 UI 层职责，插件不应干预其他任务 | 不提供 |
| 6 | `index_project` | 建文件索引是 Vela 内部缓存，插件不需要 | 不提供 |
| 7 | `query_project` | 模糊匹配文件名，插件可用 `listDir()` + 自己过滤 | 不提供，避免 API 面膨胀 |
| 8 | `set_watched` | 订阅文件改动是 Vela 内部机制，插件用 `workspace.onFileChange()` 就够了 | 已封装在桥对象里，但不单独暴露这个原语 |
| 9 | `close_window` | **关闭窗口是用户操作**，插件无权替用户关窗口 | 不提供 |

---

## v1.0.0 冻结的 API 清单

基于以上审查，v1.0.0 冻结的 API 包括：

### 稳定 API（Stable）
- `vela.version`
- `vela.editor.*`（5 个方法）
- `vela.workspace.readFile()` / `writeFile()` / `storeImage()`
- `vela.workspace.listDir()` / `createEntry()` / `renameEntry()` / `trashEntry()`
- `vela.workspace.revealInFinder()` / `copyPath()`
- `vela.session.load()` / `save()`
- `vela.settings.load()` / `save()`
- `vela.commands.register()` / `execute()` / `list()`

### 实验性 API（Experimental）
- `vela.workspace.getRoots()` / `onFileChange()`（未实现）
- `vela.search.*`（事件订阅未实现）
- `vela.replace.*`（事件订阅未实现）
- `vela.ui.showToast()` / `openToolPanel()`（只有 console 输出）

### 明确排除（Won't Expose in v1）
- `open_large` / `close_large` / `read_lines`（分片内部 API）
- `start_replace`（批量写盘风险太高）
- `cancel_task`（任务管理是 UI 层职责）
- `index_project` / `query_project`（内部缓存，插件可自行实现）
- `set_watched`（已封装在 `onFileChange()` 里）
- `close_window`（用户操作，插件无权）

---

## 将来开放的路线

如果将来真的要开放第三方插件生态，建议按以下阶段推进：

### L1（webview 内 JS，无沙箱）—— 额外 5–10 人日
- 当前桥对象就是为 L1 设计的
- 插件即目录：`manifest.json` + `main.js` + `styles.css`
- 与 CM6 同上下文，零桥接成本
- **风险**：插件能摸到 DOM 和全局变量，无隔离

### L2（权限声明 + 市场 + 生命周期）—— 累计 15–30 人日
- 插件需在 manifest 中声明需要的权限（如 `workspace:read` / `workspace:write`）
- 用户安装时确认权限
- 市场审核机制（类似 Obsidian community plugins）

### L3（QuickJS/Wasm 沙箱）—— 累计 35–70 人日
- 插件运行在隔离的沙箱里，摸不到 DOM
- 需要通过 FFI 桥接所有宿主能力
- **不适合暴露 keystroke 级编辑器事件**（延迟太高）

---

## 用户确认事项

请确认以下决策：

1. ✅ **上述 14 个暴露 / 9 个排除的分类是否合理？**
   - 特别关注 `start_replace`（批量写盘）被排除的理由是否充分
   - `close_window` 被排除是因为安全，不是技术做不到

2. ⚠️ **实验性 API 的处理方式**
   - 选项 A：v1.0.0 就标记为 experimental，文档里写明"可能变动"
   - 选项 B：v1.0.0 先不包含这些方法，等实现了再加（breaking change 风险低，因为是新增）
   - **建议选 B**：保持 v1.0.0 的 API 面极简，只包含已实现且稳定的部分

3. ⏳ **示例插件是否要真的能跑起来？**
   - 当前的两个示例插件（word-count / auto-backup）只是代码骨架，没有在 App.tsx 里真正加载
   - 要让它们跑起来需要在 App.tsx 的 `onMount` 里调用 `loadPlugin()` + `activatePlugins()`
   - **建议推迟到真有插件需求时再做**，现在只是验证 API 表达力
