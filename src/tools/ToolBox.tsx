import { createEffect, createMemo, For, Show, type JSX } from 'solid-js'
import { lineBoundsAt, type LineBounds, type ToolOption } from './tool'
import { OUTPUT_PLACEHOLDER, type ToolBox } from './store'

/**
 * 工具箱那块浮层（M3-B-1，PLAN §1.5「配一个通用 `ToolPanel` 组件」）。
 *
 * 分工与 `src/search/FindInFiles.tsx`、`src/goto/QuickOpen.tsx` 一致：
 * **状态机全在 `./store.ts`，这里只管画与收键盘**。这一层不判断「该不该跑」「哪一次的结果算数」，
 * 所以组件测试只需要盯住「画出来的东西对不对得上 store」与「按键有没有落到 store 上」。
 *
 * ## 一块居中的大浮层，两栏常驻
 *
 * 左栏目录、右栏工作台，⛔ 没有「先浏览、再进去」的两屏。代价是用的时候看不见文档，
 * 而那正是「从编辑器取 / 插回编辑器」两个按钮存在的理由。
 *
 * ## ⚠️ 左栏**不**虚拟化
 *
 * 与 QuickOpen / 搜索结果列表相反：那边是「十万个文件」，这边 P0 是 17 个工具、
 * P1 再加十来个，连分类标题一起也就三十几行。挂上 `src/ui/virtual.ts` 只会换来一个
 * 量不到高度的 jsdom（`clientHeight` 恒为 0，组件测试永远只看得见头 6 行）
 *
 * ## 键盘
 *
 * 与 QuickOpen 同一条规矩：`Escape` 在自己的子树里处理，**不注册成命令**——
 * 命令中心的 keybinding 挂在 `window` 的**捕获**阶段（见 `src/commands/dispatch.ts`），
 * 捕获跑在冒泡之前，浮层里的 `stopPropagation` 拦不住它。
 *
 * ⚠️ ↑↓ 只在**过滤框**里改选中行，不在输入格里：那两格是 textarea，
 * 抢走方向键等于让人没法在一行 JSON 里左右移动光标
 */

export interface ToolBoxProps {
  /** App 建一次、从不换引用的那份状态，见 `./store.ts` */
  box: ToolBox
}

export function ToolBox(props: ToolBoxProps) {
  // 与 QuickOpen / Sidebar 同理：`box` 是 `createToolBox()` 返回的普通对象，引用从不变；
  // 响应式读取全走 `box.rows()` 这类访问器。留在 `props.box` 上现读的话，
  // 每个闭包都会被 lint 当成「在追踪范围外面读响应式值」
  // eslint-disable-next-line solid/reactivity
  const box = props.box

  let filterEl: HTMLInputElement | undefined
  let inputEl: HTMLTextAreaElement | undefined
  let listEl: HTMLDivElement | undefined

  /** 输出格里的三态。占位句与真结果必须是两个样子：一块空白看不出是「还没跑」还是「跑出来是空的」 */
  const output = createMemo(() => {
    const result = box.result()
    if (result === null || (result.kind === 'ok' && result.text === ''))
      return { text: OUTPUT_PLACEHOLDER, state: 'placeholder' as const }
    if (result.kind === 'error') return { text: result.text, state: 'error' as const }
    return { text: result.text, state: 'ok' as const }
  })

  /** 输入格该不该出现。`input: 'none'` 的工具（UUID 生成器）没有输入这一半 */
  const wantsInput = createMemo(() => {
    const tool = box.tool()
    return tool !== null && tool.input !== 'none'
  })

  /**
   * 输入格里那一个**可跳的位置**（M3-B-2 加的，M3-B-5 从「只有出错才有」放宽）。`null` = 没有。
   *
   * ⚠️ 读的是 `box.input()`，因为 `ToolResult.at` 是**输入串**里的下标，
   * 而输入格里的文字就是那一份。工具内部跑的那一份（抹掉注释之后的）与它**逐下标对齐**——
   * 抹注释是等长的，理由写在 `builtin.ts` 的 `runJson` 上
   *
   * 🔴 **成功**的结果也可以带 `at`：正则测试器在「匹配清单」那一个模式下把它填成
   * **第一处匹配**的下标，于是看完清单能一键回到输入格里那一处。按钮的措辞跟着 `kind` 走，
   * 因为「跳到出错处」与「跳到第一处」做的是同一件事（把输入格的选区挪过去），
   * 而共用一句话的话，跑成功的时候屏幕上也写着「出错」两个字
   *
   * 🔴 只有工具**自己给了** `at` 才有这个按钮。不是从输出那句话里用正则抠一个行号出来：
   * 那句话是给人读的，措辞随工具变，而 `at` 是给机器读的
   */
  const jumpTarget = createMemo((): { bounds: LineBounds; label: string } | null => {
    const result = box.result()
    if (result === null || result.at === undefined) return null
    return {
      bounds: lineBoundsAt(box.input(), result.at),
      label: result.kind === 'error' ? '跳到出错处' : '跳到第一处',
    }
  })

  /**
   * 把输入格的选区落到那一行，并把焦点交回去。
   *
   * ⚠️ 选**一整行**而不是只放一个光标：光标落进去之后用户还得自己找这一行里哪里不对，
   * 而选中之后那一行在格子里是亮着的，与输出格里那个 `^` 说的是同一处。
   *
   * 🔴 顺序是 `focus()` 在前：反过来（先选后聚焦）的话聚焦那一下会把选区拉回
   * 上次离开时的位置。⚠️ 而「聚焦之后格子会不会滚到选区那一行」是引擎的事，
   * jsdom 里量不出来——这一条进了真机待验清单
   */
  function jumpTo(): void {
    const target = jumpTarget()
    if (inputEl === undefined || target === null) return
    inputEl.focus()
    inputEl.setSelectionRange(target.bounds.from, target.bounds.to)
  }

  function focusTarget(): HTMLElement | undefined {
    // 打开工具箱之后的第一个动作多半是往输入格里粘东西，而不是重新挑一遍工具：
    // 上次那个工具还选着、输入还留着（`store.ts` 的 `hide()` 刻意不清）。
    // 只有没有输入格的工具才把焦点交给左栏的过滤框
    return wantsInput() ? inputEl : filterEl
  }

  /**
   * 展开一次要 focus，换了一个工具也要 focus。
   *
   * ⚠️ 用**计数**而不是布尔来触发展开那一次：浮层已经开着的时候再按一次 `Mod+Shift+T`，
   * 布尔值不变就不会触发这个 effect，焦点也就抢不回来（理由与 `goto/store.ts` 逐字相同）。
   * 挂在 effect 而不是 `onMount` 上，是因为 `<Show when={box.visible()}>` 那次写入与
   * `focusRequest` 那次在同一批里——effect 跑的时候 ref 已经指到新建出来的那个节点了
   */
  createEffect(() => {
    // ⚠️ 两个订阅都写进条件里，不是「读了不用」：`focusRequest` 是计数，
    // `id` 让「点了左栏另一个工具」也触发一次——那一下之后用户接着就该打字
    const request = box.focusRequest()
    const id = box.tool()?.id ?? null
    if (request === 0 && id === null) return
    focusTarget()?.focus()
  })

  /**
   * 🔴 把控件的值拉回 store 里那一个。**必需的，不是保险**。
   *
   * `setOption` 收窄失败时故意保持原值不动（`store.ts`：悄悄夹到边界上的话，
   * 屏幕上那个格子写着 999、`run` 收到的是 64）。而 signal 不变就意味着 Solid 不重渲染，
   * 于是 DOM 会停在用户刚打的那个非法值上——正是 store 想避免的那一幕，换了个地方发生。
   * 拉回来之后，用户看见的就是真的会跑的那个数
   */
  function commitText(key: string, el: HTMLInputElement | HTMLSelectElement, raw: string): void {
    box.setOption(key, raw)
    el.value = String(box.options()[key] ?? '')
  }

  function commitToggle(key: string, el: HTMLInputElement, raw: boolean): void {
    box.setOption(key, raw)
    el.checked = Boolean(box.options()[key])
  }

  /**
   * 文字格（`kind: 'text'`）那一条：**只在被拒绝的时候**才把 DOM 拉回来。
   *
   * 🔴 与上面两个 `commit*` 的差别不是风格问题。这一格用 `input` 事件，于是它每打一个字
   * 就跑一次；而给一个**正在打字**的格子写 `.value`（哪怕写的是同一串）在 WebKit 里会把
   * 插入点甩到末尾——「在正则中间插一个字」就变成了「插到末尾」。
   * `select` / `number` 那两格没这个风险：前者是选出来的，后者失焦才提交。
   *
   * ⚠️ `text` 的 `coerceOption` 收任意字符串，所以「被拒绝」在正则测试器上**结构上到不了**；
   * 留着这一支是为了让「拉回来」这件事只在真需要的时候发生，⛔ 不是为了兜一个不存在的错
   */
  function commitInput(key: string, el: HTMLInputElement, raw: string): void {
    box.setOption(key, raw)
    const current = String(box.options()[key] ?? '')
    if (current !== raw) el.value = current
  }

  /** 四个分支写成 `if` 链而不是 `switch`：判别联合穷举之后 TS 仍然认为函数末尾可达 */
  function optionControl(option: ToolOption): JSX.Element {
    const key = option.key
    const value = () => String(box.options()[key] ?? '')
    if (option.kind === 'text') {
      return (
        <label class="toolbox-option">
          <span>{option.label}</span>
          {/* 🔴 初值写 `option.default` 而**不是** `value()`（读 store）：`option` 是个普通参数，
              没有 signal，于是 Solid 把这一格当**静态属性**处理，只在创建 DOM 那一刻赋一次。
              读 store 就会包进 effect，于是每打一个字 Solid 都把 `.value` 重写一遍，
              而重写 `.value` 正是上面 `commitInput` 在躲的那件事。
              ⚠️ 两者在挂载那一刻必然相等：换工具时 `select()` 会 `setOptions(defaultOptions(next))`
              并且整排选项重建。所以「非响应式」不是偷工——是这两个来源在结构上不会漂移 */}
          <input
            type="text"
            value={option.default}
            spellcheck={false}
            onInput={(e) => commitInput(key, e.currentTarget, e.currentTarget.value)}
          />
        </label>
      )
    }
    if (option.kind === 'toggle') {
      return (
        <label class="toolbox-option">
          <input
            type="checkbox"
            checked={Boolean(box.options()[key])}
            onChange={(e) => commitToggle(key, e.currentTarget, e.currentTarget.checked)}
          />
          <span>{option.label}</span>
        </label>
      )
    }
    if (option.kind === 'select') {
      return (
        <label class="toolbox-option">
          <span>{option.label}</span>
          <select value={value()} onChange={(e) => commitText(key, e.currentTarget, e.currentTarget.value)}>
            <For each={option.choices}>{(choice) => <option value={choice}>{choice}</option>}</For>
          </select>
        </label>
      )
    }
    return (
      <label class="toolbox-option">
        <span>{option.label}</span>
        <input
          type="number"
          min={option.min}
          max={option.max}
          value={value()}
          onChange={(e) => commitText(key, e.currentTarget, e.currentTarget.value)}
        />
      </label>
    )
  }

  function scrollCursorIntoView() {
    const el = listEl?.querySelector<HTMLElement>('.toolbox-row.selected')
    // ⚠️ 可选调用不是保险：jsdom 压根没实现 `scrollIntoView`（`src/md/scrollSync.ts` 同一个坑），
    // 于是组件测试里这一句空转，真机上它才把选中行带进视野
    el?.scrollIntoView?.({ block: 'nearest' })
  }

  /** 浮层本体上的按键：只管 `Escape` 与 `Cmd+Enter`，其余的一律放行给格子里的编辑 */
  function onOverlayKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      box.hide()
      return
    }
    // `Cmd+Enter` = 立刻跑一次，丢掉在飞的那一次防抖。改完一个选项想马上看见结果时用；
    // ⛔ 不注册成命令：它只在这块浮层里有意义，而命令是全局的
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      box.runNow()
    }
  }

  /** 过滤框上的按键：这是左栏唯一的键盘入口 */
  function onFilterKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const before = box.cursor()
      box.moveCursor(e.key === 'ArrowDown' ? 1 : -1)
      if (box.cursor() !== before) scrollCursorIntoView()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      box.commitCursor()
    }
  }

  return (
    <Show when={box.visible()}>
      <div
        class="toolbox-backdrop"
        onKeyDown={onOverlayKeyDown}
        // 点遮罩空白处收起，点子元素不算：`currentTarget === target` 是判这件事最省的办法
        // （与 QuickOpen 的 `.palette-backdrop` 同一条）
        onClick={(e) => {
          if (e.currentTarget === e.target) box.hide()
        }}
      >
        <div class="toolbox" role="dialog" aria-label="工具箱">
          <div class="toolbox-head">
            <span class="toolbox-title">工具箱</span>
            <Show when={box.tool()}>{(tool) => <span class="toolbox-current">{tool().name}</span>}</Show>
            <button class="toolbox-close" aria-label="关闭工具箱" onClick={() => box.hide()}>
              ×
            </button>
          </div>

          <div class="toolbox-body">
            <div class="toolbox-nav">
              <input
                class="toolbox-filter"
                ref={filterEl}
                type="text"
                value={box.filter()}
                placeholder="找工具…"
                aria-label="过滤工具"
                spellcheck={false}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                onInput={(e) => box.setFilter(e.currentTarget.value)}
                onKeyDown={onFilterKeyDown}
              />
              <div class="toolbox-list" ref={listEl} role="listbox" aria-label="工具">
                <For each={box.rows()}>
                  {(row, i) =>
                    row.kind === 'header' ? (
                      // 分类标题不是候选，所以不进 listbox 的语义：读屏的人听到的是一列工具名，
                      // 中间夹着几个「格式化」「文本」，与眼睛看到的一致
                      <div class="toolbox-group" role="presentation">
                        {row.label}
                      </div>
                    ) : (
                      <div
                        class="toolbox-row"
                        classList={{ selected: box.cursor() === i() }}
                        role="option"
                        aria-selected={box.cursor() === i()}
                        title={row.name}
                        onClick={() => box.openTool(row.id)}
                        // 鼠标移到哪一行就选中哪一行：浮层是「按 Enter 落地」的东西，
                        // 让悬停与选中不一致的话，用户会以为 Enter 打开的是他指着的那一行
                        onMouseEnter={() => box.selectRow(i())}
                      >
                        {row.name}
                      </div>
                    )
                  }
                </For>
                <Show when={box.rows().length === 0}>
                  <div class="toolbox-empty">
                    {box.filter() === '' ? '工具箱还是空的' : `没有匹配「${box.filter()}」的工具`}
                  </div>
                </Show>
              </div>
            </div>

            <div class="toolbox-work">
              <Show when={box.tool()} keyed fallback={<div class="toolbox-empty">还没有工具</div>}>
                {(tool) => (
                  <>
                    <Show when={(tool.options ?? []).length > 0}>
                      <div class="toolbox-options">
                        <For each={tool.options}>{(option) => optionControl(option)}</For>
                      </div>
                    </Show>

                    <div class="toolbox-io">
                      <Show when={wantsInput()}>
                        <div class="toolbox-pane">
                          <span class="toolbox-pane-label">输入</span>
                          <textarea
                            class="toolbox-text input"
                            ref={inputEl}
                            value={box.input()}
                            aria-label="工具输入"
                            spellcheck={false}
                            wrap="off"
                            onInput={(e) => box.setInput(e.currentTarget.value)}
                          />
                        </div>
                      </Show>
                      <div class="toolbox-pane">
                        <span class="toolbox-pane-label">输出</span>
                        <textarea
                          class="toolbox-text output"
                          classList={{
                            placeholder: output().state === 'placeholder',
                            error: output().state === 'error',
                          }}
                          value={output().text}
                          aria-label="工具输出"
                          aria-live="polite"
                          spellcheck={false}
                          wrap="off"
                          readOnly
                        />
                      </div>
                    </div>

                    <div class="toolbox-actions">
                      {/* 🔴 纯生成器（`input: 'none'`）的**主动作**，所以排在最前面：
                          这一类工具的输出是随机的，而「再来一批」是它唯一有意义的重复操作。
                          ⚠️ 反过来拿 `!wantsInput()` 门着——吃输入的工具输出是确定的，
                          给它一个「重新生成」等于给一个不会变的值配一个刷新键，
                          按下去什么都不发生，正是这个代码库一路在躲的那种失败 */}
                      <Show when={!wantsInput()}>
                        <button onClick={() => box.runNow()}>重新生成</button>
                      </Show>
                      {/* ⚠️ 跳转排在「复制结果」之前：出错的时候后两个都是灰的，
                          于是那一排里唯一按得动的就是它 */}
                      <Show when={wantsInput()}>
                        <Show when={jumpTarget()}>
                          {(target) => <button onClick={jumpTo}>{target().label}</button>}
                        </Show>
                      </Show>
                      <Show when={wantsInput()}>
                        <button onClick={() => box.takeFromEditor()}>从编辑器取</button>
                      </Show>
                      <button onClick={() => box.copyResult()} disabled={output().state !== 'ok'}>
                        复制结果
                      </button>
                      <button onClick={() => box.insertIntoEditor()} disabled={output().state !== 'ok'}>
                        插回编辑器
                      </button>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </div>

          <div class="toolbox-foot" classList={{ busy: box.busy() }}>
            {/* 两个槽位刻意分开：`optionError` 说的是「你刚改的那个值不合法」，
                `notice` 说的是「面板自己做的那件事怎么了」。混成一句的话，
                「缩进要在 2…8 之间」与「已复制 12 个字符」会互相盖掉 */}
            <Show when={box.optionError()}>{(text) => <span class="toolbox-bad">{text()}</span>}</Show>
            <Show when={box.notice()}>{(text) => <span class="toolbox-notice">{text()}</span>}</Show>
            <span class="toolbox-status">{box.footer()}</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
