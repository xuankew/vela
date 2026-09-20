import { describe, expect, it } from 'vitest'

/**
 * 结果行扁平化与摘要文案。
 *
 * 这一层是纯函数，所以断言可以直接写在具体数字上——不像组件测试那样得先跟 jsdom
 * 「没有布局」这件事缠斗一轮（`clientHeight` 恒为 0，见 `project/Sidebar.test.tsx`）。
 */

import type { ReplaceSummary } from '../ipc/replace'
import type { SearchFile, SearchSummary } from '../ipc/search'
import { OVERSCAN } from '../ui/virtual'
import {
  actionForKey,
  describeProgress,
  describeReplaceProgress,
  describeReplaceSummary,
  describeSummary,
  flattenFiles,
  formatDuration,
  isResultKey,
  oneLine,
  openTarget,
  replaceWarnings,
  RESULT_ROW_HEIGHT,
  resultWindow,
  segmentsOf,
  unreadableWarning,
  type ResultRow,
} from './rows'

/** 与 `src/ipc/search.test.ts` 的黄金 listing 同一批假数据，省得两边各编一套 */
function file(rel: string, lines: number[], truncated = false, replaced?: string, rootIndex = 0): SearchFile {
  return {
    rel,
    path: `/repo/${rel}`,
    // `rootIndex` 在契约上**不是**可选的（见 `ipc/search.ts`）。多根之下
    // 「同一个 rel 来自两个根」全靠它才分得开，而这一层只负责把它交给 `rootOf` 换成名字
    rootIndex,
    truncated,
    hits: lines.map((line) => ({
      line,
      text: `let a = needle; // ${line}`,
      ranges: [{ start: 8, end: 14 }],
      // 只有传了 `replaced` 才带上这个 key：纯搜索时 Rust 侧整个不序列化它
      ...(replaced === undefined ? {} : { replaced }),
      truncated: false,
    })),
  }
}

/** 与 Rust 侧 `搜索结果的线上形状` 里那条黄金 `SearchSummary` 逐字段相同 */
const GOLDEN_SUMMARY: SearchSummary = {
  filesScanned: 120,
  filesWithHits: 3,
  hits: 7,
  skippedTooLarge: 1,
  unreadable: 2,
  truncated: false,
  cancelled: true,
  elapsedMs: 45,
}

describe('flattenFiles', () => {
  it('一个文件摊成「标题行 + 每条命中一行」，标题在前', () => {
    const rows = flattenFiles([file('src/a.ts', [3, 17])])
    expect(rows.map((r) => r.kind)).toEqual(['file', 'hit', 'hit'])
    expect(rows[0]).toEqual({
      kind: 'file',
      rel: 'src/a.ts',
      root: '',
      path: '/repo/src/a.ts',
      hits: 2,
      truncated: false,
      skipped: false,
    })
    expect(rows[1]).toEqual({
      kind: 'hit',
      rel: 'src/a.ts',
      path: '/repo/src/a.ts',
      line: 3,
      text: 'let a = needle; // 3',
      ranges: [{ start: 8, end: 14 }],
      truncated: false,
    })
    // 纯搜索时**没有预览**。⚠️ 上面那条 `toEqual` 看不出来（vitest 忽略 undefined 值的键），
    // 所以单独钉一次：它是「这一行没被预览过」与「预览结果是删光」两个状态的其中一半
    expect(rows[1]?.kind === 'hit' && rows[1].replaced === undefined).toBe(true)
  })

  it('多个文件按顺序摊平，没有父子指针', () => {
    const rows = flattenFiles([file('a.ts', [1]), file('b.ts', [2, 3])])
    expect(rows.map((r) => (r.kind === 'file' ? r.rel : `${r.rel}:${r.line}`))).toEqual([
      'a.ts',
      'a.ts:1',
      'b.ts',
      'b.ts:2',
      'b.ts:3',
    ])
    // 分组只体现在顺序上：命中行自己带着 rel 与 path，不需要回头去找它的标题行。
    // 建父子指针就得算前缀和，而 `visibleWindow` 那套 O(1) 窗口算术的前提是定高扁平行
    for (const row of rows) expect(row.rel).toBeTruthy()
  })

  it('命中为零的文件仍然产出标题行', () => {
    const rows = flattenFiles([file('empty.ts', [])])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'file', rel: 'empty.ts', hits: 0 })
    // Rust 侧现在不推这种文件（`run.rs` 只在 hits 非空时才 push），但契约上没禁止。
    // 漏掉它的话那个文件就在结果里彻底消失了
  })

  it('⚠️ 增量拼接：第二批只摊它自己那几个文件，已有行对象引用不变', () => {
    const first = flattenFiles([file('a.ts', [1])])
    const second = flattenFiles([file('b.ts', [2])])
    const joined = [...first, ...second]
    expect(joined.map((r) => r.rel)).toEqual(['a.ts', 'a.ts', 'b.ts', 'b.ts'])
    // 引用不变是 `<For>` 复用 DOM 的依据：每批到达都从头重摊的话，整个列表会被重建一遍，
    // 而二十个文件一批、一万条命中就是五百批——那是在几秒钟里连着发生五百次的全量重建
    expect(joined[0]).toBe(first[0])
    expect(joined[2]).toBe(second[0])
  })

  it('单文件截断这件事留在标题行上', () => {
    const rows = flattenFiles([file('min.js', [1], true)])
    expect(rows[0]).toMatchObject({ kind: 'file', truncated: true })
  })

  it('替换模式下预览原样搬到行上', () => {
    const rows = flattenFiles([file('src/a.ts', [3], false, 'let a = hay;')])
    const hit = rows[1]
    expect(hit?.kind === 'hit' && hit.replaced).toBe('let a = hay;')
  })

  it('⚠️ 预览是空串时它仍然是「有预览」，不是「纯搜索」', () => {
    const rows = flattenFiles([file('src/a.ts', [3], false, '')])
    const hit = rows[1]
    expect(hit?.kind === 'hit' && hit.replaced).toBe('')
    expect(hit?.kind === 'hit' && hit.replaced === undefined).toBe(false)
    // 空串是「把命中的地方删光」那个合法操作。用真值判断（`if (row.replaced)`）的话
    // 它与「没预览过」合成一个分支，那一行会退回成纯搜索的样子，
    // 而用户以为自己刚刚预览了一次删除
  })

  it('isSkipped 只标它认得的那些文件，而且只落在标题行上', () => {
    const rows = flattenFiles([file('a.ts', [1]), file('b.ts', [2])], (p) => p === '/repo/a.ts')
    expect(rows.map((r) => (r.kind === 'file' ? r.skipped : null))).toEqual([true, null, false, null])
    // 命中行刻意不带这个标志：一个文件的几十条命中共享同一个命运，
    // 在标题上说一次就够，逐行重复等于把「跳过」这件事淹没在噪音里
  })

  it('不传 rootOf 时根名是空串——单根工作区那一行前面什么都不画', () => {
    const rows = flattenFiles([file('src/a.ts', [3])])
    expect(rows[0]).toMatchObject({ kind: 'file', root: '' })
  })

  it('⚠️ rootOf 把 rootIndex 换成显示名，而且只落在标题行上', () => {
    // 命中行上刻意**没有**这个字段：它紧跟在自己的标题行下面，缩进已经说明了归属，
    // 每行再挂一遍项目名会把两屏的命中挤成一屏
    const names = ['vela', 'notes']
    const rows = flattenFiles(
      [file('src/a.ts', [3], false, undefined, 1), file('README.md', [9], false, undefined, 0)],
      undefined,
      (i) => names[i] ?? '',
    )
    expect(rows.filter((r) => r.kind === 'file').map((r) => r.root)).toEqual(['notes', 'vela'])
    expect(rows.filter((r) => r.kind === 'hit')).toHaveLength(2)
  })

  it('不传 isSkipped 时一个都不跳过（纯搜索那条路）', () => {
    const rows = flattenFiles([file('a.ts', [1]), file('b.ts', [2])])
    expect(rows.filter((r) => r.kind === 'file' && r.skipped)).toHaveLength(0)
  })
})

describe('resultWindow', () => {
  it('用的是结果列表自己的行高，不是文件树那个', () => {
    expect(RESULT_ROW_HEIGHT).toBe(20)
    const win = resultWindow(0, 200, 1000)
    expect(win.totalHeight).toBe(1000 * RESULT_ROW_HEIGHT)
    // 200px 的可视区正好 10 行，加上下各 OVERSCAN
    expect(win.end - win.start).toBe(10 + OVERSCAN)
  })

  it('可视区高度为 0 时给出 OVERSCAN 行而不是 0 行', () => {
    // jsdom 里 `clientHeight` 恒为 0，组件测试看到的正是头几行。
    // 这不是给 jsdom 开的后门：面板刚展开的那一帧也是 0，返回 0 行会让它是空白的
    const win = resultWindow(0, 0, 1000)
    expect(win.start).toBe(0)
    expect(win.end).toBe(OVERSCAN)
  })

  it('总行数为 0 时一行都不渲染', () => {
    expect(resultWindow(0, 200, 0)).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 })
  })
})

describe('actionForKey', () => {
  it('空列表上任何键都不做事', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'] as const) {
      expect(actionForKey(0, null, key)).toEqual({ kind: 'none' })
    }
  })

  it('Home / End 落在两端', () => {
    expect(actionForKey(10, 4, 'Home')).toEqual({ kind: 'select', index: 0 })
    expect(actionForKey(10, 4, 'End')).toEqual({ kind: 'select', index: 9 })
  })

  it('上下键夹在列表范围内', () => {
    expect(actionForKey(10, 0, 'ArrowUp')).toEqual({ kind: 'select', index: 0 })
    expect(actionForKey(10, 9, 'ArrowDown')).toEqual({ kind: 'select', index: 9 })
    expect(actionForKey(10, 4, 'ArrowUp')).toEqual({ kind: 'select', index: 3 })
    expect(actionForKey(10, 4, 'ArrowDown')).toEqual({ kind: 'select', index: 5 })
  })

  it('没选中过时上下键都从第一行起步', () => {
    expect(actionForKey(10, null, 'ArrowUp')).toEqual({ kind: 'select', index: 0 })
    expect(actionForKey(10, null, 'ArrowDown')).toEqual({ kind: 'select', index: 0 })
  })

  it('选中的下标越界时当成没选中过', () => {
    // 会发生在「搜索跑着的时候按方向键」：上一轮的下标在这一轮可能已经不存在了
    expect(actionForKey(3, 99, 'ArrowDown')).toEqual({ kind: 'select', index: 0 })
    expect(actionForKey(3, -1, 'ArrowUp')).toEqual({ kind: 'select', index: 0 })
  })

  it('⚠️ Enter 在没选中过时不猜', () => {
    expect(actionForKey(10, null, 'Enter')).toEqual({ kind: 'none' })
    // 一万条结果里随便打开一个文件是净损失：用户按 Enter 是为了去他看着的那一条，
    // 而「他看着的那一条」只有选中状态知道
    expect(actionForKey(10, 4, 'Enter')).toEqual({ kind: 'open', index: 4 })
  })

  it('isResultKey 只认这五个键', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter']) expect(isResultKey(key)).toBe(true)
    // 左右键刻意不在里面：结果列表没有展开/折叠，左右键该由输入框与编辑器自己处理。
    // 拦下来的失败方式是「在面板里按左右键移不动光标」
    for (const key of ['ArrowLeft', 'ArrowRight', 'Escape', 'a', 'Tab']) expect(isResultKey(key)).toBe(false)
  })
})

describe('openTarget', () => {
  const rows: ResultRow[] = flattenFiles([file('a.ts', [1, 2]), file('b.ts', [5]), file('empty.ts', [])])

  it('命中行就是它自己', () => {
    expect(openTarget(rows, 2)).toMatchObject({ kind: 'hit', rel: 'a.ts', line: 2 })
  })

  it('文件行落到它的第一个命中', () => {
    expect(openTarget(rows, 0)).toMatchObject({ kind: 'hit', rel: 'a.ts', line: 1 })
    expect(openTarget(rows, 3)).toMatchObject({ kind: 'hit', rel: 'b.ts', line: 5 })
    // 点分组标题打开那个文件是直觉，而「打开但不跳行」会让用户落在文件开头，
    // 然后自己在几万行里找刚才那一处
  })

  it('一条命中都没有的文件行给出 null', () => {
    expect(openTarget(rows, 5)).toBeNull()
    // 只看下一行就够：扁平化保证文件行后面紧跟的是它自己的命中行，
    // 下一行是别的文件行就说明这个文件没有命中
  })

  it('下标越界给出 null', () => {
    expect(openTarget(rows, 99)).toBeNull()
    expect(openTarget(rows, -1)).toBeNull()
    expect(openTarget([], 0)).toBeNull()
  })

  it('给出的那一行带着跳转要用的全部东西', () => {
    const target = openTarget(rows, 2)
    expect(target).not.toBeNull()
    expect(target?.path).toBe('/repo/a.ts')
    expect(target?.line).toBe(2)
    expect(target?.ranges).toEqual([{ start: 8, end: 14 }])
  })
})

describe('formatDuration', () => {
  it('一秒以内报毫秒', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(45)).toBe('45ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('一秒以上报两位小数的秒', () => {
    expect(formatDuration(1000)).toBe('1.00s')
    expect(formatDuration(6930)).toBe('6.93s')
    // 十万个文件是 6.9s 那个量级，报成「6930ms」要人多算一步；
    // 而本仓库 107 个文件是 12.7ms，报成「0.01s」就把「快得离谱」说糊了
  })
})

describe('describeProgress', () => {
  it('心跳带来的那个累计数就显示在这句里', () => {
    expect(describeProgress(0)).toBe('正在搜索… 已扫过 0 个文件')
    expect(describeProgress(1024)).toBe('正在搜索… 已扫过 1024 个文件')
    // 一个都不命中时，心跳是前端手上唯一的东西。这句话不更新的话，
    // 那 7 秒里用户既看不到进度也看不到「没找到」，看起来就是卡死了
  })
})

describe('describeSummary', () => {
  it('黄金总账落地成一句确定的话', () => {
    expect(describeSummary(GOLDEN_SUMMARY)).toBe(
      '已取消 · 共 7 处，分布在 3 个文件里 · 扫过 120 个文件 · 45ms · 跳过 1 个过大的文件',
    )
  })

  it('一处都没找到时说「没有找到」，而不是「共 0 处」', () => {
    const text = describeSummary({ ...GOLDEN_SUMMARY, hits: 0, filesWithHits: 0, cancelled: false, unreadable: 0 })
    expect(text).toContain('没有找到')
    expect(text).not.toContain('共 0 处')
  })

  it('⚠️「已取消」放在最前面，因为它限定后面每个数字的效力', () => {
    const text = describeSummary(GOLDEN_SUMMARY)
    expect(text.startsWith('已取消')).toBe(true)
    // 那些数字只是取消之前搜到的部分。放在末尾的话用户先读到「共 7 处」，
    // 会当成一次完整搜索的结论
  })

  it('撞到上限时给出出路，而不只是报一个事实', () => {
    const text = describeSummary({ ...GOLDEN_SUMMARY, truncated: true, cancelled: false, unreadable: 0 })
    expect(text).toContain('上限')
    expect(text).toContain('写窄一点')
  })

  it('上限的具体条数不写进文案', () => {
    const text = describeSummary({ ...GOLDEN_SUMMARY, truncated: true })
    expect(text).not.toContain('20000')
    expect(text).not.toContain('20,000')
    // 那个常量住在 Rust 侧（`MAX_HITS`）。前端再抄一份就多一处会漂移的地方，
    // 而漂了也不会报错——文案只是安静地说出一个过期的数字
  })

  it('没有跳过与取消时那两段不出现', () => {
    const text = describeSummary({
      filesScanned: 107,
      filesWithHits: 2,
      hits: 4,
      skippedTooLarge: 0,
      unreadable: 0,
      truncated: false,
      cancelled: false,
      elapsedMs: 13,
    })
    expect(text).toBe('共 4 处，分布在 2 个文件里 · 扫过 107 个文件 · 13ms')
  })

  it('⚠️ 读不出来那一条不在总账里', () => {
    expect(describeSummary(GOLDEN_SUMMARY)).not.toContain('读不出来')
    expect(unreadableWarning(GOLDEN_SUMMARY)).not.toBeNull()
    // 混在一行里的后果是它跟在一串数字后面，用户扫一眼只看到「没有找到」就走了——
    // 而那串数字里恰恰藏着一个「这个 0 可能是假的」。所以它单独一句、单独用警告色
  })
})

describe('unreadableWarning', () => {
  it('一个都没漏时是 null', () => {
    expect(unreadableWarning({ ...GOLDEN_SUMMARY, unreadable: 0 })).toBeNull()
  })

  it('有漏时带上条数，并说清它意味着什么', () => {
    const text = unreadableWarning(GOLDEN_SUMMARY)!
    expect(text).toContain('2 个条目')
    expect(text).toContain('不一定成立')
    // 这是整个面板上最重要的一句话：不说出来的话用户会得到一个看起来很确定的错答案，
    // 然后据此认为代码里没有那个调用
  })

  it('找到东西的时候也照样说', () => {
    expect(unreadableWarning({ ...GOLDEN_SUMMARY, hits: 7, unreadable: 3 })).toContain('3 个条目')
    // 不只是「没找到」才需要这句：漏掉的那个目录里可能有**更**相关的命中，
    // 而用户看到的是一份看起来完整的清单
  })
})

describe('segmentsOf', () => {
  /** 紧凑断言：`let a = needle;` 里 `needle` 那一段是 [8,14) */
  function marks(text: string, ranges: Array<[number, number]>): string {
    return segmentsOf(
      text,
      ranges.map(([start, end]) => ({ start, end })),
    )
      .map((s) => (s.hit ? `[${s.text}]` : s.text))
      .join('')
  }

  it('没有命中段时是一整段普通文本', () => {
    // 空数组渲染出来是一行空白，而这一行是有正文的，只是说不清命中在哪儿
    expect(segmentsOf('let a = needle;', [])).toEqual([{ text: 'let a = needle;', hit: false }])
    expect(segmentsOf('', [])).toEqual([{ text: '', hit: false }])
  })

  it('一段命中切成三段', () => {
    expect(marks('let a = needle;', [[8, 14]])).toBe('let a = [needle];')
  })

  it('命中在行首与行尾时不产生空片段', () => {
    expect(marks('needle = x', [[0, 6]])).toBe('[needle] = x')
    expect(marks('x = needle', [[4, 10]])).toBe('x = [needle]')
    expect(segmentsOf('abc', [{ start: 0, end: 3 }])).toEqual([{ text: 'abc', hit: true }])
  })

  it('多段命中交替切开', () => {
    expect(
      marks('needle and needle', [
        [0, 6],
        [11, 17],
      ]),
    ).toBe('[needle] and [needle]')
  })

  it('⚠️ 拼回去必须等于原字符串', () => {
    const text = 'let 🚀 = needle; // 中文注释'
    // 🚀 占两个 UTF-16 码元，所以 `needle` 从 9 开始而不是 8——偏移量按码元数
    const ranges = [
      { start: 9, end: 15 },
      { start: 20, end: 22 },
    ]
    const joined = segmentsOf(text, ranges)
      .map((s) => s.text)
      .join('')
    // 少一段的失败方式是那行看起来「少了个字」，而它其实只是没被高亮——
    // 用户会以为搜索把正文改了
    expect(joined).toBe(text)
    expect(
      segmentsOf(text, ranges)
        .filter((s) => s.hit)
        .map((s) => s.text),
    ).toEqual(['needle', '中文'])
  })

  it('越界的段截到正文末尾', () => {
    expect(marks('abc', [[1, 99]])).toBe('a[bc]')
    expect(marks('abc', [[99, 120]])).toBe('abc')
  })

  it('零长度与反向的段被跳过', () => {
    expect(marks('abc', [[1, 1]])).toBe('abc')
    expect(marks('abc', [[2, 0]])).toBe('abc')
    expect(
      marks('abcdef', [
        [2, 1],
        [3, 5],
      ]),
    ).toBe('abc[de]f')
  })

  it('重叠的段不会把同一段正文渲染两次', () => {
    // 两个片段紧邻但**没有重复**：正文总共只出现一次。
    // 括号是按片段加的，所以看起来是两对——这正是「拼回去等于原串」要单独钉一条的原因
    expect(
      marks('abcdef', [
        [0, 4],
        [2, 6],
      ]),
    ).toBe('[abcd][ef]')
    expect(
      segmentsOf('abcdef', [
        { start: 0, end: 4 },
        { start: 2, end: 6 },
      ])
        .map((s) => s.text)
        .join(''),
    ).toBe('abcdef')
  })

  it('乱序的段也不会切出负长度', () => {
    // 游标只往前走，所以后面那个「更早」的段整段被吃掉
    expect(
      marks('abcdef', [
        [3, 5],
        [0, 2],
      ]),
    ).toBe('abc[de]f')
    expect(
      segmentsOf('abcdef', [
        { start: 3, end: 5 },
        { start: 0, end: 2 },
      ])
        .map((s) => s.text)
        .join(''),
    ).toBe('abcdef')
  })
})

// ───────────────────────── 替换那一半（M2-D） ─────────────────────────

/** 与 Rust 侧 `替换载荷的线上形状` 的黄金 `ReplaceSummary` 逐字段相同 */
const GOLDEN_REPLACE: ReplaceSummary = {
  filesScanned: 120,
  filesChanged: 3,
  replacements: 7,
  skippedBinary: 1,
  skippedLossy: 2,
  skippedUnmappable: 0,
  skippedTooLarge: 4,
  skippedOpen: 1,
  unreadable: 2,
  writeFailed: 0,
  truncated: false,
  cancelled: true,
  elapsedMs: 45,
}

/** 只改关心的那几个计数器，其余保持黄金值 */
function replace(patch: Partial<ReplaceSummary>): ReplaceSummary {
  return { ...GOLDEN_REPLACE, ...patch }
}

/** 一份**干净**的总账：一处保留都没有 */
const CLEAN: ReplaceSummary = replace({
  cancelled: false,
  skippedBinary: 0,
  skippedLossy: 0,
  skippedTooLarge: 0,
  skippedOpen: 0,
  unreadable: 0,
})

describe('oneLine', () => {
  it('换行显示成 ↵，因为结果行是定高的', () => {
    expect(oneLine('a\nb')).toBe('a↵b')
    expect(oneLine('a\n\nb')).toBe('a↵↵b')
    expect(oneLine('没有换行')).toBe('没有换行')
    // 撑开的话 `visibleWindow` 那套 O(1) 窗口算术当场失效（它的前提是每行一样高），
    // 溢出的话用户看到半行，会以为替换只换了一半
  })
})

describe('describeReplaceProgress', () => {
  it('三个数都在，而且「处」与「文件」分开说', () => {
    expect(describeReplaceProgress({ filesScanned: 12, filesChanged: 3, replacements: 7 })).toBe(
      '正在替换… 已改 3 个文件、7 处（扫过 12 个）',
    )
  })
})

describe('describeReplaceSummary', () => {
  it('干净的那一份：换了几个文件、几处、扫过多少、多久', () => {
    expect(describeReplaceSummary(replace({ ...CLEAN, replacements: 7, filesChanged: 3, filesScanned: 120 }))).toBe(
      '换了 7 处，写进 3 个文件 · 扫过 120 个文件 · 45ms',
    )
  })

  it('⚠️ 处数与文件数不是一回事，两个都得说', () => {
    // 只报文件数的话用户不知道到底动了多少地方，
    // 而「动了多少地方」正是他决定要不要 `git checkout` 的唯一依据
    const text = describeReplaceSummary(replace({ ...CLEAN, replacements: 1, filesChanged: 1 }))
    expect(text).toContain('1 处')
    expect(text).toContain('1 个文件')
  })

  it('一处都没换时不报「0 个文件」', () => {
    expect(describeReplaceSummary(replace({ ...CLEAN, replacements: 0, filesChanged: 0 }))).toContain('一处都没换')
  })

  it('⚠️ 已取消时必须连着说「改动不会回滚」', () => {
    const text = describeReplaceSummary(replace({ cancelled: true, replacements: 7, filesChanged: 3 }))
    expect(text.startsWith('已取消（改动不会回滚）')).toBe(true)
    expect(text).toContain('7 处')
    // 只说「已取消」的话用户会以为什么都没发生，而实际上那 3 个文件已经改完并留在磁盘上。
    // 取消不是撤销，这句话是整条 UI 上最容易被漏掉、后果也最重的一句
  })

  it('二进制与过大是中性事实，写在总账里而不是警告里', () => {
    const text = describeReplaceSummary(replace({ ...CLEAN, skippedBinary: 9, skippedTooLarge: 2 }))
    expect(text).toContain('跳过 9 个二进制文件')
    expect(text).toContain('跳过 2 个过大的文件')
    expect(replaceWarnings(replace({ ...CLEAN, skippedBinary: 9, skippedTooLarge: 2 }))).toEqual([])
    // 每个带图片的仓库都会跳过一堆二进制，把它们染成警告等于让警告色长期亮着，
    // 而长期亮着的警告色等于没有警告色
  })

  it('⚠️ 截断说的是「仓库现在换了一半」，不是「少看了一些」', () => {
    const text = describeReplaceSummary(replace({ ...CLEAN, truncated: true }))
    expect(text).toContain('换了一半')
    expect(text).toContain('写窄')
    // 搜索截断的后果是少看了一些结果；替换截断的后果是仓库停在一个没法撤销的中间状态
  })

  it('耗时口径与搜索那边共用一个函数', () => {
    expect(describeReplaceSummary(replace({ ...CLEAN, elapsedMs: 45 }))).toContain('45ms')
    expect(describeReplaceSummary(replace({ ...CLEAN, elapsedMs: 6930 }))).toContain('6.93s')
  })
})

describe('replaceWarnings', () => {
  it('干净的那一份一条保留都没有', () => {
    expect(replaceWarnings(CLEAN)).toEqual([])
  })

  it('七个计数器里只有五个上警告色，每个都点名是哪个计数器', () => {
    const cases: [Partial<ReplaceSummary>, string][] = [
      [{ writeFailed: 2 }, '没写成'],
      [{ unreadable: 2 }, '读不出来'],
      [{ skippedOpen: 1 }, '未保存的改动'],
      [{ skippedUnmappable: 3 }, '编不回'],
      [{ skippedLossy: 3 }, '有损'],
    ]
    for (const [patch, expected] of cases) {
      const warnings = replaceWarnings(replace({ ...CLEAN, ...patch }))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(expected)
    }
    // `skippedBinary` 与 `skippedTooLarge` 刻意不在这里，理由见上面那条
  })

  it('⚠️ 「没写成」排在最前面：它是唯一一个用户以为成功了的', () => {
    const warnings = replaceWarnings(replace({ ...CLEAN, writeFailed: 1, unreadable: 1, skippedOpen: 1 }))
    expect(warnings[0]).toContain('没写成')
    expect(warnings).toHaveLength(3)
    // 其余四个都会让用户知道「有些文件没被碰到」，只有这一个是静默的：
    // 总账上写着「换了 7 处」，而那 7 处里有一个文件其实没写进去
  })

  it('每条都是单独一行，不并进总账', () => {
    // 这是 `describeReplaceSummary` 与 `replaceWarnings` 分成两个函数的全部理由：
    // 混在一行里的话它跟在一串数字后面，用户扫一眼只看到「换了 7 处」就走了。
    // ⚠️ 从 `CLEAN` 起步而不是黄金那一份：后者自己就带着 skippedOpen 与 skippedLossy，
    // 于是断言测的是「一共几条」而不是「这一条有没有被并进总账」
    const only = replace({ ...CLEAN, unreadable: 2 })
    expect(describeReplaceSummary(only)).not.toContain('读不出来')
    expect(replaceWarnings(only)).toHaveLength(1)
  })

  it('⚠️ 黄金总账那一份同时触发三条，而且顺序稳定', () => {
    const warnings = replaceWarnings(GOLDEN_REPLACE)
    expect(warnings).toHaveLength(3)
    // 顺序是严重性：读不出来（总账不完整）→ 未保存被跳过（用户能自己解决）→ 解码有损
    expect(warnings[0]).toContain('读不出来')
    expect(warnings[1]).toContain('未保存')
    expect(warnings[2]).toContain('有损')
    // `writeFailed` 是 0，所以它不出现；它非零时会排在最前面，见上面那条
  })
})
