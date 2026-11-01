import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `upload_image` 的前端契约快照（M7-3）。
 *
 * Rust 侧的对照分两处（因为这个类型不在 vela-core 里）：`src-tauri/src/oss.rs` 的
 * `错误序列化成前端认的形状`、`新加的两条失败也上得了线`，以及 `commands.rs` 里
 * `upload_image` 那条命令的签名。两边各手写一份，没有代码生成。
 *
 * 🔴 这一组里最要紧的不是文案，是**第一组那一条**：invoke 的参数只许有 `dataBase64`。
 * 那四格目的地（bucket / region / AccessKey ID / 前缀）与密钥一样都传不进来，
 * 传进来就等于把「带着用户的凭证往任意主机发请求」交给 webview。
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  describeUploadError,
  PRESIGN_TTL_MS,
  presignOssImages,
  type PresignedImage,
  MAX_UPLOAD_BYTES,
  uploadImage,
} from './oss'

/** 一段够 sniff 用的 PNG 魔数（真字节在 `src/util/base64.test.ts` 那边测） */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

beforeEach(() => {
  invoke.mockReset()
})

describe('命令的形状', () => {
  it('只有一个参数对象，而且里面只有 dataBase64', async () => {
    invoke.mockResolvedValue('https://b.oss-cn-hangzhou.aliyuncs.com/assets/pasted-1.png')
    await uploadImage(PNG)
    expect(invoke).toHaveBeenCalledTimes(1)
    const [cmd, args] = invoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(cmd).toBe('upload_image')
    // 🔴 这条断言是「多一个键就红」：bucket / region / accessKeyId / prefix / secret
    // 任何一个进了这个对象，都等于把目的地交给 webview
    expect(Object.keys(args)).toEqual(['dataBase64'])
  })

  it('字节走 base64 字符串，不走数字数组', async () => {
    invoke.mockResolvedValue('u')
    await uploadImage(PNG)
    const args = (invoke.mock.calls[0] as [string, Record<string, string>])[1]
    expect(typeof args.dataBase64).toBe('string')
    expect(args.dataBase64).not.toContain(',')
  })

  it('🔴 超过 10 MB 在 invoke 之前就被拒，一个请求都不发', async () => {
    // 一张 11 MB 的图先编成 base64 约 15 MB 的字符串，再花一次 IPC 往返让 Rust 拒掉——
    // 用户看到的是「点了之后卡了一下」。数字与 Rust 的 `MAX_UPLOAD_BYTES` 同一个口径
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024)
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1)
    await expect(uploadImage(big)).rejects.toThrow(/10 MB/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('刚好到上限的字节照常发出（上限是「超过」不是「达到」）', async () => {
    invoke.mockResolvedValue('u')
    await uploadImage(new Uint8Array(MAX_UPLOAD_BYTES))
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('返回的就是那一个不带签名的 URL，原样交给调用方写进正文', async () => {
    const url = 'https://vela-img.oss-cn-hangzhou.aliyuncs.com/assets/pasted-ad48c1765eb1b87d.png'
    invoke.mockResolvedValue(url)
    expect(await uploadImage(PNG)).toBe(url)
    // ⛔ 带 `Signature=` 的那种是签名地址，有有效期，绝不能进正文（见 oss.rs 的 put_object）
    expect(url).not.toMatch(/Signature|Expires|x-oss/)
  })
})

describe('Rust → 前端 的七个 kind', () => {
  /** 与 `oss.rs` 的 `错误序列化成前端认的形状`、`新加的两条失败也上得了线` 逐字对照
   *（字段名与顺序都不许改）。`network` 那一条是**示意**的：`network_error` 在测试里造不出
   * 一个 `reqwest::Error`（见 `oss.rs` 那一段的 ⚠️），只有形状是真的 */
  const GOLDEN = {
    not_configured: '{"kind":"not_configured","reason":"设置里没有填 bucket。"}',
    bad_data: '{"kind":"bad_data","reason":"InvalidInputLength"}',
    bad_image: '{"kind":"bad_image","reason":"SVG 不支持：它是 XML，能带脚本，而预览走的是 innerHTML"}',
    bad_sign_time: '{"kind":"bad_sign_time","reason":"签名时刻不是 YYYYMMDDTHHMMSSZ 那一形"}',
    rejected:
      '{"kind":"rejected","status":403,"code":"AccessDenied","message":"这个 AccessKey 没有往该 bucket 写入的权限。用 RAM 子账号的话，策略里要放行 oss:PutObject。","request_id":null}',
    network: '{"kind":"network","reason":"Timeout","message":"30 秒内没把这张图传完。（timeout）"}',
  }

  /** 每一种失败把人话装在哪一个字段里。⚠️ 这一个映射就是 `describeUploadError` 那个 switch
   *（`network` 与 `rejected` 用 `message`，因为它们除了那句话还各带几个机器用的字段；
   * 剩下四条只有一句 `reason`） */
  const TEXT_FIELD = {
    not_configured: 'reason',
    bad_data: 'reason',
    bad_image: 'reason',
    bad_sign_time: 'reason',
    rejected: 'message',
    network: 'message',
  } as const

  it('六个 kind 各回一句可显示的话，而且是后端那句原话', () => {
    // 原样透传：前端一份、Rust 一份就是措辞漂移（同 `describeSecretError` 那一节的论证）。
    // 上面那张映射表写错一个字段，这一条就会拿 `undefined` 去比一句中文
    for (const [kind, json] of Object.entries(GOLDEN)) {
      const err = JSON.parse(json) as Record<string, string>
      const text = describeUploadError(err)
      expect(text.length).toBeGreaterThan(0)
      expect(text).toBe(err[TEXT_FIELD[kind as keyof typeof TEXT_FIELD]])
    }
  })

  it('too_big 是唯一一句前端拼的话，用词与本地那条 32 MB 的完全相同', () => {
    // 与 `./asset.ts` 的 `tooBigText` 同一个函数：两个数字不同，形状必须一样
    expect(describeUploadError({ kind: 'too_big', bytes: 5, limit: 10485760 })).toBe('这张图有 0.0 MB，超过上限 10 MB')
    expect(describeUploadError({ kind: 'too_big', bytes: 12 * 1048576, limit: MAX_UPLOAD_BYTES })).toBe(
      '这张图有 12.0 MB，超过上限 10 MB',
    )
  })

  it('rejected 的 request_id 是下划线形式，而且可以是 null', () => {
    // Rust 的字段就叫 `request_id`，`rename_all = "snake_case"` 之后仍是它。
    // 拼成 `requestId` 的话这里读出来是 undefined——报障时最想要的那一串没了
    const err = JSON.parse(GOLDEN.rejected) as { request_id: unknown; requestId?: unknown }
    expect(err.request_id).toBeNull()
    expect('requestId' in err).toBe(false)
  })

  it('不是 UploadError 的 reject 值退化成原话，不抛', () => {
    expect(describeUploadError('Command upload_image not found')).toBe('Command upload_image not found')
    expect(describeUploadError(new Error('boom'))).toBe('boom')
    expect(describeUploadError({ nope: 1 })).toBe('[object Object]')
  })

  it('未认识的 kind 也有一句返回，而不是 undefined', () => {
    expect(describeUploadError({ kind: 'from-the-future' })).toBe('[object Object]')
  })
})

/**
 * M7-8：`presign_oss_images` 的前端契约。
 *
 * Rust 侧的对照在 `src-tauri/src/oss.rs` 的 `三个字段的前端形状钉死`（手写镜像，没有代码生成）
 */
describe('presign_oss_images 的形状', () => {
  it('只有一个参数对象，里面只有 urls', async () => {
    invoke.mockResolvedValue([])
    await presignOssImages(['https://b.oss-cn-hangzhou.aliyuncs.com/assets/a.png'])
    const [cmd, args] = invoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(cmd).toBe('presign_oss_images')
    // 🔴 与 `upload_image` 同一条纪律：目的地那四格传进来，就等于把「往任意主机签一条读取
    // 凭证」交给 webview。多一个键就红
    expect(Object.keys(args)).toEqual(['urls'])
    expect(args.urls).toEqual(['https://b.oss-cn-hangzhou.aliyuncs.com/assets/a.png'])
  })

  it('一张都没有时不发 IPC（那一次往返换回来必然是空数组，而它每个字符都会发生）', async () => {
    expect(await presignOssImages([])).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('🔴 返回的是数组，一条都不 reject：失败长在那一张的 `reason` 上', async () => {
    invoke.mockResolvedValue([{ url: 'u', signedUrl: null, reason: '设置里没有填 bucket。' }])
    const got = await presignOssImages(['u'])
    expect(got[0]?.signedUrl).toBeNull()
    expect(got[0]?.reason).toBe('设置里没有填 bucket。')
  })

  it('三个字段是 camelCase，与 Rust 那个 `rename_all = "camelCase"` 逐字对上', () => {
    // ⚠️ 这一条与上面 `UploadError` 那一组**不一样**：那一个是挂在枚举上的 snake_case。
    // 混了的形状是前端读出 `undefined`，预览里那张图安静地不换
    const wire = '{"url":"u","signedUrl":"https://x?s=1","reason":null}'
    const got = JSON.parse(wire) as PresignedImage
    expect(got.signedUrl).toBe('https://x?s=1')
    expect('signed_url' in got).toBe(false)
  })

  it('TTL 与 Rust 那个 `PRESIGN_TTL_SECONDS` 是同一个数字的两种单位', () => {
    expect(PRESIGN_TTL_MS).toBe(900 * 1000)
  })
})
