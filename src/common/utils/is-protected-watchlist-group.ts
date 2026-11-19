import { WATCHLIST_PROTECTED_GROUP_IDS } from '../constants/watchlist.constants.ts';

/**
 * 判断分组 id 是否为受保护分组（默认组 + 两个账本联动组）
 *
 * 保护语义见 `WATCHLIST_PROTECTED_GROUP_IDS`：不可重命名、不可删除、
 * 不可手工增删个股；分组设置里仍可拖动位置与勾选显隐
 * @param groupId 分组 id
 * @returns 是否受保护
 */
export const isProtectedWatchlistGroup = (groupId: string): boolean =>
  WATCHLIST_PROTECTED_GROUP_IDS.includes(groupId);
