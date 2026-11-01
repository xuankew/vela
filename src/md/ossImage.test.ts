// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 预览里那几张云端图片的 DOM 修补层（M7-8）。
 *
 * ## 这一组里最要紧的是那一条「第二次不问了」
 *
 * 签名里带着秒级的时刻，两次签出来是**两个不同的 URL**，浏览器认成两个资源。
 * 于是「每次重画都重新签一遍」的症状不是浪费一次 IPC，而是用户每敲一个字就看到预览里
 * 那张图闪一下、重新加载一遍。缓存这一层的全部意义就在这条用例上
 *
 * ## ⚠️ 这里验不了「图真的显示出来了」
 *
 * jsdom 不发请求，`<img>` 的 `load` / `error` 全靠派发。真实加载、真实尺寸、真实过期
 * 都归真机。签名算得对不对也不在这里——那是 `crates/vela-core/src/oss.rs` 那六条黄金向量
 *
 * ## 🔴 对位的键是无签名那一条
 *
 * 换上去之后 `src` 里是签名地址，而 `data-oss-src` 里留的是正文那一串。下一轮重画必须拿
 * `data-oss-src` 去对位，拿 `src` 的话缓存永远不命中
 */

const { presignOssImages } = vi.hoisted(() => ({ presignOssImages: vi.fn() }))
vi.mock('../ipc/oss', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ipc/oss')>()
  return { ...real, presignOssImages }
})

import { clearOssImageCache, resignAfterError, rewriteCloudImages } from './ossImage'

const PLAIN = 'https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/pasted-1.png'
const SIGNED = `${PLAIN}?x-oss-date=20231216T162057Z&x-oss-expires=900&x-oss-signature=deadbeef`

/** 一个假的钟：过期与提前量都要按毫秒判，真 `Date.now()` 会让用例自己跑过边界 */
let now = 1_000_000
const ttl = () => {
  const spy = vi.spyOn(Date, 'now')
  spy.mockImplementation(() => now)
  return spy
}

function body(...srcs: string[]): HTMLElement {
  const el = document.createElement('div')
  srcs.forEach((src) => {
    const img = document.createElement('img')
    img.setAttribute('src', src)
    img.setAttribute('loading', 'lazy')
    el.appendChild(img)
  })
  document.body.appendChild(el)
  return el
}

function imgs(el: Element): HTMLImageElement[] {
  return Array.from(el.querySelectorAll<HTMLImageElement>('img'))
}

beforeEach(() => {
  presignOssImages.mockReset()
  // 默认当「一条都没认出来」：这一组里每一条都要走到 IPC 那一步，返回 `undefined` 的
  // mock 会让 `.then` 当场炸掉，而那与「Rust 说这不是我们的桶」是两回事
  presignOssImages.mockResolvedValue([])
  document.body.innerHTML = ''
  now = 1_000_000
  clearOssImageCache()
  ttl().mockImplementation(() => now)
})

describe('换与不换', () => {
  it('Rust 认出来的那一张换成签名地址，无签名那条留在 data-oss-src 上', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const el = body(PLAIN)
    expect(await rewriteCloudImages(el)).toBeNull()
    expect(imgs(el)[0]?.getAttribute('src')).toBe(SIGNED)
    expect(imgs(el)[0]?.dataset.ossSrc).toBe(PLAIN)
  })

  it('🔴 认不出来的（别人的站点、别人的桶、明文）一个字都不动，也不说话', async () => {
    presignOssImages.mockResolvedValue([])
    const el = body('https://e.com/a.png', 'http://e.com/b.png')
    expect(await rewriteCloudImages(el)).toBeNull()
    expect(imgs(el).map((img) => img.getAttribute('src'))).toEqual(['https://e.com/a.png', 'http://e.com/b.png'])
    expect(imgs(el)[0]?.hasAttribute('data-oss-src')).toBe(false)
  })

  it('本地图片那条协议（vela-img）压根不进这一层：它不是 http(s)', async () => {
    const el = body('vela-img://localhost/?doc=%2Fa.md&ref=a.png')
    await rewriteCloudImages(el)
    expect(presignOssImages).not.toHaveBeenCalled()
    expect(imgs(el)[0]?.getAttribute('src')).toBe('vela-img://localhost/?doc=%2Fa.md&ref=a.png')
  })

  it('一篇文档里没有任何云端图时一次 IPC 都不发', async () => {
    const el = body()
    expect(await rewriteCloudImages(el)).toBeNull()
    expect(el.querySelectorAll('img')).toHaveLength(0)
    expect(presignOssImages).not.toHaveBeenCalled()
  })

  it('一张文档里出现的地址只递一次（去重），且只递 http(s) 那几条', async () => {
    presignOssImages.mockResolvedValue([])
    const el = body(PLAIN, PLAIN, 'https://e.com/x.png', 'assets/a.png')
    await rewriteCloudImages(el)
    expect(presignOssImages).toHaveBeenCalledTimes(1)
    expect(presignOssImages.mock.calls[0]?.[0]).toEqual([PLAIN, 'https://e.com/x.png'])
  })

  it('⚠️ 写的是属性，不是 HTML：`loading` 与 `alt` 这些一个字都不丢', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const el = body(PLAIN)
    const img = imgs(el)[0]!
    img.alt = '截图'
    await rewriteCloudImages(el)
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.alt).toBe('截图')
  })
})

describe('缓存：那条「闪图」的根', () => {
  it('🔴 两次重画只签一次，而且两次换上去的是同一个地址', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const first = body(PLAIN)
    await rewriteCloudImages(first)
    // 真实的重画是整块 `innerHTML` 换掉，所以第二份 DOM 上 `src` 又是无签名那一条
    const second = body(PLAIN)
    await rewriteCloudImages(second)
    expect(presignOssImages).toHaveBeenCalledTimes(1)
    expect(imgs(second)[0]?.getAttribute('src')).toBe(SIGNED)
    expect(imgs(second)[0]?.getAttribute('src')).toBe(imgs(first)[0]?.getAttribute('src'))
  })

  it('对位读的是 data-oss-src：已经换过的那一张不会被当成一张新图', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const el = body(PLAIN)
    await rewriteCloudImages(el)
    // 同一份 DOM 上再走一次（HTML 没变、只是缓存到期前的另一次重画）
    await rewriteCloudImages(el)
    expect(presignOssImages).toHaveBeenCalledTimes(1)
    expect(imgs(el)[0]?.getAttribute('src')).toBe(SIGNED)
  })

  it('没命中的那一条也记账：下一次重画不为它再跑一趟 Rust', async () => {
    presignOssImages.mockResolvedValue([])
    const el = body('https://e.com/a.png')
    await rewriteCloudImages(el)
    await rewriteCloudImages(el)
    expect(presignOssImages).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 压着 TTL 换上去的那一张会在下一次重画前重新签（缓存比有效期短一个提前量）', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const el = body(PLAIN)
    await rewriteCloudImages(el)
    now += 13 * 60 * 1000 // 780s：提前量之内 → 仍然复用同一个地址
    await rewriteCloudImages(body(PLAIN))
    expect(presignOssImages).toHaveBeenCalledTimes(1)
    now += 2 * 60 * 1000 // 900s：过了一条带提前量的缓存 → 作废
    const fresh = `${PLAIN}?x-oss-date=20231216T163500Z&x-oss-signature=cafe`
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: fresh, reason: null }])
    const next = body(PLAIN)
    await rewriteCloudImages(next)
    expect(presignOssImages).toHaveBeenCalledTimes(2)
    expect(imgs(next)[0]?.getAttribute('src')).toBe(fresh)
  })

  it('签不出来那一条 30 秒后可以再问（用户刚在设置里改完配置不该等到天荒地老）', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: null, reason: '设置里没有填 bucket。' }])
    const el = body(PLAIN)
    expect(await rewriteCloudImages(el)).toBe('设置里没有填 bucket。')
    await rewriteCloudImages(el)
    expect(presignOssImages).toHaveBeenCalledTimes(1)
    now += 31 * 1000
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    expect(await rewriteCloudImages(el)).toBeNull()
    expect(presignOssImages).toHaveBeenCalledTimes(2)
    expect(imgs(el)[0]?.getAttribute('src')).toBe(SIGNED)
  })

  it('clearOssImageCache：换了 bucket 之后旧地址一个都不留', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const el = body(PLAIN)
    await rewriteCloudImages(el)
    clearOssImageCache()
    await rewriteCloudImages(el)
    expect(presignOssImages).toHaveBeenCalledTimes(2)
  })
})

describe('说话：那一句是 Rust 的原话', () => {
  it('命中了但配不上时把 reason 交上去，一张都不换', async () => {
    // 🔴 那句「没有拿到 AccessKey Secret，请在设置里填一次」在 Rust 的 `normalize` 里，
    // 前端一份就是措辞漂移的起点（同 `describeUploadError` 那一条）
    presignOssImages.mockResolvedValue([
      { url: PLAIN, signedUrl: null, reason: '没有拿到 AccessKey Secret，请在设置里填一次。' },
      { url: 'https://e.com/b.png', signedUrl: null, reason: '没有拿到 AccessKey Secret，请在设置里填一次。' },
    ])
    const el = body(PLAIN)
    expect(await rewriteCloudImages(el)).toBe('没有拿到 AccessKey Secret，请在设置里填一次。')
    expect(imgs(el)[0]?.getAttribute('src')).toBe(PLAIN)
  })

  it('IPC 本身坏了也是那句原话，而不是一个写死的「预览出了点问题」', async () => {
    presignOssImages.mockRejectedValue({ kind: 'not_configured', reason: '设置里没有填 region。' })
    const el = body(PLAIN)
    expect(await rewriteCloudImages(el)).toBe('设置里没有填 region。')
    // 坏了那一次同样进缓存：不然每一帧都会重问一遍，而那一句会一直闪
    await rewriteCloudImages(el)
    expect(presignOssImages).toHaveBeenCalledTimes(1)
  })
})

describe('过期那张图：失败重签一次', () => {
  it('换过一次地址的图失败 → 重签、换上新地址，返回 true', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const el = body(PLAIN)
    await rewriteCloudImages(el)
    const img = imgs(el)[0]!
    const fresh = `${PLAIN}?x-oss-date=20231216T170000Z&x-oss-signature=beef`
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: fresh, reason: null }])
    expect(await resignAfterError(img)).toBe(true)
    expect(img.getAttribute('src')).toBe(fresh)
    expect(presignOssImages).toHaveBeenLastCalledWith([PLAIN])
  })

  it('🔴 一个元素只许重试一次：没有上限的形态是每 150ms 裂一次', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const el = body(PLAIN)
    await rewriteCloudImages(el)
    const img = imgs(el)[0]!
    expect(await resignAfterError(img)).toBe(true)
    expect(await resignAfterError(img)).toBe(false)
    expect(presignOssImages).toHaveBeenCalledTimes(2)
  })

  it('没换过签名地址的图（外链、公开桶）压根不走这条路', async () => {
    const el = body('https://e.com/a.png')
    await rewriteCloudImages(el)
    expect(presignOssImages).toHaveBeenCalledTimes(1) // 那一次是「问问 Rust 这是我们自己的桶吗」
    expect(await resignAfterError(imgs(el)[0]!)).toBe(false)
    // 🔴 第二次不许发生：外链图失败的原因跟签名没有任何关系，去重签一次只会把一次
    // 普通的 404 变成一次带着凭证的请求
    expect(presignOssImages).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 已经被下一次重画换掉的元素不算「重试成功」', async () => {
    presignOssImages.mockResolvedValue([{ url: PLAIN, signedUrl: SIGNED, reason: null }])
    const el = body(PLAIN)
    await rewriteCloudImages(el)
    const img = imgs(el)[0]!
    img.remove()
    expect(await resignAfterError(img)).toBe(false)
  })
})
