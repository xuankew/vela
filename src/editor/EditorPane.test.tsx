// @vitest-environment jsdom
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EditorController } from './controller'
import { EditorPane } from './EditorPane'

let container: HTMLDivElement
let cleanups: (() => void)[]

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
    cleanups.push(
      render(
        () => <EditorPane options={{ doc: '初稿' }} onReady={(c) => (controller = c)} />,
        container,
      ),
    )
    expect(controller?.doc).toBe('初稿')
    expect(container.querySelector('.editor-container .cm-editor')).not.toBeNull()
  })

  it('options 只在挂载时读一次：改 props 不会重建编辑器', () => {
    const [options, setOptions] = createSignal({ doc: '初稿', lineWrap: true })
    let controller: EditorController | undefined
    cleanups.push(
      render(
        () => <EditorPane options={options()} onReady={(c) => (controller = c)} />,
        container,
      ),
    )

    setOptions({ doc: '改了 props', lineWrap: false })

    // 这正是「Solid 响应式不能碰 CM6」那条规则的可观测后果：
    // props 变了也不该有任何事发生，换文档只能走 controller.setDoc
    expect(controller?.doc).toBe('初稿')
    expect(controller?.lineWrap).toBe(true)
  })

  it('onUpdate 是 CM6 → signal 的唯一回路', () => {
    const [lines, setLines] = createSignal(0)
    let controller: EditorController | undefined
    cleanups.push(
      render(
        () => (
          <EditorPane
            options={{ doc: 'a\nb', onUpdate: (info) => setLines(info.lines) }}
            onReady={(c) => (controller = c)}
          />
        ),
        container,
      ),
    )

    controller?.view.dispatch({ changes: { from: 3, insert: '\nc' } })
    expect(lines()).toBe(3)
  })

  it('卸载即销毁：不留下一个还活着的 view（M1-D 反复开关标签页的前提）', () => {
    let controller: EditorController | undefined
    const dispose = render(
      () => <EditorPane options={{ doc: 'x' }} onReady={(c) => (controller = c)} />,
      container,
    )
    expect(container.querySelector('.cm-editor')).not.toBeNull()

    dispose()

    expect(() => controller?.setDoc('y')).toThrow(/已销毁/)
    expect(container.querySelector('.cm-editor')).toBeNull()
  })
})
