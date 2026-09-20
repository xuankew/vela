import { describe, expect, it } from 'vitest'
import { filterProjects, projectLabel, projectWhere } from './projects'

/**
 * `Cmd+Shift+O` 那一栏候选的字符串算术。
 *
 * 这一层刻意不碰 store：清单从哪来、当前工作区排不排得掉，都在
 * `src/project/store.ts` 的 `recentProjects` 里钉过了（那里有单独一组用例）。
 * 这里只回答「一条根清单该被画成什么样」。
 */
describe('projectLabel', () => {
  it('单根就是那个文件夹的名字', () => {
    expect(projectLabel(['/Users/me/code/vela'])).toBe('vela')
    // 末尾斜杠由 displayName 处理，这里不另写一套
    expect(projectLabel(['/Users/me/code/vela/'])).toBe('vela')
  })

  it('多根是「第一个的名字 + 还有几个」，而不是把三个长名字排成一行', () => {
    expect(projectLabel(['/Users/me/code/vela', '/Users/me/notes', '/Users/me/docs'])).toBe('vela +2')
    expect(projectLabel(['/a', '/b'])).toBe('a +1')
  })

  it('空清单给空串：那种条目在 restoreRecent 里就被摘掉了，这里只是不让它画出 undefined', () => {
    expect(projectLabel([])).toBe('')
  })
})

describe('projectWhere', () => {
  it('是第一个根的父目录，不是它自己', () => {
    expect(projectWhere(['/Users/me/code/vela'])).toBe('/Users/me/code')
    expect(projectWhere(['/Users/me/code/vela', '/Users/me/notes'])).toBe('/Users/me/code')
  })

  it('根目录下的文件夹，父层如实是一个斜杠而不是空串', () => {
    expect(projectWhere(['/vela'])).toBe('/')
  })

  it('没有斜杠或空清单都给空串：那一格不画，好过画一个错的父目录', () => {
    expect(projectWhere(['vela'])).toBe('')
    expect(projectWhere([])).toBe('')
  })

  it('⚠️ 两个同名项目靠它分开——这一格存在的全部理由', () => {
    const work = ['/Users/me/work/app']
    const side = ['/Users/me/side/app']
    expect(projectLabel(work)).toBe(projectLabel(side))
    expect(projectWhere(work)).not.toBe(projectWhere(side))
  })
})

describe('filterProjects', () => {
  const entries: (readonly string[])[] = [
    ['/Users/me/code/vela'],
    ['/Users/me/Notes'],
    ['/Users/me/work/app', '/Users/me/side/app'],
  ]

  it('空串回全表：Cmd+Shift+O 刚打开时输入框是空的', () => {
    expect(filterProjects(entries, '')).toEqual(entries)
  })

  it('大小写不敏感的子串匹配，规则与 filterSymbols 逐字相同', () => {
    expect(filterProjects(entries, 'vela')).toEqual([['/Users/me/code/vela']])
    expect(filterProjects(entries, 'NOTES')).toEqual([['/Users/me/Notes']])
  })

  it('⚠️ 匹配的是完整路径而不只是名字：用户记得住的是 ~/work/app', () => {
    // 只比名字的话这一条会得到空列表，而那看起来像「这个项目压根没被记下来」
    expect(filterProjects(entries, 'work')).toEqual([['/Users/me/work/app', '/Users/me/side/app']])
    expect(filterProjects(entries, 'me/side')).toEqual([['/Users/me/work/app', '/Users/me/side/app']])
  })

  it('多根清单里**任何**一个根命中，整条就留下——切过去是要切整份工作区', () => {
    expect(filterProjects(entries, 'side')).toEqual([['/Users/me/work/app', '/Users/me/side/app']])
  })

  it('没有命中就是空数组，顺序原样保留', () => {
    expect(filterProjects(entries, 'zzz')).toEqual([])
    expect(filterProjects(entries, '/users/me')).toEqual(entries)
  })

  it('空清单过滤出空清单，不抛', () => {
    expect(filterProjects([], 'vela')).toEqual([])
  })
})
