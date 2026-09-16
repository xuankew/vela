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

import {
  describeFsError,
  ENCODING_CHOICES,
  ENCODING_IDS,
  encodingChoiceId,
  LINE_ENDING_IDS,
  openFile,
  parseEncodingChoice,
  saveFile,
  type FileFormat,
  type TextFile,
  type WriteReport,
} from './fs'

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
  it('open_file 不覆写编码时把 encoding 显式传成 null', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_TEXT_FILE))
    await openFile('/tmp/a.txt')
    // ⚠️ 不能省掉这个 key：Tauri 对「参数缺失」与「参数为 null」的处理并不显然一致，
    // 而 `Option<Encoding>` 反序列化 null 恒为 None，传 null 就不用去赌前一种。
    // 对应 Rust 侧 wire_contract.rs 的「编码覆写参数用_null_表示走探测」
    expect(invoke).toHaveBeenCalledWith('open_file', { path: '/tmp/a.txt', encoding: null })
  })

  it('open_file 覆写编码时把 snake_case 的枚举值原样传下去', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_TEXT_FILE))
    await openFile('/tmp/a.txt', 'utf16_le')
    // 漏传或拼错的后果是静默的：Rust 那边收到 None，「以某编码重新打开」退化成
    // 「再探测一次」，用户看到的还是同一屏乱码，没有任何提示说刚才那下没生效
    expect(invoke).toHaveBeenCalledWith('open_file', { path: '/tmp/a.txt', encoding: 'utf16_le' })
  })

  it('save_file 的参数名与 Rust command 的形参一一对应', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_WRITE_REPORT))
    const format: FileFormat = { encoding: 'utf8', bom: false, eol: 'lf' }
    await saveFile('/tmp/a.txt', '正文', format)
    // Tauri 2 默认把 command 形参按 camelCase 暴露给 JS；这三个都是单词，两边同名
    expect(invoke).toHaveBeenCalledWith('save_file', { path: '/tmp/a.txt', text: '正文', format })
  })
})

describe('状态栏下拉用的编码组合表', () => {
  it('七个合法组合，GBK 只有不带 BOM 的那一种', () => {
    // Rust 侧 `Encoding::supports_bom` 排除了 gbk + bom：写了也没工具认，encode 还会忽略它。
    // UI 不提供不可能的组合，比提供了再在下游兜住要便宜
    expect(ENCODING_CHOICES.map((c) => encodingChoiceId(c))).toEqual([
      'utf8',
      'utf8-bom',
      'utf16_le',
      'utf16_le-bom',
      'utf16_be',
      'utf16_be-bom',
      'gbk',
    ])
    expect(ENCODING_CHOICES.find((c) => c.encoding === 'gbk')?.bom).toBe(false)
  })

  it('压成字符串再解回来，两个字段都不丢', () => {
    for (const choice of ENCODING_CHOICES) {
      expect(parseEncodingChoice(encodingChoiceId(choice))).toEqual({
        encoding: choice.encoding,
        bom: choice.bom,
      })
    }
    // 展示名带不带 BOM 是用户唯一能看出区别的地方
    expect(ENCODING_CHOICES.find((c) => c.encoding === 'utf16_be' && c.bom)?.label).toBe('UTF-16 BE BOM')
  })

  it('「重新打开」那一组只列四个编码：BOM 是从字节里读的，不由用户选', () => {
    expect(ENCODING_IDS).toEqual(['utf8', 'utf16_le', 'utf16_be', 'gbk'])
    expect(LINE_ENDING_IDS).toEqual(['lf', 'crlf'])
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
