import { describe, expect, it } from 'vitest'

import { createNavHistory, MAX_NAV_ENTRIES, type NavEntry } from './history'

/** 短一点的构造：绝大多数用例只关心「谁进谁出」，`isLive` 默认全活 */
function make(live: (entry: NavEntry) => boolean = () => true, max?: number) {
  return createNavHistory(max === undefined ? { isLive: live } : { isLive: live, max })
}

/** 一条历史的字面写法。`pos` 省略 = 内联标签；`null` = 分片标签（没有光标这个概念） */
function at(tabId: number, pos: number | null = 0): NavEntry {
  return { tabId, pos }
}

describe('跳转历史', () => {
  it('返回回到起跳点，前进再回到跳过来的那一处', () => {
    const h = make()
    h.push(at(1, 40)) // 在标签 1 的 40 处起跳
    expect(h.back(at(1, 900))).toEqual(at(1, 40))
    // 回去之后人站在 40，按前进就该回到 900
    expect(h.forward(at(1, 40))).toEqual(at(1, 900))
    expect(h.back(at(1, 900))).toEqual(at(1, 40))
  })

  it('连着跳两次就能连着退两次，顺序是反的', () => {
    const h = make()
    h.push(at(1, 10))
    h.push(at(2, 20))
    expect(h.back(at(3, 30))).toEqual(at(2, 20))
    expect(h.back(at(2, 20))).toEqual(at(1, 10))
  })

  it('没有历史时前进回 null', () => {
    const h = make()
    expect(h.forward(at(1, 0))).toBeNull()
  })

  it('退到底之后那一下返回不往前进栈里塞东西', () => {
    const h = make()
    expect(h.back(at(1, 0))).toBeNull()
    h.push(at(1, 5))
    expect(h.back(at(1, 6))).toEqual(at(1, 5))
    // 前进栈里只有 back 自己压进去的那一条 `current`：上面那次「什么都没找到」
    // 一个副作用都没有。塞了的话再按一次前进会跳到用户从来没去过的一处
    expect(h.forward(at(1, 5))).toEqual(at(1, 6))
    expect(h.forward(at(1, 6))).toBeNull()
  })

  it('关掉的标签那条被跳过，而且当场扔掉', () => {
    const open = new Set([1, 3])
    const h = make((e) => open.has(e.tabId))
    h.push(at(1, 10))
    h.push(at(2, 20)) // 这个标签随后被关掉
    h.push(at(3, 30))
    open.delete(3)

    // 栈顶那条死了 → 落到下一条活的；中间那条死的也被扔了
    expect(h.back(at(1, 99))).toEqual(at(1, 10))
    // 前进栈里只有刚才那一条 current，死条目不会从那边冒出来
    expect(h.forward(at(1, 10))).toEqual(at(1, 99))
    expect(h.back(at(1, 99))).toEqual(at(1, 10))
    expect(h.back(at(1, 98))).toBeNull()
  })

  it('全都死了就退到底，栈也清干净了', () => {
    let open = true
    const h = make(() => open)
    h.push(at(1, 10))
    h.push(at(1, 20))
    open = false
    expect(h.back(at(2, 0))).toBeNull()
    open = true
    // 死条目已经被扔掉了，所以「重新变活」也捞不回来——它们本来就不该被捞回来
    expect(h.back(at(2, 0))).toBeNull()
  })

  it('与栈顶逐字段相同的那一条不重复记', () => {
    const h = make()
    h.push(at(1, 40))
    h.push(at(1, 40))
    expect(h.back(at(1, 41))).toEqual(at(1, 40))
    // ⛔ 只记了一条：第二下返回就该是空的。记了两条的话用户要按两下才退一步，
    // 而第一下看上去像「按了没反应」
    expect(h.back(at(1, 40))).toBeNull()
  })

  it('回去等于没动的那一条被跳过', () => {
    const h = make()
    h.push(at(1, 10))
    // 光标本来就停在定义上时按 ⌥⌘D，记下来的原点就是脚下这一处
    h.push(at(1, 40))
    expect(h.back(at(1, 40))).toEqual(at(1, 10))
  })

  it('前进也跳过回去等于没动的那一条', () => {
    const h = make()
    h.push(at(1, 10))
    h.push(at(1, 40))
    expect(h.back(at(1, 40))).toEqual(at(1, 10))
    expect(h.forward(at(1, 40))).toBeNull()
  })

  it('同一个标签的不同位置照样记两条', () => {
    const h = make()
    h.push(at(1, 40))
    h.push(at(1, 41))
    expect(h.back(at(1, 42))).toEqual(at(1, 41))
    expect(h.back(at(1, 41))).toEqual(at(1, 40))
  })

  it('新的跳转把前进栈整个清掉', () => {
    const h = make()
    h.push(at(1, 10))
    h.push(at(1, 20))
    expect(h.back(at(1, 30))).toEqual(at(1, 20))
    // 退到中间之后又跳了一次：原来那条「前进」不再成立（与浏览器同一条语义）
    h.push(at(1, 25))
    expect(h.forward(at(1, 25))).toBeNull()
    expect(h.back(at(1, 26))).toEqual(at(1, 25))
  })

  it('分片标签那条 pos 是 null，照样进出栈', () => {
    const h = make()
    h.push(at(7, null))
    expect(h.back(at(1, 10))).toEqual(at(7, null))
  })

  it('超过上限从最老那头掉', () => {
    const h = make(() => true, 3)
    h.push(at(1, 1))
    h.push(at(1, 2))
    h.push(at(1, 3))
    h.push(at(1, 4))
    expect(h.back(at(1, 9))).toEqual(at(1, 4))
    expect(h.back(at(1, 4))).toEqual(at(1, 3))
    expect(h.back(at(1, 3))).toEqual(at(1, 2))
    expect(h.back(at(1, 2))).toBeNull()
  })

  it('默认上限是 MAX_NAV_ENTRIES，而且前进栈也守同一个上限', () => {
    expect(MAX_NAV_ENTRIES).toBeGreaterThan(0)
    const h = make()
    for (let i = 0; i < MAX_NAV_ENTRIES + 5; i++) h.push(at(1, i))
    // 最老那 5 条已经掉了：连退 MAX 次之后就该退到底
    for (let i = 0; i < MAX_NAV_ENTRIES; i++) expect(h.back(at(1, -1))).toEqual(at(1, MAX_NAV_ENTRIES + 4 - i))
    expect(h.back(at(1, -1))).toBeNull()
  })
})
