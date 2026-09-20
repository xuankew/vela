// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `src/settings/store.ts` 的单测：sanitize、写穿队列、load 的代号守卫、以及首屏应用。
 *
 * **只有 IPC 与字体注入是假的**：`../ipc/settings` 的 `loadSettings` / `saveSettings`
 * 换成 `vi.fn`（jsdom 里没有 Tauri 运行时），`../fonts/loader` 的 `applyFontVariant` /
 * `applyCodeFont` 换成 `vi.fn`（不去真的动态 import 一份 webfont CSS）。
 * ⚠️ 两个 mock 都用 `importOriginal` 摊开真模块、只盖掉那几个函数：字体注册表
 * （`FONT_VARIANTS` / `CODE_FONTS`）与默认 ID（`DEFAULT_VARIANT` / `DEFAULT_CODE_FONT`）
 * 必须是**真的**——sanitize 正是拿它们当合法值清单，换成假对象这一层就没东西可验了。
 */

// `vi.hoisted` 是必需的：`vi.mock` 会被提到文件最上面，mock 工厂在被 mock 模块首次
// import 时就执行——那时普通 `const` 还处在 TDZ 里。
const { settingsIpc, fontLoader } = vi.hoisted(() => ({
  settingsIpc: { loadSettings: vi.fn(), saveSettings: vi.fn() },
  fontLoader: { applyFontVariant: vi.fn(), applyCodeFont: vi.fn() },
}))

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

import { DEFAULT_CODE_FONT, DEFAULT_VARIANT } from '../fonts/loader'
import type { LoadedSettings, Settings, SettingsReport } from '../ipc/settings'
import { createSettingsStore, DEFAULT_FONT_SIZE, FONT_SIZES, type SettingsStore } from './store'

/** 写队列是微任务链，`setTimeout(0)` 把它冲干净（与 sessionSync.test.ts 同一条做法，不用假表） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function loaded(settings: Partial<Settings> = {}, report: Partial<SettingsReport> = {}): LoadedSettings {
  return {
    settings: { fontSize: 14, fontVariant: 'screen-gb', codeFont: 'maple-cn', ...settings },
    report: {
      userLayer: { status: 'present' },
      projectLayer: { status: 'absent' },
      ignoredProjectKeys: [],
      ...report,
    },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const cssFontSize = (): string => document.documentElement.style.getPropertyValue('--vela-font-size')

let store: SettingsStore
const warnings: string[] = []

beforeEach(() => {
  settingsIpc.loadSettings.mockReset()
  settingsIpc.saveSettings.mockReset()
  settingsIpc.saveSettings.mockResolvedValue({ bytesWritten: 80 })
  fontLoader.applyFontVariant.mockReset()
  fontLoader.applyCodeFont.mockReset()
  fontLoader.applyFontVariant.mockResolvedValue({})
  fontLoader.applyCodeFont.mockResolvedValue({})
  document.documentElement.style.removeProperty('--vela-font-size')
  warnings.length = 0
  store = createSettingsStore({ onWarn: (text) => warnings.push(text) })
})

describe('初始状态', () => {
  it('三个信号都停在内置默认，report 是 null', () => {
    expect(store.fontKey()).toBe(DEFAULT_VARIANT)
    expect(store.codeFontKey()).toBe(DEFAULT_CODE_FONT)
    expect(store.fontSize()).toBe(DEFAULT_FONT_SIZE)
    expect(store.report()).toBeNull()
  })

  it('内置默认字号与字体注册表的默认 ID 就是契约里那三个值', () => {
    // 🔴 这一条把 store 的默认与 Rust 的 `Settings::default()` tying 在一起：
    // Rust 侧 `内置默认配置被钉住` 断言 14 / "screen-gb" / "maple-cn"，
    // `ipc/settings.test.ts` 的黄金字面量也是这三个值。漂了任一边，这几条一起红。
    expect(DEFAULT_FONT_SIZE).toBe(14)
    expect(DEFAULT_VARIANT).toBe('screen-gb')
    expect(DEFAULT_CODE_FONT).toBe('maple-cn')
    // 默认字号必须是合法档位，否则首屏 select 会是空白
    expect(FONT_SIZES).toContain(DEFAULT_FONT_SIZE)
  })
})

describe('applyNow（首屏）', () => {
  it('把当前信号值写进 CSS 变量并注入两个 family，不碰 IPC', () => {
    store.applyNow()
    expect(cssFontSize()).toBe('14px')
    expect(fontLoader.applyFontVariant).toHaveBeenCalledWith('screen-gb')
    expect(fontLoader.applyCodeFont).toHaveBeenCalledWith('maple-cn')
    // 首屏应用是纯 DOM 副作用，不该读也不该写配置
    expect(settingsIpc.loadSettings).not.toHaveBeenCalled()
    expect(settingsIpc.saveSettings).not.toHaveBeenCalled()
  })
})

describe('load：装回持久化的配置', () => {
  it('把读回来的三个值灌进信号、应用到 DOM，并记下账单', async () => {
    settingsIpc.loadSettings.mockResolvedValue(
      loaded({ fontSize: 18, fontVariant: 'screen-r', codeFont: 'inherit' }, { ignoredProjectKeys: ['fontSize'] }),
    )
    await store.load(['/repo'])

    expect(store.fontSize()).toBe(18)
    expect(store.fontKey()).toBe('screen-r')
    expect(store.codeFontKey()).toBe('inherit')
    expect(cssFontSize()).toBe('18px')
    expect(fontLoader.applyFontVariant).toHaveBeenCalledWith('screen-r')
    expect(fontLoader.applyCodeFont).toHaveBeenCalledWith('inherit')
    // 账单原样暴露：项目层试图改 fontSize 被忽略这件事，App 要能读到
    expect(store.report()?.ignoredProjectKeys).toEqual(['fontSize'])
    // roots 原样递上去（多根时 Rust 只取第一个，但前端递整个清单）
    expect(settingsIpc.loadSettings).toHaveBeenCalledWith(['/repo'])
  })

  it('🔴 load 不写穿：装回盘上的值不是用户改动', async () => {
    settingsIpc.loadSettings.mockResolvedValue(loaded({ fontSize: 16 }))
    await store.load([])
    await flush()
    expect(settingsIpc.saveSettings).not.toHaveBeenCalled()
  })

  it('不认识的字体 ID 打回注册表默认', async () => {
    settingsIpc.loadSettings.mockResolvedValue(loaded({ fontVariant: '不存在的字体', codeFont: 'nope' }))
    await store.load([])
    expect(store.fontKey()).toBe(DEFAULT_VARIANT)
    expect(store.codeFontKey()).toBe(DEFAULT_CODE_FONT)
  })

  it('原型链上的键名不被当成合法 ID（hasOwnProperty 而不是 in）', async () => {
    // 配置文件是不可信输入：`"toString"` 用 `in` 会命中 Object.prototype，
    // 于是被当成一个合法字体 ID 灌进信号，select 变空白而没有任何报错
    settingsIpc.loadSettings.mockResolvedValue(loaded({ fontVariant: 'toString', codeFont: 'constructor' }))
    await store.load([])
    expect(store.fontKey()).toBe(DEFAULT_VARIANT)
    expect(store.codeFontKey()).toBe(DEFAULT_CODE_FONT)
  })

  it('档外字号打回默认档位', async () => {
    settingsIpc.loadSettings.mockResolvedValue(loaded({ fontSize: 17 }))
    await store.load([])
    // 17 不在 FONT_SIZES 里：夹回默认，否则工具栏的 select 会显示空白
    expect(store.fontSize()).toBe(DEFAULT_FONT_SIZE)
    expect(cssFontSize()).toBe(`${DEFAULT_FONT_SIZE}px`)
  })

  it('NaN / 负数 / 小数字号都打回默认', async () => {
    for (const bad of [Number.NaN, -4, 13.5, 0]) {
      settingsIpc.loadSettings.mockResolvedValue(loaded({ fontSize: bad }))
      await store.load([])
      expect(store.fontSize(), `fontSize=${bad}`).toBe(DEFAULT_FONT_SIZE)
    }
  })

  it('load 拒了（算不出主目录）时说一句话并保持当前值', async () => {
    // 先装一份合法配置，再让第二次 load 拒掉：拒掉不该把已有值冲成默认
    settingsIpc.loadSettings.mockResolvedValueOnce(loaded({ fontSize: 20 }))
    await store.load([])
    expect(store.fontSize()).toBe(20)

    settingsIpc.loadSettings.mockRejectedValueOnce({ kind: 'io', reason: 'HomeDir', message: '拿不到用户主目录' })
    await store.load(['/repo'])
    await flush()

    expect(store.fontSize()).toBe(20)
    expect(warnings).toEqual(['拿不到用户主目录'])
  })

  it('迟到的旧 load 不盖掉新 load（代号守卫）', async () => {
    const a = deferred<LoadedSettings>()
    const b = deferred<LoadedSettings>()
    settingsIpc.loadSettings.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)

    const p1 = store.load(['/root-a']) // 代号 1
    const p2 = store.load(['/root-b']) // 代号 2

    // 新的（代号 2）先回来：生效
    b.resolve(loaded({ fontSize: 20 }))
    await p2
    expect(store.fontSize()).toBe(20)

    // 旧的（代号 1）后回来：代号对不上，整个丢弃，不许把 20 盖成 12
    a.resolve(loaded({ fontSize: 12 }))
    await p1
    expect(store.fontSize()).toBe(20)
  })
})

describe('用户改动：更新 + 应用 + 写穿', () => {
  it('setFontVariant 改信号、注入、并把完整配置存出去', async () => {
    store.setFontVariant('screen-r')
    expect(store.fontKey()).toBe('screen-r')
    expect(fontLoader.applyFontVariant).toHaveBeenCalledWith('screen-r')
    await flush()
    expect(settingsIpc.saveSettings).toHaveBeenCalledTimes(1)
    expect(settingsIpc.saveSettings.mock.calls[0]![0]).toEqual({
      fontSize: 14,
      fontVariant: 'screen-r',
      codeFont: 'maple-cn',
    })
  })

  it('setCodeFont 改信号、注入、写穿', async () => {
    store.setCodeFont('inherit')
    expect(store.codeFontKey()).toBe('inherit')
    expect(fontLoader.applyCodeFont).toHaveBeenCalledWith('inherit')
    await flush()
    expect(settingsIpc.saveSettings.mock.calls[0]![0]).toEqual({
      fontSize: 14,
      fontVariant: 'screen-gb',
      codeFont: 'inherit',
    })
  })

  it('setFontSize 夹到档位、写 CSS 变量、写穿', async () => {
    store.setFontSize(16)
    expect(store.fontSize()).toBe(16)
    expect(cssFontSize()).toBe('16px')
    await flush()
    expect(settingsIpc.saveSettings.mock.calls[0]![0]).toEqual({
      fontSize: 16,
      fontVariant: 'screen-gb',
      codeFont: 'maple-cn',
    })
  })

  it('setFontSize 把档外值夹回默认再存', async () => {
    store.setFontSize(17)
    expect(store.fontSize()).toBe(DEFAULT_FONT_SIZE)
    await flush()
    expect(settingsIpc.saveSettings.mock.calls[0]![0]).toMatchObject({ fontSize: DEFAULT_FONT_SIZE })
  })

  it('stepFontSize 在档位之间走，到两端就停住', () => {
    expect(store.fontSize()).toBe(14)
    store.stepFontSize(1)
    expect(store.fontSize()).toBe(15)
    store.stepFontSize(1)
    expect(store.fontSize()).toBe(16)
    store.stepFontSize(-1)
    expect(store.fontSize()).toBe(15)
    // 顶到最大档（20）再 +1 还是 20
    store.setFontSize(20)
    store.stepFontSize(1)
    expect(store.fontSize()).toBe(20)
    // 顶到最小档（12）再 -1 还是 12
    store.setFontSize(12)
    store.stepFontSize(-1)
    expect(store.fontSize()).toBe(12)
  })

  it('resetFontSize 回到默认档', () => {
    store.setFontSize(18)
    store.resetFontSize()
    expect(store.fontSize()).toBe(DEFAULT_FONT_SIZE)
  })

  it('写穿失败时说一句话，但信号已经是新值（应用不依赖存盘成功）', async () => {
    settingsIpc.saveSettings.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '写不进去' })
    store.setFontSize(16)
    expect(store.fontSize()).toBe(16)
    await flush()
    expect(warnings).toEqual(['写不进去'])
  })
})

describe('写队列：串行 + 跳过没变化的写', () => {
  it('一串串同步改动合并成「最终值」的一次写', async () => {
    // 三次同步改动：信号 14→16→16→18 立刻到位，而 doWrite 是微任务，
    // 等它跑时读到的都是最终值 18。指纹让后两次跳过 → 只写一次
    store.setFontSize(16)
    store.setFontSize(16)
    store.setFontSize(18)
    await flush()
    await flush()
    expect(settingsIpc.saveSettings).toHaveBeenCalledTimes(1)
    expect(settingsIpc.saveSettings.mock.calls[0]![0]).toMatchObject({ fontSize: 18 })
  })

  it('隔开两轮改动就各写一次，且顺序与改动一致', async () => {
    store.setFontSize(16)
    await flush()
    store.setFontSize(18)
    await flush()
    expect(settingsIpc.saveSettings).toHaveBeenCalledTimes(2)
    expect(settingsIpc.saveSettings.mock.calls[0]![0]).toMatchObject({ fontSize: 16 })
    expect(settingsIpc.saveSettings.mock.calls[1]![0]).toMatchObject({ fontSize: 18 })
  })

  it('值没变时不写（指纹跳过）', async () => {
    store.setFontSize(16)
    await flush()
    expect(settingsIpc.saveSettings).toHaveBeenCalledTimes(1)
    // 再设成同一个值：指纹相同，跳过
    store.setFontSize(16)
    await flush()
    expect(settingsIpc.saveSettings).toHaveBeenCalledTimes(1)
  })
})
