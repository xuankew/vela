import { describe, expect, it, vi } from 'vitest'
import type { EditorController } from '../editor/controller'
import { registerBuiltinCommands, type BuiltinHooks } from './builtins'
import type { KeyEventLike } from './keybinding'
import { createCommandRegistry, type AppContext } from './registry'

/** 四个修饰键必须显式给值：`undefined === false` 为假，漏一个就匹配不上 */
function event(key: string, mods: Partial<Omit<KeyEventLike, 'key'>> = {}): KeyEventLike {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }
}

function makeHooks(): BuiltinHooks {
  return {
    newDocument: vi.fn(),
    openFile: vi.fn(),
    saveFile: vi.fn(),
    saveFileAs: vi.fn(),
    applyLineWrap: vi.fn(),
    adjustFontSize: vi.fn(),
    resetFontSize: vi.fn(),
  }
}

/** 只需要 `lineWrap` 与 `view` 两个成员被读到，造真编辑器实例没必要（也拖不动 DOM） */
function fakeController(lineWrap: boolean): EditorController {
  return { lineWrap } as unknown as EditorController
}

function makeRegistry(editor: EditorController | null) {
  const hooks = makeHooks()
  const registry = createCommandRegistry({ getContext: (): AppContext => ({ editor }) })
  const dispose = registerBuiltinCommands(registry, hooks)
  return { registry, hooks, dispose }
}

describe('内置命令', () => {
  it('十条命令全部注册成功，且互不抢占快捷键', () => {
    const { registry } = makeRegistry(null)
    expect(registry.list().map((c) => c.id)).toEqual([
      'file.new',
      'file.open',
      'file.save',
      'file.saveAs',
      'editor.foldAll',
      'editor.toggleLineWrap',
      'editor.unfoldAll',
      'view.decreaseFontSize',
      'view.increaseFontSize',
      'view.resetFontSize',
    ])
    expect(registry.conflicts()).toEqual([])
  })

  it('Mod+S 与 Mod+Shift+S 各走各的，不会被对方吃掉', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    // matchesKeybinding 对 shift 是严格相等，所以 Mod+S 不会匹配到按着 Shift 的事件
    expect(registry.findForKey(event('s', { metaKey: true }))?.id).toBe('file.save')
    expect(registry.findForKey(event('S', { metaKey: true, shiftKey: true }))?.id).toBe('file.saveAs')
    expect(registry.findForKey(event('n', { metaKey: true }))?.id).toBe('file.new')
    expect(registry.findForKey(event('o', { metaKey: true }))?.id).toBe('file.open')

    await registry.execute('file.new')
    await registry.execute('file.save')
    await registry.execute('file.saveAs')
    expect(hooks.newDocument).toHaveBeenCalledOnce()
    expect(hooks.saveFile).toHaveBeenCalledOnce()
    expect(hooks.saveFileAs).toHaveBeenCalledOnce()
  })

  it('命令的 Promise 会等到 hook 的 IO 结束', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    let settled = false
    hooks.saveFile = vi.fn(async () => {
      await Promise.resolve()
      settled = true
    })
    await registry.execute('file.save')
    // 命令面板与忙碌态要靠这个：execute 返回时必须真的写完了
    expect(settled).toBe(true)
  })

  it('没有编辑器时：新建/打开/视图可用，保存类与编辑器类不可用', () => {
    const { registry } = makeRegistry(null)
    const enabled = new Map(registry.list().map((c) => [c.id, c.enabled]))
    // 保存类被挡是应该的：没有编辑器就没有文档，让 Cmd+S 静默成功比报错更糟
    expect(enabled.get('file.save')).toBe(false)
    expect(enabled.get('file.saveAs')).toBe(false)
    expect(enabled.get('editor.foldAll')).toBe(false)
    expect(enabled.get('editor.toggleLineWrap')).toBe(false)
    // 新建与打开恰恰是在「什么都没有」时最该能用的两条
    expect(enabled.get('file.new')).toBe(true)
    expect(enabled.get('file.open')).toBe(true)
    expect(enabled.get('view.resetFontSize')).toBe(true)
  })

  it('编辑器挂上之后保存类立即可用', () => {
    const { registry } = makeRegistry(fakeController(true))
    const enabled = new Map(registry.list().map((c) => [c.id, c.enabled]))
    expect(enabled.get('file.save')).toBe(true)
    expect(enabled.get('file.saveAs')).toBe(true)
    expect(enabled.get('editor.foldAll')).toBe(true)
  })

  it('Alt+Z 取反当前换行状态，落值交给宿主', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    const cmd = registry.findForKey(event('z', { altKey: true }))
    expect(cmd?.id).toBe('editor.toggleLineWrap')
    await registry.execute(cmd!.id)
    expect(hooks.applyLineWrap).toHaveBeenCalledWith(true)
  })

  it('Mod+= / Mod+- / Mod+0 分派到字号命令', async () => {
    const { registry, hooks } = makeRegistry(null)
    expect(registry.findForKey(event('=', { metaKey: true }))?.id).toBe('view.increaseFontSize')
    expect(registry.findForKey(event('-', { metaKey: true }))?.id).toBe('view.decreaseFontSize')
    expect(registry.findForKey(event('0', { metaKey: true }))?.id).toBe('view.resetFontSize')

    await registry.execute('view.increaseFontSize')
    await registry.execute('view.decreaseFontSize')
    expect(hooks.adjustFontSize).toHaveBeenNthCalledWith(1, 1)
    expect(hooks.adjustFontSize).toHaveBeenNthCalledWith(2, -1)

    await registry.execute('view.resetFontSize')
    expect(hooks.resetFontSize).toHaveBeenCalledOnce()
  })

  it('注销后一条都不剩', () => {
    const { registry, dispose } = makeRegistry(null)
    dispose()
    expect(registry.list()).toEqual([])
  })
})
