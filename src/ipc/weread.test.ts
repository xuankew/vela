import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 三条钥匙串命令的命令名、参数名与返回值形状（M8-2 微信读书那把 key）。
 *
 * Rust 侧的对照是 `src-tauri/src/weread.rs` 与它共用的 `src-tauri/src/secrets.rs`：
 * `set_weread_key` / `delete_weread_key` / `weread_key_status`，以及 `secrets.rs` 里那两条
 * 把 JSON 形状钉住的用例。两边各手写一份，没有代码生成。
 *
 * ⚠️ 命令名拼错的失败方式与事件名同一档安静：`invoke` 直接 reject 一句
 * 「Command set_weread_key not found」，而那句报错读起来像「Rust 侧忘了注册」。
 */

const { tauriCore } = vi.hoisted(() => ({
  tauriCore: { invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>() },
}))

vi.mock('@tauri-apps/api/core', () => tauriCore)

import * as weread from './weread'
import { deleteWereadKey, setWereadKey, wereadKeyStatus } from './weread'

beforeEach(() => {
  tauriCore.invoke.mockReset()
  tauriCore.invoke.mockResolvedValue(undefined)
})

describe('三条命令的形状', () => {
  it('写入的参数叫 key：单单词，Tauri 不做驼峰转换', async () => {
    await setWereadKey('wrk-abc123')
    expect(tauriCore.invoke).toHaveBeenCalledWith('set_weread_key', { key: 'wrk-abc123' })
  })

  it('删与问都没有参数——寻址全靠 Rust 侧那两个写死的常量', async () => {
    await deleteWereadKey()
    await wereadKeyStatus()
    expect(tauriCore.invoke.mock.calls.map((c) => c[0])).toEqual(['delete_weread_key', 'weread_key_status'])
    // 一个参数都不许带：`c[1]` 是 `undefined`，长度停在 1。
    // 🔴 这里钉的是「前端传不了 service 与 account」——那个口子一开，同步就能被指到
    // 别人的钥匙串项上去
    expect(tauriCore.invoke.mock.calls.map((c) => c.length)).toEqual([1, 1])
  })

  it('前端不 trim：去首尾空白是 Rust 那一份 clean 的唯一口径', async () => {
    await setWereadKey('  wrk-abc123\n')
    expect(tauriCore.invoke).toHaveBeenCalledWith('set_weread_key', { key: '  wrk-abc123\n' })
  })

  it('status 的返回只有一个 bool，值不在里面', async () => {
    tauriCore.invoke.mockResolvedValue({ configured: true })
    expect(await wereadKeyStatus()).toEqual({ configured: true })
    expect(JSON.stringify(await wereadKeyStatus())).toBe('{"configured":true}')
  })
})

describe('🔴 这个模块里没有一条能读到 key 的命令', () => {
  it('导出的函数就那三个，多一条 get 就红', () => {
    // 这一条是给人看的护栏：`get_weread_key` 一旦出现，就必须先在这里出现，
    // 而在那里写下它的名字，等于逼着加它的人重读一遍 secrets.rs 开头那条 🔴
    expect(Object.keys(weread).sort()).toEqual(['deleteWereadKey', 'setWereadKey', 'wereadKeyStatus'])
    for (const name of Object.keys(weread)) {
      // ⚠️ 只看**动词**：「Weread」里就含着 read，所以不能整名匹配
      expect(name).not.toMatch(/^(get|read|reveal|fetch)/)
    }
  })
})
