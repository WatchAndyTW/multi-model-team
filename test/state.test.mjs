// state.test.mjs — port of the state start/end + statusline-rendering unit blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUSLINE, tmp, runNode } from './helpers.mjs';

// state.mjs reads MMT_STATE_DIR/MMT_STATE_FILE at call time, so drive it through a child process
// with the env set (mirrors the bash oracle's subshell with MMT_STATE_DIR exported).
const STATE_DRIVER = `
import * as state from ${JSON.stringify(new URL('../src/lib/state.mjs', import.meta.url).href)};
state.start({ id:'id1', backend:'agy', model:'Gemini 3.1 Pro (Low)', rule:'standard-coding', inChars:100 });
state.end({ id:'id1', backend:'agy', model:'Gemini 3.1 Pro (Low)', rule:'standard-coding', code:0, durMs:1234, outChars:50, fallback:0 });
`;

test('state start/end writes counters', () => {
  const dir = tmp('state-');
  const r = runNode('--input-type=module', {
    args: ['-e', STATE_DRIVER],
    env: { MMT_STATE_DIR: dir, MMT_STATE_FILE: '' },
  });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(j.calls, 1, 'calls=1');
  assert.equal(j.last_backend, 'agy', 'last_backend');
  assert.equal(j.open, 0, 'open=0 after end');
});

// ── statusline 3-mode render ─────────────────────────────────────────────────
function renderStatusline(stateObj) {
  const dir = tmp('sl-');
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify(stateObj, null, 2), 'utf8');
  const { stdout } = runNode(STATUSLINE, { env: { MMT_STATE_FILE: file } });
  return stdout;
}

test('statusline: active mode', () => {
  const out = renderStatusline({
    open: 2, calls: 5, active_backend: 'agy',
    active_model: 'Gemini 3.1 Pro (Low)', approx_out_chars: 12300,
  });
  assert.match(out, /2 open/);
  assert.match(out, /agy·Gemini-3\.1-Pro/);
  assert.match(out, /~12k/);
});

test('statusline: idle mode', () => {
  const out = renderStatusline({
    open: 0, calls: 3, fallbacks: 1, last_backend: 'agy', last_code: 0, last_dur_ms: 3400,
  });
  assert.match(out, /3 calls/);
  assert.match(out, /1 fallback\b/);
  assert.match(out, /last 3\.4s/);
});

test('statusline: empty mode', () => {
  // Point at a non-existent file.
  const dir = tmp('sl-empty-');
  const { stdout } = runNode(STATUSLINE, { env: { MMT_STATE_FILE: join(dir, 'none.json') } });
  assert.match(stdout, /mmt idle/);
});
