import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { InputKind, ModelSettings } from './model-settings.ts';

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
        } else if (r.officialEntitled === false) {
          parts.push(en ? 'Not in account official picker (routed by backend tier)' : '不在该账号官方下拉列表（由后端按套餐权益路由）');
        }
        if (r.lastAttribution) {
          parts.push(en
            ? `Last actual model: ${r.lastAttribution}${r.downgraded ? ' (downgraded)' : ''}`
            : `最近实测归属：${r.lastAttribution}${r.downgraded ? '（已降级/回落）' : ''}`);
        }
        routeNote.textContent = parts.join(' · ');
        routeNote.hidden = !parts.length;
      } else {
        routeNote.textContent = '';
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
                ? 'Robin native upload supports PNG/JPEG/WebP images; audio/video/PDF require native Gemini REST or a custom uploadEndpoint'
                : 'Robin 原生上传通道目前支持图片（PNG/JPEG/WebP）；音频/视频/PDF 请切换至原生 Gemini REST 协议或配置自定义 uploadEndpoint')
              : (en
                ? `Requires native Gemini REST protocol or uploadEndpoint (current: ${next.protocol})`
                : `当前 ${next.protocol} 协议需配置 uploadEndpoint 或切换至原生 Gemini REST 协议才可发送此类附件`))
            : next.attachmentsEnabled
              ? (next.protocol === 'robin' && setting.kind === 'image' && !next.hasUploadEndpoint
                ? (en
                  ? 'Uploaded automatically via Robin native Scotty upload using your signed-in OAuth account; can be disabled manually'
                  : '已通过 Robin 默认上传通道自动启用（复用当前登录账号 OAuth 鉴权），可手动关闭')
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
      if (typeof next.mirrorSubscriptionSpend === 'boolean') {
        const toggle = ui.h('input', 'connection-switch');
        toggle.type = 'checkbox';
        toggle.checked = next.mirrorSubscriptionSpend;
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-label', mirrorTitle);
        toggle.addEventListener('change', () => void saveSwitch('pricing-mirror', toggle), { signal: ctx.signal });
        const wrapper = ui.field(mirrorTitle, toggle);
        wrapper.classList.add('connection-toggle');
        mirror.append(wrapper, ui.h('p', 'tdesc', mirrorHint));
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

    async function saveSwitch(method: 'input-save' | 'pricing-mirror', toggle: HTMLInputElement, args: Record<string, unknown> = {}) {
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
