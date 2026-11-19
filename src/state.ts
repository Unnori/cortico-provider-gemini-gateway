import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readState(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read JSON state file ${file}`, { cause: error });
  }
}

export function writeState(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function httpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Expected an HTTP(S) endpoint without URL credentials or a fragment');
  }
  return url;
}

export function stringMap(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  const object = record(value);
  if (!object || Object.values(object).some(item => typeof item !== 'string')) {
    throw new Error(`${name} must map strings to strings`);
  }
  return object as Record<string, string>;
}
