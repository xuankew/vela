import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 前后端「线上契约」的前端快照，与 Rust 侧 `crates/vela-core/tests/wire_contract.rs`
 * 的 `dir_listing_的线上形状` / `tree_error_的七个变体在契约上各有其名` /
 * `entry_kind_是两个小写单词而不是布尔` / `文件查询结果的线上形状` /
 * `索引统计的线上形状` 一一对应。两边的 JSON 字面量必须同时改。
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  copyEntryPath,
  createEntry,
  describeTreeError,
  indexProject,
  listDir,
  queryProject,
  renameEntry,
  revealEntry,
  trashEntry,
  type DirListing,
  type FileQuery,
  type IndexStats,
  type TreeError,
} from './project'

/** 与 Rust 侧 `dir_listing_的线上形状` 里手搓的那个 `DirListing` 逐字节相同 */
const GOLDEN_LISTING =
  '{"rel":"src/doc","entries":[{"name":"tab.ts","rel":"src/doc/tab.ts","path":"/repo/src/doc/tab.ts","isDir":false},' +
  '{"name":"assets","rel":"src/doc/assets","path":"/repo/src/doc/assets","isDir":true}]}'

/** 黄金 listing 里的第一个条目。写操作那几条用例拿它当 `invoke` 的返回值 */
const GOLDEN_ENTRY = (JSON.parse(GOLDEN_LISTING) as DirListing).entries[0]

/** 与 Rust 侧 `文件查询结果的线上形状` 里手搓的那个 `FileQuery` 逐字节相同（M2-E/M2-F） */
const GOLDEN_QUERY =
  '{"matches":[{"rel":"src/store.ts","path":"/repo/src/store.ts","score":35,"rootIndex":0},' +
  '{"rel":"docs/about/store-history.md","path":"/repo/docs/about/store-history.md","score":23,"rootIndex":1}],"total":17}'

/** 与 Rust 侧 `索引统计的线上形状` 逐字节相同。⚠️ M2-F 之前 `elapsedMs` 是本文件里
 * 唯一一个 camelCase 改名真的会生效的字段名，现在 `FileMatch.rootIndex` 是第二个 */
const GOLDEN_STATS = '{"files":1234,"unreadable":2,"truncated":true,"elapsedMs":40}'

beforeEach(() => {
  invoke.mockReset()
})

describe('Rust → 前端 的字段名', () => {
  it('DirListing 的字段名与顺序与 Rust 侧序列化结果一致', () => {
    const parsed = JSON.parse(GOLDEN_LISTING) as DirListing
    // 键顺序就是 JSON.parse 的插入顺序，所以 stringify 相等 == 字段集合与顺序都相等
    expect(JSON.stringify(parsed)).toBe(GOLDEN_LISTING)
    expect(Object.keys(parsed)).toEqual(['rel', 'entries'])
  })

  it('DirEntry 的四个字段都在，而且布尔那个叫 isDir 不是 is_dir', () => {
    const parsed = JSON.parse(GOLDEN_LISTING) as DirListing
    const [file, dir] = parsed.entries
    expect(Object.keys(file!)).toEqual(['name', 'rel', 'path', 'isDir'])
    // 写错这一个字母的失败方式是**静默的**：每项的 `isDir` 都成 undefined，
    // 于是整棵树里没有一项能被展开，而控制台一行错都没有
    expect(file!.isDir).toBe(false)
    expect(dir!.isDir).toBe(true)
    expect(file!.name).toBe('tab.ts')
    expect(file!.rel).toBe('src/doc/tab.ts')
    expect(file!.path).toBe('/repo/src/doc/tab.ts')
  })

  it('七个错误变体在契约上各有其名', () => {
    // 穷举就是这条测试的全部内容：Rust 侧加了变体而前端没跟上，这里会少一行，
    // 读代码的人立刻看得出两边不同步。顺序也与 Rust 侧那条一一对应
    const cases: [TreeError, string][] = [
      [
        { kind: 'io', reason: 'PermissionDenied', message: '没权限' },
        '{"kind":"io","reason":"PermissionDenied","message":"没权限"}',
      ],
      [{ kind: 'not_found', path: '/repo/x' }, '{"kind":"not_found","path":"/repo/x"}'],
      [{ kind: 'not_a_directory', path: '/repo/a.ts' }, '{"kind":"not_a_directory","path":"/repo/a.ts"}'],
      // M2-B-5 的两个。前端要对这两句说不同的话——前者是「换个名字」，
      // 后者是「这个名字不行」，压成一条就只能说「出错了」
      [{ kind: 'already_exists', path: '/repo/README.md' }, '{"kind":"already_exists","path":"/repo/README.md"}'],
      [{ kind: 'bad_name', name: 'a/b' }, '{"kind":"bad_name","name":"a/b"}'],
      [{ kind: 'escape', rel: '../x' }, '{"kind":"escape","rel":"../x"}'],
      [{ kind: 'bad_root', path: 'repo' }, '{"kind":"bad_root","path":"repo"}'],
    ]
    for (const [error, golden] of cases) {
      expect(JSON.stringify(error)).toBe(golden)
    }
    // tag 是 snake_case（not_a_directory），不是 camelCase——与 fs.ts 的 ReadError 同一约定
    expect(cases.map(([e]) => e.kind)).toEqual([
      'io',
      'not_found',
      'not_a_directory',
      'already_exists',
      'bad_name',
      'escape',
      'bad_root',
    ])
  })
})

describe('前端 → Rust 的 command 名与参数名', () => {
  it('list_dir 的两个参数名与 Rust command 的形参一致', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_LISTING))
    await listDir('/repo', 'src/doc')
    expect(invoke).toHaveBeenCalledWith('list_dir', { root: '/repo', rel: 'src/doc' })
  })

  it('rel 不传时显式发空字符串，而不是把 key 省掉', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_LISTING))
    await listDir('/repo')
    // Rust 侧是 `rel: String` 而不是 `Option<String>`：缺 key 会直接反序列化失败，
    // 报的还是一个跟「忘了传参」看不出来的 serde 错误
    expect(invoke).toHaveBeenCalledWith('list_dir', { root: '/repo', rel: '' })
  })

  it('返回的 rel 能原样喂回去，这是前端不做路径拼接的前提', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_LISTING))
    const first = await listDir('/repo')
    const dir = first.entries.find((e) => e.isDir)!
    await listDir('/repo', dir.rel)
    expect(invoke).toHaveBeenLastCalledWith('list_dir', { root: '/repo', rel: 'src/doc/assets' })
    // 而 path 是给 openFile 的那一份：绝对路径，与 rel 指向同一个条目
    expect(dir.path).toBe('/repo/src/doc/assets')
  })

  it('create_entry 的 kind 是两个小写单词，不是布尔', async () => {
    invoke.mockResolvedValue(GOLDEN_ENTRY)
    await createEntry('/repo', 'src/doc/tab.ts', 'file')
    expect(invoke).toHaveBeenLastCalledWith('create_entry', { root: '/repo', rel: 'src/doc/tab.ts', kind: 'file' })
    await createEntry('/repo', 'src/doc/assets', 'dir')
    expect(invoke).toHaveBeenLastCalledWith('create_entry', { root: '/repo', rel: 'src/doc/assets', kind: 'dir' })
    // 与 Rust 侧 `entry_kind_是两个小写单词而不是布尔` 是同一条契约的两半：
    // 那边钉住 `"File"` / `true` / `"folder"` 一律反序列化失败，这边钉住前端发的是什么
  })

  it('⚠️ rename_entry 的第三个参数叫 newName：本项目第一个多单词命令参数', async () => {
    invoke.mockResolvedValue(GOLDEN_ENTRY)
    await renameEntry('/repo', 'src/doc/tab.ts', 'pane.ts')
    // Rust 侧形参是 `new_name`，Tauri 2 在命令边界上把它转成驼峰。写成 `new_name`
    // 的失败方式是一句「invalid args `newName` for command `rename_entry`」——
    // 那句报错说的是**它要的**名字，读的人却往往以为是自己传错了值
    expect(invoke).toHaveBeenCalledWith('rename_entry', {
      root: '/repo',
      rel: 'src/doc/tab.ts',
      newName: 'pane.ts',
    })
  })

  it('trash / reveal / copyPath 三个都只收 (root, rel)', async () => {
    invoke.mockResolvedValue(undefined)
    await trashEntry('/repo', 'src/doc/tab.ts')
    expect(invoke).toHaveBeenLastCalledWith('trash_entry', { root: '/repo', rel: 'src/doc/tab.ts' })
    await revealEntry('/repo', 'src/doc')
    expect(invoke).toHaveBeenLastCalledWith('reveal_entry', { root: '/repo', rel: 'src/doc' })
    await copyEntryPath('/repo', 'src/doc')
    expect(invoke).toHaveBeenLastCalledWith('copy_entry_path', { root: '/repo', rel: 'src/doc' })
    // 三条都不接绝对路径：路径由 Rust 侧从 (root, rel) 自己解析出来，
    // 前端递一条 `/Users/...` 过去就等于把「不会逃出项目根」这条保证交回给逐处审计
  })
})

describe('错误落地成人能读的话', () => {
  it('not_found 与 not_a_directory 带上路径', () => {
    expect(describeTreeError({ kind: 'not_found', path: '/repo/x' })).toContain('/repo/x')
    expect(describeTreeError({ kind: 'not_a_directory', path: '/repo/a.ts' })).toContain('是文件')
  })

  it('io 直接用 Rust 侧给的 message', () => {
    expect(describeTreeError({ kind: 'io', reason: 'PermissionDenied', message: '没权限' })).toBe('没权限')
  })

  it('already_exists 带上路径，并给出「换一个名字」这条出路', () => {
    const text = describeTreeError({ kind: 'already_exists', path: '/repo/README.md' })
    expect(text).toContain('/repo/README.md')
    expect(text).toContain('换一个名字')
    // 只说「已存在」是不够的：用户下一步该做什么必须在这句话里，
    // 否则他会去点第二次确定，然后第二次撞在同一个错误上
  })

  it('bad_name 说清哪三种名字不行', () => {
    const text = describeTreeError({ kind: 'bad_name', name: 'src/a.ts' })
    expect(text).toContain('"src/a.ts"')
    expect(text).toContain('不能用作文件名')
    // 把整条路径打进「名字」输入框是这里最常见的一种。Rust 侧拒掉它不是偷懒：
    // 移动文件需要「目标层已经被列举过」，而树是懒加载的，前提不成立
    expect(text).toContain('/')
  })

  it('⚠️ 名字是空字符串时那句话仍然有主语', () => {
    const text = describeTreeError({ kind: 'bad_name', name: '' })
    // 直接内插会得到「 不能用作文件名…」——一句没有主语的话，看着像文案坏了。
    // JSON.stringify 把它变成一对引号，用户看得见「我说的是那个空的」
    expect(text.startsWith('""')).toBe(true)
    expect(text).toContain('不能为空')
    for (const name of ['.', '..', './']) {
      expect(describeTreeError({ kind: 'bad_name', name })).toContain(JSON.stringify(name))
    }
  })

  it('escape 与 bad_root 说成内部错误，不伪装成用户的处境', () => {
    // rel 只可能来自上一次列举的返回值、root 只可能来自 dialog，两条都是**我们的 bug**。
    // 把它说成「你可以怎么怎么办」是在给一条断言套提示的皮，用户照着做也不会好
    expect(describeTreeError({ kind: 'escape', rel: '../x' })).toContain('内部错误')
    expect(describeTreeError({ kind: 'escape', rel: '../x' })).toContain('"../x"')
    expect(describeTreeError({ kind: 'bad_root', path: 'repo' })).toContain('内部错误')
  })

  it('Rust 侧将来加了变体而前端没跟上时，不会抛', () => {
    expect(describeTreeError({ kind: 'brand_new_variant' })).toBe('[object Object]')
  })

  it('不是 IPC 错误时退回 Error / 字符串', () => {
    expect(describeTreeError(new Error('网络断了'))).toBe('网络断了')
    expect(describeTreeError('字符串错误')).toBe('字符串错误')
    expect(describeTreeError(null)).toBe('null')
  })
})

describe('Rust → 前端 的字段名（M2-E 文件索引）', () => {
  it('FileQuery 与 FileMatch 的字段名与顺序与 Rust 侧序列化结果一致', () => {
    const parsed = JSON.parse(GOLDEN_QUERY) as FileQuery
    expect(JSON.stringify(parsed)).toBe(GOLDEN_QUERY)
    expect(Object.keys(parsed)).toEqual(['matches', 'total'])
    expect(Object.keys(parsed.matches[0]!)).toEqual(['rel', 'path', 'score', 'rootIndex'])
    // `path` 是绝对路径，前端拿它直接喂 openFile；`rel` 是给浮层显示的那一份
    expect(parsed.matches[0]!.path).toBe('/repo/src/store.ts')
    expect(parsed.matches[0]!.rel).toBe('src/store.ts')
  })

  it('⚠️ rootIndex 是每条各自带的，不是整份查询带一个', () => {
    const parsed = JSON.parse(GOLDEN_QUERY) as FileQuery
    expect(parsed.matches.map((m) => m.rootIndex)).toEqual([0, 1])
    // 黄金字面量里刻意一条 0 一条 1（与 Rust 侧同一个字面量）：全是 0 的话
    // 看不出这个字段是**每条各自带**。多根之下 `rel` 不再唯一——两个根里各有一个
    // `store.ts` 是常事，浮层要靠 `rootIndex` 才分得开它们，
    // 也靠它才画得出「来自哪个文件夹」那一行小字
    //
    // ⚠️ 写成 `root_index` 的失败方式与本文件里其它几条一样**静默**：
    // 前端读到 `undefined`，`roots[undefined]` 又是 `undefined`，
    // 于是那一行小字是空白，而回车打开的 `path` 照样是对的——看不出哪里坏了
    expect((parsed.matches[0] as unknown as Record<string, unknown>).root_index).toBeUndefined()
  })

  it('total 可以大于 matches.length，那个差值就是「还有更多」', () => {
    const parsed = JSON.parse(GOLDEN_QUERY) as FileQuery
    expect(parsed.matches).toHaveLength(2)
    expect(parsed.total).toBe(17)
    // ⚠️ 条数上限定在 Rust 侧（`commands.rs` 的 `QUERY_LIMIT`），前端不对它做任何假设：
    // 要显示「还有几个」就用这个差值，不要写死 50
    expect(parsed.total - parsed.matches.length).toBe(15)
    // ⚠️ 多根之下 `total` 是**各根之和**，而 `matches` 是跨根合并后再截到 `QUERY_LIMIT`
    // 的那一批。于是「共 4 万个匹配、显示 50 个」在三个大仓库一起搜时是常态，不是 bug
  })

  it('⚠️ IndexStats 的时间字段叫 elapsedMs：M2-F 之前唯一一个 camelCase 真的生效的地方', () => {
    const parsed = JSON.parse(GOLDEN_STATS) as IndexStats
    expect(JSON.stringify(parsed)).toBe(GOLDEN_STATS)
    expect(Object.keys(parsed)).toEqual(['files', 'unreadable', 'truncated', 'elapsedMs'])
    expect(parsed.elapsedMs).toBe(40)
    // 写成 elapsed_ms 的失败方式是**静默的**：undefined 参与算术是 NaN、参与比较是 false，
    // 两种都不抛，界面只会安静地少一个数字。另外三个字段都是单个单词，
    // 它们的 camelCase 是恒等的，所以真正会漂的只有这一个
    expect((parsed as unknown as Record<string, unknown>).elapsed_ms).toBeUndefined()
  })
})

describe('前端 → Rust 的 command 名与参数名（M2-E / M2-F）', () => {
  it('⚠️ index_project 收的是 roots 数组，单根时也是长度为 1 的数组', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_STATS))
    const stats = await indexProject(['/repo'])
    expect(invoke).toHaveBeenCalledWith('index_project', { roots: ['/repo'] })
    // truncated 为真时索引不全，浮层必须说一句话——这是它被回传的全部理由
    expect(stats.truncated).toBe(true)
    expect(stats.files).toBe(1234)
  })

  it('多个根按传进去的顺序发出去，Rust 侧逐个重建', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_STATS))
    await indexProject(['/repo/a', '/repo/b'])
    expect(invoke).toHaveBeenCalledWith('index_project', { roots: ['/repo/a', '/repo/b'] })
    // ⚠️ 顺序就是 `rootIndex` 的语义，与搜索、替换那两条同一条规矩。
    // 逐个而不并发地重建是 Rust 侧的决定（并发会把 blocking 池占满，而
    // `open_file` / `save_file` / `list_dir` 也在上面），所以三个大仓库意味着
    // 浮层要多等一会儿——那段时间里画的是 MRU，不是白屏
  })

  it('query_project 的三个参数名与 Rust command 的形参一致', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_QUERY))
    await queryProject(['/repo'], 'store', ['/repo/src/store.ts'])
    expect(invoke).toHaveBeenCalledWith('query_project', {
      roots: ['/repo'],
      needle: 'store',
      recent: ['/repo/src/store.ts'],
    })
  })

  it('recent 不传时显式发空数组，而不是把 key 省掉', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_QUERY))
    await queryProject(['/repo'], 'store')
    // Rust 侧是 `Vec<String>` 而不是 `Option<Vec<String>>`：缺 key 会直接反序列化失败，
    // 报的还是一个跟「忘了传参」看不出来的 serde 错误。与 listDir 的 rel 同一条规矩
    expect(invoke).toHaveBeenCalledWith('query_project', { roots: ['/repo'], needle: 'store', recent: [] })
    // ⚠️ `recent` 是**一份跨根的清单**，不是每个根一份：MRU 记的是绝对路径，
    // 而 Rust 侧拿它与每个索引里已有的 rel 比对，比不上的直接忽略
  })

  it('needle 原样发出去，不 trim，空字符串也是合法的一次查询', async () => {
    invoke.mockResolvedValue(JSON.parse(GOLDEN_QUERY))
    await queryProject(['/repo'], '  ')
    expect(invoke).toHaveBeenCalledWith('query_project', { roots: ['/repo'], needle: '  ', recent: [] })
    // 空 needle 的意思是「随便给我一批」，浮层刚展开、一个字都还没打时要的就是这个。
    // 把它当成「没填」拦在前端的话，浮层展开就是一片空白
    await queryProject(['/repo'], '')
    expect(invoke).toHaveBeenLastCalledWith('query_project', { roots: ['/repo'], needle: '', recent: [] })
  })

  it('索引建不出来时报的还是 TreeError，已有的 describeTreeError 直接就能用', async () => {
    const err: TreeError = { kind: 'not_found', path: '/repo' }
    invoke.mockRejectedValue(err)
    await expect(indexProject(['/repo'])).rejects.toEqual(err)
    await expect(queryProject(['/repo'], 'x')).rejects.toEqual(err)
    // 复用文件树那一个错误枚举是**刻意**的：多一个枚举就多一份要两边同步的分支表，
    // 而「不是绝对路径 / 不存在 / 不是目录 / IO」这四条它一条新信息也带不来
    expect(describeTreeError(err)).toContain('/repo')
    // ⚠️ 多根之下 `path` 指的是**那一个**不合法的根。取舍是「一个根不合法就整次 reject」
    // 而不是静默跳过——跳过与「这个文件夹里没有匹配的文件」在界面上长得一模一样
  })
})
