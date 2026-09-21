import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot } from '../editor/controller'
import { darkThemeEnabled, lineWrapEnabled, type EditorUpdateInfo } from '../editor/setup'
import {
  applyViewConfig,
  createTab,
  createViewConfig,
  replaceTabText,
  tabChars,
  tabLines,
  tabText,
  type Tab,
  type TabHost,
  type ViewConfig,
} from './tab'

/**
 * 标签本身的单测：全部在 node 环境跑，不起 view。
 *
 * 这一层的价值就在于「state 能脱离 view 存活」——如果一个断言必须有 view 才能写，
 * 那说明它属于 controller 或 workspace，不属于这里。
 */

let idSeq = 100

/**
 * 造一个标签。host 与 config 必须成对：`host.setText` 重建 state 时要读 config，
 * 两者不同源就会出现「换文档之后换行偏好回到默认值」这种只在特定时序下复现的 bug。
 */
function makeTab(text = '', config: ViewConfig = createViewConfig(), onUpdate?: (info: EditorUpdateInfo) => void) {
  const host: TabHost = {
    getText: (tab) => tabText(tab),
    setText: (tab, next) => replaceTabText(tab, next, config),
    focus: () => {},
    pathChanged: () => {},
  }
  return createTab({ id: idSeq++, text, config, host, ...(onUpdate ? { onUpdate } : {}) })
}

describe('createTab', () => {
  it('造出来就是一个干净的空文档标签：正文空、无名、不脏、滚动归零', () => {
    const tab = makeTab()
    expect(tabText(tab)).toBe('')
    expect(tabLines(tab)).toBe(1) // CM6 把空文档算作一行空行
    expect(tabChars(tab)).toBe(0)
    expect(tab.snapshot.scrollTop).toBe(0)
    expect(tab.snapshot.scrollLeft).toBe(0)
    expect(tab.doc.path()).toBeNull()
    expect(tab.doc.dirty()).toBe(false)
  })

  it('初始正文真的落到 state 里，换行偏好跟着 config 走', () => {
    const on = makeTab('第一行\n第二行', createViewConfig(true))
    expect(tabText(on)).toBe('第一行\n第二行')
    expect(tabLines(on)).toBe(2)
    expect(lineWrapEnabled(on.snapshot.state)).toBe(true)

    const off = makeTab('x', createViewConfig(false))
    expect(lineWrapEnabled(off.snapshot.state)).toBe(false)
  })

  it('host 的四个方法收到的都是标签自己，不是某个全局的当前标签', () => {
    // 这条防的是「所有标签共用一个 host 闭包」：那样的话打开文件会把内容写进
    // 当前活动标签而不是发起打开的那个，而且不报错。
    const seen: Tab[] = []
    const config = createViewConfig()
    const host: TabHost = {
      getText: (tab) => {
        seen.push(tab)
        return tabText(tab)
      },
      setText: (tab, text) => {
        seen.push(tab)
        replaceTabText(tab, text, config)
      },
      focus: (tab) => {
        seen.push(tab)
      },
      pathChanged: (tab) => {
        seen.push(tab)
      },
    }
    const a = createTab({ id: 1, text: 'A', config, host })
    const b = createTab({ id: 2, text: 'B', config, host })

    host.setText(a, 'A2')
    host.setText(b, 'B2')
    host.focus(a)
    host.pathChanged(b)
    expect(tabText(a)).toBe('A2')
    expect(tabText(b)).toBe('B2')
    expect(host.getText(b)).toBe('B2')
    expect(seen).toEqual([a, b, a, b, b])
  })

  it('文档模型的操作只脏自己那个标签', () => {
    const a = makeTab()
    const b = makeTab()
    a.doc.markChanged()
    expect(a.doc.dirty()).toBe(true)
    expect(b.doc.dirty()).toBe(false)
  })
})

describe('replaceTabText', () => {
  it('整篇换正文，滚动位置一并归零', () => {
    const config = createViewConfig()
    const tab = makeTab('旧正文', config)
    tab.snapshot = { ...tab.snapshot, scrollTop: 300, scrollLeft: 20 }

    replaceTabText(tab, '新正文\n第二行', config)

    expect(tabText(tab)).toBe('新正文\n第二行')
    expect(tabLines(tab)).toBe(2)
    expect(tab.snapshot.scrollTop).toBe(0)
    expect(tab.snapshot.scrollLeft).toBe(0)
  })

  it('换正文之后换行偏好不丢：重建 state 用的是当前 config', () => {
    const config = createViewConfig(false)
    const tab = makeTab('旧', config)
    replaceTabText(tab, '新', config)
    expect(lineWrapEnabled(tab.snapshot.state)).toBe(false)
  })

  it('onUpdate 被带到新 state 上——换文档不该顺手换掉监听器', () => {
    // 用 facet 长度断言而不是真的建 view：这一层不该依赖 DOM
    const onUpdate = vi.fn()
    const config = createViewConfig()
    const tab = makeTab('旧', config, onUpdate)
    const before = tab.snapshot.state.facet(EditorView.updateListener).length
    expect(before).toBe(1)

    replaceTabText(tab, '新', config)

    expect(tab.onUpdate).toBe(onUpdate)
    expect(tab.snapshot.state.facet(EditorView.updateListener).length).toBe(before)
  })

  it('换出来的是一个全新的 state 对象：撤销历史不可能跨文档存活', () => {
    const tab = makeTab('旧')
    const before: EditorSnapshot = tab.snapshot
    replaceTabText(tab, '新', createViewConfig())
    expect(tab.snapshot.state).not.toBe(before.state)
  })
})

describe('applyViewConfig（未显示的标签也要跟着全局设置走）', () => {
  it('把换行落到存着的 state 上，正文与滚动位置不动', () => {
    const config = createViewConfig(true)
    const tab = makeTab('正文', config)
    tab.snapshot = { ...tab.snapshot, scrollTop: 88 }

    config.lineWrap = false
    applyViewConfig(tab, config)

    expect(lineWrapEnabled(tab.snapshot.state)).toBe(false)
    expect(tabText(tab)).toBe('正文')
    expect(tab.snapshot.scrollTop).toBe(88)
  })

  it('配置已经一致时不换 state 对象', () => {
    // 不这样的话，切一次换行会把所有标签的 state 对象都换掉：内容没变，
    // 但任何靠 === 判断「没动过」的地方都会失准
    const config = createViewConfig(true)
    const tab = makeTab('正文', config)
    const before = tab.snapshot.state

    applyViewConfig(tab, config)

    expect(tab.snapshot.state).toBe(before)
  })

  it('来回切两次回到原状', () => {
    const config = createViewConfig(true)
    const tab = makeTab('正文', config)

    config.lineWrap = false
    applyViewConfig(tab, config)
    config.lineWrap = true
    applyViewConfig(tab, config)

    expect(lineWrapEnabled(tab.snapshot.state)).toBe(true)
  })

  it('把深浅色落到存着的 state 上（darkSlot 与 lineWrapSlot 互不干扰）', () => {
    const config = createViewConfig(true)
    const tab = makeTab('正文', config)
    expect(darkThemeEnabled(tab.snapshot.state)).toBe(true)

    config.dark = false
    applyViewConfig(tab, config)

    expect(darkThemeEnabled(tab.snapshot.state)).toBe(false)
    // 深浅色这一改不该顺手把换行也动了
    expect(lineWrapEnabled(tab.snapshot.state)).toBe(true)
    expect(tabText(tab)).toBe('正文')
  })

  it('换行与深浅色同时不一致时，一趟 update 两个槽位都跟上', () => {
    const config = createViewConfig(true)
    const tab = makeTab('正文', config)

    config.lineWrap = false
    config.dark = false
    applyViewConfig(tab, config)

    expect(lineWrapEnabled(tab.snapshot.state)).toBe(false)
    expect(darkThemeEnabled(tab.snapshot.state)).toBe(false)
  })

  it('只有深浅色一致、换行不一致时也要换 state（早退只看「全都一致」）', () => {
    // 回归保护：applyViewConfig 一度只比对 lineWrap，加 dark 那一维后若沿用旧的单条早退，
    // 「换行没变、只切主题」会被整个跳过，未显示的标签切回来还是旧色
    const config = createViewConfig(true)
    const tab = makeTab('正文', config)
    const before = tab.snapshot.state

    config.dark = false
    applyViewConfig(tab, config)

    expect(tab.snapshot.state).not.toBe(before)
    expect(darkThemeEnabled(tab.snapshot.state)).toBe(false)
  })
})
