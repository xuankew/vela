/**
 * 生成 M0 占位应用图标。
 *
 * Tauri 的 generate_context!() 在编译期就会打开 src-tauri/icons/icon.png，
 * 即使 bundle.icon 配成空数组也一样——文件不存在则 proc macro panic，整个 crate 编译不过。
 *
 * 这里用 node 内置 zlib 直接拼 PNG（signature + IHDR + IDAT + IEND，逐 chunk 算 CRC32），
 * 避免为一个占位图标引入图像库依赖。M6 做正式打包时替换成设计稿即可。
 *
 * 图案：Vela = 船帆座，两面帆 + 桅杆。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const CORNER = 112 // ≈ macOS 图标圆角比例

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outPath = join(root, 'src-tauri', 'icons', 'icon.png')

// ---------- PNG 底层 ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// ---------- 图案 ----------

const lerp = (a, b, t) => a + (b - a) * t

function outsideRoundedRect(x, y, size, r) {
  const inX = x >= r && x <= size - r
  const inY = y >= r && y <= size - r
  if (inX || inY) return false
  // 落在四个角区域，检查到圆心的距离
  const cx = x < r ? r : size - r
  const cy = y < r ? r : size - r
  return (x - cx) ** 2 + (y - cy) ** 2 > r * r
}

/** @returns {[number, number, number, number]} RGBA */
function pixel(x, y) {
  if (outsideRoundedRect(x, y, SIZE, CORNER)) return [0, 0, 0, 0]

  const t = y / SIZE
  // 背景：Tokyo Night 系的深蓝垂直渐变
  let r = lerp(0x1a, 0x24, t)
  let g = lerp(0x1b, 0x28, t)
  let b = lerp(0x26, 0x3b, t)

  const MAST_TOP = 92
  const MAST_BOTTOM = 424

  // 桅杆
  if (x >= 250 && x <= 262 && y >= MAST_TOP && y <= MAST_BOTTOM) {
    return [0xc0, 0xca, 0xf5, 255]
  }

  // 主帆（右侧大三角）：顶点 (262, 100)，向右下展开到 (432, MAST_BOTTOM)
  if (y >= 100 && y <= MAST_BOTTOM && x >= 262) {
    const edge = 262 + ((y - 100) * (432 - 262)) / (MAST_BOTTOM - 100)
    if (x <= edge) {
      const k = (y - 100) / (MAST_BOTTOM - 100)
      return [lerp(0x7a, 0x3d, k), lerp(0xa2, 0x59, k), lerp(0xf7, 0xa8, k), 255]
    }
  }

  // 前帆（左侧小三角）：顶点 (240, 152)，向左下展开到 (112, MAST_BOTTOM)
  if (y >= 152 && y <= MAST_BOTTOM && x <= 240) {
    const edge = 240 - ((y - 152) * (240 - 112)) / (MAST_BOTTOM - 152)
    if (x >= edge) {
      const k = (y - 152) / (MAST_BOTTOM - 152)
      return [lerp(0xbb, 0x6a, k), lerp(0x9a, 0x4f, k), lerp(0xf7, 0xc4, k), 255]
    }
  }

  return [r, g, b, 255]
}

// ---------- 组装 ----------

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4)
  raw[rowStart] = 0 // 每行首字节是 filter type，0 = None
  for (let x = 0; x < SIZE; x++) {
    const i = rowStart + 1 + x * 4
    const [r, g, b, a] = pixel(x, y)
    raw[i] = r
    raw[i + 1] = g
    raw[i + 2] = b
    raw[i + 3] = a
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
ihdr[10] = 0 // compression
ihdr[11] = 0 // filter
ihdr[12] = 0 // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, png)
console.log(`✓ ${outPath}  (${(png.length / 1024).toFixed(1)} KB, ${SIZE}×${SIZE})`)
