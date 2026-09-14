# M0 验证报告

> **这份报告决定项目是否继续按 Tauri 路线走。**
> 对应 `PLAN.md` §3.2 的八项验收，数据与结论以本报告为准；§3.2 的表格是同一批数据的就地批注版。
> 报告日期：2026-09-14 ｜ 被测产物：`src-tauri/target/release/bundle/macos/Vela.app`（打包后的 `.app`，非 dev 构建；**启动方式是其内层二进制** `Contents/MacOS/vela`，`open` 会卡住，见 §1 / §5）

---

## 0. 结论

**🟢 继续按 Tauri 2 路线走。M0 闸门通过（有条件）。**

八项验收：**5 项通过**（#3 #5 #6 #7 #8）、**1 项机制通过但数值超预算**（#4：首屏字体 **2.219MB** / 预算 2MB，超 11%）、**1 项客观半通过、主观半待人工**（#1）、**1 项完全未测**（#2）。

支撑「继续」这个判断的核心事实有三条：

1. **R1（WKWebView 滚动手感）这个 🔴 高风险没有被证实。** 机器空闲时帧计时贴着 60Hz 垂直同步上限（59.5~60.3fps，卡顿帧 0~2/179，p95 ≤23ms），且**1 万行涨到 5 万行没有可测量的退化** —— CM6 的视口虚拟化在我们的真实文档上成立。
2. **后来观测到的 60→55fps 掉帧不是代码缺陷**，两次归因（冷字体分片、装饰插件每帧重建）都被受控实验推翻，特征符合外部 CPU 抢占。详见 §3。
3. **性能与体积预算四项达标且余量充足**：`.app` 23MB（余量 42%）、冷启动 635ms（余量 36%）、空转内存均值 104MB（余量 46%）；前端 bundle 236.92KB 超出 D7 基线的 18.4KB **全部是 M0 探针脚手架**，收尾即消失。**唯一的硬超标是 #4 的首屏字体字节数 2.219MB（预算 2MB）** —— 根因是分片按码位区块切、一屏汉字散落到 25~36 片上，M1 按字频重排分片即可回到预算内（粗估 1.0~1.2MB），不动摇路线。

「有条件」指的是：**M1 开工前必须补齐三个未闭合项**（§5），其中 #2 中文 IME 是唯一一项**只有人能测**的。#2 若不过，对策是调 CM6 `inputStyle`（`contenteditable` ↔ `textarea`），不动摇 Tauri 路线本身。

**唯一会推翻路线的情形**：人工滚动判定「手感不可接受」，**且** Safari 对照组在同等负载下复现出顺滑差异。这两个条件目前都不成立。

---

## 1. 测量环境与口径

| 项 | 值 |
|---|---|
| 平台 | macOS（darwin 24.6.0）/ arm64 |
| 显示 | 外接 1920×1080 **@60.00Hz**，`devicePixelRatio = 1` |
| 技术栈 | Tauri 2.11.5（锁定，勿升 3.0.0-alpha）+ Solid.js + Vite 8.3.0（rolldown）+ CodeMirror 6 |
| 启动方式 | ⛔ **本行原结论已被推翻（2026-09-14）**。现在**直接跑内层二进制** `…/Vela.app/Contents/MacOS/vela` 才拿得到数据：实测 `visibilityState=visible`、rAF 正常、滚动矩阵能跑完、IPC 落盘正常。反而 **`open "$APP"` 会停在 `page-load Started` 不再前进，前端 IPC 一条都不发**（同一个二进制、同一台机器，见 §5）。原先「裸二进制恒为 hidden」的说法是错的——当时的 hidden 来自**系统休眠**（Jump Desktop 远程会话下本地显示器睡眠），不是启动方式 |
| 保活 | `nohup caffeinate -dimsu -t 1200 &` 独立进程；开跑前用 `pmset -g assertions` 确认 `PreventUserIdleDisplaySleep` 读到 **1** |
| 内存口径 | **`phys_footprint`**（`footprint -p`，即活动监视器「内存」列），**不是** `ps` 的 RSS 求和 |
| 冷启动口径 | **Rust 进程时钟**（`PROCESS_START.elapsed()`），不是 `performance.now()` |
| 数据落盘 | 前端经 `save_probe_slot` 写入仓库根的 `.m0-*.json`；槽位名在 Rust 侧是硬编码白名单，前端只能选槽位、**不能传路径** |

**两条不可用的度量口径**（已确认失效，别再尝试）：
- `performance.getEntriesByType('resource')` 在 `tauri://` 协议下**恒为 0 条 woff2**（release 构建里抓不到任何字体请求）→ 直接导致 #4 降级。
- `performance.memory` 在 WKWebView 里**恒为 undefined** → 前端侧没有 JS 堆读数。

**已知偏差**：本报告全部数据取自 **dPR=1**。图形背板成本随 dPR 平方增长，Retina（dPR=2）下 #1 滚动与 #7 内存都会被**低估**，正式判定需复测。

---

## 2. 逐项验收

| # | 验收项 | 判定 | 关键读数 |
|---|---|---|---|
| 1 | WKWebView 滚动手感 | 🟡 客观半 ✅ / 主观半 ⏳ | 低负载 59.5~60.3fps，p95 ≤23ms，卡顿 0~2/179 |
| 2 | 中文 IME | ⏳ 未测 | 结构性不可自动化，需人工输入 |
| 3 | 字体列对齐 | ✅ 通过 | CJK/ASCII **2.0000**，ASCII 极差 **0.0001px**，50 字漂移 **0px** |
| 4 | 字体分片管线 | ⚠️ 机制 ✅ / **数值 ❌ 超预算 11%** | 首屏实测 **2.219MB**（文楷 25 片 1.136MB + Maple 36 片 1.082MB）/ 预算 2MB |
| 5 | 生产构建 | ✅ 通过 | CM6 在 release 构建下完全正常 |
| 6 | 冷启动 | ✅ 通过 | **635ms**（预算 1000ms，余量 36%） |
| 7 | 空转内存 | ✅ 通过 | 均值 **104MB** / 峰值 109MB（预算 200MB，余量 46%） |
| 8 | 字体字重核实 | ✅ 结项 | Screen 版**只有 400，无 Bold** |

### #1 WKWebView 滚动手感 —— 🟡 客观半通过

**判据**：万行文件滚动无肉眼卡顿，主观手感可接受。
**为什么 60fps 是上限而不是巧合**：外接屏 @60.00Hz，垂直同步上限就是 60fps。

**低负载读数（run1/run2，06:00–06:01，机器空闲）** —— 这是本项的**有效判据数据**：

| 档 | 手感档（3000px/s ≈ 214 行/s） | p95 | 卡顿帧 |
|---|---|---|---|
| 10k 行 · 换行开 | **59.5 fps** | 21ms | 2/179 |
| 10k 行 · 换行关 | **60.3 fps** | 23ms | **0** |
| 50k 行 · 换行开 | **60.3 fps** | 19ms | **0** |
| 50k 行 · 换行关 | **60.1 fps** | 23ms | **0** |

p95 全部 ≤23ms（预算 33ms）。**1 万行 → 5 万行没有可测量的退化**，CM6 视口虚拟化成立。

压力档（全范围三角波，7.4万~63万 px/s）：10k 56.2/59.1fps、50k 48.3/44.3fps。⛔ 压力档跑不满 60fps 是上界测试的正常结果，**不能读成日常卡顿**。

**未闭合**：
- 主观「手感」仍需人滚一次 30s。两档都是**合成滚动**（程序化写 `scrollTop`），绕开了触控板惯性经 WKWebView 原生手势的那一段，而 `tauri-apps/discussions#8436` 报告的微延迟恰好在**那条路径**上。
- 安静机器（`load < 1`）复跑同一个构建，确认回到 ~60fps。
- dPR=2（Retina）复测；20k 档未单列（被 10k/50k 夹逼）。

📌 原计划的 **Safari 对照组不必做了**：低负载读数已贴在 60Hz 上限，没有「Tauri 比 Safari 差」的差值需要解释。
📌 矩阵**自检有效**：瞬时遮挡 / rAF 节流会被自动标 `aborted` 并排除，未污染结论（三次连跑里作废 1 档）。

### #2 中文 IME —— ⏳ 未测（唯一需要人的一项）

**判据**：输入无行跳动、候选框不错位、长句连续输入不丢字。

**为什么这一项结构性不可自动化**（不是偷懒，是路径问题）：
- 程序化插入文本会**绕过 `compositionstart/update/end`** —— 而那三个事件正是被测路径本身。
- 合成键盘事件（`KeyboardEvent`）**驱动不了 IME 候选窗**，候选窗由系统输入法进程绘制，不在 WebView 的事件模型里。

**已备好的工具**：探针面板里有**原生 `<textarea>` 对照组**。人工测的时候两边都打一遍，用来区分「是 CM6 的问题」还是「是 WKWebView 的问题」—— 这个区分直接决定对策。

**不过时的对策**：调整 CM6 `inputStyle`（`contenteditable` vs `textarea`）；参考 Monaco #4592 的教训。

**预估成本**：约 2 分钟中文输入。

### #3 字体列对齐 —— ✅ 通过（D2「按内容分字体」实施后）

**判据**：中英文表格 / ASCII art 对齐正确。

**判定对象是 CM6 里真实的 `.vela-code` 代码行**，不是测试台 div。这一点很关键：它是「语法节点 → 行装饰 → CSS → 解析字体 → 字形度量」整条链的**终点**，只有量到它才证明装饰真的把字体换掉了。

**Maple Mono CN @14px 实测**：

| 指标 | 实测 | 判据 |
|---|---|---|
| ASCII 步进 | 8.4 px | — |
| CJK 步进 | 16.8 px | — |
| 框线 `│` 步进 | 8.4 px | — |
| **CJK / ASCII** | **2.0000** | 2.0 |
| **框线 / ASCII** | **1.0000** | 1.0 |
| ASCII 逐字符极差 | **0.0001 px**（`i`/`l`/`W`/`m`/`.`/`@` 全部 8.4~8.4001） | 越小越好 |
| 50 个中文字累积漂移 | **0 px** | 0 |
| 标志位 | `mono=true` `aligned=true` `cjkFaceLoaded=true` | 全 true |

**链的另一端同时成立**：同一个 `contentDOM` 量出来的**正文仍是 LXGW WenKai Screen**（ASCII 极差 8.6339px、CJK/ASCII = 1.66639）。代码行是正文元素的**子孙节点**却报出另一个 family —— 这就是分字体生效的直接证据。

**量具自检**：系统等宽对照组（`ui-monospace`）ASCII 极差 0.0002px、`mono=true` → 量具可信。

📌 **对照组顺带推翻了一个备选方案**：`ui-monospace` 的 CJK/ASCII = **1.55079**，不是 2.0 —— SF Mono 没有中文字形，`中` 落到了 PingFang 上。所以「代码区退回系统等宽字体」**从来就不是** #3 的可行补救；而且对照组只能验 `mono`、**验不了 `aligned`**。

**三轮独立复现**（run3 / run4 / visible 复测）数值逐位相同。

✅ **`visible` 下的复测已补，#3 闭合**（`.m0-align.json`，`measuredAt = 2026-09-14T01:34:16.800Z`，`visibility = visible`，dPR=1）：
- `codeTarget` = **「CM6 里真实的 `.vela-code` 代码行」**，`codeFontStack` = `'Maple Mono CN', ui-monospace, monospace`
- 代码行：ASCII 步进 **8.4px**、CJK **16.8px**、框线 `│` **8.4px** → `cjkOverAscii = 2.000`、`boxOverAscii = 1.000`、ASCII 极差 **0.0001px**、50 字累积漂移 **0px**、`mono = true`、`aligned = true`、`fontsReady = true`、`cjkFaceLoaded = true`
- 同一次测量的正文（`contentDOM`）仍是 LXGW WenKai Screen：ASCII 极差 **8.6339px**、`cjkOverAscii = 1.66639`、`mono = false` → **分字体在同一次采样里两端都成立**
- 量具自检：系统等宽对照组 `mono = true`（`aligned = false`、`cjkOverAscii = 1.55079`，与前述「对照组验不了 aligned」一致）

⚠️ 此前 run3 / run4 两轮都记到 `visibility = hidden`（矩阵结束后的补测被收尾的 `pkill` 追上），按方法论第 2 条欠一次可见态复测；现已补齐。字形 advance width 与页面可见性无关，三轮读数一致 → 判定不受可见性影响。

#### 改造前的 ❌ 原始证据（保留，说明为什么必须分字体）

LXGW WenKai Screen @14px，`visibility = visible` 下，代码区（CM6 `contentDOM`）与测试台 div 读数完全一致：

| 字符 | `0` | `i` | `l` | `W` | `m` | `.` | `@` |
|---|---|---|---|---|---|---|---|
| 步进 px | 8.4013 | 3.6846 | 3.6845 | 12.3184 | 11.4229 | 4.9013 | 10.9785 |

**极差 8.6339px** → 拉丁是**比例宽度，根本不等宽**；CJK 步进 14.0px（=1em），CJK/ASCII = 1.66639（须 2.0000）；框线 `│` 也是 14px，框线/ASCII = 1.66639（须 1.0000）；50 个中文字累积漂移 **140.14px**。

⛔ **性质比原判据严重**：不是「2:1 有细微偏差」，而是**拉丁非等宽** —— 连纯英文代码的列都对不齐。文楷 Screen **只能用于 UI 与 Markdown 正文**。

⚠️ 分片来自 npm 包 `lxgw-wenkai-screen-webfont@1.7.0`（chawyehsu 维护），我们的管线只做 CSS 注入、**没碰字形度量**，所以这是字体本身的属性而非构建 bug。原始读数存档 `.m0-align-lxgw.json`。
⛔ 顺带推翻一条旧认知：先前记录的「文楷 Screen 拉丁基于 Inconsolata、是等宽的」与实测冲突，**以实测为准**。

#### 备选方案的排除过程

| 方案 | 状态 | 原因 |
|---|---|---|
| 用文楷 Mono 变体保留观感 | ⛔ 走不通 | npm 上 `lxgw-wenkai-mono-webfont`、`@fontsource/lxgw-wenkai-mono`、`lxgw-wenkai-mono-web` **全部 404**；自建分片管线则按 OFL FAQ 2.6 触发 RFN 改名义务 |
| 退回系统等宽 | ⛔ 走不通 | 实测 CJK/ASCII = 1.55079，中文表格照样对不齐 |
| **Maple Mono CN** | ✅ **已采用** | 官方声明 2:1，实测 2.0000；OFL-1.1 且**无 Reserved Font Name**，分片分发不触发改名义务 |

📌 **一度怀疑的代价已排除**：同期滚动帧率从 ~60fps 掉到 ~55fps，最初归因于这次分字体改造。噪声带（带宽 3.9fps）证明：关掉 Maple 的差值是 0.55fps、摘掉装饰插件的差值**方向还是反的**，两者都淹没在噪声里 → **分字体没有可测量的帧率成本**。详见 §3。

#### 实现约束（M1 会再碰到）

`@lezer/markdown` **没有 `tags.monospace` 映射** → 按 token 用 CSS 分字体这条路不存在。实现只能用 **ViewPlugin + `Decoration.line`**，匹配节点名 `FencedCode` / `CodeBlock` / `Table`（`src/editor/setup.ts`）。
`u.viewportChanged` **滚动时每帧都触发**，所以装饰范围必须向视口外扩 `DECO_MARGIN_PX = 2000`，否则每帧重走一遍语法树重建整个 DecorationSet。
⚠️ **但这个节流不是 #1 那次退化的修复** —— 它把重建从每帧 ~180 次削到每档 ~5 次（一个数量级），帧率**一位小数都没动**。余量本身仍该留：每帧重建一份用完就扔的 DecorationSet 是纯浪费。

### #4 字体分片管线 —— ⚠️ 机制 ✅ / **数值 ❌ 超预算 11%**

**判据**：首屏实际加载 < 2MB；随机生僻字能正确触发分片加载。

**口径已换掉**：`performance.getEntriesByType('resource')` 在 `tauri://` 协议下抓不到任何 `.woff2`（release 构建里恒为 0 条），**原先打的 ✅ 是在 dev 模式下测的，不可比**。现在改为构建期用 `scripts/font-manifest.mjs` 生成「family + 归一化 unicode-range → 真实文件字节数」清单（**433 片 / 18.07MB**），运行时拿 `document.fonts` 里 `status=loaded` 的 face 查表求和。原估的 **≈1.40MB ±50% 作废**。

**实测**（2026-09-14 09:33，release 构建，窗口 `visible`，dPR=1，wrap 开，**全部样本 `trustworthy=true`**：`rangeUnmatched=0`、`indexDisagreements=0`）：

| 状态 | 已加载 face | 文楷 Screen | Maple Mono CN | 合计 |
|---|---|---|---|---|
| 字体刚注册、尚无任何字形需求 | 0 / 336 | 0 | 0 | **0 MB** |
| 空文档 + 界面中文 | 11~23 / 336 | 11~23 片 / 0.49~1.07MB | 0 | **0.49~1.07 MB** |
| **1 万行常用字混排（判预算用这份）** | 61 / 336 | 25 片 / 1.136MB | 36 片 / 1.082MB | **2.219 MB** |
| 同上 + 30 个跨区块生僻字（机制压力样本） | 66 / 336 | 30 片 / 1.364MB | 36 片 / 1.082MB | **2.446 MB** |
| 滚完 5 万行全篇（饱和上界） | 70 / 336 | 34 片 / 1.520MB | 36 片 / 1.082MB | **2.603 MB** |

**机制侧 ✅**：0 片 → 灌文档后按需增长 → 收敛。收敛不是猜的：每 3s 复测一次，`captureShards` 对完全相同的样本会去重，**+6s / +9s 两次复测在日志里没有产生新的落盘**，那个「缺失」就是平台期证据。生僻字确实各自拉来新分片（文楷 +5 片 / +227KB）。

**数值侧 ❌**：代表性文档 **2.219MB，超预算 11%**；压力文档 2.446MB，超 22%。

**钱花在哪（关键：不是文档正文）**：
- **Maple 那 1.082MB 占了首屏的一半**，来自 `CODE_BLOCK_NODES` 里的 `Table` —— 中文表格按设计走等宽字体（这是 #3 列对齐成立的前提），fixture 的表格行全是中文。空文档时 Maple 是 **0 片**，所以这 36 片完全由文档里的代码块与表格触发。**这是预期行为，不是 bug。**
- 文楷侧 1.136MB 里，**界面自己的中文（工具栏 + 探针面板）就占掉 11~23 片**；文档正文只在此之上加了十几片。
- 结构性根因：分片是**按码位区块**切的（清单里能看到 `U+760F-76FB` 这类连续区间），一屏里几百个不同汉字会散落到 25~36 个分片上，每片平均 31~46KB，**命中即整片下载**。

⚠️ **face 计数不是单调递增的，别把样本序列当增长曲线读**：实测重建编辑器后已加载 face 从 23 掉回 12 —— WebKit 会释放不再被引用的字体数据。所以「空文档 + 界面中文」那一行只能给区间，给不出精确的 UI 成本。

**M1 的修法：按字频重排分片。** 把最常用的 ~3500 字集中到头 1~2 片，其余照旧按码位切。典型首屏就从「命中 25~36 片」变成「命中 1 片常用字 + 1 片 ASCII」。粗估文楷侧 1.136MB → ~0.55MB（3500/27000 × 4.33MB），Maple 侧同比例，**首屏有望落到 1.0~1.2MB，回到预算内**。

⛔ **不要为了达标去换精简子集方案** —— 那会触发 OFL 的 Reserved Font Name 改名义务（霞鹜 / 霞鶩 / 落霞孤鹜 / 落霞孤鶩 / LXGW），代价远大于重排分片。Maple Mono CN 无 RFN，不受此限。

⚠️ 附带发现 67.8KB gzip 的 `@font-face` CSS 开销 → 已转 R15，并由 D7（运行时按需注入）解决：首屏 CSS 从 **67.8KB 砍到 1.28KB**。

✅ **dPR 不影响这一项**：分片命中只取决于**出现了哪些码点**，与栅格化倍率无关，所以 #4 不需要 Retina 复测（#1 / #7 需要）。

### #5 生产构建 —— ✅ 通过，且这一项救了一次

**判据**：`vite build` 后 CM6 完全正常（不是只在 dev 正常）。

构建确实踩中三个坑：**rolldown 的 `manualChunks` 形式**、**esbuild 不再内置**、**粗分包摧毁懒加载**。首屏 gzip 一度冲到 **623KB**，修复后 **284.4KB / 114 chunk**（当前 236.92KB / 117 chunk）。详见 `PLAN.md` §2.3。

**为什么这一项值钱**：社区有已知的「Tauri + Vite + CM6: Works in Dev, Breaks in Production Build」陷阱。如果 M0 没跑生产构建，这个坑会在 M1 中期才暴露，那时已经有大量业务代码绑在错误的分包配置上。

### #6 冷启动 —— ✅ 通过：635ms

**判据**：空窗口到可输入 < 1s。**实测 635ms，余量 36%。**

**口径是端到端的 Rust 进程启动 → 编辑器可输入**，由 `probe_ready` 命令返回 `PROCESS_START.elapsed()`。

⚠️ **必须用进程时钟**：`performance.now()` 的原点是**页面导航开始**，不含进程拉起与 WKWebView 创建。只用前端时钟会**系统性低估**冷启动，可能把不达标的读数读成达标。差值已单列在探针面板「进程拉起 + WKWebView 创建」一行。

实现细节：`mount()` 里首次挂载完成才记 `editorReadyMs`，并**同步发起、不 await** `collectProcessUptime()` —— 多等一拍就会把后续渲染算进冷启动。

### #7 空转内存 —— ✅ 通过：均值 104MB / 峰值 109MB

**判据**：< 200MB。**余量 46%。**

13 个样本全部 `visibility=visible` 且 `hasFocus=false`（在渲染、无人操作），其中 5 个是间隔 15s 的干净空转点：

| 进程 | footprint |
|---|---|
| **合计** | 97 / **104** / 109 / 104 / 106 MB |
| vela（主） | 21~22 MB（全程不动） |
| GPU | 17~24 MB |
| WebContent | 54~61 MB |
| Networking | 5 MB |

冷启动 17s 的首个点 114MB 也在预算内。

⚠️ **口径必须用 `phys_footprint`**，不能用 `ps` 的 RSS 求和 —— vela 与 3 个 WebKit XPC 进程共享 WebKit.framework / AppKit 页，RSS 会重复计数（实测主进程 RSS 87MB 而 footprint 仅 24MB，**差 3.6 倍**）。WebKit 的 XPC 子进程 PPID=1，不能靠进程树找，要按名字找。

⛔ 早先单点读到的 **209MB 是启动初期瞬态**，干净一轮里没有复现，不能作为判定依据。
⛔ `.m0-mem-ab.log` 里 **B 段和 C 段的结论都已撤回**（漏记窗口可见性导致的错误归因），只有 D 段是干净数据。

📌 **新发现（转 M1）**：灌过 1 万行文档后即使回落到空文档，WebContent 停在 113MB、比空转基线高 **~59MB 且不回落**（同期 Rust RSS 反而从 146MB 降到 63MB）。性质是 **WebKit 侧的驻留字形/图层缓存，不是 CM6 泄漏**；但「反复开关大文件是否阶梯式上涨」「内存压力下是否被回收」未验证 → **M1 需补一条长会话内存曲线**。

📌 **字体归因已结案（数值已按 #4 的实测字节口径修正）**：早先记的「30/97 → 33/97，估算 ≈140KB」是 face 计数 × 平均体积的粗估，已被 #4 的清单查表口径取代。真实差值：空文档 + 界面中文 **11~23 片 / 0.49~1.07MB** → 1 万行常用字混排 **61 片 / 2.219MB**，即文档本身多拉 **~1.2~1.7MB** 字体数据，**解释不了 ~59MB 的不回落驻留**。mixed 与 ascii 的内存差也确实落在 ±16MB 噪声带内、方向还会反转 → **字体分片管线不是内存问题的主因，此路不必再查**。⚠️ woff2 字节 ≠ 解码后的字形位图占用（后者会放大且未单独验证），但即便放大 10 倍也只到 ~17MB，量级判断成立。

⚠️ 未闭合：本轮 dPR=1，**Retina 屏上可见态开销会被低估**，正式判定要在 dPR=2 下复测。

**参照**：Tauri 基准 ~172MB（⚠️ 该基准的度量口径不明，不能直接对齐）、Electron ~409MB。

### #8 字体字重核实 —— ✅ 已结项

**判据**：确认 Screen 版实际提供几档字重（两次抓取结论冲突）。
**实测：97 个 face 全部 `font-weight: 400`，只有 400，无 Bold。** → 转为 R16。

**影响**：粗体需浏览器合成（faux bold）或改用主系列 LXGW WenKai。这是 M4 字体管线产品化必须处理的约束，不是 M0 的阻塞项。

---

## 3. 两次撤回的归因（比数据更该记住的部分）

06:25 起连续四轮读数全部掉到 53~57fps（相对 run1/run2 的 59.5~60.3）。我先后给出两个解释，**两个都错**。

| 假设 | 受控实验 | 结果 |
|---|---|---|
| Maple 的 239 个冷分片在滚动时抢主线程 | 关掉 Maple（`DEFAULT_CODE_FONT = inherit`，插件照跑） | **55.15fps** vs 开着 Maple 的 55.70 → 差 **0.55** |
| ViewPlugin 每帧重走语法树、重建 DecorationSet | 把重建从每帧 ~180 次节流到每档 ~5 次（削掉一个数量级） | **55.6/55.2/55.8/54.1** vs 节流前 **55.7/54.5/56.1/55.3** → **一位小数都没差** |
| （终极对照）插件本身 | 把插件整个摘掉，Maple 仍注入 | 10k 换行开 **55.70fps**，而同一档**装着插件**是 57.09 / 54.36 → **方向是反的** |

**噪声带**（同一个构建连跑三次，06:54–06:58，11 个有效样本）：**53.16 ~ 57.09fps，均值 55.11，带宽 3.9fps**；卡顿帧 4~16；p95 28~48ms；单帧最低 **12.5fps**。

三个差值（≈0、−1.4、+0.55）**全部远小于 3.9fps 的带宽** → 按方法论第 4/7 条**不能报为结论**。

**形状判据（这条比均值更能定性）**：如果真是「每帧多算了一点东西」，均值会下移但分布仍然**紧贴 vsync**；实测是均值下移**并且**冒出 12.5fps 的离群帧、卡顿从 0~2 涨到 4~16 —— 这是**被外部抢占**的形状，不是稳态计算量上升的形状。

**同期机器负载**：`load averages 3.82 / 4.00 / 4.39`；WindowServer **14% CPU**（它就是逐帧合成的那一方）、一个 VM 9.1%、Qoder 10.0%、Codex Renderer 7.4%、kernel_task 5.7%。

**结论**：60→55fps 这个差值**不能归因于分字体改造**，两个被怀疑的组件各自单独移除都是零效果；最可能是机器负载，但这是**强旁证而非直接证明** —— 我无法重建 run2 那一版代码，也无法让这台机器安静下来（那是用户的 VM 和开发工具，不能杀）。

**⚠️ 在安静机器复跑之前，不能把 `FPS_BUDGET=55` 的「超标」当成真实缺陷。** noise-3 的 50k 换行关 53.16fps 就低于 55，而那不是代码问题。

**这次错误归因的代价**：基于它写了一整段节流代码（`DECO_MARGIN_PX`），重新构建重跑后帧率一位小数都没动。节流本身仍值得保留（避免每帧白建一份 DecorationSet），但它**不是修复**，代码注释与 PLAN.md 里原先「成本确定在这里」的说法都已改正。

**根因是我的 A/B 没钉死变量**：那一轮之间其实改了**四个**文件（`setup.ts` / `loader.ts` / `ProbePanel.tsx` / `App.tsx`），我只翻了 `loader.ts` 里的一个常量，另外三个在两条腿里都在，于是被无声地算进了「插件的成本」。

---

## 4. 构建产物与预算

| 指标 | 预算 | M0 实测 | 余量 |
|---|---|---|---|
| 安装包体积（`.app`） | ≤ 40MB | ✅ **23MB** | 42% |
| 冷启动到可输入 | < 1s | ✅ **635ms** | 36% |
| 空转常驻内存 | < 200MB | ✅ **104MB 均值 / 109MB 峰值** | 46% |
| 前端 bundle（gzip） | ≤ 300KB | ⚠️ **236.92KB** | 21% |
| 按键到屏幕延迟 | < 16ms | 主线程事务派发 avg < 1ms（不含系统事件投递，仅作回归基线） | — |
| 打开 10 万行文件 | < 2s，滚动 60fps | 滚动已测（5 万行手感档 60fps）；**10 万行未测** | — |

**`.app` 23MB 的构成**：Tauri 空壳 8.6MB + 字体分片 **18.07MB**（文楷 GB 4.33 + 文楷 R 4.87 + Maple 8.87）+ 前端 ~2MB + Rust 二进制 ~8MB。D2 分字体前是 14MB，Maple 的 239 个分片带来 +8.87MB。

**首屏 gzip 236.92KB 的构成**：

| 文件 | min | gzip |
|---|---|---|
| `index-*.js`（入口：Solid + 应用 + CM6 基础扩展 + **M0 探针**） | 347.59K | **127.14 KB** |
| `dist-*.js`（CM6 内核，modulepreload） | 335.25K | **108.50 KB** |
| `index-*.css`（应用自身样式，字体声明已移出） | 4.05K | **1.28 KB** |
| **首屏合计** | | **236.92 KB** |

**懒加载 chunk（不进首屏）**：`regular-*.js`（Maple 的 CSS）155.91K / 55.36KB、`lxgwwenkaigbscreen-*.js` 92.73K / 33.36KB、`lxgwwenkaiscreenr-*.js` 92.83K / 33.36KB，共 **117 个 chunk**。

**woff2 共 433 片 / 18.07MB**：文楷 GB 97 片（4.33MB）+ 文楷 R 97 片（4.87MB）+ Maple 239 片（8.87MB，hash 命名）。`dist/` 总计 26MB。

> **首屏比 D7 基线（218.5KB）多的 18.4KB 全部是 M0 探针脚手架**：`src/probe/sweep.ts`(17.5KB) 与 `ProbePanel.tsx`(46.9KB) 都是静态 import，被压进入口 chunk。M0 收尾整体删除后回落到 218KB 一线。
> **别把这 18.4KB 记成 D2 分字体的代价** —— Maple 的 CSS 走 `?inline` 动态 import，独立成 `regular-*.js`，首屏一个字节都没碰。

---

## 5. 未闭合项清单

| # | 待补 | 谁能做 | 阻塞 M1？ |
|---|---|---|---|
| #2 | **中文 IME 人工判定**：在真实窗口里用中文输入法打一段长句，编辑器与原生 textarea 对照组各打一遍 | **只有用户**（结构性不可自动化） | **是** —— 不过则要改 `inputStyle` |
| #1 | **人工滚动手感**：5 万行文档连续滚 30s，判断有无肉眼卡顿 | **只有用户**（合成滚动绕开了原生手势路径） | 否（客观半已通过） |
| #1 | **安静机器复跑**：`load < 1` 时跑同一个构建，确认回到 ~60fps | 需机器空闲（我不能杀用户的 VM / Qoder / Codex） | 否 |
| #1 #7 | **dPR=2（Retina）复测**：滚动帧率与可见态内存 | 需接 Retina 屏 | 否，但正式发布前必须 |
| #4 | ✅ **已补齐**：清单查表口径落地（433 片 / 18.07MB），首屏实测 **2.219MB**，全部样本 `trustworthy` | 已完成 | —— |
| #4 | **首屏字体超预算 11%**：按字频重排分片，把常用 ~3500 字集中到头 1~2 片（粗估可降到 1.0~1.2MB）。⛔ 不要改用精简子集，那会触发 OFL 改名义务 | 我可做，转 M1 | 否，但正式发布前必须 |
| 启动 | ⛔ **`open` / LaunchServices 路径卡死**：同一个 `.app`，直接跑内层二进制一切正常，`open` 停在 `page-load Started` 不再前进、前端 IPC 一条不发。已排除：report_path、命令注册、旧 bundle、开关文件位置、`panelOpen`、`autotest` prop、hidden 页面字体加载、osascript 窗口读数、系统休眠（caffeinate 生效、assertions=1）、bundle 签名（现在 `valid on disk` / `satisfies its Designated Requirement` / `Identifier=app.vela.m0`）、hardened runtime、`com.apple.provenance` xattr、重复注册、translocation。`spctl -a -t exec` 仍报 `rejected`（ad-hoc、无 Developer ID、未公证） | **需用户决定**是否上真 Developer ID 签名 + 公证 | **是** —— Finder / Dock 双击才是用户的真实路径 |
| #3 | ✅ **已闭合**：2026-09-14 09:34 在 `visible` 下复测，`codeTarget` = 「CM6 里真实的 `.vela-code` 代码行」，`cjkOverAscii` = **2.000**、`mono=true`、`aligned=true`；对照组 `mono=true`（量具自检通过） | 已完成 | —— |
| #7 | **长会话内存曲线**：反复开关大文件是否阶梯式上涨、内存压力下是否回收 | 我可做 | 转 M1 |

---

## 6. M0 收尾要删 / 要留

M0 的探针是为了测量而生的脚手架，收尾时必须清理 —— 但**清理清单要分清「脚手架」和「产品代码」**，这次差点误删后者。

**⛔ 不能删（D2 分字体的产品代码 + 正确的构建配置）**：
- `src/fonts/loader.ts` 里的代码区字体机制（`CodeFontId` / `applyCodeFont` / `DEFAULT_CODE_FONT`）
- `src/editor/setup.ts` 的 `codeFontBySyntax` ViewPlugin 与 `DECO_MARGIN_PX`
- 依赖 `@automann/maple-mono-cn`
- `tauri.conf.json` 的 `focus: true` 与 `bundle.active: true`（**这两条是正确的产品行为**）
- `tauri.conf.json` 的 `bundle.macOS.signingIdentity`（当前是 ad-hoc 的 `"-"`；正式发布要换成真的 Developer ID，但**不能删回默认**——默认产物 bundle 不签名，`codesign --verify` 必报红，见 §7 第 9 条）

**要删（纯脚手架）**：
- `src/probe/` 整个目录（`sweep.ts` / `ProbePanel.tsx` / `metrics.ts` / `fixtures.ts`）
- Rust 侧 `save_probe_slot` / `autotest_enabled` / `probe_memory` / `probe_ready` / `PROBE_SLOTS`
- **补齐 #4 那一轮新增的**：Rust 侧 `load_probe_slot` / `PROBE_INPUT_SLOTS` / `diag_log`（及所有调用点）/ `.on_page_load` / `boot` 槽位，以及 `read_text_file`（任意路径读写原语，本来就该删）
- **前端同期新增的**：`ProbePanel.tsx` 里的 `nextPaint` / `waitFontsInjected` / `runMatrix` 开头的首屏字体采样块 / 样本的 `lineWrap` 字段；`App.tsx` 与 `sweep.ts` 里的 `mixed-10k-common` DocKind；`index.html` 的内联探针；`src/index.tsx` 的 beats；`src/global.d.ts` 的 `__velaBoot`
- **分片字节清单**：`scripts/font-manifest.mjs`、`.m0-font-manifest.json`、`.m0-manifest-check.mjs`。⚠️ 它**只是测量工具，不是产品管线**——运行时注入 `@font-face` 的是 `loader.ts`，它不需要知道每片多少字节
- `.setup()` 里的 `set_always_on_top` + `set_focus`（带 `TODO(M0-自动扫描)` 标记）
- `App.tsx` 里的探针接线
- 仓库根所有 `.m0-*`（含开关文件 `.m0-autotest`——已于 2026-09-14 删除，它常开会让每次启动被矩阵独占 40 秒；要重跑测量就 `touch` 回来），`.gitignore` 已统一忽略该前缀
- 两个未纳管的散落文件：`..m0-shot.png-TVuZ`（4.3MB 截图）、`.build-log.txt`

⚠️ **`sweep.ts` 要留到 dPR=2 复测做完再删** —— 它是 #1/#7 复测的工具，删了就得重写。
⚠️ 删完要**重新量一次首屏体积**，确认从 236.92KB 回落到 ~218KB。

---

## 7. 方法论沉淀

十四条踩出来的教训已就地写在 `PLAN.md` §3.2「测量方法论」，比本报告的任何数据都更值钱（第 9~14 条是补齐 #4 字节口径这一轮新踩的）。摘要：

1. ⛔ **「必须打包成 `.app` 再用 `open` 启动」这条已被推翻** —— 实测**直接跑内层二进制**才拿得到数据（`visible`、rAF 正常、矩阵跑完），`open` 反而卡在 `page-load Started`。旧结论里的 `hidden` 真凶是**系统休眠**，不是启动方式。教训本身比结论更值钱：**把「环境状态」误当成「启动方式」的因果，会让人在错误的变量上反复实验。**
2. **每个样本都要记 `visibilityState` 和 `hasFocus`** —— 漏记这个字段让本项目白跑两轮并得出一个完全错误的归因。
3. **扫描时钟只累计「可见时间」** —— 产出的样本天然干净，不用事后剔除。
4. **`footprint` 绝不能高频循环** —— 它遍历 VM region，每 4s 扫 4 个进程曾把机器推进交换态、连 shell 都超时。改成阶段切换触发（~1 次/15s）。
5. **外部快照与被测阶段之间有竞态** —— footprint 脚本靠轮询报告文件感知阶段，最多滞后 2s，紧跟文档切换的快照必须丢弃。
6. **A/B 之前先枚举两个基线之间所有变过的文件**，不是只翻你怀疑的那一个。配套判据：**如果某个修复把开销削掉一个数量级而指标完全没动，那不是「修复不够」，是「这个开销从来就不是成本」**。
7. **绝对帧率跨时间窗不可比，先量噪声带再谈效应** —— 同一构建连跑三次量出带宽，效应小于带宽就不能报为结论；**分布形状比均值更能定性**（离群帧 + 尾部加宽 = 外部抢占；均值下移 + 分布仍紧贴 vsync = 稳态计算量上升）。
8. **保活断言会静默失效，必须独立验证** —— `caffeinate -w "$PID"` 抓错 PID 时不报错也不生效，显示器休眠 → rAF 冻结 → 矩阵卡死，而脚本不会告诉你数据废了。**靠运气对的不算对。**
9. **Tauri 默认不给 bundle 签名** —— 只有链接器级的 `adhoc,linker-signed`，`Info.plist=not bound`、没有 `_CodeSignature/CodeResources`，于是 `codesign --verify` 报 "code has no resources but signature indicates they must be present"。加 `bundle.macOS.signingIdentity = "-"` 才会同时签二进制与 bundle（并带上 hardened runtime 标志）。
10. **交叉校验的下标口径必须和被校验的集合一致** —— 「按 family 内出现顺序对齐清单」这条校验，下标原本只数 `status=loaded` 的 face，而清单里是整个 family 的 97/239 片，于是 70 个 face 报出 **67 个假分歧**，差点让我把一条正确的字节口径判成作废。**自检报红时先怀疑自检。**
11. **对抗性 fixture 不能用来判预算** —— `mixed-10k` 刻意塞了 30 个跨区块生僻字（一字一分片）来压懒加载，拿它判 2MB 必然超标。判预算要另备一份关掉 `rareHan` 的代表性文档；两份之差正好是生僻字的代价。
12. **已加载 face 数不是单调的** —— 重建编辑器后 WebKit 会释放不再被引用的字体数据（实测 23 → 12）。样本序列不能当增长曲线读。
13. **`document.fonts.ready` 会在加载波次之间提前 settle** —— 41ms 内连取两份是 0.53MB → 2.16MB。判「已收敛」要靠**静置复测 + 去重**：相同样本不落盘，日志里那次**缺失**才是平台期证据。
14. **`createEffect` 里同步调用会读信号的异步函数 = 自我触发循环** —— `runAlign` 第一行读 `alignBusy()`，effect 于是把它当依赖，而 `runAlign` 自己又写它。实测 **~230 次/秒、90 秒落盘 20776 次**。修法是 `untrack(...)`。这类循环之前一直被「矩阵挂起标志」和「hidden 页面」掩盖着，环境一干净就暴露。

---

## 8. 数据存档

原始读数落在仓库根（`.gitignore` 已统一忽略 `.m0-*` 前缀，共 **44 个文件**，含采样脚本与构建日志）。下表是**各项判定所依据的关键几份**：

| 文件 | 内容 |
|---|---|
| `.m0-scroll-run1.json` / `-run2.json` | **低负载有效基线**（59.5~60.3fps） |
| `.m0-scroll-run3-split.json` + `.m0-align-maple.json` | D2 后首轮：#3 首次量化通过 |
| `.m0-scroll-run4-throttle.json` + `.m0-align-run4.json` | 节流后：#3 二轮复现 |
| `.m0-scroll-ab-inherit.json` | 关掉 Maple 的对照腿 |
| `.m0-scroll-ab-nodeco.json` + `.m0-align-ab-nodeco.json` | 摘掉插件的对照腿（1 个有效样本 55.70fps） |
| `.m0-noise-1/2/3.json` | 噪声带三连跑 |
| `.m0-align-lxgw.json` | **改造前文楷的 ❌ 原始证据** |
| `.m0-shards-firstscreen-final.json` | **#4 判定的依据**：一次启动里的 10 个样本，含空文档 0 片、`mixed-10k-common` 收敛值 **2.219MB**、`mixed-10k`（含生僻字）2.446MB、滚完 5 万行饱和 2.603MB |
| `.m0-shards-run-fs2.json` / `-fs3.json` | 收敛过程的中间轮次：单份读数 → 3s 静置复测 → 三次静置复测 |
| `.m0-shards-emptydoc.json` | 空文档基线（`registeredFaces=336`、`loadedFaces=0`，证明懒加载不是空话） |
| `.m0-shards-postsroll.json` | 交叉校验修好后的第一份 `trustworthy` 样本：同样 70 片 / 2.603MB，`indexDisagreements` 由 **67 → 0** |
| `.m0-font-manifest.json` | 字节清单本体（433 片 / 18.07MB），由 `scripts/font-manifest.mjs` 生成 |
| `.m0-manifest-check.mjs` | 清单离线自检：唯一键 433/433、0 重复、0 空 range、`normRange` 幂等、`families` 与重算一致 |
| `~/Library/Logs/vela-m0-boot.log` | ⚠️ **不在仓库里**。Rust 侧 `diag_log` 写的旁路信道，与启动方式无关——`open` 那条路径前端 IPC 全静默时，只有它能证明「JS 到底跑没跑到」。`open` 卡死的定位完全靠它 |
| `.m0-report.json` / `.m0-report-sweep-d.json` | 扫描原始输出（D 段是干净数据） |
| `.m0-mem-ab.log` | 内存归因过程记录，⛔ **B/C 段结论已撤回**，只有 D 段可用 |
| `.m0-build*.log` | 构建产物明细的来源 |
