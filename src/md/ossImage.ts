/**
 * 把预览里那些「用户自己 bucket 里的图片」的 `src` 换成临时签名地址（PLAN.md §3.7 M7-8）。
 *
 * ## 这是 `MarkdownPreview` 那条「不许拼 HTML」纪律的**有界例外**
 *
 * `./render.ts` 出来的那块 HTML 一个字都不改，这一层只在**渲染之后**动 DOM，而且只动
 * 一个属性：`img.src`（外加一个用来对位的 `data-oss-src`）。⛔ 不要把它扩成「顺手加点别的」：
 * 它一扩，转义与白名单的责任就从 `render.ts` 那一处变成两处，而两处规矩的地方就是两处会漏
 * 的地方。同一条纪律（以及为什么用 `setAttribute` 而不是拼 HTML）在 `./localImage.ts` 里
 * 写得最完整
 *
 * ## 🔴 签名地址只住 DOM，绝不进正文，也绝不进剪贴板
 *
 * [`presignOssImages`] 交回的那一串带着 AccessKey ID、时刻与一串签名，是 15 分钟内能读那个
 * 对象的凭证。写进正文的话它跟着那份文档一起同步、备份、被贴到别处，而「有效期」变成一句
 * 谎话：写进去那一天它就过期了，读到的人只会以为链接是坏的。所以**无签名**那一条（正文里
 * 本来写的就是它）留在 `data-oss-src` 上，给用户看与给用户复制的都是它——读法见
 * `./imageActions.ts`，那一边各钉了一条用例
 *
 * ## ⚠️ 为什么这一层要有缓存
 *
 * 每次重画都重新走一遍 `innerHTML`，于是同一张图在一篇文档里改一个字就要签一次。签名里带着
 * 秒级的时刻，两次签出来的是**两个不同的 URL**，浏览器认成两个资源——症状是「每敲一个字，
 * 预览里那张图闪一下、重新加载一遍」。缓存按无签名那一条对位，命中就复用同一个地址。
 *
 * 缓存时长取 `PRESIGN_TTL_MS` **减一个提前量**：贴着 TTL 缓存的话，压着边界换上去那一张在
 * 屏幕上只剩几秒可活，症状换成「预览里的云端图过一阵子裂一张」
 *
 * ## ⚠️ 一张图加载失败时只重签一次
 *
 * `loading="lazy"` 意味着首屏外那张可能要几分钟后才真的发请求，而那时地址可能已经过期了。
 * 失败就重签一次（每个元素一次，`data-oss-retried` 记着），再失败就留在原样。
 * 没有那一次的话症状是「往下滚几张图就裂几张」；不做上限的话症状是「每 150ms 裂一次」
 *
 * ## 谁说话
 *
 * 签不出来时那句 `reason` 由这一层往上交给 `MarkdownPreview` 头部那一行，前端**一个字都不
 * 改写**（与 `describeUploadError` 那一条同律）。没命中（别人的站点、别人的桶）是安静返回，
 * 那种图本来就跟 OSS 没关系，说一句「云端图片没配上」纯属误导
 */
import { describeUploadError, PRESIGN_TTL_MS, presignOssImages, type PresignedImage } from '../ipc/oss'

/** 签名地址在缓存里比真正的有效期提前多久作废。60 秒盖的是时钟抖动与「压着边界换上去」那两种 */
const RESIGN_MARGIN_MS = 60 * 1000

/** 签不出来（没配、钥匙串坏了、那张压根不是我们的桶）时，多久之后可以再问一次 */
const RETRY_AFTER_FAIL_MS = 30 * 1000

/** 一张图一条，200 条已经是一篇贴图极多的笔记。超了就整份清空——比逐条淘汰简单，而代价只是多签一次 */
const MAX_CACHE_ENTRIES = 200

interface CacheEntry {
  /** null = 问过了，签不出来（或者压根不是用户那个桶里的对象） */
  signedUrl: string | null
  /** 要给用户看的那句话（Rust 的原话）；null = 没什么要说 */
  reason: string | null
  /** 过了这个时刻就重新去问 */
  expiresAt: number
  /** 在飞的那一批。同一批里第二次问到同一个 URL 时不去签第二遍，也不覆盖别人的结果 */
  pending?: Promise<void>
  pendingId?: number
}

const cache = new Map<string, CacheEntry>()

let batchSeq = 0

/** 测试用的清场：换 bucket 之后留下的都是旧桶的地址，症状是「配置改对了图还是裂的」 */
export function clearOssImageCache(): void {
  cache.clear()
}

/**
 * 一张图**当前**对应的那个无签名地址。
 *
 * 🔴 已经换过的那一张不能拿 `src` 去对位：那一个是签名地址，跟缓存里的键对不上，
 * 于是每次重画都把它当成一张没见过的图，再签一个新地址换上去——闪图就是这么来的。
 * `data-oss-src` 是这一层自己写的，换回原样时删掉，所以它同时是对位键与「给用户看的那一串」
 */
function plainUrl(img: HTMLImageElement): string {
  return img.dataset.ossSrc ?? img.getAttribute('src') ?? ''
}

function isHttp(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

function cloudImages(body: Element): HTMLImageElement[] {
  return Array.from(body.querySelectorAll('img')).filter((img) => isHttp(plainUrl(img)))
}

/** 把一张图换成签名地址；`signedUrl` 为 null 时换回无签名那一条（公开桶本来就不需要签） */
function apply(img: HTMLImageElement, plain: string, signedUrl: string | null): void {
  const wanted = signedUrl ?? plain
  if (signedUrl === null) {
    delete img.dataset.ossSrc
  } else {
    img.dataset.ossSrc = plain
  }
  // ⚠️ 用 `setAttribute` 而不是 `img.src = …`：后者会把那串过一遍 URL 解析器，
  // 而签名算的就是那串字节。这里要的是**写进去与发出去完全同一个东西**
  if ((img.getAttribute('src') ?? '') !== wanted) img.setAttribute('src', wanted)
}

/**
 * 只在「这一条还是我放进去的那一个占位」时覆盖。
 *
 * 🔴 不判这一句的话，一次慢请求回来会把更新那一次的结果抹掉——症状是「网络抖一下，
 * 预览里刚好了的那张图又裂了」，而两份结果都真实存在过，最难查
 */
function settle(url: string, id: number, entry: Omit<CacheEntry, 'pending' | 'pendingId'>): void {
  if (cache.get(url)?.pendingId === id) cache.set(url, entry)
}

/**
 * 一批地址去签名：先放占位（同一批里第二次问到同一个 URL 时不去签第二遍），
 * 结果回来再覆盖。⛔ 返回的东西不进正文、不进剪贴板，只进缓存与 `img.src`
 */
function sign(urls: string[]): Promise<void> {
  const id = ++batchSeq
  const now = Date.now()
  const batch = presignOssImages(urls)
    .then((found) => {
      const byUrl = new Map<string, PresignedImage>()
      found.forEach((item) => byUrl.set(item.url, item))
      // 一条地址一次结果：命中的那种带 `signedUrl` 或带 `reason`，没在返回里的是「不是我们的桶」
      urls.forEach((url) => {
        const item = byUrl.get(url)
        const signed = item?.signedUrl ?? null
        settle(
          url,
          id,
          signed === null
            ? { signedUrl: null, reason: item?.reason ?? null, expiresAt: now + RETRY_AFTER_FAIL_MS }
            : { signedUrl: signed, reason: null, expiresAt: now + PRESIGN_TTL_MS - RESIGN_MARGIN_MS },
        )
      })
    })
    .catch((err: unknown) => {
      // 这一条命令不返回 `Err`，走到这里只能是 IPC 本身坏了。⚠️ 那句原话要给用户，
      // 一句写死的「预览出了点问题」既没用又会把真实原因盖住
      urls.forEach((url) =>
        settle(url, id, { signedUrl: null, reason: describeUploadError(err), expiresAt: now + RETRY_AFTER_FAIL_MS }),
      )
    })
  // 🔴 占位必须在**同步**这一段就写进去：上面那两个回调是微任务，晚一步的话
  // 同一帧里的下一次重画就会为同一批地址再发一次请求
  urls.forEach((url) =>
    cache.set(url, {
      signedUrl: null,
      reason: null,
      expiresAt: now + RETRY_AFTER_FAIL_MS,
      pending: batch,
      pendingId: id,
    }),
  )
  return batch
}

/**
 * 换一次，返回这一批里第一句要给用户看的话（没有就 null）。
 *
 * ⚠️ 它是**异步**的，所以调用方不能在这里之后立刻重量排版：图的位置要等 `load` 事件才稳，
 * 而那条捕获监听 `MarkdownPreview` 本来就有，签名地址换上去之后走的还是那一条路
 */
export async function rewriteCloudImages(body: Element): Promise<string | null> {
  if (cloudImages(body).length === 0) return null
  const now = Date.now()
  const waiting: Promise<void>[] = []
  const fresh: string[] = []
  // 先去重再分流：`fresh` 是这篇文档**当前**出现的那些云端图里还没结果的
  Array.from(new Set(cloudImages(body).map((img) => plainUrl(img)))).forEach((url) => {
    const hit = cache.get(url)
    if (hit === undefined || (hit.expiresAt <= now && hit.pending === undefined)) fresh.push(url)
    else if (hit.pending !== undefined) waiting.push(hit.pending)
  })
  if (fresh.length > 0) {
    if (cache.size + fresh.length > MAX_CACHE_ENTRIES) cache.clear()
    waiting.push(sign(fresh))
  }
  await Promise.all(waiting)
  // 等的时候可能又重画了一次，所以要**重新取一遍**元素：老那批节点已经不在文档里了，
  // 而对一个游离节点赋值不报错，只是白做——所以更坏的情形是安静地什么都不显示
  let note: string | null = null
  cloudImages(body).forEach((img) => {
    const url = plainUrl(img)
    const hit = cache.get(url)
    if (hit === undefined || hit.pending !== undefined) return
    apply(img, url, hit.signedUrl)
    if (note === null) note = hit.reason
  })
  return note
}

/**
 * 一张云端图加载失败 → 重签那**一条**地址（每个元素只有一次）。
 *
 * 由 `MarkdownPreview` 挂在 `.md-preview-body` 上的**捕获** `error` 监听调用。返回 `true`
 * = 换了一个新地址，调用方该重量一遍排版
 */
export async function resignAfterError(img: HTMLImageElement): Promise<boolean> {
  const plain = img.dataset.ossSrc
  // 🔴 上限是**每个元素**一次，不是每条地址一次：那些节点每次重画都会整体换掉，
  // 按元素记才不会把一个永久坏了的地址反复去问，而按地址记的话一次重画就又是一轮
  if (plain === undefined || img.dataset.ossRetried !== undefined) return false
  img.dataset.ossRetried = '1'
  cache.delete(plain)
  await sign([plain])
  const hit = cache.get(plain)
  const signed = hit?.pending === undefined ? hit?.signedUrl : undefined
  // ⛔ 元素可能已经被下一次重画换掉了：那样这一句就不该算「换成功了」
  if (signed === undefined || signed === null || !img.isConnected) return false
  img.setAttribute('src', signed)
  return true
}
