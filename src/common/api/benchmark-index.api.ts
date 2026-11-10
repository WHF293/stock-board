import { fetchTencentRawDailyCloses } from './tencent-kline.api.ts';

/**
 * 基准指数累计涨跌幅序列（资产曲线对比用）
 *
 * 数据源：腾讯不复权日 K 收盘（fetchTencentRawDailyCloses，800 根 ≈ 3.2 年，
 * 覆盖账本「全部」区间绰绰有余）。会话级缓存收盘表，切换指数 / 区间不重复拉上游。
 */

/** 收盘表缓存（symbol → yyyy-MM-dd → 不复权收盘价；会话内复用） */
const closeCache = new Map<string, Map<string, number>>();

/**
 * 拉取指数在给定日期序列上的累计涨跌幅（%）
 *
 * 基准 = 序列中首个能取到收盘的交易日（该日涨跌幅为 0%）；账户序列中的
 * 非交易日 / 缺失日沿用最近一个交易日的收盘（曲线持平），与行情软件口径一致。
 * @param symbol 腾讯指数完整符号（sh000001 / sh000300 / sz399006 / sh000688）
 * @param dates 日期序列（yyyy-MM-dd，与账户净值曲线日期对齐）
 * @returns 逐日累计涨跌幅百分数（两位小数；序列长度与入参一致）
 * @throws 指数收盘表拉取失败（网络 / 上游异常，调用方降级为不画指数线）
 */
export const fetchBenchmarkIndexPct = async (symbol: string, dates: string[]): Promise<number[]> => {
  let closes = closeCache.get(symbol);
  if (!closes) {
    closes = await fetchTencentRawDailyCloses(symbol);
    closeCache.set(symbol, closes);
  }
  if (dates.length === 0) return [];
  // 排序后的交易日数组 + 二分找「不晚于 d 的最近收盘日」
  const tradingDays = [...closes.keys()].sort();
  const closeOnOrBefore = (d: string): number | null => {
    let lo = 0;
    let hi = tradingDays.length - 1;
    let hit: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tradingDays[mid] <= d) {
        hit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hit === null ? null : closes!.get(tradingDays[hit]) ?? null;
  };
  // 基准 = 序列内首个有收盘的交易日
  let base: number | null = null;
  const out: number[] = [];
  for (const d of dates) {
    const close = closeOnOrBefore(d);
    if (close === null) {
      out.push(0);
      continue;
    }
    if (base === null) base = close;
    out.push(Number((((close - base) / base) * 100).toFixed(2)));
  }
  return out;
};
