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

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i

const MARKDOWN: LanguageChoice = { kind: 'markdown', label: 'Markdown', description: null }
const PLAIN: LanguageChoice = { kind: 'plain', label: '纯文本', description: null }

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * 无名文档当 Markdown。
 *
 * 这不是偷懒的默认值：Vela 主打 Markdown 友好，「新建标签随手写点东西」最可能写的
 * 就是笔记，而 M1-E 之前全局 `markdownMode = true` 也正是这个行为，不改它。
 */
export function languageFor(path: string | null): LanguageChoice {
  if (path === null) return MARKDOWN
  const name = baseName(path)
  if (MARKDOWN_EXT.test(name)) return MARKDOWN
  // matchFilename 要的是文件名，喂全路径会让它的 filename 模式（如 /^makefile$/i）失配
  const description = LanguageDescription.matchFilename(languages, name)
  if (description === null) return PLAIN
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
