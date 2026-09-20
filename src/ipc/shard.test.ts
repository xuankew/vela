import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 前后端「线上契约」的前端快照——大文件只读分片那一半（M2-H）。
 *
 * Rust 侧的对照分三处，三处的字面量必须同时改：
 *
 * - `crates/vela-core/src/fs/shard.rs` 的 `元信息的线上形状` 与 `不支持编码的错误也在线上形状里`
 * - `crates/vela-core/tests/wire_contract.rs` 的 `分片元信息与分页的线上形状`
 *   与 `分片接不住的编码在契约上有其名`（那一节跑**真的** `open_shard`）
 * - `src-tauri/src/shard.rs` 的 `线上形状`（`{ handle, header }` 那层信封，
 *   以及 `read_lines` 的 `Option` → `null`）
 *
 * ⚠️ 这一份比 `watch.test.ts` 多钉一层：参数的**键名与键序**。
 * 那边只有一个 `paths`，写错名字会当场 reject；这边 `read_lines` 三个参数里有两个是同类型整数，
 * 交换之后可能碰巧命中另一个句柄。见下面「参数名写反是安静的」那一组。
 */

/**
 * ⚠️ mock 写了完整的函数签名，不是裸 `vi.fn()`。
 * 裸的话 `.mock.calls` 的元素是 `any`，于是每一处取值都是一次 unsafe member access——
 * `pnpm lint` 是门禁的一部分，这里过不了就提交不了。
 */
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { closeLarge, openLarge, readLines, type ShardHeader, type ShardOpen, type ShardPage } from './shard'
import { describeFsError, type ReadError } from './fs'

// ───────────────────────── 黄金字面量 ─────────────────────────
// 每一条都与 Rust 侧某个 assert_eq! 里的字符串逐字节相同

/** 对照 `元信息的线上形状`（vela-core）与 `线上形状`（src-tauri）的 header 部分 */
const GOLDEN_HEADER = '{"totalLines":12,"bytes":34,"encoding":"gbk","bom":true,"eol":"crlf","lossy":false}'
/** 对照 src-tauri 的 `线上形状`：`{ handle, header }` 这层信封只在这一侧存在 */
const GOLDEN_OPEN = `{"handle":7,"header":${GOLDEN_HEADER}}`
/** 对照 `元信息的线上形状` 与 `线上形状` 的 page 部分 */
const GOLDEN_PAGE = '{"start":3,"lines":["a","b"],"truncated":true,"lossy":true}'
/** 对照 src-tauri 的 `线上形状` 最后一行：`Option::None` 在线上就是一个 `null` */
const GOLDEN_NO_PAGE = 'null'
/** 对照 `不支持编码的错误也在线上形状里` */
const GOLDEN_UNSUPPORTED = '{"kind":"unsupported_encoding","encoding":"utf16_le","bytes":99}'

beforeEach(() => {
  invoke.mockReset()
})

/** 第 n 次 `invoke` 收到的参数对象。把「可选入参 + `noUncheckedIndexedAccess`」收在一处 */
function sentArgs(call = 0): Record<string, unknown> {
  const args = invoke.mock.calls[call]?.[1]
  if (!args) throw new Error(`第 ${call} 次 invoke 没有带参数对象`)
  return args
}

describe('Rust → 前端 的字段名', () => {
  it('⚠️ ShardHeader 的六个字段名与顺序与 Rust 侧一致', () => {
    const parsed = JSON.parse(GOLDEN_HEADER) as ShardHeader
    // 键顺序就是 JSON.parse 的插入顺序，所以 stringify 相等 == 字段集合与顺序都相等
    expect(JSON.stringify(parsed)).toBe(GOLDEN_HEADER)
    expect(Object.keys(parsed)).toEqual(['totalLines', 'bytes', 'encoding', 'bom', 'eol', 'lossy'])
    expect(parsed.encoding).toBe('gbk')
    expect(parsed.eol).toBe('crlf')
  })

  it('🔴 ShardHeader 里**没有** format，也没有能拼出一个 format 的字段', () => {
    // 这一条钉的是「分片模式永远不写盘」在类型上成立。
    // 有 `format` 的话，前端就能拿它去调 `saveFile`——而分片视图压根没有完整正文，
    // 保存下来的会是**当前这一页**，也就是把用户一个 200 MB 的日志截成 1 MiB。
    // 那是这个功能能造成的唯一一次不可逆损失，所以要在契约这一层就堵掉
    const keys = Object.keys(JSON.parse(GOLDEN_HEADER) as ShardHeader)
    expect(keys).not.toContain('format')
    expect(keys).not.toContain('text')
  })

  it('⚠️ ShardOpen 是 `{ handle, header }`，header 摊在里面而不是并列', () => {
    const parsed = JSON.parse(GOLDEN_OPEN) as ShardOpen
    expect(JSON.stringify(parsed)).toBe(GOLDEN_OPEN)
    expect(Object.keys(parsed)).toEqual(['handle', 'header'])
    // 句柄与元信息必须在**同一条返回值**里：分成两条命令的话，
    // 前端就得在两步之间存一个没有 totalLines 的状态，
    // 而 totalLines 正是滚动条高度的依据——缺它的那一帧只能画一个错的滚动条再跳一下
    expect(parsed.handle).toBe(7)
    expect(parsed.header.totalLines).toBe(12)
  })

  it('⚠️ ShardPage 的四个字段名与顺序与 Rust 侧一致', () => {
    const parsed = JSON.parse(GOLDEN_PAGE) as ShardPage
    expect(JSON.stringify(parsed)).toBe(GOLDEN_PAGE)
    expect(Object.keys(parsed)).toEqual(['start', 'lines', 'truncated', 'lossy'])
    expect(parsed.lines).toEqual(['a', 'b'])
  })

  it('🔴 truncated 与 lossy 是两个字段，不是压成一个 status 字符串', () => {
    // 它俩说的是一件完全不同的事，UI 的反应也完全不同：
    // `truncated` = 「这一行太长，给的是半截」→ 就地说一句；
    // `lossy` = 「这个编码解不干净，正文里有 U+FFFD」→ 整个文档的警告。
    // 压成一个字符串的话前端要靠子串匹配去分支，而那正是 `fs.ts` 开头骂的那种代码
    const parsed = JSON.parse(GOLDEN_PAGE) as ShardPage
    expect(typeof parsed.truncated).toBe('boolean')
    expect(typeof parsed.lossy).toBe('boolean')
    expect(parsed.truncated).toBe(true)
    expect(parsed.lossy).toBe(true)
  })
})

describe('命令名与参数名', () => {
  it('open_large 只收一个 path', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_OPEN))
    const opened = await openLarge('/repo/huge.log')

    expect(invoke.mock.calls[0]?.[0]).toBe('open_large')
    expect(sentArgs()).toEqual({ path: '/repo/huge.log' })
    // 返回值原样透传，不补默认值、不改字段名
    expect(JSON.stringify(opened)).toBe(GOLDEN_OPEN)
  })

  it('⚠️ open_large 的路径**原样**递过去，一个字符都不动', async () => {
    // 与 `setWatched` 同一条理由：Rust 侧拿它去 `open_shard`，
    // 而 `vela://file-changed` 事件里回来的也是原样字符串。
    // 前端先 normalize 一遍的话，两边就对不上了——而断掉的失败方式是彻底静默
    invoke.mockResolvedValue(JSON.parse(GOLDEN_OPEN))
    const paths = ['/tmp/a.log', '/repo/./b.log', '/repo/ünïcode.log']
    for (const path of paths) await openLarge(path)

    expect(invoke.mock.calls.map((c) => (c[1] as { path: string }).path)).toEqual(paths)
  })

  it('🔴 read_lines 的三个参数名逐个对上：handle / start / count', async () => {
    // 这一条钉的是本模块**最安静的失败方式**。
    // `start` 写成 `from` 的话 Rust 那边 `serde` 拿到的是缺失 → 而 Tauri 对缺参数的
    // 处理是当场 reject，还算吵；真正安静的是**两个参数交换**：
    // `handle` 与 `start` 都是整数，交换之后要么句柄不存在（回来 null，视图空白），
    // 要么碰巧存在——于是把另一个文件的行号当句柄用，读出的是**别人的正文**。
    // 所以 `readLines` 收的是一个对象而不是三个位置参数：交换在语法上就写不出来
    invoke.mockResolvedValue(JSON.parse(GOLDEN_PAGE))
    const page = await readLines({ handle: 7, start: 3, count: 2 })

    expect(invoke.mock.calls[0]?.[0]).toBe('read_lines')
    expect(sentArgs()).toEqual({ handle: 7, start: 3, count: 2 })
    expect(Object.keys(sentArgs())).toEqual(['handle', 'start', 'count'])
    expect(JSON.stringify(page)).toBe(GOLDEN_PAGE)
  })

  it('close_large 只收一个 handle', async () => {
    invoke.mockResolvedValue(null)
    await closeLarge(7)

    expect(invoke.mock.calls[0]?.[0]).toBe('close_large')
    expect(sentArgs()).toEqual({ handle: 7 })
  })

  it('⚠️ 三个命令名互不相同，也不同于 open_file', async () => {
    // `open_large` 与 `open_file` 只差一个词。叫错的话失败方式是
    // 「大文件仍然报 4 MB 上限」——而那条文案在 M2-H 之后已经改成不指向里程碑了，
    // 于是用户看到的是一句没有任何线索的「打不开」
    invoke.mockResolvedValue(null)
    await openLarge('/a')
    await readLines({ handle: 1, start: 0, count: 1 })
    await closeLarge(1)

    const names = invoke.mock.calls.map((c) => c[0])
    expect(names).toEqual(['open_large', 'read_lines', 'close_large'])
    expect(new Set(names).size).toBe(3)
  })
})

describe('read_lines 的 null 分支', () => {
  it('🔴 句柄已关时回来的是 null，**不是** reject', async () => {
    // 这是一个每天都会发生的时序：用户滚动 → 请求发出 → 用户关掉标签 →
    // `closeLarge` 先到 → 请求回来时句柄没了。
    // 报成 reject 的话前端会在「用户自己关了个标签」之后弹一条红色提示，
    // 而那条提示说的还是一个用户从来没听说过的句柄号
    invoke.mockResolvedValue(JSON.parse(GOLDEN_NO_PAGE))
    const page = await readLines({ handle: 9999, start: 0, count: 50 })

    expect(page).toBeNull()
    // 契约字面量也要钉：线上就是一个 `null`，不是 `undefined`、不是 `{}`。
    // 对照 src-tauri 的 `serde_json::to_string(&None::<ShardPage>)`
    expect(GOLDEN_NO_PAGE).toBe('null')
  })

  it('⚠️ 空文件回来的是「有页但零行」，与 null 不是一回事', async () => {
    // 两者在 UI 上要分开说：`null` = 别再请求了；零行 = 这个文件真的是空的。
    // 混成一个的话，一个空文件会被画成「读不到」，而用户会去检查权限
    invoke.mockResolvedValue(JSON.parse('{"start":0,"lines":[],"truncated":false,"lossy":false}'))
    const page = await readLines({ handle: 1, start: 0, count: 50 })

    expect(page).not.toBeNull()
    expect(page?.lines).toEqual([])
    expect(page?.start).toBe(0)
  })
})

describe('分片独有的那两个错误 kind', () => {
  it('🔴 unsupported_encoding 能被 fs.ts 的 ReadError 接住并说成人话', () => {
    // 这一条把两侧缝在一起：黄金字面量来自 Rust 的 `ReadError`，
    // 而断言用的是 `fs.ts` 的 `describeFsError`。少这一条的话，
    // 「fs.ts 的 union 里有没有这个 arm」就只由 TypeScript 在编译期看着，
    // 而 `describeFsError` 那个 `default` 分支会把漏掉的变体悄悄吞成 `[object Object]`
    const err = JSON.parse(GOLDEN_UNSUPPORTED) as ReadError
    expect(err.kind).toBe('unsupported_encoding')

    const msg = describeFsError(err)
    expect(msg).toContain('UTF-16 LE')
    expect(msg).toContain('分片模式不支持')
  })

  it('⚠️ too_large 的 limit 是原样透传的，前端不写死任何上限', () => {
    // `open_file` 的 4 MiB 与 `open_large` 的 256 MiB 走的是**同一个** kind，
    // 区分它们的只有 `limit` 那个数。前端硬编码 256 的话，
    // Rust 侧改一次上限就得记得改前端——而忘记的失败方式是文案里那个数字是错的，
    // 用户照着它去判断「我这个文件行不行」
    const msg = describeFsError({ kind: 'too_large', bytes: 300 * 1048576, limit: 268435456 })
    expect(msg).toContain('300.0 MB')
    expect(msg).toContain('256 MB')
  })
})
