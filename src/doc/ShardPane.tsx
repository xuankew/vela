import { createEffect, For, onCleanup, onMount, Show } from 'solid-js'
import { SHARD_ROW_HEIGHT, type ShardRow, type ShardView } from './shardView'

/**
 * 只读分片视图（M2-H）。挂在 `.editor-host` 里**代替** `EditorPane`，不是盖在它上面。
 *
 * ## 🔴 为什么是替换而不是叠加
 *
 * 叠一层遮罩在 CM6 上面的话，那块编辑器还活着、`ws.focusedEditor()` 还返回它，
 * 于是 `Mod+F`、`Alt+Z`、查找替换、多光标——所有 `when: (ctx) => ctx.editor !== null`
 * 的命令**全部照常可用**，而它们改的是那份空 buffer。用户按 ⌘F 会弹出一个查找面板，
 * 在零个字符里搜索。
 *
 * 替换掉之后 `attach` 压根不会发生，`focusedEditor()` 自然是 null，那一批命令一起失效。
 * 一个条件渲染换来的是「只读」这件事在**命令层**也成立，而不只是在视觉上成立
 *
 * ## ⚠️ 行高只有一个真相
 *
 * 与文件树 / 搜索结果 / 浮层同一套：`SHARD_ROW_HEIGHT` 注入成 `--vela-shard-row-height`，
 * 样式表里所有行高都引用那个变量。⛔ 不要在 CSS 里再写一遍 `18px`——
 * 两边不一致的症状是**滚动条与内容错位**，而且越往下滚错得越多，看不出是行高的问题
 *
 * ## 🔴 这里**不**负责 `dispose`
 *
 * 与 `EditorPane` 刻意相反（那个在 `onCleanup` 里把现场存回标签）。分片的生命周期属于
 * **文档**，不属于面板：换标签会让这个组件卸载，而那个 fd 与那份行索引必须活到
 * 标签真的被关掉为止。收尾在 `workspace.ts` 的 `dropTab` / `requestWindowClose` 里，
 * 走 `doc.releaseShard()`。在这儿 dispose 的话，切走再切回来就只剩一个死视图
 *
 * ## ⚠️ 这里钉不住的东西
 *
 * 滚动到底顺不顺、18px 一屏放得下多少行、长行截断得难不难看——jsdom 里 `clientHeight`
 * 恒为 0（于是窗口只给 `OVERSCAN` 行），这些只能在看得到像素的地方判断
 */

export interface ShardPaneProps {
  /** `doc.shard()` 递进来的那一个。引用在标签的整个生命期里不变 */
  view: ShardView
  /**
   * 这块分屏拿到焦点时通知宿主——与 `EditorPane` 的同名 prop 是同一件事，
   * 少了它的后果很具体：`ws.focusedPaneId()` 停在别的分屏上，于是状态栏报的是
   * **另一个标签**的行数与字节数，而 `.editor-host.focused` 那圈描边也不过来。
   *
   * 挂在最外层的 `<section>` 上而不是滚动容器上：focusin 会冒泡，
   * 与 `EditorPane` 把 `onFocusIn` 挂在容器上同一条理由
   */
  onFocus?: () => void
}

export function ShardPane(props: ShardPaneProps) {
  // 与 Sidebar / StatusBar / FindInFiles 同理：`view` 是普通对象，引用从不变，
  // 响应式读取全走 `view.rows()` 这类访问器
  // eslint-disable-next-line solid/reactivity
  const view = props.view

  let scrollEl: HTMLDivElement | undefined

  /**
   * 量一次可视区高度，顺手把当前滚动位置报给 store。
   *
   * ⚠️ 与 `FindInFiles` 不同的一点：那边的 `measure` 只更新高度，滚动位置由 `onScroll`
   * 单独喂。这边合并成一个函数，因为 store 的 `scroll(scrollTop, viewportHeight)`
   * **两个参数一起收**——窗口算术要用高度，而它只在滚动那一刻被调用
   */
  function measure() {
    if (scrollEl) view.scroll(scrollEl.scrollTop, scrollEl.clientHeight)
  }

  onMount(() => {
    measure()
    // 不用 ResizeObserver：jsdom 里没有（见 `FindInFiles.tsx` 的同一条注释），
    // 而分片面板的高度只跟着窗口与分屏走，`resize` 已经够
    window.addEventListener('resize', measure)
  })
  onCleanup(() => window.removeEventListener('resize', measure))

  /**
   * 把「跳到某一行」落到 DOM 上。
   *
   * ⚠️ 判 `jump === null` 而不是靠首次不跑：`jumpTo()` 一开始就是 null，
   * 而 `defer` 掉的 effect 在**第二次**跳同一个位置时也不会跑（见 store 里那段：
   * 每次一个新对象正是为了让它永远是一次事件）
   */
  createEffect(() => {
    const jump = view.jumpTo()
    if (jump === null || scrollEl === undefined) return
    scrollEl.scrollTop = jump.top
  })

  return (
    <section
      class="shard-pane"
      style={{ '--vela-shard-row-height': `${SHARD_ROW_HEIGHT}px` }}
      onFocusIn={() => props.onFocus?.()}
    >
      <div class="shard-head">
        <span class="shard-badge" title="这个文件太大，Vela 只读地按页取它：不能编辑，也不能保存">
          只读
        </span>
        {/* 行数、字节数、编码、换行符一律**不在这里报**：状态栏那一排已经在报了，
            而它是这类信息的惯例位置（Sublime 与 VS Code 都是）。这里只留「只读」本身
            与它的两条限定——分屏时非聚焦那一块没有状态栏可看，这一块得自己说清楚

            三种尾部互斥：报错最要紧（它解释了为什么下面几行是空的），
            其次是「正在读」，都没有的时候才是那句常驻的说明 */}
        <Show
          when={view.error()}
          fallback={
            <Show when={view.busy()} fallback={<span class="shard-tail">不随外部改动刷新</span>}>
              <span class="shard-tail busy">读取中…</span>
            </Show>
          }
        >
          {(text) => <span class="shard-error">{text()}</span>}
        </Show>
      </div>

      <div
        class="shard-scroll"
        ref={scrollEl}
        tabIndex={0}
        role="document"
        aria-label={`${view.header.totalLines.toLocaleString()} 行的只读视图`}
        onScroll={(e) => view.scroll(e.currentTarget.scrollTop, e.currentTarget.clientHeight)}
      >
        <div class="shard-spacer" style={{ height: `${view.totalHeight()}px` }}>
          <div class="shard-window" style={{ transform: `translateY(${view.offsetY()}px)` }}>
            {/* ⚠️ `rows()` 每次重算都造一批**新**行对象，所以 `<For>` 靠引用相等复用不了，
                一页回来就是把这一窗的几十个节点重挂一遍。刻意不去稳定它：
                窗口最多几十行，而稳定行对象要在 store 里维护一份按行号的缓存——
                那正是 `shardView.ts` 刚刚花力气避免的第二份状态 */}
            <For each={view.rows()}>
              {(row: ShardRow) => (
                <div class="shard-row" classList={{ gap: row.kind === 'gap', pending: row.kind === 'pending' }}>
                  <span class="shard-lineno">{row.line + 1}</span>
                  <span class="shard-text">
                    {row.text}
                    {/* 剪过的行补一个省略号：`MAX_ROW_CHARS` 之上的部分**不在缓存里**，
                        所以这不是「往右滚还能看到」，而是「这一行原本更长」（见 shardView.ts） */}
                    <Show when={row.clipped}>
                      <span class="shard-clip">…</span>
                    </Show>
                  </span>
                  {/* 逐页的有损标记。⚠️ 与 `header.lossy` 不是一回事，而这一格是它唯一的
                      露出点：文档级的 lossy 提示条讲的是「原样保存会损坏它」，
                      而分片模式压根不能保存（见 document.ts 的 `openAsShard`） */}
                  <Show when={row.lossy}>
                    <span
                      class="shard-flag"
                      title="这一页有字节没能解码，Vela 用替换字符顶着——原文件在这些位置上不是这个样子"
                    >
                      ⚠
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </section>
  )
}
