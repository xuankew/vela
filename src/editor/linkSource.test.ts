import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { linkCompletions, linkContext, type LinkCompletionHook } from './linkSource'

/**
 * 链接补全的单测：光标什么时候算「在链接目标里」、源怎么把钩子的结果变成候选、
 * 以及这一组到底挂在哪几种文档上。
 *
 * 全部在 node 环境里跑，**不起 view**：`CompletionContext` 是 state 上的纯计算，
 * 浮层的渲染是 CM6 自己的事（与 `wordSource.test.ts` 同一条口径）。
 * 「钩子怎么算出项目里的文件」在 `App.tsx`，「路径怎么相对化」在 `md/linkPath.test.ts`。
 */

/** 钩子回的候选。测试里认这个字符串来把「我们的源」从语言自带的源里挑出来 */
const LABEL = 'img/a.png'

function mdState(doc: string, hook: LinkCompletionHook = async () => [LABEL], extra: Extension[] = []) {
  return EditorState.create({ doc, extensions: [markdown(), linkCompletions(hook), ...extra] })
}

/** 光标停在文档末尾 */
function atEnd(state: EditorState) {
  return state.doc.length
}

function contextAt(state: EditorState, pos: number) {
  return new CompletionContext(state, pos, false)
}

/**
 * 取某个位置上的全部补全源。
 *
 * ⚠️ 遇到**数组**直接失败而不是悄悄跳过：CM6 的 `asSource` 会把数组交给
 * `completeFromList` 当成一份静态候选表（元素该是字符串或 `Completion`），
 * 于是「一个装着函数的数组」既不是源也不是候选，结果就是浮层永远不出东西。
 * 这条错误路径在 `linkSource.ts` 的模块文档里也记了一笔。
 */
function sourcesAt(state: EditorState, pos: number): readonly CompletionSource[] {
  const values = state.languageDataAt<CompletionSource>('autocomplete', pos)
  for (const value of values) {
    if (typeof value !== 'function') throw new Error(`autocomplete 语言数据里有非函数的源：${String(value)}`)
  }
  return values
}

async function runSources(state: EditorState, pos: number): Promise<(CompletionResult | null)[]> {
  const context = contextAt(state, pos)
  // 源可以同步返回（`completeFromList` 那种），也可以返回 promise，所以逐个包一层：
  // 直接把混合数组交给 `Promise.all` 会被 lint 认成「在 await 一个非 thenable」
  return Promise.all(sourcesAt(state, pos).map((source) => Promise.resolve(source(context))))
}

/** 我们的源在这一位给出的结果；没给就是 null */
async function linkResult(state: EditorState, pos: number): Promise<CompletionResult | null> {
  for (const result of await runSources(state, pos)) {
    if (result?.options.some((o) => o.label === LABEL)) return result
  }
  return null
}

/** 这一位上所有源加起来给出的候选文字 */
async function labels(state: EditorState, pos: number): Promise<string[]> {
  const out: string[] = []
  for (const result of await runSources(state, pos)) {
    if (result) out.push(...result.options.map((o) => o.label))
  }
  return out
}

describe('linkContext：什么位置算「在链接目标里」', () => {
  it('`](` 之后一个字都没打也算——此时钩子拿到空串', () => {
    const state = mdState('[图](')
    const at = linkContext(contextAt(state, atEnd(state)))!
    expect(at.typed).toBe('')
    expect(at.from).toBe(state.doc.length)
  })

  it('打了半截路径，typed 是那半截，from 仍在 `](` 之后', () => {
    const state = mdState('[图](img/')
    const at = linkContext(contextAt(state, atEnd(state)))!
    expect(at.typed).toBe('img/')
    // from 不是光标：候选要顶掉已经打出来的那段，否则会变成 `img/img/a.png`
    expect(at.from).toBe(state.doc.length - 4)
    expect(state.doc.sliceString(at.from, state.doc.length)).toBe('img/')
  })

  it('同一行里前面那个链接已经闭合时，只认光标所在的这一个', () => {
    const state = mdState('[甲](a.png) 然后 [乙](b')
    expect(linkContext(contextAt(state, atEnd(state)))!.typed).toBe('b')
  })

  it('目标已经闭合就不再是链接目标', () => {
    expect(linkContext(contextAt(mdState('[图](a.png)'), 10))).toBeNull()
  })

  it('闭合之后接着写正文也不算——`)` 是 `[^)]*` 的硬边界', () => {
    const state = mdState('[图](a.png) 一些正文')
    expect(linkContext(contextAt(state, atEnd(state)))).toBeNull()
  })

  it('纯正文不算', () => {
    expect(linkContext(contextAt(mdState('就是普通的中文正文'), 8))).toBeNull()
  })

  it('上一行的 `](` 不算：matchBefore 只看当前行', () => {
    const state = mdState('[图](\n正文')
    expect(linkContext(contextAt(state, atEnd(state)))).toBeNull()
  })

  it('目标长过 250 字符就不再补——那是 matchBefore 的窗口，不是我们的判断', () => {
    const state = mdState(`[图](${'a'.repeat(300)}`)
    expect(linkContext(contextAt(state, atEnd(state)))).toBeNull()
    // 窗口之内（240 个字符）就还认
    const short = mdState(`[图](${'a'.repeat(240)}`)
    expect(linkContext(contextAt(short, atEnd(short)))!.typed).toBe('a'.repeat(240))
  })
})

describe('补全源出什么', () => {
  it('钩子的字符串原样变成候选，from 指向 `](` 之后', async () => {
    const state = mdState('[图](img/')
    const result = (await linkResult(state, atEnd(state)))!
    expect(result.options).toEqual([{ label: LABEL }])
    expect(result.from).toBe(state.doc.length - 4)
  })

  it('钩子拿到的正是已经打出来的那段', async () => {
    const hook = vi.fn(async () => [LABEL])
    await linkResult(mdState('[图](img/x', hook), 9)
    expect(hook).toHaveBeenCalledWith('img/x')
  })

  it('光标不在链接目标里时钩子压根不被调用——省掉一次 IPC', async () => {
    const hook = vi.fn(async () => [LABEL])
    await labels(mdState('就是普通的中文正文', hook), 8)
    expect(hook).not.toHaveBeenCalled()
  })

  it('钩子回 null 或空数组都返回 null，而不是空结果——空结果会顶掉别的源', async () => {
    expect(
      await linkResult(
        mdState('[图](zz', async () => null),
        6,
      ),
    ).toBeNull()
    expect(
      await linkResult(
        mdState('[图](zz', async () => []),
        6,
      ),
    ).toBeNull()
  })

  /*
   * 🔴 这条钉的是「异步源必须自己吃掉失败」。CM6 对 reject 的处理是
   * 关掉浮层 + `logException`，用户看到的只是「打了一半列表没了」，控制台一行红。
   * 钩子里是一次 `query_project` IPC（根不合法、盘拔了都会 reject），
   * 所以失败必须在这一层被翻译成「这一轮没有候选」。
   */
  it('钩子 reject 时安静地给出 null，不把异常抛给 CM6', async () => {
    const state = mdState('[图](im', async () => {
      throw new Error('boom')
    })
    await expect(labels(state, atEnd(state))).resolves.toEqual([])
  })

  it('validFor 与匹配用的字符类同源：没打出 `)` 之前旧结果一直可用', async () => {
    const result = (await linkResult(mdState('[图](img/'), 8))!
    const validFor = result.validFor as RegExp
    expect(validFor.test('img/a')).toBe(true)
    expect(validFor.test('img/a.png')).toBe(true)
    // 打出 `)` 就该收起来：这个目标已经写完了，那份列表是上一轮的
    expect(validFor.test('img/a.png)')).toBe(false)
  })

  it('🔴 关掉 CM6 自己的那层筛选：它拿用户打的那段原文去比**重算过的**相对目标', async () => {
    // 少了 `filter: false`，浮层里会只剩那些碰巧与用户打的字模糊匹配的候选：
    // 打 `](../im` 时一条都不剩（`img/a.png` 里没有 `.`），打 `](im` 时 `../README.md`
    // 会被扔掉（`README.md` 里没有 `i`）。筛选已经由 Rust 的 fuzzy_score 做过了，
    // CM6 再做一遍只会用错口径把对的候选筛掉——完整论证在 linkSource.ts 文件头
    const state = mdState('[图](../im')
    const result = (await linkResult(state, atEnd(state)))!
    expect(result.filter).toBe(false)
  })
})

describe('只挂在 Markdown 上', () => {
  it('Markdown 文档里有这一组，且与 lang-markdown 自带的源并存', async () => {
    const state = mdState('[图](im')
    // lang-markdown 自己就注册了 htmlTagCompletion（补 HTML 标签名）。
    // 走 autocompletion({override}) 会把它一起顶掉，代价不是零——理由见 linkSource.ts
    expect(await labels(state, atEnd(state))).toContain(LABEL)
    const html = mdState('<di')
    // htmlTagCompletion 给的 label 自带 `<`，不是裸标签名
    expect(await labels(html, atEnd(html))).toContain('<div')
  })

  it('交出去的是一个函数，不是一份静态候选表', () => {
    // 形状钉在这里，是因为写错成 `{autocomplete: [source]}` 时**没有任何一处会报错**：
    // 数组被 asSource 交给 completeFromList 当候选表，浮层只是永远不出东西
    const state = mdState('[图](im')
    const values = state.languageDataAt('autocomplete', atEnd(state))
    expect(values.every((value) => typeof value === 'function')).toBe(true)
    // lang-markdown 自带的 htmlTagCompletion + 我们这一组，两个并列
    expect(values.length).toBe(2)
  })

  it('没挂语言的纯文本文档里没有这一组', () => {
    const state = EditorState.create({ doc: '[图](im', extensions: [linkCompletions(async () => [LABEL])] })
    expect(state.languageDataAt('autocomplete', state.doc.length)).toEqual([])
  })

  it('JSON 文档里也没有：`{"a": [1](2` 不该弹路径', async () => {
    const state = EditorState.create({
      doc: '[图](im',
      extensions: [json(), linkCompletions(async () => [LABEL])],
    })
    expect(await labels(state, atEnd(state))).not.toContain(LABEL)
  })

  /*
   * 🔴 围栏里挂了子语言时，markdown 的数据**不再**覆盖那段——子语言接管之后，
   * 那里能取到的只有 javascript 自己的源。这正是「注册进 markdownLanguage.data」
   * 想要的效果：```` ```js ```` 块里的 `a[0](x)` 不会触发一次路径查询。
   *
   * ⚠️ 用函数形式的 codeLanguages 而不是 app 里那份 `languages`（LanguageDescription[]）：
   * 后者的 `load()` 是异步的，node 环境里跑不出确定结果；函数形式直接交出 Language，
   * 等价于「已经加载好」那一态，取到的 parser 与走 description 是同一条分支。
   */
  it('挂了子语言的围栏代码块里没有这一组', async () => {
    const state = EditorState.create({
      doc: ['```js', 'const a = [x](y', '```'].join('\n'),
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: () => javascriptLanguage }),
        linkCompletions(async () => [LABEL]),
      ],
    })
    expect(await labels(state, state.doc.line(2).to)).not.toContain(LABEL)
  })

  it('没认出来的围栏（```text）仍是 markdown 的地盘，这一组照旧生效', () => {
    // 与 htmlTagCompletion 同一种覆盖面。代价是「纯文本围栏里打 `](` 会弹路径」，
    // 而那种正文本来就极少，弹了也只是多一个可选项，不会改坏文档
    const state = EditorState.create({
      doc: ['```text', '[图](im', '```'].join('\n'),
      extensions: [markdown(), linkCompletions(async () => [LABEL])],
    })
    expect(state.languageDataAt('autocomplete', state.doc.line(2).to).length).toBeGreaterThan(0)
  })
})
