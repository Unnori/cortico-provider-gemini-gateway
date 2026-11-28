import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { proxyFetch } from './http.ts';
import { maskEmail } from './redact.ts';
import { httpUrl, readState, record, stringMap, writeState } from './state.ts';

export interface DesktopOAuthConfig {
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  authEndpoint: string;
  tokenEndpoint: string;
  authParams?: Record<string, string>;
  tokenHeaders?: Record<string, string>;
  redirectHost?: string;
  redirectPath?: string;
}

interface StoredTokens {
  profile: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
}

export type AccountTermsStatus = 'accepted' | 'pending' | 'required';

interface StoredAccountTokens extends StoredTokens {
  id: string;
  addedAt: string;
  termsStatus: AccountTermsStatus;
  termsVersion?: number;
  termsAcceptedAt?: string;
}

interface StoredAccountsState {
  primaryId?: string;
  accounts: StoredAccountTokens[];
}

export interface OAuthAccountSummary {
  id: string;
  email?: string;
  expiresAt: number;
  isPrimary: boolean;
  addedAt: string;
  termsStatus: AccountTermsStatus;
  termsVersion?: number;
  termsAcceptedAt?: string;
}

export interface StartLoginOptions {
  targetAccountId?: string;
  forceAccountSelect?: boolean;
}

export interface OAuthStatus {
  configured: boolean;
  customConfig: boolean;
  signedIn: boolean;
  pending: boolean;
  pendingTargetAccountId?: string;
  authUrl?: string;
  redirectUri?: string;
  clientId?: string;
  expiresAt?: number;
  email?: string;
  primaryAccountId?: string;
  accounts: OAuthAccountSummary[];
  error?: string;
}

export const OAUTH_CONFIG_FILE = 'desktop-oauth.json';
export const OAUTH_TOKENS_FILE = 'oauth-tokens.json';
export const OAUTH_ACCOUNTS_FILE = 'oauth-accounts.json';

const ALLOWED_REDIRECT_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BUNDLED_OAUTH_URL = new URL('../resources/desktop-oauth.example.json', import.meta.url);

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function parseOAuthConfig(raw: unknown): DesktopOAuthConfig {
  const config = record(raw);
  const clientId = typeof config?.clientId === 'string' ? config.clientId.trim() : '';
  if (!config || !clientId || /^YOUR_/i.test(clientId) || /^<.+>$/.test(clientId)
      || typeof config.authEndpoint !== 'string' || typeof config.tokenEndpoint !== 'string'
      || !Array.isArray(config.scopes) || config.scopes.some(scope => typeof scope !== 'string' || !/^\S+$/.test(scope))
      || (config.clientSecret !== undefined && typeof config.clientSecret !== 'string')) {
    throw new Error('Configure clientId, authEndpoint, tokenEndpoint and scopes in desktop-oauth.json');
  }
  const clientSecret = typeof config.clientSecret === 'string' && config.clientSecret.trim()
    ? config.clientSecret.trim()
    : undefined;
  if (config.redirectHost !== undefined && (typeof config.redirectHost !== 'string' || !ALLOWED_REDIRECT_HOSTS.has(config.redirectHost))) {
    throw new Error('OAuth redirectHost must be 127.0.0.1, localhost, or [::1]');
  }
  if (config.redirectPath !== undefined && (typeof config.redirectPath !== 'string'
      || (config.redirectPath !== '' && (!config.redirectPath.startsWith('/') || /[?#]/.test(config.redirectPath))))) {
    throw new Error('OAuth redirectPath must be empty or start with / without a query or fragment');
  }
  return {
    clientId, ...(clientSecret !== undefined ? { clientSecret } : {}), scopes: config.scopes,
    authEndpoint: httpUrl(config.authEndpoint).href, tokenEndpoint: httpUrl(config.tokenEndpoint).href,
    authParams: stringMap(config.authParams, 'OAuth authParams'),
    tokenHeaders: stringMap(config.tokenHeaders, 'OAuth tokenHeaders'),
    ...(config.redirectHost !== undefined ? { redirectHost: config.redirectHost } : {}),
    ...(config.redirectPath !== undefined ? { redirectPath: config.redirectPath } : {}),
  };
}

export function readOAuthConfig(stateDir: string): DesktopOAuthConfig | undefined {
  const raw = readState(join(stateDir, OAUTH_CONFIG_FILE));
  if (raw === undefined) return undefined;
  return parseOAuthConfig(raw);
}

export function readBundledOAuthConfig(): DesktopOAuthConfig | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(BUNDLED_OAUTH_URL, 'utf8').replace(/^\uFEFF/, ''));
    return parseOAuthConfig(raw);
  } catch {
    return undefined;
  }
}

export function readRawOAuthConfigText(stateDir: string): { text: string; custom: boolean } {
  const file = join(stateDir, OAUTH_CONFIG_FILE);
  if (existsSync(file)) {
    return { text: readFileSync(file, 'utf8'), custom: true };
  }
  try {
    return { text: readFileSync(BUNDLED_OAUTH_URL, 'utf8'), custom: false };
  } catch {
    return { text: '{}', custom: false };
  }
}

export function saveOAuthConfig(stateDir: string, raw: unknown): DesktopOAuthConfig {
  const parsed = parseOAuthConfig(raw);
  writeState(join(stateDir, OAUTH_CONFIG_FILE), raw);
  return parsed;
}

export function removeOAuthConfig(stateDir: string): void {
  rmSync(join(stateDir, OAUTH_CONFIG_FILE), { force: true });
}

interface PendingSession {
  epoch: number;
  state: string;
  verifier: string;
  redirectUri: string;
  expectedPath: string;
  authUrl: string;
  targetAccountId?: string;
  forceAccountSelect: boolean;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolveDone: () => void;
  rejectDone: (error: unknown) => void;
  consumed: boolean;
}

function profileHash(config: DesktopOAuthConfig): string {
  return createHash('sha256').update(JSON.stringify([
    config.clientId, httpUrl(config.authEndpoint).href, httpUrl(config.tokenEndpoint).href, [...config.scopes].sort(),
  ])).digest('hex');
}

function normalizeEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || undefined;
}

function legacyAccountId(profile: string, email?: string): string {
  const digest = createHash('sha256').update(`${profile}:${normalizeEmail(email) ?? 'legacy'}`).digest('hex');
  return `acct_${digest.slice(0, 12)}`;
}

export class DesktopOAuth {
  private config: DesktopOAuthConfig;
  private readonly stateDir: string;
  private readonly tokenFile: string;
  private readonly accountsFile: string;
  private profile: string;
  private readonly request: typeof fetch;
  private readonly refreshingByAccount = new Map<string, Promise<string>>();
  private pending?: PendingSession;
  private epoch = 0;
  private lastError?: string;
  private customConfig: boolean;
  private onAccountUpdated?: (accountId: string) => void;

  constructor(config: DesktopOAuthConfig, stateDir: string, request: typeof fetch = proxyFetch, customConfig = false) {
    this.request = request;
    this.stateDir = stateDir;
    this.config = structuredClone(config);
    this.profile = profileHash(this.config);
    this.tokenFile = join(stateDir, OAUTH_TOKENS_FILE);
    this.accountsFile = join(stateDir, OAUTH_ACCOUNTS_FILE);
    this.customConfig = customConfig || existsSync(join(stateDir, OAUTH_CONFIG_FILE));
  }

  setOnAccountUpdated(handler?: (accountId: string) => void): void {
    this.onAccountUpdated = handler;
  }

  reconfigure(config: DesktopOAuthConfig, customConfig: boolean): void {
    const nextProfile = profileHash(config);
    if (nextProfile === this.profile && this.customConfig === customConfig
        && JSON.stringify(this.config) === JSON.stringify(config)) {
      return;
    }
    this.cancelLogin();
    this.refreshingByAccount.clear();
    this.config = structuredClone(config);
    this.profile = nextProfile;
    this.customConfig = customConfig;
    this.lastError = undefined;
  }

  private parseAccountRecord(raw: unknown): StoredAccountTokens | undefined {
    const item = record(raw);
    if (!item || typeof item.id !== 'string' || !item.id.trim()
        || typeof item.accessToken !== 'string' || !item.accessToken
        || typeof item.refreshToken !== 'string' || !item.refreshToken
        || typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt)) {
      return undefined;
    }
    const email = typeof item.email === 'string' && item.email.trim() ? item.email.trim() : undefined;
    const addedAt = typeof item.addedAt === 'string' && item.addedAt.trim() ? item.addedAt : '1970-01-01T00:00:00.000Z';
    const rawTerms = item.termsStatus;
    const termsStatus: AccountTermsStatus = rawTerms === 'pending' || rawTerms === 'required' || rawTerms === 'accepted'
      ? rawTerms
      : 'accepted';
    const termsVersion = typeof item.termsVersion === 'number' && Number.isFinite(item.termsVersion)
      ? item.termsVersion
      : undefined;
    const termsAcceptedAt = typeof item.termsAcceptedAt === 'string' && item.termsAcceptedAt.trim()
      ? item.termsAcceptedAt
      : undefined;
    return {
      id: item.id,
      profile: this.profile,
      accessToken: item.accessToken,
      refreshToken: item.refreshToken,
      expiresAt: item.expiresAt,
      ...(email ? { email } : {}),
      addedAt,
      termsStatus,
      ...(termsVersion !== undefined ? { termsVersion } : {}),
      ...(termsAcceptedAt ? { termsAcceptedAt } : {}),
    };
  }

  private readStore(): StoredAccountsState {
    const rawPool = record(readState(this.accountsFile));
    if (rawPool?.profile === this.profile && Array.isArray(rawPool.accounts)) {
      const accounts: StoredAccountTokens[] = [];
      const seen = new Set<string>();
      for (const entry of rawPool.accounts) {
        const parsed = this.parseAccountRecord(entry);
        if (!parsed || seen.has(parsed.id)) continue;
        seen.add(parsed.id);
        accounts.push(parsed);
      }
      if (accounts.length > 0) {
        const primaryId = typeof rawPool.primaryId === 'string' && seen.has(rawPool.primaryId)
          ? rawPool.primaryId
          : accounts[0].id;
        return { primaryId, accounts };
      }
      return { accounts: [] };
    }

    const rawLegacy = record(readState(this.tokenFile));
    if (rawLegacy?.profile === this.profile && typeof rawLegacy.accessToken === 'string' && rawLegacy.accessToken
        && typeof rawLegacy.refreshToken === 'string' && rawLegacy.refreshToken
        && typeof rawLegacy.expiresAt === 'number' && Number.isFinite(rawLegacy.expiresAt)) {
      const email = typeof rawLegacy.email === 'string' && rawLegacy.email.trim() ? rawLegacy.email.trim() : undefined;
      const id = legacyAccountId(this.profile, email);
      return {
        primaryId: id,
        accounts: [{
          id,
          profile: this.profile,
          accessToken: rawLegacy.accessToken,
          refreshToken: rawLegacy.refreshToken,
          expiresAt: rawLegacy.expiresAt,
          ...(email ? { email } : {}),
          addedAt: '1970-01-01T00:00:00.000Z',
          termsStatus: 'accepted',
        }],
      };
    }

    return { accounts: [] };
  }

  private writeStore(primaryId: string | undefined, accounts: StoredAccountTokens[]): void {
    if (accounts.length === 0) {
      rmSync(this.accountsFile, { force: true });
      rmSync(this.tokenFile, { force: true });
      return;
    }
    const resolvedPrimary = primaryId && accounts.some(a => a.id === primaryId) ? primaryId : accounts[0].id;
    writeState(this.accountsFile, {
      version: 1,
      profile: this.profile,
      primaryId: resolvedPrimary,
      accounts: accounts.map(a => ({
        id: a.id,
        accessToken: a.accessToken,
        refreshToken: a.refreshToken,
        expiresAt: a.expiresAt,
        ...(a.email ? { email: a.email } : {}),
        addedAt: a.addedAt,
        termsStatus: a.termsStatus,
        ...(a.termsVersion !== undefined ? { termsVersion: a.termsVersion } : {}),
        ...(a.termsAcceptedAt ? { termsAcceptedAt: a.termsAcceptedAt } : {}),
      })),
    });
    const primary = accounts.find(a => a.id === resolvedPrimary) ?? accounts[0];
    writeState(this.tokenFile, {
      profile: this.profile,
      accessToken: primary.accessToken,
      refreshToken: primary.refreshToken,
      expiresAt: primary.expiresAt,
      ...(primary.email ? { email: primary.email } : {}),
    });
  }

  listAccounts(options: { revealEmail?: boolean } = {}): OAuthAccountSummary[] {
    const reveal = Boolean(options.revealEmail);
    const store = this.readStore();
    return store.accounts.map(acct => {
      const displayEmail = reveal ? acct.email : maskEmail(acct.email);
      return {
        id: acct.id,
        ...(displayEmail ? { email: displayEmail } : {}),
        expiresAt: acct.expiresAt,
        isPrimary: acct.id === store.primaryId,
        addedAt: acct.addedAt,
        termsStatus: acct.termsStatus,
        ...(acct.termsVersion !== undefined ? { termsVersion: acct.termsVersion } : {}),
        ...(acct.termsAcceptedAt ? { termsAcceptedAt: acct.termsAcceptedAt } : {}),
      };
    });
  }

  primaryAccountId(): string | undefined {
    return this.readStore().primaryId;
  }

  status(options: { revealEmail?: boolean } = {}): OAuthStatus {
    const reveal = Boolean(options.revealEmail);
    const store = this.readStore();
    const primary = store.accounts.find(a => a.id === store.primaryId) ?? store.accounts[0];
    const primaryEmail = reveal ? primary?.email : maskEmail(primary?.email);
    return {
      configured: Boolean(this.config.clientId),
      customConfig: this.customConfig,
      signedIn: store.accounts.length > 0,
      pending: Boolean(this.pending),
      ...(this.pending?.targetAccountId ? { pendingTargetAccountId: this.pending.targetAccountId } : {}),
      ...(this.pending ? { authUrl: this.pending.authUrl, redirectUri: this.pending.redirectUri } : {}),
      clientId: this.config.clientId,
      ...(primary ? {
        expiresAt: primary.expiresAt,
        primaryAccountId: primary.id,
        ...(primaryEmail ? { email: primaryEmail } : {}),
      } : {}),
      accounts: store.accounts.map(acct => {
        const displayEmail = reveal ? acct.email : maskEmail(acct.email);
        return {
          id: acct.id,
          ...(displayEmail ? { email: displayEmail } : {}),
          expiresAt: acct.expiresAt,
          isPrimary: acct.id === store.primaryId,
          addedAt: acct.addedAt,
          termsStatus: acct.termsStatus,
          ...(acct.termsVersion !== undefined ? { termsVersion: acct.termsVersion } : {}),
          ...(acct.termsAcceptedAt ? { termsAcceptedAt: acct.termsAcceptedAt } : {}),
        };
      }),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  setAccountTermsStatus(
    accountId: string,
    termsStatus: AccountTermsStatus,
    meta?: { version?: number; acceptedAt?: string },
  ): OAuthStatus {
    const store = this.readStore();
    const idx = store.accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return this.status();
    const current = store.accounts[idx];
    const nextVersion = termsStatus === 'accepted' ? (meta?.version ?? current.termsVersion) : undefined;
    const nextAcceptedAt = termsStatus === 'accepted'
      ? (meta?.acceptedAt ?? current.termsAcceptedAt ?? new Date().toISOString())
      : undefined;
    if (
      current.termsStatus === termsStatus
      && current.termsVersion === nextVersion
      && current.termsAcceptedAt === nextAcceptedAt
    ) {
      return this.status();
    }
    const nextAccounts = [...store.accounts];
    nextAccounts[idx] = {
      ...current,
      termsStatus,
      ...(nextVersion !== undefined ? { termsVersion: nextVersion } : { termsVersion: undefined }),
      ...(nextAcceptedAt ? { termsAcceptedAt: nextAcceptedAt } : { termsAcceptedAt: undefined }),
    };
    this.writeStore(store.primaryId, nextAccounts);
    return this.status();
  }

  setPrimaryAccount(accountId: string): OAuthStatus {
    const store = this.readStore();
    if (!store.accounts.some(a => a.id === accountId)) {
      throw new Error('Selected OAuth account does not exist');
    }
    this.writeStore(accountId, store.accounts);
    return this.status();
  }

  removeAccount(accountId: string): OAuthStatus {
    if (this.pending?.targetAccountId === accountId) {
      this.cancelLogin();
    }
    this.refreshingByAccount.delete(accountId);
    const store = this.readStore();
    const remaining = store.accounts.filter(a => a.id !== accountId);
    const nextPrimary = store.primaryId === accountId ? remaining[0]?.id : store.primaryId;
    this.writeStore(nextPrimary, remaining);
    return this.status();
  }

  private async fetchEmail(accessToken: string): Promise<string | undefined> {
    if (!this.config.scopes.includes('email')
        && !this.config.scopes.includes('https://www.googleapis.com/auth/userinfo.email')) {
      return undefined;
    }
    try {
      const authOrigin = new URL(this.config.authEndpoint).origin;
      if (authOrigin !== 'https://accounts.google.com') return undefined;
      const response = await this.request('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const info = record(await response.json());
      return typeof info?.email === 'string' && info.email ? info.email : undefined;
    } catch {
      return undefined;
    }
  }

  private async exchange(
    form: Record<string, string>,
    previous?: StoredAccountTokens,
    signal?: AbortSignal,
    targetAccountId?: string,
  ): Promise<string> {
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    for (const [name, value] of Object.entries(this.config.tokenHeaders ?? {})) headers.set(name, value);
    const deadline = AbortSignal.timeout(15_000);
    const response = await this.request(this.config.tokenEndpoint, {
      method: 'POST', headers, redirect: 'error', signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
      body: new URLSearchParams({
        client_id: this.config.clientId, ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}), ...form,
      }),
    });
    if (!response.ok) {
      let code = '';
      try {
        const text = await response.text();
        const err = record(JSON.parse(text))?.error;
        if (typeof err === 'string' && /^[a-z_]+$/.test(err)) code = err;
      } catch {
        // Ignore malformed error responses; do not reflect token payloads.
      }
      throw new Error(`OAuth token endpoint returned HTTP ${response.status}${code ? ` (${code})` : ''}`);
    }
    const raw = record(await response.json());
    const expiresIn = Number(raw?.expires_in);
    const refreshToken = typeof raw?.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : previous?.refreshToken;
    if (typeof raw?.access_token !== 'string' || !raw.access_token || !refreshToken
        || !Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(expiresIn * 1000)) {
      throw new Error('OAuth token response requires access_token, expires_in and a refresh_token on first login');
    }
    signal?.throwIfAborted();
    const fetchedEmail = previous?.email ?? await this.fetchEmail(raw.access_token);
    const expiresAt = Date.now() + expiresIn * 1000;
    const store = this.readStore();
    const accounts = [...store.accounts];
    let nextPrimary = store.primaryId;
    let updatedAccountId: string | undefined;

    if (previous) {
      const idx = accounts.findIndex(a => a.id === previous.id);
      const updated: StoredAccountTokens = {
        ...previous,
        profile: this.profile,
        accessToken: raw.access_token,
        refreshToken,
        expiresAt,
        ...(fetchedEmail ? { email: fetchedEmail } : {}),
      };
      if (idx >= 0) accounts[idx] = updated;
      else accounts.push(updated);
      nextPrimary ??= updated.id;
      updatedAccountId = updated.id;
    } else {
      const normEmail = normalizeEmail(fetchedEmail);
      const emailIdx = normEmail ? accounts.findIndex(a => normalizeEmail(a.email) === normEmail) : -1;
      const targetIdx = targetAccountId ? accounts.findIndex(a => a.id === targetAccountId) : -1;
      const matchIdx = emailIdx >= 0 ? emailIdx : targetIdx;
      if (matchIdx >= 0) {
        const existing = accounts[matchIdx];
        accounts[matchIdx] = {
          ...existing,
          profile: this.profile,
          accessToken: raw.access_token,
          refreshToken,
          expiresAt,
          ...(fetchedEmail ? { email: fetchedEmail } : {}),
        };
        nextPrimary ??= existing.id;
        updatedAccountId = existing.id;
      } else {
        const newAccount: StoredAccountTokens = {
          id: `acct_${randomBytes(6).toString('hex')}`,
          profile: this.profile,
          accessToken: raw.access_token,
          refreshToken,
          expiresAt,
          ...(fetchedEmail ? { email: fetchedEmail } : {}),
          addedAt: new Date().toISOString(),
          termsStatus: 'pending',
        };
        accounts.push(newAccount);
        nextPrimary ??= newAccount.id;
        updatedAccountId = newAccount.id;
      }
    }

    this.writeStore(nextPrimary, accounts);
    this.lastError = undefined;
    if (!previous && updatedAccountId) {
      this.onAccountUpdated?.(updatedAccountId);
    }
    return raw.access_token;
  }

  async accessTokenFor(accountId: string, force = false): Promise<string> {
    const inflight = this.refreshingByAccount.get(accountId);
    if (inflight) return inflight;
    const store = this.readStore();
    const account = store.accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Complete desktop OAuth login for this endpoint first');
    if (!force && account.expiresAt > Date.now() + 60_000) return account.accessToken;
    const promise = this.exchange({ grant_type: 'refresh_token', refresh_token: account.refreshToken }, account)
      .finally(() => { this.refreshingByAccount.delete(accountId); });
    this.refreshingByAccount.set(accountId, promise);
    return promise;
  }

  async accessToken(force = false): Promise<string> {
    const store = this.readStore();
    if (!store.primaryId) throw new Error('Complete desktop OAuth login for this endpoint first');
    return this.accessTokenFor(store.primaryId, force);
  }

  private closePending(session: PendingSession | undefined): void {
    if (!session || this.pending !== session) return;
    clearTimeout(session.timer);
    session.server.close();
    this.pending = undefined;
  }

  cancelLogin(): void {
    this.epoch++;
    const session = this.pending;
    if (!session) return;
    this.closePending(session);
    session.rejectDone(new Error('Desktop OAuth login canceled'));
  }

  logout(accountId?: string): OAuthStatus {
    if (accountId) return this.removeAccount(accountId);
    this.cancelLogin();
    this.refreshingByAccount.clear();
    this.lastError = undefined;
    rmSync(this.accountsFile, { force: true });
    rmSync(this.tokenFile, { force: true });
    return this.status();
  }

  private async finishAuthorization(session: PendingSession, code: string | null, denied: boolean, signal?: AbortSignal): Promise<void> {
    try {
      if (!code || denied) throw new Error('Desktop OAuth authorization was denied or returned no code');
      await this.exchange(
        { grant_type: 'authorization_code', code, redirect_uri: session.redirectUri, code_verifier: session.verifier },
        undefined,
        signal,
        session.targetAccountId,
      );
      if (this.epoch === session.epoch) this.lastError = undefined;
      session.resolveDone();
    } catch (error) {
      if (this.epoch === session.epoch) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      session.rejectDone(error);
    } finally {
      this.closePending(session);
    }
  }

  async startLogin(signal?: AbortSignal, options: StartLoginOptions = {}): Promise<{ url: string; redirectUri: string }> {
    const targetAccountId = options.targetAccountId;
    const forceAccountSelect = Boolean(options.forceAccountSelect);
    if (this.pending) {
      if (this.pending.targetAccountId === targetAccountId && this.pending.forceAccountSelect === forceAccountSelect) {
        return { url: this.pending.authUrl, redirectUri: this.pending.redirectUri };
      }
      this.cancelLogin();
    }
    signal?.throwIfAborted();
    this.lastError = undefined;
    const epoch = ++this.epoch;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const callbackHost = this.config.redirectHost ?? '127.0.0.1';
    const callbackPath = this.config.redirectPath ?? '/oauth/callback';
    const expectedPath = callbackPath || '/';
    const doneResolvers = Promise.withResolvers<void>();
    void doneResolvers.promise.catch(() => {});

    let session!: PendingSession;
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const path = request.url?.startsWith('/') ? request.url : '/';
      const url = new URL('http://localhost' + path);
      const received = Buffer.from(url.searchParams.get('state') ?? '');
      const expected = Buffer.from(state);
      if (request.method !== 'GET' || url.pathname !== expectedPath || session.consumed
          || received.length !== expected.length || !timingSafeEqual(received, expected)) {
        response.writeHead(400).end('Invalid OAuth callback');
        return;
      }
      session.consumed = true;
      response.end('OAuth callback received. Return to the desktop application for the login result.');
      void this.finishAuthorization(session, url.searchParams.get('code'), url.searchParams.has('error'), signal);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        if (callbackHost === '127.0.0.1') server.listen(0, '127.0.0.1', resolve);
        else server.listen(0, () => resolve());
      });
    } catch (error) {
      server.close();
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Unable to bind OAuth loopback callback');
    }
    const redirectUri = `http://${callbackHost}:${address.port}${callbackPath}`;
    const url = httpUrl(this.config.authEndpoint);
    const store = this.readStore();
    const authParams: Record<string, string> = { ...(this.config.authParams ?? {}) };
    const wantsSelect = forceAccountSelect || Boolean(targetAccountId) || store.accounts.length > 0;
    if (wantsSelect) {
      const tokens = (authParams.prompt ?? '').split(/\s+/).filter(Boolean);
      if (!tokens.includes('select_account')) tokens.unshift('select_account');
      if (!tokens.includes('consent')) tokens.push('consent');
      authParams.prompt = tokens.join(' ');
    }
    for (const [key, value] of Object.entries({
      ...authParams, client_id: this.config.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: this.config.scopes.join(' '), state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    })) url.searchParams.set(key, value);

    const timer = setTimeout(() => {
      if (this.pending === session) {
        this.lastError = 'Desktop OAuth login timed out after 5 minutes';
        this.closePending(session);
        session.rejectDone(new Error(this.lastError));
      }
    }, 5 * 60_000);
    timer.unref();
    server.unref();

    session = {
      epoch, state, verifier, redirectUri, expectedPath, authUrl: url.href,
      targetAccountId, forceAccountSelect,
      server, timer, done: doneResolvers.promise, resolveDone: doneResolvers.resolve, rejectDone: doneResolvers.reject, consumed: false,
    };
    this.pending = session;
    return { url: session.authUrl, redirectUri: session.redirectUri };
  }

  async completeLogin(callbackUrlText: string): Promise<OAuthStatus> {
    const session = this.pending;
    if (!session) throw new Error('No pending OAuth login session; click Sign in first');
    let parsed: URL;
    try {
      parsed = new URL(callbackUrlText.trim());
    } catch {
      throw new Error('Invalid callback URL');
    }
    const received = Buffer.from(parsed.searchParams.get('state') ?? '');
    const expected = Buffer.from(session.state);
    if (parsed.pathname !== session.expectedPath || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new Error('Callback URL state or path does not match the active login session');
    }
    if (session.consumed) throw new Error('OAuth callback already consumed');
    session.consumed = true;
    await this.finishAuthorization(session, parsed.searchParams.get('code'), parsed.searchParams.has('error'));
    return this.status();
  }

  async login(onUrl: (url: string) => void, signal?: AbortSignal, options: StartLoginOptions = {}): Promise<void> {
    if (this.pending) throw new Error('Desktop OAuth login is already pending');
    const timeout = AbortSignal.timeout(5 * 60_000);
    const pending = signal ? AbortSignal.any([signal, timeout]) : timeout;
    pending.throwIfAborted();
    const { url } = await this.startLogin(pending, options);
    const session = this.pending!;
    const onAbort = () => {
      this.closePending(session);
      session.rejectDone(pending.reason);
    };
    pending.addEventListener('abort', onAbort, { once: true });
    try {
      onUrl(url);
      await session.done;
    } finally {
      pending.removeEventListener('abort', onAbort);
      this.closePending(session);
    }
  }
}
