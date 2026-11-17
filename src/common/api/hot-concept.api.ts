import { proxyFetch } from './proxy-fetch';
import type { HotConceptDay, HotConceptEvent } from '../types/hot-concept.types.ts';

/**
 * 同花顺「市场热点」（hot_concept）取数
 *
 * 上游为同花顺 App 端 H5 页（news.10jqka.com.cn/app/hot_concept/）的开放接口，
 * GET 免鉴权；二级页 iframe 直嵌 news.10jqka.com.cn/app/hot_concept/v2/detail
 * （无 X-Frame-Options 限制，已实测可嵌）。
 * 域名 10jqka.com.cn 已在代理白名单与 Tauri capability 中放行
 */

/** 热点日清单接口（返回近两个交易日的热点集合，首个为最新交易日） */
const HOT_CONCEPT_LIST_URL =
  'https://news.10jqka.com.cn/app/concept_v2_api/open/api/concept/event/jtcsm/v1/event/list';

/** 上游 Referer（移动端 H5 页） */
const HOT_CONCEPT_LIST_REFERER = 'https://news.10jqka.com.cn/app/hot_concept/';

/** 清单内存缓存有效期（10 分钟：热点日更新频率低，跨 tab 切换复用） */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 清单内存缓存（null = 未拉取 / 已强制失效） */
let daysCache: { days: HotConceptDay[]; fetchedAt: number } | null = null;

/**
 * 构造热点二级页地址（iframe 嵌套用；index 为事件在当日清单中的位置）
 * @param eventId 事件 id
 * @param index 事件序号（0 起）
 * @returns 二级页完整 URL
 */
export const buildHotConceptDetailUrl = (eventId: string, index: number): string =>
  `https://news.10jqka.com.cn/app/hot_concept/v2/detail?id=${eventId}&index=${index}`;

/**
 * 拉取热点日清单（最新交易日在前；10 分钟内存缓存，force=true 强制重拉）
 * @param force 是否跳过缓存强制重拉
 * @returns 热点日集合（日期降序）
 */
export const fetchHotConceptDays = async (force = false): Promise<HotConceptDay[]> => {
  if (!force && daysCache && Date.now() - daysCache.fetchedAt < CACHE_TTL_MS) {
    return daysCache.days;
  }
  const response = await proxyFetch(HOT_CONCEPT_LIST_URL, {
    headers: { Referer: HOT_CONCEPT_LIST_REFERER, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`hot_concept list HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data?: HotConceptDay[] };
  const days = payload.data;
  if (!Array.isArray(days) || days.length === 0) {
    throw new Error('hot_concept list 数据为空');
  }
  daysCache = { days, fetchedAt: Date.now() };
  return days;
};

/**
 * 拉取最新交易日的热点事件（页面消费口径）
 * @param force 是否跳过缓存强制重拉
 * @returns 最新交易日与其热点事件列表
 */
export const fetchLatestHotConcepts = async (
  force = false,
): Promise<{ date: string; events: HotConceptEvent[] }> => {
  const days = await fetchHotConceptDays(force);
  const latest = days[0];
  return { date: latest.date, events: latest.eventList };
};
