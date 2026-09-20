/**
 * `src/doc/stats.ts` 的用例（M3-A-6）。node 环境——这一层是纯函数，不碰 DOM 也不碰 CM6。
 *
 * 分四组：**口径**（中文逐字符、西文逐词，两个数不许混）、**边界**（全角空格、代理对、
 * 只有标点、非拉丁字母）、**阅读时长**（那两个速度常量真的是被用上了的）、以及**那句话**。
 *
 * ⚠️ 最后两组刻意用 `repeat` 造长文而不是手打：阅读时长的算术只有在跨过一分钟的
 * 整数倍时才验得出来，而「300 个中文字」这种东西手写进用例里是没法读的
 */

import { describe, expect, it } from 'vitest'
import { CJK_CHARS_PER_MINUTE, describeStats, LATIN_WORDS_PER_MINUTE, textStats, type TextStats } from './stats'

describe('textStats：中文逐字符、西文逐词', () => {
  it('纯中文：每个汉字算一个字', () => {
    expect(textStats('你好世界')).toMatchObject({ cjk: 4, words: 0, count: 4 })
  })

  it('纯西文：每个词算一个字，而不是每个字母', () => {
    // 🔴 这一条钉的是「按字符数英文」那种错法：`hello world` 是 11 个字符，
    // 混了口径的话这里会报出 11 字，而一篇 800 词的英文稿子会报出五千多
    expect(textStats('hello world')).toMatchObject({ cjk: 0, words: 2, count: 2 })
  })

  it('中英混排：两边各按自己的口径，字数是两者之和', () => {
    const stats = textStats('Vela 是一个编辑器')
    expect(stats.cjk).toBe(6)
    expect(stats.words).toBe(1)
    expect(stats.count).toBe(7)
  })

  it('中文里没有空格分词，所以整句是一个「字符流」而不是一个词', () => {
    // 🔴 这一条钉的是另一种错法：按词数中文的话，一整段没有空格的中文会报出 1 字
    const stats = textStats('这是一段没有空格的中文')
    expect(stats.words).toBe(0)
    expect(stats.cjk).toBe(11)
  })

  it('连字符、撇号、下划线不打断一个词', () => {
    expect(textStats("don't well-known snake_case").words).toBe(3)
  })

  it('数字算词的一部分，而单独的一串数字算一个词', () => {
    expect(textStats('2026 年 9 月').words).toBe(2)
    expect(textStats('v1 v2 rc-1').words).toBe(3)
  })

  it('`chars` 是含空白与换行的长度，口径与状态栏那个「N 字符」一致', () => {
    expect(textStats('a b\nc').chars).toBe(5)
    expect(textStats('').chars).toBe(0)
  })
})

describe('textStats：边界', () => {
  it('中文标点算字数，而全角空格不算', () => {
    // U+3000 刻意排在 CJK 那一段之外（`stats.ts` 的 `CJK_RE` 从 `3001` 起）：
    // 一份用全角空格缩进的稿子不该凭空多出一堆「字」
    expect(textStats('你好，世界。').cjk).toBe(6)
    expect(textStats('\u3000\u3000').cjk).toBe(0)
    expect(textStats('\u3000\u3000').count).toBe(0)
  })

  it('日文假名与韩文谚文同样逐字符', () => {
    expect(textStats('こんにちは').cjk).toBe(5)
    expect(textStats('안녕하세요').cjk).toBe(5)
  })

  it('扩展 B 的代理对算一个字，但 `chars` 里它占两个码元', () => {
    // 𠀀 = U+20000。⛔ 没有 `u` 标志的话 `CJK_RE` 会把它当成两个孤立代理，一个字数成两个，
    // 而 `chars` 那个数**就是**两个——两个数不一样是对的，各自的口径都写在了 `stats.ts` 上
    const stats = textStats('𠀀')
    expect(stats.cjk).toBe(1)
    expect(stats.chars).toBe(2)
  })

  it('非拉丁的拼音文字也按词数，不会报出 0', () => {
    expect(textStats('привет мир').words).toBe(2)
    expect(textStats('αβγ δεζ').words).toBe(2)
  })

  it('只有西文标点与空白时，字数是 0——那份文档确实没字可读', () => {
    expect(textStats(' \n\t... --- !!! ')).toMatchObject({ cjk: 0, words: 0, count: 0 })
  })

  it('空文档全是 0', () => {
    expect(textStats('')).toEqual({ cjk: 0, words: 0, count: 0, chars: 0, minutes: 0 })
  })

  it('代码也算得出数来：它不判语言，判语言是调用点的事', () => {
    // ⚠️ 这不是说「给代码报字数是有用的」，而是钉住这一层**不认识**语言：
    // 判「该不该问字数」是 `App.tsx` 那个 hook 的活儿，混进纯函数里就没法穷举了
    const stats = textStats('const x = 1\nfunction f() {}\n')
    expect(stats.words).toBeGreaterThan(0)
    expect(stats.cjk).toBe(0)
  })

  it('连着调两次得到同一个结果（模块级正则的 `lastIndex` 没有漏出来）', () => {
    const source = '中文 and English 混排'
    expect(textStats(source)).toEqual(textStats(source))
  })
})

describe('textStats：阅读时长', () => {
  it('两个速度常量是文档里写着的那两个口径', () => {
    expect(CJK_CHARS_PER_MINUTE).toBe(300)
    expect(LATIN_WORDS_PER_MINUTE).toBe(200)
  })

  it('空文档是 0 分钟，而不是「约 1 分钟」', () => {
    expect(textStats('').minutes).toBe(0)
    expect(textStats('   \n  ').minutes).toBe(0)
  })

  it('数得出字就至少一分钟', () => {
    expect(textStats('你').minutes).toBe(1)
    expect(textStats('hi').minutes).toBe(1)
  })

  it('中文按 300 字/分钟向上取整', () => {
    expect(textStats('字'.repeat(CJK_CHARS_PER_MINUTE)).minutes).toBe(1)
    expect(textStats('字'.repeat(CJK_CHARS_PER_MINUTE + 1)).minutes).toBe(2)
    expect(textStats('字'.repeat(CJK_CHARS_PER_MINUTE * 3)).minutes).toBe(3)
  })

  it('西文按 200 词/分钟向上取整', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
    expect(textStats(words(LATIN_WORDS_PER_MINUTE)).minutes).toBe(1)
    expect(textStats(words(LATIN_WORDS_PER_MINUTE + 1)).minutes).toBe(2)
  })

  it('混排是两边各按自己的速度算完再相加，不是取其中一边', () => {
    // 300 个中文字 = 1 分钟，100 个西文词 = 0.5 分钟，合计 1.5 → 向上取整 2。
    // 🔴 只算中文会得到 1，只算西文会得到 1，两个错法都过不了这一条
    const stats = textStats(`${'字'.repeat(300)} ${Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')}`)
    expect(stats).toMatchObject({ cjk: 300, words: 100, minutes: 2 })
  })
})

describe('describeStats：说成人话', () => {
  /** 只为了少写几行：造一份统计结果，不用先造源文本 */
  function stats(partial: Partial<TextStats>): TextStats {
    const cjk = partial.cjk ?? 0
    const words = partial.words ?? 0
    return { cjk, words, count: cjk + words, chars: partial.chars ?? cjk + words, minutes: partial.minutes ?? 1 }
  }

  it('空文档说「没有可数的字」，而不是「0 字 · 约 0 分钟」', () => {
    expect(describeStats(stats({ minutes: 0 }))).toBe('这份文档里没有可数的字')
  })

  it('纯中文不摆明细：一句「西文 0 词」是纯噪音', () => {
    expect(describeStats(stats({ cjk: 1234, minutes: 5 }))).toBe('1234 字 · 约 5 分钟读完')
  })

  it('纯西文同样不摆明细', () => {
    expect(describeStats(stats({ words: 800, minutes: 4 }))).toBe('800 字 · 约 4 分钟读完')
  })

  it('混排要把明细摆出来，否则那个总数读起来像是字符数', () => {
    expect(describeStats(stats({ cjk: 1000, words: 234, minutes: 5 }))).toBe(
      '1234 字（中文 1000 · 西文 234 词） · 约 5 分钟读完',
    )
  })

  it('⛔ 不加千分位分隔符：那个分组跟着运行环境的 locale 走，本机与 CI 会不一样', () => {
    const text = describeStats(stats({ cjk: 1234567, minutes: 4116 }))
    expect(text).toContain('1234567 字')
    expect(text).not.toContain(',')
  })

  it('它是从 textStats 直接接得上的', () => {
    expect(describeStats(textStats('你好世界'))).toBe('4 字 · 约 1 分钟读完')
  })
})
