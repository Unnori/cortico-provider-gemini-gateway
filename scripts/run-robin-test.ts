import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { proxyFetch } from '../src/http.ts';
import { DesktopOAuth, readOAuthConfig } from '../src/oauth.ts';
import { readState, record } from '../src/state.ts';

const mode = process.argv[2];
const dir = process.argv[3];

if (!mode || !dir || (mode !== 'login' && mode !== 'test')) {
  console.error('Usage: node --experimental-strip-types scripts/run-robin-test.ts <login|test> <endpoint-dir>');
  process.exit(1);
}

const oauthCfg = readOAuthConfig(dir);
if (!oauthCfg) {
  console.error('No desktop-oauth.json found in', dir);
  process.exit(1);
}

const auth = new DesktopOAuth(oauthCfg, dir);

if (mode === 'login') {
  await auth.login(url => {
    console.log('Opening Google OAuth URL in your browser:');
    console.log(url);
    if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', url]);
    }
  });
  console.log('Google OAuth login complete! Saved to:', join(dir, 'oauth-tokens.json'));
  process.exit(0);
}

const providerCfg = record(readState(join(dir, 'config.json')));
const options = record(providerCfg?.options);
const baseUrl = String(providerCfg?.baseUrl ?? 'https://robinfrontend-pa.googleapis.com').replace(/\/+$/, '');
const genRoute = String(options?.generationEndpoint ?? '/$rpc/assistant.mobile.robin.RobinService/StreamGenerate');
const delRoute = String(options?.deleteEndpoint ?? '/$rpc/assistant.mobile.robin.RobinService/DeleteConversation');
const customHeaders = (record(options?.headers) ?? {}) as Record<string, string>;

console.log('Reading / refreshing access token...');
const token = await auth.accessToken(false);
console.log('Access token ready:', token.slice(0, 20) + '...');

const headers: Record<string, string> = {
  ...customHeaders,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

const prompt = 'What is 9 multiplied by 7? Reply with only the number.';
console.log('POST', `${baseUrl}${genRoute}`);
console.log('Query:', prompt);

const resp = await proxyFetch(`${baseUrl}${genRoute}`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ query: { text: prompt } }),
});

console.log('HTTP Status:', resp.status);
const text = await resp.text();
console.log('Raw response:\n', text.slice(0, 1500));

try {
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of rows) {
    const row = record(item);
    const conv = record(row?.conversation);
    const cid = row?.conversationId ?? row?.conversation_id ?? conv?.conversationId;
    if (typeof cid === 'string' && cid) {
      console.log('Cleaning up temporary conversationId:', cid);
      await proxyFetch(`${baseUrl}${delRoute}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ conversationId: cid }),
      });
    }
  }
} catch {
  // ignore cleanup parse errors
}
