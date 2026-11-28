import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../src/client.ts';
import { GatewayControl, isPermanentOAuthFailure } from '../src/control.ts';
import provider from '../src/index.ts';
import {
  DesktopOAuth,
  OAUTH_ACCOUNTS_FILE,
  OAUTH_TOKENS_FILE,
  type DesktopOAuthConfig,
} from '../src/oauth.ts';
import type { QuotaSnapshot } from '../src/quota.ts';
import { sanitizeUpstreamText } from '../src/queue.ts';
import { maskEmail } from '../src/redact.ts';
import {
  frameGrpcMessage,
  lengthDelimited,
  ROBIN_GRPC_ACCEPT_TERMS,
  ROBIN_GRPC_GET_TERMS_VERSION,
  ROBIN_GRPC_GET_USAGE_INFO,
  ROBIN_GRPC_PROCESS_QUERY,
  stringField,
  varintField,
} from '../src/robin-grpc.ts';
import type { AuthPanelStatus, QuotaAccountLabels } from '../src/webui/server.ts';

function encodeFloat32Field(fieldNumber: number, value: number): Buffer {
  const key = Buffer.from([(fieldNumber << 3) | 5]);
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  return Buffer.concat([key, buf]);
}

function encodeUsage(tier: number, fiveHrUsed: number, weeklyUsed: number): Buffer {
  const ts1 = Buffer.concat([varintField(1, Math.floor(Date.parse('2026-11-19T16:00:00Z') / 1000)), varintField(2, 0)]);
  const ts2 = Buffer.concat([varintField(1, Math.floor(Date.parse('2026-11-26T00:00:00Z') / 1000)), varintField(2, 0)]);
  const row1 = Buffer.concat([lengthDelimited(1, ts1), encodeFloat32Field(2, fiveHrUsed), stringField(3, '5-hour')]);
  const row2 = Buffer.concat([lengthDelimited(1, ts2), encodeFloat32Field(2, weeklyUsed), stringField(3, 'Weekly')]);
  const group = Buffer.concat([varintField(1, 1), lengthDelimited(2, row1), lengthDelimited(2, row2)]);
  return Buffer.concat([varintField(2, tier), lengthDelimited(3, group)]);
}

function encodeReply(text: string): Buffer {
  const model = Buffer.concat([stringField(1, 'r_1'), lengthDelimited(2, stringField(1, text))]);
  const inner = Buffer.concat([
    lengthDelimited(1, model),
    lengthDelimited(2, stringField(1, 'c_pool_1')),
    varintField(9, 1),
    stringField(30, 'Gemini 4 Hydrogen'),
  ]);
  return lengthDelimited(1003, lengthDelimited(1, inner));
}

// Minimal valid 1x1 PNG header bytes (enough to pass PNG magic detection).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc000000301010018dd8db00000000049454e44ae426082',
  'hex',
);

const GOOGLE_TEST_CONFIG: DesktopOAuthConfig = {
  clientId: 'pool-client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  authEndpoint: 'https://accounts.google.com/o/oauth2/auth',
  tokenEndpoint: 'https://www.googleapis.com/oauth2/v4/token',
  scopes: ['openid', 'email'],
  authParams: { access_type: 'offline', prompt: 'consent' },
  redirectHost: 'localhost',
  redirectPath: '',
};

function testProfileHash(cfg: DesktopOAuthConfig): string {
  return createHash('sha256').update(JSON.stringify([
    cfg.clientId, new URL(cfg.authEndpoint).href, new URL(cfg.tokenEndpoint).href, [...cfg.scopes].sort(),
  ])).digest('hex');
}

describe('multi-account OAuth pool, routing strategies, failover, and WebUI', () => {
  it('migrates legacy oauth-tokens.json, adds accounts with select_account prompt, switches primary, and removes cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemini-pool-oauth-'));
    try {
      // Seed legacy single-account file.
      writeFileSync(join(dir, OAUTH_TOKENS_FILE), JSON.stringify({
        profile: testProfileHash(GOOGLE_TEST_CONFIG),
        accessToken: 'tok-alice',
        refreshToken: 'ref-alice',
        expiresAt: Date.now() + 3600_000,
        email: 'alice@example.com',
      }));

      const tokenFetch = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TEST_CONFIG.tokenEndpoint) {
          const code = new URLSearchParams(String(init?.body)).get('code');
          if (code === 'code-bob') {
            return Response.json({ access_token: 'tok-bob', refresh_token: 'ref-bob', expires_in: 3600 });
          }
          if (code === 'code-alice-reauth') {
            return Response.json({ access_token: 'tok-alice-2', refresh_token: 'ref-alice-2', expires_in: 3600 });
          }
        }
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
          const authHeader = new Headers(init?.headers).get('Authorization');
          if (authHeader === 'Bearer tok-bob') return Response.json({ email: 'bob@example.com' });
          if (authHeader === 'Bearer tok-alice-2') return Response.json({ email: 'alice@example.com' });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const oauth = new DesktopOAuth(GOOGLE_TEST_CONFIG, dir, tokenFetch);
      const initial = oauth.status();
      expect(initial.signedIn).toBe(true);
      expect(initial.email).toBe('a***e@example.com');
      expect(initial.accounts[0].termsStatus).toBe('accepted'); // Legacy migrated account defaults to accepted.
      expect(oauth.status({ revealEmail: true }).email).toBe('alice@example.com');
      expect(initial.accounts).toHaveLength(1);
      expect(initial.accounts[0].isPrimary).toBe(true);
      expect(await oauth.accessToken()).toBe('tok-alice');

      // Add second account: must pass prompt=select_account consent so Google shows account chooser.
      const login2 = await oauth.startLogin(undefined, { forceAccountSelect: true });
      const url2 = new URL(login2.url);
      expect(url2.searchParams.get('prompt')).toBe('select_account consent');
      const cb2 = new URL(login2.redirectUri);
      cb2.searchParams.set('code', 'code-bob');
      cb2.searchParams.set('state', url2.searchParams.get('state')!);
      const afterAdd = await oauth.completeLogin(cb2.href);

      expect(afterAdd.accounts).toHaveLength(2);
      expect(afterAdd.email).toBe('a***e@example.com'); // Primary preserved & masked by default!
      const alice = afterAdd.accounts.find(a => a.email === 'a***e@example.com')!;
      const bob = afterAdd.accounts.find(a => a.email === 'b***b@example.com')!;
      expect(alice.isPrimary).toBe(true);
      expect(bob.isPrimary).toBe(false);
      expect(await oauth.accessTokenFor(bob.id)).toBe('tok-bob');

      // Re-authenticating alice updates in place (no duplicate alice entries) and does NOT leak raw email in authUrl.
      const reauth = await oauth.startLogin(undefined, { targetAccountId: alice.id, forceAccountSelect: true });
      const reauthUrl = new URL(reauth.url);
      expect(reauthUrl.searchParams.get('login_hint')).toBeNull();
      expect(reauth.url).not.toContain('alice@example.com');
      const cbRe = new URL(reauth.redirectUri);
      cbRe.searchParams.set('code', 'code-alice-reauth');
      cbRe.searchParams.set('state', reauthUrl.searchParams.get('state')!);
      const afterReauth = await oauth.completeLogin(cbRe.href);
      expect(afterReauth.accounts).toHaveLength(2);
      expect(await oauth.accessTokenFor(alice.id)).toBe('tok-alice-2');

      // Switch primary to bob -> oauth-tokens.json syncs to bob for backward compatibility.
      const switched = oauth.setPrimaryAccount(bob.id);
      expect(switched.primaryAccountId).toBe(bob.id);
      expect(switched.email).toBe('b***b@example.com');
      expect(await oauth.accessToken()).toBe('tok-bob');
      const legacyFile = JSON.parse(readFileSync(join(dir, OAUTH_TOKENS_FILE), 'utf8')) as { email?: string; accessToken?: string };
      expect(legacyFile.email).toBe('bob@example.com');
      expect(legacyFile.accessToken).toBe('tok-bob');
      const poolFile = JSON.parse(readFileSync(join(dir, OAUTH_ACCOUNTS_FILE), 'utf8')) as { primaryId: string; accounts: unknown[] };
      expect(poolFile.primaryId).toBe(bob.id);
      expect(poolFile.accounts).toHaveLength(2);

      // Remove primary (bob) -> alice promoted automatically.
      const afterRemove = oauth.removeAccount(bob.id);
      expect(afterRemove.accounts).toHaveLength(1);
      expect(afterRemove.primaryAccountId).toBe(alice.id);
      expect(afterRemove.email).toBe('a***e@example.com');
      expect(await oauth.accessToken()).toBe('tok-alice-2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('orders accounts according to failover, round-robin, least-used, and cooldown state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemini-pool-route-'));
    try {
      writeFileSync(join(dir, 'desktop-oauth.json'), JSON.stringify(GOOGLE_TEST_CONFIG));
      writeFileSync(join(dir, OAUTH_ACCOUNTS_FILE), JSON.stringify({
        version: 1,
        profile: testProfileHash(GOOGLE_TEST_CONFIG),
        primaryId: 'acct_a',
        accounts: [
          { id: 'acct_a', accessToken: 'a', refreshToken: 'ra', expiresAt: Date.now() + 3600_000, email: 'a@example.com', addedAt: '2026-11-19T00:00:00Z' },
          { id: 'acct_b', accessToken: 'b', refreshToken: 'rb', expiresAt: Date.now() + 3600_000, email: 'b@example.com', addedAt: '2026-11-19T00:01:00Z' },
          { id: 'acct_c', accessToken: 'c', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, email: 'c@example.com', addedAt: '2026-11-19T00:02:00Z' },
        ],
      }));

      const ctrl = new GatewayControl(dir);

      // Failover: always primary first.
      expect(ctrl.pickAccountOrder('failover')).toEqual(['acct_a', 'acct_b', 'acct_c']);
      expect(ctrl.pickAccountOrder('failover')).toEqual(['acct_a', 'acct_b', 'acct_c']);

      // Round-robin: rotates healthy accounts.
      expect(ctrl.pickAccountOrder('round-robin')).toEqual(['acct_a', 'acct_b', 'acct_c']);
      expect(ctrl.pickAccountOrder('round-robin')).toEqual(['acct_b', 'acct_c', 'acct_a']);
      expect(ctrl.pickAccountOrder('round-robin')).toEqual(['acct_c', 'acct_a', 'acct_b']);

      // Cooldown pushes acct_a to the back even in failover mode.
      ctrl.markAccountCooldown('acct_a', 60_000, 'HTTP 429');
      expect(ctrl.pickAccountOrder('failover')).toEqual(['acct_b', 'acct_c', 'acct_a']);

      // Clearing cooldown restores acct_a to primary position.
      ctrl.clearAccountCooldown('acct_a');
      expect(ctrl.pickAccountOrder('failover')).toEqual(['acct_a', 'acct_b', 'acct_c']);

      // Robin quota downgrade puts that account into cooldown when backups exist and records accountId.
      const obsAt = '2026-11-21T01:05:40.000Z';
      ctrl.recordRouting({
        requestedModel: 'gemini-robin-pro',
        requestedModeCategory: 3,
        requestedThinkingLevel: 2,
        resolvedModeCategory: 1,
        downgradeReason: 2,
        observedAt: obsAt,
      }, 'acct_a');
      expect(ctrl.getObservedRouting('gemini-robin-pro')?.accountId).toBe('acct_a');
      expect(ctrl.getObservedRouting('gemini-robin-pro')?.observedAt).toBe(obsAt);
      expect(ctrl.describeAccount('acct_a')).toBe('a***@example.com');
      ctrl.setEmailsMasked(false);
      expect(ctrl.describeAccount('acct_a')).toBe('a@example.com');
      ctrl.setEmailsMasked(true);
      expect(ctrl.getAccountRuntime('acct_a').cooldownUntil).toBeGreaterThan(Date.now());
      expect(ctrl.pickAccountOrder('failover')[0]).toBe('acct_b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails over on HTTP 429 and strictly isolates Robin image blobId cache per account', async () => {
    const uploadTokens: string[] = [];
    const seenProcessRequests: { auth: string; bodyUtf8: string }[] = [];

    const uploadServer = http2.createServer();
    let uploadOrigin = '';
    let uploadSeq = 0;
    uploadServer.on('stream', (stream, headers) => {
      const method = headers[':method'];
      const auth = String(headers['authorization'] ?? '');
      const chunks: Buffer[] = [];
      stream.on('data', c => chunks.push(Buffer.from(c)));
      stream.on('end', () => {
        if (method === 'POST') {
          uploadSeq++;
          const id = auth.includes('tok-A') ? `blob-A-${uploadSeq}` : `blob-B-${uploadSeq}`;
          uploadTokens.push(`${auth}:${id}`);
          stream.respond({
            ':status': 200,
            'x-goog-upload-status': 'active',
            'x-goog-upload-url': `${uploadOrigin}/upload/session-${uploadSeq}?upload_id=${encodeURIComponent(id)}`,
          });
          stream.end();
          return;
        }
        if (method === 'PUT') {
          const reqPath = String(headers[':path'] ?? '');
          const m = /upload_id=([^&]+)/.exec(reqPath);
          const id = m ? decodeURIComponent(m[1]) : 'blob-unknown';
          stream.respond({ ':status': 200, 'x-goog-upload-status': 'final', 'content-type': 'text/plain' });
          stream.end(`/contrib_service/ttl_1d/${id}`);
          return;
        }
        stream.respond({ ':status': 405 });
        stream.end();
      });
    });

    const robinServer = http2.createServer();
    robinServer.on('stream', (stream, headers) => {
      const auth = String(headers['authorization'] ?? '');
      const chunks: Buffer[] = [];
      stream.on('data', c => chunks.push(Buffer.from(c)));
      stream.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        seenProcessRequests.push({ auth, bodyUtf8: bodyBuf.toString('utf8') });
        if (auth === 'Bearer tok-A') {
          stream.respond({ ':status': 429, 'content-type': 'text/plain' });
          stream.end('Resource exhausted');
          return;
        }
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.write(frameGrpcMessage(encodeReply('Seen on account B')));
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
      });
    });

    await Promise.all([
      new Promise<void>(resolve => uploadServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>(resolve => robinServer.listen(0, '127.0.0.1', resolve)),
    ]);
    const uploadPort = (uploadServer.address() as { port: number }).port;
    const robinPort = (robinServer.address() as { port: number }).port;
    uploadOrigin = `http://127.0.0.1:${uploadPort}`;

    const failedEvents: { accountId: string; status: number | null }[] = [];
    const succeededEvents: string[] = [];
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${robinPort}`,
      protocol: 'robin',
      generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
      robinUploadOrigin: `http://127.0.0.1:${uploadPort}`,
      auth: {
        accessToken: async () => 'tok-A',
        selectAccounts: () => ['acct_A', 'acct_B'],
        accessTokenFor: async id => (id === 'acct_A' ? 'tok-A' : 'tok-B'),
        onAccountFailure: (accountId, status) => failedEvents.push({ accountId, status }),
        onAccountSuccess: accountId => succeededEvents.push(accountId),
      },
    });

    try {
      const imageRequest = {
        model: 'gemini-robin-fast',
        contents: [{
          role: 'user' as const,
          parts: [
            { text: 'What is in this image?' },
            { inlineData: { mimeType: 'image/png', data: TINY_PNG.toString('base64') } },
          ],
        }],
      };

      const texts: string[] = [];
      for await (const chunk of client.stream(imageRequest)) {
        for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (p.text) texts.push(p.text);
        }
      }
      expect(texts.join('')).toBe('Seen on account B');
      expect(failedEvents).toEqual([{ accountId: 'acct_A', status: 429 }]);
      expect(succeededEvents).toEqual(['acct_B']);

      // Account A uploaded blob-A-1, failed 429; Account B uploaded its OWN blob-B-2 (never reused blob-A-1!).
      expect(uploadTokens).toEqual(['Bearer tok-A:blob-A-1', 'Bearer tok-B:blob-B-2']);
      expect(seenProcessRequests).toHaveLength(2);
      expect(seenProcessRequests[0].auth).toBe('Bearer tok-A');
      expect(seenProcessRequests[0].bodyUtf8).toContain('/contrib_service/ttl_1d/blob-A-1');
      expect(seenProcessRequests[1].auth).toBe('Bearer tok-B');
      expect(seenProcessRequests[1].bodyUtf8).toContain('/contrib_service/ttl_1d/blob-B-2');
      expect(seenProcessRequests[1].bodyUtf8).not.toContain('blob-A-1');

      // Second call directly on Account B reuses Account B's cached blob-B-2 (no 3rd upload).
      const clientBOnly = client;
      // Trigger another call with Account B healthy first via failed acct_A check isn't in client mock,
      // but even with [acct_A, acct_B], both caches exist so zero new uploads happen!
      for await (const _chunk of clientBOnly.stream(imageRequest)) { /* consume */ }
      expect(uploadTokens).toHaveLength(2);
    } finally {
      await Promise.all([
        new Promise<void>(resolve => uploadServer.close(() => resolve())),
        new Promise<void>(resolve => robinServer.close(() => resolve())),
      ]);
    }
  });

  it('supports multi-account WebUI auth controls, least-used selection, and all/single quota queries with partial errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gemini-pool-webui-'));
    const realFetch = globalThis.fetch;
    let failBobQuota = false;
    const termsTokens: string[] = [];

    const grpcServer = http2.createServer();
    grpcServer.on('stream', (stream, headers) => {
      const path = headers[':path'];
      const auth = String(headers['authorization'] ?? '');
      stream.resume();
      stream.on('end', () => {
        if (path === ROBIN_GRPC_GET_USAGE_INFO) {
          if (auth === 'Bearer tok-bob' && failBobQuota) {
            stream.respond({ ':status': 500, 'content-type': 'text/plain' });
            stream.end('backend boom');
            return;
          }
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          // Alice: Free (tier 1), 80% used (20% left); Bob: Pro (tier 2), 15% used (85% left).
          const payload = auth === 'Bearer tok-alice' ? encodeUsage(1, 0.8, 0.5) : encodeUsage(2, 0.15, 0.1);
          stream.write(frameGrpcMessage(payload));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        if (path === ROBIN_GRPC_GET_TERMS_VERSION) {
          termsTokens.push(auth);
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(varintField(2, 9)));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        if (path === ROBIN_GRPC_ACCEPT_TERMS) {
          termsTokens.push(auth);
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(Buffer.alloc(0)));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        stream.respond({ ':status': 404 });
        stream.end();
      });
    });
    await new Promise<void>(resolve => grpcServer.listen(0, '127.0.0.1', resolve));
    const grpcPort = (grpcServer.address() as { port: number }).port;

    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
      if (url === 'https://www.googleapis.com/oauth2/v4/token') {
        const code = new URLSearchParams(String(init?.body)).get('code');
        if (code === 'alice-code') return Response.json({ access_token: 'tok-alice', refresh_token: 'ref-alice', expires_in: 3600 });
        if (code === 'bob-code') return Response.json({ access_token: 'tok-bob', refresh_token: 'ref-bob', expires_in: 3600 });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        const auth = new Headers(init?.headers).get('Authorization');
        return Response.json({ email: auth === 'Bearer tok-alice' ? 'alice@example.com' : 'bob@example.com' });
      }
      if (url.includes('models.dev') || url.includes('openrouter.ai')) return new Response(null, { status: 404 });
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      let currentEntry: LLMProviderEntry = {
        kind: provider.id,
        baseUrl: `http://127.0.0.1:${grpcPort}`,
        spec: { model: 'gemini-robin-pro', thinking: true },
        options: {
          protocol: 'robin',
          authMode: 'oauth',
          generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
          quotaEndpoint: ROBIN_GRPC_GET_USAGE_INFO,
        },
      };

      const makeInstance = (name: string, entry: LLMProviderEntry) => provider.create(name, entry, {
        stateDir: join(root, name),
        secret: () => '',
        readBlob: () => null,
        keepThinking: () => false,
        log: nullLogger(),
      });

      const ui = provider.webUi!({
        language: 'zh',
        editing: false,
        entries: () => [{ name: 'pool', entry: currentEntry }],
        instance: name => makeInstance(name, currentEntry),
        save: (_name, next) => { currentEntry = structuredClone(next); },
      });

      // Save user-provided desktop-oauth.json first (package ships without bundled credentials).
      await ui.invoke!('auth', 'save-oauth-config', [{
        name: 'pool',
        json: JSON.stringify(GOOGLE_TEST_CONFIG),
      }]);

      // Sign in Alice then Bob.
      const loginA = await ui.invoke!('auth', 'login', [{ name: 'pool' }]) as { url: string };
      const urlA = new URL(loginA.url);
      const cbA = new URL(urlA.searchParams.get('redirect_uri')!);
      cbA.searchParams.set('code', 'alice-code');
      cbA.searchParams.set('state', urlA.searchParams.get('state')!);
      await ui.invoke!('auth', 'complete-login', [{ name: 'pool', redirectUrl: cbA.href }]);

      const loginB = await ui.invoke!('auth', 'login', [{ name: 'pool', forceAccountSelect: true }]) as { url: string };
      const urlB = new URL(loginB.url);
      expect(urlB.searchParams.get('prompt')).toContain('select_account');
      const cbB = new URL(urlB.searchParams.get('redirect_uri')!);
      cbB.searchParams.set('code', 'bob-code');
      cbB.searchParams.set('state', urlB.searchParams.get('state')!);
      const status2 = await ui.invoke!('auth', 'complete-login', [{ name: 'pool', redirectUrl: cbB.href }]) as AuthPanelStatus;

      expect(status2.accounts).toHaveLength(2);
      expect(status2.accountRouting).toBe('failover');
      expect(status2.emailsMasked).toBe(true);
      const alice = status2.accounts.find(a => a.email === 'a***e@example.com')!;
      const bob = status2.accounts.find(a => a.email === 'b***b@example.com')!;
      expect(alice.isPrimary).toBe(true);
      expect(alice.termsStatus).toBe('pending');
      expect(bob.termsStatus).toBe('pending');

      // Query ALL accounts quota (masked by default).
      const allQuota = await ui.invoke!('quota', 'query', [{ name: 'pool', accountId: 'all' }]) as QuotaSnapshot;
      expect(allQuota.totalAccounts).toBe(2);
      expect(allQuota.emailsMasked).toBe(true);
      expect(allQuota.accountOptions).toHaveLength(2);
      expect(allQuota.accountOptions!.map(o => o.email)).toEqual(['a***e@example.com', 'b***b@example.com']);
      expect(allQuota.accounts).toHaveLength(2);
      expect(allQuota.accounts![0].email).toBe('a***e@example.com');
      expect(allQuota.accounts![0].plan).toBe('Free');
      expect(allQuota.accounts![0].windows[0].remainingPercent).toBe(20);
      expect(allQuota.accounts![1].email).toBe('b***b@example.com');
      expect(allQuota.accounts![1].plan).toBe('Pro');
      expect(allQuota.accounts![1].windows[0].remainingPercent).toBe(85);

      // Toggle masking OFF from auth panel -> reveals full names in both auth & quota panels!
      const revealedAuth = await ui.invoke!('auth', 'set-mask', [{ name: 'pool', masked: false }]) as AuthPanelStatus;
      expect(revealedAuth.emailsMasked).toBe(false);
      expect(revealedAuth.email).toBe('alice@example.com');
      expect(revealedAuth.accounts.map(a => a.email)).toEqual(['alice@example.com', 'bob@example.com']);
      const revealedLabels = await ui.invoke!('quota', 'account-labels', [{ name: 'pool' }]) as QuotaAccountLabels;
      expect(revealedLabels.emailsMasked).toBe(false);
      expect(revealedLabels.accountOptions.map(o => o.email)).toEqual(['alice@example.com', 'bob@example.com']);

      // Toggle masking ON from quota panel -> hides all names back everywhere!
      const remaskedLabels = await ui.invoke!('quota', 'set-mask', [{ name: 'pool', masked: true }]) as QuotaAccountLabels;
      expect(remaskedLabels.emailsMasked).toBe(true);
      expect(remaskedLabels.accountOptions.map(o => o.email)).toEqual(['a***e@example.com', 'b***b@example.com']);
      const remaskedAuth = await ui.invoke!('auth', 'status', [{ name: 'pool' }]) as AuthPanelStatus;
      expect(remaskedAuth.emailsMasked).toBe(true);
      expect(remaskedAuth.accounts.map(a => a.email)).toEqual(['a***e@example.com', 'b***b@example.com']);

      // Switch routing to round-robin -> quota & account-labels reflect round-robin immediately.
      const rrAuth = await ui.invoke!('auth', 'set-routing', [{ name: 'pool', routing: 'round-robin' }]) as AuthPanelStatus;
      expect(rrAuth.accountRouting).toBe('round-robin');
      expect(currentEntry.options?.accountRouting).toBe('round-robin');
      const rrLabels = await ui.invoke!('quota', 'account-labels', [{ name: 'pool' }]) as QuotaAccountLabels;
      expect(rrLabels.accountRouting).toBe('round-robin');

      // auth.refresh-quotas populates weeklyRemaining & fiveHourRemaining directly on AuthPanelStatus accounts.
      const refreshedAuth = await ui.invoke!('auth', 'refresh-quotas', [{ name: 'pool' }]) as AuthPanelStatus;
      expect(refreshedAuth.accounts.find(a => a.id === alice.id)?.weeklyRemaining).toBe(50);
      expect(refreshedAuth.accounts.find(a => a.id === bob.id)?.weeklyRemaining).toBe(90);

      // Switch routing to least-used and verify Bob (90% weekly left) beats Alice (50% weekly left).
      const afterRouting = await ui.invoke!('auth', 'set-routing', [{ name: 'pool', routing: 'least-used' }]) as AuthPanelStatus;
      expect(afterRouting.accountRouting).toBe('least-used');
      expect(currentEntry.options?.accountRouting).toBe('least-used');
      const inst = makeInstance('pool', currentEntry);
      const ctrl = (inst.control as { oauth: GatewayControl }).oauth;
      expect(ctrl.pickAccountOrder('least-used')).toEqual([bob.id, alice.id]);

      // Switch routing to least-used-5h -> persisted cleanly and reflected in quota labels.
      const fiveHourRouting = await ui.invoke!('auth', 'set-routing', [{ name: 'pool', routing: 'least-used-5h' }]) as AuthPanelStatus;
      expect(fiveHourRouting.accountRouting).toBe('least-used-5h');
      expect(currentEntry.options?.accountRouting).toBe('least-used-5h');
      const fiveHourLabels = await ui.invoke!('quota', 'account-labels', [{ name: 'pool' }]) as QuotaAccountLabels;
      expect(fiveHourLabels.accountRouting).toBe('least-used-5h');
      // Restore least-used for subsequent assertions below.
      await ui.invoke!('auth', 'set-routing', [{ name: 'pool', routing: 'least-used' }]);

      // Query SINGLE selected account (Bob) -> still includes all accountOptions & accountRouting!
      const singleQuota = await ui.invoke!('quota', 'query', [{ name: 'pool', accountId: bob.id }]) as QuotaSnapshot;
      expect(singleQuota.selectedAccountId).toBe(bob.id);
      expect(singleQuota.accountRouting).toBe('least-used');
      expect(singleQuota.accountOptions).toHaveLength(2);
      expect(singleQuota.accounts).toHaveLength(1);
      expect(singleQuota.accounts![0].email).toBe('b***b@example.com');

      // Partial error in multi-account query: Bob fails 500, Alice still succeeds cleanly.
      failBobQuota = true;
      const partialQuota = await ui.invoke!('quota', 'query', [{ name: 'pool', accountId: 'all' }]) as QuotaSnapshot;
      expect(partialQuota.accounts).toHaveLength(2);
      expect(partialQuota.accounts!.find(a => a.accountId === alice.id)?.error).toBeUndefined();
      expect(partialQuota.accounts!.find(a => a.accountId === bob.id)?.error).toContain('HTTP 500');

      // Switch primary to Bob via auth panel.
      const switched = await ui.invoke!('auth', 'set-primary', [{ name: 'pool', accountId: bob.id }]) as AuthPanelStatus;
      expect(switched.primaryAccountId).toBe(bob.id);
      expect(switched.email).toBe('b***b@example.com');

      // Accept terms for Alice specifically uses Alice's Bearer token and flips ONLY Alice to 'accepted'.
      const acceptedRes = await ui.invoke!('auth', 'accept-terms', [{ name: 'pool', accountId: alice.id }]) as {
        accepted: boolean;
        version: number;
        status: AuthPanelStatus;
      };
      expect(termsTokens).toEqual(['Bearer tok-alice', 'Bearer tok-alice']);
      expect(acceptedRes.status.accounts.find(a => a.id === alice.id)?.termsStatus).toBe('accepted');
      expect(acceptedRes.status.accounts.find(a => a.id === alice.id)?.termsVersion).toBe(9);
      expect(acceptedRes.status.accounts.find(a => a.id === bob.id)?.termsStatus).toBe('pending');

      // Runtime ToS error marks an account as 'required' (bringing back the Accept Terms button).
      ctrl.markAccountTermsRequired(alice.id);
      const afterTosErr = await ui.invoke!('auth', 'status', [{ name: 'pool' }]) as AuthPanelStatus;
      expect(afterTosErr.accounts.find(a => a.id === alice.id)?.termsStatus).toBe('required');

      // Remove only Alice via per-account logout -> Bob remains signed in.
      const afterRemove = await ui.invoke!('auth', 'logout', [{ name: 'pool', accountId: alice.id }]) as AuthPanelStatus;
      expect(afterRemove.signedIn).toBe(true);
      expect(afterRemove.accounts).toHaveLength(1);
      expect(afterRemove.accounts[0].id).toBe(bob.id);
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>(resolve => grpcServer.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('masks emails with first/last char and three asterisks everywhere including upstream error text', () => {
    expect(maskEmail('543213@gmail.com')).toBe('5***3@gmail.com');
    expect(maskEmail('53@gmail.com')).toBe('5***3@gmail.com');
    expect(maskEmail('5@gmail.com')).toBe('5***@gmail.com');
    expect(maskEmail('5***3@gmail.com')).toBe('5***3@gmail.com');
    expect(maskEmail('alice@example.com')).toBe('a***e@example.com');
    expect(maskEmail('')).toBeUndefined();
    expect(maskEmail(undefined)).toBeUndefined();
    expect(sanitizeUpstreamText('Account 543213@gmail.com hit rate limit')).toBe('Account 5***3@gmail.com hit rate limit');
  });

  it('flags account as terms-required and fails over when Robin returns gRPC FAILED_PRECONDITION ToS error', async () => {
    const robinServer = http2.createServer();
    robinServer.on('stream', (stream, headers) => {
      const auth = String(headers['authorization'] ?? '');
      stream.resume();
      stream.on('end', () => {
        if (auth === 'Bearer tok-A') {
          stream.respond({
            ':status': 200,
            'content-type': 'application/grpc',
            'grpc-status': '9',
            'grpc-message': 'Please accept our terms of service before continuing.',
          }, { endStream: true });
          return;
        }
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.write(frameGrpcMessage(encodeReply('OK from account B')));
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
      });
    });
    await new Promise<void>(resolve => robinServer.listen(0, '127.0.0.1', resolve));
    const port = (robinServer.address() as { port: number }).port;

    const failures: { accountId: string; status: number | null; detail?: string }[] = [];
    const successes: string[] = [];
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      protocol: 'robin',
      generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
      auth: {
        accessToken: async () => 'tok-A',
        selectAccounts: () => ['acct_A', 'acct_B'],
        accessTokenFor: async id => (id === 'acct_A' ? 'tok-A' : 'tok-B'),
        onAccountFailure: (accountId, status, detail) => failures.push({ accountId, status, detail }),
        onAccountSuccess: accountId => successes.push(accountId),
      },
    });
    try {
      const chunks: string[] = [];
      for await (const chunk of client.stream({
        model: 'gemini-robin-fast',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      })) {
        for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (p.text) chunks.push(p.text);
        }
      }
      expect(chunks.join('')).toBe('OK from account B');
      expect(failures).toHaveLength(1);
      expect(failures[0].accountId).toBe('acct_A');
      expect(failures[0].status).toBe(400);
      expect(failures[0].detail).toContain('terms of service');
      expect(successes).toEqual(['acct_B']);
    } finally {
      await new Promise<void>(resolve => robinServer.close(() => resolve()));
    }
  });

  it('prioritizes Ultra accounts for gemini-4-carbon and reports Ultra plan in mixed Pro+Ultra pools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ggw-ultra-pool-'));
    const robinServer = http2.createServer();
    robinServer.on('stream', (stream, headers) => {
      const auth = String(headers.authorization ?? '');
      stream.resume();
      stream.on('end', () => {
        if (headers[':path'] === ROBIN_GRPC_GET_USAGE_INFO) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          // Account A is Pro (tier 2, 10% used), Account B is Ultra (tier 3, 25% used).
          const payload = auth.includes('tok-pro') ? encodeUsage(2, 0.1, 0.1) : encodeUsage(3, 0.25, 0.25);
          stream.write(frameGrpcMessage(payload));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        stream.respond({ ':status': 404 });
        stream.end();
      });
    });
    await new Promise<void>(resolve => robinServer.listen(0, '127.0.0.1', resolve));
    const port = (robinServer.address() as { port: number }).port;

    try {
      const oauthDir = join(dir, 'oauth');
      mkdirSync(oauthDir, { recursive: true });
      const ctrl = new GatewayControl(oauthDir);
      ctrl.saveOAuthConfig(JSON.stringify(GOOGLE_TEST_CONFIG));
      // Seed Pro as primary and Ultra as secondary using matching profile hash.
      writeFileSync(join(oauthDir, OAUTH_ACCOUNTS_FILE), JSON.stringify({
        version: 2,
        profile: testProfileHash(GOOGLE_TEST_CONFIG),
        primaryId: 'acct_pro',
        accounts: [
          { id: 'acct_pro', email: 'pro@example.com', accessToken: 'tok-pro', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 },
          { id: 'acct_ultra', email: 'ultra@example.com', accessToken: 'tok-ultra', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 },
        ],
      }));
      const ctrlLoaded = new GatewayControl(oauthDir);
      const entry: LLMProviderEntry = {
        kind: 'gemini-gateway',
        baseUrl: `http://127.0.0.1:${port}`,
        spec: { model: 'gemini-4-carbon', thinking: true },
        options: { protocol: 'robin', authMode: 'oauth', accountRouting: 'failover', quotaEndpoint: ROBIN_GRPC_GET_USAGE_INFO },
      };
      const snap = await ctrlLoaded.queryQuota(entry, { secret: () => '' });
      expect(snap.accounts?.find(a => a.accountId === 'acct_pro')?.plan).toBe('Pro');
      expect(snap.accounts?.find(a => a.accountId === 'acct_ultra')?.plan).toBe('Ultra');
      expect(ctrlLoaded.getPoolPlans()).toEqual(['Ultra', 'Pro']);
      expect(ctrlLoaded.findHighestTierAccountId()).toBe('acct_ultra');

      // Regular Neon follows failover (Pro primary first); Carbon prioritizes Ultra ahead of Pro!
      expect(ctrlLoaded.pickAccountOrder('failover', 'gemini-4-neon')).toEqual(['acct_pro', 'acct_ultra']);
      expect(ctrlLoaded.pickAccountOrder('failover', 'gemini-4-carbon')).toEqual(['acct_ultra', 'acct_pro']);
      // Even under least-used when Pro has more remaining quota (90% vs 75%), Carbon still prefers Ultra!
      expect(ctrlLoaded.pickAccountOrder('least-used', 'gemini-4-neon')).toEqual(['acct_pro', 'acct_ultra']);
      expect(ctrlLoaded.pickAccountOrder('least-used', 'gemini-4-carbon')).toEqual(['acct_ultra', 'acct_pro']);

      // Effective account for Carbon resolves to Ultra, and getCachedAccountInfo(acct_ultra) returns Ultra (not Pro).
      const effectiveCarbon = ctrlLoaded.resolveEffectiveAccountId('failover', 'gemini-4-carbon');
      expect(effectiveCarbon).toBe('acct_ultra');
      expect(ctrlLoaded.getCachedAccountInfo(effectiveCarbon)).toMatchObject({ plan: 'Ultra', userTier: 'TIER2' });
    } finally {
      await new Promise<void>(resolve => robinServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('orders least-used-5h by 5-hour remaining quota, prioritizes entitled Pro accounts over Free on paid models, and cools down on attribution downgrade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ggw-5h-entitle-pool-'));
    const robinServer = http2.createServer();
    robinServer.on('stream', (stream, headers) => {
      const auth = String(headers.authorization ?? '');
      stream.resume();
      stream.on('end', () => {
        if (headers[':path'] === ROBIN_GRPC_GET_USAGE_INFO) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          // acct_free: Free (tier 1), 100% 5h left, 100% weekly left
          // acct_pro_a: Pro (tier 2), 40% 5h left (0.6 used), 90% weekly left (0.1 used)
          // acct_pro_b: Pro (tier 2), 90% 5h left (0.1 used), 60% weekly left (0.4 used)
          // acct_pro_tie: Pro (tier 2), 90% 5h left (0.1 used), 75% weekly left (0.25 used)
          // acct_pro_week_empty: Pro (tier 2), 100% 5h left (0.0 used), 3% weekly left (0.97 used -> weekly exhausted)
          let payload: Buffer;
          if (auth.includes('tok-free')) payload = encodeUsage(1, 0.0, 0.0);
          else if (auth.includes('tok-pro-a')) payload = encodeUsage(2, 0.6, 0.1);
          else if (auth.includes('tok-pro-b')) payload = encodeUsage(2, 0.1, 0.4);
          else if (auth.includes('tok-pro-tie')) payload = encodeUsage(2, 0.1, 0.25);
          else payload = encodeUsage(2, 0.0, 0.97);
          stream.write(frameGrpcMessage(payload));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        stream.respond({ ':status': 404 });
        stream.end();
      });
    });
    await new Promise<void>(resolve => robinServer.listen(0, '127.0.0.1', resolve));
    const port = (robinServer.address() as { port: number }).port;

    try {
      const oauthDir = join(dir, 'oauth');
      mkdirSync(oauthDir, { recursive: true });
      const ctrlInit = new GatewayControl(oauthDir);
      ctrlInit.saveOAuthConfig(JSON.stringify(GOOGLE_TEST_CONFIG));
      writeFileSync(join(oauthDir, OAUTH_ACCOUNTS_FILE), JSON.stringify({
        version: 2,
        profile: testProfileHash(GOOGLE_TEST_CONFIG),
        primaryId: 'acct_free',
        accounts: [
          { id: 'acct_free', email: 'free@example.com', accessToken: 'tok-free', refreshToken: 'r0', expiresAt: Date.now() + 3_600_000 },
          { id: 'acct_pro_a', email: 'proa@example.com', accessToken: 'tok-pro-a', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 },
          { id: 'acct_pro_b', email: 'prob@example.com', accessToken: 'tok-pro-b', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 },
          { id: 'acct_pro_tie', email: 'protie@example.com', accessToken: 'tok-pro-tie', refreshToken: 'r3', expiresAt: Date.now() + 3_600_000 },
          { id: 'acct_pro_week_empty', email: 'proempty@example.com', accessToken: 'tok-pro-empty', refreshToken: 'r4', expiresAt: Date.now() + 3_600_000 },
        ],
      }));
      const ctrl = new GatewayControl(oauthDir);
      const entry: LLMProviderEntry = {
        kind: 'gemini-gateway',
        baseUrl: `http://127.0.0.1:${port}`,
        spec: { model: 'gemini-4-neon', thinking: true },
        options: { protocol: 'robin', authMode: 'oauth', accountRouting: 'least-used-5h', quotaEndpoint: ROBIN_GRPC_GET_USAGE_INFO },
      };
      await ctrl.queryQuota(entry, { secret: () => '' });

      // Without model hint:
      // least-used ranks by weekly remaining: acct_free (100) > acct_pro_a (90) > acct_pro_tie (75) > acct_pro_b (60) > acct_pro_week_empty (3)
      expect(ctrl.pickAccountOrder('least-used')).toEqual([
        'acct_free',
        'acct_pro_a',
        'acct_pro_tie',
        'acct_pro_b',
        'acct_pro_week_empty',
      ]);
      // least-used-5h ranks by 5h remaining, tie-breaking by weekly remaining, deprioritizing weekly <= 5% exhausted accounts:
      // acct_free (100/100) > acct_pro_tie (90/75) > acct_pro_b (90/60) > acct_pro_a (40/90) > acct_pro_week_empty (100/3 exhausted)
      expect(ctrl.pickAccountOrder('least-used-5h')).toEqual([
        'acct_free',
        'acct_pro_tie',
        'acct_pro_b',
        'acct_pro_a',
        'acct_pro_week_empty',
      ]);

      // For paid model gemini-4-neon (mode 3), Free (TIER_BASIC) is pushed behind ALL entitled Pro accounts across every routing mode!
      expect(ctrl.pickAccountOrder('least-used', 'gemini-4-neon')).toEqual([
        'acct_pro_a',
        'acct_pro_tie',
        'acct_pro_b',
        'acct_pro_week_empty',
        'acct_free',
      ]);
      expect(ctrl.pickAccountOrder('least-used-5h', 'gemini-4-neon')).toEqual([
        'acct_pro_tie',
        'acct_pro_b',
        'acct_pro_a',
        'acct_pro_week_empty',
        'acct_free',
      ]);
      expect(ctrl.pickAccountOrder('failover', 'gemini-4-neon')).toEqual([
        'acct_pro_a',
        'acct_pro_b',
        'acct_pro_tie',
        'acct_pro_week_empty',
        'acct_free',
      ]);

      // For Free-entitled gemini-3.5-flash-lite (mode 6), primary Free account remains first in failover!
      expect(ctrl.pickAccountOrder('failover', 'gemini-3.5-flash-lite')[0]).toBe('acct_free');

      // Attribution-only downgrade (no fallback/downgradeReason, e.g. 4 Neon -> Used 3.1 Pro model) cools down the account immediately.
      ctrl.recordRouting({
        requestedModel: 'gemini-4-neon',
        requestedModeCategory: 3,
        requestedThinkingLevel: 4,
        resolvedModeCategory: 3,
        resolvedThinkingLevel: 1,
        attribution: 'Used 3.1 Pro model',
        observedAt: '2026-11-27T01:28:00.000Z',
      }, 'acct_pro_a');
      expect(ctrl.getAccountRuntime('acct_pro_a').cooldownUntil).toBeGreaterThan(Date.now());
      expect(ctrl.pickAccountOrder('failover', 'gemini-4-neon')[0]).toBe('acct_pro_b');
    } finally {
      await new Promise<void>(resolve => robinServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears stale quota errors on subsequent quota success while preserving real generation errors and cooldown state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ggw-quota-err-clear-'));
    let failAccountA = false;
    let failAccountB = false;

    const robinServer = http2.createServer();
    robinServer.on('stream', (stream, headers) => {
      const auth = String(headers.authorization ?? '');
      stream.resume();
      stream.on('end', () => {
        if (headers[':path'] === ROBIN_GRPC_GET_USAGE_INFO) {
          if (auth === 'Bearer tok-a' && failAccountA) {
            stream.respond({ ':status': 500, 'content-type': 'text/plain' });
            stream.end('transient quota upstream failure');
            return;
          }
          if (auth === 'Bearer tok-b' && failAccountB) {
            stream.respond({ ':status': 500, 'content-type': 'text/plain' });
            stream.end('temporary quota failure on B');
            return;
          }
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          const payload = auth === 'Bearer tok-a' ? encodeUsage(2, 0.2, 0.1) : encodeUsage(2, 0.3, 0.2);
          stream.write(frameGrpcMessage(payload));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        stream.respond({ ':status': 404 });
        stream.end();
      });
    });
    await new Promise<void>(resolve => robinServer.listen(0, '127.0.0.1', resolve));
    const port = (robinServer.address() as { port: number }).port;

    try {
      const oauthDir = join(dir, 'oauth');
      mkdirSync(oauthDir, { recursive: true });
      const initCtrl = new GatewayControl(oauthDir);
      initCtrl.saveOAuthConfig(JSON.stringify(GOOGLE_TEST_CONFIG));
      writeFileSync(join(oauthDir, OAUTH_ACCOUNTS_FILE), JSON.stringify({
        version: 2,
        profile: testProfileHash(GOOGLE_TEST_CONFIG),
        primaryId: 'acct_a',
        accounts: [
          { id: 'acct_a', email: 'a@example.com', accessToken: 'tok-a', refreshToken: 'ra', expiresAt: Date.now() + 3_600_000 },
          { id: 'acct_b', email: 'b@example.com', accessToken: 'tok-b', refreshToken: 'rb', expiresAt: Date.now() + 3_600_000 },
        ],
      }));

      const ctrl = new GatewayControl(oauthDir);
      const entry: LLMProviderEntry = {
        kind: 'gemini-gateway',
        baseUrl: `http://127.0.0.1:${port}`,
        spec: { model: 'gemini-4-neon', thinking: true },
        options: { protocol: 'robin', authMode: 'oauth', accountRouting: 'failover', quotaEndpoint: ROBIN_GRPC_GET_USAGE_INFO },
      };

      // Round 1: initial healthy quota fetch populates cached quota with zero errors.
      await ctrl.queryQuota(entry, { secret: () => '' });
      expect(ctrl.getAccountRuntime('acct_a').fiveHourRemaining).toBe(80);
      expect(ctrl.getAccountRuntime('acct_a').lastError).toBeUndefined();
      expect(ctrl.getAccountRuntime('acct_b').lastError).toBeUndefined();

      // Round 2: acct_a quota query fails -> cached quota preserved, error surfaced on runtime card.
      failAccountA = true;
      const failedSnap = await ctrl.queryQuota(entry, { secret: () => '' });
      expect(failedSnap.accounts?.find(a => a.accountId === 'acct_a')?.error).toContain('HTTP 500');
      expect(ctrl.getAccountRuntime('acct_a').fiveHourRemaining).toBe(80);
      expect(ctrl.getAccountRuntime('acct_a').lastError).toContain('HTTP 500');
      expect(ctrl.getAccountRuntime('acct_b').lastError).toBeUndefined();

      // Round 3: acct_a quota query succeeds again -> stale quota error MUST clear immediately!
      failAccountA = false;
      const recoveredSnap = await ctrl.queryQuota(entry, { secret: () => '' });
      expect(recoveredSnap.accounts?.every(a => !a.error)).toBe(true);
      expect(ctrl.getAccountRuntime('acct_a').lastError).toBeUndefined();
      expect(ctrl.getAccountRuntime('acct_b').lastError).toBeUndefined();

      // Round 4: Real generation errors & cooldowns MUST survive subsequent quota queries (both failing and succeeding).
      ctrl.markAccountCooldown('acct_a', 60_000, 'HTTP 429 rate limited');
      ctrl.recordAccountError('acct_b', 'Generation stream failed');

      failAccountB = true;
      await ctrl.queryQuota(entry, { secret: () => '' });
      expect(ctrl.getAccountRuntime('acct_a').cooldownReason).toBe('HTTP 429 rate limited');
      expect(ctrl.getAccountRuntime('acct_a').lastError).toBe('HTTP 429 rate limited');
      // acct_b's real generation error is not overwritten by a transient quota error.
      expect(ctrl.getAccountRuntime('acct_b').lastError).toBe('Generation stream failed');

      failAccountB = false;
      await ctrl.queryQuota(entry, { secret: () => '' });
      // Quota recovery clears only quotaError and keeps both real generation error and active cooldown intact.
      expect(ctrl.getAccountRuntime('acct_a').cooldownUntil).toBeGreaterThan(Date.now());
      expect(ctrl.getAccountRuntime('acct_a').cooldownReason).toBe('HTTP 429 rate limited');
      expect(ctrl.getAccountRuntime('acct_a').lastError).toBe('HTTP 429 rate limited');
      expect(ctrl.getAccountRuntime('acct_b').lastError).toBe('Generation stream failed');

      // Generation success (clearAccountCooldown) clears the real generation error cleanly.
      ctrl.clearAccountCooldown('acct_b');
      expect(ctrl.getAccountRuntime('acct_b').lastError).toBeUndefined();
    } finally {
      await new Promise<void>(resolve => robinServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suspends permanently invalid OAuth accounts (invalid_grant) from routing and pool quota refreshes until re-authenticated', async () => {
    expect(isPermanentOAuthFailure('OAuth token endpoint returned HTTP 400 (invalid_grant)')).toBe(true);
    expect(isPermanentOAuthFailure('OAuth token endpoint returned HTTP 401 (unauthorized_client)')).toBe(true);
    expect(isPermanentOAuthFailure('Token has been expired or revoked.')).toBe(true);
    expect(isPermanentOAuthFailure('OAuth token endpoint returned HTTP 500')).toBe(false);
    expect(isPermanentOAuthFailure('Request had invalid authentication credentials.')).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'ggw-invalid-grant-'));
    const tokenEndpointCalls: string[] = [];

    const robinServer = http2.createServer();
    robinServer.on('stream', (stream, headers) => {
      stream.resume();
      stream.on('end', () => {
        if (headers[':path'] === ROBIN_GRPC_GET_USAGE_INFO) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(encodeUsage(2, 0.2, 0.1)));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        stream.respond({ ':status': 404 });
        stream.end();
      });
    });
    await new Promise<void>(resolve => robinServer.listen(0, '127.0.0.1', resolve));
    const port = (robinServer.address() as { port: number }).port;

    const oauthFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === GOOGLE_TEST_CONFIG.tokenEndpoint) {
        const params = new URLSearchParams(String(init?.body));
        const grantType = params.get('grant_type');
        if (grantType === 'refresh_token') {
          const rt = params.get('refresh_token') ?? '';
          tokenEndpointCalls.push(rt);
          return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
        }
        if (grantType === 'authorization_code' && params.get('code') === 'reauth-dead-1') {
          return Response.json({ access_token: 'tok-dead1-new', refresh_token: 'ref-dead1-new', expires_in: 3600 });
        }
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ email: 'dead1@example.com' });
      }
      throw new Error(`Unexpected OAuth fetch: ${url}`);
    });

    try {
      const oauthDir = join(dir, 'oauth');
      mkdirSync(oauthDir, { recursive: true });
      const initCtrl = new GatewayControl(oauthDir, oauthFetch);
      initCtrl.saveOAuthConfig(JSON.stringify(GOOGLE_TEST_CONFIG));
      const expiredTs = Date.now() - 60_000;
      const validTs = Date.now() + 3_600_000;
      writeFileSync(join(oauthDir, OAUTH_ACCOUNTS_FILE), JSON.stringify({
        version: 1,
        profile: testProfileHash(GOOGLE_TEST_CONFIG),
        primaryId: 'acct_dead_1',
        accounts: [
          { id: 'acct_dead_1', email: 'dead1@example.com', accessToken: 'tok-old-1', refreshToken: 'ref-dead-1', expiresAt: expiredTs, addedAt: '2026-11-20T00:00:00Z' },
          { id: 'acct_dead_2', email: 'dead2@example.com', accessToken: 'tok-old-2', refreshToken: 'ref-dead-2', expiresAt: expiredTs, addedAt: '2026-11-20T00:01:00Z' },
          { id: 'acct_good', email: 'good@example.com', accessToken: 'tok-good', refreshToken: 'ref-good', expiresAt: validTs, addedAt: '2026-11-20T00:02:00Z' },
        ],
      }));

      const ctrl = new GatewayControl(oauthDir, oauthFetch);
      const entry: LLMProviderEntry = {
        kind: 'gemini-gateway',
        baseUrl: `http://127.0.0.1:${port}`,
        spec: { model: 'gemini-4-neon', thinking: true },
        options: { protocol: 'robin', authMode: 'oauth', accountRouting: 'round-robin', quotaEndpoint: ROBIN_GRPC_GET_USAGE_INFO },
      };

      // Round 1 quota refresh discovers invalid_grant on both dead accounts and suspends them immediately.
      const snap1 = await ctrl.queryQuota(entry, { secret: () => '' });
      expect(tokenEndpointCalls.sort()).toEqual(['ref-dead-1', 'ref-dead-2']);
      expect(snap1.accounts?.find(a => a.accountId === 'acct_dead_1')?.error).toContain('invalid_grant');
      expect(snap1.accounts?.find(a => a.accountId === 'acct_good')?.error).toBeUndefined();
      expect(ctrl.getAccountRuntime('acct_dead_1').authInvalid).toBe(true);
      expect(ctrl.getAccountRuntime('acct_dead_2').authInvalid).toBe(true);
      expect(ctrl.getAccountRuntime('acct_good').authInvalid).toBeUndefined();

      // Dead accounts are excluded from scheduling across every routing mode (even if primary is dead!).
      expect(ctrl.pickAccountOrder('failover', 'gemini-4-neon')).toEqual(['acct_good']);
      expect(ctrl.pickAccountOrder('round-robin', 'gemini-4-neon')).toEqual(['acct_good']);
      expect(ctrl.pickAccountOrder('least-used', 'gemini-4-neon')).toEqual(['acct_good']);
      expect(ctrl.pickAccountOrder('least-used-5h', 'gemini-4-neon')).toEqual(['acct_good']);

      // Even while acct_good is in temporary cooldown, dead invalid_grant accounts are still skipped.
      ctrl.markAccountCooldown('acct_good', 60_000, 'HTTP 429');
      expect(ctrl.pickAccountOrder('round-robin', 'gemini-4-neon')).toEqual(['acct_good']);
      ctrl.clearAccountCooldown('acct_good');

      // Round 2 pool quota refresh skips dead accounts without burning extra token-endpoint round trips.
      tokenEndpointCalls.length = 0;
      const snap2 = await ctrl.queryQuota(entry, { secret: () => '' });
      expect(tokenEndpointCalls).toEqual([]);
      expect(snap2.accounts?.find(a => a.accountId === 'acct_dead_1')?.error).toContain('invalid_grant');
      expect(snap2.accounts?.find(a => a.accountId === 'acct_good')?.error).toBeUndefined();

      // Re-authenticating acct_dead_1 via DesktopOAuth automatically clears its suspension!
      const login = await ctrl.auth.startLogin(undefined, { targetAccountId: 'acct_dead_1', forceAccountSelect: true });
      const loginUrl = new URL(login.url);
      const cb = new URL(login.redirectUri);
      cb.searchParams.set('code', 'reauth-dead-1');
      cb.searchParams.set('state', loginUrl.searchParams.get('state')!);
      await ctrl.auth.completeLogin(cb.href);

      expect(ctrl.getAccountRuntime('acct_dead_1').authInvalid).toBeUndefined();
      expect(ctrl.getAccountRuntime('acct_dead_1').lastError).toBeUndefined();
      expect(ctrl.pickAccountOrder('failover', 'gemini-4-neon')).toEqual(['acct_dead_1', 'acct_good']);

      // External disk replacement (e.g. CLI login) updates expiresAt and auto-lifts suspension on acct_dead_2 too.
      const disk = JSON.parse(readFileSync(join(oauthDir, OAUTH_ACCOUNTS_FILE), 'utf8')) as {
        primaryId: string;
        accounts: Array<{ id: string; expiresAt: number }>;
      };
      disk.accounts.find(a => a.id === 'acct_dead_2')!.expiresAt = Date.now() + 7_200_000;
      writeFileSync(join(oauthDir, OAUTH_ACCOUNTS_FILE), JSON.stringify(disk));
      expect(ctrl.getAccountRuntime('acct_dead_2').authInvalid).toBeUndefined();
      expect(ctrl.pickAccountOrder('failover', 'gemini-4-neon')).toEqual(['acct_dead_1', 'acct_dead_2', 'acct_good']);

      // Fallback: if ALL accounts are authInvalid, pickAccountOrder still returns them so callers surface an actionable error.
      ctrl.markAccountAuthInvalid('acct_dead_1', 'invalid_grant');
      ctrl.markAccountAuthInvalid('acct_dead_2', 'invalid_grant');
      ctrl.markAccountAuthInvalid('acct_good', 'invalid_grant');
      expect(ctrl.pickAccountOrder('failover', 'gemini-4-neon')).toEqual(['acct_dead_1', 'acct_dead_2', 'acct_good']);
    } finally {
      await new Promise<void>(resolve => robinServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
