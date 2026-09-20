// @vitest-environment jsdom
import type { EditorView } from '@codemirror/view'
import { createRoot, createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPanelRefresh, PANEL_DEBOUNCE_MS, type FollowedEditor } from './panel'

/**
 * 「什么时候重算」这一层的测试。
 *
 * ⚠️ 防抖器**本身**那组用例搬去了 `src/ui/timer.test.ts`（`createDebounced` 住在 `src/ui/timer.ts`
 * 了，理由写在那儿的文件头）；这里剩下的是「面板怎么用它」——`createPanelRefresh`
 * 要订阅信号，所以它这一组在 `createRoot` 里跑真的 Solid，而它用的 `domTimer` 就是
 * `window.setTimeout`，于是 `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`
 * 能接住。**必须窄化 `toFake`**：整个冻住的话连 `requestAnimationFrame` 一起没了
 * （同 `src/doc/sessionSync.ts:52` 那条注释），而本文件不建真的 `EditorView`，
 * 窄化只为了不误伤后来人。
 */

describe('PANEL_DEBOUNCE_MS', () => {
  it('防抖窗口是 150ms', () => {
    // 与 `PREVIEW_PARSE_TIMEOUT_MS`（200ms，`preview.test.ts` 里钉）刻意分开钉：
    // 两个数都叫「毫秒」，钉在同一处会让人以为它们是一对。
    // 一个答「用户停下来多久」，一个答「最多同步解析多久」。
    // ⚠️ 也与 `tools/store.ts` 的 `TOOL_DEBOUNCE_MS` 分开钉，同一条理由
    expect(PANEL_DEBOUNCE_MS).toBe(150)
  })
})

/**
 * 两块「编辑器」替身。
 *
 * `createPanelRefresh` **只比身份**，从不读 `view` 上的任何东西，所以拿空对象当替身是诚实的；
 * 反过来建两个真的 `EditorView` 才是撒谎——那会让这组用例看起来在测 CM6 的行为，
 * 而它测的是「哪个信号变了该走立刻、哪个该走防抖」
 */
const viewA = {} as unknown as EditorView
const viewB = {} as unknown as EditorView

function followed(view: EditorView, path: string | null = '/r/a.md'): FollowedEditor {
  return { view, path }
}

describe('createPanelRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function harness(initial: FollowedEditor | null = null) {
    const [source, setSource] = createSignal<FollowedEditor | null>(initial)
    const [revision, setRevision] = createSignal(0)
    const [tabId, setTabId] = createSignal(1)
    const run = vi.fn()
    const dispose = createRoot((d) => {
      createPanelRefresh({ source, revision, tabId }, run)
      return d
    })
    return { setSource, setRevision, setTabId, run, dispose }
  }

  it('挂载时立刻跑一次，不等 150ms', () => {
    // 面板刚打开是用户唯一在看它的那一刻，等防抖的话他先看到一块空白
    const h = harness()
    expect(h.run).toHaveBeenCalledOnce()
    h.dispose()
  })

  it('source 还没有实例时也算跑了一次，只是 run 里读到 null', () => {
    // 「没有编辑器」不是「不该重算」：面板得有机会把提示文案改成那句
    // 「这块分屏里没有可预览的正文」。少这一条的症状是打开预览再聚焦只读分片，
    // 面板上留着**上一份**文档的内容
    const h = harness(null)
    expect(h.run).toHaveBeenCalledOnce()
    h.dispose()
  })

  it('同一块编辑器上改正文：先不跑，等防抖窗口过去才跑一次', () => {
    const h = harness(followed(viewA))
    expect(h.run).toHaveBeenCalledOnce()
    h.setRevision(1)
    h.setRevision(2)
    h.setRevision(3)
    expect(h.run).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(PANEL_DEBOUNCE_MS)
    // 三次按键只换来一次重算——这就是防抖在这儿的全部意义
    expect(h.run).toHaveBeenCalledTimes(2)
    h.dispose()
  })

  it('换了一块编辑器：立刻重算，不等防抖', () => {
    const h = harness(followed(viewA))
    h.setSource(followed(viewB))
    expect(h.run).toHaveBeenCalledTimes(2)
    h.dispose()
  })

  it('🔴 编辑器实例没变、只换了标签 id：仍然立刻重算', () => {
    // `showIn`（同一块分屏里换标签）走的是 `capture` + `restore`，
    // **view 是同一个实例**。所以「换了文档」这件事只能靠 `tabId` 看出来。
    // 少这一半的症状：点了另一个标签，预览／大纲还显示着上一份文档，
    // 而 `restore` 用的 `view.setState` 不触发 CM6 的 updateListener，
    // 于是没有任何东西会再叫它一遍——它会一直错下去
    const h = harness(followed(viewA))
    h.setTabId(2)
    expect(h.run).toHaveBeenCalledTimes(2)
    h.dispose()
  })

  it('换了标签之后在飞的那一次防抖被作废', () => {
    const h = harness(followed(viewA))
    h.setRevision(1)
    h.setTabId(2)
    // 立刻那一次已经跑了；先前排下的防抖不该在 150ms 之后再补一次
    expect(h.run).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(PANEL_DEBOUNCE_MS)
    expect(h.run).toHaveBeenCalledTimes(2)
    h.dispose()
  })

  it('卸载把在飞的那一次取消掉', () => {
    const h = harness(followed(viewA))
    h.setRevision(1)
    h.dispose()
    vi.advanceTimersByTime(PANEL_DEBOUNCE_MS)
    // 漏掉 `onCleanup` 的话这里会红：回调往一个已经从 DOM 上摘下来的节点里写东西，
    // 顺带 `setNote` 推进一个没人看的 signal。不报错，只是白做——所以只能钉在这儿
    expect(h.run).toHaveBeenCalledOnce()
  })
})
