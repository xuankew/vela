import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 前后端「线上契约」的前端快照，与 Rust 侧 `crates/vela-core/tests/wire_contract.rs` 的
 * `git_head_的线上形状` / `git_heads_清单里不是仓库的那一位是_null_而且留在原位` 一一对应。
 * 两边的 JSON 字面量必须同时改。
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { gitHeads, type GitHead } from './git'

/** 与 Rust 侧 `git_head_的线上形状` 里手搓的那两个 `GitHead` 逐字节相同 */
const GOLDEN_BRANCH = '{"name":"main","detached":false}'
const GOLDEN_DETACHED = '{"name":"6a1b2c3","detached":true}'

/**
 * 与 Rust 侧 `git_heads_清单里不是仓库的那一位是_null_而且留在原位` 逐字节相同。
 *
 * 🔴 这一条字面量里最要紧的是那两个 `null` 的**位置**：三个根里只有中间那个是仓库，
 * 而回来的清单仍然是三条。「滤掉 null」与「null 留在原位」在单根时看不出区别，
 * 在多根时是「每一格都对」与「每一格都在说别人的分支」的区别
 */
const GOLDEN_LIST = `[null,${GOLDEN_BRANCH},null]`

beforeEach(() => {
  invoke.mockReset()
})

describe('Rust → 前端 的字段名', () => {
  it('GitHead 是扁平的两键，布尔那个叫 detached 不是 isDetached', () => {
    const branch = JSON.parse(GOLDEN_BRANCH) as GitHead
    expect(JSON.stringify(branch)).toBe(GOLDEN_BRANCH)
    expect(Object.keys(branch)).toEqual(['name', 'detached'])

    // 写成 `isDetached` 的失败方式是**静默的**：前端读到 `undefined`，而 `undefined`
    // 是 falsy，于是游离 HEAD 一律被当成分支画出来，一句话都不报
    expect(branch.detached).toBe(false)
    expect((JSON.parse(GOLDEN_DETACHED) as GitHead).detached).toBe(true)
  })

  it('游离 HEAD 那一档的 name 装的是短 sha，字段名与分支那一档完全一样', () => {
    const detached = JSON.parse(GOLDEN_DETACHED) as GitHead
    expect(Object.keys(detached)).toEqual(['name', 'detached'])
    expect(detached.name).toBe('6a1b2c3')
  })

  it('不是仓库的那一位是 null（不是 undefined，也不是一个空对象）', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_LIST))

    const got = await gitHeads(['/plain', '/repo', '/plain/nope'])

    expect(got).toHaveLength(3)
    expect(got[0]).toBeNull()
    expect(got[2]).toBeNull()
    expect(got[1]).toEqual({ name: 'main', detached: false })
    // ⚠️ 与上面那条重复，但它钉的是**不同的错法**：拿 `=== undefined` 去筛的话
    // 这一位会被当成「有分支」，界面上就多出一个空格子
    expect(got[0]).not.toBeUndefined()
  })

  it('清单与递进去的根同长同序，中间那一位就是中间那个根的答案', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_LIST))

    const got = await gitHeads(['/plain', '/repo', '/plain/nope'])

    expect(got.map((head) => head?.name ?? null)).toEqual([null, 'main', null])
  })

  it('一个根都没有时回来一个空数组', async () => {
    invoke.mockResolvedValue([])

    expect(await gitHeads([])).toEqual([])
  })
})

describe('命令名与参数名', () => {
  it('发出去的是 git_heads，参数键是 roots', async () => {
    invoke.mockResolvedValue([])

    await gitHeads(['/a', '/b'])

    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('git_heads', { roots: ['/a', '/b'] })
  })

  it('🔴 roots 这个键不能省：Rust 侧是 Vec<String> 而不是 Option，缺 key 会直接反序列化失败', async () => {
    // 与 `project.ts` 的 `listDir` 同一条坑（那边的 `rel` 也是不能省的）。
    // 失败方式是 Tauri 报一句「invalid args `roots` for command `git_heads`」，
    // 而它出现在一次**没人 catch 的 promise** 里——这一格只会一直空着
    invoke.mockResolvedValue([])

    await gitHeads([])

    expect(invoke.mock.calls[0]?.[1]).toEqual({ roots: [] })
  })
})
