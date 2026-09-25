/**
 * 把文件从访达 / 资源管理器拖进窗口并打开。
 * 出处是 PLAN.md §2「P1 — M4 视进度纳入」里的那条「拖拽文件到窗口打开」——它没有分配
 * 像 M4-F 那样的里程碑编号，所以这里不写一个出来冒充。
 *
 * ## 为什么走 Tauri 事件而不是 HTML5 的 drop
 *
 * Tauri 2 的窗口默认 `dragDropEnabled: true`（`tauri.conf.json` 没覆写它），原生层会截下
 * 从访达 / 资源管理器拖进来的文件，以 `tauri://drag-drop` 事件给出**绝对路径**清单，
 * 而不是把 `DataTransfer.files` 交给 webview。这反而是更好的一条路：拿到路径就能直接
 * 走 `ws.openAt(path)`，与点侧边栏文件是同一条入口（`workspace.ts` 的 `openAt` 注释里
 * 早就写着「拖拽落文件都走这里」），不需要把字节读进前端再想办法落盘。
 *
 * ⚠️ 与 `doc/TabStrip.tsx` 的标签重排（那才是真用 HTML5 拖放的地方）的冲突是**分平台**的，
 * 口径按 `tauri-utils` 的 `drag_drop_enabled` 文档原文：「Disabling it is required to use
 * HTML5 drag and drop on the frontend **on Windows**」。于是 macOS 上两者共存、这一版不必
 * 动配置；Windows 上则是二选一——保持默认 true 换来文件拖入，代价是那边的标签重排使不了。
 * 那一条在 Windows 上究竟还灵不灵**没有在真机上验过**，动它之前先测。
 *
 * ## 🔴 这一层不认识 signal，也不认识 workspace
 *
 * `handleDroppedPaths` 收的是两个注入的回调，所以整条决策（哪些开、哪些拒、说什么）
 * 能在 node 环境里用两个假函数测出来，不需要 jsdom。与 `src/md/paste.ts` 同一套切法。
 *
 * ⚠️ 拒绝的判据是**扩展名**（`isBinaryPath`），不看内容：一个后缀写着 `.txt` 的
 * 二进制文件照样会被放过去、解成一屏乱码。这是有意的——内容嗅探要么读整个文件
 * （大文件白等）要么只读头部（判不准），而拖放的失败方式只是「多看了一个空标签」，
 * 不值得为它付这个代价。理由与限制都写在 `language.ts` 的 `BINARY_EXT` 上，
 * 那一条还记着「这一张表目前只管拖放，另外两条打开文件的入口没接」。
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { baseName, isBinaryPath } from '../editor/language'

/** Rust 原生层截下拖放后发给前端的事件名。Tauri 内置，非本项目自定义 */
export const DRAG_DROP_EVENT = 'tauri://drag-drop'

/**
 * `tauri://drag-drop` 的原始载荷。
 *
 * ⚠️ **没有 `type` 判别字段**——`{ type: 'drop', paths, position }` 那种形状是
 * `getCurrentWebview().onDragDropEvent()` 合成的：它内部另听了 `tauri://drag-enter` /
 * `drag-over` / `drag-leave` 三个事件，再给每一个贴上一个 type 标签汇到同一个回调里
 * （见 `@tauri-apps/api/webview.js` 的 `onDragDropEvent`）。这一层只订阅 `drag-drop`
 * 那一个，所以拿到的一直就是松手那一刻，不需要按阶段过滤。
 */
interface DragDropPayload {
  paths?: string[]
}

/**
 * 一次落文件要做的全部决策：能开的开掉，开不了的最后说一句。
 *
 * ⚠️ 两类**都**处理，不是「有一个被拒就整批不接」：用户一次拖十个文件、其中一个不是
 * 文本时，他想要的是那九个开起来 + 一句「这个我没开」，而不是十个全没开。
 *
 * 🔴 顺序是**先开、后说**，反过来那句提示会被自己抹掉：`editorNotice` 挂着一条
 * 「换标签就清空」的 effect（`App.tsx` 里 `on(() => ws.activeTab().id, …)`，理由是留着
 * 上一份文档的字数比留白更糟），而 `openAt` 恰好就会换标签。先说的话，提示刚写进
 * signal 就被这一下切标签清掉了——混合拖放（既有能开的又有不能开的）时用户一个字都看不到。
 * 后说则两清：没有能开的东西时不会切标签，提示留着；切了标签的话，清空发生在说之前。
 *
 * 逐个 `await` 而不是 `Promise.all`：`ws.openAt` 在「当前是个干净的无名标签」时会
 * **就地复用**它（`workspace.ts` 的 `openAt`），并发跑的话十个标签会去抢那一个，落点随机。
 * 串行跑则第一个占住无名标签、其余各自新建，顺序与拖放清单一致。
 *
 * 提示只发一句、把被拒的文件名带上：一次拖进来五个图片，弹五条提示条会把屏幕刷满，
 * 而用户其实只想知道「哪几个没开」。
 */
export async function handleDroppedPaths(
  paths: string[],
  deps: {
    /** 打开一个已知路径。就是 `ws.openAt`，错误由 `document.ts` 那层吞掉并落到 doc.notice */
    openAt: (path: string) => Promise<void>
    /** 说一句话。就是 `setEditorNotice` */
    notify: (text: string) => void
  },
): Promise<void> {
  const rejected = paths.filter(isBinaryPath)
  const accepted = paths.filter((p) => !isBinaryPath(p))

  for (const path of accepted) {
    await deps.openAt(path)
  }

  if (rejected.length === 1) {
    deps.notify(`不支持的格式：${baseName(rejected[0]!)}`)
  } else if (rejected.length > 1) {
    const names = rejected.slice(0, 3).map(baseName).join('、')
    const more = rejected.length > 3 ? ` 等 ${rejected.length} 个文件` : ''
    deps.notify(`不支持的格式：${names}${more}`)
  }
}

/**
 * 挂上拖放监听，返回注销函数。
 *
 * 用 `listen` 而不是 `getCurrentWebview().onDragDropEvent`：后者一次挂**四个**事件
 * （enter / over / leave / drop）再合成回调，而这一层只关心松手那一下，多挂的三个
 * 每次拖过窗口都要白跑一遍。少依赖一个模块、测试里也只需替掉 `api/event` 一个。
 *
 * ⚠️ 与 `attachWindowCloseGuard` 同一条要求：**启动第一时间挂上**，注册之前到达的事件会丢。
 */
export function attachFileDrop(onPaths: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<DragDropPayload>(DRAG_DROP_EVENT, (event) => {
    // 拖到窗口外松手时清单可能是空的；没有 paths 键也不能抛
    const paths = event.payload.paths ?? []
    if (paths.length > 0) onPaths(paths)
  })
}
