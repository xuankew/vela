import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// Tauri 期望固定端口，且失败时不要自动换端口
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 不要让前端 dev server 监听 Rust 侧改动
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // Tauri 支持的最低 webview 版本；macOS 13+ 的 WKWebView 足够新
    target: 'safari16',
    // vite 8 起 esbuild 不再是内置依赖，minify:'esbuild' 会抛 ERR_MODULE_NOT_FOUND。
    // 用 rolldown 自带的 oxc minifier，无需额外安装。
    minify: 'oxc',
    sourcemap: true,
    reportCompressedSize: true,
    // woff2 一律不内联。
    //
    // 默认 4096 字节阈值下，GB 变体有 2 个小分片被转成 base64 data URI。
    // 这看着无害，实际击穿了 unicode-range 懒加载：data URI 的字节已经随 CSS chunk
    // 下载了，浏览器没法因为「页面上没这些码点」而跳过——分片架构的前提就是不请求。
    // 而且哪些分片低于阈值取决于字体包的切分方式，包一升级就会悄悄变化。
    // 返回 undefined 让其余资源走默认逻辑。
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
    // 刻意不做手动 manualChunks。
    //
    // 试过把 @codemirror/@lezer 归入单一 chunk，结果 gzip 从百来 KB 涨到 540KB：
    // `@codemirror/language-data` 靠动态 import 实现子语言懒加载，一旦被 id.includes
    // 这类粗匹配强制合并进静态 chunk，legacy-modes 里几十种语言会全部进首屏包。
    // 让 rolldown 自动分包才能保住这些动态边界。M1 接 30+ 语言时这一点是硬约束。
  },
})
