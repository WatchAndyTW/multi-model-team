/**
 * config.mjs — roster.json loader (Node ESM port of scripts/lib/config.py)
 *
 * Replaces the bash-eval contract with plain JS objects.
 * Zero runtime dependencies (Node stdlib only). ESM, win32/linux/darwin.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveRosterPath } from './platform.mjs';

// ─── team defaults (mirrors TEAM_DEFAULTS in config.py) ──────────────────────
const TEAM_DEFAULTS = {
  dispatch_backends: ['agy', 'codex', 'native'],
  verifier: 'codex',
  verify: true,
  max_fix_loops: 1,
  caps: { agy: 4, codex: 2, native: 2 },
  tier_models: { cheap: 'haiku', standard: 'sonnet', sonnet: 'sonnet', opus: 'opus' },
  relay_model: 'sonnet',
};

// ─── reasoning defaults (mirrors REASONING_DEFAULTS in docs/REASONING.md) ─────
const REASONING_DEFAULTS = {
  panel: ['opus', 'sonnet', 'gemini'],
  judge: 'native:opus',
  synthesizer: 'native:opus',
  cap: 6,
  tier_models: { cheap: 'haiku', standard: 'sonnet', sonnet: 'sonnet', opus: 'opus', haiku: 'haiku' },
  relay_model: 'sonnet',
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

  const models = be.models ?? {};

  return {
    enabled: be.enabled ?? false,
    kind: be.kind ?? '',
    bin: be.cmd ?? name,
    bin_candidates: Array.isArray(be.bin_candidates) ? be.bin_candidates : [],
    cmd: be.cmd ?? name,
    model_tiers: {
      cheap: models.cheap ?? '',
      standard: models.standard ?? '',
    },
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

// ─── proactive ───────────────────────────────────────────────────────────────

/**
 * @param {object} roster
 * @returns {{ enabled: boolean, max_chars: number, min_chars: number, rules: string, guard_spawns: boolean, enforce_spawns: boolean }}
 */
export function proactive(roster) {
  const p = roster.proactive ?? {};
  return {
    enabled: p.enabled ?? false,
    max_chars: _int(p.max_chars, 0),
    min_chars: _int(p.min_chars, 0),
    rules: p.rules ?? '',
    guard_spawns: p.guard_spawns ?? true,
    enforce_spawns: p.enforce_spawns ?? false,
  };
}

// ─── teamConfig ──────────────────────────────────────────────────────────────

/**
 * Return team config merged over built-in defaults (mirrors emit_team_config in config.py).
 * `caps` and `tier_models` are merged key-by-key. Keys starting with `_` are ignored.
 *
 * @param {object} roster
 * @returns {object}
 */
export function teamConfig(roster) {
  const t = roster.team ?? {};

  // deep-copy defaults so we don't mutate the constant
  const merged = Object.fromEntries(
    Object.entries(TEAM_DEFAULTS).map(([k, v]) => [
      k,
      v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : v,
    ])
  );

  for (const [k, v] of Object.entries(t)) {
    if (k.startsWith('_')) continue;
    if (
      (k === 'caps' || k === 'tier_models') &&
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

// ─── helpers ─────────────────────────────────────────────────────────────────

function _int(value, defaultVal = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : defaultVal;
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
