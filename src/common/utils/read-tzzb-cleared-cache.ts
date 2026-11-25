import { TZZB_SCOPE_CACHE_STORAGE_KEY } from '../constants/tzzb-sync.constants.ts';
import type { TzzbClearedPosition } from '../types/tzzb.types.ts';

/** 清仓记录最小形态（幽灵持仓过滤只需 code + closeDate） */
export interface TzzbClearedCacheRow {
  /** 证券代码（6 位） */
  code: string;
  /** 清仓日期 YYYY-MM-DD；null = 持有中 */
  closeDate: string | null;
}

/**
 * 从账户口径快照缓存（tzzb.scopeCache.v1，localStorage）读出清仓记录
 *
 * 账户分析页每次拉全量 / 自动增量同步都会把含 `cleared`（queryClearedPosition
 * 结果）的快照落进该缓存——这里只读 localStorage，**绝不触发上游同步**，供
 * 「绝不发上游请求」的页面（如自选股账本联动分组）复用幽灵持仓过滤。
 * 多口径快照间同代码冗余：优先保留已清仓（closeDate 非空）那条
 * @returns 去重后的清仓记录列表；缓存不存在 / 坏数据返回空数组
 */
export const readTzzbClearedCache = (): TzzbClearedCacheRow[] => {
  const merged = new Map<string, string | null>();
  try {
    const raw = localStorage.getItem(TZZB_SCOPE_CACHE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      entries?: [string, { cleared?: TzzbClearedPosition[] | null }][];
    };
    for (const snapshot of parsed.entries ?? []) {
      for (const row of snapshot?.[1]?.cleared ?? []) {
        if (typeof row?.code !== 'string' || row.code === '') continue;
        const known = merged.get(row.code);
        if (known === undefined || (known === null && row.closeDate !== null)) {
          merged.set(row.code, row.closeDate);
        }
      }
    }
  } catch {
    return [];
  }
  return [...merged.entries()].map(([code, closeDate]) => ({ code, closeDate }));
};
