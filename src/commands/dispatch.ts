import type { CommandRegistry } from './registry'

/**
 * 把注册表接到全局键盘上。返回卸载函数。
 *
 * **必须用捕获阶段**：CM6 的 keymap 绑在自己的 content DOM 上，冒泡阶段的全局监听
 * 会在它之后才收到事件，于是同一个按键被两边各处理一次（例如 `Alt+Z` 既切了换行
 * 又往文档里插了个字符）。捕获阶段从 window 往下走，先于目标元素，能拦住。
 */
export function attachKeybindingDispatch(registry: CommandRegistry, target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const def = registry.findForKey(event)
    if (!def) return
    event.preventDefault()
    event.stopPropagation()
    // 命令里的异常不能让键盘监听整体失效，但也不能吞掉——吞掉的报错最难查
    void registry.execute(def.id).catch((err) => {
      console.error(`命令 ${def.id} 执行失败`, err)
    })
  }

  target.addEventListener('keydown', onKeyDown, true)
  return () => target.removeEventListener('keydown', onKeyDown, true)
}
