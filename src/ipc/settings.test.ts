import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 前后端「分层配置契约」的前端快照（M4-A）。
 *
 * 与 Rust 侧 `crates/vela-core/tests/wire_contract.rs` 的「分层配置（M4-A）」那一段
 * 一一对应，两边的 JSON 字面量必须同时改。这里钉的是**前端实际使用的字段名**：`invoke`
 * 拿到的是纯 JSON，字段名写错只会得到 `undefined`——不报错、不抛异常，表现是
 * 「重启后字号/字体回到默认」，用户只会觉得「我设的没记住」。
 */

// `vi.hoisted` 是必需的：vitest 会把 `vi.mock` 提到文件最上面，而 mock 工厂在被 mock
// 模块首次 import 时就会执行——那时普通 `const` 还处在 TDZ 里。
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { DEFAULT_CODE_FONT, DEFAULT_VARIANT } from '../fonts/loader'
import {
  describeSettingsError,
  loadSettings,
  saveSettings,
  type LoadedSettings,
  type SaveReport,
  type Settings,
  type SettingsReport,
} from './settings'

/**
 * Rust 侧 `settings_的线上形状` 断言的就是这个字面量的**字段集合与顺序**，但字节的 f64
 * 写法两边不同：这是**内置默认**（三层合并的最底层），也是空现场下 `load` 交出来的配置。
 *
 * ⚠️ 🔴 `letterSpacing` 的默认值在 **JS 侧写 `0`**（`JSON.stringify(0)` → `"0"`），而
 * Rust 侧 `serde_json` 对 `f64` 永远带小数点、写 `0.0`。两者是**同一个 JSON number**
 * （`JSON.parse("0") === JSON.parse("0.0")`，Rust 的 `from_str` 也一样），所以两边都能
 * 读回来——只是「落盘/序列化字节」这一层不同。与 session 的 `scrollTop: 0.0` 同一条取舍。
 * 于是 Rust 的黄金字面量写 `letterSpacing:0.0`，这里写 `letterSpacing:0`，各钉各那一侧的输出。
 */
const GOLDEN_SETTINGS =
  '{"fontSize":14,"fontVariant":"screen-gb","codeFont":"maple-cn","lineHeight":1.75,"letterSpacing":0,"theme":"dark"}'

/** 非默认值的一份配置，用来钉「任何一档都走同一条反序列化路径」（字段是具体值不是 Option） */
const GOLDEN_SETTINGS_CUSTOM =
  '{"fontSize":16,"fontVariant":"screen-r","codeFont":"inherit","lineHeight":2,"letterSpacing":0.05,"theme":"light"}'

/**
 * Rust 侧 `loaded_settings_的线上形状` 断言的就是这个字面量。
 * 刻意让两层各走一条不同的下场（用户层 present、项目层 corrupt），再让项目层试图写一个
 * 偏好键落进 `ignoredProjectKeys`——把「一层坏掉不拦另一层」「项目层偏好键被忽略并记账」
 * 两件事一次钉住。
 */
const GOLDEN_LOADED =
  '{"settings":{"fontSize":16,"fontVariant":"screen-r","codeFont":"inherit","lineHeight":2,"letterSpacing":0.05,"theme":"light"},"report":{"userLayer":{"status":"present"},"projectLayer":{"status":"corrupt","reason":"坏"},"ignoredProjectKeys":["fontSize"]}}'

/** Rust 侧 `空现场下_load_的线上形状`：两层都 absent、配置是内置默认、没有键被忽略 */
const GOLDEN_LOADED_EMPTY =
  '{"settings":{"fontSize":14,"fontVariant":"screen-gb","codeFont":"maple-cn","lineHeight":1.75,"letterSpacing":0,"theme":"dark"},"report":{"userLayer":{"status":"absent"},"projectLayer":{"status":"absent"},"ignoredProjectKeys":[]}}'

/** Rust 侧 `save_report_的线上形状` */
const GOLDEN_SAVE_REPORT = '{"bytesWritten":42}'

function sampleSettings(): Settings {
  return {
    fontSize: 14,
    fontVariant: 'screen-gb',
    codeFont: 'maple-cn',
    lineHeight: 1.75,
    letterSpacing: 0,
    theme: 'dark',
  }
}

beforeEach(() => {
  invoke.mockReset()
})

describe('Rust → 前端 的字段名', () => {
  it('Settings 的字段名与顺序与 Rust 侧序列化结果一致', () => {
    const parsed = JSON.parse(GOLDEN_SETTINGS) as Settings
    // 键顺序就是 JSON.parse 的插入顺序，所以 stringify 相等 == 字段集合与顺序都相等
    expect(JSON.stringify(parsed)).toBe(GOLDEN_SETTINGS)
    expect(Object.keys(parsed)).toEqual(['fontSize', 'fontVariant', 'codeFont', 'lineHeight', 'letterSpacing', 'theme'])
  })

  it('解析出来的值与前端能造出来的对象完全相等', () => {
    expect(JSON.parse(GOLDEN_SETTINGS)).toEqual(sampleSettings())
    expect(JSON.stringify(sampleSettings())).toBe(GOLDEN_SETTINGS)
  })

  it('非默认配置也原样往返：字段是具体值不是 Option', () => {
    const parsed = JSON.parse(GOLDEN_SETTINGS_CUSTOM) as Settings
    expect(parsed).toEqual({
      fontSize: 16,
      fontVariant: 'screen-r',
      codeFont: 'inherit',
      lineHeight: 2,
      letterSpacing: 0.05,
      theme: 'light',
    })
    expect(JSON.stringify(parsed)).toBe(GOLDEN_SETTINGS_CUSTOM)
  })

  it('Rust 发的 0.0 与 JS 发的 0 读回来是同一个数', () => {
    // 🔴 这一条专门钉 f64 那个跨语言差异：Rust 侧 `letterSpacing` 默认序列化成 `0.0`，
    // JS 侧是 `0`。两者 parse 出来必须 `===`，否则「Rust 存的配置」与「JS 存的配置」
    // 在 store 里会被当成两个不同的值，触发一次多余的写盘
    expect((JSON.parse('{"letterSpacing":0.0}') as { letterSpacing: number }).letterSpacing).toBe(
      (JSON.parse('{"letterSpacing":0}') as { letterSpacing: number }).letterSpacing,
    )
    // Rust 的 pretty 输出同理：`lineHeight: 2.0` 读回来是 `2`
    expect((JSON.parse('{"lineHeight":2.0}') as { lineHeight: number }).lineHeight).toBe(2)
  })

  it('LayerStatus 的三种形状：status 是标签字段，只有 corrupt 带 reason', () => {
    expect(JSON.stringify({ status: 'absent' })).toBe('{"status":"absent"}')
    expect(JSON.stringify({ status: 'present' })).toBe('{"status":"present"}')
    expect(JSON.stringify({ status: 'corrupt', reason: '坏' })).toBe('{"status":"corrupt","reason":"坏"}')
    // 与 Rust 侧 `layer_status_的三种线上形状` 逐字相同
  })

  it('LoadedSettings 的字段名与嵌套顺序与 Rust 侧一致', () => {
    const parsed = JSON.parse(GOLDEN_LOADED) as LoadedSettings
    expect(JSON.stringify(parsed)).toBe(GOLDEN_LOADED)
    expect(Object.keys(parsed)).toEqual(['settings', 'report'])
    expect(Object.keys(parsed.report)).toEqual(['userLayer', 'projectLayer', 'ignoredProjectKeys'])
    expect(parsed.report.userLayer).toEqual({ status: 'present' })
    expect(parsed.report.projectLayer).toEqual({ status: 'corrupt', reason: '坏' })
    expect(parsed.report.ignoredProjectKeys).toEqual(['fontSize'])
  })

  it('SettingsReport 的字段名是 camelCase', () => {
    const parsed = JSON.parse(GOLDEN_LOADED) as LoadedSettings
    const report: SettingsReport = parsed.report
    expect(JSON.stringify(report)).toBe(
      '{"userLayer":{"status":"present"},"projectLayer":{"status":"corrupt","reason":"坏"},"ignoredProjectKeys":["fontSize"]}',
    )
  })

  it('SaveReport 的字段名是 camelCase', () => {
    const parsed = JSON.parse(GOLDEN_SAVE_REPORT) as SaveReport
    expect(JSON.stringify(parsed)).toBe(GOLDEN_SAVE_REPORT)
    expect(Object.keys(parsed)).toEqual(['bytesWritten'])
  })
})

describe('内置默认值两边各钉一条', () => {
  it('黄金字面量里的六个默认值与 Rust 侧 DEFAULT_* 常量同值', () => {
    // Rust 侧 `内置默认配置被钉住` 断言 DEFAULT_FONT_SIZE==14 / DEFAULT_FONT_VARIANT=="screen-gb"
    // / DEFAULT_CODE_FONT=="maple-cn" / DEFAULT_LINE_HEIGHT==1.75 / DEFAULT_LETTER_SPACING==0.0
    // / DEFAULT_THEME=="dark"。
    // 这里钉的是**同一个字面量**的前端那一半：改了任一边而没改另一边，两条测试会一起红。
    const parsed = JSON.parse(GOLDEN_SETTINGS) as Settings
    expect(parsed.fontSize).toBe(14)
    expect(parsed.fontVariant).toBe('screen-gb')
    expect(parsed.codeFont).toBe('maple-cn')
    expect(parsed.lineHeight).toBe(1.75)
    expect(parsed.letterSpacing).toBe(0)
    expect(parsed.theme).toBe('dark')
  })

  it('字体注册表的默认 ID 就是契约里的默认值', () => {
    // 🔴 这一条把「ipc 契约」与「字体注册表」两个前端模块 tying 在一起：
    // Rust 的内置默认 `fontVariant`/`codeFont` 必须是前端**认得**的合法 ID，
    // 否则 store 一 sanitize 就把 Rust 给的默认又打回前端默认，两边的「默认」就不是一回事了。
    // 漂了的表现很安静：Rust 存了个前端不认识的串，UI 永远显示回退字体，没有一句报错。
    expect(DEFAULT_VARIANT).toBe('screen-gb')
    expect(DEFAULT_CODE_FONT).toBe('maple-cn')
    expect((JSON.parse(GOLDEN_SETTINGS) as Settings).fontVariant).toBe(DEFAULT_VARIANT)
    expect((JSON.parse(GOLDEN_SETTINGS) as Settings).codeFont).toBe(DEFAULT_CODE_FONT)
  })
})

describe('前端 → Rust 的 command 名与参数名', () => {
  it('load_settings 只收 roots，路径由 Rust 侧算', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_LOADED_EMPTY))
    const loaded = await loadSettings(['/Users/me/code/vela', '/Users/me/notes'])
    // ⚠️ 没有 home / path 参数是有意的：给了前端传路径的入口，就等于多一个「写任意路径」的原语。
    // 多根时 Rust 只取第一个根推项目层路径，所以这里递整个清单是安全的
    expect(invoke).toHaveBeenCalledWith('load_settings', { roots: ['/Users/me/code/vela', '/Users/me/notes'] })
    expect(loaded.report.projectLayer).toEqual({ status: 'absent' })
  })

  it('没打开文件夹时递空 roots，项目层是 absent', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_LOADED_EMPTY))
    const loaded = await loadSettings([])
    expect(invoke).toHaveBeenCalledWith('load_settings', { roots: [] })
    expect(loaded).toEqual(JSON.parse(GOLDEN_LOADED_EMPTY))
  })

  it('save_settings 的参数名是 settings，不是 config / patch', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_SAVE_REPORT))
    const settings = sampleSettings()
    await saveSettings(settings)
    // Tauri 2 默认把 command 形参按 camelCase 暴露给 JS。Rust 侧形参就叫 `settings`，
    // 单词没有下划线，所以两边同名
    expect(invoke).toHaveBeenCalledWith('save_settings', { settings })
  })

  it('发出去的 settings payload 永远带齐六个键', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_SAVE_REPORT))
    await saveSettings(sampleSettings())
    const sent = invoke.mock.calls[0]![1] as { settings: Settings }
    expect(Object.keys(sent.settings)).toEqual([
      'fontSize',
      'fontVariant',
      'codeFont',
      'lineHeight',
      'letterSpacing',
      'theme',
    ])
    // 六个键都是具体值，没有 undefined（undefined 会被 JSON.stringify 整个删掉，
    // 落到 Rust 侧就成了「缺键」，而 Settings 没有 #[serde(default)]，缺键直接拒）
    expect(JSON.stringify(sent.settings)).toBe(GOLDEN_SETTINGS)
  })
})

describe('错误落地成人能读的话', () => {
  it('no_parent 带上路径，io 直接用 Rust 给的 message', () => {
    expect(describeSettingsError({ kind: 'no_parent', path: 'settings.json' })).toContain('settings.json')
    expect(describeSettingsError({ kind: 'io', reason: 'HomeDir', message: '拿不到用户主目录' })).toBe(
      '拿不到用户主目录',
    )
  })

  it('Rust 侧将来加了变体而前端没跟上时，不会抛', () => {
    expect(describeSettingsError({ kind: 'brand_new_variant' })).toBe('[object Object]')
  })

  it('不是 IPC 错误时退回 Error / 字符串', () => {
    expect(describeSettingsError(new Error('拿不到用户主目录'))).toBe('拿不到用户主目录')
    expect(describeSettingsError('字符串错误')).toBe('字符串错误')
    expect(describeSettingsError(null)).toBe('null')
  })
})
