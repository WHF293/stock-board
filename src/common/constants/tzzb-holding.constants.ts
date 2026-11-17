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

/** 持仓回放流水单页条数（queryMoneyHistory count；远大于摩擦账本默认 20，翻页往返次数降一个量级） */
export const TZZB_HOLDING_TRADE_PAGE_COUNT = 200;

/** 持仓回放流水并行翻页并发数（上游单页往返数百毫秒，串行是首载慢的主因） */
export const TZZB_HOLDING_TRADE_FETCH_CONCURRENCY = 4;

/** 持仓回放流水持久化缓存 key（localStorage；value 含账户范围，范围不符即弃用） */
export const TZZB_HOLDING_TRADES_CACHE_KEY = 'tzzb.holdingTrades.v1';

/** 持仓回放流水落库连接串（sqlite:stock-board.db，建表在 Rust 侧 migration V11；浏览器端不可用回落 localStorage） */
export const TZZB_HOLDING_DB_URL = 'sqlite:stock-board.db';
