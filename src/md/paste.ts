import { languageFor } from '../editor/language'
import { describeAssetError, MAX_IMAGE_BYTES, storeImage, tooBigText, type StoredImage } from '../ipc/asset'
import { describeUploadError, MAX_UPLOAD_BYTES } from '../ipc/oss'
import type { OssConfig } from '../settings/store'

/**
 * 把一张粘贴进来的图片落到文档旁边，并在光标处插入 Markdown 链接（M3-A-7，M7-7 起有两条路）。
 *
 * 这一层是「剪贴板里的图片」与「正文里的一行 `![](...)`」之间的全部逻辑，
 * 而它刻意**不认识 CM6**：`insert` 与 `notify` 都是注入的回调，所以整条路能在
 * node 环境里用两个假函数测出来，不需要 jsdom、不需要 view、也不需要 Tauri。
 * CM6 那一侧的接线在 `src/editor/paste.ts`（挑文件）与 `src/App.tsx`（组装回调）。
 *
 * ## 两态：本地相对路径（M3-A-7）与云端 URL（M7-7）
 *
 * 四格里 `bucket` / `region` / `accessKeyId` 有一格是空的，就**一个字都不改**地走 M3-A-7
 * 那条路：落到 `assets/`、插一行相对链接、成功时一句话都不说。这一条不是兜底，
 * 它是「没配云端」那个多数用户的正常路径，`paste.test.ts` 里那几条原样不动的用例钉的就是它。
 *
 * 三格齐了才多走两步：**本地那一份照样落**（云端成功也不删、也不跳过），然后传 OSS，
 * 正文里写 Rust 交回来的那一个不带签名的 URL。顺序是这个样子的理由：
 *
 * 1. 本地那一份是**降级唯一的落点**。上传失败时正文里那行相对链接必须已经能指到字节，
 *    所以先落盘、后上传，⛔ 不要为了「省一次写盘」把成功路径改成只传云端——
 *    那样一失败就什么都没有了，而 OSS 挂掉、密钥过期、断网都是会发生的；
 * 2. 同一次内容哈希决定两个名字（`crates/vela-core/src/fs/asset.rs` 的 `object_naming`），
 *    磁盘上叫 `assets/pasted-<hash>.png`、bucket 里叫 `<prefix>/pasted-<hash>.png`，
 *    是同一层同一个文件。
 *
 * ⚠️ 云端**成功**时那一份本地镜像不被正文里那一行引用，这是 M7-7 裁定要的形状，不是漏删。
 * 那一个 URL 会永久写进一份会同步、会备份、会被贴到别处的文档里，而 bucket 哪天换掉、
 * 关停、被清理，图就没了——本地这一份是唯一的找回途径。
 *
 * 🔴 「三格齐」这一句**不是权威**，只是省一趟白跑的上传。权威在 Rust：`upload_image`
 * 自己再看一遍四格，还只有它知道钥匙串里有没有那个 `AccessKeySecret`（前端读不到，
 * ⛔ 也不要在这里问一次 `oss_secret_status`——那是一次异步、一个要维护的缓存，
 * 而它失败时 Rust 本来就会把「缺哪一项」说清楚）。所以四格齐、密钥没配的那种状态
 * 是会走到的：字节交出去，拿回 `not_configured` 那一句，降级写相对路径。
 *
 * ## 🔴 只在 Markdown 文档里接
 *
 * 往一个 `.rs` 文件里插一行 `![](assets/x.png)` 是纯粹的破坏。判断走的是
 * `languageFor(path).kind`，也就是**语言分派那一个真相来源**——⛔ 不要在这里
 * 重新写一遍扩展名正则：`MARKDOWN_EXT` 将来加上 `.mdx` 的时候，
 * 只改一处的结果是「高亮认它、粘贴不认它」，而那是一条没人会想到去查的不一致。
 *
 * ⚠️ 未命名草稿的 `path` 是 `null`，而 `languageFor(null)` 答 Markdown（M1-E 起就是这个
 * 行为）。所以草稿会**被接住**，然后在下面第一条拒绝里说清「先存一次」——
 * 静默什么都不做是这里最坏的结局：用户按了 ⌘V，光标闪了一下，没有任何解释。
 *
 * ## ⚠️ 落地的图片在预览里显示得出来，但走的不是 `file:`（M7-9 接上的）
 *
 * `src/md/render.ts` 那一层仍然只给 `http(s)` 出 `<img>`，本地路径一律先出
 * `<span class="md-img-local">` 占位——因为 webview 的 base 是应用自己的源，
 * `src="assets/a.png"` 必然 404，而 `file:` 压根不在允许的 scheme 里。
 * 真正让它显示出来的是组件层那一次事后替换（`./localImage.ts` + 应用自己的 `vela-img`
 * 协议），⛔ 不是 Tauri 自带的 asset 协议：那一个的 scope 随构建固定，放开到能覆盖
 * 「任意文档旁边的 `assets/`」就等于把整个磁盘交给预览。
 *
 * 🔴 所以这一层递出去的那个相对链接现在有**三处**能用：Vela 的预览、GitHub / Typora、
 * 导出的 HTML。而 M3-A-7 当时那句「在 Vela 里是一个占位符、必须原样告诉用户」已经过期——
 * 占位符如今只是**失败时的落点**（图不在文档目录里、太大、不是一种图片、这份文档
 * 还没落盘所以没有目录可参照，或者 M7-7 那一条：上传失败了）。
 *
 * ⚠️ 云端那一条 URL 是 `https://{bucket}.oss-{region}.aliyuncs.com/…`，`render.ts` 认它
 * 是因为它是 `http(s)`——出的是 `<img>`，不走 `vela-img`。私有 bucket 上它会不会 403，
 * 归 M7-8（预览里换临时签名地址）管，不在这一层。
 */

/**
 * 落地成功后要插进正文的那一行。
 *
 * @param ref 本地那一条是 `assets/pasted-<16 位十六进制>.<ext>`（`StoredImage.rel`），
 *   云端那一条是 Rust 交回来的 `https://…aliyuncs.com/<prefix>/pasted-<同一个哈希>.<ext>`
 */
export function imageMarkdown(ref: string): string {
  // 空的 alt 文本是有意的：粘进来的截图没有名字可言，而 `![](...)` 与 `![描述](...)`
  // 在渲染上没有区别，占位符反而会让人以为「Vela 替我写了个描述」。
  // ⚠️ 两个入参都是 Rust 生成的，都不含空格、括号或引号：rel 是那一个固定形状，
  // URL 里的 key 由 `crates/vela-core/src/oss.rs` 的 `uri_encode` 百分号编码过
  // （拼那一串的是 `src-tauri/src/oss.rs` 的 `object_url`）。
  // 所以不需要 `<>` 包裹也不需要转义。**如果将来命名规则变成可配置的，这句话就不成立了**
  return `![](${ref})`
}

/**
 * 云端那一态的注入点（M7-7）。
 *
 * 由宿主（`src/App.tsx`）拼：`oss` 读设置里那四格那一个信号，`upload` 就是 `uploadImage`。
 * ⚠️ 这一层从 `src/ipc/oss` 只借了「怎么说那句失败」与那个 10 MB 的数，**没有**直接叫它
 * 上传：那一条是 `invoke`，而这一份的全部逻辑要在 node 里跑（见文件头）
 */
export interface CloudLanding {
  /**
   * 用户全局配置里的那四格。同步读信号，⚠️ 里面永远没有 `AccessKeySecret`：
   * 那一个只住钥匙串，前端没有任何一条路能读到它的值（`src/ipc/secrets.ts` 文件头那条 🔴）
   */
  oss: () => OssConfig
  /** 传上去，返回要写进正文的那个**不带签名**的 URL。任何失败一律 reject，由这里降级 */
  upload: (bytes: Uint8Array) => Promise<string>
}

export interface PasteTarget {
  /** 目标文档的绝对路径。`null` = 未命名草稿 */
  path: string | null
  /** 在光标处插入一段文字。必须是一次**可撤销**的普通编辑事务 */
  insert: (text: string) => void
  /**
   * 拒绝或失败时说一句话。
   *
   * 🔴 带档位，而不是让宿主一律染成红色：「先存一次」与「磁盘写不进去」在用户眼里
   * 不是一类事——前者什么都没坏，只是他还没做那一步，染成故障色会让一次正常的
   * 粘贴看起来像 Vela 出了问题（M3-A-5 立下的同一条口径）。宿主决定这两档长什么样
   */
  notify: (text: string, level: PasteNoticeLevel) => void
  /**
   * 云端那一态。不传 = 宿主没接云端，永远走本地相对路径（M3-A-7 那条路，一字未改）。
   *
   * 可选不是为了兼容谁：`paste.test.ts` 那一个 node 环境里没有钥匙串、没有配置文件，
   * 「没配云端」本来就是这一层要能独立跑通的一种状态
   */
  cloud?: CloudLanding
  /**
   * 把上一句 `notify` 收回。云端**成功**时要用：那句「上传中…」是个进行时，
   * 链接一插进正文它就变成了一句谎话，而成功按口径不该再说别的（见 `PasteNoticeLevel`）。
   *
   * 与 `cloud` 一样可选，⚠️ 宿主接了云端就必须接它，否则进度行会一直挂在编辑器上方
   */
  clear?: () => void
}

/** `notify` 的两档。`ok` 不在里面：落地成功时**一句话都不说**，插进去的链接就是回话 */
export type PasteNoticeLevel = 'plain' | 'error'

/**
 * 三格齐 = 值得试一次上传。
 *
 * `prefix` **不在**这一条里：空前缀是「就把图放在 bucket 根上」那个合法选择，
 * sanitize 不会替用户把它填回 `assets`（理由写在 `DEFAULT_OSS_PREFIX` 的文档里）。
 *
 * ⚠️ 这一条**不是权威**，权威在 Rust 的 `oss::normalize`：它还要看钥匙串里有没有密钥、
 * region 填的是不是访问域名。这里只挡「三格全空还每次粘贴都编一遍 base64、发一趟请求」
 * 那种白跑，所以宁可不完整，⛔ 不要在这里补任何一条能读密钥的检查。
 */
function ossConfigured(c: OssConfig): boolean {
  return c.bucket !== '' && c.region !== '' && c.accessKeyId !== ''
}

/**
 * 降级那一句的档位，用的是 M3-A-5 那一条口径。
 *
 * `not_configured`（四格里缺一项，或者钥匙串里没有密钥）说的是「你还没做那一步」，
 * `too_big`（云端 10 MB）说的是「这张图本来就该留在本地」——两件事里 Vela 都没出错，
 * 染成故障色会让一次正常的粘贴看起来像坏了。
 * 403、断网、超时是另一类：用户什么都做对了，而我们没做成
 *
 * ⚠️ 认的是 `kind` 标签，读不出形状就当 `error`：宁可把一句「还没做那一步」染红，
 * 也不能把一次真的上传失败说成无关紧要
 */
function degradeLevel(err: unknown): PasteNoticeLevel {
  const kind = typeof err === 'object' && err !== null ? (err as { kind?: unknown }).kind : undefined
  return kind === 'not_configured' || kind === 'too_big' ? 'plain' : 'error'
}

/**
 * 这个文档该不该接住粘贴进来的图片。
 *
 * 同步的，因为 paste 处理器的返回值决定 CM6 要不要 `preventDefault`，
 * 那一刻之后的任何异步都来不及。
 */
export function acceptsPastedImage(path: string | null): boolean {
  return languageFor(path).kind === 'markdown'
}

/**
 * 落地一张图片。成功时**不说话**：插进正文的那行链接就是全部的反馈，
 * 与 M3-A-5「对齐成功了就不该说话」同一条口径。
 *
 * 唯一说一句的是云端那一趟的进行时（「上传中…」），它成功时被 `clear` 收回去。
 *
 * ⚠️ 这个函数**不抛**：所有失败都翻译成一句人话交给 `notify`。
 * 调用它的那一侧在一个 CM6 事件处理器里，抛出去的异常会被 CM6 吞掉
 * （它给 DOM handler 包了 try/catch），用户看到的是「什么都没发生」。
 */
export async function landPastedImage(file: File, target: PasteTarget): Promise<void> {
  const { path, insert, notify } = target

  if (path === null) {
    // 图片要落在「文档所在目录的 assets/」里，而一份没存过的草稿没有目录可推。
    // 这不是偷懒：让它落到工作区根、或落到临时目录，都会产出一个
    // 「用户存了文档之后链接就断了」的坑，而那时他已经写了一整篇了
    //
    // 🔴 这一条问在**「云端配没配」之前**，也不为云端开后门：OSS 不需要文档目录，
    // 但正文里那个链接跟的是这份文档，草稿一 ⌘S 换目录，本地那一份就没了着落
    notify('这份文档还没有路径。先存一次（⌘S），图片要落在它旁边的 assets/ 里', 'plain')
    return
  }

  // 🔴 在 `arrayBuffer()` **之前**查大小：用户在 Finder 里复制一个 2 GB 的文件再粘进来
  // 是会发生的事，那时先把 2 GB 读进 webview 内存、再交给 Rust 去拒，界面已经卡死过了。
  // `storeImage` 里还有一道同样的检查，那一道管的是「字节真的超了」，这一道管的是
  // 「连读都别读」
  if (file.size > MAX_IMAGE_BYTES) {
    notify(tooBigText(file.size, MAX_IMAGE_BYTES), 'plain')
    return
  }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (err) {
    notify(describeAssetError(err), 'error')
    return
  }

  // 本地那一份**两条路都要**，云端成功也不跳过、也不删（论证在文件头那条顺序里）。
  // 这也是「上传失败不阻塞粘贴」能做到唯一姿势：链接要有一个已经指得着的落点可退
  let stored: StoredImage
  try {
    stored = await storeImage(path, bytes)
  } catch (err) {
    // `error`：这一支是「用户什么都做对了，而我们没做成」——格式不收、目录写不进去、
    // 磁盘满了。与上面两支「你还没做那一步」不是一类事
    notify(describeAssetError(err), 'error')
    return
  }

  const cloud = target.cloud
  if (cloud === undefined || !ossConfigured(cloud.oss())) {
    insert(imageMarkdown(stored.rel))
    return
  }

  // 云端那道 10 MB 的闸门也在这里查，而**不是**交给 `uploadImage` 里那一条同样的检查：
  // 两条路的「太大」要有同一个档位、同一句话（本地 32 MiB、云端 10 MB，两个数、一个口径），
  // 而 `uploadImage` 抛的是 `Error`，那时 `degradeLevel` 认不出形状只能标成 `error`。
  // ⚠️ 查的是 `file.size`（剪贴板报的数）；万一它与真字节不一致，Rust 那一条还会兜住
  if (file.size > MAX_UPLOAD_BYTES) {
    insert(imageMarkdown(stored.rel))
    notify(tooBigText(file.size, MAX_UPLOAD_BYTES), 'plain')
    return
  }

  // 没有进度条、没有取消、没有百分比（M7-7 裁定）：一行进行时，一次 IPC 与一次 PUT 之后
  // 要么被 `clear` 收走、要么被下面那句失败换掉。
  // ⚠️ 它最长挂 30 秒——那一趟 PUT 有 `src-tauri/src/oss.rs` 的 `UPLOAD_TIMEOUT` 兜着，
  // 超时变成 `network` 那一条 reject，所以这里不需要自己再写一个定时器
  notify('上传中…', 'plain')
  let url: string
  try {
    url = await cloud.upload(bytes)
  } catch (err) {
    // 🔴 降级，不作废这次粘贴：字节在磁盘上、相对链接指得着它，正文里多一行能用的东西
    // 比一行都没有强。那句失败的话还是要说，因为「为什么正文里这个是本地路径而不是 URL」
    // 用户自己看不出来
    insert(imageMarkdown(stored.rel))
    notify(describeUploadError(err), degradeLevel(err))
    return
  }
  insert(imageMarkdown(url))
  target.clear?.()
}
