/**
 * reason-spec.mjs — parse /reasoning panel specs into resolved panelists.
 * Node ESM sibling of team-spec.mjs. Zero runtime dependencies.
 *
 * A panel token expands to a panelist { backend, tier }. See docs/REASONING.md
 * for the canonical token vocabulary.
 *
 * Exports:
 *   expandPanel(tokens, opts?)  — string[] -> { panel: Panelist[], note }
 *   parsePanel(spec, opts?)     — "2:gemini,opus,codex" -> { panel, source, note }
 *   splitPanel(rawText, opts?)  — peel a LEADING panel spec; { panel, question, source }
 *
 * Panelist = { backend:'native'|'agy'|'codex', tier:string, label:string, token:string }
 */

// ─── panel token vocabulary (canonical — every component must agree) ─────────

// token -> { backend, tier }. Aliases share a target. Lowercased keys.
const TOKEN_MAP = {
  opus:      { backend: 'native', tier: 'opus' },
  sonnet:    { backend: 'native', tier: 'sonnet' },
  claude:    { backend: 'native', tier: 'sonnet' },
  native:    { backend: 'native', tier: 'sonnet' },
  anthropic: { backend: 'native', tier: 'sonnet' },
  haiku:     { backend: 'native', tier: 'haiku' },
  gemini:    { backend: 'agy', tier: 'standard' },
  agy:       { backend: 'agy', tier: 'standard' },
  pro:       { backend: 'agy', tier: 'standard' },
  google:    { backend: 'agy', tier: 'standard' },
  flash:     { backend: 'agy', tier: 'cheap' },
  codex:     { backend: 'codex', tier: 'standard' },
  openai:    { backend: 'codex', tier: 'standard' },
  gpt:       { backend: 'codex', tier: 'standard' },
  chatgpt:   { backend: 'codex', tier: 'standard' },
};

// ─── constants ───────────────────────────────────────────────────────────────

const MAX_PER_PANEL = 16;
const DEFAULT_CAP = 8;
const DEFAULT_PANEL = ['opus', 'sonnet', 'gemini'];

// ─── helpers ─────────────────────────────────────────────────────────────────

function _clampCap(n) {
  const i = parseInt(n, 10);
  if (!Number.isFinite(i) || i < 1) return DEFAULT_CAP;
  return Math.min(MAX_PER_PANEL, i);
}

function _reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A leading token-run is only an UNAMBIGUOUS spec when it contains a comma (a multi-token
 * list like "opus,sonnet") or a colon (a count pair like "2:gemini" / "gemini:3"). A single
 * bare alias word ("opus", "pro", "native", "flash", "claude", …) is NOT treated as a spec —
 * those are common English question-leading words, and silently stripping the first word of a
 * question would corrupt it. (team-spec.mjs avoids this entirely by requiring a colon pair.)
 */
function _looksLikeSpec(specStr) {
  return /[,:]/.test(String(specStr ?? ''));
}

/** Resolve a bare token name to { backend, tier } or null. */
function _resolve(name) {
  const lc = String(name ?? '').trim().toLowerCase();
  return TOKEN_MAP[lc] ?? null;
}

/**
 * Parse a single token string into { name, count }.
 * Accepts "gemini", "3:gemini", "gemini:3". Count defaults to 1.
 * Returns null name if no known alias is present.
 */
function _parseToken(raw) {
  const pair = String(raw ?? '').trim();
  if (!pair) return { name: null, count: 0, raw: pair };

  const parts = pair.split(':').map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    return { name: _resolve(parts[0]) ? parts[0].toLowerCase() : null, count: 1, raw: pair };
  }

  // Lenient: find the numeric part and the alias part (handles either order).
  const nums  = parts.filter(p => /^\d+$/.test(p));
  const names = parts.filter(p => _resolve(p) !== null);
  if (!names.length) return { name: null, count: 0, raw: pair };
  const count = nums.length ? parseInt(nums[0], 10) : 1;
  return { name: names[0].toLowerCase(), count: Math.max(1, count), raw: pair };
}

// ─── expandPanel ─────────────────────────────────────────────────────────────

/**
 * Expand an array of panel tokens into resolved panelists.
 *
 * @param {string[]} tokens  each possibly "N:token" / "token:N"
 * @param {{ cap?:number }} [opts]
 * @returns {{ panel: Array<{backend,tier,label,token}>, note: string }}
 */
export function expandPanel(tokens, opts = {}) {
  const cap = _clampCap(opts.cap ?? DEFAULT_CAP);
  const list = Array.isArray(tokens) ? tokens : [];
  const notes = [];
  const panel = [];
  const labelCounts = {};
  let clamped = false;

  for (const raw of list) {
    const { name, count } = _parseToken(raw);
    if (!name) {
      const t = String(raw ?? '').trim();
      if (t) notes.push(`skipped unknown token '${t}'`);
      continue;
    }
    const resolved = _resolve(name);
    for (let i = 0; i < count; i++) {
      if (panel.length >= cap) { clamped = true; break; }
      const n = (labelCounts[name] = (labelCounts[name] ?? 0) + 1);
      const label = n === 1 ? name : `${name}-${n}`;
      panel.push({ backend: resolved.backend, tier: resolved.tier, label, token: name });
    }
    if (clamped) break;
  }

  if (clamped) notes.push(`clamped panel to cap ${cap}`);
  return { panel, note: notes.join('; ') };
}

// ─── parsePanel ──────────────────────────────────────────────────────────────

/**
 * Parse a comma-separated panel spec string into resolved panelists.
 * Empty/garbage -> use opts.defaultPanel (token array), source 'default'.
 *
 * @param {string} spec  e.g. "2:gemini,opus,codex"
 * @param {{ cap?:number, defaultPanel?:string[] }} [opts]
 * @returns {{ panel: Array, source: 'spec'|'default', note: string }}
 */
export function parsePanel(spec, opts = {}) {
  const cap = _clampCap(opts.cap ?? DEFAULT_CAP);
  const defaultPanel = Array.isArray(opts.defaultPanel) ? opts.defaultPanel : DEFAULT_PANEL;
  const s = String(spec ?? '').trim();

  if (s) {
    const tokens = s.split(',').map(t => t.trim()).filter(Boolean);
    const { panel, note } = expandPanel(tokens, { cap });
    if (panel.length) return { panel, source: 'spec', note };
    // nothing valid expanded -> fall to default
    const def = expandPanel(defaultPanel, { cap });
    return { panel: def.panel, source: 'default', note: note || 'no usable tokens in spec' };
  }

  const def = expandPanel(defaultPanel, { cap });
  return { panel: def.panel, source: 'default', note: def.note };
}

// ─── splitPanel ──────────────────────────────────────────────────────────────

/**
 * Deterministically peel a LEADING panel spec off rawText (mirror splitSpec).
 * A leading run of comma-separated panel tokens / N:token pairs followed by
 * whitespace + the question is a spec; otherwise the whole text is the question.
 *
 * @param {string} rawText
 * @param {{ cap?:number, defaultPanel?:string[] }} [opts]
 * @returns {{ panel: Array, question: string, source: 'spec'|'default' }}
 */
export function splitPanel(rawText, opts = {}) {
  const cap = _clampCap(opts.cap ?? DEFAULT_CAP);
  const defaultPanel = Array.isArray(opts.defaultPanel) ? opts.defaultPanel : DEFAULT_PANEL;
  const text = String(rawText ?? '').trim();

  // Build alternation of all known aliases, longest-first.
  const allAliases = Object.keys(TOKEN_MAP);
  allAliases.sort((a, b) => b.length - a.length);
  const aliasAlt = allAliases.map(_reEscape).join('|');

  // A single bare-token, N:token, or token:N pair.
  const pairPat = `(?:\\d+\\s*:\\s*(?:${aliasAlt})|(?:${aliasAlt})\\s*:\\s*\\d+|(?:${aliasAlt}))`;
  // A spec = one or more comma-separated pairs.
  const specPat = `(?:${pairPat})(?:\\s*,\\s*(?:${pairPat}))*`;

  // Attempt: spec WHITESPACE question. Only when the leading run is an UNAMBIGUOUS spec
  // (contains a comma or colon) — a single bare alias word is left as part of the question.
  const reFull = new RegExp(`^\\s*(${specPat})\\s+([\\s\\S]+)$`, 'i');
  let m = reFull.exec(text);
  if (m && _looksLikeSpec(m[1])) {
    const specStr  = m[1].trim();
    const question = m[2].trim();
    const parsed   = parsePanel(specStr, { cap, defaultPanel });
    return { panel: parsed.panel, question, source: parsed.source };
  }

  // Attempt: the whole string is just a spec (no question). Same unambiguity guard — a lone
  // bare alias ("opus") is treated as a one-word question, not an empty-question spec.
  const reOnly = new RegExp(`^\\s*(${specPat})\\s*$`, 'i');
  m = reOnly.exec(text);
  if (m && _looksLikeSpec(m[1])) {
    const parsed = parsePanel(m[1].trim(), { cap, defaultPanel });
    return { panel: parsed.panel, question: '', source: parsed.source };
  }

  // No spec found — default panel + full text as question.
  const def = parsePanel('', { cap, defaultPanel });
  return { panel: def.panel, question: text, source: 'default' };
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

    // --default <comma,tokens> overrides the default panel.
    let defaultPanel = DEFAULT_PANEL;
    const di = process.argv.indexOf('--default');
    if (di !== -1 && process.argv[di + 1]) {
      const parsed = process.argv[di + 1].split(',').map(t => t.trim()).filter(Boolean);
      if (parsed.length) defaultPanel = parsed;
    }

    const opts = { defaultPanel };
    const result = useSplit ? splitPanel(raw, opts) : parsePanel(raw.trim(), opts);
    process.stdout.write(JSON.stringify(result) + '\n');
  });
}
