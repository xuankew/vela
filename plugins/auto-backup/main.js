/**
 * 自动备份插件（示例插件 #2：读写型）
 *
 * 验证点：
 * - vela.workspace.onFileChange() 监听文件改动
 * - vela.workspace.readFile() / vela.workspace.writeFile()
 * - vela.settings.load() / vela.settings.save() 持久化配置
 * - vela.ui.showToast()
 */

let enabled = true
let unsubscribeFileChange = null

/** @param {import('../../src/bridge/types').VelaBridge} vela */
export async function activate(vela) {
  // 从配置读取开关状态
  try {
    const roots = vela.workspace.getRoots()
    const settings = await vela.settings.load(roots)
    // 假设配置里有一个 autoBackup.enabled 键（实际应该在插件自己的命名空间）
    enabled = settings.merged.autoBackupEnabled !== false
  } catch (err) {
    console.warn('[auto-backup] 读取配置失败，使用默认值:', err)
  }
  
  if (enabled) {
    startWatching(vela)
  }
  
  // 注册切换命令
  vela.commands.register('autoBackup.toggle', () => {
    enabled = !enabled
    if (enabled) {
      startWatching(vela)
      vela.ui.showToast('自动备份已开启', 'info')
    } else {
      stopWatching()
      vela.ui.showToast('自动备份已关闭', 'warn')
    }
    
    // 保存配置
    saveConfig(vela, enabled)
  }, {
    title: '切换自动备份开关',
    category: '工具',
  })
  
  // 注册列出备份命令
  vela.commands.register('autoBackup.list', async () => {
    const backupDir = getBackupDir()
    try {
      // 注意：这里需要 listDir 支持绝对路径，或者用其他方式枚举
      vela.ui.showToast(`备份目录: ${backupDir}`, 'info')
    } catch (err) {
      vela.ui.showToast('无法列出备份文件', 'error')
    }
  }, {
    title: '列出备份文件',
    category: '工具',
  })
  
  console.log('[auto-backup] 插件已激活，当前状态:', enabled ? '开启' : '关闭')
}

/** @param {import('../../src/bridge/types').VelaBridge} vela */
function startWatching(vela) {
  if (unsubscribeFileChange) {
    unsubscribeFileChange()
  }
  
  unsubscribeFileChange = vela.workspace.onFileChange(async (path) => {
    // 过滤掉备份目录本身
    if (path.includes('.vela/backups')) return
    
    try {
      const text = await vela.workspace.readFile(path)
      const timestamp = Date.now()
      const fileName = path.split('/').pop() || 'unknown'
      const backupPath = `${getBackupDir()}/${timestamp}_${fileName}`
      
      await vela.workspace.writeFile(backupPath, text)
      console.log(`[auto-backup] 已备份: ${path} → ${backupPath}`)
    } catch (err) {
      console.error('[auto-backup] 备份失败:', path, err)
    }
  })
}

function stopWatching() {
  if (unsubscribeFileChange) {
    unsubscribeFileChange()
    unsubscribeFileChange = null
  }
}

/** @param {import('../../src/bridge/types').VelaBridge} vela */
async function saveConfig(vela, value) {
  try {
    const roots = vela.workspace.getRoots()
    const settings = await vela.settings.load(roots)
    await vela.settings.save({
      ...settings.merged,
      autoBackupEnabled: value,
    })
  } catch (err) {
    console.warn('[auto-backup] 保存配置失败:', err)
  }
}

function getBackupDir() {
  // 在实际实现中，这应该从配置读取或使用平台特定的路径
  return '~/.vela/backups'
}

/** @param {import('../../src/bridge/types').VelaBridge} vela */
export function deactivate(vela) {
  stopWatching()
  console.log('[auto-backup] 插件已停用')
}
