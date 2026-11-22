import { randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import { TextDecoder } from 'node:util';
import { connectHttp2, type Http2Connector } from './http.ts';
import { GatewayError, sanitizeUpstreamText } from './queue.ts';
import type { QuotaSnapshot, QuotaWindow } from './quota.ts';

export const ROBIN_GRPC_PROCESS_QUERY = '/assistant.mobile.robin.RobinService/ProcessQuery';
export const ROBIN_GRPC_GET_USAGE_INFO = '/assistant.mobile.robin.RobinService/GetUsageInfo';
export const ROBIN_GRPC_GET_USER_STATUS = '/assistant.mobile.robin.RobinService/GetUserStatus';
export const ROBIN_GRPC_GET_TERMS_VERSION = '/assistant.mobile.robin.RobinService/GetTermsOfServiceVersion';
export const ROBIN_GRPC_ACCEPT_TERMS = '/assistant.mobile.robin.RobinService/AcceptTermsOfService';
export const ROBIN_UPLOAD_ORIGIN = 'https://push.clients6.google.com';
export const ROBIN_UPLOAD_PATH = '/upload/';
export const ROBIN_CLIENT_VERSION = '1.135.1.1291';
export const ROBIN_MAX_IMAGES_PER_REQUEST = 4;
export const ROBIN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ROBIN_MAX_ATTACHMENTS_PER_REQUEST = 4;
export const ROBIN_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export type RobinImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export const ROBIN_NATIVE_IMAGE_MIMES: ReadonlySet<string> = new Set<RobinImageMime>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export const ROBIN_ATTACHMENT_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/mpeg': 'mpeg',
  'video/x-msvideo': 'avi',
  'video/x-ms-wmv': 'wmv',
  'video/x-flv': 'flv',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
};

export const ROBIN_NATIVE_ATTACHMENT_MIMES: ReadonlySet<string> = new Set(Object.keys(ROBIN_ATTACHMENT_EXT));

const ROBIN_MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/opus': 'audio/ogg',
  'video/mov': 'video/quicktime',
  'video/avi': 'video/x-msvideo',
};

const STRICT_MAGIC_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);

export interface RobinUploadedImage {
  blobId: string;
  mimeType: RobinImageMime;
}

export interface RobinUploadedAttachment {
  blobId: string;
  mimeType: string;
  name?: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

function normalizeRobinMime(mime?: string): string | undefined {
  if (!mime) return undefined;
  const cleaned = mime.split(';', 1)[0].trim().toLowerCase();
  if (!cleaned) return undefined;
  return ROBIN_MIME_ALIASES[cleaned] ?? cleaned;
}

/** Inspects actual magic bytes so mislabeled/corrupted images cannot poison a Robin turn. */
export function detectRobinImageMime(bytes: Buffer): RobinImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Resolves a Robin-supported native attachment MIME type (images, audio, video, PDF, text)
 * from magic bytes with safe fallback to declared MIME for container/text formats.
 */
export function resolveRobinAttachmentMime(bytes: Buffer, declaredMime?: string): string | null {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  const declared = normalizeRobinMime(declaredMime);
  const coreImage = detectRobinImageMime(bytes);
  if (coreImage) return coreImage;

  if (bytes.length >= 6) {
    const head6 = bytes.toString('latin1', 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'fLaC') return 'audio/flac';
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(EBML_SIGNATURE)) {
    return declared === 'audio/webm' ? 'audio/webm' : 'video/webm';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    if (declared && ['audio/mp4', 'video/mp4', 'video/quicktime', 'video/3gpp', 'image/heic', 'image/heif'].includes(declared)) {
      return declared;
    }
    const brand = bytes.toString('latin1', 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand === 'heif') return 'image/heif';
    if (brand.startsWith('3gp')) return 'video/3gpp';
    return 'video/mp4';
  }
  if (bytes.length >= 3 && bytes.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return declared === 'audio/aac' ? 'audio/aac' : 'audio/mpeg';
  }

  if (declared && ROBIN_NATIVE_ATTACHMENT_MIMES.has(declared) && !STRICT_MAGIC_MIMES.has(declared)) {
    return declared;
  }
  return null;
}

function defaultAttachmentName(mimeType: string, counters: Record<'image' | 'audio' | 'video' | 'file', number>): string {
  const ext = ROBIN_ATTACHMENT_EXT[mimeType] ?? 'bin';
  const kind: 'image' | 'audio' | 'video' | 'file' = mimeType.startsWith('image/')
    ? 'image'
    : mimeType.startsWith('audio/')
      ? 'audio'
      : mimeType.startsWith('video/')
        ? 'video'
        : 'file';
  counters[kind] += 1;
  return `${kind}-${counters[kind]}.${ext}`;
}

export function encodeRobinAttachments(attachments: readonly RobinUploadedAttachment[] = []): Buffer[] {
  if (attachments.length > ROBIN_MAX_ATTACHMENTS_PER_REQUEST) {
    throw new RangeError(`Robin ProcessQuery supports at most ${ROBIN_MAX_ATTACHMENTS_PER_REQUEST} attachments per request`);
  }
  const counters: Record<'image' | 'audio' | 'video' | 'file', number> = { image: 0, audio: 0, video: 0, file: 0 };
  return attachments.map(attachment => {
    const mimeType = normalizeRobinMime(attachment.mimeType);
    if (!mimeType || !ROBIN_NATIVE_ATTACHMENT_MIMES.has(mimeType)) {
      throw new TypeError(`Unsupported Robin attachment MIME type: ${String(attachment.mimeType)}`);
    }
    if (!attachment.blobId || Buffer.byteLength(attachment.blobId) > 4096 || /\s|[\x00-\x1f\x7f]/u.test(attachment.blobId)) {
      throw new TypeError('Invalid Robin attachment blob ID');
    }
    // UserQuery.attachments (field 3) -> Attachment.blob (field 1), name (field 2).
    // Blob fields: blobId (1), type (2 = 1), mimeType (3), source (4 = 1).
    const blob = Buffer.concat([
      stringField(1, attachment.blobId),
      varintField(2, 1),
      stringField(3, mimeType),
      varintField(4, 1),
    ]);
    const fileName = attachment.name?.trim() || defaultAttachmentName(mimeType, counters);
    return lengthDelimited(3, Buffer.concat([
      lengthDelimited(1, blob),
      stringField(2, fileName),
    ]));
  });
}

export function encodeRobinImageAttachments(images: readonly RobinUploadedImage[] = []): Buffer[] {
  if (images.length > ROBIN_MAX_IMAGES_PER_REQUEST) {
    throw new RangeError(`Robin ProcessQuery supports at most ${ROBIN_MAX_IMAGES_PER_REQUEST} images per request`);
  }
  for (const image of images) {
    if (!ROBIN_NATIVE_IMAGE_MIMES.has(image.mimeType)) {
      throw new TypeError(`Unsupported Robin image MIME type: ${String(image.mimeType)}`);
    }
  }
  return encodeRobinAttachments(images);
}

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_FIELDS = 100_000;
const MAX_DEPTH = 32;
const MAX_FIELD_NUMBER = 0x1fffffff;
const MAX_WIRE_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface ProtobufField {
  number: number;
  wire: number;
  raw: Buffer;
  payload: Buffer;
}

export function isRobinGrpcRoute(route: string | undefined): boolean {
  if (!route) return false;
  const trimmed = route.trim();
  if (!trimmed || trimmed.startsWith('/$rpc/') || trimmed.startsWith('$rpc/')) return false;
  return /^\/?assistant\.mobile\.robin\.[^/?#\s]+\/[^/?#\s]+$/i.test(trimmed);
}

export function normalizeGrpcPath(route: string): string {
  const trimmed = route.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function encodeVarint(value: number | bigint): Buffer {
  if (typeof value !== 'bigint' && !Number.isSafeInteger(value)) throw new RangeError('Invalid varint');
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError('Varint out of uint64 range');
  const out: number[] = [];
  do {
    out.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(out);
}

function readVarintAt(input: Buffer, start: number): { value: bigint; end: number } {
  let n = 0n;
  for (let i = 0; i < 10; i++) {
    if (start + i >= input.length) throw new Error('Truncated varint');
    const b = input[start + i];
    if (i === 9 && b > 1) throw new Error('Varint overflows uint64');
    n |= BigInt(b & 127) << BigInt(i * 7);
    if (!(b & 128)) return { value: n, end: start + i + 1 };
  }
  throw new Error('Invalid varint');
}

export function varintField(number: number, value: number | bigint): Buffer {
  if (!Number.isInteger(number) || number < 1 || number > MAX_FIELD_NUMBER) throw new RangeError('Invalid field number');
  return Buffer.concat([encodeVarint(BigInt(number) * 8n), encodeVarint(BigInt(value))]);
}

export function lengthDelimited(number: number, value: Buffer): Buffer {
  if (!Number.isInteger(number) || number < 1 || number > MAX_FIELD_NUMBER) throw new RangeError('Invalid field number');
  if (value.length > MAX_MESSAGE_BYTES) throw new RangeError('Protobuf message exceeds 16 MiB');
  const result = Buffer.concat([encodeVarint(BigInt(number) * 8n + 2n), encodeVarint(value.length), value]);
  if (result.length > MAX_MESSAGE_BYTES) throw new RangeError('Protobuf message exceeds 16 MiB');
  return result;
}

export function stringField(number: number, value: string): Buffer {
  return lengthDelimited(number, Buffer.from(value, 'utf8'));
}

export function parseProtobuf(input: Buffer): ProtobufField[] {
  if (input.length > MAX_MESSAGE_BYTES) throw new RangeError('Protobuf message exceeds 16 MiB');
  let count = 0;
  function sequence(start: number, group: number | null, depth: number): { fields: ProtobufField[]; end: number; contentEnd?: number } {
    if (depth > MAX_DEPTH) throw new Error('Protobuf nesting exceeds limit');
    const fields: ProtobufField[] = [];
    let pos = start;
    while (pos < input.length) {
      if (++count > MAX_FIELDS) throw new Error('Too many protobuf fields');
      const begin = pos;
      const key = readVarintAt(input, pos);
      pos = key.end;
      const number = Number(key.value >> 3n);
      const wire = Number(key.value & 7n);
      if (number < 1 || number > MAX_FIELD_NUMBER) throw new Error('Invalid protobuf field number');
      if (wire === 4) {
        if (number !== group) throw new Error('Unmatched end group');
        return { fields, end: pos, contentEnd: begin };
      }
      let payloadStart = pos;
      let payloadEnd: number | undefined;
      if (wire === 0) {
        pos = readVarintAt(input, pos).end;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else if (wire === 2) {
        const size = readVarintAt(input, pos);
        if (size.value > BigInt(MAX_MESSAGE_BYTES)) throw new Error('Oversized protobuf field');
        payloadStart = size.end;
        pos = payloadStart + Number(size.value);
      } else if (wire === 3) {
        const nested = sequence(pos, number, depth + 1);
        payloadEnd = nested.contentEnd;
        pos = nested.end;
      } else {
        throw new Error('Unsupported protobuf wire type');
      }
      if (pos > input.length) throw new Error('Truncated protobuf field');
      payloadEnd ??= pos;
      fields.push({
        number,
        wire,
        raw: input.subarray(begin, pos),
        payload: input.subarray(payloadStart, payloadEnd),
      });
    }
    if (group !== null) throw new Error('Unterminated protobuf group');
    return { fields, end: pos };
  }
  return sequence(0, null, 0).fields;
}

function singularField(fields: ProtobufField[], number: number, wire?: number): ProtobufField | undefined {
  const found = fields.filter(f => f.number === number);
  if (!found.length) return undefined;
  const match = found[0];
  if (wire !== undefined && match.wire !== wire) return undefined;
  return match;
}

function decodeVarintScalar(field: ProtobufField | undefined): number | undefined {
  if (!field || field.wire !== 0 || !field.payload.length) return undefined;
  let value = 0n;
  for (let i = 0; i < field.payload.length; i++) {
    const b = field.payload[i];
    value |= BigInt(b & 127) << BigInt(i * 7);
    if (!(b & 128)) {
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
    }
  }
  return undefined;
}

function decodeStringField(fields: ProtobufField[], number: number): string | undefined {
  const field = singularField(fields, number, 2);
  if (!field) return undefined;
  try {
    return utf8.decode(field.payload);
  } catch {
    return undefined;
  }
}

function decodeTimestamp(bytes: Buffer): string | undefined {
  try {
    const fields = parseProtobuf(bytes);
    const seconds = decodeVarintScalar(singularField(fields, 1, 0));
    const nanos = decodeVarintScalar(singularField(fields, 2, 0)) ?? 0;
    if (seconds === undefined || seconds > 253_402_300_799 || nanos > 999_999_999) return undefined;
    const ms = seconds * 1000 + Math.floor(nanos / 1e6);
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  } catch {
    return undefined;
  }
}

export function frameGrpcMessage(bytes: Buffer): Buffer {
  if (bytes.length > MAX_MESSAGE_BYTES) throw new RangeError('gRPC message exceeds budget');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

export class GrpcMessageReader {
  private readonly maxBytes: number;
  private pending: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(maxBytes = MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes;
  }

  push(bytes: Buffer): Buffer[] {
    if (this.closed) throw new Error('gRPC reader already closed');
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const needed = this.pending.length < 5
        ? 5 - this.pending.length
        : 5 + this.pending.readUInt32BE(1) - this.pending.length;
      const take = Math.min(needed, bytes.length - offset);
      this.pending = Buffer.concat([this.pending, bytes.subarray(offset, offset + take)]);
      offset += take;
      if (this.pending.length < 5) continue;
      if (this.pending[0] !== 0) throw new Error('Compressed gRPC messages are not supported');
      const length = this.pending.readUInt32BE(1);
      if (length > this.maxBytes) throw new RangeError('gRPC frame exceeds budget');
      if (this.pending.length === length + 5) {
        frames.push(this.pending.subarray(5));
        this.pending = Buffer.alloc(0);
      }
    }
    return frames;
  }

  finish(): void {
    this.closed = true;
    if (this.pending.length) throw new Error('Truncated gRPC stream');
  }
}

export interface RobinModeSelection {
  modeCategory?: number;
  thinkingLevel: number;
  smartModelSelection: boolean;
}

export interface RobinThinkingOption {
  label: string;
  description?: string;
  thinkingLevel: number;
}

export interface RobinModeOption {
  modeVariantId?: string;
  title: string;
  modelName: string;
  description?: string;
  modeCategory: number;
  modelId: string;
}

export interface RobinUserStatus {
  policy?: string;
  modes: RobinModeOption[];
  thinkingOptions: RobinThinkingOption[];
  fetchedAt: string;
}

export interface RobinRoutingObservation {
  requestedModel: string;
  requestedModeCategory?: number;
  requestedThinkingLevel: number;
  resolvedModeCategory?: number;
  resolvedThinkingLevel?: number;
  attribution?: string;
  thoughtChars?: number;
  fallback?: number;
  downgradeReason?: number;
  observedAt: string;
}

export function slugifyRobinModelId(modelName: string, title: string, modeCategory: number): string {
  const source = (modelName || title || '').trim().toLowerCase();
  const cleaned = source
    .replace(/^gemini[\s-]+/i, '')
    .replace(/[^a-z0-9.:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!cleaned || ['auto', 'default', 'fast', 'pro', 'thinking'].includes(cleaned)) {
    if (modeCategory === 3) return 'gemini-robin-pro';
    if (modeCategory === 1) return 'gemini-robin-fast';
    if (modeCategory === 6) return 'gemini-robin-flash-lite';
    return `gemini-robin-mode-${modeCategory}`;
  }
  const candidate = `gemini-${cleaned}`;
  return /^gemini-[\w.:-]+$/.test(candidate) ? candidate : `gemini-robin-mode-${modeCategory}`;
}

/**
 * Maps Gemini model names + thinking preference to RobinService ProcessQuery
 * native ModeCategory (3=Pro/Neon, 1=Fast/Hydrogen, 6=Flash-Lite) and
 * synchronous thinkingLevel (0=off, 1=low, 4=medium, 2=high/default).
 */
export function resolveRobinMode(
  model: string,
  thinking?: boolean,
  reasoningEffort?: string,
  overrideModeCategory?: number,
): RobinModeSelection {
  const lower = model.trim().toLowerCase();
  const effort = reasoningEffort?.trim().toLowerCase();
  const thinkingLevel = thinking === false || effort === 'none' || effort === 'off' || effort === 'minimal'
    ? 0
    : effort === 'low'
      ? 1
      : effort === 'medium'
        ? 4
        : 2;
  if (overrideModeCategory !== undefined && Number.isInteger(overrideModeCategory) && overrideModeCategory >= 0) {
    return { modeCategory: overrideModeCategory, smartModelSelection: false, thinkingLevel };
  }
  if (lower === 'gemini-auto' || lower.endsWith('-auto')) {
    return { smartModelSelection: true, thinkingLevel };
  }
  if (lower.includes('flash-lite')) {
    return { modeCategory: 6, smartModelSelection: false, thinkingLevel };
  }
  if (lower.includes('hydrogen') || lower.includes('robin-fast') || lower.includes('flash')) {
    return { modeCategory: 1, smartModelSelection: false, thinkingLevel };
  }
  // Pro / Neon / Argon (migrated from retired mode 8) / default high-capability route.
  return { modeCategory: 3, smartModelSelection: false, thinkingLevel };
}

function buildRequestMetadata(instanceId: string): Buffer {
  return Buffer.concat([
    lengthDelimited(1, varintField(1, 1)),          // triggerType = 1
    lengthDelimited(2, stringField(1, 'en')),       // interfaceLanguageCode
    lengthDelimited(3, stringField(1, ROBIN_CLIENT_VERSION)), // clientVersion
    varintField(4, 21),                             // clientType = 21 (macOS desktop)
    varintField(5, 1),                              // uiSource = 1
    stringField(7, 'en'),                           // languageCode
    stringField(23, instanceId),                    // clientInstanceId
  ]);
}

export interface BuildProcessQueryOptions {
  userText: string;
  images?: readonly RobinUploadedImage[];
  attachments?: readonly RobinUploadedAttachment[];
  model: string;
  thinking?: boolean;
  reasoningEffort?: string;
  overrideModeCategory?: number;
  temporaryChat?: boolean;
  clientInstanceId?: string;
}

/** Builds the 3-frame length-prefixed gRPC wire payload for RobinService/ProcessQuery. */
export function buildProcessQueryWire(options: BuildProcessQueryOptions): Buffer {
  const {
    userText,
    images = [],
    attachments,
    model,
    thinking,
    reasoningEffort,
    overrideModeCategory,
    temporaryChat = true,
    clientInstanceId = randomUUID(),
  } = options;
  const mode = resolveRobinMode(model, thinking, reasoningEffort, overrideModeCategory);
  const metadata = buildRequestMetadata(clientInstanceId);
  const encodedAttachments = attachments ? encodeRobinAttachments(attachments) : encodeRobinImageAttachments(images);
  const userQuery = Buffer.concat([
    stringField(1, userText),
    ...encodedAttachments,
  ]);

  const clientGenerateFields: Buffer[] = [
    lengthDelimited(1, userQuery), // UserQuery { text, attachments }
    varintField(5, 1),
    lengthDelimited(13, metadata),
    varintField(15, 1), // Disable built-in workspace/extension tools for clean model turns.
  ];
  if (temporaryChat) clientGenerateFields.push(varintField(31, 1));
  clientGenerateFields.push(varintField(55, 0));
  clientGenerateFields.push(varintField(56, mode.smartModelSelection ? 1 : 0));
  if (mode.modeCategory !== undefined) clientGenerateFields.push(varintField(47, mode.modeCategory));
  clientGenerateFields.push(varintField(48, mode.thinkingLevel));

  const template = Buffer.concat(clientGenerateFields);
  const initial = Buffer.concat([
    lengthDelimited(1, metadata),
    lengthDelimited(1001, lengthDelimited(1, template)),
    lengthDelimited(1004, Buffer.alloc(0)),
  ]);

  const frame1 = Buffer.concat([varintField(1, 1), lengthDelimited(1000, initial)]);
  const frame2 = Buffer.concat([varintField(1, 1), lengthDelimited(1007, lengthDelimited(1, Buffer.from(userText, 'utf8')))]);
  const frame3 = Buffer.concat([varintField(1, 1), lengthDelimited(1007, lengthDelimited(2, Buffer.alloc(0)))]);

  return Buffer.concat([frame1, frame2, frame3].map(frameGrpcMessage));
}

export interface DecodedProcessQueryFrame {
  text?: string;
  thought?: string;
  responseId?: string;
  conversationId?: string;
  modelVersion?: string;
  fallback?: number;
  downgradeReason?: number;
  modeVariantId?: string;
  routingVariantId?: string;
  resolvedModeCategory?: number;
  resolvedThinkingLevel?: number;
  completed: boolean;
}

export function decodeProcessQueryFrame(bytes: Buffer): DecodedProcessQueryFrame | null {
  const outer = parseProtobuf(bytes);
  const wrapper = singularField(outer, 1003, 2);
  if (!wrapper) return null;
  const inner = singularField(parseProtobuf(wrapper.payload), 1, 2);
  if (!inner) return null;
  const fields = parseProtobuf(inner.payload);

  let responseId: string | undefined;
  let text: string | undefined;
  let thought: string | undefined;
  const model = singularField(fields, 1, 2);
  if (model) {
    const modelFields = parseProtobuf(model.payload);
    responseId = decodeStringField(modelFields, 1);
    const display = singularField(modelFields, 2, 2);
    if (display) text = decodeStringField(parseProtobuf(display.payload), 1);
    const thoughts = singularField(modelFields, 12, 2);
    if (thoughts) thought = decodeStringField(parseProtobuf(thoughts.payload), 1);
  }

  let conversationId: string | undefined;
  const ids = singularField(fields, 2, 2);
  if (ids) {
    conversationId = decodeStringField(parseProtobuf(ids.payload), 1);
  }

  const completed = decodeVarintScalar(singularField(fields, 9, 0)) === 1;
  const fallback = decodeVarintScalar(singularField(fields, 11, 0));
  const modelVersion = decodeStringField(fields, 30);
  const downgradeReason = decodeVarintScalar(singularField(fields, 31, 0));
  const modeVariantId = decodeStringField(fields, 39);
  const routingVariantId = decodeStringField(fields, 40);
  const resolvedModeCategory = decodeVarintScalar(singularField(fields, 41, 0));
  const resolvedThinkingLevel = decodeVarintScalar(singularField(fields, 42, 0));

  return {
    ...(text !== undefined ? { text } : {}),
    ...(thought !== undefined ? { thought } : {}),
    ...(responseId ? { responseId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(modelVersion ? { modelVersion } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    ...(downgradeReason !== undefined ? { downgradeReason } : {}),
    ...(modeVariantId ? { modeVariantId } : {}),
    ...(routingVariantId ? { routingVariantId } : {}),
    ...(resolvedModeCategory !== undefined ? { resolvedModeCategory } : {}),
    ...(resolvedThinkingLevel !== undefined ? { resolvedThinkingLevel } : {}),
    completed,
  };
}

const GRPC_TIER_NAMES: Record<number, { plan: string; userTier: string }> = {
  1: { plan: 'Free', userTier: 'TIER_BASIC' },
  2: { plan: 'Pro', userTier: 'TIER1' },
  3: { plan: 'Ultra', userTier: 'TIER2' },
  4: { plan: 'Plus', userTier: 'TIER_LITE' },
  5: { plan: 'Ultra', userTier: 'TIER_NEON' },
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function classifyWindowId(label: string, groupType: number | undefined, index: number): { id: string; poolType: string } {
  const lower = label.toLowerCase();
  if (
    lower.includes('5-hour') || lower.includes('5 hour') || lower.includes('five hour')
    || lower.includes('5 小时') || lower.includes('5小时')
    || lower.includes('current usage') || lower.includes('当前用量')
  ) {
    return { id: 'fiveHour', poolType: 'GXU_FIVE_HOURLY' };
  }
  if (lower.includes('week') || lower.includes('每周') || lower.includes('7 day') || lower.includes('7-day')) {
    return { id: 'weekly', poolType: 'GXU_WEEKLY' };
  }
  if (groupType === 1) {
    return { id: 'fiveHour', poolType: 'GXU_FIVE_HOURLY' };
  }
  if (groupType === 2) {
    return { id: 'weekly', poolType: 'GXU_WEEKLY' };
  }
  return {
    id: `window_${groupType ?? 0}_${index}`,
    poolType: groupType !== undefined ? `GROUP_${groupType}` : 'GXU',
  };
}

export function decodeGrpcUsageInfo(bytes: Buffer, endpoint?: string, fetchedAt = new Date().toISOString()): QuotaSnapshot {
  const root = parseProtobuf(bytes);
  const tierCode = decodeVarintScalar(singularField(root, 2, 0));
  const mappedTier = tierCode !== undefined ? GRPC_TIER_NAMES[tierCode] : undefined;
  const userTier = mappedTier?.userTier;
  const plan = mappedTier?.plan;

  const windows: QuotaWindow[] = [];
  const groups = root.filter(f => f.number === 3 && f.wire === 2).slice(0, 16);
  let idx = 0;
  for (const group of groups) {
    const gf = parseProtobuf(group.payload);
    const groupType = decodeVarintScalar(singularField(gf, 1, 0));
    const rows = gf.filter(f => f.number === 2 && f.wire === 2).slice(0, 32);
    for (const row of rows) {
      const rf = parseProtobuf(row.payload);
      const timeField = singularField(rf, 1, 2);
      const pctField = singularField(rf, 2, 5);
      const title = decodeStringField(rf, 3)?.trim();
      const rawFraction = pctField && pctField.payload.length === 4 ? pctField.payload.readFloatLE(0) : undefined;
      if (rawFraction === undefined && !title) continue;
      const fraction = rawFraction !== undefined && Number.isFinite(rawFraction)
        ? Math.min(Math.max(rawFraction, 0), 1)
        : 0;
      const usedPercent = round1(fraction * 100);
      const remainingPercent = round1((1 - fraction) * 100);
      const resetsAt = timeField ? decodeTimestamp(timeField.payload) : undefined;
      const { id, poolType } = classifyWindowId(title ?? '', groupType, idx++);
      windows.push({
        id,
        poolType,
        ...(title ? { title } : {}),
        usedPercent,
        remainingPercent,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }

  const order = new Map([['fiveHour', 0], ['weekly', 1]]);
  windows.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));

  return {
    supported: true,
    ...(plan ? { plan } : {}),
    ...(userTier ? { userTier } : {}),
    windows,
    fetchedAt,
    ...(endpoint ? { endpoint } : {}),
  };
}

function decodeGrpcMessageHeader(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep raw text when percent-encoding is malformed.
  }
  return sanitizeUpstreamText(decoded, 260);
}

export function grpcStatusToHttp(grpcStatus: number): number {
  switch (grpcStatus) {
    case 16: return 401; // UNAUTHENTICATED
    case 7: return 403;  // PERMISSION_DENIED
    case 8: return 429;  // RESOURCE_EXHAUSTED
    case 3:              // INVALID_ARGUMENT
    case 9:              // FAILED_PRECONDITION
      return 400;
    case 4: return 504;  // DEADLINE_EXCEEDED
    case 14: return 503; // UNAVAILABLE
    default: return 502;
  }
}

function formatGrpcErrorDetail(grpcStatus: number, grpcMessage: string, operation: string): string {
  const base = grpcMessage || `gRPC status ${grpcStatus}`;
  if (grpcStatus === 7) {
    return `${base}（当前 OAuth 令牌缺少 Robin 所需权限 Scope，请在「浏览器 OAuth 认证」面板重新登录授权）`;
  }
  if (grpcStatus === 16 && operation === 'quota') {
    return `${base}（OAuth 凭证已失效，请重新登录）`;
  }
  if (/accept our terms of service/i.test(base)) {
    return `${base}（请在「浏览器 OAuth 认证」面板点击「同意 Gemini 服务条款」完成一次确认后再调用）`;
  }
  return base;
}

function closeSessionGracefully(session: http2.ClientHttp2Session | undefined): void {
  if (!session || session.destroyed) return;
  const forceTimer = setTimeout(() => {
    try { session.destroy(); } catch { /* ignore */ }
  }, 250);
  forceTimer.unref();
  session.once('close', () => clearTimeout(forceTimer));
  try {
    session.close();
  } catch {
    clearTimeout(forceTimer);
    try { session.destroy(); } catch { /* ignore */ }
  }
}

function copySafeGrpcHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower.startsWith(':') || ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-type', 'accept', 'te'].includes(lower)) {
      continue;
    }
    out[lower] = value;
  }
  return out;
}

export interface RobinGrpcStreamSummary {
  sawCompleted: boolean;
  sawGrpcStatusOk: boolean;
  endedByIdleTimeout: boolean;
}

export interface StreamRobinGrpcOptions {
  baseUrl: string;
  path?: string;
  headers: Headers;
  userText: string;
  images?: readonly RobinUploadedImage[];
  attachments?: readonly RobinUploadedAttachment[];
  model: string;
  thinking?: boolean;
  reasoningEffort?: string;
  overrideModeCategory?: number;
  temporaryChat?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Max time to wait for trailing frames / HTTP/2 END_STREAM after receiving `completed: true`. */
  completedGraceMs?: number;
  /** Max idle time after visible text starts arriving when `completed` has not yet arrived. */
  textIdleTimeoutMs?: number;
  /** Shorter idle time once a closed `</tool_call>` block has arrived and no open `<tool_call>` tag remains. */
  toolIdleTimeoutMs?: number;
  /** Shortest idle time once a terminal `end_turn` tool call has closed at the tail of visible text. */
  endTurnIdleTimeoutMs?: number;
  connectHttp2?: Http2Connector;
  onStatus?: (httpStatus: number | null, requestId: string | null) => void;
  onStreamSummary?: (summary: RobinGrpcStreamSummary) => void;
}

function detectClosedToolIdleKind(text: string): 'end_turn' | 'tool' | 'none' {
  const lastClose = text.lastIndexOf('</tool_call>');
  if (lastClose < 0) return 'none';
  const lastOpen = text.lastIndexOf('<tool_call>');
  if (lastOpen < 0 || lastOpen > lastClose) return 'none';
  const trailing = text.slice(lastClose + '</tool_call>'.length);
  if (!trailing.trim()) {
    const inner = text.slice(lastOpen + '<tool_call>'.length, lastClose).trim();
    try {
      const parsed = JSON.parse(inner) as { name?: unknown };
      if (parsed && typeof parsed === 'object' && parsed.name === 'end_turn') {
        return 'end_turn';
      }
    } catch {
      // Fall through to generic closed tool_call delay.
    }
  }
  return 'tool';
}

export async function* streamRobinGrpc(options: StreamRobinGrpcOptions): AsyncGenerator<DecodedProcessQueryFrame> {
  const origin = new URL(options.baseUrl).origin;
  const path = normalizeGrpcPath(options.path ?? ROBIN_GRPC_PROCESS_QUERY);
  const timeoutMs = options.timeoutMs ?? 180_000;
  const completedGraceMs = options.completedGraceMs ?? 500;
  const textIdleTimeoutMs = options.textIdleTimeoutMs ?? 12_000;
  const toolIdleTimeoutMs = options.toolIdleTimeoutMs ?? 2_500;
  const endTurnIdleTimeoutMs = options.endTurnIdleTimeoutMs ?? 1_200;
  const wire = buildProcessQueryWire({
    userText: options.userText,
    images: options.images,
    attachments: options.attachments,
    model: options.model,
    thinking: options.thinking,
    reasoningEffort: options.reasoningEffort,
    overrideModeCategory: options.overrideModeCategory,
    temporaryChat: options.temporaryChat,
  });

  options.signal?.throwIfAborted();
  const connector = options.connectHttp2 ?? connectHttp2;
  const session = await connector(origin, { signal: options.signal });

  const reader = new GrpcMessageReader(MAX_FRAME_BYTES);
  const queue: DecodedProcessQueryFrame[] = [];
  let waiting: { resolve: (value: IteratorResult<DecodedProcessQueryFrame>) => void; reject: (err: unknown) => void } | null = null;
  let ended = false;
  let closed = false;
  let failure: unknown = null;
  let httpStatus: number | null = null;
  let grpcStatus: number | null = null;
  let grpcMessage = '';
  let requestId: string | null = null;
  let receivedBytes = 0;
  let sawCompleted = false;
  let sawVisibleText = false;
  let latestText = '';
  let latestThoughtLen = 0;
  let endedByIdleTimeout = false;
  let summaryReported = false;

  let req: http2.ClientHttp2Stream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completedTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const reportSummary = () => {
    if (summaryReported) return;
    summaryReported = true;
    options.onStreamSummary?.({
      sawCompleted,
      sawGrpcStatusOk: grpcStatus === 0,
      endedByIdleTimeout,
    });
  };

  const stop = (normal: boolean) => {
    clearTimeout(timer);
    clearTimeout(completedTimer);
    clearTimeout(idleTimer);
    completedTimer = undefined;
    idleTimer = undefined;
    options.signal?.removeEventListener('abort', onAbort);
    try {
      req?.close(normal ? http2.constants.NGHTTP2_NO_ERROR : http2.constants.NGHTTP2_CANCEL);
    } catch { /* ignore */ }
    closeSessionGracefully(session);
  };

  const pushFrame = (frame: DecodedProcessQueryFrame) => {
    if (closed) return;
    if (waiting) {
      const { resolve } = waiting;
      waiting = null;
      resolve({ value: frame, done: false });
    } else {
      queue.push(frame);
    }
  };

  const fail = (err: unknown) => {
    if (closed) return;
    closed = true;
    failure = err;
    if (waiting) {
      const { reject } = waiting;
      waiting = null;
      reject(err);
    }
    stop(false);
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    ended = true;
    reportSummary();
    if (waiting) {
      const { resolve } = waiting;
      waiting = null;
      resolve({ value: undefined, done: true });
    }
    stop(true);
  };

  const armIdleTimer = () => {
    if (closed || sawCompleted || !sawVisibleText) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
    const toolKind = detectClosedToolIdleKind(latestText);
    const delay = toolKind === 'end_turn'
      ? endTurnIdleTimeoutMs
      : toolKind === 'tool'
        ? toolIdleTimeoutMs
        : textIdleTimeoutMs;
    if (delay <= 0) return;
    idleTimer = setTimeout(() => {
      if (closed) return;
      if (grpcStatus !== null && grpcStatus !== 0) {
        const mapped = grpcStatusToHttp(grpcStatus);
        const detail = formatGrpcErrorDetail(grpcStatus, grpcMessage, 'generation');
        fail(new GatewayError(mapped, 'generation', { detail, body: detail }));
        return;
      }
      endedByIdleTimeout = true;
      finish();
    }, delay);
    idleTimer.unref();
  };

  const onAbort = () => {
    fail(options.signal?.reason ?? new Error('Aborted'));
  };

  const inspectHeaders = (hdrs: http2.IncomingHttpHeaders) => {
    if (hdrs[':status'] !== undefined) {
      httpStatus = Number(hdrs[':status']);
      const rid = hdrs['x-request-id'];
      requestId = typeof rid === 'string' ? rid : Array.isArray(rid) ? rid[0] ?? null : null;
      options.onStatus?.(httpStatus, requestId);
    }
    if (hdrs['grpc-message'] !== undefined) {
      grpcMessage = decodeGrpcMessageHeader(hdrs['grpc-message']);
    }
    if (hdrs['grpc-status'] !== undefined) {
      const parsed = Number(hdrs['grpc-status']);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 16) grpcStatus = parsed;
    }
    if (grpcStatus !== null && grpcStatus !== 0) {
      const mapped = grpcStatusToHttp(grpcStatus);
      const detail = formatGrpcErrorDetail(grpcStatus, grpcMessage, 'generation');
      fail(new GatewayError(mapped, 'generation', { detail, body: detail }));
      return;
    }
    if (httpStatus !== null && httpStatus !== 200) {
      const detail = grpcMessage || `gRPC HTTP ${httpStatus}`;
      fail(new GatewayError(httpStatus, 'generation', { detail, body: detail }));
    }
  };

  session.on('error', err => {
    fail(new GatewayError(502, 'generation', { detail: `HTTP/2 connection failed: ${sanitizeUpstreamText(err.message, 160)}`, cause: err }));
  });

  const extraHeaders = copySafeGrpcHeaders(options.headers);
  req = session.request({
    ...extraHeaders,
    ':method': 'POST',
    ':path': path,
    'content-type': 'application/grpc',
    te: 'trailers',
    'grpc-timeout': `${timeoutMs}m`,
    'user-agent': extraHeaders['user-agent'] || `Gemini/${ROBIN_CLIENT_VERSION}`,
  });

  timer = setTimeout(() => {
    fail(new GatewayError(504, 'generation', { detail: 'Robin gRPC stream timed out' }));
  }, timeoutMs);
  timer.unref();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  req.on('response', inspectHeaders);
  req.on('trailers', inspectHeaders);
  req.on('data', (chunk: Buffer) => {
    if (closed) return;
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_WIRE_BYTES) {
      fail(new GatewayError(502, 'generation', { detail: 'Robin gRPC response exceeded size budget' }));
      return;
    }
    try {
      let madeProgress = false;
      for (const message of reader.push(chunk)) {
        const decoded = decodeProcessQueryFrame(message);
        if (decoded) {
          pushFrame(decoded);
          if (typeof decoded.thought === 'string' && decoded.thought.length > latestThoughtLen) {
            latestThoughtLen = decoded.thought.length;
            madeProgress = true;
          }
          if (typeof decoded.text === 'string' && decoded.text.length > 0) {
            sawVisibleText = true;
            if (decoded.text.length > latestText.length) {
              latestText = decoded.text;
              madeProgress = true;
            }
          }
          if (decoded.completed) {
            sawCompleted = true;
            clearTimeout(idleTimer);
            idleTimer = undefined;
            if (!completedTimer && completedGraceMs >= 0) {
              completedTimer = setTimeout(() => {
                if (closed) return;
                if (grpcStatus !== null && grpcStatus !== 0) {
                  const mapped = grpcStatusToHttp(grpcStatus);
                  const detail = formatGrpcErrorDetail(grpcStatus, grpcMessage, 'generation');
                  fail(new GatewayError(mapped, 'generation', { detail, body: detail }));
                  return;
                }
                finish();
              }, completedGraceMs);
              completedTimer.unref();
            }
          }
        }
      }
      // Only reset the idle countdown when text/thought actually grows (never let empty/heartbeat frames extend it).
      if (sawVisibleText && !sawCompleted && (madeProgress || !idleTimer)) {
        armIdleTimer();
      }
    } catch (err) {
      fail(new GatewayError(502, 'generation', { detail: err instanceof Error ? err.message : 'Invalid gRPC frame', cause: err }));
    }
  });
  req.on('error', err => {
    fail(new GatewayError(502, 'generation', { detail: `Robin gRPC stream error: ${sanitizeUpstreamText(err.message, 160)}`, cause: err }));
  });
  req.on('end', () => {
    if (closed) return;
    try {
      reader.finish();
    } catch (err) {
      fail(new GatewayError(502, 'generation', { detail: err instanceof Error ? err.message : 'Truncated gRPC stream', cause: err }));
      return;
    }
    if (grpcStatus !== null && grpcStatus !== 0) {
      const mapped = grpcStatusToHttp(grpcStatus);
      const detail = formatGrpcErrorDetail(grpcStatus, grpcMessage, 'generation');
      fail(new GatewayError(mapped, 'generation', { detail, body: detail }));
      return;
    }
    if (httpStatus !== null && httpStatus !== 200) {
      fail(new GatewayError(httpStatus, 'generation', { detail: grpcMessage || `gRPC HTTP ${httpStatus}` }));
      return;
    }
    finish();
  });
  req.on('close', () => {
    if (!closed && !ended) {
      const rst = req?.rstCode ?? 0;
      fail(new GatewayError(502, 'generation', { detail: rst > 0 ? `Robin gRPC stream reset (RST_STREAM ${rst})` : 'Robin gRPC stream closed early' }));
    }
  });

  req.end(wire);

  try {
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (failure) throw failure;
      if (ended || closed) return;
      const next = await new Promise<IteratorResult<DecodedProcessQueryFrame>>((resolve, reject) => {
        waiting = { resolve, reject };
      });
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if (!closed) {
      closed = true;
      stop(ended);
    }
  }
}

export interface QueryRobinGrpcUsageOptions {
  baseUrl: string;
  path?: string;
  headers: Headers;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectHttp2?: Http2Connector;
}

interface UnaryRobinGrpcOptions {
  baseUrl: string;
  path: string;
  headers: Headers;
  payload: Buffer;
  operation: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectHttp2?: Http2Connector;
}

async function unaryRobinGrpc(options: UnaryRobinGrpcOptions): Promise<{ payload: Buffer; fullUrl: string }> {
  const origin = new URL(options.baseUrl).origin;
  const path = normalizeGrpcPath(options.path);
  const fullUrl = new URL(path, origin).href;
  const timeoutMs = options.timeoutMs ?? 15_000;

  options.signal?.throwIfAborted();
  const connector = options.connectHttp2 ?? connectHttp2;
  const session = await connector(origin, { signal: options.signal });

  return new Promise<{ payload: Buffer; fullUrl: string }>((resolve, reject) => {
    let settled = false;
    let httpStatus: number | null = null;
    let grpcStatus: number | null = null;
    let grpcMessage = '';
    let receivedBytes = 0;
    const payloads: Buffer[] = [];
    const reader = new GrpcMessageReader(512 * 1024);
    let req: http2.ClientHttp2Stream | undefined;

    const finish = (err: unknown, payload?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        req?.close(err ? http2.constants.NGHTTP2_CANCEL : http2.constants.NGHTTP2_NO_ERROR);
      } catch { /* ignore */ }
      closeSessionGracefully(session);
      if (err) reject(err);
      else resolve({ payload: payload!, fullUrl });
    };

    const onAbort = () => finish(options.signal?.reason ?? new Error('Aborted'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      finish(new GatewayError(504, options.operation, { detail: `Robin ${options.operation} gRPC request timed out` }));
    }, timeoutMs);
    timer.unref();

    const inspectHeaders = (hdrs: http2.IncomingHttpHeaders) => {
      if (hdrs[':status'] !== undefined) httpStatus = Number(hdrs[':status']);
      if (hdrs['grpc-message'] !== undefined) grpcMessage = decodeGrpcMessageHeader(hdrs['grpc-message']);
      if (hdrs['grpc-status'] !== undefined) {
        const parsed = Number(hdrs['grpc-status']);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 16) grpcStatus = parsed;
      }
      if (grpcStatus !== null && grpcStatus !== 0) {
        const mapped = grpcStatusToHttp(grpcStatus);
        const detail = formatGrpcErrorDetail(grpcStatus, grpcMessage, options.operation);
        finish(new GatewayError(mapped, options.operation, { detail, body: detail }));
        return;
      }
      if (httpStatus !== null && httpStatus !== 200) {
        finish(new GatewayError(httpStatus, options.operation, { detail: grpcMessage || `Endpoint returned HTTP ${httpStatus}` }));
      }
    };

    session.on('error', err => {
      finish(new GatewayError(502, options.operation, { detail: `HTTP/2 connection failed: ${sanitizeUpstreamText(err.message, 160)}`, cause: err }));
    });

    const extraHeaders = copySafeGrpcHeaders(options.headers);
    req = session.request({
      ...extraHeaders,
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-timeout': `${timeoutMs}m`,
      'user-agent': extraHeaders['user-agent'] || `Gemini/${ROBIN_CLIENT_VERSION}`,
    });

    req.on('response', inspectHeaders);
    req.on('trailers', inspectHeaders);
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > 1024 * 1024) {
        finish(new GatewayError(502, options.operation, { detail: `Robin ${options.operation} gRPC response exceeded size limit` }));
        return;
      }
      try {
        payloads.push(...reader.push(chunk));
      } catch (err) {
        finish(new GatewayError(502, options.operation, { detail: err instanceof Error ? err.message : 'Invalid gRPC frame', cause: err }));
      }
    });
    req.on('error', err => {
      finish(new GatewayError(502, options.operation, { detail: `Robin ${options.operation} gRPC stream error: ${sanitizeUpstreamText(err.message, 160)}`, cause: err }));
    });
    req.on('end', () => {
      if (settled) return;
      try {
        reader.finish();
      } catch (err) {
        finish(new GatewayError(502, options.operation, { detail: err instanceof Error ? err.message : 'Truncated gRPC stream', cause: err }));
        return;
      }
      if (grpcStatus !== null && grpcStatus !== 0) {
        const mapped = grpcStatusToHttp(grpcStatus);
        const detail = formatGrpcErrorDetail(grpcStatus, grpcMessage, options.operation);
        finish(new GatewayError(mapped, options.operation, { detail, body: detail }));
        return;
      }
      if (httpStatus !== 200 || payloads.length === 0) {
        finish(new GatewayError(httpStatus && httpStatus !== 200 ? httpStatus : 502, options.operation, {
          detail: grpcMessage || `Robin ${options.operation} gRPC response was incomplete`,
        }));
        return;
      }
      finish(null, payloads[0]);
    });
    req.on('close', () => {
      if (!settled) {
        finish(new GatewayError(502, options.operation, { detail: `Robin ${options.operation} gRPC stream closed early` }));
      }
    });

    req.end(frameGrpcMessage(options.payload));
  });
}

export async function queryRobinGrpcUsageInfo(options: QueryRobinGrpcUsageOptions): Promise<QuotaSnapshot> {
  const { payload, fullUrl } = await unaryRobinGrpc({
    baseUrl: options.baseUrl,
    path: options.path ?? ROBIN_GRPC_GET_USAGE_INFO,
    headers: options.headers,
    payload: Buffer.alloc(0),
    operation: 'quota',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    connectHttp2: options.connectHttp2,
  });
  try {
    return decodeGrpcUsageInfo(payload, fullUrl, new Date().toISOString());
  } catch (err) {
    throw new GatewayError(502, 'quota', { detail: err instanceof Error ? err.message : 'Failed to decode quota protobuf', cause: err });
  }
}

export function decodeRobinUserStatus(bytes: Buffer, fetchedAt = new Date().toISOString()): RobinUserStatus {
  const root = parseProtobuf(bytes);
  const modes: RobinModeOption[] = [];
  const seenModeKeys = new Set<string>();
  const thinkingOptions: RobinThinkingOption[] = [];
  const seenThinking = new Set<number>();

  const pushMode = (entry: Omit<RobinModeOption, 'modelId'>) => {
    const modelId = slugifyRobinModelId(entry.modelName, entry.title, entry.modeCategory);
    const key = `${entry.modeCategory}:${modelId}`;
    if (seenModeKeys.has(key)) return;
    seenModeKeys.add(key);
    modes.push({ ...entry, modelId });
  };

  for (const field17 of root.filter(f => f.number === 17 && f.wire === 2).slice(0, 32)) {
    try {
      const f = parseProtobuf(field17.payload);
      const modeCategory = decodeVarintScalar(singularField(f, 23, 0));
      if (modeCategory === undefined) continue;
      const modeVariantId = decodeStringField(f, 1);
      const title = (decodeStringField(f, 2) ?? decodeStringField(f, 18) ?? '').trim();
      const modelName = (decodeStringField(f, 3) ?? decodeStringField(f, 20) ?? decodeStringField(f, 26) ?? title).trim();
      const description = decodeStringField(f, 19)?.trim();
      pushMode({
        ...(modeVariantId ? { modeVariantId } : {}),
        title: title || modelName || `Mode ${modeCategory}`,
        modelName: modelName || title || `Mode ${modeCategory}`,
        ...(description ? { description } : {}),
        modeCategory,
      });
    } catch {
      // Ignore malformed mode entries rather than discarding valid ones.
    }
  }

  let policy: string | undefined;
  const field34 = singularField(root, 34, 2);
  if (field34) {
    try {
      const pf = parseProtobuf(field34.payload);
      policy = decodeStringField(pf, 1)?.trim();
      for (const item of pf.filter(f => f.number === 2 && f.wire === 2).slice(0, 32)) {
        try {
          const entryFields = parseProtobuf(item.payload);
          const header = singularField(entryFields, 1, 2);
          if (header) {
            const hf = parseProtobuf(header.payload);
            const modeCategory = decodeVarintScalar(singularField(hf, 3, 0));
            const title = decodeStringField(hf, 6)?.trim() ?? '';
            const modelName = decodeStringField(hf, 7)?.trim() ?? title;
            const description = decodeStringField(hf, 14)?.trim();
            if (modeCategory !== undefined && (title || modelName)) {
              pushMode({
                title: title || modelName,
                modelName: modelName || title,
                ...(description ? { description } : {}),
                modeCategory,
              });
            }
          }
          for (const opt of entryFields.filter(f => f.number === 2 && f.wire === 2).slice(0, 16)) {
            const of = parseProtobuf(opt.payload);
            const label = decodeStringField(of, 2)?.trim();
            const description = decodeStringField(of, 3)?.trim();
            const level = decodeVarintScalar(singularField(of, 4, 0));
            if (label && level !== undefined && !seenThinking.has(level)) {
              seenThinking.add(level);
              thinkingOptions.push({ label, ...(description ? { description } : {}), thinkingLevel: level });
            }
          }
        } catch {
          // Ignore malformed policy rows.
        }
      }
    } catch {
      // Ignore malformed policy section.
    }
  }

  return {
    ...(policy ? { policy } : {}),
    modes,
    thinkingOptions,
    fetchedAt,
  };
}

export async function queryRobinUserStatus(options: QueryRobinGrpcUsageOptions): Promise<RobinUserStatus> {
  const { payload } = await unaryRobinGrpc({
    baseUrl: options.baseUrl,
    path: options.path ?? ROBIN_GRPC_GET_USER_STATUS,
    headers: options.headers,
    payload: Buffer.alloc(0),
    operation: 'user status',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    connectHttp2: options.connectHttp2,
  });
  try {
    return decodeRobinUserStatus(payload, new Date().toISOString());
  } catch (err) {
    throw new GatewayError(502, 'user status', { detail: err instanceof Error ? err.message : 'Failed to decode user status protobuf', cause: err });
  }
}

export interface RobinTermsOptions {
  baseUrl: string;
  headers: Headers;
  language?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectHttp2?: Http2Connector;
}

export interface RobinTermsResult {
  accepted: boolean;
  version: number;
  acceptedAt: string;
}

function buildTermsMetadata(language: string): Buffer {
  return Buffer.concat([
    lengthDelimited(2, stringField(1, language)), // interfaceLanguageCode
    varintField(4, 21),                           // clientType = 21 (macOS desktop)
    varintField(5, 1),                            // uiSource = 1
    stringField(7, language),                     // languageCode
  ]);
}

/**
 * User-initiated confirmation of Google Gemini's native desktop Terms of Service.
 * Must only be invoked after explicit user action.
 */
export async function acceptRobinTermsOfService(options: RobinTermsOptions): Promise<RobinTermsResult> {
  const language = options.language && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(options.language)
    ? options.language
    : 'en';
  const meta = buildTermsMetadata(language);

  const versionResp = await unaryRobinGrpc({
    baseUrl: options.baseUrl,
    path: ROBIN_GRPC_GET_TERMS_VERSION,
    headers: options.headers,
    payload: Buffer.concat([stringField(1, language), lengthDelimited(2, meta)]),
    operation: 'terms version',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    connectHttp2: options.connectHttp2,
  });

  const versionFields = parseProtobuf(versionResp.payload);
  const version = decodeVarintScalar(singularField(versionFields, 1, 0));
  const legacyVersion = decodeVarintScalar(singularField(versionFields, 2, 0));
  const versionNo = legacyVersion ?? version;
  if (!versionNo || versionNo <= 0 || versionNo > 0x7fffffff) {
    throw new GatewayError(502, 'terms version', { detail: 'Google did not return a valid Terms of Service version' });
  }

  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  const timestamp = Buffer.concat([
    varintField(1, seconds),
    ...(nanos ? [varintField(2, nanos)] : []),
  ]);

  const acceptBody = Buffer.concat([
    stringField(4, `Gemini/${ROBIN_CLIENT_VERSION}`),
    varintField(5, 21),
    varintField(6, versionNo),
    lengthDelimited(7, meta),
    lengthDelimited(10, timestamp),
  ]);

  await unaryRobinGrpc({
    baseUrl: options.baseUrl,
    path: ROBIN_GRPC_ACCEPT_TERMS,
    headers: options.headers,
    payload: acceptBody,
    operation: 'terms accept',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    connectHttp2: options.connectHttp2,
  });

  return {
    accepted: true,
    version: versionNo,
    acceptedAt: new Date(now).toISOString(),
  };
}

export interface UploadRobinImagesOptions {
  images: readonly { data: Buffer; mimeType?: string }[];
  headers: Headers;
  origin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectHttp2?: Http2Connector;
}

function validateUploadLocation(raw: string | string[] | undefined, expectedOrigin: URL): URL {
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192 || /[\x00-\x20\x7f\\]/.test(value)) {
    throw new GatewayError(502, 'attachment upload', { detail: 'Robin upload endpoint returned an invalid upload URL' });
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GatewayError(502, 'attachment upload', { detail: 'Robin upload endpoint returned a malformed upload URL' });
  }
  if (
    parsed.protocol !== expectedOrigin.protocol
    || parsed.hostname !== expectedOrigin.hostname
    || parsed.port !== expectedOrigin.port
    || parsed.username
    || parsed.password
    || parsed.hash
    || !parsed.pathname.startsWith('/upload/')
  ) {
    throw new GatewayError(502, 'attachment upload', { detail: 'Robin upload URL pointed outside the expected upload origin' });
  }
  return parsed;
}

function sendHttp2UploadRequest(
  session: http2.ClientHttp2Session,
  headers: http2.OutgoingHttpHeaders,
  body: Buffer | null,
  maxBody: number,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<{ headers: http2.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ended = false;
    let responseHeaders: http2.IncomingHttpHeaders | undefined;
    let received = 0;
    const chunks: Buffer[] = [];
    let req: http2.ClientHttp2Stream | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (err: unknown, result?: { headers: http2.IncomingHttpHeaders; body: Buffer }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        try { req?.close(http2.constants.NGHTTP2_CANCEL); } catch { /* ignore */ }
        reject(err);
      } else {
        resolve(result!);
      }
    };
    const onAbort = () => finish(signal?.reason ?? new Error('Aborted'));
    const remaining = Math.max(1, deadlineMs - Date.now());
    const timer = setTimeout(() => {
      finish(new GatewayError(504, 'attachment upload', { detail: 'Robin attachment upload timed out' }));
    }, remaining);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal?.aborted) { onAbort(); return; }
    if (session.destroyed || session.closed) {
      finish(new GatewayError(502, 'attachment upload', { detail: 'Robin attachment upload HTTP/2 session closed' }));
      return;
    }

    try {
      req = session.request(headers);
    } catch (err) {
      finish(new GatewayError(502, 'attachment upload', {
        detail: `Robin attachment upload request failed: ${sanitizeUpstreamText(err instanceof Error ? err.message : String(err), 160)}`,
        cause: err,
      }));
      return;
    }

    req.on('response', hdrs => {
      responseHeaders = hdrs;
      let headerBytes = 0;
      for (const [k, v] of Object.entries(hdrs)) {
        headerBytes += Buffer.byteLength(k) + Buffer.byteLength(Array.isArray(v) ? v.join('') : String(v ?? ''));
        if (headerBytes > 8192) {
          finish(new GatewayError(502, 'attachment upload', { detail: 'Robin attachment upload response headers exceeded limit' }));
          return;
        }
      }
    });
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBody) {
        finish(new GatewayError(502, 'attachment upload', { detail: 'Robin attachment upload response body exceeded limit' }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('error', err => {
      finish(new GatewayError(502, 'attachment upload', {
        detail: `Robin attachment upload stream error: ${sanitizeUpstreamText(err.message, 160)}`,
        cause: err,
      }));
    });
    req.on('aborted', () => {
      finish(new GatewayError(502, 'attachment upload', { detail: 'Robin attachment upload stream aborted' }));
    });
    req.on('end', () => { ended = true; });
    req.on('close', () => {
      if (settled) return;
      if (!ended || req?.rstCode || !responseHeaders) {
        finish(new GatewayError(502, 'attachment upload', { detail: 'Robin attachment upload stream ended unexpectedly' }));
        return;
      }
      const status = Number(responseHeaders[':status']);
      if (status !== 200) {
        const mapped = status === 401 ? 401 : status === 403 ? 403 : status === 429 ? 429 : 502;
        const bodyText = sanitizeUpstreamText(Buffer.concat(chunks).toString('utf8'), 200);
        finish(new GatewayError(mapped, 'attachment upload', {
          detail: bodyText || `Robin attachment upload returned HTTP ${status}`,
          body: bodyText,
        }));
        return;
      }
      finish(null, { headers: responseHeaders, body: Buffer.concat(chunks) });
    });

    if (body) req.end(body);
    else req.end();
  });
}

export interface UploadRobinAttachmentsOptions {
  attachments: readonly { data: Buffer; mimeType?: string; name?: string }[];
  headers: Headers;
  origin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectHttp2?: Http2Connector;
}

/**
 * Uploads multimodal attachments (images, audio, video, PDF/text) to Google's default Robin
 * Scotty resumable upload endpoint (`https://push.clients6.google.com/upload/`) using the
 * account's existing OAuth token.
 */
export async function uploadRobinAttachments(options: UploadRobinAttachmentsOptions): Promise<RobinUploadedAttachment[]> {
  if (!options.attachments.length) return [];
  if (options.attachments.length > ROBIN_MAX_ATTACHMENTS_PER_REQUEST) {
    throw new GatewayError(400, 'attachment upload', {
      detail: `Robin supports at most ${ROBIN_MAX_ATTACHMENTS_PER_REQUEST} attachments per request`,
    });
  }

  const normalized: { data: Buffer; mimeType: string; name?: string }[] = [];
  let totalBytes = 0;
  for (const item of options.attachments) {
    if (!Buffer.isBuffer(item.data) || !item.data.length) {
      throw new GatewayError(400, 'attachment upload', { detail: 'Robin attachment upload requires non-empty bytes' });
    }
    const detected = resolveRobinAttachmentMime(item.data, item.mimeType);
    if (!detected) {
      throw new GatewayError(400, 'attachment upload', {
        detail: `Robin native upload does not support attachment type ${item.mimeType ?? 'unknown'}`,
      });
    }
    totalBytes += item.data.length;
    if (totalBytes > ROBIN_MAX_ATTACHMENT_BYTES) {
      throw new GatewayError(400, 'attachment upload', {
        detail: `Robin attachments exceed the ${Math.round(ROBIN_MAX_ATTACHMENT_BYTES / (1024 * 1024))} MiB request limit`,
      });
    }
    normalized.push({ data: item.data, mimeType: detected, ...(item.name ? { name: item.name } : {}) });
  }

  const authorization = options.headers.get('authorization')?.trim();
  if (!authorization || /[\r\n\x00-\x1f\x7f]/.test(authorization)) {
    throw new GatewayError(401, 'attachment upload', { detail: 'Robin attachment upload requires an OAuth Authorization header' });
  }

  const expectedOrigin = new URL(options.origin ?? ROBIN_UPLOAD_ORIGIN);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadlineMs = Date.now() + timeoutMs;
  const userAgent = options.headers.get('user-agent')?.trim() || `Gemini/${ROBIN_CLIENT_VERSION}`;

  options.signal?.throwIfAborted();
  const connector = options.connectHttp2 ?? connectHttp2;
  const session = await connector(expectedOrigin.origin, { signal: options.signal });
  let sessionError: Error | undefined;
  session.on('error', err => { sessionError = err; });

  try {
    const results: RobinUploadedAttachment[] = [];
    for (const attachment of normalized) {
      options.signal?.throwIfAborted();
      if (sessionError) {
        throw new GatewayError(502, 'attachment upload', {
          detail: `HTTP/2 upload session failed: ${sanitizeUpstreamText(sessionError.message, 160)}`,
          cause: sessionError,
        });
      }

      const startResp = await sendHttp2UploadRequest(
        session,
        {
          ':method': 'POST',
          ':path': ROBIN_UPLOAD_PATH,
          authorization,
          'content-length': '0',
          'push-id': 'feeds/mcudyrk2a4khkz',
          'x-tenant-id': 'bard-storage',
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-command': 'start',
          'x-goog-upload-content-type': attachment.mimeType,
          'x-goog-upload-content-length': String(attachment.data.length),
          'user-agent': userAgent,
        },
        null,
        8192,
        deadlineMs,
        options.signal,
      );
      if (String(startResp.headers['x-goog-upload-status'] ?? '').toLowerCase() !== 'active') {
        throw new GatewayError(502, 'attachment upload', { detail: 'Robin upload start did not return active status' });
      }
      const location = validateUploadLocation(startResp.headers['x-goog-upload-url'], expectedOrigin);

      const finalResp = await sendHttp2UploadRequest(
        session,
        {
          ':method': 'PUT',
          ':path': `${location.pathname}${location.search}`,
          'content-length': String(attachment.data.length),
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-command': 'upload, finalize',
          'x-goog-upload-offset': '0',
          'user-agent': userAgent,
        },
        attachment.data,
        4096,
        deadlineMs,
        options.signal,
      );
      if (String(finalResp.headers['x-goog-upload-status'] ?? '').toLowerCase() !== 'final') {
        throw new GatewayError(502, 'attachment upload', { detail: 'Robin upload finalize did not complete cleanly' });
      }
      let blobId: string;
      try {
        blobId = utf8.decode(finalResp.body).trim();
      } catch {
        throw new GatewayError(502, 'attachment upload', { detail: 'Robin upload returned non-UTF-8 blob ID' });
      }
      if (!blobId || Buffer.byteLength(blobId) > 4096 || /\s|[\x00-\x1f\x7f]/u.test(blobId)) {
        throw new GatewayError(502, 'attachment upload', { detail: 'Robin upload returned an invalid blob ID' });
      }
      results.push({ blobId, mimeType: attachment.mimeType, ...(attachment.name ? { name: attachment.name } : {}) });
    }
    return results;
  } finally {
    closeSessionGracefully(session);
  }
}

/**
 * Uploads static images (PNG / JPEG / WebP) to Google's default Robin Scotty resumable upload
 * endpoint (`https://push.clients6.google.com/upload/`) using the account's existing OAuth token.
 */
export async function uploadRobinImages(options: UploadRobinImagesOptions): Promise<RobinUploadedImage[]> {
  if (!options.images.length) return [];
  if (options.images.length > ROBIN_MAX_IMAGES_PER_REQUEST) {
    throw new GatewayError(400, 'attachment upload', {
      detail: `Robin supports at most ${ROBIN_MAX_IMAGES_PER_REQUEST} images per request`,
    });
  }
  let totalBytes = 0;
  const validated: { data: Buffer; mimeType: RobinImageMime }[] = [];
  for (const item of options.images) {
    if (!Buffer.isBuffer(item.data) || !item.data.length) {
      throw new GatewayError(400, 'attachment upload', { detail: 'Robin image upload requires non-empty image bytes' });
    }
    const detected = detectRobinImageMime(item.data);
    if (!detected) {
      throw new GatewayError(400, 'attachment upload', {
        detail: `Robin native upload only supports PNG, JPEG, and WebP images (got ${item.mimeType ?? 'unknown'})`,
      });
    }
    totalBytes += item.data.length;
    if (totalBytes > ROBIN_MAX_IMAGE_BYTES) {
      throw new GatewayError(400, 'attachment upload', {
        detail: `Robin image attachments exceed the ${Math.round(ROBIN_MAX_IMAGE_BYTES / (1024 * 1024))} MiB request limit`,
      });
    }
    validated.push({ data: item.data, mimeType: detected });
  }
  const uploaded = await uploadRobinAttachments({
    attachments: validated,
    headers: options.headers,
    origin: options.origin,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    connectHttp2: options.connectHttp2,
  });
  return uploaded.map(item => ({ blobId: item.blobId, mimeType: item.mimeType as RobinImageMime }));
}
