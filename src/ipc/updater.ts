/**
 * 自动更新检查器（M6）
 *
 * 通过 Tauri updater 插件检查新版本，流程：
 * 1. App 启动后静默检查一次
 * 2. 用户可手动触发检查
 * 3. 发现新版本时显示更新对话框
 *
 * ⚠️ 当前实现使用占位 API，实际集成需要等 Tauri updater 在前端的绑定完成
 */

// 🔴 占位导入：需要运行 `pnpm add @tauri-apps/plugin-updater @tauri-apps/plugin-process`
// import { check } from '@tauri-apps/plugin-updater'
// import { relaunch } from '@tauri-apps/plugin-process'

export interface UpdateInfo {
  version: string
  date?: string
  body?: string
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  info?: UpdateInfo
  error?: string
}

/**
 * 检查更新
 *
 * @returns 更新检查结果
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  // 🔴 占位实现：等待前端插件安装
  console.warn('[updater] 自动更新尚未启用：需要安装 @tauri-apps/plugin-updater')
  return {
    hasUpdate: false,
    error: 'Updater plugin not installed',
  }
}

/**
 * 下载并安装更新
 *
 * @param progressCallback 可选的进度回调
 * @returns 是否需要重启
 */
export async function installUpdate(
  _progressCallback?: (_progress: number) => void
): Promise<boolean> {
  // 🔴 占位实现
  console.warn('[updater] installUpdate 尚未实现')
  return false
}

/**
 * 下载、安装并重启
 */
export async function downloadInstallAndRelaunch(): Promise<void> {
  // 🔴 占位实现
  console.warn('[updater] downloadInstallAndRelaunch 尚未实现')
}
