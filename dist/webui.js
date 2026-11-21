// src/redact.ts
function maskEmail(value) {
  const trimmed = value?.trim();
  if (!trimmed) return void 0;
  const at = trimmed.lastIndexOf("@");
  if (at > 0 && at < trimmed.length - 1) {
    const local = [...trimmed.slice(0, at)];
    const domain = trimmed.slice(at + 1);
    const maskedLocal = local.length >= 2 ? `${local[0]}***${local[local.length - 1]}` : `${local[0]}***`;
    return `${maskedLocal}@${domain}`;
  }
  const chars = [...trimmed];
  return chars.length >= 2 ? `${chars[0]}***${chars[chars.length - 1]}` : `${chars[0]}***`;
}

// src/webui/model-panel.ts
function formatObservedTime(iso) {
  if (!iso) return void 0;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return void 0;
  const dt = new Date(ms);
  const now = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  const sameDay = dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth() && dt.getDate() === now.getDate();
  const date = `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  return {
    short: sameDay ? time : `${date} ${time}`,
    full: `${dt.getFullYear()}-${date} ${time}`
  };
}
var modelSettingsPanel = {
  mount: async (ctx) => {
    const en = ctx.language !== "zh" && ctx.language !== "zh-Hant";
    const zhHant = ctx.language === "zh-Hant";
    const { ui } = ctx;
    const name = ctx.scope.instance;
    if (!name) return;
    ctx.root.classList.add("ggw-panel");
    const headerRow = ui.rowbar();
    const label = ui.h("div", "ggw-model-label");
    const refreshBtn = ui.button(en ? "Refresh formats & prices" : zhHant ? "\u91CD\u65B0\u6574\u7406\u683C\u5F0F\u8207\u50F9\u683C" : "\u83B7\u53D6\u58F0\u660E\u683C\u5F0F\u4E0E\u4EF7\u683C", {
      size: "sm",
      onClick: () => void refreshCatalog()
    });
    headerRow.append(label, refreshBtn);
    const inputTypes = ui.h("p", "tdesc");
    const sourceNote = ui.h("p", "tdesc");
    const routeNote = ui.h("p", "tdesc");
    const switches = ui.h("div", "ggw-input-switches");
    switches.style.cssText = "display:flex;flex-wrap:wrap;gap:16px 24px;align-items:center;margin:8px 0";
    switches.setAttribute("role", "group");
    switches.setAttribute("aria-label", en ? "Accepted input types" : zhHant ? "\u63A5\u53D7\u7684\u8F38\u5165\u985E\u578B" : "\u63A5\u53D7\u7684\u8F93\u5165\u7C7B\u578B");
    const formatDetails = ui.h("details", "ggw-details");
    formatDetails.append(
      ui.h("summary", null, en ? "Declared formats" : zhHant ? "\u6AA2\u8996\u6A21\u578B\u8072\u660E\u7684\u683C\u5F0F" : "\u67E5\u770B\u6A21\u578B\u58F0\u660E\u7684\u683C\u5F0F"),
      inputTypes,
      sourceNote
    );
    const info = ui.h("p", "tdesc", en ? "USD per million tokens. Automatic rates follow this model and mode. Changes are saved with the connection." : zhHant ? "\u55AE\u4F4D\uFF1AUSD / \u767E\u842C token\u3002\u81EA\u52D5\u50F9\u683C\u96A8\u6A21\u578B\u8207\u6A21\u5F0F\u66F4\u65B0\uFF0C\u4FEE\u6539\u96A8\u7AEF\u9EDE\u5132\u5B58\u3002" : "\u5355\u4F4D\uFF1AUSD / \u767E\u4E07 token\u3002\u81EA\u52A8\u4EF7\u683C\u968F\u6A21\u578B\u4E0E\u8FDE\u63A5\u6A21\u5F0F\u66F4\u65B0\uFF0C\u4FEE\u6539\u968F\u7AEF\u70B9\u4FDD\u5B58\u3002");
    const status = ui.msgline();
    const fields = ui.h("div", "ggw-pricing");
    const mirror = ui.h("div");
    const mirrorTitle = en ? "Show Robin estimates under Actual spend" : zhHant ? "\u540C\u6B65\u8A02\u95B1\u6298\u7B97\u984D\u5230\u300C\u5BE6\u969B\u652F\u51FA\u300D" : "\u540C\u6B65\u8BA2\u9605\u6298\u7B97\u989D\u5230\u300C\u5B9E\u9645\u652F\u51FA\u300D";
    const mirrorHint = en ? "Applies to new calls. The amount is a subscription estimate. Manual Actual spend rates take precedence." : zhHant ? "\u5C0D\u65B0\u547C\u53EB\u751F\u6548\u3002\u91D1\u984D\u70BA\u8A02\u95B1\u4F30\u7B97\uFF0C\u624B\u52D5\u8A2D\u5B9A\u7684\u5BE6\u969B\u652F\u51FA\u8CBB\u7387\u512A\u5148\u3002" : "\u5BF9\u65B0\u8C03\u7528\u751F\u6548\u3002\u91D1\u989D\u4E3A\u8BA2\u9605\u4F30\u7B97\uFF0C\u624B\u52A8\u8BBE\u7F6E\u7684\u5B9E\u9645\u652F\u51FA\u8D39\u7387\u4F18\u5148\u3002";
    const advanced = ui.h("details", "ggw-details pricing-rules");
    const raw = ui.textarea({ rows: 10, cls: "mono" });
    raw.setAttribute("aria-label", en ? "Full pricing rules" : "\u5B8C\u6574\u8BA1\u4EF7\u89C4\u5219");
    const applyBtn = ui.button(en ? "Apply custom rules" : zhHant ? "\u5957\u7528\u81EA\u8A02\u898F\u5247" : "\u5E94\u7528\u81EA\u5B9A\u4E49\u89C4\u5219", {
      size: "sm",
      variant: "primary",
      onClick: () => void saveRaw()
    });
    const resetBtn = ui.button(en ? "Use automatic prices" : zhHant ? "\u6062\u5FA9\u81EA\u52D5\u50F9\u683C" : "\u6062\u590D\u81EA\u52A8\u4EF7\u683C", {
      size: "sm",
      onClick: () => void resetPrices()
    });
    const actions = ui.rowbar();
    actions.append(resetBtn, status);
    advanced.append(
      ui.h("summary", null, en ? "Full pricing rules (JSON)" : zhHant ? "\u5B8C\u6574\u8A08\u50F9\u898F\u5247\uFF08JSON\uFF09" : "\u5B8C\u6574\u8BA1\u4EF7\u89C4\u5219\uFF08JSON\uFF09"),
      raw,
      applyBtn
    );
    ctx.root.append(headerRow, routeNote, switches, formatDetails, info, mirror, fields, actions, advanced);
    let state;
    let fingerprint = "";
    let busy = false;
    let saving = false;
    let jsonDirty = false;
    let rateDirty = false;
    const inputLabels = en ? { image: "Images", audio: "Audio", video: "Video", file: "PDF / files" } : zhHant ? { image: "\u63A5\u53D7\u5716\u7247", audio: "\u63A5\u53D7\u97F3\u8A0A", video: "\u63A5\u53D7\u5F71\u7247", file: "\u63A5\u53D7 PDF\uFF0F\u6A94\u6848" } : { image: "\u63A5\u53D7\u56FE\u7247", audio: "\u63A5\u53D7\u97F3\u9891", video: "\u63A5\u53D7\u89C6\u9891", file: "\u63A5\u53D7 PDF\uFF0F\u6587\u4EF6" };
    const meterNames = {
      input: "\u8F93\u5165",
      uncachedInput: "\u672A\u7F13\u5B58\u8F93\u5165",
      output: "\u8F93\u51FA\uFF08\u542B\u63A8\u7406\uFF09",
      cachedInput: "\u7F13\u5B58\u8BFB\u53D6",
      "detail:cache_write": "\u7F13\u5B58\u5199\u5165",
      "detail:audio_input": "\u97F3\u9891\u8F93\u5165",
      "detail:audio_output": "\u97F3\u9891\u8F93\u51FA"
    };
    const report = (error) => {
      if (!ctx.signal.aborted) {
        status.textContent = error instanceof Error ? error.message : String(error);
        status.classList.add("bad");
      }
    };
    function paint(next) {
      const key = JSON.stringify(next);
      state = next;
      if (key === fingerprint) return;
      fingerprint = key;
      label.textContent = `${next.model || "\u2014"} \xB7 ${next.automatic ? en ? "Automatic prices" : zhHant ? "\u81EA\u52D5\u50F9\u683C" : "\u81EA\u52A8\u4EF7\u683C" : en ? "Custom prices" : zhHant ? "\u542B\u81EA\u8A02\u50F9\u683C" : "\u542B\u81EA\u5B9A\u4E49\u4EF7\u683C"}`;
      if (next.robinRoute) {
        const r = next.robinRoute;
        const parts = [];
        if (r.plan) parts.push(en ? `Plan: ${r.plan}` : `\u5957\u9910\uFF1A${r.plan}`);
        if (r.requestedModeCategory !== void 0) {
          parts.push(en ? `Route: mode ${r.requestedModeCategory}` : `\u8DEF\u7531\uFF1Amode ${r.requestedModeCategory}`);
        }
        if (r.officialEntitled === true && r.officialLabel) {
          parts.push(en ? `Official: ${r.officialLabel}` : `\u5B98\u65B9\u4E0B\u53D1\uFF1A${r.officialLabel}`);
        } else if (r.officialEntitled === false) {
          parts.push(en ? "Not in account official picker (routed by backend tier)" : "\u4E0D\u5728\u8BE5\u8D26\u53F7\u5B98\u65B9\u4E0B\u62C9\u5217\u8868\uFF08\u7531\u540E\u7AEF\u6309\u5957\u9910\u6743\u76CA\u8DEF\u7531\uFF09");
        }
        let observedTitle = "";
        if (r.lastAttribution) {
          const obsTime = formatObservedTime(r.lastObservedAt);
          if (obsTime) observedTitle = obsTime.full;
          const tags = [];
          if (r.downgraded) tags.push(en ? "downgraded" : zhHant ? "\u5DF2\u964D\u7D1A/\u56DE\u843D" : "\u5DF2\u964D\u7EA7/\u56DE\u843D");
          if (obsTime) tags.push(obsTime.short);
          if (r.lastAccount) tags.push(r.lastAccount);
          const suffix = tags.length ? en ? ` (${tags.join(" \xB7 ")})` : `\uFF08${tags.join(" \xB7 ")}\uFF09` : "";
          parts.push(en ? `Last actual model: ${r.lastAttribution}${suffix}` : zhHant ? `\u6700\u8FD1\u5BE6\u6E2C\u6B78\u5C6C\uFF1A${r.lastAttribution}${suffix}` : `\u6700\u8FD1\u5B9E\u6D4B\u5F52\u5C5E\uFF1A${r.lastAttribution}${suffix}`);
        }
        routeNote.textContent = parts.join(" \xB7 ");
        routeNote.title = observedTitle ? en ? `Last routed at ${observedTitle}` : zhHant ? `\u6700\u8FD1\u5BE6\u6E2C\u6642\u9593\uFF1A${observedTitle}` : `\u6700\u8FD1\u5B9E\u6D4B\u65F6\u95F4\uFF1A${observedTitle}` : "";
        routeNote.hidden = !parts.length;
      } else {
        routeNote.textContent = "";
        routeNote.title = "";
        routeNote.hidden = true;
      }
      inputTypes.textContent = next.input.join(", ") || (en ? 'No format declarations yet. Click "Refresh formats & prices".' : "\u6682\u672A\u83B7\u5F97\u58F0\u660E\uFF0C\u8BF7\u70B9\u51FB\u4E0A\u65B9\u300C\u83B7\u53D6\u58F0\u660E\u683C\u5F0F\u4E0E\u4EF7\u683C\u300D\u6216\u5148\u9009\u62E9\u6A21\u578B\u3002");
      sourceNote.textContent = next.catalogSource !== "unknown" ? en ? `Declaration source: ${next.catalogSource}` : `\u58F0\u660E\u6765\u6E90\uFF1A${next.catalogSource === "baseline" ? "\u5185\u7F6E Gemini \u57FA\u7EBF\u58F0\u660E" : next.catalogSource}` : "";
      switches.replaceChildren();
      for (const setting of next.inputs) {
        const toggle = ui.h("input", "connection-switch");
        toggle.type = "checkbox";
        toggle.setAttribute("role", "switch");
        toggle.checked = setting.enabled;
        toggle.disabled = !setting.available;
        toggle.setAttribute("aria-label", inputLabels[setting.kind]);
        const title = !setting.declared ? en ? "Not declared by this model" : "\u8BE5\u6A21\u578B\u672A\u58F0\u660E\u652F\u6301\u6B64\u7C7B\u8F93\u5165" : !setting.available ? next.protocol === "robin" && !next.hasUploadEndpoint ? en ? "Robin native upload supports PNG/JPEG/WebP images; audio/video/PDF require native Gemini REST or a custom uploadEndpoint" : "Robin \u539F\u751F\u4E0A\u4F20\u901A\u9053\u76EE\u524D\u652F\u6301\u56FE\u7247\uFF08PNG/JPEG/WebP\uFF09\uFF1B\u97F3\u9891/\u89C6\u9891/PDF \u8BF7\u5207\u6362\u81F3\u539F\u751F Gemini REST \u534F\u8BAE\u6216\u914D\u7F6E\u81EA\u5B9A\u4E49 uploadEndpoint" : en ? `Requires native Gemini REST protocol or uploadEndpoint (current: ${next.protocol})` : `\u5F53\u524D ${next.protocol} \u534F\u8BAE\u9700\u914D\u7F6E uploadEndpoint \u6216\u5207\u6362\u81F3\u539F\u751F Gemini REST \u534F\u8BAE\u624D\u53EF\u53D1\u9001\u6B64\u7C7B\u9644\u4EF6` : next.attachmentsEnabled ? next.protocol === "robin" && setting.kind === "image" && !next.hasUploadEndpoint ? en ? "Uploaded automatically via Robin native Scotty upload using your signed-in OAuth account; can be disabled manually" : "\u5DF2\u901A\u8FC7 Robin \u9ED8\u8BA4\u4E0A\u4F20\u901A\u9053\u81EA\u52A8\u542F\u7528\uFF08\u590D\u7528\u5F53\u524D\u767B\u5F55\u8D26\u53F7 OAuth \u9274\u6743\uFF09\uFF0C\u53EF\u624B\u52A8\u5173\u95ED" : en ? "Follows the model declaration; can be disabled manually" : "\u6309\u6A21\u578B\u58F0\u660E\u81EA\u52A8\u542F\u7528\uFF0C\u53EF\u624B\u52A8\u5173\u95ED" : en ? "All attachments are disabled; enabling this restores automatic attachments" : "\u5168\u90E8\u9644\u4EF6\u5DF2\u5173\u95ED\uFF1B\u5F00\u542F\u6B64\u9879\u5C06\u6062\u590D\u81EA\u52A8\u9644\u4EF6";
        const wrapper = ui.field(inputLabels[setting.kind], toggle);
        wrapper.classList.add("connection-toggle");
        wrapper.title = title;
        wrapper.style.cssText = "display:flex;align-items:center;gap:10px;margin:0";
        toggle.addEventListener("change", () => void saveSwitch("input-save", toggle, { kind: setting.kind }), { signal: ctx.signal });
        switches.append(wrapper);
      }
      mirror.replaceChildren();
      if (typeof next.mirrorSubscriptionSpend === "boolean") {
        const toggle = ui.h("input", "connection-switch");
        toggle.type = "checkbox";
        toggle.checked = next.mirrorSubscriptionSpend;
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-label", mirrorTitle);
        toggle.addEventListener("change", () => void saveSwitch("pricing-mirror", toggle), { signal: ctx.signal });
        const wrapper = ui.field(mirrorTitle, toggle);
        wrapper.classList.add("connection-toggle");
        mirror.append(wrapper, ui.h("p", "tdesc", mirrorHint));
      }
      fields.replaceChildren();
      for (const [index, definition] of next.definitions.entries()) {
        const group = ui.h("div");
        group.style.margin = "12px 0";
        group.append(ui.section(
          `${definition.currency} \xB7 ${definition.basis === "equivalent" ? en ? "Subscription equivalent" : "\u8BA2\u9605\u989D\u5EA6\u6298\u7B97\u8BA1\u4EF7" : en ? "Marginal API cost" : "\u6309\u91CF\u8D39\u7528\u8BA1\u4EF7"}` + (definition.source ? ` \xB7 ${definition.source}` : "")
        ));
        const grid = ui.h("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:12px 18px";
        for (const rule of definition.rules) {
          const title = en ? rule.meter : meterNames[rule.meter] ?? rule.meter.replace("detail:cache_write_", "\u7F13\u5B58\u5199\u5165 / ");
          const input = ui.input({ type: "number", value: String(rule.perMillion) });
          input.min = "0";
          input.step = "any";
          input.setAttribute("aria-label", title);
          input.addEventListener("input", () => {
            rateDirty = true;
          }, { signal: ctx.signal });
          input.addEventListener("change", () => {
            if (!state || !input.checkValidity() || !input.value.trim()) return;
            const definitions = structuredClone(state.definitions).map((value) => {
              const { timeWindows: _, ...editable } = value;
              return { ...editable, models: [state.model], source: "webui" };
            });
            definitions[index].rules.find((value) => value.meter === rule.meter).perMillion = Number(input.value);
            void save(definitions);
          }, { signal: ctx.signal });
          grid.append(ui.field(title, input));
        }
        group.append(grid);
        if (definition.inputBands?.length || definition.timeWindows?.length) {
          group.append(ui.msgline(en ? "Context tiers (>200K) / time windows are included in the full rules." : "\u542B\u957F\u4E0A\u4E0B\u6587\u9636\u68AF\uFF08>200K\uFF09\u6216\u65F6\u6BB5\u89C4\u5219\uFF0C\u8BE6\u89C1\u4E0B\u65B9\u5B8C\u6574\u8BA1\u4EF7\u89C4\u5219\u3002"));
        }
        fields.append(group);
      }
      if (!next.definitions.length) {
        fields.append(ui.msgline(en ? "No published price for this model; only token usage will be recorded." : "\u6682\u65E0\u8BE5\u6A21\u578B\u7684\u5DF2\u77E5\u516C\u5F00\u4EF7\u683C\uFF0C\u4EC5\u8BB0\u5F55\u7528\u91CF\uFF08\u53EF\u5728\u4E0B\u65B9\u624B\u52A8\u586B\u5199 JSON \u89C4\u5219\uFF09\u3002"));
      }
      if (!jsonDirty) raw.value = JSON.stringify(next.definitions, null, 2);
    }
    async function refresh() {
      if (busy || saving || jsonDirty || rateDirty || ctx.signal.aborted) return;
      busy = true;
      try {
        const next = await ctx.invoke("pricing-state", [{ name }]);
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
      status.textContent = en ? "Fetching model declarations & prices\u2026" : "\u6B63\u5728\u4ECE\u76EE\u5F55\u83B7\u53D6\u6A21\u578B\u58F0\u660E\u683C\u5F0F\u4E0E\u516C\u5F00\u4EF7\u683C\u2026";
      status.classList.remove("bad");
      try {
        const next = await ctx.invoke("refresh-catalog", [{ name }]);
        if (ctx.signal.aborted) return;
        fingerprint = "";
        paint(next);
        status.textContent = en ? `Loaded ${next.input.length} declared formats (${next.catalogSource}).` : `\u5DF2\u540C\u6B65 ${next.input.length} \u9879\u58F0\u660E\u683C\u5F0F\uFF08\u6765\u6E90\uFF1A${next.catalogSource === "baseline" ? "\u5185\u7F6E\u57FA\u7EBF" : next.catalogSource}\uFF09\u3002`;
      } catch (error) {
        report(error);
      } finally {
        saving = false;
        refreshBtn.disabled = false;
      }
    }
    async function saveSwitch(method, toggle, args = {}) {
      if (!state || saving) {
        toggle.checked = !toggle.checked;
        return;
      }
      saving = true;
      toggle.disabled = true;
      try {
        const next = await ctx.invoke(method, [{ ...args, name, model: state.model, enabled: toggle.checked }]);
        if (ctx.signal.aborted) return;
        fingerprint = "";
        paint(next);
        status.textContent = en ? "Connection draft updated (click Save below)" : "\u5DF2\u66F4\u65B0\u7AEF\u70B9\u8349\u7A3F\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09";
        status.classList.remove("bad");
      } catch (error) {
        toggle.checked = !toggle.checked;
        report(error);
      } finally {
        saving = false;
        toggle.disabled = false;
      }
    }
    async function save(definitions, fromJson = false) {
      if (!state || saving) return;
      saving = true;
      try {
        const next = await ctx.invoke("pricing-save", [{ name, model: state.model, definitions }]);
        if (ctx.signal.aborted) return;
        rateDirty = false;
        if (fromJson) jsonDirty = false;
        fingerprint = "";
        paint(next);
        status.textContent = en ? "Custom prices updated (click Save below)" : "\u5DF2\u66F4\u65B0\u81EA\u5B9A\u4E49\u4EF7\u683C\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09";
        status.classList.remove("bad");
      } catch (error) {
        report(error);
      } finally {
        saving = false;
      }
    }
    async function saveRaw() {
      try {
        const value = JSON.parse(raw.value);
        if (!Array.isArray(value)) throw new Error(en ? "JSON array required" : "\u9700\u8981 JSON \u6570\u7EC4\u683C\u5F0F");
        await save(value, true);
      } catch (error) {
        report(error);
      }
    }
    async function resetPrices() {
      if (!state || saving) return;
      saving = true;
      try {
        const next = await ctx.invoke("pricing-reset", [{ name, model: state.model }]);
        if (ctx.signal.aborted) return;
        jsonDirty = false;
        rateDirty = false;
        fingerprint = "";
        paint(next);
        status.textContent = en ? "Restored automatic prices (click Save below)" : "\u5DF2\u6062\u590D\u81EA\u52A8\u4EF7\u683C\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09";
        status.classList.remove("bad");
      } catch (error) {
        report(error);
      } finally {
        saving = false;
      }
    }
    raw.addEventListener("input", () => {
      jsonDirty = true;
    }, { signal: ctx.signal });
    ctx.guardLeave(() => jsonDirty || rateDirty ? en ? "Unapplied model setting changes" : "\u6A21\u578B\u8BA1\u4EF7\u4FEE\u6539\u5C1A\u672A\u5E94\u7528" : null);
    await refresh();
    ctx.interval(() => {
      void refresh();
    }, 1e3);
  }
};

// src/webui/client.ts
var isZh = (ctx) => ctx.language === "zh" || ctx.language === "zh-Hant";
var panelSyncListeners = /* @__PURE__ */ new Set();
function broadcastPanelSync(ev) {
  for (const listener of panelSyncListeners) listener(ev);
}
function setPanelTitle(root, title) {
  const heading = root.closest("details.connection-section")?.querySelector(":scope > summary h3");
  if (heading && heading.textContent !== title) {
    heading.textContent = title;
  }
}
function sortLeastUsed(items, info) {
  return [...items].sort((a, b) => {
    const ia = info(a);
    const ib = info(b);
    if (ia.cooled !== ib.cooled) return ia.cooled ? 1 : -1;
    if (ia.cooled && ib.cooled) return (ia.cooldownUntil ?? 0) - (ib.cooldownUntil ?? 0);
    const exhA = ia.fiveHourRemaining !== void 0 && ia.fiveHourRemaining <= 5;
    const exhB = ib.fiveHourRemaining !== void 0 && ib.fiveHourRemaining <= 5;
    if (exhA !== exhB) return exhA ? 1 : -1;
    const weekA = ia.weeklyRemaining ?? ia.fiveHourRemaining ?? 50;
    const weekB = ib.weeklyRemaining ?? ib.fiveHourRemaining ?? 50;
    if (weekA !== weekB) return weekB - weekA;
    const fiveA = ia.fiveHourRemaining ?? 50;
    const fiveB = ib.fiveHourRemaining ?? 50;
    return fiveB - fiveA;
  });
}
function safeExternalUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid authorization URL");
  }
  return url.href;
}
function formatDuration(ms, zh) {
  if (ms <= 0) return zh ? "\u5373\u5C06\u91CD\u7F6E" : "resetting soon";
  const mins = Math.floor(ms / 6e4);
  if (mins < 60) return zh ? `${mins} \u5206\u949F\u540E\u91CD\u7F6E` : `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return zh ? `${hours} \u5C0F\u65F6 ${mins % 60} \u5206\u949F\u540E\u91CD\u7F6E` : `resets in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} \u5929 ${hours % 24} \u5C0F\u65F6\u540E\u91CD\u7F6E` : `resets in ${days}d ${hours % 24}h`;
}
function formatShortExpiry(expiresAt, zh) {
  if (!expiresAt) return "\u2014";
  const diff = expiresAt - Date.now();
  if (diff <= 0) return zh ? "\u4EE4\u724C\u5F85\u81EA\u52A8\u7EED\u671F" : "Token auto-refreshes";
  const mins = Math.max(1, Math.round(diff / 6e4));
  return zh ? `\u4EE4\u724C\u7EA6 ${mins} \u5206\u949F\u540E\u7EED\u671F` : `Token ~${mins}m left`;
}
function formatCooldownLeft(until, zh) {
  if (!until) return "";
  const diff = until - Date.now();
  if (diff <= 0) return "";
  const mins = Math.max(1, Math.ceil(diff / 6e4));
  return zh ? `\u51B7\u5374 ${mins}m` : `cooldown ${mins}m`;
}
function accountDisplayName(id, email, zh, masked = true) {
  if (email) return masked ? maskEmail(email) ?? email : email;
  const suffix = id.replace(/^acct_/, "").slice(0, 6);
  return zh ? `Google \u8D26\u53F7 (${suffix})` : `Account (${suffix})`;
}
var authPanel = {
  async mount(ctx) {
    const { ui, root, signal } = ctx;
    const zh = isZh(ctx);
    const t = (cn, en) => zh ? cn : en;
    const name = ctx.scope.instance;
    if (!name) {
      root.append(ui.placeholder(t("\u8BF7\u5148\u65B0\u5EFA\u6216\u9009\u62E9\u4E00\u4E2A\u7F51\u5173\u8FDE\u63A5\u3002", "Select or create a gateway connection first.")));
      return;
    }
    root.classList.add("ggw-panel");
    const headerRow = ui.rowbar();
    const pill = ui.pill(t("\u68C0\u67E5\u4E2D\u2026", "Checking\u2026"), "plain");
    const toggleMaskBtn = ui.button(t("\u663E\u793A\u8D26\u53F7\u540D", "Show account names"), {
      size: "sm",
      onClick: () => void run(async () => {
        const nextMasked = !(state?.emailsMasked ?? true);
        state = await invoke("set-mask", { masked: nextMasked });
        broadcastPanelSync({ kind: "mask", instanceName: name, source: "auth" });
      })
    });
    toggleMaskBtn.hidden = true;
    const refreshQuotasBtn = ui.button(t("\u5237\u65B0\u5404\u53F7\u989D\u5EA6", "Refresh quotas"), {
      size: "sm",
      onClick: () => void run(async () => {
        state = await invoke("refresh-quotas");
        broadcastPanelSync({ kind: "quota", instanceName: name, source: "auth" });
        message.textContent = t("\u5DF2\u66F4\u65B0\u8D26\u53F7\u5468\u989D\u5EA6\u4E0E 5h \u4F59\u91CF\u3002", "Updated weekly and 5h quotas for all accounts.");
      })
    });
    refreshQuotasBtn.hidden = true;
    headerRow.append(pill, toggleMaskBtn, refreshQuotasBtn);
    const actions = ui.rowbar();
    const loginBtn = ui.button(t("\u6253\u5F00\u6D4F\u89C8\u5668\u8BA4\u8BC1", "Sign in with Browser"), {
      variant: "primary",
      onClick: () => void beginLogin({ forceAccountSelect: Boolean(state?.accounts.length) })
    });
    const viewTermsBtn = ui.button(t("\u67E5\u770B\u670D\u52A1\u6761\u6B3E", "View Terms"), {
      onClick: () => {
        const url = "https://policies.google.com/terms";
        try {
          window.open(url, "_blank", "noopener,noreferrer");
        } catch {
        }
      }
    });
    const cancelBtn = ui.button(t("\u53D6\u6D88\u7B49\u5F85", "Cancel"), {
      onClick: () => void run(async () => {
        state = await invoke("cancel-login");
        authLink.hidden = true;
        copyRow.hidden = true;
      })
    });
    const clearAllBtn = ui.button(t("\u6E05\u7A7A\u5168\u90E8\u8D26\u53F7", "Sign out all"), {
      variant: "danger",
      onClick: () => void run(async () => {
        state = await invoke("logout");
        authLink.hidden = true;
        copyRow.hidden = true;
        message.textContent = t("\u5DF2\u6E05\u9664\u5168\u90E8\u672C\u5730 OAuth \u8D26\u53F7\u51ED\u8BC1\u3002", "Cleared all local OAuth tokens.");
        await ctx.refresh();
      })
    });
    actions.append(loginBtn, viewTermsBtn, cancelBtn, clearAllBtn);
    const routingSelect = ui.select({
      options: [
        { value: "failover", label: t("\u4E3B\u5907\u6545\u969C\u8F6C\u79FB\uFF08\u9ED8\u8BA4\uFF1A\u4F18\u5148\u4E3B\u7528\u53F7\uFF0C429/\u964D\u7EA7\u81EA\u52A8\u5207\u5907\u7528\uFF09", "Failover (default: primary first, auto-switch on 429)") },
        { value: "round-robin", label: t("\u8F6E\u8BE2\u5747\u8861\uFF08\u65E0\u4E3B\u4ECE\u533A\u5206\uFF0C\u5E73\u7B49\u8F6E\u6D41\u4F7F\u7528\u5065\u5EB7\u8D26\u53F7\uFF09", "Round-robin (equal peers, rotate healthy accounts)") },
        { value: "least-used", label: t("\u6309\u4F59\u91CF\u4F18\u5148\uFF08\u4F18\u5148\u4F7F\u7528\u5468\u989D\u5EA6\u5269\u4F59\u6700\u591A\u7684\u53EF\u7528\u8D26\u53F7\uFF09", "Least-used (highest weekly remaining quota first)") }
      ],
      onChange: (value) => {
        const routing = value;
        void run(async () => {
          state = await invoke("set-routing", { routing });
          broadcastPanelSync({ kind: "routing", instanceName: name, routing });
          const needsQuotaFetch = routing !== "failover" && state.signedIn && state.accounts.some((a) => a.weeklyRemaining === void 0);
          if (needsQuotaFetch) {
            state = await invoke("refresh-quotas");
            broadcastPanelSync({ kind: "quota", instanceName: name, source: "auth" });
          }
          message.textContent = t(
            "\u5DF2\u5207\u6362\u591A\u8D26\u53F7\u8C03\u5EA6\u7B56\u7565\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09\u3002",
            "Updated multi-account routing strategy. Click Save below to persist."
          );
        });
      }
    });
    const routingField = ui.field(t("\u591A\u8D26\u53F7\u8C03\u5EA6\u7B56\u7565", "Account routing strategy"), routingSelect);
    routingField.hidden = true;
    const routingHint = ui.h("div", "ggw-routing-hint");
    routingHint.hidden = true;
    const pendingNote = ui.h("div", "sh-desc");
    pendingNote.hidden = true;
    let currentCopyUrl = "";
    const setCopyUrl = (u) => {
      currentCopyUrl = u;
    };
    const authLink = ui.h("a", "ggw-link", t("\u70B9\u51FB\u6253\u5F00\u6D4F\u89C8\u5668\u6388\u6743\u9875", "Open authorization page"));
    authLink.target = "_blank";
    authLink.rel = "noopener noreferrer";
    authLink.hidden = true;
    const copyRow = ui.rowbar();
    copyRow.hidden = true;
    copyRow.append(
      authLink,
      ui.copyButton(() => currentCopyUrl, { label: t("\u590D\u5236\u6388\u6743\u94FE\u63A5", "Copy URL") })
    );
    const manualBox = ui.h("div", "ggw-manual");
    manualBox.hidden = true;
    const manualInput = ui.input({
      placeholder: "http://localhost:PORT/?code=...&state=...",
      cls: "mono"
    });
    const manualBtn = ui.button(t("\u63D0\u4EA4\u56DE\u8C03\u5730\u5740", "Submit callback URL"), {
      size: "sm",
      onClick: () => void run(async () => {
        state = await invoke("complete-login", { redirectUrl: manualInput.value });
        manualInput.value = "";
        authLink.hidden = true;
        copyRow.hidden = true;
        message.textContent = t("\u8BA4\u8BC1\u5B8C\u6210\u5E76\u5DF2\u672C\u5730\u4FDD\u5B58\uFF0C\u53EF\u76F4\u63A5\u6D4B\u8BD5\u8FDE\u63A5\u6216\u5BF9\u8BDD\u8C03\u7528\u3002", "Authenticated and saved locally; ready to call.");
        await ctx.refresh();
      })
    });
    const manualRow = ui.rowbar();
    manualRow.append(manualInput, manualBtn);
    manualBox.append(
      ui.h("div", "sh-desc", t("\u82E5\u6D4F\u89C8\u5668\u5728\u5176\u4ED6\u8BBE\u5907\u6216\u56DE\u73AF\u56DE\u8C03\u88AB\u62E6\u622A\uFF0C\u53EF\u5C06\u6388\u6743\u540E\u5730\u5740\u680F\u7684\u5B8C\u6574\u56DE\u8C03 URL \u7C98\u8D34\u5230\u6B64\u5904\uFF1A", "If browser callback cannot reach localhost directly, paste the redirected callback URL here:")),
      manualRow
    );
    const accountsBox = ui.h("div", "ggw-account-list");
    const infoBox = ui.h("div");
    const termsHint = ui.h("div", "sh-desc");
    const termsLink = ui.h("a", "ggw-link", t("Google \u670D\u52A1\u6761\u6B3E (policies.google.com/terms)", "Google Terms of Service"));
    termsLink.href = "https://policies.google.com/terms";
    termsLink.target = "_blank";
    termsLink.rel = "noopener noreferrer";
    termsHint.append(
      t("\u9996\u6B21\u901A\u8FC7 Robin \u684C\u9762\u63A5\u53E3\u8C03\u7528\u65F6\uFF0C\u82E5\u67D0\u4E2A\u8D26\u53F7\u63D0\u793A\u63A5\u53D7\u670D\u52A1\u6761\u6B3E\uFF0C\u53EF\u5148\u70B9\u51FB\u300C\u67E5\u770B\u670D\u52A1\u6761\u6B3E\u300D\uFF08\u6216\u8BBF\u95EE ", 'If Google requests ToS confirmation on first Robin call for an account, click "View Terms" (or open '),
      termsLink,
      t("\uFF09\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u518D\u70B9\u51FB\u8BE5\u8D26\u53F7\u5361\u7247\u4E0A\u7684\u300C\u540C\u610F\u6761\u6B3E\u300D\u3002", ') and then click "Accept Terms" on that account card.')
    );
    termsHint.hidden = true;
    const message = ui.msgline();
    const cfgDetails = ui.h("details", "ggw-details");
    cfgDetails.append(ui.h("summary", "", t("OAuth \u5BA2\u6237\u7AEF\u914D\u7F6E (desktop-oauth.json)", "OAuth client configuration (desktop-oauth.json)")));
    const cfgHint = ui.h("div", "sh-desc");
    const cfgTextarea = ui.textarea({ rows: 10, cls: "mono" });
    const cfgActions = ui.rowbar();
    const saveCfgBtn = ui.button(t("\u4FDD\u5B58 OAuth \u914D\u7F6E", "Save OAuth config"), {
      size: "sm",
      variant: "primary",
      onClick: () => void run(async () => {
        state = await invoke("save-oauth-config", { json: cfgTextarea.value });
        await loadOAuthConfig();
        if (state.configured) cfgDetails.open = false;
        message.textContent = t(
          "OAuth \u5BA2\u6237\u7AEF\u914D\u7F6E\u5DF2\u4FDD\u5B58\u5230\u672C\u5730\uFF0C\u73B0\u5728\u53EF\u4EE5\u70B9\u51FB\u4E0A\u65B9\u300C\u6253\u5F00\u6D4F\u89C8\u5668\u8BA4\u8BC1\u300D\u3002",
          "OAuth configuration saved locally. You can now click Sign in with Browser above."
        );
      })
    });
    const copyCfgBtn = ui.copyButton(() => cfgTextarea.value, {
      label: t("\u590D\u5236\u5F53\u524D\u914D\u7F6E", "Copy config")
    });
    const resetCfgBtn = ui.button(t("\u6E05\u7A7A\u5DF2\u4FDD\u5B58\u914D\u7F6E", "Clear saved config"), {
      size: "sm",
      onClick: () => void run(async () => {
        state = await invoke("reset-oauth-config");
        await loadOAuthConfig();
        message.textContent = state.configured ? t("\u5DF2\u6062\u590D\u9ED8\u8BA4 OAuth \u914D\u7F6E\u3002", "Reset to default OAuth configuration.") : t("\u5DF2\u6E05\u7A7A\u672C\u5730 OAuth \u914D\u7F6E\uFF0C\u8BF7\u586B\u5165\u6709\u6548 JSON \u540E\u91CD\u65B0\u4FDD\u5B58\u3002", "Cleared saved OAuth config. Paste a valid JSON below and save.");
      })
    });
    cfgActions.append(saveCfgBtn, copyCfgBtn, resetCfgBtn);
    cfgDetails.append(cfgHint, cfgTextarea, cfgActions);
    let cfgLoaded = false;
    let autoOpenedCfg = false;
    async function loadOAuthConfig() {
      const cfg = await invoke("oauth-config");
      if (signal.aborted) return;
      cfgTextarea.value = cfg.text;
      cfgHint.textContent = cfg.custom ? t(
        "\u5F53\u524D\u4F7F\u7528\u6B64\u7AEF\u70B9\u672C\u5730\u4FDD\u5B58\u7684 desktop-oauth.json\u3002\u5982\u9700\u5907\u4EFD\u6216\u5206\u4EAB\u7ED9\u5176\u4ED6\u7528\u6237\uFF0C\u53EF\u70B9\u51FB\u300C\u590D\u5236\u5F53\u524D\u914D\u7F6E\u300D\u3002",
        "Using local desktop-oauth.json saved for this endpoint. Click Copy config to export or share."
      ) : t(
        "\u672C\u6269\u5C55\u4E0D\u5185\u7F6E OAuth \u5BA2\u6237\u7AEF\u51ED\u636E\u3002\u8BF7\u5C06\u5B8C\u6574\u7684 desktop-oauth.json\uFF08\u542B clientId / clientSecret\uFF09\u7C98\u8D34\u5230\u4E0B\u65B9\u5E76\u70B9\u51FB\u300C\u4FDD\u5B58 OAuth \u914D\u7F6E\u300D\uFF1B\u6216\u5148\u5728\u7B2C\u4E00\u6B65\u5207\u6362\u81F3\u300CWeb2API Gemini\u300D\u4F7F\u7528\u5B98\u65B9 API Key\u3002",
        "No OAuth credentials are bundled in this package. Paste your desktop-oauth.json (with clientId / clientSecret) below and click Save, or switch Step 1 to Web2API Gemini with an API Key."
      );
      cfgLoaded = true;
    }
    cfgDetails.addEventListener("toggle", () => {
      if (cfgDetails.open && !cfgLoaded) void loadOAuthConfig().catch((err) => {
        message.textContent = String(err);
        message.classList.add("bad");
      });
    }, { signal });
    const oauthSection = ui.h("div", "ggw-section");
    oauthSection.append(actions, routingField, routingHint, pendingNote, copyRow, manualBox, accountsBox, infoBox, termsHint, cfgDetails);
    const apiKeySection = ui.h("div", "ggw-section");
    apiKeySection.hidden = true;
    const apiKeyDesc = ui.h("div", "sh-desc");
    const apiKeyInput = ui.input({
      type: "password",
      cls: "mono",
      placeholder: t("\u7C98\u8D34 API Key\uFF08\u4F8B\u5982 AIzaSy... \u6216 sk-...\uFF09", "Paste API Key (e.g. AIzaSy... or sk-...)")
    });
    const apiKeyField = ui.field(t("API Key", "API Key"), apiKeyInput);
    const headerPresetSelect = ui.select({
      options: [
        { value: "goog", label: t("x-goog-api-key\uFF08Gemini / Web2API \u539F\u751F\u9ED8\u8BA4\uFF09", "x-goog-api-key (Gemini / Web2API default)") },
        { value: "bearer", label: t("Authorization: Bearer <Key>\uFF08\u901A\u7528\u4EE3\u7406\u7F51\u5173\uFF09", "Authorization: Bearer <Key> (Bearer proxy)") },
        { value: "custom", label: t("\u81EA\u5B9A\u4E49\u8BF7\u6C42\u5934\u4E0E\u524D\u7F00", "Custom header & prefix") }
      ],
      onChange: (value) => {
        if (value === "goog") {
          credHeaderInput.value = "x-goog-api-key";
          credPrefixInput.value = "";
        } else if (value === "bearer") {
          credHeaderInput.value = "Authorization";
          credPrefixInput.value = "Bearer ";
        }
        customCredGrid.hidden = value !== "custom" && state?.protocol !== "rpc";
      }
    });
    const headerPresetField = ui.field(t("\u5BC6\u94A5\u8BF7\u6C42\u5934\u683C\u5F0F", "Credential header format"), headerPresetSelect);
    const credHeaderInput = ui.input({ cls: "mono", placeholder: "x-goog-api-key" });
    const credPrefixInput = ui.input({ cls: "mono", placeholder: "Bearer " });
    const customCredGrid = ui.h("div", "ggw-two-col");
    customCredGrid.append(
      ui.field(t("\u8BF7\u6C42\u5934\u540D\u79F0 (credentialHeader)", "Header name (credentialHeader)"), credHeaderInput),
      ui.field(t("\u5BC6\u94A5\u524D\u7F00 (credentialPrefix)", "Key prefix (credentialPrefix)"), credPrefixInput)
    );
    customCredGrid.hidden = true;
    const apiKeyActions = ui.rowbar();
    const saveApiKeyBtn = ui.button(t("\u4FDD\u5B58 API Key", "Save API Key"), {
      size: "sm",
      variant: "primary",
      onClick: () => void run(async () => {
        const typedKey = apiKeyInput.value.trim();
        if (!typedKey && !state?.apiKeyConfigured && !secretVarInput.value.trim()) {
          throw new Error(t("\u8BF7\u5148\u8F93\u5165 API Key \u6216\u586B\u5199\u73AF\u5883\u53D8\u91CF\u540D\u3002", "Enter an API Key or .env variable name first."));
        }
        state = await invoke("save-api-key", {
          ...typedKey ? { apiKey: typedKey } : {},
          credentialHeader: credHeaderInput.value,
          credentialPrefix: credPrefixInput.value,
          secretVar: secretVarInput.value
        });
        apiKeyInput.value = "";
        message.textContent = typedKey ? t("API Key \u5DF2\u672C\u5730\u4FDD\u5B58\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u4EE5\u540C\u6B65\u7AEF\u70B9\u914D\u7F6E\uFF09\u3002", "API Key saved locally. Click Save below to persist endpoint options.") : t("\u9274\u6743\u8BF7\u6C42\u5934\u8BBE\u7F6E\u5DF2\u540C\u6B65\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09\u3002", "Credential header options synced. Click Save below to persist.");
        await ctx.refresh();
      })
    });
    const clearApiKeyBtn = ui.button(t("\u6E05\u9664\u672C\u5730\u5BC6\u94A5", "Clear saved key"), {
      size: "sm",
      variant: "danger",
      onClick: () => void run(async () => {
        state = await invoke("clear-api-key");
        apiKeyInput.value = "";
        message.textContent = t("\u5DF2\u6E05\u9664\u672C\u5730\u4FDD\u5B58\u7684 API Key\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09\u3002", "Cleared saved API Key. Click Save below to persist.");
        await ctx.refresh();
      })
    });
    clearApiKeyBtn.hidden = true;
    apiKeyActions.append(saveApiKeyBtn, clearApiKeyBtn);
    const envDetails = ui.h("details", "ggw-details");
    envDetails.append(ui.h("summary", "", t("\u9AD8\u7EA7\uFF1A\u6539\u7528 .env \u73AF\u5883\u53D8\u91CF\u540D\uFF08\u53EF\u9009\uFF09", "Advanced: use .env secret variable name (optional)")));
    const secretVarInput = ui.input({ cls: "mono", placeholder: "GEMINI_API_KEY" });
    envDetails.append(
      ui.h("div", "sh-desc", t("\u5982\u5E0C\u671B\u7531\u7AEF\u70B9\u76EE\u5F55 .env \u6587\u4EF6\u63D0\u4F9B\u5BC6\u94A5\uFF0C\u53EF\u586B\u5199\u53D8\u91CF\u540D\uFF1B\u4E0A\u65B9\u76F4\u63A5\u586B\u5165\u7684 API Key \u4F18\u5148\u3002", "Optionally reference a variable in the endpoint .env file; a directly saved API Key above takes precedence.")),
      ui.field(t("\u5BC6\u94A5\u73AF\u5883\u53D8\u91CF\u540D (secret)", "Secret env variable (secret)"), secretVarInput)
    );
    apiKeySection.append(apiKeyDesc, apiKeyField, headerPresetField, customCredGrid, apiKeyActions, envDetails);
    root.append(headerRow, oauthSection, apiKeySection, message);
    let state;
    let working = false;
    let polling = false;
    let wasSignedIn = false;
    let wasPending = false;
    let wasAccountCount = 0;
    let accountsFingerprint = "";
    let lastApiKeyFormKey = "";
    async function invoke(method, values = {}) {
      return ctx.invoke(method, [{ name, ...values }]);
    }
    async function beginLogin(opts = {}) {
      await run(async () => {
        const res = await invoke("login", opts);
        if (signal.aborted) return;
        state = res.status;
        const safeUrl = safeExternalUrl(res.url);
        authLink.href = safeUrl;
        authLink.hidden = false;
        setCopyUrl(safeUrl);
        copyRow.hidden = false;
        if (opts.targetAccountId) {
          message.textContent = t(
            "\u5DF2\u8BF7\u6C42\u6253\u5F00\u6D4F\u89C8\u5668\u91CD\u65B0\u8BA4\u8BC1\u8BE5\u8D26\u53F7\uFF1B\u82E5\u672A\u81EA\u52A8\u5F39\u51FA\uFF0C\u53EF\u70B9\u51FB\u4E0B\u65B9\u94FE\u63A5\u6216\u590D\u5236\u5730\u5740\u6253\u5F00\u3002",
            "Opening your browser to re-authenticate this account. Use the link or copy button below if needed."
          );
        } else if (opts.forceAccountSelect) {
          message.textContent = t(
            "\u5DF2\u8BF7\u6C42\u6253\u5F00\u6D4F\u89C8\u5668\u6DFB\u52A0\u65B0\u8D26\u53F7\uFF0C\u8BF7\u5728 Google \u9875\u9762\u9009\u62E9\u8981\u65B0\u589E\u7684\u8D26\u53F7\uFF1B\u82E5\u672A\u81EA\u52A8\u5F39\u51FA\uFF0C\u53EF\u70B9\u51FB\u4E0B\u65B9\u94FE\u63A5\u3002",
            "Opening your browser to add another account. Pick the account to add in Google sign-in."
          );
        } else {
          message.textContent = t(
            "\u5DF2\u8BF7\u6C42\u6253\u5F00\u7CFB\u7EDF\u6D4F\u89C8\u5668\uFF0C\u8BF7\u5B8C\u6210\u6388\u6743\uFF1B\u82E5\u672A\u81EA\u52A8\u5F39\u51FA\uFF0C\u53EF\u70B9\u51FB\u4E0B\u65B9\u94FE\u63A5\u6216\u590D\u5236\u5730\u5740\u6253\u5F00\u3002",
            "Opening your browser for authorization. If nothing opened, use the link or copy button below."
          );
        }
        try {
          window.open(safeUrl, "_blank", "noopener,noreferrer");
        } catch {
        }
      });
    }
    function renderInlineWeeklyQuota(acct, routing) {
      const box = ui.h("div", "ggw-acct-quota");
      const head = ui.h("div", "ggw-acct-quota-head");
      const lbl = ui.h(
        "span",
        "ggw-qbar-lbl",
        routing === "least-used" ? t("\u5468\u989D\u5EA6\u4F59\u91CF\uFF08\u8C03\u5EA6\u4F9D\u636E\uFF09", "Weekly quota left (priority)") : t("\u6BCF\u5468\u989D\u5EA6", "Weekly quota")
      );
      if (acct.weeklyRemaining === void 0) {
        const val2 = ui.h("span", "ggw-acct-quota-sub", t("\u5F85\u67E5\u8BE2\uFF08\u70B9\u300C\u5237\u65B0\u5404\u53F7\u989D\u5EA6\u300D\u83B7\u53D6\uFF09", "Not loaded yet"));
        head.append(lbl, val2);
        box.append(head);
        return box;
      }
      const remaining = Math.min(Math.max(acct.weeklyRemaining, 0), 100);
      const used = Math.round((100 - remaining) * 10) / 10;
      const tone = remaining <= 10 ? "bad" : remaining <= 25 ? "warn" : "";
      const val = ui.h("span", tone ? `ggw-acct-quota-main ${tone}` : "ggw-acct-quota-main", t(`\u5468\u5269\u4F59 ${remaining}%`, `${remaining}% left`));
      head.append(lbl, val);
      const track = ui.h("div", "ggw-qbar-track");
      const fill = ui.h("div", tone ? `ggw-qbar-fill ${tone}` : "ggw-qbar-fill");
      fill.style.width = `${used}%`;
      track.append(fill);
      const subParts = [t(`\u5DF2\u7528 ${used}%`, `${used}% used`)];
      if (acct.fiveHourRemaining !== void 0) {
        subParts.push(t(`5h \u5269\u4F59 ${acct.fiveHourRemaining}%`, `5h left ${acct.fiveHourRemaining}%`));
      }
      if (acct.weeklyResetsAt) {
        const resetMs = Date.parse(acct.weeklyResetsAt) - Date.now();
        if (Number.isFinite(resetMs)) subParts.push(formatDuration(resetMs, zh));
      }
      const sub = ui.h("div", "ggw-acct-quota-sub", subParts.join(" \xB7 "));
      box.append(head, track, sub);
      return box;
    }
    function renderAccountCard(acct, protocol, masked, routing, index, isTopPriority) {
      const highlight = routing === "failover" ? acct.isPrimary : routing === "least-used" && isTopPriority;
      const card = ui.h("div", highlight ? "ggw-account-card is-primary" : "ggw-account-card");
      const head = ui.h("div", "ggw-account-head");
      const ident = ui.h("div", "ggw-account-ident");
      const display = accountDisplayName(acct.id, acct.email, zh, masked);
      const emailEl = ui.h("span", "ggw-account-email", display);
      emailEl.title = display;
      ident.append(emailEl);
      const leftTags = ui.h("span", "ggw-tags");
      if (routing === "failover") {
        leftTags.append(
          acct.isPrimary ? ui.h("span", "ggw-tag primary", t("\u4E3B\u7528", "Primary")) : ui.h("span", "ggw-tag", t("\u5907\u7528", "Backup"))
        );
      } else if (routing === "round-robin") {
        leftTags.append(ui.h("span", "ggw-tag", t(`\u8F6E\u8BE2 #${index + 1}`, `Pool #${index + 1}`)));
      } else if (isTopPriority) {
        leftTags.append(ui.h("span", "ggw-tag primary", t("\u5F53\u524D\u4F18\u5148", "Next up")));
      } else {
        leftTags.append(ui.h("span", "ggw-tag", t(`\u4F59\u91CF #${index + 1}`, `Rank #${index + 1}`)));
      }
      if (acct.plan) {
        leftTags.append(ui.h("span", "ggw-tag plan", acct.plan));
      }
      ident.append(leftTags);
      const rightTags = ui.h("span", "ggw-tags");
      if (routing === "least-used" && acct.weeklyRemaining !== void 0) {
        const tone = acct.weeklyRemaining <= 10 ? "bad" : acct.weeklyRemaining <= 25 ? "warn" : "primary";
        rightTags.append(ui.h("span", `ggw-tag ${tone}`, t(`\u5468\u4F59 ${acct.weeklyRemaining}%`, `${acct.weeklyRemaining}% wk`)));
      }
      if (protocol === "robin") {
        if (acct.termsStatus === "required") {
          const tosTag = ui.h("span", "ggw-tag bad", t("\u672A\u540C\u610F\u6761\u6B3E", "Terms required"));
          tosTag.title = t("\u8C03\u7528\u65F6\u8FD4\u56DE\u672A\u540C\u610F\u670D\u52A1\u6761\u6B3E\uFF0C\u8BF7\u70B9\u51FB\u300C\u540C\u610F\u6761\u6B3E\u300D\u5B8C\u6210\u786E\u8BA4", "Upstream reported Terms of Service not accepted yet; click Accept Terms");
          rightTags.append(tosTag);
        } else if (acct.termsStatus === "pending") {
          const tosTag = ui.h("span", "ggw-tag warn", t("\u5F85\u540C\u610F\u6761\u6B3E", "Terms pending"));
          tosTag.title = t("\u65B0\u5BFC\u5165\u8D26\u53F7\uFF0C\u5EFA\u8BAE\u70B9\u51FB\u300C\u540C\u610F\u6761\u6B3E\u300D\u786E\u8BA4\u670D\u52A1\u6761\u6B3E\uFF08\u6216\u9996\u6B21\u6210\u529F\u8C03\u7528\u540E\u81EA\u52A8\u6807\u8BB0\u5DF2\u540C\u610F\uFF09", "Newly added account; click Accept Terms or confirm automatically on first successful call");
          rightTags.append(tosTag);
        } else {
          const tosTag = ui.h("span", "ggw-tag ok", t("\u5DF2\u540C\u610F\u6761\u6B3E", "Terms accepted"));
          if (acct.termsVersion !== void 0) {
            tosTag.title = t(`\u5DF2\u786E\u8BA4 Gemini \u670D\u52A1\u6761\u6B3E v${acct.termsVersion}`, `Accepted Gemini Terms v${acct.termsVersion}`);
          }
          rightTags.append(tosTag);
        }
      }
      const cdText = formatCooldownLeft(acct.cooldownUntil, zh);
      if (cdText) {
        const cdTag = ui.h("span", "ggw-tag warn", cdText);
        if (acct.cooldownReason) cdTag.title = acct.cooldownReason;
        rightTags.append(cdTag);
      } else {
        rightTags.append(ui.h("span", "ggw-tag ok", t("\u5C31\u7EEA", "Ready")));
      }
      head.append(ident, rightTags);
      const meta = ui.h("div", "ggw-account-meta");
      meta.append(ui.h("span", "", formatShortExpiry(acct.expiresAt, zh)));
      if (routing === "failover") {
        if (acct.weeklyRemaining !== void 0) {
          meta.append(ui.h("span", "mono", t(`\u5468\u5269\u4F59 ${acct.weeklyRemaining}%`, `Weekly left ${acct.weeklyRemaining}%`)));
        }
        if (acct.fiveHourRemaining !== void 0) {
          meta.append(ui.h("span", "mono", t(`5h \u5269\u4F59 ${acct.fiveHourRemaining}%`, `5h left ${acct.fiveHourRemaining}%`)));
        }
      }
      const cardActions = ui.h("div", "ggw-account-actions");
      if (routing === "failover" && !acct.isPrimary) {
        const setPrimaryBtn = ui.button(t("\u8BBE\u4E3A\u4E3B\u7528", "Set primary"), {
          size: "sm",
          variant: "primary",
          onClick: () => void run(async () => {
            state = await invoke("set-primary", { accountId: acct.id });
            message.textContent = state.saved ? t(`\u5DF2\u5C06 ${display} \u8BBE\u4E3A\u4E3B\u7528\u8D26\u53F7\u3002`, `Set ${display} as primary account.`) : t(
              `\u5DF2\u5C06 ${display} \u8BBE\u4E3A\u4E3B\u7528\u8D26\u53F7\uFF08\u5982\u521A\u5207\u6362\u8FC7\u8C03\u5EA6\u7B56\u7565\uFF0C\u8BF7\u8BB0\u5F97\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09\u3002`,
              `Set ${display} as primary account (click Save below if you also changed the routing strategy).`
            );
            await ctx.refresh();
          })
        });
        setPrimaryBtn.disabled = working;
        cardActions.append(setPrimaryBtn);
      }
      if (protocol === "robin" && acct.termsStatus !== "accepted") {
        const termsBtn = ui.button(t("\u540C\u610F\u6761\u6B3E", "Accept Terms"), {
          size: "sm",
          ...acct.termsStatus === "required" ? { variant: "primary" } : {},
          onClick: () => void run(async () => {
            const res = await invoke(
              "accept-terms",
              { accountId: acct.id }
            );
            if (signal.aborted) return;
            state = res.status;
            message.textContent = t(
              `\u5DF2\u4E3A ${display} \u786E\u8BA4 Gemini \u670D\u52A1\u6761\u6B3E\uFF08\u7248\u672C v${res.version}\uFF09\u3002`,
              `Confirmed Gemini Terms of Service (v${res.version}) for ${display}.`
            );
          })
        });
        termsBtn.disabled = working;
        cardActions.append(termsBtn);
      }
      const reauthBtn = ui.button(t("\u91CD\u65B0\u8BA4\u8BC1", "Re-auth"), {
        size: "sm",
        onClick: () => void beginLogin({ targetAccountId: acct.id, forceAccountSelect: true })
      });
      reauthBtn.disabled = working || !state?.configured;
      const removeBtn = ui.button(t("\u79FB\u9664", "Remove"), {
        size: "sm",
        variant: "danger",
        onClick: () => void run(async () => {
          state = await invoke("logout", { accountId: acct.id });
          message.textContent = t(`\u5DF2\u79FB\u9664\u8D26\u53F7 ${display}\u3002`, `Removed account ${display}.`);
          await ctx.refresh();
        })
      });
      removeBtn.disabled = working;
      cardActions.append(reauthBtn, removeBtn);
      card.append(head);
      if (routing !== "failover") {
        card.append(renderInlineWeeklyQuota(acct, routing));
      }
      card.append(meta);
      if (acct.cooldownReason || acct.lastError) {
        card.append(ui.h("div", "ggw-account-err", acct.cooldownReason || acct.lastError || ""));
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
          state.protocol === "rpc" ? t("\u81EA\u5B9A\u4E49\u9274\u6743\u4E0E API \u5BC6\u94A5", "Custom Auth & API Key") : t("API \u5BC6\u94A5\u914D\u7F6E", "API Key")
        );
        if (state.apiKeyConfigured) {
          const hintSuffix = state.apiKeyHint ? `\uFF08${state.apiKeyHint}\uFF09` : "";
          pill.textContent = state.apiKeySource === "env" ? t(`API Key \u5DF2\u5C31\u7EEA\uFF08\u73AF\u5883\u53D8\u91CF\uFF09${hintSuffix}`, `API Key ready (env)${hintSuffix}`) : t(`API Key \u5DF2\u4FDD\u5B58${hintSuffix}`, `API Key saved${hintSuffix}`);
          pill.className = "pill on";
        } else {
          pill.textContent = t("\u5F85\u586B\u5199 API Key", "API Key required");
          pill.className = "pill off";
        }
        toggleMaskBtn.hidden = true;
        refreshQuotasBtn.hidden = true;
        apiKeyDesc.textContent = state.protocol === "rpc" ? t("\u8F93\u5165\u81EA\u5EFA RPC \u7F51\u5173\u7684 API Key\uFF0C\u5E76\u6309\u9700\u81EA\u5B9A\u4E49\u9274\u6743\u8BF7\u6C42\u5934\u4E0E\u524D\u7F00\u3002\u5BC6\u94A5\u4EE5 0600 \u6743\u9650\u4FDD\u5B58\u4E8E\u672C\u5730\u76EE\u5F55\uFF0C\u4E0D\u5199\u5165 config.json\u3002", "Enter the API Key for your custom RPC gateway and customize the auth header/prefix as needed.") : t("\u76F4\u63A5\u7C98\u8D34\u4F60\u7684 Gemini / Web2API \u5BC6\u94A5\u5E76\u70B9\u51FB\u4FDD\u5B58\u3002\u5BC6\u94A5\u4EE5 0600 \u6743\u9650\u4FDD\u5B58\u5728\u672C\u5730\u76EE\u5F55\uFF0C\u4E0D\u4F1A\u5199\u5165\u660E\u6587 config.json\u3002", "Paste your Gemini or Web2API API Key and click Save. Stored locally with 0600 permissions.");
        apiKeyInput.placeholder = state.apiKeyConfigured ? t(`\u5DF2\u914D\u7F6E\uFF08${state.apiKeyHint ?? "***"}\uFF09\uFF0C\u8F93\u5165\u65B0\u5BC6\u94A5\u53EF\u8986\u76D6`, `Configured (${state.apiKeyHint ?? "***"}); type a new key to replace`) : t("\u7C98\u8D34 API Key\uFF08\u4F8B\u5982 AIzaSy... \u6216 sk-...\uFF09", "Paste API Key (e.g. AIzaSy... or sk-...)");
        saveApiKeyBtn.disabled = working;
        clearApiKeyBtn.disabled = working;
        clearApiKeyBtn.hidden = state.apiKeySource !== "stored";
        const nextFormKey = JSON.stringify([state.protocol, state.credentialHeader, state.credentialPrefix, state.secretVar ?? ""]);
        if (!working && nextFormKey !== lastApiKeyFormKey) {
          lastApiKeyFormKey = nextFormKey;
          credHeaderInput.value = state.credentialHeader;
          credPrefixInput.value = state.credentialPrefix;
          secretVarInput.value = state.secretVar ?? "";
          const preset = state.credentialHeader === "x-goog-api-key" && state.credentialPrefix === "" ? "goog" : state.credentialHeader.toLowerCase() === "authorization" && state.credentialPrefix === "Bearer " ? "bearer" : "custom";
          headerPresetSelect.value = preset;
          customCredGrid.hidden = preset !== "custom" && state.protocol !== "rpc";
        }
        wasSignedIn = state.signedIn;
        wasPending = state.pending;
        wasAccountCount = count;
        return;
      }
      setPanelTitle(root, t("\u6D4F\u89C8\u5668 OAuth \u8BA4\u8BC1", "Browser OAuth"));
      if (!state.configured) {
        pill.textContent = t("\u5F85\u586B\u5199 OAuth \u914D\u7F6E", "OAuth config required");
        pill.className = "pill off";
        if (!autoOpenedCfg) {
          autoOpenedCfg = true;
          cfgDetails.open = true;
          if (!cfgLoaded) void loadOAuthConfig().catch(() => {
          });
        }
      } else if (count > 1) {
        pill.textContent = t(`\u5DF2\u8BA4\u8BC1\uFF08${count} \u4E2A\u8D26\u53F7 \xB7 \u8D26\u53F7\u6C60\u5C31\u7EEA\uFF09`, `Signed in (${count} accounts)`);
        pill.className = "pill on";
      } else if (state.signedIn) {
        pill.textContent = t("\u5DF2\u8BA4\u8BC1\uFF081 \u4E2A\u8D26\u53F7 \xB7 \u672C\u5730\u5DF2\u4FDD\u5B58\uFF09", "Signed in (1 account)");
        pill.className = "pill on";
      } else if (state.pending) {
        pill.textContent = t("\u7B49\u5F85\u6D4F\u89C8\u5668\u6388\u6743\u2026", "Waiting for browser\u2026");
        pill.className = "pill plain";
      } else {
        pill.textContent = t("\u672A\u8BA4\u8BC1", "Not signed in");
        pill.className = "pill off";
      }
      const masked = state.emailsMasked !== false;
      toggleMaskBtn.hidden = count === 0;
      toggleMaskBtn.disabled = working;
      toggleMaskBtn.textContent = masked ? t("\u663E\u793A\u8D26\u53F7\u540D", "Show account names") : t("\u9690\u85CF\u8D26\u53F7\u540D\uFF08\u8131\u654F\uFF09", "Mask account names");
      toggleMaskBtn.title = masked ? t("\u5F53\u524D\u5DF2\u5F00\u542F\u8131\u654F\uFF08\u4EC5\u663E\u793A\u9996\u5C3E\u5B57\uFF09\uFF0C\u70B9\u51FB\u663E\u793A\u5168\u90E8\u5B8C\u6574\u8D26\u53F7\u540D", "Emails are masked by default; click to reveal all full account names") : t("\u5F53\u524D\u663E\u793A\u5B8C\u6574\u8D26\u53F7\u540D\uFF0C\u70B9\u51FB\u91CD\u65B0\u9690\u85CF\u4E3A\u8131\u654F\u683C\u5F0F", "Showing full account names; click to mask all names again");
      loginBtn.disabled = working || !state.configured;
      loginBtn.textContent = state.pending ? t("\u91CD\u65B0\u6253\u5F00\u6D4F\u89C8\u5668\u8BA4\u8BC1", "Reopen browser auth") : count > 0 ? t("\u6DFB\u52A0\u8D26\u53F7\uFF08\u6D4F\u89C8\u5668\u767B\u5F55\uFF09", "Add account (Browser)") : t("\u6253\u5F00\u6D4F\u89C8\u5668\u8BA4\u8BC1", "Sign in with Browser");
      const showTerms = state.signedIn && state.protocol === "robin";
      const anyNeedsTerms = showTerms && state.accounts.some((a) => a.termsStatus !== "accepted");
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
      refreshQuotasBtn.hidden = count === 0 || state.protocol !== "robin";
      refreshQuotasBtn.disabled = working;
      routingField.hidden = !state.authEnabled;
      routingSelect.disabled = working;
      if (!working && routingSelect.value !== routing) {
        routingSelect.value = routing;
      }
      routingHint.hidden = !state.authEnabled || count === 0;
      if (routing === "round-robin") {
        routingHint.textContent = t(
          "\u5F53\u524D\u4E3A\u8F6E\u8BE2\u6A21\u5F0F\uFF1A\u6240\u6709\u8D26\u53F7\u5E73\u7B49\u53C2\u4E0E\u8F6E\u6D41\u8C03\u7528\uFF08\u65E0\u4E3B\u4ECE\u533A\u5206\uFF09\uFF0C\u5361\u7247\u4E2D\u5E73\u7B49\u5C55\u793A\u5404\u53F7\u5468\u989D\u5EA6\u3002",
          "Round-robin: all accounts rotate equally without primary/backup roles, showing weekly quota side by side."
        );
      } else if (routing === "least-used") {
        routingHint.textContent = t(
          "\u5F53\u524D\u4E3A\u989D\u5EA6\u4F18\u5148\u6A21\u5F0F\uFF1A\u81EA\u52A8\u6309\u5468\u989D\u5EA6\u5269\u4F59\u6BD4\u4F8B\u4ECE\u9AD8\u5230\u4F4E\u6392\u5E8F\u8C03\u5EA6\uFF08\u81EA\u52A8\u907F\u5F00\u51B7\u5374\u6216 5h \u8017\u5C3D\u8D26\u53F7\uFF09\u3002",
          "Least-used: routes to the available account with the highest weekly quota remaining."
        );
      } else {
        routingHint.textContent = t(
          "\u5F53\u524D\u4E3A\u4E3B\u5907\u6545\u969C\u8F6C\u79FB\u6A21\u5F0F\uFF1A\u4F18\u5148\u4F7F\u7528\u300C\u4E3B\u7528\u300D\u8D26\u53F7\uFF0C\u9047 429 / \u914D\u989D\u964D\u7EA7 / \u8BA4\u8BC1\u5F02\u5E38\u81EA\u52A8\u5207\u6362\u5907\u7528\u53F7\u3002",
          "Failover: uses the primary account first and automatically switches to backups on 429 or downgrade."
        );
      }
      if (state.pending) {
        const target = state.pendingTargetAccountId ? state.accounts.find((a) => a.id === state.pendingTargetAccountId) : void 0;
        pendingNote.textContent = target ? t(`\u6B63\u5728\u7B49\u5F85 ${accountDisplayName(target.id, target.email, zh, masked)} \u91CD\u65B0\u6388\u6743\u2026`, `Waiting to re-authenticate ${accountDisplayName(target.id, target.email, zh, masked)}\u2026`) : count > 0 ? t("\u6B63\u5728\u7B49\u5F85\u65B0\u589E\u8D26\u53F7\u5B8C\u6210\u6D4F\u89C8\u5668\u6388\u6743\u2026", "Waiting for the new account to finish browser authorization\u2026") : t("\u6B63\u5728\u7B49\u5F85\u6D4F\u89C8\u5668\u6388\u6743\u56DE\u8C03\u2026", "Waiting for browser OAuth callback\u2026");
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
      const minuteBucket = Math.floor(Date.now() / 3e4);
      const nextFp = JSON.stringify({
        working,
        configured: state.configured,
        protocol: state.protocol,
        routing,
        masked,
        accounts: state.accounts,
        cdBucket: state.accounts.some((a) => a.cooldownUntil && a.cooldownUntil > Date.now()) ? minuteBucket : 0
      });
      if (nextFp !== accountsFingerprint) {
        accountsFingerprint = nextFp;
        if (count === 0) {
          accountsBox.replaceChildren();
        } else {
          const now = Date.now();
          const displayed = routing === "least-used" ? sortLeastUsed(state.accounts, (a) => ({
            cooled: Boolean(a.cooldownUntil && a.cooldownUntil > now),
            cooldownUntil: a.cooldownUntil,
            fiveHourRemaining: a.fiveHourRemaining,
            weeklyRemaining: a.weeklyRemaining
          })) : state.accounts;
          const topId = routing === "least-used" ? displayed[0]?.id : void 0;
          accountsBox.replaceChildren(
            ...displayed.map((acct, index) => renderAccountCard(
              acct,
              state.protocol,
              masked,
              routing,
              index,
              Boolean(topId && acct.id === topId && !(acct.cooldownUntil && acct.cooldownUntil > now))
            ))
          );
        }
      }
      const rows = [
        state.clientId ? { k: t("\u5BA2\u6237\u7AEF ID", "Client ID"), v: state.clientId } : null,
        state.redirectUri ? { k: t("\u56DE\u8C03\u5730\u5740", "Redirect URI"), v: state.redirectUri } : null
      ].filter((r) => Boolean(r));
      infoBox.replaceChildren(...rows.length ? [ui.kv(rows)] : []);
      if (state.error) {
        message.textContent = state.error;
        message.classList.add("bad");
      } else if ((!wasSignedIn || wasPending || count > wasAccountCount) && !state.pending && state.signedIn) {
        message.textContent = count > 1 ? t(`\u8D26\u53F7\u8BA4\u8BC1\u6210\u529F\u5E76\u5DF2\u52A0\u5165\u8D26\u53F7\u6C60\uFF08\u5171 ${count} \u4E2A\u8D26\u53F7\uFF09\uFF0C\u53EF\u70B9\u51FB\u4E0B\u65B9\u300C\u7ACB\u5373\u67E5\u8BE2\u989D\u5EA6\u300D\u67E5\u770B\u5404\u53F7\u4F59\u91CF\u3002`, `Account added to pool (${count} accounts total). Query quota below to inspect all accounts.`) : t("\u8BA4\u8BC1\u6210\u529F\u5E76\u5DF2\u672C\u5730\u4FDD\u5B58\uFF0C\u73B0\u5728\u53EF\u4EE5\u76F4\u63A5\u300C\u6D4B\u8BD5\u8FDE\u63A5\u300D\u6216\u4FDD\u5B58\u540E\u76F4\u63A5\u8C03\u7528\u3002", "Signed in and saved locally. Ready to test or invoke directly.");
        message.classList.remove("bad");
      }
      wasSignedIn = state.signedIn;
      wasPending = state.pending;
      wasAccountCount = count;
    }
    async function refresh() {
      if (polling || working || signal.aborted) return;
      polling = true;
      try {
        const next = await invoke("status");
        if (signal.aborted || working) return;
        const accountChanged = next.signedIn !== wasSignedIn || next.accounts.length !== wasAccountCount;
        state = next;
        paint();
        if (accountChanged) await ctx.refresh();
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add("bad");
        }
      } finally {
        polling = false;
      }
    }
    async function run(action) {
      if (working || signal.aborted) return;
      working = true;
      message.textContent = "";
      message.classList.remove("bad");
      paint();
      try {
        await action();
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add("bad");
        }
      } finally {
        working = false;
        if (!signal.aborted) paint();
      }
    }
    const onPanelSync = (ev) => {
      if (ev.instanceName !== name) return;
      if (ev.kind === "gateway") {
        lastApiKeyFormKey = "";
        void refresh();
      } else if ((ev.kind === "mask" || ev.kind === "quota") && ev.source !== "auth") {
        void refresh();
      }
    };
    panelSyncListeners.add(onPanelSync);
    signal.addEventListener("abort", () => panelSyncListeners.delete(onPanelSync), { once: true });
    await refresh();
    ctx.interval(() => {
      void refresh();
    }, 2e3);
  }
};
var quotaPanel = {
  async mount(ctx) {
    const { ui, root, signal } = ctx;
    const zh = isZh(ctx);
    const t = (cn, en) => zh ? cn : en;
    const name = ctx.scope.instance;
    if (!name) return;
    root.classList.add("ggw-panel");
    let selectedAccountId = "all";
    let emailsMasked = true;
    let accountRouting = "failover";
    let currentProtocol = "robin";
    let currentQuotaEndpoint = "";
    let lastSnapshot;
    let savingRoutes = false;
    const customRoutesSection = ui.h("div", "ggw-section");
    customRoutesSection.hidden = true;
    const routesDesc = ui.h("div", "sh-desc");
    const genRouteInput = ui.input({ cls: "mono", placeholder: "generate?$alt=json" });
    const uploadRouteInput = ui.input({ cls: "mono", placeholder: "upload" });
    const deleteRouteInput = ui.input({ cls: "mono", placeholder: "conversations/{conversationId}" });
    const convHeaderInput = ui.input({ cls: "mono", placeholder: "x-conversation-id" });
    const quotaRouteInput = ui.input({ cls: "mono", placeholder: "/quota" });
    const genRouteField = ui.field(t("\u751F\u6210\u8DEF\u7531 (generationEndpoint)", "Generation endpoint"), genRouteInput);
    const uploadRouteField = ui.field(t("\u9644\u4EF6\u4E0A\u4F20\u8DEF\u7531 (uploadEndpoint\uFF0C\u53EF\u9009)", "Upload endpoint (optional)"), uploadRouteInput);
    const deleteRouteField = ui.field(t("\u4F1A\u8BDD\u6E05\u7406\u8DEF\u7531 (deleteEndpoint\uFF0C\u542B {conversationId}\uFF0C\u53EF\u9009)", "Delete endpoint with {conversationId} (optional)"), deleteRouteInput);
    const convHeaderField = ui.field(t("\u4F1A\u8BDD ID \u54CD\u5E94\u5934 (conversationHeader\uFF0C\u53EF\u9009)", "Conversation ID header (optional)"), convHeaderInput);
    const quotaRouteField = ui.field(t("\u81EA\u5B9A\u4E49\u989D\u5EA6\u67E5\u8BE2\u8DEF\u7531 (quotaEndpoint\uFF0C\u53EF\u9009)", "Quota endpoint (optional)"), quotaRouteInput);
    const routesActions = ui.rowbar();
    const saveRoutesBtn = ui.button(t("\u4FDD\u5B58\u81EA\u5B9A\u4E49\u8DEF\u7531", "Save custom routes"), {
      size: "sm",
      variant: "primary",
      onClick: () => void saveRoutes()
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
      routesMsg
    );
    const quotaSection = ui.h("div", "ggw-section");
    const topBar = ui.h("div", "ggw-quota-toolbar");
    const accountSelect = ui.select({
      options: [{ value: "all", label: t("\u5168\u90E8\u8D26\u53F7", "All accounts") }],
      onChange: (value) => {
        selectedAccountId = value || "all";
        void fetchQuota(true);
      }
    });
    accountSelect.classList.add("ggw-quota-select");
    accountSelect.hidden = true;
    const queryBtn = ui.button(t("\u7ACB\u5373\u67E5\u8BE2\u989D\u5EA6", "Query quota"), {
      size: "sm",
      variant: "primary",
      onClick: () => void fetchQuota(true)
    });
    const toggleMaskBtn = ui.button(t("\u663E\u793A\u8D26\u53F7\u540D", "Show account names"), {
      size: "sm",
      onClick: () => void toggleQuotaMask()
    });
    toggleMaskBtn.hidden = true;
    const planPill = ui.pill(t("\u672A\u67E5\u8BE2", "Idle"), "plain");
    topBar.append(accountSelect, queryBtn, toggleMaskBtn, planPill);
    const cardsBox = ui.h("div", "ggw-quota-cards");
    const footnote = ui.h("div", "sh-desc");
    const message = ui.msgline();
    quotaSection.append(topBar, cardsBox, footnote, message);
    root.append(customRoutesSection, quotaSection);
    function applyRoutesView(routes) {
      currentProtocol = routes.protocol;
      currentQuotaEndpoint = routes.quotaEndpoint.trim();
      const isRobin = routes.protocol === "robin";
      const isRpc = routes.protocol === "rpc";
      setPanelTitle(
        root,
        isRobin ? t("\u989D\u5EA6\u67E5\u8BE2", "Quota & Usage") : isRpc ? t("\u81EA\u5B9A\u4E49\u8DEF\u7531\u4E0E\u7AEF\u70B9", "Custom RPC Routes") : t("\u81EA\u5B9A\u4E49\u63A5\u53E3\u4E0E\u989D\u5EA6", "Custom Endpoints & Quota")
      );
      customRoutesSection.hidden = isRobin;
      quotaSection.hidden = !isRobin && !currentQuotaEndpoint;
      if (!isRobin) {
        routesDesc.textContent = isRpc ? t("\u914D\u7F6E\u81EA\u5EFA RPC \u7F51\u5173\u7684\u751F\u6210\u3001\u4E0A\u4F20\u3001\u4F1A\u8BDD\u6E05\u7406\u4E0E\u53EF\u9009\u989D\u5EA6\u67E5\u8BE2\u8DEF\u7531\uFF08\u7559\u7A7A\u5219\u4F7F\u7528\u9ED8\u8BA4\u503C\uFF09\u3002", "Customize generation, upload, cleanup, and optional quota routes for your RPC gateway.") : t("\u6309\u9700\u8986\u76D6 Web2API Gemini \u7684\u6D41\u5F0F\u751F\u6210\u3001\u9644\u4EF6\u4E0A\u4F20\u6216\u989D\u5EA6\u67E5\u8BE2\u8DEF\u7531\uFF08\u7559\u7A7A\u5219\u4F7F\u7528 Gemini \u9ED8\u8BA4\u8DEF\u7531\uFF09\u3002", "Override Web2API Gemini generation, upload, or optional quota routes (leave blank for defaults).");
        genRouteInput.placeholder = isRpc ? "generate?$alt=json" : "v1beta/models/{model}:streamGenerateContent?alt=sse";
        genRouteInput.value = routes.generationEndpoint;
        uploadRouteInput.value = routes.uploadEndpoint;
        deleteRouteInput.value = routes.deleteEndpoint;
        convHeaderInput.value = routes.conversationHeader;
        quotaRouteInput.value = routes.quotaEndpoint;
        deleteRouteField.hidden = !isRpc;
        convHeaderField.hidden = !isRpc;
        saveRoutesBtn.textContent = isRpc ? t("\u4FDD\u5B58\u81EA\u5B9A\u4E49\u8DEF\u7531", "Save custom routes") : t("\u4FDD\u5B58\u63A5\u53E3\u914D\u7F6E", "Save endpoints");
      }
    }
    async function loadRoutesState() {
      try {
        const routes = await ctx.invoke("routes-state", [{ name }]);
        if (signal.aborted) return void 0;
        applyRoutesView(routes);
        return routes;
      } catch {
        return void 0;
      }
    }
    async function saveRoutes() {
      if (savingRoutes || signal.aborted) return;
      savingRoutes = true;
      saveRoutesBtn.disabled = true;
      routesMsg.textContent = "";
      routesMsg.classList.remove("bad");
      try {
        const routes = await ctx.invoke("save-routes", [{
          name,
          generationEndpoint: genRouteInput.value,
          uploadEndpoint: uploadRouteInput.value,
          ...currentProtocol === "rpc" ? {
            deleteEndpoint: deleteRouteInput.value,
            conversationHeader: convHeaderInput.value
          } : {},
          quotaEndpoint: quotaRouteInput.value
        }]);
        if (signal.aborted) return;
        applyRoutesView(routes);
        routesMsg.textContent = t("\u81EA\u5B9A\u4E49\u8DEF\u7531\u5DF2\u540C\u6B65\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09\u3002", "Custom routes synced. Click Save below to persist.");
      } catch (err) {
        if (!signal.aborted) {
          routesMsg.textContent = err instanceof Error ? err.message : String(err);
          routesMsg.classList.add("bad");
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
      toggleMaskBtn.textContent = emailsMasked ? t("\u663E\u793A\u8D26\u53F7\u540D", "Show account names") : t("\u9690\u85CF\u8D26\u53F7\u540D\uFF08\u8131\u654F\uFF09", "Mask account names");
      toggleMaskBtn.title = emailsMasked ? t("\u5F53\u524D\u5DF2\u5F00\u542F\u8131\u654F\uFF08\u4EC5\u663E\u793A\u9996\u5C3E\u5B57\uFF09\uFF0C\u70B9\u51FB\u663E\u793A\u5168\u90E8\u5B8C\u6574\u8D26\u53F7\u540D", "Emails are masked by default; click to reveal all full account names") : t("\u5F53\u524D\u663E\u793A\u5B8C\u6574\u8D26\u53F7\u540D\uFF0C\u70B9\u51FB\u91CD\u65B0\u9690\u85CF\u4E3A\u8131\u654F\u683C\u5F0F", "Showing full account names; click to mask all names again");
    }
    function applyLabelsToSnapshot(labels) {
      emailsMasked = labels.emailsMasked;
      accountRouting = labels.accountRouting;
      if (!lastSnapshot) {
        updateMaskButton();
        return;
      }
      const emailMap = new Map(labels.accountOptions.map((o) => [o.id, o.email]));
      const next = {
        ...lastSnapshot,
        emailsMasked: labels.emailsMasked,
        accountRouting: labels.accountRouting,
        accountOptions: labels.accountOptions,
        ...lastSnapshot.accounts ? {
          accounts: lastSnapshot.accounts.map((acct) => {
            const nextEmail = emailMap.get(acct.accountId);
            return {
              ...acct,
              ...nextEmail !== void 0 ? { email: nextEmail } : {}
            };
          })
        } : {}
      };
      renderSnapshot(next);
    }
    async function toggleQuotaMask() {
      if (loading || signal.aborted) return;
      toggleMaskBtn.disabled = true;
      try {
        const res = await ctx.invoke("set-mask", [{ name, masked: !emailsMasked }]);
        if (signal.aborted) return;
        applyLabelsToSnapshot(res);
        broadcastPanelSync({ kind: "mask", instanceName: name, source: "quota" });
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add("bad");
        }
      } finally {
        if (!signal.aborted) updateMaskButton();
      }
    }
    async function syncLabelsFromServer() {
      if (signal.aborted) return;
      try {
        const res = await ctx.invoke("account-labels", [{ name }]);
        if (!signal.aborted) applyLabelsToSnapshot(res);
      } catch {
      }
    }
    function windowTitle(id, title) {
      if (id === "fiveHour") return t("5 \u5C0F\u65F6\u989D\u5EA6", "5-hour");
      if (id === "weekly") return t("\u6BCF\u5468\u989D\u5EA6", "Weekly");
      return title || id;
    }
    function syncAccountSelect(snap) {
      const opts = snap.accountOptions ?? [];
      if (opts.length === 0) {
        accountSelect.hidden = true;
        selectedAccountId = "all";
        return;
      }
      accountSelect.hidden = false;
      const validIds = /* @__PURE__ */ new Set(["all", ...opts.map((o) => o.id)]);
      if (!validIds.has(selectedAccountId)) {
        selectedAccountId = "all";
      }
      const masked = snap.emailsMasked !== false;
      const showPrimary = accountRouting === "failover";
      const nextOptions = [
        { value: "all", label: t(`\u5168\u90E8\u8D26\u53F7 (${opts.length})`, `All accounts (${opts.length})`) },
        ...opts.map((o) => {
          const base = accountDisplayName(o.id, o.email, zh, masked);
          return {
            value: o.id,
            label: showPrimary && o.isPrimary ? `${base} [${t("\u4E3B\u7528", "Primary")}]` : base
          };
        })
      ];
      accountSelect.replaceChildren(
        ...nextOptions.map((item) => {
          const el = document.createElement("option");
          el.value = item.value;
          el.textContent = item.label;
          return el;
        })
      );
      accountSelect.value = selectedAccountId;
    }
    function renderCompactBar(win) {
      const bar = ui.h("div", "ggw-qbar");
      const head = ui.h("div", "ggw-qbar-head");
      const lbl = ui.h("span", "ggw-qbar-lbl", windowTitle(win.id, win.title));
      const val = ui.h("span", "ggw-qbar-val");
      const remStrong = ui.h("b", "", t(`\u5269\u4F59 ${win.remainingPercent}%`, `${win.remainingPercent}% left`));
      val.append(remStrong, t(` \xB7 \u5DF2\u7528 ${win.usedPercent}%`, ` \xB7 ${win.usedPercent}% used`));
      head.append(lbl, val);
      const track = ui.h("div", "ggw-qbar-track");
      const fillTone = win.usedPercent >= 90 ? "ggw-qbar-fill bad" : win.usedPercent >= 75 ? "ggw-qbar-fill warn" : "ggw-qbar-fill";
      const fill = ui.h("div", fillTone);
      fill.style.width = `${Math.min(Math.max(win.usedPercent, 0), 100)}%`;
      track.append(fill);
      bar.append(head, track);
      if (win.resetsAt) {
        const resetMs = Date.parse(win.resetsAt) - Date.now();
        const compactReset = Number.isFinite(resetMs) ? formatDuration(resetMs, zh) : win.resetsAt;
        const foot = ui.h("div", "ggw-qbar-foot", compactReset);
        if (Number.isFinite(resetMs)) {
          foot.title = new Date(win.resetsAt).toLocaleString();
        }
        bar.append(foot);
      }
      return bar;
    }
    function renderAccountQuotaCard(acct, masked, routing, isTopPriority, titleOverride) {
      const highlight = !titleOverride && (routing === "failover" ? acct.isPrimary : routing === "least-used" && isTopPriority);
      const card = ui.h("div", highlight ? "ggw-quota-card is-primary" : "ggw-quota-card");
      const head = ui.h("div", "ggw-quota-card-head");
      const display = titleOverride ?? accountDisplayName(acct.accountId, acct.email, zh, masked);
      const title = ui.h("div", "ggw-quota-card-title", display);
      title.title = display;
      const tags = ui.h("span", "ggw-tags");
      if (!titleOverride) {
        if (routing === "failover" && acct.isPrimary) {
          tags.append(ui.h("span", "ggw-tag primary", t("\u4E3B\u7528", "Primary")));
        } else if (routing === "least-used" && isTopPriority) {
          tags.append(ui.h("span", "ggw-tag primary", t("\u5F53\u524D\u4F18\u5148", "Next up")));
        }
      }
      if (acct.plan) tags.append(ui.h("span", "ggw-tag plan", acct.plan));
      const cdText = formatCooldownLeft(acct.cooldownUntil, zh);
      if (cdText) {
        const cdTag = ui.h("span", "ggw-tag warn", cdText);
        if (acct.cooldownReason) cdTag.title = acct.cooldownReason;
        tags.append(cdTag);
      }
      head.append(title, tags);
      card.append(head);
      if (acct.error) {
        card.append(ui.h("div", "ggw-quota-err", acct.error));
      } else if (!acct.windows.length) {
        card.append(ui.h("div", "sh-desc", t("\u63A5\u53E3\u672A\u8FD4\u56DE\u65F6\u95F4\u7A97\u53E3\u989D\u5EA6\u6570\u636E\u3002", "No quota windows returned.")));
      } else {
        const bars = ui.h("div", "ggw-qbars");
        const orderedWins = routing !== "failover" ? [...acct.windows].sort((a, b) => a.id === "weekly" ? -1 : b.id === "weekly" ? 1 : 0) : acct.windows;
        for (const win of orderedWins) {
          bars.append(renderCompactBar(win));
        }
        card.append(bars);
      }
      if (acct.creditsRemaining !== void 0 || acct.userTier) {
        const foot = ui.h("div", "ggw-quota-card-foot");
        if (acct.userTier) foot.append(ui.h("span", "mono", acct.userTier));
        if (acct.creditsRemaining !== void 0) {
          foot.append(ui.h("span", "", t(`\u8D85\u989D Credits\uFF1A${acct.creditsRemaining}`, `Overage Credits: ${acct.creditsRemaining}`)));
        }
        card.append(foot);
      }
      return card;
    }
    function renderSnapshot(snap) {
      lastSnapshot = snap;
      if (typeof snap.emailsMasked === "boolean") {
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
        planPill.textContent = t("\u5F85\u8BA4\u8BC1", "Auth required");
        planPill.className = "pill plain";
        footnote.textContent = t("\u5B8C\u6210\u4E0A\u65B9\u6D4F\u89C8\u5668 OAuth \u8BA4\u8BC1\u540E\uFF0C\u5C06\u81EA\u52A8\u67E5\u8BE2\u989D\u5EA6\u3002", "Quota will load automatically once browser OAuth login completes.");
        return;
      }
      waitingForAuth = false;
      autoQueryDone = true;
      if (!snap.supported) {
        planPill.textContent = t("\u4E0D\u9002\u7528", "N/A");
        planPill.className = "pill plain";
        footnote.textContent = snap.note ?? "";
        return;
      }
      const acctCards = snap.accounts;
      if (acctCards && acctCards.length > 0) {
        const okCount = acctCards.filter((a) => !a.error).length;
        if (okCount === 0) {
          planPill.textContent = t("\u67E5\u8BE2\u5931\u8D25", "Failed");
          planPill.className = "pill off";
        } else if (acctCards.length === 1) {
          planPill.textContent = acctCards[0].plan ? t(`\u8BA2\u9605\uFF1A${acctCards[0].plan}`, `Plan: ${acctCards[0].plan}`) : t("\u5DF2\u67E5\u8BE2", "Loaded");
          planPill.className = "pill on";
        } else {
          planPill.textContent = okCount === acctCards.length ? t(`\u5DF2\u67E5\u8BE2 \xB7 ${okCount} \u4E2A\u8D26\u53F7`, `Loaded \xB7 ${okCount} accounts`) : t(`\u90E8\u5206\u6210\u529F \xB7 ${okCount}/${acctCards.length}`, `Partial \xB7 ${okCount}/${acctCards.length}`);
          planPill.className = okCount > 0 ? "pill on" : "pill off";
        }
        const now = Date.now();
        const orderedCards = accountRouting === "least-used" ? sortLeastUsed(acctCards, (a) => ({
          cooled: Boolean(a.cooldownUntil && a.cooldownUntil > now) || Boolean(a.error),
          cooldownUntil: a.cooldownUntil,
          fiveHourRemaining: a.windows.find((w) => w.id === "fiveHour")?.remainingPercent,
          weeklyRemaining: a.windows.find((w) => w.id === "weekly")?.remainingPercent
        })) : acctCards;
        const topId = accountRouting === "least-used" ? orderedCards.find((a) => !a.error && !(a.cooldownUntil && a.cooldownUntil > now))?.accountId : void 0;
        for (const acct of orderedCards) {
          cardsBox.append(renderAccountQuotaCard(acct, emailsMasked, accountRouting, acct.accountId === topId));
        }
      } else {
        planPill.textContent = snap.plan ? t(`\u8BA2\u9605\uFF1A${snap.plan}`, `Plan: ${snap.plan}`) : t("\u5DF2\u67E5\u8BE2", "Loaded");
        planPill.className = "pill on";
        cardsBox.append(renderAccountQuotaCard({
          accountId: "gateway",
          isPrimary: true,
          ...snap.plan ? { plan: snap.plan } : {},
          ...snap.userTier ? { userTier: snap.userTier } : {},
          windows: snap.windows,
          ...snap.creditsRemaining !== void 0 ? { creditsRemaining: snap.creditsRemaining } : {},
          fetchedAt: snap.fetchedAt
        }, false, "failover", false, t("\u5F53\u524D\u7F51\u5173\u7AEF\u70B9", "Gateway endpoint")));
      }
      footnote.textContent = t(
        `\u67E5\u8BE2\u4E8E ${new Date(snap.fetchedAt).toLocaleTimeString()}`,
        `Checked at ${new Date(snap.fetchedAt).toLocaleTimeString()}`
      );
    }
    async function fetchQuota(userInitiated) {
      if (loading || signal.aborted) return;
      loading = true;
      queryBtn.disabled = true;
      accountSelect.disabled = true;
      toggleMaskBtn.disabled = true;
      if (userInitiated) {
        message.textContent = t("\u6B63\u5728\u67E5\u8BE2\u989D\u5EA6\u2026", "Querying quota\u2026");
        message.classList.remove("bad");
      }
      try {
        const args = { name };
        if (selectedAccountId && selectedAccountId !== "all") {
          args.accountId = selectedAccountId;
        } else {
          args.accountId = "all";
        }
        const snap = await ctx.invoke("query", [args]);
        if (signal.aborted) return;
        message.textContent = "";
        message.classList.remove("bad");
        renderSnapshot(snap);
        if (!snap.authRequired) {
          broadcastPanelSync({ kind: "quota", instanceName: name, source: "quota" });
        }
      } catch (err) {
        if (signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        waitingForAuth = false;
        autoQueryDone = true;
        planPill.textContent = t("\u67E5\u8BE2\u5931\u8D25", "Failed");
        planPill.className = "pill off";
        message.textContent = msg;
        message.classList.add("bad");
      } finally {
        loading = false;
        queryBtn.disabled = false;
        accountSelect.disabled = false;
        updateMaskButton();
      }
    }
    const onPanelSync = (ev) => {
      if (ev.instanceName !== name) return;
      if (ev.kind === "gateway") {
        void loadRoutesState().then((routes) => {
          if (routes?.protocol === "robin") void fetchQuota(false);
        });
      } else if (ev.kind === "mask" && ev.source !== "quota") {
        void syncLabelsFromServer();
      } else if (ev.kind === "routing") {
        accountRouting = ev.routing;
        if (lastSnapshot) {
          renderSnapshot({ ...lastSnapshot, accountRouting: ev.routing });
        }
      } else if (ev.kind === "quota" && ev.source !== "quota" && currentProtocol === "robin") {
        void fetchQuota(false);
      }
    };
    panelSyncListeners.add(onPanelSync);
    signal.addEventListener("abort", () => panelSyncListeners.delete(onPanelSync), { once: true });
    const initialRoutes = await loadRoutesState();
    if (!initialRoutes || initialRoutes.protocol === "robin" || initialRoutes.quotaEndpoint.trim()) {
      await fetchQuota(false);
    }
    ctx.interval(() => {
      if (currentProtocol === "robin" && waitingForAuth && !autoQueryDone) void fetchQuota(false);
    }, 3e3);
  }
};
var gatewayPanel = {
  async mount(ctx) {
    const { ui, root, signal } = ctx;
    const zh = isZh(ctx);
    const t = (cn, en) => zh ? cn : en;
    const name = ctx.scope.instance;
    if (!name) return;
    root.classList.add("ggw-panel");
    const modeRow = ui.rowbar();
    const robinBtn = ui.button(t("Robin \u684C\u9762\u7AEF (\u81EA\u52A8)", "Robin Desktop (Auto)"), {
      size: "sm",
      onClick: () => void applyPreset("robin")
    });
    const geminiBtn = ui.button(t("Web2API Gemini", "Web2API Gemini"), {
      size: "sm",
      onClick: () => void applyPreset("gemini")
    });
    const rpcBtn = ui.button(t("\u81EA\u5B9A\u4E49 RPC", "Custom RPC"), {
      size: "sm",
      onClick: () => void applyPreset("rpc")
    });
    modeRow.append(robinBtn, geminiBtn, rpcBtn);
    const summaryBox = ui.h("div");
    const baseUrlInput = ui.input({
      cls: "mono",
      placeholder: "http://127.0.0.1:8080",
      onChange: () => void saveOptions()
    });
    const baseUrlField = ui.field(t("\u81EA\u5EFA\u7F51\u5173\u5730\u5740 (\u81EA\u52A8\u5339\u914D\u8DEF\u7531)", "Self-hosted gateway URL (auto routes)"), baseUrlInput);
    baseUrlField.hidden = true;
    const authModeSelect = ui.select({
      options: [
        { value: "auto", label: t("auto\uFF08\u81EA\u52A8\u8BC6\u522B OAuth / API \u5BC6\u94A5\uFF09", "auto (detect OAuth or API key)") },
        { value: "oauth", label: t("oauth\uFF08\u684C\u9762\u6D4F\u89C8\u5668 OAuth\uFF09", "oauth (Desktop browser OAuth)") },
        { value: "api-key", label: t("api-key\uFF08\u4EC5\u5BC6\u94A5\u8BF7\u6C42\u5934\uFF09", "api-key (Key header only)") }
      ],
      onChange: (value) => void saveOptions({ authMode: value })
    });
    const tempCheck = ui.checkbox(t("\u542F\u7528\u65E0\u75D5\u4F1A\u8BDD\u6807\u5FD7 (temporary_chat)", "Send temporary_chat flag"), {
      onChange: () => void saveOptions()
    });
    const proxyUrlInput = ui.input({
      cls: "mono",
      placeholder: t("\u7559\u7A7A\u8DDF\u968F\u7CFB\u7EDF\u4EE3\u7406\uFF1B\u652F\u6301 7890 \u6216 http://127.0.0.1:7890", "Leave blank for system proxy; e.g. 7890 or http://127.0.0.1:7890"),
      onChange: () => void saveOptions()
    });
    const proxyUrlField = ui.field(t("\u72EC\u7ACB\u4EE3\u7406\u5730\u5740\uFF08\u53EF\u9009\uFF09", "Dedicated proxy URL (optional)"), proxyUrlInput);
    const testRow = ui.rowbar();
    const testBtn = ui.button(t("\u6D4B\u8BD5\u8FDE\u63A5", "Test connection"), {
      size: "sm",
      onClick: () => void runTest()
    });
    testRow.append(testBtn);
    const message = ui.msgline();
    root.append(
      modeRow,
      summaryBox,
      baseUrlField,
      ui.field(t("\u8BA4\u8BC1\u6A21\u5F0F", "Auth mode"), authModeSelect),
      tempCheck.el,
      proxyUrlField,
      testRow,
      message
    );
    let saving = false;
    let currentProtocol = "robin";
    let lastSavedProxyUrl = "";
    function modeDescription(protocol) {
      if (protocol === "robin") return t("RobinService HTTP/2 gRPC\uFF08\u81EA\u52A8\u5207\u6362\u5B98\u65B9\u7AEF\u70B9\u4E0E\u8DEF\u7531\uFF09", "RobinService HTTP/2 gRPC (auto endpoint & routes)");
      if (protocol === "gemini") return t("\u539F\u751F Gemini REST SSE\uFF08\u81EA\u52A8\u62FC\u63A5\u6D41\u5F0F\u751F\u6210\u8DEF\u7531\uFF09", "Native Gemini REST SSE (auto stream route)");
      return t("\u81EA\u5B9A\u4E49\u4F1A\u8BDD\u5267\u672C RPC\uFF08\u81EA\u52A8\u62FC\u63A5 generate \u8DEF\u7531\uFF09", "Custom session RPC (auto generate route)");
    }
    function fill(state) {
      currentProtocol = state.protocol;
      robinBtn.classList.toggle("primary", state.protocol === "robin");
      geminiBtn.classList.toggle("primary", state.protocol === "gemini");
      rpcBtn.classList.toggle("primary", state.protocol === "rpc");
      authModeSelect.value = state.authMode;
      tempCheck.setChecked(state.temporaryChat);
      lastSavedProxyUrl = state.proxyUrl ?? "";
      proxyUrlInput.value = lastSavedProxyUrl;
      baseUrlField.hidden = state.protocol === "robin";
      if (state.protocol !== "robin") {
        baseUrlInput.value = state.baseUrl;
      }
      summaryBox.replaceChildren(ui.kv([
        { k: t("\u81EA\u52A8\u63A5\u53E3\u5730\u5740", "Active API URL"), v: state.baseUrl },
        { k: t("\u4F20\u8F93\u6A21\u5F0F", "Transport"), v: modeDescription(state.protocol) }
      ]));
    }
    async function load() {
      const state = await ctx.invoke("state", [{ name }]);
      if (!signal.aborted) fill(state);
    }
    async function applyPreset(preset) {
      if (saving || signal.aborted) return;
      saving = true;
      message.textContent = "";
      message.classList.remove("bad");
      try {
        const state = await ctx.invoke("apply-preset", [{ name, preset }]);
        if (signal.aborted) return;
        fill(state);
        broadcastPanelSync({
          kind: "gateway",
          instanceName: name,
          protocol: state.protocol,
          authMode: state.authMode,
          authEnabled: state.authEnabled
        });
        message.textContent = t(
          `\u5DF2\u81EA\u52A8\u5207\u6362\u81F3 ${preset} \u6A21\u5F0F\u5E76\u66F4\u65B0\u63A5\u53E3\u5730\u5740\u4E3A ${state.baseUrl}\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09\u3002`,
          `Switched to ${preset} mode (${state.baseUrl}). Click Save below to persist.`
        );
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add("bad");
        }
      } finally {
        saving = false;
      }
    }
    async function saveOptions(overrides = {}) {
      if (saving || signal.aborted) return false;
      saving = true;
      message.textContent = "";
      message.classList.remove("bad");
      try {
        const state = await ctx.invoke("save-options", [{
          name,
          protocol: currentProtocol,
          authMode: overrides.authMode ?? authModeSelect.value,
          temporaryChat: tempCheck.checked,
          proxyUrl: proxyUrlInput.value,
          ...currentProtocol !== "robin" ? { baseUrl: baseUrlInput.value } : {}
        }]);
        if (!signal.aborted) {
          fill(state);
          broadcastPanelSync({
            kind: "gateway",
            instanceName: name,
            protocol: state.protocol,
            authMode: state.authMode,
            authEnabled: state.authEnabled
          });
          message.textContent = t("\u914D\u7F6E\u5DF2\u81EA\u52A8\u540C\u6B65\uFF08\u8BF7\u70B9\u51FB\u9875\u9762\u5E95\u90E8\u300C\u4FDD\u5B58\u300D\u751F\u6548\uFF09\u3002", "Options synced. Click Save below to persist.");
        }
        return true;
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add("bad");
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
      message.textContent = t("\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5\u2026", "Testing connection\u2026");
      message.classList.remove("bad");
      try {
        const res = await ctx.invoke("test", [{ name }]);
        if (signal.aborted) return;
        message.textContent = `${res.summary} \xB7 ${(res.elapsedMs / 1e3).toFixed(1)}s`;
        message.classList.toggle("bad", !res.ok);
      } catch (err) {
        if (!signal.aborted) {
          message.textContent = err instanceof Error ? err.message : String(err);
          message.classList.add("bad");
        }
      } finally {
        testBtn.disabled = false;
      }
    }
    await load();
  }
};
var client_default = {
  panels: {
    auth: authPanel,
    quota: quotaPanel,
    gateway: gatewayPanel,
    "model-settings": modelSettingsPanel
  }
};
export {
  client_default as default
};
