import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { languageFor } from '../editor/language'
import { symbolTable, wordUnderCaret } from './syntax'

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

/**
 * 真 loading 语法包，建一份挂着那门语言的 state。
 *
 * ⛔ 不直接 import `@codemirror/lang-javascript` 那一堆：那等于在测试里再写一份
 * 「扩展名 → 语言」的映射，而规则表收的 key 是 `languageFor(path).label`。
 * 走 `languageFor` 才测得到真链路，**包括「那个 label 在 `CODE_RULES` 里拼错了」这一类错**——
 * 拼错的表现是浮层永远说「还没有符号表」，而手搓的 import 会把它盖掉。
 */
async function codeState(path: string, doc: string): Promise<EditorState> {
  const description = languageFor(path).description
  if (description === null) throw new Error(`用例写错了：${path} 在 language-data 里没有语法包`)
  const support = await description.load()
  if (support === null) throw new Error(`用例写错了：${path} 的语法包 load() 回了 null`)
  return EditorState.create({ doc, extensions: [support] })
}

/**
 * 只比名字，不比位置。
 *
 * 位置是**偏移量**，写成数字只能靠数，而数错了看不出所以然；名字清单才是这张规则表的全部内容。
 * 位置另有专门的一条用例钉住。
 */
async function codeNames(path: string, doc: string): Promise<string[]> {
  const table = symbolTable(await codeState(path, doc), path)
  if (table.kind !== 'code') throw new Error(`期望 code，实得 ${table.kind}`)
  return table.items.map((item) => item.name)
}

describe('symbolTable：十种代码 label 都查得到规则表', () => {
  it.each(['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.java', 'a.py', 'a.rs', 'a.go', 'a.c', 'a.h', 'a.cpp', 'a.hpp'])(
    '%s → kind 是 code，而且语法包真的装上了',
    async (name) => {
      const path = `/repo/${name}`
      // 空文档也能回 `code` 而不是 `unsupported`：这一条钉的是**label 的拼写**。
      // `CODE_RULES` 收的 key 直接抄自 `languageFor(path).label`，它哪天改了名
      // （`language-data` 干过这种事），下面的 kind 就会翻成 unsupported，
      // 而症状是「那份语言的 Cmd+R 从此什么都不列，也不报错」
      const table = symbolTable(await codeState(path, ''), path)
      expect(table.kind).toBe('code')
      if (table.kind === 'code') expect(table.items).toEqual([])
    },
  )
})

describe('symbolTable：代码符号就是规则表说的那几种声明', () => {
  it('TypeScript：类 / 函数 / 方法 / 字段 / interface / type / enum 一起列，参数与导入不列', async () => {
    const doc = `import { thing } from './thing'
export const MAX = 10
const helper = (a: number, b: number) => a + b
class Animal extends Base {
  private name: string
  constructor(name: string) { this.name = name }
  speak(loud: boolean): string { return this.name }
}
function outer(x: number): void {
  function inner(y: number) {}
  const total = 1
}
interface Local { id: string }
type Alias = { id: string }
enum E { A = 1, B }
`
    // 文档顺序，一个不多一个不少：`thing` 是导入、`a`/`b`/`x`/`y`/`name`/`loud` 是参数、
    // `Base` 是继承来的名字、`this` 与 `this.name` 是使用处——四条口径各钉住一类
    expect(await codeNames('/repo/a.ts', doc)).toEqual([
      'MAX',
      'helper',
      'Animal',
      'name',
      'constructor',
      'speak',
      'outer',
      'inner',
      'total',
      'Local',
      'id',
      'Alias',
      'id',
      'E',
      'A',
      'B',
    ])
  })

  it('Java：`Definition` 那一种节点名就管着六种声明', async () => {
    const doc = `package com.example;
import java.util.List;
public class Widget extends Object implements Runnable {
  private static final int MAX = 1;
  public Widget(String name) {}
  public String speak(boolean loud) { return null; }
  interface Inner {}
  enum E { X, Y }
}
`
    expect(await codeNames('/repo/a.java', doc)).toEqual(['Widget', 'MAX', 'Widget', 'speak', 'Inner', 'E', 'X', 'Y'])
  })

  it('Python：`VariableName` 既是定义名也是使用名，全靠父节点分开', async () => {
    const doc = `import os
CONST = 1
class A(Base):
    attr = 1
    def method(self, x):
        def inner(y):
            pass
        return inner
def top(a, b=1):
    local = 2
    return local
`
    // `os` 是导入、`Base` 是继承、`self`/`x`/`y`/`a`/`b` 是参数、
    // 两个 `return` 后面的是**使用**。剩下七个全是定义
    expect(await codeNames('/repo/a.py', doc)).toEqual(['CONST', 'A', 'attr', 'method', 'inner', 'top', 'local'])
  })

  it('Rust：struct / enum / trait / fn / const / mod / 字段 / 枚举变体，`impl` 那两个名字不列', async () => {
    const doc = `use std::fmt;
const MAX: usize = 1;
static S: i32 = 2;
struct Point { x: f64, y: f64 }
enum Shape { Circle(f64), Square { side: f64 } }
trait Area { fn area(&self) -> f64; }
impl Area for Shape { fn area(&self) -> f64 { 0.0 } }
type Alias = Point;
mod ns { pub fn f() {} }
fn outer(a: i32) -> i32 {
    let b = a + 1;
    b
}
`
    // `impl Area for Shape` 上那两个名字（`TypeIdentifier p=ImplItem`）刻意**不在**结果里：
    // 那是**引用**别处声明的类型，跳过去看到的还是 `Area` / `Shape` 自己那两行。
    // 而 `impl` 里面那个 `fn area` 要收——它是一份实打实的定义，于是 `area` 出两次
    // （trait 里那一行声明、impl 里这一份实现），正如 C++ 的头文件与实现文件里同名方法各一行
    expect(await codeNames('/repo/a.rs', doc)).toEqual([
      'MAX',
      'S',
      'Point',
      'x',
      'y',
      'Shape',
      'Circle',
      'Square',
      'side',
      'Area',
      'area',
      'area',
      'Alias',
      'Point',
      'ns',
      'f',
      'outer',
      'b',
    ])
  })

  it('Go：`DefName` 管声明、`FieldName` 管字段与接口方法，接收者不列', async () => {
    const doc = `package main

import "fmt"

const Max = 10

var G int

type Shape interface {
	Area() float64
}

type Rect struct {
	W, H float64
}

func (r Rect) Area() float64 {
	return r.W
}

func outer(a int) int {
	b := a + 1
	return b
}
`
    // `main` 是 package 名（`PackageClause`）、`r` 与 `a` 是参数、`fmt` 是导入。
    // 最后那个 `b` 是**局部**短声明，它的父节点是 `VarDecl` 而不是 `VarSpec` ——
    // 少收这一个，函数里的 `:=` 就会整类漏掉
    expect(await codeNames('/repo/a.go', doc)).toEqual([
      'Max',
      'G',
      'Shape',
      'Area',
      'Rect',
      'W',
      'H',
      'Area',
      'outer',
      'b',
    ])
  })

  it('C：struct / enum / typedef / 函数 / 全局与局部变量，枚举常量也在', async () => {
    const doc = `#include <stdio.h>
struct Point { int x; int y; };
typedef struct Point Point;
enum Color { RED, GREEN };
int global = 1;
static int helper(int a, int b) { int sum = a + b; return sum; }
int main(int argc, char **argv) { return helper(argc, 0); }
`
    // `typedef struct Point Point;` 出两行 `Point` 是**决定**而不是漏判：那两个节点
    // 一个是 `StructSpecifier` 的名字、一个是 `TypeDefinition` 的别名，光看父节点分不开，
    // 而两处都是跳过去值得看的地方
    expect(await codeNames('/repo/a.c', doc)).toEqual([
      'Point',
      'x',
      'y',
      'Point',
      'Point',
      'Color',
      'RED',
      'GREEN',
      'global',
      'helper',
      'sum',
      'main',
    ])
  })

  it('C++ 与 C 共用一张表：namespace、类里的方法声明、字段都认得', async () => {
    const doc = `namespace ns {
class Widget : public Base {
public:
  static int count;
  Widget(int p);
  int run(double d) const;
};
}
struct Point { int x; };
int main(int argc, char **argv) { return 0; }
`
    // `Base` 的父节点是 `BaseClassClause`（那是继承来的名字，不是本文件的声明），
    // `p`/`d`/`argc`/`argv` 是参数 —— 与 C 同一条口径
    expect(await codeNames('/repo/a.cpp', doc)).toEqual([
      'ns',
      'Widget',
      'count',
      'Widget',
      'run',
      'Point',
      'x',
      'main',
    ])
  })

  it('pos 落在标识符本身，level 恒为 0', async () => {
    const doc = 'class A {\n  int f() { return 0; }\n}\n'
    const table = symbolTable(await codeState('/repo/a.java', doc), '/repo/a.java')
    if (table.kind !== 'code') throw new Error(`期望 code，实得 ${table.kind}`)
    expect(table.items).toEqual([
      { name: 'A', level: 0, pos: doc.indexOf('A') },
      { name: 'f', level: 0, pos: doc.indexOf('f') },
    ])
    // 平铺是 v1 的决定：浮层里每一行的缩进由 `level` 决定，全 0 就是齐齐的一列
    expect(table.items.every((item) => item.level === 0)).toBe(true)
  })
})

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

describe('symbolTable：说「还没有符号表」的两种情形', () => {
  // 同一个 `unsupported`，两条完全不同的来路。分开钉是因为它们的**修法**不一样：
  // 第一条要往 `CODE_RULES` 里加一张表，第二条什么都没得改，等语法包落地再按一次就有
  const bare = (doc = 'const x = 1\n'): EditorState => EditorState.create({ doc })

  it.each([
    ['/repo/a.json', 'JSON'],
    ['/repo/a.css', 'CSS'],
  ])('有语法包、但规则表里没有 %s：挂没挂上都回 unsupported', async (path, label) => {
    // 两种 state 都问一遍：这一条的判据是 `languageFor(path).label` 查不到表，
    // 它在读语法树**之前**就返回了，所以树长什么样根本不该影响结果
    expect(symbolTable(bare(), path)).toEqual({ kind: 'unsupported', label })
    expect(symbolTable(await codeState(path, 'const x = 1\n'), path)).toEqual({ kind: 'unsupported', label })
  })

  it.each([
    // 没匹配上的扩展名走 plain，label 是给人看的「纯文本」，连语法包都没有
    // ⚠️ 用的是 `language.test.ts` 已经钉住的那两个：`.conf` 之类没被钉过的扩展名
    // 哪天被 language-data 收了（TOML / Properties 都收过一批），这里的期望就会跟着漂
    ['/repo/a.log', '纯文本'],
    ['/repo/a.csv', '纯文本'],
  ])('%s 压根没有语法包，回 unsupported', (path, label) => {
    expect(symbolTable(bare(), path)).toEqual({ kind: 'unsupported', label })
  })

  it('语法包还没懒加载到位时也是 unsupported，不是那份空清单', () => {
    // `CODE_RULES` 认得 TypeScript，可这份 state 上压根没挂语法（`state.facet(language)`
    // 是 null），遍历一棵空树只能回一份空 `code`。那一刻浮层该说的是「还没有」而不是
    // 「这份文档里没有匹配的符号」——后一句把「还没装上」讲成了「这里头没有」，
    // 而用户除了再按一次 `Cmd+R` 没有别的办法，前提是那句话让他知道该再按一次
    expect(symbolTable(bare(), '/repo/a.ts')).toEqual({ kind: 'unsupported', label: 'TypeScript' })
    expect(symbolTable(bare(), '/repo/a.rs')).toEqual({ kind: 'unsupported', label: 'Rust' })
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

describe('wordUnderCaret：光标正指着的那个词', () => {
  /** 光标停在 `|` 那个位置。刻意不夹：越界与否是 CM6 的事，这里要的是它真实的行为 */
  const caretAt = (raw: string, marker = '|'): EditorState => {
    const head = raw.indexOf(marker)
    if (head < 0) throw new Error(`用例写错了：${JSON.stringify(raw)} 里没有 ${marker}`)
    return EditorState.create({ doc: raw.replace(marker, ''), selection: { anchor: head, head } })
  }

  it('光标在词的**中间**与**右边界**都取得到，只靠一次 wordAt', () => {
    // 右边界那一种是关键：CM6 的 `wordAt` 从 `pos` 同时向左向右扫，所以 `helper|`
    // 拿到的就是 `helper`，⛔ 不必再退一格（退了反而会跨到上一行去）
    expect(wordUnderCaret(caretAt('const h|elper = 1'))) // 词首
      .toBe('helper')
    expect(wordUnderCaret(caretAt('const hel|per = 1'))).toBe('helper')
    expect(wordUnderCaret(caretAt('const helper| = 1'))).toBe('helper')
  })

  it('光标在空白与标点上回 null，不是空串', () => {
    expect(wordUnderCaret(caretAt('const  | = 1'))).toBeNull()
    expect(wordUnderCaret(caretAt('const helper |'))).toBeNull()
    expect(wordUnderCaret(caretAt('(|=)'))).toBeNull()
    // 文档整个是空的：光标无处可扫
    expect(wordUnderCaret(caretAt('|'))).toBeNull()
  })

  it('中文算字母，拿到的是**整串连续的中文**', () => {
    // 字类表是 `/[\p{Alphabetic}\p{Number}_]/u`（`@codemirror/state` 的 `hasWordChar`），
    // CJK 在 `\p{Alphabetic}` 里，所以⛔**不是**「中文取不到词」。
    // 两个命令因此各自得到一个明确的结果：按词搜索在中文笔记里直接可用；
    // 跳到定义拿到的是 `项目结构` 这种名字，`CODE_RULES` 里没有中文标识符，
    // 于是「这份文件里没有叫 项目结构 的符号」那一句会如实说出来
    expect(wordUnderCaret(caretAt('# 项|目结构'))).toBe('项目结构')
    // 标点把串切断，所以「词」的边界就是标点而不是空白
    expect(wordUnderCaret(caretAt('第|一句，第二段'))).toBe('第一句')
    expect(wordUnderCaret(caretAt('see helper| here'))).toBe('helper')
  })
})
