// @vitest-environment jsdom
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '../commands/keybinding'
import { buildState, createViewConfig } from '../doc/tab'
import { languageFor } from '../editor/language'
import { clickAction, definitionAt } from '../goto/definition'
import { clickAddsCursor, type MouseButtonFields } from './multiCursor'
import { languageExtensions } from './setup'
import { definitionClick, isDefinitionClick, type ClickFields, type DefinitionClickHook } from './clickJump'

/**
 * `Cmd/Ctrl+Click` 跳定义。
 *
 * 环境要 jsdom：`definitionClick` 那一组用例**真的往 DOM 上派发 mousedown**，
 * 然后看选区变成了什么。这不是仪式感——整条设计押在三件事同时成立上：
 * 插件的 `domEventHandlers` 排在 CM6 内置处理器**前面**、返回 true 会让 CM6 不再跑它自己
 * 那个、返回 false 时它自己那个照旧跑并把光标加上。三条都是 `@codemirror/view@6.43.x`
 * 的实现细节而不是文档承诺（论证在 `clickJump.ts` 文件头），只有真的派发才能一次验住
 * 「接管了所以没多加光标」与「没接管所以光标照加」这两半。
 *
 * ⚠️ `defaultPrevented` 在这里**不是**判据：CM6 自己的 mousedown 处理器对普通单击也返回
 * true（要压掉浏览器原生的选区行为），所以接管与否那一项上两边都是 true。真正的判据是
 * **选区有没有多出来一段**。
 *
 * ⚠️ jsdom 没有真实排版，`posAtCoords` 对任何坐标都回 `0`。所以下面不校验「点第 n 个字符
 * 得到位置 n」——那是 `syntax.test.ts` 用纯 state 验的事。这里只校验两件事：
 * 钩子收到的位置与 CM6 落点**是同一个**（`ranges[0].from`），以及接管与否对选区的影响。
 */

let views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views = []
})

/**
 * 正文与初始光标：光标停在**第二个** `helper` 中间（pos 6），而 jsdom 把任何点击都换算成
 * pos 0。两者不同，于是「加了一个光标」在选区上看得见（多出来的一段在 0），
 * 「什么都没动」也看得见（还是那一段在 6）。
 */
const DOC = 'helper helper'
const CARET = 6

function ranges(view: EditorView): [number, number][] {
  return view.state.selection.ranges.map((r) => [r.from, r.to] as [number, number])
}

/** `vi.fn(() => true)` 会把 calls 推成 `[]`，索引取不到东西；签名写进泛型才有类型 */
type ClickSpy = ReturnType<typeof vi.fn<(view: EditorView, pos: number) => boolean>>

function spy(answer: boolean): ClickSpy {
  return vi.fn<(view: EditorView, pos: number) => boolean>(() => answer)
}

function makeView(hook: ClickSpy | null, doc = DOC): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: CARET, head: CARET },
      extensions: [EditorState.allowMultipleSelections.of(true), ...(hook ? [definitionClick(hook)] : [])],
    }),
    parent: document.body,
  })
  views.push(view)
  return view
}

/**
 * 派发一次真的 mousedown。
 *
 * ⚠️ 不带 `ctrlKey` 时这台环境里的默认加光标键就是它（jsdom 的 UA 是 `Mozilla/5.0 (darwin)
 * … jsdom/…`，`detectPlatform` 里 `/Mac|iPhone|iPad|iPod/` 与 `/Win/` 都不命中，于是算
 * 非 macOS、看 `ctrlKey`）。macOS 那条分支（看 `metaKey`）由下面那组纯函数用例覆盖，
 * 不在 DOM 里测——想测就得改 `navigator.userAgent`，那是给环境造假而不是给产品验货
 */
function click(
  view: EditorView,
  mods: Partial<Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {},
  options: { button?: number; detail?: number } = {},
): void {
  view.contentDOM.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
      button: options.button ?? 0,
      detail: options.detail ?? 1,
      ...mods,
    }),
  )
}

function mouse(fields: Partial<ClickFields> & { button?: number } = {}): ClickFields {
  return {
    button: 0,
    detail: 1,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...fields,
  }
}

describe('isDefinitionClick：哪一下算跳定义', () => {
  it('macOS 看 Cmd，其余平台看 Ctrl，两个都收是错的', () => {
    expect(isDefinitionClick(mouse({ metaKey: true }), 'macos')).toBe(true)
    expect(isDefinitionClick(mouse({ ctrlKey: true }), 'macos')).toBe(false)
    for (const platform of ['linux', 'windows'] as Platform[]) {
      expect(isDefinitionClick(mouse({ ctrlKey: true }), platform)).toBe(true)
      // Linux 上没有任何东西叫 Cmd，两个都收等于凭空多接管一次点击
      expect(isDefinitionClick(mouse({ metaKey: true }), platform)).toBe(false)
    }
  })

  it('不带修饰键的普通单击绝不接管，否则每点一下都在赌有没有定义', () => {
    for (const platform of ['macos', 'linux', 'windows'] as Platform[]) {
      expect(isDefinitionClick(mouse(), platform)).toBe(false)
    }
  })

  it('Alt 与 Shift 让位：那两位分别是「列块选择 / 加光标」与「扩展选区」', () => {
    expect(isDefinitionClick(mouse({ metaKey: true, altKey: true }), 'macos')).toBe(false)
    expect(isDefinitionClick(mouse({ metaKey: true, shiftKey: true }), 'macos')).toBe(false)
    expect(isDefinitionClick(mouse({ ctrlKey: true, altKey: true }), 'linux')).toBe(false)
    expect(isDefinitionClick(mouse({ ctrlKey: true, shiftKey: true }), 'linux')).toBe(false)
  })

  it('非主键不算，右键要留给上下文菜单、中键留给滚动', () => {
    for (const button of [1, 2]) {
      expect(isDefinitionClick(mouse({ ctrlKey: true, button }), 'linux')).toBe(false)
    }
  })

  it('连击不算：双击在选词、三击在选段，那一刻用户要的不是跳转', () => {
    for (const detail of [2, 3]) {
      expect(isDefinitionClick(mouse({ ctrlKey: true, detail }), 'linux')).toBe(false)
    }
  })

  it('不变式：与「加光标」唯一重叠的就是这一位，而重叠正是靠「查到才接管」解开的', () => {
    // 逐个修饰键组合枚举。Alt / Shift 那几位两边不可能同时为真；Cmd（非 mac 是 Ctrl）
    // 那一位**确实同时为真**——这就是 `multiCursor.ts` 手势表与 M5-2 的冲突点，
    // 而化解它的不是判定条件而是宿主的答案（查不到定义就回 false，那一下仍然加光标）
    for (const platform of ['macos', 'linux', 'windows'] as Platform[]) {
      for (const altKey of [false, true]) {
        for (const shiftKey of [false, true]) {
          for (const ctrlKey of [false, true]) {
            for (const metaKey of [false, true]) {
              const e = mouse({ altKey, shiftKey, ctrlKey, metaKey })
              const adds = clickAddsCursor({ ...e, detail: 1 } as MouseButtonFields, platform)
              if (isDefinitionClick(e, platform)) {
                expect(altKey || shiftKey).toBe(false)
                // ⚠️ 只要求那一位主修饰键在，**不**要求另一个不在：mac 上的 Cmd+Ctrl+单击
                // 与 Linux 上的 Ctrl+Cmd+单击都仍然算。这不是漏了排除，而是 `clickAddsCursor`
                // 对同一组合本来就答 true（它只看主修饰键与 Alt/Shift），两条规则得对齐
                expect(platform === 'macos' ? metaKey : ctrlKey).toBe(true)
                // 重叠只可能出现在这一位上，而这一位原本就是「加光标」
                expect(adds).toBe(true)
              }
            }
          }
        }
      }
    }
  })
})

describe('definitionClick：真的派发 mousedown', () => {
  it('查到定义时接管，选区一动不动——那一下没有变成两个光标', () => {
    const hook = spy(true)
    const view = makeView(hook)
    click(view, { ctrlKey: true })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(ranges(view)).toEqual([[CARET, CARET]])
  })

  it('递给钩子的是**收到事件的那个 view**，位置与 CM6 的落点同一个', () => {
    // 分屏之下「谁被点了」不能靠「当前活动标签」推（`paste.ts` 里那条时序竞态同理会跳错文档）。
    // 位置这一条钉的是「换算错了但恰好没崩」：钩子拿到的 pos 与 CM6 自己算出来的落点必须同源，
    // 否则接管与否用的是一套坐标、加光标用的是另一套
    const hook = spy(true)
    const view = makeView(hook)
    click(view, { ctrlKey: true })
    expect(hook.mock.calls[0]?.[0]).toBe(view)
    const unresolved = makeView(null)
    click(unresolved, { ctrlKey: true })
    expect(hook.mock.calls[0]?.[1]).toBe(unresolved.state.selection.ranges[0]!.from)
  })

  it('查不到定义时**不接管**，CM6 的加光标照旧——既有手势没被换掉', () => {
    const hook = spy(false)
    const view = makeView(hook)
    click(view, { ctrlKey: true })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(ranges(view)).toEqual([
      [0, 0],
      [CARET, CARET],
    ])
  })

  it('Alt+Click 与 Shift+Click 压根不问钩子，那两位仍是列块选择与扩展选区', () => {
    const asked = spy(true)
    click(makeView(asked), { ctrlKey: true, altKey: true })
    click(makeView(asked), { ctrlKey: true, shiftKey: true })
    expect(asked).not.toHaveBeenCalled()
  })

  it('双击与三击不问钩子：先让 CM6 把词和段选出来', () => {
    const hook = spy(true)
    const view = makeView(hook)
    click(view, { ctrlKey: true }, { detail: 2 })
    click(view, { ctrlKey: true }, { detail: 3 })
    expect(hook).not.toHaveBeenCalled()
    // 接管与否都没发生，所以选区还是 CM6 自己那套连击的结果，而不是**没动**
    expect(ranges(view)).not.toEqual([[CARET, CARET]])
  })

  it('中键不问钩子', () => {
    const hook = spy(true)
    makeView(hook)
    click(makeView(hook), { ctrlKey: true }, { button: 1 })
    expect(hook).not.toHaveBeenCalled()
  })

  it('不带修饰键的普通单击不问钩子，仍然只是把光标挪过去', () => {
    const hook = spy(true)
    const view = makeView(hook)
    click(view)
    expect(hook).not.toHaveBeenCalled()
    expect(ranges(view)).toEqual([[0, 0]])
  })

  it('没装这条扩展时 Ctrl+Click 的行为与从前一模一样', () => {
    // 宿主没给钩子就不装（`setup.ts`）。这条钉的是「不装 = 不改变任何既有行为」，
    // 而不是「不装 = 那儿挂着个什么都不做的处理器」
    const view = makeView(null)
    click(view, { ctrlKey: true })
    expect(ranges(view)).toEqual([
      [0, 0],
      [CARET, CARET],
    ])
  })
})

describe('整条链：真 TypeScript 语法树 + 从 workspace 那一层的入参出发', () => {
  /**
   * 上面那组只验「手势认不认、接不接管」，钩子是**替身**。这一组把 state 建在真链路上：
   * `createViewConfig` → `buildState` → `createEditorState` → `buildExtensions`，
   * 语言按 workspace 的 `syncLanguage` 那样异步加载完再 reconfigure 进槽位，
   * 然后真的派发一次 mousedown，用的是**真的 TypeScript 语法树**。
   *
   * 🔴 为什么必须有这一组：`clickDefinition` 这个选项要穿过 setup → tab → workspace
   * **三层**才到得了 view。中间任何一层漏传，上面那组用例**全绿**，而真窗口里点什么都没反应
   * ——「装了但没接上」正是这种形状，只有从最外面那层的入参出发才验得到。
   * 同理，这一组的 view 是 `buildExtensions` 装出来的**完整**扩展集（含 `mouseGestures`），
   * 所以「查不到定义时那一下仍然加光标」这条是在真配置下验的，不是在裸 state 上验的。
   *
   * ⚠️ jsdom 没有排版，任何坐标都换算成 pos 0，所以正文的**第一个词**就是被点的那个词，
   * 而光标先被挪到文末——否则「多加一个光标」与「光标本来就在 0」在选区上看不出差别
   * （同一个位置的两段会被并成一段）。也因此这里不校验「点第 n 个字符得到位置 n」，
   * 那要真排版，只能在真窗口里看。
   */
  const PATH = '/repo/a.ts'

  /**
   * 宿主那半截，与 `App.tsx` 的 `definitionFromClick` 同一条逻辑，差别只在落地那一步：
   * 「跳」用 dispatch 而不是 `controller.reveal`（后者自带 focus 与滚动，另有它自己的
   * 用例），「搜」记一笔而不是真的去起全局搜索（那是 `search/store.ts` 自己的用例）。
   *
   * 🔴 查询与分流都走 `goto/definition.ts` 里那**两个真函数**，⛔ 不在这里抄一份：
   * 抄出来的替身会把真逻辑里的错一起盖掉，那比没有这条用例更糟
   */
  function recordingHost(path: string, search: (word: string) => void, projectOpen = true) {
    return vi.fn<(view: EditorView, pos: number) => boolean>((view, pos) => {
      const action = clickAction(definitionAt(view.state, path, pos), projectOpen)
      if (action.kind === 'jump') {
        view.dispatch({ selection: { anchor: action.pos, head: action.pos } })
        return true
      }
      if (action.kind === 'search') {
        search(action.word)
        return true
      }
      return false
    })
  }

  async function mountChain(doc: string, hook: DefinitionClickHook): Promise<EditorView> {
    const choice = languageFor(PATH)
    const description = choice.description
    if (description === null) throw new Error(`用例写错了：${PATH} 在 language-data 里没有语法包`)
    const support = await description.load()
    if (support === null) throw new Error(`用例写错了：${PATH} 的语法包 load() 回了 null`)
    // 与 `createWorkspace` 逐字同一条：钩子从 options 走到 config 的第 6 个位置参数上
    const config = createViewConfig(false, () => [], undefined, true, undefined, hook)
    const languageSlot = new Compartment()
    const state = buildState(doc, config, languageSlot)
    const ready = state.update({
      effects: languageSlot.reconfigure(languageExtensions(choice, support)),
    }).state
    const view = new EditorView({ state: ready, parent: document.body })
    views.push(view)
    view.dispatch({ selection: { anchor: doc.length, head: doc.length } })
    return view
  }

  it('点一个类名：光标落到 `class` 声明上，而且那一下没有多加光标', async () => {
    const hook = recordingHost(PATH, () => {})
    const view = await mountChain('Greeter\n\nclass Greeter {\n  greet() { return 1 }\n}\n', hook)
    click(view, { ctrlKey: true })

    expect(hook.mock.results[0]?.value).toBe(true)
    // 落点写成「它前面那段正文」而不是偏移量：数出来的数字错了也看不出所以然
    expect(view.state.sliceDoc(0, view.state.selection.main.from)).toBe('Greeter\n\nclass ')
    expect(view.state.selection.ranges).toHaveLength(1)
  })

  it('点一个方法名：光标落到类体里那个方法声明上', async () => {
    const hook = recordingHost(PATH, () => {})
    const view = await mountChain('greet\n\nclass Greeter {\n  greet() { return 1 }\n}\n', hook)
    click(view, { ctrlKey: true })

    expect(hook.mock.results[0]?.value).toBe(true)
    expect(view.state.sliceDoc(0, view.state.selection.main.from)).toBe('greet\n\nclass Greeter {\n  ')
    expect(view.state.selection.ranges).toHaveLength(1)
  })

  it('点一个这份文件里没有声明的名字：接管这一下，改去项目里搜那个词', async () => {
    // 同文件查不到 ≠ 什么都不做：跨文件的符号正是「快速定位到对应的文件」要解决的，
    // 而那一条复用全局搜索（零常驻索引，口径见 `goto/definition.ts` 的 `clickAction`）
    const searched: string[] = []
    const hook = recordingHost(PATH, (word) => searched.push(word))
    const view = await mountChain('createWorkspace\n\nclass Greeter {}\n', hook)
    click(view, { ctrlKey: true })

    expect(searched).toEqual(['createWorkspace'])
    expect(hook.mock.results[0]?.value).toBe(true)
    // 接管了，所以那一下**没有**多加光标：搜索面板会抢走焦点，留在正文里的那个光标
    // 是用户没要求的东西
    expect(view.state.selection.ranges).toHaveLength(1)
  })

  it('没打开文件夹时查不到：不接管，那一下仍然是加光标', async () => {
    // 无处可搜。`search()` 在 roots 为空时只会把面板展开成一句「还没打开文件夹」，
    // 为一次点击弹这个是纯噪音——不如让这个手势位维持原样
    const searched: string[] = []
    const hook = recordingHost(PATH, (word) => searched.push(word), false)
    const view = await mountChain('createWorkspace\n\nclass Greeter {}\n', hook)
    click(view, { ctrlKey: true })

    expect(searched).toEqual([])
    expect(hook.mock.results[0]?.value).toBe(false)
    expect(view.state.selection.ranges).toHaveLength(2)
  })
})
