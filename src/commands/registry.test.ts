import { describe, expect, it, vi } from 'vitest'
import type { KeyEventLike } from './keybinding'
import { createCommandRegistry, type AppContext, type CommandRegistry } from './registry'

const NO_EDITOR: AppContext = { editor: null }

function makeRegistry(ctx: AppContext = NO_EDITOR): CommandRegistry {
  return createCommandRegistry({ platform: 'macos', getContext: () => ctx })
}

function event(key: string, metaKey = false): KeyEventLike {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey }
}

describe('register / execute', () => {
  it('执行时把上下文传给 run', async () => {
    const registry = makeRegistry()
    const run = vi.fn()
    registry.register({ id: 'editor.noop', title: '空操作', category: '编辑器', run })
    expect(await registry.execute('editor.noop')).toBe(true)
    expect(run).toHaveBeenCalledWith(NO_EDITOR)
  })

  it('调用方可以显式传上下文，覆盖 getContext', async () => {
    const registry = makeRegistry()
    const run = vi.fn()
    const other: AppContext = { editor: null }
    registry.register({ id: 'editor.noop', title: '空操作', category: '编辑器', run })
    await registry.execute('editor.noop', other)
    expect(run).toHaveBeenCalledWith(other)
  })

  it('未注册的命令抛错，而不是静默 no-op', async () => {
    await expect(makeRegistry().execute('editor.missing')).rejects.toThrow(/未注册的命令/)
  })

  it('when 不满足时返回 false 且不执行', async () => {
    const registry = makeRegistry()
    const run = vi.fn()
    registry.register({
      id: 'editor.foldAll',
      title: '折叠全部',
      category: '编辑器',
      when: (ctx) => ctx.editor !== null,
      run,
    })
    expect(await registry.execute('editor.foldAll')).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('id 必须分层命名，重复注册直接抛', () => {
    const registry = makeRegistry()
    const def = { id: 'editor.fold', title: '折叠', category: '编辑器', run: () => {} }
    registry.register(def)
    expect(() => registry.register(def)).toThrow(/重复注册/)
    // 段内 camelCase 是约定命名（PLAN.md §2.7 的 view.toggleSidebar），必须收下
    registry.register({ ...def, id: 'view.toggleSidebar' })
    expect(() => registry.register({ ...def, id: 'fold' })).toThrow(/不合法/)
    expect(() => registry.register({ ...def, id: 'Editor.Fold' })).toThrow(/不合法/)
  })

  it('快捷键写错在注册期就炸，不等到用户按下', () => {
    expect(() =>
      makeRegistry().register({
        id: 'editor.bad',
        title: '坏的绑定',
        category: '编辑器',
        keybinding: 'Hyper+X',
        run: () => {},
      }),
    ).toThrow(/未知修饰键/)
  })

  it('注销后命令消失', async () => {
    const registry = makeRegistry()
    const dispose = registry.register({ id: 'editor.tmp', title: '临时', category: '编辑器', run: () => {} })
    expect(registry.has('editor.tmp')).toBe(true)
    dispose()
    expect(registry.has('editor.tmp')).toBe(false)
    expect(registry.list()).toEqual([])
    await expect(registry.execute('editor.tmp')).rejects.toThrow(/未注册的命令/)
  })
})

describe('list（命令面板数据源）', () => {
  it('按 category → id 排序，并带上平台化的快捷键标签', () => {
    const registry = makeRegistry()
    registry.register({ id: 'view.zoomIn', title: '放大', category: '视图', keybinding: 'Mod+=', run: () => {} })
    registry.register({ id: 'editor.foldAll', title: '折叠全部', category: '编辑器', run: () => {} })
    registry.register({ id: 'editor.boom', title: '折叠', category: '编辑器', keybinding: ['Mod+K'], run: () => {} })

    expect(registry.list().map((c) => c.id)).toEqual(['editor.boom', 'editor.foldAll', 'view.zoomIn'])
    expect(registry.list().find((c) => c.id === 'view.zoomIn')?.keybindings).toEqual(['⌘='])
  })

  it('enabled 反映 when 的求值结果', () => {
    const registry = makeRegistry()
    registry.register({
      id: 'editor.foldAll',
      title: '折叠全部',
      category: '编辑器',
      when: (ctx) => ctx.editor !== null,
      run: () => {},
    })
    registry.register({ id: 'file.open', title: '打开文件', category: '文件', run: () => {} })
    // category 先于 id 比较，中文按码位：文(U+6587) < 编(U+7F16)，所以 file.open 在前
    expect(registry.list().map((c) => [c.id, c.enabled])).toEqual([
      ['file.open', true],
      ['editor.foldAll', false],
    ])
  })
})

describe('快捷键分派', () => {
  it('命中绑定则返回命令，未命中返回 null', () => {
    const registry = makeRegistry()
    registry.register({ id: 'file.open', title: '打开文件', category: '文件', keybinding: 'Mod+O', run: () => {} })
    expect(registry.findForKey(event('o', true))?.id).toBe('file.open')
    expect(registry.findForKey(event('o'))).toBeNull()
    expect(registry.findForKey(event('p', true))).toBeNull()
  })

  it('被 when 挡住的命令不参与分派', () => {
    const registry = makeRegistry()
    registry.register({
      id: 'editor.toggleLineWrap',
      title: '切换自动换行',
      category: '编辑器',
      keybinding: 'Alt+Z',
      when: (ctx) => ctx.editor !== null,
      run: () => {},
    })
    expect(registry.findForKey(event('z', false))).toBeNull()
  })

  it('冲突时后注册者胜，让后面的模块能有意覆盖', () => {
    const registry = makeRegistry()
    registry.register({ id: 'a.first', title: '先', category: 'a', keybinding: 'Mod+P', run: () => {} })
    registry.register({ id: 'a.second', title: '后', category: 'a', keybinding: 'Cmd+P', run: () => {} })
    expect(registry.findForKey(event('p', true))?.id).toBe('a.second')
  })
})

describe('conflicts', () => {
  it('同一组合的不同写法算同一个冲突', () => {
    const registry = makeRegistry()
    registry.register({ id: 'a.first', title: '先', category: 'a', keybinding: 'Mod+P', run: () => {} })
    registry.register({ id: 'b.second', title: '后', category: 'b', keybinding: 'Cmd+P', run: () => {} })
    registry.register({ id: 'c.third', title: '无关', category: 'c', keybinding: 'Mod+Q', run: () => {} })
    expect(registry.conflicts()).toEqual([{ keybinding: 'meta+p', ids: ['a.first', 'b.second'] }])
  })

  it('注销一方后冲突消失', () => {
    const registry = makeRegistry()
    registry.register({ id: 'a.first', title: '先', category: 'a', keybinding: 'Mod+P', run: () => {} })
    const dispose = registry.register({
      id: 'a.second',
      title: '后',
      category: 'a',
      keybinding: 'Mod+P',
      run: () => {},
    })
    expect(registry.conflicts()).toHaveLength(1)
    dispose()
    expect(registry.conflicts()).toEqual([])
  })
})
