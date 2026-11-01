import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 三条钥匙串命令的命令名、参数名与两条返回值形状。
 *
 * Rust 侧的对照是 `src-tauri/src/secrets.rs`：`set_oss_secret` / `delete_oss_secret` /
 * `oss_secret_status` 三条 `#[command]`，以及那两条把 JSON 形状钉住的用例
 * （`状态的_json_形状被钉住`、`四种失败的_json_形状被钉住`）。两边各手写一份，没有代码生成。
 *
 * ⚠️ 命令名拼错的失败方式与事件名同一档安静：`invoke` 直接 reject 一句
 * 「Command set_oss_secret not found」，而那句报错读起来像「Rust 侧忘了注册」。
 */

const { tauriCore } = vi.hoisted(() => ({
  tauriCore: { invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>() },
}))

vi.mock('@tauri-apps/api/core', () => tauriCore)

import * as secrets from './secrets'
import { describeSecretError, deleteOssSecret, ossSecretStatus, setOssSecret, type SecretError } from './secrets'

beforeEach(() => {
  tauriCore.invoke.mockReset()
  tauriCore.invoke.mockResolvedValue(undefined)
})

describe('三条命令的形状', () => {
  it('写入的参数叫 secret：单单词，Tauri 不做驼峰转换', async () => {
    await setOssSecret('abc123')
    expect(tauriCore.invoke).toHaveBeenCalledWith('set_oss_secret', { secret: 'abc123' })
  })

  it('删与问都没有参数——寻址全靠 Rust 侧那两个写死的常量', async () => {
    await deleteOssSecret()
    await ossSecretStatus()
    expect(tauriCore.invoke.mock.calls.map((c) => c[0])).toEqual(['delete_oss_secret', 'oss_secret_status'])
    // 一个参数都不许带：`c[1]` 是 `undefined`，长度停在 1
    expect(tauriCore.invoke.mock.calls.map((c) => c.length)).toEqual([1, 1])
    // 🔴 这里钉的是「前端传不了 service 与 account」。那一个口子一旦开，
    // M7-3 的 `upload_image` 就能被指到别人的钥匙串项上去
  })

  it('前端不 trim：去首尾空白是 Rust 那一份 clean 的唯一口径', async () => {
    // ⚠️ 两边各 trim 一次，将来其中一边改了规则，就会出现「面板以为存的是 A、
    // 钥匙串里其实是 B」。这里原样递过去，让唯一一处规则留在 Rust
    await setOssSecret('  abc123\n')
    expect(tauriCore.invoke).toHaveBeenCalledWith('set_oss_secret', { secret: '  abc123\n' })
  })

  it('status 的返回只有一个 bool，值不在里面', async () => {
    tauriCore.invoke.mockResolvedValue({ configured: true })
    expect(await ossSecretStatus()).toEqual({ configured: true })
    expect(JSON.stringify(await ossSecretStatus())).toBe('{"configured":true}')
  })
})

describe('🔴 这个模块里没有一条能读到密钥值的命令', () => {
  it('导出的函数就那四个，多一条 get 就红', () => {
    // 这一条是给人看的护栏：`get_oss_secret` 一旦出现，就必须先在这里出现，
    // 而在那里写下它的名字，等于逼着加它的人重读一遍 secrets.rs 开头那条 🔴
    expect(Object.keys(secrets).sort()).toEqual([
      'deleteOssSecret',
      'describeSecretError',
      'ossSecretStatus',
      'setOssSecret',
    ])
    for (const name of Object.keys(secrets)) {
      expect(name).not.toMatch(/get|read|reveal|fetch/)
    }
  })
})

describe('describeSecretError', () => {
  it('四种 kind 都原样透传后端那句 message，一个字都不改', () => {
    // 🔴 这一条钉的是「文案只有一个出处」。传一句**故意不是**Rust 常量的话，
    // 读回来还是它，才证明这里没有偷偷写死一份自己的文案
    const cases: Array<[SecretError, unknown]> = [
      [{ kind: 'empty', message: 'PROBE-EMPTY' }, 'PROBE-EMPTY'],
      [{ kind: 'corrupt', message: 'PROBE-CORRUPT' }, 'PROBE-CORRUPT'],
      [{ kind: 'unsupported', message: 'PROBE-UNSUPPORTED' }, 'PROBE-UNSUPPORTED'],
      [{ kind: 'keychain', code: -25293, message: 'PROBE-KEYCHAIN' }, 'PROBE-KEYCHAIN'],
    ]
    for (const [err, expected] of cases) {
      expect(describeSecretError(err)).toBe(expected)
    }
  })

  it('四种 kind 的 JSON 形状与 Rust 那四条 golden 一致', () => {
    // 对照 `secrets.rs` 的 `四种失败的_json_形状被钉住`。`keychain` 多带一个 `code`，
    // 剩下三条是 `{kind, message}`——这一条用例存在的意义就是：字段名改一边必红一边
    expect(JSON.stringify({ kind: 'empty', message: '这里要填密钥。要清掉已经存着的那一份，请点「清除」。' })).toBe(
      '{"kind":"empty","message":"这里要填密钥。要清掉已经存着的那一份，请点「清除」。"}',
    )
    expect(JSON.stringify({ kind: 'keychain', code: -25293, message: '钥匙串拒绝了这次读写。' })).toBe(
      '{"kind":"keychain","code":-25293,"message":"钥匙串拒绝了这次读写。"}',
    )
  })

  it('不是 SecretError 的 reject 值退化成原话，不抛', () => {
    // `invoke` 找不到命令时 reject 的是一句字符串，而这条函数挂在 catch 上：
    // 它自己再抛一次的话，用户看到的就只剩「未响应」
    expect(describeSecretError('Command set_oss_secret not found')).toBe('Command set_oss_secret not found')
    expect(describeSecretError(new Error('boom'))).toBe('boom')
    expect(describeSecretError({ nope: 1 })).toBe('[object Object]')
  })

  it('未认识的 kind 也有一句返回，而不是 undefined', () => {
    // 后端加一条变体时，这里不能返回 `undefined`——那一种失败在界面上是一片空白
    expect(describeSecretError({ kind: 'from-the-future' })).toBe('[object Object]')
  })
})
