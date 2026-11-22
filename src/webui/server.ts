import { randomUUID } from 'node:crypto';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import { validatePrices } from 'cortico/providers/pricebook.ts';
import { connectionBlocks } from 'cortico/providers/webui/config.ts';
import type { ProviderWebUiHost } from 'cortico/providers/webui/types.ts';
import type { WebUiPageContribution } from 'cortico/web/shared/webui-protocol.ts';
import type { GatewayInstanceControl } from '../index.ts';
import { maskProxyDisplay, parseProxyUrlInput } from '../http.ts';
import type { AccountTermsStatus } from '../oauth.ts';
import {
  configuration,
  presetEntryPatch,
  resolveAutoBaseUrl,
  type AccountRoutingMode,
  type AuthMode,
  type GatewayPresetId,
} from '../options.ts';
import type { AccountQuotaOption, QuotaBarMode, QuotaSnapshot } from '../quota.ts';
import type { GatewayProtocol } from '../shim.ts';
import { httpUrl, record } from '../state.ts';
import {
  inputCapabilities,
  MODEL_SETTINGS_PANEL,
  modelSettings,
  type InputCapabilities,
  type ModelSettings,
} from './model-settings.ts';

export interface AuthAccountItem {
  id: string;
  email?: string;
  expiresAt: number;
  isPrimary: boolean;
  addedAt: string;
  termsStatus: AccountTermsStatus;
  termsVersion?: number;
  termsAcceptedAt?: string;
  plan?: string;
  userTier?: string;
  cooldownUntil?: number;
  cooldownReason?: string;
  lastError?: string;
  fiveHourRemaining?: number;
  fiveHourResetsAt?: string;
  weeklyRemaining?: number;
  weeklyResetsAt?: string;
}

export interface AuthPanelStatus {
  saved: boolean;
  protocol: GatewayProtocol;
  authMode: AuthMode;
  accountRouting: AccountRoutingMode;
  emailsMasked: boolean;
  quotaBarMode: QuotaBarMode;
  configured: boolean;
  customConfig: boolean;
  signedIn: boolean;
  pending: boolean;
  pendingTargetAccountId?: string;
  authEnabled: boolean;
  apiKeyConfigured: boolean;
  apiKeySource: 'stored' | 'env' | 'none';
  apiKeyHint?: string;
  secretVar?: string;
  credentialHeader: string;
  credentialPrefix: string;
  authUrl?: string;
  redirectUri?: string;
  clientId?: string;
  expiresAt?: number;
  email?: string;
  primaryAccountId?: string;
  accounts: AuthAccountItem[];
  error?: string;
}

export interface QuotaAccountLabels {
  emailsMasked: boolean;
  quotaBarMode: QuotaBarMode;
  accountRouting: AccountRoutingMode;
  accountOptions: AccountQuotaOption[];
}

export interface CustomRoutesState {
  protocol: GatewayProtocol;
  baseUrl: string;
  generationEndpoint: string;
  uploadEndpoint: string;
  deleteEndpoint: string;
  conversationHeader: string;
  quotaEndpoint: string;
}

export interface GatewayPanelState {
  baseUrl: string;
  model: string;
  protocol: GatewayProtocol;
  authMode: AuthMode;
  generationEndpoint: string;
  uploadEndpoint: string;
  deleteEndpoint: string;
  quotaEndpoint: string;
  proxyUrl: string;
  temporaryChat: boolean;
  authEnabled: boolean;
}

export interface GatewayTestResult {
  ok: boolean;
  elapsedMs: number;
  summary: string;
}

const STRING_OPTION_KEYS = [
  'generationEndpoint',
  'uploadEndpoint',
  'deleteEndpoint',
  'quotaEndpoint',
  'conversationHeader',
  'authHeader',
  'authPrefix',
  'credentialHeader',
  'credentialPrefix',
  'modelsDevUrl',
  'openRouterUrl',
] as const;

function asGatewayState(entry: LLMProviderEntry, authEnabled: boolean): GatewayPanelState {
  const cfg = configuration(entry);
  return {
    baseUrl: entry.baseUrl,
    model: entry.spec?.model ?? '',
    protocol: cfg.protocol,
    authMode: cfg.authMode,
    generationEndpoint: cfg.generationEndpoint ?? '',
    uploadEndpoint: cfg.uploadEndpoint ?? '',
    deleteEndpoint: cfg.deleteEndpoint ?? '',
    quotaEndpoint: cfg.quotaEndpoint ?? '',
    proxyUrl: cfg.proxyUrl ?? '',
    temporaryChat: cfg.temporaryChat ?? true,
    authEnabled,
  };
}

function asCustomRoutesState(entry: LLMProviderEntry): CustomRoutesState {
  const cfg = configuration(entry);
  return {
    protocol: cfg.protocol,
    baseUrl: entry.baseUrl,
    generationEndpoint: cfg.generationEndpoint ?? '',
    uploadEndpoint: cfg.uploadEndpoint ?? '',
    deleteEndpoint: cfg.deleteEndpoint ?? '',
    conversationHeader: cfg.conversationHeader ?? '',
    quotaEndpoint: cfg.quotaEndpoint ?? '',
  };
}

function asAuthStatus(control: GatewayInstanceControl, entry: LLMProviderEntry, saved: boolean): AuthPanelStatus {
  const status = control.status();
  const keyInfo = control.apiKeyStatus();
  const cfg = configuration(entry);
  const accounts: AuthAccountItem[] = status.accounts.map(acct => {
    const rt = control.oauth.getAccountRuntime(acct.id);
    return {
      id: acct.id,
      ...(acct.email ? { email: acct.email } : {}),
      expiresAt: acct.expiresAt,
      isPrimary: acct.isPrimary,
      addedAt: acct.addedAt,
      termsStatus: acct.termsStatus,
      ...(acct.termsVersion !== undefined ? { termsVersion: acct.termsVersion } : {}),
      ...(acct.termsAcceptedAt ? { termsAcceptedAt: acct.termsAcceptedAt } : {}),
      ...(rt.plan ? { plan: rt.plan } : {}),
      ...(rt.userTier ? { userTier: rt.userTier } : {}),
      ...(rt.cooldownUntil ? { cooldownUntil: rt.cooldownUntil } : {}),
      ...(rt.cooldownReason ? { cooldownReason: rt.cooldownReason } : {}),
      ...(rt.lastError ? { lastError: rt.lastError } : {}),
      ...(rt.fiveHourRemaining !== undefined ? { fiveHourRemaining: rt.fiveHourRemaining } : {}),
      ...(rt.fiveHourResetsAt ? { fiveHourResetsAt: rt.fiveHourResetsAt } : {}),
      ...(rt.weeklyRemaining !== undefined ? { weeklyRemaining: rt.weeklyRemaining } : {}),
      ...(rt.weeklyResetsAt ? { weeklyResetsAt: rt.weeklyResetsAt } : {}),
    };
  });
  return {
    saved,
    protocol: cfg.protocol,
    authMode: cfg.authMode,
    accountRouting: cfg.accountRouting,
    emailsMasked: status.emailsMasked,
    quotaBarMode: status.quotaBarMode,
    configured: status.configured,
    customConfig: status.customConfig,
    signedIn: status.signedIn,
    pending: status.pending,
    ...(status.pendingTargetAccountId ? { pendingTargetAccountId: status.pendingTargetAccountId } : {}),
    authEnabled: status.authEnabled,
    apiKeyConfigured: keyInfo.configured,
    apiKeySource: keyInfo.source,
    ...(keyInfo.hint ? { apiKeyHint: keyInfo.hint } : {}),
    ...(entry.secret ? { secretVar: entry.secret } : {}),
    credentialHeader: cfg.credentialHeader ?? 'x-goog-api-key',
    credentialPrefix: cfg.credentialPrefix ?? '',
    ...(status.authUrl ? { authUrl: status.authUrl } : {}),
    ...(status.redirectUri ? { redirectUri: status.redirectUri } : {}),
    ...(status.clientId ? { clientId: status.clientId } : {}),
    ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
    ...(status.email ? { email: status.email } : {}),
    ...(status.primaryAccountId ? { primaryAccountId: status.primaryAccountId } : {}),
    accounts,
    ...(status.error ? { error: status.error } : {}),
  };
}

export function gatewayWebUi(host: ProviderWebUiHost): Partial<WebUiPageContribution> {
  const en = host.language !== 'zh' && host.language !== 'zh-Hant';
  const blocks = connectionBlocks(host.language);

  const findEntry = (args: unknown[]): { name: string; entry: LLMProviderEntry } => {
    const raw = record(args[0]);
    if (!raw || typeof raw.name !== 'string' || !raw.name) {
      throw new Error(en ? 'Select a Custom Gemini Gateway connection first.' : '请先选择一个 Custom Gemini Gateway 连接。');
    }
    const found = host.entries().find(item => item.name === raw.name);
    if (!found) throw new Error(en ? 'Gateway connection does not exist.' : '该网关连接不存在。');
    return found;
  };

  const ensureDraftDefaults = (name: string, entry: LLMProviderEntry): LLMProviderEntry => {
    if (!host.editing || name !== 'draft') return entry;
    let next = entry;
    if (entry.options === undefined && entry.baseUrl.startsWith('https://robinfrontend-pa.googleapis.com')) {
      const preset = presetEntryPatch('robin', entry.baseUrl);
      next = {
        ...next,
        baseUrl: preset.baseUrl,
        multimodal: next.multimodal ?? true,
        spec: {
          thinking: next.spec?.thinking ?? true,
          ...next.spec,
          model: next.spec?.model || preset.model,
        },
        options: {
          ...preset.options,
          oauthProfile: randomUUID(),
        },
      };
      host.save(name, next);
    } else if (!next.options?.oauthProfile) {
      next = {
        ...next,
        options: { ...next.options, oauthProfile: randomUUID() },
      };
      host.save(name, next);
    }
    return next;
  };

  return {
    panels: [
      { id: 'gateway', title: en ? 'Connection & Mode' : '连接模式与自动地址', defaultOpen: true },
      { id: 'auth', title: en ? 'Browser OAuth' : '浏览器 OAuth 认证', defaultOpen: true },
      { id: 'quota', title: en ? 'Quota & Usage' : '额度查询', defaultOpen: true },
      blocks.model,
      {
        id: MODEL_SETTINGS_PANEL,
        title: en ? 'Model inputs and pricing' : '模型输入与计价',
        defaultOpen: true,
        getMethods: ['input-capabilities'],
      },
      blocks.protocol,
    ],
    invoke: async (panel, method, args): Promise<
      | AuthPanelStatus
      | QuotaSnapshot
      | QuotaAccountLabels
      | CustomRoutesState
      | GatewayPanelState
      | GatewayTestResult
      | ModelSettings
      | InputCapabilities
      | { url: string; redirectUri: string; status: AuthPanelStatus }
      | { accepted: boolean; version: number; acceptedAt: string; status: AuthPanelStatus }
      | { text: string; custom: boolean }
    > => {
      if (!['auth', 'quota', 'gateway', MODEL_SETTINGS_PANEL].includes(panel)) {
        throw new Error(en ? 'Unknown gateway panel' : '未知网关面板');
      }

      const raw = record(args[0]) ?? {};
      let { name, entry } = findEntry(args);

      if (panel === MODEL_SETTINGS_PANEL) {
        entry = ensureDraftDefaults(name, entry);
        const control = host.instance(name).control as GatewayInstanceControl;
        const model = entry.spec?.model ?? '';
        const metaFor = (target: LLMProviderEntry) => control.metadata(target.spec?.model ?? '');
        const settingsFor = (target: LLMProviderEntry) => modelSettings(
          target,
          metaFor(target),
          control.robinRouteSummary(target.spec?.model ?? ''),
        );

        if (method === 'input-capabilities') {
          const mimes = raw.mimes === undefined ? [] : raw.mimes;
          if (!Array.isArray(mimes) || mimes.length > 128
              || mimes.some(mime => typeof mime !== 'string' || !mime.includes('/') || mime.length > 256)) {
            throw new Error(en ? 'Invalid MIME query' : '无效的 MIME 查询参数');
          }
          return inputCapabilities(entry, metaFor(entry), mimes as string[]);
        }
        if (method === 'pricing-state') {
          return settingsFor(entry);
        }
        if (method === 'refresh-catalog') {
          await control.refreshCatalog();
          return settingsFor(entry);
        }
        if (method === 'pricing-mirror') {
          const enabled = raw.enabled;
          if (configuration(entry).protocol !== 'robin' || typeof enabled !== 'boolean') {
            throw new Error(en ? 'Invalid subscription mirror setting' : '无效的订阅折算同步设置');
          }
          const next: LLMProviderEntry = { ...entry, options: { ...entry.options, mirrorSubscriptionSpend: enabled } };
          configuration(next);
          host.save(name, next);
          return settingsFor(next);
        }
        if (method === 'pricing-estimate') {
          const enabled = raw.enabled;
          if (configuration(entry).protocol !== 'robin' || typeof enabled !== 'boolean') {
            throw new Error(en ? 'Invalid Robin token estimation setting' : '无效的 Robin 本地 Token 估算设置');
          }
          const next: LLMProviderEntry = { ...entry, options: { ...entry.options, estimateRobinTokens: enabled } };
          configuration(next);
          host.save(name, next);
          return settingsFor(next);
        }
        if (raw.model !== model) {
          throw new Error(en ? 'Model changed; refresh pricing before applying' : '模型已变更，请刷新后再应用计价');
        }
        if (method === 'input-save') {
          const kind = String(raw.kind ?? '');
          const enabled = raw.enabled;
          if (!['image', 'audio', 'video', 'file'].includes(kind) || typeof enabled !== 'boolean') {
            throw new Error(en ? 'Invalid input setting' : '无效的输入类型设置');
          }
          const currentState = settingsFor(entry);
          if (enabled && !currentState.inputs.find(item => item.kind === kind)?.available) {
            throw new Error(en ? 'Input type is not supported by the model or protocol' : '当前模型或协议不支持该输入类型');
          }
          const options: Record<string, unknown> = { ...entry.options };
          if (enabled) options.attachments = 'auto';
          if (kind !== 'image') {
            options[kind === 'audio' ? 'inputAudio' : kind === 'video' ? 'inputVideo' : 'inputFiles'] = enabled;
          }
          const next: LLMProviderEntry = {
            ...entry,
            options,
            ...(kind === 'image' ? { multimodal: enabled } : {}),
          };
          configuration(next);
          host.save(name, next);
          return settingsFor(next);
        }
        if (method === 'pricing-reset') {
          const next: LLMProviderEntry = {
            ...entry,
            pricing: (entry.pricing ?? []).filter(def => !def.models.includes(model) && !def.models.includes('*')),
          };
          host.save(name, next);
          return settingsFor(next);
        }
        if (method === 'pricing-save') {
          const definitions = validatePrices(raw.definitions, host.language);
          if (definitions.some(def => def.models.length !== 1 || def.models[0] !== model)) {
            throw new Error(en ? 'Custom prices must name the selected model' : '自定义计价规则必须指定当前选中的模型');
          }
          const next: LLMProviderEntry = {
            ...entry,
            pricing: [
              ...(entry.pricing ?? []).filter(def => !def.models.includes(model) && !def.models.includes('*')),
              ...definitions,
            ],
          };
          host.save(name, next);
          return settingsFor(next);
        }
        throw new Error(en ? 'Unknown model settings action' : '未知模型计价操作');
      }

      if (panel === 'gateway') {
        entry = ensureDraftDefaults(name, entry);
        if (method === 'state') {
          const control = host.instance(name).control as GatewayInstanceControl;
          return asGatewayState(entry, control.oauth.authEnabled(entry));
        }
        if (method === 'apply-preset') {
          const presetId = raw.preset;
          if (presetId !== 'robin' && presetId !== 'gemini' && presetId !== 'rpc') {
            throw new Error(en ? 'Unknown gateway preset' : '未知预设类型');
          }
          const preset = presetEntryPatch(presetId as GatewayPresetId, entry.baseUrl);
          const oauthProfile = typeof entry.options?.oauthProfile === 'string' ? entry.options.oauthProfile : undefined;
          const accountRouting = typeof entry.options?.accountRouting === 'string' ? entry.options.accountRouting : undefined;
          const apiKeyConfigured = typeof entry.options?.apiKeyConfigured === 'boolean' ? entry.options.apiKeyConfigured : undefined;
          const credentialHeader = typeof entry.options?.credentialHeader === 'string' ? entry.options.credentialHeader : undefined;
          const credentialPrefix = typeof entry.options?.credentialPrefix === 'string' ? entry.options.credentialPrefix : undefined;
          const proxyUrl = typeof entry.options?.proxyUrl === 'string' ? entry.options.proxyUrl : undefined;
          const next: LLMProviderEntry = {
            ...entry,
            baseUrl: preset.baseUrl,
            spec: {
              thinking: entry.spec?.thinking ?? true,
              ...entry.spec,
              model: entry.spec?.model || preset.model,
            },
            options: {
              ...preset.options,
              ...(oauthProfile ? { oauthProfile } : {}),
              ...(accountRouting ? { accountRouting } : {}),
              ...(apiKeyConfigured !== undefined ? { apiKeyConfigured } : {}),
              ...(credentialHeader ? { credentialHeader } : {}),
              ...(credentialPrefix ? { credentialPrefix } : {}),
              ...(proxyUrl ? { proxyUrl } : {}),
            },
          };
          configuration(next);
          host.save(name, next);
          const control = host.instance(name).control as GatewayInstanceControl;
          return asGatewayState(next, control.oauth.authEnabled(next));
        }
        if (method === 'save-options') {
          const currentCfg = configuration(entry);
          const nextProtocol = (raw.protocol !== undefined ? raw.protocol : currentCfg.protocol) as GatewayProtocol;
          const protocolChanged = raw.protocol !== undefined && raw.protocol !== currentCfg.protocol;
          const preset = presetEntryPatch(nextProtocol, entry.baseUrl);

          const nextOptions: Record<string, unknown> = protocolChanged
            ? {
                ...preset.options,
                ...(typeof entry.options?.oauthProfile === 'string' ? { oauthProfile: entry.options.oauthProfile } : {}),
                ...(typeof entry.options?.accountRouting === 'string' ? { accountRouting: entry.options.accountRouting } : {}),
                ...(typeof entry.options?.apiKeyConfigured === 'boolean' ? { apiKeyConfigured: entry.options.apiKeyConfigured } : {}),
                ...(typeof entry.options?.credentialHeader === 'string' ? { credentialHeader: entry.options.credentialHeader } : {}),
                ...(typeof entry.options?.credentialPrefix === 'string' ? { credentialPrefix: entry.options.credentialPrefix } : {}),
                ...(typeof entry.options?.proxyUrl === 'string' ? { proxyUrl: entry.options.proxyUrl } : {}),
              }
            : { ...entry.options };

          if (raw.protocol !== undefined) nextOptions.protocol = raw.protocol;
          if (raw.authMode !== undefined) nextOptions.authMode = raw.authMode;
          if (raw.temporaryChat !== undefined) nextOptions.temporaryChat = raw.temporaryChat;
          if (raw.proxyUrl !== undefined) {
            if (typeof raw.proxyUrl !== 'string') throw new Error('Option proxyUrl must be a string');
            const normalizedProxy = parseProxyUrlInput(raw.proxyUrl);
            if (normalizedProxy) nextOptions.proxyUrl = normalizedProxy;
            else delete nextOptions.proxyUrl;
          }
          for (const key of STRING_OPTION_KEYS) {
            if (raw[key] === undefined) continue;
            if (typeof raw[key] !== 'string') throw new Error(`Option ${key} must be a string`);
            const trimmed = (raw[key] as string).trim();
            if (trimmed) nextOptions[key] = trimmed;
            else delete nextOptions[key];
          }

          let nextBaseUrl = entry.baseUrl;
          if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim() && nextProtocol !== 'robin') {
            nextBaseUrl = httpUrl(raw.baseUrl.trim()).href.replace(/\/+$/, '');
          } else if (protocolChanged || nextProtocol === 'robin') {
            nextBaseUrl = resolveAutoBaseUrl(nextProtocol, entry.baseUrl);
          }

          const next: LLMProviderEntry = { ...entry, baseUrl: nextBaseUrl, options: nextOptions };
          const nextCfg = configuration(next);
          host.save(name, next);
          const control = host.instance(name).control as GatewayInstanceControl;
          control.oauth.setProxyUrl(nextCfg.proxyUrl);
          return asGatewayState(next, control.oauth.authEnabled(next));
        }
        if (method === 'test') {
          const started = Date.now();
          const cfg = configuration(entry);
          const control = host.instance(name).control as GatewayInstanceControl;
          control.oauth.setProxyUrl(cfg.proxyUrl);
          const proxyNote = cfg.proxyUrl
            ? (en ? ` · via ${maskProxyDisplay(cfg.proxyUrl)}` : ` · 经代理 ${maskProxyDisplay(cfg.proxyUrl)}`)
            : '';
          if (cfg.protocol === 'robin') {
            const quota = await control.queryQuota();
            if (quota.authRequired) {
              return {
                ok: false,
                elapsedMs: Date.now() - started,
                summary: en ? 'Sign in with Browser OAuth below first.' : '请先在下方完成浏览器 OAuth 认证。',
              };
            }
            const accounts = quota.accounts ?? [];
            const okCount = accounts.filter(a => !a.error).length;
            if (accounts.length > 0 && okCount === 0) {
              return {
                ok: false,
                elapsedMs: Date.now() - started,
                summary: accounts[0].error || (en ? 'All accounts failed quota check.' : '全部账号连接检测均失败。'),
              };
            }
            const plan = quota.plan ? ` · ${quota.plan}` : '';
            const poolNote = accounts.length > 1
              ? (en ? ` · ${okCount}/${accounts.length} accounts ready` : ` · ${okCount}/${accounts.length} 个账号可用`)
              : '';
            return {
              ok: true,
              elapsedMs: Date.now() - started,
              summary: en
                ? `Connected (Robin HTTP/2 gRPC${plan}${poolNote}${proxyNote})`
                : `连接正常（Robin HTTP/2 gRPC${plan}${poolNote}${proxyNote}）`,
            };
          }
          if (cfg.authMode === 'api-key') {
            const keyInfo = control.apiKeyStatus();
            if (!keyInfo.configured) {
              return {
                ok: false,
                elapsedMs: Date.now() - started,
                summary: en ? 'Enter an API Key in Step 2 first.' : '请先在第二步填写并保存 API Key。',
              };
            }
            return {
              ok: true,
              elapsedMs: Date.now() - started,
              summary: en
                ? `Configuration valid (${cfg.protocol.toUpperCase()} · API Key ready${proxyNote} -> ${entry.baseUrl})`
                : `配置有效（${cfg.protocol.toUpperCase()} · API Key 已就绪${proxyNote} -> ${entry.baseUrl}）`,
            };
          }
          return {
            ok: true,
            elapsedMs: Date.now() - started,
            summary: en
              ? `Configuration valid (${cfg.protocol.toUpperCase()}${proxyNote} -> ${entry.baseUrl})`
              : `配置有效（${cfg.protocol.toUpperCase()}${proxyNote} -> ${entry.baseUrl}）`,
          };
        }
        throw new Error(en ? 'Unknown gateway action' : '未知配置操作');
      }

      if (panel === 'quota') {
        entry = ensureDraftDefaults(name, entry);
        const control = host.instance(name).control as GatewayInstanceControl;
        if (method === 'query') {
          const accountId = typeof raw.accountId === 'string' && raw.accountId.trim() ? raw.accountId.trim() : undefined;
          return control.queryQuota(undefined, accountId);
        }
        if (method === 'account-labels') {
          return {
            emailsMasked: control.oauth.isEmailsMasked(),
            quotaBarMode: control.oauth.getQuotaBarMode(),
            accountRouting: configuration(entry).accountRouting,
            accountOptions: control.oauth.listAccountOptions(),
          };
        }
        if (method === 'set-mask') {
          if (typeof raw.masked !== 'boolean') {
            throw new Error(en ? 'Invalid email masking value.' : '无效的脱敏开关参数。');
          }
          const emailsMasked = control.oauth.setEmailsMasked(raw.masked);
          return {
            emailsMasked,
            quotaBarMode: control.oauth.getQuotaBarMode(),
            accountRouting: configuration(entry).accountRouting,
            accountOptions: control.oauth.listAccountOptions(),
          };
        }
        if (method === 'set-bar-mode') {
          if (raw.mode !== 'remaining' && raw.mode !== 'used') {
            throw new Error(en ? 'Invalid quota bar display mode.' : '无效的额度显示模式参数。');
          }
          const quotaBarMode = control.oauth.setQuotaBarMode(raw.mode);
          return {
            emailsMasked: control.oauth.isEmailsMasked(),
            quotaBarMode,
            accountRouting: configuration(entry).accountRouting,
            accountOptions: control.oauth.listAccountOptions(),
          };
        }
        if (method === 'routes-state') {
          return asCustomRoutesState(entry);
        }
        if (method === 'save-routes') {
          const nextOptions: Record<string, unknown> = { ...entry.options };
          const routeKeys = ['generationEndpoint', 'uploadEndpoint', 'deleteEndpoint', 'conversationHeader', 'quotaEndpoint'] as const;
          for (const key of routeKeys) {
            if (raw[key] === undefined) continue;
            if (typeof raw[key] !== 'string') throw new Error(`Option ${key} must be a string`);
            const trimmed = (raw[key] as string).trim();
            if (trimmed) nextOptions[key] = trimmed;
            else delete nextOptions[key];
          }
          const next: LLMProviderEntry = { ...entry, options: nextOptions };
          configuration(next);
          host.save(name, next);
          return asCustomRoutesState(next);
        }
        throw new Error(en ? 'Unknown quota action' : '未知额度操作');
      }

      // panel === 'auth'
      if (method === 'status') {
        entry = ensureDraftDefaults(name, entry);
        const control = host.instance(name).control as GatewayInstanceControl;
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'oauth-config') {
        entry = ensureDraftDefaults(name, entry);
        const control = host.instance(name).control as GatewayInstanceControl;
        return control.oauth.readOAuthConfigText();
      }
      if (method === 'save-oauth-config') {
        if (typeof raw.json !== 'string' || raw.json.length > 64 * 1024) {
          throw new Error(en ? 'OAuth JSON is invalid or too large' : 'OAuth 配置 JSON 格式无效或过大');
        }
        if (name === 'draft') entry = ensureDraftDefaults(name, entry);
        const control = host.instance(name).control as GatewayInstanceControl;
        control.oauth.saveOAuthConfig(raw.json);
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'reset-oauth-config') {
        const control = host.instance(name).control as GatewayInstanceControl;
        control.oauth.resetOAuthConfig();
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'login') {
        if (host.editing && !entry.options?.oauthProfile && name === 'draft') {
          entry = ensureDraftDefaults(name, entry);
        }
        const control = host.instance(name).control as GatewayInstanceControl;
        control.oauth.setProxyUrl(configuration(entry).proxyUrl);
        control.oauth.refreshBundledConfig();
        if (!control.status().configured) {
          throw new Error(
            en
              ? 'Paste your desktop-oauth.json (with clientId) in OAuth client configuration below and click Save before signing in.'
              : '请先在下方「OAuth 客户端配置 (desktop-oauth.json)」填入有效配置并点击「保存 OAuth 配置」，再进行浏览器登录。',
          );
        }
        const targetAccountId = typeof raw.targetAccountId === 'string' && raw.targetAccountId.trim()
          ? raw.targetAccountId.trim()
          : undefined;
        const forceAccountSelect = raw.forceAccountSelect === true;
        const started = await control.oauth.auth.startLogin(undefined, {
          ...(targetAccountId ? { targetAccountId } : {}),
          ...(forceAccountSelect ? { forceAccountSelect: true } : {}),
        });
        return { ...started, status: asAuthStatus(control, entry, !host.editing) };
      }
      if (method === 'complete-login') {
        if (typeof raw.redirectUrl !== 'string' || !raw.redirectUrl.trim()) {
          throw new Error(en ? 'Paste the callback URL from your browser address bar.' : '请粘贴浏览器地址栏里的回调地址。');
        }
        const control = host.instance(name).control as GatewayInstanceControl;
        control.oauth.setProxyUrl(configuration(entry).proxyUrl);
        await control.oauth.auth.completeLogin(raw.redirectUrl);
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'cancel-login') {
        const control = host.instance(name).control as GatewayInstanceControl;
        control.oauth.auth.cancelLogin();
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'set-primary') {
        const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : '';
        if (!accountId) throw new Error(en ? 'Select an account to set as primary.' : '请指定要设为主用的账号。');
        const control = host.instance(name).control as GatewayInstanceControl;
        control.oauth.auth.setPrimaryAccount(accountId);
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'set-routing') {
        const routing = raw.routing;
        if (routing !== 'failover' && routing !== 'round-robin' && routing !== 'least-used') {
          throw new Error(en ? 'Invalid account routing strategy.' : '无效的多账号调度策略。');
        }
        entry = ensureDraftDefaults(name, entry);
        const next: LLMProviderEntry = {
          ...entry,
          options: { ...entry.options, accountRouting: routing },
        };
        configuration(next);
        host.save(name, next);
        const control = host.instance(name).control as GatewayInstanceControl;
        return asAuthStatus(control, next, !host.editing);
      }
      if (method === 'set-mask') {
        if (typeof raw.masked !== 'boolean') {
          throw new Error(en ? 'Invalid email masking value.' : '无效的脱敏开关参数。');
        }
        const control = host.instance(name).control as GatewayInstanceControl;
        control.oauth.setEmailsMasked(raw.masked);
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'refresh-quotas') {
        entry = ensureDraftDefaults(name, entry);
        const control = host.instance(name).control as GatewayInstanceControl;
        await control.queryQuota().catch(() => null);
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'save-api-key') {
        entry = ensureDraftDefaults(name, entry);
        const control = host.instance(name).control as GatewayInstanceControl;
        const nextOptions: Record<string, unknown> = { ...entry.options };
        if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
          control.oauth.saveApiKey(raw.apiKey);
          nextOptions.apiKeyConfigured = true;
        }
        if (typeof raw.credentialHeader === 'string') {
          const header = raw.credentialHeader.trim();
          if (header && header !== 'x-goog-api-key') nextOptions.credentialHeader = header;
          else delete nextOptions.credentialHeader;
        }
        if (typeof raw.credentialPrefix === 'string') {
          if (raw.credentialPrefix) nextOptions.credentialPrefix = raw.credentialPrefix;
          else delete nextOptions.credentialPrefix;
        }
        const next: LLMProviderEntry = { ...entry, options: nextOptions };
        if (typeof raw.secretVar === 'string') {
          const sec = raw.secretVar.trim();
          if (sec) next.secret = sec;
          else delete next.secret;
        }
        configuration(next);
        host.save(name, next);
        const refreshed = host.instance(name).control as GatewayInstanceControl;
        return asAuthStatus(refreshed, next, !host.editing);
      }
      if (method === 'clear-api-key') {
        entry = ensureDraftDefaults(name, entry);
        const control = host.instance(name).control as GatewayInstanceControl;
        control.oauth.removeApiKey();
        const nextOptions: Record<string, unknown> = { ...entry.options };
        delete nextOptions.apiKeyConfigured;
        const next: LLMProviderEntry = { ...entry, options: nextOptions };
        configuration(next);
        host.save(name, next);
        const refreshed = host.instance(name).control as GatewayInstanceControl;
        return asAuthStatus(refreshed, next, !host.editing);
      }
      if (method === 'logout') {
        const control = host.instance(name).control as GatewayInstanceControl;
        const accountId = typeof raw.accountId === 'string' && raw.accountId.trim() ? raw.accountId.trim() : undefined;
        if (accountId) {
          control.oauth.auth.removeAccount(accountId);
          control.oauth.removeAccountState(accountId);
        } else {
          control.oauth.auth.logout();
          control.oauth.clearRobinCache();
        }
        return asAuthStatus(control, entry, !host.editing);
      }
      if (method === 'accept-terms') {
        const control = host.instance(name).control as GatewayInstanceControl;
        const accountId = typeof raw.accountId === 'string' && raw.accountId.trim() ? raw.accountId.trim() : undefined;
        const result = await control.acceptTerms('en', undefined, accountId);
        return { ...result, status: asAuthStatus(control, entry, !host.editing) };
      }
      throw new Error(en ? 'Unknown auth action' : '未知认证操作');
    },
  };
}
