import { registerHooks } from 'node:module';
import { join } from 'node:path';

const RESPONSE_HTTP_STUB = `
const LONE_SURROGATE = /[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/g;
export function requestJson(body) {
  return JSON.stringify(body, (_key, value) => typeof value === 'string' ? value.replace(LONE_SURROGATE, '\\uFFFD') : value);
}
export class EventDecoder {
  #buffer = '';
  #scanned = 0;
  #data = [];
  feed(text) {
    this.#buffer += text;
    const events = [];
    let start = 0;
    for (;;) {
      const newline = this.#buffer.indexOf('\\n', Math.max(start, this.#scanned));
      if (newline < 0) break;
      const line = this.#buffer.slice(start, newline).replace(/\\r$/, '');
      start = newline + 1;
      if (line === '') {
        if (this.#data.length) events.push(this.#data.join('\\n'));
        this.#data = [];
      } else if (line.startsWith('data:')) {
        this.#data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    this.#buffer = this.#buffer.slice(start);
    this.#scanned = this.#buffer.length;
    return events;
  }
}
`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cortico/providers/transport/response-http.ts') {
      return { url: 'cortico-standalone://response-http', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'cortico-standalone://response-http') {
      return { format: 'module', source: RESPONSE_HTTP_STUB, shortCircuit: true };
    }
    return next(url, context);
  },
});

const { GatewayClient } = await import('../src/client.ts');
const { DesktopOAuth, readOAuthConfig } = await import('../src/oauth.ts');
const { queryGatewayQuota } = await import('../src/quota.ts');
const { readState, record } = await import('../src/state.ts');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node --experimental-strip-types scripts/verify-robin.ts <endpoint-dir>');
  process.exit(1);
}

const oauthCfg = readOAuthConfig(dir);
if (!oauthCfg) {
  console.error('No desktop-oauth.json found in', dir);
  process.exit(1);
}

const providerCfg = record(readState(join(dir, 'config.json')));
const options = record(providerCfg?.options);
const auth = new DesktopOAuth(oauthCfg, dir);

console.log('Minting / reading access token...');
const token = await auth.accessToken(false);
console.log('Access token ready:', token.slice(0, 18) + '...');

const baseUrl = String(providerCfg?.baseUrl ?? 'https://robinfrontend-pa.googleapis.com');
const quota = await queryGatewayQuota({
  baseUrl,
  protocol: 'robin',
  quotaEndpoint: typeof options?.quotaEndpoint === 'string' ? options.quotaEndpoint : '/assistant.mobile.robin.RobinService/GetUsageInfo',
  headers: (record(options?.headers) ?? {}) as Record<string, string>,
  auth,
});
console.log('Quota:', JSON.stringify(quota, null, 2));

const client = new GatewayClient({
  baseUrl,
  protocol: 'robin',
  generationEndpoint: typeof options?.generationEndpoint === 'string' ? options.generationEndpoint : '/assistant.mobile.robin.RobinService/ProcessQuery',
  ...(typeof options?.deleteEndpoint === 'string' && options.deleteEndpoint ? { deleteEndpoint: options.deleteEndpoint } : {}),
  headers: (record(options?.headers) ?? {}) as Record<string, string>,
  auth,
});

console.log('Sending test query to RobinService/ProcessQuery...');
for await (const chunk of client.stream({
  model: 'gemini-4-hydrogen',
  contents: [{ role: 'user', parts: [{ text: 'What is 9 multiplied by 7? Reply with only the number.' }] }],
})) {
  console.log('Chunk:', JSON.stringify(chunk));
}
console.log('Robin live test succeeded!');
