// @vitest-environment jsdom
import { history, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from './MarkdownPreview'
import { PANEL_DEBOUNCE_MS, type FollowedEditor } from './panel'

/**
 * 预览面板的接线测试：`props` → 渲染 → `innerHTML` → 提示文案，整条链真的跑起来。
 *
 * 「怎么把树渲染成 HTML」在 `render.test.ts` 里，「行号 ↔ 像素」的算术在
 * `scrollSync.test.ts` 里（26 条），「什么时候该重渲染」在 `panel.test.ts` 里
 * （`createDebounced` 与 `createPanelRefresh` 两组）。这里测的是**把它们接起来的那几行**，尤其是三条容易写错的：
 *
 * 1. 🔴 **挂载与换标签不等防抖**。等着的话面板刚打开是一块空白，而「刚打开」正是
 *    用户唯一在看它的那一刻。
 * 2. 🔴 **HTML 一样就不重写 `innerHTML`**。重写不只是浪费：那一下会把用户在预览里
 *    选中的文字、以及浏览器给这一栏记着的滚动位置全部丢掉。
 * 3. 🔴 **卸载时把在飞的那一次取消掉**。漏了它不会报错，只是 150ms 之后往一个已经
 *    从 DOM 上摘下来的节点里写东西。
 *
 * 最后一组（M3-A-5）测的是**唯一一处反向**：点预览里的 GFM 勾选框会把 `[ ]` ↔ `[x]`
 * 写回源文档。它要验的三件事是：认的是 `data-pos` 而不是「第几个」、过期偏移一个字都不改、
 * 以及它是一次**普通编辑事务**（进撤销栈，不是预览自己另立的一份状态）。
 *
 * ⚠️ 这里钉不住的：滚动跟得准不准（jsdom 的 `scrollTop` 赋值是空操作，
 * `clientHeight` / `scrollHeight` 恒为 0，于是 `atBottom` 永远为真、
 * `lineBlockAtHeight` 那一条压根走不到）、排版长什么样、外链点下去 WKWebView 怎么反应、
 * 以及点完勾选框那一下在真实排版里**看不看得出来**（这里只能验 `data-checked` 变了）。
 */

function mdState(doc: string): EditorState {
  // `history()` 是给「一次点击 = 一个撤销步」那一条用例加的：勾选框回写走的是一次普通
  // 编辑事务，而「普通」这三个字只有在带历史的 state 上才验得出来。对其它用例没有影响
  // （它们从不调 `undo`）
  return EditorState.create({
    doc,
    extensions: [history(), markdown({ base: markdownLanguage, codeLanguages: languages })],
  })
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
  const onClose = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(
    () => <MarkdownPreview source={source} revision={revision} tabId={tabId} onClose={onClose} />,
    container,
  )
  let disposed = false
  unmount = () => {
    if (disposed) return
    disposed = true
    dispose()
  }

  // 🔴 三个节点在挂载时**取一次存下来**，不每次回 `container` 里查：`dispose()` 会把
  // 渲染出来的东西从容器里摘掉，而「卸载之后在飞的防抖还写不写 DOM」那一条用例
  // 恰恰要在摘掉之后读它。查容器的话读到的是 null，断言会以一个 TypeError 收场，
  // 看起来像测试写坏了而不是像组件有问题
  const panel = container.querySelector<HTMLElement>('.md-preview')!
  const body = container.querySelector<HTMLElement>('.md-preview-body')!

  return {
    view,
    setSource,
    setTabId,
    onClose,
    unmount: () => unmount(),
    /** 正文变了一次。真实链路里这一下由 workspace 的 `revision` 计数发出 */
    bump: () => setRevision((n) => n + 1),
    /** 把这份正文换成 `next`，走的是真 dispatch，与用户敲键盘同一条路 */
    retype: (next: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    },
    bodyHtml: () => body.innerHTML,
    /** 当前正文。回写有没有真的落到文档上，只能问 view 自己，问 DOM 是问不出来的 */
    text: () => view.state.doc.toString(),
    /**
     * 预览里的勾选框，按出现顺序。
     *
     * ⚠️ 每次回写都会重写 `innerHTML`，于是上一批节点全部游离——所以调用点必须**现查**，
     * 不能把元素存下来跨一次点击再用。存下来的那个点得动（事件照样派发），
     * 但它已经不在文档里，于是「点完焦点还在不在」这类断言会拿到一个假答案
     */
    tasks: () => [...body.querySelectorAll<HTMLElement>('.md-task')],
    note: () => panel.querySelector('.md-preview-note')?.textContent ?? null,
    /** 在渲染结果上留一个记号：`innerHTML` 被重写的话它就没了 */
    mark: () => body.firstElementChild!.setAttribute('data-probe', '1'),
    marked: () => body.querySelector('[data-probe]') !== null,
    anchored: () => [...body.querySelectorAll('[data-line]')].map((el) => el.getAttribute('data-line')),
    close: () => panel.querySelector<HTMLButtonElement>('.md-preview-close')!.click(),
    /** 走完防抖窗口 */
    settle: () => vi.advanceTimersByTime(PANEL_DEBOUNCE_MS),
  }
}

beforeEach(() => {
  // ⚠️ 只冻 `setTimeout` / `clearTimeout`，**不**冻 `requestAnimationFrame`：
  // CM6 的 measure/read 两阶段调度正跑在 rAF 上，一起冻住的话挂真编辑器的用例
  // 会连带变成一个时序谜团（`doc/sessionSync.ts:52` 那条注释说的就是这件事，
  // 而它当时的结论是「改用可注入的定时器」——这里能直接冻是因为只需要窄化 `toFake`）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  unmount()
  for (const v of views) v.destroy()
  views.length = 0
  container.remove()
  vi.useRealTimers()
})

describe('MarkdownPreview：首次渲染', () => {
  it('挂载就渲染，不等那 150ms', () => {
    const p = mount('# 甲\n\n正文 **粗**。\n', '/r/a.md')
    // 🔴 这一条不许 `settle()`：面板刚打开时等 150ms 出一块空白，
    // 用户会以为按钮没生效，而那是他唯一在看这个面板的时刻
    expect(p.bodyHtml()).toBe('<h1 data-line="1" id="甲">甲</h1><p data-line="3">正文 <strong>粗</strong>。</p>')
    expect(p.note()).toBeNull()
  })

  it('块级元素带着 data-line 进 DOM——同步滚动只认这个属性', () => {
    const p = mount('# 甲\n\n正文。\n', '/r/a.md')
    expect(p.anchored()).toEqual(['1', '3'])
  })

  it('未命名文档也渲染：新建标签随手写几句就有得看', () => {
    const p = mount('# 甲\n', null)
    expect(p.bodyHtml()).toContain('甲')
  })
})

describe('MarkdownPreview：三种说不出口的状态', () => {
  it('不是 Markdown 时说出那个语言的名字，正文清空', () => {
    const p = mount('const x = 1', '/r/a.ts')
    // 措辞与 `Cmd+R` 那句「X 还没有符号表」同一个模子：如实说「这个语言没有」，
    // 而不是让用户去猜按钮是不是坏了
    expect(p.note()).toBe('TypeScript 还没有预览')
    expect(p.bodyHtml()).toBe('')
  })

  it('聚焦那块分屏里没有编辑器实例时，说的是「这块分屏」而不是「没有文档」', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.setSource(null)
    // 走到这一支的原因是那块分屏里**没有 CM6 实例**（只读大文件分片，或刚分出来还没挂上），
    // 而文档是存在的。说「没有文档」会让用户去看标签条——那儿明明有一个
    expect(p.note()).toBe('这块分屏里没有可预览的正文')
    expect(p.bodyHtml()).toBe('')
  })

  it('Markdown 但是空的，说的是「还是空的」', () => {
    const p = mount('', '/r/a.md')
    // 与上一条必须分开：一个是「这里没有正文」，一个是「有正文，但一个字都没写」
    expect(p.note()).toBe('这份文档还是空的')
    expect(p.bodyHtml()).toBe('')
  })

  it('点 × 把关闭交给宿主，组件自己不藏自己', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.close()
    expect(p.onClose).toHaveBeenCalledOnce()
    // 可见性是 App 的信号，不是这里的：自己藏自己的话工具栏那个「预览 开/关」
    // 就会与面板的实际状态对不上
    expect(container.querySelector('.md-preview')).not.toBeNull()
  })
})

describe('MarkdownPreview：什么时候重渲染', () => {
  it('正文变了要等满防抖窗口，窗口里连着改几次只渲染最后那一份', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.retype('# 乙\n')
    p.bump()
    p.retype('# 丙\n')
    p.bump()
    expect(p.bodyHtml()).toContain('甲')
    p.settle()
    expect(p.bodyHtml()).toBe('<h1 data-line="1" id="丙">丙</h1>')
  })

  it('换标签立刻渲染，不等防抖', () => {
    const p = mount('# 甲\n', '/r/a.md')
    const other = makeView('# 乙\n')
    p.setSource({ view: other, path: '/r/b.md' })
    p.setTabId(2)
    // 🔴 不许 `settle()`。这一条与「挂载就渲染」是同一条理由，而它更容易被顺手改坏：
    // 把 `immediate` 那个判断删掉，所有功能测试照样绿，只有「切标签后那 150ms」是空的
    expect(p.bodyHtml()).toBe('<h1 data-line="1" id="乙">乙</h1>')
  })

  it('🔴 渲染结果一样时不重写 innerHTML', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.mark()
    // 光标动一下、或者别的标签改了正文（workspace 的 `revision` 是**全工作区**口径），
    // 都会涨一次计数。那份内容没变，重写一遍就会把用户在预览里选中的文字丢掉
    p.bump()
    p.settle()
    expect(p.marked(), '内容没变却重写了 DOM').toBe(true)
    expect(p.bodyHtml()).toContain('甲')
  })

  it('内容真的变了才重写，标记物随之消失', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.mark()
    p.retype('# 乙\n')
    p.bump()
    p.settle()
    expect(p.marked()).toBe(false)
    expect(p.bodyHtml()).toContain('乙')
  })

  it('从「不是 Markdown」切回来时提示会跟着消失', () => {
    const p = mount('const x = 1', '/r/a.ts')
    expect(p.note()).toBe('TypeScript 还没有预览')
    const md = makeView('# 甲\n')
    p.setSource({ view: md, path: '/r/a.md' })
    expect(p.note()).toBeNull()
    expect(p.bodyHtml()).toContain('甲')
  })
})

describe('MarkdownPreview：卸载', () => {
  it('🔴 在飞的那一次防抖被取消，卸载之后不再写 DOM', () => {
    const p = mount('# 甲\n', '/r/a.md')
    p.retype('# 乙\n')
    p.bump()
    p.unmount()
    // 取消掉了的话这里什么都不该发生。没取消的话回调照跑，往那个已经游离的节点里
    // 写「乙」——而 `bodyHtml()` 读的是挂载时存下来的那个引用，游离了也照样读得到，
    // 所以这条断言是真的在看组件的行为，不是在看 jsdom 的怪癖
    p.settle()
    expect(p.bodyHtml()).toContain('甲')
  })
})

describe('MarkdownPreview：点勾选框回写源文档（M3-A-5）', () => {
  /** 一勾一未勾。两个 `[` 的偏移分别是 2 与 10（第一行连换行共 8 个字符） */
  const TWO = '- [ ] 甲\n- [x] 乙\n'

  it('点未打勾的那一条：文档里 [ ] 变 [x]，预览**立刻**重画', () => {
    const p = mount(TWO, '/r/a.md')
    p.tasks()[0]!.click()
    expect(p.text()).toBe('- [x] 甲\n- [x] 乙\n')
    // 🔴 不许 `settle()`。等满那 150ms 的话，用户点完看见的还是一个空框，
    // 于是他会再点一次——而那一次是**真的**会把它翻回去。所以回写后必须当场渲染，
    // 这一条与「挂载就渲染」是同一种「不许让用户看中间态」的纪律
    expect(p.tasks()[0]!.dataset.checked).toBe('true')
  })

  it('点已打勾的那一条：变回 [ ]，而 data-pos 不漂', () => {
    const p = mount(TWO, '/r/a.md')
    expect(p.tasks()[1]!.dataset.pos).toBe('10')
    p.tasks()[1]!.click()
    expect(p.text()).toBe('- [ ] 甲\n- [ ] 乙\n')
    expect(p.tasks()[1]!.dataset.checked).toBe('false')
    // `[ ]` ↔ `[x]` 是**等长**替换，所以整篇文档里其它勾选框的偏移一个都不用重算。
    // 这条断言钉的就是这件事：哪天有人把它改成 `[x]` ↔ `[✓]`（不等长），
    // 一张清单上点第二下就会改到第三个字符去
    expect(p.tasks()[1]!.dataset.pos).toBe('10')
  })

  it('认的是 data-pos 而不是「第几个」：点第二条不动第一条', () => {
    const p = mount(TWO, '/r/a.md')
    p.tasks()[1]!.click()
    expect(p.tasks()[0]!.dataset.checked, '第一条被顺手改了').toBe('false')
  })

  it('一次点击 = 一个撤销步，而且它进的是**文档**的撤销栈', () => {
    const p = mount(TWO, '/r/a.md')
    p.tasks()[0]!.click()
    expect(p.text()).toBe('- [x] 甲\n- [x] 乙\n')
    // 「它是一次普通编辑事务」这句话的全部内容就在这一行里：撤销得回去，
    // 说明它没有绕开 CM6 直接改 DOM，也没有另立一份只存在于预览里的状态
    undo(p.view)
    expect(p.text()).toBe(TWO)
  })

  it('🔴 data-pos 过期时一个字都不改，只重画一遍', () => {
    const p = mount(TWO, '/r/a.md')
    // 正文换了、面板还在防抖窗口里——那 150ms 里它显示的仍是**上一份**渲染结果，
    // 于是 DOM 上那个 `data-pos="2"` 指的是旧文档里的位置。
    // 不核对就写的话，它会把新文档的第 2..5 个字符替换成 `[x]`
    p.retype('# 标题\n')
    p.tasks()[0]!.click()
    expect(p.text(), '过期偏移改到了别处').toBe('# 标题\n')
    expect(p.tasks()).toHaveLength(0)
  })

  it('文档比那个偏移还短时不越界：空文档上点一下不抛错，只把面板更新过来', () => {
    const p = mount(TWO, '/r/a.md')
    p.retype('')
    p.tasks()[0]!.click()
    // jsdom 会把监听器里的异常吞掉（只往虚拟控制台报一条），所以「不抛错」
    // 得用**行为**来验：走到了 `render()` 才会有这句提示
    expect(p.text()).toBe('')
    expect(p.note()).toBe('这份文档还是空的')
  })

  it('键盘也走同一条路：空格切换，并且**拦掉**空格默认的滚一屏', () => {
    const p = mount(TWO, '/r/a.md')
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    p.tasks()[0]!.dispatchEvent(space)
    expect(space.defaultPrevented, '不拦的话「打勾」与「滚一屏」同时发生，滚完用户已经找不到刚点的是哪条').toBe(true)
    expect(p.text()).toBe('- [x] 甲\n- [x] 乙\n')
  })

  it('回车同样切换（`role="checkbox"` + `tabindex="0"` 许下的那一半）', () => {
    const p = mount(TWO, '/r/a.md')
    p.tasks()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(p.text()).toBe('- [x] 甲\n- [x] 乙\n')
  })

  it('别的键既不动文档也不吃默认行为', () => {
    const p = mount(TWO, '/r/a.md')
    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    p.tasks()[0]!.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(p.text()).toBe(TWO)
  })

  it('焦点原本在勾选框上时，重画之后焦点回到**同一个位置**的新节点', () => {
    const p = mount(TWO, '/r/a.md')
    const box = p.tasks()[1]!
    box.focus()
    expect(document.activeElement).toBe(box)
    box.click()
    const after = p.tasks()[1]!
    // `innerHTML` 整个换过，所以它必然是另一个节点——「还是同一个」在这里是失败而不是成功
    expect(after).not.toBe(box)
    expect(document.activeElement, '键盘用户点完就被丢回 body 了').toBe(after)
  })

  it('点标题、段落这类不是勾选框的地方，一个字都不改', () => {
    const doc = '# 标题\n\n正文。\n'
    const p = mount(doc, '/r/a.md')
    container.querySelector('.md-preview-body h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(p.text()).toBe(doc)
  })

  // ⚠️ `toggleTask` 里那句 `src === null` 的早退**测不到**，而且是有意的：
  // `setSource(null)` 是一次裸的信号写，Solid 会**同步**冲掉 user effect，
  // 于是面板在同一个 tick 里就把正文清空了——DOM 上再没有勾选框可点。
  // 那条分支留着是因为 `props.source()` 的类型本来就是 `FollowedEditor | null`，
  // 不是因为它能被走到
  it('聚焦的编辑器被摘掉时面板清空，也就没有勾选框可点了', () => {
    const p = mount(TWO, '/r/a.md')
    p.setSource(null)
    expect(p.tasks()).toHaveLength(0)
    expect(p.text(), '摘掉 source 不该动文档').toBe(TWO)
  })
})
