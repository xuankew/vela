/**
 * 内置工具清单（M3-B）。
 *
 * 这一份数组是工具箱的**全部内容**（v1 计划六个，**六个全部落地**）：`App.tsx` 把它交给
 * `createToolBox`，后者一次做成两件事——把描述符收进目录、把它们投影成命令注册表里的
 * 命令（见 `./registry.ts` 的 `installTools`，那里写着为什么这两半不能分成两个调用）。
 *
 * ## ⚠️ 加一个工具 = 往这里加一个描述符，别的地方都不用动
 *
 * 于是「工具在左栏点得到、在 `Mod+Shift+P` 里搜得到」这两件事在结构上不会漂移。
 * 描述符写错的话 `installTools` 会在启动时**整批不装并一次报出所有问题**——
 * v1 的清单是写死在代码里的常量，所以一份不合法的描述符是我们的 bug，不是用户的输入。
 *
 * ## 分工：`run` 住在这里，纯活住在各自的模块里
 *
 * `json.ts` 不知道「描述符」是什么，它只有几个能被单测直接钉住的纯函数；
 * 这里把选项值翻译成对那几个函数的调用。于是「缩进那一格选了 `Tab`」这种
 * 只有面板才关心的事，不会渗进算法层。
 *
 * ⚠️ 反过来说，**选项值的中文串本身住在这里**（`INDENT_NONE`、`CODEC_MODES`）：
 * 它们是「选项条上显示什么」，而算法层收的是已经翻译好的参数（`indentOf` 给的
 * `string | number | undefined`、`urlEncode` 给的 `whole: boolean`）
 *
 * ## 🔴 这一份**不能**懒加载
 *
 * 工具要在启动那一刻就投影成命令，否则 `Mod+Shift+P` 里搜不到它们
 * （见 PLAN §3.5「M3-B-1 实施修正」13）。所以工具的**实现**都留在首屏里，
 * 能懒加载的只有那两块浮层的 UI。
 *
 * ## ⚠️ 「一个几百字节」那个预期没兑现，但偏差在收窄
 *
 * | 里程碑 | 新增 | 首屏 gzip | 实测边际成本 |
 * |---|---|---|---|
 * | M3-B-2 | JSON 格式化 / 压缩 | 277.66 kB | **+2.40 kB** |
 * | M3-B-3 | Base64 / URL 编解码 | 278.94 kB | **+1.28 kB** |
 * | M3-B-4 | UUID + 时间戳（**两个**） | 282.19 kB | **+3.25 kB**（≈1.6 kB / 个） |
 * | M3-B-5 | 正则测试器 | 284.01 kB | **+1.82 kB** |
 * | M3-B-6 | 命名风格转换 | 284.61 kB | **+0.60 kB** |
 *
 * 🔴 五个数往两个相反的方向偏，而**都不是外推的依据**：
 *
 * - JSON 那一个的 2.40 kB 里有一大半是**共享层的开办费**（`describeErrorAt` / `locate` /
 *   `src/util/base64.ts` 那几件后来每个工具都在白拿的东西）；
 * - 编解码那一个有**三个**扫描器（base64 字母表、`%XX` 语法、落单代理项）却只 1.28 kB，
 *   因为上面那些已经付过钱了；
 * - 时间戳那一个是四个里**纯活最重的**（自己一套 ISO-8601 解析器 + BigInt 换算 +
 *   五种单位的启发式），而它连 UUID 一起也才 3.25 kB——因为定位那一层
 *   （`describeErrorAt` / `describeCharAt`）已经是第三次白拿；
 * - 正则那一个 1.82 kB，落在写它之前那一句「剩下两个大概率落在 1–2 kB / 个」的区间里。
 *   ⚠️ 但它带着**两个**扫描器（标志串 + 模式串）、一份自己的行列游标
 *   （`locate` 是 O(offset)，200 处命中上不够用）、以及一个 `$` 展开器——
 *   纯活的量并不比时间戳那一个少，省下来的是共享层已经付过四次钱；
 * - 命名风格那一个 **0.60 kB，是六个里最便宜的，而它恰好是纯活最少的那个**：
 *   没有扫描器（不需要定位，于是 `describeErrorAt` / `locate` 一次都没白拿）、
 *   没有选项格、没有 BigInt，只有一个单趟分词器加六行 `join`。
 *   🔴 它**证伪**了「越晚加越便宜是因为共享层摊薄了」这条读法：正则那一个比它晚一轮
 *   却贵三倍，差别在纯活的量，不在摊薄。
 *
 * ⚠️ 于是「新增一个工具的边际成本 ≈ 写一个纯函数」这句话是从**第二个**工具起才成立的，
 * 而 0.60–3.25 kB 这一整个区间都是「一个纯函数」——跨度是 5 倍。
 * 🔴 六个都落地了，这一张表到此为止：⛔ 别拿它的平均值去估 M4 那些还没定的工具
 */

import { base64Decode, base64Encode, urlDecode, urlEncode } from './codec'
import { blankJsonComments, scanJson, sortKeysDeep } from './json'
import { namingReport } from './naming'
import { regexReport } from './regex'
import { timeReport } from './time'
import { describeErrorAt, type ToolDefinition, type ToolOptions, type ToolResult } from './tool'
import { uuidList } from './uuid'

/**
 * 「缩进」那一格里代表**压缩**的那个候选。
 *
 * ⚠️ 抽成常量是因为它出现在两处（候选清单与 `indentOf`），而写两遍的话
 * 改一处忘一处的症状是「选了压缩、输出还是带缩进的」——一个安静地不听话的选项
 */
const INDENT_NONE = '无（压缩）'

/**
 * 把选项值翻成 `JSON.stringify` 的第三个参数。
 *
 * ⚠️ 缺省落到 `2` 而不是抛错：`run` 拿到的选项来自 `defaultOptions` 与 `coerceOption`，
 * 两边都保证值在候选里，所以 `default` 那一支是**结构上到不了**的。
 * 到不了也要给一个值，因为 `switch` 不写 `default` 的话 TS 会认为函数末尾可达
 */
function indentOf(options: ToolOptions): string | number | undefined {
  switch (options.indent) {
    case '4':
      return 4
    case 'Tab':
      return '\t'
    case INDENT_NONE:
      return undefined
    default:
      return 2
  }
}

/**
 * JSON 格式化 / 压缩的 `run`。
 *
 * 🔴 **空输入返回 `ok` + 空串**，不是错误。工具箱是「改一个字就重跑一次」的，
 * 于是打开这个工具的那一瞬间输入格是空的；那时候报「第 1 行第 1 列：这里该有一个值」
 * 会让输出格在用户还没粘东西之前就红一次。返回空串之后输出格显示的是
 * `OUTPUT_PLACEHOLDER`（「输出会出现在这里」），那正是「还没东西可跑」该有的样子
 */
function runJson(input: string, options: ToolOptions): ToolResult {
  if (input.trim() === '') return { kind: 'ok', text: '' }

  // 🔴 抹注释那一步是**等长**的（连 `\n` 的位置都保住），所以 `source` 与 `input`
  // 逐下标对齐。这一点撑着下面两件事：报出去的 `at` 能直接用来选输入格里的那一行，
  // 而给用户看的那一行可以从 **`input`** 里取——从 `source` 里取的话，
  // 他会看到一行「注释的位置上是一片空白」的文字，与他格子里的东西对不上
  const source = options.stripComments === true ? blankJsonComments(input) : input

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (err) {
    const found = scanJson(source)
    // 扫描器说没错、引擎说有问题：两边口径不一致。几乎只可能是嵌套太深把引擎的栈掀了
    // （扫描器是迭代的，不会）。这时候**如实把引擎那句原话交出去**，
    // ⛔ 不编一个位置——一个指错地方的「跳到出错处」比没有这个按钮更坏
    if (found === null) return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
    return { kind: 'error', text: describeErrorAt(input, found.offset, found.expected), at: found.offset }
  }

  if (options.sortKeys === true) value = sortKeysDeep(value)
  return { kind: 'ok', text: JSON.stringify(value, null, indentOf(options)) ?? '' }
}

/**
 * JSON 格式化 / 压缩（M3-B-2，六个里的第一个）。
 *
 * ⚠️ **一个描述符，不是两个**。「JSON 格式化」与「JSON 压缩」在 PLAN 的 P0 表里是
 * 同一格（`JSON 格式化 / 压缩（可设缩进、排序键、去注释）`），而它们本来就是同一个
 * 算法的两种缩进；分成两个工具的话左栏多一行、命令注册表多一条、`Mod+Shift+P` 里
 * 多一个「JSON」开头的候选，而用户还得先想清楚自己要的是哪一个。
 * 名字里两个词都写着，于是左栏那个过滤框打「压缩」也捞得到它
 *
 * ⚠️ 导出来只是为了让用例能直接拿这一份描述符；`App.tsx` 读的是下面那个 `BUILTIN_TOOLS`
 */
export const JSON_TOOL: ToolDefinition = {
  id: 'tool.json.format',
  name: 'JSON 格式化 / 压缩',
  category: 'format',
  input: 'text',
  side: 'js',
  options: [
    // ️ 候选值就是显示文字，没有另配一份 label（`tool.ts` 的 `SelectOption` 上写着为什么）。
    // 于是「选项条上写着 `无（压缩）`、`run` 收到的也是这个串」，中间没有能对不上的地方
    { kind: 'select', key: 'indent', label: '缩进', choices: ['2', '4', 'Tab', INDENT_NONE], default: '2' },
    { kind: 'toggle', key: 'sortKeys', label: '排序键', default: false },
    /**
     * 🔴 默认**开**。理由是这个工具的实际用法：从 `tsconfig.json`、`.vscode/settings.json`、
     * 或者别人贴给你的一段带注释的配置里拷一份进来。默认关的话，那一下得到的是一句
     * 「第 1 行第 1 列：这里不该是「/」」，而用户会以为工具坏了。
     *
     * ⚠️ 但它**可以关**，而关掉之后这个工具与 `JSON.parse` 一字不差——
     * 这是「不接受注释」那条底线的退路：输出永远是合法 JSON，⛔ 不是 JSON5
     */
    { kind: 'toggle', key: 'stripComments', label: '去注释', default: true },
  ],
  run: runJson,
}

/**
 * 「模式」那一格的五个候选。
 *
 * ⚠️ 抽成常量是因为它出现在两处（候选清单与 `runCodec` 的 `switch`），而写两遍的话
 * 改一处忘一处的症状与 `INDENT_NONE` 那条一模一样：**一个安静地不听话的选项**
 */
const MODE_B64_ENCODE = 'Base64 编码'
const MODE_B64_DECODE = 'Base64 解码'
const MODE_URL_ENCODE_VALUE = 'URL 编码（值）'
const MODE_URL_ENCODE_WHOLE = 'URL 编码（整条）'
const MODE_URL_DECODE = 'URL 解码'

const CODEC_MODES = [MODE_B64_ENCODE, MODE_B64_DECODE, MODE_URL_ENCODE_VALUE, MODE_URL_ENCODE_WHOLE, MODE_URL_DECODE]

/**
 * Base64 / URL 编解码的 `run`。
 *
 * ⚠️ 这里**没有** `runJson` 那个空输入短路：五个模式在空串上都自然地给出空串
 * （`btoa('')`、`atob('')`、`encodeURIComponent('')`、`decodeURIComponent('')` 全是 `''`），
 * 于是输出格显示的还是 `OUTPUT_PLACEHOLDER`，不需要额外拦一道
 */
function runCodec(input: string, options: ToolOptions): ToolResult {
  switch (options.mode) {
    case MODE_B64_ENCODE:
      return base64Encode(input)
    case MODE_B64_DECODE:
      return base64Decode(input)
    case MODE_URL_ENCODE_VALUE:
      return urlEncode(input, false)
    case MODE_URL_ENCODE_WHOLE:
      return urlEncode(input, true)
    case MODE_URL_DECODE:
      return urlDecode(input)
    default:
      // 结构上到不了：`options` 来自 `defaultOptions` 与 `coerceOption`，两边都保证值在候选里。
      // 到不了也要如实说一句，⛔ 不悄悄退化成某一个模式——「选了 A 跑出 B 的结果」比一条错更难查
      return { kind: 'error', text: `不认识的模式「${String(options.mode)}」` }
  }
}

/**
 * Base64 / URL 编解码（M3-B-3，六个里的第二个）。
 *
 * ⚠️ **一个描述符、一个选项，不是五个工具、也不是两个选项**。
 * 拆成「Base64」与「URL」两个工具的话，还要再各配一个「编码 / 解码」的下拉；
 * 而那个下拉在只有一种方向的工具里是**点了没反应的**——一个安静地不听话的控件，
 * 正是这一份代码里到处在躲的那种东西。合成一格之后五个候选两两互斥，选哪个都对
 *
 * ⚠️ URL 的编码**分两格**（值 / 整条）而不是一个开关，因为两者的差别不好用「是 / 否」
 * 来表达：`encodeURIComponent` 会把 `& = / ? #` 全编掉（要塞进 query 的一个值里时正是
 * 要这样），而 `encodeURI` 留着它们（它们**是**那条 URL 的结构）。
 * 中文候选里把这一点写在了括号里，于是不用读文档也选得对
 *
 * ⚠️ PLAN 的 P0 表里那一格写的是「Base64 文本 / 图片」。**图片那半没做**：
 * 工具箱的输入格是文字，图片要先有「选一个文件 / 拖进来」这条路，
 * 那是另一件事，推到 M4 与 `assets/` 路径可配置一起做（见 §3.5「M3-B-3 实施修正」）
 *
 * ⚠️ 导出来只是为了让用例能直接拿这一份描述符；`App.tsx` 读的是下面那个 `BUILTIN_TOOLS`
 */
export const CODEC_TOOL: ToolDefinition = {
  id: 'tool.codec',
  name: 'Base64 / URL 编解码',
  category: 'encode',
  input: 'text',
  side: 'js',
  options: [{ kind: 'select', key: 'mode', label: '模式', choices: CODEC_MODES, default: MODE_B64_ENCODE }],
  run: runCodec,
}

/**
 * 「个数」那一格的上限。
 *
 * 🔴 这一条线是**平台给的**，不是拍出来的：`crypto.getRandomValues` 一次最多收 65536 个字节，
 * 再多就抛 `QuotaExceededError`。而 `uuidList` 刻意**一次**填满整批——1000 个 UUID
 * 是 16000 字节，离那一条线还有四倍——于是「生成 1000 个」是一次取随机数，不是 1000 次。
 *
 * ⚠️ `builtin.test.ts` 把 `max × UUID_BYTES ≤ 65536` 钉住了：改这一个数会先撞红，
 * 而不是等到用户把格子填成 9999、点下去看见一句 `QuotaExceededError`
 */
const UUID_MAX_COUNT = 1000

/**
 * UUID 生成的 `run`。
 *
 * ⚠️ `_input` 收不到东西：这一个工具是 `input: 'none'`，而 `store.ts` 的 `runNow`
 * 对那一类**写死**递一个空串（它压根不去读输入格，因为面板没画）。
 * 参数还留着是因为 `ToolDefinition.run` 的签名是统一的
 *
 * ⚠️ 三个收窄的缺省值都落在**描述符里写的那个默认值**上，而不是抛错：
 * `defaultOptions` 与 `coerceOption` 两边都保证值合法，所以这三支结构上到不了。
 * 到不了也要给一个值，理由与 `indentOf` 的 `default` 那一支相同。
 * 🔴 而 `hyphens` 用 `!== false` 而不是 `=== true`，是为了让「到不了的那一支」
 * 落到默认值 `true` 上——`uppercase` 的默认值是 `false`，所以它用 `=== true`
 */
function runUuid(_input: string, options: ToolOptions): ToolResult {
  const count = typeof options.count === 'number' ? options.count : 1
  return { kind: 'ok', text: uuidList(count, options.uppercase === true, options.hyphens !== false) }
}

/**
 * UUID 生成（M3-B-4，六个里的第三个）。
 *
 * ⚠️ 名字里带着「（v4）」，因为这一个工具的输出是要**原样插回编辑器**的
 * （「插回编辑器」那一个按钮就是把输出格里的文字整份写进文档）。
 * 于是版本这句话没有地方可以放：写在输出的第一行的话，插回去就多了一行要手动删的东西。
 * 放在名字里，它出现在左栏、命令面板与工具箱头部三个地方，而输出保持干净
 *
 * 🔴 **只有 v4**。PLAN 的 P0 表里那一格写的是「UUID / ULID / NanoID」，
 * 后两个**没做**：ULID 要一个 Crockford base32 编码器与一个 48 位时间戳，
 * NanoID 要一份可配置的字母表，两者都不是「v4 换个参数」的形状。
 * ⛔ 别把那一格当成整格兑现了记账
 *
 * ⚠️ 导出来只是为了让用例能直接拿这一份描述符；`App.tsx` 读的是下面那个 `BUILTIN_TOOLS`
 */
export const UUID_TOOL: ToolDefinition = {
  id: 'tool.uuid',
  name: 'UUID 生成（v4）',
  category: 'generate',
  input: 'none',
  side: 'js',
  options: [
    { kind: 'number', key: 'count', label: '个数', min: 1, max: UUID_MAX_COUNT, default: 1 },
    { kind: 'toggle', key: 'uppercase', label: '大写', default: false },
    { kind: 'toggle', key: 'hyphens', label: '带连字符', default: true },
  ],
  run: runUuid,
}

/**
 * 时间戳互转的 `run`。
 *
 * 🔴 `Date.now()` 在**这里**读，不在 `timeReport` 里面读：那一个函数因此是纯的，
 * 用例能把 `now` 钉成一个确定的数。这一层是整个工具箱里唯一一处
 * 「不纯的东西留在描述符这一侧」的地方，而它也正是描述符这一层该干的活
 */
function runTime(input: string): ToolResult {
  return timeReport(input, Date.now())
}

/**
 * 时间戳互转（M3-B-4，六个里的第四个）。
 *
 * ⚠️ **一个选项都没有**：秒 / 毫秒 / 微秒 / 纳秒是按位数**猜**的，而猜成了哪一种
 * 写在输出的披露那一句里（「（输入读成「秒」）」）。做成一个下拉的话就有两处真相，
 * 而「下拉写着毫秒、输出说是秒」这种对不上是没法查的
 *
 * ⚠️ PLAN 的 P0 表里那一格写的是「秒 / 毫秒 / 时区」。**时区那半只做了一半**：
 * 输出给「本地（带 UTC 偏移）+ UTC」两行，⛔ 没有 `Asia/Shanghai` 那种选时区的格子——
 * 一份时区表加上与本地化无关的格式化是另一份预算（见 `time.ts` 的模块文档）
 *
 * ⚠️ 导出来只是为了让用例能直接拿这一份描述符；`App.tsx` 读的是下面那个 `BUILTIN_TOOLS`
 */
export const TIME_TOOL: ToolDefinition = {
  id: 'tool.timestamp',
  name: '时间戳互转',
  category: 'convert',
  input: 'text',
  side: 'js',
  run: runTime,
}

/**
 * 「输出」那一格的两个候选。
 *
 * ⚠️ 抽成常量与 `INDENT_NONE` / `CODEC_MODES` 同一条理由：它同时出现在候选清单与
 * `runRegex` 的判断里，写两遍的症状是**一个安静地不听话的选项**
 */
const REGEX_MODE_LIST = '匹配清单'
const REGEX_MODE_REPLACE = '替换结果'

/**
 * 正则测试器的 `run`。
 *
 * ⚠️ 三个文字格各自收窄成 `''` 而不是抛错，理由与 `runUuid` 相同：`defaultOptions`
 * 与 `coerceOption` 两边都保证 `kind: 'text'` 的值是字符串，所以这三支结构上到不了。
 * 🔴 落到 `''` 尤其安全——`regexReport` 对空模式返回 `ok` + 空串，也就是「还没东西可跑」
 *
 * ⚠️ `mode` 用 `=== REGEX_MODE_REPLACE` 判，于是「到不了的那一支」落到 `list` 上：
 * 清单是缺省的那一档，也是**不会改用户文字**的那一档
 */
function runRegex(input: string, options: ToolOptions): ToolResult {
  return regexReport(
    input,
    typeof options.pattern === 'string' ? options.pattern : '',
    typeof options.flags === 'string' ? options.flags : '',
    typeof options.replacement === 'string' ? options.replacement : '',
    options.mode === REGEX_MODE_REPLACE ? 'replace' : 'list',
  )
}

/**
 * 正则测试器（M3-B-5，六个里的第五个）。
 *
 * 🔴 **实时高亮没做**（用户的选择，PLAN §3.5「M3-B-5 实施修正」）。输出格是一份
 * 纯文字报告：`匹配 N 处` + 每处的行列 / 命中片段 / 各分组，或者「替换结果」那一档的
 * 纯替换后文本。理由记在 `regex.ts` 的模块文档里，一句话版：`ToolResult` 只有
 * `text` 与 `at`（一个下标），装不下一份匹配区间清单，而给它加一个 `ranges` 字段
 * 意味着输出格要从 textarea 换成一个带标记的只读 CM6——那是另一个里程碑的预算
 *
 * 🔴 `at` 指向**第一处匹配**，于是「跳到第一处」那个按钮在这一个工具上是有用的。
 * ⚠️ 模式本身或标志写错时**不带** `at`：`at` 的坐标系是输入格的，
 * 而模式住在选项格里，指过去只会指到一个无关的地方
 *
 * ⚠️ **「替换成」那一格在「匹配清单」这一档下不生效**，这与 `CODEC_TOOL` 刻意躲开的
 * 「点了没反应的控件」是同一类风险。留下来是因为另一条路更差：拆成「正则测试」与
 * 「正则替换」两个工具的话，`pattern` 与 `flags` 两格要在两份描述符里各写一遍，
 * 而「在这一个里调好的模式，切到那一个又得重打」正是这类工具最烦人的地方
 *
 * ⚠️ **没有超时中断**：一个灾难性回溯的模式（`(a+)+$` 撞上 `aaaaaaaaaaaaaaaaaaaaX`）
 * 会把整个窗口冻住，因为 `run` 跑在 UI 线程上。真正的解法是 Worker + deadline，
 * `ToolDefinition.run` 的签名已经允许返回 Promise，所以那条路没堵死（见 `regex.ts`）
 *
 * ⚠️ 导出来只是为了让用例能直接拿这一份描述符；`App.tsx` 读的是下面那个 `BUILTIN_TOOLS`
 */
export const REGEX_TOOL: ToolDefinition = {
  id: 'tool.regex',
  name: '正则测试器',
  category: 'test',
  input: 'text',
  side: 'js',
  options: [
    { kind: 'text', key: 'pattern', label: '正则', default: '' },
    { kind: 'text', key: 'flags', label: '标志', default: '' },
    { kind: 'text', key: 'replacement', label: '替换成', default: '' },
    {
      kind: 'select',
      key: 'mode',
      label: '输出',
      choices: [REGEX_MODE_LIST, REGEX_MODE_REPLACE],
      default: REGEX_MODE_LIST,
    },
  ],
  run: runRegex,
}

/**
 * 命名风格转换（M3-B-6，六个里的最后一个）。
 *
 * 🔴 六种风格**一次全给**而⛔ 不做「目标风格」下拉：与 `CODEC_TOOL`（五选一）相反。
 * 理由是这个工具的实际用法——手上有 `user_name`，**要看一眼才知道**自己要的是
 * `userName` 还是 `UserName`；做成下拉的话用户得先在六个英文名字里想清楚要哪个，
 * 而想清楚的办法正是把它们都看一遍（详见 `naming.ts`）
 *
 * ⚠️ 于是它是**第二个**「输出是报告不是内容」的工具（第一个是 `TIME_TOOL`），
 * 「插回编辑器」插进去的是六行带标签的对照表。M3-B-4 已经为时间戳认下了这一条
 *
 * 🔴 它也是**第二个**没有选项格的工具（第一个同样是 `TIME_TOOL`），
 * 于是右栏只有输入格 + 输出格、没有选项条——`ToolBox.tsx` 那一句
 * `<Show when={(tool.options ?? []).length > 0}>` 在 M3-B-4 就已经为这一种形状存在了
 *
 * ⚠️ 导出来只是为了让用例能直接拿这一份描述符；`App.tsx` 读的是下面那个 `BUILTIN_TOOLS`
 */
export const NAMING_TOOL: ToolDefinition = {
  id: 'tool.naming',
  name: '命名风格转换',
  category: 'text',
  input: 'text',
  side: 'js',
  run: (input) => namingReport(input),
}

/** v1 的内置工具。顺序无所谓：左栏按分类分组、组内按名字排（见 `./tool.ts` 的 `groupTools`） */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  JSON_TOOL,
  CODEC_TOOL,
  UUID_TOOL,
  TIME_TOOL,
  REGEX_TOOL,
  NAMING_TOOL,
]
