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
  keyOf,
  menuFor,
  parentRel,
  rowKey,
  sameRow,
  type RowKey,
  type TreeMenuAction,
  type TreeRow,
  type TreeSnapshot,
} from './tree'

function entry(name: string, rel: string, isDir = false): DirEntry {
  return { name, rel, path: `/repo/${rel}`, isDir }
}

/**
 * 第 0 个根里的一条身份。
 *
 * 大部分用例只有一棵树，写 `k('src')` 比写 `{ rootIndex: 0, rel: 'src' }` 短，
 * 而多根的那几条用例**刻意不用它**——它们要的就是「两个不同的 rootIndex」看得见
 */
const k = (rel: string): RowKey => rowKey(0, rel)

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
    const rows = flattenRows(snapshotOf({ expanded: new Set() }), 0)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      rootIndex: 0,
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
    const rows = flattenRows(snapshotOf({ expanded: new Set(['']) }), 0)
    // 排序是 Rust 侧的事（文件夹优先 → 不区分大小写 → 字节兜底），已经钉在
    // `crates/vela-core/src/project/tree.rs` 的测试里。前端再排一次就等于有两个真相，
    // 而两边规则只要差一点，「刷新之后顺序变了」这种 bug 就查不动了
    expect(rels(rows)).toEqual(['', 'src', 'README.md', 'empty'])
    expect(depths(rows)).toEqual([0, 1, 1, 1])
  })

  it('摊开且已取回的多层：深度一路加下去，顺序是深度优先', () => {
    const rows = flattenRows(FIXTURE, 0)
    expect(rels(rows)).toEqual(['', 'src', 'src/main.rs', 'src/lib.rs', 'README.md', 'empty'])
    expect(depths(rows)).toEqual([0, 1, 2, 2, 1, 1])
  })

  it('⚠️ 折叠的目录不递归进去，即便它的条目已经在 listings 里', () => {
    // 这条钉的是「按需列举」在前端的那一半：listings 是个缓存，里面可能存着
    // 一个此刻折叠着的目录的条目（用户摊开过又收起来了）。把它渲染出来就等于
    // 展开状态失效，而缓存里有 10 万条时整个虚拟化也就跟着失效了
    const rows = flattenRows(snapshotOf({ expanded: new Set(['']) }), 0)
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
      0,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.loading).toBe(true)
    expect(rows[0]?.error).toBeNull()
  })

  it('不补「读取中…」占位行：行数在数据到达时不该跳', () => {
    const loading = flattenRows(snapshotOf({ listings: new Map(), loading: new Set(['']) }), 0)
    const arrived = flattenRows(snapshotOf({ expanded: new Set(['']) }), 0)
    expect(loading).toHaveLength(1)
    // 数据到达之后行数从 1 变成 4，而不是从 2（根 + 占位）变成 4。
    // 占位行会让滚动条在每一层展开时都抽动一下
    expect(arrived).toHaveLength(4)
  })

  it('错误落在出错的那一层，别层是 null', () => {
    const rows = flattenRows(snapshotOf({ errors: new Map([['src', '权限不够']]) }), 0)
    expect(rows.find((r) => r.rel === 'src')?.error).toBe('权限不够')
    expect(rows.find((r) => r.rel === '')?.error).toBeNull()
    expect(rows.find((r) => r.rel === 'src/main.rs')?.error).toBeNull()
  })

  it('刷新失败时旧条目照常列出：error 与 entries 共存', () => {
    // 「刷新一下」失败不该把已经看见的内容抹成空白——用户会以为文件没了。
    // 出错的那一行自己会说一句话，两件事并不冲突
    const rows = flattenRows(snapshotOf({ errors: new Map([['src', '读取中失败了']]) }), 0)
    expect(rels(rows)).toEqual(['', 'src', 'src/main.rs', 'src/lib.rs', 'README.md', 'empty'])
    expect(rows.find((r) => r.rel === 'src')?.error).toBe('读取中失败了')
  })

  it('文件行的 expanded / loading / error 恒为默认值', () => {
    for (const row of flattenRows(FIXTURE, 0)) {
      if (row.isDir) continue
      expect(row.expanded).toBe(false)
      expect(row.loading).toBe(false)
      expect(row.error).toBeNull()
    }
  })

  it('空目录摊开后不多出任何行', () => {
    const rows = flattenRows(FIXTURE, 0)
    const at = rels(rows).indexOf('empty')
    expect(at).toBe(rows.length - 1)
    expect(rows[at]?.expanded).toBe(true)
  })

  it('⚠️ 传进去的 rootIndex 盖到**每一行**上，包括深层递归出来的那些', () => {
    // 漏盖的失败方式不是报错：那一行的 `rootIndex` 是 undefined，
    // 于是 `keyOf` 造出来的身份与别的行都不相等，「选中」永远落不到它上面。
    // 而 `toEqual({ rootIndex: 0, … })` 那种逐行断言只查得到根行——递归分支得单独钉
    const rows = flattenRows(FIXTURE, 3)
    expect(rows.map((r) => r.rootIndex)).toEqual([3, 3, 3, 3, 3, 3])
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
  const rows = flattenRows(FIXTURE, 0)
  // ['', 'src', 'src/main.rs', 'src/lib.rs', 'README.md', 'empty']

  function rowOf(rel: string): TreeRow {
    const row = rows.find((r) => r.rel === rel)
    if (!row) throw new Error(`FIXTURE 里没有 rel='${rel}' 的那一行`)
    return row
  }

  /** 只有一个根时的菜单。多根那一份见下面 `describe('多根工作区')` */
  function actionsOf(row: TreeRow): TreeMenuAction[] {
    return menuFor(row, 1).map((i) => i.action)
  }

  it('⚠️ 根行的菜单里没有「重命名…」也没有「移到废纸篓」', () => {
    // 那两项落在根行上的含义是「把用户整个项目文件夹改名」与「把整个项目文件夹扔进废纸篓」。
    // 这条规则被刻意放在纯函数层而不是渲染时写个 `<Show when={row.rel !== ''}>`：
    // 改一次渲染就能把后者改掉，而 `store.trash('')` 里那道拦截只是最后一道网——
    // 网兜住的是「没做成」，兜不住「菜单上摆着一项吓人的东西」
    expect(actionsOf(rowOf(''))).toEqual(['newFile', 'newFolder', 'reveal', 'copyPath', 'removeRoot'])
  })

  it('根行那一项说「关闭文件夹」——只有一个根时「工作区」这个词在界面上压根没出现过', () => {
    const one = menuFor(rowOf(''), 1).find((i) => i.action === 'removeRoot')!
    expect(one.label).toBe('关闭文件夹')
    const many = menuFor(rowOf(''), 3).find((i) => i.action === 'removeRoot')!
    expect(many.label).toBe('从工作区移除')
    // 措辞不说「删除」也不说「移除文件夹」：那个文件夹好好地在磁盘上，
    // 消失的只是「Vela 现在在看它」这件事。与「移到废纸篓」同一条规矩
    expect(many.label).not.toContain('删除')
    // 非根行永远拿不到这一项，不管工作区里有几个根
    expect(menuFor(rowOf('src'), 3).map((i) => i.action)).not.toContain('removeRoot')
  })

  it('目录行与文件行都是六项，顺序一致（根行才有的那一项不在里面）', () => {
    const six: TreeMenuAction[] = ['newFile', 'newFolder', 'rename', 'trash', 'reveal', 'copyPath']
    expect(actionsOf(rowOf('src'))).toEqual(six)
    expect(actionsOf(rowOf('src/main.rs'))).toEqual(six)
    // 空目录与普通目录没有区别：里面没东西不妨碍在它里面新建
    expect(actionsOf(rowOf('empty'))).toEqual(six)
  })

  it('分隔线画在「重命名…」与「在 Finder 中显示」上面：分的是「会不会改磁盘」', () => {
    const seps = (row: TreeRow) =>
      menuFor(row, 1)
        .filter((i) => i.separator)
        .map((i) => i.action)
    expect(seps(rowOf('src'))).toEqual(['rename', 'reveal'])
    // 根行少了中间那组，但「新建 | Finder」这条线还在，末尾还多一条：
    // 「从工作区移除」会让整个根从树上消失，它与每天用几十次的「复制路径」之间
    // 必须隔着一次误点的距离
    expect(seps(rowOf(''))).toEqual(['reveal', 'removeRoot'])
  })

  it('⚠️ 移到废纸篓那一项不带省略号，文案也不说「删除」', () => {
    const items = menuFor(rowOf('src'), 1)
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

describe('actionForKey：方向键的落点', () => {
  const rows = flattenRows(FIXTURE, 0)
  // ['', 'src', 'src/main.rs', 'src/lib.rs', 'README.md', 'empty']

  it('空树时任何键都不动', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'] as const) {
      expect(actionForKey([], null, key)).toEqual({ kind: 'none' })
      expect(actionForKey([], k(''), key)).toEqual({ kind: 'none' })
    }
  })

  it('没选中过时上下键从第一行起步', () => {
    expect(actionForKey(rows, null, 'ArrowDown')).toEqual({ kind: 'select', key: k('') })
    expect(actionForKey(rows, null, 'ArrowUp')).toEqual({ kind: 'select', key: k('') })
  })

  it('上下键在可见行里前后移动一格，两端停住', () => {
    expect(actionForKey(rows, k('src'), 'ArrowDown')).toEqual({ kind: 'select', key: k('src/main.rs') })
    expect(actionForKey(rows, k('src/main.rs'), 'ArrowUp')).toEqual({ kind: 'select', key: k('src') })
    expect(actionForKey(rows, k(''), 'ArrowUp')).toEqual({ kind: 'select', key: k('') })
    expect(actionForKey(rows, k('empty'), 'ArrowDown')).toEqual({ kind: 'select', key: k('empty') })
  })

  it('上下键跨过折叠的子树：折叠的目录算一行', () => {
    const folded = flattenRows(snapshotOf({ expanded: new Set(['']) }), 0)
    // ['', 'src', 'README.md', 'empty']
    expect(actionForKey(folded, k('src'), 'ArrowDown')).toEqual({ kind: 'select', key: k('README.md') })
  })

  it('Home / End 跳到首尾', () => {
    expect(actionForKey(rows, k('src/lib.rs'), 'Home')).toEqual({ kind: 'select', key: k('') })
    expect(actionForKey(rows, k('src/lib.rs'), 'End')).toEqual({ kind: 'select', key: k('empty') })
  })

  it('右键：折叠的目录摊开，摊开的目录下移到第一个子项', () => {
    const folded = flattenRows(snapshotOf({ expanded: new Set(['']) }), 0)
    expect(actionForKey(folded, k('src'), 'ArrowRight')).toEqual({ kind: 'expand', key: k('src') })
    expect(actionForKey(rows, k('src'), 'ArrowRight')).toEqual({ kind: 'select', key: k('src/main.rs') })
  })

  it('右键在文件与摊开的空目录上什么都不做', () => {
    expect(actionForKey(rows, k('README.md'), 'ArrowRight')).toEqual({ kind: 'none' })
    // `empty` 摊开了且是最后一行：没有子项可去
    expect(actionForKey(rows, k('empty'), 'ArrowRight')).toEqual({ kind: 'none' })
  })

  it('左键：摊开的目录收起', () => {
    expect(actionForKey(rows, k('src'), 'ArrowLeft')).toEqual({ kind: 'collapse', key: k('src') })
  })

  it('左键：折叠的目录与文件都跳到父目录', () => {
    const folded = flattenRows(snapshotOf({ expanded: new Set(['']) }), 0)
    expect(actionForKey(folded, k('src'), 'ArrowLeft')).toEqual({ kind: 'select', key: k('') })
    expect(actionForKey(rows, k('src/lib.rs'), 'ArrowLeft')).toEqual({ kind: 'select', key: k('src') })
    expect(actionForKey(rows, k('README.md'), 'ArrowLeft')).toEqual({ kind: 'select', key: k('') })
  })

  it('左键在摊开的根行上收起它——与任何其它目录同一条规则', () => {
    expect(actionForKey(rows, k(''), 'ArrowLeft')).toEqual({ kind: 'collapse', key: k('') })
  })

  it('左键在已收起的根行上无处可去', () => {
    const folded = flattenRows(snapshotOf({ expanded: new Set() }), 0)
    expect(folded).toHaveLength(1)
    expect(actionForKey(folded, k(''), 'ArrowLeft')).toEqual({ kind: 'none' })
  })

  it('Enter：文件打开，目录切换摊开', () => {
    expect(actionForKey(rows, k('README.md'), 'Enter')).toEqual({ kind: 'open', key: k('README.md') })
    expect(actionForKey(rows, k('src/main.rs'), 'Enter')).toEqual({ kind: 'open', key: k('src/main.rs') })
    expect(actionForKey(rows, k('src'), 'Enter')).toEqual({ kind: 'collapse', key: k('src') })
    const folded = flattenRows(snapshotOf({ expanded: new Set(['']) }), 0)
    expect(actionForKey(folded, k('src'), 'Enter')).toEqual({ kind: 'expand', key: k('src') })
  })

  it('选中的那行已经不在树里（刷新后消失）时，各键都退回第一行', () => {
    // 目录在 Vela 外面被删掉、然后用户按了刷新——选中的 rel 就此不存在。
    // 这时候方向键要是按「找不到就当第 -1 行」去算 ±1，会落到一个负下标上
    expect(actionForKey(rows, k('src/gone.ts'), 'ArrowDown')).toEqual({ kind: 'select', key: k('') })
    expect(actionForKey(rows, k('src/gone.ts'), 'ArrowUp')).toEqual({ kind: 'select', key: k('') })
    expect(actionForKey(rows, k('src/gone.ts'), 'ArrowRight')).toEqual({ kind: 'select', key: k('') })
    expect(actionForKey(rows, k('src/gone.ts'), 'ArrowLeft')).toEqual({ kind: 'select', key: k('') })
    expect(actionForKey(rows, k('src/gone.ts'), 'Enter')).toEqual({ kind: 'none' })
  })

  it('上下键在中间来回一次回到原处', () => {
    // 只有「不在两端」时才成立，所以挑一个明确在中间的 rel
    const down = actionForKey(rows, k('src'), 'ArrowDown')
    expect(down.kind).toBe('select')
    if (down.kind !== 'select') return
    expect(actionForKey(rows, down.key, 'ArrowUp')).toEqual({ kind: 'select', key: k('src') })
  })

  it('⚠️ 同一个 rel 在别的根里不算选中：找的是「第几个根 + rel」两个都对上的那一行', () => {
    // 两个根都有 `src`。若 `actionForKey` 只按 rel 找，它会**永远命中前一个根的那一行**
    // （`findIndex` 从头扫），于是在根 B 上按右键，摊开的却是根 A 的 src——
    // 界面上看得见的高亮在 B，真正动了的树在 A
    const twoRoots = [...flattenRows(FIXTURE, 0), ...flattenRows(FIXTURE, 1)]
    expect(actionForKey(twoRoots, rowKey(1, 'src'), 'ArrowRight')).toEqual({
      kind: 'select',
      key: rowKey(1, 'src/main.rs'),
    })
    expect(actionForKey(twoRoots, rowKey(0, 'src'), 'ArrowRight')).toEqual({
      kind: 'select',
      key: rowKey(0, 'src/main.rs'),
    })
  })
})

describe('多根：RowKey 与跨根的边界', () => {
  /**
   * 第二棵树刻意与第一棵**同形**：一样的 rel、一样的深度。
   *
   * 这不是偷懒而是要点所在——多根之下所有「按 rel 认行」的写法都只在两棵树长得不同时
   * 才碰巧正确。同形的两棵树能让每一处漏掉 `rootIndex` 的地方当场露出来
   */
  const OTHER: TreeSnapshot = {
    rootName: 'other',
    rootPath: '/other',
    listings: new Map<string, DirEntry[]>([
      ['', [entry('src', 'src', true), entry('README.md', 'README.md'), entry('empty', 'empty', true)]],
      ['src', [entry('main.rs', 'src/main.rs'), entry('lib.rs', 'src/lib.rs')]],
      ['empty', []],
    ]),
    expanded: new Set(['', 'src', 'empty']),
    loading: new Set(),
    errors: new Map(),
  }

  /** 工作区里那份「所有根首尾相接」的行数组，与 M2-F-4 的协调层要产出的东西同形 */
  function workspace(): TreeRow[] {
    return [...flattenRows(FIXTURE, 0), ...flattenRows(OTHER, 1)]
  }

  function otherOf(overrides: Partial<TreeSnapshot>): TreeSnapshot {
    return { ...OTHER, ...overrides }
  }

  it('接起来之后 rel 不再唯一，而 (rootIndex, rel) 是唯一的', () => {
    const rows = workspace()
    expect(rows).toHaveLength(12)
    const relCounts = new Map<string, number>()
    for (const row of rows) relCounts.set(row.rel, (relCounts.get(row.rel) ?? 0) + 1)
    // 两棵同形的树：每一条 rel 都出现两次，包括那两条 `''`（各自的根行）
    expect([...relCounts.values()].every((n) => n === 2)).toBe(true)
    const keys = rows.map((row) => `${row.rootIndex}\u0000${row.rel}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keyOf / sameRow：结构体不能用 === 比，而两个字段都得对上', () => {
    const row = workspace()[1]!
    // 每次 `keyOf` 都是新对象：这正是「不能用 `===` 比」的那件事
    expect(keyOf(row)).not.toBe(keyOf(row))
    expect(sameRow(keyOf(row), keyOf(row))).toBe(true)
    expect(sameRow(keyOf(row), rowKey(0, row.rel))).toBe(true)
    // rel 相同、根不同 = 不同的行
    expect(sameRow(rowKey(0, 'src'), rowKey(1, 'src'))).toBe(false)
    expect(sameRow(null, null)).toBe(true)
    expect(sameRow(null, k(''))).toBe(false)
    expect(sameRow(k(''), null)).toBe(false)
  })

  it('⚠️ 下键从第一个根的最后一行跨到第二个根的根行', () => {
    // 这是 VS Code 的行为，也是「一份扁平数组 + ±1」白拿到的东西。
    // 若不跨（比如在根尾停住），用户要在两个项目之间移动就得伸手去点鼠标
    const rows = workspace()
    expect(rows[5]!.rel).toBe('empty')
    expect(rows[5]!.rootIndex).toBe(0)
    expect(actionForKey(rows, keyOf(rows[5]!), 'ArrowDown')).toEqual({
      kind: 'select',
      key: rowKey(1, ''),
    })
  })

  it('上键反方向也一样跨回去', () => {
    const rows = workspace()
    expect(rows[6]!.rel).toBe('')
    expect(rows[6]!.rootIndex).toBe(1)
    expect(actionForKey(rows, keyOf(rows[6]!), 'ArrowUp')).toEqual({
      kind: 'select',
      key: rowKey(0, 'empty'),
    })
  })

  it('Home / End 落在整个工作区的首尾，不是各自那一个根的首尾', () => {
    const rows = workspace()
    expect(actionForKey(rows, keyOf(rows[6]!), 'Home')).toEqual({ kind: 'select', key: rowKey(0, '') })
    expect(actionForKey(rows, keyOf(rows[6]!), 'End')).toEqual({ kind: 'select', key: rowKey(1, 'empty') })
  })

  it('左键在第二个根的根行上收起它自己，而不是跑到第一个根里去', () => {
    const rows = workspace()
    const secondRoot = rows[6]!
    expect(secondRoot).toMatchObject({ rootIndex: 1, rel: '', depth: 0, expanded: true })
    expect(actionForKey(rows, keyOf(secondRoot), 'ArrowLeft')).toEqual({ kind: 'collapse', key: rowKey(1, '') })
  })

  it('⚠️ 左键在第二个根的一级子项上落到**它自己的**根行', () => {
    // 根 1 只摊开根层，于是 `src` 是折叠着的：左键 = 跳到父目录。
    // 这一条钉的是「父目录在同一个根里」——往回扫第一行就撞上根 1 自己的根行，
    // 而 `parentOf` 里那道根边界检查保证它绝不会扫到根 0 的行上去
    const rows = [
      ...flattenRows(snapshotOf({ expanded: new Set() }), 0),
      ...flattenRows(otherOf({ expanded: new Set(['']) }), 1),
    ]
    expect(rels(rows)).toEqual(['', '', 'src', 'README.md', 'empty'])
    expect(rows.map((r) => r.rootIndex)).toEqual([0, 1, 1, 1, 1])
    const target = rows[2]!
    expect(target).toMatchObject({ rootIndex: 1, rel: 'src', depth: 1, expanded: false })
    expect(actionForKey(rows, keyOf(target), 'ArrowLeft')).toEqual({ kind: 'select', key: rowKey(1, '') })
  })

  it('两个根都收起来时，左键在第二个根的根行上无处可去', () => {
    // 根行没有父目录，而上一个根的根行**不是**它的父目录。
    // 这一条与上一条一起盖住 `parentOf` 的两侧：同根内找得到，跨根一律不找
    const rows = [
      ...flattenRows(snapshotOf({ expanded: new Set() }), 0),
      ...flattenRows(otherOf({ expanded: new Set() }), 1),
    ]
    expect(rows).toHaveLength(2)
    expect(actionForKey(rows, keyOf(rows[1]!), 'ArrowLeft')).toEqual({ kind: 'none' })
  })

  it('⚠️ 两个根行都不给「重命名…」与「移到废纸篓」', () => {
    // 判据是 `rel === ''` 而不看 rootIndex，所以 N 个根行一条都不例外。
    // 少挡一个的失败方式是「右键第二个项目 → 移到废纸篓」把用户整个项目文件夹扔了
    const rootRows = workspace().filter((row) => row.rel === '')
    expect(rootRows.map((row) => row.rootIndex)).toEqual([0, 1])
    for (const row of rootRows) {
      expect(menuFor(row, 2).map((i) => i.action)).toEqual(['newFile', 'newFolder', 'reveal', 'copyPath', 'removeRoot'])
    }
  })

  it('每个根的根行都是自己那棵树的 depth 0，接起来会出现第二个 0', () => {
    // 缩进是「相对它自己的根」算的，所以整份数组里 depth 0 出现 N 次。
    // 这不是 bug 而是形状：`aria-level` 也就跟着每棵树从 1 重新开始，
    // 读屏软件听到的是「两个平级的项目」而不是「一个项目和一个子目录」
    expect(depths(workspace())).toEqual([0, 1, 2, 2, 1, 1, 0, 1, 2, 2, 1, 1])
  })

  it('containerRel 只看 rel，不看 rootIndex：它算的是**根内**的父层', () => {
    const rows = workspace()
    const first = rows.find((r) => r.rootIndex === 0 && r.rel === 'src/main.rs')!
    const second = rows.find((r) => r.rootIndex === 1 && r.rel === 'src/main.rs')!
    expect(containerRel(first)).toBe('src')
    expect(containerRel(second)).toBe('src')
    // 两个结果一样是**对的**：调用方拿着 `TreeRow`，rootIndex 从行上取，
    // 而 rel 从这个函数取。要是这里也掺进 rootIndex，反而要调用方再拆一次
  })
})
