import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import {
  CODE_FONTS,
  DEFAULT_CODE_FONT,
  DEFAULT_VARIANT,
  FONT_VARIANTS,
  type CodeFontId,
  type FontVariantId,
} from '../fonts/loader'
import { DEFAULT_FONT_SIZE, DEFAULT_LETTER_SPACING, DEFAULT_LINE_HEIGHT, FONT_SIZES, type SettingsStore } from './store'

/**
 * 「外观」浮层（M4-B，PLAN §3.6「字体管线产品化」）。
 *
 * 把原本摊在工具栏上的三个 select（正文字体 / 代码字体 / 字号）收进一个下拉，
 * 再加上**行高**与**字间距**两个步进器。工具栏因此只多一个「外观」按钮。
 *
 * ## 🔴 这是一块**锚定下拉**，不是 ToolBox 那种全屏遮罩
 *
 * 关键差别：改行高 / 字间距时要**看得见编辑器实时变化**。一块盖住编辑器的模态遮罩
 * 正好把这件事毁掉——你调的正是被它挡住的那片文字。所以这里：
 * - 没有 backdrop，浮层只占工具栏下方一小块，编辑器仍然露着；
 * - 点浮层外面**关闭**（`document` 上的 pointerdown 监听），而不是「拦截但不关」；
 * - 步进器每一下都立刻经 store 写进 CSS 变量，编辑器当场重排。
 *
 * ## 键盘
 *
 * `Escape` 在自己的子树里处理，**不注册成命令**——与 ToolBox / CommandPalette 同一条规矩
 * （命令中心的 keybinding 挂在 window 的**捕获**阶段，浮层里的 stopPropagation 拦不住它；
 * 而 `builtins.ts` 里「绑 Escape 的命令一律不注册」保证了这里不会有人来抢）。
 *
 * ## 状态全在 store，这里只管画与收键盘
 *
 * 与 `ToolBox.tsx` / `FindInFiles.tsx` 同一分工：这一层不判断「值合不合法」「该不该写盘」，
 * 那些都在 `./store.ts`。组件测试因此只需盯住「画出来的对不对得上 store」与
 * 「按键/点击有没有落到 store 的 mutator 上」。
 */

export interface AppearancePopoverProps {
  /** App 建一次、从不换引用的那份配置状态，见 `./store.ts` */
  settings: SettingsStore
}

export function AppearancePopover(props: AppearancePopoverProps) {
  // `settings` 是 `createSettingsStore()` 返回的普通对象，引用从不变；响应式读取全走
  // `props.settings.fontSize()` 这类访问器。留在 props 上现读会被 lint 当成「追踪范围外读响应式值」
  // eslint-disable-next-line solid/reactivity
  const settings = props.settings

  const [open, setOpen] = createSignal(false)
  let rootEl: HTMLDivElement | undefined
  let firstControlEl: HTMLSelectElement | undefined

  function close(): void {
    setOpen(false)
  }

  function toggle(): void {
    setOpen((v) => !v)
  }

  /**
   * 打开时把焦点交给第一个控件（字号 select）：下拉是「打开就动手」的东西，
   * 焦点还在工具栏按钮上的话，键盘用户得先 Tab 一下才够得着。
   *
   * ⚠️ 用 effect 而不是 onClick 里直接 focus：`<Show>` 那一帧才把面板建出来，
   * onClick 返回时 ref 还没指到节点。effect 在写入后跑，ref 已就位。
   */
  createEffect(() => {
    if (open()) firstControlEl?.focus()
  })

  /**
   * 点浮层外面就关。挂在 `document` 的 pointerdown 上，而不是铺一块透明 catcher：
   * catcher 会挡住编辑器，于是「调完行高顺手点一下正文」变成「点到一块看不见的板子上」。
   * 用 `rootEl.contains` 判断，浮层自己（含按钮）里的点击不算「外面」。
   */
  createEffect(() => {
    if (!open()) return
    const onDocDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (rootEl && target && !rootEl.contains(target)) close()
    }
    // 延迟一帧再挂：打开浮层那一下的 pointerdown 就是点按钮本身，
    // 同步挂上会立刻被这条监听当成「外面」再关掉
    const id = window.setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0)
    onCleanup(() => {
      window.clearTimeout(id)
      document.removeEventListener('pointerdown', onDocDown)
    })
  })

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  /** 字间距的读数：`0` 显示「正常」（对应 CSS `normal`），非零显示 em */
  const letterSpacingLabel = (): string => {
    const n = settings.letterSpacing()
    return n === 0 ? '正常' : `${n}em`
  }

  function resetAll(): void {
    settings.setFontSize(DEFAULT_FONT_SIZE)
    settings.setFontVariant(DEFAULT_VARIANT)
    settings.setCodeFont(DEFAULT_CODE_FONT)
    settings.setLineHeight(DEFAULT_LINE_HEIGHT)
    settings.setLetterSpacing(DEFAULT_LETTER_SPACING)
  }

  return (
    <div class="appearance" ref={rootEl}>
      <button
        class="toolbar-button appearance-toggle"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={toggle}
        title="字号 / 行高 / 字间距 / 字体"
      >
        外观
      </button>

      <Show when={open()}>
        <div class="appearance-pop" role="dialog" aria-label="外观" onKeyDown={onKeyDown}>
          <label class="appearance-row">
            <span class="appearance-label">字号</span>
            <select
              ref={firstControlEl}
              value={settings.fontSize()}
              onChange={(e) => settings.setFontSize(Number(e.currentTarget.value))}
              title="字号（也可用 Cmd/Ctrl + = / - / 0）"
            >
              {FONT_SIZES.map((s) => (
                <option value={s}>{s}px</option>
              ))}
            </select>
          </label>

          <div class="appearance-row">
            <span class="appearance-label">行高</span>
            <div class="appearance-stepper">
              <button onClick={() => settings.stepLineHeight(-1)} aria-label="行高减小" title="行高减小">
                −
              </button>
              <span class="appearance-value" aria-live="polite">
                {settings.lineHeight()}
              </span>
              <button onClick={() => settings.stepLineHeight(1)} aria-label="行高增大" title="行高增大">
                +
              </button>
            </div>
          </div>

          <div class="appearance-row">
            <span class="appearance-label">字间距</span>
            <div class="appearance-stepper">
              <button onClick={() => settings.stepLetterSpacing(-1)} aria-label="字间距减小" title="字间距减小">
                −
              </button>
              <span class="appearance-value" aria-live="polite">
                {letterSpacingLabel()}
              </span>
              <button onClick={() => settings.stepLetterSpacing(1)} aria-label="字间距增大" title="字间距增大">
                +
              </button>
            </div>
          </div>

          <label class="appearance-row">
            <span class="appearance-label">正文字体</span>
            <select
              value={settings.fontKey()}
              onChange={(e) => settings.setFontVariant(e.currentTarget.value as FontVariantId)}
              title="正文与 UI 字体"
            >
              {Object.values(FONT_VARIANTS).map((v) => (
                <option value={v.id}>{v.label}</option>
              ))}
            </select>
          </label>

          <label class="appearance-row">
            <span class="appearance-label">代码字体</span>
            <select
              value={settings.codeFontKey()}
              onChange={(e) => settings.setCodeFont(e.currentTarget.value as CodeFontId)}
              title="代码区字体（代码块 / 表格）"
            >
              {Object.values(CODE_FONTS).map((v) => (
                <option value={v.id}>{v.label}</option>
              ))}
            </select>
          </label>

          <div class="appearance-foot">
            <button class="appearance-reset" onClick={resetAll} title="五项都回到内置默认">
              恢复默认
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
