<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseEmpty from '../../ui/BaseEmpty.vue';
import BaseTable from '../../ui/BaseTable.vue';
import BaseTabs from '../../ui/BaseTabs.vue';
import MenuIcon from '../../ui/MenuIcon.vue';
import type {
  TzzbFundTrade,
  TzzbStockTrade,
  TzzbStockTradePage,
} from '../../../../common/types/tzzb.types.ts';
import type { TableColumn } from '../../../../common/types/table.types.ts';

/**
 * 投资账本 · 交易记录（页签在卡片标题行右侧，由父级 TzzbDashboard 管理）
 *
 * - 股票流水：queryMoneyHistory 分页（无成交时间字段，仅到日）；
 * - 基金流水：queryFundSummaryHistory（六元组重复行已在解析层去重）；
 * - 视图切换【明细 / 按品种汇总】（2026-11-09 王总指定）：明细为原平铺列表；
 *   汇总按个股 / 个基分组给出合计指标，点击分组展开该品种的明细行
 *   （股票汇总口径用全量流水 allStockTrades，分页首页覆盖不全）；
 * - 行 / 品种名交互（2026-11-10 王总指定，全站统一口径）：单击开侧栏 / 双击进详情
 */
const props = defineProps<{
  /** 当前页签（stock / fund；父级页签条管理） */
  tab: string;
  /** 股票流水分页（明细视图） */
  stockTrades: TzzbStockTradePage | null;
  /** 全量股票流水（汇总视图口径；父级摩擦账本同源，逐页合并） */
  allStockTrades?: TzzbStockTrade[] | null;
  /** 基金流水 */
  fundTrades: TzzbFundTrade[];
}>();

const emit = defineEmits<{
  /** 股票流水翻页（从 1 起） */
  page: [page: number];
  /** 单击行 / 品种名：打开个股或基金详情侧栏（2026-11-10 王总指定全站统一口径） */
  open: [code: string];
  /** 双击行 / 品种名：跳个股详情整页 */
  openPage: [code: string];
}>();

/** 视图模式：detail 平铺明细 / summary 按品种汇总（2026-11-10 起默认汇总） */
const VIEW_OPTIONS = [
  { label: '明细', value: 'detail' },
  { label: '按品种汇总', value: 'summary' },
];
const view = ref<string>('summary');

/** 汇总视图展开的品种（code 集合；点击分组行展开 / 收起明细） */
const expanded = ref<Set<string>>(new Set());

/**
 * 切换品种展开态
 * @param code 证券代码
 */
const toggleExpand = (code: string): void => {
  const next = new Set(expanded.value);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  expanded.value = next;
};

/* ---- 股票流水 ---- */

const stockColumns: TableColumn<TzzbStockTradePage['list'][number]>[] = [
  { key: 'date', label: '成交日期', sortable: true, sortValue: (r) => r.date },
  { key: 'name', label: '证券' },
  { key: 'action', label: '操作' },
  { key: 'price', label: '成交价', align: 'right', sortable: true, sortValue: (r) => r.price },
  { key: 'quantity', label: '数量', align: 'right', sortable: true, sortValue: (r) => r.quantity },
  { key: 'amount', label: '成交金额', align: 'right', sortable: true, sortValue: (r) => r.amount },
  { key: 'commission', label: '佣金', align: 'right' },
  { key: 'transferFee', label: '过户费', align: 'right' },
  { key: 'feeTotal', label: '费用合计', align: 'right' },
];

/** 汇总视图展开后的品种明细列（去掉证券列，标题行已标明品种） */
const stockDetailColumns: TableColumn<TzzbStockTrade>[] = stockColumns.filter((c) => c.key !== 'name');

/** 汇总视图的股票全量口径（全量流水优先，退回分页首页） */
const stockSource = computed<TzzbStockTrade[]>(() => props.allStockTrades ?? props.stockTrades?.list ?? []);

/** 股票按品种汇总分组（按合计盈亏方向排序：买卖金额净额） */
interface StockSummaryGroup {
  code: string;
  name: string;
  count: number;
  buyCount: number;
  sellCount: number;
  buyAmount: number;
  sellAmount: number;
  feeTotal: number;
  /** 最后一笔成交日 */
  lastDate: string;
  trades: TzzbStockTrade[];
}

const stockGroups = computed<StockSummaryGroup[]>(() => {
  const map = new Map<string, StockSummaryGroup>();
  for (const t of stockSource.value) {
    const g = map.get(t.code) ?? {
      code: t.code,
      name: t.name,
      count: 0,
      buyCount: 0,
      sellCount: 0,
      buyAmount: 0,
      sellAmount: 0,
      feeTotal: 0,
      lastDate: '',
      trades: [],
    };
    g.count += 1;
    if (t.action === '买入') {
      g.buyCount += 1;
      g.buyAmount += t.amount;
    } else {
      g.sellCount += 1;
      g.sellAmount += t.amount;
    }
    g.feeTotal += t.feeTotal;
    if (t.date > g.lastDate) g.lastDate = t.date;
    g.trades.push(t);
    map.set(t.code, g);
  }
  return [...map.values()].sort((a, b) => b.buyAmount + b.sellAmount - (a.buyAmount + a.sellAmount));
});

/**
 * 数量文案（千分位；方向由操作列表达）
 * @param v 数量
 * @returns 千分位文案
 */
const qty = (v: number): string => v.toLocaleString('zh-CN');

/**
 * 千分位金额
 * @param v 数值
 * @returns 千分位两位小数文案
 */
const yuan = (v: number): string =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 页码列表（maxPage 截取，最多展示 8 页） */
const pages = computed(() => {
  const max = props.stockTrades?.maxPage ?? 1;
  return Array.from({ length: Math.min(max, 8) }, (_, i) => i + 1);
});

/** 当前页码 */
const currentPage = computed(() => props.stockTrades?.page ?? 1);

/** 基金流水列 */
const fundColumns: TableColumn<TzzbFundTrade>[] = [
  { key: 'date', label: '确认日期', sortable: true, sortValue: (r) => r.date },
  { key: 'accountName', label: '账户' },
  { key: 'name', label: '基金' },
  { key: 'action', label: '操作' },
  { key: 'amount', label: '交易金额', align: 'right', sortable: true, sortValue: (r) => r.amount },
  { key: 'shares', label: '交易份额', align: 'right', sortable: true, sortValue: (r) => r.shares },
];

/** 汇总视图展开后的基金明细列（去掉基金列） */
const fundDetailColumns: TableColumn<TzzbFundTrade>[] = fundColumns.filter((c) => c.key !== 'name');

/** 基金按品种汇总分组 */
interface FundSummaryGroup {
  code: string;
  name: string;
  count: number;
  /** 合计交易金额（申赎同号累加，方向看操作列） */
  amountTotal: number;
  sharesTotal: number;
  lastDate: string;
  trades: TzzbFundTrade[];
}

const fundGroups = computed<FundSummaryGroup[]>(() => {
  const map = new Map<string, FundSummaryGroup>();
  for (const t of props.fundTrades) {
    const g = map.get(t.code) ?? {
      code: t.code,
      name: t.name,
      count: 0,
      amountTotal: 0,
      sharesTotal: 0,
      lastDate: '',
      trades: [],
    };
    g.count += 1;
    g.amountTotal += t.amount;
    g.sharesTotal += t.shares;
    if (t.date > g.lastDate) g.lastDate = t.date;
    g.trades.push(t);
    map.set(t.code, g);
  }
  return [...map.values()].sort((a, b) => b.amountTotal - a.amountTotal);
});
</script>

<template>
  <div>
    <!-- 视图切换：明细 / 按品种汇总 -->
    <div class="mb-2">
      <BaseTabs v-model="view" :options="VIEW_OPTIONS" />
    </div>

    <!-- ================= 股票流水 ================= -->
    <template v-if="tab === 'stock'">
      <!-- 明细（原平铺列表） -->
      <template v-if="view === 'detail'">
        <BaseTable
          v-if="stockTrades && stockTrades.list.length > 0"
          :columns="stockColumns"
          :rows="stockTrades.list"
          :row-key="(r) => `${r.date}-${r.code}-${r.action}-${r.quantity}-${r.price}`"
          :min-width="'820px'"
          row-clickable
          enable-dblclick-nav
          :footer-text="`第 ${currentPage} / ${stockTrades.maxPage} 页 · 单击开侧栏 / 双击进详情`"
          @row-click="(r) => emit('open', r.code)"
          @row-dblclick="(r) => emit('openPage', r.code)"
        >
          <template #name="{ row }">
            <span class="font-medium text-text">{{ row.name }}</span>
            <span class="ml-1 font-mono text-xs text-text-tertiary">{{ row.code }}</span>
          </template>
          <template #action="{ row }">
            <span
              class="rounded-full px-2 py-0.5 text-xs"
              :class="row.action === '买入' ? 'bg-up-weak text-up' : 'bg-down-weak text-down'"
            >
              {{ row.action }}
            </span>
          </template>
          <template #price="{ row }"><span class="font-mono tabular-nums">{{ row.price }}</span></template>
          <template #quantity="{ row }"><span class="font-mono tabular-nums">{{ qty(row.quantity) }}</span></template>
          <template #amount="{ row }"><span class="font-mono tabular-nums">{{ yuan(row.amount) }}</span></template>
          <template #commission="{ row }"><span class="font-mono tabular-nums">{{ row.commission }}</span></template>
          <template #transferFee="{ row }"><span class="font-mono tabular-nums">{{ row.transferFee }}</span></template>
          <template #feeTotal="{ row }"><span class="font-mono tabular-nums">{{ row.feeTotal }}</span></template>
        </BaseTable>
        <BaseEmpty v-else text="暂无股票流水：同步投资账本后自动填充" />

        <!-- 分页 -->
        <div v-if="(stockTrades?.maxPage ?? 1) > 1" class="mt-2 flex items-center gap-1.5">
          <button
            v-for="p in pages"
            :key="p"
            type="button"
            class="pressable h-7 min-w-7 rounded-md px-2 font-mono text-xs"
            :class="p === currentPage ? 'bg-primary text-on-primary' : 'bg-flat-weak text-text-secondary hover:text-text'"
            @click="p !== currentPage && emit('page', p)"
          >
            {{ p }}
          </button>
          <span class="text-xs text-text-tertiary">第 {{ currentPage }} / {{ stockTrades?.maxPage }} 页</span>
        </div>
      </template>

      <!-- 按品种汇总：点击分组展开明细 -->
      <template v-else>
        <BaseEmpty v-if="stockGroups.length === 0" text="暂无股票流水：同步投资账本后自动填充" />
        <div v-else class="flex flex-col gap-1.5">
          <div
            v-for="g in stockGroups"
            :key="g.code"
            class="overflow-hidden rounded-xl border border-flat-weak"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 bg-flat-weak/40 px-3 py-2.5 text-left transition-colors hover:bg-flat-weak"
              @click="toggleExpand(g.code)"
            >
              <MenuIcon
                name="chevronRight"
                :size="14"
                class="shrink-0 text-text-tertiary transition-transform"
                :class="expanded.has(g.code) ? 'rotate-90' : ''"
              />
              <div
                class="min-w-0 flex-1 cursor-pointer"
                title="单击开侧栏 / 双击进详情 · 行其他位置展开明细"
                @click.stop="emit('open', g.code)"
                @dblclick.stop="emit('openPage', g.code)"
              >
                <p class="truncate text-sm font-medium text-text">
                  {{ g.name }}
                  <span class="ml-1 font-mono text-xs text-text-tertiary">{{ g.code }}</span>
                </p>
                <p class="mt-0.5 text-xs text-text-tertiary">
                  {{ g.count }} 笔（买 {{ g.buyCount }} / 卖 {{ g.sellCount }}）· 最近成交 {{ g.lastDate }}
                </p>
              </div>
              <div class="shrink-0 text-right font-mono text-xs tabular-nums">
                <p class="text-up">买 ¥{{ yuan(g.buyAmount) }}</p>
                <p class="text-down">卖 ¥{{ yuan(g.sellAmount) }}</p>
              </div>
              <div class="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-text-secondary">
                <p>费用 {{ yuan(g.feeTotal) }}</p>
                <p :class="g.sellAmount - g.buyAmount >= 0 ? 'text-text-secondary' : 'text-text-secondary'">
                  净 ¥{{ yuan(g.sellAmount - g.buyAmount) }}
                </p>
              </div>
            </button>
            <!-- 展开的品种明细 -->
            <BaseTable
              v-if="expanded.has(g.code)"
              :columns="stockDetailColumns"
              :rows="g.trades"
              :row-key="(r) => `${r.date}-${r.action}-${r.quantity}-${r.price}`"
              :min-width="'720px'"
              scroll-class="table-scroll-sm"
              row-clickable
              enable-dblclick-nav
              @row-click="(r) => emit('open', r.code)"
              @row-dblclick="(r) => emit('openPage', r.code)"
            >
              <template #action="{ row }">
                <span
                  class="rounded-full px-2 py-0.5 text-xs"
                  :class="row.action === '买入' ? 'bg-up-weak text-up' : 'bg-down-weak text-down'"
                >
                  {{ row.action }}
                </span>
              </template>
              <template #price="{ row }"><span class="font-mono tabular-nums">{{ row.price }}</span></template>
              <template #quantity="{ row }"><span class="font-mono tabular-nums">{{ qty(row.quantity) }}</span></template>
              <template #amount="{ row }"><span class="font-mono tabular-nums">{{ yuan(row.amount) }}</span></template>
              <template #commission="{ row }"><span class="font-mono tabular-nums">{{ row.commission }}</span></template>
              <template #transferFee="{ row }"><span class="font-mono tabular-nums">{{ row.transferFee }}</span></template>
              <template #feeTotal="{ row }"><span class="font-mono tabular-nums">{{ row.feeTotal }}</span></template>
            </BaseTable>
          </div>
          <p class="text-xs text-text-tertiary">
            共 {{ stockGroups.length }} 个品种 · 点击分组行展开逐笔明细（口径：全量流水，同步水位内）
          </p>
        </div>
      </template>
    </template>

    <!-- ================= 基金流水 ================= -->
    <template v-else>
      <!-- 明细 -->
      <template v-if="view === 'detail'">
        <BaseTable
          v-if="fundTrades.length > 0"
          :columns="fundColumns"
          :rows="fundTrades"
          :row-key="(r) => `${r.date}-${r.code}-${r.action}-${r.amount}-${r.shares}`"
          :min-width="'640px'"
          row-clickable
          :footer-text="'按月查询；同六元组重复行已在解析层去重 · 单击打开基金侧栏'"
          @row-click="(r) => emit('open', r.code)"
        >
          <template #name="{ row }">
            <span class="font-medium text-text">{{ row.name }}</span>
            <span class="ml-1 font-mono text-xs text-text-tertiary">{{ row.code }}</span>
          </template>
          <template #action="{ row }">
            <span class="rounded-full bg-flat-weak px-2 py-0.5 text-xs text-text-secondary">{{ row.action }}</span>
          </template>
          <template #amount="{ row }">
            <span class="font-mono tabular-nums">¥{{ yuan(row.amount) }}</span>
          </template>
          <template #shares="{ row }"><span class="font-mono tabular-nums">{{ row.shares }}</span></template>
        </BaseTable>
        <BaseEmpty v-else text="暂无基金流水：同步投资账本后自动填充" />
      </template>

      <!-- 按品种汇总：点击分组展开明细 -->
      <template v-else>
        <BaseEmpty v-if="fundGroups.length === 0" text="暂无基金流水：同步投资账本后自动填充" />
        <div v-else class="flex flex-col gap-1.5">
          <div
            v-for="g in fundGroups"
            :key="g.code"
            class="overflow-hidden rounded-xl border border-flat-weak"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 bg-flat-weak/40 px-3 py-2.5 text-left transition-colors hover:bg-flat-weak"
              @click="toggleExpand(g.code)"
            >
              <MenuIcon
                name="chevronRight"
                :size="14"
                class="shrink-0 text-text-tertiary transition-transform"
                :class="expanded.has(g.code) ? 'rotate-90' : ''"
              />
              <div
                class="min-w-0 flex-1 cursor-pointer"
                title="单击打开基金侧栏 · 行其他位置展开明细"
                @click.stop="emit('open', g.code)"
              >
                <p class="truncate text-sm font-medium text-text">
                  {{ g.name }}
                  <span class="ml-1 font-mono text-xs text-text-tertiary">{{ g.code }}</span>
                </p>
                <p class="mt-0.5 text-xs text-text-tertiary">
                  {{ g.count }} 笔 · 最近确认 {{ g.lastDate }}
                </p>
              </div>
              <div class="shrink-0 text-right font-mono text-xs tabular-nums">
                <p>合计 ¥{{ yuan(g.amountTotal) }}</p>
                <p class="text-text-tertiary">份额 {{ qty(g.sharesTotal) }}</p>
              </div>
            </button>
            <BaseTable
              v-if="expanded.has(g.code)"
              :columns="fundDetailColumns"
              :rows="g.trades"
              :row-key="(r) => `${r.date}-${r.action}-${r.amount}-${r.shares}`"
              :min-width="'560px'"
              scroll-class="table-scroll-sm"
              row-clickable
              @row-click="(r) => emit('open', r.code)"
            >
              <template #action="{ row }">
                <span class="rounded-full bg-flat-weak px-2 py-0.5 text-xs text-text-secondary">{{ row.action }}</span>
              </template>
              <template #amount="{ row }">
                <span class="font-mono tabular-nums">¥{{ yuan(row.amount) }}</span>
              </template>
              <template #shares="{ row }"><span class="font-mono tabular-nums">{{ row.shares }}</span></template>
            </BaseTable>
          </div>
          <p class="text-xs text-text-tertiary">共 {{ fundGroups.length }} 只基金 · 点击分组行展开逐笔明细</p>
        </div>
      </template>
    </template>
  </div>
</template>
