import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../src/client.ts';
import { type GeminiRequest } from '../src/shim.ts';

const baseUrl = 'http://gateway.test/';
const input: GeminiRequest = { model: 'gemini-custom', contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };
const reply = () => Response.json({ text: 'hello', done: true });
const consume = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('serialized gateway client', () => {
  it.each([429, 403])('fails HTTP %s immediately without refreshing or retrying', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status })).mockImplementation(async () => reply());
    const accessToken = vi.fn(async (_force?: boolean) => 'token');
    const client = new GatewayClient({ baseUrl, fetch, auth: { accessToken } });
    await expect(consume(client.stream(input))).rejects.toMatchObject({ status, message: expect.stringContaining(`HTTP ${status}`) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(accessToken.mock.calls).toEqual([[false]]);
    await expect(consume(client.stream(input))).resolves.toHaveLength(2);
  });

  it.each([200, 401])('refreshes HTTP 401 once when the second attempt returns %s', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(status === 200 ? reply() : new Response(null, { status }));
    const accessToken = vi.fn(async (force?: boolean) => force ? 'new' : 'old');
    const client = new GatewayClient({ baseUrl, fetch, auth: { accessToken }, authHeader: 'X-Test-Token', authPrefix: '' });
    const run = consume(client.stream(input));
    if (status === 200) await expect(run).resolves.toHaveLength(2);
    else await expect(run).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(accessToken.mock.calls).toEqual([[false], [true]]);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-Test-Token'))).toEqual(['old', 'new']);
  });

  it('surfaces a failed refresh without making another generation request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const accessToken = vi.fn().mockResolvedValueOnce('old').mockRejectedValueOnce(new Error('invalid_grant'));
    const client = new GatewayClient({ baseUrl, fetch, auth: { accessToken } });
    await expect(consume(client.stream(input))).rejects.toMatchObject({ status: 401, message: expect.stringContaining('OAuth refresh') });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handles protobuf-JSON status errors and never replays visible output', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([{ text: 'visible' }, { error: { code: 16 } }]));
    const accessToken = vi.fn(async (_force?: boolean) => 'token');
    const client = new GatewayClient({ baseUrl, fetch, auth: { accessToken } });
    const stream = client.stream(input);
    expect((await stream.next()).value).toMatchObject({ candidates: [{ content: { parts: [{ text: 'visible' }] } }] });
    await expect(stream.next()).rejects.toMatchObject({ status: 401 });
    expect(accessToken.mock.calls).toEqual([[false]]);
  });

  it('holds the queue through consumer cancellation and cleanup, and drops canceled waiters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ conversation_id: 'session/1', text: 'first' }));
    const gate = Promise.withResolvers<void>();
    const cleanup = vi.fn(async (_id: string) => gate.promise);
    const client = new GatewayClient({ baseUrl, fetch, deleteConversation: cleanup });
    const first = client.stream(input);
    expect((await first.next()).done).toBe(false);
    const canceled = new AbortController();
    const waiting = consume(client.stream(input, { signal: canceled.signal }));
    canceled.abort(new Error('canceled'));
    await expect(waiting).rejects.toThrow('canceled');
    const next = consume(client.stream(input));
    const closing = first.return(undefined);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith('session/1'));
    expect(fetch).toHaveBeenCalledTimes(1);
    gate.resolve();
    await closing;
    await next;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uploads multipart data and cleans a returned conversation even on a gateway stream error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ attachment_id: 'attach-1' }))
      .mockResolvedValueOnce(Response.json({ conversationId: 'a/b', error: { status: 'PERMISSION_DENIED' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new GatewayClient({ baseUrl, fetch, uploadEndpoint: '/upload', deleteEndpoint: '/conversations/{conversationId}' });
    await expect(consume(client.stream({ ...input, contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: 'YWJj' } }] }] })))
      .rejects.toMatchObject({ status: 403 });
    const multipart = fetch.mock.calls[0][1]?.body as FormData;
    expect(multipart.get('mimeType')).toBe('audio/wav');
    expect(await (multipart.get('file') as Blob).text()).toBe('abc');
    expect(String(fetch.mock.calls[1][0])).toBe('http://gateway.test/generate?$alt=json');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({
      temporary_chat: true, script: { turns: [{ parts: [{ type: 'attachment', id: 'attach-1', mimeType: 'audio/wav' }] }] },
    });
    expect(String(fetch.mock.calls[2][0])).toBe('http://gateway.test/conversations/a%2Fb');
    expect(fetch.mock.calls[2][1]?.method).toBe('DELETE');
  });

  it('uses the Web2API native route, consumes SSE with split UTF-8, and preserves native tool calls', async () => {
    const first = { candidates: [{ index: 0, content: { parts: [{ text: '你好' }] } }] };
    const call = { functionCall: { name: 'lookup', args: { q: 'x' } } };
    const second = { candidates: [{ index: 0, finishReason: 'STOP', content: { parts: [call] } }] };
    const buffer = Buffer.from(`data: ${JSON.stringify(first)}\r\n\r\ndata: ${JSON.stringify(second)}\n\ndata: [DONE]\n\n`);
    const response = new Response(new ReadableStream({ start(controller) {
      for (const byte of buffer) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
    const client = new GatewayClient({ baseUrl, protocol: 'gemini', fetch });
    const chunks = await consume(client.stream(input));
    expect(String(fetch.mock.calls[0][0])).toBe('http://gateway.test/v1beta/models/gemini-custom:streamGenerateContent?alt=sse');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ contents: input.contents });
    expect(chunks.map(chunk => chunk.candidates?.[0])).toEqual([
      { content: { role: 'model', parts: [{ text: '你好' }] } }, { content: { role: 'model', parts: [call] } }, { finishReason: 'STOP' },
    ]);
  });

  it('streams JSON array objects before the next delimiter arrives', async () => {
    const encoder = new TextEncoder();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream({ start(controller) { body = controller; } }), {
      headers: { 'Content-Type': 'application/json' },
    });
    body.enqueue(encoder.encode('[{"text":"first }, entry"}'));
    const client = new GatewayClient({ baseUrl, fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response) });
    const stream = client.stream(input);
    try {
      expect((await stream.next()).value).toMatchObject({ candidates: [{ content: { parts: [{ text: 'first }, entry' }] } }] });
      body.enqueue(encoder.encode(',{"done":true}]'));
      body.close();
      expect(await consume(stream)).toEqual([{ candidates: [{ finishReason: 'STOP' }] }]);
    } finally {
      await stream.return(undefined);
    }
  });

  it('cleans up Robin conversations via POST when deleteEndpoint has no placeholder', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json([{
        conversationId: 'c_robin123',
        modelResponses: [{ responseId: 'rc_1', textResponse: { text: '63' } }],
      }]))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const client = new GatewayClient({
      baseUrl,
      protocol: 'robin',
      deleteEndpoint: '/$rpc/assistant.mobile.robin.RobinService/DeleteConversation',
      fetch,
    });
    const chunks = await consume(client.stream(input));
    expect(chunks.flatMap(chunk => chunk.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: '63' }]);
    expect(String(fetch.mock.calls[0][0])).toBe('http://gateway.test/$rpc/assistant.mobile.robin.RobinService/StreamGenerate');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ query: { text: 'Hello' } });
    expect(String(fetch.mock.calls[1][0])).toBe('http://gateway.test/$rpc/assistant.mobile.robin.RobinService/DeleteConversation');
    expect(fetch.mock.calls[1][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ conversationId: 'c_robin123' });
  });

  it('classifies Google HTML Sorry 503 block pages as non-retryable 403 with actionable guidance', async () => {
    const html = '<html><head><title>Sorry...</title></head><body><h1>We\'re sorry...</h1><p>... but your computer or network may be sending automated queries.</p></body></html>';
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(html, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    }));
    const client = new GatewayClient({
      baseUrl,
      protocol: 'robin',
      generationEndpoint: '/$rpc/assistant.mobile.robin.RobinService/StreamGenerate',
      fetch,
    });
    await expect(consume(client.stream(input))).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('ProcessQuery'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces sanitized Google RPC 403 error details without retrying', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({
      error: {
        code: 403,
        message: 'Permission denied on the service.',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'ACCESS_DENIED', metadata: { service: 'robinfrontend-pa.googleapis.com' } }],
      },
    }, { status: 403 }));
    const client = new GatewayClient({ baseUrl, fetch });
    await expect(consume(client.stream(input))).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('PERMISSION_DENIED'),
      body: expect.stringContaining('Permission denied on the service.'),
    });
  });
});
