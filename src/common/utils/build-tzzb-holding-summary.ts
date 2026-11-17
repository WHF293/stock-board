import { TZZB_HOLDING_QTY_EPS, TZZB_TRADE_ACTION_BUY, TZZB_TRADE_ACTION_SELL } from '../constants/tzzb-holding.constants.ts';
import type { TzzbHoldingRow, TzzbHoldingSummary } from '../types/tzzb-holding.types.ts';
import type { TzzbPositionHolding, TzzbStockTrade } from '../types/tzzb.types.ts';
import { normalizeAShareCode } from './normalize-a-share-code';
import { replayTzzbHoldings } from './replay-tzzb-holdings';
import type { TzzbReplayPosition } from './replay-tzzb-holdings';
import type { FullQuote } from '../types/stock-quote.types.ts';

/**
 * 单标的的当日盈亏推算中间量
 */
interface CodeDayPnl {
  /** 当日盈亏（行情缺失为 null，不进合计） */
  dayPnl: number | null;
  /** 昨收市值基准（昨日收盘持仓 × 昨收，当日盈亏率分母） */
  basis: number;
}

/** 回放合成的单标的持仓（数量 + 摊薄成本金额，语义与 TzzbReplayPosition 一致） */
interface EffectivePosition {
  /** 证券名称 */
  name: string;
  /** 当前持仓数量（含当日买卖叠加；当日全卖为 0） */
  quantity: number;
  /** 摊薄成本金额（含买入费用） */
  costAmount: number;
}

/**
 * 持仓回放的权威锚定入参（2026-11-17 新增）
 *
 * 背景：queryMoneyHistory 的流水与真实持仓存在缺口（实测电池ETF已清仓但
 * 流水回放残留 700 股——缺卖出记录，重拉也无法补齐）。清算快照
 * queryStockPosition.holdings 是券商权威口径，用它在「快照已覆盖该标的
 * 全部流水」的前提下重置回放数量，并剔除已被清仓的幽灵持仓。
 */
export interface TzzbHoldingAnchor {
  /** 权威持仓明细映射（code → holding；含已清仓的 0 数量行） */
  holdings: ReadonlyMap<string, TzzbPositionHolding>;
  /** 清算快照数据截止日（YYYY-MM-DD；空串 = 未知，全部回落纯回放） */
  dataDate: string;
}

/**
 * 判断清算快照是否已覆盖某标的的全部流水
 *
 * 只有快照截止日 ≥ 该标的最新成交日时，holdings 数量才可信（快照晚于
 * 最后一笔成交 = 清算已消化全部流水）；否则快照可能是旧的，仍走纯回放
 * @param latestTrade 该标的最新成交日（YYYY-MM-DD；无流水为 ''）
 * @param anchor 权威锚定入参
 * @returns true = 快照覆盖，可用 holdings 锚定
 */
const isSnapshotCovered = (
  latestTrade: string,
  anchor: TzzbHoldingAnchor | undefined,
): boolean =>
  anchor !== undefined &&
  anchor.dataDate !== '' &&
  latestTrade !== '' &&
  anchor.dataDate >= latestTrade;

/**
 * 用权威快照 + 当日流水叠加合成单标的持仓
 *
 * 基底 = 快照数量与摊薄成本价（清算口径，快照日收盘）；当日买入累计数量与
 * 成本（成交金额 + 费用），卖出按摊薄成本同比例扣减（与 replayTzzbHoldings
 * 同一套规则）。快照日收盘后的当日流水天然不会出现在快照里，叠加后即盘中实时
 * @param holding 权威持仓（数量可为 0 = 已清仓基底）
 * @param todayTrades 该标的当日流水
 * @returns 合成持仓
 */
const seedFromHolding = (
  holding: TzzbPositionHolding,
  todayTrades: readonly TzzbStockTrade[],
): EffectivePosition => {
  const pos: EffectivePosition = {
    name: holding.name,
    quantity: holding.quantity,
    costAmount: holding.costPrice * holding.quantity,
  };
  for (const trade of todayTrades) {
    if (trade.action.includes(TZZB_TRADE_ACTION_BUY)) {
      pos.quantity += trade.quantity;
      pos.costAmount += trade.amount + trade.feeTotal;
    } else if (trade.action.includes(TZZB_TRADE_ACTION_SELL)) {
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
  }
  return pos;
};

/**
 * 推算单只标的的当日实时盈亏
 *
 * 口径（对券商清算后下发的当日盈亏近似）：
 * - 昨日收盘持仓部分：(现价 − 昨收) × 昨日收盘数量（浮动）
 * - 当日买入回合：(现价 − 买价) × 数量 − 买入费用（浮动）
 * - 当日卖出回合：(卖价 − 昨收) × 数量 − 卖出费用（已实现）
 * @param quantity 当前持仓数量（回放净额；当日全卖为 0）
 * @param todayTrades 该标的当日流水
 * @param quote 实时报价（缺失 / 价格非法返回 null）
 * @returns 当日盈亏与昨收基准；标的与当日无关时返回 null
 */
const computeCodeDayPnl = (
  quantity: number,
  todayTrades: readonly TzzbStockTrade[],
  quote: FullQuote | undefined,
): CodeDayPnl | null => {
  const buyTrades = todayTrades.filter((t) => t.action.includes(TZZB_TRADE_ACTION_BUY));
  const sellTrades = todayTrades.filter((t) => t.action.includes(TZZB_TRADE_ACTION_SELL));
  const buyQty = buyTrades.reduce((sum, t) => sum + t.quantity, 0);
  const sellQty = sellTrades.reduce((sum, t) => sum + t.quantity, 0);
  const qtyYesterday = quantity - buyQty + sellQty;
  const feeToday = todayTrades.reduce((sum, t) => sum + t.feeTotal, 0);
  if (qtyYesterday === 0 && buyQty === 0 && sellQty === 0) return null;
  if (!quote || quote.price <= 0 || quote.prevClose <= 0) return null;
  let pnl = (quote.price - quote.prevClose) * qtyYesterday - feeToday;
  for (const trade of buyTrades) {
    pnl += (quote.price - trade.price) * trade.quantity;
  }
  for (const trade of sellTrades) {
    if (trade.price > 0) pnl -= (trade.price - quote.prevClose) * trade.quantity;
  }
  return { dayPnl: pnl, basis: quote.prevClose * qtyYesterday };
};

/**
 * 由全历史流水 + 实时行情推算当前持仓与当日实时盈亏
 *
 * 持仓 = 全历史流水回放净额 > 0 的标的（成本为摊薄口径，含买入费用）；
 * 当日盈亏逐标的推算后合计（当日已清仓标的的实现盈亏也计入合计）。
 * 行情缺失（停牌 / 拉取失败）的标的市值与当日盈亏记 null，不进合计。
 *
 * 权威锚定（anchor 存在时）：清算快照已覆盖流水的标的重置为快照数量
 * （叠加当日买卖），快照判为已清仓且当日无成交的标的剔除——流水缺口
 * 导致的幽灵持仓（如已清仓 ETF 残留）不再出现在列表里。
 * @param trades 全历史股票流水（当前账户范围；仅当日流水也支持但持仓不含历史仓位）
 * @param quotes 实时报价映射（key 为 6 位纯代码，与 FullQuote.code 同形态）
 * @param today 当日日期（YYYY-MM-DD，与流水 date 同口径）
 * @param replay 预计算的流水回放持仓（可选；调用方在行情轮询场景复用同一份回放，
 * 避免每个行情 tick 都对全历史流水重放一遍——不传时内部自行计算）
 * @param anchor 权威锚定入参（可选；缺省 = 纯流水回放，行为与旧版一致）
 * @returns 持仓汇总（含行情轮询符号清单）
 */
export const buildTzzbHoldingSummary = (
  trades: readonly TzzbStockTrade[],
  quotes: Readonly<Record<string, FullQuote>>,
  today: string,
  replay: ReadonlyMap<string, TzzbReplayPosition> = replayTzzbHoldings(trades),
  anchor?: TzzbHoldingAnchor,
): TzzbHoldingSummary => {
  const todayTrades = trades.filter((t) => t.date === today);
  const todayByCode = new Map<string, TzzbStockTrade[]>();
  for (const trade of todayTrades) {
    const list = todayByCode.get(trade.code) ?? [];
    list.push(trade);
    todayByCode.set(trade.code, list);
  }
  // 各标的最新成交日（快照覆盖判定用；单次遍历流水）
  const latestTradeByCode = new Map<string, string>();
  for (const trade of trades) {
    const known = latestTradeByCode.get(trade.code);
    if (known === undefined || trade.date > known) {
      latestTradeByCode.set(trade.code, trade.date);
    }
  }
  // 有效持仓合成：回放基底 + 权威锚定重置 + 仅存在于快照的标的补行
  const effective = new Map<string, EffectivePosition>();
  const anchorHoldings = anchor?.holdings;
  for (const [code, pos] of replay) {
    if (anchorHoldings && isSnapshotCovered(latestTradeByCode.get(code) ?? '', anchor)) {
      const holding = anchorHoldings.get(code);
      const holdQty = holding?.quantity ?? 0;
      const tradedToday = (todayByCode.get(code) ?? []).length > 0;
      if (holdQty <= TZZB_HOLDING_QTY_EPS && !tradedToday) {
        // 快照判已清仓且当日无成交：流水缺口的幽灵持仓，剔除
        continue;
      }
      if (holding) {
        effective.set(code, seedFromHolding(holding, todayByCode.get(code) ?? []));
        continue;
      }
    }
    effective.set(code, { name: pos.name, quantity: pos.quantity, costAmount: pos.costAmount });
  }
  if (anchorHoldings) {
    for (const [code, holding] of anchorHoldings) {
      const existing = effective.get(code);
      if (holding.quantity <= TZZB_HOLDING_QTY_EPS) continue;
      if (existing && existing.quantity > TZZB_HOLDING_QTY_EPS) continue;
      // 仅存在于快照（或被回放清零）的持仓（流水窗口外建仓等）：以快照为基底补行，
      // 当日卖出叠加后归零不会误复活
      effective.set(code, seedFromHolding(holding, todayByCode.get(code) ?? []));
    }
  }
  // 逐标的当日盈亏：当前持仓 ∪ 当日成交标的（当日全卖只进合计不进行）
  const dayPnlByCode = new Map<string, CodeDayPnl>();
  let dayPnlTotal = 0;
  let basisTotal = 0;
  for (const [code, pos] of effective) {
    const result = computeCodeDayPnl(pos.quantity, todayByCode.get(code) ?? [], quotes[code]);
    if (result) dayPnlByCode.set(code, result);
  }
  for (const [code, tradesToday] of todayByCode) {
    if (dayPnlByCode.has(code)) continue;
    const result = computeCodeDayPnl(effective.get(code)?.quantity ?? 0, tradesToday, quotes[code]);
    if (result) dayPnlByCode.set(code, result);
  }
  for (const result of dayPnlByCode.values()) {
    if (result.dayPnl !== null) {
      dayPnlTotal += result.dayPnl;
      basisTotal += Math.abs(result.basis);
    }
  }
  const rows: TzzbHoldingRow[] = [];
  for (const [code, pos] of effective) {
    if (pos.quantity <= TZZB_HOLDING_QTY_EPS) continue;
    const quote = quotes[code];
    const price = quote && quote.price > 0 ? quote.price : null;
    const costPrice = pos.costAmount / pos.quantity;
    const dayPnl = dayPnlByCode.get(code)?.dayPnl ?? null;
    rows.push({
      code,
      name: pos.name,
      quantity: pos.quantity,
      costPrice,
      marketValue: price === null ? null : price * pos.quantity,
      pnl: price === null ? null : (price - costPrice) * pos.quantity,
      pnlRate: price === null || costPrice <= 0 ? null : price / costPrice - 1,
      dayPnl,
      todayTradeCount: (todayByCode.get(code) ?? []).length,
    });
  }
  rows.sort((a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1));
  const heldCodes: string[] = [];
  for (const [code, pos] of effective) {
    if (pos.quantity > TZZB_HOLDING_QTY_EPS) heldCodes.push(code);
  }
  const symbols = [...new Set([...heldCodes, ...todayByCode.keys()])].map((code) =>
    normalizeAShareCode(code),
  );
  return {
    rows,
    marketValue: rows.reduce((sum, row) => sum + (row.marketValue ?? 0), 0),
    dayPnl: dayPnlTotal,
    dayRate: basisTotal > 0 ? dayPnlTotal / basisTotal : null,
    holdingCount: rows.length,
    todayTradeCount: todayTrades.length,
    symbols,
  };
};
