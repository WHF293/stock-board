import { proxyFetch } from './proxy-fetch';
import type {
  HotConceptDay,
  HotConceptEvent,
  HotConceptEventDetail,
  HotConceptEventQuote,
  HotConceptThemeBoard,
  HotConceptThemeIncrease,
} from '../types/hot-concept.types.ts';

/**
 * 同花顺「市场热点」（hot_concept）取数
 *
 * 上游为同花顺 App 端 H5 页（news.10jqka.com.cn/app/hot_concept/）的开放接口，
 * GET/POST 免鉴权（裸请求会被 Nginx UA 过滤拦截，带浏览器 UA 即放行，
 * 本地代理中间件默认补 BROWSER_USER_AGENT）；2026-11-17 起卡片弃 iframe
 * 自渲染，详情数据走同源 jtcsm 系列接口（CDP 抓包逐一实测 200 直连）。
 * 域名 10jqka.com.cn 已在代理白名单与 Tauri capability 中放行
 */

/** jtcsm 系列接口基址（详情 / 板块 / 行情） */
const HOT_CONCEPT_API_BASE =
  'https://news.10jqka.com.cn/app/concept_v2_api/open/api/concept/event/jtcsm/v1';

/** 上游 Referer（移动端 H5 页） */
const HOT_CONCEPT_LIST_REFERER = 'https://news.10jqka.com.cn/app/hot_concept/';

/** 清单内存缓存有效期（10 分钟：热点日更新频率低，跨 tab 切换复用） */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 清单内存缓存（null = 未拉取 / 已强制失效） */
let daysCache: { days: HotConceptDay[]; fetchedAt: number } | null = null;

/**
 * jtcsm 开放接口统一请求：拼基址 + 带 Referer，解析 status_code 口径
 * （0 = success，非 0 抛错；data 原样返回）
 * @param path 接口路径（相对 jtcsm/v1，含前导 /）
 * @param init fetch 初始化（GET 默认；POST 由调用方带 method/headers/body）
 * @returns data 字段
 */
const requestHotConceptApi = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await proxyFetch(`${HOT_CONCEPT_API_BASE}${path}`, {
    headers: { Referer: HOT_CONCEPT_LIST_REFERER, Accept: 'application/json' },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`hot_concept ${path} HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { status_code?: number; status_msg?: string; data?: T };
  if (payload.status_code !== 0) {
    throw new Error(`hot_concept ${path} ${payload.status_msg ?? '上游返回异常'}`);
  }
  return payload.data as T;
};

/**
 * 拉取热点事件详情（题材解读：逐条摘要 / 原文链接 / 关联题材 / 投资方向）
 * @param eventId 事件 id
 * @returns 事件详情
 */
export const fetchHotConceptEventDetail = async (eventId: string): Promise<HotConceptEventDetail> =>
  requestHotConceptApi<HotConceptEventDetail>(`/event/detail?eventId=${encodeURIComponent(eventId)}`);

/**
 * 拉取热点影响板块与成分股（题材含细分概念递归，成分股为代码/名称/涨幅/涨停态）
 * @param eventId 事件 id
 * @returns 影响板块列表（含 children 细分）
 */
export const fetchHotConceptThemeTable = async (eventId: string): Promise<HotConceptThemeBoard[]> =>
  requestHotConceptApi<HotConceptThemeBoard[]>(`/theme/table?eventId=${encodeURIComponent(eventId)}`);

/**
 * 拉取事件级行情（平均涨幅 + 涨停家数；上游页面约 4s 轮询，
 * 本应用接设置页轮询节奏，批量传多个 eventId 一次取回）
 * @param eventIds 事件 id 列表
 * @returns 事件行情列表
 */
export const fetchHotConceptEventQuotes = async (eventIds: string[]): Promise<HotConceptEventQuote[]> =>
  requestHotConceptApi<HotConceptEventQuote[]>('/event/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventIds }),
  });

/**
 * 拉取板块实时涨幅（影响板块行轮询刷新）
 * @param themes 题材列表（id + type）
 * @returns 板块涨幅列表
 */
export const fetchHotConceptThemeIncrease = async (
  themes: Array<{ id: string; type: string }>,
): Promise<HotConceptThemeIncrease[]> =>
  requestHotConceptApi<HotConceptThemeIncrease[]>('/theme/quote/increase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(themes),
  });

/**
 * 拉取热点日清单（最新交易日在前；10 分钟内存缓存，force=true 强制重拉）
 * @param force 是否跳过缓存强制重拉
 * @returns 热点日集合（日期降序）
 */
export const fetchHotConceptDays = async (force = false): Promise<HotConceptDay[]> => {
  if (!force && daysCache && Date.now() - daysCache.fetchedAt < CACHE_TTL_MS) {
    return daysCache.days;
  }
  const days = await requestHotConceptApi<HotConceptDay[]>('/event/list');
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
