/**
 * 投资账本自动增量同步常量（打开软件后台同步 + 账户口径快照缓存）
 *
 * 增量口径：上游 MCP 无真增量接口（数据全部按区间重算），本地以「收盘节点水位」
 * 做增量判定——水位未越过最近收盘节点不重复拉取；越过（新交易日收盘后首次打开）
 * 才后台静默补拉已选账户数据。
 */

/** 账户口径快照 localStorage 键（key = 账户 id / 'all' = 汇总口径；沿用迁移前键名） */
export const TZZB_SCOPE_CACHE_STORAGE_KEY = 'tzzb.scopeCache.v1';

/** 口径快照缓存条目上限（超出淘汰最旧，防 localStorage 超限） */
export const TZZB_SCOPE_CACHE_MAX = 8;

/** 汇总口径缓存 key（顶栏「全部同步账户」） */
export const TZZB_SCOPE_KEY_ALL = 'all';

/** 自动同步水位 localStorage 键（值 = { lastSyncAt, lastSyncDate }） */
export const TZZB_AUTO_SYNC_STORAGE_KEY = 'tzzb.autosync.watermark.v1';

/** 收盘节点 - 时（上游盘后数据约 15:00-15:30 定稿，取 15:30 保守判定） */
export const TZZB_CLOSE_NODE_HOUR = 15;

/** 收盘节点 - 分 */
export const TZZB_CLOSE_NODE_MINUTE = 30;

/** 打开软件自动增量同步延迟启动（毫秒；避让首屏行情请求高峰） */
export const TZZB_BOOT_SYNC_DELAY_MS = 8_000;

/** 资产曲线自定义区间默认起（看板与自动同步快照共用，避免字面量散落） */
export const TZZB_CUSTOM_RANGE_DEFAULT_FROM = '2026-09-01';

/** 资产曲线自定义区间默认止 */
export const TZZB_CUSTOM_RANGE_DEFAULT_TO = '2026-10-23';
