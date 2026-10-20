import { EditorSelection, EditorState, type ChangeSpec, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import {
  bookmarkMarks,
  bookmarkPositions,
  bookmarkTarget,
  clearAllBookmarks,
  clearBookmarks,
  nextBookmark,
  prevBookmark,
  toggleBookmark,
  toggleBookmarkAt,
} from './bookmarks'

/**
 * 只测字段与四条命令，⛔ 不建真 `EditorView`：gutter 的渲染是 DOM/CSS，node 环境里量不出
 * （与 `changeGutter.test.ts` 同一条）。
 *
 * 但命令要跑，就得有个能收 `TransactionSpec` 的假 view——`builtins.test.ts` 的
 * `fakeEditorWithDoc` 收的是**已经建好的** `Transaction`（所以那边只有 StateCommand 跑得动），
 * 而书签这四条是 `Command`（`jump` 要 `view.focus()`）。于是这里自己造一个。
 */
function fakeView(doc: string, selection?: number) {
  let current = EditorState.create({
    doc,
    ...(selection === undefined ? {} : { selection: EditorSelection.cursor(selection) }),
    extensions: [bookmarkMarks],
  })
  const focus = vi.fn()
  const view = {
    get state() {
      return current
    },
    dispatch(spec: TransactionSpec) {
      current = current.update(spec).state
    },
    focus,
  }
  return {
    view: view as unknown as EditorView,
    focus,
    positions: () => bookmarkPositions(current).map((pos) => current.doc.lineAt(pos).number),
    cursorLine: () => current.doc.lineAt(current.selection.main.head).number,
    text: () => current.doc.toString(),
    raw: () => current,
  }
}

function stateWith(doc: string, bookmarked: number[] = []): EditorState {
  const base = EditorState.create({ doc, extensions: [bookmarkMarks] })
  if (bookmarked.length === 0) return base
  return base.update({ effects: bookmarked.map((line) => toggleBookmarkAt.of(base.doc.line(line).from)) }).state
}

function apply(state: EditorState, changes: ChangeSpec): EditorState {
  return state.update({ changes }).state
}

/** 书签所在的行号（升序）。断言行号比断言 RangeSet 结构清楚 */
function lines(state: EditorState): number[] {
  return bookmarkPositions(state).map((pos) => state.doc.lineAt(pos).number)
}

describe('bookmarkMarks：切换与清空', () => {
  it('打上去、再切一次拿掉', () => {
    let s = stateWith('aa\nbb\ncc')
    s = s.update({ effects: toggleBookmarkAt.of(3) }).state
    expect(lines(s)).toEqual([2])
    s = s.update({ effects: toggleBookmarkAt.of(3) }).state
    expect(lines(s)).toEqual([])
  })

  it('多行各一个，位置升序', () => {
    let s = stateWith('aa\nbb\ncc\ndd')
    s = s.update({ effects: [toggleBookmarkAt.of(9), toggleBookmarkAt.of(3)] }).state
    expect(lines(s)).toEqual([2, 4])
  })

  it('clearAllBookmarks 一次全清', () => {
    const s = stateWith('aa\nbb\ncc', [1, 3])
    expect(lines(s)).toEqual([1, 3])
    expect(lines(s.update({ effects: clearAllBookmarks.of(null) }).state)).toEqual([])
  })

  it('纯选区变化不动书签', () => {
    const s = stateWith('aa\nbb\ncc', [2])
    expect(lines(s.update({ selection: { anchor: 0 } }).state)).toEqual([2])
  })

  it('存盘**不**清书签——它没有 changeGutter 那种自动清空时机', () => {
    // 这条钉的是「内存态但不随存盘消失」：与「未保存改动」gutter 刻意不同，
    // 理由在 `bookmarks.ts` 文件头
    const s = stateWith('aa\nbb\ncc', [2])
    expect(lines(s.update({}).state)).toEqual([2])
  })
})

describe('bookmarkMarks：跟随正文', () => {
  it('上面插一行 → 书签跟着挪到下一行', () => {
    const s = stateWith('aa\nbb\ncc', [2])
    expect(lines(apply(s, { from: 0, insert: 'top\n' }))).toEqual([3])
  })

  it('🔴 在书签行的行首插入一整行 → 书签跟着**原来那一行**走，不是留在新插入的那行上', () => {
    // startSide = 1 存在的唯一理由。默认的 0 会让书签留在 pos 3，
    // 而 pos 3 现在是新插入的 "x" 那一行——用户标的那行已经掉到第 3 行了
    const s = stateWith('aa\nbb\ncc', [2])
    const after = apply(s, { from: 3, insert: 'x\n' })
    expect(after.doc.toString()).toBe('aa\nx\nbb\ncc')
    expect(lines(after)).toEqual([3])
  })

  it('在书签行的行首插入文字 → 书签仍在行首（映射后重新吸附）', () => {
    const s = stateWith('aa\nbb\ncc', [2])
    const after = apply(s, { from: 3, insert: 'x' })
    expect(bookmarkPositions(after)).toEqual([3])
    expect(lines(after)).toEqual([2])
  })

  it('🔴 删掉书签所在的整行 → 书签没了，⛔ 不是悄悄转移到下一行', () => {
    const s = stateWith('aa\nbb\ncc\ndd', [2])
    const after = apply(s, { from: 3, to: 6 }) // 删 "bb\n"
    expect(after.doc.toString()).toBe('aa\ncc\ndd')
    expect(lines(after)).toEqual([])
  })

  it('只删书签行的文字（留换行）→ 书签留着，行还在只是空了', () => {
    const s = stateWith('aa\nbb\ncc', [2])
    const after = apply(s, { from: 3, to: 5 })
    expect(after.doc.toString()).toBe('aa\n\ncc')
    expect(lines(after)).toEqual([2])
  })

  it('只删书签行的换行（与下一行并起来）→ 书签留着，行还在只是变长了', () => {
    const s = stateWith('aa\nbb\ncc', [2])
    const after = apply(s, { from: 5, to: 6 })
    expect(after.doc.toString()).toBe('aa\nbbcc')
    expect(lines(after)).toEqual([2])
  })

  it('整篇换掉 → 书签全没', () => {
    const s = stateWith('aa\nbb\ncc', [1, 2])
    expect(lines(apply(s, { from: 0, to: 8, insert: 'x\ny\n' }))).toEqual([])
  })

  it('删掉两个书签之间的换行 → 挤到同一行，只留一个（每行至多一个）', () => {
    const s = stateWith('aa\nbb\ncc', [2, 3])
    const after = apply(s, { from: 5, to: 6 })
    expect(after.doc.toString()).toBe('aa\nbbcc')
    expect(lines(after)).toEqual([2])
  })

  it('一个书签都没有时改正文是空操作——热路径上的挡板', () => {
    const s = stateWith('aa\nbb\ncc')
    const after = apply(s, { from: 0, insert: 'x' })
    expect(bookmarkPositions(after)).toEqual([])
    // 字段返回的是**同一个** RangeSet 实例（empty 是单例），不是每次新建一个
    expect(after.field(bookmarkMarks)).toBe(s.field(bookmarkMarks))
  })
})

describe('bookmarkTarget：下一个 / 上一个', () => {
  it('一个书签都没有 → null', () => {
    expect(bookmarkTarget(stateWith('aa\nbb\ncc'), 1)).toBeNull()
    expect(bookmarkTarget(stateWith('aa\nbb\ncc'), -1)).toBeNull()
  })

  it('光标在两个书签之间：下一个给下面那个，上一个给上面那个', () => {
    const s = stateWith('aa\nbb\ncc\ndd', [1, 4]).update({ selection: { anchor: 4 } }).state
    expect(bookmarkTarget(s, 1)).toBe(9) // 第 4 行
    expect(bookmarkTarget(s, -1)).toBe(0) // 第 1 行
  })

  it('🔴 走到头回卷：最后一个之后再按「下一个」回到第一个', () => {
    const s = stateWith('aa\nbb\ncc\ndd', [1, 3]).update({ selection: { anchor: 9 } }).state
    expect(s.doc.lineAt(9).number).toBe(4)
    expect(bookmarkTarget(s, 1)).toBe(0) // 回卷到第 1 行
    const head = stateWith('aa\nbb\ncc\ndd', [2, 4]).update({ selection: { anchor: 0 } }).state
    expect(bookmarkTarget(head, -1)).toBe(9) // 回卷到第 4 行
  })

  it('只有一个书签时来回都是它', () => {
    const s = stateWith('aa\nbb\ncc', [3]).update({ selection: { anchor: 0 } }).state
    expect(bookmarkTarget(s, 1)).toBe(6)
    expect(bookmarkTarget(s, -1)).toBe(6)
  })

  it('光标停在书签行的行中间 → 「下一个」给的是再下面那个，不是本行这一个', () => {
    const s = stateWith('aa\nbb\ncc\ndd', [2, 4]).update({ selection: { anchor: 4 } }).state
    expect(s.doc.lineAt(4).number).toBe(2) // 光标在第 2 行（书签行）的行中间
    expect(bookmarkTarget(s, 1)).toBe(9) // 第 4 行
    expect(bookmarkTarget(s, -1)).toBe(9) // 回卷到第 4 行——本行这个不算「上一个」
  })
})

describe('四条命令', () => {
  it('toggleBookmark 切光标所在行，切两次回到没有', () => {
    const h = fakeView('aa\nbb\ncc', 4)
    expect(toggleBookmark(h.view)).toBe(true)
    expect(h.positions()).toEqual([2])
    toggleBookmark(h.view)
    expect(h.positions()).toEqual([])
  })

  it('nextBookmark 把光标送到下一个书签的行首并拿回焦点', () => {
    const h = fakeView('aa\nbb\ncc\ndd', 0)
    toggleBookmark(h.view)
    h.view.dispatch({ selection: { anchor: 0 } })
    h.view.dispatch({ effects: toggleBookmarkAt.of(9) })
    expect(h.positions()).toEqual([1, 4])

    expect(nextBookmark(h.view)).toBe(true)
    expect(h.cursorLine()).toBe(4)
    expect(h.focus).toHaveBeenCalledTimes(1)
  })

  it('prevBookmark 往回走', () => {
    const h = fakeView('aa\nbb\ncc\ndd', 9)
    h.view.dispatch({ effects: [toggleBookmarkAt.of(0), toggleBookmarkAt.of(9)] })
    expect(prevBookmark(h.view)).toBe(true)
    expect(h.cursorLine()).toBe(1)
  })

  it('一个书签都没有时 next / prev 返回 false 且什么都不动', () => {
    const h = fakeView('aa\nbb\ncc', 4)
    expect(nextBookmark(h.view)).toBe(false)
    expect(prevBookmark(h.view)).toBe(false)
    expect(h.cursorLine()).toBe(2)
    expect(h.focus).not.toHaveBeenCalled()
  })

  it('clearBookmarks 全清', () => {
    const h = fakeView('aa\nbb\ncc', 0)
    h.view.dispatch({ effects: [toggleBookmarkAt.of(0), toggleBookmarkAt.of(6)] })
    expect(h.positions()).toEqual([1, 3])
    expect(clearBookmarks(h.view)).toBe(true)
    expect(h.positions()).toEqual([])
  })

  it('命令只改书签，不改正文', () => {
    const h = fakeView('aa\nbb\ncc', 4)
    toggleBookmark(h.view)
    nextBookmark(h.view)
    clearBookmarks(h.view)
    expect(h.text()).toBe('aa\nbb\ncc')
  })
})
