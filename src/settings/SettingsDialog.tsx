import { onCleanup } from 'solid-js'
import {
  CODE_FONTS,
  DEFAULT_CODE_FONT,
  DEFAULT_VARIANT,
  FONT_VARIANTS,
  type CodeFontId,
  type FontVariantId,
} from '../fonts/loader'
import { DEFAULT_FONT_SIZE, DEFAULT_LETTER_SPACING, DEFAULT_LINE_HEIGHT, FONT_SIZES, type SettingsStore } from './store'
import { DEFAULT_THEME, THEME_IDS, THEME_LABELS, type ThemeId } from './theme'

/**
 * 设置对话框（M4-B，菜单触发入口）。
 *
 * 与 `AppearancePopover` 共用同一套配置逻辑，但呈现为居中模态对话框而不是锚定下拉。
 * 工具栏隐藏后，这是访问主题 / 字号 / 行高 / 字间距 / 字体的主要入口。
 *
 * ## 键盘
 *
 * - `Escape` 关闭对话框
 * - 点遮罩层外面也关闭
 */

export interface SettingsDialogProps {
  /** App 建一次、从不换引用的那份配置状态 */
  settings: SettingsStore
  visible: boolean
  onClose: () => void
}

export function SettingsDialog(props: SettingsDialogProps) {
  const settings = props.settings
  let dialogEl: HTMLDivElement | undefined

  function close(): void {
    props.onClose()
  }

  /**
   * 点遮罩层外面就关。挂在 `document` 的 pointerdown 上，
   * 用 `dialogEl.contains` 判断，对话框自己里的点击不算「外面」。
   */
  function setupOutsideClick() {
    if (!props.visible) return
    const onDocDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (dialogEl && target && !dialogEl.contains(target)) close()
    }
    // 延迟一帧再挂：打开那一下的 pointerdown 就是点按钮本身
    const id = window.setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0)
    onCleanup(() => {
      window.clearTimeout(id)
      document.removeEventListener('pointerdown', onDocDown)
    })
  }

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
    settings.setTheme(DEFAULT_THEME)
    settings.setFontSize(DEFAULT_FONT_SIZE)
    settings.setFontVariant(DEFAULT_VARIANT)
    settings.setCodeFont(DEFAULT_CODE_FONT)
    settings.setLineHeight(DEFAULT_LINE_HEIGHT)
    settings.setLetterSpacing(DEFAULT_LETTER_SPACING)
  }

  // 只在可见时挂上外部点击监听
  if (props.visible) {
    setupOutsideClick()
  }

  return (
    <div class="modal-backdrop" role="presentation">
      <div
        class="settings-dialog"
        ref={dialogEl}
        role="dialog"
        aria-label="外观设置"
        onKeyDown={onKeyDown}
      >
        <div class="settings-header">
          <h2>外观设置</h2>
          <button class="settings-close" onClick={close} title="关闭" aria-label="关闭">
            ×
          </button>
        </div>

        <div class="settings-body">
          <label class="settings-row">
            <span class="settings-label">主题</span>
            <select
              value={settings.theme()}
              onChange={(e) => settings.setTheme(e.currentTarget.value as ThemeId)}
              title="亮色 / 暗色 / 跟随系统"
            >
              {THEME_IDS.map((id) => (
                <option value={id}>{THEME_LABELS[id]}</option>
              ))}
            </select>
          </label>

          <label class="settings-row">
            <span class="settings-label">字号</span>
            <select
              onChange={(e) => settings.setFontSize(Number(e.currentTarget.value))}
              title="字号（也可用 Cmd/Ctrl + = / - / 0）"
            >
              {FONT_SIZES.map((s) => (
                <option value={String(s)} selected={s === settings.fontSize()}>
                  {s}px
                </option>
              ))}
            </select>
          </label>

          <div class="settings-row">
            <span class="settings-label">行高</span>
            <div class="settings-stepper">
              <button onClick={() => settings.stepLineHeight(-1)} aria-label="行高减小" title="行高减小">
                −
              </button>
              <span class="settings-value" aria-live="polite">
                {settings.lineHeight()}
              </span>
              <button onClick={() => settings.stepLineHeight(1)} aria-label="行高增大" title="行高增大">
                +
              </button>
            </div>
          </div>

          <div class="settings-row">
            <span class="settings-label">字间距</span>
            <div class="settings-stepper">
              <button onClick={() => settings.stepLetterSpacing(-1)} aria-label="字间距减小" title="字间距减小">
                −
              </button>
              <span class="settings-value" aria-live="polite">
                {letterSpacingLabel()}
              </span>
              <button onClick={() => settings.stepLetterSpacing(1)} aria-label="字间距增大" title="字间距增大">
                +
              </button>
            </div>
          </div>

          <label class="settings-row">
            <span class="settings-label">正文字体</span>
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

          <label class="settings-row">
            <span class="settings-label">代码字体</span>
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
        </div>

        <div class="settings-footer">
          <button class="settings-reset" onClick={resetAll} title="六项都回到内置默认">
            恢复默认
          </button>
        </div>
      </div>
    </div>
  )
}
