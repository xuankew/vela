/**
 * 字体按需注入（PLAN.md D7 / R15）
 *
 * 为什么不在 styles.css 里 @import：
 * 实测单个变体的 @font-face 声明是 104KB raw / 29.9KB gzip。原先 @import 两个变体，
 * 首屏 CSS 里 59.8KB 全是字体声明，而应用自身样式只有 ~8KB。
 *
 * 注意这里省的**不是总字节数**——把 CSS 文本搬进 JS bundle 的话 gzip 一样大。
 * 真正省的是两件事：
 *   1. 首屏关键路径。CSS 阻塞首次绘制，动态注入的 <style> 不阻塞。
 *   2. 常驻量。任一时刻只有一个变体的声明在内存里，切换时整块替换。
 *
 * 用 `?inline` 而不是普通 css import：前者把 CSS 作为字符串交给 JS，
 * 由我们决定注入时机；后者会被合并进主 CSS 文件，等于绕回老路。
 * vite 仍会处理其中的 url()，把 woff2 重写成带 hash 的产物路径。
 */

export type FontVariantId = 'screen-gb' | 'screen-r' | 'system-mono'

export interface FontVariant {
  id: FontVariantId
  label: string
  /** 注入后声明的 CSS family 名；null 表示系统字体，无需注入 */
  family: string | null
  /** 编辑器区完整字体栈 */
  stack: string
  /** UI 区字体栈 */
  uiStack: string
  /** 包内分片总数，供探针核对懒加载比例 */
  shards: number
  /** 分片全量体积（字节），同上 */
  shardBytes: number
  /**
   * 动态 import。路径必须写成字面量——rolldown 靠静态分析切 chunk，
   * 拼接字符串会让所有变体退回主 bundle，正好毁掉这次改造的目的。
   */
  load?: () => Promise<{ default: string }>
}

export const FONT_VARIANTS: Record<FontVariantId, FontVariant> = {
  'screen-gb': {
    id: 'screen-gb',
    label: '文楷 Screen (GB)',
    family: 'LXGW WenKai Screen',
    stack: "'LXGW WenKai Screen', ui-monospace, monospace",
    uiStack: "'LXGW WenKai Screen', -apple-system, sans-serif",
    shards: 97,
    shardBytes: 4.33 * 1024 * 1024,
    load: () => import('lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css?inline'),
  },
  'screen-r': {
    id: 'screen-r',
    label: '文楷 Screen R',
    family: 'LXGW WenKai Screen R',
    stack: "'LXGW WenKai Screen R', ui-monospace, monospace",
    uiStack: "'LXGW WenKai Screen R', -apple-system, sans-serif",
    shards: 97,
    shardBytes: 4.87 * 1024 * 1024,
    load: () => import('lxgw-wenkai-screen-webfont/lxgwwenkaiscreenr.css?inline'),
  },
  // 对照组：不注入任何 webfont，用于隔离「CJK webfont 对滚动性能的影响」
  'system-mono': {
    id: 'system-mono',
    label: '系统等宽（对照）',
    family: null,
    stack: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    uiStack: '-apple-system, BlinkMacSystemFont, sans-serif',
    shards: 0,
    shardBytes: 0,
  },
}

export const DEFAULT_VARIANT: FontVariantId = 'screen-gb'

/**
 * 代码区字体（PLAN.md D2 已定为「按内容分字体」）。
 *
 * 与正文字体是**两个正交维度**：正文字体决定 Markdown 正文与 UI，
 * 代码区字体决定围栏代码块 / 缩进代码 / Markdown 表格。
 *
 * 为什么必须分开：M0 验收项 #3 实测 LXGW WenKai Screen 的拉丁是**比例宽度**
 * （ASCII 步进极差 8.63px），CJK/ASCII = 1.666 而非 2.0，50 个中文字累积漂移 140px。
 * 文楷用于代码区连纯英文的列都对不齐，只能退回正文与 UI。
 *
 * Maple Mono CN 的许可证状况比文楷宽松：OFL-1.1 且**没有 Reserved Font Name**
 * （上游 OFL.txt 的版权声明后没有任何 RFN 声明），所以分片分发不触发改名义务。
 */
export type CodeFontId = 'maple-cn' | 'inherit'

export interface CodeFont {
  id: CodeFontId
  label: string
  /** 注入后声明的 CSS family 名；null 表示跟随正文字体，无需注入 */
  family: string | null
  shards: number
  shardBytes: number
  load?: () => Promise<{ default: string }>
}

export const CODE_FONTS: Record<CodeFontId, CodeFont> = {
  'maple-cn': {
    id: 'maple-cn',
    label: 'Maple Mono CN（等宽 2:1）',
    family: 'Maple Mono CN',
    // 只发 400 一个字重：dist/fonts/400 下 239 个 woff2。
    // 粗体走浏览器合成，与文楷的 R16 现状一致，真要字重再加一档 CSS。
    shards: 239,
    shardBytes: 9.3 * 1024 * 1024,
    // 路径不能写成 dist/regular.css：该包有 exports 白名单，只暴露 ./regular.css，
    // 写真实路径 dev 下可能侥幸通过但 rolldown 构建会直接失败。
    load: () => import('@automann/maple-mono-cn/regular.css?inline'),
  },
  // D2 的选项 (a)：代码区也用文楷，接受列对齐漂移。保留成一键切换而非删掉。
  inherit: { id: 'inherit', label: '跟随正文（文楷，不对齐）', family: null, shards: 0, shardBytes: 0 },
}

export const DEFAULT_CODE_FONT: CodeFontId = 'maple-cn'

const STYLE_NODE_ID = 'vela-font-faces'
const CODE_STYLE_NODE_ID = 'vela-code-font-faces'

export interface FontApplyResult {
  id: FontVariantId
  /** 本次是否真的注入了新 CSS（重复调用同变体时为 false） */
  injected: boolean
  /** 注入的 CSS 字节数 */
  cssBytes: number
  /** @font-face 条数 */
  faces: number
  /** 从调用到注入完成的耗时 */
  ms: number
  /** 是否命中了模块缓存（第二次切回同变体应为 true） */
  fromCache: boolean
}

let currentId: FontVariantId | null = null
let currentCodeId: CodeFontId | null = null

interface CachedCss {
  css: string
  bytes: number
  faces: number
}

/** 变体模块缓存：rolldown 自己也缓存 dynamic import，这层是为了同步拿到 fromCache 指标 */
const cssCache = new Map<FontVariantId, CachedCss>()
const codeCssCache = new Map<CodeFontId, CachedCss>()

/**
 * 正文字体与代码区字体各占一个 style 节点。
 *
 * 不能共用：`applyFontVariant` 是整块替换（同名 @font-face 互相覆盖，见 R14），
 * 而两个 family 必须同时驻留——正文用文楷、代码块用 Maple，缺一边就会掉回系统字体。
 */
function styleNode(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  return el
}

/**
 * 切换字体变体。整块替换而非追加：
 * 包内 lxgwwenkaiscreen.css 与 lxgwwenkaigbscreen.css 声明的是**同一个** family 名，
 * 同时驻留会产生同名 @font-face 互相覆盖（PLAN.md R14）。
 */
export async function applyFontVariant(id: FontVariantId): Promise<FontApplyResult> {
  const t0 = performance.now()
  const variant = FONT_VARIANTS[id]
  const cached = cssCache.get(id)
  const fromCache = cached !== undefined

  if (currentId === id) {
    // 已经是当前变体。仍报出真实数值，否则探针面板会显示「0 B / 0 条」，看着像注入失败。
    return {
      id,
      injected: false,
      cssBytes: cached?.bytes ?? 0,
      faces: cached?.faces ?? 0,
      ms: performance.now() - t0,
      fromCache,
    }
  }

  let cssBytes = 0
  let faces = 0

  if (variant.load) {
    let entry = cached
    if (!entry) {
      const css = (await variant.load()).default
      entry = { css, bytes: css.length, faces: css.split('@font-face').length - 1 }
      cssCache.set(id, entry)
    }
    cssBytes = entry.bytes
    faces = entry.faces
    styleNode(STYLE_NODE_ID).textContent = entry.css
  } else {
    // 系统字体对照组：清空注入的声明，避免上一个变体残留
    styleNode(STYLE_NODE_ID).textContent = ''
  }

  currentId = id

  const root = document.documentElement.style
  root.setProperty('--vela-font-editor', variant.stack)
  root.setProperty('--vela-font-ui', variant.uiStack)
  // inherit 档的代码区字体栈就是正文字体栈，换正文必须跟着刷新，
  // 否则代码区会停在上一个变体的 family 上。
  syncCodeStack()

  return {
    id,
    injected: true,
    cssBytes,
    faces,
    ms: performance.now() - t0,
    fromCache,
  }
}

/** 代码区实际生效的字体栈。inherit 档直接复用正文栈。 */
function codeStack(): string {
  const code = CODE_FONTS[currentCodeId ?? DEFAULT_CODE_FONT]
  if (code.family) return `'${code.family}', ui-monospace, monospace`
  const prose = FONT_VARIANTS[currentId ?? DEFAULT_VARIANT]
  return prose.stack
}

function syncCodeStack() {
  document.documentElement.style.setProperty('--vela-font-code', codeStack())
}

export interface CodeFontApplyResult {
  id: CodeFontId
  injected: boolean
  cssBytes: number
  faces: number
  ms: number
  fromCache: boolean
  /** 实际写进 --vela-font-code 的字体栈，探针面板要把它和量到的度量一起报出来 */
  stack: string
}

/**
 * 切换代码区字体。与 `applyFontVariant` 互不干扰：两者写不同的 style 节点、
 * 不同的 CSS 变量，因此可以各自独立切换、也可以同时驻留。
 */
export async function applyCodeFont(id: CodeFontId): Promise<CodeFontApplyResult> {
  const t0 = performance.now()
  const font = CODE_FONTS[id]
  const cached = codeCssCache.get(id)
  const fromCache = cached !== undefined
  const already = currentCodeId === id

  if (font.load && !already) {
    let entry = cached
    if (!entry) {
      const css = (await font.load()).default
      entry = { css, bytes: css.length, faces: css.split('@font-face').length - 1 }
      codeCssCache.set(id, entry)
    }
    styleNode(CODE_STYLE_NODE_ID).textContent = entry.css
    currentCodeId = id
    syncCodeStack()
    return {
      id,
      injected: true,
      cssBytes: entry.bytes,
      faces: entry.faces,
      ms: performance.now() - t0,
      fromCache,
      stack: codeStack(),
    }
  }

  if (!font.load) {
    // inherit：不需要任何 @font-face，但要把上一次注入的代码字体声明留着——
    // 清掉的话再切回来就得重新走一遍 dynamic import，白付一次异步成本。
    currentCodeId = id
    syncCodeStack()
  }

  return {
    id,
    injected: false,
    cssBytes: cached?.bytes ?? 0,
    faces: cached?.faces ?? 0,
    ms: performance.now() - t0,
    fromCache,
    stack: codeStack(),
  }
}

export function currentFontVariant(): FontVariantId | null {
  return currentId
}

export function currentCodeFont(): CodeFontId | null {
  return currentCodeId
}
