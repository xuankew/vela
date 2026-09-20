import { describe, expect, it } from 'vitest'
import { formatUuid, platformBytes, uuidList, UUID_BYTES, type ByteSource } from './uuid'

/**
 * UUID v4（M3-B-4）。
 *
 * 这一份钉的是**位与形状**：版本位、变体位、连字符、大小写、批量。
 * ⚠️ 「随机性够不够随机」不在这里问——那要么是真机的熵源问题，要么是
 * `getRandomValues` 自己的契约，两者都不是这十行代码能负责的
 */

/** 一个把缓冲区填成固定图案的随机源。`fill(i)` 给的是第 i 个字节该是什么 */
function fixed(fill: (index: number) => number): ByteSource {
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = fill(i)
  }
}

const ZERO = fixed(() => 0)
const ONES = fixed(() => 0xff)
/** 0x00 0x01 0x02 …。⚠️ 按下标 & 0xff，所以生成 17 个以上时图案会绕回来——这一份只用来生成一个 */
const RAMP = fixed((i) => i & 0xff)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('版本位与变体位', () => {
  it('🔴 全 0 的随机字节出来的是那个教科书上的样子', () => {
    // 第 7 字节的高四位被设成 0100（版本 4），第 9 字节的高两位被设成 10（RFC 4122 变体）。
    // 全 0 输入让这两处成为**唯一**非零的位，于是「设错了哪一位」在这一条上是看得见的
    expect(uuidList(1, false, true, ZERO)).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('🔴 全 1 的随机字节只改掉那 6 位，其余 122 位原样留着', () => {
    // 这一条是「掩掉再或上去」与「直接赋 0x40 / 0x80」的分水岭：
    // 直接赋值的话这里会是 `…-40ff-80ff-…`，把本该随机的 4 + 6 位也吃掉了
    expect(uuidList(1, false, true, ONES)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })

  it('递增图案：只有下标 6 与 8 两个字节与输入不同', () => {
    expect(uuidList(1, false, true, RAMP)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
    // 0x06 → 0x46（高四位置成 0100，低四位 0110 留着）、0x08 → 0x88（高两位置成 10，低六位留着）
  })

  it('真随机源出来的 200 个全都合形状、而且互不重复', () => {
    const lines = uuidList(200, false, true).split('\n')
    expect(lines).toHaveLength(200)
    for (const line of lines) expect(line).toMatch(UUID_RE)
    expect(new Set(lines).size).toBe(200)
  })
})

describe('形状选项', () => {
  it('大写只动字母，不动连字符的位置', () => {
    expect(uuidList(1, true, true, RAMP)).toBe('00010203-0405-4607-8809-0A0B0C0D0E0F')
  })

  it('去掉连字符就是 32 个十六进制位', () => {
    expect(uuidList(1, false, false, RAMP)).toBe('000102030405460788090a0b0c0d0e0f')
    expect(uuidList(1, true, false, RAMP)).toBe('000102030405460788090A0B0C0D0E0F')
  })

  it('formatUuid 只管形状，⛔ 不管版本位', () => {
    // ⚠️ 这一条是「为什么分成两层」的验收：喂进去的字节是**没设过位的**，
    // 出来也就没有那个 `4`。设位是 `uuidList` 的事，混进 formatUuid 的话
    // 「大写对不对」这条用例就没法独立失败了
    const raw = new Uint8Array(UUID_BYTES)
    expect(formatUuid(raw, false, true)).toBe('00000000-0000-0000-0000-000000000000')
    expect(formatUuid(raw, false, false)).toBe('00000000000000000000000000000000')
  })
})

describe('批量', () => {
  it('N 个就是 N 行，行间是 \\n 而末尾没有多余的换行', () => {
    const text = uuidList(3, false, true)
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    expect(text.endsWith('\n')).toBe(false)
    for (const line of lines) expect(line).toMatch(UUID_RE)
  })

  it('1 个就是一行，⛔ 不带换行——「插回编辑器」插的是这一格里的原文', () => {
    expect(uuidList(1, false, true)).toMatch(UUID_RE)
    expect(uuidList(1, false, true).includes('\n')).toBe(false)
  })

  it('🔴 整批只找随机源要一次，要的是 16 × N 个字节', () => {
    // `getRandomValues` 一次最多收 65536 字节。分成 N 次调用虽然也能跑，
    // 但「一次填完」是描述符那个 `max` 敢设到 1000 的前提（见 `uuid.ts` 的模块文档），
    // 而这件事只有数调用次数才钉得住
    const sizes: number[] = []
    const spy: ByteSource = (bytes) => {
      sizes.push(bytes.length)
      platformBytes(bytes)
    }
    expect(uuidList(7, false, true, spy).split('\n')).toHaveLength(7)
    expect(sizes).toEqual([7 * UUID_BYTES])
  })
})

describe('平台随机源', () => {
  it('platformBytes 真的填了东西，而且收多大的缓冲区就填多大', () => {
    const bytes = new Uint8Array(64)
    platformBytes(bytes)
    // ⚠️ 「不全为 0」是一个概率断言：64 个字节全 0 的概率是 2^-512。
    // 它钉的是「这个函数没写成一个空壳」，不是熵的质量
    expect(bytes.some((byte) => byte !== 0)).toBe(true)
  })

  it('不传随机源时用的就是平台那一个', () => {
    expect(uuidList(1, false, true)).toMatch(UUID_RE)
  })
})
