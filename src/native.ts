import { randomUUID } from 'node:crypto';
import {
  GenerationError,
  priceUsage,
  standardUsage,
  unknownMeters,
  type GenerateOptions,
  type Generation,
  type ProviderAttempt,
  type TokenMeters,
} from 'cortico/core/generation.ts';
import {
  createResponse,
  type OutputItem,
  type Request,
  type Response,
  type StreamEvent,
} from 'cortico/protocol/open-responses/index.ts';
import { ResponseAccumulator, ResponseProtocolError } from 'cortico/protocol/open-responses/stream.ts';
import { BaseProvider, type ProviderHost } from 'cortico/providers/base.ts';
import { nativeChatInput, requestSpec, requestTools } from 'cortico/providers/transport/native-input.ts';
import { chatMeters } from 'cortico/providers/transport/response-meters.ts';
import { canonicalMime, geminiModelId } from './catalog.ts';
import { GatewayClient, type GatewayAttempt } from './client.ts';
import { GatewayError } from './queue.ts';
import type { GeminiPart, GeminiRequest } from './shim.ts';
import { record } from './state.ts';

function inlineMedia(url: unknown): NonNullable<GeminiPart['inlineData']> {
  const match = typeof url === 'string' ? /^data:([^;,]+);base64,(.*)$/s.exec(url) : null;
  if (!match) throw new Error('Gemini media inputs require a base64 data URL with a MIME type');
  return { mimeType: canonicalMime(match[1]), data: match[2] };
}

const SAFE_TOOL_CALL_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const ORDINAL_CALL_ID_RE = /^call_\d+_/;

/**
 * Ensures every emitted tool `call_id` is globally unique across the conversation history
 * and compatible with strict providers (DeepSeek / OpenAI <=40 chars / Claude `[a-zA-Z0-9_-]+`).
 * Always mints fresh IDs for text-parsed Robin/RPC tool calls so LLM-invented repeating IDs
 * like `call_0_end_turn` never poison history when hot-switching providers.
 */
function mintUniqueCallId(
  rawId: string | undefined,
  usedCallIds: Set<string>,
  alwaysMint: boolean,
): string {
  const trimmed = typeof rawId === 'string' ? rawId.trim() : '';
  if (
    !alwaysMint
    && trimmed
    && SAFE_TOOL_CALL_ID_RE.test(trimmed)
    && !ORDINAL_CALL_ID_RE.test(trimmed)
    && !usedCallIds.has(trimmed)
  ) {
    usedCallIds.add(trimmed);
    return trimmed;
  }
  let generated: string;
  do {
    generated = `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  } while (usedCallIds.has(generated));
  usedCallIds.add(generated);
  return generated;
}

function toolConfig(choice: Request['tool_choice']): GeminiRequest['toolConfig'] {
  if (choice == null) return undefined;
  if (typeof choice !== 'string' && choice.type === 'function') {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
  }
  if (choice === 'none' || choice === 'auto' || choice === 'required') {
    return { functionCallingConfig: { mode: { none: 'NONE', auto: 'AUTO', required: 'ANY' }[choice] } };
  }
  throw new Error('Unsupported Gemini tool choice');
}

export function toGeminiInput(
  request: Request, options: GenerateOptions, host: Pick<ProviderHost, 'readBlob' | 'keepThinking'>,
  accepts: (mime: string) => boolean,
): GeminiRequest {
  const spec = requestSpec(request, options);
  const system: GeminiPart[] = [];
  const contents: GeminiRequest['contents'] = [];
  const names = new Map<string, string>();
  for (const message of nativeChatInput(request, options)) {
    if (message.role === 'system') {
      if (message.content) system.push({ text: message.content });
      continue;
    }
    const parts: GeminiPart[] = [];
    if (message.role === 'assistant') {
      if (message.reasoning_content && (message.head || host.keepThinking())) parts.push({ text: message.reasoning_content, thought: true });
      if (message.content) parts.push({ text: message.content });
      for (const call of message.tool_calls ?? []) {
        const args = record(JSON.parse(call.function.arguments || '{}'));
        if (!args) throw new Error('Gemini function arguments must be a JSON object');
        names.set(call.id, call.function.name);
        parts.push({ functionCall: { name: call.function.name, id: call.id, args } });
      }
    } else if (message.role === 'tool') {
      const id = message.tool_call_id;
      const name = id ? names.get(id) : undefined;
      if (!name) throw new Error('Gemini function output has no preceding function call');
      parts.push({ functionResponse: { name, id, response: { output: message.content } } });
    } else if (message.content && !message.parts) {
      parts.push({ text: message.content });
    }
    for (const part of message.parts ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') {
        if (message.role !== 'tool' && part.text) parts.push({ text: part.text });
        continue;
      }
      const data = part.type === 'file' ? record(part.file)?.file_data : record(part.image_url)?.url;
      const media = inlineMedia(data);
      if (!accepts(media.mimeType)) throw new Error(`Gemini gateway model does not accept ${media.mimeType}`);
      parts.push({ inlineData: media });
    }
    for (const ref of message.blobs ?? []) {
      const mimeType = canonicalMime(ref.mime);
      if (!accepts(mimeType)) continue;
      const data = host.readBlob(ref.handle);
      if (data) parts.push({ inlineData: { mimeType, data: data.toString('base64') } });
    }
    if (!parts.length) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const last = contents.at(-1);
    if (role === 'user' && last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const tools = requestTools(request);
  const generationConfig: NonNullable<GeminiRequest['generationConfig']> = {};
  if (spec.maxTokens !== undefined) generationConfig.maxOutputTokens = spec.maxTokens;
  if (spec.temperature !== undefined) generationConfig.temperature = spec.temperature;
  generationConfig.thinkingConfig = {
    includeThoughts: spec.thinking,
    ...(spec.reasoningEffort ? { thinkingLevel: spec.reasoningEffort } : {}),
  };
  if (request.top_p != null) generationConfig.topP = request.top_p;
  if (request.text?.format && request.text.format.type !== 'text') generationConfig.responseMimeType = 'application/json';
  if (request.text?.format?.type === 'json_schema') generationConfig.responseJsonSchema = request.text.format.schema;
  return {
    model: geminiModelId(spec.model), contents, ...(system.length && { systemInstruction: { parts: system } }),
    ...(tools?.length && { tools: [{ functionDeclarations: tools.map(tool => ({
      name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters,
    })) }] }),
    toolConfig: toolConfig(request.tool_choice), generationConfig,
  };
}

function count(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function chatUsage(usage: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof usage.promptTokenCount !== 'number') return undefined;
  const input = count(usage.promptTokenCount) + count(usage.toolUsePromptTokenCount);
  const reasoning = count(usage.thoughtsTokenCount);
  const output = count(usage.candidatesTokenCount) + reasoning;
  return {
    prompt_tokens: input, completion_tokens: output, total_tokens: count(usage.totalTokenCount, input + output),
    prompt_tokens_details: { cached_tokens: count(usage.cachedContentTokenCount) },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

function chatFinish(reason: string): string {
  if (reason === 'STOP' || reason === 'FINISH_REASON_UNSPECIFIED') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'].includes(reason)) return 'content_filter';
  throw new Error(`Gemini gateway finished with ${reason}`);
}

type MutableOutput = {
  id: string;
  type: string;
  status?: string;
  content?: Array<{ type: string; text: string; annotations?: unknown[] }>;
  summary?: unknown[];
  call_id?: string;
  name?: string;
  arguments?: string;
  role?: string;
};

type ChunkMeta = { id?: string; model?: string; usage?: Record<string, unknown> };

/**
 * Open Responses stream assembly that eagerly closes each completed tool call
 * (and any preceding reasoning/text item) as soon as it arrives, unlocking Cortico's
 * native `EagerDispatch` so tools like `pet_say` / `console_send` run immediately
 * instead of waiting for HTTP/2 stream shutdown or idle timers.
 */
class GatewayResponseAssembly {
  private readonly response: Response;
  private readonly accumulator = new ResponseAccumulator();
  private sequence = 0;
  private started = false;
  private finishReason: string | null = null;
  private usage: TokenMeters = unknownMeters();
  private readonly output: MutableOutput[] = [];
  private readonly closed = new Set<number>();
  private openText: { kind: 'reasoning' | 'content'; index: number } | null = null;
  private lastTouched: number | null = null;

  constructor(request: Request) {
    this.response = createResponse(`resp_${randomUUID()}`, request);
  }

  private send(event: Record<string, unknown>, emit: (event: StreamEvent) => void): void {
    const complete = structuredClone({ ...event, sequence_number: this.sequence++ }) as StreamEvent;
    this.accumulator.accept(complete);
    emit(complete);
  }

  private ensureStarted(meta: ChunkMeta, emit: (event: StreamEvent) => void): void {
    if (meta.usage) this.usage = chatMeters(meta.usage);
    if (this.started) return;
    if (meta.id) this.response.id = meta.id;
    if (meta.model) this.response.model = meta.model;
    this.send({ type: 'response.created', response: this.response }, emit);
    this.started = true;
  }

  private closeOpenText(incomplete: boolean, emit: (event: StreamEvent) => void): void {
    if (!this.openText) return;
    const { index } = this.openText;
    this.openText = null;
    if (this.closed.has(index)) return;
    const item = this.output[index];
    const part = item.content![0];
    this.send({ type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part }, emit);
    if (item.type !== 'reasoning') item.status = incomplete ? 'incomplete' : 'completed';
    this.send({ type: 'response.output_item.done', output_index: index, item }, emit);
    this.closed.add(index);
  }

  feedMeta(meta: ChunkMeta, emit: (event: StreamEvent) => void): void {
    this.ensureStarted(meta, emit);
  }

  feedText(kind: 'reasoning' | 'content', delta: string, meta: ChunkMeta, emit: (event: StreamEvent) => void): void {
    this.ensureStarted(meta, emit);
    if (!delta) return;
    if (this.openText && this.openText.kind !== kind) {
      this.closeOpenText(false, emit);
    }
    if (!this.openText) {
      const index = this.output.length;
      const item: MutableOutput = kind === 'reasoning'
        ? { type: 'reasoning', id: `rs_${randomUUID()}`, summary: [], content: [] }
        : { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'in_progress', content: [] };
      this.output.push(item);
      this.send({ type: 'response.output_item.added', output_index: index, item }, emit);
      const part = kind === 'reasoning'
        ? { type: 'reasoning_text', text: '' }
        : { type: 'output_text', text: '', annotations: [] };
      this.send({ type: 'response.content_part.added', output_index: index, item_id: item.id, content_index: 0, part }, emit);
      item.content = [part];
      this.openText = { kind, index };
    }
    const { index } = this.openText;
    const item = this.output[index];
    this.send({
      type: kind === 'reasoning' ? 'response.reasoning.delta' : 'response.output_text.delta',
      output_index: index,
      item_id: item.id,
      content_index: 0,
      delta,
      ...(kind === 'content' ? { logprobs: [] } : {}),
    }, emit);
    item.content![0].text += delta;
    this.lastTouched = index;
  }

  feedFunctionCall(
    call: { id: string; name: string; argumentsJson: string },
    meta: ChunkMeta,
    emit: (event: StreamEvent) => void,
  ): void {
    this.ensureStarted(meta, emit);
    this.closeOpenText(false, emit);
    const index = this.output.length;
    const item: MutableOutput = {
      type: 'function_call',
      id: `fc_${randomUUID()}`,
      call_id: call.id,
      name: call.name,
      arguments: '',
      status: 'in_progress',
    };
    this.output.push(item);
    this.send({ type: 'response.output_item.added', output_index: index, item }, emit);
    if (call.argumentsJson) {
      this.send({
        type: 'response.function_call_arguments.delta',
        output_index: index,
        item_id: item.id,
        delta: call.argumentsJson,
      }, emit);
      item.arguments = call.argumentsJson;
    }
    this.send({
      type: 'response.function_call_arguments.done',
      output_index: index,
      item_id: item.id,
      arguments: item.arguments,
    }, emit);
    item.status = 'completed';
    this.send({ type: 'response.output_item.done', output_index: index, item }, emit);
    this.closed.add(index);
    this.lastTouched = index;
  }

  setFinishReason(reason: string, meta: ChunkMeta, emit: (event: StreamEvent) => void): void {
    this.ensureStarted(meta, emit);
    this.finishReason = reason;
  }

  finish(emit: (event: StreamEvent) => void): Response {
    if (!this.finishReason) throw new ResponseProtocolError('Chat transport ended without finish_reason');
    const incomplete = this.finishReason === 'length' || this.finishReason === 'content_filter';
    this.closeOpenText(incomplete && this.openText?.index === this.lastTouched, emit);
    this.response.output = this.output as OutputItem[];
    this.response.usage = standardUsage(this.usage);
    this.response.status = incomplete ? 'incomplete' : 'completed';
    this.response.completed_at = Math.floor(Date.now() / 1000);
    this.response.incomplete_details = incomplete
      ? { reason: this.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' }
      : null;
    this.send({ type: `response.${this.response.status}`, response: this.response }, emit);
    return this.accumulator.finish();
  }

  snapshot(): Response | null {
    return this.accumulator.snapshot();
  }

  meters(): TokenMeters {
    return structuredClone(this.usage);
  }
}

export class CustomGeminiProvider extends BaseProvider {
  private readonly name: string;
  private readonly client: GatewayClient;
  private readonly host: ProviderHost;
  private readonly prepare: (model: string) => (mime: string) => boolean;

  constructor(
    name: string,
    client: GatewayClient,
    host: ProviderHost,
    prepare: (model: string) => (mime: string) => boolean,
  ) {
    super();
    this.name = name;
    this.client = client;
    this.host = host;
    this.prepare = prepare;
  }

  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const model = request.model ?? options.nativeSpec?.model ?? '';
    const origin = options.origin ?? { instance: this.name, module: 'gemini-gateway', model, compatibilityDomain: this.name };
    const assembly = new GatewayResponseAssembly({ ...request, model });
    const attempts: GatewayAttempt[] = [];
    const generationId = randomUUID();
    const outputLimit = (requestSpec(request, options).maxTokens ?? 65_536) * 12;
    let outputLength = 0;
    let nativeUsage: Record<string, unknown> | undefined;
    const emit = (event: StreamEvent) => {
      if ('delta' in event && typeof event.delta === 'string') {
        outputLength += event.delta.length;
        if (outputLength > outputLimit) throw new Error('Gemini gateway exceeded the output character limit');
      }
      if (!options.signal?.aborted) options.onEvent?.(event);
    };

    const attemptsFor = (response: Generation['response'] | null): ProviderAttempt[] => attempts.map((attempt, ordinal) => {
      const last = ordinal === attempts.length - 1;
      const meters = last ? assembly.meters() : unknownMeters();
      if (last && nativeUsage) meters.native = nativeUsage;
      return {
        id: randomUUID(), generationId, ordinal, origin, startedAt: attempt.startedAt, elapsedMs: attempt.elapsedMs,
        requestId: attempt.requestId, responseId: last ? response?.id ?? assembly.snapshot()?.id ?? null : null,
        outcome: last && options.signal?.aborted ? 'aborted' : attempt.completed && response?.status === 'completed' ? 'completed'
          : attempt.completed && response?.status === 'incomplete' ? 'incomplete' : 'failed',
        status: attempt.status, serviceTier: null, purpose: options.diagnostic ? 'diagnostic' : 'generation', meters,
        charges: priceUsage(meters, options.quote?.({ startedAt: attempt.startedAt, requestedServiceTier: null }) ?? []),
      };
    });
    try {
      const input = toGeminiInput(request, options, this.host, this.prepare(model));
      if (!/^gemini-[\w.:-]+$/.test(input.model)) throw new Error('Configure a Gemini model ID for this gateway');
      const usedCallIds = new Set<string>();
      for (const turn of input.contents) {
        for (const part of turn.parts) {
          if (part.functionCall?.id) usedCallIds.add(part.functionCall.id);
          if (part.functionResponse?.id) usedCallIds.add(part.functionResponse.id);
        }
      }
      const alwaysMintCallId = this.client.gatewayProtocol !== 'gemini';
      for await (const chunk of this.client.stream(input, { signal: options.signal, onAttempt: attempt => attempts.push(attempt) })) {
        if (chunk.usageMetadata) nativeUsage = chunk.usageMetadata;
        const metadata: ChunkMeta = { id: chunk.responseId, model: chunk.modelVersion, usage: chunk.usageMetadata && chatUsage(chunk.usageMetadata) };
        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];
        for (const part of parts) {
          const call = part.functionCall;
          if (call) {
            if (!call.name || (call.args !== undefined && !record(call.args))) throw new Error('Invalid Gemini functionCall');
            assembly.feedFunctionCall({
              id: mintUniqueCallId(call.id, usedCallIds, alwaysMintCallId),
              name: call.name,
              argumentsJson: JSON.stringify(call.args ?? {}),
            }, metadata, emit);
          } else if (typeof part.text === 'string' && part.text) {
            assembly.feedText(part.thought ? 'reasoning' : 'content', part.text, metadata, emit);
          }
        }
        if (candidate?.finishReason) {
          assembly.setFinishReason(chatFinish(candidate.finishReason), metadata, emit);
        } else if (!parts.length) {
          assembly.feedMeta(metadata, emit);
        }
      }
      options.signal?.throwIfAborted();
      const response = assembly.finish(emit);
      return { response, origin, attempts: attemptsFor(response) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof GatewayError
        ? error.status
        : /Complete desktop OAuth login/i.test(message)
          ? 401
          : /Configure a Gemini model ID|does not accept|Unsupported Gemini|Invalid Gemini|function output has no preceding/i.test(message)
            ? 400
            : 0;
      const body = error instanceof GatewayError ? error.body : '';
      throw new GenerationError(message, attemptsFor(null), assembly.snapshot(), origin, status, body, { cause: error });
    }
  }
}
