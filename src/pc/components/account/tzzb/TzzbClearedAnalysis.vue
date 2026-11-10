<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance, type CSSProperties } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import { CHART_AXIS_LINE_COLOR, CHART_SPLIT_LINE_COLOR, CHART_TEXT_COLOR } from '../../../../common/constants/chart.constants.ts';
import { DOWN_COLOR, UP_COLOR } from '../../../../common/constants/stock-colors.constants.ts';
import BaseChart from '../../charts/BaseChart.vue';
import BaseEmpty from '../../ui/BaseEmpty.vue';
import BaseTable from '../../ui/BaseTable.vue';
import BaseTabs from '../../ui/BaseTabs.vue';
import MenuIcon from '../../ui/MenuIcon.vue';
import type { TableColumn } from '../../../../common/types/table.types.ts';
import type {
  TzzbClearedPosition,
  TzzbDayCalendar,
  TzzbFundCycle,
  TzzbHoldingReturn,
} from '../../../../common/types/tzzb.types.ts';

/**
 * 投资账本 · 清仓分析
 *
 * 按建清仓周期逐笔分析个股 / 个基的盈亏与费用：
 * - 个股：queryClearedPosition 完整买卖回合（盈亏、收益率、费用、费用/|盈亏|、持有天数、回合数），
 *   顶部汇总条给出累计盈亏 / 累计费用 / 胜率 / 平均持有天数，并按持有天数分桶（短线/中线/长线，阈值可配置）；
 * - 个基：15 工具无基金清仓周期（queryClearedPosition 仅覆盖股票），
 *   持有周期视图由申赎流水本地重构「首笔申购 → 份额清零」回合（estProfit 为现金流估算）；
 *   累计收益视图保持 queryFundHoldingReturns 口径，费用字段缺失显示 —；
 * - 长短线维度（王总 2026-11-10 指定）：短线 ≤5 天 / 中线 6~15 天 / 长线 >15 天（默认），
 *   阈值可自定义并持久化 localStorage（不同人对长短线天数认知不同）；
 *   点击桶卡片筛选下方明细，再点取消
 * - 盈亏质量条（操作复盘阶段 2 新增，方案 §4.5，纯本地计算）：
 *   胜率×盈亏比组合（官方裸胜率不回答「赚得稳不稳」）、最长连亏天数、单日盈亏分布直方图
 */
const props = defineProps<{
  /** 清仓记录（个股周期） */
  cleared: TzzbClearedPosition[];
  /** 个基累计持仓收益 */
  fundReturns: TzzbHoldingReturn[];
  /** 基金持仓回合（本地由申赎流水重构，持有周期视图用） */
  fundCycles: TzzbFundCycle[];
  /** 可选盈亏日历（当前月；单日盈亏分布与连亏统计的数据源，缺省时对应项显示 —） */
  dayCalendar?: TzzbDayCalendar | null;
}>();

const emit = defineEmits<{
  /** 单击行打开个股 / 基金详情（2026-11-02 起个股行统一为侧栏口径，基金行保持跳详情） */
  open: [code: string];
  /** 双击个股行：跳个股详情整页 */
  openPage: [code: string];
}>();

const KIND_OPTIONS = [
  { label: '个股', value: 'stock' },
  { label: '个基', value: 'fund' },
];
const kind = ref<string>('stock');

/** 个基明细形态：cycle 持有周期（长短线分桶）/ holding 累计收益（原口径） */
const FUND_VIEW_OPTIONS = [
  { label: '持有周期', value: 'cycle' },
  { label: '累计收益', value: 'holding' },
];
const fundView = ref<string>('cycle');

/** 个股明细形态：cycle 逐周期平铺 / summary 按个股汇总（点击分组展开该股周期明细） */
const STOCK_VIEW_OPTIONS = [
  { label: '按周期', value: 'cycle' },
  { label: '按个股汇总', value: 'summary' },
];
const stockView = ref<string>('cycle');

/** 汇总视图展开的个股（code 集合） */
const expandedStocks = ref<Set<string>>(new Set());

/**
 * 切换个股展开态
 * @param code 证券代码
 */
const toggleStockExpand = (code: string): void => {
  const next = new Set(expandedStocks.value);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  expandedStocks.value = next;
};

/** 个股汇总分组（按合计盈亏降序；周期按开仓日排序；点击桶筛选后跟随过滤） */
const stockSummaryGroups = computed(() => {
  const map = new Map<
    string,
    {
      code: string;
      name: string;
      cycles: TzzbClearedPosition[];
      closedCount: number;
      profit: number;
      fee: number;
      winRate: number | null;
      holdDays: number;
    }
  >();
  for (const r of filteredCycles.value) {
    const g = map.get(r.code) ?? {
      code: r.code,
      name: r.name,
      cycles: [],
      closedCount: 0,
      profit: 0,
      fee: 0,
      winRate: null,
      holdDays: 0,
    };
    g.cycles.push(r);
    if (r.closeDate) g.closedCount += 1;
    g.profit += r.profit;
    g.fee += r.fee;
    g.holdDays += r.holdDays;
    map.set(r.code, g);
  }
  return [...map.values()]
    .map((g) => {
      const closed = g.cycles.filter((r) => r.closeDate);
      return {
        ...g,
        winRate: closed.length > 0 ? closed.filter((r) => r.profit > 0).length / closed.length : null,
        cycles: [...g.cycles].sort((a, b) => a.openDate.localeCompare(b.openDate)),
      };
    })
    .sort((a, b) => b.profit - a.profit);
});

/**
 * 千分位金额
 * @param v 数值
 * @returns 千分位两位小数文案
 */
const yuan = (v: number): string =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * 带符号金额
 * @param v 数值
 * @returns 正值补 + 号的千分位文案
 */
const signYuan = (v: number): string => `${v > 0 ? '+' : ''}${yuan(v)}`;

/**
 * 盈亏文本色
 * @param v 数值
 * @returns 涨跌语义色类（红涨绿跌）
 */
const plClass = (v: number): string => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-flat');

/* ---------------- 个股周期汇总 ---------------- */

/** 已清仓周期（持有中不计入胜率 / 平均持有） */
const closedCycles = computed(() => props.cleared.filter((r) => r.closeDate));

/** 个股汇总指标 */
const stockSummary = computed(() => {
  const closed = closedCycles.value;
  if (props.cleared.length === 0) return null;
  const totalProfit = props.cleared.reduce((s, r) => s + r.profit, 0);
  const totalFee = props.cleared.reduce((s, r) => s + r.fee, 0);
  const wins = closed.filter((r) => r.profit > 0).length;
  const best = closed.reduce<TzzbClearedPosition | null>(
    (a, b) => (!a || b.profit > a.profit ? b : a),
    null,
  );
  const worst = closed.reduce<TzzbClearedPosition | null>(
    (a, b) => (!a || b.profit < a.profit ? b : a),
    null,
  );
  return {
    totalProfit,
    totalFee,
    /** 费用占 |累计盈亏| 比例（盈亏为 0 时无意义） */
    feeRatio: totalProfit !== 0 ? totalFee / Math.abs(totalProfit) : null,
    winRate: closed.length > 0 ? wins / closed.length : null,
    avgHold:
      closed.length > 0 ? closed.reduce((s, r) => s + r.holdDays, 0) / closed.length : null,
    best,
    worst,
  };
});

/* ---------------- 长短线分桶（王总 2026-11-10 指定，阈值可配置并持久化） ----------------
 * 默认：短线 ≤5 天 / 中线 6~15 天 / 长线 >15 天；不同人对长短线天数认知不同，
 * 阈值输入框即改即用，写入 localStorage（tzzb.holdBuckets.v1）跨会话记住。
 * 个股用清仓周期 holdDays（含持有中，按截至今天的天数归桶并单独计数）；
 * 个基持有周期视图用申赎流水重构的回合（TzzbFundCycle.holdDays），口径一致 */

/** 阈值持久化键 */
const HOLD_CFG_KEY = 'tzzb.holdBuckets.v1';

/** 短线阈值（持有 ≤N 天） */
const shortDays = ref(5);

/** 中线阈值（>短线 且 ≤N 天；超过即长线） */
const midDays = ref(15);

// 启动时恢复上次保存的阈值（坏数据 / 越界静默回落默认值）
try {
  const raw = localStorage.getItem(HOLD_CFG_KEY);
  if (raw) {
    const p = JSON.parse(raw) as { short?: unknown; mid?: unknown };
    const s = Number(p.short);
    const m = Number(p.mid);
    if (Number.isFinite(s) && s >= 1) shortDays.value = Math.round(s);
    if (Number.isFinite(m) && m >= 1) midDays.value = Math.round(m);
  }
} catch {
  /* 坏数据：走默认阈值 */
}

// 阈值即改即存（只在两边都合法时写盘，输入中途的空值不落盘）
watch([shortDays, midDays], ([s, m]) => {
  if (!Number.isFinite(s) || !Number.isFinite(m) || s < 1 || m < 1) return;
  try {
    localStorage.setItem(HOLD_CFG_KEY, JSON.stringify({ short: Math.round(s), mid: Math.round(m) }));
  } catch {
    /* 持久化失败不影响使用 */
  }
});

/** 有效分桶边界（中线阈值小于短线时夹到短线+1，保证三桶不重叠） */
const effShort = computed(() => Math.max(1, Math.round(shortDays.value) || 1));
const effMid = computed(() => Math.max(effShort.value + 1, Math.round(midDays.value) || effShort.value + 1));

interface HoldBucketDef {
  key: 'short' | 'mid' | 'long';
  label: string;
  rangeLabel: string;
  test: (d: number) => boolean;
}

/** 三桶定义（label 随阈值联动） */
const holdBuckets = computed<HoldBucketDef[]>(() => [
  { key: 'short', label: '短线', rangeLabel: `≤${effShort.value} 天`, test: (d) => d <= effShort.value },
  { key: 'mid', label: '中线', rangeLabel: `${effShort.value + 1}~${effMid.value} 天`, test: (d) => d > effShort.value && d <= effMid.value },
  { key: 'long', label: '长线', rangeLabel: `>${effMid.value} 天`, test: (d) => d > effMid.value },
]);

/** 当前点击选中的桶（null = 不筛选；再点同桶取消） */
const activeBucket = ref<HoldBucketDef['key'] | null>(null);

/**
 * 切换桶筛选
 * @param key 桶 key
 */
const toggleBucket = (key: HoldBucketDef['key']): void => {
  activeBucket.value = activeBucket.value === key ? null : key;
};

/** 选中桶的持有天数判定；null = 不筛选 */
const bucketTest = computed(() => holdBuckets.value.find((b) => b.key === activeBucket.value)?.test ?? null);

/** 个股周期明细（选中桶时按持有天数过滤，否则全量） */
const filteredCycles = computed(() => {
  const t = bucketTest.value;
  return t ? props.cleared.filter((r) => t(r.holdDays)) : props.cleared;
});

/** 桶内成员聚合行（按品种合并周期） */
interface BucketMember {
  code: string;
  name: string;
  /** 该品种在本桶的周期笔数（>1 时标注 ×N） */
  count: number;
  /** 盈亏合计（个股 = 周期盈亏；个基 = 现金流估算） */
  profit: number;
  /** 费用合计（个基无口径恒为 0，模板不展示） */
  fee: number;
}

/** 桶内个股成员（王总 2026-11-10 指定：每个桶标注有哪些票、各自赚/亏与费用；按 |盈亏| 降序） */
const stockBucketMembers = computed<Record<string, BucketMember[]>>(() =>
  Object.fromEntries(
    holdBuckets.value.map((b) => {
      const map = new Map<string, BucketMember>();
      for (const r of props.cleared) {
        if (!b.test(r.holdDays)) continue;
        const g = map.get(r.code) ?? { code: r.code, name: r.name, count: 0, profit: 0, fee: 0 };
        g.count += 1;
        g.profit += r.profit;
        g.fee += r.fee;
        map.set(r.code, g);
      }
      return [b.key, [...map.values()].sort((a, c) => Math.abs(c.profit) - Math.abs(a.profit))];
    }),
  ),
);

/** 桶内个基成员（费用无口径不展示；按 |估算盈亏| 降序） */
const fundBucketMembers = computed<Record<string, BucketMember[]>>(() =>
  Object.fromEntries(
    holdBuckets.value.map((b) => {
      const map = new Map<string, BucketMember>();
      for (const r of props.fundCycles) {
        if (!b.test(r.holdDays)) continue;
        const g = map.get(r.code) ?? { code: r.code, name: r.name, count: 0, profit: 0, fee: 0 };
        g.count += 1;
        g.profit += r.estProfit;
        map.set(r.code, g);
      }
      return [b.key, [...map.values()].sort((a, c) => Math.abs(c.profit) - Math.abs(a.profit))];
    }),
  ),
);

/** 个股分桶统计（含持有中：盈亏合计含持有中浮亏口径与顶部汇总条一致） */
const stockBuckets = computed(() =>
  holdBuckets.value.map((b) => {
    const rows = props.cleared.filter((r) => b.test(r.holdDays));
    const closed = rows.filter((r) => r.closeDate);
    return {
      key: b.key,
      label: b.label,
      rangeLabel: b.rangeLabel,
      count: rows.length,
      holding: rows.length - closed.length,
      profit: rows.reduce((s, r) => s + r.profit, 0),
      fee: rows.reduce((s, r) => s + r.fee, 0),
      winRate: closed.length > 0 ? closed.filter((r) => r.profit > 0).length / closed.length : null,
      avgHold: rows.length > 0 ? rows.reduce((s, r) => s + r.holdDays, 0) / rows.length : null,
    };
  }),
);

/** 个基回合明细（选中桶时按持有天数过滤） */
const filteredFundCycles = computed(() => {
  const t = bucketTest.value;
  return t ? props.fundCycles.filter((r) => t(r.holdDays)) : props.fundCycles;
});

/** 个基分桶统计（盈亏用现金流估算口径） */
const fundBuckets = computed(() =>
  holdBuckets.value.map((b) => {
    const rows = props.fundCycles.filter((r) => b.test(r.holdDays));
    const closed = rows.filter((r) => r.closeDate);
    return {
      key: b.key,
      label: b.label,
      rangeLabel: b.rangeLabel,
      count: rows.length,
      holding: rows.length - closed.length,
      profit: rows.reduce((s, r) => s + r.estProfit, 0),
      winRate: closed.length > 0 ? closed.filter((r) => r.estProfit > 0).length / closed.length : null,
      avgHold: rows.length > 0 ? rows.reduce((s, r) => s + r.holdDays, 0) / rows.length : null,
    };
  }),
);

/* ---------------- 盈亏质量（操作复盘阶段 2 新增，方案 §4.5，纯本地） ---------------- */

/**
 * 胜率 × 盈亏比：盈利单平均盈 ÷ 亏损单平均亏
 * 胜率相同下盈亏比越高越「值」；全胜 / 全亏（盈亏比无定义）或无已清仓周期时为 null
 */
const quality = computed(() => {
  const closed = closedCycles.value;
  if (closed.length === 0) return null;
  const wins = closed.filter((r) => r.profit > 0);
  const losses = closed.filter((r) => r.profit < 0);
  if (wins.length === 0 || losses.length === 0) return null;
  const avgWin = wins.reduce((s, r) => s + r.profit, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((s, r) => s + r.profit, 0) / losses.length);
  return { winRate: wins.length / closed.length, plRatio: avgWin / avgLoss };
});

/**
 * 最长连亏天数（dayCalendar.days 按日期升序后连续 profit<0）
 * @returns 最长连亏天数；未提供日历时为 null
 */
const maxLosingStreak = computed<number | null>(() => {
  if (!props.dayCalendar) return null;
  const days = [...props.dayCalendar.days].sort((a, b) => a.date.localeCompare(b.date));
  let max = 0;
  let cur = 0;
  for (const d of days) {
    cur = d.profit < 0 ? cur + 1 : 0;
    if (cur > max) max = cur;
  }
  return max;
});

/** 分布直方图桶 */
interface DistBin {
  label: string;
  count: number;
  /** 桶中值是否为盈利（决定红/绿） */
  positive: boolean;
}

/** 分布桶数（奇数保证「0 附近」桶存在） */
const DIST_BINS = 9;

/**
 * 金额缩写（-1234 → -1.2k / 15600 → 1.6万）
 * @param v 金额
 * @returns 缩写文案
 */
const fmtK = (v: number): string => {
  const abs = Math.abs(v);
  const body =
    abs >= 10000 ? `${(abs / 10000).toFixed(1)}万` : abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs.toFixed(0);
  return v < 0 ? `-${body}` : body;
};

/** 单日盈亏分布（等宽 9 桶，min/max 锚定 0；无日历或全为 0 时为 null） */
const dailyDist = computed<DistBin[] | null>(() => {
  if (!props.dayCalendar) return null;
  const profits = props.dayCalendar.days.map((d) => d.profit);
  if (profits.length === 0) return null;
  const min = Math.min(...profits, 0);
  const max = Math.max(...profits, 0);
  if (min === max) return [{ label: '0', count: profits.length, positive: min >= 0 }];
  const step = (max - min) / DIST_BINS;
  return Array.from({ length: DIST_BINS }, (_, i) => {
    const lo = min + step * i;
    const hi = lo + step;
    const inBin = (v: number): boolean => (i === DIST_BINS - 1 ? v >= lo && v <= hi : v >= lo && v < hi);
    return {
      label: `${fmtK(lo)}~${fmtK(hi)}`,
      count: profits.filter(inBin).length,
      positive: (lo + hi) / 2 >= 0,
    };
  });
});

/** 分布直方图配置（红涨绿跌；无数据时为 null 走隐藏） */
const distOption = computed<EChartsCoreOption | null>(() => {
  const bins = dailyDist.value;
  if (!bins) return null;
  return {
    grid: { left: 8, right: 8, top: 6, bottom: 18 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const p = list[0] as { dataIndex?: number } | undefined;
        const bin = p?.dataIndex !== undefined ? bins[p.dataIndex] : undefined;
        return bin ? `${bin.label}：${bin.count} 天` : '';
      },
    },
    xAxis: {
      type: 'category',
      data: bins.map((b) => b.label),
      axisLabel: { color: CHART_TEXT_COLOR, fontSize: 9, interval: 2 },
      axisLine: { lineStyle: { color: CHART_AXIS_LINE_COLOR } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: CHART_SPLIT_LINE_COLOR } },
      axisLabel: { show: false },
    },
    series: [
      {
        type: 'bar',
        barCategoryGap: '20%',
        data: bins.map((b) => ({
          value: b.count,
          itemStyle: { color: b.positive ? UP_COLOR : DOWN_COLOR, opacity: 0.85, borderRadius: [2, 2, 0, 0] },
        })),
      },
    ],
  };
});

/** 质量条是否可见（三项数据全缺时整条隐藏，不出空骨架） */
const qualityVisible = computed(() => quality.value !== null || maxLosingStreak.value !== null || distOption.value !== null);

/** 个股周期明细列 */
const stockColumns: TableColumn<TzzbClearedPosition>[] = [  { key: 'name', label: '证券', sortable: true, sortValue: (r) => r.name },
  {
    key: 'period',
    label: '周期（开 → 清）',
    sortable: true,
    sortValue: (r) => r.openDate,
  },
  { key: 'holdDays', label: '天数', align: 'right', sortable: true, sortValue: (r) => r.holdDays },
  { key: 'rounds', label: '回合', align: 'right', sortable: true, sortValue: (r) => r.rounds },
  { key: 'profit', label: '盈亏', align: 'right', sortable: true, sortValue: (r) => r.profit },
  { key: 'rate', label: '收益率', align: 'right', sortable: true, sortValue: (r) => r.rate },
  { key: 'fee', label: '费用', align: 'right', sortable: true, sortValue: (r) => r.fee },
  {
    key: 'feeRatio',
    label: '费用 / |盈亏|',
    align: 'right',
    sortable: true,
    sortValue: (r) => (r.profit !== 0 ? r.fee / Math.abs(r.profit) : 0),
  },
];

/** 汇总视图展开后的周期明细列（去掉证券列，分组行已标明个股） */
const stockDetailColumns: TableColumn<TzzbClearedPosition>[] = stockColumns.filter((c) => c.key !== 'name');

/* ---------------- 个基（累计口径） ---------------- */

/** 个基汇总指标 */
const fundSummary = computed(() => {
  const rows = props.fundReturns;
  if (rows.length === 0) return null;
  const totalProfit = rows.reduce((s, r) => s + r.profit, 0);
  const wins = rows.filter((r) => r.profit > 0).length;
  const best = rows.reduce<TzzbHoldingReturn | null>((a, b) => (!a || b.profit > a.profit ? b : a), null);
  const worst = rows.reduce<TzzbHoldingReturn | null>((a, b) => (!a || b.profit < a.profit ? b : a), null);
  return { totalProfit, count: rows.length, winRate: wins / rows.length, best, worst };
});

/** 个基明细列（费用缺失显示 —） */
const fundColumns: TableColumn<TzzbHoldingReturn>[] = [
  { key: 'name', label: '基金', sortable: true, sortValue: (r) => r.name },
  { key: 'profit', label: '累计盈亏', align: 'right', sortable: true, sortValue: (r) => r.profit },
  { key: 'rate', label: '累计收益率', align: 'right', sortable: true, sortValue: (r) => r.rate },
  { key: 'fee', label: '费用', align: 'right' },
];

/** 个基持仓回合列（持有周期视图；盈亏为申赎现金流估算） */
const fundCycleColumns: TableColumn<TzzbFundCycle>[] = [
  { key: 'name', label: '基金', sortable: true, sortValue: (r) => r.name },
  { key: 'period', label: '周期（开 → 清）', sortable: true, sortValue: (r) => r.openDate },
  { key: 'holdDays', label: '天数', align: 'right', sortable: true, sortValue: (r) => r.holdDays },
  { key: 'buyAmount', label: '投入', align: 'right', sortable: true, sortValue: (r) => r.buyAmount },
  { key: 'sellAmount', label: '回收', align: 'right', sortable: true, sortValue: (r) => r.sellAmount },
  { key: 'estProfit', label: '估算盈亏', align: 'right', sortable: true, sortValue: (r) => r.estProfit },
];

/* ---------------- 明细表行裁剪（默认收起，王总 2026-11-10 指定，交互对齐市场总览指数） ----------------
 * 复用 .row-clamp（theme.css）的裁剪 + 高度过渡；测量逻辑针对表格改写：
 * 收起 = 表头 + 前 N 行数据（指数卡的「首行」对表格即表头，只露表头没有信息量），
 * 展开 = 表格自然高（BaseTable 滚动容器 table-scroll-sm 封顶 400px，超出后内部滚动）。
 * 「按个股汇总」视图不套裁剪——分组行本身就是默认收起的，各有各的展开开关。 */

/** 收起态可见的数据行数（表头 + 前 N 行） */
const COLLAPSED_ROW_COUNT = 3;

/** 裁剪底部阴影呼吸位（px）：必须与 theme.css `.row-clamp` 的 padding-bottom 同步 */
const CLAMP_BOTTOM_ALLOWANCE_PX = 12;

/** 裁剪容器内的明细表包装元素（函数 ref 绑定） */
const recordsRef = ref<HTMLElement | null>(null);

/** 收起态可见高度（表头 + N 行，px） */
const recordsRowHeight = ref(0);

/** 展开态高度（包装元素自然渲染高，px） */
const recordsFullHeight = ref(0);

/** 展开态（默认收起） */
const recordsExpanded = ref(false);

// 切维度 / 切视图时重置桶筛选与明细展开态（筛选只对当前视图生效，不跨场残留）
watch([kind, fundView, stockView], () => {
  activeBucket.value = null;
  recordsExpanded.value = false;
});

/** 表头 + N 行之外是否还有内容（没有则不裁剪、不渲染开关） */
const recordsHasOverflow = computed<boolean>(
  () => recordsFullHeight.value - recordsRowHeight.value > 1,
);

/** 裁剪容器内联高度；首帧未实测时不写死，避免从 0 高跳一下 */
const recordsClampStyle = computed<CSSProperties>(() =>
  recordsRowHeight.value > 0
    ? {
        height: `${
          (recordsExpanded.value ? recordsFullHeight.value : recordsRowHeight.value) +
          CLAMP_BOTTOM_ALLOWANCE_PX
        }px`,
      }
    : {},
);

/** 实测收起 / 展开高度（隐藏态尺寸为 0 时保留上次实测值，KeepAlive 缓存页不跳变） */
const measureRecords = (): void => {
  const wrap = recordsRef.value;
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  if (wrapRect.width === 0) return;
  const table = wrap.querySelector('table');
  if (!table) {
    recordsRowHeight.value = 0;
    recordsFullHeight.value = 0;
    return;
  }
  recordsFullHeight.value = Math.round(wrapRect.height);
  const rows = table.querySelectorAll('tbody tr');
  const visible = Math.min(COLLAPSED_ROW_COUNT, rows.length);
  if (visible === 0) {
    recordsRowHeight.value = recordsFullHeight.value;
    return;
  }
  const tableTop = table.getBoundingClientRect().top;
  const nthRowBottom = rows[visible - 1].getBoundingClientRect().bottom;
  recordsRowHeight.value = Math.round(nthRowBottom - tableTop);
};

/** 切换明细表展开 / 收起 */
const toggleRecordsExpanded = (): void => {
  recordsExpanded.value = !recordsExpanded.value;
};

/** 明细表裁剪观察器（包装元素尺寸变化即重测：数据刷新 / 视图切换 / 列宽变化） */
let recordsObserver: ResizeObserver | null = null;

/**
 * 函数式模板 ref：包装元素一挂载就实测并开始观察，卸载即断开
 * @param el 模板元素（卸载时为 null）
 */
const setRecordsRef = (el: Element | ComponentPublicInstance | null): void => {
  const next = el instanceof HTMLElement ? el : null;
  if (next === recordsRef.value) return;
  recordsObserver?.disconnect();
  recordsObserver = null;
  recordsRef.value = next;
  if (!next) return;
  measureRecords();
  if (typeof ResizeObserver !== 'undefined') {
    recordsObserver = new ResizeObserver(measureRecords);
    recordsObserver.observe(next);
  }
};

onBeforeUnmount(() => {
  recordsObserver?.disconnect();
  recordsObserver = null;
});
</script>

<template>
  <BaseEmpty
    v-if="cleared.length === 0 && fundReturns.length === 0"
    text="暂无建清仓数据：同步投资账本后自动生成周期分析"
  />
  <div v-else class="flex flex-col gap-3">
    <!-- 维度切换 + 个股明细形态 / 个基视图切换 -->
    <div class="flex items-center justify-between gap-2">
      <BaseTabs v-model="kind" :options="KIND_OPTIONS" />
      <div class="flex items-center gap-2">
        <BaseTabs v-if="kind === 'fund'" v-model="fundView" :options="FUND_VIEW_OPTIONS" />
        <BaseTabs v-if="kind === 'stock'" v-model="stockView" :options="STOCK_VIEW_OPTIONS" />
      </div>
    </div>

    <!-- 长短线阈值（公共配置：个股分桶 + 个基持有周期分桶共用；即改即存 localStorage） -->
    <div
      v-if="kind === 'stock' || (kind === 'fund' && fundView === 'cycle')"
      class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary"
    >
      <span class="font-medium text-text-secondary">长短线阈值</span>
      <label class="flex items-center gap-1">
        短线 ≤
        <input
          v-model.number="shortDays"
          type="number"
          min="1"
          class="w-14 rounded border border-flat-weak bg-transparent px-1.5 py-0.5 text-center font-mono text-text focus:border-primary focus:outline-none"
          aria-label="短线最大持有天数"
        />
        天
      </label>
      <label class="flex items-center gap-1">
        中线 ≤
        <input
          v-model.number="midDays"
          type="number"
          min="1"
          class="w-14 rounded border border-flat-weak bg-transparent px-1.5 py-0.5 text-center font-mono text-text focus:border-primary focus:outline-none"
          aria-label="中线最大持有天数"
        />
        天（超过即长线）· 自动保存
      </label>
    </div>

    <!-- 个股：汇总条 + 分桶 + 周期明细 -->
    <template v-if="kind === 'stock'">
      <div v-if="stockSummary" class="grid grid-cols-2 gap-2 md:grid-cols-5">
        <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
          <p class="text-xs text-text-tertiary">累计盈亏（含持有中）</p>
          <p class="mt-0.5 font-mono text-base font-semibold tabular-nums" :class="plClass(stockSummary.totalProfit)">
            {{ signYuan(stockSummary.totalProfit) }}
          </p>
        </div>
        <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
          <p class="text-xs text-text-tertiary">累计费用</p>
          <p class="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
            {{ yuan(stockSummary.totalFee) }}
            <span v-if="stockSummary.feeRatio !== null" class="text-xs font-normal text-text-tertiary">
              （{{ (stockSummary.feeRatio * 100).toFixed(0) }}% of |盈亏|）
            </span>
          </p>
        </div>
        <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
          <p class="text-xs text-text-tertiary">胜率（已清 {{ closedCycles.length }} 笔）</p>
          <p class="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
            {{ stockSummary.winRate === null ? '—' : `${(stockSummary.winRate * 100).toFixed(0)}%` }}
          </p>
        </div>
        <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
          <p class="text-xs text-text-tertiary">平均持有天数</p>
          <p class="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
            {{ stockSummary.avgHold === null ? '—' : stockSummary.avgHold.toFixed(1) }}
          </p>
        </div>
        <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
          <p class="text-xs text-text-tertiary">最佳 / 最差周期</p>
          <p class="mt-0.5 truncate font-mono text-sm font-semibold tabular-nums">
            <span :class="plClass(stockSummary.best?.profit ?? 0)">
              {{ stockSummary.best ? `${stockSummary.best.name} ${signYuan(stockSummary.best.profit)}` : '—' }}
            </span>
            <span class="mx-1 text-text-tertiary">/</span>
            <span :class="plClass(stockSummary.worst?.profit ?? 0)">
              {{ stockSummary.worst ? signYuan(stockSummary.worst.profit) : '—' }}
            </span>
          </p>
        </div>
      </div>

      <!-- 盈亏质量条（阶段 2 新增：官方裸胜率之外的「赚得稳不稳」视角） -->
      <div v-if="qualityVisible" class="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
          <p class="text-xs text-text-tertiary">胜率 × 盈亏比</p>
          <p class="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
            {{ quality ? `${(quality.winRate * 100).toFixed(0)}% × ${quality.plRatio.toFixed(2)}` : '—' }}
          </p>
          <p class="mt-0.5 text-xs text-text-tertiary">盈利单均盈 ÷ 亏损单均亏，越高越「值」</p>
        </div>
        <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
          <p class="text-xs text-text-tertiary">最长连亏（{{ props.dayCalendar ? `${props.dayCalendar.month.slice(4)} 月` : '—' }}）</p>
          <p class="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
            {{ maxLosingStreak === null ? '—' : `${maxLosingStreak} 天` }}
          </p>
          <p class="mt-0.5 text-xs text-text-tertiary">连续单日亏损（当月日历口径）</p>
        </div>
        <div v-if="distOption" class="col-span-2 rounded-lg bg-flat-weak/60 px-3 py-2">
          <p class="text-xs text-text-tertiary">
            单日盈亏分布（{{ props.dayCalendar ? `${props.dayCalendar.month.slice(4)} 月 ` : '' }}{{ props.dayCalendar?.days.length ?? 0 }} 个自然日）
          </p>
          <div class="mt-1 h-20">
            <BaseChart :options="distOption" />
          </div>
        </div>
      </div>

      <!-- 长短线分桶（阈值见上方公共配置行；点击桶筛选明细；股票口径 = 清仓周期 holdDays） -->
      <div class="flex flex-col gap-1.5">
        <div class="grid grid-cols-3 gap-2">
          <button
            v-for="b in stockBuckets"
            :key="b.key"
            type="button"
            class="rounded-lg border px-3 py-2 text-left transition-colors"
            :class="activeBucket === b.key ? 'border-primary bg-primary/5' : 'border-flat-weak hover:bg-flat-weak/40'"
            :title="activeBucket === b.key ? '点击取消筛选' : '点击筛选该桶明细'"
            @click="toggleBucket(b.key)"
          >
            <p class="text-xs text-text-secondary">
              {{ b.label }}
              <span class="text-text-tertiary">（{{ b.rangeLabel }}）</span>
            </p>
            <p class="mt-0.5 text-xs text-text-tertiary">
              {{ b.count }} 笔<template v-if="b.holding > 0">（持有中 {{ b.holding }}）</template>
              <template v-if="b.winRate !== null">· 胜率 {{ (b.winRate * 100).toFixed(0) }}%</template>
              <template v-if="b.avgHold !== null">· 均 {{ b.avgHold.toFixed(1) }} 天</template>
            </p>
            <p
              v-if="b.count > 0"
              class="font-mono text-sm font-semibold tabular-nums"
              :class="plClass(b.profit)"
            >
              {{ signYuan(b.profit) }}
              <span class="text-xs font-normal text-text-tertiary">费用 {{ yuan(b.fee) }}</span>
            </p>
            <p v-else class="font-mono text-sm text-text-tertiary">—</p>
            <!-- 桶内成员明细（王总 2026-11-10 指定）：每票盈亏与费用，|盈亏| 降序，超高内滚 -->
            <ul
              v-if="stockBucketMembers[b.key]?.length"
              class="mt-1 max-h-28 space-y-0.5 overflow-y-auto border-t border-flat-weak pt-1 text-xs"
            >
              <li
                v-for="m in stockBucketMembers[b.key]"
                :key="m.code"
                class="flex items-baseline justify-between gap-2"
              >
                <span class="min-w-0 truncate text-text-secondary">
                  {{ m.name }}
                  <span class="ml-0.5 font-mono text-text-tertiary">{{ m.code }}</span>
                  <span v-if="m.count > 1" class="text-text-tertiary">×{{ m.count }}</span>
                </span>
                <span class="shrink-0 font-mono tabular-nums">
                  <span :class="plClass(m.profit)">{{ signYuan(m.profit) }}</span>
                  <span class="text-text-tertiary">/ 费 {{ yuan(m.fee) }}</span>
                </span>
              </li>
            </ul>
          </button>
        </div>
        <p v-if="activeBucket" class="text-xs text-primary">
          已筛选「{{ holdBuckets.find((b) => b.key === activeBucket)?.label }}」桶明细（下方{{ stockView === 'summary' ? '分组' : '周期' }}表），再次点击该桶取消
        </p>
      </div>

      <!-- 按个股汇总：点击分组展开该股全部周期明细（王总 2026-11-09 指定） -->
      <template v-if="stockView === 'summary'">
        <div class="flex flex-col gap-1.5">
          <div
            v-for="g in stockSummaryGroups"
            :key="g.code"
            class="overflow-hidden rounded-xl border border-flat-weak"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 bg-flat-weak/40 px-3 py-2.5 text-left transition-colors hover:bg-flat-weak"
              @click="toggleStockExpand(g.code)"
            >
              <MenuIcon
                name="chevronRight"
                :size="14"
                class="shrink-0 text-text-tertiary transition-transform"
                :class="expandedStocks.has(g.code) ? 'rotate-90' : ''"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-text">
                  {{ g.name }}
                  <span class="ml-1 font-mono text-xs text-text-tertiary">{{ g.code }}</span>
                </p>
                <p class="mt-0.5 text-xs text-text-tertiary">
                  {{ g.cycles.length }} 个周期（已清 {{ g.closedCount }}）
                  <template v-if="g.winRate !== null">· 胜率 {{ (g.winRate * 100).toFixed(0) }}%</template>
                  · 合计持有 {{ g.holdDays }} 天
                </p>
              </div>
              <div class="shrink-0 text-right font-mono text-xs tabular-nums">
                <p class="font-semibold" :class="plClass(g.profit)">{{ signYuan(g.profit) }}</p>
                <p class="text-text-tertiary">费用 {{ yuan(g.fee) }}</p>
              </div>
            </button>
            <BaseTable
              v-if="expandedStocks.has(g.code)"
              :columns="stockDetailColumns"
              :rows="g.cycles"
              :row-key="(r) => `${r.code}-${r.openDate}`"
              :min-width="'680px'"
              scroll-class="table-scroll-sm"
              row-clickable
              enable-dblclick-nav
              @row-click="(r) => emit('open', r.code)"
              @row-dblclick="(r) => emit('openPage', r.code)"
            >
              <template #period="{ row }">
                <span class="font-mono text-xs">
                  {{ row.openDate }} → <b v-if="row.closeDate" class="font-normal">{{ row.closeDate }}</b>
                  <b v-else class="text-primary">持有中</b>
                </span>
              </template>
              <template #profit="{ row }">
                <span class="font-mono font-medium tabular-nums" :class="plClass(row.profit)">
                  {{ signYuan(row.profit) }}
                </span>
              </template>
              <template #rate="{ row }">
                <span class="font-mono tabular-nums" :class="plClass(row.rate)">
                  {{ (row.rate * 100).toFixed(2) }}%
                </span>
              </template>
              <template #feeRatio="{ row }">
                <span class="font-mono tabular-nums">
                  {{ row.profit !== 0 ? `${((row.fee / Math.abs(row.profit)) * 100).toFixed(0)}%` : '—' }}
                </span>
              </template>
            </BaseTable>
          </div>
          <p class="text-xs text-text-tertiary">
            共 {{ stockSummaryGroups.length }} 只个股 · 点击分组行展开逐周期明细 · 单击开侧栏 / 双击进详情
          </p>
        </div>
      </template>

      <!-- 周期明细（按周期平铺）：默认收起只露表头 + 3 行，chevron 展开 / 收起（对齐市场总览指数） -->
      <template v-else>
        <div class="row-clamp" :style="recordsClampStyle">
          <div :ref="setRecordsRef">
            <BaseTable
              :columns="stockColumns"
              :rows="filteredCycles"
              :row-key="(r) => `${r.code}-${r.openDate}`"
              :min-width="'780px'"
              scroll-class="table-scroll-sm"
              row-clickable
              enable-dblclick-nav
              footer-text="单击开侧栏 / 双击进详情"
              @row-click="(r) => emit('open', r.code)"
              @row-dblclick="(r) => emit('openPage', r.code)"
            >
              <template #name="{ row }">
                <span class="font-medium text-text">{{ row.name }}</span>
                <span class="ml-1 font-mono text-xs text-text-tertiary">{{ row.code }}</span>
              </template>
              <template #period="{ row }">
                <span class="font-mono text-xs">
                  {{ row.openDate }} → <b v-if="row.closeDate" class="font-normal">{{ row.closeDate }}</b>
                  <b v-else class="text-primary">持有中</b>
                </span>
              </template>
              <template #profit="{ row }">
                <span class="font-mono font-medium tabular-nums" :class="plClass(row.profit)">
                  {{ signYuan(row.profit) }}
                </span>
              </template>
              <template #rate="{ row }">
                <span class="font-mono tabular-nums" :class="plClass(row.rate)">
                  {{ (row.rate * 100).toFixed(2) }}%
                </span>
              </template>
              <template #feeRatio="{ row }">
                <span class="font-mono tabular-nums">
                  {{ row.profit !== 0 ? `${((row.fee / Math.abs(row.profit)) * 100).toFixed(0)}%` : '—' }}
                </span>
              </template>
            </BaseTable>
          </div>
        </div>
        <div v-if="recordsHasOverflow" class="-mt-1.5 flex justify-center">
          <button
            type="button"
            class="pressable rounded-full p-1.5 text-text-tertiary hover:bg-flat-weak hover:text-text active:scale-90"
            :aria-expanded="recordsExpanded"
            aria-label="清仓记录"
            :title="recordsExpanded ? '收起清仓记录' : '展开全部清仓记录'"
            @click="toggleRecordsExpanded"
          >
            <MenuIcon
              name="chevronDown"
              :size="16"
              class="transition-transform"
              :class="recordsExpanded ? 'rotate-180' : ''"
            />
          </button>
        </div>
      </template>
    </template>

    <!-- 个基：持有周期（长短线分桶 + 申赎回合）/ 累计收益（原口径） -->
    <template v-else>
      <!-- 持有周期视图：本地由申赎流水重构「首笔申购 → 份额清零」回合（上游无基金清仓周期工具） -->
      <template v-if="fundView === 'cycle'">
        <BaseEmpty
          v-if="fundCycles.length === 0"
          text="暂无基金申赎流水：同步投资账本后自动重构持有回合"
        />
        <div v-else class="flex flex-col gap-3">
          <!-- 长短线分桶（阈值见上方公共配置行；口径 = 回合持有天数，盈亏为现金流估算） -->
          <div class="flex flex-col gap-1.5">
            <div class="grid grid-cols-3 gap-2">
              <button
                v-for="b in fundBuckets"
                :key="b.key"
                type="button"
                class="rounded-lg border px-3 py-2 text-left transition-colors"
                :class="activeBucket === b.key ? 'border-primary bg-primary/5' : 'border-flat-weak hover:bg-flat-weak/40'"
                :title="activeBucket === b.key ? '点击取消筛选' : '点击筛选该桶回合'"
                @click="toggleBucket(b.key)"
              >
                <p class="text-xs text-text-secondary">
                  {{ b.label }}
                  <span class="text-text-tertiary">（{{ b.rangeLabel }}）</span>
                </p>
                <p class="mt-0.5 text-xs text-text-tertiary">
                  {{ b.count }} 回合<template v-if="b.holding > 0">（持有中 {{ b.holding }}）</template>
                  <template v-if="b.winRate !== null">· 胜率 {{ (b.winRate * 100).toFixed(0) }}%</template>
                  <template v-if="b.avgHold !== null">· 均 {{ b.avgHold.toFixed(1) }} 天</template>
                </p>
                <p
                  v-if="b.count > 0"
                  class="font-mono text-sm font-semibold tabular-nums"
                  :class="plClass(b.profit)"
                >
                  {{ signYuan(b.profit) }}
                </p>
                <p v-else class="font-mono text-sm text-text-tertiary">—</p>
                <!-- 桶内成员明细：每基估算盈亏（现金流口径，无费用字段），|估算盈亏| 降序，超高内滚 -->
                <ul
                  v-if="fundBucketMembers[b.key]?.length"
                  class="mt-1 max-h-28 space-y-0.5 overflow-y-auto border-t border-flat-weak pt-1 text-xs"
                >
                  <li
                    v-for="m in fundBucketMembers[b.key]"
                    :key="m.code"
                    class="flex items-baseline justify-between gap-2"
                  >
                    <span class="min-w-0 truncate text-text-secondary">
                      {{ m.name }}
                      <span class="ml-0.5 font-mono text-text-tertiary">{{ m.code }}</span>
                      <span v-if="m.count > 1" class="text-text-tertiary">×{{ m.count }}</span>
                    </span>
                    <span class="shrink-0 font-mono tabular-nums" :class="plClass(m.profit)">
                      {{ signYuan(m.profit) }}
                    </span>
                  </li>
                </ul>
              </button>
            </div>
            <p class="text-xs text-text-tertiary">
              按申赎流水重构「首笔申购 → 份额清零」回合 · 估算盈亏 = 赎回 − 申购（现金流口径，分红再投会有偏差） · 点击桶筛选回合表
            </p>
          </div>

          <!-- 回合明细：默认收起只露表头 + 3 行，chevron 展开 / 收起 -->
          <div class="row-clamp" :style="recordsClampStyle">
            <div :ref="setRecordsRef">
              <BaseTable
                :columns="fundCycleColumns"
                :rows="filteredFundCycles"
                :row-key="(r) => `${r.code}-${r.openDate}`"
                :min-width="'640px'"
                scroll-class="table-scroll-sm"
                row-clickable
                footer-text="点击行打开基金详情 · 持有中回合的估算盈亏为截至当前现金流差"
                @row-click="(r) => emit('open', r.code)"
              >
                <template #name="{ row }">
                  <span class="font-medium text-text">{{ row.name }}</span>
                  <span class="ml-1 font-mono text-xs text-text-tertiary">{{ row.code }}</span>
                </template>
                <template #period="{ row }">
                  <span class="font-mono text-xs">
                    {{ row.openDate }} → <b v-if="row.closeDate" class="font-normal">{{ row.closeDate }}</b>
                    <b v-else class="text-primary">持有中</b>
                  </span>
                </template>
                <template #buyAmount="{ row }">
                  <span class="font-mono tabular-nums">{{ yuan(row.buyAmount) }}</span>
                </template>
                <template #sellAmount="{ row }">
                  <span class="font-mono tabular-nums">{{ yuan(row.sellAmount) }}</span>
                </template>
                <template #estProfit="{ row }">
                  <span class="font-mono font-medium tabular-nums" :class="plClass(row.estProfit)">
                    {{ signYuan(row.estProfit) }}
                  </span>
                </template>
              </BaseTable>
            </div>
          </div>
          <div v-if="recordsHasOverflow" class="-mt-1.5 flex justify-center">
            <button
              type="button"
              class="pressable rounded-full p-1.5 text-text-tertiary hover:bg-flat-weak hover:text-text active:scale-90"
              :aria-expanded="recordsExpanded"
              aria-label="基金回合记录"
              :title="recordsExpanded ? '收起回合记录' : '展开全部回合记录'"
              @click="toggleRecordsExpanded"
            >
              <MenuIcon
                name="chevronDown"
                :size="16"
                class="transition-transform"
                :class="recordsExpanded ? 'rotate-180' : ''"
              />
            </button>
          </div>
        </div>
      </template>

      <!-- 累计收益视图（queryFundHoldingReturns 原口径） -->
      <template v-else>
        <div v-if="fundSummary" class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
            <p class="text-xs text-text-tertiary">累计盈亏（{{ fundSummary.count }} 只）</p>
            <p class="mt-0.5 font-mono text-base font-semibold tabular-nums" :class="plClass(fundSummary.totalProfit)">
              {{ signYuan(fundSummary.totalProfit) }}
            </p>
          </div>
          <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
            <p class="text-xs text-text-tertiary">盈利占比</p>
            <p class="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
              {{ (fundSummary.winRate * 100).toFixed(0) }}%
            </p>
          </div>
          <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
            <p class="text-xs text-text-tertiary">最佳</p>
            <p class="mt-0.5 truncate font-mono text-sm font-semibold tabular-nums" :class="plClass(fundSummary.best?.profit ?? 0)">
              {{ fundSummary.best ? `${fundSummary.best.name} ${signYuan(fundSummary.best.profit)}` : '—' }}
            </p>
          </div>
          <div class="rounded-lg bg-flat-weak/60 px-3 py-2">
            <p class="text-xs text-text-tertiary">最差</p>
            <p class="mt-0.5 truncate font-mono text-sm font-semibold tabular-nums" :class="plClass(fundSummary.worst?.profit ?? 0)">
              {{ fundSummary.worst ? `${fundSummary.worst.name} ${signYuan(fundSummary.worst.profit)}` : '—' }}
            </p>
          </div>
        </div>

        <div class="row-clamp" :style="recordsClampStyle">
          <div :ref="setRecordsRef">
            <BaseTable
              :columns="fundColumns"
              :rows="fundReturns"
              :row-key="(r) => r.code"
              :min-width="'560px'"
              scroll-class="table-scroll-sm"
              row-clickable
              footer-text="点击行打开基金详情 · 费用字段内测接口未提供"
              @row-click="(r) => emit('open', r.code)"
            >
              <template #name="{ row }">
                <span class="font-medium text-text">{{ row.name }}</span>
                <span class="ml-1 font-mono text-xs text-text-tertiary">{{ row.code }}</span>
              </template>
              <template #profit="{ row }">
                <span class="font-mono font-medium tabular-nums" :class="plClass(row.profit)">
                  {{ signYuan(row.profit) }}
                </span>
              </template>
              <template #rate="{ row }">
                <span class="font-mono tabular-nums" :class="plClass(row.rate)">
                  {{ (row.rate * 100).toFixed(2) }}%
                </span>
              </template>
              <template #fee> <span class="text-text-tertiary">—</span> </template>
            </BaseTable>
          </div>
        </div>
        <div v-if="recordsHasOverflow" class="-mt-1.5 flex justify-center">
          <button
            type="button"
            class="pressable rounded-full p-1.5 text-text-tertiary hover:bg-flat-weak hover:text-text active:scale-90"
            :aria-expanded="recordsExpanded"
            aria-label="清仓记录"
            :title="recordsExpanded ? '收起清仓记录' : '展开全部清仓记录'"
            @click="toggleRecordsExpanded"
          >
            <MenuIcon
              name="chevronDown"
              :size="16"
              class="transition-transform"
              :class="recordsExpanded ? 'rotate-180' : ''"
            />
          </button>
        </div>
      </template>
    </template>
  </div>
</template>
