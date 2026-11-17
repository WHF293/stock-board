/**
 * 当前持仓（流水回放推算）模块常量
 */

/** 流水操作名买入口径：opName 含「买入」即买入（证券买入 / 融资买入同口径） */
export const TZZB_TRADE_ACTION_BUY = '买入';

/** 流水操作名卖出口径：opName 含「卖出」即卖出（融券卖出同口径） */
export const TZZB_TRADE_ACTION_SELL = '卖出';

/** 回放净数量归零阈值（浮点累加误差容差，低于该值视为已清仓） */
export const TZZB_HOLDING_QTY_EPS = 1e-4;

/**
 * 账本数据起始日（yyyyMMdd）
 *
 * 实测口径（2026-11-18）：上游流水最早成交日 2024-10-15，投资账本 App「全部」
 * 区间固定从 2024-10-08 起算——queryPnlSummary(20241008) 的总盈亏与 App 完全
 * 一致；曾写死 2025-09-30 导致软件「全部区间盈亏」比 App 少算约 1064 元
 */
export const TZZB_DATA_START_DATE = '20241008';

/** 账本数据起始日（YYYY-MM-DD 形态；queryClearedPosition openDate、日期比较等用） */
export const TZZB_DATA_START_DATE_DASHED = '2024-10-08';

/** 持仓回放流水起始日（yyyyMMdd；= 账本数据起始日，回放源流水从数据起点拉满） */
export const TZZB_HOLDING_TRADE_START_DATE = TZZB_DATA_START_DATE;

/** 持仓回放流水缓存按起始日重建的水位 key（localStorage；value = {scope, startDate}） */
export const TZZB_HOLDING_TRADES_REBUILD_KEY = 'tzzb.holdingTrades.rebuildMark';

/**
 * 权威锚定矛盾度保险丝（2026-11-18）：上游清算快照 holdings 与流水回放可能
 * 版本错位（实测同日 queryStockPosition 与 queryMoneyHistory / queryDayProfitSummary
 * 互相矛盾——快照说持三只已清仓 ETF、漏掉流水在持的酒ETF）。快照覆盖标的中
 * 数量矛盾达到以下阈值时判定快照不可信，整体禁用锚定回落纯回放
 */

/** 触发禁用的最少矛盾标的数 */
export const TZZB_ANCHOR_CONFLICT_MIN_COUNT = 2;

/** 触发禁用的矛盾标的占覆盖标的的比例下限 */
export const TZZB_ANCHOR_CONFLICT_RATIO = 0.5;

/** 单标数量矛盾判定容差（差值 > max(双方数量) × 该比例即算矛盾） */
export const TZZB_ANCHOR_CONFLICT_TOLERANCE = 0.05;

/** 持仓回放流水单页条数（queryMoneyHistory count；远大于摩擦账本默认 20，翻页往返次数降一个量级） */
export const TZZB_HOLDING_TRADE_PAGE_COUNT = 200;

/** 持仓回放流水并行翻页并发数（上游单页往返数百毫秒，串行是首载慢的主因） */
export const TZZB_HOLDING_TRADE_FETCH_CONCURRENCY = 4;

/** 持仓回放流水持久化缓存 key（localStorage；value 含账户范围，范围不符即弃用） */
export const TZZB_HOLDING_TRADES_CACHE_KEY = 'tzzb.holdingTrades.v1';

/** 持仓回放流水落库连接串（sqlite:stock-board.db，建表在 Rust 侧 migration V11；浏览器端不可用回落 localStorage） */
export const TZZB_HOLDING_DB_URL = 'sqlite:stock-board.db';
