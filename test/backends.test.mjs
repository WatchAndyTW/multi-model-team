// backends.test.mjs — port of the unit blocks for quota detection, clean(), JSON config,
// forced-decision override, and backend-failure stderr surfacing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { clean, quotaExhausted } from '../src/lib/backends.mjs';
import { backend, teamConfig, proactive } from '../src/lib/config.mjs';
import { ROSTER, ROSTER_PATH, BIN_RUN, tmp, writeRosterVariant, runNode } from './helpers.mjs';

// ── quota detection (uses the real agy patterns from roster, like the oracle sources backend-env) ──
test('quota detection', () => {
  const cfg = backend(ROSTER, 'agy');
  const pats = cfg.quota_patterns;
  const codes = cfg.quota_exit_codes;
  // run.mjs combines out+err into one blob; mirror that.
  assert.equal(quotaExhausted('all good\n', pats, 0, codes), false, 'clean not flagged');
  assert.equal(quotaExhausted('RESOURCE_EXHAUSTED quota exceeded\n', pats, 1, codes), true, 'RESOURCE_EXHAUSTED');
  assert.equal(quotaExhausted('\n429 Too Many Requests', pats, 1, codes), true, '429');
});

test('quota: exit-code match short-circuits', () => {
  assert.equal(quotaExhausted('nothing here', [], 7, [7]), true);
  assert.equal(quotaExhausted('nothing here', [], 0, [7]), false);
});

// ── clean() strips CR + winpty noise ─────────────────────────────────────────
test('clean strips CR + winpty teardown noise', () => {
  assert.equal(clean('HELLO\r\nAssertion failed: ... winpty.cc, line 924\n'), 'HELLO');
});

test('clean: null/empty -> empty string', () => {
  assert.equal(clean(null), '');
  assert.equal(clean(''), '');
});

test('clean: strips ANSI CSI/OSC noise', () => {
  assert.equal(clean('\x1b[31mRED\x1b[0m'), 'RED');
});

// ── JSON config — backends configurable ──────────────────────────────────────
test('backend config fields', () => {
  assert.equal(backend(ROSTER, 'agy').kind, 'gemini');
  assert.equal(backend(ROSTER, 'codex').enabled, true);
  assert.equal(backend(ROSTER, 'codex').kind, 'codex');
  assert.equal(backend(ROSTER, 'codex').oneshot_flag, 'exec');
  assert.equal(backend(ROSTER, 'opencode').enabled, false);
  assert.equal(backend(ROSTER, 'nope').enabled, false); // unknown -> off
});

test('run.mjs: all backends disabled -> native handoff', () => {
  const d = tmp('be-off-');
  const off = writeRosterVariant(d, 'off.json', (c) => {
    c.backends.agy.enabled = false;
    c.backends.codex.enabled = false;
  });
  const { stdout } = runNode(BIN_RUN, { args: ['Write a SQL query to list users'], env: { MMT_ROSTER: off } });
  assert.match(stdout, /MMT_NATIVE_HANDOFF/);
});

test('run.mjs: no-invoker kind (opencode) health-fails -> native handoff', () => {
  const d = tmp('be-oc-');
  const oc = writeRosterVariant(d, 'oc.json', (c) => {
    c.backends.agy.enabled = false;
    c.backends.codex.enabled = false;
    c.backends.opencode.enabled = true;
    c.defaults.quota_fallback = ['agy', 'opencode', 'native:sonnet'];
  });
  const { stdout } = runNode(BIN_RUN, { args: ['Write a SQL query to list users'], env: { MMT_ROSTER: oc } });
  assert.match(stdout, /MMT_NATIVE_HANDOFF/);
});

// ── explicit force overrides the hard-line ───────────────────────────────────
test('forced decision bypasses route.sh hard-line; forced rule survives to handoff', () => {
  const reTask = 'Reverse engineer the IL2CPP dump and reconstruct the protobuf schemas via disassembly';
  const d = tmp('force-');
  const nocli = writeRosterVariant(d, 'nocli.json', (c) => {
    c.backends.agy.enabled = false;
    c.backends.codex.enabled = false;
  });
  const { stdout } = runNode(BIN_RUN, {
    args: ['--decision', '{"backend":"agy","model":"","tier":"standard","rule":"delegate-forced","native":false}', reTask],
    env: { MMT_ROSTER: nocli },
  });
  // The forced rule must survive — and the auto-route rule must NOT appear (it was bypassed).
  assert.doesNotMatch(stdout, /re-injection-heavy/, 'auto-route rule must not leak through a forced decision');
  assert.match(stdout, /delegate-forced/, 'forced rule survives to the handoff');
});

// ── backend failure surfaces stderr (no silent empty result) ─────────────────
test('run.mjs surfaces a failing backend stderr + carries it into the handoff', () => {
  const d = tmp('efail-');
  // A fake CLI: passes --version health, fails the actual exec with a stderr line + exit 1.
  const fake = join(d, process.platform === 'win32' ? 'fakecodex.cmd' : 'fakecodex.sh');
  if (process.platform === 'win32') {
    writeFileSync(fake,
      '@echo off\r\n' +
      'if "%1"=="--version" ( echo fakecodex 9.9 & exit /b 0 )\r\n' +
      'echo FAKE_SANDBOX_DENIED sandbox read-only refused 1>&2\r\n' +
      'exit /b 1\r\n');
  } else {
    writeFileSync(fake,
      '#!/usr/bin/env bash\n' +
      'case "${1:-}" in\n' +
      '  --version) echo "fakecodex 9.9" ;;\n' +
      '  *) echo "FAKE_SANDBOX_DENIED sandbox read-only refused" >&2; exit 1 ;;\n' +
      'esac\n');
    chmodSync(fake, 0o755);
  }
  const r = writeRosterVariant(d, 'r.json', (c) => {
    c.backends.agy.enabled = false;
    c.defaults.quota_fallback = ['codex', 'native:sonnet'];
  });
  const { stdout, stderr } = runNode(BIN_RUN, {
    args: ['--decision', '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}', 'review this'],
    env: { MMT_ROSTER: r, MMT_BE_BIN: fake },
  });
  const all = stdout + stderr;
  assert.match(all, /returned no usable output \(exit 1\)/, 'announces the backend failure + exit code');
  assert.match(all, /FAKE_SANDBOX_DENIED/, 'surfaces the backend stderr');
  assert.match(stdout, /last error:/, 'handoff carries the last error');
});

// ── team config (equal, configurable roles) ──────────────────────────────────
test('teamConfig defaults', () => {
  const tc = teamConfig(ROSTER);
  assert.deepEqual(tc.dispatch_backends, ['agy', 'codex', 'native']);
  assert.equal(tc.verifier, 'codex');
  assert.equal(tc.caps.agy, 4);
  assert.equal(tc.caps.codex, 2);
});

test('teamConfig override merges caps key-by-key', () => {
  const clone = JSON.parse(JSON.stringify(ROSTER));
  clone.team = {
    verifier: 'agy',
    dispatch_backends: ['codex', 'native'],
    caps: { codex: 6 },
    tier_models: { standard: 'haiku' },
  };
  const tc = teamConfig(clone);
  assert.equal(tc.verifier, 'agy');
  assert.deepEqual(tc.dispatch_backends, ['codex', 'native']);
  assert.equal(tc.caps.codex, 6);
  assert.equal(tc.caps.native, 2, 'unspecified cap preserved from defaults');
  assert.equal(tc.tier_models.standard, 'haiku');
});

// ── proactive-env knobs (config.proactive defaults + overrides) ───────────────
test('proactive gate defaults + overrides', () => {
  const def = proactive(ROSTER);
  assert.equal(def.guard_spawns, true);
  assert.equal(def.enforce_spawns, false);
  const clone = JSON.parse(JSON.stringify(ROSTER));
  clone.proactive.guard_spawns = false;
  clone.proactive.enforce_spawns = true;
  const ov = proactive(clone);
  assert.equal(ov.guard_spawns, false);
  assert.equal(ov.enforce_spawns, true);
});
