import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * 投资账本 MCP 直连通道（打包版 Tauri 专用，2026-11-10）
 *
 * dev / preview 环境的 MCP 请求与 OAuth 都由 vite 中间件代理承担
 * （server/tzzb-mcp-proxy.ts：同源 `/tzzb-mcp` 转发 + 凭据文件 + 回环回调监听）；
 * **打包版没有 dev server**，`/tzzb-mcp` 一律落空——这是 v4.36.0 打包版拿不到
 * 账本数据的根因。本模块在打包版里把整条链路搬进前端：
 *
 * - MCP 请求：经 tauri-plugin-http（Rust 直连，无 CORS；`https://*.10jqka.com.cn/*`
 *   已在 capabilities 白名单）直接打上游 endpoint，token 由前端注入 Authorization；
 * - OAuth：动态注册（公开客户端 PKCE-only）→ 授权页拉系统浏览器 →
 *   Rust 命令 `tzzb_wait_loopback_callback` 在 127.0.0.1:8791 等回调 →
 *   前端 state 校验 + code 交换 → 凭据落 localStorage（与 oauth.local.json 同构）；
 * - 续期：access_token 过期 / 401 时用 refresh_token 续期（单飞），失败清 token
 *   触发顶栏重授权流程。
 *
 * dev 环境不用本模块（走代理，凭据仍在服务端文件），两通道凭据互不迁移。
 */

/** 正式环境 MCP endpoint（与 server/tzzb-mcp-proxy.ts 的 OFFICIAL_MCP_ENDPOINT 保持一致） */
export const TZZB_MCP_ENDPOINT = 'https://tzzb.10jqka.com.cn/mcp';

/** OAuth 回调地址（loopback；上游 registration 白名单就是它，勿改） */
const REDIRECT_URI = 'http://127.0.0.1:8791/callback';

/** 回调等待硬超时（毫秒，对齐 dev 代理 AUTH_FLOW_HARD_TIMEOUT_MS） */
const AUTH_FLOW_HARD_TIMEOUT_MS = 30 * 60_000;

/** 上游请求 UA（与代理 UPSTREAM_USER_AGENT 保持同一指纹） */
const UPSTREAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** 上游 MCP scope（与代理 UPSTREAM_SCOPE 一致：公开客户端 refresh 才被 AS 认） */
const UPSTREAM_SCOPE = 'tools.read';

/** 直连模式判定：打包版 Tauri（dev 时 vite server 在，走代理） */
export const TZZB_USE_DIRECT: boolean = isTauri() && !import.meta.env.DEV;

/** 凭据本地存储 key（直连模式专用；dev 的凭据在代理侧文件，两套互不迁移） */
const OAUTH_STORAGE_KEY = 'whf:tzzb:oauth';

/** 凭据存储形态（与 oauth.local.json 同构） */
interface TzzbDirectStore {
  /** 动态注册的客户端信息（公开客户端 client_id） */
  registration?: { client_id?: string; token_endpoint_auth_method?: string };
  /** OAuth token（expires_at 毫秒时间戳） */
  tokens?: { access_token?: string; refresh_token?: string; expires_at?: number } | null;
  /** 最近一次完整浏览器授权完成时间（毫秒） */
  authorized_at?: number;
  /** 最近一次鉴权流失败原因（成功 / 重新发起时清空） */
  auth_error?: string | null;
  /** 进行中授权流的授权页地址（复用续走原流程） */
  active_authorize_url?: string | null;
}

/**
 * 读凭据存储
 * @returns 凭据对象（无记录 / 损坏时返回空对象）
 */
const loadStore = (): TzzbDirectStore => {
  try {
    return JSON.parse(localStorage.getItem(OAUTH_STORAGE_KEY) ?? '{}') as TzzbDirectStore;
  } catch {
    return {};
  }
};

/**
 * 写凭据存储
 * @param store 凭据对象（整包序列化落 localStorage）
 */
const saveStore = (store: TzzbDirectStore): void => {
  localStorage.setItem(OAUTH_STORAGE_KEY, JSON.stringify(store));
};

/** 上游 origin（oauth2 端点根） */
const upstreamOrigin = new URL(TZZB_MCP_ENDPOINT).origin;

/**
 * token endpoint（按上游 origin 派生）
 * @returns token endpoint 绝对地址
 */
const tokenEndpoint = (): string => `${upstreamOrigin}/oauth2/token`;

/**
 * 带默认头的 tauriFetch（UA 指纹统一）
 *
 * **Origin: '' 必传**：tauri-plugin-http 默认会自动附加 webview 来源
 * `Origin: http://tauri.localhost`（Windows），上游 hexin-waf / OAuth 服务的
 * CORS 白名单不认它，POST oauth2/* 一律 403 "Invalid CORS request"（纯文本体，
 * 表现为「注册失败: {}」——2026-11-10 打包版授权失败根因）。插件在
 * unsafe-headers feature 下收到空 Origin 会显式删除该头（commands.rs L305-309），
 * 请求回落为无 Origin 的服务端风格，上游正常放行。
 * @param url 请求地址
 * @param init 请求初始化（headers 与默认头合并，init 优先）
 * @returns 上游响应
 */
const upstreamFetch = (url: string, init: RequestInit): Promise<Response> =>
  tauriFetch(url, {
    ...init,
    headers: {
      Origin: '',
      'User-Agent': UPSTREAM_USER_AGENT,
      ...(init.headers as Record<string, string>),
    },
  });

/**
 * POST 表单到 oauth2 端点并解析 JSON
 * @param url 端点地址
 * @param params 表单字段
 * @returns 响应 JSON
 * @throws 非 2xx（错误体截断入 message，不加工）
 */
const postForm = async (
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> => {
  const res = await upstreamFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  // 先读原文再解析：非 JSON 错误体（WAF 回显 / 纯文本拒绝）原文进 message，不吞成 {}
  const text = await res.text();
  const json = ((): Record<string, unknown> => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  if (!res.ok) throw new Error(`${url} ${res.status}: ${text.slice(0, 300) || '（空响应体）'}`);
  return json;
};

/* ---------------- token 续期（单飞） ---------------- */

let refreshPromise: Promise<string | null> | null = null;

/**
 * 用 refresh_token 续期（实际逻辑，由 refresh 单飞包装）
 * @returns 新 access token；无凭据 / 续期失败返回 null（失败清 token，顶栏走重授权）
 */
/**
 * 用 refresh_token 续期（实际逻辑，由 refresh 单飞包装）
 * @returns 新 access token；无凭据 / 续期失败返回 null（失败清 token，顶栏走重授权）
 */
const doRefresh = async (): Promise<string | null> => {
  const store = loadStore();
  const refreshToken = store.tokens?.refresh_token;
  const clientId = store.registration?.client_id;
  // 公开客户端（'none'）refresh 才被 AS 认（与 dev 代理同口径）
  if (!refreshToken || !clientId || store.registration?.token_endpoint_auth_method !== 'none') {
    return null;
  }
  try {
    const json = await postForm(tokenEndpoint(), {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    if (typeof json['access_token'] !== 'string') return null;
    const current = loadStore();
    current.tokens = {
      access_token: json['access_token'],
      refresh_token:
        typeof json['refresh_token'] === 'string'
          ? (json['refresh_token'] as string)
          : refreshToken,
      expires_at: Date.now() + (Number(json['expires_in'] ?? 3600) - 60) * 1000,
    };
    saveStore(current);
    return current.tokens?.access_token ?? null;
  } catch {
    // invalid_client 等：清 token（authorized_at 保留展示授权时间），401 兜底触发重授权
    const current = loadStore();
    current.tokens = null;
    saveStore(current);
    return null;
  }
};

/**
 * token 续期单飞（并发请求共享一次）
 * @returns 新 access token；无凭据 / 失败返回 null
 */
const refreshAccessToken = (): Promise<string | null> => {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
};

/**
 * 取可用 access token（过期即续期）
 * @returns 可用 access token；无凭据 / 续期失败返回 null
 */
const getAccessToken = async (): Promise<string | null> => {
  const store = loadStore();
  const token = store.tokens;
  if (token?.access_token && (token.expires_at ?? 0) > Date.now() + 60_000) {
    return token.access_token;
  }
  return refreshAccessToken();
};

/* ---------------- MCP RPC ---------------- */

/**
 * 解析响应体：兼容 JSON 与 SSE（data: 行）两种形态（与 tzzb.api 的 parseRpcBody 同构；
 * 独立副本避免与 tzzb.api 循环依赖）
 * @param text 响应原文
 * @returns 解析出的 JSON-RPC 对象
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
 * 直连模式单次 POST JSON-RPC（自动带 Authorization + 会话头；401 续期重试一次）
 * @param payload JSON-RPC 请求或通知体
 * @param needSession 是否附带会话头
 * @param sessionId 当前会话 id
 * @returns 响应 JSON 与上游下发的会话 id
 */
export const directRpcPost = async (
  payload: Record<string, unknown>,
  needSession: boolean,
  sessionId: string | undefined,
): Promise<{ json: Record<string, unknown>; sessionId?: string }> => {
  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    };
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (needSession && sessionId) headers['Mcp-Session-Id'] = sessionId;
    return upstreamFetch(TZZB_MCP_ENDPOINT, { method: 'POST', headers, body: JSON.stringify(payload) });
  };
  let res = await attempt();
  // 401：token 失效，续期后重试一次（与 dev 代理 401→refresh→retry 行为对齐）
  if (res.status === 401 && (await refreshAccessToken()) !== null) {
    res = await attempt();
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}：${text.slice(0, 200)}`);
  const json = parseRpcBody(text);
  return { json, sessionId: res.headers.get('mcp-session-id') ?? undefined };
};

/* ---------------- OAuth 授权流 ---------------- */

/** 鉴权流进行中标记（进行中时 start 复用 active_authorize_url） */
let flowActive = false;

/**
 * base64url 随机串
 * @param bytes 随机字节数
 * @returns base64url 文案
 */
const randomB64url = (bytes: number): string => {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let bin = '';
  for (const byte of arr) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * SHA-256 → base64url（PKCE challenge）
 * @param input 原文（PKCE verifier）
 * @returns base64url 摘要
 */
const sha256B64url = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  let bin = '';
  for (const byte of new Uint8Array(digest)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * 动态注册公开客户端（已有 'none' 注册则复用）
 * @param store 凭据对象（注册成功回写并落盘）
 * @returns 注册信息
 */
const ensureRegistration = async (
  store: TzzbDirectStore,
): Promise<NonNullable<TzzbDirectStore['registration']>> => {
  if (
    store.registration?.client_id &&
    store.registration?.token_endpoint_auth_method === 'none'
  ) {
    return store.registration;
  }
  const res = await upstreamFetch(`${upstreamOrigin}/oauth2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'whf-stock-board-app-authcode',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      redirect_uris: [REDIRECT_URI],
    }),
  });
  // 先读原文再解析：上游异常（WAF 回显 / CORS 拒绝纯文本）时错误信息要带状态码与原文，不吞
  const regText = await res.text();
  const reg = ((): NonNullable<TzzbDirectStore['registration']> => {
    try {
      return JSON.parse(regText) as NonNullable<TzzbDirectStore['registration']>;
    } catch {
      return {};
    }
  })();
  if (!res.ok || !reg.client_id) {
    throw new Error(`注册失败 HTTP ${res.status}: ${regText.slice(0, 300) || '（空响应体）'}`);
  }
  store.registration = reg;
  saveStore(store);
  return reg;
};

/**
 * 直连模式鉴权状态（对齐 dev 代理 /auth-info 响应口径）
 * @returns 授权时间与最近失败原因
 */
export const directAuthInfo = (): { authorizedAt: number | null; authError: string | null } => {
  const store = loadStore();
  return { authorizedAt: store.authorized_at ?? null, authError: store.auth_error ?? null };
};

/** 直连模式清空授权（清注册 / token / 授权时间 / 失败原因 / 进行中地址） */
export const directAuthClear = (): void => {
  const store = loadStore();
  store.registration = undefined;
  store.tokens = null;
  store.authorized_at = undefined;
  store.auth_error = null;
  store.active_authorize_url = null;
  saveStore(store);
};

/**
 * 直连模式发起鉴权流：注册（如需）→ PKCE → Rust 回环监听 → 返回授权页地址；
 * 浏览器完成授权后的 state 校验、code 交换与落盘在后台 promise 继续
 * @returns 授权页地址 + 是否为进行中流程
 * @throws 注册失败 / 端口占用等（AUTH_FLOW_IN_PROGRESS 已在复用分支处理）
 */
export const directAuthStart = async (): Promise<{ authorizeUrl: string; pending: boolean }> => {
  const store = loadStore();
  if (flowActive) {
    if (store.active_authorize_url) return { authorizeUrl: store.active_authorize_url, pending: true };
    throw new Error('AUTH_FLOW_IN_PROGRESS');
  }
  flowActive = true;
  store.auth_error = null;
  try {
    const reg = await ensureRegistration(store);
    const verifier = randomB64url(48);
    const challenge = await sha256B64url(verifier);
    const state = randomB64url(9);
    const authorizeUrl = new URL(`${upstreamOrigin}/oauth2/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', String(reg.client_id));
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', UPSTREAM_SCOPE);
    authorizeUrl.searchParams.set('state', state);
    store.active_authorize_url = authorizeUrl.toString();
    saveStore(store);

    // 回调等待与 code 交换转后台（前端轮询 directAuthInfo 感知结果）
    void (async () => {
      try {
        const callbackUrl = await invoke<string>('tzzb_wait_loopback_callback', {
          timeoutMs: AUTH_FLOW_HARD_TIMEOUT_MS,
        });
        const callback = new URL(callbackUrl);
        const error = callback.searchParams.get('error');
        if (error) {
          throw new Error(`授权失败: ${error} ${callback.searchParams.get('error_description') ?? ''}`);
        }
        if (callback.searchParams.get('state') !== state) {
          throw new Error('state 不匹配，疑似 CSRF，中止');
        }
        // 公开客户端：交换只带 client_id，PKCE verifier 承担认证
        const json = await postForm(tokenEndpoint(), {
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          client_id: String(reg.client_id),
          code_verifier: verifier,
        });
        if (typeof json['access_token'] !== 'string') {
          throw new Error('token endpoint 未返回 access_token');
        }
        const latest = loadStore();
        latest.tokens = {
          access_token: json['access_token'],
          refresh_token:
            typeof json['refresh_token'] === 'string'
              ? (json['refresh_token'] as string)
              : latest.tokens?.refresh_token,
          expires_at: Date.now() + (Number(json['expires_in'] ?? 3600) - 60) * 1000,
        };
        latest.authorized_at = Date.now();
        latest.auth_error = null;
        latest.active_authorize_url = null;
        saveStore(latest);
      } catch (err: unknown) {
        const latest = loadStore();
        latest.auth_error = err instanceof Error ? err.message : String(err);
        latest.active_authorize_url = null;
        saveStore(latest);
      } finally {
        flowActive = false;
      }
    })();
    return { authorizeUrl: authorizeUrl.toString(), pending: false };
  } catch (err: unknown) {
    flowActive = false;
    store.auth_error = err instanceof Error ? err.message : String(err);
    saveStore(store);
    throw err;
  }
};
