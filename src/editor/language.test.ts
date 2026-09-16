import { describe, expect, it } from 'vitest'
import { languageFor, loadSupport, sameLanguage } from './language'

describe('languageFor：路径 → 语言', () => {
  it('无名文档当 Markdown，label 是给人看的「Markdown」', () => {
    const choice = languageFor(null)
    expect(choice.kind).toBe('markdown')
    expect(choice.label).toBe('Markdown')
    // markdown 是静态依赖，不走懒加载，所以没有 description
    expect(choice.description).toBeNull()
  })

  it('.md 及其变体都算 Markdown，大小写不敏感', () => {
    for (const path of ['/a/notes.md', '/a/notes.markdown', '/a/notes.mdown', '/a/NOTES.MD']) {
      expect(languageFor(path).kind, path).toBe('markdown')
    }
  })

  it('代码文件命中 language-data，label 用它的语言名而不是扩展名', () => {
    const json = languageFor('/a/pkg.json')
    expect(json.kind).toBe('code')
    expect(json.label).toBe('JSON')
    expect(json.description).not.toBeNull()

    expect(languageFor('/a/x.ts').label).toBe('TypeScript')
    expect(languageFor('/a/x.rs').label).toBe('Rust')
  })

  it('没匹配上的扩展名落到 plain，且不挂任何语言', () => {
    for (const path of ['/a/run.log', '/a/data.csv', '/a/README']) {
      const choice = languageFor(path)
      expect(choice.kind, path).toBe('plain')
      expect(choice.label, path).toBe('纯文本')
      expect(choice.description, path).toBeNull()
    }
  })

  it('判定只看 basename：目录名里的 .md 不算，Windows 分隔符也认', () => {
    // 直接把全路径喂给 matchFilename 的话，它的 filename 模式（/^makefile$/i 这类）会失配，
    // 而目录名里的点号还可能反过来误命中。这条钉住「先切 basename」这个前提
    expect(languageFor('/a/md.dir/notes.txt').kind).toBe('plain')
    expect(languageFor('C:\\Users\\x\\notes.md').kind).toBe('markdown')
  })

  it('靠文件名而非扩展名匹配的语言也命中——这正是必须切 basename 的理由', () => {
    // matchFilename 的 filename 模式要求整串等于文件名。传全路径进去，
    // '/a/Dockerfile' 永远匹配不上 /^Dockerfile$/，于是它会退回纯文本
    expect(languageFor('/a/Dockerfile').label).toBe('Dockerfile')
    // CMakeLists.txt 更刁：扩展名是 .txt，只按扩展名匹配的话必然当成纯文本，
    // 唯有 /^CMakeLists\.txt$/ 这条 filename 模式能认出它
    expect(languageFor('/a/CMakeLists.txt').kind).toBe('code')
    // 📌 language-data 的 filename 清单里**没有** Makefile（只有 BUCK/BUILD、
    // CMakeLists.txt、Dockerfile、Jenkinsfile、Gemfile/Rakefile、PKGBUILD、nginx*.conf），
    // 所以 Makefile 落到 plain 是上游的行为，不是这里的 bug
    expect(languageFor('/a/Makefile').kind).toBe('plain')
  })
})

describe('sameLanguage：什么时候算「没变」', () => {
  it('同一种语言的两个实例算相等——languageFor 每次都为 code 造新对象', () => {
    expect(sameLanguage(languageFor('/a.md'), languageFor('/b.md'))).toBe(true)
    expect(sameLanguage(languageFor('/a.json'), languageFor('/b.json'))).toBe(true)
  })

  it('语言不同就是不同，哪怕 kind 一样', () => {
    // 两个都是 code，但 JSON 与 TypeScript 的语法树不能互换。
    // 只比 kind 的话，从 .json 切到 .ts 会被判成「没变」而跳过装载
    expect(sameLanguage(languageFor('/a.json'), languageFor('/a.ts'))).toBe(false)
  })

  it('kind 不同当然不同', () => {
    expect(sameLanguage(languageFor(null), languageFor('/a.log'))).toBe(false)
    expect(sameLanguage(languageFor('/a.log'), languageFor('/a.json'))).toBe(false)
  })
})

describe('loadSupport：懒加载', () => {
  it('markdown 与 plain 都没有要加载的东西，直接给 null', async () => {
    await expect(loadSupport(languageFor(null))).resolves.toBeNull()
    await expect(loadSupport(languageFor('/a.log'))).resolves.toBeNull()
  })

  it('代码语言的动态 import 真的能落地，并且带出一个可用的 Language', async () => {
    // 这条是整个懒加载链路的终点：vite.config.ts 里「刻意不做 manualChunks」就是为了
    // 保住 language-data 的这些动态边界。import 失败或返回空的话，代码文件会永远
    // 只有等宽字体而没有语法高亮，且全程不报错
    const support = await loadSupport(languageFor('/a/pkg.json'))
    expect(support).not.toBeNull()
    expect(support?.language.name).toBe('json')
  })
})
