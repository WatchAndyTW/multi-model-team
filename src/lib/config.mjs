/**
 * config.mjs — roster.json loader (Node ESM port of scripts/lib/config.py)
 *
 * Replaces the bash-eval contract with plain JS objects.
 * Zero runtime dependencies (Node stdlib only). ESM, win32/linux/darwin.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveRosterPath } from './platform.mjs';

// ─── team defaults ───────────────────────────────────────────────────────────
// PIPELINE knobs only. Which backend does which job is decided entirely by the role staffing
// (`roles` in the roster -> src/lib/roles.mjs resolveStaffing), so the old backend-picking keys
// (dispatch_backends / verifier / caps) are gone — they were a second, competing assignment
// mechanism. `tier_models` is gone too: `defaults.native_models` is the one tier->Claude-model map,
// forwarded below as `native_models`.
const TEAM_DEFAULTS = {
  verify: true,
  max_fix_loops: 1,
  relay_model: 'sonnet',
};

// ─── reasoning defaults (mirrors REASONING_DEFAULTS in docs/REASONING.md) ─────
const REASONING_DEFAULTS = {
  panel: ['opus', 'sonnet', 'gemini'],
  judge: 'native:opus',
  synthesizer: 'native:opus',
  cap: 6,
  tier_models: { cheap: 'haiku', standard: 'sonnet', sonnet: 'sonnet', opus: 'opus', haiku: 'haiku', high: 'opus' },
  relay_model: 'sonnet',
};

// ─── native (Claude) tier -> model map ───────────────────────────────────────
// The SINGLE place a routing tier becomes a concrete Claude model. Overridable via
// roster.defaults.native_models. `high` is the alias tier a CLI-style route can use to ask for the
// strongest model without naming it, mirroring the per-backend `high` tier added for agy/codex.
const NATIVE_MODEL_DEFAULTS = {
  cheap: 'haiku',
  haiku: 'haiku',
  standard: 'sonnet',
  sonnet: 'sonnet',
  high: 'opus',
  opus: 'opus',
};

// ─── loadRoster ──────────────────────────────────────────────────────────────

/**
 * Parse roster.json from disk. Throws on bad JSON or unreadable file.
 * @param {string} path
 * @returns {object}
 */
export function loadRoster(path) {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

// ─── defaults ────────────────────────────────────────────────────────────────

/**
 * @param {object} roster
 * @returns {{ preset: string, fallback: string, quota_fallback: string[] }}
 */
export function defaults(roster) {
  const d = roster.defaults ?? {};
  return {
    preset: d.preset ?? 'balanced',
    fallback: d.fallback ?? 'native:sonnet',
    quota_fallback: Array.isArray(d.quota_fallback)
      ? d.quota_fallback
      : ['agy', 'native:sonnet'],
  };
}

// ─── backend registry / enable-disable ───────────────────────────────────────
//
// A backend is DISABLED when either the roster says so (`backends.<name>.enabled:false`) or an env
// kill switch names it. Two env switches, both CSV, both case-insensitive, evaluated per call so a
// single shell can flip a backend off without editing config:
//   MMT_DISABLE_BACKENDS="codex,agy"  — turn these OFF (blocklist)
//   MMT_ONLY_BACKENDS="agy"           — turn everything EXCEPT these off (allowlist; wins broadly)
// `native` is never disable-able: it is the guaranteed final fallback, so the chain can always land.

/** Parse a CSV env var into a lowercased list, or null when unset/empty. */
function envList(name) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return null;
  const items = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : null;
}

/** True when `name` refers to native Claude (never disable-able). */
export function isNativeBackend(name) {
  const n = String(name ?? '');
  return n === 'native' || n.startsWith('native:');
}

/**
 * Is this backend switched off by an env kill switch (independent of roster `enabled`)?
 * @param {string} name
 * @returns {boolean}
 */
export function backendDisabledByEnv(name) {
  if (isNativeBackend(name)) return false;
  const lc = String(name ?? '').toLowerCase();
  const only = envList('MMT_ONLY_BACKENDS');
  if (only && !only.includes(lc)) return true;
  const off = envList('MMT_DISABLE_BACKENDS');
  if (off && off.includes(lc)) return true;
  return false;
}

/**
 * All backend names declared in the roster (documentation keys like `_comment` excluded).
 * @param {object} roster
 * @returns {string[]}
 */
export function backendNames(roster) {
  const b = (roster && roster.backends) || {};
  return Object.keys(b).filter((k) => !k.startsWith('_') && b[k] && typeof b[k] === 'object');
}

/**
 * Is `name` usable right now — declared, roster-enabled, and not env-disabled?
 * `native` is always true (it is the guaranteed fallback).
 * @param {object} roster
 * @param {string} name
 * @returns {boolean}
 */
export function isBackendEnabled(roster, name) {
  if (isNativeBackend(name)) return true;
  const be = ((roster && roster.backends) || {})[name];
  if (!be || typeof be !== 'object') return false;
  if (be.enabled !== true) return false;
  return !backendDisabledByEnv(name);
}

/**
 * Backend names currently usable (roster-enabled AND not env-disabled). Excludes `native`.
 * @param {object} roster
 * @returns {string[]}
 */
export function enabledBackends(roster) {
  return backendNames(roster).filter((n) => isBackendEnabled(roster, n));
}

/**
 * Backend names currently switched off, each with WHY — so a caller (route --backends, run.mjs's
 * skip message, /team) can tell "you disabled it" from "the env killed it for this shell".
 * @param {object} roster
 * @returns {Array<{name:string, reason:'roster'|'env'}>}
 */
export function disabledBackends(roster) {
  return backendNames(roster)
    .filter((n) => !isBackendEnabled(roster, n))
    .map((n) => ({ name: n, reason: backendDisabledByEnv(n) ? 'env' : 'roster' }));
}

/**
 * Filter a caller-supplied backend list down to what is actually usable, always preserving
 * `native`. Used by /team staffing, /reasoning panels, and the fallback chain so a
 * disabled backend is never offered as a choice.
 * @param {object} roster
 * @param {string[]} names
 * @returns {string[]}
 */
export function filterEnabled(roster, names) {
  if (!Array.isArray(names)) return [];
  return names.filter((n) => isBackendEnabled(roster, n));
}

// ─── native model resolution ─────────────────────────────────────────────────

/**
 * Tier -> concrete Claude model, from roster.defaults.native_models merged over the built-ins.
 * @param {object} roster
 * @returns {Record<string,string>}
 */
export function nativeModels(roster) {
  const out = { ...NATIVE_MODEL_DEFAULTS };
  const cfg = (roster && roster.defaults && roster.defaults.native_models) || {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * Resolve a routing tier to a Claude model name (`sonnet`, `opus`, `haiku`, or a full model id).
 * Unknown tiers fall back to the `standard` mapping rather than guessing.
 * @param {object} roster
 * @param {string} tier
 * @returns {string}
 */
export function nativeModelForTier(roster, tier) {
  const map = nativeModels(roster);
  const t = String(tier ?? '').trim();
  return map[t] || map.standard || 'sonnet';
}

// ─── backend ─────────────────────────────────────────────────────────────────

/**
 * Return normalized backend config for `name`.
 * Missing/unknown/disabled backends still return an object; caller checks `.enabled`.
 *
 * Fields match what backends.mjs and run.mjs consume (mirrors emit_backend_env in config.py).
 *
 * @param {object} roster
 * @param {string} name
 * @returns {object}
 */
export function backend(roster, name) {
  const backends = roster.backends ?? {};
  const be = backends[name];

  if (!be || typeof be !== 'object') {
    return { enabled: false };
  }

  // Full tier->model map, forwarded verbatim so a roster can declare ANY tier keys it likes
  // (cheap/standard/high/…), not just the two the original port hardcoded. Non-string values are
  // dropped so a stray object can never reach a command line.
  const models = (be.models && typeof be.models === 'object' && !Array.isArray(be.models)) ? be.models : {};
  const model_tiers = {};
  for (const [k, v] of Object.entries(models)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string') model_tiers[k] = v;
  }
  // Aliases let a roster (or a --model flag) name a model by a short handle — `flash` ->
  // `gemini-3.6-flash-low` — instead of repeating a full id at every tier.
  const aliases = (be.model_aliases && typeof be.model_aliases === 'object' && !Array.isArray(be.model_aliases)) ? be.model_aliases : {};
  const model_aliases = {};
  for (const [k, v] of Object.entries(aliases)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string' && v.trim()) model_aliases[k.toLowerCase()] = v.trim();
  }

  return {
    // `enabled` folds in the env kill switches, so EVERY consumer that checks `.enabled`
    // (run.mjs's chain walk, the health gate, /team) honours MMT_DISABLE_BACKENDS for free.
    enabled: (be.enabled ?? false) === true && !backendDisabledByEnv(name),
    // The raw roster verdict, so a caller can tell "you disabled it" from "the env killed it".
    roster_enabled: be.enabled ?? false,
    name,
    kind: be.kind ?? '',
    bin: be.cmd ?? name,
    bin_candidates: Array.isArray(be.bin_candidates) ? be.bin_candidates : [],
    cmd: be.cmd ?? name,
    model_tiers,
    model_aliases,
    // Tier used when a route asks for one this backend doesn't define. Defaults to `standard`.
    default_tier: typeof be.default_tier === 'string' && be.default_tier.trim() ? be.default_tier.trim() : 'standard',
    use_winpty: be.use_winpty ?? true,
    winpty_flags: Array.isArray(be.winpty_flags)
      ? be.winpty_flags
      : ['-Xallow-non-tty', '-Xplain'],
    oneshot_flag: be.oneshot_flag ?? '--print',
    sandbox_flag: be.sandbox_flag ?? '--sandbox',
    extra: Array.isArray(be.extra) ? be.extra : [],
    // writable_extra: flags used INSTEAD of `extra` in /team --writable mode (full-auto). When
    // absent, backends.mjs falls back to `extra` (i.e. no writable lane = no behaviour change).
    writable_extra: Array.isArray(be.writable_extra) ? be.writable_extra : undefined,
    print_flag: be.oneshot_flag ?? '--print',   // alias consumed by backends.mjs
    hard_timeout: be.hard_timeout ?? '15m',
    quota_patterns: Array.isArray(be.quota_patterns) ? be.quota_patterns : [],
    quota_exit_codes: Array.isArray(be.quota_exit_codes) ? be.quota_exit_codes : [],
    // pass-through fields backends.mjs may read
    model_flag: be.model_flag ?? '--model',
    health: be.health ?? '--version',
    add_dir_flag: be.add_dir_flag ?? '--add-dir',
    // Per-invocation agent/profile selection (opencode: `--agent plan` read-only vs `build`
    // writable). Absent for backends that express the same thing through `extra`/`writable_extra`.
    agent_flag: be.agent_flag ?? '',
    // Flag used to tell a backend which directory to run in, for CLIs that ignore the spawned
    // process's cwd (opencode does — see its roster note).
    cwd_flag: be.cwd_flag ?? '',
    agent: be.agent ?? '',
    writable_agent: be.writable_agent ?? '',
    // HUD cost estimate (USD per 1000 output chars). Previously dropped here, which silently
    // zeroed every cost figure run.mjs wrote to the statusline no matter what the roster declared.
    cost_per_1k_chars: Number(be.cost_per_1k_chars) || 0,
    // Auth/credential failures are NOT quota exhaustion; kept separate so the handoff reason says
    // "not logged in" instead of mislabelling a 401 as a credit limit.
    auth_patterns: Array.isArray(be.auth_patterns) ? be.auth_patterns : [],
  };
}

// ─── agents ──────────────────────────────────────────────────────────────────

/**
 * Return the agents map (object keyed by agent name) from roster.
 * _comment/_about keys are not present in the agents section of the schema
 * so no filtering is needed here; forward them as-is.
 *
 * @param {object} roster
 * @returns {object}
 */
export function agents(roster) {
  return roster.agents ?? {};
}

// ─── routes ──────────────────────────────────────────────────────────────────

/**
 * Return the routes array with _comment marker objects filtered out.
 * A marker object has a `_comment` key and no `name` key.
 *
 * @param {object} roster
 * @returns {object[]}
 */
export function routes(roster) {
  const raw = roster.routes ?? [];
  return raw.filter(r => typeof r === 'object' && r !== null && !('_comment' in r && !('name' in r)));
}

// ─── teamConfig ──────────────────────────────────────────────────────────────

/**
 * Return the /team PIPELINE config merged over built-in defaults. Keys starting with `_` are
 * ignored. This no longer decides which backend runs anything — that is the role staffing's job
 * (src/lib/roles.mjs) — so there is nothing here to merge key-by-key.
 *
 * `native_models` is FORWARDED from `defaults.native_models`, not a separate knob: the workflow
 * needs a tier->Claude-model map and the Workflow runtime can't read the roster itself, but the map
 * must stay single-sourced.
 *
 * @param {object} roster
 * @returns {object}
 */
export function teamConfig(roster) {
  const t = roster.team ?? {};
  const merged = { ...TEAM_DEFAULTS };

  for (const [k, v] of Object.entries(t)) {
    if (k.startsWith('_')) continue;
    merged[k] = v;
  }

  merged.native_models = nativeModels(roster);
  return merged;
}

// ─── reasoningConfig ─────────────────────────────────────────────────────────

/**
 * Return reasoning config merged over built-in defaults (mirrors teamConfig).
 * `tier_models` is merged key-by-key; `panel` is replaced wholesale if present.
 * Keys starting with `_` are ignored.
 *
 * @param {object} roster
 * @returns {object}
 */
export function reasoningConfig(roster) {
  const r = roster.reasoning ?? {};

  // deep-copy defaults so we don't mutate the constant
  const merged = Object.fromEntries(
    Object.entries(REASONING_DEFAULTS).map(([k, v]) => [
      k,
      Array.isArray(v) ? [...v] : (v && typeof v === 'object' ? { ...v } : v),
    ])
  );

  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith('_')) continue;
    if (
      k === 'tier_models' &&
      v && typeof v === 'object' && !Array.isArray(v) &&
      merged[k] && typeof merged[k] === 'object'
    ) {
      Object.assign(merged[k], v);
    } else {
      merged[k] = v;
    }
  }

  return merged;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

import { pathToFileURL, fileURLToPath } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Two arg forms:
  //   node config.mjs <mode>              -> roster via shared resolver (.mmt/roster.json >
  //                                          ~/.claude/mmt-roster.json > plugin default)
  //   node config.mjs <rosterPath> <mode> -> explicit roster path (back-compat; tests use this)
  const KNOWN_MODES = new Set(['team-config', 'reasoning-config']);
  const rest = process.argv.slice(2);
  let rosterPath;
  let mode;
  if (rest.length === 1 && KNOWN_MODES.has(rest[0])) {
    mode = rest[0];
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    rosterPath = resolveRosterPath(root);
  } else {
    [rosterPath, mode] = rest;
  }
  if (!rosterPath || !mode) {
    process.stderr.write('Usage: node config.mjs [<rosterPath>] <mode>\n');
    process.exit(2);
  }
  let roster;
  try {
    roster = loadRoster(rosterPath);
  } catch (e) {
    process.stderr.write(`config.mjs: failed to load roster: ${e.message}\n`);
    process.exit(1);
  }
  if (mode === 'team-config') {
    process.stdout.write(JSON.stringify(teamConfig(roster)) + '\n');
  } else if (mode === 'reasoning-config') {
    process.stdout.write(JSON.stringify(reasoningConfig(roster)) + '\n');
  } else {
    process.stderr.write(`config.mjs: unknown mode '${mode}'. Supported: team-config, reasoning-config\n`);
    process.exit(2);
  }
}
