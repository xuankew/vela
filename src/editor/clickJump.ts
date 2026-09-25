import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { detectPlatform, type Platform } from '../commands/keybinding'

/**
 * `Cmd+Click`（macOS）/ `Ctrl+Click`（其余）跳到定义（M5-2）。
 *
 * 这一层只做两件事：**认出这个手势**、**把点击位置换算成一个文档位置交给宿主**。
 * 「那个词是什么、有没有定义、跳过去之后焦点放哪儿」全在宿主那边（`src/App.tsx` 的
 * `definitionFromClick`），因为那些是工作区与符号表的知识，而这一层刻意不认识它们——
 * 与 `./paste.ts` 对图片粘贴做的分工逐字相同。
 *
 * ## 🔴 这个手势位在代码文件里被**换掉**了
 *
 * `src/editor/multiCursor.ts` 那张手势表里，macOS 的 `Cmd+单击` / 其余平台的 `Ctrl+单击`
 * 原本是「加一个光标」（CM6 平台默认，那个文件自己接管了 `clickAddsSelectionRange`）。
 *
 * 换成「跳到定义」而不是叠加在它上面，是因为 `mousedown` 必须**当场**回答接不接管这一次
 * 点击，而跨文件那一跳只能异步查（没有常驻索引，口径见 `goto/definition.ts` 的
 * `clickAction`）。当场答不出来就只有两种做法：一律接管，或者一律不接管。选了前者，
 * 因为**加光标这件事在本编辑器里另有一条路**——`Option+单击`（`multiCursor.ts` 自己的
 * 绑定，与 VS Code 的映射一致）。所以这里没有夺走一个无可替代的能力。
 *
 * 宿主回 `false` 时这一层也回 `false`，CM6 自己的 mousedown 照旧跑，那一下仍然是加光标。
 * 什么时候回 false 由 `clickAction` 说了算：**笔记（Markdown）、纯文本、JSON、
 * 以及没打开文件夹时**都回 false——那些场合「跳到定义」根本不成立，手势位保持原样
 *
 * ## ⚠️ 接管的前提是「这一下会换来一个动作」
 *
 * 「一律接管、查不到什么也不做」是另一回事，那才是真亏：用户会先以为自己鼠标坏了，
 * 然后才发现「在有定义的地方才好使」。所以现在两种结局都算动作——跳过去，或者把词交给
 * 全局搜索列出 `文件:行`；两者都给不出时才把这一下还回去
 *
 * ## 让位的三种情形
 *
 * `Alt` / `Shift` / 非主键 / 连击（`detail > 1`，双击选词与三击选段）一律不接管：
 * 前两者分别归「加光标 / 列块选择」与「扩展选区」，后两者根本不是一个手势。
 * 判断与 `multiCursor.ts` 的 `clickAddsCursor` 保持同一条平台规则
 * （mac 看 `metaKey`、其余看 `ctrlKey`），⛔ 不是「两个都收」——
 * Linux 上没有任何东西叫 Cmd，两个都收等于把 `Ctrl+Click` 之外再凭空接管一次
 */

/** 宿主对「这一下有没有归宿」的答复：`true` = 已经跳走或已经改去搜，CM6 别再处理 */
export type DefinitionClickHook = (view: EditorView, pos: number) => boolean

/** 用得到的那几个字段，与 `keybinding.ts` 的 `KeyEventLike` 同一条理由：单测跑在 node 里没有 DOM */
export interface ClickFields {
  button: number
  detail: number
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/** 这一次点击是不是「跳到定义」的手势位。纯函数，`platform` 显式传进来 */
export function isDefinitionClick(event: ClickFields, platform: Platform): boolean {
  if (event.button !== 0 || event.detail !== 1) return false
  if (event.altKey || event.shiftKey) return false
  return platform === 'macos' ? event.metaKey : event.ctrlKey
}

/**
 * 装上 `Cmd/Ctrl+Click` 跳定义。宿主没给钩子时压根不装（见 `setup.ts` 里那一条 push），
 * CM6 的加光标行为一点不受影响。
 *
 * ## ⚠️ 用的是 `domEventHandlers`，靠的是它的两条语义
 *
 * 与 `./paste.ts` 里那两条一模一样：插件的处理器排在 CM6 内置的**前面**，
 * 而返回 true 会让 CM6 既 `preventDefault` 又**不再跑自己那个** mousedown——
 * 后者正是「接管时不再多加一个光标」的全部依据。
 * 这两条都是 `@codemirror/view` 的实现细节而不是文档承诺，
 * 所以 `clickJump.test.ts` 里那组用例是真的派发 DOM 事件再看选区，不是只调函数
 */
export function definitionClick(onDefinition: DefinitionClickHook): Extension {
  const platform = detectPlatform()
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!isDefinitionClick(event, platform)) return false
      // `posAtCoords` 是 **view** 的方法（它要量排版），不是 state 的。点在行号槽、滚动条、
      // 或者两段文字之间的空白上都会回 null，那一刻这个手势没有位置可跳，交回 CM6
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return false
      return onDefinition(view, pos)
    },
  })
}
