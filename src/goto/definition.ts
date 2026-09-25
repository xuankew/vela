import type { EditorState } from '@codemirror/state'
import { findSymbol } from './symbols'
import { symbolTable, wordAt } from './syntax'

/**
 * 「跳到定义」的**查询**那一半（M5-1 / M5-2）。
 *
 * 为什么单独一个模块：它有两个入口——`⌥⌘D` 与 `Cmd/Ctrl+Click`（`editor/clickJump.ts`），
 * 而两者的全部差别只在**怎么说**（快捷键四种拒绝各说一句，点击一个字都不说）。查询本身
 * 是同一件事，所以它必须是一个能被两边调用、也能被单测直接调用的纯函数。
 *
 * 留在 `App.tsx` 里的话它就测不到：那条链路的端到端用例（`editor/clickJump.test.ts` 里
 * 「整条链」那组）只能在测试里再抄一份同样的判断，而**抄的那一份会把真逻辑里的错盖掉**
 * ——与 `md/paste.ts` 把「挑哪张图」拆成纯函数、`goto/symbols.ts` 把规则表拆出来
 * 是同一条理由。
 *
 * ⛔ 它不是 LSP：不看作用域、不看类型、**不跨文件**，重名时回文档里最早的那一个
 * （见 `findSymbol`）。这四条正是它可以存在的理由：零常驻内存、零依赖、一次语法树遍历。
 * 跨文件那一跳怎么办，见文件末尾的 [`clickAction`]。
 */

/**
 * 一次查询的四种结果。⛔ 不合成 `pos | null`：
 * 快捷键那一半要把**为什么没跳**分别说出口，而点击那一半要一句都不说
 * ——一个 `null` 装不下这两种相反的要求。
 *
 * `noWord` 与 `notFound` 也不合并：前者是「指的地方根本不是一个词」（停在空白或标点上），
 * 后者是「这是个词，但这文件里没有它的声明」，对应的是两种完全不同的下一步
 * ——后者正是该提示「试试 `Mod+Alt+F` 在项目里搜」的那一种。
 */
export type DefinitionResult =
  | { kind: 'at'; pos: number }
  | { kind: 'noWord' }
  | { kind: 'noTable'; label: string }
  /**
   * `table` 是「刚才在**哪一张**表里没找到」。点击那一半靠它分流（见 [`clickAction`]）：
   * 在代码符号表里没找到 → 那多半是个跨文件的符号，值得改去项目里搜；
   * 在标题表里没找到 → 那只是笔记正文里的一个词，什么都不该发生
   */
  | { kind: 'notFound'; word: string; table: 'headings' | 'code' }

/**
 * 查「`pos` 处那个词在这份文档里有没有声明」。纯查：不跳、不说话、不改任何东西。
 *
 * 🔴 查的是 `symbolTable`，也就是 `Cmd+R` 那份清单**本身**，⛔ 不是另算一遍：两边同源之后，
 * 「浮层里列着却跳不过去」在结构上不可能发生。
 *
 * ⚠️ `state` 与 `path` 必须来自**同一个标签**。它们是两条独立的反查（`tabOfView` 给路径、
 * view 自己给 state），拼错了不会报错，只会跳到隔壁文档里那个同名符号上——所以点击那个
 * 入口两个都得从事件目标那一份 view 推出来，⛔ 不许掺 `activeTab()`
 * （那条时序竞态写在 `doc/workspace.ts` 的 `pasteImage` 上）
 */
export function definitionAt(state: EditorState, path: string | null, pos: number): DefinitionResult {
  const word = wordAt(state, pos)
  if (word === null) return { kind: 'noWord' }
  const table = symbolTable(state, path)
  if (table.kind === 'unsupported') return { kind: 'noTable', label: table.label }
  const hit = findSymbol(table.items, word)
  // 走到这里 `table.kind` 只可能是 `'headings' | 'code'`（`unsupported` 上面已经回了）
  return hit === null ? { kind: 'notFound', word, table: table.kind } : { kind: 'at', pos: hit.pos }
}

/**
 * `Cmd/Ctrl+Click` 那一下的三种归宿（M5-2）。
 *
 * 为什么不直接用 `DefinitionResult`：同一次查询，两个入口要的是**相反的反应**——
 * `⌥⌘D` 查不到要把原因说出口，点击查不到要么改去做别的事、要么一个字都不说。
 * 所以「点击该怎么办」单独一层，而且必须是纯函数：留在 `App.tsx` 里它就测不到，
 * 而这一层恰恰是**会改掉一个既有手势**的那一层（见下面 `ignore` 那条），
 * 没有用例钉住的话，改坏了只会表现为「加光标莫名其妙不灵了」。
 */
export type ClickAction = { kind: 'jump'; pos: number } | { kind: 'search'; word: string } | { kind: 'ignore' }

/**
 * 把一次查询翻译成点击的下一步。`projectOpen` = 现在有没有打开文件夹（宿主读 `tree.roots()`）。
 *
 * ## `search`：跨文件那一跳的**唯一**做法
 *
 * 「这个符号定义在哪个文件里」要么靠一份常驻的跨文件索引（⛔ 这个编辑器不内存化的
 * 正是它，口径见 `goto/symbols.ts` 文件头），要么靠**当场扫一遍**。而全局搜索已经
 * 是「当场扫一遍、把 `文件:行` 列出来、点一行就打开那份文件」——所以跨文件这一跳
 * 不新写任何东西，就是把词填进去按下回车，与 `⌥⌘F` 共用同一条路（`App.tsx` 的
 * `runWordSearch`）。代价是一次点击一趟扫描，换来的是零常驻内存。
 *
 * ⚠️ 它不是「跳过去」而是「列出来让人挑」，这一点必须认：没有索引就没有作用域与
 * 类型的信息，也就无从判断十几个命中里哪个才是真的定义。挑错一次比列出来更贵。
 *
 * ## `ignore` 的两种情形，都是在保住既有手势
 *
 * 回 `ignore` 意味着 `editor/clickJump.ts` 那一层也回 false，于是 CM6 自己的 mousedown
 * 照旧跑，那一下仍然是**加一个光标**（`editor/multiCursor.ts` 的手势表）。所以：
 *
 * - **标题表里没找到**：Markdown 的符号表就是标题，正文里随便一个词都「查不到」。
 *   拿它去搜项目的话，在笔记里 Cmd+点击一个词就会弹一次搜索面板——Vela 首先是笔记
 *   编辑器，这个噪音比跨文件跳转的价值大得多。
 * - **没打开文件夹**：无处可搜。`search()` 只会把面板展开成一句「还没打开文件夹」，
 *   为一次点击弹这个是纯噪音，不如让那一下维持原样。
 */
export function clickAction(result: DefinitionResult, projectOpen: boolean): ClickAction {
  if (result.kind === 'at') return { kind: 'jump', pos: result.pos }
  if (result.kind === 'notFound' && result.table === 'code' && projectOpen) {
    return { kind: 'search', word: result.word }
  }
  return { kind: 'ignore' }
}
