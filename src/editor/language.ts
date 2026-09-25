import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

/**
 * 路径 → 语言。纯查表，不碰 CM6 的 state，所以能在 node 环境下测。
 *
 * 「语言 → 扩展」那半边在 `./setup` 的 `languageExtensions`：它要决定字体分区，
 * 而字体主题是 setup 的私产。两边分开是为了让这一半保持纯函数。
 */

/**
 * 三种归属，对应三种渲染策略：
 * - `markdown`：正文用文楷，代码块/表格行由装饰换成等宽（PLAN.md D2「按内容分字体」）
 * - `code`：整篇等宽，语法树由 language-data 懒加载
 * - `plain`：整篇等宽，**不挂任何语言**。没匹配上的扩展名（.log / .csv / .conf…）
 *   走这里而不是退回正文字体——等宽对表格与日志列对齐是刚需，正文字体对纯散文
 *   只是好看。两边只能保一个时保对齐。
 */
export type LanguageKind = 'markdown' | 'code' | 'plain'

export interface LanguageChoice {
  readonly kind: LanguageKind
  /** 状态栏那一栏显示什么 */
  readonly label: string
  /** 需要懒加载的语言。markdown 与 plain 都是 null——前者已静态打包，后者没有 */
  readonly description: LanguageDescription | null
}

/**
 * 认作 Markdown 的那些扩展名。
 *
 * ⚠️ 导出成 HTML 时也要拿它算默认文件名（`src/md/export.ts` 的 `exportFileName`）：
 * 那边自己再写一份 `.md|.markdown|…` 的话，将来加一个扩展名就会只加对一半——
 * 症状是「`.mdx` 在编辑器里高亮成 Markdown，导出时却叫 `notes.mdx.html`」
 *
 * ⚠️ 同一份判断还管着**工具栏该不该画 Markdown 那一组按钮**（`setup.ts` 的 `markdownMode`，
 * 经 `EditorToolbar.tsx` 的 `canAttach`）。口径同样不能自己再写一份：那三处
 * （高亮 / 导出名 / 工具栏）只要有一个认 `.mdx` 而另一个不认，症状就是
 * 「编辑器里是 Markdown 的样子，工具栏却换成了代码那组按钮」这种没人想到要去查的错
 */
export const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i

const MARKDOWN: LanguageChoice = { kind: 'markdown', label: 'Markdown', description: null }
const PLAIN: LanguageChoice = { kind: 'plain', label: '纯文本', description: null }

/** 路径的最后一段。导出是给拖放提示复用它——那里要说「不支持的格式：photo.png」 */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * 文件树上那一个小图形是哪一类。
 *
 * 它是**展示**用的分类，不是第三种语言归属：`LanguageKind` 答的是「拿什么渲染这份正文」
 * （三种），这里答的是「让人一眼看出这是什么文件」（十几种）。两者只在
 * `iconForPath` 里汇合一次——那一边已经有的判断不在这儿再抄一遍表。
 *
 * ⚠️ 这一张联合类型与 `src/project/icons.tsx` 里那张表**必须同步**，少一个就编译不过
 * （那边按这个类型逐个穷举，没有 `default` 分支）。这是有意的：加一类图标时，
 * 忘了画图形的失败方式是「红着」，而不是「树上悄悄显示成通用文件」。
 */
export type FileIcon =
  | 'markdown'
  | 'code'
  | 'style'
  | 'markup'
  | 'data'
  | 'config'
  | 'shell'
  | 'git'
  | 'docker'
  | 'lock'
  | 'image'
  | 'media'
  | 'archive'
  | 'font'
  | 'doc'
  | 'binary'
  | 'file'

/**
 * 资源类格式：一份分组表，**同时**是「拖进来该不该拦」与「树上画哪个图形」的唯一来源。
 *
 * 拆成两份清单的话，加一个扩展名就会只加对一半——症状是「`.xyz` 在树上有个专属图标，
 * 拖进来却解成一屏乱码」，或者反过来「拖进来被拒了，树上却是个普通文档图标，
 * 完全看不出它为什么被拒」。所以 `isBinaryPath` 就是「命中这六组里的任意一组」。
 *
 * 黑名单而不是白名单，理由与 `workspace.ts` 的「打开…」对话框不设扩展名过滤器同一条：
 * Vela 要能打开 LICENSE、Makefile、`.log`、`.csv` 这些没有语法支持但确实是文本的东西，
 * 一份白名单会把这些一起拒掉，而那是这一版之前就立住的设计。
 *
 * ⚠️ `.svg` **不在**任何一组里：它是 XML，打开来是可编辑的文本，Vela 能改它。
 * 但它该有个图形类的图标，所以在 `iconForPath` 里单独认一次——那一条不是「拦不拦」的判断。
 * 反过来 `.jar` / `.odt` 看着像文档，实际是 zip，所以在表里。
 */
const RESOURCE_GROUPS: ReadonlyArray<{ icon: FileIcon; ext: RegExp }> = [
  { icon: 'image', ext: /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|heic|avif|svgz|psd|ai|sketch|fig|xd)$/i },
  {
    icon: 'media',
    ext: /\.(mp4|m4v|mov|avi|mkv|webm|wmv|flv|mpg|mpeg|mp3|wav|flac|aac|oga|ogg|m4a|wma|aiff|opus)$/i,
  },
  { icon: 'archive', ext: /\.(zip|tar|gz|tgz|bz2|tbz2|xz|txz|zst|7z|rar|iso|dmg|pkg|jar|war)$/i },
  { icon: 'font', ext: /\.(woff2?|ttf|otf|eot)$/i },
  { icon: 'doc', ext: /\.(pdf|docx?|xlsx?|pptx?|od[tsb]|pages|numbers|key|epub|mobi)$/i },
  { icon: 'binary', ext: /\.(exe|dll|dylib|so|o|a|class|pyc|pyo|wasm|elf|bin|db|sqlite3?|parquet)$/i },
]

/**
 * 这个路径是不是二进制／资源类文件（按扩展名判，不看内容）。见 `RESOURCE_GROUPS`。
 *
 * ⚠️ 调用方仍是**两处**：拖放落文件（`src/ipc/dragDrop.ts`）与文件树的图标。
 * 「打开…」对话框刻意没接——它仍按老行为把任何东西交给 `open_file`。于是同一张 `.png`
 * 从两条路口径不同（拖进来会被拦，点开会变乱码）。这是当时明确权衡过的取舍：
 * 拦下拖放是用户直接要求的，而改那一条要动 workspace 并回归它。要统一时把
 * `isBinaryPath` 递进那处即可。图标这一处**不改变任何打开行为**，它只挑图形。
 */
export function isBinaryPath(path: string): boolean {
  const name = baseName(path)
  return RESOURCE_GROUPS.some((group) => group.ext.test(name))
}

/**
 * 锁文件：名字是死的，扩展名不算（`go.sum` / `Cargo.lock` / `pnpm-lock.yaml`）。
 *
 * 单独一类不是为了好看，是因为**这些文件不该手改**——一把锁把这条说出来，
 * 而它们按扩展名分会散成 json / yaml / toml 三类，看着就像三个可以随便编辑的配置。
 */
const LOCK_NAMES =
  /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?|cargo\.lock|gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum|mix\.lock|Podfile\.lock)$/i

/** 没有扩展名、但一看就是给人读的说明文件。`README.md` 不在这里——它走 markdown */
const DOC_NAMES = /^(license|licence|copying|notice|authors|unlicense|readme|changelog|contributing)$/i

/** 有专属图形、但按 `language-data` 会全落到「代码」的那几类文本 */
const STYLE_EXT = /\.(css|scss|sass|less|styl|stylus|postcss)$/i
const MARKUP_EXT = /\.(html?|xml|xhtml|vue|svelte|astro|xsl)$/i
const DATA_EXT = /\.(json|jsonc|json5|jsonl|ndjson|geojson|map)$/i
const CONFIG_EXT = /\.(ya?ml|toml|ini|cfg|conf|properties|plist)$/i
const SHELL_EXT = /\.(sh|bash|zsh|fish|ksh|ps1|psm1|bat|cmd)$/i

/**
 * 这个文件在树上画哪个图形。纯查表，不看内容也不碰 DOM。
 *
 * 🔴 顺序就是判据的优先级，从「名字是死的」到「按扩展名」再到「兜底」：
 * `pnpm-lock.yaml` 先被锁文件名单接走，而不是落到 `.yaml` 那一类；
 * `.gitlab-ci.yml` 归 git，不归 config；`Dockerfile` 没有扩展名，只能按名字前缀认。
 * 把 `MARKDOWN_EXT` 那一条挪到资源组之后的话没有影响（两组不相交），但把锁文件名单
 * 挪到扩展名之后就会让 `go.sum` 变成通用文件。
 *
 * ⚠️ 目录不经过这里：`isDir` 在 `TreeRow` 上，由 `Sidebar.tsx` 自己判。
 * 从路径反推「这是不是目录」正是要避免的那件事——`LICENSE` 与 `src` 都可能没有扩展名，
 * 而文件树里同名目录/文件都合法。
 */
export function iconForPath(path: string): FileIcon {
  const name = baseName(path)
  if (LOCK_NAMES.test(name)) return 'lock'
  // `.gitignore` / `.gitattributes` / `.gitlab-ci.yml` / `.gitmodules`，以及裸的 `.git` 文件
  if (/^\.git/i.test(name)) return 'git'
  if (/^dockerfile/i.test(name) || /^docker-compose\./i.test(name)) return 'docker'
  // `.env` / `.env.local` / `.env.production`：扩展名是 `local` / `production`，压根不在表里
  if (/^\.env/i.test(name)) return 'config'
  if (MARKDOWN_EXT.test(name)) return 'markdown'
  // `.svg` 是文本（所以不在 `RESOURCE_GROUPS` 里、不会被拦），但它是张图
  if (/\.svg$/i.test(name)) return 'image'
  for (const group of RESOURCE_GROUPS) {
    if (group.ext.test(name)) return group.icon
  }
  if (STYLE_EXT.test(name)) return 'style'
  if (MARKUP_EXT.test(name)) return 'markup'
  if (DATA_EXT.test(name)) return 'data'
  if (CONFIG_EXT.test(name)) return 'config'
  if (SHELL_EXT.test(name)) return 'shell'
  if (languageFor(path).kind === 'code') return 'code'
  if (DOC_NAMES.test(name)) return 'doc'
  return 'file'
}

/**
 * 快速判断文本是否可能是 JSON 内容。
 *
 * 用简单的启发式规则：去除空白后以 `{` 或 `[` 开头。
 * 这不是严格的 JSON 验证，只是为了在无扩展名时给出合理的默认语法高亮。
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  const firstChar = trimmed[0]
  return firstChar === '{' || firstChar === '['
}

/**
 * 无名文档当 Markdown。
 *
 * 这不是偷懒的默认值：Vela 主打 Markdown 友好，「新建标签随手写点东西」最可能写的
 * 就是笔记，而 M1-E 之前全局 `markdownMode = true` 也正是这个行为，不改它。
 */
export function languageFor(path: string | null, content?: string): LanguageChoice {
  if (path === null) {
    // 无路径时，如果有内容且看起来像 JSON，就给 JSON 高亮
    if (content !== undefined && looksLikeJson(content)) {
      const jsonLang = LanguageDescription.matchFilename(languages, 'test.json')
      if (jsonLang) {
        return { kind: 'code', label: 'JSON', description: jsonLang }
      }
    }
    return MARKDOWN
  }
  const name = baseName(path)
  if (MARKDOWN_EXT.test(name)) return MARKDOWN
  // matchFilename 要的是文件名，喂全路径会让它的 filename 模式（如 /^makefile$/i）失配
  const description = LanguageDescription.matchFilename(languages, name)
  if (description === null) {
    // 扩展名没匹配上时，如果内容看起来像 JSON，给 JSON 高亮
    if (content !== undefined && looksLikeJson(content)) {
      const jsonLang = LanguageDescription.matchFilename(languages, 'test.json')
      if (jsonLang) {
        return { kind: 'code', label: 'JSON', description: jsonLang }
      }
    }
    return PLAIN
  }
  return { kind: 'code', label: description.name, description }
}

/** 两个选择是否等价。异步支持到位前后 kind 与 label 都不变，所以这一步不会重复触发 */
export function sameLanguage(a: LanguageChoice, b: LanguageChoice): boolean {
  return a.kind === b.kind && a.label === b.label
}

/**
 * 懒加载语法支持。
 *
 * `language-data` 的每个条目靠动态 import 实现按需加载，vite.config.ts 里那条
 * 「刻意不做 manualChunks」的注释就是为保住这些动态边界——粗匹配合并会让
 * legacy-modes 里几十种语言全部进首屏包。
 */
export async function loadSupport(choice: LanguageChoice): Promise<LanguageSupport | null> {
  if (choice.description === null) return null
  return choice.description.load()
}
