/**
 * JSON 可视化渲染器。把 JSON 对象渲染成可交互的 HTML 树。
 *
 * ## 设计原则
 *
 * - **纯函数**：输入 JSON + 配置，输出 HTML 字符串
 * - **安全**：所有文本内容都经过转义，防止 XSS
 * - **可折叠**：每个对象/数组节点都有展开/收起按钮
 * - **主题化**：通过 CSS 变量支持配色切换
 */

export interface JsonRenderOptions {
  /** 最大展开层级，默认 Infinity */
  maxDepth?: number
  /** 是否默认展开所有节点，默认 false */
  defaultExpanded?: boolean
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * 根据值的类型返回 CSS 类名
 */
function valueClass(value: unknown): string {
  if (value === null) return 'json-null'
  if (typeof value === 'boolean') return 'json-boolean'
  if (typeof value === 'number') return 'json-number'
  if (typeof value === 'string') return 'json-string'
  return 'json-value'
}

/**
 * 格式化值的显示文本
 */
function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value.toString()
  if (typeof value === 'number') return value.toString()
  if (typeof value === 'string') return `"${escapeHtml(value)}"`
  return String(value)
}

/**
 * 递归渲染 JSON 值为 HTML
 */
function renderValue(
  value: unknown,
  key: string | null,
  depth: number,
  options: Required<JsonRenderOptions>,
  path: string[],
): string {
  const indent = '  '.repeat(depth)
  const isExpandable = (typeof value === 'object' && value !== null) || Array.isArray(value)
  const shouldExpand = options.defaultExpanded || depth < options.maxDepth

  // 渲染键名（如果有）
  const keyHtml = key !== null ? `<span class="json-key">"${escapeHtml(key)}"</span>: ` : ''

  if (!isExpandable) {
    // 基本类型值
    return `${indent}${keyHtml}<span class="${valueClass(value)}">${formatValue(value)}</span>`
  }

  // 可折叠的节点（对象或数组）
  const isArray = Array.isArray(value)
  const size = isArray ? value.length : Object.keys(value as Record<string, unknown>).length
  const nodeId = `json-node-${path.join('-')}`
  const toggleId = `json-toggle-${path.join('-')}`

  let html = `${indent}${keyHtml}`
  html += `<button class="json-toggle" id="${toggleId}" data-target="${nodeId}" aria-expanded="${shouldExpand}">`
  html += shouldExpand ? '▾' : '▸'
  html += '</button>'

  if (isArray) {
    html += `<span class="json-bracket">[</span>`
    html += `<span class="json-size">(${size} items)</span>`
  } else {
    html += `<span class="json-bracket">{</span>`
    html += `<span class="json-size">(${size} keys)</span>`
  }

  // 子节点容器
  html += `<div class="json-children" id="${nodeId}" style="display: ${shouldExpand ? 'block' : 'none'}">`

  if (isArray) {
    // 数组元素
    for (let i = 0; i < value.length; i++) {
      html += renderValue(value[i], null, depth + 1, options, [...path, String(i)])
      if (i < value.length - 1) html += ','
      html += '\n'
    }
  } else {
    // 对象属性
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!
      html += renderValue(obj[k], k, depth + 1, options, [...path, k])
      if (i < keys.length - 1) html += ','
      html += '\n'
    }
  }

  html += `${indent}</div>`

  if (isArray) {
    html += `${indent}<span class="json-bracket">]</span>`
  } else {
    html += `${indent}<span class="json-bracket">}</span>`
  }

  return html
}

/**
 * 将 JSON 值渲染为 HTML 字符串
 */
export function renderJson(value: unknown, options: JsonRenderOptions = {}): string {
  const opts: Required<JsonRenderOptions> = {
    maxDepth: options.maxDepth ?? Infinity,
    defaultExpanded: options.defaultExpanded ?? false,
  }

  const html = renderValue(value, null, 0, opts, [])

  return `<div class="json-tree">${html}</div>`
}

/**
 * 生成内联脚本，处理展开/收起交互
 */
export function jsonTreeScript(): string {
  return `
    document.addEventListener('click', function(e) {
      const target = e.target;
      if (target.classList.contains('json-toggle')) {
        const nodeId = target.getAttribute('data-target');
        const node = document.getElementById(nodeId);
        if (node) {
          const isExpanded = target.getAttribute('aria-expanded') === 'true';
          target.setAttribute('aria-expanded', String(!isExpanded));
          target.textContent = isExpanded ? '▸' : '▾';
          node.style.display = isExpanded ? 'none' : 'block';
        }
      }
    });
  `
}
