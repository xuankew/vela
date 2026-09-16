import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 前后端「会话契约」的前端快照。
 *
 * 与 Rust 侧 `crates/vela-core/tests/wire_contract.rs` 的 M1-F 那一段一一对应，
 * 两边的 JSON 字面量必须同时改。这里钉的是**前端实际使用的字段名**：`invoke` 拿到的是
 * 纯 JSON，字段名写错只会得到 `undefined`——不报错、不抛异常，表现是「重启后什么都没
 * 恢复」，用户只会觉得这功能没做。
 */

// `vi.hoisted` 是必需的：vitest 会把 `vi.mock` 提到文件最上面，而 mock 工厂在被 mock
// 模块首次 import 时就会执行——那时普通 `const` 还处在 TDZ 里。
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  describeSessionError,
  loadSession,
  MAX_SESSION_TABS,
  saveSession,
  SESSION_VERSION,
  type PaneDirectionId,
  type Session,
  type SessionReport,
  type SessionTab,
} from './session'

/**
 * Rust 侧 `session_的线上形状` 断言的就是这个字面量，逐字符相同。
 * 样本刻意一次覆盖：带路径的干净标签、未命名的脏标签、**非默认编码 + lossy**、
 * 多光标、非零滚动、column 方向。
 */
const GOLDEN_SESSION =
  '{"version":1,"direction":"column","focused":1,"tabs":[{"path":"/tmp/a.txt","format":{"encoding":"utf8","bom":false,"eol":"lf"},"dirty":false,"lossy":false,"draft":null,"selection":[[0,0]],"main":0,"scrollTop":0.0,"scrollLeft":0.0},{"path":null,"format":{"encoding":"gbk","bom":false,"eol":"crlf"},"dirty":true,"lossy":true,"draft":"未保存\\n草稿","selection":[[0,3],[4,4]],"main":1,"scrollTop":120.5,"scrollLeft":0.0}],"panes":[0,1]}'

/**
 * 同一份数据在 `JSON.stringify` 之后的样子。与上面**只差三处**：`0.0` 变成 `0`。
 *
 * 这不是漂移。Rust 的 `f64` 永远带小数点，JS 的 number 没有「带小数点的零」，
 * 而 `0.0` 与 `0` 是同一个 JSON number，两边解析结果完全一致。
 * 把两个字面量并排放在这里，是为了让这点差异**看得见**，而不是让人对着两个文件犯嘀咕。
 */
const GOLDEN_SESSION_JS =
  '{"version":1,"direction":"column","focused":1,"tabs":[{"path":"/tmp/a.txt","format":{"encoding":"utf8","bom":false,"eol":"lf"},"dirty":false,"lossy":false,"draft":null,"selection":[[0,0]],"main":0,"scrollTop":0,"scrollLeft":0},{"path":null,"format":{"encoding":"gbk","bom":false,"eol":"crlf"},"dirty":true,"lossy":true,"draft":"未保存\\n草稿","selection":[[0,3],[4,4]],"main":1,"scrollTop":120.5,"scrollLeft":0}],"panes":[0,1]}'

/** 437 = GOLDEN_SESSION 的 UTF-8 字节数（不是字符数，中文占 3 字节），下面有用例钉住这条关系 */
const GOLDEN_REPORT = '{"bytesWritten":437,"droppedDrafts":0}'

/** 与 GOLDEN_SESSION 语义相同的对象字面量，用来做 deep-equal 与「前端能不能造出来」的检查 */
function sampleSession(): Session {
  return {
    version: SESSION_VERSION,
    direction: 'column',
    focused: 1,
    tabs: [
      {
        path: '/tmp/a.txt',
        format: { encoding: 'utf8', bom: false, eol: 'lf' },
        dirty: false,
        lossy: false,
        draft: null,
        selection: [[0, 0]],
        main: 0,
        scrollTop: 0,
        scrollLeft: 0,
      },
      {
        path: null,
        // 未命名文档也带格式，而且是非默认的：这个决定只能存在会话里
        format: { encoding: 'gbk', bom: false, eol: 'crlf' },
        dirty: true,
        lossy: true,
        draft: '未保存\n草稿',
        selection: [
          [0, 3],
          [4, 4],
        ],
        main: 1,
        scrollTop: 120.5,
        scrollLeft: 0,
      },
    ],
    panes: [0, 1],
  }
}

beforeEach(() => {
  invoke.mockReset()
})

describe('Rust → 前端 的字段名', () => {
  it('Session 与 SessionTab 的字段名与顺序与 Rust 侧序列化结果一致', () => {
    const parsed = JSON.parse(GOLDEN_SESSION) as Session
    // 键顺序就是 JSON.parse 的插入顺序，所以 stringify 相等 == 字段集合与顺序都相等
    expect(JSON.stringify(parsed)).toBe(GOLDEN_SESSION_JS)
    expect(Object.keys(parsed)).toEqual(['version', 'direction', 'focused', 'tabs', 'panes'])
    expect(Object.keys(parsed.tabs[0]!)).toEqual([
      'path',
      'format',
      'dirty',
      'lossy',
      'draft',
      'selection',
      'main',
      'scrollTop',
      'scrollLeft',
    ])
    // format 复用 fs 的契约，嵌套字段名也必须对
    expect(Object.keys(parsed.tabs[0]!.format)).toEqual(['encoding', 'bom', 'eol'])
  })

  it('解析出来的值与前端能造出来的对象完全相等', () => {
    expect(JSON.parse(GOLDEN_SESSION)).toEqual(sampleSession())
    expect(JSON.stringify(sampleSession())).toBe(GOLDEN_SESSION_JS)
  })

  it('direction 是 snake_case 枚举，与 workspace 的字面量同名', () => {
    const parsed = JSON.parse(GOLDEN_SESSION) as Session
    expect(parsed.direction).toBe('column')
    const directions: PaneDirectionId[] = ['row', 'column']
    expect(directions).toContain(parsed.direction)
  })

  it('selection 是嵌套数组，每项两个数（anchor, head）', () => {
    const parsed = JSON.parse(GOLDEN_SESSION) as Session
    expect(parsed.tabs[1]!.selection).toEqual([
      [0, 3],
      [4, 4],
    ])
    for (const range of parsed.tabs[1]!.selection) {
      expect(range).toHaveLength(2)
      expect(range.every((n) => Number.isInteger(n))).toBe(true)
    }
  })

  it('f64 的 0.0 与 JS 的 0 是同一个数，不是漂移', () => {
    expect(JSON.parse('{"scrollTop":0.0}')).toEqual({ scrollTop: 0 })
    expect(JSON.stringify({ scrollTop: 0 })).toBe('{"scrollTop":0}')
    expect(JSON.parse(GOLDEN_SESSION).tabs[0].scrollTop).toBe(0)
    // 小数照常往返
    expect(JSON.parse(GOLDEN_SESSION).tabs[1].scrollTop).toBe(120.5)
  })

  it('SessionReport 的字段名是 camelCase', () => {
    const parsed = JSON.parse(GOLDEN_REPORT) as SessionReport
    expect(JSON.stringify(parsed)).toBe(GOLDEN_REPORT)
    expect(Object.keys(parsed)).toEqual(['bytesWritten', 'droppedDrafts'])
    // bytesWritten 是**存档的 UTF-8 字节数**，不是字符数。由黄金会话现算出来，
    // 于是改了 GOLDEN_SESSION 却忘了改 GOLDEN_REPORT 会当场红，而不是留一个悄悄失真的数字
    expect(parsed.bytesWritten).toBe(new TextEncoder().encode(GOLDEN_SESSION).length)
  })

  it('版本号与标签上限与 Rust 侧同值', () => {
    // SESSION_VERSION 对不上时 Rust 会整份作废存档，所以这两个数字是契约的一部分
    expect(SESSION_VERSION).toBe(1)
    expect(JSON.parse(GOLDEN_SESSION).version).toBe(SESSION_VERSION)
    // 64 个标签的元信息最多几十 KB，离 4MB 的 IPC 上限有两个数量级——
    // 这是「丢草稿一定能把体积压下来」这条路走得通的前提
    expect(MAX_SESSION_TABS).toBe(64)
  })
})

describe('前端 → Rust 的 command 名与参数名', () => {
  it('load_session 不需要参数：路径由 Rust 侧从 app_data_dir() 算', async () => {
    invoke.mockResolvedValue(null)
    expect(await loadSession()).toBeNull()
    // ⚠️ 这里没有 path 参数是有意的：给了前端传路径的入口，就等于多一个「写任意路径」的原语
    expect(invoke).toHaveBeenCalledWith('load_session')
  })

  it('save_session 的参数名是 session，不是 sessionData', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_REPORT))
    const session = sampleSession()
    await saveSession(session)
    // Tauri 2 默认把 command 形参按 camelCase 暴露给 JS。Rust 侧形参就叫 `session`，
    // 单词没有下划线，所以两边同名——这也是当初没叫 `session_data` 的原因
    expect(invoke).toHaveBeenCalledWith('save_session', { session })
  })

  it('存档存在时 loadSession 原样返回', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_SESSION))
    expect(await loadSession()).toEqual(sampleSession())
  })
})

describe('可空字段必须显式是 null', () => {
  it('null 保得住 key，undefined 会让 key 整个消失', () => {
    // serde 对「key 缺失」与「null」的处理并不显然一致（Option<T> 缺失恰好也是 None，
    // 但那是实现细节）。类型写成 `| null` 而不是可选属性，就是为了让 TS 在这件事上帮忙。
    // 眼下可空的只剩 path 与 draft：format 与 lossy 都改成了必填，缺一个 Rust 就整份拒——
    // 缺 lossy 会被当成 false，等于把一个「原样保存会损坏文件」的文档恢复成安全的
    const tab: SessionTab = {
      path: null,
      format: { encoding: 'utf8', bom: false, eol: 'lf' },
      dirty: false,
      lossy: false,
      draft: null,
      selection: [[0, 0]],
      main: 0,
      scrollTop: 0,
      scrollLeft: 0,
    }
    expect(JSON.stringify(tab)).toBe(
      '{"path":null,"format":{"encoding":"utf8","bom":false,"eol":"lf"},"dirty":false,"lossy":false,"draft":null,"selection":[[0,0]],"main":0,"scrollTop":0,"scrollLeft":0}',
    )

    const withUndefined = { ...tab, path: undefined } as unknown as SessionTab
    expect(JSON.stringify(withUndefined)).not.toContain('"path"')
  })
})

describe('错误落地成人能读的话', () => {
  it('corrupt 说的是「上次的会话没能读回来」，不是抛 Rust 的原始报错', () => {
    const msg = describeSessionError({ kind: 'corrupt', message: 'panes[0]=3 越界' })
    expect(msg).toContain('上次的会话没能读回来')
    expect(msg).toContain('panes[0]=3')
  })

  it('version 把两个版本号都报出来', () => {
    const msg = describeSessionError({ kind: 'version', found: 2, expected: 1 })
    expect(msg).toContain('版本 2')
    expect(msg).toContain('（1）')
  })

  it('too_large 报出两个字节数', () => {
    const msg = describeSessionError({ kind: 'too_large', bytes: 5_000_000, limit: 4_194_304 })
    expect(msg).toContain('4.8 MB')
    expect(msg).toContain('4 MB')
  })

  it('no_parent 带上路径，io 直接用 Rust 给的 message', () => {
    expect(describeSessionError({ kind: 'no_parent', path: 'session.json' })).toContain('session.json')
    expect(describeSessionError({ kind: 'io', reason: 'NotFound', message: '目录没了' })).toBe('目录没了')
  })

  it('Rust 侧将来加了变体而前端没跟上时，不会抛', () => {
    expect(describeSessionError({ kind: 'brand_new_variant' } as unknown)).toBe('[object Object]')
  })

  it('不是 IPC 错误时退回 Error / 字符串', () => {
    expect(describeSessionError(new Error('拿不到应用数据目录'))).toBe('拿不到应用数据目录')
    expect(describeSessionError('字符串错误')).toBe('字符串错误')
    expect(describeSessionError(null)).toBe('null')
  })
})
