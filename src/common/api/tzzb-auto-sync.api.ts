import dayjs from 'dayjs';
import { NOTIFY_TONE } from '../constants/notify.constants.ts';
import {
  TZZB_AUTO_SYNC_STORAGE_KEY,
  TZZB_CLOSE_NODE_HOUR,
  TZZB_CLOSE_NODE_MINUTE,
  TZZB_CUSTOM_RANGE_DEFAULT_FROM,
  TZZB_CUSTOM_RANGE_DEFAULT_TO,
  TZZB_SCOPE_KEY_ALL,
} from '../constants/tzzb-sync.constants.ts';
import { useNotificationsStore } from '../stores/notifications';
import { useTzzbScopeCacheStore } from '../stores/tzzb-scope-cache';
import type { TzzbScopeSnapshot } from '../types/tzzb.types.ts';
import { getTzzbSelectedAccountIds, setTzzbAccountScope } from './tzzb.api.ts';
import { fetchTzzbScopeSnapshot } from './tzzb-snapshot.api.ts';

/**
 * 投资账本自动增量同步（打开软件后台静默补拉，2026-11-11 王总指定实装）
 *
 * 增量口径：上游 MCP 无真增量接口（数据全部按区间重算），本地以「收盘节点水位」
 * 判定是否需要拉取——水位未越过最近收盘节点（当日 15:30 后 / 次日开盘前各一档）
 * 不重复拉取；越过（新交易日收盘定稿后首次打开软件）才对已选账户做一次后台静默
 * 同步，快照写回口径缓存供账户分析页秒开。
 *
 * 失败语义：任一任务失败不覆盖旧快照（保留可用缓存）、不推水位（下次打开重试）；
 * 授权过期（401）不自动拉浏览器重授（启动场景不打扰），仅浮窗提示进页面处理。
 */

/** 同步水位（localStorage 持久化；lastSyncDate 仅作展示辅助） */
interface TzzbAutoSyncWatermark {
  /** 最近一次完整同步完成时间（毫秒） */
  lastSyncAt: number;
  /** 最近一次完整同步完成日期 yyyy-MM-dd */
  lastSyncDate: string;
}

/** 启动自动同步结果 */
export interface TzzbAutoSyncResult {
  /** skipped = 水位未越过收盘节点 / 从未确认同步账户；synced = 已补拉；failed = 拉取失败 */
  status: 'skipped' | 'synced' | 'failed';
  /** 跳过 / 失败原因（synced 时为空串） */
  reason: string;
  /** 本次同步覆盖的账户数（skipped 时为 0） */
  accountCount: number;
}

/**
 * 读取自动同步水位
 * @returns 水位；从未同步过返回 null
 */
export const getTzzbAutoSyncWatermark = (): TzzbAutoSyncWatermark | null => {
  try {
    const raw = localStorage.getItem(TZZB_AUTO_SYNC_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lastSyncAt?: number; lastSyncDate?: string };
    return typeof parsed.lastSyncAt === 'number' && parsed.lastSyncAt > 0
      ? { lastSyncAt: parsed.lastSyncAt, lastSyncDate: String(parsed.lastSyncDate ?? '') }
      : null;
  } catch {
    return null;
  }
};

/**
 * 最近一个已定稿的收盘节点（毫秒）
 *
 * 当日 15:30 之后 = 今天 15:30；之前 = 昨天 15:30（周末自然回退到上一交易日附近，
 * 非交易日打开若水位已覆盖周五收盘节点则跳过，不产生无效拉取）
 * @returns 收盘节点毫秒时间戳
 */
export const getTzzbCloseNodeMs = (): number => {
  const now = dayjs();
  const todayNode = now
    .hour(TZZB_CLOSE_NODE_HOUR)
    .minute(TZZB_CLOSE_NODE_MINUTE)
    .second(0)
    .millisecond(0);
  return now.isBefore(todayNode) ? todayNode.subtract(1, 'day').valueOf() : todayNode.valueOf();
};

/**
 * 是否需要自动增量同步（水位落后最近收盘节点 = 有未拉取的定稿数据）
 * @returns true = 需要同步
 */
export const isTzzbAutoSyncDue = (): boolean => {
  const watermark = getTzzbAutoSyncWatermark();
  return (watermark?.lastSyncAt ?? 0) < getTzzbCloseNodeMs();
};

/**
 * 推进同步水位（看板手动同步全量成功后与自动同步成功后调用）
 */
export const markTzzbSynced = (): void => {
  try {
    localStorage.setItem(
      TZZB_AUTO_SYNC_STORAGE_KEY,
      JSON.stringify({ lastSyncAt: Date.now(), lastSyncDate: dayjs().format('YYYY-MM-DD') }),
    );
  } catch {
    /* 存储满 / 隐私模式：水位丢失仅导致下次打开多拉一次，静默降级 */
  }
};

/** 运行单飞（启动钩子 / 菜单入口并发只跑一次） */
let runningPromise: Promise<TzzbAutoSyncResult> | null = null;

/**
 * 执行一轮自动增量同步（内部实现）
 * @param opts 可选项
 * @param opts.force true = 忽略水位强制拉取
 * @param opts.notify true = 结果浮窗通知（成功 / 失败）
 * @returns 同步结果
 */
const run = async (opts: { force?: boolean; notify?: boolean } = {}): Promise<TzzbAutoSyncResult> => {
  const selected = getTzzbSelectedAccountIds();
  // 从未确认过同步账户（新用户 / 首次流程未走完）：交给账户分析页的首次勾选流程
  if (selected === null) {
    return { status: 'skipped', reason: '从未确认同步账户', accountCount: 0 };
  }
  if (!opts.force && !isTzzbAutoSyncDue()) {
    return { status: 'skipped', reason: '水位未越过最近收盘节点', accountCount: 0 };
  }
  const notifications = useNotificationsStore();
  const cacheStore = useTzzbScopeCacheStore();
  cacheStore.hydrate();
  // 数据层账户范围 = 用户勾选的同步账户（空集合 = 全部）
  setTzzbAccountScope(selected.length > 0 ? selected : null);
  // 沿用缓存快照的曲线区间口径（不丢用户上次页签选择）
  const base = cacheStore.get(TZZB_SCOPE_KEY_ALL);
  const { data, errors } = await fetchTzzbScopeSnapshot(base?.range ?? 'm1');
  if (errors.length > 0) {
    // 部分失败：不覆盖旧快照（保留可用缓存）、不推水位（下次打开重试）
    const message = String(errors[0]).replace(/^Error:\s*/, '');
    if (opts.notify) {
      notifications.push({
        title: '投资账本自动增量同步失败',
        body: `${message}；打开账户分析页可查看详情或重新授权`,
        tone: NOTIFY_TONE.DOWN,
      });
    }
    return { status: 'failed', reason: message, accountCount: selected.length };
  }
  const snapshot: TzzbScopeSnapshot = {
    syncMeta: null,
    pnl: null,
    position: null,
    assetChange: null,
    dayCal: null,
    monthCal: null,
    yearPoints: [],
    cleared: [],
    fundReturns: [],
    fundCycles: [],
    stockTrades: null,
    allStockTrades: null,
    fundTrades: [],
    range: base?.range ?? 'm1',
    customFrom: base?.customFrom ?? TZZB_CUSTOM_RANGE_DEFAULT_FROM,
    customTo: base?.customTo ?? TZZB_CUSTOM_RANGE_DEFAULT_TO,
    fetchedAt: Date.now(),
    ...data,
  };
  cacheStore.save(TZZB_SCOPE_KEY_ALL, snapshot);
  markTzzbSynced();
  if (opts.notify) {
    notifications.push({
      title: '投资账本已自动增量同步',
      body: `已选 ${selected.length} 个账户的数据已更新至最新收盘（打开软件自动执行）`,
      tone: NOTIFY_TONE.FLAT,
    });
  }
  return { status: 'synced', reason: '', accountCount: selected.length };
};

/**
 * 自动增量同步入口（单飞；打开软件启动钩子与菜单入口共用）
 * @param opts 可选项
 * @param opts.force true = 忽略水位强制拉取
 * @param opts.notify true = 结果浮窗通知（成功 / 失败；跳过不弹）
 * @returns 同步结果
 */
export const runTzzbAutoSync = (
  opts: { force?: boolean; notify?: boolean } = {},
): Promise<TzzbAutoSyncResult> => {
  if (runningPromise) return runningPromise;
  runningPromise = run(opts).finally(() => {
    runningPromise = null;
  });
  return runningPromise;
};
