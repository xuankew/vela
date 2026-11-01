import { Show, onCleanup, onMount, createSignal } from 'solid-js'
import {
  CODE_FONTS,
  DEFAULT_CODE_FONT,
  DEFAULT_VARIANT,
  FONT_VARIANTS,
  type CodeFontId,
  type FontVariantId,
} from '../fonts/loader'
import { describeSecretError, deleteOssSecret, ossSecretStatus, setOssSecret } from '../ipc/secrets'
import { describeUploadError, TEST_UPLOAD_PNG, uploadImage } from '../ipc/oss'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LETTER_SPACING,
  DEFAULT_LINE_HEIGHT,
  fontSizeChoices,
  type OssConfig,
  type SettingsStore,
} from './store'
import { DEFAULT_THEME, THEME_IDS, THEME_LABELS, type ThemeId } from './theme'

export interface SettingsDialogProps {
  /** App 建一次、从不换引用的那份配置状态 */
  settings: SettingsStore
  visible: boolean
  onClose: () => void
  /** 打开快捷键配置对话框（M4-E） */
  onOpenKeybindings?: () => void
}

/** OSS 组里那四个文本框的形状（M7-6）。 */
const OSS_FIELDS: Array<{ key: keyof OssConfig; label: string; placeholder: string; hint?: string }> = [
  { key: 'bucket', label: 'Bucket', placeholder: 'vela-img' },
  {
    key: 'region',
    label: '地域',
    placeholder: 'cn-hangzhou',
    hint: '只写中间那一段：不带 `oss-` 前缀，也不带访问域名。',
  },
  { key: 'accessKeyId', label: 'AccessKey ID', placeholder: 'LTAI5t…' },
  { key: 'prefix', label: '对象前缀', placeholder: 'assets', hint: 'bucket 里的那一层目录；留空就放在根上。' },
]

/**
 * 「设置」对话框（M4-B 的外观 + M7-6 的阿里云 OSS）。
 *
 * ## 🔴 密钥那一行只写不读
 *
 * 这一整块里没有任何一处能拿到 `AccessKeySecret` 的值：状态那一个布尔来自
 * `ossSecretStatus()`，输入框的内容只流向 `set_oss_secret`，写完立刻清空。⛔ 不要
 * 「为了方便用户改」把它回显出来——那需要一条能读密钥的命令，而 webview 里任何一段脚本
 * 都能 `invoke`，预览一份别人发来的 Markdown 就足以注入一段。完整论证在
 * `src-tauri/src/secrets.rs` 的模块文档里。
 *
 * ## 四个文本框按失焦/回车提交，不按按键提交
 *
 * `~/.vela/settings.json` 的每一次写是「临时文件 + rename + fsync」。逐字符提交的话，
 * 填一只 bucket 名要三十次整档重写；按 `onBlur` 提交则一次改动一次写，
 * 而 store 的指纹还会把「焦点进出一趟」也跳过（`store.test.ts` 的
 * 「改成同一个值不重复写」钉的就是这一条）。
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const settings = props.settings
  let dialogEl: HTMLDivElement | undefined

  /**
   * 那四格的**草稿**。初值取盘上的值，且只在本组件挂载时取一次
   * （`App.tsx` 用 `<Show>` 包住，每开一次对话框是一个新实例，所以「打开时读最新值」
   * 与「不追踪信号变化」在这里是同一件事）。
   */
  const [draft, setDraft] = createSignal<OssConfig>(settings.oss())
  const [secretDraft, setSecretDraft] = createSignal('')
  const [secretBusy, setSecretBusy] = createSignal(false)
  /** 钥匙串里有没有那一项。初值 `false`，`onMount` 里异步查回来覆盖 */
  const [secretConfigured, setSecretConfigured] = createSignal(false)
  /** 密钥那一行的就地反馈（成功与失败都走这一句，红绿由 `secretFailed` 决定） */
  const [secretMsg, setSecretMsg] = createSignal<string | null>(null)
  const [secretFailed, setSecretFailed] = createSignal(false)
  const [uploading, setUploading] = createSignal(false)
  const [uploadMsg, setUploadMsg] = createSignal<string | null>(null)
  const [uploadFailed, setUploadFailed] = createSignal(false)

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

  /**
   * 只恢复**外观**六项，⛔ 不动那四格 OSS 配置。
   *
   * 偏好被清掉最坏是「字号回到 14px」，重设一次就好；bucket 被清掉是「粘贴的图静默改道
   * 回本地」，用户不会知道、也不会去那儿找。所以这一颗按钮的作用域写死在六个偏好上。
   */
  function resetAll(): void {
    settings.setTheme(DEFAULT_THEME)
    settings.setFontSize(DEFAULT_FONT_SIZE)
    settings.setFontVariant(DEFAULT_VARIANT)
    settings.setCodeFont(DEFAULT_CODE_FONT)
    settings.setLineHeight(DEFAULT_LINE_HEIGHT)
    settings.setLetterSpacing(DEFAULT_LETTER_SPACING)
  }

  /** 一格提交：草稿换成 trim 后的值，只有**真的变了**才写穿 */
  function commitOss(key: keyof OssConfig, raw: string): void {
    const trimmed = raw.trim()
    setDraft((d) => ({ ...d, [key]: trimmed }))
    if (trimmed !== settings.oss()[key]) settings.setOss({ [key]: trimmed })
  }

  async function refreshSecret(): Promise<void> {
    try {
      setSecretConfigured((await ossSecretStatus()).configured)
    } catch (err) {
      // 🔴 不把失败咽成「未配置」：「没存过」与「存了但读不出来」对用户是两句不同的话，
      // 后者说成前者，用户会一遍一遍重填同一个本来正确的密钥
      setSecretFailed(true)
      setSecretMsg(describeSecretError(err))
    }
  }

  async function saveSecret(): Promise<void> {
    const value = secretDraft()
    setSecretBusy(true)
    try {
      await setOssSecret(value)
      // 先清输入框再改状态：这一串只在这里存在过，任何一条路径都不该让它留下
      setSecretDraft('')
      setSecretConfigured(true)
      setSecretFailed(false)
      setSecretMsg('密钥已存进 macOS 钥匙串。')
    } catch (err) {
      // 失败时**不清**输入框：用户要能看见自己刚打了什么再改，而这句话与那串字节都在
      // 同一屏里，改一次试一次
      setSecretFailed(true)
      setSecretMsg(describeSecretError(err))
    } finally {
      setSecretBusy(false)
    }
  }

  async function clearSecret(): Promise<void> {
    try {
      await deleteOssSecret()
      setSecretConfigured(false)
      setSecretDraft('')
      setSecretFailed(false)
      // `delete_oss_secret` 幂等（本来没有也算成功），所以这里永远不该走红字那一条
      setSecretMsg('已从钥匙串清除。')
    } catch (err) {
      setSecretFailed(true)
      setSecretMsg(describeSecretError(err))
    }
  }

  async function runTestUpload(): Promise<void> {
    setUploading(true)
    setUploadMsg(null)
    try {
      const url = await uploadImage(TEST_UPLOAD_PNG)
      setUploadFailed(false)
      setUploadMsg(`传上去了：${url}`)
    } catch (err) {
      setUploadFailed(true)
      // 原样显示 Rust 翻好的那一句（`oss.rs` 的 `message_for` 按服务端错误码给确定的话，
      // 比这里再猜一次「是不是密钥错了」准）
      setUploadMsg(describeUploadError(err))
    } finally {
      setUploading(false)
    }
  }

  // 只在可见时挂上外部点击监听
  if (props.visible) {
    setupOutsideClick()
  }

  onMount(() => {
    void refreshSecret()
  })

  return (
    <div class="modal-backdrop" role="presentation">
      <div class="settings-dialog" ref={dialogEl} role="dialog" aria-label="设置" onKeyDown={onKeyDown}>
        <div class="settings-header">
          <h2>设置</h2>
          <button class="settings-close" onClick={close} title="关闭" aria-label="关闭">
            ×
          </button>
        </div>

        <div class="settings-body">
          <section class="settings-group">
            <h3 class="settings-group-title">外观</h3>

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
                {fontSizeChoices(settings.fontSize()).map((s) => (
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
          </section>

          <section class="settings-group">
            <h3 class="settings-group-title">阿里云 OSS</h3>
            <p class="settings-group-hint">
              四格加上钥匙串里的密钥都配好，粘贴的图片就传到 bucket、正文写公网地址； 缺任何一项就存到文档旁边的
              `assets/`。
            </p>

            {OSS_FIELDS.map((field) => (
              <div class="settings-field">
                <label class="settings-row">
                  <span class="settings-label">{field.label}</span>
                  <input
                    class="settings-input"
                    type="text"
                    spellcheck={false}
                    placeholder={field.placeholder}
                    value={draft()[field.key]}
                    onInput={(e) => {
                      setDraft((d) => ({ ...d, [field.key]: e.currentTarget.value }))
                      // 一边改一边把上一句失败清掉：留着它，用户会以为改完还是不行
                      if (uploadMsg() !== null) setUploadMsg(null)
                    }}
                    onBlur={(e) => commitOss(field.key, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitOss(field.key, e.currentTarget.value)
                      }
                    }}
                  />
                </label>
                <Show when={field.hint}>
                  <p class="settings-hint">{field.hint}</p>
                </Show>
              </div>
            ))}

            <div class="settings-field">
              <label class="settings-row">
                <span class="settings-label">
                  AccessKey Secret
                  <Show when={secretConfigured()}>
                    <span class="settings-badge">已配置</span>
                  </Show>
                </span>
                <input
                  class="settings-input"
                  type="password"
                  spellcheck={false}
                  autocomplete="off"
                  placeholder="填完按回车，或点旁边的「保存密钥」"
                  value={secretDraft()}
                  onInput={(e) => setSecretDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      if (!secretBusy()) void saveSecret()
                    }
                  }}
                />
              </label>
              <div class="settings-inline">
                <button
                  class="settings-action"
                  onClick={() => void saveSecret()}
                  disabled={secretBusy() || secretDraft().trim() === ''}
                >
                  {secretBusy() ? '保存中…' : '保存密钥'}
                </button>
                <Show when={secretConfigured()}>
                  {/* 清除是反向操作，权重要低于「保存密钥」：同 styles.css 的 .settings-action-quiet */}
                  <button class="settings-action settings-action-quiet" onClick={() => void clearSecret()}>
                    清除
                  </button>
                </Show>
              </div>
              <Show when={secretMsg() !== null}>
                <p class={secretFailed() ? 'settings-result settings-result-bad' : 'settings-result'} role="status">
                  {secretMsg()}
                </p>
              </Show>
            </div>

            <div class="settings-field">
              <button class="settings-action" onClick={() => void runTestUpload()} disabled={uploading()}>
                {uploading() ? '正在上传…' : '测试上传'}
              </button>
              <Show when={uploadMsg() !== null}>
                <p class={uploadFailed() ? 'settings-result settings-result-bad' : 'settings-result'} role="status">
                  {uploadMsg()}
                </p>
              </Show>
            </div>
          </section>
        </div>

        <div class="settings-footer">
          <button class="settings-reset" onClick={resetAll} title="外观那六项回到内置默认（不动 OSS 配置）">
            恢复默认
          </button>
          {props.onOpenKeybindings && (
            <button class="settings-keybindings-btn" onClick={props.onOpenKeybindings} title="配置快捷键">
              快捷键配置
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
