import dayjs from 'dayjs';
import type { KLineData } from 'klinecharts';
import {
  KLINE_CACHE_DATE_FORMAT,
  KLINE_CACHE_PERIODS,
  KLINE_CACHE_SOURCE_NONE,
  KLINE_CACHE_SOURCE_QFQ,
  KLINE_CACHE_SOURCES,
} from '../constants/kline-cache.constants.ts';
import type { KlineCacheMeta, KlineCacheOptions } from '../types/kline-cache.types.ts';
import type { KlineAdjustMode, KlineSeries } from '../types/kline.types.ts';
import { calcKlineTailDatalen } from '../utils/calc-kline-tail-datalen';
import { mergeKlineBars } from '../utils/merge-kline-bars';
import { shouldFetchKlineTail } from '../utils/should-fetch-kline-tail';
import {
  clearKlineCache,
  getKlineCacheMeta,
  isKlineCacheAvailable,
  listCachedKlineBars,
  upsertKlineBars,
  upsertKlineCacheMeta,
} from './kline-db.api.ts';
import { isHkSymbol } from '../utils/is-hk-symbol';
import { fetchHkKline } from './hk-kline.api';
import { fetchSinaKline, type SinaKlinePeriod } from './sina-kline.api.ts';
import { fetchTencentKlineSeries } from './tencent-kline.api.ts';
import { detectKlineAdjustDrift } from '../utils/detect-kline-adjust-drift';

/**
 * K 线取数的本地缓存编排层
 *
 * 策略（对应「历史行情不变」这一前提）：
 * - **首次**请求某票某周期 ⇒ 按周期配置取满（腾讯 qfq 日 K 上限 800 根 ≈ 3.2 年）并落库；
 * - **之后**请求 ⇒ 先读本地历史，只向腾讯补「库中最新日期 → 现在」的缺口；
 * - 缓存仍新鲜（当日已终值 / 盘中 TTL 内 / 中间无工作日）⇒ **零网络请求**直接返回；
 * - 落库一律**按票按需**：只有详情页、侧栏、Agent 单票查询这类「用户真的在看这只票」
 *   的路径才写入；批量扫描传 `write: false`，因此不会因为点一次扫描就把整池（极端情况
 *   全市场）的日 K 灌进本地库。
 *
 * **前复权口径漂移**（2026-11-02 切腾讯 qfq 后新增）：qfq 序列在除权除息后整条历史
 * 会被上游重新缩放，「历史不变」前提被打破 —— 补尾部时经 `detectKlineAdjustDrift`
 * 对重叠交易日比对收盘价，漂移即整票作废全量重取（代价仅为该票一次全量请求）。
 *
 * **新浪兜底**（2026-11-16 新增）：腾讯取数失败（限频 / 网络 / 该票无数据）时
 * 自动切新浪财经日周月 K（**不复权**）。兜底结果**不落库、不与库内序列拼接** ——
 * 两者复权口径不同，混在一条序列里会在除权日出现假跳空；兜底只在本次请求内生效，
 * 下次仍先试腾讯。返回的 `KlineSeries` 明确带上 source / adjust / fallback，
 * 供详情页如实标注数据来源。
 *
 * 不做静默降级：两条源都失败时向上抛错（调用方保留上一次成功数据），
 * 不会拿一份过期缓存冒充最新行情。
 */

/** 历史 K 线周期（日 / 周 / 月，走腾讯 qfq 源；分钟级走新浪源） */
type HistoryKlinePeriod = Extract<SinaKlinePeriod, 'daily' | 'weekly' | 'monthly'>;

/**
 * 判断周期是否为历史 K 线（日 / 周 / 月，走腾讯 qfq 源）
 * @param period K 线周期
 * @returns 是否历史 K 线（分钟级为 false，走新浪源）
 */
const isHistoryPeriod = (period: SinaKlinePeriod): period is HistoryKlinePeriod =>
  period === 'daily' || period === 'weekly' || period === 'monthly';

/**
 * 判断周期是否参与本地缓存
 * @param period K 线周期
 * @returns 是否可缓存（见 KLINE_CACHE_PERIODS 的取舍说明）
 */
const isCacheablePeriod = (period: SinaKlinePeriod): period is HistoryKlinePeriod =>
  KLINE_CACHE_PERIODS.includes(period);

/**
 * 缓存口径字符串 → 复权方式
 * @param source 库内记录的口径（见 KLINE_CACHE_SOURCES）
 * @returns 该口径对应的复权方式（未知口径按前复权处理）
 */
const adjustOfCacheSource = (source: string): KlineAdjustMode =>
  source === KLINE_CACHE_SOURCE_NONE ? 'none' : 'qfq';

/**
 * 复权方式 → 落库口径字符串
 * @param adjust 实际复权方式
 * @returns 库内口径标记
 */
const cacheSourceOfAdjust = (adjust: KlineAdjustMode): string =>
  adjust === 'none' ? KLINE_CACHE_SOURCE_NONE : KLINE_CACHE_SOURCE_QFQ;

/**
 * 历史 K 线取数：腾讯主源 → 失败切新浪财经兜底（纯网络层，不碰本地库）
 *
 * 兜底触发条件包括「请求抛错」与「上游 200 但序列为空」——两者对详情页
 * 是同一个结果（图出不来），处理方式应当一致。
 * @param symbol 完整符号（`sh600519` 形态）
 * @param period 历史周期（日 / 周 / 月）
 * @param barLimit 单次请求根数上限（不传取满）
 * @returns 序列 + 实际数据源 / 复权口径
 * @throws 两条源都失败时抛出（优先透出腾讯侧错误，便于定位主源问题）
 */
const fetchHistorySeriesWithFallback = async (
  symbol: string,
  period: HistoryKlinePeriod,
  barLimit?: number,
): Promise<KlineSeries> => {
  try {
    const { bars, adjust } = await fetchTencentKlineSeries(symbol, period, { barLimit });
    if (bars.length > 0) {
      return { bars, source: 'tencent', adjust, fallback: false };
    }
    throw new Error(`腾讯 K 线无数据（${symbol} ${period}，上游 200 但序列为空）`);
  } catch (error) {
    console.warn('[kline-cache] 腾讯源不可用，切新浪财经兜底', symbol, period, error);
    const bars = await fetchSinaKline(symbol, period, { barLimit });
    if (bars.length === 0) throw error;
    return { bars, source: 'sina', adjust: 'none', fallback: true };
  }
};

/**
 * 拉取 K 线（优先本地库，必要时只补缺口）并带回数据来源口径
 * @param symbol 完整符号（`sh600519` 形态）
 * @param period K 线周期
 * @param options 缓存策略（写入与否 / 首次请求根数上限）
 * @returns 序列 + 实际数据源 / 复权口径 / 是否兜底
 * @throws 需要回源且两条源都失败时抛错
 */
export const fetchKlineSeries = async (
  symbol: string,
  period: SinaKlinePeriod,
  options?: KlineCacheOptions,
): Promise<KlineSeries> => {
  const write = options?.write ?? true;
  // 港股符号走腾讯源直连（新浪接口不支持港股，实测返回 var _=(null)）；
  // v1 不进本地 SQLite 缓存层——该层「历史不变、只补尾部」策略按新浪源口径设计，
  // 腾讯源复权（qfq）与取数形态不同，留待有真实需求再做；内存快照（data-cache）天然生效
  if (isHkSymbol(symbol)) {
    const bars = await fetchHkKline(symbol, period, { barLimit: options?.barLimit });
    return {
      bars,
      source: 'tencent',
      // 港股日 / 周 / 月 K 走 hkfqkline 前复权；分钟级无复权概念
      adjust: isHistoryPeriod(period) ? 'qfq' : 'none',
      fallback: false,
    };
  }
  // 未纳入缓存的周期，或浏览器端无 SQLite ⇒ 退回纯网络取数
  // （历史 K 线走腾讯 qfq + 新浪兜底；分钟级无复权概念，仍走新浪源）
  if (!isCacheablePeriod(period) || !isKlineCacheAvailable()) {
    if (isHistoryPeriod(period)) {
      return fetchHistorySeriesWithFallback(symbol, period, options?.barLimit);
    }
    const bars = await fetchSinaKline(symbol, period, { barLimit: options?.barLimit });
    return { bars, source: 'sina', adjust: 'none', fallback: false };
  }

  const now = Date.now();
  let meta = await getKlineCacheMeta(symbol, period);
  // 口径不属于腾讯主源族（含旧版遗留 'sina-none' 兜底数据）⇒ 整票作废，否则新旧价格会混进同一条序列
  if (meta !== null && !KLINE_CACHE_SOURCES.includes(meta.source)) {
    console.warn(`[kline-cache] ${symbol} 缓存口径已变更，作废重取`);
    await clearKlineCache(symbol, period);
    meta = null;
  }

  const cachedBars = meta === null ? [] : await listCachedKlineBars(symbol, period);
  const hasCache = meta !== null && cachedBars.length > 0;
  const cacheSource = meta?.source ?? KLINE_CACHE_SOURCE_QFQ;

  /**
   * 用库内数据组结果（口径取水位记录，未知按前复权）
   * @param bars 库内读出的 K 线序列
   * @returns 带数据源与复权口径的取数结果
   */
  const fromCache = (bars: KLineData[]): KlineSeries => ({
    bars,
    source: 'tencent',
    adjust: adjustOfCacheSource(cacheSource),
    fallback: false,
  });

  // 缓存仍新鲜：库里已有完整历史且无需补尾部 ⇒ 零网络请求
  if (meta !== null && hasCache && !shouldFetchKlineTail(meta, now)) {
    return fromCache(cachedBars);
  }

  // 已有缓存 ⇒ 只取缺口根数；首次填充且要落库 ⇒ 取满（保证库里的历史自始完整，
  // 否则水位会把「半截历史」记成完整，之后只补尾部就永远填不回前面那段）；
  // 首次填充且只读 ⇒ 允许调用方收窄，不回写也就不会留下不完整的水位。
  let barLimit: number | undefined;
  if (meta !== null && hasCache) {
    barLimit = calcKlineTailDatalen(meta.lastDate, now);
  } else if (!write) {
    barLimit = options?.barLimit;
  }

  const series = await fetchHistorySeriesWithFallback(symbol, period, barLimit);
  const fetched = series.bars;
  if (fetched.length === 0) {
    return hasCache ? fromCache(cachedBars) : series;
  }

  // 兜底源（新浪不复权）与库内序列口径不同源：只本次展示，不落库、不拼接。
  // 混用会在除权日两侧价格跳空——图看起来正常，实为口径混用
  if (series.source !== 'tencent') {
    return series;
  }

  /**
   * 作废缓存后整票全量重取（口径切换 / 复权漂移共用）
   *
   * 重取同样走「腾讯 → 新浪兜底」链路：主源此刻不可用时至少还能出图，
   * 兜底结果不复权，故不落库（下次仍从腾讯重来）。
   * @returns 全量序列结果（含数据源与复权口径）
   * @throws 腾讯、新浪两条源都失败时抛错
   */
  const reloadFullSeries = async (): Promise<KlineSeries> => {
    await clearKlineCache(symbol, period);
    const full = await fetchHistorySeriesWithFallback(symbol, period);
    if (!write || full.source !== 'tencent') {
      return full;
    }
    await upsertKlineBars(symbol, period, full.bars);
    await upsertKlineCacheMeta({
      symbol,
      period,
      source: cacheSourceOfAdjust(full.adjust),
      firstDate: dayjs(full.bars[0].timestamp).format(KLINE_CACHE_DATE_FORMAT),
      lastDate: dayjs(full.bars[full.bars.length - 1].timestamp).format(KLINE_CACHE_DATE_FORMAT),
      barCount: full.bars.length,
      fetchedAt: now,
    });
    return full;
  };

  const sourceKey = cacheSourceOfAdjust(series.adjust);
  // 同票口径切换（无复权序列 ↔ 出现前复权序列，典型如上市公司首次分红）：
  // 老数据必须整票作废全量重取，否则 qfq 与原始价会接在同一条序列上
  if (hasCache && sourceKey !== meta?.source) {
    console.warn(`[kline-cache] ${symbol} 复权口径切换（${meta?.source} → ${sourceKey}），作废重取`);
    return reloadFullSeries();
  }

  // 前复权漂移检测：除权除息后上游整条历史重新缩放，重叠日收盘对不上 ⇒ 作废全量重取
  if (hasCache && detectKlineAdjustDrift(cachedBars, fetched)) {
    console.warn(`[kline-cache] ${symbol} 前复权口径漂移（疑似除权），缓存作废全量重取`);
    return reloadFullSeries();
  }

  const merged = mergeKlineBars(cachedBars, fetched);

  if (write) {
    await upsertKlineBars(symbol, period, fetched);
    const nextMeta: KlineCacheMeta = {
      symbol,
      period,
      source: sourceKey,
      firstDate: dayjs(merged[0].timestamp).format(KLINE_CACHE_DATE_FORMAT),
      lastDate: dayjs(merged[merged.length - 1].timestamp).format(KLINE_CACHE_DATE_FORMAT),
      barCount: merged.length,
      fetchedAt: now,
    };
    await upsertKlineCacheMeta(nextMeta);
  }

  return { bars: merged, source: 'tencent', adjust: series.adjust, fallback: false };
};

/**
 * 拉取 K 线序列（优先本地库，必要时只补缺口；只要序列的调用方用）
 *
 * 数据来源 / 复权口径需要展示的场景（个股详情页、侧栏、移动端详情）请改用
 * `fetchKlineSeries`，本函数是它的序列视图。
 * @param symbol 完整符号（`sh600519` 形态）
 * @param period K 线周期
 * @param options 缓存策略（写入与否 / 首次请求根数上限）
 * @returns klinecharts KLineData 序列（时间升序）
 * @throws 需要回源且腾讯、新浪两条源都失败时抛错
 */
export const fetchKlineCached = async (
  symbol: string,
  period: SinaKlinePeriod,
  options?: KlineCacheOptions,
): Promise<KLineData[]> => {
  const { bars } = await fetchKlineSeries(symbol, period, options);
  return bars;
};
