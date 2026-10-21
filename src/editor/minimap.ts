/**
 * 缩略图（M4-H）：编辑器右侧的一块 canvas 概览 + 视口矩形，点/拖可以滚动。
 *
 * ## 为什么自写而不是引一个 minimap 包
 *
 * 与文件树（`project/tree.ts`）、虚拟化（`ui/virtual.ts`）同一条口径：这块东西的全部
 * 知识是「把行号映射成 y 坐标」，引一个包等于引一套自己的滚动模型进来跟 CM6 的抢。
 *
 * ## 两种布局，一条公式
 *
 * `linePx = min(3, canvasHeight / lineCount)`：文档比画布矮时一行最多占 3px（条形看得清），
 * 比画布高时一行不足 1px——这时**不再逐行画**，而是把落在同一个像素行里的所有行聚合成
 * 一条（宽度取其中最长的），于是整篇文档永远铺满整块画布，视口矩形也永远在画布内。
 * 不做 VS Code 那种「内容滑动」：那要再维护一个偏移量与一条「滑到哪」的规则，
 * 而聚合布局下「点画布任意一处都能跳到对应位置」这条直觉始终成立。
 *
 * ## 纯函数与插件分离
 *
 * 布局（`minimapLayout` / `planBars` / `minimapViewport`）与绘制（`paintMinimap`）都不碰 DOM：
 * 绘制收一个 `PaintSink` 接口，真机上是 canvas 2d context 的薄壳，测试里是一个记录调用的假壳。
 * 理由与 `ipc/dragDrop.ts` 逐字相同——vitest 的 node 环境里没有 canvas，`getContext('2d')`
 * 在 jsdom 里也恒为 null，把绘制决策埋在插件里就等于宣布这块逻辑不可测。
 * 插件自己只负责三件事：挂/摘 DOM、把 CM6 的变化翻译成「重画一次」、把指针换算成 scrollTop。
 *
 * ⚠️ **jsdom 里只挂 DOM 不画**：`clientWidth` 为 0 时 `draw` 直接返回。于是组件测试能断言
 * 「开关拨动时 canvas 在不在 DOM 里」，而像素对不对只能真机看（见 PLAN「M4-H 实施修正」）。
 */

import { Facet, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/** 缩略图占的宽度（CSS px）。styles.css 里 `.cm-minimap` 与正文的让位都用它。
 * 条形比例尺由 `MINIMAP_COLS` 与 `clientWidth` 现算，改这个数不需要动绘制逻辑 */
export const MINIMAP_WIDTH = 64

/** 一条条形最多代表多少个字符：再长的行也画满格，免得超长行把比例尺压扁 */
const MINIMAP_COLS = 100

/** 文档比画布矮时一行最多占的像素。3px 是「条形还看得出行与行的间隔」的下限 */
const MAX_LINE_PX = 3

/**
 * 装了缩略图时为 true。
 *
 * 与 `setup.ts` 的 `darkThemeEnabled` 同一条路：槽位（Compartment）里装空数组时没有 provider，
 * `state.facet` 回空表，于是「关着」不需要额外存一个布尔——槽位内容本身就是真相。
 */
export const minimapFacet = Facet.define<boolean>()

export function minimapEnabled(state: EditorState): boolean {
  return state.facet(minimapFacet).some((on) => on)
}

/** 一行占多少像素。见文件头「两种布局，一条公式」 */
export function minimapLayout(lineCount: number, canvasHeight: number): number {
  if (lineCount <= 0 || canvasHeight <= 0) return 1
  return Math.min(MAX_LINE_PX, canvasHeight / lineCount)
}

export interface MinimapBar {
  /** 画布上的 y（CSS px） */
  y: number
  /** 条形高度（CSS px） */
  h: number
  /** 宽度占可用宽度的比例，0~1 */
  w: number
}

/**
 * 把文档摊成一串条形。空白行不画（缩略图里「空一行」就该是空的，画了反而看不出段落）。
 *
 * 聚合模式下同一个像素行收多行、宽度取最大：那一像素代表的是「这一段里最长的那行」，
 * 取平均会把一段代码摊成一条看不出起伏的灰带。
 */
export function planBars(state: EditorState, linePx: number, canvasHeight: number): MinimapBar[] {
  if (canvasHeight <= 0) return []
  const doc = state.doc
  const barHeight = linePx >= 1 ? linePx : 1
  const widest = new Map<number, number>()
  for (let i = 0; i < doc.lines; i++) {
    const text = doc.line(i + 1).text
    if (text.trim() === '') continue
    const row = Math.floor(i * linePx)
    if (row >= canvasHeight) break
    const w = Math.min(1, text.length / MINIMAP_COLS)
    const prev = widest.get(row)
    if (prev === undefined || w > prev) widest.set(row, w)
  }
  const bars: MinimapBar[] = []
  for (const [row, w] of widest) bars.push({ y: row, h: barHeight, w })
  bars.sort((a, b) => a.y - b.y)
  return bars
}

export interface MinimapViewport {
  top: number
  height: number
}

/**
 * 视口矩形。`scrollHeight` 为 0（还没布局）时铺满整块画布，而不是画一个 0 高度的矩形——
 * 后者在真机上会闪一下「没有视口」的空画布。
 */
export function minimapViewport(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  canvasHeight: number,
): MinimapViewport {
  if (canvasHeight <= 0) return { top: 0, height: 0 }
  if (scrollHeight <= 0) return { top: 0, height: canvasHeight }
  let height = (clientHeight / scrollHeight) * canvasHeight
  if (height > canvasHeight) height = canvasHeight
  let top = (scrollTop / scrollHeight) * canvasHeight
  if (top < 0) top = 0
  if (top > canvasHeight - height) top = canvasHeight - height
  return { top, height }
}

/**
 * 绘制的全部动作。真机壳子在下面的插件里（canvas 2d），测试里是记录调用的假壳。
 * 颜色由壳子自己设：纯函数层不认识 CSS 变量，也就不会被某一套主题绑死。
 */
export interface PaintSink {
  clear(): void
  barStyle(color: string): void
  viewportStyle(color: string): void
  bar(bar: MinimapBar): void
  viewport(vp: MinimapViewport): void
}

export function paintMinimap(
  bars: MinimapBar[],
  vp: MinimapViewport,
  barColor: string,
  viewportColor: string,
  sink: PaintSink,
): void {
  sink.clear()
  sink.barStyle(barColor)
  for (const bar of bars) sink.bar(bar)
  sink.viewportStyle(viewportColor)
  sink.viewport(vp)
}

/** 缩略图要装的全部扩展。整组进/出 Compartment，于是开关只是一次 reconfigure */
export function minimapExtension(): Extension {
  return [
    minimapFacet.of(true),
    // 正文右侧让出一块：不让的话长行会钻到缩略图底下去，而缩略图是半透明的
    EditorView.theme({ '.cm-content': { paddingRight: `${MINIMAP_WIDTH + 8}px` } }),
    ViewPlugin.fromClass(MinimapPlugin),
  ]
}

class MinimapPlugin {
  readonly dom: HTMLCanvasElement
  private bars: MinimapBar[] = []
  private barsDoc: unknown = null
  private barsHeight = -1
  private barsLinePx = -1
  private dragging = false
  private readonly onScroll: () => void
  private readonly resizeObserver: ResizeObserver | null

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('canvas')
    this.dom.className = 'cm-minimap'
    this.dom.setAttribute('aria-hidden', 'true')
    view.dom.appendChild(this.dom)
    this.onScroll = () => this.draw()
    view.scrollDOM.addEventListener('scroll', this.onScroll)
    this.dom.addEventListener('pointerdown', this.onPointerDown)
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.draw()) : null
    this.resizeObserver?.observe(this.dom)
    this.draw()
  }

  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged) this.draw()
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.dom.removeEventListener('pointerdown', this.onPointerDown)
    this.resizeObserver?.disconnect()
    this.dom.remove()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    event.preventDefault()
    this.dom.setPointerCapture(event.pointerId)
    this.dragging = true
    this.scrollToPointer(event)
    const move = (e: PointerEvent) => {
      if (this.dragging) this.scrollToPointer(e)
    }
    const up = (e: PointerEvent) => {
      this.dragging = false
      this.dom.releasePointerCapture(e.pointerId)
      this.dom.removeEventListener('pointermove', move)
      this.dom.removeEventListener('pointerup', up)
      this.dom.removeEventListener('pointercancel', up)
    }
    this.dom.addEventListener('pointermove', move)
    this.dom.addEventListener('pointerup', up)
    this.dom.addEventListener('pointercancel', up)
  }

  /** 点到的那一行落到视口**正中**，而不是顶到最上：跳过去之后上下都还有上下文 */
  private scrollToPointer(event: PointerEvent): void {
    const rect = this.dom.getBoundingClientRect()
    if (rect.height <= 0) return
    const ratio = (event.clientY - rect.top) / rect.height
    const scroller = this.view.scrollDOM
    scroller.scrollTop = ratio * scroller.scrollHeight - scroller.clientHeight / 2
  }

  private draw(): void {
    const width = this.dom.clientWidth
    const height = this.dom.clientHeight
    if (width <= 0 || height <= 0) return
    const ctx = this.dom.getContext('2d')
    if (ctx === null) return
    const dpr = window.devicePixelRatio || 1
    const backing = Math.round(width * dpr)
    if (this.dom.width !== backing || this.dom.height !== Math.round(height * dpr)) {
      this.dom.width = backing
      this.dom.height = Math.round(height * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const state = this.view.state
    const linePx = minimapLayout(state.doc.lines, height)
    if (this.barsDoc !== state.doc || this.barsHeight !== height || this.barsLinePx !== linePx) {
      this.bars = planBars(state, linePx, height)
      this.barsDoc = state.doc
      this.barsHeight = height
      this.barsLinePx = linePx
    }
    const scroller = this.view.scrollDOM
    const vp = minimapViewport(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight, height)
    const style = window.getComputedStyle(this.dom)
    const barColor = style.getPropertyValue('--vela-fg-dim').trim() || '#888888'
    const viewportColor = style.getPropertyValue('--vela-accent').trim() || '#4c8dff'
    paintMinimap(this.bars, vp, barColor, viewportColor, canvasSink(ctx, width, height))
  }
}

function canvasSink(ctx: CanvasRenderingContext2D, width: number, height: number): PaintSink {
  return {
    clear: () => ctx.clearRect(0, 0, width, height),
    barStyle: (color) => {
      ctx.globalAlpha = 0.45
      ctx.fillStyle = color
    },
    viewportStyle: (color) => {
      ctx.globalAlpha = 0.16
      ctx.fillStyle = color
    },
    bar: (bar) => ctx.fillRect(0, bar.y, Math.max(2, bar.w * width), bar.h),
    viewport: (vp) => {
      ctx.fillRect(0, vp.top, width, vp.height)
      ctx.globalAlpha = 0.55
      ctx.fillRect(0, vp.top, width, 1)
      ctx.fillRect(0, vp.top + vp.height - 1, width, 1)
    },
  }
}
