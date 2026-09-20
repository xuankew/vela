import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { MAX_IMAGE_BYTES } from '../ipc/asset'
import { acceptsPastedImage, imageMarkdown, landPastedImage, type PasteTarget } from './paste'

/**
 * 这一层刻意不认识 CM6，所以整份用例跑在 node 环境里：两个假回调 + 一个 mock 掉的
 * `invoke` 就是它的全部外部世界。CM6 那半截在 `src/editor/paste.test.ts`。
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

/** 记录两个回调收到的东西，其余什么都不做 */
function target(path: string | null): PasteTarget & { inserted: string[]; notices: [string, string][] } {
  const inserted: string[] = []
  const notices: [string, string][] = []
  return {
    path,
    insert: (text) => inserted.push(text),
    notify: (text, level) => notices.push([text, level]),
    inserted,
    notices,
  }
}

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
})
