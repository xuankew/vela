import { createResource, For, onCleanup, Show, type Accessor } from 'solid-js'
import { languageFor } from '../editor/language'
import {
  ENCODING_CHOICES,
  ENCODING_IDS,
  ENCODING_LABELS,
  encodingChoiceId,
  LINE_ENDING_IDS,
  LINE_ENDING_LABELS,
  parseEncodingChoice,
  type EncodingId,
  type LineEndingId,
} from '../ipc/fs'
import { gitHeads, type GitHead } from '../ipc/git'
import { displayName } from '../project/tree'
import { UNTITLED_LABEL } from './document'
import type { Workspace } from './workspace'

export interface StatusBarProps {
  workspace: Workspace
  /**
   * 侧边栏那一格的接线。由 `App.tsx` 注入它的两个 signal 访问器。
   *
   * ⚠️ 可选，而且**不传就不渲染那一格**：这一排的其余格子只需要 `workspace`，
   * 侧边栏的可见性却活在 `App` 里（那里还有「打开文件夹就自动弹出来」那几条规则）。
   * 为了一格按钮把整套侧边栏状态搬进 workspace 是倒过来做——`workspace` 管的是标签与文档。
   */
  sidebar?: { open: () => boolean; toggle: () => void }
  /**
   * 工作区的根。与 `sidebar` 同一条取舍：**给了它才渲染**最右边那一格「当前分支」，
   * 因为根清单活在 `App` 里（`createProjectTree`），而这一排的其余格子只关心当前这份文档。
   *
   * ⚠️ 一个根都没有时这一格自然不出现，所以「没打开文件夹」与「打开了但不是 git 仓库」
   * 在界面上是同一种结果：什么都没有。这是刻意的——见 `ipc/git.ts` 那条「没有错误通道」
   */
  roots?: Accessor<readonly string[]>
}

/** 编码下拉里「一次性动作」那一组的前缀。另一半（保存格式）用 `save:` */
const REOPEN = 'reopen:'
const SAVE = 'save:'

/**
 * 分支那一格的前缀。
 *
 * 🔴 是**文字**而不是「分支」那个记号（U+2387 ⎇），量过的：拿这一排真实的字体栈
 * （`"LXGW WenKai Screen", -apple-system, sans-serif`）在 canvas 上量，U+2387 的宽度
 * 与一个**未分配码位**完全相同（都是 11px，正好等于字号），也就是主字体里没有这个字形、
 * 只能赌系统回退；作为对照，侧边栏那格的 `▥` 量出来是 9.51px，是个真字形。
 * 赌输的表现是画出一个方框，而在 11px 上方框看起来像是**渲染坏了**，不像是一个记号。
 *
 * 两个汉字的代价量出来是 22px，换来的东西在这一排里本来就不算稀客：`行 1，列 1`、
 * `只读分片`、`选中 N 字符` 全是汉字，记号才是那个异类。
 */
const BRANCH_LABEL = '分支'

/**
 * 一次读回来的「哪几个根 + 它们各自的 HEAD」。两半必须在同一个对象里，理由写在
 * `StatusBar` 里那个 `createResource` 上。
 */
interface GitRead {
  readonly roots: readonly string[]
  readonly heads: readonly (GitHead | null)[]
}

/**
 * 状态栏。口径与 `ws.metrics()` 一致：**只报聚焦分屏显示的那个标签**，不是全部标签的汇总。
 *
 * 语言那一格刻意不复用 `tab.language`——那是个普通字段不是 signal，路径变了或异步子语言
 * 落地时都不会触发重渲染，报出来的会是一个停在过去的语言。`languageFor(path())` 是纯函数
 * 且读的是 signal，显示值与 `syncLanguage` 会装的那个永远一致。
 *
 * 编码与换行符两格是 `<select>`，改的是**保存时用的格式**（`doc.changeFormat`，会标脏）。
 * 编码那一格还兼着「以某编码重新打开」：两组选项塞在同一个下拉里（`<optgroup>`），
 * 因为「我是想换种写法存出去，还是想换种读法重读一遍」是用户在同一个位置上做的同一个
 * 决定的两半，拆成两个入口只会让人猜哪个是哪个。
 *
 * 缩进那一格还是**只显示**：改缩进要先给 `indentUnit` 开一个每标签的 Compartment
 * （和语言槽位同一条理由），而「轻量编辑器里从状态栏改缩进」这件事本身就不是刚需。
 *
 * ## 只读分片是另一排（M2-H）
 *
 * `doc.shard()` 非 null 时下面那一整排**换成**另一套格子（`只读分片 · N 行 · X MB · 编码 · 换行符`），
 * 三条理由写在 JSX 里那段注释上。最要紧的是第二条：编码与换行符那两格会调
 * `doc.changeFormat`，而它**会标脏**——分片标签一脏就再也关不掉了（关闭确认要保存，
 * 而 `save` 在分片上一律拒绝）。所以它们在这里压根不渲染。
 *
 * ## 分支那一格不属于任何一排
 *
 * 最右边那一格「当前分支」读的是**项目根**（`props.roots`），不是当前这份文档，
 * 所以它画在上面两个 `<Show>` 之外：内联与只读分片两排都带着它。数据来自 `ipc/git.ts`
 * （Rust 侧只读 `.git/HEAD`，不跑 git 也不链 libgit2），刷新时机是「窗口重新获得焦点」——
 * 两条取舍都写在组件里那个 `createResource` 上。
 */
export function StatusBar(props: StatusBarProps) {
  // `workspace` 是 createWorkspace() 返回的普通对象（一组访问器），不是 signal；
  // App 只建它一次、也从不换引用，响应式读取全走 `ws.tabs()` 这类访问器，别名不需要被追踪。
  // eslint-disable-next-line solid/reactivity
  const ws = props.workspace
  // 与 `ws` 同一条处境：`App` 只传一次、也从不换这个访问器的引用，会变的是它读出来的
  // 那份清单。所以别名可以在追踪范围外面取一次——但 lint 认不出「它是函数不是值」
  // eslint-disable-next-line solid/reactivity
  const rootList = props.roots
  const doc = () => ws.activeTab().doc
  const m = () => ws.metrics()

  /**
   * 「当前分支」那一格的数据。
   *
   * 🔴 `roots` 与 `heads` 必须待在**同一个**资源值里，不能一个读 `props.roots()`、
   * 一个读资源：换工作区的那一瞬间新根已经生效、旧清单还没回来，于是「新根的名字 +
   * 旧根的分支」会被画在一起——每一格都长得对，只是说的是别人的分支。这与 Rust 侧
   * `git_heads` 那条「`null` 留在原位」的契约防的是同一种错位，一个在数据里防、
   * 一个在渲染里防。
   */
  const [git, { refetch }] = createResource(
    // `rootList` 没给的时候源是 `undefined`，于是资源压根不发请求（Solid 的口径：
    // 源为 `undefined` / `null` / `false` 就不取）——这一格也就不渲染
    () => rootList?.(),
    async (roots): Promise<GitRead> => {
      if (roots.length === 0) return { roots, heads: [] }
      // 🔴 这一格没有错误 UI，但**不能让它变成一条没人接的 rejection**：Solid 的资源
      // 只在有人读 `.error` 时才消化它，而这里没人读。所以在这儿就地接住。
      // 接住之后留一句日志——「这一格一直空着」在界面上与「这不是 git 仓库」长得
      // 一模一样，那句日志是两者之间唯一的区别（IPC 层坏了、或者 Rust 侧那个命令
      // 没编进去，都会走到这里）
      const heads = await gitHeads(roots).catch((err: unknown) => {
        console.warn('[statusbar] 读不到当前分支：', err)
        return []
      })
      return { roots, heads }
    },
  )

  /**
   * 重读的时机：**窗口重新获得焦点**。
   *
   * 用户换分支几乎总是在 Vela 外面干的（终端里 `git checkout`、GUI 客户端、脚本），
   * 而文件监听帮不上——它盯的是打开着的那些文件（`ipc/watch.ts`），`.git/HEAD` 不在其中。
   * 成本是每个根读一个几十字节的文本文件，所以「每次回到窗口都重读一遍」是付得起的。
   *
   * ⚠️ 两个事件都听：整个应用被重新激活时 WKWebView 到底递 `focus` 还是只递
   * `visibilitychange`，取决于激活的是窗口还是应用。漏掉一个的表现是这一格**安静地**
   * 停在旧分支上——它压根没有错误通道，所以不会有第二个信号说明它没刷新。
   * ⚠️ 不能把 `refetch` 直接当处理函数递进去：它收一个可选的 `sameData`，
   * 而事件对象是 truthy，于是每次都会被当成「沿用上一份数据」那一种重取。
   * `void` 也不是装饰：它把返回值压成 `undefined`，`addEventListener` 才认这个函数
   */
  const reread = () => {
    void refetch()
  }
  if (rootList) {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reread()
    }
    window.addEventListener('focus', reread)
    document.addEventListener('visibilitychange', onVisible)
    onCleanup(() => {
      window.removeEventListener('focus', reread)
      document.removeEventListener('visibilitychange', onVisible)
    })
  }

  /** 要画出来的那几格：一个 git 根一格，不是仓库的根没有格子 */
  function gitCells(): { text: string; title: string }[] {
    const got = git()
    if (got === undefined) return []
    const { roots, heads } = got
    // 多根时才带根的名字：单根时那一格说的是「我这个项目」，名字是废话；
    // 多根时不带就分不清哪个分支属于哪个文件夹
    const many = roots.length > 1
    const cells: { text: string; title: string }[] = []
    heads.forEach((head, index) => {
      const root = roots[index]
      // `head === null` = 那一个根没有可报的分支。`root === undefined` 只可能是两边
      // 不同长，而那正是上面那条契约要挡住的错位——宁可少画一格，也不给一格配上错的名字
      if (head === null || root === undefined) return
      // 🔴 游离 HEAD 必须说出来：`name` 那一档装的是短 sha，画成 `分支 6a1b2c3` 读起来
      // 像是「在分支 6a1b2c3 上」，而它其实意味着**提交不会落到任何分支里**
      const where = head.detached ? `${head.name}（游离）` : head.name
      cells.push({
        text: `${many ? `${displayName(root)} ` : ''}${BRANCH_LABEL} ${where}`,
        title: head.detached
          ? `游离 HEAD：不在任何分支上，提交不会落到任何分支里（${root}）`
          : `当前分支（${root}）。回到这个窗口时会重读一次`,
      })
    })
    return cells
  }

  /** 当前保存格式在下拉里对应的那一项。`reopen:` 那组永远不会是选中态 */
  const saveChoice = () => `${SAVE}${encodingChoiceId(doc().format())}`

  function pickEncoding(value: string, select: HTMLSelectElement) {
    // 先拨回去再看要干什么。「重新打开」是一次性动作不是一个状态，而它在**拒绝执行**
    // （有未保存的改动）或失败时不会改 `format()`，于是没有任何重渲染会把下拉复位——
    // 不复位的话下拉会一直显示「以 GBK 重新打开」，看起来像是已经生效了
    select.value = saveChoice()
    if (value.startsWith(REOPEN)) {
      void doc().reopenWith(value.slice(REOPEN.length) as EncodingId)
      return
    }
    const { encoding, bom } = parseEncodingChoice(value.slice(SAVE.length))
    doc().changeFormat({ encoding, bom })
  }

  return (
    <footer class="statusbar">
      {/* 侧边栏的开关（左下角）。放在这里是因为**它是唯一一处看得见的位置**：
          侧边栏收起时整栏不渲染（`App.tsx` 的 `<Show when={sidebarVisible()}>`），
          栏头里那三个动作也就跟着没了，于是想把它打开只剩原生菜单（View → 切换侧边栏，`⌘B` / `Ctrl+B`）一条路——
          一个不在界面里的入口不算入口。
          这一格在 `<Show when={doc().shard() === null}>` **之外**：分片标签那排格子全都不渲染，
          但「我想去看看旁边的文件」在分片上照样成立，而且是更成立（他多半就是想换个文件）。

          ⚠️ 类名是 `.status-side` 而不是 `.status-cell`：`.status-cell` 是「关于这份文档的一个读数」，
          按钮不是读数；而测试里那些格子计数（`StatusBar.test.tsx` 与 `App.test.tsx` 各有一处）
          就是按这个类名收的，挂上去会把它们的下标断言全搅乱 */}
      <Show when={props.sidebar}>
        {(side) => (
          <button
            class="status-side"
            aria-pressed={side().open()}
            title={side().open() ? '隐藏侧边栏' : '打开侧边栏（项目文件树）'}
            onClick={side().toggle}
          >
            ▥
          </button>
        )}
      </Show>

      <span class="status-cell status-path" title={doc().path() ?? UNTITLED_LABEL}>
        {doc().busy() ? '读写中…' : `${doc().dirty() ? '● ' : ''}${doc().name()}`}
      </span>

      {/* 🔴 分片标签走**完全不同**的一排，不是在原来那排上改几个数。

          理由一：`ws.metrics()` 在分片标签上报的是那份**空占位 buffer**——正文压根不在
          CM6 里（`openAsShard` 把它清成了空串，否则 `host.getText()` 会把上一个文件
          当成这个文件的内容），于是它说「1 行 0 字符，光标在行 1 列 1」。
          从内联长成分片的那条路（`reload` 撞上 too_large，`EditorPane` 随即被卸载）
          更糟：`attach` 不会再发生、`syncMetrics` 一次都不跑，报的是**变成分片之前**
          那份正文的行列数。两种都不是屏幕上这个东西的度量，
          而「行 1，列 1」比留白更糟——它读起来像是一个真的位置。

          理由二：编码与换行符那两格是**可写**的（`doc.changeFormat`，会标脏）。
          分片标签一标脏就再也关不掉了：关闭确认会问「要不要保存」，而 `doc.save()`
          在分片上是一律拒绝的。所以这两格在这里**不渲染**——不渲染比禁用更强，
          也是 `document.ts` 里那两条写路径唯一的守卫。

          理由三：选区、缩进在一份没有光标的只读文本上没有意义 */}
      <Show when={doc().shard() === null}>
        <span class="status-cell" title="主光标的行与列">
          行 {m().line}，列 {m().col}
        </span>
        <Show when={m().selectedChars > 0}>
          <span class="status-cell">选中 {m().selectedChars} 字符</span>
        </Show>
        <Show when={m().selections > 1}>
          <span class="status-cell">{m().selections} 个选区</span>
        </Show>

        <span class="status-spacer" />

        <span class="status-cell" title="缩进">
          {m().indent}
        </span>
        <label class="status-cell status-pick" title="编码">
          <select
            value={saveChoice()}
            disabled={doc().busy()}
            onChange={(e) => pickEncoding(e.currentTarget.value, e.currentTarget)}
          >
            <optgroup label="以…保存">
              {ENCODING_CHOICES.map((c) => (
                <option value={`${SAVE}${encodingChoiceId(c)}`}>{c.label}</option>
              ))}
            </optgroup>
            {/* 无名文档磁盘上没有字节，「重新打开」无从谈起 */}
            <Show when={doc().path()}>
              <optgroup label="以…重新打开">
                {ENCODING_IDS.map((id) => (
                  <option value={`${REOPEN}${id}`}>{ENCODING_LABELS[id]}</option>
                ))}
              </optgroup>
            </Show>
          </select>
        </label>
        <label class="status-cell status-pick" title="换行符">
          <select
            value={doc().format().eol}
            disabled={doc().busy()}
            onChange={(e) => doc().changeFormat({ eol: e.currentTarget.value as LineEndingId })}
          >
            {LINE_ENDING_IDS.map((id) => (
              <option value={id}>{LINE_ENDING_LABELS[id]}</option>
            ))}
          </select>
        </label>
        <span class="status-cell" title="语言">
          {languageFor(doc().path()).label}
        </span>
        <span class="status-cell" title="全文行数与字符数">
          {m().lines.toLocaleString()} 行 · {m().chars.toLocaleString()} 字符
        </span>
      </Show>

      {/* 两个 `<Show>` 而不是一个带 `fallback` 的：`fallback` 里要塞四十行 JSX，
          读起来像是「正常那一排是备胎」。分片这一排才是那个特殊情况 */}
      <Show when={doc().shard()}>
        {(shard) => (
          <>
            <span class="status-spacer" />
            <span class="status-cell" title="这个文件太大，Vela 只读地按页取它：不能编辑，也不能保存">
              只读分片
            </span>
            <span class="status-cell" title="全文行数（口径是 wc -l，与 CM6 差一行）">
              {shard().totalLines.toLocaleString()} 行
            </span>
            <span class="status-cell" title="文件在磁盘上的字节数">
              {(shard().header.bytes / 1048576).toFixed(1)} MB
            </span>
            {/* 编码与换行符只读地报出来。⚠️ 换行符那一个只从头部 256 KiB 判出来
                （见 `ipc/shard.ts` 的 `ShardHeader.eol`），一个 CRLF 与 LF 混着的文件
                会报成前 256 KiB 里那一种——所以 title 里说清楚 */}
            <span class="status-cell" title="探测出来的编码。只读，不能改">
              {ENCODING_LABELS[shard().header.encoding]}
              {shard().header.bom ? ' BOM' : ''}
            </span>
            <span class="status-cell" title="换行符，只从文件头部那一段判出来">
              {LINE_ENDING_LABELS[shard().header.eol]}
            </span>
          </>
        )}
      </Show>

      {/* 最右边那一格：当前分支（一个 git 根一格）。
          🔴 它在上面那两个 `<Show>` **之外**，所以内联与只读分片两排都有它：这一格说的是
          **项目根**的事，与「这个标签是不是分片」无关——而分片那一排恰恰更需要一个
          「我在哪个仓库的哪个分支上看这个 100MB 的日志」的坐标。
          放在最后还有一个副作用是白拿的：`.status-cell:last-child` 不给右边框，
          于是它自己贴着窗口边缘，而它左边那一格的边框正好成了两者之间的分隔线 */}
      <For each={gitCells()}>
        {(cell) => (
          <span class="status-cell status-git" title={cell.title}>
            {cell.text}
          </span>
        )}
      </For>
    </footer>
  )
}
