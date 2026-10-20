import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from '@codemirror/state'
import { EditorView, gutter, GutterMarker, type Command } from '@codemirror/view'

/**
 * 书签（M4-J，PLAN §1.4 的 P1「书签与断点式标记」，2026-10-20 用户定了口径）。
 * ⚠️ 只交付了「书签」那一半：Vela 不调试代码，「断点」没有承接它的运行时。
 *
 * ## 🔴 它是**内存态**的：不存盘、不进 session、关标签就没
 *
 * 这一条是用户选的，不是偷懒。要跨重启活着就得进 `session.json`，而那意味着
 * **改 Rust 的 `SessionTab` 结构体**（`crates/vela-core/src/session/mod.rs`）+
 * 改 `tests/wire_contract.rs` 里的黄金字面量 + 改前端那份孪生黄金（`src/ipc/session.test.ts`
 * 里还有一个手数的「16 个字段」）。为一个 P1 功能动线上契约，代价与收益不成比例。
 *
 * 于是书签只活在**当前标签的 `EditorState`** 里：切标签跟着标签走（`EditorController.capture`
 * / `restore` 存的就是整个 state），而打开文件 / reload / 恢复草稿都走 `tab.ts` 的
 * `replaceTabText`——那是**重建整个 state**，字段跟着归零，不需要任何清理代码
 * （与 `editor/changeGutter.ts` 同一条机制）。
 *
 * ⚠️ 与「未保存改动」gutter 的**关键区别**：那个存盘时要显式 dispatch `resetChanges`
 * 清空（因为存盘不换正文），而书签**没有任何自动清空时机**——存盘不动它，改语言不动它。
 * 要清只有两条路：逐个 toggle，或者 `clearBookmarks` 命令。
 *
 * ## 交互面：gutter 圆点 + 四条命令，⛔ 没有书签列表面板
 *
 * 用户选的。gutter 那一列**可以点**（点一下切一个书签），于是鼠标党不必记快捷键。
 * 面板被砍掉是有代价的：一份长文档里「我都标了哪儿」只能靠滚，`Cmd+R` 那张符号表里
 * 也没有书签。这笔账记在这儿，将来真要补就是补一个面板，不是改这个字段。
 *
 * ## 撤销**不**管书签
 *
 * 字段的变更不进 CM6 的 history（history 只追踪 doc 与 selection），所以：
 * ① `Cmd+Z` 撤不掉一次 toggle；② 删掉一行会连带删掉它上面的书签，而撤销那次删除
 * **不会**把书签带回来。②是真会咬人的那条，见下面 `followDoc` 的注释。
 */

/**
 * 在**新文档**坐标下切一个书签：值是该行的行起点。
 *
 * 用行起点而不是行号：行号在插入/删除之后全都要重算，而位置会被 `RangeSet.map` 带着走。
 * 带 `null` 的是 `clearAllBookmarks`——它只是一个信号，不携带数据。
 */
export const toggleBookmarkAt = StateEffect.define<number>()
export const clearAllBookmarks = StateEffect.define<null>()

/**
 * 空集。
 *
 * ⚠️ 这个 `as` 是 CM6 的类型瑕疵逼出来的：`RangeSet.empty` 在 d.ts 里被写成
 * `RangeSet<any>`（`node_modules/@codemirror/state/dist/index.d.ts:1649`），
 * 于是把它赋给一个强类型变量会撞上 `no-unsafe-assignment`。`return RangeSet.empty`
 * 不会（那是返回不是赋值，`changeGutter.ts` 就是这么写的），偏偏这里要**赋值**——
 * 因为同一个事务里可能既有正文变化又有 effect。收在这一个常量里，别处都用它。
 */
const NO_BOOKMARKS = RangeSet.empty as RangeSet<GutterMarker>

/**
 * 单例。`GutterMarker` 按**身份**比较（`sameMarkers`），重复 new 会让 gutter 每次重画。
 *
 * 🔴 `startSide = 1` 不是随手写的，它是这个字段唯一一处非显然的 CM6 细节：
 *
 * point range（`from === to`）过 `RangeSet.map` 时，落点由 `changes.mapPos(pos, val.startSide)`
 * 决定（`node_modules/@codemirror/state/dist/index.js:3109`）。默认的 `startSide = 0` 表示
 * 「插在我前面的内容不算我的」，于是在**书签行的行首插入一整行**时，书签会留在原地——
 * 而原地现在是**新插入的那一行**，用户标的那行已经掉到下面去了。探针量过：
 *
 * ```
 * doc "aa\nbb\ncc\ndd\n"，书签在第 2 行（pos 3），在 pos 3 插入 "x\n"
 *   startSide = 0 → pos 3，第 2 行，内容是 "x"      ← 错位
 *   startSide = 1 → pos 5，第 3 行，内容是 "bb"     ← 跟着原行走
 * ```
 *
 * 代价是行首**插入文字**时它会跟着往后挪一位（不再是行首），所以 `update` 里每次映射完
 * 都要重新吸附到行首——那一步顺便保证了下面这条不变式。
 * `endSide` 一起设成 1 是因为两者不等时 map 会走另一条分支（同文件 :3113）。
 */
class BookmarkMarker extends GutterMarker {
  startSide = 1
  endSide = 1

  constructor() {
    super()
    // 加在 `.cm-gutterElement` 上，圆点由 styles.css 的 `::before` 画（见 `.cm-bookmarkGutter`）
    this.elementClass = 'vela-bookmark'
  }
}

export const BOOKMARK = new BookmarkMarker()

/**
 * 占位标记，只为**预留 gutter 宽度**：没有它的话这一列宽度是 0，第一个书签出现时
 * 整篇正文会往右跳一下。它不带颜色（CSS 里只有 `.cm-bookmarkGutter` 的 `min-width`）。
 */
const SPACER = new (class extends GutterMarker {
  elementClass = 'vela-bookmark-spacer'
})()

/**
 * 字段的两条不变式，`update` 的末尾负责兜住：
 * 1. 每个标记都落在**某一行的行首**；
 * 2. **每行至多一个**标记。
 *
 * 第 1 条是 gutter 能正确渲染的前提（`gutter` 用 `advanceCursor(cursor, …, line.from)`
 * 精确匹配行首，落在行中间的标记压根不会被画出来）。第 2 条防的是「删掉两行之间的换行」
 * 把两个书签挤到同一行——不去重的话那一格会叠一摞，而且 toggle 会变得没法预测。
 */
export const bookmarkMarks = StateField.define<RangeSet<GutterMarker>>({
  create: () => NO_BOOKMARKS,

  update(marks, tr) {
    // 绝大多数事务与书签无关（打字、移光标、滚视口）。这一行是热路径上的挡板
    if (!tr.docChanged && tr.effects.length === 0) return marks

    let next = tr.docChanged ? followDoc(marks, tr) : marks

    // effect 里的位置是**新文档**坐标，所以必须在映射之后应用
    for (const effect of tr.effects) {
      if (effect.is(clearAllBookmarks)) next = NO_BOOKMARKS
      else if (effect.is(toggleBookmarkAt)) next = toggle(next, effect.value)
    }
    return next
  },
})

/** 有没有落在 `lineFrom`（行首）上的书签 */
function has(marks: RangeSet<GutterMarker>, lineFrom: number): boolean {
  let found = false
  marks.between(lineFrom, lineFrom, () => {
    found = true
  })
  return found
}

function toggle(marks: RangeSet<GutterMarker>, lineFrom: number): RangeSet<GutterMarker> {
  if (has(marks, lineFrom)) return marks.update({ filter: (from) => from !== lineFrom })
  return marks.update({ add: [BOOKMARK.range(lineFrom)], sort: true })
}

/**
 * 正文变了：先扔掉「行已经不存在了」的书签，再让剩下的跟着正文挪，最后重新吸附到行首。
 *
 * ## 🔴 那一步「扔掉」是必需的，`map` 自己不干这件事
 *
 * 探针量过（doc `aa\nbb\ncc\ndd\n`，书签在第 2 行 pos 3）：把 `bb\n` 整行删掉之后，
 * `map` 把书签**原样留在 pos 3**——而 pos 3 现在是 `cc` 那一行。也就是说
 * 「删掉我标过的那一行」的结果是书签悄悄转移到了另一行上。那不是跟随，是张冠李戴。
 *
 * 判据是「这一行**整行**被某段删除覆盖」，即 `fromA <= line.from && line.to < toA`
 * （`line.to` 是行尾那个换行的位置，`toA > line.to` 意味着换行也被删了）。四种情况量过：
 *
 * | 删除区间 | 结果 | 该不该留 |
 * |---|---|---|
 * | `[3,6)` = `bb\n` 整行 | 覆盖 `[3,5]` | ⛔ 扔掉 |
 * | `[3,5)` = 只删文字、留换行 | 不覆盖换行 | ✅ 留（行还在，只是空了） |
 * | `[5,6)` = 只删换行、与下一行并起来 | 没盖到行首 | ✅ 留（行还在，只是变长了） |
 * | `[0,11)` = 整篇换掉 | 覆盖 | ⛔ 扔掉 |
 *
 * ⚠️ 判据用的是**旧文档**坐标，所以要在 `map` 之前算。
 * ⚠️ 最后一行（`line.to === doc.length`，没有结尾换行）永远不会被这条判据命中——
 * 换掉整篇时它靠 `map` 自己掉（`mapPos` 返回 null 就 `continue` 掉了，见 :3110）。
 */
function followDoc(marks: RangeSet<GutterMarker>, tr: Transaction): RangeSet<GutterMarker> {
  if (marks.size === 0) return marks

  const deleted: [number, number][] = []
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (toA > fromA) deleted.push([fromA, toA])
  })
  // 纯插入（没有删除区间）不可能毁掉任何一行
  if (deleted.length > 0) {
    const before = tr.startState.doc
    const gone = new Set<number>()
    marks.between(0, before.length, (from) => {
      const line = before.lineAt(from)
      if (deleted.some(([fromA, toA]) => fromA <= line.from && line.to < toA)) gone.add(from)
    })
    if (gone.size > 0) marks = marks.update({ filter: (from) => !gone.has(from) })
    if (marks.size === 0) return marks
  }

  // 剩下的跟着正文挪。⚠️ 这一步不能省：`gone` 那一步是在**旧文档**坐标下算的，
  // 少了 `map` 就会拿旧位置去新文档里查行——「在顶上插一行」会让所有书签跑到第 1 行去
  const mapped = marks.map(tr.changes)

  // 重新吸附到行首并按行去重（见字段上那两条不变式）。
  // 书签是个位数的量级，重建一次比维护增量便宜，也不必证明「增量一定对」
  const lines = new Set<number>()
  const doc = tr.state.doc
  mapped.between(0, doc.length, (from) => {
    lines.add(doc.lineAt(from).from)
  })
  return RangeSet.of(
    [...lines].sort((a, b) => a - b).map((from) => BOOKMARK.range(from)),
    true,
  )
}

/** 所有书签的行起点，升序。命令与测试都用它，不让第二处去碰 `RangeSet` 的游标 */
export function bookmarkPositions(state: EditorState): number[] {
  const out: number[] = []
  state.field(bookmarkMarks).between(0, state.doc.length, (from) => {
    out.push(from)
  })
  return out
}

/**
 * 从当前光标出发，往 `dir` 方向找下一个书签的行起点；一个书签都没有时返回 `null`。
 *
 * 纯函数，不碰 view——于是它能在 node 环境里被单测钉死。
 *
 * 🔴 **走到头会回卷**（最后一个之后再按「下一个」回到第一个），与 Sublime / VS Code 一致：
 * 「下一个书签」这个动作的意义是循环巡检，走到头就停住的话用户得先确认自己在哪一头。
 *
 * ⚠️ 比的是**行**而不是位置：光标停在一个书签行的行中间时，「下一个」给的是再下面那个书签，
 * 而不是同一行的这一个。用 `line.from` 而不是 `head` 做基准正是为了这件事。
 *
 * ⚠️ 只看主选区（`selection.main`）。多光标下按「下一个书签」跳的是主光标那一处——
 * 跳完之后其余光标会被这次 `selection` 覆盖掉，这是 CM6 dispatch 的既有语义，不是这里的选择。
 */
export function bookmarkTarget(state: EditorState, dir: 1 | -1): number | null {
  const marks = bookmarkPositions(state)
  const current = state.doc.lineAt(state.selection.main.head).from
  if (dir > 0) {
    for (const pos of marks) if (pos > current) return pos
  } else {
    for (let i = marks.length - 1; i >= 0; i--) {
      const pos = marks[i]
      if (pos !== undefined && pos < current) return pos
    }
  }
  // 走到头回卷。`marks` 为空时这两个下标都给 `undefined`，于是 `?? null` 一并答了
  // 「一个书签都没有」那种情况，不必再判一次长度
  return (dir > 0 ? marks[0] : marks[marks.length - 1]) ?? null
}

/** 切换光标所在行的书签。⚠️ 不进撤销栈，见文件头 */
export const toggleBookmark: Command = (view) => {
  const { state } = view
  view.dispatch({ effects: toggleBookmarkAt.of(state.doc.lineAt(state.selection.main.head).from) })
  return true
}

/**
 * 跳到某一行：选中行首，把它带到视口中间，然后拿回焦点。
 *
 * 一次 dispatch 做完前两件事，与 `editor/controller.ts` 的 `reveal` 逐字同一条理由——
 * 分成两次的话中间那帧会画出「光标已经跳了但还没滚过去」的样子。`y: 'center'` 也一样：
 * 贴着视口边缘的话，人真正想看的上下文正好被裁掉。
 *
 * ⛔ 没有复用 `EditorController.reveal`：那是 App 那一层的对象，而这个模块是纯 CM6 的，
 * 让它反向依赖 controller 就没法在裸 state / 裸 view 里单测了。
 */
function jump(view: EditorView, dir: 1 | -1): boolean {
  const target = bookmarkTarget(view.state, dir)
  if (target === null) return false
  view.dispatch({
    selection: { anchor: target },
    effects: EditorView.scrollIntoView(target, { y: 'center' }),
  })
  view.focus()
  return true
}

/** 跳到下一个书签。⚠️ 一个书签都没有时**静默什么都不做**（返回 false） */
export const nextBookmark: Command = (view) => jump(view, 1)
/** 跳到上一个书签。同上 */
export const prevBookmark: Command = (view) => jump(view, -1)

export const clearBookmarks: Command = (view) => {
  view.dispatch({ effects: clearAllBookmarks.of(null) })
  return true
}

/**
 * 把字段与 gutter 捆成一个扩展。挂在 `setup.ts` 的 `lineNumbers()` 之后、`changeGutter()` 之前——
 * 顺序决定它在行号右边、「未保存改动」竖条左边。
 *
 * 🔴 整列**一直占着** 12px，哪怕一个书签都没有。做到「有才出现」需要一个 Compartment 加上
 * 「书签数从 0 变 1」时的重配，而那要把状态抬到 workspace 去——为一个 P1 的观感问题不值当。
 */
export function bookmarkGutter(): Extension {
  return [
    bookmarkMarks,
    gutter({
      class: 'cm-bookmarkGutter',
      markers: (view: EditorView) => view.state.field(bookmarkMarks),
      initialSpacer: () => SPACER,
      domEventHandlers: {
        mousedown(view, line, event) {
          // 只认左键：右键留给（将来可能的）上下文菜单，中键是滚动。
          // ⚠️ CM6 把这里的 event 类型写成基类 `Event`（`Handlers`，view/dist/index.d.ts:2303），
          // 而 `button` 长在 `MouseEvent` 上——`mousedown` 这个键名下它必然是 MouseEvent
          if ((event as MouseEvent).button !== 0) return false
          // `line` 是 `BlockInfo`，自动换行时它是**视觉行**；书签是按文档行算的，
          // 所以先吸附到文档行首——点一个折行段落的任何一截，切的都是同一个书签
          const at = view.state.doc.lineAt(line.from).from
          view.dispatch({ effects: toggleBookmarkAt.of(at) })
          // 返回 true 让 CM6 `preventDefault`：这一下不该顺带把焦点从编辑器里拿走
          return true
        },
      },
    }),
  ]
}
