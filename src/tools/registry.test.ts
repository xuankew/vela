import { beforeEach, describe, expect, it } from 'vitest'
import { createCommandRegistry, type CommandRegistry } from '../commands/registry'
import { installTools, type ToolHost } from './registry'
import type { ToolDefinition } from './tool'

/**
 * 命令注册表用的是**真的那一份**，不是替身。
 *
 * 🔴 这一层的价值全在「工具真的进了那个注册表」，所以「进没进」必须问它本人：
 * 用一个假的 `register` 的话，`id` 过不过 `ID_RE`、分类是不是 `string`、`run` 的签名对不对，
 * 三件事一件都验不到，而那三件正是这一层唯一可能写错的地方
 */
function commands(): CommandRegistry {
  return createCommandRegistry({ getContext: () => ({ editor: null }) })
}

function def(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: 'tool.json.format',
    name: 'JSON 格式化',
    category: 'format',
    input: 'text',
    side: 'js',
    run: () => ({ kind: 'ok', text: '' }),
    ...overrides,
  }
}

function host(): ToolHost & { opened: string[] } {
  const opened: string[] = []
  return { opened, openTool: (id) => void opened.push(id) }
}

let registry: CommandRegistry
let tools: ToolHost & { opened: string[] }

beforeEach(() => {
  registry = commands()
  tools = host()
})

describe('投影成命令', () => {
  it('一个工具一条命令，标题是名字、分类是中文的「工具」', () => {
    installTools(registry, tools, [def(), def({ id: 'tool.base64', name: 'Base64', category: 'encode' })])
    const listed = registry.list()
    expect(listed.map((c) => c.id)).toEqual(['tool.base64', 'tool.json.format'])
    expect(listed.every((c) => c.category === '工具')).toBe(true)
    expect(listed.find((c) => c.id === 'tool.json.format')?.title).toBe('JSON 格式化')
  })

  it('⚠️ 分类不是 tool.category：命令面板里挨着「文件」「编辑器」出现 format 会像没写完', () => {
    installTools(registry, tools, [def()])
    expect(registry.list()[0]?.category).not.toBe('format')
  })

  it('执行那条命令就是把工具箱展开并停在这个工具上', async () => {
    installTools(registry, tools, [def()])
    await expect(registry.execute('tool.json.format')).resolves.toBe(true)
    expect(tools.opened).toEqual(['tool.json.format'])
  })

  it('🔴 不设 when：空窗口（editor 为 null）里也能执行', async () => {
    installTools(registry, tools, [def({ input: 'editor' })])
    expect(registry.list()[0]?.enabled).toBe(true)
    await expect(registry.execute('tool.json.format', { editor: null })).resolves.toBe(true)
    expect(tools.opened).toEqual(['tool.json.format'])
  })

  it('⛔ 一个快捷键都不绑：入口只有 Mod+Shift+T 那一个', () => {
    installTools(registry, tools, [def()])
    expect(registry.list()[0]?.keybindings).toEqual([])
    expect(registry.conflicts()).toEqual([])
  })

  it('工具 id 过得了命令注册表那条 ID_RE（分层命名的最后一道关）', () => {
    expect(() => installTools(registry, tools, [def({ id: 'tool.json.format.pretty' })])).not.toThrow()
  })
})

describe('目录', () => {
  const installed = () =>
    installTools(registry, tools, [
      def(),
      def({ id: 'tool.json.minify', name: 'JSON 压缩', category: 'format' }),
      def({ id: 'tool.regex', name: '正则测试器', category: 'test' }),
    ])

  it('all / has / get 三样都对得上', () => {
    const { catalog } = installed()
    expect(catalog.all().map((t) => t.id)).toEqual(['tool.json.format', 'tool.json.minify', 'tool.regex'])
    expect(catalog.has('tool.regex')).toBe(true)
    expect(catalog.has('tool.nope')).toBe(false)
    expect(catalog.get('tool.regex')?.name).toBe('正则测试器')
    expect(catalog.get('tool.nope')).toBeUndefined()
  })

  it('grouped 是左栏的数据源：按分类分组、空分类不出现', () => {
    const groups = installed().catalog.grouped()
    expect(groups.map((g) => g.label)).toEqual(['格式化', '测试器'])
    // 码位序（压 U+538B < 格 U+683C），理由见 `tool.test.ts` 里那条
    expect(groups[0]?.tools.map((t) => t.name)).toEqual(['JSON 压缩', 'JSON 格式化'])
  })

  it('dispose 把命令全注销、目录清空', () => {
    const { catalog, dispose } = installed()
    dispose()
    expect(registry.has('tool.json.format')).toBe(false)
    expect(registry.list()).toEqual([])
    expect(catalog.all()).toEqual([])
    expect(catalog.grouped()).toEqual([])
  })
})

describe('🔴 描述符不合法就整批不装', () => {
  it('一条命令都没进注册表', () => {
    const good = def()
    const bad = def({
      id: 'tool.base64',
      name: 'Base64',
      category: 'encode',
      run: 42 as unknown as ToolDefinition['run'],
    })
    expect(() => installTools(registry, tools, [good, bad])).toThrow(/tool\.base64：run 不是一个函数/)
    // 原子性：合法的那一个也没进去，于是「装了一半」这种状态压根不存在
    expect(registry.list()).toEqual([])
  })

  it('一次报出所有工具的所有问题', () => {
    let message = ''
    try {
      installTools(registry, tools, [
        def({ name: '' }),
        def({
          id: 'tool.uuid',
          name: 'UUID',
          category: 'generate',
          options: [{ kind: 'select', key: 'x', label: '', choices: [], default: 'a' }],
        }),
      ])
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('tool.json.format：name 是空的')
    expect(message).toContain('tool.uuid：选项 "x" 的 label 是空的')
    expect(message).toContain('tool.uuid：选项 "x" 一个候选都没有')
  })

  it('重复的 id 报出来，而不是等命令注册表抛一句「重复注册」', () => {
    expect(() => installTools(registry, tools, [def(), def()])).toThrow(/工具 id "tool\.json\.format" 重复/)
  })

  it('空的清单是合法的（M3-B-1 交的是框架，工具一个个来）', () => {
    const { catalog, dispose } = installTools(registry, tools, [])
    expect(catalog.all()).toEqual([])
    expect(registry.list()).toEqual([])
    dispose()
  })
})
