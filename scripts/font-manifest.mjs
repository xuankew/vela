/**
 * 生成「字体分片 → 真实字节数」清单，供 M0 验收项 #4 判定首屏字体加载是否 < 2MB。
 *
 * 为什么需要这张表：`performance.getEntriesByType('resource')` 在 `tauri://` 协议下
 * **抓不到任何 woff2**（release 构建里恒为 0 条），原先的 ✅ 是在 dev 模式下测的。
 * 前端唯一可靠的信号是 `document.fonts` 里哪些 face 的 status 变成了 `loaded`，
 * 但 FontFace 不暴露 URL，拿不到字节数——所以需要这张离线查表。
 *
 * 为什么从 node_modules 取字节数而不是从 dist 取：vite 只给资源**改名加 hash**，
 * 内容是逐字节复制的，所以源文件的大小就是实际传输量。这样清单在构建前就能生成，
 * 不必等 hash，也就能作为普通输入被探针读取而不进 bundle。
 * 脚本仍会去 dist 里核对每个分片确实被产出了，核对不上的会在汇总里报出来。
 *
 * 用法：node scripts/font-manifest.mjs [--check-dist]
 * 输出：.m0-font-manifest.json（仓库根，.gitignore 已忽略 .m0-* 前缀）
 */
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.m0-font-manifest.json')

/** 注入到前端的每一个字体 CSS。family 必须与 loader.ts 里声明的一致 */
const SOURCES = [
  {
    id: 'screen-gb',
    css: 'node_modules/lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css',
  },
  {
    id: 'screen-r',
    css: 'node_modules/lxgw-wenkai-screen-webfont/lxgwwenkaiscreenr.css',
  },
  {
    id: 'maple-cn',
    css: 'node_modules/@automann/maple-mono-cn/dist/regular.css',
  },
]

/**
 * unicode-range 的归一化。
 *
 * ⚠️ 前端 `src/probe/metrics.ts` 的 `normRange` 必须与此**逐字一致**：
 * 两边一个归一化源文本、一个归一化 WebKit 回读的值，规则不同就一个都匹配不上。
 */
function normRange(s) {
  return s.toUpperCase().replace(/\s+/g, '').replace(/;+$/, '')
}

function parseFontFaces(css, cssDir, sourceId) {
  const out = []
  const re = /@font-face\s*\{([^}]*)\}/g
  let m
  while ((m = re.exec(css)) !== null) {
    const body = m[1]
    const family = /font-family:\s*['"]?([^'";]+)/.exec(body)?.[1]?.trim()
    const url = /url\(\s*['"]?([^'")]+\.woff2)/.exec(body)?.[1]
    const range = /unicode-range:\s*([^;}]+)/.exec(body)?.[1]
    if (!family || !url) continue
    const file = join(cssDir, url.replace(/^\.\//, ''))
    if (!existsSync(file)) {
      throw new Error(`${sourceId}: 分片文件不存在 ${file}`)
    }
    out.push({
      sourceId,
      family,
      range: range ? normRange(range) : '',
      file: file.replace(ROOT + '/', ''),
      name: url.split('/').pop(),
      bytes: statSync(file).size,
      weight: /font-weight:\s*([^;}]+)/.exec(body)?.[1]?.trim() ?? '',
    })
  }
  return out
}

const entries = []
for (const src of SOURCES) {
  const cssPath = join(ROOT, src.css)
  if (!existsSync(cssPath)) throw new Error(`找不到 CSS：${src.css}`)
  const css = readFileSync(cssPath, 'utf8')
  const parsed = parseFontFaces(css, dirname(cssPath), src.id)
  if (parsed.length === 0) throw new Error(`${src.id}: 没解析出任何 @font-face，正则失效了`)
  entries.push(...parsed)
}

// 与 dist 核对：vite 保留原文件名作前缀、追加 hash，所以按「去掉 .woff2 的原名」找
const checkDist = process.argv.includes('--check-dist')
let distChecked = 0
let distMissing = 0
let distBytesMismatch = 0
if (checkDist) {
  const assetsDir = join(ROOT, 'dist/assets')
  if (!existsSync(assetsDir)) {
    console.error('⚠️ dist/assets 不存在，先跑 pnpm build；本次跳过 dist 核对')
  } else {
    const distFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.woff2'))
    for (const e of entries) {
      const stem = e.name.replace(/\.woff2$/, '')
      const hit = distFiles.find((f) => f === e.name || f.startsWith(`${stem}-`))
      if (!hit) {
        distMissing++
        continue
      }
      distChecked++
      if (statSync(join(assetsDir, hit)).size !== e.bytes) distBytesMismatch++
    }
  }
}

const families = {}
for (const e of entries) {
  const f = (families[e.family] ??= { shards: 0, bytes: 0 })
  f.shards++
  f.bytes += e.bytes
}

const manifest = {
  generatedAt: new Date().toISOString(),
  note: '由 scripts/font-manifest.mjs 生成。字节数取自 node_modules 源文件（vite 逐字节复制，只改名）。',
  families,
  entries: entries.map((e) => ({
    family: e.family,
    range: e.range,
    name: e.name,
    bytes: e.bytes,
    weight: e.weight,
  })),
}

writeFileSync(OUT, JSON.stringify(manifest))

const total = entries.reduce((s, e) => s + e.bytes, 0)
console.log(`✅ ${OUT.replace(ROOT + '/', '')}`)
for (const [family, f] of Object.entries(families)) {
  console.log(`   ${family}: ${f.shards} 片 / ${(f.bytes / 1048576).toFixed(2)} MB`)
}
console.log(`   合计: ${entries.length} 片 / ${(total / 1048576).toFixed(2)} MB`)
console.log(`   清单体积: ${(statSync(OUT).size / 1024).toFixed(1)} KB`)
if (checkDist) {
  console.log(
    `   dist 核对: 命中 ${distChecked} / 缺失 ${distMissing} / 字节不符 ${distBytesMismatch}` +
      (distMissing || distBytesMismatch ? '  ⛔ 有不一致，字节数不可信' : '  ✅ 全部逐字节一致'),
  )
}
const noRange = entries.filter((e) => !e.range).length
if (noRange) console.log(`   ⚠️ ${noRange} 个 face 没有 unicode-range，前端无法按键匹配`)
