<script setup lang="ts">
import { computed } from 'vue';
import {
  KLINE_ADJUST_LABEL,
  KLINE_FALLBACK_LABEL,
  KLINE_SOURCE_BADGE_PREFIX,
  KLINE_SOURCE_LABEL,
  KLINE_SOURCE_SEPARATOR,
} from '../../constants/kline-source.constants.ts';
import type { KlineSeries } from '../../types/kline.types.ts';

/**
 * K 线数据来源标注（图表底部小字，如「数据来源：腾讯财经 · 前复权」）
 *
 * 为什么必须标注：主源（腾讯）失败时会自动切新浪财经兜底，两者复权口径不同
 * （前复权 vs 不复权），跨除权日的涨跌幅不可比。不标出来用户会把「不复权的
 * 假跌幅」当成真实行情读。兜底时文案追加「（兜底源）」。
 *
 * 只做展示，不参与取数；未拿到结果（`series` 为空）时不渲染。
 */
const props = defineProps<{
  /** 本次实际生效的取数结果（含 bars / source / adjust / fallback） */
  series?: KlineSeries | null;
}>();

/** 标注文案（来源 + 复权口径，兜底时追加标记） */
const text = computed<string>(() => {
  const series = props.series;
  if (!series) return '';
  const base =
    `${KLINE_SOURCE_BADGE_PREFIX}` +
    `${KLINE_SOURCE_LABEL[series.source]}${KLINE_SOURCE_SEPARATOR}${KLINE_ADJUST_LABEL[series.adjust]}`;
  return series.fallback ? `${base}（${KLINE_FALLBACK_LABEL}）` : base;
});
</script>

<template>
  <span v-if="series" class="select-none text-[11px] leading-none text-text-tertiary">
    {{ text }}
  </span>
</template>
