import { createHash } from 'node:crypto';
import { requestJson } from 'cortico/providers/transport/response-http.ts';
import { gatewayFrames } from './frames.ts';
import { createHttp2Connector, createProxyFetchFor, type Http2Connector } from './http.ts';
import { GatewayError, inspectHttpError, SerialQueue } from './queue.ts';
import {
  detectRobinImageMime,
  isRobinGrpcRoute,
  resolveRobinMode,
  ROBIN_GRPC_PROCESS_QUERY,
  ROBIN_MAX_IMAGE_BYTES,
  ROBIN_MAX_IMAGES_PER_REQUEST,
  ROBIN_NATIVE_IMAGE_MIMES,
  streamRobinGrpc,
  uploadRobinImages,
  type RobinGrpcStreamSummary,
  type RobinImageMime,
  type RobinRoutingObservation,
  type RobinUploadedImage,
} from './robin-grpc.ts';
import {
  decodeGatewayEvent, RobinPartFilter, toGeminiRequest, toRobinRequest, toRpcRequest, ToolCallStream,
  type GatewayEvent, type GatewayProtocol, type GeminiChunk, type GeminiPart, type GeminiRequest, type UploadAttachment,
} from './shim.ts';
import { httpUrl, record } from './state.ts';

export interface GatewayAuthProvider {
  accessToken(force?: boolean): Promise<string>;
  enabled?: () => boolean;
  selectAccounts?: () => string[];
  accessTokenFor?: (accountId: string, force?: boolean) => Promise<string>;
  onAccountSuccess?: (accountId: string) => void;
  onAccountFailure?: (accountId: string, status: number | null, detail?: string) => void;
}

export interface GatewayClientOptions {
  baseUrl: string;
  protocol?: GatewayProtocol;
  generationEndpoint?: string;
  uploadEndpoint?: string;
  robinUploadOrigin?: string;
  deleteEndpoint?: string;
  conversationHeader?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  resolveHeaders?: () => Headers;
  auth?: GatewayAuthProvider;
  authHeader?: string;
  authPrefix?: string;
  temporaryChat?: boolean;
  uploadAttachment?: UploadAttachment;
  deleteConversation?: (conversationId: string) => Promise<void>;
  encodeRequest?: (request: GeminiRequest, upload: UploadAttachment | undefined, temporaryChat: boolean) => Promise<unknown>;
  decodeEvent?: (payload: unknown) => GatewayEvent;
  resolveRobinModeCategory?: (model: string, accountId?: string) => number | undefined;
  onRobinRouting?: (observation: RobinRoutingObservation, accountId?: string) => void;
  onCleanupError?: (error: unknown) => void;
  proxyUrl?: string;
  robinTextIdleTimeoutMs?: number;
  robinToolIdleTimeoutMs?: number;
  fetch?: typeof fetch;
  connectHttp2?: Http2Connector;
}

export interface GatewayAttempt {
  startedAt: string;
  elapsedMs: number;
  status: number | null;
  requestId: string | null;
  completed: boolean;
}

export interface GatewayStreamOptions {
  signal?: AbortSignal;
  onAttempt?: (attempt: GatewayAttempt) => void;
}

function endpoint(base: string, route: string): URL {
  return httpUrl(new URL(route, base.replace(/\/+$/, '') + '/').href);
}

async function checkResponse(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const info = await inspectHttpError(response);
  throw new GatewayError(info.status, operation, {
    ...(info.detail ? { detail: info.detail } : {}),
    body: info.body,
  });
}

const ROBIN_UPLOAD_CACHE_TTL_MS = 10 * 60_000;
const ROBIN_UPLOAD_CACHE_MAX = 32;

export class GatewayClient {
  private readonly queue = new SerialQueue();
  private readonly request: typeof fetch;
  private readonly h2Connector: Http2Connector;
  private readonly protocol: GatewayProtocol;
  private readonly base: string;
  private readonly options: GatewayClientOptions;
  private readonly robinImageCache = new Map<string, { blobId: string; mimeType: RobinImageMime; expiresAt: number }>();

  constructor(options: GatewayClientOptions) {
    this.options = options;
    this.base = httpUrl(options.baseUrl).href;
    this.request = options.fetch ?? createProxyFetchFor(options.proxyUrl);
    this.h2Connector = options.connectHttp2 ?? createHttp2Connector(options.proxyUrl);
    this.protocol = options.protocol ?? 'rpc';
  }

  private async headers(force: boolean, accountId?: string): Promise<Headers> {
    const headers = this.options.resolveHeaders
      ? new Headers(this.options.resolveHeaders())
      : new Headers(this.options.headers);
    if (this.options.auth && (!this.options.auth.enabled || this.options.auth.enabled())) {
      const token = accountId && this.options.auth.accessTokenFor
        ? await this.options.auth.accessTokenFor(accountId, force)
        : await this.options.auth.accessToken(force);
      headers.set(this.options.authHeader ?? 'Authorization', `${this.options.authPrefix ?? 'Bearer '}${token}`);
    }
    return headers;
  }

  private upload(headers: Headers, signal: AbortSignal): UploadAttachment | undefined {
    if (this.options.uploadAttachment) return this.options.uploadAttachment;
    const route = this.options.uploadEndpoint;
    if (!route) return undefined;
    return async (blob, mimeType) => {
      const uploadHeaders = new Headers(headers);
      uploadHeaders.delete('Content-Type');
      const body = new FormData();
      body.set('file', blob, 'attachment');
      body.set('mimeType', mimeType);
      const response = await this.request(endpoint(this.base, route), {
        method: 'POST', headers: uploadHeaders, body, signal, redirect: 'error',
      });
      await checkResponse(response, 'attachment upload');
      const data = record(await response.json());
      const id = data?.id ?? data?.attachmentId ?? data?.attachment_id ?? data?.fileUri;
      if (typeof id !== 'string' || !id.trim()) throw new Error('Gateway attachment upload response requires an ID');
      return id;
    };
  }

  private async cleanup(conversations: Set<string>, headers: Headers): Promise<void> {
    for (const id of conversations) {
      try {
        if (this.options.deleteConversation) await this.options.deleteConversation(id);
        else if (this.options.deleteEndpoint) {
          if (id === '.' || id === '..') throw new Error('Invalid gateway conversation ID for a cleanup URL');
          if (this.options.deleteEndpoint.includes('{conversationId}')) {
            const url = endpoint(this.base, this.options.deleteEndpoint.replaceAll('{conversationId}', encodeURIComponent(id)));
            const response = await this.request(url, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(5_000) });
            await checkResponse(response, 'conversation cleanup');
            await response.body?.cancel();
          } else {
            const url = endpoint(this.base, this.options.deleteEndpoint);
            const postHeaders = new Headers(headers);
            postHeaders.set('Content-Type', 'application/json');
            const response = await this.request(url, {
              method: 'POST', headers: postHeaders, body: JSON.stringify({ conversationId: id }),
              redirect: 'error', signal: AbortSignal.timeout(5_000),
            });
            await checkResponse(response, 'conversation cleanup');
            await response.body?.cancel();
          }
        }
      } catch (error) {
        this.options.onCleanupError?.(error);
      }
    }
  }

  private resolveGenerationRoute(): string {
    if (this.options.generationEndpoint) return this.options.generationEndpoint;
    if (this.protocol === 'gemini') return 'v1beta/models/{model}:streamGenerateContent?alt=sse';
    if (this.protocol === 'robin') {
      if (!this.options.fetch && this.base.startsWith('https://')) return ROBIN_GRPC_PROCESS_QUERY;
      return '$rpc/assistant.mobile.robin.RobinService/StreamGenerate';
    }
    return 'generate?$alt=json';
  }

  private pruneRobinImageCache(now = Date.now()): void {
    for (const [key, entry] of this.robinImageCache) {
      if (entry.expiresAt <= now) this.robinImageCache.delete(key);
    }
    while (this.robinImageCache.size > ROBIN_UPLOAD_CACHE_MAX) {
      const oldest = this.robinImageCache.keys().next().value;
      if (oldest === undefined) break;
      this.robinImageCache.delete(oldest);
    }
  }

  private clearRobinImageCacheFor(accountId?: string): void {
    const prefix = `${accountId ?? 'default'}:`;
    for (const key of this.robinImageCache.keys()) {
      if (key.startsWith(prefix)) this.robinImageCache.delete(key);
    }
  }

  private async prepareRobinGrpcAttachments(
    input: GeminiRequest,
    headers: Headers,
    signal: AbortSignal,
    accountId?: string,
  ): Promise<{ request: GeminiRequest; uploader: UploadAttachment | undefined }> {
    const customUploader = this.upload(headers, signal);
    if (customUploader) return { request: input, uploader: customUploader };

    const accountPrefix = `${accountId ?? 'default'}:`;
    type InlineCandidate = {
      section: 'system' | 'turn';
      turnIndex: number;
      partIndex: number;
      bytes: Buffer;
      mimeType: RobinImageMime | null;
      cacheKey: string;
    };

    const candidates: InlineCandidate[] = [];
    const collect = (section: 'system' | 'turn', turnIndex: number, parts: readonly GeminiPart[]) => {
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const inline = parts[partIndex].inlineData;
        if (!inline) continue;
        const bytes = Buffer.from(inline.data, 'base64');
        const detected = bytes.length ? detectRobinImageMime(bytes) : null;
        const hash = detected ? createHash('sha256').update(detected).update(':').update(bytes).digest('hex') : '';
        candidates.push({
          section,
          turnIndex,
          partIndex,
          bytes,
          mimeType: detected,
          cacheKey: hash ? `${accountPrefix}${hash}` : '',
        });
      }
    };
    if (input.systemInstruction?.parts) collect('system', -1, input.systemInstruction.parts);
    input.contents.forEach((turn, turnIndex) => collect('turn', turnIndex, turn.parts));
    if (!candidates.length) return { request: input, uploader: undefined };

    // Keep only supported images from the latest turn, within Robin's per-request count & byte budgets.
    // Earlier-turn images are never re-uploaded or re-inferred; they become compact text placeholders.
    const lastTurnIndex = input.contents.length - 1;
    const keptKeys = new Set<string>();
    const keptList: InlineCandidate[] = [];
    let totalBytes = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      if (!candidate.mimeType) continue;
      if (candidate.section !== 'turn' || candidate.turnIndex !== lastTurnIndex) continue;
      if (keptList.length >= ROBIN_MAX_IMAGES_PER_REQUEST) continue;
      if (totalBytes + candidate.bytes.length > ROBIN_MAX_IMAGE_BYTES) continue;
      totalBytes += candidate.bytes.length;
      keptList.push(candidate);
      keptKeys.add(`${candidate.section}:${candidate.turnIndex}:${candidate.partIndex}`);
    }
    keptList.reverse();

    // Batch-upload only uncached unique images for this account over a single HTTP/2 upload session.
    const now = Date.now();
    this.pruneRobinImageCache(now);
    const toUpload: { cacheKey: string; data: Buffer; mimeType: RobinImageMime }[] = [];
    const seenUploadKeys = new Set<string>();
    for (const candidate of keptList) {
      if (this.robinImageCache.has(candidate.cacheKey) || seenUploadKeys.has(candidate.cacheKey)) continue;
      seenUploadKeys.add(candidate.cacheKey);
      toUpload.push({ cacheKey: candidate.cacheKey, data: candidate.bytes, mimeType: candidate.mimeType! });
    }
    if (toUpload.length) {
      const uploaded = await uploadRobinImages({
        images: toUpload.map(item => ({ data: item.data, mimeType: item.mimeType })),
        headers,
        origin: this.options.robinUploadOrigin,
        signal,
        connectHttp2: this.h2Connector,
      });
      const expiresAt = Date.now() + ROBIN_UPLOAD_CACHE_TTL_MS;
      for (let i = 0; i < toUpload.length; i++) {
        this.robinImageCache.set(toUpload[i].cacheKey, {
          blobId: uploaded[i].blobId,
          mimeType: uploaded[i].mimeType,
          expiresAt,
        });
      }
      this.pruneRobinImageCache();
    }

    const byKey = new Map<string, InlineCandidate>();
    for (const candidate of candidates) {
      byKey.set(`${candidate.section}:${candidate.turnIndex}:${candidate.partIndex}`, candidate);
    }
    const rewriteParts = (section: 'system' | 'turn', turnIndex: number, parts: readonly GeminiPart[]): GeminiPart[] =>
      parts.map((part, partIndex) => {
        if (!part.inlineData) return part;
        const key = `${section}:${turnIndex}:${partIndex}`;
        const candidate = byKey.get(key);
        if (!candidate || !keptKeys.has(key)) {
          if (candidate?.mimeType && (candidate.section !== 'turn' || candidate.turnIndex !== lastTurnIndex)) {
            return { text: '[Earlier image omitted]' };
          }
          const reason = !candidate?.mimeType
            ? `unsupported Robin attachment (${part.inlineData.mimeType})`
            : 'oversized or excess image omitted';
          return { text: `[Attachment omitted: ${reason}]` };
        }
        const cached = this.robinImageCache.get(candidate.cacheKey)!;
        return { fileData: { fileUri: cached.blobId, mimeType: cached.mimeType } };
      });

    const rewritten: GeminiRequest = {
      ...input,
      ...(input.systemInstruction ? {
        systemInstruction: {
          ...input.systemInstruction,
          parts: rewriteParts('system', -1, input.systemInstruction.parts),
        },
      } : {}),
      contents: input.contents.map((turn, turnIndex) => ({
        ...turn,
        parts: rewriteParts('turn', turnIndex, turn.parts),
      })),
    };
    return { request: rewritten, uploader: undefined };
  }

  private async *streamGrpcAttempt(
    input: GeminiRequest,
    route: string,
    headers: Headers,
    signal: AbortSignal,
    conversations: Set<string>,
    onMeta: (meta: { status?: number | null; requestId?: string | null; observed?: boolean; completed?: boolean }) => void,
    accountId?: string,
  ): AsyncGenerator<GeminiChunk> {
    const prepared = await this.prepareRobinGrpcAttachments(input, headers, signal, accountId);
    const prompt = await toRobinRequest(prepared.request, prepared.uploader, this.options.temporaryChat ?? true);
    signal.throwIfAborted();
    const images: RobinUploadedImage[] = (prompt.query.attachments ?? [])
      .filter((att): att is { id: string; mimeType: RobinImageMime } => ROBIN_NATIVE_IMAGE_MIMES.has(att.mimeType))
      .slice(-ROBIN_MAX_IMAGES_PER_REQUEST)
      .map(att => ({ blobId: att.id, mimeType: att.mimeType }));
    const thinkingCfg = record(input.generationConfig?.thinkingConfig);
    const includeThoughts = typeof thinkingCfg?.includeThoughts === 'boolean' ? thinkingCfg.includeThoughts : true;
    const reasoningEffort = typeof thinkingCfg?.thinkingLevel === 'string' ? thinkingCfg.thinkingLevel : undefined;
    const overrideModeCategory = this.options.resolveRobinModeCategory?.(input.model, accountId);
    const requestedMode = resolveRobinMode(input.model, includeThoughts, reasoningEffort, overrideModeCategory);
    const parser = new ToolCallStream();
    const filter = new RobinPartFilter();
    let emittedText = '';
    let emittedThought = '';
    let received = false;
    let emittedToolCallCount = 0;
    let emittedVisibleTextCount = 0;
    let truncatedEarly = false;
    let streamSummary: RobinGrpcStreamSummary | undefined;
    let observedAttribution: string | undefined;
    let observedResolvedMode: number | undefined;
    let observedThinking: number | undefined;
    let observedFallback: number | undefined;
    let observedDowngrade: number | undefined;

    for await (const frame of streamRobinGrpc({
      baseUrl: this.base,
      path: route,
      headers,
      userText: prompt.query.text,
      images,
      model: input.model,
      thinking: includeThoughts,
      reasoningEffort,
      overrideModeCategory,
      temporaryChat: this.options.temporaryChat ?? true,
      signal,
      ...(this.options.robinTextIdleTimeoutMs !== undefined ? { textIdleTimeoutMs: this.options.robinTextIdleTimeoutMs } : {}),
      ...(this.options.robinToolIdleTimeoutMs !== undefined ? { toolIdleTimeoutMs: this.options.robinToolIdleTimeoutMs } : {}),
      connectHttp2: this.h2Connector,
      onStatus: (httpStatus, requestId) => onMeta({ status: httpStatus, requestId }),
      onStreamSummary: summary => { streamSummary = summary; },
    })) {
      signal.throwIfAborted();
      if (frame.conversationId) conversations.add(frame.conversationId);
      if (frame.modelVersion) observedAttribution = frame.modelVersion;
      if (frame.resolvedModeCategory !== undefined) observedResolvedMode = frame.resolvedModeCategory;
      if (frame.resolvedThinkingLevel !== undefined) observedThinking = frame.resolvedThinkingLevel;
      if (frame.fallback !== undefined) observedFallback = frame.fallback;
      if (frame.downgradeReason !== undefined) observedDowngrade = frame.downgradeReason;
      const rawParts: GeminiPart[] = [];
      if (includeThoughts && typeof frame.thought === 'string' && frame.thought.length > emittedThought.length) {
        if (frame.thought.startsWith(emittedThought)) {
          const delta = frame.thought.slice(emittedThought.length);
          emittedThought = frame.thought;
          if (delta) rawParts.push({ text: delta, thought: true });
        }
      }
      if (typeof frame.text === 'string' && frame.text.length > emittedText.length) {
        if (frame.text.startsWith(emittedText)) {
          const delta = frame.text.slice(emittedText.length);
          emittedText = frame.text;
          if (delta) rawParts.push(...parser.feed(delta));
        }
      }
      const parts = filter.feed(rawParts);
      for (const part of parts) {
        if (part.functionCall) emittedToolCallCount += 1;
        else if (!part.thought && typeof part.text === 'string' && part.text) emittedVisibleTextCount += 1;
      }
      received ||= Boolean(parts.length || frame.completed || emittedText.length > 0);
      if (parts.length) onMeta({ observed: true });
      if (parts.length || frame.responseId || frame.modelVersion) {
        yield {
          ...(parts.length ? { candidates: [{ content: { role: 'model', parts } }] } : {}),
          responseId: frame.responseId,
          modelVersion: frame.modelVersion,
        };
      }
      if (filter.isTruncated) {
        truncatedEarly = true;
        break;
      }
    }

    if (!received) throw new Error('Gemini gateway stream ended without a complete response');
    if (
      observedAttribution !== undefined
      || observedResolvedMode !== undefined
      || observedFallback !== undefined
      || observedDowngrade !== undefined
    ) {
      this.options.onRobinRouting?.({
        requestedModel: input.model,
        ...(requestedMode.modeCategory !== undefined ? { requestedModeCategory: requestedMode.modeCategory } : {}),
        requestedThinkingLevel: requestedMode.thinkingLevel,
        ...(observedResolvedMode !== undefined ? { resolvedModeCategory: observedResolvedMode } : {}),
        ...(observedThinking !== undefined ? { resolvedThinkingLevel: observedThinking } : {}),
        ...(observedAttribution ? { attribution: observedAttribution } : {}),
        ...(observedFallback !== undefined ? { fallback: observedFallback } : {}),
        ...(observedDowngrade !== undefined ? { downgradeReason: observedDowngrade } : {}),
        observedAt: new Date().toISOString(),
      }, accountId);
    }
    const hadPendingToolMarkup = parser.hasPendingToolMarkup;
    const tail = [...filter.feed(parser.finish()), ...filter.finish()];
    for (const part of tail) {
      if (part.functionCall) emittedToolCallCount += 1;
      else if (!part.thought && typeof part.text === 'string' && part.text) emittedVisibleTextCount += 1;
    }
    const confirmedComplete = Boolean(
      truncatedEarly
      || streamSummary?.sawCompleted
      || streamSummary?.sawGrpcStatusOk,
    );
    if (!confirmedComplete && emittedVisibleTextCount === 0 && emittedToolCallCount === 0) {
      throw new GatewayError(504, 'generation', {
        detail: streamSummary?.endedByIdleTimeout
          ? 'Robin gRPC stream stalled without completion'
          : 'Gemini gateway stream ended without completion confirmation',
      });
    }
    // If neither `completed=1` nor `grpc-status=0` arrived:
    // - Always mark incomplete (`MAX_TOKENS`) when an unclosed `<tool_call>` was cut short or on plain text.
    // - Preserve `STOP` when all `<tool_call>...</tool_call>` blocks closed cleanly with valid JSON so
    //   Coopanion pet replies (which are tool calls) still execute instead of getting blocked by Core.
    const markIncomplete = !confirmedComplete && (hadPendingToolMarkup || emittedToolCallCount === 0);
    const finishReason = markIncomplete ? 'MAX_TOKENS' : 'STOP';
    onMeta({ completed: true });
    yield { candidates: [{ ...(tail.length ? { content: { role: 'model', parts: tail } } : {}), finishReason }] };
  }

  async *stream(input: GeminiRequest, options: GatewayStreamOptions = {}): AsyncGenerator<GeminiChunk> {
    const release = await this.queue.acquire(options.signal);
    try {
      const route = this.resolveGenerationRoute();
      const useRobinGrpc = this.protocol === 'robin' && isRobinGrpcRoute(route) && !this.options.encodeRequest && !this.options.decodeEvent;
      const url = endpoint(this.base, route.replaceAll('{model}', encodeURIComponent(input.model)));
      const encode = this.options.encodeRequest ?? (this.protocol === 'gemini' ? toGeminiRequest : this.protocol === 'robin' ? toRobinRequest : toRpcRequest);
      const decode = this.options.decodeEvent ?? decodeGatewayEvent;
      const deadline = AbortSignal.timeout(300_000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const authActive = Boolean(this.options.auth && (!this.options.auth.enabled || this.options.auth.enabled()));
      const selectedIds = authActive && this.options.auth?.selectAccounts
        ? this.options.auth.selectAccounts()
        : [];
      const accountCandidates: (string | undefined)[] = selectedIds.length > 0 ? selectedIds : [undefined];

      for (let accountIndex = 0; accountIndex < accountCandidates.length; accountIndex++) {
        const accountId = accountCandidates[accountIndex];
        const hasNextAccount = accountIndex + 1 < accountCandidates.length;
        let body: string | undefined;
        let failoverToNext = false;

        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted();
          let headers: Headers;
          try {
            headers = await this.headers(attempt === 1, accountId);
          } catch (error) {
            if (accountId && hasNextAccount && !signal.aborted) {
              this.options.auth?.onAccountFailure?.(
                accountId,
                401,
                error instanceof Error ? error.message : String(error),
              );
              failoverToNext = true;
              break;
            }
            if (attempt === 1) throw new GatewayError(401, 'OAuth refresh', { cause: error });
            throw error;
          }
          signal.throwIfAborted();
          const conversations = new Set<string>();
          let observed = false;
          let started: number | undefined;
          let status: number | null = null;
          let requestId: string | null = null;
          let completed = false;
          try {
            if (useRobinGrpc) {
              started = Date.now();
              for await (const chunk of this.streamGrpcAttempt(input, route, headers, signal, conversations, meta => {
                if (meta.status !== undefined) status = meta.status;
                if (meta.requestId !== undefined) requestId = meta.requestId;
                if (meta.observed) observed = true;
                if (meta.completed) completed = true;
              }, accountId)) {
                yield chunk;
              }
              if (accountId) this.options.auth?.onAccountSuccess?.(accountId);
              return;
            }

            body ??= requestJson(await encode(input, this.upload(headers, signal), this.options.temporaryChat ?? true));
            signal.throwIfAborted();
            headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
            headers.set(
              'Accept',
              headers.get('Accept') ?? (this.protocol === 'robin' ? 'application/json' : 'text/event-stream, application/x-ndjson, application/json'),
            );
            started = Date.now();
            const response = await this.request(url, { method: 'POST', body, headers, signal, redirect: 'error' });
            status = response.status;
            requestId = response.headers.get('x-request-id');
            const headerId = response.headers.get(this.options.conversationHeader ?? 'x-conversation-id');
            if (headerId) conversations.add(headerId);
            await checkResponse(response, 'generation');
            const parser = new ToolCallStream();
            const robinFilter = this.protocol === 'robin' ? new RobinPartFilter() : undefined;
            let received = false;
            let finishReason: string | undefined;
            for await (const payload of gatewayFrames(response)) {
              signal.throwIfAborted();
              const event = decode(payload);
              if (event.conversationId) conversations.add(event.conversationId);
              if (event.errorStatus) throw new GatewayError(event.errorStatus, 'generation');
              const rawParts: GeminiPart[] = [];
              for (const part of event.parts ?? []) {
                if (typeof part.text === 'string' && !part.thought && !part.functionCall) {
                  const parsed = parser.feed(part.text);
                  if (part.thoughtSignature && parsed.length) parsed[parsed.length - 1].thoughtSignature = part.thoughtSignature;
                  rawParts.push(...parsed);
                } else {
                  rawParts.push(...parser.finish(), part);
                }
              }
              const parts = robinFilter ? robinFilter.feed(rawParts) : rawParts;
              finishReason = event.finishReason ?? finishReason;
              received ||= Boolean(parts.length || event.parts?.length || event.finishReason);
              if (parts.length || event.usageMetadata || event.responseId || event.modelVersion) {
                observed = true;
                yield {
                  ...(parts.length ? { candidates: [{ content: { role: 'model', parts } }] } : {}),
                  usageMetadata: event.usageMetadata, responseId: event.responseId, modelVersion: event.modelVersion,
                };
              }
              if (robinFilter?.isTruncated) break;
            }
            if (!received || (!finishReason && this.protocol === 'gemini')) throw new Error('Gemini gateway stream ended without a complete response');
            const parserTail = parser.finish();
            const parts = robinFilter ? [...robinFilter.feed(parserTail), ...robinFilter.finish()] : parserTail;
            completed = true;
            yield { candidates: [{ ...(parts.length ? { content: { role: 'model', parts } } : {}), finishReason: finishReason ?? 'STOP' }] };
            if (accountId) this.options.auth?.onAccountSuccess?.(accountId);
            return;
          } catch (error) {
            if (error instanceof GatewayError) status = error.status;
            if (error instanceof GatewayError && error.status === 401) {
              this.clearRobinImageCacheFor(accountId);
            }
            if (!signal.aborted && error instanceof GatewayError && error.status === 401
                && attempt === 0 && authActive && !observed) {
              continue;
            }
            const isTermsError = error instanceof GatewayError
              && /accept our terms of service|terms of service|服务条款/i.test(error.message);
            const isFailoverStatus = error instanceof GatewayError
              && (error.status === 429 || error.status === 403 || error.status === 401 || isTermsError);
            if (accountId && isFailoverStatus && !signal.aborted) {
              this.options.auth?.onAccountFailure?.(accountId, error.status, error.message);
              if (hasNextAccount && !observed) {
                failoverToNext = true;
                break;
              }
            }
            throw error;
          } finally {
            await this.cleanup(conversations, headers);
            if (started !== undefined) {
              options.onAttempt?.({ startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, status, requestId, completed });
            }
          }
        }

        if (!failoverToNext) break;
      }
    } finally {
      release();
    }
  }
}
