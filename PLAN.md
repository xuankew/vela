# Vela · 技术方案与实施计划

| | |
|---|---|
| **代号** | Vela（船帆座） |
| **文档版本** | v1.0 |
| **日期** | 2026-09-13 |
| **状态** | 已定稿，待启动 M0 |
| **技术栈** | Rust + Tauri 2.11.x + Solid + CodeMirror 6 |

---

## 0. 摘要

**Vela 是一款面向开发者的「速开编辑器 + 文本工具箱」**，对标 Sublime Text 的轻量与手感，内置 DevToys 级别的高频工具集，架构上按 Obsidian 的「一切皆命令」方式设计以便未来扩展插件。

**核心结论**

1. **编辑器内核选 CodeMirror 6**，不选 Monaco。gzip 体积 75–135KB vs 598KB+，且 Lezer 提供真 AST，是 Markdown 结构化预览的唯一现实路径。Obsidian 本身即 CM6。
2. **前端选 Solid**，runtime 8.4KB gzip，无虚拟 DOM，与 CM6 的命令式 DOM 管理边界最干净。
3. **文档模型 v1 放在前端**（CM6 的 `Text` 本身就是 rope），编辑零 IPC 延迟。Rust 侧 `ropey` 只用于超大文件只读分片模式。
4. **不碰任何 copyleft 代码**。Zed 编辑器核心是 GPL-3.0、athas 是 AGPL-3.0、hermes-ide 是 BUSL 1.1 且明文排除竞品编辑器——三者均不可复用于闭源商业化。可安全复用的是 MIT/Apache/Unlicense 生态：`ropey`、`ignore`、`grep-*`、`notify`、`tree-sitter`。
5. **插件系统 v1 只收敛接口、不开放**。把宿主能力全部收到带版本号的 `vela.*` 桥对象后面，用 2–3 个「假装是第三方」的示例插件反向验证 API 表达力。将来开放 L1 方案额外仅需 5–10 人日。
6. **中文字体是最大的体积风险**：`LXGWWenKaiScreen.ttf` 单文件 24.48MB。方案为 WOFF2 分片 + `unicode-range` 懒加载，首屏实际加载控制在 2MB 内。
7. **总量 43–54 人日**（1 名熟练 Rust+TS 全栈全职，约 9–11 周）。M1 结束（第 3 周末）即有可日用的编辑器。
8. **M0 是风险闸门**：WKWebView 的滚动/输入手感存在未解决的生态级 open issue，必须用 3 天先验证，不过则重估 Tauri 路线。

---

## 1. 产品方案

### 1.1 定位

三个参照物，各取一味：

| 参照物 | 取什么 | 不取什么 |
|---|---|---|
| **Sublime Text** | 秒开、多光标、Goto Anything、轻量手感 | 它过时的插件生态与 Python API |
| **DevToys** | 高频文本处理工具箱、智能检测 | 它「独立工具应用」的形态——Vela 的工具长在编辑器里 |
| **Obsidian** | 「一切皆命令」的可扩展架构 | 它的知识库/双链定位 |

**一句话定位**：开发者桌面上那个「随手打开、改完就关」的编辑器，顺手还能处理 JSON、时间戳、正则。

**市场空位**：调研发现 Tauri 编辑器赛道两极分化——要么是 Monaco/CM6 套壳的 Markdown 编辑器（数十个，均 <50 star），要么是 sidex（16.4MB，VS Code workbench 移植）、athas 这类重型全功能 IDE。**「轻量代码编辑器 + 文件树 + 工具箱」这个中间地带基本是空的。**

### 1.2 目标用户与核心场景

**主要用户**：需要在多个项目/配置/日志间快速切换的开发者。

**四个高频场景**（所有设计决策以此为优先级依据）：

1. **速开速改**：双击/拖拽打开一个 JSON/YAML/配置文件，改几个值，保存关闭。要求冷启动 < 1s。
2. **跨项目检索**：在一堆目录里找某个字符串/配置项，批量替换。要求 ripgrep 级性能。
3. **文本加工**：拿到一段压缩 JSON、一个 JWT、一个时间戳、一段乱码，就地处理。要求 ≤ 2 次按键可达。
4. **写文档**：Markdown 编辑 + 预览，粘贴截图自动落地。

### 1.3 非目标（v1 坚决不做）

明确列出以避免范围蔓延——这是「轻量」能守住的前提：

- ❌ **LSP / 代码智能**：补全、诊断、跳转定义、重命名、代码操作。工作量与复杂度陡增，且直接偏离「轻量速开」定位。
- ❌ **调试器**
- ❌ **集成终端**：速开场景下「在 Finder 中显示」「复制路径」比终端更有用。
- ❌ **远程开发 / SSH / WSL**
- ❌ **协作编辑 / CRDT**
- ❌ **AI 补全**：将来作为插件实现，不进内核。
- ❌ **所见即所得 Markdown（WYSIWYG）**：用分屏预览代替。Obsidian 的 Live Preview 是自研装饰层，成本极高。
- ❌ **第三方插件开放**：v1 只收敛接口。

### 1.4 编辑器能力清单

#### P0 — M1 必须交付

| 能力 | 说明 |
|---|---|
| 多光标 / 多选区 | `Cmd+D` 逐词选中下一个匹配、`Cmd+Shift+L` 全展开、`Alt+Click` 添加光标、列块选择（`Cmd+Shift+L/R` 或鼠标拖拽） |
| 命令面板 | `Cmd+Shift+P`，**所有**编辑器操作与内置工具的唯一入口 |
| Goto Anything | `Cmd+P` 模糊找文件、`Cmd+R` 文件内符号、`Cmd+G` 跳转行号 |
| 查找替换 | 单文件（含正则、整词、保留大小写替换）、查找选中词的下一个/上一个 |
| 语法高亮 | 主流 30+ 语言，Lezer 增量解析，子语言懒加载 |
| 括号与缩进 | 括号/标签匹配高亮、自动缩进、缩进引导线、Tab 宽度切换 |
| 代码折叠 | 按缩进与按语法两种模式 |
| 行操作 | 复制行、删除行、上下移行、排序行、去重 |
| 词补全 | 基于当前文档 + 项目词典（**非 LSP**，成本极低但很实用） |
| 标签页 | 多标签、脏标记、关闭确认、`Cmd+W` / `Ctrl+Tab` 切换 |
| 分屏 | 水平/垂直分屏、拖拽重排、聚焦切换 |
| 文件 IO | 打开/保存/另存为、编码探测（UTF-8/GBK）、LF/CRLF 切换、BOM 处理 |
| 会话恢复 | 重启后恢复标签、光标位置、滚动位置、未保存草稿 |
| 撤销历史 | 多文件独立撤销栈，保存不清空 |
| 状态栏 | 行列、编码、换行符、语言、缩进、字数 |

#### P1 — M4 视进度纳入

- Minimap
- Git gutter（行级增删改标记，只读展示，不做 stage/commit）
- 拼写检查
- 书签与断点式标记
- 拖拽文件到窗口打开
- 「在 Finder 中显示」「复制相对/绝对路径」

#### 已知能力上限（诚实标注）

- **大文件**：十万行 / 数十 MB 级流畅可编辑。超过 50MB 进入**只读分片模式**（Rust 侧持有全文，前端只请求可视窗口）。百万行 / 百 MB 级 CM6 与 Monaco 都撑不住，不做承诺。
- **连字（ligatures）**：默认关闭。`font-variant-ligatures` 在 contenteditable 语境下会导致光标定位错乱，这是浏览器级问题。
- **East Asian Width 歧义字符**（`±` `×`、希腊字母等）：CM6/Monaco 的单值 `charWidth` 测量模型都无法正确定位，属行业公认老问题，接受。
- **长行 + 自动换行的大文档**：CM6 会有「pop 抖动」，作者明确表示这是为保持响应性必须付的代价。

### 1.5 内置工具集

#### 架构杠杆点

**所有工具共用一个声明式抽象**，配一个通用 `ToolPanel` 组件（左右分栏 + 选项条 + 复制结果）。新增一个工具的边际成本 ≈ 写一个纯函数。

```ts
interface ToolDefinition {
  id: string              // 'tool.json.format'
  name: string            // 'JSON 格式化'
  icon: string
  category: 'format' | 'encode' | 'generate' | 'convert' | 'test' | 'text' | 'graphic'
  input: 'editor' | 'text' | 'none'   // 取当前文档 / 独立输入框 / 无输入
  options?: ToolOption[]              // 声明式渲染选项条
  side: 'js' | 'rust'                 // 轻计算走前端，重计算（哈希/图片/转码）走 Rust
  run(input: string, opts: unknown): Promise<ToolResult>
}
```

**这套注册机制就是将来插件 API 的第一个内部用户**——「预留接口」由此天然达成，无需额外设计。

#### P0 工具清单（17 个，M3 交付）

| 分类 | 工具 |
|---|---|
| **格式化** | JSON 格式化 / 压缩（可设缩进、排序键、去注释）、JSON ↔ YAML、SQL 格式化、XML / HTML 格式化、Markdown 表格对齐 |
| **编解码** | Base64 文本 / 图片、URL 编解码、HTML 实体、JWT 解析（含 payload 与过期时间提示）、Unicode / 转义字符 |
| **生成器** | UUID / ULID / NanoID、哈希（MD5 / SHA1 / SHA256 / SHA512，走 Rust 侧）、时间戳互转（秒 / 毫秒 / 时区） |
| **测试器** | 正则测试器（实时高亮 + 分组捕获 + 替换预览）、文本 Diff（两栏对比）、JSONPath 查询 |
| **文本** | 命名风格转换（camel / snake / kebab / CONSTANT / Pascal）、Cron 表达式解析（含未来 N 次触发时间） |

#### P1 工具（M4+）

颜色转换与取色器、进制转换、二维码生成、CSV ↔ Markdown ↔ JSON 互转、GBK ↔ UTF-8 转码、图片压缩与格式转换（Rust `image` crate）、Lorem Ipsum / 中文假文、随机密码、JSON Array → Table

#### 智能检测（强烈建议进 P0）

粘贴任意内容，自动识别它是 JWT / Base64 / JSON / 时间戳 / 颜色值 / URL 编码，直接给出对应工具入口。这是 DevToys 最讨喜的设计，成本低但直接命中「使用便捷」诉求。

实现：一组带优先级的正则/启发式规则，输入变化时 debounce 150ms 执行。

#### 接入方式

工具可通过三条路径触达，全部走命令注册表：
1. `Cmd+Shift+P` 命令面板搜索工具名
2. 绑定快捷键（如 `Cmd+Shift+J` → JSON 格式化）
3. 侧边栏「工具箱」面板，按分类浏览

### 1.6 Markdown 友好

| 功能 | 实现要点 |
|---|---|
| 分屏预览 + 同步滚动 | `@lezer/markdown` 的 AST 映射源位置到预览位置。**不做 WYSIWYG** |
| 大纲面板 | 基于 AST 标题节点，支持点击跳转与折叠 |
| 表格自动对齐 | 编辑时自动补齐 `|` 与对齐空格，格式化命令可调 |
| GFM 任务列表 | `- [ ]` 渲染为可点击复选框，点击回写源文件 |
| **图片粘贴自动落地** | `Cmd+V` 截图 → 存入 `assets/`（可配置路径与命名规则）→ 插入相对路径。**对写文档的人价值极高** |
| 链接补全 | 输入 `](` 时补全项目内相对路径文件 |
| 统计 | 字数、字符数、阅读时长（中文按字符计，英文按词计） |
| 导出 HTML | 内联样式单文件导出 |

代码块内子语言高亮通过 `@codemirror/language-data` 懒加载。

### 1.7 项目与目录支持

| 功能 | 实现要点 |
|---|---|
| 侧边栏文件树 | **懒加载**（Rust 侧按需 `read_dir`，绝不建全量树）+ 前端虚拟化列表 + `ignore` crate 遵守 `.gitignore`/`.ignore`/全局忽略 + `node_modules`、`.git`、`dist` 默认折叠 |
| 全局搜索 / 替换 | `grep-searcher` + `grep-regex`（ripgrep 的库化产物），**流式返回**结果（Tauri event 分批推送），按文件分组、带上下文预览、点击跳转、支持 include/exclude glob |
| 多根工作区 | 一个项目挂多个文件夹，对齐 Sublime 的 `.sublime-project` |
| 项目级配置 | `.vela/settings.json`，与用户全局配置分层合并 |
| 最近项目 | 快速切换 `Cmd+Shift+O` |
| 外部改动监听 | `notify` + debounce，文件被外部修改时提示重载；有未保存改动时给冲突处理选项 |

**验收目标**：打开一个含 `node_modules` 的真实前端仓库（10 万+ 文件），侧边栏秒开不卡，全局搜索 < 2s 出首批结果。

### 1.8 主题

- **CSS Variables 驱动**：主题 = 一组变量值，切换零重启、无重新编译。
- 内置：Vela Dark、Vela Light、High Contrast，+ 3 套流行配色移植（**注意核对配色方案各自的 License**，多为 MIT，但需逐个确认）。
- 跟随系统深浅色（macOS `prefers-color-scheme`）。
- 编辑器语法配色与 UI 配色分离，便于用户只改一部分。
- 用户自定义主题：放一个 JSON 文件到 `~/.vela/themes/` 即可加载（这也是将来插件的第一个能力出口）。

### 1.9 字体

#### 默认字体：霞鹜文楷屏显版

**合规性已确认**：SIL OFL 1.1，项目自带 OFL.txt 明确允许 bundled / embedded / redistributed，**甚至允许随软件一起销售**——闭源商业化无障碍。

**Reserved Font Name（RFN）**：霞鹜 / 霞鶩 / 落霞孤鹜 / 落霞孤鶩 / LXGW。这条很关键：

> **OFL FAQ 2.6 明确「子集化视为修改」**，子集化后不得继续使用 RFN，必须改名（如 "Vela Kai"）。
> **OFL FAQ 2.2：仅压缩转 WOFF2、字形数据不变，则无需改名。**

#### 体积问题（M0 已实测）

| 字体资产 | 实测体积 |
|---|---|
| `LXGWWenKaiScreen.ttf` | **24.48MB** |
| `LXGWWenKaiScreenMono.ttf` | 24.44MB |
| `lxgw-wenkai-screen-webfont` **单变体** | **97 个 woff2 分片 / 4.33MB**（GB 国标版）、**4.87MB**（Screen R） |
| `lxgw-wenkai-screen-webfont` 4 变体合计 | 18.40MB |
| Maple Mono 英文单包 | 1.76MB |
| Maple Mono CN 全字重 zip | **134.28MB** |
| Sarasa Gothic SuperTTC | 135.78MB(7z) / 385.70MB(zip) |

> **M0 修正**：早期估算把 18.40MB 当成单变体体积，实际那是 4 个变体的总和。**只引一个变体时成本是 4.33–4.87MB，约为原估的 1/4**——这让「分片懒加载」相对「精简子集改名」的优势明显扩大（见 §5 D1）。

包版本 `v1.250.2`。全量打包几套中文字体，安装包仍会轻松破 100MB，直接违背「轻量」核心诉求——**按需引入单个变体是硬约束，不是优化项**。

#### M0 实测出的三个坑（已写进代码注释）

1. **family 名冲突**：`lxgwwenkaiscreen.css` 与 `lxgwwenkaigbscreen.css` 声明的是**同一个** family `'LXGW WenKai Screen'`（两个 `*r.css` 同理都叫 `'LXGW WenKai Screen R'`）。包自带的 `style.css` 会 @import 全部四个 → **194 条同名 `@font-face` 互相覆盖**，渲染结果不可预期。**必须只 import 一个变体的 css**，`src/styles.css` 已如此处理。
2. **只有 400 字重**：97 个 `@font-face` 全部 `font-weight: 400`，**没有 Bold**。Markdown 的 `**加粗**` 只能靠浏览器合成伪粗（faux bold），笔画会发糊。若要真字重，得改用霞鹜文楷主系列（Light / Regular / Medium）。→ 验收项 #8 已答复。
3. **不存在 Mono 的 webfont 包**：`npm view lxgw-wenkai-mono-webfont` 返回 404。§1.9「字体分工建议」里「代码区用 Screen Mono」这条路**要么自己从 24.44MB TTF 切分分片，要么放弃**。

#### 方案：WOFF2 分片 + unicode-range 懒加载（推荐，M0 已验证）

1. 直接 `@import` `lxgw-wenkai-screen-webfont` 里**单个变体**的 css（97 个 woff2 分片，4.33–4.87MB）。不需要自己切，包已按 Unicode 区块切好，粒度足够细（如 `U+1f300-1f357`）。
2. 每个分片自带 `unicode-range`，浏览器只在页面出现对应字符时才请求该分片。
3. Tauri 侧无需自定义协议——分片走 vite 打包产物，`asset:` 协议直接可用。M1 若要按需下发，再考虑 `vela://font/...`。

优点：不改名、合规最干净、首屏快、覆盖完整。
代价（**M0 实测**）：

- 安装包 **+4.33MB**（单变体），不是原先估的 +18MB。
- **194 条 `@font-face` 声明本身进首屏 CSS：67.8KB gzip**。这是分片懒加载方案的固定开销，精简子集方案只需 1 条声明。已计入 §2.9 预算。
- 首屏实际只请求拉丁 + 常用汉字区块，实测远低于 1MB。

**备选方案**：精简子集（GB2312 常用 7000 字 + 拉丁，woff2 约 4–6MB），生僻字 fallback 系统 PingFang。**代价是必须改名为 "Vela Kai"**（RFN 规则），且生僻字/扩展区汉字会掉到系统字体，视觉断层明显。

> **M0 后的倾向**：单变体实测只有 4.33MB，与精简子集的 4–6MB **体积已经持平**，但分片方案不用改名、覆盖完整、无视觉断层。**分片懒加载的优势从「略好」变成「明显」**。仅剩的劣势是那 67.8KB gzip 的 CSS 声明开销。
>
> ⚠️ **待决策**：D1 见 §5。

#### 字体分工建议

| 区域 | 字体 | 理由 |
|---|---|---|
| 代码编辑区 | **Maple Mono CN**（可变字体，官方声明完美 **2:1** CJK:Latin，OFL 1.1） | 严格等宽，列对齐可靠 |
| Markdown 正文 / 预览 | **LXGW WenKai Screen** | 楷体手感，长文阅读舒适 |
| UI 界面 | LXGW WenKai Screen R（或系统字体，更省体积） | — |
| ~~代码区备选~~ | ~~LXGW WenKai Screen **Mono**~~ | ❌ **无 webfont 包**（npm 404）。要用得自行从 24.44MB TTF 切分分片，M0 判定不划算 |

> ⚠️ **重要澄清（M0 已结项）**：
> - LXGW WenKai Screen 的拉丁字符基于 Inconsolata（等宽），但仓库 **README 未声明 CJK:Latin 是严格 2:1 比例**。因此非 Mono 变体用于代码区仍可能出现列对齐漂移 → 这正是 M0 验收项 #3「列对齐测试台」要人工判定的东西，`ProbePanel.tsx` 里已备好含制表符/歧义宽字符/生僻字/emoji 的对照样本。
> - **字重问题已有答案：只有 `font-weight: 400`，没有 Bold**。原先两次抓取结论不一致的悬案结项。影响：Markdown 加粗只能伪粗，需在 M3 评估观感是否可接受，或改用主系列（Light/Regular/Medium，但那三个都没有 Screen 优化）。

#### 内置可切换字体清单

- LXGW WenKai Screen GB（默认，97 分片 / 4.33MB）
- LXGW WenKai Screen R（97 分片 / 4.87MB，与 GB 二选一，**不可同时引入**——family 同名）
- Maple Mono CN（代码推荐）
- JetBrains Mono + Noto Sans CJK fallback
- Sarasa Gothic Mono SC（**License 需人工核对**：GitHub API 返回 NOASSERTION，仓库 LICENSE 是多字体组合声明，官方口径为 OFL 1.1）

除默认字体外，其余建议**按需下载**而非全部打包，以守住体积预算。M0 脚手架的字体下拉已按「GB / R / 系统等宽（对照组）」三档实现，正好用于对比 CJK webfont 对滚动性能的影响。

---

## 2. 技术方案

### 2.1 选型总表

| 层 | 选型 | 版本 | License | 备选 / 备注 |
|---|---|---|---|---|
| 应用框架 | **Tauri** | 2.11.5（锁定） | Apache-2.0 / MIT | ⚠️ Tauri 3.0.0-alpha.0 于 2026-09-13 发布，milestone 仅 29%、无 due date、Linux 迁 GTK4（破坏性）→ **不升** |
| 编辑器内核 | **CodeMirror 6** | latest | MIT | Monaco（体积 5× 且无 Markdown AST）、Ace（BSD-3，扩展性弱） |
| 语法解析 | **Lezer** | — | MIT | tree-sitter WASM 大一个数量级（ts grammar 2.29MB），不用于前端 |
| 前端框架 | **Solid** | 1.9.x | MIT | Svelte 5（次选，生态更厚）、React（被迫选项，仅当必须用 headless-tree） |
| 构建 | **Vite** | latest | MIT | ⚠️ 已知「dev 正常、生产构建炸」陷阱，M0 验证 |
| UI 组件 | **Kobalte** + **Ark UI Tree View** | — | MIT | `cmdk-solid` 做命令面板 |
| CSS | **纯 CSS Variables** | — | — | Tailwind v4 可选，桌面端收益有限 |
| 文本 rope | **ropey** | 1.6.1 | **MIT** | 仅用于超大文件只读分片 |
| 目录监听 | **notify** | 8.2.0 | CC0-1.0 | 9.0.0-rc.5 有三项 macOS FSEvents 专项优化，M4 评估切换 |
| 遍历与忽略 | **ignore** | 0.4.33 | Unlicense OR MIT | ripgrep 同款 `WalkBuilder` |
| 全文搜索 | **grep-searcher / grep-regex / grep-matcher / grep-cli** | 0.1.x | Unlicense OR MIT | crate 源码仅 16–74KB，体积影响可忽略 |
| 会话存储 | **rusqlite** 或 **sled** | — | MIT / Apache | M1 决定 |
| 异步 | **tokio** | — | MIT | — |

### 2.2 为什么是 CodeMirror 6（两路调研结论冲突的裁决）

开源项目盘点一路建议 Monaco，理由是 sidex 与 athas 两个最成熟项目都用它、生态验证充分。选型一路拿到实测体积后结论相反。**本方案采纳 CM6**，依据如下：

| 维度 | CodeMirror 6 | Monaco |
|---|---|---|
| min+gzip | **75KB（最小配置）/ 135KB（全功能）** | **598KB**（核心 chunk `editor-KLE6jdfb.js` 2.39MB）+ CSS 116KB |
| npm 解包总量 | ~8.23MB | **93.4MB**（`min/` 目录 23.3MB） |
| Markdown | `@lezer/markdown` 给**真 AST** + GFM 扩展 + 嵌套语言插槽 | 仅 6.5KB 正则 monarch tokenizer，**无 AST** |
| 扩展体系 | 函数式 facet/extension，Decoration、StateField、gutter 皆一等公民 | API 自动生成、文档差、扩展面窄 |
| Web Worker | **无依赖** | Tauri+Vite 下 worker 跨源加载是已知麻烦（vite#12662） |
| 中文 IME | — | 有「行跳动」issue（#4592），修复依赖的实验性选项已被标记 duplicate 关闭 |
| License | MIT | MIT |

**决定性论据**：**Obsidian 自己就是 CodeMirror 6**，其 Live Preview 是 CM6 装饰层。既然产品要对标 Obsidian 的可扩展性，用同一个内核是最短路径。Replit、Sourcegraph 也都从 Monaco 迁到 CM6，理由正是「可扩展性 + 无需 monkey-patch」。

Monaco 唯一的优势是「开箱即得的 IDE 感」，但那正是 Vela 刻意不做的部分（无 LSP）。

### 2.3 前端框架

运行时体积（bundlephobia 实测 min / gzip）：

| 框架 | min | gzip |
|---|---|---|
| **Solid 1.9.15** | 22.4KB | **8.4KB** |
| Preact 10.29.8 | 11.8KB | 4.8KB |
| Svelte 5.57.0 | 36.9KB | 13.6KB |
| Vue 3.5.42 | 122.5KB | 46.4KB |
| React 19 | react + react-dom + scheduler 三包叠加 | 明显更重 |

**选 Solid 的实质理由不只是体积**：它无虚拟 DOM，与 CM6 这类自己管 DOM 的命令式库集成时边界最干净——不会出现「框架想重渲染、CM6 想自己管 DOM」的打架。这对编辑器类应用是结构性优势。

配套组件：
- 命令面板：`cmdk-solid` 1.2.0（基于 `@kobalte/core`）
- 文件树：`Ark UI` Tree View（支持 lazy loading + virtualization，多框架）
- 备选：`headless-tree`（898★，虚拟化 + 拖拽 + 键盘导航）**仅 React** → 若坚持用它则被迫选 React，不划算

#### M0 踩坑记录：Vite 8 已换 rolldown（构建配置有破坏性变化）

Vite 8.3.0 底层打包器是 **rolldown（Rust），不是 rollup**。三处会直接咬人：

1. **`output.manualChunks` 只接受函数形式**。传对象会报 `Invalid type: Expected Function but received Object` 然后 `TypeError: manualChunks is not a function`。
2. **esbuild 不再是内置依赖**。`build.minify: 'esbuild'`（Vite 5–7 的默认值）会抛 `Failed to load transformWithEsbuild ... Cannot find package 'esbuild'`。改用 **`minify: 'oxc'`**（rolldown 自带，无需额外安装）。
3. **粗粒度 manualChunks 会摧毁 CM6 的懒加载分包**——这是 M0 最贵的一课：

   `@codemirror/language-data` 靠**动态 import** 实现几十种子语言的懒加载。一旦用 `id.includes('@codemirror')` 这种粗匹配把它和它依赖的 `legacy-modes` 强制合并进静态 chunk，动态边界就全没了。

   | | 首屏 gzip | dist 里 JS/CSS 文件数 |
   |---|---|---|
   | 手动 manualChunks（错误） | **623 KB**（单个 codemirror chunk 就 540.2KB） | 3 |
   | 交给 rolldown 自动分包（正确） | **284.4 KB** | 114（376.7KB 子语言被正确推迟） |

   **结论：这个项目里不做手动 manualChunks，是硬约束不是偏好。** 理由已写成注释钉在 `vite.config.ts` 里，防止将来有人「优化」回去。M1 接 30+ 语言时，这条决定了首屏会不会爆。

### 2.4 文档模型归属（关键架构决策）

| 方案 | 优点 | 缺点 | 采用者 |
|---|---|---|---|
| **前端持有**（CM6 `Text` rope） | 编辑零 IPC 延迟、实现简单、撤销/多光标天然可用 | 超大文件吃前端内存 | Obsidian、hermes-ide |
| Rust 侧持有（`ropey`）+ CRDT 同步 | 支持超大文件、多视图、协同编辑 | 复杂度陡增、每次按键过 IPC | Zed、Lapce |

**Vela v1 选前端持有。** Rust 侧职责收窄为：
- **打开**：读文件 → 一次性传字符串给前端（>50MB 走分片）
- **保存**：接收全文 → 编码转换 → 原子写入（临时文件 + rename）
- **搜索**：完全在 Rust 侧，流式推结果
- **监听**：`notify` 事件推送

`ropey` 仅在**超大文件只读分片模式**下启用：Rust 侧持有全文，前端按可视窗口请求 `[startByte, endByte]` 分片，禁用编辑。

> **推论**：绝不在 IPC 里传整个大文件。JSON 序列化一个 50MB 字符串会直接爆内存。这是 Tauri 编辑器场景的头号性能陷阱。

### 2.5 Rust 侧架构

```
vela-core/
├── fs/          文件读写、编码探测(UTF-8/GBK/BOM)、原子写入、大文件分片读取
├── search/      grep-searcher + grep-regex + ignore::WalkBuilder，流式结果通道
├── watcher/     notify + notify-debouncer-full，事件合并与抖动抑制
├── project/     多根工作区、.vela/settings.json 分层合并、最近项目
├── session/     会话持久化（标签/光标/滚动/未保存草稿）
├── tools/       重计算工具的 Rust 实现：哈希、图片处理、编码转换
└── ipc/         Tauri command / event 定义，与前端共享 TS 类型生成
```

**值得借鉴的架构模式**（借鉴思想，不复制代码）：
- **Lapce**（Apache-2.0）：`lapce-app` / `lapce-proxy` / `lapce-rpc` 的前后端分离 + RPC 分层。注意其 tree-sitter 锁在 0.22.6（当前 0.27.0），且最近提交几乎全是依赖 bump 与 CI 修复 → 已进入维护模式，**不要依赖其演进**。
- **athas**（AGPL-3.0，代码不可用）：后端 14 个 crate 的划分（`ai`/`database`/`debugger`/`extensions`/`fff-search`/`github`/`lsp`/`project`/`remote`/`runtime`/`terminal`/`tooling`/`version-control`/`wsl`）与 `extensions/{sdk,schema,official,community}` + `artifacts.json` 的插件分层，是现成的好范式。**AGPL 只限制复制代码，不限制借鉴架构思想。**
- **sidex**（MIT，可复用）：唯一 License 干净且功能完整的 Tauri 编辑器脚手架。实测 16.4MB（vs VS Code 797.8MB），macOS 空转内存目标 <200MB。但它是「重型 VS Code workbench 移植」且带一个 Go 子进程（`sidexai/sidex-server`），与 Vela 定位相反 → **当架构参考答案，不 fork**。

### 2.6 IPC 协议

**两种通道，职责分离**：

| 通道 | 用途 | 特性 |
|---|---|---|
| Tauri `command`（invoke） | 请求/响应：读写文件、执行工具、查配置 | 一次性，需控制 payload 大小 |
| Tauri `event`（emit/listen） | 流式：搜索结果分批、文件变更通知、大文件分片、长任务进度 | 可取消（返回 cancel token） |

**设计约束**：
1. 单次 IPC payload **上限 4MB**。超出必须分片或走流式 event。
2. 所有 command 生成对应的 TypeScript 类型（用 `specta` + `tauri-specta`，或手写 codegen），杜绝前后端类型漂移。
3. 长任务（全局搜索、大文件读取）一律返回 `taskId`，通过 event 推进度，支持前端取消。
4. 文件内容传输统一走 **字节 + 编码元信息**，不在 Rust 侧强行转 String（避免非法 UTF-8 崩溃）。

### 2.7 命令中心与插件预留

**这是架构核心。** 「预留插件接口、暂不开放」的落地方式不是做一套插件框架，而是**让所有内部功能都走同一个注册表**。

```ts
interface CommandDefinition {
  id: string                    // 分层命名：'editor.fold' / 'tool.json.format' / 'view.toggleSidebar'
  title: string
  category: string
  icon?: string
  keybinding?: string | string[]
  when?: (ctx: AppContext) => boolean   // 上下文条件，决定命令是否可用/可见
  run: (ctx: AppContext) => void | Promise<void>
}

const registry = createCommandRegistry()
registry.register({ ... })
```

**编辑器操作、内置工具、面板开关、主题切换——全部是命令。** 命令面板、菜单栏、快捷键绑定、侧边栏按钮都只是这个注册表的不同视图。

将来开放插件 = 允许第三方 JS 调用同一个注册表，**零重构成本**。

#### `vela.*` 桥对象（唯一对外 API 面）

```ts
const vela = {
  version: '1.0.0',
  commands: { register, execute, list },
  editor:   { getActive, getText, setText, replaceSelection, onDidChange },
  workspace:{ getRoots, readFile, writeFile, onFileChange },
  tools:    { register },
  ui:       { registerPanel, showToast, openToolPanel, registerTheme },
}
```

**设计纪律**：
- API 面**从第一天就极小**。发布即冻结，之后只能加不能改。
- 仿 Obsidian 的 `minAppVersion` 做版本协商。
- 宿主侧保留一层 shim（适配层）承接未来的 breaking change。
- 紧急情况下可按插件 id 下发禁用名单（若将来做 registry）。

#### 插件运行时路线（将来开放时）

调研结论（人日按 1 名熟练全栈全职计）：

| 档位 | 方案 | 累计人日 | 说明 |
|---|---|---|---|
| **L1** | webview 内 JS，**无沙箱**（Obsidian 同款） | **5–10** | 与 CM6 同上下文，**零桥接**。插件即目录：`manifest.json` + `main.js` + `styles.css` |
| **L2** | L1 + 权限声明 + 市场 + 生命周期管理 UI | 15–30 | 市场可仿 `obsidian-releases/community-plugins.json`（PR + 人工审核）压缩工作量 |
| **L3** | 隔离沙箱（QuickJS `rquickjs` 0.13.0 / Wasm `extism` 1.30.0） | 35–70 | 光 Rust↔webview 双向桥就要 8–12 人日；沙箱内**摸不到 DOM**，不适合暴露 keystroke 级编辑器事件 |

**已排除**：Deno/V8（`rusty_v8` 使二进制增大数十 MB，与「轻量」直接冲突）、proxy-wasm（网络代理 ABI，不适用）、wasmCloud（分布式运行时，过重）。

**建议：v1 只做 M5（接口收敛），把 L1 留到有真实生态需求时。**

**启动性能对策**：N 个插件 = 启动时多解析执行 N 份 bundle。必须**懒激活**——manifest 声明激活时机，命令首次触发才加载（Obsidian 即如此）。

### 2.8 字体加载管线

**M0 实际落地的管线**（比原设想简单得多——不需要自己切分，也不需要自定义协议）：

```
构建期：
  npm 包 lxgw-wenkai-screen-webfont（已按 Unicode 区块切好，单变体 97 分片 / 4.33MB）
    → src/fonts/loader.ts 用动态 import() + vite `?inline` 引入**单个变体**的 css
    → rolldown 为每个变体生成独立懒加载 chunk（实测各 30.5KB gzip）
    → vite 重写 chunk 内的 url() 为带 hash 的 /assets/*.woff2，并 emit 分片文件
    → assetsInlineLimit 对 .woff2 强制 return false（见 R17，否则小分片会被 base64 内联，
      击穿 unicode-range 懒加载）

运行期：
  用户选中变体 → applyFontVariant() 拉取对应 chunk（首次网络/磁盘，之后命中模块缓存）
              → 整块替换 <style id="vela-font-faces"> 的 textContent（不追加，见 R14）
              → 覆写 --vela-font-editor / --vela-font-ui
              → webview 遇到字符 → 匹配 unicode-range → 只请求命中的那几个 woff2
```

**原设想过时了两点**，记录在此避免有人按旧文档实现：

1. ~~「用 fonttools/glyphhanger 自己切 388 个分片」~~ → 包内已有切好的产物，粒度足够细（如 `U+1f300-1f357`），自己切是纯浪费。**388 是 4 个变体的总数，单变体是 97。**
2. ~~「通过 `vela://font/<shard>.woff2` 自定义协议加载」~~ → 不需要。分片走 vite 常规资源管线，Tauri 的 `asset:` 协议直接可用。M1 若要做字体按需下发（不打包、运行时下载）再引入自定义协议。

**首屏不阻塞**：编辑器挂载与字体注入并行触发，编辑器不等字体；字体到达后靠包内已声明的 `font-display: swap` 重排。这样冷启动计时（验收项 #6）不含字体成本。注入前的兜底字体栈是系统等宽，不会出现无字体空窗。

**合规要点**：仅 TTF → WOFF2 转换与分片，**字形数据不变**，按 OFL FAQ 2.2 无需改名，可继续叫 LXGW WenKai。若做子集化（删字形）则触发 FAQ 2.6，必须改名。本项目走的是分片路线，**不改名**。

字体切换：`--vela-font-editor` / `--vela-font-ui` 两个 CSS Variable，由 loader 在注入时一并覆写，切换即生效、无需重启。M4 的主题系统会接管这些变量。

### 2.9 性能与体积预算

**硬性预算**（M0 建立基线，每阶段末回归测量）：

| 指标 | 预算 | M0 实测 | 参照 |
|---|---|---|---|
| 安装包体积（.dmg） | **≤ 40MB** | 待 M6 | Tauri 空壳 8.6MB + 字体分片 **4.33MB** + 前端 ~2MB + Rust 二进制 ~8MB |
| 冷启动到可输入 | **< 1s** | 待窗口实测 | — |
| 空转常驻内存（macOS） | **< 200MB** | 待窗口实测 | Tauri 基准 ~172MB；Electron 为 ~409MB |
| 打开 10 万行文件 | **< 2s**，滚动 60fps | 待窗口实测 | — |
| 全局搜索（10 万文件仓库） | **首批结果 < 2s** | M2 | ripgrep 级 |
| 前端 bundle（gzip） | **≤ 300KB** | ✅ **218.5KB**（余量 27%，D7 实施前是 284.4KB / 余量 5%） | CM6 135KB + Solid 8.4KB + cmdk-solid 14.9KB + 业务代码 |
| 按键到屏幕延迟 | **< 16ms** | 待窗口实测 | 不可感知 |

**M0 构建产物明细**（`pnpm build`，D7 实施后）：

| 文件 | min | gzip | 说明 |
|---|---|---|---|
| `index-*.js` | 316K | 113.0 KB | 入口：Solid + 应用代码 + CM6 基础扩展 |
| `dist-*.js`（modulepreload） | 328K | 104.3 KB | CM6 内核 |
| `index-*.css` | ~5K | **1.2 KB** | 应用自身样式（字体声明已移出） |
| **首屏合计** | | **218.5 KB** | |
| `lxgwwenkaigbscreen-*.js` | 90.6K | 30.5 KB | 字体变体 GB，**懒加载 chunk**，选中才拉 |
| `lxgwwenkaiscreenr-*.js` | 90.7K | 30.5 KB | 字体变体 R，同上 |
| 112 个子语言 chunk | | 376.7 KB | 懒加载，**不进首屏** |
| 194 个 woff2 | | 9.6 MB | 两变体各 97 片；**发布时只保留一个 → 4.33MB** |

> ✅ **D7 已实施：字体 `@font-face` 改为运行时按需注入。** 首屏 gzip **284.4 → 218.5 KB**（省 65.9 KB / 23%），其中首屏 CSS 从 **67.8 KB 砍到 1.2 KB**。
>
> 实现方式见 `src/fonts/loader.ts`：动态 `import()` + vite `?inline`，每个变体成为独立 chunk，注入时**整块替换** `<style id="vela-font-faces">` 而非追加——这样任一时刻只驻留一个变体，顺带根治了 R14 的同名 family 冲突。编辑器挂载不等字体（并行触发），靠 `font-display: swap` 重排，冷启动计时不被拖慢。
>
> **需要澄清一个当时没说准的地方**：这次改造省的**不是总字节数**——把 CSS 文本搬进 JS bundle，gzip 一样大。真正省的是两件事：① 离开首屏关键路径（CSS 阻塞首次绘制，动态注入的 `<style>` 不阻塞）；② 常驻量减半（只驻留选中的那个变体）。原估「腾出 ~58KB」按「首屏 CSS 产物减少」算是成立的，但别误读成总体积变小了。
>
> **实施中发现的新坑**：vite 默认 `assetsInlineLimit: 4096` 会把小分片转成 base64 data URI。GB 变体有 2 个中招（3.9KB → base64 5.2KB）。**这看着无害，实际击穿了 unicode-range 懒加载**——data URI 的字节已随 CSS chunk 下载，浏览器没法因为「页面上没这些码点」而跳过请求，而分片架构的前提恰恰就是不请求。且哪些分片低于阈值取决于字体包的切分方式，包一升级就悄悄变化。已在 `vite.config.ts` 用函数形式对 `.woff2` 强制返回 `false`，两个变体 chunk 随即对称（各 97 条 url 引用 / 30.5 KB gzip）。

**内存优化手段**：
- 文件树懒加载，绝不在内存里建全量树
- 搜索结果流式推送 + 前端虚拟列表，不一次性渲染上万条
- `@codemirror/language-data` 子语言懒加载（**M0 已验证生效**，前提是别手动 manualChunks，见 §2.3）
- 关闭标签页时彻底释放 EditorView（CM6 的 `destroy()`，注意别泄漏 StateField 订阅）
- 字体分片按需加载，不预载

### 2.10 License 合规

**用户已确认：闭源，可能商业化。** 因此以下代码**一行都不能碰**：

| 项目 | License | 为什么不能用 |
|---|---|---|
| **Zed** | 编辑器核心 crate（`text`/`multi_buffer`/`editor`/`language`/`rope`/`lsp`）全部 **GPL-3.0-or-later**；仅 `gpui` 是 Apache-2.0 | Rust 静态链接进二进制即构成衍生作品，整个发行物必须 GPL 开源。而 Apache 的那个 `gpui` 是原生 GPU 渲染框架，与 Tauri webview 架构根本冲突 |
| **athas** | **AGPL-3.0**（GitHub API 误标 NOASSERTION，实际 LICENSE 首行为 AFFERO） | 比 GPL 更严，网络服务使用也触发源码公开义务 |
| **hermes-ide** | **BUSL 1.1**，Additional Use Grant **明文排除** "design or marketed as a code editor, terminal emulator, or IDE" 的竞品用途；Change Date = 每次发布后 3 年，之后转 Apache-2.0 | Vela 正好落在被排除的定义内 |
| MarkFlowy / markra / RapidRAW / Fluxium | AGPL-3.0 / GPL-3.0 | 同上 |

**可安全复用**：

| 资产 | License |
|---|---|
| sidex | MIT |
| Lapce 全部 / floem / `floem-editor-core` | Apache-2.0 / MIT |
| xi-editor rope | Apache-2.0 |
| **ropey 1.6.1** | **MIT**（已核实 Cargo.toml `license` 字段） |
| CodeMirror 6 / Monaco / Solid / Vite / Kobalte / Ark UI / cmdk | MIT |
| Ace | BSD-3-Clause |
| `ignore` / `grep-*` | Unlicense OR MIT |
| `notify` | CC0-1.0 |
| Helix | **MPL-2.0**（文件级弱 copyleft：不改其源文件、仅借鉴设计则闭源集成可行） |
| LXGW WenKai / Maple Mono / JetBrains Mono / Noto Sans CJK | OFL 1.1 |
| Sarasa Gothic | ⚠️ **需人工核对 LICENSE 全文**（GitHub API 返回 NOASSERTION，仓库为多字体组合声明，官方口径 OFL 1.1） |

**sidex 的隐性风险**（若参考它）：MIT 覆盖代码本身（microsoft/vscode 源码仓库确为 MIT），但 ① 品牌上不能使用 "Visual Studio Code" 名义（微软的产品名与二进制是专有的，只有源码 MIT）；② 微软 Marketplace ToS 禁止非 VS Code 客户端接入——sidex 已正确改用 **Open VSX** 规避。**正式商用前建议法务复核。**

**内置主题配色**：逐个核对 License（多为 MIT，但 Dracula/One Dark 等需确认其具体条款）。

---

## 3. 实施计划

### 3.1 阶段总览

| 阶段 | 名称 | 人日 | 累计 | 里程碑产出 |
|---|---|---|---|---|
| **M0** | 技术验证冲刺（风险闸门） | 3 | 3 | 可行性结论 |
| **M1** | 编辑器内核 | 10–12 | 13–15 | **可日用的单文件编辑器** |
| **M2** | 项目与搜索 | 8–10 | 21–25 | 能开真实仓库 |
| **M3** | Markdown + 内置工具 | 10–12 | 31–37 | 差异化功能成型 |
| **M4** | 主题、字体、打磨 | 6–8 | 37–45 | 视觉与性能达标 |
| **M5** | 插件接口收敛 | 3–5 | 40–50 | API 边界冻结 |
| **M6** | 打包发布 | 3–4 | **43–54** | v1.0 可分发 |

按 1 名熟练 Rust+TS 全栈全职计，约 **9–11 周**。
**M1 结束（第 3 周末）即有能日用的编辑器**——建议从那时起 dogfooding，边用边改。

---

### 3.2 M0 · 技术验证冲刺（3 人日）— 风险闸门

> **这是整个计划里最重要的 3 天。** 两个未解决的生态级风险必须现在验证，而不是三个月后。
> **原则：M0 不通过，不进入 M1。**

**做什么**：Tauri 2.11.5 + Solid + Vite + CM6 的最小空壳，打开一个一万行文件，能滚、能打中文。不写任何业务功能。

| # | 验收项 | 通过标准 | 当前状态 | 不过的备选方案 |
|---|---|---|---|---|
| 1 | **WKWebView 滚动手感** | 万行文件滚动无肉眼卡顿，主观手感可接受 | ⏳ **待人工判定**（探针面板已备 5s FpsSampler + 10k/20k/50k 行 fixture + wrap 开关） | 存在 open issue（tauri-apps/discussions#8436）报告 macOS 上 Tauri 滚动有微延迟而 Safari 无，**无根因、无修复结论**。对策：试 `macOSPrivateApi`；把滚动容器交给原生；**极端情况下重估 Tauri 路线** |
| 2 | **中文 IME** | 输入无行跳动、候选框不错位、长句连续输入不丢字 | ⏳ **待人工判定**（已备原生 textarea 对照组，用于区分是 CM6 的问题还是 WKWebView 的问题） | 调整 CM6 `inputStyle`（`contenteditable` vs `textarea`）；参考 Monaco #4592 的教训 |
| 3 | **字体列对齐** | ~~Screen Mono 下~~ 中英文表格 / ASCII art 对齐正确 | ⏳ **待人工判定**。⚠️ **原判据失效**：Screen Mono 无 webfont 包（R14 同源发现），改为直接测 Screen GB 的实际漂移量，据此定 D2 | 代码区换 Maple Mono CN（官方声明 2:1）—— **这已基本成为唯一可行解** |
| 4 | **字体分片管线** | 首屏实际加载 **< 2MB**；随机生僻字能正确触发分片加载 | ✅ **通过**。懒加载生效：192 个 woff2 共 9.6MB 在盘，但首屏只请求实际用到的分片。探针用 `performance.getEntriesByType('resource')` 过滤 `.woff2` 求和，可量化。<br>⚠️ 附带发现 67.8KB gzip 的 `@font-face` CSS 开销 → R15 | 换精简子集方案（需改名 Vela Kai） |
| 5 | **生产构建** | `vite build` 后 CM6 **完全正常**（不是只在 dev 正常） | ✅ **通过，且这个验收项救了一次**。构建确实踩中三个坑（rolldown manualChunks 形式、esbuild 不再内置、粗分包摧毁懒加载），首屏 gzip 一度 623KB，修复后 **284.4KB / 114 chunk**。详见 §2.3 | 有已知「Tauri + Vite + CM6: Works in Dev, Breaks in Production Build」陷阱。排查分包、worker、动态 import 配置 |
| 6 | **冷启动** | 空窗口到可输入 **< 1s** | ⏳ **待窗口实测**。已埋三段计时：Rust 进程启动（`PROCESS_START`）、`index.html` 内联 `__VELA_T0`、应用挂载 | 削减启动路径、延迟非关键扩展加载 |
| 7 | **空转内存** | **< 200MB** | ⏳ **待窗口实测**。`probe_memory` 命令已实现（Rust 侧走 `ps -o rss=`，避免 M0 阶段引入 `sysinfo` 增加编译负担），前端侧读 `performance.memory` | 参照 Tauri 基准 ~172MB |
| 8 | **字体字重核实** | 确认 Screen 版实际提供几档字重（两次抓取结论冲突） | ✅ **已结项：只有 `font-weight: 400`，无 Bold**。97 个 face 全部 400 → 转为 R16 | 粗体需浏览器合成（faux bold）或改用主系列 LXGW WenKai |

**产出**：一份《M0 验证报告》，逐项记录实测数据与结论。**这份报告决定项目是否继续按 Tauri 路线走。**

#### 脚手架现状（工具链三条腿）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0（修掉 5 个错误后） |
| `cargo check` | ✅ EXIT=0，173 个 rlib 依赖 |
| `pnpm build` | ✅ EXIT=0，538ms，首屏 284.4KB gzip |
| `pnpm app:dev` | ✅ 27.21s 编译完成，窗口已启动 |

**踩坑记录**：`bundle.icon: []` **不能**绕过图标要求——`tauri::generate_context!()` 在编译期无条件打开 `src-tauri/icons/icon.png`，缺失会让 proc macro panic。已用 `scripts/gen-icon.mjs`（纯 node+zlib 手写 PNG，512×512 船帆座图形，5.4KB）解决，避免为一个占位图标引入图像库依赖。

**剩余工作**：#1 #2 #3 #6 #7 五项需要**在真实 WKWebView 窗口里人工判定**——这几项恰恰是 M0 存在的理由（R1 是 🔴 高风险，动摇整个 Tauri 路线），不能用 Chromium 侧的自动化指标替代。注意窗口隐藏/最小化时 rAF 会被冻结，FpsSampler 读数会失真，测量时必须保持窗口可见。

---

### 3.3 M1 · 编辑器内核（10–12 人日）

**目标**：一个能日常使用的单文件编辑器。

| 工作项 | 人日 | 要点 |
|---|---|---|
| 项目脚手架 | 1 | Tauri 2.11.5 + Solid + Vite + TS 严格模式；`vela-core` crate 骨架；ESLint/Prettier/rustfmt/clippy；CI（build + test） |
| **命令注册中心** | 1.5 | **架构地基，必须 M1 就立起来**。含 `when` 上下文求值、快捷键绑定与冲突解析、命令面板数据源 |
| CM6 封装层 | 2 | EditorView 生命周期管理、扩展组合、与 Solid 的边界隔离（**关键：别让 Solid 碰 CM6 的 DOM**）、多实例（分屏）管理、`destroy()` 防泄漏 |
| 多光标全套 | 1.5 | `Cmd+D`、`Cmd+Shift+L`、`Alt+Click`、列块选择、多光标下的查找替换 |
| 文件 IO | 1.5 | 打开/保存/另存为、编码探测（UTF-8/GBK/BOM）、LF/CRLF、原子写入、脏标记、外部改动检测 |
| 查找替换 | 1 | 正则、整词、保留大小写替换、查找选中词 |
| 编辑基本功 | 1 | 括号匹配、自动缩进、缩进引导线、代码折叠、行操作、排序去重 |
| 词补全 | 0.5 | 当前文档 + 项目词典 |
| 标签页 + 分屏 | 1.5 | 多标签、拖拽重排、水平/垂直分屏、聚焦切换 |
| 会话恢复 | 1 | 标签、光标、滚动位置、未保存草稿持久化（rusqlite/sled） |
| 语言高亮 | 0.5 | `@codemirror/language-data` 接入，子语言懒加载 |
| 状态栏 + 基础 UI | 0.5 | 行列、编码、换行符、语言、缩进、字数 |

**验收**：能用它替代 Sublime 完成「改配置文件、看日志、快速搜索替换」的日常闭环。冷启动 < 1s，空转内存 < 200MB。

---

### 3.4 M2 · 项目与搜索（8–10 人日）

**目标**：能打开真实仓库并使用。

| 工作项 | 人日 | 要点 |
|---|---|---|
| 文件树 Rust 侧 | 1.5 | 按需 `read_dir`（**绝不建全量树**）、`ignore::WalkBuilder` 遵守 .gitignore、排序规则（文件夹优先/类型分组） |
| 文件树前端 | 2 | 虚拟化列表、展开折叠状态持久化、`node_modules`/`.git`/`dist` 默认折叠、右键菜单（新建/重命名/删除/在 Finder 中显示/复制路径） |
| 全局搜索 | 2.5 | `grep-searcher` + `grep-regex`，**流式 event 推送**，按文件分组、上下文预览、include/exclude glob、可取消 |
| 全局替换 | 1 | 预览所有变更 → 确认 → 批量应用，支持正则 |
| Goto Anything | 1 | `Cmd+P` 模糊找文件（fuzzy match + 最近使用加权）、`Cmd+R` 文件内符号（Lezer AST）、`Cmd+G` 跳行 |
| 工作区管理 | 1 | 多根工作区、`.vela/settings.json` 分层合并、最近项目、`Cmd+Shift+O` |
| 文件监听 | 1 | `notify` 8.2.0 + `notify-debouncer-full` 抖动合并，外部改动提示重载，冲突处理 |
| 大文件只读分片 | 1 | `ropey` 持有全文，前端按可视窗口请求分片，禁用编辑并给出提示 |

**验收**：打开一个含 `node_modules` 的真实前端仓库（10 万+ 文件），侧边栏秒开不卡，全局搜索首批结果 < 2s。

---

### 3.5 M3 · Markdown + 内置工具（10–12 人日）

**目标**：差异化功能成型——这是 Vela 区别于普通编辑器的地方。

#### Markdown（4–5 人日）

| 工作项 | 人日 |
|---|---|
| 分屏预览 + 同步滚动（AST 源位置映射） | 2 |
| 大纲面板（标题层级导航 + 折叠 + 点击跳转） | 0.5 |
| 表格自动对齐 + GFM 任务列表可点击回写 | 1 |
| **图片粘贴自动落地**（存 `assets/` + 插相对路径，路径与命名可配置） | 0.5 |
| 链接补全、字数/阅读时长统计、导出 HTML | 1 |

#### 内置工具 P0（6–7 人日）

| 工作项 | 人日 |
|---|---|
| 通用 `ToolPanel` 组件（左右分栏 + 声明式选项条 + 复制结果 + 与编辑器互通） | 2 |
| 格式化类 5 个（JSON 格式化/压缩、JSON↔YAML、SQL、XML/HTML、Markdown 表格） | 1.5 |
| 编解码类 5 个（Base64 文本/图片、URL、HTML 实体、JWT、Unicode 转义） | 1 |
| 生成器类 3 个（UUID/ULID/NanoID、哈希走 Rust 侧、时间戳互转） | 1 |
| 测试器类 3 个（正则测试器、文本 Diff、JSONPath） | 1 |
| 文本类 2 个（命名风格转换、Cron 解析） | 0.5 |
| **智能检测**（粘贴内容自动识别并推荐工具） | 0.5 |

**验收**：JSON 格式化、时间戳转换、正则测试三个高频工具的操作路径 **≤ 2 次按键**（`Cmd+P` 直达）。Markdown 文档写作体验可替代 Typora 的日常用途。

---

### 3.6 M4 · 主题、字体、打磨（6–8 人日）

| 工作项 | 人日 | 要点 |
|---|---|---|
| 主题系统 | 1.5 | CSS Variables 架构、内置 3 套基础主题 + 3 套流行配色移植（逐个核对 License）、跟随系统、用户自定义主题加载（`~/.vela/themes/`） |
| 字体管线产品化 | 2 | 分片懒加载落地、字体切换 UI（编辑器/UI/正文三区独立）、字号/行高/字间距设置、按需下载额外字体 |
| P1 功能 | 2 | Minimap、Git gutter（只读行级标记）、拖拽文件打开、在 Finder 中显示、复制路径 |
| 性能调优 | 1.5 | 冷启动剖析、内存泄漏排查（EditorView 释放）、大文件回归、搜索性能 |
| 依赖评估 | 0.5 | 评估切 `notify` 9.0.0-rc（三项 macOS FSEvents 专项优化：`with_fsevent_latency`、回调性能、单一 stream root） |

**验收**：§2.9 的性能与体积预算全部达标。视觉上有辨识度、不廉价。

---

### 3.7 M5 · 插件接口收敛（3–5 人日）

**目标**：不开放第三方，只做**内部重构 + 冻结 API 边界**。

| 工作项 | 人日 |
|---|---|
| 所有宿主能力收敛到 `vela.*` 桥对象，带版本号 | 1.5 |
| 写 **2–3 个「假装是第三方」的示例插件**，验证 API 表达力 | 1.5 |
| 激活时机声明机制（懒激活，避免 N 个插件拖慢启动） | 0.5 |
| 内部 API 契约文档 | 0.5 |
| 审视并砍掉多余 API 面（**发布即冻结，现在是最便宜的时候**） | 1 |

> **为什么值得做**：用示例插件反向验证是发现 API 设计缺陷的唯一可靠方法。等真有第三方开发者时才发现问题，改起来就是 breaking change。
>
> **将来开放的成本**（调研估算）：L1（webview 内 JS，Obsidian 同款无沙箱）额外 **5–10 人日**；L2（权限 + 市场 + 生命周期）累计 15–30；L3（QuickJS/Wasm 沙箱）累计 35–70。

---

### 3.8 M6 · 打包发布（3–4 人日）

| 工作项 | 人日 | 要点 |
|---|---|---|
| macOS 打包 | 1.5 | `.dmg` + `.app`，Apple Silicon + Intel 双架构（universal binary 或分别构建） |
| 签名与公证 | 1 | **商业化必需**。Apple Developer 账号、`codesign`、`notarytool` 公证、staple |
| 自动更新 | 1 | Tauri updater + 更新服务器（可用 Cloudflare R2 + Workers，成本低） |
| 崩溃上报（可选） | 0.5 | Sentry 或自建 |
| 首版发布物 | — | 官网/README、截图、下载页 |

Windows / Linux 留到 v1.x（届时需处理 WebView2 内存差异与 WebkitGTK 图形问题）。

---

## 4. 风险登记册

| # | 风险 | 等级 | 影响 | 应对 | 责任阶段 |
|---|---|---|---|---|---|
| R1 | **WKWebView 滚动/输入手感不达标** | 🔴 高 | 动摇整个 Tauri 路线 | M0 闸门验证；不过则试 `macOSPrivateApi`/原生滚动容器；极端情况重估技术栈 | M0 |
| R2 | **中文字体 24MB 拖垮「轻量」** | 🟢 **已收敛** | 安装包破 100MB，违背核心诉求 | ✅ **M0 实测：单变体仅 97 分片 / 4.33MB，且 unicode-range 懒加载生效**。原风险基于「18.4MB=单变体」的错误估算，实际是 4 变体总和。**剩余动作**：发布时确保只打包一个变体 | M0 ✅ |
| R3 | CM6 + Vite 生产构建陷阱 | 🟡 **已命中并修复** | 上线前才发现构建产物坏了 | ✅ M0 就验证 `vite build`，**果然踩中三个坑**：rolldown 拒绝对象形式 manualChunks、esbuild 不再内置（须 `minify:'oxc'`）、粗粒度 manualChunks 摧毁懒加载（623KB→284KB gzip）。详见 §2.3。**若留到 M6 才发现，返工成本会大得多** | M0 ✅ |
| R4 | CJK 列对齐漂移 | 🟡 中 | 代码区表格/缩进视觉错位 | 代码区用 Maple Mono CN（声明 2:1）；文楷仅用于正文/UI。M0 已备好列对齐测试台（`ProbePanel.tsx`），**待人工判定** | M0 / M4 |
| R5 | 大文件 IPC 序列化爆内存 | 🟡 中 | 打开大文件即崩溃 | 单次 payload 上限 4MB；>50MB 走 ropey 只读分片模式 | M2 |
| R6 | **API 发布即冻结** | 🟡 中 | 未来插件生态被烂 API 锁死 | M5 用示例插件反向验证；API 面从第一天就极小；带版本号 + shim 适配层 | M5 |
| R7 | License 误用（GPL/AGPL/BUSL 传染） | 🟡 中 | 闭源商业化受阻，法律风险 | 严格遵守 §2.10 清单；不 fork athas/hermes/Zed；Sarasa Gothic 与主题配色逐个核对；商用前法务复核 | 全程 |
| R8 | 范围蔓延（想做 LSP/终端/AI） | 🟡 中 | 工期翻倍，轻量定位丢失 | §1.3 非目标清单为硬约束；任何新增功能需先证明属于四个核心场景之一 | 全程 |
| R9 | CM6 长行 + 自动换行「pop 抖动」 | 🟢 低 | 特定文档滚动手感 | 作者明确为响应性必须付的代价；可对超长行降级关闭换行。**M0 fixture 已内置超长行样本 + wrap 开关 + FpsSampler，待实测** | M0 / M1 |
| R10 | East Asian Width 歧义字符定位 | 🟢 低 | `±` `×` 希腊字母列对齐 | 行业公认老问题，CM6/Monaco 单值 `charWidth` 模型均无法解决，接受 | — |
| R11 | 连字导致光标错乱 | 🟢 低 | 开启 ligatures 后光标漂移 | **默认关闭** `font-variant-ligatures`（`setup.ts` 已实现，M0 验证是否真复现） | M0 / M1 |
| R12 | Tauri 3.0 迁移 | 🟢 低 | 未来需跟进 GTK4 等破坏性变更 | 锁 2.11.x；3.0 milestone 仅 29%、无 due date，不急；架构上避免依赖 v1 兼容层 | M6+ |
| R13 | `notify` macOS FSEvents 边界问题 | 🟢 低 | 部分文件变更漏报 | 官方文档提示网络盘/Docker on M1 场景退回 `PollWatcher`；FSEvents 安全模型导致部分文件「无 owner」 | M2 |
| R14 | **字体 family 同名冲突**（M0 新发现） | 🟢 **已根治** | 194 条同名 `@font-face` 互相覆盖，渲染结果不可预期且难排查 | `lxgwwenkaiscreen.css` 与 `lxgwwenkaigbscreen.css` 声明同一个 family 名。✅ **D7 实施后结构性解决**：`src/fonts/loader.ts` 注入时整块替换 `<style>` 节点，任一时刻只可能驻留一个变体，从「靠约定不引错文件」变成「架构上不可能同时驻留」 | M0 ✅ |
| R15 | **前端 bundle 余量仅 5%**（M0 新发现） | 🟢 **已解除** | M1 加多标签/文件树/命令面板、M3 加 17 个工具后必然突破 300KB 预算 | ✅ **D7 已实施**：字体 `@font-face` 改运行时按需注入，首屏 gzip **284.4 → 218.5 KB**，余量 5% → **27%**。详见 §2.9。**注意这只是买回了空间，M1/M3 仍需在每阶段末回归测量** | M0 ✅ |
| R16 | **文楷 Screen 无 Bold 字重**（M0 新发现） | 🟢 低 | Markdown `**加粗**` 只能浏览器合成伪粗，笔画发糊 | 已实测确认 97 个 face 全为 `font-weight: 400`。M3 做 Markdown 时评估观感；不可接受则改用主系列 Light/Regular/Medium（但那三个无屏显优化） | M3 |
| R17 | **`assetsInlineLimit` 击穿字体懒加载**（D7 实施中发现） | 🟡 中 | 小分片被转 base64 data URI，字节随 CSS chunk 强制下载，`unicode-range` 的「不请求」语义失效；且触发条件随字体包版本漂移 | vite 默认阈值 4096 字节，GB 变体实测有 2 个分片中招。✅ 已在 `vite.config.ts` 用函数形式对 `.woff2` 强制 `return false`，两变体 chunk 随即对称。**教训：分片资源架构必须显式关闭内联，不能依赖默认值** | M0 ✅ |

---

## 5. 待决策项

| # | 决策 | 选项 | 建议 | 需何时定 |
|---|---|---|---|---|
| D1 | **字体分发策略** | (a) WOFF2 全量分片懒加载（**实测 4.33MB/变体**，不改名）<br>(b) 精简子集（4–6MB，须改名 "Vela Kai"，生僻字 fallback 系统字体） | **(a)** — M0 实测后优势从「略好」变「明显」：**两者体积已持平**，但 (a) 不改名、覆盖完整、无视觉断层。原先唯一的劣势（67.8KB gzip 的 `@font-face` 占首屏 CSS）**已被 D7 消掉**，现在 (a) 无短板 | **M0 已可定** |
| D2 | **代码区默认字体** | (a) 全程 LXGW WenKai（尊重偏好，接受列对齐漂移；**且 Screen Mono 无 webfont 包，要等宽得自己从 24.44MB TTF 切分**）<br>(b) 代码区 Maple Mono CN + 正文 LXGW WenKai | **(b)** — M0 新发现让 (a) 成本上升：等宽变体拿不到现成分片。把 (a) 作为一键切换选项保留即可 | M0 人工判定列对齐后 |
| D3 | 会话存储 | rusqlite（SQLite）vs sled（嵌入式 KV）vs JSON 文件 | SQLite — 结构化查询与迁移更省心 | M1 |
| D4 | 前端框架最终确认 | Solid（推荐）vs Svelte 5 | Solid | 已定，除非 M0 发现问题 |
| D5 | 是否内置 P1 工具集 | 全做 vs 只做 P0 | 先只做 P0，按用户反馈补 | M3 |
| D6 | Sarasa Gothic 是否纳入 | 需人工核对 LICENSE 全文 | 核对通过再纳入，否则用 Maple Mono 替代 | M4 |
| D7 | **前端 bundle 预算是否上调**（= R15） | (a) 守住 300KB，靠字体 CSS 运行时注入腾空间<br>(b) 上调到 400KB，理由是 Tauri 本地加载不受网络 RTT 支配 | ✅ **已定 (a) 并实施完成**。首屏 gzip **284.4 → 218.5 KB**，余量 5% → 27%，无需动预算。实现见 `src/fonts/loader.ts`，实测明细见 §2.9。**副产物**：R14 被结构性根治，另发现并修掉 R17 | **已完成** |

---

## 附录 A · 调研来源

### 编辑器内核与前端
- [CodeMirror: Bundling with Rollup（官方体积数字）](https://codemirror.net/examples/bundle/)
- [Replit: Betting on CodeMirror](https://replit.com/blog/codemirror) · [Replit: Comparing Code Editors](https://replit.com/blog/code-editors)
- [Sourcegraph: Migrating from Monaco Editor to CodeMirror](https://sourcegraph.com/blog/migrating-monaco-codemirror)
- [Obsidian: CodeMirror 6 migration guide](https://obsidian.md/blog/codemirror-6-migration-guide/)
- [codemirror/dev issue #1089（大文档 pop 抖动）](https://github.com/codemirror/dev/issues/1089)
- [CM6 论坛：ligatures / charWidth 与非等宽字体](https://discuss.codemirror.net/t/cm6-ligatures/2921)
- [monaco-editor issue #4592（CJK 行跳动）](https://github.com/microsoft/monaco-editor/issues/4592) · [#123（ligatures）](https://github.com/microsoft/monaco-editor/issues/123)
- [Elixir Forum: Reason for switching from Monaco to CodeMirror](https://elixirforum.com/t/reason-for-switching-from-monaco-to-codemirror/60999)
- [vite issue #12662（worker 跨源加载）](https://github.com/vitejs/vite/issues/12662)
- [tree-sitter in browser discussion](https://github.com/tree-sitter/tree-sitter/discussions/1024)
- [cmdk](https://github.com/dip/cmdk) · [headless-tree](https://headless-tree.lukasbach.com/) · [Ark UI Tree View](https://ark-ui.com/docs/components/tree-view)
- [Tailwind CSS v4.0 发布博客](https://tailwindcss.com/blog/tailwindcss-v4)

### 开源项目与 License
- [Sidenai/sidex](https://github.com/Sidenai/sidex) · [athasdev/athas](https://github.com/athasdev/athas) · [athas HN 讨论](https://news.ycombinator.com/item?id=46021356)
- [hermes-hq/hermes-ide](https://github.com/hermes-hq/hermes-ide)
- [lapce/lapce](https://github.com/lapce/lapce) · [lapce/floem](https://github.com/lapce/floem)
- [zed-industries/zed](https://github.com/zed-industries/zed)
- [helix-editor/helix](https://github.com/helix-editor/helix) · [neovide](https://github.com/neovide/neovide) · [xi-editor](https://github.com/xi-editor/xi-editor)
- [Graviton-App（已归档）](https://github.com/Graviton-Code-Editor/Graviton-App) · [MarkFlowy](https://github.com/drl990114/MarkFlowy)

### Tauri
- [Tauri Releases](https://v2.tauri.app/release/) · [tauri-apps/tauri releases](https://github.com/tauri-apps/tauri/releases) · [Tauri 3.0 milestone](https://github.com/tauri-apps/tauri/milestone/5)
- [Tauri vs Electron（gethopp 基准）](https://www.gethopp.app/blog/tauri-vs-electron)
- [WKWebView 滚动微卡顿 discussion #8436](https://github.com/orgs/tauri-apps/discussions/8436)
- [Tauri CSP 文档](https://tauri.app/security/csp/) · [Tauri Linux Graphics Issues](https://v2.tauri.app/zh-cn/develop/debug/linux-graphics/)
- [Tauri + Vite + CM6 生产构建问题](https://discuss.codemirror.net/t/tauri-sveltekit-vite-codemirror-6-works-in-dev-breaks-in-production-build/9339)

### Rust 生态
- [docs.rs/notify](https://docs.rs/notify/) · [notify CHANGELOG](https://github.com/notify-rs/notify/blob/main/notify/CHANGELOG.md)
- [ignore crate: WalkBuilder](https://docs.rs/rustfmt_ignore/latest/ignore/struct.WalkBuilder.html) · [ripgrep discussions: ignore crate API](https://github.com/BurntSushi/ripgrep/discussions/2730)

### 插件系统
- [Obsidian sample plugin manifest.json](https://raw.githubusercontent.com/obsidianmd/obsidian-sample-plugin/master/manifest.json)
- [obsidian-releases/community-plugins.json](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json)
- [Obsidian: Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [BRAT (obsidian42-brat)](https://github.com/TfTHacker/obsidian42-brat) · [obsidian-plugin-sandbox（反证官方无沙箱）](https://github.com/timhor/obsidian-plugin-sandbox)
- [rquickjs](https://crates.io/crates/rquickjs) / [GitHub](https://github.com/DelSkayn/rquickjs) · [quickjs-ng](https://github.com/quickjs-ng/quickjs)
- [wasmtime](https://crates.io/crates/wasmtime) · [wasmer](https://crates.io/crates/wasmer) · [extism](https://crates.io/crates/extism) / [Extism blog](https://extism.org/blog/)
- [mlua](https://crates.io/crates/mlua) · [denoland/rusty_v8](https://github.com/denoland/rusty_v8) · [Rust 社区 V8 嵌入讨论](https://users.rust-lang.org/t/which-is-the-best-way-to-embedded-v8-engine-in-my-rust-program/104277)

### 字体
- [LXGW WenKai Screen](https://github.com/lxgw/LxgwWenKai-Screen) · [LXGW WenKai](https://github.com/lxgw/LxgwWenkai)
- [LXGW WenKai OFL.txt（RFN 与打包条款）](https://raw.githubusercontent.com/lxgw/LxgwWenkai/main/OFL.txt)
- [Open Font License FAQ（子集化 / WOFF2 / RFN）](https://openfontlicense.org/ofl-faq/)
- [Maple Mono](https://github.com/subframe7536/maple-font) · [Sarasa Gothic](https://github.com/be5invis/Sarasa-Gothic)
- [HN: When monospace fonts aren't](https://news.ycombinator.com/item?id=10206380)

### 工具集参照
- [DevToys](https://devtoys.app/) · [DevToys Smart Detection 设计指南](https://devtoys.app/doc/articles/extension-development/guidelines/UX/support-smart-detection.html)
- [Sublime Text](https://www.sublimetext.com/)

---

## 附录 B · 可复用开源资产清单（License 已核）

### Rust crates

| crate | 版本 | License | 用途 |
|---|---|---|---|
| `tauri` | 2.11.5 | Apache-2.0 / MIT | 应用框架 |
| `ropey` | 1.6.1 | MIT | 超大文件 rope |
| `notify` | 8.2.0 | CC0-1.0 | 目录监听 |
| `notify-debouncer-full` | — | CC0-1.0 | 事件抖动合并 |
| `ignore` | 0.4.33 | Unlicense OR MIT | 遍历 + gitignore |
| `grep-searcher` | 0.1.17 | Unlicense OR MIT | 全文搜索 |
| `grep-regex` | 0.1.14 | Unlicense OR MIT | 搜索正则 |
| `grep-matcher` | 0.1.9 | Unlicense OR MIT | 匹配抽象 |
| `grep-cli` | 0.1.12 | Unlicense OR MIT | CLI 工具 |
| `walkdir` | 2.5.0 | Unlicense OR MIT | 轻量遍历补充 |
| `tokio` | — | MIT | 异步运行时 |
| `image` | — | MIT OR Apache-2.0 | 图片工具（P1） |
| `sha2` / `md-5` | — | MIT OR Apache-2.0 | 哈希工具 |

### 前端包

| 包 | License | 用途 |
|---|---|---|
| `codemirror` / `@codemirror/*` | MIT | 编辑器内核 |
| `@lezer/*` | MIT | 语法解析 |
| `@codemirror/lang-markdown` / `@lezer/markdown` | MIT | Markdown AST |
| `@codemirror/language-data` | MIT | 子语言懒加载 |
| `solid-js` | MIT | 前端框架 |
| `@kobalte/core` | MIT | 无样式可访问组件 |
| `cmdk-solid` | MIT | 命令面板 |
| `@ark-ui/solid` | MIT | Tree View（懒加载 + 虚拟化） |

### 字体

| 字体 | License | 备注 |
|---|---|---|
| LXGW WenKai Screen / Screen Mono | OFL 1.1 | 默认；RFN = 霞鹜/霞鶩/落霞孤鹜/落霞孤鶩/LXGW；**子集化须改名，仅转 WOFF2 无需改名** |
| Maple Mono CN | OFL 1.1 | 代码区推荐；官方声明完美 2:1 |
| JetBrains Mono | OFL 1.1 | 不含中文，需配 Noto Sans CJK（OFL 1.1） |
| Sarasa Gothic | ⚠️ 待核对 | GitHub API NOASSERTION，官方口径 OFL 1.1 |

### 明确禁用（copyleft / 商业限制）

| 项目 | License | 原因 |
|---|---|---|
| Zed `text`/`multi_buffer`/`editor`/`language`/`rope`/`lsp` | GPL-3.0-or-later | 静态链接即传染整个发行物 |
| athas | AGPL-3.0 | 网络服务使用亦触发开源义务 |
| hermes-ide | BUSL 1.1 | Additional Use Grant 明文排除 code editor/IDE 竞品 |
| MarkFlowy / markra / RapidRAW | AGPL-3.0 | — |
| Fluxium / markright | GPL-3.0 | — |

---

**文档结束。** 下一步：执行 M0 技术验证冲刺，产出《M0 验证报告》后再决定是否进入 M1。
