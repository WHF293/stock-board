/**
 * 「今天题材」tab（原「市场热点」，2026-11-17 更名；今天炒什么页共享常量）
 */

/**
 * 热点二级页 iframe 的暗色模式滤镜（父页面挂到 iframe 元素上的 CSS filter）
 *
 * 上游 hot_concept 页有原生暗色主题（html 上的 light/dark 类切换），但主题
 * 唯一入口是 UA 里的 `hxtheme1` 标记（同花顺 App webview 注入，实测逆向其
 * checkDarkModeFunc 确认），跨域 iframe 无法改 UA / contentDocument，
 * 也无 URL 参数或 postMessage 入口；上游接口无 CORS 头，同源镜像方案在
 * Tauri 端（无 vite 中间件）不可行 —— 故沿用期货产业链面板（FuturesChainPanel）
 * 的经典反色方案：invert(1) 整体反色 + hue-rotate(180deg) 抵消色相翻转
 * （涨红跌绿等彩色还原），再压一点对比度和亮度减少刺眼。亮色模式传 'none'。
 */
export const HOT_CONCEPT_DARK_FILTER =
  'invert(1) hue-rotate(180deg) contrast(0.92) brightness(0.96)';
