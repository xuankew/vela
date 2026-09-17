// @vitest-environment jsdom
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  SearchQuery,
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  search,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectMatches,
  createFindReplacePanel,
  matchCase,
  preserveCase,
  replaceAllCommand,
  replaceNextCommand,
  setPreserveCase,
  unquote,
} from './findReplace'

let views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views = []
})

/**
 * 建一个真视图。
 *
 * 查找替换绕不开 `EditorView`：`openSearchPanel` 要往 DOM 里插面板，`replaceAll` 要读
 * `view.state.field(searchState)`，保留大小写那条路也要 `view.dispatch`。
 * node 环境下这些一个都造不出来，所以整个文件走 jsdom。
 */
function makeView(doc: string, selection?: number | [number, number]) {
  const state = EditorState.create({
    doc,
    ...(selection === undefined
      ? {}
      : {
          selection:
            typeof selection === 'number'
              ? EditorSelection.cursor(selection)
              : EditorSelection.range(selection[0], selection[1]),
        }),
    extensions: [
      search({ createPanel: createFindReplacePanel }),
      preserveCase,
      // 少了这条，selectMatches 选出的多个区间会被静默塌成主选区，下面的差分测试就成了假象。
      // 真实应用里 setup.ts 也开着它。
      EditorState.allowMultipleSelections.of(true),
    ],
  })
  const view = new EditorView({ state, parent: document.body })
  views.push(view)
  return view
}

/** `@codemirror/search` 没有导出 `SearchSpec` 这个名字，从构造函数签名反推 */
type QuerySpec = ConstructorParameters<typeof SearchQuery>[0]

function applyQuery(view: EditorView, spec: QuerySpec) {
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery(spec)) })
}

function applyPreserve(view: EditorView, on: boolean) {
  view.dispatch({ effects: setPreserveCase.of(on) })
}

const NO_LIMIT = 1e9

describe('matchCase：按被匹配文本的大小写形状改写替换文本', () => {
  it('全大写 → 全大写，全小写 → 全小写', () => {
    expect(matchCase('bar', 'FOO')).toBe('BAR')
    expect(matchCase('bar', 'foo')).toBe('bar')
    // 形状说了算，不是「替换文本自己写的算」：用户敲了 Bar，匹配到全小写的 foo 也该出 bar
    expect(matchCase('Bar', 'foo')).toBe('bar')
    expect(matchCase('bar1', 'FOO')).toBe('BAR1')
  })

  it('首字母大写 → 只把替换文本的第一个字母抬起来，其余不动', () => {
    expect(matchCase('bar', 'Foo')).toBe('Bar')
    // 刻意不强制把其余部分转小写：用户特地敲的大写不该被悄悄抹掉
    expect(matchCase('bAR', 'Foo')).toBe('BAR')
    // 抬的是第一个**有大小写之分**的字符，不是第一个字符
    expect(matchCase('1ab', 'Foo')).toBe('1Ab')
  })

  it('混合形状、无大小写字符、空替换文本一律原样', () => {
    expect(matchCase('bar', 'fOO')).toBe('bar')
    expect(matchCase('bar', 'FoO')).toBe('bar')
    expect(matchCase('bar', '123')).toBe('bar')
    expect(matchCase('bar', '汉字')).toBe('bar')
    expect(matchCase('bar', '')).toBe('bar')
    expect(matchCase('', 'FOO')).toBe('')
  })
})

describe('unquote：按 CM6 同一套规则展开转义', () => {
  const plain = new SearchQuery({ search: 'x', replace: 'y' })
  const literal = new SearchQuery({ search: 'x', replace: 'y', literal: true })

  it('非字面量模式下展开 \\n \\r \\t \\\\', () => {
    expect(unquote(plain, 'a\\nb')).toBe('a\nb')
    expect(unquote(plain, 'a\\rb')).toBe('a\rb')
    expect(unquote(plain, 'a\\tb')).toBe('a\tb')
    expect(unquote(plain, 'a\\\\b')).toBe('a\\b')
  })

  it('认不出的转义原样留着，字面量模式整个不展开', () => {
    expect(unquote(plain, '\\q')).toBe('\\q')
    expect(unquote(literal, 'a\\nb')).toBe('a\\nb')
  })
})

describe('collectMatches：与 CM6 自己的匹配集合对齐', () => {
  it('默认大小写不敏感，caseSensitive / wholeWord / limit 都照办', () => {
    // 位置：foo@0、Foo@4、fooobar@8、foo@16
    const state = EditorState.create({ doc: 'foo Foo fooobar foo' })
    const all = new SearchQuery({ search: 'foo' })
    expect(collectMatches(state, all, 0, state.doc.length, NO_LIMIT).map((m) => m.from)).toEqual([0, 4, 8, 16])

    // 区分大小写后 Foo 那处没了，但 fooobar 开头那处仍然是小写的 foo，还在
    const sensitive = new SearchQuery({ search: 'foo', caseSensitive: true })
    expect(collectMatches(state, sensitive, 0, state.doc.length, NO_LIMIT).map((m) => m.from)).toEqual([0, 8, 16])

    // wholeWord 把 fooobar 里那处排掉——这条是 getCursor 自己就做了的，不是这里加的
    const word = new SearchQuery({ search: 'foo', wholeWord: true })
    expect(collectMatches(state, word, 0, state.doc.length, NO_LIMIT).map((m) => m.from)).toEqual([0, 4, 16])

    expect(collectMatches(state, all, 0, state.doc.length, 2)).toHaveLength(2)
  })

  it('区间限制生效：只收 from..to 里的匹配', () => {
    const state = EditorState.create({ doc: 'foo foo foo' })
    const query = new SearchQuery({ search: 'foo' })
    expect(collectMatches(state, query, 4, 11, NO_LIMIT).map((m) => m.from)).toEqual([4, 8])
  })

  it('匹配集合与 CM6 selectMatches 选出来的一致', () => {
    // 差分测试：selectMatches 走的是 CM6 内部的 matchAll，两边应当给出同一批区间。
    // 这是「没有重写查找逻辑」这件事唯一的客观证据。
    const view = makeView('foo bar Foo baz foo foo')
    applyQuery(view, { search: 'foo' })
    expect(selectMatches(view)).toBe(true)
    const cm6Ranges = view.state.selection.ranges.map((r) => [r.from, r.to])
    const mine = collectMatches(view.state, getSearchQuery(view.state), 0, view.state.doc.length, NO_LIMIT).map((m) => [
      m.from,
      m.to,
    ])
    expect(mine).toEqual(cm6Ranges)
    expect(mine).toHaveLength(4)
  })

  it('丢掉不精确匹配：边界落在 NFKD 会展开成多字符的字里面时，那段区间盖住了不属于匹配的内容', () => {
    // '½' 归一化成 '1⁄2'（三个字符），CM6 的 SearchCursor 在归一化文本上匹配，
    // 于是查 '1' 会在 ½ 上命中一次，但那次的 from..to 是整个 '½'，替换它会连分数一起改掉。
    // CM6 的 replaceAll 用内部的 precise 标记跳过这种匹配；那个标记没进公开类型，
    // 这里靠「区间文本归一化后必须等于查询串」重判一次。
    const state = EditorState.create({ doc: '½ a1' })
    const query = new SearchQuery({ search: '1' })

    // 先证明原始游标确实吐出了那条不精确匹配：不然下面这个断言在 CM6 行为变化时会假通过，
    // 而 collectMatches 里那段重判也就悄悄变成了死代码。
    const raw: string[] = []
    const cursor = query.getCursor(state)
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      raw.push(state.sliceDoc(step.value.from, step.value.to))
    }
    expect(raw).toContain('½')

    const matches = collectMatches(state, query, 0, state.doc.length, NO_LIMIT)
    expect(matches.map((m) => state.sliceDoc(m.from, m.to))).toEqual(['1'])
  })
})

describe('replaceAllCommand', () => {
  it('保留大小写关着时，替换文本原样落地，且与 CM6 的 replaceAll 结果逐字相同', () => {
    const doc = 'Foo foo FOO fOo'
    const mine = makeView(doc)
    const theirs = makeView(doc)
    for (const view of [mine, theirs]) applyQuery(view, { search: 'foo', replace: 'Bar' })

    expect(replaceAllCommand(mine)).toBe(true)
    expect(replaceAll(theirs)).toBe(true)
    // 关着的时候走的就是 CM6 那条路，不是「行为恰好一样」
    expect(mine.state.doc.toString()).toBe(theirs.state.doc.toString())
    expect(mine.state.doc.toString()).toBe('Bar Bar Bar Bar')
  })

  it('保留大小写开着时，四处匹配各按自己的形状改', () => {
    const view = makeView('Foo foo FOO fOo')
    applyQuery(view, { search: 'foo', replace: 'bar' })
    applyPreserve(view, true)
    expect(replaceAllCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('Bar bar BAR bar')
  })

  it('开着时替换文本里的 \\n 仍然展开成换行', () => {
    const view = makeView('a b')
    applyQuery(view, { search: ' ', replace: '\\n' })
    applyPreserve(view, true)
    expect(replaceAllCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a\nb')
  })

  it('正则模式下这个开关不生效——拿不到捕获组，就不假装能用', () => {
    const view = makeView('FOO foo')
    applyQuery(view, { search: 'f.o', regexp: true, replace: 'bar' })
    applyPreserve(view, true)
    expect(replaceAllCommand(view)).toBe(true)
    // 真生效的话 FOO 那处会变成 BAR
    expect(view.state.doc.toString()).toBe('bar bar')
  })

  it('一处都没匹配上时返回 false，且不往撤销历史里塞空记录', () => {
    const view = makeView('abc')
    applyQuery(view, { search: 'zzz', replace: 'y' })
    applyPreserve(view, true)
    expect(replaceAllCommand(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('abc')
  })

  it('查询为空时不算失败，而是把面板打开让用户先填', () => {
    const view = makeView('abc')
    applyPreserve(view, true)
    expect(getSearchQuery(view.state).valid).toBe(false)
    replaceAllCommand(view)
    expect(view.dom.querySelector('.cm-search')).not.toBeNull()
  })
})

describe('replaceNextCommand', () => {
  it('选区不在匹配上时只跳过去，不动文档', () => {
    const view = makeView('foo bar foo', 0)
    applyQuery(view, { search: 'foo', replace: 'X' })
    applyPreserve(view, true)

    expect(replaceNextCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('foo bar foo')
    const { from, to } = view.state.selection.main
    expect(view.state.sliceDoc(from, to)).toBe('foo')
    expect(from).toBe(0)
  })

  it('选区正好是一个匹配时才替换，并把选区推到下一处（位置过了 changeSet 映射）', () => {
    const view = makeView('foo bar foo baz foo', [0, 3])
    // 替换文本比匹配长一个字符，后面两处的位置会整体右移——映射漏了就会选错地方
    applyQuery(view, { search: 'foo', replace: 'quux' })
    applyPreserve(view, true)

    expect(replaceNextCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('quux bar foo baz foo')
    const { from, to } = view.state.selection.main
    expect(view.state.sliceDoc(from, to)).toBe('foo')
    expect([from, to]).toEqual([9, 12])
  })

  it('替换最后一处后选区绕回第一处', () => {
    const view = makeView('a a', [2, 3])
    applyQuery(view, { search: 'a', replace: 'b' })
    applyPreserve(view, true)

    expect(replaceNextCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('a b')
    expect(view.state.selection.main.from).toBe(0)
    expect(view.state.selection.main.to).toBe(1)
  })

  it('开着保留大小写时，只改当前这一处的大小写形状', () => {
    const view = makeView('FOO foo', [0, 3])
    applyQuery(view, { search: 'foo', replace: 'bar' })
    applyPreserve(view, true)

    expect(replaceNextCommand(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('BAR foo')
  })

  it('整篇一个匹配都没有时返回 false，不动文档也不动选区', () => {
    const view = makeView('abc', 1)
    applyQuery(view, { search: 'zzz', replace: 'y' })
    applyPreserve(view, true)

    expect(replaceNextCommand(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('abc')
    expect(view.state.selection.main.from).toBe(1)
  })

  it('整篇只有一个匹配时也能替换，选区停在替换结果上（没有「下一处」可跳）', () => {
    const view = makeView('abc', [1, 2])
    applyQuery(view, { search: 'b', replace: 'XYZ' })
    applyPreserve(view, true)

    expect(replaceNextCommand(view)).toBe(true)
    // 保留大小写开着：匹配到的 'b' 是全小写，所以 'XYZ' 被转成 'xyz'——这正是这个开关的含义
    expect(view.state.doc.toString()).toBe('axyzc')
    // 不硬造选区，交给 CM6 按 changes 映射：原来选中的 b 变成了 xyz，选区跟着覆盖它
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('xyz')
  })
})

describe('自建面板', () => {
  function panelOf(view: EditorView) {
    const panel = view.dom.querySelector('.cm-search')
    expect(panel, '面板应当已经挂进 DOM').not.toBeNull()
    return panel!
  }

  function input(panel: Element, name: string) {
    const field = panel.querySelector<HTMLInputElement>(`[name=${name}]`)
    expect(field, `找不到 [name=${name}]`).not.toBeNull()
    return field!
  }

  it('结构照抄 CM6：main-field 在查找框上，四个开关与六个按钮齐活', () => {
    const view = makeView('abc')
    expect(openSearchPanel(view)).toBe(true)
    const panel = panelOf(view)

    // openSearchPanel 靠 querySelector('[main-field]') 找输入框，少了它面板打不开也聚焦不了
    expect(panel.querySelector('[main-field]')).toBe(input(panel, 'search'))
    for (const name of ['search', 'replace']) expect(input(panel, name).classList.contains('cm-textfield')).toBe(true)
    for (const name of ['case', 're', 'word', 'preserveCase']) {
      expect(input(panel, name).type, name).toBe('checkbox')
    }
    for (const name of ['next', 'prev', 'select', 'replace', 'replaceAll', 'close']) {
      expect(panel.querySelector(`button[name=${name}]`), name).not.toBeNull()
    }
    // form="" 必须是 attribute：它在 IDL 里是 readonly，当属性赋值会在严格模式下抛
    expect(input(panel, 'search').getAttribute('form')).toBe('')

    // `cm-panel` 是 CM6 的面板插件自己加的，加完 `.cm-panel.cm-search` 才命中——
    // search() 的 baseTheme 正是按这个选择器上色的，照抄 class 名换到的就是这套样式
    expect(panel.classList.contains('cm-panel')).toBe(true)
    // 面板自己声明了 top = true（刻意不走 search({ top }) 配置，免得两处各说一套）
    expect(panel.parentElement?.className).toContain('cm-panels-top')
  })

  it('在查找框里打字就把查询写回 state', () => {
    const view = makeView('abc')
    openSearchPanel(view)
    const field = input(panelOf(view), 'search')

    field.value = 'abc'
    field.dispatchEvent(new Event('change'))
    expect(getSearchQuery(view.state).search).toBe('abc')

    field.value = 'xyz'
    field.dispatchEvent(new KeyboardEvent('keyup'))
    expect(getSearchQuery(view.state).search).toBe('xyz')
  })

  it('勾上正则就把「保留大小写」禁用并取消勾选——禁用却仍打勾是最容易被误解的状态', () => {
    const view = makeView('abc')
    openSearchPanel(view)
    const panel = panelOf(view)
    const re = input(panel, 're')
    const preserve = input(panel, 'preserveCase')

    preserve.checked = true
    preserve.dispatchEvent(new Event('change'))
    expect(view.state.field(preserveCase)).toBe(true)

    re.checked = true
    re.dispatchEvent(new Event('change'))
    expect(preserve.disabled).toBe(true)
    expect(preserve.checked).toBe(false)
    expect(view.state.field(preserveCase)).toBe(false)
    expect(getSearchQuery(view.state).regexp).toBe(true)

    re.checked = false
    re.dispatchEvent(new Event('change'))
    expect(preserve.disabled).toBe(false)
  })

  it('查找选中词：打开面板时把当前选区填进查找框', () => {
    // 这条是 CM6 defaultQuery 自带的，测试钉住它是为了确认自建面板没把它弄丢
    const view = makeView('hello world', [0, 5])
    openSearchPanel(view)
    expect(input(panelOf(view), 'search').value).toBe('hello')
    expect(getSearchQuery(view.state).search).toBe('hello')
  })

  it('开关状态挂在 EditorState 上：关掉再打开面板，勾选还在', () => {
    const view = makeView('abc')
    openSearchPanel(view)
    const preserve = input(panelOf(view), 'preserveCase')
    preserve.checked = true
    preserve.dispatchEvent(new Event('change'))
    expect(view.state.field(preserveCase)).toBe(true)

    expect(closeSearchPanel(view)).toBe(true)
    expect(view.dom.querySelector('.cm-search')).toBeNull()

    openSearchPanel(view)
    expect(input(panelOf(view), 'preserveCase').checked).toBe(true)
  })

  it('别处改 state 时面板把控件同步回来', () => {
    const view = makeView('abc')
    openSearchPanel(view)
    applyQuery(view, { search: 'zzz', replace: 'yyy', caseSensitive: true, wholeWord: true })
    applyPreserve(view, true)

    const panel = panelOf(view)
    expect(input(panel, 'search').value).toBe('zzz')
    expect(input(panel, 'replace').value).toBe('yyy')
    expect(input(panel, 'case').checked).toBe(true)
    expect(input(panel, 'word').checked).toBe(true)
    expect(input(panel, 'preserveCase').checked).toBe(true)
  })

  it('别处把查询改成正则时，面板里的「保留大小写」跟着禁用', () => {
    const view = makeView('abc')
    openSearchPanel(view)
    applyPreserve(view, true)
    applyQuery(view, { search: 'a.c', regexp: true })

    const preserve = input(panelOf(view), 'preserveCase')
    expect(preserve.disabled).toBe(true)
    expect(preserve.checked).toBe(false)
  })

  it('关闭按钮真的能关掉面板', () => {
    const view = makeView('abc')
    openSearchPanel(view)
    const close = panelOf(view).querySelector<HTMLButtonElement>('button[name=close]')!
    close.click()
    expect(view.dom.querySelector('.cm-search')).toBeNull()
  })
})
