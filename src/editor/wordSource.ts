import { type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState, Facet, StateField, type Extension, type Text } from '@codemirror/state'

/**
 * 词补全：**当前文档 + 其他打开的标签**里的词。
 *
 * PLAN.md §2 功能清单写的是「当前文档 + 项目词典」。M1 没有项目概念——文件树、
 * 工作区根、全局搜索都是 M2 的事，这一版把「项目词典」落地成**所有打开的标签**，
 * 等 M2 有了文件树再决定要不要扩到磁盘上的文件（那需要 Rust 侧配合，不是前端能
 * 自己加的）。
 *
 * ⛔ 这不是 LSP，也不该长成 LSP：没有语义、没有类型、没有作用域，就是「这个词
 * 在文档里出现过」。PLAN.md §1 的非目标里 LSP / 代码智能是明确排除的。
 *
 * **成本是这一层唯一的技术难点。** 4MB 的单文件上限意味着全文扫描不能放在每次
 * 按键上（一次正则扫 4M 字符是几十毫秒，打字会明显发黏），所以词典是 StateField
 * 增量维护的：建 state 时扫一遍全文，之后每个事务只扫**插入的那部分**。
 */

/**
 * 什么算一个词：拉丁字母、数字、下划线、`$`，至少两个字符。
 *
 * ⛔ 刻意不含中日韩字符，虽然「把上文用过的短语再打一遍」听着很有用：中文是拿
 * 输入法打的，组合期间屏幕上已经有一个候选窗，再叠一个补全窗就是两层弹窗抢同一块
 * 地方。M0 #2 的 IME 判定是按「不抢键、不干扰组合」通过的，这里不去挑战那个前提。
 * （想按「此刻是否正在组合」放行也做不到：那要读 `view.composing`，而
 * `CompletionContext` 只给 state。）
 *
 * 也不含连字符：`foo-bar` 会被切成 `foo` 与 `bar`。用户要的通常是补一个标识符，
 * 不是补一段带标点的文本。
 */
const WORD_RE = /[A-Za-z0-9_$]{2,}/g

/** 光标前面那段「正在打的词」。允许只有一个字符——显式触发时那也要能补 */
const PREFIX_RE = /[A-Za-z0-9_$]+/

/** `validFor` 要整段匹配，所以要锚定：不锚的话 "ab cd" 也算通过 */
const PREFIX_ANCHORED = /^[A-Za-z0-9_$]+$/

/**
 * 自动触发至少要打满两个字符。
 *
 * 一个字符就弹的话，敲下 `a` 的瞬间会冒出一个装着几千个词的列表——那不是补全，
 * 是遮挡。显式触发（`Alt+/`）不受这条限制：用户已经明说了要补全。
 */
const MIN_TYPED = 2

/**
 * 单个文档最多收多少个词，收满就不再收。
 *
 * 定这个上限是为了内存：一份 4MB 的英文文档能有二十万个不同的词，全存下来是十几
 * MB 的字符串，而这是一个主打低占用的编辑器。两万个词已经覆盖任何真实文档的词汇量
 * （常用英文单词总共才几万个）。
 *
 * **满了就停，而不是每次插入都重建**：重建是 O(全文)，而收益只是把本来就很全的词典
 * 补得更全一点。
 */
const MAX_WORDS = 20_000

/** 一次最多给补全面板多少个候选。再多的话列表里也看不见，白造对象 */
const MAX_OPTIONS = 200

/**
 * 一份文档的词汇表。
 *
 * 键是小写、值是文档里的原写法：匹配大小写不敏感（打 `con` 要能补出 `Config`），
 * 但补进去的应该是文档里真实的那个写法。同一个词的不同大小写因此只留第一次见到的
 * 那一个——那本来就是同一个词。
 */
export class WordDict {
  private readonly byLower = new Map<string, string>()
  private full = false

  get size(): number {
    return this.byLower.size
  }

  static fromDoc(doc: Text): WordDict {
    const dict = new WordDict()
    dict.absorbDoc(doc)
    return dict
  }

  /**
   * 把一份文本里的词收进来。逐行扫而不是 `doc.toString()` 一把扫：4MB 的文档
   * `toString` 会真的分配 4MB 字符串，而词不可能跨行（换行不是词字符），
   * 按行切既省那次分配也天然不会被 chunk 边界切断。
   */
  absorbDoc(doc: Text): void {
    for (const line of doc.iterLines()) this.absorb(line)
  }

  private absorb(text: string): void {
    if (this.full) return
    for (const match of text.matchAll(WORD_RE)) {
      const word = match[0]
      const lower = word.toLowerCase()
      if (this.byLower.has(lower)) continue
      this.byLower.set(lower, word)
      if (this.byLower.size >= MAX_WORDS) {
        this.full = true
        return
      }
    }
  }

  /** 把前缀命中的词追加到 `out` 里。`seen` 跨词典共享，同一个词只出一次 */
  collect(prefixLower: string, out: Completion[], seen: Set<string>): void {
    for (const [lower, word] of this.byLower) {
      if (out.length >= MAX_OPTIONS) return
      if (seen.has(lower) || !lower.startsWith(prefixLower)) continue
      // 与前缀一模一样的不收。词典是增量吸收的，用户正在打的那个前缀本身就在里面，
      // 不排掉的话每次都会把「你已经打出来的这几个字」当候选列出来——那不是补全，是噪音。
      if (lower === prefixLower) continue
      seen.add(lower)
      out.push({ label: word })
    }
  }
}

/**
 * 每个 state 自己维护的词典。
 *
 * ⚠️ **update 里是就地改，返回的是同一个对象**，这与 StateField「值不可变」的惯例
 * 相悖，是有意为之：不可变就得每次按键复制一份两万条的 Map，那正是这里要避免的成本。
 * 代价是同一份词典会被它派生出的所有 state 共享——包括撤销回去的旧 state 与
 * `tab.snapshot` 里存着的那一份。可以接受，因为**词典是建议性的**：它唯一的作用是
 * 产出候选列表，多一个已经删掉的词只是让用户在列表里看到一个用不上的选项，
 * 不会损坏任何数据。删掉的词也确实不会跟着消失，理由同上——要跟着消失就得给每个
 * 词记出现次数，那是十倍的复杂度换一个「列表更干净一点」。
 */
export const wordDict = StateField.define<WordDict>({
  create: (state) => WordDict.fromDoc(state.doc),
  update: (dict, tr) => {
    if (!tr.docChanged) return dict
    tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => dict.absorbDoc(inserted))
    return dict
  },
})

/**
 * 「还有谁能贡献词」，由 workspace 注入所有标签的活 state。
 *
 * 用 facet 而不是让补全源直接 import workspace：这一层不该知道标签与分屏的存在，
 * 而且注入之后「跨文档取词」这条能在 node 环境里拿两个裸 state 测出来。
 * 缺省是空的——`createEditorState` 被单独调用时（测试、将来的复用）就只有自己那份词典。
 */
export const wordPeers = Facet.define<() => Iterable<EditorState>>()

function dictsFor(state: EditorState): WordDict[] {
  const dicts = [state.field(wordDict)]
  for (const peers of state.facet(wordPeers)) {
    for (const peer of peers()) {
      // 自己已经在第一位了。liveStates 给的是「显示中的读 view.state」，
      // 那正是 context.state，靠引用相等就能认出来
      if (peer !== state) dicts.push(peer.field(wordDict))
    }
  }
  return dicts
}

export function completeWords(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(PREFIX_RE)
  if (word === null) return null
  if (word.text.length < (context.explicit ? 1 : MIN_TYPED)) return null

  const prefix = word.text.toLowerCase()
  const options: Completion[] = []
  const seen = new Set<string>()
  for (const dict of dictsFor(context.state)) {
    dict.collect(prefix, options, seen)
    if (options.length >= MAX_OPTIONS) break
  }
  // 没命中就返回 null 而不是空结果：空结果会让 CM6 认为「这个源给过了，没有东西」，
  // 而 null 是「这次我不参与」，别的源（语言包自己带的那些）照常出
  if (options.length === 0) return null
  return { from: word.from, options, validFor: PREFIX_ANCHORED }
}

/** 语言数据是每次请求都读的，值本身不会变，所以提到模块级免得每次分配一个数组 */
const WORD_LANGUAGE_DATA = [{ autocomplete: completeWords }] as const

/**
 * 词典 + 词源。装在 `buildExtensions` 的基础扩展集里，对所有语言都生效。
 *
 * ⚠️ 词源是注册进 `EditorState.languageData` 的 `autocomplete` 键，**不是**
 * `autocompletion({ override: [...] })`。override 的类型文档写得很直白：「默认情况下
 * 源取自 autocomplete 语言数据」——也就是说一旦给了 override，语言包自带的那些源
 * （lang-css 的属性与值、lang-html 的标签与属性、lang-javascript 的 TS 泛型作用域）
 * 会**全部**被顶掉。而 `completionSource` 这个 facet 压根没有从包里导出。
 * 注册进语言数据是唯一一条「与语言包的源并列而不是互斥」的路。
 */
export const wordCompletions: Extension = [wordDict, EditorState.languageData.of(() => WORD_LANGUAGE_DATA)]
