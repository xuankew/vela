/**
 * `src/md/export.ts` 的用例（M3-A-6）。node 环境——这一层是纯字符串拼接。
 *
 * 分四组：**结构**（那一份 HTML 文档该有的都在，顺序对）、**安全**（title 被转义、
 * 正文里没有一个 `<script>`、样式块没被正文捅穿、不内嵌字体）、**那几条写死的决定**
 * （勾选框是死的、配色不跟主题走），以及**默认文件名**。
 *
 * ⚠️ 安全那一组有一条是**跨模块**的：拿真的 `renderMarkdown` 渲染一份含 `<script>` 的
 * Markdown 再导出。只在 `export.ts` 里断言「我不加脚本」是不够的——导出件的安全性
 * 取决于「render 的白名单」与「export 不再拼东西」两件事**同时**成立，
 * 而这一条是唯一一条把它们钉在一起的
 */

import { markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { EXPORT_FILE_FORMAT, EXPORT_STYLE, exportFileName, exportHtml } from './export'
import { renderMarkdown } from './render'

/** 一份真实的渲染结果，用来当 `bodyHtml`。⛔ 不手搓假 HTML：要钉的就是「与 render 接得上」 */
function renderOf(source: string): string {
  return renderMarkdown(markdownLanguage.parser.parse(source), source)
}

/** 取出 `<style>` 与 `</style>` 之间那一段 */
function styleOf(html: string): string {
  return html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'))
}

describe('exportHtml：结构', () => {
  const html = exportHtml('笔记', '<h1>标题</h1>')

  it('是一份完整的 HTML 文档，而不是一个片段', () => {
    expect(html.startsWith('<!DOCTYPE html>\n<html>\n<head>\n')).toBe(true)
    expect(html.endsWith('</main>\n</body>\n</html>\n')).toBe(true)
  })

  it('声明了 utf-8：导出件里全是中文，少了这一句在 Windows 上打开就是乱码', () => {
    expect(html).toContain('<meta charset="utf-8">')
  })

  it('带 viewport 与 generator', () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(html).toContain('<meta name="generator" content="Vela">')
  })

  it('`<head>` 在 `<body>` 前面，样式在正文前面', () => {
    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('<body>'))
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('<main'))
  })

  it('正文被包在 `<main class="md-doc">` 里，而那正是样式表唯一的作用域', () => {
    expect(html).toContain('<main class="md-doc">\n<h1>标题</h1>\n</main>')
    expect(styleOf(html)).toContain('.md-doc {')
  })

  it('`bodyHtml` 原样进去：不转义、不改写、不重排', () => {
    // 🔴 这一条钉的是「不要顺手清洗一下」：任何在这里做的正则替换都等于在 render.ts
    // 那一整套用例**看不见的地方**改字节，而改坏的可能是转义本身
    const body = renderOf('# 标题\n\n一段 **粗体** 与 `代码`。\n')
    expect(exportHtml('t.md', body)).toContain(`\n${body}\n`)
  })

  it('空正文也照拼——判空是调用点的事，这一层不替它做决定', () => {
    expect(exportHtml('t.md', '')).toContain('<main class="md-doc">\n\n</main>')
  })

  it('样式表是一个常量：两次导出得到的那一段逐字相同', () => {
    expect(styleOf(exportHtml('甲', '<p>甲</p>'))).toBe(styleOf(exportHtml('乙', '<p>乙</p>')))
    expect(styleOf(html).trim()).toBe(EXPORT_STYLE)
  })
})

describe('exportHtml：安全', () => {
  it('标题被转义，于是它不能从 `<title>` 里逃出去', () => {
    const html = exportHtml('</title><script>alert(1)</script>', '<p>x</p>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
  })

  it('标题里的引号与 `&` 也被转义', () => {
    expect(exportHtml('a"b\'c&d', '')).toContain('<title>a&quot;b&#39;c&amp;d</title>')
  })

  it('🔴 渲染一份含原始 HTML 的 Markdown 再导出：整份文件里没有一个 `<script`', () => {
    const source = '# 标题\n\n<script>alert(document.cookie)</script>\n\n<img src=x onerror="alert(1)">\n'
    const html = exportHtml('evil.md', renderOf(source))
    expect(html.toLowerCase()).not.toContain('<script')
    expect(html).not.toContain('<img')
    // 那段原始 HTML 是**被当成文本**渲染出来的（`render.ts` 的 `md-raw`），所以它还在，只是不能执行。
    // ⚠️ 于是这里**不能**断言「文件里没有 `onerror=`」：`onerror=` 那五个字符确实在，
    // 但它是文本，前面那个 `<img` 已经被转成了 `&lt;img`，没有标签给它挂。
    // 钉「属性名不出现」会逼着调用点去做清洗，而那正是文件头 ⛔ 掉的事
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('onerror=&quot;')
  })

  it('正文里的 `</style>` 捅不穿样式块', () => {
    // 这是「原样插值」最经典的一种穿法：正文若能写出一个裸的 `</style>`，
    // 后面那段就会从 CSS 变成 HTML。render 把 `<` 转掉了，所以整份文件里
    // `</style>` 只出现一次——就是导出件自己的那一个
    const html = exportHtml('t.md', renderOf('</style><script>alert(1)</script>\n'))
    expect(html.indexOf('</style>')).toBe(html.lastIndexOf('</style>'))
    expect(html.toLowerCase()).not.toContain('<script')
  })

  it('⛔ 不内嵌字体：没有 `@font-face`，没有霞鹜文楷，没有 data URI', () => {
    // 两条理由写在 `export.ts` 的文件头：LXGW 的 OFL 声明了保留字体名（那笔账还没结），
    // 而一份内嵌字体的「单文件」是几 MB 起
    expect(EXPORT_STYLE).not.toContain('@font-face')
    expect(EXPORT_STYLE).not.toContain('LXGW')
    expect(EXPORT_STYLE).not.toContain('霞鹜')
    expect(EXPORT_STYLE).not.toContain('Maple')
    expect(EXPORT_STYLE).not.toContain('data:')
  })

  it('只用系统字体栈', () => {
    expect(EXPORT_STYLE).toContain('-apple-system')
    expect(EXPORT_STYLE).toContain('PingFang SC')
    expect(EXPORT_STYLE).toContain('ui-monospace')
  })

  it('`javascript:` 那一条在导出件里也画成「点不动的链接」', () => {
    const html = exportHtml('t.md', renderOf('[点我](javascript:alert(1))\n'))
    expect(html).toContain('md-unsafe-link')
    expect(EXPORT_STYLE).toContain('.md-doc .md-unsafe-link')
  })

  it('本地图片在导出件里同样是占位，不是一个 `<img>`', () => {
    const html = exportHtml('t.md', renderOf('![图](./a.png)\n'))
    expect(html).toContain('md-img-local')
    expect(html).not.toContain('<img')
  })
})

describe('exportHtml：那几条写死的决定', () => {
  it('配色是浅色，而且不读编辑器的主题变量', () => {
    // 跟着主题走的话，深色主题下导出的是一张黑底白字的网页，打印出来是一整页墨。
    // 🔴 `var(--vela-…)` 一个都不能有：这一层是纯函数，而 jsdom 里 `styles.css` 压根没加载，
    // 那些变量全是空的——写了也不会报错，只会导出一份没有颜色的网页
    expect(EXPORT_STYLE).not.toContain('var(--vela')
    expect(EXPORT_STYLE).toContain('background: #fff')
    expect(EXPORT_STYLE).toContain('color-scheme: light')
  })

  it('勾选框画得出来，但明确是**点不动**的', () => {
    // 导出件里没有脚本（这是有意的，理由见文件头），于是 M3-A-5 那个能点的勾选框
    // 在这儿是死的。`cursor: default` 是那件事在视觉上唯一能说出口的地方——
    // 画成 `pointer` 再点不动，比画成不能点的样子更让人怀疑是不是自己点歪了
    expect(EXPORT_STYLE).toContain('.md-doc .md-task {')
    expect(EXPORT_STYLE).toContain('cursor: default')
    expect(EXPORT_STYLE).not.toContain('cursor: pointer')
    expect(EXPORT_STYLE).toContain(".md-doc .md-task[data-checked='true']")
  })

  it('render 会输出的那几个类名，样式表里都有一条', () => {
    for (const selector of [
      '.md-doc li.md-task-item',
      '.md-doc .md-unsafe-link',
      '.md-doc .md-img-local',
      '.md-doc .md-left',
      '.md-doc .md-center',
      '.md-doc .md-right',
    ]) {
      expect(EXPORT_STYLE, selector).toContain(selector)
    }
  })

  it('有一小段打印样式：「单文件导出」最常见的两个去处是浏览器全屏与打印机', () => {
    expect(EXPORT_STYLE).toContain('@media print')
  })

  it('落盘格式写死成 UTF-8 / 无 BOM / LF，**不**继承源文档的格式', () => {
    // 一份 GBK 的 Markdown 导出成 GBK 的 HTML，会与文件里那句 `<meta charset="utf-8">` 打架，
    // 中文变成一片问号。导出件是要发出去的，它该用最不会被认错的那一种
    expect(EXPORT_FILE_FORMAT).toEqual({ encoding: 'utf8', bom: false, eol: 'lf' })
  })
})

describe('exportFileName：默认文件名', () => {
  it('剥掉 Markdown 的扩展名再换成 .html', () => {
    expect(exportFileName('/notes/t.md', '空文档')).toBe('t.html')
    expect(exportFileName('/notes/t.markdown', '空文档')).toBe('t.html')
    expect(exportFileName('/notes/t.mdown', '空文档')).toBe('t.html')
    expect(exportFileName('/notes/t.mkd', '空文档')).toBe('t.html')
  })

  it('大小写不敏感，与 `languageFor` 认扩展名的口径一致', () => {
    expect(exportFileName('/notes/T.MD', '空文档')).toBe('T.html')
  })

  it('Windows 风格的路径也认', () => {
    expect(exportFileName('C:\\notes\\t.md', '空文档')).toBe('t.html')
  })

  it('⛔ 只剥 Markdown 那几个：`notes.tar.gz` 不该变成 `notes.tar.html`', () => {
    // 把中间那段当扩展名剥掉的话，用户拿到的是一个名字看着像压缩包、内容是网页的东西
    expect(exportFileName('/dl/notes.tar.gz', '空文档')).toBe('notes.tar.gz.html')
    expect(exportFileName('/notes/README', '空文档')).toBe('README.html')
  })

  it('无名文档用调用点递进来的那个名字', () => {
    expect(exportFileName(null, '空文档')).toBe('空文档.html')
  })

  it('边界如实记下：一个叫 `.md` 的隐藏文件剥完什么都不剩', () => {
    // ⚠️ 这一条是**如实记下**一个边界而不是修它：一个叫 `.md` 的隐藏文件剥掉扩展名就什么都不剩。
    // 兜住它要判断「剥完是不是空的」，而那种文件在现实里不存在（`.md` 是扩展名不是文件名），
    // 为一个不存在的情况加一条分支，代价是读代码的人要多想一层
    expect(exportFileName('/notes/.md', '空文档')).toBe('.html')
  })
})
