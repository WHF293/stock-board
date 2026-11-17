<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import BaseButton from '../ui/BaseButton.vue';
import BaseCard from '../ui/BaseCard.vue';
import BaseEmpty from '../ui/BaseEmpty.vue';
import BaseSkeleton from '../ui/BaseSkeleton.vue';
import MenuIcon from '../ui/MenuIcon.vue';
import { fetchLatestHotConcepts, buildHotConceptDetailUrl } from '../../../common/api/hot-concept.api.ts';
import { HOT_CONCEPT_DARK_FILTER } from '../../../common/constants/hot-concept.constants.ts';
import type { HotConceptEvent, HotConceptTopStock } from '../../../common/types/hot-concept.types.ts';
import { formatPercent } from '../../../common/utils/format-percent';
import { useTheme } from '../../../common/composables/use-theme';
import { getTrendByChangePercent } from '../../../common/constants/trend.constants.ts';
import { TREND_PILL_CLASS } from '../../../common/constants/stock-colors.constants.ts';

/**
 * 今天题材（原「市场热点」，2026-11-17 王总指定更名；今天炒什么页首个默认页签）
 *
 * 数据源：同花顺 App 端 hot_concept 开放接口（免鉴权，GET），解析最新交易日的
 * 热点事件清单；每个热点一张 375px 卡片（形式对齐股票热榜卡片流，横向滚动），
 * 卡片头部展示热点标题 / 热度 / 投资方向 / 关联题材 / 领涨股，
 * 卡片本体为 iframe 直嵌热点二级页（news.10jqka.com.cn/app/hot_concept/v2/detail，
 * 已实测无 X-Frame-Options 限制可嵌）——二级页内的个股行情由上游自行渲染；
 * 暗色模式下 iframe 挂反色滤镜跟随应用主题（上游原生 dark 类跨域不可触达，
 * 见 HOT_CONCEPT_DARK_FILTER 说明）
 */

const { isDark } = useTheme();

/** iframe 元素上的暗色反色滤镜（亮色模式不挂滤镜；应用主题切换即自动跟随） */
const frameStyle = computed(() => ({
  filter: isDark.value ? HOT_CONCEPT_DARK_FILTER : 'none',
}));

/** 最新交易日（YYYY-MM-DD） */
const tradeDate = ref('');

/** 热点事件列表（当日顺序，index 即二级页参数） */
const events = ref<HotConceptEvent[]>([]);

/** 清单拉取中 */
const loading = ref(false);

/** 清单拉取失败 */
const error = ref(false);

/** 刷新计数（iframe :key 组成部分，强制刷新时重挂全部 iframe） */
const refreshTick = ref(0);

/** 已完成加载的 iframe 集合（eventId，骨架屏判定） */
const loadedIframes = ref(new Set<string>());

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

/**
 * iframe 加载完成回调（骨架屏切换）
 * @param eventId 事件 id
 */
const onIframeLoad = (eventId: string): void => {
  loadedIframes.value.add(eventId);
};

/** 拉取最新交易日热点清单（失败不清空旧数据，保留上次内容） */
const refresh = async (): Promise<void> => {
  loading.value = true;
  error.value = false;
  try {
    const { date, events: list } = await fetchLatestHotConcepts(true);
    tradeDate.value = date;
    events.value = list;
    loadedIframes.value = new Set();
    refreshTick.value += 1;
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

/** 卡片渲染清单（携带二级页地址） */
const cardViews = computed(() =>
  events.value.map((event, index) => ({
    event,
    index,
    detailUrl: buildHotConceptDetailUrl(event.eventId, index),
  })),
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <!-- 控制行：最新交易日 + 刷新（清单本身低频更新，不接行情轮询） -->
    <div class="flex shrink-0 items-center gap-2">
      <span v-if="tradeDate" class="text-xs text-text-tertiary">{{ tradeDate }} 热点</span>
      <span class="text-xs text-text-tertiary">
        每个热点一张卡片，卡片内为热点详情二级页 · 点击卡片标题可在浏览器打开原页
      </span>
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

    <!-- 热点卡片流：横向滚动（形式对齐股票热榜卡片流），卡片本体 = 二级页 iframe -->
    <div v-else class="flex min-h-0 flex-1 gap-4 overflow-x-auto">
      <BaseCard
        v-for="card in cardViews"
        :key="`${card.event.eventId}#${refreshTick}`"
        class="!flex !h-full !w-[375px] !shrink-0 !flex-col !overflow-hidden !p-0"
      >
        <!-- 卡片头部：热点标题（点按可在浏览器打开原页）+ 热度 -->
        <header class="shrink-0 border-b border-flat-weak px-4 py-3">
          <div class="flex items-start justify-between gap-2">
            <a
              class="line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-snug text-text hover:text-primary active:opacity-80"
              :href="card.detailUrl"
              target="_blank"
              rel="noopener noreferrer"
              :title="card.event.title"
            >
              {{ card.event.title }}
            </a>
            <span
              class="shrink-0 rounded bg-flat-weak px-1.5 py-0.5 text-xs tabular-nums text-text-tertiary"
              :title="`热度 ${card.event.heat}`"
            >
              热 {{ formatHeat(card.event.heat) }}
            </span>
          </div>
          <!-- 投资方向 + 关联题材 chips -->
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              v-if="card.event.investmentDirection"
              class="rounded bg-primary-weak px-1.5 py-0.5 text-xs text-primary"
            >
              {{ card.event.investmentDirection }}
            </span>
            <span
              v-for="theme in card.event.themes.slice(0, 4)"
              :key="theme.id"
              class="rounded bg-flat-weak px-1.5 py-0.5 text-xs text-text-tertiary"
            >
              {{ theme.showName }}
            </span>
          </div>
          <!-- 领涨股 pills（涨跌幅红涨绿跌） -->
          <div v-if="topStocksOf(card.event).length > 0" class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="stock in topStocksOf(card.event)"
              :key="stock.stockCode"
              class="rounded px-1.5 py-0.5 text-xs tabular-nums"
              :class="TREND_PILL_CLASS[getTrendByChangePercent(stock.risePercent)]"
            >
              {{ stock.stockName }} {{ formatPercent(stock.risePercent) }}
            </span>
          </div>
        </header>

        <!-- 卡片本体：热点二级页 iframe（上游自行渲染个股行情与资讯） -->
        <div class="relative min-h-0 flex-1 bg-white">
          <div
            v-if="!loadedIframes.has(card.event.eventId)"
            class="absolute inset-0 flex items-start justify-center overflow-hidden p-4"
          >
            <BaseSkeleton class="w-full pt-6">
              <div class="h-4 w-3/4 rounded bg-flat-weak" />
              <div class="h-3 w-full rounded bg-flat-weak" />
              <div class="h-3 w-5/6 rounded bg-flat-weak" />
              <div class="h-3 w-2/3 rounded bg-flat-weak" />
            </BaseSkeleton>
          </div>
          <iframe
            class="h-full w-full border-0"
            :src="card.detailUrl"
            :style="frameStyle"
            :title="card.event.title"
            loading="lazy"
            referrerpolicy="no-referrer"
            @load="onIframeLoad(card.event.eventId)"
          />
        </div>
      </BaseCard>
    </div>
  </div>
</template>
