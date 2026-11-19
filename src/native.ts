import { randomUUID } from 'node:crypto';
import { GenerationError, priceUsage, unknownMeters, type GenerateOptions, type Generation, type ProviderAttempt } from 'cortico/core/generation.ts';
import type { Request, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { BaseProvider, type ProviderHost } from 'cortico/providers/base.ts';
import { nativeChatInput, requestSpec, requestTools } from 'cortico/providers/transport/native-input.ts';
import { ChatResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';
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
    const assembly = new ChatResponseAssembly({ ...request, model });
    const attempts: GatewayAttempt[] = [];
    const generationId = randomUUID();
    const outputLimit = (requestSpec(request, options).maxTokens ?? 65_536) * 12;
    let outputLength = 0;
    let callIndex = 0;
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
      for await (const chunk of this.client.stream(input, { signal: options.signal, onAttempt: attempt => attempts.push(attempt) })) {
        if (chunk.usageMetadata) nativeUsage = chunk.usageMetadata;
        const metadata = { id: chunk.responseId, model: chunk.modelVersion, usage: chunk.usageMetadata && chatUsage(chunk.usageMetadata) };
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          const call = part.functionCall;
          if (call) {
            if (!call.name || (call.args !== undefined && !record(call.args))) throw new Error('Invalid Gemini functionCall');
            const delta = { tool_calls: [{ index: callIndex++, id: call.id || `call_${randomUUID()}`,
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] };
            assembly.feed({ ...metadata, choices: [{ delta }] }, emit);
          } else if (typeof part.text === 'string' && part.text) {
            const delta = part.thought ? { reasoning_content: part.text } : { content: part.text };
            assembly.feed({ ...metadata, choices: [{ delta }] }, emit);
          }
        }
        assembly.feed({ ...metadata, choices: candidate?.finishReason ? [{ finish_reason: chatFinish(candidate.finishReason) }] : [] }, emit);
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
