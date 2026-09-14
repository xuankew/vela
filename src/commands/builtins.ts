import { foldAll, unfoldAll } from '@codemirror/language'
import type { CommandRegistry } from './registry'

/**
 * 命令需要的宿主能力。
 *
 * 用注入而不是让命令直接 import App 的状态：命令定义是架构地基，
 * 一旦反向依赖具体组件，就没法单测、也没法在将来的插件宿主里复用。
 */
export interface BuiltinHooks {
  /** 打开文件。M1-B 换成 Rust 侧原生对话框，当前仍走 `<input type=file>` */
  openFile: () => void
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
}

/**
 * 注册内置命令。返回统一的注销函数。
 *
 * 折叠/展开刻意**不绑快捷键**：CM6 的 `foldKeymap` 已经绑了 `Cmd/Ctrl+Shift+[` `]`
 * 折叠当前区块，再绑一套只会制造冲突。这两条命令的价值是让折叠能被命令面板与
 * 将来的菜单栏调用——那正是「所有功能走同一个注册表」的意义。
 */
export function registerBuiltinCommands(registry: CommandRegistry, hooks: BuiltinHooks): () => void {
  const dispose = [
    registry.register({
      id: 'file.open',
      title: '打开文件…',
      category: '文件',
      keybinding: 'Mod+O',
      run: () => hooks.openFile(),
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
