/**
 * router.mjs — routing decision engine (replaces match.py).
 * Parity: first-match-wins over routes(roster); preset biases; tier->model resolution.
 */
import { routes as getRosterRoutes, defaults as getRosterDefaults } from './config.mjs';
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
    return { model: `native:${tier}`, native: true };
  }
  const backends = roster.backends || {};
  const be = backends[backend] || {};
  const models = be.models || {};

  if (tier in models && models[tier]) return { model: models[tier], native: false };
  if ('standard' in models && models.standard) return { model: models.standard, native: false };
  const first = Object.values(models).find(v => v);
  if (first) return { model: first, native: false };
  return { model: `${backend}:${tier}`, native: false };
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
function matchRule(routes, chars, types) {
  const tset = new Set(types.filter(Boolean));
  const nearMisses = [];

  for (const r of routes) {
    // Skip marker objects (no name key)
    if (!r.name) continue;

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

    if (ok) return { rule: r, nearMisses };

    // Collect near-misses: rules with type overlap (ignore char constraints)
    if ('type' in when) {
      const ruleTypes = when.type;
      const hasTypeOverlap = ruleTypes.some(t => tset.has(t));
      if (hasTypeOverlap) {
        nearMisses.push({ rule: r, backend: r.backend || 'native', tier: r.tier || 'sonnet' });
      }
    }
  }

  return { rule: null, nearMisses };
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

  const { rule, nearMisses } = matchRule(rawRoutes, chars, types);

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
  const { model, native } = resolveModel(roster, backend, tier);
  const confidence = computeConfidence(types, nearMisses);

  return { backend, model, tier, rule: ruleName, native, preset, score, nearMisses, confidence };
}
