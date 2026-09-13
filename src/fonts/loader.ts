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

const STYLE_NODE_ID = 'vela-font-faces'

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

interface CachedCss {
  css: string
  bytes: number
  faces: number
}

/** 变体模块缓存：rolldown 自己也缓存 dynamic import，这层是为了同步拿到 fromCache 指标 */
const cssCache = new Map<FontVariantId, CachedCss>()

function styleNode(): HTMLStyleElement {
  let el = document.getElementById(STYLE_NODE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_NODE_ID
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
    styleNode().textContent = entry.css
  } else {
    // 系统字体对照组：清空注入的声明，避免上一个变体残留
    styleNode().textContent = ''
  }

  currentId = id

  const root = document.documentElement.style
  root.setProperty('--vela-font-editor', variant.stack)
  root.setProperty('--vela-font-ui', variant.uiStack)

  return {
    id,
    injected: true,
    cssBytes,
    faces,
    ms: performance.now() - t0,
    fromCache,
  }
}

export function currentFontVariant(): FontVariantId | null {
  return currentId
}
