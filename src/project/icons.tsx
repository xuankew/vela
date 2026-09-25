import type { JSX } from 'solid-js'
import type { FileIcon } from '../editor/language'

/**
 * 文件树上那一个小图形。
 *
 * ## 为什么是内联 SVG 而不是 emoji
 *
 * emoji 是**彩色位图**：同一串 `📄` 在 macOS 与 Windows 上是两张不同的图，而且它不接受
 * `color`——八套主题（`theme.ts` 的 `THEME_IDS`）对它一点影响都没有。用户要的「亮/暗主题下
 * 都清晰可辨」在 emoji 那条路上压根做不到，不是做得好不好看的问题。
 *
 * ## 颜色只有一处来源
 *
 * 每个图形一律 `stroke="currentColor"`、`fill="none"`，于是**色从 CSS 来**（`styles.css` 里
 * 按类别给 `color`，明度再按主题的 `--vela-icon-lit` 切）。这一层不知道任何颜色字面量。
 * 将来加主题只要给那一套 `--vela-icon-*` 定两个数，图标自动跟上。
 *
 * ## 网格与描边
 *
 * 16×16 网格、1.3 描边、圆头圆角。描边刻意不到 1.5：显示尺寸是 14px（`ROW_HEIGHT` 只有 22px），
 * 缩到 0.875 倍之后 1.5 的描边会糊成一团，尤其暖米那种有底纹的亮色上。
 *
 * ⚠️  **这一批图形没有在真机上看过**。它们全部由直线、圆与单段圆弧构成，坐标都在
 * 1..15 之间（不留半个像素的悬空端点），但「画得对」与「画得好」是两件事。
 * 改任何一个 `d` 之前先起 `pnpm tauri dev` 看一眼，别只靠测试绿——测试钉得住
 * 「哪一类用哪个图形」，钉不住「那个图形像不像个文件夹」。
 */

/**
 * 树上会出现的全部图形 = 文件的 17 类 + 目录。
 *
 * 🔴 这里**不写第二张分类表**：文件那半边直接是 `language.ts` 的 `FileIcon`。
 * 于是 `Record<TreeGlyph, …>` 少一个图形就编译不过——加一类而忘了画图形的失败方式是红的，
 * 而不是「树上悄悄退回通用文件图标」。
 */
export type TreeGlyph = FileIcon | 'folder'

/** 一个图形：16 网格上的一段或多段描边。 */
type Glyph = () => JSX.Element

const GLYPHS: Record<TreeGlyph, Glyph> = {
  folder: () => <path d="M2 4.5h4l1.5 1.5H14V13H2Z" />,

  // 折角纸。它是 `file` 与 `doc` 共用的那半，两处各写一遍是为了让每个图形能独立调
  file: () => (
    <>
      <path d="M4 1.75h5.5L13 5.25V14.25H4Z" />
      <path d="M9.5 1.75v3.5H13" />
    </>
  ),
  doc: () => (
    <>
      <path d="M4 1.75h5.5L13 5.25V14.25H4Z" />
      <path d="M9.5 1.75v3.5H13" />
      <path d="M6 8.5h4.5M6 11h4.5" />
    </>
  ),
  // Markdown 的通用标记：一个 M 加一支向下的箭头
  markdown: () => (
    <>
      <path d="M1.75 3.5h12.5v9H1.75Z" />
      <path d="M4.25 10.75v-5.5l2.4 2.9 2.4-2.9v5.5" />
      <path d="M11.9 5.75v5m0 0 1.4-1.6m-1.4 1.6-1.4-1.6" />
    </>
  ),
  code: () => <path d="M5.75 5 2.75 8l3 3M10.25 5l3 3-3 3M8.9 3.5 7.1 12.5" />,
  // 吊牌：`<>` 与 code 太像，标签形状才是「markup」这个词本来的意思
  markup: () => (
    <>
      <path d="M2 2h5.6l6.4 6.4-5.6 5.6L2 7.6Z" />
      <circle cx="5" cy="5" r="1.1" />
    </>
  ),
  // 一滴颜料：样式表管的是颜色，不是结构
  style: () => <path d="M8 2.5c2.4 3 3.9 5 3.9 6.9a3.9 3.9 0 0 1-7.8 0c0-1.9 1.5-3.9 3.9-6.9Z" />,
  data: () => (
    <path d="M6.4 2.6c-1.9 0-.9 4.4-2.9 5.4 2 1 1 5.4 2.9 5.4M9.6 2.6c1.9 0 .9 4.4 2.9 5.4-2 1-1 5.4-2.9 5.4" />
  ),
  // 三条滑杆：配置项的形状
  config: () => (
    <>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.5" />
      <circle cx="10.5" cy="8" r="1.5" />
      <circle cx="4.5" cy="11.5" r="1.5" />
    </>
  ),
  shell: () => (
    <>
      <path d="M2 3.25h12v9.5H2Z" />
      <path d="M4.5 6.2 6.6 8.25 4.5 10.3M8.6 10.5h3" />
    </>
  ),
  git: () => (
    <>
      <circle cx="4.5" cy="3.75" r="1.5" />
      <circle cx="4.5" cy="12.25" r="1.5" />
      <circle cx="11.5" cy="3.75" r="1.5" />
      <path d="M4.5 5.25v5.5M11.5 5.25c0 3.2-7 1.6-7 4.9" />
    </>
  ),
  // 三个格子摞在一条线上：容器
  docker: () => (
    <>
      <path d="M2 12h12" />
      <path d="M3 9.5h2.4V7.1H3ZM6.8 9.5h2.4V7.1H6.8ZM3 6.4h2.4V4H3Z" />
      <path d="M10.6 9.5H13V7.1h-2.4Z" />
    </>
  ),
  lock: () => (
    <>
      <path d="M4 7.25h8V14H4Z" />
      <path d="M6.2 7.25V5.5a1.8 1.8 0 0 1 3.6 0v1.75" />
    </>
  ),
  image: () => (
    <>
      <path d="M2 3.25h12v9.5H2Z" />
      <circle cx="5.6" cy="6.4" r="1.2" />
      <path d="M2.6 12.2 6.4 8.4l2.6 2.6 2-2 2.4 2.4" />
    </>
  ),
  media: () => (
    <>
      <path d="M2 3.25h12v9.5H2Z" />
      <path d="M6.6 6.1 10.6 8l-4 1.9Z" />
    </>
  ),
  archive: () => (
    <>
      <path d="M2 5.25h12V14H2Z" />
      <path d="M2 5.25 3.6 2.25h8.8L14 5.25" />
      <path d="M6.4 8.6h3.2" />
    </>
  ),
  font: () => <path d="M3.5 13.25 8 2.75l4.5 10.5M5.6 9.25h4.8" />,
  // 芯片：方块加八根引脚
  binary: () => <path d="M5 5h6v6H5ZM7 2.5V5M9 2.5V5M7 11v2.5M9 11v2.5M2.5 7H5M2.5 9H5M11 7h2.5M11 9h2.5" />,
}

/**
 * 画一个图形。调用方只管给它类别，颜色与尺寸由 CSS 定（见 `styles.css` 的 `.tree-glyph`）。
 *
 * `aria-hidden` 是必需的：这一行已经有 `.tree-name` 说清是哪个文件，图形对读屏软件
 * 是纯粹的重复播报，而它自己没有任何可朗读的名字。
 */
export function TreeGlyphIcon(props: { glyph: TreeGlyph }): JSX.Element {
  return (
    <svg
      class={`tree-glyph t-${props.glyph}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[props.glyph]()}
    </svg>
  )
}
