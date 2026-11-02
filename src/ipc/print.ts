/**
 * 系统打印面板的前端这一半（M7-15，另一半在 `src-tauri/src/print.rs`）。
 *
 * 只有一条命令、一个载荷都没有：要打印的正文早已在主窗口的 DOM 里（见
 * `src/md/print.ts` 的 `mountPrintSnapshot`）。名字 `print_window` 是 Rust 与 TS
 * 手写共享的，改一边必须改另一边——和 `src/ipc/windowClose.ts` 的事件名同一类风险，
 * 只是这一处的失败方式是「按了导出 PDF 什么都没发生」，没有任何报错。
 */

import { invoke } from '@tauri-apps/api/core'

/** 叫出系统打印面板。macOS 上这就是「导出 PDF」的入口（面板里有「存储为 PDF」） */
export function printWindow(): Promise<void> {
  return invoke<void>('print_window')
}
