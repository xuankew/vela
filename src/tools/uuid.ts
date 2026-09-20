/**
 * UUID v4（M3-B-4）。
 *
 * ## 🔴 为什么不用 `crypto.randomUUID()`
 *
 * 它是**安全上下文专属**的（MDN 上那一格写着 "available only in secure contexts"），
 * 而 Vela 的前端跑在 `tauri://localhost` 这个自定义协议下——它算不算 secure context
 * 是 WebKit 的决定，⛔ 我在这里量不出来（jsdom 里 `isSecureContext` 干脆是 `undefined`，
 * 而 `randomUUID` 存在，所以测试环境会给一个假的安心）。
 * `crypto.getRandomValues` **不受这个限制**，而 v4 本身只是「16 个随机字节 + 改两位」，
 * 于是手搓十行换一个不依赖未验证前提的实现，这笔账是划算的。
 * ⚠️ 真机上要不要退回 `randomUUID` 见 PLAN §3.5「M3-B-4 实施修正」那条真机清单。
 *
 * ## ⚠️ 随机源是注入的，不是为了「好测」这么笼统
 *
 * `uuidList` 的确切输出**只有**在随机源固定时才写得出来，而这一份要钉的是
 * 「版本位与变体位真的被设上了」——那条断言长成 `ffffffff-ffff-4fff-bfff-ffffffffffff`
 * 这样，靠真随机是永远等不到的。
 *
 * ## ⚠️ v4 只有 v4
 *
 * ULID / NanoID / v7（时间有序，数据库主键那类场景真正想要的）都**没做**：
 * v7 要自己拼 48 位毫秒时间戳，而 ULID 要 Crockford base32 与自己的单调性保证，
 * 两者都不是「十行」的量级。§2 那张 P0 表里写的是「UUID / ULID / NanoID」，
 * 这里只兑现了第一个，⛔ 记账时不要写成整行都交付了
 */

/**
 * 填一批随机字节。
 *
 * ⚠️ 收的是**调用方分配好的**缓冲区而不是返回一个新的：批量生成时只分配一次
 * （1000 个 UUID = 16000 字节），也免得随机源与分配策略缠在一起
 */
export type ByteSource = (bytes: Uint8Array) => void

/** 一个 UUID 的字节数。⚠️ 16 字节 = 128 位，其中 6 位被版本与变体占掉 */
export const UUID_BYTES = 16

/** 平台上那一个随机源 */
export function platformBytes(bytes: Uint8Array): void {
  crypto.getRandomValues(bytes)
}

/**
 * 16 个字节 → 展示串。
 *
 * ⚠️ 这一层**只管形状**（连字符、大小写），⛔ 不管版本位——设位是 `uuidList` 的事。
 * 分成两层是为了让「`ffffffff-ffff-4fff-bfff-…` 那两位到底对不对」与
 * 「大写与去连字符对不对」各有一条能单独失败的用例
 */
export function formatUuid(bytes: Uint8Array, uppercase: boolean, hyphens: boolean): string {
  let plain = ''
  for (let i = 0; i < bytes.length; i++) plain += (bytes[i] ?? 0).toString(16).padStart(2, '0')
  if (!hyphens) return uppercase ? plain.toUpperCase() : plain
  const body = `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`
  return uppercase ? body.toUpperCase() : body
}

/**
 * 生成 `count` 个 v4，一行一个。
 *
 * 🔴 版本位与变体位是**掩掉原有高位再或上去**的，不是直接赋 `0x40` / `0x80`：
 * 第 7 字节的高四位是版本（`0100` = v4），低四位仍是随机的；
 * 第 9 字节的高两位是变体（`10` = RFC 4122），低六位仍是随机的。
 * 直接赋值会把 6 位随机性扔掉，而 UUID 的全部价值就在那 122 位随机性上
 *
 * 🔴 一次 `random(bytes)` 填完整批，而 `getRandomValues` 一次最多收 **65536** 个字节
 * （超了抛 `QuotaExceededError`）。所以 `count` 有个上限，而那个上限写在描述符的 `max` 上
 * （`builtin.ts`），⛔ 不在这里分块填——一条永远走不到的分块分支比一个上限更难维护。
 * 那条 `max` 与 65536 之间的关系由 `builtin.test.ts` 钉住，改一处忘一处会在那里炸
 */
export function uuidList(
  count: number,
  uppercase: boolean,
  hyphens: boolean,
  random: ByteSource = platformBytes,
): string {
  const bytes = new Uint8Array(UUID_BYTES * count)
  random(bytes)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const one = bytes.subarray(i * UUID_BYTES, (i + 1) * UUID_BYTES)
    one[6] = (one[6]! & 0x0f) | 0x40
    one[8] = (one[8]! & 0x3f) | 0x80
    out.push(formatUuid(one, uppercase, hyphens))
  }
  return out.join('\n')
}
