// hooks.test.mjs — port of the hook unit blocks (heavy-read, proactive, spawn-route guard).
// Each hook is one node process; we drive it via stdin payloads with a chosen roster.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOOK_HEAVY, HOOK_PROACTIVE, HOOK_SPAWN, HOOK_FANOUT, ROSTER_PATH,
  tmp, writeRosterVariant, runNode,
} from './helpers.mjs';

// ── heavy-read guard (allow / deny) ──────────────────────────────────────────
test('heavy-read guard: allow small dump / big non-guarded ext, deny big dump', () => {
  const d = tmp('hr-');
  const small = join(d, 't_small.dump');
  const big = join(d, 't_big.dump');
  const bigTxt = join(d, 't_big.txt');
  writeFileSync(small, 'x'.repeat(1000));
  writeFileSync(big, 'x'.repeat(80000));
  writeFileSync(bigTxt, 'x'.repeat(80000));
  const payload = (fp) => JSON.stringify({ tool_name: 'Read', tool_input: { file_path: fp } });

  assert.equal(runNode(HOOK_HEAVY, { input: payload(small) }).stdout, '', 'small dump -> allow (silent)');
  assert.equal(runNode(HOOK_HEAVY, { input: payload(bigTxt) }).stdout, '', 'big .txt -> allow (silent)');
  assert.match(runNode(HOOK_HEAVY, { input: payload(big) }).stdout, /"permissionDecision":"deny"/, 'big dump -> deny');
});

test('heavy-read guard: MMT_HOOK_DISABLE=1 -> silent', () => {
  const d = tmp('hr-dis-');
  const big = join(d, 't_big.dump');
  writeFileSync(big, 'x'.repeat(80000));
  const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: big } });
  assert.equal(runNode(HOOK_HEAVY, { input: payload, env: { MMT_HOOK_DISABLE: '1' } }).stdout, '');
});

// ── proactive route (UserPromptSubmit) ───────────────────────────────────────
test('proactive hook: off->silent, on+agy->nudge, opus/slash/cap/env->silent', () => {
  const d = tmp('pr-');
  const on = writeRosterVariant(d, 'on.json', (c) => { c.proactive.enabled = true; });
  const cap = writeRosterVariant(d, 'cap.json', (c) => { c.proactive.enabled = true; c.proactive.max_chars = 10; });
  const sql = JSON.stringify({ prompt: 'Write a SQL query to join users and orders tables' });
  const run = (payload, roster, env = {}) => runNode(HOOK_PROACTIVE, { input: payload, env: { MMT_ROSTER: roster, ...env } }).stdout;

  assert.equal(run(sql, ROSTER_PATH), '', 'disabled -> silent');
  const nudge = run(sql, on);
  assert.match(nudge, /routes to agy/, 'enabled+agy -> nudge');
  assert.match(nudge, /multi-model-team:delegate/, 'nudge names delegate agent');
  assert.equal(run(JSON.stringify({ prompt: 'Reverse engineer the IL2CPP dump and extract protobuf' }), on), '', 'opus task -> silent');
  assert.equal(run(JSON.stringify({ prompt: '/team build a thing' }), on), '', 'slash command -> silent');
  assert.equal(run(sql, cap), '', 'max_chars cap -> silent');
  assert.equal(run(sql, on, { MMT_PROACTIVE_DISABLE: '1' }), '', 'env DISABLE -> silent');
});

// ── spawn-route guard (PreToolUse Task/Agent) ────────────────────────────────
function mkspawn(sub, desc, prompt) {
  return JSON.stringify({ tool_name: 'Task', tool_input: { subagent_type: sub, description: desc, prompt } });
}

test('spawn guard: agy nudge / enforce-deny / codex / exemptions', () => {
  const d = tmp('sp-');
  const on = writeRosterVariant(d, 'on.json', (c) => { c.proactive.enabled = true; });
  const enforce = writeRosterVariant(d, 'enforce.json', (c) => { c.proactive.enabled = true; c.proactive.enforce_spawns = true; });
  const guardoff = writeRosterVariant(d, 'guardoff.json', (c) => { c.proactive.enabled = true; c.proactive.guard_spawns = false; });
  const sh = (payload, roster, env = {}) => runNode(HOOK_SPAWN, { input: payload, env: { MMT_ROSTER: roster, ...env } }).stdout;

  const sql = mkspawn('general-purpose', 'write sql', 'Write a SQL query to list all users sorted by signup date');
  const codex = mkspawn('general-purpose', 'review', 'Review this diff for correctness bugs and regressions, then write a regression test suite');
  const nat = mkspawn('general-purpose', 're', 'Reverse engineer the IL2CPP global-metadata and reconstruct protobuf schemas via disassembly');
  const our = mkspawn('multi-model-team:delegate', 'x', 'Write a SQL query to list all users');
  const runsh = mkspawn('general-purpose', 'x', 'bash run.sh --decision to dispatch this subtask');
  const worker = mkspawn('general-purpose', 'x', '[mmt-team-worker] Write a SQL query to list all users');

  assert.equal(sh(sql, ROSTER_PATH), '', 'disabled -> silent');
  const nudge = sh(sql, on);
  assert.match(nudge, /"permissionDecision":"allow"/, 'agy task -> allow nudge');
  assert.match(nudge, /routes to agy/, 'nudge names agy');
  assert.match(nudge, /multi-model-team:delegate/, 'nudge names delegate');
  assert.match(sh(sql, enforce), /"permissionDecision":"deny"/, 'enforce -> deny');
  const cnudge = sh(codex, on);
  assert.match(cnudge, /routes to codex/, 'codex task -> nudge codex');
  assert.match(cnudge, /multi-model-team:codex/, 'codex nudge names codex agent');
  assert.equal(sh(nat, on), '', 'native task -> silent');
  assert.equal(sh(our, on), '', 'our subagent -> silent');
  assert.equal(sh(runsh, on), '', 'already-dispatching -> silent');
  assert.equal(sh(worker, on), '', 'team-worker tag -> silent');
  assert.equal(sh(sql, guardoff), '', 'guard_spawns=false -> silent');
  assert.equal(sh(sql, on, { MMT_PROACTIVE_DISABLE: '1' }), '', 'env DISABLE -> silent');
});

// ── command fan-out guard (UserPromptSubmit: /reasoning, /team) ──────────────
test('command fan-out guard: fires on /reasoning & /team (bare + namespaced), silent otherwise', () => {
  const run = (prompt, env = {}) =>
    runNode(HOOK_FANOUT, { input: JSON.stringify({ prompt }), env }).stdout;

  // /reasoning -> reasoning directive injected.
  const r = run('/reasoning what is the best caching strategy?');
  assert.match(r, /"hookEventName":"UserPromptSubmit"/, '/reasoning -> UserPromptSubmit context');
  assert.match(r, /\/reasoning MANDATORY ENGINE PATH/, '/reasoning -> reasoning directive');
  assert.match(r, /run\.mjs --decision/, 'directive requires the run.mjs relay');
  assert.match(r, /native.{0,3}:.{0,3}false/, 'directive requires native:false on the relay decision');
  assert.match(r, /No dress-up contract/, 'directive states the no-dress-up contract');

  // namespaced /multi-model-team:reasoning -> same.
  assert.match(run('/multi-model-team:reasoning compare X and Y'), /\/reasoning MANDATORY ENGINE PATH/, 'namespaced reasoning -> directive');

  // /team -> team directive.
  const t = run('/team codex:3 build the thing');
  assert.match(t, /\/team MANDATORY ENGINE PATH/, '/team -> team directive');
  assert.match(run('/multi-model-team:team 2:gemini do it'), /\/team MANDATORY ENGINE PATH/, 'namespaced team -> directive');

  // The prompt text is NEVER echoed back (injection hygiene).
  assert.doesNotMatch(r, /caching strategy/, 'prompt text not echoed into directive');

  // Non-matching prompts -> silent.
  assert.equal(run('just a normal question about caching'), '', 'plain prompt -> silent');
  assert.equal(run('/teammate roster please'), '', '/teammate (longer word) -> silent');
  assert.equal(run('/oh-my-claudecode:team do a thing'), '', "another plugin's /team -> silent");
  assert.equal(run('/reasoningx foo'), '', '/reasoningx (longer word) -> silent');

  // Kill switches -> silent.
  assert.equal(run('/reasoning x', { MMT_HOOK_DISABLE: '1' }), '', 'MMT_HOOK_DISABLE -> silent');
  assert.equal(run('/reasoning x', { MMT_COMMAND_GUARD_DISABLE: '1' }), '', 'MMT_COMMAND_GUARD_DISABLE -> silent');

  // NOT gated on proactive.enabled: fires even with the default roster (proactive off).
  assert.match(run('/reasoning x', { MMT_ROSTER: ROSTER_PATH }), /MANDATORY ENGINE PATH/, 'fires regardless of proactive.enabled');
});

test('spawn guard: OMC team worker is nudged-never-denied (even under enforce)', () => {
  const d = tmp('sp-omc-');
  const on = writeRosterVariant(d, 'on.json', (c) => { c.proactive.enabled = true; });
  const enforce = writeRosterVariant(d, 'enforce.json', (c) => { c.proactive.enabled = true; c.proactive.enforce_spawns = true; });
  const sh = (payload, roster) => runNode(HOOK_SPAWN, { input: payload, env: { MMT_ROSTER: roster } }).stdout;

  const omc = JSON.stringify({
    tool_name: 'Task',
    tool_input: {
      subagent_type: 'oh-my-claudecode:executor', team_name: 'fix-ts', name: 'worker-1',
      description: 'write sql',
      prompt: 'You are a TEAM WORKER in team fix-ts. You report to team-lead. Write a SQL query to list all users sorted by signup date.',
    },
  });
  const a = sh(omc, on);
  assert.match(a, /"permissionDecision":"allow"/, 'OMC worker -> allow nudge');
  assert.match(a, /node .*run\.mjs/, 'OMC nudge points at node src/bin/run.mjs');
  assert.doesNotMatch(a, /scripts[\\/]run\.sh/, 'OMC nudge must not reference the deleted scripts/run.sh');
  // The key OMC-aware invariant: NEVER denied, even with enforce_spawns on.
  assert.match(sh(omc, enforce), /"permissionDecision":"allow"/, 'OMC worker under enforce -> still allow (never deny)');
});
