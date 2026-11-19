import { execFileSync } from 'node:child_process';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { PassThrough, Readable, pipeline } from 'node:stream';
import tls from 'node:tls';
import zlib from 'node:zlib';

const NATIVE_FETCH = globalThis.fetch;
const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[?::1\]?)$/i;
const WINDOWS_PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const REGISTRY_CACHE_MS = 60_000;
const MAX_REDIRECTS = 5;

export interface ProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
}

export interface ProxyFetchOptions {
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  platform?: NodeJS.Platform;
  proxyUrl?: string;
  fallbackFetch?: typeof fetch;
  readSystemProxy?: () => ProxyConfig | undefined;
}

let registryCache: { at: number; config: ProxyConfig | undefined } | undefined;

export function resetProxyCache(): void {
  registryCache = undefined;
}

export function normalizeProxyUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const portMatch = /^:?(\d{1,5})$/.exec(trimmed);
  if (portMatch) {
    const port = Number(portMatch[1]);
    if (port < 1 || port > 65535) return undefined;
    return `http://127.0.0.1:${port}/`;
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return undefined;
    if (url.port) {
      const p = Number(url.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseProxyUrlInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (schemeMatch && !['http', 'https'].includes(schemeMatch[1].toLowerCase())) {
    throw new Error('代理地址仅支持 HTTP/HTTPS 代理（例如 http://127.0.0.1:7890 或直接填端口 7890）；使用 Clash/v2rayN 请填写混合/HTTP 端口。');
  }
  const normalized = normalizeProxyUrl(trimmed);
  if (!normalized) {
    throw new Error('代理地址格式无效，请输入 http://127.0.0.1:7890、127.0.0.1:7890 或纯端口号（如 7890）。');
  }
  const parsed = new URL(normalized);
  return parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.href.slice(0, -1) : parsed.href;
}

export function maskProxyDisplay(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    if (!parsed.username && !parsed.password) return proxyUrl;
    parsed.username = '';
    parsed.password = '';
    return parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.href.slice(0, -1) : parsed.href;
  } catch {
    return proxyUrl;
  }
}

export function parseWindowsProxyServer(server: string): Pick<ProxyConfig, 'httpProxy' | 'httpsProxy'> {
  const parts = server.split(';').map(item => item.trim()).filter(Boolean);
  let httpProxy: string | undefined;
  let httpsProxy: string | undefined;
  let plainProxy: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      plainProxy ??= normalizeProxyUrl(part);
      continue;
    }
    const scheme = part.slice(0, eq).trim().toLowerCase();
    const addr = normalizeProxyUrl(part.slice(eq + 1));
    if (!addr) continue;
    if (scheme === 'http') httpProxy ??= addr;
    else if (scheme === 'https') httpsProxy ??= addr;
  }
  return {
    httpProxy: httpProxy ?? plainProxy,
    httpsProxy: httpsProxy ?? httpProxy ?? plainProxy,
  };
}

function readWindowsRegistryProxy(): ProxyConfig | undefined {
  const now = Date.now();
  if (registryCache && now - registryCache.at < REGISTRY_CACHE_MS) return registryCache.config;
  let config: ProxyConfig | undefined;
  try {
    const output = execFileSync('reg', ['query', WINDOWS_PROXY_KEY], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) {
      const server = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim() ?? '';
      const override = /ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim() ?? '';
      const parsed = server ? parseWindowsProxyServer(server) : {};
      if (parsed.httpProxy || parsed.httpsProxy) {
        config = { ...parsed, noProxy: override };
      }
    }
  } catch {
    config = undefined;
  }
  registryCache = { at: now, config };
  return config;
}

export function resolveProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readSystemProxy: () => ProxyConfig | undefined = readWindowsRegistryProxy,
): ProxyConfig | undefined {
  const httpsProxy = normalizeProxyUrl(env.HTTPS_PROXY ?? env.https_proxy ?? '');
  const httpProxy = normalizeProxyUrl(env.HTTP_PROXY ?? env.http_proxy ?? '');
  const allProxy = normalizeProxyUrl(env.ALL_PROXY ?? env.all_proxy ?? '');
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? '';
  if (httpsProxy || httpProxy || allProxy) {
    return { httpProxy, httpsProxy, allProxy, noProxy };
  }
  if (platform === 'win32') return readSystemProxy();
  return undefined;
}

export function matchesNoProxy(target: URL, noProxy = ''): boolean {
  const host = target.hostname.toLowerCase();
  if (LOOPBACK.test(host)) return true;
  if (!noProxy.trim()) return false;
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const rawEntry of noProxy.split(/[,;]/)) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    if (entry === '<local>') {
      if (!host.includes('.')) return true;
      continue;
    }
    const colon = entry.lastIndexOf(':');
    const hasPort = colon > 0 && !entry.endsWith(']') && /^\d+$/.test(entry.slice(colon + 1));
    const entryHost = (hasPort ? entry.slice(0, colon) : entry).replace(/^\*\./, '.');
    const entryPort = hasPort ? entry.slice(colon + 1) : undefined;
    if (entryPort && entryPort !== port) continue;
    if (entryHost.startsWith('.')) {
      if (host === entryHost.slice(1) || host.endsWith(entryHost)) return true;
    } else if (host === entryHost || host.endsWith(`.${entryHost}`)) {
      return true;
    }
  }
  return false;
}

export function proxyForUrl(target: URL, config: ProxyConfig | undefined): string | undefined {
  if (!config || matchesNoProxy(target, config.noProxy)) return undefined;
  if (target.protocol === 'https:') return config.httpsProxy ?? config.allProxy ?? config.httpProxy;
  if (target.protocol === 'http:') return config.httpProxy ?? config.allProxy;
  return undefined;
}

function hasHostProxy(env: NodeJS.ProcessEnv, execArgv: readonly string[]): boolean {
  return execArgv.includes('--use-env-proxy')
    || env.NODE_USE_ENV_PROXY === '1'
    || env.COOPANION_SYSTEM_PROXY === '1';
}

function proxyAuthHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

class TunnelAgent extends https.Agent {
  private readonly proxy: URL;

  constructor(proxyUrl: string) {
    super({ keepAlive: false });
    this.proxy = new URL(proxyUrl);
  }

  override createConnection(
    options: https.RequestOptions & { servername?: string },
    callback: (error: Error | null, socket?: Duplex) => void,
  ): undefined {
    const targetHost = String(options.hostname || options.host || '');
    const targetPort = Number(options.port) || 443;
    const authority = targetHost.includes(':') && !targetHost.startsWith('[')
      ? `[${targetHost}]:${targetPort}`
      : `${targetHost}:${targetPort}`;
    const proxyPort = Number(this.proxy.port) || (this.proxy.protocol === 'https:' ? 443 : 80);
    const proxyHeaders: Record<string, string> = { Host: authority };
    const auth = proxyAuthHeader(this.proxy);
    if (auth) proxyHeaders['Proxy-Authorization'] = auth;

    const transport = this.proxy.protocol === 'https:' ? https : http;
    const connectReq = transport.request({
      host: this.proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: proxyHeaders,
      agent: false,
    });

    connectReq.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`Proxy CONNECT returned HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || targetHost,
      });
      const onError = (err: Error) => {
        tlsSocket.removeListener('secureConnect', onSecure);
        callback(err);
      };
      const onSecure = () => {
        tlsSocket.removeListener('error', onError);
        callback(null, tlsSocket);
      };
      tlsSocket.once('error', onError);
      tlsSocket.once('secureConnect', onSecure);
    });

    connectReq.once('error', err => callback(err));
    connectReq.end();
    return undefined;
  }
}

function decodeBody(res: http.IncomingMessage, headers: Headers): Readable {
  const encoding = (res.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (!encoding || encoding === 'identity') return res;
  const decoders = [];
  for (const coding of encoding.split(',').map(item => item.trim()).filter(Boolean).reverse()) {
    if (coding === 'gzip' || coding === 'x-gzip') decoders.push(zlib.createGunzip());
    else if (coding === 'deflate') decoders.push(zlib.createInflate());
    else if (coding === 'br') decoders.push(zlib.createBrotliDecompress());
    else if (coding === 'zstd' && typeof zlib.createZstdDecompress === 'function') decoders.push(zlib.createZstdDecompress());
    else return res;
  }
  headers.delete('content-encoding');
  headers.delete('content-length');
  const output = new PassThrough();
  pipeline([res, ...decoders, output], err => {
    if (err && !output.destroyed) output.destroy(err);
  });
  return output;
}

type FetchInput = Parameters<typeof fetch>[0];
type RedirectMode = NonNullable<RequestInit['redirect']>;

async function sendSingleProxyRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  redirect: RedirectMode,
  signal: AbortSignal,
  proxyUrl: string,
): Promise<{ response: Response; location?: string }> {
  signal.throwIfAborted();
  const proxy = new URL(proxyUrl);
  const isHttps = url.protocol === 'https:';
  const agent = isHttps ? new TunnelAgent(proxyUrl) : undefined;
  const reqHeaders = { ...headers };
  if (body && !Object.keys(reqHeaders).some(key => key.toLowerCase() === 'content-length')) {
    reqHeaders['content-length'] = String(body.byteLength);
  }
  if (!isHttps) {
    const auth = proxyAuthHeader(proxy);
    if (auth && !Object.keys(reqHeaders).some(key => key.toLowerCase() === 'proxy-authorization')) {
      reqHeaders['proxy-authorization'] = auth;
    }
    if (!Object.keys(reqHeaders).some(key => key.toLowerCase() === 'host')) {
      reqHeaders.host = url.host;
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeRes: http.IncomingMessage | undefined;
    let bodyStream: Readable | undefined;
    const finishCleanup = () => {
      signal.removeEventListener('abort', onAbort);
      agent?.destroy();
    };
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        finishCleanup();
        reject(error);
      }
    };
    const onAbort = () => {
      const reason = signal.reason;
      const err = reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));
      clientReq.destroy(err);
      activeRes?.destroy(err);
      bodyStream?.destroy(err);
      finishCleanup();
      if (!settled) {
        settled = true;
        reject(reason);
      }
    };

    const requestOptions: http.RequestOptions = isHttps
      ? { method, headers: reqHeaders, agent }
      : {
          host: proxy.hostname,
          port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
          method,
          path: url.href,
          headers: reqHeaders,
          agent: false,
        };
    const transport = isHttps ? https : proxy.protocol === 'https:' ? https : http;
    const target = isHttps ? url : requestOptions;

    const handleResponse = (res: http.IncomingMessage) => {
      activeRes = res;
      if (settled) {
        res.destroy();
        return;
      }
      const status = res.statusCode ?? 500;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, value);
        }
      }
      const location = responseHeaders.get('location') ?? undefined;
      if (status >= 300 && status < 400 && location) {
        if (redirect === 'error') {
          res.destroy();
          fail(new TypeError('Failed to fetch', { cause: new Error(`Unexpected redirect (HTTP ${status})`) }));
          return;
        }
        if (redirect === 'follow') {
          res.resume();
          res.once('end', finishCleanup);
          res.once('close', finishCleanup);
          settled = true;
          resolve({ response: new Response(null, { status, headers: responseHeaders }), location });
          return;
        }
      }

      settled = true;
      const emptyBody = status === 204 || status === 205 || status === 304 || method === 'HEAD';
      if (emptyBody) {
        res.resume();
        res.once('end', finishCleanup);
        res.once('close', finishCleanup);
        resolve({ response: new Response(null, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }) });
        return;
      }
      bodyStream = decodeBody(res, responseHeaders);
      bodyStream.once('end', finishCleanup);
      bodyStream.once('close', finishCleanup);
      bodyStream.once('error', finishCleanup);
      res.once('close', finishCleanup);
      resolve({
        response: new Response(Readable.toWeb(bodyStream) as ReadableStream<Uint8Array>, {
          status,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders,
        }),
      });
    };

    const clientReq = isHttps
      ? https.request(target as URL, requestOptions, handleResponse)
      : transport.request(requestOptions, handleResponse);

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    clientReq.once('error', fail);
    if (body?.byteLength) clientReq.write(body);
    clientReq.end();
  });
}

async function sendViaProxy(
  input: FetchInput,
  init: RequestInit | undefined,
  resolveProxy: (url: URL) => string | undefined,
  baseFetch: typeof fetch,
): Promise<Response> {
  const request = new Request(input, init);
  request.signal.throwIfAborted();
  let url = new URL(request.url);
  let method = request.method;
  let body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers.entries()) headers[name] = value;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const proxyUrl = resolveProxy(url);
    if (!proxyUrl) {
      return baseFetch(url, {
        method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        redirect: request.redirect,
        signal: request.signal,
      });
    }
    const { response, location } = await sendSingleProxyRequest(url, method, headers, body, request.redirect, request.signal, proxyUrl);
    if (!location || request.redirect !== 'follow') return response;
    if (hop === MAX_REDIRECTS) throw new TypeError('Failed to fetch', { cause: new Error('Too many redirects') });
    const nextUrl = new URL(location, url);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      for (const key of Object.keys(headers)) {
        if (/^(content-length|content-type)$/i.test(key)) delete headers[key];
      }
    }
    if (nextUrl.origin !== url.origin) {
      for (const key of Object.keys(headers)) {
        if (/^authorization$/i.test(key)) delete headers[key];
      }
    }
    url = nextUrl;
  }
  throw new TypeError('Failed to fetch');
}

export function createProxyFetch(options: ProxyFetchOptions = {}): typeof fetch {
  const env = options.env ?? process.env;
  const execArgv = options.execArgv ?? process.execArgv;
  const platform = options.platform ?? process.platform;
  const fallbackFetch = options.fallbackFetch;
  const explicitProxy = options.proxyUrl ? normalizeProxyUrl(options.proxyUrl) : undefined;

  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const baseFetch = fallbackFetch ?? globalThis.fetch;
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return baseFetch(input, init);
    }

    if (explicitProxy) {
      const explicitConfig: ProxyConfig = {
        httpProxy: explicitProxy,
        httpsProxy: explicitProxy,
        allProxy: explicitProxy,
      };
      const resolveTargetProxy = (candidate: URL) => proxyForUrl(candidate, explicitConfig);
      if (!resolveTargetProxy(target)) return baseFetch(input, init);
      return sendViaProxy(input, init, resolveTargetProxy, baseFetch);
    }

    if (!fallbackFetch && globalThis.fetch !== NATIVE_FETCH) return baseFetch(input, init);
    if (hasHostProxy(env, execArgv)) return baseFetch(input, init);

    const config = resolveProxyConfig(env, platform, options.readSystemProxy);
    const resolveTargetProxy = (candidate: URL) => proxyForUrl(candidate, config);
    if (!resolveTargetProxy(target)) return baseFetch(input, init);
    return sendViaProxy(input, init, resolveTargetProxy, baseFetch);
  };
}

export const proxyFetch: typeof fetch = createProxyFetch();

export function createProxyFetchFor(proxyUrl?: string): typeof fetch {
  const normalized = proxyUrl ? normalizeProxyUrl(proxyUrl) : undefined;
  return normalized ? createProxyFetch({ proxyUrl: normalized }) : proxyFetch;
}

export interface ConnectHttp2Options {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  proxyUrl?: string;
  readSystemProxy?: () => ProxyConfig | undefined;
}

export type Http2Connector = (origin: string | URL, options?: ConnectHttp2Options) => Promise<http2.ClientHttp2Session>;

function ensureConnectAttemptTimeout(minMs = 5_000): void {
  const netAny = net as typeof net & {
    getDefaultAutoSelectFamilyAttemptTimeout?: () => number;
    setDefaultAutoSelectFamilyAttemptTimeout?: (ms: number) => void;
  };
  if (typeof netAny.getDefaultAutoSelectFamilyAttemptTimeout === 'function'
      && typeof netAny.setDefaultAutoSelectFamilyAttemptTimeout === 'function'
      && netAny.getDefaultAutoSelectFamilyAttemptTimeout() < minMs) {
    netAny.setDefaultAutoSelectFamilyAttemptTimeout(minMs);
  }
}

function openProxyTlsTunnel(target: URL, proxyUrl: string, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const proxy = new URL(proxyUrl);
    const targetPort = Number(target.port) || 443;
    const authority = target.hostname.includes(':') && !target.hostname.startsWith('[')
      ? `[${target.hostname}]:${targetPort}`
      : `${target.hostname}:${targetPort}`;
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const proxyHeaders: Record<string, string> = { Host: authority };
    const auth = proxyAuthHeader(proxy);
    if (auth) proxyHeaders['Proxy-Authorization'] = auth;

    let settled = false;
    let activeSocket: Duplex | undefined;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      activeSocket?.destroy();
      reject(err);
    };
    const onAbort = () => {
      const reason = signal?.reason ?? new Error('Aborted');
      connectReq.destroy(reason instanceof Error ? reason : new Error(String(reason)));
      fail(reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const transport = proxy.protocol === 'https:' ? https : http;
    const connectReq = transport.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: proxyHeaders,
      agent: false,
    });

    connectReq.once('connect', (res, socket, head) => {
      activeSocket = socket;
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        fail(new Error(`Proxy CONNECT returned HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['h2'],
      });
      activeSocket = tlsSocket;
      const onError = (err: Error) => {
        tlsSocket.removeListener('secureConnect', onSecure);
        fail(err);
      };
      const onSecure = () => {
        tlsSocket.removeListener('error', onError);
        if (settled) {
          tlsSocket.destroy();
          return;
        }
        settled = true;
        cleanup();
        resolve(tlsSocket);
      };
      tlsSocket.once('error', onError);
      tlsSocket.once('secureConnect', onSecure);
    });

    connectReq.once('error', fail);
    connectReq.end();
  });
}

/**
 * Opens an HTTP/2 session to `origin`, honoring `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`
 * and the Windows system proxy even when Node was started with `--use-env-proxy`
 * (since `node:http2` does not use undici's proxy dispatcher).
 */
export async function connectHttp2(origin: string | URL, options: ConnectHttp2Options = {}): Promise<http2.ClientHttp2Session> {
  ensureConnectAttemptTimeout();
  const target = typeof origin === 'string' ? new URL(origin) : new URL(origin.href);
  options.signal?.throwIfAborted();
  const explicitProxy = options.proxyUrl ? normalizeProxyUrl(options.proxyUrl) : undefined;
  const config = explicitProxy
    ? { httpProxy: explicitProxy, httpsProxy: explicitProxy, allProxy: explicitProxy }
    : resolveProxyConfig(
      options.env ?? process.env,
      options.platform ?? process.platform,
      options.readSystemProxy,
    );
  const proxyUrl = proxyForUrl(target, config);
  if (proxyUrl && target.protocol === 'https:') {
    const tlsSocket = await openProxyTlsTunnel(target, proxyUrl, options.signal);
    return http2.connect(target.origin, { createConnection: () => tlsSocket });
  }
  return http2.connect(target.origin);
}

export function createHttp2Connector(proxyUrl?: string): Http2Connector {
  const normalized = proxyUrl ? normalizeProxyUrl(proxyUrl) : undefined;
  if (!normalized) return connectHttp2;
  return (origin, options = {}) => connectHttp2(origin, { ...options, proxyUrl: normalized });
}
