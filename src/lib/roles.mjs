/**
 * roles.mjs — the /team ROLE system (oh-my-claudecode parity).
 *
 * A ROLE says what a worker is *for* (`planner`, `executor`, `code-reviewer`); a BACKEND says which
 * model runs it (`agy`, `codex`, `opencode`, `native`). They are independent by design — that is the
 * whole point of the spec: you choose the model per job, not per stage. `impl:opencode:2` and
 * `impl:claude:1` are both valid and can coexist in one run.
 *
 * The vocabulary mirrors OMC's staged pipeline (`team-plan -> team-prd -> team-exec -> team-verify
 * -> team-fix`) and its agent catalog, so a user who knows OMC already knows this. Roles, stages,
 * aliases and default tiers all live in `roster.json` under `roles` — nothing here is hardcoded
 * except the fail-safe fallback used when that section is missing.
 *
 * Spec grammar (the shape the user types):
 *
 *   spec       := group (";" group)*
 *   group      := role ":" assignment ("," assignment)*
 *   assignment := backend [":" count] | count ":" backend | backend | count
 *
 *   orch:claude:2;impl:opencode:1,claude:2;review:codex:2
 *
 * Both `backend:count` and `count:backend` are accepted, matching the older cap spec's leniency.
 *
 * Exports:
 *   roleCatalog(roster)             — normalized { role -> {stage, tier, aliases, desc} }
 *   normalizeRole(name, catalog)    — alias/canonical -> canonical role name, or null
 *   looksLikeRoleSpec(text, cat)    — does this text START with a known role token?
 *   parseRoleSpec(spec, opts)       — spec string -> { assignments, byStage, roles, counts, note }
 *   splitRoleSpec(rawText, opts)    — peel leading flags + role spec; -> { ...parsed, task, flags }
 *
 * Zero runtime dependencies (Node stdlib only). ESM, win32/linux/darwin.
 */

// ─── backend vocabulary ──────────────────────────────────────────────────────
//
// The spec's backend words, mapped to roster backend names. Kept in step with team-spec.mjs's cap
// vocabulary so `claude` means native in both, and shares opencode's `oc` alias.
const BACKEND_ALIASES = new Map(Object.entries({
  gemini: 'agy', agy: 'agy', flash: 'agy', pro: 'agy', google: 'agy',
  codex: 'codex', chatgpt: 'codex', openai: 'codex', gpt: 'codex',
  opencode: 'opencode', oc: 'opencode',
  claude: 'native', native: 'native', sonnet: 'native', opus: 'native', haiku: 'native',
  anthropic: 'native',
}));

// A tier the user can pin directly on a native assignment (`orch:opus:1`). Native-only: for a CLI
// backend the tier comes from the role, and the model ladder resolves it per backend.
const BACKEND_TIER_HINT = new Map(Object.entries({
  opus: 'high', sonnet: 'standard', haiku: 'cheap', flash: 'cheap', pro: 'standard',
}));

// Fail-safe catalog: only used when roster.roles is missing/unreadable, so a broken config degrades
// to a working (if smaller) vocabulary instead of rejecting every spec.
const FALLBACK_CATALOG = {
  planner:  { stage: 'plan',   tier: 'high',     aliases: ['orch', 'orchestrator', 'plan'] },
  executor: { stage: 'exec',   tier: 'standard', aliases: ['impl', 'exec', 'implement', 'build'] },
  verifier: { stage: 'verify', tier: 'standard', aliases: ['verify', 'check'] },
  'code-reviewer': { stage: 'verify', tier: 'high', aliases: ['review', 'reviewer'] },
  fixer:    { stage: 'fix',    tier: 'standard', aliases: ['fix'] },
};
const FALLBACK_STAGES = ['plan', 'prd', 'exec', 'verify', 'fix'];

const MAX_PER_ASSIGNMENT = 16;   // parity with the cap spec's clamp

// ─── catalog ─────────────────────────────────────────────────────────────────

/**
 * Normalized role catalog from the roster (documentation keys stripped).
 * @param {object} roster
 * @returns {{catalog:Record<string,{stage:string,tier:string,aliases:string[],desc:string}>, stages:string[], defaultBackend:string, defaultCount:number}}
 */
export function roleCatalog(roster) {
  const cfg = (roster && roster.roles) || {};
  const raw = (cfg.catalog && typeof cfg.catalog === 'object' && !Array.isArray(cfg.catalog))
    ? cfg.catalog : null;

  const catalog = {};
  for (const [name, spec] of Object.entries(raw || FALLBACK_CATALOG)) {
    if (name.startsWith('_') || !spec || typeof spec !== 'object') continue;
    catalog[name] = {
      stage: typeof spec.stage === 'string' && spec.stage ? spec.stage : 'exec',
      tier: typeof spec.tier === 'string' && spec.tier ? spec.tier : 'standard',
      aliases: Array.isArray(spec.aliases) ? spec.aliases.filter((a) => typeof a === 'string') : [],
      desc: typeof spec.desc === 'string' ? spec.desc : '',
    };
  }

  const stages = Array.isArray(cfg.stages) && cfg.stages.length
    ? cfg.stages.filter((s) => typeof s === 'string')
    : FALLBACK_STAGES.slice();

  return {
    catalog,
    stages,
    defaultBackend: typeof cfg.default_backend === 'string' && cfg.default_backend ? cfg.default_backend : 'native',
    defaultCount: Number.isFinite(cfg.default_count) && cfg.default_count > 0 ? Math.floor(cfg.default_count) : 1,
  };
}

/** Build alias -> canonical lookup once per catalog. */
function aliasIndex(catalog) {
  const idx = new Map();
  for (const [name, spec] of Object.entries(catalog)) {
    idx.set(name.toLowerCase(), name);
    for (const a of spec.aliases) idx.set(String(a).toLowerCase(), name);
  }
  return idx;
}

/**
 * Resolve a typed role word to its canonical role name.
 * @param {string} name
 * @param {Record<string,object>} catalog
 * @returns {string|null} canonical role, or null when unknown
 */
export function normalizeRole(name, catalog) {
  const lc = String(name ?? '').trim().toLowerCase();
  if (!lc) return null;
  return aliasIndex(catalog).get(lc) ?? null;
}

/** Resolve a typed backend word to a roster backend name. */
function normalizeBackend(name) {
  const lc = String(name ?? '').trim().toLowerCase();
  return BACKEND_ALIASES.get(lc) ?? null;
}

function clampCount(n) {
  const i = parseInt(n, 10);
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(MAX_PER_ASSIGNMENT, i));
}

/**
 * Does this text begin with a role spec? Used to choose between the ROLE grammar and the older cap
 * grammar without guessing: a spec is a role spec only when its first token names a known role.
 * That keeps `5:gemini,2:claude` (cap) and `orch:claude:2` (role) unambiguous — no cap token can
 * start with a role word, and no role token starts with a bare number.
 * @param {string} text
 * @param {Record<string,object>} catalog
 * @returns {boolean}
 */
export function looksLikeRoleSpec(text, catalog) {
  const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:/.exec(String(text ?? ''));
  if (!m) return false;
  return normalizeRole(m[1], catalog) !== null;
}

// ─── parseRoleSpec ───────────────────────────────────────────────────────────

/**
 * Parse a role spec into concrete worker assignments.
 *
 * @param {string} spec  e.g. "orch:claude:2;impl:opencode:1,claude:2;review:codex:2"
 * @param {{roster?:object}} [opts]
 * @returns {{
 *   assignments: Array<{role:string, stage:string, backend:string, count:number, tier:string}>,
 *   byStage: Record<string, Array<object>>,
 *   roles: string[],
 *   stages: string[],
 *   counts: Record<string, number>,
 *   total: number,
 *   source: 'roles',
 *   note: string
 * }}
 */
export function parseRoleSpec(spec, opts = {}) {
  const { catalog, stages, defaultBackend, defaultCount } = roleCatalog(opts.roster);
  const notes = [];
  const assignments = [];

  for (const rawGroup of String(spec ?? '').split(';')) {
    const group = rawGroup.trim();
    if (!group) continue;

    // `role : rest` — the role is everything before the FIRST colon.
    const colon = group.indexOf(':');
    const roleWord = colon === -1 ? group : group.slice(0, colon);
    const rest = colon === -1 ? '' : group.slice(colon + 1);

    const role = normalizeRole(roleWord, catalog);
    if (!role) {
      notes.push(`ignored unknown role '${roleWord.trim()}'`);
      continue;
    }
    const roleSpec = catalog[role];

    // No backends given (`review` on its own) -> one worker on the default backend.
    if (!rest.trim()) {
      assignments.push({ role, stage: roleSpec.stage, backend: defaultBackend, count: defaultCount, tier: roleSpec.tier });
      continue;
    }

    for (const rawItem of rest.split(',')) {
      const item = rawItem.trim();
      if (!item) continue;

      // Lenient like the cap spec: find the backend part and the numeric part in any order, so
      // `opencode:2` and `2:opencode` both work, and a bare `opencode` means "one".
      const parts = item.split(':').map((p) => p.trim()).filter(Boolean);
      const backendWord = parts.find((p) => normalizeBackend(p) !== null);
      const countWord = parts.find((p) => /^\d+$/.test(p));

      if (!backendWord) {
        notes.push(`ignored '${item}' in role '${role}' (no known backend)`);
        continue;
      }
      const backend = normalizeBackend(backendWord);
      const count = countWord === undefined ? defaultCount : clampCount(countWord);
      if (count === 0) {
        notes.push(`'${role}:${backendWord}' set to 0 — skipped`);
        continue;
      }
      // A native assignment may pin its own tier by naming a Claude model word (`orch:opus:2`);
      // otherwise the role's default tier applies. CLI backends always take the role's tier and let
      // the per-backend model ladder resolve it (so `high` means "that backend's strongest").
      const tierHint = backend === 'native' ? BACKEND_TIER_HINT.get(backendWord.toLowerCase()) : undefined;
      assignments.push({ role, stage: roleSpec.stage, backend, count, tier: tierHint || roleSpec.tier });
    }
  }

  return _shape(assignments, stages, notes.join('; '));
}

/** Group assignments by stage + build the summary counters every consumer wants. */
function _shape(assignments, stages, note) {
  const byStage = {};
  for (const s of stages) byStage[s] = [];
  for (const a of assignments) {
    if (!byStage[a.stage]) byStage[a.stage] = [];
    byStage[a.stage].push(a);
  }
  // Only stages that actually have workers — an empty stage is skipped by the pipeline.
  const activeStages = stages.filter((s) => (byStage[s] || []).length > 0);

  const counts = {};
  for (const a of assignments) counts[a.backend] = (counts[a.backend] ?? 0) + a.count;

  return {
    assignments,
    byStage,
    roles: [...new Set(assignments.map((a) => a.role))],
    stages: activeStages,
    counts,
    total: assignments.reduce((n, a) => n + a.count, 0),
    source: 'roles',
    note,
  };
}

// ─── splitRoleSpec ───────────────────────────────────────────────────────────

/**
 * Peel leading mode flags and a leading ROLE spec off raw input.
 *
 * Mirrors team-spec.splitSpec: flags may sit on either side of the spec, and neither the flags nor
 * the spec are left in the task text.
 *
 * @param {string} rawText
 * @param {{roster?:object}} [opts]
 * @returns {object|null} parsed role spec + { task, flags, writable }, or null when the text does
 *                        not start with a role spec (caller falls back to the cap grammar).
 */
export function splitRoleSpec(rawText, opts = {}) {
  let text = String(rawText ?? '').trim();
  const { catalog } = roleCatalog(opts.roster);

  const flags = [];
  const peelFlags = () => {
    let m;
    while ((m = /^\s*(--[A-Za-z][A-Za-z0-9-]*)(?=\s|$)/.exec(text))) {
      flags.push(m[1].toLowerCase());
      text = text.slice(m[0].length).trim();
    }
  };
  peelFlags();

  if (!looksLikeRoleSpec(text, catalog)) return null;

  // The spec runs up to the first whitespace that is NOT inside the spec grammar. Role specs never
  // contain spaces in practice, but tolerate them around the `;` and `,` separators so
  // `orch:claude:2; impl:opencode:1` parses. Consume greedily while the next token still looks like
  // spec syntax, then treat the remainder as the task.
  const specTokenRe = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*(?:\s*[,;]\s*)?/;
  let spec = '';
  for (;;) {
    const m = specTokenRe.exec(text);
    if (!m) break;
    const chunk = m[0];
    spec += chunk;
    text = text.slice(chunk.length);
    // Keep going only while the chunk ended on a separator — otherwise the spec is complete.
    if (!/[,;]\s*$/.test(chunk)) break;
    text = text.replace(/^\s+/, '');
  }

  text = text.trim();
  peelFlags();   // `roles --writable task`

  const parsed = parseRoleSpec(spec, opts);
  return { ...parsed, task: text.trim(), flags, writable: flags.includes('--writable') };
}

// ─── describe (for command output / --roles) ─────────────────────────────────

/**
 * Human-readable catalog listing, grouped by stage — backs `route.mjs --roles`.
 * @param {object} roster
 * @returns {string}
 */
export function describeRoles(roster) {
  const { catalog, stages } = roleCatalog(roster);
  const lines = [];
  for (const stage of stages) {
    const inStage = Object.entries(catalog).filter(([, s]) => s.stage === stage);
    if (!inStage.length) continue;
    lines.push(`${stage}:`);
    for (const [name, spec] of inStage) {
      const aliases = spec.aliases.length ? `  (${spec.aliases.join(', ')})` : '';
      lines.push(`  ${name.padEnd(20)} tier=${spec.tier.padEnd(9)}${aliases}`);
      if (spec.desc) lines.push(`  ${' '.repeat(20)} ${spec.desc}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadRoster } = await import('./config.mjs');
  const { resolveRosterPath } = await import('./platform.mjs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let roster = {};
  try { roster = loadRoster(resolveRosterPath(root)); } catch { /* fall back to built-ins */ }

  if (process.argv.includes('--list')) {
    process.stdout.write(describeRoles(roster));
    process.exit(0);
  }

  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = chunks.join('');
    const useSplit = process.argv.includes('--split');
    const result = useSplit ? splitRoleSpec(raw, { roster }) : parseRoleSpec(raw.trim(), { roster });
    process.stdout.write(JSON.stringify(result) + '\n');
  });
}
