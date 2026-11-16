import {
  LIMIT_RATIO_BSE,
  LIMIT_RATIO_GEM_STAR,
  LIMIT_RATIO_MAIN_BOARD,
} from '../constants/limit-mark.constants.ts';

/**
 * 按标的符号取日 K 涨跌停幅度
 *
 * 板块口径：创业板（sz30x）/ 科创板（sh68x）20%、北交所（bj）30%、沪深主板 10%；
 * 指数（sh000 / sz399）、基金 ETF（sh51/56/58、sz15/16/18）、港美股无涨跌停板 → 0。
 * ST 股主板幅度应为 5%，但 K 线序列里没有股票名称，此处按主板 10% 处理
 * （漏判 ST 涨跌停，不会误判——5% 的涨跌停在 10% 判据下不会被标记）。
 *
 * @param symbol 完整符号（sh600519 / sz300750 / bj832000 / hk00700 形态）
 * @returns 涨跌停幅度小数（0.1 / 0.2 / 0.3；无涨跌停限制返回 0）
 */
export const getDailyLimitRatio = (symbol?: string | null): number => {
  if (!symbol) return 0;
  const s = symbol.toLowerCase();
  // 港美股无涨跌停限制
  if (s.startsWith('hk') || s.startsWith('us')) return 0;
  // 指数与场内基金无个股式涨跌停标记意义
  if (/^sh(000|51|56|58)/.test(s) || /^sz(39|15|16|18)/.test(s)) return 0;
  // 创业板 / 科创板 20%
  if (/^sh68/.test(s) || /^sz30/.test(s)) return LIMIT_RATIO_GEM_STAR;
  // 北交所 30%
  if (s.startsWith('bj')) return LIMIT_RATIO_BSE;
  // 其余沪深证券（主板个股 / B 股）按 10%
  if (/^(sh|sz)/.test(s)) return LIMIT_RATIO_MAIN_BOARD;
  return 0;
};
