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
 * `[![alt](img.png)](https://example.com)` 在预览里就是一个可点的链接。判据在
 * `./imageActions.ts` 的 `zoomOf` 里，`closest('a')` 上返回 null，于是点击归链接。
 * 那一个文件同时说了右键那一条为什么**不**用同一个守卫（右键不导航，没得抢），
 * 两条判据分开写在那里，⛔ 不要合并成一条
 *
 * ## ⚠️ 右键菜单不在这一层，但这一层负责让那张图认得出自己
 *
 * 大图没有自己的菜单宿主：`ImageLightbox` 把正文那串引用挂回 `<img>` 的 `data-path` 上，
 * 事件一路冒泡到 `.md-preview`，由宿主那一份菜单接住。于是**右键大图**与右键预览里那一张
 * 得到同一个结果。⛔ 不要在这一层再建一个 `TreeMenu`：两个宿主意味着两份关闭路径要守，
 * 而这一层连焦点陷阱都故意没做
 *
 * ## ⚠️ 一层已知的 a11y 欠账：没有焦点陷阱
 *
 * `Tab` 从关闭按钮走出去会掉到遮罩后面的界面里。做陷阱要回答「哪些元素算这个对话框的」，
 * 而这里只有两个（对话框本身与 `×`）。`role="dialog"` 不带 `aria-modal` 是刻意的：
 * 声明了模态却守不住焦点，比不声明更误导读屏器——与 `SettingsDialog` 同一口径
 */
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { ZoomTarget } from './imageActions'

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
        {/* `data-path` 原样挂回来（`null` 时 Solid 直接不写这个属性）：宿主 `.md-preview-body` 上那份
            右键菜单靠它认图，于是**右键大图**与右键预览里那一张得到同一个结果。⛔ 别省这一句：
            省了之后大图上的右键会走 webview 的原生菜单，而那里「拷贝图像地址」交出去的是
            `vela-img://…`——一条外面谁都打不开的死链接（论证见 `./imageActions.ts` 那条红字）。
            M7-8 起 `data-oss-src` 同一条理由：云端那一张在预览里的 `src` 是一份 15 分钟的
            读取凭证，⛔ 大图上的右键与底部那一行都只许用那一个不带签名的地址 */}
        <img
          class="img-zoom"
          src={props.target.src}
          data-path={props.target.ref}
          data-oss-src={props.target.unsigned}
          alt={props.target.label}
          onError={() => setFailed(true)}
        />
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
