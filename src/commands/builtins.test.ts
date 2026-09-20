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
    addFolder: vi.fn(),
    openRecentProject: vi.fn(),
    closeFolder: vi.fn(),
    toggleSidebar: vi.fn(),
    togglePreview: vi.fn(),
    toggleOutline: vi.fn(),
    alignTable: vi.fn(),
    wordCount: vi.fn(),
    exportHtml: vi.fn(),
    findInFiles: vi.fn(),
    replaceInFiles: vi.fn(),
    gotoFile: vi.fn(),
    gotoSymbol: vi.fn(),
    openToolBox: vi.fn(),
    openCommandPalette: vi.fn(),
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
 * 分屏那五条命令的 id。
 *
 * 抽出来是因为两处要用同一份清单，而它们要钉的是**相反**的两件事：M1-D-5 那组验它们
 * 各分派到自己的 hook，M1-C-1 那条不变式则要把它们**排除**在「没有编辑器就一律置灰」
 * 之外。清单写两遍的话，哪天加第六条分屏命令只会有一处被想起来。
 */
const PANE_COMMAND_IDS: readonly string[] = [
  'editor.splitRight',
  'editor.splitDown',
  'editor.closePane',
  'editor.focusNextPane',
  'editor.focusPreviousPane',
]

/**
 * `editor.*` 里**刻意不设 `when`** 的那几条，共七条。
 *
 * 前五条就是分屏那五条。后两条理由不同、结论相同：`editor.alignTable`（M3-A-5）与
 * `editor.wordCount`（M3-A-6）都作用于**文档**而不是面板，而只读分片那块分屏里
 * `ctx.editor` 同样是 null——「没有编辑器」在这儿的意思可能是「聚焦的是一份只读大文件」，
 * 不是「没有表可对齐」。字数那条更是反过来的：几百万行的日志恰恰是**最不该**被数的，
 * 但那句话得由宿主说出来，不能靠一个按下去毫无反应的快捷键表达。
 *
 * ⛔ 不要顺手并进 `PANE_COMMAND_IDS`：那份清单还担着「五条各分派到自己的 hook」那组
 * 断言（M1-D-5），把后两条混进去会把它们也拽进那组，而它们压根不是分屏命令。
 */
const UNGATED_EDITOR_COMMAND_IDS: readonly string[] = [...PANE_COMMAND_IDS, 'editor.alignTable', 'editor.wordCount']

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
  it('四十八条命令全部注册成功，且互不抢占快捷键', () => {
    const { registry } = makeRegistry(null)
    // ⚠️ list() 先按 category 码点排、再按 id 排，所以这个数组**不是**按 id 前缀分组的：
    // 「工具」(U+5DE5) < 「搜索」(U+641C) < 「文件」(U+6587) < 「编辑器」(U+7F16)
    // < 「视图」(U+89C6) < 「跳转」(U+8DF3) < 「项目」(U+9879)。
    // 两条 search.* 排在 file.* 之前正是这个缘故——它们的 id 以 s 开头，本该在 file.* 之后；
    // 两条 goto.* 排在 view.* 之后同理。⚠️ 「跳转」的码点比「视图」**大**，
    // 凭字形或拼音猜排序在这里必错
    expect(registry.list().map((c) => c.id)).toEqual([
      // 「工具」这一组只有一条：M3-B-1 交的是工具箱那个**入口**，
      // 六个工具本身在 M3-B-2…6 里由 `tools/builtin.ts` 投影进来（见 tools/registry.test.ts）
      'toolbox.open',
      'search.findInFiles',
      'search.replaceInFiles',
      'file.exportHtml',
      'file.new',
      'file.open',
      'file.save',
      'file.saveAs',
      'editor.addCursorAbove',
      'editor.addCursorBelow',
      'editor.alignTable',
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
      'editor.wordCount',
      // 'c' < 'v'，所以命令面板排在六条 view.* 前面
      'commandPalette.open',
      'view.decreaseFontSize',
      'view.increaseFontSize',
      'view.resetFontSize',
      'view.toggleOutline',
      'view.togglePreview',
      'view.toggleSidebar',
      'goto.file',
      'goto.symbol',
      'project.addFolder',
      'project.closeFolder',
      'project.openFolder',
      'project.openRecent',
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
    // 预览那条也是：面板自己会说「X 还没有预览」，比快捷键按了没反应说得多
    expect(enabled.get('view.togglePreview')).toBe(true)
    // 大纲同一条理由，而它说的那一句是「X 还没有符号表」——与 `Cmd+R` 浮层逐字相同
    expect(enabled.get('view.toggleOutline')).toBe(true)
    // ⚠️ 这一条是 `editor.*` 却**照样可用**：与分屏那五条同一条理由（见 builtins.ts 里那段 🔴）——
    // 只读分片那块分屏里 `ctx.editor` 是 null，而它的含义是「聚焦的是一份只读大文件」，
    // 不是「没东西可对齐」。宿主自己会说「这块分屏里没有可对齐的表格」
    expect(enabled.get('editor.alignTable')).toBe(true)
    // 字数统计同一条理由，而且更极端：只读分片恰恰是最不该被数的那种文档，
    // 所以「这块分屏里没有可统计的正文」这句话必须由宿主说（M3-A-6）
    expect(enabled.get('editor.wordCount')).toBe(true)
    // ⚠️ `file.exportHtml` 在「文件」分类里却也不设 gate，与同分类的 `file.save` /
    // `file.saveAs` 不一致——它要说的四种拒绝里有一种是「这不是 Markdown」，
    // 而那与有没有编辑器无关，`ctx.editor !== null` 表达不了
    expect(enabled.get('file.exportHtml')).toBe(true)
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

  // 🔴 点名的那七条是**例外**：M2-H 之后 `ctx.editor === null` 不再等于「没东西可
  // 编辑」，也可能是「聚焦的是一块只读分片」（`ShardPane` 不是 CM6，压根没有
  // `EditorController`），而 M3-A-5 的对齐表格与 M3-A-6 的字数统计同受其害。例外的代价是
  // 这条不变式对它们失效，所以只能靠 `UNGATED_EDITOR_COMMAND_IDS` 点名，不能靠「凡 editor.* 都要 gate」一刀切
  it('没有编辑器时，除点名的那七条外所有 editor.* 命令一律置灰，且执行返回 false 而不是抛错', async () => {
    const { registry } = makeRegistry(null)
    const editorCommands = registry
      .list()
      .filter((c) => c.id.startsWith('editor.') && !UNGATED_EDITOR_COMMAND_IDS.includes(c.id))
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

  // 🔴 这条从「一律置灰」翻成「一律照跑」是 M2-H 改的，理由逐字写在 builtins.ts 那段
  // 注释里，简言之：只读分片那块分屏里**没有** `EditorController`，于是
  // `ctx.editor === null` 的含义已经从「没东西可分屏」变成了「聚焦的是一份只读大文件」。
  // 照旧设 gate 的后果是：打开一个 100 MB 的日志，整组分屏命令全哑掉；而工具栏那两个
  // 按钮的 `disabled` 只看 `MAX_PANES`，**看上去还是能点的**——点下去什么也不发生，
  // 也不报错。安全性不在这里保证，在 workspace 里：`capture` / `focusPane` /
  // `syncMetrics` 全是 `controller?.` 那一套写法，没有编辑器就是什么都不做
  it('没有编辑器时五条照样跑（聚焦的可能是一块只读分片）', async () => {
    const { registry, hooks } = makeRegistry(null)
    for (const id of PANE_COMMAND_IDS) {
      expect(registry.list().find((c) => c.id === id)?.enabled, `${id} 应当可点`).toBe(true)
      expect(await registry.execute(id), `${id} 应当分派到自己的 hook`).toBe(true)
    }
    expect(hooks.splitRight).toHaveBeenCalledOnce()
    expect(hooks.splitDown).toHaveBeenCalledOnce()
    expect(hooks.closePane).toHaveBeenCalledOnce()
    expect(hooks.focusNextPane).toHaveBeenCalledOnce()
    expect(hooks.focusPreviousPane).toHaveBeenCalledOnce()

    // 按键那条路同一条规矩：`findForKey` 也过 `when`，gate 一加 ⌘\ 就一起哑
    expect(registry.findForKey(event('\\', { metaKey: true }))?.id).toBe('editor.splitRight')
  })
})

describe('M2-B：项目与侧边栏命令的接线', () => {
  it('四条命令各分派到自己的 hook', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    await registry.execute('project.openFolder')
    await registry.execute('project.addFolder')
    await registry.execute('project.closeFolder')
    await registry.execute('view.toggleSidebar')
    expect(hooks.openFolder).toHaveBeenCalledOnce()
    expect(hooks.addFolder).toHaveBeenCalledOnce()
    expect(hooks.closeFolder).toHaveBeenCalledOnce()
    expect(hooks.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('Mod+B 命中显示/隐藏侧边栏，且不与任何已有绑定互抢', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('b', { metaKey: true }))?.id).toBe('view.toggleSidebar')
    // 少一个 Cmd 就是普通字符输入，不该被命令接管
    expect(registry.findForKey(event('b'))).toBeNull()
  })

  it('三条 project.* 刻意不绑快捷键，但仍进注册表——命令面板要能调它们', () => {
    const { registry } = makeRegistry(fakeController(false))
    const listed = new Map(registry.list().map((c) => [c.id, c.keybindings]))
    expect(listed.get('project.openFolder')).toEqual([])
    expect(listed.get('project.addFolder')).toEqual([])
    expect(listed.get('project.closeFolder')).toEqual([])
    // ⛔ Mod+O 已经是「打开文件」，而 Mod+Shift+O 是 M2-F 那条 `project.openRecent` 的
    // （见下面那个 describe）。这条断言在 M2-B 时写的是「无人占用」，M2-F 把它兑掉了——
    // 留着这一半的意义是钉住「打开文件夹」自己没有顺手抢一个键
  })

  it('没有编辑器时四条照样执行成功——这正是它们不设 when 的全部理由', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 空窗口里最该能做的动作就是「打开一个文件夹」。要是这里返回 false，
    // 用户面对一个没有标签的窗口，命令面板里这几条会全是灰的，等于没有入口。
    expect(await registry.execute('project.openFolder')).toBe(true)
    expect(await registry.execute('project.addFolder')).toBe(true)
    expect(await registry.execute('project.closeFolder')).toBe(true)
    expect(await registry.execute('view.toggleSidebar')).toBe(true)
    expect(hooks.openFolder).toHaveBeenCalledOnce()
    expect(hooks.addFolder).toHaveBeenCalledOnce()
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

describe('M2-E：跳转浮层命令的接线', () => {
  it('两条各分派到自己的 hook，谁也不蹭谁', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('goto.file')).toBe(true)
    expect(hooks.gotoFile).toHaveBeenCalledOnce()
    expect(hooks.gotoSymbol).not.toHaveBeenCalled()

    expect(await registry.execute('goto.symbol')).toBe(true)
    expect(hooks.gotoSymbol).toHaveBeenCalledOnce()
    expect(hooks.gotoFile).toHaveBeenCalledOnce()
    // ⚠️ 上面那两条 `toHaveBeenCalledOnce` 是这一组里唯一能发现「谁把 gotoSymbol 接到
    // gotoFile 上」的断言：那样接的话 Mod+R 弹出的浮层里输入框是空的，用户看到的是文件列表
    // 而不是标题列表，而两条命令都返回 true，没有任何一处报错
  })

  it('Mod+P 与 Mod+R 各命中自己那条，少一个 Cmd 就是普通字符输入', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('p', { metaKey: true }))?.id).toBe('goto.file')
    expect(registry.findForKey(event('r', { metaKey: true }))?.id).toBe('goto.symbol')
    expect(registry.findForKey(event('p'))).toBeNull()
    expect(registry.findForKey(event('r'))).toBeNull()
    // 带 Shift 的两种组合都不该被 Mod+P / Mod+R 吃掉：matchesKeybinding 对 shift 是严格相等。
    // ⚠️ Mod+Shift+P 这条断言在 M2-E 时写的是「无人占用」，M3-B-1d 把它兑给了命令面板；
    // Mod+Shift+R 仍然空着并被钉住（见下面「M3-B-1」那个 describe）
    expect(registry.findForKey(event('P', { metaKey: true, shiftKey: true }))?.id).toBe('commandPalette.open')
    expect(registry.findForKey(event('R', { metaKey: true, shiftKey: true }))).toBeNull()
  })

  it('标题与分类：新开的「跳转」分类排在「视图」之后、「项目」之前', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.get('goto.file')?.title).toBe('跳转到文件…')
    expect(registry.get('goto.symbol')?.title).toBe('跳转到标题…')
    expect(registry.get('goto.file')?.category).toBe('跳转')
    expect(registry.get('goto.symbol')?.category).toBe('跳转')
    // 展示名分平台，注册表缺省 'macos'（registry.ts:90）；没有 shift，所以就是 ⌘ 加字母
    expect(registry.list().find((c) => c.id === 'goto.file')?.keybindings).toEqual(['⌘P'])
    expect(registry.list().find((c) => c.id === 'goto.symbol')?.keybindings).toEqual(['⌘R'])
  })

  it('没有编辑器时照样执行成功——空窗口里按 Mod+P 该看到浮层与「先打开一个文件夹」那句话', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 与 M2-B / M2-C / M2-D 那几条同一条理由：`when` 一律不设。
    // 浮层自己会说清楚缺什么，而快捷键按了没反应什么也说不清
    expect(await registry.execute('goto.file')).toBe(true)
    expect(hooks.gotoFile).toHaveBeenCalledOnce()
    expect(await registry.execute('goto.symbol')).toBe(true)
    expect(hooks.gotoSymbol).toHaveBeenCalledOnce()
  })

  it('⛔ 不注册跳行命令：Mod+Alt+G 仍然归 CM6 的 gotoLine 自己管', () => {
    const { registry } = makeRegistry(fakeController(false))
    // 跳行已经有两个入口了：CM6 原生那条（它自己弹一个输入框）与浮层里的 `:42`。
    // 再注册第三条等于给同一件事开第三扇门，而三扇门的 UI 各不相同。
    // 这条断言钉的是「注册表没有偷偷把 Mod+Alt+G 抢过来」——抢了的话 CM6 那个输入框
    // 就再也弹不出来（dispatch.ts 在捕获阶段 preventDefault + stopPropagation），
    // 而功能测试全绿，因为命令确实执行成功了
    expect(registry.findForKey(event('g', { metaKey: true, altKey: true }))).toBeNull()
    // 浮层里的 `:42` 不走命令，走 goto/store.ts 的查询解析，所以注册表里也没有对应 id
    expect(registry.list().map((c) => c.id)).not.toContain('goto.line')
  })
})

describe('M2-F：最近项目命令的接线', () => {
  it('project.openRecent 分派到自己的 hook，不蹭另外三条 project.*', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('project.openRecent')).toBe(true)
    expect(hooks.openRecentProject).toHaveBeenCalledOnce()
    // ⚠️ 这三条是这一组里唯一能发现「谁把 openRecent 接到 openFolder 上」的断言：
    // 那样接的话按 Mod+Shift+O 弹的是系统目录对话框，而不是浮层里那份最近清单，
    // 而命令照样返回 true，没有任何一处报错
    expect(hooks.openFolder).not.toHaveBeenCalled()
    expect(hooks.addFolder).not.toHaveBeenCalled()
    expect(hooks.closeFolder).not.toHaveBeenCalled()
  })

  it('Mod+Shift+O 命中它，而 Mod+O 仍然是「打开文件」', () => {
    const { registry } = makeRegistry(fakeController(false))
    // 与 Mod+S / Mod+Shift+S 同一套配对法：matchesKeybinding 对 shift 严格相等，
    // 所以「打开文件」不会被带 Shift 的这条吃掉
    expect(registry.findForKey(event('O', { metaKey: true, shiftKey: true }))?.id).toBe('project.openRecent')
    expect(registry.findForKey(event('o', { metaKey: true }))?.id).toBe('file.open')
    expect(registry.findForKey(event('o'))).toBeNull()
    expect(registry.findForKey(event('O', { shiftKey: true }))).toBeNull()
  })

  it('标题与分类：它换掉的是整棵树，所以归「项目」而不是「跳转」', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.get('project.openRecent')?.title).toBe('打开最近的项目…')
    expect(registry.get('project.openRecent')?.category).toBe('项目')
    // mods 的顺序由 MOD_ORDER 定，shift 在 meta 前，所以读作 ⇧⌘O
    expect(registry.list().find((c) => c.id === 'project.openRecent')?.keybindings).toEqual(['⇧⌘O'])
  })

  it('没有编辑器时照样执行成功，而且**不设 when**：一份空清单不是「此刻不适用」', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 与 M2-B / M2-C / M2-D / M2-E 那几条同一条理由。这里还多一层：第一次启动时
    // 最近清单必然是空的，而空清单是「还没攒出东西」——浮层会把这句话说出来
    // （见 goto/store.ts 的 footer），命令置灰则什么也说不清
    expect(await registry.execute('project.openRecent')).toBe(true)
    expect(hooks.openRecentProject).toHaveBeenCalledOnce()
    expect(registry.list().find((c) => c.id === 'project.openRecent')?.enabled).toBe(true)
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

describe('M3-A：Markdown 预览命令的接线', () => {
  it('view.togglePreview 分派到自己的 hook，不顺手带动侧边栏那一条', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('view.togglePreview')).toBe(true)
    expect(hooks.togglePreview).toHaveBeenCalledOnce()
    // 两个可见性是独立的：关掉一个不该顺手关掉另一个（见 BuiltinHooks.togglePreview）
    expect(hooks.toggleSidebar).not.toHaveBeenCalled()
  })

  it('Mod+Shift+V 命中它，而 Mod+V 仍然是空的', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('V', { metaKey: true, shiftKey: true }))?.id).toBe('view.togglePreview')
    // Mod+V 是系统粘贴。与 Mod+W / Ctrl+Space 同一条道理：系统级快捷键在事件到达
    // webview 之前就被吃掉了，绑在这儿收不到按键——所以这个键**必须**空着，
    // 而空着也意味着 `Mod+Shift+V` 与它不是「一对」，别照着 Mod+F / Mod+Shift+F
    // 那个形状去理解它
    expect(registry.findForKey(event('v', { metaKey: true }))).toBeNull()
  })

  it('没有编辑器时照样执行成功——面板自己会说「这块分屏里没有可预览的正文」', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 设 `when: ctx.editor !== null` 的话，快捷键按下去什么也不发生，用户得到的信息是零。
    // 不设 gate，面板出来并如实说一句，至少告诉了他「功能在，只是这里没有正文」
    expect(await registry.execute('view.togglePreview')).toBe(true)
    expect(hooks.togglePreview).toHaveBeenCalledOnce()
  })

  it('非 Markdown 文档也照样执行成功——命令层刻意不判语言', async () => {
    // 这里递一个带真 state 的假编辑器，证明 `run` 压根没读它：判语言是**面板**的事
    // （`previewHtml` 走 `languageFor`），命令层再判一遍就会有两份会各自漂移的真相
    const { registry, hooks } = makeRegistry(fakeEditorWithDoc('const x = 1').controller)
    expect(await registry.execute('view.togglePreview')).toBe(true)
    expect(hooks.togglePreview).toHaveBeenCalledOnce()
  })
})

describe('M3-A：大纲命令的接线', () => {
  it('view.toggleOutline 分派到自己的 hook，不顺手带动预览与侧边栏', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('view.toggleOutline')).toBe(true)
    expect(hooks.toggleOutline).toHaveBeenCalledOnce()
    // 三个可见性各自独立：大纲答「这份文档的结构」，预览答「渲染出来什么样」，
    // 侧边栏答「磁盘上有什么」。关掉一个不该顺手关掉另一个
    expect(hooks.togglePreview).not.toHaveBeenCalled()
    expect(hooks.toggleSidebar).not.toHaveBeenCalled()
  })

  it('Mod+Shift+M 命中它，而 Mod+M 仍然是空的', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('M', { metaKey: true, shiftKey: true }))?.id).toBe('view.toggleOutline')
    // ⚠️ 与预览那条 `Mod+V` 的理由**不同**：`Mod+M` 在 macOS 上是「最小化窗口」，
    // 由系统吃掉、压根到不了 webview，所以它空着不是本项目让出来的，而是本来就收不到。
    // 于是 `Mod+Shift+M` 与它不是「一对」，别照着 Mod+F / Mod+Shift+F 那个形状去理解
    expect(registry.findForKey(event('m', { metaKey: true }))).toBeNull()
  })

  it('没有编辑器时照样执行成功——面板自己会说「这块分屏里没有可列的标题」', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 与预览逐字同一条：设 `when: ctx.editor !== null` 的话快捷键按下去什么也不发生，
    // 用户得到的信息是零；不设 gate，面板出来并如实说一句
    expect(await registry.execute('view.toggleOutline')).toBe(true)
    expect(hooks.toggleOutline).toHaveBeenCalledOnce()
  })

  it('非 Markdown 文档也照样执行成功——命令层刻意不判语言', async () => {
    // 判语言是**面板**的事（`symbolTable` 走 `languageFor`），命令层再判一遍
    // 就会有两份会各自漂移的真相
    const { registry, hooks } = makeRegistry(fakeEditorWithDoc('const x = 1').controller)
    expect(await registry.execute('view.toggleOutline')).toBe(true)
    expect(hooks.toggleOutline).toHaveBeenCalledOnce()
  })
})

describe('M3-A-5：表格对齐命令的接线', () => {
  it('editor.alignTable 分派到自己的 hook', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('editor.alignTable')).toBe(true)
    expect(hooks.alignTable).toHaveBeenCalledOnce()
  })

  it('🔴 Mod+Shift+A 与 Alt+Shift+A 是两条命令，同一个物理键不互相吃', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('A', { metaKey: true, shiftKey: true }))?.id).toBe('editor.alignTable')
    // `Alt+Shift+A` 早在 M1-C-1 就给了「升序排序行」。真实 macOS 上按 Option+Shift+a
    // 浏览器给的 `key` 是 `Å` 而不是 `'a'`（所以这里必须用 `macOptionEvent`），
    // 而解析走的是 `code` 的物理键位——两条命令共用 `KeyA` 这一个物理键，靠修饰键分开
    expect(registry.findForKey(macOptionEvent('KeyA', 'Å', true))?.id).toBe('editor.sortLinesAsc')
    // ⚠️ Mod+Shift+T 这条断言在 M3-A-5 时写的是「刻意不占，留给 M3-B 的工具面板」，
    // 而 M3-B-1e 把它兑掉了——现在它是工具箱（见下面「M3-B-1」那个 describe）
    expect(registry.findForKey(event('T', { metaKey: true, shiftKey: true }))?.id).toBe('toolbox.open')
  })

  it('没有编辑器时照样执行成功——宿主会说「这块分屏里没有可对齐的表格」', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 与预览/大纲逐字同一条：设 `when: ctx.editor !== null` 的话快捷键按下去什么也不发生，
    // 用户得到的信息是零。而 M2-H 之后 `ctx.editor === null` 的意思已经是「聚焦的是一份
    // 只读大文件」，不是「没东西可对齐」——照旧设 gate 会让这条命令在那种标签上整个哑掉
    expect(await registry.execute('editor.alignTable')).toBe(true)
    expect(hooks.alignTable).toHaveBeenCalledOnce()
  })

  it('非 Markdown 文档也照样执行成功——命令层刻意不判语言', async () => {
    // 判语言在这儿是**多余**的：`.ts` 文档的语法树里压根没有 `Table` 节点，
    // `alignTableAt` 自己就回 `noTable`，宿主于是如实说「光标不在表格里」。
    // 命令层再判一遍就是两份会各自漂移的真相
    const { registry, hooks } = makeRegistry(fakeEditorWithDoc('const x = 1').controller)
    expect(await registry.execute('editor.alignTable')).toBe(true)
    expect(hooks.alignTable).toHaveBeenCalledOnce()
  })

  it('标题与分类', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.get('editor.alignTable')?.title).toBe('对齐当前表格')
    expect(registry.get('editor.alignTable')?.category).toBe('编辑器')
  })
})

describe('M3-A-6：字数统计与导出 HTML 的接线', () => {
  it('Mod+Shift+C → editor.wordCount，Mod+Shift+E → file.exportHtml', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('C', { metaKey: true, shiftKey: true }))?.id).toBe('editor.wordCount')
    expect(registry.findForKey(event('E', { metaKey: true, shiftKey: true }))?.id).toBe('file.exportHtml')
    // ⛔ Mod+Shift+W 刻意不占：macOS 上它是系统的「关闭所有窗口」，事件到不了 webview，
    // 与上面 `Mod+W`（合并分屏）不绑是同一条理由
    expect(registry.findForKey(event('W', { metaKey: true, shiftKey: true }))).toBeNull()
  })

  it('两条各分派到自己的 hook', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('editor.wordCount')).toBe(true)
    expect(hooks.wordCount).toHaveBeenCalledOnce()
    expect(hooks.exportHtml).not.toHaveBeenCalled()

    expect(await registry.execute('file.exportHtml')).toBe(true)
    expect(hooks.exportHtml).toHaveBeenCalledOnce()
    expect(hooks.wordCount).toHaveBeenCalledOnce()
  })

  it('🔴 导出的 Promise 会等到写盘结束才 resolve', async () => {
    // 这一条比 `file.save` 那条（上面「命令的 Promise 会等到 hook 的 IO 结束」）更要紧：
    // 导出要先弹系统对话框、再写盘，而「已导出到 …」那句话只能在**写完之后**才说。
    // 提前 resolve 的话宿主会在文件还没落地时就报成功——用户照着那个路径去找，什么都没有
    const { registry, hooks } = makeRegistry(fakeController(false))
    let settled = false
    hooks.exportHtml = vi.fn(async () => {
      await Promise.resolve()
      settled = true
    })
    await registry.execute('file.exportHtml')
    expect(settled).toBe(true)
  })

  it('没有编辑器时两条都照样执行成功——四种拒绝全归宿主说', async () => {
    const { registry, hooks } = makeRegistry(null)
    expect(await registry.execute('editor.wordCount')).toBe(true)
    expect(hooks.wordCount).toHaveBeenCalledOnce()
    expect(await registry.execute('file.exportHtml')).toBe(true)
    expect(hooks.exportHtml).toHaveBeenCalledOnce()
  })

  it('非 Markdown 文档也照样执行导出——命令层刻意不判语言', async () => {
    // 「这不是 Markdown」是宿主在 `previewHtml` 回 `unsupported` 之后说的（那里已经有语言信息，
    // 不必再判一遍），与大纲/对齐表格同一条：命令层判语言只会多一份会漂移的真相
    const { registry, hooks } = makeRegistry(fakeEditorWithDoc('const x = 1').controller)
    expect(await registry.execute('file.exportHtml')).toBe(true)
    expect(hooks.exportHtml).toHaveBeenCalledOnce()
  })

  it('标题与分类', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.get('editor.wordCount')?.title).toBe('统计字数')
    expect(registry.get('editor.wordCount')?.category).toBe('编辑器')
    // 标题末尾那个省略号是有意的：这条命令**会弹系统对话框**，与「另存为…」（`file.saveAs`）
    // 同一种标记。没有省略号的话用户在命令面板里看不出它要打断自己
    expect(registry.get('file.exportHtml')?.title).toBe('导出 HTML…')
    expect(registry.get('file.exportHtml')?.category).toBe('文件')
  })
})

describe('M3-B-1：工具箱与命令面板两个入口的接线', () => {
  it('两条各分派到自己的 hook，谁也不蹭谁', async () => {
    const { registry, hooks } = makeRegistry(fakeController(false))
    expect(await registry.execute('toolbox.open')).toBe(true)
    expect(hooks.openToolBox).toHaveBeenCalledOnce()
    expect(hooks.openCommandPalette).not.toHaveBeenCalled()

    expect(await registry.execute('commandPalette.open')).toBe(true)
    expect(hooks.openCommandPalette).toHaveBeenCalledOnce()
    expect(hooks.openToolBox).toHaveBeenCalledOnce()
    // ⚠️ 上面那两条 `toHaveBeenCalledOnce` 是这一组里唯一能发现「谁把 openToolBox 接到
    // openCommandPalette 上」的断言：那样接的话 Mod+Shift+T 弹出来的是命令面板，
    // 而两条命令都返回 true，没有任何一处报错（与 goto.file / goto.symbol 那组同一条）
  })

  it('Mod+Shift+T → 工具箱，Mod+Shift+P → 命令面板', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.findForKey(event('T', { metaKey: true, shiftKey: true }))?.id).toBe('toolbox.open')
    expect(registry.findForKey(event('P', { metaKey: true, shiftKey: true }))?.id).toBe('commandPalette.open')
    // 少一个 Shift 就是普通字符输入，两个键都不该被吃掉
    expect(registry.findForKey(event('t', { metaKey: true }))).toBeNull()
    expect(registry.findForKey(event('p', { metaKey: true }))?.id).toBe('goto.file')
  })

  it('⛔ Mod+Shift+R 仍然空着并被钉住', () => {
    const { registry } = makeRegistry(fakeController(false))
    // `Mod+Shift+*` 那一排已经不宽了：O 最近项目、V 预览、M 大纲、F 搜索、H 替换、
    // A 表格对齐、C 字数、E 导出、S 另存为、K 删行、G 查找上一个、L 全选相同内容、
    // Enter 替换下一个，加上这一次兑掉的 T 与 P。留着 R 是刻意的：
    // ⛔ 不要顺手拿它去绑单个工具，理由写在 `tools/registry.ts` 的文件头
    expect(registry.findForKey(event('R', { metaKey: true, shiftKey: true }))).toBeNull()
  })

  it('两条都不设 when：空窗口里按下去也照样执行成功', async () => {
    const { registry, hooks } = makeRegistry(null)
    // 与 goto.file / search.findInFiles 逐字同一条理由：浮层自己会说清楚缺什么，
    // 而快捷键按了没反应什么也说不清。⚠️ 工具箱里那个 `input: 'editor'` 的工具
    // 在空窗口里会如实说「现在没有打开的文档」，比一个灰掉的入口有用
    expect(await registry.execute('toolbox.open')).toBe(true)
    expect(hooks.openToolBox).toHaveBeenCalledOnce()
    expect(await registry.execute('commandPalette.open')).toBe(true)
    expect(hooks.openCommandPalette).toHaveBeenCalledOnce()
  })

  it('标题、分类与展示用的快捷键', () => {
    const { registry } = makeRegistry(fakeController(false))
    expect(registry.get('toolbox.open')?.title).toBe('工具箱…')
    expect(registry.get('toolbox.open')?.category).toBe('工具')
    expect(registry.get('commandPalette.open')?.title).toBe('命令面板…')
    expect(registry.get('commandPalette.open')?.category).toBe('视图')
    // 标题末尾那个省略号是有意的：两条都会**弹出一块浮层**并抢走焦点，
    // 与「另存为…」「导出 HTML…」同一种标记（见上面 M3-A-6 那组）
    expect(registry.list().find((c) => c.id === 'toolbox.open')?.keybindings).toEqual(['⇧⌘T'])
    expect(registry.list().find((c) => c.id === 'commandPalette.open')?.keybindings).toEqual(['⇧⌘P'])
  })

  it('🔴 命令面板自己也在清单里——于是那几条没有快捷键的命令终于有了入口', () => {
    const { registry } = makeRegistry(fakeController(false))
    const all = registry.list()
    const unbound = all.filter((c) => c.keybindings.length === 0)
    // 这一条钉的是 PLAN 第 77 行那笔 P0 欠账**被还掉了**：M1-A 只交了「命令面板的数据源」，
    // 而数据源本身没有入口。
    //
    // ⚠️ 钉的是**具体那几条**而不是数量。M3-B-1 之前的账是「二十几条没有快捷键」，量下来只有 7 条
    // （折叠/展开、选中全部匹配项、关闭分屏、项目那三条）——因为这个代码库一路都在给命令绑键，
    // 而那几条也各有别的入口（`foldKeymap`、面板按钮、侧栏）。所以面板补上的不是「够不着」，
    // 而是「一眼看全」：它是唯一一处能列出所有命令、并顺带告诉你每条绑在哪个键上的地方。
    // 钉数量的坏处是新加一条绑了键的命令就得改这条用例，而那与本条要证明的事无关
    expect(unbound.map((c) => c.id).sort()).toEqual([
      'editor.closePane',
      'editor.foldAll',
      'editor.selectAllMatches',
      'editor.unfoldAll',
      'project.addFolder',
      'project.closeFolder',
      'project.openFolder',
    ])
    expect(all.map((c) => c.id)).toContain('commandPalette.open')
  })
})
