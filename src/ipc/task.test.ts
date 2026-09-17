import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `cancel_task` 的命令名与参数名。Rust 侧的对照是 `src-tauri/src/commands.rs` 的
 * `cancel_task`（形参 `task_id: String`）与那四条注册表测试。
 *
 * ⚠️ 这一个命令是搜索与替换**共用**的，所以它的测试不属于 `search.test.ts`
 * 也不属于 `replace.test.ts`——与 `task.ts` 的分法一致。
 */

const { tauriCore } = vi.hoisted(() => ({
  tauriCore: { invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>() },
}))

vi.mock('@tauri-apps/api/core', () => tauriCore)

import { cancelTask } from './task'

beforeEach(() => {
  tauriCore.invoke.mockReset()
  tauriCore.invoke.mockResolvedValue(undefined)
})

describe('cancel_task', () => {
  it('⚠️ 参数叫 taskId：本项目第二个多单词命令参数', async () => {
    await cancelTask('search-7')
    // Rust 侧形参是 `task_id`，Tauri 2 在命令边界上把它转成驼峰。写成 `task_id`
    // 的失败方式是一句「invalid args `taskId` for command `cancel_task`」——
    // 那句报错说的是**它要的**名字，读的人却往往以为是自己传错了值。
    // 第一个多单词参数是 `rename_entry` 的 `newName`，见 project.test.ts
    expect(tauriCore.invoke).toHaveBeenCalledWith('cancel_task', { taskId: 'search-7' })
  })

  it('搜索与替换的 taskId 走的是同一个命令，前缀不参与任何判断', async () => {
    await cancelTask('search-7')
    await cancelTask('replace-8')
    expect(tauriCore.invoke.mock.calls.map((c) => c[0])).toEqual(['cancel_task', 'cancel_task'])
    expect(tauriCore.invoke.mock.calls.map((c) => c[1])).toEqual([{ taskId: 'search-7' }, { taskId: 'replace-8' }])
    // ⚠️ 这一条钉的是「前端不解析前缀」：Rust 侧的 `TaskRegistry` 用一个全局单调
    // 计数器给两种任务发号，前缀只为日志可读。前端要是按前缀分派到两个命令，
    // 哪天那边改了前缀，失败方式就是「点了取消，什么也没发生」
  })

  it('幂等：不认识的 taskId 也照样发出去，前端不拦', async () => {
    await cancelTask('search-9999')
    expect(tauriCore.invoke).toHaveBeenCalledWith('cancel_task', { taskId: 'search-9999' })
    // 「取消一个已经跑完的任务」是正常时序而不是错误：点取消的那一刻后台线程
    // 可能刚好发完 done。Rust 侧对不认识的 id 什么也不做（`取消一个不认识的_id_什么也不做`），
    // 前端因此不需要判返回值，也没有失败分支
  })
})
