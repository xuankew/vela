import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 三条钥匙串命令的命令名、参数名与返回值形状（M8-5 GitHub token）。
 *
 * Rust 侧的对照是 `src-tauri/src/github.rs` 与它共用的 `src-tauri/src/secrets.rs`：
 * `set_github_token` / `delete_github_token` / `github_token_status`，以及 `github.rs` 里
 * 那两条钉住「槽位与另外两把凭证不共用」的用例。两边各手写一份，没有代码生成。
 *
 * ⚠️ 命令名拼错的失败方式与事件名同一档安静：`invoke` 直接 reject 一句
 * 「Command set_github_token not found」，而那句报错读起来像「Rust 侧忘了注册」。
 */

const { tauriCore } = vi.hoisted(() => ({
  tauriCore: { invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>() },
}))

vi.mock('@tauri-apps/api/core', () => tauriCore)

import * as github from './github'
import { deleteGithubToken, githubTokenStatus, setGithubToken } from './github'

beforeEach(() => {
  tauriCore.invoke.mockReset()
  tauriCore.invoke.mockResolvedValue(undefined)
})

describe('三条命令的形状', () => {
  it('写入的参数叫 token：单单词，Tauri 不做驼峰转换', async () => {
    await setGithubToken('ghp_abc123')
    expect(tauriCore.invoke).toHaveBeenCalledWith('set_github_token', { token: 'ghp_abc123' })
  })

  it('删与问都没有参数——寻址全靠 Rust 侧那两个写死的常量', async () => {
    await deleteGithubToken()
    await githubTokenStatus()
    expect(tauriCore.invoke.mock.calls.map((c) => c[0])).toEqual(['delete_github_token', 'github_token_status'])
    // 一个参数都不许带：`c[1]` 是 `undefined`，长度停在 1。
    // 🔴 这里钉的是「前端传不了 service 与 account」——那个口子一开，同步就能被指到
    // 别人的钥匙串项上去
    expect(tauriCore.invoke.mock.calls.map((c) => c.length)).toEqual([1, 1])
  })

  it('前端不 trim：去首尾空白是 Rust 那一份 clean 的唯一口径', async () => {
    await setGithubToken('  ghp_abc123\n')
    expect(tauriCore.invoke).toHaveBeenCalledWith('set_github_token', { token: '  ghp_abc123\n' })
  })

  it('status 的返回只有一个 bool，值不在里面', async () => {
    tauriCore.invoke.mockResolvedValue({ configured: true })
    expect(await githubTokenStatus()).toEqual({ configured: true })
    expect(JSON.stringify(await githubTokenStatus())).toBe('{"configured":true}')
  })
})

describe('🔴 这个模块里没有一条能读到 token 的命令', () => {
  it('导出的函数就那三个，多一条 get 就红', () => {
    // 这一条是给人看的护栏：`get_github_token` 一旦出现，就必须先在这里出现，
    // 而在那里写下它的名字，等于逼着加它的人重读一遍 secrets.rs 开头那条 🔴
    expect(Object.keys(github).sort()).toEqual(['deleteGithubToken', 'githubTokenStatus', 'setGithubToken'])
    for (const name of Object.keys(github)) {
      expect(name).not.toMatch(/^(get|read|reveal|fetch)/)
    }
  })
})
