/**
 * Markdown 编辑工具栏（M4-F）。
 *
 * 提供常用的 Markdown 格式化操作，挂在编辑器上方。
 * 支持显示/隐藏，按钮根据当前选区智能启用/禁用。
 *
 * 右端另有一个「预览 / 编辑」开关：并排（左写右看）与只预览（藏掉编辑区）之间来回。
 * 它就是 `Cmd+Shift+V` 那条三档循环的**前两档**，不新增命令、也不新增形态——
 * 只是把「用户得先知道快捷键存在」的那个入口摆到看得见的地方。
 * ⚠️ 阅读模式下格式按钮全部禁用：它们会改一块用户看不见的 buffer，
 * 改了没反应（或者更糟，改错了地方）比按不动更难查。
 */

import type { EditorController } from '../editor/controller'
import type { PreviewMode } from './previewMode'

export interface MarkdownToolbarProps {
  /** 当前编辑器实例 */
  editor: () => EditorController | null
  /** 点击关闭按钮时隐藏工具栏 */
  onToggle: () => void
  /** 预览那一栏此刻的形态（`md/previewMode.ts` 的三档） */
  previewMode: () => PreviewMode
  /** 这份文档此刻有没有预览可看：`.ts`、只读大文件分片都没有 */
  previewAvailable: () => boolean
  /** 「预览 / 编辑」按钮的落点：并排 ↔ 只预览 */
  onPreviewMode: (mode: PreviewMode) => void
}

/** 工具栏按钮定义 */
interface ToolbarButton {
  id: string
  title: string
  icon: string
  shortcut?: string
  action: (editor: EditorController) => void
}

/**
 * 在光标位置或选区周围插入标记。
 * 如果已有选区，则在选区前后插入；否则在光标处插入占位符。
 */
function insertAround(editor: EditorController, before: string, after: string, placeholder = '文本'): void {
  const view = editor.view
  if (!view) return

  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const text = selected || placeholder

  const insert = `${before}${text}${after}`
  const newFrom = from + before.length
  const newTo = newFrom + text.length

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: newFrom, head: newTo },
  })
  view.focus()
}

/**
 * 在行首插入前缀（如列表标记、引用标记）。
 * 对多行选区逐行处理。
 */
function insertLinePrefix(editor: EditorController, prefix: string): void {
  const view = editor.view
  if (!view) return

  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from)
  const endLine = view.state.doc.lineAt(to)

  const changes = []
  for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo++) {
    const line = view.state.doc.line(lineNo)
    changes.push({ from: line.from, insert: prefix })
  }

  view.dispatch({ changes })
  view.focus()
}

/** 所有工具栏按钮 */
const BUTTONS: ToolbarButton[] = [
  {
    id: 'bold',
    title: '粗体 (Ctrl+B)',
    icon: '𝐁',
    shortcut: 'Mod+B',
    action: (ed) => insertAround(ed, '**', '**', '粗体文本'),
  },
  {
    id: 'italic',
    title: '斜体 (Ctrl+I)',
    icon: '𝐼',
    shortcut: 'Mod+I',
    action: (ed) => insertAround(ed, '*', '*', '斜体文本'),
  },
  {
    id: 'strikethrough',
    title: '删除线',
    icon: 'S̶',
    action: (ed) => insertAround(ed, '~~', '~~', '删除文本'),
  },
  {
    id: 'heading1',
    title: '一级标题',
    icon: 'H1',
    action: (ed) => insertLinePrefix(ed, '# '),
  },
  {
    id: 'heading2',
    title: '二级标题',
    icon: 'H2',
    action: (ed) => insertLinePrefix(ed, '## '),
  },
  {
    id: 'heading3',
    title: '三级标题',
    icon: 'H3',
    action: (ed) => insertLinePrefix(ed, '### '),
  },
  {
    id: 'bullet-list',
    title: '无序列表',
    icon: '•',
    action: (ed) => insertLinePrefix(ed, '- '),
  },
  {
    id: 'numbered-list',
    title: '有序列表',
    icon: '1.',
    action: (ed) => insertLinePrefix(ed, '1. '),
  },
  {
    id: 'task-list',
    title: '任务列表',
    icon: '☐',
    action: (ed) => insertLinePrefix(ed, '- [ ] '),
  },
  {
    id: 'quote',
    title: '引用',
    icon: '❝',
    action: (ed) => insertLinePrefix(ed, '> '),
  },
  {
    id: 'code-inline',
    title: '行内代码（`代码`）',
    icon: '</>',
    action: (ed) => insertAround(ed, '`', '`', '代码'),
  },
  {
    id: 'code-block',
    title: '代码块（``` 围栏，可多行）',
    icon: '```',
    action: (ed) => {
      const view = ed.view
      if (!view) return
      const { from, to } = view.state.selection.main
      const selected = view.state.sliceDoc(from, to)
      const text = selected || '代码'
      const insert = `\`\`\`\n${text}\n\`\`\``
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + 4, head: from + 4 + text.length },
      })
      view.focus()
    },
  },
  {
    id: 'link',
    title: '链接',
    icon: '🔗',
    action: (ed) => {
      const view = ed.view
      if (!view) return
      const { from, to } = view.state.selection.main
      const selected = view.state.sliceDoc(from, to)
      const text = selected || '链接文本'
      const insert = `[${text}](url)`
      const urlStart = from + text.length + 3
      const urlEnd = urlStart + 3
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: urlStart, head: urlEnd },
      })
      view.focus()
    },
  },
  {
    id: 'image',
    title: '图片',
    icon: '🖼',
    action: (ed) => {
      insertAround(ed, '![alt](', ')', '图片地址')
    },
  },
  {
    id: 'table',
    title: '表格',
    icon: '⊞',
    action: (ed) => {
      const table = `| 列1 | 列2 | 列3 |
| --- | --- | --- |
| 单元格 | 单元格 | 单元格 |
| 单元格 | 单元格 | 单元格 |`
      const view = ed.view
      if (!view) return
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: table },
        selection: { anchor: from, head: from },
      })
      view.focus()
    },
  },
  {
    id: 'horizontal-rule',
    title: '分隔线',
    icon: '—',
    action: (ed) => {
      const view = ed.view
      if (!view) return
      const { from } = view.state.selection.main
      view.dispatch({
        changes: { from, insert: '\n---\n' },
        selection: { anchor: from + 5, head: from + 5 },
      })
      view.focus()
    },
  },
]

export function MarkdownToolbar(props: MarkdownToolbarProps) {
  /** 此刻真的在「只预览」里：文档没有预览可看时那一档会降级成并排，不算 */
  const previewOnly = () => props.previewMode() === 'only' && props.previewAvailable()

  const modeTitle = () => {
    if (!props.previewAvailable()) return '这个文件没有 Markdown 预览'
    return previewOnly() ? '回到左编辑、右预览' : '只看预览（隐藏编辑区）'
  }

  return (
    <div class="md-toolbar" role="toolbar" aria-label="Markdown 工具栏">
      <div class="md-toolbar-toggle">
        <button
          class="md-toolbar-toggle-btn"
          onClick={() => props.onToggle()}
          title="隐藏工具栏"
          aria-label="隐藏工具栏"
        >
          ✕
        </button>
      </div>
      <div class="md-toolbar-buttons">
        {BUTTONS.map((btn) => (
          <button
            class="md-toolbar-btn"
            title={previewOnly() ? '预览模式下不能编辑，先切回「编辑」' : btn.title}
            aria-label={btn.title}
            disabled={previewOnly()}
            onClick={() => {
              const ed = props.editor()
              if (ed) btn.action(ed)
            }}
          >
            {btn.icon}
          </button>
        ))}
      </div>
      {/* 放在最右：它是「换整个视图形态」，和左边那一排「往正文里插东西」不是一类动作，
          离得远一点不容易误点。文案说的是**点下去会到哪儿**（与菜单项的时态一致） */}
      <button
        class="md-toolbar-btn md-toolbar-mode"
        title={modeTitle()}
        aria-label={previewOnly() ? '编辑' : '预览'}
        aria-pressed={previewOnly()}
        disabled={!props.previewAvailable()}
        onClick={() => props.onPreviewMode(previewOnly() ? 'side' : 'only')}
      >
        {previewOnly() ? '编辑' : '预览'}
      </button>
    </div>
  )
}
