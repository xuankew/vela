/**
 * 把项目里的一个文件，换成「从当前文档看过去」的 Markdown 链接目标（M3-A-6）。
 *
 * 这一层是纯字符串运算，⛔ 不碰 CM6、不碰 IPC、也不碰磁盘，所以整条规则能在 node 环境里
 * 直接钉住。CM6 那一侧的接线在 `src/editor/linkSource.ts`，取候选那一步在 `App.tsx`
 * 的 `linkFiles` 钩子里（走的是 `Cmd+P` 同一个 `query_project`）。
 *
 * ## 🔴 基准是**文档所在目录**，不是项目根
 *
 * Markdown 的链接目标是相对**当前文档**解析的（CommonMark 与 GitHub 都是这个口径），
 * 所以 `/repo/doc/a.md` 里链到 `/repo/img/b.png` 必须写成 `../img/b.png`。
 * 写成项目根相对的 `img/b.png` 在 Vela 里看着没错——因为文档常常就在根上——
 * 而一旦它被挪进子目录，链接就静默断了，而断链在编辑器里**长得与好链一模一样**。
 *
 * ## ⚠️ 这是全前端第二处路径字符串运算
 *
 * 第一处是 `ipc/project.ts` 的 `revealFile`（把绝对路径拆成「所在目录 + 文件名」）。
 * 那一处的注释立过一条规矩：路径算术要能论证「拼错了也逃不出授权范围」。这里同样成立，
 * 而且更容易——**算出来的字符串只是被插进正文当文本**，没有任何一步拿它去开文件、
 * 列目录或写盘。最坏结果是一条点了没反应的链接，不是越权访问。
 */

/**
 * 分隔符：`/` 与 `\` 都算。与 `doc/document.ts` 的 `baseName`、`ipc/project.ts` 的
 * `revealFile` 逐字同一条口径（那两处也是 `lastIndexOf` 两个都找）。
 *
 * ⚠️ macOS 上文件名里可以真的含一个反斜杠，那样会被误当成目录分隔——这是继承来的取舍，
 * 不是这一层新引入的：Windows 支持排在 v1.x（PLAN §3.8），而在那之前 `\` 出现在路径里
 * 的唯一来源就是 Windows 风格的路径。
 */
const SEP = /[\\/]/

/**
 * 一个路径段里必须百分号编码的字符。
 *
 * 前四个是 **CommonMark 的语法限制**：链接目标写在 `(...)` 里时不能含空格，
 * 括号成对不上就断，`<`/`>` 是另一种目标写法的定界符。
 * 后三个是 **URL 语义**：`#` 后面会被渲染器当片段、`?` 后面当查询、
 * 而 `%` 自己不编码的话，一个真的叫 `100%.md` 的文件与一个已经编码过的目标就分不出来了。
 *
 * ⛔ **不编码非 ASCII**：中文文件名原样留着。百分号编码它们在语法上同样正确，
 * 但源码里会变成一串 `%E4%B8%AD`——而这个项目的正文就是中文，
 * 让链接目标读不出来等于把一半文档变成噪音（GitHub 与 Typora 也都留原文）。
 */
const UNSAFE = /[%()<>#? ]/g

function encodeSegment(segment: string): string {
  return segment.replace(UNSAFE, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/**
 * 链接目标长得像一个 URL 方案时（`http:`、`mailto:`），前面补一个 `./`。
 *
 * macOS 允许文件名里带冒号（Finder 里显示成 `/`），于是磁盘上真的可能有一个叫
 * `mailto:x` 的文件。不补的话 `[a](mailto:x)` 会被每一个渲染器读成一条邮件链接——
 * 而它的失败方式是**静默的**：链接点得动，只是去了别的地方。
 */
const SCHEME_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:/

/**
 * 从 `docPath` 这份文档链到 `targetPath` 这个文件，该写什么。
 *
 * 回 `null` 的三种情况都是「这一条不该出现在候选里」，而不是出错：
 * ① 文档还没存过（`path` 是 `null`，没有基准可推）；② 目标就是文档自己；
 * ③ 两个路径一个绝对一个相对（相对化没有意义）。
 *
 * @param docPath 当前文档的绝对路径，未命名草稿是 `null`
 * @param targetPath 候选文件的绝对路径。⚠️ 来自 `query_project` 的 `FileMatch.path`，
 *   原样递进来，⛔ 不要自己拿 `rel` 拼——那条规矩写在 `ipc/project.ts` 的 `DirEntry.rel` 上
 */
export function linkTarget(docPath: string | null, targetPath: string): string | null {
  if (docPath === null || docPath === targetPath) return null

  const from = docPath.split(SEP)
  const to = targetPath.split(SEP)
  // 一个是绝对路径（首段是空串，因为 `/a`.split('/') 是 ['', 'a']）、另一个不是的话，
  // 两者的段没有可比性，硬算会得出一串 `../` 指向谁也不知道的地方
  if ((from[0] === '') !== (to[0] === '')) return null

  // 文档所在目录：去掉最后一段（文件名）
  const base = from.slice(0, -1)
  // `i < to.length - 1`：目标自己的文件名**不算**公共前缀。少了这一条，`/a/b.md` 链到
  // `/a/b` 会算出「零层爬升 + 空尾巴」，插进正文就是一个空的 `]()`；有了它，
  // 尾巴至少还剩文件名，于是结果永远不是空串（也永远不需要再判一次）
  let i = 0
  while (i < base.length && i < to.length - 1 && base[i] === to[i]) i++

  const ups = base.length - i
  const rel = [...Array.from({ length: ups }, () => '..'), ...to.slice(i).map(encodeSegment)].join('/')
  return SCHEME_LIKE.test(rel) ? `./${rel}` : rel
}

/**
 * 开头的相对前缀：`./`、`../` 的连续若干段（`\` 也算，与 `SEP` 同一条口径）。
 *
 * 🔴 必须带分隔符才算一段，否则一个真的叫 `..hidden` 的目录会被咬掉两个点
 */
const RELATIVE_PREFIX = /^(?:\.\.?[\\/])+/

/**
 * 把用户已经打出来的那段链接目标，换成能拿去查项目索引的关键词。
 *
 * 🔴 要剥掉开头的 `./` 与 `../`：索引里存的是**项目根相对**路径，`..` 在里面压根不存在，
 * 原样拿去模糊匹配的结果是「一个候选都没有」——而 `](../img/` 正是这个功能最常见的起手式
 * （图片放在文档的隔壁目录）。剥掉之后查的是 `img/`，回来的候选再经 [`linkTarget`]
 * 按文档位置重新相对化，插进去的仍然是 `../img/a.png`。
 *
 * ⚠️ 代价是「用户打的那个目录」与「回来的候选所在的目录」可能不是同一个。这是
 * 全项目模糊（PLAN §3.6 M3-A-6 方案 A）本来就接受的口径：查得到就补，
 * 而补进去的路径**永远**是按文档位置算对的。
 */
export function linkNeedle(typed: string): string {
  const rest = typed.replace(RELATIVE_PREFIX, '')
  // 正打到一半的 `..`（那个 `/` 还没出来）同样查不到东西，按「什么都没打」处理
  return rest === '.' || rest === '..' ? '' : rest
}

/**
 * 一批候选文件（绝对路径）→ 一批可以直接插进正文的链接目标。**顺序原样保留**：
 * `query_project` 回来的已经是按分数排好的（见 `ipc/project.ts` 的 `FileQuery`），
 * 这一层⛔ 不要再排一次。
 *
 * 算不出相对路径的那些直接从候选里掉出去，⛔ 不要退化成绝对路径：绝对路径链接换台机器
 * 就断，而且在正文里读起来是一长串噪音。掉出去的只有两种——文档自己，
 * 以及一个绝对一个相对的混搭配（两者的段没有可比性，见 [`linkTarget`]）。
 */
export function linkTargets(docPath: string | null, paths: readonly string[]): string[] {
  const out: string[] = []
  for (const path of paths) {
    const target = linkTarget(docPath, path)
    if (target !== null) out.push(target)
  }
  return out
}
