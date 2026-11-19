import type { Ref } from 'vue';

/**
 * 个股标签服务（宿主视角的结构契约）
 *
 * 由盯盘插件 dsh-sidebar-watch 经 `ctx.provide('watch:tags', …)` 提供（真身是
 * 插件 settings 的 `widgetStockColors` 映射），宿主自选股页经
 * `pluginKernel.services.consumeAs('watch:tags')` **按结构取用**——
 * 插件未安装 / 停用时取到 undefined，标签功能整体缺席（数据保留在插件侧）。
 * `colors` 是插件侧创建的响应式 ref（构建时 vue 外部化到宿主运行时桥，同一
 * Vue 实例），因此自选股页圆点与任务栏小组件气泡圆点天然双向实时同步。
 */
export interface StockTagsServiceView {
  /** symbol → 色名（键为 sh600519 完整符号；未设置过的票无键） */
  colors: Readonly<Ref<Readonly<Record<string, string>>>>;
  /**
   * 设置单只票的标签色（非法色名 / 空符号 / 同值由插件侧忽略）
   * @param symbol 完整符号（sh600519 形态）
   * @param color 目标色名（如 white / red / blue…，全集见 watch-widget 常量）
   */
  setColor(symbol: string, color: string): void;
}
