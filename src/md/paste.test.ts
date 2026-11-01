import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { MAX_IMAGE_BYTES } from '../ipc/asset'
import { MAX_UPLOAD_BYTES } from '../ipc/oss'
import type { OssConfig } from '../settings/store'
import { bytesToBase64 } from '../util/base64'
import { acceptsPastedImage, imageMarkdown, landPastedImage, type PasteTarget } from './paste'

/**
 * 这一层刻意不认识 CM6，所以整份用例跑在 node 环境里：两个假回调 + 一个 mock 掉的
 * `invoke` 就是它的全部外部世界。CM6 那半截在 `src/editor/paste.test.ts`。
 *
 * ⚠️ M7-7 起的云端那一态**不 mock** `../ipc/oss` 里那个 `uploadImage`，而是把 `cloud.upload`
 * 换成一个假函数：这一层与「怎么传」之间只有那一个注入点，钉住注入点比钉住实现更准，
 * 而线上形状（`upload_image` 只收 `dataBase64`）由 `src/App.test.tsx` 与 `../ipc/oss.test.ts`
 * 各钉一条。
 */

const GOLDEN = {
  rel: 'assets/pasted-ad48c1765eb1b87d.png',
  path: '/notes/assets/pasted-ad48c1765eb1b87d.png',
  bytes: 67,
  reused: false,
}

/** 与 Rust 侧 `asset.rs` 的 `TINY_PNG` 是同一份字节，落地名也是同一个 */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

function png(bytes: Uint8Array<ArrayBuffer> = TINY_PNG, name = 'shot.png'): File {
  return new File([bytes], name, { type: 'image/png' })
}

/**
 * 记录两个回调收到的东西，其余什么都不做。
 *
 * `oss` 传了就顺手把云端那一态接上（`cloud.upload` 是一个可以被每条用例改答案的假函数，
 * `clear` 同理）；不传就是 M3-A-7 那条路——下面那一批用例走的全是这一支
 */
function target(
  path: string | null,
  oss?: OssConfig,
): PasteTarget & {
  inserted: string[]
  notices: [string, string][]
  upload: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
} {
  const inserted: string[] = []
  const notices: [string, string][] = []
  const upload = vi.fn(() => Promise.resolve(OSS_URL))
  const clear = vi.fn()
  return {
    path,
    insert: (text) => inserted.push(text),
    notify: (text, level) => notices.push([text, level]),
    ...(oss === undefined ? {} : { cloud: { oss: () => oss, upload } }),
    clear,
    inserted,
    notices,
    upload,
  }
}

/** 三格齐的一份配置。`prefix` 那一格不参与「配没配」的判断，见 `ossConfigured` 那段注释 */
const OSS: OssConfig = { bucket: 'vela-img', region: 'cn-hangzhou', accessKeyId: 'LTAI-x', prefix: 'assets' }

/** Rust `upload_image` 交回来的那一个**不带签名**的 URL：与本地那一份同一个哈希、同一个名字 */
const OSS_URL = 'https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/pasted-ad48c1765eb1b87d.png'

beforeEach(() => {
  invoke.mockReset()
})

describe('imageMarkdown', () => {
  it('插进正文的是一行空 alt 的相对链接', () => {
    expect(imageMarkdown('assets/pasted-ad48c1765eb1b87d.png')).toBe('![](assets/pasted-ad48c1765eb1b87d.png)')
  })

  it('不转义也不加尖括号：Rust 生成的名字里没有需要转义的东西', () => {
    // ⚠️ 这一条钉的是命名规则与这一层之间的隐含约定。哪天 `assets/` 或名字变成
    // 可配置的（M4），一个带空格的名字会让这行链接在别的渲染器里直接断掉，
    // 而这里就是唯一需要跟着改的地方
    expect(imageMarkdown('assets/a b.png')).toBe('![](assets/a b.png)')
  })
})

describe('acceptsPastedImage', () => {
  it('Markdown 的四种扩展名都接', () => {
    for (const at of ['/a/note.md', '/a/note.markdown', '/a/note.mdown', '/a/note.mkd']) {
      expect(acceptsPastedImage(at), at).toBe(true)
    }
  })

  it('扩展名的大小写不影响判断', () => {
    expect(acceptsPastedImage('/a/NOTE.MD')).toBe(true)
  })

  it('未命名草稿也接：接住是为了能说清「先存一次」', () => {
    // ⚠️ `languageFor(null)` 答 Markdown（M1-E 起就是这个行为）。要是这里答 false，
    // 用户在草稿里按 ⌘V 得到的是一次彻底的静默
    expect(acceptsPastedImage(null)).toBe(true)
  })

  it('别的语言一律不接', () => {
    for (const at of ['/a/main.rs', '/a/README.txt', '/a/app.tsx', '/a/no-extension']) {
      expect(acceptsPastedImage(at), at).toBe(false)
    }
  })
})

describe('landPastedImage', () => {
  it('未命名草稿被拒绝，而且说清下一步该做什么', async () => {
    const t = target(null)
    await landPastedImage(png(), t)
    expect(t.inserted).toEqual([])
    expect(t.notices).toEqual([['这份文档还没有路径。先存一次（⌘S），图片要落在它旁边的 assets/ 里', 'plain']])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('超过上限时在**读文件之前**就拒', async () => {
    // 🔴 断言的是「arrayBuffer 压根没被调」，不只是「没插链接」：用户在 Finder 里
    // 复制一个 2 GB 的文件再粘进来是会发生的事，那时先读进内存就已经卡死了
    const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(0)))
    const huge = { size: MAX_IMAGE_BYTES + 1, arrayBuffer } as unknown as File
    const t = target('/notes/a.md')
    await landPastedImage(huge, t)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(t.inserted).toEqual([])
    expect(t.notices).toEqual([['这张图有 32.0 MB，超过上限 32 MB', 'plain']])
  })

  it('刚好在上限内不拦', async () => {
    const exactly = { size: MAX_IMAGE_BYTES, arrayBuffer: () => Promise.resolve(TINY_PNG.buffer) } as unknown as File
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md')
    await landPastedImage(exactly, t)
    expect(t.notices).toEqual([])
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
  })

  it('成功时把 rel 递进 invoke，并插入那一行链接', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md')
    await landPastedImage(png(), t)
    expect(invoke).toHaveBeenCalledTimes(1)
    const [command, args] = invoke.mock.calls[0] as [string, Record<string, string>]
    expect(command).toBe('store_image')
    // ⚠️ 递的是文档路径，不是目录：目录由 Rust 从它推出来，前端没有「写哪儿」这个说法
    expect(args.docPath).toBe('/notes/a.md')
    expect(typeof args.dataBase64).toBe('string')
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices).toEqual([])
  })

  it('复用了已有文件时同样不说话：插进去的链接就是全部的反馈', async () => {
    invoke.mockResolvedValue({ ...GOLDEN, reused: true })
    const t = target('/notes/a.md')
    await landPastedImage(png(), t)
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices).toEqual([])
  })

  it('Rust 拒收时把原因说成人话，并且标成 error', async () => {
    invoke.mockRejectedValue({ kind: 'unsupported', reason: 'SVG 是 XML，能带脚本，不收' })
    const t = target('/notes/a.md')
    await landPastedImage(png(), t)
    expect(t.inserted).toEqual([])
    expect(t.notices).toEqual([['SVG 是 XML，能带脚本，不收', 'error']])
  })

  it('写盘失败时同样说出口', async () => {
    invoke.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '没有写权限' })
    const t = target('/notes/a.md')
    await landPastedImage(png(), t)
    expect(t.notices).toEqual([['没有写权限', 'error']])
  })

  it('后端回了不认识的东西也不抛，退化成 String()', async () => {
    // ⚠️ 调用它的那一侧在一个 CM6 DOM 事件处理器里，抛出去的异常会被 CM6 吞掉，
    // 用户看到的是「什么都没发生」——比任何一句难听的错误文案都糟
    invoke.mockRejectedValue('boom')
    const t = target('/notes/a.md')
    await expect(landPastedImage(png(), t)).resolves.toBeUndefined()
    expect(t.inserted).toEqual([])
    expect(t.notices).toEqual([['boom', 'error']])
  })

  it('读文件失败也不抛', async () => {
    const broken = {
      size: 4,
      arrayBuffer: () => Promise.reject(new Error('读不出来')),
    } as unknown as File
    const t = target('/notes/a.md')
    await expect(landPastedImage(broken, t)).resolves.toBeUndefined()
    expect(t.inserted).toEqual([])
    expect(t.notices).toEqual([['读不出来', 'error']])
  })

  it('一次粘贴只读一次文件', async () => {
    // 🔴 云端那一步复用本地那一份字节。各读一遍 = 两次把整张图解码进内存，
    // 而 `file.arrayBuffer()` 每次都是一趟真的读取
    const arrayBuffer = vi.fn(() => Promise.resolve(TINY_PNG.buffer))
    const file = { size: 67, arrayBuffer } as unknown as File
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    await landPastedImage(file, t)
    expect(arrayBuffer).toHaveBeenCalledTimes(1)
    expect(t.upload).toHaveBeenCalledTimes(1)
  })
})

describe('云端那一态（M7-7）', () => {
  it('三格齐：本地落一份、再传一次，正文写回来的那个 URL', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    await landPastedImage(png(), t)
    expect(invoke).toHaveBeenCalledTimes(1) // 只有 store_image；上传走的是注入的那个假函数
    expect(t.upload).toHaveBeenCalledTimes(1)
    expect(t.inserted).toEqual([`![](${OSS_URL})`])
    expect(t.notices).toEqual([['上传中…', 'plain']])
    expect(t.clear).toHaveBeenCalledTimes(1)
  })

  it('递给上传的字节与递给本地的是同一份', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    await landPastedImage(png(), t)
    const local = invoke.mock.calls[0] as [string, { dataBase64: string }]
    expect(local[0]).toBe('store_image')
    expect(t.upload.mock.calls[0]![0]).toEqual(TINY_PNG)
    expect(local[1].dataBase64).toBe(bytesToBase64(TINY_PNG))
  })

  it('没接云端时一个字都不改：不上传、不说「上传中…」、也不收回', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md')
    await landPastedImage(png(), t)
    expect(t.upload).not.toHaveBeenCalled()
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices).toEqual([])
    expect(t.clear).not.toHaveBeenCalled()
  })

  it('三格里任何一格是空的都不走云端', async () => {
    invoke.mockResolvedValue(GOLDEN)
    for (const key of ['bucket', 'region', 'accessKeyId'] as const) {
      const t = target('/notes/a.md', { ...OSS, [key]: '' })
      await landPastedImage(png(), t)
      expect(t.upload, key).not.toHaveBeenCalled()
      expect(t.inserted, key).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    }
  })

  it('空前缀**不是**「没配」：那是「就把图放在 bucket 根上」那个合法选择', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', { ...OSS, prefix: '' })
    await landPastedImage(png(), t)
    expect(t.upload).toHaveBeenCalledTimes(1)
    expect(t.inserted).toEqual([`![](${OSS_URL})`])
  })

  it('本地那一份先落：磁盘写不进去时一次上传都不会发', async () => {
    // 🔴 顺序是整个降级能力的前提——先落盘、后上传，失败时正文里那行相对链接才指得着什么
    invoke.mockRejectedValue({ kind: 'io', reason: 'PermissionDenied', message: '没有写权限' })
    const t = target('/notes/a.md', OSS)
    await landPastedImage(png(), t)
    expect(t.upload).not.toHaveBeenCalled()
    expect(t.inserted).toEqual([])
    expect(t.notices).toEqual([['没有写权限', 'error']])
  })

  it('未命名草稿即使云端配好也先拒：不落盘也不上传', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target(null, OSS)
    await landPastedImage(png(), t)
    expect(invoke).not.toHaveBeenCalled()
    expect(t.upload).not.toHaveBeenCalled()
    expect(t.notices).toEqual([['这份文档还没有路径。先存一次（⌘S），图片要落在它旁边的 assets/ 里', 'plain']])
  })

  it('超过云端 10 MB：本地照样落、插相对路径，但一次上传都不发', async () => {
    // ⚠️ 32 MiB 以内、10 MB 以外那张图**不该被丢掉**：它落得了本地，只是上不了云。
    // 这一条钉的就是「上限从 32MB 收到 10MB」收的是云端那一趟，不是这次粘贴
    invoke.mockResolvedValue(GOLDEN)
    const big = { size: MAX_UPLOAD_BYTES + 1, arrayBuffer: () => Promise.resolve(TINY_PNG.buffer) } as unknown as File
    const t = target('/notes/a.md', OSS)
    await landPastedImage(big, t)
    expect(t.upload).not.toHaveBeenCalled()
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices).toEqual([['这张图有 10.0 MB，超过上限 10 MB', 'plain']])
    expect(t.clear).not.toHaveBeenCalled()
  })

  it('云端开着时 32 MiB 那道闸门仍然在最前面', async () => {
    const arrayBuffer = vi.fn(() => Promise.resolve(TINY_PNG.buffer))
    const huge = { size: MAX_IMAGE_BYTES + 1, arrayBuffer } as unknown as File
    const t = target('/notes/a.md', OSS)
    await landPastedImage(huge, t)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(t.upload).not.toHaveBeenCalled()
    expect(t.notices).toEqual([['这张图有 32.0 MB，超过上限 32 MB', 'plain']])
  })

  it('OSS 回了 403：降级写相对路径，用 Rust 那句话，标成 error', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    t.upload.mockRejectedValue({
      kind: 'rejected',
      status: 403,
      code: 'InvalidAccessKeyId',
      message: '这个 AccessKey ID 在阿里云上不存在，去控制台核对一下',
      request_id: null,
    })
    await expect(landPastedImage(png(), t)).resolves.toBeUndefined()
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices).toEqual([
      ['上传中…', 'plain'],
      ['这个 AccessKey ID 在阿里云上不存在，去控制台核对一下', 'error'],
    ])
    expect(t.clear).not.toHaveBeenCalled()
  })

  it('断网：同样降级，同样把原因说出口', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    t.upload.mockRejectedValue({ kind: 'network', reason: 'Connect', message: '连不上 OSS 的服务器' })
    await landPastedImage(png(), t)
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices[1]).toEqual(['连不上 OSS 的服务器', 'error'])
  })

  it('钥匙串里没有密钥（Rust 的 not_configured）：降级，但档位是 plain', async () => {
    // 三格齐、密钥没配是**能走到**的一支：`ossConfigured` 只看那三格（密钥前端读不到），
    // 权威那一句由 Rust 说。它不是故障，是「你还没做那一步」——与「先存一次」同一档
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    t.upload.mockRejectedValue({ kind: 'not_configured', reason: '没有拿到 AccessKey Secret，请在设置里填一次。' })
    await landPastedImage(png(), t)
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices[1]).toEqual(['没有拿到 AccessKey Secret，请在设置里填一次。', 'plain'])
  })

  it('上传那一步抛的是 Error（前端自己那道上限拦的）也照样降级，不往外抛', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    t.upload.mockRejectedValue(new Error('这张图有 12.0 MB，超过上限 10 MB'))
    await expect(landPastedImage(png(), t)).resolves.toBeUndefined()
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices[1]).toEqual(['这张图有 12.0 MB，超过上限 10 MB', 'error'])
  })

  it('后端回了不认识的东西也只说一句话，不抛', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    t.upload.mockRejectedValue('boom')
    await expect(landPastedImage(png(), t)).resolves.toBeUndefined()
    expect(t.inserted).toEqual(['![](assets/pasted-ad48c1765eb1b87d.png)'])
    expect(t.notices[1]).toEqual(['boom', 'error'])
  })

  it('四格是在上传那一刻才读的：改了设置下一次粘贴就换路线', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const oss = { ...OSS }
    const t = target('/notes/a.md', oss)
    await landPastedImage(png(), t)
    expect(t.upload).toHaveBeenCalledTimes(1)
    oss.bucket = ''
    await landPastedImage(png(), t)
    expect(t.upload).toHaveBeenCalledTimes(1)
    expect(t.inserted).toHaveLength(2)
  })

  it('成功之后不再补一句「传上去了」：链接就是回话', async () => {
    invoke.mockResolvedValue(GOLDEN)
    const t = target('/notes/a.md', OSS)
    await landPastedImage(png(), t)
    expect(t.notices.filter((n) => n[0] !== '上传中…')).toEqual([])
  })
})
