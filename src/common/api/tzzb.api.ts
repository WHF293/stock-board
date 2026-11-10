import dayjs from 'dayjs';
import { TZZB_TRADE_FETCH_MAX_PAGES } from '../types/tzzb.types.ts';
import {
  TZZB_INDEX_NAME,
  type TzzbAccount,
  type TzzbAccountKind,
  type TzzbAssetChange,
  type TzzbClearedPosition,
  type TzzbDayCalendar,
  type TzzbFundCycle,
  type TzzbFundTrade,
  type TzzbHoldingReturn,
  type TzzbMonthCalendar,
  type TzzbPnlSummary,
  type TzzbPositionSummary,
  type TzzbStockTrade,
  type TzzbStockTradePage,
  type TzzbSyncMeta,
  type TzzbYearPoint,
} from '../types/tzzb.types.ts';

/**
 * 投资账本（tzzb）数据出口
 *
 * 传输形态：远程 MCP（Streamable HTTP JSON-RPC），dev/preview 阶段经同源代理
 * `/tzzb-mcp` 转发到上游 endpoint（server/tzzb-mcp-proxy.ts）。正式环境已发布
 * （2026-11-09），上游 endpoint 写死为 TZZB_MCP_ENDPOINT，不再依赖 .env.local
 * 与用户自定义配置文件。
 *
 * 会话：首次调用做 MCP initialize 握手拿 Mcp-Session-Id，后续复用；
 * 上游判定会话失效（404/400）时自动重新握手并重试一次。
 *
 * ⚠️ 上游 MCP 测试域名一律不写进入库代码（完整域名与
 * 用法见 .ai/项目资源/投资账本MCP同步-开发方案.md；本机配置在 .env.local，gitignore 已覆盖）。
 */

/** 客户端开关：正式环境已发布，MCP 通道恒开启（历史 dev 开关，保留常量避免调用方大改） */
export const TZZB_MCP_LIVE: boolean = true;

/** MCP 同源代理路径（server/tzzb-mcp-proxy.ts 挂载；打包版无 dev server 走直连，见 tzzb-direct.ts） */
const MCP_PROXY_PATH = '/tzzb-mcp';

/** 正式环境 endpoint 常量单一定义在 tzzb-direct.ts（直连模块同样需要），此处原样转出 */
export { TZZB_MCP_ENDPOINT } from './tzzb-direct.ts';

import {
  TZZB_USE_DIRECT,
  directAuthClear,
  directAuthInfo,
  directAuthStart,
  directRpcPost,
} from './tzzb-direct.ts';

/** 直连模式：打包版 Tauri（无 vite dev server，/tzzb-mcp 不存在，必须直连上游） */
const USE_DIRECT = TZZB_USE_DIRECT;

/* ---------------- MCP Streamable HTTP 客户端 ---------------- */

/** JSON-RPC 递增 id */
let rpcId = 0;

/** MCP 会话 id（initialize 握手下发；undefined = 未握手 / 已失效） */
let mcpSessionId: string | undefined;

/** 握手单飞 promise（并发调用共享一次 initialize） */
let sessionPromise: Promise<string | undefined> | null = null;

/**
 * 解析响应体：兼容 JSON 与 SSE（data: 行）两种形态
 * @param text 响应原文
 * @returns 解析出的 JSON-RPC 对象（SSE 取最后一个 data 帧）
 * @throws 响应不是合法 JSON-RPC 时抛错，错误信息直接携带响应体原文（截断展示，不加工）
 */
const parseRpcBody = (text: string): Record<string, unknown> => {
  const json = (() => {
    if (!text.includes('data:')) return JSON.parse(text) as unknown;
    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== '');
    return JSON.parse(frames[frames.length - 1] ?? '{}') as unknown;
  })() as Record<string, unknown>;
  if (!json || typeof json !== 'object' || !('jsonrpc' in json)) {
    throw new Error(`MCP 响应非 JSON-RPC，原文：${text.slice(0, 300) || '（空响应体）'}`);
  }
  return json;
};

/**
 * 单次 POST JSON-RPC（自动带会话头）
 * @param payload JSON-RPC 请求或通知体
 * @param needSession 是否附带会话头
 * @returns { json, sessionId }：响应 JSON 与上游下发的会话 id
 */
const postRpc = async (
  payload: Record<string, unknown>,
  needSession: boolean,
): Promise<{ json: Record<string, unknown>; sessionId?: string }> => {
  // 打包版直连：token 注入 / 401 续期重试在 tzzb-direct 内完成
  if (USE_DIRECT) return directRpcPost(payload, needSession, mcpSessionId);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18',
  };
  if (needSession && mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;
  const res = await fetch(MCP_PROXY_PATH, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}：${text.slice(0, 200)}`);
  }
  const json = parseRpcBody(text);
  return { json, sessionId: res.headers.get('mcp-session-id') ?? undefined };
};

/**
 * MCP initialize 握手（单飞；拿到 Mcp-Session-Id 并发送 initialized 通知）
 * @returns 会话 id（上游未下发时为 undefined）
 */
const ensureSession = async (): Promise<string | undefined> => {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    rpcId += 1;
    const { json, sessionId } = await postRpc(
      {
        jsonrpc: '2.0',
        id: rpcId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'whf-stock-board', version: '1.0.0' },
        },
      },
      false,
    );
    if (json.error) throw new Error(String((json.error as Record<string, unknown>).message ?? 'initialize 失败'));
    mcpSessionId = sessionId;
    // initialized 通知（无 id，不需要响应）
    await postRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, true).catch(() => undefined);
    return mcpSessionId;
  })();
  try {
    return await sessionPromise;
  } finally {
    sessionPromise = null;
  }
};

/**
 * 调用投资账本 MCP 工具并解出业务负载
 *
 * MCP 工具返回 content[{type:'text'}] 文本，内为业务 JSON（与内测采样同构）；
 * 优先取 structuredContent。会话失效（404 / HTTP 400）自动重握手重试一次。
 * @param tool 工具名
 * @param args 工具入参
 * @returns 业务响应对象；未配置代理时返回 undefined
 */
const callTzzbTool = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  if (!TZZB_MCP_LIVE) return undefined;
  await ensureSession();
  rpcId += 1;
  const payload = {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  };
  let json: Record<string, unknown>;
  try {
    json = (await postRpc(payload, true)).json;
  } catch (error) {
    // 会话失效：重置后重新握手重试一次
    const message = String(error);
    if (!message.includes('MCP HTTP 404') && !message.includes('MCP HTTP 400')) throw error;
    mcpSessionId = undefined;
    await ensureSession();
    rpcId += 1;
    json = (await postRpc({ ...payload, id: rpcId }, true)).json;
  }
  if (json.error) {
    throw new Error(String((json.error as Record<string, unknown>).message ?? 'MCP 调用失败'));
  }
  const result = json.result as
    | {
        structuredContent?: unknown;
        content?: { type?: string; text?: string }[];
        isError?: boolean;
      }
    | undefined;
  if (!result) return undefined;
  if (result.isError) {
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    throw new Error(`工具 ${tool} 返回错误：${text.slice(0, 200)}`);
  }
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/* ---------------- 账户（promptAccountSelection 派生，全模块共享） ---------------- */

/** 账户键集合（逗号分隔多账号；与内测采样请求同构） */
interface TzzbKeys {
  fundKey: string;
  rzrqFundKey: string;
  manualId: string;
  fundId: string;
  custId: string;
}

/** 账户原始分组缓存 key（localStorage；账户固定不动，拉一次持久复用，菜单「更新账户列表」强制刷新） */
const ACCOUNT_CACHE_KEY = 'tzzb.accounts.raw.v1';

/** 同步账户勾选 key（localStorage；null = 从未确认过 → 首次拉到账户后弹勾选确认） */
const ACCOUNT_SELECTED_KEY = 'tzzb.accounts.selected.v1';

/** 当前账户范围（null = 全部账户；多选勾选的账户 id 集合，影响全部数据接口取数口径） */
let scopeAccountIds: string[] | null = null;

/**
 * 设置账户范围（看板确认同步账户时调用；null = 全部账户）
 * @param accountIds 账户 id 集合（promptAccountSelection 分组内条目 id）；null = 全部
 */
export const setTzzbAccountScope = (accountIds: string[] | null): void => {
  scopeAccountIds = accountIds;
};

/** promptAccountSelection 分组响应形态 */
type TzzbAccountRaw = Record<string, { id: string; name: string }[]>;

/** promptAccountSelection 原始响应缓存（账户列表与键共用一次拉取） */
let accountRawCache: TzzbAccountRaw | null = null;

/** 拉取单飞 */
let accountPromise: Promise<TzzbAccountRaw | null> | null = null;

/**
 * 读取 localStorage 账户缓存（结构损坏 / 字段缺失一律丢弃）
 * @returns 缓存的分组响应；无有效缓存返回 null
 */
const readAccountCache = (): TzzbAccountRaw | null => {
  try {
    const raw = localStorage.getItem(ACCOUNT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { raw?: TzzbAccountRaw };
    return parsed?.raw && typeof parsed.raw === 'object' ? parsed.raw : null;
  } catch {
    return null;
  }
};

/**
 * 账户分组落盘缓存（内存 + localStorage 一起写）
 * @param raw 分组响应
 */
const writeAccountCache = (raw: TzzbAccountRaw): void => {
  accountRawCache = raw;
  try {
    localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), raw }));
  } catch {
    // 存储满 / 隐私模式：内存缓存仍有效，静默降级
  }
};

/**
 * 确保账户原始分组可用（内存缓存 → localStorage 缓存 → 网络 promptAccountSelection）
 * @returns 分组响应；未配置代理时返回 null
 */
const ensureAccountRaw = async (): Promise<TzzbAccountRaw | null> => {
  if (accountRawCache) return accountRawCache;
  const cached = readAccountCache();
  if (cached) {
    accountRawCache = cached;
    return accountRawCache;
  }
  if (!accountPromise) {
    accountPromise = callTzzbTool('promptAccountSelection', { scope: 'all' }).then((r) => {
      const raw = (r as TzzbAccountRaw | undefined) ?? null;
      if (raw) writeAccountCache(raw);
      accountRawCache = raw;
      return accountRawCache;
    });
  }
  try {
    return await accountPromise;
  } finally {
    accountPromise = null;
  }
};

/**
 * 强制刷新账户分组（「更新账户列表」入口）：忽略全部缓存重新调上游，
 * 成功后覆盖内存与 localStorage 缓存
 * @returns 最新分组响应；拉取失败抛错（调用方提示）
 */
export const refreshTzzbAccountRaw = async (): Promise<TzzbAccountRaw> => {
  const r = await callTzzbTool('promptAccountSelection', { scope: 'all' });
  const raw = r as TzzbAccountRaw | undefined;
  if (!raw) throw new Error('账户列表刷新失败：上游未返回数据');
  writeAccountCache(raw);
  return raw;
};

/**
 * 读取用户确认的同步账户勾选
 * @returns 勾选账户 id 集合；null = 从未确认过（首次拉到账户后需弹勾选确认）
 */
export const getTzzbSelectedAccountIds = (): string[] | null => {
  try {
    const raw = localStorage.getItem(ACCOUNT_SELECTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
};

/**
 * 持久化用户确认的同步账户勾选
 * @param ids 勾选账户 id 集合（至少 1 个，调用方保证）
 */
export const setTzzbSelectedAccountIds = (ids: string[]): void => {
  try {
    localStorage.setItem(ACCOUNT_SELECTED_KEY, JSON.stringify(ids));
  } catch {
    // 同上：降级内存语义（本次会话仍生效）
  }
};

/**
 * 从账户分组派生键集合（逗号分隔多账号；设置了账户范围时仅取勾选账户条目）
 * @param r 分组响应
 * @returns 股票三键 + 基金两键
 */
const deriveKeys = (r: Record<string, { id: string; name: string }[]>): TzzbKeys => {
  const ids = (key: string): string => {
    const list = r[key] ?? [];
    const scoped = scopeAccountIds ? list.filter((a) => scopeAccountIds!.includes(String(a.id))) : list;
    return scoped.map((a) => String(a.id)).join(',');
  };
  return {
    fundKey: ids('fund_key'),
    rzrqFundKey: ids('rzrq_fund_key'),
    manualId: ids('manual_id'),
    fundId: ids('fund_id'),
    // cust_id 是用户级客户号（单条），不随账户范围过滤
    custId: String((r['cust_id'] as { id: string }[] | undefined)?.[0]?.id ?? ''),
  };
};

/**
 * 确保账户键可用
 * @returns 账户键集合；未配置代理时返回 null
 */
const ensureKeys = async (): Promise<TzzbKeys | null> => {
  const raw = await ensureAccountRaw();
  return raw ? deriveKeys(raw) : null;
};

/**
 * 股票侧三键入参（fundKey / rzrqFundKey / manualId）
 * @param keys 账户键集合
 * @returns 三键入参对象
 */
const stockKeyArgs = (keys: TzzbKeys): Record<string, unknown> => ({
  fundKey: keys.fundKey,
  rzrqFundKey: keys.rzrqFundKey,
  manualId: keys.manualId,
});

/**
 * 股票三键 + 基金两键全量入参（全量参数工具）
 * @param keys 账户键集合
 * @returns 五键入参对象
 */
const fullKeyArgs = (keys: TzzbKeys): Record<string, unknown> => ({
  ...stockKeyArgs(keys),
  fundId: keys.fundId,
  custId: keys.custId,
});

/* ---------------- 解析工具 ---------------- */

/**
 * 宽松数值解析：字符串数字 / 科学计数法（"3E+4"）/ null / 空串一律安全转数值
 * @param v 原始值
 * @returns 数值（解析失败返回 0）
 */
const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
};

/**
 * columns + rows 矩阵 → 对象数组（queryFund* 系工具的返回形态）
 * @param raw 矩阵原值
 * @returns 行对象数组（结构不符返回空数组）
 */
const matrixRows = (raw: unknown): Record<string, unknown>[] => {
  const m = raw as { columns?: string[]; rows?: unknown[][] } | null;
  if (!m?.columns || !Array.isArray(m.rows)) return [];
  return m.rows.map((row) => Object.fromEntries(m.columns!.map((c, i) => [c, row[i]])));
};

/**
 * profit_loss_list（columns+rows）统一解出日期 / 盈亏 / 收益率
 * @param raw profit_loss_list 原值
 * @returns 逐期点数组
 */
const parseProfitLossRows = (raw: unknown): { date: string; profit: number; rate: number }[] =>
  matrixRows(raw).map((row) => ({
    date: String(row['date'] ?? ''),
    profit: num(row['profit_loss']),
    rate: num(row['profit_loss_rate']),
  }));

/**
 * total_index → 指数涨跌列表
 * @param raw total_index 原值（代码 → 小数涨跌幅）
 * @returns 指数涨跌数组（展示名映射见 TZZB_INDEX_NAME）
 */
const parseIndexes = (raw: unknown): { name: string; rate: number }[] =>
  Object.entries((raw as Record<string, number> | null) ?? {}).map(([code, rate]) => ({
    name: TZZB_INDEX_NAME[code] ?? code,
    rate: num(rate),
  }));

/**
 * 清仓日有效性判断
 * @param v closeDate 原值
 * @returns yyyy-MM-dd 日期；空串 / 「持有中」/ 非日期返回 null
 */
const parseCloseDate = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/* ---------------- 接口 ---------------- */

/**
 * 区间 → 起止日期（yyyyMMdd；'all' 以同步水位 2025-09-30 为起点）
 * @param range TZZB_RANGE_OPTIONS value
 * @returns [startDate, endDate]
 */
const rangeDates = (range: string): [string, string] => {
  const today = dayjs();
  const start =
    range === 'm1'
      ? today.startOf('month')
      : range === 'm3'
        ? today.subtract(3, 'month')
        : range === 'm6'
          ? today.subtract(6, 'month')
          : range === 'y1'
            ? today.subtract(1, 'year')
            : range === 'ytd'
              ? today.startOf('year')
              : range === 'all'
                ? dayjs('2025-09-30')
                : today.startOf('month');
  return [start.format('YYYYMMDD'), today.format('YYYYMMDD')];
};

/**
 * 分组响应 → 展示账户列表（股票类在前、基金类在后）
 * @param r 分组响应
 * @returns 账户列表
 */
const mapAccounts = (r: TzzbAccountRaw): TzzbAccount[] => {
  const group = (key: string, kind: TzzbAccountKind): TzzbAccount[] =>
    (r[key] ?? []).map((a) => ({
      id: String(a.id),
      name: String(a.name),
      kind,
    }));
  return [
    ...group('fund_key', 'stock'),
    ...group('rzrq_fund_key', 'rzrq'),
    ...group('manual_id', 'manual'),
    ...group('fund_id', 'fund'),
  ];
};

/**
 * 账户列表（缓存优先：内存 → localStorage → 网络；账户固定不变，
 * 同步时不再重复拉取，刷新走 refreshTzzbAccounts）
 * @returns 账户列表（股票类在前、基金类在后）
 */
export const getTzzbAccounts = async (): Promise<TzzbAccount[]> => {
  const r = await ensureAccountRaw();
  return r ? mapAccounts(r) : [];
};

/**
 * 强制刷新账户列表（「更新账户列表」菜单入口）：绕过缓存重调上游并落盘
 * @returns 最新账户列表
 * @throws 上游拉取失败
 */
export const refreshTzzbAccounts = async (): Promise<TzzbAccount[]> =>
  mapAccounts(await refreshTzzbAccountRaw());

/**
 * 资产曲线汇总（queryPnlSummary：净值 / 指数 / 区间总盈亏）
 * @param range 区间（TZZB_RANGE_OPTIONS value，映射为 startDate/endDate）
 * @returns 汇总对象；未配置代理 / 调用失败时返回 null
 */
export const getTzzbPnlSummary = async (range = 'm1'): Promise<TzzbPnlSummary | null> => {
  const keys = await ensureKeys();
  if (!keys) return null;
  const [startDate, endDate] = rangeDates(range);
  const r = (await callTzzbTool('queryPnlSummary', {
    startDate,
    endDate,
    ...fullKeyArgs(keys),
  })) as Record<string, unknown> | undefined;
  if (!r) return null;
  const assetTrend = ((r['netValueTrend'] as Record<string, unknown>[] | undefined) ?? [])
    // 上游起点会自动向前多带约一个月（官方为算区间收益率），按请求起点裁齐，
    // 否则累计收益曲线会混入区间外的历史盈亏
    .filter((p) => String(p['time'] ?? '') >= startDate)
    .map((p) => ({
      date: String(p['time'] ?? ''),
      totalAsset: num(p['totalAsset']),
      dailyProfit: num(p['dailyProfitLoss']),
      navIndex: num(p['netValueIndex']),
      positionRatio: num(p['positionRatio']),
      dailyRate: num(p['dailyReturnRate']),
      cumRate: num(p['totalReturnRate']),
    }));
  const indexTrend = ((r['shIndexTrend'] as Record<string, unknown>[] | undefined) ?? []).map(
    (p) => ({
      date: String(p['time'] ?? ''),
      sh: num(p['shIndex']),
      hs300: num(p['hs300']),
    }),
  );
  return {
    totalProfit: num(r['totalProfitLoss']),
    totalRate: num(r['totalReturnRate']),
    assetTrend,
    indexTrend,
  };
};

/**
 * 持仓汇总（queryStockPosition 顶层：总资产 / 市值 / 可用资金 / 仓位）
 * @returns 汇总对象；未配置代理 / 调用失败时返回 null
 */
export const getTzzbPositionSummary = async (): Promise<TzzbPositionSummary | null> => {
  const keys = await ensureKeys();
  if (!keys) return null;
  const r = (await callTzzbTool('queryStockPosition', stockKeyArgs(keys))) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    totalAsset: num(r['totalAsset']),
    marketValue: num(r['totalMarketValue']),
    availableFunds: num(r['availableFunds']),
    positionRatio: num(r['positionRatio']),
  };
};

/**
 * 区间资金变动（queryAssetChangeSummary；无数据侧为 null）
 * @param range 区间（TZZB_RANGE_OPTIONS value；默认本月，与指标行口径一致）
 * @returns 股票 / 基金两侧变动；未配置代理 / 调用失败时返回 null
 */
export const getTzzbAssetChange = async (range = 'm1'): Promise<TzzbAssetChange | null> => {
  const keys = await ensureKeys();
  if (!keys) return null;
  const [startDate, endDate] = rangeDates(range);
  const r = (await callTzzbTool('queryAssetChangeSummary', {
    startDate,
    endDate,
    ...fullKeyArgs(keys),
  })) as Record<string, unknown> | undefined;
  if (!r) return null;
  const side = (key: string) => {
    const s = r[key] as Record<string, unknown> | null | undefined;
    if (!s) return null;
    return {
      startAsset: num(s['start_asset']),
      transferIn: num(s['money_in']),
      transferOut: num(s['money_out']),
      dividend: num(s['bonus']),
      profit: num(s['profit']),
      endAsset: num(s['end_asset']),
    };
  };
  return { stock: side('stock'), fund: side('fund') };
};

/**
 * 盈亏日历 · 月视图（queryDayCalendarSummary；区间须覆盖整月）
 * @param month 月份 yyyyMM
 * @returns 月视图数据；未配置代理 / 调用失败时返回 null
 */
export const getTzzbDayCalendar = async (month: string): Promise<TzzbDayCalendar | null> => {
  const keys = await ensureKeys();
  if (!keys) return null;
  const first = dayjs(`${month.slice(0, 4)}-${month.slice(4, 6)}-01`);
  const r = (await callTzzbTool('queryDayCalendarSummary', {
    startDate: first.format('YYYYMMDD'),
    endDate: first.endOf('month').format('YYYYMMDD'),
    ...fullKeyArgs(keys),
  })) as Record<string, unknown> | undefined;
  if (!r) return null;
  const pm = (r['profit_map'] as Record<string, unknown> | null) ?? {};
  return {
    month,
    days: parseProfitLossRows(r['profit_loss_list']),
    summary: {
      stockProfit: num(pm['stock_profit']),
      fundProfit: num(pm['fund_profit']),
      total: num(pm['profit_loss']),
      rate: num(pm['profit_loss_rate']),
    },
    indexes: parseIndexes(r['total_index']),
  };
};

/**
 * 盈亏日历 · 年视图（queryMonthCalendarSummary 按年查询）
 * @param year 年份 yyyy
 * @returns 12 个月点数据；未配置代理 / 调用失败时返回 null
 */
export const getTzzbMonthCalendar = async (year: string): Promise<TzzbMonthCalendar | null> => {
  const keys = await ensureKeys();
  if (!keys) return null;
  const r = (await callTzzbTool('queryMonthCalendarSummary', {
    year,
    ...fullKeyArgs(keys),
  })) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    year,
    months: parseProfitLossRows(r['profit_loss_list']).map((row) => ({
      month: row.date,
      profit: row.profit,
      rate: row.rate,
    })),
  };
};

/**
 * 年度聚合点（年历格；queryMonthCalendarSummary 逐年拉取后前端聚合）
 * @param years 年份列表
 * @returns 有数据年份的聚合点（profit 合计 / rate 小数累加近似）
 */
export const getTzzbYearPoints = async (years: string[]): Promise<TzzbYearPoint[]> => {
  const points = await Promise.all(
    years.map(async (year) => {
      const cal = await getTzzbMonthCalendar(year);
      if (!cal || cal.months.length === 0) return null;
      const profit = cal.months.reduce((sum, m) => sum + m.profit, 0);
      const rate = cal.months.reduce((sum, m) => sum + m.rate, 0);
      return { year, profit, rate };
    }),
  );
  return points.filter((p): p is TzzbYearPoint => p !== null);
};

/**
 * 建清仓记录（queryClearedPosition；closeDate 空 = 持有中）
 * @returns 清仓记录列表；未配置代理 / 调用失败时返回空数组
 */
export const getTzzbClearedPositions = async (): Promise<TzzbClearedPosition[]> => {
  const keys = await ensureKeys();
  if (!keys) return [];
  const r = (await callTzzbTool('queryClearedPosition', {
    openDate: '2025-09-30',
    closeDate: dayjs().format('YYYY-MM-DD'),
    groupBy: 'stock',
    ...stockKeyArgs(keys),
  })) as Record<string, unknown> | undefined;
  if (!r) return [];
  return ((r['list'] as Record<string, unknown>[] | undefined) ?? []).map((row) => ({
    code: String(row['stockCode'] ?? ''),
    name: String(row['stockName'] ?? ''),
    openDate: String(row['openDate'] ?? ''),
    closeDate: parseCloseDate(row['closeDate']),
    holdDays: num(row['holdDays']),
    rounds: num(row['ocCount']),
    avgBuy: num(row['avgBuyPrice']),
    avgSell: row['avgSellPrice'] === '' ? null : num(row['avgSellPrice']),
    fee: num(row['fee']),
    profit: num(row['totalProfit']),
    rate: num(row['totalProfitRate']),
  }));
};

/**
 * 个基累计收益（queryFundHoldingReturns.allProfit / allRate）
 * @returns 个基收益列表；未配置代理 / 调用失败时返回空数组
 */
export const getTzzbFundHoldingReturns = async (): Promise<TzzbHoldingReturn[]> => {
  const keys = await ensureKeys();
  if (!keys) return [];
  const r = (await callTzzbTool('queryFundHoldingReturns', {
    fundId: keys.fundId,
    custId: keys.custId,
  })) as Record<string, unknown> | undefined;
  if (!r) return [];
  return matrixRows(r['funds']).map((row) => ({
    code: String(row['fundcode'] ?? ''),
    name: String(row['fundname'] ?? ''),
    profit: num(row['allProfit']),
    rate: num(row['allRate']),
  }));
};

/**
 * 股票逐笔流水（queryMoneyHistory 分页）
 * @param page 页码（从 1 起）
 * @param range 可选区间（缺省为近三个月，保持既有口径）
 * @param range.startDate 区间起始日 yyyyMMdd
 * @param range.endDate 区间结束日 yyyyMMdd
 * @returns 分页流水；未配置代理 / 调用失败时返回 null
 */
export const getTzzbStockTrades = async (
  page: string,
  range?: { startDate?: string; endDate?: string },
): Promise<TzzbStockTradePage | null> => {
  const keys = await ensureKeys();
  if (!keys) return null;
  const r = (await callTzzbTool('queryMoneyHistory', {
    page: String(page),
    count: '20',
    startDate: range?.startDate ?? dayjs().subtract(3, 'month').format('YYYYMMDD'),
    endDate: range?.endDate ?? dayjs().format('YYYYMMDD'),
    ...stockKeyArgs(keys),
  })) as Record<string, unknown> | undefined;
  if (!r) return null;
  const list = ((r['list'] as Record<string, unknown>[] | undefined) ?? []).map(
    (row): TzzbStockTrade => ({
      date: String(row['entryDate'] ?? ''),
      code: String(row['stockCode'] ?? ''),
      name: String(row['stockName'] ?? ''),
      action: String(row['opName'] ?? ''),
      price: num(row['entryPrice']),
      quantity: num(row['entryCount']),
      amount: num(row['entryMoney']),
      commission: num(row['commission']),
      transferFee: num(row['transferFee']),
      feeTotal: num(row['feeTotal']),
    }),
  );
  return { page: num(r['page']) || 1, maxPage: num(r['maxPage']) || 1, list };
};

/** 全量股票流水内存缓存（dashboard 同步时覆盖写入；个股详情「交易记录」等低频入口免翻页复用） */
let allStockTradesCache: TzzbStockTrade[] | null = null;

/**
 * 拉取统计窗口内全量股票流水（首页 + 逐页串行合并，页数上限防御异常 maxPage；
 * list 覆盖写内存缓存供个股详情「交易记录」等低频入口免翻页复用）
 * @returns 首页分页结构（list 已合并全量页）；未配置代理 / 调用失败时返回 null
 */
export const fetchTzzbAllStockTrades = async (): Promise<TzzbStockTradePage | null> => {
  const first = await getTzzbStockTrades('1');
  if (!first) return null;
  const list = [...first.list];
  const maxPage = Math.min(first.maxPage, TZZB_TRADE_FETCH_MAX_PAGES);
  for (let page = 2; page <= maxPage; page += 1) {
    const next = await getTzzbStockTrades(String(page));
    if (!next || next.list.length === 0) break;
    list.push(...next.list);
  }
  allStockTradesCache = list;
  return { page: first.page, maxPage: first.maxPage, list };
};

/**
 * 读取全量股票流水（有缓存直接返回；无缓存时拉取一次并落缓存）
 *
 * 供个股详情「交易记录」合并账本流水等低频入口使用；注意缓存口径跟随
 * 最近一次数据层账户范围（setTzzbAccountScope），聚焦单账户时仅含该账户流水
 * @returns 全量流水；未配置代理 / 调用失败时返回空数组
 */
export const getTzzbAllStockTrades = async (): Promise<TzzbStockTrade[]> => {
  if (allStockTradesCache) return allStockTradesCache;
  return (await fetchTzzbAllStockTrades())?.list ?? [];
};

/**
 * 基金申赎流水（queryFundSummaryHistory；六元组重复行去重）
 * @param month 月份 yyyy-MM
 * @returns 去重后的流水列表；未配置代理 / 调用失败时返回空数组
 */
export const getTzzbFundTrades = async (month: string): Promise<TzzbFundTrade[]> => {
  const keys = await ensureKeys();
  if (!keys) return [];
  const r = (await callTzzbTool('queryFundSummaryHistory', {
    monthList: month,
    fundId: keys.fundId,
    custId: keys.custId,
  })) as { data?: { month?: string; list?: unknown }[] } | undefined;
  if (!r?.data) return [];
  const seen = new Set<string>();
  const out: TzzbFundTrade[] = [];
  for (const block of r.data) {
    for (const row of matrixRows(block.list)) {
      const trade: TzzbFundTrade = {
        date: String(row['confirmDate'] ?? ''),
        accountName: String(row['accountName'] ?? ''),
        code: String(row['fundCode'] ?? ''),
        name: String(row['fundName'] ?? ''),
        action: String(row['opName'] ?? ''),
        amount: num(row['transAmount']),
        shares: num(row['transCount']),
      };
      // 实测存在完全重复行：六元组（账户+代码+名称+金额+份额+确认日+操作）去重
      const key = [
        trade.accountName,
        trade.code,
        trade.name,
        trade.amount,
        trade.shares,
        trade.date,
        trade.action,
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trade);
    }
  }
  return out;
};

/**
 * 基金持仓回合重构的数据起点（yyyy-MM）
 *
 * 与 getTzzbClearedPositions 的 openDate='2025-09-30' 同口径：账本数据起始月，
 * 早于该月的申赎流水不存在，回合重构从本月起全量拉取
 */
export const TZZB_FUND_CYCLE_START_MONTH = '2025-09';

/** 回合闭合的份额归零阈值（浮点累加误差容差） */
const FUND_CYCLE_SHARE_EPS = 1e-4;

/**
 * 基金持仓回合（本地重构；上游无基金清仓周期工具）
 *
 * 从数据起始月（TZZB_FUND_CYCLE_START_MONTH）到当月逐月拉申赎流水（复用
 * getTzzbFundTrades 的去重口径），按基金聚合重构「首笔申购 → 份额清零」回合：
 * - 买入类操作（申购 / 定投 / 买入）累计份额与投入金额；首笔买入日记开仓日
 * - 卖出类操作（赎回 / 卖出）扣减份额与回收金额；份额清零日闭合回合
 * - 流水耗尽仍未清零 → 持有中回合（closeDate=null，持有天数算到今天）
 * - 估算盈亏 = 回收 − 投入（现金流口径，分红再投等会有偏差，展示层需标注）
 *
 * @returns 回合列表（按开仓日升序）；未配置代理 / 全部月份拉取失败时返回空数组
 */
export const getTzzbFundCycles = async (): Promise<TzzbFundCycle[]> => {
  const start = dayjs(TZZB_FUND_CYCLE_START_MONTH);
  const end = dayjs();
  const months: string[] = [];
  for (let m = start; !m.isAfter(end, 'month'); m = m.add(1, 'month')) {
    months.push(m.format('YYYY-MM'));
  }
  // 串行逐月拉取（MCP 会话复用；单月失败跳过不影响其余月份）
  const trades: TzzbFundTrade[] = [];
  for (const month of months) {
    try {
      trades.push(...(await getTzzbFundTrades(month)));
    } catch {
      // 上游报错原样放行由调用方感知不了单月——跳过该月，回合可能因此偏长
    }
  }
  if (trades.length === 0) return [];
  // 按基金分组 + 确认日升序（同日按流水原序，先买后卖）
  const byCode = new Map<string, { name: string; rows: TzzbFundTrade[] }>();
  for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    const g = byCode.get(t.code) ?? { name: t.name, rows: [] };
    g.name = t.name || g.name;
    g.rows.push(t);
    byCode.set(t.code, g);
  }
  const today = dayjs();
  const out: TzzbFundCycle[] = [];
  for (const [code, g] of byCode) {
    let openDate: string | null = null;
    let buyAmount = 0;
    let sellAmount = 0;
    let netShares = 0;
    const close = (closeDate: string | null): void => {
      if (!openDate) return;
      const endDate = closeDate ? dayjs(closeDate) : today;
      out.push({
        code,
        name: g.name,
        openDate,
        closeDate,
        holdDays: Math.max(1, endDate.diff(dayjs(openDate), 'day') + 1),
        buyAmount,
        sellAmount,
        estProfit: sellAmount - buyAmount,
      });
      openDate = null;
      buyAmount = 0;
      sellAmount = 0;
      netShares = 0;
    };
    for (const t of g.rows) {
      const isBuy = t.action.includes('申购') || t.action.includes('定投') || t.action.includes('买入');
      const isSell = t.action.includes('赎回') || t.action.includes('卖出');
      if (!isBuy && !isSell) continue; // 分红 / 转换等其它操作不影响回合
      if (isBuy) {
        if (!openDate) openDate = t.date;
        buyAmount += t.amount;
        netShares += t.shares;
      } else {
        if (!openDate) openDate = t.date; // 防御：首笔即赎回（建仓前流水缺失）
        sellAmount += t.amount;
        netShares -= t.shares;
        if (netShares <= FUND_CYCLE_SHARE_EPS) close(t.date);
      }
    }
    close(null); // 收尾：未清零 → 持有中
  }
  return out.sort((a, b) => a.openDate.localeCompare(b.openDate));
};

/** 授权信息响应形态（GET /tzzb-mcp/auth-info，dev server 本地端点，见 server/tzzb-mcp-proxy.ts） */
interface TzzbAuthInfo {
  /** 最近一次完整授权时间（毫秒）；无凭据记录时为 null */
  authorizedAt?: number | null;
  /** 最近一次鉴权流失败原因（鉴权流进行中 / 失败时透出，成功或重新发起时为 null） */
  authError?: string | null;
}

/** 鉴权启动响应形态（POST /tzzb-mcp/auth-start，dev server 本地端点） */
interface TzzbAuthStart {
  /** 浏览器打开的同花顺授权页地址 */
  authorizeUrl?: string;
  /** 非 2xx 时的错误码（AUTH_FLOW_IN_PROGRESS / TZZB_MCP_NOT_CONFIGURED / 上游错误摘要） */
  error?: string;
}

/** 发起鉴权结果：authorizeUrl 恒有值（进行中时为进行中流程的授权页地址，复用打开即可续走原流程） */
export interface TzzbMcpAuthStartResult {
  /** 授权页地址（调用方负责拉起系统浏览器） */
  authorizeUrl: string;
  /** 是否为已进行中的流程（true = 上次发起的流程尚未完成，本次为复用） */
  pending: boolean;
}

/** 授权清空响应形态（POST /tzzb-mcp/auth-clear，dev server 本地端点） */
interface TzzbAuthClear {
  /** 清空成功标记 */
  cleared?: boolean;
  /** 非 2xx 时的错误码（TZZB_MCP_NOT_CONFIGURED / TZZB_MCP_AUTH_CLEAR_FAILED） */
  error?: string;
}

/** MCP 鉴权轮询间隔（毫秒） */
const AUTH_POLL_INTERVAL_MS = 2_000;

/** MCP 鉴权整体超时（毫秒）：与代理软超时（10 分钟，见 server/tzzb-mcp-proxy.ts）对齐；
 * 超时后代理监听仍保持，用户晚完成授权依然落盘生效，只是前端不再等待 */
const AUTH_WAIT_TIMEOUT_MS = 600_000;

/** 直连通道展示前缀（顶栏同步状态第二行） */
const DIRECT_LABEL = 'MCP 直连';

/**
 * 取最近一次授权时间（上游授权有效期 1 个月，到期需重走浏览器授权，顶栏据此提示重授时点）
 * @returns 毫秒时间戳；未配置代理 / 请求失败时返回 null
 */
export const fetchAuthorizedAt = async (): Promise<number | null> => {
  // 打包版直连：凭据在前端 localStorage，读本地状态即可
  if (USE_DIRECT) return directAuthInfo().authorizedAt;
  try {
    const res = await fetch(`${MCP_PROXY_PATH}/auth-info`);
    if (!res.ok) return null;
    const json = (await res.json()) as TzzbAuthInfo;
    return typeof json.authorizedAt === 'number' && json.authorizedAt > 0
      ? json.authorizedAt
      : null;
  } catch {
    return null;
  }
};

/**
 * 发起 MCP 浏览器鉴权（dev/preview server 本地端点；server 起回环回调监听，
 * 浏览器完成授权后自动做 code 交换并把凭据落盘 oauth.local.json）。
 * 已有流程进行中（AUTH_FLOW_IN_PROGRESS）时不抛错：返回进行中流程的授权页地址
 * 并置 pending = true，调用方重新打开该地址完成授权即可续走原流程的回调与 code 交换
 * @returns 授权页地址 + 是否为进行中流程（pending）
 * @throws 鉴权流未配置（TZZB_MCP_NOT_CONFIGURED）/ 注册失败等（错误码或上游错误摘要）
 */
export const startTzzbMcpAuth = async (): Promise<TzzbMcpAuthStartResult> => {
  // 打包版直连：注册 / PKCE / 回环回调（Rust 命令）/ code 交换全在前端与 Rust 侧完成
  if (USE_DIRECT) return directAuthStart();
  const res = await fetch(`${MCP_PROXY_PATH}/auth-start`, { method: 'POST' });
  const json = (await res.json().catch(() => ({}))) as TzzbAuthStart;
  if (!res.ok) {
    if (json.error === 'AUTH_FLOW_IN_PROGRESS' && json.authorizeUrl) {
      return { authorizeUrl: json.authorizeUrl, pending: true };
    }
    throw new Error(json.error ?? `auth-start HTTP ${res.status}`);
  }
  if (!json.authorizeUrl) throw new Error('auth-start 未返回授权地址');
  return { authorizeUrl: json.authorizeUrl, pending: false };
};

/**
 * 清空本地 MCP 授权信息（POST /tzzb-mcp/auth-clear）：删除凭据文件中的
 * 动态注册（registration）、OAuth 令牌（tokens）与授权时间（authorized_at），
 * 下次授权将重新走动态注册；用于注册失效（refresh 报 invalid_client）等场景
 * @throws 清空失败（未配置凭据文件 / 落盘失败）
 */
export const clearTzzbMcpAuth = async (): Promise<void> => {
  // 打包版直连：清前端 localStorage 凭据
  if (USE_DIRECT) {
    directAuthClear();
    return;
  }
  const res = await fetch(`${MCP_PROXY_PATH}/auth-clear`, { method: 'POST' });
  const json = (await res.json().catch(() => ({}))) as TzzbAuthClear;
  if (!res.ok || json.error) throw new Error(json.error ?? `auth-clear HTTP ${res.status}`);
};

/**
 * 等待鉴权完成：轮询 auth-info，直到 authorizedAt 晚于起点（成功）或透出 authError（失败）
 * @param sinceMs 发起鉴权前的授权时间（毫秒；无记录传 0）
 * @param timeoutMs 整体超时（毫秒）
 * @returns resolve 完成后的授权时间（毫秒）
 * @throws 超时 / 服务端透出的鉴权失败原因
 */
export const waitTzzbMcpAuthorized = (sinceMs: number, timeoutMs: number = AUTH_WAIT_TIMEOUT_MS): Promise<number> =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      try {
        // 打包版直连：轮询前端凭据状态（auth_error / authorized_at 由直连鉴权流维护）
        const json: TzzbAuthInfo = USE_DIRECT
          ? directAuthInfo()
          : await fetch(`${MCP_PROXY_PATH}/auth-info`)
              .then((res) => res.json().catch(() => ({})) as TzzbAuthInfo)
              .catch(() => ({}));
        if (json.authError) {
          reject(new Error(json.authError));
          return;
        }
        if (typeof json.authorizedAt === 'number' && json.authorizedAt > sinceMs) {
          resolve(json.authorizedAt);
          return;
        }
      } catch {
        // 网络抖动继续轮询，直到整体超时
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('等待授权超时'));
        return;
      }
      window.setTimeout(() => void tick(), AUTH_POLL_INTERVAL_MS);
    };
    void tick();
  });

/**
 * 同步状态（直连阶段为实时拉取口径；第二行附最近一次授权时间——上游授权有效期
 * 1 个月，供判断何时需要重新授权）
 * @returns 同步状态文案
 */
export const getTzzbSyncMeta = async (): Promise<TzzbSyncMeta> => {
  const authorizedAt = await fetchAuthorizedAt();
  return {
    lastSyncLabel: `${dayjs().format('YYYY-MM-DD HH:mm')}（实时）`,
    dataDate: dayjs().format('YYYY-MM-DD'),
    authExpireLabel: authorizedAt
      ? `${DIRECT_LABEL}-授权时间：${dayjs(authorizedAt).format('YYYY-MM-DD HH:mm')}`
      : DIRECT_LABEL,
  };
};
