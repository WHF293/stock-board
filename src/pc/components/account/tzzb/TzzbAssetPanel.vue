<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { useElementSize } from '@vueuse/core';
import type { EChartsCoreOption } from 'echarts/core';
import {
  CHART_AXIS_LINE_COLOR,
  CHART_LINE_BLUE,
  CHART_LINE_YELLOW,
  CHART_SPLIT_LINE_COLOR,
  CHART_TEXT_COLOR,
} from '../../../../common/constants/chart.constants.ts';
import {
  BENCHMARK_INDEX_DEFAULT,
  BENCHMARK_INDEX_OPTIONS,
} from '../../../../common/constants/benchmark-index.constants.ts';
import { fetchBenchmarkIndexPct } from '../../../../common/api/benchmark-index.api.ts';
import {
  TZZB_RANGE_LABEL,
  TZZB_RANGE_OPTIONS,
  type TzzbPnlSummary,
  type TzzbStockTrade,
} from '../../../../common/types/tzzb.types.ts';
import { useSettingsStore } from '../../../../common/stores/settings';
import { computeUnderwater } from '../../../../common/utils/compute-underwater';
import { DOWN_COLOR } from '../../../../common/constants/stock-colors.constants.ts';
import BaseChart from '../../charts/BaseChart.vue';
import BaseTabs from '../../ui/BaseTabs.vue';

/**
 * 投资账本 · 资产曲线（queryPnlSummary + 腾讯基准指数）
 *
 * - 双模式（王总 2026-11-10 指定）：「盈亏率」= 自己的按日累计收益率曲线 +
 *   单条基准指数累计涨跌幅曲线（select 四选一：上证 / 沪深300 / 创业板指 / 科创50）；
 *   「收益」= 自己的累计收益金额曲线，不显示指数曲线；
 * - 净值指数曲线已下线（原基点 1000 归一化对比，王总 2026-11-10 指定移除）；
 * - 基准指数统一走腾讯不复权日 K（benchmark-index.api，会话级缓存），
 *   不再依赖上游 shIndexTrend（其无科创板指数且行对齐不可靠）；
 * - 开关「仓位变化」：仓位移出主图，下方副图（K线主图+副图样式）按 3:1 高度比
 *   绘制黄色面积图，右轴 0~100%（王总 2026-11-09 定稿）；
 * - 开关「最大回撤」：主曲线下方渲染黄色半透明背景（王总 2026-10-23 定稿）；
 * - 区间为受控状态（父级持有），切换时 emit 给父级重拉 queryPnlSummary
 */
const props = defineProps<{
  /** 资产曲线汇总 */
  pnl: TzzbPnlSummary | null;
  /** 当前区间（父级持有；TZZB_RANGE_OPTIONS value） */
  range: string;
  /** 可选全量股票流水（回撤段「期间操作」列统计用；缺省时该列显示 —） */
  trades?: TzzbStockTrade[] | null;
}>();

const emit = defineEmits<{
  /** 区间切换（父级重拉 queryPnlSummary 并联动指标行） */
  'range-change': [range: string];
  /** 自定义区间起止变化 */
  'custom-change': [from: string, to: string];
}>();

const settingsStore = useSettingsStore();

/** 区间 v-model 代理（get = 父级状态，set = 上抛） */
const rangeModel = computed({
  get: () => props.range,
  set: (v: string) => emit('range-change', v),
});

/** 自定义区间起止（mock 阶段仅展示） */
const customFrom = ref('2026-09-01');
const customTo = ref('2026-10-23');

/** 区间副标题文案 */
const rangeLabel = computed(
  () => TZZB_RANGE_LABEL[props.range] ?? '本月',
);

/** 切到自定义区间或日期变化时上抛起止 */
watch([rangeModel, customFrom, customTo], ([r, from, to]) => {
  if (r === 'custom') emit('custom-change', from, to);
});

/** 仓位变化开关（默认开） */
const posOn = ref(true);

/** 最大回撤开关 */
const ddOn = ref(false);

/** 回撤水下开关（操作复盘阶段 2 新增：净值曲线之外的水下视角，纯本地计算） */
const uwOn = ref(false);

/** 曲线数据（空态兜底） */
const trend = computed(() => props.pnl?.assetTrend ?? []);

/** 图表模式：rate = 盈亏率（自己收益率 + 单条指数涨跌幅）；profit = 收益（累计收益金额，无指数） */
const CHART_MODE_OPTIONS = [
  { label: '盈亏率', value: 'rate' },
  { label: '收益', value: 'profit' },
] as const;
const chartMode = ref<'rate' | 'profit'>('rate');

/** 当前基准指数（腾讯符号；收益模式下不渲染指数线与选择器） */
const indexSymbol = ref<string>(BENCHMARK_INDEX_DEFAULT);

/** 当前选中指数的展示名 */
const indexLabel = computed(
  () => BENCHMARK_INDEX_OPTIONS.find((o) => o.value === indexSymbol.value)?.label ?? indexSymbol.value,
);

/**
 * 归一化后的曲线数据（空数据给占位单点防 ECharts 报错）
 *
 * selfRate = 自己的按日累计收益率（%，首日相对化归零，与指数 0% 起点对齐）；
 * cumProfit = 逐日盈亏累加的累计收益金额（元，区间首日起算）
 */
const trend0 = computed(() => {
  const asset = trend.value;
  if (asset.length === 0) {
    return { dates: ['-'], isoDates: ['-'], selfRate: [0], cumProfit: [0], posVals: [0] };
  }
  let cum = 0;
  const cumProfit = asset.map((p) => {
    cum += p.dailyProfit;
    return Number(cum.toFixed(2));
  });
  const rateBase = asset[0].cumRate;
  return {
    dates: asset.map((p) => dayjs(`${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6, 8)}`).format('MM-DD')),
    isoDates: asset.map((p) => `${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6, 8)}`),
    selfRate: asset.map((p) => Number(((p.cumRate - rateBase) * 100).toFixed(2))),
    cumProfit,
    posVals: asset.map((p) => Number((p.positionRatio * 100).toFixed(2))),
  };
});

/** 基准指数累计涨跌幅序列（%；拉取失败 / 加载中为空 = 不画指数线） */
const indexPct = ref<number[]>([]);

/** 指数序列请求序号（快速切换指数时丢弃过期响应） */
let indexFetchSeq = 0;

// 日期序列 / 选中指数变化 → 重取该指数的累计涨跌幅（失败降级为不画，不阻塞主曲线）
watch(
  [() => trend0.value.isoDates, indexSymbol],
  async ([dates, symbol]) => {
    const seq = ++indexFetchSeq;
    if (dates.length < 2) {
      indexPct.value = [];
      return;
    }
    try {
      const pct = await fetchBenchmarkIndexPct(symbol, dates);
      if (seq === indexFetchSeq) indexPct.value = pct;
    } catch {
      if (seq === indexFetchSeq) indexPct.value = [];
    }
  },
  { immediate: true },
);

/** 水下计算（trend 为空时 underwater 为空数组，消费侧短路） */
const uw = computed(() => computeUnderwater(trend.value, props.trades ?? null));

/** 水下子图数据（百分比口径，-3.2 = 水下 3.2%） */
const uwPct = computed(() =>
  uw.value.underwater.length >= 2
    ? uw.value.underwater.map((v) => Number((v * 100).toFixed(2)))
    : [],
);

/** 水下子图配置（主图下方独立小图，绿色=亏损语义，红涨绿跌口径） */
const uwOption = computed<EChartsCoreOption>(() => {
  void settingsStore.trendTheme;
  return {
    grid: { left: 44, right: 12, top: 8, bottom: 20 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const p = list[0] as { axisValue?: string; data?: number } | undefined;
        const v = p?.data ?? 0;
        return `<b>${p?.axisValue ?? ''}</b><br/>水下 ${Math.abs(v).toFixed(2)}%`;
      },
    },
    xAxis: {
      type: 'category',
      data: trend0.value.dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: CHART_AXIS_LINE_COLOR } },
      axisLabel: { color: CHART_TEXT_COLOR, fontSize: 10 },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      max: 0,
      splitLine: { lineStyle: { color: CHART_SPLIT_LINE_COLOR } },
      axisLabel: { color: CHART_TEXT_COLOR, fontSize: 10, formatter: (v: number) => `${v}%` },
    },
    series: [
      {
        name: '回撤水下',
        type: 'line',
        data: uwPct.value,
        symbol: 'none',
        lineStyle: { color: DOWN_COLOR, width: 1.2 },
        itemStyle: { color: DOWN_COLOR },
        areaStyle: { color: DOWN_COLOR, opacity: 0.22 },
      },
    ],
  };
});

/**
 * 千分位金额（回撤段操作列，整数元）
 * @param v 金额
 * @returns 千分位整数文案
 */
const yuan = (v: number): string => v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });

/**
 * 回撤段操作列文案（无流水输入返回 —）
 * @param i 段下标
 * @returns 操作文案（买/卖笔数与金额；未操作 / —）
 */
const activityText = (i: number): string => {
  const a = uw.value.segments[i]?.activity;
  if (!a) return '—';
  if (a.buys === 0 && a.sells === 0) return '未操作';
  const parts: string[] = [];
  if (a.buys > 0) parts.push(`买 ${a.buys} 笔 ¥${yuan(a.buyAmount)}`);
  if (a.sells > 0) parts.push(`卖 ${a.sells} 笔 ¥${yuan(a.sellAmount)}`);
  return parts.join(' · ');
};

/** 主图 / 仓位副图高度比（主图:副图 = 3:1，K线主图+副图样式，王总 2026-11-09 定稿） */
const PANE_RATIO = 3;

/** 主图顶部留白（px） */
const PANE_TOP_PAD = 12;

/** 主图与副图间距（px） */
const PANE_GAP = 14;

/** 副图底部 x 轴标签区高度（px） */
const PANE_BOTTOM_PAD = 22;

/** 副图最小高度（px，容器极矮时保底可读） */
const PANE_SUB_MIN = 30;

/** 容器高度兜底（px，首帧未量到尺寸时按此切分） */
const CHART_BOX_FALLBACK_HEIGHT = 320;

/** 图表容器（量实高后按 3:1 精确切分主图 / 副图两个 grid） */
const chartBox = ref<HTMLDivElement | null>(null);

/** 容器实高（px） */
const { height: boxH } = useElementSize(chartBox);

const option = computed<EChartsCoreOption>(() => {
  void settingsStore.trendTheme;
  const { dates, selfRate, cumProfit, posVals } = trend0.value;
  const rateMode = chartMode.value === 'rate';
  /** 主曲线数值（rate = 自己累计收益率；profit = 累计收益金额） */
  const mainVals = rateMode ? selfRate : cumProfit;

  const series: Record<string, unknown>[] = [];
  // 最大回撤：黄色半透明背景垫底（主曲线下方，先渲染被后续曲线覆盖）。
  // origin: 'start' 固定填到网格底边 —— 默认 auto 会锚到 y=0 线，收益率曲线
  // 过 0 轴后曲线在 0 下方时填充翻到曲线上方（王总 2026-11-10 反馈不绘制）
  if (ddOn.value) {
    series.push({
      name: '回撤背景',
      type: 'line',
      data: mainVals,
      symbol: 'none',
      lineStyle: { width: 0, opacity: 0 },
      areaStyle: { color: CHART_LINE_YELLOW, opacity: 0.15, origin: 'start' },
      tooltip: { show: false },
      silent: true,
      z: 0,
    });
  }
  series.push({
    name: rateMode ? '收益率' : '累计收益',
    type: 'line',
    data: mainVals,
    symbol: 'none',
    lineStyle: { color: CHART_LINE_BLUE, width: 2 },
    itemStyle: { color: CHART_LINE_BLUE },
    areaStyle: { color: CHART_LINE_BLUE, opacity: 0.07, origin: 'start' },
  });
  // 基准指数线：仅盈亏率模式且序列就绪时渲染（收益模式不显示指数曲线）
  const hasIndex = rateMode && indexPct.value.length === dates.length;
  if (hasIndex) {
    series.push({
      name: indexLabel.value,
      type: 'line',
      data: indexPct.value,
      symbol: 'none',
      lineStyle: { color: CHART_LINE_YELLOW, width: 1.4 },
      itemStyle: { color: CHART_LINE_YELLOW },
    });
  }

  // 仓位副图开启：主图 / 副图双 grid 按 3:1 切分容器实高（K线主图+副图样式），
  // 仓位画成副图黄色面积图；关闭时回到原单 grid 布局
  const subOn = posOn.value;
  const boxHeight = boxH.value > 0 ? boxH.value : CHART_BOX_FALLBACK_HEIGHT;
  const plotHeight = boxHeight - PANE_TOP_PAD - PANE_BOTTOM_PAD - (subOn ? PANE_GAP : 0);
  const subHeight = subOn ? Math.max(PANE_SUB_MIN, Math.round(plotHeight / (PANE_RATIO + 1))) : 0;
  const mainHeight = plotHeight - subHeight;

  if (subOn) {
    series.push({
      name: '仓位',
      type: 'line',
      data: posVals,
      xAxisIndex: 1,
      yAxisIndex: 1,
      symbol: 'none',
      lineStyle: { color: CHART_LINE_YELLOW, width: 1.2 },
      itemStyle: { color: CHART_LINE_YELLOW },
      areaStyle: { color: CHART_LINE_YELLOW, opacity: 0.15 },
    });
  }

  /**
   * 主轴数值文案（rate = 百分数；profit = 千分位元）
   * @param v 主曲线数值
   * @returns 格式化文案
   */
  const mainText = (v: number): string =>
    rateMode ? `${v.toFixed(2)}%` : `¥${v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;

  return {
    grid: subOn
      ? [
          { left: 44, right: 44, top: PANE_TOP_PAD, height: mainHeight },
          { left: 44, right: 44, top: PANE_TOP_PAD + mainHeight + PANE_GAP, height: subHeight },
        ]
      : { left: 44, right: 44, top: 18, bottom: 24 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { axisValue?: string; dataIndex?: number } | undefined;
        const date = first?.axisValue ?? '';
        const i = first?.dataIndex ?? -1;
        const lines = [`<b>${date}</b>`];
        if (i >= 0 && mainVals[i] !== undefined) {
          lines.push(`${rateMode ? '收益率' : '累计收益'} ${mainText(mainVals[i])}`);
        }
        if (hasIndex && i >= 0 && indexPct.value[i] !== undefined) {
          lines.push(`<span style="color:${CHART_LINE_YELLOW}">${indexLabel.value} ${indexPct.value[i]}%</span>`);
        }
        if (i >= 0 && subOn && posVals[i] !== undefined) {
          lines.push(`<span style="color:${CHART_LINE_YELLOW}">仓位 ${posVals[i]}%</span>`);
        }
        return lines.join('<br/>');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: subOn
      ? [
          {
            type: 'category',
            gridIndex: 0,
            data: dates,
            boundaryGap: false,
            axisLine: { lineStyle: { color: CHART_AXIS_LINE_COLOR } },
            axisTick: { show: false },
            axisLabel: { show: false },
          },
          {
            type: 'category',
            gridIndex: 1,
            data: dates,
            boundaryGap: false,
            axisLine: { lineStyle: { color: CHART_AXIS_LINE_COLOR } },
            axisTick: { show: false },
            axisLabel: { color: CHART_TEXT_COLOR, fontSize: 10 },
          },
        ]
      : {
          type: 'category',
          data: dates,
          boundaryGap: false,
          axisLine: { lineStyle: { color: CHART_AXIS_LINE_COLOR } },
          axisLabel: { color: CHART_TEXT_COLOR, fontSize: 10 },
          axisTick: { show: false },
        },
    yAxis: subOn
      ? [
          {
            type: 'value',
            gridIndex: 0,
            scale: true,
            splitLine: { lineStyle: { color: CHART_SPLIT_LINE_COLOR } },
            axisLabel: {
              color: CHART_TEXT_COLOR,
              fontSize: 10,
              formatter: (v: number) => (rateMode ? `${v.toFixed(1)}%` : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })),
            },
          },
          {
            type: 'value',
            gridIndex: 1,
            min: 0,
            max: 100,
            interval: 50,
            position: 'right',
            splitLine: { show: false },
            axisLabel: {
              color: CHART_LINE_YELLOW,
              fontSize: 10,
              formatter: (v: number) => `${v}%`,
            },
          },
        ]
      : [
          {
            type: 'value',
            scale: true,
            splitLine: { lineStyle: { color: CHART_SPLIT_LINE_COLOR } },
            axisLabel: {
              color: CHART_TEXT_COLOR,
              fontSize: 10,
              formatter: (v: number) => (rateMode ? `${v.toFixed(1)}%` : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })),
            },
          },
        ],
    series,
  };
});
</script>

<template>
  <div class="flex flex-1 flex-col">
    <!-- 控制区两行：区间独占一行，模式 / 指数 / 开关一行 -->
    <div class="mb-2">
      <BaseTabs v-model="rangeModel" :options="TZZB_RANGE_OPTIONS" />
    </div>
    <div class="mb-2 flex flex-wrap items-center gap-3">
      <BaseTabs v-model="chartMode" :options="CHART_MODE_OPTIONS" />
      <!-- 基准指数四选一（一次只画一条；收益模式下不显示指数，选择器一并隐藏） -->
      <select
        v-if="chartMode === 'rate'"
        v-model="indexSymbol"
        class="rounded-lg bg-flat-weak px-2 py-1 text-xs text-text outline-none"
        aria-label="切换基准指数"
      >
        <option v-for="o in BENCHMARK_INDEX_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
        <input v-model="posOn" type="checkbox" class="accent-primary" />
        仓位变化
      </label>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
        <input v-model="ddOn" type="checkbox" class="accent-primary" />
        最大回撤
      </label>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
        <input v-model="uwOn" type="checkbox" class="accent-primary" />
        回撤水下
      </label>
    </div>

    <!-- 自定义区间行 -->
    <div v-if="rangeModel === 'custom'" class="mb-2 flex items-center gap-2 text-xs text-text-secondary">
      <input v-model="customFrom" type="date" class="rounded-lg bg-flat-weak px-2 py-1 font-mono text-xs text-text" />
      <span class="text-text-tertiary">~</span>
      <input v-model="customTo" type="date" class="rounded-lg bg-flat-weak px-2 py-1 font-mono text-xs text-text" />
      <span class="text-text-tertiary">正式接入后按起止日调 queryPnlSummary（区间过长自动分段）</span>
    </div>

    <!-- 图表（开启「仓位变化」时内部按 3:1 分主图 / 仓位副图两个 grid）。
         高度必须是确定值：BaseChart 根元素为 h-full（百分比高度），父容器高度
         一旦是 flex/auto（百分比解析为 auto）ECharts 容器会塌成 0 高不渲染；
         勾选「回撤水下」时下方还有子图 + 回撤段表格，切小档给它们留空间 -->
    <div ref="chartBox" class="relative shrink-0" :class="uwOn ? 'h-56' : 'h-72'">
      <BaseChart :options="option" not-merge />
    </div>

    <!-- 回撤水下子图 + 回撤段明细（操作复盘阶段 2 新增；方案 §4.4） -->
    <template v-if="uwOn && uwPct.length > 0">
      <div class="mt-1 h-24 shrink-0">
        <BaseChart :options="uwOption" not-merge />
      </div>
      <div
        v-if="uw.segments.length > 0"
        class="mt-1 max-h-32 shrink-0 overflow-y-auto rounded-lg bg-flat-weak/40 p-2"
      >
        <table class="w-full text-left text-xs">
          <thead>
            <tr class="text-text-tertiary">
              <th class="py-0.5 pr-2 font-normal">回撤段（峰值 → 谷底）</th>
              <th class="py-0.5 pr-2 text-right font-normal">深度</th>
              <th class="py-0.5 pr-2 text-right font-normal">下行</th>
              <th class="py-0.5 pr-2 text-right font-normal">修复</th>
              <th class="py-0.5 text-right font-normal">回撤期间操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(seg, i) in uw.segments"
              :key="seg.peakDate"
              class="border-t border-flat-weak"
              :class="i === uw.maxSegmentIndex ? 'bg-flat-weak/70' : ''"
            >
              <td class="py-0.5 pr-2 font-mono text-text-secondary">
                {{ seg.peakDate.slice(5) }} → {{ seg.troughDate.slice(5) }}
                <span v-if="i === uw.maxSegmentIndex" class="ml-1 text-text-tertiary">最深</span>
              </td>
              <td class="py-0.5 pr-2 text-right font-mono tabular-nums text-down">
                -{{ (seg.depth * 100).toFixed(2) }}%
              </td>
              <td class="py-0.5 pr-2 text-right font-mono tabular-nums text-text-secondary">
                {{ seg.durationDays }} 天
              </td>
              <td class="py-0.5 pr-2 text-right font-mono tabular-nums" :class="seg.recoveryDays === null ? 'text-down' : 'text-text-secondary'">
                {{ seg.recoveryDays === null ? '未修复' : `${seg.recoveryDays} 天` }}
              </td>
              <td class="py-0.5 text-right font-mono tabular-nums text-text-secondary">
                {{ activityText(i) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p class="mt-1 shrink-0 text-xs text-text-tertiary">
      {{
        chartMode === 'rate'
          ? `收益率按日累计（首日归零）${indexPct.length > 0 ? ` · 对比${indexLabel}累计涨跌幅` : ''}`
          : '累计收益金额（区间首日起逐日盈亏累加）'
      }}{{ posOn ? ' · 副图仓位 %（右轴）' : '' }} · {{ rangeLabel }}
    </p>
  </div>
</template>
