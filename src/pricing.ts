import type { PriceRule } from 'cortico/core/generation.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import { geminiModelId, type ModelMetadata } from './catalog.ts';
import { configuration } from './options.ts';

type Rates = readonly [input: number | null, output: number | null, cachedInput: number | null, cacheWrite: number | null];

interface PriceRow {
  id: string;
  rates: Rates;
  /** Optional long-context band (> 200K starts at 200001). */
  band?: readonly [from: number, input: number | null, output: number | null, cachedInput: number | null, cacheWrite: number | null];
}

const BUILTIN_SOURCE = 'Gemini published reference rates';

/**
 * Built-in USD per million tokens reference rates for Gemini & Robin native models.
 * Live catalog rates from models.dev / OpenRouter take precedence when present.
 */
export const GEMINI_PRICE_ROWS: readonly PriceRow[] = [
  { id: 'gemini-robin-pro', rates: [2, 12, 0.2, null], band: [200_001, 4, 18, 0.4, null] },
  { id: 'gemini-robin-fast', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-robin-flash-lite', rates: [0.3, 2.5, 0.03, null] },
  { id: 'gemini-4-argon', rates: [4, 20, 0.2, null] },
  { id: 'gemini-4-neon', rates: [4, 20, 0.2, null] },
  { id: 'gemini-4-hydrogen', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-argon', rates: [4, 20, 0.2, null] },
  { id: 'gemini-hydrogen', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-flash-lite', rates: [0.3, 2.5, 0.03, null] },
  { id: 'gemini-3.8-flash', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-3.7-flash', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-3.6-flash', rates: [1.5, 7.5, 0.15, null] },
  { id: 'gemini-3.5-flash', rates: [1.5, 9, 0.15, null] },
  { id: 'gemini-3.5-flash-lite', rates: [0.3, 2.5, 0.03, null] },
  { id: 'gemini-3.1-pro', rates: [2, 12, 0.2, null], band: [200_001, 4, 18, 0.4, null] },
  { id: 'gemini-3.1-pro-preview', rates: [2, 12, 0.2, null], band: [200_001, 4, 18, 0.4, null] },
  { id: 'gemini-3-pro', rates: [2, 12, 0.2, null], band: [200_001, 4, 18, 0.4, null] },
  { id: 'gemini-3-pro-preview', rates: [2, 12, 0.2, null], band: [200_001, 4, 18, 0.4, null] },
  { id: 'gemini-3-flash', rates: [0.5, 3, 0.05, null] },
  { id: 'gemini-3-flash-preview', rates: [0.5, 3, 0.05, null] },
  { id: 'gemini-2.5-pro', rates: [1.25, 10, 0.125, null], band: [200_001, 2.5, 15, 0.25, null] },
  { id: 'gemini-2.5-pro-preview', rates: [1.25, 10, 0.125, null], band: [200_001, 2.5, 15, 0.25, null] },
  { id: 'gemini-2.5-flash', rates: [0.3, 2.5, 0.03, null] },
  { id: 'gemini-2.5-flash-lite', rates: [0.1, 0.4, 0.01, null] },
  { id: 'gemini-2.0-flash', rates: [0.1, 0.4, 0.025, null] },
];

function rulesFromRates([input, output, cachedInput, cacheWrite]: Rates): PriceRule[] {
  const rules: PriceRule[] = [];
  if (cachedInput !== null) rules.push({ meter: 'cachedInput', perMillion: cachedInput });
  if (input !== null) rules.push({ meter: cachedInput !== null ? 'uncachedInput' : 'input', perMillion: input });
  if (cacheWrite !== null) rules.push({ meter: 'detail:cache_write', perMillion: cacheWrite });
  if (output !== null) rules.push({ meter: 'output', perMillion: output });
  return rules;
}

function findBuiltinRow(model: string): PriceRow | undefined {
  const id = geminiModelId(model).toLowerCase();
  const exact = GEMINI_PRICE_ROWS.find(row => row.id === id);
  if (exact) return exact;
  // Match dated / preview suffixes (e.g. gemini-2.5-pro-05-06 -> gemini-2.5-pro).
  return GEMINI_PRICE_ROWS.find(row => id.startsWith(`${row.id}-`));
}

export function priceBasisForEntry(entry: LLMProviderEntry): 'equivalent' | 'marginal' {
  const cfg = configuration(entry);
  if (cfg.protocol === 'robin') return 'equivalent';
  return cfg.authMode === 'api-key' ? 'marginal' : 'equivalent';
}

export function automaticPriceForModel(
  model: string,
  meta: ModelMetadata | undefined,
  basis: 'equivalent' | 'marginal',
): PriceDefinition | undefined {
  if (!model.trim()) return undefined;
  // Prefer live catalog metadata prices when available.
  if (meta && (meta.inputPrice !== undefined || meta.outputPrice !== undefined)) {
    const hasCacheRead = meta.cachedInputPrice !== undefined;
    const rules: PriceRule[] = [];
    if (meta.cachedInputPrice !== undefined) rules.push({ meter: 'cachedInput', perMillion: meta.cachedInputPrice });
    if (meta.inputPrice !== undefined) rules.push({ meter: hasCacheRead ? 'uncachedInput' : 'input', perMillion: meta.inputPrice });
    if (meta.cacheWritePrice !== undefined) rules.push({ meter: 'detail:cache_write', perMillion: meta.cacheWritePrice });
    if (meta.outputPrice !== undefined) rules.push({ meter: 'output', perMillion: meta.outputPrice });
    if (rules.length) {
      return {
        models: [model],
        currency: 'USD',
        basis,
        source: meta.source,
        rules,
      };
    }
  }

  const row = findBuiltinRow(model);
  if (!row) return undefined;
  return {
    models: [model],
    currency: 'USD',
    basis,
    source: BUILTIN_SOURCE,
    rules: rulesFromRates(row.rates),
    ...(row.band ? { inputBands: [{ from: row.band[0], rules: rulesFromRates([row.band[1], row.band[2], row.band[3], row.band[4]]) }] } : {}),
  };
}

/**
 * Returns automatic price definitions for a request, mirroring subscription estimates to
 * `marginal` ("Actual spend") when `options.mirrorSubscriptionSpend` is enabled on Robin.
 */
export function resolveProviderPrices(
  entry: LLMProviderEntry,
  model: string,
  meta: ModelMetadata | undefined,
): PriceDefinition[] {
  if (!model.trim()) return [];
  const cfg = configuration(entry);
  const basis = priceBasisForEntry(entry);
  const autoDef = automaticPriceForModel(model, meta, basis);
  const defaults = autoDef ? [autoDef] : [];

  if (cfg.protocol !== 'robin' || cfg.mirrorSubscriptionSpend !== true) {
    return defaults;
  }

  // Follow the same last-matching override rule as Cortico Core; leave explicit marginal overrides untouched.
  let equivalent: PriceDefinition | undefined = autoDef;
  for (const def of entry.pricing ?? []) {
    if (!def.models.includes(model) && !def.models.includes('*')) continue;
    if (def.basis === 'marginal') return defaults;
    equivalent = def;
  }
  if (!equivalent) return defaults;
  return [
    ...defaults,
    {
      ...equivalent,
      models: [model],
      basis: 'marginal',
      source: `Robin subscription estimate · ${equivalent.source}`,
    },
  ];
}
