/**
 * 工具目录 + 把工具**投影进 M1-A 那个命令注册表**（M3-B-1）。
 *
 * ## 🔴 这不是第二个命令注册表
 *
 * PLAN §2.7 那句话是架构地基：「编辑器操作、内置工具、面板开关、主题切换——全部是命令」。
 * 所以这里**没有** `execute`、**没有** keybinding 解析、**没有** `when` 求值——那些都只有
 * `commands/registry.ts` 一份。这一层持有的只是**描述符**（`run` / `options` / `input`），
 * 也就是命令注册表没有槽位可放的那一半数据。
 *
 * 于是 §1.5 那三条触达路径**一条都不用另写**：
 * 1. `Mod+Shift+P` 命令面板搜工具名 —— `commands.list()` 里本来就有它；
 * 2. 绑快捷键 —— `CommandDefinition.keybinding`，⚠️ M3-B **一个都不绑**（理由见下）；
 * 3. 工具箱面板按分类浏览 —— 这一层的 `grouped()`。
 *
 * ## ⚠️ 为什么不给每个工具绑快捷键
 *
 * PLAN §1.5 举的例子是 `Cmd+Shift+J` → JSON 格式化。真绑的话六个工具吃掉六个
 * `Mod+Shift+*`，而那一排已经不宽了：`O` 最近项目、`V` 预览、`M` 大纲、`F` 搜索、
 * `H` 替换、`A` 表格对齐、`C` 字数、`E` 导出、`S` 另存为、`K` 删行都占着，
 * `P` 是命令面板（M3-B-1d）、`T` 是工具箱、`W` 是 macOS 的「关闭所有窗口」压根到不了
 * webview，只剩 `R` 空着并被用例钉住。更重要的一条是**入口的唯一性**：`Mod+Shift+T`
 * 打开工具箱，里面换工具是 `↑↓` + `Enter`，于是「用一个工具」永远是两次按键——
 * 正好是 M3 验收那条判据（≤ 2 次按键）。再给单个工具绑键等于给同一件事开第二个入口，
 * 而两个入口的行为迟早会不一致。
 *
 * ## 🔴 `installTools` 是**唯一**的注册入口，而且两半是一次做成的
 *
 * 「往目录里加一个工具」与「往命令注册表加一条命令」如果是两个调用，那么漏掉后一个的
 * 失败方式是：工具箱里点得到、命令面板里搜不到、`Mod+Shift+P` 那条路径静默失效。
 * 合成一个函数 + 一个合并的 `dispose` 之后，这种漂移在结构上就写不出来。
 */

import type { CommandRegistry } from '../commands/registry'
import { groupTools, validateTool, type ToolDefinition, type ToolGroup } from './tool'

/** 宿主能力。只有一条：把工具箱展开并停在某个工具上 */
export interface ToolHost {
  /**
   * 打开工具箱并直接选中这个工具。
   *
   * ⚠️ 不是「切换工具箱可见性」：从命令面板里挑「JSON 格式化」的用户要的是**那个工具**，
   * 而一个 toggle 语义的钩子会在工具箱已经开着的时候把它关掉——他刚挑完的东西消失了。
   * 与 `builtins.ts` 里 `gotoFile` / `gotoSymbol` 不复用是同一条理由：
   * 命令的语义是**到达某个状态**
   */
  openTool: (id: string) => void
}

/** 安装之后那份**只读**的目录 */
export interface ToolCatalog {
  all(): readonly ToolDefinition[]
  has(id: string): boolean
  get(id: string): ToolDefinition | undefined
  /** 左栏的数据源，已按分类分组、组内按名字排序（见 `tool.ts` 的 `groupTools`） */
  grouped(): readonly ToolGroup[]
}

export interface InstalledTools {
  readonly catalog: ToolCatalog
  /** 注销全部命令并清空目录。与 `registerBuiltinCommands` 的返回值同一种东西 */
  dispose: () => void
}

/**
 * 装一批工具。
 *
 * 🔴 **描述符不合法就整批不装**，并且一次报出**所有**工具的所有问题。
 * 这是启动路径上的一次自检：v1 的工具清单是写死在代码里的常量，所以一份不合法的
 * 描述符是**我们的 bug**，不是用户的输入。让它当场炸比让那个工具在左栏里点不动好——
 * 后者的症状是「点了没反应」，而那正是这个代码库一路在躲的失败方式
 */
export function installTools(
  commands: CommandRegistry,
  host: ToolHost,
  defs: readonly ToolDefinition[],
): InstalledTools {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const def of defs) {
    if (seen.has(def.id)) problems.push(`工具 id "${def.id}" 重复`)
    seen.add(def.id)
    for (const problem of validateTool(def)) problems.push(`${def.id}：${problem}`)
  }
  if (problems.length > 0) throw new Error(`工具描述符不合法：\n  ${problems.join('\n  ')}`)

  const tools = [...defs]
  const disposers = tools.map((tool) =>
    commands.register({
      id: tool.id,
      title: tool.name,
      // ⚠️ 分类是中文的「工具」而不是 `tool.category`，理由写在 `tool.ts` 的文件头
      category: '工具',
      /**
       * 🔴 **不设 `when`**：已经落地的六个工具压根都不需要编辑器（五个 `input: 'text'`、
       * 一个 `input: 'none'`），而将来真有一个 `input: 'editor'` 的也不该被 gate 掉——
       * 空窗口里点开它，面板会如实说「先打开一个文档」，而设了 `when` 的话命令面板里
       * 它是**灰的**，用户得到的信息是「这个功能现在不能用」，却不知道要做什么才能用。
       * 与 `togglePreview` / `alignTable` / `wordCount` 逐字同一条理由
       */
      run: () => host.openTool(tool.id),
    }),
  )

  return {
    catalog: {
      all: () => tools,
      has: (id) => tools.some((tool) => tool.id === id),
      get: (id) => tools.find((tool) => tool.id === id),
      grouped: () => groupTools(tools),
    },
    dispose() {
      for (const dispose of disposers) dispose()
      tools.length = 0
    },
  }
}
