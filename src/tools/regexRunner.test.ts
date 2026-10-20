import { describe, expect, it, vi } from 'vitest'
import type { Timer } from '../ui/timer'
import {
  createRegexRunner,
  REGEX_DEADLINE_MS,
  timeoutResult,
  type RegexJob,
  type SpawnRegexWorker,
} from './regexRunner'
import type { ToolResult } from './tool'

/**
 * `regexRunner` 的三件难事：**到点中断**、**换一次输入就掐掉上一次在飞的**、**worker 起不来时退回主线程**。
 *
 * 🔴 全部用**假的 `spawn` 与假的时钟**跑，⛔ 不碰真的 `Worker`：node 测试环境里它压根不存在，
 * 而这一层的难点没有一样与「worker 具体怎么起」有关——真的那一份只剩 `regexRunner.ts` 末尾那三行胶水。
 * 于是「灾难性回溯会不会真的把窗口冻死」这件事，靠的是这里能被穷举的状态机，不是运气。
 */

function job(input: string, pattern: string): RegexJob {
  return { input, pattern, flags: '', replacement: '', mode: 'list' }
}

/** 手动挡的时钟：`Timer` 是注入点，不必 `vi.useFakeTimers` */
function fakeTimer() {
  let next = 1
  const scheduled = new Map<number, () => void>()
  const timer: Timer = {
    after: (fn) => {
      const id = next++
      scheduled.set(id, fn)
      return id
    },
    cancel: (id) => {
      scheduled.delete(id)
    },
  }
  return {
    timer,
    pending: () => scheduled.size,
    fireAll() {
      for (const [, fn] of [...scheduled]) fn()
      scheduled.clear()
    },
  }
}

interface FakeWorker {
  readonly job: RegexJob
  settle: (result: ToolResult) => void
  terminated: boolean
}

/** 假 spawn：把每个 worker 记下来，让用例能手动 settle 它、并断言它有没有被 terminate */
function fakeSpawn(opts: { throwOnSpawn?: boolean } = {}) {
  const workers: FakeWorker[] = []
  const spawn: SpawnRegexWorker = (j, settle) => {
    if (opts.throwOnSpawn) throw new Error('这个环境没有 Web Worker')
    const worker: FakeWorker = { job: j, settle, terminated: false }
    workers.push(worker)
    return () => {
      worker.terminated = true
    }
  }
  return { spawn, workers }
}

describe('regexRunner — 正常出结果', () => {
  it('worker 交回结果时就交那一份，随后 terminate 掉它、取消掉截止时间', async () => {
    const clock = fakeTimer()
    const { spawn, workers } = fakeSpawn()
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })

    const pending = runner.run(job('a1b2', '\\d'))
    expect(clock.pending()).toBe(1) // 排了一个截止时间
    workers[0]!.settle({ kind: 'ok', text: '匹配 2 处' })

    await expect(pending).resolves.toEqual({ kind: 'ok', text: '匹配 2 处' })
    expect(workers[0]!.terminated).toBe(true)
    expect(clock.pending()).toBe(0) // 结果先到，截止时间被取消，不会晚点又炸一次
  })

  it('spawn 收到的是原样那一份 job', async () => {
    const clock = fakeTimer()
    const { spawn, workers } = fakeSpawn()
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })
    const j = job('xx', 'a+')
    const pending = runner.run(j)
    expect(workers[0]!.job).toBe(j)
    workers[0]!.settle({ kind: 'ok', text: '' })
    await pending
  })

  it('一次运行只结算一次：worker 迟到的第二条消息被忽略', async () => {
    const clock = fakeTimer()
    const { spawn, workers } = fakeSpawn()
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })
    const pending = runner.run(job('a', 'b'))
    workers[0]!.settle({ kind: 'ok', text: '第一' })
    workers[0]!.settle({ kind: 'ok', text: '第二' }) // terminate 之后挤进来的迟到消息
    await expect(pending).resolves.toEqual({ kind: 'ok', text: '第一' })
  })

  it('spawn 同步结算也认，且不留一个用不上的截止时间', async () => {
    const clock = fakeTimer()
    let terminated = false
    const spawn: SpawnRegexWorker = (_j, settle) => {
      settle({ kind: 'ok', text: '同步' })
      return () => {
        terminated = true
      }
    }
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })
    await expect(runner.run(job('a', 'b'))).resolves.toEqual({ kind: 'ok', text: '同步' })
    expect(clock.pending()).toBe(0)
    expect(terminated).toBe(true)
  })
})

describe('regexRunner — 到点中断（灾难性回溯那一条）', () => {
  it('worker 一直不出结果，到点就中断：报超时那一句并 terminate 掉 worker', async () => {
    const clock = fakeTimer()
    const { spawn, workers } = fakeSpawn()
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })

    const pending = runner.run(job('a'.repeat(30), '(a+)+$'))
    clock.fireAll() // 时间到

    const out = await pending
    expect(out.kind).toBe('error')
    expect(out.text).toContain('灾难性回溯')
    expect(out.text).toContain(`${REGEX_DEADLINE_MS}ms`)
    expect(workers[0]!.terminated).toBe(true) // 🔴 真的把那个核停掉了，不是任它烧到进程结束
  })

  it('自定义的 deadlineMs 会写进那一句', async () => {
    const clock = fakeTimer()
    const { spawn } = fakeSpawn()
    const runner = createRegexRunner({
      spawn,
      timer: clock.timer,
      deadlineMs: 500,
      fallback: () => ({ kind: 'error', text: 'fb' }),
    })
    const pending = runner.run(job('a', 'b'))
    clock.fireAll()
    expect((await pending).text).toContain('500ms')
  })

  it('中断之后 worker 迟到的结果被忽略（那一次已经结算过了）', async () => {
    const clock = fakeTimer()
    const { spawn, workers } = fakeSpawn()
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })
    const pending = runner.run(job('a', 'b'))
    clock.fireAll()
    const out = await pending
    expect(out.text).toContain('灾难性回溯')
    workers[0]!.settle({ kind: 'ok', text: '迟到' }) // terminate 之后才回来
    expect(out.text).toContain('灾难性回溯') // 拿到的那一份没有被改写
  })
})

describe('regexRunner — 取消与顶替', () => {
  it('cancel 掐掉在飞的那一次并 terminate worker', async () => {
    const clock = fakeTimer()
    const { spawn, workers } = fakeSpawn()
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })
    const pending = runner.run(job('a', 'b'))
    runner.cancel()
    await expect(pending).resolves.toMatchObject({ kind: 'error' })
    expect(workers[0]!.terminated).toBe(true)
    expect(clock.pending()).toBe(0)
  })

  it('没有在飞的时候 cancel 是空操作', () => {
    const clock = fakeTimer()
    const { spawn } = fakeSpawn()
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })
    expect(() => runner.cancel()).not.toThrow()
  })

  it('起下一次运行会顶掉上一次：上一次立刻结算、worker 被 terminate，不占着核跑到自己的 deadline', async () => {
    const clock = fakeTimer()
    const { spawn, workers } = fakeSpawn()
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback: () => ({ kind: 'error', text: 'fb' }) })

    const a = runner.run(job('a', 'x'))
    const b = runner.run(job('b', 'y'))

    await expect(a).resolves.toMatchObject({ kind: 'error' }) // 被取代
    expect(workers[0]!.terminated).toBe(true) // 🔴 上一个卡死的 worker 被停了，不是任它烧
    expect(workers[1]!.terminated).toBe(false) // 新的这个还在飞

    workers[1]!.settle({ kind: 'ok', text: 'B' })
    await expect(b).resolves.toEqual({ kind: 'ok', text: 'B' })
  })
})

describe('regexRunner — worker 起不来时退回主线程', () => {
  it('spawn 抛异常就走 fallback，如实交回它的结果，且不排截止时间', async () => {
    const clock = fakeTimer()
    const { spawn } = fakeSpawn({ throwOnSpawn: true })
    const fallback = vi.fn((j: RegexJob): ToolResult => ({ kind: 'ok', text: `fb:${j.pattern}` }))
    const runner = createRegexRunner({ spawn, timer: clock.timer, fallback })

    await expect(runner.run(job('abc', '\\d'))).resolves.toEqual({ kind: 'ok', text: 'fb:\\d' })
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(clock.pending()).toBe(0) // 同步跑完了，没有 worker 要盯，也就不需要 deadline
  })
})

describe('timeoutResult', () => {
  it('那句话里带着毫秒数与「灾难性回溯」，并给一个能做的动作', () => {
    const out = timeoutResult(2000)
    expect(out.kind).toBe('error')
    expect(out.text).toContain('2000ms')
    expect(out.text).toContain('灾难性回溯')
    expect(out.text).toContain('收紧')
  })
})
