import { describe, expect, it } from 'vitest'
import {
  canonicalKeybinding,
  formatKeybinding,
  keyFromEvent,
  matchesKeybinding,
  parseKeybinding,
  type KeyEventLike,
} from './keybinding'

type Mods = Partial<Pick<KeyEventLike, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>>

function event(key: string, mods: Mods = {}): KeyEventLike {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }
}

describe('parseKeybinding', () => {
  it('Mod 按平台解析：macOS 是 meta，其余是 ctrl', () => {
    expect(parseKeybinding('Mod+D', 'macos').mods).toEqual(['meta'])
    expect(parseKeybinding('Mod+D', 'linux').mods).toEqual(['ctrl'])
    expect(parseKeybinding('Mod+D', 'windows').mods).toEqual(['ctrl'])
  })

  it('修饰键规范化成固定顺序，与声明顺序无关', () => {
    expect(canonicalKeybinding(parseKeybinding('Shift+Cmd+P', 'macos'))).toBe('shift+meta+p')
    expect(canonicalKeybinding(parseKeybinding('Cmd+Shift+P', 'macos'))).toBe('shift+meta+p')
  })

  it('别名收敛到同一个规范串', () => {
    const canonical = ['Cmd+P', 'Command+P', 'Meta+P', 'mod+p'].map((s) =>
      canonicalKeybinding(parseKeybinding(s, 'macos')),
    )
    expect(new Set(canonical).size).toBe(1)
    expect(canonicalKeybinding(parseKeybinding('Option+Up', 'macos'))).toBe('alt+arrowup')
  })

  it('主键统一小写', () => {
    expect(parseKeybinding('CMD+SHIFT+p', 'macos').key).toBe('p')
    expect(parseKeybinding('Cmd+A', 'macos').key).toBe('a')
  })

  it('裸键只允许 Escape 与 F1~F24，裸字母必须拒绝', () => {
    expect(parseKeybinding('Escape', 'macos').key).toBe('escape')
    expect(parseKeybinding('F5', 'macos').key).toBe('f5')
    // 允许裸字母的话，一处 'p' 与 'Mod+p' 的笔误就会吞掉编辑器里的正常输入
    expect(() => parseKeybinding('p', 'macos')).toThrow(/修饰键/)
    expect(() => parseKeybinding('F25', 'macos')).toThrow(/无法识别的主键/)
  })

  it('缺主键、未知修饰键都在解析期报错', () => {
    expect(() => parseKeybinding('Mod+', 'macos')).toThrow(/缺少主键/)
    expect(() => parseKeybinding('Hyper+X', 'macos')).toThrow(/未知修饰键/)
  })

  it('不支持绑定字面量 + 键', () => {
    // 'Mod++' 按 + 切分会得到空 token，歧义无法消解；要绑加号用 'Mod+='
    expect(() => parseKeybinding('Mod++', 'macos')).toThrow()
    expect(parseKeybinding('Mod+=', 'macos').key).toBe('=')
  })
})

describe('matchesKeybinding', () => {
  it('修饰键必须完全一致，多一个少一个都不匹配', () => {
    const binding = parseKeybinding('Mod+Shift+P', 'macos')
    expect(matchesKeybinding(event('P', { metaKey: true, shiftKey: true }), binding)).toBe(true)
    expect(matchesKeybinding(event('P', { metaKey: true }), binding)).toBe(false)
    expect(matchesKeybinding(event('P', { metaKey: true, shiftKey: true, ctrlKey: true }), binding)).toBe(false)
  })

  it('event.key 的大写形式与声明的小写主键对齐', () => {
    const binding = parseKeybinding('Mod+Shift+P', 'macos')
    expect(matchesKeybinding(event('p', { metaKey: true, shiftKey: true }), binding)).toBe(true)
  })

  it('纯修饰键按下不算匹配，否则单独敲一下 Cmd 就会触发命令', () => {
    expect(keyFromEvent(event('Meta', { metaKey: true }))).toBeNull()
    expect(matchesKeybinding(event('Meta', { metaKey: true }), parseKeybinding('Mod+P', 'macos'))).toBe(false)
  })

  it('空格与方向键', () => {
    expect(matchesKeybinding(event(' ', { metaKey: true }), parseKeybinding('Mod+Space', 'macos'))).toBe(true)
    expect(matchesKeybinding(event('ArrowUp', { altKey: true }), parseKeybinding('Alt+Up', 'macos'))).toBe(true)
  })
})

describe('formatKeybinding', () => {
  it('macOS 出符号，其余平台出文字', () => {
    expect(formatKeybinding(parseKeybinding('Mod+Shift+P', 'macos'), 'macos')).toBe('⇧⌘P')
    expect(formatKeybinding(parseKeybinding('Mod+Shift+P', 'linux'), 'linux')).toBe('Ctrl+Shift+P')
    expect(formatKeybinding(parseKeybinding('Alt+Up', 'macos'), 'macos')).toBe('⌥↑')
  })
})
