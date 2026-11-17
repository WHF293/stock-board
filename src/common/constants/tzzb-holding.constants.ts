/**
 * 当前持仓（流水回放推算）模块常量
 */

/** 流水操作名买入口径：opName 含「买入」即买入（证券买入 / 融资买入同口径） */
export const TZZB_TRADE_ACTION_BUY = '买入';

/** 流水操作名卖出口径：opName 含「卖出」即卖出（融券卖出同口径） */
export const TZZB_TRADE_ACTION_SELL = '卖出';

/** 回放净数量归零阈值（浮点累加误差容差，低于该值视为已清仓） */
export const TZZB_HOLDING_QTY_EPS = 1e-4;

/** 持仓回放流水起始日（yyyyMMdd；账本数据起始 2025-09-30，更早无流水） */
export const TZZB_HOLDING_TRADE_START_DATE = '20250930';
