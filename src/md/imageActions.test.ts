// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { copyTargetOf, zoomOf } from './imageActions'

/**
 * 预览里对一张图的**两个手势**各自认不认这次命中。
 *
 * 这一层全是纯判断，所以这一份文件是整个 M7-11 / M7-12 里最值钱的用例：那两个组件的测试
 * 只能钉住「挂上了 DOM」，而「什么情况下弹、弹出来给的是哪串字」由这两个函数决定。
 *
 * 三条要紧的：
 *
 * 1. 🔴 **`src` 读的是属性而不是 `.src`**。后者会拿文档 base 去解析，`vela-img://…`
 *    在有些实现里会被改写成别的形状，而 Rust 那一边按原样那串校验。
 * 2. 🔴 **任何一路都不许把 `vela-img:` 交出去**（见下面那组 `copyTargetOf` 用例）。
 *    复制出去的是一串谁都打不开的死链，粘进正文还能把文档弄坏。
 * 3. ⚠️ **左键让链接，右键不让**。这两条判据故意不同，所以它们各有一组用例；
 *    把它们合成一条守卫的话，链接里的图就再也复制不了地址了
 */

const LOCAL_URL = 'vela-img://localhost/?doc=%2Fnotes%2Fa.md&ref=assets%2Fpasted-0123.png'

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

describe('zoomOf：哪一次点击算「点了一张图，要看大图」', () => {
  it('本地图片给出原样的 vela-img URL，而那一行说明与 `ref` 用的是正文里那串引用', () => {
    expect(zoomOf(localImg())).toEqual({
      src: LOCAL_URL,
      label: 'assets/pasted-0123.png',
      ref: 'assets/pasted-0123.png',
    })
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
