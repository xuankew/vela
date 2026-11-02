// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { copyTargetOf, markZoomableImages, zoomOf } from './imageActions'

/**
 * 预览里对一张图的**三个手势**各自认不认这次命中：左键看大图、右键复制、键盘 Enter / 空格。
 *
 * 这一层全是纯判断（`markZoomableImages` 也只读 DOM、不发请求），所以这一份文件是整个
 * M7-11 / M7-12 里最值钱的用例：那两个组件的测试只能钉住「挂上了 DOM」，
 * 而「什么情况下弹、弹出来给的是哪串字」由这几个函数决定。
 *
 * 四条要紧的：
 *
 * 1. 🔴 **`src` 读的是属性而不是 `.src`**。后者会拿文档 base 去解析，`vela-img://…`
 *    在有些实现里会被改写成别的形状，而 Rust 那一边按原样那串校验。
 * 2. 🔴 **任何一路都不许把 `vela-img:` 交出去**（见下面那组 `copyTargetOf` 用例）。
 *    复制出去的是一串谁都打不开的死链，粘进正文还能把文档弄坏。
 * 3. ⚠️ **左键让链接，右键不让**。这两条判据故意不同，所以它们各有一组用例；
 *    把它们合成一条守卫的话，链接里的图就再也复制不了地址了
 * 4. 🔴 **M7-8 起 `src` 不一定是能给人看的那一串**：预览里那张云端图的 `src` 是一份
 *    15 分钟的读取凭证，所以「会离开这一层的东西」（剪贴板、大图底部那一行）读的是
 *    `data-oss-src`。这一条漏掉的形态是把一条临时授权粘进别人的聊天窗口
 *
 * ⚠️ 键盘那一条（M7-11 认下的欠账）**复用左键的判据**，所以它这一组用例钉的不是新规矩，
 * 而是「一处判据、两个消费者」这件事本身没被写坏
 */

const LOCAL_URL = 'vela-img://localhost/?doc=%2Fnotes%2Fa.md&ref=assets%2Fpasted-0123.png'

/**
 * M7-8：预览里那张云端图的 `src` 此刻是签名地址，`data-oss-src` 里才是正文那一串。
 * 主机名抄自 `src-tauri/src/oss.rs` 的 `object_url` 拼出来的形状（命不命中由 Rust 判，
 * 所以这里要的只是一个形状正确的样本）
 */
const OSS_PLAIN = 'https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/pasted-ad48c1765eb1b87d.png'
const OSS_SIGNED = `${OSS_PLAIN}?x-oss-credential=LTAI5tExampleId%2F20231216%2Fcn-hangzhou%2Foss%2Faliyun_v4_request&x-oss-signature=deadbeef`

/** 造一张「已经在预览里显示出来」的图；本地图片由 `localImage.ts` 挂上 `data-path` */
function imageEl(attrs: Record<string, string>, wrapInLink = false): HTMLElement {
  const img = document.createElement('img')
  Object.entries(attrs).forEach(([k, v]) => img.setAttribute(k, v))
  if (!wrapInLink) return img
  const a = document.createElement('a')
  a.setAttribute('href', 'https://example.com/post')
  a.append(img)
  return a
}

function localImg(): HTMLImageElement {
  return imageEl({ src: LOCAL_URL, 'data-path': 'assets/pasted-0123.png' }) as HTMLImageElement
}

/** 已经换过签名地址的那一张（`ossImage.ts` 的产物） */
function cloudImg(): HTMLImageElement {
  return imageEl({ src: OSS_SIGNED, 'data-oss-src': OSS_PLAIN }) as HTMLImageElement
}

describe('zoomOf：哪一次点击算「点了一张图，要看大图」', () => {
  it('本地图片给出原样的 vela-img URL，而那一行说明与 `ref` 用的是正文里那串引用', () => {
    expect(zoomOf(localImg())).toEqual({
      src: LOCAL_URL,
      label: 'assets/pasted-0123.png',
      ref: 'assets/pasted-0123.png',
      unsigned: null,
    })
  })

  it('🔴 云端那张：显示用签名地址，那一行说明与挂回大图的都是不带签名的地址', () => {
    // 那一个遮罩底部的一行会被人复制、贴进别处，而签名地址是一份 15 分钟的读取凭证
    expect(zoomOf(cloudImg())).toEqual({ src: OSS_SIGNED, label: OSS_PLAIN, ref: null, unsigned: OSS_PLAIN })
    expect(zoomOf(cloudImg())?.label).not.toContain('x-oss-')
  })

  it('公开桶那张（没换过签名地址）没有 `unsigned`：`src` 本身就是正文那一串', () => {
    const img = imageEl({ src: OSS_PLAIN }) as HTMLImageElement
    expect(zoomOf(img)?.unsigned).toBeNull()
    expect(zoomOf(img)?.label).toBe(OSS_PLAIN)
  })

  it('⚠️ `src` 读的是 `data-oss-src` 那一个属性，不是 `.src`', () => {
    // jsdom 里 `.src` 会给那串签名地址重新编码一遍（`%2F` 变 `/`），而那与签名的字节
    // 不是同一个东西。这一条与上面那条「读属性不读 `.src`」是同一个坑的两个方向
    const img = imageEl({ src: 'https://e.com/a.png', 'data-oss-src': 'https://e.com/a%20b.png' }) as HTMLImageElement
    expect(zoomOf(img)?.label).toBe('https://e.com/a%20b.png')
    expect(copyTargetOf(img)?.text).toBe('https://e.com/a%20b.png')
  })

  it('⚠️ `src` 读属性不读 `.src`：后者会被文档 base 解析改写', () => {
    const img = imageEl({ src: 'https://e.com/a.png' }) as HTMLImageElement
    // jsdom 会把 `.src` 补成绝对形式；这一条钉子保证代码里用的是属性本身
    expect(img.src).toBe('https://e.com/a.png')
    const got = zoomOf(img)
    expect(got?.src).toBe(img.getAttribute('src'))
    expect(got?.label).toBe('https://e.com/a.png') // 外链没有 data-path，退回 URL
    expect(got?.ref).toBeNull() // 也就不会在大图上冒充成一串文档内的引用
  })

  it('🔴 被链接包住的图归链接，不弹——那一次点击是「打开这个链接」', () => {
    const a = imageEl({ src: 'https://e.com/a.png' }, true)
    const img = a.querySelector('img') as HTMLImageElement
    expect(zoomOf(img)).toBeNull()
  })

  it('占位 `span`、没有 src 的图、以及非元素都不算', () => {
    const span = document.createElement('span')
    span.className = 'md-img-local'
    expect(zoomOf(span)).toBeNull()
    expect(zoomOf(imageEl({}) as HTMLImageElement)).toBeNull()
    expect(zoomOf(document.createTextNode('x'))).toBeNull()
    expect(zoomOf(null)).toBeNull()
  })

  it('`data-path` 是空串时不算引用（不能拿一个空的 `ref` 去冒充本地图片）', () => {
    const img = imageEl({ src: LOCAL_URL, 'data-path': '' }) as HTMLImageElement
    expect(zoomOf(img)?.ref).toBeNull()
  })
})

describe('markZoomableImages：哪些图标成键盘也停得下来（M7-11 欠账一）', () => {
  /** 造一小块预览正文。⚠️ 必须是**挂在同一个根上**的：这个函数走的是一次 DOM 扫描 */
  function root(...children: HTMLElement[]): HTMLElement {
    const el = document.createElement('div')
    el.append(...children)
    return el
  }

  it('标的是 `tabindex` + `role` + 一句念得出来的名字', () => {
    const el = imageEl({ src: 'https://e.com/a.png', alt: '一张截图' }) as HTMLImageElement
    markZoomableImages(root(el))
    expect(el.getAttribute('tabindex')).toBe('0')
    expect(el.getAttribute('role')).toBe('button')
    // `role="button"` 顶掉了 `img` 的语义，名字里必须带着替代文字，
    // 否则读屏器念出来的是「按钮」加一串 URL
    expect(el.getAttribute('aria-label')).toBe('看大图：一张截图')
  })

  it('⛔ 被链接包住的图不标：那一次点击归链接，多一个按了没反应的焦点是在骗人', () => {
    const a = imageEl({ src: 'https://e.com/a.png', alt: '一张截图' }, true)
    const el = a.querySelector('img')!
    markZoomableImages(root(a))
    expect(el.hasAttribute('tabindex')).toBe(false)
    expect(el.hasAttribute('role')).toBe(false)
  })

  it('没有 `src` 的图不标（它压根没显示出来）；占位 `span` 不是 `<img>`，扫都扫不到', () => {
    const bare = imageEl({ alt: '一张截图' }) as HTMLImageElement
    const span = document.createElement('span')
    span.className = 'md-img-local'
    markZoomableImages(root(bare, span))
    expect(bare.hasAttribute('tabindex')).toBe(false)
    expect(span.hasAttribute('tabindex')).toBe(false)
  })

  it('🔴 标出来的那一批与 `zoomOf` 认的那一批是**同一批**——一处判据，两个消费者', () => {
    // 这一条是这组用例里最值钱的：分开写两份判据的话，「能 Tab 停下来」与「点得开」会各自漂，
    // 而症状是安静的（多一个按了没反应的停点，或者少一个键盘到不了的图）
    const zoomable = imageEl({ src: LOCAL_URL, 'data-path': 'assets/pasted-0123.png', alt: '甲' })
    const cloud = imageEl({ src: OSS_SIGNED, 'data-oss-src': OSS_PLAIN, alt: '乙' })
    const linked = imageEl({ src: 'https://e.com/a.png', alt: '丙' }, true)
    const bare = imageEl({ alt: '丁' })
    const r = root(zoomable, cloud, linked, bare)
    markZoomableImages(r)
    for (const el of [...r.querySelectorAll('img')]) {
      expect(el.hasAttribute('tabindex'), `${el.getAttribute('alt')} 该不该停得下来`).toBe(zoomOf(el) !== null)
    }
    expect([...r.querySelectorAll('img[tabindex]')]).toHaveLength(2)
  })
})

describe('copyTargetOf：右键那张图要复制什么', () => {
  it('本地图片复制正文里那串引用，菜单上写「复制路径」', () => {
    expect(copyTargetOf(localImg())).toEqual({ text: 'assets/pasted-0123.png', label: '复制路径' })
  })

  it('外链图片复制那个地址，菜单上写「复制链接」', () => {
    const img = imageEl({ src: 'https://e.com/a.png' }) as HTMLImageElement
    expect(copyTargetOf(img)).toEqual({ text: 'https://e.com/a.png', label: '复制链接' })
  })

  it('⚠️ 包在链接里的图照样能右键（右键不导航，没有手势可抢）', () => {
    const a = imageEl({ src: 'https://e.com/a.png' }, true)
    const img = a.querySelector('img') as HTMLImageElement
    expect(zoomOf(img)).toBeNull() // 同一张图，左键归链接
    expect(copyTargetOf(img)?.label).toBe('复制链接')
  })

  it('🔴 没有 `data-path` 的本地图片什么都不复制——`vela-img:` 绝不能进剪贴板', () => {
    const img = imageEl({ src: LOCAL_URL }) as HTMLImageElement
    expect(copyTargetOf(img)).toBeNull()
  })

  it('🔴 云端那张复制出去的是不带签名的地址——一份 15 分钟的读取凭证不进剪贴板', () => {
    // 剪贴板会走到应用外面：粘进聊天窗口、粘进另一篇文档、被同步工具带走，
    // 而那一串在有效期内对任何拿到它的人都读得通（论证见 `./ossImage.ts` 文件头那条 🔴）
    expect(copyTargetOf(cloudImg())).toEqual({ text: OSS_PLAIN, label: '复制链接' })
    expect(copyTargetOf(cloudImg())?.text).not.toContain('x-oss-')
  })

  it('⚠️ 包在链接里的云端图右键照样给不带签名的那一条', () => {
    const a = imageEl({ src: OSS_SIGNED, 'data-oss-src': OSS_PLAIN }, true)
    const img = a.querySelector('img') as HTMLImageElement
    expect(copyTargetOf(img)?.text).toBe(OSS_PLAIN)
  })

  it('🔴 `data:` 那种内联图也不给：一串 base64 复制出去既没用又长得要命', () => {
    const img = imageEl({ src: 'data:image/png;base64,iVBORw0KGgo=' }) as HTMLImageElement
    expect(copyTargetOf(img)).toBeNull()
  })

  it('认不出来的那些输入返回 null，调用方据此把原生菜单留给用户', () => {
    expect(copyTargetOf(document.createElement('span'))).toBeNull()
    expect(copyTargetOf(imageEl({}) as HTMLImageElement)).toBeNull()
    expect(copyTargetOf(null)).toBeNull()
  })
})
