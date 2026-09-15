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

describe('物理键位（event.code）', () => {
  /** macOS 上 Option+z 真实产生的事件：key 是特殊字符，只有 code 还认得出是 Z 键 */
  const macOptionZ: KeyEventLike = { key: 'Ω', code: 'KeyZ', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }

  it('Alt+字母在 macOS 上必须能匹配——这是回归测试', () => {
    // 修好之前这里返回 'ω'，与声明的 'z' 永远对不上，Alt+Z 在真机上是死的
    expect(keyFromEvent(macOptionZ)).toBe('z')
    expect(matchesKeybinding(macOptionZ, parseKeybinding('Alt+Z', 'macos'))).toBe(true)
  })

  it('Option+Shift+字母同理（sortLines 那类绑定靠它）', () => {
    const macOptionShiftS: KeyEventLike = { key: 'Á', code: 'KeyS', ctrlKey: false, altKey: true, shiftKey: true, metaKey: false }
    expect(matchesKeybinding(macOptionShiftS, parseKeybinding('Alt+Shift+S', 'macos'))).toBe(true)
  })

  it('code 优先于 key：两者矛盾时信 code', () => {
    expect(keyFromEvent({ key: 'Ω', code: 'KeyZ', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false })).toBe('z')
  })

  it('纯修饰键的 code（AltLeft 等）不算主键，单敲 Option 仍然不触发命令', () => {
    expect(keyFromEvent(event('Alt', { altKey: true }) as KeyEventLike)).toBeNull()
    expect(
      keyFromEvent({ key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }),
    ).toBeNull()
    expect(
      matchesKeybinding(
        { key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false },
        parseKeybinding('Alt+Z', 'macos'),
      ),
    ).toBe(false)
  })

  it("输入法接管时（key === 'Process'）放弃匹配，即使 code 报得出物理字母", () => {
    // 中文候选过程中 code 仍是 'KeyZ'，照常用它匹配就会把键从 IME 手里抢走。
    // M0 #2 的中文 IME 判定是按「不抢键」通过的，这条钉住那个前提。
    expect(
      keyFromEvent({ key: 'Process', code: 'KeyZ', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }),
    ).toBeNull()
  })

  it('没有 code 时退回 key，老路径不受影响', () => {
    expect(keyFromEvent(event('ArrowUp', { altKey: true }))).toBe('arrowup')
    expect(keyFromEvent(event('P', { metaKey: true, shiftKey: true }))).toBe('p')
  })

  it('code 表里没有的键位退回 key（小键盘、IntlBackslash 等）', () => {
    expect(
      keyFromEvent({ key: '+', code: 'NumpadAdd', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }),
    ).toBe('+')
  })

  it('带 Shift 的标点：key 是 "+" 而 code 是 Equal，按 "=" 匹配', () => {
    const shiftEqual: KeyEventLike = { key: '+', code: 'Equal', ctrlKey: false, altKey: false, shiftKey: true, metaKey: true }
    expect(matchesKeybinding(shiftEqual, parseKeybinding('Mod+Shift+=', 'macos'))).toBe(true)
    expect(matchesKeybinding(shiftEqual, parseKeybinding('Mod+=', 'macos'))).toBe(false)
  })

  it('数字与功能键走规律命名，不必逐个列表', () => {
    expect(keyFromEvent({ key: '0', code: 'Digit0', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true })).toBe('0')
    expect(keyFromEvent({ key: 'F5', code: 'F5', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBe('f5')
  })
})

describe('formatKeybinding', () => {
  it('macOS 出符号，其余平台出文字', () => {
    expect(formatKeybinding(parseKeybinding('Mod+Shift+P', 'macos'), 'macos')).toBe('⇧⌘P')
    expect(formatKeybinding(parseKeybinding('Mod+Shift+P', 'linux'), 'linux')).toBe('Ctrl+Shift+P')
    expect(formatKeybinding(parseKeybinding('Alt+Up', 'macos'), 'macos')).toBe('⌥↑')
  })
})
