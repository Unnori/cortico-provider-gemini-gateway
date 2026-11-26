import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { describe, expect, it } from 'vitest';
import { GatewayControl } from '../src/control.ts';
import provider, {
  describeRobinDowngradeReason,
  describeRobinModeCategory,
} from '../src/index.ts';
import { OAUTH_ACCOUNTS_FILE, type DesktopOAuthConfig } from '../src/oauth.ts';
import { configuration } from '../src/options.ts';
import {
  frameGrpcMessage,
  lengthDelimited,
  ROBIN_GRPC_PROCESS_QUERY,
  stringField,
  varintField,
} from '../src/robin-grpc.ts';

const GOOGLE_TEST_CONFIG: DesktopOAuthConfig = {
  clientId: 'strict-routing-client.apps.googleusercontent.com',
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

function encodeRobinReply(
  text: string,
  opts: {
    attribution?: string;
    fallback?: number;
    downgradeReason?: number;
    resolvedModeCategory?: number;
    resolvedThinkingLevel?: number;
  } = {},
): Buffer {
  const model = Buffer.concat([stringField(1, 'r_1'), lengthDelimited(2, stringField(1, text))]);
  const parts: Buffer[] = [
    lengthDelimited(1, model),
    lengthDelimited(2, stringField(1, 'c_strict_1')),
    varintField(9, 1),
    stringField(30, opts.attribution ?? 'Used 4 Neon model'),
  ];
  if (opts.fallback !== undefined) parts.push(varintField(11, opts.fallback));
  if (opts.downgradeReason !== undefined) parts.push(varintField(31, opts.downgradeReason));
  if (opts.resolvedModeCategory !== undefined) parts.push(varintField(41, opts.resolvedModeCategory));
  if (opts.resolvedThinkingLevel !== undefined) parts.push(varintField(42, opts.resolvedThinkingLevel));
  return lengthDelimited(1003, lengthDelimited(1, Buffer.concat(parts)));
}

async function createRobinPoolFixture(
  replyForToken: (token: string, callIndex: number) => Buffer,
  entryOptions: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ggw-strict-routing-'));
  const seenTokens: string[] = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const auth = String(headers.authorization ?? '');
    const token = auth.replace(/^Bearer\s+/i, '');
    stream.resume();
    stream.on('end', () => {
      if (headers[':path'] === ROBIN_GRPC_PROCESS_QUERY) {
        seenTokens.push(token);
        const payload = replyForToken(token, seenTokens.length);
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.write(frameGrpcMessage(payload));
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
        return;
      }
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const oauthDir = dir;
  const seedCtrl = new GatewayControl(oauthDir);
  seedCtrl.saveOAuthConfig(JSON.stringify(GOOGLE_TEST_CONFIG));
  writeFileSync(join(oauthDir, OAUTH_ACCOUNTS_FILE), JSON.stringify({
    version: 2,
    profile: testProfileHash(GOOGLE_TEST_CONFIG),
    primaryId: 'acct_A',
    accounts: [
      { id: 'acct_A', email: 'a@example.com', accessToken: 'tok-A', refreshToken: 'r-A', expiresAt: Date.now() + 3_600_000 },
      { id: 'acct_B', email: 'b@example.com', accessToken: 'tok-B', refreshToken: 'r-B', expiresAt: Date.now() + 3_600_000 },
    ],
  }));

  const entry: LLMProviderEntry = {
    kind: 'gemini-gateway',
    baseUrl: `http://127.0.0.1:${port}`,
    spec: { model: 'gemini-4-neon', thinking: true, reasoningEffort: 'low' },
    options: {
      protocol: 'robin',
      authMode: 'oauth',
      accountRouting: 'failover',
      generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
      ...entryOptions,
    },
  };

  const instance = provider.create('gemini-gateway', entry, {
    stateDir: dir,
    log: nullLogger(),
    secret: () => '',
    readBlob: () => null,
    keepThinking: () => true,
    currentEntry: () => entry,
  });

  return {
    seenTokens,
    instance,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('Robin downgrade cooldown preservation, strictModelRouting, and routing telemetry', () => {
  it('formats known and unknown Robin downgrade reasons and mode categories', () => {
    expect(describeRobinDowngradeReason(2)).toContain('code 2');
    expect(describeRobinDowngradeReason(3)).toContain('code 3');
    expect(describeRobinDowngradeReason(6)).toContain('code 6');
    expect(describeRobinDowngradeReason(8)).toContain('code 8');
    expect(describeRobinDowngradeReason(99)).toBe('code 99');
    expect(describeRobinDowngradeReason(undefined)).toBe('unknown');

    expect(describeRobinModeCategory(1)).toBe('FAST');
    expect(describeRobinModeCategory(3)).toBe('PRO');
    expect(describeRobinModeCategory(6)).toBe('FLASH-LITE');
    expect(describeRobinModeCategory(8)).toBe('ULTRA');
    expect(describeRobinModeCategory(42)).toBe('code 42');
    expect(describeRobinModeCategory(undefined)).toBe('unknown');
  });

  it('parses strictModelRouting option (default false) and exposes it in config schema', () => {
    const baseEntry: LLMProviderEntry = {
      kind: 'gemini-gateway',
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      options: { protocol: 'robin' },
    };
    expect(configuration(baseEntry).strictModelRouting).toBe(false);
    expect(configuration({
      ...baseEntry,
      options: { ...baseEntry.options, strictModelRouting: true },
    }).strictModelRouting).toBe(true);

    const groups = provider.config('gemini-gateway', baseEntry, 'en');
    const props = groups[0]?.schema?.properties as Record<string, unknown> | undefined;
    expect(props).toHaveProperty('providers.gemini-gateway.options.strictModelRouting');
  });

  it('preserves built-in quota downgrade cooldown across onAccountSuccess and attaches routing telemetry to meters.native', async () => {
    const fixture = await createRobinPoolFixture(token => {
      if (token === 'tok-A') {
        return encodeRobinReply('downgraded from A', {
          attribution: 'Used auto model selection',
          downgradeReason: 6,
          resolvedModeCategory: 6,
          resolvedThinkingLevel: 1,
        });
      }
      return encodeRobinReply('pro from B', {
        attribution: 'Used 4 Neon High model',
        resolvedModeCategory: 3,
        resolvedThinkingLevel: 2,
      });
    });

    try {
      const req = {
        model: 'gemini-4-neon',
        input: [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text: 'hi' }] }],
        thinking: true,
        reasoningEffort: 'low' as const,
      };
      const opts = {
        origin: { instance: 'gemini-gateway', module: 'gemini-gateway', model: 'gemini-4-neon', compatibilityDomain: 'test' },
      };

      // Turn 1 hits primary acct_A and receives quota downgrade code 6.
      const g1 = await fixture.instance.client.respond(req, opts);
      expect(fixture.seenTokens).toEqual(['tok-A']);
      expect(g1.attempts.at(-1)?.meters.native).toMatchObject({
        accountId: 'acct_A',
        downgraded: true,
        requestedModeCategory: 3,
        resolvedModeCategory: 6,
        downgradeReason: 6,
        resolvedModeLabel: 'FLASH-LITE',
        downgradeReasonLabel: 'auto-routing / quota-or-tier-fallback (code 6)',
      });

      // Because onAccountSuccess no longer wipes downgrade cooldown, Turn 2 fails over to acct_B.
      const g2 = await fixture.instance.client.respond(req, opts);
      expect(fixture.seenTokens).toEqual(['tok-A', 'tok-B']);
      expect(g2.attempts.at(-1)?.meters.native).toMatchObject({
        accountId: 'acct_B',
        downgraded: false,
        requestedModeCategory: 3,
        resolvedModeCategory: 3,
        resolvedModeLabel: 'PRO',
      });
    } finally {
      await fixture.close();
    }
  });

  it('cools down non-quota Robin fallbacks when strictModelRouting is enabled and records telemetry even with estimateRobinTokens=false', async () => {
    const replyNonQuotaFallback = (token: string) => {
      if (token === 'tok-A') {
        return encodeRobinReply('fallback from A', {
          attribution: 'Used auto model selection',
          fallback: 1,
          resolvedModeCategory: 6,
        });
      }
      return encodeRobinReply('pro from B', {
        attribution: 'Used 4 Neon model',
        resolvedModeCategory: 3,
      });
    };

    const req = {
      model: 'gemini-4-neon',
      input: [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text: 'hi' }] }],
    };
    const opts = {
      origin: { instance: 'gemini-gateway', module: 'gemini-gateway', model: 'gemini-4-neon', compatibilityDomain: 'test' },
    };

    // With strictModelRouting disabled, non-quota fallback does not trigger cooldown.
    const relaxed = await createRobinPoolFixture(replyNonQuotaFallback, {
      strictModelRouting: false,
      estimateRobinTokens: false,
    });
    try {
      const g1 = await relaxed.instance.client.respond(req, opts);
      expect(g1.attempts.at(-1)?.meters.native).toMatchObject({
        accountId: 'acct_A',
        downgraded: true,
        resolvedModeLabel: 'FLASH-LITE',
      });
      await relaxed.instance.client.respond(req, opts);
      expect(relaxed.seenTokens).toEqual(['tok-A', 'tok-A']);
    } finally {
      await relaxed.close();
    }

    // With strictModelRouting enabled, non-quota fallback cools down acct_A so Turn 2 fails over to acct_B.
    const strict = await createRobinPoolFixture(replyNonQuotaFallback, {
      strictModelRouting: true,
      estimateRobinTokens: false,
    });
    try {
      await strict.instance.client.respond(req, opts);
      await strict.instance.client.respond(req, opts);
      expect(strict.seenTokens).toEqual(['tok-A', 'tok-B']);
    } finally {
      await strict.close();
    }
  });
});
