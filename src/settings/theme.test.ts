// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `src/settings/theme.ts` 的单测：注册表常量、sanitize、系统偏好解析与订阅、DOM 属性落地。
 *
 * 这一层不碰 IPC，只碰 `window.matchMedia` 与 `document.documentElement`，所以唯一的假东西
 * 是一个可控的 `matchMedia`：真实 jsdom 的 `matchMedia().matches` 恒为 false 且不会派发
 * `change`，测不出「跟随系统」的解析与订阅，只能自己装一个能改 `matches`、能手动 fire 的。
 */

import {
  applyThemeAttr,
  DARK_QUERY,
  DEFAULT_THEME,
  isDarkTheme,
  resolveTheme,
  sanitizeThemeId,
  systemTheme,
  THEME_IDS,
  THEME_LABELS,
  watchSystemTheme,
} from './theme'

interface FakeMql {
  matches: boolean
  setMatches: (v: boolean) => void
  fire: () => void
  listenerCount: () => number
}

/** 装一个可控的 matchMedia，返回操作它的把手。每次调 window.matchMedia 都拿到同一个 mql */
function installMatchMedia(matches: boolean): FakeMql {
  const listeners = new Set<() => void>()
  const mql = { matches, media: DARK_QUERY }
  const handle: FakeMql = {
    matches,
    setMatches(v) {
      mql.matches = v
      handle.matches = v
    },
    fire() {
      for (const cb of listeners) cb()
    },
    listenerCount: () => listeners.size,
  }
  const fake = {
    ...mql,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  }
  // handler 读的是 `mql.matches`，而 setMatches 改的是内层 `mql`；fake 上的 matches 只是初值副本
  Object.defineProperty(fake, 'matches', { get: () => mql.matches })
  window.matchMedia = vi.fn(() => fake) as unknown as typeof window.matchMedia
  return handle
}

let hadMatchMedia = false
let originalMatchMedia: typeof window.matchMedia | undefined

beforeEach(() => {
  hadMatchMedia = 'matchMedia' in window
  // 存下原函数以便 afterEach 原样还原；这里只做「保存引用」，不会脱离 window 调用它
  // eslint-disable-next-line @typescript-eslint/unbound-method
  originalMatchMedia = window.matchMedia
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  if (hadMatchMedia && originalMatchMedia) window.matchMedia = originalMatchMedia
  else delete (window as { matchMedia?: unknown }).matchMedia
})

describe('注册表常量', () => {
  it('三个 ID 与它们的标签一一对应', () => {
    expect(THEME_IDS).toEqual(['light', 'dark', 'system'])
    for (const id of THEME_IDS) expect(typeof THEME_LABELS[id]).toBe('string')
    expect(THEME_LABELS.system).toBe('跟随系统')
  })

  it('🔴 默认是 dark，与 Rust DEFAULT_THEME 同值', () => {
    // 与 `crates/vela-core/src/settings/mod.rs` 的 `DEFAULT_THEME` 及 `wire_contract.rs`
    // 的 `内置默认配置被钉住` 各钉一条：默认取 dark 是为了「老用户升级后一个像素都不动」
    expect(DEFAULT_THEME).toBe('dark')
    expect(THEME_IDS).toContain(DEFAULT_THEME)
  })
})

describe('sanitizeThemeId', () => {
  it('合法 ID 原样通过', () => {
    for (const id of ['light', 'dark', 'system']) expect(sanitizeThemeId(id)).toBe(id)
  })

  it('不认识的串打回默认', () => {
    for (const bad of ['nope', '', 'Dark', 'LIGHT', 'solarized']) expect(sanitizeThemeId(bad)).toBe(DEFAULT_THEME)
  })

  it('原型链上的键名不被当成合法 ID', () => {
    // 配置是不可信输入：`toString` / `constructor` 若被当成合法主题，select 会显示空白
    for (const bad of ['toString', 'constructor', 'hasOwnProperty']) expect(sanitizeThemeId(bad)).toBe(DEFAULT_THEME)
  })
})

describe('systemTheme / resolveTheme', () => {
  it('系统偏暗时解析成 dark，偏亮时解析成 light', () => {
    const mql = installMatchMedia(true)
    expect(systemTheme()).toBe('dark')
    mql.setMatches(false)
    expect(systemTheme()).toBe('light')
  })

  it('没有 matchMedia 时退回 dark（= 默认，也是这个应用在 M4-C 之前的样子）', () => {
    delete (window as { matchMedia?: unknown }).matchMedia
    expect(systemTheme()).toBe('dark')
  })

  it("resolveTheme 把 'system' 拆开，其余原样", () => {
    const mql = installMatchMedia(false)
    expect(resolveTheme('system')).toBe('light')
    mql.setMatches(true)
    expect(resolveTheme('system')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('isDarkTheme 跟着解析结果走', () => {
    const mql = installMatchMedia(true)
    expect(isDarkTheme('dark')).toBe(true)
    expect(isDarkTheme('light')).toBe(false)
    expect(isDarkTheme('system')).toBe(true)
    mql.setMatches(false)
    expect(isDarkTheme('system')).toBe(false)
  })
})

describe('applyThemeAttr', () => {
  it('把具体主题写进 <html data-theme>', () => {
    applyThemeAttr('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyThemeAttr('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('watchSystemTheme', () => {
  it('系统偏好变化时回调解析出的具体主题，退订后不再回调', () => {
    const mql = installMatchMedia(true)
    const seen: string[] = []
    const unwatch = watchSystemTheme((t) => seen.push(t))
    expect(mql.listenerCount()).toBe(1)

    mql.setMatches(false)
    mql.fire()
    expect(seen).toEqual(['light'])

    unwatch()
    expect(mql.listenerCount()).toBe(0)
    mql.setMatches(true)
    mql.fire()
    expect(seen, '退订之后不该再收到').toEqual(['light'])
  })

  it('没有 matchMedia 时返回空退订，不抛错', () => {
    delete (window as { matchMedia?: unknown }).matchMedia
    const unwatch = watchSystemTheme(() => {})
    expect(typeof unwatch).toBe('function')
    expect(() => unwatch()).not.toThrow()
  })
})
