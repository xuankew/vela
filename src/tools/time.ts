/**
 * 时间戳与日期互转的**纯活**（M3-B-4，PLAN §3.5）。
 *
 * 与 `json.ts` / `codec.ts` 同一条口径：这一层只认字符串、只返回 `ToolResult`，
 * ⛔ 不认识描述符、不认识选项条、也不认识 Solid。「时间戳互转」这个名字住在 `builtin.ts`。
 *
 * ## 🔴 为什么不用 `new Date(字符串)`
 *
 * 四条实测（这一份 jsdom 环境里跑的，真机是 JavaScriptCore，V8 只会更宽松）：
 *
 * | 调用 | 结果 |
 * |---|---|
 * | `new Date('2024-02-30')` | **`2024-03-01T00:00:00.000Z`** —— 一个不存在的日子被**悄悄地滚**成了下个月 |
 * | `new Date('1700000000')` | **Invalid Date** —— 一串纯数字**不**被当成时间戳 |
 * | `new Date('2024-03-05')` | UTC 零点 |
 * | `new Date('2024-03-05T12:34:56')` | **本地**时间 |
 *
 * 第一条是最要命的：它不报错，它给一个**自信地错着**的答案，而这正是这个代码库一路在躲的东西
 * （同一条理由见 `tool.ts` 的 `coerceOption`：宁可返回 `null` 也不夹到边界上）。
 * 第三、四条是 ES 规范自己的不一致——只写日期按 UTC、写了时间按本地，
 * 于是 `2024-03-05` 与 `2024-03-05T00:00:00` 在 UTC+8 上差整整 8 小时。
 * 而所有失败都只说 `Invalid Date`，**一个下标都没有**，「跳到出错处」那一格因此永远点不亮。
 *
 * 所以这里自己写解析器：只认 ISO 8601 与纯数字两种形状，每一处失败都带着位置。
 *
 * ## 🔴 一处**故意**与规范不一样的地方
 *
 * **没写时区就按本地理解，即使只写了日期。** 也就是 `2024-03-05` 与 `2024-03-05T00:00:00`
 * 在 Vela 里给出**同一个**时刻，而 `new Date` 会让它们差 8 小时。
 *
 * 理由是自洽：这个工具的输出第一行就写着「本地」，而用户粘进来一个只有日期的串时
 * 心里想的是「那一天」，不是「那一天的 UTC 零点」。规范那个分裂没有任何一方的好处，
 * 只有历史包袱。⚠️ 输出里那句「（输入里没写时区，按本地时间 UTC+08:00 理解）」
 * 是这条规则的**披露**，⛔ 不能删——静默地按本地解释与静默地按 UTC 解释一样坏
 *
 * ## 🔴 那一串数字最多认 25 位
 *
 * 纯数字那一条走 `BigInt`（`Number` 在 2^53 之上就开始丢位，而纳秒时间戳现在是 19 位）。
 * 而 `BigInt` 的除法**不是线性的**，`store.ts` 又允许一格一百万个字符——
 * 一百万位的数字做一次除法就是一次**看得见的卡死**，而卡死比报错坏得多
 * （同一条理由见 `json.ts` 那个**迭代**的扫描器）。25 位足够装下公元 ±27 万年的纳秒
 *
 * ## ⚠️ 单位是**猜**的，所以每一次都如实说出来
 *
 * `1700000000` 是秒还是毫秒，从数字本身看不出来。这里按有效位数猜
 * （≤11 秒、12–14 毫秒、15–17 微秒、≥18 纳秒），然后在输出里写一行「（输入读成「秒」）」。
 * 猜错了用户一眼能看出来，⛔ 而不是盯着一个公元 5138 年的日期想「这工具坏了」。
 * 落在 1900…2200 之外时再多一句位数的提示
 *
 * ## ⚠️ 报告用**全角冒号**，不做列对齐
 *
 * 「本地」「UTC」「秒」三个标签的**显示宽度**分别是 4、3、1 个半角格，而 `.length`
 * 给的是 2、3、1——用 `padEnd` 对齐的话在等宽字体下依然是歪的（PLAN 风险 R10）。
 * 全角冒号自带一个格子的间隔，于是**不需要**对齐，也就绕开了整个问题
 *
 * ## ⛔ 没做的
 *
 * - **IANA 时区选择器**（`Asia/Shanghai` 那种）。一份时区表 + 与本地化无关的格式化
 *   是另一份预算，而「本地 + UTC」已经覆盖了真实需要
 * - **相对时间**（「3 天前」）。P0 那一行写的是「秒 / 毫秒 / 时区」，而按日历算的
 *   中文时间单位（「1 个月」是 28 到 31 天）不值得
 * - `Mar 5, 2024` / `5/3/2024` / `2024年3月5日`。前两个要猜月与日的先后
 *   （`5/3` 是 3 月 5 日还是 5 月 3 日），猜错就是静默地错；后一个不难，但也不在 P0 里
 *
 * ## ⚠️ 用例必须与本机时区无关
 *
 * CI 跑的是 ubuntu（TZ = UTC），本机是 UTC+8（`getTimezoneOffset()` 给 −480）。
 * 所以「没写时区」那一类的断言一律写成 `new Date(2024, 2, 5).getTime()`——
 * 这个表达式在两个时区里给出**不同的数**，但它永远等于被测代码算出来的那一个
 *
 * ## ⚠️ 零新依赖
 *
 * `Date` / `BigInt` 都是平台自带的
 */

import { describeCharAt, describeErrorAt, type LocatedError, type ToolResult } from './tool'

/**
 * `Date` 能表示的最大毫秒数：±1 亿天，也就是公元 -271821 年到 275760 年。
 *
 * ⚠️ 超过它 `toISOString()` **直接抛** RangeError，而 `getUTCFullYear()` 给 `NaN`——
 * 一个抛、一个不抛，所以这一条线必须在**进渲染之前**就卡住
 *
 * 🔴 是 `8.64e15` 不是 `8.64e12`。少写三个零的话上限变成公元 2244 年，
 * 而 `0099-01-01` 这种完全合法的日期会被当成「超出范围」拒掉
 */
export const MAX_DATE_MS = 8.64e15

/**
 * 实际拿来卡范围的那一条，比 `MAX_DATE_MS` 少整整一天。
 *
 * ⚠️ 那一天是给 `formatAt` 留的：它要拿 `ms + offset * 60_000` 去构造一个 `Date`，
 * 而偏移最大 ±24 小时。贴着上限的时刻一旦被渲染就会在 `toISOString()` 上抛出来
 */
const SAFE_MS = MAX_DATE_MS - 86_400_000

/** 一串数字最多认多少位（整数位 + 小数位加起来）。理由见模块文档 */
const MAX_TIMESTAMP_DIGITS = 25

/** 落在这两年之外，就多说一句「位数是单位的线索」 */
const PLAUSIBLE_MIN_YEAR = 1900
const PLAUSIBLE_MAX_YEAR = 2200

/** 下标就是 `getUTCDay()` / `getDay()` 的返回值 */
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/** 下标是**月份减一**。二月单独算，见 `daysInMonth` */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** 时间戳的单位。⚠️ 这四个中文名**同时就是**输出里那句「（输入读成「秒」）」的措辞 */
export type TimeUnit = '秒' | '毫秒' | '微秒' | '纳秒'

/**
 * 一次解析的结果。
 *
 * 🔴 `zone` 是**三值**的，不是一个布尔。纯数字那一支给 `'absolute'`：一个 epoch 数
 * 与哪个时区都没关系，所以「没写时区，按本地理解」那句披露**不能**在它身上出现——
 * 说了就是一句假话。只有 `'local'`（写了日期/时间但没写时区）才说
 */
export type TimeParse =
  | {
      readonly kind: 'ok'
      /** 从 1970-01-01T00:00:00Z 起的毫秒数，可以为负 */
      readonly ms: number
      readonly zone: 'absolute' | 'explicit' | 'local'
      /** 纯数字那一支猜出来的单位；ISO 那一支永远是 `null`（它不需要猜） */
      readonly unit: TimeUnit | null
      /** 比毫秒更细、装不下的那一部分，形如 `0.456`；没有就是空串 */
      readonly dropped: string
    }
  | { readonly kind: 'error'; readonly error: LocatedError }

function bad(offset: number, expected: string): TimeParse {
  return { kind: 'error', error: { offset, expected } }
}

function isAsciiSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

/**
 * 读**恰好两位**数字，读不出返回 `-1`。
 *
 * ⚠️ 刻意不收一位数（`2024-3-5`）：ISO 8601 要求补零，而放宽到「一两位都行」的话
 * `3/5/2024` 这种形状就得开始猜月与日的先后——猜错就是静默地错。
 * 报错那一句会说清「该是两位数字」，用户自己补一个零就过去了
 */
function twoDigits(text: string, at: number, end: number): number {
  if (at + 2 > end) return -1
  const tens = text.charCodeAt(at)
  const ones = text.charCodeAt(at + 1)
  if (!isDigit(tens) || !isDigit(ones)) return -1
  return (tens - 0x30) * 10 + (ones - 0x30)
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** `month` 是 1…12 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28
  return MONTH_DAYS[month - 1] ?? 31
}

/** 按有效位数猜单位。理由与披露方式见模块文档 */
export function unitFor(significantDigits: number): TimeUnit {
  if (significantDigits <= 11) return '秒'
  if (significantDigits <= 14) return '毫秒'
  if (significantDigits <= 17) return '微秒'
  return '纳秒'
}

/** `单位 → 毫秒` 那个分数的分子与分母 */
const NUMERATOR: Readonly<Record<TimeUnit, bigint>> = { 秒: 1000n, 毫秒: 1n, 微秒: 1n, 纳秒: 1n }
const DENOMINATOR: Readonly<Record<TimeUnit, bigint>> = { 秒: 1n, 毫秒: 1n, 微秒: 1000n, 纳秒: 1000000n }

/**
 * 余数 → `0.456` 这样一串。
 *
 * ⚠️ 末尾的零要抹掉：`.500` 读起来比 `.5` 精确，而它们是同一个数
 */
function decimalOf(remainder: bigint, divisor: bigint): string {
  const padded = String(remainder).padStart(String(divisor).length - 1, '0')
  let last = padded.length
  while (last > 0 && padded[last - 1] === '0') last--
  return `0.${padded.slice(0, last)}`
}

/**
 * 把一串数字读成一个时刻。
 *
 * 🔴 走 `BigInt` 而不是 `Number`：纳秒时间戳现在是 19 位，早就过了 2^53（16 位）。
 * 而 `Number('1700000000123456789')` 不报错，它给一个**差了几百纳秒**的数——
 * 又是那种自信地错着的答案
 *
 * ⚠️ `signStart` 与 `end` 都由 `parseTime` 算好递进来，所以这里报的每一个下标
 * 都是**原始输入串**里的，能直接拿去选输入格的那一行
 */
function parseNumeric(text: string, signStart: number, end: number): TimeParse {
  let i = signStart
  let negative = false
  const sign = text.charCodeAt(i)
  if (sign === 0x2b) i++
  else if (sign === 0x2d) {
    negative = true
    i++
  }

  const intStart = i
  while (i < end && isDigit(text.charCodeAt(i))) i++
  const intEnd = i
  let fracStart = intEnd
  let fracEnd = intEnd
  if (i < end && text.charCodeAt(i) === 0x2e) {
    i++
    fracStart = i
    while (i < end && isDigit(text.charCodeAt(i))) i++
    fracEnd = i
  }
  if (i !== end) return bad(i, `数字后面还跟着别的东西：${describeCharAt(text, i)}`)

  const total = intEnd - intStart + (fracEnd - fracStart)
  // 🔴 这一道闸必须**在**构造 BigInt 之前，理由见模块文档
  if (total > MAX_TIMESTAMP_DIGITS) {
    return bad(signStart, `这一串有 ${total} 位数字，而一个时间戳最多认 ${MAX_TIMESTAMP_DIGITS} 位`)
  }

  // 前导零不算位数：`0000001700000000` 是秒，不是纳秒
  let first = intStart
  while (first < intEnd - 1 && text.charCodeAt(first) === 0x30) first++
  const unit = unitFor(intEnd - first)
  const fracLen = fracEnd - fracStart

  const scaled = BigInt(text.slice(intStart, intEnd) + text.slice(fracStart, fracEnd))
  const divisor = DENOMINATOR[unit] * 10n ** BigInt(fracLen)
  const numerator = scaled * NUMERATOR[unit]
  const quotient = numerator / divisor
  const remainder = numerator % divisor
  // ⚠️ BigInt 的除法是**朝零截断**的，而时刻要的是**朝下取整**：
  // −1.5 秒该是 −2000 毫秒（更早的那一刻），不是 −1000
  const msBig = negative ? (remainder === 0n ? -quotient : -(quotient + 1n)) : quotient

  if (msBig > BigInt(SAFE_MS) || msBig < -BigInt(SAFE_MS)) {
    return bad(signStart, `这一串换算出来是 ${msBig} 毫秒，超出了能表示的范围（公元 -271821 年到 275760 年）`)
  }
  return {
    kind: 'ok',
    ms: Number(msBig),
    zone: 'absolute',
    unit,
    dropped: remainder === 0n ? '' : decimalOf(remainder, divisor),
  }
}

/**
 * 把 `YYYY-MM-DD[THH:mm[:ss[.frac]]][Z|±HH[:mm]]` 读成一个时刻。分隔符也收 `/` 与 `.`。
 *
 * 🔴 全程用显式下标走，不用正则：正则报不出「错在第几个字符」，而 `describeErrorAt`
 * 要的正是一个下标。代价是这个函数长，收益是**每一处**失败都说得清自己在哪儿
 */
function parseIso(text: string, start: number, end: number): TimeParse {
  let i = start
  for (let k = 0; k < 4; k++, i++) {
    if (i >= end || !isDigit(text.charCodeAt(i))) {
      return bad(i, '该是一个日期（YYYY-MM-DD，也收 YYYY/MM/DD 与 YYYY.MM.DD）或者一串时间戳，这里是年份的四位数字')
    }
  }
  const year = Number(text.slice(i - 4, i))

  const separator = text[i]
  if (separator !== '-' && separator !== '/' && separator !== '.') {
    return bad(i, `年份后面该是「-」「/」「.」之一，而不是${describeCharAt(text, i)}`)
  }
  i++

  const month = twoDigits(text, i, end)
  if (month < 0) return bad(i, `月份该是两位数字（01…12），而不是${describeCharAt(text, i)}`)
  const monthStart = i
  i += 2
  if (month < 1 || month > 12) return bad(monthStart, `月份该是 01…12，而不是 ${String(month).padStart(2, '0')}`)

  if (text[i] !== separator) {
    return bad(i, `这里的分隔符该与前面那个一样（「${separator}」），而不是${describeCharAt(text, i)}`)
  }
  i++

  const day = twoDigits(text, i, end)
  if (day < 0) return bad(i, `日该是两位数字（01…31），而不是${describeCharAt(text, i)}`)
  const dayStart = i
  i += 2
  const days = daysInMonth(year, month)
  // 🔴 这一句是整个自写解析器的**存在理由**：`new Date('2024-02-30')` 会给出 3 月 1 日
  if (day < 1 || day > days) return bad(dayStart, `${year} 年 ${month} 月只有 ${days} 天，没有 ${day} 日`)

  let hour = 0
  let minute = 0
  let second = 0
  let fracMs = 0
  let dropped = ''
  let zone: 'explicit' | 'local' = 'local'
  let offsetMinutes = 0

  if (i < end && (text[i] === 'T' || text[i] === 't' || text[i] === ' ')) {
    i++
    hour = twoDigits(text, i, end)
    if (hour < 0) return bad(i, `小时该是两位数字（00…23），而不是${describeCharAt(text, i)}`)
    const hourStart = i
    i += 2
    if (hour > 23) return bad(hourStart, `小时该是 00…23，而不是 ${String(hour).padStart(2, '0')}`)

    if (text[i] !== ':') return bad(i, `小时后面该是「:」，而不是${describeCharAt(text, i)}`)
    i++

    minute = twoDigits(text, i, end)
    if (minute < 0) return bad(i, `分钟该是两位数字（00…59），而不是${describeCharAt(text, i)}`)
    const minuteStart = i
    i += 2
    if (minute > 59) return bad(minuteStart, `分钟该是 00…59，而不是 ${String(minute).padStart(2, '0')}`)

    if (i < end && text[i] === ':') {
      i++
      second = twoDigits(text, i, end)
      if (second < 0) return bad(i, `秒该是两位数字（00…59），而不是${describeCharAt(text, i)}`)
      const secondStart = i
      i += 2
      // ⚠️ 闰秒单独说：`23:59:60` 在真实世界里存在过几十次，一句「该是 00…59」读起来像是工具不认识它
      if (second === 60) {
        return bad(secondStart, '这一格只到毫秒，装不下闰秒（第 60 秒）。写成 59 秒，或者整个往后挪一秒')
      }
      if (second > 59) return bad(secondStart, `秒该是 00…59，而不是 ${String(second).padStart(2, '0')}`)
    }

    if (i < end && (text[i] === '.' || text[i] === ',')) {
      i++
      const fracStart = i
      while (i < end && isDigit(text.charCodeAt(i))) i++
      if (i === fracStart) return bad(i, '小数点后面该是数字')
      const frac = text.slice(fracStart, i)
      fracMs = Number(frac.slice(0, 3).padEnd(3, '0'))
      const rest = frac.slice(3).replace(/0+$/, '')
      if (rest !== '') dropped = `0.${rest}`
    }

    if (i < end) {
      const mark = text[i]
      if (mark === 'Z' || mark === 'z') {
        zone = 'explicit'
        i++
      } else if (mark === '+' || mark === '-') {
        zone = 'explicit'
        i++
        const offsetHour = twoDigits(text, i, end)
        if (offsetHour < 0) return bad(i, `时区的小时该是两位数字（00…23），而不是${describeCharAt(text, i)}`)
        const offsetHourStart = i
        i += 2
        if (offsetHour > 23) {
          return bad(offsetHourStart, `时区的小时该是 00…23，而不是 ${String(offsetHour).padStart(2, '0')}`)
        }
        let offsetMinute = 0
        if (i < end && text[i] === ':') i++
        if (i < end && isDigit(text.charCodeAt(i))) {
          offsetMinute = twoDigits(text, i, end)
          if (offsetMinute < 0) return bad(i, `时区的分钟该是两位数字（00…59），而不是${describeCharAt(text, i)}`)
          const offsetMinuteStart = i
          i += 2
          if (offsetMinute > 59) {
            return bad(offsetMinuteStart, `时区的分钟该是 00…59，而不是 ${String(offsetMinute).padStart(2, '0')}`)
          }
        }
        offsetMinutes = (mark === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute)
      } else {
        return bad(i, `时间后面该是时区（「Z」或者「+08:00」），或者到此为止，而不是${describeCharAt(text, i)}`)
      }
    }
  }

  if (i !== end) return bad(i, `日期后面还跟着别的东西：${describeCharAt(text, i)}`)

  // 🔴 用 `setUTCFullYear` / `setFullYear` 而不是 `Date.UTC(year, …)` / `new Date(year, …)`：
  // 后两个把 0…99 的年份**重映射**到 1900…1999，于是 `0099-01-01` 会变成 1999 年。
  // `set*FullYear` 是全平台唯一不做这件重事的入口
  const at = new Date(0)
  let ms: number
  if (zone === 'explicit') {
    at.setUTCFullYear(year, month - 1, day)
    at.setUTCHours(hour, minute, second, fracMs)
    ms = at.getTime() - offsetMinutes * 60_000
  } else {
    at.setFullYear(year, month - 1, day)
    at.setHours(hour, minute, second, fracMs)
    ms = at.getTime()
  }

  // ⚠️ 这里**不**卡范围：年份只收四位，于是 ISO 那一条能给出的最远时刻是
  // 公元 9999 年（253402300799000 毫秒），离 `SAFE_MS` 还差三十多倍。
  // 一个结构上到不了的检查只会让读的人以为「四位数字也可能超范围」
  return { kind: 'ok', ms, zone, unit: null, dropped }
}

/**
 * 一串文字 → 一个时刻。
 *
 * ⚠️ **只**认两种形状：一串数字（可带符号与小数），或者 ISO 8601 的日期时间。
 * 别的都带着位置报错，⛔ 不给一个「猜的」答案
 *
 * 🔴 分派规则是「**第一段数字是不是恰好 4 位、并且后面跟着一个日期分隔符**」，
 * 而不是「第一个字符是不是数字」。后一种写法在 `1700000000abc` 上会走进日期那一条，
 * 然后在第 5 个字符上报「年份后面该是「-」」——一句完全指错方向的话。
 * 现在这一串走数字那一条，报的是「数字后面还跟着别的东西：「a」」，指着第 11 个字符
 */
export function parseTime(text: string): TimeParse {
  let start = 0
  while (start < text.length && isAsciiSpace(text.charCodeAt(start))) start++
  let end = text.length
  while (end > start && isAsciiSpace(text.charCodeAt(end - 1))) end--
  if (start === end) {
    return bad(start, '这一格是空的：写一个时间戳（1700000000）或者一个日期（2024-03-05）进来')
  }

  let i = start
  const sign = text.charCodeAt(i)
  if (sign === 0x2b || sign === 0x2d) i++
  const runStart = i
  while (i < end && isDigit(text.charCodeAt(i))) i++

  let numeric = false
  const run = i - runStart
  if (run > 0) {
    if (run !== 4) numeric = true
    else {
      const after = text[i]
      numeric = after !== '-' && after !== '/' && after !== '.'
    }
  }
  return numeric ? parseNumeric(text, start, end) : parseIso(text, start, end)
}

/**
 * 这一刻本机相对 UTC 偏多少**分钟**（东边为正）。
 *
 * 🔴 符号与平台的 `getTimezoneOffset()` **相反**：那一个返回「UTC 减本地」，
 * 于是 UTC+8 给 −480。这里翻过来，因为 `offsetLabel` 要写的是 `UTC+08:00`，
 * 而让用户去读一个与标签反号的数是没有必要的负担
 *
 * ⚠️ 收 `ms` 而不是无参：有夏令时的时区在一年里给出两个不同的偏移，
 * 而报告要说的是**那一刻**的偏移
 */
export function localOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset()
}

/** 分钟偏移 → `UTC` / `UTC+08:00` / `UTC-05:30` */
export function offsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'UTC'
  const absolute = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const minutes = String(absolute % 60).padStart(2, '0')
  return `UTC${offsetMinutes < 0 ? '-' : '+'}${hours}:${minutes}`
}

/**
 * 把一刻渲染成 `2023-11-15 06:13:20 星期三`，**在 `offsetMinutes` 那个时区里**。
 *
 * 🔴 实现是「先把偏移加到毫秒上，再一律用 UTC 的取值器」。绕这一圈是为了**可测**：
 * 直接调 `toLocaleString` 的话结果取决于本机的时区与 ICU 数据，
 * 而 CI 跑 ubuntu、本机是 macOS，两边会给出两个字符串。
 * 现在 `formatAt(ms, 480)` 在任何一台机器上都是同一句话
 *
 * ⚠️ 加偏移那一步会超出 `MAX_DATE_MS`，所以 `SAFE_MS` 留了一整天，见它自己的注释
 */
export function formatAt(ms: number, offsetMinutes: number): string {
  const at = new Date(ms + offsetMinutes * 60_000)
  const year = String(at.getUTCFullYear()).padStart(4, '0')
  const month = String(at.getUTCMonth() + 1).padStart(2, '0')
  const day = String(at.getUTCDate()).padStart(2, '0')
  const hours = String(at.getUTCHours()).padStart(2, '0')
  const minutes = String(at.getUTCMinutes()).padStart(2, '0')
  const seconds = String(at.getUTCSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${WEEKDAYS[at.getUTCDay()]!}`
}

/**
 * 一刻 → `2023-11-14T22:13:20Z`。
 *
 * ⚠️ 末尾那个 `.000` 要抹掉：整秒的时刻在日志里占绝大多数，
 * 而 `.000` 那三个字符既不携带信息也不便于粘回别处。
 * 毫秒不为零时它们照原样留着（`.123Z`）
 */
export function formatIso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z')
}

/**
 * 一份报告：五行时刻 + 若干句披露。
 *
 * ⚠️ `now` 是**递进来**的，不在里面读 `Date.now()`：空输入要给「现在这一刻」，
 * 而那样一来这个函数就不纯了，用例也没法钉住确切的字符串
 *
 * 🔴 每一句披露都不是装饰，它们各自对应一条「用户可能猜错」的规则：
 * 空输入（给的是现在）、单位（是猜的）、时区（我们按本地理解，与规范不同）、
 * 精度（比毫秒细的装不下）。⛔ 一句都不要删
 */
export function timeReport(text: string, now: number): ToolResult {
  const empty = text.trim() === ''
  const parsed: TimeParse = empty ? { kind: 'ok', ms: now, zone: 'absolute', unit: null, dropped: '' } : parseTime(text)
  if (parsed.kind === 'error') {
    const { offset, expected } = parsed.error
    return { kind: 'error', text: describeErrorAt(text, offset, expected), at: offset }
  }

  const { ms, zone, unit, dropped } = parsed
  const localOffset = localOffsetMinutes(ms)
  const lines = [
    `本地：${formatAt(ms, localOffset)}（${offsetLabel(localOffset)}）`,
    `UTC：${formatAt(ms, 0)}`,
    `ISO：${formatIso(ms)}`,
    `秒：${Math.floor(ms / 1000)}`,
    `毫秒：${ms}`,
  ]

  const notes: string[] = []
  if (empty) notes.push('（这一格是空的，给的是现在这一刻）')
  if (unit !== null) notes.push(`（输入读成「${unit}」）`)
  if (zone === 'local') notes.push(`（输入里没写时区，按本地时间 ${offsetLabel(localOffset)} 理解）`)
  if (dropped !== '') notes.push(`⚠️ 这一格只到毫秒，输入里比毫秒更细的「${dropped}」毫秒装不下`)

  const year = new Date(ms).getUTCFullYear()
  if (unit !== null && (year < PLAUSIBLE_MIN_YEAR || year > PLAUSIBLE_MAX_YEAR)) {
    notes.push(`⚠️ 这个时刻落在公元 ${year} 年。位数是单位的线索：10 位是秒、13 位是毫秒、16 位是微秒、19 位是纳秒`)
  }

  return { kind: 'ok', text: notes.length === 0 ? lines.join('\n') : `${lines.join('\n')}\n\n${notes.join('\n')}` }
}
