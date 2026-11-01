/**
 * 预览里点一张图 → 看大图（PLAN.md §3.7 M7-11）。
 *
 * ## 只做「看清楚这一张」，不做图片浏览器
 *
 * 一个全屏遮罩 + 一张等比缩放到窗口内的图 + 一行它自己的路径，关法三种（点遮罩、
 * `×`、`Esc`）。⛔ 没有缩放按钮、没有左右翻页、没有下载：那一些是「图片浏览器」的
 * 语义，而 Vela 是编辑器——用户点图的动机是「这行 `![]()` 指的是哪张图、上面写了什么」，
 * 看完就关。加控件会把这一层变成一个需要键盘归属、焦点顺序与滚动语义的小应用。
 *
 * ## 🔴 这一层不碰字节，只把 `src` 原样交给 `<img>`
 *
 * 大图用的就是预览里那一张的**同一个 URL**，所以它天然继承 M7-9 那两条边界：
 * 本地图的 `vela-img://…` 由 Rust 每次请求重新校验（canonical 之后仍在文档目录里、
 * 认魔数、有上限），外链图走 `render.ts` 的 `safeUrl` 白名单。⛔ 不要在这里加一条
 * 「把图读进内存再显示」的路：那等于给预览开第二个图片来源，而它的边界要靠这一段代码守。
 *
 * ⚠️ 同一个 URL 通常**不会**再发一次请求（webview 的图像缓存），但真发一次也无所谓：
 * 那一次走的还是校验。反过来说，URL 过期了就显示不出来——M7-8 给 OSS 图挂的是临时签名
 * `src`，大图复用的是同一个 `src`，压着 TTL 点开的话会拿到 403。那种情况走 `error`，
 * 见下面那句「加载不出来」。
 *
 * ## 🔴 被链接包住的图不抢这次点击
 *
 * `[![alt](img.png)](https://example.com)` 在预览里就是一个可点的链接。`zoomOf` 在
 * `closest('a')` 上返回 null，于是点击归链接。⛔ 别改成「先弹大图、大图里再放一个打开链接」：
 * 那会让同一个手势在「带链接的图」与「不带的图」上有两种结果，而用户看不出来为什么。
 *
 * ## ⚠️ 一层已知的 a11y 欠账：没有焦点陷阱
 *
 * `Tab` 从关闭按钮走出去会掉到遮罩后面的界面里。做陷阱要回答「哪些元素算这个对话框的」，
 * 而这里只有两个（对话框本身与 `×`）。`role="dialog"` 不带 `aria-modal` 是刻意的：
 * 声明了模态却守不住焦点，比不声明更误导读屏器——与 `SettingsDialog` 同一口径。
 */
import { createSignal, onCleanup, onMount, Show } from 'solid-js'

/** 一次点击命中的那张图：显示用的 URL，与那句给人看的路径 */
export interface ZoomTarget {
  /** 直接塞进 `<img src>` 的那个字符串，与预览里那一张一模一样 */
  src: string
  /** 底部那一行。本地图是正文里写的原样引用，外链是那个 URL */
  label: string
}

/**
 * 这次点击该不该弹大图；该的话给出目标，不该就 null。
 *
 * 🔴 `src` 读的是 `getAttribute('src')` 而不是 `.src`：后者会拿文档的 base URL 去解析，
 * 于是 `vela-img://…` 在某些实现里被改写成别的形状。这里要的是**原样那串**，
 * 因为 Rust 那一边按原样校验（见 `src-tauri/src/imgproto.rs`）
 *
 * ⚠️ `label` 优先取 `data-path`：那是 `render.ts` 写进占位、`localImage.ts` 搬到 `<img>` 上的
 * 正文原样引用（`assets/pasted-….png`）。用户想知道的是「正文里指的是哪个文件」，
 * 而不是应用自己编出来的协议 URL
 */
export function zoomOf(target: EventTarget | null): ZoomTarget | null {
  if (!(target instanceof HTMLImageElement)) return null
  if (target.closest('a') !== null) return null
  const src = target.getAttribute('src')
  if (src === null || src === '') return null
  return { src, label: target.dataset.path ?? src }
}

export interface ImageLightboxProps {
  target: ZoomTarget
  onClose: () => void
}

export function ImageLightbox(props: ImageLightboxProps) {
  let backdropEl: HTMLDivElement | undefined
  let dialogEl: HTMLDivElement | undefined
  /** 那张大图没到位（图被移走了、URL 过期了、或者协议那道校验把它拒了） */
  const [failed, setFailed] = createSignal(false)
  /** 打开之前那个拿着焦点的元素；关掉之后还给它的（见 `focusBack`） */
  const owner: Element | null = document.activeElement

  onMount(() => {
    // ⛔ 焦点必须进来，否则 `Esc` 那条 `onKeyDown` 压根不会作用在这个组件上：
    // 点预览里的一张图不会让任何元素可聚焦（`<img>` 默认不可聚焦，而这一栏也没有 tabindex）
    dialogEl?.focus()
  })

  function focusBack(): void {
    // 只还给「还在文档里」的那个元素：那张图可能已经被下一次重画换掉了，
    // 而对一个游离节点调 `focus()` 的结果是焦点掉到 body 上——不如什么都不做
    if (owner instanceof HTMLElement && owner.isConnected) owner.focus()
  }

  onCleanup(focusBack)

  function onBackdropClick(event: MouseEvent): void {
    // 只有点在遮罩本体上才算「点外面」。图与那一行说明都是它的子节点，
    // 事件会一路冒泡到这里，所以必须比 `target`，⛔ 不能挂在子节点上再各自 stopPropagation
    if (event.target === backdropEl) props.onClose()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    props.onClose()
  }

  return (
    // z-index 刻意比 `.modal-backdrop`（10）低一档，见 `src/styles.css` 那一段
    <div class="img-zoom-backdrop" ref={backdropEl} onClick={onBackdropClick}>
      <div
        class="img-zoom-dialog"
        role="dialog"
        aria-label="图片大图"
        tabindex={-1}
        ref={dialogEl}
        onKeyDown={onKeyDown}
      >
        <img class="img-zoom" src={props.target.src} alt={props.target.label} onError={() => setFailed(true)} />
        <div class="img-zoom-foot">
          {/* 加载失败时那句要说的是「这一张出不来」，而路径还是得给——它是用户唯一的线索 */}
          <span class="img-zoom-path" classList={{ failed: failed() }}>
            {/* 前缀与路径是两段：整句换掉的话用户就不知道是哪一张了，而「哪一张」正是这句话的用处 */}
            <Show when={failed()}>这张图加载不出来：</Show>
            {props.target.label}
          </span>
          <button class="img-zoom-close" onClick={() => props.onClose()} title="关闭大图（Esc）" aria-label="关闭大图">
            ×
          </button>
        </div>
      </div>
    </div>
  )
}
