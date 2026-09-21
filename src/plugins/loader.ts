/**
 * 插件加载器（M5 插件接口收敛 - 懒激活机制原型）
 *
 * 这一层负责：
 * 1. 扫描 plugins/ 目录下的 manifest.json
 * 2. 根据 activationEvents 决定何时加载
 * 3. 动态 import() 插件入口并调用 activate/deactivate
 */

import type { VelaBridge } from '../bridge/types'

export interface PluginManifest {
  name: string
  displayName: string
  version: string
  description?: string
  author?: string
  minVelaVersion: string
  activationEvents: string[]
  contributes?: {
    commands?: Array<{
      id: string
      title: string
      category?: string
    }>
  }
}

export interface PluginInstance {
  manifest: PluginManifest
  activate: (vela: VelaBridge) => void | Promise<void>
  deactivate?: (vela: VelaBridge) => void | Promise<void>
}

const loadedPlugins = new Map<string, PluginInstance>()

/**
 * 加载单个插件
 */
export async function loadPlugin(
  pluginDir: string,
  vela: VelaBridge
): Promise<PluginInstance | null> {
  try {
    // 读取 manifest
    const manifestPath = `${pluginDir}/manifest.json`
    const manifestResp = await fetch(manifestPath)
    if (!manifestResp.ok) {
      console.warn(`[plugin-loader] 无法读取 ${manifestPath}`)
      return null
    }
    const manifest: PluginManifest = await manifestResp.json()
    
    // 版本检查
    if (!satisfiesMinVersion(vela.version, manifest.minVelaVersion)) {
      console.warn(
        `[plugin-loader] 插件 ${manifest.name} 要求 Vela >= ${manifest.minVelaVersion}，当前是 ${vela.version}`
      )
      return null
    }
    
    // 动态 import 插件入口
    const mainModule = await import(`${pluginDir}/main.js`)
    if (!mainModule.activate) {
      console.warn(`[plugin-loader] 插件 ${manifest.name} 没有导出 activate 函数`)
      return null
    }
    
    const instance: PluginInstance = {
      manifest,
      activate: mainModule.activate,
      deactivate: mainModule.deactivate,
    }
    
    loadedPlugins.set(manifest.name, instance)
    return instance
  } catch (err) {
    console.error(`[plugin-loader] 加载插件失败 ${pluginDir}:`, err)
    return null
  }
}

/**
 * 激活匹配的插件
 */
export async function activatePlugins(
  vela: VelaBridge,
  event: string
): Promise<void> {
  for (const [name, instance] of loadedPlugins) {
    if (instance.manifest.activationEvents.includes(event)) {
      try {
        await instance.activate(vela)
        console.log(`[plugin-loader] 已激活插件: ${name} (触发事件: ${event})`)
      } catch (err) {
        console.error(`[plugin-loader] 激活插件 ${name} 失败:`, err)
      }
    }
  }
}

/**
 * 停用所有已加载的插件
 */
export async function deactivateAllPlugins(vela: VelaBridge): Promise<void> {
  for (const [name, instance] of loadedPlugins) {
    try {
      if (instance.deactivate) {
        await instance.deactivate(vela)
      }
    } catch (err) {
      console.error(`[plugin-loader] 停用插件 ${name} 失败:`, err)
    }
  }
  loadedPlugins.clear()
}

/**
 * 简单的 semver 比较（只比较 major.minor.patch）
 */
function satisfiesMinVersion(current: string, min: string): boolean {
  const parse = (v: string) => v.split('.').map(Number)
  const parts = parse(current)
  const minParts = parse(min)
  
  const cMajor = parts[0] ?? 0
  const cMinor = parts[1] ?? 0
  const cPatch = parts[2] ?? 0
  const mMajor = minParts[0] ?? 0
  const mMinor = minParts[1] ?? 0
  const mPatch = minParts[2] ?? 0
  
  if (cMajor !== mMajor) return cMajor > mMajor
  if (cMinor !== mMinor) return cMinor > mMinor
  return cPatch >= mPatch
}
