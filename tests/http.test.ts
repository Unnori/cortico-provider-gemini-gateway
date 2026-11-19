import http from 'node:http';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProxyFetch,
  maskProxyDisplay,
  matchesNoProxy,
  normalizeProxyUrl,
  parseProxyUrlInput,
  parseWindowsProxyServer,
  proxyForUrl,
  resetProxyCache,
  resolveProxyConfig,
} from '../src/http.ts';

describe('proxy resolution and transport', () => {
  afterEach(() => {
    resetProxyCache();
  });

  it('normalizes proxy URLs and parses Windows ProxyServer strings', () => {
    expect(normalizeProxyUrl('127.0.0.1:7897')).toBe('http://127.0.0.1:7897/');
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toBeUndefined();
    expect(parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891')).toEqual({
      httpProxy: 'http://127.0.0.1:7890/',
      httpsProxy: 'http://127.0.0.1:7891/',
    });
    expect(parseWindowsProxyServer('127.0.0.1:7897')).toEqual({
      httpProxy: 'http://127.0.0.1:7897/',
      httpsProxy: 'http://127.0.0.1:7897/',
    });
  });

  it('prefers env proxy over system proxy and honors NO_PROXY and loopback bypass', () => {
    const readSystemProxy = vi.fn(() => ({ httpProxy: 'http://127.0.0.1:8888/', httpsProxy: 'http://127.0.0.1:8888/' }));
    const fromEnv = resolveProxyConfig({ HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: '.internal.local,<local>' }, 'win32', readSystemProxy);
    expect(readSystemProxy).not.toHaveBeenCalled();
    expect(proxyForUrl(new URL('https://www.googleapis.com/oauth2/v4/token'), fromEnv)).toBe('http://127.0.0.1:7897/');
    expect(proxyForUrl(new URL('https://api.internal.local/v1'), fromEnv)).toBeUndefined();
    expect(proxyForUrl(new URL('http://intranet/status'), fromEnv)).toBeUndefined();
    expect(proxyForUrl(new URL('http://127.0.0.1:8080/health'), fromEnv)).toBeUndefined();
    expect(proxyForUrl(new URL('http://localhost:3000/cb'), fromEnv)).toBeUndefined();
    expect(matchesNoProxy(new URL('https://example.com:8443/'), 'example.com:8443')).toBe(true);
    expect(matchesNoProxy(new URL('https://example.com:443/'), 'example.com:8443')).toBe(false);

    const fromSys = resolveProxyConfig({}, 'win32', readSystemProxy);
    expect(readSystemProxy).toHaveBeenCalledTimes(1);
    expect(proxyForUrl(new URL('https://www.googleapis.com/'), fromSys)).toBe('http://127.0.0.1:8888/');
  });

  it('delegates to fallback fetch when host proxy is already active or target bypasses proxy', async () => {
    const fallback = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const withFlag = createProxyFetch({
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
      execArgv: ['--use-env-proxy'],
      fallbackFetch: fallback,
    });
    await withFlag('https://www.googleapis.com/test');
    expect(fallback).toHaveBeenCalledTimes(1);

    const withNoProxy = createProxyFetch({
      env: { HTTP_PROXY: 'http://127.0.0.1:7897' },
      execArgv: [],
      fallbackFetch: fallback,
    });
    await withNoProxy('http://127.0.0.1:9999/local');
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('routes requests through a local HTTP proxy, decompresses gzip, enforces redirect:error, and supports aborts', async () => {
    const received: { method?: string; url?: string; body?: string; connectAuthority?: string; proxyAuth?: string }[] = [];
    const proxyServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        received.push({ method: req.method, url: req.url, body });
        if (req.url?.endsWith('/redirect')) {
          res.writeHead(302, { Location: 'http://gateway.example.test/final' });
          res.end();
          return;
        }
        if (req.url?.endsWith('/final')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ redirected: true }));
          return;
        }
        if (req.url?.endsWith('/slow')) {
          // Hold open until client aborts.
          return;
        }
        const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ echoed: body })));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        res.end(payload);
      });
    });
    proxyServer.on('connect', (req, socket) => {
      received.push({
        method: 'CONNECT',
        connectAuthority: req.url,
        proxyAuth: req.headers['proxy-authorization'],
      });
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    });

    await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const addr = proxyServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const proxyUrl = `http://user:pass@127.0.0.1:${addr.port}`;

    try {
      const proxyFetch = createProxyFetch({
        env: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl },
        execArgv: [],
        platform: 'linux',
        fallbackFetch: vi.fn<typeof fetch>(),
      });

      const res = await proxyFetch('http://gateway.example.test/token', {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ echoed: 'grant_type=authorization_code&code=abc' });
      expect(received[0]).toMatchObject({ method: 'POST', url: 'http://gateway.example.test/token' });

      await expect(proxyFetch('http://gateway.example.test/redirect', { redirect: 'error' })).rejects.toThrow('Failed to fetch');
      const followed = await proxyFetch('http://gateway.example.test/redirect');
      expect(await followed.json()).toEqual({ redirected: true });

      const aborted = proxyFetch('http://gateway.example.test/slow', { signal: AbortSignal.timeout(50) });
      await expect(aborted).rejects.toThrow();

      await expect(proxyFetch('https://www.googleapis.com/oauth2/v4/token')).rejects.toThrow('Proxy CONNECT returned HTTP 502');
      expect(received.at(-1)).toEqual({
        method: 'CONNECT',
        connectAuthority: 'www.googleapis.com:443',
        proxyAuth: `Basic ${Buffer.from('user:pass').toString('base64')}`,
      });

      // Explicit per-provider proxyUrl overrides host proxy flags (--use-env-proxy / COOPANION_SYSTEM_PROXY=1).
      expect(parseProxyUrlInput('')).toBeUndefined();
      expect(parseProxyUrlInput('7890')).toBe('http://127.0.0.1:7890');
      expect(parseProxyUrlInput(':10809')).toBe('http://127.0.0.1:10809');
      expect(parseProxyUrlInput('127.0.0.1:7891')).toBe('http://127.0.0.1:7891');
      expect(parseProxyUrlInput('http://user:pass@127.0.0.1:7891/')).toBe('http://user:pass@127.0.0.1:7891');
      expect(maskProxyDisplay('http://user:pass@127.0.0.1:7891')).toBe('http://127.0.0.1:7891');
      expect(() => parseProxyUrlInput('socks5://127.0.0.1:1080')).toThrow(/HTTP\/HTTPS/);
      expect(() => parseProxyUrlInput('99999')).toThrow(/格式无效/);

      const fallback = vi.fn<typeof fetch>(async () => Response.json({ fallback: true }));
      const explicitFetch = createProxyFetch({
        proxyUrl,
        env: { COOPANION_SYSTEM_PROXY: '1' },
        execArgv: ['--use-env-proxy'],
        fallbackFetch: fallback,
      });
      const overrideRes = await explicitFetch('http://gateway.example.test/override', { method: 'GET' });
      expect(overrideRes.status).toBe(200);
      expect(fallback).not.toHaveBeenCalled();
      // Loopback targets still bypass even when explicit proxyUrl is configured.
      await explicitFetch('http://127.0.0.1:9999/local');
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>(resolve => proxyServer.close(() => resolve()));
    }
  });
});
