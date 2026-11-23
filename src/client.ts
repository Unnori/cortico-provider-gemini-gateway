import { createHash } from 'node:crypto';
import { estimateTokens } from 'cortico/protocol/open-responses/tokens.ts';
import { requestJson } from 'cortico/providers/transport/response-http.ts';
import { canonicalMime } from './catalog.ts';
import { gatewayFrames } from './frames.ts';
import { createHttp2Connector, createProxyFetchFor, type Http2Connector } from './http.ts';
import { GatewayError, inspectHttpError, SerialQueue } from './queue.ts';
import {
  isRobinGrpcRoute,
  resolveRobinAttachmentMime,
  resolveRobinMode,
  ROBIN_GRPC_PROCESS_QUERY,
  ROBIN_MAX_ATTACHMENT_BYTES,
  ROBIN_MAX_ATTACHMENTS_PER_REQUEST,
  ROBIN_NATIVE_ATTACHMENT_MIMES,
  streamRobinGrpc,
  uploadRobinAttachments,
  type RobinGrpcStreamSummary,
  type RobinRoutingObservation,
  type RobinUploadedAttachment,
} from './robin-grpc.ts';
import {
  decodeGatewayEvent, RobinPartFilter, toGeminiRequest, toRobinRequest, toRpcRequest, ToolCallStream,
  unwrapRobinAutoLinks,
  type GatewayEvent, type GatewayProtocol, type GeminiChunk, type GeminiPart, type GeminiRequest,
  type ToolCallRepairStrategy, type UploadAttachment,
} from './shim.ts';
import { httpUrl, record } from './state.ts';

export interface GatewayAuthProvider {
  accessToken(force?: boolean): Promise<string>;
  enabled?: () => boolean;
  selectAccounts?: (model?: string) => string[];
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
  estimateRobinTokens?: boolean | (() => boolean);
  onRobinRouting?: (observation: RobinRoutingObservation, accountId?: string) => void;
  onRobinTransientError?: (info: { accountId?: string; detail: string; action: 'failover' | 'retry' | 'fail' }) => void;
  onToolCallRepair?: (info: { name: string; strategy: ToolCallRepairStrategy }) => void;
  onCleanupError?: (error: unknown) => void;
  proxyUrl?: string;
  robinTextIdleTimeoutMs?: number;
  robinOpenToolIdleTimeoutMs?: number;
  robinToolIdleTimeoutMs?: number;
  robinEndTurnIdleTimeoutMs?: number;
  robinTransientRetryDelayMs?: number;
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

function longestCommonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function skipMarkdownLinkTail(text: string, pos: number): number {
  if (text[pos] !== ']' || text[pos + 1] !== '(') return pos;
  let depth = 1;
  let j = pos + 2;
  while (j < text.length && depth > 0) {
    const ch = text[j];
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') return pos;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    j += 1;
  }
  return depth === 0 ? j : pos;
}

/**
 * When a cumulative Robin frame mutates already-emitted plain text (outside a pending `<tool_call>`),
 * locates where genuinely new unseen text begins so streaming continues without freezing or repeating text.
 */
function findPlainTextResyncOffset(emitted: string, next: string, commonPrefixLen: number): number {
  const tail = emitted.slice(commonPrefixLen);
  if (tail) {
    const maxAnchor = Math.min(tail.length, 32);
    const minAnchor = Math.min(tail.length, 6);
    for (let len = maxAnchor; len >= minAnchor; len = len > 12 ? Math.floor(len / 2) : len - 1) {
      const anchor = emitted.slice(emitted.length - len);
      const found = next.indexOf(anchor, commonPrefixLen);
      if (found >= 0 && found - commonPrefixLen <= 256) {
        const end = found + anchor.length;
        const skipped = skipMarkdownLinkTail(next, end);
        if (len >= 3 || skipped > end || found - commonPrefixLen <= 16) {
          return skipped;
        }
      }
      if (len <= minAnchor) break;
    }
    if (tail.startsWith('[') && next[commonPrefixLen] === '[') {
      const closeBracket = next.indexOf(']', commonPrefixLen + 1);
      if (closeBracket > commonPrefixLen && next[closeBracket + 1] === '(') {
        const afterLink = skipMarkdownLinkTail(next, closeBracket);
        if (afterLink > closeBracket) return afterLink;
      }
    }
  }
  return Math.min(emitted.length, next.length);
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
const ROBIN_CANNED_ERROR_TEXTS: readonly string[] = [
  'i seem to be encountering an error. can i try something else for you?',
  'i encountered an error doing what you asked. could you try again?',
  'sorry, something went wrong. please try your request again.',
  'something went wrong. please try again.',
  'something went wrong. please try again later.',
  'an error occurred. please try again.',
  "i'm having a hard time fulfilling your request. can i help you with something else instead?",
  "i'm having trouble fulfilling your request. please try again.",
  "i'm having trouble right now. please try again later.",
  "i couldn't complete your request. please try again.",
  "something went wrong and i couldn't complete your request. please try again.",
  'sorry, i ran into an error. please try again.',
  'i ran into an error. please try again.',
];

function isRobinCannedErrorPrefix(normalized: string): boolean {
  return ROBIN_CANNED_ERROR_TEXTS.some(phrase => phrase.startsWith(normalized));
}

function isRobinCannedErrorExact(normalized: string): boolean {
  return ROBIN_CANNED_ERROR_TEXTS.includes(normalized);
}

class RobinTransientError extends GatewayError {
  constructor(status: number, detail: string) {
    super(status, 'generation', { detail });
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class GatewayClient {
  private readonly queue = new SerialQueue();
  private readonly request: typeof fetch;
  private readonly h2Connector: Http2Connector;
  private readonly protocol: GatewayProtocol;
  private readonly base: string;
  private readonly options: GatewayClientOptions;
  private readonly robinAttachmentCache = new Map<string, { blobId: string; mimeType: string; expiresAt: number }>();

  constructor(options: GatewayClientOptions) {
    this.options = options;
    this.base = httpUrl(options.baseUrl).href;
    this.request = options.fetch ?? createProxyFetchFor(options.proxyUrl);
    this.h2Connector = options.connectHttp2 ?? createHttp2Connector(options.proxyUrl);
    this.protocol = options.protocol ?? 'rpc';
  }

  get gatewayProtocol(): GatewayProtocol {
    return this.protocol;
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

  private pruneRobinAttachmentCache(now = Date.now()): void {
    for (const [key, entry] of this.robinAttachmentCache) {
      if (entry.expiresAt <= now) this.robinAttachmentCache.delete(key);
    }
    while (this.robinAttachmentCache.size > ROBIN_UPLOAD_CACHE_MAX) {
      const oldest = this.robinAttachmentCache.keys().next().value;
      if (oldest === undefined) break;
      this.robinAttachmentCache.delete(oldest);
    }
  }

  private clearRobinAttachmentCacheFor(accountId?: string): void {
    const prefix = `${accountId ?? 'default'}:`;
    for (const key of this.robinAttachmentCache.keys()) {
      if (key.startsWith(prefix)) this.robinAttachmentCache.delete(key);
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
      mimeType: string | null;
      cacheKey: string;
    };

    const candidates: InlineCandidate[] = [];
    const collect = (section: 'system' | 'turn', turnIndex: number, parts: readonly GeminiPart[]) => {
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const inline = parts[partIndex].inlineData;
        if (!inline) continue;
        const bytes = Buffer.from(inline.data, 'base64');
        const detected = bytes.length ? resolveRobinAttachmentMime(bytes, inline.mimeType) : null;
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

    // Keep only supported multimodal attachments from the latest turn, within Robin's per-request budgets.
    // Earlier-turn attachments are never re-uploaded or re-inferred; they become compact text placeholders.
    const lastTurnIndex = input.contents.length - 1;
    const keptKeys = new Set<string>();
    const keptList: InlineCandidate[] = [];
    let totalBytes = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      if (!candidate.mimeType) continue;
      if (candidate.section !== 'turn' || candidate.turnIndex !== lastTurnIndex) continue;
      if (keptList.length >= ROBIN_MAX_ATTACHMENTS_PER_REQUEST) continue;
      if (totalBytes + candidate.bytes.length > ROBIN_MAX_ATTACHMENT_BYTES) continue;
      totalBytes += candidate.bytes.length;
      keptList.push(candidate);
      keptKeys.add(`${candidate.section}:${candidate.turnIndex}:${candidate.partIndex}`);
    }
    keptList.reverse();

    // Batch-upload only uncached unique attachments for this account over a single HTTP/2 upload session.
    const now = Date.now();
    this.pruneRobinAttachmentCache(now);
    const toUpload: { cacheKey: string; data: Buffer; mimeType: string }[] = [];
    const seenUploadKeys = new Set<string>();
    for (const candidate of keptList) {
      if (this.robinAttachmentCache.has(candidate.cacheKey) || seenUploadKeys.has(candidate.cacheKey)) continue;
      seenUploadKeys.add(candidate.cacheKey);
      toUpload.push({ cacheKey: candidate.cacheKey, data: candidate.bytes, mimeType: candidate.mimeType! });
    }
    if (toUpload.length) {
      const uploaded = await uploadRobinAttachments({
        attachments: toUpload.map(item => ({ data: item.data, mimeType: item.mimeType })),
        headers,
        origin: this.options.robinUploadOrigin,
        signal,
        connectHttp2: this.h2Connector,
      });
      const expiresAt = Date.now() + ROBIN_UPLOAD_CACHE_TTL_MS;
      for (let i = 0; i < toUpload.length; i++) {
        this.robinAttachmentCache.set(toUpload[i].cacheKey, {
          blobId: uploaded[i].blobId,
          mimeType: uploaded[i].mimeType,
          expiresAt,
        });
      }
      this.pruneRobinAttachmentCache();
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
            return { text: candidate.mimeType.startsWith('image/') ? '[Earlier image omitted]' : '[Earlier attachment omitted]' };
          }
          const reason = !candidate?.mimeType
            ? `unsupported Robin attachment (${part.inlineData.mimeType})`
            : (candidate.mimeType.startsWith('image/') ? 'oversized or excess image omitted' : 'oversized or excess attachment omitted');
          return { text: `[Attachment omitted: ${reason}]` };
        }
        const cached = this.robinAttachmentCache.get(candidate.cacheKey)!;
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
    const attachments: RobinUploadedAttachment[] = (prompt.query.attachments ?? [])
      .map(att => ({ blobId: att.id, mimeType: canonicalMime(att.mimeType) }))
      .filter(att => ROBIN_NATIVE_ATTACHMENT_MIMES.has(att.mimeType))
      .slice(-ROBIN_MAX_ATTACHMENTS_PER_REQUEST);
    const thinkingCfg = record(input.generationConfig?.thinkingConfig);
    const includeThoughts = typeof thinkingCfg?.includeThoughts === 'boolean' ? thinkingCfg.includeThoughts : true;
    const reasoningEffort = typeof thinkingCfg?.thinkingLevel === 'string' ? thinkingCfg.thinkingLevel : undefined;
    const overrideModeCategory = this.options.resolveRobinModeCategory?.(input.model, accountId);
    const requestedMode = resolveRobinMode(input.model, includeThoughts, reasoningEffort, overrideModeCategory);
    const parser = new ToolCallStream(this.options.onToolCallRepair ? { onRepair: this.options.onToolCallRepair } : undefined);
    const filter = new RobinPartFilter();
    let emittedText = '';
    let emittedThought = '';
    let heldCannedText = '';
    let received = false;
    let emittedToolCallCount = 0;
    let emittedVisibleTextCount = 0;
    let emittedThoughtCount = 0;
    let truncatedEarly = false;
    let streamSummary: RobinGrpcStreamSummary | undefined;
    let observedAttribution: string | undefined;
    let observedResolvedMode: number | undefined;
    let observedThinking: number | undefined;
    let observedThoughtChars = 0;
    let observedFallback: number | undefined;
    let observedDowngrade: number | undefined;

    for await (const frame of streamRobinGrpc({
      baseUrl: this.base,
      path: route,
      headers,
      userText: prompt.query.text,
      attachments,
      model: input.model,
      thinking: includeThoughts,
      reasoningEffort,
      overrideModeCategory,
      temporaryChat: this.options.temporaryChat ?? true,
      signal,
      ...(this.options.robinTextIdleTimeoutMs !== undefined ? { textIdleTimeoutMs: this.options.robinTextIdleTimeoutMs } : {}),
      ...(this.options.robinOpenToolIdleTimeoutMs !== undefined ? { openToolIdleTimeoutMs: this.options.robinOpenToolIdleTimeoutMs } : {}),
      ...(this.options.robinToolIdleTimeoutMs !== undefined ? { toolIdleTimeoutMs: this.options.robinToolIdleTimeoutMs } : {}),
      ...(this.options.robinEndTurnIdleTimeoutMs !== undefined ? { endTurnIdleTimeoutMs: this.options.robinEndTurnIdleTimeoutMs } : {}),
      connectHttp2: this.h2Connector,
      onStatus: (httpStatus, requestId) => onMeta({ status: httpStatus, requestId }),
      onStreamSummary: summary => { streamSummary = summary; },
    })) {
      signal.throwIfAborted();
      if (frame.conversationId) conversations.add(frame.conversationId);
      if (frame.modelVersion) observedAttribution = frame.modelVersion;
      if (frame.resolvedModeCategory !== undefined) observedResolvedMode = frame.resolvedModeCategory;
      if (frame.resolvedThinkingLevel !== undefined) observedThinking = frame.resolvedThinkingLevel;
      if (typeof frame.thought === 'string' && frame.thought.length > observedThoughtChars) {
        observedThoughtChars = frame.thought.length;
      }
      if (frame.fallback !== undefined) observedFallback = frame.fallback;
      if (frame.downgradeReason !== undefined) observedDowngrade = frame.downgradeReason;
      const rawParts: GeminiPart[] = [];
      if (includeThoughts && typeof frame.thought === 'string' && frame.thought.length > 0) {
        const normalizedThought = unwrapRobinAutoLinks(frame.thought);
        if (normalizedThought.length > emittedThought.length) {
          if (normalizedThought.startsWith(emittedThought)) {
            const delta = normalizedThought.slice(emittedThought.length);
            emittedThought = normalizedThought;
            if (delta) rawParts.push({ text: delta, thought: true });
          } else {
            const commonPrefixLen = longestCommonPrefix(emittedThought, normalizedThought);
            const resyncOffset = findPlainTextResyncOffset(emittedThought, normalizedThought, commonPrefixLen);
            const delta = normalizedThought.slice(resyncOffset);
            emittedThought = normalizedThought;
            if (delta) rawParts.push({ text: delta, thought: true });
          }
        }
      }
      if (typeof frame.text === 'string' && frame.text.length > 0) {
        const normalizedText = unwrapRobinAutoLinks(frame.text);
        if (normalizedText !== emittedText) {
          if (normalizedText.startsWith(emittedText)) {
            const delta = normalizedText.slice(emittedText.length);
            emittedText = normalizedText;
            if (delta) rawParts.push(...parser.feed(delta));
          } else {
            const commonPrefixLen = longestCommonPrefix(emittedText, normalizedText);
            const committedOffset = emittedText.length - parser.pendingRawLength;
            if (
              commonPrefixLen >= committedOffset
              && (normalizedText.length >= emittedText.length || normalizedText.includes('</tool_call>') || frame.completed)
            ) {
              parser.discardPending();
              const resynced = normalizedText.slice(committedOffset);
              emittedText = normalizedText;
              if (resynced) rawParts.push(...parser.feed(resynced));
            } else if (normalizedText.length > emittedText.length) {
              const resyncOffset = findPlainTextResyncOffset(emittedText, normalizedText, commonPrefixLen);
              const delta = normalizedText.slice(resyncOffset);
              emittedText = normalizedText;
              if (delta) rawParts.push(...parser.feed(delta));
            }
          }
        }
      }
      const filteredParts = filter.feed(rawParts);
      const parts: GeminiPart[] = [];
      for (const part of filteredParts) {
        if (part.functionCall) {
          if (heldCannedText) {
            parts.push({ text: heldCannedText });
            emittedVisibleTextCount += 1;
            heldCannedText = '';
          }
          emittedToolCallCount += 1;
          parts.push(part);
          continue;
        }
        if (!part.thought && typeof part.text === 'string' && part.text) {
          if (emittedToolCallCount === 0 && emittedVisibleTextCount === 0) {
            const candidate = heldCannedText + part.text;
            const norm = candidate.trimStart().toLowerCase();
            if (!norm || isRobinCannedErrorPrefix(norm)) {
              heldCannedText = candidate;
              continue;
            }
            heldCannedText = '';
            emittedVisibleTextCount += 1;
            parts.push({ text: candidate });
            continue;
          }
          emittedVisibleTextCount += 1;
          parts.push(part);
          continue;
        }
        if (part.thought && typeof part.text === 'string' && part.text) emittedThoughtCount += 1;
        parts.push(part);
      }
      const hasEmittedOutput = emittedToolCallCount > 0 || emittedVisibleTextCount > 0 || emittedThoughtCount > 0;
      received ||= Boolean(parts.length || heldCannedText.length > 0 || frame.completed || emittedText.length > 0);
      if (parts.length) onMeta({ observed: true });
      if (parts.length || (!heldCannedText && (!parser.hasPendingToolMarkup || hasEmittedOutput) && (frame.responseId || frame.modelVersion))) {
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
    const hadPriorOutput = emittedToolCallCount > 0 || emittedVisibleTextCount > 0 || emittedThoughtCount > 0;
    const parserTail = parser.finish();
    const hadPendingToolMarkup = parser.hadUnrecoveredToolMarkup;
    const rawTail = [...filter.feed(parserTail), ...filter.finish()];
    const tail: GeminiPart[] = [];
    for (const part of rawTail) {
      if (part.functionCall) {
        if (heldCannedText) {
          tail.push({ text: heldCannedText });
          emittedVisibleTextCount += 1;
          heldCannedText = '';
        }
        emittedToolCallCount += 1;
        tail.push(part);
      } else if (!part.thought && typeof part.text === 'string' && part.text) {
        if (emittedToolCallCount === 0 && emittedVisibleTextCount === 0) {
          heldCannedText += part.text;
        } else {
          emittedVisibleTextCount += 1;
          tail.push(part);
        }
      } else {
        tail.push(part);
      }
    }
    if (heldCannedText) {
      if (emittedToolCallCount === 0 && emittedVisibleTextCount === 0
          && isRobinCannedErrorExact(heldCannedText.trim().toLowerCase())) {
        throw new RobinTransientError(
          503,
          `Robin upstream returned transient canned error ("${heldCannedText.trim()}")`,
        );
      }
      tail.unshift({ text: heldCannedText });
      emittedVisibleTextCount += 1;
      heldCannedText = '';
    }
    const confirmedComplete = Boolean(
      truncatedEarly
      || streamSummary?.sawCompleted
      || streamSummary?.sawGrpcStatusOk,
    );
    if (!confirmedComplete && !hadPriorOutput && hadPendingToolMarkup && emittedToolCallCount === 0) {
      throw new RobinTransientError(
        504,
        streamSummary?.endedByIdleTimeout
          ? `Robin gRPC stream stalled mid-<tool_call> (${emittedText.length} chars buffered without closing)`
          : `Robin gRPC stream ended mid-<tool_call> without completion (${emittedText.length} chars buffered)`,
      );
    }
    if (
      observedAttribution !== undefined
      || observedResolvedMode !== undefined
      || observedThinking !== undefined
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
        thoughtChars: observedThoughtChars,
        ...(observedFallback !== undefined ? { fallback: observedFallback } : {}),
        ...(observedDowngrade !== undefined ? { downgradeReason: observedDowngrade } : {}),
        observedAt: new Date().toISOString(),
      }, accountId);
    }
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
    let estimatedUsage: Record<string, unknown> | undefined;
    const shouldEstimate = typeof this.options.estimateRobinTokens === 'function'
      ? this.options.estimateRobinTokens()
      : Boolean(this.options.estimateRobinTokens);
    if (shouldEstimate) {
      const attachmentTokens = attachments.reduce(
        (sum, att) => sum + (att.mimeType.startsWith('image/') ? 258 : 512),
        0,
      );
      const promptTokenCount = estimateTokens(prompt.query.text) + attachmentTokens;
      const candidatesTokenCount = emittedText ? estimateTokens(emittedText) : 0;
      const thoughtsTokenCount = emittedThought ? estimateTokens(emittedThought) : 0;
      estimatedUsage = {
        promptTokenCount,
        candidatesTokenCount,
        ...(thoughtsTokenCount > 0 ? { thoughtsTokenCount } : {}),
        cachedContentTokenCount: 0,
        totalTokenCount: promptTokenCount + candidatesTokenCount + thoughtsTokenCount,
        estimated: true,
        source: 'robin-local-estimate',
      };
    }
    onMeta({ completed: true });
    yield {
      candidates: [{ ...(tail.length ? { content: { role: 'model', parts: tail } } : {}), finishReason }],
      ...(estimatedUsage ? { usageMetadata: estimatedUsage } : {}),
    };
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
        ? this.options.auth.selectAccounts(input.model)
        : [];
      const accountCandidates: (string | undefined)[] = selectedIds.length > 0 ? selectedIds : [undefined];

      let transientRetries = 0;

      for (let accountIndex = 0; accountIndex < accountCandidates.length; accountIndex++) {
        const accountId = accountCandidates[accountIndex];
        const hasNextAccount = accountIndex + 1 < accountCandidates.length;
        let body: string | undefined;
        let failoverToNext = false;
        let forceRefresh = false;
        let refreshed401 = false;

        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          let headers: Headers;
          try {
            headers = await this.headers(forceRefresh, accountId);
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
            if (forceRefresh) throw new GatewayError(401, 'OAuth refresh', { cause: error });
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
            const parser = new ToolCallStream(this.options.onToolCallRepair ? { onRepair: this.options.onToolCallRepair } : undefined);
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
              this.clearRobinAttachmentCacheFor(accountId);
            }
            if (!signal.aborted && error instanceof GatewayError && error.status === 401
                && !refreshed401 && authActive && !observed) {
              refreshed401 = true;
              forceRefresh = true;
              continue;
            }
            if (!signal.aborted && !observed && error instanceof RobinTransientError) {
              if (transientRetries < 1) {
                transientRetries += 1;
                if (hasNextAccount) {
                  this.options.onRobinTransientError?.({ accountId, detail: error.message, action: 'failover' });
                  failoverToNext = true;
                  break;
                }
                this.options.onRobinTransientError?.({ accountId, detail: error.message, action: 'retry' });
                await sleepAbortable(this.options.robinTransientRetryDelayMs ?? 500, signal);
                forceRefresh = false;
                continue;
              }
              this.options.onRobinTransientError?.({ accountId, detail: error.message, action: 'fail' });
              throw error;
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
