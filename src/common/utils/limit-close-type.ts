import type { KLineData } from 'klinecharts';
import {
  LIMIT_PRICE_EQUAL_EPSILON,
  LIMIT_PRICE_ROUND_TOLERANCE,
} from '../constants/limit-mark.constants.ts';

/**
 * 判定一根日 K 的收盘是否钉死在涨跌停价
 *
 * 两条必要条件组合判定（前复权序列同样适用——涨跌幅按比例缩放不变）：
 * 1. 形态：涨停收盘必然收在全天最高（封板价即当日最高可成交价），跌停收在全天最低；
 *    复权系数对同 bar 内各价一致，原始序列的 close == high / close == low
 *    在复权后仍是严格相等（留浮点容差）。
 * 2. 幅度：实际涨跌幅落在 [ratio - 容差, ratio + 容差] 内，容差来自
 *    涨停价四舍五入到分的半宽（0.005 / 昨收）。
 *
 * 已知误差源（均为「漏判」方向，不会把普通上涨误标成涨停）：
 * - ST 股 5% 板按主板 10% 判据会漏判（调用方未提供股票名称）；
 * - 除权除息日当天，昨收在前复权序列里经过缩放，幅度判据失真，可能漏判。
 *
 * @param bar 单根 K 线（close / high / low）
 * @param prevClose 前一根收盘价（即判定基准昨收；首根无前收传 NaN）
 * @param ratio 涨跌停幅度小数（getDailyLimitRatio；0 表示无涨跌停限制）
 * @returns 'up' 涨停 / 'down' 跌停 / null 非涨跌停收盘
 */
export const limitCloseType = (
  bar: Pick<KLineData, 'close' | 'high' | 'low'>,
  prevClose: number,
  ratio: number,
): 'up' | 'down' | null => {
  if (!(ratio > 0) || !(prevClose > 0)) return null;
  const epsilon = LIMIT_PRICE_EQUAL_EPSILON * Math.max(1, bar.close);
  const atHigh = bar.high - bar.close <= epsilon;
  const atLow = bar.close - bar.low <= epsilon;
  if (!atHigh && !atLow) return null;
  const pct = bar.close / prevClose - 1;
  const tolerance = LIMIT_PRICE_ROUND_TOLERANCE / prevClose;
  // 幅度必须落在 [ratio ± 容差] 内：真涨跌停价是四舍五入后的唯一价格，
  // 涨跌幅不可能明显偏离比例（远超/远低于 ratio 的只有无涨跌幅限制阶段的数据）
  if (atHigh && pct >= ratio - tolerance && pct <= ratio + tolerance) return 'up';
  if (atLow && pct <= -(ratio - tolerance) && pct >= -(ratio + tolerance)) return 'down';
  return null;
};
