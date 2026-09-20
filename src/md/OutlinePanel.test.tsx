// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTLINE_ROW_HEIGHT } from './outline'
import { OutlinePanel } from './OutlinePanel'
import { PANEL_DEBOUNCE_MS, type FollowedEditor } from './panel'

/**
 * 大纲面板的接线测试：`props` → `symbolTable` → `flattenOutline` → 虚拟列表 → 点击。
 *
 * 「层级与折叠怎么算」在 `outline.test.ts` 里（35 条，纯函数，穷举过边界），
 * 「标题怎么从语法树上摘」在 `goto/syntax.test.ts` 里，「什么时候重算」在 `panel.test.ts` 里。
 * 这里测的是**把它们接起来的那几行**，尤其是四条容易写错的：
 *
 * 1. 🔴 **挂载与换标签不等防抖**（与预览同一条理由，同一份 `createPanelRefresh`）。
 * 2. 🔴 **折叠状态按标签存**：切走再切回来还收着。漏了它不报错，只是用户收过的那一格
 *    自己弹回去了，而他没做过任何可以解释这件事的操作。
 * 3. 🔴 **点一行跳的是 `pos`**，而那个 `pos` 与 `Cmd+R` 浮层里选同一个标题拿到的
 *    **逐字相同**——两边同源，所以「浮层里跳得对、大纲里跳得不对」在结构上不可能。
 * 4. 🔴 **`pruneFold` 收的是标题清单**，不是摊平之后的行：搞反的话「父项收着、子项也收着」
 *    里那个子项的键会被当成失效清掉，展开父项之后子项莫名其妙是摊开的。
 *
 * ⚠️ 这里钉不住的：缩进与省略号在真实排版下长什么样、行高与 CSS 变量对不对得上、
 * jsdom 里 `clientHeight` 恒为 0 所以窗口永远只给 `OVERSCAN`（6）行——
 * 「几千个标题滚起来不卡」这件事只能在看得到像素的地方判断。
 */

function mdState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, codeLanguages: languages }) })
}

let container: HTMLElement
let unmount: () => void
/** 组件外面建的编辑器要在组件之后收，否则卸载时的 `removeEventListener` 会摸到一个已销毁的 view */
const views: EditorView[] = []

function makeView(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({ state: mdState(doc), parent })
  views.push(view)
  return view
}

function mount(doc: string, path: string | null) {
  const view = makeView(doc)
  const [source, setSource] = createSignal<FollowedEditor | null>({ view, path })
  const [revision, setRevision] = createSignal(0)
  const [tabId, setTabId] = createSignal(1)
  const onJump = vi.fn()
  const onClose = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(
    () => <OutlinePanel source={source} revision={revision} tabId={tabId} onJump={onJump} onClose={onClose} />,
    container,
  )
  let disposed = false
  unmount = () => {
    if (disposed) return
    disposed = true
    dispose()
  }

  // 🔴 与 `MarkdownPreview.test.tsx` 同一条：这个节点在挂载时**取一次存下来**，
  // 因为 `dispose()` 会把渲染出来的东西从容器里摘掉，而「卸载之后在飞的防抖还写不写」
  // 那一条用例恰恰要在摘掉之后读它
  const panel = container.querySelector<HTMLElement>('.outline')!

  /** 摊平之后的可见行，按屏幕顺序 */
  const rowEls = () => [...panel.querySelectorAll<HTMLElement>('.outline-row')]

  return {
    view,
    setSource,
    setTabId,
    onJump,
    onClose,
    unmount: () => unmount(),
    /** 正文变了一次。真实链路里这一下由 workspace 的 `revision` 计数发出 */
    bump: () => setRevision((n) => n + 1),
    /** 把这份正文换成 `next`，走的是真 dispatch，与用户敲键盘同一条路 */
    retype: (next: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    },
    note: () => panel.querySelector('.outline-note')?.textContent ?? null,
    names: () => rowEls().map((el) => el.querySelector('.outline-name')?.textContent ?? ''),
    /** 每行的缩进像素，读的是组件写在行内样式上的那个值 */
    indents: () => rowEls().map((el) => el.style.paddingLeft),
    /** 第 i 行的折叠箭头是不是一个真的按钮（没有子标题时它是个空 span，点不出东西） */
    twistyIsButton: (i: number) => rowEls()[i]?.querySelector('.outline-twisty')?.tagName === 'BUTTON',
    clickTwisty: (i: number) => {
      const el = rowEls()[i]?.querySelector<HTMLButtonElement>('.outline-twisty')
      if (el === undefined || el === null) throw new Error(`第 ${i} 行上没有折叠箭头`)
      el.click()
    },
    clickName: (i: number) => {
      const el = rowEls()[i]?.querySelector<HTMLButtonElement>('.outline-name')
      if (el === undefined || el === null) throw new Error(`第 ${i} 行上没有标题按钮`)
      el.click()
    },
    /** 占位元素撑出的总高：虚拟滚动的窗口算术全靠它与行高对得上 */
    spacerHeight: () => panel.querySelector<HTMLElement>('.outline-spacer')?.style.height ?? '',
    rowHeightVar: () => panel.style.getPropertyValue('--vela-outline-row-height'),
    close: () => panel.querySelector<HTMLButtonElement>('.outline-close')!.click(),
    /** 走完防抖窗口 */
    settle: () => vi.advanceTimersByTime(PANEL_DEBOUNCE_MS),
  }
}

beforeEach(() => {
  // ⚠️ 只冻 `setTimeout` / `clearTimeout`，**不**冻 `requestAnimationFrame`：
  // CM6 的 measure/read 两阶段调度正跑在 rAF 上（理由与 `MarkdownPreview.test.tsx` 逐字相同）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  unmount()
  for (const v of views) v.destroy()
  views.length = 0
  container.remove()
  vi.useRealTimers()
})

describe('OutlinePanel：首次重算', () => {
  it('挂载就列出标题，不等那 150ms', () => {
    const p = mount('# 甲\n\n## 乙\n\n# 丙\n', '/r/a.md')
    // 🔴 这一条不许 `settle()`：面板刚打开时等 150ms 出一条空栏，
    // 用户会以为按钮没生效，而那是他唯一在看这个面板的时刻
    expect(p.names()).toEqual(['甲', '乙', '丙'])
    expect(p.note()).toBeNull()
  })

  it('缩进按**树的深度**，不按标题级别：`#` 后面直接跟 `###` 也只缩进一格', () => {
    // 作者跳级是常见写法。按级别缩进的话丙会空出一格什么都没有的缩进，
    // 而整篇只用 `##` / `###` 的文档会让整个面板白空两格（见 outline.ts 文件头）
    const p = mount('# 甲\n\n### 丙\n', '/r/a.md')
    expect(p.names()).toEqual(['甲', '丙'])
    expect(p.indents()).toEqual(['4px', '16px'])
  })

  it('行高只有一个真相：注入成 CSS 变量，占位高度 = 行数 × 它', () => {
    const p = mount('# 甲\n\n## 乙\n\n# 丙\n', '/r/a.md')
    expect(p.rowHeightVar()).toBe(`${OUTLINE_ROW_HEIGHT}px`)
    // 写成两处字面量的话，漂移的失败方式是「行与行之间露出一条缝」或「互相压住半个字」——
    // 不报错，只是难看，而且很难联想到是 TS 里一个常量与 CSS 里一个数字对不上
    expect(p.spacerHeight()).toBe(`${3 * OUTLINE_ROW_HEIGHT}px`)
  })

  it('未命名文档也列：新建标签随手写几个标题就有得看', () => {
    const p = mount('# 甲\n', null)
    expect(p.names()).toEqual(['甲'])
  })
})

describe('OutlinePanel：折叠', () => {
  const DOC = '# 甲\n\n## 乙\n\n### 丙\n\n## 丁\n\n# 戊\n'

  it('有子标题的行给一个真的按钮，叶子行给一个同宽的空位', () => {
    const p = mount(DOC, '/r/a.md')
    expect(p.names()).toEqual(['甲', '乙', '丙', '丁', '戊'])
    expect(p.twistyIsButton(0)).toBe(true) // 甲 下面有 乙
    expect(p.twistyIsButton(2)).toBe(false) // 丙 是叶子
    expect(p.twistyIsButton(4)).toBe(false) // 戊 是叶子
    // ⚠️ 叶子行**留一个空 span** 而不是什么都不渲染：不留的话同层的标题会因为
    // 「有没有箭头」错开一个字宽，而缩进本来是用来说层级的
    expect(p.indents()[2]).toBe('28px')
  })

  it('点箭头收起整个子树，再点一次摊回来', () => {
    const p = mount(DOC, '/r/a.md')
    p.clickTwisty(0)
    // 甲 收着，于是 乙 丙 丁 整个不出现——不是「渲染时跳过」：
    // 虚拟滚动的窗口算术建立在「数组长度就是总行数」上，把隐藏行留在数组里会让滚动条高度对不上
    expect(p.names()).toEqual(['甲', '戊'])
    expect(p.spacerHeight()).toBe(`${2 * OUTLINE_ROW_HEIGHT}px`)
    p.clickTwisty(0)
    expect(p.names()).toEqual(['甲', '乙', '丙', '丁', '戊'])
  })

  it('收起一个中间层，它下面的子层跟着不见，而它的兄弟还在', () => {
    const p = mount(DOC, '/r/a.md')
    p.clickTwisty(1) // 乙
    expect(p.names()).toEqual(['甲', '乙', '丁', '戊'])
  })

  it('🔴 折叠状态按标签存：切走再切回来，收着的那一格还收着', () => {
    const p = mount(DOC, '/r/a.md')
    p.clickTwisty(0)
    expect(p.names()).toEqual(['甲', '戊'])

    // ⚠️ 下面两次 `set` 是**分开**写的，于是中间有一帧是「view 已经是 b.md、tabId 还是 1」。
    // 真实链路里 `showIn` 用 `batch` 把两者一起改，不会有这一帧；而这一条用例
    // 恰恰要它存在——重算时若把对账结果写回折叠表，那一帧就会拿 b.md 的标题
    // 去对账标签 1 的集合，把「甲」判成失效清掉，于是切回来时它是摊开的。
    // 存着的东西被毁掉是没有日志的，所以只能钉在这儿（理由见 `foldedByTab` 上那条 🔴）
    const other = makeView('# 一\n\n## 二\n')
    p.setSource({ view: other, path: '/r/b.md' })
    p.setTabId(2)
    expect(p.names()).toEqual(['一', '二'])

    // 换回第一个标签：那两格必须还是收着的。漏了这一条的症状是用户收过的东西自己弹开
    p.setSource({ view: p.view, path: '/r/a.md' })
    p.setTabId(1)
    expect(p.names()).toEqual(['甲', '戊'])
  })

  it('改标题会丢掉它自己与它子树的折叠状态——这是**刻意**的', () => {
    // 键是「从根到这一行的标题名链」（理由见 `OutlineRow.key`）。用 `pos` 当键的话
    // 每敲一个字后面所有标题的 pos 都变，折叠状态活不过一次输入——面板会在打字时自己展开。
    // 两害相权，这一条选的是「改标题丢折叠」而不是「打字丢折叠」
    const p = mount('# 甲\n\n## 乙\n', '/r/a.md')
    p.clickTwisty(0)
    expect(p.names()).toEqual(['甲'])
    p.retype('# 甲改\n\n## 乙\n')
    p.bump()
    p.settle()
    expect(p.names()).toEqual(['甲改', '乙'])
  })

  it('🔴 父项收着、子项也收着时，子项那个键不会被当成失效清掉', () => {
    // `pruneFold` 收的必须是**标题清单**而不是摊平之后的行：后者已经跳过了收起的子树，
    // 拿它对账会把「乙」的键清掉，于是展开「甲」之后「乙」莫名其妙是摊开的
    const p = mount(DOC, '/r/a.md')
    p.clickTwisty(1) // 先收 乙（丙 跟着不见）
    p.clickTwisty(0) // 再收 甲（乙 丁 跟着不见）
    expect(p.names()).toEqual(['甲', '戊'])
    p.retype(DOC) // 触发一次重算，让 pruneFold 真的跑一遍
    p.bump()
    p.settle()
    expect(p.names()).toEqual(['甲', '戊'])
    p.clickTwisty(0) // 展开 甲：乙 该还是收着的
    expect(p.names()).toEqual(['甲', '乙', '丁', '戊'])
  })
})

describe('OutlinePanel：点击跳转', () => {
  it('点一行标题，交出去的是那个标题在文档里的起点', () => {
    // ⚠️ 这两个数字与 `Cmd+R` 浮层里选同一个标题拿到的**逐字相同**：
    // 都是 `symbolsFrom` 里的 `node.from`（`goto/symbols.ts:121`）。
    // 大纲自己再算一遍位置的话，「浮层跳得对、大纲跳得不对」就成了迟早会发生的分歧
    const p = mount('# 甲\n\n## 乙\n', '/r/a.md')
    p.clickName(0)
    p.clickName(1)
    expect(p.onJump.mock.calls).toEqual([[0], [5]])
  })

  it('收起之后仍然列着的那些行，跳的还是它们自己的位置', () => {
    const p = mount('# 甲\n\n## 乙\n\n# 丙\n', '/r/a.md')
    p.clickTwisty(0)
    expect(p.names()).toEqual(['甲', '丙'])
    p.clickName(1)
    // 丙 在 `'# 甲\n\n## 乙\n\n# 丙\n'` 里的起点是 11：
    // `#`(0) ` `(1) `甲`(2) `\n`(3) `\n`(4) `#`(5) `#`(6) ` `(7) `乙`(8) `\n`(9) `\n`(10) `#`(11)
    expect(p.onJump.mock.calls).toEqual([[11]])
  })

  it('点 × 把关闭交给宿主，组件自己不藏自己', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.close()
    expect(p.onClose).toHaveBeenCalledOnce()
    // 可见性是 App 的信号，不是这里的：自己藏自己的话工具栏那个「大纲 开/关」
    // 就会与面板的实际状态对不上
    expect(container.querySelector('.outline')).not.toBeNull()
  })
})

describe('OutlinePanel：四种说不出口的状态', () => {
  it('不是 Markdown 时说出那个语言的名字，措辞与 Cmd+R 浮层逐字相同', () => {
    const p = mount('const x = 1', '/r/a.ts')
    // 🔴 这一句必须与 `goto/store.ts:452` 那一句一字不差。同一个事实两种说法的话，
    // 用户会以为浮层与面板答的是两个问题
    expect(p.note()).toBe('TypeScript 还没有符号表')
    expect(p.names()).toEqual([])
    expect(p.spacerHeight()).toBe('0px')
  })

  it('聚焦那块分屏里没有编辑器实例时，说的是「这块分屏」而不是「没有文档」', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.setSource(null)
    // 走到这一支的原因是那块分屏里**没有 CM6 实例**（只读大文件分片，或刚分出来还没挂上），
    // 而文档是存在的。说「没有文档」会让用户去看标签条——那儿明明有一个。
    // 措辞与预览那一句（「这块分屏里没有可预览的正文」）同一个模子：
    // 两个面板并排开着的时候不该各说各话
    expect(p.note()).toBe('这块分屏里没有可列的标题')
    expect(p.names()).toEqual([])
  })

  it('是 Markdown 但一个标题都没有，说的是「还没有标题」', () => {
    const p = mount('正文一段，没有标题。\n', '/r/a.md')
    // 与上一条必须分开：一个是「这里没有正文」，一个是「有正文，但作者没写标题」。
    // 合成一句的话用户会去怀疑自己的文档写坏了
    expect(p.note()).toBe('这份文档还没有标题')
    expect(p.names()).toEqual([])
  })

  it('空文档也是「还没有标题」，而不是「还是空的」', () => {
    // ⚠️ 与预览**刻意不同**：预览那句是「这份文档还是空的」，因为它渲染的是正文，
    // 而空正文渲染出来就是一片空白，得说清楚。大纲列的是标题，
    // 空文档与「有正文但没标题」在大纲上是同一件事——都没东西可列，
    // 分成两句只会让用户去猜这两句有什么区别
    const p = mount('', '/r/a.md')
    expect(p.note()).toBe('这份文档还没有标题')
  })

  it('从「不是 Markdown」切回来时提示会跟着消失', () => {
    const p = mount('const x = 1', '/r/a.ts')
    expect(p.note()).toBe('TypeScript 还没有符号表')
    const md = makeView('# 甲\n')
    p.setSource({ view: md, path: '/r/a.md' })
    expect(p.note()).toBeNull()
    expect(p.names()).toEqual(['甲'])
  })
})

describe('OutlinePanel：什么时候重算', () => {
  it('正文变了要等满防抖窗口，窗口里连着改几次只算最后那一份', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.retype('# 乙\n')
    p.bump()
    p.retype('# 丙\n')
    p.bump()
    expect(p.names()).toEqual(['甲'])
    p.settle()
    expect(p.names()).toEqual(['丙'])
  })

  it('换标签立刻重算，不等防抖', () => {
    const p = mount('# 甲\n', '/r/a.md')
    const other = makeView('# 乙\n')
    p.setSource({ view: other, path: '/r/b.md' })
    p.setTabId(2)
    // 🔴 不许 `settle()`。把 `createPanelRefresh` 里 `immediate` 那个判断删掉，
    // 所有功能测试照样绿，只有「切标签后那 150ms」是空的
    expect(p.names()).toEqual(['乙'])
  })

  it('🔴 同一块编辑器上换标签（view 实例没变）也立刻重算', () => {
    // 这一条钉的是 `showIn`：同一块分屏里换标签走 `capture` + `restore`，
    // **view 是同一个实例**。只比实例的话这里会红，而红的方式很难看——
    // 面板停在上一份文档的标题上，直到用户敲一个字
    const p = mount('# 甲\n', '/r/a.md')
    p.retype('# 乙\n')
    p.setTabId(2)
    expect(p.names()).toEqual(['乙'])
  })

  it('正文没变、只是计数涨了（光标动一下）不重算出新东西', () => {
    const p = mount('# 甲\n\n## 乙\n', '/r/a.md')
    p.clickTwisty(0)
    expect(p.names()).toEqual(['甲'])
    // workspace 的 `revision` 是**全工作区**口径：别的标签改了正文也会涨一次。
    // 那一下重算出来的是同一份标题，而折叠状态不该被它冲掉
    p.bump()
    p.settle()
    expect(p.names()).toEqual(['甲'])
  })
})

describe('OutlinePanel：卸载', () => {
  it('🔴 在飞的那一次防抖被取消，卸载之后不再写 signal', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.retype('# 乙\n')
    p.bump()
    p.unmount()
    // 取消掉了的话这里什么都不该发生。没取消的话回调照跑，往一个已经 dispose 的
    // owner 里 `setHeadings`——不报错，只是白写，所以只能钉在这儿
    p.settle()
    expect(p.names()).toEqual(['甲'])
  })
})
