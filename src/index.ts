import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { LLMProviderEntry, ReasoningTier } from 'cortico/core/types.ts';
import type { ProviderModule } from 'cortico/providers/base.ts';
import { geminiBaseline, ModelCatalog, type ModelMetadata } from './catalog.ts';
import { GatewayClient } from './client.ts';
import { gatewayControl, type GatewayControl } from './control.ts';
import { createHttp2Connector, createProxyFetchFor } from './http.ts';
import { CustomGeminiProvider } from './native.ts';
import { configuration, option, resolveHeaders } from './options.ts';
import { resolveProviderPrices } from './pricing.ts';
import type { QuotaSnapshot } from './quota.ts';
import type { RobinTermsResult, RobinUserStatus } from './robin-grpc.ts';
import {
  buildRobinListedModels,
  buildRobinRouteSummary,
  robinCatalogLookupIds,
  type RobinRouteSummary,
} from './robin-models.ts';
import { acceptsGatewayMime } from './webui/model-settings.ts';
import { gatewayWebUi } from './webui/server.ts';

const catalogs = new Map<string, ModelCatalog>();
const robinAccounts = new Map<string, GatewayControl>();
const catalogKey = (entry: LLMProviderEntry) => JSON.stringify([
  entry.baseUrl, entry.options?.modelsDevUrl, entry.options?.openRouterUrl, entry.options?.proxyUrl,
]);
const accountKey = (entry: LLMProviderEntry) => JSON.stringify([
  entry.baseUrl, entry.options?.oauthProfile ?? '',
]);
const metadata = (entry: LLMProviderEntry, model: string): ModelMetadata | undefined => {
  const isRobin = entry.options?.protocol === 'robin';
  let fallbacks: string[] | undefined;
  if (isRobin) {
    const ctrl = robinAccounts.get(accountKey(entry));
    const acct = ctrl?.getCachedAccountInfo();
    const obs = ctrl?.getObservedRouting(model);
    fallbacks = robinCatalogLookupIds(model, acct?.plan, acct?.userTier, obs?.attribution);
  }
  return catalogs.get(catalogKey(entry))?.get(model, fallbacks) ?? geminiBaseline(model);
};

function tiers(language: Language): ReasoningTier[] {
  const en = language !== 'zh' && language !== 'zh-Hant';
  return [
    { id: 'off', label: en ? 'Off' : '不思考', thinking: false },
    { id: 'default', label: en ? 'Thinking · default' : '思考 · 默认', thinking: true },
    { id: 'low', label: en ? 'Thinking · fast' : '思考 · 快', thinking: true, effort: 'low' },
    { id: 'medium', label: en ? 'Thinking · standard' : '思考 · 标准', thinking: true, effort: 'medium' },
    { id: 'high', label: en ? 'Thinking · deep' : '思考 · 深入', thinking: true, effort: 'high' },
  ];
}

function normalize(entry: LLMProviderEntry): LLMProviderEntry {
  const spec = entry.spec;
  if (spec === undefined) return entry;
  const model = (spec as { model?: unknown }).model;
  if (typeof model !== 'string' || !model.trim()) return { ...entry, spec: undefined };
  const nextSpec = { ...spec };
  const rawEffort = typeof nextSpec.reasoningEffort === 'string' ? nextSpec.reasoningEffort.trim().toLowerCase() : undefined;
  if (!nextSpec.thinking) {
    delete nextSpec.reasoningEffort;
  } else if (rawEffort === undefined || rawEffort === '' || rawEffort === 'default' || rawEffort === 'auto') {
    delete nextSpec.reasoningEffort;
  } else if (rawEffort === 'off' || rawEffort === 'none' || rawEffort === 'minimal') {
    nextSpec.thinking = false;
    delete nextSpec.reasoningEffort;
  } else if (rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high') {
    nextSpec.reasoningEffort = rawEffort;
  } else if (rawEffort === 'max' || rawEffort === 'xhigh') {
    nextSpec.reasoningEffort = 'high';
  }
  return { ...entry, spec: nextSpec };
}

export interface GatewayInstanceControl {
  oauth: GatewayControl;
  status: () => ReturnType<GatewayControl['status']>;
  apiKeyStatus: () => ReturnType<GatewayControl['apiKeyStatus']>;
  queryQuota: (signal?: AbortSignal, accountId?: string) => Promise<QuotaSnapshot>;
  queryUserStatus: (signal?: AbortSignal, force?: boolean, accountId?: string) => Promise<RobinUserStatus | null>;
  robinRouteSummary: (model: string) => RobinRouteSummary | undefined;
  acceptTerms: (language?: string, signal?: AbortSignal, accountId?: string) => Promise<RobinTermsResult>;
  metadata: (model: string) => ModelMetadata | undefined;
  refreshCatalog: () => Promise<void>;
}

function gatewayConfigGroups(name: string, language: Language): ConfigGroup[] {
  const en = language !== 'zh' && language !== 'zh-Hant';
  const prefix = `providers.${name}.options.`;
  return [{
    id: `llm.gemini-gateway.${name}.headers`,
    owner: 'provider:gemini-gateway',
    schema: {
      type: 'object',
      title: en ? 'Gateway Headers' : '网关请求头',
      properties: {
        [`${prefix}headers`]: {
          type: 'object',
          title: en ? 'Headers (JSON)' : '自定义请求头 (JSON)',
          description: en ? 'Plain HTTP headers sent with generation and quota requests.' : '随生成与额度请求一起发送的明文请求头。',
        },
        [`${prefix}secretHeaders`]: {
          type: 'object',
          title: en ? 'Secret Headers (JSON)' : '密钥请求头映射 (JSON)',
          description: en ? 'Map header names to .env secret variable names.' : '将请求头名称映射到端点 .env 中的密钥变量名。',
        },
      },
    },
  }];
}

export const GEMINI_GATEWAY = {
  id: 'gemini-gateway',
  title: 'Custom Gemini Gateway',
  description: 'Self-hosted Gemini REST and session RPC with configurable desktop OAuth.',
  defaultBaseUrl: 'https://robinfrontend-pa.googleapis.com',
  baseUrlSuggestions: ['https://robinfrontend-pa.googleapis.com', 'http://127.0.0.1:8080'],
  describe: { protocols: ['gemini', 'custom-gemini-rpc'], auth: ['oauth', 'api-key'], local: false, input: ['text', 'image', 'audio', 'video'] },
  localize: (language: Language) => {
    const en = language !== 'zh' && language !== 'zh-Hant';
    return {
      title: 'Custom Gemini Gateway',
      description: en
        ? 'Gemini Robin desktop OAuth & self-hosted Gemini REST / RPC gateway with automatic formats, pricing and quota.'
        : '支持 Robin 桌面 OAuth 与自建 Gemini REST/RPC 网关，内置额度查询、格式声明与自动计价。',
      reasoningTiers: tiers(language),
    };
  },
  reasoningTiers: tiers('zh'),
  serviceTiers: [],
  normalize,
  validateEntry(entry) { configuration(entry); },
  validateModel(_entry, spec) {
    if (!geminiBaseline(spec.model)) throw new Error('Expected a Gemini model ID');
  },
  availability(_name, entry, language) {
    const en = language !== 'zh' && language !== 'zh-Hant';
    const config = configuration(entry);
    if (config.authMode === 'api-key' && !entry.secret && !config.apiKeyConfigured) {
      return {
        ready: false,
        reason: en
          ? 'Enter an API Key in Step 2 or switch auth mode to OAuth.'
          : '请在第二步填写 API Key，或将认证模式切换为 OAuth。',
      };
    }
    return { ready: true };
  },
  accepts: (entry, spec, mime) => acceptsGatewayMime(entry, metadata(entry, spec.model), mime),
  config: (name, _entry, language) => gatewayConfigGroups(name, language),
  webUi: gatewayWebUi,
  prices(entry, request) {
    const model = request.model ?? entry.spec?.model ?? '';
    return resolveProviderPrices(entry, model, metadata(entry, model));
  },
  create(name, entry, host) {
    const current = () => host.currentEntry?.() ?? entry;
    const options = configuration(entry);
    const oauth = gatewayControl(host, entry);
    const headers = resolveHeaders(entry, host, true, oauth.oauthDir);
    const useOAuth = oauth.authEnabled(entry);
    const key = catalogKey(entry);
    const constructCatalog = () => new ModelCatalog(host.stateDir, {
      modelsDevUrl: option(entry, 'modelsDevUrl'), openRouterUrl: option(entry, 'openRouterUrl'),
      fetch: createProxyFetchFor(options.proxyUrl),
      warn: message => host.log.warn(message),
    });
    const catalog = host.resource?.(`gemini-catalog:${key}`, constructCatalog) ?? constructCatalog();
    catalogs.set(key, catalog);
    if (options.protocol === 'robin') robinAccounts.set(accountKey(entry), oauth);
    const resolveModelMeta = (model: string): ModelMetadata | undefined => {
      const cur = current();
      const isRobin = configuration(cur).protocol === 'robin';
      if (!isRobin) return catalog.get(model) ?? geminiBaseline(model);
      const acct = oauth.getCachedAccountInfo();
      const observed = oauth.getObservedRouting(model);
      const fallbacks = robinCatalogLookupIds(model, acct.plan, acct.userTier, observed?.attribution);
      return catalog.get(model, fallbacks) ?? geminiBaseline(model);
    };
    const gateway = new GatewayClient({
      ...options,
      headers,
      fetch: (input, init) => createProxyFetchFor(configuration(current()).proxyUrl)(input, init),
      connectHttp2: (origin, h2Opts) => createHttp2Connector(configuration(current()).proxyUrl)(origin, h2Opts),
      resolveHeaders: () => resolveHeaders(current(), host, true, oauth.oauthDir),
      auth: {
        enabled: () => oauth.authEnabled(current()),
        accessToken: force => {
          oauth.refreshBundledConfig();
          oauth.setProxyUrl(configuration(current()).proxyUrl);
          return oauth.auth.accessToken(force);
        },
        selectAccounts: () => {
          oauth.refreshBundledConfig();
          oauth.setProxyUrl(configuration(current()).proxyUrl);
          return oauth.pickAccountOrder(configuration(current()).accountRouting);
        },
        accessTokenFor: (accountId, force) => {
          oauth.refreshBundledConfig();
          oauth.setProxyUrl(configuration(current()).proxyUrl);
          return oauth.auth.accessTokenFor(accountId, force);
        },
        onAccountSuccess: accountId => {
          oauth.clearAccountCooldown(accountId);
          const cur = current();
          const curCfg = configuration(cur);
          if (curCfg.protocol === 'robin') {
            oauth.markAccountTermsAccepted(accountId);
          }
          if (curCfg.protocol === 'robin' && curCfg.accountRouting === 'least-used' && oauth.auth.listAccounts().length > 1) {
            const rt = oauth.getAccountRuntime(accountId);
            const fetchedAtMs = rt.quotaFetchedAt ? Date.parse(rt.quotaFetchedAt) : 0;
            if (!fetchedAtMs || Date.now() - fetchedAtMs > 2 * 60_000) {
              void oauth.queryQuota(cur, host, undefined, accountId).catch(() => {});
            }
          }
        },
        onAccountFailure: (accountId, status, detail) => {
          const isTermsError = Boolean(detail && /accept our terms of service|terms of service|服务条款/i.test(detail));
          if (isTermsError) {
            oauth.markAccountTermsRequired(accountId);
          }
          let cooldownMs = 5 * 60_000;
          if (isTermsError) {
            cooldownMs = 15 * 60_000;
          } else if (status === 429) {
            const rt = oauth.getAccountRuntime(accountId);
            const fiveHr = rt.quota?.windows.find(w => w.id === 'fiveHour');
            const resetMs = fiveHr?.resetsAt ? Date.parse(fiveHr.resetsAt) - Date.now() : NaN;
            if (Number.isFinite(resetMs) && resetMs > 60_000) {
              cooldownMs = Math.min(resetMs, 30 * 60_000);
            }
          } else if (status === 403) {
            cooldownMs = 15 * 60_000;
          } else if (status === 401) {
            cooldownMs = 10 * 60_000;
          }
          const label = detail?.trim() || (status ? `HTTP ${status}` : '请求失败');
          oauth.markAccountCooldown(accountId, cooldownMs, label);
          host.log.warn('Gemini gateway account entered cooldown', {
            accountId,
            status,
            cooldownSec: Math.round(cooldownMs / 1000),
            detail,
          });
        },
      },
      resolveRobinModeCategory: (model, accountId) => oauth.resolveDiscoveredModeCategory(model, accountId),
      onRobinRouting: (obs, accountId) => {
        oauth.recordRouting(obs, accountId);
        const downgraded = obs.fallback === 1
          || (obs.downgradeReason !== undefined && obs.downgradeReason > 0)
          || (obs.requestedModeCategory !== undefined
            && obs.resolvedModeCategory !== undefined
            && obs.resolvedModeCategory !== obs.requestedModeCategory);
        if (downgraded) {
          host.log.warn('Robin backend routed or downgraded model', {
            ...(accountId ? { accountId } : {}),
            requestedModel: obs.requestedModel,
            requestedModeCategory: obs.requestedModeCategory,
            resolvedModeCategory: obs.resolvedModeCategory,
            attribution: obs.attribution,
            fallback: obs.fallback,
            downgradeReason: obs.downgradeReason,
          });
        }
      },
      onCleanupError: error => host.log.warn('Gemini gateway conversation cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    });
    const control: GatewayInstanceControl = {
      oauth,
      status: () => oauth.status(current()),
      apiKeyStatus: () => oauth.apiKeyStatus(current(), host),
      queryQuota: (signal, accountId) => oauth.queryQuota(current(), host, signal, accountId),
      queryUserStatus: (signal, force, accountId) => oauth.queryUserStatus(current(), host, signal, force, accountId),
      robinRouteSummary: model => {
        const cur = current();
        if (configuration(cur).protocol !== 'robin') return undefined;
        const acct = oauth.getCachedAccountInfo();
        return buildRobinRouteSummary({
          model,
          userStatus: acct.userStatus,
          plan: acct.plan,
          userTier: acct.userTier,
          observed: oauth.getObservedRouting(model),
          overrideModeCategory: oauth.resolveDiscoveredModeCategory(model),
        });
      },
      acceptTerms: (language, signal, accountId) => oauth.acceptTerms(current(), host, language, signal, accountId),
      metadata: model => resolveModelMeta(model),
      refreshCatalog: async () => {
        const cur = current();
        const tasks: Promise<unknown>[] = [catalog.refresh(true)];
        if (configuration(cur).protocol === 'robin' && oauth.authEnabled(cur) && oauth.auth.status().signedIn) {
          tasks.push(
            oauth.queryUserStatus(cur, host, undefined, true).catch(() => null),
            oauth.queryQuota(cur, host).catch(() => null),
          );
        }
        await Promise.all(tasks);
      },
    };
    return {
      client: new CustomGeminiProvider(name, gateway, host, model => {
        void catalog.refresh();
        return mime => acceptsGatewayMime(current(), resolveModelMeta(model), mime);
      }),
      control,
      start: () => {
        const cur = current();
        const curCfg = configuration(cur);
        if (curCfg.protocol === 'robin' && oauth.authEnabled(cur) && oauth.auth.listAccounts().length > 1) {
          void oauth.queryQuota(cur, host).catch(() => {});
        }
        return catalog.refresh();
      },
      listModels: async () => {
        const cur = current();
        const isRobin = configuration(cur).protocol === 'robin';
        if (isRobin) {
          const signedIn = oauth.authEnabled(cur) && oauth.auth.status().signedIn;
          const [userStatus, quota] = await Promise.all([
            signedIn ? oauth.queryUserStatus(cur, host, undefined, true).catch(err => {
              host.log.warn('Robin GetUserStatus failed while listing models', {
                error: err instanceof Error ? err.message : String(err),
              });
              return oauth.getCachedAccountInfo().userStatus ?? null;
            }) : Promise.resolve(null),
            signedIn ? oauth.queryQuota(cur, host).catch(() => null) : Promise.resolve(null),
            catalog.refresh().catch(() => undefined),
          ]);
          const acct = oauth.getCachedAccountInfo();
          return buildRobinListedModels({
            userStatus,
            plan: quota?.plan ?? acct.plan,
            userTier: quota?.userTier ?? acct.userTier,
            configuredModel: cur.spec?.model,
            resolveMeta: id => resolveModelMeta(id),
            observedRouting: id => oauth.getObservedRouting(id),
          });
        }
        return (await catalog.list(cur.spec?.model, false)).map(model => ({
          id: model.id,
          displayName: model.displayName,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          inputImages: model.inputMimeTypes.some(mime => mime.startsWith('image/')),
        }));
      },
      contextWindow: model => resolveModelMeta(model)?.contextWindow,
      compatibilityKey: () => [options.protocol, options.authMode, useOAuth, options.generationEndpoint, oauth.oauthDir],
    };
  },
} satisfies ProviderModule;

export default GEMINI_GATEWAY;
export { GatewayClient } from './client.ts';
export type { GatewayClientOptions } from './client.ts';
export type { GeminiChunk, GeminiRequest } from './shim.ts';
