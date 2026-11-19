import { describe, expect, it, vi } from 'vitest';
import { parseQuotaResponse, queryGatewayQuota, robinPlanName } from '../src/quota.ts';

describe('gateway quota querying', () => {
  it('parses Robin GetUsageInfo GXU pools, userTier, and overage credits', () => {
    expect(robinPlanName('TIER_PRO')).toBe('Pro');
    expect(robinPlanName('TIER_ULTRA')).toBe('Ultra');
    expect(robinPlanName('TIER_LITE')).toBe('Plus');
    expect(robinPlanName('TIER_BASIC')).toBe('Free');

    const snapshot = parseQuotaResponse({
      userTier: 'TIER1',
      usage: [
        { budgetPoolType: 'GXU_WEEKLY', gxu: { pctUsed: 0.425, windowRefreshesAt: '2026-11-25T00:00:00Z', title: 'Weekly' } },
        { budgetPoolType: 'GXU_FIVE_HOURLY', gxu: { pctUsed: 0.15, windowRefreshesAt: '2026-11-19T08:00:00Z', title: '5-hour' } },
        { budgetPoolType: 'OVERAGE_CREDITS', credits: { creditsRemaining: '120', useOverageAiCredits: true } },
      ],
    }, 'https://robinfrontend-pa.googleapis.com/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo?$alt=json');

    expect(snapshot.supported).toBe(true);
    expect(snapshot.plan).toBe('Pro');
    expect(snapshot.userTier).toBe('TIER1');
    expect(snapshot.creditsRemaining).toBe(120);
    expect(snapshot.useOverageAiCredits).toBe(true);
    expect(snapshot.windows.map(w => ({ id: w.id, usedPercent: w.usedPercent, remainingPercent: w.remainingPercent }))).toEqual([
      { id: 'fiveHour', usedPercent: 15, remainingPercent: 85 },
      { id: 'weekly', usedPercent: 42.5, remainingPercent: 57.5 },
    ]);
  });

  it('retries 401 once with forced token refresh against GetUsageInfo', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({
        userTier: 'TIER_PRO',
        usage: [{ budgetPoolType: 'GXU_FIVE_HOURLY', gxu: { pctUsed: 0.2 } }],
      }));
    const accessToken = vi.fn(async (force?: boolean) => (force ? 'fresh-tok' : 'stale-tok'));
    const snap = await queryGatewayQuota({
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      protocol: 'robin',
      auth: { accessToken },
      fetch,
    });
    expect(snap.plan).toBe('Pro');
    expect(snap.windows[0]?.usedPercent).toBe(20);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toBe('https://robinfrontend-pa.googleapis.com/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo?$alt=json');
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer fresh-tok');
    expect(accessToken.mock.calls).toEqual([[false], [true]]);
  });

  it('returns unsupported cleanly for non-Robin protocols without a custom quotaEndpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const snap = await queryGatewayQuota({
      baseUrl: 'http://127.0.0.1:8080',
      protocol: 'gemini',
      fetch,
    });
    expect(snap.supported).toBe(false);
    expect(snap.windows).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces upstream Google 403 PERMISSION_DENIED reason and scope hint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({
      error: {
        code: 403,
        message: 'Permission denied on the service.',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'ACCESS_DENIED', metadata: { service: 'robinfrontend-pa.googleapis.com' } }],
      },
    }, { status: 403 }));
    await expect(queryGatewayQuota({
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      protocol: 'robin',
      quotaEndpoint: '/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo?$alt=json',
      fetch,
    })).rejects.toThrow(/HTTP 403.*PERMISSION_DENIED.*Scope/);
  });
});
