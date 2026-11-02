// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboardHoldsAnImage, imagePaste, pickPastedImage, readClipboardImage, type PasteData } from './paste'

/**
 * 走 jsdom 有两个理由：`imagePaste` 要一个真的 `EditorView` 才能派发事件，
 * 而 `pickPastedImage` 挑的东西（`File`）在 node 环境下也没有全局。
 *
 * ⚠️ `imagePaste` 那几条**真的往 DOM 上派发 paste 事件**，然后看正文有没有被插入。
 * 这不是为了仪式感：整条设计押在「插件的 domEventHandlers 排在 CM6 内置处理器之前，
 * 返回 true 就能拦下默认粘贴」这一个实现细节上（论证在 `paste.ts` 的文件头），
 * 而只有真的派发才能同时验住「拦住了」与「没接的时候默认粘贴照旧发生」两半
 *
 * 🔴 但这一份**验不了真引擎给不给图**：下面那个 `transfer()` 是手造的假 `DataTransfer`，
 * 「WebKit 把一张 macOS 截图交成了什么形状」只有真机知道。所以 M7-13 那条兜底
 * （`readClipboardImage`）在这里全部靠**注入**验：验的是「读到了就落地、读不到就说一句话」，
 * ⛔ 不是「真机上读得到」
 */

let views: EditorView[] = []

afterEach(() => {
  for (const view of views) view.destroy()
  views = []
})

/**
 * `DataTransfer` 在 jsdom 里造不出来（没有构造器），而我们只用到那四个成员。
 *
 * ⚠️ 四个成员在 [`PasteData`] 里全是可选的，所以「引擎少给一个」是可以直接写出来的形状，
 * 不需要 `as unknown as DataTransfer` 那一路强转（强转会连「成员根本不存在」一起盖住）
 */
function transfer(options: {
  text?: string
  uri?: string
  files?: File[]
  items?: DataTransferItem[]
  types?: string[]
}): PasteData {
  return {
    getData: (format: string) => (format === 'text/plain' ? (options.text ?? '') : (options.uri ?? '')),
    ...(options.files === undefined ? {} : { files: options.files as unknown as FileList }),
    ...(options.items === undefined ? {} : { items: options.items as unknown as DataTransferItemList }),
    ...(options.types === undefined ? {} : { types: options.types }),
  }
}

function item(kind: 'file' | 'string', type: string, file: File | null): DataTransferItem {
  return { kind, type, getAsFile: () => file } as unknown as DataTransferItem
}

function imageFile(name = 'shot.png', type = 'image/png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type })
}

/** `vi.fn(() => true)` 会把 calls 推成 `[]`，索引取不到东西；把签名写进泛型才有类型 */
type PasteSpy = ReturnType<typeof vi.fn<(file: File | null, view: EditorView, types: readonly string[]) => boolean>>

function spy(answer: boolean): PasteSpy {
  return vi.fn<(file: File | null, view: EditorView, types: readonly string[]) => boolean>(() => answer)
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

  it('🔴 引擎连 files / items / types 都没给时不抛，只是不接', () => {
    // `Array.from(undefined)` 抛 `TypeError`，而它抛在 CM6 的 DOM 处理器里会被 CM6 吞掉，
    // 用户看到的是「按了 ⌘V，什么都没发生」——M7-13 那次真机静默的最坏一种可能形状
    expect(pickPastedImage({ getData: () => '' })).toBeNull()
    expect(pickPastedImage({ getData: () => '一段话' })).toBeNull()
  })
})

describe('clipboardHoldsAnImage', () => {
  it('types 里有 image/* 时认', () => {
    expect(clipboardHoldsAnImage(transfer({ types: ['image/png'] }))).toBe(true)
  })

  it('认大小写与别的图像格式', () => {
    expect(clipboardHoldsAnImage(transfer({ types: ['IMAGE/TIFF'] }))).toBe(true)
    expect(clipboardHoldsAnImage(transfer({ types: ['text/html', 'image/jpeg'] }))).toBe(true)
  })

  it('认 Files：那是「有文件项、但 files/items 没给出来」的形状', () => {
    expect(clipboardHoldsAnImage(transfer({ types: ['Files'] }))).toBe(true)
    expect(clipboardHoldsAnImage(transfer({ types: ['files'] }))).toBe(true)
  })

  it('只有文字时不认：那一支必须原样交给 CM6', () => {
    expect(clipboardHoldsAnImage(transfer({ types: ['text/plain'] }))).toBe(false)
    expect(clipboardHoldsAnImage(transfer({ types: ['text/plain', 'text/html'] }))).toBe(false)
  })

  it('types 缺失或为空时不认', () => {
    expect(clipboardHoldsAnImage(transfer({}))).toBe(false)
    expect(clipboardHoldsAnImage({ getData: () => '' })).toBe(false)
  })
})

describe('readClipboardImage', () => {
  function clipItem(types: string[], blob: Blob | null) {
    return { types, getType: async () => blob ?? Promise.reject(new Error('取不出来')) }
  }

  it('这个 webview 没开放 navigator.clipboard.read() 时说清是这一件事', async () => {
    const read = await readClipboardImage(undefined)
    expect(read.kind).toBe('unavailable')
    expect(read).toEqual({ kind: 'unavailable', reason: '这个 webview 没有开放 navigator.clipboard.read()' })
  })

  it('被拒时把引擎那句原文带回来，不翻译成更含糊的中文', async () => {
    const denied = Object.assign(new Error('The request is not allowed.'), { name: 'NotAllowedError' })
    const read = await readClipboardImage(async () => Promise.reject(denied))
    expect(read).toEqual({ kind: 'unavailable', reason: 'NotAllowedError The request is not allowed.' })
  })

  it('读到图片项时包成一个 File，字节与 MIME 原样带过去', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const read = await readClipboardImage(async () => [clipItem(['image/png'], new Blob([bytes]))])
    expect(read.kind).toBe('file')
    if (read.kind !== 'file') return
    expect(read.file.type).toBe('image/png')
    expect(read.file.size).toBe(bytes.length)
    expect(new Uint8Array(await read.file.arrayBuffer())).toEqual(bytes)
  })

  it('剪贴板里只有文字时答 no_image，而不是 unavailable', async () => {
    const read = await readClipboardImage(async () => [clipItem(['text/plain'], new Blob(['hi']))])
    expect(read).toEqual({ kind: 'no_image' })
  })

  it('空清单也是 no_image', async () => {
    expect(await readClipboardImage(async () => [])).toEqual({ kind: 'no_image' })
  })

  it('一项的 getType 读不动时继续试下一项', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff])
    const read = await readClipboardImage(async () => [
      clipItem(['image/png'], null),
      clipItem(['image/jpeg'], new Blob([bytes])),
    ])
    expect(read.kind).toBe('file')
    if (read.kind !== 'file') return
    expect(read.file.type).toBe('image/jpeg')
    expect(read.file.size).toBe(bytes.length)
  })

  it('一项里混着文字与图片时挑图片那个类型去读', async () => {
    const asked: string[] = []
    const read = await readClipboardImage(async () => [
      {
        types: ['text/html', 'image/png'],
        getType: async (type: string) => {
          asked.push(type)
          return new Blob([new Uint8Array([0x89, 0x50])])
        },
      },
    ])
    expect(read.kind).toBe('file')
    expect(asked).toEqual(['image/png'])
  })
})

describe('imagePaste', () => {
  function makeView(onImage: (file: File | null, view: EditorView, types: readonly string[]) => boolean): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions: [imagePaste(onImage)] }),
      parent: document.body,
    })
    views.push(view)
    return view
  }

  /** 派发一个真的 paste 事件，返回派发之后的正文 */
  function paste(view: EditorView, data: PasteData): string {
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
    // 主路径上 types 是空的：那一份清单只在「引擎没交出文件」那一支才有意义
    expect(onImage.mock.calls[0]?.[2]).toEqual([])
  })

  it('🔴 引擎没交出文件、但 types 声称有图时：递 null + 原始 types，并且照样拦下默认粘贴', () => {
    // M7-13 那一次真机静默的正面用例。拦下来不是为了插什么（剪贴板里没有正文，
    // 默认粘贴压根插不出东西），是为了**有机会说一句话**
    const onImage = spy(true)
    const view = makeView(onImage)
    expect(paste(view, transfer({ types: ['image/png', 'Files'] }))).toBe('')
    expect(onImage).toHaveBeenCalledTimes(1)
    expect(onImage.mock.calls[0]?.[0]).toBeNull()
    expect(onImage.mock.calls[0]?.[2]).toEqual(['image/png', 'Files'])
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

  it('🔴 有正文时即使 types 声称有图也不接：那一次粘贴属于文字', () => {
    // 这一条钉的是「正文优先」那条 🔴 规则**没有被兜底绕过**：绕过它的后果是
    // 用户从网页复制一段带插图的文字，正文凭空少一半，而且没有任何提示
    const onImage = spy(true)
    const view = makeView(onImage)
    const data = transfer({ text: '一段话', types: ['text/plain', 'image/png'] })
    expect(paste(view, data)).toBe('一段话')
    expect(onImage).not.toHaveBeenCalled()
  })

  it('剪贴板里没有图片时压根不调钩子', () => {
    const onImage = spy(true)
    const view = makeView(onImage)
    expect(paste(view, transfer({ text: '只有字' }))).toBe('只有字')
    expect(onImage).not.toHaveBeenCalled()
  })

  it('纯文字粘贴（types 里只有 text/plain）不走兜底', () => {
    const onImage = spy(true)
    const view = makeView(onImage)
    expect(paste(view, transfer({ text: '只有字', types: ['text/plain'] }))).toBe('只有字')
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
