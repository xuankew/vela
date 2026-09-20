import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { PREVIEW_PARSE_TIMEOUT_MS, previewHtml } from './preview'

/**
 * 与 `src/editor/setup.ts` 里那份 Markdown 扩展**逐字相同**，理由与
 * `src/goto/syntax.test.ts:15` 的 `mdState` 一样：只挂 `markdown()` 的话
 * `codeLanguages` 不在场，围栏代码块会被当成普通 Markdown 解析，树的形状就不是真的了。
 */
function mdState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, codeLanguages: languages }) })
}

/** 取渲染结果，不是 `html` 那一种就当场失败——省得每条用例都写一遍 `kind === 'html' &&` */
function htmlOfState(state: EditorState, path: string | null = '/r/a.md'): string {
  const result = previewHtml(state, path)
  if (result.kind !== 'html') throw new Error(`这一份本该能渲染，实际回了 ${result.label}`)
  return result.html
}

function htmlOf(doc: string, path: string | null): string {
  return htmlOfState(mdState(doc), path)
}

describe('previewHtml：语言闸门', () => {
  it('非 Markdown 一个字都不猜，只回那个语言在状态栏上的名字', () => {
    // ⛔ 这里不能退化成「按 Markdown 渲染试试」：一份 `.ts` 里的 `<div>` 会被当成
    // 内联 HTML 处理，而渲染器的白名单会把它整个吞掉——用户看到的是一片空白，
    // 而空白与「这文件本来就是空的」长得一模一样
    expect(previewHtml(mdState('const x = 1'), '/repo/a.ts')).toEqual({
      kind: 'unsupported',
      label: 'TypeScript',
    })
    // 没匹配上扩展名的走 `plain`，label 是中文那一档
    expect(previewHtml(mdState('2026-09-19 12:00'), '/repo/a.log')).toEqual({
      kind: 'unsupported',
      label: '纯文本',
    })
  })

  it('未命名文档按 Markdown 处理——「新建标签随手写几句」是有结果的', () => {
    expect(htmlOf('# 甲', null)).toContain('甲')
  })

  it('扩展名大小写不敏感，与 languageFor 同一条正则', () => {
    for (const path of ['/r/a.md', '/r/a.MARKDOWN', '/r/a.Mdown', '/r/a.MKD']) {
      expect(htmlOf('# 甲', path), path).toContain('甲')
    }
  })
})

describe('previewHtml：渲染结果', () => {
  it('空文档回空串，而不是回一句提示', () => {
    // 「空的」这件事由 `html === ''` 表达，文案是**面板**的职责（见 MarkdownPreview.tsx）。
    // 在这一层塞一句「这份文档还是空的」的话，那句话会被当成正文渲染进 innerHTML
    expect(previewHtml(mdState(''), '/r/a.md')).toEqual({ kind: 'html', html: '', partial: false })
  })

  it('块级元素带 data-line，而同步滚动只认这个属性', () => {
    expect(htmlOf('# 甲\n\n正文。\n', '/r/a.md')).toBe('<h1 data-line="1" id="甲">甲</h1><p data-line="3">正文。</p>')
  })

  it('渲染用的是 state 当前的正文，不是它被创建时那一份', () => {
    // 这一条钉的是「预览不会读到一份旧文档」。真实链路里每次编辑都产出一个新的 state，
    // 而 `previewHtml` 收的就是那一个；把正文缓存进某个 field 的话这里会红
    const before = mdState('# 旧\n')
    expect(htmlOfState(before)).toContain('旧')
    const after = before.update({ changes: { from: 0, to: before.doc.length, insert: '# 新\n' } }).state
    expect(htmlOfState(after)).toContain('新')
  })

  it('正常文档 partial 为 false', () => {
    // `partial` 的另一半（超时退回半截树）在 `previewTimeout.test.ts` 里：
    // 那一条要把 `ensureSyntaxTree` 换成回 null 的假实现，而 `vi.mock` 是文件级的，
    // 混在这儿会让本文件其余用例全部失去真的解析器
    const result = previewHtml(mdState('# 甲\n\n正文。\n'), '/r/a.md')
    expect(result.kind === 'html' && result.partial).toBe(false)
  })

  it('解析预算是 200ms', () => {
    // 钉住数值本身不是为了不让改，而是让「改它」这个动作在 diff 里看得见。
    // 防抖窗口那一条（`PANEL_DEBOUNCE_MS === 150`）在 `panel.test.ts` 里：
    // 两个数都叫「毫秒」，而把它们钉在同一处会让人以为它们是一对——
    // 一个答「用户停下来多久」，一个答「最多同步解析多久」，改一个不该顺手动另一个
    expect(PREVIEW_PARSE_TIMEOUT_MS).toBe(200)
  })
})
