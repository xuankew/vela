/**
 * `tools/time.ts` 的用例。
 *
 * ## 🔴 这一份文件里的每一句断言都必须与本机时区无关
 *
 * CI 跑 ubuntu（TZ = UTC），本机是 UTC+8（`getTimezoneOffset()` 给 −480）。
 * 于是「没写时区」那一类只能断言**等式**——`new Date(2024, 2, 5).getTime()` 在两个时区里
 * 是两个不同的数，但它永远等于被测代码算出来的那一个。
 * 而「写了时区」与「纯数字」两类是绝对时刻，可以直接钉死数字。
 *
 * ⚠️ 报告里那一行「本地：…」因此**只能**用正则去量形状，⛔ 不能写死字符串
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_DATE_MS,
  daysInMonth,
  formatAt,
  formatIso,
  localOffsetMinutes,
  offsetLabel,
  parseTime,
  timeReport,
  unitFor,
} from './time'

type Ok = Extract<ReturnType<typeof parseTime>, { kind: 'ok' }>

/** 断言解析成功并把成功那一支取出来。失败时把消息带上，省得回去加一次 `console.log` */
function ok(text: string): Ok {
  const parsed = parseTime(text)
  if (parsed.kind !== 'ok') throw new Error(`「${text}」本该解析成功，却是：${parsed.error.expected}`)
  return parsed
}

/** 断言解析失败，并把「下标 + 那句人话」一起交出来 */
function bad(text: string): { offset: number; expected: string } {
  const parsed = parseTime(text)
  if (parsed.kind !== 'error') throw new Error(`「${text}」本该报错，却给出了 ${parsed.ms}`)
  return parsed.error
}

describe('纯数字：四种单位都认，而且如实说自己认成了哪一种', () => {
  it('10 位是秒', () => {
    expect(ok('1700000000')).toEqual({
      kind: 'ok',
      ms: 1700000000000,
      zone: 'absolute',
      unit: '秒',
      dropped: '',
    })
  })

  it('13 位是毫秒', () => {
    expect(ok('1700000000123').ms).toBe(1700000000123)
    expect(ok('1700000000123').unit).toBe('毫秒')
  })

  it('16 位是微秒：毫秒以上的部分被截掉，而截掉了多少要说出来', () => {
    const parsed = ok('1700000000123456')
    expect(parsed.unit).toBe('微秒')
    expect(parsed.ms).toBe(1700000000123)
    expect(parsed.dropped).toBe('0.456')
  })

  it('19 位是纳秒', () => {
    const parsed = ok('1700000000123456789')
    expect(parsed.unit).toBe('纳秒')
    expect(parsed.ms).toBe(1700000000123)
    expect(parsed.dropped).toBe('0.456789')
  })

  it('带小数：单位由**整数部分**的位数决定，不是由总位数', () => {
    // ⚠️ 这一条钉的是一个真会写错的地方：拿总位数（13）去猜的话 `1700000000.123`
    // 会被读成毫秒，于是给出公元 55871 年
    expect(ok('1700000000.5').ms).toBe(1700000000500)
    expect(ok('1700000000.5').unit).toBe('秒')
    expect(ok('1700000000.5').dropped).toBe('')
    expect(ok('1700000000.1234').ms).toBe(1700000000123)
    expect(ok('1700000000.1234').dropped).toBe('0.4')
  })

  it('正负号都收，而负数朝**下**取整', () => {
    expect(ok('+1700000000').ms).toBe(1700000000000)
    expect(ok('-1700000000').ms).toBe(-1700000000000)
    // 🔴 1970 年之前的时刻：−1700000000123.456 毫秒该落到 −…124，不是 −…123。
    // BigInt 的除法是朝零截断的，不补这一步的话负数会**晚**一毫秒
    const parsed = ok('-1700000000123456')
    expect(parsed.ms).toBe(-1700000000124)
    expect(parsed.dropped).toBe('0.456')
  })

  it('前导零不算位数', () => {
    const parsed = ok('0000001700000000')
    expect(parsed.unit).toBe('秒')
    expect(parsed.ms).toBe(1700000000000)
  })

  it('0 就是 1970-01-01T00:00:00Z', () => {
    expect(ok('0').ms).toBe(0)
    expect(ok('0').unit).toBe('秒')
  })

  it('两头的空白吃掉，中间的不吃', () => {
    expect(ok('  1700000000 \n').ms).toBe(1700000000000)
    const error = bad('1700000000 1')
    expect(error.offset).toBe(10)
    // ⚠️ 指的是那个**空格**，而空格在 textarea 里是看不见的，所以报码位而不是字形
    expect(error.expected).toBe('数字后面还跟着别的东西：这个字符（U+0020）')
  })

  it('位数猜错时输出里那一句披露是唯一的线索，所以 `unitFor` 的四个边界都要钉住', () => {
    expect(unitFor(1)).toBe('秒')
    expect(unitFor(11)).toBe('秒')
    expect(unitFor(12)).toBe('毫秒')
    expect(unitFor(14)).toBe('毫秒')
    expect(unitFor(15)).toBe('微秒')
    expect(unitFor(17)).toBe('微秒')
    expect(unitFor(18)).toBe('纳秒')
    expect(unitFor(25)).toBe('纳秒')
  })
})

describe('纯数字：两道闸', () => {
  it('超过 25 位就拒绝，而且**在**构造 BigInt 之前拒绝', () => {
    // 🔴 这一条不是「输入洁癖」：`store.ts` 允许一格一百万个字符，而 BigInt 的除法
    // 不是线性的。没有这道闸的话粘一百万个 9 进来就是一次看得见的卡死
    const digits = '9'.repeat(26)
    const error = bad(digits)
    expect(error.offset).toBe(0)
    expect(error.expected).toContain('26 位数字')
    expect(error.expected).toContain('最多认 25 位')
    // 整数位 + 小数位是**加起来**算的
    expect(bad(`1.${'9'.repeat(30)}`).expected).toContain('31 位数字')
  })

  it('换算出来超出 Date 的范围就拒绝，而那一天余量是留给渲染的', () => {
    // 🔴 只有纳秒那一条能撞到这道闸：秒/毫秒/微秒按位数上限最多给出 1e14 毫秒，
    // 而 22 位以上的纳秒能给出 1e16 毫秒，超过了 8.64e15
    expect(bad('9'.repeat(23)).expected).toContain('超出了能表示的范围')
    // 刚好在 `SAFE_MS` 上：能过，而且**渲染时**加上 14 小时偏移也不炸
    expect(ok('8639999913600000000000').ms).toBe(MAX_DATE_MS - 86_400_000)
    expect(formatAt(MAX_DATE_MS - 86_400_000, 14 * 60)).not.toContain('NaN')
    // 🔴 真正会抛的是 `formatIso` 里的 `toISOString()`，所以那一份报告也要能出得来
    expect(timeReport('8639999913600000000000', 0).kind).toBe('ok')
    expect(bad('8639999913600001000000').expected).toContain('超出了能表示的范围')
    // 四位数的年份最远到 9999，离上限还有三十多倍，所以 ISO 那一条**不需要**这道闸
    expect(ok('9999-12-31T23:59:59Z').ms).toBe(253402300799000)
  })

  it('`MAX_DATE_MS` 真的是引擎的那一条线，不是我们自己编的一个数', () => {
    expect(() => new Date(MAX_DATE_MS).toISOString()).not.toThrow()
    expect(() => new Date(MAX_DATE_MS + 1).toISOString()).toThrow(RangeError)
  })
})

describe('ISO：能读的形状', () => {
  it('只写日期 = 本地零点（🔴 这一条是**故意**与 `new Date` 不一样的）', () => {
    const parsed = ok('2024-03-05')
    expect(parsed.ms).toBe(new Date(2024, 2, 5).getTime())
    expect(parsed.zone).toBe('local')
    expect(parsed.unit).toBeNull()
    // ⚠️ `new Date('2024-03-05')` 给的是 **UTC** 零点，在 UTC+8 上差 8 小时。
    // 这一行把那条分歧钉在这里，将来谁想「改成与规范一致」会先撞红
    if (new Date().getTimezoneOffset() !== 0) {
      expect(parsed.ms).not.toBe(Date.UTC(2024, 2, 5))
    }
  })

  it('写了时间但没写时区，也是本地', () => {
    expect(ok('2024-03-05T12:34:56').ms).toBe(new Date(2024, 2, 5, 12, 34, 56).getTime())
    expect(ok('2024-03-05 12:34:56').ms).toBe(new Date(2024, 2, 5, 12, 34, 56).getTime())
    expect(ok('2024-03-05t12:34:56').ms).toBe(new Date(2024, 2, 5, 12, 34, 56).getTime())
    expect(ok('2024-03-05T12:34:56').zone).toBe('local')
  })

  it('写了时区就是绝对时刻，可以直接钉死数字', () => {
    expect(ok('2024-03-05T12:34:56Z').ms).toBe(Date.UTC(2024, 2, 5, 12, 34, 56))
    expect(ok('2024-03-05T12:34:56z').ms).toBe(Date.UTC(2024, 2, 5, 12, 34, 56))
    expect(ok('2024-03-05T12:34:56+08:00').ms).toBe(Date.UTC(2024, 2, 5, 4, 34, 56))
    expect(ok('2024-03-05T12:34:56+0800').ms).toBe(Date.UTC(2024, 2, 5, 4, 34, 56))
    expect(ok('2024-03-05T12:34:56+08').ms).toBe(Date.UTC(2024, 2, 5, 4, 34, 56))
    expect(ok('2024-03-05T12:34:56-05:30').ms).toBe(Date.UTC(2024, 2, 5, 18, 4, 56))
    expect(ok('2024-03-05T12:34:56Z').zone).toBe('explicit')
  })

  it('秒可以省，小数可以带，逗号也当小数点', () => {
    expect(ok('2024-03-05T12:34').ms).toBe(new Date(2024, 2, 5, 12, 34).getTime())
    expect(ok('2024-03-05T12:34:56.123Z').ms).toBe(Date.UTC(2024, 2, 5, 12, 34, 56, 123))
    expect(ok('2024-03-05T12:34:56,123Z').ms).toBe(Date.UTC(2024, 2, 5, 12, 34, 56, 123))
    expect(ok('2024-03-05T12:34:56.1Z').ms).toBe(Date.UTC(2024, 2, 5, 12, 34, 56, 100))
  })

  it('比毫秒更细的部分被截掉，而截掉了多少要说出来', () => {
    const parsed = ok('2024-03-05T12:34:56.123456Z')
    expect(parsed.ms).toBe(Date.UTC(2024, 2, 5, 12, 34, 56, 123))
    expect(parsed.dropped).toBe('0.456')
    // ⚠️ 末尾是零的话**不算**截掉了什么：`.123000` 与 `.123` 是同一个时刻
    expect(ok('2024-03-05T12:34:56.123000Z').dropped).toBe('')
  })

  it('`/` 与 `.` 也当分隔符，但两个分隔符必须一样', () => {
    expect(ok('2024/03/05').ms).toBe(new Date(2024, 2, 5).getTime())
    expect(ok('2024.03.05').ms).toBe(new Date(2024, 2, 5).getTime())
    expect(bad('2024-03/05').expected).toBe('这里的分隔符该与前面那个一样（「-」），而不是「/」')
  })

  it('年份的 0…99 不会被重映射到 1900…1999', () => {
    // 🔴 `Date.UTC(99, 0, 1)` 自己就会重映射，所以拿它当期望值是**循环论证**。
    // 这里改成钉渲染出来的那一句：它是这条规则唯一的可观察后果
    expect(formatIso(ok('0099-01-01T00:00:00Z').ms)).toBe('0099-01-01T00:00:00Z')
    expect(formatIso(ok('0001-01-01T00:00:00Z').ms)).toBe('0001-01-01T00:00:00Z')
  })
})

describe('ISO：拒绝，而且每一处都带着位置', () => {
  it('🔴 `2024-02-30` 是**不存在的日子**，而 `new Date` 会悄悄地给出 3 月 1 日', () => {
    expect(new Date('2024-02-30').toISOString()).toBe('2024-03-01T00:00:00.000Z')
    const error = bad('2024-02-30')
    expect(error.offset).toBe(8)
    expect(error.expected).toBe('2024 年 2 月只有 29 天，没有 30 日')
  })

  it('闰年算得对，于是 2 月 29 日在 2024 年过、在 2023 年不过', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2023, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)
    expect(daysInMonth(2024, 4)).toBe(30)
    expect(ok('2024-02-29').ms).toBe(new Date(2024, 1, 29).getTime())
    expect(bad('2023-02-29').expected).toBe('2023 年 2 月只有 28 天，没有 29 日')
    expect(bad('2024-04-31').expected).toBe('2024 年 4 月只有 30 天，没有 31 日')
  })

  it('月份、小时、分钟超出范围时，报的是**值**而不只是「不合法」', () => {
    expect(bad('2024-13-01')).toEqual({ offset: 5, expected: '月份该是 01…12，而不是 13' })
    expect(bad('2024-00-01')).toEqual({ offset: 5, expected: '月份该是 01…12，而不是 00' })
    expect(bad('2024-03-05T25:00:00')).toEqual({ offset: 11, expected: '小时该是 00…23，而不是 25' })
    expect(bad('2024-03-05T12:60:00')).toEqual({ offset: 14, expected: '分钟该是 00…59，而不是 60' })
    expect(bad('2024-03-05T12:34:99')).toEqual({ offset: 17, expected: '秒该是 00…59，而不是 99' })
  })

  it('第 60 秒单独说：它在真实世界里存在过，一句「该是 00…59」读起来像是工具不认识它', () => {
    const error = bad('2024-06-30T23:59:60Z')
    expect(error.offset).toBe(17)
    expect(error.expected).toContain('闰秒')
  })

  it('不肯补零就报错，⛔ 不放宽成「一两位都行」', () => {
    expect(bad('2024-3-05').expected).toBe('月份该是两位数字（01…12），而不是「3」')
    expect(bad('2024-03-5').expected).toBe('日该是两位数字（01…31），而不是「5」')
    expect(bad('2024-03-05T1:34:56').expected).toBe('小时该是两位数字（00…23），而不是「1」')
  })

  it('读到一半就没了的时候，说的是「末尾」而不是「undefined」', () => {
    expect(bad('2024-03').expected).toBe('这里的分隔符该与前面那个一样（「-」），而不是末尾')
    expect(bad('2024-').expected).toBe('月份该是两位数字（01…12），而不是末尾')
    expect(bad('2024-03-05T12:34:56.').expected).toBe('小数点后面该是数字')
  })

  it('多出来的东西要指着第一个多出来的字符', () => {
    expect(bad('2024-03-05X')).toEqual({ offset: 10, expected: '日期后面还跟着别的东西：「X」' })
    expect(bad('2024-03-05T12:34:56Q').expected).toBe(
      '时间后面该是时区（「Z」或者「+08:00」），或者到此为止，而不是「Q」',
    )
    expect(bad('2024-03-05T12:34:56+08:00X').expected).toBe('日期后面还跟着别的东西：「X」')
  })

  it('看不出是日期的时候，那一句要把**两种**形状都说出来', () => {
    const error = bad('abc')
    expect(error.offset).toBe(0)
    expect(error.expected).toContain('YYYY-MM-DD')
    expect(error.expected).toContain('一串时间戳')
  })

  it('🔴 分派按「第一段数字是不是 4 位」走，于是数字后面的垃圾报在数字后面', () => {
    // 走进日期那一条的话这里会报「年份后面该是「-」」并指着第 5 个字符——完全指错方向
    expect(bad('1700000000abc')).toEqual({ offset: 10, expected: '数字后面还跟着别的东西：「a」' })
    // 而 4 位数字后面跟着分隔符的，还是日期
    expect(ok('2024-03-05').zone).toBe('local')
    expect(ok('2024').unit).toBe('秒')
  })

  it('空的那一格说的是「写点什么进来」', () => {
    expect(bad('').expected).toContain('这一格是空的')
    expect(bad('   \n ').expected).toContain('这一格是空的')
  })
})

describe('渲染：三件与本机时区无关的事', () => {
  it('`offsetLabel` 把分钟偏移写成 `UTC±HH:MM`，零偏移只写 `UTC`', () => {
    expect(offsetLabel(0)).toBe('UTC')
    expect(offsetLabel(480)).toBe('UTC+08:00')
    expect(offsetLabel(-330)).toBe('UTC-05:30')
    expect(offsetLabel(60)).toBe('UTC+01:00')
    expect(offsetLabel(-5)).toBe('UTC-00:05')
  })

  it('`localOffsetMinutes` 的符号与平台的 `getTimezoneOffset()` **相反**', () => {
    // 🔴 这一行钉的就是那次翻转本身：平台返回「UTC 减本地」，UTC+8 给 −480，
    // 而 `offsetLabel` 要写的是 `UTC+08:00`。两个符号同时出现在一份报告里是没有必要的负担
    expect(localOffsetMinutes(0) + new Date(0).getTimezoneOffset()).toBe(0)
    expect(offsetLabel(localOffsetMinutes(0))).toMatch(/^UTC([+-]\d{2}:\d{2})?$/)
  })

  it('`formatAt` 收偏移量，于是在哪一台机器上都是同一句话', () => {
    expect(formatAt(1700000000000, 0)).toBe('2023-11-14 22:13:20 星期二')
    expect(formatAt(1700000000000, 480)).toBe('2023-11-15 06:13:20 星期三')
    expect(formatAt(1700000000000, -330)).toBe('2023-11-14 16:43:20 星期二')
    expect(formatAt(0, 0)).toBe('1970-01-01 00:00:00 星期四')
    // 跨日与跨月各来一发：偏移是把毫秒加上去再一律读 UTC，所以边界全靠 `Date` 自己
    expect(formatAt(Date.UTC(2024, 1, 29, 20, 0, 0), 480)).toBe('2024-03-01 04:00:00 星期五')
  })

  it('`formatIso` 抹掉整秒那个 `.000`，毫秒不为零时留着', () => {
    expect(formatIso(1700000000000)).toBe('2023-11-14T22:13:20Z')
    expect(formatIso(1700000000123)).toBe('2023-11-14T22:13:20.123Z')
    expect(formatIso(0)).toBe('1970-01-01T00:00:00Z')
  })
})

describe('报告：五行时刻 + 每一句披露', () => {
  /** 把报告拆成「时刻那几行」与「披露那几句」两半 */
  function report(text: string, now = 0): { lines: string[]; notes: string[] } {
    const result = timeReport(text, now)
    if (result.kind !== 'error') {
      const [head, tail = ''] = result.text.split('\n\n')
      return { lines: head!.split('\n'), notes: tail === '' ? [] : tail.split('\n') }
    }
    throw new Error(`「${text}」本该出一份报告，却是：${result.text}`)
  }

  it('五行都在，顺序是 本地 / UTC / ISO / 秒 / 毫秒', () => {
    const { lines } = report('1700000000')
    expect(lines).toHaveLength(5)
    expect(lines[1]).toBe('UTC：2023-11-14 22:13:20 星期二')
    expect(lines[2]).toBe('ISO：2023-11-14T22:13:20Z')
    expect(lines[3]).toBe('秒：1700000000')
    expect(lines[4]).toBe('毫秒：1700000000000')
    // ⚠️ 本地那一行**只能**量形状：它的字符串取决于跑用例那台机器的时区
    expect(lines[0]).toMatch(/^本地：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 星期.（UTC([+-]\d{2}:\d{2})?）$/)
  })

  it('🔴 用全角冒号而**不做列对齐**：三个标签的显示宽度是 4 / 3 / 1，`padEnd` 对不齐', () => {
    const { lines } = report('1700000000')
    for (const line of lines) expect(line).toMatch(/^(本地|UTC|ISO|秒|毫秒)：/)
  })

  it('纯数字要说「读成了哪一种单位」，⛔ 不能说「没写时区」', () => {
    const { notes } = report('1700000000')
    expect(notes).toEqual(['（输入读成「秒」）'])
  })

  it('写了日期但没写时区要说「按本地理解」，⛔ 不能说单位', () => {
    const { notes } = report('2024-03-05')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/^（输入里没写时区，按本地时间 UTC([+-]\d{2}:\d{2})? 理解）$/)
  })

  it('写了时区的话一句披露都没有，于是报告里连那个空行都不出现', () => {
    const result = timeReport('2024-03-05T12:34:56Z', 0)
    expect(result.kind).toBe('ok')
    expect(result.text).not.toContain('\n\n')
    expect(report('2024-03-05T12:34:56Z').notes).toEqual([])
  })

  it('空的那一格给「现在这一刻」，而 `now` 是递进来的，所以这一句是确定的', () => {
    const { lines, notes } = report('', 1700000000000)
    expect(lines[2]).toBe('ISO：2023-11-14T22:13:20Z')
    expect(notes).toEqual(['（这一格是空的，给的是现在这一刻）'])
  })

  it('截掉过精度要说，落在 1900…2200 之外要再说一句位数的提示', () => {
    expect(report('1700000000123456').notes).toEqual([
      '（输入读成「微秒」）',
      '⚠️ 这一格只到毫秒，输入里比毫秒更细的「0.456」毫秒装不下',
    ])
    // 11 位 → 秒 → 公元 5138 年。这一句是「单位猜错了」唯一的自救线索
    const notes = report('99999999999').notes
    expect(notes[0]).toBe('（输入读成「秒」）')
    expect(notes[1]).toContain('公元 5138 年')
    expect(notes[1]).toContain('10 位是秒、13 位是毫秒、16 位是微秒、19 位是纳秒')
    // ⚠️ 而 ISO 那一条**不**说这句：`5138-01-01` 是用户自己写出来的年份，不是猜的
    expect(report('5138-01-01').notes).toHaveLength(1)
  })

  it('出错时把「跳到出错处」那一个下标一并交出去', () => {
    const result = timeReport('2024-02-30', 0)
    expect(result.kind).toBe('error')
    expect(result.at).toBe(8)
    expect(result.text).toBe('第 1 行第 9 列：2024 年 2 月只有 29 天，没有 30 日\n  2024-02-30\n          ^')
  })

  it('🔴 开头那个换行被吃掉，而报出来的下标仍然是**原始串**里的', () => {
    // 这一格只解析一个时刻，所以「第 2 行」只可能来自开头的空白。
    // `start` 跳过了那一个字符，于是解析器内部的下标全都得加回去——
    // 少了这一步的话「跳到出错处」会选中上一行
    const result = timeReport('\n2024-13-01', 0)
    expect(result.kind).toBe('error')
    expect(result.at).toBe(6)
    expect(result.text.startsWith('第 2 行第 6 列：月份该是 01…12，而不是 13')).toBe(true)
  })
})
