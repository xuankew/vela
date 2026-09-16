import { describeSessionError, loadSession, saveSession } from '../ipc/session'
import type { Workspace } from './workspace'

/**
 * 会话的「什么时候存、什么时候读」这一层（M1-F-5）。
 *
 * `workspace` 只管把现场序列化成一份纯数据（`serializeSession` / `restoreSession`），
 * 存不存、存多勤、存失败了说什么，都是这里的职责。分开的好处是 workspace 的测试
 * 不必拖进定时器与 IPC。
 *
 * **两条策略**：
 *
 * 1. **节流靠定时轮询 + 内容比对**，而不是「改动时打个标记」。标记要挂在每一个会改现场
 *    的地方：输入、切标签、开文件、另存为、换编码、分屏、合并、聚焦、滚动、拖拽重排……
 *    漏一个的后果是**存档悄悄停在旧状态**，而且没有任何报错。轮询比对不会漏：它只看
 *    序列化出来的结果本身。代价是每 5 秒多算一次 `serializeSession`——几十个标签也就
 *    一两毫秒，换来的是「不可能漏」。
 *
 * 2. **关窗放行前必须再存一次**。节流那一轮最长要等 5 秒，而 `close_window` 是
 *    `Window::destroy()`，webview 当场就没了——最后 5 秒里敲的字全丢。
 */

/** 自动保存的最小间隔。5 秒是「崩了最多丢 5 秒」与「打字时别一直写盘」之间的取舍 */
export const SESSION_SYNC_INTERVAL_MS = 5000

/** 定时器句柄的注销函数 */
type Unschedule = () => void

/**
 * 定时器可注入。
 *
 * 不用 `vi.useFakeTimers()`：假表会把 `requestAnimationFrame` 一起冻住，而 CM6 的
 * measure/read 两阶段调度正跑在 rAF 上——挂真编辑器的用例会连带变成一个时序谜团。
 */
export type Scheduler = (tick: () => void, intervalMs: number) => Unschedule

export interface SessionSyncOptions {
  workspace: Workspace
  /**
   * 出问题时说一句话（存档读不回来、写不下去、草稿被丢）。
   *
   * 没注入就什么都不说。会话恢复是**启动路径**上的一环，它失败不该把应用一起带走：
   * 存档坏了就照常开一个新文档，比崩在启动画面上好得多。
   */
  onWarn?: (text: string) => void
  intervalMs?: number
  schedule?: Scheduler
}

export interface SessionSync {
  /** 读回上次的会话装进 workspace，然后启动节流自动保存。要在应用挂载后立刻调 */
  start: () => Promise<void>
  /**
   * 立刻存一次，不等节流。关窗握手在放行前调它。
   *
   * 与后台那一轮串行：两个写并发会让「盘上最后是哪一份」变成掷硬币。
   */
  saveNow: () => Promise<void>
  /** 停掉定时器。已经在飞的写不打断——它自己会落地 */
  stop: () => void
}

export function createSessionSync(options: SessionSyncOptions): SessionSync {
  const ws = options.workspace
  const warn = options.onWarn ?? (() => {})
  const intervalMs = options.intervalMs ?? SESSION_SYNC_INTERVAL_MS
  const schedule =
    options.schedule ??
    ((tick, ms) => {
      const id = setInterval(tick, ms)
      return () => clearInterval(id)
    })

  /**
   * 上一次**成功写出去**的那份 JSON。写失败时不更新——下一轮会重试，
   * 否则一次瞬时故障就把这轮改动永久跳过了。
   */
  let lastSent: string | null = null
  let unschedule: Unschedule | null = null
  /** 写队列的尾巴。所有写都挂在它后面，于是任意时刻最多一个写在飞 */
  let tail: Promise<void> = Promise.resolve()

  async function doWrite(): Promise<void> {
    const session = ws.serializeSession()
    // 指纹只用来跟自己做相等比较，不需要与线上的字节完全一致
    const fingerprint = JSON.stringify(session)
    if (fingerprint === lastSent) return
    try {
      const report = await saveSession(session)
      lastSent = fingerprint
      if (report.droppedDrafts > 0) {
        warn(
          `会话太大，有 ${report.droppedDrafts} 个文档的未保存内容没能存进会话——` +
            '重启后它们会回到磁盘上的样子。请手动保存这几个文档。',
        )
      }
    } catch (err) {
      warn(describeSessionError(err))
    }
  }

  function enqueue(): Promise<void> {
    // doWrite 自己吞掉了所有异常，于是 tail 永远不会 reject，也就不需要 catch 兜底
    tail = tail.then(doWrite)
    return tail
  }

  return {
    async start() {
      try {
        const saved = await loadSession()
        // null = 第一次启动，还没有存档。静默地留着 workspace 自带的那个空标签
        if (saved !== null) await ws.restoreSession(saved)
      } catch (err) {
        // 存档存在但读不回来（损坏 / 版本不认 / 超上限）。这不是启动失败：
        // 说一句，然后照常用现在这个空 workspace 跑
        warn(describeSessionError(err))
      }
      unschedule?.()
      unschedule = schedule(() => void enqueue(), intervalMs)
    },
    saveNow: enqueue,
    stop() {
      unschedule?.()
      unschedule = null
    },
  }
}
