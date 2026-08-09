/**
 * team-spec.mjs — parse /team agent-cap specs into per-backend caps.
 * Node ESM port of scripts/lib/team_spec.py. Zero runtime dependencies.
 *
 * Exports:
 *   parseCaps(spec)      — "N:gemini,M:claude" -> { gemini, codex, opencode, claude, total, source, note }
 *   splitSpec(rawText)   — peel leading mode flags + a LEADING cap spec;
 *                          return { caps, task, source, flags, writable }
 *
 * Cap keys are the /team SPEC vocabulary, not roster backend names:
 *   gemini -> agy,  codex -> codex,  opencode -> opencode,  claude -> native.
 * A backend missing from these alias sets is invisible to the spec: `_normalize` returns null, the
 * pair is dropped as "unparseable" AND `splitSpec`'s alternation never matches it, so the whole
 * spec is swallowed into the task text. That is exactly what happened to opencode before it was
 * added here — `/team 2:opencode <task>` silently lost both the cap and the spec boundary.
 */

import { splitRoleSpec } from './roles.mjs';

// ─── alias sets ──────────────────────────────────────────────────────────────

const GEMINI_ALIASES   = new Set(['gemini', 'agy', 'flash', 'pro', 'google']);
const CODEX_ALIASES    = new Set(['codex', 'chatgpt', 'openai', 'gpt']);
const OPENCODE_ALIASES = new Set(['opencode', 'oc']);
const CLAUDE_ALIASES   = new Set(['claude', 'native', 'sonnet', 'opus', 'anthropic']);

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_GEMINI   = _envInt('MMT_TEAM_GEMINI_DEFAULT',   4);
const DEFAULT_CODEX    = _envInt('MMT_TEAM_CODEX_DEFAULT',    2);
const DEFAULT_OPENCODE = _envInt('MMT_TEAM_OPENCODE_DEFAULT', 2);
const DEFAULT_CLAUDE   = _envInt('MMT_TEAM_CLAUDE_DEFAULT',   2);
const MAX_PER_BACKEND = 16;

// ─── helpers ─────────────────────────────────────────────────────────────────

function _envInt(name, def) {
  const v = process.env[name] ?? '';
  if (!v.trim()) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, n) : def;
}

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

function _defaults(note) {
  return {
    gemini: DEFAULT_GEMINI, codex: DEFAULT_CODEX,
    opencode: DEFAULT_OPENCODE, claude: DEFAULT_CLAUDE,
    total:  DEFAULT_GEMINI + DEFAULT_CODEX + DEFAULT_OPENCODE + DEFAULT_CLAUDE,
    source: 'default', note,
  };
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
 * @returns {{ caps: object, task: string, source: string, flags: string[], writable: boolean }}
 */
export function splitSpec(rawText, opts = {}) {
  // ROLE spec first. The two grammars are unambiguous — a role spec starts with a known role word,
  // a cap spec starts with a number or a backend word — so this is a check, not a guess. When the
  // input is a role spec the caps are DERIVED from it, so callers that only understand caps keep
  // working unchanged.
  const asRoles = splitRoleSpec(rawText, opts);
  if (asRoles) {
    return {
      caps: _capsFromRoleCounts(asRoles.counts),
      roles: asRoles,
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
    return _withFlags({ caps, task: text, source: caps.source }, flags);
  }

  // Attempt: the whole string is just a spec.
  const reOnly = new RegExp(`^\\s*(${specPat})\\s*$`, 'i');
  m = reOnly.exec(text);
  if (m) {
    const caps = parseCaps(m[1].trim());
    return _withFlags({ caps, task: '', source: caps.source }, flags);
  }

  // No spec found — return defaults + remaining text as task.
  return _withFlags({ caps: _defaults(''), task: text, source: 'default' }, flags);
}

/**
 * Project a role spec's per-backend worker counts onto the cap-spec shape, so every existing
 * consumer of `.caps` (the workflow's CAPS ladder, `--gemini-cap`) keeps working when the user
 * types a role spec instead. Backend names come back as the CAP vocabulary (`gemini`/`claude`),
 * not roster names, because that is what `.caps` has always meant.
 * @param {Record<string,number>} counts  by roster backend name
 */
function _capsFromRoleCounts(counts) {
  const CAP_KEY = { agy: 'gemini', codex: 'codex', opencode: 'opencode', native: 'claude' };
  const caps = { gemini: 0, codex: 0, opencode: 0, claude: 0 };
  for (const [backend, n] of Object.entries(counts || {})) {
    const key = CAP_KEY[backend];
    if (key) caps[key] = _clamp(n);
  }
  return {
    ...caps,
    total: caps.gemini + caps.codex + caps.opencode + caps.claude,
    source: 'spec',   // the user DID specify — a role spec is an explicit assignment
    note: '',
  };
}

/** Attach the consumed mode flags (and the `--writable` convenience boolean) to a split result. */
function _withFlags(result, flags) {
  return { ...result, flags, writable: flags.includes('--writable') };
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
