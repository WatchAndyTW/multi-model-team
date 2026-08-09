// roles.test.mjs — the /team ROLE system (oh-my-claudecode parity).
//
// Covers the spec grammar the user types, the OMC vocabulary it resolves against, how a role spec
// coexists with the older cap grammar, and the projection onto caps that keeps existing consumers
// working. Fully offline — nothing here spawns a backend.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  roleCatalog, normalizeRole, looksLikeRoleSpec, parseRoleSpec, splitRoleSpec, describeRoles,
} from '../src/lib/roles.mjs';
import { splitSpec, parseCaps } from '../src/lib/team-spec.mjs';
import { ROSTER } from './helpers.mjs';

const R = { roster: ROSTER };
const CAT = roleCatalog(ROSTER).catalog;

// ── the requested spec, end to end ───────────────────────────────────────────

test('the requested spec staffs exactly the workers it names', () => {
  const s = splitRoleSpec('orch:claude:2;impl:opencode:1,claude:2;review:codex:2 build a REST service', R);
  assert.ok(s, 'must be recognised as a role spec');

  assert.deepEqual(
    s.assignments.map((a) => [a.role, a.backend, a.count]),
    [
      ['planner', 'native', 2],
      ['executor', 'opencode', 1],
      ['executor', 'native', 2],
      ['code-reviewer', 'codex', 2],
    ],
    'orch->planner, impl->executor, review->code-reviewer; one role split across two backends',
  );
  assert.equal(s.task, 'build a REST service', 'spec must not leak into the task');
  assert.equal(s.total, 7);
  assert.deepEqual(s.counts, { native: 4, opencode: 1, codex: 2 });
});

test('only stages with workers are active, in pipeline order', () => {
  const s = splitRoleSpec('orch:claude:2;impl:opencode:1;review:codex:2 x', R);
  assert.deepEqual(s.stages, ['plan', 'exec', 'verify'], 'prd and fix are skipped — nobody staffed them');
  // Ordering is the pipeline's, not the order the user typed.
  const typed = splitRoleSpec('review:codex:2;orch:claude:1 x', R);
  assert.deepEqual(typed.stages, ['plan', 'verify'], 'stage order is canonical, not as-typed');
});

test('a single role runs just its own stage', () => {
  const s = splitRoleSpec('impl:opencode:2 build it', R);
  assert.deepEqual(s.stages, ['exec']);
  assert.equal(s.assignments.length, 1);
  assert.equal(s.task, 'build it');
});

// ── OMC vocabulary ───────────────────────────────────────────────────────────

test('the catalog is OMC\'s: every agent is a role, on its OMC stage', () => {
  const OMC_AGENTS = [
    'analyst', 'architect', 'code-reviewer', 'code-simplifier', 'critic', 'debugger', 'designer',
    'document-specialist', 'executor', 'explore', 'git-master', 'planner', 'qa-tester', 'scientist',
    'security-reviewer', 'test-engineer', 'tracer', 'verifier', 'writer',
  ];
  for (const agent of OMC_AGENTS) {
    assert.ok(CAT[agent], `OMC agent "${agent}" must exist as a role`);
  }
  // Plus the fix-stage role OMC staffs with executor/debugger.
  assert.ok(CAT.fixer, 'fixer covers OMC team-fix');

  // OMC's stage placement for the load-bearing ones.
  assert.equal(CAT.explore.stage, 'plan');
  assert.equal(CAT.planner.stage, 'plan');
  assert.equal(CAT.analyst.stage, 'prd');
  assert.equal(CAT.critic.stage, 'prd');
  assert.equal(CAT.executor.stage, 'exec');
  assert.equal(CAT.verifier.stage, 'verify');
  assert.equal(CAT['security-reviewer'].stage, 'verify');
  assert.equal(CAT.fixer.stage, 'fix');
});

test('default tiers mirror OMC\'s model choice per agent', () => {
  // OMC: planner/analyst/architect/critic/code-reviewer/security-reviewer = opus -> high
  //      executor/verifier/designer/debugger/test-engineer            = sonnet -> standard
  //      explore/writer                                              = haiku  -> cheap
  assert.equal(CAT.planner.tier, 'high');
  assert.equal(CAT['code-reviewer'].tier, 'high');
  assert.equal(CAT['security-reviewer'].tier, 'high');
  assert.equal(CAT.executor.tier, 'standard');
  assert.equal(CAT.verifier.tier, 'standard');
  assert.equal(CAT.explore.tier, 'cheap');
  assert.equal(CAT.writer.tier, 'cheap');
});

test('aliases resolve — including the orch/impl/review shorthand', () => {
  assert.equal(normalizeRole('orch', CAT), 'planner');
  assert.equal(normalizeRole('impl', CAT), 'executor');
  assert.equal(normalizeRole('review', CAT), 'code-reviewer');
  assert.equal(normalizeRole('ORCH', CAT), 'planner', 'case-insensitive');
  assert.equal(normalizeRole('planner', CAT), 'planner', 'canonical name works too');
  assert.equal(normalizeRole('security', CAT), 'security-reviewer');
  assert.equal(normalizeRole('qa', CAT), 'qa-tester');
  assert.equal(normalizeRole('nonsense', CAT), null);
});

test('every specialist is directly nameable, not just the three aliases', () => {
  const s = parseRoleSpec('explore:agy:2;architect:claude:1;security-reviewer:codex:1;designer:opencode:2', R);
  assert.deepEqual(
    s.assignments.map((a) => `${a.role}/${a.backend}`),
    ['explore/agy', 'architect/native', 'security-reviewer/codex', 'designer/opencode'],
  );
  assert.deepEqual(s.stages, ['plan', 'exec', 'verify']);
});

// ── grammar details ──────────────────────────────────────────────────────────

test('count and backend are order-agnostic; a bare backend means one worker', () => {
  assert.equal(parseRoleSpec('impl:opencode:3', R).assignments[0].count, 3);
  assert.equal(parseRoleSpec('impl:3:opencode', R).assignments[0].count, 3, 'count:backend also works');
  assert.equal(parseRoleSpec('impl:opencode', R).assignments[0].count, 1, 'bare backend -> 1');
});

test('a role with no backend gets one worker on the default backend', () => {
  const a = parseRoleSpec('review', R).assignments[0];
  assert.equal(a.role, 'code-reviewer');
  assert.equal(a.backend, 'native');
  assert.equal(a.count, 1);
});

test('a native assignment may pin its own tier by naming a Claude model', () => {
  assert.equal(parseRoleSpec('impl:opus:1', R).assignments[0].tier, 'high', 'opus -> high');
  assert.equal(parseRoleSpec('impl:haiku:1', R).assignments[0].tier, 'cheap');
  // A CLI backend keeps the ROLE's tier; the per-backend model ladder resolves what `high` means
  // there, so `high` on agy is agy's strongest model, not Opus.
  assert.equal(parseRoleSpec('review:codex:1', R).assignments[0].tier, 'high');
});

test('counts clamp, and a zero count drops the assignment with a note', () => {
  assert.equal(parseRoleSpec('impl:opencode:99', R).assignments[0].count, 16, 'clamped to 16');
  const zero = parseRoleSpec('impl:opencode:0', R);
  assert.equal(zero.assignments.length, 0);
  assert.match(zero.note, /0/);
});

test('unknown roles and backends are reported, not silently accepted', () => {
  const badRole = parseRoleSpec('wizard:claude:2;impl:opencode:1', R);
  assert.deepEqual(badRole.assignments.map((a) => a.role), ['executor'], 'good group survives');
  assert.match(badRole.note, /unknown role 'wizard'/);

  const badBackend = parseRoleSpec('impl:llama:2', R);
  assert.equal(badBackend.assignments.length, 0);
  assert.match(badBackend.note, /no known backend/);
});

test('whitespace around separators is tolerated', () => {
  const s = splitRoleSpec('orch:claude:1; impl:opencode:2 do the thing', R);
  assert.deepEqual(s.assignments.map((a) => a.role), ['planner', 'executor']);
  assert.equal(s.task, 'do the thing');
});

test('assignments carry the role description for the worker brief', () => {
  // The Workflow engine has no filesystem access, so `desc` must ride in the parsed args or a role
  // would only be a scheduling label and every worker would behave identically.
  const a = parseRoleSpec('review:codex:1', R).assignments[0];
  assert.ok(a.desc && a.desc.length > 0, 'desc must be present');
  assert.equal(a.desc, CAT['code-reviewer'].desc);
});

// ── mode flags ───────────────────────────────────────────────────────────────

test('--writable is peeled on either side of a role spec', () => {
  const before = splitRoleSpec('--writable orch:claude:1;impl:codex:2 ship it', R);
  assert.equal(before.writable, true);
  assert.equal(before.task, 'ship it');
  assert.equal(before.assignments.length, 2);

  const after = splitRoleSpec('orch:claude:1;impl:codex:2 --writable ship it', R);
  assert.equal(after.writable, true);
  assert.equal(after.task, 'ship it');
});

// ── coexistence with the cap grammar ─────────────────────────────────────────

test('role and cap grammars are told apart, not guessed', () => {
  assert.equal(looksLikeRoleSpec('orch:claude:2 x', CAT), true);
  assert.equal(looksLikeRoleSpec('5:gemini,2:claude x', CAT), false, 'cap spec starts with a number');
  assert.equal(looksLikeRoleSpec('gemini:3 x', CAT), false, 'a backend word is not a role');
  assert.equal(looksLikeRoleSpec('fix the bug', CAT), false, 'no colon -> not a spec');
});

test('splitSpec routes a role spec to roles and a cap spec to caps', () => {
  const roles = splitSpec('orch:claude:2;impl:opencode:1 build it', R);
  assert.equal(roles.source, 'roles');
  assert.ok(roles.roles, 'the parsed role spec is attached');
  assert.equal(roles.task, 'build it');

  const caps = splitSpec('5:gemini,2:claude build it', R);
  assert.equal(caps.source, 'spec');
  assert.equal(caps.roles, undefined, 'a cap spec produces no roles');
  assert.equal(caps.caps.gemini, 5);
  assert.equal(caps.task, 'build it');
});

test('a role spec still yields caps, so cap-only consumers keep working', () => {
  // The workflow's CAPS ladder and --gemini-cap only understand caps; a role spec must project
  // onto them rather than leaving them at defaults.
  const { caps } = splitSpec('orch:claude:2;impl:opencode:1,claude:2;review:codex:2 x', R);
  assert.equal(caps.claude, 4, '2 planners + 2 executors on native');
  assert.equal(caps.opencode, 1);
  assert.equal(caps.codex, 2);
  assert.equal(caps.gemini, 0, 'agy was not staffed');
  assert.equal(caps.total, 7);
  assert.equal(caps.source, 'spec', 'a role spec IS an explicit assignment');
});

test('the legacy cap grammar is untouched by the role layer', () => {
  assert.equal(parseCaps('5:gemini,2:claude').gemini, 5);
  assert.equal(parseCaps('3:agy,2:native').claude, 2);
  assert.equal(parseCaps('').source, 'default');
  const plain = splitSpec('do a thing with 3 steps: x', R);
  assert.equal(plain.source, 'default');
  assert.equal(plain.task, 'do a thing with 3 steps: x', '"N steps:" is still not a spec');
});

// ── config-driven ────────────────────────────────────────────────────────────

test('the catalog comes from the roster, so it is tunable without code', () => {
  const clone = JSON.parse(JSON.stringify(ROSTER));
  clone.roles.catalog['pen-tester'] = { stage: 'verify', tier: 'high', aliases: ['pentest'], desc: 'Break it.' };
  const s = parseRoleSpec('pentest:codex:2', { roster: clone });
  assert.equal(s.assignments[0].role, 'pen-tester');
  assert.equal(s.assignments[0].stage, 'verify');
  assert.equal(s.assignments[0].tier, 'high');
});

test('a missing roles section degrades to the built-in catalog instead of failing', () => {
  const bare = parseRoleSpec('orch:claude:1;impl:codex:2;review:codex:1', { roster: {} });
  assert.deepEqual(bare.assignments.map((a) => a.role), ['planner', 'executor', 'code-reviewer']);
});

test('describeRoles lists the catalog grouped by stage', () => {
  const out = describeRoles(ROSTER);
  assert.match(out, /plan:/);
  assert.match(out, /planner/);
  assert.match(out, /orch/, 'aliases are shown');
  assert.match(out, /verify:/);
  assert.match(out, /security-reviewer/);
});
