import { createServer as createHttpServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Connect, Plugin } from 'vite';

/** 同源代理路径（前端 MCP 客户端统一 POST 此路径） */
export const TZZB_MCP_PROXY_PATH = '/tzzb-mcp';

/** 授权信息子路径（GET <TZZB_MCP_PROXY_PATH>/auth-info；仅本地 dev server 提供，不透传上游） */
export const TZZB_MCP_AUTH_INFO_PATH = '/auth-info';

/** 鉴权启动子路径（POST <TZZB_MCP_PROXY_PATH>/auth-start；仅本地 dev server 提供，不透传上游） */
export const TZZB_MCP_AUTH_START_PATH = '/auth-start';

/**
 * 正式环境 MCP endpoint（2026-11-09 正式环境发布，写死此处的唯一目标地址；
 * 与前端 src/common/api/tzzb.api.ts 的 TZZB_MCP_ENDPOINT 保持一致，换环境两处同步改）
 */
const OFFICIAL_MCP_ENDPOINT = 'https://tzzb.10jqka.com.cn/mcp';

/** 生效 target / token 的惰性解析器（每次调用读配置文件，弹窗保存即生效） */
type ValueGetter = () => string | undefined;

/** 鉴权回调回环端口（与 tzzb-auth-helper.mjs 同一注册 redirect_uri，复用已有 registration） */
const REDIRECT_PORT = 8791;

/** OAuth 回调地址（loopback；上游 registration 白名单里就是它，勿改） */
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

/** 鉴权流整体超时（毫秒）：浏览器登录 + 确认授权给 5 分钟足够 */
const AUTH_FLOW_TIMEOUT_MS = 300_000;

/** 上游透传的请求头（MCP 会话 / 协议版本 / 鉴权 / SSE 续传） */
const PASSTHROUGH_HEADERS = [
  'authorization',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;

/** 上游回传给浏览器的响应头 */
const RESPONSE_HEADERS = ['mcp-session-id', 'mcp-protocol-version'] as const;

/** 上游超时（MCP 工具调用可能较慢，放宽到 60s） */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** 上游请求 UA（WAF 对非浏览器 UA 敏感，伪装成真实 Chrome） */
const UPSTREAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * WAF 回显熔断基础冷却（毫秒）。实测（2026-11-09）：瞬时并发触发 hexin-waf
 * 影子封禁后，上游对**任何**请求（任意路径/方法/UA/token）回 200 + 请求头回显，
 * 从最后一次请求起静默约 3 分钟才解除 —— 期间任何重试都会续封，所以触发后
 * 必须完全静默冷却，而不是短间隔退避（短退避会永远解不了封）
 */
const WAF_COOLDOWN_MS = 180_000;
/** WAF 冷却上限（连续触发时冷却时长指数递增，封顶 30 分钟） */
const WAF_COOLDOWN_MAX_MS = 30 * 60_000;

/** WAF 熔断状态（同进程所有请求共享）：回显触发后进入冷却，冷却期内请求快速
 * 失败（不打上游）；冷却结束放行下一个请求作探测 —— 成功则复位，仍回显则冷却
 * 时长翻倍（连续触发说明封禁未过，继续打只会续封） */
const wafBreaker = { cooldownUntil: 0, strikes: 0 };

/** 合法上游响应体的开头特征（JSON-RPC 单响应 / SSE 帧 / SSE 注释行） */
const JSONRPC_BODY_PREFIXES = ['{"jsonrpc"', 'event:', 'data:', ':'] as const;

/** 上游响应体 reader 的最小结构（Node fetch body.getReader() 返回，宽于标准类型） */
interface UpstreamBodyReader {
  /** 读取下一块 */
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  /** 提前终止（丢弃 WAF 回显时用） */
  cancel: () => Promise<void>;
}

/** 响应体预读首块 */
interface UpstreamBodyChunk {
  /** 流是否已读完 */
  done: boolean;
  /** 块数据 */
  value?: Uint8Array;
}

/**
 * 凭据文件形态（.ai/项目资源/tzzb-mcp/oauth.local.json，由
 * tzzb-auth-helper.mjs 维护；gitignore 覆盖不入库）
 */
interface TzzbAuthFile {
  /** 动态注册的客户端信息（client_id / client_secret） */
  registration?: {
    client_id?: string;
    client_secret?: string;
    /** 客户端注册时间（秒级时间戳；授权时间缺记录时的回落值） */
    client_id_issued_at?: number;
  };
  /** OAuth token（access_token / refresh_token / expires_at 毫秒时间戳） */
  tokens?: { access_token?: string; refresh_token?: string; expires_at?: number } | null;
  /** 最近一次完整浏览器授权完成时间（毫秒；tzzb-auth-helper.mjs 授权成功后落盘） */
  authorized_at?: number;
}

/**
 * 凭据读取与刷新（tokenFile 未配置时全部为 no-op）
 * @param getTarget 上游 MCP endpoint 惰性解析器（派生 token endpoint，编辑后即生效）
 * @param tokenFile 凭据文件路径（oauth.local.json）
 * @returns getAccessToken 取可用 token / refresh 强制续期
 */
const createAuthProvider = (getTarget: ValueGetter, tokenFile: string | undefined) => {
  /** token endpoint（上游 origin + /oauth2/token；按当前生效 target 派生）
   * @returns token endpoint 绝对地址；target 未配置时 null
   */
  const tokenEndpoint = (): string | null => {
    const target = getTarget();
    return target ? new URL('/oauth2/token', target).toString() : null;
  };

  /**
   * 读凭据文件
   * @returns 凭据对象；文件缺失返回 null
   */
  const load = (): TzzbAuthFile | null => {
    if (!tokenFile) return null;
    try {
      return JSON.parse(readFileSync(tokenFile, 'utf-8')) as TzzbAuthFile;
    } catch {
      return null;
    }
  };

  /**
   * 用 refresh_token 续期并回写凭据文件（实际请求逻辑，由 refresh 单飞包装）
   * @returns 新 access token；续期失败返回 null
   */
  const doRefresh = async (): Promise<string | null> => {
    const store = load();
    const refreshToken = store?.tokens?.refresh_token;
    const clientId = store?.registration?.client_id;
    const clientSecret = store?.registration?.client_secret;
    const endpoint = tokenEndpoint();
    if (!tokenFile || !refreshToken || !clientId || !clientSecret || !endpoint) return null;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as Record<string, unknown>;
      const accessToken = json['access_token'];
      if (typeof accessToken !== 'string') return null;
      const expiresIn = Number(json['expires_in'] ?? 3600);
      store.tokens = {
        ...store.tokens,
        access_token: accessToken,
        refresh_token:
          typeof json['refresh_token'] === 'string'
            ? (json['refresh_token'] as string)
            : refreshToken,
        expires_at: Date.now() + (expiresIn - 60) * 1000,
      };
      writeFileSync(tokenFile, JSON.stringify(store, null, 2));
      return accessToken;
    } catch {
      return null;
    }
  };

  /** 进行中的续期（单飞：上游 access token 仅 5 分钟有效，突发并发会同时到期，
   * 多个 401 触发并发 refresh 时 refresh_token 轮换会互相顶掉 —— 必须合并为一次） */
  let refreshing: Promise<string | null> | null = null;

  /**
   * 取当前可用的 access token（过期先续期；并发续期合并为一次请求）
   * @returns Bearer token；无凭据返回 null
   */
  const refresh = async (): Promise<string | null> => {
    if (refreshing) return refreshing;
    refreshing = doRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  /**
   * 取当前可用的 access token（过期先续期）
   * @returns Bearer token；无凭据返回 null
   */
  const getAccessToken = async (): Promise<string | null> => {
    const store = load();
    const token = store?.tokens?.access_token;
    if (!token) return null;
    if ((store.tokens?.expires_at ?? 0) > Date.now() + 60_000) return token;
    return (await refresh()) ?? token;
  };

  /**
   * 取最近一次完整授权时间（上游授权有效期 1 个月，看板顶栏据此提示重授时点）
   * @returns 毫秒时间戳：优先凭据文件的 authorized_at（tzzb-auth-helper.mjs 完整授权后落盘），
   *          未记录时回落客户端注册时间 client_id_issued_at；无凭据文件返回 null
   */
  const getAuthorizedAt = (): number | null => {
    const store = load();
    const authorizedAt = typeof store?.authorized_at === 'number' ? store.authorized_at : 0;
    const issuedAt =
      typeof store?.registration?.client_id_issued_at === 'number'
        ? store.registration.client_id_issued_at * 1000
        : 0;
    return authorizedAt || issuedAt || null;
  };

  return { getAccessToken, refresh, getAuthorizedAt };
};

/** 鉴权启动响应（POST /tzzb-mcp/auth-start 的 200 响应体） */
interface TzzbAuthStartResult {
  /** 浏览器打开的同花顺授权页地址（调用方负责拉起系统浏览器） */
  authorizeUrl: string;
}

/**
 * 浏览器鉴权流启动器（与 .ai/项目资源/tzzb-mcp/tzzb-auth-helper.mjs 同一套流程）
 *
 * PKCE S256 + loopback 8791 回调：auth-start 返回授权页地址后，回调监听与
 * code 交换在后台进行；凭据（含 authorized_at）落盘同一份 oauth.local.json，
 * 完成后 auth-info 的 authorizedAt 前进、前端轮询即感知。
 *
 * @param getTarget 上游 MCP endpoint 惰性解析器（派生 origin 与 oauth2 端点）
 * @param tokenFile 凭据文件路径（oauth.local.json；未配置时 start 直接报错）
 * @returns start 启动一次鉴权流（进行中重复调用报 AUTH_FLOW_IN_PROGRESS）
 */
const createAuthFlowStarter = (getTarget: ValueGetter, tokenFile: string | undefined) => {
  /** 是否有进行中的鉴权流（单飞：重复点击不重复占回调端口） */
  let active = false;
  /** 最近一次鉴权流失败原因（成功 / 重新发起时清空；auth-info 透出给前端快速失败） */
  let lastAuthError: string | null = null;

  /**
   * 读凭据文件
   * @returns 凭据对象；文件缺失 / 损坏返回空结构
   */
  const loadStore = (): TzzbAuthFile => {
    try {
      return JSON.parse(readFileSync(tokenFile as string, 'utf-8')) as TzzbAuthFile;
    } catch {
      return {};
    }
  };

  /**
   * token 表单请求
   * @param url token endpoint
   * @param body 表单字段
   * @returns 响应 JSON；非 2xx 抛错（含上游错误摘要）
   */
  const postForm = async (url: string, body: Record<string, string>): Promise<Record<string, unknown>> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`token endpoint ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };

/**
 * 动态注册授权码客户端（已有 registration 则跳过）
 * @param store 凭据对象（注册成功后回写并落盘）
 * @param origin 上游 origin（oauth2 端点根，按当前生效 target 派生）
 * @returns 客户端注册信息
 */
const ensureRegistration = async (
  store: TzzbAuthFile,
  origin: string,
): Promise<NonNullable<TzzbAuthFile['registration']>> => {
  if (store.registration) return store.registration;
  const res = await fetch(`${origin}/oauth2/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        client_name: 'whf-stock-board-dev-authcode',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        redirect_uris: [REDIRECT_URI],
      }),
    });
    const reg = (await res.json().catch(() => ({}))) as NonNullable<TzzbAuthFile['registration']>;
    if (!reg.client_id) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 300)}`);
    store.registration = reg;
    writeFileSync(tokenFile as string, JSON.stringify(store, null, 2));
    return reg;
  };

  /**
   * 起回调监听并等待授权回调
   * @param server 回环 HTTP server（调用方负责 close）
   * @returns 授权回调 URL（含 code / state 或 error）
   */
  const waitCallback = (server: Server): Promise<URL> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待授权超时')), AUTH_FLOW_TIMEOUT_MS);
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', REDIRECT_URI);
        if (u.pathname !== '/callback') {
          res.end('ok');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>授权成功</h2>可关闭此窗口，回到股票看板。');
        clearTimeout(timer);
        resolve(u);
      });
      server.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      server.listen(REDIRECT_PORT, '127.0.0.1');
    });

  /**
   * 启动一次鉴权流：注册（如需）→ PKCE → 起回调监听 → 返回授权页地址；
   * 浏览器完成授权后的 code 交换与落盘在本 promise 后台继续
   * @returns 授权页地址
   * @throws TZZB_MCP_NOT_CONFIGURED / AUTH_FLOW_IN_PROGRESS / 注册失败等
   */
  const start = async (): Promise<TzzbAuthStartResult> => {
    const target = getTarget();
    if (!target || !tokenFile) throw new Error('TZZB_MCP_NOT_CONFIGURED');
    if (active) throw new Error('AUTH_FLOW_IN_PROGRESS');
    active = true;
    lastAuthError = null;
    /** 上游 origin（oauth2 端点根，按本次发起时的生效 target 派生） */
    const origin = new URL(target).origin;
    const server = createHttpServer();
    try {
      const store = loadStore();
      const reg = await ensureRegistration(store, origin);
      const verifier = Buffer.from(crypto.randomBytes(48)).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const state = crypto.randomBytes(12).toString('hex');
      const authorizeUrl = new URL(`${origin}/oauth2/authorize`);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', String(reg.client_id));
      authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('state', state);

      // 返回授权页地址后，回调等待与 code 交换转后台（前端轮询 auth-info 感知结果）
      void waitCallback(server)
        .then(async (callbackUrl) => {
          server.close();
          const error = callbackUrl.searchParams.get('error');
          if (error) {
            throw new Error(`授权失败: ${error} ${callbackUrl.searchParams.get('error_description') ?? ''}`);
          }
          if (callbackUrl.searchParams.get('state') !== state) {
            throw new Error('state 不匹配，疑似 CSRF，中止');
          }
          const json = await postForm(`${origin}/oauth2/token`, {
            grant_type: 'authorization_code',
            code: callbackUrl.searchParams.get('code') ?? '',
            redirect_uri: REDIRECT_URI,
            client_id: String(reg.client_id),
            client_secret: String(reg.client_secret ?? ''),
            code_verifier: verifier,
          });
          if (typeof json['access_token'] !== 'string') throw new Error('token endpoint 未返回 access_token');
          store.tokens = {
            ...store.tokens,
            access_token: json['access_token'],
            refresh_token:
              typeof json['refresh_token'] === 'string'
                ? (json['refresh_token'] as string)
                : store.tokens?.refresh_token,
            expires_at: Date.now() + (Number(json['expires_in'] ?? 3600) - 60) * 1000,
          };
          // 仅完整浏览器授权时更新 authorized_at（顶栏授权时间展示口径，同 helper）
          store.authorized_at = Date.now();
          writeFileSync(tokenFile as string, JSON.stringify(store, null, 2));
        })
        .catch((err: unknown) => {
          lastAuthError = err instanceof Error ? err.message : String(err);
          server.close();
        })
        .finally(() => {
          active = false;
        });
      return { authorizeUrl: authorizeUrl.toString() };
    } catch (err) {
      server.close();
      active = false;
      if (err instanceof Error && err.message === '等待授权超时') {
        lastAuthError = err.message;
      }
      throw err;
    }
  };

  return { start, getLastError: (): string | null => lastAuthError };
};

/**
 * 读取并拼接请求体（POST JSON / SSE 续传都需要原样透传）
 * @param req 入站请求流
 * @returns 请求体字节
 */
const readRequestBody = (req: Connect.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/**
 * 创建投资账本 MCP 同源代理中间件
 *
 * 浏览器直连外部 MCP 会被 CORS 拦（Streamable HTTP 要求自定义头 + OPTIONS 预检），
 * dev/preview server 以同源路径反向代理到上游 MCP endpoint：
 * - 目标地址写死正式环境 OFFICIAL_MCP_ENDPOINT（2026-11-09 正式环境发布；
 *   原 .env.local / tzzb-mcp.config.local.json 运行时配置与「编辑MCP」功能一并下线）；
 * - 鉴权：优先凭据文件（TZZB_MCP_TOKEN_FILE，oauth.local.json，由
 *   tzzb-auth-helper.mjs 维护，401 自动 refresh_token 续期重试），其次静态 token；
 * - 方法固定透传 POST（MCP Streamable HTTP 仅用 POST + 可选 GET 流）；
 *   例外：GET <同源路径>/auth-info、POST <同源路径>/auth-start
 *   为本地端点（授权时间 / 发起浏览器鉴权，不透传上游）；
 * - MCP 会话头双向透传（client → upstream 的 Mcp-Session-Id，upstream → client 的
 *   下发头）；响应体流式回写，SSE 渐进输出不被缓冲卡死
 * @param getTarget 生效 target 惰性解析器（恒返回正式环境 endpoint）
 * @param getToken 生效静态 token 惰性解析器
 * @param tokenFile 可选凭据文件路径（.env.local 的 TZZB_MCP_TOKEN_FILE）
 * @param auth 凭据提供器（取 token / 续期）
 * @param authFlow 浏览器鉴权流启动器（auth-start 用）
 * @returns Connect 兼容中间件
 */
const createTzzbMcpMiddleware =
  (
    getTarget: ValueGetter,
    getToken: ValueGetter,
    tokenFile: string | undefined,
    auth: ReturnType<typeof createAuthProvider>,
    authFlow: ReturnType<typeof createAuthFlowStarter>,
  ): Connect.NextHandleFunction =>
  async (req, res, _next) => {
    const urlPath = (req.url ?? '').split('?')[0];
    // 本地元信息端点：GET /tzzb-mcp/auth-info 返回最近一次授权时间 + 鉴权流失败原因
    //（不透传上游；MCP Streamable HTTP 客户端仅用 POST，GET 分支空闲可用）
    if (req.method === 'GET' && urlPath === TZZB_MCP_AUTH_INFO_PATH) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authorizedAt: auth.getAuthorizedAt(), authError: authFlow.getLastError() }));
      return;
    }
    // 本地鉴权端点：POST /tzzb-mcp/auth-start 发起浏览器鉴权流（返回授权页地址，
    // 回调与 code 交换在 dev server 后台进行，前端轮询 auth-info 感知结果）
    if (req.method === 'POST' && urlPath === TZZB_MCP_AUTH_START_PATH) {
      try {
        const result = await authFlow.start();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const known = message === 'AUTH_FLOW_IN_PROGRESS' || message === 'TZZB_MCP_NOT_CONFIGURED';
        res.statusCode = known ? 409 : 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }
    // 本地配置端点（GET/POST /tzzb-mcp/config 与「编辑MCP」功能）已于 2026-11-09
    // 随正式环境发布一并下线：上游目标写死 OFFICIAL_MCP_ENDPOINT，不再可改
    const target = getTarget();
    if (!target) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'TZZB_MCP_NOT_CONFIGURED' }));
      return;
    }
    // WAF 熔断冷却期：快速失败不打上游（任何重试都会续封，必须静默冷却）
    const nowMs = Date.now();
    if (nowMs < wafBreaker.cooldownUntil) {
      const retryAfterMs = wafBreaker.cooldownUntil - nowMs;
      res.statusCode = 503;
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'TZZB_MCP_WAF_COOLDOWN',
          retryAfterMs,
          message: `上游防护冷却中，约 ${Math.max(1, Math.ceil(retryAfterMs / 60_000))} 分钟后自动恢复（冷却期内请求快速失败，避免续封）`,
        }),
      );
      return;
    }
    try {
      const body = await readRequestBody(req);
      const buildHeaders = async (): Promise<Record<string, string>> => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          // 上游 WAF（hexin-waf）对非浏览器 UA 敏感，固定伪装成真实浏览器特征
          'User-Agent': UPSTREAM_USER_AGENT,
        };
        const bearer = (await auth.getAccessToken()) ?? getToken();
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        for (const name of PASSTHROUGH_HEADERS) {
          const value = req.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        return headers;
      };
      const doFetch = async () =>
        fetch(target, {
          method: 'POST',
          headers: await buildHeaders(),
          body,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      /**
       * 正常响应透传：写入状态 / 响应头后流式回写（SSE 事件到达即推给浏览器）
       * @param upstream 上游响应
       * @param reader 响应体 reader
       * @param first 已预读的首块（透传前判别 WAF 回显时读出，不能丢；未预读时 undefined）
       */
      const streamUpstream = async (
        upstream: Response,
        reader: UpstreamBodyReader,
        first?: UpstreamBodyChunk,
      ): Promise<void> => {
        res.statusCode = upstream.status;
        const contentType = upstream.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        for (const name of RESPONSE_HEADERS) {
          const value = upstream.headers.get(name);
          if (value) res.setHeader(name, value);
        }
        if (first?.value) res.write(first.value);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      let upstream = await doFetch();
      // token 失效：凭据文件存在时刷新续期后重试一次
      if (upstream.status === 401 && tokenFile) {
        await auth.refresh();
        upstream = await doFetch();
      }
      const reader = upstream.body?.getReader();
      // 非 200：原样透传状态与响应体（401/400 等错误体对客户端排障有用，不重试）
      if (upstream.status !== 200 || !reader) {
        res.statusCode = upstream.status;
        const contentType = upstream.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        for (const name of RESPONSE_HEADERS) {
          const value = upstream.headers.get(name);
          if (value) res.setHeader(name, value);
        }
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
        return;
      }
      // 预读首块判别 WAF 回显（200 + 请求头回显 JSON，合法 JSON-RPC 必以
      // {"jsonrpc" / event: / data: / : ping 开头）
      const first = await reader.read();
      const head =
        first.value && first.value.length > 0
          ? Buffer.from(first.value.slice(0, 32)).toString('utf-8')
          : '';
      const wafEcho = !first.done && head !== '' && !JSONRPC_BODY_PREFIXES.some((p) => head.startsWith(p));
      if (!wafEcho) {
        // 正常响应：熔断复位
        wafBreaker.strikes = 0;
        wafBreaker.cooldownUntil = 0;
        await streamUpstream(upstream, reader, first);
        return;
      }
      // WAF 影子封禁：触发熔断 —— 从现在起完全静默冷却（时长指数递增），
      // 冷却期内所有请求快速失败；严禁短间隔重试（任何请求都会续封）
      wafBreaker.strikes += 1;
      const cooldownMs = Math.min(WAF_COOLDOWN_MS * 2 ** (wafBreaker.strikes - 1), WAF_COOLDOWN_MAX_MS);
      wafBreaker.cooldownUntil = Date.now() + cooldownMs;
      await reader.cancel().catch(() => undefined);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'TZZB_MCP_WAF_ECHO',
          cooldownMs,
          message: `上游防护（WAF）触发影子封禁，代理将静默 ${Math.round(cooldownMs / 60_000)} 分钟后自动探测恢复；期间请勿频繁手动同步`,
        }),
      );
    } catch (error) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'TZZB_MCP_UPSTREAM_FAILED', message: String(error) }));
    }
  };

/**
 * Vite 插件：dev / preview server 挂载投资账本 MCP 同源代理
 * @param envToken 可选静态 Bearer token（.env.local 兜底）
 * @param tokenFile 可选凭据文件路径（.env.local 的 TZZB_MCP_TOKEN_FILE，优先于静态 token）
 * @returns Vite 插件对象
 */
export const tzzbMcpProxyPlugin = (envToken?: string, tokenFile?: string): Plugin => {
  /** 生效 target：正式环境已发布，写死 OFFICIAL_MCP_ENDPOINT
   * @returns 正式环境上游 endpoint
   */
  const getTarget: ValueGetter = () => OFFICIAL_MCP_ENDPOINT;
  /** 生效静态 token：.env.local 兜底
   * @returns 生效的静态 Bearer token；未配置时 undefined
   */
  const getToken: ValueGetter = () => envToken?.trim() || undefined;
  const auth = createAuthProvider(getTarget, tokenFile);
  const authFlow = createAuthFlowStarter(getTarget, tokenFile);
  const middleware = createTzzbMcpMiddleware(getTarget, getToken, tokenFile, auth, authFlow);
  return {
    name: 'tzzb-mcp-proxy',
    configureServer(server) {
      server.middlewares.use(TZZB_MCP_PROXY_PATH, middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(TZZB_MCP_PROXY_PATH, middleware);
    },
  };
};
