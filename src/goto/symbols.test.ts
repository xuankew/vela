import { describe, expect, it } from 'vitest'
import {
  codeRulesFor,
  codeSymbolsFrom,
  filterSymbols,
  findSymbol,
  headingLevel,
  matchesCodeRule,
  symbolsFrom,
  type CodeRule,
  type CodeSymbolNode,
  type DocSymbol,
  type SymbolDoc,
  type SymbolNode,
} from './symbols'

/**
 * 手搓的 `SymbolDoc`。
 *
 * 这一层测试**不 import CodeMirror**——`symbols.ts` 之所以收结构类型而不是 `Text`，
 * 唯一的目的就是让这里能用一行 `slice` 顶掉整个 CM6。真文档那一半在 `./syntax.test.ts`。
 */
function docOf(text: string): SymbolDoc {
  return { sliceString: (from, to) => text.slice(from, to) }
}

/**
 * 按「原文里的那一段」造节点，省掉手算偏移量。
 *
 * 找不到就抛：用例写错了该红在用例上，而不是变成一个 `from = -1` 的节点去考 `symbolsFrom`
 * 的健壮性——那玩意儿收的是**语法树**给的节点，语法树不会给它负数。
 */
function nodeIn(text: string, raw: string, name: string): SymbolNode {
  const from = text.indexOf(raw)
  if (from < 0) throw new Error(`用例写错了：${JSON.stringify(raw)} 不在 ${JSON.stringify(text)} 里`)
  return { name, from, to: from + raw.length }
}

/** 「整份文档就是一个标题节点」这个最常见形状的简写 */
function one(text: string, name: string): DocSymbol[] {
  return symbolsFrom([nodeIn(text, text, name)], docOf(text))
}

describe('headingLevel：八个节点名，一个不多一个不少', () => {
  it.each([
    ['ATXHeading1', 1],
    ['ATXHeading2', 2],
    ['ATXHeading3', 3],
    ['ATXHeading4', 4],
    ['ATXHeading5', 5],
    ['ATXHeading6', 6],
    ['SetextHeading1', 1],
    ['SetextHeading2', 2],
  ])('%s → %i', (name, level) => {
    expect(headingLevel(name)).toBe(level)
  })

  it('其他节点名一律回 null', () => {
    // `ATXHeading7` 不存在（CommonMark 到 6 级封顶），`HeaderMark` 是标题里那串井号本身，
    // `Section` 是 lezer 给标题+正文包的那一层——把 Section 也算进去会让每个标题出现两次
    for (const name of ['Paragraph', 'HeaderMark', 'Section', 'ATXHeading7', 'FencedCode', 'Document', '']) {
      expect(headingLevel(name), name).toBe(null)
    }
  })

  it('Setext 的级别写在节点名里，所以不用嗅下划线是 = 还是 -', () => {
    // 自己判 `=`/`-` 就是把解析器已经做过的事再做一遍，而且做得更差：
    // `foo\n- bar` 里的 `- bar` 是列表项而不是下划线，只有 Lezer 分得清
    expect(headingLevel('SetextHeading1')).not.toBe(headingLevel('SetextHeading2'))
  })
})

describe('symbolsFrom：ATX 标题的文字部分', () => {
  // [原文, 节点名里的级别, 期望的标题文字]
  const cases: [string, number, string][] = [
    ['# 甲', 1, '甲'],
    ['## 甲', 2, '甲'],
    ['###### 六级', 6, '六级'],
    ['#\t制表符开头', 1, '制表符开头'],
    ['#  两个空格', 1, '两个空格'],
    ['### 闭合 ###', 3, '闭合'],
    ['###  闭合带空格  ##  ', 3, '闭合带空格'],
    ['### a ## b ###', 3, 'a ## b'],
    ['# a  b', 1, 'a  b'],
  ]

  it.each(cases)('%s → %s', (raw, level, name) => {
    expect(one(raw, `ATXHeading${level}`)).toEqual([{ name, level, pos: 0 }])
  })

  it('闭合井号串**必须**前面有空白，所以 `### C#` 抠出来是 C#', () => {
    // 写成 `/#+$/` 会得到 `C`，而 `C#` 恰好是个真语言名、`F#` 也是。
    // 这条是 atxTitle 里最容易写错的一行，单独钉住
    expect(one('### C#', 'ATXHeading3')).toEqual([{ name: 'C#', level: 3, pos: 0 }])
    expect(one('### F#', 'ATXHeading3')).toEqual([{ name: 'F#', level: 3, pos: 0 }])
    // 同理，紧贴着正文的那串井号不是闭合串
    expect(one('### 闭合###', 'ATXHeading3')).toEqual([{ name: '闭合###', level: 3, pos: 0 }])
  })

  it('全是井号的标题抠完是空的，整条不进表', () => {
    // CommonMark 里 `### ###` 的内容确实是空的（后一串是闭合串）。
    // 浮层里一行空白既点不出东西也读不出意思，跳过比留一条幽灵行好
    expect(one('### ###', 'ATXHeading3')).toEqual([])
    expect(one('#', 'ATXHeading1')).toEqual([])
    expect(one('###   ', 'ATXHeading3')).toEqual([])
  })

  it('level 取自节点名，不是数井号数出来的', () => {
    // 节点名与原文里的井号数不一致时**信节点名**：Lezer 才是解析器，
    // 七个井号的行它按 CommonMark 的封顶规则当成六级标题。
    // 这里若改成「数井号」，level 会变成 7，浮层缩进就跑到表外面去了
    expect(one('####### 七个井号', 'ATXHeading6')).toEqual([{ name: '七个井号', level: 6, pos: 0 }])
  })
})

describe('symbolsFrom：Setext 标题', () => {
  it('节点覆盖「正文 + 下划线」两行，文字只到最后一个换行之前', () => {
    expect(one('标题\n===', 'SetextHeading1')).toEqual([{ name: '标题', level: 1, pos: 0 }])
    expect(one('二级标题\n---', 'SetextHeading2')).toEqual([{ name: '二级标题', level: 2, pos: 0 }])
  })

  it('正文可以跨多行，那些换行压成一个空格', () => {
    // 段落式 Setext 是真存在的写法。列表里的一行不能有换行，
    // 但**空格是标题内容**，所以只压换行、不压空格
    expect(one('第一行\n第二行\n===', 'SetextHeading1')).toEqual([{ name: '第一行 第二行', level: 1, pos: 0 }])
  })

  it('pos 指向正文首字，不是下划线那一行', () => {
    // 跳过去要落在**标题上**。落在 `===` 那行的话光标在下面，
    // 而 `scrollIntoView({y:'center'})` 会把正文顶到中间、标题被推出视口
    const text = '甲\n===\n\n乙\n---\n'
    const items = symbolsFrom(
      [nodeIn(text, '甲\n===', 'SetextHeading1'), nodeIn(text, '乙\n---', 'SetextHeading2')],
      docOf(text),
    )
    expect(items).toEqual([
      { name: '甲', level: 1, pos: 0 },
      { name: '乙', level: 2, pos: text.indexOf('乙') },
    ])
  })

  it('节点里万一没有换行，整段就是标题', () => {
    // 真的 SetextHeading 节点一定跨两行（正文 + 下划线），所以这条分支实际到不了。
    // 留着兜底只是为了 `lastIndexOf` 回 -1 时不要切出个空串来——那会把标题整个吃掉
    expect(one('===', 'SetextHeading1')).toEqual([{ name: '===', level: 1, pos: 0 }])
  })
})

describe('symbolsFrom：整表的形状', () => {
  it('顺序就是喂进来的顺序，不重排也不排序', () => {
    // `Cmd+R` 列的是**结构**，而结构的信息量一半在层级、一半在先后。
    // 这里喂一个倒序的数组来钉住「不重排」：真语法树给的本来就是文档顺序，
    // 一旦有人在这里加了个 `.sort()`，倒序用例会红，正序用例则看不出来
    const text = '甲\n\n乙\n'
    const nodes = [nodeIn(text, '乙', 'ATXHeading1'), nodeIn(text, '甲', 'ATXHeading1')]
    expect(symbolsFrom(nodes, docOf(text))).toEqual([
      { name: '乙', level: 1, pos: 3 },
      { name: '甲', level: 1, pos: 0 },
    ])
  })

  it('不认识的节点名被忽略，不会抛也不会变成一行空白', () => {
    const text = '# 甲\n\n正文\n'
    const nodes = [
      nodeIn(text, '# 甲', 'ATXHeading1'),
      nodeIn(text, '正文', 'Paragraph'),
      nodeIn(text, '#', 'HeaderMark'),
    ]
    expect(symbolsFrom(nodes, docOf(text))).toEqual([{ name: '甲', level: 1, pos: 0 }])
  })

  it('空节点表回空数组', () => {
    expect(symbolsFrom([], docOf('# 甲'))).toEqual([])
  })

  it('位置是 UTF-16 码元，emoji 与 CJK 都不会错开', () => {
    // 与 `src/search/reveal.ts` 里那条「偏移量是 UTF-16 码元」是同一套单位。
    // 这里刻意用 `String.prototype.indexOf` 造节点而不是手算数字：
    // 它数的就是码元，两边同一把尺子
    const text = '# 🎉 派对\n\n# 第二个\n'
    const items = symbolsFrom([nodeIn(text, '# 🎉 派对', 'ATXHeading1')], docOf(text))
    expect(items).toEqual([{ name: '🎉 派对', level: 1, pos: 0 }])
    expect(text.indexOf('# 第二个')).toBe('# 🎉 派对\n\n'.length)
  })
})

describe('filterSymbols：大小写不敏感的**子串**匹配', () => {
  const items: DocSymbol[] = [
    { name: 'Installation', level: 1, pos: 0 },
    { name: '安装步骤', level: 2, pos: 10 },
    { name: 'API Reference', level: 2, pos: 20 },
    { name: 'Troubleshooting', level: 1, pos: 30 },
  ]

  it('空串回全表，而且是个**新数组**', () => {
    const all = filterSymbols(items, '')
    expect(all).toEqual(items)
    // 不共享引用：调用方拿到手可能会排序/切片，改到原表上就会污染下一次按键
    expect(all).not.toBe(items)
  })

  it('子串匹配，不分大小写', () => {
    expect(filterSymbols(items, 'insta').map((s) => s.name)).toEqual(['Installation'])
    // 大写的 needle 照样匹到小写的正文，而且回的是文档顺序
    expect(filterSymbols(items, 'N').map((s) => s.name)).toEqual(['Installation', 'API Reference', 'Troubleshooting'])
  })

  it('中文照样能匹', () => {
    expect(filterSymbols(items, '安装').map((s) => s.name)).toEqual(['安装步骤'])
  })

  it('结果保持文档顺序，不按匹配质量重排', () => {
    // ⚠️ 刻意**不做**模糊匹配、也**不打分**：文件那一半的模糊匹配在 Rust
    // （`vela_core::project::index`），这里再写一套 TS 打分器的话，同一个浮层里
    // 切一下前缀就换一套排序规则——两边对不上比哪一边不准都难受
    expect(filterSymbols(items, 's').map((s) => s.name)).toEqual(['Installation', 'Troubleshooting'])
  })

  it('没有匹配回空数组，不是 null', () => {
    expect(filterSymbols(items, 'zzz')).toEqual([])
  })

  it('空表回空表', () => {
    expect(filterSymbols([], 'a')).toEqual([])
    expect(filterSymbols([], '')).toEqual([])
  })
})

describe('findSymbol：精确同名，与 filterSymbols 刻意不是一套匹配', () => {
  const items: DocSymbol[] = [
    { name: 'get', level: 0, pos: 3 },
    { name: 'getName', level: 0, pos: 20 },
    { name: 'Widget', level: 0, pos: 40 },
    // 重名：C++ 的头文件声明与实现各一行，Rust 的 trait 与 impl 各一行
    { name: 'get', level: 0, pos: 99 },
  ]

  it('精确同名才命中，子串不算', () => {
    // 🔴 这一条是整段匹配规则的立足点：`get` 必须命中 `get` 而**不是** `getName`。
    // 改成模糊的话按 `Mod+Alt+D` 会跳到隔壁那个符号上——那不是跳转而是猜，
    // 而猜错的跳转比不跳更糟（用户得自己找回原来那一处）
    expect(findSymbol(items, 'get')?.pos).toBe(3)
    expect(findSymbol(items, 'Widget')?.pos).toBe(40)
    expect(findSymbol(items, 'Name')).toBeNull()
    expect(findSymbol(items, 'ge')).toBeNull()
  })

  it('大小写敏感：标识符就是大小写敏感的', () => {
    expect(findSymbol(items, 'widget')).toBeNull()
    expect(findSymbol(items, 'WIDGET')).toBeNull()
  })

  it('重名回文档里最早的那一个，不回「离光标最近的那一个」', () => {
    // 后者要先算作用域，那是 LSP 的活（口径写在 `symbols.ts` 文件头）。
    // 两个都能跳，而第一个是稳定答案——连按同一个键不会在两处之间跳来跳去
    expect(findSymbol(items, 'get')?.pos).toBe(3)
  })

  it('空清单与空串一律 null，不是「返回第一个」', () => {
    expect(findSymbol([], 'get')).toBeNull()
    expect(findSymbol(items, '')).toBeNull()
  })
})

describe('代码符号规则表：形状与命中', () => {
  /** 一条最小规则，够用来考 `matchesCodeRule` 的两个维度 */
  const rules: CodeRule[] = [{ node: 'VariableDefinition', parents: ['ClassDeclaration', 'FunctionDeclaration'] }]

  it('节点名对、父节点名不对 → 不命中（`parents` 存在的全部理由）', () => {
    expect(matchesCodeRule('VariableDefinition', 'ClassDeclaration', rules)).toBe(true)
    // 参数与导入与真正的声明**共用节点名**，只能靠父节点挡在外面
    expect(matchesCodeRule('VariableDefinition', 'Parameter', rules)).toBe(false)
    expect(matchesCodeRule('VariableDefinition', '', rules)).toBe(false)
    expect(matchesCodeRule('PropertyName', 'ClassDeclaration', rules)).toBe(false)
  })

  it('多条规则是**或**的关系，命中任一条即可', () => {
    const two: CodeRule[] = [...rules, { node: 'TypeDefinition', parents: ['InterfaceDeclaration'] }]
    expect(matchesCodeRule('TypeDefinition', 'InterfaceDeclaration', two)).toBe(true)
    // 加了规则不该让原来的命中翻掉：两张表是分语言拼起来的，改一处会牵连邻居
    expect(matchesCodeRule('VariableDefinition', 'FunctionDeclaration', two)).toBe(true)
  })

  it('十种 label 全查得到表，其余语言一律 null', () => {
    for (const label of ['TypeScript', 'TSX', 'JavaScript', 'JSX', 'Java', 'Python', 'Rust', 'Go', 'C', 'C++']) {
      expect(codeRulesFor(label)).not.toBeNull()
    }
    // 这三个是真会被 `languageFor` 回出来的 label，不是随手编的字母
    expect(codeRulesFor('JSON')).toBeNull()
    expect(codeRulesFor('CSS')).toBeNull()
    expect(codeRulesFor('纯文本')).toBeNull()
    expect(codeRulesFor('')).toBeNull()
  })

  it('每条规则的 `parents` 都非空：空清单等于「永不命中」，写错时看不出来', () => {
    // 🔴 元检查。少这一条的话，「某个 label 的符号永远是空的」这类 bug 会伪装成
    // 「这份文件里确实没有声明」，而它其实是一个手误的 `parents: []`
    for (const label of ['TypeScript', 'TSX', 'JavaScript', 'JSX', 'Java', 'Python', 'Rust', 'Go', 'C', 'C++']) {
      for (const rule of codeRulesFor(label)!) {
        expect(rule.parents.length, `${label} / ${rule.node}`).toBeGreaterThan(0)
        expect(rule.node, label).not.toBe('')
      }
    }
  })

  it('TS 与 JS 是同一张表（同一套语法树），C 与 C++ 也是', () => {
    expect(codeRulesFor('TypeScript')).toBe(codeRulesFor('JavaScript'))
    expect(codeRulesFor('C')).toBe(codeRulesFor('C++'))
    // 而 Java 不是同一张：它的节点名是 `Definition` 那一套
    expect(codeRulesFor('Java')).not.toBe(codeRulesFor('TypeScript'))
  })

  it('codeSymbolsFrom：按规则挑、抠名字、pos 指向节点起点、顺序不变', () => {
    const text = 'class A {\n  f() {}\n  p: number\n}'
    const nodes: CodeSymbolNode[] = [
      { name: 'VariableDefinition', from: 6, to: 7, parent: 'ClassDeclaration' },
      // 参数：节点名与真声明一样，靠父节点挡掉
      { name: 'VariableDefinition', from: 0, to: 0, parent: 'Parameter' },
      { name: 'PropertyName', from: 21, to: 22, parent: 'PropertyType' },
    ]
    expect(
      codeSymbolsFrom(nodes, docOf(text), [
        { node: 'VariableDefinition', parents: ['ClassDeclaration'] },
        { node: 'PropertyName', parents: ['PropertyType'] },
      ]),
    ).toEqual([
      { name: 'A', level: 0, pos: 6 },
      { name: 'p', level: 0, pos: 21 },
    ])
  })

  it('代码符号的 level 恒为 0：平铺，不缩进', () => {
    // 标题的 1–6 级是 CommonMark 直接给的事实；代码的嵌套层级要比祖先链，
    // 每种语言单独调一遍，算错会缩进出一个**看起来很像**的错结构（见 CODE_RULES 上面那段）
    const text = 'x'
    const out = codeSymbolsFrom([{ name: 'Identifier', from: 0, to: 1, parent: 'FunctionDeclarator' }], docOf(text), [
      { node: 'Identifier', parents: ['FunctionDeclarator'] },
    ])
    expect(out).toEqual([{ name: 'x', level: 0, pos: 0 }])
  })
})
