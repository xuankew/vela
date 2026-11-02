// @vitest-environment jsdom
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「设置」对话框里 **OSS 那一组**的组件测试（M7-6）。
 *
 * 外观那六项的接线由 `App.test.tsx` 与 `AppearancePopover.test.tsx` 管，四格的
 * 「读回来 → 写出去时原样带上」由 `store.test.ts` 管。这里只测面板这一层新添的四件事：
 *
 * 1. **提交时机**：失焦/回车写穿，打字不写（一次原子写带一次 fsync）；
 * 2. 🔴 **密钥只写不读**：初值来自 `oss_secret_status` 那一个布尔，任何用例里都
 *    不该出现「把密钥值填回输入框」这件事；
 * 3. **反馈就地显示且不吞**：密钥与上传的失败都显示 Rust 那句原文，不咽成「未配置」；
 * 4. **「恢复默认」的作用域只有外观六项**——它清掉 bucket 的话，用户不会知道，
 *    而后果是「粘贴的图静默改道回本地」。
 *
 * ⚠️ 用**真的** store 与**真的** `../ipc/secrets` / `../ipc/oss`，只 mock `invoke`：
 * 这一层要验的正是「DOM 事件 → 哪一条命令、什么参数形状」，而参数形状（
 * 只有 `dataBase64`、`{ secret }`）就是安全边界本身。用假模块就等于把要验的东西 mock 掉了。
 */

const { invoke, settingsIpc, fontLoader } = vi.hoisted(() => ({
  invoke: vi.fn(),
  settingsIpc: { loadSettings: vi.fn(), saveSettings: vi.fn() },
  fontLoader: { applyFontVariant: vi.fn(), applyCodeFont: vi.fn() },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

vi.mock('../ipc/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/settings')>()),
  loadSettings: settingsIpc.loadSettings,
  saveSettings: settingsIpc.saveSettings,
}))

vi.mock('../fonts/loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fonts/loader')>()),
  applyFontVariant: fontLoader.applyFontVariant,
  applyCodeFont: fontLoader.applyCodeFont,
}))

import { TEST_UPLOAD_PNG, type UploadError } from '../ipc/oss'
import type { SecretError } from '../ipc/secrets'
import { bytesToBase64 } from '../util/base64'
import { createSettingsStore, type SettingsStore } from './store'
import { SettingsDialog } from './SettingsDialog'

/** 写队列与 `onMount` 里那两个异步查询都要靠它落地 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 用 serde 出来的那个**对象**拒绝，而不是包一层 `Error`。
 *
 * ⚠️ 与 `src/goto/store.test.ts` 同一条做法：Tauri 的 `invoke`  reject 的就是命令返回的
 * 错误值本身，它不是 `Error`。而 `describeSecretError` / `describeUploadError` 靠
 * `kind` 分支，所以这里必须还原那个形状，否则测的是「Error 兜底路径」而不是分支逻辑。
 */
function rejectWith(payload: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 见上
  return Promise.reject(payload)
}

let store: SettingsStore
let dispose: () => void
let container: HTMLDivElement
const closeCalls: number[] = []

/**
 * 装一条 `invoke`：密钥默认「没配」，上传默认成功、保存密钥默认成功。
 * 单条用例要改哪一条，就在用例里再 `invoke.mockImplementation` 覆盖。
 */
function wireInvoke(options: { configured?: boolean; upload?: string; secret?: SecretError } = {}): void {
  invoke.mockImplementation((command: string) => {
    if (command === 'oss_secret_status') return Promise.resolve({ configured: options.configured ?? false })
    if (command === 'upload_image') return Promise.resolve(options.upload ?? 'https://b.oss.aliyuncs.com/p.png')
    if (command === 'set_oss_secret' && options.secret) return rejectWith(options.secret)
    return Promise.resolve(undefined)
  })
}

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  dispose = render(() => <SettingsDialog settings={store} visible onClose={() => closeCalls.push(1)} />, container)
}

const dialog = (): HTMLElement => container.querySelector<HTMLElement>('.settings-dialog')!
/** 换了 `invoke` 装好后重开一次对话框：`onMount` 里那次状态查询要重跑 */
async function reopen(): Promise<void> {
  dispose()
  mount()
  await flush()
}
const groupTitles = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('.settings-group-title')].map((el) => el.textContent)
const group = (title: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('.settings-group')].find((g) =>
    g.querySelector('.settings-group-title')?.textContent?.includes(title),
  )!
/** 按标签找那一行的 input/值：`AccessKey Secret` 那一个标签后面还会挂 badge，所以用前缀匹配 */
function fieldInput(label: string): HTMLInputElement {
  const rows = [...group('阿里云 OSS').querySelectorAll<HTMLElement>('.settings-row')]
  const row = rows.find((r) => r.querySelector('.settings-label')?.textContent?.startsWith(label))
  return row!.querySelector<HTMLInputElement>('input')!
}
const resultText = (label: string): string | null => {
  const el = fieldInput(label).closest('.settings-field')?.querySelector('.settings-result')
  return el ? (el.textContent ?? null) : null
}
/** 「测试上传」那一行是 OSS 组里最后一个 field，它的结果行只有这一处 */
const uploadResult = (): string | null =>
  group('阿里云 OSS').querySelector('.settings-field:last-child .settings-result')?.textContent ?? null
const uploadButton = (): HTMLButtonElement =>
  [...group('阿里云 OSS').querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    /测试上传|正在上传/.test(b.textContent),
  )!

function type(el: HTMLInputElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function blur(el: HTMLInputElement): void {
  el.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
}
function press(el: HTMLElement, key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return e
}
function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
/** 第 n 次 `save_settings` 收出去的那份 payload */
const savedPayload = (n = 0): Record<string, unknown> => settingsIpc.saveSettings.mock.calls[n]![0] as never

beforeEach(async () => {
  invoke.mockReset()
  settingsIpc.loadSettings.mockReset()
  settingsIpc.saveSettings.mockReset()
  settingsIpc.saveSettings.mockResolvedValue({ bytesWritten: 80 })
  fontLoader.applyFontVariant.mockReset()
  fontLoader.applyCodeFont.mockReset()
  fontLoader.applyFontVariant.mockResolvedValue({})
  fontLoader.applyCodeFont.mockResolvedValue({})
  closeCalls.length = 0
  wireInvoke()
  settingsIpc.loadSettings.mockResolvedValue({
    settings: {
      fontSize: 14,
      fontVariant: 'screen-gb',
      codeFont: 'maple-cn',
      lineHeight: 1.75,
      letterSpacing: 0,
      theme: 'dark',
      ossBucket: 'vela-img',
      ossRegion: 'cn-hangzhou',
      ossAccessKeyId: 'LTAI5tExampleId',
      ossPrefix: 'docs',
      markdownToolbar: true,
    },
    report: { userLayer: { status: 'present' }, projectLayer: { status: 'absent' }, ignoredProjectKeys: [] },
  })
  store = createSettingsStore()
  await store.load([])
  mount()
})

afterEach(() => {
  dispose()
  container.remove()
})

describe('标题与分组（M7-6 的改名）', () => {
  it('🔴 modal 叫「设置」，`h2` 与 `aria-label` 一起跟上', () => {
    expect(dialog().querySelector('h2')?.textContent).toBe('设置')
    expect(dialog().getAttribute('aria-label')).toBe('设置')
  })

  it('两组小标题：外观在前、阿里云 OSS 在后', () => {
    expect(groupTitles()).toEqual(['外观', '阿里云 OSS'])
  })

  it('外观那六项还在「外观」组里，OSS 的四格在另一组', () => {
    expect(group('外观').querySelectorAll('select')).toHaveLength(4)
    expect(group('阿里云 OSS').querySelectorAll('input[type="text"]')).toHaveLength(4)
  })
})

describe('四格文本框：读回来、失焦写出去', () => {
  it('四个框的初值就是盘上那四格（按 bucket / 地域 / AccessKey ID / 对象前缀 的顺序）', () => {
    expect(fieldInput('Bucket').value).toBe('vela-img')
    expect(fieldInput('地域').value).toBe('cn-hangzhou')
    expect(fieldInput('AccessKey ID').value).toBe('LTAI5tExampleId')
    expect(fieldInput('对象前缀').value).toBe('docs')
  })

  it('🔴 打字不写盘：只有失焦那一下提交一次', async () => {
    const bucket = fieldInput('Bucket')
    type(bucket, 'v')
    type(bucket, 've')
    type(bucket, 'vela')
    await flush()
    expect(settingsIpc.saveSettings).not.toHaveBeenCalled()
    blur(bucket)
    await flush()
    expect(settingsIpc.saveSettings).toHaveBeenCalledTimes(1)
    expect(savedPayload(0)).toMatchObject({ ossBucket: 'vela' })
  })

  it('回车等价于失焦', async () => {
    const bucket = fieldInput('Bucket')
    type(bucket, 'new-img')
    press(bucket, 'Enter')
    await flush()
    expect(savedPayload(0)).toMatchObject({ ossBucket: 'new-img' })
  })

  it('焦点进出一趟但值没变时不写（store 的指纹跳过）', async () => {
    const bucket = fieldInput('Bucket')
    blur(bucket)
    await flush()
    expect(settingsIpc.saveSettings).not.toHaveBeenCalled()
  })

  it('两端空白在提交时被去掉，而且框里显示的就是存进去的那一份', async () => {
    const bucket = fieldInput('Bucket')
    type(bucket, '  vela-img 2  ')
    blur(bucket)
    await flush()
    expect(store.oss().bucket).toBe('vela-img 2')
    expect(bucket.value).toBe('vela-img 2')
    expect(savedPayload(0)).toMatchObject({ ossBucket: 'vela-img 2' })
  })

  it('改一格的 payload 里其余三格原样带着：一次写穿不能抹掉别的格', async () => {
    type(fieldInput('地域'), 'cn-shanghai')
    blur(fieldInput('地域'))
    await flush()
    expect(savedPayload(0)).toMatchObject({
      ossBucket: 'vela-img',
      ossRegion: 'cn-shanghai',
      ossAccessKeyId: 'LTAI5tExampleId',
      ossPrefix: 'docs',
    })
  })

  it('🔴 「恢复默认」只打回外观六项，一格 OSS 配置都不动', async () => {
    click(container.querySelector<HTMLButtonElement>('.settings-reset')!)
    await flush()
    expect(savedPayload(0)).toMatchObject({
      fontSize: 14,
      theme: 'dark',
      ossBucket: 'vela-img',
      ossRegion: 'cn-hangzhou',
      ossAccessKeyId: 'LTAI5tExampleId',
      ossPrefix: 'docs',
    })
  })
})

describe('密钥那一行：只写不进读', () => {
  it('打开时查一次状态；没配过就不出现「已配置」与「清除」', async () => {
    await flush()
    expect(invoke.mock.calls.filter((c) => c[0] === 'oss_secret_status')).toHaveLength(1)
    expect(group('阿里云 OSS').textContent).not.toContain('已配置')
  })

  it('配过之后标签后面挂一个「已配置」，并多出「清除」那一个反向按钮', async () => {
    wireInvoke({ configured: true })
    await reopen()
    expect(group('阿里云 OSS').textContent).toContain('已配置')
    const quiet = [...group('阿里云 OSS').querySelectorAll<HTMLButtonElement>('.settings-action-quiet')]
    expect(quiet.map((b) => b.textContent)).toEqual(['清除'])
  })

  it('🔴 保存密钥：原样（不 trim）交给 `set_oss_secret`，成功后清空输入框', async () => {
    const secret = fieldInput('AccessKey Secret')
    type(secret, '  SECRET-VALUE  ')
    expect(secret.disabled).toBe(false)
    click(
      [...group('阿里云 OSS').querySelectorAll<HTMLButtonElement>('.settings-action')].find((b) =>
        b.textContent?.startsWith('保存密钥'),
      )!,
    )
    await flush()
    // trim 的口径只有一份，在 Rust（`secrets.rs` 的 `clean`）；前端先 trim 一次就会出现
    // 「面板以为存的是 A、钥匙串里其实是 B」
    expect(invoke).toHaveBeenCalledWith('set_oss_secret', { secret: '  SECRET-VALUE  ' })
    expect(secret.value).toBe('')
    expect(resultText('AccessKey Secret')).toContain('钥匙串')
  })

  it('空的或全空白的密钥按下去没有反应，也不发出命令', () => {
    const save = [...group('阿里云 OSS').querySelectorAll<HTMLButtonElement>('.settings-action')].find((b) =>
      b.textContent?.startsWith('保存密钥'),
    )!
    expect(save.disabled).toBe(true)
    click(save)
    expect(invoke.mock.calls.some((c) => c[0] === 'set_oss_secret')).toBe(false)
  })

  it('保存失败：把 Rust 那句原文显示出来，输入框**不**清空', async () => {
    wireInvoke({ secret: { kind: 'keychain', code: -25293, message: 'PROBE-KEYCHAIN' } as SecretError })
    const secret = fieldInput('AccessKey Secret')
    type(secret, 'ABC123')
    click(
      [...group('阿里云 OSS').querySelectorAll<HTMLButtonElement>('.settings-action')].find((b) =>
        b.textContent?.startsWith('保存密钥'),
      )!,
    )
    await flush()
    expect(resultText('AccessKey Secret')).toContain('PROBE-KEYCHAIN')
    expect(secret.value).toBe('ABC123')
  })

  it('🔴 状态查询失败不咽成「未配置」：那句话要显示出来', async () => {
    wireInvoke()
    invoke.mockImplementation((command: string) =>
      command === 'oss_secret_status'
        ? rejectWith({ kind: 'unsupported', message: 'PROBE-NO-KEYCHAIN' } satisfies SecretError)
        : Promise.resolve(undefined),
    )
    await reopen()
    expect(resultText('AccessKey Secret')).toContain('PROBE-NO-KEYCHAIN')
  })

  it('清除成功后 badge 消失、并说一句「已清除」（命令幂等，所以没有红字那条路）', async () => {
    wireInvoke({ configured: true })
    await reopen()
    click([...group('阿里云 OSS').querySelectorAll<HTMLButtonElement>('.settings-action-quiet')][0]!)
    await flush()
    expect(invoke).toHaveBeenCalledWith('delete_oss_secret')
    expect(group('阿里云 OSS').textContent).not.toContain('已配置')
    expect(resultText('AccessKey Secret')).toContain('清除')
  })
})

describe('测试上传', () => {
  it('🔴 只把字节交出去：命令的参数仍然只有 `dataBase64` 一个键', async () => {
    click(uploadButton())
    await flush()
    const call = invoke.mock.calls.find((c) => c[0] === 'upload_image')!
    expect(Object.keys(call[1] as object)).toEqual(['dataBase64'])
    expect(store.oss()).toMatchObject({ bucket: 'vela-img' })
  })

  it('把那张 1×1 的探测图传上去，成功时把 URL 就地显示出来', async () => {
    wireInvoke({ upload: 'https://b.oss-cn-hangzhou.aliyuncs.com/assets/pasted-abc.png' })
    await reopen()
    click(uploadButton())
    await flush()
    const call = invoke.mock.calls.find((c) => c[0] === 'upload_image')!
    expect(call[1] as { dataBase64: string }).toEqual({ dataBase64: bytesToBase64(TEST_UPLOAD_PNG) })
    expect(uploadResult()).toContain('pasted-abc.png')
  })

  it('失败：显示 Rust 翻好的那一句，而不是「上传失败，请重试」', async () => {
    const rejected: UploadError = {
      kind: 'rejected',
      status: 403,
      code: 'SignatureDoesNotMatch',
      message: 'PROBE-SIGN-FAIL',
      request_id: null,
    }
    invoke.mockImplementation((command: string) => {
      if (command === 'upload_image') return rejectWith(rejected)
      if (command === 'oss_secret_status') return Promise.resolve({ configured: true })
      return Promise.resolve(undefined)
    })
    await reopen()
    click(uploadButton())
    await flush()
    const line = group('阿里云 OSS').querySelector('.settings-result-bad')
    expect(line?.textContent).toContain('PROBE-SIGN-FAIL')
  })

  it('上传中按钮禁用、文案换成「正在上传…」，回来就恢复', async () => {
    let resolveUpload!: (url: string) => void
    invoke.mockImplementation((command: string) =>
      command === 'upload_image'
        ? new Promise<string>((res) => void (resolveUpload = res))
        : command === 'oss_secret_status'
          ? Promise.resolve({ configured: true })
          : Promise.resolve(undefined),
    )
    await reopen()
    const button = uploadButton()
    click(button)
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('正在上传')
    resolveUpload('https://b.oss-cn-hangzhou.aliyuncs.com/assets/pasted-abc.png')
    await flush()
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('测试上传')
  })

  it('改一格就把上一条失败文案清掉：留着会让人以为改完还是不行', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'upload_image'
        ? rejectWith({ kind: 'not_configured', reason: 'PROBE-NOT-CONFIG' } satisfies UploadError)
        : Promise.resolve({ configured: true }),
    )
    await reopen()
    click(uploadButton())
    await flush()
    expect(group('阿里云 OSS').textContent).toContain('PROBE-NOT-CONFIG')
    type(fieldInput('Bucket'), 'another')
    expect(group('阿里云 OSS').textContent).not.toContain('PROBE-NOT-CONFIG')
  })
})

describe('关闭', () => {
  it('Esc 关掉对话框并 preventDefault', () => {
    const e = press(dialog(), 'Escape')
    expect(e.defaultPrevented).toBe(true)
    expect(closeCalls).toEqual([1])
  })
})
