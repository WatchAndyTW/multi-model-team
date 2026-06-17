// hooks.test.mjs — hook unit blocks (proactive, spawn-route guard, command fan-out guard).
// Each hook is one node process; we drive it via stdin payloads. Roster is resolved from
// <cwd>/.mmt/roster.json, so each variant runs in its own temp project dir (makeProjectRoster).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOOK_PROACTIVE, HOOK_SPAWN, HOOK_FANOUT,
  makeProjectRoster, runNode,
} from './helpers.mjs';

// ── proactive route (UserPromptSubmit) ───────────────────────────────────────
test('proactive hook: off->silent, on+agy->nudge, opus/slash/cap/env->silent', () => {
  // Roster is resolved from <cwd>/.mmt/roster.json; each variant gets its own project dir.
  const offDir = makeProjectRoster('pr-off-');                                                   // proactive disabled (default)
  const onDir = makeProjectRoster('pr-on-', (c) => { c.proactive.enabled = true; });
  const capDir = makeProjectRoster('pr-cap-', (c) => { c.proactive.enabled = true; c.proactive.max_chars = 10; });
  const sql = JSON.stringify({ prompt: 'Write a SQL query to join users and orders tables' });
  const run = (payload, cwd, env = {}) => runNode(HOOK_PROACTIVE, { input: payload, cwd, env }).stdout;

  assert.equal(run(sql, offDir), '', 'disabled -> silent');
  const nudge = run(sql, onDir);
  assert.match(nudge, /routes to agy/, 'enabled+agy -> nudge');
  assert.match(nudge, /multi-model-team:agy/, 'nudge names agy agent');
  assert.equal(run(JSON.stringify({ prompt: 'Reverse engineer the IL2CPP dump and extract protobuf' }), onDir), '', 'opus task -> silent');
  assert.equal(run(JSON.stringify({ prompt: '/team build a thing' }), onDir), '', 'slash command -> silent');
  assert.equal(run(sql, capDir), '', 'max_chars cap -> silent');
  assert.equal(run(sql, onDir, { MMT_PROACTIVE_DISABLE: '1' }), '', 'env DISABLE -> silent');
});

// ── spawn-route guard (PreToolUse Task/Agent) ────────────────────────────────
function mkspawn(sub, desc, prompt) {
  return JSON.stringify({ tool_name: 'Task', tool_input: { subagent_type: sub, description: desc, prompt } });
}

test('spawn guard: agy nudge / enforce-deny / codex / exemptions', () => {
  // Roster resolved from <cwd>/.mmt/roster.json; each variant gets its own project dir.
  const offDir = makeProjectRoster('sp-off-');                                                          // proactive disabled (default)
  const onDir = makeProjectRoster('sp-on-', (c) => { c.proactive.enabled = true; });
  const enforceDir = makeProjectRoster('sp-enf-', (c) => { c.proactive.enabled = true; c.proactive.enforce_spawns = true; });
  const guardoffDir = makeProjectRoster('sp-go-', (c) => { c.proactive.enabled = true; c.proactive.guard_spawns = false; });
  const sh = (payload, cwd, env = {}) => runNode(HOOK_SPAWN, { input: payload, cwd, env }).stdout;

  const sql = mkspawn('general-purpose', 'write sql', 'Write a SQL query to list all users sorted by signup date');
  const codex = mkspawn('general-purpose', 'review', 'Review this diff for correctness bugs and regressions, then write a regression test suite');
  const nat = mkspawn('general-purpose', 're', 'Reverse engineer the IL2CPP global-metadata and reconstruct protobuf schemas via disassembly');
  const our = mkspawn('multi-model-team:agy', 'x', 'Write a SQL query to list all users');
  const runsh = mkspawn('general-purpose', 'x', 'bash run.sh --decision to dispatch this subtask');
  const worker = mkspawn('general-purpose', 'x', '[mmt-team-worker] Write a SQL query to list all users');

  assert.equal(sh(sql, offDir), '', 'disabled -> silent');
  const nudge = sh(sql, onDir);
  assert.match(nudge, /"permissionDecision":"allow"/, 'agy task -> allow nudge');
  assert.match(nudge, /routes to agy/, 'nudge names agy');
  assert.match(nudge, /multi-model-team:agy/, 'nudge names agy');
  assert.match(sh(sql, enforceDir), /"permissionDecision":"deny"/, 'enforce -> deny');
  const cnudge = sh(codex, onDir);
  assert.match(cnudge, /routes to codex/, 'codex task -> nudge codex');
  assert.match(cnudge, /multi-model-team:codex/, 'codex nudge names codex agent');
  assert.equal(sh(nat, onDir), '', 'native task -> silent');
  assert.equal(sh(our, onDir), '', 'our subagent -> silent');
  assert.equal(sh(runsh, onDir), '', 'already-dispatching -> silent');
  assert.equal(sh(worker, onDir), '', 'team-worker tag -> silent');
  assert.equal(sh(sql, guardoffDir), '', 'guard_spawns=false -> silent');
  assert.equal(sh(sql, onDir, { MMT_PROACTIVE_DISABLE: '1' }), '', 'env DISABLE -> silent');
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

  // NOT gated on proactive.enabled: the guard never reads the roster, so it fires regardless.
  assert.match(run('/reasoning x'), /MANDATORY ENGINE PATH/, 'fires regardless of proactive.enabled');
});

test('spawn guard: OMC team worker is nudged-never-denied (even under enforce)', () => {
  const onDir = makeProjectRoster('sp-omc-on-', (c) => { c.proactive.enabled = true; });
  const enforceDir = makeProjectRoster('sp-omc-enf-', (c) => { c.proactive.enabled = true; c.proactive.enforce_spawns = true; });
  const sh = (payload, cwd) => runNode(HOOK_SPAWN, { input: payload, cwd }).stdout;

  const omc = JSON.stringify({
    tool_name: 'Task',
    tool_input: {
      subagent_type: 'oh-my-claudecode:executor', team_name: 'fix-ts', name: 'worker-1',
      description: 'write sql',
      prompt: 'You are a TEAM WORKER in team fix-ts. You report to team-lead. Write a SQL query to list all users sorted by signup date.',
    },
  });
  const a = sh(omc, onDir);
  assert.match(a, /"permissionDecision":"allow"/, 'OMC worker -> allow nudge');
  assert.match(a, /node .*run\.mjs/, 'OMC nudge points at node src/bin/run.mjs');
  assert.doesNotMatch(a, /scripts[\\/]run\.sh/, 'OMC nudge must not reference the deleted scripts/run.sh');
  // The key OMC-aware invariant: NEVER denied, even with enforce_spawns on.
  assert.match(sh(omc, enforceDir), /"permissionDecision":"allow"/, 'OMC worker under enforce -> still allow (never deny)');
});
