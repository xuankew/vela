/**
 * 「这份文档里有哪些可以跳的地方」（M2-E-4，`Cmd+R`）。
 *
 * 与 `src/search/reveal.ts` 同一套分工：**这一半刻意不认识 CodeMirror**。入参是只有
 * `sliceString` 的结构类型（CM6 的 `Text` 天然满足），节点是已经摘出来的 `{name, from, to}`。
 * 于是「标题文字抠得对不对」这件全是字符串边界的事能在 node 环境里穷举，
 * 不必先造一个真的 `EditorState`，也不会把「抠错了」与「语法树没解析完」两种失败混在一条用例里。
 * 认识 CM6 的那一半在 `./syntax.ts`，薄得只剩一次 `tree.iterate` 加一句「语法装上了没有」。
 *
 * ## Markdown 标题之外还有一张代码符号表
 *
 * 标题那一半不需要任何语言知识：ATX / Setext 的节点名里就写着级别。代码那一半是
 * 一张按**「节点名 + 直系父节点名」**建的规则表（`CODE_RULES`），只覆盖 TS/JS、Java、
 * Python、Rust、Go、C/C++ 这十种 label，其余语言一律回 `unsupported`，
 * 由浮层如实说「这个语言还没有符号表」。
 *
 * ⛔ 不能退化成全文搜索：那会让 `Cmd+R` 与 `Cmd+Shift+F` 变成两个入口一个行为，
 * 而用户按 `Cmd+R` 时想要的是**结构**。
 *
 * 这张表 ⛔ **不是**「代码智能」，它与 LSP 的差别是全部的差别：只看名字落在哪儿，
 * 不做作用域解析、不看类型、不跨文件。所以它零常驻内存、零依赖、一次语法树遍历就算完，
 * 而这三条正是 `Cmd+R` 能存在的理由。
 */

/** 一个已经从语法树上摘下来的节点。`name` 是 Lezer 的节点名，不是标题文字 */
export interface SymbolNode {
  readonly name: string
  readonly from: number
  readonly to: number
}

/**
 * 代码符号要多带一个**直系父节点名**（根节点没有父，传空串）。
 *
 * 只有节点名不够用：Rust 的 `TypeIdentifier` 既是 `struct Point` 的名字也是 `Vec<T>` 里
 * 那个类型引用，Go 的 `DefName` 既是函数名也是参数名。区分这两者的信息全在父节点上
 * （`StructItem` 对 `Parameter`），而父节点名是唯一一个**跨语法稳定**的东西。
 */
export interface CodeSymbolNode extends SymbolNode {
  readonly parent: string
}

/** CM6 `Text` 的一个最小结构子集：只用到「把这段位置读成字符串」 */
export interface SymbolDoc {
  sliceString(from: number, to: number): string
}

/** 符号表里的一行 */
export interface DocSymbol {
  /** 显示用的文字：标题是去掉井号的那一行，代码符号是标识符本身 */
  readonly name: string
  /** 标题是 1–6，浮层按它缩进让结构一眼看得出层级；代码符号恒 0，见 `CODE_RULES` 上面那段 */
  readonly level: number
  /** 这个名字**在文档里的起点**，交给 `EditorController.reveal` 用 */
  readonly pos: number
}

/**
 * `Cmd+R` 的三种结局。
 *
 * 刻意是个带 `kind` 的联合而不是 `DocSymbol[] | null`：`null` 说不清是
 * 「这个语言没有符号表」还是「有，但一个符号都没有」——前者该提示、后者该显示空列表，
 * 两种 UI 文案完全不同，合成一个值就只能在调用点靠猜。
 *
 * `headings` 与 `code` 分开而不是并成一个 `items`：浮层底下那句量词跟着它们走
 * （「3 个标题」对「12 个符号」），而那是这一份清单唯一的区别。
 */
export type SymbolTable =
  | { readonly kind: 'headings'; readonly items: readonly DocSymbol[] }
  | { readonly kind: 'code'; readonly items: readonly DocSymbol[] }
  /** `label` 直接取自 `languageFor(path).label`，也就是状态栏上显示的那个语言名 */
  | { readonly kind: 'unsupported'; readonly label: string }

/**
 * 节点名 → 标题级别。
 *
 * Setext 的级别**已经写在节点名里**了（`@lezer/markdown` 分 `SetextHeading1` / `SetextHeading2`），
 * 所以不用去嗅下划线是 `=` 还是 `-`——那是把解析器已经做过的事再做一遍，而且做得更差
 * （`===` 与 `-` 的判定还要考虑惰性链接 `foo\n- bar`）。
 */
const HEADING_LEVEL: Readonly<Record<string, number>> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
}

/** 这个节点名是不是标题；不是就回 `null`。语法树遍历那一半靠它决定要不要摘 */
export function headingLevel(nodeName: string): number | null {
  const level = HEADING_LEVEL[nodeName]
  return level === undefined ? null : level
}

/**
 * ATX 标题的文字部分。
 *
 * 照着 CommonMark 的两条规则做，而不是「把井号都删了」：
 * - 开井号串后面**可以没有空白**（`#Title` 不是标题，但 `#\tTitle` 是，所以吃 `[ \t]*`）
 * - 闭井号串**必须前面有空白**，所以 `### C#` 的尾巴不是闭合串而是标题内容的一部分。
 *   这条最容易写错：写成 `/#+$/` 会把 `### C#` 抠成 `### C`，而 `C#` 恰好是个真语言名。
 */
function atxTitle(raw: string): string {
  let body = raw.replace(/^#+/, '')
  const closing = body.match(/[ \t]+#+[ \t]*$/)
  if (closing !== null && closing.index !== undefined) body = body.slice(0, closing.index)
  return normalize(body)
}

/**
 * Setext 标题的文字部分。
 *
 * 节点覆盖「正文 + 下划线」**两行**（`Title\n===`），所以标题文字只到最后一个换行之前。
 * 正文本身还可以跨多行（段落式 Setext），那些换行按下面 `normalize` 的规则压成空格。
 */
function setextTitle(raw: string): string {
  const cut = raw.lastIndexOf('\n')
  return normalize(cut < 0 ? raw : raw.slice(0, cut))
}

/** 列表里的一行不能有换行，但标题内部的空格是内容，所以只压换行、不压空格 */
function normalize(text: string): string {
  return text.replace(/\n+/g, ' ').trim()
}

/**
 * 把摘下来的节点翻译成符号表。顺序**就是文档顺序**，不重排：
 * `Cmd+R` 列的是结构，而结构的信息量一半在层级、一半在先后。
 *
 * 空标题（`###` 后面什么都没有）直接跳过——浮层里一行空白既点不出东西也读不出意思。
 */
export function symbolsFrom(nodes: readonly SymbolNode[], doc: SymbolDoc): DocSymbol[] {
  const out: DocSymbol[] = []
  for (const node of nodes) {
    const level = headingLevel(node.name)
    if (level === null) continue
    const raw = doc.sliceString(node.from, node.to)
    const name = node.name.startsWith('ATX') ? atxTitle(raw) : setextTitle(raw)
    if (name === '') continue
    out.push({ name, level, pos: node.from })
  }
  return out
}

/** 一条代码符号规则。`parents` 是**直系父节点**的名字清单，不是祖先链 */
export interface CodeRule {
  readonly node: string
  readonly parents: readonly string[]
}

/** TS / JS 那一套（`@lezer/javascript`），四种 label 共用 */
const SCRIPT_RULES: readonly CodeRule[] = [
  // 类名、函数名、命名空间名、`const` / `let` / `var`（含解构出来的那几个）
  {
    node: 'VariableDefinition',
    parents: [
      'ClassDeclaration',
      'FunctionDeclaration',
      'NamespaceDeclaration',
      'VariableDeclaration',
      'ArrayPattern',
      'ObjectPattern',
    ],
  },
  // 方法、字段、以及 interface / 类型字面量里的属性
  { node: 'PropertyDefinition', parents: ['MethodDeclaration', 'PropertyDeclaration', 'PropertyType'] },
  // `interface` / `type` / `enum` 的名字。泛型参数 `<T>` 的父节点是 `TypeParamList`，不收
  { node: 'TypeDefinition', parents: ['InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration'] },
  // 枚举成员
  { node: 'PropertyName', parents: ['EnumBody'] },
]

/** C 与 C++ 共用：`@lezer/cpp` 是 `@lezer/c` 的超集，声明节点名两边一致 */
const CPP_RULES: readonly CodeRule[] = [
  {
    node: 'TypeIdentifier',
    parents: [
      'StructSpecifier',
      'UnionSpecifier',
      'EnumSpecifier',
      'ClassSpecifier',
      'TypeDefinition',
      'AliasDeclaration',
    ],
  },
  // 函数名（C++ 的方法声明同形，父节点都是 `FunctionDeclarator`）、枚举常量、命名空间、
  // 以及全局/局部的变量名（`InitDeclarator`）
  { node: 'Identifier', parents: ['FunctionDeclarator', 'Enumerator', 'NamespaceDefinition', 'InitDeclarator'] },
  // 结构体字段与 C++ 的类成员方法
  { node: 'FieldIdentifier', parents: ['FieldDeclaration', 'FunctionDeclarator'] },
]

/**
 * 代码符号的规则表：命中 `node` 这个节点名，**且**它的直系父节点名在 `parents` 里。
 *
 * ## 每张表都是拿真语法树量出来的
 *
 * 节点名不是推测的。`./syntax.test.ts` 里逐个语言用 `languageFor(path).description.load()`
 * 真加载语法包、真解析一段样例，把「哪种声明产出哪个节点名、父节点是谁」钉成了用例，
 * 所以下面每一条都能在测试里找到对应的那一行文档。语法包升级改了节点名，那条测试会红。
 *
 * ## 两条一以贯之的口径
 *
 * - **参数与导入一律不进表**。它们不是「跳过去读代码」的落点，而它们与真正的声明
 *   共用同一个节点名（Go 的 `DefName`、C++ 的 `Identifier`、TS 的 `VariableDefinition`），
 *   所以只能靠父节点把它们挡在外面——这就是 `parents` 存在的唯一理由。
 * - **函数体内的局部变量进表**。看着像噪音，但「这份文件里各个 `sum` 分别是谁」正是
 *   同文件跳转要回答的问题；而且 Python 的类属性与函数内局部变量在父节点上**同形**
 *   （都是 `AssignStatement`），要分开就得比祖先链，而十种语言比两种不值得。
 *
 * ## 平铺，不缩进
 *
 * 代码符号的 `level` 恒为 0（`codeSymbolsFrom` 里写死）。标题那 1–6 级是 CommonMark
 * 直接给出的事实，而代码的嵌套层级要从祖先链算——`ClassBody` 里第几层、命名空间里第几层，
 * 每种语言都得单独调一遍，算错还会缩进出一个**看起来很像**的错结构。
 * v1 靠输入框过滤（`@wor`），不靠缩进看图。
 */
const CODE_RULES: Readonly<Record<string, readonly CodeRule[] | undefined>> = {
  // TS 与 JS 是同一套语法树（`@lezer/javascript`），所以四种 label 共用一张表
  TypeScript: SCRIPT_RULES,
  TSX: SCRIPT_RULES,
  JavaScript: SCRIPT_RULES,
  JSX: SCRIPT_RULES,

  Java: [
    // Java 把「这里是声明的名字」做成了一个专门的节点名 `Definition`，父节点说清是哪一种
    {
      node: 'Definition',
      parents: ['ClassDeclaration', 'InterfaceDeclaration', 'EnumDeclaration', 'RecordDeclaration'],
    },
    { node: 'Definition', parents: ['MethodDeclaration', 'ConstructorDeclaration', 'EnumConstant'] },
    // 字段与局部变量都挂在 `VariableDeclarator` 下（见上面那条口径）
    { node: 'Definition', parents: ['VariableDeclarator'] },
  ],

  Python: [
    // Python 没有「定义名」这种节点：`VariableName` 既是定义也是使用，全靠父节点分
    { node: 'VariableName', parents: ['ClassDefinition', 'FunctionDefinition'] },
    // 模块常量、类属性、局部变量、`f = lambda …` 全走这一条
    { node: 'VariableName', parents: ['AssignStatement'] },
  ],

  Rust: [
    { node: 'BoundIdentifier', parents: ['FunctionItem', 'ConstItem', 'StaticItem', 'ModItem', 'LetDeclaration'] },
    // `impl Area for Shape` 那两个 `TypeIdentifier` 的父节点是 `ImplItem`，刻意不收：
    // 那是**引用**别处的类型，跳过去看到的还是那两个名字本身
    { node: 'TypeIdentifier', parents: ['StructItem', 'EnumItem', 'UnionItem', 'TraitItem', 'TypeItem'] },
    { node: 'FieldIdentifier', parents: ['FieldDeclaration'] },
    { node: 'Identifier', parents: ['EnumVariant'] },
  ],

  Go: [
    // `VarDecl` 是 `b := 1` 那种函数体内的短声明，`VarSpec` 才是顶层的 `var G int`
    { node: 'DefName', parents: ['FunctionDecl', 'MethodDecl', 'TypeSpec', 'ConstSpec', 'VarSpec', 'VarDecl'] },
    // `FieldName` 同时管结构体字段**和**接口方法、以及方法名本身
    { node: 'FieldName', parents: ['FieldDecl', 'MethodDecl', 'MethodElem'] },
  ],

  C: CPP_RULES,
  'C++': CPP_RULES,
}

/**
 * 这个语言有没有代码符号表。`null` = 没有，调用方据此回 `unsupported`。
 *
 * ⚠️ 收的是 `languageFor(path).label`，也就是状态栏那一栏的字。这个名字同时是
 * `language-data` 的 `LanguageDescription.name`，两边只会不一致一次——就是它改名那次，
 * 而 `./syntax.test.ts` 里那几条按 label 断言的用例当场会红。
 */
export function codeRulesFor(label: string): readonly CodeRule[] | null {
  return CODE_RULES[label] ?? null
}

/**
 * 把摘下来的节点翻译成代码符号表，顺序**就是文档顺序**。
 *
 * 与 `symbolsFrom` 同一套分工：这里只做「按规则表挑 + 抠字符串」，
 * 遍历语法树那一步在 `./syntax.ts`。
 */
export function codeSymbolsFrom(
  nodes: readonly CodeSymbolNode[],
  doc: SymbolDoc,
  rules: readonly CodeRule[],
): DocSymbol[] {
  const out: DocSymbol[] = []
  for (const node of nodes) {
    if (!matchesCodeRule(node.name, node.parent, rules)) continue
    const name = normalize(doc.sliceString(node.from, node.to))
    if (name === '') continue
    out.push({ name, level: 0, pos: node.from })
  }
  return out
}

/** 这个「节点名 + 父节点名」的组合在不在表里 */
export function matchesCodeRule(nodeName: string, parent: string, rules: readonly CodeRule[]): boolean {
  for (const rule of rules) {
    if (rule.node === nodeName && rule.parents.includes(parent)) return true
  }
  return false
}

/**
 * 按输入过滤符号表。
 *
 * ⚠️ 这里是**大小写不敏感的子串匹配**，刻意不做模糊匹配、也不打分排序。
 * 文件那一半的模糊匹配在 Rust（`vela_core::project::index`），如果这里再写一套 TS 的
 * 打分器，同一个 `Cmd+P` 浮层里切一下前缀就会换一套排序规则——
 * 两边对不上比哪一边不准都难受。子串匹配是「没有第二种解释」的那一个。
 *
 * 空串回全表：`Cmd+R` 刚打开时输入框是空的，那时该列出全部符号。
 */
export function filterSymbols(items: readonly DocSymbol[], needle: string): DocSymbol[] {
  if (needle === '') return [...items]
  const lower = needle.toLowerCase()
  return items.filter((item) => item.name.toLowerCase().includes(lower))
}

/**
 * 清单里有没有**就叫这个名字**的符号；有多个时回文档里最早的那一个。
 *
 * 给「跳到定义」（`Mod+Alt+D`）用，而它与上面的 `filterSymbols` 刻意不是同一个匹配：
 * 浮层里用户是在**找**，子串、不区分大小写都对；这里是**跳**，模糊一下就会把 `get`
 * 跳到 `getName` 上——那不是跳转而是猜，而猜错的跳转比不跳更糟（他得自己找回原来的位置）。
 * 大小写同理：标识符是大小写敏感的，`Widget` 与 `widget` 在代码里就是两个东西。
 *
 * 重名回最早那一个，不回「最近的那一个」：后者要先算作用域，而作用域解析是 LSP 的活，
 * 这张表的口径写在文件头。同一个名字在这份文件里出现两次（比如 C++ 的头文件声明与实现）
 * 时，用户按第二次还能再按一次 `Cmd+R` 自己挑——所以这里不需要一个更聪明的规则。
 */
export function findSymbol(items: readonly DocSymbol[], name: string): DocSymbol | null {
  for (const item of items) {
    if (item.name === name) return item
  }
  return null
}
