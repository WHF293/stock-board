import { isTauri } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import { TZZB_HOLDING_DB_URL } from '../constants/tzzb-holding.constants.ts';
import type { TzzbStockTrade } from '../types/tzzb.types.ts';

/**
 * stock-board.db 投资账本持仓流水出口（tzzb_holding_trade 表，2026-11-17 新增）
 *
 * 职责与 `board-calendar-db.api.ts` 同款：
 * - 持有 `sqlite:stock-board.db` 连接单例（建表在 Rust 侧 migration V11，见
 *   src-tauri/src/lib.rs 的 STOCK_BOARD_DB_V11）；
 * - 蛇形行 → TzzbStockTrade 的映射边界；
 * - 浏览器端降级：非 Tauri 环境一律返回 null / no-op，调用方回落 localStorage 缓存。
 *
 * 约束：业务代码不允许绕过本文件直接 `load()` stock-board.db（board / account-records
 * 模块各自持有自己的出口文件，本模块同口径）。
 */

/** 连接单例（Database.load 自带插件 migration，建表在 Rust 侧） */
let dbPromise: Promise<Database> | null = null;

/** 单条 SQL 的最大行数（多值 INSERT 分块大小，控制占位符总数） */
const INSERT_CHUNK_ROWS = 100;

/** DB 原始行（蛇形列，类型宽松） */
type Row = Record<string, unknown>;

/**
 * 行取值兜底（字符串）
 * @param v DB 原始值
 * @returns 字符串值
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 行取值兜底（数值，空值按 0）
 * @param v DB 原始值
 * @returns 数值
 */
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/**
 * 获取 stock-board.db 连接（懒加载单例）
 * @returns 连接实例；浏览器端（非 Tauri）为 null
 */
const getTzzbHoldingDb = async (): Promise<Database | null> => {
  if (!isTauri()) {
    return null;
  }
  if (dbPromise === null) {
    const created = Database.load(TZZB_HOLDING_DB_URL);
    dbPromise = created;
    // 首次连接失败时清空单例，允许后续重试（否则全部调用都会命中已 reject 的 Promise）
    created.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
};

/**
 * 生成多值 INSERT 的 VALUES 占位符片段
 * @param rowCount 行数
 * @param colCount 每行列数
 * @returns 形如 `($1,$2),($3,$4)` 的片段
 */
const buildValuesClause = (rowCount: number, colCount: number): string => {
  const groups: string[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const slots: string[] = [];
    for (let c = 0; c < colCount; c += 1) {
      slots.push(`$${r * colCount + c + 1}`);
    }
    groups.push(`(${slots.join(',')})`);
  }
  return groups.join(',');
};

/**
 * 数组分块
 * @param items 原始数组
 * @param size 每块大小
 * @returns 分块后的二维数组
 */
const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

/**
 * tzzb_holding_trade 行 → TzzbStockTrade
 * @param r DB 原始行
 * @returns 股票流水
 */
const toTrade = (r: Row): TzzbStockTrade => ({
  date: str(r.trade_date),
  code: str(r.code),
  name: str(r.name),
  action: str(r.action),
  price: num(r.price),
  quantity: num(r.quantity),
  amount: num(r.amount),
  commission: num(r.commission),
  transferFee: num(r.transfer_fee),
  feeTotal: num(r.fee_total),
});

/**
 * 读取某账户范围的持仓回放全历史流水（按成交日期 + 入库行序升序）
 * @param scope 账户范围口径 key（'all' = 汇总 / 单账户 id / 多选 id 逗号拼接）
 * @returns 全历史流水；浏览器端（非 Tauri）返回 null（调用方回落 localStorage）
 */
export const loadTzzbHoldingTradesFromDb = async (
  scope: string,
): Promise<TzzbStockTrade[] | null> => {
  const db = await getTzzbHoldingDb();
  if (!db) return null;
  const rows = await db.select<Row[]>(
    'SELECT * FROM tzzb_holding_trade WHERE scope = $1 ORDER BY trade_date, id',
    [scope],
  );
  return rows.map(toTrade);
};

/**
 * 读取某账户范围库内最新成交日（增量拉取的起点；边界日整日重拉捕捉同日新增成交）
 * @param scope 账户范围口径 key
 * @returns 最新成交日（YYYY-MM-DD）；无库 / 该口径无数据返回 null
 */
export const getTzzbHoldingLastTradeDateFromDb = async (
  scope: string,
): Promise<string | null> => {
  const db = await getTzzbHoldingDb();
  if (!db) return null;
  const rows = await db.select<Row[]>(
    'SELECT MAX(trade_date) AS last_date FROM tzzb_holding_trade WHERE scope = $1',
    [scope],
  );
  const value = str(rows[0]?.last_date);
  return value.length > 0 ? value : null;
};

/**
 * 增量合并流水入某账户范围（INSERT OR IGNORE：唯一约束八元组去重，
 * 边界日整日重拉的既有行不重复入库）
 * @param scope 账户范围口径 key
 * @param trades 待合并流水（增量段）
 * @returns 实际新增行数（0 = 全部已存在 / 无库 / 空入参）
 */
export const saveTzzbHoldingTradesToDb = async (
  scope: string,
  trades: readonly TzzbStockTrade[],
): Promise<number> => {
  const db = await getTzzbHoldingDb();
  if (!db || trades.length === 0) return 0;
  const syncedAt = Date.now();
  let inserted = 0;
  for (const part of chunk(trades, INSERT_CHUNK_ROWS)) {
    const sql =
      `INSERT OR IGNORE INTO tzzb_holding_trade ` +
      `(scope, trade_date, code, name, action, price, quantity, amount, commission, transfer_fee, fee_total, synced_at) ` +
      `VALUES ${buildValuesClause(part.length, 12)}`;
    const result = await db.execute(
      sql,
      part.flatMap((t) => [
        scope,
        t.date,
        t.code,
        t.name,
        t.action,
        t.price,
        t.quantity,
        t.amount,
        t.commission,
        t.transferFee,
        t.feeTotal,
        syncedAt,
      ]),
    );
    inserted += result.rowsAffected ?? 0;
  }
  return inserted;
};
