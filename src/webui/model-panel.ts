import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { InputKind, ModelSettings } from './model-settings.ts';

function formatObservedTime(iso: string | undefined): { short: string; full: string } | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const dt = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  const sameDay = dt.getFullYear() === now.getFullYear()
    && dt.getMonth() === now.getMonth()
    && dt.getDate() === now.getDate();
  const date = `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  return {
    short: sameDay ? time : `${date} ${time}`,
    full: `${dt.getFullYear()}-${date} ${time}`,
  };
}

function formatThinkingLevel(level: number | undefined, en: boolean, zhHant: boolean): string | undefined {
  if (level === undefined || !Number.isFinite(level)) return undefined;
  if (level === 0) return en ? 'Off (0)' : zhHant ? '關 (0)' : '关 (0)';
  if (level === 1) return en ? 'Low (1)' : 'Low / 快 (1)';
  if (level === 4) return en ? 'Medium (4)' : zhHant ? 'Medium / 標準 (4)' : 'Medium / 标准 (4)';
  if (level === 2) return en ? 'High (2)' : 'High / 深入 (2)';
  return `level ${level}`;
}

export const modelSettingsPanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const en = ctx.language !== 'zh' && ctx.language !== 'zh-Hant';
    const zhHant = ctx.language === 'zh-Hant';
    const { ui } = ctx;
    const name = ctx.scope.instance;
    if (!name) return;

    ctx.root.classList.add('ggw-panel');

    const headerRow = ui.rowbar();
    const label = ui.h('div', 'ggw-model-label');
    const refreshBtn = ui.button(en ? 'Refresh formats & prices' : zhHant ? '重新整理格式與價格' : '获取声明格式与价格', {
      size: 'sm',
      onClick: () => void refreshCatalog(),
    });
    headerRow.append(label, refreshBtn);

    const inputTypes = ui.h('p', 'tdesc');
    const sourceNote = ui.h('p', 'tdesc');
    const routeNote = ui.h('p', 'tdesc');
    const switches = ui.h('div', 'ggw-input-switches');
    switches.style.cssText = 'display:flex;flex-wrap:wrap;gap:16px 24px;align-items:center;margin:8px 0';
    switches.setAttribute('role', 'group');
    switches.setAttribute('aria-label', en ? 'Accepted input types' : zhHant ? '接受的輸入類型' : '接受的输入类型');

    const formatDetails = ui.h('details', 'ggw-details');
    formatDetails.append(
      ui.h('summary', null, en ? 'Declared formats' : zhHant ? '檢視模型聲明的格式' : '查看模型声明的格式'),
      inputTypes,
      sourceNote,
    );

    const info = ui.h('p', 'tdesc', en
      ? 'USD per million tokens. Automatic rates follow this model and mode. Changes are saved with the connection.'
      : zhHant
        ? '單位：USD / 百萬 token。自動價格隨模型與模式更新，修改隨端點儲存。'
        : '单位：USD / 百万 token。自动价格随模型与连接模式更新，修改随端点保存。');

    const status = ui.msgline();
    const fields = ui.h('div', 'ggw-pricing');
    const mirror = ui.h('div');
    const mirrorTitle = en
      ? 'Show Robin estimates under Actual spend'
      : zhHant
        ? '同步訂閱折算額到「實際支出」'
        : '同步订阅折算额到「实际支出」';
    const mirrorHint = en
      ? 'Applies to new calls. The amount is a subscription estimate. Manual Actual spend rates take precedence.'
      : zhHant
        ? '對新呼叫生效。金額為訂閱估算，手動設定的實際支出費率優先。'
        : '对新调用生效。金额为订阅估算，手动设置的实际支出费率优先。';
    const estimateTitle = en
      ? 'Local Robin token estimate (estimated, not measured)'
      : zhHant
        ? '啟用本地 Token 估算兜底（估測值，非實測）'
        : '启用本地 Token 估算兜底（估测值，非实测）';
    const estimateBadgeText = en ? 'Estimated' : zhHant ? '估測值' : '估测值';
    const estimateHint = en
      ? 'Approximate estimate only, not upstream measurements: Robin protocol does not report token counts or cache hits. Estimates input/output tokens from prompt and visible reply text locally (cache hits are not counted; hidden reasoning tokens are excluded) so cumulative token stats and spend estimates work.'
      : zhHant
        ? '⚠️ 此項為本機近似估測值，並非 Google 上游實測數據：Robin 協議本身不下發 Token 與快取命中；開啟後按實際收發文本估算輸入輸出 Token（快取命中不計數，不含隱藏思考 Token），以使累計用量與折算金額正常累計。'
        : '⚠️ 此项为本机近似估测值，并非 Google 上游实测数据：Robin 协议本身不下发 Token 与缓存命中；开启后按实际收发文本估算输入输出 Token（缓存命中不计数，不含隐藏思考 Token），以使累计用量与折算金额正常累计。';

    const advanced = ui.h('details', 'ggw-details pricing-rules');
    const raw = ui.textarea({ rows: 10, cls: 'mono' });
    raw.setAttribute('aria-label', en ? 'Full pricing rules' : '完整计价规则');
    const applyBtn = ui.button(en ? 'Apply custom rules' : zhHant ? '套用自訂規則' : '应用自定义规则', {
      size: 'sm',
      variant: 'primary',
      onClick: () => void saveRaw(),
    });
    const resetBtn = ui.button(en ? 'Use automatic prices' : zhHant ? '恢復自動價格' : '恢复自动价格', {
      size: 'sm',
      onClick: () => void resetPrices(),
    });
    const actions = ui.rowbar();
    actions.append(resetBtn, status);
    advanced.append(
      ui.h('summary', null, en ? 'Full pricing rules (JSON)' : zhHant ? '完整計價規則（JSON）' : '完整计价规则（JSON）'),
      raw,
      applyBtn,
    );

    ctx.root.append(headerRow, routeNote, switches, formatDetails, info, mirror, fields, actions, advanced);

    let state: ModelSettings | undefined;
    let fingerprint = '';
    let busy = false;
    let saving = false;
    let jsonDirty = false;
    let rateDirty = false;

    const inputLabels: Record<InputKind, string> = en
      ? { image: 'Images', audio: 'Audio', video: 'Video', file: 'PDF / files' }
      : zhHant
        ? { image: '接受圖片', audio: '接受音訊', video: '接受影片', file: '接受 PDF／檔案' }
        : { image: '接受图片', audio: '接受音频', video: '接受视频', file: '接受 PDF／文件' };

    const meterNames: Record<string, string> = {
      input: '输入',
      uncachedInput: '未缓存输入',
      output: '输出（含推理）',
      cachedInput: '缓存读取',
      'detail:cache_write': '缓存写入',
      'detail:audio_input': '音频输入',
      'detail:audio_output': '音频输出',
    };

    const report = (error: unknown) => {
      if (!ctx.signal.aborted) {
        status.textContent = error instanceof Error ? error.message : String(error);
        status.classList.add('bad');
      }
    };

    function paint(next: ModelSettings) {
      const key = JSON.stringify(next);
      state = next;
      if (key === fingerprint) return;
      fingerprint = key;

      label.textContent = `${next.model || '—'} · ${next.automatic
        ? (en ? 'Automatic prices' : zhHant ? '自動價格' : '自动价格')
        : (en ? 'Custom prices' : zhHant ? '含自訂價格' : '含自定义价格')}`;

      if (next.robinRoute) {
        const r = next.robinRoute;
        const parts: string[] = [];
        if (r.plan) parts.push(en ? `Plan: ${r.plan}` : `套餐：${r.plan}`);
        if (r.requestedModeCategory !== undefined) {
          parts.push(en ? `Route: mode ${r.requestedModeCategory}` : `路由：mode ${r.requestedModeCategory}`);
        }
        if (r.officialEntitled === true && r.officialLabel) {
          parts.push(en ? `Official: ${r.officialLabel}` : `官方下发：${r.officialLabel}`);
        } else if (r.ultraOnly && r.officialEntitled === false) {
          parts.push(en
            ? 'Ultra only (Pro/Free accounts will be downgraded by backend)'
            : '仅 Ultra 可用（Pro/Free 账号选择会被后端降级）');
        } else if (r.officialEntitled === false) {
          parts.push(en ? 'Not in account official picker (routed by backend tier)' : '不在该账号官方下拉列表（由后端按套餐权益路由）');
        }
        const titleParts: string[] = [];
        const obsTime = formatObservedTime(r.lastObservedAt);
        if (obsTime) {
          titleParts.push(en ? `Last routed at ${obsTime.full}` : zhHant ? `最近實測時間：${obsTime.full}` : `最近实测时间：${obsTime.full}`);
        }
        const resolvedThinkLabel = formatThinkingLevel(r.lastResolvedThinkingLevel, en, zhHant);
        const requestedThinkLabel = formatThinkingLevel(r.requestedThinkingLevel, en, zhHant);
        if (resolvedThinkLabel && requestedThinkLabel && r.lastResolvedThinkingLevel !== r.requestedThinkingLevel) {
          titleParts.push(en
            ? `Thinking: requested ${requestedThinkLabel} → actual ${resolvedThinkLabel}`
            : zhHant
              ? `思考等級：請求 ${requestedThinkLabel} → 實測 ${resolvedThinkLabel}`
              : `思考等级：请求 ${requestedThinkLabel} → 实测 ${resolvedThinkLabel}`);
        }
        if (r.lastThoughtChars !== undefined) {
          titleParts.push(en
            ? `Thought stream: ${r.lastThoughtChars} chars`
            : zhHant
              ? `思考流：${r.lastThoughtChars} 字元`
              : `思考流：${r.lastThoughtChars} 字符`);
        }
        if (r.lastAttribution || resolvedThinkLabel) {
          const tags: string[] = [];
          if (r.downgraded) tags.push(en ? 'downgraded' : zhHant ? '已降級/回落' : '已降级/回落');
          if (resolvedThinkLabel) {
            const clampedNote = requestedThinkLabel && r.lastResolvedThinkingLevel !== r.requestedThinkingLevel
              ? (en ? `, req ${requestedThinkLabel}` : zhHant ? `，請求 ${requestedThinkLabel}` : `，请求 ${requestedThinkLabel}`)
              : '';
            tags.push(en
              ? `thinking: ${resolvedThinkLabel}${clampedNote}`
              : zhHant
                ? `實測思考：${resolvedThinkLabel}${clampedNote}`
                : `实测思考：${resolvedThinkLabel}${clampedNote}`);
          }
          if (obsTime) tags.push(obsTime.short);
          if (r.lastAccount) tags.push(r.lastAccount);
          const suffix = tags.length
            ? (en ? ` (${tags.join(' · ')})` : `（${tags.join(' · ')}）`)
            : '';
          if (r.lastAttribution) {
            parts.push(en
              ? `Last actual model: ${r.lastAttribution}${suffix}`
              : zhHant
                ? `最近實測歸屬：${r.lastAttribution}${suffix}`
                : `最近实测归属：${r.lastAttribution}${suffix}`);
          } else {
            parts.push(tags.join(' · '));
          }
        }
        routeNote.textContent = parts.join(' · ');
        routeNote.title = titleParts.join(' · ');
        routeNote.hidden = !parts.length;
      } else {
        routeNote.textContent = '';
        routeNote.title = '';
        routeNote.hidden = true;
      }

      inputTypes.textContent = next.input.join(', ')
        || (en ? 'No format declarations yet. Click "Refresh formats & prices".' : '暂未获得声明，请点击上方「获取声明格式与价格」或先选择模型。');
      sourceNote.textContent = next.catalogSource !== 'unknown'
        ? (en ? `Declaration source: ${next.catalogSource}` : `声明来源：${next.catalogSource === 'baseline' ? '内置 Gemini 基线声明' : next.catalogSource}`)
        : '';

      switches.replaceChildren();
      for (const setting of next.inputs) {
        const toggle = ui.h('input', 'connection-switch');
        toggle.type = 'checkbox';
        toggle.setAttribute('role', 'switch');
        toggle.checked = setting.enabled;
        toggle.disabled = !setting.available;
        toggle.setAttribute('aria-label', inputLabels[setting.kind]);

        const title = !setting.declared
          ? (en ? 'Not declared by this model' : '该模型未声明支持此类输入')
          : !setting.available
            ? (next.protocol === 'robin' && !next.hasUploadEndpoint
              ? (en
                ? 'This format is outside Robin native upload MIME support; use native Gemini REST or a custom uploadEndpoint'
                : '该格式暂不在 Robin 原生上传支持列表中，可切换至原生 Gemini REST 协议或配置自定义 uploadEndpoint')
              : (en
                ? `Requires native Gemini REST protocol or uploadEndpoint (current: ${next.protocol})`
                : `当前 ${next.protocol} 协议需配置 uploadEndpoint 或切换至原生 Gemini REST 协议才可发送此类附件`))
            : next.attachmentsEnabled
              ? (next.protocol === 'robin' && !next.hasUploadEndpoint
                ? (en
                  ? 'Uploaded automatically via Robin native Scotty upload (images, audio, video, PDF/files) using your signed-in OAuth account; can be disabled manually'
                  : '已通过 Robin 默认上传通道自动启用（支持图片/音频/视频/PDF 等，复用当前登录账号 OAuth 鉴权），可按类别手动关闭')
                : (en ? 'Follows the model declaration; can be disabled manually' : '按模型声明自动启用，可手动关闭'))
              : (en ? 'All attachments are disabled; enabling this restores automatic attachments' : '全部附件已关闭；开启此项将恢复自动附件');

        const wrapper = ui.field(inputLabels[setting.kind], toggle);
        wrapper.classList.add('connection-toggle');
        wrapper.title = title;
        wrapper.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0';
        toggle.addEventListener('change', () => void saveSwitch('input-save', toggle, { kind: setting.kind }), { signal: ctx.signal });
        switches.append(wrapper);
      }

      mirror.replaceChildren();
      if (typeof next.mirrorSubscriptionSpend === 'boolean' || typeof next.estimateRobinTokens === 'boolean') {
        const robinBillingBox = ui.h('div', 'ggw-account-card');
        robinBillingBox.style.cssText = 'display:grid;gap:10px;margin:6px 0 10px';

        const controlsRow = ui.h('div');
        controlsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center';

        if (typeof next.estimateRobinTokens === 'boolean') {
          const check = ui.h('input');
          check.type = 'checkbox';
          check.checked = next.estimateRobinTokens;
          check.style.cssText = 'width:16px;height:16px;accent-color:var(--accent);cursor:pointer;margin:0;flex:none';
          check.setAttribute('aria-label', estimateTitle);
          check.addEventListener('change', () => void saveSwitch('pricing-estimate', check), { signal: ctx.signal });

          const checkLabel = ui.h('label');
          checkLabel.style.cssText = 'display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;color:var(--ink)';
          const badge = ui.h('span', 'ggw-tag warn', estimateBadgeText);
          checkLabel.append(check, ui.h('span', null, estimateTitle), badge);
          controlsRow.append(checkLabel);
        }

        if (typeof next.mirrorSubscriptionSpend === 'boolean') {
          const toggle = ui.h('input', 'connection-switch');
          toggle.type = 'checkbox';
          toggle.checked = next.mirrorSubscriptionSpend;
          toggle.setAttribute('role', 'switch');
          toggle.setAttribute('aria-label', mirrorTitle);
          toggle.addEventListener('change', () => void saveSwitch('pricing-mirror', toggle), { signal: ctx.signal });
          const wrapper = ui.field(mirrorTitle, toggle);
          wrapper.classList.add('connection-toggle');
          wrapper.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0';
          controlsRow.append(wrapper);
        }

        robinBillingBox.append(controlsRow);
        if (typeof next.estimateRobinTokens === 'boolean') {
          const estDesc = ui.h('p', 'tdesc', estimateHint);
          estDesc.style.margin = '0';
          robinBillingBox.append(estDesc);
        }
        if (typeof next.mirrorSubscriptionSpend === 'boolean') {
          const mirDesc = ui.h('p', 'tdesc', mirrorHint);
          mirDesc.style.margin = '0';
          robinBillingBox.append(mirDesc);
        }
        mirror.append(robinBillingBox);
      }

      fields.replaceChildren();
      for (const [index, definition] of next.definitions.entries()) {
        const group = ui.h('div');
        group.style.margin = '12px 0';
        group.append(ui.section(
          `${definition.currency} · ${definition.basis === 'equivalent'
            ? (en ? 'Subscription equivalent' : '订阅额度折算计价')
            : (en ? 'Marginal API cost' : '按量费用计价')}`
          + (definition.source ? ` · ${definition.source}` : ''),
        ));
        const grid = ui.h('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:12px 18px';
        for (const rule of definition.rules) {
          const title = en ? rule.meter : meterNames[rule.meter] ?? rule.meter.replace('detail:cache_write_', '缓存写入 / ');
          const input = ui.input({ type: 'number', value: String(rule.perMillion) });
          input.min = '0';
          input.step = 'any';
          input.setAttribute('aria-label', title);
          input.addEventListener('input', () => { rateDirty = true; }, { signal: ctx.signal });
          input.addEventListener('change', () => {
            if (!state || !input.checkValidity() || !input.value.trim()) return;
            const definitions = structuredClone(state.definitions).map(value => {
              const { timeWindows: _, ...editable } = value;
              return { ...editable, models: [state!.model], source: 'webui' };
            });
            definitions[index].rules.find(value => value.meter === rule.meter)!.perMillion = Number(input.value);
            void save(definitions);
          }, { signal: ctx.signal });
          grid.append(ui.field(title, input));
        }
        group.append(grid);
        if (definition.inputBands?.length || definition.timeWindows?.length) {
          group.append(ui.msgline(en
            ? 'Context tiers (>200K) / time windows are included in the full rules.'
            : '含长上下文阶梯（>200K）或时段规则，详见下方完整计价规则。'));
        }
        fields.append(group);
      }

      if (!next.definitions.length) {
        fields.append(ui.msgline(en
          ? 'No published price for this model; only token usage will be recorded.'
          : '暂无该模型的已知公开价格，仅记录用量（可在下方手动填写 JSON 规则）。'));
      }
      if (!jsonDirty) raw.value = JSON.stringify(next.definitions, null, 2);
    }

    async function refresh() {
      if (busy || saving || jsonDirty || rateDirty || ctx.signal.aborted) return;
      busy = true;
      try {
        const next = await ctx.invoke<ModelSettings>('pricing-state', [{ name }]);
        if (jsonDirty || rateDirty || saving || ctx.signal.aborted) return;
        paint(next);
      } catch (error) {
        report(error);
      } finally {
        busy = false;
      }
    }

    async function refreshCatalog() {
      if (saving || ctx.signal.aborted) return;
      saving = true;
      refreshBtn.disabled = true;
      status.textContent = en ? 'Fetching model declarations & prices…' : '正在从目录获取模型声明格式与公开价格…';
      status.classList.remove('bad');
      try {
        const next = await ctx.invoke<ModelSettings>('refresh-catalog', [{ name }]);
        if (ctx.signal.aborted) return;
        fingerprint = '';
        paint(next);
        status.textContent = en
          ? `Loaded ${next.input.length} declared formats (${next.catalogSource}).`
          : `已同步 ${next.input.length} 项声明格式（来源：${next.catalogSource === 'baseline' ? '内置基线' : next.catalogSource}）。`;
      } catch (error) {
        report(error);
      } finally {
        saving = false;
        refreshBtn.disabled = false;
      }
    }

    async function saveSwitch(method: 'input-save' | 'pricing-mirror' | 'pricing-estimate', toggle: HTMLInputElement, args: Record<string, unknown> = {}) {
      if (!state || saving) {
        toggle.checked = !toggle.checked;
        return;
      }
      saving = true;
      toggle.disabled = true;
      try {
        const next = await ctx.invoke<ModelSettings>(method, [{ ...args, name, model: state.model, enabled: toggle.checked }]);
        if (ctx.signal.aborted) return;
        fingerprint = '';
        paint(next);
        status.textContent = en ? 'Connection draft updated (click Save below)' : '已更新端点草稿（请点击页面底部「保存」生效）';
        status.classList.remove('bad');
      } catch (error) {
        toggle.checked = !toggle.checked;
        report(error);
      } finally {
        saving = false;
        toggle.disabled = false;
      }
    }

    async function save(definitions: unknown[], fromJson = false) {
      if (!state || saving) return;
      saving = true;
      try {
        const next = await ctx.invoke<ModelSettings>('pricing-save', [{ name, model: state.model, definitions }]);
        if (ctx.signal.aborted) return;
        rateDirty = false;
        if (fromJson) jsonDirty = false;
        fingerprint = '';
        paint(next);
        status.textContent = en ? 'Custom prices updated (click Save below)' : '已更新自定义价格（请点击页面底部「保存」生效）';
        status.classList.remove('bad');
      } catch (error) {
        report(error);
      } finally {
        saving = false;
      }
    }

    async function saveRaw() {
      try {
        const value: unknown = JSON.parse(raw.value);
        if (!Array.isArray(value)) throw new Error(en ? 'JSON array required' : '需要 JSON 数组格式');
        await save(value, true);
      } catch (error) {
        report(error);
      }
    }

    async function resetPrices() {
      if (!state || saving) return;
      saving = true;
      try {
        const next = await ctx.invoke<ModelSettings>('pricing-reset', [{ name, model: state.model }]);
        if (ctx.signal.aborted) return;
        jsonDirty = false;
        rateDirty = false;
        fingerprint = '';
        paint(next);
        status.textContent = en ? 'Restored automatic prices (click Save below)' : '已恢复自动价格（请点击页面底部「保存」生效）';
        status.classList.remove('bad');
      } catch (error) {
        report(error);
      } finally {
        saving = false;
      }
    }

    raw.addEventListener('input', () => { jsonDirty = true; }, { signal: ctx.signal });
    ctx.guardLeave(() => (jsonDirty || rateDirty ? (en ? 'Unapplied model setting changes' : '模型计价修改尚未应用') : null));
    await refresh();
    ctx.interval(() => { void refresh(); }, 1000);
  },
};
