export {}

declare global {
  interface Window {
    /** index.html 内联脚本记录的模块加载起点 */
    __VELA_T0?: number
    /**
     * index.html 内联脚本提供的启动心跳写入器。
     * 组件里的探针委托给它，全局只有一份事件数组，避免两处各写各的互相覆盖。
     */
    __velaBoot?: (stage: string, extra?: Record<string, unknown>) => void
  }
}
