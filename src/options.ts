import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { ProviderHost } from 'cortico/providers/base.ts';
import type { GatewayClientOptions } from './client.ts';
import { readStoredApiKey } from './api-key.ts';
import { parseProxyUrlInput } from './http.ts';
import { OAUTH_ACCOUNTS_FILE, OAUTH_CONFIG_FILE, OAUTH_TOKENS_FILE } from './oauth.ts';
import type { GatewayProtocol } from './shim.ts';
import { httpUrl, stringMap } from './state.ts';

export type AuthMode = 'auto' | 'oauth' | 'api-key';
export type AccountRoutingMode = 'failover' | 'round-robin' | 'least-used' | 'least-used-5h';
export type GatewayPresetId = 'robin' | 'official' | 'gemini' | 'rpc';

export interface GatewayConfiguration extends GatewayClientOptions {
  protocol: GatewayProtocol;
  authMode: AuthMode;
  accountRouting: AccountRoutingMode;
  quotaEndpoint?: string;
  proxyUrl?: string;
  credentialHeader?: string;
  credentialPrefix?: string;
  secretHeaders: Record<string, string>;
  modelsDevUrl?: string;
  openRouterUrl?: string;
  oauthProfile?: string;
  apiKeyConfigured?: boolean;
  attachments?: 'auto' | 'off';
  inputAudio?: boolean;
  inputVideo?: boolean;
  inputFiles?: boolean;
  mirrorSubscriptionSpend?: boolean;
  estimateRobinTokens?: boolean;
}

export function option(entry: LLMProviderEntry, key: string): string | undefined {
  const value = entry.options?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Gateway option ${key} must be a string`);
  return value;
}

export function configuration(entry: LLMProviderEntry): GatewayConfiguration {
  const base = httpUrl(entry.baseUrl);
  if (base.search) throw new Error('Put gateway query parameters in generationEndpoint');
  const protocol = (option(entry, 'protocol') ?? 'rpc') as GatewayProtocol;
  if (protocol !== 'rpc' && protocol !== 'gemini' && protocol !== 'robin') {
    throw new Error('Gateway protocol must be rpc, gemini or robin');
  }
  const authMode = (option(entry, 'authMode') ?? 'auto') as AuthMode;
  if (authMode !== 'auto' && authMode !== 'oauth' && authMode !== 'api-key') {
    throw new Error('Gateway authMode must be auto, oauth or api-key');
  }
  const accountRouting = (option(entry, 'accountRouting') ?? 'failover') as AccountRoutingMode;
  if (
    accountRouting !== 'failover'
    && accountRouting !== 'round-robin'
    && accountRouting !== 'least-used'
    && accountRouting !== 'least-used-5h'
  ) {
    throw new Error('Gateway accountRouting must be failover, round-robin, least-used or least-used-5h');
  }
  const temporaryChat = entry.options?.temporaryChat;
  if (temporaryChat !== undefined && typeof temporaryChat !== 'boolean') {
    throw new Error('temporaryChat must be a boolean');
  }
  const generationEndpoint = option(entry, 'generationEndpoint');
  const uploadEndpoint = option(entry, 'uploadEndpoint');
  const deleteEndpoint = option(entry, 'deleteEndpoint');
  const quotaEndpoint = option(entry, 'quotaEndpoint');
  if (deleteEndpoint && protocol !== 'robin' && !deleteEndpoint.includes('{conversationId}')) {
    throw new Error('deleteEndpoint requires a {conversationId} placeholder');
  }
  for (const route of [generationEndpoint, uploadEndpoint, deleteEndpoint, quotaEndpoint]) {
    if (route) httpUrl(new URL(route, base.href.replace(/\/+$/, '') + '/').href);
  }
  const modelsDevUrl = option(entry, 'modelsDevUrl');
  const openRouterUrl = option(entry, 'openRouterUrl');
  for (const url of [modelsDevUrl, openRouterUrl]) {
    if (url !== undefined) httpUrl(url);
  }
  const rawProxyUrl = option(entry, 'proxyUrl');
  const proxyUrl = rawProxyUrl !== undefined ? parseProxyUrlInput(rawProxyUrl) : undefined;
  const oauthProfile = option(entry, 'oauthProfile');
  if (oauthProfile !== undefined && !/^[a-f0-9-]{36}$/.test(oauthProfile)) {
    throw new Error('Invalid OAuth profile');
  }
  const attachments = option(entry, 'attachments');
  if (attachments !== undefined && attachments !== 'auto' && attachments !== 'off') {
    throw new Error('Gateway attachments must be auto or off');
  }
  const boolOpt = (key: string): boolean | undefined => {
    const val = entry.options?.[key];
    if (val === undefined) return undefined;
    if (typeof val !== 'boolean') throw new Error(`Gateway option ${key} must be a boolean`);
    return val;
  };
  const inputAudio = boolOpt('inputAudio');
  const inputVideo = boolOpt('inputVideo');
  const inputFiles = boolOpt('inputFiles');
  const mirrorSubscriptionSpend = boolOpt('mirrorSubscriptionSpend');
  const estimateRobinTokens = boolOpt('estimateRobinTokens');
  const apiKeyConfigured = boolOpt('apiKeyConfigured');
  const headers = stringMap(entry.options?.headers, 'Gateway headers');
  const secretHeaders = stringMap(entry.options?.secretHeaders, 'Gateway secretHeaders');
  return {
    baseUrl: base.href,
    protocol,
    authMode,
    accountRouting,
    generationEndpoint,
    uploadEndpoint,
    deleteEndpoint,
    quotaEndpoint,
    proxyUrl,
    temporaryChat,
    headers,
    secretHeaders,
    conversationHeader: option(entry, 'conversationHeader'),
    authHeader: option(entry, 'authHeader'),
    authPrefix: option(entry, 'authPrefix'),
    credentialHeader: option(entry, 'credentialHeader'),
    credentialPrefix: option(entry, 'credentialPrefix'),
    modelsDevUrl,
    openRouterUrl,
    oauthProfile,
    apiKeyConfigured,
    attachments: attachments as 'auto' | 'off' | undefined,
    inputAudio,
    inputVideo,
    inputFiles,
    mirrorSubscriptionSpend,
    estimateRobinTokens,
  };
}

export function resolveHeaders(
  entry: LLMProviderEntry,
  host: Pick<ProviderHost, 'secret'>,
  requireSecrets = true,
  oauthDir?: string,
): Headers {
  const config = configuration(entry);
  const headers = new Headers(config.headers);
  const storedKey = oauthDir ? readStoredApiKey(oauthDir) : undefined;
  const envKey = entry.secret ? host.secret(entry.secret) : undefined;
  const apiKey = storedKey || envKey;
  if (apiKey) {
    headers.set(config.credentialHeader ?? 'x-goog-api-key', (config.credentialPrefix ?? '') + apiKey);
  } else if (entry.secret && requireSecrets) {
    throw new Error(`Missing Gemini gateway secret ${entry.secret}`);
  }
  for (const [header, variable] of Object.entries(config.secretHeaders)) {
    const value = host.secret(variable);
    if (!value) {
      if (requireSecrets) throw new Error(`Missing Gemini gateway secret ${variable}`);
    } else {
      headers.set(header, value);
    }
  }
  return headers;
}

export function shouldUseOAuth(entry: LLMProviderEntry, oauthDir: string): boolean {
  const config = configuration(entry);
  if (config.authMode === 'api-key') return false;
  if (config.authMode === 'oauth') return true;
  if (existsSync(join(oauthDir, OAUTH_CONFIG_FILE))
      || existsSync(join(oauthDir, OAUTH_TOKENS_FILE))
      || existsSync(join(oauthDir, OAUTH_ACCOUNTS_FILE))) return true;
  return config.protocol === 'robin' && !entry.secret;
}

export const ROBIN_DEFAULT_BASE_URL = 'https://robinfrontend-pa.googleapis.com';
export const OFFICIAL_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
export const SELF_HOSTED_DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

export function isOfficialGeminiBaseUrl(rawUrl?: string): boolean {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) return false;
  try {
    return new URL(trimmed).hostname.toLowerCase() === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

export function resolveAutoBaseUrl(protocol: GatewayProtocol, currentBaseUrl?: string): string {
  const trimmed = (currentBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (protocol === 'robin') return ROBIN_DEFAULT_BASE_URL;
  if (!trimmed || trimmed === ROBIN_DEFAULT_BASE_URL || isOfficialGeminiBaseUrl(trimmed)) {
    return SELF_HOSTED_DEFAULT_BASE_URL;
  }
  return trimmed;
}

export function presetEntryPatch(preset: GatewayPresetId, currentBaseUrl?: string): {
  baseUrl: string;
  model: string;
  options: Record<string, unknown>;
} {
  if (preset === 'robin') {
    return {
      baseUrl: ROBIN_DEFAULT_BASE_URL,
      model: 'gemini-2.5-pro',
      options: {
        protocol: 'robin',
        authMode: 'oauth',
        generationEndpoint: '/assistant.mobile.robin.RobinService/ProcessQuery',
        quotaEndpoint: '/assistant.mobile.robin.RobinService/GetUsageInfo',
        temporaryChat: true,
        headers: {},
        secretHeaders: {},
      },
    };
  }
  if (preset === 'official') {
    return {
      baseUrl: OFFICIAL_GEMINI_BASE_URL,
      model: 'gemini-2.5-pro',
      options: {
        protocol: 'gemini',
        authMode: 'api-key',
        generationEndpoint: 'v1beta/models/{model}:streamGenerateContent?alt=sse',
        temporaryChat: false,
      },
    };
  }
  if (preset === 'gemini') {
    return {
      baseUrl: resolveAutoBaseUrl('gemini', currentBaseUrl),
      model: 'gemini-2.5-pro',
      options: {
        protocol: 'gemini',
        authMode: 'api-key',
        generationEndpoint: 'v1beta/models/{model}:streamGenerateContent?alt=sse',
        temporaryChat: true,
      },
    };
  }
  return {
    baseUrl: resolveAutoBaseUrl('rpc', currentBaseUrl),
    model: 'gemini-2.5-pro',
    options: {
      protocol: 'rpc',
      authMode: 'api-key',
      generationEndpoint: 'generate?$alt=json',
      temporaryChat: true,
    },
  };
}
