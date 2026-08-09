/**
 * team-spec.mjs — parse a /team spec into the staffing the pipeline runs on.
 *
 * TWO grammars, ONE result. Whatever the user typed — a role spec (`impl:opencode:2`), a
 * backend-only spec (`5:gemini,2:claude`), or nothing at all — `splitSpec` returns a fully
 * RESOLVED staffing table in `.roles`, with every unstaffed job defaulted to Claude by
 * `roles.resolveStaffing`. There is no separate auto-assignment panel to fall back to: a backend
 * runs only where the user put it.
 *
 * A backend-only spec means "use these to DO the work" — they become the executors, and the fix
 * stage follows them.
 *
 * Exports:
 *   parseCaps(spec)      — "N:gemini,M:claude" -> { gemini, codex, opencode, claude, total, source, note }
 *                          (what the user TYPED; an empty/garbage spec is zeros, not a default panel)
 *   splitSpec(rawText)   — peel leading mode flags + a LEADING spec of either grammar;
 *                          return { caps, roles, task, source, flags, writable }
 *
 * Cap keys are the /team SPEC vocabulary, not roster backend names:
 *   gemini -> agy,  codex -> codex,  opencode -> opencode,  claude -> native.
 * A backend missing from these alias sets is invisible to the spec: `_normalize` returns null, the
 * pair is dropped as "unparseable" AND `splitSpec`'s alternation never matches it, so the whole
 * spec is swallowed into the task text. That is exactly what happened to opencode before it was
 * added here — `/team 2:opencode <task>` silently lost both the cap and the spec boundary.
 */

import { splitRoleSpec, resolveStaffing, staffingFromBackends } from './roles.mjs';

// ─── alias sets ──────────────────────────────────────────────────────────────

const GEMINI_ALIASES   = new Set(['gemini', 'agy', 'flash', 'pro', 'google']);
const CODEX_ALIASES    = new Set(['codex', 'chatgpt', 'openai', 'gpt']);
const OPENCODE_ALIASES = new Set(['opencode', 'oc']);
const CLAUDE_ALIASES   = new Set(['claude', 'native', 'sonnet', 'opus', 'anthropic']);

// ─── constants ───────────────────────────────────────────────────────────────

const MAX_PER_BACKEND = 16;

// Cap-spec key -> roster backend name, and back. The two vocabularies are kept apart deliberately:
// `.caps` has always spoken gemini/claude, while staffing speaks agy/native.
const CAP_TO_BACKEND = { gemini: 'agy', codex: 'codex', opencode: 'opencode', claude: 'native' };
const BACKEND_TO_CAP = { agy: 'gemini', codex: 'codex', opencode: 'opencode', native: 'claude' };

// ─── helpers ─────────────────────────────────────────────────────────────────

function _clamp(n) {
  const i = parseInt(n, 10);
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(MAX_PER_BACKEND, i));
}

function _normalize(name) {
  const lc = String(name ?? '').trim().toLowerCase();
  if (GEMINI_ALIASES.has(lc))   return 'gemini';
  if (CODEX_ALIASES.has(lc))    return 'codex';
  if (OPENCODE_ALIASES.has(lc)) return 'opencode';
  if (CLAUDE_ALIASES.has(lc))   return 'claude';
  return null;
}

// ─── parseCaps ───────────────────────────────────────────────────────────────

/**
 * Parse a pure cap spec string into per-backend caps.
 *
 * @param {string} spec  e.g. "5:gemini,2:claude" or "gemini:3,codex:2"
 * @returns {{ gemini:number, codex:number, claude:number, total:number, source:string, note:string }}
 */
export function parseCaps(spec) {
  const s = String(spec ?? '').trim();
  if (!s) {
    return _defaults('');
  }

  const caps  = {};
  const notes = [];

  for (const raw of s.split(',')) {
    const pair = raw.trim();
    if (!pair) continue;

    const parts = pair.split(':').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      notes.push(`ignored malformed pair '${pair}'`);
      continue;
    }

    // Lenient: find the numeric part and the backend part (handles 3-token "5:gemini:standard").
    const nums  = parts.filter(p => /^\d+$/.test(p));
    const names = parts.filter(p => _normalize(p) !== null);

    if (!nums.length || !names.length) {
      notes.push(`ignored unparseable pair '${pair}'`);
      continue;
    }
    if (parts.length > 2) {
      notes.push(`used ${nums[0]}:${names[0]} from '${pair}'`);
    }

    const key = _normalize(names[0]);
    caps[key] = (caps[key] ?? 0) + _clamp(nums[0]);
  }

  if (!Object.keys(caps).length) {
    return _defaults(notes.join('; ') || 'no usable pairs in spec');
  }

  const gemini   = _clamp(caps.gemini   ?? 0);
  const codex    = _clamp(caps.codex    ?? 0);
  const opencode = _clamp(caps.opencode ?? 0);
  const claude   = _clamp(caps.claude   ?? 0);
  return { gemini, codex, opencode, claude,
           total: gemini + codex + opencode + claude,
           source: 'spec', note: notes.join('; ') };
}

/**
 * "The user named no backends." Deliberately ZEROS, not a default panel of CLI agents: the old
 * built-in 4-gemini/2-codex/2-opencode/2-claude spread auto-staffed CLIs nobody asked for. Staffing
 * defaults now live in ONE place — `roles.resolveStaffing`, which fills every unstaffed job with
 * Claude — so there is nothing to duplicate here.
 */
function _defaults(note) {
  return { gemini: 0, codex: 0, opencode: 0, claude: 0, total: 0, source: 'default', note };
}

// ─── splitSpec ───────────────────────────────────────────────────────────────

/**
 * Deterministically peel any LEADING mode flags and a LEADING cap spec off rawText.
 *
 * "3 things: a b c" is NOT misread as a spec — a leading token is only treated as a spec
 * if it consists of N:backend or backend:N pairs with KNOWN aliases.
 *
 * MODE FLAGS FIRST: `/team`'s documented argument order is `[--writable] [caps] <task>`, but the
 * spec matcher only ever looked at the very start of the text — so a leading `--writable` pushed
 * the spec out of position and the caps were silently lost (source:'default') AND the spec text
 * leaked into the task. Leading `--flag` tokens are therefore consumed first, in either order
 * relative to the spec, and reported back so the caller still sees them. They are kept OUT of the
 * task text, which is what the command doc already asks the caller to do by hand.
 *
 * @param {string} rawText
 * @returns {{ caps: object, roles: object, task: string, source: string, flags: string[], writable: boolean }}
 */
export function splitSpec(rawText, opts = {}) {
  // ROLE spec first. The two grammars are unambiguous — a role spec starts with a known role word,
  // a cap spec starts with a number or a backend word — so this is a check, not a guess. Either way
  // the result is one RESOLVED staffing table; `.caps` is projected back off it so cap-only
  // consumers (--gemini-cap, the scripted path) keep working unchanged.
  const asRoles = splitRoleSpec(rawText, opts);
  if (asRoles) {
    const staffing = resolveStaffing(asRoles, opts);
    return {
      caps: _capsFromStaffing(staffing, 'spec'),
      roles: staffing,
      task: asRoles.task,
      source: 'roles',
      flags: asRoles.flags,
      writable: asRoles.writable,
    };
  }

  let text = String(rawText ?? '').trim();

  // Peel leading `--flag` tokens (before AND after a spec, so both documented orders work).
  const flags = [];
  const peelFlags = () => {
    let m;
    while ((m = /^\s*(--[A-Za-z][A-Za-z0-9-]*)(?=\s|$)/.exec(text))) {
      flags.push(m[1].toLowerCase());
      text = text.slice(m[0].length).trim();
    }
  };
  peelFlags();

  // Build alternation of all known aliases, longest-first (mirrors Python's re.escape sort).
  const allAliases = [...GEMINI_ALIASES, ...CODEX_ALIASES, ...OPENCODE_ALIASES, ...CLAUDE_ALIASES];
  allAliases.sort((a, b) => b.length - a.length);
  const aliasAlt = allAliases.map(_reEscape).join('|');

  // A single N:backend or backend:N pair (digits and known backend, colon-separated).
  const pairPat = `(?:\\d+\\s*:\\s*(?:${aliasAlt})|(?:${aliasAlt})\\s*:\\s*\\d+)`;
  // A spec = one or more comma-separated pairs.
  const specPat = `(?:${pairPat})(?:\\s*,\\s*(?:${pairPat}))*`;

  // Attempt: spec WHITESPACE task
  const reFull = new RegExp(`^\\s*(${specPat})\\s+([\\s\\S]*)$`, 'i');
  let m = reFull.exec(text);
  if (m) {
    const specStr = m[1].trim();
    const caps    = parseCaps(specStr);
    text = m[2].trim();
    peelFlags();   // `caps --writable task` — the flag may also trail the spec
    return _withFlags(caps, text, opts, flags);
  }

  // Attempt: the whole string is just a spec.
  const reOnly = new RegExp(`^\\s*(${specPat})\\s*$`, 'i');
  m = reOnly.exec(text);
  if (m) {
    return _withFlags(parseCaps(m[1].trim()), '', opts, flags);
  }

  // No spec at all — the staffing resolver still returns a full table, all of it Claude.
  return _withFlags(_defaults(''), text, opts, flags);
}

/**
 * Project a staffing table's WORKER counts back onto the cap-spec shape, so every existing consumer
 * of `.caps` (`--gemini-cap`, the scripted path) keeps working. Only worker stages count — the
 * verify/fix staffing is the pipeline's own loop, not parallel subtask capacity, which is exactly
 * what a cap has always meant. Names come back as the CAP vocabulary (`gemini`/`claude`).
 */
function _capsFromStaffing(staffing, source) {
  const caps = { gemini: 0, codex: 0, opencode: 0, claude: 0 };
  for (const a of (staffing.workers || [])) {
    const key = BACKEND_TO_CAP[a.backend];
    if (key) caps[key] = _clamp(caps[key] + a.count);
  }
  return {
    ...caps,
    total: caps.gemini + caps.codex + caps.opencode + caps.claude,
    source,
    note: staffing.note || '',
  };
}

/**
 * Finish a cap-grammar split: staff the named backends as EXECUTORS, resolve the rest of the
 * pipeline onto Claude, and attach the consumed mode flags. `.caps` is re-derived from the resolved
 * table so it reports what will actually run, not what was typed.
 */
function _withFlags(caps, task, opts, flags) {
  const counts = {};
  for (const [key, backend] of Object.entries(CAP_TO_BACKEND)) {
    if (caps[key] > 0) counts[backend] = caps[key];
  }
  const staffing = staffingFromBackends(counts, opts);
  return {
    caps: _capsFromStaffing(staffing, caps.source),
    roles: staffing,
    task,
    source: caps.source,
    flags,
    writable: flags.includes('--writable'),
  };
}

function _reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The role vocabulary lives in the roster, so --split needs it to recognise a role spec. A roster
  // that won't load is not fatal: roles.mjs falls back to a built-in catalog and the cap grammar is
  // roster-independent, so parsing still works.
  const { loadRoster } = await import('./config.mjs');
  const { resolveRosterPath } = await import('./platform.mjs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let roster = {};
  try { roster = loadRoster(resolveRosterPath(root)); } catch { /* built-in catalog applies */ }

  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = chunks.join('');
    const useSplit = process.argv.includes('--split');
    const result = useSplit ? splitSpec(raw, { roster }) : parseCaps(raw.trim());
    process.stdout.write(JSON.stringify(result) + '\n');
  });
}
