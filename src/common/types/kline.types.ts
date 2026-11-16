/**
 * 分时 / 个股资金流相关类型统一出口
 *
 * ⚠️ 2026-09-29 stock-sdk 淘汰第一轮：K 线 / 筹码 / 技术信号相关类型已随死代码
 * `api/kline.api.ts` 一并移除（SDK kline 域在宿主已无消费方）；保留的
 * `StockFundFlowDaily` 为 flow.api 消费。
 */
export type { StockFundFlowDaily } from 'stock-sdk';

import type { KLineData } from 'klinecharts';

/**
 * K 线数据源标识（详情页「数据来源」标注 / 兜底判定用）
 *
 * - `tencent`：腾讯 web.ifzq.gtimg.cn（A 股日周月 K 前复权、港股全周期）
 * - `sina`：新浪 quotes.sina.cn（分钟级；A 股日周月 K 的兜底源，不复权）
 */
export type KlineSourceId = 'tencent' | 'sina';

/**
 * K 线价格复权口径
 *
 * - `qfq`：前复权（腾讯 A 股有除权记录的标的 / 港股日周月 K）
 * - `none`：不复权（新浪源；腾讯对无复权序列的标的回落 `day` 键，价格即原始价）
 */
export type KlineAdjustMode = 'qfq' | 'none';

/**
 * 一次 K 线取数的结果：行情序列 + 口径元信息
 *
 * 序列与口径必须成对下发 —— 详情页要如实标注「哪来的数据、是否复权」，
 * 兜底到新浪时价格口径会从 qfq 变成不复权，混在一起会让人误读跨除权日的跌幅。
 */
export interface KlineSeries {
  /** klinecharts K 线序列（时间升序） */
  bars: KLineData[];
  /** 实际生效的数据源 */
  source: KlineSourceId;
  /** 实际生效的复权口径 */
  adjust: KlineAdjustMode;
  /** 是否为兜底源（主源失败后切换） */
  fallback: boolean;
}

/**
 * 分时固定时间轴的连续段
 */
export interface MinuteAxisRange {
  /** 该段首分钟的 HH:mm */
  start: string;
  /** 该段首分钟的连续分钟数（含首分钟） */
  count: number;
}

/**
 * 分时 X 轴固定刻度
 */
export interface MinuteAxisTick {
  /** 轴上的分钟时刻（HH:mm） */
  time: string;
  /** 刻度展示文案 */
  label: string;
}
