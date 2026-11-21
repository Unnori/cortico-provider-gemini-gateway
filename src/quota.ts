import { createHttp2Connector, createProxyFetchFor, type Http2Connector } from './http.ts';
import type { AccountRoutingMode } from './options.ts';
import { GatewayError, inspectHttpError } from './queue.ts';
import { isRobinGrpcRoute, queryRobinGrpcUsageInfo, ROBIN_GRPC_GET_USAGE_INFO } from './robin-grpc.ts';
import { httpUrl, record } from './state.ts';

export const DEFAULT_ROBIN_QUOTA_ENDPOINT = '/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo?$alt=json';
export const DEFAULT_ROBIN_GRPC_QUOTA_ENDPOINT = ROBIN_GRPC_GET_USAGE_INFO;

export type QuotaBarMode = 'remaining' | 'used';

export interface QuotaWindow {
  id: string;
  poolType: string;
  title?: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: string;
}

export interface AccountQuotaOption {
  id: string;
  email?: string;
  isPrimary: boolean;
}

export interface AccountQuotaSnapshot {
  accountId: string;
  email?: string;
  isPrimary: boolean;
  plan?: string;
  userTier?: string;
  windows: QuotaWindow[];
  creditsRemaining?: number;
  useOverageAiCredits?: boolean;
  cooldownUntil?: number;
  cooldownReason?: string;
  fetchedAt: string;
  error?: string;
}

export interface QuotaSnapshot {
  supported: boolean;
  authRequired?: boolean;
  plan?: string;
  userTier?: string;
  windows: QuotaWindow[];
  creditsRemaining?: number;
  useOverageAiCredits?: boolean;
  fetchedAt: string;
  endpoint?: string;
  note?: string;
  selectedAccountId?: string;
  totalAccounts?: number;
  emailsMasked?: boolean;
  quotaBarMode?: QuotaBarMode;
  accountRouting?: AccountRoutingMode;
  accountOptions?: AccountQuotaOption[];
  accounts?: AccountQuotaSnapshot[];
}

export interface QuotaQueryOptions {
  baseUrl: string;
  protocol: 'rpc' | 'gemini' | 'robin';
  quotaEndpoint?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  auth?: { accessToken(force?: boolean): Promise<string> };
  authHeader?: string;
  authPrefix?: string;
  proxyUrl?: string;
  fetch?: typeof fetch;
  connectHttp2?: Http2Connector;
}

export function robinPlanName(userTier: unknown): string | undefined {
  if (typeof userTier !== 'string' || !userTier.trim()) return undefined;
  const raw = userTier.trim().toUpperCase();
  switch (raw) {
    case 'TIER_ULTRA':
    case 'TIER_NEON':
    case 'TIER2':
      return 'Ultra';
    case 'TIER_PRO':
    case 'TIER_PREMIUM':
    case 'TIER1':
      return 'Pro';
    case 'TIER_PLUS':
    case 'TIER_LITE':
    case 'TIER_HELIUM':
      return 'Plus';
    case 'TIER_BASIC':
    case 'TIER_FREE':
    case 'TIER0':
      return 'Free';
    case 'TIER_EXPANDED':
      return 'Expanded';
    default:
      if (raw.includes('ULTRA') || raw.includes('NEON')) return 'Ultra';
      if (raw.includes('PRO')) return 'Pro';
      if (raw.includes('PLUS') || raw.includes('LITE') || raw.includes('HELIUM')) return 'Plus';
      if (raw.includes('FREE') || raw.includes('BASIC')) return 'Free';
      return userTier.trim();
  }
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function parseQuotaResponse(raw: unknown, endpoint?: string, fetchedAt = new Date().toISOString()): QuotaSnapshot {
  const root = record(raw);
  if (!root) throw new Error('Quota endpoint returned non-object JSON');

  const userTier = typeof root.userTier === 'string' && root.userTier.trim() ? root.userTier.trim() : undefined;
  const plan = robinPlanName(userTier) ?? (typeof root.plan === 'string' && root.plan.trim() ? root.plan.trim() : undefined);
  const windows: QuotaWindow[] = [];
  let creditsRemaining: number | undefined = num(root.creditsRemaining);
  let useOverageAiCredits: boolean | undefined;

  if (Array.isArray(root.usage)) {
    for (const item of root.usage) {
      const entry = record(item);
      if (!entry) continue;
      const poolType = typeof entry.budgetPoolType === 'string' ? entry.budgetPoolType : '';
      if (poolType === 'OVERAGE_CREDITS') {
        const credits = record(entry.credits);
        const remaining = num(credits?.creditsRemaining);
        if (remaining !== undefined) creditsRemaining = remaining;
        if (typeof credits?.useOverageAiCredits === 'boolean') useOverageAiCredits = credits.useOverageAiCredits;
        continue;
      }
      const gxu = record(entry.gxu);
      if (!gxu) continue;
      const pctUsedRaw = num(gxu.pctUsed) ?? 0;
      const fraction = Math.min(Math.max(pctUsedRaw, 0), 1);
      const usedPercent = round1(fraction * 100);
      const remainingPercent = round1((1 - fraction) * 100);
      const resetsAt = typeof gxu.windowRefreshesAt === 'string' && gxu.windowRefreshesAt ? gxu.windowRefreshesAt : undefined;
      const title = typeof gxu.title === 'string' && gxu.title ? gxu.title : undefined;
      windows.push({
        id: poolType === 'GXU_FIVE_HOURLY' ? 'fiveHour' : poolType === 'GXU_WEEKLY' ? 'weekly' : poolType.toLowerCase() || 'window',
        poolType: poolType || 'GXU',
        ...(title ? { title } : {}),
        usedPercent,
        remainingPercent,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  } else if (Array.isArray(root.windows)) {
    for (const [index, item] of root.windows.entries()) {
      const entry = record(item);
      if (!entry) continue;
      const used = num(entry.usedPercent);
      const remaining = num(entry.remainingPercent);
      const usedPercent = used !== undefined ? round1(Math.min(Math.max(used, 0), 100))
        : remaining !== undefined ? round1(100 - Math.min(Math.max(remaining, 0), 100)) : 0;
      const remainingPercent = round1(100 - usedPercent);
      windows.push({
        id: typeof entry.id === 'string' && entry.id ? entry.id : `window_${index}`,
        poolType: typeof entry.poolType === 'string' ? entry.poolType : 'CUSTOM',
        ...(typeof entry.title === 'string' && entry.title ? { title: entry.title } : {}),
        usedPercent,
        remainingPercent,
        ...(typeof entry.resetsAt === 'string' && entry.resetsAt ? { resetsAt: entry.resetsAt } : {}),
      });
    }
  } else {
    const used = num(root.usedPercent);
    const remaining = num(root.remainingPercent);
    if (used !== undefined || remaining !== undefined) {
      const usedPercent = used !== undefined ? round1(Math.min(Math.max(used, 0), 100))
        : round1(100 - Math.min(Math.max(remaining!, 0), 100));
      windows.push({
        id: 'quota',
        poolType: 'CUSTOM',
        usedPercent,
        remainingPercent: round1(100 - usedPercent),
        ...(typeof root.resetsAt === 'string' && root.resetsAt ? { resetsAt: root.resetsAt } : {}),
      });
    }
  }

  const order = new Map([['fiveHour', 0], ['weekly', 1]]);
  windows.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));

  return {
    supported: true,
    ...(plan ? { plan } : {}),
    ...(userTier ? { userTier } : {}),
    windows,
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
    ...(useOverageAiCredits !== undefined ? { useOverageAiCredits } : {}),
    fetchedAt,
    ...(endpoint ? { endpoint } : {}),
  };
}

export function resolveQuotaEndpoint(baseUrl: string, protocol: 'rpc' | 'gemini' | 'robin', quotaEndpoint?: string): string | undefined {
  const route = quotaEndpoint?.trim() || (protocol === 'robin' ? DEFAULT_ROBIN_QUOTA_ENDPOINT : undefined);
  if (!route) return undefined;
  return httpUrl(new URL(route, baseUrl.replace(/\/+$/, '') + '/').href).href;
}

export async function queryGatewayQuota(options: QuotaQueryOptions, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const configuredRoute = options.quotaEndpoint?.trim();
  const defaultRoute = options.protocol === 'robin'
    ? (!options.fetch && options.baseUrl.startsWith('https://') ? DEFAULT_ROBIN_GRPC_QUOTA_ENDPOINT : DEFAULT_ROBIN_QUOTA_ENDPOINT)
    : undefined;
  const route = configuredRoute || defaultRoute;
  const fetchedAt = new Date().toISOString();
  if (!route) {
    return {
      supported: false,
      windows: [],
      fetchedAt,
      note: '当前协议未配置额度查询端点；可在「网关与协议配置」填写 quotaEndpoint 或切换至 Robin 协议。',
    };
  }

  const useGrpc = options.protocol === 'robin' && isRobinGrpcRoute(route);
  const url = httpUrl(new URL(route, options.baseUrl.replace(/\/+$/, '') + '/').href).href;
  const request = options.fetch ?? createProxyFetchFor(options.proxyUrl);
  const h2Connector = options.connectHttp2 ?? createHttp2Connector(options.proxyUrl);
  const deadline = AbortSignal.timeout(15_000);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = new Headers(options.headers);
    if (options.auth) {
      const token = await options.auth.accessToken(attempt === 1);
      headers.set(options.authHeader ?? 'Authorization', `${options.authPrefix ?? 'Bearer '}${token}`);
    }

    if (useGrpc) {
      try {
        return await queryRobinGrpcUsageInfo({
          baseUrl: options.baseUrl,
          path: route,
          headers,
          signal: combinedSignal,
          connectHttp2: h2Connector,
        });
      } catch (error) {
        if (error instanceof GatewayError && error.status === 401 && attempt === 0 && options.auth && !combinedSignal.aborted) {
          continue;
        }
        throw error;
      }
    }

    headers.set('Content-Type', headers.get('Content-Type') ?? 'application/x-protobuf');
    headers.set('Accept', headers.get('Accept') ?? 'application/json');

    const response = await request(url, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: combinedSignal,
    });

    if (response.status === 401 && attempt === 0 && options.auth) {
      await response.body?.cancel().catch(() => {});
      continue;
    }

    if (!response.ok) {
      const info = await inspectHttpError(response);
      throw new Error(`Quota endpoint returned HTTP ${info.status}${info.detail ? `: ${info.detail}` : ''}`);
    }

    const raw: unknown = await response.json();
    return parseQuotaResponse(raw, url, new Date().toISOString());
  }

  throw new Error('Quota endpoint returned HTTP 401');
}
