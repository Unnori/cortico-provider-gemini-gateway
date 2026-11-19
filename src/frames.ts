import { EventDecoder } from 'cortico/providers/transport/response-http.ts';

const FRAME_LIMIT = 8 * 1024 * 1024;

/** A JSON object or a streamed top-level JSON array, with quoted delimiters handled across chunks. */
class JsonFrames {
  private mode?: 'array' | 'object';
  private value = '';
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private closed = false;
  private afterComma = false;
  private emitted = false;

  *feed(text: string): Generator<string> {
    if (!this.mode) {
      text = text.trimStart();
      if (!text) return;
      this.mode = text.startsWith('[') ? 'array' : 'object';
      if (this.mode === 'array') text = text.slice(1);
    }
    if (this.mode === 'object') {
      this.value += text;
      this.checkLimit();
      return;
    }
    for (const char of text) {
      if (this.closed) {
        if (!/\s/.test(char)) throw new Error('Unexpected data after gateway JSON array');
        continue;
      }
      if (!this.quoted && this.depth === 0 && (char === ',' || char === ']')) {
        const value = this.value.trim();
        if (!value && !this.emitted && (char === ',' || this.afterComma)) throw new Error('Missing value in gateway JSON array');
        this.value = '';
        this.emitted = false;
        this.closed = char === ']';
        this.afterComma = char === ',';
        if (value) yield value;
        continue;
      }
      if (this.emitted) {
        if (!/\s/.test(char)) throw new Error('Missing delimiter in gateway JSON array');
        continue;
      }
      this.value += char;
      this.checkLimit();
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.quoted = false;
      } else if (char === '"') this.quoted = true;
      else if (char === '[' || char === '{') this.depth++;
      else if (char === ']' || char === '}') {
        this.depth--;
        if (this.depth === 0) {
          const value = this.value;
          this.value = '';
          this.emitted = true;
          yield value;
        }
      }
    }
  }

  finish(): string[] {
    if (this.mode === 'array' && !this.closed) throw new Error('Gateway JSON array ended prematurely');
    return this.mode === 'object' && this.value.trim() ? [this.value] : [];
  }

  private checkLimit(): void {
    if (this.value.length > FRAME_LIMIT) throw new Error('Gateway JSON frame exceeds the size limit');
  }
}

export async function* gatewayFrames(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('Gemini gateway returned an empty response body');
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  const sse = type.includes('text/event-stream') ? new EventDecoder() : undefined;
  const ndjson = /(?:ndjson|jsonl)/.test(type);
  const json = new JsonFrames();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const reader = response.body.getReader();
  let line = '';

  function* feed(text: string, done: boolean): Generator<string> {
    if (sse) {
      yield* sse.feed(done ? text + '\n\n' : text);
    } else if (ndjson) {
      const lines = (line + text).split('\n');
      line = lines.pop() ?? '';
      if (line.length > FRAME_LIMIT) throw new Error('Gateway NDJSON frame exceeds the size limit');
      if (done) lines.push(line);
      for (const value of lines) if (value.trim()) yield value;
    } else {
      yield* json.feed(text);
      if (done) yield* json.finish();
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      for (const payload of feed(utf8.decode(value, { stream: !done }), done)) {
        if (payload.trim() === '[DONE]') return;
        if (payload.length > FRAME_LIMIT) throw new Error('Gateway JSON frame exceeds the size limit');
        yield JSON.parse(payload);
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
