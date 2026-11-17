<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import BaseButton from '../ui/BaseButton.vue';
import BaseCard from '../ui/BaseCard.vue';
import BaseEmpty from '../ui/BaseEmpty.vue';
import MenuIcon from '../ui/MenuIcon.vue';
import { fetchLatestHotConcepts } from '../../../common/api/hot-concept.api.ts';
import type { HotConceptEvent, HotConceptTopStock } from '../../../common/types/hot-concept.types.ts';
import { formatPercent } from '../../../common/utils/format-percent';
import { getTrendByChangePercent } from '../../../common/constants/trend.constants.ts';
import { TREND_PILL_CLASS } from '../../../common/constants/stock-colors.constants.ts';
import HotConceptDetailPanel from './HotConceptDetailPanel.vue';

/**
 * 今天题材（原「市场热点」，2026-11-17 王总指定更名；今天炒什么页首个默认页签）
 *
 * 数据源：同花顺 App 端 hot_concept 开放接口（news 同源、免鉴权，仅需浏览器 UA），
 * 解析最新交易日的热点事件清单；每个热点一张 375px 卡片（形式对齐股票热榜
 * 卡片流，横向滚动），卡片头部展示热点标题 / 热度 / 投资方向 / 关联题材 / 领涨股。
 *
 * 卡片本体为自渲染详情（2026-11-17 王总拍板弃 iframe，见 HotConceptDetailPanel）：
 * 题材解读 / 影响板块 / 成分股行情表走 jtcsm 开放接口 + 应用自有行情通道。
 * 原 iframe 方案的 dataq 401（hexin-v 顶层 URL 指纹反嵌）、切页闪刷、
 * 二级页无返回三大问题随架构根除。
 */

/** 最新交易日（YYYY-MM-DD） */
const tradeDate = ref('');

/** 热点事件列表（当日顺序） */
const events = ref<HotConceptEvent[]>([]);

/** 清单拉取中 */
const loading = ref(false);

/** 清单拉取失败 */
const error = ref(false);

/**
 * 热度值格式化（原始计数 → 万位缩写）
 * @param heat 热度原始值
 * @returns 形如 `69.1万` / `8,906` 的文案
 */
const formatHeat = (heat: number): string =>
  heat >= 10000 ? `${(heat / 10000).toFixed(1)}万` : String(heat);

/**
 * 领涨股展示口径（最多 3 只，剔除无代码的脏数据）
 * @param event 热点事件
 * @returns 领涨股列表
 */
const topStocksOf = (event: HotConceptEvent): HotConceptTopStock[] =>
  event.topStocks.filter((stock) => stock.stockCode !== '').slice(0, 3);

/** 拉取最新交易日热点清单（失败不清空旧数据，保留上次内容） */
const refresh = async (): Promise<void> => {
  loading.value = true;
  error.value = false;
  try {
    const { date, events: list } = await fetchLatestHotConcepts(true);
    tradeDate.value = date;
    events.value = list;
  } catch (err) {
    console.error('[hot-concept] 热点清单拉取失败', err);
    error.value = true;
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  void refresh();
});

/** 卡片渲染清单 */
const cardViews = computed(() => events.value);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <!-- 控制行：最新交易日 + 刷新（清单本身低频更新，不接行情轮询） -->
    <div class="flex shrink-0 items-center gap-2">
      <span v-if="tradeDate" class="text-xs text-text-tertiary">{{ tradeDate }} 热点</span>
      <BaseButton class="ml-auto" variant="ghost" :disabled="loading" @click="refresh">
        <MenuIcon name="refresh" :size="14" :class="{ 'animate-spin': loading }" />
        {{ loading ? '刷新中…' : '刷新' }}
      </BaseButton>
    </div>

    <!-- 拉取失败（有旧数据时保留展示，仅控制行提示） -->
    <BaseEmpty
      v-if="error && events.length === 0"
      class="min-h-0 flex-1"
      description="热点清单拉取失败，请点击「刷新」重试"
    />

    <!-- 空态 -->
    <BaseEmpty v-else-if="!loading && events.length === 0" class="min-h-0 flex-1" description="暂无今天题材" />

    <!-- 热点卡片流：横向滚动（形式对齐股票热榜卡片流）；卡片本体自渲染详情 -->
    <div v-else class="flex min-h-0 flex-1 gap-4 overflow-x-auto">
      <BaseCard
        v-for="card in cardViews"
        :key="card.eventId"
        class="!flex !h-full !w-[375px] !shrink-0 !flex-col !overflow-hidden !p-0"
      >
        <!-- 卡片头部：热点标题 + 热度 -->
        <header class="shrink-0 border-b border-flat-weak px-4 py-3">
          <div class="flex items-start justify-between gap-2">
            <h2 class="line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-snug text-text" :title="card.title">
              {{ card.title }}
            </h2>
            <span
              class="shrink-0 rounded bg-flat-weak px-1.5 py-0.5 text-xs tabular-nums text-text-tertiary"
              :title="`热度 ${card.heat}`"
            >
              热 {{ formatHeat(card.heat) }}
            </span>
          </div>
          <!-- 投资方向 + 关联题材 chips -->
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              v-if="card.investmentDirection"
              class="rounded bg-primary-weak px-1.5 py-0.5 text-xs text-primary"
            >
              {{ card.investmentDirection }}
            </span>
            <span
              v-for="theme in card.themes.slice(0, 4)"
              :key="theme.id"
              class="rounded bg-flat-weak px-1.5 py-0.5 text-xs text-text-tertiary"
            >
              {{ theme.showName }}
            </span>
          </div>
          <!-- 领涨股 pills（涨跌幅红涨绿跌） -->
          <div v-if="topStocksOf(card).length > 0" class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="stock in topStocksOf(card)"
              :key="stock.stockCode"
              class="rounded px-1.5 py-0.5 text-xs tabular-nums"
              :class="TREND_PILL_CLASS[getTrendByChangePercent(stock.risePercent)]"
            >
              {{ stock.stockName }} {{ formatPercent(stock.risePercent) }}
            </span>
          </div>
        </header>

        <!-- 卡片本体：自渲染详情（题材解读 / 影响板块 / 成分股行情表） -->
        <HotConceptDetailPanel class="min-h-0 flex-1" :event-id="card.eventId" />
      </BaseCard>
    </div>
  </div>
</template>
