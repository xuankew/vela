import { RangeSet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { gutter, GutterMarker, type EditorView } from '@codemirror/view'

/**
 * 「未保存改动」gutter（#28，累积改动路线）。
 *
 * ## 🔴 它**不是** git gutter，也**不**对比磁盘上的基线文本
 *
 * 这一条曾经叫「Git gutter」，用户在 2026-10-19 明确选了**累积改动**这一路，理由与
 * `doc/document.ts` 的脏标记哲学逐字相同：`dirty` 是**只增不减**的（撤销回到已保存状态
 * 时它仍然是脏的），因为「每次按键比对全文」不值当（见 document.ts `markChanged` 的注释）。
 * 真·行级 diff 要在 `DocumentModel` 里存一份 `savedText` 基线、再写一个 Myers diff，
 * 大文件每次改动都要重算——那条路是给「对比 HEAD」准备的，而 git 那半边已经缓议。
 *
 * 于是这里的语义是：**自上次「与磁盘一致」以来被碰过的行**。它与 `dirty` 是一对——
 * `dirty` 说「这个文档整体脏了」，gutter 说「脏在哪几行」。取舍也一样：把一行改了又改回去，
 * 标记**不会**消失（要消失就得比对全文，正是不做的那件事）；存盘 / 打开 / reload 会整体清空。
 *
 * ## ⚠️ 标记的三分类是「改动形状」推出来的，⛔ 不是「与基线比出来的」
 *
 * 没有基线就无从知道一行到底是新增还是改写，只能看这次事务的 `ChangeSet` 长什么样：
 * 纯插入（旧侧空）→ `added`；纯删除（新侧空）→ `deleted`；替换（两侧都非空）→ `modified`。
 * 所以「在一行中间插入几个字符」会标成 `added` 而不是 `modified`——这是诚实的近似，
 * 不是 bug。颜色沿用八套主题都有的语义 token：`--vela-ok` / `--vela-accent` / `--vela-bad`。
 *
 * ## 清空时机只有一处需要显式触发
 *
 * 打开 / reload / 恢复草稿都走 `tab.ts` 的 `replaceTabText`，那是**重建整个 state**——
 * 字段跟着新 state 一起归零，不需要任何额外动作。唯一「正文不动、却该清空」的是**存盘**
 * （`document.ts` 的 `writeTo`：只 `setDirty(false)`，buffer 原样留着），所以那里要 dispatch
 * 一个 `resetChanges`。接线见 `doc/workspace.ts` 的 `host.clearChangeMarks`。
 */

/** 存盘成功之后清空累积的改动标记。带 `null` 是因为它只是一个信号，不携带数据 */
export const resetChanges = StateEffect.define<null>()

/** 三种标记 + 一个占位。用单例：`GutterMarker` 按身份比较，重复 new 会让 gutter 每次重画 */
type ChangeKind = 'added' | 'modified' | 'deleted'

class ChangeMarker extends GutterMarker {
  /** 测试读它来断言「这一行被标成了哪一种」。渲染只认 `elementClass` */
  readonly kind: ChangeKind

  constructor(kind: ChangeKind) {
    super()
    this.kind = kind
    // 加在 `.cm-gutterElement` 上，颜色由 styles.css 的 `::before` 竖条画（见 `.cm-changeGutter`）
    this.elementClass = `vela-change-${kind}`
  }
}

export const ADDED_MARK = new ChangeMarker('added')
export const MODIFIED_MARK = new ChangeMarker('modified')
export const DELETED_MARK = new ChangeMarker('deleted')

/**
 * 占位标记，只为**预留 gutter 宽度**：没有它的话，一个还没改动过的文档那一列宽度是 0，
 * 第一处改动出现时整篇正文会往右跳一下。它不带颜色（styles.css 里 `.vela-change-spacer`
 * 只给宽度、不画竖条）。
 */
const SPACER = new (class extends GutterMarker {
  elementClass = 'vela-change-spacer'
})()

/**
 * 累积「被碰过的行」。值是一个 `RangeSet<GutterMarker>`，每行至多一个标记。
 *
 * 三个动作，顺序不能乱：
 * 1. `resetChanges` → 直接清空（存盘）。
 * 2. `map(tr.changes)` → 已有标记跟着正文一起挪：在第 3 行上面插一行，原来第 3 行的标记
 *    要移到第 4 行，否则标记会钉在错误的行上。
 * 3. 把这次事务改动的行并进去，并按行去重（`filter` 掉同位置的旧标记再 `add`）——
 *    不去重的话，反复编辑同一行会在一个 gutter 格里叠一摞标记，只增不减。
 */
export const changeMarks = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,

  update(marks, tr) {
    if (tr.effects.some((e) => e.is(resetChanges))) return RangeSet.empty
    // 只有正文变化才可能产生新标记；纯选区 / 视口变化原样带过（map 是 no-op）
    if (!tr.docChanged) return marks

    const mapped = marks.map(tr.changes)
    const doc = tr.state.doc
    const add: Range<GutterMarker>[] = []

    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      // 纯删除：新侧是空区间，标记落在删除点所在的那一行（新文档里顶上来的那一行）
      if (fromB === toB) {
        add.push(DELETED_MARK.range(doc.lineAt(Math.min(fromB, doc.length)).from))
        return
      }
      // 纯插入 vs 替换：旧侧空 = 插入。分类的理由与近似见文件头
      const marker = fromA === toA ? ADDED_MARK : MODIFIED_MARK
      // 改动区间是**新文档**里的 [fromB, toB)。两端都可能正好落在一行的边界上，
      // 直接 lineAt 会把没被碰的邻行也算进来，所以各吸附一次：
      //  ⚠️ 起点若正好是某一行的结尾（插入的内容以换行开头，另起了一行），真正的新内容
      //     从**下一行**才开始——把前面那一行标上是假阳性（它的文本一个字都没变）
      const startLine = doc.lineAt(fromB)
      const startPos = startLine.to === fromB && fromB < doc.length ? fromB + 1 : fromB
      //  ⚠️ 终点若正好是某一行的开头，改动到它前面就结束了，那一行不该被标
      const endLine = doc.lineAt(toB)
      const endPos = endLine.from === toB && toB > 0 ? toB - 1 : toB
      // 逐行标过去：改动可能横跨新文档里的多行（粘了一段带换行的文本）
      let pos = startPos
      for (;;) {
        const line = doc.lineAt(pos)
        add.push(marker.range(line.from))
        if (line.to >= endPos) break
        pos = line.to + 1
      }
    })

    if (add.length === 0) return mapped
    // 同一行这次又被碰了：先滤掉旧标记再加新的，保证「每行至多一个」
    const touched = new Set(add.map((r) => r.from))
    return mapped.update({ filter: (from) => !touched.has(from), add, sort: true })
  },
})

/**
 * 把字段与 gutter 捆成一个扩展。挂在 `setup.ts` 的 `lineNumbers()` 之后——
 * 顺序决定它在行号右边、折叠槽左边。
 */
export function changeGutter(): Extension {
  return [
    changeMarks,
    gutter({
      class: 'cm-changeGutter',
      markers: (view: EditorView) => view.state.field(changeMarks),
      // 预留宽度，免得第一处改动出现时正文横向跳一下
      initialSpacer: () => SPACER,
    }),
  ]
}
