import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// 刻意独立于 vite.config.ts：那份配置是为 WKWebView 的产物分包调过的（assetsInlineLimit、
// 不做 manualChunks），跟单测无关；混在一起改一处就可能碰坏另一处。
// 唯一必须两边都有的是 solid 插件——没有它 .tsx 里的 JSX 会被按 React 语义编译。
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
