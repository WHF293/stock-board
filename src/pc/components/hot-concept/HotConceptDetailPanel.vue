<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import BaseButton from '../ui/BaseButton.vue';
import BaseEmpty from '../ui/BaseEmpty.vue';
import MenuIcon from '../ui/MenuIcon.vue';
import {
  fetchHotConceptEventDetail,
  fetchHotConceptEventQuotes,
  fetchHotConceptStockTags,
  fetchHotConceptThemeIncrease,
  fetchHotConceptThemeTable,
} from '../../../common/api/hot-concept.api.ts';
import { fetchConstituentQuotesBatch } from '../../../common/api/board-constituent-quote.api.ts';
import type {
  HotConceptEventDetail,
  HotConceptStockTagInfo,
  HotConceptThemeBoard,
} from '../../../common/types/hot-concept.types.ts';
import type { BoardConstituentQuote } from '../../../common/types/board-calendar.types.ts';
import { POLLING_INTERVAL } from '../../../common/constants/polling.constants.ts';
import { usePolling } from '../../../common/composables/use-polling';
import { useStockOpen } from '../../../common/composables/use-stock-open';
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
 * 交互对齐上游二级页（2026-11-17 实测上游页面）：
 * - 影响板块 = 可点选页签，默认选中第一个板块，点选切换该板块的成分股列表；
 * - 成分股行单击开右侧个股侧栏、双击进详情整页（左侧可选列表 = 卡片全部成分股）；
 * - 个股下可展开描述块（标签 + 关联段落），get_stock_tag 体外不可用时回落
 *   topStocks.reason 兜底（见 hot-concept.api.ts 的降级说明）。
 *
 * 原 iframe 方案的三大问题（dataq 401 / 切换闪刷 / 二级页返回）随架构根除：
 * 无二级页、无跨域上下文销毁、行情列由自有通道补齐。
 */

const props = defineProps<{
  /** 热点事件 id（detail / table / quote 三接口的定位参数） */
  eventId: string;
}>();

const { openSidebar, openPage, toContextList } = useStockOpen();

/* ---------------- 静态数据（详情 + 板块成分，事件不变不重拉） ---------------- */

/** 事件详情（题材解读） */
const detail = ref<HotConceptEventDetail | null>(null);

/** 影响板块（含细分概念与成分股） */
const boards = ref<HotConceptThemeBoard[] | null>(null);

/** 静态数据拉取中 */
const staticLoading = ref(false);

/** 静态数据拉取失败 */
const staticError = ref(false);

/** 当前选中板块 id（null = 未选，随 boards 就绪默认第一个，对齐上游 index=0） */
const activeThemeId = ref<string | null>(null);

/** 个股标签与描述映射（code → tag info；get_stock_tag 不可用时为空映射） */
const stockTagInfoMap = ref<Record<string, HotConceptStockTagInfo>>({});

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
    void fetchStockTagInfos(themeTable);
  } catch (error) {
    console.error('[hot-concept] 热点详情拉取失败', props.eventId, error);
    staticError.value = true;
  } finally {
    staticLoading.value = false;
  }
};

watch(() => props.eventId, () => void fetchStatic(), { immediate: true });

// 板块清单就绪 / 变化时：选中项失效则回落第一个板块
watch(
  () => boards.value?.map((theme) => theme.id).join(','),
  () => {
    const ids = boards.value?.map((theme) => theme.id) ?? [];
    if (ids.length === 0) {
      activeThemeId.value = null;
    } else if (activeThemeId.value === null || !ids.includes(activeThemeId.value)) {
      activeThemeId.value = ids[0] ?? null;
    }
  },
  { immediate: true },
);

/**
 * 拉取个股标签与描述（fire-and-forget；失败静默，reason 兜底）
 * @param table 影响板块树
 */
const fetchStockTagInfos = async (table: HotConceptThemeBoard[]): Promise<void> => {
  const marketIdByCode = new Map<string, string>();
  const codes: string[] = [];
  const collect = (theme: HotConceptThemeBoard): void => {
    for (const stock of theme.topStocks ?? []) {
      if (stock.stockCode === '' || marketIdByCode.has(stock.stockCode)) continue;
      marketIdByCode.set(stock.stockCode, stock.marketId);
      codes.push(stock.stockCode);
    }
    for (const child of theme.children ?? []) collect(child);
  };
  for (const theme of table) collect(theme);
  const keyword = table[0]?.showName ?? '';
  const map = await fetchHotConceptStockTags(props.eventId, keyword, codes, marketIdByCode).catch(
    () => new Map<string, HotConceptStockTagInfo>(),
  );
  stockTagInfoMap.value = Object.fromEntries(map);
};

/* ---------------- 成分股行模型（选中板块 → 细分概念分组摊平） ---------------- */

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
  /** 上游上涨原因（多数为 null；描述块无标签数据时的兜底文案） */
  reason: string | null;
}

/** 成分股分组（细分概念一组；无细分时整板块一组） */
interface StockGroup {
  /** 分组名（细分概念名 / 板块名） */
  label: string;
  rows: StockRow[];
}

/** 当前选中板块（失效时回落第一个） */
const activeBoard = computed<HotConceptThemeBoard | null>(
  () => boards.value?.find((theme) => theme.id === activeThemeId.value) ?? boards.value?.[0] ?? null,
);

/**
 * 选中板块树摊平为分组行（顺序保持上游口径：细分 → 成分，领涨在前）
 */
const stockGroups = computed<StockGroup[]>(() => {
  const board = activeBoard.value;
  if (!board) return [];
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
          reason: stock.reason,
        })),
      });
    }
  };
  if (board.children && board.children.length > 0) {
    for (const child of board.children) {
      pushRows(child.showName, child.topStocks);
    }
  } else {
    pushRows(board.showName, board.topStocks);
  }
  return groups;
});

/** 卡片全部成分股（跨板块去重，保持上游顺序；行情轮询入参 + 详情页上下文列表源） */
const cardStockRows = computed<StockRow[]>(() => {
  const rows: StockRow[] = [];
  const seen = new Set<string>();
  for (const theme of boards.value ?? []) {
    const collect = (board: HotConceptThemeBoard): void => {
      for (const stock of board.topStocks ?? []) {
        if (stock.stockCode === '' || seen.has(stock.stockCode)) continue;
        seen.add(stock.stockCode);
        rows.push({
          stockCode: stock.stockCode,
          stockName: stock.stockName,
          upstreamRisePercent: stock.risePercent,
          limitUpState: stock.limitUpState,
          reason: stock.reason,
        });
      }
      for (const child of board.children ?? []) collect(child);
    };
    collect(theme);
  }
  return rows;
});

/** 全部成分股代码（去重，批量询价入参） */
const stockSymbols = computed(() => cardStockRows.value.map((row) => row.stockCode));

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

/* ---------------- 个股交互（单击侧栏 / 双击详情页，对齐全站口径） ---------------- */

/** 单击延迟派发定时器（双击合并窗口；null = 无待派发单击） */
let pendingClick: { timer: number; code: string } | null = null;

/** 单击/双击合并窗口（毫秒；与 BaseTable enableDblclickNav 同值） */
const DBLCLICK_MERGE_MS = 250;

/**
 * 卡片成分股的详情页上下文列表（左侧可选列表 = 当前卡片全部成分股）
 */
const cardContextList = computed(() =>
  toContextList(cardStockRows.value, (row) => row.stockCode),
);

/**
 * 成分股行单击（延迟合并双击窗口后打开右侧个股侧栏）
 * @param row 成分股行
 */
const onStockRowClick = (row: StockRow): void => {
  if (pendingClick) window.clearTimeout(pendingClick.timer);
  const timer = window.setTimeout(() => {
    pendingClick = null;
    openSidebar(row.stockCode);
  }, DBLCLICK_MERGE_MS);
  pendingClick = { timer, code: row.stockCode };
};

/**
 * 成分股行双击（取消未派发的单击，跳详情整页并携带卡片上下文列表）
 * @param row 成分股行
 */
const onStockRowDblclick = (row: StockRow): void => {
  if (pendingClick) {
    window.clearTimeout(pendingClick.timer);
    pendingClick = null;
  }
  openPage(row.stockCode, cardContextList.value);
};

// 组件卸载时清掉待派发的单击定时器
onBeforeUnmount(() => {
  if (pendingClick) window.clearTimeout(pendingClick.timer);
  pendingClick = null;
});

/* ---------------- 个股描述块（标签 + 关联段落；默认一行，可展开） ---------------- */

/** 已展开描述的股票代码集合 */
const expandedDescCodes = ref<Set<string>>(new Set());

/**
 * 互动易问答原文解析（associatedReason 为 JSON 串 {query, answer} 时转可读文案）
 * @param reason 关联描述原文
 * @returns 可读文案（非 JSON 原样返回）
 */
const parseAssociateReason = (reason: string): string => {
  if (!reason.startsWith('{')) return reason;
  try {
    const qa = JSON.parse(reason) as { query?: string; answer?: string };
    return `投资者提问：${qa.query ?? ''} 董秘回答：${qa.answer ?? ''}`;
  } catch {
    return reason;
  }
};

/**
 * 个股描述内容（标签数据优先，回落上游上涨原因）
 * @param row 成分股行
 * @returns 标签清单 + 段落清单；无可展示内容为 null
 */
const descOf = (row: StockRow): { tags: string[]; paragraphs: string[] } | null => {
  const info = stockTagInfoMap.value[row.stockCode];
  if (info) {
    const tags = info.tagInfoList.map((tag) => tag.name).filter((name) => name !== '');
    const paragraphs = info.associatedInfoList
      .filter((item) => (item.associatedReason ?? '') !== '')
      .map((item) => {
        const text = parseAssociateReason(item.associatedReason ?? '');
        const source = item.associatedSource ?? '';
        return source === '' ? text : `【${source}】${text}`;
      });
    if (tags.length > 0 || paragraphs.length > 0) return { tags, paragraphs };
  }
  if (row.reason !== null && row.reason !== '') {
    return { tags: [], paragraphs: [row.reason] };
  }
  return null;
};

/**
 * 切换个股描述展开态
 * @param stockCode 6 位股票代码
 */
const toggleDesc = (stockCode: string): void => {
  const next = new Set(expandedDescCodes.value);
  if (next.has(stockCode)) {
    next.delete(stockCode);
  } else {
    next.add(stockCode);
  }
  expandedDescCodes.value = next;
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

      <!-- 影响板块：可点选页签（默认第一个板块，点选切换成分股列表）+ 实时涨幅 -->
      <section v-if="(boards?.length ?? 0) > 0" class="border-b border-flat-weak px-4 py-3">
        <h3 class="text-xs font-semibold text-text-secondary">影响板块</h3>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          <button
            v-for="theme in boards ?? []"
            :key="theme.id"
            type="button"
            class="pressable flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
            :class="theme.id === activeThemeId ? 'bg-primary-weak text-primary' : 'bg-flat-weak text-text-secondary'"
            :title="`查看「${theme.showName}」板块成分股`"
            @click="activeThemeId = theme.id"
          >
            <span>{{ theme.showName }}</span>
            <span
              class="tabular-nums"
              :class="themeRiseOf(theme.id) === null ? 'text-text-tertiary' : TREND_TEXT_CLASS[getTrendByChangePercent(themeRiseOf(theme.id) as number)]"
            >
              {{ themeRiseOf(theme.id) === null ? '—' : formatPercent(themeRiseOf(theme.id)) }}
            </span>
          </button>
        </div>
      </section>

      <!-- 成分股表格：名称代码 / 最新 / 涨幅 / 流通市值（行情三列走自有通道，涨停标红）；
           单击开侧栏 / 双击进详情页（左侧列表 = 卡片全部成分股）；行下可展开个股描述 -->
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
            <template v-for="row in group.rows" :key="row.stockCode">
              <tr
                class="cursor-pointer hover:bg-flat-weak"
                :title="`单击查看 ${row.stockName} 行情，双击进详情页`"
                @click="onStockRowClick(row)"
                @dblclick="onStockRowDblclick(row)"
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
              <!-- 个股描述块：默认一行，查看更多展开 / 收起（无数据不渲染） -->
              <tr v-if="descOf(row) !== null">
                <td colspan="4" class="border-b border-flat-weak px-4 pb-2 pt-0.5">
                  <div :class="expandedDescCodes.has(row.stockCode) ? '' : 'line-clamp-1'">
                    <div v-if="(descOf(row)?.tags.length ?? 0) > 0" class="mb-1 flex flex-wrap gap-1">
                      <span
                        v-for="tag in descOf(row)?.tags"
                        :key="tag"
                        class="rounded bg-flat-weak px-1.5 py-0.5 text-[10px] text-text-secondary"
                      >
                        {{ tag }}
                      </span>
                    </div>
                    <p
                      v-for="(text, index) in descOf(row)?.paragraphs"
                      :key="index"
                      class="text-xs leading-relaxed text-text-tertiary"
                    >
                      {{ text }}
                    </p>
                  </div>
                  <button
                    type="button"
                    class="pressable mt-0.5 inline-flex items-center text-xs text-primary hover:underline"
                    @click.stop="toggleDesc(row.stockCode)"
                  >
                    {{ expandedDescCodes.has(row.stockCode) ? '收起' : '查看更多' }}
                    <MenuIcon v-if="!expandedDescCodes.has(row.stockCode)" name="chevronRight" :size="12" />
                  </button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </section>

      <!-- 无成分股兜底 -->
      <BaseEmpty v-else class="py-6" description="暂无成分股数据" />
    </div>
  </div>
</template>
