import { Show } from 'solid-js'
import { languageFor } from '../editor/language'
import {
  ENCODING_CHOICES,
  ENCODING_IDS,
  ENCODING_LABELS,
  encodingChoiceId,
  LINE_ENDING_IDS,
  LINE_ENDING_LABELS,
  parseEncodingChoice,
  type EncodingId,
  type LineEndingId,
} from '../ipc/fs'
import { UNTITLED_LABEL } from './document'
import type { Workspace } from './workspace'

export interface StatusBarProps {
  workspace: Workspace
}

/** 编码下拉里「一次性动作」那一组的前缀。另一半（保存格式）用 `save:` */
const REOPEN = 'reopen:'
const SAVE = 'save:'

/**
 * 状态栏。口径与 `ws.metrics()` 一致：**只报聚焦分屏显示的那个标签**，不是全部标签的汇总。
 *
 * 语言那一格刻意不复用 `tab.language`——那是个普通字段不是 signal，路径变了或异步子语言
 * 落地时都不会触发重渲染，报出来的会是一个停在过去的语言。`languageFor(path())` 是纯函数
 * 且读的是 signal，显示值与 `syncLanguage` 会装的那个永远一致。
 *
 * 编码与换行符两格是 `<select>`，改的是**保存时用的格式**（`doc.changeFormat`，会标脏）。
 * 编码那一格还兼着「以某编码重新打开」：两组选项塞在同一个下拉里（`<optgroup>`），
 * 因为「我是想换种写法存出去，还是想换种读法重读一遍」是用户在同一个位置上做的同一个
 * 决定的两半，拆成两个入口只会让人猜哪个是哪个。
 *
 * 缩进那一格还是**只显示**：改缩进要先给 `indentUnit` 开一个每标签的 Compartment
 * （和语言槽位同一条理由），而「轻量编辑器里从状态栏改缩进」这件事本身就不是刚需。
 */
export function StatusBar(props: StatusBarProps) {
  // `workspace` 是 createWorkspace() 返回的普通对象（一组访问器），不是 signal；
  // App 只建它一次、也从不换引用，响应式读取全走 `ws.tabs()` 这类访问器，别名不需要被追踪。
  // eslint-disable-next-line solid/reactivity
  const ws = props.workspace
  const doc = () => ws.activeTab().doc
  const m = () => ws.metrics()

  /** 当前保存格式在下拉里对应的那一项。`reopen:` 那组永远不会是选中态 */
  const saveChoice = () => `${SAVE}${encodingChoiceId(doc().format())}`

  function pickEncoding(value: string, select: HTMLSelectElement) {
    // 先拨回去再看要干什么。「重新打开」是一次性动作不是一个状态，而它在**拒绝执行**
    // （有未保存的改动）或失败时不会改 `format()`，于是没有任何重渲染会把下拉复位——
    // 不复位的话下拉会一直显示「以 GBK 重新打开」，看起来像是已经生效了
    select.value = saveChoice()
    if (value.startsWith(REOPEN)) {
      void doc().reopenWith(value.slice(REOPEN.length) as EncodingId)
      return
    }
    const { encoding, bom } = parseEncodingChoice(value.slice(SAVE.length))
    doc().changeFormat({ encoding, bom })
  }

  return (
    <footer class="statusbar">
      <span class="status-cell status-path" title={doc().path() ?? UNTITLED_LABEL}>
        {doc().busy() ? '读写中…' : `${doc().dirty() ? '● ' : ''}${doc().name()}`}
      </span>
      <span class="status-cell" title="主光标的行与列">
        行 {m().line}，列 {m().col}
      </span>
      <Show when={m().selectedChars > 0}>
        <span class="status-cell">选中 {m().selectedChars} 字符</span>
      </Show>
      <Show when={m().selections > 1}>
        <span class="status-cell">{m().selections} 个选区</span>
      </Show>

      <span class="status-spacer" />

      <span class="status-cell" title="缩进">
        {m().indent}
      </span>
      <label class="status-cell status-pick" title="编码">
        <select
          value={saveChoice()}
          disabled={doc().busy()}
          onChange={(e) => pickEncoding(e.currentTarget.value, e.currentTarget)}
        >
          <optgroup label="以…保存">
            {ENCODING_CHOICES.map((c) => (
              <option value={`${SAVE}${encodingChoiceId(c)}`}>{c.label}</option>
            ))}
          </optgroup>
          {/* 无名文档磁盘上没有字节，「重新打开」无从谈起 */}
          <Show when={doc().path()}>
            <optgroup label="以…重新打开">
              {ENCODING_IDS.map((id) => (
                <option value={`${REOPEN}${id}`}>{ENCODING_LABELS[id]}</option>
              ))}
            </optgroup>
          </Show>
        </select>
      </label>
      <label class="status-cell status-pick" title="换行符">
        <select
          value={doc().format().eol}
          disabled={doc().busy()}
          onChange={(e) => doc().changeFormat({ eol: e.currentTarget.value as LineEndingId })}
        >
          {LINE_ENDING_IDS.map((id) => (
            <option value={id}>{LINE_ENDING_LABELS[id]}</option>
          ))}
        </select>
      </label>
      <span class="status-cell" title="语言">
        {languageFor(doc().path()).label}
      </span>
      <span class="status-cell" title="全文行数与字符数">
        {m().lines.toLocaleString()} 行 · {m().chars.toLocaleString()} 字符
      </span>
    </footer>
  )
}
