// backends.test.mjs — port of the unit blocks for quota detection, clean(), JSON config,
// forced-decision override, and backend-failure stderr surfacing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { clean, quotaExhausted, quotaFromResult } from '../src/lib/backends.mjs';
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

// ── quotaFromResult: a SUCCESSFUL answer is never quota (the codex-read-the-roster false positive) ──
test('quotaFromResult: clean exit-0 with quota words in STDOUT is NOT exhaustion', () => {
  const pats = ['quota', '429', 'rate limit', 'exceeded', 'too many requests'];
  // codex read this repo's roster.json and quoted its quota_patterns in a PASS answer — exit 0.
  const ok = { code: 0, stdout: 'PASS. quota 429 rate limit exceeded too many requests', stderr: '' };
  assert.equal(quotaFromResult(ok, clean(ok.stdout), pats, []), false, 'successful answer must not be quota');
  // genuine exhaustion is a FAILURE: non-zero exit + the signal on stderr.
  const bad = { code: 1, stdout: '', stderr: 'Error: 429 too many requests, quota exceeded' };
  assert.equal(quotaFromResult(bad, clean(bad.stdout), pats, []), true, 'failure with quota stderr IS quota');
  // empty output on exit 0 (agy silent no-op) with a stderr signal still counts.
  const empty = { code: 0, stdout: '', stderr: 'rate limit hit' };
  assert.equal(quotaFromResult(empty, '', pats, []), true, 'empty output -> not ok -> scan applies');
  // exit-code-based detection still works through the helper.
  assert.equal(quotaFromResult({ code: 7, stdout: '', stderr: '' }, '', [], [7]), true, 'quota exit code');
});

// Integration: a CLI that exits 0 and prints quota words to STDOUT must have its output RETURNED,
// not discarded as exhaustion + fallen back to native. (Regression for the false-positive bug.)
test('run.mjs: exit-0 backend whose stdout contains quota words is returned, not handed off', () => {
  const d = tmp('quota-fp-');
  const fake = join(d, process.platform === 'win32' ? 'fakecodex.cmd' : 'fakecodex.sh');
  if (process.platform === 'win32') {
    writeFileSync(fake,
      '@echo off\r\n' +
      'if "%1"=="--version" ( echo fakecodex 9.9 & exit /b 0 )\r\n' +
      'echo REVIEW_OK quota 429 rate limit exceeded too many requests\r\n' +
      'exit /b 0\r\n');
  } else {
    writeFileSync(fake,
      '#!/usr/bin/env bash\n' +
      'case "${1:-}" in\n' +
      '  --version) echo "fakecodex 9.9" ;;\n' +
      '  *) echo "REVIEW_OK quota 429 rate limit exceeded too many requests" ;;\n' +
      'esac\n');
    chmodSync(fake, 0o755);
  }
  const r = writeRosterVariant(d, 'r.json', (c) => {
    c.backends.agy.enabled = false;
    c.defaults.quota_fallback = ['codex', 'native:sonnet'];
  });
  const { stdout } = runNode(BIN_RUN, {
    args: ['--decision', '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}', 'review this'],
    env: { MMT_ROSTER: r, MMT_BE_BIN: fake },
  });
  assert.match(stdout, /REVIEW_OK/, 'the backend answer is returned');
  assert.doesNotMatch(stdout, /MMT_NATIVE_HANDOFF/, 'a successful answer is NOT misread as quota + handed off');
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
