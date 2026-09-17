import { describe, expect, it } from 'vitest'
import type { MatchRange } from '../ipc/search'
import { revealTarget, type RevealDoc } from './reveal'

/**
 * `revealTarget` 的单测。
 *
 * 假的文档只有 `lines` 与 `line(n)` 两样东西——这正是 `reveal.ts` 只肯要的全部。
 * ⚠️ 越界的 `n` 会**抛**，与 CM6 `Text.line()` 的行为一致：这条不是照着实现抄的，
 * 是下面那条「不 clamp 就真的会炸」的用例的前提。桩要是宽松地返回个空行，
 * 那条用例就变成自己证明自己，而生产代码里的 clamp 也就永远看不出为什么非有不可。
 */
function docOf(lines: string[]): RevealDoc {
  const starts: number[] = []
  let at = 0
  for (const text of lines) {
    starts.push(at)
    // +1 是那个换行符：CM6 的 `line.to` 不含行终止符，而下一行的 `from` 要跳过它
    at += text.length + 1
  }
  return {
    lines: lines.length,
    line(n) {
      const from = starts[n - 1]
      const text = lines[n - 1]
      if (from === undefined || text === undefined) throw new RangeError(`文档里没有第 ${n} 行`)
      return { from, to: from + text.length }
    },
  }
}

const DOC = docOf(['first line', 'let a = needle;', 'last'])

describe('命中段落到文档位置上', () => {
  it('偏移量加上行首就是文档位置', () => {
    const line = DOC.line(2)
    const target = revealTarget(DOC, 2, [{ start: 8, end: 14 }])
    expect(target).toEqual({ anchor: line.from + 8, head: line.from + 14 })
    expect('let a = needle;'.slice(target.anchor - line.from, target.head - line.from)).toBe('needle')
  })

  it('第一行的行首是 0，不是 1', () => {
    // 差一的话每一次跳转都会往右错一个字，而第 1 行永远看不出来——所以单独钉一下
    expect(revealTarget(DOC, 1, [{ start: 0, end: 5 }])).toEqual({ anchor: 0, head: 5 })
  })

  it('多个命中段只取第一个', () => {
    const doc = docOf(['needle and needle'])
    const target = revealTarget(doc, 1, [
      { start: 0, end: 6 },
      { start: 11, end: 17 },
    ])
    expect(target).toEqual({ anchor: 0, head: 6 })
  })

  it('零长度的段被跳过，用后面那个', () => {
    const target = revealTarget(DOC, 2, [
      { start: 8, end: 8 },
      { start: 8, end: 14 },
    ])
    expect(target).toEqual({ anchor: DOC.line(2).from + 8, head: DOC.line(2).from + 14 })
  })

  it('一个能用的段都没有时落到行首，而不是选中整行', () => {
    const at = DOC.line(2).from
    // `ranges` 为空不等于「这行没命中」，而是「命中了但说不清在哪儿」——
    // 正文被预览上限截断、或命中段数撞了上限时会这样
    expect(revealTarget(DOC, 2, [])).toEqual({ anchor: at, head: at })
    expect(revealTarget(DOC, 2, [{ start: 5, end: 5 }])).toEqual({ anchor: at, head: at })
    // 选中整行的话，用户顺手打一个字就把整行替换掉了，而他并不知道自己选中了什么
  })

  it('畸形（end 在 start 前面）的段当成不可用，落到行首兜底', () => {
    const at = DOC.line(2).from
    const target = revealTarget(DOC, 2, [{ start: 10, end: 3 }])
    // 规范化之后它是零长度的，零长度选不出东西 → 跳过 → 没有别的段可用 → 行首。
    // 关键不是落在哪儿，而是 **head 永远不会跑到 anchor 前面**：那种选区交给
    // `view.dispatch` 会得到一个方向反了的选区，按左键与按右键的行为互换
    expect(target.head).toBeGreaterThanOrEqual(target.anchor)
    expect(target).toEqual({ anchor: at, head: at })
  })
})

describe('两处 clamp', () => {
  it('行号超出文档就落到最后一行', () => {
    // 搜索结果会过期：搜完之后那个文件被别的进程改短了，用户再点结果就是这个局面
    const target = revealTarget(DOC, 99, [{ start: 0, end: 4 }])
    expect(target).toEqual({ anchor: DOC.line(3).from, head: DOC.line(3).from + 4 })
  })

  it('行号是 0 或负数就落到第一行', () => {
    expect(revealTarget(DOC, 0, [])).toEqual({ anchor: 0, head: 0 })
    expect(revealTarget(DOC, -3, [])).toEqual({ anchor: 0, head: 0 })
  })

  it('偏移量越过行长就截到行尾', () => {
    const line = DOC.line(2)
    const target = revealTarget(DOC, 2, [{ start: 8, end: 9999 }])
    expect(target).toEqual({ anchor: line.from + 8, head: line.to })
  })

  it('⚠️ 不 clamp 的话 CM6 会直接抛——这条钉住上面那几条不是多余的', () => {
    expect(() => DOC.line(99)).toThrow(RangeError)
    // 而 revealTarget 面对同一个行号是**给答案**的，不是把异常往上抛给点击处理函数
    expect(() => revealTarget(DOC, 99, [])).not.toThrow()
  })
})

describe('偏移量的单位是 UTF-16 码元', () => {
  const text = 'let 🚀 = needle'
  const doc = docOf([text])

  it('直接相加就对了，中间不需要任何换算', () => {
    const units = text.indexOf('needle')
    const target = revealTarget(doc, 1, [{ start: units, end: units + 'needle'.length }])
    expect(text.slice(target.anchor, target.head)).toBe('needle')
  })

  it('⚠️ 按码点数算就错开了，而且只在这种行上错', () => {
    const units = text.indexOf('needle')
    // 前缀里那个 🚀 占两个 UTF-16 码元、但只算一个码点，所以两套单位在这儿确实不一样
    const points = [...text.slice(0, units)].length
    expect(points).not.toBe(units)

    const wrong = revealTarget(doc, 1, [{ start: points, end: points + 'needle'.length }])
    expect(text.slice(wrong.anchor, wrong.head)).not.toBe('needle')
  })

  it('中日韩文字在 BMP 里，两套单位恰好相同——所以错开只在含 emoji 的行上出现', () => {
    const cjk = 'let 中文 = needle'
    const at = cjk.indexOf('needle')
    expect([...cjk.slice(0, at)].length).toBe(at)
    expect(cjk.slice(revealTarget(docOf([cjk]), 1, [{ start: at, end: at + 6 }]).anchor)).toBe('needle')
  })

  it('空文档的唯一一行也能跳', () => {
    const empty = docOf([''])
    expect(empty.lines).toBe(1)
    expect(revealTarget(empty, 1, [{ start: 0, end: 3 }])).toEqual({ anchor: 0, head: 0 })
    expect(revealTarget(empty, 1, [])).toEqual({ anchor: 0, head: 0 })
  })
})

/** 类型层面的自检：CM6 的 `Text` 必须能原样塞进 `RevealDoc`，否则接线那一层要写转换 */
describe('接口形状', () => {
  it('只要求 lines 与 line(n)，多余的能力一律不要', () => {
    const ranges: MatchRange[] = [{ start: 0, end: 1 }]
    const minimal: RevealDoc = { lines: 1, line: () => ({ from: 0, to: 1 }) }
    expect(revealTarget(minimal, 1, ranges)).toEqual({ anchor: 0, head: 1 })
    // 真的 CM6 Text 还带着 length / sliceString / iter 等等一大堆，
    // 但它们一个都没被用到——所以这一层可以在没有 CM6 的环境里测。
    // 经由一个不带标注的中间变量赋值：直接写在字面量上会被 TS 的多余属性检查拦下来，
    // 而「结构上多几样也能用」正是要说明的那件事
    const withExtras = {
      lines: 2,
      line: (n: number) => (n === 1 ? { from: 0, to: 3 } : { from: 4, to: 9 }),
      length: 9,
    }
    const richer: RevealDoc = withExtras
    expect(revealTarget(richer, 2, [{ start: 1, end: 2 }])).toEqual({ anchor: 5, head: 6 })
  })
})
