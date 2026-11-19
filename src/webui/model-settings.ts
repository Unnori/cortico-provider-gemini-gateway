import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import { acceptsMime, canonicalMime, type ModelMetadata } from '../catalog.ts';
import { configuration } from '../options.ts';
import { automaticPriceForModel, priceBasisForEntry } from '../pricing.ts';
import { ROBIN_NATIVE_IMAGE_MIMES } from '../robin-grpc.ts';
import type { RobinRouteSummary } from '../robin-models.ts';

export const MODEL_SETTINGS_PANEL = 'model-settings';
export type InputKind = 'image' | 'audio' | 'video' | 'file';

export interface InputSetting {
  kind: InputKind;
  declared: boolean;
  available: boolean;
  enabled: boolean;
}

export interface ModelInputs {
  model: string;
  input: string[];
  inputs: InputSetting[];
  protocol: string;
  attachmentsEnabled: boolean;
  hasUploadEndpoint: boolean;
  catalogSource: ModelMetadata['source'] | 'unknown';
}

export interface InputCapabilities extends ModelInputs {
  /** Effective support for the caller's exact MIME types, without uploading bytes. */
  accepts: Record<string, boolean>;
}

export interface ModelSettings extends ModelInputs {
  automatic: boolean;
  mirrorSubscriptionSpend: boolean | null;
  robinRoute?: RobinRouteSummary;
  definitions: PriceDefinition[];
  overrides: PriceDefinition[];
}

export function protocolSupportsMime(entry: LLMProviderEntry, mime: string): boolean {
  const cfg = configuration(entry);
  const type = canonicalMime(mime);
  if (type === 'text/plain') return true;
  if (cfg.protocol === 'gemini') return true;
  if (cfg.protocol === 'robin') {
    if (cfg.uploadEndpoint) return true;
    return ROBIN_NATIVE_IMAGE_MIMES.has(type);
  }
  return Boolean(cfg.uploadEndpoint);
}

/** Single unified MIME acceptance policy shared by ProviderModule.accepts and WebUI declarations. */
export function acceptsGatewayMime(entry: LLMProviderEntry, meta: ModelMetadata | undefined, mime: string): boolean {
  const cfg = configuration(entry);
  const type = canonicalMime(mime);
  if (type !== 'text/plain' && cfg.attachments === 'off') return false;
  if (!protocolSupportsMime(entry, type)) return false;
  if (type.startsWith('image/') && !entry.multimodal) return false;
  if (type.startsWith('audio/') && cfg.inputAudio === false) return false;
  if (type.startsWith('video/') && cfg.inputVideo === false) return false;
  if (!/^(image|audio|video)\//.test(type) && type !== 'text/plain' && cfg.inputFiles === false) return false;
  return acceptsMime(meta, type);
}

function candidatesForKind(input: string[], kind: InputKind): string[] {
  return input.filter(mime => {
    const norm = canonicalMime(mime);
    if (kind === 'file') return norm === 'pdf' || (norm.includes('/') && !/^(image|audio|video)\//.test(norm) && norm !== 'text/plain');
    return norm === kind || norm.startsWith(`${kind}/`);
  });
}

function representativeMime(mime: string, kind: InputKind): string {
  if (mime === 'pdf') return 'application/pdf';
  if (mime.includes('/')) return canonicalMime(mime);
  if (kind === 'image') return 'image/png';
  if (kind === 'audio') return 'audio/wav';
  if (kind === 'video') return 'video/mp4';
  return 'application/pdf';
}

/** Read-only discovery using the exact same MIME policy as ProviderModule.accepts. */
export function inputCapabilities(
  entry: LLMProviderEntry,
  meta: ModelMetadata | undefined,
  mimes: string[] = [],
): InputCapabilities {
  const cfg = configuration(entry);
  const model = entry.spec?.model ?? '';
  const input = meta?.inputMimeTypes ?? [];
  const inputs = (['image', 'audio', 'video', 'file'] as const).map(kind => {
    const candidates = candidatesForKind(input, kind);
    const available = candidates.some(mime => protocolSupportsMime(entry, representativeMime(mime, kind)));
    const enabled = candidates.some(mime => acceptsGatewayMime(entry, meta, representativeMime(mime, kind)));
    return { kind, declared: candidates.length > 0, available, enabled };
  });
  return {
    model,
    input,
    inputs,
    protocol: cfg.protocol,
    attachmentsEnabled: cfg.attachments !== 'off',
    hasUploadEndpoint: Boolean(cfg.uploadEndpoint),
    catalogSource: meta?.source ?? 'unknown',
    accepts: Object.fromEntries(mimes.map(mime => [mime, Boolean(model) && acceptsGatewayMime(entry, meta, mime)])),
  };
}

/** Automatic display never turns current defaults into frozen custom prices. */
export function modelSettings(
  entry: LLMProviderEntry,
  meta: ModelMetadata | undefined,
  robinRoute?: RobinRouteSummary,
): ModelSettings {
  const cfg = configuration(entry);
  const model = entry.spec?.model ?? '';
  const basis = priceBasisForEntry(entry);
  const autoDef = automaticPriceForModel(model, meta, basis);
  const overrides = entry.pricing ?? [];
  const byBasis = new Map<string, PriceDefinition>();
  if (autoDef) byBasis.set(autoDef.basis, autoDef);
  const matching = overrides.filter(def => def.models.includes(model) || def.models.includes('*'));
  for (const def of matching) byBasis.set(def.basis, def);
  const { accepts: _accepts, ...inputs } = inputCapabilities(entry, meta);
  const mirrorSubscriptionSpend = cfg.protocol === 'robin' ? cfg.mirrorSubscriptionSpend === true : null;
  return {
    ...inputs,
    automatic: !matching.length,
    mirrorSubscriptionSpend,
    ...(robinRoute ? { robinRoute } : {}),
    definitions: [...byBasis.values()],
    overrides,
  };
}
