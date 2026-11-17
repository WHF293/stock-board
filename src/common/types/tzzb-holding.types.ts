/**
 * 当前持仓（交易流水回放推算）类型
 *
 * 背景：账本 MCP 的持仓 / 当日盈亏（queryStockPosition / queryPnlSummary）
 * 要等券商清算后才下发，盘中拿不到。本模块用全历史成交流水回推出各账户
 * 当前持仓，再结合实时行情与当日流水推算盘中实时盈亏（2026-11-17 新增）。
 */

/** 当前持仓单行（流水回放 + 实时行情合成） */
export interface TzzbHoldingRow {
  /** 证券代码（6 位） */
  code: string;
  /** 证券名称 */
  name: string;
  /** 当前持仓数量（股，回放净额） */
  quantity: number;
  /** 摊薄成本价（含买入费用；数量为 0 时无意义） */
  costPrice: number;
  /** 持仓市值（现价 × 数量；行情缺失为 null） */
  marketValue: number | null;
  /** 浮动盈亏（(现价 − 成本价) × 数量；行情缺失为 null） */
  pnl: number | null;
  /** 持仓收益率（小数口径；行情缺失 / 成本价为 0 时为 null） */
  pnlRate: number | null;
  /**
   * 当日实时盈亏（行情缺失为 null）
   *
   * 口径 = (现价 − 昨收) × 昨日收盘持仓 + 当日买入回合 (现价 − 买价) × 数量
   * − 当日卖出回合 (卖价 − 昨收) × 数量 − 当日费用；当日已清仓个股也计入
   */
  dayPnl: number | null;
  /** 当日成交笔数 */
  todayTradeCount: number;
}

/** 当前持仓模块汇总 */
export interface TzzbHoldingSummary {
  /** 持仓行（按市值降序；行情缺失行沉底） */
  rows: TzzbHoldingRow[];
  /** 持仓市值合计（仅计有行情的行） */
  marketValue: number;
  /** 当日实时盈亏合计（含当日已清仓个股的实现盈亏） */
  dayPnl: number;
  /** 当日盈亏率（分母 = 昨收市值基准；基准为 0 时为 null） */
  dayRate: number | null;
  /** 持仓只数 */
  holdingCount: number;
  /** 当日成交笔数 */
  todayTradeCount: number;
  /** 行情轮询符号清单（当前持仓 ∪ 当日成交标的；normalizeAShareCode 完整形态） */
  symbols: string[];
}
