/**
 * 关窗握手的前端这一半（另一半在 `src-tauri/src/lib.rs`）。
 *
 * ⚠️ 事件名是 Rust 与 TS 之间手写共享的常量，两边各有一份，改一边必须改另一边：
 * `lib.rs` 里的 `REQUEST_CLOSE` 与这里的 `REQUEST_CLOSE_EVENT`。
 * 和 `src/ipc/fs.ts` 的类型漂移是同一类风险，只是这一处的失败方式温和些——
 * 名字对不上的话窗口会**永远关不掉**，而不是静默丢数据。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Rust 侧拦下 CloseRequested / Cmd+Q 之后发的事件 */
export const REQUEST_CLOSE_EVENT = 'vela://request-close'

/**
 * 挂上关窗守卫。`canClose` 返回 true 才真的去拆窗口。
 *
 * 用 `close_window`（Rust 侧是 `Window::destroy()`）而不是前端直接调 `window.close()`：
 * `close()` 会再触发一次 `CloseRequested`，于是「问用户 → 用户同意 → 又问一遍」死循环。
 * `destroy()` 直接拆窗口，随后 Tauri 以 `ExitRequested { code: None }` 退场，
 * 而那一种 `lib.rs` 是放行的。
 *
 * 返回注销函数。**要在应用启动的第一时间挂上**：注册之前到达的事件会丢掉，
 * 用户点关闭就会看到窗口毫无反应。
 */
export async function attachWindowCloseGuard(canClose: () => Promise<boolean>): Promise<UnlistenFn> {
  return listen(REQUEST_CLOSE_EVENT, () => {
    void canClose().then(async (ok) => {
      if (ok) await invoke('close_window')
    })
  })
}
