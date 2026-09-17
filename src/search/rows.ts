/**
 * 搜索结果的**纯逻辑**：把「一批批推过来的 `SearchFile`」摊成可以直接虚拟化渲染的扁平行数组，
 * 再从这个数组上算出键盘落点，以及把 `SearchSummary` 落地成人话。
 *
 * 与 `src/project/tree.ts` 是同一个分层：这一层不含 signal、不含 IPC、不含 DOM，
 * 全是纯函数，于是每一件都能被单测直接钉住。状态本身住在 `./store.ts`。
 *
 * ## 为什么是「文件行 + 命中行」两种行
 *
 * 一次搜索最多产出 `MAX_HITS`（Rust 侧 20000）条命中。把它们平铺成一张表，
 * 用户看到的是两万行里同一个文件名重复几十遍；按文件分组则文件名只出现一次，
 * 而且「这个文件里到处都是」这件事一眼就能看出来。
 *
 * ⚠️ 分组只体现在**行的顺序**上，不建父子指针：扁平数组 + 定高行是 `visibleWindow`
 * 那套 O(1) 窗口算术的前提，一旦引入嵌套就得算前缀和。缩进靠 CSS 的 padding 表达。
 *
 * ## 为什么扁平化是增量的
 *
 * `flattenFiles` 一次只处理**新到的那一批**，调用方把结果 append 到已有数组后面。
 * 每批到达都从头重摊一遍的话，成本是 O(批次 × 总行数)：二十个文件一批、一万条命中
 * 就是五百批 × 两万行 = 一千万次对象构造，而这五百批是在几秒钟里连着到的。
 * 增量摊的话每批只做它自己那几十行。
 *
 * 顺带保住一条渲染性质：已经摊出来的行对象**引用不变**，所以 `<For>` 靠引用相等
 * 把 DOM 原样复用，新结果到达时不会把整个列表重建一遍。
 */

import type { MatchRange, SearchFile, SearchSummary } from '../ipc/search'
import type { ReplaceProgress, ReplaceSummary } from '../ipc/replace'
import { OVERSCAN, visibleWindow, type VirtualWindow } from '../project/tree'

/** 结果列表里的一行。文件行是分组标题，命中行是真正能点着跳过去的那一条 */
export type ResultRow = FileRow | HitRow

export interface FileRow {
  kind: 'file'
  /** 相对项目根的路径，与 `DirEntry.rel` 同一个口径 */
  rel: string
  path: string
  /** 这个文件里有多少处命中。分组标题上显示的就是它 */
  hits: number
  /** 撞到单文件上限（Rust 侧 500），UI 要说「还有更多」 */
  truncated: boolean
  /**
   * 替换时这个文件会被**跳过**：它正开着一个标签、且有未保存的改动。
   *
   * ⚠️ 必须在预览里就说出来，不能等 `ReplaceSummary.skippedOpen` 事后补：
   * 预览走的是 `start_search`，它不知道 `skip` 清单的存在，于是那些行会照常
   * 显示成「将会被替换」。不标的话用户批准的是一份**做不到**的清单，
   * 而事后那句「跳过了 2 个」看起来像是我们偷偷少改了
   */
  skipped: boolean
}

export interface HitRow {
  kind: 'hit'
  rel: string
  /** 绝对路径。点这一行时原样交给 `openFile`，前端不自己拼 */
  path: string
  /** 1 起算 */
  line: number
  /** 这一行的正文，不含行终止符也没有 trim——`ranges` 的偏移量是按它算的 */
  text: string
  /**
   * 要高亮的段，偏移量是 **UTF-16 码元**，与 `String.prototype.slice`、
   * 与 CM6 的文档位置同一口径。⚠️ 可能是空的（见 `SearchHit` 的文档）：
   * 空不等于「这行没命中」，只是画不出高亮，行号照样能跳。
   *
   * ⚠️ 而且它数的是 `text` 里的位置，**不是** `replaced` 里的——替换串长度一变，
   * 拿它去切 `replaced` 会安静地切错半个词
   */
  ranges: MatchRange[]
  /**
   * 替换模式下这一行换完之后长什么样。
   *
   * ⚠️ 判它只能用 `=== undefined`，**不能用真值判断**：`''` 是「把命中的地方删光」
   * 那个合法操作的预览，而真值判断下它与「纯搜索、没预览过」长得一模一样。
   * 搞混的后果是那一行退回成纯搜索的样子，用户以为自己刚刚预览了一次删除
   *
   * ⚠️ 可能含 `\n`（模板里打换行是合法的），所以渲染前要过 [`oneLine`]
   */
  replaced?: string
  truncated: boolean
}

/** `segmentsOf` 切出来的一段。`hit` 为真就是要加粗那一下的地方 */
export interface ResultSegment {
  text: string
  hit: boolean
}

/**
 * 行高。与 `tree.ts` 的 `ROW_HEIGHT`（22）刻意不同：结果列表一屏要装的东西比文件树多，
 * 而且命中行本身就有缩进与行号两个前缀，22px 会让面板在同样的窗口高度下少显示 10% 的行。
 *
 * ⚠️ 与侧边栏同一条规矩：**行高只有一个真相**。这个常量同时用于窗口算术与 CSS
 * （组件把它注入成 `--vela-search-row-height`），写成两处字面量的话漂移的失败方式是
 * 「行与行之间露出一条缝」，不报错，只是难看。
 */
export const RESULT_ROW_HEIGHT = 20

/**
 * 结果列表的可视窗口。
 *
 * 直接复用 `project/tree.ts` 的 `visibleWindow`：它的算术只依赖「定高行 + 总行数」，
 * 与「行是树节点还是搜索结果」无关，`OVERSCAN` 那条理由（快速滚动时别露白）也一模一样。
 * 只有行高不同，所以显式传进去。
 *
 * 它现在住在 `project/` 下面是历史顺序，不是归属判断。M2-E 的 Goto Anything 会是第三个
 * 消费者，到那时再抽成共享模块——现在抽是给一个还不存在的第三方让路。
 */
export function resultWindow(scrollTop: number, viewportHeight: number, total: number): VirtualWindow {
  return visibleWindow(scrollTop, viewportHeight, total, RESULT_ROW_HEIGHT, OVERSCAN)
}

/**
 * 把**一批**文件摊成行。调用方负责 append，理由见模块文档。
 *
 * 每个文件产出「一行标题 + 它的每条命中一行」。命中为零的文件也照样产出标题行——
 * Rust 侧不会推这种文件（`run.rs` 只在 `hits` 非空时才 push），但契约上没禁止，
 * 而漏掉它的话那个文件就在结果里彻底消失了，连「搜到了但没命中」都说不出来。
 *
 * @param isSkipped 这个绝对路径在替换时会不会被跳过（见 `FileRow.skipped`）。
 *   ⚠️ 它是**摊的那一刻**求值的，所以用户在这批到达之后才把某个文件改脏，
 *   已经摊出来的那一行不会跟着变。这是接受的代价：换成「每次渲染都查一遍」的话
 *   `rows()` 就得依赖一个每次编辑都变的信号，而 `<For>` 靠引用相等复用 DOM 那条
 *   性质会当场失效——两万个节点重建一遍。真正的对账在落盘之后，
 *   由 `ReplaceSummary.skippedOpen` 如实报出
 */
export function flattenFiles(
  files: readonly SearchFile[],
  isSkipped: (path: string) => boolean = () => false,
): ResultRow[] {
  const rows: ResultRow[] = []
  for (const file of files) {
    rows.push({
      kind: 'file',
      rel: file.rel,
      path: file.path,
      hits: file.hits.length,
      truncated: file.truncated,
      skipped: isSkipped(file.path),
    })
    for (const hit of file.hits) {
      rows.push({
        kind: 'hit',
        rel: file.rel,
        path: file.path,
        line: hit.line,
        text: hit.text,
        ranges: hit.ranges,
        // 直接搬 `hit.replaced`：纯搜索时它是 `undefined`，与「预览结果是删光」那个
        // 空串在类型上就是两个值，中间不需要任何转换
        replaced: hit.replaced,
        truncated: hit.truncated,
      })
    }
  }
  return rows
}

/** 一次按键要做的动作。`none` = 这个键在此刻的状态下什么都不该干 */
export type ResultAction = { kind: 'select'; index: number } | { kind: 'open'; index: number } | { kind: 'none' }

/** `actionForKey` 认的键。用 `e.key` 的字面值，不经过命令中心的 keybinding 解析 */
export type ResultKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'Enter'

const RESULT_KEYS: ReadonlySet<string> = new Set<ResultKey>(['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'])

/** 与 `tree.ts` 的 `isTreeKey` 同理：收窄放在这里，漏一个键的失败方式是「按了没反应」 */
export function isResultKey(key: string): key is ResultKey {
  return RESULT_KEYS.has(key)
}

const NONE: ResultAction = { kind: 'none' }

/**
 * 方向键在一份扁平结果上的落点。
 *
 * 比树上那套简单得多——没有展开/折叠，所以左右键不在这里，上下就是 ±1：
 * 「可见行」这个概念已经被扁平数组算好了。
 *
 * ⚠️ 选中用的是**下标**而不是某个 id：结果行没有天然主键（同一个文件的同一条命中
 * 在两次搜索之间毫无关系），而下标在一次搜索内是稳定的——行只会往后面 append，
 * 前面那些的位置不会动。换一次搜索整个列表被替换，选中跟着清空。
 */
export function actionForKey(total: number, current: number | null, key: ResultKey): ResultAction {
  if (total <= 0) return NONE
  const at = current === null || current < 0 || current >= total ? -1 : current
  switch (key) {
    case 'Home':
      return { kind: 'select', index: 0 }
    case 'End':
      return { kind: 'select', index: total - 1 }
    case 'ArrowUp':
      // 没选中过时上下键都从第一行起步，与 `tree.ts` 的 `actionForKey` 同一条规矩
      return { kind: 'select', index: at < 0 ? 0 : Math.max(0, at - 1) }
    case 'ArrowDown':
      return { kind: 'select', index: at < 0 ? 0 : Math.min(total - 1, at + 1) }
    case 'Enter':
      // 没选中过就不猜用户想开哪一条：一万条结果里随便打开一个文件是净损失
      return at < 0 ? NONE : { kind: 'open', index: at }
  }
}

/**
 * 第 `index` 行该跳到哪一处命中。
 *
 * 命中行就是它自己；**文件行是它的第一个命中**——点分组标题打开那个文件是所有人的直觉，
 * 而「打开但不跳行」会让用户落在文件开头，然后自己在几万行里找刚才那一处。
 *
 * 返回 null 只有一种情况：那一行是文件行，而它一条命中都没有（见 `flattenFiles`）。
 */
export function openTarget(rows: readonly ResultRow[], index: number): HitRow | null {
  const row = rows[index]
  if (!row) return null
  if (row.kind === 'hit') return row
  const next = rows[index + 1]
  // 扁平化保证一个文件行后面紧跟的就是它自己的命中行，所以只看下一行就够：
  // 下一行是别的文件行，说明这个文件一条命中都没有
  return next && next.kind === 'hit' ? next : null
}

/**
 * 一行正文按命中段切成「普通 / 高亮」交替的片段，给面板把命中那一下加粗用。
 *
 * 一条不变量：**把所有片段的 `text` 拼回去必须等于原字符串**。渲染时少一段的失败方式是
 * 那行看起来「少了个字」，而它其实只是没被高亮——用户会以为搜索把正文改了。
 *
 * `ranges` 为空时返回一整段普通文本，而不是空数组：空数组渲染出来是一行空白，
 * 而这一行是有正文的，只是说不清命中在哪儿（见 `SearchHit.ranges` 的注释）。
 *
 * 游标 `at` 只往前走，所以乱序或重叠的段会被自然吃掉——不会切出负长度的片段，
 * 也不会让同一段正文被渲染两次。
 */
export function segmentsOf(text: string, ranges: readonly MatchRange[]): ResultSegment[] {
  const out: ResultSegment[] = []
  let at = 0
  for (const range of ranges) {
    const start = Math.max(range.start, at)
    const end = Math.min(range.end, text.length)
    if (end <= start) continue
    if (start > at) out.push({ text: text.slice(at, start), hit: false })
    out.push({ text: text.slice(start, end), hit: true })
    at = end
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), hit: false })
  return out
}

/**
 * 耗时怎么说。<1s 报毫秒，≥1s 报两位小数的秒。
 *
 * 十万个文件的搜索是 6.9s 那个量级，报成「6930ms」要人多算一步；
 * 而本仓库 107 个文件是 12.7ms，报成「0.01s」就把「快得离谱」这件事说糊了。
 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
}

/** 搜索进行中时那一句进度。心跳批带来的 `filesScanned` 就显示在这里 */
export function describeProgress(filesScanned: number): string {
  return `正在搜索… 已扫过 ${filesScanned} 个文件`
}

/**
 * 一次搜索结束时的总账，一句话说完。
 *
 * ⚠️ **刻意不含「读不出来」那一条**：那句话不是总账的一部分，是一个警告，
 * 由 [`unreadableWarning`] 单独给出、单独用警告色渲染。混在这一行里的后果是
 * 它跟在一串数字后面，用户扫一眼只看到「共 0 处」就走了——而那一串数字里
 * 恰恰藏着一个「这个 0 可能是假的」。
 *
 * 也刻意不写「上限是 20000 条」这种具体数字：那个常量住在 Rust 侧（`MAX_HITS`），
 * 前端再抄一份就多一处会漂移的地方，而漂了也不会报错。
 */
export function describeSummary(summary: SearchSummary): string {
  const parts: string[] = []
  // 「已取消」放最前面：它限定的是后面每一个数字的效力——那些只是取消之前搜到的部分
  if (summary.cancelled) parts.push('已取消')
  parts.push(summary.hits === 0 ? '没有找到' : `共 ${summary.hits} 处，分布在 ${summary.filesWithHits} 个文件里`)
  parts.push(`扫过 ${summary.filesScanned} 个文件`)
  parts.push(formatDuration(summary.elapsedMs))
  if (summary.truncated) parts.push('撞到结果条数上限，剩下的没搜——把搜索词写窄一点')
  if (summary.skippedTooLarge > 0) parts.push(`跳过 ${summary.skippedTooLarge} 个过大的文件`)
  return parts.join(' · ')
}

/**
 * 「有东西没读成」那一句。null = 没有。
 *
 * ⚠️ 这是整个面板上**最重要的一句话**：`unreadable > 0` 意味着「没有找到」可能是假的。
 * 不说出来的话用户会得到一个看起来很确定的错答案，然后据此认为代码里没有那个调用。
 * 权限不够、文件在遍历途中被删、外接盘掉线，都会落到这个计数里。
 */
export function unreadableWarning(summary: SearchSummary): string | null {
  if (summary.unreadable <= 0) return null
  return `有 ${summary.unreadable} 个条目读不出来（权限不够、被删或 IO 错误），所以「没有找到」不一定成立`
}

// ───────────────────────── 替换那一半（M2-D） ─────────────────────────

/**
 * 把预览串压成一行。
 *
 * 模板里打 `\n` 是**合法的**（「把这个调用换成两行」），于是 `replaced` 可以含换行。
 * 而结果行是定高的：让它撑开的话 `visibleWindow` 那套 O(1) 窗口算术当场失效
 * （它的全部前提是「每行一样高」），让它溢出的话用户看到半行，
 * 会以为替换只换了一半。显示成 `↵` 是唯一既保住定高、又如实说出「这里有个换行」的办法。
 *
 * ⚠️ 只管 `\n`：`text` 与 `replaced` 都是 Rust 侧 `normalize_to_lf` 之后的产物，
 * 里面不会有孤立的 `\r`
 */
export function oneLine(text: string): string {
  return text.replaceAll('\n', '↵')
}

/** 替换进行中那一句进度。⚠️ 快照里的 `filesScanned` 会**落后**于最终总账，见 `replace.rs` 的 `Sink` */
export function describeReplaceProgress(progress: ReplaceProgress): string {
  return `正在替换… 已改 ${progress.filesChanged} 个文件、${progress.replacements} 处（扫过 ${progress.filesScanned} 个）`
}

/**
 * 一次替换结束时的总账。
 *
 * 与 [`describeSummary`] 同一条分层：**这一行只放中性事实**，凡是会限定这些数字效力的
 * 一律交给 [`replaceWarnings`] 单独成行。理由也一样——「换了 0 处」后面跟一串小字，
 * 用户扫一眼就走了，而那串小字里恰恰藏着「这个 0 可能是假的」。
 *
 * ⚠️ `replacements` 说的是**处**，不是行也不只是文件：一行里可以有多处命中。
 * 报成「换了 3 个文件」的话，用户不知道到底动了多少地方，
 * 而「动了多少地方」正是他决定要不要 `git checkout` 的唯一依据
 */
export function describeReplaceSummary(summary: ReplaceSummary): string {
  const parts: string[] = []
  // 「已取消」放最前面：它限定后面每一个数字，而且必须与 `filesChanged` 一起读。
  // 只说「已取消」的话用户会以为什么都没发生，而实际上已经改完的文件留在磁盘上
  if (summary.cancelled) parts.push('已取消（改动不会回滚）')
  parts.push(
    summary.replacements === 0 ? '一处都没换' : `换了 ${summary.replacements} 处，写进 ${summary.filesChanged} 个文件`,
  )
  parts.push(`扫过 ${summary.filesScanned} 个文件`)
  parts.push(formatDuration(summary.elapsedMs))
  // 这两个是**我们主动决定不改**，属于中性事实，不上警告色：
  // 二进制文件本来就不该被当文本重写，每个带图片的仓库都会跳过一堆
  if (summary.skippedBinary > 0) parts.push(`跳过 ${summary.skippedBinary} 个二进制文件`)
  if (summary.skippedTooLarge > 0) parts.push(`跳过 ${summary.skippedTooLarge} 个过大的文件`)
  if (summary.truncated) {
    // ⚠️ 这一条比搜索那边严重得多：搜索截断的后果是「少看了一些结果」，
    // 替换截断的后果是**仓库现在处于「换了一半」的状态**，而那半个状态没法撤销
    parts.push('撞到上限就停了，仓库现在是「换了一半」的状态——把搜索词写窄一点，剩下的再换一遍')
  }
  return parts.join(' · ')
}

/**
 * 「这份总账得打个折扣」的那些话，每条单独一行。空数组 = 没有任何保留。
 *
 * ⚠️ 顺序是按**严重性**排的，不是按字段声明顺序：前两条说的是「结果可能不完整」，
 * 后面三条说的是「这些文件我们没碰，而且是有理由的」。混在一起排的话
 * 用户读到第三条就已经开始跳读了，而前两条才是他必须看见的
 */
export function replaceWarnings(summary: ReplaceSummary): string[] {
  const out: string[] = []
  // 与其它六个 `skipped*` 不是一类：那些是「我们决定不写」，这一个是「想写而写不成」。
  // 磁盘满、文件只读、权限不够都落在这里，而它们的共同点是**用户以为换成功了**
  if (summary.writeFailed > 0) {
    out.push(`有 ${summary.writeFailed} 个文件没写成（磁盘满、只读或权限不够），它们还是旧内容`)
  }
  // 与 `unreadableWarning` 同一条理由，但更要紧：这里「一处都没换」可能是假的
  if (summary.unreadable > 0) {
    out.push(`有 ${summary.unreadable} 个文件读不出来（权限不够、被删或 IO 错误），所以这份总账不完整`)
  }
  // 这一条用户自己能解决，所以要给出下一步：保存之后再来一遍
  if (summary.skippedOpen > 0) {
    out.push(`有 ${summary.skippedOpen} 个文件正开着且有未保存的改动，被跳过了——保存它们之后再换一遍`)
  }
  if (summary.skippedUnmappable > 0) {
    out.push(`有 ${summary.skippedUnmappable} 个文件的替换结果编不回它自己的编码（例如往 GBK 里换进 emoji），整个跳过`)
  }
  if (summary.skippedLossy > 0) {
    out.push(`有 ${summary.skippedLossy} 个文件解码时就已经有损，跳过——写回去会把替换字符永久焊进文件`)
  }
  return out
}
