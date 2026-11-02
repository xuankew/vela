import { createEffect, on, onCleanup } from 'solid-js'
import { createDebounced, domTimer, type Timer } from '../ui/timer'
import type { Workspace } from './workspace'

/**
 * 自动存盘：用户停手一小会儿，就把**该落盘的**文档写回原路径。
 *
 * 与 `sessionSync` 是两条互补的保险，别拿一条替另一条：
 *
 * - `sessionSync` 每 5 秒把现场（含草稿）写进会话存档，管的是**进程没了**之后还能捡回来
 * - 这一层把改动写回**文件本身**，管的是「用户忘了按 ⌘S，但文件应该就是最新的」
 *
 * 于是「没命名的文档」在这里一律不碰：`save()` 对它走的是另存为，会弹原生对话框，
 * 而一个定时器弹出来的对话框是最糟的一种打扰。会话存档照收它的草稿。
 *
 * ## 只自动写「用户自己弄脏的」文档
 *
 * 判据是 `doc.edits() > 0` 而不是 `doc.dirty()`。启动时恢复出来的草稿按定义就是脏的，
 * 可它可能已经比磁盘旧（Vela 关着的时候别人改过那个文件）。照着 `dirty` 行事的话，
 * 自动存盘会在用户什么都没做的时候，用一份过时的草稿把磁盘盖掉。用户真敲下第一个字，
 * 那份草稿才算「他的东西」，之后才交给自动存盘。
 *
 * ## 刻意不碰的四类
 *
 * - 未命名：见上面那条（另存为对话框）
 * - 只读分片：`save` 本来就拒，正文也不在内存里
 * - 有损解码（`lossy`）：原样写回就是拿 U+FFFD 覆盖原文件，而那是**数据损坏**。
 *   用户手动 ⌘S 时 Vela 会说一句，自动存盘连说的机会都没有
 * - 冲突队列里还排着的：文件被外部改过而 Vela 手里有未保存改动，写下去等于替用户
 *   在「覆盖磁盘上的版本」上按了确认。冲突问完（用户选了「保留我的改动」）之后再编辑，
 *   才会重新进入自动存盘的范围
 *
 * ⚠️ 残留竞态：外部改动的事件在 `fileWatch` 那边有 250ms 的防抖，而自动存盘是在
 * 停手 1.5s 之后才写。若别人恰好在这一轮触发前 250ms 内改了文件，那一次仍会被覆盖。
 * 再往下压就要把两个防抖合成一个状态机，代价与收益不成比例：会话存档里还留着一份
 */

/**
 * 停手多久之后写。
 *
 * 短了会在打字途中反复整篇序列化 + 原子写盘；长了「打完最后一个字就切走窗口」那一下
 * 留在内存里的时间更久。1.5s 与 `fileWatch` 的 250ms 事件防抖也拉开了一个量级，
 * 让「外部刚改过」那条冲突有机会先排进队列
 */
export const AUTO_SAVE_DELAY_MS = 1500

export interface AutoSaveOptions {
  workspace: Workspace
  /**
   * 这个标签此刻不能自动写盘。接的是 `fileWatch.hasConflict`：
   * 还排着一条没答复的文件冲突时，自动写盘等于替用户做了决定
   */
  blocked?: (tabId: number) => boolean
  /** 测试用。生产走 `AUTO_SAVE_DELAY_MS` */
  delayMs?: number
  timer?: Timer
}

export function createAutoSave(options: AutoSaveOptions): void {
  const ws = options.workspace
  const blocked = options.blocked ?? (() => false)
  const timer = options.timer ?? domTimer

  /** 写盘的串行尾巴：任意时刻最多一个自动写盘在飞，顺序与排进来的顺序一致 */
  let tail: Promise<void> = Promise.resolve()

  async function saveDirty(): Promise<void> {
    let deferred = false
    for (const tab of ws.tabs()) {
      const doc = tab.doc
      // 判据的顺序是有讲究的：先排除「压根不该碰的」，再判「现在不方便碰的」。
      // 反过来的话，一个只读分片会因为 `busy` 被记成 deferred，白转一圈
      if (!doc.dirty()) continue
      if (doc.path() === null) continue
      if (doc.shard() !== null) continue
      if (doc.lossy()) continue
      if (doc.edits() === 0) continue
      if (blocked(tab.id)) continue
      if (doc.busy()) {
        // 手动保存 / 打开 / 重载正在飞。这一轮跳过，但等它落定之后必须再来一次：
        // `writeTo` 现在会在「写盘期间又敲了字」时保留脏标记，而那一刻不会有新的
        // revision 变化来重新排期——不补这一次，那几个字要等到下一次按键才会落盘
        deferred = true
        continue
      }
      await doc.save()
    }
    if (deferred) debounced.schedule()
  }

  const debounced = createDebounced(timer, options.delayMs ?? AUTO_SAVE_DELAY_MS, () => {
    tail = tail.then(saveDirty)
  })

  createEffect(
    on(
      ws.revision,
      () => debounced.schedule(),
      // 建 effect 那一下的初跑没有意义：此时还没有任何文档，更没有人敲过字
      { defer: true },
    ),
  )

  // 窗口/组件没了之后那个回调还会跑 1.5s，而它要读的 workspace 已经没人管了
  onCleanup(() => debounced.cancel())
}
