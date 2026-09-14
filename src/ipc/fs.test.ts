import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 前后端「线上契约」的前端快照。
 *
 * 与 Rust 侧 `crates/vela-core/tests/wire_contract.rs` 一一对应，两边的 JSON 字面量必须
 * 同时改。这里钉的是**前端实际使用的字段名**：`invoke` 拿到的是纯 JSON，字段名写错
 * 只会得到 `undefined`，不报错、不抛异常，是最难查的一类 bug。
 */

// `vi.hoisted` 是必需的：vitest 会把 `vi.mock` 提到文件最上面，而 mock 工厂在被 mock
// 模块首次 import 时就会执行——那时普通 `const` 还处在 TDZ 里。
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { describeFsError, openFile, saveFile, type FileFormat, type TextFile, type WriteReport } from './fs'

// 与 Rust 侧 text_file_的线上形状 用的是同一个文件（GBK + CRLF + 「第一行\n第二行\n」）
const GOLDEN_TEXT_FILE =
  '{"text":"第一行\\n第二行\\n","format":{"encoding":"gbk","bom":false,"eol":"crlf"},"lossy":false,"bytes":16}'
const GOLDEN_WRITE_REPORT = '{"bytesWritten":1,"unmappable":false}'

beforeEach(() => {
  invoke.mockReset()
})

describe('Rust → 前端 的字段名', () => {
  it('TextFile 的字段名与顺序与 Rust 侧序列化结果一致', () => {
    const parsed = JSON.parse(GOLDEN_TEXT_FILE) as TextFile
    // 键顺序就是 JSON.parse 的插入顺序，所以 stringify 相等 == 字段集合与顺序都相等
    expect(JSON.stringify(parsed)).toBe(GOLDEN_TEXT_FILE)
    expect(Object.keys(parsed)).toEqual(['text', 'format', 'lossy', 'bytes'])
    expect(Object.keys(parsed.format)).toEqual(['encoding', 'bom', 'eol'])
    // 枚举值是 snake_case，不是 camelCase（utf16_le 而非 utf16Le）
    expect(parsed.format.encoding).toBe('gbk')
    expect(parsed.format.eol).toBe('crlf')
  })

  it('WriteReport 的字段名是 camelCase', () => {
    const parsed = JSON.parse(GOLDEN_WRITE_REPORT) as WriteReport
    expect(JSON.stringify(parsed)).toBe(GOLDEN_WRITE_REPORT)
    expect(Object.keys(parsed)).toEqual(['bytesWritten', 'unmappable'])
  })

  it('四种编码与两种行尾的线上值都能被前端的类型接住', () => {
    // 这条钉的是「枚举值清单」这份契约本身：Rust 侧加一个变体而前端没跟上，
    // 这里的穷举就会少一个，读代码的人能立刻看出两边不同步
    const seen = new Set<string>()
    for (const encoding of ['utf8', 'utf16_le', 'utf16_be', 'gbk'] as const) {
      for (const eol of ['lf', 'crlf'] as const) {
        const format: FileFormat = { encoding, bom: false, eol }
        seen.add(JSON.stringify(format))
      }
    }
    expect(seen.size).toBe(8)
    expect([...seen]).toContain('{"encoding":"utf16_be","bom":false,"eol":"crlf"}')
  })
})

describe('前端 → Rust 的 command 名与参数名', () => {
  it('open_file 只收一个 path', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_TEXT_FILE))
    await openFile('/tmp/a.txt')
    expect(invoke).toHaveBeenCalledWith('open_file', { path: '/tmp/a.txt' })
  })

  it('save_file 的参数名与 Rust command 的形参一一对应', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_WRITE_REPORT))
    const format: FileFormat = { encoding: 'utf8', bom: false, eol: 'lf' }
    await saveFile('/tmp/a.txt', '正文', format)
    // Tauri 2 默认把 command 形参按 camelCase 暴露给 JS；这三个都是单词，两边同名
    expect(invoke).toHaveBeenCalledWith('save_file', { path: '/tmp/a.txt', text: '正文', format })
  })
})

describe('错误落地成人能读的话', () => {
  it('too_large 报出两个字节数并指向 M2', () => {
    const msg = describeFsError({ kind: 'too_large', bytes: 5_000_000, limit: 4_194_304 })
    expect(msg).toContain('4.8 MB')
    expect(msg).toContain('4 MB')
    expect(msg).toContain('M2')
  })

  it('directory / no_parent 带上路径', () => {
    expect(describeFsError({ kind: 'directory', path: '/a/b' })).toContain('/a/b')
    expect(describeFsError({ kind: 'no_parent', path: 'bare.txt' })).toContain('bare.txt')
  })

  it('io 直接用 Rust 侧给的 message', () => {
    expect(describeFsError({ kind: 'io', reason: 'NotFound', message: '没这个文件' })).toBe('没这个文件')
  })

  it('Rust 侧将来加了变体而前端没跟上时，不会抛', () => {
    expect(describeFsError({ kind: 'brand_new_variant' } as unknown)).toBe('[object Object]')
  })

  it('不是 IPC 错误时退回 Error / 字符串', () => {
    expect(describeFsError(new Error('网络断了'))).toBe('网络断了')
    expect(describeFsError('字符串错误')).toBe('字符串错误')
    expect(describeFsError(null)).toBe('null')
  })
})
