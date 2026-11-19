import http2 from 'node:http2';
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../src/client.ts';
import { queryGatewayQuota } from '../src/quota.ts';
import {
  acceptRobinTermsOfService,
  buildProcessQueryWire,
  decodeGrpcUsageInfo,
  decodeProcessQueryFrame,
  decodeRobinUserStatus,
  detectRobinImageMime,
  encodeRobinImageAttachments,
  frameGrpcMessage,
  GrpcMessageReader,
  isRobinGrpcRoute,
  lengthDelimited,
  parseProtobuf,
  resolveRobinMode,
  ROBIN_GRPC_ACCEPT_TERMS,
  ROBIN_GRPC_GET_TERMS_VERSION,
  ROBIN_GRPC_GET_USAGE_INFO,
  ROBIN_GRPC_GET_USER_STATUS,
  ROBIN_GRPC_PROCESS_QUERY,
  slugifyRobinModelId,
  stringField,
  uploadRobinImages,
  varintField,
} from '../src/robin-grpc.ts';
import {
  buildRobinListedModels,
  buildRobinRouteSummary,
  robinCatalogLookupIds,
} from '../src/robin-models.ts';
import { geminiBaseline } from '../src/catalog.ts';
import type { GeminiRequest } from '../src/shim.ts';

function encodeFloat32Field(fieldNumber: number, value: number): Buffer {
  const key = Buffer.from([(fieldNumber << 3) | 5]);
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  return Buffer.concat([key, buf]);
}

function encodeProcessQueryResponse(opts: {
  text?: string;
  thought?: string;
  responseId?: string;
  conversationId?: string;
  attribution?: string;
  completed?: boolean;
}): Buffer {
  const modelParts: Buffer[] = [];
  if (opts.responseId) modelParts.push(stringField(1, opts.responseId));
  if (opts.text !== undefined) modelParts.push(lengthDelimited(2, stringField(1, opts.text)));
  if (opts.thought !== undefined) modelParts.push(lengthDelimited(12, stringField(1, opts.thought)));

  const clientParts: Buffer[] = [];
  if (modelParts.length) clientParts.push(lengthDelimited(1, Buffer.concat(modelParts)));
  if (opts.conversationId) clientParts.push(lengthDelimited(2, stringField(1, opts.conversationId)));
  if (opts.completed) clientParts.push(varintField(9, 1));
  if (opts.attribution) clientParts.push(stringField(30, opts.attribution));

  return lengthDelimited(1003, lengthDelimited(1, Buffer.concat(clientParts)));
}

function encodeUsageInfoResponse(): Buffer {
  const ts1 = Buffer.concat([varintField(1, Math.floor(Date.parse('2026-11-19T12:00:00Z') / 1000)), varintField(2, 0)]);
  const ts2 = Buffer.concat([varintField(1, Math.floor(Date.parse('2026-11-26T00:00:00Z') / 1000)), varintField(2, 0)]);
  const row1 = Buffer.concat([lengthDelimited(1, ts1), encodeFloat32Field(2, 0.25), stringField(3, '5-hour usage')]);
  const row2 = Buffer.concat([lengthDelimited(1, ts2), encodeFloat32Field(2, 0.6), stringField(3, 'Weekly usage')]);
  const group = Buffer.concat([varintField(1, 1), lengthDelimited(2, row1), lengthDelimited(2, row2)]);
  return Buffer.concat([varintField(2, 2), lengthDelimited(3, group)]);
}

const consume = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('Robin native HTTP/2 gRPC wire codec and transport', () => {
  it('classifies gRPC routes vs Connect-JSON $rpc routes and resolves model modes', () => {
    expect(isRobinGrpcRoute(ROBIN_GRPC_PROCESS_QUERY)).toBe(true);
    expect(isRobinGrpcRoute(ROBIN_GRPC_GET_USAGE_INFO)).toBe(true);
    expect(isRobinGrpcRoute(ROBIN_GRPC_GET_USER_STATUS)).toBe(true);
    expect(isRobinGrpcRoute('/$rpc/assistant.mobile.robin.RobinService/StreamGenerate')).toBe(false);
    expect(isRobinGrpcRoute('/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo?$alt=json')).toBe(false);

    expect(resolveRobinMode('gemini-4-hydrogen', true)).toEqual({ modeCategory: 1, smartModelSelection: false, thinkingLevel: 2 });
    expect(resolveRobinMode('gemini-robin-fast', true, 'low')).toEqual({ modeCategory: 1, smartModelSelection: false, thinkingLevel: 1 });
    expect(resolveRobinMode('gemini-robin-pro', true, 'medium')).toEqual({ modeCategory: 3, smartModelSelection: false, thinkingLevel: 4 });
    expect(resolveRobinMode('gemini-4-neon', true, 'high')).toEqual({ modeCategory: 3, smartModelSelection: false, thinkingLevel: 2 });
    expect(resolveRobinMode('gemini-4-argon', true)).toEqual({ modeCategory: 3, smartModelSelection: false, thinkingLevel: 2 });
    expect(resolveRobinMode('gemini-2.5-pro', false)).toEqual({ modeCategory: 3, smartModelSelection: false, thinkingLevel: 0 });
    expect(resolveRobinMode('gemini-3.5-flash-lite', true)).toEqual({ modeCategory: 6, smartModelSelection: false, thinkingLevel: 2 });
    expect(resolveRobinMode('gemini-auto', true)).toEqual({ smartModelSelection: true, thinkingLevel: 2 });
    expect(resolveRobinMode('gemini-custom', true, 'low', 6)).toEqual({ modeCategory: 6, smartModelSelection: false, thinkingLevel: 1 });
  });

  it('encodes 3-frame ProcessQuery wire payload and decodes response & quota protobufs', () => {
    const wire = buildProcessQueryWire({
      userText: 'What is 9*7?',
      model: 'gemini-4-hydrogen',
      thinking: true,
      temporaryChat: true,
    });
    const reader = new GrpcMessageReader();
    const frames = reader.push(wire);
    reader.finish();
    expect(frames).toHaveLength(3);
    const frame1 = parseProtobuf(frames[0]);
    expect(frame1.some(f => f.number === 1000)).toBe(true);
    const frame2 = parseProtobuf(frames[1]);
    expect(frame2.some(f => f.number === 1007)).toBe(true);

    const decoded = decodeProcessQueryFrame(encodeProcessQueryResponse({
      text: '63',
      thought: '9 * 7 = 63',
      responseId: 'rc_1',
      conversationId: 'c_abc',
      attribution: 'Gemini 4 Hydrogen',
      completed: true,
    }));
    expect(decoded).toEqual({
      text: '63',
      thought: '9 * 7 = 63',
      responseId: 'rc_1',
      conversationId: 'c_abc',
      modelVersion: 'Gemini 4 Hydrogen',
      completed: true,
    });

    const quota = decodeGrpcUsageInfo(encodeUsageInfoResponse(), 'https://robinfrontend-pa.googleapis.com/assistant.mobile.robin.RobinService/GetUsageInfo');
    expect(quota.supported).toBe(true);
    expect(quota.plan).toBe('Pro');
    expect(quota.userTier).toBe('TIER1');
    expect(quota.windows).toEqual([
      { id: 'fiveHour', poolType: 'GXU_FIVE_HOURLY', title: '5-hour usage', usedPercent: 25, remainingPercent: 75, resetsAt: '2026-11-19T12:00:00.000Z' },
      { id: 'weekly', poolType: 'GXU_WEEKLY', title: 'Weekly usage', usedPercent: 60, remainingPercent: 40, resetsAt: '2026-11-26T00:00:00.000Z' },
    ]);
  });

  it('streams ProcessQuery over HTTP/2 gRPC, computes monotonic deltas, refreshes 401 once, and maps 403', async () => {
    let queryCalls = 0;
    let quotaCalls = 0;
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      const path = headers[':path'];
      const auth = headers['authorization'];
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(chunk as Buffer));
      stream.on('end', () => {
        if (path === ROBIN_GRPC_PROCESS_QUERY) {
          queryCalls++;
          if (auth === 'Bearer stale-token') {
            stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
            stream.on('wantTrailers', () => {
              stream.sendTrailers({ 'grpc-status': '16', 'grpc-message': 'Request had invalid authentication credentials.' });
            });
            stream.end();
            return;
          }
          if (auth === 'Bearer forbidden-token') {
            stream.respond({
              ':status': 200,
              'content-type': 'application/grpc',
              'grpc-status': '7',
              'grpc-message': 'Permission denied on the service.',
            }, { endStream: true });
            return;
          }
          expect(headers['content-type']).toBe('application/grpc');
          const reader = new GrpcMessageReader();
          expect(reader.push(Buffer.concat(chunks))).toHaveLength(3);
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            thought: 'Let me think',
            text: 'Result: ',
            responseId: 'rc_live',
            attribution: 'Gemini 4 Hydrogen',
          })));
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            thought: 'Let me think... done.',
            text: 'Result: 63',
            responseId: 'rc_live',
            attribution: 'Gemini 4 Hydrogen',
            completed: true,
          })));
          stream.on('wantTrailers', () => {
            stream.sendTrailers({ 'grpc-status': '0' });
          });
          stream.end();
          return;
        }
        if (path === ROBIN_GRPC_GET_USAGE_INFO) {
          quotaCalls++;
          if (auth === 'Bearer stale-token') {
            stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
            stream.on('wantTrailers', () => {
              stream.sendTrailers({ 'grpc-status': '16', 'grpc-message': 'Expired token' });
            });
            stream.end();
            return;
          }
          if (auth === 'Bearer forbidden-token') {
            stream.respond({
              ':status': 200,
              'content-type': 'application/grpc',
              'grpc-status': '7',
              'grpc-message': 'Permission denied on the service.',
            }, { endStream: true });
            return;
          }
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(encodeUsageInfoResponse()));
          stream.on('wantTrailers', () => {
            stream.sendTrailers({ 'grpc-status': '0' });
          });
          stream.end();
          return;
        }
        if (path === ROBIN_GRPC_GET_TERMS_VERSION) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(Buffer.concat([varintField(1, 5), varintField(2, 4)])));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        if (path === ROBIN_GRPC_ACCEPT_TERMS) {
          const reader = new GrpcMessageReader();
          const frames = reader.push(Buffer.concat(chunks));
          const reqFields = parseProtobuf(frames[0]);
          // field 5 = clientType(21), field 6 = legacyVersion(4), field 10 = timestamp
          expect(reqFields.some(f => f.number === 5)).toBe(true);
          expect(reqFields.some(f => f.number === 6 && f.payload[0] === 4)).toBe(true);
          expect(reqFields.some(f => f.number === 10)).toBe(true);
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(Buffer.alloc(0)));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        stream.respond({ ':status': 404 });
        stream.end();
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const accessToken = vi.fn(async (force?: boolean) => (force ? 'fresh-token' : 'stale-token'));
      const client = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        auth: { accessToken },
      });
      const input: GeminiRequest = {
        model: 'gemini-4-hydrogen',
        contents: [{ role: 'user', parts: [{ text: '9 * 7 = ?' }] }],
        generationConfig: { thinkingConfig: { includeThoughts: true } },
      };

      const chunks = await consume(client.stream(input));
      expect(queryCalls).toBe(2);
      expect(accessToken.mock.calls).toEqual([[false], [true]]);
      const parts = chunks.flatMap(c => c.candidates?.[0]?.content?.parts ?? []);
      expect(parts).toEqual([
        { text: 'Let me think', thought: true },
        { text: 'Result: ' },
        { text: '... done.', thought: true },
        { text: '63' },
      ]);
      expect(chunks.at(-1)).toEqual({ candidates: [{ finishReason: 'STOP' }] });

      // Quota query refreshes 401 once and decodes protobuf windows + plan.
      const quotaAuth = vi.fn(async (force?: boolean) => (force ? 'fresh-token' : 'stale-token'));
      const snap = await queryGatewayQuota({
        baseUrl,
        protocol: 'robin',
        quotaEndpoint: ROBIN_GRPC_GET_USAGE_INFO,
        auth: { accessToken: quotaAuth },
      });
      expect(quotaCalls).toBe(2);
      expect(snap.plan).toBe('Pro');
      expect(snap.windows.map(w => w.usedPercent)).toEqual([25, 60]);

      // gRPC PERMISSION_DENIED (7) maps to 403 with scope hint and never retries.
      const deniedClient = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        auth: { accessToken: async () => 'forbidden-token' },
      });
      await expect(consume(deniedClient.stream(input))).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('Permission denied'),
      });
      await expect(queryGatewayQuota({
        baseUrl,
        protocol: 'robin',
        quotaEndpoint: ROBIN_GRPC_GET_USAGE_INFO,
        auth: { accessToken: async () => 'forbidden-token' },
      })).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('Scope'),
      });

      // User-initiated Terms of Service confirmation fetches version and sends AcceptTermsOfService.
      const terms = await acceptRobinTermsOfService({
        baseUrl,
        headers: new Headers({ Authorization: 'Bearer fresh-token' }),
      });
      expect(terms.accepted).toBe(true);
      expect(terms.version).toBe(4);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('detects image magic bytes, encodes ProcessQuery attachments, uploads via HTTP/2 Scotty resumable flow, and caches blob IDs', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const webpBytes = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');
    const gifBytes = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');

    expect(detectRobinImageMime(pngBytes)).toBe('image/png');
    expect(detectRobinImageMime(jpegBytes)).toBe('image/jpeg');
    expect(detectRobinImageMime(webpBytes)).toBe('image/webp');
    expect(detectRobinImageMime(gifBytes)).toBeNull();

    const encodedAttachments = encodeRobinImageAttachments([
      { blobId: '/contrib_service/ttl_1d/blob-1', mimeType: 'image/png' },
      { blobId: '/contrib_service/ttl_1d/blob-2', mimeType: 'image/jpeg' },
    ]);
    expect(encodedAttachments).toHaveLength(2);
    const wire = buildProcessQueryWire({
      userText: 'Describe these',
      images: [{ blobId: '/contrib_service/ttl_1d/blob-1', mimeType: 'image/png' }],
      model: 'gemini-4-neon',
      thinking: true,
    });
    const frames = new GrpcMessageReader().push(wire);
    const f1 = parseProtobuf(frames[0]);
    const initial = parseProtobuf(f1.find(f => f.number === 1000)!.payload);
    const ext1001 = parseProtobuf(initial.find(f => f.number === 1001)!.payload);
    const template = parseProtobuf(ext1001.find(f => f.number === 1)!.payload);
    const userQuery = parseProtobuf(template.find(f => f.number === 1)!.payload);
    expect(userQuery.find(f => f.number === 1)?.payload.toString('utf8')).toBe('Describe these');
    const att = parseProtobuf(userQuery.find(f => f.number === 3)!.payload);
    expect(att.find(f => f.number === 2)?.payload.toString('utf8')).toBe('image-1.png');
    const blob = parseProtobuf(att.find(f => f.number === 1)!.payload);
    expect(blob.find(f => f.number === 1)?.payload.toString('utf8')).toBe('/contrib_service/ttl_1d/blob-1');
    expect(blob.find(f => f.number === 2)?.payload[0]).toBe(1);
    expect(blob.find(f => f.number === 3)?.payload.toString('utf8')).toBe('image/png');
    expect(blob.find(f => f.number === 4)?.payload[0]).toBe(1);

    let uploadStarts = 0;
    let uploadFinishes = 0;
    const receivedBlobIdsPerTurn: string[][] = [];
    const receivedTextsPerTurn: string[] = [];
    const pngBytes2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);

    const server = http2.createServer();
    let baseUrl = '';
    server.on('stream', (stream, headers) => {
      const path = String(headers[':path'] ?? '');
      const method = String(headers[':method'] ?? '');
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        if (method === 'POST' && path === '/upload/') {
          uploadStarts += 1;
          expect(headers['authorization']).toBe('Bearer fresh-token');
          expect(headers['push-id']).toBe('feeds/mcudyrk2a4khkz');
          expect(headers['x-tenant-id']).toBe('bard-storage');
          expect(headers['x-goog-upload-protocol']).toBe('resumable');
          expect(headers['x-goog-upload-command']).toBe('start');
          stream.respond({
            ':status': 200,
            'x-goog-upload-status': 'active',
            'x-goog-upload-url': `${baseUrl}/upload/session-${uploadStarts}?upload_id=u${uploadStarts}`,
          });
          stream.end();
          return;
        }
        if (method === 'PUT' && path.startsWith('/upload/session-')) {
          uploadFinishes += 1;
          expect(headers['x-goog-upload-command']).toBe('upload, finalize');
          expect(headers['x-goog-upload-offset']).toBe('0');
          const uploadedBuf = Buffer.concat(chunks);
          expect(uploadedBuf.equals(pngBytes) || uploadedBuf.equals(pngBytes2)).toBe(true);
          stream.respond({ ':status': 200, 'x-goog-upload-status': 'final' });
          stream.end(`/contrib_service/ttl_1d/uploaded-${uploadFinishes}`);
          return;
        }
        if (path === ROBIN_GRPC_PROCESS_QUERY) {
          const reqFrames = new GrpcMessageReader().push(Buffer.concat(chunks));
          const reqF1 = parseProtobuf(reqFrames[0]);
          const reqInit = parseProtobuf(reqF1.find(f => f.number === 1000)!.payload);
          const req1001 = parseProtobuf(reqInit.find(f => f.number === 1001)!.payload);
          const reqTpl = parseProtobuf(req1001.find(f => f.number === 1)!.payload);
          const reqQuery = parseProtobuf(reqTpl.find(f => f.number === 1)!.payload);
          receivedTextsPerTurn.push(reqQuery.find(f => f.number === 1)?.payload.toString('utf8') ?? '');
          const ids = reqQuery
            .filter(f => f.number === 3)
            .map(f => parseProtobuf(parseProtobuf(f.payload).find(a => a.number === 1)!.payload).find(b => b.number === 1)!.payload.toString('utf8'));
          receivedBlobIdsPerTurn.push(ids);

          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({ text: `Saw ${ids.length} image(s)`, completed: true })));
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        stream.respond({ ':status': 404 });
        stream.end();
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Direct helper check
      const direct = await uploadRobinImages({
        images: [{ data: pngBytes, mimeType: 'image/png' }],
        headers: new Headers({ Authorization: 'Bearer fresh-token' }),
        origin: baseUrl,
      });
      expect(direct).toEqual([{ blobId: '/contrib_service/ttl_1d/uploaded-1', mimeType: 'image/png' }]);

      // End-to-end GatewayClient with Robin gRPC automatically uploads image once and reuses cache on turn 2.
      const client = new GatewayClient({
        baseUrl,
        robinUploadOrigin: baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        auth: { accessToken: async () => 'fresh-token' },
      });
      const imageRequest: GeminiRequest = {
        model: 'gemini-4-neon',
        contents: [{
          role: 'user',
          parts: [
            { text: 'What is in this image?' },
            { inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } },
          ],
        }],
      };

      const turn1 = await consume(client.stream(imageRequest));
      const turn2 = await consume(client.stream(imageRequest));
      expect(turn1.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'Saw 1 image(s)' }]);
      expect(turn2.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'Saw 1 image(s)' }]);
      // Direct helper used 1 upload + client turn 1 used 1 upload; turn 2 hit SHA-256 cache!
      expect(uploadStarts).toBe(2);
      expect(uploadFinishes).toBe(2);

      // Follow-up text-only turn: earlier image in turn 0 is replaced with a placeholder and NOT attached or uploaded.
      const followUpTextOnly: GeminiRequest = {
        model: 'gemini-4-hydrogen',
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Look at this old image' },
              { inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } },
            ],
          },
          { role: 'model', parts: [{ text: 'It is a cat.' }] },
          { role: 'user', parts: [{ text: 'Now tell me a joke.' }] },
        ],
      };
      const turn3 = await consume(client.stream(followUpTextOnly));
      expect(turn3.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'Saw 0 image(s)' }]);
      expect(uploadStarts).toBe(2);
      expect(receivedTextsPerTurn[2]).toContain('[Earlier image omitted]');
      expect(receivedTextsPerTurn[2]).not.toContain('[Attached image:');

      // Follow-up turn with a NEW image: only the latest turn's new image is uploaded and attached; old image stays a placeholder.
      const followUpWithNewImage: GeminiRequest = {
        model: 'gemini-4-hydrogen',
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Look at this old image' },
              { inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } },
            ],
          },
          { role: 'model', parts: [{ text: 'It is a cat.' }] },
          {
            role: 'user',
            parts: [
              { text: 'What about this new image?' },
              { inlineData: { mimeType: 'image/png', data: pngBytes2.toString('base64') } },
            ],
          },
        ],
      };
      const turn4 = await consume(client.stream(followUpWithNewImage));
      expect(turn4.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'Saw 1 image(s)' }]);
      expect(uploadStarts).toBe(3);
      expect(uploadFinishes).toBe(3);
      expect(receivedTextsPerTurn[3]).toContain('[Earlier image omitted]');
      expect(receivedTextsPerTurn[3]).toContain('[Attached image: image-1.png (image/png)]');
      expect(receivedBlobIdsPerTurn).toEqual([
        ['/contrib_service/ttl_1d/uploaded-2'],
        ['/contrib_service/ttl_1d/uploaded-2'],
        [],
        ['/contrib_service/ttl_1d/uploaded-3'],
      ]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('decodes GetUserStatus models & thinking levels and builds Option A Robin model lists for Free and Pro accounts', () => {
    const mode17 = Buffer.concat([
      stringField(1, 'cf41b0e0dd7d53e5'),
      stringField(2, 'Flash-Lite'),
      stringField(3, '3.5 Flash-Lite'),
      stringField(19, 'Quick answers'),
      varintField(23, 6),
    ]);
    const policyOptLow = Buffer.concat([stringField(2, 'Low'), stringField(3, 'Fast and efficient'), varintField(4, 1)]);
    const policyOptMed = Buffer.concat([stringField(2, 'Medium'), stringField(3, 'Balanced depth'), varintField(4, 4)]);
    const policyOptHigh = Buffer.concat([stringField(2, 'High'), stringField(3, 'Extra thorough'), varintField(4, 2)]);
    const policyRow = Buffer.concat([
      lengthDelimited(1, Buffer.concat([varintField(3, 6), stringField(6, 'Flash-Lite'), stringField(7, '3.5 Flash-Lite')])),
      lengthDelimited(2, policyOptLow),
      lengthDelimited(2, policyOptMed),
      lengthDelimited(2, policyOptHigh),
    ]);
    const field34 = Buffer.concat([stringField(1, 'launch_free_policy'), lengthDelimited(2, policyRow)]);
    const statusBytes = Buffer.concat([lengthDelimited(17, mode17), lengthDelimited(34, field34)]);

    const decoded = decodeRobinUserStatus(statusBytes);
    expect(decoded.policy).toBe('launch_free_policy');
    expect(decoded.modes).toEqual([{
      modeVariantId: 'cf41b0e0dd7d53e5',
      title: 'Flash-Lite',
      modelName: '3.5 Flash-Lite',
      description: 'Quick answers',
      modeCategory: 6,
      modelId: 'gemini-3.5-flash-lite',
    }]);
    expect(decoded.thinkingOptions.map(o => [o.label, o.thinkingLevel])).toEqual([
      ['Low', 1],
      ['Medium', 4],
      ['High', 2],
    ]);
    expect(slugifyRobinModelId('Auto', 'Auto', 6)).toBe('gemini-robin-flash-lite');

    // Free account list: official 3.5 Flash-Lite + 3 native route tiers + legacy configured gemini-4-neon.
    const freeList = buildRobinListedModels({
      userStatus: decoded,
      plan: 'Free',
      userTier: 'TIER_BASIC',
      configuredModel: 'gemini-4-neon',
      resolveMeta: id => geminiBaseline(id),
    });
    expect(freeList.map(m => m.id)).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-robin-pro',
      'gemini-robin-fast',
      'gemini-robin-flash-lite',
      'gemini-4-neon',
    ]);
    expect(freeList[0].displayName).toContain('官方下发');
    expect(freeList[1].displayName).toContain('原生路由');
    expect(freeList[1].displayName).toContain('3.1 Pro');
    expect(freeList[2].displayName).toContain('4 Hydrogen');

    // Pro account list with multiple official modes:
    const proStatus = {
      policy: 'launch_pro_policy',
      fetchedAt: decoded.fetchedAt,
      thinkingOptions: decoded.thinkingOptions,
      modes: [
        { title: 'Pro', modelName: '4 Neon', modeCategory: 3, modelId: 'gemini-4-neon' },
        { title: 'Fast', modelName: '4 Hydrogen', modeCategory: 1, modelId: 'gemini-4-hydrogen' },
        { title: 'Flash-Lite', modelName: '3.5 Flash-Lite', modeCategory: 6, modelId: 'gemini-3.5-flash-lite' },
      ],
    };
    const proList = buildRobinListedModels({
      userStatus: proStatus,
      plan: 'Pro',
      userTier: 'TIER1',
      resolveMeta: id => geminiBaseline(id),
    });
    expect(proList.slice(0, 3).map(m => m.id)).toEqual(['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.5-flash-lite']);
    expect(proList[0].displayName).toContain('Pro 可用');

    // Catalog lookup aligns Free PRO route to 3.1 Pro and Pro PRO route to 4 Neon.
    expect(robinCatalogLookupIds('gemini-robin-pro', 'Free', 'TIER_BASIC')).toEqual(
      expect.arrayContaining(['gemini-robin-pro', 'gemini-3.1-pro', 'gemini-2.5-pro']),
    );
    expect(robinCatalogLookupIds('gemini-robin-pro', 'Free', 'TIER_BASIC', 'Used 3.1 Pro model')[0]).toBe('gemini-3.1-pro');

    // Route summary flags downgrade when resolvedModeCategory differs from requestedModeCategory.
    const summary = buildRobinRouteSummary({
      model: 'gemini-robin-pro',
      userStatus: decoded,
      plan: 'Free',
      userTier: 'TIER_BASIC',
      observed: {
        requestedModel: 'gemini-robin-pro',
        requestedModeCategory: 3,
        requestedThinkingLevel: 2,
        resolvedModeCategory: 6,
        attribution: 'Used auto model selection',
        downgradeReason: 2,
        observedAt: new Date().toISOString(),
      },
    });
    expect(summary.officialEntitled).toBe(false);
    expect(summary.downgraded).toBe(true);
    expect(summary.lastAttribution).toBe('Used auto model selection');
  });
});
