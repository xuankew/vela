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
    openFile: vi.fn(),
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
  it('七条命令全部注册成功，且互不抢占快捷键', () => {
    const { registry } = makeRegistry(null)
    expect(registry.list().map((c) => c.id)).toEqual([
      'file.open',
      'editor.foldAll',
      'editor.toggleLineWrap',
      'editor.unfoldAll',
      'view.decreaseFontSize',
      'view.increaseFontSize',
      'view.resetFontSize',
    ])
    expect(registry.conflicts()).toEqual([])
  })

  it('编辑器类命令在没有编辑器时不可用，文件/视图类始终可用', () => {
    const { registry } = makeRegistry(null)
    const enabled = new Map(registry.list().map((c) => [c.id, c.enabled]))
    expect(enabled.get('editor.foldAll')).toBe(false)
    expect(enabled.get('editor.toggleLineWrap')).toBe(false)
    expect(enabled.get('file.open')).toBe(true)
    expect(enabled.get('view.resetFontSize')).toBe(true)
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
