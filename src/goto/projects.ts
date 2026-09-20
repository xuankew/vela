/**
 * `Cmd+Shift+O`（最近项目）那一栏候选的纯函数部分（M2-F-6）。
 *
 * 与 `./symbols.ts` 同一套分工：**这一层只算字符串，不碰 store、不碰 DOM**，
 * 于是「两个同名项目怎么分开」「多根那条候选该写什么」这些能被穷举。
 *
 * ## 一条候选是一个**根清单**，不是一个路径
 *
 * 清单本身存在项目树那一层（`src/project/store.ts` 的 `recentProjects`），
 * 这一层拿到的是已经排掉当前工作区的那一份。这里只回答「它该被画成什么样」。
 */

// 只借这一个纯函数，理由与 `./store.ts` 那条 import 逐字相同：
// 「怎么从一条绝对路径里抠出最后一段」在 `tree.ts` 里已经把末尾斜杠与根目录 `/` 都处理过了
import { displayName } from '../project/tree'

/**
 * 候选行上那个名字。
 *
 * 多根时在后面挂一个「还有几个」：`vela +2`。刻意不写成 `vela、notes、docs`——
 * 三个长名字排在一行里，用户扫过去只看见一片字，而他要认的其实只是「是哪一个项目」。
 * 剩下的两个名字在悬停的 title 里一行一个（见 `./store.ts` 的 `projectRows`）。
 *
 * 空清单给空字符串：那种条目在 `restoreRecent` 里就被摘掉了，这里只是不让它画出 `undefined`
 */
export function projectLabel(roots: readonly string[]): string {
  const first = roots[0]
  if (first === undefined) return ''
  const name = displayName(first)
  return roots.length > 1 ? `${name} +${roots.length - 1}` : name
}

/**
 * 画在名字前面那一格：第一个根的**父目录**。
 *
 * ## 为什么要有它
 *
 * 只有名字的话，`~/work/app` 与 `~/side/app` 在浮层里是两行一模一样的 `app`。
 * 而 `Cmd+Shift+O` 的全部价值就是「切到我要的那一个」——两行分不出来，
 * 用户只能靠悬停一个个读 title，那比没有这一栏更慢。
 *
 * 与文件候选的 `.palette-root` 复用同一格与同一条 `/` 分隔线（`::after`），
 * 于是两种模式下左边界对齐，读起来也是同一句话：「这个名字在那个地方」
 */
export function projectWhere(roots: readonly string[]): string {
  const first = roots[0]
  if (first === undefined) return ''
  const cut = first.lastIndexOf('/')
  // 没有斜杠 = 不是绝对路径。清单里的条目一律来自原生目录对话框，走不到这里，
  // 但给空串比给一个错的父目录好
  if (cut < 0) return ''
  // `/vela` 的父层是根目录，`slice(0, 0)` 会得到空字符串——那时如实给一个斜杠
  return cut === 0 ? '/' : first.slice(0, cut)
}

/**
 * 按输入过滤最近项目。
 *
 * ⚠️ 与 `filterSymbols` 同一条规矩：**大小写不敏感的子串匹配**，刻意不做模糊匹配、
 * 也不打分排序。文件那一半的模糊匹配在 Rust（`vela_core::project::index`），
 * 这里再写一套 TS 的打分器，同一个浮层里切一下模式就会换一套排序规则。
 *
 * 匹配的是**完整路径**而不只是名字：用户记得住的是 `~/work/app`，
 * 只比名字的话打 `work` 会得到一个空列表，而那看起来像「这个项目没被记下来」
 *
 * 空串回全表：`Cmd+Shift+O` 刚打开时输入框是空的，那时该列出全部
 */
export function filterProjects(entries: readonly (readonly string[])[], needle: string): (readonly string[])[] {
  if (needle === '') return [...entries]
  const lower = needle.toLowerCase()
  return entries.filter((roots) => roots.some((root) => root.toLowerCase().includes(lower)))
}
