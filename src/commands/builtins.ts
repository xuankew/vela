import { startCompletion } from '@codemirror/autocomplete'
import { addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, deleteLine, moveLineDown, moveLineUp } from '@codemirror/commands'
import { foldAll, unfoldAll } from '@codemirror/language'
// selectNextOccurrence 与查找替换那几个都住在 search 包里，不在 commands 包
import {
  findNext,
  findPrevious,
  openSearchPanel,
  selectMatches,
  selectNextOccurrence,
} from '@codemirror/search'
import type { Command } from '@codemirror/view'
import { replaceAllCommand, replaceNextCommand } from '../editor/findReplace'
import { removeDuplicateLines, sortLinesAscending, sortLinesDescending } from '../editor/lineOps'
import { selectAllOccurrences } from '../editor/multiCursor'
import type { CommandDefinition, CommandRegistry } from './registry'

/**
 * 命令需要的宿主能力。
 *
 * 用注入而不是让命令直接 import App 的状态：命令定义是架构地基，
 * 一旦反向依赖具体组件，就没法单测、也没法在将来的插件宿主里复用。
 */
export interface BuiltinHooks {
  newDocument: () => void
  /** 弹原生「打开」对话框并读入选中的文件 */
  openFile: () => void | Promise<void>
  /** 写回当前路径；没有路径时由宿主自行落到「另存为」 */
  saveFile: () => void | Promise<void>
  saveFileAs: () => void | Promise<void>
  /**
   * 切换自动换行。
   *
   * 命令只负责决定新值，落值由宿主做——因为换行状态同时活在两个地方：
   * `EditorController`（真正生效的扩展）与 App 的 signal（工具栏按钮的标签）。
   */
  applyLineWrap: (on: boolean) => void
  /** 字号是全局 CSS 变量，不属于任何单个编辑器实例 */
  adjustFontSize: (delta: number) => void
  resetFontSize: () => void
  /**
   * 分屏五条。都作用于「聚焦的那块分屏」，而不是 `ctx.editor`——
   * `ctx.editor` 只是那块分屏里的编辑器实例，分屏的增删与聚焦是工作区的事。
   */
  splitRight: () => void
  splitDown: () => void
  closePane: () => void
  focusNextPane: () => void
  focusPreviousPane: () => void
}

/**
 * 把 CM6 的 `Command` 包成注册表命令。
 *
 * 十几条行操作/选区命令只差 id、标题、函数本身和快捷键，`when` 与 `run` 是完全一样的。
 * 重复写十几遍只会把真正的差异埋进样板里。
 *
 * 参数类型取 `Command`（收 `EditorView`）而不是 `StateCommand`（收 `{state, dispatch}`）：
 * CM6 自己两种都在用——`moveLineUp` 是 StateCommand，`deleteLine` 是 Command。
 * 我们永远递 `ctx.editor!.view`，而 `EditorView` 结构上就有 `{ state, dispatch }`，
 * 于是 StateCommand 靠参数逆变也能塞进来，两边都不用改。
 */
function cmCommand(
  id: string,
  title: string,
  command: Command,
  keybinding?: string | string[],
): CommandDefinition {
  return {
    id,
    title,
    category: '编辑器',
    ...(keybinding ? { keybinding } : {}),
    when: (ctx) => ctx.editor !== null,
    run: (ctx) => {
      command(ctx.editor!.view)
    },
  }
}

/**
 * 注册内置命令。返回统一的注销函数。
 *
 * **快捷键的归属**：下面不少命令绑的键 CM6 自己的 keymap 也绑了（`Alt+↑` 移动行、
 * `Mod+D` 选下一个、`Mod+Shift+K` 删行…）。这不是重复处理：`attachKeybindingDispatch`
 * 在 window 的**捕获阶段**监听，先于 CM6 挂在 contentDOM 上的 keymap 收到事件，并且
 * `preventDefault` + `stopPropagation`，所以 CM6 那条根本不会触发——而注册表调用的
 * 又是**同一个 CM6 函数**，行为完全一致。这么做的收益是命令面板能显示出快捷键；
 * 代价是同一个绑定在两处声明，改的时候要记得 CM6 那份是死的。
 *
 * ⚠️ **例外：绑 Escape 的命令一律不注册。** CM6 把 Escape 按 scope 分流
 * （`closeSearchPanel` 只在 `editor search-panel` 里生效，`simplifySelection` 在编辑器里），
 * 而全局捕获监听看不到 scope，注册上去就会在查找面板打开时把「关闭面板」吞掉。
 *
 * 折叠/展开也刻意**不绑快捷键**：CM6 的 `foldKeymap` 已经绑了 `Cmd/Ctrl+Shift+[` `]`
 * 折叠当前区块，再绑一套只会制造冲突。这两条命令的价值是让折叠能被命令面板与
 * 将来的菜单栏调用——那正是「所有功能走同一个注册表」的意义。
 */
export function registerBuiltinCommands(registry: CommandRegistry, hooks: BuiltinHooks): () => void {
  const dispose = [
    registry.register({
      id: 'file.new',
      title: '新建',
      category: '文件',
      keybinding: 'Mod+N',
      run: () => hooks.newDocument(),
    }),
    registry.register({
      id: 'file.open',
      title: '打开文件…',
      category: '文件',
      keybinding: 'Mod+O',
      run: () => hooks.openFile(),
    }),
    registry.register({
      id: 'file.save',
      title: '保存',
      category: '文件',
      keybinding: 'Mod+S',
      when: (ctx) => ctx.editor !== null,
      run: async () => {
        await hooks.saveFile()
      },
    }),
    registry.register({
      id: 'file.saveAs',
      title: '另存为…',
      category: '文件',
      keybinding: 'Mod+Shift+S',
      when: (ctx) => ctx.editor !== null,
      run: async () => {
        await hooks.saveFileAs()
      },
    }),

    registry.register({
      id: 'editor.foldAll',
      title: '折叠全部',
      category: '编辑器',
      when: (ctx) => ctx.editor !== null,
      run: (ctx) => {
        foldAll(ctx.editor!.view)
      },
    }),
    registry.register({
      id: 'editor.unfoldAll',
      title: '展开全部',
      category: '编辑器',
      when: (ctx) => ctx.editor !== null,
      run: (ctx) => {
        unfoldAll(ctx.editor!.view)
      },
    }),
    registry.register({
      id: 'editor.toggleLineWrap',
      title: '切换自动换行',
      category: '编辑器',
      // Alt+Z 是 VS Code 的既有约定，CM6 没有占用它
      keybinding: 'Alt+Z',
      when: (ctx) => ctx.editor !== null,
      run: (ctx) => hooks.applyLineWrap(!ctx.editor!.lineWrap),
    }),
    // 词补全的显式入口。自动触发不需要命令：autocompletion 的 activateOnTyping 默认开着，
    // 打满两个字符就自己弹（见 editor/wordSource 的 MIN_TYPED）。
    // ⛔ 不绑 Ctrl+Space（CM6 completionKeymap 里那条）：macOS 上它是系统的「切换到上一个
    // 输入法」，与 Mod+W 同一条道理——系统级快捷键在事件到达 webview 之前就被吃掉了，
    // 绑在注册表里收不到按键。Alt+/ 是 Sublime 的既有约定，CM6 没有占用它；Option+/ 打出
    // 的是 ÷，但我们的解析走 event.code 的物理键位（见 commands/keybinding.ts），所以能匹配。
    registry.register(cmCommand('editor.startCompletion', '触发词补全', startCompletion, 'Alt+/')),

    // 分屏。快捷键沿用 VS Code 的既有约定（`Mod+\` 右分屏、`Mod+Shift+\` 下分屏、
    // `Mod+Alt+←→` 切焦点），不另发明。
    registry.register({
      id: 'editor.splitRight',
      title: '向右分屏',
      category: '编辑器',
      keybinding: 'Mod+\\',
      when: (ctx) => ctx.editor !== null,
      run: () => hooks.splitRight(),
    }),
    registry.register({
      id: 'editor.splitDown',
      title: '向下分屏',
      category: '编辑器',
      keybinding: 'Mod+Shift+\\',
      when: (ctx) => ctx.editor !== null,
      run: () => hooks.splitDown(),
    }),
    registry.register({
      id: 'editor.focusNextPane',
      title: '聚焦下一块分屏',
      category: '编辑器',
      keybinding: 'Mod+Alt+Right',
      when: (ctx) => ctx.editor !== null,
      run: () => hooks.focusNextPane(),
    }),
    registry.register({
      id: 'editor.focusPreviousPane',
      title: '聚焦上一块分屏',
      category: '编辑器',
      keybinding: 'Mod+Alt+Left',
      when: (ctx) => ctx.editor !== null,
      run: () => hooks.focusPreviousPane(),
    }),
    // ⛔ 「合并分屏」刻意不绑 `Mod+W`：macOS 的原生菜单快捷键等价物在事件到达 webview
    // 之前就被系统吃掉了，绑在这里收不到按键（见 §3.3「M1-D 实施修正」）。
    // 不绑键与 foldAll / unfoldAll 同一条理由：工具栏的「合并」按钮就是它的入口，
    // 注册进来只为让命令面板能调用。
    registry.register({
      id: 'editor.closePane',
      title: '合并分屏',
      category: '编辑器',
      when: (ctx) => ctx.editor !== null,
      run: () => hooks.closePane(),
    }),

    // 行操作。快捷键沿用 CM6 defaultKeymap 已有的那一套，不另发明。
    registry.register(cmCommand('editor.moveLineUp', '上移当前行', moveLineUp, 'Alt+Up')),
    registry.register(cmCommand('editor.moveLineDown', '下移当前行', moveLineDown, 'Alt+Down')),
    registry.register(cmCommand('editor.copyLineUp', '向上复制当前行', copyLineUp, 'Shift+Alt+Up')),
    registry.register(cmCommand('editor.copyLineDown', '向下复制当前行', copyLineDown, 'Shift+Alt+Down')),
    registry.register(cmCommand('editor.deleteLine', '删除当前行', deleteLine, 'Mod+Shift+K')),

    // 多光标。`Mod-Alt-ArrowUp/Down` 在 CM6 的 defaultKeymap、`Mod-d` / `Mod-Shift-l` 在
    // searchKeymap 里都绑了同样的键，沿用那一套，不另发明。
    // `editor.selectAllOccurrences` 是**例外**：用的是 editor/multiCursor 里自己写的那个，
    // 因为 CM6 原生的 selectSelectionMatches 在已经有多个选区时直接拒绝（Cmd+D 按几下再
    // Cmd+Shift+L 就成了死路）。
    registry.register(cmCommand('editor.selectNextOccurrence', '选中下一个相同内容', selectNextOccurrence, 'Mod+D')),
    registry.register(cmCommand('editor.selectAllOccurrences', '选中全部相同内容', selectAllOccurrences, 'Mod+Shift+L')),
    registry.register(cmCommand('editor.addCursorAbove', '在上方添加光标', addCursorAbove, 'Mod+Alt+Up')),
    registry.register(cmCommand('editor.addCursorBelow', '在下方添加光标', addCursorBelow, 'Mod+Alt+Down')),
    // ⛔ `selectLine`（CM6 绑 Alt-l，macOS 上覆盖成 Ctrl-l）与 `simplifySelection`（Escape）
    // 刻意不注册：前者要按平台写两份声明，而本项目的快捷键 DSL 只有 `Mod` 一个可移植修饰键；
    // 后者撞上面「绑 Escape 的命令一律不注册」那条规矩。两个都由 CM6 自己的 keymap 负责。
    // Option+Click 加光标 / Option+Shift+拖拽 列块选择是鼠标手势，不走命令，见 editor/multiCursor。

    // 排序去重。CM6 没有内置，见 ../editor/lineOps。
    // Alt+Shift+字母 在 macOS 上曾经匹配不到（Option 会把 key 变成特殊字符），
    // 现在靠 event.code 解析物理键位才能用，见 commands/keybinding.ts。
    registry.register(cmCommand('editor.sortLinesAsc', '升序排序行', sortLinesAscending, 'Alt+Shift+A')),
    registry.register(cmCommand('editor.sortLinesDesc', '降序排序行', sortLinesDescending, 'Alt+Shift+D')),
    registry.register(cmCommand('editor.removeDuplicateLines', '删除重复行', removeDuplicateLines, 'Alt+Shift+U')),

    // 查找替换。面板是自建的（多一个「保留大小写」开关，见 editor/findReplace），
    // 但 openSearchPanel / findNext / findPrevious / selectMatches 都是 CM6 原生的——
    // 它们通过 `search({ createPanel })` 找到我们的面板，不需要重写。
    // 只有「替换」两条换成了自己的包装：保留大小写关着时原样转交 CM6，开着时才走自己的路径。
    registry.register(cmCommand('editor.find', '查找替换…', openSearchPanel, 'Mod+F')),
    registry.register(cmCommand('editor.findNext', '查找下一个', findNext, ['Mod+G', 'F3'])),
    registry.register(cmCommand('editor.findPrevious', '查找上一个', findPrevious, ['Mod+Shift+G', 'Shift+F3'])),
    // 全部选中不绑键：CM6 的 searchKeymap 也没绑，面板上的「全部选中」按钮就是它的入口。
    // 注册进来只为让命令面板能调用，与 foldAll / unfoldAll 同一条理由。
    registry.register(cmCommand('editor.selectAllMatches', '选中全部匹配项', selectMatches)),
    registry.register(cmCommand('editor.replaceNext', '替换下一个', replaceNextCommand, 'Mod+Shift+Enter')),
    registry.register(cmCommand('editor.replaceAll', '全部替换', replaceAllCommand, 'Mod+Alt+Enter')),
    // ⛔ `closeSearchPanel` 刻意不注册：它绑 Escape，撞上面「绑 Escape 的命令一律不注册」那条规矩。
    // `gotoLine`（CM6 绑 Mod-Alt-g）不属于查找替换，也不在 #22 的范围里，交给 CM6 自己的 keymap。

    registry.register({
      id: 'view.increaseFontSize',
      title: '放大字号',
      category: '视图',
      keybinding: 'Mod+=',
      run: () => hooks.adjustFontSize(1),
    }),
    registry.register({
      id: 'view.decreaseFontSize',
      title: '缩小字号',
      category: '视图',
      keybinding: 'Mod+-',
      run: () => hooks.adjustFontSize(-1),
    }),
    registry.register({
      id: 'view.resetFontSize',
      title: '重置字号',
      category: '视图',
      keybinding: 'Mod+0',
      run: () => hooks.resetFontSize(),
    }),
  ]

  return () => {
    for (const d of dispose) d()
  }
}
