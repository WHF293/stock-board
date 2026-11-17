import { TZZB_HOLDING_QTY_EPS, TZZB_TRADE_ACTION_BUY, TZZB_TRADE_ACTION_SELL } from '../constants/tzzb-holding.constants.ts';
import type { TzzbHoldingRow, TzzbHoldingSummary } from '../types/tzzb-holding.types.ts';
import type { TzzbStockTrade } from '../types/tzzb.types.ts';
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
 * 幽灵剔除（2026-11-18）：上游流水与清算快照可能互相矛盾（实测快照漏掉
 * 流水在持的标的、又保留已清仓标的），且重拉无法补齐——改用清仓记录交叉：
 * 清仓记录里最后一笔清仓日 ≥ 该标的最后一笔买入日（全部买卖回合已闭合）
 * 的标的判定为已清仓，从持仓表剔除（当日有成交的除外，走当日已清仓合计）。
 * @param trades 全历史股票流水（当前账户范围；仅当日流水也支持但持仓不含历史仓位）
 * @param quotes 实时报价映射（key 为 6 位纯代码，与 FullQuote.code 同形态）
 * @param today 当日日期（YYYY-MM-DD，与流水 date 同口径）
 * @param replay 预计算的流水回放持仓（可选；调用方在行情轮询场景复用同一份回放，
 * 避免每个行情 tick 都对全历史流水重放一遍——不传时内部自行计算）
 * @param phantomCodes 已清仓幽灵标的代码集（可选；由调用方用清仓记录 × 流水
 * 最后一笔买入日交叉算出，见 buildTzzbPhantomCodes）
 * @returns 持仓汇总（含行情轮询符号清单）
 */
export const buildTzzbHoldingSummary = (
  trades: readonly TzzbStockTrade[],
  quotes: Readonly<Record<string, FullQuote>>,
  today: string,
  replay: ReadonlyMap<string, TzzbReplayPosition> = replayTzzbHoldings(trades),
  phantomCodes?: ReadonlySet<string>,
): TzzbHoldingSummary => {
  const todayTrades = trades.filter((t) => t.date === today);
  const todayByCode = new Map<string, TzzbStockTrade[]>();
  for (const trade of todayTrades) {
    const list = todayByCode.get(trade.code) ?? [];
    list.push(trade);
    todayByCode.set(trade.code, list);
  }
  // 逐标的当日盈亏：当前持仓 ∪ 当日成交标的（当日全卖只进合计不进行）
  const dayPnlByCode = new Map<string, CodeDayPnl>();
  let dayPnlTotal = 0;
  let basisTotal = 0;
  for (const [code, pos] of replay) {
    if (phantomCodes?.has(code) && (todayByCode.get(code) ?? []).length === 0) continue;
    const result = computeCodeDayPnl(pos.quantity, todayByCode.get(code) ?? [], quotes[code]);
    if (result) dayPnlByCode.set(code, result);
  }
  for (const [code, tradesToday] of todayByCode) {
    if (dayPnlByCode.has(code)) continue;
    const result = computeCodeDayPnl(replay.get(code)?.quantity ?? 0, tradesToday, quotes[code]);
    if (result) dayPnlByCode.set(code, result);
  }
  for (const result of dayPnlByCode.values()) {
    if (result.dayPnl !== null) {
      dayPnlTotal += result.dayPnl;
      basisTotal += Math.abs(result.basis);
    }
  }
  const rows: TzzbHoldingRow[] = [];
  for (const [code, pos] of replay) {
    if (pos.quantity <= TZZB_HOLDING_QTY_EPS) continue;
    if (phantomCodes?.has(code) && (todayByCode.get(code) ?? []).length === 0) continue;
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
  for (const [code, pos] of replay) {
    if (pos.quantity > TZZB_HOLDING_QTY_EPS && !(phantomCodes?.has(code) ?? false)) {
      heldCodes.push(code);
    }
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

/**
 * 用清仓记录 × 流水最后一笔买入日交叉算出「已清仓幽灵标的」代码集
 *
 * 规则：清仓记录存在该标的（closeDate 非空）且最后一笔清仓日 ≥ 最后一笔买入日
 * ——说明全部买卖回合已闭合，流水回放的剩余持仓（源于上游流水缺卖出记录，
 * 重拉无法补齐）是幽灵持仓。持有中回合（closeDate null）或清仓后又买入的
 * 标的不在集合内，保留回放结果
 * @param trades 全历史股票流水（当前账户范围）
 * @param cleared 清仓记录列表（queryClearedPosition，groupBu stock 聚合口径）
 * @returns 幽灵标的代码集合（6 位纯代码）
 */
export const buildTzzbPhantomCodes = (
  trades: readonly TzzbStockTrade[],
  cleared: readonly { code: string; closeDate: string | null }[],
): Set<string> => {
  const lastBuyByCode = new Map<string, string>();
  for (const trade of trades) {
    if (!trade.action.includes(TZZB_TRADE_ACTION_BUY)) continue;
    const known = lastBuyByCode.get(trade.code);
    if (known === undefined || trade.date >= known) {
      lastBuyByCode.set(trade.code, trade.date);
    }
  }
  const phantom = new Set<string>();
  for (const row of cleared) {
    if (row.closeDate === null) continue;
    const lastBuy = lastBuyByCode.get(row.code);
    if (lastBuy !== undefined && row.closeDate >= lastBuy) {
      phantom.add(row.code);
    }
  }
  return phantom;
};
