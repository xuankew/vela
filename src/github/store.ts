/**
 * GitHub 目录同步的**可变状态**：在不在跑、跑到第几个文件、怎么取消（M8-6b）。
 *
 * 与 `weread/store.ts` 是同一个分层、同一份认账逻辑：IPC 与事件在 `./ipc.ts`，
 * 这里只剩「异步 + 状态」。为什么三个变量（`adopted` / `starting` / `retired`）
 * 一个都不能省，逐条理由见 `src/search/store.ts` 的模块文档——`github_sync_dir`
 * 同样是先 spawn 后台任务、再返回 taskId，而一次**预检之后立刻失败**的同步
 * （比如 `main` 与 `master` 都不存在）足以让 `failed` 比 invoke 先到。
 *
 * ## 两把同步互不认账
 *
 * 微信读书与 GitHub 是两个 store、两组事件、两套 taskId（Rust 侧同一个计数器发号，
 * 永不重复）。这里只认 `github-*` 那三个事件；侧栏上的互斥（一边在跑时另一枚图标
 * 先收起来）是**界面层**的事，不在这里——store 不该知道另一个 store 存不存在。
 *
 * ## 取消不是终止信号
 *
 * `cancel()` 只调 `cancel_task`，状态一律不动：后台是协作式取消，它跑到下一次检查标志
 * 才知道，而**唯一的终止信号仍然是 `github-done`**（`summary.cancelled = true`）。
 */

import { createSignal, type Accessor } from 'solid-js'
import { cancelTask } from '../ipc/task'
import {
  describeGithubError,
  startGithubSync,
  type GithubError,
  type GithubHandlers,
  type GithubProgress,
  type GithubSummary,
} from './ipc'

export interface GithubSync {
  /** 有没有一次同步在飞。图标用它禁用自己、根行用它换掉那一格 */
  readonly running: Accessor<boolean>
  /** 最近一份进度。`null` = 还没收到第一份（刚起飞的极短窗口） */
  readonly progress: Accessor<GithubProgress | null>

  /**
   * 起一次同步。已经在跑时什么都不做（图标那边本来也会隐藏，这里是第二道）。
   *
   * 预检失败会 reject（目录不对、没配仓库、token 读不出来）：调用方拿到的那句话走
   * `onError`，与事件里那条失败的落点相同——用户看到的只有一处。
   */
  start: (dir: string) => Promise<void>

  /** 请求取消。终止信号仍然是 `github-done`，见模块文档 */
  cancel: () => Promise<void>

  /** 交给 `attachGithubListeners` 的三个回调。启动时挂一次、挂着不放 */
  readonly handlers: GithubHandlers
}

export interface GithubSyncOptions {
  /**
   * 失败那句话交给谁。App 注入窗口顶部那条提示（与文件树操作失败同一个落点）——
   * 侧边栏只有 220px 宽，一句带路径的中文在里面会折成竖条。
   */
  onError: (text: string) => void
}

export function createGithubSync(options: GithubSyncOptions): GithubSync {
  const [running, setRunning] = createSignal(false)
  const [progress, setProgress] = createSignal<GithubProgress | null>(null)

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
      const taskId = await startGithubSync(dir)
      starting = false
      // 这一轮可能在 invoke 回来之前就结束了（done/failed 早到），那时它已经进了 retired，
      // 再认下来会让 cancel() 去取消一个已经结束的任务。与 `weread/store.ts` 同一条
      if (!retired.has(taskId)) adopted = taskId
    } catch (err) {
      starting = false
      setRunning(false)
      setProgress(null)
      options.onError(describeGithubError(err))
    }
  }

  async function cancel(): Promise<void> {
    if (adopted === null) return
    await cancelTask(adopted)
  }

  const handlers: GithubHandlers = {
    onProgress(taskId: string, next: GithubProgress): void {
      if (!accept(taskId)) return
      setProgress(next)
    },
    onDone(taskId: string, _summary: GithubSummary): void {
      if (!accept(taskId)) return
      finish(taskId)
      // ⚠️ 完成不弹提示：成没成看磁盘与远端，再说一句只是噪声。取消同理——
      // `_summary` 留着参数是为了真机那一轮要显示「取消时已拉/推了几个」时有地方可接
    },
    onFailed(taskId: string, error: GithubError): void {
      if (!accept(taskId)) return
      finish(taskId)
      options.onError(describeGithubError(error))
    },
  }

  return { running, progress, start, cancel, handlers }
}
