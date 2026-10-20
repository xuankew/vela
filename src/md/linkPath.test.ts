import { describe, expect, it } from 'vitest'
import { linkNeedle, linkTarget, linkTargets } from './linkPath'

/**
 * 链接目标是**插进正文的一段文本**，写错了不会有异常、不会有红点，只会有一条点了没反应的链接。
 * 所以这一份用例钉的全是「用户看得见的那一串字符」，一条都不放过编码与爬升层数。
 *
 * ⚠️ 跑在 node 环境里：这一层是纯字符串运算，既不认识 CM6 也不认识 Tauri
 * （与 `paste.test.ts` 同一条口径）。
 */

describe('linkTarget：基准是文档所在目录', () => {
  it('同目录下就是文件名本身，不带 ./ 前缀', () => {
    expect(linkTarget('/repo/doc/a.md', '/repo/doc/b.md')).toBe('b.md')
  })

  it('子目录直接往下写', () => {
    expect(linkTarget('/repo/a.md', '/repo/notes/b.md')).toBe('notes/b.md')
  })

  it('隔壁目录要爬一层', () => {
    expect(linkTarget('/repo/doc/a.md', '/repo/img/b.png')).toBe('../img/b.png')
  })

  it('爬升层数按公共前缀算，不多不少', () => {
    expect(linkTarget('/repo/x/y/z/a.md', '/repo/b.md')).toBe('../../../b.md')
    expect(linkTarget('/repo/x/y/z/a.md', '/repo/x/b.md')).toBe('../../b.md')
  })

  it('文档就长在根目录下时也能算', () => {
    // '/x.md'.split('/') 是 ['', 'x.md']，所在目录只有那个空段，于是爬升零层
    expect(linkTarget('/a.md', '/notes/b.md')).toBe('notes/b.md')
  })

  it('Windows 风格的路径也认，而结果一律用 / 分隔', () => {
    expect(linkTarget('C:\\repo\\doc\\a.md', 'C:\\repo\\img\\b.png')).toBe('../img/b.png')
  })

  it('🔴 名字前缀相同但目录不同的两个文件不会被误当成公共前缀', () => {
    // `/repo/notes` 与 `/repo/notes-old` 的字符串前缀是包含关系，按段比才分得开
    expect(linkTarget('/repo/notes/a.md', '/repo/notes-old/b.md')).toBe('../notes-old/b.md')
  })
})

describe('linkTarget：编码', () => {
  it('空格编成 %20 —— 未编码的空格会让 CommonMark 把后半截当成标题', () => {
    expect(linkTarget('/repo/a.md', '/repo/My Notes.md')).toBe('My%20Notes.md')
  })

  it('括号编成 %28/%29 —— 未编码的右括号会提前结束链接目标', () => {
    expect(linkTarget('/repo/a.md', '/repo/f(x).md')).toBe('f%28x%29.md')
  })

  it('# 与 ? 也编：否则渲染器把它们后面那段当片段与查询', () => {
    expect(linkTarget('/repo/a.md', '/repo/a#1.md')).toBe('a%231.md')
    expect(linkTarget('/repo/a.md', '/repo/a?x.md')).toBe('a%3Fx.md')
  })

  it('% 自己也编，于是一个真叫 100%.md 的文件不会与已编码过的目标混淆', () => {
    expect(linkTarget('/repo/a.md', '/repo/100%.md')).toBe('100%25.md')
  })

  it('< 与 > 编掉：它们是链接目标的另一种定界符', () => {
    expect(linkTarget('/repo/a.md', '/repo/<x>.md')).toBe('%3Cx%3E.md')
  })

  it('⛔ 中文原样留着，不做百分号编码', () => {
    expect(linkTarget('/repo/a.md', '/repo/第一章.md')).toBe('第一章.md')
    expect(linkTarget('/repo/a.md', '/repo/笔记/第一章 草稿.md')).toBe('笔记/第一章%20草稿.md')
  })

  it('🔴 目标长得像 URL 方案时补 ./，否则它会被读成外部链接', () => {
    // macOS 允许文件名里带冒号（Finder 里显示成 /），所以磁盘上真可能有这种文件。
    // 失败方式是静默的：链接点得动，只是去了别的地方
    expect(linkTarget('/repo/a.md', '/repo/mailto:x.md')).toBe('./mailto:x.md')
    expect(linkTarget('/repo/a.md', '/repo/HTTP:x')).toBe('./HTTP:x')
  })

  it('只在**开头**像方案时才补 ./，路径中间的冒号不动', () => {
    expect(linkTarget('/repo/a.md', '/repo/notes/mailto:x.md')).toBe('notes/mailto:x.md')
  })
})

describe('linkTarget：不出候选的三种情况', () => {
  it('文档还没存过时回 null —— 未命名草稿没有基准可推', () => {
    expect(linkTarget(null, '/repo/a.md')).toBeNull()
  })

  it('目标就是文档自己时回 null —— 链到自己没有意义', () => {
    expect(linkTarget('/repo/a.md', '/repo/a.md')).toBeNull()
  })

  it('一个绝对一个相对时回 null，而不是硬算出一串指向谁的 ../', () => {
    expect(linkTarget('/repo/a.md', 'notes/b.md')).toBeNull()
    expect(linkTarget('a.md', '/repo/b.md')).toBeNull()
  })

  it('🔴 与文档同名的**文件**仍然算得出目标，不会退化成空的 `]()`', () => {
    // 钉的是公共前缀那个循环里 `i < to.length - 1` 那半条：目标自己的文件名不参与比对，
    // 所以 `/a/b`（一个没有扩展名的文件）链出来是 `b`，而不是「零层爬升 + 空尾巴」
    expect(linkTarget('/a/b.md', '/a/b')).toBe('b')
  })
})

describe('linkNeedle：已经打出来的目标文字 → 拿去查索引的关键词', () => {
  it('剥掉开头的 ./ 与 ../，可以连着好几段', () => {
    expect(linkNeedle('../img/a')).toBe('img/a')
    expect(linkNeedle('../../a')).toBe('a')
    expect(linkNeedle('./a')).toBe('a')
    expect(linkNeedle('../../../img/')).toBe('img/')
  })

  it('没有相对前缀时原样不动——模糊匹配的关键词就是它自己', () => {
    expect(linkNeedle('img/a')).toBe('img/a')
    expect(linkNeedle('')).toBe('')
  })

  /*
   * 🔴 这两条钉的是「正打到一半」那个瞬间：`..` 后面那个 `/` 还没出来时，
   * 前缀正则不认它（不认是对的，见下一条），可拿去查索引又必然一个都匹配不上。
   * 按空处理，于是浮层给出最近打开的那批文件，而不是在用户打到第三个字符时突然空掉。
   */
  it('只打了 . 或 .. 时按「什么都没打」处理', () => {
    expect(linkNeedle('..')).toBe('')
    expect(linkNeedle('.')).toBe('')
    expect(linkNeedle('../')).toBe('')
  })

  it('Windows 风格的反斜杠一样剥', () => {
    expect(linkNeedle('..\\img\\a')).toBe('img\\a')
  })

  it('⛔ 不咬掉真的以点开头的目录名', () => {
    // 前缀必须**带分隔符**才算一段，否则 `.github/x` 会被啃成 `github/x`
    expect(linkNeedle('..hidden/x')).toBe('..hidden/x')
    expect(linkNeedle('.github/workflows')).toBe('.github/workflows')
    // 路径中间的 `..` 更不该动
    expect(linkNeedle('a..b')).toBe('a..b')
  })
})

describe('linkTargets：一批候选 → 一批可插入的目标', () => {
  it('逐个相对化，顺序原样保留（query_project 已经按分数排好了）', () => {
    expect(linkTargets('/repo/doc/a.md', ['/repo/doc/b.md', '/repo/img/c.png', '/repo/doc/d.md'])).toEqual([
      'b.md',
      '../img/c.png',
      'd.md',
    ])
  })

  it('算不出目标的那些直接掉出去，⛔ 不退化成绝对路径', () => {
    // 文档自己 + 一个绝对一个相对的混搭，两种都在 linkTarget 里回 null
    expect(linkTargets('/repo/a.md', ['/repo/a.md', 'notes/b.md', '/repo/c.md'])).toEqual(['c.md'])
  })

  it('文档还没存过时一条都不给：未命名草稿没有基准可推', () => {
    expect(linkTargets(null, ['/repo/a.md', '/repo/b.md'])).toEqual([])
  })

  it('空候选进来就是空候选出去', () => {
    expect(linkTargets('/repo/a.md', [])).toEqual([])
  })
})
