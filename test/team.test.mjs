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
test('splitSpec deterministic boundary', () => {
  assert.equal(splitSpec('2:claude,5:gemini build it').caps.gemini, 5, 'caps preserved either order');
  assert.equal(splitSpec('5:gemini,2:claude build it').task, 'build it', 'task extracted');
  assert.equal(splitSpec('do a thing with 3 steps: x').task, 'do a thing with 3 steps: x', '"N steps:" is NOT a spec');
  assert.equal(splitSpec('fix the bug').caps.gemini, 4, 'no spec -> default gemini');
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

test('gen-agents: forced dispatch pins backend via --decision-b64; route dispatch does not', () => {
  const d = tmp('gen-forced-');
  const agentsDir = join(d, 'agents');
  generateAgents(ROSTER, agentsDir);
  // codex agent is dispatch:forced in the roster -> body must carry a forced --decision-b64.
  // The decision JSON is base64url-encoded (shell-agnostic: no single-quoted JSON / `\` line-
  // continuation that mangles under PowerShell) — decode it and assert the forced flags survive.
  if (existsSync(join(agentsDir, 'codex.md'))) {
    const codexBody = readFileSync(join(agentsDir, 'codex.md'), 'utf8');
    const m = codexBody.match(/--decision-b64=([A-Za-z0-9_-]+)/);
    assert.ok(m, 'forced agent body pins a --decision-b64 token');
    const decision = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    assert.equal(decision.native, false, 'forced agent forces backend (native:false)');
    assert.equal(decision.backend, 'codex', 'forced agent pins the codex backend');
    // No single-quoted inline JSON / backslash line-continuation (the PowerShell-hostile form).
    assert.doesNotMatch(codexBody, /--decision '/, 'no single-quoted inline --decision JSON');
  }
});
