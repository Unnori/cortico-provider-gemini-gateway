import { record } from './state.ts';

type JsonObject = Record<string, unknown>;

export interface FunctionCall { name: string; args?: JsonObject; id?: string; }
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
  functionCall?: FunctionCall;
  functionResponse?: { name: string; response: JsonObject; id?: string };
}
export interface GeminiRequest {
  model: string;
  contents: { role?: 'user' | 'model'; parts: GeminiPart[] }[];
  systemInstruction?: { role?: string; parts: GeminiPart[] };
  tools?: { functionDeclarations?: { name: string; description?: string; parameters?: JsonObject; parametersJsonSchema?: unknown }[] }[];
  toolConfig?: JsonObject;
  generationConfig?: JsonObject;
}
export interface GeminiChunk {
  candidates?: { content?: { role: 'model'; parts: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: JsonObject;
  responseId?: string;
  modelVersion?: string;
}

export type UploadAttachment = (blob: Blob, mimeType: string) => Promise<string>;
export type GatewayProtocol = 'rpc' | 'gemini' | 'robin';
type ScriptPart =
  | { type: 'text'; text: string; thought?: boolean }
  | { type: 'function_call'; call: FunctionCall }
  | { type: 'function_response'; result: NonNullable<GeminiPart['functionResponse']> }
  | { type: 'attachment'; id: string; mimeType: string };

export interface ContextScript {
  system: ScriptPart[];
  tools: { name: string; description?: string; parameters: unknown }[];
  turns: { role: 'user' | 'model'; parts: ScriptPart[] }[];
  toolCallFormat: string;
}

export interface RpcRequest {
  model: string;
  temporary_chat: boolean;
  stream: true;
  script: ContextScript;
  generationConfig?: JsonObject;
  toolConfig?: JsonObject;
}

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';
const TOOL_CALL_FORMAT = 'To call a declared function, emit <tool_call>{"name":"function_name","args":{}}</tool_call> with a JSON object for args.';
const ROBIN_TOOL_PROTOCOL = [
  TOOL_CALL_FORMAT,
  'Native function calling is unavailable here; express every tool invocation as a <tool_call>{"name":"function_name","args":{}}</tool_call> tag with valid JSON (escape backslashes as \\\\ inside strings, e.g. LaTeX or hex escapes).',
  'Emit multiple tool calls for the same step back-to-back with no text between </tool_call> and the next <tool_call>.',
  'Never fabricate tool results, follow-up turns, or transcript role labels, and never repeat tool arguments as plain text.',
  'Finish your response right after the last </tool_call> of this single step so the caller can execute it and return the real output.',
].join('\n');

const TRANSCRIPT_MARKER_LINE = /^[ \t]*\[(?:User(?:\s+\d+)?|Assistant(?:\s+\d+)?|Caller Tool Result|Tool Result|System)\][ \t]*$/i;
const TRANSCRIPT_MARKER_PREFIX = /(?:^|\r?\n)[ \t]*(?:\[(?:User(?:\s+\d+)?|Assistant(?:\s+\d+)?|Caller Tool Result|Tool Result|System)\]|<\/?tool_response\b|<system_instruction\b|<available_tools\b|<tool_protocol\b)/i;
const PROTOCOL_ECHO_LINE = /^(?:(?:STOP immediately and wait for the caller to return the real tool results\.?|Finish your response right after the last <\/tool_call>[^.\n]*\.?|End your response immediately after the last <\/tool_call>[^.\n]*\.?|Respond now for the latest turn only\.?|Produce only the single next assistant step for the latest turn above\.?|Do NOT repeat tool speech\/arguments in ordinary visible prose\.?|CRITICAL:\s*Native\/internal function-calling channels are DISABLED[^.\n]*\.?)\s*)+$/i;
const PROTOCOL_ECHO_PREFIXES = [
  'stop immediately',
  'finish your response right after',
  'end your response immediately',
  'respond now for the latest turn',
  'produce only the single next assistant step',
  'do not repeat tool speech',
  'critical: native/internal function-calling',
];
const CALL_ORDINAL_RE = /^call_(\d+)_/;

async function replaceMedia(part: GeminiPart, upload?: UploadAttachment): Promise<GeminiPart> {
  if (!part.inlineData || !upload) return part;
  const { inlineData, ...rest } = part;
  const { data, mimeType } = inlineData;
  const ref = await upload(new Blob([Uint8Array.from(Buffer.from(data, 'base64'))], { type: mimeType }), mimeType);
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('Attachment upload returned no reference ID');
  return { ...rest, fileData: { fileUri: ref, mimeType } };
}

async function scriptParts(parts: GeminiPart[], upload?: UploadAttachment): Promise<ScriptPart[]> {
  const output: ScriptPart[] = [];
  for (const original of parts) {
    if (original.inlineData && !upload) throw new Error('RPC inlineData requires an attachment upload hook or endpoint');
    const part = await replaceMedia(original, upload);
    if (part.text !== undefined) output.push({ type: 'text', text: part.text, ...(part.thought && { thought: true }) });
    if (part.functionCall) output.push({ type: 'function_call', call: part.functionCall });
    if (part.functionResponse) output.push({ type: 'function_response', result: part.functionResponse });
    if (part.fileData) output.push({ type: 'attachment', id: part.fileData.fileUri, mimeType: part.fileData.mimeType });
  }
  return output;
}

export async function toRpcRequest(request: GeminiRequest, upload?: UploadAttachment, temporaryChat = true): Promise<RpcRequest> {
  const system = await scriptParts(request.systemInstruction?.parts ?? [], upload);
  const turns: ContextScript['turns'] = [];
  for (const turn of request.contents) {
    turns.push({ role: turn.role ?? 'user', parts: await scriptParts(turn.parts, upload) });
  }
  const tools = request.tools?.flatMap(tool => (tool.functionDeclarations ?? []).map(declaration => ({
    name: declaration.name, description: declaration.description,
    parameters: declaration.parametersJsonSchema ?? declaration.parameters ?? { type: 'object' },
  }))) ?? [];
  return {
    model: request.model, temporary_chat: temporaryChat, stream: true,
    script: { system, tools, turns, toolCallFormat: tools.length ? TOOL_CALL_FORMAT : '' },
    generationConfig: request.generationConfig, toolConfig: request.toolConfig,
  };
}

export async function toGeminiRequest(request: GeminiRequest, upload?: UploadAttachment, temporaryChat = true): Promise<unknown> {
  const { model: _model, ...body } = request;
  if (!upload) return { ...body, temporary_chat: temporaryChat };
  const contents: GeminiRequest['contents'] = [];
  for (const turn of body.contents) {
    const parts: GeminiPart[] = [];
    for (const part of turn.parts) parts.push(await replaceMedia(part, upload));
    contents.push({ ...turn, parts });
  }
  let systemInstruction = body.systemInstruction;
  if (systemInstruction) {
    const parts: GeminiPart[] = [];
    for (const part of systemInstruction.parts) parts.push(await replaceMedia(part, upload));
    systemInstruction = { ...systemInstruction, parts };
  }
  return { ...body, contents, systemInstruction, temporary_chat: temporaryChat };
}

function isTurnBoundaryLine(lineOnly: string): boolean {
  const trimmed = lineOnly.trim();
  if (!trimmed) return false;
  return TRANSCRIPT_MARKER_LINE.test(lineOnly)
    || /^<\/?(?:tool_response|system_instruction|available_tools|tool_protocol)\b/i.test(trimmed)
    || PROTOCOL_ECHO_LINE.test(trimmed);
}

function couldStartBoundary(trimmed: string): boolean {
  if (!trimmed) return true;
  if (trimmed.startsWith('[') || trimmed.startsWith('<')) return true;
  const lower = trimmed.toLowerCase();
  return PROTOCOL_ECHO_PREFIXES.some(prefix => prefix.startsWith(lower) || lower.startsWith(prefix));
}

function cleanHistoricalAssistantText(text: string): string {
  const lines = text.split(/\r?\n/).filter(line => !isTurnBoundaryLine(line));
  return lines.join('\n').trim();
}

function imageExtForMime(mimeType: string): string | undefined {
  const norm = mimeType.trim().toLowerCase();
  if (norm === 'image/png') return 'png';
  if (norm === 'image/jpeg' || norm === 'image/jpg') return 'jpg';
  if (norm === 'image/webp') return 'webp';
  return undefined;
}

function formatRobinPart(
  part: ScriptPart,
  role?: 'user' | 'model',
  imageLabels?: Map<ScriptPart, string>,
): string {
  if (part.type === 'text') {
    // Robin replays history as plain text without native thought signatures;
    // strip historical thinking traces to avoid compounding token/GXU usage across turns.
    if (part.thought) return '';
    return role === 'model' ? cleanHistoricalAssistantText(part.text) : part.text;
  }
  if (part.type === 'function_call') return `${TOOL_OPEN}${JSON.stringify(part.call)}${TOOL_CLOSE}`;
  if (part.type === 'function_response') return `<tool_response name="${part.result.name}"${part.result.id ? ` id="${part.result.id}"` : ''}>${JSON.stringify(part.result.response)}</tool_response>`;
  const imageLabel = imageLabels?.get(part);
  if (imageLabel) return `[Attached image: ${imageLabel} (${part.mimeType})]`;
  return `[Attachment: ${part.id} (${part.mimeType})]`;
}

/**
 * Losslessly strips pure JSON Schema boilerplate ($schema, $id, $comment, boolean
 * additionalProperties, empty required/properties/description, redundant title)
 * from Robin's serialized tool list while preserving every semantic constraint,
 * description, enum, and parameter name.
 */
function pruneRobinToolSchema(node: unknown, propName?: string, depth = 0): unknown {
  if (depth > 16 || !node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(item => pruneRobinToolSchema(item, undefined, depth + 1));

  const src = node as Record<string, unknown>;
  const hasDescription = typeof src.description === 'string' && src.description.trim().length > 0;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (key === '$schema' || key === '$id' || key === '$comment') continue;
    if (key === 'additionalProperties' && typeof value === 'boolean') continue;
    if (key === 'required' && Array.isArray(value) && value.length === 0) continue;
    if (key === 'description' && typeof value === 'string' && !value.trim()) continue;
    if (key === 'title' && typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || hasDescription || (propName && trimmed.toLowerCase() === propName.toLowerCase())) continue;
    }

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [pName, pSchema] of Object.entries(value as Record<string, unknown>)) {
        props[pName] = pruneRobinToolSchema(pSchema, pName, depth + 1);
      }
      if (Object.keys(props).length === 0) continue;
      out[key] = props;
      continue;
    }

    if ((key === '$defs' || key === 'definitions') && value && typeof value === 'object' && !Array.isArray(value)) {
      const defs: Record<string, unknown> = {};
      for (const [dName, dSchema] of Object.entries(value as Record<string, unknown>)) {
        defs[dName] = pruneRobinToolSchema(dSchema, dName, depth + 1);
      }
      if (Object.keys(defs).length === 0) continue;
      out[key] = defs;
      continue;
    }

    if (key === 'items' || key === 'additionalProperties' || key === 'not') {
      out[key] = pruneRobinToolSchema(value, undefined, depth + 1);
      continue;
    }

    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'prefixItems') && Array.isArray(value)) {
      out[key] = value.map(item => pruneRobinToolSchema(item, undefined, depth + 1));
      continue;
    }

    out[key] = value;
  }
  return out;
}

function compactRobinTools(tools: ContextScript['tools']): unknown[] {
  return tools.map(tool => {
    const description = typeof tool.description === 'string' ? tool.description.trim() : '';
    return {
      name: tool.name,
      ...(description ? { description } : {}),
      parameters: pruneRobinToolSchema(tool.parameters, tool.name),
    };
  });
}

export async function toRobinRequest(request: GeminiRequest, upload?: UploadAttachment, _temporaryChat = true): Promise<{ query: { text: string; attachments?: { id: string; mimeType: string }[] } }> {
  const rpc = await toRpcRequest(request, upload, _temporaryChat);
  const sections: string[] = [];
  const attachments: { id: string; mimeType: string }[] = [];
  const imageLabels = new Map<ScriptPart, string>();
  let imageIndex = 0;

  const trackAttachment = (part: ScriptPart) => {
    if (part.type !== 'attachment') return;
    attachments.push({ id: part.id, mimeType: part.mimeType });
    const ext = imageExtForMime(part.mimeType);
    if (ext) imageLabels.set(part, `image-${++imageIndex}.${ext}`);
  };

  for (const part of rpc.script.system) trackAttachment(part);
  for (const turn of rpc.script.turns) {
    for (const part of turn.parts) trackAttachment(part);
  }

  const systemText = rpc.script.system.map(part => formatRobinPart(part, undefined, imageLabels)).filter(Boolean).join('\n').trim();
  if (systemText) sections.push(`<system_instruction>\n${systemText}\n</system_instruction>`);

  if (rpc.script.tools.length) {
    sections.push(`<available_tools>\n${JSON.stringify(compactRobinTools(rpc.script.tools))}\n</available_tools>\n<tool_protocol>\n${ROBIN_TOOL_PROTOCOL}\n</tool_protocol>`);
  }

  if (rpc.script.turns.length === 1 && rpc.script.turns[0].role === 'user' && !systemText && !rpc.script.tools.length) {
    const text = rpc.script.turns[0].parts.map(part => formatRobinPart(part, 'user', imageLabels)).join('\n');
    return { query: { text, ...(attachments.length ? { attachments } : {}) } };
  }

  const historyBlocks: string[] = [];
  for (const turn of rpc.script.turns) {
    if (turn.role === 'model') {
      const formatted = turn.parts.map(part => formatRobinPart(part, 'model', imageLabels)).filter(Boolean).join('\n');
      if (formatted) historyBlocks.push(`[Assistant]\n${formatted}`);
      continue;
    }
    // Separate tool results from user turns so the model never confuses tool responses with [User] turns.
    const toolResults = turn.parts.filter(part => part.type === 'function_response');
    const userParts = turn.parts.filter(part => part.type !== 'function_response');
    if (toolResults.length) {
      const toolOnlyAttachments = userParts.length > 0 && userParts.every(part => part.type === 'attachment');
      const resultParts = toolOnlyAttachments ? [...toolResults, ...userParts] : toolResults;
      historyBlocks.push(`[Caller Tool Result]\n${resultParts.map(part => formatRobinPart(part, 'user', imageLabels)).filter(Boolean).join('\n')}`);
      if (toolOnlyAttachments) continue;
    }
    if (userParts.length) {
      const formatted = userParts.map(part => formatRobinPart(part, 'user', imageLabels)).filter(Boolean).join('\n');
      if (formatted) historyBlocks.push(`[User]\n${formatted}`);
    }
  }

  if (historyBlocks.length) {
    sections.push(historyBlocks.join('\n\n'));
    sections.push('Produce only the single next assistant step for the latest turn above.');
  }
  return { query: { text: sections.join('\n\n'), ...(attachments.length ? { attachments } : {}) } };
}

const HEX4 = /^[0-9a-fA-F]{4}$/;
const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/**
 * Repairs common LLM JSON-string escaping mistakes inside a closed `<tool_call>` payload
 * when strict `JSON.parse` fails (e.g. single backslashes in LaTeX `\circ`/`\Leftrightarrow`
 * or hex literals `\x02`/`\xff`, invalid `\u` sequences, or raw control characters in strings).
 * Never fabricates missing quotes or braces, so genuinely truncated calls still fail safely.
 */
function repairToolCallJson(payload: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = payload[i + 1];
      if (next === undefined) {
        out += '\\\\';
        continue;
      }
      if (VALID_JSON_ESCAPES.has(next)) {
        out += ch + next;
        i += 1;
        continue;
      }
      if (next === 'u') {
        const hex = payload.slice(i + 2, i + 6);
        if (HEX4.test(hex)) {
          out += payload.slice(i, i + 6);
          i += 5;
          continue;
        }
      }
      out += '\\\\' + next;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseCall(payload: string): FunctionCall | undefined {
  const decode = (raw: string): FunctionCall | undefined => {
    const call = record(JSON.parse(raw));
    const args = record(call?.args) ?? record(call?.arguments);
    if (typeof call?.name === 'string' && call.name.trim() && args) {
      return { name: call.name, args, ...(typeof call.id === 'string' && call.id ? { id: call.id } : {}) };
    }
    return undefined;
  };
  try {
    return decode(payload);
  } catch {
    try {
      return decode(repairToolCallJson(payload));
    } catch { /* Invalid tags are returned as text. */ }
  }
  return undefined;
}

/** Retains only a possible opening tag prefix or the current tool block across text deltas. */
export class ToolCallStream {
  private prefix = '';
  private tool: string | undefined;
  private quoted = false;
  private escaped = false;
  private closing = 0;

  /** True when an opening `<tool_call>` (or partial `<tool_call` prefix) has not yet closed with `</tool_call>`. */
  get hasPendingToolMarkup(): boolean {
    return this.tool !== undefined || this.prefix.length > 0;
  }

  feed(text: string): GeminiPart[] {
    const parts: GeminiPart[] = [];
    let offset = 0;
    while (offset < text.length) {
      if (this.tool === undefined) {
        const pending = this.prefix + text.slice(offset);
        this.prefix = '';
        const open = pending.indexOf(TOOL_OPEN);
        if (open < 0) {
          for (let length = Math.min(TOOL_OPEN.length - 1, pending.length); length > 0; length--) {
            if (pending.endsWith(TOOL_OPEN.slice(0, length))) { this.prefix = pending.slice(-length); break; }
          }
          const ordinary = pending.slice(0, pending.length - this.prefix.length);
          if (ordinary) parts.push({ text: ordinary });
          break;
        }
        if (open > 0) parts.push({ text: pending.slice(0, open) });
        text = pending;
        offset = open + TOOL_OPEN.length;
        this.tool = '';
      }

      while (offset < text.length && this.tool !== undefined) {
        const char = text[offset++];
        this.tool += char;
        if (this.tool.length > 1_048_576) throw new Error('Gateway tool call exceeds the 1 MiB parser limit');
        if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (char === '\\') this.escaped = true;
          else if (char === '"') this.quoted = false;
        } else if (char === '"') {
          this.quoted = true;
          this.closing = 0;
        } else {
          this.closing = char === TOOL_CLOSE[this.closing] ? this.closing + 1 : Number(char === '<');
          if (this.closing === TOOL_CLOSE.length) {
            const functionCall = parseCall(this.tool.slice(0, -TOOL_CLOSE.length));
            parts.push(functionCall ? { functionCall } : { text: TOOL_OPEN + this.tool });
            this.tool = undefined;
            this.closing = 0;
          }
        }
      }
    }
    return parts;
  }

  finish(): GeminiPart[] {
    const text = this.tool === undefined ? this.prefix : TOOL_OPEN + this.tool;
    this.prefix = '';
    this.tool = undefined;
    this.quoted = this.escaped = false;
    this.closing = 0;
    return text ? [{ text }] : [];
  }
}

/**
 * Cleans Robin single-turn transcript artifacts from parsed model parts:
 * - Suppresses pure-whitespace gaps between/around `<tool_call>` blocks.
 * - Truncates hallucinated follow-up turns emitted after a tool call — whether signaled by
 *   transcript/role markers (`[User 0002]`, `[Caller Tool Result]`, `<tool_response>`, `[Assistant]`),
 *   echoed protocol stop-instructions (`STOP immediately...`), duplicate `call_id`s, or a reset
 *   per-turn `call_0_` ordinal — preventing both leaked protocol prose and premature second-turn tool execution.
 */
export class RobinPartFilter {
  private seenToolCall = false;
  private seenVisibleText = false;
  private truncated = false;
  private atLineStart = true;
  private pendingLine = '';
  private pendingWhitespace = '';
  private readonly seenCallIds = new Set<string>();
  private lastCallOrdinal: number | null = null;

  get isTruncated(): boolean {
    return this.truncated;
  }

  private flushSafeText(raw: string, out: GeminiPart[]): void {
    if (!raw || this.truncated) return;
    if (!this.seenVisibleText) {
      if (!raw.trim()) {
        this.pendingWhitespace += raw;
        return;
      }
      const trimmedLead = this.seenToolCall ? raw.replace(/^\s+/, '') : (this.pendingWhitespace + raw);
      this.pendingWhitespace = '';
      if (!trimmedLead) return;
      this.seenVisibleText = true;
      out.push({ text: trimmedLead });
      return;
    }
    if (!raw.trim()) {
      this.pendingWhitespace += raw;
      return;
    }
    out.push({ text: this.pendingWhitespace + raw });
    this.pendingWhitespace = '';
  }

  private drainLines(final: boolean, out: GeminiPart[]): void {
    if (this.truncated) {
      this.pendingLine = '';
      this.pendingWhitespace = '';
      return;
    }
    while (true) {
      const nl = this.pendingLine.indexOf('\n');
      if (nl < 0) break;
      const lineWithNl = this.pendingLine.slice(0, nl + 1);
      this.pendingLine = this.pendingLine.slice(nl + 1);
      const wasStart = this.atLineStart;
      this.atLineStart = true;
      if (wasStart) {
        const lineOnly = lineWithNl.replace(/\r?\n$/, '');
        if (isTurnBoundaryLine(lineOnly)) {
          if (this.seenToolCall) {
            this.truncated = true;
            this.pendingLine = '';
            this.pendingWhitespace = '';
            return;
          }
          continue;
        }
      }
      this.flushSafeText(lineWithNl, out);
    }

    if (!this.pendingLine) return;

    if (!final) {
      // Stream immediately once we know the current line cannot start with a transcript marker or echoed stop cue.
      if (!this.atLineStart) {
        const chunk = this.pendingLine;
        this.pendingLine = '';
        this.flushSafeText(chunk, out);
        return;
      }
      const trimmed = this.pendingLine.trimStart();
      if (trimmed && !couldStartBoundary(trimmed)) {
        const chunk = this.pendingLine;
        this.pendingLine = '';
        this.atLineStart = false;
        this.flushSafeText(chunk, out);
      }
      return;
    }

    const tail = this.pendingLine;
    this.pendingLine = '';
    if (this.atLineStart && isTurnBoundaryLine(tail)) {
      if (this.seenToolCall) {
        this.truncated = true;
        this.pendingWhitespace = '';
      }
      return;
    }
    const match = this.atLineStart ? TRANSCRIPT_MARKER_PREFIX.exec(tail) : null;
    if (match && this.seenToolCall) {
      const before = tail.slice(0, match.index);
      if (before) this.flushSafeText(before, out);
      this.truncated = true;
      this.pendingWhitespace = '';
      return;
    }
    this.flushSafeText(tail, out);
  }

  feed(parts: GeminiPart[]): GeminiPart[] {
    const out: GeminiPart[] = [];
    for (const part of parts) {
      if (this.truncated) continue;
      if (part.functionCall) {
        this.drainLines(true, out);
        if (this.truncated) continue;
        const callId = part.functionCall.id;
        if (callId) {
          if (this.seenCallIds.has(callId)) {
            this.truncated = true;
            this.pendingWhitespace = '';
            continue;
          }
          const ordinalMatch = CALL_ORDINAL_RE.exec(callId);
          if (ordinalMatch) {
            const ordinal = Number(ordinalMatch[1]);
            if (this.lastCallOrdinal !== null && ordinal <= this.lastCallOrdinal) {
              this.truncated = true;
              this.pendingWhitespace = '';
              continue;
            }
            this.lastCallOrdinal = ordinal;
          }
          this.seenCallIds.add(callId);
        }
        this.pendingWhitespace = '';
        this.seenToolCall = true;
        this.atLineStart = true;
        out.push(part);
        continue;
      }
      if (part.thought || typeof part.text !== 'string') {
        out.push(part);
        continue;
      }
      this.pendingLine += part.text;
      this.drainLines(false, out);
    }
    return out;
  }

  finish(): GeminiPart[] {
    const out: GeminiPart[] = [];
    this.drainLines(true, out);
    this.pendingWhitespace = '';
    return out;
  }
}

export interface GatewayEvent {
  conversationId?: string;
  parts?: GeminiPart[];
  finishReason?: string;
  usageMetadata?: JsonObject;
  responseId?: string;
  modelVersion?: string;
  errorStatus?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function status(error: unknown): number | undefined {
  if (error == null || error === false) return undefined;
  const raw = record(error);
  const code = Number(raw?.code ?? raw?.status ?? error);
  if (Number.isInteger(code) && code >= 400 && code <= 599) return code;
  if (code === 16 || raw?.status === 'UNAUTHENTICATED') return 401;
  if (code === 7 || raw?.status === 'PERMISSION_DENIED') return 403;
  if (code === 8 || raw?.status === 'RESOURCE_EXHAUSTED') return 429;
  return 502;
}

/** Default JSON/protobuf-JSON event mapping. Gateways can supply a different decoder. */
export function decodeGatewayEvent(payload: unknown): GatewayEvent {
  if (typeof payload === 'string') return { parts: [{ text: payload }] };
  const outer = record(payload);
  if (!outer) throw new Error('Expected a JSON gateway event object');
  const row = record(outer.response) ?? record(outer.data) ?? outer;
  const candidate = Array.isArray(row.candidates) ? record(row.candidates[0]) : undefined;
  if (Array.isArray(row.candidates) && (row.candidates.length > 1 || (candidate?.index !== undefined && candidate.index !== 0))) {
    throw new Error('Gemini gateway supports one response candidate per request');
  }
  const parts = record(candidate?.content)?.parts ?? row.parts;
  let text = str(row.text) ?? str(row.delta) ?? str(record(row.delta)?.text);
  let robinResponseId: string | undefined;
  let robinModelVersion: string | undefined;
  let robinDone = false;
  if (text === undefined && Array.isArray(row.modelResponses)) {
    const texts: string[] = [];
    const grabText = (node: unknown) => {
      if (typeof node === 'string') { if (node) texts.push(node); return; }
      if (Array.isArray(node)) { for (const item of node) grabText(item); return; }
      const obj = record(node);
      if (!obj) return;
      if (typeof obj.text === 'string') texts.push(obj.text);
      else {
        if ('textResponse' in obj) grabText(obj.textResponse);
        if ('shareableTextResponse' in obj) grabText(obj.shareableTextResponse);
      }
    };
    for (const item of row.modelResponses) {
      const mr = record(item);
      if (!mr) continue;
      robinResponseId ??= str(mr.responseId);
      robinModelVersion ??= str(mr.modelAttributionName);
      grabText(mr.textResponse ?? mr);
    }
    if (texts.length) {
      text = texts.join('');
      robinDone = true;
    }
  }
  const feedback = record(row.promptFeedback);
  return {
    conversationId: str(outer.conversationId) ?? str(outer.conversation_id) ?? str(row.conversationId) ?? str(row.conversation_id)
      ?? str(record(row.conversation)?.conversationId) ?? str(record(row.conversation)?.conversation_id),
    parts: Array.isArray(parts) ? parts as GeminiPart[] : text === undefined ? undefined : [{ text }],
    finishReason: str(candidate?.finishReason) ?? str(row.finishReason) ?? str(row.finish_reason)
      ?? (feedback?.blockReason ? 'SAFETY' : (row.done === true || robinDone) ? 'STOP' : undefined),
    usageMetadata: record(row.usageMetadata) ?? record(row.usage_metadata),
    responseId: str(row.responseId) ?? robinResponseId,
    modelVersion: str(row.modelVersion) ?? str(row.modelAttributionName) ?? robinModelVersion,
    errorStatus: status(outer.error ?? row.error),
  };
}
