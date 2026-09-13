/**
 * M0 测试文本生成。
 *
 * 刻意覆盖多个维度，因为 M0 的验收项分散在不同渲染路径上：
 * - 中英文混排 → 字体列对齐（验收项 #3）
 * - 跨 Unicode 区块的生僻字 → 触发 woff2 分片懒加载（验收项 #4）
 * - East Asian Width 歧义字符 → 已知无法完全解决，但要确认不崩
 * - 超长行 + 自动换行 → CM6 的 "pop 抖动"（风险 R9）
 * - Markdown 代码块 → Lezer 嵌套语言高亮
 *
 * 生成过程是确定性的（固定种子的伪随机），保证跨阶段测量可对比。
 */

const COMMON_HAN =
  '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'

// 跨 Unicode 区块：扩展 A、扩展 B、兼容表意、叠字、以及笔画复杂的罕用字。
// 这些字分散在不同的 woff2 分片里，是验证 unicode-range 懒加载的关键样本。
const RARE_HAN = [
  '龘', '靐', '齉', '爨', '驫', '麤', '毳', '垚', '焱', '淼',
  '㙟', '㙞', '㙓', '㐀', '㐁', '㑇', '㒼', '㔾', '㕮', '㖞',
  '𠀀', '𠀁', '𠀂', '𪜀', '𪜁', '𫝆', '𫝇', '𫖮', '𫖯', '𫖰',
]

// East Asian Width = Ambiguous，行业公认的老问题（风险 R10）
const AMBIGUOUS = ['±', '×', '÷', '≠', '≤', '≥', '≈', '∞', 'α', 'β', 'γ', 'Δ', 'π', 'σ', 'φ', 'ω', '①', '②', '③', 'Ⅰ', 'Ⅱ', 'Ⅲ', '─', '│', '┌', '┐', '└', '┘', '├', '┤']

const EMOJI = ['🚀', '⚡️', '🔥', '📦', '🧪', '✅', '❌', '⚠️']

const CODE_SAMPLES = [
  'const registry = createCommandRegistry()',
  'fn main() { vela_lib::run() }',
  'import { EditorView } from "@codemirror/view"',
  'export interface ToolDefinition { id: string; run: () => void }',
  'let sum = (0..100).filter(|n| n % 3 == 0).sum::<u32>();',
  'await invoke<FilePayload>("read_text_file", { path })',
  'if (delta > 0 && delta < 1000) this.frames.push(delta)',
  'type Result<T> = { ok: true; value: T } | { ok: false; error: string }',
]

const PROSE_SAMPLES = [
  '编辑器的手感取决于按键到屏幕之间的延迟，任何超过一帧的抖动都会被察觉。',
  '轻量不是少功能，而是每一个功能都不拖累启动路径与常驻内存。',
  'CodeMirror 6 的扩展是函数式的 facet，组合它们不会产生隐式的全局状态。',
  '文件树必须懒加载：把十万个节点塞进内存是最常见的性能陷阱。',
  '中文排版的难点在于字符宽度歧义，而不是字形本身。',
  '命令注册表是唯一需要现在就设计对的东西，因为发布即冻结。',
]

/** 确定性伪随机（mulberry32），保证每次生成完全一致的文本 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)]!
}

export interface FixtureOptions {
  lines?: number
  /** 是否包含超长行（触发 CM6 换行抖动，风险 R9） */
  longLines?: boolean
  /** 是否包含生僻字（触发字体分片懒加载，验收项 #4） */
  rareHan?: boolean
  seed?: number
}

export interface Fixture {
  text: string
  lineCount: number
  byteLength: number
  longestLine: number
}

/**
 * 生成一份 Markdown 测试文档，内含代码块、表格、中英混排、生僻字与歧义宽字符。
 */
export function generateFixture(options: FixtureOptions = {}): Fixture {
  const { lines = 10_000, longLines = true, rareHan = true, seed = 20260913 } = options
  const rnd = mulberry32(seed)
  const out: string[] = []
  let longest = 0

  const push = (line: string) => {
    out.push(line)
    if (line.length > longest) longest = line.length
  }

  for (let i = 0; i < lines; i++) {
    const kind = i % 12

    switch (kind) {
      case 0:
        push(`## 第 ${i} 节 · 性能验证`)
        break

      case 1:
        push(`\`\`\`${pick(rnd, ['ts', 'rust', 'json', 'bash'])}`)
        break

      case 2:
        push(pick(rnd, CODE_SAMPLES))
        break

      case 3:
        push('```')
        break

      case 4:
        push(pick(rnd, PROSE_SAMPLES))
        break

      case 5: {
        // 中英混排 + 歧义宽字符：验证列对齐
        const a = pick(rnd, AMBIGUOUS)
        const b = pick(rnd, AMBIGUOUS)
        push(`| 指标 ${a} | 预算 ${b} | 实测值 | 结论 ${i % 2 === 0 ? '✅' : '❌'} |`)
        break
      }

      case 6: {
        // 生僻字行：触发额外的 woff2 分片加载
        const chars = rareHan
          ? Array.from({ length: 6 }, () => pick(rnd, RARE_HAN)).join('')
          : Array.from({ length: 6 }, () => pick(rnd, [...COMMON_HAN])).join('')
        push(`- 罕用字样本 ${chars} · 常用字样本 ${pick(rnd, [...COMMON_HAN])}${pick(rnd, [...COMMON_HAN])}${pick(rnd, [...COMMON_HAN])}`)
        break
      }

      case 7:
        push(`> ${pick(rnd, PROSE_SAMPLES)} ${pick(rnd, EMOJI)}`)
        break

      case 8: {
        // 超长行：验证 CM6 在 wrap 下的抖动
        const base = pick(rnd, PROSE_SAMPLES)
        const repeat = longLines ? 8 + Math.floor(rnd() * 8) : 1
        push(`${i}. ${base.repeat(repeat)}`)
        break
      }

      case 9:
        push(`- [${i % 3 === 0 ? 'x' : ' '}] 任务项 ${i}：${pick(rnd, CODE_SAMPLES)}`)
        break

      case 10:
        push(`\tconst value${i} = ${Math.floor(rnd() * 100000)} // 缩进行 ${i}`)
        break

      default:
        push('')
    }
  }

  const text = out.join('\n')
  return {
    text,
    lineCount: out.length,
    byteLength: new TextEncoder().encode(text).length,
    longestLine: longest,
  }
}

/** 只含 ASCII 的对照组，用于隔离「中文字体」对滚动性能的影响 */
export function generateAsciiFixture(lines = 10_000): Fixture {
  const rnd = mulberry32(42)
  const out: string[] = []
  let longest = 0
  for (let i = 0; i < lines; i++) {
    const line = pick(rnd, CODE_SAMPLES) + ` // line ${i}`
    out.push(line)
    if (line.length > longest) longest = line.length
  }
  const text = out.join('\n')
  return { text, lineCount: lines, byteLength: text.length, longestLine: longest }
}
