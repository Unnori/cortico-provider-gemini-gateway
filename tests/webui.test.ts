import { mkdtempSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { describe, expect, it, vi } from 'vitest';
import provider from '../src/index.ts';
import type { QuotaSnapshot } from '../src/quota.ts';
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
import type { AuthPanelStatus, CustomRoutesState, GatewayPanelState, GatewayTestResult } from '../src/webui/server.ts';
import { resolveHeaders } from '../src/options.ts';
import { resolveOAuthDir } from '../src/control.ts';

function encodeFloat32Field(fieldNumber: number, value: number): Buffer {
  const key = Buffer.from([(fieldNumber << 3) | 5]);
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  return Buffer.concat([key, buf]);
}

function encodeMockUsage(): Buffer {
  const ts1 = Buffer.concat([varintField(1, Math.floor(Date.parse('2026-11-19T08:00:00Z') / 1000)), varintField(2, 0)]);
  const ts2 = Buffer.concat([varintField(1, Math.floor(Date.parse('2026-11-26T00:00:00Z') / 1000)), varintField(2, 0)]);
  const row1 = Buffer.concat([lengthDelimited(1, ts1), encodeFloat32Field(2, 0.25), stringField(3, '5-hour')]);
  const row2 = Buffer.concat([lengthDelimited(1, ts2), encodeFloat32Field(2, 0.1), stringField(3, 'Weekly')]);
  const group = Buffer.concat([varintField(1, 1), lengthDelimited(2, row1), lengthDelimited(2, row2)]);
  return Buffer.concat([varintField(2, 2), lengthDelimited(3, group)]);
}

function encodeMockReply(text: string): Buffer {
  const model = Buffer.concat([stringField(1, 'r_1'), lengthDelimited(2, stringField(1, text))]);
  const inner = Buffer.concat([
    lengthDelimited(1, model),
    lengthDelimited(2, stringField(1, 'c_webui_1')),
    varintField(9, 1),
    stringField(30, 'Gemini 4 Hydrogen'),
  ]);
  return lengthDelimited(1003, lengthDelimited(1, inner));
}

describe('gateway WebUI browser OAuth, persistence, direct call, and quota panel', () => {
  it('authenticates via browser loopback in draft, persists locally, supports immediate gRPC calls, and queries quota', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gemini-webui-'));
    const realFetch = globalThis.fetch;

    const grpcServer = http2.createServer();
    grpcServer.on('stream', (stream, headers) => {
      const path = headers[':path'];
      stream.resume();
      stream.on('end', () => {
        expect(headers['authorization']).toBe('Bearer tok-live-1');
        if (path === ROBIN_GRPC_GET_USAGE_INFO) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(encodeMockUsage()));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        if (path === ROBIN_GRPC_PROCESS_QUERY) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(encodeMockReply('63')));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        if (path === ROBIN_GRPC_GET_TERMS_VERSION) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(varintField(2, 7)));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        if (path === ROBIN_GRPC_ACCEPT_TERMS) {
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
    const grpcAddr = grpcServer.address();
    if (!grpcAddr || typeof grpcAddr === 'string') throw new Error('Expected TCP address');
    const localRobinUrl = `http://127.0.0.1:${grpcAddr.port}`;

    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
        return realFetch(input, init);
      }
      if (url === 'https://www.googleapis.com/oauth2/v4/token') {
        return Response.json({ access_token: 'tok-live-1', refresh_token: 'ref-live-1', expires_in: 3600 });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ email: 'robin-user@example.com' });
      }
      if (url.includes('models.dev') || url.includes('openrouter.ai')) {
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      let currentName = 'draft';
      let currentEntry: LLMProviderEntry = {
        kind: provider.id,
        baseUrl: provider.defaultBaseUrl,
        spec: { model: '', thinking: true },
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
        editing: true,
        entries: () => [{ name: currentName, entry: currentEntry }],
        instance: name => makeInstance(name, currentEntry),
        save: (_name, next) => { currentEntry = structuredClone(next); },
      });

      // 0. Panel layout omits redundant manual endpoint block and replaces bare pricing with model-settings.
      expect(ui.panels?.map(p => p.id)).toEqual(['gateway', 'auth', 'quota', 'model', 'model-settings', 'protocol']);

      // 1. Gateway state auto-initializes Robin draft defaults + oauthProfile.
      const gatewayState = await ui.invoke!('gateway', 'state', [{ name: 'draft' }]) as GatewayPanelState;
      expect(gatewayState.protocol).toBe('robin');
      expect(gatewayState.authMode).toBe('oauth');
      expect(gatewayState.generationEndpoint).toBe(ROBIN_GRPC_PROCESS_QUERY);
      expect(gatewayState.quotaEndpoint).toBe(ROBIN_GRPC_GET_USAGE_INFO);
      expect(currentEntry.spec?.model).toBe('gemini-2.5-pro');
      expect(typeof currentEntry.options?.oauthProfile).toBe('string');

      // 1b. Quota query before sign-in returns authRequired without hitting upstream.
      const beforeLogin = await ui.invoke!('quota', 'query', [{ name: 'draft' }]) as QuotaSnapshot;
      expect(beforeLogin.supported).toBe(true);
      expect(beforeLogin.authRequired).toBe(true);
      expect(beforeLogin.windows).toEqual([]);

      // Point baseUrl at local HTTP/2 mock gRPC server for live call & quota checks.
      currentEntry = { ...currentEntry, baseUrl: localRobinUrl };

      // 2a. Fresh install has no bundled OAuth credentials: login guides user to paste desktop-oauth.json first.
      const beforeCfg = await ui.invoke!('auth', 'status', [{ name: 'draft' }]) as AuthPanelStatus;
      expect(beforeCfg.configured).toBe(false);
      await expect(ui.invoke!('auth', 'login', [{ name: 'draft' }])).rejects.toThrow('desktop-oauth.json');

      // 2b. Save user-provided desktop-oauth.json via WebUI panel, then start browser OAuth login.
      const savedCfg = await ui.invoke!('auth', 'save-oauth-config', [{
        name: 'draft',
        json: JSON.stringify({
          clientId: 'test-robin-client.apps.googleusercontent.com',
          clientSecret: 'test-client-secret',
          scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/assistant', 'https://www.googleapis.com/auth/gemini'],
          authEndpoint: 'https://accounts.google.com/o/oauth2/auth',
          tokenEndpoint: 'https://www.googleapis.com/oauth2/v4/token',
          redirectHost: 'localhost',
          redirectPath: '',
          authParams: { access_type: 'offline', prompt: 'consent' },
        }),
      }]) as AuthPanelStatus;
      expect(savedCfg.configured).toBe(true);
      expect(savedCfg.customConfig).toBe(true);

      const loginStarted = await ui.invoke!('auth', 'login', [{ name: 'draft' }]) as { url: string; status: AuthPanelStatus };
      expect(loginStarted.status.pending).toBe(true);
      const authUrl = new URL(loginStarted.url);
      expect(authUrl.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/assistant');
      const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', 'browser-auth-code');
      redirect.searchParams.set('state', authUrl.searchParams.get('state')!);

      const cbResp = await fetch(redirect);
      expect(cbResp.status).toBe(200);

      // Wait for async token exchange to finish and persist (masked by default).
      let authStatus!: AuthPanelStatus;
      await vi.waitFor(async () => {
        authStatus = await ui.invoke!('auth', 'status', [{ name: 'draft' }]) as AuthPanelStatus;
        expect(authStatus.signedIn).toBe(true);
      });
      expect(authStatus.emailsMasked).toBe(true);
      expect(authStatus.email).toBe('r***r@example.com');

      // 3. Query quota right in the panel via native HTTP/2 gRPC.
      const quota = await ui.invoke!('quota', 'query', [{ name: 'draft' }]) as QuotaSnapshot;
      expect(quota.supported).toBe(true);
      expect(quota.authRequired).toBeUndefined();
      expect(quota.plan).toBe('Pro');
      expect(quota.windows.map(w => w.usedPercent)).toEqual([25, 10]);

      // 3b. Test connection in gateway panel succeeds via live gRPC quota check.
      const testRes = await ui.invoke!('gateway', 'test', [{ name: 'draft' }]) as GatewayTestResult;
      expect(testRes.ok).toBe(true);
      expect(testRes.summary).toContain('Robin');

      // 3c. User-initiated Gemini ToS confirmation in auth panel.
      const terms = await ui.invoke!('auth', 'accept-terms', [{ name: 'draft' }]) as { accepted: boolean; version: number; status: AuthPanelStatus };
      expect(terms.accepted).toBe(true);
      expect(terms.version).toBe(7);
      expect(terms.status.protocol).toBe('robin');

      // 4. Save under a real endpoint name and invoke directly (no re-login or restart needed).
      currentName = 'my-robin';
      const savedInstance = makeInstance('my-robin', currentEntry);
      const generation = await savedInstance.client.respond({
        model: 'gemini-4-hydrogen',
        input: '9 * 7 = ?',
      });
      expect(generation.response.status).toBe('completed');
      expect(JSON.stringify(generation.response.output)).toContain('63');

      // 5. Switch presets & options cleanly — baseUrl switches automatically with protocol!
      const geminiState = await ui.invoke!('gateway', 'apply-preset', [{ name: 'my-robin', preset: 'gemini' }]) as GatewayPanelState;
      expect(geminiState.protocol).toBe('gemini');
      expect(geminiState.authMode).toBe('api-key');
      expect(geminiState.baseUrl).toBe(localRobinUrl);
      const backToRobin = await ui.invoke!('gateway', 'apply-preset', [{ name: 'my-robin', preset: 'robin' }]) as GatewayPanelState;
      expect(backToRobin.protocol).toBe('robin');
      expect(backToRobin.baseUrl).toBe('https://robinfrontend-pa.googleapis.com');
      const switchedToRpc = await ui.invoke!('gateway', 'apply-preset', [{ name: 'my-robin', preset: 'rpc' }]) as GatewayPanelState;
      expect(switchedToRpc.protocol).toBe('rpc');
      expect(switchedToRpc.baseUrl).toBe('http://127.0.0.1:8080');

      // 6. Logout clears local tokens; clearing OAuth config cleanly resets configured to false.
      const loggedOut = await ui.invoke!('auth', 'logout', [{ name: 'my-robin' }]) as AuthPanelStatus;
      expect(loggedOut.signedIn).toBe(false);
      const clearedCfg = await ui.invoke!('auth', 'reset-oauth-config', [{ name: 'my-robin' }]) as AuthPanelStatus;
      expect(clearedCfg.configured).toBe(false);
      expect(clearedCfg.customConfig).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>(resolve => grpcServer.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('switches Step 2 to API Key management for Web2API Gemini and Step 3 to custom routes for Custom RPC', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gemini-webui-apikey-'));
    try {
      let currentEntry: LLMProviderEntry = {
        kind: provider.id,
        baseUrl: provider.defaultBaseUrl,
        spec: { model: 'gemini-2.5-pro', thinking: true },
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
        editing: true,
        entries: () => [{ name: 'draft', entry: currentEntry }],
        instance: name => makeInstance(name, currentEntry),
        save: (_name, next) => { currentEntry = structuredClone(next); },
      });

      // 1. Switch Step 1 to Web2API Gemini -> Step 2 becomes API Key mode.
      await ui.invoke!('gateway', 'apply-preset', [{ name: 'draft', preset: 'gemini' }]);
      const authBefore = await ui.invoke!('auth', 'status', [{ name: 'draft' }]) as AuthPanelStatus;
      expect(authBefore.protocol).toBe('gemini');
      expect(authBefore.authEnabled).toBe(false);
      expect(authBefore.apiKeyConfigured).toBe(false);
      expect(provider.availability!('draft', currentEntry, 'zh').ready).toBe(false);

      // Save API Key with Bearer prefix directly in Step 2 (raw key never written to entry/config.json).
      const authSaved = await ui.invoke!('auth', 'save-api-key', [{
        name: 'draft',
        apiKey: 'AIzaTestSecretKey9876',
        credentialHeader: 'Authorization',
        credentialPrefix: 'Bearer ',
      }]) as AuthPanelStatus;
      expect(authSaved.apiKeyConfigured).toBe(true);
      expect(authSaved.apiKeySource).toBe('stored');
      expect(authSaved.apiKeyHint).toBe('AIza***9876');
      expect(authSaved.credentialHeader).toBe('Authorization');
      expect(authSaved.credentialPrefix).toBe('Bearer ');
      expect(JSON.stringify(currentEntry)).not.toContain('AIzaTestSecretKey9876');
      expect(provider.availability!('draft', currentEntry, 'zh').ready).toBe(true);

      // Verify runtime header injection preserves "Bearer " trailing space.
      const oauthDir = resolveOAuthDir(join(root, 'draft'), currentEntry);
      const headers = resolveHeaders(currentEntry, { secret: () => '' }, true, oauthDir);
      expect(headers.get('Authorization')).toBe('Bearer AIzaTestSecretKey9876');

      const testOk = await ui.invoke!('gateway', 'test', [{ name: 'draft' }]) as GatewayTestResult;
      expect(testOk.ok).toBe(true);

      // Save dedicated proxyUrl (shorthand port -> normalized URL), verify persistence across mode switches & clear.
      const withProxy = await ui.invoke!('gateway', 'save-options', [{
        name: 'draft',
        protocol: 'gemini',
        authMode: 'api-key',
        temporaryChat: true,
        proxyUrl: '7891',
      }]) as GatewayPanelState;
      expect(withProxy.proxyUrl).toBe('http://127.0.0.1:7891');
      const testWithProxy = await ui.invoke!('gateway', 'test', [{ name: 'draft' }]) as GatewayTestResult;
      expect(testWithProxy.ok).toBe(true);
      expect(testWithProxy.summary).toContain('http://127.0.0.1:7891');

      const switchedPreserveProxy = await ui.invoke!('gateway', 'apply-preset', [{ name: 'draft', preset: 'robin' }]) as GatewayPanelState;
      expect(switchedPreserveProxy.proxyUrl).toBe('http://127.0.0.1:7891');

      await expect(ui.invoke!('gateway', 'save-options', [{
        name: 'draft',
        protocol: 'robin',
        authMode: 'oauth',
        temporaryChat: true,
        proxyUrl: 'socks5://127.0.0.1:1080',
      }])).rejects.toThrow(/HTTP\/HTTPS/);

      const clearedProxy = await ui.invoke!('gateway', 'save-options', [{
        name: 'draft',
        protocol: 'gemini',
        authMode: 'api-key',
        temporaryChat: true,
        proxyUrl: '',
      }]) as GatewayPanelState;
      expect(clearedProxy.proxyUrl).toBe('');
      expect(testOk.summary).toContain('API Key');

      // 2. Switch Step 1 to Custom RPC -> Step 3 exposes custom routes editor.
      await ui.invoke!('gateway', 'apply-preset', [{ name: 'draft', preset: 'rpc' }]);
      const routesBefore = await ui.invoke!('quota', 'routes-state', [{ name: 'draft' }]) as CustomRoutesState;
      expect(routesBefore.protocol).toBe('rpc');
      expect(routesBefore.generationEndpoint).toBe('generate?$alt=json');

      const routesAfter = await ui.invoke!('quota', 'save-routes', [{
        name: 'draft',
        generationEndpoint: 'v2/chat',
        uploadEndpoint: 'v2/upload',
        deleteEndpoint: 'v2/sessions/{conversationId}',
        conversationHeader: 'x-session-id',
        quotaEndpoint: 'v2/quota',
      }]) as CustomRoutesState;
      expect(routesAfter.generationEndpoint).toBe('v2/chat');
      expect(routesAfter.uploadEndpoint).toBe('v2/upload');
      expect(routesAfter.deleteEndpoint).toBe('v2/sessions/{conversationId}');
      expect(routesAfter.conversationHeader).toBe('x-session-id');
      expect(routesAfter.quotaEndpoint).toBe('v2/quota');

      // 3. Clearing API key resets apiKeyConfigured & availability cleanly.
      const authCleared = await ui.invoke!('auth', 'clear-api-key', [{ name: 'draft' }]) as AuthPanelStatus;
      expect(authCleared.apiKeyConfigured).toBe(false);
      expect(provider.availability!('draft', currentEntry, 'zh').ready).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
