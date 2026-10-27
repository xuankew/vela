import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// 刻意独立于 vite.config.ts：那份配置是为 WKWebView 的产物分包调过的（assetsInlineLimit、
// 不做 manualChunks），跟单测无关；混在一起改一处就可能碰坏另一处。
// 唯一必须两边都有的是 solid 插件——没有它 .tsx 里的 JSX 会被按 React 语义编译。
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'node',
    /**
     * 默认 `css: false` 会把**所有** CSS 请求（含 `?raw`）桩成空串，于是 `styles.css?raw`
     * 读到的是 `''`——`TabStrip.test.tsx` 那条钉 `.editor-host { z-index: 0 }` 的哨兵会
     * 变成一条恒红的测试。这里把 `styles.css` 放进来让它真被处理。
     * ⚠️ 正则不能带 `$`：id 是 `styles.css?raw`，带尾锚点就匹配不上、桩照旧生效。
     * 影响面只有那一条哨兵——`styles.css` 在测试模块图里唯一的常规导入方是 `index.tsx`，
     * 而测试一律直接挂 `App.tsx`，不经过它。
     */
    css: { include: [/styles\.css/] },
    // 补丁自己用 `typeof Range` 守卫，所以跑在 node 环境的测试文件上也不会炸
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
