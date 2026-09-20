/**
 * 字节 ↔ base64 的两个原语。
 *
 * 🔴 **为什么单独一个文件**：它有两个互不相干的调用方——`ipc/asset.ts`（图片落地要走
 * invoke，载荷是 base64 而不是数字数组）与 `tools/codec.ts`（「Base64 编解码」那一个工具）。
 * 原来它住在 `ipc/asset.ts` 里，M3-B-3 要复用时只有两条路：让 `tools/codec.ts` 去 import
 * 一个 Tauri 命令封装（依赖方向反了，而且会把 `@tauri-apps/api/core` 拖进一个本该能在
 * jsdom 里空手跑完的纯文字模块），或者把六行抄一遍。⛔ 两条都不选，搬上来。
 *
 * ## 🔴 `btoa` / `atob` 吃的是 **Latin-1 字符串**，不是 UTF-8
 *
 * `btoa('中文')` 直接 `InvalidCharacterError`：`btoa` 要求每个码元都 < 256。所以「文字 →
 * base64」永远是两步：先 `TextEncoder` 编成 UTF-8 字节，再把每个字节当成一个 Latin-1 码元
 * 交给 `btoa`。反过来解码也是两步。中间那一步用的是 `fromCharCode` / `charCodeAt` 的
 * **码元**语义，⛔ 不涉及任何文本编码——0x89 进去就该是 U+0089 出来。弄错的样子是高位字节
 * 被替换成问号：Rust 那侧解出一张坏图却报「不是认得的图片格式」，一句完全指不到真问题的话。
 *
 * ## 🔴 `bytesToBase64` 必须**分块**调 `String.fromCharCode`
 *
 * `String.fromCharCode(...bytes)` 是把整个数组摊成实参列表。实参个数有上限（V8 与 JSC
 * 都在十几万这个量级），超了就 `RangeError: Maximum call stack size exceeded`。
 * 一张稍微大点的截图就够撞上去，而**失败方式是抛异常**——粘贴什么都没发生，
 * 用户只看到光标闪了一下。分块的大小取 `0x8000`，比两家引擎的下限都低一个数量级。
 */

/** 一次摊给 `String.fromCharCode` 的实参个数上限。理由见模块文档 */
const B64_CHUNK = 0x8000

/** 字节 → 标准 base64（带 padding，⛔ 不含 URL-safe 字母表与换行） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK))
  }
  return btoa(binary)
}

/**
 * `atob` 出来的那个 Latin-1 字符串 → 字节。
 *
 * ⚠️ 这里**不需要**分块：写入是一个一个下标赋值的，没有摊实参那一步。
 * 读的时候 `charCodeAt` 也只返回一个数
 */
export function base64ToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
