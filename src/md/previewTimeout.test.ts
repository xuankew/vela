/**
 * 单独一个文件，只为钉住「解析超时之后退回半截树、并且把这件事说出来」那一条。
 *
 * `vi.mock` 是**文件级**的：把 `ensureSyntaxTree` 换成永远回 null 的假实现之后，
 * 同一个文件里再没有一条用例能用到真的超时判定。放在 `preview.test.ts` 里等于
 * 为了一个分支废掉整个文件。
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@codemirror/language', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/language')>()
  // 只换这一个：`syntaxTree` 必须是真的，否则「退回半截树」退回的是一棵假树，
  // 而这一条要钉的恰恰是**退回之后照样渲染得出东西**
  return { ...actual, ensureSyntaxTree: () => null }
})

const { previewHtml } = await import('./preview')

function mdState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, codeLanguages: languages }) })
}

describe('previewHtml：解析超时', () => {
  it('退回已经建出来的那棵树，并且 partial 为 true', () => {
    const result = previewHtml(mdState('# 甲\n\n正文。\n'), '/r/a.md')
    // 🔴 两个断言缺一不可：只断 `partial` 的话「超时 → 面板整个空着」也过；
    // 只断 html 的话「渲染出来了但没告诉用户这只是前半截」也过——
    // 而后者的症状是用户看到一份结尾莫名其妙没了的预览，然后去怀疑自己的文档写坏了
    expect(result.kind === 'html' && result.partial).toBe(true)
    expect(result.kind === 'html' && result.html).toContain('甲')
  })

  it('超时的空文档照样是 html 那一种，不会退化成「不支持」', () => {
    // 语言判定与解析超时是两件独立的事：`.md` 就是 `.md`，解析没跑完不改变这一点。
    // 混了的话面板会说「Markdown 还没有预览」——一句自相矛盾的话
    const result = previewHtml(mdState(''), '/r/a.md')
    expect(result).toEqual({ kind: 'html', html: '', partial: true })
  })
})
