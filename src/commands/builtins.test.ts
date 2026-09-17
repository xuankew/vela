import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import type { EditorController } from '../editor/controller'
import { registerBuiltinCommands, type BuiltinHooks } from './builtins'
import type { KeyEventLike } from './keybinding'
import { createCommandRegistry, type AppContext } from './registry'

/** 四个修饰键必须显式给值：`undefined === false` 为假，漏一个就匹配不上 */
function event(key: string, mods: Partial<Omit<KeyEventLike, 'key'>> = {}): KeyEventLike {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }
}

/**
 * 真实 macOS 上按 Option+字母时浏览器给的 `key` 是特殊字符（Option+z → `Ω`，
 * Option+Shift+a → `Å`），根本不是 `'z'`。`event('z', {altKey:true})` 那种合成事件
 * 在现实里不存在——Alt+Z 曾经整个失效就是这么被测试盖住的。
 */
function macOptionEvent(code: string, key: string, shift = false): KeyEventLike {
  return { key, code, ctrlKey: false, altKey: true, shiftKey: shift, metaKey: false }
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
    splitRight: vi.fn(),
    splitDown: vi.fn(),
    closePane: vi.fn(),
    focusNextPane: vi.fn(),
    focusPreviousPane: vi.fn(),
    openFolder: vi.fn(),
    closeFolder: vi.fn(),
    toggleSidebar: vi.fn(),
    findInFiles: vi.fn(),
    replaceInFiles: vi.fn(),
  }
}

/** 只需要 `lineWrap` 与 `view` 两个成员被读到，造真编辑器实例没必要（也拖不动 DOM） */
function fakeController(lineWrap: boolean): EditorController {
  return { lineWrap } as unknown as EditorController
}

/**
 * 带真 EditorState 的假编辑器，用来验证命令**确实作用到了文档上**，而不只是 id 存在。
 *
 * 行操作与排序去重都是 `StateCommand`，只碰 `{ state, dispatch }`，碰不到 DOM，
 * 所以 node 环境就够（jsdom 没有布局引擎，见 src/test/setup.ts）。
 *
 * `selection` 传数字是光标位置，传 `[from, to]` 是选区——多光标命令要求选区非空。
 */
function fakeEditorWithDoc(doc: string, selection?: number | [number, number]) {
  const initial =
    selection === undefined
      ? undefined
      : typeof selection === 'number'
        ? EditorSelection.cursor(selection)
        : EditorSelection.range(selection[0], selection[1])
  let current = EditorState.create({
    doc,
    ...(initial ? { selection: initial } : {}),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  const view = {
    // 用 getter：连续执行两条命令时，第二条必须看到第一条的结果
    get state() {
      return current
    },
    dispatch: (tr: Transaction) => {
      current = tr.state
    },
  }
  return {
    controller: { lineWrap: true, view } as unknown as EditorController,
    text: () => current.doc.toString(),
    /** copyLineUp / copyLineDown 产出的文本**完全一样**，只有光标落在哪一份上不同 */
    cursorLine: () => current.doc.lineAt(current.selection.main.head).number,
    /** 多光标命令不动文本，动的是「有几处被同时选中」，只能从选区上看结果 */
    selected: () => current.selection.ranges.map((r) => current.sliceDoc(r.from, r.to)),
  }
}

function makeRegistry(editor: EditorController | null) {
  const hooks = makeHooks()
  const registry = createCommandRegistry({ getContext: (): AppContext => ({ editor }) })
  const dispose = registerBuiltinCommands(registry, hooks)
  return { registry, hooks, dispose }
}

/**
 * 建一套「带真文档的假编辑器 + 注册表」。需要连按几次的手势直接用它——
 * `pressKey` 每次都重建注册表，按不出「第二次」。
 */
function harness(doc: string, selection?: number | [number, number]) {
  const { controller, ...probe } = fakeEditorWithDoc(doc, selection)
  const registry = createCommandRegistry({
    platform: 'macos',
    getContext: (): AppContext => ({ editor: controller }),
  })
  const dispose = registerBuiltinCommands(registry, makeHooks())
  return { registry, dispose, ...probe }
}

/**
 * 按一次键并返回结果，验证「快捷键 → 命令 → 真的改了 state」这条完整链路。
 *
 * 只有 `StateCommand` 能这么跑。`deleteLine` 与 `addCursorAbove/Below` 是 `Command`，
 * 实现里要读 `view.lineWrapping` / `moveVertically` / `coordsAtPos`（为了删完行、加完光标
 * 之后光标别乱跳），node 环境造不出这些——它们单独只验快捷键能被找到。
 */
async function pressKey(doc: string, selection: number | [number, number], key: KeyEventLike, id: string) {
  const h = harness(doc, selection)
  expect(h.registry.findForKey(key)?.id).toBe(id)
  const ran = await h.registry.execute(id)
  const result = { text: h.text(), cursorLine: h.cursorLine(), selected: h.selected() }
  h.dispose()
  expect(ran).toBe(true)
  return result
}

describe('内置命令', () => {
  it('三十九条命令全部注册成功，且互不抢占快捷键', () => {
    const { registry } = makeRegistry(null)
    // ⚠️ list() 先按 category 码点排、再按 id 排，所以这个数组**不是**按 id 前缀分组的：
    // 「搜索」(U+641C) < 「文件」(U+6587) < 「编辑器」 < 「视图」 < 「项目」。
    // 两条 search.* 排在最前面正是这个缘故——它们的 id 以 s 开头，本该在 file.* 之后
    expect(registry.list().map((c) => c.id)).toEqual([
      'search.findInFiles',
      'search.replaceInFiles',
      'file.new',
      'file.open',
      'file.save',
      'file.saveAs',
      'editor.addCursorAbove',
      'editor.addCursorBelow',
      'editor.closePane',
      'editor.copyLineDown',
      'editor.copyLineUp',
      'editor.deleteLine',
      'editor.find',
      'editor.findNext',
      'editor.findPrevious',
      'editor.focusNextPane',
      'editor.focusPreviousPane',
      'editor.foldAll',
      'editor.moveLineDown',
      'editor.moveLineUp',
      'editor.removeDuplicateLines',
      'editor.replaceAll',
      'editor.replaceNext',
      'editor.selectAllMatches',
      'editor.selectAllOccurrences',
      'editor.selectNextOccurrence',
      'editor.sortLinesAsc',
      'editor.sortLinesDesc',
      'editor.splitDown',
      'editor.splitRight',
      'editor.startCompletion',
      'editor.toggleLineWrap',
      'editor.unfoldAll',
      'view.decreaseFontSize',
      'view.increaseFontSize',
      'view.resetFontSize',
      'view.toggleSidebar',
      'project.closeFolder',
      'project.openFolder',
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
    // 项目三条同理：空窗口里最该能做的就是「打开一个文件夹」
    expect(enabled.get('project.openFolder')).toBe(true)
    expect(enabled.get('project.closeFolder')).toBe(true)
    expect(enabled.get('view.toggleSidebar')).toBe(true)
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

describe('M1-C-1：行操作与排序去重', () => {
  it('Alt+↑ / Alt+↓ 上下移动当前行', async () => {
    const doc = '第一行\n第二行\n第三行'
    // 光标停在第二行里
    expect((await pressKey(doc, 5, event('ArrowUp', { altKey: true }), 'editor.moveLineUp')).text).toBe(
      '第二行\n第一行\n第三行',
    )
    expect((await pressKey(doc, 5, event('ArrowDown', { altKey: true }), 'editor.moveLineDown')).text).toBe(
      '第一行\n第三行\n第二行',
    )
  })

  it('Shift+Alt+↑ / Shift+Alt+↓ 向上/向下复制当前行', async () => {
    const doc = '第一行\n第二行\n第三行'
    const up = await pressKey(doc, 5, event('ArrowUp', { altKey: true, shiftKey: true }), 'editor.copyLineUp')
    const down = await pressKey(doc, 5, event('ArrowDown', { altKey: true, shiftKey: true }), 'editor.copyLineDown')
    // 文本一模一样：都是把第二行原地复制一份。区别只在光标留在上面那份还是下面那份。
    expect(up.text).toBe('第一行\n第二行\n第二行\n第三行')
    expect(down.text).toBe(up.text)
    expect(up.cursorLine).toBe(2)
    expect(down.cursorLine).toBe(3)
  })

  it('Alt+Shift+A / D / U 排序与去重', async () => {
    expect(
      (await pressKey('banana\napple\ncherry', 0, macOptionEvent('KeyA', 'Å', true), 'editor.sortLinesAsc')).text,
    ).toBe('apple\nbanana\ncherry')
    expect(
      (await pressKey('banana\napple\ncherry', 0, macOptionEvent('KeyD', 'Î', true), 'editor.sortLinesDesc')).text,
    ).toBe('cherry\nbanana\napple')
    expect(
      (await pressKey('a\nb\na\nc\nb', 0, macOptionEvent('KeyU', 'Û', true), 'editor.removeDuplicateLines')).text,
    ).toBe('a\nb\nc')
  })

  it('Option+Z 在 macOS 上是 `Ω`，命令仍然命中——这是 Alt+Z 曾整条失效的回归', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(macOptionEvent('KeyZ', 'Ω'))?.id).toBe('editor.toggleLineWrap')
  })

  it('Mod+Shift+K 命中删除行命令', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('K', { metaKey: true, shiftKey: true }))?.id).toBe('editor.deleteLine')
  })

  it('没有编辑器时，所有 editor.* 命令一律置灰，且执行返回 false 而不是抛错', async () => {
    const { registry } = makeRegistry(null)
    const editorCommands = registry.list().filter((c) => c.id.startsWith('editor.'))
    // 用不变式而不是写死清单：漏掉 `when` 的新命令会立刻在下面的循环里炸，
    // 而不是等到用户在空窗口里按下 Cmd+Shift+K 才抛一个未捕获异常。
    // 条数刻意不写死——「一条都没漏注册」已经由上面那条完整清单保证了，
    // 这里再钉一个数字只会让每次加命令都得多改一处。
    expect(editorCommands.length).toBeGreaterThan(0)
    for (const { id, enabled } of editorCommands) {
      expect(enabled, id).toBe(false)
      await expect(registry.execute(id), id).resolves.toBe(false)
    }
  })
})

describe('M1-C-2：多光标命令的接线', () => {
  it('Mod+D 逐个加选区：光标状态下先选中当前词，再连按拿满三处', async () => {
    const h = harness('foo bar foo baz foo', 1) // 光标在第一个 'foo' 里
    expect(h.registry.findForKey(event('d', { metaKey: true }))?.id).toBe('editor.selectNextOccurrence')

    // 空选区时 CM6 先选中光标所在的词——与 VS Code / Sublime 的 Cmd+D 一致，
    // 所以第一次按下不该是「什么都没发生」
    await h.registry.execute('editor.selectNextOccurrence')
    expect(h.selected()).toEqual(['foo'])
    await h.registry.execute('editor.selectNextOccurrence')
    expect(h.selected()).toEqual(['foo', 'foo'])
    await h.registry.execute('editor.selectNextOccurrence')
    expect(h.selected()).toEqual(['foo', 'foo', 'foo'])
    h.dispose()
  })

  it('Mod+Shift+L 命中「选中全部相同内容」', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('L', { metaKey: true, shiftKey: true }))?.id).toBe('editor.selectAllOccurrences')
  })

  it('Mod+Alt+↑↓ 加光标，且不与 Alt+↑↓ 移动行互抢', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('ArrowUp', { metaKey: true, altKey: true }))?.id).toBe('editor.addCursorAbove')
    expect(registry.findForKey(event('ArrowDown', { metaKey: true, altKey: true }))?.id).toBe('editor.addCursorBelow')
    // 修饰键是严格相等：少一个 Cmd 就是移动行，不是加光标
    expect(registry.findForKey(event('ArrowUp', { altKey: true }))?.id).toBe('editor.moveLineUp')
    expect(registry.findForKey(event('ArrowUp', { altKey: true, shiftKey: true }))?.id).toBe('editor.copyLineUp')
  })
})

describe('M1-C-3：查找替换命令的接线', () => {
  /**
   * 这一组只验「快捷键能被找到」。真正跑起来要一个带面板插件与 searchState 字段的
   * `EditorView`，node 环境造不出来——那部分在 src/editor/findReplace.test.ts 里用真视图验。
   */
  it('Mod+F 打开面板，Mod+G / F3 与 Mod+Shift+G / Shift+F3 各走各的', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('f', { metaKey: true }))?.id).toBe('editor.find')
    expect(registry.findForKey(event('g', { metaKey: true }))?.id).toBe('editor.findNext')
    expect(registry.findForKey(event('F3'))?.id).toBe('editor.findNext')
    expect(registry.findForKey(event('G', { metaKey: true, shiftKey: true }))?.id).toBe('editor.findPrevious')
    expect(registry.findForKey(event('F3', { shiftKey: true }))?.id).toBe('editor.findPrevious')
    // 裸 F3 不该被 Mod+F3 那类声明吃掉，反过来也一样
    expect(registry.findForKey(event('F4'))).toBeNull()
  })

  it('两条替换命令绑的是 Enter 的组合键，不与 CM6 的 Mod+Enter 插空行互抢', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('Enter', { metaKey: true, shiftKey: true }))?.id).toBe('editor.replaceNext')
    expect(registry.findForKey(event('Enter', { metaKey: true, altKey: true }))?.id).toBe('editor.replaceAll')
    // Mod+Enter 是 CM6 defaultKeymap 的 insertBlankLine，刻意没注册，留给它
    expect(registry.findForKey(event('Enter', { metaKey: true }))).toBeNull()
  })

  it('Escape 与 Mod+Alt+G 都没被注册表接管，仍由 CM6 自己的 keymap 处理', () => {
    const { registry } = makeRegistry(fakeController(false))
    // 绑 Escape 的命令一律不注册：全局捕获监听看不到 scope，注册上去会吞掉「关闭查找面板」
    expect(registry.findForKey(event('Escape'))).toBeNull()
    expect(registry.findForKey(event('g', { metaKey: true, altKey: true }))).toBeNull()
  })

  it('「选中全部匹配项」不绑快捷键，但仍进注册表——命令面板要能调它', () => {
    const { registry } = makeRegistry(fakeController(false))
    const info = registry.list().find((c) => c.id === 'editor.selectAllMatches')
    expect(info?.keybindings).toEqual([])
    expect(info?.enabled).toBe(true)
  })
})

describe('M1-D-5：分屏命令的接线', () => {
  it('Mod+\\ 右分屏、Mod+Shift+\\ 下分屏，两者不互抢', () => {
    const { registry } = makeRegistry(fakeController(false))
    // `\` 只有一个字符，走 keyFromEvent 的「单字符转小写」那条路，不经 CODE_ALIASES
    expect(registry.findForKey(event('\\', { metaKey: true }))?.id).toBe('editor.splitRight')
    expect(registry.findForKey(event('\\', { metaKey: true, shiftKey: true }))?.id).toBe('editor.splitDown')
  })

  it('Mod+Alt+←→ 切分屏焦点，不与 Mod+Alt+↑↓ 加光标互抢', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('ArrowRight', { metaKey: true, altKey: true }))?.id).toBe('editor.focusNextPane')
    expect(registry.findForKey(event('ArrowLeft', { metaKey: true, altKey: true }))?.id).toBe(
      'editor.focusPreviousPane',
    )
    expect(registry.findForKey(event('ArrowUp', { metaKey: true, altKey: true }))?.id).toBe('editor.addCursorAbove')
    expect(registry.findForKey(event('ArrowDown', { metaKey: true, altKey: true }))?.id).toBe('editor.addCursorBelow')
  })

  it('五条命令各分派到自己的 hook', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    await registry.execute('editor.splitRight')
    await registry.execute('editor.splitDown')
    await registry.execute('editor.closePane')
    await registry.execute('editor.focusNextPane')
    await registry.execute('editor.focusPreviousPane')
    expect(hooks.splitRight).toHaveBeenCalledOnce()
    expect(hooks.splitDown).toHaveBeenCalledOnce()
    expect(hooks.closePane).toHaveBeenCalledOnce()
    expect(hooks.focusNextPane).toHaveBeenCalledOnce()
    expect(hooks.focusPreviousPane).toHaveBeenCalledOnce()
  })

  it('「合并分屏」不绑快捷键，Mod+W 也没被占用', () => {
    const { registry } = makeRegistry(fakeController(false))
    const info = registry.list().find((c) => c.id === 'editor.closePane')
    expect(info?.keybindings).toEqual([])
    // ⛔ Mod+W 在 macOS 上被原生菜单的快捷键等价物先吃掉，绑在这里根本收不到事件。
    // 这条断言钉住「别以为绑了就有效」——入口只有工具栏的「合并」按钮与命令面板。
    expect(registry.findForKey(event('w', { metaKey: true }))).toBeNull()
  })

  it('没有编辑器时五条一律置灰，执行返回 false 而不是抛错', async () => {
    const { registry, hooks } = makeRegistry(null)
    for (const id of [
      'editor.splitRight',
      'editor.splitDown',
      'editor.closePane',
      'editor.focusNextPane',
      'editor.focusPreviousPane',
    ]) {
      expect(registry.list().find((c) => c.id === id)?.enabled, `${id} 应当置灰`).toBe(false)
      expect(await registry.execute(id), `${id} 应当 no-op`).toBe(false)
    }
    expect(hooks.splitRight).not.toHaveBeenCalled()
  })
})

describe('M2-B：项目与侧边栏命令的接线', () => {
  it('三条命令各分派到自己的 hook', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    await registry.execute('project.openFolder')
    await registry.execute('project.closeFolder')
    await registry.execute('view.toggleSidebar')
    expect(hooks.openFolder).toHaveBeenCalledOnce()
    expect(hooks.closeFolder).toHaveBeenCalledOnce()
    expect(hooks.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('Mod+B 命中显示/隐藏侧边栏，且不与任何已有绑定互抢', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('b', { metaKey: true }))?.id).toBe('view.toggleSidebar')
    // 少一个 Cmd 就是普通字符输入，不该被命令接管
    expect(registry.findForKey(event('b'))).toBeNull()
  })

  it('两条 project.* 刻意不绑快捷键，但仍进注册表——命令面板要能调它们', () => {
    const { registry } = makeRegistry(fakeController(false))
    const listed = new Map(registry.list().map((c) => [c.id, c.keybindings]))
    expect(listed.get('project.openFolder')).toEqual([])
    expect(listed.get('project.closeFolder')).toEqual([])
    // ⛔ Mod+Shift+O 留给 M2-F 的「工作区管理」，Mod+O 已经是「打开文件」。
    // 断言它现在没被占用，是钉住「别在 M2-B 里顺手把它用掉」
    expect(registry.findForKey(event('O', { metaKey: true, shiftKey: true }))).toBeNull()
  })

  it('没有编辑器时三条照样执行成功——这正是它们不设 when 的全部理由', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 空窗口里最该能做的动作就是「打开一个文件夹」。要是这里返回 false，
    // 用户面对一个没有标签的窗口，命令面板里这三条会全是灰的，等于没有入口。
    expect(await registry.execute('project.openFolder')).toBe(true)
    expect(await registry.execute('project.closeFolder')).toBe(true)
    expect(await registry.execute('view.toggleSidebar')).toBe(true)
    expect(hooks.openFolder).toHaveBeenCalledOnce()
    expect(hooks.closeFolder).toHaveBeenCalledOnce()
    expect(hooks.toggleSidebar).toHaveBeenCalledOnce()
  })
})

describe('M2-C：全局搜索命令的接线', () => {
  it('search.findInFiles 分派到自己的 hook', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('search.findInFiles')).toBe(true)
    expect(hooks.findInFiles).toHaveBeenCalledOnce()
  })

  it('Mod+Shift+F 命中它，而 Mod+F 仍然是文档内查找', () => {
    const { registry } = makeRegistry(fakeController(false))
    // 这两个是刻意配成一对的：同一个字母，差一个 Shift，分别落到「当前文档」与「整个项目」。
    // matchesKeybinding 对 shift 是严格相等，所以 Mod+F 不会被带 Shift 的这条吃掉
    expect(registry.findForKey(event('F', { metaKey: true, shiftKey: true }))?.id).toBe('search.findInFiles')
    expect(registry.findForKey(event('f', { metaKey: true }))?.id).toBe('editor.find')
    // 少一个 Cmd 就是普通字符输入，不该被命令接管
    expect(registry.findForKey(event('f'))).toBeNull()
    expect(registry.findForKey(event('F', { shiftKey: true }))).toBeNull()
  })

  it('标题与分类：命令面板里要看得出这条搜的是整个项目，不是当前文档', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.get('search.findInFiles')?.title).toBe('在项目里搜索…')
    expect(registry.get('search.findInFiles')?.category).toBe('搜索')
    // 展示名分平台，注册表缺省 'macos'（registry.ts:90）。mods 的顺序由 MOD_ORDER 定，
    // 是 shift 在 meta 前，所以读作 ⇧⌘F 而不是 ⌘⇧F
    expect(registry.list().find((c) => c.id === 'search.findInFiles')?.keybindings).toEqual(['⇧⌘F'])
  })

  it('没有编辑器时照样执行成功——展开面板这件事不依赖聚焦的文档', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 与 M2-B 那三条同一条理由：空窗口里按 Mod+Shift+F 该看到的是面板与
    // 「还没打开文件夹」那句话，而不是快捷键按了没反应
    expect(await registry.execute('search.findInFiles')).toBe(true)
    expect(hooks.findInFiles).toHaveBeenCalledOnce()
  })
})

describe('M2-D：全局替换命令的接线', () => {
  it('search.replaceInFiles 分派到自己的 hook，不蹭 findInFiles 那条', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('search.replaceInFiles')).toBe(true)
    expect(hooks.replaceInFiles).toHaveBeenCalledOnce()
    // ⚠️ 两个 hook 是**两个入口、两种落点**（一个展开面板、一个展开面板并直接进替换模式）。
    // 谁把 `replaceInFiles` 接到 `findInFiles` 上，用户按下 Mod+Shift+H 看到的就只是搜索面板，
    // 而这一条正是唯一能发现它的断言
    expect(hooks.findInFiles).not.toHaveBeenCalled()
  })

  it('Mod+Shift+H 命中它，而 Mod+H 与 Mod+Shift+F 都还是原来的样子', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('H', { metaKey: true, shiftKey: true }))?.id).toBe('search.replaceInFiles')
    // Mod+H 此前在本项目里就是空的（CM6 的 keymap 里也没有 Mod-h），新命令不该顺手把它占了：
    // 占用一个用户可能留给输入法或系统手势的组合键，代价比省一条命令大
    expect(registry.findForKey(event('h', { metaKey: true }))).toBeNull()
    // 与 Mod+Shift+F 是同一个面板的两个入口，各自命中自己那条
    expect(registry.findForKey(event('F', { metaKey: true, shiftKey: true }))?.id).toBe('search.findInFiles')
    // 文档内替换仍然是 Mod+Shift+Enter，与项目内替换隔着一个字母，不互抢
    expect(registry.findForKey(event('Enter', { metaKey: true, shiftKey: true }))?.id).toBe('editor.replaceNext')
    // 少一个 Cmd 就是普通字符输入
    expect(registry.findForKey(event('H', { shiftKey: true }))).toBeNull()
  })

  it('标题与分类：命令面板里要看得出这条改的是整个项目', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.get('search.replaceInFiles')?.title).toBe('在项目里替换…')
    expect(registry.get('search.replaceInFiles')?.category).toBe('搜索')
    // 与 Mod+Shift+F 同一条规矩：mods 顺序由 MOD_ORDER 定，shift 在 meta 前
    expect(registry.list().find((c) => c.id === 'search.replaceInFiles')?.keybindings).toEqual(['⇧⌘H'])
  })

  it('没有编辑器时照样执行成功——理由与 Mod+Shift+F 一模一样', async () => {
    const { registry, hooks } = makeRegistry(null)
    expect(await registry.execute('search.replaceInFiles')).toBe(true)
    expect(hooks.replaceInFiles).toHaveBeenCalledOnce()
  })
})

/**
 * 只假掉 `startCompletion` 一个函数，其余全用真的。
 *
 * 它要读真实的 DOM（补全面板是 tooltip，挂在 document.body 上），node 环境造不出来；
 * 而这里要验的是「命令确实把 view 递给了 CM6 的入口」，不是补全面板长什么样。
 * ⚠️ 整体替换成假对象会连带删掉本模块其它导出，见 PLAN.md M1-E 实施修正 #33。
 */
const { autocomplete } = vi.hoisted(() => ({
  autocomplete: { startCompletion: vi.fn<typeof import('@codemirror/autocomplete').startCompletion>() },
}))

vi.mock('@codemirror/autocomplete', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@codemirror/autocomplete')>()),
  startCompletion: autocomplete.startCompletion,
}))

describe('M1-E-3：词补全命令的接线', () => {
  it('标题与快捷键声明：命令面板里要能看出这条是干什么的、怎么按', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.get('editor.startCompletion')?.title).toBe('触发词补全')
    expect(registry.get('editor.startCompletion')?.keybinding).toBe('Alt+/')

    // 展示名分平台。注册表的缺省平台是写死的 'macos'（registry.ts:90，项目 macOS 优先），
    // 所以 makeRegistry 建出来的那个本来就出符号；文字形式要显式要一个别的平台才看得到
    expect(registry.list().find((c) => c.id === 'editor.startCompletion')?.keybindings).toEqual(['⌥/'])
    const linux = createCommandRegistry({
      platform: 'linux',
      getContext: (): AppContext => ({ editor: fakeController(false) }),
    })
    const disposeLinux = registerBuiltinCommands(linux, makeHooks())
    expect(linux.list().find((c) => c.id === 'editor.startCompletion')?.keybindings).toEqual(['Alt+/'])
    disposeLinux()
  })

  it('Option+/ 在 macOS 上是 `÷`，命令仍然命中——与 Alt+Z 同一类回归', () => {
    const { registry } = makeRegistry(fakeController(false))
    // 只靠 event.key 永远匹配不到：Option 会把 `/` 转成 `÷`。
    // 靠的是 event.code 报的物理键位 `Slash`（见 keybinding.ts 的 CODE_ALIASES）
    expect(registry.findForKey(macOptionEvent('Slash', '÷'))?.id).toBe('editor.startCompletion')
    // 另一条路也要通：其余平台上 Alt+/ 给的 key 就是 `/`。两边都命中才说明匹配走的是
    // 物理键位，而不是碰巧某一种事件形状
    expect(registry.findForKey(event('/', { altKey: true }))?.id).toBe('editor.startCompletion')
  })

  it('Ctrl+Space 刻意没被占用——那是 macOS 的「切换到上一个输入法」', () => {
    const { registry } = makeRegistry(fakeController(false))
    // 与 Mod+W 同一条道理：系统级快捷键在事件到达 webview 之前就被吃掉了，绑了也收不到。
    // 断言它没被绑，是钉住「别以为 CM6 completionKeymap 里那条在这儿有效」
    expect(registry.findForKey(event(' ', { ctrlKey: true }))).toBeNull()
  })

  it('执行时把 view 递给 CM6 的 startCompletion', async () => {
    // startCompletion 的签名收 EditorView 而不是 { state, dispatch }，所以钉的是
    // 「递过去的就是那个 view 对象本身」。就地造，不从 fakeEditorWithDoc 里反着掏
    const view = { state: EditorState.create({ doc: 'alpha' }) }
    const controller = { lineWrap: true, view } as unknown as EditorController
    const registry = createCommandRegistry({ getContext: (): AppContext => ({ editor: controller }) })
    const dispose = registerBuiltinCommands(registry, makeHooks())
    autocomplete.startCompletion.mockClear()

    await registry.execute('editor.startCompletion')
    expect(autocomplete.startCompletion).toHaveBeenCalledOnce()
    expect(autocomplete.startCompletion.mock.calls[0]![0]).toBe(view)
    dispose()
  })

  it('没有编辑器时置灰，执行返回 false 而不是抛错', async () => {
    const { registry } = makeRegistry(null)
    autocomplete.startCompletion.mockClear()
    expect(registry.list().find((c) => c.id === 'editor.startCompletion')?.enabled).toBe(false)
    expect(await registry.execute('editor.startCompletion')).toBe(false)
    expect(autocomplete.startCompletion).not.toHaveBeenCalled()
  })
})
