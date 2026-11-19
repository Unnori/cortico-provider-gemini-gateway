import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptsMime, CATALOG_TTL_MS, DEFAULT_MODELS_DEV_URL, DEFAULT_OPENROUTER_URL, ModelCatalog, parseModelsDev, parseOpenRouter } from '../src/catalog.ts';

const provider = {
  google: { models: {
    'gemini-scoped': { name: 'Scoped', limit: { context: 123_456, output: 12_345 }, cost: { input: 0, output: 3.5 },
      modalities: { input: ['text', 'image', 'audio', 'video', 'pdf', 'unknown'] } },
    'gemini-text': { modalities: { input: ['text'] } },
    'other-model': {},
  } },
  other: { models: { 'gemini-not-google': {} } },
};
const router = { data: [
  { id: 'google/gemini-router', context_length: 300_000, top_provider: { max_completion_tokens: 4000 },
    architecture: { input_modalities: ['text', 'file', 'pdf'] }, pricing: { prompt: '0.000001', completion: '0.000005' } },
  { id: 'other/gemini-router' }, { id: 'google/other-model' }, null,
] };

describe('Gemini model metadata', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-catalog-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('extracts Google limits, USD per million and declared MIME types', () => {
    const [model, text] = parseModelsDev(provider);
    expect(parseModelsDev(provider).map(row => row.id)).toEqual(['gemini-scoped', 'gemini-text']);
    expect(model).toMatchObject({ displayName: 'Scoped', contextWindow: 123_456, maxOutputTokens: 12_345, inputPrice: 0, outputPrice: 3.5 });
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'audio/mp3', 'audio/wav', 'video/mp4', 'application/pdf', 'text/plain']) {
      expect(acceptsMime(model, mime)).toBe(true);
    }
    expect(text.inputMimeTypes).toEqual(['text/plain']);
    expect(acceptsMime(model, 'TEXT/PLAIN; charset=utf-8')).toBe(true);
  });

  it('normalizes OpenRouter prices and file modalities', () => {
    expect(parseOpenRouter(router)).toEqual([expect.objectContaining({
      id: 'gemini-router', inputPrice: 1, outputPrice: 5, contextWindow: 300_000, maxOutputTokens: 4000,
      inputMimeTypes: ['text/plain', 'application/pdf'], source: 'openrouter',
    })]);
  });

  it('fetches once for concurrent callers, reopens the cache and refreshes after 24h', async () => {
    let now = 90_000;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(provider));
    const catalog = new ModelCatalog(dir, { fetch, now: () => now });
    await Promise.all([catalog.refresh(), catalog.refresh()]);
    const reopened = new ModelCatalog(dir, { fetch, now: () => now });
    expect((await reopened.list()).map(row => row.id)).toEqual(['gemini-scoped', 'gemini-text']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(DEFAULT_MODELS_DEV_URL);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    now += CATALOG_TTL_MS;
    await reopened.list();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses OpenRouter for empty Google metadata and Gemini defaults for misses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ google: { models: {} } }))
      .mockResolvedValueOnce(Response.json(router));
    const catalog = new ModelCatalog(dir, { fetch });
    const rows = await catalog.list('models/gemini-enterprise');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([DEFAULT_MODELS_DEV_URL, DEFAULT_OPENROUTER_URL]);
    expect(rows.map(row => row.id)).toEqual(['gemini-router', 'gemini-enterprise']);
    const baseline = catalog.get('gemini-enterprise');
    expect(baseline).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 65_536, source: 'baseline' });
    expect(baseline?.inputPrice).toBeUndefined();
    expect(baseline?.inputMimeTypes).toEqual(expect.arrayContaining(['image/png', 'audio/wav', 'application/pdf']));
    expect(catalog.get('not-gemini')).toBeUndefined();
  });

  it('recovers from a malformed cache and two unavailable metadata sources', async () => {
    writeFileSync(join(dir, 'model-catalog.json'), '{');
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const catalog = new ModelCatalog(dir, { fetch });
    expect(await catalog.list('gemini-custom')).toEqual([expect.objectContaining({ source: 'baseline' })]);
    await catalog.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
