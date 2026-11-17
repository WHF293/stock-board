<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import BaseButton from '../ui/BaseButton.vue';
import BaseEmpty from '../ui/BaseEmpty.vue';
import MenuIcon from '../ui/MenuIcon.vue';
import {
  fetchHotConceptEventDetail,
  fetchHotConceptEventQuotes,
  fetchHotConceptThemeIncrease,
  fetchHotConceptThemeTable,
} from '../../../common/api/hot-concept.api.ts';
import { fetchConstituentQuotesBatch } from '../../../common/api/board-constituent-quote.api.ts';
import type {
  HotConceptEventDetail,
  HotConceptThemeBoard,
} from '../../../common/types/hot-concept.types.ts';
import type { BoardConstituentQuote } from '../../../common/types/board-calendar.types.ts';
import { POLLING_INTERVAL } from '../../../common/constants/polling.constants.ts';
import { ROUTE_PATH } from '../../../common/constants/router-meta.constants.ts';
import { usePolling } from '../../../common/composables/use-polling';
import { getTrendByChangePercent } from '../../../common/constants/trend.constants.ts';
import { TREND_TEXT_CLASS } from '../../../common/constants/stock-colors.constants.ts';
import { formatPercent } from '../../../common/utils/format-percent';
import { formatPrice } from '../../../common/utils/format-price';

/**
 * 今天题材卡片本体（2026-11-17 弃 iframe 自渲染，替代原二级页嵌入）
 *
 * 数据源：同花顺 jtcsm 开放接口（news 同源、免鉴权、CDP 抓包实测直连）——
 * event/detail（题材解读）+ theme/table（影响板块与成分股，一次性拉取）；
 * event/quote（事件平均涨幅/涨停家数）+ theme/quote/increase（板块实时涨幅）
 * + 腾讯批量报价（个股最新价/流通市值，board-constituent-quote 通道）随行情
 * 轮询刷新（生效间隔 = max(设置页行情刷新档, 4s)，交易窗口感知）。
 *
 * 原 iframe 方案的三大问题（dataq 401 / 切换闪刷 / 二级页返回）随架构根除：
 * 无二级页、无跨域上下文销毁、行情列由自有通道补齐。
 */

const props = defineProps<{
  /** 热点事件 id（detail / table / quote 三接口的定位参数） */
  eventId: string;
}>();

const router = useRouter();

/* ---------------- 静态数据（详情 + 板块成分，事件不变不重拉） ---------------- */

/** 事件详情（题材解读） */
const detail = ref<HotConceptEventDetail | null>(null);

/** 影响板块（含细分概念与成分股） */
const boards = ref<HotConceptThemeBoard[] | null>(null);

/** 静态数据拉取中 */
const staticLoading = ref(false);

/** 静态数据拉取失败 */
const staticError = ref(false);

/**
 * 拉取详情与板块成分（eventId 变化时重拉；清单刷新同 id 不重拉）
 */
const fetchStatic = async (): Promise<void> => {
  staticLoading.value = detail.value === null;
  staticError.value = false;
  try {
    const [eventDetail, themeTable] = await Promise.all([
      fetchHotConceptEventDetail(props.eventId),
      fetchHotConceptThemeTable(props.eventId),
    ]);
    detail.value = eventDetail;
    boards.value = themeTable;
  } catch (error) {
    console.error('[hot-concept] 热点详情拉取失败', props.eventId, error);
    staticError.value = true;
  } finally {
    staticLoading.value = false;
  }
};

watch(() => props.eventId, () => void fetchStatic(), { immediate: true });

/* ---------------- 成分股行模型（板块 → 细分概念分组摊平） ---------------- */

/** 成分股行（上游 topStocks + 自有行情合并后的展示模型） */
interface StockRow {
  /** 6 位股票代码 */
  stockCode: string;
  /** 股票名 */
  stockName: string;
  /** 上游快照涨幅（自有行情到达前的首帧口径） */
  upstreamRisePercent: number | null;
  /** 涨停状态（1 = 涨停） */
  limitUpState: number | null;
}

/** 成分股分组（细分概念一组；无细分时整板块一组） */
interface StockGroup {
  /** 分组名（细分概念名 / 板块名） */
  label: string;
  rows: StockRow[];
}

/**
 * 板块树摊平为分组行（顺序保持上游口径：板块 → 细分 → 成分，领涨在前）
 */
const stockGroups = computed<StockGroup[]>(() => {
  const table = boards.value;
  if (!table) return [];
  const groups: StockGroup[] = [];
  const pushRows = (label: string, rows: HotConceptThemeBoard['topStocks']): void => {
    const list = (rows ?? []).filter((stock) => stock.stockCode !== '');
    if (list.length > 0) {
      groups.push({
        label,
        rows: list.map((stock) => ({
          stockCode: stock.stockCode,
          stockName: stock.stockName,
          upstreamRisePercent: stock.risePercent,
          limitUpState: stock.limitUpState,
        })),
      });
    }
  };
  for (const theme of table) {
    if (theme.children && theme.children.length > 0) {
      for (const child of theme.children) {
        pushRows(child.showName, child.topStocks);
      }
    } else {
      pushRows(theme.showName, theme.topStocks);
    }
  }
  return groups;
});

/** 全部成分股代码（去重，批量询价入参） */
const stockSymbols = computed(() => [
  ...new Set(stockGroups.value.flatMap((group) => group.rows.map((row) => row.stockCode))),
]);

/** 顶层题材列表（板块涨幅轮询入参） */
const topThemes = computed(() =>
  (boards.value ?? []).map((theme) => ({ id: theme.id, type: theme.type })),
);

/* ---------------- 实时数据（行情轮询） ---------------- */

/** 事件平均涨幅（百分数数值，null = 未取到） */
const eventRisePercent = ref<number | null>(null);

/** 涨停家数 */
const eventLimitUpCount = ref<number | null>(null);

/** 板块实时涨幅映射（themeId → 涨幅百分数数值） */
const themeIncreaseMap = ref<Record<string, number | null>>({});

/** 成分股自有行情映射（symbol → 行情） */
const stockQuoteMap = ref<Record<string, BoardConstituentQuote>>({});

/**
 * 行情轮询任务：事件平均涨幅 / 板块涨幅 / 成分股批量询价三路并行
 * （任一路失败不影响其余，静默保留上次值）
 */
const pollQuotes = async (): Promise<void> => {
  const themes = topThemes.value;
  const symbols = stockSymbols.value;
  if (themes.length === 0 && symbols.length === 0) return;
  const [eventQuotes, increases, quotes] = await Promise.allSettled([
    fetchHotConceptEventQuotes([props.eventId]),
    themes.length > 0 ? fetchHotConceptThemeIncrease(themes) : Promise.resolve([]),
    symbols.length > 0 ? fetchConstituentQuotesBatch(symbols) : Promise.resolve(new Map()),
  ]);
  if (eventQuotes.status === 'fulfilled') {
    const quote = eventQuotes.value.find((item) => item.eventId === props.eventId);
    if (quote) {
      eventRisePercent.value = quote.risePercent;
      eventLimitUpCount.value = quote.limitUpCount;
    }
  }
  if (increases.status === 'fulfilled') {
    themeIncreaseMap.value = Object.fromEntries(
      increases.value.map((item) => [item.id, item.risePercent]),
    );
  }
  if (quotes.status === 'fulfilled') {
    stockQuoteMap.value = Object.fromEntries(quotes.value);
  }
};

// 行情轮询：间隔取设置页「行情刷新间隔」为生效档（调度内核 max(设置值, 4s)），
// 交易窗口感知（A 股窗口外只请求一次）
usePolling({
  task: pollQuotes,
  intervalMs: POLLING_INTERVAL.QUOTES_INTRADAY,
  tradingAware: true,
});

/**
 * 板块实时涨幅（表格静态值优先级低于轮询值）
 * @param themeId 题材 id
 * @returns 涨幅百分数数值（未取到 null）
 */
const themeRiseOf = (themeId: string): number | null =>
  themeIncreaseMap.value[themeId] ?? boards.value?.find((theme) => theme.id === themeId)?.risePercent ?? null;

/**
 * 行涨幅展示口径：自有行情优先（与最新/市值同源），未到达回落上游快照
 * @param row 成分股行
 * @returns 涨幅百分数数值（未取到 null）
 */
const rowRisePercent = (row: StockRow): number | null =>
  stockQuoteMap.value[row.stockCode]?.changePercent ?? row.upstreamRisePercent;

/**
 * 行现价（自有行情；未到达 null，模板展示 `--`）
 * @param row 成分股行
 * @returns 现价（元）
 */
const rowPrice = (row: StockRow): number | null => stockQuoteMap.value[row.stockCode]?.price ?? null;

/**
 * 行流通市值（自有行情；未到达 null，模板展示 `--`）
 * @param row 成分股行
 * @returns 流通市值（亿元）
 */
const rowMarketCap = (row: StockRow): number | null =>
  stockQuoteMap.value[row.stockCode]?.circulatingMarketCap ?? null;

/**
 * 跳应用内个股详情
 * @param stockCode 6 位代码
 */
const goStockDetail = (stockCode: string): void => {
  void router.push(`${ROUTE_PATH.STOCK_DETAIL}/${stockCode}`);
};
</script>

<template>
  <!-- 静态数据骨架屏 -->
  <div v-if="staticLoading" class="flex h-full flex-col gap-3 p-4">
    <div class="h-4 w-2/3 rounded bg-flat-weak" />
    <div class="h-3 w-full rounded bg-flat-weak" />
    <div class="h-3 w-5/6 rounded bg-flat-weak" />
    <div class="h-3 w-2/3 rounded bg-flat-weak" />
    <div class="mt-2 h-24 w-full rounded bg-flat-weak" />
  </div>

  <!-- 静态数据失败（可重试） -->
  <BaseEmpty v-else-if="staticError" description="详情拉取失败">
    <BaseButton variant="ghost" @click="fetchStatic">
      <MenuIcon name="refresh" :size="14" />
      重试
    </BaseButton>
  </BaseEmpty>

  <div v-else class="flex h-full min-h-0 flex-col">
    <!-- 事件行情头：平均涨幅 + 涨停家数（轮询刷新，红涨绿跌） -->
    <div class="flex shrink-0 items-center gap-2 border-b border-flat-weak px-4 py-2">
      <span class="text-xs text-text-tertiary">平均涨幅</span>
      <span
        class="text-xs font-semibold tabular-nums"
        :class="eventRisePercent === null ? 'text-text-tertiary' : TREND_TEXT_CLASS[getTrendByChangePercent(eventRisePercent)]"
      >
        {{ eventRisePercent === null ? '—' : formatPercent(eventRisePercent) }}
      </span>
      <span class="text-xs text-text-tertiary">涨停</span>
      <span class="text-xs font-semibold tabular-nums text-up">
        {{ eventLimitUpCount === null ? '—' : `${eventLimitUpCount} 家` }}
      </span>
    </div>

    <!-- 卡片内容滚动区 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <!-- 题材解读 -->
      <section v-if="(detail?.summaryItems?.length ?? 0) > 0" class="border-b border-flat-weak px-4 py-3">
        <h3 class="text-xs font-semibold text-text-secondary">题材解读</h3>
        <ul class="mt-1.5 space-y-1">
          <li
            v-for="(item, index) in detail?.summaryItems ?? []"
            :key="index"
            class="text-xs leading-relaxed text-text-tertiary"
          >
            {{ item }}
          </li>
        </ul>
        <a
          v-if="detail?.jumpUrl"
          class="mt-1.5 inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
          :href="detail.jumpUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          详情
          <MenuIcon name="chevronRight" :size="12" />
        </a>
      </section>

      <!-- 影响板块：板块名 + 实时涨幅（轮询刷新） -->
      <section v-if="(boards?.length ?? 0) > 0" class="border-b border-flat-weak px-4 py-3">
        <h3 class="text-xs font-semibold text-text-secondary">影响板块</h3>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          <span
            v-for="theme in boards ?? []"
            :key="theme.id"
            class="flex items-center gap-1 rounded bg-flat-weak px-1.5 py-0.5 text-xs"
          >
            <span class="text-text-secondary">{{ theme.showName }}</span>
            <span
              class="tabular-nums"
              :class="themeRiseOf(theme.id) === null ? 'text-text-tertiary' : TREND_TEXT_CLASS[getTrendByChangePercent(themeRiseOf(theme.id) as number)]"
            >
              {{ themeRiseOf(theme.id) === null ? '—' : formatPercent(themeRiseOf(theme.id)) }}
            </span>
          </span>
        </div>
      </section>

      <!-- 成分股表格：名称代码 / 最新 / 涨幅 / 流通市值（行情三列走自有通道，涨停标红） -->
      <section v-if="stockGroups.length > 0" class="pb-2">
        <table class="w-full text-xs tabular-nums">
          <thead>
            <tr class="text-text-tertiary">
              <th class="sticky top-0 z-10 bg-surface px-4 py-1.5 text-left font-normal">名称代码</th>
              <th class="sticky top-0 z-10 bg-surface px-2 py-1.5 text-right font-normal">最新</th>
              <th class="sticky top-0 z-10 bg-surface px-2 py-1.5 text-right font-normal">涨幅</th>
              <th class="sticky top-0 z-10 bg-surface px-4 py-1.5 text-right font-normal">流通市值</th>
            </tr>
          </thead>
          <tbody v-for="group in stockGroups" :key="group.label">
            <tr>
              <td colspan="4" class="px-4 pb-1 pt-2 text-xs text-text-tertiary">{{ group.label }}</td>
            </tr>
            <tr
              v-for="row in group.rows"
              :key="row.stockCode"
              class="cursor-pointer hover:bg-flat-weak"
              :title="`查看 ${row.stockName} 行情`"
              @click="goStockDetail(row.stockCode)"
            >
              <td class="max-w-0 px-4 py-1.5">
                <span class="block truncate font-medium text-text">{{ row.stockName }}</span>
                <span class="block text-text-tertiary">{{ row.stockCode }}</span>
              </td>
              <td class="px-2 py-1.5 text-right text-text">{{ formatPrice(rowPrice(row)) }}</td>
              <td
                class="px-2 py-1.5 text-right"
                :class="rowRisePercent(row) === null ? 'text-text-tertiary' : TREND_TEXT_CLASS[getTrendByChangePercent(rowRisePercent(row) as number)]"
              >
                <span>{{ rowRisePercent(row) === null ? '—' : formatPercent(rowRisePercent(row)) }}</span>
                <span v-if="row.limitUpState === 1" class="ml-0.5 rounded bg-up-weak px-0.5 text-[10px] text-up">停</span>
              </td>
              <td class="px-4 py-1.5 text-right text-text-tertiary">
                {{ rowMarketCap(row) === null ? '—' : rowMarketCap(row)?.toFixed(2) }}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 无成分股兜底 -->
      <BaseEmpty v-else class="py-6" description="暂无成分股数据" />
    </div>
  </div>
</template>
