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
import type { AuthPanelStatus, CustomRoutesState, GatewayPanelState, GatewayTestResult, QuotaAccountLabels } from '../src/webui/server.ts';
import { resolveHeaders } from '../src/options.ts';
import { GatewayControl, resolveOAuthDir } from '../src/control.ts';

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
      expect(authStatus.quotaBarMode).toBe('remaining');
      expect(authStatus.email).toBe('r***r@example.com');

      // 3. Query quota right in the panel via native HTTP/2 gRPC.
      const quota = await ui.invoke!('quota', 'query', [{ name: 'draft' }]) as QuotaSnapshot;
      expect(quota.supported).toBe(true);
      expect(quota.authRequired).toBeUndefined();
      expect(quota.plan).toBe('Pro');
      expect(quota.quotaBarMode).toBe('remaining');
      expect(quota.windows.map(w => w.usedPercent)).toEqual([25, 10]);

      // 3a. Quota bar display mode defaults to remaining, toggles cleanly, and persists to disk.
      const usedLabels = await ui.invoke!('quota', 'set-bar-mode', [{ name: 'draft', mode: 'used' }]) as QuotaAccountLabels;
      expect(usedLabels.quotaBarMode).toBe('used');
      const statusAfterToggle = await ui.invoke!('auth', 'status', [{ name: 'draft' }]) as AuthPanelStatus;
      expect(statusAfterToggle.quotaBarMode).toBe('used');
      const reloadedControl = new GatewayControl(resolveOAuthDir(join(root, 'draft'), currentEntry));
      expect(reloadedControl.getQuotaBarMode()).toBe('used');
      const remainingLabels = await ui.invoke!('quota', 'set-bar-mode', [{ name: 'draft', mode: 'remaining' }]) as QuotaAccountLabels;
      expect(remainingLabels.quotaBarMode).toBe('remaining');
      await expect(ui.invoke!('quota', 'set-bar-mode', [{ name: 'draft', mode: 'invalid' }])).rejects.toThrow();

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
      const quoteDefs = provider.prices!(currentEntry, { model: 'gemini-4-hydrogen' });
      const generation = await savedInstance.client.respond(
        { model: 'gemini-4-hydrogen', input: '9 * 7 = ?' },
        {
          quote: ({ startedAt }) => quoteDefs.map((def, idx) => ({
            id: `q_${idx}`,
            currency: def.currency,
            basis: def.basis,
            rules: def.rules,
            source: def.source ?? 'test',
            capturedAt: startedAt,
          })),
        },
      );
      expect(generation.response.status).toBe('completed');
      expect(JSON.stringify(generation.response.output)).toContain('63');
      // Robin local token estimation is enabled by default so input/output tokens and spend estimates count cleanly (cache hits = 0).
      const estMeters = generation.attempts[0].meters;
      expect(estMeters.input).toBeGreaterThan(0);
      expect(estMeters.output).toBeGreaterThan(0);
      expect(estMeters.cachedInput).toBe(0);
      expect(estMeters.uncachedInput).toBe(estMeters.input);
      expect(estMeters.native).toMatchObject({ estimated: true, source: 'robin-local-estimate' });
      expect(generation.attempts[0].charges[0]?.amount).toBeGreaterThan(0);
      expect(generation.attempts[0].charges[0]?.missing).toEqual([]);

      // Disabling the pricing-estimate checkbox restores null meters on subsequent calls.
      const disabledEst = await ui.invoke!('model-settings', 'pricing-estimate', [{
        name: 'my-robin',
        enabled: false,
      }]) as { estimateRobinTokens: boolean | null };
      expect(disabledEst.estimateRobinTokens).toBe(false);
      const savedWithoutEst = makeInstance('my-robin', currentEntry);
      const genNoEst = await savedWithoutEst.client.respond({
        model: 'gemini-4-hydrogen',
        input: '9 * 7 = ?',
      });
      expect(genNoEst.attempts[0].meters.input).toBeNull();
      expect(genNoEst.attempts[0].meters.output).toBeNull();
      expect(genNoEst.attempts[0].meters.cachedInput).toBeNull();

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

  it('supports Official Gemini API preset with live /v1beta/models test, model listing, x-goog-api-key, and thoughtSignature replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gemini-webui-official-'));
    const seenBodies: Record<string, unknown>[] = [];
    const seenHeaders: Headers[] = [];
    let streamTurn = 0;

    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const hdrs = new Headers(init?.headers);
      if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?')) {
        seenHeaders.push(hdrs);
        if (hdrs.get('x-goog-api-key') !== 'AIzaSyOfficialLiveKey9999') {
          return Response.json({ error: { code: 400, message: 'API key not valid.' } }, { status: 400 });
        }
        return Response.json({
          models: [
            {
              name: 'models/gemini-3-flash',
              displayName: 'Gemini 3 Flash',
              inputTokenLimit: 1_048_576,
              outputTokenLimit: 65_536,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              inputTokenLimit: 1_048_576,
              outputTokenLimit: 65_536,
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/text-embedding-004',
              displayName: 'Text Embedding',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        });
      }
      if (url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse') {
        seenHeaders.push(hdrs);
        seenBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        streamTurn += 1;
        const sse = streamTurn === 1
          ? [
              `data: ${JSON.stringify({
                candidates: [{
                  content: {
                    role: 'model',
                    parts: [{
                      functionCall: { name: 'lookup_weather', args: { city: 'Tokyo' } },
                      thoughtSignature: 'sig_official_turn1_xyz',
                    }],
                  },
                  finishReason: 'STOP',
                }],
                responseId: 'resp_off_1',
                modelVersion: 'gemini-3-flash',
              })}`,
              '',
            ].join('\n\n')
          : [
              `data: ${JSON.stringify({
                candidates: [{
                  content: {
                    role: 'model',
                    parts: [{ text: 'Tokyo is 22C. Example literal tag: <tool_call>{"name":"noop","args":{}}</tool_call>' }],
                  },
                  finishReason: 'STOP',
                }],
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25, totalTokenCount: 125 },
                responseId: 'resp_off_2',
                modelVersion: 'gemini-3-flash',
              })}`,
              '',
            ].join('\n\n');
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.includes('models.dev') || url.includes('openrouter.ai')) {
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      let currentEntry: LLMProviderEntry = {
        kind: provider.id,
        baseUrl: provider.defaultBaseUrl,
        spec: { model: 'gemini-3-flash', thinking: true, reasoningEffort: 'high' },
        options: {
          protocol: 'gemini',
          authMode: 'api-key',
          credentialHeader: 'Authorization',
          credentialPrefix: 'Bearer ',
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
        editing: true,
        entries: () => [{ name: 'official-test', entry: currentEntry }],
        instance: name => makeInstance(name, currentEntry),
        save: (_name, next) => { currentEntry = structuredClone(next); },
      });

      // 1. Applying 'official' preset points directly to generativelanguage.googleapis.com, disables temporary_chat,
      //    and clears leftover self-hosted Authorization: Bearer header overrides.
      const gw = await ui.invoke!('gateway', 'apply-preset', [{ name: 'official-test', preset: 'official' }]) as GatewayPanelState;
      expect(gw.protocol).toBe('gemini');
      expect(gw.isOfficialGemini).toBe(true);
      expect(gw.baseUrl).toBe('https://generativelanguage.googleapis.com');
      expect(gw.authMode).toBe('api-key');
      expect(gw.temporaryChat).toBe(false);
      expect(currentEntry.options?.credentialHeader).toBeUndefined();
      expect(currentEntry.options?.credentialPrefix).toBeUndefined();

      // Test before entering API key guides user to Step 2.
      const testNoKey = await ui.invoke!('gateway', 'test', [{ name: 'official-test' }]) as GatewayTestResult;
      expect(testNoKey.ok).toBe(false);

      // 2. Save official Gemini API Key and run live connection test + official model listing.
      const authStatus = await ui.invoke!('auth', 'save-api-key', [{
        name: 'official-test',
        apiKey: 'AIzaSyOfficialLiveKey9999',
      }]) as AuthPanelStatus;
      expect(authStatus.isOfficialGemini).toBe(true);
      expect(authStatus.apiKeyConfigured).toBe(true);
      expect(authStatus.credentialHeader).toBe('x-goog-api-key');

      const testOk = await ui.invoke!('gateway', 'test', [{ name: 'official-test' }]) as GatewayTestResult;
      expect(testOk.ok).toBe(true);
      expect(testOk.summary).toContain('官方 Gemini API');
      expect(testOk.summary).toContain('2 个模型可用');

      const inst = makeInstance('official-test', currentEntry);
      const listed = await inst.listModels!();
      expect(listed.map(m => m.id)).toEqual(['gemini-3-flash', 'gemini-2.5-pro']);

      // 3. Multi-turn tool calling: Turn 1 has synthetic external_event_frame (gets skip_thought_signature_validator);
      //    Turn 2 replays real thoughtSignature cached from Turn 1 and preserves literal <tool_call> text safely.
      const turn1 = await inst.client.respond({
        model: 'gemini-3-flash',
        reasoning: { effort: 'high' },
        tools: [{ type: 'function', name: 'lookup_weather', description: 'Get weather', parameters: { type: 'object' } }],
        input: [
          { type: 'function_call', call_id: 'evf_1', name: 'external_event_frame', arguments: '{}' },
          { type: 'function_call_output', call_id: 'evf_1', output: 'What is the weather in Tokyo?' },
        ],
      });
      expect(turn1.response.status).toBe('completed');
      const emittedCall = turn1.response.output.find(i => i.type === 'function_call');
      expect(emittedCall?.type).toBe('function_call');
      const turn1CallId = emittedCall && emittedCall.type === 'function_call' ? emittedCall.call_id : '';
      expect(turn1CallId).toBeTruthy();

      expect('temporary_chat' in seenBodies[0]).toBe(false);
      expect(seenBodies[0].generationConfig).toEqual({
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
      });
      const turn1Contents = seenBodies[0].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      expect(turn1Contents[0].parts[0]).toEqual({
        functionCall: { name: 'external_event_frame', args: {} },
        thoughtSignature: 'skip_thought_signature_validator',
      });
      expect(turn1Contents[1].parts[0]).toEqual({
        functionResponse: { name: 'external_event_frame', response: { output: 'What is the weather in Tokyo?' } },
      });

      const turn2 = await inst.client.respond({
        model: 'gemini-3-flash',
        reasoning: { effort: 'high' },
        tools: [{ type: 'function', name: 'lookup_weather', description: 'Get weather', parameters: { type: 'object' } }],
        input: [
          { type: 'function_call', call_id: 'evf_1', name: 'external_event_frame', arguments: '{}' },
          { type: 'function_call_output', call_id: 'evf_1', output: 'What is the weather in Tokyo?' },
          { type: 'function_call', call_id: turn1CallId, name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
          { type: 'function_call_output', call_id: turn1CallId, output: '22C sunny' },
        ],
      });
      expect(turn2.response.status).toBe('completed');
      // Cached real thoughtSignature from Turn 1 is replayed on Turn 2!
      const turn2Contents = seenBodies[1].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      expect(turn2Contents[2].parts[0]).toEqual({
        functionCall: { name: 'lookup_weather', args: { city: 'Tokyo' } },
        thoughtSignature: 'sig_official_turn1_xyz',
      });
      // Prose mentioning <tool_call> is NOT turned into a synthetic function call on official API.
      expect(turn2.response.output.some(i => i.type === 'function_call')).toBe(false);
      expect(JSON.stringify(turn2.response.output)).toContain('<tool_call>');
      expect(seenHeaders.every(h => h.get('x-goog-api-key') === 'AIzaSyOfficialLiveKey9999')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
