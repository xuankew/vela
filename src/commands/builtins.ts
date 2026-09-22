import { startCompletion } from '@codemirror/autocomplete'
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  deleteLine,
  moveLineDown,
  moveLineUp,
} from '@codemirror/commands'
import { foldAll, unfoldAll } from '@codemirror/language'
// selectNextOccurrence 与查找替换那几个都住在 search 包里，不在 commands 包
import { findNext, findPrevious, openSearchPanel, selectMatches, selectNextOccurrence } from '@codemirror/search'
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
  // 项目四条（M2-B 三条 + M2-F 一条）。前三条都作用于侧边栏那棵树，最后一条作用于
  // 跳转浮层，但都不是 `ctx.editor`——没有编辑器聚焦时它们照样该能用，所以 `when` 一律不设。
  /** 弹原生目录对话框，选中之后打开成项目根并把侧边栏显示出来 */
  openFolder: () => void | Promise<void>
  /** 弹原生目录对话框（可多选），把挑中的**追加**到工作区后面（M2-F） */
  addFolder: () => void | Promise<void>
  /**
   * 展开跳转浮层，进去就是**最近项目**那一种意图（M2-F，`Mod+Shift+O`）。
   *
   * 与 `gotoFile` / `gotoSymbol` 同一个浮层、同一份状态，差别只在 `show` 的第二个参数。
   * 放在「项目」而不是「跳转」分类下：它换掉的是整棵树，而「跳转」那两条答的是
   * 「带我去当前工作区里的某一处」。
   *
   * ⚠️ 刻意不复用「打开文件夹…」再让调用方自己去翻：与 `replaceInFiles` 逐字同一条理由——
   * 快捷键的语义是**到达某个状态**
   */
  openRecentProject: () => void
  /** 关掉工作区里所有文件夹。不动任何已打开的标签 */
  closeFolder: () => void
  /** 显示/隐藏侧边栏 */
  toggleSidebar: () => void
  /**
   * 显示/隐藏 Markdown 预览那一栏（M3-A-3）。
   *
   * 与侧边栏是**两个独立的可见性**：侧边栏答「磁盘上有什么」，预览答「这份文档渲染出来
   * 是什么样」，关掉一个不该顺手关掉另一个。
   *
   * ⚠️ 命令本身**不判语言**：打开一个 `.ts` 再按 `Mod+Shift+V`，面板照样出来，
   * 里面写着「TypeScript 还没有预览」。设 `when: (ctx) => 是 Markdown` 的话快捷键按下去
   * 什么也不发生，而用户得到的信息是零——那句提示至少告诉了他「功能在，只是这个文件不行」。
   */
  togglePreview: () => void
  /**
   * 显示/隐藏 JSON 预览那一栏（M4-D）。
   *
   * 与 Markdown 预览是**两个独立的可见性**：Markdown 预览答「这份文档渲染出来是什么样」，
   * JSON 预览答「这段文本解析成 JSON 后的树形结构」。关掉一个不该顺手关掉另一个。
   *
   * ⚠️ 命令本身**不判内容**：打开一个 `.md` 再按 `Mod+Shift+K`，面板照样出来，
   * 里面写着「JSON 解析失败」。设 `when` gate 的话快捷键按下去什么也不发生，信息是零
   */
  toggleJsonPreview: () => void
  /**
   * 显示/隐藏大纲那一栏（M3-A-4）。
   *
   * 与预览是**两个独立的可见性**，也与侧边栏是：大纲答「这份文档的结构长什么样」，
   * 而它列的标题与 `Cmd+R` 浮层里那一份**逐字同源**（都是 `symbolTable`），
   * 差别只在浮层是「按名字过滤后跳一次」，大纲是「一直挂在那儿」。
   *
   * ⚠️ 与 `togglePreview` 同一条：命令本身**不判语言**，面板自己会说
   * 「TypeScript 还没有符号表」。设 `when` 的话快捷键按下去什么也不发生，信息是零
   */
  toggleOutline: () => void
  /**
   * 把光标所在的那张 Markdown 表格**只改空白**地重排（M3-A-5，`Mod+Shift+A`）。
   *
   * 与上面那些「作用于面板」的 hook 不同，这一条作用于**聚焦分屏里的文档**，所以
   * 「没有编辑器」「光标不在表格里」「这张表已经对齐了」三种情况全归宿主说——
   * 命令本身**不设 `when`**，理由与 `togglePreview` 逐字相同：设了 gate 的话
   * 快捷键按下去什么也不发生，而用户得到的信息是零。
   */
  alignTable: () => void
  /**
   * 统计聚焦那块分屏里的字数与阅读时长（M3-A-6，`Mod+Shift+C`）。
   *
   * 结果走 `editorNotice` 说出来，**不进状态栏**。理由是成本而不是位置：
   * `syncMetrics` 在每一个事务上跑（包括只动了光标的），而字数是一次全文扫描，
   * 塞进去等于每敲一个键就重扫一遍。防抖能压住频率，但压不住「状态栏那个数字会自己
   * 跳一下」——一个会滞后的字数比一个要按键才出来的字数更容易被当成 bug。
   * 完整论证在 `src/doc/stats.ts` 的文件头。
   *
   * 不设 `when`，与 `alignTable` 同一条：「没有编辑器」在这儿的意思可能是「聚焦的是一份
   * 只读大文件」，而那种文件恰恰是**最不该**被数的（几百万行的日志，数一遍要几秒）——
   * 所以这句话该由宿主说，不该由一个按下去没反应的快捷键说
   */
  wordCount: () => void
  /**
   * 把聚焦那份 Markdown 导出成单文件 HTML（M3-A-6，`Mod+Shift+E`）。
   *
   * 与上面那些 hook 的差别在于它**要弹一次系统保存对话框、要写盘**，所以是异步的。
   * 它复用 `save_file`（同一条原子写盘路径），⛔ 没有为它新增一个 Tauri 命令：
   * 「写一个文件」这件事后端已经会做了，多一个命令只会多一处要审的路径接受面。
   *
   * 同样不设 `when`，四种拒绝（不是 Markdown / 解析没跑完 / 文档是空的 / 这块分屏没有
   * CM6 实例）全归宿主说。⚠️ 与同分类的 `file.save` / `file.saveAs` 不一致是有意的：
   * 那两条的 `when` 是 M2-H 之前写的，而它们**照样**要在 `document.ts` 里再拒一次
   * （工具栏按钮不看 `when`），所以那个 gate 本来就没在独自承担什么
   */
  exportHtml: () => void | Promise<void>
  /**
   * 展开窗口底部的全局搜索面板，并把焦点放进搜索词输入框（M2-C）。
   *
   * 与项目三条同一条道理：它作用于那个面板而不是 `ctx.editor`，
   * 所以没有编辑器聚焦时也照样该能用——空窗口里搜不了东西，但那是「还没打开文件夹」
   * 那句话要说的事，不该由快捷键按了没反应来表达。
   */
  findInFiles: () => void
  /**
   * 展开窗口底部的全局搜索面板并**直接进替换模式**（M2-D，`Mod+Shift+H`）。
   *
   * 与 `findInFiles` 是同一个面板、同一份状态，差别只在进去之后是不是已经开着替换那一排。
   * 刻意不复用 `findInFiles` 再让调用方自己去翻模式：那会把「按这个键该看到什么」
   * 拆到两个地方，而快捷键的语义是**到达某个状态**，不是执行一串动作
   */
  replaceInFiles: () => void
  /**
   * 展开跳转浮层，输入框是空的（M2-E，`Mod+P`）——按名字找项目里的文件。
   *
   * 与全局搜索那两条同一条道理：它作用于那个浮层而不是 `ctx.editor`，所以 `when` 不设。
   * 空窗口里按它照样该展开，浮层自己会说「先打开一个文件夹，才能按名字找文件」。
   */
  gotoFile: () => void
  /**
   * 展开同一个浮层，但**进去就是列标题模式**（M2-E，`Mod+R`）。
   *
   * ⚠️ 刻意不复用 `gotoFile` 再让调用方自己去补那个 `@`：与 `replaceInFiles` 逐字同一条理由——
   * 快捷键的语义是**到达某个状态**。浮层已经开着的时候再按另一个键，也不该把索引重建一遍
   * （见 `goto/store.ts` 的 `show`）
   */
  gotoSymbol: () => void
  /**
   * 展开工具箱那块大浮层（M3-B-1，`Mod+Shift+T`）。
   *
   * 🔴 是「展开并停在上次那个工具上」，**不是 toggle**：从命令面板里挑「工具箱」的用户
   * 要的是那块浮层出现，而一个 toggle 语义的钩子会在它已经开着的时候把它关掉——
   * 与 `tools/registry.ts` 的 `openTool` 逐字同一条理由。收起是 `Escape` 的事。
   *
   * 不设 `when`：工具箱里六个工具只有一个是 `input: 'editor'` 的，而空窗口里点开它，
   * 面板会如实说「现在没有打开的文档」——设 gate 的话用户得到的是「这个功能现在不能用」，
   * 却不知道要做什么才能用（与 `togglePreview` / `alignTable` / `wordCount` 同一条）
   */
  openToolBox: () => void
  /**
   * 展开命令面板（M3-B-1d，`Mod+Shift+P`）。
   *
   * 它列的就是这个注册表自己——于是「所有功能走同一个注册表」这句话在界面上第一次
   * 变得可见：没有快捷键的那些命令（折叠/展开、全部选中匹配项…）终于有了入口。
   *
   * ⚠️ 这一条自己也出现在面板里。那不是递归 bug：`commit()` 是**先收起再执行**的，
   * 所以在面板里挑「命令面板」的效果是浮层闪一下重新聚焦，与 VS Code 一致
   */
  openCommandPalette: () => void
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
function cmCommand(id: string, title: string, command: Command, keybinding?: string | string[]): CommandDefinition {
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
    // 导出单文件 HTML（M3-A-6）。绑 Mod+Shift+E：E = Export。
    //
    // ⚠️ 这个键此前是空的：`@codemirror` 与 `@lezer` 的 dist 里搜不到一条 `Mod-Shift-e`
    // （`grep -ohiE "Mod-Shift-[cew]|Ctrl-Shift-[cew]" node_modules/@codemirror/*/dist/index.js
    // node_modules/@lezer/*/dist/index.js` 零命中，同一批里 `Mod-Shift-l` 是有的，
    // 所以那次搜索本身是通的），本项目也没有自建原生菜单去占它。
    //
    // ⛔ 不设 `when`，理由与同分类的 `file.save` / `file.saveAs` **不同**：那两条是 M2-H
    // 之前写的，而它们照样要在 `document.ts` 里再拒一次（工具栏按钮不看 `when`），
    // 所以那个 gate 本来就没在独自承担什么。这一条要说的四种拒绝里有一种是「这不是
    // Markdown」——那与有没有编辑器无关，gate 表达不了
    registry.register({
      id: 'file.exportHtml',
      title: '导出 HTML…',
      category: '文件',
      keybinding: 'Mod+Shift+E',
      run: async () => {
        await hooks.exportHtml()
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
    // Markdown 表格对齐（M3-A-5）。
    // ⛔ 不是 `Alt+Shift+A`——那是上面「升序排序行」；也不是 `Mod+Shift+T`，
    // 那个刻意留给 M3-B 的工具面板。A = Align。
    // 不设 `when` 的理由见 `BuiltinHooks.alignTable` 那条注释。
    registry.register({
      id: 'editor.alignTable',
      title: '对齐当前表格',
      category: '编辑器',
      keybinding: 'Mod+Shift+A',
      run: () => hooks.alignTable(),
    }),
    // 字数与阅读时长（M3-A-6）。绑 Mod+Shift+C：C = Count。
    //
    // ⛔ 不绑 Mod+Shift+W（W = Word 更顺）：macOS 上 Cmd+Shift+W 是系统的「关闭所有窗口」，
    // 与上面「合并分屏」不绑 Mod+W 是同一条理由——系统级快捷键在事件到达 webview 之前
    // 就被吃掉了，绑在注册表里收不到按键。
    //
    // ⚠️ Mod+Shift+C 此前是空的（与 Mod+Shift+E 同一批 `grep` 查证，见上面那条注释）。
    // VS Code 里它是「复制当前文件路径」，但本项目的界面参照物是 Sublime，
    // 而 Sublime 的 Word Count 没有默认快捷键——这个位置在这儿不与任何肌肉记忆打架
    registry.register({
      id: 'editor.wordCount',
      title: '统计字数',
      category: '编辑器',
      keybinding: 'Mod+Shift+C',
      run: () => hooks.wordCount(),
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
    //
    // 🔴 这五条**一律不设 `when`**。它们从前都写着 `ctx.editor !== null` 那个条件，
    // 而 M2-H 之后那一条是错的：只读分片那块分屏里**没有** `EditorController`
    // （`ShardPane` 不是 CM6，理由见 `App.tsx` 里那段「替换而不是叠一层」），于是
    // `ctx.editor` 是 null——而它的含义已经从「没东西可分屏」变成了「聚焦的是一份
    // 只读大文件」。照旧设 gate 的后果是：打开一个 100 MB 的日志，分屏/合并/切焦点
    // 整组命令全哑掉；而工具栏那两个按钮的 `disabled` 只看 `MAX_PANES`，
    // **看上去还是能点的**——点下去什么也不发生，也不报错。
    //
    // 不设 gate 是安全的：五个 hook 全走 workspace，而 workspace 里 `capture` /
    // `focusPane` / `syncMetrics` 都是 `controller?.` 那一套写法，没有编辑器就是什么都不做。
    registry.register({
      id: 'editor.splitRight',
      title: '向右分屏',
      category: '编辑器',
      keybinding: 'Mod+\\',
      run: () => hooks.splitRight(),
    }),
    registry.register({
      id: 'editor.splitDown',
      title: '向下分屏',
      category: '编辑器',
      keybinding: 'Mod+Shift+\\',
      run: () => hooks.splitDown(),
    }),
    registry.register({
      id: 'editor.focusNextPane',
      title: '聚焦下一块分屏',
      category: '编辑器',
      keybinding: 'Mod+Alt+Right',
      run: () => hooks.focusNextPane(),
    }),
    registry.register({
      id: 'editor.focusPreviousPane',
      title: '聚焦上一块分屏',
      category: '编辑器',
      keybinding: 'Mod+Alt+Left',
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
      run: () => hooks.closePane(),
    }),

    // 项目（M2-B）。
    // ⛔ 「打开文件夹」刻意不绑快捷键：`Mod+O` 已经是「打开文件」，而 `Mod+Shift+O`
    // 在 PLAN §3.4 里留给「工作区管理」——M2-F 把它兑给了下面那条 `project.openRecent`。
    // 侧边栏头部与工具栏的按钮就是「打开文件夹…」的入口。
    registry.register({
      id: 'project.openFolder',
      title: '打开文件夹…',
      category: '项目',
      run: () => hooks.openFolder(),
    }),
    // 没有 `when`：`AppContext` 里只有 `editor`，而「有没有打开项目」不属于编辑器状态。
    // 不加 `project` 字段是为了不给命令中心添一个所有 `editor.*` 都不关心的依赖——
    // `closeFolder` 在没有项目时本来就是空操作，命令面板里灰不灰只是观感问题。
    // 与「打开文件夹…」的区别只有一个字：这个是**追加**，那个是**替换**。
    // 命令面板里两条挨着放，标题上也把「到工作区」写全——省掉它的话两条读起来
    // 像是同一件事的两种说法，而其中一种会把用户原来的项目整个换掉
    registry.register({
      id: 'project.addFolder',
      title: '添加文件夹到工作区…',
      category: '项目',
      run: () => hooks.addFolder(),
    }),
    // 最近项目（M2-F）。绑 Mod+Shift+O：PLAN §3.4 给「工作区管理」留的就是这个键，
    // 而 VS Code 的「Open Recent」在 macOS 上是 Cmd+R——那个键在这里已经是
    // `goto.symbol`（跳转到标题，Sublime 的既有约定），两者不可兼得时选了 PLAN 里写着的那个。
    //
    // ⚠️ 这个键此前是空的：`@codemirror` 与 `@lezer` 里搜不到一条 `Mod-Shift-o`
    // （与上面 Mod+P / Mod+R 那两条同一套查证），本项目也没有自建原生菜单去占它。
    //
    // 没有 `when`：一份空的最近清单不是「这条命令此刻不适用」，而是「这里还没攒出东西」——
    // 浮层自己会把这句话说出来（见 `goto/store.ts` 的 footer），快捷键按了没反应则什么也说不清
    registry.register({
      id: 'project.openRecent',
      title: '打开最近的项目…',
      category: '项目',
      keybinding: 'Mod+Shift+O',
      run: () => hooks.openRecentProject(),
    }),
    registry.register({
      id: 'project.closeFolder',
      title: '关闭所有文件夹',
      category: '项目',
      run: () => hooks.closeFolder(),
    }),
    registry.register({
      id: 'view.toggleSidebar',
      title: '显示/隐藏侧边栏',
      category: '视图',
      // Mod+B 是 VS Code 的既有约定，CM6 没有占用它
      keybinding: 'Mod+B',
      run: () => hooks.toggleSidebar(),
    }),
    // Markdown 预览（M3-A-3）。绑 Mod+Shift+V：VS Code 的「Open Preview to the Side」是
    // Cmd+K V、Sublime 的 MarkdownPreview 是 alt+m，两个都不是单键组合，这里取的是
    // Obsidian 与 Typora 共用的那一个——而本项目的 Markdown 体验参照的正是它们。
    //
    // ⚠️ 这个键此前是空的：`@codemirror` 与 `@lezer` 里搜不到一条 `Mod-Shift-v`
    // （`grep -rniE "Mod-v|Mod-Shift-v|Ctrl-v" node_modules/@codemirror/*/dist/index.js`
    // 只命中 `Ctrl-v: cursorPageDown`），本项目也没有自建原生菜单去占它。
    //
    // 没有 `when`：理由写在 `BuiltinHooks.togglePreview` 上——面板自己会说
    // 「X 还没有预览」，那比快捷键按了没反应说得多
    registry.register({
      id: 'view.togglePreview',
      title: '显示/隐藏 Markdown 预览',
      category: '视图',
      keybinding: 'Mod+Shift+V',
      run: () => hooks.togglePreview(),
    }),

    // 大纲（M3-A-4）。绑 Mod+Shift+M：VS Code 的 Cmd+Shift+M 是「问题」面板，
    // 而本项目**永远不会有**那一栏（无 LSP 是写进 v1 非目标里的硬约束，见 PLAN.md §2.2），
    // 所以这个键位在这儿是空的，拿来放「文档结构」不会与任何既有肌肉记忆打架。
    // Obsidian 的 Outline 面板没有默认快捷键，Sublime 也没有——这一条没有现成约定可循。
    //
    // ⚠️ 这个键此前是空的：`@codemirror` 与 `@lezer` 的 dist 里搜不到一条 `Mod-Shift-m`
    // （`grep -oh "Mod-Shift-m|Ctrl-Shift-m" node_modules/@codemirror/*/dist/index.js
    // node_modules/@lezer/*/dist/index.js` 零命中），本项目也没有自建原生菜单去占它。
    //
    // 没有 `when`：与 `togglePreview` 同一条理由——面板自己会说「X 还没有符号表」
    registry.register({
      id: 'view.toggleOutline',
      title: '显示/隐藏大纲',
      category: '视图',
      keybinding: 'Mod+Shift+M',
      run: () => hooks.toggleOutline(),
    }),

    // 全局搜索（M2-C）。绑 Mod+Shift+F：VS Code 与 Sublime 的既有约定。
    // CM6 的 searchKeymap 只占了 Mod+F / Mod+G / Mod+Shift+G / Mod+Alt+Enter / Mod+D 这几条，
    // Mod+Shift+F 是空的——而它正好与「Mod+F 是文档内查找」形成一对，不用另发明。
    registry.register({
      id: 'search.findInFiles',
      title: '在项目里搜索…',
      category: '搜索',
      keybinding: 'Mod+Shift+F',
      run: () => hooks.findInFiles(),
    }),

    // 全局替换（M2-D）。绑 Mod+Shift+H：VS Code 里「Replace in Files」就是 Cmd+Shift+H，
    // 也与上面那条 Mod+Shift+F 形成一对（同一个面板，差一个「进去就是替换模式」）。
    // 这个键在本项目里此前是空的：CM6 的 searchKeymap 只有 Mod-f / F3 / Mod-g / Escape /
    // Mod-Shift-l / Mod-Alt-g / Mod-d，commands / view 的 keymap 里也没有 Mod-h；
    // 文档内替换走的是 Mod+Shift+Enter（见下面的 editor.replaceNext）
    registry.register({
      id: 'search.replaceInFiles',
      title: '在项目里替换…',
      category: '搜索',
      keybinding: 'Mod+Shift+H',
      run: () => hooks.replaceInFiles(),
    }),

    // 跳转浮层（M2-E）。新开一个「跳转」分类，不塞进「搜索」：
    // 搜索答的是「哪些地方有这个词」，跳转答的是「带我去那一处」——命令面板里挨着放
    // 会让人以为按名字找文件是全文搜索的一种。`CommandDefinition.category` 是普通
    // `string` 而不是联合类型（registry.ts:28），所以加一个分类不用改任何类型声明；
    // `list()` 按 category 码点再按 id 排（registry.ts:144），「跳转」(U+8DF3) 落在
    // 「视图」(U+89C6) 与「项目」(U+9879) 之间。
    //
    // ⚠️ 两个键此前都是空的：整个 `@codemirror` 里搜不到一条 `Mod-p` / `Mod-r`
    // （`grep -i 'Mod-p|Mod-r|Ctrl-p|Ctrl-r' node_modules/@codemirror` 零命中）；
    // 本项目也没有自建原生菜单（`src-tauri/src/lib.rs` 里一条 `MenuBuilder` 都没有），
    // macOS 那套标准菜单项同样不占它们。
    // 选这两个字母不是随便挑的——Sublime 的 Goto Anything 是 Cmd+P、Goto Symbol 是 Cmd+R，
    // 而这个项目的界面参照物正是 Sublime。
    registry.register({
      id: 'goto.file',
      title: '跳转到文件…',
      category: '跳转',
      keybinding: 'Mod+P',
      run: () => hooks.gotoFile(),
    }),
    registry.register({
      id: 'goto.symbol',
      title: '跳转到标题…',
      category: '跳转',
      keybinding: 'Mod+R',
      run: () => hooks.gotoSymbol(),
    }),
    // ⛔ 刻意**不**注册 `goto.line`。跳行这件事已经有两个入口了：CM6 原生的 `gotoLine`
    // （绑 Mod+Alt+G，它自己会弹一个输入框），以及这个浮层里的 `:42` 语法。再注册一条
    // 等于给同一件事开第三扇门，而这三扇门的 UI 还长得各不相同。
    // 保留 CM6 那条是 PLAN §M2-E 里定下的决定，浮层里的 `:42` 是给「我知道文件名也知道行号」
    // 的人用的——一次按键到位，不必先开 gotoLine 再输一遍。

    // 工具箱（M3-B-1）。绑 Mod+Shift+T：T = Tools，与 VS Code / Sublime 的既有约定一致。
    // 这个键此前是空的，而且 `builtins.test.ts` 里有一条用例**钉住了它没人占**——
    // 那条用例现在翻成「占用且命中这一条」，与 M2-F 给 Mod+Shift+O 做的同一件事。
    //
    // 分类是「工具」，与 `tools/registry.ts` 投影出来的那些工具同分类：面板里它们挨着放，
    // 而「工具」(U+5DE5) 是所有分类里码位最小的，于是它排在最前面——那正是入口该在的位置。
    // ⚠️ 单个工具**一个键都不绑**，理由写在 `tools/registry.ts` 的文件头。
    registry.register({
      id: 'toolbox.open',
      title: '工具箱…',
      category: '工具',
      keybinding: 'Mod+Shift+T',
      run: () => hooks.openToolBox(),
    }),

    // JSON 预览（M4-D）。绑 Mod+Shift+K：K = JSON (K for "Key")，与 Markdown 预览的 V 对应。
    // 分类是「视图」，与 Markdown 预览同分类：两个都是「当前文档的另一种呈现方式」。
    registry.register({
      id: 'view.toggleJsonPreview',
      title: 'JSON 预览',
      category: '视图',
      keybinding: 'Mod+Alt+V',
      run: () => hooks.toggleJsonPreview(),
    }),

    // 命令面板（M3-B-1d）。绑 Mod+Shift+P：VS Code 的「Show All Commands」就是 Cmd+Shift+P，
    // Sublime 的命令面板是 Cmd+Shift+P，两个参照物在这里恰好一致。
    //
    // 🔴 这一条还的是 PLAN 第 77 行那笔 P0 欠账：命令面板从 M1-A 起就在核心功能清单里，
    // 而 M1-A 只交了「命令面板的数据源」（`registry.list()`）——数据源没有入口，等于没有面板。
    // 补上之后，五十来条命令第一次有了「一眼看全」的地方，并且每一行顺带告诉你它绑在哪个键上
    // （`CommandInfo.keybindings` 本来就是格式化好的展示串）。
    // ⚠️ 别把这笔账记成「二十几条命令够不着」：量下来没绑键的只有 7 条，而那几条各有别的入口
    // （`foldKeymap`、面板按钮、侧栏）。清单在 `builtins.test.ts` 的「命令面板自己也在清单里」那条里钉着
    registry.register({
      id: 'commandPalette.open',
      title: '命令面板…',
      category: '视图',
      keybinding: 'Mod+Shift+P',
      run: () => hooks.openCommandPalette(),
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
    registry.register(
      cmCommand('editor.selectAllOccurrences', '选中全部相同内容', selectAllOccurrences, 'Mod+Shift+L'),
    ),
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

    // JSON 格式化 / 压缩（M3-B-2）。直接操作编辑器内容，不打开工具箱面板。
    registry.register({
      id: 'editor.formatJson',
      title: '格式化 JSON',
      category: '编辑器',
      keybinding: 'Mod+Shift+J',
      when: (ctx) => ctx.editor !== null,
      run: (ctx) => {
        const editor = ctx.editor
        if (!editor) return
        const view = editor.view
        const text = view.state.doc.toString()
        if (!text.trim()) return

        try {
          const value = JSON.parse(text)
          const formatted = JSON.stringify(value, null, 2)
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: formatted },
          })
        } catch (err) {
          // 解析失败时不做任何操作，保持原文不动
          console.warn('JSON 格式化失败:', err instanceof Error ? err.message : String(err))
        }
      },
    }),

    registry.register({
      id: 'editor.minifyJson',
      title: '压缩 JSON',
      category: '编辑器',
      keybinding: 'Mod+Alt+J',
      when: (ctx) => ctx.editor !== null,
      run: (ctx) => {
        const editor = ctx.editor
        if (!editor) return
        const view = editor.view
        const text = view.state.doc.toString()
        if (!text.trim()) return

        try {
          const value = JSON.parse(text)
          const minified = JSON.stringify(value)
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: minified },
          })
        } catch (err) {
          // 解析失败时不做任何操作，保持原文不动
          console.warn('JSON 压缩失败:', err instanceof Error ? err.message : String(err))
        }
      },
    }),

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
    // M2-E 之后这条决定被复核过一次，结论不变——理由写在上面「跳转浮层」那一段。

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
