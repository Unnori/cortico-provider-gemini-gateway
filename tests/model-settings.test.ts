import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { describe, expect, it, vi } from 'vitest';
import { geminiBaseline } from '../src/catalog.ts';
import provider from '../src/index.ts';
import { automaticPriceForModel, resolveProviderPrices } from '../src/pricing.ts';
import {
  inputCapabilities,
  MODEL_SETTINGS_PANEL,
  modelSettings,
  type InputCapabilities,
  type ModelSettings,
} from '../src/webui/model-settings.ts';

describe('model declared formats and automatic pricing (opencode style)', () => {
  it('auto-fills built-in Gemini prices including >200K bands and Robin subscription mirror', () => {
    const proAuto = automaticPriceForModel('gemini-2.5-pro', undefined, 'equivalent');
    expect(proAuto).toMatchObject({
      models: ['gemini-2.5-pro'],
      currency: 'USD',
      basis: 'equivalent',
      rules: [
        { meter: 'cachedInput', perMillion: 0.125 },
        { meter: 'uncachedInput', perMillion: 1.25 },
        { meter: 'output', perMillion: 10 },
      ],
      inputBands: [expect.objectContaining({ from: 200_001 })],
    });

    const robinEntry: LLMProviderEntry = {
      kind: provider.id,
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      spec: { model: 'gemini-4-hydrogen', thinking: true },
      options: { protocol: 'robin', authMode: 'oauth', mirrorSubscriptionSpend: true },
    };
    const quotes = resolveProviderPrices(robinEntry, 'gemini-4-hydrogen', undefined);
    expect(quotes).toHaveLength(2);
    expect(quotes.map(q => q.basis)).toEqual(['equivalent', 'marginal']);
    expect(quotes[0].rules).toContainEqual({ meter: 'uncachedInput', perMillion: 1.5 });
    expect(quotes[0].rules).toContainEqual({ meter: 'output', perMillion: 7.5 });
  });

  it('supports read-only input-capabilities, format toggles, catalog refresh, custom price save, and reset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gemini-model-settings-'));
    const fetchMock = vi.fn<typeof globalThis.fetch>(async input => {
      const url = String(input);
      if (url.includes('models.dev')) {
        return Response.json({
          google: {
            models: {
              'gemini-2.5-pro': {
                id: 'gemini-2.5-pro',
                name: 'Gemini 2.5 Pro',
                limit: { context: 1_048_576, output: 65_536 },
                modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'] },
                cost: { input: 1.25, output: 10, cache_read: 0.125 },
              },
            },
          },
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      let currentEntry: LLMProviderEntry = {
        kind: provider.id,
        baseUrl: 'http://127.0.0.1:8080',
        multimodal: true,
        spec: { model: 'gemini-2.5-pro', thinking: true },
        options: { protocol: 'gemini', authMode: 'api-key' },
      };

      const makeInstance = (name: string, entry: LLMProviderEntry) => provider.create(name, entry, {
        stateDir: join(root, name),
        secret: () => 'test-key',
        readBlob: () => null,
        keepThinking: () => false,
        log: nullLogger(),
      });

      const ui = provider.webUi!({
        language: 'zh',
        editing: true,
        entries: () => [{ name: 'local-gemini', entry: currentEntry }],
        instance: name => makeInstance(name, currentEntry),
        save: (_name, next) => { currentEntry = structuredClone(next); },
      });

      // Panel declares read-only input-capabilities GET method.
      const panelDecl = ui.panels?.find(p => p.id === MODEL_SETTINGS_PANEL);
      expect(panelDecl?.getMethods).toEqual(['input-capabilities']);

      // Refresh catalog reads live models.dev declarations & prices.
      const refreshed = await ui.invoke!(MODEL_SETTINGS_PANEL, 'refresh-catalog', [{ name: 'local-gemini' }]) as ModelSettings;
      expect(refreshed.catalogSource).toBe('models.dev');
      expect(refreshed.automatic).toBe(true);
      expect(refreshed.input).toContain('image/png');
      expect(refreshed.input).toContain('video/mp4');
      expect(refreshed.definitions[0]?.basis).toBe('marginal');
      expect(refreshed.definitions[0]?.rules).toContainEqual({ meter: 'uncachedInput', perMillion: 1.25 });

      // Read-only input-capabilities matches ProviderModule.accepts.
      const caps = await ui.invoke!(MODEL_SETTINGS_PANEL, 'input-capabilities', [{
        name: 'local-gemini',
        mimes: ['image/png', 'video/mp4', 'application/pdf', 'application/octet-stream'],
      }]) as InputCapabilities;
      expect(caps.accepts).toEqual({
        'image/png': true,
        'video/mp4': true,
        'application/pdf': true,
        'application/octet-stream': false,
      });

      // Disable video input via input-save.
      const withoutVideo = await ui.invoke!(MODEL_SETTINGS_PANEL, 'input-save', [{
        name: 'local-gemini',
        model: 'gemini-2.5-pro',
        kind: 'video',
        enabled: false,
      }]) as ModelSettings;
      expect(withoutVideo.inputs.find(i => i.kind === 'video')?.enabled).toBe(false);
      expect(inputCapabilities(currentEntry, undefined, ['video/mp4']).accepts['video/mp4']).toBe(false);

      // Save custom price override and then reset back to automatic prices.
      const customSaved = await ui.invoke!(MODEL_SETTINGS_PANEL, 'pricing-save', [{
        name: 'local-gemini',
        model: 'gemini-2.5-pro',
        definitions: [{
          models: ['gemini-2.5-pro'],
          currency: 'USD',
          basis: 'marginal',
          source: 'webui',
          rules: [{ meter: 'uncachedInput', perMillion: 9 }, { meter: 'output', perMillion: 18 }],
        }],
      }]) as ModelSettings;
      expect(customSaved.automatic).toBe(false);
      expect(customSaved.definitions[0]?.rules).toContainEqual({ meter: 'uncachedInput', perMillion: 9 });

      const reset = await ui.invoke!(MODEL_SETTINGS_PANEL, 'pricing-reset', [{
        name: 'local-gemini',
        model: 'gemini-2.5-pro',
      }]) as ModelSettings;
      expect(reset.automatic).toBe(true);
      expect(reset.definitions[0]?.rules).toContainEqual({ meter: 'uncachedInput', perMillion: 1.25 });
    } finally {
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('automatically declares full multimodal support (image/audio/video/PDF) for Robin mode without a manual uploadEndpoint', () => {
    const robinEntry: LLMProviderEntry = {
      kind: provider.id,
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      multimodal: true,
      spec: { model: 'gemini-4-neon', thinking: true },
      options: { protocol: 'robin', authMode: 'oauth' },
    };

    expect(provider.accepts(robinEntry, robinEntry.spec!, 'image/jpeg')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'image/png')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'image/webp')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'image/gif')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'audio/wav')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'audio/mp3')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'audio/ogg')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'audio/x-m4a')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'video/mp4')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'video/webm')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'application/pdf')).toBe(true);
    expect(provider.accepts(robinEntry, robinEntry.spec!, 'application/octet-stream')).toBe(false);

    const baseline = geminiBaseline('gemini-4-neon');
    const caps = inputCapabilities(robinEntry, baseline, [
      'image/jpeg',
      'image/gif',
      'audio/wav',
      'video/mp4',
      'application/pdf',
      'application/octet-stream',
    ]);
    expect(caps.accepts).toEqual({
      'image/jpeg': true,
      'image/gif': true,
      'audio/wav': true,
      'video/mp4': true,
      'application/pdf': true,
      'application/octet-stream': false,
    });
    const settings = modelSettings(robinEntry, baseline);
    expect(settings.estimateRobinTokens).toBe(true);
    expect(modelSettings({ ...robinEntry, options: { ...robinEntry.options, estimateRobinTokens: false } }, baseline).estimateRobinTokens).toBe(false);
    expect(modelSettings({ ...robinEntry, options: { protocol: 'gemini', authMode: 'api-key' } }, baseline).estimateRobinTokens).toBeNull();
    for (const kind of ['image', 'audio', 'video', 'file'] as const) {
      expect(settings.inputs.find(i => i.kind === kind)).toEqual({
        kind,
        declared: true,
        available: true,
        enabled: true,
      });
    }

    // Individual input switches still disable each modality independently in Robin mode.
    const restricted: LLMProviderEntry = {
      ...robinEntry,
      options: { ...robinEntry.options, inputAudio: false, inputVideo: false, inputFiles: false },
    };
    expect(provider.accepts(restricted, restricted.spec!, 'image/png')).toBe(true);
    expect(provider.accepts(restricted, restricted.spec!, 'audio/wav')).toBe(false);
    expect(provider.accepts(restricted, restricted.spec!, 'video/mp4')).toBe(false);
    expect(provider.accepts(restricted, restricted.spec!, 'application/pdf')).toBe(false);
  });
});
