import { TZZB_HOLDING_QTY_EPS, TZZB_TRADE_ACTION_BUY, TZZB_TRADE_ACTION_SELL } from '../constants/tzzb-holding.constants.ts';
import type { TzzbStockTrade } from '../types/tzzb.types.ts';

/** 单只标的的回放持仓（摊薄成本口径） */
export interface TzzbReplayPosition {
  /** 证券代码（6 位） */
  code: string;
  /** 证券名称（取最近一笔流水） */
  name: string;
  /** 回放净持仓数量（股；清零 / 负数防御后 ≥ 0） */
  quantity: number;
  /** 剩余持仓的摊薄成本金额（含买入费用；清仓后为 0） */
  costAmount: number;
}

/**
 * 全历史成交流水回放出各标的当前持仓
 *
 * 口径：按成交日期升序重放——买入累计数量与成本（成交金额 + 费用合计）；
 * 卖出按摊薄成本同比例扣减成本金额。买卖判定看 opName 含「买入」/「卖出」
 * （与基金回合重构同口径，分红 / 转托管等其他操作不参与回放）。
 *
 * 注意：流水无成交时间字段，同日多笔按接口返回顺序重放，摊薄成本对
 * 同日买卖顺序不敏感（差异在费用摊到哪一回合，量级可忽略）。
 * @param trades 全历史股票流水（当前账户范围）
 * @returns 代码 → 回放持仓映射（含已清仓标的，数量为 0，供当日盈亏取昨日基准）
 */
export const replayTzzbHoldings = (
  trades: readonly TzzbStockTrade[],
): Map<string, TzzbReplayPosition> => {
  // 升序稳定排序（同日保持接口原始顺序，确定性重放）
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  const map = new Map<string, TzzbReplayPosition>();
  for (const trade of sorted) {
    const pos = map.get(trade.code) ?? {
      code: trade.code,
      name: trade.name,
      quantity: 0,
      costAmount: 0,
    };
    pos.name = trade.name || pos.name;
    if (trade.action.includes(TZZB_TRADE_ACTION_BUY)) {
      pos.quantity += trade.quantity;
      pos.costAmount += trade.amount + trade.feeTotal;
    } else if (trade.action.includes(TZZB_TRADE_ACTION_SELL)) {
      // 摊薄成本同比例扣减；超卖（数据异常）时数量钳到 0、成本清零
      const held = Math.max(pos.quantity, 0);
      const sold = Math.min(trade.quantity, held);
      if (held > TZZB_HOLDING_QTY_EPS) {
        pos.costAmount -= (pos.costAmount / held) * sold;
      }
      pos.quantity = held - trade.quantity;
      if (pos.quantity <= TZZB_HOLDING_QTY_EPS) {
        pos.quantity = 0;
        pos.costAmount = 0;
      }
    }
    map.set(trade.code, pos);
  }
  return map;
};
