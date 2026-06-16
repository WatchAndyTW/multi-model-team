// cli.test.mjs — spawn-based tests for the CLI entry points of team-spec.mjs and config.mjs.
// Guards against the regression where these modules had no CLI guard and printed nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── team-spec.mjs CLI (--split) ──────────────────────────────────────────────

test('team-spec.mjs --split: parses cap spec + task from stdin', () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/lib/team-spec.mjs'), '--split'],
    { input: '2:gemini,1:codex build x', encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `exit ${result.status}; stderr: ${result.stderr}`);
  assert.ok(result.stdout.trim().length > 0, 'stdout must be non-empty');
  const parsed = JSON.parse(result.stdout.trim());
  // splitSpec returns { caps: {gemini,codex,claude,...}, task, source }
  assert.equal(parsed.caps.gemini, 2, 'gemini cap = 2');
  assert.equal(parsed.caps.codex, 1, 'codex cap = 1');
  assert.equal(parsed.task, 'build x', 'task stripped correctly');
  assert.equal(parsed.source, 'spec', 'source = spec when a valid spec is present');
});

test('team-spec.mjs --split: no spec → default caps + full text as task', () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/lib/team-spec.mjs'), '--split'],
    { input: 'just a plain task', encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `exit ${result.status}; stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.source, 'default', 'no spec → source=default');
  assert.equal(parsed.task, 'just a plain task', 'full input returned as task');
  assert.ok(typeof parsed.caps.gemini === 'number', 'gemini is a number');
});

test('team-spec.mjs (no --split): parseCaps from stdin', () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/lib/team-spec.mjs')],
    { input: '3:gemini,2:claude', encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `exit ${result.status}; stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.gemini, 3, 'gemini cap parsed');
  assert.equal(parsed.claude, 2, 'claude cap parsed');
  assert.equal(parsed.source, 'spec');
});

// ── config.mjs CLI (team-config) ─────────────────────────────────────────────

test('config.mjs team-config: returns valid team config JSON', () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/lib/config.mjs'), join(ROOT, 'config/roster.json'), 'team-config'],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `exit ${result.status}; stderr: ${result.stderr}`);
  assert.ok(result.stdout.trim().length > 0, 'stdout must be non-empty');
  const parsed = JSON.parse(result.stdout.trim());
  assert.ok(Array.isArray(parsed.dispatch_backends), 'dispatch_backends is an array');
  assert.ok(typeof parsed.verifier === 'string', 'verifier is a string');
  assert.ok(typeof parsed.caps === 'object' && parsed.caps !== null, 'caps is an object');
  assert.ok(typeof parsed.verify === 'boolean', 'verify is a boolean');
  assert.ok(typeof parsed.max_fix_loops === 'number', 'max_fix_loops is a number');
});

test('config.mjs unknown mode: exits 2 with stderr message', () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/lib/config.mjs'), join(ROOT, 'config/roster.json'), 'bogus-mode'],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 2, 'should exit with code 2 for unknown mode');
  assert.match(result.stderr, /unknown mode/, 'stderr mentions unknown mode');
});

test('config.mjs missing args: exits 2', () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/lib/config.mjs')],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 2, 'missing args → exit 2');
});

// ── run.mjs CLI (--add-dir is accepted, not rejected as an unknown flag) ──────

test('run.mjs --add-dir: accepted (not an unknown flag) with a forced native decision', () => {
  // Regression: --add-dir is instructed by every agent, but run.mjs parseArgs
  // lacked it, so it bombed with "unknown flag" (exit 2). A native decision short-circuits to the
  // handoff sentinel (no backend invoked) — so this exercises arg parsing without touching agy/codex.
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/bin/run.mjs'), '--add-dir', ROOT, '--decision', '{"backend":"native","native":true}'],
    { input: 'x', encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `--add-dir should be accepted; exit ${result.status}; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /unknown flag/, 'must not report --add-dir as an unknown flag');
  assert.match(result.stdout, /MMT_NATIVE_HANDOFF/, 'native decision emits the handoff sentinel');
});
