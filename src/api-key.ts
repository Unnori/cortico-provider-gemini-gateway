import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readState, record, writeState } from './state.ts';

export const API_KEY_FILE = 'api-key.json';

export interface StoredApiKeyInfo {
  configured: boolean;
  hint?: string;
  updatedAt?: string;
}

export function maskSecretHint(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

export function readStoredApiKey(oauthDir: string): string | undefined {
  const raw = record(readState(join(oauthDir, API_KEY_FILE)));
  return typeof raw?.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined;
}

export function readStoredApiKeyInfo(oauthDir: string): StoredApiKeyInfo {
  const raw = record(readState(join(oauthDir, API_KEY_FILE)));
  const key = typeof raw?.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : '';
  if (!key) return { configured: false };
  return {
    configured: true,
    hint: maskSecretHint(key),
    ...(typeof raw?.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function saveStoredApiKey(oauthDir: string, apiKey: string): StoredApiKeyInfo {
  const trimmed = apiKey.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error('API Key cannot be empty or contain whitespace');
  }
  const updatedAt = new Date().toISOString();
  writeState(join(oauthDir, API_KEY_FILE), { apiKey: trimmed, updatedAt });
  return { configured: true, hint: maskSecretHint(trimmed), updatedAt };
}

export function removeStoredApiKey(oauthDir: string): StoredApiKeyInfo {
  rmSync(join(oauthDir, API_KEY_FILE), { force: true });
  return { configured: false };
}
