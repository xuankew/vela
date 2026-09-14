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

export type WriteError =
  | { kind: 'io'; reason: string; message: string }
  | { kind: 'no_parent'; path: string }

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

export function openFile(path: string): Promise<TextFile> {
  return invoke<TextFile>('open_file', { path })
}

export function saveFile(path: string, text: string, format: FileFormat): Promise<WriteReport> {
  return invoke<WriteReport>('save_file', { path, text, format })
}
