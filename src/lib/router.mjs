/**
 * router.mjs — routing decision engine (replaces match.py).
 * Parity: first-match-wins over routes(roster); preset biases; tier->model resolution.
 */
import {
  routes as getRosterRoutes,
  defaults as getRosterDefaults,
  isBackendEnabled,
  nativeModelForTier,
} from './config.mjs';
import { charCount, classify } from './score.mjs';

/**
 * Resolve (backend, tier) -> { model, native }.
 * @param {object} roster
 * @param {string} backend
 * @param {string} tier
 * @returns {{ model: string, native: boolean }}
 */
function resolveModel(roster, backend, tier) {
  if (backend === 'native') {
    // Keep the `native:<tier>` contract every consumer parses, but validate the tier against the
    // roster's native_models map so an unknown tier can't leak into a handoff sentinel.
    const resolved = nativeModelForTier(roster, tier);
    return { model: `native:${tier}`, native: true, nativeModel: resolved };
  }
  const backends = roster.backends || {};
  const be = backends[backend] || {};
  const models = (be.models && typeof be.models === 'object') ? be.models : {};
  const aliases = (be.model_aliases && typeof be.model_aliases === 'object') ? be.model_aliases : {};
  const alias = (v) => {
    const s = String(v ?? '').trim();
    const hit = s && aliases[s.toLowerCase()];
    return hit ? String(hit) : s;
  };
  const dflTier = typeof be.default_tier === 'string' && be.default_tier ? be.default_tier : 'standard';

  // Same ladder as backends.modelForTier, so the decision JSON reports the model that will
  // actually be used: exact tier -> default_tier -> standard -> cheap -> first declared.
  if (models[tier]) return { model: alias(models[tier]), native: false };
  if (aliases[String(tier).toLowerCase()]) return { model: alias(tier), native: false };
  if (models[dflTier]) return { model: alias(models[dflTier]), native: false };
  if (models.standard) return { model: alias(models.standard), native: false };
  if (models.cheap) return { model: alias(models.cheap), native: false };
  const first = Object.entries(models).find(([k, v]) => !k.startsWith('_') && v);
  if (first) return { model: alias(first[1]), native: false };
  // No model map at all is legitimate (opencode ships one): the invoker omits the model flag and
  // the CLI uses its own default. Report that explicitly rather than inventing a `<backend>:<tier>`.
  return { model: '', native: false };
}

/**
 * Apply documented preset biases (parity with match.py apply_preset).
 * @param {string} preset
 * @param {string} ruleName
 * @param {string} backend
 * @param {string} tier
 * @returns {[string, string]} [backend, tier]
 */
function applyPreset(preset, ruleName, backend, tier) {
  if (preset === 'budget' && ruleName === 'judgment-coding') return ['agy', 'standard'];
  if (preset === 'premium' && (ruleName === 'standard-coding' || ruleName === 'trivial')) return ['native', 'sonnet'];
  return [backend, tier];
}

/**
 * First-match-wins rule evaluation (parity with match.py match_rule).
 * Returns the winning rule or null; also collects near-misses for confidence.
 * @param {object[]} routes
 * @param {number} chars
 * @param {string[]} types
 * @returns {{ rule: object|null, nearMisses: object[] }}
 */
function matchRule(routes, chars, types, isEnabled) {
  const tset = new Set(types.filter(Boolean));
  const nearMisses = [];
  const skippedDisabled = [];

  for (const r of routes) {
    // Skip marker objects (no name key)
    if (!r.name) continue;

    // A rule pointing at a DISABLED backend is skipped entirely, so matching continues to the next
    // rule. Without this the router would happily return a backend that run.mjs then refuses to
    // use — the decision JSON would advertise a backend the user has switched off, and the real
    // destination would only emerge as a silent fallback.
    // Skipping here means disabling `agy` makes its commodity work fall through to the next
    // matching rule (codex/opencode/native) as an HONEST, visible decision.
    if (r.backend && !isEnabled(r.backend)) {
      skippedDisabled.push({ rule: r.name, backend: r.backend });
      continue;
    }

    const when = r.when || {};
    let ok = true;

    if ('type' in when) {
      const ruleTypes = when.type;
      const hasMatch = ruleTypes.some(t => tset.has(t));
      if (!hasMatch) ok = false;
    }
    if (ok && 'min_chars' in when) {
      if (chars < Number(when.min_chars)) ok = false;
    }
    if (ok && 'max_chars' in when) {
      if (chars > Number(when.max_chars)) ok = false;
    }

    if (ok) return { rule: r, nearMisses, skippedDisabled };

    // Collect near-misses: rules with type overlap (ignore char constraints)
    if ('type' in when) {
      const ruleTypes = when.type;
      const hasTypeOverlap = ruleTypes.some(t => tset.has(t));
      if (hasTypeOverlap) {
        nearMisses.push({ rule: r, backend: r.backend || 'native', tier: r.tier || 'sonnet' });
      }
    }
  }

  return { rule: null, nearMisses, skippedDisabled };
}

/**
 * Compute decision confidence.
 * @param {string[]} types - matched task types
 * @param {object[]} nearMisses - rules with type overlap but failed on chars/min_chars/max_chars
 * @returns {"high" | "medium" | "low"}
 */
function computeConfidence(types, nearMisses) {
  if (types.length > 0 && nearMisses.length === 0) return 'high';
  if (nearMisses.length > 0) return 'medium';
  return 'low'; // catch-all only
}

/**
 * Produce a routing decision.
 * @param {{ task: string, roster: object, tagsPath: string, preset?: string }} opts
 * @returns {{ backend: string, model: string, tier: string, rule: string, native: boolean,
 *             preset: string, score: { chars: number, types: string[] },
 *             nearMisses: object[], confidence: string }}
 */
export function decide({ task, roster, tagsPath, preset: presetArg }) {
  const defs = getRosterDefaults(roster);
  const preset = presetArg || defs.preset || 'balanced';

  const chars = charCount(task);
  const types = classify(task, tagsPath);

  const rawRoutes = getRosterRoutes(roster);
  const score = { chars, types };

  const isEnabled = (b) => isBackendEnabled(roster, b);
  const { rule, nearMisses, skippedDisabled } = matchRule(rawRoutes, chars, types, isEnabled);

  let backend, tier, ruleName;
  if (rule === null) {
    backend = 'native';
    tier = 'sonnet';
    ruleName = 'catch-all-safe';
  } else {
    backend = rule.backend || 'native';
    tier = rule.tier || 'sonnet';
    ruleName = rule.name || 'unnamed';
  }

  [backend, tier] = applyPreset(preset, ruleName, backend, tier);
  // A preset can bias INTO a disabled backend (budget pushes judgment-coding onto agy). Undo that
  // rather than emit a decision the executor will refuse — native is always available.
  if (!isEnabled(backend)) {
    skippedDisabled.push({ rule: `${ruleName}:preset-${preset}`, backend });
    backend = 'native';
    tier = 'sonnet';
  }
  const { model, native } = resolveModel(roster, backend, tier);
  const confidence = computeConfidence(types, nearMisses);

  return {
    backend, model, tier, rule: ruleName, native, preset, score, nearMisses, confidence,
    // Rules passed over because their backend is switched off — surfaced so `--explain` can say
    // WHY a task landed somewhere unexpected.
    skippedDisabled,
  };
}
