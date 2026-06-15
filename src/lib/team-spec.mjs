/**
 * team-spec.mjs — parse /team agent-cap specs into per-backend caps.
 * Node ESM port of scripts/lib/team_spec.py. Zero runtime dependencies.
 *
 * Exports:
 *   parseCaps(spec)      — "N:gemini,M:claude" -> { gemini, codex, claude, total, source, note }
 *   splitSpec(rawText)   — peel a LEADING cap spec; return { caps, task, source }
 */

// ─── alias sets ──────────────────────────────────────────────────────────────

const GEMINI_ALIASES = new Set(['gemini', 'agy', 'flash', 'pro', 'google']);
const CODEX_ALIASES  = new Set(['codex', 'chatgpt', 'openai', 'gpt']);
const CLAUDE_ALIASES = new Set(['claude', 'native', 'sonnet', 'opus', 'anthropic']);

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_GEMINI = _envInt('MMT_TEAM_GEMINI_DEFAULT', 4);
const DEFAULT_CODEX  = _envInt('MMT_TEAM_CODEX_DEFAULT',  2);
const DEFAULT_CLAUDE = _envInt('MMT_TEAM_CLAUDE_DEFAULT', 2);
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
  if (GEMINI_ALIASES.has(lc)) return 'gemini';
  if (CODEX_ALIASES.has(lc))  return 'codex';
  if (CLAUDE_ALIASES.has(lc)) return 'claude';
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

  const gemini = _clamp(caps.gemini ?? 0);
  const codex  = _clamp(caps.codex  ?? 0);
  const claude = _clamp(caps.claude  ?? 0);
  return { gemini, codex, claude, total: gemini + codex + claude,
           source: 'spec', note: notes.join('; ') };
}

function _defaults(note) {
  return {
    gemini: DEFAULT_GEMINI, codex: DEFAULT_CODEX, claude: DEFAULT_CLAUDE,
    total:  DEFAULT_GEMINI + DEFAULT_CODEX + DEFAULT_CLAUDE,
    source: 'default', note,
  };
}

// ─── splitSpec ───────────────────────────────────────────────────────────────

/**
 * Deterministically peel a LEADING cap spec off rawText.
 * "3 things: a b c" is NOT misread as a spec — a leading token is only treated as a spec
 * if it consists of N:backend or backend:N pairs with KNOWN aliases.
 *
 * @param {string} rawText
 * @returns {{ caps: object, task: string, source: string }}
 */
export function splitSpec(rawText) {
  const text = String(rawText ?? '').trim();

  // Build alternation of all known aliases, longest-first (mirrors Python's re.escape sort).
  const allAliases = [...GEMINI_ALIASES, ...CODEX_ALIASES, ...CLAUDE_ALIASES];
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
    const task    = m[2].trim();
    const caps    = parseCaps(specStr);
    return { caps, task, source: caps.source };
  }

  // Attempt: the whole string is just a spec.
  const reOnly = new RegExp(`^\\s*(${specPat})\\s*$`, 'i');
  m = reOnly.exec(text);
  if (m) {
    const caps = parseCaps(m[1].trim());
    return { caps, task: '', source: caps.source };
  }

  // No spec found — return defaults + full text as task.
  return { caps: _defaults(''), task: text, source: 'default' };
}

function _reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = chunks.join('');
    const useSplit = process.argv.includes('--split');
    const result = useSplit ? splitSpec(raw) : parseCaps(raw.trim());
    process.stdout.write(JSON.stringify(result) + '\n');
  });
}
