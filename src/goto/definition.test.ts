import { describe, expect, it } from 'vitest'
import { clickAction, type DefinitionResult } from './definition'

/**
 * `clickAction`：`Cmd/Ctrl+Click` 那一下的三路分流（M5-2）。
 *
 * 这一组用例钉的是**一个既有手势的边界**，不是新功能：回 `ignore` 意味着 CM6 自己的
 * mousedown 照旧跑，那一下仍然是「加一个光标」（`editor/multiCursor.ts` 的手势表）。
 * 所以这里每一条 `ignore` 都是在说「这一次点击不归跳定义管」，改坏了不会报错，
 * 只会表现为加光标莫名其妙不灵——那种坏法在别的用例里看不见。
 *
 * ⚠️ 查询那一半（`definitionAt`）不在这儿测：它要真的语法树，端到端那组用例在
 * `editor/clickJump.test.ts` 里，从 `createViewConfig` 一路建到派发 mousedown。
 * 这里只喂**已经查完的结果**，因为分流只依赖那四种 `kind`。
 */

/** 造一个查询结果，省掉每条用例里重复的形状 */
const at = (pos: number): DefinitionResult => ({ kind: 'at', pos })
const notFound = (word: string, table: 'headings' | 'code'): DefinitionResult => ({
  kind: 'notFound',
  word,
  table,
})

describe('clickAction：这一下归谁', () => {
  it('查到了就跳，与有没有打开文件夹无关', () => {
    expect(clickAction(at(42), true)).toEqual({ kind: 'jump', pos: 42 })
    expect(clickAction(at(42), false)).toEqual({ kind: 'jump', pos: 42 })
  })

  it('代码文件里查不到：改去项目里搜那个词', () => {
    expect(clickAction(notFound('createWorkspace', 'code'), true)).toEqual({
      kind: 'search',
      word: 'createWorkspace',
    })
  })

  it('标题表里查不到：什么都不做，那一下仍然是加光标', () => {
    // 🔴 这一条是笔记优先的直接后果。Markdown 的符号表就是标题，正文里**随便一个词**
    // 都查不到——拿它去搜项目的话，在笔记里 Cmd+点击一个词就弹一次搜索面板
    expect(clickAction(notFound('项目结构', 'headings'), true)).toEqual({ kind: 'ignore' })
  })

  it('没打开文件夹：什么都不做，无处可搜就别弹面板', () => {
    // `search()` 在 roots 为空时只会把面板展开成一句「还没打开文件夹」
    // （`search/store.ts:554`），为一次点击弹这个是纯噪音
    expect(clickAction(notFound('createWorkspace', 'code'), false)).toEqual({ kind: 'ignore' })
  })

  it('另外两种查询结果一律什么都不做', () => {
    // `noWord` = 点在空白或标点上，`noTable` = 这门语言没有符号表（JSON、纯文本）。
    // 两种都没有「词」可拿去搜，也就没有第二条路可走
    expect(clickAction({ kind: 'noWord' }, true)).toEqual({ kind: 'ignore' })
    expect(clickAction({ kind: 'noTable', label: 'JSON' }, true)).toEqual({ kind: 'ignore' })
  })
})
