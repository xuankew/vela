import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from './base64'

/**
 * 0…255 全部 256 个字节值。
 *
 * ⚠️ 刻意不用「一张真 PNG」当样本（那一份留在 `ipc/asset.test.ts`，它钉的是图片落地那条
 * 契约）。这里要钉的是「任何字节都不会被搞坏」，而覆盖全部 256 个值比覆盖 PNG 头那四个
 * 更强：`btoa` 的红线是码元 < 256，所以**每一个**高位字节都是一次踩线的机会
 */
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)

describe('bytesToBase64', () => {
  it('空输入编成空字符串', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })

  it('ASCII 与二进制字节都能原样往返', () => {
    for (const bytes of [Uint8Array.from([0]), Uint8Array.from([255, 0, 128]), ALL_BYTES]) {
      const decoded = base64ToBytes(atob(bytesToBase64(bytes)))
      expect(decoded).toEqual(bytes)
    }
  })

  it('🔴 高位字节不会被当成字符编码搞坏', () => {
    // `btoa` 的入参是**Latin-1 字符串**，不是 UTF-8。这里钉的是「字节 → 字符」这一步
    // 用的是 fromCharCode 的**码元**语义而不是任何文本编码：0x89 进去就该是 U+0089 出来。
    // 弄错的样子是 PNG 头那几个高位字节被替换成问号，Rust 侧解出来是一张坏图，
    // 而报的错是「不是认得的图片格式」——一句完全指不到真问题的话
    expect(bytesToBase64(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe('iVBORw==')
  })

  it('标准 base64 带 padding，正是 Rust 侧 STANDARD 引擎认的那种', () => {
    expect(bytesToBase64(Uint8Array.from([1]))).toBe('AQ==')
    expect(bytesToBase64(Uint8Array.from([1, 2]))).toBe('AQI=')
    expect(bytesToBase64(Uint8Array.from([1, 2, 3]))).toBe('AQID')
    // ⛔ 不含 URL-safe 字母表与换行：Rust 那侧刻意只认一种写法
    const b64 = bytesToBase64(ALL_BYTES)
    expect(b64).not.toContain('-')
    expect(b64).not.toContain('_')
    expect(b64).not.toContain('\n')
  })

  it('🔴 大于一块的数据也编得对——这一条钉的是「分块」本身', () => {
    // 500 000 字节，远超 `String.fromCharCode(...bytes)` 一次能吃的实参个数
    // （V8 实测在 10 万与 13 万之间就炸，JSC 更低）。
    // 不分块的失败方式是 **RangeError: Maximum call stack size exceeded**，
    // 也就是说粘贴什么都没发生，用户只看到光标闪了一下
    const big = new Uint8Array(500_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) % 256
    expect(() => String.fromCharCode(...big)).toThrow(RangeError)

    const decoded = base64ToBytes(atob(bytesToBase64(big)))
    expect(decoded.length).toBe(big.length)
    for (let i = 0; i < big.length; i += 9973) expect(decoded[i]).toBe(big[i])
    expect(decoded[big.length - 1]).toBe(big[big.length - 1])
  })
})

describe('base64ToBytes', () => {
  it('空字符串解成空数组', () => {
    expect(base64ToBytes('')).toEqual(new Uint8Array(0))
  })

  it('逐字节取的是**码元**，所以高位字节原样落地', () => {
    expect(base64ToBytes(atob('iVBORw=='))).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))
    expect(base64ToBytes(atob('//8='))).toEqual(Uint8Array.from([255, 255]))
  })

  it('长度与那个 Latin-1 字符串的长度严格相等——不猜、不裁、不补', () => {
    // ⚠️ 这一条钉的是「一步不多」：`atob` 已经把空白吃掉、把 padding 算完了，
    // 这里再动长度就等于第二次解码。真出错的后果是 Rust 侧收到一个短了一截的 PNG，
    // 而报的错还是那句指不到真问题的「不是认得的图片格式」
    for (const b64 of ['', 'AA==', 'AAA=', 'AAAA', bytesToBase64(ALL_BYTES)]) {
      expect(base64ToBytes(atob(b64)).length).toBe(atob(b64).length)
    }
  })

  it('🔴 大于一块的数据也解得对——反方向没有摊实参，但同样要逐字节对得上', () => {
    const big = new Uint8Array(500_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 11 + 5) % 256
    const decoded = base64ToBytes(atob(bytesToBase64(big)))
    expect(decoded.length).toBe(big.length)
    for (let i = 0; i < big.length; i += 9973) expect(decoded[i]).toBe(big[i])
  })
})
