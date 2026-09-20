// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imagePaste, pickPastedImage } from './paste'

/**
 * 走 jsdom 有两个理由：`imagePaste` 要一个真的 `EditorView` 才能派发事件，
 * 而 `pickPastedImage` 挑的东西（`File`）在 node 环境下也没有全局。
 *
 * ⚠️ `imagePaste` 那几条**真的往 DOM 上派发 paste 事件**，然后看正文有没有被插入。
 * 这不是为了仪式感：整条设计押在「插件的 domEventHandlers 排在 CM6 内置处理器之前，
 * 返回 true 就能拦下默认粘贴」这一个实现细节上（论证在 `paste.ts` 的文件头），
 * 而只有真的派发才能同时验住「拦住了」与「没接的时候默认粘贴照旧发生」两半
 */

let views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views = []
})

/** `DataTransfer` 在 jsdom 里造不出来（没有构造器），而我们只用到这四个成员 */
function transfer(options: { text?: string; uri?: string; files?: File[]; items?: DataTransferItem[] }): DataTransfer {
  return {
    getData: (format: string) => (format === 'text/plain' ? (options.text ?? '') : (options.uri ?? '')),
    files: (options.files ?? []) as unknown as FileList,
    items: (options.items ?? []) as unknown as DataTransferItemList,
  } as unknown as DataTransfer
}

function item(kind: 'file' | 'string', type: string, file: File | null): DataTransferItem {
  return { kind, type, getAsFile: () => file } as unknown as DataTransferItem
}

function imageFile(name = 'shot.png', type = 'image/png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type })
}

/** `vi.fn(() => true)` 会把 calls 推成 `[]`，索引取不到东西；把签名写进泛型才有类型 */
type PasteSpy = ReturnType<typeof vi.fn<(file: File, view: EditorView) => boolean>>

function spy(answer: boolean): PasteSpy {
  return vi.fn<(file: File, view: EditorView) => boolean>(() => answer)
}

describe('pickPastedImage', () => {
  it('没有剪贴板数据时不接', () => {
    expect(pickPastedImage(null)).toBeNull()
  })

  it('剪贴板里有正文时一律不接，即使同时也带着一张图', () => {
    // 🔴 这条是整个设计里最要紧的一条：从网页复制一段带插图的文字，
    // 接了图就等于把用户复制的正文吞掉，而他看不到任何提示
    const shot = imageFile()
    expect(pickPastedImage(transfer({ text: '一段话', files: [shot] }))).toBeNull()
  })

  it('files 里的图片是主路径', () => {
    const shot = imageFile()
    expect(pickPastedImage(transfer({ files: [shot] }))).toBe(shot)
  })

  it('files 里混着非图片时跳过它，继续找图片', () => {
    const txt = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const shot = imageFile()
    expect(pickPastedImage(transfer({ files: [txt, shot] }))).toBe(shot)
  })

  it('files 里全是非图片时不接', () => {
    const txt = new File(['hi'], 'a.txt', { type: 'text/plain' })
    expect(pickPastedImage(transfer({ files: [txt] }))).toBeNull()
  })

  it('多张图片时只接第一张', () => {
    // 一次粘贴落两张图要插两行链接，而「粘了三次截图，编辑器里出现三行」与
    // 「粘了一次，出现两行」在用户眼里是两件完全不同的事。宁可少接，不可多插
    const a = imageFile('a.png')
    const b = imageFile('b.png')
    expect(pickPastedImage(transfer({ files: [a, b] }))).toBe(a)
  })

  it('MIME 的大小写不影响判断', () => {
    const shot = imageFile('shot.PNG', 'IMAGE/PNG')
    expect(pickPastedImage(transfer({ files: [shot] }))).toBe(shot)
  })

  it('files 空、图只挂在 items 上时走兜底那条路', () => {
    const shot = imageFile()
    expect(pickPastedImage(transfer({ items: [item('file', 'image/png', shot)] }))).toBe(shot)
  })

  it('items 里 kind 不是 file 的不算', () => {
    const shot = imageFile()
    expect(pickPastedImage(transfer({ items: [item('string', 'image/png', shot)] }))).toBeNull()
  })

  it('items 里 getAsFile 返回 null 时放弃这次粘贴，而不是抛', () => {
    // 那一刻数据已经被取走了，没有第二次机会。放弃的后果是 CM6 走默认路径，
    // 也就是「什么都没插」，比抛出一个被 CM6 吞掉的异常诚实
    expect(pickPastedImage(transfer({ items: [item('file', 'image/png', null)] }))).toBeNull()
  })

  it('items 里的非图片跳过，后面的图片还能挑出来', () => {
    const txt = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const shot = imageFile()
    const picked = pickPastedImage(
      transfer({ items: [item('file', 'text/plain', txt), item('file', 'image/gif', shot)] }),
    )
    expect(picked).toBe(shot)
  })

  it('svg 也接：格式白名单在 Rust 那边，前端只认 image/', () => {
    // ⚠️ 这一条看着像漏了安全，其实相反：接住它才能**说出**为什么不收。
    // 前端拦下来的失败方式是完全静默的一次 ⌘V
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })
    expect(pickPastedImage(transfer({ files: [svg] }))).toBe(svg)
  })

  it('空的剪贴板什么都不接', () => {
    expect(pickPastedImage(transfer({}))).toBeNull()
  })
})

describe('imagePaste', () => {
  function makeView(onImage: (file: File, view: EditorView) => boolean): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions: [imagePaste(onImage)] }),
      parent: document.body,
    })
    views.push(view)
    return view
  }

  /** 派发一个真的 paste 事件，返回派发之后的正文 */
  function paste(view: EditorView, data: DataTransfer): string {
    // jsdom 的 `ClipboardEvent` 构造器不接受 `clipboardData`（那一项被忽略），
    // 所以挂在一个普通 Event 上。CM6 只读这一个属性，不检查事件的具体类型
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    view.contentDOM.dispatchEvent(event)
    return view.state.doc.toString()
  }

  it('只有图片时把文件与 view 一起交给钩子，并且**拦下**默认粘贴', () => {
    const onImage = spy(true)
    const view = makeView(onImage)
    const shot = imageFile()
    expect(paste(view, transfer({ files: [shot] }))).toBe('')
    expect(onImage).toHaveBeenCalledTimes(1)
    expect(onImage.mock.calls[0]?.[0]).toBe(shot)
    // 🔴 递过去的是**收到事件的那个 view**。分屏之下它与「当前活动的那块」可以不是同一个，
    // 而 App 那侧要靠它反查出目标文档（`Workspace.tabOfView`）
    expect(onImage.mock.calls[0]?.[1]).toBe(view)
  })

  it('钩子不接时 CM6 的默认粘贴照样发生', () => {
    // 用 `text/uri-list` 造一个「正文为空但仍有一段可插的文字」的剪贴板：
    // 我们的钩子只看 `text/plain`，所以它照样被问到、照样答 false，
    // 而内置处理器接着把它插进去——「拦不住的那一半没被我们弄坏」于是是可观测的
    const onImage = spy(false)
    const view = makeView(onImage)
    expect(paste(view, transfer({ uri: 'file:///a/b.png', files: [imageFile()] }))).toBe('file:///a/b.png')
    expect(onImage).toHaveBeenCalledTimes(1)
  })

  it('剪贴板里有正文时压根不调钩子，正文照常粘进来', () => {
    const onImage = spy(true)
    const view = makeView(onImage)
    expect(paste(view, transfer({ text: '一段话', files: [imageFile()] }))).toBe('一段话')
    expect(onImage).not.toHaveBeenCalled()
  })

  it('剪贴板里没有图片时压根不调钩子', () => {
    const onImage = spy(true)
    const view = makeView(onImage)
    expect(paste(view, transfer({ text: '只有字' }))).toBe('只有字')
    expect(onImage).not.toHaveBeenCalled()
  })

  it('没装这个扩展时粘贴行为与从前一模一样', () => {
    // 宿主没给钩子就不装（`setup.ts`）。这条钉的是「不装 = 不改变任何既有行为」，
    // 而不是「不装 = 有个空的处理器挂在那儿」
    const view = new EditorView({ state: EditorState.create({ doc: '' }), parent: document.body })
    views.push(view)
    expect(paste(view, transfer({ text: '一段话' }))).toBe('一段话')
  })
})
