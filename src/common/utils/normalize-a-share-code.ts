import { ETF_CODE_PREFIXES } from '../constants/etf.constants.ts';

/**
 * A 股 6 位纯代码归一化为完整符号（sh/sz/bj 前缀）
 *
 * 规则：场内基金按 ETF_CODE_PREFIXES 完整方案归市场（沪 50/51/52/56/58、
 * 深 15/16/18，见 etf.constants.ts——5 开头若走「首位数字段」兜底会被误归
 * 北交所，512690 这类沪市 ETF 行情会拉空）；6 开头（含 688/689 科创）为
 * 沪市；0/3 开头为深市；4/8/9 开头（含 920 新段）为北交所
 */

/** 指数符号前缀规则（沪市 000 段 + 深市 399 段），编译期正则 */
const INDEX_SYMBOL_PATTERN = /^(sh000|sz399)\d{3}$/;

/** 场内基金前缀 → 市场前缀映射（5 开头段全为沪市基金，其余为深市基金） */
const ETF_MARKET_BY_PREFIX: ReadonlyMap<string, 'sh' | 'sz'> = new Map(
  ETF_CODE_PREFIXES.map((prefix) => [prefix, (prefix.startsWith('5') ? 'sh' : 'sz') as 'sh' | 'sz']),
);

/**
 * 是否为指数符号（指数分时/五日无「均价」概念，图表不绘制均价线）
 *
 * 规则：沪市 000 段（sh000001 上证指数 / sh000300 沪深300 / sh000688 科创50 等）
 * 与深市 399 段（sz399001 深证成指 / sz399006 创业板指 等）均为指数；
 * 个股为 sh6 / sz0 / sz3 / bj4|8|9 段，不会命中
 * @param symbol 完整符号（sh600519 形态）
 * @returns true 表示指数
 */
export const isIndexSymbol = (symbol: string): boolean =>
  INDEX_SYMBOL_PATTERN.test(symbol);

/**
 * 6 位纯代码归一化为完整符号
 * @param code 6 位纯代码（如 600519）
 * @returns 完整符号（如 sh600519）；无法识别时原样返回
 */
export const normalizeAShareCode = (code: string): string => {
  if (!/^\d{6}$/.test(code)) {
    return code;
  }
  // 场内基金优先（前缀全为 2 位；5 开头沪市基金走「首位数字段」兜底会被误归北交所）
  const etfMarket = ETF_MARKET_BY_PREFIX.get(code.slice(0, 2));
  if (etfMarket) {
    return `${etfMarket}${code}`;
  }
  if (code.startsWith('6')) {
    return `sh${code}`;
  }
  if (code.startsWith('0') || code.startsWith('3')) {
    return `sz${code}`;
  }
  return `bj${code}`;
};
