import { maskEmail } from './redact.ts';
import { record } from './state.ts';

interface Waiter {
  grant: () => void;
}

/** An abortable FIFO lock. Callers hold it through stream finalization and cleanup. */
export class SerialQueue {
  private locked = false;
  private readonly waiting = new Set<Waiter>();

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (!this.locked) {
      this.locked = true;
      return this.release();
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting.delete(waiter);
        reject(signal?.reason);
      };
      const waiter: Waiter = { grant: () => {
        signal?.removeEventListener('abort', abort);
        resolve(this.release());
      } };
      this.waiting.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.values().next().value;
      if (next) {
        this.waiting.delete(next);
        next.grant();
      } else {
        this.locked = false;
      }
    };
  }
}

export function sanitizeUpstreamText(value: string, maxLength = 320): string {
  const cleaned = value
    .slice(0, 8192)
    .replace(/\b(?:ya29\.[A-Za-z0-9._-]+|GOCSPX-[A-Za-z0-9_-]+|1\/\/[A-Za-z0-9._-]+|Bearer\s+\S+)\b/gi, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, match => maskEmail(match) ?? '[email]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

async function readBoundedText(response: Response, limitBytes = 8192): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, limitBytes - total);
      chunks.push(take === value.byteLength ? value : value.subarray(0, take));
      total += take;
    }
  } catch {
    // Ignore read errors on error bodies.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function inspectHttpError(response: Response): Promise<{ status: number; detail?: string; body: string }> {
  const status = response.status;
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const raw = await readBoundedText(response);
  if (!raw.trim()) return { status, body: '' };

  if (contentType.includes('text/html') || /^\s*</.test(raw)) {
    if (/<title>\s*Sorry\b/i.test(raw) || /sending automated queries/i.test(raw)) {
      const detail = `Google 拦截了该 HTTP 请求（上游返回 HTTP ${status} Sorry 反自动化页）；若使用 Robin 协议请改用原生 HTTP/2 gRPC 路由 /assistant.mobile.robin.RobinService/ProcessQuery，或切换代理出口节点。`;
      return { status: status === 503 ? 403 : status, detail, body: detail };
    }
    const title = /<title>([^<]{1,120})<\/title>/i.exec(raw)?.[1];
    const detail = sanitizeUpstreamText(title ?? raw.replace(/<[^>]+>/g, ' '), 200);
    return { status, ...(detail ? { detail } : {}), body: detail };
  }

  try {
    const parsed = record(JSON.parse(raw));
    const errObj = record(parsed?.error) ?? parsed;
    const rpcStatus = typeof errObj?.status === 'string' ? errObj.status : '';
    const rpcMessage = typeof errObj?.message === 'string' ? errObj.message : '';
    let reason = '';
    let service = '';
    if (Array.isArray(errObj?.details)) {
      for (const item of errObj.details) {
        const entry = record(item);
        if (typeof entry?.reason === 'string' && !reason) reason = entry.reason;
        const meta = record(entry?.metadata);
        if (typeof meta?.service === 'string' && !service) service = meta.service;
      }
    }
    const parts = [rpcStatus, reason ? `(${reason})` : '', rpcMessage].filter(Boolean).join(' ').trim();
    if (parts) {
      let detail = sanitizeUpstreamText(parts, 260);
      if (status === 403 && service.includes('robinfrontend-pa')) {
        detail += '（当前 OAuth 令牌缺少 Robin 所需权限 Scope，请在「浏览器 OAuth 认证」面板重新登录授权）';
      }
      return { status, detail, body: detail };
    }
  } catch {
    // Not JSON; fall through to plain text summary.
  }

  const snippet = sanitizeUpstreamText(raw, 220);
  return { status, ...(snippet ? { detail: snippet } : {}), body: snippet };
}

export interface GatewayErrorOptions extends ErrorOptions {
  detail?: string;
  body?: string;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, operation: string, options?: GatewayErrorOptions) {
    const fallback = status === 429 ? 'rate limit exceeded'
      : status === 403 ? 'access forbidden'
      : status === 401 ? 'authentication failed'
      : 'request failed';
    const detail = options?.detail?.trim() || fallback;
    super(`Gemini gateway ${operation} HTTP ${status}: ${detail}`, options);
    this.status = status;
    this.body = options?.body ?? detail;
    this.name = 'GatewayError';
  }
}
