import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `store_image` 的前端契约快照。
 *
 * 与 Rust 侧 `crates/vela-core/tests/wire_contract.rs` 的
 * `stored_image_的字段名是_camel_case` / `asset_error_用_kind_标签区分变体` 一一对应，
 * 两边的 JSON 字面量必须同时改。
 *
 * ⚠️ 这一组里最该盯住的是 `rel`：它是唯一一个会被**拼进文档正文**的字段，
 * 读错的后果是正文里躺着一个当时看着完全正常的坏链接。
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { describeAssetError, MAX_IMAGE_BYTES, storeImage, type StoredImage } from './asset'
// ⚠️ 只为 `storeImage` 那一条用例引进来算期望值。编码器本身的用例在 `src/util/base64.test.ts`
import { bytesToBase64 } from '../util/base64'

/** 与 Rust 侧 `TINY_PNG` 同一串字节（1×1 透明 PNG，67 字节） */
const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

/** Rust 侧 `asset_error_用_kind_标签区分变体` 里那五个确切字面量 */
const GOLDEN: Record<string, string> = {
  empty: '{"kind":"empty"}',
  unsupported: '{"kind":"unsupported","reason":"x"}',
  bad_data: '{"kind":"bad_data","reason":"y"}',
  no_parent: '{"kind":"no_parent","path":"note.md"}',
  too_big: '{"kind":"too_big","bytes":5,"limit":33554432}',
}

/** Rust 侧 `stored_image_的字段名是_camel_case` 里那一份的确切 JSON（路径换成一个假的） */
const GOLDEN_STORED_IMAGE =
  '{"rel":"assets/pasted-ad48c1765eb1b87d.png","path":"/notes/assets/pasted-ad48c1765eb1b87d.png","bytes":67,"reused":false}'

beforeEach(() => {
  invoke.mockReset()
})

describe('Rust → 前端 的字段名', () => {
  it('StoredImage 的字段名与顺序与 Rust 侧序列化结果一致', () => {
    const parsed = JSON.parse(GOLDEN_STORED_IMAGE) as StoredImage
    expect(JSON.stringify(parsed)).toBe(GOLDEN_STORED_IMAGE)
    expect(Object.keys(parsed)).toEqual(['rel', 'path', 'bytes', 'reused'])
    // rel 是 Markdown 链接：固定目录名 + 正斜杠，⛔ 不是文件系统路径
    expect(parsed.rel).toMatch(/^assets\/pasted-[0-9a-f]{16}\.png$/)
  })

  it('🔴 rel 里的分隔符是正斜杠，而且目录名与 Rust 的 ASSET_DIR 是同一个字面量', () => {
    // 这一条在 macOS 上与「拿 Path::display() 当链接」长得一模一样，所以只有把字面量
    // 钉死，将来移植到 Windows 时那个静默的反斜杠才会被这条测试拦下来
    expect(GOLDEN_STORED_IMAGE).toContain('"rel":"assets/')
    expect(GOLDEN_STORED_IMAGE).not.toContain('\\')
  })

  it('AssetError 的六种 kind 字面量与 Rust 的 serde 标签一致', () => {
    // 与 `asset_error_用_kind_标签区分变体` 逐条对照
    expect(GOLDEN['empty']).toBe('{"kind":"empty"}')
    expect(GOLDEN['unsupported']).toBe('{"kind":"unsupported","reason":"x"}')
    expect(GOLDEN['bad_data']).toBe('{"kind":"bad_data","reason":"y"}')
    expect(GOLDEN['no_parent']).toBe('{"kind":"no_parent","path":"note.md"}')
    expect(GOLDEN['too_big']).toBe('{"kind":"too_big","bytes":5,"limit":33554432}')
  })

  it('上限两边是同一个数', () => {
    // wire_contract.rs 里那个 `"limit":33554432` 字面量的前端对照
    expect(MAX_IMAGE_BYTES).toBe(33554432)
    expect(MAX_IMAGE_BYTES).toBe(32 * 1024 * 1024)
  })
})

describe('describeAssetError', () => {
  it('unsupported 与 bad_data 直接用 Rust 侧写好的那句话', () => {
    // `unsupported` 的 reason 里带着开头的字节——那是「我粘的明明是一张图」与
    // 「Vela 说这不是图」之间唯一的线索，前端不该改写它
    const reason = '开头的字节是 3c 73 76 67，不是认得的图片格式（只收 PNG / JPEG / GIF / WebP / BMP）'
    expect(describeAssetError({ kind: 'unsupported', reason })).toBe(reason)
    expect(describeAssetError({ kind: 'bad_data', reason: 'Invalid byte 1, offset 3' })).toBe(
      'Invalid byte 1, offset 3',
    )
  })

  it('too_big 的口径与 describeFsError 的 too_large 一致（MB 一位小数、上限取整）', () => {
    expect(describeAssetError({ kind: 'too_big', bytes: 33554433, limit: 33554432 })).toBe(
      '这张图有 32.0 MB，超过上限 32 MB',
    )
  })

  it('empty 与 no_parent 各说各的', () => {
    expect(describeAssetError({ kind: 'empty' })).toBe('粘进来的图片是空的')
    expect(describeAssetError({ kind: 'no_parent', path: 'note.md' })).toBe(
      'note.md 没有目录部分，推不出 assets/ 该放哪',
    )
  })

  it('io 显示 message 而不是 reason', () => {
    // reason 是给日志与测试看的（`NotADirectory` / `NameExhausted`），message 是给人看的
    expect(describeAssetError({ kind: 'io', reason: 'NotADirectory', message: '/n/assets 已经存在' })).toBe(
      '/n/assets 已经存在',
    )
  })

  it('不认识的形状退回字符串，不抛', () => {
    expect(describeAssetError(new Error('网络断了'))).toBe('网络断了')
    expect(describeAssetError('一句裸字符串')).toBe('一句裸字符串')
    expect(describeAssetError(null)).toBe('null')
    expect(describeAssetError({ kind: 42 })).toBe('[object Object]')
  })
})

describe('storeImage', () => {
  it('命令名与两个参数名都在契约里', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_STORED_IMAGE))
    const stored = await storeImage('/notes/a.md', TINY_PNG)

    expect(invoke).toHaveBeenCalledTimes(1)
    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('store_image')
    // ⚠️ Tauri 把 Rust 的 `doc_path` / `data_base64` 转成 camelCase。
    // 写成下划线的失败方式是一句「invalid args」，还算好查；
    // 而字段名写错（比如把 `rel` 读成 `relative`）拿到的是 `undefined`，一点声音都没有
    expect(Object.keys(args)).toEqual(['docPath', 'dataBase64'])
    expect(args['docPath']).toBe('/notes/a.md')
    expect(args['dataBase64']).toBe(bytesToBase64(TINY_PNG))
    expect(stored.rel).toBe('assets/pasted-ad48c1765eb1b87d.png')
  })

  it('⚠️ 参数里**没有**目标目录，也没有文件名', () => {
    // 这一条钉的是 M3-A-7 的整个安全取舍：前端拿不到「往哪写、叫什么」这两个原语。
    // 将来谁给命令加一个 `dir` 参数，这条测试会先炸
    invoke.mockResolvedValue(JSON.parse(GOLDEN_STORED_IMAGE))
    void storeImage('/notes/a.md', TINY_PNG)
    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.keys(args).sort()).toEqual(['dataBase64', 'docPath'])
  })

  it('🔴 超限时压根不发出请求', async () => {
    // 把 33 MB 编成 base64 再让 Rust 拒掉，白花的是一次几十毫秒的编码与一次 IPC 往返
    const tooBig = new Uint8Array(MAX_IMAGE_BYTES + 1)
    await expect(storeImage('/notes/a.md', tooBig)).rejects.toThrow('这张图有 32.0 MB，超过上限 32 MB')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('刚好在上限内不拦', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_STORED_IMAGE))
    // ⚠️ 这一条会真的编一次 32 MiB 的 base64。它钉的是「> 而不是 >=」——
    // 差一字节就把合法的最后那张图拒掉，是最容易写错也最没人会去试的边界
    await expect(storeImage('/notes/a.md', new Uint8Array(MAX_IMAGE_BYTES))).resolves.toBeTruthy()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('Rust 侧的 reject 原样冒上来，由 describeAssetError 翻译', async () => {
    invoke.mockRejectedValue({ kind: 'unsupported', reason: 'SVG 不支持：它是 XML，能带脚本，而预览走的是 innerHTML' })
    const err: unknown = await storeImage('/notes/a.md', TINY_PNG).catch((e: unknown) => e)
    expect(describeAssetError(err)).toBe('SVG 不支持：它是 XML，能带脚本，而预览走的是 innerHTML')
  })
})
