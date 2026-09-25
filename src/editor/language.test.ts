import { describe, expect, it } from 'vitest'
import { baseName, iconForPath, isBinaryPath, languageFor, loadSupport, sameLanguage } from './language'

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

describe('isBinaryPath：二进制与资源类判定', () => {
  it('图片／视频／音频／压缩包／可执行／字体／office 都算二进制', () => {
    for (const path of [
      '/a/photo.png',
      '/a/photo.JPG',
      '/a/pic.jpeg',
      '/a/icon.ico',
      '/a/app.icns',
      '/a/clip.mp4',
      '/a/song.mp3',
      '/a/sound.wav',
      '/a/archive.zip',
      '/a/pkg.tar.gz',
      '/a/big.7z',
      '/a/app.jar',
      '/a/disk.dmg',
      '/a/win.exe',
      '/a/lib.dylib',
      '/a/mod.so',
      '/a/bytecode.class',
      '/a/mod.wasm',
      '/a/Foo.ttf',
      '/a/web.woff2',
      '/a/doc.pdf',
      '/a/doc.docx',
      '/a/sheet.xlsx',
      '/a/deck.pptx',
      '/a/book.epub',
    ]) {
      expect(isBinaryPath(path), path).toBe(true)
    }
  })

  it('🔴 文本一律放行：无后缀、点开头、以及 Vela 刻意能开的那些', () => {
    // 这一条是整个黑名单设计的立足点。改成白名单的话它们全会被误伤，
    // 而 `workspace.ts` 的「打开…」注释里明写着要能开 LICENSE / Makefile
    for (const path of [
      '/a/LICENSE',
      '/a/Makefile',
      '/a/README',
      '/a/.gitignore',
      '/a/.zshrc',
      '/a/run.log',
      '/a/data.csv',
      '/a/app.conf',
      '/a/notes.md',
      '/a/pkg.json',
      '/a/main.rs',
      '/a/script.sh',
      '/a/Dockerfile',
    ]) {
      expect(isBinaryPath(path), path).toBe(false)
    }
  })

  it('⚠️ .svg 是文本不是图片：它是 XML，打开来可编辑，所以不在黑名单里', () => {
    expect(isBinaryPath('/a/icon.svg')).toBe(false)
    // 而 svgz 是 gzip 压过的，确实是二进制
    expect(isBinaryPath('/a/icon.svgz')).toBe(true)
  })

  it('只看 basename：目录名里的 .png 不算', () => {
    // 与 languageFor 同一条前提。少了切 basename，png 目录里的文件会被误判
    expect(isBinaryPath('/a.png/main.rs')).toBe(false)
    expect(isBinaryPath('C:\\proj\\png\\main.rs')).toBe(false)
    expect(isBinaryPath('C:\\proj\\shots\\a.PNG')).toBe(true)
  })

  it('baseName 认两种分隔符，无分隔符时原样返回', () => {
    expect(baseName('/a/b.md')).toBe('b.md')
    expect(baseName('C:\\a\\b.md')).toBe('b.md')
    expect(baseName('b.md')).toBe('b.md')
  })
})

describe('iconForPath：路径 → 图标类别', () => {
  it('资源类各归一类，与 isBinaryPath 共用同一张分组表', () => {
    expect(iconForPath('/a/photo.PNG')).toBe('image')
    expect(iconForPath('/a/clip.mp4')).toBe('media')
    expect(iconForPath('/a/x.wav')).toBe('media')
    expect(iconForPath('/a/app.zip')).toBe('archive')
    expect(iconForPath('/a/jar.jar')).toBe('archive')
    expect(iconForPath('/a/LXGWWenKai.woff2')).toBe('font')
    expect(iconForPath('/a/report.pdf')).toBe('doc')
    expect(iconForPath('/a/Book.epub')).toBe('doc')
    expect(iconForPath('/a/native.so')).toBe('binary')
    expect(iconForPath('/a/app.db')).toBe('binary')
  })

  it('文本类按用途分：样式 / 标签 / 数据 / 配置 / 脚本 / 代码', () => {
    expect(iconForPath('/a/notes.md')).toBe('markdown')
    expect(iconForPath('/a/notes.mdown')).toBe('markdown')
    expect(iconForPath('/a/main.css')).toBe('style')
    expect(iconForPath('/a/theme.scss')).toBe('style')
    expect(iconForPath('/a/index.html')).toBe('markup')
    expect(iconForPath('/a/App.vue')).toBe('markup')
    expect(iconForPath('/a/pkg.json')).toBe('data')
    expect(iconForPath('/a/tsconfig.jsonc')).toBe('data')
    expect(iconForPath('/a/app.config.js')).toBe('code')
    expect(iconForPath('/a/conf.yaml')).toBe('config')
    expect(iconForPath('/a/Cargo.toml')).toBe('config')
    expect(iconForPath('/a/deploy.sh')).toBe('shell')
    expect(iconForPath('/a/build.ps1')).toBe('shell')
    expect(iconForPath('/a/main.ts')).toBe('code')
    expect(iconForPath('/a/app.rs')).toBe('code')
    expect(iconForPath('/a/x.d.ts')).toBe('code')
  })

  it('🔴 顺序：名字是死的优先于扩展名', () => {
    // 反过来写的话这三条会各自落到 data / config / config——恰好是它们最不该被读成的样子：
    // 锁文件不该手改、`.gitlab-ci.yml` 说的是 git 而不是通用配置、`.env` 是密钥
    expect(iconForPath('/a/pnpm-lock.yaml')).toBe('lock')
    expect(iconForPath('/a/package-lock.json')).toBe('lock')
    expect(iconForPath('/a/go.sum')).toBe('lock')
    expect(iconForPath('/a/Cargo.lock')).toBe('lock')
    expect(iconForPath('/a/.gitlab-ci.yml')).toBe('git')
    expect(iconForPath('/a/.gitignore')).toBe('git')
    expect(iconForPath('/a/.env.local')).toBe('config')
    // Dockerfile 压根没有扩展名，只能按名字前缀认
    expect(iconForPath('/a/Dockerfile')).toBe('docker')
    expect(iconForPath('/a/docker-compose.yml')).toBe('docker')
  })

  it('README.md 是 markdown，裸的 LICENSE 才是 doc', () => {
    expect(iconForPath('/a/README.md')).toBe('markdown')
    expect(iconForPath('/a/LICENSE')).toBe('doc')
    expect(iconForPath('/a/CHANGELOG')).toBe('doc')
  })

  it('⚠️ .svg 的图标是图片，但它不是二进制：图标与拦不拦是两件事', () => {
    // 这一条同时钉住两个方向。只钉一个的话，将来有人「顺手统一一下」就会把 svg 拖进
    // RESOURCE_GROUPS（于是拖放被拒、而 Vela 明明能编辑它），或者把它的图标退回 file
    expect(iconForPath('/a/logo.svg')).toBe('image')
    expect(isBinaryPath('/a/logo.svg')).toBe(false)
    // 而 .svgz 两边都在：它是 gzip 压过的，拦、并且是图片
    expect(iconForPath('/a/logo.svgz')).toBe('image')
    expect(isBinaryPath('/a/logo.svgz')).toBe(true)
  })

  it('认不出来的落到 file：没有语法支持的文本、无后缀的杂项', () => {
    for (const path of ['/a/run.log', '/a/data.csv', '/a/Makefile', '/a/README.en']) {
      expect(iconForPath(path), path).toBe('file')
    }
  })

  it('只看 basename：目录名里的 .md 不算，Windows 分隔符也认', () => {
    expect(iconForPath('/a.md/main.rs')).toBe('code')
    expect(iconForPath('C:\\proj\\shots\\a.PNG')).toBe('image')
    expect(iconForPath('C:\\proj\\notes\\x.md')).toBe('markdown')
  })

  it('🔴 RESOURCE_GROUPS 的并集与拆分前那张黑名单逐字相同', () => {
    // 拆成六组是为了让图标分类复用同一张表，**不是为了改判定**。这一条把原表那一条
    // 长串 alternation 全列出来逐个验：漏一个扩展名的失败方式是「`.icns` 拖进来不拦了」，
    // 那是行为回归，不是难看，所以必须在这儿钉住
    const allResourceExts =
      'png jpg jpeg gif webp bmp ico icns tif tiff heic avif svgz psd ai sketch fig xd mp4 m4v mov avi mkv webm wmv flv mpg mpeg mp3 wav flac aac oga ogg m4a wma aiff opus zip tar gz tgz bz2 tbz2 xz txz zst 7z rar iso dmg pkg jar war exe dll dylib so o a class pyc pyo wasm elf bin woff woff2 ttf otf eot pdf doc docx xls xlsx ppt pptx odt ods odb pages numbers key epub mobi db sqlite sqlite3 parquet'
    for (const ext of allResourceExts.split(' ')) {
      expect(isBinaryPath(`/a/x.${ext}`), ext).toBe(true)
      expect(iconForPath(`/a/x.${ext}`), ext).not.toBe('file')
    }
    // 反向：这些确实是文本的，一个都不许被顺手拖进资源组
    for (const ext of [
      'md',
      'markdown',
      'txt',
      'log',
      'csv',
      'svg',
      'ts',
      'tsx',
      'rs',
      'py',
      'go',
      'java',
      'json',
      'yaml',
      'toml',
      'css',
      'html',
      'sh',
      'sql',
    ]) {
      expect(isBinaryPath(`/a/x.${ext}`), ext).toBe(false)
    }
  })
})
