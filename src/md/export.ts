/**
 * 导出成单文件 HTML（M3-A-6）。纯字符串拼接，不认识 CM6、不认识 Solid、不认识文件系统。
 *
 * ## 🔴 安全边界与预览是**同一条**，一点没加宽
 *
 * `bodyHtml` 那个参数**原样**插进去，不转义、不清洗、也不做任何「顺手修一修」的正则替换。
 * 这么写是安全的，唯一的理由是：调用点（`App.tsx` 的 `exportHtml` hook）递进来的是
 * `previewHtml()` 的产物，而那份产物的每一个字节都出自 `./render.ts` 的白名单与转义
 * （28 个标签、非白名单协议降级成 `<span class="md-unsafe-link">`、本地图片是占位而不是 `<img>`）。
 *
 * ⛔ 所以这一层只有两个输入是可信的：`bodyHtml` 必须来自 `render.ts`，`title` 必须过
 * `escapeHtml`（下面那一次调用就是它唯一的出口）。谁要在这一层里再拼一个字符串进去，
 * 就等于在**预览那一整套用例看不见的地方**开了一道口子——而导出的文件是要发给别人的，
 * 泄漏面比预览还大：它在浏览器里打开，不在 Vela 的沙箱里。
 *
 * ## 🔴 导出的文件里**一个脚本都没有**，这是有意的
 *
 * 于是预览里那个能点的 GFM 勾选框（M3-A-5）在导出件里是**死的**：`render.ts` 给它的是
 * `role="checkbox"` + `tabindex="0"`，样式把它画成勾选框，但点下去什么也不会发生。
 * 不加脚本的理由比「让它能点」重要得多：一份带着脚本的 HTML 在别人的浏览器里就是可执行文件，
 * 而这份文件是用户**主动发出去**的。少一个能点的勾选框，换「Vela 导出的 HTML 永远不含脚本」
 * 这句能说出口的话，划算。下面的样式因此给 `.md-task` 配的是 `cursor: default`。
 *
 * ## ⚠️ 字体：**只用系统字体栈，⛔ 不内嵌霞鹜文楷**
 *
 * 两条理由，第一条是法律：LXGW WenKai Screen 的 OFL 声明了保留字体名（`霞鹜` / `LXGW`），
 * 而把字体塞进导出件属于再分发——那条 RFN 的账本来就还没结（PLAN.md 里欠用户的那个决定），
 * 不该由一个导出功能悄悄替它做决定。第二条是体积：一份内嵌字体的「单文件 HTML」是几 MB 起，
 * 而「单文件」这个卖点的全部意义就是它能当附件发出去。
 *
 * 于是导出件的观感与 Vela 里的预览**不一样**（那边是文楷 + Maple Mono CN，这边是系统字体）。
 * 这不是没做完：一份要在别人机器上、在纸上、在邮件里看的东西，本来就该用那台机器上
 * 一定有的字体
 *
 * ## ⚠️ 配色是**写死的浅色**，不跟着主题走
 *
 * 编辑器里默认是深色主题（Tokyo Night），而导出件是拿去读和打印的。跟着主题走的话，
 * 用户在深色主题下按一次导出，得到的是一张黑底白字的网页——打印出来是一整页墨。
 * 写死也让这一层保持纯：读 `getComputedStyle` 拿 CSS 变量的话，它就得认识 DOM，
 * 而 jsdom 里 `styles.css` 压根没加载，那些变量全是空的，用例也就无从写起
 */

import { MARKDOWN_EXT } from '../editor/language'
import type { FileFormat } from '../ipc/fs'
import { escapeHtml } from './render'

/**
 * 导出件落盘时用的格式：UTF-8、无 BOM、LF。
 *
 * ⚠️ 刻意**不继承源文档的格式**。一份 GBK 的 Markdown 导出成 GBK 的 HTML，
 * 浏览器要靠 `<meta charset>` 与它自己的猜测去认——而那份 meta 写的是 `utf-8`，
 * 于是两者打架，中文变成一片问号。导出件是要发出去的，它该用最不会被认错的那一种。
 *
 * 同理不换 CRLF：HTML 里的换行符只是排版空白，而 `save_file` 走的 `apply_eol`
 * 会把整份文件的 `\n` 都换掉，多此一举还多一份字节。
 *
 * 放在这一层（而不是 `App.tsx` 那个 hook 里）是为了让「一份导出件长什么样」这件事
 * 有一个模块负责：文件名在这儿、内容在这儿、落盘格式也在这儿
 */
export const EXPORT_FILE_FORMAT: FileFormat = { encoding: 'utf8', bom: false, eol: 'lf' }

/**
 * 导出件的那份样式。
 *
 * ⚠️ **整块是常量，一个插值都没有**：它是这份文件里唯一一段「不经转义就写进 HTML」的东西，
 * 而它之所以能这么写，正是因为它不含任何来自文档的字节。谁要往里插一个变量，
 * 那个变量就得先过 `escapeHtml`——而 CSS 里的转义规则与 HTML 的不是一回事，
 * 所以正确的做法是**不要插**
 *
 * 排版口径与 `styles.css` 里 `.md-preview-body` 那一段对齐（同样的行距、同样的标题级差、
 * 同样只给前两级画底线），差别只在颜色是写死的、宽度是居中限宽的
 */
export const EXPORT_STYLE = `
:root {
  color-scheme: light;
}

body {
  margin: 0;
  background: #fff;
  color: #1f2328;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 16px;
  line-height: 1.75;
  -webkit-text-size-adjust: 100%;
}

/* 限宽 + 居中：一行 90 个汉字是读不动的，而「单文件导出」最常见的去处是浏览器全屏 */
.md-doc {
  max-width: 46em;
  margin: 0 auto;
  padding: 2.5em 1.5em 4em;
  overflow-wrap: break-word;
}

.md-doc > :first-child {
  margin-top: 0;
}

.md-doc > :last-child {
  margin-bottom: 0;
}

.md-doc p {
  margin: 0 0 0.9em;
}

.md-doc h1,
.md-doc h2,
.md-doc h3,
.md-doc h4,
.md-doc h5,
.md-doc h6 {
  margin: 1.4em 0 0.6em;
  line-height: 1.35;
  font-weight: 600;
}

.md-doc h1,
.md-doc h2 {
  padding-bottom: 0.25em;
  border-bottom: 1px solid #d1d9e0;
}

.md-doc h1 {
  font-size: 1.6em;
}

.md-doc h2 {
  font-size: 1.35em;
}

.md-doc h3 {
  font-size: 1.18em;
}

.md-doc h4 {
  font-size: 1.06em;
}

.md-doc h5,
.md-doc h6 {
  font-size: 1em;
  color: #59636e;
}

.md-doc ul,
.md-doc ol {
  margin: 0 0 0.9em;
  padding-left: 1.6em;
}

.md-doc li {
  margin: 0.2em 0;
}

.md-doc li > ul,
.md-doc li > ol {
  margin-bottom: 0;
}

.md-doc li.md-task-item {
  list-style: none;
  margin-left: -1.2em;
}

.md-doc .md-task {
  display: inline-block;
  width: 0.95em;
  height: 0.95em;
  margin-right: 0.45em;
  border: 1px solid #d1d9e0;
  border-radius: 2px;
  vertical-align: -0.1em;
  text-align: center;
  line-height: 0.95em;
  font-size: 0.85em;
  /* ⛔ 不是 pointer：导出件里没有脚本，它点不动（理由见文件头）。
     画成能点的样子再点不动，比画成不能点的样子更让人怀疑是不是自己点歪了 */
  cursor: default;
}

.md-doc .md-task[data-checked='true'] {
  background: #0969da;
  border-color: #0969da;
  color: #fff;
}

.md-doc .md-task[data-checked='true']::after {
  content: "✓";
}

.md-doc blockquote {
  margin: 0 0 0.9em;
  padding: 0.2em 0 0.2em 0.9em;
  border-left: 3px solid #d1d9e0;
  color: #59636e;
}

.md-doc blockquote > :last-child {
  margin-bottom: 0;
}

.md-doc pre,
.md-doc code,
.md-doc table {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

.md-doc pre {
  margin: 0 0 0.9em;
  padding: 8px 10px;
  background: #f6f8fa;
  border-radius: 3px;
  overflow-x: auto;
  line-height: 1.5;
  font-size: 0.92em;
}

.md-doc code {
  padding: 0.1em 0.35em;
  background: #f6f8fa;
  border-radius: 3px;
  font-size: 0.92em;
}

.md-doc pre code {
  padding: 0;
  background: none;
  border-radius: 0;
  font-size: inherit;
}

.md-doc hr {
  margin: 1.4em 0;
  border: none;
  border-top: 1px solid #d1d9e0;
}

.md-doc a {
  color: #0969da;
  text-decoration: none;
}

.md-doc a:hover {
  text-decoration: underline;
}

.md-doc .md-unsafe-link {
  color: #cf222e;
  cursor: not-allowed;
}

.md-doc .md-img-local {
  color: #59636e;
  border-bottom: 1px dashed #d1d9e0;
  cursor: help;
}

.md-doc img {
  max-width: 100%;
}

.md-doc table {
  margin: 0 0 0.9em;
  border-collapse: collapse;
  font-size: 0.95em;
}

.md-doc th,
.md-doc td {
  padding: 4px 10px;
  border: 1px solid #d1d9e0;
}

.md-doc th {
  background: #f6f8fa;
  font-weight: 600;
}

.md-doc .md-left {
  text-align: left;
}

.md-doc .md-center {
  text-align: center;
}

.md-doc .md-right {
  text-align: right;
}

@media print {
  .md-doc {
    max-width: none;
    padding: 0;
  }

  .md-doc a {
    color: inherit;
    text-decoration: underline;
  }
}
`.trim()

/**
 * 拼出一份完整的 HTML 文档。
 *
 * ⚠️ `bodyHtml` **原样**进去，`title` 过 `escapeHtml`——两者的差别与理由写在文件头。
 * 刻意不接「要不要带样式表」这类选项：一份没有样式的导出件是一堆挤在一起的标签，
 * 而「单文件」这个卖点的全部意义就是拿到手就能看
 */
export function exportHtml(title: string, bodyHtml: string): string {
  // ⛔ 没有 `lang` 属性：Vela 不知道这份文档是哪种语言写的，而写错一个 `lang`
  // 会让屏幕阅读器用错的发音规则念完整篇——那比不写更糟。CJK 字形由字体栈点名，不靠 `lang`
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Vela">
<title>${escapeHtml(title)}</title>
<style>
${EXPORT_STYLE}
</style>
</head>
<body>
<main class="md-doc">
${bodyHtml}
</main>
</body>
</html>
`
}

/**
 * 默认的导出文件名：`notes/t.md` → `t.html`。
 *
 * `fallback` 是给无名文档用的（调用点递 `doc.name()`，也就是「空文档」）——
 * 未命名文档按 Markdown 处理是 `editor/language.ts` 那条默认值，所以它**能**导出，
 * 于是它也得有个名字
 *
 * ⚠️ 只剥 Markdown 那几个扩展名，其余一律**追加** `.html`：
 * 一份 `notes.tar.gz` 不该变成 `notes.tar.html`——把中间那段当成扩展名剥掉的话，
 * 用户拿到的是一个名字看着像压缩包、内容是网页的东西
 */
export function exportFileName(path: string | null, fallback: string): string {
  const name = path === null ? fallback : baseName(path)
  return `${MARKDOWN_EXT.test(name) ? name.replace(MARKDOWN_EXT, '') : name}.html`
}

/** 与 `editor/language.ts` 的 `baseName` 同一个口径：`/` 与 `\` 都认，取最后一段 */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}
