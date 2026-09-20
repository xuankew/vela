import { describe, expect, it } from 'vitest'
import { markdownLanguage } from '@codemirror/lang-markdown'
// ⚠️ `?raw` 而不是 `node:fs`：tsconfig 的 `types` 只有 `vite/client`，没有 node 的类型
import setupSource from '../editor/setup.ts?raw'

import { headingLevel } from '../goto/symbols'
import {
  ALLOWED_TAGS,
  LOCAL_IMAGE_CLASS,
  UNSAFE_LINK_CLASS,
  decodeEntity,
  escapeHtml,
  renderMarkdown,
  safeUrl,
  slugify,
} from './render'

/**
 * 渲染器用的是**真的** `markdownLanguage.parser`，⛔ 不是手搓的假树。
 *
 * 假树只能证明「渲染器能处理我以为的形状」，而这一层的每一个 bug 都出在
 * 「树的真实形状与我以为的不一样」：`Task` 覆盖整段而不只是 `[ ]`、
 * Blockquote 里的 `Paragraph` 把第二行的 `>` 包进去、表头排在分隔行**之前**。
 * 这三条全是拿真解析器打出来之后才发现的。
 */
function html(source: string): string {
  return renderMarkdown(markdownLanguage.parser.parse(source), source)
}

/** 从一份 HTML 里把所有标签名抠出来（含结束标签） */
function tagNames(output: string): string[] {
  const names: string[] = []
  for (const match of output.matchAll(/<\/?([a-z][a-z0-9]*)/gi)) {
    const name = match[1]
    if (name !== undefined) names.push(name.toLowerCase())
  }
  return names
}

/**
 * 「输出里没有事件属性」这件事的**唯一**可靠查法：把每个标签拆成属性名，
 * 再对一份白名单。
 *
 * 🔴 不能用 `/ on[a-z]+=/` 这类全文正则，两种方向都会错：
 * - **假阳性**：敌意输入被正确转义之后，`onerror=` 这些字样**本来就该**以文本形式
 *   留在输出里（`&lt;img src=x onerror=alert(1)&gt;`）。
 * - **假阳性第二种**：`alt="a&quot; onload=&quot;…"` 里那个 ` onload=` 在属性值**内部**，
 *   引号已经转义过了，压根开不出新属性，但正则看不见引号的配对关系。
 *
 * 反过来，属性名白名单还顺手多管一件事：将来谁往标签里加了个没登记的新属性，
 * 这里会当场红，而不管那个属性危不危险。
 */
const ALLOWED_ATTRS: readonly string[] = [
  'data-line',
  'id',
  'class',
  'start',
  'href',
  'title',
  'target',
  'rel',
  'src',
  'alt',
  'loading',
  'role',
  'aria-checked',
  'tabindex',
  'data-pos',
  'data-checked',
  'data-path',
]

/**
 * 一个「规矩的」开始标签长什么样：名字 + 若干个 `name="值"`，值里不含裸引号。
 * 不匹配就说明输出里有裸 `>`、没加引号的属性、或者引号没配对——三种都是事故。
 */
const STRICT_TAG = /^<[a-z][a-z0-9]*(?:\s+[a-z-]+="[^"]*")*>$/i

function expectSafeTags(output: string): void {
  for (const tag of tags(output)) {
    expect(tag, `标签形状不对（引号没配对／有裸 >／有未加引号的属性）`).toMatch(STRICT_TAG)
    for (const match of tag.matchAll(/\s([a-z-]+)="/gi)) {
      const name = (match[1] ?? '').toLowerCase()
      expect(ALLOWED_ATTRS, `${tag} 里出现了没登记的属性 ${name}`).toContain(name)
    }
  }
  // 结束标签不许带任何东西。
  // ⚠️ 不能写成 `/<\/[a-z][a-z0-9]*[^>]+>/`：那个 `[^>]+` 会把 `</pre>` 里的 `re`
  // 吃进去（`[a-z0-9]*` 回溯到只匹配 `p`），于是**每一个**正常的结束标签都算违规。
  // 先把 `</…>` 整段抠出来，再要求它严格等于 `</名字>`
  for (const close of output.matchAll(/<\/[^>]*>/g)) {
    expect(close[0], '结束标签里不许有别的字符').toMatch(/^<\/[a-z][a-z0-9]*>$/)
  }
}

// ───────────────────────── 纯函数 ─────────────────────────

describe('escapeHtml', () => {
  it('🔴 五个字符全部转义，包括单引号', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('⚠️ 不会二次转义：已经转好的串再进去会变成字面量', () => {
    // 这条钉的是**调用方的义务**而不是函数的能力：escapeHtml 不知道输入是不是已经转过。
    // 所以「解码 → 再转义」那个顺序（见 decodeEntity）必须写在调用点，不能靠这里兜
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })

  it('CJK 与代理对一个字符都不动', () => {
    expect(escapeHtml('中文 𝕏 与 emoji 😀')).toBe('中文 𝕏 与 emoji 😀')
  })
})

describe('safeUrl', () => {
  it('http / https / mailto 放行', () => {
    expect(safeUrl('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d')
    expect(safeUrl('http://example.com')).toBe('http://example.com')
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c')
  })

  it('相对路径与锚点放行', () => {
    expect(safeUrl('assets/a.png')).toBe('assets/a.png')
    expect(safeUrl('/abs/path')).toBe('/abs/path')
    expect(safeUrl('#标题')).toBe('#标题')
    expect(safeUrl('./x/../y')).toBe('./x/../y')
  })

  it('🔴 javascript: / data: / file: / vbscript: 一律拒绝', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('JaVaScRiPt:alert(1)')).toBeNull()
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeUrl('data:image/png;base64,iVBOR')).toBeNull()
    expect(safeUrl('file:///etc/passwd')).toBeNull()
    expect(safeUrl('vbscript:msgbox')).toBeNull()
  })

  it('🔴 协议里插空白这个经典绕法被堵住了', () => {
    // 浏览器会把 href="java\tscript:alert(1)" 当脚本执行，而制表符让
    // 「开头是不是协议」这个判断落空 → 被当成相对路径放行。先删空白再判，这条路就断了
    expect(safeUrl('java\tscript:alert(1)')).toBeNull()
    expect(safeUrl('java\nscript:alert(1)')).toBeNull()
    expect(safeUrl(' javascript:alert(1)')).toBeNull()
    expect(safeUrl('jav\x00ascript:alert(1)')).toBeNull()
  })

  it('⚠️ 合法 URL 里的空白被删掉而不是被拒绝', () => {
    expect(safeUrl('https://example.com/a b')).toBe('https://example.com/ab')
    expect(safeUrl('  https://example.com  ')).toBe('https://example.com')
  })

  it('空串与纯空白回 null', () => {
    expect(safeUrl('')).toBeNull()
    expect(safeUrl('   ')).toBeNull()
    expect(safeUrl('\t\n')).toBeNull()
  })

  it('带端口、用户名、IPv6 的都当合法', () => {
    expect(safeUrl('https://user:pw@example.com:8443/x')).toBe('https://user:pw@example.com:8443/x')
    expect(safeUrl('http://[::1]:8080/')).toBe('http://[::1]:8080/')
  })
})

describe('decodeEntity', () => {
  it('十进制与十六进制数字实体', () => {
    expect(decodeEntity('&#65;')).toBe('A')
    expect(decodeEntity('&#x41;')).toBe('A')
    expect(decodeEntity('&#X1F600;')).toBe('😀')
  })

  it('命名实体只认那六个，其余原样返回', () => {
    expect(decodeEntity('&amp;')).toBe('&')
    expect(decodeEntity('&lt;')).toBe('<')
    expect(decodeEntity('&nbsp;')).toBe('\u00a0')
    expect(decodeEntity('&notanentity;')).toBe('&notanentity;')
    expect(decodeEntity('&copy;')).toBe('&copy;')
  })

  it('🔴 代理区与超范围码点原样返回，不抛 RangeError', () => {
    expect(decodeEntity('&#xD800;')).toBe('&#xD800;')
    expect(decodeEntity('&#55296;')).toBe('&#55296;')
    expect(decodeEntity('&#x110000;')).toBe('&#x110000;')
  })

  it('畸形的实体原样返回', () => {
    expect(decodeEntity('&#;')).toBe('&#;')
    expect(decodeEntity('&#x;')).toBe('&#x;')
    expect(decodeEntity('&')).toBe('&')
    expect(decodeEntity('&;')).toBe('&;')
    expect(decodeEntity('&#12ab;')).toBe('&#12ab;')
  })

  it('🔴 解码出来的 `<` 在渲染结果里仍然是转义的', () => {
    // 「解码 → 再转义」这个顺序是整个实体处理的命门：少了后半步，
    // `&lt;script&gt;` 就会变成真的标签
    expect(html('&lt;script&gt;alert(1)&lt;/script&gt;')).not.toContain('<script')
    expect(html('&lt;script&gt;')).toContain('&lt;script&gt;')
  })
})

describe('slugify', () => {
  it('CJK 保留，标点删掉，空格换成连字符', () => {
    const seen = new Map<string, number>()
    expect(slugify('Hello, World!', seen)).toBe('hello-world')
    // ⚠️ `·` 删掉之后留下两个空格，它们被折叠成**一个**连字符——与 `a  b` 同一条规则
    expect(slugify('第三节 · 实现', seen)).toBe('第三节-实现')
    expect(slugify('a  b', seen)).toBe('a-b')
  })

  it('⚠️ 重名追加序号，于是两个同名小节不会共用一个锚点', () => {
    const seen = new Map<string, number>()
    expect(slugify('同名', seen)).toBe('同名')
    expect(slugify('同名', seen)).toBe('同名-1')
    expect(slugify('同名', seen)).toBe('同名-2')
  })

  it('空标题落到 section，不会生成 id=""', () => {
    const seen = new Map<string, number>()
    expect(slugify('!!!', seen)).toBe('section')
    expect(slugify('', seen)).toBe('section-1')
  })
})

// ───────────────────────── 块级 ─────────────────────────

describe('标题', () => {
  it('ATX 六级各自出对应的标签，井号一个都不剩', () => {
    for (let level = 1; level <= 6; level++) {
      const output = html(`${'#'.repeat(level)} 标题${level}`)
      expect(output).toContain(`<h${level} `)
      expect(output).toContain(`标题${level}</h${level}>`)
      expect(output).not.toContain('#')
    }
  })

  it('🔴 `### C#` 的尾巴是内容不是闭合井号串', () => {
    // 这条是「用树而不是用正则」最直接的好处：闭合井号串必须前面有空白，
    // 所以 `C#` 里的 `#` 是标题文字的一部分。src/goto/symbols.ts 用正则重判了一遍，
    // 这里白拿——树已经判过了
    const output = html('### C#')
    expect(output).toContain('<h3 ')
    expect(output).toContain('C#</h3>')
  })

  it('Setext 两级，下划线不进输出', () => {
    expect(html('标题\n===')).toContain('<h1 ')
    expect(html('标题\n---')).toContain('<h2 ')
    // ⚠️ 只能断言 `===` 不出现：单个 `=` 是属性的一部分（data-line="1"），必然存在
    expect(html('标题\n===')).not.toContain('===')
    expect(html('标题\n---')).not.toContain('---')
  })

  it('标题带行内格式', () => {
    expect(html('# 带 **粗** 的标题')).toContain(
      '<h1 data-line="1" id="带-粗-的标题">带 <strong>粗</strong> 的标题</h1>',
    )
  })

  it('🔴 与 goto/symbols.ts 的 headingLevel 对得上（两份表刻意没共享）', () => {
    // render.ts 的 HEADING_LEVELS 与 symbols.ts 的 HEADING_LEVEL 是同一份知识的两个副本，
    // 分开是为了不让两个模块的改动互相牵连。代价是改一处要记得改另一处——这条用例就是那个「记得」
    const cases: ReadonlyArray<readonly [string, number, string]> = [
      ['ATXHeading1', 1, '# T'],
      ['ATXHeading2', 2, '## T'],
      ['ATXHeading3', 3, '### T'],
      ['ATXHeading4', 4, '#### T'],
      ['ATXHeading5', 5, '##### T'],
      ['ATXHeading6', 6, '###### T'],
      ['SetextHeading1', 1, 'T\n==='],
      ['SetextHeading2', 2, 'T\n---'],
    ]
    for (const [nodeName, level, source] of cases) {
      expect(headingLevel(nodeName), `${nodeName} 在 symbols.ts 里的级别`).toBe(level)
      expect(html(source), `${source} 渲染出的级别`).toContain(`<h${level} `)
    }
    // 反向：非标题节点一律 null，免得哪天有人往 HEADING_LEVELS 里塞了个别的
    expect(headingLevel('Paragraph')).toBeNull()
    expect(headingLevel('Heading')).toBeNull()
  })

  it('⚠️ 同名标题的锚点各自唯一', () => {
    const output = html('# 小节\n\n# 小节')
    expect(output).toContain('id="小节"')
    expect(output).toContain('id="小节-1"')
  })
})

describe('段落与换行', () => {
  it('软换行留在输出里，⛔ 不变成 <br>', () => {
    const output = html('第一行\n第二行')
    expect(output).toBe('<p data-line="1">第一行\n第二行</p>')
    expect(output).not.toContain('<br>')
  })

  it('硬换行（行尾两个空格）出 <br>', () => {
    expect(html('第一行  \n第二行')).toContain('<br>')
  })

  it('两个段落各自带自己的行号', () => {
    const output = html('甲\n\n乙\n\n丙')
    expect(output).toContain('<p data-line="1">甲</p>')
    expect(output).toContain('<p data-line="3">乙</p>')
    expect(output).toContain('<p data-line="5">丙</p>')
  })

  it('空文档渲染成空串', () => {
    expect(html('')).toBe('')
    expect(html('\n\n\n')).toBe('')
  })
})

describe('引用', () => {
  it('🔴 第二行的 `>` 不会漏进正文', () => {
    // 实测树：Paragraph 覆盖「引用\n> 第二行」，那个 `>` 是它的 QuoteMark 子节点。
    // 整段 slice 就会把它当正文渲染出来——这是「靠走子节点 + 填空隙」存在的理由
    const output = html('> 引用\n> 第二行')
    expect(output).toBe('<blockquote data-line="1"><p data-line="1">引用\n第二行</p></blockquote>')
    // ⚠️ 只能断言 `&gt;` 不出现：`>` 本身是标签的一部分，全文匹配它必然是假的
    expect(output).not.toContain('&gt;')
  })

  it('嵌套引用', () => {
    const output = html('> 外\n>\n> > 内')
    expect(output).toContain('<blockquote')
    expect(output).toContain('内')
    expect(output).not.toContain('&gt;')
  })

  it('引用里的其他块级元素照常渲染', () => {
    const output = html('> # 标题\n>\n> - 项')
    expect(output).toContain('<h1 ')
    expect(output).toContain('<ul')
  })
})

describe('列表', () => {
  it('紧列表的 li 里不包 <p>', () => {
    const output = html('- 甲\n- 乙')
    expect(output).toContain('<li data-line="1">甲</li>')
    expect(output).not.toContain('<p')
  })

  it('松列表的 li 里包 <p>', () => {
    const output = html('- 甲\n\n- 乙\n\n  第二段')
    expect(output).toContain('<p')
    expect(output).toContain('第二段')
  })

  it('有序列表默认不带 start，从 3 开始时带', () => {
    expect(html('1. 甲\n2. 乙')).toContain('<ol data-line="1">')
    expect(html('3. 甲\n4. 乙')).toContain('<ol data-line="1" start="3">')
  })

  it('⚠️ 只有第一项决定 start，后面写什么编号都不影响', () => {
    // CommonMark 的规定：`3. a\n7. b` 渲染成 3、4。这里钉的是「别去读第二项的 ListMark」
    expect(html('3. 甲\n7. 乙')).toContain('start="3"')
    expect(html('3. 甲\n7. 乙')).not.toContain('start="7"')
  })

  it('嵌套列表', () => {
    const output = html('- 甲\n  - 乙\n    - 丙')
    expect(output.match(/<ul/g)?.length).toBe(3)
  })

  it('列表项里的行内格式与代码块', () => {
    expect(html('- **粗** 与 `码`')).toContain('<li data-line="1"><strong>粗</strong> 与 <code>码</code></li>')
    expect(html('- 甲\n\n  ```js\n  x\n  ```')).toContain('<pre')
  })
})

describe('任务列表', () => {
  it('🔴 勾选框**和**待办文字都在，一个都没吞', () => {
    // 实测树：`- [ ] 待办` 的 ListItem 子节点是 ListMark + Task，**没有 Paragraph**，
    // 而 Task 覆盖 `[ ] 待办` 整段——TaskMarker 只是它开头三个字符，「待办」是空隙。
    // 只渲染勾选框、跳过 Task 的话，所有待办事项的文字会整个消失
    const output = html('- [ ] 待办')
    expect(output).toContain('class="md-task"')
    expect(output).toContain('待办')
    expect(output).not.toContain('[ ]')
    expect(output).not.toContain('[x]')
  })

  it('⛔ 不是 <input>：状态由源文档决定，浏览器改不了', () => {
    expect(html('- [ ] 甲\n- [x] 乙')).not.toContain('<input')
  })

  it('未勾选与已勾选各自如实', () => {
    const output = html('- [ ] 甲\n- [x] 乙\n- [X] 丙')
    expect(output).toContain('data-checked="false"')
    expect(output.match(/data-checked="true"/g)?.length).toBe(2)
    expect(output).toContain('aria-checked="false"')
  })

  it('🔴 data-pos 就是 `[ ]` 在源文本里的偏移，回写靠它', () => {
    const source = '# 标题\n\n- [ ] 甲\n- [x] 乙'
    const first = source.indexOf('- [ ]') + 2
    const second = source.indexOf('- [x]') + 2
    const output = html(source)
    expect(output).toContain(`data-pos="${first}"`)
    expect(output).toContain(`data-pos="${second}"`)
    // 钉死「替换 [pos, pos+3) 正好是那个方括号串」这件事——差一个字符就会写坏文档
    expect(source.slice(first, first + 3)).toBe('[ ]')
    expect(source.slice(second, second + 3)).toBe('[x]')
  })

  it('非任务项不带 md-task 类', () => {
    expect(html('- 普通项')).not.toContain('md-task')
  })

  it('任务项带 md-task-item 类，普通项不带', () => {
    expect(html('- [ ] 甲')).toContain('class="md-task-item"')
    expect(html('- 甲')).not.toContain('md-task-item')
  })
})

describe('代码块', () => {
  it('围栏代码：语言进 class，围栏本身不进输出', () => {
    const output = html('```js\nconst x = 1\n```')
    expect(output).toContain('<pre data-line="1"><code class="language-js">const x = 1</code></pre>')
    expect(output).not.toContain('```')
  })

  it('🔴 代码里的 HTML 一律转义', () => {
    const output = html('```\n<script>alert(1)</script>\n```')
    expect(output).toContain('&lt;script&gt;')
    expect(output).not.toContain('<script')
  })

  it('🔴 语言标记本身也是用户输入，进属性前必须转义', () => {
    // ``` 后面跟 `"><img src=x onerror=alert(1)>` 是最直接的注入点：
    // 它会被拼进 class="language-…" 里，一个未转义的双引号就能开出属性
    const output = html('```"><img src=x onerror=alert(1)>\nx\n```')
    expect(output).not.toContain('<img')
    expectSafeTags(output)
    expect(output).toContain('&quot;')
  })

  it('没有语言标记时不加空 class', () => {
    expect(html('```\nx\n```')).toContain('<pre data-line="1"><code>x</code></pre>')
  })

  it('空围栏不炸', () => {
    expect(html('```\n```')).toContain('<pre')
    expect(html('```js\n```')).toContain('<code class="language-js">')
  })

  it('缩进代码块不带那四个空格', () => {
    const output = html('    缩进代码')
    expect(output).toBe('<pre data-line="1"><code>缩进代码</code></pre>')
  })

  it('多行代码保住换行', () => {
    expect(html('```\na\nb\nc\n```')).toContain('a\nb\nc')
  })

  it('行内代码：反引号不进输出，内容转义', () => {
    expect(html('用 `a<b` 比较')).toContain('<code>a&lt;b</code>')
  })

  it('⚠️ 行内代码里的 ** 不是强调', () => {
    expect(html('`**not bold**`')).toContain('<code>**not bold**</code>')
    expect(html('`**not bold**`')).not.toContain('<strong>')
  })
})

describe('水平线与引用定义', () => {
  it('三种水平线写法都出 <hr>', () => {
    expect(html('---')).toContain('<hr data-line="1">')
    expect(html('***')).toContain('<hr')
    expect(html('___')).toContain('<hr')
  })

  it('🔴 链接定义不渲染成正文', () => {
    const output = html('[a]\n\n[ref]: https://example.com')
    expect(output).not.toContain('example.com')
    expect(output).not.toContain('[ref]')
  })
})

describe('表格', () => {
  const BASIC = '| 左 | 右 |\n|---|---|\n| a | b |'

  it('表头进 thead/th，数据行进 tbody/td', () => {
    const output = html(BASIC)
    expect(output).toContain('<thead><tr><th>左</th><th>右</th></tr></thead>')
    expect(output).toContain('<tbody><tr><td>a</td><td>b</td></tr></tbody>')
  })

  it('🔴 对齐**同时**作用在表头与数据行上', () => {
    // 分隔行排在表头**之后**，所以边遍历边渲染的话表头那一趟拿到的对齐还是空的。
    // 这条用例钉的就是「先收集、后渲染」那个改法
    const output = html('| 甲 | 乙 | 丙 |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
    expect(output).toContain('<th class="md-left">甲</th>')
    expect(output).toContain('<th class="md-center">乙</th>')
    expect(output).toContain('<th class="md-right">丙</th>')
    expect(output).toContain('<td class="md-left">1</td>')
    expect(output).toContain('<td class="md-center">2</td>')
    expect(output).toContain('<td class="md-right">3</td>')
  })

  it('竖线分隔符不进输出', () => {
    expect(html(BASIC)).not.toContain('|')
  })

  it('⚠️ 单元格数不齐时照常渲染，多出来的格子没有对齐类', () => {
    const output = html('| 甲 | 乙 |\n|:--|--:|\n| 只有一列 |')
    expect(output).toContain('<td class="md-left">只有一列</td>')
    expect(output.match(/<td/g)?.length).toBe(1)
  })

  it('单元格里的行内格式与转义', () => {
    const output = html('| 甲 |\n|---|\n| **粗** `<x>` |')
    expect(output).toContain('<td><strong>粗</strong> <code>&lt;x&gt;</code></td>')
  })

  it('表格带源行号', () => {
    expect(html(`前言\n\n${BASIC}`)).toContain('<table data-line="3">')
  })
})

// ───────────────────────── 行内 ─────────────────────────

describe('行内格式', () => {
  it('强调、加粗、删除线、上下标', () => {
    expect(html('*斜*')).toBe('<p data-line="1"><em>斜</em></p>')
    expect(html('**粗**')).toContain('<strong>粗</strong>')
    expect(html('~~删~~')).toContain('<del>删</del>')
    expect(html('H~2~O')).toContain('H<sub>2</sub>O')
    expect(html('x^2^')).toContain('x<sup>2</sup>')
  })

  it('嵌套', () => {
    expect(html('**粗里有 *斜* 与 `码`**')).toContain('<strong>粗里有 <em>斜</em> 与 <code>码</code></strong>')
  })

  it('🔴 转义反斜杠：`\\*` 出来是一个星号，不是强调', () => {
    const output = html('\\*不是斜体\\*')
    expect(output).toBe('<p data-line="1">*不是斜体*</p>')
    expect(output).not.toContain('<em>')
  })

  it('⚠️ `\\\\` 出来是一个反斜杠', () => {
    expect(html('a\\\\b')).toContain('a\\b')
  })

  it('emoji 短名原样输出，⛔ 不替换成码点', () => {
    expect(html(':smile:')).toContain(':smile:')
    expect(html(':smile:')).not.toContain('😄')
  })

  it('实体解码后重新转义', () => {
    expect(html('&amp;')).toBe('<p data-line="1">&amp;</p>')
    expect(html('&#65;')).toBe('<p data-line="1">A</p>')
  })
})

describe('链接', () => {
  it('行内链接：目标进 href，文字进内容，标记一个不剩', () => {
    const output = html('[文字](https://example.com)')
    expect(output).toContain('href="https://example.com"')
    expect(output).toContain('>文字</a>')
    expect(output).not.toContain('[')
    expect(output).not.toContain(']')
  })

  it('带标题的链接', () => {
    expect(html('[a](https://e.com "提示")')).toContain('title="提示"')
    expect(html("[a](https://e.com '提示')")).toContain('title="提示"')
    expect(html('[a](https://e.com (提示))')).toContain('title="提示"')
  })

  it('🔴 标题与目标之间那个空格不会被当成链接文字', () => {
    // 「撞到 URL/LinkTitle/LinkLabel 就停止收集」这条规则存在的全部理由
    expect(html('[a](https://e.com "t")')).toContain('>a</a>')
    expect(html('[a](https://e.com "t")')).not.toContain('&quot;')
  })

  it('站外链接带 target 与 rel，站内锚点不带', () => {
    expect(html('[a](https://e.com)')).toContain('target="_blank" rel="noopener noreferrer"')
    expect(html('[a](#小节)')).not.toContain('target=')
    expect(html('[a](/local)')).not.toContain('target=')
  })

  it('自动链接', () => {
    const output = html('<https://example.com>')
    expect(output).toContain('<a href="https://example.com"')
    expect(output).toContain('>https://example.com</a>')
    expect(output).not.toContain('&lt;')
  })

  it('引用式链接：定义在**后面**也能解析', () => {
    const output = html('[文字][ref]\n\n[ref]: https://example.com "标题"')
    expect(output).toContain('href="https://example.com"')
    expect(output).toContain('title="标题"')
    expect(output).toContain('>文字</a>')
  })

  it('⚠️ 标签大小写不敏感、空白折叠', () => {
    expect(html('[文字][Ref Key]\n\n[REF   KEY]: https://e.com')).toContain('href="https://e.com"')
  })

  it('快捷引用（没有第二个方括号）', () => {
    expect(html('[ref]\n\n[ref]: https://e.com')).toContain('href="https://e.com"')
  })

  it('没有对应定义的方括号原样当文字', () => {
    const output = html('[孤立的]')
    expect(output).toBe('<p data-line="1">[孤立的]</p>')
    expect(output).not.toContain('<a')
  })

  it('🔴 javascript: 链接不出 <a>，但文字还在', () => {
    const output = html('[点我](javascript:alert(1))')
    expect(output).not.toContain('<a ')
    expect(output).not.toContain('javascript:')
    expect(output).toContain(`class="${UNSAFE_LINK_CLASS}"`)
    expect(output).toContain('点我')
  })

  it('🔴 协议里插空白的绕法：解析器压根不认它是链接，于是原样当文字', () => {
    // ⚠️ 这一条的实际防线**不在 safeUrl**：URL 里有制表符时 Lezer 根本不产生 Link 节点，
    // 整串退回成正文。这是好事，但别把它记成 safeUrl 的功劳——safeUrl 那一层是单独用
    // 纯函数测的（见上面「协议里插空白这个经典绕法被堵住了」）。两层各自都要成立：
    // 哪天解析器变宽松了，safeUrl 得能独自接住
    const output = html('[点我](java\tscript:alert(1))')
    expect(output).not.toContain('<a ')
    expect(output).toContain('点我')
    expect(output).toContain('script:alert(1)')
  })

  it('file: 链接被拒', () => {
    expect(html('[passwd](file:///etc/passwd)')).not.toContain('<a ')
  })

  it('链接文字里的格式照常渲染', () => {
    expect(html('[**粗**链接](https://e.com)')).toContain('<a href="https://e.com"')
    expect(html('[**粗**链接](https://e.com)')).toContain('<strong>粗</strong>链接</a>')
  })
})

describe('图片', () => {
  it('http(s) 目标出真的 <img>，带 alt 与 lazy', () => {
    const output = html('![替代](https://e.com/a.png)')
    expect(output).toContain('<img src="https://e.com/a.png" alt="替代"')
    expect(output).toContain('loading="lazy"')
  })

  it('⚠️ 本地路径出占位 span 而不是裂图', () => {
    // webview 的 base URL 是应用自己的源，不是文档目录，所以相对路径必然 404。
    // 画一个裂图会让用户以为是文件丢了；如实说「本地图片还没接上」才对
    const output = html('![图](assets/a.png)')
    expect(output).not.toContain('<img')
    expect(output).toContain(`class="${LOCAL_IMAGE_CLASS}"`)
    expect(output).toContain('data-path="assets/a.png"')
    expect(output).toContain('图</span>')
  })

  it('file: 与 data: 的图片一律走占位', () => {
    expect(html('![x](file:///etc/passwd)')).not.toContain('<img')
    expect(html('![x](data:image/png;base64,AAA)')).not.toContain('<img')
  })

  it('alt 为空时给个占位词，不留下空属性', () => {
    expect(html('![](https://e.com/a.png)')).toContain('alt="图片"')
  })

  it('🔴 alt 里的引号被转义，开不出属性', () => {
    const output = html('![a" onload="alert(1)](https://e.com/a.png)')
    expectSafeTags(output)
    expect(output).toContain('&quot;')
  })

  it('没有目标的图片不炸', () => {
    expect(html('![只有alt]')).toContain(LOCAL_IMAGE_CLASS)
  })
})

describe('内联 HTML', () => {
  it('🔴 内联标签当**文字**渲染，一个都不执行', () => {
    const output = html('前 <b>粗</b> 后 <script>alert(1)</script>')
    expect(output).not.toContain('<b>')
    expect(output).not.toContain('<script')
    expect(output).toContain('&lt;b&gt;')
    expect(output).toContain('&lt;script&gt;')
  })

  it('🔴 块级 HTML 与注释都进 md-raw 的 <pre>，保住换行', () => {
    const block = html('<div>\n  <span>x</span>\n</div>')
    expect(block).toContain('<pre class="md-raw"')
    expect(block).not.toContain('<div>')
    expect(block).toContain('&lt;span&gt;')

    const comment = html('<!-- <script>alert(1)</script> -->')
    expect(comment).toContain('md-raw')
    expect(comment).not.toContain('<script')
  })

  it('⚠️ 事件属性根本没有落脚的地方：输出里不会出现 on*=', () => {
    expectSafeTags(html('<img src=x onerror=alert(1)>'))
    expectSafeTags(html('<a href="#" onclick="x()">y</a>'))
  })
})

// ───────────────────────── 源位置映射 ─────────────────────────

describe('data-line', () => {
  it('每个块级元素带自己那一行，1-based', () => {
    const source = ['# 甲', '', '段落', '', '- 项', '', '> 引用', '', '```', 'x', '```'].join('\n')
    const output = html(source)
    expect(output).toContain('<h1 data-line="1"')
    expect(output).toContain('<p data-line="3">')
    expect(output).toContain('<ul data-line="5">')
    expect(output).toContain('<blockquote data-line="7">')
    expect(output).toContain('<pre data-line="9">')
  })

  it('⚠️ 列表项也带行号，同步滚动才有足够的粒度', () => {
    const output = html('- 甲\n- 乙\n- 丙')
    expect(output).toContain('<li data-line="1"')
    expect(output).toContain('<li data-line="2"')
    expect(output).toContain('<li data-line="3"')
  })

  it('CRLF 文档的行号也对', () => {
    // 换行符切换是 M1-E 的功能，一份 CRLF 的笔记切到预览不能行号全错
    const output = html('# 甲\r\n\r\n乙')
    expect(output).toContain('<h1 data-line="1"')
    expect(output).toContain('<p data-line="3">')
  })

  it('行号单调不减，且都在文档行数范围内', () => {
    const source = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? `## 标题${i}` : `正文${i}`)).join('\n\n')
    const lines = [...html(source).matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1]))
    const total = source.split('\n').length
    expect(lines.length).toBeGreaterThan(20)
    for (let i = 1; i < lines.length; i++) {
      // 允许相等（同一段里的多个块级元素），⛔ 不允许倒退
      expect(lines[i], `第 ${i} 个 data-line 倒退了`).toBeGreaterThanOrEqual(lines[i - 1] ?? 0)
    }
    expect(Math.max(...lines)).toBeLessThanOrEqual(total)
  })
})

// ───────────────────────── 🔴 安全：把保证变成可执行的 ─────────────────────────

/**
 * 一份「什么都有一点」的正常文档，用来做覆盖率检查，也用来钉整体输出。
 * ⚠️ 它必须与 HOSTILE 分开：敌意语料证明的是「坏输入不产生坏输出」，
 * 这一份证明的是「好输入产生对的输出」。
 *
 * ⚠️ 六级标题**必须**全在这里出现一遍：覆盖率那条用例要求白名单里每个标签都被走到，
 * 而 h3–h6 只有这一处能产出。
 */
const CORPUS: readonly string[] = [
  '# 标题\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级',
  '正文 **粗** *斜* ~~删~~ `码` H~2~O x^2^',
  '- 甲\n- 乙\n\n1. 一\n2. 二',
  '- [ ] 待办\n- [x] 已办',
  '> 引用\n>\n> > 嵌套',
  '| 甲 | 乙 |\n|:--|--:|\n| 1 | 2 |',
  '```js\nconst x = 1\n```\n\n    缩进代码',
  '[链接](https://e.com "标题") ![图](https://e.com/a.png) <https://auto> [ref]\n\n[ref]: https://r.example',
  '---\n\n硬折  \n下一行\n\n<a>内联HTML</a>',
]

/**
 * 一份尽量把渲染器所有出口都走一遍的语料。
 *
 * ⚠️ 加新的输出路径时**必须**往这里加一条对应的敌意输入。这条要求写在 render.ts 的
 * 文件头（「任何新增的输出都必须经过 escapeHtml 或 safeUrl」），而这份语料是它的执行版本。
 */
const HOSTILE: readonly string[] = [
  '<script>alert(1)</script>',
  '前 <b>粗</b> 后',
  '<!-- 注释里的 <script>x</script> -->',
  '<img src=x onerror=alert(1)>',
  '[点我](javascript:alert(1))',
  '[点我](JaVaScRiPt:alert(1))',
  '[点我](java\tscript:alert(1))',
  '[点我](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[点我](file:///etc/passwd)',
  '[点我](vbscript:msgbox)',
  '![图](javascript:alert(1))',
  '![a" onload="alert(1)](https://e.com/x.png)',
  '```"><img src=x onerror=alert(1)>\n代码\n```',
  '```js\n<script>alert(1)</script>\n```',
  '# <script>alert(1)</script>',
  '[<script>x</script>](https://e.com)',
  '`<script>alert(1)</script>`',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;script&#62;alert(1)&#60;/script&#62;',
  '<iframe src="https://evil.example"></iframe>',
  '<svg onload=alert(1)>',
  '<a href="#" onclick="alert(1)">y</a>',
  '<form action="https://evil.example"><input name=x></form>',
  '<style>body{display:none}</style>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<object data="https://evil.example"></object>',
  '<embed src="https://evil.example">',
  '<button onclick="alert(1)">按</button>',
  '<body onload=alert(1)>',
  '<div>块级</div>\n\n<div>第二段</div>',
  '- [ ] <script>x</script>',
  '| <script>x</script> |\n|---|\n| <img src=x onerror=alert(1)> |',
  '> <script>x</script>',
  '[ref]: javascript:alert(1)\n\n[点我][ref]',
  '" onmouseover="alert(1)',
  "' onfocus='alert(1)",
  '\\<script\\>alert(1)\\</script\\>',
  '<SCRIPT>alert(1)</SCRIPT>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
]

/**
 * 输出里出现就等于保证被破了的东西。
 *
 * 🔴 后五条**必须**锚在真标签里（`<[a-z][^>]*\s…`），不能直接全文匹配：
 * `<a href="#" onclick="alert(1)">` 作为敌意输入时，它的正确输出是
 * `&lt;a href=&quot;#&quot; onclick=&quot;…` ——里面那个空格 + `onclick=` 是**文本**，
 * 完全无害，但裸匹配 `/ on[a-z]+=/` 会把它判成失败。而 `<` 开头的几条不用锚：
 * 转义过的文本里根本不会出现裸 `<`。
 */
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/<script/i, '<script'],
  [/<iframe/i, '<iframe'],
  [/<svg/i, '<svg'],
  [/<object/i, '<object'],
  [/<embed/i, '<embed'],
  [/<form/i, '<form'],
  [/<input/i, '<input'],
  [/<button/i, '<button'],
  [/<style/i, '<style'],
  [/<link/i, '<link'],
  [/<meta/i, '<meta'],
  [/<body/i, '<body'],
  [/<[a-z][^>]*\shref\s*=\s*["']?\s*javascript:/i, 'javascript: 目标'],
  [/<[a-z][^>]*\ssrc\s*=\s*["']?\s*javascript:/i, 'javascript: 图片源'],
  [/<[a-z][^>]*\shref\s*=\s*["']?\s*data:/i, 'data: 目标'],
  [/<[a-z][^>]*\ssrc\s*=\s*["']?\s*file:/i, 'file: 目标'],
]

/** 输出里所有真标签的原文（`<…>`），用来做只有落在标签里才有意义的检查 */
function tags(output: string): string[] {
  return [...output.matchAll(/<[a-z][^>]*>/gi)].map((m) => m[0])
}

describe('🔴 敌意输入', () => {
  for (const source of HOSTILE) {
    it(`不产生任何可执行的东西：${JSON.stringify(source.slice(0, 48))}`, () => {
      const output = html(source)
      for (const [pattern, what] of FORBIDDEN) {
        expect(output, `${what} 出现在了输出里`).not.toMatch(pattern)
      }
      // 标签名必须全在白名单里。这条比上面那几条更强：它连「将来有人加了一个
      // 没登记的新标签」也一起拦住
      for (const name of tagNames(output)) {
        expect(ALLOWED_TAGS, `<${name}> 不在白名单里`).toContain(name)
      }
      // 属性名同样：事件属性没有落脚的地方，因为它压根不在白名单里
      expectSafeTags(output)
    })
  }

  it('⚠️ 好输入的标签形状同样规矩（白名单不只对敌意输入生效）', () => {
    // 一个未转义的 `"` 就能从 `title="…"` 里逃出来，后面接什么就都是新属性了。
    // ⚠️ 不能写成「匹配 `x="([^"]*)"` 再断言值里没有引号」——那个正则本身就保证了结论，是恒真。
    // STRICT_TAG 要求整串严格等于「名字 + 若干个 name="值"」，多一个字符都不匹配
    for (const source of CORPUS) {
      expectSafeTags(html(source))
    }
  })

  it('🔴 语料确实覆盖到了每一个输出分支（否则上面那些用例是空的）', () => {
    // 这条守的是「测试自己退化成恒真」：把语料渲染出来的标签种类数一下，
    // 白名单里每一个都该被走到
    const seen = new Set<string>()
    for (const source of [...HOSTILE, ...CORPUS]) {
      for (const name of tagNames(html(source))) seen.add(name)
    }
    const missed = ALLOWED_TAGS.filter((tag) => !seen.has(tag))
    expect(missed, `这些标签一次都没被渲染出来，说明语料有缺口：${missed.join(' ')}`).toEqual([])
  })
})

describe('整体输出', () => {
  it('一份什么都有的文档：标签闭合、内容都在', () => {
    const source = CORPUS.join('\n\n')
    const output = html(source)

    // 每个非空标签的开闭数量必须相等。不配对的 HTML 进 innerHTML 会被浏览器
    // **自动补全**，补出来的形状没人能预测——所以这条比「看起来对」重要得多
    const VOID_TAGS = new Set(['br', 'hr', 'img'])
    for (const name of new Set(tagNames(output))) {
      if (VOID_TAGS.has(name)) continue
      const open = output.match(new RegExp(`<${name}[\\s>]`, 'g'))?.length ?? 0
      const close = output.match(new RegExp(`</${name}>`, 'g'))?.length ?? 0
      expect(close, `<${name}> 开 ${open} 个、闭 ${close} 个`).toBe(open)
    }

    expect(output).toContain('标题')
    expect(output).toContain('<strong>粗</strong>')
    expect(output).toContain('<sub>2</sub>')
    expect(output).toContain('待办')
    expect(output).toContain('<th class="md-left">甲</th>')
    expect(output).toContain('language-js')
    expect(output).toContain('href="https://r.example"')
    expect(output).toContain('<br>')
  })

  it('⚠️ 同一份输入渲染两次结果完全相同（渲染器没有跨调用的状态）', () => {
    const source = CORPUS.join('\n\n')
    expect(html(source)).toBe(html(source))
  })

  it('🔴 编辑器与预览用的是同一个解析器', () => {
    // 这条钉的是整个方案的前提：预览复用 markdownLanguage 那棵树，所以「高亮说这是标题、
    // 预览说不是」在结构上不可能发生。哪天有人把 setup.ts 里的 base 换成别的解析器，
    // 这个前提就没了，而表现是一堆说不清的对不上——所以要在测试里当场红
    expect(setupSource).toContain('markdown({ base: markdownLanguage')
    // 而 markdownLanguage 必须带 GFM：表格、任务列表、删除线都靠它
    const names = new Set<string>()
    markdownLanguage.parser
      .parse('- [ ] x\n\n| a |\n|---|\n| b |\n\n~~删~~')
      .iterate({ enter: (node) => void names.add(node.name) })
    expect(names.has('Task'), 'GFM 任务列表没在解析器里').toBe(true)
    expect(names.has('Table'), 'GFM 表格没在解析器里').toBe(true)
    expect(names.has('Strikethrough'), 'GFM 删除线没在解析器里').toBe(true)
  })
})
