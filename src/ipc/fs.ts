/**
 * `vela-core::fs` 的前端镜像 + Tauri command 封装（PLAN.md §2.6）。
 *
 * ⚠️ **这里的类型是手写的，与 Rust 侧之间没有代码生成。** 漂移的失败方式极其难查：
 * 字段名大小写不对，`invoke` 只会给你一个 `undefined`，不报错。所以两边各有一份
 * 对照的黄金 JSON 快照，改任何一边都必须同时改另一边：
 *
 * - Rust：`crates/vela-core/tests/wire_contract.rs`
 * - 前端：`src/ipc/fs.test.ts`
 *
 * **命令的参数名同样在契约里**：Tauri 按名字去 invoke 的 payload 里取值，`openFile`
 * 少传或拼错 `encoding`，Rust 那边拿到的就是 `None`——「以 GBK 重新打开」会静默变成
 * 「再探测一次」，用户看到的还是同一屏乱码。
 *
 * 真要上代码生成（tauri-specta）是 M1-H 的事——那会引入一个 build 步骤和一层宏，
 * 眼下两个 command、五个类型的规模还不值当。
 */

import { invoke } from '@tauri-apps/api/core'

/** Rust `fs::Encoding`，`#[serde(rename_all = "snake_case")]` */
export type EncodingId = 'utf8' | 'utf16_le' | 'utf16_be' | 'gbk'

/** Rust `fs::LineEnding`，同上 */
export type LineEndingId = 'lf' | 'crlf'

/**
 * 还原原文件所需的全部格式信息。
 *
 * 前端把它当**不透明的一团数据**：打开时收下来，保存时原样传回去，不解释、不改写。
 * 这样「打开 → 不改一个字 → 保存」才能产出字节完全相同的文件。
 */
export interface FileFormat {
  encoding: EncodingId
  bom: boolean
  eol: LineEndingId
}

/** 编码的状态栏展示名。与 Rust 侧 `Encoding::label()` 保持一致 */
export const ENCODING_LABELS: Record<EncodingId, string> = {
  utf8: 'UTF-8',
  utf16_le: 'UTF-16 LE',
  utf16_be: 'UTF-16 BE',
  gbk: 'GBK',
}

export const LINE_ENDING_LABELS: Record<LineEndingId, string> = {
  lf: 'LF',
  crlf: 'CRLF',
}

export const ENCODING_IDS: EncodingId[] = ['utf8', 'utf16_le', 'utf16_be', 'gbk']

export const LINE_ENDING_IDS: LineEndingId[] = ['lf', 'crlf']

/** 下拉里的一项：编码 + 有没有 BOM + 给人看的名字 */
export interface EncodingChoice {
  encoding: EncodingId
  bom: boolean
  label: string
}

/**
 * 编码 + BOM 的**合法**组合，给状态栏的下拉用。
 *
 * 七个而不是八个：GBK 没有 BOM 这回事（Rust 侧 `Encoding::supports_bom`），
 * 写了也不会被任何工具认出来，`encode` 还会直接忽略它。UI 不提供不可能的组合，
 * 比提供了再在下游兜住要便宜。
 */
// 回调的返回类型必须显式标出来：ternary 两支的元素类型不同（一支只剩 "gbk" 字面量），
// flatMap 会把 U 推成其中一支，再跟这里的注解打起来（TS2322）
export const ENCODING_CHOICES: EncodingChoice[] = ENCODING_IDS.flatMap((encoding): EncodingChoice[] =>
  encoding === 'gbk'
    ? [{ encoding, bom: false, label: ENCODING_LABELS[encoding] }]
    : [
        { encoding, bom: false, label: ENCODING_LABELS[encoding] },
        { encoding, bom: true, label: `${ENCODING_LABELS[encoding]} BOM` },
      ],
)

const BOM_SUFFIX = '-bom'

/** `<select>` 的 value 只能是一个字符串，而编码与 BOM 是两个字段，于是压成一个 */
export function encodingChoiceId(choice: { encoding: EncodingId; bom: boolean }): string {
  return choice.bom ? `${choice.encoding}${BOM_SUFFIX}` : choice.encoding
}

export function parseEncodingChoice(id: string): { encoding: EncodingId; bom: boolean } {
  const bom = id.endsWith(BOM_SUFFIX)
  return { encoding: (bom ? id.slice(0, id.length - BOM_SUFFIX.length) : id) as EncodingId, bom }
}

/** Rust `fs::TextFile`，`#[serde(rename_all = "camelCase")]`（字段名本来就都是单词） */
export interface TextFile {
  /** 已归一化为 LF 的正文，可直接交给 CM6 */
  text: string
  format: FileFormat
  /** true = 解码时有字节无法映射，已用 U+FFFD 顶替。**原样保存会损坏这个文件** */
  lossy: boolean
  /** 原文件字节数。不能用 `text.length` 代替——那是归一化后的字符数 */
  bytes: number
}

/** Rust `fs::WriteReport` */
export interface WriteReport {
  bytesWritten: number
  /** true = 有字符在目标编码里不存在，已被写成 `&#20013;` 这类数字字符引用（即数据损坏） */
  unmappable: boolean
}

export type ReadError =
  | { kind: 'io'; reason: string; message: string }
  | { kind: 'directory'; path: string }
  | { kind: 'too_large'; bytes: number; limit: number }

export type WriteError = { kind: 'io'; reason: string; message: string } | { kind: 'no_parent'; path: string }

export type FsError = ReadError | WriteError

/** `invoke` 的 reject 值是 `unknown`：Tauri 把 Rust 的 `Err` 序列化后原样抛出 */
function isFsError(value: unknown): value is FsError {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

export function describeFsError(err: unknown): string {
  if (!isFsError(err)) return err instanceof Error ? err.message : String(err)
  switch (err.kind) {
    case 'too_large':
      return `文件 ${(err.bytes / 1048576).toFixed(1)} MB，超过单次传输上限 ${(err.limit / 1048576).toFixed(0)} MB（只读分片模式在 M2）`
    case 'directory':
      return `${err.path} 是目录，不是文件`
    case 'no_parent':
      return `${err.path} 没有目录部分，无法确定临时文件位置`
    case 'io':
      return err.message
    default:
      return String(err)
  }
}

/**
 * @param encoding 跳过探测、直接用这个编码解——状态栏的「以…重新打开」。
 *
 * ⚠️ 不覆写时也必须把 key 传过去（值为 `null`）。Tauri 对「参数整个缺失」与「参数是
 * null」的处理并不显然一致，而 `Option<Encoding>` 反序列化 `null` 恒为 `None`——
 * 传 null 就不用去赌前一种。契约钉在 `crates/vela-core/tests/wire_contract.rs`。
 */
export function openFile(path: string, encoding?: EncodingId): Promise<TextFile> {
  return invoke<TextFile>('open_file', { path, encoding: encoding ?? null })
}

export function saveFile(path: string, text: string, format: FileFormat): Promise<WriteReport> {
  return invoke<WriteReport>('save_file', { path, text, format })
}
