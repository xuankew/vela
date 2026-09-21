// @vitest-environment jsdom
import { Compartment, EditorState } from '@codemirror/state'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEditorState, type EditorUpdateInfo } from './setup'
import type { EditorController } from './controller'
import { languageFor } from './language'
import { EditorPane } from './EditorPane'

let container: HTMLDivElement
let cleanups: (() => void)[]

function stateFor(doc = '', onUpdate?: (info: EditorUpdateInfo) => void): EditorState {
  return createEditorState({
    doc,
    lineWrap: true,
    language: languageFor(null),
    lineWrapSlot: new Compartment(),
    darkSlot: new Compartment(),
    languageSlot: new Compartment(),
    onUpdate,
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  cleanups = []
})

afterEach(() => {
  for (const dispose of cleanups) dispose()
  container.remove()
})

describe('EditorPane（Solid ↔ CM6 边界）', () => {
  it('挂载后交出可用的 controller，编辑器 DOM 落在 .editor-container 里', () => {
    let controller: EditorController | undefined
    cleanups.push(render(() => <EditorPane state={stateFor('初稿')} onReady={(c) => (controller = c)} />, container))
    expect(controller?.doc).toBe('初稿')
    expect(container.querySelector('.editor-container .cm-editor')).not.toBeNull()
  })

  it('state 只在挂载时读一次：换 props 不会重建编辑器', () => {
    const [state, setState] = createSignal(stateFor('初稿'))
    let controller: EditorController | undefined
    cleanups.push(render(() => <EditorPane state={state()} onReady={(c) => (controller = c)} />, container))

    setState(stateFor('改了 props'))

    // 这正是「Solid 响应式不能碰 CM6」那条规则的可观测后果：props 变了也不该有任何事发生。
    // 换标签只能走 controller.restore —— 一旦这里跟着重建，每次切换都会丢掉
    // 视图插件的状态（查找面板、折叠、滚动位置），而且 CM6 会在两次 measure 之间被抽走 DOM。
    expect(controller?.doc).toBe('初稿')
  })

  it('state 里的 onUpdate 是 CM6 → signal 的唯一回路', () => {
    const [lines, setLines] = createSignal(0)
    let controller: EditorController | undefined
    cleanups.push(
      render(
        () => <EditorPane state={stateFor('a\nb', (info) => setLines(info.lines))} onReady={(c) => (controller = c)} />,
        container,
      ),
    )

    controller?.view.dispatch({ changes: { from: 3, insert: '\nc' } })
    // 测试要的就是「同步读到当前值」。放进 createEffect 里读，断言会推到下一个 tick 才跑，
    // 用例反而会绿得毫无意义。
    // eslint-disable-next-line solid/reactivity
    expect(lines()).toBe(3)
  })

  it('卸载即销毁：不留下一个还活着的 view（反复开关标签页的前提）', () => {
    let controller: EditorController | undefined
    const snap = { state: stateFor('x'), scrollTop: 0, scrollLeft: 0 }
    const dispose = render(() => <EditorPane state={snap.state} onReady={(c) => (controller = c)} />, container)
    expect(container.querySelector('.cm-editor')).not.toBeNull()

    dispose()

    expect(() => controller?.restore(snap)).toThrow(/已销毁/)
    expect(container.querySelector('.cm-editor')).toBeNull()
  })

  it('onDestroy 在 view 还活着时触发：宿主要趁这一刻把现场存回标签', () => {
    let controller: EditorController | undefined
    let docAtDestroy: string | undefined
    const dispose = render(
      () => (
        <EditorPane
          state={stateFor('存着')}
          onReady={(c) => (controller = c)}
          onDestroy={() => (docAtDestroy = controller?.doc)}
        />
      ),
      container,
    )
    controller?.view.dispatch({ changes: { from: 2, insert: '新的' } })

    dispose()

    // 顺序反了的话这里读到的是 undefined：合并分屏就会把没存盘的正文一起扔掉
    expect(docAtDestroy).toBe('存着新的')
    expect(() => controller?.capture()).toThrow(/已销毁/)
  })

  it('focusin 从 CM6 的正文冒泡上来就算这块分屏拿到焦点', () => {
    let focuses = 0
    cleanups.push(
      render(() => <EditorPane state={stateFor()} onReady={() => {}} onFocus={() => focuses++} />, container),
    )
    const content = container.querySelector('.cm-content')
    expect(content).not.toBeNull()

    content!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    expect(focuses).toBe(1)
  })
})
