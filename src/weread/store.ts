/**
 * 微信读书全量同步的**可变状态**：在不在跑、跑到第几本、怎么取消（M8-6）。
 *
 * 与 `src/search/store.ts` 是同一个分层：IPC 与事件在 `./ipc.ts`，这里只剩
 * 「异步 + 状态」。结构性的东西（进度那句话怎么写、图标什么时候出现）在组件与纯函数里。
 *
 * ## 认账逻辑照抄搜索那一份，理由也一样
 *
 * `weread_sync_dir` 是先 spawn 后台任务、再返回 taskId 的，所以「事件已经在路上」与
 * 「invoke 还没回来」这两件事会重叠——一次几千本书的同步不太可能快到这种程度，但
 * **一次立刻就失败的同步**可以（列书单那一步就撞上 `upgrade_info`）。朴素的
 * `if (taskId !== current()) return` 在这种时候会把那条 `weread-failed` 丢掉，
 * 界面永远停在「同步中…」。所以三个变量（`adopted` / `starting` / `retired`）
 * 一个都不能省，逐条注释见 `search/store.ts` 的模块文档。
 *
 * ## 取消不是终止信号
 *
 * `cancel()` 只调 `cancel_task`，状态一律不动：后台是协作式取消，它跑到下一次检查标志
 * 才知道，而**唯一的终止信号仍然是 `weread-done`**（`summary.cancelled = true`）。
 * 这里自己把 `running` 置假的话，取消之后迟到的进度会落在一个「已经结束」的界面上。
 */

import { createSignal, type Accessor } from 'solid-js'
import { cancelTask } from '../ipc/task'
import {
  describeWereadError,
  startWereadSync,
  type WereadError,
  type WereadHandlers,
  type WereadProgress,
  type WereadSummary,
} from './ipc'

export interface WereadSync {
  /** 有没有一次同步在飞。图标用它禁用自己、根行用它换掉那一格 */
  readonly running: Accessor<boolean>
  /** 最近一份进度。`null` = 还没收到第一份（刚起飞的极短窗口） */
  readonly progress: Accessor<WereadProgress | null>

  /**
   * 起一次同步。已经在跑时什么都不做（图标那边本来也会禁用，这里是第二道）。
   *
   * 预检失败会 reject（目录不对、key 没配）：调用方拿到的那句话走 `onError`，
   * 与事件里那条失败的落点相同——用户看到的只有一处。
   */
  start: (dir: string) => Promise<void>

  /** 请求取消。终止信号仍然是 `weread-done`，见模块文档 */
  cancel: () => Promise<void>

  /** 交给 `attachWereadListeners` 的三个回调。启动时挂一次、挂着不放 */
  readonly handlers: WereadHandlers
}

export interface WereadSyncOptions {
  /**
   * 失败那句话交给谁。App 注入窗口顶部那条提示（与文件树操作失败同一个落点）——
   * 侧边栏只有 220px 宽，一句带路径的中文在里面会折成竖条。
   */
  onError: (text: string) => void
}

export function createWereadSync(options: WereadSyncOptions): WereadSync {
  const [running, setRunning] = createSignal(false)
  const [progress, setProgress] = createSignal<WereadProgress | null>(null)

  let adopted: string | null = null
  let starting = false
  const retired = new Set<string>()

  function accept(taskId: string): boolean {
    if (retired.has(taskId)) return false
    if (adopted === taskId) return true
    if (starting) {
      adopted = taskId
      return true
    }
    return false
  }

  function finish(taskId: string): void {
    retired.add(taskId)
    if (adopted === taskId) adopted = null
    starting = false
    setRunning(false)
    setProgress(null)
  }

  async function start(dir: string): Promise<void> {
    if (running()) return
    starting = true
    setProgress(null)
    setRunning(true)
    try {
      const taskId = await startWereadSync(dir)
      starting = false
      // 可能这一轮在 invoke 回来之前就结束了（done 早到），那时它已经进了 retired，
      // 再认下来会让 cancel() 去取消一个已经结束的任务。与 `search/store.ts` 同一条
      if (!retired.has(taskId)) adopted = taskId
    } catch (err) {
      starting = false
      setRunning(false)
      setProgress(null)
      options.onError(describeWereadError(err))
    }
  }

  async function cancel(): Promise<void> {
    if (adopted === null) return
    await cancelTask(adopted)
  }

  const handlers: WereadHandlers = {
    onProgress(taskId: string, next: WereadProgress): void {
      if (!accept(taskId)) return
      setProgress(next)
    },
    onDone(taskId: string, _summary: WereadSummary): void {
      if (!accept(taskId)) return
      finish(taskId)
      // ⚠️ 完成不弹提示、不改提示条：这是「用户点了图标才发生」的动作，但它的结果就写在
      // 磁盘上（新素材文件 + 整理文件），再说一句只是噪声。取消同理——`_summary` 留着
      // 参数是为了 M8-6b / 真机那一轮要显示「取消时已写完几本」时有地方可接
    },
    onFailed(taskId: string, error: WereadError): void {
      if (!accept(taskId)) return
      finish(taskId)
      options.onError(describeWereadError(error))
    },
  }

  return { running, progress, start, cancel, handlers }
}
