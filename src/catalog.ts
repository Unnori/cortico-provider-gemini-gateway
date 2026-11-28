import { join } from 'node:path';
import { proxyFetch } from './http.ts';
import { inspectHttpError } from './queue.ts';
import { httpUrl, readState, record, writeState } from './state.ts';

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json';
export const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

const MIME = {
  text: ['text/plain'],
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'],
  audio: ['audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/webm'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/x-msvideo', 'video/x-ms-wmv', 'video/x-flv', 'video/3gpp'],
  pdf: ['application/pdf'],
  file: ['application/pdf'],
} as const;
const BASELINE_MIME = [...MIME.text, ...MIME.image, ...MIME.audio, ...MIME.pdf];
const MULTIMODAL_VIDEO_MIME = [...MIME.text, ...MIME.image, ...MIME.audio, ...MIME.video, ...MIME.pdf];
const BASELINE_CONTEXT = 1_048_576;
const BASELINE_OUTPUT = 65_536;

export interface ModelMetadata {
  id: string;
  displayName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputMimeTypes: string[];
  inputPrice?: number;
  outputPrice?: number;
  cachedInputPrice?: number;
  cacheWritePrice?: number;
  source: 'models.dev' | 'openrouter' | 'baseline';
}

export const BUILTIN_ROBIN_MODELS: readonly ModelMetadata[] = [
  { id: 'gemini-robin-pro', displayName: 'Robin PRO (mode 3)', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-robin-fast', displayName: 'Robin FAST (mode 1)', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-robin-flash-lite', displayName: 'Robin Flash-Lite (mode 6)', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...BASELINE_MIME], source: 'baseline' },
  { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...BASELINE_MIME], source: 'baseline' },
  { id: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon (Ultra)', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon (Ultra)', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen (Fast)', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...MULTIMODAL_VIDEO_MIME], source: 'baseline' },
  { id: 'gemini-flash-lite', displayName: 'Gemini Flash-Lite', contextWindow: 1_048_576, maxOutputTokens: 65_536, inputMimeTypes: [...BASELINE_MIME], source: 'baseline' },
];

export function geminiModelId(model: string): string {
  return model.replace(/^(?:models\/)?(?:google\/)?/, '');
}

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/opus': 'audio/ogg',
  'video/mov': 'video/quicktime',
  'video/avi': 'video/x-msvideo',
};

export function canonicalMime(mime: string): string {
  const normalized = mime.split(';', 1)[0].trim().toLowerCase();
  return MIME_ALIASES[normalized] ?? normalized;
}

export function geminiBaseline(model: string): ModelMetadata | undefined {
  const id = geminiModelId(model);
  if (!/^gemini-[\w.:-]+$/.test(id)) return undefined;
  const builtin = BUILTIN_ROBIN_MODELS.find(item => item.id === id);
  if (builtin) return structuredClone(builtin);
  return { id, contextWindow: BASELINE_CONTEXT, maxOutputTokens: BASELINE_OUTPUT, inputMimeTypes: [...BASELINE_MIME], source: 'baseline' };
}

export function acceptsMime(model: ModelMetadata | undefined, mime: string): boolean {
  if (!model) return false;
  const target = canonicalMime(mime);
  return model.inputMimeTypes.some(declared => {
    const norm = canonicalMime(declared);
    return norm === target
      || (declared === 'pdf' && target === 'application/pdf')
      || (['image', 'audio', 'video'].includes(declared) && target.startsWith(`${declared}/`));
  });
}

function tokenLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function price(value: unknown, perToken = false): number | undefined {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  const converted = typeof parsed === 'number' ? parsed * (perToken ? 1_000_000 : 1) : NaN;
  return Number.isFinite(converted) && converted >= 0 ? Math.round(converted * 1_000_000) / 1_000_000 : undefined;
}

function inputMimes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...BASELINE_MIME];
  const groups = value.flatMap(item => {
    if (typeof item !== 'string') return [];
    if (Object.hasOwn(MIME, item)) return [...MIME[item as keyof typeof MIME]];
    if (item.includes('/')) return [item.toLowerCase()];
    return [];
  });
  return [...new Set(groups.length ? groups : BASELINE_MIME)];
}

export function parseModelsDev(raw: unknown): ModelMetadata[] {
  const models = record(record(record(raw)?.google)?.models);
  return Object.entries(models ?? {}).flatMap(([key, value]) => {
    const row = record(value);
    const model = geminiBaseline(typeof row?.id === 'string' ? row.id : key);
    if (!model || !row) return [];
    const limit = record(row.limit);
    const cost = record(row.cost);
    return [{
      ...model,
      source: 'models.dev',
      displayName: typeof row.name === 'string' ? row.name : model.displayName,
      contextWindow: tokenLimit(limit?.context) ?? model.contextWindow,
      maxOutputTokens: tokenLimit(limit?.output) ?? model.maxOutputTokens,
      inputMimeTypes: inputMimes(record(row.modalities)?.input),
      inputPrice: price(cost?.input),
      outputPrice: price(cost?.output),
      cachedInputPrice: price(cost?.cache_read),
      cacheWritePrice: price(cost?.cache_write),
    }];
  });
}

export function parseOpenRouter(raw: unknown): ModelMetadata[] {
  const data = record(raw)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap(value => {
    const row = record(value);
    if (!row || typeof row.id !== 'string' || !row.id.startsWith('google/')) return [];
    const model = geminiBaseline(row.id);
    if (!model) return [];
    const provider = record(row.top_provider);
    const cost = record(row.pricing);
    return [{
      ...model,
      source: 'openrouter',
      displayName: typeof row.name === 'string' ? row.name : model.displayName,
      contextWindow: tokenLimit(row.context_length) ?? tokenLimit(provider?.context_length) ?? model.contextWindow,
      maxOutputTokens: tokenLimit(provider?.max_completion_tokens) ?? model.maxOutputTokens,
      inputMimeTypes: inputMimes(record(row.architecture)?.input_modalities),
      inputPrice: price(cost?.prompt, true),
      outputPrice: price(cost?.completion, true),
      cachedInputPrice: price(cost?.input_cache_read, true),
      cacheWritePrice: price(cost?.input_cache_write, true),
    }];
  });
}

export function parseOfficialGeminiModels(raw: unknown): ModelMetadata[] {
  const rows = record(raw)?.models;
  if (!Array.isArray(rows)) return [];
  const out: ModelMetadata[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    const row = record(item);
    if (!row || typeof row.name !== 'string') continue;
    const methods = Array.isArray(row.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
    if (methods.length > 0 && !methods.includes('generateContent')) continue;
    const baseline = geminiBaseline(row.name);
    if (!baseline || seen.has(baseline.id)) continue;
    seen.add(baseline.id);
    out.push({
      ...baseline,
      displayName: typeof row.displayName === 'string' && row.displayName.trim()
        ? row.displayName.trim()
        : baseline.displayName,
      contextWindow: tokenLimit(row.inputTokenLimit) ?? baseline.contextWindow,
      maxOutputTokens: tokenLimit(row.outputTokenLimit) ?? baseline.maxOutputTokens,
      inputMimeTypes: [...MULTIMODAL_VIDEO_MIME],
    });
  }
  return out;
}

export async function fetchOfficialGeminiModels(
  baseUrl: string,
  headers: Headers,
  fetchFn: typeof fetch = proxyFetch,
  signal?: AbortSignal,
  pageSize = 100,
): Promise<ModelMetadata[]> {
  const url = httpUrl(new URL(`v1beta/models?pageSize=${pageSize}`, baseUrl.replace(/\/+$/, '') + '/').href).href;
  const reqHeaders = new Headers(headers);
  reqHeaders.set('Accept', 'application/json');
  const deadline = AbortSignal.timeout(12_000);
  const response = await fetchFn(url, {
    method: 'GET',
    headers: reqHeaders,
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) {
    const info = await inspectHttpError(response);
    throw new Error(`Official Gemini API returned HTTP ${info.status}${info.detail ? `: ${info.detail}` : ''}`);
  }
  return parseOfficialGeminiModels(await response.json());
}

export interface CatalogOptions {
  modelsDevUrl?: string;
  openRouterUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  warn?: (message: string) => void;
}

interface Snapshot { fetchedAt: number; models: Map<string, ModelMetadata>; }

export class ModelCatalog {
  private readonly file: string;
  private readonly urls: [string, string];
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly options: CatalogOptions;
  private snapshot?: Snapshot;
  private pending?: Promise<void>;
  private retryAt = 0;

  constructor(stateDir: string, options: CatalogOptions = {}) {
    this.options = options;
    this.file = join(stateDir, 'model-catalog.json');
    this.urls = [httpUrl(options.modelsDevUrl ?? DEFAULT_MODELS_DEV_URL).href, httpUrl(options.openRouterUrl ?? DEFAULT_OPENROUTER_URL).href];
    this.request = options.fetch ?? proxyFetch;
    this.now = options.now ?? Date.now;
    try {
      const cache = record(readState(this.file));
      if (cache?.version !== 1 || JSON.stringify(cache.urls) !== JSON.stringify(this.urls)
          || typeof cache.fetchedAt !== 'number' || !Array.isArray(cache.models)) return;
      const models = cache.models.filter((row): row is ModelMetadata => {
        const model = record(row);
        return !!model && typeof model.id === 'string' && !!geminiBaseline(model.id) && !!tokenLimit(model.contextWindow)
          && !!tokenLimit(model.maxOutputTokens) && Array.isArray(model.inputMimeTypes) && model.inputMimeTypes.every(mime => typeof mime === 'string')
          && (model.source === 'models.dev' || model.source === 'openrouter')
          && (model.displayName === undefined || typeof model.displayName === 'string')
          && [model.inputPrice, model.outputPrice, model.cachedInputPrice, model.cacheWritePrice]
            .every(value => value === undefined || typeof value === 'number' && price(value) !== undefined);
      });
      if (models.length) this.snapshot = { fetchedAt: cache.fetchedAt, models: new Map(models.map(model => [model.id, model])) };
    } catch {
      options.warn?.('Cannot read Gemini model catalog cache');
    }
  }

  private fresh(): Snapshot | undefined {
    const age = this.snapshot ? this.now() - this.snapshot.fetchedAt : Infinity;
    return age >= 0 && age < CATALOG_TTL_MS ? this.snapshot : undefined;
  }

  get(model: string, fallbackIds?: readonly string[]): ModelMetadata | undefined {
    const fresh = this.fresh()?.models;
    const primaryId = geminiModelId(model);
    const direct = fresh?.get(primaryId);
    if (direct) return structuredClone(direct);
    if (fresh && fallbackIds?.length) {
      for (const alias of fallbackIds) {
        const hit = fresh.get(geminiModelId(alias));
        if (hit) return { ...structuredClone(hit), id: primaryId };
      }
    }
    return geminiBaseline(model);
  }

  async list(configuredModel?: string, includeBuiltin = false): Promise<ModelMetadata[]> {
    await this.refresh();
    const models = new Map(this.fresh()?.models);
    if (includeBuiltin) {
      for (const item of BUILTIN_ROBIN_MODELS) {
        if (!models.has(item.id)) models.set(item.id, structuredClone(item));
      }
    }
    const fallback = configuredModel ? this.get(configuredModel) : undefined;
    if (fallback && !models.has(fallback.id)) models.set(fallback.id, fallback);
    return structuredClone([...models.values()]);
  }

  async refresh(force = false): Promise<void> {
    if (!force && (this.fresh() || this.now() < this.retryAt)) return;
    this.pending ??= this.fetchModels().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async fetchModels(): Promise<void> {
    const parsers = [parseModelsDev, parseOpenRouter];
    for (const [index, url] of this.urls.entries()) {
      let models: ModelMetadata[];
      try {
        const response = await this.request(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }
        models = parsers[index](await response.json());
      } catch {
        continue;
      }
      if (!models.length) continue;
      const fetchedAt = this.now();
      this.snapshot = { fetchedAt, models: new Map(models.map(model => [model.id, model])) };
      try {
        writeState(this.file, { version: 1, urls: this.urls, fetchedAt, models });
      } catch {
        this.options.warn?.('Cannot write Gemini model catalog cache');
      }
      return;
    }
    this.retryAt = this.now() + 5 * 60_000;
    this.options.warn?.('Gemini public model catalogs unavailable');
  }
}
