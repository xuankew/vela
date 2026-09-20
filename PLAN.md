# Vela · 技术方案与实施计划

| | |
|---|---|
| **代号** | Vela（船帆座） |
| **文档版本** | v1.2 |
| **日期** | 2026-09-14 |
| **状态** | ✅ **M0 闸门通过、无阻塞项 —— M1 可开工**。**八项验收全部通过**（#1 #2 #3 #5 #6 #7 #8 于 M0 通过；#4 机制当时即通过，数值原判「超预算 11%」已由 **M1-G 重测改判达标**：首屏 1.039MB / 预算 2MB，原读数是压测稳态被错标成首屏）。推翻 Tauri 路线的情形已正式排除。实测数据见 [`M0-REPORT.md`](M0-REPORT.md)，§3.2 是就地批注版，§3.3「M1-G 实施修正」是 #4 的结案 |
| **技术栈** | Rust + Tauri 2.11.x + Solid + CodeMirror 6 |

---

## 0. 摘要

**Vela 是一款面向开发者的「速开编辑器 + 文本工具箱」**，对标 Sublime Text 的轻量与手感，内置 DevToys 级别的高频工具集，架构上按 Obsidian 的「一切皆命令」方式设计以便未来扩展插件。

**核心结论**

1. **编辑器内核选 CodeMirror 6**，不选 Monaco。gzip 体积 75–135KB vs 598KB+，且 Lezer 提供真 AST，是 Markdown 结构化预览的唯一现实路径。Obsidian 本身即 CM6。
2. **前端选 Solid**，runtime 8.4KB gzip，无虚拟 DOM，与 CM6 的命令式 DOM 管理边界最干净。
3. **文档模型 v1 放在前端**（CM6 的 `Text` 本身就是 rope），编辑零 IPC 延迟。Rust 侧**不持有全文**：超大文件走只读分片，Rust 只存一份「每 1024 行一个字节偏移」的稀疏索引，正文按行号窗口现读现还。⚠️ 这里推翻了原计划的 `ropey` 方案，理由见 §3.4「M2-H 实施修正」1。
4. **不碰任何 copyleft 代码**。Zed 编辑器核心是 GPL-3.0、athas 是 AGPL-3.0、hermes-ide 是 BUSL 1.1 且明文排除竞品编辑器——三者均不可复用于闭源商业化。可安全复用的是 MIT/Apache/Unlicense 生态：`memchr`、`ignore`、`grep-*`、`notify`、`tree-sitter`（`ropey` 也在这一档，但 M2-H 最终没有引入它）。
5. **插件系统 v1 只收敛接口、不开放**。把宿主能力全部收到带版本号的 `vela.*` 桥对象后面，用 2–3 个「假装是第三方」的示例插件反向验证 API 表达力。将来开放 L1 方案额外仅需 5–10 人日。
6. **中文字体是最大的体积风险**：`LXGWWenKaiScreen.ttf` 单文件 24.48MB。方案为 WOFF2 分片 + `unicode-range` 懒加载。✅ **M1-G 核实后已达标：首屏（启动 + 空文档 + 界面文案）实测 26 片 / 1.039MB，在 2MB 预算内。** M0 记的 2.219MB 是**1 万行合成压测文档滚完后的稳态**，被错标成了首屏；原写「分片按码位区块切、按字频重排可降到 1.0~1.2MB」的根因与修法**双双作废**——上游 `cn-font-split` 本来就按字频装箱，而把常用字集中成大分片反而会让典型一屏从 0.65MB 涨到 1.09MB。⛔ **不要自己动手切字体二进制**：上游 OFL 声明了 RFN `'LXGW'`，自切即成为 Modified Version 的作者，对闭源商业发布是实打实的责任（详见 §3.3「M1-G 实施修正」5）。
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
| 多光标 / 多选区 | `Cmd+D` 逐词选中下一个匹配、`Cmd+Shift+L` 全展开、`Option+Click` 添加光标、`Option+Shift+拖拽` 列块选择（修饰键归属的取舍见 §3.3「M1-C 实施修正」1、2） |
| 命令面板 | ✅ **已交付（M3-B-1d，2026-09-19）**：`Cmd+Shift+P`（`commandPalette.open`）打开一块居中浮层，模糊匹配**标题 / 分类 / 命令 id** 三处，每一行右侧显示它绑的键（`CommandInfo.keybindings` 本来就是格式化好的展示串），`when` 不通过的行置灰但**仍然列出来**（灰掉的一行至少告诉用户「有这个东西，现在按不动」，藏起来等于不存在）。`↑↓` 选、`Enter` 执行、`Esc` 收起、`PageUp/Down` 翻页、点遮罩空白处收起。<br>⚠️ **「唯一入口」这句原话不成立**：快捷键、工具栏按钮、右键菜单、工具箱左栏都是入口，命令面板是**兜底**的那个——它的价值是发现性（列出全部命令 + 显示每条的键），不是唯一性。⛔ **没有采用 `cmdk-solid`**，理由见 §3.5「M3-B-1 实施修正」2 |
| Goto Anything | ✅ **已交付（M2-E，2026-09-18）**：一个顶部浮层，四种意图共用一格输入框——空 = 最近打开过的、`store` = 模糊找文件（fuzzy match + MRU 加权）、`:42` = 当前文档跳行、`store.ts:42` = 打开并跳行、`@安装` = 当前文档的标题。`Cmd+P` 进去是文件模式、`Cmd+R` 进去直接是 `@`。<br>⚠️ **三处与原写不同**：① ~~`Cmd+R` 文件内符号（Lezer AST）~~ **只做 Markdown 标题**，其他语言诚实地说「这个语言还没有符号表」，⛔ 不退化成全文搜索、⛔ 不许长成代码智能；② ~~`Cmd+Alt+G` 跳转行号~~ **CM6 原生那条原样留着**，⛔ 不注册 `goto.line` 命令（抢键的失败方式是静默的），浮层里的 `:42` 是第二个入口而不是替代品；③ 索引**不跨会话缓存**，`index_project` 每次展开都重建。改判理由与踩坑见 §3.4「M2-E 实施修正」 |
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
- 「在 Finder 中显示」「复制相对/绝对路径」 ✅ **已交付（M2-B，2026-09-17）**：树右键菜单两项，Rust 侧走 `open -R` / `pbcopy`，用 `Command::arg()` 不过 shell

#### 已知能力上限（诚实标注）

- **大文件**：十万行 / 数十 MB 级流畅可编辑。**4 MiB 以上**进入**只读分片模式**（Rust 侧只持有一份稀疏行索引，正文按行号窗口现读现还，**不持有全文**），**256 MiB 以上**拒绝打开。百万行 / 百 MB 级 CM6 与 Monaco 都撑不住，不做承诺。<br>✅ **已交付（M2-H，2026-09-19）**，三处与原写不同：① 门槛是 **4 MiB**（`MAX_INLINE_BYTES`，管单次 IPC payload）而不是 50MB；② Rust **不持有全文**，`ropey` 方案作废（见 §3.4「M2-H 实施修正」1）；③ 分片里**没有 ⌘F**，靠全局搜索覆盖——为此把搜索的 `MAX_FILE_BYTES` 从 10 MiB 抬到 **64 MiB**，于是 **64–256 MiB 这一段是「打得开、搜不到」**，缺口是有意的、计入 `skipped_too_large` 上报而不静默。<br>⚠️ 分片只保证**能滚动能看**：单行超过 1 MiB 的那一段会显示「这一行太长，取不出来」占位（继续往下滚自愈），且不随外部改动刷新。
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

> 🔴 **这张表已被 M3-B-1 改判：v1 只做高频 6 个**（见 §3.5「M3-B-1 实施修正」3）。
> 表保留原样作为当时的估算，✅ 标出的是**已交付**的那一个。

| 分类 | 工具 |
|---|---|
| **格式化** | ✅ **JSON 格式化 / 压缩（可设缩进、排序键、去注释）—— M3-B-2 已交付**，三样能力逐项对上，另加一件表里没有的：语法错报「第 N 行第 M 列」并画一个脱字号，面板上还有「跳到出错处」（见 §3.5「M3-B-2 实施修正」）。<br>JSON ↔ YAML、SQL 格式化、XML / HTML 格式化、Markdown 表格对齐 ⛔ **推给「有人真的要再说」**（表格对齐已经以 `Mod+Shift+A` 那条命令的形式交付了，不在工具箱里，见 §3.5「M3-A-5 实施修正」） |
| **编解码** | ✅ **Base64 文本 + URL 编解码 —— M3-B-3 已交付**：一个工具、一格五选下拉（Base64 编码 / 解码、URL 编码「值」/「整条」、URL 解码），非法字符报「第 N 行第 M 列」并画脱字号，面板上有「跳到出错处」（见 §3.5「M3-B-3 实施修正」）。<br>⛔ **「Base64 图片」那半没做**——它要一条读任意路径或收文件选择器结果的通路，与 `assets/` 目录可配置化一起推给 M4（理由见「M3-B-3 实施修正」8）。<br>HTML 实体、JWT 解析（含 payload 与过期时间提示）、Unicode / 转义字符 ⛔ **推给「有人真的要再说」** |
| **生成器** | ✅ **UUID 生成（v4）—— M3-B-4 已交付**：一格「个数」（1…1000）+ 两格开关（大写 / 带连字符），面板上有「重新生成」（见 §3.5「M3-B-4 实施修正」）。<br>⛔ **ULID / NanoID 没做**——推给「有人真的要再说」，而加一个就是往 `BUILTIN_TOOLS` 里塞一项描述符。<br>✅ **时间戳互转 —— M3-B-4 已交付**（⚠️ 代码里的分类是**转换**不是生成器，本行按 P0 表的原始归类记账）：秒 / 毫秒 / 微秒 / 纳秒按**位数**猜并在报告里逐次披露，输出本地（带 UTC 偏移）/ UTC / ISO / 秒 / 毫秒 五行；日期只收 `YYYY-MM-DD`（也收 `/` 与 `.`），**不存在的日子**（`2024-02-30`，而 `new Date` 会静默滚到 3 月 1 日）报错带行列与脱字号。<br>⛔ **「时区」那半没做**：没有 IANA 时区选择器（`Asia/Shanghai` 那一种，推给 M4 与设置系统一起做），⛔ 也不收 `Mar 5, 2024` / `5/3/2024` / `2024年3月5日`，⛔ 也不做相对时间（理由见「M3-B-4 实施修正」15）。<br>哈希（MD5 / SHA1 / SHA256 / SHA512，走 Rust 侧）⛔ **压根不在用户选的 6 个里**，一行都没写 |
| **测试器** | ✅ **正则测试器 —— M3-B-5 已交付**：三格文字（正则 / 标志 / 替换成）+ 一格下拉（匹配清单 / 替换结果）。清单给「匹配 N 处」+ 每处的行列、下标、命中片段与各分组（`$1` 与 `$<name>` 两种叫法都给），`at` 指第一处于是面板上有「跳到第一处」；替换那一档交出去的是**纯**替换后文本（没有抬头），于是「插回编辑器」直接可用。模式或标志写错时报「第 N 行第 M 列」并画脱字号（见 §3.5「M3-B-5 实施修正」）。<br>⛔ **「实时高亮」没做**——用户在「先不做高亮 / 扩 `ToolResult` 装区间清单 + 只读 CM6 输出格 / 给它单独一块面板」三选一里选的第一个，理由见「M3-B-5 实施修正」1。<br>⛔ **没有超时中断**：灾难性回溯的模式会冻住整个窗口，真解是 Worker + deadline，见「M3-B-5 实施修正」11。<br>文本 Diff（两栏对比）、JSONPath 查询 ⛔ **推给「有人真的要再说」** |
| **文本** | ✅ **命名风格转换 —— M3-B-6 已交付**：⚠️ **没有「目标风格」下拉**，六种（小驼峰 / 大驼峰 / 蛇形 / 常量 / 短横线 / 点分）**一次全给**，理由是「要看一眼才知道自己要哪一个」（见 §3.5「M3-B-6 实施修正」1）。分词认三类边界，于是 `XMLHttpRequest` → `xml_http_request` 而 ⛔ 不是 `x_m_l_http_request`；中文整串算一个词，补充平面上的字符不会被吃掉。<br>⛔ **它不是批量转换器**：换行与空格在这里与 `_`、`-` 是同一类东西（分词符），粘两行得到的是**一个**双词短语的六种写法。<br>⛔ **大小写信息在分词那一步就被抹平**：`HTTPServer` 的大驼峰是 `HttpServer` 而不是 `HTTPServer`，理由见「M3-B-6 实施修正」4。<br>Cron 表达式解析（含未来 N 次触发时间）⛔ **推给「有人真的要再说」**——本行 0.5 人日因此是**部分兑现** |

#### P1 工具（M4+）

颜色转换与取色器、进制转换、二维码生成、CSV ↔ Markdown ↔ JSON 互转、GBK ↔ UTF-8 转码、图片压缩与格式转换（Rust `image` crate）、Lorem Ipsum / 中文假文、随机密码、JSON Array → Table

#### 智能检测（强烈建议进 P0）

粘贴任意内容，自动识别它是 JWT / Base64 / JSON / 时间戳 / 颜色值 / URL 编码，直接给出对应工具入口。这是 DevToys 最讨喜的设计，成本低但直接命中「使用便捷」诉求。

实现：一组带优先级的正则/启发式规则，输入变化时 debounce 150ms 执行。

#### 接入方式

工具可通过三条路径触达，全部走命令注册表：
1. ✅ `Cmd+Shift+P` 命令面板搜索工具名（M3-B-1d 已交付；`installTools` 把每个工具投影成一条 `category: '工具'` 的命令，所以「加一个工具」与「加一条命令」是**一次**调用，漏不掉）
2. ⛔ ~~绑定快捷键（如 `Cmd+Shift+J` → JSON 格式化）~~ **M3-B-1 决定一个都不绑**：六个工具会吃掉六个 `Mod+Shift+*`，而那一排只剩 `R` 空着；更要紧的是**入口的唯一性**——`Mod+Shift+T` 打开工具箱、里面 `↑↓` + `Enter` 换工具，「用一个工具」永远是两次按键，正好满足下面那条验收判据，再给单个工具绑键等于给同一件事开第二扇门。理由全文写在 `src/tools/registry.ts` 的文件头
3. ⚠️ ~~侧边栏「工具箱」面板，按分类浏览~~ **改成了一块居中大浮层**（`Mod+Shift+T`），不是侧边栏面板：左栏按分类列出工具、右栏是工作台。用户在「大浮层 / 底部面板 / 右侧第三栏」三选一里选了大浮层。代价是**用工具时看不见正文**，由「从编辑器取 / 插回编辑器」两个按钮补偿。改判理由见 §3.5「M3-B-1 实施修正」1

### 1.6 Markdown 友好

| 功能 | 实现要点 |
|---|---|
| 分屏预览 + 同步滚动 | `@lezer/markdown` 的 AST 映射源位置到预览位置。**不做 WYSIWYG** |
| 大纲面板 | 基于 AST 标题节点，支持点击跳转与折叠 |
| 表格自动对齐 | ~~编辑时自动补齐 `|` 与对齐空格~~，格式化命令可调 → ✅ **M3-A-5 已交付，但只做命令那一半**（`Mod+Shift+A`，按**显示宽度**对齐）。⛔ **「编辑时自动」被砍**：IME 组词期间整表重排会打散正在组的词、打字时横向抖动，而这两条在 jsdom 里一个都验不了；同理砍掉「回车补一行」「Tab 跳格」。理由与全文见 §3.5「M3-A-5 实施修正」1 |
| GFM 任务列表 | `- [ ]` 渲染为可点击复选框，点击回写源文件。✅ **M3-A-5 已交付**（`role="checkbox"` 的 span 而**不是** `<input>`：状态完全由源文档决定，点击只发一次普通编辑事务，所以它进撤销栈、置脏、跟着 ⌘S 落盘） |
| **图片粘贴自动落地** | `Cmd+V` 截图 → 存入 `assets/`（可配置路径与命名规则）→ 插入相对路径。**对写文档的人价值极高** → ✅ **M3-A-7 已交付，但两条都要改口**：① ⛔ **可配置没有交付**——`.vela/settings.json` 项目级配置由用户决定推到 M4（见 §3.4「M2-F 实施修正」1），所以 `assets/` 与命名规则（`pasted-<内容哈希>.<ext>`）**写死在 Rust 侧**，要改只能改代码；② ⚠️ **落地的图片在 Vela 自己的预览里不显示**，在导出的 HTML 里也不显示——`render.ts` 把本地图片映射成 `<span class="md-img-local">` 占位符，`file:` 不在允许的 scheme 里；要显示得启用 Tauri 的 asset protocol，那是一次**主动扩大攻击面**（`csp` 还是 `null`），M3-A-7 刻意不做。链接在 GitHub / Typora / 任何别的渲染器里都能用。理由与全文见 §3.5「M3-A-7 实施修正」1、3 |
| 链接补全 | 输入 `](` 时补全项目内相对路径文件 → ⛔ **M3-A-6 没做，仍未排期**。它与 §1.5 的词补全不是一回事：那一条补的是**文档里出现过的词**，这一条要补的是**项目里存在的路径**，得走 M2-E 那个文件索引（`query_project`）而不是 `wordSource`。原表把它与「统计、导出 HTML」并成一行估 1 人日，那一行现在只交付了后两样 |
| 统计 | 字数、字符数、阅读时长（中文按字符计，英文按词计）→ ✅ **M3-A-6 已交付，但形态是一条命令**（`editor.wordCount`，`Mod+Shift+C`，结果落在提示条上），⛔ **不是状态栏的一格**。理由是成本而不是位置：`syncMetrics` 在每一个事务上跑（包括只动了光标的），而字数是一次全文扫描。取舍全文见 §3.5「M3-A-6 实施修正」1 |
| 导出 HTML | 内联样式单文件导出 → ✅ **M3-A-6 已交付**（`file.exportHtml`，`Mod+Shift+E`）。**内联的是样式，不是字体**：⛔ 用系统字体栈，**不嵌霞鹜文楷**——OFL 的保留字体名那笔账还没结（§3.3「M1-G 实施修正」留给用户的那条），而一个导出功能不该悄悄替它结账。详见 §3.5「M3-A-6 实施修正」3 |

代码块内子语言高亮通过 `@codemirror/language-data` 懒加载。

### 1.7 项目与目录支持

| 功能 | 实现要点 |
|---|---|
| 侧边栏文件树 | **懒加载**（Rust 侧按需 `read_dir`，绝不建全量树）+ 前端虚拟化列表 + ~~`ignore` crate 遵守 `.gitignore`/`.ignore`/全局忽略~~ **改成不过滤**（实测慢 45×，见 §3.4「M2-A 实施修正」1）+ ~~`node_modules`、`.git`、`dist` 默认折叠~~ **这条已删**（整棵树本来就默认收起，见 §3.4「M2-B 实施修正」1） |
| 全局搜索 / 替换 | `grep-searcher` + `grep-regex`（ripgrep 的库化产物），**流式返回**结果（Tauri event 分批推送），按文件分组、~~带上下文预览~~ **只显示命中那一行**（改判理由见 §3.4「M2-C 实施修正」7）、点击跳转、~~支持 include/exclude glob~~ **glob 在 Rust 与 IPC 两侧都有、UI 刻意不暴露**（修正 8）。✅ **搜索半边已交付（M2-C，2026-09-17）**；✅ **替换半边已交付（M2-D，2026-09-17）**——预览**不另起一条 IPC**（同一条 `start_search` 在 `query.replace` 存在时就在命中里多带一个 `replaced`），落盘走第二遍 `start_replace` + 原子写，改判与踩坑见 §3.4「M2-D 实施修正」 |
| 多根工作区 | ✅ **已交付（M2-F-1~5，2026-09-19）**：一个项目挂多个文件夹。~~对齐 Sublime 的 `.sublime-project`~~ **没有项目文件**——工作区就是一份根清单，活在会话存档里（`Session.project.roots`），换台机器打开就靠最近项目那条路。⚠️ **落地面全在前端**：Rust 侧一个新文件都没加，只是让 `start_search` / `start_replace` / `index_project` / `query_project` 四条命令从收一个 `root` 改成收 `roots: Vec<String>`（一个 taskId、一次取消、一份总账）。改判与踩坑见 §3.4「M2-F 实施修正」 |
| 项目级配置 | ✅ **已交付（M4-A，2026-09-20）**：`.vela/settings.json` + 用户全局 `~/.vela/settings.json` + 内置默认，**三层合并** + 逐键 allowed-layers 门（原 🔴 **推迟到 M4**，用户在「M2-F 里做 / 推到 M4」两选一里选的后者，理由见 §3.4「M2-F 实施修正」1）。⚠️ **v1 只迁了字体三键（`fontSize`/`fontVariant`/`codeFont`）、且项目层对偏好键空转**（三个键全是个人偏好，只认全局），项目安全档建好了但是空的。落地与三条用户裁定见 §3.6「M4-A 实施修正」 |
| 最近项目 | ✅ **已交付（M2-F-6，2026-09-19）**：快速切换 `Cmd+Shift+O`，复用 `Cmd+P` 那个浮层的第四种意图（⛔ 一个新浮层都没加）。<br>⚠️ **与 M2-E 的 MRU 不是一回事，两者都在**：M2-E 记的是**最近打开过的文件**（`Session.recent`，用来给 `Cmd+P` 的模糊匹配加分），这里记的是**最近换过的工作区**（`Session.recentProjects`，一条是**一份根清单**而不是一个路径）。名字只差一个词、归属却在存档的两半里，见「M2-F 实施修正」5 |
| 外部改动监听 | ✅ **已交付（M2-G-1~5，2026-09-19）**：`notify` 8.2.0 + `notify-debouncer-full` 0.6.0（250ms 抖动合并）。<br>⚠️ **盯的是「打开着的文件」，不是整个项目**：订阅的单位是**这些文件的父目录**（上限 256 个），侧边栏那棵树**不跟着刷新**（M2-G 范围外，见 §3.4「M2-G 实施修正」1）。<br>三分流：干净文档被改 → **静默重读**，一个字都不问；脏文档被改、或文件被删 → 弹裁决框（覆盖 / 另存为 / 保留）。改判与踩坑见 §3.4「M2-G 实施修正」 |

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
| UI 组件 | ⛔ **一个都没采用，全部自写** | — | — | ~~**Kobalte** + **Ark UI Tree View**~~ / ~~`cmdk-solid` 做命令面板~~。✅ **M3-B-1 结案**：文件树（`src/project/tree.ts` + `src/ui/virtual.ts`）、跳转浮层（`src/goto/QuickOpen.tsx`）、命令面板（`src/commands/CommandPalette.tsx`）、工具箱（`src/tools/ToolBox.tsx`）四块全是手写的，**零 UI 依赖**。理由是体积而不是能力：首屏预算 300KB 的余量在 M2-H 时只剩 14.4%、M3-B-1 之后只剩 **8.25%**，而 `cmdk-solid` 会把 `@kobalte/core` 一起拽进来（一个通用无样式组件库，Vela 只用它一个组合框）。⚠️ 代价是**可访问性得自己写**：`role="dialog"` / `role="listbox"` / `role="option"` / `aria-selected` / `aria-disabled` / `aria-controls` 这些属性现在是逐块手写的，被各自的组件测试钉住，但没有第三方替我们兜底 |
| CSS | **纯 CSS Variables** | — | — | Tailwind v4 可选，桌面端收益有限 |
| 大文件只读分片 | **稀疏行索引 + `memchr`** | 2.8.3 | **Unlicense OR MIT** | ✅ **M2-H 已采用**（`memchr` 本来就在 `Cargo.lock` 里，是 `grep-searcher` 的传递依赖，改成直接依赖不多拉一个 crate）。⛔ **~~ropey 1.6.1 MIT~~ 从未落地**：`Rope::from_reader` 要把整份文件读进内存，256 MiB 的文件就是 ~256 MiB 常驻（rope 的节点开销还要更多），与 §2.9「空转常驻 < 200MB」直接冲突；而分片模式**只需要按行号取一段**，一份「每 1024 行一个字节偏移」的索引 + `pread` 就够了，常驻内存与文件大小**脱钩**。作废理由见 §3.4「M2-H 实施修正」1 |
| 目录监听 | **notify** | 8.2.0 | CC0-1.0 | ✅ **M2-G 已采用**。`default = ["macos_fsevent"]` → 传递依赖 `fsevent-sys` 4.1.0（MIT）。Linux 侧走 `inotify` 0.11.5（**ISC**）+ `mio` 1.2.3（MIT），两者都已在 `Cargo.lock` 里（lockfile 与平台无关），CI 的 `rust` job 跑在 ubuntu-latest 上会真的编译它们。9.0.0-rc.5 有三项 macOS FSEvents 专项优化，M4 评估切换 |
| 抖动合并 | **notify-debouncer-full** | 0.6.0 | **MIT OR Apache-2.0** | ✅ **M2-G 已采用**。⚠️ 与 `notify` **不同 license**（附录 B 原来把它记成 CC0-1.0，已更正）；传递依赖 `notify-types` 2.1.0、`file-id` 0.2.3 都是 MIT OR Apache-2.0。**四个 license 都逐个从 registry 里的 `Cargo.toml` 读过**，不是照抄文档 |
| 遍历与忽略 | **ignore** | 0.4.33 | Unlicense OR MIT | ripgrep 同款 `WalkBuilder` |
| 全文搜索 | **grep-searcher / grep-regex / grep-matcher / grep-cli** | 0.1.x | Unlicense OR MIT | crate 源码仅 16–74KB，体积影响可忽略 |
| 会话存储 | **无**（`app_data_dir()/session.json` 单个 JSON 文件 + 复用已有的原子写） | — | — | ✅ M1-F 已定：**rusqlite / sled 都没加**，理由与重估点见 §3.3「M1-F 实施修正」1 |
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
- ⛔ ~~命令面板：`cmdk-solid` 1.2.0（基于 `@kobalte/core`）~~ **M3-B-1d 自写**（`src/commands/CommandPalette.tsx` + `src/commands/palette.ts`），零依赖。理由见 §2.4「UI 组件」那一行
- ⛔ ~~文件树：`Ark UI` Tree View（支持 lazy loading + virtualization，多框架）~~ **M2-B 自写**（`src/project/tree.ts` + `src/ui/virtual.ts`），零依赖。多根、右键菜单、拖拽、`Cmd+P` 复用都已经在自己的代码里，换一个组件库等于重写一遍接线
- ⛔ ~~备选：`headless-tree`（898★，虚拟化 + 拖拽 + 键盘导航）**仅 React** → 若坚持用它则被迫选 React，不划算~~ **这一条随上一条一起作废**：Solid 留下了，React 从没进场

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
- **打开**：读文件 → 一次性传字符串给前端（**≥ 4 MiB 走只读分片**，✅ M2-H 已落地）
- **保存**：接收全文 → 编码转换 → 原子写入（临时文件 + rename）
- **搜索**：完全在 Rust 侧，流式推结果
- **监听**：`notify` 事件推送（✅ M2-G 已落地：订阅的单位是**打开着的文件的父目录**，不是项目根，见 §3.4「M2-G 实施修正」1）

✅ **M2-H 已落地，但只读分片那一层没有走上面表格里的第二条路**：Rust **不持有全文**，而是扫一遍文件建一份「每 1024 行一个字节偏移」的稀疏索引，前端按**行号**请求 `read_lines(handle, start, count)`，Rust 从最近的锚点 `seek` 过去、现读现还。三处与原写不同：

1. **请求的单位是行号窗口 `[start, count)`，不是字节区间 `[startByte, endByte]`。** 字节区间要求前端自己知道行边界，而前端压根没有全文；行号才是虚拟列表天然的单位（`visibleWindow` 回的就是 `{start, end}`）。
2. **常驻内存与文件大小脱钩**：256 MiB 的文件、10 字节一行，索引也就 `ANCHOR_STRIDE` 一个锚点 8 字节 ≈ **210 KB**，正文一页页过手就走。`ropey` 的 `Rope::from_reader` 做不到这一点——它要把整份读进来，一个 500 MB 的日志就是 500 MB 常驻，而且是**打开成功之后**才超预算，界面上看不出异常。代价是「跳到第 N 行」要从最近的锚点顺着扫过去，最多 1023 行（几十 KB 的读）。
3. **上限是 256 MiB**（`MAX_SHARD_BYTES`），再往上直接拒绝打开，而不是退化成别的模式。

> **推论**：绝不在 IPC 里传整个大文件。JSON 序列化一个几十 MB 的字符串会直接爆内存。这是 Tauri 编辑器场景的头号性能陷阱。⚠️ 这条推论对**分片模式本身**同样成立，于是有了第二条上限：`read_lines` 单次最多回 1024 行 / 1 MiB 原始字节（`MAX_PAGE_LINES` / `MAX_PAGE_BYTES`），单行超长时宁可在前端显示占位也不把一页撑爆。

### 2.5 Rust 侧架构

```
vela-core/
├── fs/          文件读写、编码探测(UTF-8/GBK/BOM)、原子写入、✅ M2-H 大文件只读分片（`fs/shard.rs`：
│                稀疏行索引 + 按需读盘，**不持有全文**）
├── search/      grep-searcher + grep-regex + ignore::WalkBuilder，流式结果通道
├── watcher/     ✅ M2-G：监听计划（哪些目录该订、哪些输入要丢）+ 事件分类（还在→changed / 没了→removed）。
│                ⚠️ **纯函数，一个 `notify` 依赖都没有**——真的 debouncer 与托管状态住在
│                `src-tauri/src/watcher.rs`，理由与下面「M1-B 实测修正」那条逐字相同
├── project/     多根工作区（✅ M2-F）、文件树、文件索引
├── session/     会话持久化（标签/光标/滚动/未保存草稿）
├── settings/    ✅ M4-A：三层配置合并（内置默认 → 用户全局 `~/.vela/settings.json` → 项目级
│                `<root>/.vela/settings.json`）+ 逐键 allowed-layers 门。⚠️ **load 不缓存、无状态**
│                （每次现读现合并，所以 managed state 仍 4 份没涨）；save **只写用户全局层**，
│                落点由 `src-tauri` 的 `home_dir()` 算、前端碰不到（与 `session_path` 同一姿势）
└── tools/       重计算工具的 Rust 实现：哈希、图片处理、编码转换
```

> **M1-B 实测修正**：原计划的 `ipc/` 模块**没有**放进 vela-core。Tauri command 住在
> `src-tauri/src/commands.rs`（一层薄适配器），vela-core 只导出框架无关的 `fs::read_text`
> / `fs::write_text_atomic`。理由：一旦 vela-core 依赖 `tauri`，它的测试就需要 `AppHandle`，
> 而且再也不能被 CLI 工具或无头批处理复用——那正是「框架无关」这一层要保住的东西。
> 线上数据结构（`FileFormat` / `TextFile` / `WriteReport` / `ReadError` / `WriteError`）就
> 定义在 `fs` 模块内，由 command 层原样返回，不另设 `types/`。
>
> 上面这棵树的落地进度：**`fs/`（M1-B）、`session/`（M1-F）、`project/`（M2-A）、`search/`（M2-C）、
> `watcher/`（M2-G）已落地**，只剩 `tools/` 还没有——等真正用到时再加，不预先建空目录当装饰。
> ⚠️ **M2-G 是第一个在树的两侧各加一个同名模块的**：`crates/vela-core/src/watcher/mod.rs`（纯函数）
> 与 `src-tauri/src/watcher.rs`（`notify` + debouncer + `WatcherState` 托管状态 + `set_watched` 命令）。
> `fs/` 那一对是 `fs/` ↔ `commands.rs`，名字不同，所以「同名分居两侧」这件事是 M2-G 才出现的：
> grep `watcher` 会同时命中两边，读代码时先看清是哪一侧。
> **M2-H 是第二个**：`crates/vela-core/src/fs/shard.rs`（稀疏行索引 + `open_shard` + `Shard::read_page`，
> 框架无关、可单测）与 `src-tauri/src/shard.rs`（`ShardRegistry` 句柄表托管状态 + `open_large` /
> `read_lines` / `close_large` 三条命令）。⚠️ 分工与 `watcher` 那一对**不一样**，别照着套：
> watcher 的纯函数层连一个 `notify` 依赖都没有，而 `fs/shard.rs` **自己就持有那个 fd**
> （`Shard { header, index, file }`——把 fd 关在结构里，「索引与内容来自同一个 inode」才是结构上成立
> 而不是一句注释）；命令层管的是**谁还活着**：`HashMap<u64, Arc<Mutex<Shard>>>`，句柄换 `Shard`。
> 于是两侧收的参数类型不同——内核收路径 / `&mut Shard`，命令收**整数句柄**。grep `shard`
> 会同时命中两边，外加前端的 `src/ipc/shard.ts` 与 `src/doc/shardView.ts`，一共四处。
> ⚠️ `project/` 已经不只是 `tree.rs` 了：`ops.rs`（M2-B-5a：新建/重命名/解析已存在）、
> `walk.rs` + `index.rs`（M2-E-1：遍历 + 文件索引 + 手写模糊匹配 + MRU 加权）。
> 多根工作区（M2-F）**一个 Rust 新文件都没加**——`project/` 还是 `mod.rs` + `tree.rs` +
> `ops.rs` + `walk.rs` + `index.rs` 五个，改的只是 `start_search` / `start_replace` /
> `index_project` / `query_project` 四条既有命令从收一个 `root` 改成收 `roots: Vec<String>`，
> 以及 `session/mod.rs:152` 那个 `SessionProject` 的形状
> （`{root, expanded}` → `{roots: [{root, expanded}]}`）。
> `.vela/settings.json` 分层合并原**推迟到 M4**（用户在两选一里选的后者，理由见
> §3.4「M2-F 实施修正」1）；✅ **M4-A 已交付**，落在新的 `settings/` 模块（不是 `project/` 里），
> 与它三条用户裁定见 §3.6「M4-A 实施修正」。
> ⚠️ 本节原文写着「**最近项目（MRU）本来也记在 M2-F 名下，M2-E 提前做掉了**」，
> 这句**只对了一半**：M2-E 做的是最近**文件**（`Session.recent`，落在**前端**
> `src/doc/workspace.ts`，Rust 侧只拿它当加分权重、不持有任何状态，见「M2-E 实施修正」5）；
> M2-F-6 补上的是最近**工作区**（`Session.recentProjects`，一条是**一份根清单**而不是一个路径，
> 落在 `src/project/store.ts`）。两者名字只差一个词、归属却在树的两边，
> 判据只有一条：它记的东西是文档还是文件夹（见「M2-F 实施修正」5）。

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
2. 前后端类型不得漂移。**M1-B 实测修正**：原计划用 `specta` + `tauri-specta` 生成 TS 类型，
   实际改为「手写 `src/ipc/fs.ts` + 两侧黄金 JSON 契约测试」：
   `crates/vela-core/tests/wire_contract.rs` 钉住 Rust 的序列化输出，
   `src/ipc/fs.test.ts` 用同一份黄金字符串钉住 TS 侧的解析与字段名，两边任一处改了字段
   都会红。理由：当前只有 2 个 command / 5 个类型，codegen 要引入一个构建期步骤和一层
   宏（宏展开报错的排查成本远高于手写），不划算。**重估点在 M1-H**：等 command 数量涨到
   两位数（搜索、工具、会话）再上 codegen。
   ✅ **M1-H 已重估：不引入。** 实测 command 仍是 **5 个**（`open_file` / `save_file` /
   `close_window` / `load_session` / `save_session`），触发条件未达到。
   ⚠️ **并更正本节原来的一句话**：原写「届时黄金 JSON 测试可以直接退役」**是错的**。
   specta 保证的是「TS 类型与 Rust 类型同形」，**保证不了线上字节的形状**——今天钉住的
   三件事它一件都看不见：① Rust 的 `f64` 序列化成 `0.0` 而 `JSON.stringify` 写成 `0`；
   ② `serde(rename_all)` 是否真的生效；③ `bytesWritten: 437` 是由黄金会话现算出来的。
   所以 codegen 是**补充**而不是替代。重估点改为：手写类型成为真实负担时（command 上两位数）
   再上，且**黄金 JSON 测试保留**。详见 §3.3「M1-H 实施修正」8。
   ⚠️ **M2-E 收尾时这个数字条件已经过了，但没有触发引入——因为真正的判据是「成为真实负担」，
   而它还没发生。** 当时 `invoke_handler` 里是 **16 个** command（`open_file` / `save_file` /
   `list_dir` / `create_entry` / `rename_entry` / `trash_entry` / `reveal_entry` /
   `copy_entry_path` / `close_window` / `load_session` / `save_session` / `start_search` /
   `start_replace` / `cancel_task` / `index_project` / `query_project`）。M2-C 到 M2-E 这三轮
   一共加了 7 个，**没有一次是因为手写类型漂移而返工**——两侧的黄金 JSON 契约测试每次都先红。
   也就是说：负担的**风险**随 command 数涨，但「specta 能省下的那份工」至今是零，而它要引入的
   是一个构建期步骤 + 一层宏（宏展开报错的排查成本，M1-B 当时就量过）。**下一次真出一次
   字段名漂移没被契约测试逮住，就是引入它的时机**；在那之前继续手写。
   ⚠️ **M2-G 又加了一个（17 个：多一个 `set_watched`），判据仍然没触发。** 这一条恰好是
   「手写 + 两侧黄金 JSON」这套办法**最**够用的一次：`WatchStats` 五个字段、`FileChange`
   两个小写单词，一共就这点线上形状，而漂移的失败方式是「外部改了文件而 Vela 一声不吭」——
   界面上没有任何东西可看、控制台一行错都没有（详见 `src/ipc/watch.ts` 的文件头）。
   两侧各有对照：Rust `src-tauri/src/watcher.rs` 的 `监听总账的线上形状` /
   `文件改动载荷的线上形状` + `wire_contract.rs` 的 `file_change_是两个小写单词`，
   前端 `src/ipc/watch.test.ts`，事件名另有 `lib.rs` 的 `file_changed_event_matches_frontend`
   （**第八个**事件名快照测试）。
   ⚠️ **M2-H 加到 20 个 command / 4 份 managed state，判据依然没触发——但这一轮把「参数名」从
   顺带钉住变成了必须钉住。** 三个新 command 是 `shard::open_large`（第十四条收路径的
   命令）/ `shard::read_lines` / `shard::close_large`；第四份 managed state 是 `shard::ShardRegistry`，
   它是这四份里**唯一一个必须有人来收尾的**——`TaskRegistry` / `ProjectIndexCache` / `WatcherState`
   里残留一个条目，代价是一次白算或一次白发的事件；`ShardRegistry` 里残留一个条目就是一个**不会
   自己关掉的 fd**。
   线上形状的对照仍然是三处：vela-core `fs/shard.rs` 的 `元信息的线上形状`、`wire_contract.rs` 的
   `分片元信息与分页的线上形状` 与 `分片接不住的编码在契约上有其名`（那一节跑**真的** `open_shard`）、
   src-tauri `shard.rs` 的 `线上形状`（`{ handle, header }` 那层信封只在这一侧存在），前端
   `src/ipc/shard.test.ts`。
   🔴 但这一轮**最安静的失败方式不在返回值里，在参数里**：`read_lines` 收 `handle` / `start` / `count`
   三个整数，其中两个交换之后要么句柄不存在（回 `null`，视图空白），要么碰巧存在——于是把**另一个
   文件的行号当句柄**用，读出的是别人的正文。所以 `src/ipc/shard.ts` 的 `readLines` 收一个对象而不是
   三个位置参数（交换在语法上就写不出来），并且三个键名与键序逐个进了断言
   （`shard.test.ts:142`；M2-G 的 `watch.test.ts` 已经钉过一次参数名，但那边只有一个 `paths`）。
   ⚠️ **M4-A 加到 23 个 command（多 `load_settings` / `save_settings`），判据依然没触发，managed state 仍 4 份**
   （配置层**无状态**：每次 load 现读现合并、不缓存，所以没添第五份）。这一轮最该钉的是**参数名 `settings`**
   （不是 `session` 那种早就钉过的）：`save_settings` 收一个对象、`load_settings` 收一个 `roots` 数组，
   两侧各有黄金 JSON 对照——Rust `settings/mod.rs` 的单测 + `wire_contract.rs` 那 7 条线上形状，
   前端 `src/ipc/settings.test.ts`（16 条，含把契约默认值与字体注册表 `DEFAULT_VARIANT`/`DEFAULT_CODE_FONT`
   对起来那一条）。🔴 **写盘落点不收路径参数**（`save_settings` 的 `~/.vela/settings.json` 由 Rust `home_dir()` 算），
   所以「参数名漂移」这一轮的风险面比 M2-H 那条「整数句柄交换」小，详见 §3.6「M4-A 实施修正」6。
3. 长任务（全局搜索、大文件读取）一律返回 `taskId`，通过 event 推进度，支持前端取消。
   ⚠️ **M2-H 的 `read_lines` 是这条规则的第二个例外**（第一个是 M1 的 `open_file`）：它把结果直接
   返回，不给 `taskId`、不推 event、不可取消。理由是单次上限被 `MAX_PAGE_LINES`（1024 行）/
   `MAX_PAGE_BYTES`（1 MiB）夹死，最坏情况是从锚点顺扫 1023 行——那是几十 KB 的顺序读，给它做一套
   取消机制比它本身还贵。⛔ 这条例外**只在「单次有硬上限」时成立**：`open_large` 要现扫全文建索引，
   256 MiB 上就不是几十 KB 了，它跑在 `spawn_blocking` 里但同样不可取消——那是 §3.4「M2-H 实施修正」
   12 记的真机债之一（冷读耗时一个数都没有），不是设计上已经过关。
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

> ✅ **M3-B-1 对账**：这句话列的四个视图，现在**命令面板**（`Mod+Shift+P`）、**快捷键绑定**、**侧边栏按钮/工具栏按钮**三个都真的存在了；⛔ **菜单栏没有，也不打算有**——`src-tauri/src/lib.rs` 里一条 `MenuBuilder` 都没写，所以 macOS 上 Vela 的菜单是系统给的那套默认项（这也是 `Mod+W` / `Mod+Shift+W` 绑不上的原因）。而「内置工具也是命令」那半句由 `src/tools/registry.ts` 的 `installTools` 兑现：它把每个工具投影成一条 `category: '工具'` 的命令，**没有第二个注册表、没有第二份 keybinding 解析、没有第二份 `when` 求值**。⚠️ 主题切换至今**不是**命令（M4 的活）。

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
| 空转常驻内存（macOS） | **< 200MB** | ✅ **均值 104MB / 峰值 109MB**（余量 46%，`phys_footprint` 口径，dPR=1）。⚠️ **M2-H 之后这一行的含义变宽了但没重量**：分片模式让常驻内存与文件大小**脱钩**（256 MiB 的文件只留 ≈210 KB 索引，见 §2.4），所以「打开一个大文件」不再自动意味着超预算——这正是 `ropey` 方案被作废的理由。**但脱钩只在纸面上算过，没有实测**：开着分片时的 `phys_footprint` 一个数都没有 | Tauri 基准 ~172MB；Electron 为 ~409MB |
| 打开 10 万行文件 | **< 2s**，滚动 60fps | 滚动已测：5 万行手感档 **60fps**（见 §3.2 #1）。10 万行未测。⚠️ **M2-H 把这一行劈成了两半**：10 万行通常在 4 MiB 以下，仍走**内联 CM6**（原样未测）；超过 4 MiB 的十万行文件根本进不了 CM6，走分片，那「< 2s」考的就变成了 `open_shard` 那一趟顺序扫描建索引（一次 `memchr` 数 `0x0A`），而**冷读**（不在 page cache 里、尤其在网络卷上）的耗时同样一个数都没有 | — |
| 全局搜索（10 万文件仓库） | **首批结果 < 2s** | ✅ **M2-C 实测达标，但改判过一次**。**心跳之前**：有 2000 处命中时首批 **65.6ms**（达标），而**一个都不命中时首批 7.14s**（超预算 3.6 倍）——批次以「有命中的文件」为单位，没命中就没批次，而那 7 秒里前端手上什么都没有。**心跳之后**同一棵树复测：第一个信号 **33.75ms**（快约 218 倍）、390 次心跳、最长静默 40.3ms、总耗时 7.35s 基本没变；有命中那侧首个结果 **52.9ms**。⚠️ 量的是**合成的十万文件树**（外部卷、release），不是含 `node_modules` 的真实仓库。⚠️ **M2-H 把单文件上限 `MAX_FILE_BYTES` 从 10 MiB 抬到 64 MiB**（理由见 §3.4「M2-H 实施修正」3），于是最坏情况那个「慢文件」的空洞从实测的 6.9–8.5ms 变成**线性外推的 ≈55ms**——外推不是复测，与 `HEARTBEAT_MS`（250ms）的余量从一个数量级缩到 ~4.5×。真要把上限再抬，这一条得重量 | ripgrep 级 |
| 前端 bundle（gzip） | **≤ 300KB** | ✅ **M0 219.58KB**（余量 27%）→ **M2-C 244.29KB** → **M2-D 247.56KB** → **M2-E 收尾 250.60KB** → **M2-F 252.52KB** → **M2-G 254.16KB** → **M2-H 256.69KB**（余量 14.4%）→ **M3-A 收尾 269.03KB**（余量 10.32%）→ **M3-B-1 275.26KB**（余量 8.25%）→ **M3-B-2 277.66KB**（余量 7.45%）→ **M3-B-3 278.94KB**（余量 7.02%）→ **M3-B-4 282.19KB**（余量 5.94%）→ **M3-B-5 284.01KB**（余量 5.33%）→ **M3-B-6 284.61KB**（余量 5.13%）→ **M3-C 277.37KB**（余量 **7.54%**）→ **M4-A 277.84KB**（余量 **7.39%**）。M0 探针脚手架已于 2026-09-14 整体删除，从 236.92KB 回落 17.34KB；此后 M1 的编辑器功能与 M2 的文件树/全局搜索/全局替换/Goto Anything/多根工作区/文件监听/大文件只读分片一路加到 256.69KB（M2-H 时是 `index-CNF4LQvD.js` 145.45 + `dist-Cx7xBNi0.js` 108.38 + `index-B0zf3Qrw.css` 2.86；**M3-B-1 之后是 `index-CYDsHyFQ.js` 162.68 + `dist-Cx7xBNi0.js` 108.38 + `index-BhMjxJ3w.css` 4.20；M3-B-2 之后是 `index-DeVDbUsH.js` 165.08 + 后两个逐字不变；M3-B-3 之后是 `index-DE5ksiWr.js` 166.36 + 后两个仍逐字不变；M3-B-4 之后是 `index-DXtGvns0.js` 169.61 + 后两个仍逐字不变；M3-B-5 之后是 `index-BOqJdQFy.js` 171.42 + 后两个仍逐字不变；M3-B-6 之后是 `index-DniRLlC2.js` 172.02 + `dist-Cx7xBNi0.js` 108.38 + `index-B2FiruYW.css` 4.21；M3-C 之后是 `index-DLQUEx4N.js` 172.95 + `dist-uhAGXbQS.js` 100.21 + `index-B2FiruYW.css` 4.21；M4-A 之后是 `index-CXlrqgld.js` 173.42 + 后两个逐字不变**（🔴 **CM6 那个 modulepreload chunk 的哈希与字节自 M2-E 以来第一次变**：`dist-Cx7xBNi0.js` 108.38 → `dist-uhAGXbQS.js` 100.21，引入 `lazy()` 边界后 rolldown 重画分包图、在 entry 与 vendor 之间挪了模块，⛔ 不是 CM6 被懒加载，见 §3.5「M3-C 实施修正」7；⚠️ CSS 的**哈希**变了而字节只长 0.01KB——M3-B-5a 给文字格加了一条 `.toolbox-option input[type='text'] { width: 180px }`））。⚠️ 增量最大的一步是 M2-C-4c 的 **+3.60KB**——`App.tsx` 开始 import `src/search/*`，那一整层不再被 tree-shaking 摇掉；M2-D **+3.27KB**（替换那一排 UI + 确认单 + 一条命令）；M2-E **+3.04KB**（`src/goto/*` 五个模块 + `src/ui/virtual.ts` + 浮层 CSS 0.24KB + 两条命令）；M2-F **+1.92KB**（多根 + 最近项目，⛔ 一个新浮层都没加）；M2-G **+1.64KB**（裁决框整套复用 `.modal-*`，**CSS 一个字节都没长**，哈希与 M2-F 逐字相同）；M2-H **+2.53KB**（`src/doc/shardView.ts` + `src/doc/ShardPane.tsx` + 状态栏那一排只读格 + `App.tsx` 接线；**CSS +0.17KB，哈希自 M2-F 以来第一次变**——新增的是一整套 16 条 `.shard-*` 选择器，状态栏那几格复用既有样式）；M4-A **+0.47KB**（`settings/store.ts` + `ipc/settings.ts` + `App.tsx` 字体信号接线，全落在 entry；CSS 与 modulepreload chunk 一个字节没动，也没加任何新懒加载边界——`settingsNotice` 复用既有 `.notice warning`）。⚠️ **M2-E 起 CM6 那个 modulepreload chunk 不再是 M0 那一个字节不差的 108.31KB，变成 108.38KB（hash 也随之换了）**——没有追查原因，0.07KB 的量级不值得为它停一次工，但「一个字节没变」这句话从此不再成立 | CM6 内核 100.21KB（modulepreload chunk，🔴 **「自 M2-E 起一个字节没动」这句话到 M3-C 断了**：`dist-Cx7xBNi0.js` 108.38 → `dist-uhAGXbQS.js` 100.21，rolldown 因 `lazy()` 边界重画分包图、在 entry 与 vendor 之间挪了模块，⛔ 不是 CM6 被懒加载，编辑器仍首屏，见 §3.5「M3-C 实施修正」7）+ 入口 173.42KB（Solid + CM6 基础扩展 + 应用代码；M4-A，M3-C 时是 172.95）+ 应用 CSS 4.21KB。✅ **`cmdk-solid` / `@kobalte/core` / `@ark-ui/solid` 三个 UI 依赖一个都没进场**（M3-B-1 结案，见 §2.4「UI 组件」那一行），所以「这 14.4% 不是永久空间」那句担心没有以它预想的方式兑现——**兑掉它的是 M3 自己的功能代码**。🔴 **余量 5.13% → M3-C-1/C-2 买回到 7.54%（277.37KB）**：`md/render.ts`（41KB 源）、`md/export.ts`、`md/preview.ts`、`md/MarkdownPreview.tsx`、`commands/CommandPalette.tsx`、`tools/ToolBox.tsx` **已移出首屏**（六个懒加载 chunk，见 §3.5「M3-C 实施修正」）；⛔ **`md/paste.ts` + `ipc/asset.ts` 与 `doc/stats.ts` 仍在首屏**——M3-C-3 未做：paste 卡在「同步粘贴闸」那道约束上（`acceptsPastedImage` 必须同步回答，要移得先拆模块），stats 是纯没做（字数命令本可 `await import`）。所以「M3-C 的懒加载是把余量买回来的唯一手段」这句话**只兑现了一部分**，⛔ 不是全部买回来。⛔ **`tools/registry.ts` + `tools/builtin.ts` + `tools/json.ts` + `tools/codec.ts` + `tools/uuid.ts` + `tools/time.ts` + `tools/regex.ts` + `tools/naming.ts` + `util/base64.ts` 九个圈不进去**（工具要在启动时投影成命令），M3-B-2 那 2.40KB、M3-B-3 那 1.28KB、M3-B-4 那 3.25KB、M3-B-5 那 1.82KB 与 M3-B-6 那 0.60KB 因此都是首屏常驻的，见 §3.5「M3-B-2 实施修正」14、「M3-B-3 实施修正」11、「M3-B-4 实施修正」14、「M3-B-5 实施修正」15 与「M3-B-6 实施修正」9。⚠️ **M4-A 只 +0.47KB、余量 7.54% → 7.39%**：配置层是纯逻辑（store + ipc 镜像 + 三个信号接线），⛔ 没加新懒加载边界、没加一行 CSS、managed state 也没涨（无状态，现读现合并），所以这一步几乎没动预算——详见 §3.6「M4-A 实施修正」9 |
| **首屏字体字节** | **< 2MB** | ✅ **1.039MB（余量 48%）** —— **M1-G 重测改判达标**。口径：从生产构建 `dist/index.html` 实际引用的三个 chunk 里取非 ASCII 码点集（296 个），比对分片 `unicode-range` 查表求和 → 文楷 GB **26 片 / 1.039MB**。加上正文频率前 500 字**一片都不用多拉**（常用字已在这 26 片内），前 1500 字才到 36 片 / 1.534MB。<br>⚠️ **这 296 个码点是 M1-G 当时那三个 chunk 里量出来的，M2-C / M2-D / M2-E 之后都没有重算**（那套查表脚本随 M0 脚手架一起删了）。此后新加的只有面板/确认单/浮层上的中文串，码点集**只会变大不会变小**，但增量落在已有分片里的概率很高——48% 的余量足够兜住，重算留给下次真要动字体分片时。<br>⚠️ **M0 原记的 ❌ 2.219MB 是口径错误**：那是 1 万行常用字混排**压测文档滚完后的稳态**（文楷 25 片 1.136MB + Maple 36 片 1.082MB），不是首屏。原判的根因「按码位区块切」与修法「按字频重排」**双双作废**，见 §3.3「M1-G 实施修正」 | 压测稳态 2.219MB；饱和上界（滚完 5 万行）2.603MB；中文表格/代码块多时 Maple 侧另加 0.9~2.1MB（D2 把 `Table` 划进代码区，见 M1-G 修正 4） |
| 按键到屏幕延迟 | **< 16ms** | 主线程事务派发 avg < 1ms（不含系统事件投递，仅作回归基线） | 不可感知 |

**M0 构建产物明细**（`pnpm build`，D7 字体按需注入 + D2 代码区分字体后；**2026-09-14 删除 M0 脚手架后复测**）：

| 文件 | min | gzip | 说明 |
|---|---|---|---|
| `index-*.js` | 302.83K | **110.23 KB** | 入口：Solid + 应用代码 + CM6 基础扩展 |
| `dist-*.js`（modulepreload） | 335.25K | **108.50 KB** | CM6 内核 |
| `index-*.css` | 2.29K | **0.85 KB** | 应用自身样式（字体声明已移出） |
| **首屏合计** | | **219.58 KB** | 预算 ≤300KB，余量 27% |
| `regular-*.js` | 155.91K | 55.36 KB | Maple Mono CN 的 CSS，**懒加载 chunk**，不进首屏 |
| `lxgwwenkaigbscreen-*.js` | 92.73K | 33.36 KB | 字体变体 GB，**懒加载 chunk**，选中才拉 |
| `lxgwwenkaiscreenr-*.js` | 92.83K | 33.36 KB | 字体变体 R，同上 |
| 117 个 chunk（含子语言） | | | 懒加载，**不进首屏** |
| 433 个 woff2 | | **18.1 MB** | 文楷 GB 97 片 / 4.33MB + 文楷 R 97 片 / 4.87MB + Maple 239 片 / ≈8.9MB（hash 命名） |
| `dist/` 总计 | | 26 MB | |
| `Vela.app` | | **23 MB** | 预算 ≤40MB。⚠️ 这是清理脚手架前那次 release 构建的读数；Rust 侧少了约 200 行探针，只会更小 |

> ✅ **M0 探针脚手架已整体删除，首屏 gzip 236.92 → 219.58 KB**（-17.34 KB，2026-09-14 复测）。当初被压进入口 chunk 的是两个静态 import：`src/probe/sweep.ts`(17.5KB) 与 `ProbePanel.tsx`(46.9KB)。比 D7 基线（218.5 KB）多出的 1.08 KB 是清理后 `App.tsx` 的工具栏与字体切换 UI，不是残留脚手架。**别把当初那 18.4 KB 记成 D2 分字体的代价**——Maple 的 CSS 是 `?inline` 动态 import，独立成 `regular-*.js`，首屏一个字节都没碰。
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
| **ropey 1.6.1** | **MIT**（已核实 registry 里 crate manifest 的 `license` 字段）。⚠️ **它不是 Vela 的依赖**——`Cargo.lock` 里没有它，M2-H 最终选了稀疏行索引，见 §2.1 与 §3.4「M2-H 实施修正」1 |
| CodeMirror 6 / Monaco / Solid / Vite / Kobalte / Ark UI / cmdk | MIT |
| Ace | BSD-3-Clause |
| `ignore` / `grep-*` | Unlicense OR MIT |
| **`memchr` 2.8.3** | **Unlicense OR MIT**（M2-H「大文件只读分片」提为直接依赖，用来数 `0x0A`；本来就在 `Cargo.lock` 里，是 `grep-searcher` 的传递依赖）|
| `notify` | CC0-1.0 |
| **`notify-debouncer-full` 0.6.0** | **MIT OR Apache-2.0**（M2-G「外部改动监听」引入；⚠️ 与 `notify` 不同 license，两个都已核实 crate manifest）|
| **trash 5.2.9** | **MIT**（已核实 crate manifest 的 `license` 字段；M2-B-5「移到废纸篓」引入）|
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
| 4 | **字体分片管线** | 首屏实际加载 **< 2MB**；随机生僻字能正确触发分片加载 | ✅ **机制 ✅ / 数值 ✅（M1-G 改判：真首屏 26 片 / 1.039MB，预算 2MB 余量 48%）**。下面是 M0 当时的原始读数与口径（2026-09-14 09:33 补齐），**保留不改，但注意它测的是压测文档的稳态、不是首屏**。<br>**新口径**：构建期 `scripts/font-manifest.mjs` 生成「family + 归一化 unicode-range → 真实字节数」清单（**433 片 / 18.07MB**），运行时用 `document.fonts` 里 `status=loaded` 的 face 查表求和。⛔ 原口径 `performance.getEntriesByType('resource')` 在 `tauri://` 下恒为 0 条 woff2，**原估 ≈1.40MB ±50% 作废**。<br>**实测**（release 构建、窗口 `visible`、dPR=1、wrap 开，全部样本 `trustworthy=true`：`rangeUnmatched=0`、`indexDisagreements=0`）：<br>· 字体刚注册、无字形需求：**0 / 336 片，0 MB**<br>· 空文档 + 界面中文：11~23 片文楷，**0.49~1.07 MB**（Maple **0 片**）<br>· **1 万行常用字混排（判预算用这份）：61 片 = 文楷 25 片 1.136MB + Maple 36 片 1.082MB → 2.219 MB**<br>· 同上 + 30 个跨区块生僻字（机制压力样本）：66 片 → **2.446 MB**（文楷 +5 片 / +227KB，生僻字确实一字一分片地拉）<br>· 滚完 5 万行全篇（饱和上界）：70 片 → **2.603 MB**<br>**机制侧成立**：0 → 按需增长 → 收敛。收敛靠**静置复测 + 去重**证明：每 3s 复测一次，相同样本不落盘，`+6s / +9s` 两次在日志里**没有产生新落盘**，那个缺失就是平台期证据。<br>**钱花在哪（关键：不是文档正文）**：① Maple 那 1.082MB 占首屏一半，来自 `CODE_BLOCK_NODES` 里的 `Table`——中文表格按设计走等宽字体（这是 #3 列对齐成立的前提），fixture 表格行全是中文，**预期行为不是 bug**；② 文楷 1.136MB 里界面自己的中文就占 11~23 片，文档正文只加了十几片；③ ~~结构性根因：**分片按码位区块切**~~ 🔴 **这条已被 M1-G 推翻**：清单里 `U+760F-76FB` 这类连续区间是**生僻字尾部**的装箱结果，不是整包的切法；上游 `cn-font-split` 按字频排序后再装箱，所以文楷 GB 的末片 `subset-118` 有 174/188 个码点被真实中文语料用到、而开头 10 片只有 0~2/138。**「命中即整片下载」这半句仍然成立**（每片 31~46KB），但它不是缺陷，正是 `unicode-range` 懒加载省字节的机制本身。<br>⚠️ **face 计数不单调**：重建编辑器后已加载 face 从 23 掉回 12（WebKit 释放不再被引用的字体数据），所以样本序列不能当增长曲线读，「空文档 + 界面」那行只能给区间。<br>⚠️ 附带发现 67.8KB gzip 的 `@font-face` CSS 开销 → R15，已由 D7 解决（首屏 CSS 67.8KB → 1.28KB）。<br>✅ **dPR 不影响本项**：分片命中只取决于出现哪些码点，与栅格化倍率无关 → #4 不需要 Retina 复测（#1 / #7 需要）。 | ✅ **口径已落地**（清单查表，绕开失效的 resource timing）。<br>🔴 **原写的「M1 修法：按字频重排分片」已被 M1-G 实测推翻并作废，原文见 git 历史。** 两个错处：① **根因不成立**——上游 `cn-font-split` 本来就按字频装箱，文楷 GB 末片 `subset-118` 的 188 个码点里 **174 个**被真实中文语料用到、`117` 166/188、`116` 139/188，而**开头** 10 片只有 0~2/138；常用字早就挤在一起，只是挤在编号**末尾**。② **修法方向是反的**——「3500 字集中到头 1~2 片」按实测密度 312 B/字形算是个 **~1.09MB 的巨型分片**，而典型一屏只用 300 字左右、今天只拉 **0.648MB（13 片）**；把片做大等于亲手扔掉 `unicode-range` 懒加载赖以省字节的「片内多数码点这一屏用不到」。<br>✅ **改判达标**：按「启动 + 空文档 + 界面文案」这个真首屏口径重测是 **26 片 / 1.039MB**，预算 2MB 余量 48%；上面那个 2.219MB 是**1 万行压测文档滚完后的稳态**，被错标成了首屏。<br>⛔ **RFN 核实结果（比本项更重要）**：上游 `OFL.txt` 确实声明 `Reserved Font Name '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW'`，而 OFL FAQ 明确「删字形即产生 Modified Version」、Modified Version 不得用 RFN。我们今天消费的 `lxgw-wenkai-screen-webfont` 本身就是第三方子集化的产物并以 `'LXGW WenKai Screen'` 分发，**这条张力与 #4 无关、现在就存在**；自己重切会把 Modified Version 的作者变成我们。Maple Mono CN 的 LICENSE **无 RFN 声明**，不受此限。详见 §3.3「M1-G 实施修正」5 |
| 5 | **生产构建** | `vite build` 后 CM6 **完全正常**（不是只在 dev 正常） | ✅ **通过，且这个验收项救了一次**。构建确实踩中三个坑（rolldown manualChunks 形式、esbuild 不再内置、粗分包摧毁懒加载），首屏 gzip 一度 623KB，修复后 **284.4KB / 114 chunk**。详见 §2.3 | 有已知「Tauri + Vite + CM6: Works in Dev, Breaks in Production Build」陷阱。排查分包、worker、动态 import 配置 |
| 6 | **冷启动** | 空窗口到可输入 **< 1s** | ✅ **通过：635ms**（预算 1000ms，余量 36%）。口径是端到端的 Rust 进程启动 → 编辑器可输入，由 `probe_ready` 命令返回 `PROCESS_START.elapsed()`，不是 `performance.now()`。<br>⚠️ 必须用进程时钟：`performance.now()` 的原点是**页面导航开始**，不含进程拉起与 WKWebView 创建，只用前端时钟会系统性低估冷启动，可能把不达标的读数读成达标。差值已单列在探针面板「进程拉起 + WKWebView 创建」一行 | 削减启动路径、延迟非关键扩展加载 |
| 7 | **空转内存** | **< 200MB** | ✅ **通过：空转均值 104MB，峰值 109MB，余量 46%**。13 个样本全部 `visibility=visible` 且 `hasFocus=false`（在渲染、无人操作），其中 5 个是间隔 15s 的干净空转点：合计 97 / 104 / 109 / 104 / 106 MB；拆分 vela 21~22（全程不动）｜GPU 17~24｜WebContent 54~61｜Networking 5。冷启动 17s 的首个点 114MB 也在预算内。<br>⚠️ 口径必须用 `phys_footprint`（`footprint -p`，即活动监视器「内存」列），**不能用 `ps` 的 RSS 求和**——vela 与 3 个 WebKit XPC 进程共享 WebKit.framework/AppKit 页，RSS 会重复计数（实测主进程 RSS 87MB 而 footprint 仅 24MB，差 3.6 倍）。<br>⛔ 早先单点读到的 209MB 是**启动初期瞬态，干净一轮里没有复现**，不能作为判定依据。<br>⚠️ 未闭合：本轮 `devicePixelRatio = 1`，图形背板成本随 dPR 平方增长，**Retina 屏上可见态开销会被低估**，正式判定要在 dPR=2 下复测。<br>⛔ `performance.memory` 在 WKWebView 恒为 undefined，前端侧的 JS 堆读数不可用。<br>📌 **新发现（转 M1）**：灌过 1 万行文档后即使回落到空文档，WebContent 停在 113MB、比空转基线高 **~59MB 且不回落**（同期 Rust RSS 反而从 146MB 降到 63MB）。性质是 WebKit 侧的驻留字形/图层缓存，不是 CM6 泄漏；但「反复开关大文件是否阶梯式上涨」「内存压力下是否被回收」未验证 → M1 需补一条长会话内存曲线。<br>📌 **字体归因已结案（数值已按 #4 的实测字节口径修正）**：早先记的「30/97 → 33/97，估算 ≈140KB」是 face 计数 × 平均体积的粗估，已被 #4 的清单查表口径取代。真实差值是：空文档 + 界面中文 **11~23 片 / 0.49~1.07MB** → 1 万行常用字混排 **61 片 / 2.219MB**，即文档本身多拉 **~1.2~1.7MB** 字体数据。这个量级**解释不了 ~59MB 的不回落驻留**，所以「字体分片管线不是内存问题的主因」结论不变（mixed 与 ascii 的内存差也确实落在 ±16MB 噪声带内、方向还会反转）。<br>⚠️ **诚实标注**：woff2 字节 ≠ 解码后的字形位图占用，后者会放大若干倍且未单独验证；但即便放大 10 倍也只到 ~17MB，仍不足以解释 59MB，量级判断成立。此路不必再查。 | 参照 Tauri 基准 ~172MB（**该基准的度量口径不明，不能直接对齐**）。若 dPR=2 复测超标：削减常驻 face 数、把图形背板交给原生滚动容器、或收紧 200MB 预算的适用口径 |
| 8 | **字体字重核实** | 确认 Screen 版实际提供几档字重（两次抓取结论冲突） | ✅ **已结项：只有 `font-weight: 400`，无 Bold**。97 个 face 全部 400 → 转为 R16 | 粗体需浏览器合成（faux bold）或改用主系列 LXGW WenKai |

**产出**：✅ 已交付 **[`M0-REPORT.md`](M0-REPORT.md)**，逐项记录实测数据与结论。
**结论：🟢 继续按 Tauri 2 路线走，M0 闸门通过、无阻塞项 —— M1 可以开工** —— **八项全部通过**（#1 #2 #3 #5 #6 #7 #8 于 M0 通过；#4 机制当时即 ✅，数值原判「❌ 首屏 2.219MB 超预算 11%」**已由 M1-G 重测改判为 ✅ 1.039MB**，原读数是压测文档稳态误标为首屏）。**不存在可能推翻 Tauri 路线的未知。** 上表的「当前状态」列与本节是同一批数据的就地批注版，**引用结论时以报告为准**（#4 的最终判定以 §3.3「M1-G 实施修正」为准）。
> 📌 **#2 于 2026-09-14 由用户人工判定通过**，它是八项里唯一结构性不可自动化的一项，也是原先唯一阻塞 M1 的项 → 条件已解除。
> 📌 **#4 已由 M1-G 就地结案，改判「✅ 达标」**：原写的根因「按码点区块切分让一屏字符散落到 25~36 片」**经实测推翻**——上游 `cn-font-split` 本来就按字频装箱，文楷 GB 末片 `subset-118` 的 188 个码点里有 174 个被真实中文语料用到，而开头 10 片只有 0~2 个。修法「按字频重排」随之作废（把常用字集中成大分片反而更贵）。2.219MB 是压测文档的**稳态**，首屏实测 **1.039MB / 预算 2MB**。详见 §3.3「M1-G 实施修正」。
> ⚠️ **另有一个不属于验收项的独立阻塞**：`open` / LaunchServices 启动路径卡死。不阻塞 M1 开发（内层二进制可正常启动），**但阻塞正式分发**——Finder / Dock 双击才是用户的真实路径，需用户决定是否上真 Developer ID 签名 + 公证。详见 M0-REPORT §5「启动」行。
> ✅ **#1 的主观半于 2026-09-14 21:54 由用户人工判定通过**（5 万行文档、触控板连续滚动、「没有卡顿，挺流畅」），**M0 至此没有任何未知**。原计划「唯一会推翻 Tauri 路线的情形」= 人工判定手感不可接受 **且** Safari 对照组复现顺滑差异；前半条已被否定 → **该情形正式排除，Safari 对照组不必做**，`macOSPrivateApi` / 原生滚动容器 / 重估路线都不需要。
> 📌 **这条判定是在 `load 3.49 / 3.03 / 2.98` 下做出的，按不对称证据规则是更强的证据**（负载高时手感好 = 更严苛条件下达标，是个下界；负载高时手感差才不能归因于 Tauri）。⚠️ 但它也是 **M0 唯一没有数据产物的验收项**：人工判定不落盘、单次、无埋点核实实际滚动量，证据强度低于同节的量化项。

#### 脚手架现状（工具链四条腿）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ EXIT=0（修掉 5 个错误后） |
| `cargo check` | ✅ EXIT=0，173 个 rlib 依赖 |
| `pnpm build` | ✅ EXIT=0，671ms，首屏 gzip 演进：284.4KB → D7 字体注入 + M0 探针 236.92KB → **脚手架删除后 219.58KB**（当前明细见 §2.9） |
| `pnpm app:dev` | ✅ 27.21s 编译完成，窗口已启动 |
| `pnpm tauri build` | ✅ EXIT=0，产出 `src-tauri/target/release/bundle/macos/Vela.app`（可执行体 14.6MB），M0 的实测数据全部取自这个打包产物 |

> ⚠️ **这张表是 M0 时期的快照，不是当前的完整门禁清单。** 标题里的「四条腿」在当时就已经数错了（表里是五行），而 M1-H 之后工具链又长出三条：`pnpm lint`（ESLint 10 + typescript-eslint + eslint-plugin-solid）、`pnpm format:check`（Prettier）、以及 `cargo fmt --check` / `cargo clippy -- -D warnings`，全部由 `.github/workflows/ci.yml` 的 `web` 与 `rust` 两个 job 守着。当前门禁以 CI 工作流为准，实施细节见 §3.3「M1-H 实施修正」。

**踩坑记录**：`bundle.icon: []` **不能**绕过图标要求——`tauri::generate_context!()` 在编译期无条件打开 `src-tauri/icons/icon.png`，缺失会让 proc macro panic。已用 `scripts/gen-icon.mjs`（纯 node+zlib 手写 PNG，512×512 船帆座图形，5.4KB）解决，避免为一个占位图标引入图像库依赖。
> 后续：`pnpm tauri icon` 会生成 **52 个**文件（含 android/ios/Windows 磁贴），macOS 只需要 5 个（icns + 三张 png + icon.png），已裁剪。`bundle.active` 也由此改为 `true`。

**剩余工作**（截至 2026-09-14，**八项验收全部通过**：#1 #2 #3 #5 #6 #7 #8 于 M0 通过，#4 由 M1-G 重测改判达标并结案。下面只剩非阻塞的补测）：
- ✅ **#2 中文 IME 已由用户人工判定通过**（2026-09-14）。它是八项里**唯一结构性不可自动化**的一项——程序化插入文本会绕过 `compositionstart/update/end`（而那正是被测路径），合成键盘事件也驱动不了 IME 候选窗。未覆盖面（只验一种输入法、dPR=1）转 M1 的「CM6 封装层」工作项。
- ✅ **#1 已由用户人工判定通过**（2026-09-14 21:54，5 万行 + 触控板 + load 3.49）。**边界认知保留**：#1 只有一半可自动化——合成滚动 + 帧计时能给回归基线，但绕开了触控板惯性经原生手势的那一段，答不了「手感」，那一半只能人滚。**剩下的两项补测都不阻塞、也都不是决策输入**：安静机器（`load < 1`）复跑只作为 M1 的帧率回归基线；dPR=2（Retina）复测在正式发布前做。
- **#3 纯字体度量，已完全自动化**并三轮独立复现通过（含 2026-09-14 09:34 的 `visible` 复测），不再需要人眼判定。
- **#4 已测完并由 M1-G 改判为「机制 ✅ / 数值 ✅ 达标」**：首屏实测 **1.039MB** vs 2MB 预算（余量 48%）。M0 原判的 ❌ 2.219MB 是**1 万行压测文档滚完后的稳态**被错标成首屏，根因「按码位区块切」与修法「按字频重排」**双双作废**；**dPR 不影响本项，无需 Retina 复测**。详见上表 #4 行、M0-REPORT §2 与 §3.3「M1-G 实施修正」。

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
| 项目脚手架 | 1 | Tauri 2.11.5 + Solid + Vite + TS 严格模式；`vela-core` crate 骨架；ESLint/Prettier/rustfmt/clippy；CI（build + test）。✅ **全项交付**——lint/format/CI 这半截由 M1-H 补齐（含 `noUncheckedIndexedAccess` 这个连带发现），实施细节与教训见 §3.3「M1-H 实施修正」，工作流见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| **命令注册中心** | 1.5 | **架构地基，必须 M1 就立起来**。含 `when` 上下文求值、快捷键绑定与冲突解析、命令面板数据源 |
| CM6 封装层 | 2 | EditorView 生命周期管理、扩展组合、与 Solid 的边界隔离（**关键：别让 Solid 碰 CM6 的 DOM**）、多实例（分屏）管理、`destroy()` 防泄漏；**多输入法验证**——M0 #2 只在一种输入法、dPR=1 下人工判定通过，这里要在系统拼音 + 一款第三方输入法（自己绘候选窗的那类）上各过一遍，并在 dPR=2 下复测候选框定位 |
| 多光标全套 | 1.5 | `Cmd+D`、`Cmd+Shift+L`、`Alt+Click`、列块选择、多光标下的查找替换 |
| 文件 IO | 1.5 | 打开/保存/另存为、编码探测（UTF-8/GBK/BOM）、LF/CRLF、原子写入、脏标记、外部改动检测 |
| 查找替换 | 1 | 正则、整词、保留大小写替换、查找选中词 |
| 编辑基本功 | 1 | 括号匹配、自动缩进、缩进引导线、代码折叠、行操作、排序去重 |
| 词补全 | 0.5 | 当前文档 + 项目词典（M1 没有项目概念，「项目词典」落地成**所有打开的标签**，见下面 M1-E 修正 35） |
| 标签页 + 分屏 | 1.5 | 多标签、拖拽重排、水平/垂直分屏、聚焦切换 |
| 会话恢复 | 1 | 标签、光标、滚动位置、未保存草稿持久化（**原写 rusqlite/sled，落地改成 `app_data_dir()` 下的单个 JSON 文件**，取舍与重估点见 §3.3「M1-F 实施修正」1） |
| 语言高亮 | 0.5 | `@codemirror/language-data` 接入，子语言懒加载 |
| 状态栏 + 基础 UI | 0.5 | 行列、编码、换行符、语言、缩进、字数 |
| ~~**字体分片按字频重排**~~ | ~~0.5~~ → **0** | ⛔ **核实后不实施：前提是错的。** 两个字体包的分片**本来就是按字频排的**（只是密度高的排在编号**末尾**），提议的「把常用 3500 字集中到头 1~2 片」会让典型一屏从 0.65MB **涨到** 1.09MB。实测启动即空文档只拉 **1.039MB**，本来就在 2MB 预算内；2.219MB 是 1 万行合成压测文档的**稳态**，被错标成了首屏。完整证据、重测数字与 RFN 核实结果见 §3.3「M1-G 实施修正」 |

**验收**：能用它替代 Sublime 完成「改配置文件、看日志、快速搜索替换」的日常闭环。冷启动 < 1s，空转内存 < 200MB，**首屏字体字节 < 2MB** —— ✅ 实测 **1.039MB**。⚠️ **「首屏」的口径必须写死为「启动 + 空文档 + 界面文案所触发的分片」**（清单查表，不是 resource timing）；压测文档滚完后的稳态另计（2.219MB），**不得冒充首屏**，M0 就是这么把 #4 判错的，见 §3.3「M1-G 实施修正」3。

> **M1-C 实施修正**（编辑基本功 / 多光标 / 查找替换落地时与本节及 §2 功能清单的偏离）：
>
> 1. **列块选择改绑 `Option+Shift+拖拽`，`Option+Click` 让给「添加光标」。** §2 的功能清单把这两项并列却没写修饰键，而 CM6 的 `rectangularSelection` 默认触发条件**就是** `Option+拖拽`，两者直接抢键。取舍：加光标的频率远高于列块，所以列块多按一个 Shift。
>    连带两个坑记在 `src/editor/multiCursor.ts`：`EditorView.clickAddsSelectionRange` 这个 facet **一注册就完全接管**（不与平台默认合并），所以 macOS 的 `Cmd+Click` 加光标是在那里自己重写一遍的；`crosshairCursor()` 只认单个修饰键，会在「单纯加光标」时也显示十字（错误提示），换成了自研的 `ColumnSelectHint` 插件。
> 2. **`Cmd+Shift+L` 用的是自研 `selectAllOccurrences`，不是 CM6 的 `selectSelectionMatches`。** 后者在已有多个选区时**直接返回 false**，于是「`Cmd+D` 按几下再 `Cmd+Shift+L`」是条死路。自研版先把选区收敛到第一处再重试，且**只在所有选区文本完全相同时**才这么做——否则等于悄悄丢掉用户已有的光标。
> 3. **「保留大小写替换」只支持普通字符串查询，正则模式下复选框是禁用的**（不是假装能用）。CM6 的 `RegExpQuery.getReplacement` 要展开 `$1` / `$&`，依赖匹配结果上的捕获组，而公开 API 的 `getCursor` 只给 `{from, to}`；自己重跑一遍正则去凑捕获组，会在锚点、环视与跨行正则上与 CM6 的结果分叉。
> 4. **查找面板是自建的**，走 `search({ createPanel })` 这个官方扩展点，不是 DOM hack。理由：CM6 的面板没有「保留大小写」的位置，而一个看不见的开关等于没有。结构刻意照抄 CM6 的 `SearchPanel`（`.cm-search` / `.cm-textfield` / `[main-field]` / 六个 `button[name=…]`），于是 `search()` 自带的 `baseTheme` 直接适用，只多出一个复选框。
> 5. **`Cmd+G` 归「查找下一个」，§3.4 里 Goto Anything 的跳行改用 `Cmd+Alt+G`**（CM6 `searchKeymap` 本来就绑在那里）。Vela 的手感对标 Sublime，而 Sublime 的 `Cmd+G` 是查找下一个；跳行让位。
> 6. **补了一个 bug：`search()` 之前压根没挂。** 扩展集里只有 `searchKeymap` 而没有 `search()`，`searchState` 字段不存在，`getSearchQuery` 会直接抛异常——也就是说查找替换在 M1-C 之前是坏的，只是没有任何入口能触发到它。
>
> 刻意**不做**的：不注册绑 `Escape` 的命令（`closeSearchPanel` / `simplifySelection`），因为全局捕获监听看不到 CM6 的 scope，注册上去会在查找面板打开时把「关闭面板」吞掉；面板上不做匹配计数（CM6 原面板也没有，且那意味着每敲一个字符就全文扫一遍）。

> **M1-D 实施修正**（标签页 / 关闭确认 / 分屏落地时与本节及 §2 功能清单的偏离）：
>
> 1. **架构改成「一个标签一份 `EditorState`，一个分屏一个 `EditorView`」。** 切换标签是 `view.setState(tab.state)`，不是重建编辑器。`updateListener` 被**烘进 state**（`editor/setup.ts` 的 `createEditorState`），于是切完之后收到更新通知的天然就是新标签自己那个监听器，路由不需要任何判断。滚动位置不属于 state，单独存在 `EditorSnapshot` 里，且必须在 `setState` **之后**赋值——setState 会重建整个 docView，先赋的值会被新布局冲掉。
> 2. **换行偏好是全局视图设置，不是每标签一个。** CM6 的 `Compartment` 按**实例**寻址，共享同一个实例就能用一次 `reconfigure` 同时作用于「正在显示的 view」与「存着的所有 state」，工具栏那个开关因此不可能与屏幕上的状态不一致。显示中的走 `view.dispatch`，其余走 `state.update`——前者用 `setState` 会销毁视图插件、丢焦点与滚动位置。分屏之后「显示中的」是**每一块**分屏的 view，循环 dispatch。`markdownMode` 眼下也是全局的，M1-E 做「按扩展名分语言」时要挪到 Tab 上（**已兑现**，见下面 M1-E 修正 1）。
> 3. **`Cmd+N` 的语义从「新建文档」变成「新建标签」**，`DocumentModel` 上的 `newDocument` 与 `openViaDialog` 两个方法被删掉了：它们都要先回答「落到哪个标签上」，那是 workspace 的知识，文档模型只剩 `openAt(path)`。
> 4. **打开文件的路由规则**：同一路径只开一个标签（再开一次会丢掉已有改动，还让用户在两份内容里猜哪份是真的）；当前标签是**干净的无名标签**时就地复用，否则新开一个。「当前标签」= **聚焦分屏**显示的那个。打开**失败**时错误落在新开的空标签上，原来的草稿一动不动——这是行为变更，`App.test.tsx` 里那条用例已按新契约重写。
> 5. **`tabs()` 与 `panes()` 永远非空**：关掉最后一个标签时补一个空的进来。允许「零」的话所有 `editor.*` 命令的 `when` 会同时失效、状态栏没有可显示的对象、`activeTab()` 变成 nullable 并传染给每一个调用点。
> 6. **关闭确认用自建模态，不是原生对话框**——M1-B 遗留项「capabilities 必须补 `dialog:allow-confirm`」因此**作废，capabilities 无需任何改动**。理由：`plugin-dialog` 只有 `message`/`ask`/`confirm`，全是**两个**按钮，而这里必须有三条出路（保存 / 不保存 / 取消）；少掉「取消」，Esc（rfd 上映射到 cancel 那一支）就成了「直接扔掉改动」。副产物是这个对话框能在 jsdom 里测，原生对话框只能 mock 掉、分支覆盖全是假的。默认焦点落在「保存」上：什么都不看直接按回车不该是丢数据。
> 7. **关窗拦截有两个入口，只拦 `CloseRequested` 在 macOS 上等于没拦。** 点红绿灯走 `CloseRequested`，而 `Cmd+Q` 与菜单里的「退出 Vela」走 `ExitRequested`，压根不经过窗口。两者一律 prevent + 发事件，决定权整个交给前端；前端答「可以关」之后调 `close_window`（Rust 侧是 `Window::destroy()`，不是 `close()`——后者会再触发一次 `CloseRequested`，死循环）。`ExitRequested { code: None }` 必须放行，那是我们自己 destroy 窗口引发的正常退场。事件名两边手写各一份，靠 `lib.rs` 与 `windowClose.test.ts` 的两个契约快照钉住（与 `wire_contract.rs` 同一套路数）。
> 8. **`promptDiscard` 由宿主注入，缺省答「取消」。** 这个缺省看着反常（没接 UI 就关不掉标签），但另一头是静默丢数据；宁可什么都别关。注入而不是直接调对话框，是为了让「保存 / 不保存 / 取消」三条分支真的可测。
> 9. **首屏 gzip 227.10 → 231.60 KB**（`index-*.js` 121.86 + `dist-*.js` 108.31 + `index-*.css` 1.43），预算 300 KB，余量 22.8%。M1-D 的标签条、workspace、模态对话框与分屏合计 +4.50 KB。
> 10. **分屏模型是扁平的**：`panes: Pane[]` + 一个全局 `direction` + `focusedPaneId`，上限 `MAX_PANES = 4`。刻意不做 VS Code 那种嵌套分组（左右各再上下分）——那要求一棵布局树、每个节点各自的方向与比例，而轻量编辑器里真正高频的只有「左右并排看两个文件」与「上下对照」，扁平模型下这两个都是一次点击。§2 功能清单里的「水平/垂直分屏」按这个口径算完成。
> 11. **一个标签同时只显示在一个分屏里**（可以有标签谁都不显示，比如它的分屏被合并掉了）。允许两块分屏显示同一个标签的话，`Tab.snapshot` 就不再是「没显示时的唯一真相」，撤销历史与滚动位置会分叉成两份。两条连带后果：`split` 给新分屏装的是**新空标签**而不是当前标签的副本；`closeTab` 挑「右邻居」时必须跳过正被别的分屏显示着的标签，一个都挑不出来就补一个空标签——这条是分屏落地时才暴露的，`dropTab` 已重写并有专门用例钉住。
> 12. **⛔ 「合并分屏」不绑 `Mod+W`**：macOS 的原生菜单快捷键等价物在事件到达 webview 之前就被系统吃掉了，绑在注册表里根本收不到按键。入口只有工具栏的「合并」按钮与命令面板（与 `foldAll` / `unfoldAll` 同一条理由）。分屏的其余四条绑 `Mod+\`（右分屏）、`Mod+Shift+\`（下分屏）、`Mod+Alt+←/→`（切焦点），沿用 VS Code 约定。
> 13. **焦点与拆卸都由 `EditorPane` 自己上报**，App 不再持有单个 controller：`onFocusIn`（focusin 会冒泡，容器收得到 `.cm-content` 的聚焦）→ `ws.focusPane(paneId)`，`onCleanup` 里的 `onDestroy` → `ws.detach(paneId)`。**onDestroy 必须在 `controller.destroy()` 之前调用**——workspace 要趁 view 还活着 capture 现场，顺序反了合并分屏就会把没存盘的正文一起扔掉（`EditorPane.test.tsx` 有专门用例）。`AppContext.editor` 相应变成 `ws.focusedEditor()`。
>
> **待人工验**（启动真实 app 被拦，自动化到不了）：标签条的观感与拖拽重排手感、模态对话框的视觉、**分屏的观感**（1px 分隔线、聚焦块的 accent 描边、`.tab.shown` 的顶部灰条是否够明显）、以及**真的点一次红绿灯与 Cmd+Q** 确认关窗握手在 Tauri 运行时里通。

> **M1-E 实施修正**（语言高亮与状态栏落地时与本节及 §2 功能清单的偏离。**覆盖 M1-E-1「语言按扩展名分派」、M1-E-2「状态栏：只读显示 + 编码/换行符切换」与 M1-E-3「词补全」**）：
>
> 1. **`markdownMode` 这个全局选项被删掉了，语言变成 Tab 的属性**——兑现 M1-D 修正 2 末尾那句「M1-E 时要挪到 Tab 上」。`Compartment` 按**实例**寻址，所以这里的做法与 `lineWrapSlot` **正好相反**：换行槽位全局共享一个实例（一次 `reconfigure` 拨动所有标签），语言槽位每标签一个实例（改一个标签的语言不该波及别的）。
> 2. **顺带修掉一个一直存在的 bug：M1-E 之前所有文件都被当成 Markdown 解析。** `markdownMode` 默认开且全局，于是 `.json` / `.ts` / `.log` 一律拿 Markdown 的语法树与正文字体。现在 `.log` 这类没匹配上的扩展名**不挂任何语言**（`state.facet(language)` 为 null）。
> 3. **没匹配上的扩展名给等宽字体，不给正文字体。** 取舍：等宽对日志与表格的列对齐是刚需，正文字体对纯散文只是好看；两边只能保一个时保对齐。
> 4. **语言只有一条安装路径**：`buildState` 刻意**不传** `language`（槽位建出来是空的），一律由 workspace 的 `syncLanguage` 装。理由是子语言靠动态 import 懒加载，建 state 那一刻拿不到 `LanguageSupport`；只留一条路径，加载回来时就不必判断「这个 state 是哪条路建的」。
> 5. **`syncLanguage` 必须在 `restore(snapshot)` 之后调用**（`workspace.ts` 的 `host.setText`）。显示中的标签走 `view.dispatch`，而 dispatch **不回写** `snapshot`；先装语言再 restore，restore 用的还是那个没装语言的 snapshot，语言会被整个冲掉——静默，不报错。
> 6. **新增宿主钩子 `pathChanged`**：路径是语言的唯一依据，而语言槽位归 workspace 管，所以 `document.ts` 每次 `setPath` 之后都得说一声（打开文件、另存为两处）。这一层刻意**不自己算语言**：它连 CM6 都不该知道。
> 7. **异步竞态用 `tab.languageToken`**：代号先自增再发请求，加载回来时对不上就丢掉结果。不丢的话「快速连开两个文件」会让前一个文件的语法树盖到后一个上，同样静默。连带的坑：`replaceTabText` 之后必须把 `tab.language` 归零，否则 `syncLanguage` 认为「语言没变」直接跳过，打开文件后既没有高亮也没有字体分区。
> 8. **`Makefile` 落到纯文本是上游行为，不是 bug**：`language-data` 的 filename 模式清单里压根没有 Makefile（有 `Dockerfile` / `CMakeLists.txt` / `Jenkinsfile` / `Gemfile` / `Rakefile` / `PKGBUILD` / `BUCK` / `BUILD` / `nginx*.conf` / `extensions.conf`）。另一个坑：`LanguageDescription.matchFilename` 要的是**文件名**，喂全路径会让锚定的模式（`/^Dockerfile$/`）失配。两条都写进 `language.test.ts` 钉住了，别再当 bug 重开。
> 9. **无名文档 → Markdown**，保持 M1-E 之前 `markdownMode = true` 的行为，不因为「没路径」就退化成纯文本。
> 10. **⛔ `manualChunks` 仍然一条都不能加。** 本次构建 117 个 chunk，而 `index.html` 只引三个（入口 + CM6 内核 + 应用 CSS），语言包全部按需。一旦手动分包，`legacy-modes` 那几十种语言会全部塌进首屏——`vite.config.ts` 里的注释就是为这一刻写的。
> 11. **首屏 gzip 231.60 → 232.35 KB**（`index-*.js` 122.61 + `dist-*.js` 108.31 + `index-*.css` 1.43），预算 300 KB，余量 22.6%。**接进 30+ 种语言只涨 0.75 KB**：涨的是 language-data 的描述表，语法本体一个字节都没进首屏。
> 12. **测试口径变了一处**：`workspace.test.ts` 文件头原本写「假的只有 IPC 与原生对话框」，现在多了一个——**子语言懒加载的时机闸门**（默认关着走真 import，只有「晚到的结果被丢弃」那条用例闸住）。不闸住的话晚到与否由 import 决定，那条用例就是掷硬币，过与不过都说明不了什么。
> 13. **度量从两个数扩成七个字段**（`DocMetrics`：`lines` / `chars` / `line` / `col` / `selections` / `selectedChars` / `indent`），统一由 workspace 的 `syncMetrics` 算。**列数按字符数报，不按字素报**：CM6 的位置就是 UTF-16 code unit 偏移，一个 emoji 会显示成 2 列。要按字素报得自己切分，不值这个成本。
> 14. **`metrics()` 的口径是「聚焦分屏里那个标签」**，与命令的口径一致。显示中的标签读 `view.state`，没显示的读 `snapshot.state`——沿用 M1-D 那条「snapshot 是没显示时的唯一真相」。
> 15. **缩进报的是 state 上的 `indentUnit` facet，不是常量。** `INDENT_UNIT` 导出成常量只为给 `indentLabel` 一个默认值，取值一律走 facet。缩进菜单最终没做（第 29 条），但**将来要做时这条自动生效**，不必回头改状态栏。
> 16. **语言那一格读 `languageFor(doc().path())`，不读 `tab.language`**：后者是普通字段不是 signal，另存为换了扩展名也不会重渲染，状态栏会一直报旧语言。代价是「模型自己算的那份」与「显示的那份」成了两个来源，但两边调的是同一个 `languageFor`，分叉不了。
> 17. **编码 / 换行符 / 缩进三格在 M1-E-2a 是 `<span>`**，M1-E-2b 把前两格换成了原生 `<select>`（第 21 条起）。当时留的那个问题——「改了编码算不算未保存的改动」——答案是**算**：`format` 变了不标脏，关窗时这个决定会被静默扔掉，用户拿到的还是旧编码的文件。**缩进那一格刻意没做**，理由见第 29 条。
> 18. **工具栏右侧那两个 badge 删掉了**（文件名 + 行数字符数），信息全数搬进状态栏，一处不重复。`.app` 的 grid 因此从 4 行变 5 行。
> 19. **首屏 gzip 232.35 → 232.84 KB**（`index-*.js` 122.61→123.04、`index-*.css` 1.43→1.49），预算 300 KB，余量 22.4%。chunk 仍 117 个，`index.html` 仍只引三个。
> 20. **测试口径再加两处**：状态栏的**格子按 `title` 精确查**（中间几格是条件渲染的，下标不稳），于是 **tooltip 文案成了契约**——改文案就得改测试，这是故意的，那几行字就是给用户看的说明。另外 16 处既有的度量断言从 `toEqual` 改成 `toMatchObject`：`DocMetrics` 每加一个字段，`toEqual` 都要改十几处，改的人只会照抄实际值，断言就退化成快照了。
>
> **M1-E-2b（编码 / 换行符切换，含「以另一种编码重新解码」）：**
>
> 21. **编码那一格是「一个下拉里两组」，不是两个入口。**「以…保存」7 项（改写盘格式）+「以…重新打开」4 项（换一种读法把同一份字节再读一遍）。这是**两个不同的操作**，但是同一个决定，所以放一处。用原生 `<select>` + `<optgroup>` 而不是自绘弹层：不用写 click-outside、不用管焦点、不多一个组件——「不加交互复杂度」比「好看」优先。
> 22. **GBK 只有不带 BOM 的那一项**（7 项而不是 8 项）。Rust 侧 `Encoding::supports_bom` 排除了 `gbk + bom`，`encode` 还会直接忽略它；UI 不提供不可能的组合，比提供了再在下游兜住要便宜。`StatusBar.test.tsx` 里显式断言了 `'GBK BOM'` **不在**选项里。
> 23. **`<select>` 的 value 只能是一个字符串，而编码是「encoding + bom」两个字段**，于是压成 `utf16_le-bom` 这种 id，`encodingChoiceId` / `parseEncodingChoice` 一对互逆函数管这件事，两侧都有测试（穷举 7 个组合来回压一遍）。
> 24. **改格式算脏**（兑现第 17 条）：`changeFormat` 只动 `format` 不动正文，但必须 `setDirty(true)`。换行符同理，而且它是**写盘时**才生效的——正文在内存里始终是 LF，所以改 EOL 之后 `getText()` 里一个 `\r` 都不该有，这条也有测试钉住。
> 25. **「以…重新打开」在有未保存改动时拒绝执行，只给一条提示，不弹模态框。** 不复用 `promptDiscard`：那个对话框的语义是「这个文档还要不要」，而这里用户想要的恰恰是**留住文档**、只换一种读法，弹它等于问错问题。无名文档（没有路径）上它是个 no-op。
> 26. **`open_file` 因此多了一个参数 `encoding: Option<Encoding>`**，前端**恒传**这个 key（不覆写时传 `null`）。理由是一个静默的数据完整性洞：探测顺序是 BOM → 是合法 UTF-8 就判 utf8 → 否则 GBK，于是**一份 GBK 文件只要字节恰好是合法 UTF-8，就会被解成 UTF-8 且 `lossy = false`**——正文看起来完全正常，UI 里没有任何东西能警告用户。`C4 A3` 这组字节就是实例：UTF-8 读出来是 "ģ"，GBK 读出来是 "模"。没有覆写参数，用户就没有任何办法把它读对。
>     - 刻意**不省略**这个 key：Tauri 对「参数缺失」与「参数为 null」的处理并不显然一致，而 `Option<Encoding>` 反序列化 `null` 恒为 `None`，传 null 就不用去赌前一种。两侧都用 golden 测试钉住了（`fs.test.ts` 与 `wire_contract.rs`），拼错的枚举值必须**报错**而不是静默当成 `None`。
> 27. **⚠️ `encoding_rs` 的 `decode()` 会先做 BOM sniffing。** `GBK.decode()` 遇到开头的 `EF BB BF` 会自动改用 UTF-8 解码，并把「实际用的编码」放进返回值的第二项——而那一项我们本来就没读（写成 `_`）。于是显式指定编码在带 BOM 的文件上会**静默失效**：测试现象是 `left: "正文" right: "正文"`，两边一模一样、`lossy` 还是 false，看起来像断言写错了。修法是 `decode_as` 走 **`decode_without_bom_handling`**，BOM 的剥离由调用方负责，且**只剥属于该编码的那一种**（GBK 的 `bom()` 是空切片，而 `strip_prefix(&[])` 恒成功——不先判空就会让 `bom = true` 凭空成立）。探测路径撞不到这个坑，因为它总是先自己把 BOM 剥掉。
> 28. **显式指定编码时，目录拒绝与 4MB 上限照样生效**——漏掉的话「以某编码重新打开」就成了绕过上限的后门。
> 29. **缩进那一格刻意没做成菜单**（推翻第 17 条里的计划）。要支持它得给 `indentUnit` 开一个**每标签**的 Compartment（与语言槽位同一条理由），再从 `EditorSetupOptions` → `tab.ts` → `workspace.ts` 一路串下来；而「在轻量编辑器里从状态栏改缩进」本身不是刚需。第 15 条那个「取值一律走 facet」的决定仍然成立，将来要做不用回头改状态栏。
> 30. **状态栏的 `<select>` 必须把全局 select 样式抹平**：全局那条规则（边框 + 底色 + 3px 内边距）是给工具栏那种 28px 高的控件写的，塞进 22px 的条里会把整条撑高——而状态栏一跳高，靠 `1fr` 算出来的正文区就跟着跳一次布局。
> 31. **「重新打开」拨完必须手动把下拉复位。** 它是一次性动作不是一个状态，而在**拒绝执行**（有未保存改动）或失败时都不会改 `format()`，于是没有任何重渲染会把 `<select>` 拨回去——不复位的话它会一直显示「以 GBK 重新打开」，看起来像是已经生效了。
> 32. **首屏 gzip 232.84 → 233.66 KB**（`index-*.js` 123.04→123.80、`index-*.css` 1.49→1.55），预算 300 KB，余量 **22.1%**。chunk 仍 **117** 个，`index.html` 仍只引三个。Rust 侧 53 lib + 6 wire-contract、前端 **386** 个用例全绿。
> 33. **测试口径再加两处**：① **整体替换模块的 mock（`vi.mock('./ipc/fs', () => ipc)`）在模块长出新的常量导出时会把整份文件一起挂**，而且报出来的错是 `dispose is not a function`——真凶是 render 里对 `undefined` 调 `.map`，栈里根本看不到。改成 `importOriginal` 展开 + 只覆写要假的那几个函数（标签表本来也该是真的：那正是要显示给用户看的东西，mock 掉等于自己给自己判卷）。② jsdom 里驱动 `<select>` 要先设 `.value` 再 `dispatchEvent(new Event('change', {bubbles:true}))`；读显示值必须读 `selectedOptions[0].textContent`，整个元素的 `textContent` 会把所有 option 的文字拼成「UTF-8UTF-8 BOMUTF-16 LE…」。
>
> **M1-E-3（词补全）：**
>
> 34. **词补全在这一版之前是「装了但没有」**：`autocompletion()` 一直挂在扩展集里，但**一个词源都没有**——`completeAnyWord` 不是默认装的，接的那些语言包也都不带词源。于是打字从来不弹补全，而控制台干干净净。与第 2 条（所有文件都被当成 Markdown）同一类：**没有入口能触发到的坏功能不会自己报错**。
> 35. **§2 那句「项目词典」在 M1 落地成「所有打开的标签」。** M1 没有项目概念（文件树与工作区根目录是 M2 的事），要扫磁盘就得先让 Rust 去遍历目录。注入点是 `wordPeers` 这个 facet，由 workspace 的 `liveStates` 供给，**口径与 `syncMetrics` / `host.getText` 是同一条**（显示中读 `view.state`，没显示读 `snapshot.state`）；读错来源的后果在这里是「补出来的是切走那一刻的旧词」。M2 有了工作区根目录之后，把这个 getter 换成「磁盘上的词 + 打开的标签」即可，词源本身不用动。
> 36. **词典是增量维护的 `StateField`，不是每次请求现扫全文。** 4MB 的上限意味着一次全扫是 O(全文)——按每键一次算就是几十毫秒的卡顿。改成 `create` 时扫一遍、`update` 里只吸收 `tr.changes.iterChanges` 给出的那段插入文本，于是每键成本是 O(打进去的字)。**逐行扫（`doc.iterLines()`）而不是 `doc.toString()`**：词不可能跨行，按行切既省掉一次 4MB 的字符串分配，也天然不会被 `Text` 的 chunk 边界切断。
> 37. **⚠️ 这个 StateField 刻意违反「值不可变」的惯例**：`update` 里就地改、返回同一个对象。不可变就得每键复制一份两万条的 Map，那正是第 36 条要避免的成本。代价是词典被它派生出的所有 state 共享（包括撤销回去的旧 state 与 `tab.snapshot` 里存着的那一份），**删掉的词也不会跟着消失**。可以接受，因为词典是**建议性的**：它唯一的产出是候选列表，多一个已经删掉的词只是列表里多一个用不上的选项，不损坏任何数据。要让它跟着消失就得给每个词记出现次数，十倍的复杂度换「列表干净一点」。
> 38. **`MAX_WORDS = 20_000`，装满就停，不重建。** 一份 4MB 的英文文档能有二十万个不同的词，全存下来是十几 MB 字符串，与「主打低占用」直接冲突；两万个词已经覆盖任何真实文档的词汇量。重建是 O(全文)，而收益只是把本来就很全的词典补得更全一点。
> 39. **⛔ 中日韩字符不进词典。** 中文是拿输入法打的，在候选窗上面再叠一个补全弹层只会互相遮挡；而且 `CompletionContext` 压根看不到 `view.composing`，做不到「组字中就不弹」。M0 #2 那个「不抢键、不打扰组字」的判定是挣来的，不在这里赔掉。词的正则因此是 `[A-Za-z0-9_$]{2,}`——单字符也不收，一个字母的候选列表等于噪音。
> 40. **正在打的那几个字不作为候选。** 词典是增量吸收的，用户打出来的前缀本身就在里面，不排掉的话每次都会把「你已经打出来的这几个字」列成第一项——那不是补全，是噪音。`collect` 里一条 `lower === prefixLower` 就够（大小写不敏感，所以打 `con` 也不会把 `Con` 列出来）。
> 41. **自动触发要满两个字符，显式触发（`Alt+/`）一个就认。** 一个字符就弹的话，敲下 `a` 的瞬间会冒出一个装着几千个词的列表——那不是补全，是遮挡。**没命中时返回 `null` 而不是空结果**：`null` 是「这次我不参与」，语言包自带的源照常出；空结果会把它们顶掉。
> 42. **⚠️ 词源注册进 `EditorState.languageData` 的 `autocomplete` 键，不是 `autocompletion({override})`。** `override` 的类型文档写得很直白：默认源「取自 `autocomplete` 语言数据」——给了 override 就会把 `lang-css` / `lang-html` / `lang-javascript` 自带的源**全部顶掉**。而 `completionSource` 这个类型压根没从包里导出（写了会 TS2724），所以语言数据是唯一一条**加法**的注册路径。
> 43. **快捷键是 `Alt+/`（Sublime 的既有约定），⛔ 不是 `Ctrl+Space`。** CM6 `completionKeymap` 里那条 `Ctrl-Space` 在 macOS 上是系统的「切换到上一个输入法」，与 `Mod+W` 同一条道理——事件到达 webview 之前就被吃掉了，绑了也收不到（`builtins.test.ts` 里显式断言它**没被占用**）。`Option+/` 打出来的是 `÷`，但解析走 `event.code` 的物理键位（`CODE_ALIASES` 里有 `Slash`），所以能命中；这与 `Alt+Z` 是同一类回归，两种事件形状都钉了。
> 44. **弹层的外观得自己给一份 theme。** `darkTheme.of(true)` 让 CM6 的 `&dark` 规则生效了，弹层不是浅底——但那些颜色是**写死的**：`#333338` 的底、没有边框、选中行 `#347`、分组线 `1px solid silver`（暗底上一道亮边）、列表字体是笼统的 `monospace`，与本应用其余每一处面板（`--vela-bg-panel` + `--vela-border`）都不是一套。**用 `EditorView.theme` 而不是写进 styles.css**：theme 模块的优先级天然高于 baseTheme，而 styles.css 里同等特异度的选择器会被 CM6 运行时注入的样式表按顺序压过去。列表字体改成 `--vela-font-code`：里面是标识符，按 D2「按内容分字体」它属于代码。
> 45. **`peerStates` 挂在 `ViewConfig` 上而不是每标签一份**——与 `lineWrapSlot` 同一条理由（都是工作区的属性），与 `languageSlot` 相反（那是标签自己的）。缺省是 `() => []`，于是 `wordSource` 不经 workspace 单独用时退化成只有当前文档那一份，**不报错**。
> 46. **首屏 gzip 233.66 → 233.88 KB**（`index-*.js` 123.80→124.02、`dist-*.js` 108.31 与 `index-*.css` 1.55 都不变），预算 300 KB，余量 **22.0%**。chunk 仍 **117** 个，`index.html` 仍只引三个。**只涨 0.22 KB**：`@codemirror/autocomplete` 早就在首屏里了（`autocompletion()` 一直挂着），这次进去的只有词典与词源本身；theme 是运行时生成的，所以 CSS 一个字节没动。前端 **422** 个用例（+36）、Rust 53 lib + 6 wire-contract 全绿。
> 47. **测试口径再加两处**：① **`CompletionContext.matchBefore(re)` 取的是光标前那一段连续的词字符**，所以用例里插入的正文前面必须留空格——在 `'hello world'` 末尾直接插 `'wo'` 得到的是 `'worldwo'`，前缀成了 `worldwo` 而不是 `wo`，看起来像词源坏了，其实是光标位置算错了。② **注册表的缺省平台是写死的 `'macos'`**（`registry.ts`，项目 macOS 优先），不是 `detectPlatform()`；node 环境里也照样出 `⌥/` 这种符号形式，想看 `Alt+/` 那种文字形式得显式要一个别的平台。
>
> **待人工验**：真的各打开一个 `.md` / `.json` / `.ts` / `.log`，肉眼确认高亮与字体分区对——jsdom 里只能读 facet（语言名、装饰插件在不在），**读不到算出来的字体**，那一层自动化到不了。状态栏另需肉眼过一遍：22px 的条压在正文下面、路径过长时省略号截断、选中与多光标那两格是否只在需要时出现。**M1-E-2b 新增**：两个下拉塞进 22px 的条里撑没撑高整条、原生下拉面板在 `color-scheme: dark` 下是不是暗的、hover 时看不看得出能点、以及**拿一个真的 GBK 文件走一遍「以 GBK 重新打开」**（这条在 jsdom 里是 mock 的，真 IPC 只由 Rust 侧的单测覆盖）。**M1-E-3 新增**：打两个字母时弹层**出没出**、长得对不对（`--vela-bg-panel` 的底 + 边框、选中行不是 CM6 那个 `#347`、列表是 Maple Mono 而不是笼统的 monospace）、**中文输入法组字时会不会被弹层打扰**（这条是第 39 条那个取舍的真正验收，自动化压根测不到）、以及 **`Alt+/` 在真 macOS 键盘上按不按得到**（`Option+/` 出 `÷`，靠 `event.code` 才命中，与 `Alt+Z` 同一类风险）。

> **M1-F 实施修正**（会话恢复落地时与本节及 §2 功能清单的偏离）：
>
> 1. **存储介质从 rusqlite/sled 改成 `app_data_dir()` 下的单个 `session.json`。** 表格里那句「rusqlite/sled」是按「会话可能要增量写、可能要按窗口分档」估的，落地时发现两个前提都不成立：会话是**整体读写**的（启动读一次、运行期每 5 秒最多写一次、关窗写一次），而且 M1 只有一个窗口。单文件 + `write_bytes_atomic`（临时文件 + `rename`）就够了，而代价是**少两个依赖、少一层 FFI、少一套迁移**。两个候选的许可证本来都没问题（rusqlite MIT、sled Apache-2.0），所以这个决定是成本/复杂度上的，不是合规上的。
>    - **重估点**：出现下面任何一条就换回「元信息 + `drafts/<id>` 分文件」——① 每窗口一份会话；② 命名会话（工作区）；③ 草稿要增量写而不是整篇重写。真到了要 SQL 查询的那天再上 rusqlite，届时 `session` 模块的公开面（`load` / `save` / `Session`）不用动。
> 2. **4MiB 硬上限，超了从最大的草稿开始丢，但 ⚠️ 绝不能静默丢。** `SessionReport.droppedDrafts > 0` 时前端必须在提示条上说一句。用户以为稿子存下来了、下次启动发现没了，比一开始就不存更糟。丢光草稿还超预算就说明**元信息本身**超了 4MiB，那种情况整份报错——而它本该被第 3 条拦住。上限来自 PLAN §2.6 修正 1（单次 IPC payload 4MB）。
> 3. **`MAX_SESSION_TABS = 64` 有两个身份：前端是「存」的预算，Rust 是「读」的闸。** 两边各写一份、各有一条契约测试钉住，没有代码生成。光靠 4MiB 拦不住标签数——一个标签的元信息只有一百来字节，一份手改过但结构合法的存档能塞进几万个，而前端会照着它建几万个 CodeMirror state，启动直接卡死。前端超出部分从**最后**截断（标签条按最近使用排，越靠右越可能是顺手开一眼的），但**分屏正在显示的标签一定留住**：截掉它会让 `panes` 里的下标悬空，Rust 因此拒掉整份存档。
> 4. **⚠️ 存档路径由 Rust 从 `app_data_dir()` 算，`load_session` / `save_session` 都不接受路径参数。** 让它变成参数等于给 webview 再添一个「写任意路径」的原语，而写的内容是用户未保存的草稿（`src-tauri/src/commands.rs` 的 `session_path`）。这与 M0 删掉 `read_text_file(path)` 探针是同一条理由。
> 5. **干净又有路径的标签不存正文，恢复时重新读盘。** Vela 关着的时候文件可能被别的程序改过，拿存档里的旧正文盖上去等于悄悄回退用户的文件。存草稿的条件因此是「脏 **或** 未命名」。
> 6. **`format` 与 `lossy` 是必填字段，⛔ 不加 `#[serde(default)]`。** 未命名文档也带一份 `format`：它是**那个文档**的属性、决定它的字节怎么写回去，不是「有没有路径」的附属品——用户在没落过盘的文档上选了 GBK+CRLF，这个决定只能存在这里。`lossy` 的全部作用是拦住「原样保存会永久损坏原文件」，重启后把它丢了等于把那条警告连同它要防的事故一起删掉。加了 `default` 之后旧存档会被解析成 `lossy: false` + UTF-8/LF，于是一个本该警告的文档安安静静地按 UTF-8 写回去。会话格式有 `version` 兜着，不认识的整份作废，用不着靠默认值硬吃旧文件。`wire_contract.rs` 里有一条用例专门把这两个 key 抠掉、断言整份被拒。
> 7. **`version` 由 Rust 存盘时强行覆写成自己的 `SESSION_VERSION`，不接受调用方传的值。** 前端把它当不透明数据往返，让它能写这个字段等于让它能伪造一份「看起来是新格式」的旧数据。
> 8. **恢复时选区必须夹到文档长度以内。** CM6 的 `checkSelection` 对越界位置直接抛 `RangeError`，而磁盘上的文件可能在 Vela 关着的时候被截短了，存档里的光标位置就成了非法值。夹是单调的，所以选区之间的先后顺序不会被打乱。`main`（主选区下标）也夹一次：Rust 侧校验过，但 `restoreSession` 是公开方法，测试与将来的调用方都可能递进来一份手搓的存档。
> 9. **多光标整个数组都存**（每项 `[anchor, head]`），不是只存一个光标位置。M1-C 把多光标做成了一等公民，恢复时把 5 个光标变成 1 个是明显的手感倒退，代价只是一个数组。
> 10. **`focused` 是 `panes` 的下标，不是 `tabs` 的下标**——两者只有一个标签时才碰巧相同。`panes` 存的也是 `tabs` 的下标而不是运行期的标签 id（id 是前端递增分配的，重启后对不上），且**不允许重复**：`workspace.ts` 的不变量 2 规定一个标签同时只显示在一个分屏里。`validate` 挂在手写的 `Deserialize` 上，所以坏存档在**解析阶段**就被拒，不会变成一个「下次启动才炸」的文件。
> 11. **⛔ 偏好设置不进会话存档。** 字体、字号、换行开关、主题属于 settings（M2），混进会话的话「换一次字体」就会触发一次会话写盘，而且两个来源会互相覆盖。会话只存**这一次的现场**。
> 12. **节流用「定时轮询 + 比对序列化结果」，不是「改动时打个标记」。** 标记要挂在每一个会改现场的地方：输入、切标签、开文件、另存为、换编码、分屏、合并、聚焦、**滚动**、拖拽重排……漏一个的后果是存档悄悄停在旧状态，而且没有任何报错（滚动尤其容易漏：它是纯视口更新，连 `onUpdate` 都不触发）。比对不会漏，代价是每 5 秒多算一次 `serializeSession`——几十个标签一两毫秒，换来「不可能漏」。
> 13. **关窗放行之后必须再存一次。** 节流那一轮最长要等 5 秒，而 `close_window` 是 `Window::destroy()`，webview 当场就没了。接线方式是把这个动作塞进 `attachWindowCloseGuard` 的回调里（`requestWindowClose()` 答 true 之后 `await saveNow()`），于是 `windowClose.ts` 一行都不用改。`saveNow` 写失败也**不往上抛**：抛出去的后果是那条 promise 链 reject，`close_window` 永远不被调用，应用变成一个关不掉的窗口——而用户的**文档**已经由 `requestWindowClose` 那一步保住了，存档是尽力而为的。
> 14. **答「不保存」必须真的把改动清掉（新增 `DocumentModel.discardChanges`）。** 这是 M1-F 与 M1-D 的接缝：M1-F 之前「不保存」等于「窗口一关内存就没了」，是免费的；有了存档之后，存档收草稿的条件就是脏标记，不清掉它，用户刚刚明确扔掉的稿子下次启动会原样端回来——那个确认对话框就成了在撒谎。有路径的只清脏标记（存档于是收 `draft: null`，恢复时重读磁盘，用户看到的正是他要的「磁盘上的样子」）；未命名文档还得把正文清空，因为磁盘上没有它、正文就是唯一的副本。⚠️ 有路径时**刻意不回滚编辑器里的正文**：真回滚要重新读一次盘，而这条路跑在关窗/关标签的半路上，读失败会把一个已经放行了的关闭又卡住。
> 15. **顺带修掉一个从 M1-D 就在的 bug：启动、新建分屏、恢复会话之后都得先点一下编辑器才能打字。** `split` 里的 `focusPane` 跑的时候新分屏的 `controller` 还是 null，那一次 `controller?.focus()` 是静默空操作。修在 `workspace.attach` 里：聚焦的那块挂上 controller 时补一次 `focus()`。同处还要补一次 `applyScroll`——恢复出来的标签带着非零滚动，而新 view 是从 0 起的。`applyScroll` 因此成为 `EditorController` 上一个**独立于 `restore` 的方法**：`attach` 那一刻 view 是刚用这个标签的 state 建起来的，再 `setState` 一次等于把一个全新视图的 docView 拆了重建。
> 16. **`restoreDraft` 不复用 `openAt`。** 后者走 fs 层并且把 `dirty` 强制设成 false，而恢复出来的草稿按定义就是脏的——标成干净的话，下一次关窗的确认会直接放行，用户的稿子没了。它内部用 `replaceText` 而不是 `setText`：整篇替换会触发 `docChanged`，不挡住的话「装进去」这个动作会自己把文档再标脏一次，而 `dirty` 该由存档说了算。也刻意**不 `host.focus()`**：恢复好几个标签时，焦点不该落在「恰好最后处理的那个」上。
> 17. **首屏 gzip 233.88 → 235.01 KB**（`index-*.js` 124.02→125.15、`dist-*.js` 108.31 与 `index-*.css` 1.55 都不变），预算 300 KB，余量 **21.7%**。chunk 仍 **117** 个，`index.html` 仍只引三个（⛔ `manualChunks` 一条都没加）。前端 **495** 个用例（+73）、Rust **90** 个（75 lib + 14 wire-contract + 1 契约）全绿。
> 18. **测试口径再加三处**：① `session.test.ts` 的黄金 JSON 与 Rust 侧**只差三处** `0.0` → `0`（serde 给 `f64` 一律带小数点，`JSON.stringify` 不带；同一个 JSON 数字，两边各自钉住自己的字面量）。`SessionReport` 那条用例里的 `bytesWritten: 437` 是**由黄金会话现算出来的**（`new TextEncoder().encode(GOLDEN_SESSION).length`），于是改了会话却忘了改报告数字会当场红。② 会话层的单测**不用 `vi.useFakeTimers()`**：假表会把 `requestAnimationFrame` 一起冻住，而 CM6 的 measure/read 两阶段调度正跑在 rAF 上，挂真编辑器的用例会连带变成一个时序谜团。调度器改成注入的（`Scheduler`），用例手动点一轮就跑一轮。③ `document.test.ts` 与 `App.test.tsx` 的 `beforeEach` 都只 `mockReset` 了 `openFile`、**没给默认返回值**，于是任何走 `openAt` 的新用例都会静默失败（拿到 `undefined` 后在 `file.text` 上抛、路径留在 null、错误落在 notice 上）——写恢复类用例时必须自己 `mockResolvedValue(textFile())`。
>
> **待人工验**（启动真实 app 被拦，自动化到不了）：**重启一次 Vela**，确认标签、正文、光标、多光标、滚动位置、分屏布局与聚焦的那块都回来了；干净的文件是**重新读盘**的（关机期间用别的编辑器改一下那个文件，再启动 Vela，看到的应该是改后的内容）；未命名文档的草稿原样回来而且仍然标着 ●；**恢复完直接打字打得进去**（第 15 条那个修复，不用先点一下编辑器）；关窗时答「不保存」再启动，那份稿子**不该**回来；把 `session.json` 手改坏一次，启动应该看到「上次的会话没能读回来」而不是白屏。存档位置：`~/Library/Application Support/app.vela.m1/session.json`。

> **M1-G 实施修正**（「字体分片按字频重排」核实后**不实施**，M0 #4 就地结案）：
>
> 1. **前提是错的：两个字体包的分片本来就是按字频排的，只是密度高的排在编号末尾。** 上游用的都是 `cn-font-split`，它按频率表排序后再装箱，所以「按码位区块切、一屏汉字散落到 25~36 片」这个根因判断从一开始就不成立。证据（拿仓库里 110KB 的真实中文语料 PLAN.md + M0-REPORT.md 去比对每片的 `unicode-range`）：文楷 GB 变体末 10 片的「片内码点被语料用到」的比例是 `subset-110` 48/188、`112` 68/188、`113` 96/188、`115` 131/188、`117` 166/188、`118` **174/188**；而**开头** 10 片是 0~2/138。Maple 同形：末片 `#237` 24/24、`#238` 55/58，开头 8 片 0~1/140。**常用字早就挤在一起了，只是挤在尾部。**
> 2. **提议的修法会让典型场景变差，不是变好。** 「把常用 ~3500 字集中到头 1~2 片」= 做一个 3500 字形的巨型分片。文楷 GB 的实测密度是 14492 码点 / 4.328MB ≈ **312 B/字形**，3500 字就是 **~1.09MB 的单一分片**——而一屏典型中文正文只用得到 300 个左右的字，今天拉 **0.648MB**（13 片）。把片做大等于把 `unicode-range` 懒加载赖以省字节的「片内大部分码点这一屏用不到」这个前提亲手扔掉。**分片粒度不是越粗越好，139~188 码点/片已经接近这个语料的最优点。**
> 3. **重测：预算本来就是达标的，2.219MB 是稳态被错标成了首屏。** 口径改成「从生产构建产物 `dist/index.html` 实际引用的三个 chunk 里取非 ASCII 码点集」（296 个，注释已被构建剥掉，比拿源码 grep 干净——源码 grep 会把 CodeMirror 各语言模式 chunk 里的拉丁扩展与关键字表也算进来，虚高到 776 个）：
>    - **启动 + 空文档 + 界面文案**：文楷 GB **26 片 / 1.039MB** → **在 2MB 预算内**（与 M0 记的「空文档 + 界面中文 0.49~1.07MB」上沿吻合）。
>    - **加上正文频率前 200 / 500 字**：仍是 **26 片 / 1.039MB**——常用字已经全在那 26 片里了，正文再加字**一片都不用多拉**。前 1500 字才涨到 36 片 / 1.534MB，仍在预算内。
>    - 2.219MB 那个数来自 M0 的**1 万行常用字混排**合成压测文档（2000+ 个不同汉字 + 表格 + 代码块），是**滚完一整篇极端文档后的稳态驻留**，不是首屏。⚠️ **口径教训：懒加载架构下「首屏字节」必须按「首屏实际出现的字符集」算，不能拿压测文档的稳态冒充。**
> 4. **唯一还能真的把数字压下去的杠杆不在分片，在 D2：Markdown 表格被划进了代码区。** `Table` 与 `FencedCode`/`CodeBlock` 一起打 `.vela-code`，于是**中文表格里的正文走 Maple Mono CN**，一篇中文文档会同时拉两套 CJK 字体。实测同样字符集下 Maple 侧是 **46 片 / 1.96MB**（比文楷的 1.53MB 还贵，因为 Maple 的 CJK 字形更大：8.867MB / 239 片）。把 `Table` 移出 `.vela-code` 能让纯中文文档少拉一整套 CJK——**但代价是表格源码失去 2:1 列对齐**，而那正是 D2 当初选 Maple 的理由。这是产品取舍不是技术债，**没有擅自改**，留给用户拍板。
> 5. **RFN 核实结果（这条比 #26 本身重要，它关系到商业化发布）。** 上游 `LxgwWenKai-Screen/OFL.txt` 确实声明了：`Copyright 2021-2026 LXGW ... Reserved Font Name '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW'`。OFL 1.1 条件 3 规定 Modified Version 不得使用 RFN，而 OFL FAQ 明确「删字形（subset）会产生 Modified Version」，且**没有给 webfont / 格式转换开豁免**。纯 TTF→WOFF2 转换在业内没有共识（TypeDrawers 那帖 Dave Crossland / John Hudson / Christopher Slye 三种意见并存），但**子集化是有共识的**。
>    - ⚠️ **所以我们今天就已经在这个张力里了，与 #26 无关**：`lxgw-wenkai-screen-webfont@1.7.0`（作者 Chawye Hsu，包装代码 MIT、字体 OFL）本身就是第三方把 TTF **子集化成 97/388 片**的产物，而我们以 family 名 `'LXGW WenKai Screen'`（含 RFN `LXGW`）分发它。上游 README 只写「available under the SIL Open Font License 1.1」，**没有提到授权、RFN 或子集化规则**——即没有可引用的书面许可。
>    - **这恰好是「不要自己动手重排分片」的第二个理由**：一旦我们自己跑 fonttools 重切， Modified Version 的作者就从 chawyehsu 变成我们，那条责任也就直接落到一个**闭源、可能商业化**的产品头上。Maple Mono CN 的 `LICENSE` 版权声明后**没有任何 RFN 声明**，所以 Maple 侧随便切都不触发改名义务——但按第 2 条，切了也没收益。
>    - **待用户决策（商业化发布前必须定）**：(a) 向 LXGW 作者取得书面许可；(b) 把 family 名改成不含 RFN 的名字（如 `Vela Kai`，PLAN 里 D1 的 (b) 方案已备）；(c) 换成无 RFN 的等价楷書（代价是重测 #3 列对齐与视觉）。**在此之前不要做任何自己动字体二进制的优化。**
> 6. **结论：M1-G 以 0 人日结案，一行代码没改。** M0 #4 从「❌ 超预算 11%」改判为「✅ 达标（首屏 1.039MB / 预算 2MB），原超标读数系稳态误标为首屏」。§2 硬预算表、§3.2 #4 与 R2 里「按字频重排可降到 1.0~1.2MB」那句同步作废。**重估点**：若将来出现「安装包体积要压到 20MB 以下」或「首屏要进 500KB」这类新约束，那时该动的也不是重排分片，而是第 4 条（表格字体归属）与第 5 条（换字体/改名）。

> **M1-H 实施修正**（lint / format / CI 落地；「脚手架」这一项至此真的补齐了）：
> 1. **`rustfmt.toml`：`use_small_heuristics = "Max"` + `max_width = 120`。** 默认的 `"Default"` 会把 `struct_lit_width` 压到 18、`single_line_if_else_max_width` 压到 50，于是 `Decoded { text, encoding, bom, lossy }` 这种一行放得下的字面量被摊成五行——本仓库的 Rust 是**刻意的紧凑单行风格**（`fs/encoding.rs`、`session/mod.rs` 通篇如此）。实测：默认配置下 `cargo fmt` 产出 **90 处纯排版差异**，那不是格式化，是把手写排版整个重画一遍，review 时读不出任何语义信息。换 `Max` → 32 处，再把 `max_width` 放宽到 120（与前端 prettier 同宽）→ **21 处**，全部归一后 `cargo fmt --all --check` 干净、**90 个测试仍全绿**（黄金 JSON 契约那 14 条也照过，格式化没碰任何断言）。
>    ⚠️ 这两项都是 **stable** 选项。`wrap_comments` / `imports_granularity` / `group_imports` 是 unstable，在 stable 工具链上会被**静默忽略**——配了等于没配，在 CI 里就成了「看着有保险、其实没有」。
> 2. **clippy 只有 2 条**（`needless_borrows_for_generic_args`，都在 `fs/read.rs` 的测试里）：`fs::write(&path, &[0x61, …])` 的借用是多余的，`[u8; N]` 本来就实现 `AsRef<[u8]>`，传字面量即可。CI 用 `cargo clippy --workspace --all-targets -- -D warnings`，**不在源码里写 `#![deny(warnings)]`**——那会让本地开发构建也被新版本的 clippy 卡住。没加 `[workspace.lints]` 也没加 `clippy.toml`：没有需要调的东西，多一层配置只是多一个真相来源。
> 3. **这一轮真正的收获是打开了 `noUncheckedIndexedAccess`，而它不是为了过 lint 才开的。** ESLint 首跑 **238 条**，其中 **180 条是 `no-unnecessary-type-assertion`，而它们几乎全是非空断言 `x!`**。根因不是代码写多了断言：代码库本来就按「索引访问可能是 undefined」的防御性写法在写，tsconfig 却没开这个开关，于是 TS 认为那些 `!` 多余。用 `tsc --noEmit --noUncheckedIndexedAccess` 先探代价：**只有 4 处不合规**。开启后 180 条 lint 归零，同时暴露出 4 处真正没设防的索引访问（`viewport.ts` 的 `ranges[0]` / `ranges[len-1]`、`controller.test.ts` 两处 `mock.calls[0][0]`）。
>    ⚠️ **教训**：lint 报出成百上千条**同一条规则**时，先怀疑是「配置与代码风格的口径不一致」，而不是「代码有几百个错」。这次顺着报错去删 180 个 `!` 会是纯亏损——删掉的是防御，留下的是配置缺口。
> 4. **两条规则关掉，都有据可查，不是嫌烦。**
>    - `@typescript-eslint/require-await` → off：24 处命中**全部**是「Promise 返回型签名的桩实现」（`promptDiscard: async () => 'cancel'`、`invoke.mockImplementation(async () => ({…}))`）。这些位置上的 `async` 是**类型强制要求**的（接口要 Promise，去掉就编译不过），而规则的前提是「写了 async 却忘了 await」。留着它换来的是 24 条永久豁免——**那比没有这条规则更糟，它教会所有人无视 lint 输出**。
>    - `solid/prefer-for` → off：本仓库三处真正的响应式列表（`ws.tabs()` / `ws.panes()` / `props.names`）**已经全部用 `<For>`**；被点名的 6 处 `.map()` 迭代的是 `FONT_VARIANTS` / `ENCODING_CHOICES` / `LINE_ENDING_IDS` 这类模块级常量，回调里不读任何 signal，Solid 只求值一次，换 `<For>` 是白付一层 keyed 协调的开销。规则分不清「常量表」和「响应式数组」。
>    - `prefer-const` 用 `ignoreReadBeforeAssign: true`：放过 `let doc!: DocumentModel` 这种「赋值前就被自己的闭包读到」的循环初始化（照规则改成 `const doc!: T` 是**语法错误**），而 `let r = lerp(…)` 那种真漏网的仍然会报。剩下 3 处（`tab.ts` / `workspace.ts` / `wordSource.test.ts`）是「被自己初始化表达式里的闭包引用」，这个选项覆盖不到——实测**直接写成 `const` 就行**：闭包捕获的是绑定不是值，`const self: EditorState = stateFor('alpha', () => [self])` 配上显式注解也不会触发循环推断。三处都已改，注释同步更正。
> 5. **6 处 `eslint-disable-next-line` 全部写了理由，且都是插件口径问题而非代码问题。**
>    - `solid/reactivity` ×4：`props.workspace` ×2（是 `createWorkspace()` 返回的普通对象、App 只建一次也从不换引用，不是 signal）、`syncMetrics(firstTab)`（普通函数的一次性命令式推送，套 `createEffect` 反而会跟着无关 signal 重跑）、测试里直接读 `lines()`（要的正是同步当前值，放进 tracked scope 断言会推到下一个 tick、**绿得毫无意义**）。
>    - `only-throw-error` ×2：两处 mock **必须**抛普通对象——Tauri 的 `invoke` 在 Rust command 返回 `Err` 时拒绝的就是那个序列化结果，不是 `Error` 实例；包一层 `new Error` 等于把被测路径换成生产环境里不存在的那条。
>    - ⚠️ **踩坑**：`eslint-disable-next-line` 只作用于**紧跟它的那一行**。把说明续写在指令下面（`// eslint-disable-next-line rule -- 说明` 再换行接着解释）会让指令去禁一行**注释**、真错误照旧红。正确写法是说明在上、指令紧贴代码行；同行说明只能用 `-- ` 那种单行形式。
> 6. **给 mock 标上真实签名，立刻抓出一处既有缺陷。** 把 `vi.fn()` 换成 `vi.fn<typeof import('./ipc/fs').openFile>()` 之后，`App.test.tsx` 里 `let release!: (v: unknown) => void` 当场编译不过：`new Promise((resolve) => (release = resolve))` 交出去的是 `(value: TextFile | PromiseLike<TextFile>) => void`，参数位在逆变方向上 `unknown` 是不健全的。这是**开了类型才看得见的旧问题**，不是新引入的。顺带删掉三处 `(...args: unknown[]) => ipc.openFile(...args)` 包装、直接传 mock 引用：typed 之后 `unknown[]` 已不满足真实签名，而那层包装本身也不产生任何行为差异。
>    📌 附带收益：以后 `mockResolvedValue(错的形状)` 会**在编译期**红，而不是变成一个运行时的谜。
> 7. **两处真实类型漏洞修掉了，都在产品代码 `findReplace.ts`。**
>    - `iterateMatches(…).next().value` 是 **`any`**：`Generator<Match>` 的第二个类型参数 `TReturn` **默认就是 `any`**，`.next()` 于是返回 `IteratorResult<Match, any>`，`.value` 塌成 `any`，后面 `match.from` / `match.to` 完全没被检查。改用文件里既有的 `for (const m of …)` 写法，`limit: 1` 保证最多一个匹配，连判空都不需要。
>    - `elt()` 的 `attrs: Record<string, unknown>` 让 `String(value)` 可以把 `[object Object]` **静默写进 DOM 属性**。收紧成 `string | number | boolean | AttrHandler | null | undefined`；`AttrHandler = (event: never) => void` 的 `never` 参数位是为了让 `() => void` 与 `(e: KeyboardEvent) => void` 都能赋进来（逆变方向上 `never` 可赋给任何类型），同时把对象挡在联合类型外面。
> 8. **specta codegen 重估点：不引入**（详见 §2.6 约束 2 的更正）。触发条件是「command 上两位数」，实测仍是 **5 个**；并且原写「届时黄金 JSON 测试可以直接退役」是错的——codegen 保证类型同形，保证不了线上字节。
> 9. **CI：`.github/workflows/ci.yml`，三个 job。** 仓库有 remote（`git@github.com:xuankew/vela.git`），所以这不是个空配置文件。
>    - `web`（ubuntu）：`pnpm install --frozen-lockfile` → typecheck → lint → **format:check** → test → **build**。format 只查不改：CI 里跑 `--write` 会把「有人忘了格式化」变成静默通过。build 必须单跑一遍——vite 走 rolldown、与 vitest 的解析路径不同，只有它能抓到「dev 下侥幸通过、构建期才炸」的动态 import 路径，而字体分片那条链全靠静态分析切 chunk。
>    - `rust`（ubuntu）：先装 Tauri 的 Linux 系统依赖（`libwebkit2gtk-4.1-dev` 等），否则 `clippy --all-targets` 会红在**链接阶段**、报错长得像代码问题；再 `cargo fmt --all --check` → `clippy --workspace --all-targets -- -D warnings` → `cargo test --workspace`。
>    - `bundle-macos`（macos）：**只在打 tag 或 `workflow_dispatch` 时跑**——macOS runner 按 Linux 的 **10 倍**计费，而 `tauri build` 是 `codegen-units=1 + lto=true` 的 release 全量编译。它验的恰好是前两个 job 验不到的：ad-hoc 签名、`.app` bundle 结构、图标与 Info.plist。`bundle.targets` 只有 `"app"`，所以 artifact 只有 `.app` 一个路径，`if-no-files-found: error` 防止打个空 artifact 装作成功。
>    - **工具链全部钉死**：node `22.22.2`（与本地同版本）、pnpm 由 `package.json` 新增的 `packageManager: pnpm@10.18.1` **单点提供**（不在 workflow 里再写一遍，免得两处各钉一个）、Rust `dtolnay/rust-toolchain@1.97.1`（本地 Homebrew rustc 同版本；已核实 `static.rust-lang.org/dist/channel-rust-1.97.1.toml` 返回 200）。**钉小版本而不跟 stable 是刻意的**：`cargo fmt --check` 与 `clippy -D warnings` 都是会随工具链漂移的门禁，跟 stable 意味着某天早上 CI 红了而代码一行没动——那种红只会训练人去点 re-run。升级 = 改那一行 + 本地把 fmt/clippy 重跑一遍。
>    - `concurrency` + `cancel-in-progress: true`：同一分支推了新 commit 就取消还在跑的旧 run。
>    - ⚠️ **CI 的每个门禁都在本地跑过一遍**（fmt / clippy -D warnings / cargo test / typecheck / lint / format:check / build 全绿），第一次 push 不该有惊喜。**唯独 `bundle-macos` 与那串 `apt-get` 依赖本地无法验证**——要等第一次打 tag 或手动触发才算真验过。
>    - 📌 **可选加固（未做）**：第三方 action 目前按 tag 引用（`actions/checkout@v4` 等）。对一个闭源商业仓库，按 commit SHA 钉死能挡住「上游 tag 被移动」这类供应链风险；`dtolnay/rust-toolchain` 是例外，它把 ref 本身当工具链名用，**没法按 SHA 钉**。
> 10. **口径复核：全是排版与类型层面的改动，体积一个字节没动。** 首屏 gzip 仍 **235.01 KB**（`index-*.js` 125.15 + `dist-*.js` 108.31 + `index-*.css` 1.55），chunk 仍 **117** 个、`dist/index.html` 仍只引 **3** 个。前端 **495** 个用例（22 个文件）、Rust **90** 个（75 lib + 14 wire-contract + 1 契约）全绿。`tauri.conf.json` 被 prettier 收了一处数组换行，语义未变。prettier 忽略了 `*.md`（PLAN.md / M0-REPORT.md 里有大量刻意压成单行的表格与多层引用块，重排产出的 diff 与内容无关）与 `pnpm-lock.yaml`。

---

### 3.4 M2 · 项目与搜索（8–10 人日）

**目标**：能打开真实仓库并使用。

| 工作项 | 人日 | 要点 |
|---|---|---|
| 文件树 Rust 侧 | 1.5 | ✅ **已交付（M2-A，2026-09-17），但与本行原文相反**：按需 `read_dir`（**绝不建全量树**，这条照做）、排序规则（文件夹优先 / 不区分大小写 / 字节兜底），而 ~~`ignore::WalkBuilder` 遵守 .gitignore~~ **改成了不过滤**——实测过滤让顶层从 79µs 变慢到 5.14ms（45×），且与下一行的「`node_modules`/`dist` 默认折叠」自相矛盾。详见下面「M2-A 实施修正」1。原写的「类型分组」排序**没做**，理由见修正 3 |
| 文件树前端 | 2 | ✅ **已交付（M2-B-1~5，2026-09-17）**：✅ 虚拟化列表（固定行高 + 上下各 3 行 overscan）、✅ 展开折叠状态**进了会话存档**（`Session.project`）、✅ 侧边栏 UI（打开/关闭文件夹、刷新、错误就地显示）、~~`node_modules`/`.git`/`dist` 默认折叠~~ **这条删掉了**（整棵树默认全收起，没有「自动展开」这件事，见下面「M2-B 实施修正」1）、✅ 右键菜单（新建文件/新建文件夹/重命名/移到废纸篓/在 Finder 中显示/复制路径）——原写的「删除」落地成**移到废纸篓**、后两项调 macOS 自带命令，见修正 2、3；根行不给「重命名」与「移到废纸篓」，见「M2-B-5 实施修正」2 |
| 全局搜索 | 2.5 | ✅ **已交付（M2-C-1~4，2026-09-17）**：✅ `grep-searcher` + `grep-regex`（另加 `grep-matcher` 接口 trait、`ignore` 遍历过滤、`globset` 通配，五条都是 Unlicense OR MIT）、✅ **流式 event 推送**（batch/done/failed 三个事件 + 心跳批，见修正 5）、✅ 按文件分组（**只体现在行的顺序上，不建父子指针**，见修正 6）、~~上下文预览~~ **改判成只显示命中那一行本身**（见修正 7）、⚠️ include/exclude glob **Rust 与 IPC 两侧都在，UI 刻意不暴露**（用户在「搜索词 + 三个开关」与「再加 include/exclude 两个输入框」里选的前者，见修正 8）、✅ 可取消（协作式，见修正 4） |
| 全局替换 | 1 | ✅ **已交付（M2-D-1~5，2026-09-17）**：✅ 预览所有变更（**不另起一条 IPC**——同一条 `start_search` 在 `query.replace` 存在时就在命中里多带一个 `replaced`，见修正 1）、✅ 确认（**摊一张确认单**，落盘前把「会改几个文件、几行、跳几个、是不是在删」写成人话，见修正 3）、✅ 批量应用（`start_replace` 走第二遍并原子写盘，见修正 2）、✅ 支持正则（**复用搜索侧同一个 matcher**，所以预览与落盘的匹配规则在结构上不可能分岔）。⚠️ **没有跨文件撤销**——这是本项目里唯一一处批量写盘，确认单上明写着，见修正 3。原表没写、但落地时补上的两条：**正开着且未保存的文件被跳过而不是被盖掉**（修正 4）、**落盘之后把干净标签从磁盘重读一遍并说一句**（修正 5） |
| Goto Anything | 1 | ✅ **已交付（M2-E-1~6，2026-09-18）**：`Cmd+P` 模糊找文件（**手写** fuzzy match + MRU 加权，⛔ 一个新 crate 都没加）、`Cmd+R` ~~文件内符号（Lezer AST）~~ **只做 Markdown 标题**（ATX 1-6 + Setext 1/2；其他语言回「这个语言还没有符号表」）、~~`Cmd+Alt+G` 跳行~~ **CM6 原生那条原样留着、⛔ 不注册 `goto.line`**，跳行改成浮层里的 `:42` 语法（`Cmd+G` 早被 M1-C 的「查找下一个」占了，见 §3.3「M1-C 实施修正」5）。四种意图共用一格输入框，另有 `store.ts:42` 与 `@标题`。原表没写、落地时补上的：**MRU 进会话存档**（上限 50）、**索引不跨会话缓存**（`index_project` 每次展开都重建，于是「过期」不可能发生、手动刷新入口也不需要）。改判与踩坑见下面「M2-E 实施修正」 |
| 工作区管理 | 1 | ✅ **已交付大半（M2-F-1~6，2026-09-19）**：✅ **多根工作区**（侧边栏 `+` 一次多选，`Cmd+Shift+O` 换整套根；~~对齐 Sublime 的 `.sublime-project`~~ **没有项目文件**——工作区就是一份根清单，活在会话存档的 `Session.project.roots` 里，见「M2-F 实施修正」3）、✅ **最近项目**（`Cmd+Shift+O`，复用 `Cmd+P` 那个浮层的第四种意图，⛔ 一个新浮层都没加，见「M2-F 实施修正」5、9、10）、🔴 ~~`.vela/settings.json` 分层合并~~ **推迟到 M4**（用户在两选一里选的后者，见「M2-F 实施修正」1）。<br>⚠️ 原行写着「`Cmd+Shift+O`（⛔ 这个键已被用例钉住为占用状态）」——**措辞本身是错的**：M2-F 之前那条用例钉的是**无人占用**（`findForKey(...).toBeNull()`），M2-F 把它兑给了 `project.openRecent` 并同时**翻转了那条断言**（见「M2-F 实施修正」8）。<br>⚠️ 原行还写着「~~最近项目~~（M2-E 提前做掉了）」——**只对一半**：M2-E 做的是最近**文件**（`Session.recent`），这里补的是最近**工作区**（`Session.recentProjects`，一条是一份根清单），两者并存（见 §2.5 那段更正与「M2-F 实施修正」5） |
| 文件监听 | 1 | ✅ **已交付（M2-G-1~5，2026-09-19）**：`notify` 8.2.0 + `notify-debouncer-full` 0.6.0（250ms 抖动合并）。<br>⚠️ **与本行原文的两处不同**：① 原写「文件被外部修改时提示重载」——落地成**三分流**，干净文档被改走**静默重读**、一个字都不问（弹框只是打断），只有脏文档被改与文件被删才提示；② 监听范围是**打开着的文件的父目录**（上限 256 个），**不是**项目根，所以侧边栏那棵树不跟着刷新（修正 1）。<br>⛔ **不做「自己写盘的事件抑制表」**（修正 2），⛔ **`Remove` 不当删除用、一律 `stat` 一次再判**（修正 3）。改判与踩坑见下面「M2-G 实施修正」 |
| 大文件只读分片 | 1 | ✅ **已交付（M2-H-1~6，2026-09-19），但与本行原文几乎处处不同**：<br>① ~~`ropey` 持有全文~~ **Rust 侧不持有全文**——只存一份「每 1024 行一个字节偏移」的稀疏索引，正文按行号窗口现读现还，256 MiB 的文件常驻 ≈210 KB（`ropey` 从未进过 `Cargo.toml`，作废理由见下面「M2-H 实施修正」1）；<br>② ~~按可视窗口请求分片~~ 请求的单位是**行号** `[start, count)` 而不是字节区间（修正 1）；渲染层**复用 `src/ui/virtual.ts`** 那个只读虚拟列表，⛔ 不是「CM6 装一个窗口化文档」（修正 2）；<br>③ ~~禁用编辑并给出提示~~ **连提示都没有**：`too_large` 在这一层不是失败而是「换一条路」，界面上直接换成只读分片，⛔ 一个字都不抱怨（说一句「文件太大」而屏幕上明明显示着内容，是自相矛盾）。「只读」由**状态栏那一整排只读格**表达（编码/换行符两个 `<select>` 压根不渲染），而不是由一句提示（修正 6）；<br>④ 原表没写、落地时补上的一条：**分片里没有 ⌘F**（用户在「要不要」里选的「不要，全局搜索已经够了」）。这条决定连带把搜索的 `MAX_FILE_BYTES` 从 10 MiB 抬到 **64 MiB**，于是 **4–64 MiB 搜得到、64–256 MiB 打得开却搜不到**——缺口是有意的、计入 `skipped_too_large` 上报（修正 3）；<br>⑤ 门槛是 **4 MiB**（`MAX_INLINE_BYTES`，管单次 IPC payload）而不是 §1.4 原写的 50MB，上限 **256 MiB**（`MAX_SHARD_BYTES`）；<br>⑥ 三条**原表压根没有**的收尾：分片路径**不进文件监听清单**（修正 9）、**关掉标签必须还 fd**（Vela 里唯一一个不调就会漏的资源，修正 6）、**分片标签永远不会变脏**（否则关不掉，修正 6） |

**验收**：打开一个含 `node_modules` 的真实前端仓库（10 万+ 文件），侧边栏秒开不卡，全局搜索首批结果 < 2s。

> ⚠️ **M2-C 收尾时这条验收只结了一半，另一半明写着欠**：
> - **搜索半边**：✅ 已量、已达标，但量的是**合成的十万文件树**（外部卷、release），不是含 `node_modules` 的真实仓库。数据在 §2.9 与下面「M2-C 实施修正」2。
> - **侧边栏半边**：❌ 仍只有下界证据。本仓库 22722 个文件（不含 `target/`），判据要的是「10 万+」；已实测的是**每条目成本** 2.4µs/项，据此外推单层十万项约 240ms——⚠️ **线性外推不是实测**。
> - **两半共同欠的一次**：真·端到端。`start_search` → batch/heartbeat → done 这条链**从来没有对着一个真的 `AppHandle` 跑过**，测试里的事件全是手工触发的；侧边栏的虚拟化滚动手感同理。这两件都要靠 `./restart.sh` 起真 app 才能结。
>   ⚠️ **M2-D 之后这条债变长了，没有变短**：`start_replace` → progress → done 是同一种「事件全靠手工触发」的测试，而它是本项目里**唯一一条会改用户磁盘**的链——真机上要量的除了「跑不跑得通」，还有**落盘那一遍在一个大仓库上到底要多久**（预览是只读的、可以随便重来，落盘不行）。这个数现在一个都没有。
>   ⚠️ **M2-E 又加了一笔，而且它是这条验收的正中靶心**：`index_project` **每次展开浮层都无条件重建索引**（改判见下面「M2-E 实施修正」1），所以「10 万+ 文件的仓库上按一次 `Cmd+P` 要等多久」这个数，比搜索那两笔更直接地决定这条验收算不算过。现在一个都没有。
>   ⚠️ **M2-F 让这笔变贵了，不是变便宜**：多根之下 `rebuild_indexes`（`src-tauri/src/commands.rs:796`）是**逐个根串行重建**的——刻意不并发，理由是三个大仓库同时建会把 blocking 池占满，而 `open_file` / `save_file` / `list_dir` 也跑在上面（那段注释里有原文）。于是「10 万+ 文件」这个数现在要乘上根的个数：三个大仓库的工作区按一次 `Cmd+P`，最坏是三倍耗时。而浮层此刻画的是 MRU，用户**看得见**候选、看不见慢——所以这笔债比 M2-E 那笔更容易被漏掉。**要量的是「N 个十万文件的根」，不是「一个」。**
>   ✅ **M2-G 是唯一一个没往这笔债上加东西的 M**，而且是刻意不加的：文件监听盯的是**打开着的那些文件的父目录**（上限 256 个），⛔ 不是项目树，所以「10 万+ 文件」这个规模与它无关——一个装了十万文件的仓库里只开着三个文件，就只订三个目录。它自己那一份真机债（FSEvents 端到端延迟、漏事件率、符号链接、Vela 自己 ⌘S 弹不弹）另记在下面「M2-G 实施修正」17，⚠️ 与本条验收**不是同一件事**，别把两笔并成一笔勾掉。
>   ⚠️ **M2-H 又加了一笔，而且它加在「搜索」那一半上**：`MAX_FILE_BYTES` 从 10 MiB 抬到 **64 MiB**（修正 3）之后，「首批结果 < 2s」这个判据的最坏情况变了——一次搜索里可能夹着一个 64 MiB 的文件，扫它一趟按线性外推 ≈55ms。**这个数是外推的，不是复测的**：实测只在 10 MiB 上做过（6.9–8.5ms）。要结这笔债，得在一个真有 10 万+ 文件、且**其中至少一个几十 MB** 的仓库上跑一次真机搜索，看首批延迟与心跳间隔。另外「64 MiB 规模的替换」同样一个数都没有——替换要把整份读进内存，峰值约两倍文件大小，那正是 64 MiB 这个数被选中而不是 256 MiB 的理由（修正 3），**而这条推理从来没在真机上被验证过**。
>   ⚠️ **M2-H 自己那一份真机债与上面两笔都不是一回事**，另记在「M2-H 实施修正」12：`open_shard` 建索引的**冷读**耗时（尤其网络卷）、一个真·大文件（压缩过的单行 JSON、一行一条记录的日志导出）端到端打开、`MAX_PAGE_BYTES` 撑爆的那一段锚点在真 WKWebView 里的占位与自愈、整个 `ShardPane` 的视觉与手感（18px 行密度、7–9 位行号的 gutter 对齐、18px 行里塞 13px 字、长行省略号、只读头部条、从日志里选中复制）、以及**分片被聚焦时的分屏/合并/切焦点**（`Mod+\`、`Mod+Shift+\`、`Mod+Alt+←→` 与三个工具栏按钮）与**在分屏里关掉一个分片标签**（那条走 `removeFromList` 的 `batch()` 路径，修正 7）。

> **M2-A 实施修正**（2026-09-17，文件树 Rust 侧交付时踩出来/改判的，按重要性排）：
>
> 1. 🔴 **`ignore::WalkBuilder` 遵守 .gitignore 这条被推翻了，改成不过滤——而且性能方向是反的。** 这是用户在「树里不过滤 / 显示并置灰 / 照过滤并改 PLAN 措辞」三选一里选的第一项（Sublime 与 VS Code 的默认行为）。三条依据：
>    - **实测对照**（本仓库、Apple Silicon、dev 构建、三次连跑取区间）：
>      | 层 | 条目 | `WalkBuilder`（过滤） | `read_dir`（不过滤） |
>      |---|---|---|---|
>      | 顶层 | 25 | 5.14ms | **79~115µs** |
>      | `crates/vela-core/src` | 4 | 599µs | **27~36µs** |
>      | `node_modules`（21 个符号链接） | 23 | 779µs | **120~134µs** |
>      | `node_modules/.pnpm`（本仓库最宽的一层） | 289 | 8.76ms | **698~732µs** |
>      过滤让顶层慢了 **45×**：它省下的是「按需列举本来就没花的钱」，而自己得先把 .gitignore 链（仓库级 + 全局配置 + `.git/info/exclude`）读一遍、编成 regex set。
>    - **PLAN 自相矛盾**：第 2 项要求 `node_modules`/`.git`/`dist`「默认折叠」，这句话预设它们**可见**；而第 1 项的过滤会让其中两个压根不出现在顶层（实测顶层 22 项里没有 `dist`/`node_modules`/`target`，只有 `.git` 活着），第 2 项就无从实现。
>    - **代价是实的**：`dist/index.html`（刚 build 完想看一眼）与 `node_modules/@codemirror/view` 的类型声明正是 Vela 目标用户最常开的东西，滤掉之后只能退回「打开对话框」或 `Cmd+P`。
>    - ⚠️ **全局搜索是另一回事，M2-C 那边一律过滤**：搜索要把每个文件的正文都读一遍，不过滤就等于 grep 十万个依赖文件。`ignore` 依赖已从 vela-core 摘掉（留着一条没人用的依赖等于让 manifest 说假话），M2-C 会把它加回到搜索侧，**并且要有一条与 `gitignore_命中的条目照常列出` 方向相反的测试**——两条测试方向相反不是写错了，是两处的权衡本来就不同。
>    - ⚠️ **一个诚实的例外**：`node_modules` 那一层**首次**展开量到 3.24ms，之后才落回 120µs。那是 21 个 pnpm 符号链接第一次被 stat 时的冷缓存，与过滤无关。
> 2. **IPC 面定成 `list_dir(root, rel)` 而不是 `list_dir(path)`，是为了让逃逸在结构上不可能。** `rel` 含 `..` 或本身是绝对路径时直接拒绝，压根不去拼路径。换成「前端传绝对路径 + Rust 侧检查它在不在 root 下面」也能做，但那是一个需要逐次审计的**判断**，而这里是一个不需要判断的**形状**。代价是 `DirEntry` 里 `rel` 与 `path` 冗余（`path` = root + `rel`），这个冗余是刻意买的：**前端因此永远不需要做路径拼接**，也就不会在分隔符、大小写、末尾斜杠上犯错。
> 3. **符号链接是有意放行的**（`resolve` 只挡词法逃逸，指向 root 外面的链接仍能展开）。不是漏洞：pnpm 的 `node_modules` 整个是符号链接搭的（本仓库 879 条），挡住等于让本项目的文件树不能用；而 `open_file` 本来就接受任意绝对路径，放行链接没有扩大任何一类信任面。`is_dir` 对链接必须 stat 一次才能判——遍历拿到的 `d_type` 只知道「这是个链接」。
> 4. **原写的「类型分组」排序没做**，只做了「文件夹优先 → 不区分大小写的名字 → 字节兜底」。理由：Sublime / VS Code / JetBrains 三家都没有按扩展名分组，它会让「找同名的 `.ts` 与 `.test.ts`」变成跨组扫视；而 PLAN 自己的约束里就写着「不用堆功能」。要是将来有人要，那是 `.vela/settings.json`（🔴 **已从 M2-F 推到 M4**）里的一个开关，不是默认行为。
> 5. ⚠️ **排序的「平局按字节」那条只能用合成数据测。** 第一次写成「建 `foo`/`Foo`/`FOO` 三个真实文件」，在本机只留下了一个——macOS 默认卷大小写不敏感，三者是**同一个文件**。而 Linux 与 macOS 的「区分大小写」卷上平局确实会发生，那时少了字节兜底，顺序就跟着 `read_dir` 漂（同一棵树刷新两次长得不一样）。修法是把比较器提成 `sort_entries()` 单独测。**教训：一个测试如果依赖文件系统的某个可选属性，它在那种属性下会静默地什么也没测。**
> 6. ⚠️ **信任面扩大了一类，不只是多了一个命令。** `open_file` 给的是「读一个已知路径的文件」，`list_dir` 给的是**枚举**——不知道路径也能一层层翻出来。两条缓解：`rel` 结构化防逃逸（见 2）、`root` 只可能来自 dialog 插件（`directory: true`），前端没有任何输入框能填它。但 `tauri.conf.json` 的 `csp` 仍是 `null`，所以这条前提只靠「不加载远程内容」这个约定撑着。**M5 开放插件时必须换成「dialog 打开过的 root 记在 Tauri managed state 里，命令只收 `rootId`」**——这句话已经写进 `src-tauri/src/commands.rs` 的文件头。
> 7. **契约测试分成两半，缺一不可**：手搓的 `DirListing` 字面量钉**字段名与顺序**（不能用 `list_dir` 的真实输出，`path` 落在 `tempfile` 的随机目录里，做成字面量这个测试自己就会漂）；另一条 `列举结果的_path_与_rel_都以_name_结尾` 用真实列举钉**字段之间的关系**。只有前一半的话，两边可以全绿而 `list_dir` 依然发出 `path` 与 `name` 对不上的数据——那正是前端把 `path` 交给 `open_file` 时会炸的形状。
> 8. **验收判据只拿到 1/5 规模的下界证据，还不能结。** 本仓库 22709 个文件（不含 `target/`），判据要的是「10 万+」。已实测的是**每条目成本**：289 项 / 698µs ≈ 2.4µs/项，所以单层一万项约 24ms、十万项约 240ms——⚠️ **这是线性外推不是实测**。按需列举让「仓库总文件数」与成本脱钩，唯一能伤到它的是「单层条目数极大」。**判据要等 M2-B 的 UI 落地后，拿一个真实的 10 万+ 文件仓库再量一次**（连带量虚拟化列表）。
> 9. **数字**：Rust 测试 90 → **108**（vela-core lib 75 → 90，其中 `project::tree` 15 条；wire_contract 14 → 17）；前端 495 → **506**（23 个文件，新增 `src/ipc/project.test.ts` 11 条）；七道门禁全绿；首屏 gzip **235.01KB 不变**（`src/ipc/project.ts` 还没有任何 import 者，被 tree-shaking 整个摇掉了，三个产物文件名哈希与 M1-H 收尾时逐字节相同）。

> **M2-B 实施修正**（2026-09-17，文件树前端 M2-B-1~4 交付时改判/踩出来的，按重要性排）：
>
> 1. 🔴 **`node_modules`/`.git`/`dist`「默认折叠」这条要求被删掉了，不是实现了也不是绕过了。** 用户原话是「**承认失效，删掉这条**」。失效的原因是 M2-A 的懒加载把这个需求的前提抽走了：树是**按需**列举的，一个层在摊开之前压根没被读过，所以「默认状态」本来就是全收起——`node_modules` 也好 `.git` 也好，除非用户亲手点它，否则一行都不会出现。这条要求预设的是「树是预先建好、默认全展开、再挑几个收起来」那种实现，Vela 不是那种实现。留着它等于让 PLAN 里有一条永远为真、因此永远测不出任何东西的验收项。
>    - 顺带把 M2-A 修正 1 里「第 2 项要求默认折叠、第 1 项的过滤让它无从实现」那个矛盾结清了：**矛盾双方现在都不在了**。不过滤，也不默认折叠。
> 2. 🔴 **右键「删除」改成「移到废纸篓」，用 `trash` crate（5.2.9，MIT，已核）。** 用户在「真删 / 移到废纸篓 / 只给菜单不实现」里选的第二项。理由不是怕误删那么简单：**Vela 的目标用户是开发者，而开发者删掉的常常是 `git` 管不着的东西**——`.env`、本地 build 产物、没进版本库的草稿。真删的话一次手滑就没有第二次机会，而废纸篓给了一个与「Cmd+Z」同一量级的后悔药。代价是 `trash` 这个依赖（走 `objc2`/`cocoa-foundation` 那条 macOS 路径），以及删除不再是原子的 O(1) `remove_file`。
>    - ⚠️ **提示语要说「已移到废纸篓」，不能说「已删除」。** 措辞不对，用户会去找那个不存在的确认撤销，或者反过来以为文件真没了。
> 3. **「在 Finder 中显示」与「复制路径」调 macOS 自带命令，零新依赖。** 用户原话「**调 macOS 自带命令**」：`open -R <path>` 与 `pbcopy`（路径走 stdin）。两条都比自己实现好——`open -R` 会顺带选中那个条目并处理「父目录已不存在」的情形，`pbcopy` 直接接系统剪贴板，不用碰 Tauri 的 clipboard 权限。
>    - ⚠️ **这两条是 macOS-only 的，将来上别的平台要加 `#[cfg]` 分支**而不是「找等价命令」——`xdg-open`/`explorer` 的选中语义与 `open -R` 不同，直接换会把「显示并选中」降级成「打开目录」。M2 的目标平台是 macOS 优先，所以这笔债是明写的、不是被忽略的。
> 4. 🔴 **加了 `Session.project` 但 `SESSION_VERSION` 仍然是 1。** 这不是漏改：新增的是一个**可选字段**，两个方向都能自己降级——旧存档喂给新 Vela，`Raw::project` 带 `#[serde(default)]`，缺 key 解析成 `None`（= 上次没打开文件夹，语义正确）；新存档喂给旧 Vela，serde 默认忽略未知字段。这条论证**只对「新增可选字段」成立**：改一个字段的含义、删字段、收紧 `validate`，三件事都必须升版本号。论证写在字段文档里，而真正判它成不成立的是一条测试（`缺少_project_键的旧存档照常解析`）——它用「从当前序列化结果里把 `project` 那段字符串抠掉」的办法造旧字节，而不是另写一份手抄字面量，所以旧形状不会跟着代码漂。
>    - 同一个决定里还有一条反向选择：**刻意不用 `#[serde(skip_serializing_if = "Option::is_none")]`。** 用了它，「没打开文件夹」在线上就变成了「没有这个键」，与「字段名拼错」长得一模一样，而契约测试也就没有一个稳定的键可以钉。永远序列化出来，`None` 写成 `"project":null`，前端那边的类型相应地写成 `| null` 而不是 `?:`。
> 5. ⚠️ **`expanded` 的条数上限只有一处，在前端（`src/project/store.ts` 的 `MAX_RESTORED_EXPANDED = 512`）。** 原计划在 Rust 侧也加一个 `MAX_SESSION_EXPANDED`，读完 `store.ts` 发现已经有了，于是**放弃**两边各截一次。理由：这条上限管的成本是「每条 `rel` 一次 `list_dir` 往返」，那是**前端的启动成本**；Rust 侧该管的是 4MiB 的 payload 预算，而 `MAX_SESSION_BYTES` 已经在管了。两处各截一次的结果是「谁也说不清最终生效的是哪个数」。这个「刻意不加」被一条测试钉住（`展开列表原样往返不在_rust_侧截断`，900 条原样回来），否则将来有人顺手加上去，两边就悄悄开始打架。
> 6. ⚠️ **`sessionSync` 的 `lastSent` 是「上一次写出去的指纹」，不是「见过的状态集合」——所以 A→B→A 会写三次，这是对的。** 我一开始把测试写成「摊开再收起，应该只写两次」，跑出来三次，去查代码，**错的是我的前提不是代码**：收起之后磁盘上的存档仍然写着 B（摊开那个状态），不写第三次就会把一份过期的现场留在盘上。三次写、第四次空转不写，这才是正确形状。
>    - **教训**：把「去重」理解成「见过就不再发」是缓存的语义，而这里是**镜像**的语义——目标不是少发几次，是让盘上的东西等于内存里的东西。
>    - 同一层的另一条：指纹必须在**两半拼接之后**算。`workspace.serializeSession()` 的 `project` 恒为 `null`（workspace 不知道项目树存在，是 sessionSync 把它覆盖上去的），算早了就只覆盖标签页那一半，摊开/收起文件夹永远不会触发写。这条由 `只摊开一层（不动任何标签）也会触发一次写` 钉住。
> 7. **恢复时两半是 `Promise.all` 并行装的，侧边栏自动展开。** 两个 store 互不依赖，串起来等于把两笔启动开销相加而不是取最大值。存档里有 `root` 就把侧边栏打开——树恢复好了却看不见等于没恢复；而 `openFolder` 里那条「对话框取消就不显示侧边栏」的判断在这儿**不适用**，这次不是用户刚点了什么，是他上次的现场。
> 8. ⚠️ **存档里那一层已经被删掉时，树里不会出现红色的错误行——这是正确行为，不是漏了。** 第一版测试断言「那一行要带错误」，跑挂了。查下去：`flattenRows` 是从 `listings` 生成行的，一条存在于 `expanded` 却读不出列举的 `rel` **根本没有行**可以挂错误。而 `errors` 映射照常记了它，一旦那层重新出现在某个父列举里（用户把文件夹建回来了），错误就地显示。测试改成了断言「别的层照常恢复、不产生任何警告」，并把「为什么没有红行」写在测试名里。
>    - **教训**：一个状态的**可见性**取决于它有没有对应的行，而行的来源是列举结果不是展开集合。把错误挂在一个可能不存在的载体上，等于错误只在某些时候可见。
> 9. **数字**：Rust 测试 108 → **113**（vela-core lib 90 → 94，wire_contract 17 → 18；vela bin 1 条不变）；前端 625 → **641**（26 个文件）；七道门禁全绿；首屏 gzip 238.24KB → **238.30KB**（`index-FWf3HCHu.js` 128.15 + `dist-GyccKmKx.js` 108.31 + `index-By4GtNX2.css` 1.84），预算 300KB。⚠️ M2-B-1~3 那 116 条前端测试把首屏抬了 3.23KB（235.01 → 238.24），M2-B-4 只加了 0.06KB——会话存档这一半几乎不进产物，因为 `serializeState`/`restoreState` 本来就存在，只是被接到了 `sessionSync` 上。

> **M2-B-5 实施修正**（2026-09-17，右键菜单 + 五个文件操作交付时改判/踩出来的，按重要性排）：
>
> 1. 🔴 **「移到废纸篓」不问「确定吗」——确认对话框是刻意不加的，不是漏了。** 三条理由叠在一起：(a) 动作本身可挽回，废纸篓就是那个后悔药，再问一次等于把后悔药包在另一层后悔药里；(b) Finder 与 VS Code 删到废纸篓都不问，问了反而是「不像系统里的东西」；(c) 每次都问的对话框，用户几天之内就会养成反射性回车的习惯，那时它既没省下点击也没拦下任何一次误删，只剩一个每次都要多按一下的回车。这条与用户既有的两条偏好同向：「宁可删功能也不加交互复杂度」、「反向操作给最小视觉重量」。
>    - ⚠️ **真正的安全网是提示条上那句话，不是颜色也不是对话框**：「已把「x」移到废纸篓，可以在 Finder 的废纸篓里找回」。菜单项本身刻意不做成红色——菜单里每一项都是用户主动叫出来的，把其中一项画成危险会让整条菜单看起来不可信（这条理由写在 `TreeMenu.tsx` 的文件头）。
>    - **这个决定被一条测试钉住**（点完「移到废纸篓」之后断言 `maybeModal()` 为 `null`）。钉的是决定不是代码：将来有人顺手加一个确认框，现有用例会当场红，他就得先读这一段再决定。
> 2. ⚠️ **根行的菜单里没有「重命名…」也没有「移到废纸篓」。** 那两项落在根行上的含义是「把用户整个项目文件夹改名」与「把整个项目文件夹扔进废纸篓」——不是不能做，是不该出现在一个右键文件树的菜单里。
>    - **规则放在纯函数层（`tree.ts` 的 `menuFor`）而不是渲染时写个 `<Show when={row.rel !== ''}>`。** 改一次渲染就能把后者改掉，而 `store.trash('')` 里那道拦截只是最后一道网：网兜住的是「没做成」，兜不住「菜单上摆着一项吓人的东西」。两层都要有，但它们防的不是同一件事。
> 3. 🔴 **一个真 bug，被自己写的测试抓出来：右键第二行时菜单的内容换了、位置没换。** `<Show when={menu()}>` 在两次右键之间前后都是真值，Solid **复用**同一个 `TreeMenu` 实例，`onMount` 不会重跑——而贴边回推（`clamp`）当时只在 `onMount` 里算。于是菜单留在上一个光标的位置上，指着另一行。
>    - 真实浏览器里被 mousedown → contextmenu 这个顺序**掩盖**了：mousedown 先把菜单关掉，contextmenu 再开一个新的，实例是重建的。Ctrl+Click、以及任何只发 `contextmenu` 的路径都会露出来。
>    - **修的是组件不是测试**：`onMount(clamp)` → `createEffect(() => clamp(props.x, props.y))`，坐标做成参数传进去（读要发生在追踪范围里面）。
>    - **教训**：`<Show>` 的 when 保持真值时子组件不重建，任何「从 props 算一次」的东西都必须放进 `createEffect`，或者用 `<Show ... keyed>` 强制重建。名称对话框那一处就是用 `keyed`（`prompt()` 每次都是整个换掉的新对象）。
> 4. **五处 `solid/reactivity` 报警全部按根因改掉了，没有用 eslint-disable 压。** 报警的共同形状是「一个闭包读了 `props.X`，而这个闭包被交给了一个不追踪的地方」：(a) `TreeMenu` 的 `props.x/y` → 变成 `clamp` 的参数、`createSignal` 的初值包 `untrack`；(b) `runOp` 的成功回调 → 第二个参数从 `onSuccess?: () => void` 改成 `okText?: string`（那句话只取决于点的是哪一行，进函数之前就算得出来，没必要做成回调）；(c) JSX 属性上的 async 箭头 → 提成具名的 `closing()`，`<Show ... keyed>` 直接把 `cfg.onSubmit` 传下去；(d) `props.onNotice` → 解构成局部常量，沿用既有的 `const tree = props.tree` 约定；(e) `pick` 里的 `menu()?.row` → 做成显式的 `row` 参数。
>    - **为什么值得逐条改而不是加 disable**：这条规则在这五处报的都是同一件事——「这个值到底该不该跟着 props 变」，而五处的答案分别是「该（3）」「不该（b、e）」「一次性初值（a）」「引用恒定（d）」。用 disable 压掉的话，第 3 条那个真 bug 与另外四处看起来就一模一样了。
> 5. ⚠️ **`pbcopy` 写完必须把 `child.stdin` 显式置成 `None`。** 只 drop 那个 `&mut` 借用**不会关闭管道**：`pbcopy` 在等 EOF，而我们在 `wait()`，两边互相等——UI 冻住，且没有任何日志。这类「写完就等」的子进程调用都要检查一遍 stdin 的所有权。
>    - 同一条里的另一半：**一律 `Command::arg()`，绝不 `sh -c`。** 文件名来自用户的磁盘，引号、`$`、反引号都是合法字符；走 shell 就是把一次「复制路径」变成一次命令注入。
> 6. **数字**：Rust 测试 113 → **137**（vela-core lib 94 → 116，wire_contract 18 → 20；vela bin 1 条不变）；前端 641 → **714**（仍 26 个文件，`Sidebar.test.tsx` 35 → 67、`tree.test.ts` 42 → 48）；七道门禁全绿（`pnpm lint` 从 5 条报警回到 **0**）；首屏 gzip 238.30KB → **240.61KB**（`index-DqowTMtv.js` 130.31 + `dist-GyccKmKx.js` 108.31 + `index-DiXbeY5y.css` 1.99），预算 300KB。
>    - ⚠️ **jsdom 钉不住的两样，写在这里当债**：菜单贴边回推的**另一半**（`window.innerWidth - rect.width`，jsdom 的 `getBoundingClientRect()` 全是 0，只能钉住「没被推出视口」这一半）；以及 `open -R` / `pbcopy` / `trash` 这三个 macOS 系统调用本身——桩能验「前端把话说对了」，验不了「Finder 真的跳到那一行」。

> **M2-C 实施修正**（2026-09-17，全局搜索 M2-C-1~4 交付时改判/踩出来的，按重要性排）：
>
> 1. 🔴 **两条真实的竞态，都不是「加个 if 判一下 taskId」能挡住的。** 认任务用的是三个变量而不是一根指针（`src/search/store.ts` 的模块文档里有完整推导）：
>    - **第一条：`listen` 本身是异步的，注册之前到达的事件永久丢失。** 所以三个搜索事件在 **App 挂载时挂一次、挂着不放**，不是每次搜索挂一遍。这条由 `App.test.tsx` 的一条用例钉住（断言四个事件名都在 `listeners` 里）。丢掉的偏偏是最前面那几批，表现是「共 87 处」与列表里的条数对不上——一个没有任何报错可查的静默漏数。
>    - **第二条：终止事件可能比 `start_search` 的返回值先到。** `start_search` 是先 spawn 后台线程再返回 taskId 的，而本仓库 107 个文件整次搜索只要 **12.7ms**——完全可能 `search-done` 已经躺在事件队列里了，前端手上却还没有 taskId 可以拿它去对。朴素写法（`if (taskId !== current()) return`）在这里会**把整次搜索的结果全丢掉**，面板永远停在「正在搜索…」。
>    - 于是有了 `adopted`（当前认下的 id）/ `starting`（invoke 已发出还没回，这个窗口里到达的任何未作废 id 都认下来）/ `retired`（明确作废过的 id，被取消的旧搜索还会继续推几批）。**只有 `retired` 能挡住旧批次，只有 `starting` 能接住早到的批次，缺一条都是错的。**
> 2. 🔴 **心跳批是被实测逼出来的，不是「顺手加个进度」。** 批次以「有命中的文件」为单位，于是**没有命中就没有批次**。实测（十万个文件、外部卷、release）：
>    | 场景 | 首批延迟 | 总耗时 |
>    |---|---|---|
>    | 有 2000 处命中 | **65.6ms** | 6.93s |
>    | 一个都不命中 | **7.14s** | 7.14s |
>    第二行是全部理由：「搜一个不存在的词」恰恰是全文搜索最常见的操作之一，而那 7 秒里前端既不能显示进度也不能说「没找到」，看起来就是卡死。解法是让 `SearchBatch` 允许 `files` 为空——那是心跳，只带累计的 `files_scanned`；两条阈值取先到者（每 `HEARTBEAT_FILES=256` 个文件，或距上次推送过了 `HEARTBEAT_MS=250`），于是前端最多 250ms 或 256 个文件收不到信号，**与仓库里文件的平均大小无关**。
>    - 加心跳之后同一棵树复测：**第一个信号 33.75ms**（快了约 218 倍），全程 390 次心跳，相邻两次最长静默 **40.3ms**，总耗时 7.35s 基本没变（390 个几十字节的批次对 7 秒的遍历是噪音）。
>    - 有命中那一侧也量了：首个结果 52.9ms、125 个批次、**0 次心跳**、最大间隔 800 个文件、最长静默 69.5ms、总耗时 6.72s。单个 10MiB 文件（= `MAX_FILE_BYTES` 上限）从头扫到尾 **6.9–8.5ms**（3 次），所以「压着结果时撞上一个慢文件」那个空洞有界。
>    - **前端的规则因此是：`files` 为空时只更新进度，不要动结果列表，更不要把它当成「搜索结束了」。** 结束的唯一信号是 done 事件。把它当成「没有结果」的话，十万个文件那 7 秒里面板会先闪一次「没有找到」再出结果。
> 3. 🔴 **二进制文件与非 UTF-8 文件长得像，处理方式必须相反。**
>    - **含 NUL 的（二进制）**：`quit(0)`，见到 NUL 就收手。⚠️ 这一条是**显式配上去的，不是继承来的默认值**——`Searcher::new()` 拿到 `\x00\xff\nneedle\n` 照样把 `needle` 报出来，钉这件事的测试在配上它之前是红的。不猜第三方库的默认值，是因为猜错的失败方式很安静：搜索结果里混进 `.woff2`、`.png`、`pack-*.idx`，而它们全都「看起来像个文件」。
>    - **不含 NUL 但也不是 UTF-8 的（GBK 之类）**：走 `sinks::Lossy`，非法字节换成 U+FFFD 继续搜。用 `sinks::UTF8` 的话这个文件会让 `search_path` 报错，于是被计入 `unreadable` 而**一条命中都不报**——用户搜一个明明在文件里的标识符，得到「0 个结果」加一句「有 1 个文件读不出来」，而那个文件正是他要的。Vela 的目标用户会打开 GBK 文件（`fs` 那边专门做了编码探测），这不是边角情况。
>    - **两条各有一个诚实的限制，都记在钉住它们的测试上**：Lossy 换来的是「ASCII 搜索词（标识符、URL、错误码）在 GBK 文件里照样命中」，代价是**中文搜索词搜不到非 UTF-8 文件里的中文**（字节序列不同，要支持得先按探测出的编码把整个文件解码一遍，那是另一件事）；`quit` 的收手粒度是按 `grep-searcher` 的读缓冲来的（我们不依赖它的具体位置，测试只区分「第一个缓冲内」与「远在后面」），而 `search_path` 返回 `()`、给不出「有没有搜完」的信号，所以被收手的文件 `truncated` 仍然是 false。要修得自己实现 `Sink` 接 `binary_data` 钩子，而 `Lossy` 里那套行号簿记重写一遍很容易出错——记在这儿，不是忘了。
> 4. **取消是协作式的，所以「取消」按钮不清结果、`cancel()` 也不动状态。** 后台线程要跑到下一次检查标志才知道要停，其间还会推几批——那些批次**仍然有效**。点「取消」的用户表达的是「别再搜下去了」，不是「把已经搜到的也扔掉」；随后 done 事件里 `cancelled` 为真，由它收尾。这里自己把 `running` 置假的话，那一批迟到的结果会落在一个「已经结束」的面板上，用户看到的是数字自己在动。
>    - ⚠️ **`cancel_task` 是同步命令，这是被 Tauri 的规则逼的**：*async commands that contain references as inputs must return a `Result`*，而 `State<'_, T>` 算引用。要么返回 `Result`、要么去掉 async——取消只是置一个原子标志，本来就不需要 async。（M2-C 时它叫 `cancel_search`，M2-D 落盘那一轮复用同一个注册表与同一个命令，名字随之改成中性的 `cancel_task`。）
>    - ⚠️ **一条已知没测的路径**：搜索在**文件中途**被取消时，那个文件已经攒了一半的命中会被整个丢弃（不是推出去）。这是正确行为（半份文件的命中没有意义，批次的单位是文件），但没有测试钉住它——要钉就得让取消恰好落在一个文件的中间，而那需要控制遍历时机。
> 5. **流式推送是三个事件 + 单线程遍历，两个都是刻意的。**
>    - `search-batch` / `search-done` / `search-failed`。PLAN §2.6 约束 1 与 3：单次 payload 上限 4MB、长任务一律 taskId + event。一次搜索在十万文件仓库上可以产出上万条命中，一次性回传既撞 4MB 也撞「首批 < 2s」。批次的单位是**文件**：一个文件的命中只有扫完它才齐，而 UI 按文件分组。
>    - **单线程 `build()` 而不是 `build_parallel()`**（ripgrep 用的是后者）：① 取消与截断都是「走到哪儿停到哪儿」，并行版要额外协调谁先停；② **结果顺序确定**，同一棵树搜两次长得一样，测试才写得出来；③ 流式推送让有命中时的「首批 < 2s」不依赖总耗时。真要提速，换 `build_parallel` 是一个局部改动。
> 6. **按文件分组只体现在「行的顺序」上，不建父子指针。** 一次搜索最多 20000 条命中（`MAX_HITS`）。平铺成一张表，用户看到的是两万行里同一个文件名重复几十遍；按文件分组则文件名只出现一次，而且「这个文件里到处都是」一眼就看得出来。但扁平数组 + 定高行是 `visibleWindow` 那套 **O(1) 窗口算术**的前提，一旦引入嵌套就得算前缀和。缩进靠 CSS 的 padding 表达。
>    - 复用而不是另写：`resultWindow` 直接调 `project/tree.ts` 的 `visibleWindow`，它的算术只依赖「定高行 + 总行数」，与「行是树节点还是搜索结果」无关。只有行高不同（`RESULT_ROW_HEIGHT = 20`，刻意比文件树的 22 小：结果列表一屏要装的东西更多）。它现在住在 `project/` 下面是**历史顺序不是归属判断**，M2-E 的 Goto Anything 会是第三个消费者，到那时再抽成共享模块——现在抽是给一个还不存在的第三方让路。✅ **M2-E 已抽**：算术搬进 `src/ui/virtual.ts`，三个列表共用；行高仍是每个列表自己的常量（见「M2-E 实施修正」6、14）。
>    - ⚠️ 摊平是**增量**的：每批只处理新到的那一批，调用方 append。从头重摊的成本是 O(批次 × 总行数)——二十个文件一批、一万条命中就是五百批 × 两万行 = 一千万次对象构造，而这五百批是在几秒里连着到的。顺带保住一条渲染性质：已摊出来的行对象**引用不变**，`<For>` 靠引用相等把 DOM 原样复用。
> 7. ~~上下文预览~~ **改判成只显示命中那一行本身，没有上下各 N 行。** 三条理由：① 底部面板一行只有 20px，装不下三行预览，要装就得让行高变成可变的，那会当场废掉上面第 6 条的 O(1) 窗口算术；② 上下文预览在**流式**推送下没有额外成本，但它的价值在「判断这一处是不是我要的」，而点一下就能跳过去看，比在 20px 的行里读三行截断的正文有效；③ `MAX_PREVIEW_BYTES = 1000` 已经在管「一行有多长」，再管「几行」是两个方向的上限叠在一起。这笔债是明写的：**要加上下文预览，得先把虚拟滚动改成变高行**。
> 8. ⚠️ **两个用户决定，都是「少做」的方向。**
>    - **面板放窗口底部**（在「底部面板 / 右侧面板 / 覆盖式浮层」里选的第一个）。宽度等于窗口宽度，所以 `rel + 行号 + 命中行正文` 能在一行里放下；代价是占掉编辑区高度，于是它必须一键可收起（`Esc` 与头部那个 `×` 都行，收起时状态一律留着——重新展开该看到上次那份结果）。
>    - **第一版只放搜索词 + 三个开关**（字面量 / 区分大小写 / 整词），`include`/`exclude` **Rust 与 IPC 两侧都实现了、UI 刻意不暴露**。前端连那两个 key 都不发：Rust 侧容器上有 `#[serde(default)]`，缺 key 就是「不限」，前端替它补两个空数组等于把默认值抄两份，哪天那边改了默认两边就悄悄分岔。
> 9. ⚠️ **命中偏移量是 UTF-16 码元，不是字符也不是字节。** 这不是顺手抄了 JS 的习惯，而是因为**消费方是 CodeMirror**：它的位置就是 UTF-16 码元偏移。Rust 侧发字符偏移的话前端得再转一次，而那次转换的失败方式是「高亮画错一个字」——在含 emoji 或 CJK 扩展区（`𠀀` 这类，一个字符两个码元）的行上必错，而错得很安静。在产出偏移量的那一侧一次算对，比在消费侧到处补转换便宜。
> 10. **每一个 `SearchError` 都发生在第一批结果之前——这是刻意维持的性质。** 编译正则、编译通配、检查 root 三件事全在遍历开始之前做完（`preflight` 与 `search` **共用 `check_root`（`search/run.rs:351`）与 `compile`（`search/run.rs:364`）两个函数**，所以「reject 了就是压根没开始」这条规则不是靠两处各写一遍来维持的）。⚠️ **本条原文写的是「共用一份 `prepare` 实现」，那个函数已经不存在了**：M2-F 把它拆成两半——多根之下「检查」要做 N 次而「编译」只做一次，摊在一个函数里就只能逐根重编，那会让「预览与落盘用同一台匹配机」从「同一个对象」退化成「N 个内容相同的对象」（`run.rs:346` 那段注释里有原文）。拆开的代价是那个 `for root in roots { check_root(root)? }` 循环**在三处各写一遍**（`preflight_roots`、`search_roots`、`replace.rs` 的 `preflight_apply_roots`），一致性不再靠结构、改由用例 `preflight_roots 与 search_roots 在多根下也必须给出同一个错误值`（`run.rs:1659`）钉住。于是前端的规则可以很简单：`start_search` reject = 这次搜索没开始、不会有任何事件、不需要作废谁；收到了 event = 搜索开始了，剩下的只会是 done。遍历途中的单个文件读不动**不是**错误：它计入 `SearchSummary::unreadable`，搜索继续——整次搜索失败比少搜一个目录糟得多。
>    - ⚠️ 而 `unreadable > 0` 那句话是**整个面板上最重要的一句话**：它意味着「没有找到」可能是假的。所以它单独一行、单独用警告色，**刻意不混进总账那一行**——混进去的话它跟在一串数字后面，用户扫一眼只看到「共 0 处」就走了，而那一串数字里恰恰藏着「这个 0 可能是假的」。
> 11. ⚠️ **搜索侧的 `.gitignore` 与符号链接规则都与文件树相反，两边各有一条钉住自己方向的测试**（树那边 `gitignore_命中的条目照常列出`，这边 `gitignore_命中的文件不搜`）。**两条测试方向相反不是写错了，是两处的成本结构不同**：树是按需的，过滤省下的是本来就没花的钱，自己却要先读一遍 .gitignore 链、编成 regex set（实测顶层慢 45×）；搜索要把每个文件的正文都读一遍，不过滤就等于 grep 十万个 `node_modules` 里的文件。符号链接同理：树放行（pnpm 的 `node_modules` 整个是链接搭的），搜索 `follow_links(false)` 且只搜 `file_type().is_file()` 的条目——跟着链接走会把同一个包读几十遍，还可能成环。
>    - ⚠️ 一个会咬人的细节：**`ignore` 即使 root 是一个子目录，也会应用它父目录里的 `.gitignore`。** 这不是 bug，是 `git` 自己的语义，但「我明明把搜索根指到了 `src/`，为什么这些文件没被搜」的排查会从这里开始。
>    - ⚠️ `globset` 的 `*` **跨过** `/`（`literal_separator` 默认关）。所以 `include: ["*.ts"]` 会匹配 `src/a/b.ts`，这与 shell 的 glob 直觉相反。不猜默认值，钉在测试上。
> 12. **单文件上限的判据是「超过」而不是「达到」。** 一个正好 500 行命中的文件**不算**被截断——「达到就报截断」会让它被标成「还有更多」，而它其实已经扫完了。代价是多扫一行：在 `MAX_HITS_PER_FILE + 1` 行时才停。留下的永远是**最前面**的 500 条。
> 13. **taskId 单调递增、永不复用。** 复用的话 `retired` 会把新一轮的批次当成「已作废任务的迟到批次」丢掉，而那种失败在 UI 上就是面板卡在「正在搜索…」。测试桩里也必须照做（`App.test.tsx` / `FindInFiles.test.tsx` 的 taskId 都是每轮自增的，写死一个 id 的话第二轮的用例会绿得毫无意义）。
> 14. **组件叫 `FindInFiles` 而不是 `SearchPanel`——因为 CM6 已经占用了那个名字。** `openSearchPanel`/`closeSearchPanel` 是**当前文档内**的查找替换（`Mod+F`），这一个是**整个项目**的搜索（`Mod+Shift+F`）。两个都叫 SearchPanel 的话，`builtins.ts` 里会同时出现两个意思完全不同的「搜索面板」。
> 15. **布局：新增一层 `.main` 纵向 flex，塞进 `.app` 既有的那份 `1fr` 里，`.app` 的 grid 一个字没改。** `.app` 是行数固定的五行 grid（工具栏/标签条/提示条/正文/状态栏），`styles.css` 里有一条注释专门警告「别加第六行」——多插一行就会把 `1fr` 挤到错误的行上。面板于是住在 `.main` 里面，与 `.body-row` 平级；两层收起时都是 `<Show>` 直接不渲染，不留占位，**没开过搜索的用户看到的布局与加这两层之前逐像素相同**。
>    - **这条原本只活在 CSS 注释里的不变量，现在是一条可执行的断言**：`App.test.tsx` 枚举 `.app` 的五个孩子并逐个比 className。将来谁把面板提成 grid item，那条用例当场红。
> 16. **`EditorController.reveal(anchor, head)` 是「跳过去并选中」的共享原语，M2-E 会是第二个消费者。** 一次 dispatch 做完三件事（选区 + `scrollIntoView(y:'center')` + 聚焦）——分成三次的话中间那两帧会画出「光标已经跳了但还没滚过去」的样子，看着像闪了一下，**而选区与焦点两条断言在分成三次的写法下照样全绿**，所以钉它的用例盯的是 dispatch 的次数与那一个 spec。
>    - 纯函数那一半（`revealTarget`）**刻意不认识 CodeMirror**：入参是一个只有 `lines` 与 `line(n)` 的结构类型，CM6 的 `Text` 天然满足。挂在 CM6 上测的话会把「偏移量算错了」与「CM6 装不起来」两种失败混在一条用例里。它有两处 clamp（行号越界、偏移量越界），挡的都是真实场景：**搜索结果会过期**，M2-G 的文件监听落地之后只会更常见。
>    - ⚠️ 探到的一个 CM6 边界：`StateEffect` 的公开面只有 `value` / `map()` / `is<T>()` / 静态 `define` / 静态 `mapEffects`，**没有公开的 `.type`**。所以要断言「滚到中间」只能读 `ScrollTarget` 自己的可枚举字段 `y`（`'center'`），不能拿 `EditorView.scrollIntoView(0).type` 当探针。
> 17. **新增了本项目第一个 `category: '搜索'` 的命令**（M2-D 的全局替换成了第二条，见下面「M2-D 实施修正」12）。绑 `Mod+Shift+F`：CM6 的 `searchKeymap` 只占了 `Mod+F` / `Mod+G`（Shift 是「上一个」）/ `F3`（同样带 Shift 变体）/ `Escape` / `Mod+Shift+L` / `Mod+Alt+G` / `Mod+D`，`Mod+Shift+F` 是空的，而它正好与「`Mod+F` 是文档内查找」形成一对，不用另发明。它**不设 `when`**：没有编辑器聚焦时也该能展开面板，空窗口里搜不了东西是「还没打开文件夹」那句话要说的事，不该由「快捷键按了没反应」来表达。
>    - ⚠️ **这一条原来把清单写错了**（写成 `Mod+F` / `Mod+G` / `Mod+Shift+G` / `Mod+Alt+Enter` / `Mod+D`）。`Mod+Alt+Enter` 在 `@codemirror/search` 里**根本不存在**，而 `Mod+Shift+L` 与 `Mod+Alt+G` 被漏掉了。上面的清单是 M2-D 挑键时重新 grep 构建产物核出来的（`grep -o '"\(Mod\|Alt\|Shift\|Esc\|F3\)[^"]*"' node_modules/@codemirror/search/dist/index.js`）——**要占任何一个 `Mod+*` 之前先跑一遍这条命令**，凭印象写的清单会得出「这个键是空的」这种错结论。
>    - ⚠️ 一个会咬人的排序事实：`registry.list()` 先按 `category` **码点**排、再按 id 排，所以那条枚举全部命令 id 的用例**不是按前缀分组的**——「搜索」(U+641C) < 「文件」(U+6587) < 「编辑器」(U+7F16) < 「视图」(U+89C6) < 「项目」(U+9879)，新 id 要插在数组**最前面**。
> 18. ⚠️ **Rust 测试名一律用中文句子、不含大写 ASCII。** `clippy --workspace --all-targets -- -D warnings` 会把 `non_snake_case` 变成硬错误，而 `#[test] fn fooBar()` 正好撞上它。这不是风格偏好，是门禁：起名时带一个大写字母，`cargo clippy` 就红。
> 19. **数字**：Rust 测试 137 → **197**（vela-core lib 116 → 165，**+49 条全部来自 `search::*`**；wire_contract 20 → 25；vela bin 1 条不变）；前端 714 → **905**（26 → **31** 个文件，新增 `src/ipc/search.test.ts` 26、`src/search/rows.test.ts` 42、`src/search/store.test.ts` 46、`src/search/reveal.test.ts` 15、`src/search/FindInFiles.test.tsx` 45）；**七道门禁全绿**；首屏 gzip 240.61KB → **244.29KB**（`index-ndyS-2jf.js` 133.66 + `dist-GyccKmKx.js` 108.31 + `index-BUnzYizj.css` 2.32），预算 300KB。
>    - ⚠️ 这 **+3.68KB** 里，M2-C-1~3 贡献 **0**（`src/ipc/search.ts` 与整个 `src/search/` 那时还没有任何 import 者，被 tree-shaking 整个摇掉了），M2-C-4c 贡献 **+3.60KB**（`App.tsx` 开始 import `src/search/*`），M2-C-4d 贡献 **+0.08KB**（命令注册 + 工具栏那个按钮）。
>    - **新依赖五条**（版本号取自 `Cargo.lock`）：`globset` 0.4.20、`grep-matcher` 0.1.9、`grep-regex` 0.1.14、`grep-searcher` 0.1.17、`ignore` 0.4.33，全部 **Unlicense OR MIT**，逐个 `cargo info` 核过。`serde` 进了 `src-tauri` 的 `[dependencies]`、`serde_json` 进了 `[dev-dependencies]`。计划表里的 `grep-cli` **没有进 lock**（用不上），`walkdir` 2.5.0 在 lock 里但是 `ignore` 的传递依赖，不是我们直接用的。
>    - ⚠️ **jsdom 钉不住的，写在这里当债**：面板占掉多少编辑区高度、240px 这个数在真实窗口里合不合适、结果行的省略号断在哪儿、`.find-mark` 与 `.find-opt.on` 的对比度——jsdom 里没有布局（`clientHeight` 恒为 0，于是虚拟窗口永远只给出 `OVERSCAN` 行）。**以及真·端到端**：`start_search` → batch/heartbeat → done 这条链从来没有对着一个真的 `AppHandle` 跑过，测试里事件是手工触发的。

> **M2-D 实施修正**（2026-09-17，全局替换 M2-D-1~5 交付时改判/踩出来的，按重要性排）：
>
> 1. 🔴 **预览不另起一条 IPC：还是那条 `start_search`，`query` 上多一个可选的 `replace`。** 命中里于是多一个 `replaced` 字段（把这一行按模板展开之后的样子）。理由不是省一条命令，而是**让「所见即所做」在结构上成立**：Rust 侧只有一份 matcher 构造与一份模板展开实现，预览与落盘共用它。要是预览走一条独立的路径，两边的匹配规则就会各自演化，而失败方式是「预览说会改 3 处、落盘改了 4 处」——一个用户不可能自己发现的分岔。
>    - 代价是 `SearchHit.ranges` 的偏移量指的是**原文**里的位置，不是 `replaced` 里的。UI 因此把两者分开渲染（原文那一段照旧打 `mark`，箭头后面才是预览），不做「在预览里再高亮一次」。
>    - ⚠️ **替换内容为空串是合法输入**，意思是「把每一处命中删掉」。它必须照样把 `replace` 这个 key 发出去：挂在「非空」上的话前端会省掉这个 key，Rust 侧当成纯搜索，用户点了「替换全部」却一个字都没改，而面板看起来一切正常。同理，UI 判断「这一行有没有预览过」只能用 `=== undefined`，**不能真值判断**。
> 2. 🔴 **`start_replace` 是第十个接受路径的命令，也是第一个会在 `root` 底下写盘的。** 前九个里，`open_file`/`save_file` 收任意绝对路径（那是编辑器本来的样子），其余七个收 `(root, rel)`、逃逸在结构上不可能。这一条的包含性故事与前九个都不同：它**遍历** `root`（`follow_links(false)`，与搜索同一套 `ignore` 规则，所以 `node_modules` 与 `.gitignore` 命中的条目一个都不会被写），而唯一由前端递进去的绝对路径清单是 `skip`——⚠️ **它的用途是保护，不是授权**：里面是「正开着且有未保存改动」的那些文件，Rust 见到就跳过。
>    - 写盘是**原子**的（临时文件 + rename）：进程在写到一半时被杀掉，留下的要么是旧内容要么是新内容，不会是一个截断的文件。
>    - 单个文件写失败**不中止整轮**：它计入 `ReplaceSummary.writeFailed`，其余文件照写。理由是「一处失败就回滚已经写完的几十个文件」需要一份备份，而那份备份本身就是第二个可以写错东西的地方；如实报出「有 2 个文件没写成」比悄悄回滚更诚实。
> 3. 🔴 **Vela 没有跨文件撤销，这是本项目里唯一一处批量写盘——所以落盘前必须摊一张确认单。** 确认单（`ReplaceConfirm`，由 App 渲染成 `.modal-backdrop`，不在面板里面：面板只是 `.main` 底下那 240px，遮罩挂在里面就只罩住它自己）说的是**人话**：改几个文件、几行、跳过几个、是不是在删（`deleting`）、以及这份清单完不完整（`truncated`）。
>    - ⚠️ **「替换全部」只摊单子，一个字节都不写。** 这一条被单独钉住：点它之后 `start_replace` 的调用次数必须是 0。真正的批准在对话框里，而对话框的默认焦点不在「替换」那个按钮上。
>    - 与 M2-B 那条「反向操作给最小视觉重量」的规矩相反，这里的确认按钮**不给**弱化样式：它不是「退出/删除自己刚做的东西」，而是用户主动发起的一次批量修改，弱化它只会让人反复点。⚠️ 但也**不给** `.primary`——两个按钮都是基础 `button` 样式，长得一模一样，「替换」在左、默认焦点那个「取消」在右（`DiscardDialog` 是反过来的：安全的「保存」带 `.primary` 且拿默认焦点）。这一处**视觉重量刻意谁都不加**：破坏性由 `.modal-warn` 那句话说，不由任何一个按钮的样子说。
> 4. **正开着且有未保存改动的文件被跳过，而不是被盖掉、也不是先替用户保存。** `skip` 由 `workspace.dirtyPaths()` 在**批准那一刻**求值（不是预览那一刻：中间可能又脏了几个）。
>    - 为什么不「先保存再替换」：那会把用户还没决定要不要留的稿子写进磁盘，等于替他做了另一个决定。
>    - 为什么必须**看得见**：跳过之后那一轮的 `replacements` 会小于预览里的数字。所以三处同时说这件事——结果行整行标 `.skipped`、文件行的计数里带原因、总账下面单独一行警告「保存它们之后再换一遍」。只在总账里说一个数字的话，用户看到的是「说好 3 处怎么只改了 2 处」。
>    - ⚠️ 路径原样递，**不 normalize**：Rust 侧逐组件比 `Path` 相等，而 macOS 上 `/tmp` 与 `/private/tmp` 这类差别会让「同一个文件」比不出来，失败方式是静默地盖掉用户的稿子。
> 5. **落盘之后把 `root` 底下那些干净的标签从磁盘重读一遍，并且说一句。** 重读是必须的：磁盘变了而编辑器里还是旧正文，用户下一次 `Mod+S` 就会把刚替换掉的内容写回去。
>    - **脏的一个字节都不碰**——`DocumentModel.reload()` 自己挡（见 M1-B），所以这里只需要数「真的变了几个」。
>    - ⚠️ 那句话是单独一条 `.notice ok`，**不并进面板底部那行总账**：总账说的是磁盘上发生了什么，这一句说的是编辑器里跟着发生了什么——正文换了，**撤销栈也重建了**。不说一句的话用户看到的是「我刚在改的文件自己动了」，而那正是他最不知道该往哪儿想的一种变化。
>    - `filesChanged === 0` 时不调用：一个文件都没动，重新读盘是白跑 IPC。
> 6. ⚠️ **`replace-done` 的 summary 是落盘那一轮唯一权威的最终数字。** 替换侧的 `Sink` **刻意没有 final flush**（搜索侧的 `Collector` 有），所以最后一次 `replace-progress` 里的 `filesScanned` 可以**小于** summary 里的那个；`filesChanged` 与 `replacements` 则永远相等。前端因此不把 progress 的最后一次快照当结论用。
> 7. ⚠️ **`onProgress` 可能一次都不来**（改的文件少于一个批次的量，或全程没触发心跳）。UI 不许把「没有进度」当成出错或卡死：状态行在这种情况下退化成裸的「正在替换…」，而不是「正在替换… 已改 0 个文件」——后者读起来像卡住了。
> 8. **条件改过之后「替换全部」灰掉，而不是悄悄把结果行清掉。** `stale` 的唯一来源是用户在搜完之后动了条件（搜索词、三个开关、替换内容、或替换模式本身）。
>    - ⚠️ **这不是数据安全问题**：`start_replace` 拿着**当前** `query()` 从头再走一遍，写的永远是当前条件。真正错的是**人批准了一份他没看到的清单**——预览行里的 `replaced` 说的是上一份条件。
>    - 灰掉的每一种理由都写在按钮的 `title` 上（正在写盘 / 等这一轮搜完 / 条件改过了 / 先搜一遍 / 一处都没命中）。灰掉的按钮不解释自己的话，用户只会反复点它，然后以为这个功能是坏的。
>    - 清行是更糟的处理：用户看到的是「刚搜出来的结果凭空没了」。
> 9. **替换模板的语义与 `regex` crate 的 `Replacer` 一致，包括 `$$` 转义**：`$$&` 展开成字面量 `"$&"`，`$$$&` 展开成 `"$" + 整个匹配`。⚠️ 而 `build_matcher` 上配了 `.line_terminator(Some(b'\n'))`，所以**跨行匹配在结构上不可能**——不是「碰巧搜不到」，是引擎不允许。这一条与「替换内容里可以有 `\n`」并不矛盾：模板展开是字符串操作，与匹配无关。
>    - ⛔ **没有引入 `regex` crate**：搜索侧用的是 `grep-regex`（ripgrep 的库化产物），再引一个引擎就意味着两套语法，而它们的差异会在「预览说会改、落盘说不会改」这种最难查的地方显形。
> 10. ⚠️ **单文件 500 命中上限只在预览那一侧；落盘路径没有这个上限。** 所以真实的 `replacements` 可以**大于**预览里数出来的条数。确认单上的 `truncated` 因此必须单独说「这份清单不完整」，而不能只在总账里说——两处说的是不同的东西：总账那个 `truncated` 是「结果被截断了」，确认单这个是「**你批准的这份清单**被截断了」。
> 11. 🔴 **一个只在真实按键下才复现的 bug：Solid 的批处理顺序不可靠，于是焦点落错了格子。** `showReplace()` = 「打开替换模式」+「展开面板并要求聚焦」，两个信号连着写。而命令分派挂在 `window` 的**捕获阶段**、不在 Solid 委托的事件批里，所以两次写各自跑完一轮更新——组件里「`focusRequest` 变了就聚焦搜索词」与「`replaceMode` 变了就聚焦替换为」这两个 effect 谁后跑，完全由写入顺序决定。点面板上那个「替换」按钮时只有一个信号变，看不出问题；按 `Mod+Shift+H` 时两个都变，于是焦点留在了搜索词上。
>    - **修法不是调顺序，是让 store 把意图说出来**：新增 `focusTarget: 'pattern' | 'replacement'`，`show()` 说 pattern、`showReplace()` 说 replacement，组件那个 effect 照它选格子。两条路于是指向同一格，effect 谁先谁后不再有语义。⚠️ `setFocusTarget` 必须写在 `setFocusRequest` **之前**（同一个理由）。
>    - ⚠️ 「搜索词还空着就留在上面那一格」这条规则在组件里**写了两遍**（键盘入口一处、鼠标点按钮一处），是故意的：两条入口必须得出同一个答案，而合并成一个 effect 需要把 `pattern()` 读成依赖——那会让替换模式下每打一个字焦点就被抢走一次。
>    - **教训：靠「后注册的 effect 会赢」来实现的行为，等于把语义交给一个看不见的时序。** 它在测试里能绿（`modeButton().click()` 走的是 Solid 的事件批），只在真实按键下坏。
> 12. **新增命令 `search.replaceInFiles`，绑 `Mod+Shift+H`。** VS Code 里「Replace in Files」就是 `Cmd+Shift+H`，也与 M2-C 的 `Mod+Shift+F` 形成一对（同一个面板，差一个「进去就是替换模式」）。这个键此前在本项目里是空的：CM6 的 `searchKeymap` 只有 `Mod-f` / `F3` / `Mod-g` / `Escape` / `Mod-Shift-l` / `Mod-Alt-g` / `Mod-d`，`commands` / `view` 的 keymap 里也没有 `Mod-h`；文档内替换走的是 `Mod+Shift+Enter`。⚠️ `Mod+H`（不带 Shift）**刻意不占**——留给输入法与系统手势。
>    - 命令总数 38 → **39**，`category: '搜索'` 从一条变两条。⚠️ `registry.list()` 先按 category 码点排、再按 id 排，所以枚举用例里两条 `search.*` 都插在数组**最前面**。
> 13. **数字**：Rust 测试 197 → **255**（vela-core lib 165 → **216**，wire_contract 25 → **29**，`vela_lib` **10**）；前端 905 → **1067**（31 → **34** 个文件）。新增三个文件：`src/ipc/task.test.ts` **3**（`cancel_task` 是搜索与替换**共用**的，所以它的测试既不属于 `search.test.ts` 也不属于 `replace.test.ts`）、`src/ipc/replace.test.ts` **17**、`src/search/ReplaceConfirm.test.tsx` **15**；长起来的：`rows` 42 → **60**、`store` 46 → **99**、`FindInFiles` 45 → **68**、`App` 68 → **76**、`builtins` 39 → **43**、`ipc/search` 26 → **29**，以及「已打开文件对账」那一步带出来的 `doc/document` → **39**、`doc/workspace` → **105**。⚠️ 这些数取自 **vitest 的 JSON reporter**（`--reporter=json`），不是数 `it(` 的行数——嵌套 `describe` 下缩进不一致，grep 会少数。**七道门禁全绿**；首屏 gzip 244.29KB → **247.56KB**（`index-BRA2wVS1.js` 136.84 + `dist-GyccKmKx.js` 108.31 + `index-6OKQSPpP.css` 2.41），预算 300KB，余量 **17.5%**。chunk 仍 **117** 个，`dist/index.html` 仍只引 **3** 个（⛔ `manualChunks` 一条都没加）。
>    - **新依赖零条**：Rust 侧完全复用 M2-C 那五条，`Cargo.toml` 一个字节没改。替换是搜索的第二个消费者，不是第二个子系统。
> 14. ⚠️ **jsdom 钉不住的债，在 M2-C 那一份之上再加**：`.find-mode` 与 `.find-opt` 的视觉区分够不够、替换模式下多出来那一排（约 26px）值不值、`.find-new` 的绿与 `.find-mark` 的蓝并排时读不读得开、`.find-row.skipped` 压暗的程度、确认单的版式、以及新增那条 `.notice ok` 会不会与 lossy 警告挤在一起。**以及真·端到端**：`start_replace` → progress → done 这条链同样从来没有对着一个真的 `AppHandle` 跑过；而落盘那一轮的**真实成本**（十万文件仓库上改一千处要多久）也还没量过——搜索侧量过 6.72s，替换侧多一遍写盘，只有实测才知道。

> **M2-E 实施修正**（2026-09-18，Goto Anything M2-E-1~6 交付时改判/踩出来的，按重要性排）：
>
> 1. 🔴 **「Rust 建索引并缓存」这个决定，落地时把「缓存」那半句改判掉了——因为它想省的那个代价根本不存在。** 决策时接受的成本是「索引会过期，所以需要一个手动刷新的入口」。实测下来（M2-E-2）：`index_project` **每次展开浮层都无条件重建**，`query_project` 只在 `root` 换了才重建（`src-tauri/src/commands.rs` 的 `ProjectIndexCache`，那条不对称写在它的文档里）。「过期」在结构上不可能发生，手动刷新入口也就没有存在的理由。
>    - ⚠️ **别把它读成「有缓存」**：`ProjectIndexCache` 存在的唯一目的，是让**同一次浮层会话里**那一串 `query_project`（每敲一个键一次）不重复建索引，不是跨会话的。
>    - 代价换成了另一样东西：**每次 `Cmd+P` 都要走一遍目录**。这个数在真实仓库上还没量（见 15）。
> 2. **`Cmd+R` 只做 Markdown 标题，其他语言诚实地说「还没有」。** 范围就是 `ATXHeading1-6` + `SetextHeading1/2`；非 Markdown 文档回 `{kind:'unsupported', label}`，浮层里显示「这个语言还没有符号表」。
>    - ⛔ **绝不退化成全文搜索**：那种「好像能用」的降级会让人以为符号表坏了，而它其实只是没做。宁可明说。
>    - ⛔ **也不许长成代码智能**：v1 的非目标里没有 LSP，`Cmd+R` 是一个标题清单，不是符号索引。这是一条明确记着的债。
>    - `ensureSyntaxTree(state, doc.length, 50ms)` 拿不到就退回 `syntaxTree(state)`：解析没跑完时给出**已有的那部分**标题，而不是空列表——空列表与「这份文档没有标题」在用户眼里是同一件事，而前者是假的。
> 3. **`Cmd+Alt+G` 原样留着 CM6 的 `gotoLine`，⛔ 不注册 `goto.line` 命令。** 跳行于是有两个入口：CM6 自己那个提示框，与浮层里的 `:42`。不给同一件事开第三扇门——何况那三扇门的 UI 还长得各不相同。
>    - ⚠️ **抢这个键的失败方式是静默的**：命令分派挂在 `window` 的**捕获阶段**并 `preventDefault`（`src/commands/dispatch.ts`），抢了 `Mod+Alt+G` 就等于让 CM6 那个提示框永远弹不出来，而所有功能用例照样全绿。所以这条「不做什么」的决定用一条专门的用例钉住（`builtins.test.ts`）。
> 4. **浮层里的文法是 VS Code `Cmd+P` 的口径**：空 = 列出最近打开过的；`store` = 模糊找文件；`:42` = 当前文档跳行；`store.ts:42` = 打开并跳行；`@安装` = 当前文档的标题。四种意图共用一格输入框，靠前后缀区分——这是用户唯一不需要学第二套按键就能猜到的口径。
>    - ⚠️ **一个字符都不 trim**：首尾空格是查询的一部分。文件名里可以有空格（`My Notes.md` 在 macOS 上极常见），而「用户多打了一个尾随空格」与「用户在找一个名字以空格结尾的文件」在这一格输入框里区分不出来。宁可让前者少命中几条——他删掉空格就好——也不要让后者永远搜不到。Rust 侧 `needle` 的文档写的是同一条规矩。
>    - **解析顺序是有意义的**：`@` 与开头的 `:` 先判，剩下的才去**最后**一个冒号上切 `:行号`（Windows 的盘符 `C:\repo\a.ts:42` 因此不会被拆开）。
>    - **两处已知误判，故意留着**：`file.ts:12:3`（VS Code 的 行:列）会被读成「文件 `file.ts:12` 的第 3 行」，失败方式是**列表空着**——用户看得见，不会跳到错的地方去；名字里带冒号又正好以 `:数字` 结尾的文件会被拆成文件名 + 行号。两条都能用更复杂的文法消掉，代价是这一格输入框的行为变得要查文档才知道。列跳转本来就不在 v1 范围里（`EditorController.reveal` 收的是位置，没有列的概念）。
> 5. **MRU 进了会话存档**（`Session.recent`，上限 50 条），不另起一个存储。旧档没有这个字段时按空清单读，不报错。
>    - ⚠️ **`recent` 是绝对路径清单，只用来加分**：Rust 侧拿它与索引里已有的 rel 比对，比不上的直接忽略。一份伪造的 `recent` 最坏只能打乱顺序，**不会让任何一个额外的文件被读**。上限 `MAX_RECENT` 在前端写入与恢复两处各夹一次，`FileIndex::recent_bonus` 自己还 `take(MAX_RECENT)` 一遍——三处同值，各有测试钉住那个数字。
>    - ⚠️ **前端那条 IPC 不能省这个 key**：Rust 侧是 `Vec<String>` 而不是 `Option<...>`，缺 key 直接反序列化失败。
> 6. **第三个消费者到位，才把虚拟窗口抽出来**：`src/ui/virtual.ts`（`visibleWindow` + `OVERSCAN` + `VirtualWindow`）。M2-C 修正 3 写的是「M2-E 会是第三个消费者，到那时再抽」——现在抽了，三个列表（文件树、搜索结果、浮层候选）共用同一份算术。
>    - ⚠️ **抽的是算术，不是行高**：`QUICK_OPEN_ROW_HEIGHT = 20` 与那两个仍然是每个列表自己的唯一真相，样式表里的行高一律引用那个变量。行高只该有一个来源，而那个来源不是共享模块。
> 7. **新增「跳转」分类，不塞进「搜索」。** 搜索答的是「哪些地方有这个词」，跳转答的是「带我去那一处」——命令面板里挨着放，会让人以为按名字找文件是全文搜索的一种。`CommandDefinition.category` 是普通 `string` 而不是联合类型，所以加一个分类不用改任何类型声明。
>    - 🔴 **踩坑：`registry.list()` 先按 category 码点排、再按 id 排，而凭字形或拼音猜这个顺序必错。** 实测：搜 U+641C < 文 U+6587 < 编 U+7F16 < **视 U+89C6 < 跳 U+8DF3** < 项 U+9879。「跳转」落在「视图」与「项目」之间。
> 8. **两个键此前都是空的，而且是核过才占的**：整个 `@codemirror` 里搜不到一条 `Mod-p` / `Mod-r` / `Ctrl-p` / `Ctrl-r`；本项目也没有自建原生菜单（`src-tauri/src/lib.rs` 里一条 `MenuBuilder` 都没有），macOS 那套标准菜单项同样不占它们。选这两个字母不是随便挑的——Sublime 的 Goto Anything 是 `Cmd+P`、Goto Symbol 是 `Cmd+R`，而这个项目的界面参照物正是 Sublime。
>    - ⚠️ **`Mod+Shift+P` / `Mod+Shift+R` 刻意留空**（留给将来的命令面板一类），并且用用例钉住；`Mod+Shift+O` 也仍为 M2-F 留着。🔴 **后半句已被 M2-F 兑掉**：那个键现在绑的是 `project.openRecent`（「打开最近的项目…」），钉住它的用例从「无人占用」翻转成「占用且命中这一条」（见下面「M2-F 实施修正」8）。🔴 **`Mod+Shift+P` 也已被 M3-B-1d 兑掉**（现在是 `commandPalette.open`，「命令面板…」），只剩 `Mod+Shift+R` 空着并被用例钉住。
> 9. **`Escape` 在浮层自己的子树里处理，⛔ 不注册成命令**——与查找面板同一条规矩，理由同样是捕获阶段拦不住。同理，点遮罩空白处收起用的是 `e.currentTarget === e.target`，不必给浮层本体挂一个 `stopPropagation`。
> 10. **浮层是顶部盖着的，不是底部面板**：底部那一块已经被全局搜索占了（240px），两者同时展开编辑区只剩一条缝；而 `Cmd+P` 的典型用法是「跳过去，浮层立刻消失」，它不是一个会一直开着的面板。`.palette-backdrop` 是 `position: fixed`，脱离 `.app` 那个「行数必须固定」的 grid 流，所以不会给它多加出一行来。
>    - `z-index: 20`，盖在 `.modal-backdrop`（10）上面。反过来放的话，一张确认单开着的时候按 `Cmd+P`，浮层会藏在遮罩后面，用户只看到「按了没反应」；盖在上面时他按 `Escape` 就回到那张单子。
>    - ⚠️ **刻意不压暗背景**：挑标题时要的正是「一边看编辑区一边挑」，压暗等于宣布后面那块现在与他无关。
> 11. 🔴 **jsdom 钉不住「`:42` 落地之后光标停在第 42 行」，而且失败方式极具误导性**（看起来像产品把光标丢了）。实测事件顺序（探针记录）：`reveal` 派发交易、state 的光标确实到了目标 → 紧接着 `view.focus()`，jsdom 把 DOM 选区挪到 `(contentDOM, 0)`，而 CM6 `updateSelection()` 那一下 `Selection.collapse()` 在 jsdom 里**没有落住** → jsdom 随后补发 `selectionchange`，CM6 的 `DOMObserver.onSelectionChange` 看见「DOM 选区在编辑器里、且与 state 不一致」，判定成用户拖了光标，`applyDOMChange` 把 state 的光标**改回 0**。
>    - **产品代码是对的**：真浏览器里 `collapse()` 会落住，`readSelectionRange()` 因为两边一致直接返回 false，不会有这次回改；CM6 自己那条「浏览器在 focus 时把光标挪到了元素开头」的兜底（`atElementStart`）正是为这种情形写的。
>    - **用例因此改成断言同步那一拍**（派发出去的光标位置 = 278），落定之后的落点由 `a.ts:42` 那条覆盖——它的 `reveal` 跑在 `openAt` 之后的微任务里，那条 `selectionchange` 早已消化完，全程不回改，`cursorLine()` 稳稳地是 42。两条走的是同一段 `revealTarget` + `controller.reveal`。
>    - ⚠️ **这是本项目里第一个「同步断言才对、`await` 之后反而错」的用例。** 以后凡是断言光标落点，先想一遍这条。
> 12. **模糊匹配是手写的，⛔ 一个新 crate 都没加。** Rust 侧完全复用 M2 已有的那些，`Cargo.toml` 一个字节没改。引一个 fuzzy 库意味着多一条 license 要核、多一套打分口径要与 MRU 加权对齐，而这里要的排序规则只有几条（连续命中、词首命中、`recent` 加分）。
> 13. **数字**：Rust 测试 255 → **304**（vela-core lib 216 → **254**，wire_contract 29 → **32**，`vela_lib` 10 → **18**）；前端 1067 → **1280**（34 → **40** 个文件）。新增六个文件：`goto/query` **25**、`goto/symbols` **36**、`goto/syntax` **16**、`goto/store` **50**、`goto/QuickOpen` **35**、`ui/virtual` **12**；长起来的：`App` 76 → **86**、`builtins` 43 → **48**、`doc/workspace` 105 → **124**、`ipc/project` → **25**、`sessionSync` → **29**、`ipc/session` → **27**。命令总数 39 → **41**（`goto.file` / `goto.symbol`）。**七道门禁全绿**；首屏 gzip 247.56KB → **250.60KB**（`index-CfdvHkYL.js` 139.57 + `dist-Cx7xBNi0.js` 108.38 + `index-B6KhrU-4.css` 2.65），预算 300KB，余量 **16.5%**。chunk 仍 **117** 个，`dist/index.html` 仍只引 **3** 个（⛔ `manualChunks` 一条都没加）。
> 14. ✅ **M2-E-5 顺手还掉了一笔 M2-C 的债**：`resultWindow` 当时写在 `project/tree.ts` 下面，明说是「历史顺序不是归属判断」。现在算术搬进了 `src/ui/virtual.ts`，`project/` 与 `search/` 都不再是它的家。
> 15. ⚠️ **jsdom 钉不住的债，在 M2-D 那一份之上再加**：浮层的观感（520px 宽、距顶 72px、**不压暗**背景下够不够读）、标题按级别每级缩进 12px 是不是一眼看得出层级、代码字体与界面字体在同一格里切换会不会跳、`Cmd+R` 在一份几百个标题的长笔记上滚起来顺不顺。**以及真·端到端**：`index_project` / `query_project` 从来没有对着一个真的 `AppHandle` 跑过；**十万文件的真实仓库上「每次展开都重建一遍索引」到底要多久，这个数现在一个都没有**——它正是修正 1 那个改判换过来的代价，也是 M2-G 文件监听落地之后能不能真正缓存起来的前提。以及 `Cmd+P` / `Cmd+R` 与 WKWebView 默认行为不冲突这件事：grep 证明了 CM6 与自建菜单都不占，**真窗口里还没按过**。

> **M2-F 实施修正**（2026-09-19，工作区管理 M2-F-1~7 交付时改判/踩出来的，按重要性排）：
>
> 1. 🔴 **用户裁定：`.vela/settings.json` 分层合并推迟到 M4。** 在「M2-F 里做 / 推到 M4」两选一里选的后者。这一版 M2-F 因此只剩两件事：**多根工作区**与 **`Cmd+Shift+O` 最近项目**。推迟是对的：项目级配置要回答的不是「怎么读一个 json」，而是**三层合并**（内置默认 → 用户全局 → 项目级）加上「哪一层能改哪些键」，而用户全局那一层本身还没有落地（M4 的事）——先做项目级，等 M4 补上全局层时要回头改一遍合并顺序。⚠️ **M4 那张表已经跟着改了**：加了「项目级配置 1 人日」一行，同时把「P1 功能」从 2 降到 1.5（它列的「在 Finder 中显示、复制路径」M2-B-5 已经交付），标题人日 6–8 → **6.5–8.5**。
> 2. 🔴 **用户裁定：多根之下全局搜索与 `Cmd+P` 覆盖所有根，Rust 命令收 `roots` 数组。** 在「跨所有根，Rust 命令收 `roots` 数组 / 只搜当前聚焦的那个根 / 前端逐根各发一次再合并」三选一里选的第一个。落地成 `start_search` / `start_replace` / `index_project` / `query_project` 四条命令一起改签名，**一个 taskId、一次取消、一份总账**。
>    - ⚠️ 顺带把「只搜聚焦的根」排除掉的理由值得留一句：它会造出一个**安静的错答案**——用户在三个根里搜一个词、搜不到，而「这个仓库里没有」与「你搜的不是那个仓库」在界面上长得一模一样。宁可慢，不可错得看不出来。
>    - ⚠️ **坏根的取舍与搜索侧同一条：一个根不合法就整次 reject，坏根的路径写在错误里**，而不是「跳过它、搜剩下的」——理由逐字同上（`src-tauri/src/commands.rs:767` 的 `preflight_index_roots` 与 `vela_core::search::preflight_roots`）。⚠️ 预检**放在 `cache.retain` 前面**，好让「reject = 什么都没发生」在缓存这一侧也字面成立。
>    - ✅ **信任面没有变宽**：每一个 `root` 仍然只可能来自 dialog 插件（`directory: true`），前端没有任何输入框能填它；vela-core 那一侧对每一个根各查一次「是不是绝对路径、存不存在、是不是目录」。
> 3. **没有项目文件。** ~~对齐 Sublime 的 `.sublime-project`~~——工作区就是**一份根清单**，活在会话存档的 `Session.project.roots` 里，磁盘上不落第二个文件。三条理由：① 一旦有了 `.sublime-project`，就得回答「它跟会话存档谁说了算」「用户改了它要不要热重载」「关不关得掉」三件事，而 v1 一件都不需要；② Vela 的场景是「速开编辑器」，工作区是**现场**而不是**配置**，现场本来就该跟着会话走；③ 少一个文件格式就少一份要向后兼容的东西，而 M2-F 已经背着一份（见修正 13）。
>    - ⚠️ **代价是「工作区不可分享」**：把一份根清单发给同事这件事做不到。真到了那一步再加 `.vela-workspace` 也不迟——`Session.project.roots` 已经是根清单的形状，序列化成一个独立文件只是一次 `serde_json::to_string`。
> 4. **前端拆成两层：`rootTree.ts`（单根实例）+ `store.ts`（协调层）。** 单根那一份原样搬进 `rootTree.ts`，`store.ts` 持有 `mounted: readonly Mounted[]`（`Mounted = { tree, release }`）。
>    - ⚠️ **位次是显式推下去的，不是算出来的**：每个 `RootTree` 自己存一个 `index` 信号，`removeRoot` 之后协调层逐个调 `tree.setIndex(i)`。行键 `RowKey` 是 `{ rootIndex, rel }` 的**结构体**而不是拼出来的字符串——多根之下两个根里可以有一个同名的 `src/`，`rel` 不再唯一。⛔ **所有身份比较一律走 `sameRow()`，没有一处 `===`**（`tree.ts:98`）。
>    - 🔴 **`release` 必须与 `dispose` 成对调用**：`dispose` 只让实例停止影响界面，而它那个 `rows()` memo 挂在 `createRoot` 造出来的所有者上——不 `release` 就永远不会被回收。对一个主打低内存的编辑器来说，「每关一个文件夹漏一个 memo」正是要防的那种账（`store.ts:102` 那段注释）。
>    - ⚠️ **`roots: []` 是被 Rust 拒的**，「一个文件夹都没开」在前端的表示是 `project: null`，不是一份空清单。这两者不是一回事：空清单意味着「有一个工作区，它没有根」。
> 5. **「最近项目」记的是一份根清单，不是一个路径。** `Session.recentProjects`，一条 = 一个工作区 = **一份根清单**。
>    - ⚠️ **与 M2-E 的 MRU 并存，两者不是一回事**：M2-E 记最近打开过的**文件**（`Session.recent`，住在 workspace 那一半），这里记最近换过的**工作区**（住在树那一半）。名字只差一个词、归属却在两边，**判据只有一条：它记的东西是文档还是文件夹**。
>    - 于是它由 `sessionSync` 在拼接时**盖上去**（`tree.serializeRecent()`），启动时**交回去**（`tree.restoreRecent()`）——与 `project` 那一格同一条路径。⚠️ `restoreRecent` 是**同步**调的，放在那个 `Promise.all` **前面**：它只写一个信号、没有 IO，于是即便下面两半里有一半抛了，清单也已经在内存里了。
>    - 🔴 **`sameWorkspace` 逐个比，⛔ 不 join 成一个字符串**：`['a\nb']` 与 `['a','b']` join 之后是同一个串，两个不同的工作区会混成一条（`store.ts:80`，用例「`sameWorkspace` 逐个比，路径里的换行不会把两条不同的清单混成一条」钉住）。
>    - ⚠️ **空清单一律不记**（`rememberWorkspace` 的 early return）：否则「关闭所有文件夹」之后紧接着一次自动保存，清单最前面就会多出一条空工作区，而 `Cmd+Shift+O` 会把它画成一行没有名字的候选。
> 6. **只在「离开一个工作区」时记，共三处：`openAt` / `openMany` / `close`。** `addRoot` / `removeRoot` / `restoreState` **一律不记**。
>    - `addRoot` 不记：加一个根是**改**当前工作区，不是换一个。记的话一次「开三个文件夹」会在清单里攒出 `/a`、`/a /b`、`/a /b /c` 三条半成品，而用户认的只有最后那一条。
>    - `restoreState` 不记：那是**把上次的现场装回来**，不是用户换了一次项目。记的话每次启动都把同一份清单再顶一遍，`MAX_RECENT_PROJECTS = 12` 很快被启动噪音占满，而真正想回去的那一份反被挤到外面（`store.ts:295` 那段注释）。
>    - ⚠️ 记的是**离开时**的那一份，所以「切到 B、五秒内又切回 A」也必须把 B 记下来——那条用例断言的是这个**性质**，而不是「什么时候调了 `rememberOutgoing`」这个机制。
> 7. **当前工作区不出现在候选里。** `recentProjects()` 在返回前 `filter(!sameWorkspace(current))`。理由：选它等于 `openMany` 重建整棵树，用户摊开的每一层都会被收回去——那是把一个无操作的点击变成一次破坏。
>    - 🔴 **⚠️ `recentProjects()` 与 `serializeRecent()` 是两个不同的函数，容易看错**：前者**排掉**当前工作区（给浮层看），后者**写回**当前工作区（存档是全集，不然重启之后「上一次开着的那个」就永远丢了）。两者都调 `rememberWorkspace(...)`，差别只在最后那一个 `filter`。
> 8. **`Mod+Shift+O` 的键位裁定。** VS Code 的「Open Recent」在 macOS 上是 `Cmd+R`，而 `Cmd+R` 在这里已经是 `goto.symbol`（跳转到标题，Sublime 的既有约定，M2-E 占的）。两者不可兼得，选了 **PLAN §3.4 原表里预留的那一个**。
>    - ⚠️ **占之前核过**：整个 `@codemirror` 与 `@lezer` 里搜不到一条 `Mod-Shift-o` / `Ctrl-Shift-o`（与 M2-E 修正 8 同一套查证），本项目也没有自建原生菜单去占它。
>    - 🔴 **同时翻转了 M2-E 那条断言**：`builtins.test.ts` 里原本写着 `findForKey('Mod+Shift+O')` → `toBeNull()`（「无人占用，别顺手拿去绑别的」）。M2-F 把它改成「占用且命中 `project.openRecent`」，**并保留了另一半**（`Mod+O` 仍是 `file.open`、裸 `o` 与 `Shift+O` 谁也不命中）——留着这半条的意义是钉住「打开文件夹」自己没有顺手抢一个键。
>    - ⚠️ **`project.openRecent` 放在「项目」分类而不是「跳转」**：它换掉的是整棵树，而「跳转」那两条答的是「带我去当前工作区里的某一处」。
>    - ⚠️ **没有 `when`**：一份空的最近清单不是「这条命令此刻不适用」，而是「这里还没攒出东西」——浮层自己会把这句话说出来，而快捷键按了没反应则什么也说不清。
> 9. **复用 `Cmd+P` 那个浮层，⛔ 一个新浮层都没加**：第四种意图 `'project'`（前三是 goto / line / symbol）。标签、`aria-label`、placeholder 三处跟着意图走，用例逐字钉住（`切换到最近项目` / `最近项目` / `按名字或路径找最近项目…`）。
>    - 🔴 **它压根不问索引，一条 IPC 都不发**——用例断言 `indexProject` / `queryProject` 都没被调、`.busy` 没出现。这不只是省一次往返：项目清单本来就在前端内存里。
>    - ⚠️ **代价是一个新信号 `indexed`**（`goto/store.ts:261`）。`ready` 说的是「列表可以算了」，而项目模式**不需要索引**也算得出来。少了 `indexed`，「浮层开着的时候从 `Cmd+Shift+O` 切到 `Cmd+P`」会走进一个 `ready === true` 却压根没建过索引的现场——文件清单永远是空的，而浮层不报错。补的那一下在 `show()` 里：`if (which === 'goto' && !indexed()) await buildIndex(epoch)`（`store.ts:527`）。**反方向什么都不用补**（project 那一路压根不问索引）。
>    - ⚠️ **`mode` 那个 memo 刻意不看输入框里的字**：项目模式下 `:42` 与 `@标题` 都只是在过滤项目名，不是切换意图。
>    - ⚠️ **`commitSelected()` 重新解析 `raw()` 而不是读 `lineTarget()`**：Solid 的 effect 不同步到那一步，「填好 `:42` 立刻按 Enter」会读到上一次的解析结果。
> 10. **`.palette-root` 那一格被复用成「第一个根的父目录」**（`projectWhere`）。只有名字的话 `~/work/app` 与 `~/side/app` 在浮层里是两行一模一样的 `app`，而 `Cmd+Shift+O` 的全部价值就是「切到我要的那一个」——两行分不出来，用户只能靠悬停一个个读 title，那比没有这一栏更慢。
>     - 与文件候选复用**同一格与同一条 `/` 分隔线**（`::after`），于是两种模式下左边界对齐，读起来也是同一句话：「这个名字在那个地方」。⛔ 没有新加一个 CSS 类。
>     - ⚠️ 边界：`/vela` 的父层是根目录，`slice(0, 0)` 会得到空字符串——那时如实给一个 `/`；没有斜杠（不是绝对路径）给空串而不是猜一个父目录。
>     - **多根候选写成 `vela +2` 而不是三个名字**（`projectLabel`）：三个长名字排在一行里，用户扫过去只看见一片字，而他要认的其实只是「是哪一个项目」。剩下的在悬停 title 里一行一个。
>     - ⚠️ **项目行不缩进、不带 `.symbol` 类**：它没有层级，`paddingLeft` 与文件行同一个 `10px`（用例钉住）。
> 11. **过滤是大小写不敏感的子串匹配，⛔ 不是模糊匹配、也不打分排序**（`filterProjects`，与 `filterSymbols` 同一条规矩）。⚠️ 匹配的是**完整路径**而不只是名字：用户记得住 `~/work/app`，只比名字的话打 `work` 会得到一个空列表，而那看起来像「这个项目没被记下来」。
>     - ⛔ **刻意不写第二套 TS 打分器**：文件那一半的模糊匹配在 Rust（`vela_core::project::index`），这里再写一套，同一个浮层里切一下模式就会换一套排序规则。
>     - 空串回全表：`Cmd+Shift+O` 刚打开时输入框是空的，那时该列出全部。
>     - ⚠️ 就地过滤**不发 IPC**，所以没有 debounce 也没有世代号——与文件那一路（每次按键一次 `query_project`）是两套机制，别照着改。
>     - ⚠️ **空清单的措辞分两种**：一条都没有时是「还没有别的项目：先用「文件夹…」打开一个，换过一次之后这里就有东西了」，打字之后没匹配上是「没有匹配的最近项目」。两句都说清了「下一步做什么」，而不是都回一句「无结果」。
> 12. 🔴 **踩坑：mock `loadSession` 的用例必须把三个 `#[serde(default)]` 键全写齐。** `Session` 现在是 `version, direction, focused, tabs, panes, project, recent, recentProjects`。少写一个 → `sessionSync.start()` 读到 `undefined` 抛 → **那个抛被它自己的 catch 咽下去变成一条 warn** → 恢复失败一半而用例照样绿，只有「另一份现场其实没装好」这件事没人看见。
>     - 实际炸了**三条**老用例（一条 M1-F 的会话恢复接线、两条 M2-B 的侧边栏接线），失败症状还各不相同：`sidebar()` 是 null、`statusName()` 变成 `空文档`、标签数不对。**根因只有一个**：`App.test.tsx` 里两处 session 字面量缺 `recentProjects`。
>     - ⚠️ 那条 catch 是对的（会话恢复在启动路径上，它失败不该把应用一起带走），所以**这个坑以后还会再踩**。规矩：`App.test.tsx` 里的 `savedSession()` 与 `archiveWith()` 两个工厂**必须**带齐这三个键，注释里已经写了理由。
> 13. ⚠️ **旧存档形状的兼容只在 Rust 一处**：`SessionProject::deserialize` 把 `{root, expanded}` 归一成 `{roots: [{root, expanded}]}`。⛔ **不 bump `SESSION_VERSION`、不写双形状**。
>     - 🔴 于是**前端 mock 出来的存档恒为新形状**——`loadSession` 是假的，压根不过 Rust。上面修正 12 那三条老用例之所以要改，不是因为形状变了，而是因为**少了键**。这两件事很容易被混成一件。
>     - ⚠️ **黄金 JSON 契约的字节数变了：696**（`src/ipc/session.test.ts:49` 那条 `GOLDEN_REPORT` 钉着，另有一条用例断言它等于 `GOLDEN_SESSION` 的 UTF-8 字节数）。以后动 `Session` 的字段顺序或名字，那个数会跟着变，而它会**失败得很响**——这一半是好的。
> 14. ⚠️ **恢复路径上的两个上限，只管恢复。** `MAX_RESTORED_ROOTS = 16`（`addRoot` **不设上限**——用户手动加多少个是他自己的事，而存档是磁盘上的 JSON）、`MAX_RESTORED_EXPANDED = 512`（**每个根**，不是总共）。
>     - 恢复走 `openMany`：**去重 → 截断 → 并行 `readLayers([''])`**。串行读会把切换拖成 N 次往返之和；去重是因为同一个根写两遍会造出两份各自维护的缓存。
>     - 🔴 **`Session.recentProjects` 是不可信输入**：它是一份从磁盘读回来的**绝对路径清单**，而它会被交给 `tree.openMany()` 挂成根。`restoreRecent` 丢掉空条目与重复、截到 `MAX_RECENT_PROJECTS = 12`。⚠️ 唯一的**写**方是 `rememberOutgoing()`，它的值只可能来自 `roots()`，而 `roots()` 只可能装对话框授权过的目录——所以「存档里出现一个没授权过的路径」只能来自用户手改存档，而那与手改 `project.roots` 是同一档风险，没有新增。
> 15. **数字**：Rust 测试 304 → **320**（vela-core lib 254 → **264**，wire_contract 32 → **37**，`vela_lib` 18 → **19**）；前端 1280 → **1414**（40 → **41** 个文件）。新增一个文件：`goto/projects` **13**；长起来的：`project/store` → **95**、`project/Sidebar` 67 → **75**、`project/tree` 48 → **53**、`goto/store` 50 → **64**、`goto/QuickOpen` 35 → **45**、`App` 86 → **93**、`builtins` 48 → **52**、`sessionSync` 29 → **35**、`ipc/project` 25 → **27**、`ipc/session` 27 → **28**、`search/store` → **109**、`doc/workspace` → **124**。命令总数 41 → **43**（`project.addFolder` / `project.openRecent`）。**八道门禁全绿**；首屏 gzip 250.60KB → **252.52KB**（`index-CSlnFeLY.js` 141.45 + `dist-Cx7xBNi0.js` 108.38 + `index-CWlMC48c.css` 2.69），预算 300KB，余量 **15.8%**。chunk 仍 **117** 个，`dist/index.html` 仍只引 **3** 个（⛔ `manualChunks` 一条都没加）。
>     - ⚠️ **Rust 侧一个新文件都没加**（`project/` 还是 `mod.rs` + `tree.rs` + `ops.rs` + `walk.rs` + `index.rs` 五个），新增的 16 条全在既有的四个模块里。⚠️ 前端**一个新 store 都没加**：`rootTree.ts` 是从 `store.ts` 里**搬出来**的一半，不是新写的一层。
>     - ⚠️ 前面几个 M 写的是「七道门禁」，这里数出来是**八道**：`cargo test` / `cargo fmt --check` / `cargo clippy -D warnings` / `tsc --noEmit` / `eslint .` / `prettier --check .` / `vitest run` / `vite build`（首屏体积那道闸）。⚠️ 别按七道来数，也别把 `prettier` 与 `eslint` 当成一道——`pnpm lint` 只跑 eslint，`format:check` 是另一条脚本。
>     - ⚠️ `npx vitest run --reporter=json` 会往 `.vitest/` 里写东西，而那个目录**没有被 gitignore**，于是它会当场弄脏 `prettier --check`。取每文件条数就用默认 reporter 的输出。
> 16. ⚠️ **jsdom 钉不住的债，在 M2-E 那一份之上再加**：多根侧边栏的观感（根行「从工作区移除」与「关闭文件夹」两种措辞在真实菜单里分不分得清、`N 个文件夹` 那个头标签、跨根的方向键导航走不走得顺、`.find-root` / `.palette-root` 两个前缀与它们的 `/` 分隔线在真实字号下够不够读）、`vela +2` 这种标签是不是一眼认得出「还有两个」、`⇧⌘O` 在命令面板里的显示、侧边栏 `+` 按钮的多选对话框（`pickDirectory({ multiple, directory: true })`，而 `multiple` **只在 `addViaDialog` 上开**——`openViaDialog` 一次只挑一个）、`onApplied` 在多根下把所有标签重读一遍。
>     - **以及 `Cmd+Shift+O` 在真 WKWebView 里不与系统行为冲突**——grep 证明了 CM6 与自建菜单都不占，**真窗口里还没按过**（与 `Cmd+P` / `Cmd+R` 同一条债）。
>     - 🔴 **以及上面那条验收债变贵了**：`index_project` 多根之下**逐个根串行重建**（刻意不并发，理由见 `commands.rs:796`），所以「10 万+ 文件」这个数要**乘上根的个数**。要量的是「N 个十万文件的根」，不是「一个」。

> **M2-G 实施修正**（2026-09-19，外部改动监听 M2-G-1~6 交付时改判/踩出来的，按重要性排）：
>
> 1. 🔴 **监听范围改判：盯的是「打开着的文件的父目录」，⛔ 不是项目树；侧边栏因此不自动刷新。** §3.4 那一行要的是「文件被外部修改时提示重载」，说的就是开着的那些文件。盯整棵树是**另一个功能**（侧边栏自动刷新），而它恰好落在 M2-A 那条教训的正上方：十万文件的仓库上，任何「对整棵树做点什么」的操作都是预算要去的地方。侧边栏今天有一个手动刷新按钮，那已经够用了。⚠️ **于是「在 Finder 里往项目里拖一个文件进来，树里不会自己冒出来」是已知行为，不是 bug**；要做也是 M4 的事，而且那时候要一并回答「debounce 多久」「展开着的那一层要不要跟着重排」「正在拖拽时刷新会不会把拖拽打断」三个问题。
> 2. ⛔ **不做「Vela 自己写盘的事件抑制表」。** 直觉上应该记一份「刚刚是我自己存的」然后把它滤掉，实际三条理由都不成立：① 保存成功 ⇒ 文档变干净 ⇒ `reload()` 读回来的字节与编辑器里那份**逐字相同** ⇒ `document.ts` 里那句 `if (changed) replaceText(...)` 让它成为一个**空操作**——连撤销栈与 `EditorState` 的对象同一性都不碰，可见成本是零；② 保存**失败**时脏标记还在，那一次弹窗是**该弹的**（磁盘上那份确实与手里这份不一致）；③ 一张抑制表的漏失效方式是「那个文件从此再也不会被提醒，而且是静默的」——正是这一层最该避免的失败方式。用例 `⛔ Vela 自己保存之后收到的那条事件不弹对话框，而且连撤销栈都不碰` 同时断言了「`openFile` 被调了第二次」（证明确实走到了静默重载）与「`snapshot.state` 的对象没换」。
> 3. 🔴 **`Remove` 不当「被删了」用：一律 `stat` 一次，在不在由 stat 说了算，事件种类只用来决定要不要看。** 规则只有一条（`vela_core::watcher::classify`）：`Other`（只读一类的动静、认不出来的）→ 不惊动任何人；其余三种，文件还在 → `changed`，文件没了 → `removed`。⚠️ **「说被删了但文件还在 → 算正文变了」不是兜底，是主要路径**：原子写盘（写临时文件 → rename 盖上去）在 FSEvents 上产生一对 `Remove` + `Create`，debouncer 合并成功是一条 `Modify`、没合并上就是先一条 `Remove`，而**本项目自己的 `save_file` 就是这么写的**。不做这次转换的话，用户每存一次盘就会看到一句「这个文件被删掉了」——一句关于他自己刚刚那次保存的假警报。反过来「说被写了但文件没了」也照同一条规则走（来自「建了又删」被合并成一条 `Created`）。
> 4. 🔴 **`Filter` 是一张「canonical → 前端原样字符串」的翻译表，而且值是 `Vec<String>` 不是 `String`。** 键必须 canonical（FSEvents 报上来的是内核眼里的路径），值必须原样（前端拿事件里的 `path` 去与 `doc.path()` 比，而那一个从来没被规范化过，理由与 `workspace.dirtyPaths` 上那条逐字相同）。macOS 上 `/tmp`、`/var` 都是指向 `/private/...` 的符号链接，所以少这一步的失败方式是**彻底的静默**：`/tmp/a.txt` 这个标签永远匹配不上 `/private/tmp/a.txt` 这条事件，不报错、不崩溃，只是外部改了文件而 Vela 一声不吭。值是 `Vec` 因为**一个 canonical 路径可以对应多个原样字符串**（一个符号链接与它的目标、同一卷的两个挂载别名），只留一个的话另一个标签就静默听不见了——那种现场会收到**两条**事件、指向两个不同的标签，而前端按标签处理，所以是对的。⚠️ **这条在 jsdom 里钉不住，只有真机上把文件放在符号链接底下才看得见。**
> 5. ⚠️ **一个目录订不上不会让整次调用失败，只记进 `WatchStats.failed` 继续走——与搜索/替换那条「一个根不合法就整次 reject」的规矩相反。** 理由是失败的方向不同：那边 reject 换来的是「用户知道这次没搜成」，这边 reject 换来的是「前端把整件事关掉，于是**所有**文件都不再被监听」——为了一个订不上的目录赔上其余十几个，方向是错的。⚠️ 代价是这份失败**不会自愈**（`plan` 照原样写回，下一次 diff 认为它已经订上了；真要重来一次得让那个目录先从清单里消失再回来），所以 `failed` / `skipped` / `truncated` 三个数字都必须让用户看见：`describeWatchStats` 把它们拼成一句「文件监听不完整：…。这些文件被外部改动时 Vela 不会提醒。」走窗口顶上那条提示。⚠️ 那句文案里**刻意不写 256 这个数**（Rust 的 `MAX_WATCH_DIRS`，两边没有代码生成），与 `goto/store.ts` 说索引截断那条同一个手法。
> 6. ⚠️ **`set_watched` 整个跑在 `spawn_blocking` 里，因为 `Debouncer::watch` 会同步枚举一层目录。** `notify-debouncer-full` 的 `FileIdMap::add_path` 对 `RecursiveMode::NonRecursive` 跑的是 `WalkDir::new(path).follow_links(true).max_depth(1)`——rename 检测靠这份 file-id 缓存。一个装了一万个文件的目录就是一万次 stat，网络卷上能到秒级，而那正是 `open_file` / `save_file` / `list_dir` 共用的那批 async worker 的位置。两把锁都包在 `Arc` 里也不是为了共享给别处，而是为了能**克隆进 blocking 池**（`State<'_, T>` 是个借用，`spawn_blocking` 要 `'static'`）。
> 7. 🔴 **踩坑：`new_debouncer` 的回调参数不写类型注解会炸成 `E0275: overflow evaluating the requirement &_: IntoIterator`。** 报错指向的是 trait 求解溢出，与「闭包参数没注解」这件事看起来毫无关系。必须写成 `move |result: DebounceEventResult|`（`DebounceEventResult = Result<Vec<DebouncedEvent>, Vec<Error>>`）。
> 8. **前端每次递的都是全量清单，⛔ 不是增量；diff 在 Rust 侧做。** 两边各记一份状态的话，「谁漏了一次调用」的失败方式是**永久性的静默失效**（那个文件从此再也不会被盯上，而且没有任何东西会说出来），而整份清单的最坏结果只是「多订阅一个目录」。⚠️ 递空数组 = **把监听整个关掉**（线程与订阅一起放掉），不是「什么都不改」；`stop()` 走的是同一条队列，所以「关掉」必然排在最后一次「订上」之后——**关窗口不等于退出**，那一下必须落地。
> 9. **清单在前端就是「去重 + 排序」的，于是拖拽重排标签与重复保存都不惊动 IPC。** `sameList` 逐元素比，`workspace.reorder()` 会换掉 `tabs()` 的数组同一性、让 effect 重跑，挡下那一次白跑的 IPC 的正是这道闸。⚠️ 排序也是 Rust 侧 `diff_dirs` 的前提：那是一次线性归并，两份清单都有序才有意义，否则同一个标签集合会因为 `HashMap` 的迭代顺序每次都 diff 出「全变了」。
> 10. ⚠️ **`createEffect` 必须在 owner 里同步创建，所以清单同步那个 effect 靠一个 `ready` 信号放行。** `start()` 里 `await listenFileChanged(...)` 之后已经跨过了一个微任务边界，那时 `getOwner()` 是 null，在它后面创建的 effect **不会跟着组件一起 dispose**——它会活到整个 `render` 的根被拆掉为止，而 Vela 的根就是整个窗口。于是顺序是：effect 在工厂函数里就建好（读 `ready()` 直接返回），`start()` 只在 `listen` 落地之后把 `ready` 翻成 true。⚠️ **先挂监听、再送清单**这个顺序本身也有用例钉住（`calls` 数组的第 0 项是 `listen`、第 1 项才是 `setWatched(0)`）：`listen` 是异步的，注册完成之前到达的事件**永久丢失**，而这一条比搜索/替换那两组更要紧——那两个漏了顶多是界面转圈不停，这一个漏了用户会在不知情的情况下用 ⌘S 把别人的改动盖掉。
> 11. **冲突队列的名字与路径是现读的，不是入队时的快照；死标签自动从队列里消失。** `live()` 那个 memo 每次都从活标签上取 `name` / `path`：等用户答复可能已经是几分钟之后，其间这个标签可能被另存为过（名字与路径都变了），而对话框上显示一个旧名字比不显示更误导。标签被关掉之后，它的条目在 `current` / `pending` / `resolve` 三处一起失效，另有一个 GC effect 把底层数组收干净（tab id 单调递增、永不复用，所以一条死条目不可能被重新加回来、也不可能被去重掉）。
> 12. **裁决框的三个按钮一个都不给 `.primary`——与 `DiscardDialog` 刻意不同。** 那里有一条明显更安全的出路（`.primary` 落在「保存」上），这里没有：「覆盖」「另存为」「保留」哪个对，取决于用户刚才在别的程序里做了什么，而 Vela 一点都不知道，给其中一个染上主色等于替用户猜。默认焦点仍然落在最右那一个安全动作上（`changed` 是「保留我的改动」、`removed` 是「保留标签」），于是「什么都不看直接按回车」不会扔掉任何东西；破坏性那一条靠 `.modal-warn` 那句话说，不靠颜色（与 `ReplaceConfirm` 同一条处理）。⚠️ **`ConflictChoice` 刻意只有一个 `keep`**，不拆成「保留我的改动」与「保留标签」——它们是同一个动作，两种措辞属于对话框而不属于类型。
> 13. 🔴 **裁决框与关闭确认互斥，而且关闭确认优先。** `resolve('closeTab')` 自己就会把 `DiscardDialog` 叫出来（脏标签要再问一次，那是唯一给「保存」留出路的地方），而两个 `.modal-backdrop` 同时在场会叠成两层遮罩——z-index 同为 10，谁在上面只取决于 DOM 顺序，被压在底下那个点不着。渲染门因此写成 `pendingClose() === null && fileWatch.current()`。用例断言的是 `querySelectorAll('.modal-backdrop')` 的**长度恒为 1**，以及答完「不保存」之后第二个冲突才露出来。
> 14. 🔴 **信任面：`set_watched` 是第十三条接受路径的命令，而它一个字节都不读。** 它拿这些路径只做两件事：订阅它们的父目录、把它们记进过滤器表。⛔ 没有 `File::open`，没有读，也没有写；事件推给谁的前提是「那个路径本来就在过滤器表里」，也就是前端自己递进来过的。⚠️ 所以「递一份恶意清单」的后果是**让 Vela 去盯一个用户没打开过的目录**，并把那个目录里被盯着的那些文件的变动事件发给 webview——事件里只有路径，没有内容。这与 `query_project` 收 `recent` 是同一档：扩大了「能看到哪些名字」，没有扩大「能读到哪些内容」。**M5 开放插件时这一条要跟着其余几条一起换成 `rootId`。**
> 15. ⚠️ **`watcher` 是第一个在树的两侧同名的模块**：`crates/vela-core/src/watcher/mod.rs`（纯函数：`plan_watches` / `diff_dirs` / `classify`，**一个 `notify` 依赖都没有**）与 `src-tauri/src/watcher.rs`（`notify` + debouncer + `WatcherState` + `set_watched` 命令）。`fs/` 那一对是 `fs/` ↔ `commands.rs`，名字不同，所以「grep `watcher` 会同时命中两边」这件事是 M2-G 才出现的。vela-core 不引 `notify` 的理由比 `trash` 不进 `project/ops.rs` 更硬一档：一个真的 watcher 在单测里既会漏文件描述符、又要等 FSEvents/inotify 的异步回调，于是「改一行断言、睡 200ms、偶尔红一次」会变成这一层的常态。⚠️ **「不含 notify」不等于「不碰文件系统」**：`plan_watches` 每个路径 canonicalize 一次，`classify` 的 `path_exists` 由调用方 stat 出来递进来——两者都是元数据级的一次系统调用，不起线程、不注册回调，所以在单测里是确定的。
> 16. **数字**：Rust 测试 320 → **350**（vela-core lib 264 → **281**，**+17 条全部来自 `watcher/mod.rs`**；wire_contract 37 → **38**；`vela_lib` 19 → **31**，+12 = `src-tauri/src/watcher.rs` 的 11 条 + `lib.rs` 里 `file_changed_event_matches_frontend` 那一条）；前端 1414 → **1486**（41 → **44** 个文件）。新增三个文件：`ipc/watch` **14**、`doc/fileWatch` **36**、`doc/FileConflictDialog` **14**；长起来的**只有一个**：`App` 93 → **101**。<br>⚠️ **命令中心总数 43 → 43，一条都没加**：这一整个功能是事件驱动的，没有入口可绑（`Escape` 在裁决框自己的子树里处理，与查找面板/浮层同一条规矩——命令分派挂在 `window` 的**捕获阶段**，拦不住）。<br>⚠️ Tauri 侧三个数各加一：command 16 → **17**（`set_watched`）、事件名 7 → **8**（`vela://file-changed`）、managed state 2 → **3**（`WatcherState`，前两份是 `TaskRegistry` 与 `ProjectIndexCache`）。<br>**八道门禁全绿**；首屏 gzip 252.52KB → **254.16KB**（`index-DDdjG689.js` 143.09 + `dist-Cx7xBNi0.js` 108.38 + `index-CWlMC48c.css` 2.69），预算 300KB，余量 **15.3%**。chunk 仍 **117** 个，`dist/index.html` 仍只引 **3** 个（⛔ `manualChunks` 一条都没加）。<br>⚠️ **CSS 的哈希与 M2-F 逐字相同**（还是 `index-CWlMC48c.css` / 2.69KB）：裁决框整套复用 `.modal-backdrop` / `.modal` / `.modal-title` / `.modal-body` / `.modal-warn` / `.modal-actions`，**一个新 class 都没加**，所以那 +1.64KB 全是 JS。
> 17. ⚠️ **jsdom 钉不住的债，在 M2-F 那一份之上再加**：裁决框的版式（三个按钮并排在 320px 最小宽度下挤不挤、全路径那一行在长路径下换行还是溢出）、`.modal-warn` 那句话与上面三段正文的层次够不够读、「后面还有 N 个文件要问」在 N 很大时要不要换成别的说法。
>     - 🔴 **以及真机上一个数都没有的那一半**：`notify` 在 FSEvents 下的**端到端延迟**（别的编辑器 ⌘S 到 Vela 弹出裁决框之间隔多久）与**漏事件率**，这两个数现在**一个都没有**——250ms 那个 debounce 窗口是按推理定的，不是量出来的。以及符号链接底下的路径（修正 4 那条**只有真机能验**）、网络卷与 Docker on M1 场景要不要退回 `PollWatcher`（风险登记册 R13）。
>     - 🔴 **以及 Vela 自己 ⌘S 之后到底弹不弹**：修正 2 那三条理由在 jsdom 里全钉住了，但「debouncer 有没有把那对 `Remove` + `Create` 合并上」取决于真机时序，**合并失败才是主要路径**（修正 3），所以这一条必须在真机上存十次盘看一次都不弹才算过。
>     - ⚠️ **Linux 侧另有一条**：`notify` 在 Linux 上走 inotify，而 inotify 的**每用户 watch 配额**（`fs.inotify.max_user_watches`）与 FSEvents 完全不是一个模型——配额满了会落进 `failed`，于是「监听不完整」那句话在 Linux 上会比 macOS 常见得多。CI 的 `rust` job 跑在 ubuntu-latest 上，而 `crates/vela-core/src/watcher/mod.rs` 里那些 `tempdir()` 用例会**真的建目录、真的写文件**（其中 `计划里的路径是_canonical_形式` 那条在 Linux 上两边相等、在 macOS 上 `/var` → `/private/var`，两种都算过）；它们不碰 `notify` 本身，所以不需要 runner 上有 watch 配额。

> **M2-H 实施修正**（2026-09-19，大文件只读分片 M2-H-1~6 交付时改判/踩出来的，按重要性排）：
>
> 1. 🔴 **`ropey` 整个方案作废，改成「稀疏行索引 + 按需读盘」——`ropey` 从未进过 `Cargo.toml`，`Cargo.lock` 里也一个字都没有。** §0 结论 3、§2.1 选型表、§2.4、§3.4 那一行、风险登记册 R5、附录 B 六处都写着「Rust 侧 `ropey` 持有全文」，全部改判。两条理由，第一条是硬的：
>    - **它与 §2.9 的预算直接打架。** 空转常驻内存的硬上限是 **200MB**（实测均值 104MB），而 `Rope::from_reader` 要把整份文件读进来——一个 500MB 的日志就是 500MB 常驻，打开它当场超预算两倍半。⚠️ 而且是**打开成功之后**才超，界面上看不出任何异常，用户只会看到 Vela 越来越慢。换成稀疏索引之后常驻内存与文件大小**脱钩**：256 MiB 的文件、10 字节一行，索引就是 `ANCHOR_STRIDE`（1024）一个锚点 8 字节 ≈ **210 KB**。代价是「跳到第 N 行」要从最近的锚点顺着扫过去，最多 1023 行——几十 KB 的读，比多驻留几百 MB 便宜得多。
>    - **另一半理由是「只读」。** `ropey` 值钱的地方是增量编辑（O(log n) 插入），而这个模式**按定义禁用编辑**，于是那份能力一个字节都用不上。为一个用不到的能力付一整个依赖 + 一份内存，不划算。M2-E 手写模糊匹配而没引 fuzzy crate 是同一条判断。
>    - ⚠️ **请求的单位跟着变了：行号窗口 `[start, count)`，不是 §2.4 原写的字节区间 `[startByte, endByte]`。** 字节区间要求前端自己知道行边界，而前端压根没有全文；行号才是虚拟列表天然的单位（`visibleWindow` 回的就是 `{start, end}`）。Rust 侧把行号翻成字节偏移，前端一个字节的偏移量都不持有。
>    - ⚠️ **附录 B 与 §2.1 里那条「ropey 1.6.1 MIT，已核实 Cargo.toml license 字段」是个陈旧条目**：license 本身没错（registry 里的 manifest 确实是 MIT），但它读起来像「这是我们的依赖」。已就地标注「它不是 Vela 的依赖」。M2-H 真正提为直接依赖的是 **`memchr` 2.8.3（Unlicense OR MIT）**，而它本来就在 `Cargo.lock` 里（`grep-searcher` 的传递依赖），所以这一步一个新 crate 都没拉进来。
> 2. 🔴 **「数 `0x0A` 的个数 = 数行」这条前提只在单字节安全的编码上成立，而 UTF-16 被明确拒绝。** UTF-8 的续字节是 0x80–0xBF，GBK 的尾字节是 0x40–0xFE（都不含 0x0A），所以 `0x0A` 在这两种编码里**永远不可能出现在一个字符内部**——数它等于数行，`memchr` 一趟扫完就够。UTF-16 打破这条（`"\n"` 就是 `0A 00`），于是 `open_shard` 在探到 `Utf16Le | Utf16Be` 时直接回 `ReadError::UnsupportedEncoding`，文案说清楚是编码的问题、不是文件坏了。⛔ **不退化成「按字节猜、猜错了显示乱码」**：那种失败方式是安静的，用户看到半截行而没有任何一个字段报警。⚠️ 另有三条口径与内联路径**刻意不同**且都写在 `shard.rs` 的模块文档里：行数按 `wc -l` 那一套（⛔ 与 CM6 差一行）、`anchors[0]` 是 BOM 长度（于是第 0 行不会带着 U+FEFF）、行尾**不剥** `\r`（前端按原样显示，`CRLF` 那一格由 `ShardHeader.eol` 说）。
> 3. 🔴 **分片里没有 ⌘F，而这条决定连带改了全局搜索的上限：`MAX_FILE_BYTES` 10 MiB → 64 MiB。** 用户在「要不要给分片加一个文件内查找」里选的是**不要，全局搜索已经够了**，而那个选项的措辞里明写着「那就得把搜索收文件的上限抬上来，抬到多少要一起定」。**抬到 64 MiB，不是 256 MiB**，理由是两个成本结构相反的功能共用同一个闸：
>    - **搜索是流式的**，一个 64 MiB 的文件只花**时间**不花内存（实测 10 MiB 是 6.9–8.5ms，线性外推 64 MiB ≈ 55ms、256 MiB ≈ 215ms）。⚠️ **外推不是复测**，与 `HEARTBEAT_MS`（250ms）的余量因此从一个数量级缩到 ~4.5×；真要把上限再抬，这一条得重量（§2.9 那一行也这么写）。
>    - **替换要把整份读进内存**（`expand_text` 先展开再原子写盘），峰值约**两倍文件大小**——256 MiB 就是 ~512 MiB 的瞬时占用，而 §2.9 那条预算是「空转常驻 < 200MB」（实测均值 104MB）。64 MiB 把峰值压在 ~128 MiB，还在预算内。
>    - ⛔ **不取 `MAX_SHARD_BYTES`（256 MiB）来对齐**，就是为了上一条。⚠️ 于是 **64–256 MiB 这一段是「打得开、搜不到」**，而且这段缺口是**有意的、不静默的**：计入 `SearchSummary::skipped_too_large`，前端摘要里说得出「有 N 个文件因为太大被跳过」。真要覆盖它，正确的做法是**给分片视图加一个走行索引的搜索**（索引已经在手，按锚点分段扫即可），⛔ 而不是把替换的内存峰值再抬四倍。
>    - ⚠️ **三个上限各管一件事，别混**：`MAX_INLINE_BYTES`（4 MiB，`fs/read.rs`）管单次 IPC payload；`MAX_FILE_BYTES`（64 MiB，`search/run.rs`）管「别为一个 2GB 的日志把整次搜索卡住」；`MAX_SHARD_BYTES`（256 MiB，`fs/shard.rs`）管「能不能以只读分片打开」。于是**一个 4–64 MiB 的文件搜得到、却是以分片方式打开的**，`shardView.ts` 的 `gotoLine` 与 `App.tsx` 的搜索结果跳转都在这条缝上工作。
>    - ⚠️ 顺手把两个 `huge.bin` 测试夹具改成 `set_len` 撑**稀疏文件**（这一个文件压根不会被读——大小闸排在读之前，而 `metadata().len()` 报的是逻辑长度），省掉每次 CI 真写 192 MiB。`run.rs` 里那个 `edge.txt` **必须是真的文本**（稀疏 = 全 NUL = 会被二进制探测拒掉），所以它照旧真写 64 MiB，vela-core 的套件仍然 2.93s 跑完。
> 4. ⚠️ **`MAX_PAGE_BYTES`（1 MiB）限制的是「从锚点起读了多少原始字节」，不是「回了多少行字节」，于是一条超长行会污染一整段锚点。** 具体现场：`read_page` 从最近的锚点 `seek` 过去、顺着扫到目标行，扫的字节数一旦撞到 1 MiB 就停手。一个 500 MB 的单行 JSON 意味着**从它所在的那个锚点往后、直到它结束之前的每一个 start 都取不出东西来**。处理方式是**认了这个洞，并且让它自愈**：前端拿到空页就在那些行上画 `GAP_TEXT`（「这一行太长，取不出来——继续往下滚会重新接上」），⛔ 不重试、不报错；一旦滚进后面一个锚点段（≤1024 行），读的就是一段正常数据，洞自己合上。⛔ **不把 `MAX_PAGE_BYTES` 抬到能装下一整行**：那等于把 §2.4 那句「绝不在 IPC 里传整个大文件」在最坏情况上重新打开一次，而一个 500 MB 的单行文件是真会遇到的（压缩过的 JSON、一行一条记录的日志导出）。⚠️ 这个洞**在 jsdom 里钉住了形状，但真机上没看过**（修正 12）。
> 5. 🔴 **五条分屏命令摘掉了 `when: (ctx) => ctx.editor !== null`，因为 `ctx.editor === null` 在 M2-H 之后换了意思。** 从前它只表示「没有聚焦的编辑器」，现在还多了一种：**聚焦的是一块只读分片**（`ShardPane` 压根不挂 `EditorController`）。门照原样留着的话，用户一打开大文件，`Mod+\` / `Mod+Shift+\` / `Mod+Alt+←→` / `editor.closePane` 五条**全部哑掉**，而工具栏那三个分屏按钮**看起来还是可点的**（它们的 `disabled` 只查 `MAX_PANES`）——一个能点、一个不响，是最难查的那类不一致。⚠️ **摘掉门不等于没有安全性**，安全性在 workspace 那一侧：`capture` / `focusPane` / `syncMetrics` 全是 `controller?.` 那一套写法。⚠️ 于是 `builtins.test.ts` 里 M1-C-1 那条不变式（「没有编辑器时所有 `editor.*` 一律置灰」）必须**收窄**：抽出 `PANE_COMMAND_IDS` 常量、把这五条排除在外，⛔ 但不删那条不变式本身——留着它，将来新增一条忘了写 `when` 的命令会当场红。同一个常量还被 M1-D-5 那组用（那一组要钉的是**相反**的事：五条照样分派到自己的 hook），清单写两遍的话哪天加第六条只会有一处被想起来。
> 6. 🔴 **「只读」这件事由三处一起表达，而其中一处是「压根不渲染」。** ① **一句提示都没有**：`too_large` 在这一层不是失败而是「换一条路」，界面上直接换成只读分片；说一句「文件太大」而屏幕上明明显示着内容，是自相矛盾。② **头部条上一个 `只读` 徽章**（`title` 里写全「不能编辑，也不能保存」），旁边那格常态写着「**不随外部改动刷新**」（修正 9）。③ **状态栏换成一整排只读的格子**：行数 / 大小 / 编码 / BOM / 换行符照显示，而**编码与换行符那两个 `<select>` 压根不渲染**，行列那一格也不显示。⚠️ ③ 是「**分片标签永远不会变脏**」唯一的守卫：一旦脏了就再也关不掉——关闭确认要保存，而 `save` 在分片上一律拒绝。<br>🔴 **还有一条顺序不变式：一个标签必须先离开 `tabs()`，再释放它的分片 fd。** `dropTab` 因此写成 `removeFromList(id)` 然后才 `doomed.doc.releaseShard()`；`restoreSession` 的 `releaseAllShards()` 紧贴在 `setTabs(fresh)` 之前。反过来的话，那个标签在两步之间既不在清单里、又还持着一个句柄，而 Solid 会在同一批里卸载 `ShardPane`——**它的 `dispose()` 也会调 `closeLarge`**，于是同一个 fd 被还两次。第二次不炸（Rust 侧句柄表查不到就静默返回），但「谁负责还」这件事从此没有唯一答案。⚠️ `closeLarge` 是 Vela 里**唯一一个不调就会漏**的收尾：漏了不会有任何症状，只是 fd 一直挂在那儿，开够多次就撞上 `TooManyOpenFiles`。
> 7. 🔴 **踩坑（真 bug，不是测试写错）：`removeFromList` 的整个函数体必须裹在 `batch()` 里，否则关掉一个分片标签会静默漏掉那个 fd。** 这个函数从前是两次分开的同步写：先 `setTabs(rest)` 把标签摘掉，再 `showIn(victim, ...)` 给那块分屏换上新标签。**两步之间有一个「某块分屏显示的标签不在 `tabs()` 里」的中间态。** M2-H 之前没人看得见它（`EditorPane` 只在 `onMount` 读一次 props，换标签不重挂）；M2-H 之后 `App.tsx` 在每块分屏外面套了一层 `<Show when={shardOf(pane)}>`，而 `shardOf` 查不到标签就返回 null → 那块分屏从「只读分片」翻成 fallback → 真的去挂一个新的 `EditorPane` → `paneState` 里那句 `tabs().find(...)!` 当场炸（`!` 的前提是「分屏新建时它的标签一定已经在 `tabs()` 里」，中间态正好破坏它）。<br>⚠️ **而炸点在 `closeTab` 这个 async 函数体内，所以它变成一个没人接的 rejected promise**：`dropTab` 后半句的 `releaseShard()` 再也跑不到，那个 fd 就这么漏了，**一点声音都没有**。发现它是因为 `App.test.tsx` 里那条 `expect(shardCmd.closed).toEqual([1])` 拿到了 `[]`，外加一条 `Unhandled Rejection`。⚠️ **同一个用例还暴露了我自己一条写错的期望**：修好 `batch()` 之后 `.cm-editor` 是 2 个而不是 1 个——关掉的是**标签**不是分屏，两块分屏都还在，而空出来的那块由 `removeFromList` 的 `free.length === 0` 分支补一个「空文档」进来（这条对分片和普通标签是同一条路，不是分片特有的例外）。**改的是断言，不是产品代码。**<br>⚠️ 顺带核过其余五个也写 `tabs`/`panes` 的地方（`split` / `closePane` / `newTab` / `activateTab` / `reorder` / 初始化），它们要么只有一次写、要么两次写的顺序不产生这个中间态，都不需要 `batch`。
> 8. ⚠️ **`createShardView` 里那个 `rows` memo 必须裹在 `createRoot` 里，并由 `dispose()` 显式拆掉。** 它唯一的调用点是 `document.ts` 的 `openAsShard`，而那已经在 `await openLarge(...)` 之后——**脱离了任何组件的 computation，没有 owner**。裸建一个 memo 的话 Solid 当场警告「computations created outside a `createRoot` or `render` will never be disposed」，而且警告说的是实情：没有 owner 就没人把它登记进 children 列表，`dispose()` 也收不到它。靠 GC 其实收得掉（它与外界只有 signal 那几条边），但那是「碰巧没事」而不是「被管住了」——而这个视图偏偏是 Vela 里**唯一一个不调 `dispose` 就会漏 fd** 的东西，它的拆解路径值得写得比别处更实。⚠️ **只裹 memo，不裹上面那几个 `createSignal`**：signal 不是 computation，裸建既不警告也不需要拆。⚠️ 回调参数**不能叫 `dispose`**（这个作用域里已经有一个 `function dispose()`，遮蔽了虽然也能跑，但读的人会以为是递归）。<br>📌 修完之后发现**三个测试文件**（`document.test.ts` / `workspace.test.ts` / `StatusBar.test.tsx`）里 mock 掉 `createShardView` 的理由注释全都写的是这条警告——那已经不是真理由了，三处一起改写成**当前**的理由：`createShardView` 建好就**立刻**要第一页，而那几个替身 `shardIpc` 里没有 `readLines`，真跑起来是一条没人接的 rejection。
> 9. 🔴 **分片路径整个不参与文件监听，而这是「一条规矩的两半」，不是一条兜底。** `fileWatch.ts` 里 `currentPaths()` **不把它列进清单**（于是压根不去订它的父目录），`onEvent()` 里**事件到了也扔掉**。⚠️ 两半都要，因为清单同步是异步的：一个标签从内联长成分片（文件被外部写到超过 4 MiB）的那一刻，摘订阅那次 `set_watched` 还在队列上，事件却已经能到了。只做一半的失败方式是「重开一次分片」——那是**整份文件重扫一遍**（重新建索引），而 M2-G 给普通文档定的静默重载之所以便宜，正是因为 CM6 那边只是一次 `replaceText`。面板上因此常态写着「**不随外部改动刷新**」（修正 6 的 ②）：这不是没说，是明说的已知行为。⚠️ `currentPaths()` 那个 effect 的依赖里必须有 `doc.shard()`，不然「内联 → 分片」这次转变不会触发重算。
> 10. 🔴 **信任面：`open_large` 是第十四条接受路径的命令，而与 `set_watched` 不同，它确实读内容——与 `open_file` 同一档。** `read_lines` / `close_large` 只收一个整数句柄；**句柄可猜不跨越任何权限边界**，因为同一个调用方本来就可以直接 `open_large(path)`。⚠️ **`ShardRegistry` 不是一张授权表**：四个 managed state（`TaskRegistry` / `ProjectIndexCache` / `WatcherState` / `ShardRegistry`）里没有任何一个记录「用户授权过哪些路径」，整条前提仍然是「没有远程内容」这个约定，而 `tauri.conf.json` 的 `csp` 还是 `null`。🔴 **M5 开放插件时这条推理必须重读一遍**：那时候 `open_large` 会变成只收 `rootId`，**句柄就成了唯一的入口，于是它必须不可猜**。⚠️ 另两条边界：`Shard` 把 fd 关在结构里（`Shard { header, index, file }`），于是「索引与内容来自同一个 inode」是结构上成立而不是一句注释；`Arc<Mutex<Shard>>` 而不是 `Shard`，因为 `read_page` 是 seek + read 两步，同一个分片上的两个并发请求会互相踩。所有 `Mutex::lock()` 一律 `unwrap_or_else(PoisonError::into_inner)`，而 release 是 **`panic = "abort"`**——一个越界索引就能带走整个 Vela 进程，所以 `read_page` 夹取每一个下标。
> 11. **数字**：Rust 测试 350 → **381**（vela-core lib 281 → **304**，**+23 条一条不差全在 `fs::shard`**；wire_contract 38 → **40**；`vela_lib` 31 → **37**，+6 = `src-tauri/src/shard.rs` 的句柄表用例）；前端 1486 → **1599**（44 → **47** 个文件）。新增三个文件：`ipc/shard` **14**、`doc/shardView` **35**、`doc/ShardPane` **23**（合计 **+72**）；长起来的是 `App` 101 → **106**、`doc/workspace` **132**、`doc/document` **25**、`doc/StatusBar` **25**、`doc/fileWatch` **41**（+分片排除那几条）、`commands/builtins`（条数没变，一条**翻转**、一条**收窄**，见修正 5）。<br>⚠️ Tauri 侧：command 17 → **20**（`shard::open_large` / `shard::read_lines` / `shard::close_large`）、事件名 **8 → 8**（⛔ 一个新事件都没加，分片是纯请求-响应）、managed state 3 → **4**（`ShardRegistry`）。<br>**八道门禁全绿**；首屏 gzip 254.16KB → **256.69KB**（`index-CNF4LQvD.js` 145.45 + `dist-Cx7xBNi0.js` 108.38 + `index-B0zf3Qrw.css` 2.86），预算 300KB，余量 **14.4%**。chunk 仍 **117** 个，`dist/index.html` 仍只引 **3** 个（⛔ `manualChunks` 一条都没加），`pnpm build` 806ms。<br>⚠️ **CSS 的哈希自 M2-F 以来第一次变**（`index-CWlMC48c.css` → `index-B0zf3Qrw.css`，2.69 → 2.86KB）：新增的是一整套 **16 条 `.shard-*` 选择器**，状态栏那几格复用既有样式。CM6 那个 modulepreload chunk **一个字节没动**（还是 108.38KB / `dist-Cx7xBNi0.js`）。<br>⚠️ **搜索那两条上限改动一条测试都没加**（350 → 381 里的 +31 全在分片这一侧）：改的是既有边界用例的**数字与断言消息**，以及把两个 `huge.bin` 夹具换成稀疏文件（修正 3）。
> 12. ⚠️ **jsdom 钉不住的债，在 M2-G 那一份之上再加一整层——M2-H 是一个视觉/手感功能，而视觉一半在 jsdom 里全是 0。** `clientHeight` 恒为 0（于是 `visibleWindow` 永远走「高度为 0 就给 OVERSCAN 行」那条分支，测试里靠一个本地 `fakeBox(el, height)` 撑着）、`scrollTop` 赋值是空操作、没有 `ResizeObserver`（组件改用 `window.addEventListener('resize', ...)`）。要真机上看的是：
>     - 🔴 **`open_shard` 建索引的冷读耗时**：那一趟顺序扫描（`SCAN_CHUNK` = 1 MiB）在文件**不在 page cache 里**时要多久，尤其在网络卷上。测试全部跑在热缓存上，一个冷读数都没有。这直接决定 §2.9「打开 10 万行文件 < 2s」那一行的分片半边算不算过。
>     - 🔴 **一个真·大文件端到端**：压缩过的单行 JSON、一行一条记录的日志导出。要看的除了「打得开」，还有**滚到底**要多久、以及修正 4 那个洞在真 WKWebView 里的样子（占位文案出现、继续往下滚之后**真的接上**）。
>     - 🔴 **整个 `ShardPane` 的视觉与手感**：18px 的行密度读一段日志累不累、7–9 位行号时 gutter 的宽度对不对齐、18px 行里塞 13px 字（再大就顶出去）的观感、长行的省略号、只读头部条挤不挤、**能不能从日志里选中并复制出来**（这是只读视图唯一还该有的交互）。
>     - 🔴 **分片被聚焦时的分屏/合并/切焦点**：`Mod+\`、`Mod+Shift+\`、`Mod+Alt+←→` 与三个工具栏按钮。修正 5 摘掉的就是这五条的门，而「按下去到底发生了什么」在 jsdom 里只断言到 hook 被调，**没有断言到画面**。
>     - 🔴 **在分屏里关掉一个分片标签**：那正是修正 7 那条 `batch()` 路径。jsdom 里它现在过了（`.cm-editor` 是 2 个、`closed` 是 `[1]`），但**真机上要确认那个 fd 真的还回去了**——`lsof` 数一数，别只看界面没崩。
>     - 🔴 **64 MiB 规模的真机搜索与替换**：修正 3 那两个数（≈55ms、~128 MiB 峰值）**一个是线性外推、一个是纸面算术**，都没量过。
>     - ⚠️ **开着分片时的 `phys_footprint`**：修正 1 那条「常驻内存与文件大小脱钩」是整个改判的地基，而它只在纸面上算过（≈210 KB 索引）。真机上开着几个大分片量一次，才知道前端那 8 MiB 的 `MAX_CACHE_CHARS` 页缓存在 WKWebView 里实际占多少。
>     - ⚠️ **UTF-16 那个拒绝**：修正 2 的 `UnsupportedEncoding` 有单测，但**真机上打开一个 UTF-16 的大文件**（Windows 上导出的日志很常见）看到的文案够不够说清楚，没验过。

---

### 3.5 M3 · Markdown + 内置工具（10–12 人日）

**目标**：差异化功能成型——这是 Vela 区别于普通编辑器的地方。

#### Markdown（4–5 人日）

| 工作项 | 人日 |
|---|---|
| 分屏预览 + 同步滚动（AST 源位置映射） | 2 |
| 大纲面板（标题层级导航 + 折叠 + 点击跳转） | 0.5 |
| 表格自动对齐 + GFM 任务列表可点击回写 | 1 |
| **图片粘贴自动落地**（存 `assets/` + 插相对路径，路径与命名可配置）<br>⚠️ **M3-A-7 部分兑现**：存 `assets/` + 插相对路径已落地，**「路径与命名可配置」推给 M4 的项目级配置**（见下面「M3-A-7 实施修正」2） | 0.5 |
| 链接补全、字数/阅读时长统计、导出 HTML<br>⚠️ **M3-A-6 只交付了这一行的后两样**：字数统计与导出 HTML 已落地（见下面「M3-A-6 实施修正」），**链接补全没做也仍未排期**（§2 那一行记着它与词补全的差别）。这一行的 1 人日因此是**部分兑现** | 1 |

#### 内置工具 P0（6–7 人日）

> 🔴 **M3-B 的范围被用户改判过**：原来这张表列的是 18 个工具，用户在「全做 / 只做高频 6 个」里选了后者，
> 并且**零新依赖**。下面这张表保留原样作为**当时的估算**，改判后的清单见「M3-B-1 实施修正」3。
> ⚠️ 表里那 18 个不是被删了，是被推到了「有人真的要再说」——`ToolDefinition` 那层描述符
> 加一个工具就是往 `src/tools/builtin.ts` 的数组里塞一项，框架不用再动。

| 工作项 | 人日 |
|---|---|
| ✅ 通用 `ToolPanel` 组件（左右分栏 + 声明式选项条 + 复制结果 + 与编辑器互通）<br>**M3-B-1 已交付**，但**不叫 `ToolPanel`、也不在侧边栏**：落地是 `src/tools/ToolBox.tsx`，一块 `Mod+Shift+T` 打开的居中大浮层。四样能力逐项对上：左右分栏（左栏按分类列工具、右栏工作台）、声明式选项条（`ToolDefinition.options` → 自动画出 text/number/select/toggle）、复制结果、与编辑器互通（「从编辑器取」/「插回编辑器」）。改判理由见「M3-B-1 实施修正」1 | 2 |
| 格式化类 5 个（JSON 格式化/压缩、JSON↔YAML、SQL、XML/HTML、Markdown 表格）<br>⚠️ **M3-B-2 只交付了这一行里的第一个**（JSON 格式化 / 压缩），另外四个按 M3-B-1 修正 3 推给「有人真的要再说」。这一行的 1.5 人日因此是**部分兑现** | 1.5 |
| 编解码类 5 个（Base64 文本/图片、URL、HTML 实体、JWT、Unicode 转义）<br>⚠️ **M3-B-3 交付了这一行里的前两个**（Base64 文本 + URL，合成一个工具），**Base64 图片那半推给 M4**，另外三个按 M3-B-1 修正 3 推给「有人真的要再说」。这一行的 1 人日因此是**部分兑现** | 1 |
| 生成器类 3 个（UUID/ULID/NanoID、哈希走 Rust 侧、时间戳互转）<br>⚠️ **M3-B-4 交付了 UUID（只 v4）与时间戳互转（无 IANA 时区选择器）**，⛔ ULID / NanoID 推给「有人真的要再说」，⛔ 哈希那一格压根不在用户选的 6 个里、一行没写。这一行的 1 人日因此是**部分兑现**（与上面「编解码类」那一行同一种记账） | 1 |
| 测试器类 3 个（正则测试器、文本 Diff、JSONPath）<br>⚠️ **M3-B-5 交付了正则测试器，而它自己就是部分兑现**：分组捕获 ✅、替换预览 ✅、⛔ **实时高亮没做**（用户选的，理由见「M3-B-5 实施修正」1），⛔ 也没有超时中断（同 11）。另外两个按 M3-B-1 修正 3 推给「有人真的要再说」。这一行的 1 人日因此是**部分兑现**（与上面「编解码类」「生成器类」两行同一种记账） | 1 |
| 文本类 2 个（命名风格转换、Cron 解析）<br>⚠️ **M3-B-6 只交付了命名风格转换**，Cron 解析按 M3-B-1 修正 3 推给「有人真的要再说」。这一行的 0.5 人日因此是**部分兑现**（与上面四行同一种记账） | 0.5 |
| **智能检测**（粘贴内容自动识别并推荐工具） | 0.5 |

**验收**：JSON 格式化、时间戳转换、正则测试三个高频工具的操作路径 **≤ 2 次按键**（`Cmd+P` 直达）。Markdown 文档写作体验可替代 Typora 的日常用途。

> ⚠️ **这条验收判据的括号写错了，但结论没变。** `Cmd+P` 是**跳转浮层**（M2-E，找文件/找标题），
> 里面压根没有工具；工具的两条路是 `Mod+Shift+T`（工具箱，1 次按键到浮层 + 1 次 `Enter` 换工具 = **2 次**）
> 与 `Mod+Shift+P`（命令面板搜工具名，1 次到面板 + 1 次 `Enter` 执行 = **2 次**）。
> 两条都正好卡在 ≤ 2 次按键上，所以判据满足，但**靠的不是原文写的那个键**。
> ✅ **进度（2026-09-20，M3-B-5 收尾）**：三个高频工具**全部交付**——JSON 格式化（M3-B-2）、
> 时间戳转换（M3-B-4）、正则测试（M3-B-5），两条路各 2 次按键的口径对三个都成立。
> ⚠️ 于是这一条验收判据**结案**，而它自始至终没有靠原文写的那个键。
> 🔴 **M3-B-6 收尾时用户选的六个已全部落地**（Base64 / URL 编解码 M3-B-3、UUID M3-B-4、命名风格转换 M3-B-6），
> 两条路各 2 次按键的口径对六个都成立——那三条只是判据点名的样本，⛔ 不是被优待的三个。
> 🔴 这也是「不给单个工具绑快捷键」那条决定的依据：绑了键是 1 次按键，可六个工具就要吃掉六个
> `Mod+Shift+*`，而判据本来就过了。

> **M3-A-5 实施修正**（表格对齐 + GFM 任务列表回写，2026-09-19）
>
> 1. 🔴 **改判：只做「一条命令」，不做「编辑时自动」。** §2 功能表那一行原写的是「编辑时自动补齐 `|` 与对齐空格，格式化命令可调」（PLAN 第 162 行），落地时**砍掉了自动那一半**，只留 `Mod+Shift+A`。三个理由：① **IME**——中文输入法组词期间文档里是一串带下划线的临时文本，每一次 `compositionupdate` 都触发整表重排会把正在组的词打散；② **横向抖动**——一边打字一边重排，光标右边所有列都在动，而人正在看的恰恰是那一列；③ **①② 在 jsdom 里一个都验不了**（没有输入法、没有布局），做了自动那半就只能靠用户在真机上判断它烦不烦，而那正是「能自动化的别推给用户」的反面。⛔ 同理砍掉「回车自动补一行」「Tab 跳下一格并补齐」——它们与自动对齐是同一类手感功能，吃同一批理由。**§2 那一行以此为准：Vela 的表格对齐是一条命令，不是一个输入模式。**
> 2. **实际落地的三样**：`editor.alignTable`（`Mod+Shift+A`，第 **46** 条命令，**不设 `when`**，理由与 `togglePreview` 逐字相同——设了 gate 的话按下去什么也不发生，用户得到的信息是零）+ `src/md/table.ts`（按**显示宽度**对齐，逐行替换而非整块替换）+ 预览里的 GFM 勾选框可点回写（§2 第 163 行「点击回写源文件」原样交付）。
> 3. 🔴 **依赖方向是 `render` → `table`，不能反过来。** `Align` / `parseAlignments` 原来住在 `render.ts`，这次搬进了 `table.ts`：对齐是**首屏命令**，而那个 41KB 的渲染器在 M3-C 里要变成预览专用的懒加载块；让 `table` 反过来 import `render`，按一下 `Mod+Shift+A` 就把整个渲染器拖进首屏。
> 4. 🔴 **`displayWidth` 的 2:1 是借来的，与 §3.3「M1-G 实施修正」4 那个未决项绑死。** 中文表格按设计走 Maple Mono CN（D2 把 `Table` 划进 `CODE_BLOCK_NODES`），实测 CJK/ASCII = **2.0000**，所以「一个汉字算两格」成立。**要是哪天用户拍板把 `Table` 移出代码区**（M1-G 修正 4 留给用户的那条杠杆），表格正文会落到文楷 Screen 上，而它的 CJK/ASCII 实测是 **1.66639**——对齐会在真实排版里歪掉，而**所有测试照样全绿**（`displayWidth` 是纯函数，量的是「应该几格」，不是「屏幕上几格」）。改那条决定时必须一起改 `table.ts`。
> 5. ⚠️ **`SymbolTable` 没有 `partial`，`table.ts` 继承了同一个洞。** 一份大 Markdown 可能只解析了前半截（`ensureSyntaxTree` 的 `ALIGN_PARSE_TIMEOUT_MS` = 50ms），落在后半截的表就找不到，而命令会如实说「光标不在表格里」——不是错话，但也没说出「因为文档太大」。与 `OutlinePanel.tsx` 文件头记的是同一件事，一起留到有人真的撞上再说。
> 6. ⚠️ **勾选框回写是预览面板**唯一**一处反向写**，`md/panel.ts` 原来那句「两个面板都只读不写」已改口。边界写清楚：它只读 `render.ts` 早就写好的 `data-pos` / `data-checked` 两个属性，**一个字节的新 HTML 都不加**，所以 M3-A 那条 `innerHTML` 安全边界一点没动；回写前有 `TASK_MARKER` 复核（`data-pos` 是**渲染那一刻**的偏移，而面板有 150ms 防抖，过期偏移只重画、不改字）；`[ ]` ↔ `[x]` 是**等长**替换，所以全文其它勾选框的偏移一个都不用重算。⛔ 不要顺着这条先例再加别的「在预览里直接改正文」的入口：预览里没有光标、没有选区、也不画改动边界。
> 7. **数字**：前端 1888 → **1943**（55 → **56** 个文件）。M3-A-5 自己 **+55**：新增 `md/table.test.ts` **35**、`MarkdownPreview.test.tsx` 13 → **25**、`App.test.tsx` 128 → **134**、`commands/builtins.test.ts` 60 → **65**，`md/render.test.ts` **−3**（那 3 条 `parseAlignments` 搬进了 `table.test.ts`，与被测代码同家）。Rust **381 一条没动**——这一项是纯前端。命令 45 → **46**，Tauri command / 事件名 / managed state **一个没加**。<br>首屏 gzip 263.69KB → **265.70KB**（`index-H26iUtQM.js` 153.63 + `dist-Cx7xBNi0.js` 108.38 + `index-vUpS-3W0.css` 3.69），预算 300KB，余量 **11.4%**（上一次 12.1%）。**CM6 那个 chunk 的哈希与字节一个没动**（还是 `dist-Cx7xBNi0.js` / 108.38KB）——新增的 2.01KB 全在 `index` 里，正是第 3 条那个方向换来的。CSS 3.68 → 3.69KB（`.md-task` 的 `cursor: pointer` 与 `:focus-visible`）。**八道门禁全绿**，`stderr` 干净。
> 8. ⚠️ **真机上要看的（jsdom 钉不住，一个数都没有）**：① 🔴 **一张中文表在 WKWebView + Maple Mono CN 里是不是真的齐**——第 4 条那个 2:1 就是为它写的，纸面上量不出来；② 🔴 **点勾选框那一下看不看得出来**（框有没有立刻重画、焦点还在不在、空格会不会顺带滚一屏）；③ 🔴 **无色 `.notice` 的观感**——它既不是错误也不是成功（三句话是「光标不在表格里」/「这张表已经对齐了」/「这块分屏里没有可对齐的表格」），染成 `warning` 会让「按错了键」看起来像故障，染成 `ok` 会让「已经对齐了」看起来像刚改了什么，所以选了无色，但**颜色对不对只能看**；④ ⚠️ `Mod+Shift+A` 在一张几百行的表上的耗时（50ms 解析预算 + 一次全表重排 + 一次 dispatch）。

> **M3-A-6 实施修正**（字数/阅读时长统计 + 导出 HTML，2026-09-19）
>
> 1. 🔴 **改判：字数统计是一条命令（`Mod+Shift+C`），不是状态栏的一格。** §2 那一行原写的是「字数、字符数、阅读时长」，读起来像是状态栏常驻，落地时**没有**放进状态栏。理由是成本而不是位置：`syncMetrics`（`doc/workspace.ts`）在**每一个事务**上跑，包括只动了光标的那些，而它读的历来全是 O(1) 的 rope 值（`doc.lines` / `doc.length` / `lineAt` / `indentUnit`）；字数是一次**全文扫描**加一次 `doc.toString()` 全文拷贝，塞进去等于每敲一个键、每移一次光标就重扫一遍。也考虑过「防抖 150ms 后更新状态栏」：那压得住频率，压不住**观感**——一个在你停下来之后自己跳一下的数字，比一个要按键才出来的数字更像 bug（而防抖那 150ms 里它显示的还是上一份文档的数）。参照物是 Sublime 的 Word Count：也是一条命令，也落在一个临时位置。**这条纪律钉在两处**：`src/doc/stats.ts` 的文件头写全文论证，`App.test.tsx` 里有一条 `🔴 字数不进状态栏` 直接断言状态栏那几格里没有它。
> 2. ⚠️ **中文逐字符、西文逐词，两个口径不能混。** 只按「非空白字符」数的话英文一篇 500 词的文章会报出 3000「字」；只按 `\w+` 分词的话中文一整段是 1 个「词」。两个错法都是**静默**的——数字看着像个数字，不像错。落地口径：CJK 用 `CJK_RE` 数字符，西文用 `replace(CJK_RE, ' ')` 先把中文挖成空格再按 `\p{L}\p{N}\p{M}` 分词，两者相加。⚠️ **U+3000（全角空格）刻意排除在 CJK 区间之外**（区间从 `3001` 起），否则用全角空格缩进的文档字数会虚高；而**中文标点算字数**（Word / 知乎 / 微信都是这个口径）。阅读时长按 **300 字/分钟（中）+ 200 词/分钟（西）**分别折算再相加，空文档报 0 而不是 1。
> 3. 🔴 **导出件用系统字体栈，⛔ 不嵌霞鹜文楷。** §2 那一行原写的是「内联样式单文件导出」——内联的是**样式**，不是字体。两个理由：① **OFL 的保留字体名那笔账还没结**（上游声明了 `Reserved Font Name '霞鹜'…'LXGW'`，而 OFL FAQ 明确说子集化产生 Modified Version、不得沿用 RFN、**没有 webfont 豁免**，见 §3.3「M1-G 实施修正」），一个导出功能不该悄悄替它结账；② 嵌了字体的「单文件」是 MB 级的，那正好把这个功能的意义抵消掉。所以 `EXPORT_STYLE` 里**一个 `@font-face` 都没有**，正文走 `-apple-system / PingFang SC / Microsoft YaHei / Noto Sans CJK SC`，代码走 `ui-monospace / SF Mono / Menlo / Consolas`。这条被 `md/export.test.ts` 钉住（断言导出件里搜不到 `@font-face` / `LXGW` / `霞鹜` / `Maple` / `data:`）。
> 4. 🔴 **导出的安全边界与预览是同一条，没有放宽。** 那份 HTML 里的每个字节仍然出自 `src/md/render.ts` 的白名单与转义（`bodyHtml` **原样**塞进 `<main>`，正因为它是 render 产的；`title` 是另一个输入，走 `escapeHtml`），⛔ `export.ts` 里**不做任何「顺手清理」**——在 render 那一整套用例看不见的地方改字节，正是边界失守的方式。⚠️ 而且导出件的**影响面比预览更大**：它是在浏览器里打开的，一份带脚本的 HTML 被用户邮件发出去就是一个可执行文件。所以还有一条**跨模块**用例（`App.test.tsx`）：源文档里写 `<script>alert(document.cookie)</script>`，断言写进 `saveFile` 的那份 HTML 里搜不到 `<script`、但搜得到 `&lt;script&gt;`（它被降级成了 `<pre class="md-raw">` 里的文字）。
> 5. 🔴 **导出件里刻意一个脚本都没有**，于是 M3-A-5 那个可点勾选框在导出件里是**死的**（`.md-task` 的 `cursor` 也从 `pointer` 改成了 `default`）。这不是遗漏：勾选框能点是靠 `MarkdownPreview.tsx` 上的事件委托，而导出件是静态文件；要让它在导出件里也能点就得往里塞 JS，那与第 4 条正面冲突。
> 6. ⚠️ **`partial` 一律拒绝导出，⛔ 不「先导前半截」。** `previewHtml` 回 `partial: true` 的意思是 `ensureSyntaxTree` 在 200ms 内没解析完、渲染出来的是**半截树**。预览里出半截可以——旁边就是源文件，用户看得见少了什么；导出件不行，收到它的人手上没有源文件，他看到的是一个「结尾莫名其妙没了」的网页并且会认为那就是全文。⚠️ 这一支在 jsdom 里**测不到**（`ensureSyntaxTree` 在那儿总是同步解析完，碰不到 200ms 预算），已在 `App.test.tsx` 里如实注明，不假装覆盖了。
> 7. 🔴 **`Mod+Shift+E` 与 `Mod+Shift+C` 此前都是空的**，取证方式是 `grep -ohiE "Mod-Shift-[cew]|Ctrl-Shift-[cew]" node_modules/@codemirror/*/dist/index.js node_modules/@lezer/*/dist/index.js` → 零命中；⚠️ 同一批里 `Mod-Shift-l` **是**有命中的，所以那次搜索本身是通的（一个只跑「期望零命中」的 grep 无法区分「真没有」与「搜错了」）。⛔ **不绑 `Mod+Shift+W`**（W = Word 更顺）：macOS 上它是系统的「关闭所有窗口」，事件到不了 webview，与「合并分屏」不绑 `Mod+W` 是同一条理由。🔴 **后半句已被 M3-B-1 兑掉**：`Mod+Shift+P` 现在是 `commandPalette.open`、`Mod+Shift+T` 现在是 `toolbox.open`，两个键的用例都从「无人占用」翻转成「占用且命中这一条」；**只剩 `Mod+Shift+R` 空着并被钉住**。
> 8. ⚠️ **`editorNotice` 从 `string | null` 变成了 `{ level, text } | null`。** 一次**写盘**必须能看起来像成功或失败：「导出失败：…」与「光标不在表格里」用同一个灰色的话，用户会以为那只是一句提示，然后照着一个**不存在**的路径去找文件。三档：`plain`（M3-A-5 那三句 + M3-A-6 那四句拒绝，渲染成**光秃秃的** `class="notice"`——⛔ 不是 `notice plain`，`styles.css` 里没有 `.notice.plain` 这条规则）、`ok`（已导出到 …）、`error`（导出失败：…）。同时补上了 `App.tsx` 里**早就写着却没有代码兑现**的那句「切个标签这句话就该消失」（一条 `createEffect(on(() => ws.activeTab().id, …, { defer: true }))`）——提示条说的永远是「此刻这一块」，让它跟着标签走的话屏幕上挂着的是**另一个文档**的字数，一个自信地错着的数字比空着更糟。
> 9. **数字**：前端 1943 → **2017**（56 → **58** 个文件）。M3-A-6 自己 **+74**：新增 `doc/stats.test.ts` **27**、`md/export.test.ts` **27**、`commands/builtins.test.ts` 65 → **71**、`App.test.tsx` 134 → **148**。Rust **381 一条没动**（37 + 304 + 40）——这一项是纯前端。命令 46 → **48**（`file.exportHtml`、`editor.wordCount`），🔴 **Tauri command / 事件名 / managed state 一个没加**：导出复用**已有的** `save_file`（同一条原子写盘路径），目标路径只来自 `plugin-dialog` 的保存选择器，所以**路径接受面没有变宽**。新增依赖 **0**。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 265.70KB → **268.18KB**（`index-ZcU4rPts.js` 156.11 + `dist-Cx7xBNi0.js` 108.38 + `index-vUpS-3W0.css` 3.69），预算 300KB，余量 **10.6%**（上一次 11.4%）。**CM6 那个 chunk 的哈希与字节一个没动**，CSS 也没动——新增的 2.48KB 全在 `index` 里，因为 `App.tsx` 现在是**静态** import `./md/export`、`./md/preview` 与 `./doc/stats` 的。⚠️ **M3-C 做懒加载时必须把 `export.ts` 一起圈进去**（它 import `render.ts` 的 `escapeHtml`，所以让 render 变懒会自然把 export 带走，那是对的——导出本来就是按需的）。
> 10. ⚠️ **真机上要看的（jsdom 钉不住，一个数都没有）**：① 🔴 **导出件在真浏览器里长什么样**——46em 的行长、CJK 字体在 macOS 与 Windows 上的回退结果、`@media print` 那一段、以及那个死掉的 `.md-task` 勾选框**看不看得出它点不动**（`cursor: default` 是唯一线索）；② 🔴 **系统保存对话框的 `filters`**（`[{ name: 'HTML', extensions: ['html','htm'] }]`）在 macOS 上是不是真的把后缀限制住了，`defaultPath` 只给文件名时对话框落在哪个目录；③ ⚠️ 一份几十万字文档上 `Mod+Shift+C` 的耗时（一次 `doc.toString()` 全文拷贝 + 两趟正则）；④ ⚠️ 提示条三档颜色在真实主题下的观感（`ok` 用的是 `--vela-accent`，而默认主题是暗色 Tokyo Night）。
> 11. ⚠️ **记账欠账**：M3-A-1（`md/render.ts`）、M3-A-2（`md/outline.ts`）、M3-A-3（预览面板 + 同步滚动）、M3-A-4（大纲面板）这四项**没有各自的实施修正块**——它们与 A-5、A-6 一样都还在工作区里没提交，`git log` 上拿不到分项的测试数与体积数，事后也无法如实重建。本节现有的分项数字是从 A-5 那次开始记的；A-1~A-4 的交付内容以 §2 功能表那几行与源码文件头为准。

> **M3-A-7 实施修正**（图片粘贴自动落地，2026-09-19）
>
> 1. 🔴 **改判：不接拖放，只接粘贴。** §2 那一行原写的是「`Cmd+V` 截图」，落地时**严格只做了 `Cmd+V`**，`EditorView.domEventHandlers` 里那个 `drop` 键**刻意不填**。理由不是偷懒：拖一个文件进编辑器，用户意图有「把这张图插进来」与「打开这个文件」两种，而 Vela 的拖放语义（`openAt`）已经是后者了；两种意图撞在同一个手势上，猜错的那一半是**静默**的（图没插进来，或者一个正在写的文档被换掉了）。截图粘贴没有这个歧义——剪贴板里除了那张图什么都没有。
> 2. ⛔ **「路径与命名可配置」没有交付，推给 M4。** 那一半依赖 `.vela/settings.json` 项目级配置，而 M2-F 时用户在「M2-F 里做 / 推到 M4」两选一里选了后者（见 §3.4「M2-F 实施修正」1）。⚠️ **M4-A 已把配置管线与「项目安全档」的接缝建好，但那个资产目录键还没接进去**——`md/paste.ts` 仍写死，它是项目安全档的第一个候选成员（见 §3.6「M4-A 实施修正」8）。所以现在是**写死的**：目录 = 文档所在目录下的 `assets/`（`ASSET_DIR`），文件名 = `pasted-<16 位十六进制内容哈希>.<ext>`（`NAME_PREFIX`），撞名换后缀（`MAX_SUFFIX` = 32）。⚠️ 哈希命名带来一个**好性质**：同一张图粘两次只落一个文件，第二次直接复用（`StoredImage.reused: true`），而且**不说话**——插进正文的那行链接就是全部反馈，与 M3-A-5「对齐成功了就不该说话」同一条口径。⚠️ 真接配置时必须回头改 `md/paste.ts` 里那句「rel 不含空格、括号或引号所以不需要 `<>` 包裹也不需要转义」——命名规则一旦可配置，那句话就不成立了。
> 3. 🔴 **落地的图片在 Vela 自己的预览里不显示，导出的 HTML 里也不显示。** 这是 M3-A 那条安全边界的**直接后果**，不是 bug：`src/md/render.ts` 把本地图片映射成 `<span class="md-img-local">` 占位符，从不输出 `<img>`——`file:` 不在允许的 scheme 里，而 `tauri.conf.json` 的 `csp` 是 `null`，白名单 + 转义就是**全部**防线。要让它显示得启用 Tauri 的 asset protocol，那是一次主动扩大攻击面（一个能被诱导渲染任意本地文件的预览面），**M3-A-7 刻意不做**。链接在 GitHub / Typora / 任何别的渲染器里都能用。**这句话必须原样告诉用户**，否则「粘了图但预览里是个灰框」看起来像是坏了。⛔ 也不要顺着这条先例去改 `render.ts` 的 scheme 白名单：那 28 个标签与那个白名单是 `md/render.test.ts` 在看的唯一边界。
> 4. 🔴 **剪贴板里同时有正文的时候一律不接。** 从网页上复制一段带插图的文字，`text/plain` 与一个图片文件**同时**在剪贴板里，那时用户要的是文字。要是把图接了，paste 处理器返回 `true`，CM6 就不再插那段文字——用户的复制**凭空少了一半内容**，而且没有任何提示。反过来（只接「没有正文」的粘贴）的失败方式是**安全**的：从 Finder 复制一个文件时有些系统会把路径也放进 `text/plain`，那次粘贴会退化成「插入一段路径文字」，内容是少了图，但一个字都没丢，而且看得见。
> 5. ⚠️ **格式白名单只在 Rust 侧，前端一律不复制。** 前端只看 MIME 前缀（`image/*` 全接），真正的判断是 `fs/asset.rs` 的**魔数嗅探**。复制一份白名单的话，「Rust 收了但前端没接」与「前端接了但 Rust 拒了」两种不一致都会出现，而**前一种的失败方式是粘贴什么都没发生**——没有报错、没有提示、光标闪一下。于是 SVG 会被前端接住、被 Rust 拒绝、然后**在通知里说清为什么**（「SVG 是 XML，能带脚本」）。一句解释永远好过一次静默。同一条理由管着 HEIC / AVIF。
> 6. 🔴 **`store_image` 是第 15 个接受路径的命令，也是第 2 个会写的**（第 1 个是 M2-D 的 `start_replace`）。它的收窄方式与两者都不同：**目标路径不是参数**。Rust 侧只收 `doc_path`（当前文档，用来推目录）与 `data_base64`，⛔ 没有任何「目标目录」「文件名」入参，目录名是常量 `assets`，文件名由内容哈希生成，所以它能写的只有 `assets/pasted-*.{png,jpg,gif,webp,bmp}` 这一种形状——写不进 `.md`、写不进 `.zshrc`、也覆盖不了任何已有文件（撞名就换后缀）。`commands.rs` 那段 XSS 论证已按此扩写。⚠️ M5 开插件时它要与其余 14 个一起换成 `rootId` + Tauri managed state。
> 7. 🔴 **CM6 没有 `EditorView.handlePaste`。** 原设计写的是 `EditorView.handlePaste.of((view, event) => …)`，而 `@codemirror/view@6.43.11` **没有导出这个 facet**（`grep` 过 `dist/index.d.ts` 与 `index.js`：只有 `clipboardInputFilter`，那个是改文本的，拿不到文件）。实际用的是 `EditorView.domEventHandlers({ paste(event, view) { … } })`，⚠️ **参数顺序是 `(event, view)`，与 facet 相反**。这个方案依赖 CM6 的**两条实现细节**（都在 `index.js` 里核对过，⚠️ 不是文档承诺的契约）：① `computeHandlers` 把**插件提供的**处理器排在内置那张表**之前**，所以返回 `true` 真的能拦下内置的 `handlers.paste`；② `runHandlers` 在处理器返回 `true` 时自己调 `event.preventDefault()` 并 `break`。正因为这是实现细节，`editor/paste.test.ts` 里那 5 条用例是**真的派发 DOM `paste` 事件**然后看正文有没有被插入——哪天 CM6 改了顺序，用例会当场红，而不是等到用户的截图变成一串文件名。
> 8. 🔴 **钩子必须同步回答「接不接」，落地是异步的。** paste 处理器的返回值决定 CM6 要不要 `preventDefault`，那一刻之后的任何异步都来不及。于是 `pasteImageInto` 答的只是「**这份文档该不该接**」（`languageFor(path).kind === 'markdown'`，⛔ 不在 `md/paste.ts` 里重写一遍扩展名正则——语言分派是**唯一真相来源**，重写一份的结果是「高亮认它、粘贴不认它」），答完 `true` 就把剩下的交给 `void landPastedImage(…)`，成没成通过 `editorNotice` 说回话。⚠️ 未命名草稿的 `path` 是 `null` 而 `languageFor(null)` 答 Markdown，所以草稿**会被接住**，然后在第一条拒绝里说清「先存一次（⌘S）」——图片要落在文档旁边的 `assets/` 里，一份没存过的草稿没有目录可推，让它落到工作区根或临时目录都会产出「存了文档之后链接就断了」的坑。
> 9. ⚠️ **四种拒绝全都要说出口，而且分两档色。** `PasteTarget.notify` 带 `level`，`plain`（这份文档不是 Markdown / 还没有路径 / 图片超过 32 MB）与 `error`（SVG 不收 / 没有写权限 / 读不出字节）。「先存一次」与「磁盘写不进去」在用户眼里不是一类事，前者什么都没坏，染成故障色会让一次正常的粘贴看起来像 Vela 出了问题（M3-A-5 立下的同一条口径）。⚠️ 落地**成功时一句话都不说**，`ok` 这一档压根不存在。⚠️ 大小检查在 `arrayBuffer()` **之前**：从 Finder 复制一个 2 GB 文件再粘进来是会发生的事，那时先把 2 GB 读进 webview 内存再交给 Rust 去拒，界面已经卡死过了（Rust 侧还有一道同样的 `MAX_IMAGE_BYTES` = 32 MiB 检查，那一道管「字节真的超了」，这一道管「连读都别读」）。
> 10. ⚠️ **目标文档从 `tabOfView(view)` 推，⛔ 不从 `activeTab()` 推。** 钩子拿到的是**收到 paste 事件的那块分屏**，而 `activeTab()` 读的是焦点跟踪的结果；两者在「焦点还没跟上」的时序下会不是同一个标签——图片落到隔壁文档的目录里、链接插在另一份文档里，两边都错而且**错得对不上**。`tabOfView` 这个反查就是为它加的（`doc/workspace.ts` 文件头那段「谁收到事件，就改谁」）。`App.test.tsx` 里有一条**分屏用例**专门钉这个：第 0 块是 `.ts`、第 1 块是 `.md`、焦点停在第 0 块，往第 1 块派发 paste，断言 `docPath` 是那个 `.md`、第 1 块正文变了、第 0 块**一个字没动**。
> 11. **数字**：前端 2017 → **2076**（58 → **61** 个文件）。M3-A-7 自己 **+59**：新增 `ipc/asset.test.ts` **19**、`editor/paste.test.ts` **18**、`md/paste.test.ts` **15**，`App.test.tsx` 148 → **155**（**7** 条接线用例）。Rust 381 → **407**（37 + 304 → **328** + 40 → **42**）：`fs/asset.rs` 新增 **24** 条，`tests/wire_contract.rs` 新增 **2** 条（`store_image` 的参数名与错误形状）。Tauri command 20 → **21**（`store_image`），🔴 **命令注册表仍是 48 条、快捷键 0 新增**（粘贴是一个 DOM 处理器，不是一条命令，所以它**不在** `Cmd+P` 里、也没有 `Mod+Shift+*`），事件名仍 **8**，managed state 仍 **4**。新增依赖 **1**：`base64 = "0.22"`（MIT OR Apache-2.0，⚠️ **本来就在 `Cargo.lock` 里**，所以 `[[package]]` 条目零新增；前端那半是手写的 0x8000 分块 + `String.fromCharCode`，因为超过 10 万个参数会 `RangeError`）。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 268.18KB → **269.03KB**（`index-M6QbDDoT.js` 156.96 + `dist-Cx7xBNi0.js` 108.38 + `index-vUpS-3W0.css` 3.69），预算 300KB，余量 **10.32%**（上一次 10.6%）。**CM6 那个 chunk 的哈希与字节一个没动，CSS 也没动**——新增的 0.85KB 全在 `index` 里，因为 `App.tsx` 现在是**静态** import `./md/paste` → `./ipc/asset` 的。⚠️ **M3-C 做懒加载时必须把 `./md/paste` 与 `./ipc/asset` 一起圈进去**（连同 M3-A-6 那三个），粘贴是按需的，没理由让它待在首屏。
> 12. ⚠️ **真机上要看的（jsdom 钉不住，一个数都没有）**：① 🔴 **真的 `Cmd+V` 一张 macOS 截图**进一个 `.md`，看 `assets/` 里有没有落文件、正文那一行链接对不对、撤销栈里是不是**一步**能撤掉；② 🔴 **从 Finder 复制一个图片文件再 `Cmd+V`**（走的是 `data.files` 还是 `data.items` 那条兜底，两个引擎不一样）；③ 🔴 **粘一张 SVG**，看那句解释性拒绝是不是真的出来了；④ ⚠️ **粘进未命名草稿**（该说「先存一次（⌘S）」）与**粘进一个 `.rs`**（该说「这份文档不是 Markdown」）；⑤ 🔴 **预览里那个 `.md-img-local` 占位符长什么样**——第 3 条那句「不显示」必须让用户看得见是什么形状，一个空白的灰框与「Vela 坏了」是分不清的；⑥ ⚠️ 一张接近 32 MB 的图的落地耗时（前端 base64 编码 + 一次 IPC + Rust 侧原子写盘）。

> **M3-B-1 实施修正**（工具注册表 + 工具箱大浮层 + `Mod+Shift+P` 命令面板，2026-09-19）
>
> 1. 🔴 **改判：工具箱是一块居中大浮层，不是侧边栏面板。** 用户在「大浮层 / 底部面板 / 右侧第三栏」三选一里选了大浮层：`Mod+Shift+T` 打开，左栏按分类列工具（190px，`↑↓` + `Enter` 换），右栏是工作台，`Esc` 收起，点遮罩空白处也收起——**逐字复用 M2-E 跳转浮层与 M2-G 裁决框那套习惯**，所以「一块盖住中间的浮层」在 Vela 里现在是同一种东西的第三次出现。⚠️ **代价是明写的**：用工具时看不见正文。补偿是两个按钮「从编辑器取」/「插回编辑器」，加上关掉再打开时**输入、选项与选中的工具都留着**（`hide()` 里那段注释）——工具抽屉与一次性对话框的区别就在这儿。⛔ 不选底部面板的理由：那一排已经被全局搜索/替换占着（240px），再塞一层会变成三选一的下拉，而「搜索」与「工具」在用户心里不是同一类东西。
> 2. ⛔ **零新依赖。`cmdk-solid` 与 `@kobalte/core` 都没有进场**，§2.4 那一行与附录 B 那三行已按此结案。理由不是意识形态：M2-H 收尾时首屏余量只剩 14.4%，而 `cmdk-solid` 1.2.0 会把 `@kobalte/core` 整个拽进来（一个通用无样式组件库，Vela 只用它一个组合框）。自写的成本是**两块浮层加起来 ~5.7KB gzip**（见第 12 条），而可访问性属性（`role="dialog"` / `role="listbox"` / `role="option"` / `aria-selected` / `aria-disabled` / `aria-controls`）逐块手写、被各自的组件测试钉住。⚠️ **没有第三方兜底**这句话要留着：以后有人加一块浮层，那六个属性得自己记得写。
> 3. 🔴 **工具范围改判：v1 只做高频 6 个，不是原表那 18 个。** 用户选的：JSON 格式化/压缩、时间戳互转、UUID、Base64/URL 编解码、正则测试器、命名风格转换（M3-B-2 ~ M3-B-6 五项任务）。⚠️ **M3-B-1 只交框架，`src/tools/builtin.ts` 里那个数组是空的**——这是刻意的：框架与工具分开落地，第一个工具进场时不用再动 App。🔴 **那个空数组已经被 M3-B-2 ~ M3-B-6 填满六项了**（`JSON_TOOL`、`CODEC_TOOL`、`UUID_TOOL`、`TIME_TOOL`、`REGEX_TOOL`、`NAMING_TOOL`；用户选的六个**全部落地**），App 一行没改，这条设计当时就兑现了——**连着五次**都是只改 `builtin.ts` 自己与它的用例（M3-B-4 那一次顺带给 `ToolBox.tsx` 加了一个只给纯生成器的「重新生成」按钮，M3-B-5 那一次把 `ToolBox.tsx` 里 `at` 那一个 memo 从错误专属改成通用的 `jumpTarget`——两次都是**面板**的能力不是工具的能力，见「M3-B-4 实施修正」12 与「M3-B-5 实施修正」2）。空目录时左栏如实说「还没有工具」，⛔ 不画一块空白（与 `OUTPUT_PLACEHOLDER` 同一条理由：空白分不清是「还没跑」还是「没有」）。原表那 18 个不是删了，是推给「有人真的要再说」，加一个就是往那个数组里塞一项描述符。
> 4. 🔴 **`installTools` 是唯一的注册入口，「加进目录」与「加进命令注册表」是一次做成的。** 分成两个调用的话，漏掉后一个的失败方式是：工具箱里点得到、命令面板里搜不到、`Mod+Shift+P` 那条路径**静默**失效。合成一个函数 + 一个合并的 `dispose` 之后这种漂移在结构上写不出来。⚠️ 而且它是**启动路径上的一次自检**：描述符不合法就整批不装，并且一次报出所有工具的所有问题——v1 的工具清单是写死在代码里的常量，一份不合法的描述符是**我们的 bug**，让它当场炸比让那个工具在左栏里点不动好（后者的症状是「点了没反应」，正是这个代码库一路在躲的失败方式）。
> 5. 🔴 **`createMemo` 是急切求值的，这个 bug 是量出来的不是推出来的。** `createCommandPalette` 里那个 `const all = createMemo(() => registry.list(options.context()))` 会在 `createCommandPalette` **返回之前**就跑一遍。而 App 在组件体里建面板、在 `onMount` 里才注册那五十来条内置命令——于是面板记住的是「建它那一刻」的清单（只有工具投影出来的那几条，M3-B-1 里是**零条**），而且永远不会自己更新。修法是在 `show()` 里抬一格 `generation` 信号、让 memo 读它（`registry` 压根没有「命令变了」这个通知，而面板是**开门那一刻**才需要清单的）。⚠️ 取证方式是写了一个一次性的 `src/commands/probe.test.ts` 打印两次 `rows()`，跑完删掉——`创建那一刻 rows = [ 'early.one' ]` / `show 之后 rows = [ 'early.one' ]`。**光靠读代码推不出这一条**，因为「memo 是懒的」在 React 里成立、在 Solid 里不成立。`commands/palette.test.ts` 第 44 条把它钉住了（先建面板、后注册命令、断言 `show()` 之前看不见、之后看得见）。
> 6. ⚠️ **`App.tsx` 里那条挂了三个里程碑的 TODO 结案了。** 原话是「命令面板落地时要改成订阅，否则面板里 `editor.*` 的置灰状态不会跟着焦点走」。改法**不是**把 `getContext` 那一行改掉，而是把**同一个 `appContext` 函数**同时交给注册表与面板：注册表那一边要的仍是「被调用时求值」（`when` 在 `execute` 那一刻读一次就够），面板把它读进 memo 的追踪范围里，于是同一次调用在那一边变成了「订阅」。⚠️ 因此 `appContext` **不能**被换成一个存下来的快照对象。验收钉在两处：`commands/palette.test.ts`（翻 `setEditor` 看 `enabled` 跟着翻）与 `App.test.tsx`（真 App 里一条都不该置灰）。
> 7. 🔴 **`src/ui/timer.ts` 是从 `src/md/panel.ts` 搬出来的，⛔ 不留 re-export。** 工具箱是防抖器的第二个消费者家族（改一个字防抖 150ms 再跑一次，与「改一段正文防抖 150ms 再重解析」是同一件事）。让 `tools/store.ts` 从 `md/panel.ts` import 等于让**工具**这一层依赖 **Markdown** 那一层；更要紧的是 M3-C 要把 `md/*` 圈进懒加载块，那条 import 会把 `md/panel.ts` 拽回首屏，而理由只是「借一个 setTimeout 包装」。留 re-export 的话「哪一个才是真的」有两个答案，下一个人会照着近的那一个 import，这条边就长回来了。搬家把 `md/panel.test.ts` 里 7 条用例一起带走了（15 → 8），新的 `ui/timer.test.ts` 正好 7 条。
> 8. ⚠️ **`list()` 的排序是按 category 码点、再按 id，所以「工具」是第一个分类。** 工 U+5DE5 < 搜 U+641C < 文 U+6587 < 编 U+7F16 < 视 U+89C6 < 跳 U+8DF3 < 项 U+9879。于是 `toolbox.open` 是命令面板里的**第一行**，而那 6 个工具进场之后会占据开头连续 6 行。⚠️ 凭字形或拼音猜这个排序在这里必错（「跳转」的码点比「视图」**大**），`commands/builtins.test.ts` 里那条全清单用例的文件头已经把这件事写了一遍，这次又应验了一回。
> 9. ⚠️ **`Mod+Shift+P` 与 `Mod+Shift+T` 都不再空着**（§3.3「M1-C 实施修正」与 §3.5「M3-A-6 实施修正」7 那两句已改口），两条用例都从「无人占用」翻转成「占用且命中这一条」。**只剩 `Mod+Shift+R` 空着并被钉住。** 两个键的选择都有参照物：`Cmd+Shift+P` 是 VS Code「Show All Commands」与 Sublime 命令面板的共同选择；`Cmd+Shift+T` 是 Sublime 的 Quick Panel（工具箱正是一块 quick panel）。⛔ **仍然不绑 `Mod+Shift+W`**（macOS 的「关闭所有窗口」到不了 webview）。
> 10. 🔴 **工具箱的「复制结果」走 `navigator.clipboard.writeText`，这是一笔真机待验的债。** `src/ipc/project.ts` 里那条 `copy_entry_path` 刻意绕开了它、改走 Rust `pbcopy`，理由是「`navigator.clipboard` 要求安全上下文，而 Tauri 在 macOS 上跑的是 `tauri://localhost` 这个自定义协议，算不算安全上下文取决于 WKWebView 的版本」。这里绕不开：那一版收的是 `(root, rel)`，为的是「复制一个路径」，而工具箱要复制的是**刚算出来的正文**，它在内存里没有文件可指。所以 `copyText` 如实返回 `false`，面板上那句话变成「复制不了——输出格里的文字是可以自己选中的」——**失败是说出来的，不是静默的**。⚠️ 真机上如果它确实抛了，补一条 Rust `copy_text` 命令（照 `copy_entry_path` 写）就是解法，而 `App.tsx` 里那一个函数是唯一要改的地方。
> 11. ⚠️ **jsdom 钉不住的那些（一个数都没有）**：命令面板 600px 够不够放下「标题 + 分类 + `⇧⌘P`」三格、`.palette-row.command` 那个「命令行走 UI 字体、不走代码字体」的切换、置灰那 `opacity: 0.45` 的观感、`PageDown` 一页走几行（jsdom 的 `clientHeight` 恒为 0，所以 `pageSize()` 恒为 1）；工具箱 880×560 的尺寸、190px 左栏放不放得下「JSON 格式化」这种名字、右栏两格并排的宽度、选项条换行、以及 `rgba(0,0,0,0.45)` 那层遮罩与 `.modal-backdrop` 叠在一起长什么样。⚠️ 两块的 `z-index` 都是 **20**，所以「谁在上面」由 DOM 顺序决定：App 里刻意画成 `QuickOpen → CommandPalette → ToolBox`，因为唯一会同时开着两个的情形正是「在命令面板里挑了一个工具」，那一下要看见的是工具箱。
> 12. **数字**：前端 2076 → **2313**（61 → **68** 个文件）。M3-B-1 新增 7 个测试文件：`tools/tool.test.ts` **33**、`tools/store.test.ts` **61**、`tools/registry.test.ts` **13**、`tools/ToolBox.test.tsx` **37**、`commands/palette.test.ts` **44**、`commands/CommandPalette.test.tsx` **34**、`ui/timer.test.ts` **7**（从 `md/panel.test.ts` 搬来，那一边 15 → 8）；`commands/builtins.test.ts` 71 → **77**（+6，两个入口的接线）、`App.test.tsx` 155 → **162**（+7，接线）。⚠️ 分项相加是 **+235**，与实测的 **+237** 差 2 条，查不出来——`ui/timer` 那次搬家前后的逐文件数没有留档，以**实测的 2313** 为准。Rust **407 一条没动**（37 + 328 + 42）：M3-B **一行 Rust 都没写**。命令 48 → **50**（`toolbox.open`、`commandPalette.open`），快捷键 23 → **25**。🔴 **Tauri command 仍 21、事件名仍 8、managed state 仍 4、路径接受面一个字没变宽**。新增依赖 **0**。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 269.03KB → **275.26KB**（`index-CYDsHyFQ.js` 162.68 + `dist-Cx7xBNi0.js` 108.38 + `index-BhMjxJ3w.css` 4.20），预算 300KB，余量 **8.25%**（上一次 10.32%）。**CM6 那个 chunk 的哈希与字节一个没动**（还是 `dist-Cx7xBNi0.js` / 108.38KB）。CSS 3.69 → **4.20KB**（+0.51，`.toolbox-*` 那一整套 + `.palette.wide` 与 `.palette-row.command` 两条），**哈希自 M3-A-3 以来第一次变**（`index-vUpS-3W0.css` → `index-BhMjxJ3w.css`）。新增的 5.72KB JS 全在 `index` 里，因为 `App.tsx` 现在是**静态** import `./tools/*` 与 `./commands/CommandPalette` 的。
> 13. ⚠️ **M3-C 的懒加载清单再加三项，但有一项加不了。** 要圈进去的是 `commands/CommandPalette.tsx`（面板的 UI，按需）与 `tools/ToolBox.tsx`（工具箱的 UI，按需）。🔴 **`tools/registry.ts` + `tools/builtin.ts` 圈不进去**：工具要在启动时就投影成命令，否则命令面板里搜不到工具名——而那意味着**六个工具的实现代码必须留在首屏**（到 M3-B-6 为止，圈不进去的清单是 **9 个模块**：`tools/registry.ts`、`tools/builtin.ts`、`tools/json.ts`、`tools/codec.ts`、`tools/uuid.ts`、`tools/time.ts`、`tools/regex.ts`、`tools/naming.ts`、`util/base64.ts`）。它们是纯函数（`JSON.stringify` / `TextEncoder` / `crypto.randomUUID` / `new RegExp`），预期每个几百字节，所以这笔账划得来；⚠️ 但 M3-C 量体积时要**分别报**「框架 + 工具实现」与「两块浮层 UI」两个数，混在一起就看不出懒加载到底省了多少。<br>🔴 **两处事后更正**（2026-09-20，M3-B-4）：① 「预期每个几百字节」**一次都没兑现**，实测是 2.40 / 1.28 / ≈1.6 / ≈1.6 / 1.82 / 0.60 KB gzip，六个一共 **+9.35KB**——「账划得来」这半句仍然成立（占预算 3.1%），⛔ 但那个数量级不能再拿来做预算；② `crypto.randomUUID` **没有用上**，它是 secure-context-only 的 API 而 `tauri://localhost` 算不算 secure context 没有验过，所以 v4 是由 `crypto.getRandomValues` 手搓的（见「M3-B-4 实施修正」1）。
> 14. ⚠️ **真机上要看的**：① 🔴 `Mod+Shift+P` 在真实 WKWebView 里能不能收到（macOS 上 `Cmd+Shift+P` 不被系统占用，但**没有取证过**，取证方式同 M3-A-6 修正 7 那个 grep）；② 🔴 第 10 条那笔剪贴板债；③ ⚠️ 第 11 条那一整批观感；④ ⚠️ 从命令面板里挑「工具箱…」那一下，两块浮层的交接看不看得出闪烁（`commit()` 先收起再执行，同一个 tick 里两件事都发生）；⑤ ~~⚠️ 工具箱空目录时那句「还没有工具」在 880×560 的一块大浮层里会不会显得空得离谱~~ —— **M3-B-2 一落地这一条就自动消失了**（`BUILTIN_TOOLS` 不再是空的），结案。

> **M3-B-2 实施修正**（第一个工具：JSON 格式化 / 压缩，2026-09-19）
>
> 1. 🔴 **这个工具有一个自己的 JSON 扫描器，因为运行环境不是 V8。** `ToolResult.text` 那句注释把「要说清哪一行哪一列」写成了契约，而契约**没法**靠读引擎的错误消息兑现：Vela 跑在 WKWebView 里，那是 JavaScriptCore，`JSON.parse('{"a":1,}')` 在 V8 上给 `Expected double-quoted property name in JSON at position 7 (line 1 column 8)`，在 JSC 上只给 `JSON Parse error: Expected '}'` —— **压根没有位置**。用正则去抠那句英文等于把契约挂在一句随版本变的字符串上，而且在真机上必然抠不到。所以位置自己算（`src/tools/json.ts` 的 `scanJson`）。⚠️ **分工是「值由 `JSON.parse` 建，扫描器只在解析已经失败之后跑去找位置」**：它 bails 在第一个错上，所以合法输入永远走不到它，1MB 的正经 JSON 只有出错时才多扫一小段。⚠️ 还有一条诚实的兜底：万一扫描器说「我找不到错」而引擎抛了（两者理论上可能不一致），报**引擎那句原文**而不是编一个位置。
> 2. 🔴 **扫描器是迭代的**（显式 `stack: number[]`，`ARRAY=1` / `OBJECT=2`），不是递归下降。递归版在 `'['.repeat(20_000)` 上会炸栈，而输入格里能贴进 100 万个字符（`MAX_TOOL_CHARS`），一份深嵌套的 JSON 是**用户输入**不是我们的 bug——它该得到一句「第 20000 行…」而不是让整个 webview 崩掉。这一条被用例钉住（`json.test.ts` 的 `🔴 套两万层不炸栈`）。
> 3. 🔴 **`{"a":1,}` 需要两个不同的对象键状态，一个不够。** 尾逗号是 JSON 里最常打错的一种，而一个允许 `}` 的 `key` 状态会把 `{"a":1,}` 扫成**合法**——于是 `JSON.parse` 抛了、扫描器却说「没错」，正好掉进第 1 条那个兜底分支，用户拿到的是一句没有位置的英文。修法是把状态拆成 `keyFirst`（紧跟 `{`，允许 `}` 表示空对象）与 `key`（逗号之后，`"` 是强制的）。⚠️ **这个 bug 是手推出来的，不是用例抓出来的**：写完第一版之后逐条对拍 39 份非法样本才发现，而当时那条对拍用例（`🔴 说「没错」当且仅当 JSON.parse 不抛`）已经在了——它当时是绿的，因为**语料里没有尾逗号对象**。所以第 5 条那份语料是这次真正的产出之一。
> 4. 🔴 **抹注释必须是「等长替换」，不是删除。** `blankJsonComments` 把 `//…` 与 `/* … */` 换成**同样长度**的空白并且保住 `\n` 的位置，于是抹过之后的下标与用户输入格里的下标**1:1 对得上**。这件事同时是两处的地基：报出来的「第 N 行第 M 列」，以及「跳到出错处」那一下要选的区间。删掉注释的话下标立刻错位，而错位是**静默**的——行列看着像个行列，只是指到了别处。⚠️ 一个顺带的优化：一个注释都没有时返回**原引用**（`if (last === 0) return text`），所以「去注释」关掉与否在大多数输入上连一次拷贝都省了。
> 5. ⚠️ **语料是 23 份合法 + 39 份非法，对拍判据是 `JSON.parse` 本身。** 合法那一半断言 `scanJson` 回 `null`，非法那一半断言它回一个位置、而且 `describeJsonError` 出来的形状对（三行、`^第 N 行第 M 列：`、脱字号在片段范围内）。⚠️ **形状那条用例比「位置精确等于某个数」更值钱**：它是唯一一条会自动覆盖**新加进语料的样本**的检查，而逐个手算下标这件事这次已经算错过 5 回（都是我自己写的期望值错，实现是对的）。
> 6. 🔴 **一个描述符，不是「格式化」与「压缩」两个。** §2 那张 P0 表里它写在一行（`JSON 格式化/压缩`），保持一行有两个理由：① 「六个工具」那笔账要还对得上；② 压缩只是 `indent` 选到「无（压缩）」，两个描述符意味着两份选项条、两份 `run`、以及左栏里两条几乎一样的行。⚠️ 名字刻意写成 **`JSON 格式化 / 压缩`**（中间带空格与斜杠），因为左栏那个过滤框是**子串**匹配——用户打「压缩」也要捞得到它。
> 7. ⚠️ **「去注释」默认是开的。** `tsconfig.json` 与 `.vscode/settings.json` 都是 JSONC，而「把这份文件贴进来看一下」是这个工具最常见的用法；默认关掉的话用户第一次用它就会撞上一句语法错，而错误在**注释那一行**上，看起来像工具坏了。⚠️ 但它**可以关**，关掉之后这个工具与 `JSON.parse` 一字不差（用例钉住：关掉之后 `{\n  // …\n}` 报错，而且报的是中文的、带行列的那一句）。
> 8. 🔴 **`ToolResult` 加了 `at?: number`，这是它唯一的例外，而且方向是反的。** 那个接口的文件头写着「正文只有文字，没有富结构」，理由是给这一层加「高亮区间」「匹配列表」等于让**通用面板**认识某一个具体工具。`at` 不属于那一类：它不让面板认识 JSON，它让「哪一处出错了」这件事对**每一个**吃文字的工具都表达得出来（正则的匹配位置、命名转换里那个不合法的字符，是同一个形状）。⚠️ **口径是 UTF-16 码元**，与 `textarea.selectionStart` 逐字相同——不是随便挑的，是这个数唯一的用途决定的。给了它面板才画「跳到出错处」，不给就只有那句话。
> 9. 🔴 **`lineBoundsAt` 住在 `tool.ts`，⛔ 不住在 `json.ts`。** 面板要把选区挪到「出错那一行」，而挪的单位是整行（只放一个光标的话用户还得自己找这一行哪里不对；选中之后那一行在格子里是亮着的，与输出格里那个 `^` 说的是同一处）。这个换算与是哪个工具无关，所以住在描述符那一层——于是**依赖方向仍然是 `json.ts` → `tool.ts`**，面板一个具体工具的模块都不 import。⚠️ 两个方向都是**就近扫**不是从头数（往前找上一个 `\n` 是 O(列号)），一行十万个字符的压缩 JSON 上这是「立刻」与「卡一下」的区别。
> 10. 🔴 **`focus()` 必须在 `setSelectionRange()` 之前。** 反过来写的话，聚焦那一下会把选区拉回上次离开时的位置，于是「跳到出错处」看起来按了没反应。⚠️ 而「聚焦之后格子会不会**滚**到选区那一行」是引擎的事，jsdom 里量不出来——进了第 14 条的真机清单。
> 11. ⚠️ **`JSON.parse` 路线有三个已知失真，写进用例而不是藏起来。** ① 超过 2^53 的整数：`12345678901234567890` → `12345678901234567000`；② `-0` → `0`；③ `1e400` → `Infinity` → stringify 成 `null`。三条都是**双精度浮点**的必然结果，不是实现选择；要避开就得自己写一个大数 JSON 解析器，而那与「零新依赖 + 几百字节」这笔账不合算。⚠️ 用例的名字就叫 `🔴 两个已知的失真：大整数与 -0`，为的是下一个人不会把它当 bug 修。④ 另一条**排不动**的：`sortKeysDeep` 对**数字形状的键**无效——JS 对象永远把整数样式的键按升序放在最前面，与赋值顺序无关，所以 `{"2":1,"1":2}` 排完还是 `1` 在前。这一条也被钉住，同样是防止有人去「修」它。
> 12. ⛔ **零新依赖，而且 ⛔ 不是 `json5`。** `json5` 能顺带把注释、尾逗号、单引号全收下来，但那是**换了一门语言**：输出不再是合法 JSON，而「格式化 JSON」这个工具给出一个 `JSON.parse` 读不回去的结果是错的。要收的只有注释一种，而它是一个**可关的开关**（第 7 条）。
> 13. **数字**：前端 2313 → **2379**（68 → **70** 个文件）。M3-B-2 自己 **+66**：新增 `tools/json.test.ts` **36**、`tools/builtin.test.ts` **17**；`tools/tool.test.ts` 33 → **39**（+6，`lineBoundsAt`）、`tools/ToolBox.test.tsx` 37 → **43**（+6，「跳到出错处」）、`App.test.tsx` 162 → **163**（+2 接线用例 −1 那条已经作废的「空目录如实说没有工具」）。⚠️ **分项相加正好 +66**，与实测一致。Rust **407 一条没动**（37 + 328 + 42）：M3-B-2 **一行 Rust 都没写**。命令 50 → **51**（`tool.json.format`），🔴 **快捷键仍 25**（第 6 个理由见 `tools/registry.ts` 的文件头：给单个工具绑键等于给同一件事开第二个入口）。🔴 **Tauri command 仍 21、事件名仍 8、managed state 仍 4、路径接受面一个字没变宽**。新增依赖 **0**。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 275.26KB → **277.66KB**（`index-DeVDbUsH.js` 165.08 + `dist-Cx7xBNi0.js` 108.38 + `index-BhMjxJ3w.css` 4.20），预算 300KB，余量 **7.45%**（上一次 8.25%）。**CM6 那个 chunk 与 CSS 的哈希和字节都一个没动**（CSS 没长是因为「跳到出错处」那个按钮吃的是全局 `button` 样式）。chunk 仍 **117** 个、`dist/index.html` 仍只引 **3** 个。⚠️ **+2.40KB 比「一个工具几百字节」那个预期大**：吃掉的不是描述符，是那个扫描器 + 抹注释 + 定位 + 中文错误文案（`SNIPPET_WIDTH=160` 那一段带脱字号的报告）。M3-B-3~6 那五个是**真**几百字节的量级（`TextEncoder` / `crypto.randomUUID` / `new RegExp` / 字符串替换），所以这一条不能拿来外推。
> 14. 🔴 **M3-C 的懒加载清单：`tools/json.ts` 也圈不进去**（M3-B-1 修正 13 那句话现在有了第一个实例）。`builtin.ts` 静态 import `json.ts`，而 `builtin.ts` 必须在启动时就投影成命令。⚠️ 所以那 2.40KB 是**首屏常驻**的，六个工具进场之后这一项已经长到 9.35KB；M3-C 量体积时要按「框架 + 工具实现（常驻）」与「两块浮层 UI（可按需）」两个数分别报。
> 15. ⚠️ **真机上要看的（jsdom 钉不住）**：① 🔴 `inputEl.focus()` 之后 `setSelectionRange()` 在 WKWebView 里**会不会把格子滚到选中那一行**（jsdom 里没有布局也没有 `scrollIntoView`，第 10 条那半句只验了选区与焦点，没验滚动）；② ⚠️ 「JSON 格式化 / 压缩」这 15 个字放不放得进 190px 的左栏（M3-B-1 修正 11 里那条「190px 够不够放『JSON 格式化』」现在有了真实的最长名字）；③ ⚠️ 输出格里那个用 ASCII `^` 画的脱字号，在**中文行**上会不会歪——`locate` 的 `column` 数的是 UTF-16 码元，而文楷/Maple 里一个汉字占两格，所以 `^` 在含中文的那一行上必然对不齐（这一条**已知**，写在 `locate` 的文档注释里；真机上看的是它歪到什么程度、要不要改成用全角空格垫）。
>
> **M3-B-3 实施修正**（第二个工具：Base64 / URL 编解码，2026-09-19）
>
> 1. 🔴 **四条编解码的错误路径没有一条报位置，所以这里也有自己的扫描器。** 与 M3-B-2 第 1 条同因（跑在 WKWebView 里，那是 JavaScriptCore 不是 V8），但量出来的是另外五句：`btoa('中文')` → `InvalidCharacterError: Invalid character`；`atob('a*bc')` → 同一句；`atob('YWJjZ')`（长度不对）→ `InvalidCharacterError: The string to be decoded is not correctly encoded.`；`new TextDecoder('utf-8',{fatal:true})` 解坏字节 → `TypeError: The encoded data was not valid for encoding utf-8`；`decodeURIComponent('%zz')` 与 `('%E4%B8')` → `URIError: URI malformed`。⛔ **五句里一个下标都没有**。⚠️ 分工与 JSON 那一次不同：扫描器**只在引擎已经抛了之后**才跑，所以它的任务不是「判定合法性」而是「找一个能指的地方」。话虽如此，两个扫描器都拿引擎做了对拍——`scanBase64` 对 `atob` 25 份样本，`scanPercent` 对 `decodeURIComponent` **双向**（该抛的都抛、不该抛的都不抛）：因为「扫描器说没错而引擎抛了」会掉进那句没有位置的英文兜底，正是这一层要避免的那一幕。
> 2. 🔴 **`at` 只在「那个下标是输入格的字符下标」时才给，这是一条按*下标空间*划的线。** 非法 base64 字符、`=` 的位置与个数、坏的 `%XX`、落单代理项——四处都在**输入字符空间**里，于是都给 `at`，面板画得出「跳到出错处」。⛔ 而「解出来的字节不是合法 UTF-8」那一条**不给**：那个下标是**字节**下标（`5Lit5paH` 是 8 个字符、解出 6 个字节），填进 `at` 的话「跳到出错处」会把选区放到一个错的地方上，而**一个差一点的跳转按钮比没有跳转按钮更坏**——用户会以为工具指对了。这不是新决定，是 M3-B-2 第 8 条「`at` 的口径是 UTF-16 码元、与 `textarea.selectionStart` 逐字相同」的推论。
> 3. 🔴 **`decodeURIComponent` 抛 `URIError` 只有两个原因**，这个事实省掉了一整类猜测：`%` 后面不是两位十六进制，**或者**解出来的字节不是合法 UTF-8。于是「`scanPercent` 扫干净了 + 引擎还是抛了」⇒ **必然**是字节那一支。这一条演绎是 `urlDecode` 那句没有位置的错还能说得具体的全部理由（「多半是把一个汉字截断了，或者这一段本来就不是 UTF-8 编的」），⛔ 而不是「不知道哪里错了」。⚠️ 它被钉住的方式就是第 1 条那个双向对拍：`badSyntax` 7 份断言扫描器找得到，`badBytes` 4 份断言扫描器找不到而引擎抛。
> 4. ⚠️ **`atob` 的三个脾气，都是量出来的不是读文档读来的。** ① **吃掉所有 ASCII 空白**（空格 / `\t` / `\n` / `\r\n`，所以 PEM 那种折行的能直接解），但 NBSP `U+00A0` 与零宽 `U+200B` **不是** ASCII 空白，于是它们落到「字母表里没有这个字符」；② **不认 base64url**（`-` / `_` 直接 `Invalid character`）；③ 🔴 **收缺 padding**（`atob('YWJjZA')` → `'abcd'`）。第 ③ 条决定了一件事：「少一个 `=`」⛔ **不算错**——引擎收的东西我们不能说它错，否则「Vela 说有错、别处能解」看起来像我们坏了。而 `===`（padding 太多）与 `=` 后面还有内容（`atob('Y=Jj')`）都**是**错。
> 5. 🔴 **`base64Decode` 刻意比 `atob` 宽：先把 `-`→`+`、`_`→`/` 归一化再解。** 理由是用户手上那一串多半是从 JWT 或者 URL 参数里抄来的，而「解不开」对这个工具就是失败。⚠️ 放宽之所以**安全**，是因为这两个替换都是 1:1 等长的，于是归一化前后下标逐位对齐，报出来的位置仍然指着用户输入格里看得见的那一个字符——与 M3-B-2 第 4 条「等长抹注释」是同一个手法。⛔ 反过来说，任何**改变长度**的预处理（比如顺手把空白删掉）都会让位置静默错位，所以 `scanBase64` 是**跳过**空白而不是删掉它。
> 6. 🔴 **`bytesToBase64` 从 `src/ipc/asset.ts` 搬到了新的 `src/util/base64.ts`。** 它现在有两个互不相干的调用方（M3-A-7 的图片粘贴落地、M3-B-3 的编解码工具），而被否掉的两条路是：① 让 `tools/` 依赖 `ipc/`——那会把一个纯算法工具挂到 Tauri 的 invoke 层上，而 `codec.ts` 一个命令都不调；② 复制那六行——它不长，但它带着一条**被用例钉住的**不变量（`String.fromCharCode` 必须分块，50 万个字节一次摊会 `RangeError`），复制等于让那条不变量有两个地方要维护。⚠️ 顺手补上了缺的逆向 `base64ToBytes`，⛔ 而 `asset.ts` **不再 re-export**（一个编码器只有一个家，留一个别名就是留一条会漂移的路）。⚠️ 语料同时从「8 字节 PNG 头」升级成**全 256 个字节值**，另加两个 50 万字节的往返各钉一头。
> 7. ⚠️ **五种模式是「一个描述符 + 一格五选下拉」，不是两个工具、也不是两格下拉。** 拆成「Base64」与「URL」两个工具的话左栏多一行、而每一行只剩两三个候选；做成两格下拉（「类型」+「方向」）的话，选了「URL」之后「Base64 解码」那一格还留在屏幕上——**一个安静地不听话的控件**比没有控件更坏（与 M3-B-2 第 6 条同一个理由）。⚠️ URL 编码拆成「值 / 整条」两个**候选**而不是一个开关，因为区别不是 yes/no 而是「放过哪些字符」：`encodeURIComponent` 放过 9 个符号，`encodeURI` 放过 20 个（多出 `&=/?#+,;:@$` 这 11 个，量过的），而用户心里想的是「我编的是整条 URL 还是一个参数」。⚠️ 名字写成 `Base64 / URL 编解码`，为的是左栏那个**子串**过滤框打「base64」「url」「编解码」三个都捞得到（用例把三个都钉了，比的是小写化之后）。
> 8. 🔴 **§2 那张 P0 表里这一格写的是「Base64 文本 / 图片」——图片那半没做。** 它要的是「选一张图进来、给出 base64 / data URI」，而那需要一条**读任意路径**或者**收一个文件选择器结果**的通路：前者是路径接受面（🔴 21 个命令里已经有 15 个吃路径，M5 还要把它们收成 `rootId`，现在再加一个是往反方向走），后者要动 `tauri-plugin-dialog` 与 `store_image` 那条已经收口的通路。⚠️ **推给 M4，与 `assets/` 目录名与命名规则的可配置化一起做**（M3-A-7 那条也是这么推的）：两件事卡在同一个缺口上——**用户可配置的输出/输入位置**。⛔ 不要为了「把表填满」现在就开一个吃绝对路径的 base64 命令。
> 9. ⚠️ **换一格选项立刻拿「现在输入格里那一份」重跑，⛔ 不是把上一次的输出接回来当输入。** 这是 `store.ts` 的 `setOption → scheduleRun` 既有语义（M3-B-1 就有），但它在**有方向**的工具上第一次变得显眼：编完 `中文` → `5Lit5paH` 之后直接把下拉切到「Base64 解码」，重跑的是 `解码('中文')`，用户看到的是一句指着他刚打的那个汉字的错。🔴 **这是对的，不改**：悄悄把输出喂回输入的话，输入格里显示的字与真正跑的那一份不是同一个东西，而那正是 `setOption` 收窄失败时「保持原值不动」要避免的同一类静默不一致。App 层那条用例（`在工具箱里切到第二个工具、改一格选项`）把这个口径钉住了，**包括那句错的原文**。
> 10. **数字**：前端 2379 → **2423**（70 → **72** 个文件）。M3-B-3 自己 **+44**：新增 `tools/codec.test.ts` **31**、`util/base64.test.ts` **9**；`tools/builtin.test.ts` 17 → **25**（+8）、`tools/tool.test.ts` 39 → **47**（+8：搬进来的 `locate` 4 条 + `describeErrorAt` 4 条）、`App.test.tsx` 163 → **164**（+1）。⚠️ **两处是负的**：`tools/json.test.ts` 36 → **28**（−8，那 8 条搬去了 `tool.test.ts`）、`ipc/asset.test.ts` 19 → **14**（−5，那 5 条搬去了 `util/base64.test.ts`）。分项相加 +9 −5 +31 +8 −8 +8 +1 = **+44**，与实测一致。⚠️ **搬家时定了一条测试的依赖方向规则**：测试可以**向下** import（`json.test.ts` → `tool.ts`，与 `json.ts` → `tool.ts` 同向），⛔ 不能**向上**（`tool.test.ts` → `json.ts`）——后者会让一份底层测试替一条源码里并不存在的依赖背书。所以 `tool.test.ts` 里那四条的下标全是**手数的常量**，而「扫描器报的下标喂进渲染器之后 `^` 落对了地方」那条端到端验收留在 `builtin.test.ts`（那里本来就要同时拿到两边）。Rust **407 一条没动**（37 + 328 + 42）：M3-B-3 **一行 Rust 都没写**。命令 51 → **52**（`tool.codec`），🔴 **快捷键仍 25**。🔴 **Tauri command 仍 21、事件名仍 8、managed state 仍 4、路径接受面一个字没变宽**（第 8 条那个缺口就是为了保住这一句）。新增依赖 **0**（`TextEncoder` / `TextDecoder` / `atob` / `btoa` / `encodeURI*` / `decodeURIComponent` 全是平台自带）。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 277.66KB → **278.94KB**（`index-DE5ksiWr.js` 166.36 + `dist-Cx7xBNi0.js` 108.38 + `index-BhMjxJ3w.css` 4.20），预算 300KB，余量 **7.02%**（上一次 7.45%）。**CM6 那个 chunk 与 CSS 的哈希和字节都一个没动**（CSS 没长是因为那一格下拉吃的是既有 `.toolbox-option` 样式）。chunk 仍 **117** 个、`dist/index.html` 仍只引 **3** 个。⚠️ **+1.28KB，大约是 M3-B-2 那 +2.40KB 的一半**，而它有**三个**扫描器（base64 字母表与 `=`、`%XX` 语法、落单代理项）对 JSON 的一个：便宜下来的原因是 `describeErrorAt` / `locate` 那一层与 `src/util/base64.ts` 的编码器**都是已经付过钱的**。🔴 所以「新增一个工具的边际成本 ≈ 写一个纯函数」这句话是从**第二个**工具起才成立的，⛔ 而两个数都不能拿来外推剩下四个（第一个偏高、第二个偏低）。
> 11. 🔴 **`tools/codec.ts` 也圈不进懒加载**（M3-B-2 修正 14 的第二个实例；圈不进去的清单从 3 个模块变成 5 个：`tools/registry.ts` + `tools/builtin.ts` + `tools/json.ts` + `tools/codec.ts` + `util/base64.ts`）。⚠️ `util/base64.ts` 进这一列的理由与另外四个**不同**：它是被 `ipc/asset.ts` 静态引用的，而 `asset.ts` 目前还在首屏里；M3-C 真把 `md/paste.ts` + `ipc/asset.ts` 圈成按需之后，`util/base64.ts` 会**同时**被一个常驻模块（`codec.ts`）和一个按需模块引用，于是它必然留在常驻那一侧。这不是问题，只是记账时要说清它算在哪一边，⛔ 别把它当「可以摇掉」的那一类列进 M3-C 的收益里。
> 12. ⚠️ **真机上要看的（jsdom 钉不住）**：① 左栏 190px 那一列最长的一行换成了 `Base64 / URL 编解码`（M3-B-2 修正 15 ② 那条「`JSON 格式化 / 压缩` 放不放得下」有了新的、更长的样本，而且它一半拉丁一半汉字，两种字宽混在同一行）；② 选项条里那一格**五选**下拉读起来顺不顺、「URL 编码（整条）」这 10 个字放不放得下（M3-B-1 只验过 text/number/select/toggle 四种控件各画得出，没验过一个真实工具的五选）；③ 🔴 打开这个工具那一瞬间输入格是空的（`input: 'text'` 的工具**不**自动预填，见 `store.ts` 的 `prefill`），于是第一次运行是 `编码('')`，输出格该显示 `OUTPUT_PLACEHOLDER`「输出会出现在这里」⛔ 而不是一句红错——`run('')` 回 `{kind:'ok',text:''}` 这一半在单元层钉住了，「空输出在面板上长成占位符」那一半只在真浮层里看得见；④ M3-B-2 修正 15 那三条**一条都没结案**，而其中第 ③ 条（中文行上 ASCII `^` 歪不歪）现在**更可能咬人**：贴进来的 base64 常常是中文编的、URL 编码串里全是 `%E4%B8%AD`，它们与中文文案挨在一起的机会比 JSON 多得多。

> **M3-B-4 实施修正**（第三、第四个工具：UUID 生成 + 时间戳互转，2026-09-20）
>
> 1. 🔴 **`crypto.randomUUID` 没用，v4 是手搓的。** 它是 **secure-context-only** 的 API，而 jsdom 里 `globalThis.isSecureContext` 是 `undefined`——于是那一份测试环境**给不出任何保证**（`crypto.getRandomValues` 与 `crypto.randomUUID` 在 jsdom 里同时存在，两边都绿，真机上未必）。`tauri://localhost` 算不算 secure context 到今天**没有验过**（第 16 条 ①）。⚠️ `getRandomValues` **不是** secure-context-only，所以手搓这一份在两种情况下都能跑。🔴 反过来说：就算第 ① 条量出来是 `true`，这几十行也**不该**换回一行 `crypto.randomUUID()`——那是拿「多一个只在部分上下文里存在的依赖」去换「少几十行」，而少的那几十行已经被 12 条用例钉住了，维护成本是零。
> 2. 🔴 **`getRandomValues` 一次最多 65536 字节**（超了抛 `QuotaExceededError`），这条平台上限决定了「个数」那一格的上限：`UUID_MAX_COUNT = 1000` → 16000 字节，四倍余量。⚠️ `uuidList` 是**一次调用填满整批**的，不是循环 1000 次——循环也能过，但那会把这条上限变成一个「什么时候会撞上」的运行时问题，而一次填满让它变成一个**算得出来的常量关系**。用例钉的正是 `max * UUID_BYTES <= 65536`（用的是 `uuid.ts` 导出的 `UUID_BYTES`，⛔ 不是写死的 16），于是形状改了这条关系还在。
> 3. ⚠️ **RFC 4122 的 v4 是「先掩码再或」**：第 6 字节高四位 `0100`、第 8 字节高两位 `10`，写成 `(b & 0x0f) | 0x40` 与 `(b & 0x3f) | 0x80`。⛔ 少掩码那一步的话随机字节的高位会漏进版本位，症状是「大部分时候对、偶尔出来一个不是 v4 的串」——200 份真随机样本里未必撞得上，所以 `uuid.test.ts` 注入的是**假随机源**、断言的是**逐位**。⚠️ 这也是 `builtin.test.ts` 那一层**故意不重测版本位**的理由：那一层拿的是真随机，只能量形状（`V4_RE`、行数、去重、大写与无连字符两种变体）。
> 4. 🔴 **`MAX_DATE_MS` 是 `8.64e15`，不是 `8.64e12`——这是本轮唯一一个我自己写错、被自己的用例抓住的数。** 写错 1000 倍的后果是三条同时红：`0099-01-01` 被判「超出范围」、`99999999999`（公元 5138 年）被判超范围、以及 `new Date(MAX_DATE_MS + 1).toISOString()` 该抛 `RangeError` 却不抛。诊断办法是量而不是查：`new Date(8639913600000).toISOString()` → `2243-10-16`，也就是 8.64e12 毫秒只有 ±100000 天 ≈ ±274 年。ECMAScript 的真边界是 ±8.64e15 毫秒 = ±100000000 天 → 年份 **−271821 … +275760**。⚠️ 顺带量出**一个会抛一个不抛**：`toISOString()` 越界抛 `RangeError`，而 `getUTCFullYear()` 越界**静默给 `NaN`**——所以这道闸必须在**渲染之前**拦住，否则输出格里会出现一行 `NaN-NaN-NaN`，那不算错，算难看。
> 5. ⚠️ **只有「纳秒」那一支能撞上限，于是 `parseIso` 里那道范围检查是死代码，删了。** 按位数分类（≤11 秒、12–14 毫秒、15–17 微秒、≥18 纳秒）与 25 位上限算下来：秒最大 9.99e13 毫秒、毫秒 9.99e13、微秒 9.99e13，而纳秒要 **≥22 位**才超 8.64e15。日期那一支更宽：四位年份封顶 9999 → `9999-12-31T23:59:59Z` = 253402300799000 毫秒，离上限还有 **34 倍**。⛔ 留一道结构上到不了的检查，等于留一个「以后有人改了分类却忘了改这里」的口子。
> 6. 🔴 **25 位那道闸必须在构造 BigInt 之前查。** BigInt 的除法是**超线性**的，而 `store.ts` 允许 `MAX_TOOL_CHARS = 1_000_000`——一份一百万字符的数字串如果先 `BigInt(...)` 再判长度，用户看到的是**界面冻住**，不是一句错。与 `json.ts` 那个迭代扫描器（`'['.repeat(20000)` 不炸栈）是同一条思路：**输入长度是用户给的，任何 O(n²) 以上的活都要先设一道闸**。⚠️ 闸报的是「这一串有 N 位数字，而一个时间戳最多认 25 位」，带着位置，于是「跳到出错处」按得动。
> 7. ⚠️ **负数时间戳要向下取整，而 BigInt 的除法是向零截断。** `-1700000000123456` 微秒 → `-1700000000124` 毫秒（⛔ 不是 `-1700000000123`）。修法是 `negative ? (remainder === 0n ? -q : -(q + 1n)) : q`。这一条只在 1970 年之前的时刻上看得出来，而那正是「差 1 毫秒没人会注意到」的那一类，所以它被单独钉了一条用例。
> 8. 🔴 **「不写时区就当本地时间」是刻意与 ES 规范不一致的，而这条不一致被用例钉住了。** 规范说 `new Date('2024-03-05')`（只有日期）是 **UTC 午夜**，而 `new Date('2024-03-05T12:34:56')`（有时间没时区）是**本地**；`'2024-03-05 12:34:56'`（空格）也是本地。⚠️ 这个区别在规范里有历史原因，在用户眼里没有：同一个格子里少写一段就换了一个时区基准，正是那种「当时看着对、回头才发现差 8 小时」的错。于是这里统一成**本地**，并在报告里如实披露一句「（输入里没写时区，按本地时间 UTC+08:00 理解）」。🔴 用例钉的是 `ok('2024-03-05').ms` **不等于** `Date.UTC(2024,2,5)`（本机时区非 UTC 时才断言），⛔ 不是钉一个具体毫秒数——后者在 ubuntu（TZ=UTC）的 CI 上会假绿。将来谁想「按规范对齐」，会先撞红。
> 9. ⚠️ **单位是猜的，而每一次猜都在报告里说出来。** ≤11 位当秒、12–14 毫秒、15–17 微秒、≥18 纳秒——这是启发式，不是解析。于是报告里必有一行「（输入读成「秒」）」；而当猜出来的年份落在 1900…2200 之外时**再加一句**位数提示（「10 位是秒、13 位是毫秒、16 位是微秒、19 位是纳秒」）。🔴 反过来，**「时间戳互转」这一格没有选项**（`TIME_TOOL.options` 是 `undefined`，用例钉住）：加一格「单位」下拉就有了**两个真相来源**，而下拉选「秒」+ 输入 13 位数字时，工具要么不听话要么悄悄改口径，两条都比一句披露难查。⚠️ 位数只数**整数部分**（`1700000000.5` 是秒），数总位数的话它会变成公元 55871 年。
> 10. 🔴 **分派规则是「第一段数字正好 4 位、且后面跟着日期分隔符」，⛔ 不是「第一个字符是数字」。** 后者会把 `1700000000abc` 送进日期解析器，报出来的是「第 1 行第 5 列：年份后面该是「-」」——指着 `0`，而真正的问题在第 11 个字符上。**一个指错方向的错比没有错更坏**（与 M3-B-2 第 8 条、M3-B-3 第 2 条同一条口径）。改完之后它报的是「第 1 行第 11 列：数字后面还跟着别的东西：「a」」。⚠️ 顺带解决了 `2024` 与 `2024.03.05` 的歧义：前者是秒（后面没有分隔符），后者是日期。
> 11. ⚠️ **`describeCharAt` 迎来了第三个调用方**（前两个都在 `codec.ts`）。这一层存在的理由是：**空格在 textarea 里是看不见的**，而它的码位 `0x20` 又落在「可打印窗口」`0x21…0x7e` 之外，于是报出来的是「这个字符（U+0020）」而不是「「 」」。用例把 `'1700000000 1'` 这一份钉住了——报的正是那个空格，⛔ 不是后面那个 `1`。
> 12. 🔴 **纯生成器（`input: 'none'`）需要自己的主动作，于是「重新生成」进了动作排的第一位。** `store.ts` 的 `prefill` 只给 `input: 'editor'` 的工具预填，`runNow` 里对 `input: 'none'` 硬写了 `''`——也就是说这一类工具**不吃输入**，那么「从编辑器取」对它没有意义（按钮不画），而输出是随机的，于是**唯一有意义的重复操作**就是再跑一次。⚠️ 反过来用 `!wantsInput()` 门着：吃输入的工具输出是确定的，给它一个「重新生成」等于给一个不会变的值配一个刷新键——按下去什么都不发生，正是这一份代码一路在躲的那种失败。🔴 它调的是 store 已经导出的 `runNow`（`debounced.now()`），**绕过防抖**；用例是「点一下立刻断言输出变了」，⛔ 没有 `clock.fire()`，于是「接错成 `scheduleRun`」会当场红。⚠️ 样式上**不给 `.primary`**（M2-D / M2-G 那条例外的延续：用户主动发起的操作不弱化、也不加强，轻重靠位置承担）。
> 13. **数字**：前端 2423 → **2496**（72 → **74** 个文件）。M3-B-4 自己 **+73**：新增 `tools/uuid.test.ts` **12**、`tools/time.test.ts` **43**；`tools/builtin.test.ts` 25 → **38**（+13）、`tools/ToolBox.test.tsx` 43 → **47**（+4，「重新生成」那一组）、`App.test.tsx` 164 → **165**（+1，纯生成器那一条端到端）。分项相加 12+43+13+4+1 = **+73**，与实测一致。Rust **407 一条没动**（37 + 328 + 42）：M3-B-4 **一行 Rust 都没写**（🔴 §2 P0 表里「哈希走 Rust 侧」那一格**没做**，见第 15 条）。命令 52 → **54**（`tool.uuid`、`tool.timestamp`），🔴 **快捷键仍 25**。🔴 **Tauri command 仍 21、事件名仍 8、managed state 仍 4、路径接受面一个字没变宽**。新增依赖 **0**（`crypto.getRandomValues` / `Date` / `BigInt` / `TextEncoder` 全是平台自带）。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 278.94KB → **282.19KB**（`index-DXtGvns0.js` 169.61 + `dist-Cx7xBNi0.js` 108.38 + `index-BhMjxJ3w.css` 4.20），预算 300KB，余量 **5.94%**（上一次 7.02%）。**CM6 那个 chunk 与 CSS 的哈希和字节都一个没动**（CSS 没长是因为「重新生成」吃的是全局 `button` 样式、UUID 那三格选项吃的是既有 `.toolbox-option`）。js chunk 仍 **117** 个（另 1 个 CSS）、`dist/index.html` 仍只引 **3** 个。⚠️ **+3.25KB 买了两个工具**（≈1.6KB / 个），是四轮里**单个最便宜**的一次，而它买到的 `time.ts` 是四个里纯活最重的（自己一套 ISO-8601 解析器 + BigInt 换算 + 四种单位启发式 + 五行报告）。⛔ **但别把 3.25 除以二当承诺**：这一批里 UUID 几乎不花钱（几十行 + 一个平台原语），钱全在时间戳上。
> 14. 🔴 **`tools/uuid.ts` 与 `tools/time.ts` 也圈不进懒加载**（M3-B-2 修正 14 / M3-B-3 修正 11 的第三、第四个实例；圈不进去的清单从 5 个模块变成 **7 个**：`tools/registry.ts` + `tools/builtin.ts` + `tools/json.ts` + `tools/codec.ts` + `tools/uuid.ts` + `tools/time.ts` + `util/base64.ts`）。⚠️ 这一条现在有了实测支撑：M3-B-1 修正 13 说「预期每个几百字节，所以这笔账划得来」，四个工具量下来是 **2.40 / 1.28 / ≈1.6 / ≈1.6 KB**（后两个合起来实测 +3.25KB）——一共 **+6.93KB**，占预算 **2.3%**，🔴 **账仍然划得来**，⛔ 但「几百字节」那个预期**一次都没兑现过**，别再拿它做预算。
> 15. 🔴 **§2 那张 P0 表里「生成器」那一行是三格，本轮只碰了两格，而且各交了一半。** ✅ **UUID**：只做了 **v4**。⛔ **ULID / NanoID 没做**——前者要一套 Crockford base32 编码加毫秒时间戳前缀，后者要一份可配置字母表，两个都属于「有人真的要再说」，而加一个就是往 `BUILTIN_TOOLS` 里塞一项描述符（这条设计到本轮为止兑现了**三次**：App 一行没改）。✅ **时间戳互转**：本地（带 UTC 偏移）/ UTC / ISO / 秒 / 毫秒 五行都有。⛔ **没有 IANA 时区选择器**（`Asia/Shanghai` 那一种）：`Intl.DateTimeFormat` 的 `timeZone` 虽然平台自带，但「一格下拉里放哪些时区」是个**产品**决定不是技术决定，推到 M4 与设置系统一起做。⛔ 也**不接受** `Mar 5, 2024` / `5/3/2024` / `2024年3月5日` 这三种写法（`5/3` 是 3 月 5 日还是 5 月 3 日，两种文化里答案相反），也**不做**相对时间（「3 小时前」——它需要「现在」，而「现在」在一个改一个字就重跑一次的面板里是个会自己动的量）。⛔ **哈希（MD5 / SHA1 / SHA256 / SHA512）那一格压根不在用户选的 6 个里**（M3-B-1 修正 3），本轮一行都没写；它要走 Rust 侧（`sha2` / `md-5`，都是 MIT OR Apache-2.0，License 上没问题），推给「有人真的要再说」。
> 16. ⚠️ **真机上要看的（jsdom 钉不住）**：① 🔴 `window.isSecureContext` 在 `tauri://localhost` 下是不是 `true`（第 1 条那笔账的最后一格；我们**不依赖**它，而第 1 条的结论是就算为真也**不要**简化）；② 时间戳那五行报告 + 空行 + 披露句在输出格里读起来顺不顺——它是四个工具里**唯一**一个输出为「多行结构化文案」的，另外三个输出的都是「一段可以插回编辑器的东西」，而输出格的字体与行高是按后者定的；③ 左栏 190px 那一列现在有**第四组**了，最长的一行换成 `UUID 生成（v4）`（M3-B-3 修正 12 ① 那条又有了新样本，而且它带一对全角括号）；④ 🔴 UUID 是第一个 `input: 'none'` 的工具，于是工作区里**只有输出格**加一条三格选项排——那一块看起来会不会像**没做完**（少了一半的样子）；⑤ 「重新生成」在动作排第一位、又没有 `.primary`，读不读得出它是这一类工具的主操作；⑥ M3-B-2 修正 15 与 M3-B-3 修正 12 那七条**一条都没结案**；⚠️ 其中「中文行上 ASCII `^` 歪不歪」这一条本轮**没有新样本**——脱字号画的是输入格里那一行，而时间戳的输入几乎总是纯 ASCII（`2024-02-30`），中文只出现在报告文案里，那一部分不画脱字号。

> **M3-B-5 实施修正**（第五个工具：正则测试器，2026-09-20）
>
> 1. 🔴 **「实时高亮」没做，这是用户的选择，不是漏掉的。** 三选一里选的是「先不做高亮」，另两个是「扩 `ToolResult` 装一份匹配区间清单 + 输出格换成带标记的只读 CM6」与「给正则测试器单独一块面板」。⚠️ 挡住第一条的是**类型**：`ToolResult` 只有 `text`（一段可以插回编辑器的文字）与 `at`（一个下标），装不下 N 个区间；加一个 `ranges` 字段意味着输出格不再是 textarea，而「插回编辑器」「复制结果」两个按钮的语义都要重新想一遍。挡住第二条的是它压根不解决问题——单独一块面板还是要一份区间清单。于是 v1 的口径是：**输出格是一份纯文字报告**，「匹配 N 处」+ 每处的行列 / 下标 / 命中片段 / 各分组，而跳转靠 `at` 指第一处。⛔ 别把 P0 表那一格「实时高亮 + 分组捕获 + 替换预览」当成整格兑现了记账：**分组捕获 ✅、替换预览 ✅、实时高亮 ⛔**。
> 2. 🔴 **`ToolResult.at` 从这一轮起不再是错误专属的。** M3-B-2 引入它时，`ToolBox.tsx` 里读它的那一个 memo 叫 `errorSelection`，并且**只在 `kind === 'error'` 时读**。正则测试器成功的时候也要给一个下标（第一处匹配），否则那份报告只能靠用户自己在输入格里翻——于是那个 memo 改名 `jumpTarget`，按钮文字跟着 `kind` 走：错误 → 「跳到出错处」，成功 → 「跳到第一处」。⚠️ **这一步差点没做**：`at` 在成功结果上原本是**死数据**，而给用户看的那一份选项文字里承诺了「`at` 指第一处，于是跳转按钮按得动」。⛔ 成功的结果上不能写「跳到出错处」——那是一句自相矛盾的话。
> 3. 🔴 **两个扫描器，而它们的地位不一样。** `scanFlags`（标志串）**总是**先跑：标志住在选项格里，引擎那句 `Invalid regular expression flags` 压根不带位置，而自己扫能报「第 1 行第 2 列」并把脱字号画在用户打的那一串上。`scanPattern`（模式串）**只在 `new RegExp` 抛了之后才跑**：引擎是权威，扫描器只是给引擎那句英文补一个中文的位置。与 `json.ts` / `codec.ts` / `time.ts` 逐字同一条口径——**引擎说得出来的，一律用引擎的**。
> 4. 🔴 **扫描器刻意「少报」：查不出来的一律返回 `null`，把引擎的原话放过去。** `a{2,1}`（区间写反）与 `(?<a>x)(?<a>y)`（重复具名分组）都不在它的职责里，两条都被用例钉住「返回 null **且** 报出去的文案里不含『第 1 行』」。⛔ 这是「**一个指错地方的『跳到出错处』比没有这个按钮更坏**」那一条（M3-B-2 修正 8 / M3-B-3 修正 2 / M3-B-4 修正 10）在正则上的第四次落地：宁可少一个位置，不可给一个假位置。
> 5. ⚠️ **惰性量词要一个五状态机**（`prev: 'start' | 'open' | 'alt' | 'atom' | 'quantified'`），四状态是错的。`*` / `+` 要求 `prev === 'atom'` 并把状态置成 `'quantified'`；`?` 接受 `'atom'` **或** `'quantified'`，并且 `prev = prev === 'quantified' ? 'open' : 'quantified'`。于是 `a+?`、`a??`、`a{2,3}?` 合法而 `a+??`、`a???`、`a+*`、`a**`、`(*`、`a|*` 不合法。**第一版写成四状态，症状是 `a+?` 被判成「量词前面没有东西」**——那正是用户最常打的那一种。8 条断言覆盖这一组。
> 6. 🔴 **`(?=a)*` 在 V8 里是合法的**（量词修饰环视没问题），而我在写用例时把它当成了错例，`compileError` 当场抛「模式 /(?=a)*/ 本该编不出来」。⚠️ 这一条记下来是因为它正好是第 3 条那个分工的反面教材：**「我以为引擎会拒绝」不是证据**，只有跑一次才是。它现在在合法清单里，旁边一句「别把它当错例」。
> 7. 🔴 **`$<name>` 的三条规则是实测出来的，⛔ 不是从规范推的**，而第一次推错了两处：① 没有闭合的 `>` → 那个 `$` 原样输出；② 模式里**压根没有**具名分组 → `$<` 也是字面的 `$`，于是 `$<x>` 整串留在输出里；③ 有具名分组、只是名字对不上 → 展开成**空串**。②③ 的差别是差分表抓出来的（`expected '$<nope>' to be ''` 与 `expected 'ac' to be 'a$<x>c'` 两次红）。⚠️ **这份差分表只能在 V8 上跑**（vitest = Node），而真机是 **JavaScriptCore**——它进了真机待验清单（第 17 条 ①），与 M3-B-2 那条「JSC 的 `JSON.parse` 不给位置」是同一类风险。
> 8. 🔴 **`MAX_REGEX_HITS = 200` 只砍清单，⛔ 不砍替换结果。** 一份被砍掉一半的替换文本会被「插回编辑器」当成完整文档写回去，那是一次**静默的数据损坏**——比卡一下坏得多。用例两边都钉了：清单在 205 处上只列 200 条，替换在同样的输入上给出 205 个字符。
> 9. 🔴 **撞上上限时抬头写「匹配 200 处以上」，⛔ 不写「匹配 200 处」。** 这是本轮第二个自己写错、被自己抓住的数（第一个是 M3-B-4 的 `MAX_DATE_MS`）：`hits.length` 是**列出来的**条数，而「匹配 N 处」读起来是总数。用户会拿那个数判断「这个正则在这份文件里常不常见」，一份写着 200、实际是 5000 的报告是一次安静的误导。⚠️ 末尾那一句「…只列出前 200 处，后面还有更多」还留着：它在 200 条之后，正是读者停下来的地方，而抬头已经被滚出屏幕了。
> 10. ⚠️ **`regex.ts` 自带一份行游标，这是仓库里第三份行列实现。** `tool.ts` 的 `locate()` 每次都从 0 数 `\n`，是 O(offset)；`MAX_TOOL_CHARS = 1_000_000` 上 200 处命中就是 2×10⁸ 次比较。于是这里换成一个单调前进的 `LineCursor`。⛔ 三份不是没收拾干净：`locate` 是「一次调用、任意下标」，`lineBoundsAt` 是「就近扫、两个方向都是 O(行长)」，`LineCursor` 是「一串递增下标」——三种访问模式。⚠️ 真要合并，得先把 `describeErrorAt` 也改成收一个游标，那是 M3-C 之后的事。
> 11. 🔴 **灾难性回溯没有超时中断，这是 v1 已知的一条硬限制。** `(a+)+$` 撞上 `aaaaaaaaaaaaaaaaaaaaX` 会把整个窗口冻住，因为 `run` 跑在 UI 线程上，而 `MAX_TOOL_CHARS` 只挡得住「输入太大」，⛔ 挡不住「模式太坏」。真解是 Worker + deadline；⚠️ **那条路没堵死**——`ToolDefinition.run` 的签名本来就允许返回 `Promise<ToolResult>`，`store.ts` 也已经在 `await` 它。不做的原因是：一个 Worker 意味着正则与输入都要结构化克隆过去，而「改一个字就重跑一次」的面板上那笔开销是每 150ms 一次的。记在这里是为了让下一个人不必重新发现一次。
> 12. ⚠️ **「标志」那一格只认 `g i m s u`，三个被排除的各有一句理由。** ⛔ `y`（黏性）：它要求匹配从 `lastIndex` 上开始，而「列出全部匹配」是一路往后走的，带上它的话第一处之后再也不会有匹配——那是个**安静地什么都不报**的结果，于是它单独一句文案（「与『列出全部匹配』互斥」）而不是混进「不认识」。⛔ `d`（`hasIndices`）与 `v`（`unicodeSets`）：这一份压根不读它们给的东西，收下来就是一个「点了没反应」的选项。⚠️ `g` 认，但 `normalizeFlags` 无论如何都会补上它（两件事都要求全局），并且**保持用户打的顺序**、只去重——于是报告抬头里那一串能与格子里的字对上。
> 13. ⚠️ **一个描述符、四个选项，⛔ 不是「正则测试」与「正则替换」两个工具。** 与 `CODEC_TOOL` 同一条理由：拆成两个的话 `pattern` 与 `flags` 要在两份描述符里各写一遍，而「在这一个里调好的模式，切到那一个又得重打」正是这类工具最烦人的地方。🔴 **代价是「替换成」那一格在「匹配清单」这一档下不生效**——这与本文件到处在躲的「安静地不听话的控件」是同一类风险，认了，因为另一条路更差。⚠️ 让它按模式隐藏要给 `ToolOption` 加一个 `visibleWhen`，为一个工具加一套机制不划算。
> 14. 🔴 **`tool.ts` 多了第四种选项 `kind: 'text'`，而 `coerceOption` 对它⛔ 不 trim。** 它装的可能是一个正则，而 `\s` 与 ` \s` 是两个东西；`select` / `number` / `toggle` 三种都不 trim 也不会有人注意，`text` 会。⚠️ **`text` 一条专属校验规则都没有**，这是有意的：`select` 有「默认值必须在候选里」、`number` 有「默认值必须在 min…max 里」，而 `text` 没有对应的跨字段不变量；至于「default 是字符串」，TS 已经钉住了，再写一遍就是给一个不可能发生的场景加校验。🔴 **面板那一格用 `input` 事件 + 非响应式初值 + 只在被拒时写回**：写 `.value` 会把光标推到行尾（jsdom 实测：写**不同**的值 → 光标到末尾；写**相同**的值 → 不动），于是每打一个字都重写一遍的话用户没法在一行正则中间插入字符。⚠️ 初值写 `option.default`（一个普通参数，Solid 当**静态属性**处理）而不是读 store，两者在挂载那一刻必然相等，因为换工具时 `select()` 会 `setOptions(defaultOptions(next))` 并整排重建选项。🔴 **这条设计的全部重量压在「WebKit 写相同的 `.value` 也不动光标」上**，而 jsdom 只能证明它自己——真机待验（第 17 条 ②）。用例钉的是 `.value` 的**写入次数**（0 次），⛔ 不是光标位置，因为 jsdom 上光标断言是空的；那一条自带一个**对照组**（`value={sig()}` 必须写 1 次），于是「0」不可能悄悄意味着「探针没挂上」。
> 15. **数字**：前端 2496 → **2589**（74 → **75** 个文件）。M3-B-5 自己 **+93**：新增 `tools/regex.test.ts` **71**；`tools/tool.test.ts` **52**（+5，`text` 那一组）、`tools/ToolBox.test.tsx` 47 → **55**（+8：文字格那一组 6 条 + 「跳到第一处」那一组 2 条）、`tools/builtin.test.ts` 38 → **47**（+9，正则描述符那一组）。分项相加 71+5+8+9 = **+93**，与实测一致。Rust **407 一条没动**（37 + 328 + 42）：M3-B-5 **一行 Rust 都没写**。命令 54 → **55**（`tool.regex`），🔴 **快捷键仍 25**（「不给单个工具绑快捷键」那条决定的第四个实例）。🔴 **Tauri command 仍 21、事件名仍 8、managed state 仍 4、路径接受面一个字没变宽**（第五个工具，第五次）。新增依赖 **0**（`RegExp` 是平台自带）。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 282.19KB → **284.01KB**（`index-BOqJdQFy.js` 171.42 + `dist-Cx7xBNi0.js` 108.38 + `index-B2FiruYW.css` 4.21），预算 300KB，余量 **5.33%**（上一次 5.94%）。⚠️ **CSS 的哈希四轮以来第一次变**（4.20 → 4.21KB）：M3-B-5a 给文字格加了一条 `width: 180px`——一个装正则的格子按数字格那个 60px 宽是看不见自己在打什么的。CM6 那个 chunk 仍一个字节没动。js chunk 仍 **117** 个（另 1 个 CSS）、`dist/index.html` 仍只引 **3** 个。⚠️ **+1.82KB** 是五个工具里**唯一一次落在预测区间（1–2KB）里**的，而它带着两个扫描器、一份自己的行列游标与一个 `$` 展开器。
> 16. 🔴 **`tools/regex.ts` 也圈不进懒加载**（M3-B-2 修正 14 / M3-B-3 修正 11 / M3-B-4 修正 14 的第五个实例；圈不进去的清单从 7 个模块变成 **8 个**）。⚠️ 于是 M3-C 量体积时要报的那两个数里，「框架 + 工具实现」这一个已经涨到 **8.75KB / 占预算 2.9%**，而它**一个字节都省不掉**；能省的只有「两块浮层 UI」那一个数。
> 17. ⚠️ **真机上要看的（jsdom 钉不住）**：① 🔴 **JavaScriptCore** 对「模式里没有具名分组时的 `$<x>`」是不是也当字面的 `$`（V8 是，规范文本说空串）——第 7 条那份差分表永远只能在 V8 上跑；② 🔴 WebKit 往一个**正在打字**的 `<input type="text">` 里写**相同**的 `.value` 会不会推光标（jsdom 实测不会，而第 14 条那一整套设计压在这一条上）；③ 🔴 一个灾难性回溯的模式是不是真的把窗口冻住，以及这对 v1 可不可以接受（第 11 条）；④ 新的 180px 文字格够不够读懂一个正则，`spellcheck="false"` 是不是真的压掉了红波浪线；⑤ 「匹配清单」那份多行报告在输出格里读起来顺不顺——它刻意用全角冒号而不是列对齐（PLAN 风险 R10），中文与 ASCII 混排时那两格会不会歪；⑥ 左栏现在有**第五组**（测试器）了，最长的一行仍是 `JSON 格式化 / 压缩`，但组标题多了一个；⑦ M3-B-2 修正 15、M3-B-3 修正 12、M3-B-4 修正 16 那十六条**一条都没结案**；⚠️ 其中「中文行上 ASCII `^` 歪不歪」这一条本轮**有了新样本**——正则的输入格里中文很常见，而那三行示意图正是画在它上面的。


> #### 「M3-B-6 实施修正」（2026-09-20，命名风格转换）
>
> 1. 🔴 **六种风格一次全给，⛔ 没有「目标风格」那一格下拉**——与编解码那一个（一格五选一）刻意相反。理由是这个工具的实际用法：手上有 `user_name`，**要看一眼才知道**自己要的是 `userName` 还是 `UserName`；做成下拉的话用户得先在六个英文名字里想清楚要哪个，而想清楚的办法正是把它们都看一遍。⚠️ 代价与时间戳那一个一样：输出是**报告**不是「一段可以插回编辑器的东西」，于是「插回编辑器」插进去的是六行带标签的对照表——真正按得动的是「复制结果」，或者直接在输出格里选中要的那一段。M3-B-4 已经为时间戳认下了这一条，这里是第二次。
> 2. 🔴 **整个输入被当成一个短语，⛔ 它不是批量转换器。** 换行与空格在这里与 `_`、`-` 是同一类东西（分词符），于是粘两行 `foo\nbar` 得到的是 `fooBar`，⛔ 不是「两行各转一遍」。「一列标识符批量换风格」是另一个工具（输出形状是 N 行不是 6 行，而且要决定按列对齐还是按块分组），推给「有人真的要再说」。
> 3. 🔴 **难的那一半是分词，不是拼接。** 拼六种风格是六行 `join`；分词要同时应付四类边界，而 naive 的 `/[A-Z]/g` 一条都不对：`HTTPServer` 会变成 `h_t_t_p_server`（合法蛇形、完全没用）、`already-kebab` 会被整串当成一个词、`__dunder__` 会连下划线一起留下。判据「大写串后面跟小写要在**最后那个大写前面**断」必须能往前读一个字符，所以 `splitWords` 是带 `s[i + 1]` 的单趟扫描。⚠️ 真机上最容易撞见的正是这一类：`XMLHttpRequest`、`IOSVersion`、`AWSRegion` 到处都是。
> 4. ⚠️ **大小写信息在分词那一步就被抹平了。** 词一律归一成小写，于是 `HTTPServer` 的大驼峰是 `HttpServer` 而**不是** `HTTPServer`。⛔ 这不是漏了：要保住缩写的全大写就得在词上多带一份「它原本是不是全大写」的标记，而那份标记在蛇形与短横线上没有意义、在小驼峰上会产生 `hTTPServer` 这种东西。只有常量式看起来「还原」了缩写，而那也不是还原，是巧合。
> 5. 🔴 **第一版有两个 Unicode bug，都是在跑之前重读时发现的，而它们都属于「能编译、能跑、结果全错」那一类。** ① 字符类写成了 `/[^\P{L}\P{N}]/`（双重否定）——一个汉字**同时**是 `\P{N}`（不是数字）与 `\p{L}`（是字母），于是被那个 `^` 排除掉，结果是**所有中文都成了分隔符**；② 没有 `u` 标志——那样 `\p{L}` 压根不是 Unicode 属性转义，而是「`p` 出现 `{L}` 次」。⚠️ 这两个都不会报错、不会抛、也不会让任何一条「纯 ASCII」的用例变红，而它们会让这一个工具在中文用户手上完全失效。修法是 `const WORD_CODE = /[\p{L}\p{N}]/u`。
> 6. 🔴 **按下标走会静默吃掉补充平面上的字符。** `𠀀`（U+20000）在 UTF-16 里是两个代理项，`for (let i = 0; i < s.length; i++)` 会各拿到半个，而那半个既不是字母也不是数字，于是那个字被当成分隔符**丢掉**。改成按码位走（`codePointAt` + `len = code > 0xffff ? 2 : 1`），并且**另存一份 `lastCode`** 而不是从 `current` 的尾巴上取——`charCodeAt(current.length - 1)` 取的正是那个低代理项。
> 7. ⚠️ **「空输入」与「有输入但切不出词」是两种情况。** 前者返回 `ok` + 空串（于是输出格显示 `OUTPUT_PLACEHOLDER`，与 JSON / 正则那两个同一条口径，⛔ 不给六行空的 `小驼峰（camelCase）：`）；后者（`___`、`---`、`...`）返回 `ok` + 一句人话「这一串里没有字母或数字，没有可转换的词」——静默空串的话输出格显示的还是占位文字，读起来像是没跑。🔴 而它是 `ok` 不是 `error`：那一串不是**写错了**，只是里面没有可转换的东西。
> 8. 🔴 **永远不带 `at`**，而 `renderStyle` 的 `switch` **没有 `default` 那一支**。前者是因为 `at` 的坐标系是输入格，而「哪一种风格写错了」这件事没有位置可指（正则那一个能带是因为它指的是第一处匹配）；后者是因为 `NamingStyle` 是六个字面量的联合，六支写全之后 TS 自己知道这个 `switch` 是穷尽的——加一支「万一不认识就抛」是给一个类型上到不了的情况写代码，而它会变成一份永远跑不到的分支（与 `codec.ts` / `time.ts` 同一条口径）。
> 9. **数字**：前端 2589 → **2623**（75 → **76** 个文件）。M3-B-6 自己 **+34**：新增 `tools/naming.test.ts` **28**、`tools/builtin.test.ts` 47 → **53**（+6，命名风格描述符那一组）。分项相加 28+6 = **+34**，与实测一致。Rust **407 一条没动**（37 + 328 + 42）：M3-B-6 **一行 Rust 都没写**。命令 55 → **56**（`tool.naming`），🔴 **快捷键仍 25**（「不给单个工具绑快捷键」那条决定的第五个实例）。🔴 **Tauri command 仍 21、事件名仍 8、managed state 仍 4、路径接受面一个字没变宽**（第六个工具，第六次）。新增依赖 **0**。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 284.01KB → **284.61KB**（`index-DniRLlC2.js` 172.02 + `dist-Cx7xBNi0.js` 108.38 + `index-B2FiruYW.css` 4.21），预算 300KB，余量 **5.13%**（上一次 5.33%）。**CSS 与 CM6 那个 chunk 的哈希与字节都逐字没动**——新增的 0.60KB 全在 `index` 里。js chunk 仍 **117** 个、`dist/index.html` 仍只引 **3** 个。⚠️ **+0.60KB 是六个工具里最便宜的**，而它恰好是纯活最少的那个：没有扫描器（不需要定位，于是 `describeErrorAt` / `locate` 一次都没白拿）、没有选项格、没有 BigInt，只有一个单趟分词器加六行 `join`。🔴 它因此**证伪**了「越晚加越便宜是因为共享层摊薄了」这条读法——正则那一个比它晚一轮却贵三倍，差别在纯活的量。
> 10. 🔴 **`tools/naming.ts` 也圈不进懒加载**（M3-B-2 修正 14 / M3-B-3 修正 11 / M3-B-4 修正 14 / M3-B-5 修正 16 的第六个实例；圈不进去的清单从 8 个模块变成 **9 个**）。⚠️ 于是 M3-C 量体积时要报的那两个数里，「框架 + 工具实现」这一个已经涨到 **9.35KB / 占预算 3.1%**，而它**一个字节都省不掉**；能省的只有「两块浮层 UI」那一个数。
> 11. ⚠️ **真机上要看的（jsdom 钉不住）**：① 左栏现在有**第六组**（文本）了，而它只有一个成员——一个只有一个成员的组标题读起来是不是多余；② 这一个工具的右栏**没有选项条**（`ToolBox.tsx` 那一句 `<Show when={(tool.options ?? []).length > 0}>` 把整条藏了），于是只有输入格 + 输出格，这一种最简布局看起来是不是残缺（时间戳那一个是同一种形状，M3-B-4 修正 16 ⑯ 已经问过一遍，**没结案**）；③ 六行对照表在输出格里读起来顺不顺——它刻意用全角冒号而不是列对齐（PLAN 风险 R10），而六个标签的中文长度不一样（`小驼峰（camelCase）：` 与 `常量（CONSTANT_CASE）：` 差两格）；④ 「插回编辑器」把六行对照表整份写进文档，这个行为在这一个工具上是不是应该在 UI 上劝退（⛔ 本轮**没做**任何劝退，只是记下来）；⑤ M3-B-2 修正 15、M3-B-3 修正 12、M3-B-4 修正 16、M3-B-5 修正 17 那二十四条**一条都没结案**。

> **M3-C 实施修正**（懒加载：预览链 + 两块浮层 UI 移出首屏，2026-09-20）
>
> 1. 🔴 **改判：M3-C 只兑现了 C-1（预览链）与 C-2（两块浮层 UI），⛔ §2.9 那张懒加载清单没有全部兑现。** 清单原列七样：`md/render`、`md/export`、`md/preview`、`md/paste` + `ipc/asset`、`doc/stats`、`commands/CommandPalette.tsx`、`tools/ToolBox.tsx`。本轮移出去的是**前五样里的前三个 + 后两个**（render / export / preview / MarkdownPreview / CommandPalette / ToolBox），⛔ **`md/paste` + `ipc/asset` 与 `doc/stats` 仍在首屏**（取证：生产构建的 entry chunk 里搜得到 `md/paste` 那句「先存一次」的拒绝文案，而 `doc/stats` 是 `App.tsx:16` 的静态 import）。这一半推给 **M3-C-3（未做）**，理由分两条：① 🔴 `md/paste` 的 `acceptsPastedImage` 是 CM6 粘贴 DOM 处理器里那道**同步闸**（M3-A-7 修正 8：钩子必须同步回答「接不接」，那一刻之后任何异步都来不及），要把它移出首屏就得先拆成「同步闸留首屏 + `landPastedImage` 按需」，⛔ 不是加一个 `lazy()` 就行；② ⚠️ `doc/stats`（`textStats` / `describeStats`）只被字数命令 `Mod+Shift+C` 用，命令处理器本可以 `await import('./doc/stats')`，但本轮没做。⚠️ 于是 §2.9 那一行「M3-C 的懒加载是把它买回来的唯一手段」这句话**只兑现了一部分**，余量从 5.13% 买回到 **7.54%**，⛔ 不是「全部买回来」。
> 2. 🔴 **C-1 最值钱的不是 `MarkdownPreview.tsx` 自己（1.82KB 按需），是它身后那条链。** `MarkdownPreview` → `md/preview`（0.33KB）→ **`md/render`（3.61KB 按需，全仓最大的一个前端模块，41KB 源）**，再加上 `md/export`（1.88KB，它 import `render` 的 `escapeHtml`，所以让 render 变懒自然把它带走）。这四个里**只要有一个还在首屏静态引用，那个渲染器就一个字节都省不掉**。⚠️ 反过来 `md/table.ts`（`alignTableAt`，`Mod+Shift+A`）与 `md/outline.ts` / `md/panel.ts` **必须留在首屏**——表格对齐是一条随时可能按的命令，而 M3-A-5 修正 3 已经把依赖方向钉成 `render` → `table`（不是反过来），正是为了让「按一下 `Mod+Shift+A` 不把渲染器拖进首屏」这件事成立。🔴 这一条到 M3-C 才算真的兑现：此前 `App.tsx` 静态 import `MarkdownPreview`，所以 render 一直在首屏里，那条依赖方向只是**预防**、还没**收益**。
> 3. 🔴 **C-2 挪走的只有组件，⛔ 不是它们身后那套状态。** `createToolBox`（`tools/store.ts`）与 `createCommandPalette`（`commands/palette.ts`）都还在首屏里**同步**跑——前者在启动那一刻把六个工具投影成命令塞进注册表，后者把命令清单读进一个 memo，而注册表在启动时就要是全的（`Mod+Shift+T` / `Mod+Shift+P` 本身就是注册表里的命令，键绑定挂在 `window` 的捕获阶段，与浮层画没画出来无关）。🔴 同理 M3-B-2~6 修正里反复点名的那 **9 个模块**（`tools/registry` + `builtin` + `json` + `codec` + `uuid` + `time` + `regex` + `naming` + `util/base64`，**9.35KB / 占预算 3.1%**）一个都没挪、也挪不了。⚠️ 所以 C-2 省下的是**画浮层的那份 JSX 与它自己的类名**（ToolBox 2.56KB + CommandPalette 1.35KB = **3.91KB 按需**），而工具的纯活照旧常驻——M3-B-1 修正 13 要求的「两个数分开报」到这里才报得出来（见第 8 条）。
> 4. 🔴 **`lazy` 外面必须再套一层同条件的 `<Show>`，里面那层不删。** 两块浮层的可见性归 App 管，而组件**内部**各自已经包了 `<Show when={…visible()}>`。要懒加载就得在**外面**再套一层同条件的 `Show`——否则组件在启动时就挂载了（只是渲染成空），`lazy` 那一次 `import()` 也就跟着提前到了首屏，等于白拆。⚠️ 里面那一层因此看着冗余，但**不删**：chunk 什么时候回来是不受控的，「按下 `Mod+Shift+T` 又立刻 `Esc`」那一下会让组件在 `visible()` 已经是 false 之后才挂载，那时兜住它的正是里面那一层。⚠️ Solid 的 `Suspense` **不产生 DOM 节点**，所以 `.body-row` 那个横向 flex 的子元素顺序与个数一个都没变（`MarkdownPreview` 那一栏同理）。
> 5. 🔴 **测试侧量出来一条真发现：Solid 的 `lazy` memo 是全局的，而顶层预热焐热的是模块、⛔ 不是那份 memo。** `App.test.tsx` 顶上那段 `await Promise.all([import('./md/MarkdownPreview'), …, import('./tools/ToolBox'), import('./commands/CommandPalette')])`（M3-C 加的）把 vite-node 的**模块缓存**焐热了，于是 `lazy` 那一次 `import()` 只剩微任务、一个 `flush()`（`setTimeout(0)`）就够——**但 `lazy` 组件自己那份「解析好了没」的 memo 是模块级全局的，预热碰不到它**。后果是：每块浮层**第一次**被触发时仍要等一个微任务才渲染进 `Suspense`。于是全量跑时只有「首个打开工具箱」与「首个打开命令面板」那两条红（`toolboxEl()` / `commandPaletteEl()` 同步断言拿到 `null`），而其余几条**靠前面用例已经把全局 memo 焐热**侥幸绿。🔴 **取证方式不是读代码，是单独跑**：`pnpm test src/App.test.tsx -t "Esc 收起工具箱"` 在冷启动下**当场红**（`expected null not to be null`），证明它的绿是**执行顺序**给的、不是自己挣的。修法是块内 **9 个**打开浮层的用例统一在 `press()` 之后 `await flush()`，与顺序无关；⛔ **不靠多加几次 `flush()` 蒙**——预热注释那条「冷缓存必然偶发」的论证仍然成立，预热 + 单次 `flush()` 是**配套**的（预热把 import 压成微任务，单次 flush 才够）。
> 6. ⚠️ **首屏 CSS 一个字节没动**（还是 `index-B2FiruYW.css` / 4.21KB，哈希同 M3-B-5）。懒加载只切 **JS**，那**一个** CSS chunk 不拆（`build.cssCodeSplit` 没开，rolldown 把所有组件的样式并进同一张表），而两块浮层与预览的类名本来就在里面。⚠️ 所以「浮层 UI 移到按需」这句话**只对 JS 成立**，CSS 那 4.21KB 仍全额首屏——要连 CSS 一起省得另开 `cssCodeSplit`，本轮没做。
> 7. 🔴 **CM6 那个 modulepreload chunk「一个字节没动」的不变量到 M3-C 断了。** 自 M2-E 起它一直是 `dist-Cx7xBNi0.js` / 108.38KB，M3-C 之后变成 **`dist-uhAGXbQS.js` / 100.21KB**（哈希与字节**都**变）。原因是引入 `lazy()` 边界后 rolldown 重画了分包图，在 entry 与那个共享 vendor chunk 之间挪了模块（entry 172.02 → **172.95**，vendor 108.38 → **100.21**，两者一升一降）。⚠️ **不是 CM6 被懒加载了**：编辑器仍首屏（`EditorPane` + CM6 基础扩展在 entry，CM6 内核在 modulepreload，App 一挂载就能编辑，165 条 App 用例全绿即是证），只是分包边界重画。🔴 所以 PLAN 里那句「CM6 那个 chunk 一个字节没动」从 M2-E 起成立、**到 M3-C 不再成立**，§2.9 那一行已按此改口。
> 8. **数字**：前端 **2623 一条没动**（76 个文件）——M3-C 加 **0** 条用例，只把「工具箱与命令面板接线」那个 describe 里 **9** 条从同步改成 `async` + `await flush()`（含两条原本就红的：首个开工具箱、首个开命令面板）。Rust **407 一条没动**（37 + 328 + 42）：M3-C **一行 Rust 都没写**。命令仍 **56**、快捷键仍 **25**、🔴 **Tauri command 仍 21、事件名仍 8、managed state 仍 4、路径接受面一个字没变宽**（懒加载是纯前端打包，没碰任何一条通路）。新增依赖 **0**（`lazy` / `Suspense` 是 solid-js 自带，动态 `import()` 是平台自带）。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 284.61KB → **277.37KB**（`index-DLQUEx4N.js` 172.95 + `dist-uhAGXbQS.js` 100.21 + `index-B2FiruYW.css` 4.21），预算 300KB，余量 **7.54%**（上一次 5.13%，**买回 2.41 个百分点**）。js chunk 117 → **123**（**+6** 个懒加载 chunk：`render` / `export` / `MarkdownPreview` / `preview` / `ToolBox` / `CommandPalette`），`dist/index.html` 仍只引 **3** 个（⛔ `manualChunks` 一条都没加）。<br>🔴 **M3-B-1 修正 13 要的两个数分开报**：① **框架 + 工具实现（常驻，圈不进去）= 9.35KB / 占预算 3.1%**（9 个模块逐字未动）；② **两块浮层 UI（可按需）= 3.91KB**（ToolBox 2.56 + CommandPalette 1.35，已从首屏移进懒加载 chunk）。⚠️ C-1 那条预览链另算 **7.64KB 按需**（render 3.61 + export 1.88 + MarkdownPreview 1.82 + preview 0.33）。⚠️ **移出首屏的合计 11.55KB 与净降的 7.24KB 对不上**，差在 chunk 包装开销（每个懒加载 chunk 有自己的 require 包装）与 entry/vendor 那次重分包（第 7 条），⛔ 别把 11.55 当成首屏收益。
> 9. ⚠️ **真机上要看的（jsdom 钉不住，一个数都没有）**：① 🔴 **第一次**打开预览 / 工具箱 / 命令面板那一跳动态 `import()` 在 Tauri 里是不是真的毫秒以下（读一个本地文件），有没有看得见的白屏或 `Suspense` 闪烁——jsdom 里那一跳被预热压成了微任务，真机是 WKWebView 第一次去取一个本地 chunk；② 🔴 `lazy` 的 `Suspense` fallback 现在是**空的**（`Suspense` 不产生 DOM），第一次打开那一瞬浮层位置是不是空的、会不会闪一下才出现（与 M3-B-1 修正 14 ④「两块浮层交接看不看得出闪烁」是同一类，但那次说的是「面板里挑工具」，这次说的是「冷启动第一开」）；③ ⚠️ 所有体积数是**生产构建产物**量的（`vite build` + gzip），jsdom 量不出真实分包与网络，真机 WKWebView 的加载时序另算；④ ⚠️ M3-B-2 修正 15、M3-B-3 修正 12、M3-B-4 修正 16、M3-B-5 修正 17、M3-B-6 修正 11 那二十九条**一条都没结案**，M3-C 是纯打包改动，一个观感项都没碰。
> 10. 🔴 **M3-C-3（未做）的清单与它卡住的地方，记在这里省得下一个人重新发现。** 要移的是 `doc/stats`（字数命令里 `await import`，无约束，纯没做）与 `md/paste` + `ipc/asset`（⛔ 卡在第 1 条①那个同步闸：得先把 `acceptsPastedImage` 留在首屏、只让 `landPastedImage` 按需，而它俩现在同住 `md/paste.ts`）。⚠️ `util/base64.ts` 就算 `ipc/asset` 移走了也**仍留首屏**——它被常驻的 `tools/codec.ts` 静态引用（M3-B-3 修正 11 早记过这一笔），⛔ 别把它算进 M3-C-3 的收益里。⚠️ 这三样都是小模块（stats / paste / asset 各约 1KB 量级），M3-C-3 真做完预期再省 3~4KB、余量到 ~9%，⛔ 不是数量级的改善——要不要做取决于 M4 加主题/字体切换 UI 时余量够不够。

---

### 3.6 M4 · 主题、字体、打磨（6.5–8.5 人日）

| 工作项 | 人日 | 要点 |
|---|---|---|
| 主题系统 | 1.5 | CSS Variables 架构、内置 3 套基础主题 + 3 套流行配色移植（逐个核对 License）、跟随系统、用户自定义主题加载（`~/.vela/themes/`） |
| 字体管线产品化 | 2 | 分片懒加载落地、字体切换 UI（编辑器/UI/正文三区独立）、字号/行高/字间距设置、按需下载额外字体 |
| P1 功能 | 1.5 | Minimap、Git gutter（只读行级标记）、拖拽文件打开。⚠️ 原行还列着「在 Finder 中显示、复制路径」——**这两条 M2-B-5 已经交付了**（右键菜单里，调 macOS 自带命令，见 §3.4「M2-B-5 实施修正」3），人日因此从 2 降到 1.5 |
| 性能调优 | 1.5 | 冷启动剖析、内存泄漏排查（EditorView 释放）、大文件回归、搜索性能 |
| 项目级配置 | 1 | ✅ **M4-A 已交付**（原为 🔴 **M2-F 推过来的**，用户在「M2-F 里做 / 推到 M4」两选一里选的后者，理由见 §3.4「M2-F 实施修正」1）：`.vela/settings.json` + 用户全局 `~/.vela/settings.json` + 内置默认，**三层合并**；「哪一层能改哪些键」已定下来（逐键 allowed-layers 门）。⚠️ **v1 只迁了字体三键、且项目层空转**，详见下面「M4-A 实施修正」。⚠️ 上面那张 M2-A 修正 4 里说的「类型分组排序」要是哪天有人要，开关就落在这一层——**那个项目安全档现在建好了但是空的**，它会是第一个成员 |
| 依赖评估 | 0.5 | 评估切 `notify` 9.0.0-rc（三项 macOS FSEvents 专项优化：`with_fsevent_latency`、回调性能、单一 stream root） |

**验收**：§2.9 的性能与体积预算全部达标。视觉上有辨识度、不廉价。

> **M4-A 实施修正**（项目级配置：三层合并 + 字体信号迁移，2026-09-20）
>
> 1. 🔴 **用户裁定三条，逐条落地。** ① **v1 schema = 迁移现有字体信号**（不是先搭一个空架子）：`fontSize` / `fontVariant` / `codeFont` 三个键从 `App.tsx` 里三个**只活在内存里**的信号（调好字号、重启回 14px）接到持久化配置上，于是「我设的字号」跟着人走。② **多根工作区只认第一个根**：项目层路径由 `roots[0]` 推出（`<root>/.vela/settings.json`），Rust 侧 `load` 收 `Option<&Path>`、command 层取 `roots.first()`。③ **个人偏好只认全局**：三个键全是**偏好类**，allowed-layers = 「内置默认 + 用户全局」，项目层**读得到、也校验、但对偏好键不生效**——Rust 的 `resolve` 把项目层写的偏好键丢进 `report.ignoredProjectKeys`。
> 2. 🔴 **项目层在 v1 是「接好线但空转」的，这是一句实话不是缺陷。** 三个键全是偏好类，所以打开一个带 `.vela/settings.json` 的仓库**不会**改掉你的字号。项目安全档（allowed-layers 含项目层的那一档）**结构上建好了、但 v1 里一个成员都没有**——第一个成员将是 M3-A-7 那个「粘贴落地目录/命名」的路径值键（见第 8 条）。⚠️ 于是 `load` 在 roots 变化时**仍然要重跑**：v1 里合并出的配置不随 roots 变（项目层不生效），但那份**账单**（`ignoredProjectKeys`）会变——换一个仓库，它想覆盖的键可能不一样。`App.tsx` 用一个 `createEffect(() => void settings.load(tree.roots()))` 钉住这条。
> 3. ⛔ **`ignoredProjectKeys` 的用户可见提示 v1 没做，这是有意推迟、不是漏掉。** `SettingsStore.report()` 已原样暴露那份账单、也被 `store.test.ts` 钉住（这是文档化的接缝），但 `App.tsx` 的 `settingsNotice` **只接到 `onWarn`**（load/save 的错误），没有据 `report().ignoredProjectKeys` 说「这个仓库想改你的字号，但字号只认全局」。理由：v1 里它**几乎永远不会触发**（没有仓库带 `.vela/settings.json`，而且三个键全是偏好类），而等第一个项目安全键落地时这句话的措辞与触发条件都要重画——现在做等于为一个空集写文案。
> 4. 🔴 **sanitize 只在前端 store 夹一次，Rust 侧刻意不夹、不校验 ID。** `Settings.fontSize` 是个裸 `u32`、两个字体 ID 是裸 `String`：合法档位清单（`FONT_SIZES`）与合法 ID（`FONT_VARIANTS` / `CODE_FONTS`）都是 **UI 概念**，Rust 不知道它们存在。夹一次就够，两边各夹一次的结果是谁也说不清最终值（与 `SessionRoot.expanded` 的 `MAX_RESTORED_EXPANDED`、`recent` 的 `MAX_RECENT` 同一套分工）。⚠️ **用 `hasOwnProperty` 而不是 `in`**：配置文件是**不可信输入**（可能被手改、可能来自克隆的仓库），`in` 会命中原型链，于是 `"toString"` 这种字符串会被当成合法字体 ID——`store.test.ts` 专门钉了这条。
> 5. 🔴 **写穿用一条 promise 队列，不用定时器、不用 debounce。** 与 `doc/sessionSync.ts` 逐字同一套做法：所有写挂在 `tail` 链尾，任意时刻最多一个写在飞，于是「快速连按 `Cmd+=`」不会让两次原子写以乱序 rename 收场（那样盘上可能停在中间某一档）；再加一个 `lastSent` 指纹跳过没变化的写（同步连按三下只落一次盘、存的是最终值）。⛔ **不用 `vi.useFakeTimers()`**——理由与 sessionSync 相同：假表会把 `requestAnimationFrame` 一起冻住，而 CM6 跑在 rAF 上。另有一个 `loadGen` 代号挡住「迟到的旧 load 盖掉新 load」（roots 快速连变时会有多个 load 在飞）。
> 6. 🔴 **安全姿势：写盘落点完全由 Rust 算，前端碰不到。** `save_settings` **不收任何路径参数**——落点 `~/.vela/settings.json` 由新增的 `home_dir(app)` helper（`app.path().home_dir()`）算出，与 `session_path` 同一条姿势。`load_settings` 是这一轮**唯一**新收前端路径的命令（`roots[0]`），而它只拼写死的相对段 `.vela/settings.json`，且 `roots` 只可能来自 dialog 插件（与 `index_project` 同一信任面）。⛔ **路径接受面没有变宽**：`src-tauri/src/commands.rs` 那张「谁能碰到磁盘」的表从 15 行涨到 17 行，但新两行里只有一行收前端路径，理由写在那张表底下的 ⚠️ 注里。
> 7. ⚠️ **两边各写一份的契约常量又多了三个**：`DEFAULT_FONT_SIZE`(14) / `DEFAULT_FONT_VARIANT`("screen-gb") / `DEFAULT_CODE_FONT`("maple-cn") 在 Rust `settings/mod.rs` 与前端各存一份，由 `wire_contract.rs`、`ipc/settings.test.ts`、`settings/store.test.ts` 各钉（与 `MAX_SESSION_TABS` 同一套做法，没有代码生成）。🔴 `ipc/settings.test.ts` 还有一条把契约默认值与**字体注册表**的 `DEFAULT_VARIANT` / `DEFAULT_CODE_FONT` 对起来——漂了会当场红，而不是悄悄退化成「换了个默认字体」。
> 8. ⛔ **M3-A-7 修正 2 那半句「路径与命名可配置」到 M4-A 仍然没交付。** 配置管线与项目安全档的**接缝**这一轮建好了，但那个资产目录键**没有接进去**：`md/paste.ts` 里目录仍写死 `ASSET_DIR`、命名仍写死 `pasted-<哈希>`。它是项目安全档的**第一个候选成员**，真要接时还得回头改 paste.ts 那句「rel 不含空格/括号/引号所以不需要 `<>` 包裹」——命名规则一旦可配置那句话就不成立（M3-A-7 修正 2 已记）。⚠️ 同理 M2-A 修正 4 的「类型分组排序」开关也仍只是「会落在这一层」，没落地。
> 9. **数字**：前端 **2623 → 2668（+45）**：`ipc/settings.test.ts` 16 + `settings/store.test.ts` 21 + `App.test.tsx`「分层配置接线（M4-A）」8。Rust **407 → 428（+21）**：vela-core lib 328 → **342**（+14，settings 模块单测）、`wire_contract.rs` 42 → **49**（+7，settings 线上形状）。🔴 **Tauri command 21 → 23**（`load_settings` / `save_settings`），**managed state 仍 4**（配置层无状态：每次 load 现读现合并，不缓存），**事件名仍 8**，路径接受面见第 6 条。新增依赖 **0**（serde 早在）。**八道门禁全绿**，`stderr` 干净。<br>首屏 gzip 277.37KB → **277.84KB**（`index-CXlrqgld.js` **173.42** + `dist-uhAGXbQS.js` 100.21 + `index-B2FiruYW.css` 4.21），预算 300KB，余量 7.54% → **7.39%**（**+0.47KB**，全落在 entry：settings store + ipc + App.tsx 接线）。⚠️ **modulepreload chunk 与 CSS 一个字节没动**（`dist-uhAGXbQS.js` 100.21、CSS 哈希仍 `B2FiruYW`）——M4-A 没引入任何新懒加载边界，也没加一行 CSS（`settingsNotice` 复用既有 `.notice warning`）。
> 10. 🔴 **真机上要看的（jsdom 钉不住，一个数都没有）**：① `~/.vela/settings.json` 是不是真的被原子写出来了（temp 同目录 + `sync_all` + rename + fsync 父目录），重启后字号/字体是不是真的回来了——jsdom 里 `save_settings` 是个 mock，盘上一个字节都没落；② 手改一个**非法**值进配置文件（`fontSize: 17`、`fontVariant: "toString"`），真机是不是退回默认而不是白屏或注入一个不存在的 webfont；③ 放一个带 `.vela/settings.json`（写 `fontSize`）的仓库，打开后字号**不该**变（项目层对偏好键空转），这条在真机上才看得见「空转」是不是真的空转；④ 切换字体时 webfont 注入在真 WKWebView 里的时序（`applyNow` 里 `void applyFontVariant/applyCodeFont`，首屏不等它）。

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
| R2 | **中文字体 24MB 拖垮「轻量」** | 🟢 **已收敛** | 安装包破 100MB，违背核心诉求 | ✅ **M0 实测：unicode-range 懒加载生效，安装包体积达标**。原风险基于「18.4MB=单变体」的错误估算，实际是 4 变体总和。<br>📌 **D2 分字体后我们确实同时打包 3 个 family / 433 片 / 18.07MB**（文楷 GB 4.33 + 文楷 R 4.87 + Maple 8.87），`.app` 合计 **23MB**，对 40MB 预算余量 **42%** → 安装体积这条已闭合，**不需要「只打包一个变体」**（那会牺牲代码区列对齐，见 R4）。<br>⚠️ **首屏这条也已闭合**：M1-G 按真首屏口径重测是 **26 片 / 1.039MB**，预算 2MB 余量 48%；M0 记的 2.219MB 是压测文档稳态误标为首屏，「按字频重排」的修法一并作废（分片本来就按字频排）。<br>🔴 **R2 剩下的两条真遗留都不在体积**：① **RFN**——上游声明了 `Reserved Font Name 'LXGW'` 等，而我们以 `'LXGW WenKai Screen'` 分发第三方子集化的 woff2，商业化发布前必须定（取得书面许可 / 改名 / 换字体）；② **中文 Markdown 表格走 Maple**（D2 把 `Table` 划进代码区），一篇中文文档会同时拉两套 CJK 字体。详见 §3.3「M1-G 实施修正」4、5 | M0 ✅ / M1-G 结案 |
| R3 | CM6 + Vite 生产构建陷阱 | 🟡 **已命中并修复** | 上线前才发现构建产物坏了 | ✅ M0 就验证 `vite build`，**果然踩中三个坑**：rolldown 拒绝对象形式 manualChunks、esbuild 不再内置（须 `minify:'oxc'`）、粗粒度 manualChunks 摧毁懒加载（623KB→284KB gzip）。详见 §2.3。**若留到 M6 才发现，返工成本会大得多** | M0 ✅ |
| R4 | CJK 列对齐漂移 | 🟢 **已收敛** | 代码区表格/缩进视觉错位 | ✅ **M0 实测通过**：代码区换 Maple Mono CN 后，在 CM6 里真实的 `.vela-code` 行上量到 CJK/ASCII = **2.0000**、框线/ASCII = **1.0000**、ASCII 极差 **0.0001px**、50 字累积漂移 **0px**，三轮独立复现（含一次 `visible` 复测）。文楷仅用于正文/UI（其拉丁是**比例宽度**，根本不等宽，故必须分字体）。<br>📌 量具本身已自动化，**不再需要人眼判定**；剩余口子是 dPR=2 与将来新增可切换字体时要重跑一遍。详见 §3.2 #3 | M0 ✅ / M4 |
| R5 | 大文件 IPC 序列化爆内存 | 🟢 **已收敛** | 打开大文件即崩溃 | ✅ **M2-H 已落地，而应对手段与原写不同**：原写「单次 payload 上限 4MB；>50MB 走 `ropey` 只读分片模式」——**`ropey` 从未进过 `Cargo.toml`**，改成「稀疏行索引 + 按需读盘」，Rust **不持有全文**（作废理由见 §3.4「M2-H 实施修正」1）。三条上限各管一件事：`MAX_INLINE_BYTES` **4 MiB**（单次 IPC payload，与原写一致）、`MAX_SHARD_BYTES` **256 MiB**（超过就拒绝打开，不退化成别的模式）、`MAX_PAGE_LINES` 1024 / `MAX_PAGE_BYTES` **1 MiB**（单次 `read_lines` 的回复，⚠️ **原计划里压根没有这一条**，而它才是「分片模式自己不爆内存」的真正守卫——只把 4MB 那条用在打开上、却让分片一次回一整段，等于把同一个洞挪了个位置）。<br>⚠️ **两个残留口子**：① 单行超过 1 MiB 会污染它所在的那一整段锚点，前端显示占位、继续往下滚自愈（修正 4）；② 搜索的 `MAX_FILE_BYTES` 抬到 **64 MiB** 之后，**64–256 MiB 这一段打得开却搜不到**，缺口是有意的、计入 `skipped_too_large` 上报（修正 3）。<br>🔴 **而「爆内存」这件事本身一个真机数都没有**：开着几个大分片时的 `phys_footprint`、`open_shard` 建索引的冷读耗时、64 MiB 规模的真机搜索/替换峰值，全在 §3.4「M2-H 实施修正」12 那份债里 | M2 ✅（M2-H） |
| R6 | **API 发布即冻结** | 🟡 中 | 未来插件生态被烂 API 锁死 | M5 用示例插件反向验证；API 面从第一天就极小；带版本号 + shim 适配层 | M5 |
| R7 | License 误用（GPL/AGPL/BUSL 传染） | 🟡 中 | 闭源商业化受阻，法律风险 | 严格遵守 §2.10 清单；不 fork athas/hermes/Zed；Sarasa Gothic 与主题配色逐个核对；商用前法务复核 | 全程 |
| R8 | 范围蔓延（想做 LSP/终端/AI） | 🟡 中 | 工期翻倍，轻量定位丢失 | §1.3 非目标清单为硬约束；任何新增功能需先证明属于四个核心场景之一 | 全程 |
| R9 | CM6 长行 + 自动换行「pop 抖动」 | 🟢 **已实测，低** | 特定文档滚动手感 | ✅ **M0 已测**：超长行 fixture 下换行开/关两档帧率差在噪声带内（10k 59.5 vs 60.3fps、50k 60.3 vs 60.1fps，低负载），**没有可测量的抖动代价**。作者明确这是为响应性付的代价；「对超长行降级关闭换行」这条对策**当前不需要**，留作 dPR=2 复测时再看 | M0 ✅ / M1 |
| R10 | East Asian Width 歧义字符定位 | 🟢 低 | `±` `×` 希腊字母列对齐 | 行业公认老问题，CM6/Monaco 单值 `charWidth` 模型均无法解决，接受 | — |
| R11 | 连字导致光标错乱 | 🟢 低 | 开启 ligatures 后光标漂移 | **默认关闭** `font-variant-ligatures`（`setup.ts` 已实现，M0 验证是否真复现） | M0 / M1 |
| R12 | Tauri 3.0 迁移 | 🟢 低 | 未来需跟进 GTK4 等破坏性变更 | 锁 2.11.x；3.0 milestone 仅 29%、无 due date，不急；架构上避免依赖 v1 兼容层 | M6+ |
| R13 | `notify` macOS FSEvents 边界问题 | 🟢 低 | 部分文件变更漏报 | 官方文档提示网络盘/Docker on M1 场景退回 `PollWatcher`；FSEvents 安全模型导致部分文件「无 owner」 | M2 |
| R14 | **字体 family 同名冲突**（M0 新发现） | 🟢 **已根治** | 194 条同名 `@font-face` 互相覆盖，渲染结果不可预期且难排查 | `lxgwwenkaiscreen.css` 与 `lxgwwenkaigbscreen.css` 声明同一个 family 名。✅ **D7 实施后结构性解决**：`src/fonts/loader.ts` 注入时整块替换 `<style>` 节点，任一时刻只可能驻留一个变体，从「靠约定不引错文件」变成「架构上不可能同时驻留」 | M0 ✅ |
| R15 | **前端 bundle 余量仅 5%**（M0 新发现） | 🟡 **重新亮灯**（M3-B-1，2026-09-19；M3-B-3 / M3-B-4 / M3-B-5 / M3-B-6 复核；🟡 **M3-C-1/C-2 把余量从 5.13% 买回到 7.54%**，2026-09-20，⛔ 仍偏紧；**M4-A +0.47KB → 7.39%**，配置层是纯逻辑、没加懒加载边界也没加 CSS，几乎没动预算） | M1 加多标签/文件树/命令面板、M3 加 17 个工具后必然突破 300KB 预算 | ✅ **D7 已实施**：字体 `@font-face` 改运行时按需注入，首屏 gzip **284.4 → 218.5 KB**，余量 5% → **27%**。详见 §2.9。**注意这只是买回了空间，M1/M3 仍需在每阶段末回归测量**<br>🔴 **那句提醒应验了**：M2-H 收尾 14.4% → M3-A 收尾 10.32% → M3-B-1 8.25% → M3-B-2 7.45% → M3-B-3 7.02% → M3-B-4 5.94% → M3-B-5 5.33% → **M3-B-6 只剩 5.13%**（284.61KB / 300KB）→ 🔴 **M3-C-1/C-2 买回到 7.54%**（277.37KB / 300KB，预览链 + 两块浮层 UI 移出首屏；⛔ `doc/stats` 与 `md/paste`+`ipc/asset` 仍在首屏，M3-C-3 未做）。⚠️ **不是依赖吃掉的**——`cmdk-solid` / `@kobalte/core` / `@ark-ui/solid` 三个 UI 依赖一个都没进场，「M3 加 17 个工具」也被改判成 6 个；吃掉余量的是 M3 自己的功能代码。🔴 **解法就是 M3-C 的懒加载**（清单见 §2.9 那一行），而不是上调预算；**M3-C-1/C-2 已交付**——六个 chunk 移出首屏（预览链 `MarkdownPreview`→`md/preview`→`md/render` 那条 41KB 的链 + 工具箱/命令面板两块浮层 UI），首屏净降 **7.24KB**，⛔ **但 M3-C-3 未做**：`doc/stats`、`md/paste`、`ipc/asset` 仍是静态引用留在首屏（paste 被 M3-A-7 修正 8 的同步钩子约束挡住）。详见 §3.5「M3-C 实施修正」1、10。⚠️ **但工具的实现代码懒加载不了**（要在启动时投影成命令），M3-B-2 那 2.40KB、M3-B-3 那 1.28KB、M3-B-4 那 3.25KB、M3-B-5 那 1.82KB 与 M3-B-6 那 0.60KB 都是常驻的，六个工具一共 **9.35KB / 占预算 3.1%**。🔴 **六个都落地了，这一条到此结案**：实测区间是 **0.60–3.25KB / 个**，跨度 5 倍，⛔ 而它**不是一条递减曲线**——最后加的那一个最便宜，因为它纯活最少（没有扫描器、不需要定位、没有选项格、没有 BigInt），不是因为共享层摊薄了。⚠️ 所以「越晚加越便宜」这条读法被 M3-B-6 **证伪**了：正则比命名风格晚一轮却贵三倍。🔴 结论只剩一句：**边际成本 ≈ 那个工具自己的纯活**，框架与共享层从第二个工具起就基本不要钱了 | M0 ✅ |
| R16 | **文楷 Screen 无 Bold 字重**（M0 新发现） | 🟢 低 | Markdown `**加粗**` 只能浏览器合成伪粗，笔画发糊 | 已实测确认 97 个 face 全为 `font-weight: 400`。M3 做 Markdown 时评估观感；不可接受则改用主系列 Light/Regular/Medium（但那三个无屏显优化） | M3 |
| R17 | **`assetsInlineLimit` 击穿字体懒加载**（D7 实施中发现） | 🟡 中 | 小分片被转 base64 data URI，字节随 CSS chunk 强制下载，`unicode-range` 的「不请求」语义失效；且触发条件随字体包版本漂移 | vite 默认阈值 4096 字节，GB 变体实测有 2 个分片中招。✅ 已在 `vite.config.ts` 用函数形式对 `.woff2` 强制 `return false`，两变体 chunk 随即对称。**教训：分片资源架构必须显式关闭内联，不能依赖默认值** | M0 ✅ |

---

## 5. 待决策项

| # | 决策 | 选项 | 建议 | 需何时定 |
|---|---|---|---|---|
| D1 | **字体分发策略** | (a) WOFF2 全量分片懒加载（**实测 4.33MB/变体**，不改名）<br>(b) 精简子集（4–6MB，须改名 "Vela Kai"，生僻字 fallback 系统字体） | **(a)** — M0 实测后优势从「略好」变「明显」：**两者体积已持平**，但 (a) 不改名、覆盖完整、无视觉断层。原先唯一的劣势（67.8KB gzip 的 `@font-face` 占首屏 CSS）**已被 D7 消掉**，现在 (a) 无短板 | **M0 已可定** |
| D2 | **代码区默认字体** | (a) 全程 LXGW WenKai（尊重偏好，接受列对齐漂移；**且 Screen Mono 无 webfont 包，要等宽得自己从 24.44MB TTF 切分**）<br>(b) 代码区 Maple Mono CN + 正文 LXGW WenKai | ✅ **已定 (b) 并实施完成**（用户拍板「按内容分字体」）。#3 的量化结果让 (a) 直接出局：文楷 Screen 的拉丁**根本不是等宽**（ASCII 步进极差 8.63px），连纯英文代码都对不齐，不是「2:1 有细微偏差」。<br>**实现**：`--vela-font-editor`（正文/UI）与 `--vela-font-code`（代码区）两个变量正交，CM6 侧用 ViewPlugin 按语法节点名 `FencedCode`/`CodeBlock`/`Table` 给整行打 `.vela-code` 行装饰（⛔ 不能按 token 走 CSS：`@lezer/markdown` 没有任何 `tags.monospace` 映射）。两套 `@font-face` 各自一个 `<style>` 节点同时驻留。<br>**选包**：`@automann/maple-mono-cn@7.9.2`（精确锁版）。OFL-1.1 且**无 Reserved Font Name** → 分片不触发改名义务，这点与文楷不同。只引 400 一个字重：239 分片 / 9.33MB / CSS 156KB(gzip 55KB)，作为独立 lazy chunk。<br>**代价**：安装包 woff2 从 9.2MB → 18.5MB，见 §2.9。(a) 保留为工具栏一键切换「跟随正文」，切过去 #3 应立刻变红，这本身是分流生效的反向证据 | **已完成** |
| D3 | **会话存储介质** | rusqlite（SQLite）vs sled（嵌入式 KV）vs JSON 文件 | ✅ **已定 JSON 文件并实施完成**，**推翻原建议的 SQLite**。会话是「一份 64 个标签以内的整体快照」，读一次写一次、没有查询也没有单条更新，SQLite 的结构化查询与迁移能力全用不上，却要背 FFI 编译、`bundled` 体积和一层 schema 迁移。sled 同理，且仍在 beta。<br>**实现**：`crates/vela-core/src/session/` 序列化 + `write_bytes_atomic`（与 `fs` 共用同一条临时文件+rename 路径），落点是 Rust 侧从 `app_data_dir()` 算出来的 `session.json`，⛔ **不作为 command 参数**。<br>**重估点**：出现「每窗口独立会话」「具名会话」或「草稿增量写」任一需求时，改成「元信息 JSON + `drafts/<id>` 分文件」，而不是回到 SQLite。详见 §3.3「M1-F 实施修正」1 | **已完成** |
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
| `tauri` | 2.11.5 | Apache-2.0 / MIT | 应用框架 ✅ |
| `tauri-plugin-dialog` | 2.7.3 | Apache-2.0 OR MIT | 原生目录选择框 ✅ |
| `trash` | 5.2.9 | MIT | 移到废纸篓（macOS 走 `objc2`/`cocoa-foundation`）✅ |
| `encoding_rs` | 0.8.41 | (Apache-2.0 OR MIT) AND BSD-3-Clause | 编码探测与 GBK 解码 ✅ |
| `serde` / `serde_json` | 1.0.229 / 1.0.151 | MIT OR Apache-2.0 | 会话存档与线上契约 ✅ |
| `tempfile` | 3.27.0 | MIT OR Apache-2.0 | 原子写入的临时文件 ✅ |
| `memchr` | 2.8.3 | Unlicense OR MIT | 大文件只读分片数 `0x0A` 建行索引 ✅（M2-H）。⚠️ 本来就在 lock 里（`grep-searcher` 的传递依赖），提为直接依赖一个新 crate 都没拉进来 |
| ~~`ropey`~~ | ~~1.6.1~~ | MIT | ⛔ **没用上，不在 `Cargo.lock` 也不在任何 `Cargo.toml` 里**（M2-H 原计划用它持有超大文件全文，改判成稀疏行索引，理由见 §3.4「M2-H 实施修正」1）。⚠️ 这一行从前没有 ⛔ 标记、读起来像个待装的依赖，而 §2.1 与 §2.10 都照它记过账 |
| `notify` | 8.2.0 | CC0-1.0 | 目录监听 ✅（M2-G）。传递依赖 `fsevent-sys` 4.1.0 = MIT、`notify-types` 2.1.0 = MIT OR Apache-2.0；Linux 侧 `inotify` 0.11.5 = ISC、`mio` 1.2.3 = MIT |
| `notify-debouncer-full` | 0.6.0 | **MIT OR Apache-2.0** | 事件抖动合并 ✅（M2-G）。🔴 **原来这一行记的是「版本 —、CC0-1.0」，两处都错**：license 是从 registry 里的 `Cargo.toml` 现读的，`file-id` 0.2.3 同为 MIT OR Apache-2.0 |
| `ignore` | 0.4.33 | Unlicense OR MIT | 搜索侧遍历 + gitignore 过滤 ✅ |
| `grep-searcher` | 0.1.17 | Unlicense OR MIT | 全文搜索（按行扫正文）✅ |
| `grep-regex` | 0.1.14 | Unlicense OR MIT | 搜索正则（编匹配机）✅ |
| `grep-matcher` | 0.1.9 | Unlicense OR MIT | 上面两者的接口 trait ✅ |
| `globset` | 0.4.20 | Unlicense OR MIT | include/exclude 通配 ✅ |
| `grep-cli` | — | Unlicense OR MIT | ⛔ **没用上，不在 `Cargo.lock` 里**（M2-C 原计划列的，实际不需要） |
| `walkdir` | 2.5.0 | Unlicense OR MIT | ⚠️ 在 lock 里，但是 `ignore` 的**传递依赖**，我们没直接用 |
| `tokio` | — | MIT | 异步运行时 |
| `image` | — | MIT OR Apache-2.0 | 图片工具（P1） |
| `sha2` / `md-5` | — | MIT OR Apache-2.0 | 哈希工具 |

> ✅ = 已经进了 `Cargo.toml` 并且落在 `Cargo.lock` 里（版本号取自 lock，不是取自要求）；
> 没有 ✅ 的是计划中的，M2-D 已交付且**一条新依赖都没加**，剩下的要等 M2-E~H 与 M3 才逐个落地。⚠️ `ignore` 走过一个来回，现在**结束了**：
> M2-A 一度引入，因为「树不按 `.gitignore` 过滤」那个决定又摘掉，M2-C 加回到**搜索侧**并留在那里。
> 两边的方向是**刻意相反**的（树按需读一层、过滤省不下钱；搜索要读每个文件的正文、不过滤就等于
> grep 十万个依赖文件），各有一条测试钉住自己的方向——`gitignore_命中的条目照常列出` 与
> `gitignore_命中的文件不搜`。两条方向相反不是写错了，理由见 §3.4「M2-C 实施修正」11。

### 前端包

| 包 | License | 用途 |
|---|---|---|
| `codemirror` / `@codemirror/*` | MIT | 编辑器内核 |
| `@lezer/*` | MIT | 语法解析 |
| `@codemirror/lang-markdown` / `@lezer/markdown` | MIT | Markdown AST |
| `@codemirror/language-data` | MIT | 子语言懒加载 |
| `solid-js` | MIT | 前端框架 |
| ~~`@kobalte/core`~~ | MIT | ⛔ **从未采用**（M3-B-1 结案）：无样式可访问组件，Vela 只用它一个组合框，代价是把整个库拽进首屏 |
| ~~`cmdk-solid`~~ | MIT | ⛔ **从未采用**（M3-B-1d 结案）：命令面板自写，见 §2.4「UI 组件」那一行 |
| ~~`@ark-ui/solid`~~ | MIT | ⛔ **从未采用**（M2-B 结案）：Tree View 自写（`src/project/tree.ts` + `src/ui/virtual.ts`） |

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
