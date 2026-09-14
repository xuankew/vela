# Vela · 技术方案与实施计划

| | |
|---|---|
| **代号** | Vela（船帆座） |
| **文档版本** | v1.2 |
| **日期** | 2026-09-14 |
| **状态** | ✅ **M0 闸门通过、无阻塞项 —— M1 可开工**。**7 项验收通过**（#1 #2 #3 #5 #6 #7 #8）、#4 机制通过但首屏字体超预算 11%（转 M1 工作项）。八项全部有结论，推翻 Tauri 路线的情形已正式排除。实测数据见 [`M0-REPORT.md`](M0-REPORT.md)，§3.2 是就地批注版 |
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
6. **中文字体是最大的体积风险**：`LXGWWenKaiScreen.ttf` 单文件 24.48MB。方案为 WOFF2 分片 + `unicode-range` 懒加载。⚠️ **M0 实测首屏 2.219MB，超 2MB 预算 11%**——根因是分片按码位区块切、一屏汉字散落到 25~36 片上；M1 按字频重排分片可降到 1.0~1.2MB（见 §3.2 #4 与 §3.3）。⛔ 不要改用精简子集，那会触发 OFL 的 Reserved Font Name 改名义务。
7. **总量 43–54 人日**（1 名熟练 Rust+TS 全栈全职，约 9–11 周）。M1 结束（第 3 周末）即有可日用的编辑器。
8. ✅ **M0 风险闸门已通过（2026-09-14），八项验收全部有结论**：WKWebView 的滚动/输入手感这个生态级 open issue（tauri-apps/discussions#8436）**没有被证实**——客观上机器空闲时帧计时贴着 60Hz vsync 上限（59.5~60.3fps，p95 ≤23ms），1 万行涨到 5 万行无可测退化；主观上用户在 5 万行文档用触控板连续滚动判定「没有卡顿，挺流畅」（且是在 `load 3.49` 的高负载下判的，属更严苛条件下的通过）；中文 IME 亦人工判定通过。**原计划「唯一会推翻 Tauri 路线的情形」已正式排除，Safari 对照组不必做**。**Tauri 2 路线确认，M1 可开工**。数据见 [`M0-REPORT.md`](M0-REPORT.md)。

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

#### 字体分工（D2 已定并实施）

| 区域 | 字体 | CSS 变量 | 实测依据 |
|---|---|---|---|
| Markdown 正文 / UI | **LXGW WenKai Screen**（GB 变体，97 分片 / 4.33MB） | `--vela-font-editor`、`--vela-font-ui` | 楷体手感，长文阅读舒适。⛔ 拉丁是**比例宽度**，不能用于代码区 |
| 代码块 / 缩进代码 / 表格 | **Maple Mono CN**（`@automann/maple-mono-cn@7.9.2`，400 单字重，239 分片 / 9.33MB） | `--vela-font-code` | 官方声明 2:1 CJK:Latin；OFL-1.1 且**无 RFN**，分片分发不触发改名义务 |
| ~~代码区备选~~ | ~~LXGW WenKai Screen **Mono**~~ | — | ❌ **无 webfont 包**（npm 404）。要用得自行从 24.44MB TTF 切分，且按 OFL FAQ 2.6 子集化触发改名义务 |

**实现方式**（`src/fonts/loader.ts` + `src/editor/setup.ts`）：

- 两套 `@font-face` 各占一个 `<style>` 节点（`vela-font-faces` / `vela-code-font-faces`）**同时驻留**。不能共用一个节点：正文变体是整块替换（R14 同名 family 冲突），共用会把代码字体一起冲掉。
- 分流靠 ViewPlugin 按语法节点名 `FencedCode` / `CodeBlock` / `Table` 给整行打 `.vela-code` 行装饰。
  ⛔ **不能按 token 走 CSS**：`@lezer/markdown` 里**没有任何 `tags.monospace` 映射**（实测其 dist 搜不到），且带语言标签的围栏被 `codeLanguages` 嵌套子语言接管后，内部 token 变成 keyword/string，`.tok-monospace` 压根不会出现。
- 非 Markdown 文档（.ts / .json / 纯文本）整篇都是代码，直接挂 `codeDocFontTheme`，不走节点分流。
- 工具栏两个下拉正交：代码区切到「跟随正文」时 #3 应立刻变红，这是分流生效的反向证据。

> ⚠️ **重要澄清（M0 已结项）**：
> - ⛔ **推翻一条旧认知**：先前记录的「文楷 Screen 拉丁基于 Inconsolata、是等宽的」与实测冲突。`measureAlignment()` 在 WKWebView 内直接量字形 advance width，实测 ASCII 逐字符步进极差 **8.6339px**（`i`=3.68 `W`=12.32），CJK/ASCII = **1.66639** 而非 2.0，50 个中文字累积漂移 **140.14px** —— 拉丁**根本不等宽**，性质比原判据「2:1 有细微偏差」严重得多。以实测为准。
> - 量具自检可信：同一套量具跑系统等宽对照组（`ui-monospace`），ASCII 步进极差 **0.0002px**、`mono=true`。
> - **#3 已全自动量化，无需人工判定**：字体切换、文档切换、窗口转为可见时自动重测，结果自动落盘 `.m0-align.json`。
> - **字重问题已有答案：只有 `font-weight: 400`，没有 Bold**。影响：Markdown 加粗只能伪粗，需在 M3 评估观感是否可接受，或改用主系列（Light/Regular/Medium，但那三个都没有 Screen 优化）。→ R16

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
| 安装包体积（.app） | **≤ 40MB** | ✅ **23MB**（余量 42%）。D2 分字体前是 14MB，Maple Mono CN 的 239 个分片 +8.87MB | Tauri 空壳 8.6MB + 字体分片 **18.07MB**（文楷 GB 4.33 + R 4.87 + Maple 8.87）+ 前端 ~2MB + Rust 二进制 ~8MB |
| 冷启动到可输入 | **< 1s** | ✅ **635ms**（余量 36%，Rust 进程时钟端到端） | — |
| 空转常驻内存（macOS） | **< 200MB** | ✅ **均值 104MB / 峰值 109MB**（余量 46%，`phys_footprint` 口径，dPR=1） | Tauri 基准 ~172MB；Electron 为 ~409MB |
| 打开 10 万行文件 | **< 2s**，滚动 60fps | 滚动已测：5 万行手感档 **60fps**（见 §3.2 #1）。10 万行未测 | — |
| 全局搜索（10 万文件仓库） | **首批结果 < 2s** | M2 | ripgrep 级 |
| 前端 bundle（gzip） | **≤ 300KB** | ⚠️ **236.92KB**（余量 21%）。D7 基线是 218.5KB，**+18.4KB 全部来自 M0 探针脚手架**：`src/probe/sweep.ts`(17.5KB) 与 `ProbePanel.tsx`(46.9KB) 都是静态 import，落在入口 chunk 里。M0 收尾会整体删除，届时回落到 218KB 一线 | CM6 135KB + Solid 8.4KB + cmdk-solid 14.9KB + 业务代码 |
| **首屏字体字节** | **< 2MB** | ❌ **2.219MB（超 11%）** —— M0 唯一超标的硬预算。1 万行常用字混排下加载 61 片：文楷 25 片 1.136MB + Maple 36 片 1.082MB。口径是构建期分片清单查表（`performance` 的 resource timing 在 `tauri://` 下恒为 0 条 woff2，不可用）。根因是分片按码位区块切、一屏汉字散落到 25~36 片；**M1 按字频重排可降到 1.0~1.2MB**（见 §3.3）。详见 §3.2 #4 | 饱和上界（滚完 5 万行）2.603MB；空文档 + 界面中文 0.49~1.07MB |
| 按键到屏幕延迟 | **< 16ms** | 主线程事务派发 avg < 1ms（不含系统事件投递，仅作回归基线） | 不可感知 |

**M0 构建产物明细**（`pnpm build`，D7 字体按需注入 + D2 代码区分字体后）：

| 文件 | min | gzip | 说明 |
|---|---|---|---|
| `index-*.js` | 347.59K | **127.14 KB** | 入口：Solid + 应用代码 + CM6 基础扩展 + **M0 探针**（见下） |
| `dist-*.js`（modulepreload） | 335.25K | **108.50 KB** | CM6 内核 |
| `index-*.css` | 4.05K | **1.28 KB** | 应用自身样式（字体声明已移出） |
| **首屏合计** | | **236.92 KB** | 预算 ≤300KB，余量 21% |
| `regular-*.js` | 155.91K | 55.36 KB | Maple Mono CN 的 CSS，**懒加载 chunk**，不进首屏 |
| `lxgwwenkaigbscreen-*.js` | 92.73K | 33.36 KB | 字体变体 GB，**懒加载 chunk**，选中才拉 |
| `lxgwwenkaiscreenr-*.js` | 92.83K | 33.36 KB | 字体变体 R，同上 |
| 117 个 chunk（含子语言） | | | 懒加载，**不进首屏** |
| 433 个 woff2 | | **18.1 MB** | 文楷 GB 97 片 / 4.33MB + 文楷 R 97 片 / 4.87MB + Maple 239 片 / ≈8.9MB（hash 命名） |
| `dist/` 总计 | | 26 MB | |
| `Vela.app` | | **23 MB** | 预算 ≤40MB |

> **首屏比 D7 基线（218.5 KB）多了 18.4 KB，全部是 M0 探针脚手架**：`src/probe/sweep.ts`(17.5KB) 与 `ProbePanel.tsx`(46.9KB) 都是静态 import，被压进入口 chunk。M0 收尾整体删除后回落到 218 KB 一线。**别把这 18.4 KB 记成 D2 分字体的代价**——Maple 的 CSS 是 `?inline` 动态 import，独立成 `regular-*.js`，首屏一个字节都没碰。
>
> 注意 npm 包的 `exports` 白名单：`@automann/maple-mono-cn` 只暴露 `"./regular.css"`，必须 import `@automann/maple-mono-cn/regular.css?inline`；直接写包内的真实 `dist/` 路径会在构建期就报 "Package subpath is not defined"。

> ✅ **D7 已实施：字体 `@font-face` 改为运行时按需注入。** 首屏 gzip **284.4 → 218.5 KB**（省 65.9 KB / 23%），其中首屏 CSS 从 **67.8 KB 砍到 1.2 KB**。
>
> 实现方式见 `src/fonts/loader.ts`：动态 `import()` + vite `?inline`，每个变体成为独立 chunk，注入时**整块替换** `<style id="vela-font-faces">` 而非追加——这样任一时刻只驻留一个变体，顺带根治了 R14 的同名 family 冲突。编辑器挂载不等字体（并行触发），靠 `font-display: swap` 重排，冷启动计时不被拖慢。
>
> **需要澄清一个当时没说准的地方**：这次改造省的**不是总字节数**——把 CSS 文本搬进 JS bundle，gzip 一样大。真正省的是两件事：① 离开首屏关键路径（CSS 阻塞首次绘制，动态注入的 `<style>` 不阻塞）；② 常驻量减半（只驻留选中的那个变体）。原估「腾出 ~58KB」按「首屏 CSS 产物减少」算是成立的，但别误读成总体积变小了。
>
> **实施中发现的新坑**：vite 默认 `assetsInlineLimit: 4096` 会把小分片转成 base64 data URI。GB 变体有 2 个中招（3.9KB → base64 5.2KB）。**这看着无害，实际击穿了 unicode-range 懒加载**——data URI 的字节已随 CSS chunk 下载，浏览器没法因为「页面上没这些码点」而跳过请求，而分片架构的前提恰恰就是不请求。且哪些分片低于阈值取决于字体包的切分方式，包一升级就悄悄变化。已在 `vite.config.ts` 用函数形式对 `.woff2` 强制返回 `false`，两个变体 chunk 随即对称（各 97 条 url 引用 / 33.36 KB gzip）。

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
| 1 | **WKWebView 滚动手感** | 万行文件滚动无肉眼卡顿，主观手感可接受 | ✅ **通过（客观半 + 主观半均通过）**。<br>**主观半 ✅（人工判定，2026-09-14 21:54）**：用户在真实 WKWebView 窗口里切到 **5 万行**文档、用**触控板**连续滚动（含惯性甩动与突然反向），判定「**没有卡顿，挺流畅的**」，两条判据（无肉眼卡顿、主观手感可接受）均满足。被测产物 `…/Vela.app/Contents/MacOS/vela`（release，与 #2 / #4 同一份构建），dPR=1。<br>📌 **这条判定是在 `load averages 3.49 / 3.03 / 2.98` 下做出的，而这是更强的证据**：判定规则不对称——负载高时手感好 = 在比目标环境更严苛的条件下达标（**下界**）；负载高时手感差才不能归因于 Tauri。<br>⚠️ **诚实标注：这是 M0 唯一没有数据产物的验收项**（人工判定不经探针、不落盘，无 `.json` 可复核；单次判定、无埋点核实实际滚了多少行）。证据强度低于同节的量化项，但主观手感本来只能这么测。<br><br>**客观半 ✅（帧计时，低负载基线）**，但读数对机器负载高度敏感。<br>**判据口径**：外接 1920×1080 **@60.00Hz**、`devicePixelRatio=1`，所以 **60fps 就是垂直同步上限**，不是「凑巧跑到 60」。<br><br>**低负载读数（run1/run2，06:00–06:01，机器空闲）**：手感档（3000px/s ≈ 每秒 214 行）四档 10k 换行开 **59.5fps**（p95 21ms，卡顿 2/179）｜10k 换行关 **60.3fps**（p95 23ms，**卡顿 0**）｜50k 换行开 **60.3fps**（p95 19ms，**卡顿 0**）｜50k 换行关 **60.1fps**（p95 23ms，**卡顿 0**）。p95 全部 ≤23ms（预算 33ms），**1 万行涨到 5 万行没有可测量的退化** → CM6 的视口虚拟化成立。压力档（全范围三角波，7.4万~63万 px/s）10k 56.2/59.1、50k 48.3/44.3fps；⛔ 压力档跑不满 60fps 是上界测试的正常结果，不能读成日常卡顿。<br><br>⛔ **撤回两个错误归因。** 06:25 起连续四轮全部掉到 53~57fps，我先后归因于「Maple 239 个冷分片」和「ViewPlugin 每帧重走语法树重建 DecorationSet」，**两次都错**：<br>· 把重建从每帧 ~180 次节流到每档 ~5 次（削掉一个数量级）→ 帧率 **55.6/55.2/55.8/54.1**，与节流前 **55.7/54.5/56.1/55.3** 一位小数都没差；<br>· 把插件整个摘掉（Maple 仍注入）→ 10k 换行开 **55.70fps**，而同一档装着插件是 **57.09 / 54.36**，**方向还是反的**；<br>· 关掉 Maple（`inherit`，插件照跑）→ **55.15fps**，与开着 Maple 的 55.70 差 0.55。<br>三个差值（≈0、−1.4、+0.55）**全部远小于下面量出来的 3.9fps 噪声带宽**，按本节方法论第 4 条不能报为结论。<br><br>**噪声带（同一个构建连跑三次，06:54–06:58，11 个有效样本）**：**53.16 ~ 57.09fps，均值 55.11，带宽 3.9fps**；卡顿帧 4~16；p95 28~48ms；单帧最低 **12.5fps**。<br>**形状判据（这条比均值更能定性）**：如果真是「每帧多算了一点东西」，均值会下移但分布仍然紧贴 vsync；实测是均值下移**并且**冒出 12.5fps 的离群帧、卡顿从 0~2 涨到 4~16 —— 这是**被外部抢占**的形状，不是稳态计算量上升的形状。<br>**同期机器负载**：`load averages 3.82 / 4.00 / 4.39`，WindowServer **14% CPU**（它就是逐帧合成的那一方）、一个 VM 9.1%、Qoder 10.0%、Codex Renderer 7.4%、kernel_task 5.7%。<br><br>📌 **结论**：60→55fps 这个差值**不能归因于分字体改造**，两个被怀疑的组件各自单独移除都是零效果；最可能是机器负载，但这是**强旁证而非直接证明**——我无法重建 run2 那一版代码，也无法让这台机器安静下来。<br>📌 **原「安静机器复跑」一项已降级，不再是决策输入、也不再是 M1 的前置条件**：它的目的是闭合「60→55fps 是不是代码退化」，而噪声带实验（同一构建三次连跑 53.16~57.09fps，带宽 3.9fps）已把两次归因推翻，本次**高负载（load 3.49）下的主观通过**又给了比安静机器上的 fps 数字更强的证据 → **那个疑问已经闭合**。剩下的价值只是给 M1 留一条干净的帧率回归基线，可在 M1 开工后顺带补。<br>⚠️ 在此之前仍然**不能把 `FPS_BUDGET=55` 的「超标」当成真实缺陷**——noise-3 的 50k 换行关 53.16fps 就低于 55，而那不是代码问题。<br><br>📌 **合成滚动的边界仍然存在，但缺口已被人工滚动补上**：两档客观数据都是程序化写 `scrollTop`，绕开了触控板惯性经 WKWebView 原生手势的那一段，而 discussions#8436 报告的微延迟恰好在那条路径上 → 「手感」这一半自动化不了。**现在那条路径被人用触控板滚过了（见本行顶部的主观半判定）**，缺口闭合。<br>📌 原计划的 Safari 对照组**确定不必做**，两条独立理由：① 低负载客观读数已贴在 60Hz 上限，没有「Tauri 比 Safari 差」的差值需要解释；② 推翻条件是「手感不可接受 **且** Safari 复现顺滑差异」，前半条已被否定，合取式不可能成立。<br>📌 矩阵的自检有效：瞬时遮挡/rAF 节流会被自动标 `aborted` 并排除，没有污染结论（三次连跑里作废 1 档）。<br>⚠️ **`caffeinate` 的坑（本轮白跑两次）**：`caffeinate -dimsu -w "$PID"` 在 `pgrep` 抓到错误 PID 时会**静默失效**，`displaysleep=10` 随即让显示器休眠、窗口转 `hidden`、rAF 冻结，矩阵在开跑 10 秒后就卡死。必须用**独立进程**持有断言（`caffeinate -dimsu -t 1200 &`）并在开跑前用 `pmset -g assertions | grep PreventUserIdleDisplaySleep` 确认读到 **1**。run4 之所以成功，是因为 `pgrep -f` 误抓到了长命的 shell，`-w` 反而一直挂着——**靠运气对的不算对**。<br>⚠️ 未闭合：`devicePixelRatio=1`，Retina（dPR=2）下每帧要画的像素是 4 倍，需复测；20k 档未单列（被 10k/50k 夹逼）。 | 存在 open issue（tauri-apps/discussions#8436）报告 macOS 上 Tauri 滚动有微延迟而 Safari 无，**无根因、无修复结论**。对策：试 `macOSPrivateApi`；把滚动容器交给原生；**极端情况下重估 Tauri 路线**。<br>✅ **这条备选确定不触发**——触发条件是「人工手感判定不通过 **且** Safari 对照组复现同负载下的顺滑差异」，**前半条已被用户的人工判定否定**，合取式不可能成立。客观数据也未触发：低负载时帧计时贴着 vsync 上限，高负载时的掉帧有明确的外部抢占特征且与我们的代码无关。`macOSPrivateApi` / 原生滚动容器 / 重估路线**都不需要做**。 |
| 2 | **中文 IME** | 输入无行跳动、候选框不错位、长句连续输入不丢字 | ✅ **通过（人工判定，2026-09-14）**。用户在真实 WKWebView 窗口里人工输入验证，四条判据（行跳动 / 候选框错位 / 长句丢字 / 上屏后光标位置）均无异常。被测产物是 `…/Vela.app/Contents/MacOS/vela`（release，与 #4 同一份构建），dPR=1。<br>📌 **这是 M0 唯一结构性不可自动化的一项，它通过意味着八项验收再无阻塞项。**<br>**为什么不可自动化**（不是偷懒，是路径问题）：程序化插入文本会**绕过 `compositionstart/update/end`**——而那三个事件正是被测路径本身；合成 `KeyboardEvent` **驱动不了 IME 候选窗**，候选窗由系统输入法进程绘制，不在 WebView 的事件模型里。<br>📌 面板里备的**原生 `<textarea>` 对照组**用于区分「CM6 的问题」还是「WKWebView 的问题」；两边都正常时该区分不产生信息，本轮判定不依赖它。<br>⚠️ **两条未覆盖面（不阻塞 M1，发布前要补）**：① **只验了一种输入法**——不同输入法的 composition 事件序列差别很大（系统拼音 / 双拼 / 五笔 / 仓颉，以及搜狗、微信输入法这类自己绘候选窗的第三方输入法），`inputStyle` 的问题往往只在某一种上暴露；② **dPR=1**——候选框定位涉及屏幕坐标换算，Retina 下需复测，与 #1 / #7 的 dPR=2 复测合并做。 | ~~调整 CM6 `inputStyle`（`contenteditable` vs `textarea`）；参考 Monaco #4592 的教训。~~ ✅ 未触发。<br>📌 **若将来在别的输入法上复现**，对策仍是调 `inputStyle`，不动摇 Tauri 路线。已并入 M1「CM6 封装层」工作项，内核阶段在系统拼音 + 一款第三方输入法上各过一遍。 |
| 3 | **字体列对齐** | ~~Screen Mono 下~~ 中英文表格 / ASCII art 对齐正确 | ✅ **通过（D2「按内容分字体」实施后，全自动量化，三轮独立复现，含一次 `visible` 复测）**。<br>**判定对象是 CM6 里真实的 `.vela-code` 代码行**（不是测试台 div）——这一条是「语法节点 → 行装饰 → CSS → 解析字体 → 字形度量」整条链的终点，只有量到它才证明装饰真的把字体换掉了。实测 Maple Mono CN @14px：ASCII 步进 **8.4px**、CJK 步进 **16.8px**、框线 `│` 步进 **8.4px**，CJK/ASCII = **2.0000**（判据 2.0）、框线/ASCII = **1.0000**（判据 1.0）、ASCII 逐字符极差 **0.0001px**（`i`/`l`/`W`/`m`/`.`/`@` 全部 8.4~8.4001）、50 个中文字累积漂移 **0px**，`mono=true` `aligned=true` `cjkFaceLoaded=true`。<br>**链的另一端同时成立**：同一个 `contentDOM` 量出来的正文仍是 LXGW WenKai Screen，ASCII 极差 8.6339px、CJK/ASCII = 1.66639 —— 代码行是正文元素的**子孙节点**却报出另一个 family，这就是分字体生效的直接证据。<br>**量具自检**：系统等宽对照组（`ui-monospace`）ASCII 极差 0.0002px、`mono=true` → 量具可信。<br>📌 **对照组顺带推翻了一个备选方案**：`ui-monospace` 的 CJK/ASCII = **1.55079**，不是 2.0 —— SF Mono 没有中文字形，`中` 落到了 PingFang 上。所以「代码区退回系统等宽字体」从来就不是 #3 的可行补救，而对照组只能验 `mono`、**验不了 `aligned`**。<br>✅ **`visible` 下的复测已补**（2026-09-14 09:34）：此前 run3/run4 两轮都记到 `visibility=hidden`，按本节方法论第 2 条欠一次可见态复测；现已在 `visible` 窗口下重测，判定对象仍是 CM6 里真实的 `.vela-code` 代码行，`cjkOverAscii = 2.000`、`mono = true`、`aligned = true`，系统等宽对照组 `mono = true`。读数存档 `.m0-align.json`。字形 advance width 与页面可见性无关，三轮数值一致 → **#3 结案**。<br><br>**以下是改造前的 ❌ 原始证据，保留说明为什么必须分字体**：LXGW WenKai Screen @14px 在 `visibility=visible` 下，代码区（CM6 `contentDOM`）与测试台 div 读数完全一致；ASCII 逐字符步进 `0`=8.4013 / `i`=3.6846 / `l`=3.6845 / `W`=12.3184 / `m`=11.4229 / `.`=4.9013 / `@`=10.9785，**极差 8.6339px** → 拉丁是**比例宽度，根本不等宽**；CJK 步进 14.0px（=1em），CJK/ASCII = 1.66639（须 2.0000）；框线 `│` 也是 14px，框线/ASCII = 1.66639（须 1.0000）；50 个中文字累积漂移 **140.14px**。⛔ 性质比原判据严重：不是「2:1 有细微偏差」而是**拉丁非等宽**——连纯英文代码的列都对不齐，文楷 Screen 只能用于 UI 与 Markdown 正文。<br>⚠️ 分片来自 npm 包 `lxgw-wenkai-screen-webfont@1.7.0`（chawyehsu 维护），我们的管线只做 CSS 注入、**没碰字形度量**，所以这是字体本身的属性而非构建 bug。原始读数存档 `.m0-align-lxgw.json`。<br>⚠️ 顺带推翻一条旧认知：先前记录的「文楷 Screen 拉丁基于 Inconsolata、是等宽的」与实测冲突，以实测为准。 | ~~代码区换真等宽 CJK 字体。~~ ✅ **已执行**，见 §5 D2。<br>⛔ **想保留文楷观感这条路当前走不通**：npm 上 `lxgw-wenkai-mono-webfont`、`@fontsource/lxgw-wenkai-mono`、`lxgw-wenkai-mono-web` **全部 404**，没有现成的 Mono 变体 webfont 包；要用就得自己从官方 TTF 建分片管线（而按 OFL FAQ 2.6，子集化触发 RFN 改名义务）。<br>⛔ **退回系统等宽也不行**：实测 `ui-monospace` 的 CJK/ASCII = 1.55079（SF Mono 无中文字形，回落到 PingFang），中文表格照样对不齐。<br>✅ 最终解：**Maple Mono CN**（官方声明 2:1，实测 2.0000），OFL-1.1 且**无 Reserved Font Name**，分片分发不触发改名义务。<br>📌 **一度怀疑的代价已排除**：同期滚动帧率从 ~60fps 掉到 ~55fps，我最初归因于这次分字体改造。连跑三次的噪声带（53.2~57.1fps，带宽 3.9fps）证明：关掉 Maple 的差值是 0.55fps、摘掉装饰插件的差值方向还是反的，两者都淹没在噪声里 → **分字体没有可测量的帧率成本**，那次掉帧另有原因（机器负载，详见 #1）。 |
| 4 | **字体分片管线** | 首屏实际加载 **< 2MB**；随机生僻字能正确触发分片加载 | ⚠️ **机制 ✅ / 数值 ❌ 超预算 11%**（2026-09-14 09:33 补齐，口径已换掉）。<br>**新口径**：构建期 `scripts/font-manifest.mjs` 生成「family + 归一化 unicode-range → 真实字节数」清单（**433 片 / 18.07MB**），运行时用 `document.fonts` 里 `status=loaded` 的 face 查表求和。⛔ 原口径 `performance.getEntriesByType('resource')` 在 `tauri://` 下恒为 0 条 woff2，**原估 ≈1.40MB ±50% 作废**。<br>**实测**（release 构建、窗口 `visible`、dPR=1、wrap 开，全部样本 `trustworthy=true`：`rangeUnmatched=0`、`indexDisagreements=0`）：<br>· 字体刚注册、无字形需求：**0 / 336 片，0 MB**<br>· 空文档 + 界面中文：11~23 片文楷，**0.49~1.07 MB**（Maple **0 片**）<br>· **1 万行常用字混排（判预算用这份）：61 片 = 文楷 25 片 1.136MB + Maple 36 片 1.082MB → 2.219 MB**<br>· 同上 + 30 个跨区块生僻字（机制压力样本）：66 片 → **2.446 MB**（文楷 +5 片 / +227KB，生僻字确实一字一分片地拉）<br>· 滚完 5 万行全篇（饱和上界）：70 片 → **2.603 MB**<br>**机制侧成立**：0 → 按需增长 → 收敛。收敛靠**静置复测 + 去重**证明：每 3s 复测一次，相同样本不落盘，`+6s / +9s` 两次在日志里**没有产生新落盘**，那个缺失就是平台期证据。<br>**钱花在哪（关键：不是文档正文）**：① Maple 那 1.082MB 占首屏一半，来自 `CODE_BLOCK_NODES` 里的 `Table`——中文表格按设计走等宽字体（这是 #3 列对齐成立的前提），fixture 表格行全是中文，**预期行为不是 bug**；② 文楷 1.136MB 里界面自己的中文就占 11~23 片，文档正文只加了十几片；③ 结构性根因：**分片按码位区块切**（清单里能看到 `U+760F-76FB` 这类连续区间），一屏几百个不同汉字散落到 25~36 片上，每片均 31~46KB，**命中即整片下载**。<br>⚠️ **face 计数不单调**：重建编辑器后已加载 face 从 23 掉回 12（WebKit 释放不再被引用的字体数据），所以样本序列不能当增长曲线读，「空文档 + 界面」那行只能给区间。<br>⚠️ 附带发现 67.8KB gzip 的 `@font-face` CSS 开销 → R15，已由 D7 解决（首屏 CSS 67.8KB → 1.28KB）。<br>✅ **dPR 不影响本项**：分片命中只取决于出现哪些码点，与栅格化倍率无关 → #4 不需要 Retina 复测（#1 / #7 需要）。 | ✅ **口径已落地**（清单查表，绕开失效的 resource timing）。<br>**M1 修法：按字频重排分片。** 把最常用的 ~3500 字集中到头 1~2 片、其余照旧按码位切，典型首屏就从「命中 25~36 片」变成「命中 1 片常用字 + 1 片 ASCII」。粗估文楷侧 1.136MB → ~0.55MB（3500/27000 × 4.33MB），Maple 同比例，**首屏有望落到 1.0~1.2MB，回到预算内**。<br>⛔ **不要改用精简子集方案**（原备选）：子集化会触发 OFL 的 **Reserved Font Name 改名义务**（霞鹜 / 霞鶩 / 落霞孤鹜 / 落霞孤鶩 / LXGW），代价远大于重排分片。Maple Mono CN 无 RFN，不受此限。 |
| 5 | **生产构建** | `vite build` 后 CM6 **完全正常**（不是只在 dev 正常） | ✅ **通过，且这个验收项救了一次**。构建确实踩中三个坑（rolldown manualChunks 形式、esbuild 不再内置、粗分包摧毁懒加载），首屏 gzip 一度 623KB，修复后 **284.4KB / 114 chunk**。详见 §2.3 | 有已知「Tauri + Vite + CM6: Works in Dev, Breaks in Production Build」陷阱。排查分包、worker、动态 import 配置 |
| 6 | **冷启动** | 空窗口到可输入 **< 1s** | ✅ **通过：635ms**（预算 1000ms，余量 36%）。口径是端到端的 Rust 进程启动 → 编辑器可输入，由 `probe_ready` 命令返回 `PROCESS_START.elapsed()`，不是 `performance.now()`。<br>⚠️ 必须用进程时钟：`performance.now()` 的原点是**页面导航开始**，不含进程拉起与 WKWebView 创建，只用前端时钟会系统性低估冷启动，可能把不达标的读数读成达标。差值已单列在探针面板「进程拉起 + WKWebView 创建」一行 | 削减启动路径、延迟非关键扩展加载 |
| 7 | **空转内存** | **< 200MB** | ✅ **通过：空转均值 104MB，峰值 109MB，余量 46%**。13 个样本全部 `visibility=visible` 且 `hasFocus=false`（在渲染、无人操作），其中 5 个是间隔 15s 的干净空转点：合计 97 / 104 / 109 / 104 / 106 MB；拆分 vela 21~22（全程不动）｜GPU 17~24｜WebContent 54~61｜Networking 5。冷启动 17s 的首个点 114MB 也在预算内。<br>⚠️ 口径必须用 `phys_footprint`（`footprint -p`，即活动监视器「内存」列），**不能用 `ps` 的 RSS 求和**——vela 与 3 个 WebKit XPC 进程共享 WebKit.framework/AppKit 页，RSS 会重复计数（实测主进程 RSS 87MB 而 footprint 仅 24MB，差 3.6 倍）。<br>⛔ 早先单点读到的 209MB 是**启动初期瞬态，干净一轮里没有复现**，不能作为判定依据。<br>⚠️ 未闭合：本轮 `devicePixelRatio = 1`，图形背板成本随 dPR 平方增长，**Retina 屏上可见态开销会被低估**，正式判定要在 dPR=2 下复测。<br>⛔ `performance.memory` 在 WKWebView 恒为 undefined，前端侧的 JS 堆读数不可用。<br>📌 **新发现（转 M1）**：灌过 1 万行文档后即使回落到空文档，WebContent 停在 113MB、比空转基线高 **~59MB 且不回落**（同期 Rust RSS 反而从 146MB 降到 63MB）。性质是 WebKit 侧的驻留字形/图层缓存，不是 CM6 泄漏；但「反复开关大文件是否阶梯式上涨」「内存压力下是否被回收」未验证 → M1 需补一条长会话内存曲线。<br>📌 **字体归因已结案（数值已按 #4 的实测字节口径修正）**：早先记的「30/97 → 33/97，估算 ≈140KB」是 face 计数 × 平均体积的粗估，已被 #4 的清单查表口径取代。真实差值是：空文档 + 界面中文 **11~23 片 / 0.49~1.07MB** → 1 万行常用字混排 **61 片 / 2.219MB**，即文档本身多拉 **~1.2~1.7MB** 字体数据。这个量级**解释不了 ~59MB 的不回落驻留**，所以「字体分片管线不是内存问题的主因」结论不变（mixed 与 ascii 的内存差也确实落在 ±16MB 噪声带内、方向还会反转）。<br>⚠️ **诚实标注**：woff2 字节 ≠ 解码后的字形位图占用，后者会放大若干倍且未单独验证；但即便放大 10 倍也只到 ~17MB，仍不足以解释 59MB，量级判断成立。此路不必再查。 | 参照 Tauri 基准 ~172MB（**该基准的度量口径不明，不能直接对齐**）。若 dPR=2 复测超标：削减常驻 face 数、把图形背板交给原生滚动容器、或收紧 200MB 预算的适用口径 |
| 8 | **字体字重核实** | 确认 Screen 版实际提供几档字重（两次抓取结论冲突） | ✅ **已结项：只有 `font-weight: 400`，无 Bold**。97 个 face 全部 400 → 转为 R16 | 粗体需浏览器合成（faux bold）或改用主系列 LXGW WenKai |

**产出**：✅ 已交付 **[`M0-REPORT.md`](M0-REPORT.md)**，逐项记录实测数据与结论。
**结论：🟢 继续按 Tauri 2 路线走，M0 闸门通过、无阻塞项 —— M1 可以开工** —— **7 项通过**（#1 #2 #3 #5 #6 #7 #8）、**#4 机制 ✅ 但数值 ❌（首屏 2.219MB，超 2MiB 预算 11%，已转 M1 工作项）**。**八项验收全部有结论，不存在可能推翻 Tauri 路线的未知。** 上表的「当前状态」列与本节是同一批数据的就地批注版，**引用结论时以报告为准**。
> 📌 **#2 于 2026-09-14 由用户人工判定通过**，它是八项里唯一结构性不可自动化的一项，也是原先唯一阻塞 M1 的项 → 条件已解除。
> 📌 **#4 不阻塞路线**：超标 11% 的根因是「按码点区块切分」让一屏字符散落到 25~36 个分片，修法是按字频重排分片（见上表 #4 行），已登记为 §3.3 的 M1 工作项（0.5 人日），不触及架构。
> ⚠️ **另有一个不属于验收项的独立阻塞**：`open` / LaunchServices 启动路径卡死。不阻塞 M1 开发（内层二进制可正常启动），**但阻塞正式分发**——Finder / Dock 双击才是用户的真实路径，需用户决定是否上真 Developer ID 签名 + 公证。详见 M0-REPORT §5「启动」行。
> ✅ **#1 的主观半于 2026-09-14 21:54 由用户人工判定通过**（5 万行文档、触控板连续滚动、「没有卡顿，挺流畅」），**M0 至此没有任何未知**。原计划「唯一会推翻 Tauri 路线的情形」= 人工判定手感不可接受 **且** Safari 对照组复现顺滑差异；前半条已被否定 → **该情形正式排除，Safari 对照组不必做**，`macOSPrivateApi` / 原生滚动容器 / 重估路线都不需要。
> 📌 **这条判定是在 `load 3.49 / 3.03 / 2.98` 下做出的，按不对称证据规则是更强的证据**（负载高时手感好 = 更严苛条件下达标，是个下界；负载高时手感差才不能归因于 Tauri）。⚠️ 但它也是 **M0 唯一没有数据产物的验收项**：人工判定不落盘、单次、无埋点核实实际滚动量，证据强度低于同节的量化项。

#### 脚手架现状（工具链四条腿）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0（修掉 5 个错误后） |
| `cargo check` | ✅ EXIT=0，173 个 rlib 依赖 |
| `pnpm build` | ✅ EXIT=0，538ms，首屏 gzip 当时 284.4KB → D7 字体注入改造后 **236.92KB**（当前明细见 §2.9） |
| `pnpm app:dev` | ✅ 27.21s 编译完成，窗口已启动 |
| `pnpm tauri build` | ✅ EXIT=0，产出 `src-tauri/target/release/bundle/macos/Vela.app`（可执行体 14.6MB），M0 的实测数据全部取自这个打包产物 |

**踩坑记录**：`bundle.icon: []` **不能**绕过图标要求——`tauri::generate_context!()` 在编译期无条件打开 `src-tauri/icons/icon.png`，缺失会让 proc macro panic。已用 `scripts/gen-icon.mjs`（纯 node+zlib 手写 PNG，512×512 船帆座图形，5.4KB）解决，避免为一个占位图标引入图像库依赖。
> 后续：`pnpm tauri icon` 会生成 **52 个**文件（含 android/ios/Windows 磁贴），macOS 只需要 5 个（icns + 三张 png + icon.png），已裁剪。`bundle.active` 也由此改为 `true`。

**剩余工作**（截至 2026-09-14，**八项验收全部有结论**：#1 #2 #3 #5 #6 #7 #8 通过，#4 机制通过但数值超预算已转 M1。下面只剩非阻塞的补测）：
- ✅ **#2 中文 IME 已由用户人工判定通过**（2026-09-14）。它是八项里**唯一结构性不可自动化**的一项——程序化插入文本会绕过 `compositionstart/update/end`（而那正是被测路径），合成键盘事件也驱动不了 IME 候选窗。未覆盖面（只验一种输入法、dPR=1）转 M1 的「CM6 封装层」工作项。
- ✅ **#1 已由用户人工判定通过**（2026-09-14 21:54，5 万行 + 触控板 + load 3.49）。**边界认知保留**：#1 只有一半可自动化——合成滚动 + 帧计时能给回归基线，但绕开了触控板惯性经原生手势的那一段，答不了「手感」，那一半只能人滚。**剩下的两项补测都不阻塞、也都不是决策输入**：安静机器（`load < 1`）复跑只作为 M1 的帧率回归基线；dPR=2（Retina）复测在正式发布前做。
- **#3 纯字体度量，已完全自动化**并三轮独立复现通过（含 2026-09-14 09:34 的 `visible` 复测），不再需要人眼判定。
- **#4 已测完，判为「机制 ✅ / 数值 ❌ 超预算 11%」**：首屏 2.219MB vs 2MiB 预算。根因是分片按码位区块切，修法（按字频重排）已登记为 §3.3 的 M1 工作项，不阻塞路线；**dPR 不影响本项，无需 Retina 复测**。详见上表 #4 行与 M0-REPORT §2。

**测量方法论（十五条踩出来的教训，比数据本身更值钱；第 9~14 条是补齐 #4 字节口径那一轮新踩的，第 15 条是 #1 主观判定那一轮）**：

1. ⛔ **「必须打包成 `.app` 再用 `open` 启动」这条已被推翻，原结论撤回。** 原先记的是「裸二进制拿不到 NSApplication activation，`visibilityState` 恒为 `hidden`，所有渲染数据都是废的」。2026-09-14 补齐 #4 时实测：**直接跑内层二进制**（`Vela.app/Contents/MacOS/vela`）才拿得到数据（`visible`、rAF 正常、矩阵跑完），`open` 反而卡在 `page-load Started` 不动。旧结论里 `hidden` 的真凶是**系统休眠**（远程 Jump Desktop 会话导致本地显示器/系统睡眠，`pmset -g log` 是权威），不是启动方式。
   → 教训本身比结论更值钱：**把「环境状态」误当成「启动方式」的因果，会让人在错误的变量上反复实验。** 当时为了绕开这个假想敌，加了 `focus: true`、`set_always_on_top`、重签名——全是冲着错的变量去的。
2. **每个样本都要记 `visibilityState` 和 `hasFocus`。** 窗口被完全遮挡时 WebKit 挂起渲染、释放图层与字形缓存，WebContent footprint 能从两百多 MB 掉到几十 MB。本项目因为漏记这个字段，白跑了两轮并得出过一个完全错误的归因结论（详见 `.m0-mem-ab.log` 的 B/C 段撤回记录）。
3. **扫描时钟只累计「可见时间」。** 被遮挡时停走而不是继续采样，这样产出的样本天然干净，不用事后剔除。
4. **`footprint` 绝不能高频循环。** 它要遍历进程的 VM region，本身就是重操作；每 4s 扫 4 个进程曾把机器推进交换态、连 shell 命令都超时。改成**阶段切换触发**（约 1 次/15s）。
5. **外部快照与被测阶段之间有竞态。** footprint 脚本靠轮询报告文件感知阶段变化，最多滞后 2s，凡是紧跟文档切换的快照都已被下一阶段污染，必须丢弃。
6. **A/B 之前先枚举两个基线之间**所有**变过的文件，不是只翻你怀疑的那一个。** 2026-09-14 的教训：滚动帧率从 60fps 掉到 55fps，我只把 `DEFAULT_CODE_FONT` 从 `maple-cn` 翻成 `inherit` 就当成了 A/B，但那一轮之间其实改了**四个**文件（`setup.ts` / `loader.ts` / `ProbePanel.tsx` / `App.tsx`），另外三个在两条腿里都在，于是被无声地算进了「插件的成本」。基于这个错误归因写了一整段节流代码，重新构建重跑后帧率**一位小数都没动**。
   成本几乎为零的做法：`stat -f '%Sm %N' -t '%m-%d %H:%M:%S' <相关源文件>`，把 mtime 和每轮测量的时间戳并排看，落在好基线之后、坏基线之前的**全部**是嫌疑变量。
   配套判据：**如果某个修复把开销削掉了一个数量级而指标完全没动，那不是「修复不够」，是「这个开销从来就不是成本」**——此时回到变量枚举，不要加大剂量。
7. **绝对帧率跨时间窗不可比，先量噪声带再谈效应。** run1/run2（06:00）测到 59.5~60.4fps，此后四轮（06:25~06:45）全是 54~57fps，而期间被摘掉又装回的组件（字体、装饰插件）对读数**毫无影响**。同期的机器状态：`load averages 3.79/3.93/4.62`，WindowServer 9.5% CPU、一个 VM 11%、Qoder 13%、`kernel_task` 8%。WindowServer 是逐帧合成的那一方，它被抢走 CPU 会**整体压低 fps 并加宽尾部**——症状正好是「均值掉 4fps + p95 从 21ms 涨到 45ms + 出现 8.5fps 的离群帧」，与「代码里多了点每帧工作」的表现无法区分。
   → 结论只能来自**同一负载窗口内的配对对比**，不能拿今天的读数去减一小时前另一负载下的读数。要判定某个改动值不值 4fps，就在同一个构建里做运行时开关、两条腿相隔十几秒各跑一次；并且**先连跑三次同一个构建**，把噪声带量出来，效应小于带宽就不能报为结论（同第 4 条）。
8. **保活断言会静默失效，必须用 `pmset` 验读到 1 再开跑。** `caffeinate -dimsu -w "$PID"` 在 `pgrep` 抓错 PID（空或抓到别的进程）时**不报错也不生效**；本机 `displaysleep=10`，显示器随即休眠 → 窗口转 `hidden` → WebKit 冻结 rAF → 矩阵开跑十几秒后卡死，产出的是一份「只有 2 个样本」的废数据，而脚本自己不会告诉你它废了。正确做法：用**独立进程**持有断言（`nohup caffeinate -dimsu -t 1200 &`），开跑前 `pmset -g assertions | grep PreventUserIdleDisplaySleep` 必须读到 **1**。
   → 通用教训：**靠运气对的不算对。** run4 之所以成功，是 `pgrep -f` 误抓到一个长命 shell、`-w` 反而一直挂着——机制是坏的，只是那一轮碰巧没暴露。凡是「前置条件满足才有效」的步骤，都要有一条独立于被测流程的验证手段。
9. **Tauri 默认不给 bundle 签名，`codesign --verify` 必然报红。** 默认产物只有链接器级的 `adhoc,linker-signed`：二进制本身有签名，但 `Info.plist=not bound`、bundle 里没有 `_CodeSignature/CodeResources`，于是 `codesign --verify --deep` 报 "code has no resources but signature indicates they must be present"。加 `bundle.macOS.signingIdentity = "-"` 才会同时签二进制与 bundle（并带上 hardened runtime 标志）。
   ⚠️ 但**签名不是 `open` 卡住的原因**——加完之后 `open` 照样卡在 `page-load Started`，`spctl -a -t exec` 仍是 `rejected`（无 Developer ID / 未公证）。真正的发布签名与公证是用户的决定，见 M0-REPORT §5。
10. **交叉校验的下标口径必须和被校验的集合一致。自检报红时先怀疑自检。** #4 的字节口径用了双路校验：主路按 `family + 归一化 unicode-range` 查表，交叉校验按「family 内出现顺序」对齐清单序号。第一轮跑出 **70 个 face 里 67 个「分歧」**，我据此判定「`document.fonts` 的迭代顺序 ≠ 注册顺序，交叉校验的前提不成立」，差点把一条正确的字节口径整个作废。
    真凶是一个下标 bug：`seenPerFamily` 的自增写在 `if (face.status !== 'loaded') return` **之后**，于是下标只数 loaded 的 face，而清单里 `known[]` 是整个 family 的 97/239 片——下标指向了错误的那一段。把自增提到 status 检查之前，同一批 70 个 face 立刻变成 `indexDisagreements: 0`。
    📌 顺带修正一条我先前对你说过、但被数据推翻的话：**「迭代顺序 == 注册顺序」这个前提是真的**，不成立的是我的下标。
11. **对抗性 fixture 不能用来判预算。** `mixed-10k` 是专门为压懒加载造的，刻意塞了 30 个跨区块生僻字（龘靐齉爨驫… / 㙟㙞㙓… / 𠀀𠀁𠀂…），一字一分片，拿它判「首屏 < 2MB」**必然超标**，而那不是用户会打开的文档。
    修法：另备一份关掉 `rareHan` 的代表性文档（`mixed-10k-common`）专用于判预算，两份之差正好是生僻字的代价（实测 2.219MB vs 2.446MB，+5 片 / +227KB）。
    ⚠️ **顺序也要钉死**：已加载的 face 不会主动卸载，所以必须**先测代表性文档、再测对抗性文档**，反过来读到的就是被污染的上界。
12. **已加载 face 数不是单调的，样本序列不能当增长曲线读。** 重建编辑器后实测已加载 face 从 **23 掉回 12**——WebKit 会释放不再被引用的字体数据。所以「空文档 + 界面中文」那一档只能给区间（11~23 片 / 0.49~1.07MB），不能给单点；任何「按时间递增」的画法都是错的。
13. **`document.fonts.ready` 会在加载波次之间提前 settle，单次读数不能当终值。** 实测 41ms 内连取两份是 **0.533MB → 2.160MB**，再过 3s 变成 **2.446MB**。`ready` 只保证「当前这一波」加载完了，不保证没有下一波。
    → 判「已收敛」要靠**静置复测 + 去重**：每 3s 复测一次，`captureShards` 对相同样本不落盘，于是启动日志里 `+6s / +9s` 两次**缺失的落盘记录**才是平台期证据。这条比任何单次读数都可信，因为它的判据是「没有变化」而不是「变化很小」。
14. **`createEffect` 里同步调用一个会读信号的异步函数 = 自我触发循环。** `runAlign` 第一行读 `alignBusy()`，effect 于是把它登记成依赖，而 `runAlign` 自己又写这个信号 → 实测 **~230 次/秒、90 秒落盘 20776 次**。修法是 `untrack(...)` 包住调用。
    ⚠️ 这类循环之前一直被两个东西掩盖着：「矩阵挂起标志」和「hidden 页面冻结 rAF」。**环境一干净就暴露**——这也是为什么第 1 条那个假想敌特别有害：它让页面长期处于 hidden，于是真 bug 一直没机会跑出来。
15. **主观性能判定的证据规则是不对称的：高负载下的「流畅」比安静机器上的「流畅」更强。** 机器一直安静不下来（`load 3.2~4.4`，最大占用者常是 Qoder 自己的 Renderer），我一度把「#1 主观半」挂着等一台安静机器。这是错的：判定规则应该**在开测前就写死**——负载高时若手感好，说明在比目标环境更严苛的条件下已达标（**下界**，结论更强）；负载高时若手感差，才不能归因于 Tauri（需复测）。实测落在前一种（`load 3.49` 下判「没有卡顿，挺流畅」），所以**等安静机器是没有必要的**，安静机器复跑随后被降级为「只作 M1 的帧率回归基线」。
    → 推广：**任何「等更好条件再测」的挂起项，都要先问「结果的两个分支分别意味着什么」**。若两个分支都能得出结论，当前条件就够用；只有一个分支能用时，才值得等。这条与第 7 条（差值小于噪声带不能报结论）是一对：第 7 条管「不能说」，本条管「其实已经能说」。
    ⚠️ **人工判定必须如实标注证据强度**：它不经探针、不落盘、没有 `.json` 可复核，是单次判定，而且「滚了 5 万行 / 30 秒」是按指引执行的、**没有独立埋点核实**。这不改变结论（主观手感本来只能这么测），但引用时要记住它弱于同节的量化项——**把弱证据写得和强证据一样确定，是另一种失真**。

---

### 3.3 M1 · 编辑器内核（10–12 人日）

**目标**：一个能日常使用的单文件编辑器。

| 工作项 | 人日 | 要点 |
|---|---|---|
| 项目脚手架 | 1 | Tauri 2.11.5 + Solid + Vite + TS 严格模式；`vela-core` crate 骨架；ESLint/Prettier/rustfmt/clippy；CI（build + test） |
| **命令注册中心** | 1.5 | **架构地基，必须 M1 就立起来**。含 `when` 上下文求值、快捷键绑定与冲突解析、命令面板数据源 |
| CM6 封装层 | 2 | EditorView 生命周期管理、扩展组合、与 Solid 的边界隔离（**关键：别让 Solid 碰 CM6 的 DOM**）、多实例（分屏）管理、`destroy()` 防泄漏；**多输入法验证**——M0 #2 只在一种输入法、dPR=1 下人工判定通过，这里要在系统拼音 + 一款第三方输入法（自己绘候选窗的那类）上各过一遍，并在 dPR=2 下复测候选框定位 |
| 多光标全套 | 1.5 | `Cmd+D`、`Cmd+Shift+L`、`Alt+Click`、列块选择、多光标下的查找替换 |
| 文件 IO | 1.5 | 打开/保存/另存为、编码探测（UTF-8/GBK/BOM）、LF/CRLF、原子写入、脏标记、外部改动检测 |
| 查找替换 | 1 | 正则、整词、保留大小写替换、查找选中词 |
| 编辑基本功 | 1 | 括号匹配、自动缩进、缩进引导线、代码折叠、行操作、排序去重 |
| 词补全 | 0.5 | 当前文档 + 项目词典 |
| 标签页 + 分屏 | 1.5 | 多标签、拖拽重排、水平/垂直分屏、聚焦切换 |
| 会话恢复 | 1 | 标签、光标、滚动位置、未保存草稿持久化（rusqlite/sled） |
| 语言高亮 | 0.5 | `@codemirror/language-data` 接入，子语言懒加载 |
| 状态栏 + 基础 UI | 0.5 | 行列、编码、换行符、语言、缩进、字数 |
| **字体分片按字频重排** | 0.5 | **M0 #4 的遗留超标项**。现状：分片按码位区块切，一屏汉字散落到 25~36 片，首屏实测 **2.219MB**（预算 2MiB，超 11%）。改为把常用 ~3500 字集中到头 1~2 片、其余照旧按码位切，粗估降到 1.0~1.2MB。⛔ **不要改用精简子集**——子集化触发 OFL 的 Reserved Font Name 改名义务（霞鹜 / LXGW 等）。Maple Mono CN 无 RFN，不受此限。详见 M0-REPORT §2 #4 |

**验收**：能用它替代 Sublime 完成「改配置文件、看日志、快速搜索替换」的日常闭环。冷启动 < 1s，空转内存 < 200MB，**首屏字体字节 < 2MB**（M0 #4 的口径：清单查表，不是 resource timing）。

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
| R1 | **WKWebView 滚动/输入手感不达标** | 🟢 **已排除**（M0 双证据） | 动摇整个 Tauri 路线 | ✅ **M0 未证实该风险**：客观帧计时低负载贴 vsync 上限（59.5~60.3fps，10k→50k 无退化），主观人工滚动（5 万行 + 触控板 + `load 3.49`）判「没有卡顿，挺流畅」。触发后备对策的条件（手感不可接受 **且** Safari 对照组复现顺滑差异）已不可能成立。<br>📌 **后备对策保留但不用做**：`macOSPrivateApi` / 原生滚动容器 / 重估技术栈——若将来在 dPR=2 或新的 macOS 版本上复现微延迟，仍按此顺序升级。详见 §3.2 #1 | M0 ✅ |
| R2 | **中文字体 24MB 拖垮「轻量」** | 🟢 **已收敛** | 安装包破 100MB，违背核心诉求 | ✅ **M0 实测：unicode-range 懒加载生效，安装包体积达标**。原风险基于「18.4MB=单变体」的错误估算，实际是 4 变体总和。<br>📌 **D2 分字体后我们确实同时打包 3 个 family / 433 片 / 18.07MB**（文楷 GB 4.33 + 文楷 R 4.87 + Maple 8.87），`.app` 合计 **23MB**，对 40MB 预算余量 **42%** → 安装体积这条已闭合，**不需要「只打包一个变体」**（那会牺牲代码区列对齐，见 R4）。<br>⚠️ **真正的遗留不是安装包而是首屏**：实测首屏字体 **2.219MB** 超 2MB 预算 11%（#4），修法是按字频重排分片，已登记为 §3.3 的 M1 工作项 | M0 ✅ |
| R3 | CM6 + Vite 生产构建陷阱 | 🟡 **已命中并修复** | 上线前才发现构建产物坏了 | ✅ M0 就验证 `vite build`，**果然踩中三个坑**：rolldown 拒绝对象形式 manualChunks、esbuild 不再内置（须 `minify:'oxc'`）、粗粒度 manualChunks 摧毁懒加载（623KB→284KB gzip）。详见 §2.3。**若留到 M6 才发现，返工成本会大得多** | M0 ✅ |
| R4 | CJK 列对齐漂移 | 🟢 **已收敛** | 代码区表格/缩进视觉错位 | ✅ **M0 实测通过**：代码区换 Maple Mono CN 后，在 CM6 里真实的 `.vela-code` 行上量到 CJK/ASCII = **2.0000**、框线/ASCII = **1.0000**、ASCII 极差 **0.0001px**、50 字累积漂移 **0px**，三轮独立复现（含一次 `visible` 复测）。文楷仅用于正文/UI（其拉丁是**比例宽度**，根本不等宽，故必须分字体）。<br>📌 量具本身已自动化，**不再需要人眼判定**；剩余口子是 dPR=2 与将来新增可切换字体时要重跑一遍。详见 §3.2 #3 | M0 ✅ / M4 |
| R5 | 大文件 IPC 序列化爆内存 | 🟡 中 | 打开大文件即崩溃 | 单次 payload 上限 4MB；>50MB 走 ropey 只读分片模式 | M2 |
| R6 | **API 发布即冻结** | 🟡 中 | 未来插件生态被烂 API 锁死 | M5 用示例插件反向验证；API 面从第一天就极小；带版本号 + shim 适配层 | M5 |
| R7 | License 误用（GPL/AGPL/BUSL 传染） | 🟡 中 | 闭源商业化受阻，法律风险 | 严格遵守 §2.10 清单；不 fork athas/hermes/Zed；Sarasa Gothic 与主题配色逐个核对；商用前法务复核 | 全程 |
| R8 | 范围蔓延（想做 LSP/终端/AI） | 🟡 中 | 工期翻倍，轻量定位丢失 | §1.3 非目标清单为硬约束；任何新增功能需先证明属于四个核心场景之一 | 全程 |
| R9 | CM6 长行 + 自动换行「pop 抖动」 | 🟢 **已实测，低** | 特定文档滚动手感 | ✅ **M0 已测**：超长行 fixture 下换行开/关两档帧率差在噪声带内（10k 59.5 vs 60.3fps、50k 60.3 vs 60.1fps，低负载），**没有可测量的抖动代价**。作者明确这是为响应性付的代价；「对超长行降级关闭换行」这条对策**当前不需要**，留作 dPR=2 复测时再看 | M0 ✅ / M1 |
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
| D2 | **代码区默认字体** | (a) 全程 LXGW WenKai（尊重偏好，接受列对齐漂移；**且 Screen Mono 无 webfont 包，要等宽得自己从 24.44MB TTF 切分**）<br>(b) 代码区 Maple Mono CN + 正文 LXGW WenKai | ✅ **已定 (b) 并实施完成**（用户拍板「按内容分字体」）。#3 的量化结果让 (a) 直接出局：文楷 Screen 的拉丁**根本不是等宽**（ASCII 步进极差 8.63px），连纯英文代码都对不齐，不是「2:1 有细微偏差」。<br>**实现**：`--vela-font-editor`（正文/UI）与 `--vela-font-code`（代码区）两个变量正交，CM6 侧用 ViewPlugin 按语法节点名 `FencedCode`/`CodeBlock`/`Table` 给整行打 `.vela-code` 行装饰（⛔ 不能按 token 走 CSS：`@lezer/markdown` 没有任何 `tags.monospace` 映射）。两套 `@font-face` 各自一个 `<style>` 节点同时驻留。<br>**选包**：`@automann/maple-mono-cn@7.9.2`（精确锁版）。OFL-1.1 且**无 Reserved Font Name** → 分片不触发改名义务，这点与文楷不同。只引 400 一个字重：239 分片 / 9.33MB / CSS 156KB(gzip 55KB)，作为独立 lazy chunk。<br>**代价**：安装包 woff2 从 9.2MB → 18.5MB，见 §2.9。(a) 保留为工具栏一键切换「跟随正文」，切过去 #3 应立刻变红，这本身是分流生效的反向证据 | **已完成** |
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
