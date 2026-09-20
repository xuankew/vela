import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { CommandPalette } from './palette'

/**
 * `Mod+Shift+P` 的浮层（M3-B-1d，PLAN 第 77 行那条核心功能）。
 *
 * ## 复用 QuickOpen 那一套，而不是另起一套
 *
 * 类名沿用 `.palette-*`：两块浮层是同一件东西的两个数据源——一个列文件与标题，
 * 一个列命令。让它们看起来一样的好处不只是省 CSS，而是「顶部一块浮层、打几个字、
 * ↑↓ 挑、Enter 落地、Escape 走人」这一套手势在两个地方完全一致，用户不必学两遍。
 *
 * ⚠️ 于是这一层**只**加了三个类：`.palette.wide`（命令要同时装下标题、分类与快捷键，
 * 520px 挤）、`.palette-row.command`（命令标题是散文 → UI 字体，不是路径 → 代码字体）、
 * `.palette-row.disabled`（`when` 不满足的那一条）。其余全在 `styles.css` 的跳转浮层那一段里。
 *
 * ## ⛔ 不虚拟化
 *
 * 六十来行、将来上百。理由写在 `./palette.ts` 的文件头。
 * 于是这里没有 `.palette-spacer` / `.palette-window` 那一层——那两层是为
 * `visibleWindow` 的位移算术存在的，不虚拟化就不需要它们。
 *
 * ## 键盘
 *
 * 落点在 `palette.ts` 的 `moveRow`（纯函数、已单测）。这一层只做三件事：
 * 收窄 `e.key`、`preventDefault`、把选中行滚进可视区。
 *
 * ⚠️ 处理挂在**遮罩**上而不是输入框上：点过某一行之后焦点可能不在输入框里，
 * 而那一下 Escape 也该收起浮层。`Escape` 依旧**不注册成命令**——命令中心的 keybinding
 * 挂在 `window` 的**捕获**阶段（见 `src/commands/dispatch.ts`），捕获跑在冒泡之前，
 * 浮层里的 `stopPropagation` 拦不住它
 */

export interface CommandPaletteProps {
  /** App 建一次、从不换引用的那份状态，见 `./palette.ts` */
  palette: CommandPalette
}

/**
 * 行高。**只**用来算「一页是多少行」。
 *
 * ⚠️ 它与 `styles.css` 里 `.palette-backdrop` 上那个 `--vela-palette-row-height: 20px`
 * 是同一个数的两份写法。QuickOpen 那边这个数是虚拟滚动窗口算术的输入，所以由组件注入
 * CSS 变量、只有一个真相；这里没有虚拟滚动，它漂了也只是 `PageDown` 多走或少走一行，
 * 于是留在 CSS 里当默认值、JS 侧只留这一个近似值
 */
const ROW_HEIGHT = 20

export function CommandPalette(props: CommandPaletteProps) {
  // 与 QuickOpen / ToolBox 同理：`palette` 是 `createCommandPalette()` 返回的普通对象，
  // 引用从不变；响应式读取全走 `palette.rows()` 这类访问器
  // eslint-disable-next-line solid/reactivity
  const palette = props.palette

  let inputEl: HTMLInputElement | undefined
  let scrollEl: HTMLDivElement | undefined

  const [viewportHeight, setViewportHeight] = createSignal(0)
  /** jsdom 里量不到高度，于是这里是 1——`PageDown` 只走一行，不是 bug */
  const pageSize = createMemo(() => Math.max(1, Math.floor(viewportHeight() / ROW_HEIGHT)))

  function measure() {
    if (scrollEl) setViewportHeight(scrollEl.clientHeight)
  }

  onMount(() => {
    measure()
    // 与 QuickOpen 同理不用 ResizeObserver：浮层宽度是 CSS 定死的，列表高度只跟着窗口走，
    // 而 jsdom 里没有 ResizeObserver
    window.addEventListener('resize', measure)
    inputEl?.focus()
  })
  onCleanup(() => window.removeEventListener('resize', measure))

  /**
   * 每加一就 focus 一次。用**计数**而不是布尔：浮层已经开着的时候再按一次 `Mod+Shift+P`，
   * 布尔值不变就不会触发这个 effect，焦点也就抢不回来（理由与 `goto/store.ts` 逐字相同）。
   *
   * ⚠️ 不顺手 `select()` 全选：`show()` 每次都把查询词清空，所以任何一条真实路径上
   * 都没有「上一次留下的文字」可选。为一种不会发生的情形留一行代码，
   * 只会让下一个人以为它有用途
   */
  createEffect(() => {
    if (palette.focusRequest() === 0) return
    inputEl?.focus()
  })

  /** 把某一行滚进可视区。已经在里面时一动不动——「跳一下」比「不动」更让人失去方向 */
  function scrollToIndex(index: number) {
    const el = scrollEl
    if (!el) return
    const top = index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      palette.hide()
      return
    }
    if (e.key === 'Enter') {
      // ⚠️ 必须 preventDefault，即便一条都没匹配上：不拦的话浏览器会把它当成表单提交，
      // 而某些内核会顺手把焦点挪走
      e.preventDefault()
      palette.commit()
      return
    }
    const delta =
      e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowUp'
          ? -1
          : e.key === 'PageDown'
            ? pageSize()
            : e.key === 'PageUp'
              ? -pageSize()
              : null
    // `null` = 不是这四个键，一律放行给输入框（`←`/`→` 是文本光标的事）
    if (delta === null) return
    e.preventDefault()
    const before = palette.selected()
    palette.moveBy(delta)
    if (palette.selected() !== before) scrollToIndex(palette.selected())
  }

  return (
    <Show when={palette.visible()}>
      <div
        class="palette-backdrop"
        onKeyDown={onKeyDown}
        // 点遮罩空白处收起，点子元素不算（与 QuickOpen、ToolBox 同一条）
        onClick={(e) => {
          if (e.currentTarget === e.target) palette.hide()
        }}
      >
        <div class="palette wide" role="dialog" aria-label="命令面板">
          <input
            class="palette-input"
            ref={inputEl}
            type="text"
            value={palette.query()}
            placeholder="按名字、分类或 id 找命令…（↑↓ 选，Enter 执行）"
            aria-label="命令"
            aria-controls="command-palette-list"
            spellcheck={false}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            onInput={(e) => palette.setQuery(e.currentTarget.value)}
          />

          <div class="palette-list" id="command-palette-list" ref={scrollEl} role="listbox" aria-label="命令候选">
            <For each={palette.rows()}>
              {(row, i) => (
                <div
                  class="palette-row command"
                  classList={{ selected: palette.selected() === i(), disabled: !row.enabled }}
                  role="option"
                  aria-selected={palette.selected() === i()}
                  // `aria-disabled` 而不是 `disabled`：这一行是个 div，没有 disabled 可言；
                  // 而读屏的人该知道「这一条现在按不动」，`opacity` 是说给他听的
                  aria-disabled={!row.enabled}
                  // id 是给「看得见名字却不知道它叫什么」的人的：`editor.toggleLineWrap`
                  // 与「切换自动换行」是同一条命令，而查询词两个都能打
                  title={row.id}
                  onClick={() => {
                    palette.select(i())
                    palette.commit()
                  }}
                  // 鼠标移到哪一行就选中哪一行：面板是「按 Enter 落地」的东西，
                  // 让悬停与选中不一致的话，用户会以为 Enter 执行的是他指着的那一条
                  onMouseEnter={() => palette.select(i())}
                >
                  <span class="palette-text">{row.title}</span>
                  <span class="palette-cat">{row.category}</span>
                  {/* 没有绑定快捷键的那一格压根不画节点，⛔ 不画一个空 span：
                      空 span 也会占掉它自己那份 margin，于是有键与没键的两行右边界对不齐 */}
                  {row.keys === '' ? null : <span class="palette-keys">{row.keys}</span>}
                </div>
              )}
            </For>
          </div>

          <div class="palette-foot">
            <span class="palette-status">{palette.footer()}</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
