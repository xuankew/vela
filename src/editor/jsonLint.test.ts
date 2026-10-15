// @vitest-environment jsdom
import { json } from '@codemirror/lang-json'
import { diagnosticCount, forEachDiagnostic, forceLinting } from '@codemirror/lint'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildState, createViewConfig } from '../doc/tab'
import { jsonLint, jsonLintSource, MAX_LINT_LENGTH } from './jsonLint'
import { languageFor } from './language'
import { languageExtensions } from './setup'

/**
 * JSON 格式校验。两组用例：
 *
 * **校验源**（`jsonLintSource`）是同步纯函数，给它一个只有 `state` 的假 view 就够——
 * 它全程只读 `view.state`（文档 + 语法树）。体积闸那一条要靠这组才测得起：
 * 2 MiB 的文档建成真 view 太贵。
 *
 * 🔴 假 view 上**必须挂 JSON 语言**：错误位置是从 Lezer 语法树的 error 节点读的，
 * 没有语言就没有树，校验会退到位置 0，那几条位置断言就成了「验回落分支」而不是验位置。
 *
 * **装配**那一组走真 view，而且是 `buildState` → `languageExtensions` → `Compartment`
 * 这条真链路（与 `doc/workspace.ts` 的 `syncLanguage` 同一次序：先装 `support === null`，
 * 子语言落地再装一次）。理由是「挂了但没接上」这种形状在纯函数那一组永远全绿：
 * `jsonLintSource` 自己是对的，可要是 `languageExtensions` 忘了带它，真窗口里
 * 一个红点都不会有。
 *
 * ⚠️ jsdom 没有排版：红点画在哪个像素、气泡长什么样、悬浮才出现的那些都量不出来，
 * 只能验「诊断进了 state」与「行号槽那一条 gutter 在不在 DOM 上」。
 */

let views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views = []
})

/**
 * 等异步落地：校验源本身是同步的，但 lint 那个 ViewPlugin 把结果统一当 promise 处理，
 * 拿到结果是几个微任务之后才 dispatch 回来的。
 *
 * 🔴 「0 条」那几条用例本身**分不清**「跑完了没报错」与「还没跑」，所以它们的可信度
 * 全押在同一文件里那条「1 条」的用例上：同一个 helper、同一个等待长度，那边等到了，
 * 这边等到 0 才是真的 0。
 */
async function settle(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const asView = (doc: string): EditorView =>
  ({ state: EditorState.create({ doc, extensions: [json()] }) }) as unknown as EditorView

/** 对象属性后面多一个逗号：`JSON.parse` 报在下一行行首那个 `}` 上 */
const BAD_JSON = '{\n  "a": 1,\n}'

describe('jsonLintSource：校验源', () => {
  it('合法 JSON 一条诊断都没有', () => {
    expect(jsonLintSource(asView('{"a": [1, 2], "b": null, "c": "x"}'))).toEqual([])
    expect(jsonLintSource(asView('[1, 2, 3]'))).toEqual([])
  })

  it('空文档与只有空白的文档不报错——新建的 .json 不该一打开就挂红点', () => {
    // `JSON.parse('')` 抛的是「Unexpected end of JSON input」，不拦的话位置 0 就是一个红点，
    // 而那时用户一个字都还没写
    expect(jsonLintSource(asView(''))).toEqual([])
    expect(jsonLintSource(asView('\n'))).toEqual([])
    expect(jsonLintSource(asView('  \n\t\n'))).toEqual([])
  })

  it('非法 JSON 给出一条 error，位置是语法树指的那一处，且至少有一个字符宽', () => {
    const diagnostics = jsonLintSource(asView(BAD_JSON))
    expect(diagnostics).toHaveLength(1)
    const [only] = diagnostics
    expect(only!.severity).toBe('error')
    expect(only!.message).toMatch(/JSON/)
    // 多余的逗号是个**零宽** error 节点（落在两个 token 之间），扩到紧随的那个字符上
    // ——CM6 对零宽诊断画的是位置下方一个 6×4 的小三角，对非零宽才画波浪线
    expect(BAD_JSON.slice(only!.from, only!.to)).toBe('}')
    expect(BAD_JSON.slice(0, only!.from)).toBe('{\n  "a": 1,\n')
  })

  it('漏了逗号接一个裸对象：标在那个 `{` 上，不是文件开头', () => {
    // 🔴 这条是真机截图换来的回归用例。JSC 的报错是
    // `JSON Parse error: Property name must be a string literal`，一个位置都不带，
    // 靠抠报错文本的实现（`jsonParseLinter`）在这里会回落到 0，红点钉在第一行的 `{` 上；
    // 用户看到的是「错误明明在第 3 行，红点却在第 1 行」。V8 环境（node / Chromium）验不出来
    const doc = '{\n  "a": 1\n  {\n    "b": 2\n  }\n}'
    const at = doc.indexOf('\n  {') + 3
    expect(doc[at]).toBe('{')

    const [only] = jsonLintSource(asView(doc))
    expect(only!.from).toBe(at)
    expect(doc.slice(only!.from, only!.to)).toBe('{')
  })

  it('超过 MAX_LINT_LENGTH 直接跳过——哪怕内容是坏的', () => {
    // 刻意构造成**非法** JSON：合法的话「返回空」就分不清是被闸拦了还是本来就没错
    const huge = `[0,${'0,'.repeat(MAX_LINT_LENGTH / 2)},]`
    expect(huge.length).toBeGreaterThan(MAX_LINT_LENGTH)
    expect(jsonLintSource(asView(huge))).toEqual([])
  })

  it('上限是 2 MiB：4 MiB 以上进不了编辑器（走只读分片），这条闸拦的是中间那一段', () => {
    expect(MAX_LINT_LENGTH).toBe(2 * 1024 * 1024)
  })
})

describe('装配：只有 JSON 文档挂校验', () => {
  /** 与 `workspace.syncLanguage` 同一条时序：槽位先装同步部分，子语言落地再装一次 */
  async function mount(path: string | null, doc: string): Promise<EditorView> {
    const choice = languageFor(path, doc)
    const languageSlot = new Compartment()
    const view = new EditorView({
      state: buildState(doc, createViewConfig(), languageSlot),
      parent: document.body,
    })
    views.push(view)
    view.dispatch({ effects: languageSlot.reconfigure(languageExtensions(choice, null)) })
    const support = choice.description === null ? null : await choice.description.load()
    view.dispatch({ effects: languageSlot.reconfigure(languageExtensions(choice, support)) })
    return view
  }

  it('.json：坏内容长出诊断，行号槽多一条 lint gutter', async () => {
    const view = await mount('/repo/pkg.json', BAD_JSON)
    expect(view.dom.querySelector('.cm-gutter-lint')).toBeTruthy()

    forceLinting(view)
    await vi.waitFor(() => expect(diagnosticCount(view.state)).toBe(1))

    const seen: string[] = []
    forEachDiagnostic(view.state, (d, from, to) => seen.push(`${from}-${to}:${d.severity}`))
    expect(seen).toEqual([`${BAD_JSON.length - 1}-${BAD_JSON.length}:error`])
  })

  it('语法包没落地时不挂校验——没有树就没有位置，早挂只会把红点钉在文件开头', async () => {
    const choice = languageFor('/repo/pkg.json', BAD_JSON)
    const lint = jsonLint()
    expect(languageExtensions(choice, null).filter((e) => lint.includes(e))).toEqual([])
    expect(languageExtensions(choice, await choice.description!.load()).filter((e) => lint.includes(e))).toEqual([
      ...lint,
    ])
  })

  it('无名但内容像 JSON 的草稿也挂上了——languageFor 靠 looksLikeJson 认出来的那一档', async () => {
    const view = await mount(null, BAD_JSON)
    forceLinting(view)
    await vi.waitFor(() => expect(diagnosticCount(view.state)).toBe(1))
  })

  it('Markdown 里同一段坏 JSON：不校验（围栏里的 json 是子语言，不归这条管）', async () => {
    const view = await mount('/repo/notes.md', '```json\n' + BAD_JSON + '\n```\n')
    expect(view.dom.querySelector('.cm-gutter-lint')).toBeNull()
    forceLinting(view)
    await settle()
    expect(diagnosticCount(view.state)).toBe(0)
  })

  it('没匹配上语言的文件（.log）：不校验', async () => {
    // ⚠️ 正文刻意**不像** JSON：`languageFor` 对没匹配上扩展名的文档还有一条 `looksLikeJson`
    // 提升（既有的自动高亮行为），拿 `{…}` 当正文的话它会被判成 JSON——那这条用例
    // 验的就不是「plain 不挂校验」，而是反过来证明了提升生效，红点还该有
    const view = await mount('/repo/run.log', '2026-10-08 12:00:00 INFO payload={oops: }\n')
    expect(view.dom.querySelector('.cm-gutter-lint')).toBeNull()
    forceLinting(view)
    await settle()
    expect(diagnosticCount(view.state)).toBe(0)
  })

  it('同是 .log，正文像 JSON 时会被提升成 JSON 并跟着校验——既有的自动高亮口径', async () => {
    const view = await mount('/repo/dump.log', '{"a": 1,}')
    expect(view.dom.querySelector('.cm-gutter-lint')).toBeTruthy()
    forceLinting(view)
    await vi.waitFor(() => expect(diagnosticCount(view.state)).toBe(1))
  })

  it('两次调用给的是同一份实例：第二次 reconfigure 不该把校验再排一遍', () => {
    expect(jsonLint()).toBe(jsonLint())
  })
})
