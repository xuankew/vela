// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { LOCAL_IMAGE_CLASS } from './render'
import { LOCAL_IMAGE_SCHEME, localImageUrl, restorePlaceholder, rewriteLocalImages } from './localImage'

/**
 * `./localImage.ts` 这一层的用例：一条 URL 的形状，与占位 ↔ `<img>` 的来回。
 *
 * 三条不能少的：
 *
 * 1. 🔴 **黄金 URL**。协议名与两个参数的编码方式在 Rust（`src-tauri/src/imgproto.rs`）与
 *    这里各写一份，没有代码生成。拼不上的失败方式是「预览里每张本地图都不显示」，
 *    而 webview 对一个加载失败的 `<img>` 一声不吭——所以钉成字面量。
 * 2. 🔴 **正文里那个引用伪造不出第二个查询参数**。`ref` 完全由 `.md` 文本决定，
 *    一份别人发来的文档写着 `![](x.png&doc=/etc) ` 时必须只是一个找不到文件的名字。
 * 3. 🔴 **换不成就回到占位**，而不是留下一张裂图或者干脆消失。
 *
 * ⚠️ 这里验不了「图真的显示出来了」：jsdom 不发请求，`<img>` 的 `load` / `error` 全靠手动
 * 派发。真实加载、真实尺寸与真实排版归真机（见 PLAN.md 的 M7-9 回归清单）
 */

function body(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

/** `render.ts` 对本地图片实际产出的那个占位，逐字照抄它的形状 */
function placeholder(path: string, alt = '图'): string {
  return `<span class="${LOCAL_IMAGE_CLASS}" data-path="${path}" title="${path}">${alt}</span>`
}

describe('localImageUrl：与 Rust 侧的契约', () => {
  it('黄金 URL：协议名、两个参数、全量百分号编码', () => {
    expect(LOCAL_IMAGE_SCHEME).toBe('vela-img')
    expect(localImageUrl('/notes/a.md', 'assets/pasted-0123456789abcdef.png')).toBe(
      'vela-img://localhost/?doc=%2Fnotes%2Fa.md&ref=assets%2Fpasted-0123456789abcdef.png',
    )
  })

  // 🔴 编码集合的钉子：`encodeURIComponent` 会留下 `!~*'()` 这几个不转义，
  // 而 **`&` `=` `/` `?` `#` `%` 一定转**。少了后面这一半，正文就能塞进第二个 `doc`
  it('正文里的引用伪造不出第二个查询参数', () => {
    const url = localImageUrl('/notes/a.md', 'x.png&doc=/etc/passwd#y?z')
    expect(url).not.toContain('&doc=%2Fetc')
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect([...params.keys()]).toEqual(['doc', 'ref'])
    // 解回来的必须与递进去的**逐字相同**：Rust 那一边按同样的口径解码
    expect(params.get('ref')).toBe('x.png&doc=/etc/passwd#y?z')
  })

  it('带空格与中文的路径都能原样绕回来', () => {
    const doc = '/Users/我 的笔记/a b.md'
    const params = new URLSearchParams(localImageUrl(doc, '截图 1.png').split('?')[1])
    expect(params.get('doc')).toBe(doc)
    expect(params.get('ref')).toBe('截图 1.png')
  })
})

describe('rewriteLocalImages：占位 → <img>', () => {
  it('换掉一张，src 走协议，data-path 与 alt 和 title 都留着', () => {
    const el = body(placeholder('assets/a.png'))
    expect(rewriteLocalImages(el, '/notes/a.md')).toBe(1)

    const img = el.querySelector('img')!
    expect(img).not.toBeNull()
    // ⚠️ 读 `getAttribute` 而不是 `.src`：后者是「解析成绝对 URL 之后」的形式，
    // 什么协议都会给它补一个 base，于是这条黄金断言量的就不是我们写进去的那串字符了
    expect(img.getAttribute('src')).toBe('vela-img://localhost/?doc=%2Fnotes%2Fa.md&ref=assets%2Fa.png')
    expect(img.dataset.path).toBe('assets/a.png')
    expect(img.alt).toBe('图')
    expect(img.title).toBe('assets/a.png')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(el.querySelector(`.${LOCAL_IMAGE_CLASS}`)).toBeNull()
  })

  it('几张占位全换，一张都不落', () => {
    const el = body(`${placeholder('assets/a.png')}<p>中间</p>${placeholder('assets/b.png', '另一张')}`)
    expect(rewriteLocalImages(el, '/notes/a.md')).toBe(2)
    expect(el.querySelectorAll('img')).toHaveLength(2)
  })

  // ⚠️ 没落盘的缓冲区没有目录可参照，Rust 一定回 400。不换不是漏了，是省掉一次
  // 「发请求 → 失败 → 换回占位」的白闪
  it('文档路径是 null 或空串时一张都不换', () => {
    for (const path of [null, '']) {
      const el = body(placeholder('assets/a.png'))
      expect(rewriteLocalImages(el, path)).toBe(0)
      expect(el.querySelector('img')).toBeNull()
      expect(el.querySelector(`.${LOCAL_IMAGE_CLASS}`)).not.toBeNull()
    }
  })

  it('data-path 是空串的不换：那是个压根不该发出去的请求', () => {
    const el = body(placeholder(''))
    expect(rewriteLocalImages(el, '/notes/a.md')).toBe(0)
    expect(el.querySelector('img')).toBeNull()
  })
})

describe('restorePlaceholder：加载失败回到占位', () => {
  function makeImg(path: string | null, alt = '图'): HTMLImageElement {
    const img = document.createElement('img')
    if (path !== null) img.dataset.path = path
    img.alt = alt
    img.title = path ?? ''
    return img
  }

  it('换回带的 class、data-path、title 与文字都和原来那个占位一样', () => {
    const el = body('')
    const img = makeImg('assets/a.png')
    el.append(img)

    expect(restorePlaceholder(img)).toBe(true)
    const span = el.querySelector<HTMLElement>(`.${LOCAL_IMAGE_CLASS}`)!
    expect(span).not.toBeNull()
    expect(span.dataset.path).toBe('assets/a.png')
    expect(span.title).toBe('assets/a.png')
    expect(span.textContent).toBe('图')
    expect(el.querySelector('img')).toBeNull()
  })

  it('alt 是空的占位文字用「图片」，与 render.ts 同一条口径', () => {
    const el = body('')
    const img = makeImg('assets/a.png', '')
    el.append(img)
    restorePlaceholder(img)
    expect(el.querySelector(`.${LOCAL_IMAGE_CLASS}`)?.textContent).toBe('图片')
  })

  // 🔴 外链 `<img>` 加载失败**不是**这一层的事：它没有 `data-path`，换成都没有意义，
  // 而把它换成占位等于谎报「这是一张本地图片」
  it('不是本地图的元素一律不动，返回 false', () => {
    const el = body('<img src="https://e.com/a.png" alt="外链">')
    expect(restorePlaceholder(el.querySelector('img'))).toBe(false)
    expect(el.querySelector('img')).not.toBeNull()

    expect(restorePlaceholder(null)).toBe(false)
    expect(restorePlaceholder(document.createElement('span'))).toBe(false)
  })
})
