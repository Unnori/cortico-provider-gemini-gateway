import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { AccountRoutingMode, AuthMode } from '../options.ts';
import type { AccountQuotaSnapshot, QuotaSnapshot, QuotaWindow } from '../quota.ts';
import { maskEmail } from '../redact.ts';
import type { GatewayProtocol } from '../shim.ts';
import { modelSettingsPanel } from './model-panel.ts';
import type {
  AuthAccountItem,
  AuthPanelStatus,
  CustomRoutesState,
  GatewayPanelState,
  GatewayTestResult,
  QuotaAccountLabels,
} from './server.ts';
import './style.css';

const isZh = (ctx: WebUiPanelContext) => ctx.language === 'zh' || ctx.language === 'zh-Hant';

type PanelSyncEvent =
  | { kind: 'mask'; instanceName: string; source: 'auth' | 'quota' }
  | { kind: 'routing'; instanceName: string; routing: AccountRoutingMode }
  | { kind: 'quota'; instanceName: string; source: 'auth' | 'quota' }
  | { kind: 'gateway'; instanceName: string; protocol: GatewayProtocol; authMode: AuthMode; authEnabled: boolean };
const panelSyncListeners = new Set<(ev: PanelSyncEvent) => void>();
function broadcastPanelSync(ev: PanelSyncEvent): void {
  for (const listener of panelSyncListeners) listener(ev);
}

function setPanelTitle(root: HTMLElement, title: string): void {
  const heading = root.closest('details.connection-section')?.querySelector(':scope > summary h3');
  if (heading && heading.textContent !== title) {
    heading.textContent = title;
  }
}

function sortLeastUsed<T>(
  items: readonly T[],
  info: (item: T) => { cooled: boolean; cooldownUntil?: number; fiveHourRemaining?: number; weeklyRemaining?: number },
): T[] {
  return [...items].sort((a, b) => {
    const ia = info(a);
    const ib = info(b);
    if (ia.cooled !== ib.cooled) return ia.cooled ? 1 : -1;
    if (ia.cooled && ib.cooled) return (ia.cooldownUntil ?? 0) - (ib.cooldownUntil ?? 0);
    const exhA = ia.fiveHourRemaining !== undefined && ia.fiveHourRemaining <= 5;
    const exhB = ib.fiveHourRemaining !== undefined && ib.fiveHourRemaining <= 5;
    if (exhA !== exhB) return exhA ? 1 : -1;
    const weekA = ia.weeklyRemaining ?? ia.fiveHourRemaining ?? 50;
    const weekB = ib.weeklyRemaining ?? ib.fiveHourRemaining ?? 50;
    if (weekA !== weekB) return weekB - weekA;
    const fiveA = ia.fiveHourRemaining ?? 50;
    const fiveB = ib.fiveHourRemaining ?? 50;
    return fiveB - fiveA;
  });
}

function safeExternalUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid authorization URL');
  }
  return url.href;
}

function formatDuration(ms: number, zh: boolean): string {
  if (ms <= 0) return zh ? '即将重置' : 'resetting soon';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return zh ? `${mins} 分钟后重置` : `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return zh ? `${hours} 小时 ${mins % 60} 分钟后重置` : `resets in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天 ${hours % 24} 小时后重置` : `resets in ${days}d ${hours % 24}h`;
}

function formatShortExpiry(expiresAt: number | undefined, zh: boolean): string {
  if (!expiresAt) return '—';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return zh ? '令牌待自动续期' : 'Token auto-refreshes';
  const mins = Math.max(1, Math.round(diff / 60_000));
  return zh ? `令牌约 ${mins} 分钟后续期` : `Token ~${mins}m left`;
}

function formatCooldownLeft(until: number | undefined, zh: boolean): string {
  if (!until) return '';
  const diff = until - Date.now();
  if (diff <= 0) return '';
  const mins = Math.max(1, Math.ceil(diff / 60_000));
  return zh ? `冷却 ${mins}m` : `cooldown ${mins}m`;
}

function accountDisplayName(id: string, email: string | undefined, zh: boolean, masked = true): string {
  if (email) return masked ? (maskEmail(email) ?? email) : email;
  const suffix = id.replace(/^acct_/, '').slice(0, 6);
  return zh ? `Google 账号 (${suffix})` : `Account (${suffix})`;
}

const authPanel: WebUiPanel = {
  async mount(ctx) {
    const { ui, root, signal } = ctx;
    const zh = isZh(ctx);
    const t = (cn: string, en: string) => (zh ? cn : en);
    const name = ctx.scope.instance;
    if (!name) {
      root.append(ui.placeholder(t('请先新建或选择一个网关连接。', 'Select or create a gateway connection first.')));
      return;
    }

    root.classList.add('ggw-panel');
    const headerRow = ui.rowbar();
    const pill = ui.pill(t('检查中…', 'Checking…'), 'plain');
    const toggleMaskBtn = ui.button(t('显示账号名', 'Show account names'), {
      size: 'sm',
      onClick: () => void run(async () => {
        const nextMasked = !(state?.emailsMasked ?? true);
        state = await invoke<AuthPanelStatus>('set-mask', { masked: nextMasked });
        broadcastPanelSync({ kind: 'mask', instanceName: name, source: 'auth' });
      }),
    });
    toggleMaskBtn.hidden = true;
    const refreshQuotasBtn = ui.button(t('刷新各号额度', 'Refresh quotas'), {
      size: 'sm',
      onClick: () => void run(async () => {
        state = await invoke<AuthPanelStatus>('refresh-quotas');
        broadcastPanelSync({ kind: 'quota', instanceName: name, source: 'auth' });
        message.textContent = t('已更新账号周额度与 5h 余量。', 'Updated weekly and 5h quotas for all accounts.');
      }),
    });
    refreshQuotasBtn.hidden = true;
    headerRow.append(pill, toggleMaskBtn, refreshQuotasBtn);

    const actions = ui.rowbar();
    const loginBtn = ui.button(t('打开浏览器认证', 'Sign in with Browser'), {
      variant: 'primary',
      onClick: () => void beginLogin({ forceAccountSelect: Boolean(state?.accounts.length) }),
    });
    const viewTermsBtn = ui.button(t('查看服务条款', 'View Terms'), {
      onClick: () => {
        const url = 'https://policies.google.com/terms';
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch {
          // Link below remains clickable as fallback.
        }
      },
    });
    const cancelBtn = ui.button(t('取消等待', 'Cancel'), {
      onClick: () => void run(async () => {
        state = await invoke<AuthPanelStatus>('cancel-login');
        authLink.hidden = true;
        copyRow.hidden = true;
      }),
    });
    const clearAllBtn = ui.button(t('清空全部账号', 'Sign out all'), {
      variant: 'danger',
      onClick: () => void run(async () => {
        state = await invoke<AuthPanelStatus>('logout');
        authLink.hidden = true;
        copyRow.hidden = true;
        message.textContent = t('已清除全部本地 OAuth 账号凭证。', 'Cleared all local OAuth tokens.');
        await ctx.refresh();
      }),
    });
    actions.append(loginBtn, viewTermsBtn, cancelBtn, clearAllBtn);

    const routingSelect = ui.select({
      options: [
        { value: 'failover', label: t('主备故障转移（默认：优先主用号，429/降级自动切备用）', 'Failover (default: primary first, auto-switch on 429)') },
        { value: 'round-robin', label: t('轮询均衡（无主从区分，平等轮流使用健康账号）', 'Round-robin (equal peers, rotate healthy accounts)') },
        { value: 'least-used', label: t('按余量优先（优先使用周额度剩余最多的可用账号）', 'Least-used (highest weekly remaining quota first)') },
      ],
      onChange: value => {
        // Capture selected value BEFORE run() invokes paint() so it is never reset to stale state.
        const routing = value as AccountRoutingMode;
        void run(async () => {
          state = await invoke<AuthPanelStatus>('set-routing', { routing });
          broadcastPanelSync({ kind: 'routing', instanceName: name, routing });
          const needsQuotaFetch = routing !== 'failover'
            && state.signedIn
            && state.accounts.some(a => a.weeklyRemaining === undefined);
          if (needsQuotaFetch) {
            state = await invoke<AuthPanelStatus>('refresh-quotas');
            broadcastPanelSync({ kind: 'quota', instanceName: name, source: 'auth' });
          }
          message.textContent = t(
            '已切换多账号调度策略（请点击页面底部「保存」生效）。',
            'Updated multi-account routing strategy. Click Save below to persist.',
          );
        });
      },
    });
    const routingField = ui.field(t('多账号调度策略', 'Account routing strategy'), routingSelect);
    routingField.hidden = true;
    const routingHint = ui.h('div', 'ggw-routing-hint');
    routingHint.hidden = true;

    const pendingNote = ui.h('div', 'sh-desc');
    pendingNote.hidden = true;

    let currentCopyUrl = '';
    const setCopyUrl = (u: string) => { currentCopyUrl = u; };
    const authLink = ui.h('a', 'ggw-link', t('点击打开浏览器授权页', 'Open authorization page'));
    authLink.target = '_blank';
    authLink.rel = 'noopener noreferrer';
    authLink.hidden = true;
    const copyRow = ui.rowbar();
    copyRow.hidden = true;
    copyRow.append(
      authLink,
      ui.copyButton(() => currentCopyUrl, { label: t('复制授权链接', 'Copy URL') }),
    );

    const manualBox = ui.h('div', 'ggw-manual');
    manualBox.hidden = true;
    const manualInput = ui.input({
      placeholder: 'http://localhost:PORT/?code=...&state=...',
      cls: 'mono',
    });
    const manualBtn = ui.button(t('提交回调地址', 'Submit callback URL'), {
      size: 'sm',
      onClick: () => void run(async () => {
        state = await invoke<AuthPanelStatus>('complete-login', { redirectUrl: manualInput.value });
        manualInput.value = '';
        authLink.hidden = true;
        copyRow.hidden = true;
        message.textContent = t('认证完成并已本地保存，可直接测试连接或对话调用。', 'Authenticated and saved locally; ready to call.');
        await ctx.refresh();
      }),
    });
    const manualRow = ui.rowbar();
    manualRow.append(manualInput, manualBtn);
    manualBox.append(
      ui.h('div', 'sh-desc', t('若浏览器在其他设备或回环回调被拦截，可将授权后地址栏的完整回调 URL 粘贴到此处：', 'If browser callback cannot reach localhost directly, paste the redirected callback URL here:')),
      manualRow,
    );

    const accountsBox = ui.h('div', 'ggw-account-list');
    const infoBox = ui.h('div');

    const termsHint = ui.h('div', 'sh-desc');
    const termsLink = ui.h('a', 'ggw-link', t('Google 服务条款 (policies.google.com/terms)', 'Google Terms of Service'));
    termsLink.href = 'https://policies.google.com/terms';
    termsLink.target = '_blank';
    termsLink.rel = 'noopener noreferrer';
    termsHint.append(
      t('首次通过 Robin 桌面接口调用时，若某个账号提示接受服务条款，可先点击「查看服务条款」（或访问 ', 'If Google requests ToS confirmation on first Robin call for an account, click "View Terms" (or open '),
      termsLink,
      t('），确认无误后再点击该账号卡片上的「同意条款」。', ') and then click "Accept Terms" on that account card.'),
    );
    termsHint.hidden = true;

    const message = ui.msgline();

    const cfgDetails = ui.h('details', 'ggw-details');
    cfgDetails.append(ui.h('summary', '', t('OAuth 客户端配置 (desktop-oauth.json)', 'OAuth client configuration (desktop-oauth.json)')));
    const cfgHint = ui.h('div', 'sh-desc');
    const cfgTextarea = ui.textarea({ rows: 10, cls: 'mono' });
    const cfgActions = ui.rowbar();
    const saveCfgBtn = ui.button(t('保存 OAuth 配置', 'Save OAuth config'), {
      size: 'sm',
      variant: 'primary',
      onClick: () => void run(async () => {
        state = await invoke<AuthPanelStatus>('save-oauth-config', { json: cfgTextarea.value });
        await loadOAuthConfig();
        if (state.configured) cfgDetails.open = false;
        message.textContent = t(
          'OAuth 客户端配置已保存到本地，现在可以点击上方「打开浏览器认证」。',
          'OAuth configuration saved locally. You can now click Sign in with Browser above.',
        );
      }),
    });
    const copyCfgBtn = ui.copyButton(() => cfgTextarea.value, {
      label: t('复制当前配置', 'Copy config'),
    });
    const resetCfgBtn = ui.button(t('清空已保存配置', 'Clear saved config'), {
      size: 'sm',
      onClick: () => void run(async () => {
        state = await invoke<AuthPanelStatus>('reset-oauth-config');
        await loadOAuthConfig();
        message.textContent = state.configured
          ? t('已恢复默认 OAuth 配置。', 'Reset to default OAuth configuration.')
          : t('已清空本地 OAuth 配置，请填入有效 JSON 后重新保存。', 'Cleared saved OAuth config. Paste a valid JSON below and save.');
      }),
    });
    cfgActions.append(saveCfgBtn, copyCfgBtn, resetCfgBtn);
    cfgDetails.append(cfgHint, cfgTextarea, cfgActions);

    let cfgLoaded = false;
    let autoOpenedCfg = false;
    async function loadOAuthConfig() {
      const cfg = await invoke<{ text: string; custom: boolean }>('oauth-config');
      if (signal.aborted) return;
      cfgTextarea.value = cfg.text;
      cfgHint.textContent = cfg.custom
        ? t(
          '当前使用此端点本地保存的 desktop-oauth.json。如需备份或分享给其他用户，可点击「复制当前配置」。',
          'Using local desktop-oauth.json saved for this endpoint. Click Copy config to export or share.',
        )
        : t(
          '本扩展不内置 OAuth 客户端凭据。请将完整的 desktop-oauth.json（含 clientId / clientSecret）粘贴到下方并点击「保存 OAuth 配置」；或先在第一步切换至「Web2API Gemini」使用官方 API Key。',
          'No OAuth credentials are bundled in this package. Paste your desktop-oauth.json (with clientId / clientSecret) below and click Save, or switch Step 1 to Web2API Gemini with an API Key.',
        );
      cfgLoaded = true;
    }
    cfgDetails.addEventListener('toggle', () => {
      if (cfgDetails.open && !cfgLoaded) void loadOAuthConfig().catch(err => {
        message.textContent = String(err);
        message.classList.add('bad');
      });
    }, { signal });

    const oauthSection = ui.h('div', 'ggw-section');
    oauthSection.append(actions, routingField, routingHint, pendingNote, copyRow, manualBox, accountsBox, infoBox, termsHint, cfgDetails);

    // API Key configuration section (shown automatically in Web2API Gemini / Custom RPC api-key modes)
    const apiKeySection = ui.h('div', 'ggw-section');
    apiKeySection.hidden = true;
    const apiKeyDesc = ui.h('div', 'sh-desc');
    const apiKeyInput = ui.input({
      type: 'password',
      cls: 'mono',
      placeholder: t('粘贴 API Key（例如 AIzaSy... 或 sk-...）', 'Paste API Key (e.g. AIzaSy... or sk-...)'),
    });
    const apiKeyField = ui.field(t('API Key', 'API Key'), apiKeyInput);

    const headerPresetSelect = ui.select({
      options: [
        { value: 'goog', label: t('x-goog-api-key（Gemini / Web2API 原生默认）', 'x-goog-api-key (Gemini / Web2API default)') },
        { value: 'bearer', label: t('Authorization: Bearer <Key>（通用代理网关）', 'Authorization: Bearer <Key> (Bearer proxy)') },
        { value: 'custom', label: t('自定义请求头与前缀', 'Custom header & prefix') },
      ],
      onChange: value => {
        if (value === 'goog') {
          credHeaderInput.value = 'x-goog-api-key';
          credPrefixInput.value = '';
        } else if (value === 'bearer') {
          credHeaderInput.value = 'Authorization';
          credPrefixInput.value = 'Bearer ';
        }
        customCredGrid.hidden = value !== 'custom' && state?.protocol !== 'rpc';
      },
    });
    const headerPresetField = ui.field(t('密钥请求头格式', 'Credential header format'), headerPresetSelect);

    const credHeaderInput = ui.input({ cls: 'mono', placeholder: 'x-goog-api-key' });
    const credPrefixInput = ui.input({ cls: 'mono', placeholder: 'Bearer ' });
    const customCredGrid = ui.h('div', 'ggw-two-col');
    customCredGrid.append(
      ui.field(t('请求头名称 (credentialHeader)', 'Header name (credentialHeader)'), credHeaderInput),
      ui.field(t('密钥前缀 (credentialPrefix)', 'Key prefix (credentialPrefix)'), credPrefixInput),
    );
    customCredGrid.hidden = true;

    const apiKeyActions = ui.rowbar();
    const saveApiKeyBtn = ui.button(t('保存 API Key', 'Save API Key'), {
      size: 'sm',
      variant: 'primary',
      onClick: () => void run(async () => {
        const typedKey = apiKeyInput.value.trim();
        if (!typedKey && !state?.apiKeyConfigured && !secretVarInput.value.trim()) {
          throw new Error(t('请先输入 API Key 或填写环境变量名。', 'Enter an API Key or .env variable name first.'));
        }
        state = await invoke<AuthPanelStatus>('save-api-key', {
          ...(typedKey ? { apiKey: typedKey } : {}),
          credentialHeader: credHeaderInput.value,
          credentialPrefix: credPrefixInput.value,
          secretVar: secretVarInput.value,
        });
        apiKeyInput.value = '';
        message.textContent = typedKey
          ? t('API Key 已本地保存（请点击页面底部「保存」以同步端点配置）。', 'API Key saved locally. Click Save below to persist endpoint options.')
          : t('鉴权请求头设置已同步（请点击页面底部「保存」生效）。', 'Credential header options synced. Click Save below to persist.');
        await ctx.refresh();
      }),
    });
    const clearApiKeyBtn = ui.button(t('清除本地密钥', 'Clear saved key'), {
      size: 'sm',
      variant: 'danger',
      onClick: () => void run(async () => {
        state = await invoke<AuthPanelStatus>('clear-api-key');
        apiKeyInput.value = '';
        message.textContent = t('已清除本地保存的 API Key（请点击页面底部「保存」生效）。', 'Cleared saved API Key. Click Save below to persist.');
        await ctx.refresh();
      }),
    });
    clearApiKeyBtn.hidden = true;
    apiKeyActions.append(saveApiKeyBtn, clearApiKeyBtn);

    const envDetails = ui.h('details', 'ggw-details');
    envDetails.append(ui.h('summary', '', t('高级：改用 .env 环境变量名（可选）', 'Advanced: use .env secret variable name (optional)')));
    const secretVarInput = ui.input({ cls: 'mono', placeholder: 'GEMINI_API_KEY' });
    envDetails.append(
      ui.h('div', 'sh-desc', t('如希望由端点目录 .env 文件提供密钥，可填写变量名；上方直接填入的 API Key 优先。', 'Optionally reference a variable in the endpoint .env file; a directly saved API Key above takes precedence.')),
      ui.field(t('密钥环境变量名 (secret)', 'Secret env variable (secret)'), secretVarInput),
    );

    apiKeySection.append(apiKeyDesc, apiKeyField, headerPresetField, customCredGrid, apiKeyActions, envDetails);

    root.append(headerRow, oauthSection, apiKeySection, message);

    let state: AuthPanelStatus | undefined;
    let working = false;
    let polling = false;
    let wasSignedIn = false;
    let wasPending = false;
    let wasAccountCount = 0;
    let accountsFingerprint = '';
    let lastApiKeyFormKey = '';

    async function invoke<T = unknown>(method: string, values: Record<string, unknown> = {}): Promise<T> {
      return ctx.invoke<T>(method, [{ name, ...values }]);
    }

    async function beginLogin(opts: { targetAccountId?: string; forceAccountSelect?: boolean } = {}) {
      await run(async () => {
        const res = await invoke<{ url: string; redirectUri: string; status: AuthPanelStatus }>('login', opts);
        if (signal.aborted) return;
        state = res.status;
        const safeUrl = safeExternalUrl(res.url);
        authLink.href = safeUrl;
        authLink.hidden = false;
        setCopyUrl(safeUrl);
        copyRow.hidden = false;
        if (opts.targetAccountId) {
          message.textContent = t(
            '已请求打开浏览器重新认证该账号；若未自动弹出，可点击下方链接或复制地址打开。',
            'Opening your browser to re-authenticate this account. Use the link or copy button below if needed.',
          );
        } else if (opts.forceAccountSelect) {
          message.textContent = t(
            '已请求打开浏览器添加新账号，请在 Google 页面选择要新增的账号；若未自动弹出，可点击下方链接。',
            'Opening your browser to add another account. Pick the account to add in Google sign-in.',
          );
        } else {
          message.textContent = t(
            '已请求打开系统浏览器，请完成授权；若未自动弹出，可点击下方链接或复制地址打开。',
            'Opening your browser for authorization. If nothing opened, use the link or copy button below.',
          );
        }
        try {
          window.open(safeUrl, '_blank', 'noopener,noreferrer');
        } catch {
          // Link + copy button remain visible as fallback.
        }
      });
    }

    function renderInlineWeeklyQuota(acct: AuthAccountItem, routing: AccountRoutingMode): HTMLElement {
      const box = ui.h('div', 'ggw-acct-quota');
      const head = ui.h('div', 'ggw-acct-quota-head');
      const lbl = ui.h(
        'span',
        'ggw-qbar-lbl',
        routing === 'least-used' ? t('周额度余量（调度依据）', 'Weekly quota left (priority)') : t('每周额度', 'Weekly quota'),
      );
      if (acct.weeklyRemaining === undefined) {
        const val = ui.h('span', 'ggw-acct-quota-sub', t('待查询（点「刷新各号额度」获取）', 'Not loaded yet'));
        head.append(lbl, val);
        box.append(head);
        return box;
      }
      const remaining = Math.min(Math.max(acct.weeklyRemaining, 0), 100);
      const used = Math.round((100 - remaining) * 10) / 10;
      const tone = remaining <= 10 ? 'bad' : remaining <= 25 ? 'warn' : '';
      const val = ui.h('span', tone ? `ggw-acct-quota-main ${tone}` : 'ggw-acct-quota-main', t(`周剩余 ${remaining}%`, `${remaining}% left`));
      head.append(lbl, val);

      const track = ui.h('div', 'ggw-qbar-track');
      const fill = ui.h('div', tone ? `ggw-qbar-fill ${tone}` : 'ggw-qbar-fill');
      // In least-used / round-robin weekly bar, show used bar consistent with Step 3 (or remaining? Keep consistent used fill + clear text!).
      fill.style.width = `${used}%`;
      track.append(fill);

      const subParts: string[] = [t(`已用 ${used}%`, `${used}% used`)];
      if (acct.fiveHourRemaining !== undefined) {
        subParts.push(t(`5h 剩余 ${acct.fiveHourRemaining}%`, `5h left ${acct.fiveHourRemaining}%`));
      }
      if (acct.weeklyResetsAt) {
        const resetMs = Date.parse(acct.weeklyResetsAt) - Date.now();
        if (Number.isFinite(resetMs)) subParts.push(formatDuration(resetMs, zh));
      }
      const sub = ui.h('div', 'ggw-acct-quota-sub', subParts.join(' · '));
      box.append(head, track, sub);
      return box;
    }

    function renderAccountCard(
      acct: AuthAccountItem,
      protocol: AuthPanelStatus['protocol'],
      masked: boolean,
      routing: AccountRoutingMode,
      index: number,
      isTopPriority: boolean,
    ): HTMLElement {
      const highlight = routing === 'failover' ? acct.isPrimary : (routing === 'least-used' && isTopPriority);
      const card = ui.h('div', highlight ? 'ggw-account-card is-primary' : 'ggw-account-card');

      const head = ui.h('div', 'ggw-account-head');
      const ident = ui.h('div', 'ggw-account-ident');
      const display = accountDisplayName(acct.id, acct.email, zh, masked);
      const emailEl = ui.h('span', 'ggw-account-email', display);
      emailEl.title = display;
      ident.append(emailEl);

      const leftTags = ui.h('span', 'ggw-tags');
      if (routing === 'failover') {
        leftTags.append(
          acct.isPrimary
            ? ui.h('span', 'ggw-tag primary', t('主用', 'Primary'))
            : ui.h('span', 'ggw-tag', t('备用', 'Backup')),
        );
      } else if (routing === 'round-robin') {
        leftTags.append(ui.h('span', 'ggw-tag', t(`轮询 #${index + 1}`, `Pool #${index + 1}`)));
      } else if (isTopPriority) {
        leftTags.append(ui.h('span', 'ggw-tag primary', t('当前优先', 'Next up')));
      } else {
        leftTags.append(ui.h('span', 'ggw-tag', t(`余量 #${index + 1}`, `Rank #${index + 1}`)));
      }
      if (acct.plan) {
        leftTags.append(ui.h('span', 'ggw-tag plan', acct.plan));
      }
      ident.append(leftTags);

      const rightTags = ui.h('span', 'ggw-tags');
      if (routing === 'least-used' && acct.weeklyRemaining !== undefined) {
        const tone = acct.weeklyRemaining <= 10 ? 'bad' : acct.weeklyRemaining <= 25 ? 'warn' : 'primary';
        rightTags.append(ui.h('span', `ggw-tag ${tone}`, t(`周余 ${acct.weeklyRemaining}%`, `${acct.weeklyRemaining}% wk`)));
      }
      if (protocol === 'robin') {
        if (acct.termsStatus === 'required') {
          const tosTag = ui.h('span', 'ggw-tag bad', t('未同意条款', 'Terms required'));
          tosTag.title = t('调用时返回未同意服务条款，请点击「同意条款」完成确认', 'Upstream reported Terms of Service not accepted yet; click Accept Terms');
          rightTags.append(tosTag);
        } else if (acct.termsStatus === 'pending') {
          const tosTag = ui.h('span', 'ggw-tag warn', t('待同意条款', 'Terms pending'));
          tosTag.title = t('新导入账号，建议点击「同意条款」确认服务条款（或首次成功调用后自动标记已同意）', 'Newly added account; click Accept Terms or confirm automatically on first successful call');
          rightTags.append(tosTag);
        } else {
          const tosTag = ui.h('span', 'ggw-tag ok', t('已同意条款', 'Terms accepted'));
          if (acct.termsVersion !== undefined) {
            tosTag.title = t(`已确认 Gemini 服务条款 v${acct.termsVersion}`, `Accepted Gemini Terms v${acct.termsVersion}`);
          }
          rightTags.append(tosTag);
        }
      }
      const cdText = formatCooldownLeft(acct.cooldownUntil, zh);
      if (cdText) {
        const cdTag = ui.h('span', 'ggw-tag warn', cdText);
        if (acct.cooldownReason) cdTag.title = acct.cooldownReason;
        rightTags.append(cdTag);
      } else {
        rightTags.append(ui.h('span', 'ggw-tag ok', t('就绪', 'Ready')));
      }
      head.append(ident, rightTags);

      const meta = ui.h('div', 'ggw-account-meta');
      meta.append(ui.h('span', '', formatShortExpiry(acct.expiresAt, zh)));
      if (routing === 'failover') {
        if (acct.weeklyRemaining !== undefined) {
          meta.append(ui.h('span', 'mono', t(`周剩余 ${acct.weeklyRemaining}%`, `Weekly left ${acct.weeklyRemaining}%`)));
        }
        if (acct.fiveHourRemaining !== undefined) {
          meta.append(ui.h('span', 'mono', t(`5h 剩余 ${acct.fiveHourRemaining}%`, `5h left ${acct.fiveHourRemaining}%`)));
        }
      }

      const cardActions = ui.h('div', 'ggw-account-actions');
      if (routing === 'failover' && !acct.isPrimary) {
        const setPrimaryBtn = ui.button(t('设为主用', 'Set primary'), {
          size: 'sm',
          variant: 'primary',
          onClick: () => void run(async () => {
            state = await invoke<AuthPanelStatus>('set-primary', { accountId: acct.id });
            message.textContent = t(`已将 ${display} 设为主用账号。`, `Set ${display} as primary account.`);
            await ctx.refresh();
          }),
        });
        setPrimaryBtn.disabled = working;
        cardActions.append(setPrimaryBtn);
      }
      if (protocol === 'robin' && acct.termsStatus !== 'accepted') {
        const termsBtn = ui.button(t('同意条款', 'Accept Terms'), {
          size: 'sm',
          ...(acct.termsStatus === 'required' ? { variant: 'primary' as const } : {}),
          onClick: () => void run(async () => {
            const res = await invoke<{ accepted: boolean; version: number; acceptedAt: string; status: AuthPanelStatus }>(
              'accept-terms',
              { accountId: acct.id },
            );
            if (signal.aborted) return;
            state = res.status;
            message.textContent = t(
              `已为 ${display} 确认 Gemini 服务条款（版本 v${res.version}）。`,
              `Confirmed Gemini Terms of Service (v${res.version}) for ${display}.`,
            );
          }),
        });
        termsBtn.disabled = working;
        cardActions.append(termsBtn);
      }
      const reauthBtn = ui.button(t('重新认证', 'Re-auth'), {
        size: 'sm',
        onClick: () => void beginLogin({ targetAccountId: acct.id, forceAccountSelect: true }),
      });
      reauthBtn.disabled = working || !state?.configured;
      const removeBtn = ui.button(t('移除', 'Remove'), {
        size: 'sm',
        variant: 'danger',
        onClick: () => void run(async () => {
          state = await invoke<AuthPanelStatus>('logout', { accountId: acct.id });
          message.textContent = t(`已移除账号 ${display}。`, `Removed account ${display}.`);
          await ctx.refresh();
        }),
      });
      removeBtn.disabled = working;
      cardActions.append(reauthBtn, removeBtn);

      card.append(head);
      if (routing !== 'failover') {
        card.append(renderInlineWeeklyQuota(acct, routing));
      }
      card.append(meta);
      if (acct.cooldownReason || acct.lastError) {
        card.append(ui.h('div', 'ggw-account-err', acct.cooldownReason || acct.lastError || ''));
      }
      card.append(cardActions);
      return card;
    }

    function paint() {
      if (!state) return;
      const count = state.accounts.length;
      const isApiKeyMode = !state.authEnabled;
      oauthSection.hidden = isApiKeyMode;
      apiKeySection.hidden = !isApiKeyMode;

      if (isApiKeyMode) {
        setPanelTitle(
          root,
          state.protocol === 'rpc'
            ? t('自定义鉴权与 API 密钥', 'Custom Auth & API Key')
            : t('API 密钥配置', 'API Key'),
        );
        if (state.apiKeyConfigured) {
          const hintSuffix = state.apiKeyHint ? `（${state.apiKeyHint}）` : '';
          pill.textContent = state.apiKeySource === 'env'
            ? t(`API Key 已就绪（环境变量）${hintSuffix}`, `API Key ready (env)${hintSuffix}`)
            : t(`API Key 已保存${hintSuffix}`, `API Key saved${hintSuffix}`);
          pill.className = 'pill on';
        } else {
          pill.textContent = t('待填写 API Key', 'API Key required');
          pill.className = 'pill off';
        }

        toggleMaskBtn.hidden = true;
        refreshQuotasBtn.hidden = true;
        apiKeyDesc.textContent = state.protocol === 'rpc'
          ? t('输入自建 RPC 网关的 API Key，并按需自定义鉴权请求头与前缀。密钥以 0600 权限保存于本地目录，不写入 config.json。', 'Enter the API Key for your custom RPC gateway and customize the auth header/prefix as needed.')
          : t('直接粘贴你的 Gemini / Web2API 密钥并点击保存。密钥以 0600 权限保存在本地目录，不会写入明文 config.json。', 'Paste your Gemini or Web2API API Key and click Save. Stored locally with 0600 permissions.');
        apiKeyInput.placeholder = state.apiKeyConfigured
          ? t(`已配置（${state.apiKeyHint ?? '***'}），输入新密钥可覆盖`, `Configured (${state.apiKeyHint ?? '***'}); type a new key to replace`)
          : t('粘贴 API Key（例如 AIzaSy... 或 sk-...）', 'Paste API Key (e.g. AIzaSy... or sk-...)');
        saveApiKeyBtn.disabled = working;
        clearApiKeyBtn.disabled = working;
        clearApiKeyBtn.hidden = state.apiKeySource !== 'stored';

        const nextFormKey = JSON.stringify([state.protocol, state.credentialHeader, state.credentialPrefix, state.secretVar ?? '']);
        if (!working && nextFormKey !== lastApiKeyFormKey) {
          lastApiKeyFormKey = nextFormKey;
          credHeaderInput.value = state.credentialHeader;
          credPrefixInput.value = state.credentialPrefix;
          secretVarInput.value = state.secretVar ?? '';
          const preset = state.credentialHeader === 'x-goog-api-key' && state.credentialPrefix === ''
            ? 'goog'
            : state.credentialHeader.toLowerCase() === 'authorization' && state.credentialPrefix === 'Bearer '
              ? 'bearer'
              : 'custom';
          headerPresetSelect.value = preset;
          customCredGrid.hidden = preset !== 'custom' && state.protocol !== 'rpc';
        }
        wasSignedIn = state.signedIn;
        wasPending = state.pending;
        wasAccountCount = count;
        return;
      }

      setPanelTitle(root, t('浏览器 OAuth 认证', 'Browser OAuth'));
      if (!state.configured) {
        pill.textContent = t('待填写 OAuth 配置', 'OAuth config required');
        pill.className = 'pill off';
        if (!autoOpenedCfg) {
          autoOpenedCfg = true;
          cfgDetails.open = true;
          if (!cfgLoaded) void loadOAuthConfig().catch(() => {});
        }
      } else if (count > 1) {
        pill.textContent = t(`已认证（${count} 个账号 · 账号池就绪）`, `Signed in (${count} accounts)`);
        pill.className = 'pill on';
      } else if (state.signedIn) {
        pill.textContent = t('已认证（1 个账号 · 本地已保存）', 'Signed in (1 account)');
        pill.className = 'pill on';
      } else if (state.pending) {
        pill.textContent = t('等待浏览器授权…', 'Waiting for browser…');
        pill.className = 'pill plain';
      } else {
        pill.textContent = t('未认证', 'Not signed in');
        pill.className = 'pill off';
      }

      const masked = state.emailsMasked !== false;
      toggleMaskBtn.hidden = count === 0;
      toggleMaskBtn.disabled = working;
      toggleMaskBtn.textContent = masked
        ? t('显示账号名', 'Show account names')
        : t('隐藏账号名（脱敏）', 'Mask account names');
      toggleMaskBtn.title = masked
        ? t('当前已开启脱敏（仅显示首尾字），点击显示全部完整账号名', 'Emails are masked by default; click to reveal all full account names')
        : t('当前显示完整账号名，点击重新隐藏为脱敏格式', 'Showing full account names; click to mask all names again');

      loginBtn.disabled = working || !state.configured;
      loginBtn.textContent = state.pending
        ? t('重新打开浏览器认证', 'Reopen browser auth')
        : count > 0
          ? t('添加账号（浏览器登录）', 'Add account (Browser)')
          : t('打开浏览器认证', 'Sign in with Browser');
      const showTerms = state.signedIn && state.protocol === 'robin';
      const anyNeedsTerms = showTerms && state.accounts.some(a => a.termsStatus !== 'accepted');
      viewTermsBtn.hidden = !showTerms;
      viewTermsBtn.disabled = working;
      termsHint.hidden = !anyNeedsTerms;
      cancelBtn.hidden = !state.pending;
      cancelBtn.disabled = working;
      clearAllBtn.hidden = count < 2;
      clearAllBtn.disabled = working;
      manualBox.hidden = !state.pending;
      manualBtn.disabled = working;
      saveCfgBtn.disabled = working;
      resetCfgBtn.disabled = working;

      const routing = state.accountRouting;
      refreshQuotasBtn.hidden = count === 0 || state.protocol !== 'robin';
      refreshQuotasBtn.disabled = working;

      routingField.hidden = !state.authEnabled;
      routingSelect.disabled = working;
      if (!working && routingSelect.value !== routing) {
        routingSelect.value = routing;
      }
      routingHint.hidden = !state.authEnabled || count === 0;
      if (routing === 'round-robin') {
        routingHint.textContent = t(
          '当前为轮询模式：所有账号平等参与轮流调用（无主从区分），卡片中平等展示各号周额度。',
          'Round-robin: all accounts rotate equally without primary/backup roles, showing weekly quota side by side.',
        );
      } else if (routing === 'least-used') {
        routingHint.textContent = t(
          '当前为额度优先模式：自动按周额度剩余比例从高到低排序调度（自动避开冷却或 5h 耗尽账号）。',
          'Least-used: routes to the available account with the highest weekly quota remaining.',
        );
      } else {
        routingHint.textContent = t(
          '当前为主备故障转移模式：优先使用「主用」账号，遇 429 / 配额降级 / 认证异常自动切换备用号。',
          'Failover: uses the primary account first and automatically switches to backups on 429 or downgrade.',
        );
      }

      if (state.pending) {
        const target = state.pendingTargetAccountId
          ? state.accounts.find(a => a.id === state!.pendingTargetAccountId)
          : undefined;
        pendingNote.textContent = target
          ? t(`正在等待 ${accountDisplayName(target.id, target.email, zh, masked)} 重新授权…`, `Waiting to re-authenticate ${accountDisplayName(target.id, target.email, zh, masked)}…`)
          : count > 0
            ? t('正在等待新增账号完成浏览器授权…', 'Waiting for the new account to finish browser authorization…')
            : t('正在等待浏览器授权回调…', 'Waiting for browser OAuth callback…');
        pendingNote.hidden = false;
      } else {
        pendingNote.hidden = true;
      }

      if (state.pending && state.authUrl) {
        try {
          const safeUrl = safeExternalUrl(state.authUrl);
          authLink.href = safeUrl;
          authLink.hidden = false;
          setCopyUrl(safeUrl);
          copyRow.hidden = false;
        } catch {
          authLink.hidden = true;
        }
      } else {
        authLink.hidden = true;
        copyRow.hidden = true;
      }

      // Avoid rebuilding account cards on identical 2s polling frames so button hover/focus stays steady.
      const minuteBucket = Math.floor(Date.now() / 30_000);
      const nextFp = JSON.stringify({
        working,
        configured: state.configured,
        protocol: state.protocol,
        routing,
        masked,
        accounts: state.accounts,
        cdBucket: state.accounts.some(a => a.cooldownUntil && a.cooldownUntil > Date.now()) ? minuteBucket : 0,
      });
      if (nextFp !== accountsFingerprint) {
        accountsFingerprint = nextFp;
        if (count === 0) {
          accountsBox.replaceChildren();
        } else {
          const now = Date.now();
          const displayed = routing === 'least-used'
            ? sortLeastUsed(state.accounts, a => ({
                cooled: Boolean(a.cooldownUntil && a.cooldownUntil > now),
                cooldownUntil: a.cooldownUntil,
                fiveHourRemaining: a.fiveHourRemaining,
                weeklyRemaining: a.weeklyRemaining,
              }))
            : state.accounts;
          const topId = routing === 'least-used' ? displayed[0]?.id : undefined;
          accountsBox.replaceChildren(
            ...displayed.map((acct, index) => renderAccountCard(
              acct,
              state!.protocol,
              masked,
              routing,
              index,
              Boolean(topId && acct.id === topId && !(acct.cooldownUntil && acct.cooldownUntil > now)),
            )),
          );
        }
      }

      const rows = [
        state.clientId ? { k: t('客户端 ID', 'Client ID'), v: state.clientId } : null,
        state.redirectUri ? { k: t('回调地址', 'Redirect URI'), v: state.redirectUri } : null,
      ].filter((r): r is { k: string; v: string } => Boolean(r));
      infoBox.replaceChildren(...(rows.length ? [ui.kv(rows)] : []));

      if (state.error) {
        message.textContent = state.error;
        message.classList.add('bad');
      } else if ((!wasSignedIn || wasPending || count > wasAccountCount) && !state.pending && state.signedIn) {
        message.textContent = count > 1
          ? t(`账号认证成功并已加入账号池（共 ${count} 个账号），可点击下方「立即查询额度」查看各号余量。`, `Account added to pool (${count} accounts total). Query quota below to inspect all accounts.`)
          : t('认证成功并已本地保存，现在可以直接「测试连接」或保存后直接调用。', 'Signed in and saved locally. Ready to test or invoke directly.');
        message.classList.remove('bad');
      }
      wasSignedIn = state.signedIn;
      wasPending = state.pending;
      wasAccountCount = count;
    }

    async function refresh() {
      if (polling || working || signal.aborted) return;
      polling = true;
      try {
        const next = await invoke<AuthPanelStatus>('status');
        if (signal.aborted || working) return;
        const accountChanged = next.signedIn !== wasSignedIn || next.accounts.length !== wasAccountCount;
        state = next;
        paint();
        if (accountChanged) await ctx.refresh();
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add('bad');
        }
      } finally {
        polling = false;
      }
    }

    async function run(action: () => Promise<void>) {
      if (working || signal.aborted) return;
      working = true;
      message.textContent = '';
      message.classList.remove('bad');
      paint();
      try {
        await action();
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add('bad');
        }
      } finally {
        working = false;
        if (!signal.aborted) paint();
      }
    }

    const onPanelSync = (ev: PanelSyncEvent) => {
      if (ev.instanceName !== name) return;
      if (ev.kind === 'gateway') {
        lastApiKeyFormKey = '';
        void refresh();
      } else if ((ev.kind === 'mask' || ev.kind === 'quota') && ev.source !== 'auth') {
        void refresh();
      }
    };
    panelSyncListeners.add(onPanelSync);
    signal.addEventListener('abort', () => panelSyncListeners.delete(onPanelSync), { once: true });

    await refresh();
    ctx.interval(() => { void refresh(); }, 2000);
  },
};

const quotaPanel: WebUiPanel = {
  async mount(ctx) {
    const { ui, root, signal } = ctx;
    const zh = isZh(ctx);
    const t = (cn: string, en: string) => (zh ? cn : en);
    const name = ctx.scope.instance;
    if (!name) return;

    root.classList.add('ggw-panel');
    let selectedAccountId = 'all';
    let emailsMasked = true;
    let accountRouting: AccountRoutingMode = 'failover';
    let currentProtocol: GatewayProtocol = 'robin';
    let currentQuotaEndpoint = '';
    let lastSnapshot: QuotaSnapshot | undefined;
    let savingRoutes = false;

    // Custom routes section (shown in Web2API Gemini / Custom RPC modes)
    const customRoutesSection = ui.h('div', 'ggw-section');
    customRoutesSection.hidden = true;
    const routesDesc = ui.h('div', 'sh-desc');
    const genRouteInput = ui.input({ cls: 'mono', placeholder: 'generate?$alt=json' });
    const uploadRouteInput = ui.input({ cls: 'mono', placeholder: 'upload' });
    const deleteRouteInput = ui.input({ cls: 'mono', placeholder: 'conversations/{conversationId}' });
    const convHeaderInput = ui.input({ cls: 'mono', placeholder: 'x-conversation-id' });
    const quotaRouteInput = ui.input({ cls: 'mono', placeholder: '/quota' });

    const genRouteField = ui.field(t('生成路由 (generationEndpoint)', 'Generation endpoint'), genRouteInput);
    const uploadRouteField = ui.field(t('附件上传路由 (uploadEndpoint，可选)', 'Upload endpoint (optional)'), uploadRouteInput);
    const deleteRouteField = ui.field(t('会话清理路由 (deleteEndpoint，含 {conversationId}，可选)', 'Delete endpoint with {conversationId} (optional)'), deleteRouteInput);
    const convHeaderField = ui.field(t('会话 ID 响应头 (conversationHeader，可选)', 'Conversation ID header (optional)'), convHeaderInput);
    const quotaRouteField = ui.field(t('自定义额度查询路由 (quotaEndpoint，可选)', 'Quota endpoint (optional)'), quotaRouteInput);

    const routesActions = ui.rowbar();
    const saveRoutesBtn = ui.button(t('保存自定义路由', 'Save custom routes'), {
      size: 'sm',
      variant: 'primary',
      onClick: () => void saveRoutes(),
    });
    routesActions.append(saveRoutesBtn);
    const routesMsg = ui.msgline();
    customRoutesSection.append(
      routesDesc,
      genRouteField,
      uploadRouteField,
      deleteRouteField,
      convHeaderField,
      quotaRouteField,
      routesActions,
      routesMsg,
    );

    const quotaSection = ui.h('div', 'ggw-section');
    const topBar = ui.h('div', 'ggw-quota-toolbar');
    const accountSelect = ui.select({
      options: [{ value: 'all', label: t('全部账号', 'All accounts') }],
      onChange: value => {
        selectedAccountId = value || 'all';
        void fetchQuota(true);
      },
    });
    accountSelect.classList.add('ggw-quota-select');
    accountSelect.hidden = true;

    const queryBtn = ui.button(t('立即查询额度', 'Query quota'), {
      size: 'sm',
      variant: 'primary',
      onClick: () => void fetchQuota(true),
    });
    const toggleMaskBtn = ui.button(t('显示账号名', 'Show account names'), {
      size: 'sm',
      onClick: () => void toggleQuotaMask(),
    });
    toggleMaskBtn.hidden = true;
    const planPill = ui.pill(t('未查询', 'Idle'), 'plain');
    topBar.append(accountSelect, queryBtn, toggleMaskBtn, planPill);

    const cardsBox = ui.h('div', 'ggw-quota-cards');
    const footnote = ui.h('div', 'sh-desc');
    const message = ui.msgline();
    quotaSection.append(topBar, cardsBox, footnote, message);
    root.append(customRoutesSection, quotaSection);

    function applyRoutesView(routes: CustomRoutesState) {
      currentProtocol = routes.protocol;
      currentQuotaEndpoint = routes.quotaEndpoint.trim();
      const isRobin = routes.protocol === 'robin';
      const isRpc = routes.protocol === 'rpc';

      setPanelTitle(
        root,
        isRobin
          ? t('额度查询', 'Quota & Usage')
          : isRpc
            ? t('自定义路由与端点', 'Custom RPC Routes')
            : t('自定义接口与额度', 'Custom Endpoints & Quota'),
      );

      customRoutesSection.hidden = isRobin;
      quotaSection.hidden = !isRobin && !currentQuotaEndpoint;

      if (!isRobin) {
        routesDesc.textContent = isRpc
          ? t('配置自建 RPC 网关的生成、上传、会话清理与可选额度查询路由（留空则使用默认值）。', 'Customize generation, upload, cleanup, and optional quota routes for your RPC gateway.')
          : t('按需覆盖 Web2API Gemini 的流式生成、附件上传或额度查询路由（留空则使用 Gemini 默认路由）。', 'Override Web2API Gemini generation, upload, or optional quota routes (leave blank for defaults).');
        genRouteInput.placeholder = isRpc
          ? 'generate?$alt=json'
          : 'v1beta/models/{model}:streamGenerateContent?alt=sse';
        genRouteInput.value = routes.generationEndpoint;
        uploadRouteInput.value = routes.uploadEndpoint;
        deleteRouteInput.value = routes.deleteEndpoint;
        convHeaderInput.value = routes.conversationHeader;
        quotaRouteInput.value = routes.quotaEndpoint;
        deleteRouteField.hidden = !isRpc;
        convHeaderField.hidden = !isRpc;
        saveRoutesBtn.textContent = isRpc
          ? t('保存自定义路由', 'Save custom routes')
          : t('保存接口配置', 'Save endpoints');
      }
    }

    async function loadRoutesState(): Promise<CustomRoutesState | undefined> {
      try {
        const routes = await ctx.invoke<CustomRoutesState>('routes-state', [{ name }]);
        if (signal.aborted) return undefined;
        applyRoutesView(routes);
        return routes;
      } catch {
        return undefined;
      }
    }

    async function saveRoutes() {
      if (savingRoutes || signal.aborted) return;
      savingRoutes = true;
      saveRoutesBtn.disabled = true;
      routesMsg.textContent = '';
      routesMsg.classList.remove('bad');
      try {
        const routes = await ctx.invoke<CustomRoutesState>('save-routes', [{
          name,
          generationEndpoint: genRouteInput.value,
          uploadEndpoint: uploadRouteInput.value,
          ...(currentProtocol === 'rpc' ? {
            deleteEndpoint: deleteRouteInput.value,
            conversationHeader: convHeaderInput.value,
          } : {}),
          quotaEndpoint: quotaRouteInput.value,
        }]);
        if (signal.aborted) return;
        applyRoutesView(routes);
        routesMsg.textContent = t('自定义路由已同步（请点击页面底部「保存」生效）。', 'Custom routes synced. Click Save below to persist.');
      } catch (err) {
        if (!signal.aborted) {
          routesMsg.textContent = err instanceof Error ? err.message : String(err);
          routesMsg.classList.add('bad');
        }
      } finally {
        savingRoutes = false;
        saveRoutesBtn.disabled = false;
      }
    }

    let loading = false;
    let waitingForAuth = false;
    let autoQueryDone = false;

    function updateMaskButton() {
      const hasAccounts = Boolean(lastSnapshot?.accountOptions?.length);
      toggleMaskBtn.hidden = !hasAccounts;
      toggleMaskBtn.disabled = loading;
      toggleMaskBtn.textContent = emailsMasked
        ? t('显示账号名', 'Show account names')
        : t('隐藏账号名（脱敏）', 'Mask account names');
      toggleMaskBtn.title = emailsMasked
        ? t('当前已开启脱敏（仅显示首尾字），点击显示全部完整账号名', 'Emails are masked by default; click to reveal all full account names')
        : t('当前显示完整账号名，点击重新隐藏为脱敏格式', 'Showing full account names; click to mask all names again');
    }

    function applyLabelsToSnapshot(labels: QuotaAccountLabels) {
      emailsMasked = labels.emailsMasked;
      accountRouting = labels.accountRouting;
      if (!lastSnapshot) {
        updateMaskButton();
        return;
      }
      const emailMap = new Map(labels.accountOptions.map(o => [o.id, o.email]));
      const next: QuotaSnapshot = {
        ...lastSnapshot,
        emailsMasked: labels.emailsMasked,
        accountRouting: labels.accountRouting,
        accountOptions: labels.accountOptions,
        ...(lastSnapshot.accounts ? {
          accounts: lastSnapshot.accounts.map(acct => {
            const nextEmail = emailMap.get(acct.accountId);
            return {
              ...acct,
              ...(nextEmail !== undefined ? { email: nextEmail } : {}),
            };
          }),
        } : {}),
      };
      renderSnapshot(next);
    }

    async function toggleQuotaMask() {
      if (loading || signal.aborted) return;
      toggleMaskBtn.disabled = true;
      try {
        const res = await ctx.invoke<QuotaAccountLabels>('set-mask', [{ name, masked: !emailsMasked }]);
        if (signal.aborted) return;
        applyLabelsToSnapshot(res);
        broadcastPanelSync({ kind: 'mask', instanceName: name, source: 'quota' });
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add('bad');
        }
      } finally {
        if (!signal.aborted) updateMaskButton();
      }
    }

    async function syncLabelsFromServer() {
      if (signal.aborted) return;
      try {
        const res = await ctx.invoke<QuotaAccountLabels>('account-labels', [{ name }]);
        if (!signal.aborted) applyLabelsToSnapshot(res);
      } catch {
        // Ignore transient sync errors; next manual query will refresh cleanly.
      }
    }

    function windowTitle(id: string, title?: string): string {
      if (id === 'fiveHour') return t('5 小时额度', '5-hour');
      if (id === 'weekly') return t('每周额度', 'Weekly');
      return title || id;
    }

    function syncAccountSelect(snap: QuotaSnapshot) {
      const opts = snap.accountOptions ?? [];
      if (opts.length === 0) {
        accountSelect.hidden = true;
        selectedAccountId = 'all';
        return;
      }
      accountSelect.hidden = false;
      const validIds = new Set(['all', ...opts.map(o => o.id)]);
      if (!validIds.has(selectedAccountId)) {
        selectedAccountId = 'all';
      }
      const masked = snap.emailsMasked !== false;
      const showPrimary = accountRouting === 'failover';
      const nextOptions = [
        { value: 'all', label: t(`全部账号 (${opts.length})`, `All accounts (${opts.length})`) },
        ...opts.map(o => {
          const base = accountDisplayName(o.id, o.email, zh, masked);
          return {
            value: o.id,
            label: showPrimary && o.isPrimary ? `${base} [${t('主用', 'Primary')}]` : base,
          };
        }),
      ];
      accountSelect.replaceChildren(
        ...nextOptions.map(item => {
          const el = document.createElement('option');
          el.value = item.value;
          el.textContent = item.label;
          return el;
        }),
      );
      accountSelect.value = selectedAccountId;
    }

    function renderCompactBar(win: QuotaWindow): HTMLElement {
      const bar = ui.h('div', 'ggw-qbar');
      const head = ui.h('div', 'ggw-qbar-head');
      const lbl = ui.h('span', 'ggw-qbar-lbl', windowTitle(win.id, win.title));
      const val = ui.h('span', 'ggw-qbar-val');
      const remStrong = ui.h('b', '', t(`剩余 ${win.remainingPercent}%`, `${win.remainingPercent}% left`));
      val.append(remStrong, t(` · 已用 ${win.usedPercent}%`, ` · ${win.usedPercent}% used`));
      head.append(lbl, val);

      const track = ui.h('div', 'ggw-qbar-track');
      const fillTone = win.usedPercent >= 90 ? 'ggw-qbar-fill bad' : win.usedPercent >= 75 ? 'ggw-qbar-fill warn' : 'ggw-qbar-fill';
      const fill = ui.h('div', fillTone);
      fill.style.width = `${Math.min(Math.max(win.usedPercent, 0), 100)}%`;
      track.append(fill);

      bar.append(head, track);
      if (win.resetsAt) {
        const resetMs = Date.parse(win.resetsAt) - Date.now();
        const compactReset = Number.isFinite(resetMs) ? formatDuration(resetMs, zh) : win.resetsAt;
        const foot = ui.h('div', 'ggw-qbar-foot', compactReset);
        if (Number.isFinite(resetMs)) {
          foot.title = new Date(win.resetsAt).toLocaleString();
        }
        bar.append(foot);
      }
      return bar;
    }

    function renderAccountQuotaCard(
      acct: AccountQuotaSnapshot,
      masked: boolean,
      routing: AccountRoutingMode,
      isTopPriority: boolean,
      titleOverride?: string,
    ): HTMLElement {
      const highlight = !titleOverride && (routing === 'failover' ? acct.isPrimary : (routing === 'least-used' && isTopPriority));
      const card = ui.h('div', highlight ? 'ggw-quota-card is-primary' : 'ggw-quota-card');

      const head = ui.h('div', 'ggw-quota-card-head');
      const display = titleOverride ?? accountDisplayName(acct.accountId, acct.email, zh, masked);
      const title = ui.h('div', 'ggw-quota-card-title', display);
      title.title = display;

      const tags = ui.h('span', 'ggw-tags');
      if (!titleOverride) {
        if (routing === 'failover' && acct.isPrimary) {
          tags.append(ui.h('span', 'ggw-tag primary', t('主用', 'Primary')));
        } else if (routing === 'least-used' && isTopPriority) {
          tags.append(ui.h('span', 'ggw-tag primary', t('当前优先', 'Next up')));
        }
      }
      if (acct.plan) tags.append(ui.h('span', 'ggw-tag plan', acct.plan));
      const cdText = formatCooldownLeft(acct.cooldownUntil, zh);
      if (cdText) {
        const cdTag = ui.h('span', 'ggw-tag warn', cdText);
        if (acct.cooldownReason) cdTag.title = acct.cooldownReason;
        tags.append(cdTag);
      }
      head.append(title, tags);
      card.append(head);

      if (acct.error) {
        card.append(ui.h('div', 'ggw-quota-err', acct.error));
      } else if (!acct.windows.length) {
        card.append(ui.h('div', 'sh-desc', t('接口未返回时间窗口额度数据。', 'No quota windows returned.')));
      } else {
        const bars = ui.h('div', 'ggw-qbars');
        const orderedWins = routing !== 'failover'
          ? [...acct.windows].sort((a, b) => (a.id === 'weekly' ? -1 : b.id === 'weekly' ? 1 : 0))
          : acct.windows;
        for (const win of orderedWins) {
          bars.append(renderCompactBar(win));
        }
        card.append(bars);
      }

      if (acct.creditsRemaining !== undefined || acct.userTier) {
        const foot = ui.h('div', 'ggw-quota-card-foot');
        if (acct.userTier) foot.append(ui.h('span', 'mono', acct.userTier));
        if (acct.creditsRemaining !== undefined) {
          foot.append(ui.h('span', '', t(`超额 Credits：${acct.creditsRemaining}`, `Overage Credits: ${acct.creditsRemaining}`)));
        }
        card.append(foot);
      }

      return card;
    }

    function renderSnapshot(snap: QuotaSnapshot) {
      lastSnapshot = snap;
      if (typeof snap.emailsMasked === 'boolean') {
        emailsMasked = snap.emailsMasked;
      }
      if (snap.accountRouting) {
        accountRouting = snap.accountRouting;
      }
      cardsBox.replaceChildren();
      syncAccountSelect(snap);
      updateMaskButton();

      if (snap.authRequired) {
        waitingForAuth = true;
        autoQueryDone = false;
        planPill.textContent = t('待认证', 'Auth required');
        planPill.className = 'pill plain';
        footnote.textContent = t('完成上方浏览器 OAuth 认证后，将自动查询额度。', 'Quota will load automatically once browser OAuth login completes.');
        return;
      }
      waitingForAuth = false;
      autoQueryDone = true;
      if (!snap.supported) {
        planPill.textContent = t('不适用', 'N/A');
        planPill.className = 'pill plain';
        footnote.textContent = snap.note ?? '';
        return;
      }

      const acctCards = snap.accounts;
      if (acctCards && acctCards.length > 0) {
        const okCount = acctCards.filter(a => !a.error).length;
        if (okCount === 0) {
          planPill.textContent = t('查询失败', 'Failed');
          planPill.className = 'pill off';
        } else if (acctCards.length === 1) {
          planPill.textContent = acctCards[0].plan
            ? t(`订阅：${acctCards[0].plan}`, `Plan: ${acctCards[0].plan}`)
            : t('已查询', 'Loaded');
          planPill.className = 'pill on';
        } else {
          planPill.textContent = okCount === acctCards.length
            ? t(`已查询 · ${okCount} 个账号`, `Loaded · ${okCount} accounts`)
            : t(`部分成功 · ${okCount}/${acctCards.length}`, `Partial · ${okCount}/${acctCards.length}`);
          planPill.className = okCount > 0 ? 'pill on' : 'pill off';
        }

        const now = Date.now();
        const orderedCards = accountRouting === 'least-used'
          ? sortLeastUsed(acctCards, a => ({
              cooled: Boolean(a.cooldownUntil && a.cooldownUntil > now) || Boolean(a.error),
              cooldownUntil: a.cooldownUntil,
              fiveHourRemaining: a.windows.find(w => w.id === 'fiveHour')?.remainingPercent,
              weeklyRemaining: a.windows.find(w => w.id === 'weekly')?.remainingPercent,
            }))
          : acctCards;
        const topId = accountRouting === 'least-used'
          ? orderedCards.find(a => !a.error && !(a.cooldownUntil && a.cooldownUntil > now))?.accountId
          : undefined;

        for (const acct of orderedCards) {
          cardsBox.append(renderAccountQuotaCard(acct, emailsMasked, accountRouting, acct.accountId === topId));
        }
      } else {
        // Non-OAuth / custom quotaEndpoint fallback rendered in the same compact card style.
        planPill.textContent = snap.plan
          ? t(`订阅：${snap.plan}`, `Plan: ${snap.plan}`)
          : t('已查询', 'Loaded');
        planPill.className = 'pill on';
        cardsBox.append(renderAccountQuotaCard({
          accountId: 'gateway',
          isPrimary: true,
          ...(snap.plan ? { plan: snap.plan } : {}),
          ...(snap.userTier ? { userTier: snap.userTier } : {}),
          windows: snap.windows,
          ...(snap.creditsRemaining !== undefined ? { creditsRemaining: snap.creditsRemaining } : {}),
          fetchedAt: snap.fetchedAt,
        }, false, 'failover', false, t('当前网关端点', 'Gateway endpoint')));
      }

      footnote.textContent = t(
        `查询于 ${new Date(snap.fetchedAt).toLocaleTimeString()}`,
        `Checked at ${new Date(snap.fetchedAt).toLocaleTimeString()}`,
      );
    }

    async function fetchQuota(userInitiated: boolean) {
      if (loading || signal.aborted) return;
      loading = true;
      queryBtn.disabled = true;
      accountSelect.disabled = true;
      toggleMaskBtn.disabled = true;
      if (userInitiated) {
        message.textContent = t('正在查询额度…', 'Querying quota…');
        message.classList.remove('bad');
      }
      try {
        const args: Record<string, unknown> = { name };
        if (selectedAccountId && selectedAccountId !== 'all') {
          args.accountId = selectedAccountId;
        } else {
          args.accountId = 'all';
        }
        const snap = await ctx.invoke<QuotaSnapshot>('query', [args]);
        if (signal.aborted) return;
        message.textContent = '';
        message.classList.remove('bad');
        renderSnapshot(snap);
        if (!snap.authRequired) {
          broadcastPanelSync({ kind: 'quota', instanceName: name, source: 'quota' });
        }
      } catch (err) {
        if (signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Stop automatic polling after any real upstream/network error; user can click Query manually.
        waitingForAuth = false;
        autoQueryDone = true;
        planPill.textContent = t('查询失败', 'Failed');
        planPill.className = 'pill off';
        message.textContent = msg;
        message.classList.add('bad');
      } finally {
        loading = false;
        queryBtn.disabled = false;
        accountSelect.disabled = false;
        updateMaskButton();
      }
    }

    const onPanelSync = (ev: PanelSyncEvent) => {
      if (ev.instanceName !== name) return;
      if (ev.kind === 'gateway') {
        void loadRoutesState().then(routes => {
          if (routes?.protocol === 'robin') void fetchQuota(false);
        });
      } else if (ev.kind === 'mask' && ev.source !== 'quota') {
        void syncLabelsFromServer();
      } else if (ev.kind === 'routing') {
        accountRouting = ev.routing;
        if (lastSnapshot) {
          renderSnapshot({ ...lastSnapshot, accountRouting: ev.routing });
        }
      } else if (ev.kind === 'quota' && ev.source !== 'quota' && currentProtocol === 'robin') {
        void fetchQuota(false);
      }
    };
    panelSyncListeners.add(onPanelSync);
    signal.addEventListener('abort', () => panelSyncListeners.delete(onPanelSync), { once: true });

    const initialRoutes = await loadRoutesState();
    if (!initialRoutes || initialRoutes.protocol === 'robin' || initialRoutes.quotaEndpoint.trim()) {
      await fetchQuota(false);
    }
    // Only poll local auth status while waiting for sign-in; never auto-retry failed upstream quota calls.
    ctx.interval(() => {
      if (currentProtocol === 'robin' && waitingForAuth && !autoQueryDone) void fetchQuota(false);
    }, 3000);
  },
};

const gatewayPanel: WebUiPanel = {
  async mount(ctx) {
    const { ui, root, signal } = ctx;
    const zh = isZh(ctx);
    const t = (cn: string, en: string) => (zh ? cn : en);
    const name = ctx.scope.instance;
    if (!name) return;

    root.classList.add('ggw-panel');
    const modeRow = ui.rowbar();
    const robinBtn = ui.button(t('Robin 桌面端 (自动)', 'Robin Desktop (Auto)'), {
      size: 'sm',
      onClick: () => void applyPreset('robin'),
    });
    const geminiBtn = ui.button(t('Web2API Gemini', 'Web2API Gemini'), {
      size: 'sm',
      onClick: () => void applyPreset('gemini'),
    });
    const rpcBtn = ui.button(t('自定义 RPC', 'Custom RPC'), {
      size: 'sm',
      onClick: () => void applyPreset('rpc'),
    });
    modeRow.append(robinBtn, geminiBtn, rpcBtn);

    const summaryBox = ui.h('div');

    const baseUrlInput = ui.input({
      cls: 'mono',
      placeholder: 'http://127.0.0.1:8080',
      onChange: () => void saveOptions(),
    });
    const baseUrlField = ui.field(t('自建网关地址 (自动匹配路由)', 'Self-hosted gateway URL (auto routes)'), baseUrlInput);
    baseUrlField.hidden = true;

    const authModeSelect = ui.select({
      options: [
        { value: 'auto', label: t('auto（自动识别 OAuth / API 密钥）', 'auto (detect OAuth or API key)') },
        { value: 'oauth', label: t('oauth（桌面浏览器 OAuth）', 'oauth (Desktop browser OAuth)') },
        { value: 'api-key', label: t('api-key（仅密钥请求头）', 'api-key (Key header only)') },
      ],
      onChange: value => void saveOptions({ authMode: value as AuthMode }),
    });
    const tempCheck = ui.checkbox(t('启用无痕会话标志 (temporary_chat)', 'Send temporary_chat flag'), {
      onChange: () => void saveOptions(),
    });

    const proxyUrlInput = ui.input({
      cls: 'mono',
      placeholder: t('留空跟随系统代理；支持 7890 或 http://127.0.0.1:7890', 'Leave blank for system proxy; e.g. 7890 or http://127.0.0.1:7890'),
      onChange: () => void saveOptions(),
    });
    const proxyUrlField = ui.field(t('独立代理地址（可选）', 'Dedicated proxy URL (optional)'), proxyUrlInput);

    const testRow = ui.rowbar();
    const testBtn = ui.button(t('测试连接', 'Test connection'), {
      size: 'sm',
      onClick: () => void runTest(),
    });
    testRow.append(testBtn);

    const message = ui.msgline();

    root.append(
      modeRow,
      summaryBox,
      baseUrlField,
      ui.field(t('认证模式', 'Auth mode'), authModeSelect),
      tempCheck.el,
      proxyUrlField,
      testRow,
      message,
    );

    let saving = false;
    let currentProtocol: GatewayPanelState['protocol'] = 'robin';
    let lastSavedProxyUrl = '';

    function modeDescription(protocol: GatewayPanelState['protocol']): string {
      if (protocol === 'robin') return t('RobinService HTTP/2 gRPC（自动切换官方端点与路由）', 'RobinService HTTP/2 gRPC (auto endpoint & routes)');
      if (protocol === 'gemini') return t('原生 Gemini REST SSE（自动拼接流式生成路由）', 'Native Gemini REST SSE (auto stream route)');
      return t('自定义会话剧本 RPC（自动拼接 generate 路由）', 'Custom session RPC (auto generate route)');
    }

    function fill(state: GatewayPanelState) {
      currentProtocol = state.protocol;
      robinBtn.classList.toggle('primary', state.protocol === 'robin');
      geminiBtn.classList.toggle('primary', state.protocol === 'gemini');
      rpcBtn.classList.toggle('primary', state.protocol === 'rpc');

      authModeSelect.value = state.authMode;
      tempCheck.setChecked(state.temporaryChat);
      lastSavedProxyUrl = state.proxyUrl ?? '';
      proxyUrlInput.value = lastSavedProxyUrl;

      baseUrlField.hidden = state.protocol === 'robin';
      if (state.protocol !== 'robin') {
        baseUrlInput.value = state.baseUrl;
      }

      summaryBox.replaceChildren(ui.kv([
        { k: t('自动接口地址', 'Active API URL'), v: state.baseUrl },
        { k: t('传输模式', 'Transport'), v: modeDescription(state.protocol) },
      ]));
    }

    async function load() {
      const state = await ctx.invoke<GatewayPanelState>('state', [{ name }]);
      if (!signal.aborted) fill(state);
    }

    async function applyPreset(preset: 'robin' | 'gemini' | 'rpc') {
      if (saving || signal.aborted) return;
      saving = true;
      message.textContent = '';
      message.classList.remove('bad');
      try {
        const state = await ctx.invoke<GatewayPanelState>('apply-preset', [{ name, preset }]);
        if (signal.aborted) return;
        fill(state);
        broadcastPanelSync({
          kind: 'gateway',
          instanceName: name,
          protocol: state.protocol,
          authMode: state.authMode,
          authEnabled: state.authEnabled,
        });
        message.textContent = t(
          `已自动切换至 ${preset} 模式并更新接口地址为 ${state.baseUrl}（请点击页面底部「保存」生效）。`,
          `Switched to ${preset} mode (${state.baseUrl}). Click Save below to persist.`,
        );
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add('bad');
        }
      } finally {
        saving = false;
      }
    }

    async function saveOptions(overrides: { authMode?: AuthMode } = {}): Promise<boolean> {
      if (saving || signal.aborted) return false;
      saving = true;
      message.textContent = '';
      message.classList.remove('bad');
      try {
        const state = await ctx.invoke<GatewayPanelState>('save-options', [{
          name,
          protocol: currentProtocol,
          authMode: overrides.authMode ?? authModeSelect.value,
          temporaryChat: tempCheck.checked,
          proxyUrl: proxyUrlInput.value,
          ...(currentProtocol !== 'robin' ? { baseUrl: baseUrlInput.value } : {}),
        }]);
        if (!signal.aborted) {
          fill(state);
          broadcastPanelSync({
            kind: 'gateway',
            instanceName: name,
            protocol: state.protocol,
            authMode: state.authMode,
            authEnabled: state.authEnabled,
          });
          message.textContent = t('配置已自动同步（请点击页面底部「保存」生效）。', 'Options synced. Click Save below to persist.');
        }
        return true;
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add('bad');
        }
        return false;
      } finally {
        saving = false;
      }
    }

    async function runTest() {
      if (saving || signal.aborted) return;
      if (proxyUrlInput.value.trim() !== lastSavedProxyUrl) {
        const savedOk = await saveOptions();
        if (!savedOk || signal.aborted) return;
      }
      testBtn.disabled = true;
      message.textContent = t('正在测试连接…', 'Testing connection…');
      message.classList.remove('bad');
      try {
        const res = await ctx.invoke<GatewayTestResult>('test', [{ name }]);
        if (signal.aborted) return;
        message.textContent = `${res.summary} · ${(res.elapsedMs / 1000).toFixed(1)}s`;
        message.classList.toggle('bad', !res.ok);
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add('bad');
        }
      } finally {
        testBtn.disabled = false;
      }
    }

    await load();
  },
};

export default {
  panels: {
    auth: authPanel,
    quota: quotaPanel,
    gateway: gatewayPanel,
    'model-settings': modelSettingsPanel,
  },
} satisfies WebUiClientBundle;
