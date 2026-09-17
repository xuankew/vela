// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * workspace 的单测：标签之间怎么调度。
 *
 * **假的是 IPC、原生对话框，以及子语言懒加载的时机**（前两个：jsdom 里没有 Tauri 运行时）。
 * 那一块可见编辑区用的是真的 `EditorController`：`onUpdate` 是 view 插件，只有真 view 会触发它，
 * 拿替身的话「输入 → 度量 → 脏标记」这条链就全是假象。
 *
 * 懒加载闸门默认**关着**，走真的动态 import。只有「加载回来时语言已经换过了」那条用例把它闸住：
 * 晚到的结果什么时候落地由 import 决定，不闸住的话那条用例就是掷硬币——过与不过都说明不了什么。
 */

const { ipc, dialog, lazyLoad } = vi.hoisted(() => ({
  ipc: {
    openFile: vi.fn(),
    saveFile: vi.fn(),
    describeFsError: (err: unknown) => `模拟错误：${JSON.stringify(err)}`,
    ENCODING_LABELS: { utf8: 'UTF-8', utf16_le: 'UTF-16 LE', utf16_be: 'UTF-16 BE', gbk: 'GBK' },
  },
  dialog: { open: vi.fn(), save: vi.fn() },
  lazyLoad: { held: false, parked: [] as (() => void)[], landings: [] as (LanguageSupport | null)[] },
}))

vi.mock('../ipc/fs', () => ipc)
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
vi.mock('../editor/language', async (importOriginal) => {
  const real = await importOriginal<typeof import('../editor/language')>()
  return {
    ...real,
    loadSupport: (choice: LanguageChoice) =>
      lazyLoad.held
        ? new Promise<LanguageSupport | null>((resolve) => {
            lazyLoad.parked.push(
              () =>
                void real.loadSupport(choice).then((support) => {
                  // 记一笔「晚到的结果真的落地了」：断言的是「落地了却没被采用」，
                  // 没这一笔就只能靠 sleep 猜，猜短了用例就是空跑
                  lazyLoad.landings.push(support)
                  resolve(support)
                }),
            )
          })
        : real.loadSupport(choice),
  }
})

import { EditorSelection, type EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { indentUnit, language, type LanguageSupport } from '@codemirror/language'
import { EditorController } from '../editor/controller'
import type { LanguageChoice } from '../editor/language'
import { codeFontBySyntax, indentLabel, lineWrapEnabled } from '../editor/setup'
import { completeWords, wordPeers } from '../editor/wordSource'
import type { TextFile, WriteReport } from '../ipc/fs'
import { MAX_SESSION_TABS, SESSION_VERSION, type Session, type SessionTab } from '../ipc/session'
import { tabText } from './tab'
import {
  createWorkspace,
  MAX_PANES,
  type DiscardDecision,
  type DiscardPrompt,
  type SplitDirection,
  type Workspace,
} from './workspace'

function textFile(overrides: Partial<TextFile> = {}): TextFile {
  return {
    text: '正文',
    format: { encoding: 'utf8', bom: false, eol: 'lf' },
    lossy: false,
    bytes: 6,
    ...overrides,
  }
}

const OK_REPORT: WriteReport = { bytesWritten: 6, unmappable: false }

/**
 * state 上真正装着的语言：`markdown` / `json` / …，没挂语言（纯文本）时是 null。
 *
 * 读 facet 而不是读 `tab.language`：后者是模型的自述，装没装进 state 是另一回事。
 * M1-E-1 之前没有任何一条用例验证过这一步，整个特性其实是没人看着的。
 */
function languageName(state: EditorState): string | null {
  return state.facet(language)?.name ?? null
}

/**
 * 在文档末尾请求一次词补全，返回候选的文字。
 *
 * 光标放在末尾是因为 `mounted()` 的 `type()` 就是这么落光标的；`explicit` 默认关，
 * 于是走的是「至少打满两个字符」那条自动触发的路径。
 */
function completionLabels(state: EditorState, explicit = false): string[] {
  const result = completeWords(new CompletionContext(state, state.doc.length, explicit))
  return result?.options.map((o) => o.label) ?? []
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 子语言靠动态 import 落地，什么时候回来不由测试决定，只能轮询 */
async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !pred(); i++) await sleep(5)
  if (!pred()) throw new Error(`等了 2 秒还没等到：${what}`)
}

/** 闸住子语言加载：之后的 loadSupport 停在门口，等 `releaseSupportLoads` 放行 */
function holdSupportLoads() {
  lazyLoad.held = true
}

function releaseSupportLoads() {
  lazyLoad.held = false
  for (const go of lazyLoad.parked.splice(0)) go()
}

/** 建过的真编辑器，测试结束后统一 destroy。不叫 panes：那是 workspace 里「分屏」的名字 */
const liveEditors: { controller: EditorController; host: HTMLElement }[] = []

/**
 * 一块分屏的夹具。
 *
 * 分屏测试必须挂**真的** controller：`setLineWrap` 要 dispatch 到每块分屏的 view、
 * `detach` 要趁 view 还活着 capture 现场，拿替身这两条都验不出来。
 */
interface PaneFixture {
  readonly id: number
  readonly controller: EditorController
  readonly text: string
  type(text: string): void
}

/** 建一个 workspace 并把真的编辑区挂上去 */
function mounted(options: { lineWrap?: boolean; promptDiscard?: DiscardPrompt } = {}) {
  const ws = createWorkspace({
    lineWrap: options.lineWrap,
    // 默认答「不保存」：本文件里绝大多数用例测的是调度，不是确认流程。
    // 确认流程在「关闭确认」那个 describe 里逐个决策地测。
    promptDiscard: options.promptDiscard ?? (async () => 'discard'),
  })

  function spawn(paneId: number, state: EditorState): EditorController {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = new EditorController(host, state)
    liveEditors.push({ controller, host })
    ws.attach(paneId, controller)
    return controller
  }

  const controller = spawn(ws.panes()[0]!.id, ws.activeTab().snapshot.state)
  return {
    ws,
    controller,
    get doc() {
      return controller.doc
    },
    get state() {
      return controller.view.state
    },
    get scrollTop() {
      return controller.view.scrollDOM.scrollTop
    },
    type(text: string) {
      const at = controller.view.state.doc.length
      // 带上 selection：真实敲字会把光标落在插入的文本之后，只发 changes 的话光标停在 0，
      // 「光标位置跟着标签走」这条就没得测了
      controller.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
    },
    setScroll(top: number, left = 0) {
      controller.view.scrollDOM.scrollTop = top
      controller.view.scrollDOM.scrollLeft = left
    },
    /** 加一块分屏并给它挂上真编辑器。已到 `MAX_PANES` 时 `split` 只改方向，这里会抛 */
    splitPane(direction: SplitDirection = 'row'): PaneFixture {
      const before = new Set(ws.panes().map((p) => p.id))
      ws.split(direction)
      const fresh = ws.panes().find((p) => !before.has(p.id))
      if (!fresh) throw new Error('分屏数已到上限，没有新分屏可挂')
      const next = spawn(fresh.id, ws.tabs().find((t) => t.id === fresh.tabId())!.snapshot.state)
      return {
        id: fresh.id,
        controller: next,
        get text() {
          return next.doc
        },
        type(text: string) {
          const at = next.view.state.doc.length
          next.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
        },
      }
    },
  }
}

beforeEach(() => {
  ipc.openFile.mockReset()
  ipc.saveFile.mockReset()
  dialog.open.mockReset()
  dialog.save.mockReset()
  ipc.openFile.mockResolvedValue(textFile())
  ipc.saveFile.mockResolvedValue(OK_REPORT)
  // 闸门是模块级的，不复位的话某条用例闸住了会一路漏到后面的用例里
  lazyLoad.held = false
  lazyLoad.parked.length = 0
  lazyLoad.landings.length = 0
})

afterEach(() => {
  for (const { controller, host } of liveEditors.splice(0)) {
    controller.destroy()
    host.remove()
  }
})

describe('起始状态', () => {
  it('一上来就有一个空标签，activeTab 永远有值', () => {
    const ws = createWorkspace()
    expect(ws.tabs()).toHaveLength(1)
    expect(ws.activeTab()).toBe(ws.tabs()[0])
    expect(ws.activeIndex()).toBe(0)
    expect(ws.activeTab().doc.name()).toBe('空文档')
  })

  it('度量报的是空文档：1 行 0 字符（CM6 把空文档算作一行空行）', () => {
    const ws = createWorkspace()
    // 本文件里的度量断言一律 toMatchObject：这些用例要验的是行数与字符数，
    // 而 DocMetrics 还带着行列/选区/缩进（状态栏要的），用 toEqual 的话每加一个字段
    // 就得改十几处断言，改的人只会照抄实际值，断言就退化成「快照」了
    expect(ws.metrics()).toMatchObject({ lines: 1, chars: 0 })
  })

  it('换行偏好取自构造参数，并且真的落进了 state', () => {
    expect(lineWrapEnabled(createWorkspace({ lineWrap: true }).activeTab().snapshot.state)).toBe(true)
    expect(lineWrapEnabled(createWorkspace({ lineWrap: false }).activeTab().snapshot.state)).toBe(false)
  })
})

describe('newTab / activateTab：现场存取', () => {
  it('新建标签会激活它，原来那份正文留在自己的 snapshot 里', () => {
    const pane = mounted()
    pane.type('第一份')

    const second = pane.ws.newTab()

    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.activeTab()).toBe(second)
    expect(pane.doc).toBe('')
    expect(tabText(pane.ws.tabs()[0]!)).toBe('第一份')
  })

  it('来回切换：正文、光标位置、滚动位置各自跟着自己的标签走', () => {
    const pane = mounted()
    pane.type('AAA')
    pane.setScroll(120, 5)
    const first = pane.ws.activeTab()

    const second = pane.ws.newTab()
    pane.type('BBBBB')
    pane.setScroll(40)

    pane.ws.activateTab(first.id)
    expect(pane.doc).toBe('AAA')
    expect(pane.scrollTop).toBe(120)
    expect(pane.state.selection.main.head).toBe(3)

    pane.ws.activateTab(second.id)
    expect(pane.doc).toBe('BBBBB')
    expect(pane.scrollTop).toBe(40)
    expect(pane.state.selection.main.head).toBe(5)
  })

  it('激活已经活动的标签不做任何事（不白重建一次视图）', () => {
    const pane = mounted()
    const before = pane.state
    pane.ws.activateTab(pane.ws.activeTab().id)
    expect(pane.state).toBe(before)
  })

  it('激活一个不存在的 id 是安全的空操作', () => {
    const pane = mounted()
    const before = pane.state
    pane.ws.activateTab(9999)
    expect(pane.state).toBe(before)
    expect(pane.ws.tabs()).toHaveLength(1)
  })
})

describe('closeTab', () => {
  it('关掉非活动标签：列表少一个，显示的东西不变', async () => {
    const pane = mounted()
    const second = pane.ws.newTab()
    pane.type('留在屏幕上')
    const before = pane.state

    await pane.ws.closeTab(pane.ws.tabs()[0]!.id)

    expect(pane.ws.tabs()).toEqual([second])
    expect(pane.ws.activeTab()).toBe(second)
    expect(pane.state).toBe(before)
  })

  it('关掉活动标签：激活右邻居', async () => {
    const pane = mounted()
    const a = pane.ws.tabs()[0]!
    const b = pane.ws.newTab()
    const c = pane.ws.newTab()
    pane.ws.activateTab(b.id)
    pane.type('B 的正文')

    await pane.ws.closeTab(b.id)

    expect(pane.ws.tabs().map((t) => t.id)).toEqual([a.id, c.id])
    expect(pane.ws.activeTab()).toBe(c)
    expect(pane.doc).toBe('')
  })

  it('关掉末尾的活动标签：退回新的末尾', async () => {
    const pane = mounted()
    const a = pane.ws.tabs()[0]!
    const b = pane.ws.newTab()
    pane.type('B 的正文')

    await pane.ws.closeTab(b.id)

    expect(pane.ws.tabs().map((t) => t.id)).toEqual([a.id])
    expect(pane.ws.activeTab()).toBe(a)
    expect(pane.doc).toBe('')
  })

  it('关掉最后一个标签会补一个空标签进来——tabs 永远非空', async () => {
    // 允许「零标签」的话所有 editor.* 命令的 when 会同时失效、状态栏没有可显示的对象、
    // activeTab() 变成 nullable 并传染给每一个调用点
    const pane = mounted()
    pane.type('要被关掉的')
    const doomed = pane.ws.activeTab()

    await pane.ws.closeTab(doomed.id)

    expect(pane.ws.tabs()).toHaveLength(1)
    expect(pane.ws.activeTab().id).not.toBe(doomed.id)
    expect(pane.doc).toBe('')
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 0 })
  })

  it('关掉一个不存在的 id 是安全的空操作', async () => {
    const pane = mounted()
    await pane.ws.closeTab(4242)
    expect(pane.ws.tabs()).toHaveLength(1)
  })
})

describe('reorder（拖拽重排）', () => {
  it('往右拖：dragged 落到 target 后面', () => {
    const ws = createWorkspace()
    const a = ws.tabs()[0]!
    const b = ws.newTab()
    const c = ws.newTab()

    ws.reorder(a.id, c.id)

    expect(ws.tabs().map((t) => t.id)).toEqual([b.id, c.id, a.id])
  })

  it('往左拖：dragged 落到 target 前面', () => {
    const ws = createWorkspace()
    const a = ws.tabs()[0]!
    const b = ws.newTab()
    const c = ws.newTab()

    ws.reorder(c.id, a.id)

    expect(ws.tabs().map((t) => t.id)).toEqual([c.id, a.id, b.id])
  })

  it('拖到自己身上、或拖一个不存在的 id，都不改顺序', () => {
    const ws = createWorkspace()
    const b = ws.newTab()
    const before = ws.tabs()

    ws.reorder(b.id, b.id)
    ws.reorder(9999, b.id)
    ws.reorder(b.id, 9999)

    expect(ws.tabs()).toEqual(before)
  })

  it('重排不改变活动标签', () => {
    const pane = mounted()
    pane.ws.newTab()
    const active = pane.ws.activeTab()
    pane.ws.reorder(pane.ws.tabs()[0]!.id, active.id)
    expect(pane.ws.activeTab()).toBe(active)
  })
})

describe('openAt：文件落到哪个标签', () => {
  it('干净的无名活动标签就地复用，不新增标签', async () => {
    const pane = mounted()
    const before = pane.ws.activeTab()

    await pane.ws.openAt('/a.txt')

    expect(pane.ws.tabs()).toHaveLength(1)
    expect(pane.ws.activeTab()).toBe(before)
    expect(before.doc.path()).toBe('/a.txt')
    expect(pane.doc).toBe('正文')
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 2 })
  })

  it('活动标签已经脏了就新建一个，不动用户手上的东西', async () => {
    const pane = mounted()
    pane.type('手稿')
    const draft = pane.ws.activeTab()

    await pane.ws.openAt('/a.txt')

    expect(pane.ws.tabs()).toHaveLength(2)
    expect(tabText(draft)).toBe('手稿')
    expect(pane.ws.activeTab().doc.path()).toBe('/a.txt')
    expect(pane.doc).toBe('正文')
  })

  it('活动标签已经有别的路径时也新建一个', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    await pane.ws.openAt('/b.txt')
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.tabs().map((t) => t.doc.path())).toEqual(['/a.txt', '/b.txt'])
  })

  it('同一个文件只开一个标签：第二次只激活，不重读', async () => {
    // 再读一次不但会丢掉已有的未保存改动，还会让用户在两份内容里猜哪份是真的
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    pane.type('改过了')
    const opened = pane.ws.activeTab()
    pane.ws.newTab()

    await pane.ws.openAt('/a.txt')

    expect(ipc.openFile).toHaveBeenCalledTimes(1)
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.activeTab()).toBe(opened)
    expect(pane.doc).toBe('正文改过了')
    expect(opened.doc.dirty()).toBe(true)
  })

  it('读取失败时报错落在被打开的那个标签上，原文完好', async () => {
    const pane = mounted()
    pane.type('手稿')
    ipc.openFile.mockRejectedValue({ kind: 'too_large', bytes: 5_000_000, limit: 4_194_304 })

    await pane.ws.openAt('/huge.log')

    // 新标签是空的，错误提示在它身上；手稿在它自己那个标签里完好无损
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.activeTab().doc.notice()?.level).toBe('error')
    expect(pane.doc).toBe('')
    expect(tabText(pane.ws.tabs()[0]!)).toBe('手稿')
  })
})

/**
 * 语言落到 state 里的证据链。
 *
 * 这一组之前是**完全没人看着的**：`language.test.ts` 只验「路径算出哪个语言」，
 * 装配那一步（syncLanguage → Compartment → state）一条断言都没有，345 个用例全绿也
 * 说明不了语法高亮是不是真的在工作。
 */
describe('M1-E-1：语言按扩展名分派', () => {
  it('新标签没有路径 → Markdown（M1-E 之前全局 markdownMode = true 就是这个行为）', () => {
    const pane = mounted()

    expect(languageName(pane.state)).toBe('markdown')
    expect(pane.ws.activeTab().language?.label).toBe('Markdown')
    // 代码块与表格换等宽字体靠的是这个装饰插件，它要读语法树，只在 Markdown 下挂
    expect(pane.controller.view.plugin(codeFontBySyntax)).not.toBe(null)
  })

  it('没匹配上的扩展名不挂语言：日志不再被当成 Markdown 解析', async () => {
    // M1-E 之前 markdownMode 是全局且默认开的，于是 .json / .ts / .log 一律按 Markdown
    // 解析、一律用正文字体。这条钉住那个行为已经没了
    const pane = mounted()

    await pane.ws.openAt('/var/app.log')

    expect(languageName(pane.state)).toBe(null)
    expect(pane.ws.activeTab().language).toMatchObject({ kind: 'plain', label: '纯文本' })
    expect(pane.controller.view.plugin(codeFontBySyntax)).toBe(null)
  })

  it('代码语言的语法树是懒加载的：同步就知道是哪种语言，树随后补上', async () => {
    const pane = mounted()

    await pane.ws.openAt('/out/pkg.json')

    // 标签与字体分区同步就位（状态栏不必等 import），语法树等动态 import 落地后补
    expect(pane.ws.activeTab().language).toMatchObject({ kind: 'code', label: 'JSON' })
    await waitFor(() => languageName(pane.state) === 'json', 'json 子语言落地')
  })

  it('语言是标签自己的属性：改一个标签不波及另一个', async () => {
    const pane = mounted()
    await pane.ws.openAt('/notes.md')
    const mdTab = pane.ws.activeTab()
    await pane.ws.openAt('/var/app.log') // 活动标签已有路径 → 落到新标签上
    const logTab = pane.ws.activeTab()
    expect(logTab).not.toBe(mdTab)

    // 显示中的读 view.state，没显示的读它自己那份 snapshot
    expect(languageName(pane.state)).toBe(null)
    expect(languageName(mdTab.snapshot.state)).toBe('markdown')

    pane.ws.activateTab(mdTab.id)
    expect(languageName(pane.state)).toBe('markdown')
    expect(languageName(logTab.snapshot.state)).toBe(null)
  })

  it('两块分屏各显示一个标签时，语言互不干扰', async () => {
    const pane = mounted()
    await pane.ws.openAt('/notes.md')
    const mdTab = pane.ws.activeTab()

    const right = pane.splitPane()
    await pane.ws.openAt('/var/app.log')

    expect(languageName(pane.state)).toBe('markdown')
    expect(languageName(right.controller.view.state)).toBe(null)
    expect(mdTab.doc.path()).toBe('/notes.md')
  })

  it('另存为换了扩展名 → 语言跟着换', async () => {
    const pane = mounted()
    expect(languageName(pane.state)).toBe('markdown')
    dialog.save.mockResolvedValue('/out/pkg.json')

    await pane.ws.saveAs()

    expect(pane.ws.activeTab().doc.path()).toBe('/out/pkg.json')
    await waitFor(() => languageName(pane.state) === 'json', 'json 子语言落地')
  })

  it('加载回来时语言已经换过了：晚到的结果被丢掉', async () => {
    // 不丢的话，快速连开两个文件会让前一个文件的语法树盖到后一个上，且不报错
    holdSupportLoads()
    const pane = mounted()
    dialog.save.mockResolvedValue('/out/pkg.json')
    // 不 await：json 的加载得停在门口，才能在它落地之前把语言换成 Markdown
    const pending = pane.ws.saveAs()
    dialog.save.mockResolvedValue('/out/notes.md')
    await pane.ws.saveAs()
    await pending
    expect(languageName(pane.state)).toBe('markdown')

    releaseSupportLoads()
    await waitFor(() => lazyLoad.landings.length > 0, 'json 子语言落地')
    // 落地的是**能用的** json 语法，不是 null：否则「没被采用」就没有意义
    expect(lazyLoad.landings[0]?.language.name).toBe('json')

    expect(languageName(pane.state)).toBe('markdown')
    expect(pane.ws.activeTab().language?.label).toBe('Markdown')
  })
})

describe('M1-E-3：词补全跨标签', () => {
  /**
   * PLAN.md §2 那句「项目词典」在 M1 的落地形态是**所有打开的标签**（文件树是 M2 的事）。
   * 这组用例走的是 workspace 真的注入给 `createViewConfig` 的那个 `liveStates`，
   * 不是单测里手搓的 peers 闭包——wordSource.test.ts 已经单独钉过词源本身了。
   */
  it('别的标签里的词也能补出来', () => {
    const pane = mounted()
    pane.type('zephyr')
    // 注入的 getter 就一个：liveStates。少了它补全退化成只有当前文档，且不会报错
    expect(pane.state.facet(wordPeers)).toHaveLength(1)

    const right = pane.splitPane()
    right.type(' ze')

    expect(completionLabels(right.controller.view.state)).toEqual(['zephyr'])
  })

  it('谁都不显示的标签也算——读的是它自己那份 snapshot', () => {
    const pane = mounted()
    pane.type('zephyr')
    const right = pane.splitPane()
    right.type('quartz')
    // 合并掉右边那块分屏：标签留在标签条上，只是不再被任何分屏显示。
    // liveStates 的口径与 syncMetrics / host.getText 是同一条——显示中读 view.state，
    // 没显示读 snapshot.state；读错来源的话这里的词就补不出来了
    pane.ws.closePane(right.id)
    expect(pane.ws.panes()).toHaveLength(1)
    expect(pane.ws.tabs()).toHaveLength(2)

    pane.type(' qu')

    expect(completionLabels(pane.state)).toEqual(['quartz'])
  })

  it('同一个词在两个标签里都出现时只出一次', () => {
    const pane = mounted()
    pane.type('omega')
    const right = pane.splitPane()
    right.type('omega')

    right.type(' om')

    // 两份词典里都有 omega，跨词典的 seen 集合负责去重
    expect(completionLabels(right.controller.view.state)).toEqual(['omega'])
  })
})

describe('openViaDialog', () => {
  it('对话框取消时什么都不动', async () => {
    const pane = mounted()
    dialog.open.mockResolvedValue(null)

    await pane.ws.openViaDialog()

    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(pane.ws.tabs()).toHaveLength(1)
    expect(pane.doc).toBe('')
  })

  it('不设扩展名过滤器：编辑器要能打开 LICENSE、Makefile、无后缀的配置文件', async () => {
    const pane = mounted()
    dialog.open.mockResolvedValue('/proj/Makefile')

    await pane.ws.openViaDialog()

    expect(dialog.open).toHaveBeenCalledWith({ multiple: false, directory: false })
    expect(pane.ws.activeTab().doc.name()).toBe('Makefile')
  })
})

describe('setLineWrap：全局设置要落到每一个标签', () => {
  it('显示中的那个走 dispatch，其余的走 state.update', () => {
    const pane = mounted()
    const second = pane.ws.newTab()
    pane.ws.activateTab(pane.ws.tabs()[0]!.id)

    pane.ws.setLineWrap(false)

    expect(pane.ws.lineWrap()).toBe(false)
    expect(lineWrapEnabled(pane.state)).toBe(false)
    expect(lineWrapEnabled(second.snapshot.state)).toBe(false)
  })

  it('切到后台标签，它的换行状态也是对的', () => {
    const pane = mounted()
    const second = pane.ws.newTab()
    pane.ws.setLineWrap(false)

    pane.ws.activateTab(second.id)

    expect(lineWrapEnabled(pane.state)).toBe(false)
  })

  it('传入相同值时什么都不做（不白重建一次视图）', () => {
    const pane = mounted()
    const before = pane.state
    pane.ws.setLineWrap(true)
    expect(pane.state).toBe(before)
  })

  it('toggleLineWrap 来回翻', () => {
    const ws = createWorkspace()
    expect(ws.lineWrap()).toBe(true)
    ws.toggleLineWrap()
    expect(ws.lineWrap()).toBe(false)
    ws.toggleLineWrap()
    expect(ws.lineWrap()).toBe(true)
  })

  it('关着换行时新建的标签也是关的', () => {
    const ws = createWorkspace()
    ws.setLineWrap(false)
    expect(lineWrapEnabled(ws.newTab().snapshot.state)).toBe(false)
  })

  it('关掉换行之后打开文件，新正文仍然是关的', async () => {
    const pane = mounted()
    pane.ws.setLineWrap(false)
    await pane.ws.openAt('/a.txt')
    expect(lineWrapEnabled(pane.ws.activeTab().snapshot.state)).toBe(false)
  })
})

describe('度量与脏标记', () => {
  it('输入经 state 里的 onUpdate 推到 metrics，并且只脏自己', () => {
    const pane = mounted()
    pane.type('三行\n第二\n第三')
    expect(pane.ws.metrics()).toMatchObject({ lines: 3, chars: 8 })
    expect(pane.ws.activeTab().doc.dirty()).toBe(true)
  })

  it('行列跟着主光标走，从 1 开始数', () => {
    const pane = mounted()
    pane.type('第一行\n第二行\n第三行')
    // type 把光标落在插入文本之后：第三行末尾 = 3 行 4 列
    expect(pane.ws.metrics()).toMatchObject({ lines: 3, chars: 11, line: 3, col: 4 })

    // 「第二行」的第二个字之后（偏移 5，第二行从 4 开始）
    pane.controller.view.dispatch({ selection: { anchor: 5 } })
    expect(pane.ws.metrics()).toMatchObject({ line: 2, col: 2 })
  })

  it('选中报出字符数、多光标报出选区个数，纯光标时是 1 个选区 0 字符', () => {
    const pane = mounted()
    pane.type('abcdef')

    pane.controller.view.dispatch({ selection: { anchor: 1, head: 4 } })
    expect(pane.ws.metrics()).toMatchObject({ selections: 1, selectedChars: 3 })

    // 收敛成光标：选区数还是 1（CM6 把光标当空选区），选中字符数归零
    pane.controller.view.dispatch({ selection: { anchor: 2 } })
    expect(pane.ws.metrics()).toMatchObject({ selections: 1, selectedChars: 0 })

    // ⛔ 不能写成 `selection: { ranges: [...] }`：TransactionSpec 只认 `EditorSelection`
    // 或**单个** `{anchor, head}`，写错不报错，会变成 undefined 位置一路炸到第三方帧里
    pane.controller.view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 6)]),
    })
    // 列报的是**主选区**的 head，而 `EditorSelection.create` 不传 mainIndex 时主选区是第一个
    expect(pane.ws.metrics()).toMatchObject({ selections: 2, selectedChars: 5, line: 1, col: 3 })
  })

  it('缩进报的是这个标签 state 上的 indentUnit，不是写死的字符串', () => {
    const pane = mounted()
    const state = pane.controller.view.state
    expect(pane.ws.metrics().indent).toBe(indentLabel(state.facet(indentUnit)))
    expect(pane.ws.metrics().indent).toBe('2 空格')
    // 换行符与缩进都是「配置变了显示就得跟着变」的东西，但眼下没有改缩进的入口，
    // 所以这里只钉住取值来源。indentLabel 本身的分支在 setup.test.ts 里测
  })

  it('整篇替换正文（打开文件）不算用户改动，敲一个字才算', async () => {
    // 这条是 document.ts 里 `replacing` 标志存在的全部理由：替换正文会让 CM6 回调
    // docChanged，挡不住的话刚打开的文件立刻显示成「未保存」
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    expect(pane.ws.activeTab().doc.dirty()).toBe(false)
    expect(pane.ws.anyDirty()).toBe(false)

    pane.type('改')
    expect(pane.ws.activeTab().doc.dirty()).toBe(true)
  })

  it('切标签时 metrics 换成新标签的', async () => {
    const pane = mounted()
    pane.type('aaaa')
    const first = pane.ws.activeTab()
    const second = pane.ws.newTab()
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 0 })

    pane.ws.activateTab(first.id)
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 4 })

    pane.ws.activateTab(second.id)
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 0 })
  })

  it('后台标签的 state 变了也不会污染 metrics（状态栏只显示最新那个）', () => {
    const pane = mounted()
    const first = pane.ws.activeTab()
    pane.ws.newTab()
    first.snapshot = {
      ...first.snapshot,
      state: first.snapshot.state.update({ changes: { from: 0, insert: '偷偷改的' } }).state,
    }
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 0 })
    expect(pane.doc).toBe('')
  })

  it('anyDirty 只要有任意一个标签没落盘就是真', async () => {
    const pane = mounted()
    expect(pane.ws.anyDirty()).toBe(false)

    await pane.ws.openAt('/a.txt')
    expect(pane.ws.anyDirty()).toBe(false)

    pane.type('x')
    expect(pane.ws.anyDirty()).toBe(true)

    const second = pane.ws.newTab()
    expect(second.doc.dirty()).toBe(false)
    expect(pane.ws.anyDirty()).toBe(true)
  })

  it('光标移动不置脏：脏标记只认正文变化', () => {
    const pane = mounted()
    pane.controller.view.dispatch({ selection: { anchor: 0 } })
    expect(pane.ws.activeTab().doc.dirty()).toBe(false)
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 0 })
  })
})

describe('host 路由：显示中与未显示的标签读到的正文不一样', () => {
  it('显示中的标签 getText 读 view.state，不是过期的 snapshot', async () => {
    // snapshot 只在切走时更新，显示期间它一直是旧的。读错来源会让「保存」写出旧内容
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    pane.type('追加')

    expect(tabText(pane.ws.activeTab())).toBe('正文') // snapshot 还是打开那一刻的

    await pane.ws.save()
    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文追加', { encoding: 'utf8', bom: false, eol: 'lf' })
  })

  it('save / saveAs 都作用于活动标签', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    const first = pane.ws.activeTab()
    pane.ws.newTab()
    pane.type('第二份')

    dialog.save.mockResolvedValue('/b.txt')
    await pane.ws.save()

    expect(ipc.saveFile).toHaveBeenCalledWith('/b.txt', '第二份', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(first.doc.path()).toBe('/a.txt')
    expect(pane.ws.activeTab().doc.path()).toBe('/b.txt')
  })

  it('detach 之后 host 退回到读 snapshot，不炸', () => {
    const pane = mounted()
    const first = pane.ws.activeTab()
    pane.type('存着')
    pane.ws.newTab()
    pane.ws.activateTab(first.id) // 这一下把「存着」装回分屏，也把它 capture 回 first.snapshot

    pane.ws.detach(pane.ws.panes()[0]!.id)

    expect(pane.ws.activeTab()).toBe(first)
    expect(tabText(first)).toBe('存着')
    // detach 之后不该再有人往已交出的 controller 上写东西
    expect(() => pane.ws.newTab()).not.toThrow()
  })
})

describe('未挂编辑器时也能工作（挂载前的那一小段时间）', () => {
  it('newTab / closeTab / reorder 都不需要 controller 在场', async () => {
    const ws: Workspace = createWorkspace()
    const a = ws.tabs()[0]!
    const b = ws.newTab()
    const c = ws.newTab()
    expect(ws.tabs()).toHaveLength(3)

    ws.reorder(a.id, c.id)
    expect(ws.tabs().map((t) => t.id)).toEqual([b.id, c.id, a.id])
    expect(ws.activeTab()).toBe(c)

    await ws.closeTab(b.id)
    expect(ws.tabs().map((t) => t.id)).toEqual([c.id, a.id])
    expect(ws.activeTab()).toBe(c)
  })

  it('attach 之后度量对上，不需要额外 restore', () => {
    const ws = createWorkspace()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = new EditorController(host, ws.activeTab().snapshot.state)
    liveEditors.push({ controller, host })
    controller.view.dispatch({ changes: { from: 0, insert: '挂载前的内容' } })

    ws.attach(ws.panes()[0]!.id, controller)

    expect(ws.metrics()).toMatchObject({ lines: 1, chars: 6 })
  })

  it('分屏的增删与聚焦也不需要 controller 在场', () => {
    const ws: Workspace = createWorkspace()
    const first = ws.panes()[0]!

    ws.split('row')
    expect(ws.panes()).toHaveLength(2)
    expect(ws.focusedPaneId()).not.toBe(first.id)

    ws.cyclePane(-1)
    expect(ws.focusedPaneId()).toBe(first.id)

    ws.closePane(ws.panes()[1]!.id)
    expect(ws.panes()).toEqual([first])
    expect(ws.focusedPaneId()).toBe(first.id)
    expect(ws.focusedEditor()).toBeNull()
  })
})

describe('M1-D-5：分屏', () => {
  it('一块分屏时的行为与加分屏之前完全一致', () => {
    const pane = mounted()
    expect(pane.ws.panes()).toHaveLength(1)
    expect(pane.ws.direction()).toBe('row')
    expect(pane.ws.focusedPaneId()).toBe(pane.ws.panes()[0]!.id)
    expect(pane.ws.focusedEditor()).toBe(pane.controller)
    expect(pane.ws.panes()[0]!.tabId()).toBe(pane.ws.activeTab().id)
  })

  it('split 加一块分屏、装一个新空标签，并把焦点交给它', () => {
    const pane = mounted()
    pane.type('左边')
    const leftTab = pane.ws.activeTab()

    const right = pane.splitPane('row')

    expect(pane.ws.panes()).toHaveLength(2)
    expect(pane.ws.direction()).toBe('row')
    // 新分屏装的是**新标签**，不是把左边那个复制过去：一个标签只能显示在一个分屏里
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.focusedPaneId()).toBe(right.id)
    expect(pane.ws.activeTab()).not.toBe(leftTab)
    expect(right.text).toBe('')
    // 左边那份正文一动没动
    expect(pane.controller.doc).toBe('左边')
    // 度量跟着焦点走，焦点在新分屏上，所以是空文档的度量
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 0 })
  })

  it('direction 由最后一次 split 决定，且到 MAX_PANES 之后只改方向不再加分屏', () => {
    const pane = mounted()
    pane.splitPane('column')
    expect(pane.ws.direction()).toBe('column')
    expect(pane.ws.panes()).toHaveLength(2)

    for (let i = 2; i < MAX_PANES; i++) {
      pane.splitPane('column')
      expect(pane.ws.panes()).toHaveLength(i + 1)
    }
    expect(pane.ws.direction()).toBe('column')

    pane.ws.split('row')
    expect(pane.ws.panes()).toHaveLength(MAX_PANES)
    expect(pane.ws.direction()).toBe('row')
    expect(pane.ws.tabs()).toHaveLength(MAX_PANES)
  })

  it('两块分屏各有各的正文与光标，互不串台', () => {
    const pane = mounted()
    pane.type('AAA')
    const right = pane.splitPane('row')
    right.type('BBBBB')

    expect(pane.controller.doc).toBe('AAA')
    expect(right.text).toBe('BBBBB')
    // 光标位置也是各自的：右边敲了 5 个字，左边停在 3
    expect(right.controller.view.state.selection.main.head).toBe(5)
    expect(pane.controller.view.state.selection.main.head).toBe(3)
    // 两块都是脏的
    expect(pane.ws.anyDirty()).toBe(true)
    expect(pane.ws.tabs().filter((t) => t.doc.dirty())).toHaveLength(2)
  })

  it('焦点决定度量与「活动标签」，focusPane 换焦点不换正文', () => {
    const pane = mounted()
    pane.type('AAA')
    const leftTab = pane.ws.activeTab()
    const right = pane.splitPane('row')
    right.type('BBBBB')
    const leftId = pane.ws.panes()[0]!.id

    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 5 })

    pane.ws.focusPane(leftId)
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 3 })
    expect(pane.ws.activeTab()).toBe(leftTab)
    expect(right.controller.doc).toBe('BBBBB')

    // 幂等：重复聚焦同一块不该把正文或度量搅乱
    pane.ws.focusPane(leftId)
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 3 })
  })

  it('cyclePane 两个方向都回绕', () => {
    const pane = mounted()
    const ids = [pane.ws.panes()[0]!.id]
    ids.push(pane.splitPane('row').id)
    ids.push(pane.splitPane('row').id)
    expect(pane.ws.focusedPaneId()).toBe(ids[2])

    pane.ws.cyclePane(1)
    expect(pane.ws.focusedPaneId()).toBe(ids[0]) // 末尾往后绕回开头
    pane.ws.cyclePane(-1)
    expect(pane.ws.focusedPaneId()).toBe(ids[2]) // 开头往前绕到末尾
    pane.ws.cyclePane(-1)
    expect(pane.ws.focusedPaneId()).toBe(ids[1]) // 普通的往前一步
    pane.ws.cyclePane(1)
    expect(pane.ws.focusedPaneId()).toBe(ids[2]) // 普通的往后一步
  })

  it('只有一块分屏时 cyclePane 是空操作，不会把焦点丢成 -1', () => {
    const pane = mounted()
    const only = pane.ws.panes()[0]!.id
    pane.ws.cyclePane(1)
    pane.ws.cyclePane(-1)
    expect(pane.ws.focusedPaneId()).toBe(only)
  })

  it('closePane 合掉分屏，它显示的标签留在标签条上、现场也存了回去', () => {
    const pane = mounted()
    pane.type('左边')
    const leftTab = pane.ws.activeTab()
    const right = pane.splitPane('row')
    right.type('右边')
    const rightTab = pane.ws.activeTab()
    const leftId = pane.ws.panes()[0]!.id

    pane.ws.closePane(right.id)

    expect(pane.ws.panes()).toHaveLength(1)
    // 合并分屏不是关标签：两个标签都还在条上
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(tabText(rightTab)).toBe('右边')
    expect(rightTab.doc.dirty()).toBe(true)
    // 焦点落回剩下那块，活动标签也跟着回去
    expect(pane.ws.focusedPaneId()).toBe(leftId)
    expect(pane.ws.activeTab()).toBe(leftTab)
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 2 })
    expect(pane.ws.focusedEditor()).toBe(pane.controller)
  })

  it('合掉聚焦的分屏之后焦点落到剩下的最后一块；只剩一块时是空操作', () => {
    const pane = mounted()
    const a = pane.ws.panes()[0]!.id
    const b = pane.splitPane('row').id
    const c = pane.splitPane('row').id
    expect(pane.ws.focusedPaneId()).toBe(c)

    pane.ws.closePane(c)
    expect(pane.ws.focusedPaneId()).toBe(b)

    pane.ws.closePane(b)
    expect(pane.ws.panes().map((p) => p.id)).toEqual([a])

    pane.ws.closePane(a)
    expect(pane.ws.panes()).toHaveLength(1)
    expect(pane.ws.focusedPaneId()).toBe(a)
  })

  it('activateTab 命中别的分屏里显示着的标签时聚焦那块，而不是把它搬过来', () => {
    const pane = mounted()
    const right = pane.splitPane('row')
    const rightTab = pane.ws.activeTab()
    pane.ws.focusPane(pane.ws.panes()[0]!.id)
    const third = pane.ws.newTab() // 装进左边那块

    pane.ws.activateTab(rightTab.id)

    expect(pane.ws.focusedPaneId()).toBe(right.id)
    expect(pane.ws.activeTab()).toBe(rightTab)
    // 左边那块还显示着 third：搬走会让它空掉，而一个标签也不能同时显示在两处
    expect(pane.ws.panes()[0]!.tabId()).toBe(third.id)
  })

  it('activateTab 命中谁都没显示的标签时，把它装进聚焦的那块分屏', () => {
    const pane = mounted()
    const right = pane.splitPane('row')
    right.type('孤儿')
    const orphan = pane.ws.activeTab()
    pane.ws.closePane(right.id) // 标签留下，分屏没了
    expect(pane.ws.panes()[0]!.tabId()).not.toBe(orphan.id)

    pane.ws.activateTab(orphan.id)

    expect(pane.ws.panes()[0]!.tabId()).toBe(orphan.id)
    expect(pane.controller.doc).toBe('孤儿')
    expect(pane.ws.metrics()).toMatchObject({ lines: 1, chars: 2 })
  })

  it('setLineWrap 落到每一块分屏的 view 上，也落到没显示着的标签上', () => {
    const pane = mounted({ lineWrap: true })
    const right = pane.splitPane('row')
    const leftTab = pane.ws.tabs()[0]!

    pane.ws.focusPane(pane.ws.panes()[0]!.id)
    pane.ws.newTab() // 左边那块改显示这个新标签，leftTab 就谁都没显示了

    pane.ws.setLineWrap(false)

    // 显示中的标签看 view（snapshot 只在切走时更新，这会儿还是旧的）
    expect(lineWrapEnabled(pane.controller.view.state)).toBe(false)
    expect(lineWrapEnabled(right.controller.view.state)).toBe(false)
    // 没显示在任何分屏里的标签没有 view 可 dispatch，只能就地 update 出一个新 state
    expect(lineWrapEnabled(leftTab.snapshot.state)).toBe(false)
    expect(pane.ws.lineWrap()).toBe(false)
  })

  it('openAt 与 save 都落在聚焦的那块分屏上', async () => {
    const pane = mounted()
    pane.type('左边')
    const right = pane.splitPane('row')

    await pane.ws.openAt('/a.txt')

    // 复用「干净的无名标签」这条规则只看聚焦分屏的那个标签，所以落到了右边
    expect(right.text).toBe('正文')
    expect(pane.controller.doc).toBe('左边')
    expect(pane.ws.activeTab().doc.path()).toBe('/a.txt')

    right.type('追加')
    await pane.ws.save()
    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文追加', { encoding: 'utf8', bom: false, eol: 'lf' })

    // 焦点换到左边那块之后，保存的是左边那个标签——它没有路径，于是落到另存为
    pane.ws.focusPane(pane.ws.panes()[0]!.id)
    dialog.save.mockResolvedValue('/left.txt')
    await pane.ws.save()
    expect(ipc.saveFile).toHaveBeenCalledWith('/left.txt', '左边', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(right.controller.doc).toBe('正文追加')
  })

  it('closeTab 不会让两块分屏显示同一个标签', async () => {
    const pane = mounted()
    pane.type('左边')
    const leftTab = pane.ws.activeTab()
    const right = pane.splitPane('row')
    right.type('右边')

    pane.ws.focusPane(pane.ws.panes()[0]!.id)
    await pane.ws.closeTab(leftTab.id)

    // 右邻居（右边那个标签）正在另一块分屏里显示着，不能搬过来——补一个空标签
    expect(pane.ws.tabs()).toHaveLength(2)
    expect(pane.ws.tabs()).not.toContain(leftTab)
    expect(pane.ws.panes()[0]!.tabId()).not.toBe(pane.ws.panes()[1]!.tabId())
    expect(pane.controller.doc).toBe('')
    expect(right.controller.doc).toBe('右边')
  })

  it('关掉没被任何分屏显示的标签，只是从条上摘掉', async () => {
    const pane = mounted()
    const right = pane.splitPane('row')
    right.type('孤儿')
    const orphan = pane.ws.activeTab()
    pane.ws.closePane(right.id)
    const leftId = pane.ws.panes()[0]!.id
    const shownBefore = pane.ws.panes()[0]!.tabId()

    await pane.ws.closeTab(orphan.id)

    expect(pane.ws.tabs()).not.toContain(orphan)
    expect(pane.ws.panes()).toHaveLength(1)
    expect(pane.ws.panes()[0]!.tabId()).toBe(shownBefore)
    expect(pane.ws.focusedPaneId()).toBe(leftId)
  })
})

describe('关闭确认', () => {
  /** 记下问过什么、并一律答同一个决策 */
  function recorder(decision: DiscardDecision) {
    const calls: string[][] = []
    const promptDiscard: DiscardPrompt = async (names) => {
      calls.push(names)
      return decision
    }
    return { calls, promptDiscard }
  }

  it('干净标签压根不问', async () => {
    const prompt = recorder('discard')
    const pane = mounted({ promptDiscard: prompt.promptDiscard })
    await pane.ws.closeTab(pane.ws.activeTab().id)
    expect(prompt.calls).toEqual([])
  })

  it('答「取消」：标签留着，脏标记也留着', async () => {
    const prompt = recorder('cancel')
    const pane = mounted({ promptDiscard: prompt.promptDiscard })
    await pane.ws.openAt('/a.txt')
    pane.type('改')
    const tab = pane.ws.activeTab()

    await pane.ws.closeTab(tab.id)

    expect(prompt.calls).toEqual([['a.txt']])
    expect(pane.ws.tabs()).toEqual([tab])
    expect(tab.doc.dirty()).toBe(true)
    expect(ipc.saveFile).not.toHaveBeenCalled()
  })

  it('答「不保存」：直接摘掉，一个字节都不写', async () => {
    const pane = mounted({ promptDiscard: async () => 'discard' })
    await pane.ws.openAt('/a.txt')
    pane.type('改')

    await pane.ws.closeTab(pane.ws.activeTab().id)

    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(pane.ws.tabs()).toHaveLength(1) // 补进来的那个空标签
    expect(pane.ws.activeTab().doc.path()).toBeNull()
  })

  it('答「保存」：先写盘再关', async () => {
    const pane = mounted({ promptDiscard: async () => 'save' })
    await pane.ws.openAt('/a.txt')
    pane.type('改')

    await pane.ws.closeTab(pane.ws.activeTab().id)

    expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
    expect(pane.ws.activeTab().doc.path()).toBeNull()
  })

  it('答「保存」但写盘失败：标签必须留着，否则用户以为已经保存了', async () => {
    const pane = mounted({ promptDiscard: async () => 'save' })
    await pane.ws.openAt('/a.txt')
    pane.type('改')
    const tab = pane.ws.activeTab()
    ipc.saveFile.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '权限不够' })

    await pane.ws.closeTab(tab.id)

    expect(pane.ws.tabs()).toEqual([tab])
    expect(tab.doc.dirty()).toBe(true)
    expect(tab.doc.notice()?.level).toBe('error')
  })

  it('无名文档答「保存」会落到另存为；那个对话框被取消时同样中止关闭', async () => {
    const pane = mounted({ promptDiscard: async () => 'save' })
    pane.type('没名字的稿子')
    const tab = pane.ws.activeTab()
    dialog.save.mockResolvedValue(null)

    await pane.ws.closeTab(tab.id)

    expect(dialog.save).toHaveBeenCalled()
    expect(ipc.saveFile).not.toHaveBeenCalled()
    expect(pane.ws.tabs()).toEqual([tab])

    // 这次给个路径，就该写盘并关掉
    dialog.save.mockResolvedValue('/chosen.txt')
    await pane.ws.closeTab(tab.id)
    expect(ipc.saveFile).toHaveBeenCalledWith('/chosen.txt', '没名字的稿子', {
      encoding: 'utf8',
      bom: false,
      eol: 'lf',
    })
    expect(pane.ws.tabs()).not.toContain(tab)
  })

  it('没注入 promptDiscard 时默认答「取消」——静默丢数据是不可接受的缺省值', async () => {
    const bare = createWorkspace()
    const tab = bare.tabs()[0]!
    tab.doc.markChanged()

    await bare.closeTab(tab.id)

    expect(bare.tabs()).toEqual([tab])
    expect(tab.doc.dirty()).toBe(true)
  })

  describe('requestWindowClose（窗口级总闸）', () => {
    it('全干净：直接放行，不问', async () => {
      const prompt = recorder('cancel')
      const pane = mounted({ promptDiscard: prompt.promptDiscard })
      await pane.ws.openAt('/a.txt')
      pane.ws.newTab()

      expect(await pane.ws.requestWindowClose()).toBe(true)
      expect(prompt.calls).toEqual([])
    })

    it('多个脏标签一次问完，而不是一个一个弹', async () => {
      const prompt = recorder('discard')
      const pane = mounted({ promptDiscard: prompt.promptDiscard })
      await pane.ws.openAt('/a.txt')
      pane.type('改')
      pane.ws.newTab()
      await pane.ws.openAt('/b.txt')
      pane.type('也改')

      expect(await pane.ws.requestWindowClose()).toBe(true)
      expect(prompt.calls).toEqual([['a.txt', 'b.txt']])
    })

    it('答「取消」：返回 false，一个标签都不动', async () => {
      const pane = mounted({ promptDiscard: async () => 'cancel' })
      await pane.ws.openAt('/a.txt')
      pane.type('改')

      expect(await pane.ws.requestWindowClose()).toBe(false)
      expect(pane.ws.tabs()).toHaveLength(1)
      expect(pane.ws.activeTab().doc.dirty()).toBe(true)
    })

    it('答「保存」：全部落盘之后才放行', async () => {
      const pane = mounted({ promptDiscard: async () => 'save' })
      await pane.ws.openAt('/a.txt')
      pane.type('改')
      pane.ws.newTab()
      await pane.ws.openAt('/b.txt')
      pane.type('也改')

      expect(await pane.ws.requestWindowClose()).toBe(true)
      expect(ipc.saveFile).toHaveBeenCalledWith('/a.txt', '正文改', { encoding: 'utf8', bom: false, eol: 'lf' })
      expect(ipc.saveFile).toHaveBeenCalledWith('/b.txt', '正文也改', { encoding: 'utf8', bom: false, eol: 'lf' })
      expect(pane.ws.anyDirty()).toBe(false)
    })

    it('答「保存」但其中一个写不下去：不放行——半关状态比不关更糟', async () => {
      const pane = mounted({ promptDiscard: async () => 'save' })
      await pane.ws.openAt('/a.txt')
      pane.type('改')
      pane.ws.newTab()
      await pane.ws.openAt('/b.txt')
      pane.type('也改')
      ipc.saveFile.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '权限不够' })

      expect(await pane.ws.requestWindowClose()).toBe(false)
      expect(pane.ws.tabs()).toHaveLength(2)
      expect(pane.ws.anyDirty()).toBe(true)
    })
  })
})

/**
 * M1-F-4：会话的序列化与恢复。
 *
 * 这一组必须挂**真的** controller：`serializeSession` 读的是活的 `view.state` 与
 * `scrollDOM`，`attach` 要把滚动位置与焦点落到刚建起来的 view 上——拿替身这两条都验不出来，
 * 而「读错来源」正是这一层最容易犯、又最不容易被发现的错。
 */
describe('M1-F-4：会话序列化与恢复', () => {
  function sessionTab(overrides: Partial<SessionTab> = {}): SessionTab {
    return {
      path: null,
      format: { encoding: 'utf8', bom: false, eol: 'lf' },
      dirty: true,
      lossy: false,
      draft: '',
      selection: [[0, 0]],
      main: 0,
      scrollTop: 0,
      scrollLeft: 0,
      ...overrides,
    }
  }

  function sessionOf(tabs: SessionTab[], overrides: Partial<Session> = {}): Session {
    // `project: null` 是基底的一部分：这些用例都只关心标签页那一半，
    // 而 `Partial<Session>` 里它是可选的——不写死一个值，展开之后类型就成了 `| undefined`
    return { version: SESSION_VERSION, direction: 'row', focused: 0, tabs, panes: [0], project: null, ...overrides }
  }

  /**
   * 模拟 Solid 在 `restoreSession` 换掉 pane 记录之后做的事：为每块新分屏挂一个 EditorPane。
   *
   * 不模拟这一步的话，恢复出来的标签永远停在 snapshot 上，`attach` 里的滚动与焦点
   * 压根不会被执行到——而那正是「恢复完还得先点一下编辑器才能打字」这个 bug 的所在。
   */
  function remountAll(ws: Workspace) {
    for (const p of ws.panes()) {
      if (p.controller) continue
      const host = document.createElement('div')
      document.body.appendChild(host)
      const tab = ws.tabs().find((t) => t.id === p.tabId())!
      const controller = new EditorController(host, tab.snapshot.state)
      liveEditors.push({ controller, host })
      ws.attach(p.id, controller)
    }
  }

  it('serializeSession 是纯读：调完之后现场一点没变', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    pane.type('x')
    const stateBefore = pane.state
    const tabsBefore = pane.ws.tabs()
    const panesBefore = pane.ws.panes()

    pane.ws.serializeSession()

    expect(pane.state).toBe(stateBefore)
    expect(pane.ws.tabs()).toBe(tabsBefore)
    expect(pane.ws.panes()).toBe(panesBefore)
  })

  it('读的是活的 view，不是切走那一刻的旧 snapshot', async () => {
    // 显示期间 `tab.snapshot` 一直是旧的（只在 capture 时更新）。读错来源的后果是
    // **存档里存的是打开文件那一刻的正文**，用户最后敲的那些字全丢，而且不报错
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    pane.type('刚敲进去的')
    // snapshot 停在打开那一刻：里面有文件正文，但没有刚敲进去的那些字
    expect(tabText(pane.ws.activeTab())).toBe('正文')

    const saved = pane.ws.serializeSession()

    expect(saved.tabs[0]!.draft).toBe('正文刚敲进去的')
  })

  it('draft 的口径：干净又有路径的不存正文，脏的与未命名的存', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    expect(pane.ws.serializeSession().tabs[0]!).toMatchObject({ path: '/a.txt', dirty: false, draft: null })

    pane.type('改')
    expect(pane.ws.serializeSession().tabs[0]!).toMatchObject({ dirty: true, draft: '正文改' })

    pane.ws.newTab()
    pane.type('还没落盘')
    const untitled = pane.ws.serializeSession().tabs[1]!
    expect(untitled).toMatchObject({ path: null, dirty: true, draft: '还没落盘' })
    // 未命名文档的格式决定也只能存在这儿
    expect(untitled.format).toEqual({ encoding: 'utf8', bom: false, eol: 'lf' })
  })

  it('多光标、主选区下标与滚动位置都进存档', async () => {
    const pane = mounted()
    pane.type('alpha\nbeta\ngamma')
    pane.controller.view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.range(6, 9)], 1),
    })
    pane.setScroll(120, 5)

    const saved = pane.ws.serializeSession()

    expect(saved.tabs[0]!.selection).toEqual([
      [2, 2],
      [6, 9],
    ])
    expect(saved.tabs[0]!.main).toBe(1)
    expect(saved.tabs[0]!.scrollTop).toBe(120)
    expect(saved.tabs[0]!.scrollLeft).toBe(5)
  })

  it('存下来再恢复回来：正文、脏标记、布局、方向、聚焦、滚动一样不少', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.md')
    pane.type('# 标题')
    pane.setScroll(80)
    const right = pane.splitPane('column')
    await pane.ws.openAt('/b.txt')
    right.type('右边的草稿')
    const saved = pane.ws.serializeSession()
    expect(saved).toMatchObject({ direction: 'column', focused: 1, panes: [0, 1] })

    const fresh = mounted()
    await fresh.ws.restoreSession(saved)
    remountAll(fresh.ws)

    expect(fresh.ws.tabs().map((t) => t.doc.path())).toEqual(['/a.md', '/b.txt'])
    expect(tabText(fresh.ws.tabs()[0]!)).toBe('正文# 标题')
    expect(tabText(fresh.ws.tabs()[1]!)).toBe('正文右边的草稿')
    expect(fresh.ws.tabs().map((t) => t.doc.dirty())).toEqual([true, true])
    expect(fresh.ws.direction()).toBe('column')
    expect(fresh.ws.panes()).toHaveLength(2)
    expect(fresh.ws.activeTab().doc.path()).toBe('/b.txt')
    // 滚动位置由 attach 落到刚建起来的 view 上
    expect(fresh.ws.panes()[0]!.controller!.view.scrollDOM.scrollTop).toBe(80)
  })

  it('干净又有路径的标签恢复时重新读盘：关机期间被改过的文件以磁盘为准', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    const saved = pane.ws.serializeSession()
    expect(saved.tabs[0]!.draft).toBeNull()

    ipc.openFile.mockResolvedValue(textFile({ text: '关机期间被别的程序改过了' }))
    const fresh = mounted()
    await fresh.ws.restoreSession(saved)

    expect(ipc.openFile).toHaveBeenCalledWith('/a.txt')
    expect(tabText(fresh.ws.activeTab())).toBe('关机期间被别的程序改过了')
    expect(fresh.ws.activeTab().doc.dirty()).toBe(false)
  })

  it('脏标签的草稿原样回来，一次磁盘都不碰', async () => {
    const pane = mounted()
    await pane.ws.openAt('/a.txt')
    pane.type('改过了')
    const saved = pane.ws.serializeSession()

    ipc.openFile.mockClear()
    const fresh = mounted()
    await fresh.ws.restoreSession(saved)

    expect(ipc.openFile).not.toHaveBeenCalled()
    expect(tabText(fresh.ws.activeTab())).toBe('正文改过了')
    expect(fresh.ws.activeTab().doc.dirty()).toBe(true)
    expect(fresh.ws.activeTab().doc.path()).toBe('/a.txt')
  })

  it('一个文件读不回来不影响其余标签：错误落在那个标签自己的提示条上', async () => {
    ipc.openFile.mockImplementation(async (path: string) => {
      // 抛的**就是**那个普通对象：Tauri 的 invoke 在 Rust command 返回 Err 时拒绝的正是
      // 这个序列化结果，下游断言也靠 `kind` 字面量认它。换成 Error 实例等于测一个
      // 生产环境里根本不存在的形状。
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (path === '/gone.txt') throw { kind: 'io', reason: 'NotFound', message: '没了' }
      return textFile({ text: `${path} 的正文` })
    })
    const saved = sessionOf(
      [
        sessionTab({ path: '/gone.txt', dirty: false, draft: null }),
        sessionTab({ path: '/ok.txt', dirty: false, draft: null }),
      ],
      // 一块分屏显示第二个标签：panes 不需要覆盖所有标签
      { panes: [1] },
    )

    const fresh = mounted()
    await fresh.ws.restoreSession(saved)

    const [broken, ok] = fresh.ws.tabs()
    expect(broken!.doc.notice()?.level).toBe('error')
    expect(ok!.doc.notice()).toBeNull()
    expect(tabText(ok!)).toBe('/ok.txt 的正文')
    expect(fresh.ws.activeTab()).toBe(ok)
  })

  it('存档里的光标越界时被夹住，而不是让 CM6 抛 RangeError', async () => {
    // Vela 关着的时候文件可能被截短：存档里的 cursor=999，恢复回来正文只有 2 个字符。
    // 不夹的话 checkSelection 直接抛，整个启动恢复都完不成
    const saved = sessionOf([sessionTab({ draft: '短文', selection: [[999, 999]], main: 0 })])

    const fresh = mounted()
    await fresh.ws.restoreSession(saved)

    const state = fresh.ws.activeTab().snapshot.state
    expect(state.selection.main.head).toBe(2)
    expect(state.doc.toString()).toBe('短文')
  })

  it('恢复出来的语言跟着路径走', async () => {
    const saved = sessionOf([
      sessionTab({ path: '/notes.md', draft: '# 标题' }),
      sessionTab({ path: '/var/app.log', draft: '一行日志' }),
    ])

    const fresh = mounted()
    await fresh.ws.restoreSession(saved)
    remountAll(fresh.ws)

    const [md, log] = fresh.ws.tabs()
    expect(languageName(md!.snapshot.state)).toBe('markdown')
    // 没匹配上的扩展名不挂语言，与 M1-E-1 那条口径一致
    expect(languageName(log!.snapshot.state)).toBe(null)
  })

  it('恢复完聚焦的那块分屏直接能打字，不用先点一下', async () => {
    const pane = mounted()
    pane.splitPane('column')
    const saved = pane.ws.serializeSession()
    expect(saved.focused).toBe(1)

    const fresh = mounted()
    await fresh.ws.restoreSession(saved)
    remountAll(fresh.ws)

    const focused = fresh.ws.panes()[saved.focused]!
    const other = fresh.ws.panes()[0]!
    expect(focused.controller).not.toBeNull()
    expect(focused.controller!.view.dom.contains(document.activeElement)).toBe(true)
    // 没聚焦的那块不该抢走焦点
    expect(other.controller!.view.dom.contains(document.activeElement)).toBe(false)
  })

  it('恢复会整个换掉现在的现场', async () => {
    const fresh = mounted()
    fresh.type('要被扔掉的')
    expect(fresh.ws.anyDirty()).toBe(true)

    await fresh.ws.restoreSession(sessionOf([sessionTab({ path: '/a.txt', draft: '存档里的' })]))

    expect(fresh.ws.tabs()).toHaveLength(1)
    expect(tabText(fresh.ws.activeTab())).toBe('存档里的')
    expect(fresh.ws.activeTab().doc.path()).toBe('/a.txt')
  })

  it('标签数超过上限时从后面截断，但分屏正在显示的那个一定留住', async () => {
    // 截掉一个显示中的标签会让 panes 里的下标悬空，Rust 侧因此拒掉**整份**存档
    const ws = createWorkspace()
    for (let i = 0; i < MAX_SESSION_TABS + 3; i++) ws.newTab()
    const last = ws.tabs()[ws.tabs().length - 1]!
    ws.activateTab(last.id)
    await ws.openAt('/last.txt')

    const saved = ws.serializeSession()

    expect(saved.tabs).toHaveLength(MAX_SESSION_TABS)
    // 最后那个标签被留下来了，而且落在末尾——panes 指得过去
    expect(saved.panes).toEqual([MAX_SESSION_TABS - 1])
    expect(saved.tabs[MAX_SESSION_TABS - 1]!.path).toBe('/last.txt')
    expect(saved.focused).toBe(0)
  })

  it('关窗时答「不保存」：被扔掉的草稿不会从存档里回来', async () => {
    // M1-F 与 M1-D 的接缝。存档收草稿的条件就是脏标记，所以「不保存」必须真的把
    // 文档清干净——否则那个确认对话框在撒谎：用户点了「不保存」，稿子下次启动照样在
    const pane = mounted({ promptDiscard: async () => 'discard' })
    await pane.ws.openAt('/a.txt')
    pane.type('不要了')
    expect(pane.ws.serializeSession().tabs[0]!.draft).toBe('正文不要了')

    expect(await pane.ws.requestWindowClose()).toBe(true)

    const saved = pane.ws.serializeSession()
    expect(saved.tabs[0]!.dirty).toBe(false)
    // 是 null 而不是空串：恢复时会重新读盘，用户看到的就是他要的那个「磁盘上的样子」
    expect(saved.tabs[0]!.draft).toBeNull()
  })

  it('未命名文档答「不保存」：正文一起清空，磁盘上没有它、正文就是唯一的副本', async () => {
    const pane = mounted({ promptDiscard: async () => 'discard' })
    pane.type('从没落过盘')
    expect(pane.ws.anyDirty()).toBe(true)

    expect(await pane.ws.requestWindowClose()).toBe(true)

    expect(pane.ws.anyDirty()).toBe(false)
    expect(pane.doc).toBe('')
    expect(pane.ws.serializeSession().tabs[0]!.draft).toBe('')
  })
})

describe('M2-D-4c：全局替换之后的对账', () => {
  /**
   * 这一组大多用**不挂编辑器**的 workspace：`dirtyPaths` 与 `reloadUnder` 只碰标签表与
   * 文档模型，而后台标签的 host 本来就走 snapshot 那条路。少起一个 CM6，十几条用例的
   * 耗时就下来了。「显示中的那个标签」另有一条挂真编辑器的用例（本 describe 最后一条）。
   */
  async function opened(...paths: string[]): Promise<Workspace> {
    const ws = createWorkspace()
    for (const at of paths) {
      // openAt 在「活动标签干净但已经有别的路径」时会新建一个标签，所以一个个开就是一个个标签
      await ws.openAt(at)
    }
    return ws
  }

  /** 这一轮对账真的去读了哪些文件。⚠️ 用之前先 `mockClear`，不然数到的是 openAt 那几趟 */
  function reread(): unknown[] {
    return ipc.openFile.mock.calls.map((c: unknown[]) => c[0])
  }

  it('dirtyPaths：一个都不脏时是空数组', async () => {
    const ws = await opened('/repo/a.ts', '/repo/b.ts')
    expect(ws.dirtyPaths()).toEqual([])
  })

  it('dirtyPaths：只收**有路径的**脏标签', async () => {
    const ws = await opened('/repo/a.ts')
    ws.newTab()
    // 未命名的那个也脏，但它收不进来：磁盘上没有它，落盘碰不到，不需要保护
    ws.activeTab().doc.markChanged()
    await ws.openAt('/repo/b.ts')
    ws.activeTab().doc.markChanged()

    // `/repo/a.ts` 干净，也不收
    expect(ws.dirtyPaths()).toEqual(['/repo/b.ts'])
  })

  it('dirtyPaths：保存之后立刻从清单里消失', async () => {
    const ws = await opened('/repo/a.ts')
    ws.activeTab().doc.markChanged()
    expect(ws.dirtyPaths()).toEqual(['/repo/a.ts'])

    await ws.save()

    // skip 清单是在**按下「替换全部」那一刻**才算的，所以刚存完盘的文件必须马上不在清单里，
    // 否则它会被白白跳过一轮，而用户看到的是一句「有 1 个文件正开着且有未保存的改动」的假话
    expect(ws.dirtyPaths()).toEqual([])
  })

  it('reloadUnder：只重读 root 底下的标签，兄弟前缀不算', async () => {
    const ws = await opened('/repo/a.ts', '/repo-other/b.ts', '/other/c.ts')
    ipc.openFile.mockClear()

    await ws.reloadUnder('/repo')

    // ⚠️ 前缀是 `'/repo/'` 而不是 `'/repo'`：少了那个斜杠，`/repo-other/b.ts` 会被当成
    // `/repo` 底下的一员。正文一样时 reload 什么都不写，但那一趟读盘已经发生了
    expect(reread()).toEqual(['/repo/a.ts'])
  })

  it('reloadUnder：root 带不带结尾斜杠都一样', async () => {
    const ws = await opened('/repo/a.ts')
    ipc.openFile.mockClear()

    await ws.reloadUnder('/repo/')

    // 项目根来自对话框，macOS 上选到卷根时它就是一个裸 `/`，两种写法都得认
    expect(reread()).toEqual(['/repo/a.ts'])
  })

  it('reloadUnder：未命名标签一次 IO 都不发', async () => {
    const ws = createWorkspace()
    ws.activeTab().doc.markChanged()
    ipc.openFile.mockClear()

    await expect(ws.reloadUnder('/repo')).resolves.toBe(0)

    expect(ipc.openFile).not.toHaveBeenCalled()
  })

  it('reloadUnder：脏标签不碰，也不算进返回值', async () => {
    const ws = await opened('/repo/a.ts')
    ws.activeTab().doc.markChanged()
    ipc.openFile.mockClear()

    await expect(ws.reloadUnder('/repo')).resolves.toBe(0)

    expect(ipc.openFile).not.toHaveBeenCalled()
    // 这里刻意**没有**再判一次 dirty：那条规矩只该有 `DocumentModel.reload` 一个真相来源。
    // 两边各写一遍的话哪天分岔，失败方式是「用户没保存的稿子被刚落盘的结果覆盖」
    expect(tabText(ws.activeTab())).toBe('正文')
  })

  it('reloadUnder：返回的是正文**真的**换过了的标签数，标签表本身一点没动', async () => {
    const ws = await opened('/repo/a.ts', '/repo/b.ts')
    const before = ws.tabs()
    ipc.openFile.mockImplementation(async (path: string) =>
      textFile({ text: path === '/repo/a.ts' ? '换过了' : '正文' }),
    )

    // b.ts 盘上没变 → reload 一个字都不动，也就不该被数进来（那个数是要报给用户的）
    await expect(ws.reloadUnder('/repo')).resolves.toBe(1)

    const [a, b] = ws.tabs()
    expect(tabText(a!)).toBe('换过了')
    expect(tabText(b!)).toBe('正文')
    // 对账不重建标签：重建的话每块分屏记着的 tabId 会全部失配
    expect(ws.tabs()).toBe(before)
  })

  it('reloadUnder：显示中的那个标签走真编辑器，正文与度量都跟着换，而且不算用户改动', async () => {
    const pane = mounted()
    await pane.ws.openAt('/repo/a.ts')
    expect(pane.doc).toBe('正文')
    ipc.openFile.mockResolvedValueOnce(textFile({ text: '换过了\n第二行' }))

    await expect(pane.ws.reloadUnder('/repo')).resolves.toBe(1)

    expect(pane.doc).toBe('换过了\n第二行')
    expect(pane.ws.metrics()).toMatchObject({ lines: 2, chars: 7 })
    // `replacing` 标志存在的理由在这里被真 CM6 考验一次：挡不住的话每个被重读的标签
    // 都会凭空变脏，关窗时的「有未保存的改动」就是这么来的
    expect(pane.ws.activeTab().doc.dirty()).toBe(false)
    expect(pane.ws.anyDirty()).toBe(false)
  })
})
