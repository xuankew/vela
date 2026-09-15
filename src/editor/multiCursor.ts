import { EditorSelection } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { selectSelectionMatches } from '@codemirror/search'
import { EditorView, ViewPlugin, rectangularSelection, type Command } from '@codemirror/view'
import { detectPlatform, type Platform } from '../commands/keybinding'

/**
 * 多光标（M1-C-2）。分两块：鼠标手势的分流，与 CM6 键盘命令的一个补洞。
 *
 * ## 鼠标
 *
 * CM6 出厂时 `rectangularSelection` 吃掉**整个 Alt+左键拖拽**：它的 `mouseSelectionStyle`
 * 在 `handlers.mousedown` 里排在 `basicMouseSelection` **前面**，filter 一命中就直接返回列块
 * 样式，普通点击逻辑压根不会被问到。所以「Alt+Click 加一个光标」在默认配置下不存在。
 *
 * PLAN.md 同时要求「Alt+Click 加光标」与「列块选择（鼠标拖拽）」，两者不可能都占 Alt+拖拽，
 * 于是按 VS Code 的既有约定拆开：
 *
 * | 手势 | 行为 |
 * | --- | --- |
 * | 单击 / 拖拽 | 普通选区，替换 |
 * | **Option+单击** | 加一个光标；点在已有光标上则把它移除 |
 * | **Option+拖拽** | 加一个光标并拖出选区 |
 * | **Option+Shift+拖拽** | 列块选择，替换整个选区 |
 * | Cmd+单击（macOS）/ Ctrl+单击（其余） | 加一个光标，CM6 平台默认，保留 |
 * | Shift+拖拽 | 扩展当前选区，CM6 默认，保留 |
 *
 * ⚠️ `clickAddsSelectionRange` 这个 facet **一旦注册就完全接管**：CM6 的 `addsSelectionRange()`
 * 只读 `facet[0]`，不与默认值合并。所以非 Alt 分支必须自己把平台默认（mac 看 metaKey、
 * 其余看 ctrlKey）原样实现一遍，漏掉就等于把 Cmd+Click 加光标这个既有能力弄坏了。
 *
 * ## 键盘
 *
 * 键盘侧不重写任何东西：`Mod+D` / `Mod+Alt+↑↓` 直接注册 CM6 自己的命令（见 commands/builtins）。
 * 唯一的例外是文件末尾的 `selectAllOccurrences`，它补的是 CM6 一个会走到死路的洞。
 */

/**
 * 只用到这几个字段，和 `keybinding.ts` 的 `KeyEventLike` 同一个道理：
 * 单测跑在 node 环境里没有 DOM，而这两条谓词只依赖修饰键与按键号。
 * 真 `MouseEvent` 结构上兼容它，且逆变让谓词能直接递给 CM6 的 facet。
 */
export interface MouseButtonFields {
  button: number
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/** 列块选择的触发条件。与平台无关：Option+Shift 在任何平台都不该是别的意思 */
export function isColumnSelectDrag(event: MouseButtonFields): boolean {
  return event.altKey && event.shiftKey && event.button === 0
}

export function clickAddsCursor(event: MouseButtonFields, platform: Platform): boolean {
  if (!event.altKey) return platform === 'macos' ? event.metaKey : event.ctrlKey
  // Option+Shift 让给列块选择。这一条必须是 false：`rectangleSelectionStyle` 在 multiple
  // 为真时会把列块 **concat 到已有选区后面**，而列块选择应当替换掉整个选区。
  return !event.shiftKey
}

const showCrosshair = { style: 'cursor: crosshair' }

/**
 * 只在 Option+Shift 同时按下时把光标换成十字。
 *
 * 不直接用 CM6 的 `crosshairCursor()`：它内部那张 `keys` 表只有单个修饰键，没有组合键，
 * 照原样留着的话单独按 Option 也会变十字——而 Option+Click 现在是「加光标」，十字在那儿是
 * 个错误提示（十字在各家编辑器里都意味着框选）。
 */
class ColumnSelectHint {
  isDown = false

  constructor(private view: EditorView) {}

  set(isDown: boolean) {
    if (this.isDown === isDown) return
    this.isDown = isDown
    // 传空数组只为触发一次重算，好让 contentAttributes 重新求值
    this.view.update([])
  }
}

const columnSelectHintPlugin = ViewPlugin.fromClass(ColumnSelectHint, {
  eventObservers: {
    // keyup 上被松开的那个键，自己的修饰位已经是 false，所以三个监听用同一个表达式就够。
    // 窗口失焦时可能漏掉 keyup，mousemove 会把它纠正回来——CM6 自己也是这个精度。
    keydown(e) {
      this.set(e.altKey && e.shiftKey)
    },
    keyup(e) {
      this.set(e.altKey && e.shiftKey)
    },
    mousemove(e) {
      this.set(e.altKey && e.shiftKey)
    },
  },
})

const platform = detectPlatform()

export const mouseGestures: Extension = [
  rectangularSelection({ eventFilter: isColumnSelectDrag }),
  EditorView.clickAddsSelectionRange.of((event) => clickAddsCursor(event, platform)),
  columnSelectHintPlugin,
  EditorView.contentAttributes.of((view) => (view.plugin(columnSelectHintPlugin)?.isDown ? showCrosshair : null)),
]

/**
 * 「选中全部相同内容」（Cmd+Shift+L）。
 *
 * CM6 的 `selectSelectionMatches` 只接受**单一非空选区**：`sel.ranges.length > 1` 就直接
 * `return false`。但「Cmd+D 按了几下，再 Cmd+Shift+L 一次全要」是用户真会走的路线，
 * 停在那儿一动不动像是坏掉了。所以先收敛到第一个选区再跑一次。
 *
 * 收敛**只在所有选区文本相同时**才做——那正是 Cmd+D 造出来的状态，语义没有歧义。
 * 文本各不相同（Option+Click 随便点出来的）时保持 CM6 的拒绝：否则等于悄悄按其中一个
 * 把用户其余光标全替换掉，那是丢工作。
 */
export const selectAllOccurrences: Command = (view) => {
  if (selectSelectionMatches(view)) return true

  const { state } = view
  const ranges = state.selection.ranges
  if (ranges.length < 2) return false
  const first = ranges[0]!
  const text = state.sliceDoc(first.from, first.to)
  if (!text) return false
  if (ranges.some((r) => state.sliceDoc(r.from, r.to) !== text)) return false

  view.dispatch({ selection: EditorSelection.range(first.from, first.to) })
  // dispatch 是同步的，view.state 已经是收敛后的那一份
  return selectSelectionMatches(view)
}
