/**
 * 打印快照（M7-15）：把一份已经渲染好的正文挂进主窗口，只在打印媒体里可见。
 *
 * ## 为什么「导出 PDF」要借打印面板
 *
 * macOS 上只有一个可靠的出口：wry 的 `WebviewWindow::print()`（原生
 * `WKWebView.printOperationWithPrintInfo`）。页面里的 `window.print()` 在 WKWebView 里是
 * **空操作**——它不像 Safari 那样自带浏览器外壳，没人接这个调用。于是「导出 PDF」这条路
 * 就是：把应用界面在打印媒体里藏掉、只留正文，再交给系统的打印面板，
 * 用户在面板左下角的「PDF ▾」里选「存储为 PDF」。
 *
 * ## 🔴 正文必须来自 `./render.ts`，这里不再清洗
 *
 * `bodyHtml` 原样进 `innerHTML`，与 `./export.ts` 是同一条安全边界：调用点递进来的必须是
 * `previewHtml()` 的产物。这一层不做第二遍白名单——两套清洗规则迟早漂开，而漂开的那一天
 * 看起来一切正常。同理，样式也是原封不动的 `EXPORT_STYLE`，导出的 HTML 与打印出来的 PDF
 * 因此是同一个观感，不会出现「网页一套、纸上另一套」。
 *
 * ## ⚠️ 快照**不随打印结束删除**
 *
 * `print()` 返回的是「打印面板已经弹出来了」，不是「打印完了」；wry 没有回调能等到面板关闭，
 * 而打印预览是照着**活文档**排版的。⛔ 不要在这之后立刻摘掉快照——那会让面板里/纸上的
 * 内容缺一截，且没有任何报错。下一次打印前整块替换即可。
 *
 * 它留在屏幕上也没有代价：屏幕上 `display: none`（见 `styles.css` 的打印快照那一节），
 * 并带 `aria-hidden`，不进无障碍树也不进 Tab 顺序。`html[data-print-snapshot]` 这个开关
 * 只在打印媒体里被读到，全应用唯一的打印入口就是这条命令，所以它同样不需要摘。
 */

import { EXPORT_STYLE } from './export'

/** 快照根节点。`styles.css` 里那几条 `@media print` 规则按这个 id 认它 */
export const PRINT_ROOT_ID = 'vela-print-root'

/** 只在打印媒体里生效的样式表。导出的 HTML 里那一份 `<style>` 用的是同一段常量 */
export const PRINT_STYLE_ID = 'vela-print-style'

/**
 * 挂（或替换）打印快照。
 *
 * 三次以上的调用是合法的：每次导出都重新渲染一份，旧快照被整块换掉而不是叠加——
 * 叠加的失败方式是「第二份文档打印出来是第一份」，而那件事只有在纸上才看得见。
 */
export function mountPrintSnapshot(bodyHtml: string): void {
  let style = document.getElementById(PRINT_STYLE_ID)
  if (!(style instanceof HTMLStyleElement)) {
    const created = document.createElement('style')
    created.id = PRINT_STYLE_ID
    // 用 `media` 属性而不是在内容外面包一层 `@media print`：EXPORT_STYLE 自己已经有一段
    // `@media print` 了，嵌两层不是错，但「只在这一种媒体里生效」这件事写在一个地方更清楚
    created.media = 'print'
    document.head.appendChild(created)
    style = created
  }
  style.textContent = EXPORT_STYLE

  let root = document.getElementById(PRINT_ROOT_ID)
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('main')
    root.id = PRINT_ROOT_ID
    // 与 `exportHtml` 的 `<main class="md-doc">` 是同一个外壳：EXPORT_STYLE 的每一条
    // 排版规则都挂在 `.md-doc` 下
    root.className = 'md-doc'
    root.setAttribute('aria-hidden', 'true')
    document.body.appendChild(root)
  }
  root.innerHTML = bodyHtml

  // 开关放在 `<html>` 上而不是根节点自己身上：`body` 的 `overflow: hidden` 与 `height: 100%`
  // 是全局布局，必须由一条能压过它们的规则一并改掉，否则打印只会出一页
  document.documentElement.dataset.printSnapshot = ''
}
