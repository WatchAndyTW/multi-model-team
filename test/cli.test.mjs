// cli.test.mjs — spawn-based tests for the CLI entry points of team-spec.mjs and config.mjs.
// Guards against the regression where these modules had no CLI guard and printed nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── run.mjs base64url transports (--task-b64 / --decision-b64) ───────────────
// The shell-agnostic relay transport: payload + decision ride as base64url args, decoded in Node
// (never a shell). A NATIVE forced decision needs no backend call, so the handoff sentinel is a
// deterministic, offline-checkable proof that decode + decision-parse round-trip correctly.

// Pure-JS base64url encoder, byte-identical to the workflow-side encoder it must interop with.
function b64urlEncode(s) {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = Buffer.from(String(s), 'utf8');
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]; const b = bytes[i + 1]; const c = bytes[i + 2];
    out += ALPHA[a >> 2];
    out += ALPHA[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += i + 1 < bytes.length ? ALPHA[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHA[c & 63] : '=';
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

test('run.mjs --task-b64/--decision-b64: decodes unicode + parses decision (native handoff)', () => {
  const task = 'Explain café 日本語 🚀 in one line';
  const decision = JSON.stringify({ backend: 'native', model: '', tier: 'opus', rule: 'reason', native: true });
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'src/bin/run.mjs'), `--task-b64=${b64urlEncode(task)}`, `--decision-b64=${b64urlEncode(decision)}`],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  // Native decision -> deterministic handoff sentinel carrying the decoded tier+rule.
  assert.match(r.stdout, /MMT_NATIVE_HANDOFF/, 'native decision -> handoff sentinel');
  assert.match(r.stdout, /tier=opus/, 'decision-b64 tier decoded + applied');
  assert.match(r.stdout, /rule=reason/, 'decision-b64 rule decoded + applied');
});

test('run.mjs --task-b64: invalid base64url exits 2 (fail loud, not silent misdispatch)', () => {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'src/bin/run.mjs'), '--task-b64=not valid b64!!', '--decision', '{"backend":"native","native":true}'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 2, 'invalid --task-b64 must exit 2');
  assert.match(r.stderr, /invalid --task-b64/, 'stderr names the bad flag');
});

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

// ── roster resolution: $MMT_ROSTER > ~/.claude/mmt-roster.json > plugin default ──
// The "setup is correct" fix: a user's ~/.claude/mmt-roster.json must be picked up automatically.
// Exercised end-to-end through config.mjs's one-arg form, with HOME/USERPROFILE pointed at a tmp
// dir so the user-file branch is deterministic (config.mjs reads it via the shared resolver).

// A roster with a distinctive reasoning.cap proves WHICH file was read.
function rosterWithCap(cap) {
  return JSON.stringify({ reasoning: { panel: ['opus'], cap } });
}
// Spawn `node config.mjs reasoning-config` (one-arg form -> shared resolver) with a fake home.
function runReasoningConfig(home, env = {}) {
  return spawnSync(
    process.execPath,
    [join(ROOT, 'src/lib/config.mjs'), 'reasoning-config'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, MMT_ROSTER: '', ...env } }
  );
}

test('roster resolution: ~/.claude/mmt-roster.json is used when present (one-arg form)', () => {
  const home = mkdtempSync(join(tmpdir(), 'mmt-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'mmt-roster.json'), rosterWithCap(99), 'utf8');

  const r = runReasoningConfig(home);
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.cap, 99, 'used ~/.claude/mmt-roster.json (cap=99), not the plugin default');
});

test('roster resolution: falls back to plugin default when no user roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'mmt-home-empty-'));
  // No .claude/mmt-roster.json written.
  const r = runReasoningConfig(home);
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout.trim());
  // The shipped config/roster.json has reasoning.cap = 6.
  assert.equal(parsed.cap, 6, 'fell back to plugin default roster (cap=6)');
});

test('roster resolution: $MMT_ROSTER wins over the user roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'mmt-home-env-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'mmt-roster.json'), rosterWithCap(99), 'utf8');
  // An explicit env roster with a different cap must win.
  const envRoster = join(home, 'env-roster.json');
  writeFileSync(envRoster, rosterWithCap(42), 'utf8');

  const r = runReasoningConfig(home, { MMT_ROSTER: envRoster });
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.cap, 42, '$MMT_ROSTER (cap=42) wins over the user roster (cap=99)');
});

// ── run.mjs CLI (--add-dir is accepted, not rejected as an unknown flag) ──────

test('run.mjs --add-dir: accepted (not an unknown flag) with a forced native decision', () => {
  // Regression: --add-dir is instructed by every agent + heavy-read-guard, but run.mjs parseArgs
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
