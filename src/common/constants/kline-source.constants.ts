import type { KlineAdjustMode, KlineSourceId } from '../types/kline.types.ts';

/**
 * K 线数据来源标注文案（详情页 K 线卡片右下角小字）
 *
 * 标注必须如实反映**本次实际生效**的来源与复权口径：主源（腾讯）失败切到
 * 新浪兜底时，价格口径会从「前复权」变成「不复权」，跨除权日的涨跌幅不可比，
 * 不标出来用户会当成真实跌幅看。
 */

/** 数据源展示名 */
export const KLINE_SOURCE_LABEL: Record<KlineSourceId, string> = {
  tencent: '腾讯财经',
  sina: '新浪财经',
};

/** 复权口径展示名 */
export const KLINE_ADJUST_LABEL: Record<KlineAdjustMode, string> = {
  qfq: '前复权',
  none: '不复权',
};

/** 标注前缀 */
export const KLINE_SOURCE_BADGE_PREFIX = '数据来源：';

/** 兜底源标记（主源失败切换时追加在标注尾部） */
export const KLINE_FALLBACK_LABEL = '兜底源';

/** 来源与复权口径之间的分隔符 */
export const KLINE_SOURCE_SEPARATOR = ' · ';
