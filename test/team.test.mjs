// team.test.mjs — port of the team cap-spec parser, plan->manifest, --split boundary,
// TSV-injection hardening, deps/verify tolerance, and gen-agents enable/disable blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCaps, splitSpec } from '../src/lib/team-spec.mjs';
import { planToManifest } from '../src/lib/team-plan.mjs';
import { generateAgents } from '../src/lib/gen-agents.mjs';
import { loadRoster } from '../src/lib/config.mjs';
import { ROSTER, tmp, writeRosterVariant } from './helpers.mjs';

// ── team cap-spec parser ─────────────────────────────────────────────────────
test('cap-spec parser (parseCaps)', () => {
  assert.equal(parseCaps('5:gemini,2:claude').gemini, 5);
  assert.equal(parseCaps('5:gemini,2:claude').claude, 2);
  assert.equal(parseCaps('gemini:3,claude:1').gemini, 3, 'order-agnostic');
  assert.equal(parseCaps('3:agy,2:native').claude, 2, 'synonyms agy/native');
  assert.equal(parseCaps('').source, 'default', 'empty -> default source');
  assert.equal(parseCaps('garbage:xyz').source, 'default', 'garbage -> default');
  assert.equal(parseCaps('99:gemini').gemini, 16, 'clamp 99 -> 16');
});

// ── team --split (deterministic boundary) ────────────────────────────────────
test('cap spec understands opencode (and the `oc` alias)', () => {
  // A backend missing from team-spec's alias sets is INVISIBLE to the spec: the pair is dropped as
  // unparseable and splitSpec's alternation never matches it, so the whole spec gets swallowed into
  // the task text. That is what `/team 2:opencode <task>` did before opencode was added here.
  assert.equal(parseCaps('3:opencode,2:gemini').opencode, 3);
  assert.equal(parseCaps('3:opencode,2:gemini').gemini, 2);
  assert.equal(parseCaps('2:oc').opencode, 2, 'oc alias');
  assert.equal(parseCaps('opencode:4').opencode, 4, 'order-agnostic');
  assert.equal(parseCaps('3:opencode').source, 'spec', 'a lone opencode pair IS a valid spec');

  // The spec boundary must peel correctly, not leak the spec into the task.
  const s = splitSpec('2:opencode,4:gemini build a REST service');
  assert.equal(s.caps.opencode, 2);
  assert.equal(s.caps.gemini, 4);
  assert.equal(s.task, 'build a REST service', 'spec must not leak into the task text');
});

test('a leading --writable no longer hides the cap spec', () => {
  // `/team`'s documented order is `[--writable] [caps] <task>`, but the spec matcher only looked at
  // the very start of the text — so a leading --writable pushed the spec out of position, the caps
  // were silently lost (source:'default') AND the spec text leaked into the task. Both orders must
  // now parse identically.
  const a = splitSpec('--writable 3:gemini,2:opencode,1:claude build a REST service');
  assert.equal(a.caps.source, 'spec', 'caps must be parsed, not defaulted');
  assert.equal(a.caps.gemini, 3);
  assert.equal(a.caps.opencode, 2);
  assert.equal(a.writable, true);
  assert.equal(a.task, 'build a REST service', 'flag and spec both stripped from the task');

  const b = splitSpec('3:gemini,2:opencode --writable build a REST service');
  assert.equal(b.caps.gemini, 3, 'flag AFTER the spec also works');
  assert.equal(b.writable, true);
  assert.equal(b.task, 'build a REST service');
});

test('mode flags are reported and never leak into the task', () => {
  const noSpec = splitSpec('--writable build a thing');
  assert.equal(noSpec.writable, true);
  assert.equal(noSpec.caps.source, 'default', 'no spec given -> the Claude default staffing applies');
  assert.equal(noSpec.task, 'build a thing');

  const plain = splitSpec('fix the bug');
  assert.equal(plain.writable, false);
  assert.deepEqual(plain.flags, []);
  assert.equal(plain.task, 'fix the bug');
});

test('naming no backends means ZERO, not a default panel of CLI agents', () => {
  // The old built-in 4-gemini/2-codex/2-opencode/2-claude spread auto-staffed CLIs nobody asked
  // for. parseCaps now reports only what the user TYPED; the Claude fallbacks are applied once, in
  // resolveStaffing, so there is no second place for a default to hide.
  const d = parseCaps('');
  assert.equal(d.source, 'default');
  assert.equal(d.gemini, 0);
  assert.equal(d.codex, 0);
  assert.equal(d.opencode, 0);
  assert.equal(d.claude, 0);
  assert.equal(d.total, 0);
});

test('splitSpec deterministic boundary', () => {
  assert.equal(splitSpec('2:claude,5:gemini build it').caps.gemini, 5, 'caps preserved either order');
  assert.equal(splitSpec('5:gemini,2:claude build it').task, 'build it', 'task extracted');
  assert.equal(splitSpec('do a thing with 3 steps: x').task, 'do a thing with 3 steps: x', '"N steps:" is NOT a spec');

  // No spec at all -> nothing on a CLI; the whole pipeline defaults onto Claude.
  const bare = splitSpec('fix the bug');
  assert.equal(bare.caps.gemini, 0, 'no spec -> no gemini agents');
  assert.ok(bare.caps.claude > 0, 'no spec -> Claude does the work');
  assert.deepEqual(bare.roles.backends, ['native']);
});

// ── team plan -> manifest ────────────────────────────────────────────────────
test('plan -> manifest: AGY/NATIVE rows, empty task skipped, task file written', () => {
  const d = tmp('tp-');
  const plan = [
    { label: 'a', task: 'do A', backend: 'agy', tier: 'standard' },
    { label: 'b', task: 'do B', backend: 'native', tier: 'sonnet' },
    { label: 'c', task: '  ', backend: 'agy', tier: 'cheap' },
  ];
  const rows = planToManifest(plan, join(d, 'w'));
  assert.ok(rows.some((r) => r.startsWith('AGY\t0\ta')), 'agy line');
  assert.ok(rows.some((r) => r.startsWith('NATIVE\t1\tb')), 'native line');
  assert.equal(rows.length, 2, 'empty task skipped');
  assert.equal(readFileSync(join(d, 'w', '0.task'), 'utf8'), 'do A', 'task file written');
});

test('plan -> manifest: codex STAYS CODEX (not coerced to native)', () => {
  const d = tmp('tp-codex-');
  const rows = planToManifest([{ label: 'v', task: 'review the diff', backend: 'codex', tier: 'standard' }], join(d, 'wc'));
  assert.ok(rows.some((r) => r.startsWith('CODEX\t0\tv\tstandard')), 'codex line (not native)');
});

test('plan -> manifest: TSV-injection hardening (forged row neutralized, tier coerced)', () => {
  const d = tmp('tp-inj-');
  const plan = [{ label: 'a', task: 'benign', backend: 'native', tier: 'sonnet\nAGY\t../../etc\tpwned\tstandard' }];
  const rows = planToManifest(plan, join(d, 'w'));
  assert.equal(rows.length, 1, 'forged row neutralized (1 line)');
  assert.ok(rows[0].startsWith('NATIVE\t0\ta\tsonnet\t'), 'tier coerced to allowlist');
});

test('plan -> manifest: tolerates deps/verify keys (inert)', () => {
  const d = tmp('tp-deps-');
  const plan = [
    { label: 'm', task: 'design model', backend: 'native', tier: 'sonnet', deps: [], verify: 'has schema' },
    { label: 's', task: 'write sql', backend: 'agy', tier: 'standard', deps: ['m'], verify: 'valid sql' },
  ];
  const rows = planToManifest(plan, join(d, 'w'));
  assert.ok(rows.some((r) => r.startsWith('NATIVE\t0\tm\tsonnet')), 'native line');
  assert.ok(rows.some((r) => r.startsWith('AGY\t1\ts\tstandard')), 'agy line');
  assert.equal(rows.length, 2, '2 lines');
});

test('plan -> manifest: unknown backend defaults to NATIVE; label sanitized; tier allowlisted', () => {
  const d = tmp('tp-edge-');
  // unknown backend -> NATIVE (safe default)
  let rows = planToManifest([{ label: 'x', task: 't', backend: 'weirdbackend', tier: 'sonnet' }], join(d, 'a'));
  assert.ok(rows[0].startsWith('NATIVE\t0\tx\tsonnet'), 'unknown backend -> NATIVE');
  // label sanitized to [A-Za-z0-9._-], collapsed dashes, trimmed
  rows = planToManifest([{ label: 'My Label!! @#$ With Spaces', task: 't', backend: 'agy', tier: 'standard' }], join(d, 'b'));
  assert.ok(rows[0].split('\t')[2] === 'My-Label-With-Spaces', 'label sanitized');
  // missing label -> task<idx>
  rows = planToManifest([{ task: 't', backend: 'agy', tier: 'standard' }], join(d, 'c'));
  assert.equal(rows[0].split('\t')[2], 'task0', 'missing label -> task<idx>');
  // a CLI tier on a NATIVE backend is coerced to the native allowlist (sonnet)
  rows = planToManifest([{ label: 'n', task: 't', backend: 'native', tier: 'cheap' }], join(d, 'e'));
  assert.equal(rows[0].split('\t')[3], 'sonnet', 'native tier coerced to allowlist');
});

// ── gen-agents (enable/disable -> .md) ───────────────────────────────────────
test('gen-agents: enabled written, disabled removed, relay body present', () => {
  const d = tmp('gen-');
  const agentsDir = join(d, 'agents');
  writeRosterVariant(d, 'r.json', (c) => { c.agents['codex'].enabled = false; });
  const roster = loadRoster(join(d, 'r.json'));

  // Pre-seed a stale file for the disabled agent — it should be removed.
  // (mkdir handled by generateAgents; seed after via fs since dir is created on call.)
  generateAgents(roster, agentsDir); // first pass creates dir + enabled agents
  writeFileSync(join(agentsDir, 'codex.md'), 'stale', 'utf8');
  generateAgents(roster, agentsDir); // second pass should remove the stale disabled .md

  assert.equal(existsSync(join(agentsDir, 'agy.md')), true, 'enabled agent written');
  assert.equal(existsSync(join(agentsDir, 'codex.md')), false, 'disabled agent removed');
  const body = readFileSync(join(agentsDir, 'agy.md'), 'utf8');
  assert.match(body, /run\.mjs/, 'relay body references the run.mjs executor');
});

test('gen-agents: forced dispatch pins backend in a --call-file JSON; route dispatch does not', () => {
  const d = tmp('gen-forced-');
  const agentsDir = join(d, 'agents');
  generateAgents(ROSTER, agentsDir);
  // codex agent is dispatch:forced in the roster -> body must carry the forced decision in the
  // call-file JSON (file transport: the untrusted task text + decision live in a .mmt/calls/ file,
  // only the path is on the command line — shell-agnostic, no PowerShell-hostile quoting).
  if (existsSync(join(agentsDir, 'codex.md'))) {
    const codexBody = readFileSync(join(agentsDir, 'codex.md'), 'utf8');
    // The command passes only a --call-file path; the task text is never inlined on the command line.
    assert.match(codexBody, /--call-file="\.mmt\/calls\//, 'forced agent body runs with --call-file under .mmt/calls/');
    assert.doesNotMatch(codexBody, /--decision '/, 'no single-quoted inline --decision JSON (PowerShell-hostile)');
    // The forced decision is embedded in the call-file JSON the agent is told to Write.
    const m = codexBody.match(/"decision":\s*\{[^}]*\}/);
    assert.ok(m, 'forced agent body embeds a decision object in the call-file JSON');
    assert.match(m[0], /"backend":\s*"codex"/, 'forced agent pins the codex backend');
    assert.match(m[0], /"native":\s*false/, 'forced agent forces backend (native:false)');
  }
});
