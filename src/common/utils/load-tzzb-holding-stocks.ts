import { WATCHLIST_SYMBOL_PATTERN } from '../constants/watchlist.constants.ts';
import {
  TZZB_HOLDING_QTY_EPS,
  TZZB_TRADE_ACTION_BUY,
} from '../constants/tzzb-holding.constants.ts';
import { loadAllScopesTzzbHoldingTradesFromDb } from '../api/tzzb-holding-db.api.ts';
import {
  dedupeHoldingTrades,
  readAllScopesTzzbHoldingTradesCache,
} from '../api/tzzb.api.ts';
import { toFullSymbol } from './to-full-symbol';
import { buildTzzbPhantomCodes } from './build-tzzb-holding-summary';
import { readTzzbClearedCache } from './read-tzzb-cleared-cache';
import { replayTzzbHoldings } from './replay-tzzb-holdings';
import type { WatchlistStock } from '../types/watchlist.types.ts';

/** 账本流水回放出的两个自选分组内容 */
export interface TzzbHoldingStocks {
  /** 在持标的（回放净数量 > 归零阈值且非幽灵持仓） */
  current: WatchlistStock[];
  /** 已清仓标的（回放净数量归零 / 幽灵持仓；只统计出现过买入流水的，排除仅有分红等非买卖流水的代码） */
  history: WatchlistStock[];
}

/**
 * 从**本地**账本流水回放出「当前持仓 / 历史持有」两个自选分组的内容
 *
 * 数据口径（2026-11-25 修正）：**全部账户合并**——落库与降级缓存按账户范围
 * 分 scope 冗余存储，而账户分析页确认过同步账户后 scopeAccountIds 恒非 null、
 * 'all' 口径实际从不落库；改为跨 scope 全读后按唯一约束八元组去重合并
 * （dedupeHoldingTrades）。只读两级本地缓存，**绝不触发上游同步**——
 * SQLite（tzzb_holding_trade 表，Tauri 端）→ localStorage 降级缓存（浏览器端 /
 * SQLite 无数据时）→ 都没有则空组；想要新数据请先到「账户分析」页同步账本
 *
 * 幽灵剔除与账户分析「当前持仓」面板同口径（buildTzzbPhantomCodes）：清仓
 * 记录（读口径快照缓存）里最后一笔清仓日 ≥ 该标的最后一笔买入日的标的，
 * 上游流水缺卖出记录导致的回放残留不算在持
 * @returns 两组自选股条目（符号已归一为完整形态；非法符号的标的跳过）
 */
export const loadTzzbHoldingStocks = async (): Promise<TzzbHoldingStocks> => {
  const trades = dedupeHoldingTrades(
    (await loadAllScopesTzzbHoldingTradesFromDb())
    ?? readAllScopesTzzbHoldingTradesCache()
    ?? [],
  );
  const replay = replayTzzbHoldings(trades);
  // 幽灵持仓：流水回放残留但清仓记录已闭合的标的（如电池ETF清仓后残留 700 股）
  const phantomCodes = buildTzzbPhantomCodes(trades, readTzzbClearedCache());
  // 只有出现过买入流水的代码才算「曾持有」：回放会把只有分红 / 转托管等
  // 非买卖流水的代码也建为数量 0 的条目，这类不是已清仓标的
  const everBought = new Set(
    trades
      .filter((trade) => trade.action.includes(TZZB_TRADE_ACTION_BUY))
      .map((trade) => trade.code),
  );
  const current: WatchlistStock[] = [];
  const history: WatchlistStock[] = [];
  const addedAt = Date.now();
  for (const position of replay.values()) {
    const symbol = toFullSymbol(position.code);
    // 自选股只收完整符号形态；无法归一的代码（异常流水）跳过
    if (!WATCHLIST_SYMBOL_PATTERN.test(symbol)) {
      continue;
    }
    const stock: WatchlistStock = { symbol, name: position.name, addedAt };
    if (position.quantity > TZZB_HOLDING_QTY_EPS && !phantomCodes.has(position.code)) {
      current.push(stock);
    } else if (everBought.has(position.code)) {
      history.push(stock);
    }
  }
  return { current, history };
};
