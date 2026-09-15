import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 关窗守卫的前端这一半。
 *
 * 这里能测的只有「收到事件之后怎么决策」，真正的关闭发生在 Rust 侧
 * （`Window::destroy()`），那一半只能靠 `pnpm tauri dev` 手工验。
 * 但**事件名与命令名是跨语言手写的字符串**，对不上的话窗口会永远关不掉——
 * 这是本文件存在的主要理由，见下面第一条用例。
 */

const { tauriEvent, tauriCore } = vi.hoisted(() => ({
  tauriEvent: { listen: vi.fn() },
  tauriCore: { invoke: vi.fn() },
}))

vi.mock('@tauri-apps/api/event', () => tauriEvent)
vi.mock('@tauri-apps/api/core', () => tauriCore)

import { attachWindowCloseGuard, REQUEST_CLOSE_EVENT } from './windowClose'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let handler: (() => void) | undefined
let unlisten: () => void

beforeEach(() => {
  tauriEvent.listen.mockReset()
  tauriCore.invoke.mockReset()
  handler = undefined
  unlisten = vi.fn()
  tauriEvent.listen.mockImplementation(async (_name: string, cb: () => void) => {
    handler = cb
    return unlisten
  })
})

describe('跨语言契约', () => {
  it('事件名与 Rust 侧 lib.rs 的 REQUEST_CLOSE 是同一个字面量', () => {
    // Rust 侧的对照在 src-tauri/src/lib.rs 的 #[cfg(test)]，改一边必须同时改另一边
    expect(REQUEST_CLOSE_EVENT).toBe('vela://request-close')
  })

  it('命令名与 Rust 侧 commands.rs 里的 close_window 是同一个字面量', async () => {
    await attachWindowCloseGuard(async () => true)
    handler?.()
    await flush()
    expect(tauriCore.invoke).toHaveBeenCalledWith('close_window')
  })
})

describe('attachWindowCloseGuard', () => {
  it('listen 挂的就是那个事件名，拿回来的是注销函数', async () => {
    const off = await attachWindowCloseGuard(async () => true)
    expect(tauriEvent.listen).toHaveBeenCalledOnce()
    expect(tauriEvent.listen.mock.calls[0]![0]).toBe(REQUEST_CLOSE_EVENT)
    expect(off).toBe(unlisten)
  })

  it('canClose 答 false 时一个命令都不发——窗口留着，等用户处理未保存的改动', async () => {
    await attachWindowCloseGuard(async () => false)
    handler?.()
    await flush()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it('canClose 是每次事件都重新问一遍，不是挂上去时问一次就定死', async () => {
    let answer = false
    await attachWindowCloseGuard(async () => answer)

    handler?.()
    await flush()
    expect(tauriCore.invoke).not.toHaveBeenCalled()

    answer = true
    handler?.()
    await flush()
    expect(tauriCore.invoke).toHaveBeenCalledOnce()
  })
})
