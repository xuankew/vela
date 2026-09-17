/**
 * 长任务的取消（PLAN.md §2.6 约束 3 的后半句）。
 *
 * 搜索（M2-C）与全局替换（M2-D）在 Rust 侧共用**同一份** `TaskRegistry`，
 * 也共用**同一个** `cancel_task` 命令——所以这个封装不属于 `search.ts`
 * 也不属于 `replace.ts`。放在其中一个里的话，另一个就得反过来 import 它，
 * 而「替换模块依赖搜索模块」是一条没有道理的依赖。
 *
 * ## taskId 是谁发的
 *
 * `start_search` 发的是 `search-N`，`start_replace` 发的是 `replace-N`，
 * 两边的 N 来自**同一个**单调计数器，所以绝不重复。前缀只是让 id 在日志里可读，
 * `cancel_task` 不看它——路由靠的是 id 整体相等。
 *
 * ⚠️ 也就是说前端**不需要**、也**不应该**去解析这个前缀。
 * 「先看 id 以什么开头，再决定调哪个取消函数」那种写法会引入第二个真相来源，
 * 而 Rust 侧哪天改了前缀，失败方式是「点了取消，什么也没发生」。
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * 取消一个正在跑的任务（搜索或替换）。
 *
 * **幂等**：taskId 不认识也照样成功。「取消一个已经跑完的任务」是正常时序——
 * 点取消的那一刻后台线程可能刚好发完 done。所以这里不需要判返回值，也没有失败分支。
 *
 * ⚠️ **对替换而言，取消不是撤销。** 按下去的那一刻已经改完的文件**留在磁盘上**，
 * 随后的 `ReplaceSummary` 里 `cancelled` 为真、`filesChanged` 如实报出改了几个。
 * UI 必须把那个数字说出来：「已取消，改动了 37 个文件」与「已取消」是两句话，
 * 少说后半句的话用户会以为什么都没发生。
 *
 * ⚠️ Rust 侧形参是 `task_id: String`，Tauri 2 在命令边界上转成驼峰，所以这里写 `taskId`。
 * 写成 `task_id` 的失败方式是一句「invalid args `taskId` for command `cancel_task`」——
 * 那句报错说的是**它要的**名字，读的人却往往以为是自己传错了值。
 * 这是本项目第二个多单词命令参数（第一个是 `rename_entry` 的 `newName`）
 */
export function cancelTask(taskId: string): Promise<void> {
  return invoke<void>('cancel_task', { taskId })
}
