import { createRoot, createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorController } from '../editor/controller'
import { createCommandRegistry, type AppContext, type CommandDefinition, type CommandInfo } from './registry'
import { createCommandPalette, fuzzyScore, matchCommands, moveRow, rowOf, type CommandPalette } from './palette'

/**
 * 命令面板状态机的单测。
 *
 * 本文件钉三件在组件里钉不住的事：**模糊匹配到底匹不匹得上、谁排在前面**、
 * **同分时那个排序是码位不是 `localeCompare`**（CI 跑在 ubuntu 上，两者的 ICU 不一样）、
 * 以及 🔴 **`context` 是不是真的被订阅了**——那一条是 `App.tsx` 里那条 TODO 的验收测试：
 * `getContext` 是「被调用时求值」的，面板要的是「焦点一变，置灰就跟着变」，
 * 而它只有在 `context()` 被读在一个 memo 的追踪范围里才成立。
 *
 * 组件那一半（画什么、六个键落在哪儿、焦点抢不抢得回来）在 `./CommandPalette.test.tsx` 里。
 */

/** `AppContext.editor` 只被用来判空，所以一个空壳就够；真的 `EditorController` 要一块 CodeMirror */
const SOME_EDITOR = {} as EditorController

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function def(id: string, overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return { id, title: id, category: 'misc', run: () => {}, ...overrides }
}

function info(id: string, overrides: Partial<CommandInfo> = {}): CommandInfo {
  return { id, title: id, category: 'misc', enabled: true, keybindings: [], ...overrides }
}

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
})

describe('fuzzyScore', () => {
  it('空查询对任何文本都给 0 分', () => {
    expect(fuzzyScore('toggle', '')).toBe(0)
    expect(fuzzyScore('', '')).toBe(0)
  })

  it('不是子序列就返回 null', () => {
    expect(fuzzyScore('toggle', 'tx')).toBeNull()
    // 顺序也算：子序列不是子串，`ba` 在 `ab` 里找不到「先 b 后 a」的一条路
    expect(fuzzyScore('ab', 'ba')).toBeNull()
  })

  it('大小写无关', () => {
    expect(fuzzyScore('ToggleSidebar', 'tsb')).toBe(fuzzyScore('togglesidebar', 'TSB'))
  })

  it('连续命中比词首命中值钱，词首命中比词中命中值钱', () => {
    // 连着两个：'a' 6 分，'b' 紧随其后 6 分
    expect(fuzzyScore('ab', 'ab')).toBe(12)
    // 同一个字母，唯一区别是它前面那个字符算不算词边界
    expect(fuzzyScore('a-b', 'b')).toBe(4)
    expect(fuzzyScore('ab', 'b')).toBe(1)
  })

  it('⚠️ 第一个字符落在下标 0 时走的是「连续」那一支，不是「词首」那一支', () => {
    // `prev` 起手是 -1，于是 `at === prev + 1` 在 at=0 时也成立。
    // 那一条写在前面，所以首字母吃的是 6 分。钉住它是为了将来重排分支时不至于悄悄改掉分数
    expect(fuzzyScore('ab', 'a')).toBe(6)
    expect(fuzzyScore('a-b', 'a')).toBe(6)
  })

  it('词边界认得 . - _ / : 空格与全角括号', () => {
    for (const sep of [' ', '.', '-', '_', '/', ':', '(', ')', '（', '）', '·']) {
      expect(fuzzyScore(`a${sep}b`, 'b')).toBe(4)
    }
  })

  it('跳过的字符要扣分，所以连着的那一条排在散开的那一条前面', () => {
    expect(fuzzyScore('toggle', 'tg')).toBeLessThan(fuzzyScore('toggle', 'to') as number)
  })

  it('扣分封顶，于是一条长命令不会因为长就永远匹不过短的', () => {
    const capped = fuzzyScore(`a${'x'.repeat(12)}b`, 'ab') as number
    const longer = fuzzyScore(`a${'x'.repeat(40)}b`, 'ab') as number
    const justUnder = fuzzyScore(`a${'x'.repeat(11)}b`, 'ab') as number
    expect(longer).toBe(capped)
    expect(justUnder).toBe(capped + 1)
  })

  it('分数可以是负的，而负的照样算命中（只有 null 才是没匹上）', () => {
    const score = fuzzyScore(`a${'x'.repeat(30)}b`, 'ab') as number
    expect(score).toBeLessThan(0)
  })

  it('中日韩文字逐字匹配', () => {
    expect(fuzzyScore('切换自动换行', '换行')).not.toBeNull()
    expect(fuzzyScore('切换自动换行', '缩放')).toBeNull()
  })

  it('按码位遍历，代理对不会被劈成两半', () => {
    // `for...of` 走的是码位；写成 `query[i]` 的话 '😀' 会变成两个孤立代理项，分数就不是这个数了
    expect(fuzzyScore('😀😁😂', '😀😂')).toBe(4)
  })
})

describe('rowOf', () => {
  it('把注册表的口径转成画出来的口径', () => {
    expect(rowOf(info('editor.fold', { title: '折叠全部', category: 'editor', enabled: false }))).toEqual({
      id: 'editor.fold',
      title: '折叠全部',
      category: 'editor',
      keys: '',
      enabled: false,
    })
  })

  it('keys 是空格连起来的，一个绑定时没有空格', () => {
    expect(rowOf(info('a.b', { keybindings: ['⇧⌘P'] })).keys).toBe('⇧⌘P')
    expect(rowOf(info('a.b', { keybindings: ['⇧⌘P', 'Mod+X'] })).keys).toBe('⇧⌘P Mod+X')
  })
})

describe('matchCommands', () => {
  it('空查询原样返回，⛔ 不排序', () => {
    const commands = [info('z.last'), info('a.first'), info('m.mid')]
    expect(matchCommands(commands, '').map((row) => row.id)).toEqual(['z.last', 'a.first', 'm.mid'])
  })

  it('只有空格的查询也一样（trim 之后是空的）', () => {
    const commands = [info('z.last'), info('a.first')]
    expect(matchCommands(commands, '   ').map((row) => row.id)).toEqual(['z.last', 'a.first'])
    expect(matchCommands(commands, '\t\n').map((row) => row.id)).toEqual(['z.last', 'a.first'])
  })

  it('三个字段里任一个命中就算命中', () => {
    const commands = [
      info('editor.toggleLineWrap', { title: '切换自动换行', category: '编辑器' }),
      info('file.save', { title: '保存', category: '文件' }),
    ]
    expect(matchCommands(commands, '换行').map((r) => r.id)).toEqual(['editor.toggleLineWrap'])
    expect(matchCommands(commands, 'wrap').map((r) => r.id)).toEqual(['editor.toggleLineWrap'])
    expect(matchCommands(commands, '编辑器').map((r) => r.id)).toEqual(['editor.toggleLineWrap'])
  })

  it('一条都不命中就是空数组', () => {
    const commands = [info('file.save', { title: '保存', category: '文件' })]
    expect(matchCommands(commands, 'zzz')).toEqual([])
  })

  it('置灰的命令照样出现在结果里——`when` 挡的是执行，不是可见', () => {
    const commands = [info('editor.save', { enabled: false }), info('file.save')]
    const rows = matchCommands(commands, 'save')
    expect(rows.map((r) => r.id)).toEqual(['editor.save', 'file.save'])
    expect(rows[0]?.enabled).toBe(false)
  })

  it('分数高的排前面', () => {
    const commands = [
      info('a.b', { title: 'find open' }), // 'f' 词首，'o' 隔了四个字符且也在词首
      info('c.d', { title: 'format json' }), // 'fo' 连着
    ]
    expect(matchCommands(commands, 'fo').map((r) => r.title)).toEqual(['format json', 'find open'])
  })

  it('同分按标题的码位升序，⛔ 不是 localeCompare', () => {
    // 压 U+538B < 格 U+683C，所以码位序是「压 x」在前。
    // 🔴 而 ICU 的 `localeCompare` 走拼音，会给出「格 x」在前——CI 的 ubuntu 与本机的 macOS
    // 在这件事上不一致，所以整个代码库一律用 `<`/`>` 比码位（`registry.list()` 同一条）
    const commands = [info('a.b', { title: '格 x' }), info('c.d', { title: '压 x' })]
    expect(matchCommands(commands, 'x').map((r) => r.title)).toEqual(['压 x', '格 x'])
  })

  it('同分且同标题时保持原顺序（`Array.prototype.sort` 自 ES2019 起是稳定的）', () => {
    const commands = [info('z.z', { title: '同名' }), info('a.a', { title: '同名' })]
    expect(matchCommands(commands, '同名').map((r) => r.id)).toEqual(['z.z', 'a.a'])
  })
})

describe('moveRow', () => {
  it('total 不大于 0 时给 0', () => {
    expect(moveRow(0, 3, 1)).toBe(0)
    expect(moveRow(-5, 0, 1)).toBe(0)
  })

  it('两端都停住，⛔ 不绕回', () => {
    expect(moveRow(3, 0, -1)).toBe(0)
    expect(moveRow(3, 2, 1)).toBe(2)
    expect(moveRow(3, 2, 99)).toBe(2)
    expect(moveRow(3, 0, -99)).toBe(0)
  })

  it('中间正常走', () => {
    expect(moveRow(5, 1, 1)).toBe(2)
    expect(moveRow(5, 3, -2)).toBe(1)
    expect(moveRow(5, 2, 0)).toBe(2)
  })

  it('越界的 selected 先归一化，于是它不会把移动吞掉一次', () => {
    expect(moveRow(5, -3, 1)).toBe(1)
    expect(moveRow(5, 99, -1)).toBe(3)
  })
})

describe('createCommandPalette', () => {
  const [editor, setEditor] = createSignalHolder()

  /** `editor.*` 那一类命令的门槛：没有聚焦的编辑器就置灰 */
  const NEEDS_EDITOR = (ctx: AppContext) => ctx.editor !== null

  function makeRegistry(defs: readonly CommandDefinition[]) {
    const registry = createCommandRegistry({ getContext: () => ({ editor: editor() }) })
    for (const one of defs) registry.register(one)
    return registry
  }

  function mount(defs: readonly CommandDefinition[]): CommandPalette {
    const registry = makeRegistry(defs)
    let palette!: CommandPalette
    createRoot((teardown) => {
      dispose = teardown
      palette = createCommandPalette({ registry, context: () => ({ editor: editor() }) })
    })
    return palette
  }

  it('一开始是收着的，查询词是空的，选中在第 0 行', () => {
    const palette = mount([def('file.save')])
    expect(palette.visible()).toBe(false)
    expect(palette.query()).toBe('')
    expect(palette.selected()).toBe(0)
  })

  it('show 展开并把 focusRequest 加一——用计数不用布尔', () => {
    const palette = mount([def('file.save')])
    expect(palette.focusRequest()).toBe(0)
    palette.show()
    expect(palette.visible()).toBe(true)
    expect(palette.focusRequest()).toBe(1)
    // 🔴 浮层已经开着的时候再按一次 `Mod+Shift+P`：布尔值不变就抢不回焦点，计数才抢得回
    palette.show()
    expect(palette.focusRequest()).toBe(2)
  })

  it('show 把上一次的查询词与选中都清掉', () => {
    const palette = mount([def('file.save'), def('file.open')])
    palette.show()
    palette.setQuery('save')
    palette.select(0)
    expect(palette.query()).toBe('save')
    palette.show()
    expect(palette.query()).toBe('')
    expect(palette.selected()).toBe(0)
    expect(palette.rows()).toHaveLength(2)
  })

  it('hide 只收起，⛔ 不清查询词——那是 show 的事', () => {
    const palette = mount([def('file.save')])
    palette.show()
    palette.setQuery('save')
    palette.hide()
    expect(palette.visible()).toBe(false)
    expect(palette.query()).toBe('save')
  })

  it('setQuery 过滤并把选中归 0', () => {
    const palette = mount([def('a.one'), def('b.two')])
    palette.select(1)
    palette.setQuery('one')
    expect(palette.selected()).toBe(0)
    expect(palette.rows().map((r) => r.id)).toEqual(['a.one'])
    // 🔴 归 0 而不是保持下标：`rows` 换掉之后同一个下标指的是另一条命令
    palette.setQuery('')
    expect(palette.selected()).toBe(0)
  })

  it('total 是命令总数，不受查询词影响', () => {
    const palette = mount([def('a.one'), def('b.two'), def('c.three')])
    expect(palette.total()).toBe(3)
    palette.setQuery('one')
    expect(palette.rows()).toHaveLength(1)
    expect(palette.total()).toBe(3)
  })

  it('moveBy 在**过滤后**的行数里移动，两端停住', () => {
    const palette = mount([def('a.one'), def('b.two'), def('c.three')])
    palette.moveBy(1)
    expect(palette.selected()).toBe(1)
    palette.moveBy(9)
    expect(palette.selected()).toBe(2)
    palette.moveBy(-9)
    expect(palette.selected()).toBe(0)
    palette.setQuery('three')
    palette.moveBy(1)
    expect(palette.selected()).toBe(0)
  })

  it('commit 执行选中那一条', async () => {
    const run = vi.fn<(ctx: AppContext) => void>()
    const palette = mount([def('a.one'), def('b.two', { run })])
    palette.select(1)
    palette.commit()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('🔴 commit 先收起再执行：被执行的命令可能自己展开一块浮层', async () => {
    let visibleDuringRun: boolean | null = null
    const palette = mount([
      def('goto.file', {
        run: () => {
          visibleDuringRun = palette.visible()
        },
      }),
    ])
    palette.show()
    palette.commit()
    await flush()
    // 顺序反过来的话，那一条命令展开的浮层会被这次收起盖掉
    expect(visibleDuringRun).toBe(false)
  })

  it('一条都没匹配上时 commit 是 no-op，⛔ 不抛', async () => {
    const palette = mount([def('a.one')])
    palette.setQuery('zzz')
    expect(() => palette.commit()).not.toThrow()
    await flush()
    expect(palette.visible()).toBe(false)
  })

  it('选中那一条被置灰时照样调 execute，而 execute 自己返回 false', async () => {
    const run = vi.fn<(ctx: AppContext) => void>()
    const palette = mount([def('editor.save', { run, when: NEEDS_EDITOR })])
    expect(palette.rows()[0]?.enabled).toBe(false)
    palette.commit()
    await flush()
    expect(run).not.toHaveBeenCalled()
  })

  it('没有 when 的命令永远是 enabled', () => {
    const palette = mount([def('file.save')])
    expect(palette.rows()[0]?.enabled).toBe(true)
  })

  it('🔴 context 是被**订阅**的：焦点一变，置灰就跟着变', () => {
    const palette = mount([def('editor.save', { when: NEEDS_EDITOR }), def('file.save')])
    expect(palette.rows().map((r) => r.enabled)).toEqual([false, true])
    setEditor(SOME_EDITOR)
    expect(palette.rows().map((r) => r.enabled)).toEqual([true, true])
    setEditor(null)
    expect(palette.rows().map((r) => r.enabled)).toEqual([false, true])
  })

  it('🔴 于是焦点一变，置灰的那一条立刻能执行了', async () => {
    const run = vi.fn<(ctx: AppContext) => void>()
    const palette = mount([def('editor.save', { run, when: NEEDS_EDITOR })])
    palette.commit()
    await flush()
    expect(run).not.toHaveBeenCalled()
    setEditor(SOME_EDITOR)
    palette.commit()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rows 按注册表的顺序（category → id）', () => {
    const palette = mount([def('z.zulu', { category: 'b' }), def('a.alpha', { category: 'a' })])
    expect(palette.rows().map((r) => r.id)).toEqual(['a.alpha', 'z.zulu'])
  })

  it('🔴 show 重新抓一遍清单：面板建好之后才注册的命令也看得见', () => {
    // `createMemo` 是**急切求值**的，而 App 是在组件体里建面板、在 `onMount` 里才注册
    // 那四十来条内置命令的。少了 `show()` 里那一格 `generation`，面板记住的就是
    // 「建它那一刻」的清单，而且永远不会自己更新——症状是浮层里空空如也
    const registry = makeRegistry([def('a.early')])
    let panel!: CommandPalette
    createRoot((teardown) => {
      dispose = teardown
      panel = createCommandPalette({ registry, context: () => ({ editor: editor() }) })
    })
    expect(panel.rows().map((r) => r.id)).toEqual(['a.early'])
    registry.register(def('b.late'))
    // ⚠️ 注册表没有「命令变了」这个通知，所以这一刻面板还是旧的
    expect(panel.rows().map((r) => r.id)).toEqual(['a.early'])
    panel.show()
    expect(panel.rows().map((r) => r.id)).toEqual(['a.early', 'b.late'])
    expect(panel.total()).toBe(2)
  })

  describe('footer', () => {
    it('没有查询词时只报总数', () => {
      const palette = mount([def('a.one'), def('b.two')])
      expect(palette.footer()).toBe('共 2 条命令')
    })

    it('一条都没匹配上时把查询词说出来', () => {
      const palette = mount([def('a.one')])
      palette.setQuery('  zzz  ')
      expect(palette.footer()).toBe('没有匹配「zzz」的命令')
    })

    it('匹配上时报「命中 / 总数」', () => {
      const palette = mount([def('a.one'), def('b.two'), def('c.three')])
      palette.setQuery('o')
      expect(palette.footer()).toMatch(/^\d+ \/ 共 3 条命令$/)
      expect(palette.rows().length).toBeGreaterThan(0)
    })
  })
})

/**
 * 一个可以跨用例复用的 `editor` signal。
 *
 * ⚠️ 建在 `createRoot` **外面**：signal 不需要 root，而如果建在里面，
 * 用例结束时 root 一 dispose，下一个用例拿到的就是一个已经断开的 setter
 */
function createSignalHolder() {
  const [editor, setEditor] = createSignal<EditorController | null>(null)
  return [editor, setEditor] as const
}
