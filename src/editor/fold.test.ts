// @vitest-environment jsdom
import { json } from '@codemirror/lang-json'
import { foldAll, foldedRanges, syntaxTreeAvailable, unfoldAll, unfoldEffect } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { foldWholeDocument } from './fold'

/**
 * 「折叠全部」要覆盖整篇，而不只是解析到的那一屏。
 *
 * 🔴 这一组用例存在的唯一理由是把 `fold.ts` 文件头那条断言钉住：CM6 的 `syntaxFolding`
 * 在 `tree.length < end` 时直接返回 null，而后台解析是视口驱动的——于是**裸调 `foldAll`
 * 在一份长文档上会漏掉后半截**。第一条用例先量出这个漏、再量 `foldWholeDocument` 补上了；
 * 少了前半截，后半截全绿也说明不了什么（「折不全」这个 bug 的表现正是「折了一些」）。
 *
 * ⚠️ jsdom 没有排版引擎，CM6 的视口是按它自己那套兜底尺寸算的（实测 1202 行的文档
 * 只给到 `{from: 0, to: 347}`，语法树解析到 3003），所以「一屏是多少行」在这里与真窗口
 * 不是一个数。用例不钉住那个数，只钉住「裸 `foldAll` 折到的位置远没到文末」这个**关系**
 * ——它在真窗口里同样成立，只是漏得更少。
 *
 * ⚠️ 数的是**区间**，而两条路数的口径不同：裸 `foldAll` 只折最外层（且只在已解析区域内），
 * `foldWholeDocument` 折**每一层**——300 个成员的数组折完是 301 条（最外层 + 每个成员）。
 * 用例钉的是关系（「有一条盖住全篇」、以及「展开最外层之后里面还折着」），不是某个固定条数。
 */

let views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views = []
})

/** 300 个成员的数组，每个成员 4 行：1202 行的 JSON，远超任何一屏 */
function bigJson(members = 300): string {
  const items = Array.from({ length: members }, (_, i) => `  {\n    "id": ${i},\n    "name": "n${i}"\n  }`)
  return `[\n${items.join(',\n')}\n]`
}

function view(doc: string, withLanguage = true): EditorView {
  const v = new EditorView({ state: EditorState.create({ doc, extensions: withLanguage ? [json()] : [] }) })
  // 🔴 必须真的挂进 document：`foldWholeDocument` 用 `view.dom.isConnected` 判
  // 「这个 view 还活着吗」，游离在文档外面的话它第一轮就会停手，用例全绿而什么都没验
  document.body.appendChild(v.dom)
  views.push(v)
  return v
}

function rangesOf(v: EditorView): [number, number][] {
  const out: [number, number][] = []
  for (const cursor = foldedRanges(v.state).iter(); cursor.value; cursor.next()) out.push([cursor.from, cursor.to])
  return out
}

describe('foldWholeDocument', () => {
  it('裸的 foldAll 在长文档上折不全，foldWholeDocument 一次盖住整篇', async () => {
    const doc = bigJson()

    // 前半截：量出那个漏。新建的 view 只解析到视口附近，于是最外层那个数组折不动
    //（它的 end 在文末，`tree.length < end`），只有前四分之一里的成员被折了起来
    const bare = view(doc)
    expect(foldAll(bare)).toBe(true)
    const bareRanges = rangesOf(bare)
    expect(bareRanges.length).toBeGreaterThan(1)
    expect(syntaxTreeAvailable(bare.state, doc.length)).toBe(false)
    expect(Math.max(...bareRanges.map(([, to]) => to)), '文末那一截应当还摊着').toBeLessThan(doc.length - 1000)

    // 后半截：同一个形状，走我们这一条
    const v = view(doc)
    expect(await foldWholeDocument(v)).toBe(true)
    expect(syntaxTreeAvailable(v.state, doc.length)).toBe(true)
    const folded = rangesOf(v)
    // 每一层都折了：不止一条区间，且其中最外层那一条盖住几乎整篇（掐头去尾各一个方括号）
    // ——用户看见的就是「全文缩成一行」
    expect(folded.length).toBeGreaterThan(1)
    expect(
      folded.some(([from, to]) => to - from > doc.length * 0.99),
      '最外层那一条应当在',
    ).toBe(true)
  })

  it('折满之后展开最外层，里面还是折着的（逐层折，不是只折一层）', async () => {
    const doc = bigJson()
    const v = view(doc)
    await foldWholeDocument(v)
    const all = rangesOf(v)
    const outer = all.find(([from, to]) => to - from > doc.length * 0.99)!

    // 展开根节点就是折叠槽那支箭干的事：对**这一条**区间 dispatch unfold
    v.dispatch({ effects: unfoldEffect.of({ from: outer[0], to: outer[1] }) })
    const rest = rangesOf(v)
    expect(rest).toHaveLength(all.length - 1)
    expect(
      rest.some(([from, to]) => to - from > doc.length * 0.99),
      '最外层应当已经摊开',
    ).toBe(false)
  })

  it('折满之后能一次全展开（折叠与展开是一对可逆操作）', async () => {
    const v = view(bigJson())
    await foldWholeDocument(v)
    expect(rangesOf(v).length).toBeGreaterThan(1)

    // `unfoldAll` 是 CM6 自己的：它读的是**已折叠区间**，不需要语法树，所以直接调
    unfoldAll(v)
    expect(rangesOf(v)).toEqual([])
  })

  it('没有可折的块时如实返回 false，正文一个字不动', async () => {
    const v = view('一行\n两行')
    expect(await foldWholeDocument(v)).toBe(false)
    expect(v.state.doc.toString()).toBe('一行\n两行')
  })

  it('纯文本（没挂语言）不进那个解析循环，立刻返回', async () => {
    const v = view(bigJson(), false)
    expect(await foldWholeDocument(v)).toBe(false)
    expect(rangesOf(v)).toEqual([])
  })
})
