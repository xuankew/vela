/**
 * 字数统计插件（示例插件 #1：只读型）
 *
 * 验证点：
 * - vela.editor.getActive() + vela.editor.getText()
 * - vela.ui.showToast()
 * - vela.commands.register() 注册命令
 */

/** @param {import('../../src/bridge/types').VelaBridge} vela */
export function activate(vela) {
  // 注册命令
  vela.commands.register('wordCount.show', () => {
    const handle = vela.editor.getActive()
    if (!handle) {
      vela.ui.showToast('没有打开的文档', 'warn')
      return
    }

    const text = vela.editor.getText(handle)
    
    // 统计
    const chars = text.length
    const lines = text.split('\n').length
    // 中文词数近似：按空白分割后的非空段数
    const words = text.trim().split(/\s+/).filter(Boolean).length
    
    // 格式化显示
    const message = `字符: ${chars} | 行数: ${lines} | 词数: ${words}`
    vela.ui.showToast(message, 'info')
    
    console.log('[word-count]', message)
  }, {
    title: '显示字数统计',
    category: '工具',
  })
  
  console.log('[word-count] 插件已激活')
}

/** @param {import('../../src/bridge/types').VelaBridge} vela */
export function deactivate(vela) {
  console.log('[word-count] 插件已停用')
}
