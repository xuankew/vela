/**
 * 跳转历史：「跳出去之后还能回得来」的那一套上下文栈（M5-3）。
 *
 * 这一层是**纯数据**：两个数组、三条操作，不认识标签、不认识编辑器、也不认识 DOM。
 * 「哪个标签还活着」「怎么把光标放回去」全在宿主那边（`src/App.tsx` 的 `navRestore`），
 * 与 `goto/definition.ts` 只答「这个词的定义在哪儿」、不答「跳过去」是同一条分工。
 *
 * ## 一条历史记的是「跳之前站在哪儿」
 *
 * 于是「返回」= 把栈顶那一条装回去。⛔ 不是记「跳到了哪儿」：那种记法要用户按两次才回得去
 * （第一次退回起跳点之前的那一跳），而他要的是一次到位。
 *
 * ## 🔴 关掉的标签由宿主的 `isLive` 挡掉，而且**当场扔掉**
 *
 * 历史里存的是 `tabId`，而标签随时会被关掉。弹栈时遇到死条目不是「停下来什么都不做」，
 * 而是把它扔掉、继续往前找活的——停下来的表现是「按返回没反应，得连按三下才动」，
 * 用户没法知道那三下里发生了什么。
 *
 * ⛔ 存路径而不是 `tabId`（于是关掉的标签也能重新打开回来）是另一种做法，这里刻意不做：
 * 重新打开要读盘、要处理「文件已经没了／权限变了／大到只能走分片」，而分片那条路
 * 连「位置」都不是同一个量（行号 vs 光标偏移）。代价与收益不成比例
 *
 * ## 🔴「回去等于没动」的条目也跳过
 *
 * 光标本来就停在定义上时按 `⌥⌘D`、或者 `Cmd+P` 挑的正是当前这个文件，记下来的原点
 * 就是脚下这一处。把它弹出去的症状是**屏幕上一个字都不变**，而用户没法区分
 * 「历史是空的」和「这个键坏了」——那正是 M5-2 给 `Cmd+Click` 定的那条底线的反面
 * （「接管的前提是这一下会换来一个动作」，见 `editor/clickJump.ts`）
 *
 * ## ⚠️ 分片标签：`pos` 是 null
 *
 * 只读大文件走分片视图（`src/doc/shardView.ts`），那儿**没有 CM6 state，也就没有光标**，
 * 位置的唯一表达是「滚动条在哪一行」，而那一层没有把当前行号暴露出来的接口。
 * 于是从分片标签起跳时记下来的是一条只有标签、没有位置的历史：返回会把那个标签切回来，
 * 但**不动**它的滚动位置。给 `ShardView` 加一个 `topLine` 访问器就能补齐，那是另一个模块的改动
 */

/** 一条导航历史：哪个标签 + 那个标签里的哪个位置 */
export interface NavEntry {
  readonly tabId: number
  /**
   * 光标位置（0 起）。`null` = 分片标签，那儿没有「光标」这个概念，
   * 回去只切标签、不动位置（理由见文件头）
   */
  readonly pos: number | null
}

/**
 * 栈的上限。
 *
 * 50 条足够一次会话里翻来覆去地跳，而两条数组各 50 个 `{tabId, pos}` 对象是几 KB 的事。
 * 真正要防的不是内存而是「按 500 下返回」这种没有尽头的状态：超了就从**最老**那头掉
 */
export const MAX_NAV_ENTRIES = 50

export interface NavHistory {
  /**
   * 记下「起跳前站在哪儿」。
   *
   * 🔴 顺手把前进栈清空：与浏览器的历史同一条语义——回到中间某一处之后再跳一次，
   * 原来那条「前进」就不成立了。不清空的后果是按前进跳到一个用户根本没去过的地方
   */
  push(entry: NavEntry): void
  /**
   * 返回：把 `current`（用户此刻站在哪儿）压进前进栈，弹出栈顶那条**回得去的**历史。
   * 没有可返回的地方时回 `null`，此时两个栈一个字都不改
   */
  back(current: NavEntry): NavEntry | null
  /** `back` 的镜像：把 `current` 压回返回栈，弹出前进栈顶那条活着的历史 */
  forward(current: NavEntry): NavEntry | null
}

export interface NavHistoryOptions {
  /**
   * 这条历史还回得去吗（那个标签还开着吗）。宿主给，因为只有它认识标签表。
   *
   * ⚠️ 实现里通常会读一个信号（`ws.tabs()`），而 `back` / `forward` 可能跑在
   * 一个 `createEffect` 里——那样一来这个读取就成了订阅。宿主要自己 `untrack`
   */
  isLive: (entry: NavEntry) => boolean
  /** 覆盖 `MAX_NAV_ENTRIES`。只在测试里用得上 */
  readonly max?: number
}

export function createNavHistory(options: NavHistoryOptions): NavHistory {
  const { isLive } = options
  const max = options.max ?? MAX_NAV_ENTRIES

  /** 返回栈：栈顶（数组末尾）是最近一次起跳的地方 */
  const backStack: NavEntry[] = []
  /** 前进栈：只有 `back` / `forward` 会往里写，`push` 会把它整个清掉 */
  const forwardStack: NavEntry[] = []

  function onto(stack: NavEntry[], entry: NavEntry) {
    stack.push(entry)
    // 从最老那头掉：`shift` 是 O(n)，而 n 上限 50，一次跳转多拷 50 个引用不值得优化
    if (stack.length > max) stack.shift()
  }

  /**
   * 从栈顶往下找第一条**回得去的**，途中把不合格的条目扔掉。
   *
   * 不合格有两种：那个标签已经关掉了（`isLive` 说不是），以及那一条与 `current`
   * 逐字段相同——后者是「装回去等于没动」：光标本来就在定义上时按 `⌥⌘D`、
   * 或者 `Cmd+P` 挑的正是当前这个文件，记下来的原点就是脚下这一处。
   * 把它弹出去的症状是**屏幕上一个字都不变**，而用户没法区分「历史是空的」和「这个键坏了」。
   *
   * ⚠️ 找不到时回 `null` 而且栈已经被清干净了——那是想要的结果：不合格的条目留着只会在
   * 下一次弹栈时再被扫一遍
   */
  function popLive(stack: NavEntry[], current: NavEntry): NavEntry | null {
    while (stack.length > 0) {
      const entry = stack.pop()!
      if (isLive(entry) && !sameEntry(entry, current)) return entry
    }
    return null
  }

  /** 与栈顶那一条**逐字段相同**就不记 */
  function sameEntry(a: NavEntry, b: NavEntry): boolean {
    return a.tabId === b.tabId && a.pos === b.pos
  }

  return {
    push(entry) {
      const top = backStack[backStack.length - 1]
      if (top !== undefined && sameEntry(top, entry)) return
      forwardStack.length = 0
      onto(backStack, entry)
    },

    back(current) {
      const entry = popLive(backStack, current)
      if (entry === null) return null
      onto(forwardStack, current)
      return entry
    },

    forward(current) {
      const entry = popLive(forwardStack, current)
      if (entry === null) return null
      onto(backStack, current)
      return entry
    },
  }
}
