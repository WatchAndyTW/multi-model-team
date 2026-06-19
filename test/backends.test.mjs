// backends.test.mjs — port of the unit blocks for quota detection, clean(), JSON config,
// forced-decision override, and backend-failure stderr surfacing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
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
    args: ['--roster', r, '--decision', '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}', 'review this'],
    env: { MMT_BE_BIN: fake },
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
  const { stdout } = runNode(BIN_RUN, { args: ['--roster', off, 'Write a SQL query to list users'] });
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
  const { stdout } = runNode(BIN_RUN, { args: ['--roster', oc, 'Write a SQL query to list users'] });
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
    args: ['--roster', nocli, '--decision', '{"backend":"agy","model":"","tier":"standard","rule":"delegate-forced","native":false}', reTask],
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
  const logDir = join(d, 'logs');
  const { stdout, stderr } = runNode(BIN_RUN, {
    args: ['--roster', r, '--decision', '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}', 'review this'],
    env: { MMT_BE_BIN: fake, MMT_LOG_DIR: logDir },
  });
  const all = stdout + stderr;
  // New loud failure banner (replaces the older terse "returned no usable output" line).
  assert.match(stderr, /\[mmt\] ERROR: backend 'codex' \(nonzero-exit\) failed/, 'loud [mmt] ERROR banner names the backend + failure kind');
  assert.match(all, /FAKE_SANDBOX_DENIED/, 'surfaces the backend stderr');
  assert.match(stdout, /last error:/, 'handoff carries the last error');

  // Durable structured failure record written to .mmt/logs/failures.log (item: better logging).
  const logFile = join(logDir, 'failures.log');
  assert.ok(existsSync(logFile), 'failures.log written');
  const rec = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop());
  assert.equal(rec.backend, 'codex', 'log record names the backend');
  assert.equal(rec.kind, 'nonzero-exit', 'log record records the failure kind');
  assert.equal(rec.code, 1, 'log record records the exit code');
  assert.match(rec.error, /FAKE_SANDBOX_DENIED/, 'log record captures the stderr reason');
  assert.ok(typeof rec.ts === 'string' && rec.ts.length > 0, 'log record is timestamped');

  // Heartbeat status file: a failed call leaves a terminal status:"failed" record (callId is random,
  // so glob the calls/ dir). MMT_LOG_DIR=<d>/logs -> status under <d>/calls/<callId>.status.json.
  const callsDir = join(d, 'calls');
  assert.ok(existsSync(callsDir), 'status calls/ dir created');
  const statusFiles = readdirSync(callsDir).filter((f) => f.endsWith('.status.json'));
  assert.ok(statusFiles.length >= 1, 'a status file was written');
  const st = JSON.parse(readFileSync(join(callsDir, statusFiles[0]), 'utf8').trim());
  assert.equal(st.state, 'failed', 'status reflects the failed call');
  assert.equal(st.backend, 'codex', 'status names the backend');
  assert.ok(typeof st.elapsed_ms === 'number', 'status records elapsed_ms');
});

// ── a backend that exceeds hard_timeout is logged as kind:"timeout" (the gemini multi-attempt bug) ──
test('run.mjs: a backend slower than hard_timeout is SIGKILLed and logged as kind:"timeout"', () => {
  const d = tmp('etimeout-');
  // Fake CLI: passes --version health, then sleeps ~7s on exec. With a 3s hard_timeout, run.mjs
  // SIGKILLs it (code 124) -> must surface as a TIMEOUT, not a generic nonzero-exit/empty.
  const fake = join(d, process.platform === 'win32' ? 'slowcodex.cmd' : 'slowcodex.sh');
  if (process.platform === 'win32') {
    writeFileSync(fake,
      '@echo off\r\n' +
      'if "%1"=="--version" ( echo slowcodex 1.0 & exit /b 0 )\r\n' +
      'ping -n 8 127.0.0.1 >nul\r\n' +
      'echo LATE\r\n' +
      'exit /b 0\r\n');
  } else {
    writeFileSync(fake,
      '#!/usr/bin/env bash\n' +
      'case "${1:-}" in\n' +
      '  --version) echo "slowcodex 1.0" ;;\n' +
      '  *) sleep 7; echo "LATE" ;;\n' +
      'esac\n');
    chmodSync(fake, 0o755);
  }
  const r = writeRosterVariant(d, 'r.json', (c) => {
    c.backends.agy.enabled = false;
    c.backends.codex.hard_timeout = '3s';   // force the SIGKILL well before the fake finishes
    c.defaults.quota_fallback = ['codex', 'native:sonnet'];
  });
  const logDir = join(d, 'logs');
  const { stdout, stderr } = runNode(BIN_RUN, {
    args: ['--roster', r, '--decision', '{"backend":"codex","model":"","tier":"standard","rule":"team","native":false}', 'do a slow thing'],
    env: { MMT_BE_BIN: fake, MMT_LOG_DIR: logDir },
  });
  assert.match(stderr, /\[mmt\] ERROR: backend 'codex' \(timeout\) failed/, 'timeout shows a distinct (timeout) banner');
  assert.match(stdout, /timed out after/, 'handoff reason explains the timeout');
  const rec = JSON.parse(readFileSync(join(logDir, 'failures.log'), 'utf8').trim().split('\n').pop());
  assert.equal(rec.kind, 'timeout', 'log record kind is "timeout", not "nonzero-exit"');
  assert.equal(rec.code, 124, 'timeout record carries the 124 sentinel code');
});

test('run.mjs --call-file: a successful CLI writes a terminal status:"done" file next to the call file', () => {
  const d = tmp('estatus-');
  // Fake CLI that passes health and succeeds with output (uses codex's stdin `-` path on posix; on
  // win32 the .cmd echoes a fixed line). The point is a clean exit-0 with usable stdout.
  const fake = join(d, process.platform === 'win32' ? 'fakeok.cmd' : 'fakeok.sh');
  if (process.platform === 'win32') {
    writeFileSync(fake,
      '@echo off\r\n' +
      'if "%1"=="--version" ( echo fakeok 1.0 & exit /b 0 )\r\n' +
      'echo RELAY_OK\r\n' +
      'exit /b 0\r\n');
  } else {
    writeFileSync(fake,
      '#!/usr/bin/env bash\n' +
      'case "${1:-}" in\n' +
      '  --version) echo "fakeok 1.0" ;;\n' +
      '  *) echo "RELAY_OK" ;;\n' +
      'esac\n');
    chmodSync(fake, 0o755);
  }
  const r = writeRosterVariant(d, 'r.json', (c) => { c.backends.agy.enabled = false; });
  const callFile = join(d, 'call.json');
  writeFileSync(callFile, JSON.stringify({
    decision: { backend: 'codex', model: '', tier: 'standard', rule: 'team', native: false },
    task: 'say hello',
  }), 'utf8');
  const { stdout } = runNode(BIN_RUN, {
    args: ['--roster', r, '--call-file', callFile],
    env: { MMT_BE_BIN: fake },
  });
  assert.match(stdout, /RELAY_OK/, 'CLI output is returned');
  // Predictable status path: "<call-file>.status.json", terminal state "done".
  const statusFile = `${callFile}.status.json`;
  assert.ok(existsSync(statusFile), 'status file written next to the call file (predictable path)');
  const st = JSON.parse(readFileSync(statusFile, 'utf8').trim());
  assert.equal(st.state, 'done', 'status is done on success');
  assert.equal(st.backend, 'codex', 'status names the backend');
  assert.equal(st.code, 0, 'status records exit 0');
});

test('run.mjs --cwd --writable: CLI runs IN the worktree cwd and gets the writable sandbox flags', () => {
  const d = tmp('ewrite-');
  // The worktree the agent should write into (just a dir for the test — not a real git worktree).
  const wt = join(d, 'worktree');
  mkdirSync(wt, { recursive: true });
  // Fake CLI: on --version, health. Otherwise it records (a) its CWD and (b) the full arg list it was
  // invoked with into a marker file IN ITS CWD — so we can prove run.mjs ran it in the worktree with
  // the writable (full-auto) flags rather than the read-only `-s read-only` extra.
  const fake = join(d, process.platform === 'win32' ? 'fakew.cmd' : 'fakew.sh');
  if (process.platform === 'win32') {
    writeFileSync(fake,
      '@echo off\r\n' +
      'if "%1"=="--version" ( echo fakew 1.0 & exit /b 0 )\r\n' +
      'echo cwd=%CD% > agent-wrote.txt\r\n' +
      'echo args=%* >> agent-wrote.txt\r\n' +
      'echo WROTE_IN_WORKTREE\r\n' +
      'exit /b 0\r\n');
  } else {
    writeFileSync(fake,
      '#!/usr/bin/env bash\n' +
      'if [ "${1:-}" = "--version" ]; then echo "fakew 1.0"; exit 0; fi\n' +
      'echo "cwd=$(pwd)" > agent-wrote.txt\n' +
      'echo "args=$*" >> agent-wrote.txt\n' +
      'echo WROTE_IN_WORKTREE\n');
    chmodSync(fake, 0o755);
  }
  const r = writeRosterVariant(d, 'r.json', (c) => { c.backends.agy.enabled = false; });
  const callFile = join(d, 'call.json');
  writeFileSync(callFile, JSON.stringify({
    decision: { backend: 'codex', model: '', tier: 'standard', rule: 'team', native: false },
    task: 'make an edit',
  }), 'utf8');
  const { stdout } = runNode(BIN_RUN, {
    args: ['--roster', r, '--cwd', wt, '--writable', '--call-file', callFile],
    env: { MMT_BE_BIN: fake },
  });
  assert.match(stdout, /WROTE_IN_WORKTREE/, 'CLI ran and produced output');
  // (a) The CLI wrote its marker file INSIDE the worktree cwd (write isolation).
  const marker = join(wt, 'agent-wrote.txt');
  assert.ok(existsSync(marker), 'CLI wrote its file into the --cwd worktree, not the parent');
  const body = readFileSync(marker, 'utf8');
  // (b) It was invoked with the writable sandbox flag, NOT the read-only `-s read-only` extra.
  assert.match(body, /dangerously-bypass-approvals-and-sandbox/, 'writable mode passed codex writable_extra (full-auto)');
  assert.doesNotMatch(body, /read-only/, 'writable mode dropped the read-only sandbox flag');
});

// ── a backend that FAILS its --version health probe is no longer a SILENT skip ────────────────────
// This was the "sometimes it just fails" bug: a backend that flunked health was dropped with no
// lastErr, no failures.log, no status record — just a bare "backend options exhausted" handoff. Now
// a health skip is LOUD: named in the handoff reason, appended to failures.log (kind:"health"), and
// recorded as a failed status. Fake CLI exits non-zero on --version (and everything else) twice.
test('run.mjs: a backend that fails health is logged LOUDLY as kind:"health", not silently skipped', () => {
  const d = tmp('ehealth-');
  const fake = join(d, process.platform === 'win32' ? 'deadcodex.cmd' : 'deadcodex.sh');
  if (process.platform === 'win32') {
    // Always exit 7 with a stderr line — including on --version, so the health probe (×2) fails.
    writeFileSync(fake, '@echo off\r\necho DEAD_BINARY not authed 1>&2\r\nexit /b 7\r\n');
  } else {
    writeFileSync(fake, '#!/usr/bin/env bash\necho "DEAD_BINARY not authed" >&2\nexit 7\n');
    chmodSync(fake, 0o755);
  }
  const r = writeRosterVariant(d, 'r.json', (c) => {
    c.backends.agy.enabled = false;                 // only codex in play
    c.defaults.quota_fallback = ['codex', 'native:sonnet'];
  });
  const logDir = join(d, 'logs');
  const { stdout, stderr } = runNode(BIN_RUN, {
    args: ['--roster', r, '--decision', '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}', 'review this'],
    env: { MMT_BE_BIN: fake, MMT_LOG_DIR: logDir },
  });
  // 1. Loud stderr banner naming the backend + the health failure kind.
  assert.match(stderr, /\[mmt\] ERROR: backend 'codex' \(health\) failed/, 'health skip emits a loud [mmt] ERROR banner');
  // 2. Handoff still happens, but now CARRIES the cause instead of a bare "exhausted".
  assert.match(stdout, /MMT_NATIVE_HANDOFF/, 'still hands off to native');
  assert.match(stdout, /last error:.*codex.*health check failed/i, 'handoff reason names the health failure');
  // 3. Durable failures.log record with kind:"health".
  const logFile = join(logDir, 'failures.log');
  assert.ok(existsSync(logFile), 'failures.log written on a health skip (was silent before)');
  const rec = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop());
  assert.equal(rec.backend, 'codex', 'log record names the backend');
  assert.equal(rec.kind, 'health', 'log record kind is "health"');
  // 4. A failed status record exists (callId is random — glob the calls/ dir).
  const callsDir = join(d, 'calls');
  assert.ok(existsSync(callsDir), 'status calls/ dir created on a health skip');
  const statusFiles = readdirSync(callsDir).filter((f) => f.endsWith('.status.json'));
  const st = JSON.parse(readFileSync(join(callsDir, statusFiles[0]), 'utf8').trim());
  assert.equal(st.state, 'failed', 'status reflects the failed (health) call');
  assert.equal(st.kind, 'health', 'status kind is "health"');
});

// ── health(): a transient probe miss recovers on the NEXT call (negative verdict is never cached) ──
// + one-shot retry: a SINGLE flaky --version no longer scores the backend down. Fake CLI fails its
// FIRST --version (cold-start hiccup) then succeeds — within one health() call the retry recovers it.
test('health(): one-shot retry survives a single flaky --version; negative verdict is not cached', async () => {
  const { health, _clearHealthCache } = await import('../src/lib/backends.mjs');
  _clearHealthCache();
  const d = tmp('hretry-');
  const counter = join(d, 'n.txt');
  const fake = join(d, process.platform === 'win32' ? 'flaky.cmd' : 'flaky.sh');
  if (process.platform === 'win32') {
    // First --version invocation exits 1 (no output); every later one prints a version + exit 0.
    writeFileSync(fake,
      '@echo off\r\n' +
      'if not exist "' + counter.replace(/\//g, '\\') + '" ( echo x > "' + counter.replace(/\//g, '\\') + '" & exit /b 1 )\r\n' +
      'echo flaky 1.0\r\n' +
      'exit /b 0\r\n');
  } else {
    writeFileSync(fake,
      '#!/usr/bin/env bash\n' +
      'if [ ! -f "' + counter + '" ]; then echo x > "' + counter + '"; exit 1; fi\n' +
      'echo "flaky 1.0"\n');
    chmodSync(fake, 0o755);
  }
  // health() resolves the binary for kind:"codex" via resolveBinary('codex', …) which honors MMT_BE_BIN.
  process.env.MMT_BE_BIN = fake;
  try {
    const cfg = { kind: 'codex', enabled: true, health: '--version' };
    // The first attempt's --version fails (exit 1), the in-probe retry succeeds -> healthy in ONE call.
    const ok = await health(cfg);
    assert.equal(ok, true, 'one-shot retry recovers a single flaky --version within one health() call');
  } finally {
    delete process.env.MMT_BE_BIN;
    _clearHealthCache();
  }
});

test('run.mjs (no --writable): CLI gets the read-only sandbox flags (default behaviour unchanged)', () => {
  const d = tmp('eread-');
  const wt = join(d, 'here');
  mkdirSync(wt, { recursive: true });
  const fake = join(d, process.platform === 'win32' ? 'faker.cmd' : 'faker.sh');
  if (process.platform === 'win32') {
    writeFileSync(fake,
      '@echo off\r\n' +
      'if "%1"=="--version" ( echo faker 1.0 & exit /b 0 )\r\n' +
      'echo args=%* > ro-args.txt\r\n' +
      'echo READONLY_OK\r\n' +
      'exit /b 0\r\n');
  } else {
    writeFileSync(fake,
      '#!/usr/bin/env bash\n' +
      'if [ "${1:-}" = "--version" ]; then echo "faker 1.0"; exit 0; fi\n' +
      'echo "args=$*" > ro-args.txt\n' +
      'echo READONLY_OK\n');
    chmodSync(fake, 0o755);
  }
  const r = writeRosterVariant(d, 'r.json', (c) => { c.backends.agy.enabled = false; });
  const callFile = join(d, 'call.json');
  writeFileSync(callFile, JSON.stringify({
    decision: { backend: 'codex', model: '', tier: 'standard', rule: 'team', native: false },
    task: 'review',
  }), 'utf8');
  // --cwd given but NO --writable: read-only extra must still be used.
  const { stdout } = runNode(BIN_RUN, { args: ['--roster', r, '--cwd', wt, '--call-file', callFile], env: { MMT_BE_BIN: fake } });
  assert.match(stdout, /READONLY_OK/, 'CLI ran');
  const body = readFileSync(join(wt, 'ro-args.txt'), 'utf8');
  assert.match(body, /read-only/, 'read-only mode keeps the -s read-only sandbox flag');
  assert.doesNotMatch(body, /dangerously-bypass/, 'read-only mode does NOT use the full-auto flag');
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
