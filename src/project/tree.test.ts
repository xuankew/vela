import { describe, expect, it } from 'vitest'

/**
 * 树的纯逻辑单测。跑在 node 环境（见 `vitest.config.ts` 的 `environment: 'node'`）：
 * 这些函数对 DOM 的要求是零，挂 jsdom 只会让用例慢一倍、还多一层「到底是逻辑错了
 * 还是 jsdom 又不支持某个 API」的排查成本。
 *
 * 组件层（`Sidebar.tsx`）的测试是另一件事，那边才需要 jsdom。
 */

import type { DirEntry } from '../ipc/project'
import {
  actionForKey,
  childRel,
  containerRel,
  displayName,
  flattenRows,
  menuFor,
  OVERSCAN,
  parentRel,
  ROW_HEIGHT,
  type TreeMenuAction,
  type TreeRow,
  type TreeSnapshot,
  visibleWindow,
} from './tree'

function entry(name: string, rel: string, isDir = false): DirEntry {
  return { name, rel, path: `/repo/${rel}`, isDir }
}

/**
 * 一棵固定的小树，后面所有用例都从它出发。
 *
 * ```
 * repo/
 *   src/          摊开
 *     main.rs
 *     lib.rs
 *   README.md
 *   empty/        摊开，但一个条目都没有
 * ```
 */
const FIXTURE: TreeSnapshot = {
  rootName: 'repo',
  rootPath: '/repo',
  listings: new Map<string, DirEntry[]>([
    ['', [entry('src', 'src', true), entry('README.md', 'README.md'), entry('empty', 'empty', true)]],
    ['src', [entry('main.rs', 'src/main.rs'), entry('lib.rs', 'src/lib.rs')]],
    ['empty', []],
  ]),
  expanded: new Set(['', 'src', 'empty']),
  loading: new Set(),
  errors: new Map(),
}

function snapshotOf(overrides: Partial<TreeSnapshot>): TreeSnapshot {
  return { ...FIXTURE, ...overrides }
}

function rels(rows: readonly TreeRow[]): string[] {
  return rows.map((r) => r.rel)
}

function depths(rows: readonly TreeRow[]): number[] {
  return rows.map((r) => r.depth)
}

describe('flattenRows：结构', () => {
  it('根没摊开时只有根行自己', () => {
    const rows = flattenRows(snapshotOf({ expanded: new Set() }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      rel: '',
      name: 'repo',
      path: '/repo',
      isDir: true,
      depth: 0,
      expanded: false,
      loading: false,
      error: null,
    })
  })

  it('根摊开后按 listings 的原样顺序产出子行——前端不重排', () => {
    const rows = flattenRows(snapshotOf({ expanded: new Set(['']) }))
    // 排序是 Rust 侧的事（文件夹优先 → 不区分大小写 → 字节兜底），已经钉在
    // `crates/vela-core/src/project/tree.rs` 的测试里。前端再排一次就等于有两个真相，
    // 而两边规则只要差一点，「刷新之后顺序变了」这种 bug 就查不动了
    expect(rels(rows)).toEqual(['', 'src', 'README.md', 'empty'])
    expect(depths(rows)).toEqual([0, 1, 1, 1])
  })

  it('摊开且已取回的多层：深度一路加下去，顺序是深度优先', () => {
    const rows = flattenRows(FIXTURE)
    expect(rels(rows)).toEqual(['', 'src', 'src/main.rs', 'src/lib.rs', 'README.md', 'empty'])
    expect(depths(rows)).toEqual([0, 1, 2, 2, 1, 1])
  })

  it('⚠️ 折叠的目录不递归进去，即便它的条目已经在 listings 里', () => {
    // 这条钉的是「按需列举」在前端的那一半：listings 是个缓存，里面可能存着
    // 一个此刻折叠着的目录的条目（用户摊开过又收起来了）。把它渲染出来就等于
    // 展开状态失效，而缓存里有 10 万条时整个虚拟化也就跟着失效了
    const rows = flattenRows(snapshotOf({ expanded: new Set(['']) }))
    expect(rels(rows)).not.toContain('src/main.rs')
    expect(rows.find((r) => r.rel === 'src')?.expanded).toBe(false)
  })

  it('摊开了但条目还没回来：只产出该层自己，并带上 loading', () => {
    const rows = flattenRows(
      snapshotOf({
        listings: new Map(),
        expanded: new Set(['']),
        loading: new Set(['']),
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.loading).toBe(true)
    expect(rows[0]?.error).toBeNull()
  })

  it('不补「读取中…」占位行：行数在数据到达时不该跳', () => {
    const loading = flattenRows(snapshotOf({ listings: new Map(), loading: new Set(['']) }))
    const arrived = flattenRows(snapshotOf({ expanded: new Set(['']) }))
    expect(loading).toHaveLength(1)
    // 数据到达之后行数从 1 变成 4，而不是从 2（根 + 占位）变成 4。
    // 占位行会让滚动条在每一层展开时都抽动一下
    expect(arrived).toHaveLength(4)
  })

  it('错误落在出错的那一层，别层是 null', () => {
    const rows = flattenRows(snapshotOf({ errors: new Map([['src', '权限不够']]) }))
    expect(rows.find((r) => r.rel === 'src')?.error).toBe('权限不够')
    expect(rows.find((r) => r.rel === '')?.error).toBeNull()
    expect(rows.find((r) => r.rel === 'src/main.rs')?.error).toBeNull()
  })

  it('刷新失败时旧条目照常列出：error 与 entries 共存', () => {
    // 「刷新一下」失败不该把已经看见的内容抹成空白——用户会以为文件没了。
    // 出错的那一行自己会说一句话，两件事并不冲突
    const rows = flattenRows(snapshotOf({ errors: new Map([['src', '读取中失败了']]) }))
    expect(rels(rows)).toEqual(['', 'src', 'src/main.rs', 'src/lib.rs', 'README.md', 'empty'])
    expect(rows.find((r) => r.rel === 'src')?.error).toBe('读取中失败了')
  })

  it('文件行的 expanded / loading / error 恒为默认值', () => {
    for (const row of flattenRows(FIXTURE)) {
      if (row.isDir) continue
      expect(row.expanded).toBe(false)
      expect(row.loading).toBe(false)
      expect(row.error).toBeNull()
    }
  })

  it('空目录摊开后不多出任何行', () => {
    const rows = flattenRows(FIXTURE)
    const at = rels(rows).indexOf('empty')
    expect(at).toBe(rows.length - 1)
    expect(rows[at]?.expanded).toBe(true)
  })
})

describe('displayName：从绝对路径抠出标签', () => {
  it('常规路径取最后一段', () => {
    expect(displayName('/Volumes/data/dev/Vela')).toBe('Vela')
  })

  it('末尾多一个斜杠也算得对', () => {
    // dialog 不会给出带斜杠的路径，但会话存档是磁盘上的 JSON，
    // 可能被别的版本写过、也可能被用户手改过
    expect(displayName('/repo/Vela/')).toBe('Vela')
    expect(displayName('/repo/Vela///')).toBe('Vela')
  })

  it('根目录与裸名字不会得到空标签', () => {
    expect(displayName('/')).toBe('/')
    expect(displayName('Vela')).toBe('Vela')
  })

  it('中文名、空格、点号原样保留', () => {
    expect(displayName('/Users/我/我的 项目.d')).toBe('我的 项目.d')
  })
})

describe('childRel / parentRel：rel 的拼与拆', () => {
  it('⚠️ 根层新建得到的是名字本身，不是以斜杠开头的 rel', () => {
    // 这一条是整个函数的存在理由。`'' + '/' + name` 会得到 `"/foo.txt"`，
    // 而 Rust 侧的 `resolve` 把以 `/` 开头的 rel 当绝对路径拒掉——用户新建一个文件，
    // 屏幕上出现的却是一句「内部错误：相对路径越出了项目根目录」
    expect(childRel('', '新建.md')).toBe('新建.md')
    expect(childRel('', 'src')).toBe('src')
  })

  it('子层用 / 连接，与 DirEntry.rel 的分隔符一致', () => {
    expect(childRel('src', 'main.rs')).toBe('src/main.rs')
    expect(childRel('src/deep', 'a.ts')).toBe('src/deep/a.ts')
  })

  it('parentRel 是它的反向', () => {
    for (const [parent, name] of [
      ['', '新建.md'],
      ['src', 'main.rs'],
      ['src/deep', 'a.ts'],
    ] as const) {
      const rel = childRel(parent, name)
      expect(parentRel(rel)).toBe(parent)
      // 拆出来的最后一段就是 displayName 在绝对路径上做的那件事，只是对象换成了 rel
      expect(rel.slice(rel.lastIndexOf('/') + 1)).toBe(name)
    }
  })

  it('根层与根的直接子项都得到空父层', () => {
    expect(parentRel('')).toBe('')
    expect(parentRel('README.md')).toBe('')
  })

  it('名字里带空格、中文、% 与 # 时不参与任何转义', () => {
    // rel 是原样递给 Rust 的字符串，不是 URL 也不是 shell 参数：
    // 在这一层做任何编码都会让 Rust 侧真的去建一个名字里带百分号的文件
    expect(childRel('我的 项目', '说明 文档.md')).toBe('我的 项目/说明 文档.md')
    expect(parentRel('我的 项目/说明 文档.md')).toBe('我的 项目')
    expect(childRel('', '100% #1 draft.md')).toBe('100% #1 draft.md')
    expect(parentRel('src/100% #1 draft.md')).toBe('src')
  })
})

describe('containerRel / menuFor：右键一行该给出什么', () => {
  const rows = flattenRows(FIXTURE)
  // ['', 'src', 'src/main.rs', 'src/lib.rs', 'README.md', 'empty']

  function rowOf(rel: string): TreeRow {
    const row = rows.find((r) => r.rel === rel)
    if (!row) throw new Error(`FIXTURE 里没有 rel='${rel}' 的那一行`)
    return row
  }

  function actionsOf(row: TreeRow): TreeMenuAction[] {
    return menuFor(row).map((i) => i.action)
  }

  it('⚠️ 根行的菜单里没有「重命名…」也没有「移到废纸篓」', () => {
    // 那两项落在根行上的含义是「把用户整个项目文件夹改名」与「把整个项目文件夹扔进废纸篓」。
    // 这条规则被刻意放在纯函数层而不是渲染时写个 `<Show when={row.rel !== ''}>`：
    // 改一次渲染就能把后者改掉，而 `store.trash('')` 里那道拦截只是最后一道网——
    // 网兜住的是「没做成」，兜不住「菜单上摆着一项吓人的东西」
    expect(actionsOf(rowOf(''))).toEqual(['newFile', 'newFolder', 'reveal', 'copyPath'])
  })

  it('目录行与文件行都是六项，顺序一致', () => {
    const six: TreeMenuAction[] = ['newFile', 'newFolder', 'rename', 'trash', 'reveal', 'copyPath']
    expect(actionsOf(rowOf('src'))).toEqual(six)
    expect(actionsOf(rowOf('src/main.rs'))).toEqual(six)
    // 空目录与普通目录没有区别：里面没东西不妨碍在它里面新建
    expect(actionsOf(rowOf('empty'))).toEqual(six)
  })

  it('分隔线画在「重命名…」与「在 Finder 中显示」上面：分的是「会不会改磁盘」', () => {
    const seps = (row: TreeRow) =>
      menuFor(row)
        .filter((i) => i.separator)
        .map((i) => i.action)
    expect(seps(rowOf('src'))).toEqual(['rename', 'reveal'])
    // 根行少了中间那组，但「新建 | Finder」这条线还在
    expect(seps(rowOf(''))).toEqual(['reveal'])
  })

  it('⚠️ 移到废纸篓那一项不带省略号，文案也不说「删除」', () => {
    const items = menuFor(rowOf('src'))
    const trash = items.find((i) => i.action === 'trash')!
    // 没有省略号：它不打开对话框，点下去当场就做完了。省略号在 macOS 上是
    // 「还要再问你一句」的意思，标错了用户会等着那个永远不会来的确认框
    expect(trash.label).toBe('移到废纸篓')
    expect(trash.label).not.toContain('删除')
    // 反过来，会打开对话框的那一项必须带省略号
    expect(items.find((i) => i.action === 'rename')!.label).toBe('重命名…')
    // 「在 Finder 中显示」与「复制路径」都是当场做完的，也都不带
    expect(items.find((i) => i.action === 'reveal')!.label).toBe('在 Finder 中显示')
    expect(items.find((i) => i.action === 'copyPath')!.label).toBe('复制路径')
  })

  it('containerRel：目录行是它自己，文件行是它的父层', () => {
    expect(containerRel(rowOf('src'))).toBe('src')
    expect(containerRel(rowOf('src/main.rs'))).toBe('src')
    expect(containerRel(rowOf('README.md'))).toBe('')
    expect(containerRel(rowOf(''))).toBe('')
  })

  it('⚠️ 文件行给出的容器层拼出来是「旁边」，不是「里面」', () => {
    // 右键一个文件选「新建文件」，新文件应该出现在它旁边——文件没有里面。
    // 把文件行自己当目标层的话 `childRel` 会拼出 `src/main.rs/新文件.md`，
    // Rust 侧回一句 `not_a_directory`，用户看到的是「新建失败」而不是「建在了对的地方」
    expect(childRel(containerRel(rowOf('src/main.rs')), '新文件.md')).toBe('src/新文件.md')
    expect(childRel(containerRel(rowOf('README.md')), '新文件.md')).toBe('新文件.md')
  })
})

describe('visibleWindow：虚拟滚动的窗口算术', () => {
  const VIEWPORT = ROW_HEIGHT * 20 // 正好 20 行

  it('零行时什么都不渲染', () => {
    expect(visibleWindow(0, VIEWPORT, 0)).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 })
  })

  it('停在顶部时从头开始，多渲染 overscan 行', () => {
    const w = visibleWindow(0, VIEWPORT, 500)
    expect(w.start).toBe(0)
    expect(w.end).toBe(20 + OVERSCAN)
    expect(w.offsetY).toBe(0)
    expect(w.totalHeight).toBe(500 * ROW_HEIGHT)
  })

  it('滚到中间：上下各留出 overscan', () => {
    const w = visibleWindow(100 * ROW_HEIGHT, VIEWPORT, 500)
    expect(w.start).toBe(100 - OVERSCAN)
    expect(w.end).toBe(100 + 20 + OVERSCAN)
    expect(w.offsetY).toBe((100 - OVERSCAN) * ROW_HEIGHT)
  })

  it('滚到底部时 end 夹到 total', () => {
    const w = visibleWindow((500 - 20) * ROW_HEIGHT, VIEWPORT, 500)
    expect(w.start).toBe(500 - 20 - OVERSCAN)
    expect(w.end).toBe(500)
  })

  it('总行数比一屏还少时全渲染', () => {
    const w = visibleWindow(0, VIEWPORT, 5)
    expect(w.start).toBe(0)
    expect(w.end).toBe(5)
  })

  it('viewportHeight 为 0 时给出 overscan 行，不是 0 行', () => {
    // jsdom 的 clientHeight 恒为 0，组件测试看到的正是这批行；
    // 真实场景是侧边栏被拖到看不见——多 6 个节点没有代价，空白一帧有
    const w = visibleWindow(0, 0, 500)
    expect(w.start).toBe(0)
    expect(w.end).toBe(OVERSCAN)
  })

  it('负的 scrollTop 与超界的 scrollTop 都夹得住', () => {
    expect(visibleWindow(-1000, VIEWPORT, 500).start).toBe(0)
    const beyond = visibleWindow(100000 * ROW_HEIGHT, VIEWPORT, 500)
    expect(beyond.start).toBeLessThanOrEqual(500)
    expect(beyond.end).toBeLessThanOrEqual(500)
    expect(beyond.start).toBeLessThanOrEqual(beyond.end)
  })

  it('不整除的视口高度往上取整，不会露出半行空白', () => {
    const w = visibleWindow(0, ROW_HEIGHT * 20.5, 500)
    expect(w.end - w.start).toBe(21 + OVERSCAN)
  })

  it('任意参数下都满足 start ≤ end ≤ total 且 offsetY = start × rowHeight', () => {
    for (const scrollTop of [0, 7, 22, 2199, 2200, 10978, 999999]) {
      for (const total of [0, 1, 19, 20, 21, 500, 100000]) {
        const w = visibleWindow(scrollTop, VIEWPORT, total)
        expect(w.start).toBeGreaterThanOrEqual(0)
        expect(w.start).toBeLessThanOrEqual(w.end)
        expect(w.end).toBeLessThanOrEqual(total)
        expect(w.offsetY).toBe(w.start * ROW_HEIGHT)
        expect(w.totalHeight).toBe(total * ROW_HEIGHT)
      }
    }
  })
})

describe('actionForKey：方向键的落点', () => {
  const rows = flattenRows(FIXTURE)
  // ['', 'src', 'src/main.rs', 'src/lib.rs', 'README.md', 'empty']

  it('空树时任何键都不动', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'] as const) {
      expect(actionForKey([], null, key)).toEqual({ kind: 'none' })
      expect(actionForKey([], '', key)).toEqual({ kind: 'none' })
    }
  })

  it('没选中过时上下键从第一行起步', () => {
    expect(actionForKey(rows, null, 'ArrowDown')).toEqual({ kind: 'select', rel: '' })
    expect(actionForKey(rows, null, 'ArrowUp')).toEqual({ kind: 'select', rel: '' })
  })

  it('上下键在可见行里前后移动一格，两端停住', () => {
    expect(actionForKey(rows, 'src', 'ArrowDown')).toEqual({ kind: 'select', rel: 'src/main.rs' })
    expect(actionForKey(rows, 'src/main.rs', 'ArrowUp')).toEqual({ kind: 'select', rel: 'src' })
    expect(actionForKey(rows, '', 'ArrowUp')).toEqual({ kind: 'select', rel: '' })
    expect(actionForKey(rows, 'empty', 'ArrowDown')).toEqual({ kind: 'select', rel: 'empty' })
  })

  it('上下键跨过折叠的子树：折叠的目录算一行', () => {
    const folded = flattenRows(snapshotOf({ expanded: new Set(['']) }))
    // ['', 'src', 'README.md', 'empty']
    expect(actionForKey(folded, 'src', 'ArrowDown')).toEqual({ kind: 'select', rel: 'README.md' })
  })

  it('Home / End 跳到首尾', () => {
    expect(actionForKey(rows, 'src/lib.rs', 'Home')).toEqual({ kind: 'select', rel: '' })
    expect(actionForKey(rows, 'src/lib.rs', 'End')).toEqual({ kind: 'select', rel: 'empty' })
  })

  it('右键：折叠的目录摊开，摊开的目录下移到第一个子项', () => {
    const folded = flattenRows(snapshotOf({ expanded: new Set(['']) }))
    expect(actionForKey(folded, 'src', 'ArrowRight')).toEqual({ kind: 'expand', rel: 'src' })
    expect(actionForKey(rows, 'src', 'ArrowRight')).toEqual({ kind: 'select', rel: 'src/main.rs' })
  })

  it('右键在文件与摊开的空目录上什么都不做', () => {
    expect(actionForKey(rows, 'README.md', 'ArrowRight')).toEqual({ kind: 'none' })
    // `empty` 摊开了且是最后一行：没有子项可去
    expect(actionForKey(rows, 'empty', 'ArrowRight')).toEqual({ kind: 'none' })
  })

  it('左键：摊开的目录收起', () => {
    expect(actionForKey(rows, 'src', 'ArrowLeft')).toEqual({ kind: 'collapse', rel: 'src' })
  })

  it('左键：折叠的目录与文件都跳到父目录', () => {
    const folded = flattenRows(snapshotOf({ expanded: new Set(['']) }))
    expect(actionForKey(folded, 'src', 'ArrowLeft')).toEqual({ kind: 'select', rel: '' })
    expect(actionForKey(rows, 'src/lib.rs', 'ArrowLeft')).toEqual({ kind: 'select', rel: 'src' })
    expect(actionForKey(rows, 'README.md', 'ArrowLeft')).toEqual({ kind: 'select', rel: '' })
  })

  it('左键在摊开的根行上收起它——与任何其它目录同一条规则', () => {
    expect(actionForKey(rows, '', 'ArrowLeft')).toEqual({ kind: 'collapse', rel: '' })
  })

  it('左键在已收起的根行上无处可去', () => {
    const folded = flattenRows(snapshotOf({ expanded: new Set() }))
    expect(folded).toHaveLength(1)
    expect(actionForKey(folded, '', 'ArrowLeft')).toEqual({ kind: 'none' })
  })

  it('Enter：文件打开，目录切换摊开', () => {
    expect(actionForKey(rows, 'README.md', 'Enter')).toEqual({ kind: 'open', rel: 'README.md' })
    expect(actionForKey(rows, 'src/main.rs', 'Enter')).toEqual({ kind: 'open', rel: 'src/main.rs' })
    expect(actionForKey(rows, 'src', 'Enter')).toEqual({ kind: 'collapse', rel: 'src' })
    const folded = flattenRows(snapshotOf({ expanded: new Set(['']) }))
    expect(actionForKey(folded, 'src', 'Enter')).toEqual({ kind: 'expand', rel: 'src' })
  })

  it('选中的那行已经不在树里（刷新后消失）时，各键都退回第一行', () => {
    // 目录在 Vela 外面被删掉、然后用户按了刷新——选中的 rel 就此不存在。
    // 这时候方向键要是按「找不到就当第 -1 行」去算 ±1，会落到一个负下标上
    expect(actionForKey(rows, 'src/gone.ts', 'ArrowDown')).toEqual({ kind: 'select', rel: '' })
    expect(actionForKey(rows, 'src/gone.ts', 'ArrowUp')).toEqual({ kind: 'select', rel: '' })
    expect(actionForKey(rows, 'src/gone.ts', 'ArrowRight')).toEqual({ kind: 'select', rel: '' })
    expect(actionForKey(rows, 'src/gone.ts', 'ArrowLeft')).toEqual({ kind: 'select', rel: '' })
    expect(actionForKey(rows, 'src/gone.ts', 'Enter')).toEqual({ kind: 'none' })
  })

  it('上下键在中间来回一次回到原处', () => {
    // 只有「不在两端」时才成立，所以挑一个明确在中间的 rel
    const down = actionForKey(rows, 'src', 'ArrowDown')
    expect(down.kind).toBe('select')
    if (down.kind !== 'select') return
    expect(actionForKey(rows, down.rel, 'ArrowUp')).toEqual({ kind: 'select', rel: 'src' })
  })
})
