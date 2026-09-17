import { EditorSelection, StateEffect, StateField, type ChangeSpec, type EditorState } from '@codemirror/state'
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search'
import { EditorView, runScopeHandlers, type Command, type Panel, type ViewUpdate } from '@codemirror/view'

/**
 * 查找替换（M1-C-3）。
 *
 * 正则、整词、区分大小写、查找选中词、替换、全部替换——这些 CM6 的 `search()` 全都有，
 * 一件都不用重写。**唯一自己实现的是「保留大小写替换」**，因为 CM6 没有这个能力。
 *
 * 但 CM6 的面板没有这个开关的位置，所以整个面板换成自己的（`search({ createPanel })` 是
 * 官方扩展点，不是 DOM hack）。面板刻意照抄 CM6 `SearchPanel` 的结构与 class 名
 * （`.cm-search` / `.cm-textfield` / `.cm-button` / `[name=close]`），因为 `search()` 自带的
 * `baseTheme` 正是按这些选择器上色的——沿用它们就白拿一套已经过验证的样式，只多出一个
 * 复选框。`main-field` 这个属性也必须留着，`openSearchPanel` 靠它找到并聚焦输入框。
 *
 * ## 保留大小写只支持普通字符串查询，不支持正则
 *
 * CM6 的 `SearchQuery` 公开面只有那几个只读字段加一个 `getCursor(state, from?, to?)`，
 * 而 `matchAll` / `getReplacement` / 匹配结果上的 `match`（正则捕获组）全是 `@internal`。
 * 正则替换要展开 `$1` / `$&`，拿不到捕获组就做不到；自己重跑一遍正则去凑捕获组，又会在
 * 锚点、环视与跨行正则上与 CM6 的结果分叉。所以正则模式下这个复选框是**禁用**的，
 * 而不是假装能用。普通字符串查询的替换文本是字面量（`StringQuery.getReplacement` 就是
 * `unquote(replace)`，不做任何 `$` 展开），不需要捕获组，可以精确实现。
 */

export const setPreserveCase = StateEffect.define<boolean>()

/**
 * 「保留大小写」开关。
 *
 * 放进 EditorState 而不是面板实例：面板每次打开都是新建的，状态挂在实例上就等于
 * 每次打开查找都被重置成关，用户得重新点一遍。
 */
export const preserveCase = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setPreserveCase)) value = effect.value
    return value
  },
})

/** CM6 的 `SearchQuery.prototype.unquote` 标了 `@internal`，这里按同一规则自己写一份 */
export function unquote(query: SearchQuery, text: string): string {
  if (query.literal) return text
  return text.replace(/\\([nrt\\])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\',
  )
}

/** 有大小写之分的字符才算：数字、标点、汉字一律排除，否则 `123` 会被判成「全小写」 */
function isCased(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase()
}

function capitalize(text: string): string {
  const chars = [...text]
  const index = chars.findIndex(isCased)
  if (index < 0) return text
  chars[index] = chars[index]!.toUpperCase()
  return chars.join('')
}

/**
 * 按被匹配文本的大小写形状改写替换文本。
 *
 * - 全大写 → 替换文本转全大写（`FOO` → `BAR`）
 * - 全小写 → 替换文本转全小写（`foo` → `bar`）
 * - 首字母大写、其余小写 → 替换文本首字母大写（`Foo` → `Bar`）
 * - 混合、或压根没有带大小写的字符 → **原样**
 *
 * 三种形状都照搬被匹配文本，而不是「只在看得懂的时候改」：「保留大小写」这个名字承诺的就是
 * 匹配的形状说了算，全大写会转、全小写却不转，规则不对称。与 VS Code 的 preserve case 一致。
 *
 * 混合大小写按原样输出是刻意的：`fOO` 这种形状没有唯一的对应写法，猜不出来就别猜。
 * 首字母大写那一条也**只动第一个字母**，不把其余部分强制转小写——用户特地敲的大写不该被悄悄抹掉。
 */
export function matchCase(replacement: string, matched: string): string {
  if (replacement === '') return replacement
  const letters = [...matched].filter(isCased)
  if (letters.length === 0) return replacement
  if (letters.every((ch) => ch === ch.toUpperCase())) return replacement.toUpperCase()
  if (letters.every((ch) => ch === ch.toLowerCase())) return replacement.toLowerCase()
  const [first, ...rest] = letters
  if (first === first!.toUpperCase() && rest.every((ch) => ch === ch.toLowerCase())) return capitalize(replacement)
  return replacement
}

export interface Match {
  from: number
  to: number
}

/** CM6 的 `SearchCursor` 会先把文本与查询串都做 NFKD 归一化（大小写不敏感时再转小写），精确性重判要用同一套折叠 */
function caseFold(query: SearchQuery): (text: string) => string {
  return query.caseSensitive ? (text) => text.normalize('NFKD') : (text) => text.normalize('NFKD').toLowerCase()
}

/**
 * 逐个产出 `[from, to)` 里的匹配。用公开的 `getCursor`——它已经应用了整词过滤、
 * 大小写折叠与 `test`，所以产出的匹配集合与 CM6 自己高亮出来的那一批一致。
 *
 * CM6 内部的匹配结果还带一个 `precise` 标记，它没进公开类型：匹配边界落在「NFKD 归一化后
 * 会展开成多个字符」的那个字里面时为 false，表示 `from..to` 盖住了不属于匹配的内容
 * （查 `1` 会在 `½` 上命中，但区间是整个 `½`）。CM6 的 `replaceAll` 会跳过这种匹配，
 * 这里用公开 API 重判一次——精确匹配的区间文本归一化后必然等于查询串，不精确的会更长，
 * 比较自然失败。正则查询恒为精确（`RegExpCursor` 的文档写明了这点），不用判。
 *
 * `limit` 是硬上限：扫描成本随文档长度线性增长，4MB 的文档不能不设防。
 */
function* iterateMatches(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
  limit: number,
): Generator<Match> {
  const fold = caseFold(query)
  const foldedWanted = query.regexp ? '' : fold(unquote(query, query.search))
  let found = 0
  const cursor = query.getCursor(state, from, to)
  for (let step = cursor.next(); !step.done && found < limit; step = cursor.next()) {
    const match = step.value
    if (!query.regexp && fold(state.sliceDoc(match.from, match.to)) !== foldedWanted) continue
    found++
    yield { from: match.from, to: match.to }
  }
}

export function collectMatches(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
  limit: number,
): Match[] {
  return [...iterateMatches(state, query, from, to, limit)]
}

/**
 * 当前选区是否**正好**是一个匹配。只扫选区那一段；整词的边界仍按全文判
 * （`SearchCursor` 读的是 `state.doc`，不是被截出来的那一段）。
 */
function isMatchAt(state: EditorState, query: SearchQuery, from: number, to: number): boolean {
  if (from === to) return false
  for (const match of iterateMatches(state, query, from, to, 1)) return match.from === from && match.to === to
  return false
}

/**
 * `from` 之后的第一个匹配，没有就从文档开头绕回。
 *
 * 两段都是**有界**游标，这是刻意的：按一次「替换下一个」不该把整篇文档扫一遍——
 * 4MB 的日志上那意味着每敲一次键都新建一个十万级的数组。
 */
function firstMatchAfter(state: EditorState, query: SearchQuery, from: number): Match | null {
  const length = state.doc.length
  const windows: [number, number][] = [
    [from, length],
    [0, Math.min(from, length)],
  ]
  for (const [start, end] of windows) {
    for (const match of iterateMatches(state, query, start, end, 1)) return match
  }
  return null
}

/** 1e9 与 CM6 `replaceAll` 传给 `matchAll` 的上限一致，实际上就是「不设限」 */
const NO_LIMIT = 1e9

function preservingCase(state: EditorState): boolean {
  // 见模块文档：正则下拿不到捕获组，这个开关不生效
  return state.field(preserveCase) && !getSearchQuery(state).regexp
}

function replaceAllPreserving(view: EditorView): boolean {
  const { state } = view
  const query = getSearchQuery(state)
  const replacement = unquote(query, query.replace)
  const matches = collectMatches(state, query, 0, state.doc.length, NO_LIMIT)
  if (matches.length === 0) return false
  const changes: ChangeSpec[] = matches.map((m) => ({
    from: m.from,
    to: m.to,
    insert: matchCase(replacement, state.sliceDoc(m.from, m.to)),
  }))
  view.dispatch({ changes, userEvent: 'input.replace.all' })
  return true
}

function replaceNextPreserving(view: EditorView): boolean {
  const { state } = view
  const query = getSearchQuery(state)
  const { from, to } = state.selection.main

  // CM6 的语义：当前选区正好是一个匹配才替换，否则这一下只是跳过去。
  // 照抄这条，否则「按一次替换」会在用户还没看清匹配时就改掉文档。
  if (!isMatchAt(state, query, from, to)) {
    const next = firstMatchAfter(state, query, to)
    if (!next) return false
    view.dispatch({
      selection: EditorSelection.range(next.from, next.to),
      effects: EditorView.scrollIntoView(next.to),
      userEvent: 'select.search',
    })
    return true
  }

  const insert = matchCase(unquote(query, query.replace), state.sliceDoc(from, to))
  const changes = state.changes({ from, to, insert })
  // 下一处在**改动前**的文档里找，再跟着 changes 映射过去：改动后的位置自己算是重复实现
  const following = firstMatchAfter(state, query, to)
  const selection = following ? EditorSelection.single(following.from, following.to).map(changes) : null
  view.dispatch({
    changes,
    // 没有下一处（整篇就这一个匹配）时不硬造选区，让 CM6 按 changes 自动映射当前选区
    ...(selection ? { selection } : {}),
    effects: EditorView.scrollIntoView(selection ? selection.main.head : changes.mapPos(to)),
    userEvent: 'input.replace',
  })
  return true
}

/**
 * 「替换下一个」。**保留大小写关着时原样转交 CM6 的 `replaceNext`**——不重写它，
 * 免得两条路径的行为随时间慢慢漂开（CM6 那条还管着无障碍播报与滚动对齐）。
 */
export const replaceNextCommand: Command = (view) => {
  if (!preservingCase(view.state)) return replaceNext(view)
  // CM6 `searchCommand` 的兜底：查询为空或非法时不算失败，而是把面板打开让用户先填
  if (!getSearchQuery(view.state).valid) return openSearchPanel(view)
  return replaceNextPreserving(view)
}

/** 「全部替换」。同 `replaceNextCommand`，保留大小写关着就转交 CM6 的 `replaceAll` */
export const replaceAllCommand: Command = (view) => {
  if (!preservingCase(view.state)) return replaceAll(view)
  if (!getSearchQuery(view.state).valid) return openSearchPanel(view)
  return replaceAllPreserving(view)
}

// ---------- 面板 ----------

/**
 * `never` 参数位是为了让任意形状的事件处理函数都能赋进来（`() => void`、
 * `(e: KeyboardEvent) => void` 都算），同时又把对象/数组挡在联合类型外面——
 * `setAttribute` 只吃字符串，值类型留成 `unknown` 的话 `String(value)` 会静默
 * 往 DOM 属性里写 `[object Object]`。
 */
type AttrHandler = (event: never) => void

type AttrValue = string | number | boolean | AttrHandler | null | undefined

function elt<T extends HTMLElement>(
  tag: string,
  attrs: Record<string, AttrValue> | null = null,
  children: (Node | string)[] = [],
): T {
  const node = document.createElement(tag) as T
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined) continue
    // `value` / `checked` / `onchange` 是属性，`main-field` / `aria-label` 只能是 attribute。
    // `form` 是个例外：它 `in node` 为真，但 IDL 里是 readonly，ES 模块的严格模式下赋值直接抛
    // TypeError，只能走 setAttribute。
    if (key === 'form' || !(key in node)) node.setAttribute(key, String(value))
    else (node as unknown as Record<string, unknown>)[key] = value
  }
  for (const child of children) node.append(child)
  return node
}

/**
 * 自建面板。结构与 CM6 `SearchPanel` 一一对应，只在三个复选框后面多插一个「保留大小写」。
 *
 * 用原生 DOM 而不是 Solid：面板生命周期由 CM6 管（`mount` / `update` / `destroy`），
 * 而它要的只是几个 input 与 button。挂一套响应式运行时进来，换来的只有卸载时机的麻烦。
 */
class FindReplacePanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true

  private query: SearchQuery
  private preserving: boolean
  private readonly searchField: HTMLInputElement
  private readonly replaceField: HTMLInputElement
  private readonly caseField: HTMLInputElement
  private readonly reField: HTMLInputElement
  private readonly wordField: HTMLInputElement
  private readonly preserveField: HTMLInputElement

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state)
    this.preserving = view.state.field(preserveCase)

    const field = (name: string, label: string, value: string): HTMLInputElement =>
      elt<HTMLInputElement>('input', {
        class: 'cm-textfield',
        name,
        placeholder: label,
        'aria-label': label,
        // `form=""` 让输入框不属于任何表单，回车才不会触发页面级提交
        form: '',
        value,
        // `main-field` 不能省：openSearchPanel 靠 querySelector('[main-field]') 找输入框
        ...(name === 'search' ? { 'main-field': 'true' } : {}),
        onchange: () => this.commit(),
        onkeyup: () => this.commit(),
      })
    this.searchField = field('search', '查找', this.query.search)
    this.replaceField = field('replace', '替换为', this.query.replace)

    const toggle = (name: string, checked: boolean): HTMLInputElement =>
      elt<HTMLInputElement>('input', {
        type: 'checkbox',
        name,
        form: '',
        checked,
        onchange: () => this.commit(),
      })
    this.caseField = toggle('case', this.query.caseSensitive)
    this.reField = toggle('re', this.query.regexp)
    this.wordField = toggle('word', this.query.wholeWord)
    this.preserveField = toggle('preserveCase', this.preserving)

    const button = (name: string, label: string, onclick: () => void): HTMLButtonElement =>
      elt<HTMLButtonElement>('button', { class: 'cm-button', name, type: 'button', onclick }, [label])

    this.dom = elt<HTMLDivElement>('div', { class: 'cm-search', onkeydown: (e: KeyboardEvent) => this.keydown(e) }, [
      this.searchField,
      button('next', '下一个', () => findNext(view)),
      button('prev', '上一个', () => findPrevious(view)),
      button('select', '全部选中', () => selectMatches(view)),
      elt('label', null, [this.caseField, '区分大小写']),
      elt('label', null, [this.reField, '正则']),
      elt('label', null, [this.wordField, '整词']),
      elt('label', { title: '把替换文本改成与被匹配文本一致的大小写形状（正则模式下不可用）' }, [
        this.preserveField,
        '保留大小写',
      ]),
      elt('br'),
      this.replaceField,
      button('replace', '替换', () => replaceNextCommand(view)),
      button('replaceAll', '全部替换', () => replaceAllCommand(view)),
      elt<HTMLButtonElement>(
        'button',
        { name: 'close', type: 'button', 'aria-label': '关闭', onclick: () => closeSearchPanel(view) },
        ['×'],
      ),
    ])

    this.syncPreserveAvailability()
  }

  private commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked,
    })
    // 正则下保留大小写不生效（见模块文档）。勾着正则时强制关掉，
    // 而不是让复选框看着是开的、行为却是关的。
    const preserving = this.preserveField.checked && !query.regexp

    const effects: StateEffect<SearchQuery | boolean>[] = []
    if (!query.eq(this.query)) {
      this.query = query
      effects.push(setSearchQuery.of(query))
    }
    if (preserving !== this.preserving) {
      this.preserving = preserving
      effects.push(setPreserveCase.of(preserving))
    }
    if (effects.length > 0) this.view.dispatch({ effects })
    this.syncPreserveAvailability()
  }

  /** 勾了正则就禁用「保留大小写」并把勾去掉——禁用却仍打勾是最容易被误解的状态 */
  private syncPreserveAvailability() {
    const blocked = this.reField.checked
    this.preserveField.disabled = blocked
    if (blocked) this.preserveField.checked = false
  }

  private keydown(e: KeyboardEvent) {
    // 先让 scope 处理器有机会吃掉 Escape：closeSearchPanel 只在 "search-panel" scope 里生效
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault()
    } else if (e.key === 'Enter' && e.target === this.searchField) {
      e.preventDefault()
      ;(e.shiftKey ? findPrevious : findNext)(this.view)
    } else if (e.key === 'Enter' && e.target === this.replaceField) {
      e.preventDefault()
      replaceNextCommand(this.view)
    }
  }

  /** CM6 在 state 变化后调这里：查询或开关被别处改掉时把控件同步回来 */
  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.setQuery(effect.value)
        else if (effect.is(setPreserveCase) && effect.value !== this.preserving) this.setPreserving(effect.value)
      }
    }
  }

  private setQuery(query: SearchQuery) {
    this.query = query
    this.searchField.value = query.search
    this.replaceField.value = query.replace
    this.caseField.checked = query.caseSensitive
    this.reField.checked = query.regexp
    this.wordField.checked = query.wholeWord
    this.syncPreserveAvailability()
  }

  private setPreserving(value: boolean) {
    this.preserving = value
    this.preserveField.checked = value
  }

  mount() {
    this.searchField.select()
  }
}

export function createFindReplacePanel(view: EditorView): Panel {
  return new FindReplacePanel(view)
}
