#!/usr/bin/env node
// statusline.mjs — one-line HUD for Claude Code Desktop (Node ESM port of statusline.sh).
//
// Reads stateDir()/state.json (flat one-field-per-line JSON) and renders one of three modes.
// Single node process, minimal imports (only platform for the state dir). Claude Code passes
// session JSON on stdin; we don't read it.
//
//   Active: ⟳ agy·Gemini-3.1-Pro │ 2 open │ ~12k↓
//   Idle  : ◦ agy idle │ 5 calls · 1 fallback │ last 3.4s ✓
//   Empty : ◦ mmt idle

import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../src/lib/platform.mjs';

function stateFile() {
  return process.env.MMT_STATE_FILE || path.join(process.env.MMT_STATE_DIR || stateDir(), 'state.json');
}

// Parse the flat state.json line-by-line (parity with the bash builtin read loop). We avoid
// JSON.parse only for robustness against a mid-write file; the format is one "key": value per line.
function loadState(text) {
  const S = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"')) continue;            // only "key": value lines
    const key = line.slice(line.indexOf('"') + 1, line.indexOf('"', line.indexOf('"') + 1));
    let val = line.slice(line.indexOf(':') + 1).trim();
    val = val.replace(/,$/, '');                  // strip trailing comma
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1); // unquote strings
    S[key] = val;
  }
  return S;
}

function shortModel(m) {
  let s = String(m == null ? '' : m);
  const paren = s.indexOf(' (');
  if (paren >= 0) s = s.slice(0, paren);          // strip " (...)" suffix
  return s.replace(/ /g, '-');                    // spaces -> dashes
}

function human(c) {
  const n = parseInt(c, 10);
  if (Number.isFinite(n) && n >= 1000) return `~${Math.floor(n / 1000)}k`;
  return `~${Number.isFinite(n) ? n : 0}`;
}

function dur(ms) {
  const m = parseInt(ms, 10) || 0;
  return `${Math.floor(m / 1000)}.${Math.floor((m % 1000) / 100)}s`;
}

function toInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// Convert integer micro-USD (millionths of a dollar) to a short display string ($0.04).
function usd(micros) {
  const m = parseInt(micros, 10) || 0;
  return `$${(m / 1_000_000).toFixed(2)}`;
}

function main() {
  const file = stateFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    process.stdout.write('◦ mmt idle\n');
    return;
  }

  const S = loadState(text);
  const open = toInt(S.open, 0);
  const calls = toInt(S.calls, 0);
  const fallbacks = S.fallbacks ?? '0';
  const lastCode = S.last_code ?? '0';
  const lastDur = S.last_dur_ms ?? '0';
  const outChars = S.approx_out_chars ?? '0';
  const costMicros = S.approx_cost_micros ?? '0';
  const abk = S.active_backend || '';
  const amodel = S.active_model || '';
  const lbk = S.last_backend || '';

  if (open > 0) {
    process.stdout.write(`⟳ ${abk || 'agy'}·${shortModel(amodel || '?')} │ ${open} open │ ${human(outChars)}↓ │ ${usd(costMicros)}\n`);
  } else if (calls > 0) {
    const ok = String(lastCode) === '0' ? '✓' : '✗';
    const fbword = String(fallbacks) === '1' ? 'fallback' : 'fallbacks';
    process.stdout.write(`◦ ${lbk || 'agy'} idle │ ${calls} calls · ${fallbacks} ${fbword} │ last ${dur(lastDur)} ${ok} │ ${usd(costMicros)}\n`);
  } else {
    process.stdout.write('◦ mmt idle\n');
  }
}

main();
