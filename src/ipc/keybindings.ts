/**
 * `vela-core::keybindings` 的前端镜像 + Tauri command 封装（M4-E）。
 *
 * 与 `./settings.ts` 同一套规矩：类型手写，没有代码生成。
 * 用户自定义快捷键配置存在 `~/.vela/keybindings.json`。
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * 用户自定义的快捷键映射：命令 ID → 快捷键串或数组。
 *
 * 这是 load/save 的原样形状，不做任何校验。校验归前端 store 管
 * （解析失败就跳过那条，用内置默认）。
 */
export type UserKeybindings = Record<string, string | string[]>

/**
 * 加载结果。与 settings 同一条理由：文件不存在不算错，当成「没有自定义配置」。
 */
export interface LoadedKeybindings {
  /** 合并后的用户配置；读失败时是空对象 */
  keybindings: UserKeybindings
}

/**
 * 从 Rust 侧读取 `~/.vela/keybindings.json`。
 *
 * 不传路径——位置由 Rust 侧从 `home_dir()` 算出，与 settings 一致。
 * 任何一层坏掉都退化成空配置并记进日志，不拦启动。
 */
export async function loadKeybindings(): Promise<LoadedKeybindings> {
  try {
    const raw = await invoke<LoadedKeybindings>('load_keybindings')
    return raw
  } catch (err) {
    console.warn('[keybindings] 加载失败:', err)
    return { keybindings: {} }
  }
}

/**
 * 把用户自定义配置写穿到 `~/.vela/keybindings.json`。
 *
 * 原子写（先写 `.tmp` 再 rename），与 settings 同一套做法。
 */
export async function saveKeybindings(keybindings: UserKeybindings): Promise<void> {
  try {
    await invoke('save_keybindings', { keybindings })
  } catch (err) {
    console.error('[keybindings] 保存失败:', err)
    throw err
  }
}
