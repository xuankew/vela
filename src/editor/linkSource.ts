import { type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { markdownLanguage } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'

/**
 * Markdown 链接补全（M3-A-6）：打完 `](` 之后，补**项目里的文件**，插进去的是
 * 相对当前文档的路径（相对化与编码那半在 `src/md/linkPath.ts`，取候选那半在
 * `App.tsx` 的 `linkFiles` 钩子里）。
 *
 * ## 🔴 只挂 Markdown，靠的是 `markdownLanguage.data`，⛔ 不是 `autocompletion({override})`
 *
 * 与 `./wordSource` 末尾那条同一套理由，而且这里更要紧一档：`override` 会把语言包自带的源
 * **全部**顶掉，而 `lang-markdown` 确实自带一个（`htmlTagCompletion`，补正文里的 HTML 标签名），
 * 所以代价不是零。真正的问题还是「链接补全」这件事**只在 Markdown 文档里成立**，而
 * `wordCompletions` 是全局注册的（`EditorState.languageData`）。注册进 `markdownLanguage`
 * 的数据里，作用域就跟着语言走：一个 `.rs` 文件里打 `](` 什么也不会发生。
 *
 * 附带一条实测到的边界：带语言标签的围栏（```` ```js ````）会被 `codeLanguages` 挂上子语言，
 * 那一段取的就不再是 markdown 的数据，于是里面的 `a[0](x)` 不会触发一次路径查询。
 * 没认出来的围栏（```` ```text ````）仍是 markdown 的地盘，这一组照常生效——与
 * `htmlTagCompletion` 同一种覆盖面。
 *
 * ## 🔴 交出去的必须是**函数**，⛔ 不能写成 `{autocomplete: [source]}`
 *
 * `autocomplete` 的 dist 里，语言数据的每一项都要过一遍 `asSource`，而它对数组的处理是
 * `completeFromList(source)`——**把数组当成一份静态候选表**（元素是字符串或 `Completion`），
 * 不是「一组源」。写成 `[source]` 的后果是：里面那个函数被当成一条候选，label 是 undefined，
 * 浮层永远不出东西，而控制台干干净净。`Language.data` 的类型是 `{[name: string]: any}`，
 * 所以 `tsc` 也不会拦。与 `wordSource` 的 `{autocomplete: completeWords}` 对齐即可，
 * `linkSource.test.ts` 里有一条专门钉这个形状。
 *
 * ## ⚠️ 与词补全并存，不互斥
 *
 * 打 `](no` 时补全浮层里会**同时**出现路径与文档词（词补全打满两个字符就自己弹）。
 * 刻意不去压掉后者：压它得在 `completeWords` 里判「此刻是不是在链接目标里」，而那个判断
 * 是全局的——`a[0](x)` 在 JS/Python 里长得一模一样，压下去的代价是**代码文件里的正常词补全
 * 莫名失效**，那种 bug 没人会想到来查这里。VS Code 的 Markdown 也是两个源并列的。
 *
 * ## 🔴 结果必须带 `filter: false`，否则 CM6 会拿**用户打的那一段**再筛一遍
 *
 * CM6 收到源的结果之后，默认把 `state.sliceDoc(from, to)`（也就是 `](` 到光标之间那段原文）
 * 当成模式，对每一条候选的 `label` 做一次模糊匹配，**不匹配的丢掉**（dist 里
 * `sortOptions` 的 `else` 那一支）。我们的 `label` 是**重算过的相对目标**，与用户打的字
 * 天然对不上：
 *
 * - 打 `](../im`：模式是 `../im`，而候选是 `img/a.png`——开头那两个 `.` 在候选里根本不存在，
 *   于是**全部候选被丢掉**。这正是「剥掉 `../` 再查」想救的那个场面，被 CM6 又筛回去了；
 * - 打 `](im`：`img/a.png` 能过，`../README.md` 过不了（`README.md` 里没有 `i`）。
 *
 * 而筛选本来就已经做过了：Rust 的 `fuzzy_score` 拿剥过前缀的 needle 在**项目根相对路径**上
 * 匹配、按分数排序、截到 50 条。CM6 再筛一遍只会用错口径把对的候选扔掉，所以这里显式关掉。
 *
 * ⚠️ 关掉之后 CM6 给每条候选的分数是 `1e9 - 序号`（dist 里写死的），于是**保持我们递上去的顺序**，
 * 并且排在词补全那些候选前面——两者正好都是想要的：Rust 的顺序就是相关度顺序，
 * 而在链接目标里路径候选本来就该压在文档词上面。
 *
 * ## 🔴 异步源必须自己吃掉失败
 *
 * `query_project` 是一次 IPC，会 reject（根不合法、盘拔了）。CM6 对源的处理是
 * `Promise.resolve(source(context)).then(ok, err => { dispatch(closeCompletion); logException(err) })`
 * ——**reject 的后果是浮层被关掉 + 控制台一个异常**，而用户看到的只是「打了一半列表没了」。
 * 所以这里给 `.then` 配了第二个回调，把失败翻译成「这一轮没有候选」。
 *
 * ## ⚠️ 慢查询不会插进去一份过期列表
 *
 * 第一次触发要现建索引（两万文件 40ms、十万文件 205ms，数字来自 `query_project` 的注释），
 * 用户完全可能在这两百毫秒里又打了五个字。两条兜底都是 CM6 自己的：
 * ① 结果落地前它会查 `context.aborted`，作废的直接扔；
 * ② 没作废的会拿 `validFor` 对**当前**那段文字重新过一遍。
 * 于是 `validFor` 在这里不是装饰：它决定了「用户已经打到 `../img/` 了，那份只查到 `../i`
 * 的结果还能不能用」。
 */

/**
 * 单个编辑器上的钩子：给一段已经打出来的目标文字，回一批**可以直接插进正文**的链接。
 * `null` 与空数组都表示「没有候选」——前者是「这一轮我不参与」，后者是「参与了，没找到」。
 */
export type LinkCompletionHook = (typed: string) => Promise<string[] | null>

/**
 * 工作区级的钩子，比上面多一个参数：**当前文档的绝对路径**。
 *
 * 为什么要多这一层：补全源拿到的只有 `CompletionContext`，而 context 只给 `state`、
 * ⛔ 不给 view，于是「这份文档在磁盘上的哪个目录」在这一层问不出来——那是标签的知识。
 * `doc/tab.ts` 的 `createTab` 把它闭包成每标签一份的 [`LinkCompletionHook`]，
 * 与 `pasteImage` / `clickDefinition` 走的是同一条注入链。
 */
export type LinkFilesHook = (typed: string, docPath: string | null) => Promise<string[] | null>

/**
 * 「光标在一个还没闭合的链接目标里」。
 *
 * ⚠️ 正则**不带 `$` 尾锚**，`matchBefore` 自己会加：它把光标前那一行（最多 250 字符）
 * 切出来，用 `ensureAnchor(expr, false)` 锚到末尾再搜。所以 `[^)]*` 会一直吃到光标为止，
 * 而遇到 `)` 就停——`[a](b) 一些正文|` 因此不会被认成链接目标。
 *
 * 🔴 顺带一个免费的限制：250 字符的窗口意味着「链接目标长过 250 字符」时不再补全。
 * 那不是缺陷，那种链接本身就该被换行拆开。
 */
const LINK_RE = /\]\([^)]*/

/** 与 `LINK_RE` 的尾巴同一个字符类：打出一个 `)` 就算这个目标写完了，列表该收起来 */
const VALID_RE = /^[^)]*$/

/** `](` 是两个字符，补全的起点要跳过它们——否则插进去的路径会把 `](` 一起吃掉 */
const OPEN_LEN = 2

/**
 * 光标是不是正落在一个链接目标里，以及「已经打出来的那段」与「该从哪儿开始替换」。
 *
 * 单独导出是为了能在不建 view 的情况下钉住它：`CompletionContext` 是可以拿一个裸
 * `EditorState` 造出来的，而这一层的判断全是 state 上的字符串运算。
 */
export function linkContext(context: CompletionContext): { from: number; typed: string } | null {
  const match = context.matchBefore(LINK_RE)
  if (match === null) return null
  return { from: match.from + OPEN_LEN, typed: match.text.slice(OPEN_LEN) }
}

/**
 * 装上链接补全。缺省不装（`EditorSetupOptions.completeLinks` 没传就没有这一组），
 * 所以 `createEditorState` 被单独调用时（测试、将来的复用）行为与 M3-A-6 之前逐字一致。
 */
export function linkCompletions(hook: LinkCompletionHook): Extension {
  const source = (context: CompletionContext): Promise<CompletionResult | null> | null => {
    const at = linkContext(context)
    if (at === null) return null
    return hook(at.typed).then(
      (names): CompletionResult | null => {
        // 空列表回 null 而不是 `{options: []}`：与 `completeWords` 同一条口径，
        // 空结果会让 CM6 认为「这个源给过了，没有东西」，而 null 是「这次我不参与」
        if (names === null || names.length === 0) return null
        const options: Completion[] = names.map((label) => ({ label }))
        // `filter: false` 是必需的，见文件头那一节
        return { from: at.from, options, filter: false, validFor: VALID_RE }
      },
      () => null,
    )
  }
  return markdownLanguage.data.of({ autocomplete: source })
}
