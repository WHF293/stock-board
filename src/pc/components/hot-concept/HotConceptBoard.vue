<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
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
 * 卡片本体为热点二级页 iframe（news.10jqka.com.cn/app/hot_concept/v2/detail，
 * 已实测无 X-Frame-Options 限制可嵌）；暗色模式下 iframe 挂反色滤镜跟随应用主题
 * （上游原生 dark 类跨域不可触达，见 HOT_CONCEPT_DARK_FILTER 说明）。
 *
 * iframe 常驻图层（2026-11-17 王总指定优化，解决切换闪刷）：
 * iframe 元素挂在 body 级常驻图层（不入 Vue 虚拟树、永不脱离文档）——
 * 切页签的 v-if 卸载 / 切页的 KeepAlive 容器搬运都不会销毁其浏览上下文，
 * 组件侧只渲染占位槽位，rAF 循环把 iframe 同步到槽位的视口坐标上，
 * 切换时图层整体 display:none 隐藏（元素仍挂在文档里，不触发重载）。
 *
 * 上一页 / 下一页（2026-11-17 王总指定新增）：跨域 iframe 的 history 对
 * 父页面完全不可访问，故在组件侧自管路由堆栈——可还原的只有自己赋 src 的
 * 地址；iframe 内点进的子页 URL 跨域读不到（堆栈记 null，「上一页」直接回
 * 跳最近一个已知地址）。「下一页」仅在被回跳后的已知地址间可用。
 *
 * 已知上游限制（2026-11-17 实测）：详情页内的实时行情走 dataq.10jqka.com.cn，
 * 其 hexin-v 反爬 token 把顶层页面 URL 织进指纹校验——顶层为非同花顺域名时
 * 一律 401（about:blank 顶层例外；静态内容走的 news.10jqka.com.cn 同源接口
 * 不受限）。这是上游主动反嵌限制，网页侧无法绕过；完整行情请点卡片标题在
 * 浏览器打开原页。
 */

/** 上游行情接口在嵌入页不可用的提示文案（控制行展示） */
const UPSTREAM_QUOTE_LIMIT_TIP =
  '卡内为热点详情页：题材解读 / 板块 / 成分股可用；实时行情接口受同花顺反嵌限制不可用，完整行情点标题在浏览器打开。';

/** iframe 元素注册表（eventId → 条目；模块级，跨组件重挂载存活） */
interface FrameEntry {
  /** iframe 元素（挂在常驻图层上） */
  el: HTMLIFrameElement;
  /** 组件里的占位槽位（rAF 同步坐标的基准） */
  slot: HTMLElement;
  /** 路由堆栈（已知地址 / null = iframe 内点进、跨域读不到地址的子页） */
  stack: (string | null)[];
  /** 当前堆栈游标 */
  idx: number;
  /** 本次 load 是否由我们赋 src 触发（区分已知导航与 iframe 内点进） */
  pendingKnown: boolean;
  /** 建帧时的根地址（清单刷新后 index 变化则重建帧） */
  rootUrl: string;
}

const frames = new Map<string, FrameEntry>();

/** body 级常驻图层单例（pointer-events 关，仅 iframe 自身可交互） */
const FRAME_LAYER_ID = 'hot-concept-frame-layer';
let frameLayerEl: HTMLDivElement | null = null;

/**
 * 取常驻图层（无则创建：fixed 铺满视口、z 在页面内容之上弹窗之下、默认隐藏）
 * @returns 图层元素
 */
const ensureFrameLayer = (): HTMLDivElement => {
  if (frameLayerEl?.isConnected) return frameLayerEl;
  const el = document.createElement('div');
  el.id = FRAME_LAYER_ID;
  el.style.cssText = 'position:fixed;inset:0;z-index:30;pointer-events:none;display:none;';
  document.body.appendChild(el);
  frameLayerEl = el;
  return el;
};

/** 当前主题（iframe 反色滤镜跟随） */
const { isDark } = useTheme();

/**
 * 应用主题滤镜到所有 iframe（暗色反色、亮色还原）
 */
const applyThemeFilter = (): void => {
  for (const entry of frames.values()) {
    entry.el.style.filter = isDark.value ? HOT_CONCEPT_DARK_FILTER : 'none';
  }
};

watch(isDark, applyThemeFilter);

/** 最新交易日（YYYY-MM-DD） */
const tradeDate = ref('');

/** 热点事件列表（当日顺序，index 即二级页参数） */
const events = ref<HotConceptEvent[]>([]);

/** 清单拉取中 */
const loading = ref(false);

/** 清单拉取失败 */
const error = ref(false);

/** 已完成首帧加载的 iframe 集合（eventId → true，骨架屏判定；帧跨切换存活故不随刷新重置） */
const loadedMap = ref<Record<string, boolean>>({});

/** 页签导航按钮状态（eventId → 上一页 / 下一页可用性） */
const navState = reactive<Record<string, { canBack: boolean; canForward: boolean }>>({});

/** 图层是否应显示（组件挂载 && 页面激活 && 本页签激活） */
const layerVisible = ref(false);

/** rAF 同步循环句柄（0 = 未运行） */
let rafId = 0;

/**
 * rAF 同步循环：把每个 iframe 摆到其槽位的视口坐标上（fixed 图层 + 视口坐标，
 * 页面横滚 / 纵滚 / 窗口缩放都会在下一帧跟上）
 */
const syncFrames = (): void => {
  if (!layerVisible.value || !frameLayerEl) {
    rafId = 0;
    return;
  }
  for (const entry of frames.values()) {
    if (!entry.slot.isConnected) continue;
    const rect = entry.slot.getBoundingClientRect();
    const style = entry.el.style;
    style.left = `${rect.left}px`;
    style.top = `${rect.top}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
  }
  rafId = requestAnimationFrame(syncFrames);
};

/**
 * 启动同步循环（幂等）
 */
const startSync = (): void => {
  if (rafId === 0) rafId = requestAnimationFrame(syncFrames);
};

/**
 * 切换图层显隐（隐藏只是 display:none，iframe 元素仍挂在文档里不触发重载）
 * @param visible 是否显示
 */
const setLayerVisible = (visible: boolean): void => {
  layerVisible.value = visible;
  const layer = ensureFrameLayer();
  layer.style.display = visible ? 'block' : 'none';
  if (visible) startSync();
};

/**
 * 刷新导航按钮状态（写响应式记录供模板消费）
 * @param eventId 事件 id
 */
const updateNavState = (eventId: string): void => {
  const entry = frames.get(eventId);
  if (!entry) return;
  navState[eventId] = {
    canBack: entry.idx > 0,
    canForward: entry.idx < entry.stack.length - 1 && entry.stack[entry.idx + 1] !== null,
  };
};

/**
 * 导航到堆栈指定游标的地址（赋 src 触发已知导航）
 * @param entry 帧条目
 * @param eventId 事件 id
 */
const navigateToIdx = (entry: FrameEntry, eventId: string): void => {
  const url = entry.stack[entry.idx];
  if (url) {
    entry.pendingKnown = true;
    entry.el.src = url;
  }
  updateNavState(eventId);
};

/**
 * iframe load 回调：已知导航清标记；iframe 内点进的子页（跨域读不到地址）
 * 在堆栈顶记 null。建帧时 Chromium 可能先派发一次 about:blank 空白页 load，
 * 按已知导航吞掉（不推进堆栈）。
 * @param eventId 事件 id
 */
const onFrameLoad = (eventId: string): void => {
  const entry = frames.get(eventId);
  if (!entry) return;
  if (entry.el.contentWindow?.location.href === 'about:blank') return;
  loadedMap.value = { ...loadedMap.value, [eventId]: true };
  if (entry.pendingKnown) {
    entry.pendingKnown = false;
    updateNavState(eventId);
    return;
  }
  entry.stack = entry.stack.slice(0, entry.idx + 1);
  entry.stack.push(null);
  entry.idx += 1;
  updateNavState(eventId);
};

/**
 * 上一页：回跳到最近一个已知地址（iframe 内点进的未知子页无法原样还原，
 * 直接越过并从堆栈丢弃；根地址恒已知，idx>0 时必能回跳）
 * @param eventId 事件 id
 */
const goBack = (eventId: string): void => {
  const entry = frames.get(eventId);
  if (!entry || entry.idx === 0) return;
  let i = entry.idx - 1;
  while (i > 0 && entry.stack[i] === null) i -= 1;
  entry.idx = i;
  entry.stack = entry.stack.slice(0, i + 1);
  navigateToIdx(entry, eventId);
};

/**
 * 下一页：仅在回跳落点之后仍是已知地址时可用（未知子页不可还原，前进无效）
 * @param eventId 事件 id
 */
const goForward = (eventId: string): void => {
  const entry = frames.get(eventId);
  if (!entry) return;
  if (entry.idx < entry.stack.length - 1 && entry.stack[entry.idx + 1] !== null) {
    entry.idx += 1;
    navigateToIdx(entry, eventId);
  }
};

/** 占位槽位元素表（eventId → 槽位；v-for ref 注册，随组件重挂重建） */
const slotEls = new Map<string, HTMLElement>();

/**
 * 确保某事件卡的 iframe 存在（无则建帧挂图层；根地址变化则重建）
 * @param eventId 事件 id
 * @param rootUrl 二级页根地址
 */
const ensureFrame = (eventId: string, rootUrl: string): void => {
  const existing = frames.get(eventId);
  if (existing) {
    if (existing.rootUrl === rootUrl) return;
    existing.el.remove();
    frames.delete(eventId);
  }
  const el = document.createElement('iframe');
  el.style.cssText = 'position:absolute;border:0;background:#fff;pointer-events:auto;';
  el.title = eventId;
  el.addEventListener('load', () => onFrameLoad(eventId));
  el.src = rootUrl;
  ensureFrameLayer().appendChild(el);
  const slot = slotEls.get(eventId);
  frames.set(eventId, { el, slot: slot ?? document.createElement('div'), stack: [rootUrl], idx: 0, pendingKnown: true, rootUrl });
  loadedMap.value = { ...loadedMap.value, [eventId]: false };
  applyThemeFilter();
  updateNavState(eventId);
};

/**
 * 注册占位槽位（模板 ref 回调；槽位随组件重挂重建，帧元素不重建）
 * @param eventId 事件 id
 * @param el 槽位元素（卸载时为 null）
 */
const registerSlot = (eventId: string, el: unknown): void => {
  if (el instanceof HTMLElement) {
    slotEls.set(eventId, el);
    const entry = frames.get(eventId);
    if (entry) entry.slot = el;
  } else {
    slotEls.delete(eventId);
  }
};

/** 卡片渲染清单（携带二级页地址） */
const cardViews = computed(() =>
  events.value.map((event, index) => ({
    event,
    index,
    detailUrl: buildHotConceptDetailUrl(event.eventId, index),
  })),
);

/** 清单变化：为每个事件建帧 / 根地址变化重建，并清掉已不存在事件的孤儿帧 */
watch(cardViews, (cards) => {
  const alive = new Set<string>();
  for (const card of cards) {
    alive.add(card.event.eventId);
    ensureFrame(card.event.eventId, card.detailUrl);
  }
  for (const [eventId, entry] of frames) {
    if (!alive.has(eventId)) {
      entry.el.remove();
      frames.delete(eventId);
      delete navState[eventId];
    }
  }
});

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
    // 不重置 loadedMap：旧帧保留不闪刷，新帧在 ensureFrame 里单独标记未加载
  } catch (err) {
    console.error('[hot-concept] 热点清单拉取失败', err);
    error.value = true;
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  void refresh();
  setLayerVisible(true);
});

// KeepAlive 页切走 / 回来：隐藏 / 恢复图层（iframe 元素不动，不触发重载）
onActivated(() => setLayerVisible(true));
onDeactivated(() => setLayerVisible(false));

onBeforeUnmount(() => {
  setLayerVisible(false);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <!-- 控制行：最新交易日 + 刷新（清单本身低频更新，不接行情轮询） -->
    <div class="flex shrink-0 items-center gap-2">
      <span v-if="tradeDate" class="text-xs text-text-tertiary">{{ tradeDate }} 热点</span>
      <span class="min-w-0 truncate text-xs text-text-tertiary" :title="UPSTREAM_QUOTE_LIMIT_TIP">
        {{ UPSTREAM_QUOTE_LIMIT_TIP }}
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

    <!-- 热点卡片流：横向滚动（形式对齐股票热榜卡片流）；卡片本体只渲染
         槽位与导航条，iframe 由常驻图层按槽位坐标摆放（切页签 / 切页不闪刷） -->
    <div v-else class="flex min-h-0 flex-1 gap-4 overflow-x-auto">
      <BaseCard
        v-for="card in cardViews"
        :key="card.event.eventId"
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

        <!-- 路由堆栈切换条（2026-11-17 王总指定新增）：跨域 iframe 的 history
             不可访问，组件侧自管堆栈——「上一页」回跳最近已知地址（卡内点进的
             子页读不到地址，越过并丢弃）；「下一页」仅在已知地址间可用 -->
        <div class="flex shrink-0 items-center gap-1 border-b border-flat-weak px-3 py-1">
          <button
            type="button"
            class="rounded p-1 text-text-tertiary hover:bg-flat-weak hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!navState[card.event.eventId]?.canBack"
            title="上一页（回到最近可还原的页面）"
            @click="goBack(card.event.eventId)"
          >
            <MenuIcon name="chevronLeft" :size="14" />
          </button>
          <button
            type="button"
            class="rounded p-1 text-text-tertiary hover:bg-flat-weak hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!navState[card.event.eventId]?.canForward"
            title="下一页（仅回跳前的已知页面可前进）"
            @click="goForward(card.event.eventId)"
          >
            <MenuIcon name="chevronRight" :size="14" />
          </button>
          <span class="ml-1 truncate text-xs text-text-tertiary">页内点进的子页用 ‹ 返回</span>
        </div>

        <!-- 卡片本体槽位：iframe 由常驻图层按此区域坐标摆放 -->
        <div :ref="(el) => registerSlot(card.event.eventId, el)" class="relative min-h-0 flex-1 bg-white">
          <div
            v-if="!loadedMap[card.event.eventId]"
            class="absolute inset-0 flex items-start justify-center overflow-hidden p-4"
          >
            <BaseSkeleton class="w-full pt-6">
              <div class="h-4 w-3/4 rounded bg-flat-weak" />
              <div class="h-3 w-full rounded bg-flat-weak" />
              <div class="h-3 w-5/6 rounded bg-flat-weak" />
              <div class="h-3 w-2/3 rounded bg-flat-weak" />
            </BaseSkeleton>
          </div>
        </div>
      </BaseCard>
    </div>
  </div>
</template>
