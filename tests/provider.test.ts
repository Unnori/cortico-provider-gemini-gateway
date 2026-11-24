import { mkdtempSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { validateEntry } from 'cortico/providers/configuration.ts';
import { GatewayClient } from '../src/client.ts';
import provider from '../src/index.ts';
import { CustomGeminiProvider } from '../src/native.ts';
import {
  frameGrpcMessage,
  lengthDelimited,
  ROBIN_GRPC_PROCESS_QUERY,
  stringField,
  varintField,
} from '../src/robin-grpc.ts';

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

it('eagerly emits output_item.done for closed tool calls before the HTTP/2 stream finishes closing', async () => {
  const openStreams: http2.ServerHttp2Stream[] = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    if (headers[':path'] !== ROBIN_GRPC_PROCESS_QUERY) {
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    openStreams.push(stream);
    stream.resume();
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      const modelParts = Buffer.concat([
        stringField(1, 'rc_eager'),
        lengthDelimited(2, stringField(1, '<tool_call>{"name":"pet_say","id":"call_0_say","args":{"script":"秒回！"}}</tool_call>')),
        lengthDelimited(12, stringField(1, '先想一下怎么打招呼')),
      ]);
      const clientParts = Buffer.concat([
        lengthDelimited(1, modelParts),
        varintField(9, 0),
        stringField(30, 'Gemini 4 Hydrogen'),
      ]);
      const frame = lengthDelimited(1003, lengthDelimited(1, clientParts));
      // Send complete tool call with completed=0 and deliberately keep HTTP/2 stream hanging open!
      stream.write(frameGrpcMessage(frame));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const client = new GatewayClient({
      baseUrl,
      protocol: 'robin',
      generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
      robinToolIdleTimeoutMs: 450,
      robinTextIdleTimeoutMs: 800,
      auth: { accessToken: async () => 'fresh-token' },
    });
    const customProvider = new CustomGeminiProvider('robin-eager', client, {
      stateDir: tmpdir(),
      secret: () => '',
      readBlob: () => null,
      keepThinking: () => false,
      log: nullLogger(),
    }, () => () => true);

    const startedAt = Date.now();
    const doneOrder: Array<{ index: number; type: string; status?: string; at: number }> = [];
    const result = await customProvider.respond({
      model: 'gemini-robin-fast',
      tools: [{ type: 'function', name: 'pet_say', parameters: { type: 'object' } }],
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    }, {
      nativeSpec: { model: 'gemini-robin-fast', thinking: true },
      onEvent: event => {
        if (event.type === 'response.output_item.done' && event.item) {
          doneOrder.push({
            index: event.output_index,
            type: event.item.type,
            status: 'status' in event.item ? String(event.item.status) : undefined,
            at: Date.now() - startedAt,
          });
        }
      },
    });
    const totalMs = Date.now() - startedAt;

    // Reasoning (index 0) and pet_say (index 1) must BOTH emit output_item.done IMMEDIATELY,
    // well before the 450ms background tool idle timer ends the HTTP/2 stream!
    expect(doneOrder.map(d => ({ index: d.index, type: d.type, status: d.status }))).toEqual([
      { index: 0, type: 'reasoning', status: undefined },
      { index: 1, type: 'function_call', status: 'completed' },
    ]);
    expect(doneOrder[1].at).toBeLessThan(250);
    expect(totalMs - doneOrder[1].at).toBeGreaterThanOrEqual(300);
    expect(result.response.status).toBe('completed');
    expect(result.response.output).toEqual([
      expect.objectContaining({ type: 'reasoning' }),
      expect.objectContaining({
        type: 'function_call',
        call_id: expect.stringMatching(/^call_[0-9a-f]{16}$/),
        name: 'pet_say',
        status: 'completed',
      }),
    ]);

    // Second turn where Robin repeats the exact same model-fabricated `call_0_say` (and history already
    // contains the first turn's call_id): minted call_id must be globally unique and <= 40 chars so
    // hot-switching to DeepSeek/OpenAI never fails with Duplicate call_id.
    const firstCallId = (result.response.output[1] as { call_id: string }).call_id;
    expect(firstCallId).not.toBe('call_0_say');
    expect(firstCallId.length).toBeLessThanOrEqual(40);
    const result2 = await customProvider.respond({
      model: 'gemini-robin-fast',
      tools: [{ type: 'function', name: 'pet_say', parameters: { type: 'object' } }],
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'function_call', call_id: firstCallId, name: 'pet_say', arguments: '{"script":"秒回！"}' },
        { type: 'function_call_output', call_id: firstCallId, output: 'ok' },
        { type: 'message', role: 'user', content: 'again' },
      ],
    }, { nativeSpec: { model: 'gemini-robin-fast', thinking: true } });
    const secondCallId = (result2.response.output[1] as { call_id: string }).call_id;
    expect(secondCallId).toMatch(/^call_[0-9a-f]{16}$/);
    expect(secondCallId).not.toBe('call_0_say');
    expect(secondCallId).not.toBe(firstCallId);
  } finally {
    for (const s of openStreams) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('keeps Robin HTTPS default route on ProcessQuery when proxy fetch and connectHttp2 are both injected (without OAuth)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gemini-robin-route-'));
  const host = {
    stateDir,
    secret: () => '',
    readBlob: () => null,
    keepThinking: () => false,
    log: nullLogger(),
  };
  try {
    const defaultEntry: LLMProviderEntry = {
      kind: provider.id,
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      spec: { model: 'gemini-4-neon', thinking: true },
      options: { protocol: 'robin', authMode: 'oauth', proxyUrl: 'http://127.0.0.1:7890' },
    };
    const defaultInstance = provider.create('robin-default-route', defaultEntry, host);
    expect((defaultInstance.client as CustomGeminiProvider).generationRoute).toBe(ROBIN_GRPC_PROCESS_QUERY);

    const explicitRpcEntry: LLMProviderEntry = {
      ...defaultEntry,
      options: {
        ...defaultEntry.options,
        generationEndpoint: '/$rpc/assistant.mobile.robin.RobinService/StreamGenerate',
      },
    };
    const explicitInstance = provider.create('robin-explicit-rpc', explicitRpcEntry, host);
    expect((explicitInstance.client as CustomGeminiProvider).generationRoute).toBe(
      '/$rpc/assistant.mobile.robin.RobinService/StreamGenerate',
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }

  const seenPaths: string[] = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    seenPaths.push(String(headers[':path'] ?? ''));
    stream.resume();
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      const clientParts = Buffer.concat([
        lengthDelimited(1, Buffer.concat([stringField(1, 'rc_grpc_default'), lengthDelimited(2, stringField(1, 'gRPC ok'))])),
        varintField(9, 1),
      ]);
      stream.write(frameGrpcMessage(lengthDelimited(1003, lengthDelimited(1, clientParts))));
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
  const localPort = addr.port;

  try {
    const consume = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
      const items: T[] = [];
      for await (const item of stream) items.push(item);
      return items;
    };
    const req = { model: 'gemini-4-neon', contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }] };

    // Both fetch + connectHttp2 injected, no explicit generationEndpoint -> defaults to HTTP/2 gRPC ProcessQuery.
    const unusedFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('fetch should not be called when Robin HTTPS defaults to ProcessQuery');
    });
    const connectSpy = vi.fn((_origin: string | URL, opts?: { signal?: AbortSignal }) => {
      const session = http2.connect(`http://127.0.0.1:${localPort}`);
      opts?.signal?.addEventListener('abort', () => {
        try { session.close(); } catch { /* ignore */ }
      }, { once: true });
      return Promise.resolve(session);
    });
    const grpcDefaultClient = new GatewayClient({
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      protocol: 'robin',
      fetch: unusedFetch,
      connectHttp2: connectSpy,
      auth: { accessToken: async () => 'test-token' },
    });
    const grpcChunks = await consume(grpcDefaultClient.stream(req));
    expect(grpcChunks.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'gRPC ok' }]);
    expect(unusedFetch).not.toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(seenPaths).toEqual([ROBIN_GRPC_PROCESS_QUERY]);

    // Explicit $rpc generationEndpoint still wins over connectHttp2.
    const rpcFetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([{
      conversationId: 'c_rpc_explicit',
      modelResponses: [{ responseId: 'rc_rpc_explicit', textResponse: { text: 'RPC explicit ok' } }],
    }]));
    const unusedH2 = vi.fn(async () => {
      throw new Error('connectHttp2 should not be called when explicit HTTP $rpc route is selected');
    });
    const explicitClient = new GatewayClient({
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      protocol: 'robin',
      generationEndpoint: '/$rpc/assistant.mobile.robin.RobinService/StreamGenerate',
      fetch: rpcFetch,
      connectHttp2: unusedH2,
    });
    const explicitChunks = await consume(explicitClient.stream(req));
    expect(explicitChunks.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'RPC explicit ok' }]);
    expect(rpcFetch).toHaveBeenCalledTimes(1);
    expect(String(rpcFetch.mock.calls[0][0])).toBe('https://robinfrontend-pa.googleapis.com/$rpc/assistant.mobile.robin.RobinService/StreamGenerate');
    expect(unusedH2).not.toHaveBeenCalled();

    // Fetch-only caller (without connectHttp2) stays on HTTP $rpc StreamGenerate for mock compatibility.
    const fetchOnly = vi.fn<typeof globalThis.fetch>(async () => Response.json([{
      conversationId: 'c_fetch_only',
      modelResponses: [{ responseId: 'rc_fetch_only', textResponse: { text: 'Fetch only ok' } }],
    }]));
    const fetchOnlyClient = new GatewayClient({
      baseUrl: 'https://robinfrontend-pa.googleapis.com',
      protocol: 'robin',
      fetch: fetchOnly,
    });
    const fetchOnlyChunks = await consume(fetchOnlyClient.stream(req));
    expect(fetchOnlyChunks.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'Fetch only ok' }]);
    expect(String(fetchOnly.mock.calls[0][0])).toBe('https://robinfrontend-pa.googleapis.com/$rpc/assistant.mobile.robin.RobinService/StreamGenerate');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
