// cli.test.mjs — spawn-based tests for the CLI entry points of team-spec.mjs and config.mjs.
// Guards against the regression where these modules had no CLI guard and printed nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── run.mjs file transports (--call-file / --task-file / --decision-file) ─────
// The shell-agnostic relay transport: the relay sub-agent WRITES the payload to a .mmt/calls/ file
// (never a shell), and only the file PATH rides on the command line. run.mjs reads it in Node. A
// NATIVE forced decision needs no backend call, so the handoff sentinel is a deterministic,
// offline-checkable proof that the file read + decision-parse round-trip correctly.

test('run.mjs --call-file: reads unicode task + parses decision from one JSON file (native handoff)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmt-call-'));
  const callPath = join(dir, 'c1.json');
  writeFileSync(callPath, JSON.stringify({
    decision: { backend: 'native', model: '', tier: 'opus', rule: 'reason', native: true },
    task: 'Explain café 日本語 🚀 in one line',
  }), 'utf8');
  const r = spawnSync(process.execPath, [join(ROOT, 'src/bin/run.mjs'), `--call-file=${callPath}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  // Native decision -> deterministic handoff sentinel carrying the file's tier+rule.
  assert.match(r.stdout, /MMT_NATIVE_HANDOFF/, 'native decision -> handoff sentinel');
  assert.match(r.stdout, /tier=opus/, 'call-file decision tier read + applied');
  assert.match(r.stdout, /rule=reason/, 'call-file decision rule read + applied');
});

test('run.mjs --task-file + --decision: reads task from file, decision inline (native handoff)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmt-task-'));
  const taskPath = join(dir, 't1.txt');
  writeFileSync(taskPath, 'Summarize the design 日本語', 'utf8');
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'src/bin/run.mjs'), `--task-file=${taskPath}`, '--decision', '{"backend":"native","native":true,"tier":"sonnet","rule":"x"}'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /MMT_NATIVE_HANDOFF/, 'native decision -> handoff sentinel');
  assert.match(r.stdout, /tier=sonnet/, 'inline decision applied with --task-file');
});

test('run.mjs --call-file: missing file exits 2 (fail loud, not silent misdispatch)', () => {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'src/bin/run.mjs'), `--call-file=${join(tmpdir(), 'mmt-does-not-exist-xyz.json')}`],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 2, 'missing --call-file must exit 2');
  assert.match(r.stderr, /cannot read --call-file/, 'stderr names the bad flag');
});

test('run.mjs --call-file: invalid JSON exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmt-badjson-'));
  const callPath = join(dir, 'bad.json');
  writeFileSync(callPath, '{not valid json', 'utf8');
  const r = spawnSync(process.execPath, [join(ROOT, 'src/bin/run.mjs'), `--call-file=${callPath}`], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'invalid JSON in --call-file must exit 2');
  assert.match(r.stderr, /invalid JSON in --call-file/, 'stderr explains the bad JSON');
});

test('run.mjs --call-file: valid JSON but no "task" field exits 2 (fail loud, not silent stdin fallthrough)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmt-notask-'));
  const callPath = join(dir, 'notask.json');
  // A corrupt relay payload: decision present, task missing. Must fail loud, not block on stdin.
  writeFileSync(callPath, JSON.stringify({ decision: { backend: 'codex', native: false } }), 'utf8');
  const r = spawnSync(process.execPath, [join(ROOT, 'src/bin/run.mjs'), `--call-file=${callPath}`], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 2, 'call-file with no task must exit 2');
  assert.match(r.stderr, /has no usable "task" field/, 'stderr names the missing task field');
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

// ── roster resolution: .mmt/roster.json (cwd) > ~/.claude/mmt-roster.json > plugin default ──
// File-based, env-free. Exercised end-to-end through config.mjs's one-arg form: HOME/USERPROFILE
// point at a tmp dir (the user-roster branch) and cwd is a tmp project dir (the .mmt branch).
// A distinctive reasoning.cap proves WHICH file was read (plugin default ships cap=6).

function rosterWithCap(cap) {
  return JSON.stringify({ reasoning: { panel: ['opus'], cap } });
}
function writeUserRoster(home, cap) {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'mmt-roster.json'), rosterWithCap(cap), 'utf8');
}
function writeProjectRosterFile(projDir, cap) {
  mkdirSync(join(projDir, '.mmt'), { recursive: true });
  writeFileSync(join(projDir, '.mmt', 'roster.json'), rosterWithCap(cap), 'utf8');
}
// `node config.mjs reasoning-config` (one-arg form -> shared resolver), with a fake home + cwd.
function runReasoningConfig(home, cwd) {
  return spawnSync(
    process.execPath,
    [join(ROOT, 'src/lib/config.mjs'), 'reasoning-config'],
    { encoding: 'utf8', cwd, env: { ...process.env, HOME: home, USERPROFILE: home } }
  );
}

test('roster resolution: .mmt/roster.json (cwd) wins over ~/.claude and plugin default', () => {
  const home = mkdtempSync(join(tmpdir(), 'mmt-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'mmt-proj-'));
  writeUserRoster(home, 99);       // user roster present...
  writeProjectRosterFile(proj, 7); // ...but project .mmt/roster.json must win.

  const r = runReasoningConfig(home, proj);
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout.trim()).cap, 7, '.mmt/roster.json (cap=7) wins');
});

test('roster resolution: ~/.claude/mmt-roster.json used when no project roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'mmt-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'mmt-proj-empty-')); // no .mmt/
  writeUserRoster(home, 99);

  const r = runReasoningConfig(home, proj);
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout.trim()).cap, 99, 'used ~/.claude/mmt-roster.json (cap=99)');
});

test('roster resolution: falls back to plugin default when neither project nor user roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'mmt-home-empty-'));
  const proj = mkdtempSync(join(tmpdir(), 'mmt-proj-empty2-'));
  const r = runReasoningConfig(home, proj);
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout.trim()).cap, 6, 'fell back to plugin default roster (cap=6)');
});

// ── setup.mjs (/mmt-setup): creates ~/.claude/mmt-roster.json, never clobbers ─
test('setup.mjs: creates ~/.claude/mmt-roster.json, no-op on re-run, --force resets', () => {
  const home = mkdtempSync(join(tmpdir(), 'mmt-setup-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const setup = (args = []) => spawnSync(process.execPath, [join(ROOT, 'src/bin/setup.mjs'), ...args], { encoding: 'utf8', env });
  const target = join(home, '.claude', 'mmt-roster.json');

  // First run creates it, seeded from the plugin default (cap=6).
  const r1 = setup();
  assert.equal(r1.status, 0, `exit ${r1.status}; stderr: ${r1.stderr}`);
  assert.match(r1.stdout, /created your personal roster/, 'reports creation');
  assert.ok(existsSync(target), 'file created at ~/.claude/mmt-roster.json');
  const seeded = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(seeded.reasoning.cap, 6, 'seeded from the shipped default (cap=6)');

  // Re-run is a no-op: it must NOT clobber an edited personal roster.
  writeFileSync(target, JSON.stringify({ reasoning: { panel: ['opus'], cap: 123 } }), 'utf8');
  const r2 = setup();
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /already exists — leaving it untouched/, 're-run is a no-op');
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).reasoning.cap, 123, 'edited roster preserved');

  // --force resets it back to the shipped default.
  const r3 = setup(['--force']);
  assert.equal(r3.status, 0);
  assert.match(r3.stdout, /reset your personal roster/, '--force resets');
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).reasoning.cap, 6, '--force restored the default');
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

test('run.mjs --cwd / --writable: accepted (not unknown flags) with a forced native decision', () => {
  // Writable-mode flags must parse even on the native short-circuit (no backend invoked here).
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/bin/run.mjs'), '--cwd', ROOT, '--writable', '--decision', '{"backend":"native","native":true}'],
    { input: 'x', encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `--cwd/--writable should be accepted; exit ${result.status}; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /unknown flag/, 'must not report --cwd/--writable as unknown flags');
  assert.match(result.stdout, /MMT_NATIVE_HANDOFF/, 'native decision still short-circuits');
});

test('run.mjs --cwd=VALUE (equals form, as the workflow relay emits it): parsed, not an unknown flag', () => {
  // The workflow builds `--cwd=${JSON.stringify(worktree)}` (equals form). Prove parseArgs's generic
  // eq-split handles it for --cwd, not just the space form.
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/bin/run.mjs'), `--cwd=${ROOT}`, '--writable', '--decision', '{"backend":"native","native":true}'],
    { input: 'x', encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `--cwd=VALUE should parse; exit ${result.status}; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /unknown flag/, '--cwd=VALUE must not be an unknown flag');
  assert.match(result.stdout, /MMT_NATIVE_HANDOFF/, 'native short-circuit still works');
});

test('pluginRootFrom: decodes percent-encoded file:// URLs (space/non-ASCII paths)', async () => {
  // Regression: pluginRootFrom used URL.pathname (percent-ENCODED, never decoded), so a plugin
  // path with a space (C:\Users\First Last\...) — very common on Windows — resolved to a non-
  // existent `…First%20Last…` root. Every roster/tags lookup then failed fs.existsSync and ALL
  // hooks fail-open (silent no-op). The fix uses fileURLToPath. Assert no stray %xx survives and
  // that the returned root is the parent of the hooks/ dir.
  const { pluginRootFrom } = await import('../src/lib/hook-common.mjs');
  const { pathToFileURL } = await import('node:url');
  const { join: pjoin } = await import('node:path');

  // A hook file living at <root>/hooks/x.mjs where <root> contains a space and a non-ASCII char.
  const fakeRoot = pjoin(tmpdir(), 'My Plugin Dir é', 'mmt-root');
  const hookFile = pjoin(fakeRoot, 'hooks', 'proactive-route.mjs');
  const hookUrl = pathToFileURL(hookFile).href;

  const root = pluginRootFrom(hookUrl);
  assert.doesNotMatch(root, /%[0-9A-Fa-f]{2}/, 'resolved root must not contain percent-escapes');
  assert.equal(root, fakeRoot, 'root is the parent of the hooks/ directory, fully decoded');
});
