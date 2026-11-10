/**
 * 资产曲线基准指数选项（腾讯不复权日 K 符号口径）
 *
 * 上游 queryPnlSummary.shIndexTrend 只有上证 / 沪深300 / 创业板指等场内指数、
 * 无科创板指数，且按行对齐账户序列不可靠——四个基准统一改走腾讯 K 线源
 * （web.ifzq.gtimg.cn，已在代理白名单内，不占投资账本 MCP 配额）。
 */

/** 基准指数选项（value = 腾讯完整符号） */
export const BENCHMARK_INDEX_OPTIONS = [
  { value: 'sh000001', label: '上证指数' },
  { value: 'sh000300', label: '沪深300' },
  { value: 'sz399006', label: '创业板指' },
  { value: 'sh000688', label: '科创50' },
] as const;

/** 基准指数符号类型 */
export type BenchmarkIndexSymbol = (typeof BENCHMARK_INDEX_OPTIONS)[number]['value'];

/** 默认选中指数（与指标行「对比沪深300」口径一致） */
export const BENCHMARK_INDEX_DEFAULT: BenchmarkIndexSymbol = 'sh000300';
