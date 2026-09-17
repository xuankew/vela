import globals from 'globals'
import solid from 'eslint-plugin-solid'
import tseslint from 'typescript-eslint'

// 用 typescript-eslint 而不是裸 ESLint + parser：`tseslint.config()` 会把 extends 数组
// 展平成 flat config 对象，省掉手写 plugins/languageOptions 的样板。
export default tseslint.config(
  { ignores: ['dist/', 'target/', 'src-tauri/target/', 'node_modules/'] },

  // 应用源码。选 recommendedTypeChecked 而不是 recommended，是为了拿到
  // `no-floating-promises` / `no-misused-promises`：这个应用满是 Tauri IPC 的
  // Promise，一个没 await 的 saveFile() 拒绝掉就是静默丢数据，tsc 看不见这类问题。
  // solid 插件补的也是 tsc 的盲区——`solid/reactivity` 抓「解构 props / 在
  // createEffect 外面读 signal」这种把响应性弄丢的写法，类型检查完全过得去。
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked, solid.configs['flat/typescript']],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 关掉，因为在本仓库它的误报率是 100%：24 处命中**全部**是「Promise 返回型签名的桩实现」
      // ——`promptDiscard: async () => 'cancel'`、`invoke.mockImplementation(async () => ({...}))`。
      // 这些位置上的 `async` 是类型强制要求的（接口要 Promise，去掉 async 就编译不过），
      // 而规则的前提是「写了 async 却忘了 await」。留着只会换来 24 条永久豁免，
      // 那比没有这条规则更糟：它教会所有人无视 lint 输出。
      '@typescript-eslint/require-await': 'off',

      // 关掉，因为它分不清「常量表」和「响应式数组」。本仓库三处真正的响应式列表
      // （`ws.tabs()` / `ws.panes()` / `props.names`）**已经全部用 `<For>`**；被点名的 6 处
      // `.map()` 迭代的是 FONT_VARIANTS / ENCODING_CHOICES / LINE_ENDING_IDS 这类模块级常量，
      // 回调里不读任何 signal，Solid 只会求值一次，换成 `<For>` 是白付一层 keyed 协调的开销。
      'solid/prefer-for': 'off',

      // `ignoreReadBeforeAssign`：本仓库有一处刻意的循环初始化写法——
      // `let doc!: DocumentModel` 紧接着被自己 host 的闭包引用（tab.ts / workspace.ts 的
      // `let tab: Tab` 同理，注释就写在现场）。变量在赋值前就被读到，规则却只数「赋值一次」
      // 于是报 prefer-const；照它改成 `const doc!: T` 是**语法错误**。开这个选项正好只放过这类，
      // `let r = lerp(...)` 那种真正的漏网 const 仍然会报。
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },

  // 构建脚本与配置文件。它们不在 tsconfig.json 的 include 里（那里只有 src/**），
  // 类型感知规则拿不到 program 会直接报错，所以显式关掉；环境也从浏览器换成 Node。
  {
    files: ['*.config.{ts,js,mjs}', 'scripts/**/*.{js,mjs}'],
    extends: [tseslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
)
