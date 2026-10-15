/**
 * 状态栏右下角那一格「当前分支」的全部前端接口。
 *
 * Rust 侧只读 `.git/HEAD`（`crates/vela-core/src/project/git.rs`），不跑 `git` 也不链
 * libgit2——所以这一格**只知道 HEAD 指向哪儿**：不知道工作区脏不脏、不知道领先落后
 * 几个提交。取舍的理由写在那个模块的文件头，这里只留一句结论：想加 `*` / `↑2` 那种
 * 记号，先决定去哪儿读对象库与 index，别在这个文件里加。
 *
 * ⚠️ 类型是手写的，两边没有代码生成（与 `fs.ts` / `project.ts` 同一条处境）。
 * 两份对照的黄金 JSON：Rust 侧 `crates/vela-core/tests/wire_contract.rs` 的
 * `git_head_的线上形状` 与 `git_heads_清单里不是仓库的那一位是_null_而且留在原位`，
 * 前端 `src/ipc/git.test.ts`。
 */

import { invoke } from '@tauri-apps/api/core'

/** Rust `project::GitHead`，`#[serde(rename_all = "camelCase")]` */
export interface GitHead {
  /**
   * `detached` 为假时是**分支名**（`main`，ref 前缀已经剥掉），为真时是**短 sha**（`6a1b2c3`）。
   * 🔴 同一个字段装两种东西，所以显示之前必须看 `detached`：把短 sha 画成
   * `分支 6a1b2c3` 是一句假话——用户会照着这一格去理解「我的提交会落到哪儿」。
   */
  name: string
  /** 游离 HEAD（`git checkout <sha>` / rebase 中途 / `worktree --detach`） */
  detached: boolean
}

/**
 * 逐个根读一次 HEAD，回一份**与 `roots` 同长同序**的清单。
 *
 * 🔴 `null` **留在原位**，不是被滤掉：`out[i]` 说的就是 `roots[i]`，`null` = 那一个根
 * 没有可报的分支（不是仓库 / HEAD 读不动 / 内容认不出来）。滤掉的话多根工作区里
 * 后一个根的分支会被挂到前一个根的名字上——每一格都长得对，只是说的是别人的分支。
 *
 * ⚠️ 是 `null` 而不是 `undefined`：Rust 的 `Option` 在线上就是 JSON `null`。
 * 拿 `=== undefined` 去判的话那一位会被当成「有分支」，显示成一个空格子。
 *
 * ⚠️ **不 reject。** 这条命令没有错误通道（理由在 Rust 侧那个模块的文件头最后一段）：
 * 这一格是装饰，读不到就该什么都不显示，而「permission denied」对一个只想知道自己在
 * 哪个分支上的人没有任何可做的动作。所以调用方**不需要** `try`/`catch`，
 * 但也别指望它能报出问题——它压根不会。
 *
 * 成本是每个根读一个几十字节的文本文件，所以「窗口每次重新获得焦点就重读一遍」是
 * 付得起的（对比：跑一次 `git rev-parse` 是一个子进程，几十毫秒起）。
 */
export function gitHeads(roots: readonly string[]): Promise<(GitHead | null)[]> {
  return invoke<(GitHead | null)[]>('git_heads', { roots })
}
