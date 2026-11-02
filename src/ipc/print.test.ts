import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 命令名 `print_window` 的契约快照（M7-15）。
 *
 * 拼错的失败方式与 `close_window` 那一档一样安静：按了「导出 PDF」之后什么都不发生，
 * 用户得到的信息是零，而他的下一个动作是再按一次。Rust 侧那一条在
 * `src-tauri/src/print.rs`，两边没有代码生成，只能各写一份、靠这两份用例盯着。
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { printWindow } from './print'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
})

describe('print_window 的线上形状', () => {
  it('就一条命令、不带参数', async () => {
    await printWindow()

    // ⛔ 不递正文：正文在主窗口 DOM 里，再经 IPC 送一遍只会多出一份要审的载荷
    expect(invoke).toHaveBeenCalledWith('print_window')
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('把 Rust 侧的拒绝原样抛给调用方', async () => {
    invoke.mockRejectedValue('打印面板打不开')

    await expect(printWindow()).rejects.toBe('打印面板打不开')
  })
})
