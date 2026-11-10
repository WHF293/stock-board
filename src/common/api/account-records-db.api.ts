import { isTauri } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import { mergeSymbolTradeRecords } from '../utils/merge-symbol-trade-records';
import { getTzzbAllStockTrades } from './tzzb.api.ts';
import type { TzzbStockTrade } from '../types/tzzb.types.ts';
import type { AccountTradeRecord, ImportKind } from '../types/account.types.ts';

/**
 * 账户成交流水只读出口（stock-board.db，表见 src-tauri/src/lib.rs v4 迁移）
 *
 * 交割单 / 对账单两表同构（account_trade_record / account_statement_record），
 * 由 kind 映射表名。手工文件导入已下线，本模块仅保留读取与级联删除：
 * 现存数据为历史导入存量。个股成交记录（listTradeRecordsBySymbol）在本机库
 * 之外合并同花顺投资账本（MCP）股票流水——本机库只覆盖历史导入存量，
 * 账本流水覆盖 ETF 等全品种（2026-11-10 王总反馈侧栏 ETF 无记录）；
 * 浏览器端降级：本机库读取返回空，账本流水照常合并
 */

/** 连接单例 */
let dbPromise: Promise<Database> | null = null;

/**
 * 取连接（仅 Tauri 环境）
 * @returns 连接 Promise；浏览器环境返回 null
 */
const getDb = (): Promise<Database> | null => {
  if (!isTauri()) return null;
  dbPromise ??= Database.load('sqlite:stock-board.db');
  return dbPromise;
};

/** kind → 表名 */
const TABLE_BY_KIND: Record<ImportKind, string> = {
  trade: 'account_trade_record',
  statement: 'account_statement_record',
};

/**
 * 数据库行 -> 流水记录（两表同构，共用映射）
 * @param r 数据行
 * @returns 流水记录
 */
const mapRow = (r: Record<string, unknown>): AccountTradeRecord => ({
  id: String(r.id),
  accountId: String(r.account_id),
  tradeDate: String(r.trade_date),
  tradeTime: String(r.trade_time),
  symbol: String(r.symbol),
  stockName: String(r.stock_name),
  action: String(r.action),
  quantity: Number(r.quantity),
  price: Number(r.price),
  amount: Number(r.amount),
  balance: r.balance === null ? null : Number(r.balance),
  netAmount: Number(r.net_amount),
  afterAmount: r.after_amount === null ? null : Number(r.after_amount),
  stampTax: Number(r.stamp_tax),
  commission: Number(r.commission),
  transferFee: Number(r.transfer_fee),
  entrustFee: Number(r.entrust_fee),
  serviceFee: Number(r.service_fee),
  contractNo: String(r.contract_no ?? ''),
  dealNo: String(r.deal_no ?? ''),
  market: String(r.market ?? ''),
  importedAt: Number(r.imported_at),
});

/**
 * 读取某账户的成交流水（按日期时间升序）
 * @param accountId 账户 id
 * @param kind 导入类型
 * @returns 流水记录
 */
export const listTradeRecords = async (
  accountId: string,
  kind: ImportKind,
): Promise<AccountTradeRecord[]> => {
  const db = getDb();
  if (!db) return [];
  const rows = await (
    await db
  ).select<Record<string, unknown>[]>(
    `SELECT * FROM ${TABLE_BY_KIND[kind]} WHERE account_id = $1 ORDER BY trade_date, trade_time`,
    [accountId],
  );
  return rows.map(mapRow);
};

/**
 * 账本股票流水 → 成交记录（口径对齐本机库形态）
 *
 * 账本流水无成交时间（仅到日）、无账户维度（归入固定虚拟账户 'tzzb-mcp'）；
 * quantity 原文无符号，方向看操作名（卖出转负）
 * @param t 账本股票流水行
 * @returns 成交记录
 */
const mapTzzbTrade = (t: TzzbStockTrade): AccountTradeRecord => ({
  id: `tzzb-${t.date}-${t.code}-${t.action}-${t.quantity}-${t.price}`,
  accountId: 'tzzb-mcp',
  tradeDate: t.date,
  tradeTime: '',
  symbol: t.code,
  stockName: t.name,
  action: t.action,
  quantity: t.action.includes('卖') ? -Math.abs(t.quantity) : Math.abs(t.quantity),
  price: t.price,
  amount: t.amount,
  balance: null,
  netAmount: t.amount,
  afterAmount: null,
  stampTax: 0,
  commission: t.commission,
  transferFee: t.transferFee,
  entrustFee: 0,
  serviceFee: 0,
  contractNo: '',
  dealNo: '',
  market: '',
  importedAt: 0,
});

/**
 * 跨源同笔匹配键（本机库 × 账本流水去重）：日期 + 代码 + 方向数量 + 价格 + 操作。
 * 价格取 3 位小数归一避免浮点尾差；本机记录优先保留（含成交时间与费用明细）
 * @param record 成交记录
 * @returns 匹配键
 */
const crossSourceIdentity = (record: AccountTradeRecord): string =>
  [record.tradeDate, record.symbol, Math.abs(record.quantity), record.price.toFixed(3), record.action].join('|');

/**
 * 读取个股的全部成交记录（供个股详情页「交易记录」与 K 线 BS/T 标注）
 *
 * 本机库：交割单表覆盖更长历史（实测 2024-10 起）全量保留，对账单表只补充其缺失部分；
 * 合并与跨表去重口径见 utils/merge-symbol-trade-records。symbol 匹配同时覆盖
 * 库内存量的带市场前缀形态（sh/sz/bj）。
 * 账本流水（MCP）：按 6 位代码过滤后并入，与本机库同笔去重（本机优先）；
 * 拉取失败静默为空（不阻塞本机记录展示）
 * @param symbol 个股符号（sh600519 / 600519 形态均可）
 * @returns 成交记录（按日期时间倒序，最新在前）
 */
export const listTradeRecordsBySymbol = async (symbol: string): Promise<AccountTradeRecord[]> => {
  const code = symbol.replace(/^(sh|sz|bj)/i, '');
  // 库内 symbol 存量可能带市场前缀（sh/sz/bj），四形态一并命中
  const variants = [code, `sh${code}`, `sz${code}`, `bj${code}`];
  const db = getDb();
  let local: AccountTradeRecord[] = [];
  if (db) {
    const conn = await db;
    const [tradeRows, statementRows] = await Promise.all([
      conn.select<Record<string, unknown>[]>(
        'SELECT * FROM account_trade_record WHERE symbol IN ($1, $2, $3, $4)',
        variants,
      ),
      conn.select<Record<string, unknown>[]>(
        'SELECT * FROM account_statement_record WHERE symbol IN ($1, $2, $3, $4)',
        variants,
      ),
    ]);
    local = mergeSymbolTradeRecords(tradeRows.map(mapRow), statementRows.map(mapRow));
  }
  let mcp: AccountTradeRecord[] = [];
  try {
    const trades = await getTzzbAllStockTrades();
    mcp = trades.filter((t) => t.code === code).map(mapTzzbTrade);
  } catch (error) {
    console.warn('[account-records-db] merge tzzb trades failed', error);
  }
  const localKeys = new Set(local.map(crossSourceIdentity));
  return [...local, ...mcp.filter((record) => !localKeys.has(crossSourceIdentity(record)))].sort(
    (a, b) => `${b.tradeDate} ${b.tradeTime}`.localeCompare(`${a.tradeDate} ${a.tradeTime}`),
  );
};

/**
 * 删除某账户的全部成交流水（两类表一起清，账户删除时级联）
 * @param accountId 账户 id
 */
export const deleteTradeRecordsByAccount = async (accountId: string): Promise<void> => {
  const db = getDb();
  if (!db) return;
  const conn = await db;
  await conn.execute('DELETE FROM account_trade_record WHERE account_id = $1', [accountId]);
  await conn.execute('DELETE FROM account_statement_record WHERE account_id = $1', [accountId]);
};
