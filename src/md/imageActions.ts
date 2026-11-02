/**
 * 预览里对**一张图**认不认这一次手势（PLAN.md §3.7 M7-11 与 M7-12）。
 *
 * 手势是三个：左键看大图、右键复制、以及键盘走到那张图上按 Enter / 空格
 * （最后一个是 M7-11 认下的欠账，见下面的 [`markZoomableImages`]）。
 * 前两个各自认不认，判据**不共用**；第三个直接复用左键那一个。
 *
 * ## 为什么是两个判据，而不是一个
 *
 * 左键与右键在这里不是同一个问题：
 *
 * - **左键（看大图）要让开链接。** `[![alt](a.png)](https://e.com)` 在预览里就是一个可点的
 *   链接，那一次点击归它。⛔ 别改成「先弹大图、大图里再放一个打开链接」：同一个手势在
 *   「带链接的图」与「不带的图」上有两种结果，而用户看不出来为什么。
 * - **右键（复制链接）不用让。** 右键不导航，没有什么手势可抢；图上的右键问的就是
 *   **这张图**的地址，包在链接里也一样。
 *
 * 所以两个函数共用「这是不是一张渲染出来的 `<img>`」，⛔ 不共用「它在不在链接里」。
 * 把 `closest('a')` 提成一个公共守卫省事，代价是链接里的图片右键什么都弹不出来——
 * 而那恰好是用户最想复制链接的那一类图。
 *
 * ## 🔴 「链接」指的是正文里那串，不是应用自己编出来的那个
 *
 * 本地图片的 `src` 是 `vela-img://localhost/?doc=…&ref=…`（M7-9 那条协议），
 * 复制到外面是一条**谁都打不开**的链接。所以 `copyTargetOf` 对本地图片走的是
 * `data-path`，也就是正文 `![](...)` 括号里那串原样引用（`assets/pasted-….png`），
 * 菜单上写的也是「复制路径」而不是「复制链接」。⚠️ 这一条没有自动检查，只有
 * `imageActions.test.ts` 里那一句断言守着：**任何一路都不许把 `vela-img:` 交出去**。
 *
 * ## 🔴 M7-8 起「正文那一串」有三种，判据只有一个：这东西会不会离开这一层
 *
 * 本地图片给 `data-path`（正文 `![](...)` 里那串引用）、云端图片给 `data-oss-src`
 * （那一个**不带签名**的地址）、别的外链才给 `src`。⚠️ 三种里只有**显示**那一路用 `src`：
 * 预览里那张云端图的 `src` 此刻是一份 15 分钟的读取凭证，而剪贴板与大图底部那一行都会
 * 走到应用外面去（完整论证在 `./ossImage.ts` 文件头那条 🔴）。
 * 这一条也没有自动检查，只有 `imageActions.test.ts` 里那两句断言守着
 *
 * ## ⚠️ 大图上右键也要能给同一个结果，所以 `ZoomTarget` 多带了一个 `ref`
 *
 * 遮罩里那张 `<img>` 是宿主这一栏的子节点，右键靠冒泡走到同一个处理里。它只认 `data-path`，
 * 所以 `ImageLightbox` 把 `ref` 原样挂回自己的 `data-path` 上——挂 `label` 不行，
 * 外链图的 `label` 就等于 URL，会冒充成一串文档内的引用，把「复制链接」说成「复制路径」。
 *
 * 🟡 下面那四个小读取函数（`imageOf` / `srcOf` / `refOf` / `unsignedOf`）是几个手势共用的：
 * 每条规矩只有一个落点，所以「属性而不是 `.src`」这类红字只写一次
 *
 * ## ⚠️ 为什么不做「复制绝对路径」
 *
 * 那要把正文里那串引用（可以带 `../`）解析成磁盘路径，而解析与「有没有跑出文档目录」
 * 这件事只有一个权威：`crates/vela-core/src/fs/local_image.rs`。在前端再写一遍归一化，
 * 就是两处规矩、两处会漏。真要这条应该加一条 Rust 命令，不是在这一层拼字符串。
 */

/** 一次左键命中的一张图：显示用的 URL，与那句给人看的路径 */
export interface ZoomTarget {
  /** 直接塞进 `<img src>` 的那个字符串，与预览里那一张一模一样 */
  src: string
  /** 大图底部那一行。本地图片是正文里写的原样引用，外链是那个 URL */
  label: string
  /**
   * 正文 `![](...)` 括号里那串引用；外链图是 null。
   *
   * 🔴 大图要把这一份原样挂回它自己那张 `<img>` 的 `data-path` 上，于是右键**大图**弹出的
   * 菜单与右键**预览里那一张**得到同一个结果（复制那串引用，而不是那个协议 URL）。
   * 只留 `label` 不够：外链那一个恰好等于 URL，挂上去会把「复制链接」说成「复制路径」
   */
  ref: string | null
  /**
   * 这一张是**用户自己 bucket** 里的图片时，那一个不带签名的地址；否则 null。
   *
   * 🔴 它是 M7-8 那条例外的另一半：`src` 此刻可能是一份 15 分钟的读取凭证，而会离开
   * 这一层的东西（大图底部那一行、右键复制出去的那一串）⛔ 只许用这一个。
   * 由 `./ossImage.ts` 挂在 `data-oss-src` 上
   */
  unsigned: string | null
}

/** 一次右键要复制的东西，与菜单上那一项的名字 */
export interface CopyTarget {
  /** 进剪贴板的那串 */
  text: string
  /** 「复制链接」还是「复制路径」——两件事的文案不该共用一个 */
  label: string
}

/** 这一次点击命中的是不是渲染出来的 `<img>`。占位 `span` 不是图，压根不该算 */
function imageOf(target: EventTarget | null): HTMLImageElement | null {
  return target instanceof HTMLImageElement ? target : null
}

/**
 * 🔴 地址读的是 `getAttribute('src')` 而不是 `.src`：后者会拿文档的 base URL 去解析，
 * 于是 `vela-img://…` 在某些实现里被改写成别的形状。这里要的是**原样那串**，
 * 因为 Rust 那一边按原样校验（见 `src-tauri/src/imgproto.rs`）。
 * 两个手势都从这一个函数拿，所以这条规矩只有一处
 */
function srcOf(img: HTMLImageElement): string | null {
  const src = img.getAttribute('src')
  return src === null || src === '' ? null : src
}

/**
 * 正文 `![](...)` 里那串引用，由 `localImage.ts` 挂在 `data-path` 上；外链图没有它。
 *
 * ⚠️ 空串按「没有」算：当成有值的两个后果都是安静的——大图底下那一行是空白，
 * 而右键复制出来一个空字符串
 */
function refOf(img: HTMLImageElement): string | null {
  const raw = img.dataset.path
  return raw === undefined || raw === '' ? null : raw
}

/**
 * 云端图片那一个**不带签名**的地址，由 `./ossImage.ts` 挂在 `data-oss-src` 上；别的图没有它。
 *
 * 🔴 它是 M7-8 那条「签名地址只住 DOM」的出口：两个手势里凡是**会离开这一层**的东西
 * （大图底部那一行、剪贴板）都读它，⛔ 不读 `src`——那时 `src` 里是一份 15 分钟的读取凭证。
 * 只有真正显示用的那一个 `<img src>` 才用 `src`
 *
 * ⚠️ 空串同样按「没有」算，与 [`refOf`] 一条理由
 */
function unsignedOf(img: HTMLImageElement): string | null {
  const raw = img.dataset.ossSrc
  return raw === undefined || raw === '' ? null : raw
}

/** 左键：该不该弹大图 */
export function zoomOf(target: EventTarget | null): ZoomTarget | null {
  const img = imageOf(target)
  if (img === null || img.closest('a') !== null) return null
  const src = srcOf(img)
  if (src === null) return null
  const unsigned = unsignedOf(img)
  // `label` 优先取引用：用户想知道的是「正文里指的是哪个文件」，
  // 而不是应用自己编出来的协议 URL；云端那一张则是那一个不带签名的地址
  const ref = refOf(img)
  return { src, label: ref ?? unsigned ?? src, ref, unsigned }
}

/**
 * 把「点得开大图」的那一些图标成键盘也停得下来（M7-11 认下的第一笔欠账）。
 *
 * 🔴 判据就是 [`zoomOf`] 本身，⛔ 不要在这儿重写一遍「在不在链接里」「有没有 src」：
 * 一处判据的两个消费者才保证**能 Tab 停下来的**与**点得开的**是同一批图。分成两份的
 * 症状是安静的——链接里的图片多出一个停不下来的焦点，或者反过来键盘能停但按了没反应
 *
 * ⚠️ 调用点在 `MarkdownPreview` 的 `render()` 里、`rewriteLocalImages` **之后**：
 * 本地图片在那一步之前还是占位 `span`，早一步扫就一张都扫不到
 *
 * ⚠️ 没有「把上一次的标记擦掉」那一支：`render()` 每次都是 `bodyEl.innerHTML = html`
 * 整块重建，节点是新的。真要加清理就得先回答「哪些属性算这一层写的」，
 * 而这个问题在这里不存在
 *
 * 🟡 代价是明写的：一篇贴了二十张图的笔记因此多出二十次 `Tab`。换来的是一件事——
 * 键盘用户此前**完全看不到图**（那一层没有任何别的入口）。要减这个代价得先回答
 * 「预览里键盘该怎么走」，那是这一栏更大的一题，不是这一句能顺手解决的
 */
export function markZoomableImages(root: HTMLElement): void {
  for (const img of root.querySelectorAll('img')) {
    if (zoomOf(img) === null) continue
    img.setAttribute('tabindex', '0')
    img.setAttribute('role', 'button')
    // `role="button"` 顶掉了 `img` 那个语义，所以名字里要把替代文字带上，
    // 否则读屏器念出来的是「按钮」加一串 URL。`alt` 在这里不会是空的：
    // `render.ts:856` 空替代文字统一写成「图片」，本地图片那一支原样搬（`localImage.ts:74`）
    img.setAttribute('aria-label', `看大图：${img.alt}`)
  }
}

/**
 * 右键：该不该弹那份菜单、以及复制什么。认不出来的那种图就 null——
 * 调用方此时**不该** `preventDefault`，把原生的那份菜单留给用户
 */
export function copyTargetOf(target: EventTarget | null): CopyTarget | null {
  const img = imageOf(target)
  if (img === null) return null
  const ref = refOf(img)
  if (ref !== null) return { text: ref, label: '复制路径' }
  // 🔴 云端那张复制出去的是 `data-oss-src` 那一个**不带签名**的地址：剪贴板会走到应用外面，
  // 而签名地址是一份 15 分钟的读取凭证，贴进聊天窗口、贴进另一篇文档就等于把访问权发出去了。
  // 公开桶那张本来就没有签名地址，于是这一句拿到 null，走下面那一条
  const unsigned = unsignedOf(img)
  if (unsigned !== null) return { text: unsigned, label: '复制链接' }
  const src = srcOf(img)
  if (src === null) return null
  // ⛔ 只放 `http(s)`：`vela-img:` 是应用内部的事（上面那条红字），而 `data:` 那串
  // base64 复制出去既没用又长得要命。这一句是整个函数唯一的一处判断，所以它值一条用例
  if (!src.startsWith('http://') && !src.startsWith('https://')) return null
  return { text: src, label: '复制链接' }
}
