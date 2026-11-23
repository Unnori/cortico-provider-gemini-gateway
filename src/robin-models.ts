import type { ListedModel } from 'cortico/providers/base.ts';
import { geminiModelId, type ModelMetadata } from './catalog.ts';
import {
  resolveRobinMode,
  type RobinModeOption,
  type RobinRoutingObservation,
  type RobinUserStatus,
} from './robin-grpc.ts';

export const ROBIN_PRO_MODEL_ID = 'gemini-robin-pro';
export const ROBIN_FAST_MODEL_ID = 'gemini-robin-fast';
export const ROBIN_FLASH_LITE_MODEL_ID = 'gemini-robin-flash-lite';

export interface RobinRouteSummary {
  plan?: string;
  userTier?: string;
  policy?: string;
  requestedModeCategory?: number;
  requestedThinkingLevel?: number;
  officialEntitled?: boolean;
  officialLabel?: string;
  ultraOnly?: boolean;
  lastAttribution?: string;
  lastObservedAt?: string;
  lastAccount?: string;
  lastResolvedModeCategory?: number;
  lastResolvedThinkingLevel?: number;
  lastThoughtChars?: number;
  lastDowngradeReason?: number;
  lastFallback?: number;
  downgraded?: boolean;
}

export interface BuildRobinListedModelsOptions {
  userStatus?: RobinUserStatus | null;
  plan?: string;
  userTier?: string;
  poolPlans?: readonly string[];
  configuredModel?: string;
  resolveMeta: (id: string) => ModelMetadata | undefined;
  observedRouting?: (id: string) => RobinRoutingObservation | undefined;
}

export function isUltraPlan(plan?: string, userTier?: string): boolean {
  const tier = userTier?.trim().toUpperCase();
  return tier === 'TIER2' || tier === 'TIER_NEON' || tier === 'TIER_ULTRA'
    || plan?.trim().toLowerCase() === 'ultra';
}

export function planTierRank(plan?: string, userTier?: string): number {
  if (isUltraPlan(plan, userTier)) return 4;
  const tier = userTier?.trim().toUpperCase();
  const p = plan?.trim().toLowerCase();
  if (tier === 'TIER1' || tier === 'TIER_PRO' || tier === 'TIER_PREMIUM' || p === 'pro') return 3;
  if (tier === 'TIER_LITE' || tier === 'TIER_PLUS' || tier === 'TIER_HELIUM' || p === 'plus') return 2;
  if (tier === 'TIER_BASIC' || tier === 'TIER_FREE' || tier === 'TIER0' || p === 'free') return 1;
  return p ? 1 : 0;
}

export function isUltraOnlyRobinModel(modelOrName?: string, modeCategory?: number): boolean {
  if (modeCategory === 8) return true;
  if (!modelOrName) return false;
  return /\bcarbon\b/i.test(modelOrName);
}

function isFreePlan(plan?: string, userTier?: string): boolean {
  return userTier === 'TIER_BASIC' || plan?.toLowerCase() === 'free';
}

function isPaidTier(plan?: string, userTier?: string): boolean {
  return Boolean(
    userTier === 'TIER1' || userTier === 'TIER2' || userTier === 'TIER_NEON' || userTier === 'TIER_LITE'
    || (plan && !isFreePlan(plan, userTier)),
  );
}

function formatOfficialDisplayName(
  mode: RobinModeOption,
  plan?: string,
  userTier?: string,
  poolHasUltra = false,
): string {
  const base = /^gemini\b/i.test(mode.modelName)
    ? mode.modelName
    : mode.modelName
      ? `Gemini ${mode.modelName}`
      : `Gemini ${mode.title}`;
  const ultraOnly = isUltraOnlyRobinModel(mode.modelId, mode.modeCategory)
    || isUltraOnlyRobinModel(mode.modelName, mode.modeCategory)
    || mode.entitled === false;

  if (ultraOnly) {
    if (isUltraPlan(plan, userTier) && mode.entitled !== false) {
      return `${base} [官方下发 · mode ${mode.modeCategory} · 仅 Ultra 可用]`;
    }
    if (poolHasUltra) {
      return `${base} [官方下发 · mode ${mode.modeCategory} · 仅 Ultra 可用 · 池内 Ultra 优先]`;
    }
    const downgradeNote = plan ? `${plan} 选择会被降级` : '非 Ultra 会被降级';
    return `${base} [mode ${mode.modeCategory} · 仅 Ultra 可用（${downgradeNote}）]`;
  }

  const tierNote = plan ? `${plan} 可用` : '当前账号可用';
  return `${base} [官方下发 · mode ${mode.modeCategory} · ${tierNote}]`;
}

function formatNativeRouteDisplayName(
  modeCategory: 3 | 1 | 6,
  plan?: string,
  userTier?: string,
  entitledByStatus = false,
  observed?: RobinRoutingObservation,
): string {
  const free = isFreePlan(plan, userTier);
  const paid = isPaidTier(plan, userTier);
  const obsSuffix = observed?.attribution ? ` · 实测: ${observed.attribution}` : '';

  if (modeCategory === 3) {
    if (free) {
      return `Robin PRO 档 [原生路由 · mode 3 · 需 Pro/Ultra；Free 下由后端路由至 3.1 Pro${obsSuffix}]`;
    }
    if (paid) {
      return `Robin PRO 档 [原生路由 · mode 3 · ${plan ?? '订阅'} 可用${entitledByStatus ? '' : ' · 受套餐路由'}${obsSuffix}]`;
    }
    return `Robin PRO 档 [原生路由 · mode 3 · 需 Pro/Ultra（Free 可能回落 3.1 Pro）${obsSuffix}]`;
  }
  if (modeCategory === 1) {
    if (free) {
      return `Robin FAST 档 [原生路由 · mode 1 · Free 实测路由 4 Hydrogen · 受额度限制${obsSuffix}]`;
    }
    if (paid) {
      return `Robin FAST 档 [原生路由 · mode 1 · ${plan ?? '订阅'} 可用${obsSuffix}]`;
    }
    return `Robin FAST 档 [原生路由 · mode 1 · Fast / Hydrogen 档${obsSuffix}]`;
  }
  return `Robin Flash-Lite 档 [原生路由 · mode 6 · 全套餐可用${obsSuffix}]`;
}

/**
 * Builds the Robin model picker list by combining live `GetUserStatus` official entries
 * with the 3 explicit native Robin route tiers (PRO=3, FAST=1, Flash-Lite=6),
 * clearly labeling source & account tier accessibility without mixing unrelated external API models.
 */
export function buildRobinListedModels(options: BuildRobinListedModelsOptions): ListedModel[] {
  const { userStatus, plan, userTier, poolPlans, configuredModel, resolveMeta, observedRouting } = options;
  const result: ListedModel[] = [];
  const seenIds = new Set<string>();
  const officialModes = new Set<number>();
  const poolHasUltra = Boolean(
    isUltraPlan(plan, userTier)
    || poolPlans?.some(p => isUltraPlan(p)),
  );

  const push = (id: string, displayName: string) => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const meta = resolveMeta(id);
    result.push({
      id,
      displayName,
      contextWindow: meta?.contextWindow ?? 1_048_576,
      maxOutputTokens: meta?.maxOutputTokens ?? 65_536,
      inputImages: true,
    });
  };

  // 1. Official models returned directly by RobinService/GetUserStatus for the signed-in account.
  for (const mode of userStatus?.modes ?? []) {
    if (mode.entitled !== false) officialModes.add(mode.modeCategory);
    push(mode.modelId, formatOfficialDisplayName(mode, plan, userTier, poolHasUltra));
  }

  // 2. Explicit 3 native Robin protocol route tiers with clear source & tier-accessibility annotations.
  const nativeRoutes: readonly { id: string; modeCategory: 3 | 1 | 6 }[] = [
    { id: ROBIN_PRO_MODEL_ID, modeCategory: 3 },
    { id: ROBIN_FAST_MODEL_ID, modeCategory: 1 },
    { id: ROBIN_FLASH_LITE_MODEL_ID, modeCategory: 6 },
  ];
  for (const route of nativeRoutes) {
    push(
      route.id,
      formatNativeRouteDisplayName(
        route.modeCategory,
        plan,
        userTier,
        officialModes.has(route.modeCategory),
        observedRouting?.(route.id),
      ),
    );
  }

  // 3. Preserve any already-configured legacy/custom Gemini ID so the picker never loses selection.
  if (configuredModel && configuredModel.trim()) {
    const cleanId = geminiModelId(configuredModel.trim());
    if (!seenIds.has(cleanId)) {
      const mapped = resolveRobinMode(cleanId);
      const modeTag = mapped.smartModelSelection ? 'Auto' : `mode ${mapped.modeCategory}`;
      const ultraWarn = isUltraOnlyRobinModel(cleanId, mapped.modeCategory) && !poolHasUltra
        ? ` · 仅 Ultra 可用（${plan ? `${plan} 会被降级` : '非 Ultra 会被降级'}）`
        : '';
      const freeWarn = !ultraWarn && isFreePlan(plan, userTier) && mapped.modeCategory === 3
        ? ' · Free 下由后端路由至 3.1 Pro'
        : '';
      const obs = observedRouting?.(cleanId);
      const obsTag = obs?.attribution ? ` · 实测: ${obs.attribution}` : '';
      push(cleanId, `${cleanId} [当前已选 · 映射 ${modeTag}${ultraWarn}${freeWarn}${obsTag}]`);
    }
  }

  return result;
}

/**
 * Resolves ordered external catalog / pricebook lookup IDs for a Robin model so input declarations
 * and reference pricing align with the model Robin actually routes to.
 */
export function robinCatalogLookupIds(
  model: string,
  plan?: string,
  userTier?: string,
  observedAttribution?: string,
): string[] {
  const id = geminiModelId(model).toLowerCase();
  const candidates: string[] = [];
  const add = (candidate: string) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  // Prefer the real server-observed model attribution when available.
  if (observedAttribution) {
    const attr = observedAttribution.toLowerCase();
    if (attr.includes('4 carbon') || attr.includes('carbon')) add('gemini-4-carbon');
    else if (attr.includes('4 neon') || attr.includes('neon')) add('gemini-4-neon');
    else if (attr.includes('4 hydrogen') || attr.includes('hydrogen')) add('gemini-4-hydrogen');
    else if (attr.includes('3.5 flash-lite')) add('gemini-3.5-flash-lite');
    else if (attr.includes('3.1 pro')) add('gemini-3.1-pro');
    else if (attr.includes('3.8 flash')) add('gemini-3.8-flash');
    else if (attr.includes('2.5 pro')) add('gemini-2.5-pro');
    else if (attr.includes('2.5 flash-lite')) add('gemini-2.5-flash-lite');
    else if (attr.includes('2.5 flash')) add('gemini-2.5-flash');
  }

  add(id);
  const free = isFreePlan(plan, userTier);

  if (id === 'gemini-4-carbon') {
    add('gemini-4-neon');
    add('gemini-3.1-pro');
    add('gemini-3.1-pro-preview');
    add('gemini-2.5-pro');
  } else if (id === ROBIN_PRO_MODEL_ID || id === 'gemini-4-neon' || id === 'gemini-4-argon') {
    if (free) {
      add('gemini-3.1-pro');
      add('gemini-3.1-pro-preview');
      add('gemini-2.5-pro');
    } else {
      add('gemini-4-neon');
      add('gemini-3.1-pro');
      add('gemini-3.1-pro-preview');
      add('gemini-2.5-pro');
    }
  } else if (id === ROBIN_FAST_MODEL_ID || id === 'gemini-4-hydrogen') {
    add('gemini-4-hydrogen');
    add('gemini-3-flash');
    add('gemini-3-flash-preview');
    add('gemini-2.5-flash');
  } else if (id === ROBIN_FLASH_LITE_MODEL_ID || id === 'gemini-3.5-flash-lite' || id === 'gemini-flash-lite') {
    add('gemini-3.5-flash-lite');
    add('gemini-flash-lite');
    add('gemini-2.5-flash-lite');
  } else if (id.includes('3.1-pro')) {
    add('gemini-3.1-pro-preview');
    add('gemini-2.5-pro');
  }

  return candidates;
}

export function buildRobinRouteSummary(opts: {
  model: string;
  thinking?: boolean;
  reasoningEffort?: string;
  userStatus?: RobinUserStatus | null;
  plan?: string;
  userTier?: string;
  observed?: RobinRoutingObservation;
  observedAccount?: string;
  overrideModeCategory?: number;
}): RobinRouteSummary {
  const { model, thinking, reasoningEffort, userStatus, plan, userTier, observed, observedAccount, overrideModeCategory } = opts;
  const resolved = resolveRobinMode(model, thinking ?? true, reasoningEffort, overrideModeCategory);
  const ultraOnly = isUltraOnlyRobinModel(model, resolved.modeCategory);
  const official = userStatus?.modes.find(m =>
    m.entitled !== false && (m.modelId === geminiModelId(model) || m.modeCategory === resolved.modeCategory),
  );
  const downgraded = Boolean(
    observed && (
      observed.fallback === 1
      || (observed.downgradeReason !== undefined && observed.downgradeReason > 0)
      || (observed.requestedModeCategory !== undefined
        && observed.resolvedModeCategory !== undefined
        && observed.resolvedModeCategory !== observed.requestedModeCategory)
    ),
  );
  const requestedThinkingLevel = observed?.requestedThinkingLevel ?? resolved.thinkingLevel;
  return {
    ...(plan ? { plan } : {}),
    ...(userTier ? { userTier } : {}),
    ...(userStatus?.policy ? { policy: userStatus.policy } : {}),
    ...(resolved.modeCategory !== undefined ? { requestedModeCategory: resolved.modeCategory } : {}),
    ...(requestedThinkingLevel !== undefined ? { requestedThinkingLevel } : {}),
    ...(userStatus ? { officialEntitled: Boolean(official) } : {}),
    ...(official ? { officialLabel: `${official.modelName} (mode ${official.modeCategory})` } : {}),
    ...(ultraOnly ? { ultraOnly: true } : {}),
    ...(observed?.attribution ? { lastAttribution: observed.attribution } : {}),
    ...(observed?.observedAt ? { lastObservedAt: observed.observedAt } : {}),
    ...(observedAccount ? { lastAccount: observedAccount } : {}),
    ...(observed?.resolvedModeCategory !== undefined ? { lastResolvedModeCategory: observed.resolvedModeCategory } : {}),
    ...(observed?.resolvedThinkingLevel !== undefined ? { lastResolvedThinkingLevel: observed.resolvedThinkingLevel } : {}),
    ...(observed?.thoughtChars !== undefined ? { lastThoughtChars: observed.thoughtChars } : {}),
    ...(observed?.downgradeReason !== undefined ? { lastDowngradeReason: observed.downgradeReason } : {}),
    ...(observed?.fallback !== undefined ? { lastFallback: observed.fallback } : {}),
    ...(observed ? { downgraded } : {}),
  };
}
