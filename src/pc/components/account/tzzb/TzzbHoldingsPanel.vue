<script setup lang="ts">
import { computed } from 'vue';
import BaseEmpty from '../../ui/BaseEmpty.vue';
import BaseTable from '../../ui/BaseTable.vue';
import BaseSkeleton from '../../ui/BaseSkeleton.vue';
import type { TableColumn } from '../../../../common/types/table.types.ts';
import type { TzzbHoldingRow, TzzbHoldingSummary } from '../../../../common/types/tzzb-holding.types.ts';

/**
 * 当前持仓 · 实时盈亏（2026-11-17 新增）
 *
 * 账本 MCP 的持仓 / 当日盈亏要等券商清算后才下发，盘中拿不到——
 * 本模块由全历史成交流水回推出当前持仓，结合实时行情与当日流水
 * 推算盘中实时盈亏（口径见 build-tzzb-holding-summary.ts）。
 * 行情轮询间隔与设置页「行情刷新间隔」一致（usePolling 调度）。
 */
const props = defineProps<{
  /** 持仓汇总（null = 流水尚未就绪） */
  summary: TzzbHoldingSummary | null;
  /** 全历史流水拉取中（首载骨架屏） */
  loading: boolean;
}>();

const emit = defineEmits<{
  /** 单击行：打开个股详情侧栏（全站统一口径） */
  open: [code: string];
  /** 双击行：跳个股详情整页 */
  openPage: [code: string];
}>();

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

const columns: TableColumn<TzzbHoldingRow>[] = [
  { key: 'name', label: '证券', sortable: true, sortValue: (r) => r.name },
  { key: 'quantity', label: '持仓数量', align: 'right', sortable: true, sortValue: (r) => r.quantity },
  { key: 'costPrice', label: '成本价', align: 'right', sortable: true, sortValue: (r) => r.costPrice },
  { key: 'marketValue', label: '市值', align: 'right', sortable: true, sortValue: (r) => r.marketValue },
  { key: 'pnl', label: '浮动盈亏', align: 'right', sortable: true, sortValue: (r) => r.pnl },
  { key: 'pnlRate', label: '收益率', align: 'right', sortable: true, sortValue: (r) => r.pnlRate },
  { key: 'dayPnl', label: '当日盈亏', align: 'right', sortable: true, sortValue: (r) => r.dayPnl },
  { key: 'todayTradeCount', label: '今日成交', align: 'right', sortable: true, sortValue: (r) => r.todayTradeCount },
];

/** 汇总条（流水就绪后展示） */
const chips = computed(() => {
  const s = props.summary;
  if (!s) return [];
  return [
    { label: '持仓市值', value: yuan(s.marketValue), cls: '' },
    {
      label: '当日盈亏',
      value: signYuan(s.dayPnl),
      cls: plClass(s.dayPnl),
    },
    {
      label: '当日收益率',
      value: s.dayRate === null ? '—' : `${s.dayRate > 0 ? '+' : ''}${(s.dayRate * 100).toFixed(2)}%`,
      cls: s.dayRate === null ? 'text-flat' : plClass(s.dayRate),
    },
    { label: '持仓只数', value: String(s.holdingCount), cls: '' },
    { label: '今日成交', value: `${s.todayTradeCount} 笔`, cls: '' },
  ];
});
</script>

<template>
  <!-- 首载（全历史流水拉取中） -->
  <BaseSkeleton v-if="loading" class="h-48" />
  <template v-else-if="summary">
    <!-- 汇总条 -->
    <div class="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
      <span v-for="chip in chips" :key="chip.label" class="flex items-baseline gap-1.5">
        <span class="text-xs text-text-tertiary">{{ chip.label }}</span>
        <span class="font-mono text-sm font-medium tabular-nums" :class="chip.cls">
          {{ chip.value }}
        </span>
      </span>
    </div>
    <BaseTable
      v-if="summary.rows.length > 0"
      :columns="columns"
      :rows="summary.rows"
      :row-key="(r) => r.code"
      :min-width="'760px'"
      scroll-class="table-scroll"
      row-clickable
      enable-dblclick-nav
      :footer-text="`持仓与当日盈亏由交易流水回放 + 实时行情推算（券商清算口径以账本为准）· 单击开侧栏 / 双击进详情`"
      @row-click="(r) => emit('open', r.code)"
      @row-dblclick="(r) => emit('openPage', r.code)"
    >
      <template #name="{ row }">
        <span class="font-medium text-text">{{ row.name }}</span>
        <span class="ml-1 font-mono text-xs text-text-tertiary">{{ row.code }}</span>
      </template>
      <template #quantity="{ row }">
        <span class="font-mono tabular-nums">{{ row.quantity.toLocaleString('zh-CN') }}</span>
      </template>
      <template #costPrice="{ row }">
        <span class="font-mono tabular-nums">{{ row.costPrice.toFixed(3) }}</span>
      </template>
      <template #marketValue="{ row }">
        <span class="font-mono tabular-nums">{{ row.marketValue === null ? '—' : yuan(row.marketValue) }}</span>
      </template>
      <template #pnl="{ row }">
        <span
          class="font-mono font-medium tabular-nums"
          :class="row.pnl === null ? 'text-flat' : plClass(row.pnl)"
        >
          {{ row.pnl === null ? '—' : signYuan(row.pnl) }}
        </span>
      </template>
      <template #pnlRate="{ row }">
        <span class="font-mono tabular-nums" :class="row.pnlRate === null ? 'text-flat' : plClass(row.pnlRate)">
          {{ row.pnlRate === null ? '—' : `${(row.pnlRate * 100).toFixed(2)}%` }}
        </span>
      </template>
      <template #dayPnl="{ row }">
        <span
          class="font-mono font-medium tabular-nums"
          :class="row.dayPnl === null ? 'text-flat' : plClass(row.dayPnl)"
        >
          {{ row.dayPnl === null ? '—' : signYuan(row.dayPnl) }}
        </span>
      </template>
      <template #todayTradeCount="{ row }">
        <span class="font-mono tabular-nums">{{ row.todayTradeCount > 0 ? `${row.todayTradeCount} 笔` : '—' }}</span>
      </template>
    </BaseTable>
    <BaseEmpty v-else text="未推算出持仓：账户流水为空或全部已清仓" />
  </template>
  <BaseEmpty v-else text="流水未就绪：请先同步投资账本" />
</template>
