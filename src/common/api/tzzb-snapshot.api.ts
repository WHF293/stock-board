import dayjs from 'dayjs';
import {
  fetchTzzbAllStockTrades,
  getTzzbAssetChange,
  getTzzbClearedPositions,
  getTzzbDayCalendar,
  getTzzbFundCycles,
  getTzzbFundHoldingReturns,
  getTzzbFundTrades,
  getTzzbMonthCalendar,
  getTzzbPnlSummary,
  getTzzbPositionSummary,
  getTzzbSyncMeta,
  getTzzbYearPoints,
} from './tzzb.api.ts';
import type { TzzbScopeSnapshot } from '../types/tzzb.types.ts';

/**
 * 投资账本账户口径快照拉取（12 任务组合）
 *
 * 供看板手动同步（loadAll）与打开软件自动增量同步共用同一套任务清单，
 * 单任务失败不影响其余（allSettled，失败字段缺省由调用方保留旧值）。
 * 原清单散落在 TzzbDashboard.loadAll，2026-11-11 为支撑启动自动同步收敛至此。
 */

/** 快照数据字段（不含 UI 口径字段 range / customFrom / customTo 与 fetchedAt） */
export type TzzbSnapshotData = Omit<
  TzzbScopeSnapshot,
  'range' | 'customFrom' | 'customTo' | 'fetchedAt'
>;

/** 拉取结果（data 仅含成功任务字段；errors 原样透出供 401 识别与失败通知） */
export interface TzzbSnapshotFetchResult {
  /** 成功任务的数据（字段缺省 = 该任务失败） */
  data: Partial<TzzbSnapshotData>;
  /** 失败任务抛出的错误（顺序与任务清单无关） */
  errors: unknown[];
}

/** 任务总数（进度条分母；与下方 allSettled 任务数保持一致） */
export const TZZB_SNAPSHOT_TASK_TOTAL = 12;

/**
 * 拉取当前账户范围的全部模块数据并组装快照数据段
 *
 * 账户范围由 tzzb.api 的 setTzzbAccountScope 决定（调用方先行设置）；
 * 资产曲线按传入 range 取数（与看板页签口径一致）
 * @param range 资产曲线区间（TZZB_RANGE_OPTIONS value）
 * @param opts 可选项
 * @param opts.onTaskDone 单任务完成回调（成功失败都触发，进度条推进用）
 * @returns 成功字段 + 失败错误列表
 */
export const fetchTzzbScopeSnapshot = async (
  range: string,
  opts: { onTaskDone?: () => void } = {},
): Promise<TzzbSnapshotFetchResult> => {
  const bump = (): void => opts.onTaskDone?.();
  const results = await Promise.allSettled([
    getTzzbSyncMeta().finally(bump),
    // 按当前选中的区间取数（默认 m1）：切账户整拉时页签可能停在非默认区间，
    // 取默认区间会导致曲线与页签口径不一致（2026-11-10 王总反馈）
    getTzzbPnlSummary(range).finally(bump),
    getTzzbPositionSummary().finally(bump),
    getTzzbAssetChange().finally(bump),
    getTzzbDayCalendar(dayjs().format('YYYYMM')).finally(bump),
    getTzzbMonthCalendar(dayjs().format('YYYY')).finally(bump),
    getTzzbYearPoints([dayjs().format('YYYY'), dayjs().subtract(1, 'year').format('YYYY')]).finally(bump),
    getTzzbClearedPositions().finally(bump),
    getTzzbFundHoldingReturns().finally(bump),
    getTzzbFundCycles().finally(bump),
    fetchTzzbAllStockTrades().finally(bump),
    getTzzbFundTrades(dayjs().format('YYYY-MM')).finally(bump),
  ]);
  const [meta, pnlR, posR, chgR, dayR, monR, yearR, clrR, fundRetR, fundCycR, tradeR, fundTradeR] =
    results;
  const data: Partial<TzzbSnapshotData> = {};
  const errors: unknown[] = [];
  const ok = <T>(r: PromiseSettledResult<T>, assign: (v: T) => void): void => {
    if (r.status === 'fulfilled') assign(r.value);
    else errors.push(r.reason);
  };
  ok(meta, (v) => {
    data.syncMeta = v;
  });
  ok(pnlR, (v) => {
    data.pnl = v;
  });
  ok(posR, (v) => {
    data.position = v;
  });
  ok(chgR, (v) => {
    data.assetChange = v;
  });
  ok(dayR, (v) => {
    data.dayCal = v;
  });
  ok(monR, (v) => {
    data.monthCal = v;
  });
  ok(yearR, (v) => {
    data.yearPoints = v;
  });
  ok(clrR, (v) => {
    data.cleared = v;
  });
  ok(fundRetR, (v) => {
    data.fundReturns = v;
  });
  ok(fundCycR, (v) => {
    data.fundCycles = v;
  });
  // 摩擦账本口径：首页分页结构里的 list 已合并全量页
  ok(tradeR, (v) => {
    data.stockTrades = v;
    data.allStockTrades = v?.list ?? null;
  });
  ok(fundTradeR, (v) => {
    data.fundTrades = v;
  });
  return { data, errors };
};
