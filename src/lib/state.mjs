// state.mjs — HUD state read/write (ESM port of scripts/lib/state.sh).
//
// Writes platform.stateDir()/state.json as FLAT, one-field-per-line JSON so statusline can parse
// it fork-free (no jq / no real JSON parser needed). Parity target: scripts/lib/state.sh
// (mmt_state_start / mmt_state_end / _mmt_state_flush / _mmt_state_load / _mmt_lock).
//
// The HUD is non-critical: a failed lock/write skips the update rather than blocking delegation.
// Writes are serialized with an mkdir-spinlock (stale-break after ~2s); the file is replaced
// atomically (tmp + rename, copy fallback on a transient msys rename hiccup).
//
// Zero runtime deps (Node stdlib only). Runs on win32 / linux / darwin.

import fs from 'node:fs';
import path from 'node:path';
import * as platform from './platform.mjs';

function stateFile() {
  return process.env.MMT_STATE_FILE || path.join(platform.stateDir(), 'state.json');
}
function lockDir() {
  return path.join(path.dirname(stateFile()), '.lock');
}

function nowMs() {
  return Date.now();
}

// Read an integer field out of the flat state.json (line-oriented, no JSON.parse needed; mirrors
// state.sh _mmt_get_num so we tolerate the file even mid-write).
function getNum(text, key, def) {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`));
  return m ? parseInt(m[1], 10) : def;
}

function loadCounters() {
  let text = '';
  try {
    text = fs.readFileSync(stateFile(), 'utf8');
  } catch {
    text = '';
  }
  return {
    open: getNum(text, 'open', 0),
    calls: getNum(text, 'calls', 0),
    fallbacks: getNum(text, 'fallbacks', 0),
    errors: getNum(text, 'errors', 0),
    approx_in_chars: getNum(text, 'approx_in_chars', 0),
    approx_out_chars: getNum(text, 'approx_out_chars', 0),
  };
}

// Minimal JSON string escaping (parity with state.sh _mmt_json_esc: backslash + double-quote).
function jsonEsc(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function intOr(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// Spinlock via mkdir. Returns true if locked (caller must unlock), false if it gave up after the
// stale-break attempt. Busy-wait is short (the critical section is a single small file write); we
// use a bounded synchronous spin so start/end stay synchronous like the bash API.
function lock() {
  const dir = lockDir();
  try {
    fs.mkdirSync(platform.stateDir(), { recursive: true });
  } catch { /* ignore */ }
  // Also ensure the directory that will hold state.json exists if MMT_STATE_FILE points elsewhere.
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  } catch { /* ignore */ }

  for (let i = 0; i < 40; i++) {
    try {
      fs.mkdirSync(dir);
      return true;
    } catch {
      // busy — short synchronous spin (~50ms) to mirror `sleep 0.05`.
      spinSleep(50);
    }
  }
  // Stale-break: remove the lock dir and try once more (parity with state.sh).
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try {
    fs.mkdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function unlock() {
  try {
    fs.rmdirSync(lockDir());
  } catch { /* ignore */ }
}

// Tiny busy-wait. Atomics.wait on a SharedArrayBuffer gives a real, signal-free sleep without
// pulling in async (start/end are synchronous, like the bash functions).
function spinSleep(ms) {
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  } catch {
    // Fallback: spin on the clock (SharedArrayBuffer/Atomics unavailable in some sandboxes).
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

// Write the full flat state file from a counters object. Atomic: tmp + rename, copy fallback.
function flush(s) {
  const file = stateFile();
  const tmp = `${file}.tmp.${process.pid}.${Math.floor(Math.random() * 1e6)}`;
  const lines = [
    '{',
    '  "schema": 1,',
    `  "updated": ${nowMs()},`,
    `  "open": ${intOr(s.open, 0)},`,
    `  "calls": ${intOr(s.calls, 0)},`,
    `  "fallbacks": ${intOr(s.fallbacks, 0)},`,
    `  "errors": ${intOr(s.errors, 0)},`,
    `  "active_id": "${jsonEsc(s.active_id)}",`,
    `  "active_backend": "${jsonEsc(s.active_backend)}",`,
    `  "active_model": "${jsonEsc(s.active_model)}",`,
    `  "active_rule": "${jsonEsc(s.active_rule)}",`,
    `  "active_started": ${intOr(s.active_started, 0)},`,
    `  "last_id": "${jsonEsc(s.last_id)}",`,
    `  "last_backend": "${jsonEsc(s.last_backend)}",`,
    `  "last_model": "${jsonEsc(s.last_model)}",`,
    `  "last_rule": "${jsonEsc(s.last_rule)}",`,
    `  "last_code": ${intOr(s.last_code, 0)},`,
    `  "last_dur_ms": ${intOr(s.last_dur_ms, 0)},`,
    `  "last_out_chars": ${intOr(s.last_out_chars, 0)},`,
    `  "approx_in_chars": ${intOr(s.approx_in_chars, 0)},`,
    `  "approx_out_chars": ${intOr(s.approx_out_chars, 0)}`,
    '}',
    '',
  ];
  const body = lines.join('\n');
  try {
    fs.writeFileSync(tmp, body, 'utf8');
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return false;
  }
  try {
    fs.renameSync(tmp, file); // atomic on the same filesystem.
  } catch {
    // Rename hiccup (msys/cross-device): fall back to a direct copy of contents.
    try {
      fs.writeFileSync(file, body, 'utf8');
    } catch { /* ignore — HUD is non-critical */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  return true;
}

// start({ id, backend, model, rule, inChars? }) — open++, set active_*, accumulate approx_in_chars.
// Always writes (the lock only reduces races; a failed lock still writes, like the bash original).
export function start({ id, backend, model, rule, inChars } = {}) {
  const locked = lock();
  try {
    const s = loadCounters();
    s.open = (s.open || 0) + 1;
    s.active_id = id || '';
    s.active_backend = backend || '';
    s.active_model = model || '';
    s.active_rule = rule || '';
    s.active_started = nowMs();
    s.approx_in_chars = (s.approx_in_chars || 0) + intOr(inChars, 0);
    flush(s);
  } finally {
    if (locked) unlock();
  }
}

// end({ id, backend, model, rule, code, durMs, outChars, fallback }) — open--, calls++, set last_*.
export function end({ id, backend, model, rule, code, durMs, outChars, fallback } = {}) {
  const locked = lock();
  try {
    const s = loadCounters();
    if ((s.open || 0) > 0) s.open -= 1;
    s.calls = (s.calls || 0) + 1;
    const fb = intOr(fallback, 0);
    if (fb !== 0) s.fallbacks = (s.fallbacks || 0) + fb;
    const c = intOr(code, 0);
    if (c !== 0) s.errors = (s.errors || 0) + 1;
    // Clear active_* (the delegation is no longer in flight).
    s.active_id = '';
    s.active_backend = '';
    s.active_model = '';
    s.active_rule = '';
    s.active_started = 0;
    s.last_id = id || '';
    s.last_backend = backend || '';
    s.last_model = model || '';
    s.last_rule = rule || '';
    s.last_code = c;
    s.last_dur_ms = intOr(durMs, 0);
    s.last_out_chars = intOr(outChars, 0);
    s.approx_out_chars = (s.approx_out_chars || 0) + intOr(outChars, 0);
    flush(s);
  } finally {
    if (locked) unlock();
  }
}
