import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 拖放落文件（PLAN.md §2「P1 — M4 视进度纳入」的「拖拽文件到窗口打开」）。
 *
 * 两条主线：
 * 1. `handleDroppedPaths` 的决策——哪些交给 `openAt`、哪些只说一句，以及**先开后说**的顺序。
 *    顺序那条是真会坏的（提示会被切标签的清空 effect 抹掉），所以专门钉一条；
 * 2. `attachFileDrop` 订阅的是 `tauri://drag-drop` 这个**跨语言字符串**。它拼错的话
 *    表现是"拖进来毫无反应"，与"这个格式确实不支持"在界面上长得一模一样，
 *    所以事件名要像 `windowClose.test.ts` 那样单独钉住。
 *
 * 真正的原生拖放（Rust 侧截 HTML5 事件再转发）这里测不到，得 `pnpm tauri dev` 手工验。
 */

const { tauriEvent } = vi.hoisted(() => ({ tauriEvent: { listen: vi.fn() } }))
vi.mock('@tauri-apps/api/event', () => tauriEvent)

import { attachFileDrop, DRAG_DROP_EVENT, handleDroppedPaths } from './dragDrop'

describe('handleDroppedPaths', () => {
  /** 记录调用顺序的探针：顺序本身就是这一层的契约之一 */
  function harness(opts?: { openDelay?: number }) {
    const calls: string[] = []
    const opened: string[] = []
    const openAt = vi.fn(async (path: string) => {
      if (opts?.openDelay) await new Promise((r) => setTimeout(r, opts.openDelay))
      opened.push(path)
      calls.push(`open:${path}`)
    })
    const notify = vi.fn((text: string) => calls.push(`notify:${text}`))
    return { calls, opened, openAt, notify }
  }

  it('全是文本时逐个交给 openAt，一句提示都不说', async () => {
    const h = harness()
    await handleDroppedPaths(['/a/notes.md', '/a/main.rs', '/a/LICENSE'], h)
    expect(h.opened).toEqual(['/a/notes.md', '/a/main.rs', '/a/LICENSE'])
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('单个二进制：不打开，提示里带的是文件名而不是整条路径', async () => {
    const h = harness()
    await handleDroppedPaths(['/Users/x/Desktop/photo.png'], h)
    expect(h.openAt).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith('不支持的格式：photo.png')
  })

  it('混合拖放：能开的照样开，只对被拒的说一句——不是有一个不支持就整批不接', async () => {
    const h = harness()
    await handleDroppedPaths(['/a/notes.md', '/a/photo.png', '/a/clip.mp4'], h)
    expect(h.opened).toEqual(['/a/notes.md'])
    expect(h.notify).toHaveBeenCalledWith('不支持的格式：photo.png、clip.mp4')
  })

  it('被拒的超过三个只列前三个，但总数说全', async () => {
    const h = harness()
    await handleDroppedPaths(['/a/1.png', '/a/2.png', '/a/3.png', '/a/4.png', '/a/5.png'], h)
    expect(h.notify).toHaveBeenCalledWith('不支持的格式：1.png、2.png、3.png 等 5 个文件')
  })

  it('正好三个时不出现「等 N 个」那句——列出来的就是全部', async () => {
    const h = harness()
    await handleDroppedPaths(['/a/1.png', '/a/2.png', '/a/3.png'], h)
    expect(h.notify).toHaveBeenCalledWith('不支持的格式：1.png、2.png、3.png')
  })

  it('🔴 提示一定发生在所有 openAt 之后', async () => {
    // 反过来（先说后开）在界面上的症状是：混合拖放时那句话**一个字都看不到**。
    // 因为 `editorNotice` 挂着「换标签就清空」的 effect（App.tsx），而 openAt 会换标签。
    // 这条用例钉的是时序，不是文案，所以把 openAt 做成异步的才有意义
    const h = harness({ openDelay: 1 })
    await handleDroppedPaths(['/a/notes.md', '/a/photo.png'], h)
    expect(h.calls).toEqual(['open:/a/notes.md', 'notify:不支持的格式：photo.png'])
  })

  it('⚠️ 串行打开而不是 Promise.all：并发会让多个文件抢同一个干净无名标签', async () => {
    // `workspace.ts` 的 openAt 在「当前是干净的无名标签」时就地复用那个标签。
    // 并发跑的话两个文件会同时命中这条分支，落点变成随机的一个
    const inflight: string[] = []
    const openAt = vi.fn(async (path: string) => {
      inflight.push(`+${path}`)
      await new Promise((r) => setTimeout(r, 1))
      inflight.push(`-${path}`)
    })
    await handleDroppedPaths(['/a/x.md', '/a/y.md'], { openAt, notify: vi.fn() })
    expect(inflight).toEqual(['+/a/x.md', '-/a/x.md', '+/a/y.md', '-/a/y.md'])
  })

  it('空清单什么都不做', async () => {
    const h = harness()
    await handleDroppedPaths([], h)
    expect(h.openAt).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
  })
})

describe('attachFileDrop', () => {
  let handler: ((event: { payload: unknown }) => void) | undefined
  const unlisten = vi.fn()

  beforeEach(() => {
    tauriEvent.listen.mockReset()
    handler = undefined
    tauriEvent.listen.mockImplementation(async (_name: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb
      return unlisten
    })
  })

  it('订阅的事件名就是 tauri://drag-drop，拿回来的是注销函数', async () => {
    const off = await attachFileDrop(vi.fn())
    expect(tauriEvent.listen).toHaveBeenCalledOnce()
    expect(tauriEvent.listen.mock.calls[0]![0]).toBe('tauri://drag-drop')
    expect(DRAG_DROP_EVENT).toBe('tauri://drag-drop')
    expect(off).toBe(unlisten)
  })

  it('drop 事件把路径清单原样交出去', async () => {
    const onPaths = vi.fn()
    await attachFileDrop(onPaths)
    // ⚠️ 载荷形状是**原始**事件的 `{ paths }`，没有 `type` 判别字段——
    // 那个字段是 onDragDropEvent 包装时合成的，这一层没走那条路
    handler!({ payload: { paths: ['/a/x.md', '/a/y.png'] } })
    expect(onPaths).toHaveBeenCalledWith(['/a/x.md', '/a/y.png'])
  })

  it('清单为空或缺 paths 字段时一个回调都不发', async () => {
    const onPaths = vi.fn()
    await attachFileDrop(onPaths)
    handler!({ payload: { paths: [] } })
    handler!({ payload: {} })
    expect(onPaths).not.toHaveBeenCalled()
  })
})
