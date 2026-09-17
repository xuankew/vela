/**
 * 把「一条命中」翻译成「文档里的一段位置」。
 *
 * 这一层是纯函数，而且**刻意不认识 CodeMirror**：入参是一个只有 `lines` 与 `line(n)`
 * 两样东西的结构类型（CM6 的 `Text` 天然满足）。这么做只有一个理由——能测。
 * 挂在 CM6 上测的话要先造一个真的 `EditorState`，而 jsdom 里那玩意儿既慢又
 * 会把「偏移量算错了」与「CM6 装不起来」两种失败混在一条用例里。
 *
 * ## 偏移量是 UTF-16 码元
 *
 * `MatchRange.start` / `end` 数的是 UTF-16 码元（见 `src/ipc/search.ts`），
 * 而 CM6 的文档位置也是 UTF-16 码元——**同一套单位，所以可以直接相加**。
 * 中间不要过 `Array.from(text)`、`[...text]` 或任何「按字符数」的换算：
 * 那会把含 emoji / CJK 扩展区的行选中位置错开一个字，而且只在那些行上错。
 *
 * ## 两处 clamp 都是在挡真实场景，不是防御性编程
 *
 * - **行号**：搜索结果会过期。搜完之后那个文件被别的进程改了、短了，用户再点结果，
 *   行号就落在文档外面——而 `Text.line(n)` 对越界的 n 是**抛 RangeError** 的。
 *   M2-G 的文件监听落地之后这只会更常见，不是更少见。
 * - **偏移量**：`SearchHit.ranges` 可能是空的，文档里写得很清楚——空不等于「这行没命中」，
 *   而是「命中了但说不清在哪儿」（正文被预览上限截断、或命中段数撞了上限）。
 */

import type { MatchRange } from '../ipc/search'

/** CM6 `Text` 的一个最小结构子集：只用到「一共几行」与「第 n 行从哪到哪」 */
export interface RevealDoc {
  /** 1 起算的行数。CM6 的空文档也有 1 行，所以它永远 ≥ 1 */
  readonly lines: number
  /** `n` 是 **1 起算**的。调用前必须已经 clamp 过，越界会抛 */
  line(n: number): { from: number; to: number }
}

/** 一段可以原样交给 `view.dispatch({ selection })` 的位置 */
export interface RevealTarget {
  anchor: number
  head: number
}

/**
 * 算出「跳到这一条命中」该把光标放哪儿。
 *
 * @param line `SearchHit.line`，1 起算
 * @param ranges `SearchHit.ranges`，可能为空
 *
 * 只取**第一个**命中段：用户点的是结果列表里的一行，那一行的意思就是「这个文件的这一行」，
 * 把这一行里的三处命中一次全选中看着热闹，实际会让人分不清自己点的是哪一处——
 * 而且真要一次改全部那是 M2-D 全局替换的事，不是「跳过去看一眼」的事。
 */
export function revealTarget(doc: RevealDoc, line: number, ranges: readonly MatchRange[]): RevealTarget {
  const at = doc.line(Math.min(Math.max(1, line), doc.lines))
  const length = at.to - at.from

  for (const range of ranges) {
    const start = Math.min(Math.max(0, range.start), length)
    const end = Math.min(Math.max(range.end, start), length)
    // 零长度的段选不出东西，跳过它去找下一个；一个都没有就落到下面那条兜底
    if (end > start) return { anchor: at.from + start, head: at.from + end }
  }

  // 说不清命中在哪儿时把光标放在行首，**不选中整行**：
  // 选中之后用户顺手打一个字就会把整行替换掉，而他并不知道自己选中了什么。
  // 放在行首则什么都不会丢，行号照样是对的，`scrollIntoView` 也照样能把它带到中间
  return { anchor: at.from, head: at.from }
}
