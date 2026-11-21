import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { ProviderHost } from 'cortico/providers/base.ts';
import { createHttp2Connector, createProxyFetchFor, normalizeProxyUrl } from './http.ts';
import {
  API_KEY_FILE,
  maskSecretHint,
  readStoredApiKeyInfo,
  removeStoredApiKey,
  saveStoredApiKey,
  type StoredApiKeyInfo,
} from './api-key.ts';
import {
  DesktopOAuth,
  OAUTH_ACCOUNTS_FILE,
  OAUTH_CONFIG_FILE,
  OAUTH_TOKENS_FILE,
  type OAuthAccountSummary,
  type OAuthStatus,
  readBundledOAuthConfig,
  readOAuthConfig,
  readRawOAuthConfigText,
  removeOAuthConfig,
  saveOAuthConfig,
} from './oauth.ts';
import { configuration, resolveHeaders, shouldUseOAuth, type AccountRoutingMode } from './options.ts';
import { GatewayError } from './queue.ts';
import { geminiModelId } from './catalog.ts';
import {
  type AccountQuotaOption,
  type AccountQuotaSnapshot,
  type QuotaBarMode,
  type QuotaSnapshot,
  queryGatewayQuota,
} from './quota.ts';
import {
  acceptRobinTermsOfService,
  queryRobinUserStatus,
  type RobinRoutingObservation,
  type RobinTermsResult,
  type RobinUserStatus,
} from './robin-grpc.ts';
import { readState, record, writeState } from './state.ts';

export const UI_PREFS_FILE = 'ui-prefs.json';
const controls = new Map<string, GatewayControl>();

export function resolveOAuthDir(hostStateDir: string, entry: LLMProviderEntry): string {
  const profile = entry.options?.oauthProfile;
  if (typeof profile === 'string' && /^[a-f0-9-]{36}$/.test(profile)) {
    const profileDir = join(dirname(hostStateDir), '.gemini-gateway-oauth', profile);
    // Preserve CLI-written credentials if the endpoint was logged in via stateDir before adopting oauthProfile.
    const hasProfileCreds = existsSync(join(profileDir, OAUTH_ACCOUNTS_FILE))
      || existsSync(join(profileDir, OAUTH_TOKENS_FILE));
    const hasHostCreds = existsSync(join(hostStateDir, OAUTH_ACCOUNTS_FILE))
      || existsSync(join(hostStateDir, OAUTH_TOKENS_FILE));
    if (!hasProfileCreds && hasHostCreds) {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      if (existsSync(join(hostStateDir, OAUTH_ACCOUNTS_FILE))) {
        copyFileSync(join(hostStateDir, OAUTH_ACCOUNTS_FILE), join(profileDir, OAUTH_ACCOUNTS_FILE));
      }
      if (existsSync(join(hostStateDir, OAUTH_TOKENS_FILE))) {
        copyFileSync(join(hostStateDir, OAUTH_TOKENS_FILE), join(profileDir, OAUTH_TOKENS_FILE));
      }
      if (!existsSync(join(profileDir, OAUTH_CONFIG_FILE)) && existsSync(join(hostStateDir, OAUTH_CONFIG_FILE))) {
        copyFileSync(join(hostStateDir, OAUTH_CONFIG_FILE), join(profileDir, OAUTH_CONFIG_FILE));
      }
      if (!existsSync(join(profileDir, API_KEY_FILE)) && existsSync(join(hostStateDir, API_KEY_FILE))) {
        copyFileSync(join(hostStateDir, API_KEY_FILE), join(profileDir, API_KEY_FILE));
      }
      if (!existsSync(join(profileDir, UI_PREFS_FILE)) && existsSync(join(hostStateDir, UI_PREFS_FILE))) {
        copyFileSync(join(hostStateDir, UI_PREFS_FILE), join(profileDir, UI_PREFS_FILE));
      }
    }
    return profileDir;
  }
  return hostStateDir;
}

export function gatewayControl(host: Pick<ProviderHost, 'stateDir'>, entry: LLMProviderEntry): GatewayControl {
  const oauthDir = resolveOAuthDir(host.stateDir, entry);
  const key = resolve(oauthDir);
  let control = controls.get(key);
  if (!control) {
    control = new GatewayControl(oauthDir);
    controls.set(key, control);
  }
  const rawProxy = typeof entry.options?.proxyUrl === 'string' ? entry.options.proxyUrl : undefined;
  control.setProxyUrl(rawProxy ? normalizeProxyUrl(rawProxy) : undefined);
  return control;
}

export interface GatewayOAuthStatus extends OAuthStatus {
  authEnabled: boolean;
  oauthDir: string;
  emailsMasked: boolean;
  quotaBarMode: QuotaBarMode;
}

export interface AccountRuntimeInfo {
  plan?: string;
  userTier?: string;
  userStatus?: RobinUserStatus;
  quota?: QuotaSnapshot;
  cooldownUntil?: number;
  cooldownReason?: string;
  lastError?: string;
  fiveHourRemaining?: number;
  fiveHourResetsAt?: string;
  weeklyRemaining?: number;
  weeklyResetsAt?: string;
  quotaFetchedAt?: string;
  lastUsedAt?: number;
}

interface AccountRuntimeState {
  userStatus?: { value: RobinUserStatus; expiresAt: number };
  plan?: { plan?: string; userTier?: string; expiresAt: number };
  quota?: QuotaSnapshot;
  cooldownUntil?: number;
  cooldownReason?: string;
  lastError?: string;
  lastUsedAt?: number;
}

const ROBIN_STATUS_TTL_MS = 5 * 60_000;
const ROBIN_QUOTA_DOWNGRADE_REASONS = new Set([2, 3, 6, 8]);
const ROBIN_DOWNGRADE_COOLDOWN_MS = 5 * 60_000;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

function orderPrimaryFirst(accounts: readonly OAuthAccountSummary[]): OAuthAccountSummary[] {
  const primary = accounts.find(a => a.isPrimary);
  if (!primary) return [...accounts];
  return [primary, ...accounts.filter(a => a.id !== primary.id)];
}

export interface RecordedRobinRouting extends RobinRoutingObservation {
  accountId?: string;
}

export class GatewayControl {
  readonly oauthDir: string;
  readonly auth: DesktopOAuth;
  private readonly accountRuntime = new Map<string, AccountRuntimeState>();
  private readonly observedRouting = new Map<string, RecordedRobinRouting>();
  private rrCursor = 0;
  private emailsMasked = true;
  private quotaBarMode: QuotaBarMode = 'remaining';
  private activeProxyUrl?: string;
  private cachedProxyFetch?: { proxyUrl?: string; fn: typeof fetch };

  private static emptyOAuthConfig() {
    return {
      clientId: '',
      scopes: [],
      authEndpoint: 'https://accounts.google.com/o/oauth2/auth',
      tokenEndpoint: 'https://www.googleapis.com/oauth2/v4/token',
    };
  }

  constructor(oauthDir: string, request?: typeof fetch) {
    this.oauthDir = oauthDir;
    try {
      const prefs = record(readState(join(oauthDir, UI_PREFS_FILE)));
      if (prefs?.quotaBarMode === 'used' || prefs?.quotaBarMode === 'remaining') {
        this.quotaBarMode = prefs.quotaBarMode;
      }
    } catch {
      // Ignore malformed UI preferences and keep the default remaining-quota display.
    }
    const custom = readOAuthConfig(oauthDir);
    const bundled = custom ? undefined : readBundledOAuthConfig();
    const config = custom ?? bundled ?? GatewayControl.emptyOAuthConfig();
    const oauthFetch: typeof fetch = request ?? ((input, init) => this.fetchForProxy()(input, init));
    this.auth = new DesktopOAuth(config, oauthDir, oauthFetch, Boolean(custom));
  }

  private fetchForProxy(): typeof fetch {
    if (!this.cachedProxyFetch || this.cachedProxyFetch.proxyUrl !== this.activeProxyUrl) {
      this.cachedProxyFetch = {
        proxyUrl: this.activeProxyUrl,
        fn: createProxyFetchFor(this.activeProxyUrl),
      };
    }
    return this.cachedProxyFetch.fn;
  }

  setProxyUrl(proxyUrl?: string): void {
    const normalized = proxyUrl ? normalizeProxyUrl(proxyUrl) : undefined;
    if (this.activeProxyUrl !== normalized) {
      this.activeProxyUrl = normalized;
      this.cachedProxyFetch = undefined;
    }
  }

  private ensureRuntime(accountId: string): AccountRuntimeState {
    let rt = this.accountRuntime.get(accountId);
    if (!rt) {
      rt = {};
      this.accountRuntime.set(accountId, rt);
    }
    return rt;
  }

  private activeCooldown(rt: AccountRuntimeState | undefined, now = Date.now()): { until: number; reason?: string } | undefined {
    if (!rt?.cooldownUntil) return undefined;
    if (rt.cooldownUntil <= now) {
      rt.cooldownUntil = undefined;
      rt.cooldownReason = undefined;
      return undefined;
    }
    return { until: rt.cooldownUntil, ...(rt.cooldownReason ? { reason: rt.cooldownReason } : {}) };
  }

  isEmailsMasked(): boolean {
    return this.emailsMasked;
  }

  setEmailsMasked(masked: boolean): boolean {
    this.emailsMasked = Boolean(masked);
    return this.emailsMasked;
  }

  getQuotaBarMode(): QuotaBarMode {
    return this.quotaBarMode;
  }

  setQuotaBarMode(mode: QuotaBarMode): QuotaBarMode {
    this.quotaBarMode = mode === 'used' ? 'used' : 'remaining';
    writeState(join(this.oauthDir, UI_PREFS_FILE), { quotaBarMode: this.quotaBarMode });
    return this.quotaBarMode;
  }

  listAccountOptions(): AccountQuotaOption[] {
    const ordered = orderPrimaryFirst(this.auth.listAccounts({ revealEmail: !this.emailsMasked }));
    return ordered.map(acct => ({
      id: acct.id,
      ...(acct.email ? { email: acct.email } : {}),
      isPrimary: acct.isPrimary,
    }));
  }

  authEnabled(entry: LLMProviderEntry): boolean {
    return shouldUseOAuth(entry, this.oauthDir);
  }

  status(entry: LLMProviderEntry): GatewayOAuthStatus {
    this.refreshBundledConfig();
    const base = this.auth.status({ revealEmail: !this.emailsMasked });
    return {
      ...base,
      configured: base.configured,
      authEnabled: this.authEnabled(entry),
      oauthDir: this.oauthDir,
      emailsMasked: this.emailsMasked,
      quotaBarMode: this.quotaBarMode,
    };
  }

  refreshBundledConfig(): void {
    if (this.auth.status().customConfig || this.auth.status().pending) return;
    const bundled = readBundledOAuthConfig();
    if (bundled) this.auth.reconfigure(bundled, false);
  }

  readOAuthConfigText(): { text: string; custom: boolean } {
    return readRawOAuthConfigText(this.oauthDir);
  }

  apiKeyStatus(entry: LLMProviderEntry, host: Pick<ProviderHost, 'secret'>): {
    configured: boolean;
    source: 'stored' | 'env' | 'none';
    hint?: string;
    updatedAt?: string;
  } {
    const stored = readStoredApiKeyInfo(this.oauthDir);
    if (stored.configured) {
      return {
        configured: true,
        source: 'stored',
        ...(stored.hint ? { hint: stored.hint } : {}),
        ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
      };
    }
    if (entry.secret) {
      const envVal = host.secret(entry.secret);
      if (envVal) {
        return { configured: true, source: 'env', hint: maskSecretHint(envVal) };
      }
    }
    return { configured: false, source: 'none' };
  }

  saveApiKey(apiKey: string): StoredApiKeyInfo {
    return saveStoredApiKey(this.oauthDir, apiKey);
  }

  removeApiKey(): StoredApiKeyInfo {
    return removeStoredApiKey(this.oauthDir);
  }

  saveOAuthConfig(jsonText: string): OAuthStatus {
    const raw: unknown = JSON.parse(jsonText);
    const parsed = saveOAuthConfig(this.oauthDir, raw);
    this.auth.reconfigure(parsed, true);
    this.clearRobinCache();
    return this.auth.status({ revealEmail: !this.emailsMasked });
  }

  resetOAuthConfig(): OAuthStatus {
    removeOAuthConfig(this.oauthDir);
    const bundled = readBundledOAuthConfig();
    this.auth.reconfigure(bundled ?? GatewayControl.emptyOAuthConfig(), false);
    this.clearRobinCache();
    return this.auth.status({ revealEmail: !this.emailsMasked });
  }

  clearRobinCache(): void {
    this.accountRuntime.clear();
    this.observedRouting.clear();
    this.rrCursor = 0;
  }

  removeAccountState(accountId: string): void {
    this.accountRuntime.delete(accountId);
  }

  markAccountCooldown(accountId: string, durationMs: number, reason: string): void {
    const rt = this.ensureRuntime(accountId);
    const until = Date.now() + Math.max(1_000, durationMs);
    rt.cooldownUntil = Math.max(rt.cooldownUntil ?? 0, until);
    rt.cooldownReason = reason;
    rt.lastError = reason;
  }

  markAccountTermsRequired(accountId: string): void {
    this.auth.setAccountTermsStatus(accountId, 'required');
  }

  markAccountTermsAccepted(accountId: string, meta?: { version?: number; acceptedAt?: string }): void {
    const existing = this.auth.listAccounts().find(a => a.id === accountId);
    if (!existing) return;
    if (existing.termsStatus !== 'accepted' || meta?.version !== undefined) {
      this.auth.setAccountTermsStatus(accountId, 'accepted', meta);
    }
  }

  clearAccountCooldown(accountId: string): void {
    const rt = this.ensureRuntime(accountId);
    rt.cooldownUntil = undefined;
    rt.cooldownReason = undefined;
    rt.lastError = undefined;
    rt.lastUsedAt = Date.now();
  }

  recordAccountError(accountId: string, message: string): void {
    const rt = this.ensureRuntime(accountId);
    rt.lastError = message;
  }

  getAccountRuntime(accountId: string): AccountRuntimeInfo {
    const rt = this.accountRuntime.get(accountId);
    if (!rt) return {};
    const cd = this.activeCooldown(rt);
    const fiveHour = rt.quota?.windows.find(w => w.id === 'fiveHour');
    const weekly = rt.quota?.windows.find(w => w.id === 'weekly');
    return {
      ...(rt.plan?.plan ? { plan: rt.plan.plan } : {}),
      ...(rt.plan?.userTier ? { userTier: rt.plan.userTier } : {}),
      ...(rt.userStatus?.value ? { userStatus: rt.userStatus.value } : {}),
      ...(rt.quota ? { quota: rt.quota, quotaFetchedAt: rt.quota.fetchedAt } : {}),
      ...(cd ? { cooldownUntil: cd.until, ...(cd.reason ? { cooldownReason: cd.reason } : {}) } : {}),
      ...(rt.lastError ? { lastError: rt.lastError } : {}),
      ...(fiveHour ? {
        fiveHourRemaining: fiveHour.remainingPercent,
        ...(fiveHour.resetsAt ? { fiveHourResetsAt: fiveHour.resetsAt } : {}),
      } : {}),
      ...(weekly ? {
        weeklyRemaining: weekly.remainingPercent,
        ...(weekly.resetsAt ? { weeklyResetsAt: weekly.resetsAt } : {}),
      } : {}),
      ...(rt.lastUsedAt !== undefined ? { lastUsedAt: rt.lastUsedAt } : {}),
    };
  }

  pickAccountOrder(routing: AccountRoutingMode): string[] {
    const ordered = routing === 'failover'
      ? orderPrimaryFirst(this.auth.listAccounts())
      : this.auth.listAccounts();
    if (ordered.length <= 1) return ordered.map(a => a.id);

    const now = Date.now();
    const healthy: OAuthAccountSummary[] = [];
    const cooled: { acct: OAuthAccountSummary; until: number }[] = [];
    for (const acct of ordered) {
      const cd = this.activeCooldown(this.accountRuntime.get(acct.id), now);
      if (cd) cooled.push({ acct, until: cd.until });
      else healthy.push(acct);
    }

    cooled.sort((a, b) => a.until - b.until);

    let orderedHealthy = healthy;
    if (routing === 'round-robin' && healthy.length > 1) {
      const offset = this.rrCursor++ % healthy.length;
      orderedHealthy = [...healthy.slice(offset), ...healthy.slice(0, offset)];
    } else if (routing === 'least-used' && healthy.length > 1) {
      orderedHealthy = [...healthy].sort((a, b) => {
        const ra = this.getAccountRuntime(a.id);
        const rb = this.getAccountRuntime(b.id);
        const exhaustedA = ra.fiveHourRemaining !== undefined && ra.fiveHourRemaining <= 5;
        const exhaustedB = rb.fiveHourRemaining !== undefined && rb.fiveHourRemaining <= 5;
        if (exhaustedA !== exhaustedB) return exhaustedA ? 1 : -1;
        const weekA = ra.weeklyRemaining ?? ra.fiveHourRemaining ?? 50;
        const weekB = rb.weeklyRemaining ?? rb.fiveHourRemaining ?? 50;
        if (weekA !== weekB) return weekB - weekA;
        const fiveA = ra.fiveHourRemaining ?? 50;
        const fiveB = rb.fiveHourRemaining ?? 50;
        if (fiveA !== fiveB) return fiveB - fiveA;
        return 0;
      });
    }

    return [...orderedHealthy.map(a => a.id), ...cooled.map(c => c.acct.id)];
  }

  recordRouting(observation: RobinRoutingObservation, accountId?: string): void {
    const key = geminiModelId(observation.requestedModel).toLowerCase();
    this.observedRouting.set(key, {
      ...observation,
      ...(accountId ? { accountId } : {}),
    });
    if (this.observedRouting.size > 32) {
      const oldest = this.observedRouting.keys().next().value;
      if (oldest !== undefined) this.observedRouting.delete(oldest);
    }
    if (
      accountId
      && observation.downgradeReason !== undefined
      && ROBIN_QUOTA_DOWNGRADE_REASONS.has(observation.downgradeReason)
      && this.auth.listAccounts().length > 1
    ) {
      this.markAccountCooldown(
        accountId,
        ROBIN_DOWNGRADE_COOLDOWN_MS,
        `Robin 配额降级 (code ${observation.downgradeReason})`,
      );
    }
  }

  getObservedRouting(model: string): RecordedRobinRouting | undefined {
    return this.observedRouting.get(geminiModelId(model).toLowerCase());
  }

  describeAccount(accountId: string | undefined): string | undefined {
    if (!accountId) return undefined;
    const acct = this.auth.listAccounts({ revealEmail: !this.emailsMasked }).find(a => a.id === accountId);
    if (acct?.email) return acct.email;
    return accountId.replace(/^acct_/, '').slice(0, 6);
  }

  getCachedAccountInfo(accountId?: string): { plan?: string; userTier?: string; userStatus?: RobinUserStatus } {
    const resolvedId = accountId ?? this.auth.primaryAccountId();
    const primaryRt = resolvedId ? this.accountRuntime.get(resolvedId) : undefined;
    let userStatus = primaryRt?.userStatus?.value;
    let plan = primaryRt?.plan?.plan;
    let userTier = primaryRt?.plan?.userTier;
    if (!userStatus || !plan) {
      for (const rt of this.accountRuntime.values()) {
        if (!userStatus && rt.userStatus?.value) userStatus = rt.userStatus.value;
        if (!plan && rt.plan?.plan) plan = rt.plan.plan;
        if (!userTier && rt.plan?.userTier) userTier = rt.plan.userTier;
      }
    }
    return {
      ...(plan ? { plan } : {}),
      ...(userTier ? { userTier } : {}),
      ...(userStatus ? { userStatus } : {}),
    };
  }

  resolveDiscoveredModeCategory(model: string, accountId?: string): number | undefined {
    const id = geminiModelId(model).toLowerCase();
    const resolvedId = accountId ?? this.auth.primaryAccountId();
    const primaryStatus = resolvedId ? this.accountRuntime.get(resolvedId)?.userStatus?.value : undefined;
    const direct = primaryStatus?.modes.find(mode => mode.modelId.toLowerCase() === id);
    if (direct) return direct.modeCategory;
    for (const rt of this.accountRuntime.values()) {
      const match = rt.userStatus?.value.modes.find(mode => mode.modelId.toLowerCase() === id);
      if (match) return match.modeCategory;
    }
    return undefined;
  }

  async queryUserStatus(
    entry: LLMProviderEntry,
    host: Pick<ProviderHost, 'secret'>,
    signal?: AbortSignal,
    force = false,
    accountId?: string,
  ): Promise<RobinUserStatus | null> {
    this.refreshBundledConfig();
    const config = configuration(entry);
    this.setProxyUrl(config.proxyUrl);
    if (config.protocol !== 'robin') return null;
    if (!this.authEnabled(entry)) return null;
    const resolvedId = accountId ?? this.auth.primaryAccountId();
    if (!resolvedId) return null;
    const rt = this.ensureRuntime(resolvedId);
    const now = Date.now();
    if (!force && rt.userStatus && rt.userStatus.expiresAt > now) {
      return rt.userStatus.value;
    }
    const baseHeaders = resolveHeaders(entry, host, false);
    const h2Connector = createHttp2Connector(config.proxyUrl);
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(baseHeaders);
      const token = await this.auth.accessTokenFor(resolvedId, attempt === 1);
      headers.set(config.authHeader ?? 'Authorization', `${config.authPrefix ?? 'Bearer '}${token}`);
      try {
        const status = await queryRobinUserStatus({
          baseUrl: config.baseUrl,
          headers,
          signal,
          connectHttp2: h2Connector,
        });
        rt.userStatus = { value: status, expiresAt: Date.now() + ROBIN_STATUS_TTL_MS };
        return status;
      } catch (error) {
        if (error instanceof GatewayError && error.status === 401 && attempt === 0 && !signal?.aborted) {
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  async queryQuota(
    entry: LLMProviderEntry,
    host: Pick<ProviderHost, 'secret'>,
    signal?: AbortSignal,
    targetAccountId?: string,
  ): Promise<QuotaSnapshot> {
    this.refreshBundledConfig();
    const config = configuration(entry);
    this.setProxyUrl(config.proxyUrl);
    const useOAuth = this.authEnabled(entry);
    const headers = resolveHeaders(entry, host, false, this.oauthDir);

    if (!useOAuth) {
      const snapshot = await queryGatewayQuota({
        baseUrl: config.baseUrl,
        protocol: config.protocol,
        quotaEndpoint: config.quotaEndpoint,
        headers,
        authHeader: config.authHeader,
        authPrefix: config.authPrefix,
        ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
      }, signal);
      if (snapshot.plan || snapshot.userTier) {
        this.ensureRuntime('__default__').plan = {
          plan: snapshot.plan,
          userTier: snapshot.userTier,
          expiresAt: Date.now() + ROBIN_STATUS_TTL_MS,
        };
      }
      return { ...snapshot, quotaBarMode: this.quotaBarMode };
    }

    const orderedAccounts = config.accountRouting === 'failover'
      ? orderPrimaryFirst(this.auth.listAccounts({ revealEmail: !this.emailsMasked }))
      : this.auth.listAccounts({ revealEmail: !this.emailsMasked });
    if (orderedAccounts.length === 0) {
      return {
        supported: true,
        authRequired: true,
        windows: [],
        fetchedAt: new Date().toISOString(),
        totalAccounts: 0,
        emailsMasked: this.emailsMasked,
        quotaBarMode: this.quotaBarMode,
        accountRouting: config.accountRouting,
        accountOptions: [],
        accounts: [],
        note: '完成上方浏览器 OAuth 认证后，将自动查询额度。',
      };
    }

    const accountOptions: AccountQuotaOption[] = orderedAccounts.map(acct => ({
      id: acct.id,
      ...(acct.email ? { email: acct.email } : {}),
      isPrimary: acct.isPrimary,
    }));

    const wantsSingle = Boolean(targetAccountId && targetAccountId !== 'all');
    const targets = wantsSingle
      ? orderedAccounts.filter(acct => acct.id === targetAccountId)
      : orderedAccounts;
    if (wantsSingle && targets.length === 0) {
      throw new Error('Selected OAuth account does not exist');
    }

    const results = await mapLimit(targets, 3, async (acct): Promise<AccountQuotaSnapshot> => {
      const rt = this.ensureRuntime(acct.id);
      try {
        const snap = await queryGatewayQuota({
          baseUrl: config.baseUrl,
          protocol: config.protocol,
          quotaEndpoint: config.quotaEndpoint,
          headers,
          auth: { accessToken: force => this.auth.accessTokenFor(acct.id, force) },
          authHeader: config.authHeader,
          authPrefix: config.authPrefix,
          ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
        }, signal);
        rt.quota = snap;
        if (snap.plan || snap.userTier) {
          rt.plan = {
            plan: snap.plan,
            userTier: snap.userTier,
            expiresAt: Date.now() + ROBIN_STATUS_TTL_MS,
          };
        }
        const cd = this.activeCooldown(rt);
        return {
          accountId: acct.id,
          ...(acct.email ? { email: acct.email } : {}),
          isPrimary: acct.isPrimary,
          ...(snap.plan ? { plan: snap.plan } : {}),
          ...(snap.userTier ? { userTier: snap.userTier } : {}),
          windows: snap.windows,
          ...(snap.creditsRemaining !== undefined ? { creditsRemaining: snap.creditsRemaining } : {}),
          ...(snap.useOverageAiCredits !== undefined ? { useOverageAiCredits: snap.useOverageAiCredits } : {}),
          ...(cd ? { cooldownUntil: cd.until, ...(cd.reason ? { cooldownReason: cd.reason } : {}) } : {}),
          fetchedAt: snap.fetchedAt,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        rt.lastError = msg;
        if (/accept our terms of service|terms of service|服务条款/i.test(msg)) {
          this.markAccountTermsRequired(acct.id);
        }
        const cd = this.activeCooldown(rt);
        return {
          accountId: acct.id,
          ...(acct.email ? { email: acct.email } : {}),
          isPrimary: acct.isPrimary,
          ...(rt.plan?.plan ? { plan: rt.plan.plan } : {}),
          ...(rt.plan?.userTier ? { userTier: rt.plan.userTier } : {}),
          windows: [],
          ...(cd ? { cooldownUntil: cd.until, ...(cd.reason ? { cooldownReason: cd.reason } : {}) } : {}),
          fetchedAt: new Date().toISOString(),
          error: msg,
        };
      }
    });

    // Preserve single-account error throwing semantics for callers & gateway test.
    if (orderedAccounts.length === 1 && results.length === 1 && results[0].error) {
      throw new Error(results[0].error);
    }

    const head = results.find(r => r.isPrimary && !r.error) ?? results.find(r => !r.error) ?? results[0];
    return {
      supported: true,
      ...(head.plan ? { plan: head.plan } : {}),
      ...(head.userTier ? { userTier: head.userTier } : {}),
      windows: head.windows,
      ...(head.creditsRemaining !== undefined ? { creditsRemaining: head.creditsRemaining } : {}),
      ...(head.useOverageAiCredits !== undefined ? { useOverageAiCredits: head.useOverageAiCredits } : {}),
      fetchedAt: head.fetchedAt,
      selectedAccountId: wantsSingle ? targetAccountId : 'all',
      totalAccounts: orderedAccounts.length,
      emailsMasked: this.emailsMasked,
      quotaBarMode: this.quotaBarMode,
      accountRouting: config.accountRouting,
      accountOptions,
      accounts: results,
    };
  }

  async acceptTerms(
    entry: LLMProviderEntry,
    host: Pick<ProviderHost, 'secret'>,
    language = 'en',
    signal?: AbortSignal,
    accountId?: string,
  ): Promise<RobinTermsResult> {
    this.refreshBundledConfig();
    const config = configuration(entry);
    this.setProxyUrl(config.proxyUrl);
    if (config.protocol !== 'robin') {
      throw new Error('仅 Robin 协议需要确认 Gemini 桌面服务条款。');
    }
    const resolvedId = accountId ?? this.auth.primaryAccountId();
    if (!this.authEnabled(entry) || !resolvedId) {
      throw new Error('请先完成浏览器 OAuth 认证后再确认服务条款。');
    }
    const baseHeaders = resolveHeaders(entry, host, false);
    const h2Connector = createHttp2Connector(config.proxyUrl);
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(baseHeaders);
      const token = await this.auth.accessTokenFor(resolvedId, attempt === 1);
      headers.set(config.authHeader ?? 'Authorization', `${config.authPrefix ?? 'Bearer '}${token}`);
      try {
        const result = await acceptRobinTermsOfService({
          baseUrl: config.baseUrl,
          headers,
          language,
          signal,
          connectHttp2: h2Connector,
        });
        this.markAccountTermsAccepted(resolvedId, { version: result.version, acceptedAt: result.acceptedAt });
        this.clearAccountCooldown(resolvedId);
        return result;
      } catch (error) {
        if (error instanceof GatewayError && error.status === 401 && attempt === 0 && !signal?.aborted) {
          continue;
        }
        throw error;
      }
    }
    throw new GatewayError(401, 'terms accept');
  }
}
