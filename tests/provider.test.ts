import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { validateEntry } from 'cortico/providers/configuration.ts';
import provider from '../src/index.ts';

it('mounts a Cortico endpoint, quotes metadata and round-trips history and tool events', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gemini-provider-'));
  const entry: LLMProviderEntry = { kind: provider.id, baseUrl: 'https://gateway.test/', secret: 'GATEWAY_KEY',
    spec: { model: 'gemini-test', thinking: false }, options: { uploadEndpoint: '/files' } };
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ google: { models: { 'gemini-test': {
      limit: { context: 500_000, output: 16_384 }, cost: { input: 0.25, output: 1 }, modalities: { input: ['text', 'pdf'] },
    } } } }))
    .mockResolvedValueOnce(Response.json([
      { text: 'Result: <tool_' },
      { text: 'call>{"name":"lookup","args":{"q":"new"}}</tool_call>', done: true,
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } },
    ]));
  vi.stubGlobal('fetch', fetch);
  try {
    const instance = provider.create('test', entry, {
      stateDir, secret: () => 'local-test-key', readBlob: () => null, keepThinking: () => false, log: nullLogger(),
    });
    expect(await instance.listModels()).toEqual([expect.objectContaining({ id: 'gemini-test', inputImages: false, maxOutputTokens: 16_384 })]);
    expect(instance.contextWindow('gemini-test')).toBe(500_000);
    expect(provider.prices(entry, { model: 'gemini-test' })).toEqual([expect.objectContaining({
      basis: 'equivalent', rules: [{ meter: 'input', perMillion: 0.25 }, { meter: 'output', perMillion: 1 }],
    })]);
    expect(provider.accepts(entry, entry.spec!, 'application/pdf')).toBe(true);
    const events: StreamEvent[] = [];
    const result = await instance.client.respond({
      model: 'gemini-test', instructions: 'Read carefully.',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      input: [
        { type: 'message', role: 'user', content: 'Find it.' },
        { type: 'function_call', call_id: 'prior-call', name: 'lookup', arguments: '{"q":"old"}' },
        { type: 'function_call_output', call_id: 'prior-call', output: 'Old result' },
      ],
    }, { onEvent: event => events.push(event) });
    const [, sent] = fetch.mock.calls[1];
    expect(new Headers(sent?.headers).get('x-goog-api-key')).toBe('local-test-key');
    expect(JSON.parse(String(sent?.body))).toMatchObject({ temporary_chat: true, script: {
      system: [{ type: 'text', text: 'Read carefully.' }],
      turns: [
        { role: 'user', parts: [{ type: 'text', text: 'Find it.' }] },
        { role: 'model', parts: [{ type: 'function_call', call: { id: 'prior-call', name: 'lookup' } }] },
        { role: 'user', parts: [{ type: 'function_response', result: { id: 'prior-call', name: 'lookup', response: { output: 'Old result' } } }] },
      ],
    } });
    expect(result.response.status).toBe('completed');
    expect(result.response.output).toEqual([
      expect.objectContaining({ type: 'message', content: [expect.objectContaining({ text: 'Result: ' })] }),
      expect.objectContaining({ type: 'function_call', name: 'lookup', arguments: '{"q":"new"}', status: 'completed' }),
    ]);
    expect(result.attempts).toEqual([expect.objectContaining({ status: 200, outcome: 'completed', meters: expect.objectContaining({ input: 10, output: 3 }) })]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'response.function_call_arguments.delta', delta: '{"q":"new"}' }));
  } finally {
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it('validates legacy thinking-without-effort configs and normalizes reasoning effort values', () => {
  const legacyRobin: LLMProviderEntry = {
    kind: provider.id,
    baseUrl: 'https://robinfrontend-pa.googleapis.com',
    spec: { model: 'gemini-4-neon', thinking: true, contextWindow: 1_048_576 },
    options: { protocol: 'robin', authMode: 'oauth' },
    multimodal: true,
    pricing: [],
  };
  const validated = validateEntry(provider, legacyRobin, 'zh');
  expect(validated.spec).toEqual({ model: 'gemini-4-neon', thinking: true, contextWindow: 1_048_576 });

  const normalizedMax = validateEntry(provider, {
    ...legacyRobin,
    spec: { model: 'gemini-4-neon', thinking: true, reasoningEffort: 'MAX' },
  }, 'zh');
  expect(normalizedMax.spec?.reasoningEffort).toBe('high');

  const normalizedNone = validateEntry(provider, {
    ...legacyRobin,
    spec: { model: 'gemini-4-neon', thinking: true, reasoningEffort: 'none' },
  }, 'zh');
  expect(normalizedNone.spec).toEqual({ model: 'gemini-4-neon', thinking: false });

  expect(() => validateEntry(provider, {
    ...legacyRobin,
    spec: { model: 'gemini-4-neon', thinking: true, reasoningEffort: 'bogus' },
  }, 'zh')).toThrow();
});
