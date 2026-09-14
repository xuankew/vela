/**
 * jsdom 环境补丁。
 *
 * jsdom 没有布局引擎，`Range.prototype.getClientRects` 干脆就没实现。CM6 的选区图层在
 * measure 阶段会调它，于是每次 `view.focus()` 都往 stderr 打一整段 TypeError 栈。
 *
 * 测试本身是绿的（CM6 内部吞掉了异常），但**满屏噪音会让人不再去看 stderr**——而这个
 * 项目没有别的观察通道（浏览器导航被拦、screencapture 会挂、dev 构建没有 devtools），
 * stderr 是唯一还能自动抓到的信号，不能污染它。
 *
 * 返回空矩形列表，等价于「这个范围没有可见几何」，与 jsdom 里一切都是 0×0 的现实一致。
 * 注意这只是消音，不是能力：凡依赖真实坐标的行为（光标定位、滚动、字体度量、IME）
 * 在 jsdom 里仍然验不了，那部分只能靠 `pnpm tauri dev` 人工确认。
 */

if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  const empty: DOMRectList = { length: 0, item: () => null } as unknown as DOMRectList
  Range.prototype.getClientRects = () => empty
}
