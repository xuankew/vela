import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { completeWords, wordCompletions, wordDict, wordPeers, WordDict } from './wordSource'

/**
 * 词补全的单测：词典怎么收词、词源怎么出候选。
 *
 * 全部在 node 环境里跑，**不起 view**：`CompletionContext` 是 state 上的纯计算，
 * 补全面板的渲染是 CM6 自己的事，测它等于替上游判卷。跨标签那条要真的走一遍
 * workspace 的接线，放在 `workspace.test.ts` 里。
 *
 * ⚠️ 写用例时留意：**插入的正文前面要留空格**。`matchBefore` 取的是光标前那段
 * 连续的词字符，在 `'hello world'` 末尾直接插 `'wo'` 得到的是 `'worldwo'`，
 * 于是前缀成了 `worldwo` 而不是 `wo`——断言会莫名其妙地失败。
 */

function dictOf(text: string): WordDict {
  return WordDict.fromDoc(Text.of(text.split('\n')))
}

function stateFor(doc: string, peers?: () => Iterable<EditorState>): EditorState {
  return EditorState.create({
    doc,
    extensions: peers === undefined ? [wordCompletions] : [wordCompletions, wordPeers.of(peers)],
  })
}

/** 光标放在文档末尾（`pos` 缺省就是主光标），取一次补全结果 */
function complete(state: EditorState, explicit = false) {
  return completeWords(new CompletionContext(state, state.doc.length, explicit))
}

function labels(state: EditorState, explicit = false): string[] {
  return complete(state, explicit)?.options.map((o) => o.label) ?? []
}

/** 在末尾接着打几个字，返回打完之后的 state */
function typing(state: EditorState, text: string): EditorState {
  return state.update({ changes: { from: state.doc.length, insert: text } }).state
}

describe('WordDict 收什么词', () => {
  it('拉丁字母、数字、下划线的连续段，重复的只算一个', () => {
    expect(dictOf('foo bar foo baz_1 x9').size).toBe(4)
  })

  it('单个字符不收：一个字母的候选列表等于噪音', () => {
    expect(dictOf('a I bb x').size).toBe(1)
  })

  it('中日韩字符不收——中文是拿输入法打的，不跟候选窗抢地方', () => {
    expect(dictOf('你好世界 hello 世界').size).toBe(1)
  })

  it('连字符与标点都是词的边界', () => {
    expect(dictOf('foo-bar baz.qux').size).toBe(4)
  })

  it('大小写不敏感，保留第一次见到的写法', () => {
    const dict = dictOf('Config config CONFIG')
    expect(dict.size).toBe(1)
    const out: { label: string }[] = []
    dict.collect('con', out, new Set())
    expect(out).toEqual([{ label: 'Config' }])
  })

  it('collect 跨词典去重：同一个词只出一次', () => {
    const out: { label: string }[] = []
    const seen = new Set<string>()
    dictOf('shared alpha').collect('', out, seen)
    dictOf('shared beta').collect('', out, seen)
    expect(out.map((o) => o.label).sort()).toEqual(['alpha', 'beta', 'shared'])
  })
})

describe('词典跟着文档增量走', () => {
  // 两条都是「先打出完整的词，再打它的前缀」：词典是增量吸收的，没有重扫全文，
  // 所以刚敲进去的词立刻就能补。而「正在打的那个前缀」本身也在词典里，
  // 它被 collect 排掉了（见下一条），于是断言的是**另一个**词。
  it('敲进去的新词立刻能补，不需要重扫全文', () => {
    const typed = typing(stateFor('alpha'), ' zeta')
    expect(labels(typing(typed, ' ze'))).toEqual(['zeta'])
  })

  it('正在打的那几个字不会被当成候选', () => {
    // 光标停在 `alpha` 末尾：前缀就是 alpha，词典里也只有 alpha。
    // 排掉它之后一个候选都不剩，于是整个源返回 null（空结果会顶掉别的源）
    expect(complete(stateFor('alpha'))).toBeNull()
  })

  /*
   * 这条钉的是「词典是建议性的」那个取舍：删掉的词不会跟着消失。
   * 要跟着消失就得给每个词记出现次数，十倍的复杂度换「列表干净一点」。
   * 副作用是候选里可能出现一个文档里已经没有的词——补进去仍然是合法文本，不损坏数据。
   */
  it('删掉的词还留在词典里（有意为之）', () => {
    const state = stateFor('alpha beta')
    const deleted = state.update({ changes: { from: 6, to: 10 } }).state
    expect(deleted.doc.toString()).toBe('alpha ')
    expect(labels(typing(deleted, 'be'))).toEqual(['beta'])
  })

  it('不换正文的事务（移动光标）不动词典', () => {
    const state = stateFor('alpha')
    const moved = state.update({ selection: { anchor: 0 } }).state
    expect(moved.field(wordDict)).toBe(state.field(wordDict))
  })

  it('装满就不再收：宁可少几个候选，也不在每次按键上重建一份两万条的表', () => {
    // MAX_WORDS 是 20000，这里造 25000 个不同的词。刻意不导出那个常量来断言——
    // 要钉的是**行为**（有界、且满了就停），不是具体数字
    const words: string[] = []
    for (let i = 0; i < 25_000; i++) words.push(`word${i}`)
    const state = stateFor(words.join(' '))
    const size = state.field(wordDict).size
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThan(25_000)

    const next = typing(state, ' brandNewWord')
    expect(next.field(wordDict).size).toBe(size)
    expect(labels(next)).not.toContain('brandNewWord')
  })
})

describe('词源出什么候选', () => {
  it('打了一个字符不弹，打满两个才弹', () => {
    const state = stateFor('alpha beta')
    expect(complete(typing(state, ' a'))).toBeNull()
    expect(labels(typing(state, ' al'))).toContain('alpha')
  })

  it('显式触发时一个字符也认', () => {
    expect(labels(typing(stateFor('alpha beta'), ' a'), true)).toEqual(['alpha'])
  })

  it('前缀匹配大小写不敏感，补出来的是文档里的写法', () => {
    expect(labels(typing(stateFor('Configuration'), ' con'))).toEqual(['Configuration'])
  })

  it('from 指向词首，不是光标位置', () => {
    const state = typing(stateFor('hello world'), ' wo')
    const result = complete(state)!
    expect(result.from).toBe(12)
    expect(state.doc.sliceString(result.from, state.doc.length)).toBe('wo')
  })

  it('没有命中就返回 null，而不是空结果——空结果会顶掉别的源', () => {
    expect(complete(typing(stateFor('alpha'), ' zz'))).toBeNull()
  })

  it('光标紧跟在中文后面时不参与（那段不是词）', () => {
    expect(complete(typing(stateFor('alpha 你好'), '世'))).toBeNull()
  })

  it('空文档什么都不给', () => {
    expect(complete(stateFor(''))).toBeNull()
  })

  it('一次最多给 200 个候选', () => {
    // 与 wordSource 里的 MAX_OPTIONS 是同一个数。改了那边就得改这里，这是故意的：
    // 列表里看得见的位置就那么多，这个数字是产品决定而不是实现细节
    const words: string[] = []
    for (let i = 0; i < 300; i++) words.push(`prefix${i}`)
    expect(complete(stateFor(`${words.join(' ')} prefix`))!.options).toHaveLength(200)
  })

  it('validFor 是锚定的：继续打字算同一个词，打出空格就不算了', () => {
    const validFor = complete(typing(stateFor('alpha'), ' al'))!.validFor as RegExp
    expect(validFor.test('al')).toBe(true)
    expect(validFor.test('alp')).toBe(true)
    expect(validFor.test('al ph')).toBe(false)
  })
})

describe('跨文档（「项目词典」在 M1 的落地形态）', () => {
  it('别的标签里的词也能补，重复的只出一次', () => {
    const peer = stateFor('zebra omega')
    const own = stateFor('alpha omega', () => [peer])
    expect(labels(typing(own, ' om'))).toEqual(['omega'])
    expect(labels(typing(own, ' ze'))).toEqual(['zebra'])
  })

  it('peers 里含自己时不会重复', () => {
    const self: EditorState = stateFor('alpha', () => [self])
    // ⚠️ update 之后是新 state，peers 闭包里那个 self 是旧的——正是这种情况最容易
    // 让同一个词出两遍，所以断言的是「只出一次」
    expect(labels(typing(self, ' al'))).toEqual(['alpha'])
  })

  it('没注入 peers 时只有当前文档的词典', () => {
    expect(complete(typing(stateFor('alpha'), ' ze'))).toBeNull()
  })
})

describe('接线', () => {
  it('词源注册在语言数据的 autocomplete 键上，不是 override', () => {
    // 这条钉的是 wordSource 末尾那个取舍：override 会把语言包自带的源全顶掉，
    // 所以词源必须与它们并列。languageDataAt 正是 autocompletion 默认的取源处
    expect(stateFor('alpha').languageDataAt('autocomplete', 0)).toContain(completeWords)
  })

  it('词典字段随 wordCompletions 一起装上', () => {
    expect(stateFor('alpha beta').field(wordDict).size).toBe(2)
  })
})
