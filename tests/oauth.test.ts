import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DesktopOAuth, OAUTH_CONFIG_FILE, parseOAuthConfig, readBundledOAuthConfig, readOAuthConfig, removeOAuthConfig, saveOAuthConfig, type DesktopOAuthConfig } from '../src/oauth.ts';

it('binds loopback, verifies state and PKCE, and persists rotated refresh tokens for later instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-oauth-'));
  const config: DesktopOAuthConfig = {
    clientId: 'local-client', clientSecret: 'test-value', authEndpoint: 'https://oauth.test/authorize?realm=test',
    tokenEndpoint: 'https://oauth.test/token', scopes: ['open-id', 'gateway.invoke'],
    authParams: { access_type: 'offline' }, tokenHeaders: { 'X-OAuth-Test': 'yes' },
  };
  const tokenFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'a1', refresh_token: 'r1', expires_in: 15 }))
    .mockResolvedValueOnce(Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }))
    .mockResolvedValueOnce(Response.json({ access_token: 'a3', expires_in: '3600' }));
  const loginUrl = Promise.withResolvers<string>();
  const cancel = new AbortController();
  const login = new DesktopOAuth(config, dir, tokenFetch).login(loginUrl.resolve, cancel.signal);
  void login.catch(loginUrl.reject);
  try {
    const url = new URL(await loginUrl.promise);
    expect(url.searchParams.get('scope')).toBe('open-id gateway.invoke');
    expect(url.searchParams.get('realm')).toBe('test');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    expect(callback.hostname).toBe('127.0.0.1');
    expect(callback.pathname).toBe('/oauth/callback');
    callback.searchParams.set('code', 'sample-code');
    callback.searchParams.set('state', 'wrong');
    expect((await fetch(callback)).status).toBe(400);
    expect(tokenFetch).not.toHaveBeenCalled();
    callback.searchParams.set('state', url.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
    await login;
    const form = new URLSearchParams(String(tokenFetch.mock.calls[0][1]?.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_secret')).toBe('test-value');
    expect(form.get('code')).toBe('sample-code');
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(new Headers(tokenFetch.mock.calls[0][1]?.headers).get('X-OAuth-Test')).toBe('yes');

    const auth = new DesktopOAuth(config, dir, tokenFetch);
    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(['a2', 'a2']);
    expect(tokenFetch).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(String(tokenFetch.mock.calls[1][1]?.body)).get('refresh_token')).toBe('r1');
    expect(await new DesktopOAuth(config, dir, tokenFetch).accessToken()).toBe('a2');
    expect(await auth.accessToken(true)).toBe('a3');
    expect(new URLSearchParams(String(tokenFetch.mock.calls[2][1]?.body)).get('refresh_token')).toBe('r2');
    await expect(new DesktopOAuth({ ...config, clientId: 'different' }, dir, tokenFetch).accessToken()).rejects.toThrow('login');
  } finally {
    cancel.abort();
    await login.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

it('supports custom redirectHost/redirectPath, validates them, and surfaces sanitized token errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-oauth-custom-'));
  writeFileSync(join(dir, OAUTH_CONFIG_FILE), JSON.stringify({
    clientId: 'robin-client',
    authEndpoint: 'https://accounts.google.com/o/oauth2/auth',
    tokenEndpoint: 'https://www.googleapis.com/oauth2/v4/token',
    scopes: ['openid', 'email'],
    redirectHost: 'localhost',
    redirectPath: '',
  }));
  const parsed = readOAuthConfig(dir)!;
  expect(parsed.redirectHost).toBe('localhost');
  expect(parsed.redirectPath).toBe('');

  const tokenFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: 'redirect_uri_mismatch', error_description: 'do not reflect' }, { status: 400 }));
  const loginUrl = Promise.withResolvers<string>();
  const cancel = new AbortController();
  const login = new DesktopOAuth(parsed, dir, tokenFetch).login(loginUrl.resolve, cancel.signal);
  void login.catch(loginUrl.reject);

  try {
    const url = new URL(await loginUrl.promise);
    const redirectUri = url.searchParams.get('redirect_uri')!;
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', 'robin-code');
    callback.searchParams.set('state', url.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
    await expect(login).rejects.toThrow('HTTP 400 (redirect_uri_mismatch)');
    await expect(login).rejects.not.toThrow('do not reflect');

    writeFileSync(join(dir, OAUTH_CONFIG_FILE), JSON.stringify({
      clientId: 'bad-host',
      authEndpoint: 'https://accounts.google.com/o/oauth2/auth',
      tokenEndpoint: 'https://www.googleapis.com/oauth2/v4/token',
      scopes: ['openid'],
      redirectHost: 'evil.example',
    }));
    expect(() => readOAuthConfig(dir)).toThrow('redirectHost');
  } finally {
    cancel.abort();
    await login.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

it('supports non-blocking startLogin, manual completeLogin, cancelLogin, logout, and config persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-oauth-manual-'));
  const cfg = saveOAuthConfig(dir, {
    clientId: 'manual-client',
    authEndpoint: 'https://oauth.test/authorize',
    tokenEndpoint: 'https://oauth.test/token',
    scopes: ['openid'],
    redirectHost: 'localhost',
    redirectPath: '',
  });
  const tokenFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'manual-a1', refresh_token: 'manual-r1', expires_in: 3600 }));
  const auth = new DesktopOAuth(cfg, dir, tokenFetch);
  try {
    const started = await auth.startLogin();
    expect(auth.status().pending).toBe(true);
    const same = await auth.startLogin();
    expect(same.url).toBe(started.url);

    const authUrl = new URL(started.url);
    const cb = new URL(authUrl.searchParams.get('redirect_uri')!);
    cb.searchParams.set('code', 'manual-code');
    cb.searchParams.set('state', authUrl.searchParams.get('state')!);

    const status = await auth.completeLogin(cb.href);
    expect(status.signedIn).toBe(true);
    expect(status.pending).toBe(false);
    expect(await auth.accessToken()).toBe('manual-a1');

    expect(auth.logout().signedIn).toBe(false);
    await auth.startLogin();
    auth.cancelLogin();
    expect(auth.status().pending).toBe(false);

    removeOAuthConfig(dir);
    expect(readOAuthConfig(dir)).toBeUndefined();
  } finally {
    auth.cancelLogin();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('ships a secret-free desktop OAuth template that stays unconfigured until filled by the user', () => {
  expect(readBundledOAuthConfig()).toBeUndefined();
  const rawText = readFileSync(new URL('../resources/desktop-oauth.example.json', import.meta.url), 'utf8');
  expect(rawText).not.toMatch(/GOCSPX-/);
  const template = JSON.parse(rawText) as {
    clientId: string;
    clientSecret: string;
    redirectHost: string;
    redirectPath: string;
    scopes: string[];
    authParams?: Record<string, string>;
  };
  expect(template.clientId).toBe('');
  expect(template.clientSecret).toBe('');
  expect(template.redirectHost).toBe('localhost');
  expect(template.redirectPath).toBe('');
  expect(template.scopes).toContain('https://www.googleapis.com/auth/assistant');
  expect(template.scopes).toContain('https://www.googleapis.com/auth/client_channel');
  expect(template.scopes).toContain('https://www.googleapis.com/auth/gemini');
  expect(template.scopes).toContain('https://www.googleapis.com/auth/userinfo.email');
  expect(template.scopes).not.toContain('https://www.googleapis.com/auth/drive');
  expect(template.authParams?.access_type).toBe('offline');
  expect(() => parseOAuthConfig({ ...template, clientId: 'YOUR_CLIENT_ID' })).toThrow('Configure clientId');
});
