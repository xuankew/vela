import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { symbolTable } from './syntax'

/**
 * 与 `src/editor/setup.ts:303` **逐字相同**的 Markdown 扩展。
 *
 * 不用 `buildExtensions` 是因为它会连 keymap、主题、ViewPlugin 一起装上，而这里只关心语法树；
 * 但也**不能**只挂 `markdown()`——`codeLanguages` 决定了围栏里的内容归不归子语言管，
 * 下面那条「围栏里的 `# 假的` 不进表」的用例少了它就测不到真形状。
 */
function mdState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, codeLanguages: languages }) })
}

describe('symbolTable：Markdown 文档', () => {
  it('ATX 与 Setext 混着也能一起列出来，顺序是文档顺序', () => {
    const doc = '# 甲\n\n正文一段。\n\n乙\n---\n\n## 丙\n'
    const table = symbolTable(mdState(doc), '/repo/a.md')
    expect(table).toEqual({
      kind: 'headings',
      items: [
        { name: '甲', level: 1, pos: 0 },
        { name: '乙', level: 2, pos: doc.indexOf('乙') },
        { name: '丙', level: 2, pos: doc.indexOf('## 丙') },
      ],
    })
  })

  it('pos 指向标题本身，Setext 的也是正文那一行而不是下划线', () => {
    // 跳过去要落在标题上。落在 `---` 那行的话 `scrollIntoView({y:'center'})`
    // 会把正文顶到屏幕中间、标题被推出视口，用户看不到自己跳到哪了
    const doc = '标题\n===\n'
    const table = symbolTable(mdState(doc), 'a.md')
    expect(table.kind === 'headings' && table.items[0]?.pos).toBe(0)
  })

  it('`.markdown` 这类同族扩展名走的是同一条路', () => {
    expect(symbolTable(mdState('# 甲\n'), 'a.markdown').kind).toBe('headings')
    expect(symbolTable(mdState('# 甲\n'), 'a.mdown').kind).toBe('headings')
  })

  it('未命名文档（path 为 null）也有符号表', () => {
    // `languageFor(null)` 回 Markdown，因为「新建标签随手写点东西」最可能写的就是笔记。
    // 这里只是继承那条默认值：新建的标签写几个标题再按 `Cmd+R` 是**有**结果的
    expect(symbolTable(mdState('# 甲\n'), null)).toEqual({
      kind: 'headings',
      items: [{ name: '甲', level: 1, pos: 0 }],
    })
  })

  it('一个标题都没有时是空表，不是 unsupported', () => {
    // 两种「没东西」在 UI 上是两句话：「这份文档没有标题」与「这个语言还没有符号表」。
    // 混成一个值就只能靠猜
    expect(symbolTable(mdState('全是正文，没有标题。\n'), 'a.md')).toEqual({ kind: 'headings', items: [] })
    expect(symbolTable(mdState(''), 'a.md')).toEqual({ kind: 'headings', items: [] })
  })

  it('围栏代码块里的 `# 假的` 不进表', () => {
    // ```markdown 这种带语言名的围栏会把内容交给子语言，而子语言里的 `# 假的`
    // 是**那个块**的标题、不是这份文档的。把它列出来的话点过去会跳到一段代码里
    const doc = '```markdown\n# 假的\n```\n\n# 真的\n'
    expect(symbolTable(mdState(doc), 'a.md')).toEqual({
      kind: 'headings',
      items: [{ name: '真的', level: 1, pos: doc.indexOf('# 真的') }],
    })
  })
})

describe('symbolTable：非 Markdown 一律如实说没有', () => {
  // 刻意传一个**空的、连语言都没挂**的 state：unsupported 那一步在读语法树之前就返回了，
  // 于是这棵树长什么样根本不影响结果。真文档里这些 state 是挂着对应语言的
  const bare = (doc = 'const x = 1\n'): EditorState => EditorState.create({ doc })

  it.each([
    ['/repo/a.ts', 'TypeScript'],
    ['/repo/a.rs', 'Rust'],
    ['/repo/a.json', 'JSON'],
    ['/repo/a.css', 'CSS'],
    // 没匹配上的扩展名走 plain，label 是给人看的「纯文本」
    // ⚠️ 用的是 `language.test.ts` 已经钉住的那两个：`.conf` 之类没被钉过的扩展名
    // 哪天被 language-data 收了（TOML / Properties 都收过一批），这里的期望就会跟着漂
    ['/repo/a.log', '纯文本'],
    ['/repo/a.csv', '纯文本'],
  ])('%s → unsupported，label 是 %s', (path, label) => {
    expect(symbolTable(bare(), path)).toEqual({ kind: 'unsupported', label })
  })

  it('label 取自 languageFor，也就是状态栏上显示的那个名字', () => {
    // 浮层里那句话是「TypeScript 还没有符号表」。名字必须与状态栏一致，
    // 否则用户会以为是两个不同的东西
    const table = symbolTable(bare(), '/repo/a.ts')
    expect(table.kind === 'unsupported' && table.label).toBe('TypeScript')
  })
})

describe('symbolTable：语法树可能只解析了一半', () => {
  /** 一段填充正文，用来把最后一个标题推到解析器一次跑不到的地方 */
  const FILLER = '凑够行数让解析器跟不上的正文。\n\n'

  /**
   * 造一份**解析器一次跑不完**的文档。
   *
   * 全新的 state 上 `syntaxTree(state)` 只覆盖**固定的 3016 个字符**——实测这个数与文档
   * 大小无关（400 段、2000 段、8000 段都是 3016），所以它不是个时间量、不会随机器快慢漂，
   * 下面的断言因此是确定的。
   */
  function longDoc(paras: number): { doc: string; state: EditorState } {
    const doc = `# 头一个\n\n${FILLER.repeat(paras)}# 最后一个\n`
    return { doc, state: mdState(doc) }
  }

  it('最后一个标题也在表里——这是 ensureSyntaxTree 存在的唯一理由', () => {
    // 1000 段 ≈ 2.3 万字符，最后一个标题在 3016 之外老远；实测这份文档
    // `ensureSyntaxTree` 只需 7ms 左右，离 50ms 的预算有七倍余量
    const { doc, state } = longDoc(1000)
    expect(doc.indexOf('# 最后一个')).toBeGreaterThan(3016)

    const table = symbolTable(state, 'a.md')
    expect(table.kind === 'headings' && table.items.map((s) => s.name)).toEqual(['头一个', '最后一个'])
    expect(table.kind === 'headings' && table.items[1]?.pos).toBe(doc.indexOf('# 最后一个'))
  })

  it('⚠️ 直接用 syntaxTree(state) 会**静默**少一条', () => {
    // 这条用例是上一条的**反向证据**：它钉住「ensureSyntaxTree 不是可有可无的保险」。
    // 少了它，`ensureSyntaxTree(...) ?? syntaxTree(...)` 会被下一个人简化成
    // `syntaxTree(...)`，所有正向用例照样绿，而 `Cmd+R` 在大文档上少列标题——
    // 不报错、不空列表，只是安静地少几行，正是最难发现的那类退化
    const { doc, state } = longDoc(1000)
    const partial = syntaxTree(state)
    expect(partial.length).toBeLessThan(doc.length)

    const found: string[] = []
    partial.iterate({
      enter: (n) => {
        if (n.name.startsWith('ATXHeading')) found.push(n.name)
      },
    })
    expect(found).toEqual(['ATXHeading1'])
  })

  it('撞到解析预算时退回半截的树，宁可少列也不要空着', () => {
    // `?? syntaxTree(state)` 那半截兜底。10 万段 ≈ 200 万字符，实测要 380ms 才解析得完，
    // 于是 50ms 的预算必然撞穿、`ensureSyntaxTree` 回 `null`——这种文档在 M2-H 的
    // 只读分片里另有安排，这里只关心浮层不会因此整个空掉。
    //
    // ⚠️ 只断言「第一个标题在」，**不**断言「最后一个不在」：后者取决于这台机器有多快，
    // 「50ms 内能不能解析完 200 万字符」是个测量问题而不是逻辑问题，钉住它只会换来 CI 上的偶发红
    const table = symbolTable(longDoc(100_000).state, 'a.md')
    expect(table.kind).toBe('headings')
    if (table.kind === 'headings') {
      expect(table.items[0]).toEqual({ name: '头一个', level: 1, pos: 0 })
    }
  })
})
