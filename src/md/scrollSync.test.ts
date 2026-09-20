// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { renderMarkdown } from './render'
import { anchorTable, atBottom, collectAnchors, fractionalLine, topForLine, type LineAnchor } from './scrollSync'

/** 灌一份**真的**渲染结果进 jsdom。假 DOM 只能证明「我以为的形状」，而这一层的重复行恰恰来自真形状 */
function dom(source: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(markdownLanguage.parser.parse(source), source)
  return host
}

describe('anchorTable', () => {
  it('空输入回空表', () => {
    expect(anchorTable([])).toEqual([])
  })

  it('读不出行号的那几条被丢掉，而不是把整张表带歪', () => {
    // 🔴 留着 NaN 的话 `sort` 的比较器会回 NaN，而 `Array.prototype.sort` 对 NaN 的
    // 处理是**未定义顺序**——表看起来还在，插值出来的位置全错，而且不报错
    expect(
      anchorTable([
        ['abc', 10],
        ['', 20],
        ['3', 30],
        ['x1', 40],
      ]),
    ).toEqual([{ line: 3, top: 30 }])
  })

  it('top 不是有限数的那几条也丢掉', () => {
    // jsdom 里量不到布局时 `getBoundingClientRect().top` 是 0，那是**有限**的，走不到这一支；
    // 这一支挡的是 `Infinity` / `NaN`——`fractionalLine` 除零的产物，
    // 混进表里会让 `topForLine` 插出 NaN，而 `scrollTop = NaN` 在浏览器里是静默空操作
    expect(
      anchorTable([
        ['1', Number.POSITIVE_INFINITY],
        ['2', Number.NaN],
        ['3', 30],
      ]),
    ).toEqual([{ line: 3, top: 30 }])
  })

  it('同一行只留 top 最小的那一个，与输入顺序无关', () => {
    // `<blockquote data-line="3">` 里那个 `<p data-line="3">` 报的是同一行，
    // 而外层那个 top 更小 = 这一行真正开始的地方。留内层的话预览会比编辑器低一段
    expect(
      anchorTable([
        ['3', 88],
        ['1', 0],
        ['3', 80],
        ['2', 40],
        ['3', 95],
      ]),
    ).toEqual([
      { line: 1, top: 0 },
      { line: 2, top: 40 },
      { line: 3, top: 80 },
    ])
  })

  it('输入是乱的也照样排好——插值要求 x 单调，不满足就是静默算错', () => {
    expect(
      anchorTable([
        ['9', 90],
        ['2', 20],
        ['5', 50],
      ]),
    ).toEqual([
      { line: 2, top: 20 },
      { line: 5, top: 50 },
      { line: 9, top: 90 },
    ])
  })

  it('行号带前导空白与正负号也能读出来', () => {
    // `Number.parseInt` 的宽容是白捡的，钉住它是为了防止哪天换成 `Number(...)`：
    // `Number(' 12 ')` 一样是 12，但 `Number('12px')` 是 NaN 而 parseInt 是 12——
    // 渲染器不会写 `12px`，可「不会」是靠 render.test.ts 钉的，不是靠这里假设的
    expect(
      anchorTable([
        [' 12', 120],
        ['+7', 70],
      ]),
    ).toEqual([
      { line: 7, top: 70 },
      { line: 12, top: 120 },
    ])
  })
})

describe('collectAnchors', () => {
  it('从真的渲染结果里把 data-line 全捞出来，topOf 由调用方给', () => {
    const host = dom('# 甲\n\n正文。\n')
    // jsdom 量不到布局，所以按标签名发一份假的像素：h1 在 0，p 在 100
    const tops = new Map<string, number>([
      ['H1', 0],
      ['P', 100],
    ])
    expect(collectAnchors(host, (el) => tops.get(el.tagName) ?? -1)).toEqual([
      { line: 1, top: 0 },
      { line: 3, top: 100 },
    ])
  })

  it('引用块那一行只留外层，因为内层的 p 报的是同一个行号', () => {
    const host = dom('> 引用一句\n')
    const withLine = [...host.querySelectorAll('[data-line]')]
    // 先确认前提：真有两条同一行的，否则这条用例会绿得毫无意义
    expect(withLine.length).toBeGreaterThan(1)
    expect(new Set(withLine.map((el) => el.getAttribute('data-line'))).size).toBe(1)
    // 外层 top 小、内层 top 大：blockquote 的边框与内边距把 p 推下去了
    const table = collectAnchors(host, (el) => (el.tagName === 'BLOCKQUOTE' ? 40 : 44))
    expect(table).toEqual([{ line: 1, top: 40 }])
  })

  it('data-line 是空串的元素被跳过', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p data-line="">坏的一条</p><p data-line="5">好的一条</p>'
    expect(collectAnchors(host, () => 0)).toEqual([{ line: 5, top: 0 }])
  })

  it('没有 data-line 的渲染结果回空表——而不是抛错', () => {
    // 走到这一支的情况是 `render.ts` 哪天忘了给某种块写行号。回空表的话 `topForLine`
    // 一律回 0，预览停在顶上；抛错的话整个面板白屏。前者是可接受的退化
    const host = document.createElement('div')
    host.innerHTML = '<p>没有行号</p>'
    expect(collectAnchors(host, () => 0)).toEqual([])
  })
})

describe('fractionalLine', () => {
  it('视口顶正好压在这一行上，就是整数行号', () => {
    expect(fractionalLine(10, 200, 20, 200)).toBe(10)
  })

  it('滚过一半就是 .5——小数那一半正是「不跳块」的手感来源', () => {
    expect(fractionalLine(10, 200, 20, 210)).toBe(10.5)
    expect(fractionalLine(10, 200, 20, 205)).toBe(10.25)
  })

  it('滚过整个行块也只到下一行为止，不外推到 11、12', () => {
    // 夹到 1 的理由：`lineBlockAtHeight` 在滚动位置越过最后一个块时会给一个很远的块，
    // 不夹的话插值出来的行号会超出文档，`topForLine` 再把它夹到最后一个锚点——
    // 结果看着对，中间那一帧却是「预览先跳到底再跳回来」
    expect(fractionalLine(10, 200, 20, 999)).toBe(11)
  })

  it('scrollTop 在行块之前时夹到 0，不给负数', () => {
    expect(fractionalLine(10, 200, 20, 0)).toBe(10)
  })

  it('🔴 行块高度为 0 时直接回整数行号', () => {
    // jsdom 里没有布局引擎，`lineBlockAtHeight` 量出来就是 0。不挡的话除零得 Infinity，
    // `topForLine` 一路夹到最后一个锚点——表现是「一打开预览就滚到底了」，
    // 而这个 bug 只在测试里出现，于是它会先表现为一批莫名其妙红的用例
    expect(fractionalLine(10, 200, 0, 250)).toBe(10)
    expect(fractionalLine(10, 200, -5, 250)).toBe(10)
  })
})

describe('topForLine', () => {
  const anchors: LineAnchor[] = [
    { line: 1, top: 0 },
    { line: 5, top: 100 },
    { line: 9, top: 400 },
  ]

  it('空表回 0', () => {
    expect(topForLine([], 7)).toBe(0)
  })

  it('正好落在锚点上就回那个锚点的 top', () => {
    expect(topForLine(anchors, 1)).toBe(0)
    expect(topForLine(anchors, 5)).toBe(100)
    expect(topForLine(anchors, 9)).toBe(400)
  })

  it('两个锚点之间按行号线性插值', () => {
    expect(topForLine(anchors, 3)).toBe(50)
    expect(topForLine(anchors, 7)).toBe(250)
    // 小数行号也走同一条插值：这是滚动跟手的关键，只按整数跳的话一行就是一整块
    expect(topForLine(anchors, 2.5)).toBe(37.5)
  })

  it('两端之外夹到端点，不外推', () => {
    // 外推出来的 top 会超出 scrollHeight，浏览器自己夹回来，但中间那一帧是肉眼可见的一跳
    expect(topForLine(anchors, 0)).toBe(0)
    expect(topForLine(anchors, -5)).toBe(0)
    expect(topForLine(anchors, 99)).toBe(400)
  })

  it('只有一个锚点时任何行号都回它', () => {
    const one: LineAnchor[] = [{ line: 4, top: 88 }]
    expect(topForLine(one, 1)).toBe(88)
    expect(topForLine(one, 4)).toBe(88)
    expect(topForLine(one, 99)).toBe(88)
  })

  it('上千个锚点也查得对——二分而不是线性扫，因为每一次滚动事件都要查一遍', () => {
    // 造 2000 个等距锚点，然后逐行对账一遍。这条用例真正的价值不是「2000 也能对」，
    // 而是它把二分的边界（`mid` 取上中位数、`low`/`high` 收口）整个走了一遍——
    // 写成 `(low + high) >>> 1` 配 `low = mid` 的话这里会在某些下标上死循环
    const many: LineAnchor[] = Array.from({ length: 2000 }, (_, i) => ({ line: i + 1, top: i * 10 }))
    for (const line of [1, 2, 3, 999, 1000, 1001, 1999, 2000]) {
      expect(topForLine(many, line), `line ${line}`).toBe((line - 1) * 10)
    }
    expect(topForLine(many, 1500.5)).toBe(14995)
    expect(topForLine(many, 0)).toBe(0)
    expect(topForLine(many, 2001)).toBe(19990)
  })
})

describe('atBottom', () => {
  it('正好到底', () => {
    expect(atBottom(900, 100, 1000)).toBe(true)
  })

  it('差 1px 也算到底——那是亚像素取整的余量', () => {
    // dPR=2 上 `scrollTop` 可以是小数，而 `scrollHeight` / `clientHeight` 是取过整的。
    // 不留余量的症状是「滚到底了却不认」，而它只在某些缩放比下出现
    expect(atBottom(899, 100, 1000)).toBe(true)
    expect(atBottom(899.4, 100, 1000)).toBe(true)
  })

  it('差 2px 就不算了', () => {
    expect(atBottom(898, 100, 1000)).toBe(false)
  })

  it('内容不超过一屏时也算到底——那时两边都只有一个位置', () => {
    expect(atBottom(0, 500, 300)).toBe(true)
    expect(atBottom(0, 500, 500)).toBe(true)
  })

  it('jsdom 的全零也是到底', () => {
    // 组件测试里读到的就是这三个 0。回 false 的话那一批用例会走进 `lineBlockAtHeight`
    // 那一条，而那条在 jsdom 里量不出东西
    expect(atBottom(0, 0, 0)).toBe(true)
  })
})
