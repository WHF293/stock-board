<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import dayjs from 'dayjs';
import NoticeBar from '../../ui/NoticeBar.vue';
import BaseCard from '../../ui/BaseCard.vue';
import BaseSkeleton from '../../ui/BaseSkeleton.vue';
import BaseTabs from '../../ui/BaseTabs.vue';
import MenuIcon from '../../ui/MenuIcon.vue';
import { ROUTE_PATH } from '../../../../common/constants/router-meta.constants.ts';
import { HOST_HEADER_ITEM } from '../../../../common/constants/header.constants.ts';
import { NOTIFY_TONE } from '../../../../common/constants/notify.constants.ts';
import { useSettingsStore } from '../../../../common/stores/settings';
import { useNotificationsStore } from '../../../../common/stores/notifications';
import { useTzzbAnalysisStore } from '../../../../common/stores/tzzb-analysis';
import { requestAgentAnalysis } from '../../../agent/agent-bridge';
import { buildAssetCurveAnalysisPrompt } from '../../../../common/utils/build-asset-curve-analysis-prompt';
import { buildClearedPositionAnalysisPrompt } from '../../../../common/utils/build-cleared-position-analysis-prompt';
import { openExternalUrl } from '../../../../common/utils/open-external-url';
import { findMaxDrawdown } from '../../../../common/utils/find-max-drawdown';
import type { RankDataset } from '../../../../common/types/rank-dataset.types';
import {
  clearTzzbMcpAuth,
  fetchAuthorizedAt,
  getTzzbAccounts,
  getTzzbAssetChange,
  getTzzbClearedPositions,
  getTzzbDayCalendar,
  getTzzbFundCycles,
  getTzzbFundHoldingReturns,
  fetchTzzbAllStockTrades,
  getTzzbFundTrades,
  getTzzbMonthCalendar,
  getTzzbPnlSummary,
  getTzzbPositionSummary,
  getTzzbSelectedAccountIds,
  getTzzbStockTrades,
  getTzzbSyncMeta,
  getTzzbYearPoints,
  refreshTzzbAccounts,
  setTzzbAccountScope,
  setTzzbSelectedAccountIds,
  startTzzbMcpAuth,
  waitTzzbMcpAuthorized,
} from '../../../../common/api/tzzb.api.ts';
import { useRouter } from 'vue-router';
import { useStockOpen } from '../../../../common/composables/use-stock-open';
import type {
  TzzbAccount,
  TzzbAssetChange,
  TzzbClearedPosition,
  TzzbDayCalendar,
  TzzbFundCycle,
  TzzbFundTrade,
  TzzbHoldingReturn,
  TzzbMonthCalendar,
  TzzbPnlSummary,
  TzzbPositionSummary,
  TzzbStockTrade,
  TzzbStockTradePage,
  TzzbSyncMeta,
  TzzbYearPoint,
} from '../../../../common/types/tzzb.types.ts';
import { TZZB_RANGE_LABEL } from '../../../../common/types/tzzb.types.ts';
import TzzbTopbar from './TzzbTopbar.vue';
import TzzbAccountSelectModal from './TzzbAccountSelectModal.vue';
import TzzbErrorDetailModal from './TzzbErrorDetailModal.vue';
import TzzbMetricRow from './TzzbMetricRow.vue';
import TzzbAssetPanel from './TzzbAssetPanel.vue';
import TzzbAssetChangeCard from './TzzbAssetChangeCard.vue';
import TzzbProfitCalendar from './TzzbProfitCalendar.vue';
import TzzbClearedPanel from './TzzbClearedPanel.vue';
import TzzbClearedAnalysis from './TzzbClearedAnalysis.vue';
import TzzbKindRank from './TzzbKindRank.vue';
import TzzbTradeRecords from './TzzbTradeRecords.vue';
import TzzbFeeLedger from './TzzbFeeLedger.vue';
import TzzbBehaviorDiag from './TzzbBehaviorDiag.vue';

/**
 * 投资账本数据中心（账户分析页主体）
 *
 * 数据流：tzzb.api（当前 mock 传输）→ 本容器分发六大模块组件；
 * 切换账户 / 翻页 / 日历下钻在此统一重拉。mock 采样只覆盖「whf-东北」，
 * 切换其他账户时展示空态（正式接入后按账户维度重拉）。
 */
const router = useRouter();
const { openSidebar } = useStockOpen();

/* ---------------- 状态 ---------------- */

const accounts = ref<TzzbAccount[]>([]);
const selectedId = ref('');
const syncMeta = ref<TzzbSyncMeta | null>(null);
const syncing = ref(false);
const loading = ref(true);

/* ---------------- 同步账户勾选（多选确认，2026-11-10 王总指定） ---------------- */

/** 用户勾选的同步账户 id 集合（确认后持久化，后续取数只覆盖这些账户） */
const selectedSyncIds = ref<string[]>([]);

/** 勾选弹窗开关 */
const pickerOpen = ref(false);

/** 是否首次确认（true = 首次拉到账户后的强制确认环节，确认前不拉数据） */
const pickerFirst = ref(false);

/** 更新账户列表进行中（菜单防重入） */
const refreshingAccounts = ref(false);

/* ---------------- 错误详情弹窗（浮窗点击 → 查看服务端完整报错） ---------------- */

/** 详情弹窗开关 */
const errorDetailOpen = ref(false);

/** 当前展示的完整报错（title 同通知标题；detail 为服务端保留信息原样文本） */
const errorDetail = ref<{ title: string; detail: string }>({ title: '', detail: '' });

/**
 * 弹错误通知（点击浮窗打开完整报错弹窗；2026-11-10 王总指定交互）
 * @param title 通知标题
 * @param body 通知正文（摘要）
 * @param detail 完整报错文本（服务端响应体 / 异常消息原样）
 * @param tone 通知语气（默认 DOWN）
 */
const notifyError = (
  title: string,
  body: string,
  detail: string,
  tone: (typeof NOTIFY_TONE)[keyof typeof NOTIFY_TONE] = NOTIFY_TONE.DOWN,
): void => {
  notifications.push({
    title,
    body,
    tone,
    onClick: () => {
      errorDetail.value = { title, detail };
      errorDetailOpen.value = true;
    },
  });
};

/** 数据初始化完成标记（首次勾选确认后由 skeleton 拉取，后续静默） */
let dataInitialized = false;

/** 顶栏账户可选列表 = 用户勾选的同步账户（未确认勾选前展示全量） */
const visibleAccounts = computed(() =>
  selectedSyncIds.value.length > 0
    ? accounts.value.filter((a) => selectedSyncIds.value.includes(a.id))
    : accounts.value,
);

/**
 * 勾选裁剪：剔除已不存在的账户 id（上游账户被删除后自动收缩勾选）
 * @param saved 已持久化的勾选集合
 * @param list 最新账户列表
 * @returns 裁剪后的勾选集合（空列表时返回 null = 全部）
 */
const pruneSelection = (saved: string[], list: TzzbAccount[]): string[] | null => {
  const ids = new Set(list.map((a) => a.id));
  const kept = saved.filter((id) => ids.has(id));
  if (kept.length === 0) return list.length > 0 ? list.map((a) => a.id) : null;
  return kept;
};

/**
 * 应用勾选范围到数据层（空集合 = 全部账户）
 * @param ids 勾选账户 id 集合
 */
const applySelection = (ids: string[]): void => {
  selectedSyncIds.value = ids;
  setTzzbAccountScope(ids.length > 0 ? ids : null);
  // 当前聚焦账户不在新勾选集合内时回落到全部同步账户
  if (selectedId.value && !ids.includes(selectedId.value)) selectedId.value = '';
};

/**
 * 账户列表补拉（缓存优先；列表已有数据时秒回不耗上游配额）
 *
 * 触发点：页面挂载（initAccounts）/ 手动同步前列表为空 / 授权成功后的自动同步——
 * 挂载时可能尚未授权导致首次拉取失败，授权成功后必须补拉，否则账户永远为空
 * （2026-11-10 实测 0/0 缺口）。拉到新账户时的勾选处理：
 * - 从未确认过勾选 → 弹首次确认弹窗（默认全选，确认前不拉数据）；
 * - 已有勾选记录 → 裁剪失效账户并持久化
 */
const ensureAccounts = async (): Promise<void> => {
  if (accounts.value.length > 0) return;
  let list: TzzbAccount[];
  try {
    list = await getTzzbAccounts();
  } catch {
    // 拉取失败（未授权 / 网络等）：不阻塞后续同步，下次同步再补
    return;
  }
  if (list.length === 0) return;
  accounts.value = list;
  const saved = getTzzbSelectedAccountIds();
  if (saved === null) {
    pickerFirst.value = true;
    pickerOpen.value = true;
    return;
  }
  const pruned = pruneSelection(saved, list);
  if (pruned) {
    applySelection(pruned);
    setTzzbSelectedAccountIds(pruned);
  }
};

/**
 * 启动初始化：账户列表缓存优先（localStorage → 内存 → 首次网络）；
 * 首次拉到账户会弹勾选确认（等待用户确认后再拉数据），其余情况拉数据。
 * 恢复上次聚焦口径：账户仍存在且其快照在本地缓存中 → 秒开 + 静默后台刷新一次
 */
const initAccounts = async (): Promise<void> => {
  hydrateScopeCache();
  await ensureAccounts();
  if (pickerOpen.value) return;
  dataInitialized = true;
  const last = persistedLastScope;
  if (last && last !== scopeKey() && (last === 'all' || accounts.value.some((a) => a.id === last))) {
    selectedId.value = last === 'all' ? '' : last;
    applyAccountScope();
  }
  const hit = scopeCache.get(scopeKey());
  if (hit) {
    applyScope(hit);
    // 缓存命中走 silent 分支（不改 loading），必须手动关骨架屏
    loading.value = false;
    void loadAll('silent', { quiet: true });
    return;
  }
  void loadAll();
};

/**
 * 勾选确认：持久化 + 应用范围 + 重拉数据（首次 skeleton / 后续静默）
 * @param ids 确认的账户 id 集合
 */
const onPickerConfirm = (ids: string[]): void => {
  pickerFirst.value = false;
  applySelection(ids);
  setTzzbSelectedAccountIds(ids);
  const first = !dataInitialized;
  dataInitialized = true;
  syncing.value = true;
  void loadAll(first ? 'skeleton' : 'silent').finally(() => {
    syncing.value = false;
  });
};

// 首次确认被取消（ESC / 遮罩 / 取消按钮）：不卡骨架屏，按全部账户继续拉数据
watch(pickerOpen, (open, prev) => {
  if (!open && prev && pickerFirst.value) {
    pickerFirst.value = false;
    if (!dataInitialized) {
      dataInitialized = true;
      void loadAll();
    }
  }
});

/**
 * 打开勾选弹窗（菜单「选择同步账户」；默认勾选当前生效集合）
 */
const onSelectAccounts = (): void => {
  pickerFirst.value = false;
  pickerOpen.value = true;
};

/**
 * 更新账户列表（菜单「更新账户列表」）：绕过缓存重拉上游并落盘，
 * 勾选裁剪失效账户后同步生效；从未确认过勾选时直接进首次确认流程
 */
const onRefreshAccounts = async (): Promise<void> => {
  if (refreshingAccounts.value) return;
  refreshingAccounts.value = true;
  try {
    const list = await refreshTzzbAccounts();
    if (list.length === 0) {
      // 上游返回空列表（授权失效等）：不弹空弹窗，浮窗说明
      notifications.push({
        title: '未拉到任何账户',
        body: '账户列表为空，请确认已完成授权后重试；若同步有报错请点浮窗查看上游原文',
        tone: NOTIFY_TONE.DOWN,
      });
      return;
    }
    accounts.value = list;
    const saved = getTzzbSelectedAccountIds();
    if (saved === null) {
      pickerFirst.value = true;
      pickerOpen.value = true;
      return;
    }
    const pruned = pruneSelection(saved, list);
    if (pruned) {
      applySelection(pruned);
      setTzzbSelectedAccountIds(pruned);
    }
    notifications.push({
      title: '账户列表已更新',
      body: `共 ${list.length} 个账户，同步范围 ${pruned?.length ?? 0} 个（缓存已刷新）`,
      tone: NOTIFY_TONE.UP,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (UPSTREAM_401_PATTERN.test(message)) {
      // 授权过期（refresh 被上游拒绝）：转入自动重授权流程
      void autoReauthOn401();
      return;
    }
    notifyError('账户列表更新失败', message, message);
  } finally {
    refreshingAccounts.value = false;
  }
};

/** 交易记录页签（股票流水 / 基金流水；历史导入页签已删） */
const TRADE_TAB_OPTIONS = [
  { label: '股票流水', value: 'stock' },
  { label: '基金流水', value: 'fund' },
];
const tradeTab = ref('stock');

/**
 * 聚焦账户的类别（null = 汇总口径，王总 2026-11-10 指定）
 *
 * 顶栏选中单账户时驱动下方各模块自动切到对应类别：股票类账户
 * （stock / rzrq / manual）→ 股票，基金类账户 → 基金；
 * 汇总（全部同步账户）时为 null，各模块隐藏股票/基金切换并平铺两类内容
 */
const focusKind = computed<'stock' | 'fund' | null>(() => {
  if (!selectedId.value) return null;
  const acc = accounts.value.find((a) => a.id === selectedId.value);
  if (!acc) return null;
  return acc.kind === 'fund' ? 'fund' : 'stock';
});

// 聚焦单账户 → 交易记录页签自动切到对应类别（汇总时页签整体隐藏、两类平铺）
watch(focusKind, (k) => {
  if (k) tradeTab.value = k;
});

const pnl = ref<TzzbPnlSummary | null>(null);
const position = ref<TzzbPositionSummary | null>(null);

/** 资产曲线区间（父级持有；切换时重拉 queryPnlSummary，指标行区间盈亏 / 对比沪深300 联动） */
const range = ref<string>('m1');
/** 自定义区间起止（range = custom 时生效） */
const customFrom = ref('2026-09-01');
const customTo = ref('2026-10-23');

/** 区间展示名（指标行「区间盈亏」副标题用） */
const rangeLabel = computed(() => TZZB_RANGE_LABEL[range.value] ?? '本月');

/** 快照恢复中标记（恢复的 range 赋值会让下方 watcher 误触发重拉，恢复窗口内跳过） */
let applyingSnapshot = false;

/** 区间变化 → 重拉资产曲线汇总（失败浮窗提示，成功静默替换；旧数据保留避免闪空） */
watch([range, customFrom, customTo], ([r, from, to]) => {
  if (applyingSnapshot) return;
  if (r !== 'custom' || (from && to)) {
    void getTzzbPnlSummary(r).then((v) => {
      if (v) {
        pnl.value = v;
      } else {
        notifications.push({
          title: '资产曲线区间数据拉取失败',
          body: `「${TZZB_RANGE_LABEL[r] ?? r}」区间数据未更新，仍显示上一区间；请稍后重新同步`,
          tone: NOTIFY_TONE.DOWN,
        });
      }
    });
  }
});

const assetChange = ref<TzzbAssetChange | null>(null);
const dayCal = ref<TzzbDayCalendar | null>(null);
const monthCal = ref<TzzbMonthCalendar | null>(null);
const yearPoints = ref<TzzbYearPoint[]>([]);
const cleared = ref<TzzbClearedPosition[]>([]);
const fundReturns = ref<TzzbHoldingReturn[]>([]);
/** 基金持仓回合（本地由申赎流水重构，长短线维度分析用） */
const fundCycles = ref<TzzbFundCycle[]>([]);
const stockTrades = ref<TzzbStockTradePage | null>(null);
const fundTrades = ref<TzzbFundTrade[]>([]);

/** 摩擦账本全量流水（统计窗口内逐页合并，与交易记录首页共用一次首拉） */
const allStockTrades = ref<TzzbStockTrade[] | null>(null);

/** 最新净值点（当日盈亏口径：assetTrend 最后一个交易日；null = 无曲线数据） */
const lastPoint = computed(() => {
  const trend = pnl.value?.assetTrend ?? [];
  return trend.length > 0 ? trend[trend.length - 1] : null;
});

/* ---------------- 账户口径本地缓存（切换账户秒开，2026-11-10 王总指定） ----------------
 * 每个账户口径（含汇总）拉全量后快照到内存 + localStorage；再次切到该口径直接
 * 回放快照（连资产曲线区间状态一并恢复），不打上游、不进进度条，数据更新走手动同步 */

/**
 * 单个账户口径的数据快照（scopeCache 的值；range / 自定义区间一并快照，
 * 保证「指标行区间盈亏 / 资产曲线」口径与快照数据一致）
 */
interface ScopeSnapshot {
  syncMeta: TzzbSyncMeta | null;
  pnl: TzzbPnlSummary | null;
  position: TzzbPositionSummary | null;
  assetChange: TzzbAssetChange | null;
  dayCal: TzzbDayCalendar | null;
  monthCal: TzzbMonthCalendar | null;
  yearPoints: TzzbYearPoint[];
  cleared: TzzbClearedPosition[];
  fundReturns: TzzbHoldingReturn[];
  fundCycles: TzzbFundCycle[];
  stockTrades: TzzbStockTradePage | null;
  allStockTrades: TzzbStockTrade[] | null;
  fundTrades: TzzbFundTrade[];
  range: string;
  customFrom: string;
  customTo: string;
  fetchedAt: number;
}

/** localStorage 持久化键（含 lastScope，重启后恢复上次聚焦口径） */
const SCOPE_CACHE_STORAGE_KEY = 'tzzb.scopeCache.v1';

/** 缓存条目上限（超出淘汰最旧，防 localStorage 超限） */
const SCOPE_CACHE_MAX = 8;

/** 账户口径缓存（key = 账户 id；'all' = 汇总口径） */
const scopeCache = new Map<string, ScopeSnapshot>();

/** hydrate 时读出的上次聚焦口径（initAccounts 恢复用） */
let persistedLastScope: string | null = null;

/**
 * 当前缓存口径 key
 * @returns 账户 id；'' / 'all' = 汇总口径
 */
const scopeKey = (): string => selectedId.value || 'all';

/**
 * 快照当前口径的全部数据引用（浅拷贝即可：各 ref 整体替换不原地改）
 * @returns 快照对象
 */
const captureScope = (): ScopeSnapshot => ({
  syncMeta: syncMeta.value,
  pnl: pnl.value,
  position: position.value,
  assetChange: assetChange.value,
  dayCal: dayCal.value,
  monthCal: monthCal.value,
  yearPoints: yearPoints.value,
  cleared: cleared.value,
  fundReturns: fundReturns.value,
  fundCycles: fundCycles.value,
  stockTrades: stockTrades.value,
  allStockTrades: allStockTrades.value,
  fundTrades: fundTrades.value,
  range: range.value,
  customFrom: customFrom.value,
  customTo: customTo.value,
  fetchedAt: Date.now(),
});

/**
 * 回放快照到页面状态（含 range / 自定义区间；恢复窗口内屏蔽区间 watcher 的重拉）
 * @param s 目标快照
 */
const applyScope = (s: ScopeSnapshot): void => {
  applyingSnapshot = true;
  syncMeta.value = s.syncMeta;
  pnl.value = s.pnl;
  position.value = s.position;
  assetChange.value = s.assetChange;
  dayCal.value = s.dayCal;
  monthCal.value = s.monthCal;
  yearPoints.value = s.yearPoints;
  cleared.value = s.cleared;
  fundReturns.value = s.fundReturns;
  fundCycles.value = s.fundCycles;
  stockTrades.value = s.stockTrades;
  allStockTrades.value = s.allStockTrades;
  fundTrades.value = s.fundTrades;
  range.value = s.range;
  customFrom.value = s.customFrom;
  customTo.value = s.customTo;
  void nextTick().then(() => {
    applyingSnapshot = false;
  });
};

/**
 * 持久化缓存到 localStorage（含 lastScope；超限 / 坏数据静默放弃，不影响主流程）
 */
const persistScopeCache = (): void => {
  try {
    const entries = [...scopeCache.entries()].slice(-SCOPE_CACHE_MAX);
    localStorage.setItem(
      SCOPE_CACHE_STORAGE_KEY,
      JSON.stringify({ lastScope: scopeKey(), entries }),
    );
  } catch {
    /* 容量超限等：放弃持久化，内存缓存仍生效 */
  }
};

/**
 * 从 localStorage 恢复缓存与上次聚焦口径（坏数据静默忽略）
 */
const hydrateScopeCache = (): void => {
  try {
    const raw = localStorage.getItem(SCOPE_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { lastScope?: string; entries?: [string, ScopeSnapshot][] };
    for (const [k, v] of parsed.entries ?? []) scopeCache.set(k, v);
    persistedLastScope = typeof parsed.lastScope === 'string' ? parsed.lastScope : null;
  } catch {
    /* 坏数据：忽略，走正常网络首载 */
  }
};

/** 数据层账户范围跟随当前聚焦口径（切账户 / 恢复上次口径共用） */
const applyAccountScope = (): void => {
  setTzzbAccountScope(
    selectedId.value
      ? [selectedId.value]
      : selectedSyncIds.value.length > 0
        ? selectedSyncIds.value
        : null,
  );
};

/** 沪深300 区间涨跌幅（指标卡超额对比用） */
const hs300Rate = computed(() => {
  const list = pnl.value?.indexTrend ?? [];
  if (list.length < 2 || list[0].hs300 === 0) return 0;
  return list[list.length - 1].hs300 / list[0].hs300 - 1;
});

/** 区间平均总资产（摩擦账本换手率分母；无曲线数据为 null） */
const avgTotalAsset = computed(() => {
  const trend = pnl.value?.assetTrend ?? [];
  if (trend.length === 0) return null;
  return trend.reduce((sum, point) => sum + point.totalAsset, 0) / trend.length;
});

/* ---------------- 操作复盘生成分析（阶段 3：操作贡献 / 行为诊断共用一份 store 结果） ---------------- */

const analysisStore = useTzzbAnalysisStore();

/** 分析窗口（跟随页面级 range 联动；custom 用起止日期，「全部」不设界） */
const analysisWindow = computed<{ from: string | null; to: string | null }>(() => {
  const today = dayjs();
  const fmt = (d: ReturnType<typeof dayjs>) => d.format('YYYY-MM-DD');
  switch (range.value) {
    case 'm1':
      return { from: fmt(today.startOf('month')), to: fmt(today) };
    case 'm3':
      return { from: fmt(today.subtract(3, 'month')), to: fmt(today) };
    case 'm6':
      return { from: fmt(today.subtract(6, 'month')), to: fmt(today) };
    case 'y1':
      return { from: fmt(today.subtract(1, 'year')), to: fmt(today) };
    case 'ytd':
      return { from: fmt(today.startOf('year')), to: fmt(today) };
    case 'custom':
      return { from: customFrom.value, to: customTo.value };
    default:
      return { from: null, to: null };
  }
});

/**
 * 「生成分析」统一入口（行为诊断卡 / 操作贡献视角共用）
 *
 * store 内做同 key 命中短路（accountId|range|dataDate|流水条数），
 * 重复点击 / 切卡重入不重拉
 */
const onGenerateAnalysis = (): void => {
  void analysisStore.generate({
    accountId: selectedId.value || 'all',
    range: range.value,
    dataDate: syncMeta.value?.dataDate ?? dayjs().format('YYYY-MM-DD'),
    trades: allStockTrades.value ?? [],
    cleared: cleared.value,
    windowFrom: analysisWindow.value.from,
    windowTo: analysisWindow.value.to,
  });
};

/**
 * 自动触发分析：流水就绪后，账户 / 区间 / 数据日 / 流水条数任一变化即自动生成
 * （王总 2026-11-10：行为诊断不再手动点「生成分析」）。store 内同 key 命中短路，
 * 重复触发不重拉；流水未就绪（null）不触发，避免拿空流水生成一份 0 样本结果
 */
watch(
  () =>
    [
      selectedId.value,
      range.value,
      customFrom.value,
      customTo.value,
      syncMeta.value?.dataDate ?? '',
      allStockTrades.value === null ? 'pending' : `ready:${allStockTrades.value.length}`,
    ].join('|'),
  () => {
    if (allStockTrades.value !== null) onGenerateAnalysis();
  },
  { immediate: true },
);

/* ---------------- 模块级 AI 分析（资产曲线 / 清仓分析，图表头右侧 icon） ---------------- */

const settingsStore = useSettingsStore();
const notifications = useNotificationsStore();

/** 「AI 分析」入口跟随顶栏「Agent 分析」条目的显隐开关（设置 → 布局编排 → 右上角工具编排） */
const agentEntryVisible = computed(
  () => !settingsStore.hiddenHeaderItems.includes(HOST_HEADER_ITEM.AGENT),
);

/** 两个入口各自独立防重入 */
const assetAiRunning = ref(false);
const clearedAiRunning = ref(false);

/**
 * 带符号百分数文案（小数口径 → 「+1.23%」）
 * @param rate 小数口径涨跌幅
 * @returns 百分数文案
 */
const signPct = (rate: number): string => `${rate > 0 ? '+' : ''}${(rate * 100).toFixed(2)}%`;

/**
 * 区间指数涨跌（TzzbIndexPoint 首尾比）
 * @param key 指数字段（sh / hs300）
 * @returns 小数口径涨跌；数据不足返回 null
 */
const indexRangeRate = (key: 'sh' | 'hs300'): number | null => {
  const list = pnl.value?.indexTrend ?? [];
  if (list.length < 2 || list[0][key] === 0) return null;
  return list[list.length - 1][key] / list[0][key] - 1;
};

/** 净值序列抽样上限（行数；超出等距抽，保住首尾点） */
const AI_NAV_SAMPLE_MAX_ROWS = 60;

/**
 * 资产曲线数据段（AI 分析口径）：区间概览 + 最大回撤 + 净值序列抽样
 * @returns 数据段列表；无曲线数据返回空数组
 */
const buildAssetDatasets = (): RankDataset[] => {
  const summary = pnl.value;
  if (!summary || summary.assetTrend.length < 2) {
    return [];
  }
  const navStart = summary.assetTrend[0].navIndex;
  const navEnd = summary.assetTrend[summary.assetTrend.length - 1].navIndex;
  const navRate = navStart > 0 ? navEnd / navStart - 1 : 0;
  const hs300 = indexRangeRate('hs300');
  const sh = indexRangeRate('sh');
  const avgPosition =
    summary.assetTrend.reduce((sum, point) => sum + point.positionRatio, 0) /
    summary.assetTrend.length;
  const drawdown = findMaxDrawdown(
    summary.assetTrend.map((point) => ({ date: point.date, value: point.navIndex })),
  );
  const datasets: RankDataset[] = [
    {
      title: '区间概览',
      columns: [
        { label: '区间盈亏(元)', key: 'profit' },
        { label: '区间收益率', key: 'rate' },
        { label: '净值指数(末值,基点1000)', key: 'navEnd' },
        { label: '上证区间涨跌', key: 'shRate' },
        { label: '沪深300区间涨跌', key: 'hs300Rate' },
        { label: '超额收益(vs沪深300)', key: 'excess' },
        { label: '平均仓位', key: 'position' },
        { label: '最大回撤', key: 'dd' },
      ],
      rows: [
        {
          profit: summary.totalProfit,
          rate: signPct(summary.totalRate),
          navEnd,
          shRate: sh === null ? '—' : signPct(sh),
          hs300Rate: hs300 === null ? '—' : signPct(hs300),
          excess: hs300 === null ? '—' : signPct(navRate - hs300),
          position: `${(avgPosition * 100).toFixed(1)}%`,
          dd: drawdown ? `-${(drawdown.depth * 100).toFixed(2)}%` : '无',
        },
      ],
    },
  ];
  if (drawdown) {
    datasets.push({
      title: '最大回撤窗口（谷底后与指数同窗口对照，可判断市场性/个股性回撤）',
      columns: [
        { label: '峰值日期', key: 'peak' },
        { label: '谷底日期', key: 'trough' },
        { label: '回撤深度', key: 'depth' },
        { label: '是否已收复', key: 'recovered' },
      ],
      rows: [
        {
          peak: drawdown.peakDate,
          trough: drawdown.troughDate,
          depth: `-${(drawdown.depth * 100).toFixed(2)}%`,
          recovered: drawdown.recovered ? '是' : '否',
        },
      ],
    });
  }
  // 净值序列等距抽样（保首尾），给模型看形态而不是逐日全量
  const trend = summary.assetTrend;
  const step = Math.max(1, Math.ceil(trend.length / AI_NAV_SAMPLE_MAX_ROWS));
  const sampled = trend.filter(
    (_, index) => index % step === 0 || index === trend.length - 1,
  );
  const indexByDate = new Map(summary.indexTrend.map((point) => [point.date, point]));
  datasets.push({
    title: '净值序列（抽样，含同日指数点位）',
    columns: [
      { label: '日期', key: 'date' },
      { label: '总资产(元)', key: 'asset' },
      { label: '当日盈亏(元)', key: 'daily' },
      { label: '净值指数', key: 'nav' },
      { label: '仓位', key: 'position' },
      { label: '上证', key: 'sh' },
      { label: '沪深300', key: 'hs300' },
    ],
    rows: sampled.map((point) => {
      const index = indexByDate.get(point.date);
      return {
        date: point.date,
        asset: point.totalAsset,
        daily: point.dailyProfit,
        nav: point.navIndex,
        position: `${(point.positionRatio * 100).toFixed(0)}%`,
        sh: index?.sh ?? null,
        hs300: index?.hs300 ?? null,
      };
    }),
  });
  return datasets;
};

/** 已清仓周期（清仓非空的记录，Top 盈亏单只从这里挑） */
const closedCycles = computed(() => cleared.value.filter((row) => row.closeDate !== null));

/** 区间已实现盈亏（摩擦账本拖累比分母；无清仓记录为 null） */
const realizedProfit = computed(() => {
  const closed = closedCycles.value;
  if (closed.length === 0) return null;
  return closed.reduce((sum, row) => sum + row.profit, 0);
});

/** 持有天数分桶边界（天）：短线 / 波段 / 中线 / 长线 */
const HOLD_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '短线(≤5天)', min: 0, max: 5 },
  { label: '波段(6-20天)', min: 6, max: 20 },
  { label: '中线(21-60天)', min: 21, max: 60 },
  { label: '长线(>60天)', min: 61, max: Number.MAX_SAFE_INTEGER },
];

/** 明细单挑出条数（最大盈利 / 亏损各取前 N） */
const AI_TOP_TRADES = 5;

/**
 * 清仓分析数据段（AI 分析口径）：周期汇总 + 持有天数分桶 + Top 盈亏单
 * @returns 数据段列表；无清仓记录返回空数组
 */
const buildClearedDatasets = (): RankDataset[] => {
  const closed = closedCycles.value;
  if (closed.length === 0) {
    return [];
  }
  const wins = closed.filter((row) => row.profit > 0);
  const losses = closed.filter((row) => row.profit < 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, r) => s + r.profit, 0) / wins.length : 0;
  const avgLoss =
    losses.length > 0 ? losses.reduce((s, r) => s + r.profit, 0) / losses.length : 0;
  const datasets: RankDataset[] = [
    {
      title: '周期汇总（已清仓）',
      columns: [
        { label: '已清笔数', key: 'count' },
        { label: '胜率', key: 'winRate' },
        { label: '累计盈亏(元)', key: 'profit' },
        { label: '平均盈利单(元)', key: 'avgWin' },
        { label: '平均亏损单(元)', key: 'avgLoss' },
        { label: '盈亏比', key: 'plRatio' },
        { label: '累计费用(元)', key: 'fee' },
        { label: '平均持有天数', key: 'hold' },
      ],
      rows: [
        {
          count: closed.length,
          winRate: `${((wins.length / closed.length) * 100).toFixed(0)}%`,
          profit: closed.reduce((s, r) => s + r.profit, 0),
          avgWin,
          avgLoss,
          plRatio:
            avgLoss === 0 ? '—' : `${(Math.abs(avgWin / avgLoss)).toFixed(2)}`,
          fee: closed.reduce((s, r) => s + r.fee, 0),
          hold: Number(
            (closed.reduce((s, r) => s + r.holdDays, 0) / closed.length).toFixed(1),
          ),
        },
      ],
    },
    {
      title: '持有天数分桶（各桶笔数与盈亏，判断哪段周期在赚钱）',
      columns: [
        { label: '分桶', key: 'bucket' },
        { label: '笔数', key: 'count' },
        { label: '合计盈亏(元)', key: 'profit' },
        { label: '胜率', key: 'winRate' },
      ],
      rows: HOLD_BUCKETS.map((bucket) => {
        const rows = closed.filter((row) => row.holdDays >= bucket.min && row.holdDays <= bucket.max);
        const bucketWins = rows.filter((row) => row.profit > 0).length;
        return {
          bucket: bucket.label,
          count: rows.length,
          profit: rows.reduce((s, r) => s + r.profit, 0),
          winRate: rows.length === 0 ? '—' : `${((bucketWins / rows.length) * 100).toFixed(0)}%`,
        };
      }),
    },
  ];
  const byProfit = [...closed].sort((a, b) => b.profit - a.profit);
  const tradeColumns = [
    { label: '名称', key: 'name' },
    { label: '开仓日', key: 'open' },
    { label: '清仓日', key: 'close' },
    { label: '持有天数', key: 'hold' },
    { label: '回合数', key: 'rounds' },
    { label: '建仓均价', key: 'avgBuy' },
    { label: '清仓均价', key: 'avgSell' },
    { label: '盈亏(元)', key: 'profit' },
    { label: '收益率', key: 'rate' },
  ];
  const toTradeRow = (row: TzzbClearedPosition): Record<string, unknown> => ({
    name: row.name,
    open: row.openDate,
    close: row.closeDate,
    hold: row.holdDays,
    rounds: row.rounds,
    avgBuy: row.avgBuy,
    avgSell: row.avgSell,
    profit: row.profit,
    rate: signPct(row.rate),
  });
  datasets.push({
    title: '最大盈利单 Top5',
    columns: tradeColumns,
    rows: byProfit.slice(0, AI_TOP_TRADES).map(toTradeRow),
  });
  datasets.push({
    title: '最大亏损单 Top5',
    columns: tradeColumns,
    rows: byProfit.slice(-AI_TOP_TRADES).map(toTradeRow),
  });
  return datasets;
};

/**
 * 发起「资产曲线 AI 分析」（指数印证 / 市场风向 / 政策 / 地缘由提示词驱动 Agent 查证）
 */
const runAssetAiAnalysis = async (): Promise<void> => {
  if (assetAiRunning.value) return;
  const label = rangeLabel.value === '自定义区间' ? `${customFrom.value} ~ ${customTo.value}` : rangeLabel.value;
  const prompt = buildAssetCurveAnalysisPrompt(label, buildAssetDatasets());
  if (prompt === '') {
    notifications.push({
      title: '暂无可分析的数据',
      body: '请等待资产曲线数据加载完成后再发起 AI 分析',
      tone: NOTIFY_TONE.FLAT,
    });
    return;
  }
  assetAiRunning.value = true;
  try {
    await requestAgentAnalysis(prompt);
  } finally {
    assetAiRunning.value = false;
  }
};

/**
 * 发起「清仓分析 AI 分析」（典型案例 / 行为偏差的行情查证由提示词驱动 Agent 完成）
 */
const runClearedAiAnalysis = async (): Promise<void> => {
  if (clearedAiRunning.value) return;
  const prompt = buildClearedPositionAnalysisPrompt(buildClearedDatasets());
  if (prompt === '') {
    notifications.push({
      title: '暂无可分析的数据',
      body: '请先同步投资账本生成建清仓记录',
      tone: NOTIFY_TONE.FLAT,
    });
    return;
  }
  clearedAiRunning.value = true;
  try {
    await requestAgentAnalysis(prompt);
  } finally {
    clearedAiRunning.value = false;
  }
};

/** 当前选中账户名（mock 采样提示用） */
const selectedName = computed(
  () => accounts.value.find((a) => a.id === selectedId.value)?.name ?? '全部账户',
);

/* ---------------- 加载 ---------------- */

/** 同步任务总数（loadAll 并行任务数，进度条分母；账户列表走独立缓存初始化，不计入） */
const SYNC_TASK_TOTAL = 12;

/** 同步进度（null = 未在同步；done/total 驱动顶栏进度条） */
const syncProgress = ref<{ done: number; total: number } | null>(null);

/**
 * 拉取全部模块（并行启动；单模块失败不影响其余，各自落空态，
 * 失败原因原样透出——上游报什么就展示什么，不做拦截加工与自动重试）。
 * 完成后把当前口径快照进本地缓存（切换回来秒开）
 * @param mode skeleton = 首载（显示骨架屏）；silent = 手动同步 / 切账户（保留旧数据，只走进度条）
 * @param opts 可选项
 * @param opts.quiet true = 完全静默后台刷新（不进进度条，用于缓存命中后的保活刷新）
 */
const loadAll = async (
  mode: 'skeleton' | 'silent' = 'skeleton',
  opts: { quiet?: boolean } = {},
): Promise<void> => {
  if (mode === 'skeleton') loading.value = true;
  if (!opts.quiet) syncProgress.value = { done: 0, total: SYNC_TASK_TOTAL };
  let done = 0;
  /** 单任务完成时推进进度条（quiet 模式不驱动进度条） */
  const bump = (): void => {
    done += 1;
    if (!opts.quiet) syncProgress.value = { done, total: SYNC_TASK_TOTAL };
  };
  const results = await Promise.allSettled([
    getTzzbSyncMeta().finally(bump),
    // 按当前选中的区间取数（默认 m1）：切账户整拉时页签停在「近三月」等
    // 非默认区间，取默认区间会导致曲线与页签口径不一致（2026-11-10 王总反馈）
    getTzzbPnlSummary(range.value).finally(bump),
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
  const [meta, pnlR, posR, chgR, dayR, monR, yearR, clrR, fundRetR, fundCycR, tradeR, fundTradeR] = results;
  if (meta.status === 'fulfilled') syncMeta.value = meta.value;
  if (pnlR.status === 'fulfilled') pnl.value = pnlR.value;
  if (posR.status === 'fulfilled') position.value = posR.value;
  if (chgR.status === 'fulfilled') assetChange.value = chgR.value;
  if (dayR.status === 'fulfilled') dayCal.value = dayR.value;
  if (monR.status === 'fulfilled') monthCal.value = monR.value;
  if (yearR.status === 'fulfilled') yearPoints.value = yearR.value;
  if (clrR.status === 'fulfilled') cleared.value = clrR.value;
  if (fundRetR.status === 'fulfilled') fundReturns.value = fundRetR.value;
  if (fundCycR.status === 'fulfilled') fundCycles.value = fundCycR.value;
  if (tradeR.status === 'fulfilled') {
    stockTrades.value = tradeR.value;
    // 摩擦账本口径：首页分页结构里的 list 已合并全量页
    allStockTrades.value = tradeR.value?.list ?? null;
  }
  if (fundTradeR.status === 'fulfilled') fundTrades.value = fundTradeR.value;
  syncProgress.value = null;
  if (mode === 'skeleton') loading.value = false;
  // 本口径数据落缓存（内存 + localStorage），再次切入秒开
  scopeCache.set(scopeKey(), captureScope());
  persistScopeCache();
  // 上游 401 感知：access token 过期且 refresh 被上游拒绝（invalid_client）——
  // 自动拉起浏览器重新授权（对齐 Claude 客户端行为），授权落盘后自动同步
  const unauthorized = results.some(
    (r): r is PromiseRejectedResult =>
      r.status === 'rejected' && UPSTREAM_401_PATTERN.test(String(r.reason)),
  );
  if (unauthorized) void autoReauthOn401();
};

onMounted(() => {
  void initAccounts();
});

/* ---------------- 交互 ---------------- */

/**
 * 切换账户（顶栏展示口径）：在勾选的同步账户内进一步聚焦单账户。
 * 本地缓存命中（含刚切出去的口径）直接回放快照秒开——不打上游、不进进度条；
 * 未命中才整体静默重拉（进度条反馈，不闪骨架屏）
 * @param id 账户 id；'' = 全部同步账户（回落到勾选集合口径）
 */
const onSelectAccount = (id: string): void => {
  if (id === selectedId.value) return;
  // 离开前把当前口径快照进缓存（回来时秒开）
  scopeCache.set(scopeKey(), captureScope());
  persistScopeCache();
  selectedId.value = id;
  applyAccountScope();
  const hit = scopeCache.get(scopeKey());
  if (hit) {
    applyScope(hit);
    return;
  }
  syncing.value = true;
  void loadAll('silent').finally(() => {
    syncing.value = false;
  });
};

/**
 * 手动同步：账户列表为空时先补拉（挂载时未授权失败的场景，授权成功后在这里补上）；
 * 补拉弹出了首次勾选确认则等待用户确认（确认回调自己拉数据），否则静默重拉
 */
const onSync = async (): Promise<void> => {
  syncing.value = true;
  await ensureAccounts();
  if (!pickerOpen.value) await loadAll('silent');
  syncing.value = false;
};

/**
 * 重授权公共流程：发起本地鉴权流并拉起系统浏览器完成同花顺 OAuth 授权，
 * 等待授权落盘后整体静默重拉；已有流程进行中时复用其授权页地址重新打开
 * （完成授权走原流程回调），不再以 AUTH_FLOW_IN_PROGRESS 失败
 * @throws 鉴权流未配置 / 注册失败 / 等待超时 / 服务端透出的鉴权失败原因
 */
const runReauthFlow = async (): Promise<void> => {
  const since = (await fetchAuthorizedAt()) ?? 0;
  const { authorizeUrl, pending } = await startTzzbMcpAuth();
  // Tauri WebView 里 window.open 不会落系统浏览器（2026-10-20 王总反馈），必须走 opener
  openExternalUrl(authorizeUrl);
  if (pending) {
    notifications.push({
      title: '授权流程进行中',
      body: '已重新打开授权页，完成登录授权后自动继续',
      tone: NOTIFY_TONE.PRIMARY,
    });
  }
  await waitTzzbMcpAuthorized(since);
  notifications.push({
    title: '投资账本授权成功',
    body: 'MCP 凭据已更新，正在重新拉取数据',
    tone: NOTIFY_TONE.UP,
  });
  await onSync();
};

/**
 * 重新授权（菜单手动入口）：失败浮窗透出原因
 */
const onReauth = async (): Promise<void> => {
  try {
    await runReauthFlow();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    notifyError('投资账本重新授权失败', message, message);
  }
};

/* ---------------- 401 自动重授权（对齐 Claude MCP 客户端行为） ---------------- */

/**
 * 背景（2026-11-10 实测）：上游对动态注册客户端的 refresh_token 续期系统性拒绝
 * （fresh refresh_token 未用过即 401 invalid_client，post / basic 认证均试过），
 * access token 仅约 5 分钟有效 —— 过期后所有取数 401。Claude 等标准 MCP 客户端
 * 收到 401 会透明地自动重新走授权流程，这里对齐同样行为。
 */

/** 自动重授权进行中（单飞：一轮同步多个 401 只触发一次） */
let autoReauthRunning = false;

/** 上次自动重授权时间（冷却防循环：流程失败时不会无限反复拉浏览器） */
let lastAutoReauthAt = 0;

/** 自动重授权冷却（毫秒）：失败后 10 分钟内不自动重试（可手动点菜单「重新授权」） */
const AUTO_REAUTH_COOLDOWN_MS = 10 * 60_000;

/** 上游 401 错误标记（代理把上游 HTTP 401 原样抛出：`MCP HTTP 401：...`） */
const UPSTREAM_401_PATTERN = /MCP HTTP 401/;

/**
 * 401 自动重授权兜底：拉起浏览器授权页（会话热时仅需一次点击确认），
 * 授权落盘后自动同步；冷却期内或已有流程进行中时跳过
 */
const autoReauthOn401 = async (): Promise<void> => {
  if (autoReauthRunning) return;
  if (Date.now() - lastAutoReauthAt < AUTO_REAUTH_COOLDOWN_MS) return;
  autoReauthRunning = true;
  lastAutoReauthAt = Date.now();
  try {
    notifications.push({
      title: 'MCP 授权过期，正在自动重新授权',
      body: '上游对 refresh 续期受限，已拉起浏览器授权页——完成授权后自动同步',
      tone: NOTIFY_TONE.PRIMARY,
    });
    await runReauthFlow();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    notifyError(
      '自动重新授权失败',
      `${message}；可稍后手动点「账本 MCP 设置 → 重新授权」`,
      message,
    );
  } finally {
    autoReauthRunning = false;
  }
};

/**
 * 清空授权信息：删除本地 OAuth 凭据（动态注册 + 令牌），
 * 重新授权时将重新注册客户端（用于 refresh 报 invalid_client 等凭据失效场景）
 */
const onClearAuth = async (): Promise<void> => {
  try {
    await clearTzzbMcpAuth();
    syncMeta.value = await getTzzbSyncMeta();
    notifications.push({
      title: '授权信息已清空',
      body: '本地 MCP 凭据已删除；点击「重新授权」重新走 OAuth 流程',
      tone: NOTIFY_TONE.PRIMARY,
    });
  } catch (e) {
    notifications.push({
      title: '清空授权信息失败',
      body: e instanceof Error ? e.message : String(e),
      tone: NOTIFY_TONE.DOWN,
    });
  }
};

/**
 * 盈亏日历切月
 * @param ym 月份 yyyyMM
 */
const onDayMonth = (ym: string): void => {
  void getTzzbDayCalendar(ym).then((v) => {
    if (v) dayCal.value = v;
  });
};

/**
 * 盈亏日历切年（月历 / 年历共用）
 * @param year 年份 yyyy
 */
const onMonthYear = (year: string): void => {
  void getTzzbMonthCalendar(year).then((v) => {
    if (v) monthCal.value = v;
  });
};

/**
 * 股票流水翻页
 * @param page 页码（从 1 起）
 */
const onTradePage = (page: number): void => {
  void getTzzbStockTrades(String(page)).then((v) => {
    if (v) stockTrades.value = v;
  });
};

/**
 * 点击品种打开个股 / 基金详情（2026-11-02 起统一口径：单击 = 右侧个股侧栏；
 * 基金无个股详情侧栏，回落跳详情整页）
 * @param code 证券代码
 */
const openStockDetail = (code: string): void => {
  if (/^\d{6}$/.test(code)) {
    openSidebar(code);
    return;
  }
  void router.push(`${ROUTE_PATH.STOCK_DETAIL}/${code}`);
};

/**
 * 双击品种：跳个股详情整页（携带建清仓行作为来源列表）
 * @param code 证券代码
 */
const openStockDetailPage = (code: string): void => {
  void router.push(`${ROUTE_PATH.STOCK_DETAIL}/${code}`);
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <NoticeBar
      class="shrink-0"
      :text="`真实数据：同花顺投资账本 MCP 直连（正式环境） · 当前 ${selectedName} · 切换账户 / 区间按真实接口重拉`"
    />

    <!-- 顶栏：账户选择器 + 同步状态 -->
    <div class="rounded-card shrink-0 bg-surface px-4 py-2.5 shadow-card">
      <TzzbTopbar
        :accounts="visibleAccounts"
        :selected-id="selectedId"
        :sync-meta="syncMeta"
        :syncing="syncing"
        :refreshing-accounts="refreshingAccounts"
        @select="onSelectAccount"
        @sync="onSync"
        @reauth="onReauth"
        @clear-auth="onClearAuth"
        @select-accounts="onSelectAccounts"
        @refresh-accounts="onRefreshAccounts"
      />
      <!-- 同步账户勾选弹窗（首次拉取确认 / 菜单随时改勾选） -->
      <TzzbAccountSelectModal
        v-model:open="pickerOpen"
        :accounts="accounts"
        :selected-ids="pickerFirst ? accounts.map((a) => a.id) : selectedSyncIds"
        :first-confirm="pickerFirst"
        @confirm="onPickerConfirm"
      />
      <!-- 完整报错详情弹窗（错误类浮窗点击打开，含复制按钮） -->
      <TzzbErrorDetailModal
        v-model:open="errorDetailOpen"
        :title="errorDetail.title"
        :detail="errorDetail.detail"
      />
      <!-- 同步进度条：手动同步 / 切账户重拉时替代骨架屏（旧数据保持可见） -->
      <div v-if="syncProgress" class="mt-2 flex items-center gap-2.5">
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-flat-weak">
          <div
            class="h-full rounded-full bg-primary transition-all duration-300"
            :style="{ width: `${(syncProgress.done / syncProgress.total) * 100}%` }"
          />
        </div>
        <span class="shrink-0 font-mono text-xs text-text-tertiary">
          正在同步 {{ syncProgress.done }}/{{ syncProgress.total }}
        </span>
      </div>
    </div>

    <!-- 骨架（首载） -->
    <template v-if="loading">
      <BaseSkeleton class="h-24" />
      <BaseSkeleton class="h-72" />
      <BaseSkeleton class="h-96" />
    </template>

    <template v-else>
      <!-- ① 指标行（区间盈亏 / 对比沪深300 跟随资产曲线区间） -->
      <TzzbMetricRow
        :total-asset="position?.totalAsset ?? 0"
        :market-value="position?.marketValue ?? 0"
        :available-funds="position?.availableFunds ?? 0"
        :position-ratio="position?.positionRatio ?? 0"
        :daily-profit="lastPoint?.dailyProfit ?? 0"
        :daily-rate="lastPoint?.dailyRate ?? null"
        :daily-date="lastPoint?.date ?? ''"
        :range-profit="pnl?.totalProfit ?? 0"
        :range-rate="pnl?.totalRate ?? 0"
        :range-label="rangeLabel === '自定义区间' ? `${customFrom} ~ ${customTo}` : rangeLabel"
        :hs300-rate="hs300Rate"
      />

      <!-- ② 资产曲线 + 区间资金变动 -->
      <div class="grid shrink-0 gap-3 xl:grid-cols-3">
        <BaseCard title="资产曲线" class="xl:col-span-2">
          <template #extra>
            <button
              v-if="agentEntryVisible"
              type="button"
              class="pressable rounded p-1 text-text-tertiary hover:bg-flat-weak hover:text-text active:scale-90 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="assetAiRunning"
              :title="assetAiRunning ? '分析已发送给 Agent' : 'AI 分析该区间资产表现（结合指数 / 市场风向 / 政策与地缘）'"
              :aria-label="`AI 分析资产曲线（${rangeLabel}）`"
              @click="void runAssetAiAnalysis()"
            >
              <MenuIcon name="agent" :size="14" />
            </button>
          </template>
          <!-- min-h-80 可生长外壳：勾选「回撤水下」后子图 + 回撤段表格需要额外
               高度，固定 h-80 会把主图压没了（2026-11-10 王总反馈） -->
          <div class="flex min-h-80 flex-col">
            <TzzbAssetPanel
              :pnl="pnl"
              :range="range"
              :trades="allStockTrades"
              @range-change="(r) => (range = r)"
              @custom-change="(f, t) => ((customFrom = f), (customTo = t))"
            />
          </div>
        </BaseCard>
        <BaseCard title="区间资金变动" fill class="min-h-0">
          <TzzbAssetChangeCard :data="assetChange" />
        </BaseCard>
      </div>

      <!-- ③ 盈亏日历（三级下钻） -->
      <BaseCard title="盈亏日历">
        <TzzbProfitCalendar
          :day-cal="dayCal"
          :month-cal="monthCal"
          :year-points="yearPoints"
          @day-month="onDayMonth"
          @month-year="onMonthYear"
        />
      </BaseCard>

      <!-- ④ 建清仓 + ⑤ 品种总盈亏（xl 定高等高，两侧各自内部滚动） -->
      <div class="grid shrink-0 gap-3 xl:h-[30rem] xl:grid-cols-5">
        <BaseCard title="建清仓记录" fill class="min-h-0 min-w-0 overflow-hidden xl:col-span-3">
          <TzzbClearedPanel :rows="cleared" fill @open="openStockDetail" @open-page="openStockDetailPage" />
        </BaseCard>
        <BaseCard title="品种总盈亏" fill class="min-h-0 min-w-0 overflow-hidden xl:col-span-2">
          <TzzbKindRank :cleared="cleared" :fund-returns="fundReturns" :focus-kind="focusKind" @open="openStockDetail" @open-page="openStockDetailPage" @generate="onGenerateAnalysis" />
        </BaseCard>
      </div>

      <!-- 行为诊断（操作复盘阶段 3 新增）+ 交易摩擦账本（阶段 1）同行 2/3 + 1/3 -->
      <div class="grid shrink-0 gap-3 xl:grid-cols-3">
        <BaseCard title="行为诊断" fill class="min-h-0 xl:col-span-2">
          <TzzbBehaviorDiag @generate="onGenerateAnalysis" />
        </BaseCard>
        <BaseCard title="交易摩擦账本" fill class="min-h-0">
          <TzzbFeeLedger
            :trades="allStockTrades"
            :avg-total-asset="avgTotalAsset"
            :realized-profit="realizedProfit"
          />
        </BaseCard>
      </div>

      <!-- ⑥ 清仓分析（逐周期盈亏 / 费用） -->
      <BaseCard title="清仓分析">
        <template #extra>
          <button
            v-if="agentEntryVisible"
            type="button"
            class="pressable rounded p-1 text-text-tertiary hover:bg-flat-weak hover:text-text active:scale-90 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="clearedAiRunning"
            :title="clearedAiRunning ? '分析已发送给 Agent' : 'AI 分析建清仓操作质量（结合行情查证典型案例）'"
            aria-label="AI 分析清仓分析"
            @click="void runClearedAiAnalysis()"
          >
            <MenuIcon name="agent" :size="14" />
          </button>
        </template>
        <TzzbClearedAnalysis :cleared="cleared" :fund-returns="fundReturns" :fund-cycles="fundCycles" :day-calendar="dayCal" @open="openStockDetail" @open-page="openStockDetailPage" />
      </BaseCard>

      <!-- ⑦ 交易记录（页签在标题行右侧；历史导入页签已删）。
           汇总口径（未聚焦单账户）隐藏页签，股票 / 基金流水平铺展示 -->
      <BaseCard title="交易记录">
        <template #extra>
          <BaseTabs v-if="focusKind" v-model="tradeTab" :options="TRADE_TAB_OPTIONS" />
        </template>
        <template v-if="focusKind">
          <TzzbTradeRecords
            :tab="tradeTab"
            :stock-trades="stockTrades"
            :all-stock-trades="allStockTrades"
            :fund-trades="fundTrades"
            @page="onTradePage"
            @open="openStockDetail"
            @open-page="openStockDetailPage"
          />
        </template>
        <div v-else class="flex flex-col gap-6">
          <div>
            <p class="mb-2 text-xs font-medium text-text-secondary">股票流水</p>
            <TzzbTradeRecords
              tab="stock"
              :stock-trades="stockTrades"
              :all-stock-trades="allStockTrades"
              :fund-trades="fundTrades"
              @page="onTradePage"
              @open="openStockDetail"
              @open-page="openStockDetailPage"
            />
          </div>
          <div>
            <p class="mb-2 text-xs font-medium text-text-secondary">基金流水</p>
            <TzzbTradeRecords
              tab="fund"
              :stock-trades="stockTrades"
              :all-stock-trades="allStockTrades"
              :fund-trades="fundTrades"
              @page="onTradePage"
              @open="openStockDetail"
              @open-page="openStockDetailPage"
            />
          </div>
        </div>
      </BaseCard>
    </template>
  </div>
</template>
