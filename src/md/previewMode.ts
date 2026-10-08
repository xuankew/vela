/**
 * Markdown 预览那一栏的三档形态。
 *
 * ## 为什么是一个三档循环，而不是新加一条命令
 *
 * 「只预览」不是一个与「切换预览」并列的动作，它是同一个动作的第三档：
 * 关 → 并排 → 只预览 → 关。做成新命令的代价是三处（`commands/builtins.ts` 一条、
 * `src-tauri/src/menu.rs` 一项、`builtins.test.ts` 里那份硬编码清单），换来的却是一个
 * 用户得先知道它存在才会去菜单里找的开关。循环不需要学：他已经在按 `Cmd+Shift+V`，
 * 多按一次就到了。
 *
 * ## 🔴 `only` 是**藏**编辑器，不是卸载它
 *
 * 预览的数据源 `FollowedEditor`（`./panel.ts`）带的是一个**活的 CM6 view**：渲染读它的
 * `state`，同步滚动读它的 `scrollDOM`，点勾选框回写走它的 `dispatch`。卸载 `.body` 的话
 * `ws.focusedView()` 变 null，预览自己就空了——「只预览」会成了「什么都没有」。
 *
 * 于是留下两笔认了的债：
 *
 * - 那块编辑器只是看不见，`Mod+F` / `Alt+Z` / 多光标这类命令**照样生效**，作用在一个
 *   看不见的地方。这是 `ShardPane.tsx` 文件头那条 🔴 警告的同一种失败方式，区别在于
 *   这里面板标题会明说「阅读模式」，用户至少知道自己不在编辑态；
 * - 藏起来的 CM6 不参与排版，`scrollDOM` 的三个几何量全是 0。所以 `MarkdownPreview` 的
 *   `follow()` 必须自己认「源没有布局」这一态——不认的话 `atBottom(0,0,0)` 恒为真
 *   （`./scrollSync.ts:145`），每一次防抖重画都会把预览甩到最底下。
 *
 * ⚠️ 还有一层：`only` 并不总是藏得起来。当前文档压根没有预览（`.ts`、只读大文件分片）时，
 * 藏掉编辑器等于把整块屏幕让给一句「TypeScript 还没有预览」，那是个死胡同。
 * 判据在 App 的 `editorHidden()` 上，它要求预览**真的有东西可看**。
 */
export type PreviewMode = 'off' | 'side' | 'only'

/** `Cmd+Shift+V` 按一下走一格 */
export function nextPreviewMode(mode: PreviewMode): PreviewMode {
  if (mode === 'off') return 'side'
  if (mode === 'side') return 'only'
  return 'off'
}
