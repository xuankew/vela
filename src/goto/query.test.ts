import { describe, expect, it } from 'vitest'
import { parseGotoQuery } from './query'

describe('parseGotoQuery：四种意图', () => {
  it('空串是文件查询，needle 也是空串——「列出最近打开过的」就是这个形状', () => {
    expect(parseGotoQuery('')).toEqual({ kind: 'file', needle: '' })
  })

  it('普通文字是文件查询', () => {
    expect(parseGotoQuery('store')).toEqual({ kind: 'file', needle: 'store' })
  })

  it(':行号 是跳行', () => {
    expect(parseGotoQuery(':42')).toEqual({ kind: 'line', line: 42 })
    expect(parseGotoQuery(':1')).toEqual({ kind: 'line', line: 1 })
  })

  it('文件:行号 是「打开它并跳到那一行」', () => {
    expect(parseGotoQuery('store.ts:42')).toEqual({ kind: 'fileLine', needle: 'store.ts', line: 42 })
  })

  it('@ 开头是符号表，@ 后面照抄成 needle', () => {
    expect(parseGotoQuery('@安装')).toEqual({ kind: 'symbol', needle: '安装' })
    expect(parseGotoQuery('@')).toEqual({ kind: 'symbol', needle: '' })
  })
})

describe('parseGotoQuery：前缀赢过后缀', () => {
  it('@foo:2 是符号查询，不是「文件 @foo 的第 2 行」', () => {
    // `@` 是用户明确说「我要符号表」的信号。反过来判的话 `@` 开头的标题永远够不到，
    // 而 Markdown 里 `@` 开头的标题不算罕见（`@Deprecated`、`@since v2`）
    expect(parseGotoQuery('@foo:2')).toEqual({ kind: 'symbol', needle: 'foo:2' })
  })

  it(':42 不会被读成「文件 :4 的第 2 行」', () => {
    expect(parseGotoQuery(':42')).toEqual({ kind: 'line', line: 42 })
  })
})

describe('parseGotoQuery：从最后一个冒号切', () => {
  it('Windows 盘符不会被拆开', () => {
    expect(parseGotoQuery('C:\\repo\\a.ts:42')).toEqual({ kind: 'fileLine', needle: 'C:\\repo\\a.ts', line: 42 })
  })

  it('名字里本来就带冒号时，只有尾部那段当行号', () => {
    expect(parseGotoQuery('a:b.ts:7')).toEqual({ kind: 'fileLine', needle: 'a:b.ts', line: 7 })
  })

  it('尾部的 行:列 会被读成「文件 file.ts:12 的第 3 行」——已知误判，失败方式是列表空着', () => {
    // 列跳转不在 v1 的范围里（`EditorController.reveal` 收的是位置，没有列的概念）。
    // 这条用例不是「期望的行为很好」，而是把误判的**具体形状**钉住：
    // 万一以后真加了列跳转，这条会红，那时才该改文法
    expect(parseGotoQuery('file.ts:12:3')).toEqual({ kind: 'fileLine', needle: 'file.ts:12', line: 3 })
  })
})

describe('parseGotoQuery：不像行号的一律落回文件查询', () => {
  const cases: string[] = [
    ':0', // 1 起算的行号里没有第 0 行
    ':007', // 前导零
    ':-1',
    ':1.5',
    ':12a',
    ':', // 光一个冒号
    ': ',
    'store.ts:', // 尾随冒号，needle 该是原文而不是被截断的 'store.ts'
    'store.ts:x',
  ]

  it.each(cases)('%s 是文件查询，needle 一字不改', (raw) => {
    expect(parseGotoQuery(raw)).toEqual({ kind: 'file', needle: raw })
  })

  it('报错比空列表更难查，所以这里刻意不抛', () => {
    expect(() => parseGotoQuery(':abc')).not.toThrow()
  })
})

describe('parseGotoQuery：一个字符都不 trim', () => {
  it('首尾空格原样留在 needle 里', () => {
    // 文件名里可以有空格（`My Notes.md` 在 macOS 上极常见），而「用户多打了一个空格」
    // 与「用户要找名字以空格结尾的文件」在这一格输入框里区分不出来。
    // 宁可让前者少命中几条——他删掉空格就好——也不要让后者永远搜不到
    expect(parseGotoQuery('My Notes ')).toEqual({ kind: 'file', needle: 'My Notes ' })
    expect(parseGotoQuery(' My Notes.md')).toEqual({ kind: 'file', needle: ' My Notes.md' })
  })

  it('空格不算「开头就是冒号」，于是 `  :42` 走的是文件那条路', () => {
    // 判前缀用的是 `startsWith(':')`，前面有空格就不算。needle 因此是那两个空格——
    // 一个几乎匹配一切的文件查询，列表看着正常，只是没人找得到东西。
    // 这不是理想行为，但它是「不 trim」这条规矩的直接后果，而且是**看得见**的后果
    expect(parseGotoQuery('  :42')).toEqual({ kind: 'fileLine', needle: '  ', line: 42 })
  })

  it('@ 后面的空格也原样留着——标题里的空格是内容', () => {
    expect(parseGotoQuery('@ 安装 ')).toEqual({ kind: 'symbol', needle: ' 安装 ' })
  })
})

describe('parseGotoQuery：行号的数字边界', () => {
  it('长得离谱的行号不抛也不截断，交给 revealTarget 去夹', () => {
    // `reveal.ts` 里那道 `Math.min(Math.max(1, line), doc.lines)` 是**已经在的**钳位，
    // 而且它挡的正是「搜索结果过期了」这个真实场景。这里再夹一遍就是第二份会漂的抄写
    const huge = parseGotoQuery(':99999999999999999999')
    expect(huge.kind).toBe('line')
    if (huge.kind === 'line') expect(Number.isFinite(huge.line)).toBe(true)
  })

  it('多位行号读成十进制', () => {
    expect(parseGotoQuery(':1000')).toEqual({ kind: 'line', line: 1000 })
  })
})
