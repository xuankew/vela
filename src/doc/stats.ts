/**
 * 字数与阅读时长（M3-A-6）。纯函数：不认识 CM6、不认识 Solid，所以能在 node 环境里穷举。
 *
 * ## 🔴 中文按字符计、西文按词计，两个口径**不能混**
 *
 * 这是 PLAN §2 那一行「统计」写死的口径，也是所有中文字数工具的共识：一个汉字就是**一个字**，
 * 而 `internationalization` 是**一个词**。混成一个口径的两种错法都很难看，而且都不报错——
 * 用「按字符」数英文，一篇 800 词的英文稿子会报出 5000「字」，读起来像是被人灌了水；
 * 用「按词」数中文，一篇 3000 字的中文稿子会报出 300「字」（中文没有空格分词），
 * 少了一个数量级，而用户只会认为这个功能坏了。
 *
 * 所以这里数的是**两个数**，加起来才是「字数」：`cjk` 逐字符、`words` 逐词。
 * 阅读时长也跟着分开算——中文默读与英文默读的速度本来就不是一个数。
 *
 * ## ⚠️ 这是一个**按需**计算，⛔ 不要塞进 `syncMetrics`
 *
 * `doc/workspace.ts` 的 `syncMetrics` 在**每一个事务**上跑，包括只动了光标的那些，
 * 而它读的 `doc.lines` / `doc.length` 在 CM6 的 rope 上是 O(1)。这一层是 O(n) 的全文扫描
 * 加一次等长的字符串分配：放进 `syncMetrics` 的后果是每敲一个键、每移一次光标都重扫一遍
 * 全文，一份 4 MiB 的文档能把输入延迟顶到几百毫秒。
 *
 * 防抖（`md/panel.ts` 那 150ms）能压住频率，但压不住另一件事：状态栏上那个数字会在
 * 你停下来之后**自己跳一下**，而一个会滞后的字数比一个要按键才出来的字数更容易被当成 bug。
 * 于是它做成了一条命令（`editor.wordCount`），结果走 `editorNotice` 说出来——
 * Sublime 的 Word Count 正是这个形状，而本项目的界面参照物就是 Sublime。
 */

/**
 * 中文默读速度（字/分钟）。
 *
 * 取 300 而不是常被引用的 400–500：那两个数是**熟练读者读浅显内容**的上限，
 * 而会去按「导出 HTML」的人写的多半是要别人认真读的东西。宁可报得保守一点——
 * 「约 5 分钟」结果读了 4 分钟没人会来投诉，反过来则会让人觉得这个数在骗他
 */
export const CJK_CHARS_PER_MINUTE = 300

/**
 * 西文默读速度（词/分钟）。
 *
 * 与上面同一个取舍：常引用的是 200–250 wpm，取下限
 */
export const LATIN_WORDS_PER_MINUTE = 200

/**
 * CJK 那一部分。
 *
 * 含而不只是汉字：假名（`3040-30FF`）、谚文（`AC00-D7AF`）、CJK 标点（`3001-303F`）
 * 与全角形式（`FF00-FFEF`）都按**一个字符**算。四条理由：
 * - 日文与韩文同样是「一个字一个字符」的书写系统，排除掉它们会让一份日文稿子报出接近 0 的字数；
 * - 中文标点算字数是国内所有字数工具（Word、知乎、微信）的一致口径，「，。」确实占版面；
 * - ⛔ 但 **U+3000 全角空格不算**——所以这一段从 `3001` 起，空格算进字数的话
 *   一份用全角空格缩进的稿子会凭空多出一堆「字」；
 * - `20000-2A6DF`（扩展 B）要 `u` 标志才认得：它是代理对，没有 `u` 的话一个字符会被数成两个
 *
 * ⚠️ `g` + `u` 的标志让这个正则带 `lastIndex` 状态。下面两个调用点用的是 `match` 与 `replace`，
 * 两者按规范都会先把 `lastIndex` 归零，所以模块级共享一份是安全的。
 * ⛔ 换成 `exec` 循环的话必须搬进函数里，否则第二次调用会从上一次停下的地方接着数
 */
const CJK_RE =
  /[\u3001-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2a6df}]/gu

/**
 * 西文那一部分：一个「词」是字母/数字/附标号的一段连续，中间许一个连字符、撇号或下划线。
 *
 * 用 `\p{L}\p{N}\p{M}` 而不是 `[A-Za-z0-9]`：一份俄文或希腊文的稿子同样是按词读的，
 * 写成 ASCII 的话它会报出 0 词，而 0 词配上「约 0 分钟」读起来像是这个文件是空的。
 * `don't` / `well-known` / `snake_case` 各算一个词，这与人的直觉一致；
 * 而 CJK 字符**不会**被这一条吃掉，因为它们在上一步就被换成空格了（见 `textStats`）
 */
const WORD_RE = /[\p{L}\p{N}\p{M}]+(?:[-'’_][\p{L}\p{N}\p{M}]+)*/gu

export interface TextStats {
  /** CJK 字符数（逐字符） */
  readonly cjk: number
  /** 西文词数（逐词） */
  readonly words: number
  /** 字数 = `cjk + words`。这才是给人看的那一个数 */
  readonly count: number
  /**
   * 含空白的字符数，口径是 **UTF-16 码元**（`source.length`）。
   *
   * ⚠️ 刻意与状态栏那个「N 字符」同一个口径（它读的是 `state.doc.length`，也是码元）：
   * 两处报出不同的数比两处都不精确更糟。代价是扩展 B 那种代理对字符会被数成 2——
   * 而那种字符在正文里几乎不出现，在代码里出现时也没人数它的字数
   */
  readonly chars: number
  /** 阅读分钟数，向上取整。`count === 0` 时是 0（一份空文档不该说「约 1 分钟」） */
  readonly minutes: number
}

/**
 * 数一遍。
 *
 * 🔴 先把 CJK 抠成空格再数西文词，而不是写一条带命名分组的联合正则：多一次等长字符串分配，
 * 换来的是两个数各自都是 `match(...).length` 这种一眼看懂的形状。这一层是按需跑的
 * （见文件头），几百毫秒的最坏情况换可读性是划算的；反过来那条联合正则要在一个循环里
 * 按分组分流，而「哪个分组命中了」这件事本身就得再写一条用例去钉
 */
export function textStats(source: string): TextStats {
  const cjk = source.match(CJK_RE)?.length ?? 0
  const words = source.replace(CJK_RE, ' ').match(WORD_RE)?.length ?? 0
  return { cjk, words, count: cjk + words, chars: source.length, minutes: readingMinutes(cjk, words) }
}

function readingMinutes(cjk: number, words: number): number {
  if (cjk === 0 && words === 0) return 0
  const minutes = cjk / CJK_CHARS_PER_MINUTE + words / LATIN_WORDS_PER_MINUTE
  // `max(1, …)`：数得出字就一定读得完，而「约 0 分钟」读起来像没算
  return Math.max(1, Math.ceil(minutes))
}

/**
 * 把统计结果说成一句话，给 `editorNotice` 用。
 *
 * ⚠️ **不用 `toLocaleString` 加分隔符**：那东西的分组跟着运行环境的 locale 走，
 * 本机 macOS 与 CI 的 ubuntu 会给出不一样的字符串，而这一句是要被用例逐字比对的。
 * 中文本来也不用千分位，`1234 字` 读起来没有任何障碍
 *
 * 只在**两种文字都有**的时候才把明细摆出来：一份纯中文稿子后面挂一句「西文 0 词」
 * 是纯噪音，而一份中英混排的稿子不给明细就说不清那个总数是怎么来的——
 * 尤其是它会让人以为「字数」是字符数
 */
export function describeStats(stats: TextStats): string {
  if (stats.count === 0) return '这份文档里没有可数的字'
  const mixed = stats.cjk > 0 && stats.words > 0
  const detail = mixed ? `（中文 ${stats.cjk} · 西文 ${stats.words} 词）` : ''
  return `${stats.count} 字${detail} · 约 ${stats.minutes} 分钟读完`
}
