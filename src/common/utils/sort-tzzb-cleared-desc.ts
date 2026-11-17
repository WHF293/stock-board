import type { TzzbClearedPosition } from '../types/tzzb.types.ts';

/**
 * 建清仓记录按「最新事件日期」降序排列（2026-11-17 王总指定：最新记录显示在最上面）
 *
 * 排序键 = 清仓日（持有中回退开仓日），同日按开仓日降序稳定区分；
 * 不改入参顺序（纯拷贝排序，快照回放等消费方原数组不受影响）
 * @param rows 建清仓记录（上游原始顺序，按开仓日升序）
 * @returns 降序排列后的新数组
 */
export const sortTzzbClearedDesc = (rows: readonly TzzbClearedPosition[]): TzzbClearedPosition[] =>
  [...rows].sort((a, b) => {
    const keyA = a.closeDate ?? a.openDate;
    const keyB = b.closeDate ?? b.openDate;
    if (keyA !== keyB) return keyB.localeCompare(keyA);
    return b.openDate.localeCompare(a.openDate);
  });
