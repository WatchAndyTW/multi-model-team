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
 * Staffing is the ONLY thing that decides which backend does which job — there is no separate
 * auto-assignment panel. `resolveStaffing` turns whatever the user typed (a role spec, a
 * backend-only spec, or nothing at all) into a COMPLETE staffing table by applying three rules:
 *
 *   1. what the user staffed, stands;
 *   2. a core role with a `follows` target borrows that role's backends (the fixer follows the
 *      executor, so a fix goes back to whoever did the work);
 *   3. every remaining core job falls back to Claude at that role's tier — never to a CLI.
 *
 * Exports:
 *   roleCatalog(roster)             — normalized { role -> {stage, tier, aliases, desc} } + core map
 *   normalizeRole(name, catalog)    — alias/canonical -> canonical role name, or null
 *   looksLikeRoleSpec(text, cat)    — does this text START with a known role token?
 *   parseRoleSpec(spec, opts)       — spec string -> { assignments, byStage, roles, counts, note }
 *   splitRoleSpec(rawText, opts)    — peel leading flags + role spec; -> { ...parsed, task, flags }
 *   resolveStaffing(parsed, opts)   — explicit assignments -> the COMPLETE staffing table
 *   staffingFromBackends(counts, o) — backend-only counts -> staffing (they become the executors)
 *
 * Zero runtime dependencies (Node stdlib only). ESM, win32/linux/darwin.
 */

import { backendNames, isBackendEnabled } from './config.mjs';

// ─── backend vocabulary ──────────────────────────────────────────────────────
//
// Every backend declared in the roster is nameable by its OWN key automatically, so adding one to
// roster.json makes it staffable with no code change here. This map covers the two things roster
// keys can't: the nicknames (`gemini` for agy, `chatgpt` for codex, `claude` for native), and the
// shipped backends' own names as a fail-safe for when the roster is missing/unreadable (the same
// reason FALLBACK_CATALOG exists). Kept in step with team-spec.mjs's cap vocabulary.
const BACKEND_ALIASES = new Map(Object.entries({
  agy: 'agy', gemini: 'agy', flash: 'agy', pro: 'agy', google: 'agy',
  codex: 'codex', chatgpt: 'codex', openai: 'codex', gpt: 'codex',
  opencode: 'opencode', oc: 'opencode',
  claude: 'native', native: 'native', sonnet: 'native', opus: 'native', haiku: 'native',
  anthropic: 'native',
}));

/** Backend keys the roster declares (documentation `_keys` excluded). */
function rosterBackendNames(roster) {
  const b = (roster && roster.backends) || {};
  return Object.keys(b).filter((k) => !k.startsWith('_') && b[k] && typeof b[k] === 'object');
}

/**
 * Every backend word this roster understands: its own declared keys, plus `native`, plus the
 * friendly aliases. Exported so the cap grammar (team-spec.mjs) can build the same vocabulary
 * instead of keeping a second hardcoded copy that drifts.
 * @param {object} roster
 * @returns {string[]} lowercase words, longest first (for regex alternation)
 */
export function backendWords(roster) {
  const words = new Set(['native', ...rosterBackendNames(roster).map((n) => n.toLowerCase())]);
  for (const alias of BACKEND_ALIASES.keys()) words.add(alias);
  return [...words].sort((a, b) => b.length - a.length);
}

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

// The jobs the pipeline always needs, used when roster.roles.core is missing/unreadable.
const FALLBACK_CORE = {
  executor: { count: 4 },
  verifier: { count: 1 },
  fixer: { count: 1, follows: 'executor' },
};

// Two of the stages are the pipeline's OWN machinery rather than planned work: `verify` reviews each
// exec result and `fix` repairs it. Roles on those stages staff the verify/fix loop; roles on every
// other stage are decomposed into subtasks. Naming them here (instead of scattering the check) is
// what keeps "who reviews" and "who implements" one mechanism instead of two.
export const VERIFY_STAGE = 'verify';
export const FIX_STAGE = 'fix';

const MAX_PER_ASSIGNMENT = 16;   // parity with the cap spec's clamp

// ─── catalog ─────────────────────────────────────────────────────────────────

/**
 * Normalized role catalog from the roster (documentation keys stripped).
 * @param {object} roster
 * @returns {{catalog:Record<string,{stage:string,tier:string,aliases:string[],desc:string}>, stages:string[], defaultBackend:string, defaultCount:number, core:Record<string,{count:number,follows:string}>}}
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

  // The always-needed jobs. Only roles the catalog actually knows survive, so a typo in `core`
  // can't conjure a role with no stage or tier.
  const rawCore = (cfg.core && typeof cfg.core === 'object' && !Array.isArray(cfg.core)) ? cfg.core : FALLBACK_CORE;
  const core = {};
  for (const [name, spec] of Object.entries(rawCore)) {
    if (name.startsWith('_') || !catalog[name]) continue;
    const count = spec && Number.isFinite(spec.count) && spec.count > 0 ? Math.floor(spec.count) : 1;
    core[name] = {
      count: Math.min(MAX_PER_ASSIGNMENT, count),
      follows: spec && typeof spec.follows === 'string' && catalog[spec.follows] ? spec.follows : '',
      // Optional per-role fallback backend, for "I always want X doing this job" without typing a
      // spec every run. Absent -> `default_backend` (Claude).
      backend: spec && typeof spec.backend === 'string' && spec.backend ? spec.backend : '',
    };
  }

  return {
    catalog,
    stages,
    core,
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

/**
 * Resolve a typed backend word to a roster backend name. A roster's OWN key always wins, so a newly
 * declared backend is staffable immediately; the alias map only covers nicknames.
 * @param {string} name
 * @param {object} [roster]
 */
function normalizeBackend(name, roster) {
  const lc = String(name ?? '').trim().toLowerCase();
  if (!lc) return null;
  if (lc === 'native') return 'native';
  const declared = rosterBackendNames(roster).find((n) => n.toLowerCase() === lc);
  if (declared) return declared;
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
      assignments.push({ role, stage: roleSpec.stage, backend: defaultBackend, count: defaultCount, tier: roleSpec.tier, desc: roleSpec.desc });
      continue;
    }

    for (const rawItem of rest.split(',')) {
      const item = rawItem.trim();
      if (!item) continue;

      // Lenient like the cap spec: find the backend part and the numeric part in any order, so
      // `opencode:2` and `2:opencode` both work, and a bare `opencode` means "one".
      const parts = item.split(':').map((p) => p.trim()).filter(Boolean);
      const backendWord = parts.find((p) => normalizeBackend(p, opts.roster) !== null);
      const countWord = parts.find((p) => /^\d+$/.test(p));

      if (!backendWord) {
        notes.push(`ignored '${item}' in role '${role}' (no known backend)`);
        continue;
      }
      const backend = normalizeBackend(backendWord, opts.roster);
      const count = countWord === undefined ? defaultCount : clampCount(countWord);
      if (count === 0) {
        notes.push(`'${role}:${backendWord}' set to 0 — skipped`);
        continue;
      }
      // A native assignment may pin its own tier by naming a Claude model word (`orch:opus:2`);
      // otherwise the role's default tier applies. CLI backends always take the role's tier and let
      // the per-backend model ladder resolve it (so `high` means "that backend's strongest").
      const tierHint = backend === 'native' ? BACKEND_TIER_HINT.get(backendWord.toLowerCase()) : undefined;
      // desc rides along so the Workflow engine (which has no filesystem access) can brief each
      // worker on its role without re-reading the roster.
      assignments.push({ role, stage: roleSpec.stage, backend, count, tier: tierHint || roleSpec.tier, desc: roleSpec.desc });
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

  // Scan the spec off the front, CONTEXT-AWARE. The old greedy regex consumed any word-shaped token
  // after a separator, so `review:codex:2; which is a problem` ate `which` out of the user's task
  // text; and it stopped dead at a space after a colon, so `review: codex:2 task` lost the `codex:2`
  // and left the task starting with a stray `:`. Both are silent corruption of what the user typed.
  //
  // So: track what may legitimately come next and stop the moment it doesn't.
  //   after `;` -> a ROLE starts the next group
  //   after `,` -> another assignment: a BACKEND (`impl:opencode:1,claude:2`) or a role
  //   after `:` -> a BACKEND or a COUNT
  // Whitespace is tolerated around every separator, including after a colon.
  const TOKEN = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*/;
  const head = (tok) => String(tok).split(':')[0];
  const isRole = (tok) => normalizeRole(head(tok), catalog) !== null;
  const isBackend = (tok) => normalizeBackend(head(tok), opts.roster) !== null;
  const accepts = {
    role: isRole,
    assignment: (tok) => isBackend(tok) || isRole(tok),
    value: (tok) => isBackend(tok) || /^\d+$/.test(head(tok)),
  };

  let i = 0;          // cursor
  let end = 0;        // index just past the last character that is definitely part of the spec
  let expect = null;  // null = the first token, already validated by looksLikeRoleSpec above
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    const m = TOKEN.exec(text.slice(i));
    if (!m) break;
    const tok = m[0];
    if (expect && !accepts[expect](tok)) break;   // not spec syntax -> the task starts here
    i += tok.length;
    end = i;
    // A separator (or a dangling colon) means the spec continues; anything else ends it.
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    const sep = text[j];
    if (sep === ';') { i = j + 1; end = i; expect = 'role'; continue; }
    if (sep === ',') { i = j + 1; end = i; expect = 'assignment'; continue; }
    if (sep === ':') { i = j + 1; end = i; expect = 'value'; continue; }
    break;
  }
  const spec = text.slice(0, end);
  text = text.slice(end).trim();
  peelFlags();   // `roles --writable task`

  const parsed = parseRoleSpec(spec, opts);
  return { ...parsed, task: text.trim(), flags, writable: flags.includes('--writable') };
}

// ─── resolveStaffing ─────────────────────────────────────────────────────────

/**
 * Turn what the user staffed into the COMPLETE staffing table the pipeline runs on.
 *
 * This is the single place a job gets a backend. Three rules, in order:
 *   1. explicit assignments stand (a disabled backend is dropped with a note — the user's switch
 *      wins over their spec, same as the router skipping a disabled route);
 *   2. a core role with `follows` copies that role's staffing (fixer follows executor, so a fix
 *      goes back to the backend that did the work);
 *   3. any core job still unstaffed runs on `default_backend` (Claude) at the role's catalog tier.
 *
 * @param {object|Array} input   parseRoleSpec/splitRoleSpec output, or a bare assignments array
 * @param {{roster?:object}} [opts]
 * @returns {{
 *   assignments: Array<object>, workers: Array<object>, verifiers: Array<object>,
 *   fixers: Array<object>, byStage: Record<string,Array<object>>, roles: string[],
 *   stages: string[], counts: Record<string,number>, backends: string[],
 *   defaulted: string[], note: string
 * }}
 */
export function resolveStaffing(input, opts = {}) {
  const roster = opts.roster || {};
  const { catalog, stages, core, defaultBackend, defaultCount } = roleCatalog(roster);

  const explicit = Array.isArray(input)
    ? input
    : (input && Array.isArray(input.assignments) ? input.assignments : []);
  const notes = [];
  if (input && typeof input.note === 'string' && input.note) notes.push(input.note);

  // A backend the user switched off is not a staffing option — honour the switch here rather than
  // dispatching to it and letting run.mjs bounce it back. Skipped entirely for a roster that
  // declares no backends at all (the fallback-catalog path), where "enabled" is unknowable.
  const gated = backendNames(roster).length > 0;
  const usable = (b) => !gated || isBackendEnabled(roster, b);

  const out = [];
  for (const a of explicit) {
    if (!a || !a.role || !catalog[a.role]) continue;
    if (!usable(a.backend)) {
      notes.push(`'${a.role}' on ${a.backend} skipped — that backend is disabled`);
      continue;
    }
    out.push({ ...a, source: 'spec' });
  }

  // A core job is satisfied by ANY role on its stage, not just the canonical one: staffing
  // `review:codex:2` (code-reviewer) IS staffing the review job, so it must not also get a
  // defaulted Claude verifier alongside it. Same for exec — `designer:agy:2` staffs the work.
  const covered = (stage) => out.some((a) => a.stage === stage);

  // 2 · inheritance, before defaulting: a follower only defaults if its target stage is empty too.
  for (const [role, spec] of Object.entries(core)) {
    const meta = catalog[role];
    if (!spec.follows || covered(meta.stage)) continue;
    // Follow the target's STAGE, not just its role name — a fix goes back to whoever did the work,
    // whether that was the executor, the designer, or the debugger.
    const fromStage = catalog[spec.follows].stage;
    const from = out.filter((a) => a.stage === fromStage);
    if (!from.length) continue;
    for (const src of from) {
      out.push({
        role, stage: meta.stage, backend: src.backend, count: src.count,
        tier: meta.tier, desc: meta.desc, source: 'follows', follows: spec.follows,
      });
    }
    notes.push(`${role} follows ${spec.follows} (${[...new Set(from.map((a) => a.backend))].join(', ')})`);
  }

  // 3 · everything still unstaffed falls back to Claude at the role's own tier. A core entry may
  //     name its own fallback `backend` (e.g. "always review on codex"); a disabled one reverts to
  //     the global default rather than staffing a backend that can't run.
  //
  // `default_backend` is user-editable and can itself name a DISABLED backend — in which case every
  // unstaffed job (i.e. the whole pipeline, for a bare `/team <task>`) was being auto-staffed onto a
  // backend that cannot run, silently defeating the switch. The global fallback must be usable too;
  // `native` is the guaranteed final option, which is exactly why it can never be disabled.
  const globalDefault = usable(defaultBackend) ? defaultBackend : 'native';
  if (globalDefault !== defaultBackend) {
    notes.push(`default_backend '${defaultBackend}' is disabled — unstaffed jobs fall back to native`);
  }
  const defaulted = [];
  for (const [role, spec] of Object.entries(core)) {
    const meta = catalog[role];
    if (covered(meta.stage)) continue;
    const pref = spec.backend && usable(spec.backend) ? spec.backend : globalDefault;
    out.push({
      role, stage: meta.stage, backend: pref,
      count: Math.max(1, Math.min(MAX_PER_ASSIGNMENT, spec.count || defaultCount)),
      tier: meta.tier, desc: meta.desc, source: 'default',
    });
    defaulted.push(role);
  }

  // Group. `verify`/`fix` staff the pipeline's own loop; every other stage is decomposed into work.
  const workers = out.filter((a) => a.stage !== VERIFY_STAGE && a.stage !== FIX_STAGE);
  const verifiers = _dedupe(out.filter((a) => a.stage === VERIFY_STAGE));
  const fixers = out.filter((a) => a.stage === FIX_STAGE);

  const byStage = {};
  for (const a of out) (byStage[a.stage] ??= []).push(a);

  const counts = {};
  for (const a of out) counts[a.backend] = (counts[a.backend] ?? 0) + a.count;

  return {
    assignments: out,
    workers,
    verifiers,
    fixers,
    byStage,
    roles: [...new Set(out.map((a) => a.role))],
    // Active WORKER stages only, in pipeline order — what the decomposer plans for.
    stages: stages.filter((s) => workers.some((a) => a.stage === s)),
    // The full pipeline order, so a consumer that can't read the roster (the Workflow runtime) can
    // still sort stages without hardcoding the list.
    stageOrder: stages,
    counts,
    backends: [...new Set(workers.map((a) => a.backend))],
    defaulted,
    note: notes.filter(Boolean).join('; '),
  };
}

/**
 * One entry per (role, backend, TIER). A count on a reviewer bounds parallelism, not reviews per
 * result — but a different TIER is a different reviewer, not a duplicate. Keying by (role, backend)
 * alone silently collapsed `verify:opus:1,sonnet:1` to the opus one: the same tier-collapse that hit
 * worker slots, on the verify side. The user staffed two reviewers and got one.
 */
function _dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = `${a.role}|${a.backend}|${a.tier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/**
 * Staffing from a backend-only choice (`5:gemini,2:claude`, or the roster/env default): naming a
 * backend without a role means "use it to DO the work", so those become the executors — and the
 * fixer follows them by inheritance. Everything else falls back to Claude.
 *
 * @param {Record<string,number>} counts  by roster backend name, e.g. { agy: 5, native: 2 }
 * @param {{roster?:object}} [opts]
 */
export function staffingFromBackends(counts, opts = {}) {
  const { catalog } = roleCatalog(opts.roster);
  const meta = catalog.executor;
  const assignments = [];
  if (meta) {
    for (const [backend, n] of Object.entries(counts || {})) {
      const count = Math.max(0, Math.min(MAX_PER_ASSIGNMENT, parseInt(n, 10) || 0));
      if (!count) continue;
      assignments.push({ role: 'executor', stage: meta.stage, backend, count, tier: meta.tier, desc: meta.desc });
    }
  }
  return resolveStaffing(assignments, opts);
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
    let result;
    if (process.argv.includes('--staff')) {
      // The RESOLVED table — what actually runs, including the Claude fallbacks. `--split`/default
      // show only what the user typed, which is the right view for debugging the grammar itself.
      const split = splitRoleSpec(raw, { roster });
      const staffing = resolveStaffing(split || parseRoleSpec(raw.trim(), { roster }), { roster });
      result = split ? { ...staffing, task: split.task, flags: split.flags, writable: split.writable } : staffing;
    } else if (process.argv.includes('--split')) {
      result = splitRoleSpec(raw, { roster });
    } else {
      result = parseRoleSpec(raw.trim(), { roster });
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  });
}
