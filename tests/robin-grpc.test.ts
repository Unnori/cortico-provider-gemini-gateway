import http2 from 'node:http2';
import { describe, expect, it, vi } from 'vitest';
import { classifyRobinCannedRejection, findLatestMediaBatchStart, GatewayClient } from '../src/client.ts';
import { queryGatewayQuota } from '../src/quota.ts';
import {
  acceptRobinTermsOfService,
  buildProcessQueryWire,
  decodeGrpcUsageInfo,
  decodeProcessQueryFrame,
  decodeRobinUserStatus,
  detectRobinImageMime,
  encodeRobinAttachments,
  encodeRobinImageAttachments,
  frameGrpcMessage,
  GrpcMessageReader,
  isRobinGrpcRoute,
  lengthDelimited,
  parseProtobuf,
  resolveRobinAttachmentMime,
  resolveRobinMode,
  ROBIN_GRPC_ACCEPT_TERMS,
  ROBIN_GRPC_GET_TERMS_VERSION,
  ROBIN_GRPC_GET_USAGE_INFO,
  ROBIN_GRPC_GET_USER_STATUS,
  ROBIN_GRPC_PROCESS_QUERY,
  slugifyRobinModelId,
  stringField,
  uploadRobinAttachments,
  uploadRobinImages,
  varintField,
} from '../src/robin-grpc.ts';
import {
  buildRobinListedModels,
  buildRobinRouteSummary,
  detectRobinDowngrade,
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
  fallback?: number;
  downgradeReason?: number;
  resolvedModeCategory?: number;
  resolvedThinkingLevel?: number;
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
  if (opts.fallback !== undefined) clientParts.push(varintField(11, opts.fallback));
  if (opts.attribution) clientParts.push(stringField(30, opts.attribution));
  if (opts.downgradeReason !== undefined) clientParts.push(varintField(31, opts.downgradeReason));
  if (opts.resolvedModeCategory !== undefined) clientParts.push(varintField(41, opts.resolvedModeCategory));
  if (opts.resolvedThinkingLevel !== undefined) clientParts.push(varintField(42, opts.resolvedThinkingLevel));

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

    // Recognizes Google's renamed "Current usage" (groupType=1) as fiveHour and sorts it before Weekly limit (groupType=2).
    const tsCurrent = Buffer.concat([varintField(1, Math.floor(Date.parse('2026-11-20T20:00:00Z') / 1000)), varintField(2, 0)]);
    const tsWeekly = Buffer.concat([varintField(1, Math.floor(Date.parse('2026-11-25T08:00:00Z') / 1000)), varintField(2, 0)]);
    const currentGroup = Buffer.concat([
      varintField(1, 1),
      lengthDelimited(2, Buffer.concat([lengthDelimited(1, tsCurrent), encodeFloat32Field(2, 0.01), stringField(3, 'Current usage')])),
    ]);
    const weeklyGroup = Buffer.concat([
      varintField(1, 2),
      lengthDelimited(2, Buffer.concat([lengthDelimited(1, tsWeekly), encodeFloat32Field(2, 0.022), stringField(3, 'Weekly limit')])),
    ]);
    const renamedQuota = decodeGrpcUsageInfo(Buffer.concat([
      varintField(2, 2),
      lengthDelimited(3, weeklyGroup),
      lengthDelimited(3, currentGroup),
    ]));
    expect(renamedQuota.windows).toEqual([
      { id: 'fiveHour', poolType: 'GXU_FIVE_HOURLY', title: 'Current usage', usedPercent: 1, remainingPercent: 99, resetsAt: '2026-11-20T20:00:00.000Z' },
      { id: 'weekly', poolType: 'GXU_WEEKLY', title: 'Weekly limit', usedPercent: 2.2, remainingPercent: 97.8, resetsAt: '2026-11-25T08:00:00.000Z' },
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
      entitled: true,
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

    // Pro account whose field 17 advertises 4 Carbon (mode 8) while field 34 (neon_pro_policy) omits mode 8:
    // Carbon MUST NOT be marked as "Pro 可用" and MUST be marked Ultra-only with downgrade warning.
    const f17Neon = Buffer.concat([stringField(1, 'v_neon'), stringField(2, 'Neon'), stringField(3, '4 Neon'), varintField(23, 3)]);
    const f17Carbon = Buffer.concat([stringField(1, 'v_carbon'), stringField(2, 'Carbon'), stringField(3, '4 Carbon'), varintField(23, 8)]);
    const f34NeonRow = Buffer.concat([lengthDelimited(1, Buffer.concat([varintField(3, 3), stringField(6, 'Neon'), stringField(7, '4 Neon')]))]);
    const f34CarbonRow = Buffer.concat([lengthDelimited(1, Buffer.concat([varintField(3, 8), stringField(6, 'Carbon'), stringField(7, '4 Carbon')]))]);
    const proRawStatus = decodeRobinUserStatus(Buffer.concat([
      lengthDelimited(17, f17Neon),
      lengthDelimited(17, f17Carbon),
      lengthDelimited(34, Buffer.concat([stringField(1, 'neon_pro_policy'), lengthDelimited(2, f34NeonRow)])),
    ]));
    expect(proRawStatus.modes.find(m => m.modelId === 'gemini-4-neon')?.entitled).toBe(true);
    expect(proRawStatus.modes.find(m => m.modelId === 'gemini-4-carbon')?.entitled).toBe(false);

    const proOnlyCarbonList = buildRobinListedModels({
      userStatus: proRawStatus,
      plan: 'Pro',
      userTier: 'TIER1',
      poolPlans: ['Pro'],
      resolveMeta: id => geminiBaseline(id),
    });
    const proCarbonEntry = proOnlyCarbonList.find(m => m.id === 'gemini-4-carbon')!;
    expect(proCarbonEntry.displayName).toContain('仅 Ultra 可用');
    expect(proCarbonEntry.displayName).toContain('降级');
    expect(proCarbonEntry.displayName).not.toContain('Pro 可用');

    // Ultra account whose field 34 (neon_launch_ultra_policy) includes mode 8:
    // Regular models show "Ultra 可用" (never "Pro 可用") and Carbon shows "仅 Ultra 可用".
    const ultraRawStatus = decodeRobinUserStatus(Buffer.concat([
      lengthDelimited(17, f17Neon),
      lengthDelimited(17, f17Carbon),
      lengthDelimited(34, Buffer.concat([
        stringField(1, 'neon_launch_ultra_policy'),
        lengthDelimited(2, f34NeonRow),
        lengthDelimited(2, f34CarbonRow),
      ])),
    ]));
    expect(ultraRawStatus.modes.find(m => m.modelId === 'gemini-4-carbon')?.entitled).toBe(true);

    const ultraList = buildRobinListedModels({
      userStatus: ultraRawStatus,
      plan: 'Ultra',
      userTier: 'TIER2',
      poolPlans: ['Ultra'],
      resolveMeta: id => geminiBaseline(id),
    });
    expect(ultraList.find(m => m.id === 'gemini-4-neon')?.displayName).toContain('Ultra 可用');
    expect(ultraList.find(m => m.id === 'gemini-4-neon')?.displayName).not.toContain('Pro 可用');
    expect(ultraList.find(m => m.id === 'gemini-4-carbon')?.displayName).toContain('仅 Ultra 可用');
    expect(ultraList.find(m => m.id === 'gemini-4-carbon')?.displayName).not.toContain('Pro 可用');
    expect(ultraList.find(m => m.id === 'gemini-robin-pro')?.displayName).toContain('Ultra 可用');
    expect(ultraList.find(m => m.id === 'gemini-robin-fast')?.displayName).toContain('Ultra 可用');

    // resolveRobinMode maps gemini-4-carbon directly to mode 8 even without cached GetUserStatus.
    expect(resolveRobinMode('gemini-4-carbon', true, 'low')).toEqual({
      modeCategory: 8,
      smartModelSelection: false,
      thinkingLevel: 1,
    });

    // buildRobinRouteSummary marks Carbon as officialEntitled=false on Pro and officialEntitled=true on Ultra.
    const proCarbonSummary = buildRobinRouteSummary({
      model: 'gemini-4-carbon',
      userStatus: proRawStatus,
      plan: 'Pro',
      userTier: 'TIER1',
    });
    expect(proCarbonSummary.ultraOnly).toBe(true);
    expect(proCarbonSummary.officialEntitled).toBe(false);
    const ultraCarbonSummary = buildRobinRouteSummary({
      model: 'gemini-4-carbon',
      userStatus: ultraRawStatus,
      plan: 'Ultra',
      userTier: 'TIER2',
    });
    expect(ultraCarbonSummary.ultraOnly).toBe(true);
    expect(ultraCarbonSummary.officialEntitled).toBe(true);
    expect(ultraCarbonSummary.plan).toBe('Ultra');

    // Catalog lookup aligns Free PRO route to 3.1 Pro and Pro PRO route to 4 Neon.
    expect(robinCatalogLookupIds('gemini-robin-pro', 'Free', 'TIER_BASIC')).toEqual(
      expect.arrayContaining(['gemini-robin-pro', 'gemini-3.1-pro', 'gemini-2.5-pro']),
    );
    expect(robinCatalogLookupIds('gemini-robin-pro', 'Free', 'TIER_BASIC', 'Used 3.1 Pro model')[0]).toBe('gemini-3.1-pro');

    // Route summary flags downgrade when resolvedModeCategory differs from requestedModeCategory.
    const observedAt = '2026-11-21T01:05:40.000Z';
    const summary = buildRobinRouteSummary({
      model: 'gemini-robin-pro',
      thinking: true,
      reasoningEffort: 'low',
      userStatus: decoded,
      plan: 'Free',
      userTier: 'TIER_BASIC',
      observed: {
        requestedModel: 'gemini-robin-pro',
        requestedModeCategory: 3,
        requestedThinkingLevel: 1,
        resolvedModeCategory: 6,
        resolvedThinkingLevel: 1,
        attribution: 'Used auto model selection',
        thoughtChars: 0,
        downgradeReason: 2,
        observedAt,
      },
      observedAccount: 'y***3@gmail.com',
    });
    expect(summary.officialEntitled).toBe(false);
    expect(summary.downgraded).toBe(true);
    expect(summary.requestedThinkingLevel).toBe(1);
    expect(summary.lastResolvedThinkingLevel).toBe(1);
    expect(summary.lastThoughtChars).toBe(0);
    expect(summary.lastAttribution).toBe('Used auto model selection');
    expect(summary.lastObservedAt).toBe(observedAt);
    expect(summary.lastAccount).toBe('y***3@gmail.com');
  });

  it('closes cleanly after completed grace period when HTTP/2 END_STREAM stalls, and cancels immediately on tool-call truncation', async () => {
    let scenario: 'hang-after-completed' | 'hallucinate-after-tool' = 'hang-after-completed';
    let hallucinateStreamClosedEarly = false;
    const openStreams: http2.ServerHttp2Stream[] = [];
    const server = http2.createServer();

    server.on('stream', (stream, headers) => {
      if (headers[':path'] !== ROBIN_GRPC_PROCESS_QUERY) {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      openStreams.push(stream);
      const chunks: Buffer[] = [];
      stream.on('data', c => chunks.push(c as Buffer));
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        if (scenario === 'hang-after-completed') {
          // Server sends `completed: true` frame, then intentionally NEVER sends END_STREAM / trailers.
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: 'All done!',
            responseId: 'rc_hang',
            attribution: 'Gemini 4 Hydrogen',
            completed: true,
          })));
          return;
        }
        // Tool call followed immediately by hallucinated [User] follow-up turn; stream intentionally stays open.
        stream.on('close', () => { hallucinateStreamClosedEarly = true; });
        stream.write(frameGrpcMessage(encodeProcessQueryResponse({
          text: '<tool_call>{"name":"pet_say","args":{"script":"你好呀"}}</tool_call>\n[User]\n假装自己是用户继续胡说八道...',
          responseId: 'rc_trunc',
          attribution: 'Gemini 4 Hydrogen',
          completed: false,
        })));
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
        auth: { accessToken: async () => 'fresh-token' },
      });

      // Case 1: completed=true arrived, server/proxy never closes H2 stream -> finishes via 500ms grace period.
      const t0 = Date.now();
      const chunks1 = await consume(client.stream({
        model: 'gemini-robin-fast',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      }));
      const elapsed1 = Date.now() - t0;
      expect(elapsed1).toBeLessThan(2_500);
      expect(chunks1.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'All done!' }]);
      expect(chunks1.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');

      // Case 2: model hallucinates follow-up turn after <tool_call> -> immediately yields valid call & cancels upstream stream!
      scenario = 'hallucinate-after-tool';
      const t1 = Date.now();
      const chunks2 = await consume(client.stream({
        model: 'gemini-robin-fast',
        tools: [{ functionDeclarations: [{ name: 'pet_say', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'say hi' }] }],
      }));
      const elapsed2 = Date.now() - t1;
      expect(elapsed2).toBeLessThan(1_000);
      expect(chunks2.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'pet_say', args: { script: '你好呀' } } },
      ]);
      expect(chunks2.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(hallucinateStreamClosedEarly).toBe(true);
    } finally {
      for (const s of openStreams) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('handles missing completed/grpc-status with idle timeout, preserves mid-stream pauses, and marks incomplete tool tags without executing them', async () => {
    type Scenario = 'plain-text-stalled' | 'mid-stream-pause' | 'partial-tool-stalled' | 'closed-tool-stalled' | 'odd-quote-tool-stalled' | 'eof-without-trailers';
    let scenario: Scenario = 'plain-text-stalled';
    const openStreams: http2.ServerHttp2Stream[] = [];
    const server = http2.createServer();

    server.on('stream', (stream, headers) => {
      if (headers[':path'] !== ROBIN_GRPC_PROCESS_QUERY) {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      openStreams.push(stream);
      const chunks: Buffer[] = [];
      stream.on('data', c => chunks.push(c as Buffer));
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        if (scenario === 'plain-text-stalled') {
          // Plain text arrives with completed=0, stream never sends completed=1 or END_STREAM.
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '这是一段正常正文，但末尾完成信号丢了。',
            responseId: 'rc_idle_plain',
            attribution: 'Gemini 4 Hydrogen',
            completed: false,
          })));
          return;
        }
        if (scenario === 'mid-stream-pause') {
          // Part 1 arrives, pauses for 120ms (< textIdleTimeoutMs=250ms), then continues and sends completed=1.
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '第一段正文，',
            responseId: 'rc_pause',
            attribution: 'Gemini 4 Hydrogen',
            completed: false,
          })));
          setTimeout(() => {
            if (stream.closed || stream.destroyed) return;
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              text: '第一段正文，停顿后继续说完啦！',
              responseId: 'rc_pause',
              attribution: 'Gemini 4 Hydrogen',
              completed: true,
            })));
            stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
            stream.end();
          }, 120);
          return;
        }
        if (scenario === 'partial-tool-stalled') {
          // Cut off mid-<tool_call> JSON with no completed=1 and no END_STREAM.
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '准备说话\n<tool_call>{"name":"pet_say","args":{"script":"没说',
            responseId: 'rc_partial_tool',
            attribution: 'Gemini 4 Hydrogen',
            completed: false,
          })));
          return;
        }
        if (scenario === 'closed-tool-stalled') {
          // Complete closed <tool_call>...</tool_call> arrives with completed=0, tail frames lost.
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '<tool_call>{"name":"pet_say","args":{"script":"早安呀！"}}</tool_call>',
            responseId: 'rc_closed_tool',
            attribution: 'Gemini 4 Hydrogen',
            completed: false,
          })));
          return;
        }
        if (scenario === 'odd-quote-tool-stalled') {
          // Closed <tool_call> with an odd unescaped double quote inside string, stalled tail without completed=1.
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '<tool_call>{"name":"wechat_send","args":{"text":"买了个 15" 屏幕"}}</tool_call>',
            responseId: 'rc_odd_quote_tool',
            attribution: 'Gemini 4 Neon',
            completed: false,
          })));
          return;
        }
        // eof-without-trailers: HTTP/2 END_STREAM arrives without completed=1 and without grpc-status trailer.
        stream.write(frameGrpcMessage(encodeProcessQueryResponse({
          text: '无 trailers 直接断开的正文',
          responseId: 'rc_eof_notrailers',
          attribution: 'Gemini 4 Hydrogen',
          completed: false,
        })));
        stream.end();
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const repairedCalls: { name: string; strategy: string }[] = [];
      const client = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        robinTextIdleTimeoutMs: 250,
        robinToolIdleTimeoutMs: 120,
        onToolCallRepair: info => repairedCalls.push(info),
        auth: { accessToken: async () => 'fresh-token' },
      });

      // 1. Plain text stalled with completed=0 -> exits promptly via text idle timeout, preserves text, marks incomplete (MAX_TOKENS).
      const t0 = Date.now();
      const res1 = await consume(client.stream({
        model: 'gemini-robin-fast',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }));
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(res1.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text).join('')).toBe('这是一段正常正文，但末尾完成信号丢了。');
      expect(res1.at(-1)?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');

      // 2. Mid-stream pause shorter than textIdleTimeoutMs -> NOT cut off, completes cleanly with STOP.
      scenario = 'mid-stream-pause';
      const res2 = await consume(client.stream({
        model: 'gemini-robin-fast',
        contents: [{ role: 'user', parts: [{ text: 'long reply' }] }],
      }));
      expect(res2.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text).join('')).toBe('第一段正文，停顿后继续说完啦！');
      expect(res2.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');

      // 3. Unclosed <tool_call> stalled -> NEVER emits executable functionCall, preserves text, marks incomplete (MAX_TOKENS).
      scenario = 'partial-tool-stalled';
      const res3 = await consume(client.stream({
        model: 'gemini-robin-fast',
        tools: [{ functionDeclarations: [{ name: 'pet_say', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'talk' }] }],
      }));
      const parts3 = res3.flatMap(c => c.candidates?.[0]?.content?.parts ?? []);
      expect(parts3.filter(p => p.functionCall)).toEqual([]);
      expect(parts3.map(p => p.text ?? '').join('')).toContain('准备说话');
      expect(res3.at(-1)?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');

      // 4. Cleanly closed <tool_call>...</tool_call> stalled without completed=1 -> exits via shorter tool idle timeout and allows STOP execution.
      scenario = 'closed-tool-stalled';
      const t4 = Date.now();
      const res4 = await consume(client.stream({
        model: 'gemini-robin-fast',
        tools: [{ functionDeclarations: [{ name: 'pet_say', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'greet' }] }],
      }));
      expect(Date.now() - t4).toBeLessThan(1_000);
      expect(res4.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'pet_say', args: { script: '早安呀！' } } },
      ]);
      expect(res4.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');

      // 4b. Closed <tool_call> with an odd unescaped quote stalled without completed=1 -> recovers cleanly at finish() with STOP.
      scenario = 'odd-quote-tool-stalled';
      const res4b = await consume(client.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'wechat_send', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'send screen size' }] }],
      }));
      expect(res4b.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'wechat_send', args: { text: '买了个 15" 屏幕' } } },
      ]);
      expect(res4b.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');
      expect(repairedCalls).toEqual([{ name: 'wechat_send', strategy: 'lenient-json' }]);

      // 5. HTTP/2 stream ends cleanly without completed=1 and without grpc-status -> preserves text and marks incomplete.
      scenario = 'eof-without-trailers';
      const res5 = await consume(client.stream({
        model: 'gemini-robin-fast',
        contents: [{ role: 'user', parts: [{ text: 'eof' }] }],
      }));
      expect(res5.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text).join('')).toBe('无 trailers 直接断开的正文');
      expect(res5.at(-1)?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');
    } finally {
      for (const s of openStreams) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('uses shorter end_turn idle timeout and ignores empty heartbeat frames when counting idle time', async () => {
    let mode: 'end-turn' | 'heartbeat-spam' = 'end-turn';
    const openStreams: http2.ServerHttp2Stream[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];
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
        if (mode === 'end-turn') {
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '<tool_call>{"name":"pet_say","args":{"script":"晚安"}}</tool_call><tool_call>{"name":"end_turn","args":{}}</tool_call>',
            responseId: 'rc_end_turn',
            completed: false,
          })));
          return;
        }
        // Send visible text once, then keep sending empty outer=[1014] & duplicate-length frames every 40ms.
        stream.write(frameGrpcMessage(encodeProcessQueryResponse({
          text: '正文已说完，后面全是空心跳',
          responseId: 'rc_hb',
          completed: false,
        })));
        const iv = setInterval(() => {
          if (stream.closed || stream.destroyed) {
            clearInterval(iv);
            return;
          }
          stream.write(frameGrpcMessage(lengthDelimited(1014, Buffer.from('hb'))));
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '正文已说完，后面全是空心跳',
            responseId: 'rc_hb',
            completed: false,
          })));
        }, 40);
        intervals.push(iv);
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
        robinTextIdleTimeoutMs: 220,
        robinToolIdleTimeoutMs: 600,
        robinEndTurnIdleTimeoutMs: 90,
        auth: { accessToken: async () => 'fresh-token' },
      });

      // 1. Trailing end_turn exits via endTurnIdleTimeoutMs (90ms), well below toolIdleTimeoutMs (600ms).
      const t0 = Date.now();
      const res1 = await consume(client.stream({
        model: 'gemini-robin-fast',
        tools: [{ functionDeclarations: [{ name: 'pet_say', parametersJsonSchema: { type: 'object' } }, { name: 'end_turn', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'goodnight' }] }],
      }));
      const elapsed1 = Date.now() - t0;
      expect(elapsed1).toBeLessThan(400);
      expect(res1.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).filter(p => p.functionCall).map(p => p.functionCall?.name)).toEqual(['pet_say', 'end_turn']);
      expect(res1.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');

      // 2. Empty/duplicate heartbeat frames every 40ms must NOT extend the 220ms text idle timer.
      mode = 'heartbeat-spam';
      const t1 = Date.now();
      const res2 = await consume(client.stream({
        model: 'gemini-robin-fast',
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      }));
      const elapsed2 = Date.now() - t1;
      expect(elapsed2).toBeLessThan(650);
      expect(res2.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text).join('')).toBe('正文已说完，后面全是空心跳');
      expect(res2.at(-1)?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');
    } finally {
      for (const iv of intervals) clearInterval(iv);
      for (const s of openStreams) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('supports multimodal attachments (audio, video, PDF, GIF, text) via Robin Scotty upload with per-account caching and earlier-turn pruning', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n', 'latin1');
    const mp3Bytes = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from([0xff, 0xfb, 0x90, 0x00])]);
    const wavBytes = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1');
    const oggBytes = Buffer.from('OggS\x00\x02\x00\x00', 'latin1');
    const flacBytes = Buffer.from('fLaC\x00\x00\x00\x22', 'latin1');
    const mp4Bytes = Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00', 'latin1');
    const m4aBytes = Buffer.from('\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00', 'latin1');
    const webmBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    const gifBytes = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
    const txtBytes = Buffer.from('Hello Robin text attachment', 'utf8');

    expect(resolveRobinAttachmentMime(pdfBytes, 'application/pdf')).toBe('application/pdf');
    expect(resolveRobinAttachmentMime(Buffer.from('not-a-pdf'), 'application/pdf')).toBeNull();
    expect(resolveRobinAttachmentMime(Buffer.from('not-a-png'), 'image/png')).toBeNull();
    expect(resolveRobinAttachmentMime(gifBytes)).toBe('image/gif');
    expect(resolveRobinAttachmentMime(wavBytes)).toBe('audio/wav');
    expect(resolveRobinAttachmentMime(oggBytes)).toBe('audio/ogg');
    expect(resolveRobinAttachmentMime(flacBytes)).toBe('audio/flac');
    expect(resolveRobinAttachmentMime(mp3Bytes, 'audio/mp3')).toBe('audio/mpeg');
    expect(resolveRobinAttachmentMime(mp4Bytes)).toBe('video/mp4');
    expect(resolveRobinAttachmentMime(m4aBytes)).toBe('audio/mp4');
    expect(resolveRobinAttachmentMime(mp4Bytes, 'audio/x-m4a')).toBe('audio/mp4');
    expect(resolveRobinAttachmentMime(webmBytes)).toBe('video/webm');
    expect(resolveRobinAttachmentMime(webmBytes, 'audio/webm')).toBe('audio/webm');
    expect(resolveRobinAttachmentMime(txtBytes, 'text/plain; charset=utf-8')).toBe('text/plain');
    expect(resolveRobinAttachmentMime(Buffer.from([0x01, 0x02]), 'application/octet-stream')).toBeNull();

    const encodedMixed = encodeRobinAttachments([
      { blobId: '/contrib_service/ttl_1d/a1', mimeType: 'audio/mpeg' },
      { blobId: '/contrib_service/ttl_1d/v1', mimeType: 'video/mp4' },
      { blobId: '/contrib_service/ttl_1d/f1', mimeType: 'application/pdf' },
    ]);
    expect(encodedMixed.map(buf => parseProtobuf(parseProtobuf(buf)[0].payload).find(f => f.number === 2)?.payload.toString('utf8'))).toEqual([
      'audio-1.mp3',
      'video-1.mp4',
      'file-1.pdf',
    ]);

    const uploadedContentTypes: string[] = [];
    const receivedAttachmentsPerTurn: Array<Array<{ blobId: string; mimeType: string; name: string }>> = [];
    const receivedTextsPerTurn: string[] = [];
    let uploadCounter = 0;

    const server = http2.createServer();
    let baseUrl = '';
    server.on('stream', (stream, headers) => {
      const path = String(headers[':path'] ?? '');
      const method = String(headers[':method'] ?? '');
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        if (method === 'POST' && path === '/upload/') {
          uploadCounter += 1;
          uploadedContentTypes.push(String(headers['x-goog-upload-content-type'] ?? ''));
          stream.respond({
            ':status': 200,
            'x-goog-upload-status': 'active',
            'x-goog-upload-url': `${baseUrl}/upload/media-${uploadCounter}`,
          });
          stream.end();
          return;
        }
        if (method === 'PUT' && path.startsWith('/upload/media-')) {
          const idx = path.slice('/upload/media-'.length);
          stream.respond({ ':status': 200, 'x-goog-upload-status': 'final' });
          stream.end(`/contrib_service/ttl_1d/media-${idx}`);
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
          const atts = reqQuery.filter(f => f.number === 3).map(f => {
            const attFields = parseProtobuf(f.payload);
            const blobFields = parseProtobuf(attFields.find(a => a.number === 1)!.payload);
            return {
              blobId: blobFields.find(b => b.number === 1)!.payload.toString('utf8'),
              mimeType: blobFields.find(b => b.number === 3)!.payload.toString('utf8'),
              name: attFields.find(a => a.number === 2)!.payload.toString('utf8'),
            };
          });
          receivedAttachmentsPerTurn.push(atts);

          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({ text: `Saw ${atts.length} attachment(s)`, completed: true })));
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
      const direct = await uploadRobinAttachments({
        attachments: [{ data: pdfBytes, mimeType: 'application/pdf' }],
        headers: new Headers({ Authorization: 'Bearer fresh-token' }),
        origin: baseUrl,
      });
      expect(direct).toEqual([{ blobId: '/contrib_service/ttl_1d/media-1', mimeType: 'application/pdf' }]);

      const client = new GatewayClient({
        baseUrl,
        robinUploadOrigin: baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        auth: { accessToken: async () => 'fresh-token' },
      });

      const multimodalReq: GeminiRequest = {
        model: 'gemini-4-neon',
        contents: [{
          role: 'user',
          parts: [
            { text: 'Analyze audio, video, and PDF' },
            { inlineData: { mimeType: 'audio/mp3', data: mp3Bytes.toString('base64') } },
            { inlineData: { mimeType: 'video/mp4', data: mp4Bytes.toString('base64') } },
            { inlineData: { mimeType: 'application/pdf', data: pdfBytes.toString('base64') } },
          ],
        }],
      };

      const turn1 = await consume(client.stream(multimodalReq));
      const turn2 = await consume(client.stream(multimodalReq));
      expect(turn1.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'Saw 3 attachment(s)' }]);
      expect(turn2.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'Saw 3 attachment(s)' }]);
      // Direct helper (1) + Turn 1 (3) = 4 total; Turn 2 hits SHA-256 cache cleanly.
      expect(uploadedContentTypes).toEqual(['application/pdf', 'audio/mpeg', 'video/mp4', 'application/pdf']);
      expect(receivedAttachmentsPerTurn[0]).toEqual([
        { blobId: '/contrib_service/ttl_1d/media-2', mimeType: 'audio/mpeg', name: 'audio-1.mp3' },
        { blobId: '/contrib_service/ttl_1d/media-3', mimeType: 'video/mp4', name: 'video-1.mp4' },
        { blobId: '/contrib_service/ttl_1d/media-4', mimeType: 'application/pdf', name: 'file-1.pdf' },
      ]);
      expect(receivedTextsPerTurn[0]).toContain('[Attached audio: audio-1.mp3 (audio/mpeg)]');
      expect(receivedTextsPerTurn[0]).toContain('[Attached video: video-1.mp4 (video/mp4)]');
      expect(receivedTextsPerTurn[0]).toContain('[Attached file: file-1.pdf (application/pdf)]');

      // Follow-up text-only turn prunes earlier audio/PDF into compact placeholders without re-uploading.
      const followUp: GeminiRequest = {
        model: 'gemini-4-neon',
        contents: [
          multimodalReq.contents[0],
          { role: 'model', parts: [{ text: 'Done analyzing.' }] },
          { role: 'user', parts: [{ text: 'Summarize briefly.' }] },
        ],
      };
      const turn3 = await consume(client.stream(followUp));
      expect(turn3.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{ text: 'Saw 0 attachment(s)' }]);
      expect(uploadedContentTypes).toHaveLength(4);
      expect(receivedAttachmentsPerTurn[2]).toEqual([]);
      expect(receivedTextsPerTurn[2]).toContain('[Earlier attachment omitted]');
      expect(receivedTextsPerTurn[2]).not.toContain('[Attached audio:');
      expect(receivedTextsPerTurn[2]).not.toContain('[Attached file:');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('recovers cleanly when Robin auto-linkifies URLs mid-stream or rewrites cumulative frame prefixes', async () => {
    type CaseName = 'tool-autolink' | 'prose-autolink' | 'tool-prefix-rewrite' | 'prose-prefix-rewrite';
    let currentCase: CaseName = 'tool-autolink';
    const server = http2.createServer();

    server.on('stream', (stream, headers) => {
      if (headers[':path'] !== ROBIN_GRPC_PROCESS_QUERY) {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      stream.resume();
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        const writeFrame = (text: string, completed = false) => {
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text,
            responseId: `rc_${currentCase}`,
            attribution: 'Used 4 Neon model',
            completed,
          })));
        };

        if (currentCase === 'tool-autolink') {
          // Exact live wire reproduction: Robin auto-links partial URL at :77, then rewrites to :7788/health.
          writeFrame('<tool_call>{"name":"workspace_run","args');
          writeFrame('<tool_call>{"name":"workspace_run","args":{"command":"bash","args":["-lc","curl -s -m 6 [http://127.0.0.1:77](http://127.0.0.1:77)');
          writeFrame('<tool_call>{"name":"workspace_run","args":{"command":"bash","args":["-lc","curl -s -m 6 [http://127.0.0.1:7788/health](http://127.0.0.1:7788/health) && echo ok"]}}</tool_call>', true);
        } else if (currentCase === 'prose-autolink') {
          writeFrame('Visit [https://github.com/Unnori/cortico](https://github.com/Unnori/cortico)');
          writeFrame('Visit [https://github.com/Unnori/cortico-provider-gemini-gateway](https://github.com/Unnori/cortico-provider-gemini-gateway) and [www.google.com](https://www.google.com) done.', true);
        } else if (currentCase === 'tool-prefix-rewrite') {
          // Non-auto-link prefix rewrite inside an open, not-yet-emitted <tool_call>.
          writeFrame('先查一下\n<tool_call>{"name":"run","args":{"q":"foo');
          writeFrame('先查一下\n<tool_call>{"name":"run","args":{"q":"[foo](https://custom.example) done"}}</tool_call>', true);
        } else {
          // Non-auto-link prefix rewrite in already-emitted plain prose followed by a tool call.
          writeFrame('请看 example.com');
          writeFrame('请看 [example.com](https://docs.example.com) 后面继续\n<tool_call>{"name":"end_turn","args":{}}</tool_call>', true);
        }

        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
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
        auth: { accessToken: async () => 'fresh-token' },
      });

      currentCase = 'tool-autolink';
      const r1 = await consume(client.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'workspace_run', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'check health' }] }],
      }));
      expect(r1.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([{
        functionCall: {
          name: 'workspace_run',
          args: { command: 'bash', args: ['-lc', 'curl -s -m 6 http://127.0.0.1:7788/health && echo ok'] },
        },
      }]);
      expect(r1.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');

      currentCase = 'prose-autolink';
      const r2 = await consume(client.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'links' }] }],
      }));
      expect(r2.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')).toBe(
        'Visit https://github.com/Unnori/cortico-provider-gemini-gateway and www.google.com done.',
      );

      currentCase = 'tool-prefix-rewrite';
      const r3 = await consume(client.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'run', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'search' }] }],
      }));
      const parts3 = r3.flatMap(c => c.candidates?.[0]?.content?.parts ?? []);
      expect(parts3.filter(p => p.text).map(p => p.text).join('')).toBe('先查一下\n');
      expect(parts3.filter(p => p.functionCall)).toEqual([
        { functionCall: { name: 'run', args: { q: '[foo](https://custom.example) done' } } },
      ]);

      currentCase = 'prose-prefix-rewrite';
      const r4 = await consume(client.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'end_turn', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'bye' }] }],
      }));
      const parts4 = r4.flatMap(c => c.candidates?.[0]?.content?.parts ?? []);
      expect(parts4.filter(p => p.text).map(p => p.text).join('')).toBe('请看 example.com 后面继续\n');
      expect(parts4.filter(p => p.functionCall)).toEqual([
        { functionCall: { name: 'end_turn', args: {} } },
      ]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('intercepts Robin transient canned errors (retry on single account, failover on multi-account, preserve legitimate quotes)', async () => {
    type Mode = 'single-retry-ok' | 'multi-failover-ok' | 'persistent-canned' | 'quoted-canned' | 'prefix-only';
    let mode: Mode = 'single-retry-ok';
    let callCount = 0;
    const seenTokens: string[] = [];
    const server = http2.createServer();

    server.on('stream', (stream, headers) => {
      if (headers[':path'] !== ROBIN_GRPC_PROCESS_QUERY) {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      seenTokens.push(String(headers.authorization ?? ''));
      callCount += 1;
      const attemptNo = callCount;
      stream.resume();
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        const send = (text: string, completed = false) => {
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text,
            responseId: `rc_canned_${attemptNo}`,
            attribution: 'Used 4 Neon model',
            completed,
          })));
        };

        if (mode === 'single-retry-ok') {
          if (attemptNo === 1) {
            // Split across 2 frames to verify prefix buffering holds cleanly without leaking downstream.
            send('I seem to be encountering ');
            send('I seem to be encountering an error. Can I try something else for you?', true);
          } else {
            send('<tool_call>{"name":"pet_say","args":{"script":"重试成功啦！"}}</tool_call>', true);
          }
        } else if (mode === 'multi-failover-ok') {
          if (attemptNo === 1) {
            send('I encountered an error doing what you asked. Could you try again?', true);
          } else {
            send('二号账号接力成功！', true);
          }
        } else if (mode === 'persistent-canned') {
          send('Sorry, something went wrong. Please try your request again.', true);
        } else if (mode === 'quoted-canned') {
          send('I seem to be encountering an error. Can I try something else for you?');
          send('I seem to be encountering an error. Can I try something else for you? 这句话是 Google 返回的。', true);
        } else {
          send('I seem to be', true);
        }

        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Single account: retries once without forcing OAuth refresh and returns clean tool call.
      const events1: { accountId?: string; action: string }[] = [];
      const refreshFlags: boolean[] = [];
      const singleClient = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        robinTransientRetryDelayMs: 0,
        onRobinTransientError: info => events1.push({ accountId: info.accountId, action: info.action }),
        auth: {
          accessToken: async force => {
            refreshFlags.push(Boolean(force));
            return 'tok-single';
          },
        },
      });
      mode = 'single-retry-ok';
      callCount = 0;
      const res1 = await consume(singleClient.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'pet_say', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      }));
      expect(res1.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'pet_say', args: { script: '重试成功啦！' } } },
      ]);
      expect(events1).toEqual([{ accountId: undefined, action: 'retry' }]);
      expect(refreshFlags).toEqual([false, false]);

      // 2. Multi-account: fails over to second account WITHOUT putting first account into failure cooldown.
      const failedAccounts: string[] = [];
      const succeededAccounts: string[] = [];
      const events2: { accountId?: string; action: string }[] = [];
      const multiClient = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        robinTransientRetryDelayMs: 0,
        onRobinTransientError: info => events2.push({ accountId: info.accountId, action: info.action }),
        auth: {
          accessToken: async () => 'tok-default',
          selectAccounts: () => ['acct_1', 'acct_2'],
          accessTokenFor: async id => `tok-${id}`,
          onAccountFailure: id => failedAccounts.push(id),
          onAccountSuccess: id => succeededAccounts.push(id),
        },
      });
      mode = 'multi-failover-ok';
      callCount = 0;
      seenTokens.length = 0;
      const res2 = await consume(multiClient.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      }));
      expect(res2.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')).toBe('二号账号接力成功！');
      expect(seenTokens).toEqual(['Bearer tok-acct_1', 'Bearer tok-acct_2']);
      expect(failedAccounts).toEqual([]);
      expect(succeededAccounts).toEqual(['acct_2']);
      expect(events2).toEqual([{ accountId: 'acct_1', action: 'failover' }]);

      // 3. Persistent canned error: throws GatewayError(503) instead of polluting conversation history.
      mode = 'persistent-canned';
      callCount = 0;
      await expect(consume(singleClient.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'bad media' }] }],
      }))).rejects.toMatchObject({ status: 503 });
      expect(callCount).toBe(2);

      // 4. Legitimate reply quoting the canned error followed by explanation is preserved intact.
      mode = 'quoted-canned';
      callCount = 0;
      const res4 = await consume(singleClient.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'explain error' }] }],
      }));
      expect(res4.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')).toBe(
        'I seem to be encountering an error. Can I try something else for you? 这句话是 Google 返回的。',
      );
      expect(callCount).toBe(1);

      // 5. Short partial prefix that is not the full canned error is flushed cleanly at end-of-stream.
      mode = 'prefix-only';
      callCount = 0;
      const res5 = await consume(singleClient.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'short' }] }],
      }));
      expect(res5.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')).toBe('I seem to be');
      expect(callCount).toBe(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('uses longer openToolIdleTimeoutMs while <tool_call> is open and fails over if an initial <tool_call> stub still stalls', async () => {
    type Mode = 'slow-open-tool' | 'stalled-open-stub-failover';
    let mode: Mode = 'slow-open-tool';
    let attemptCount = 0;
    const openStreams: http2.ServerHttp2Stream[] = [];
    const server = http2.createServer();

    server.on('stream', (stream, headers) => {
      if (headers[':path'] !== ROBIN_GRPC_PROCESS_QUERY) {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      openStreams.push(stream);
      attemptCount += 1;
      const currentAttempt = attemptCount;
      stream.resume();
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        if (mode === 'slow-open-tool') {
          // Sends opening `<tool_call>{"` and pauses 220ms (> textIdleTimeoutMs=120ms, < openToolIdleTimeoutMs=500ms).
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '<tool_call>{"',
            responseId: 'rc_slow_open',
            attribution: 'Used 4 Neon model',
            completed: false,
          })));
          setTimeout(() => {
            if (stream.closed || stream.destroyed) return;
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              text: '<tool_call>{"name":"wechat_send","args":{"text":"长工具调用稳稳吐完啦"}}</tool_call>',
              responseId: 'rc_slow_open',
              attribution: 'Used 4 Neon model',
              completed: true,
            })));
            stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
            stream.end();
          }, 220);
          return;
        }
        // stalled-open-stub-failover: attempt 1 stalls permanently on `<tool_call>{"`, attempt 2 completes cleanly.
        if (currentAttempt === 1) {
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text: '<tool_call>{"',
            responseId: 'rc_stub_1',
            attribution: 'Used 4 Neon model',
            completed: false,
          })));
          return;
        }
        stream.write(frameGrpcMessage(encodeProcessQueryResponse({
          text: '<tool_call>{"name":"wechat_send","args":{"text":"切号补救成功"}}</tool_call>',
          responseId: 'rc_stub_2',
          attribution: 'Used 4 Neon model',
          completed: true,
        })));
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const slowClient = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        robinTextIdleTimeoutMs: 120,
        robinOpenToolIdleTimeoutMs: 500,
        auth: { accessToken: async () => 'tok' },
      });
      mode = 'slow-open-tool';
      attemptCount = 0;
      const slowRes = await consume(slowClient.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'wechat_send', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'write long reply' }] }],
      }));
      expect(slowRes.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'wechat_send', args: { text: '长工具调用稳稳吐完啦' } } },
      ]);
      expect(slowRes.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');

      const failedAccounts: string[] = [];
      const transientEvents: { accountId?: string; action: string }[] = [];
      const failoverClient = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        robinTextIdleTimeoutMs: 120,
        robinOpenToolIdleTimeoutMs: 120,
        robinTransientRetryDelayMs: 0,
        onRobinTransientError: info => transientEvents.push({ accountId: info.accountId, action: info.action }),
        auth: {
          accessToken: async () => 'tok',
          selectAccounts: () => ['acct_1', 'acct_2'],
          accessTokenFor: async id => `tok-${id}`,
          onAccountFailure: id => failedAccounts.push(id),
        },
      });
      mode = 'stalled-open-stub-failover';
      attemptCount = 0;
      const recovered = await consume(failoverClient.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'wechat_send', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'retry stub' }] }],
      }));
      expect(recovered.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'wechat_send', args: { text: '切号补救成功' } } },
      ]);
      expect(recovered.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');
      expect(failedAccounts).toEqual([]);
      expect(transientEvents).toEqual([{ accountId: 'acct_1', action: 'failover' }]);
    } finally {
      for (const s of openStreams) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('keeps media across the latest preempted or interrupted input batch while pruning earlier completed turns', async () => {
    const evfCall = (id: string) => ({
      role: 'model' as const,
      parts: [{ functionCall: { name: 'external_event_frame', id, args: {} } }],
    });
    const evfResult = (id: string, output: string, extra: GeminiRequest['contents'][number]['parts'] = []) => ({
      role: 'user' as const,
      parts: [{ functionResponse: { name: 'external_event_frame', id, response: { output } } }, ...extra],
    });
    const pngBytes = (seed: number) => Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
      Buffer.from([seed, seed + 1, seed + 2, seed + 3]),
    ]);
    const wavBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00,
    ]);

    // Pure boundary checks:
    expect(findLatestMediaBatchStart([
      { role: 'user', parts: [{ text: 'old' }] },
      { role: 'model', parts: [{ functionCall: { name: 'end_turn', id: 'c1', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'end_turn', id: 'c1', response: { output: '[turn ended]' } } }] },
      evfCall('evf_1'),
      evfResult('evf_1', '[1 new event] sent image'),
      evfCall('evf_2'),
      evfResult('evf_2', '[1 new event] follow-up preempt'),
    ])).toBe(2);

    expect(findLatestMediaBatchStart([
      evfCall('evf_1'),
      evfResult('evf_1', '[1 new event] sent image'),
      { role: 'model', parts: [{ functionCall: { name: 'read_file', id: 'c_read', args: { path: 'a.ts' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', id: 'c_read', response: { output: 'export const x = 1;' } } }] },
    ])).toBe(3);

    expect(findLatestMediaBatchStart([
      { role: 'user', parts: [{ text: 'part 1' }] },
      { role: 'user', parts: [{ text: 'part 2' }] },
    ])).toBe(0);

    const uploadedContentTypes: string[] = [];
    const receivedAttachmentsPerTurn: Array<Array<{ blobId: string; mimeType: string; name: string }>> = [];
    const receivedTextsPerTurn: string[] = [];
    let uploadCounter = 0;

    const server = http2.createServer();
    let baseUrl = '';
    server.on('stream', (stream, headers) => {
      const path = String(headers[':path'] ?? '');
      const method = String(headers[':method'] ?? '');
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        if (method === 'POST' && path === '/upload/') {
          uploadCounter += 1;
          uploadedContentTypes.push(String(headers['x-goog-upload-content-type'] ?? ''));
          stream.respond({
            ':status': 200,
            'x-goog-upload-status': 'active',
            'x-goog-upload-url': `${baseUrl}/upload/batch-${uploadCounter}`,
          });
          stream.end();
          return;
        }
        if (method === 'PUT' && path.startsWith('/upload/batch-')) {
          const idx = path.slice('/upload/batch-'.length);
          stream.respond({ ':status': 200, 'x-goog-upload-status': 'final' });
          stream.end(`/contrib_service/ttl_1d/batch-${idx}`);
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
          const atts = reqQuery.filter(f => f.number === 3).map(f => {
            const attFields = parseProtobuf(f.payload);
            const blobFields = parseProtobuf(attFields.find(a => a.number === 1)!.payload);
            return {
              blobId: blobFields.find(b => b.number === 1)!.payload.toString('utf8'),
              mimeType: blobFields.find(b => b.number === 3)!.payload.toString('utf8'),
              name: attFields.find(a => a.number === 2)!.payload.toString('utf8'),
            };
          });
          receivedAttachmentsPerTurn.push(atts);

          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({ text: `Saw ${atts.length} attachment(s)`, completed: true })));
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
      const client = new GatewayClient({
        baseUrl,
        robinUploadOrigin: baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        auth: { accessToken: async () => 'fresh-token' },
      });

      const oldImg = pngBytes(1).toString('base64');
      const img1 = pngBytes(2).toString('base64');
      const audio1 = wavBytes.toString('base64');

      // 1) Initial attempt with img1 (before preempt) uploads img1 once.
      const beforePreempt: GeminiRequest = {
        model: 'gemini-4-neon',
        contents: [
          evfCall('evf_0'),
          evfResult('evf_0', '[1 new event] earlier image', [{ inlineData: { mimeType: 'image/png', data: oldImg } }]),
          { role: 'model', parts: [{ functionCall: { name: 'end_turn', id: 'c_old', args: {} } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'end_turn', id: 'c_old', response: { output: '[turn ended]' } } }] },
          evfCall('evf_1'),
          evfResult('evf_1', '[1 new event] check this photo', [{ inlineData: { mimeType: 'image/png', data: img1 } }]),
        ],
      };
      await consume(client.stream(beforePreempt));
      expect(uploadedContentTypes).toEqual(['image/png']);
      expect(receivedAttachmentsPerTurn[0]).toEqual([
        { blobId: '/contrib_service/ttl_1d/batch-1', mimeType: 'image/png', name: 'image-1.png' },
      ]);
      expect(receivedTextsPerTurn[0]).toContain('[Earlier image omitted]');

      // 2) Preempted by follow-up text + voice frames: img1 is preserved (and served from SHA-256 cache),
      //    audio1 is uploaded alongside it, while oldImg stays omitted.
      const afterPreempt: GeminiRequest = {
        model: 'gemini-4-neon',
        contents: [
          ...beforePreempt.contents,
          evfCall('evf_2'),
          evfResult('evf_2', '[1 new event] wait look at the top-left corner'),
          evfCall('evf_3'),
          evfResult('evf_3', '[1 new event] voice follow-up', [{ inlineData: { mimeType: 'audio/wav', data: audio1 } }]),
        ],
      };
      await consume(client.stream(afterPreempt));
      expect(uploadedContentTypes).toEqual(['image/png', 'audio/wav']);
      expect(receivedAttachmentsPerTurn[1]).toEqual([
        { blobId: '/contrib_service/ttl_1d/batch-1', mimeType: 'image/png', name: 'image-1.png' },
        { blobId: '/contrib_service/ttl_1d/batch-2', mimeType: 'audio/wav', name: 'audio-1.wav' },
      ]);
      expect(receivedTextsPerTurn[1]).toContain('[Earlier image omitted]');
      expect(receivedTextsPerTurn[1]).toContain('[Attached image: image-1.png (image/png)]');
      expect(receivedTextsPerTurn[1]).toContain('[Attached audio: audio-1.wav (audio/wav)]');

      // 3) Mid-round interrupt after model started speaking: img1 + interrupting audio both ride into the new request.
      const afterInterrupt: GeminiRequest = {
        model: 'gemini-4-neon',
        contents: [
          ...beforePreempt.contents,
          {
            role: 'model',
            parts: [
              { functionCall: { name: 'pet_say', id: 'c_say', args: { script: '哇这图...' } } },
              { functionCall: { name: 'end_turn', id: 'c_end', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'pet_say', id: 'c_say', response: { output: 'spoke partial [an interrupt signal was sent while this tool ran]' } } },
              { functionResponse: { name: 'end_turn', id: 'c_end', response: { output: '[not executed: interrupted by a new event]' } } },
            ],
          },
          evfCall('evf_4'),
          evfResult('evf_4', '[1 new event] stop talking and read the error in the image', [{ inlineData: { mimeType: 'audio/wav', data: audio1 } }]),
        ],
      };
      await consume(client.stream(afterInterrupt));
      expect(uploadedContentTypes).toEqual(['image/png', 'audio/wav']);
      expect(receivedAttachmentsPerTurn[2]).toEqual([
        { blobId: '/contrib_service/ttl_1d/batch-1', mimeType: 'image/png', name: 'image-1.png' },
        { blobId: '/contrib_service/ttl_1d/batch-2', mimeType: 'audio/wav', name: 'audio-1.wav' },
      ]);

      // 4) Once the assistant finishes normally, the next follow-up omits all earlier media cleanly.
      const afterCompleted: GeminiRequest = {
        model: 'gemini-4-neon',
        contents: [
          ...afterInterrupt.contents,
          { role: 'model', parts: [{ functionCall: { name: 'end_turn', id: 'c_done', args: {} } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'end_turn', id: 'c_done', response: { output: '[turn ended]' } } }] },
          evfCall('evf_5'),
          evfResult('evf_5', '[1 new event] got it thanks'),
        ],
      };
      await consume(client.stream(afterCompleted));
      expect(receivedAttachmentsPerTurn[3]).toEqual([]);
      expect(receivedTextsPerTurn[3]).toContain('[Earlier image omitted]');
      expect(receivedTextsPerTurn[3]).toContain('[Earlier attachment omitted]');

      // 5) Over-cap burst (5 images across consecutive preempted frames) keeps the newest 4 in chronological order.
      const burstContents: GeminiRequest['contents'] = [];
      for (let k = 1; k <= 5; k++) {
        burstContents.push(evfCall(`evf_burst_${k}`));
        burstContents.push(evfResult(`evf_burst_${k}`, `[1 new event] pic ${k}`, [
          { inlineData: { mimeType: 'image/png', data: pngBytes(20 + k).toString('base64') } },
        ]));
      }
      await consume(client.stream({ model: 'gemini-4-neon', contents: burstContents }));
      expect(receivedAttachmentsPerTurn[4]).toHaveLength(4);
      expect(receivedAttachmentsPerTurn[4].map(a => a.name)).toEqual([
        'image-1.png', 'image-2.png', 'image-3.png', 'image-4.png',
      ]);
      expect(receivedTextsPerTurn[4]).toContain('[Attachment omitted: oversized or excess image omitted]');
      expect(receivedTextsPerTurn[4]).not.toContain('[Earlier image omitted]');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('intercepts HTTP 200 Robin safety/policy refusals (including 2-frame replacement), fails over across accounts, and throws 422 without polluting history', async () => {
    // 1. Unit classification checks (positives and negatives).
    expect(classifyRobinCannedRejection("I'm just a language model and can't help with that.")).toBe('safety-refusal');
    expect(classifyRobinCannedRejection(
      'It appears this one would go against my [guidelines](https://gemini.google/policy-guidelines/). Is there something else I can try for you?',
    )).toBe('safety-refusal');
    expect(classifyRobinCannedRejection(
      "I'm unable to assist with that particular request, as it may go against my [guidelines](https://gemini.google/policy-guidelines/).",
    )).toBe('safety-refusal');
    expect(classifyRobinCannedRejection(
      'That request may go against my [guidelines](https://gemini.google/policy-guidelines/).',
    )).toBe('safety-refusal');
    expect(classifyRobinCannedRejection('我只是一个语言模型，无法在这方面提供帮助。')).toBe('safety-refusal');
    expect(classifyRobinCannedRejection('I seem to be encountering an error. Can I try something else for you?')).toBe('transient-error');

    expect(classifyRobinCannedRejection("I'm just a language model and can't help with that. 这句话是外审返回的。")).toBeNull();
    expect(classifyRobinCannedRejection("I'm sorry, I couldn't find that file.")).toBeNull();
    expect(classifyRobinCannedRejection(
      'Let me explain the policy.\n\nSee [guidelines](https://gemini.google/policy-guidelines/) for full details.',
    )).toBeNull();

    type Mode =
      | 'multi-3-failover-ok'
      | 'multi-3-persistent'
      | 'single-retry-ok'
      | 'single-persistent'
      | 'frame2-recovered-text'
      | 'quoted-plus-explanation'
      | 'refusal-then-tool';
    let mode: Mode = 'multi-3-failover-ok';
    let callCount = 0;
    const seenTokens: string[] = [];
    const server = http2.createServer();

    server.on('stream', (stream, headers) => {
      if (headers[':path'] !== ROBIN_GRPC_PROCESS_QUERY) {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      callCount += 1;
      const attemptNo = callCount;
      seenTokens.push(String(headers.authorization ?? ''));
      stream.resume();
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        const send = (text: string, completed = false) => {
          stream.write(frameGrpcMessage(encodeProcessQueryResponse({
            text,
            responseId: `rc_refusal_${attemptNo}`,
            attribution: 'Used 4 Neon Medium model',
            completed,
          })));
        };

        if (mode === 'multi-3-failover-ok') {
          if (attemptNo === 1) {
            send("I'm just a language model and can't help with that.");
            send('It appears this one would go against my [guidelines](https://gemini.google/policy-guidelines/). Is there something else I can try for you?', true);
          } else if (attemptNo === 2) {
            send("I'm just a language model and can't help with that.");
            send("I'm unable to assist with that particular request, as it may go against my [guidelines](https://gemini.google/policy-guidelines/).", true);
          } else {
            send('<tool_call>{"name":"wechat_send","args":{"text":"三号账号正常接力回复！"}}</tool_call>', true);
          }
        } else if (mode === 'multi-3-persistent') {
          send("I'm just a language model and can't help with that.");
          send('It appears this one would go against my [guidelines](https://gemini.google/policy-guidelines/). Is there something else I can try for you?', true);
        } else if (mode === 'single-retry-ok') {
          if (attemptNo === 1) {
            send("I'm just a language model and can't help with that.", true);
          } else {
            send('<tool_call>{"name":"wechat_send","args":{"text":"单号重试避开外审啦！"}}</tool_call>', true);
          }
        } else if (mode === 'single-persistent') {
          send('That request may go against my [guidelines](https://gemini.google/policy-guidelines/).', true);
        } else if (mode === 'frame2-recovered-text') {
          send("I'm just a language model and can't help with that.");
          send('正常恢复后的回复', true);
        } else if (mode === 'quoted-plus-explanation') {
          send("I'm just a language model and can't help with that. 这句只是在引用外审日志。", true);
        } else {
          send("I'm just a language model and can't help with that.");
          send("I'm just a language model and can't help with that.\n<tool_call>{\"name\":\"wechat_send\",\"args\":{\"text\":\"附带工具调用\"}}</tool_call>", true);
        }

        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 2. 3-account pool failover across 2-frame policy refusals without putting accounts into cooldown.
      const failedAccounts: string[] = [];
      const succeededAccounts: string[] = [];
      const transientEvents: { accountId?: string; action: string; detail: string }[] = [];
      const multiClient = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        robinTransientRetryDelayMs: 0,
        onRobinTransientError: info => transientEvents.push({
          accountId: info.accountId,
          action: info.action,
          detail: info.detail,
        }),
        auth: {
          accessToken: async () => 'tok-default',
          selectAccounts: () => ['acct_1', 'acct_2', 'acct_3'],
          accessTokenFor: async id => `tok-${id}`,
          onAccountFailure: id => failedAccounts.push(id),
          onAccountSuccess: id => succeededAccounts.push(id),
        },
      });

      mode = 'multi-3-failover-ok';
      callCount = 0;
      seenTokens.length = 0;
      const res2 = await consume(multiClient.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'wechat_send', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      }));
      expect(res2.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'wechat_send', args: { text: '三号账号正常接力回复！' } } },
      ]);
      expect(seenTokens).toEqual(['Bearer tok-acct_1', 'Bearer tok-acct_2', 'Bearer tok-acct_3']);
      expect(failedAccounts).toEqual([]);
      expect(succeededAccounts).toEqual(['acct_3']);
      expect(transientEvents.map(e => ({ accountId: e.accountId, action: e.action }))).toEqual([
        { accountId: 'acct_1', action: 'failover' },
        { accountId: 'acct_2', action: 'failover' },
      ]);

      // 3. Persistent refusal across 3-account pool emits zero chunks and throws status 422.
      mode = 'multi-3-persistent';
      callCount = 0;
      seenTokens.length = 0;
      transientEvents.length = 0;
      const emittedOnFail: unknown[] = [];
      await expect((async () => {
        for await (const chunk of multiClient.stream({
          model: 'gemini-4-neon',
          contents: [{ role: 'user', parts: [{ text: 'sensitive' }] }],
        })) {
          emittedOnFail.push(chunk);
        }
      })()).rejects.toMatchObject({ status: 422 });
      expect(callCount).toBe(3);
      expect(seenTokens).toEqual(['Bearer tok-acct_1', 'Bearer tok-acct_2', 'Bearer tok-acct_3']);
      expect(emittedOnFail).toEqual([]);
      expect(transientEvents.map(e => ({ accountId: e.accountId, action: e.action }))).toEqual([
        { accountId: 'acct_1', action: 'failover' },
        { accountId: 'acct_2', action: 'failover' },
        { accountId: 'acct_3', action: 'fail' },
      ]);

      // 4. Single-account refusal retries once cleanly and throws 422 when persistent.
      const singleEvents: { action: string }[] = [];
      const singleClient = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        robinTransientRetryDelayMs: 0,
        onRobinTransientError: info => singleEvents.push({ action: info.action }),
        auth: { accessToken: async () => 'tok-single' },
      });
      mode = 'single-retry-ok';
      callCount = 0;
      const singleRecovered = await consume(singleClient.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'wechat_send', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'retry' }] }],
      }));
      expect(singleRecovered.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'wechat_send', args: { text: '单号重试避开外审啦！' } } },
      ]);
      expect(callCount).toBe(2);
      expect(singleEvents).toEqual([{ action: 'retry' }]);

      mode = 'single-persistent';
      callCount = 0;
      singleEvents.length = 0;
      await expect(consume(singleClient.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'still blocked' }] }],
      }))).rejects.toMatchObject({ status: 422 });
      expect(callCount).toBe(2);
      expect(singleEvents).toEqual([{ action: 'retry' }, { action: 'fail' }]);

      // 5. Frame-1 refusal replaced by Frame-2 normal text drops Frame 1 completely.
      mode = 'frame2-recovered-text';
      callCount = 0;
      const recoveredText = await consume(singleClient.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'recover' }] }],
      }));
      expect(recoveredText.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')).toBe('正常恢复后的回复');
      expect(callCount).toBe(1);

      // 6. Quoted refusal with commentary or accompanied by tool calls passes through intact without retry.
      mode = 'quoted-plus-explanation';
      callCount = 0;
      const quoted = await consume(singleClient.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'explain' }] }],
      }));
      expect(quoted.flatMap(c => c.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')).toBe(
        "I'm just a language model and can't help with that. 这句只是在引用外审日志。",
      );
      expect(callCount).toBe(1);

      mode = 'refusal-then-tool';
      callCount = 0;
      const withTool = await consume(singleClient.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'wechat_send', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'tool' }] }],
      }));
      expect(withTool.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { text: "I'm just a language model and can't help with that." },
        { functionCall: { name: 'wechat_send', args: { text: '附带工具调用' } } },
      ]);
      expect(callCount).toBe(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('detects silent Robin model downgrade and immediately transfers to another account without leaking downgraded output', async () => {
    // 1. Unit checks for detectRobinDowngrade (positives and negatives).
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-neon',
      requestedModeCategory: 3,
      resolvedModeCategory: 3,
      attribution: 'Used 3.1 Pro model',
    })).toBe('mode 3 -> Used 3.1 Pro model');
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-neon',
      requestedModeCategory: 3,
      attribution: 'Used auto model selection',
    })).toBe('mode 3 -> Used auto model selection');
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-carbon',
      requestedModeCategory: 8,
      resolvedModeCategory: 8,
      attribution: 'Used 4 Neon Medium model',
    })).toBe('mode 8 -> Used 4 Neon Medium model');
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-hydrogen',
      requestedModeCategory: 1,
      resolvedModeCategory: 1,
      attribution: 'Used 3.5 Flash-Lite model',
    })).toBe('mode 1 -> Used 3.5 Flash-Lite model');
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-neon',
      requestedModeCategory: 3,
      resolvedModeCategory: 6,
    })).toBe('mode 3 -> 6');
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-neon',
      requestedModeCategory: 3,
      fallback: 1,
    })).toBe('fallback=1');
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-neon',
      requestedModeCategory: 3,
      downgradeReason: 2,
    })).toBe('downgradeReason=2');

    // Non-downgraded & explicit lower-tier models must NOT false-positive.
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-neon',
      requestedModeCategory: 3,
      resolvedModeCategory: 3,
      attribution: 'Used 4 Neon Medium model',
    })).toBeNull();
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-hydrogen',
      requestedModeCategory: 1,
      resolvedModeCategory: 1,
      attribution: 'Gemini 4 Hydrogen',
    })).toBeNull();
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-4-carbon',
      requestedModeCategory: 8,
      resolvedModeCategory: 8,
      attribution: 'Used 4 Carbon High model',
    })).toBeNull();
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-auto',
      attribution: 'Used auto model selection',
    })).toBeNull();
    expect(detectRobinDowngrade({
      requestedModel: 'gemini-3.1-pro',
      requestedModeCategory: 3,
      resolvedModeCategory: 3,
      attribution: 'Used 3.1 Pro model',
    })).toBeNull();

    // 2. End-to-end HTTP/2 gRPC instant downgrade failover tests.
    type Scenario = 'frame1-downgrade-failover' | 'meta-frame1-then-frame2-downgrade' | 'all-accounts-downgraded';
    let scenario: Scenario = 'frame1-downgrade-failover';
    const seenTokens: string[] = [];
    const server = http2.createServer();

    server.on('stream', (stream, headers) => {
      if (headers[':path'] !== ROBIN_GRPC_PROCESS_QUERY) {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      const auth = String(headers.authorization ?? '');
      seenTokens.push(auth);
      stream.resume();
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        if (scenario === 'frame1-downgrade-failover') {
          if (auth === 'Bearer tok-acct_1') {
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              responseId: 'rc_down_1',
              attribution: 'Used 3.1 Pro model',
              resolvedModeCategory: 3,
              resolvedThinkingLevel: 1,
              text: 'truncated free-tier leakage',
              completed: true,
            })));
          } else {
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              responseId: 'rc_ok_2',
              attribution: 'Used 4 Neon Medium model',
              resolvedModeCategory: 3,
              resolvedThinkingLevel: 4,
              text: '<tool_call>{"name":"wechat_send","args":{"text":"切到健康 Pro 号成功！"}}</tool_call>',
              completed: true,
            })));
          }
        } else if (scenario === 'meta-frame1-then-frame2-downgrade') {
          if (auth === 'Bearer tok-acct_1') {
            // Frame 1 carries responseId metadata only; Frame 2 carries downgraded attribution + text.
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              responseId: 'rc_meta_1',
              conversationId: 'c_meta_1',
            })));
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              responseId: 'rc_meta_1',
              attribution: 'Used 3.1 Pro model',
              resolvedModeCategory: 3,
              text: 'should never leak from frame 2',
              completed: true,
            })));
          } else {
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              responseId: 'rc_meta_2',
              attribution: 'Used 4 Neon Medium model',
              resolvedModeCategory: 3,
              text: 'Clean recovery on account 2',
              completed: true,
            })));
          }
        } else {
          // Both accounts downgrade: acct_1 transfers to acct_2, acct_2 (last account) completes gracefully.
          if (auth === 'Bearer tok-acct_1') {
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              responseId: 'rc_all_1',
              attribution: 'Used 3.1 Pro model',
              resolvedModeCategory: 3,
              text: 'first downgraded output',
              completed: true,
            })));
          } else {
            stream.write(frameGrpcMessage(encodeProcessQueryResponse({
              responseId: 'rc_all_2',
              attribution: 'Used auto model selection',
              resolvedModeCategory: 6,
              downgradeReason: 2,
              text: 'fallback output from last account',
              completed: true,
            })));
          }
        }
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const downgradedEvents: { accountId: string; detail: string }[] = [];
      const succeededAccounts: string[] = [];
      const transientEvents: { accountId?: string; action: string }[] = [];

      const client = new GatewayClient({
        baseUrl,
        protocol: 'robin',
        generationEndpoint: ROBIN_GRPC_PROCESS_QUERY,
        onRobinTransientError: info => transientEvents.push({ accountId: info.accountId, action: info.action }),
        auth: {
          accessToken: async () => 'tok-default',
          selectAccounts: () => ['acct_1', 'acct_2'],
          accessTokenFor: async id => `tok-${id}`,
          onAccountDowngrade: (accountId, detail) => downgradedEvents.push({ accountId, detail }),
          onAccountSuccess: accountId => succeededAccounts.push(accountId),
        },
      });

      // Scenario A: Frame 1 silent downgrade transfers instantly with zero leaked chunks.
      scenario = 'frame1-downgrade-failover';
      const chunksA = await consume(client.stream({
        model: 'gemini-4-neon',
        tools: [{ functionDeclarations: [{ name: 'wechat_send', parametersJsonSchema: { type: 'object' } }] }],
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }));
      expect(chunksA.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { functionCall: { name: 'wechat_send', args: { text: '切到健康 Pro 号成功！' } } },
      ]);
      expect(chunksA.some(c => c.responseId === 'rc_down_1')).toBe(false);
      expect(seenTokens).toEqual(['Bearer tok-acct_1', 'Bearer tok-acct_2']);
      expect(downgradedEvents).toEqual([{ accountId: 'acct_1', detail: 'mode 3 -> Used 3.1 Pro model' }]);
      expect(succeededAccounts).toEqual(['acct_2']);
      expect(transientEvents).toEqual([{ accountId: 'acct_1', action: 'failover' }]);

      // Scenario B: Metadata-only Frame 1 followed by downgraded Frame 2 still transfers with zero leaked chunks.
      scenario = 'meta-frame1-then-frame2-downgrade';
      seenTokens.length = 0;
      downgradedEvents.length = 0;
      succeededAccounts.length = 0;
      transientEvents.length = 0;
      const chunksB = await consume(client.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'hello again' }] }],
      }));
      expect(chunksB.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { text: 'Clean recovery on account 2' },
      ]);
      expect(chunksB.some(c => c.responseId === 'rc_meta_1')).toBe(false);
      expect(seenTokens).toEqual(['Bearer tok-acct_1', 'Bearer tok-acct_2']);
      expect(downgradedEvents).toEqual([{ accountId: 'acct_1', detail: 'mode 3 -> Used 3.1 Pro model' }]);
      expect(succeededAccounts).toEqual(['acct_2']);

      // Scenario C: All accounts downgraded -> transfers away from acct_1, gracefully finishes on last account acct_2,
      // reports downgrade for both, and does NOT call onAccountSuccess (so cooldown is not wiped!).
      scenario = 'all-accounts-downgraded';
      seenTokens.length = 0;
      downgradedEvents.length = 0;
      succeededAccounts.length = 0;
      transientEvents.length = 0;
      const chunksC = await consume(client.stream({
        model: 'gemini-4-neon',
        contents: [{ role: 'user', parts: [{ text: 'last resort' }] }],
      }));
      expect(chunksC.flatMap(c => c.candidates?.[0]?.content?.parts ?? [])).toEqual([
        { text: 'fallback output from last account' },
      ]);
      expect(seenTokens).toEqual(['Bearer tok-acct_1', 'Bearer tok-acct_2']);
      expect(downgradedEvents).toEqual([
        { accountId: 'acct_1', detail: 'mode 3 -> Used 3.1 Pro model' },
        { accountId: 'acct_2', detail: 'downgradeReason=2 (Used auto model selection)' },
      ]);
      expect(succeededAccounts).toEqual([]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
