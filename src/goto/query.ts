/**
 * `Cmd+P` 那一格输入框的文法（M2-E-4）。
 *
 * 四种意图共用一个输入框，靠**前缀**与**后缀**区分——这是 VS Code 的 `Cmd+P` 的口径，
 * 也是用户唯一不需要学第二套按键就能猜到的口径：
 *
 * | 输入 | 意思 |
 * | --- | --- |
 * | ``（空） | 列出最近打开过的文件（`recent` 加分，见 `FileIndex::recent_bonus`） |
 * | `store` | 在项目里模糊找文件 |
 * | `:42` | 跳到**当前文档**第 42 行 |
 * | `store.ts:42` | 打开这个文件并跳到第 42 行 |
 * | `@安装` | 列出**当前文档**的标题（只有 Markdown 有，见 `./symbols.ts`） |
 *
 * ## 为什么 `:42` 不复用 CM6 自带的 gotoLine
 *
 * 它复用了——但只是**跳转那一步**。`Mod+Alt+G` 上那个 CM6 原生 `gotoLine` 原样留着
 * （夺一个用户已经习惯的键去换一个功能更弱的自建面板是净亏），这里做的是让同一个
 * 能力也能从 `Cmd+P` 里够到，而且能带上文件名。
 *
 * 跳行的落地也不新写：`{kind:'line'}` 的消费者对空 `ranges` 调
 * `revealTarget(doc, line, [])`，那个组合已经被 `src/search/reveal.test.ts` 钉住，
 * 语义正是「光标落在这一行的行首，什么都不选中」。
 *
 * ## ⚠️ 一个字符都不 trim
 *
 * 首尾空格是**查询的一部分**，原样递给 Rust 的 `query_project`：文件名里可以有空格
 * （`My Notes.md` 是 macOS 上极常见的名字），而「用户打了尾随空格」与「用户想找一个
 * 名字以空格结尾的文件」在这一格输入框里区分不出来。宁可让前者少命中几条——
 * 他删掉空格就好——也不要让后者永远搜不到。Rust 侧的 `needle` 文档写的是同一条规矩。
 *
 * ## 已知的两处误判，以及为什么留着
 *
 * - `file.ts:12:3`（VS Code 的 行:列）会被读成「文件 `file.ts:12` 的第 3 行」。
 *   列跳转本来就不在 v1 的范围里（`EditorController.reveal` 收的是位置，没有列的概念），
 *   于是这里的失败方式是**列表空着**——用户看得见，不会跳到错的地方去。
 * - 名字里带冒号又正好以 `:数字` 结尾的文件（`notes:2.md` 不算，`notes:2` 才算）
 *   会被拆成文件名 + 行号。macOS 允许这种名字，但 Finder 里显示成 `/`，
 *   实际碰到的概率低于「用户想跳行」的概率。
 *
 * 两条都换成更复杂的文法就能消掉，代价是这一格输入框的行为变得要查文档才知道。不值。
 */

/** 行号：不接受前导零与 `0`。`0` 在 1 起算的行号里没有意义，让它落回文件查询 */
const LINE = /^[1-9][0-9]*$/

export type GotoQuery =
  /** 在项目里找文件。`needle` 可以是空串（= 列出最近的那些） */
  | { readonly kind: 'file'; readonly needle: string }
  /** 跳到当前文档的某一行 */
  | { readonly kind: 'line'; readonly line: number }
  /** 打开某个文件并跳到它的某一行 */
  | { readonly kind: 'fileLine'; readonly needle: string; readonly line: number }
  /** 在当前文档的符号表里找。`needle` 可以是空串（= 全列出来） */
  | { readonly kind: 'symbol'; readonly needle: string }

/**
 * 把输入框里的原文分成四种意图之一。
 *
 * ⚠️ **顺序是有意义的**：`@` 与开头的 `:` 先判，剩下的才去尾部找 `:行号`。
 * 反过来做的话 `@foo:2` 会被当成「文件 `@foo` 的第 2 行」，而 `@` 开头是用户
 * 明确说「我要符号表」的信号，它该赢。
 *
 * @param raw 输入框的原文，**不做任何 trim**（理由见文件头）
 */
export function parseGotoQuery(raw: string): GotoQuery {
  if (raw.startsWith('@')) return { kind: 'symbol', needle: raw.slice(1) }

  if (raw.startsWith(':')) {
    const digits = raw.slice(1)
    if (LINE.test(digits)) return { kind: 'line', line: Number(digits) }
    // `:` 后面不是行号就整个当文件查询：`:foo` 更可能是在找一个名字里带冒号的文件，
    // 而不是一个打错的跳行。这里报错的话用户只会看到「什么都没发生」，更难查
    return { kind: 'file', needle: raw }
  }

  // 从**最后**一个冒号切：`C:\repo\a.ts:42` 要先让尾部的 `42` 当行号，
  // 剩下的 `C:\repo\a.ts` 整个是路径（Windows 的盘符因此不会被拆开）
  const cut = raw.lastIndexOf(':')
  // `cut > 0` 而不是 `>= 0`：开头就是冒号的情况上面已经处理过了，
  // 而 `:42` 落到这里意味着它不是合法行号，needle 不该是空串
  if (cut > 0 && LINE.test(raw.slice(cut + 1))) {
    return { kind: 'fileLine', needle: raw.slice(0, cut), line: Number(raw.slice(cut + 1)) }
  }

  return { kind: 'file', needle: raw }
}
