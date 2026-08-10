// roles.test.mjs — the /team ROLE system (oh-my-claudecode parity).
//
// Covers the spec grammar the user types, the OMC vocabulary it resolves against, how a role spec
// coexists with the older cap grammar, and the projection onto caps that keeps existing consumers
// working. Fully offline — nothing here spawns a backend.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  roleCatalog, normalizeRole, looksLikeRoleSpec, parseRoleSpec, splitRoleSpec, describeRoles,
  resolveStaffing, staffingFromBackends, backendWords,
} from '../src/lib/roles.mjs';
import { splitSpec, parseCaps } from '../src/lib/team-spec.mjs';
import { ROSTER } from './helpers.mjs';

const R = { roster: ROSTER };
const CAT = roleCatalog(ROSTER).catalog;

/** `role/backend[xN]` for each assignment — the compact shape most staffing assertions want. */
const shape = (list) => list.map((a) => `${a.role}/${a.backend}x${a.count}`);

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
  // One role -> just its own stage.
  assert.deepEqual(splitRoleSpec('impl:opencode:2 build it', R).stages, ['exec']);
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

  // OMC's stage placement, and its per-agent model choice as the role's default tier
  // (opus -> high, sonnet -> standard, haiku -> cheap).
  const parity = [
    ['explore', 'plan', 'cheap'],
    ['planner', 'plan', 'high'],
    ['analyst', 'prd', 'high'],
    ['critic', 'prd', 'high'],
    ['executor', 'exec', 'standard'],
    ['writer', 'exec', 'cheap'],
    ['verifier', 'verify', 'standard'],
    ['code-reviewer', 'verify', 'high'],
    ['security-reviewer', 'verify', 'high'],
    ['fixer', 'fix', 'standard'],
  ];
  for (const [role, stage, tier] of parity) {
    assert.equal(CAT[role].stage, stage, `${role} belongs to the ${stage} stage`);
    assert.equal(CAT[role].tier, tier, `${role} defaults to the ${tier} tier`);
  }
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

test('BOTH grammars produce a resolved staffing table — there is no second mechanism', () => {
  const roles = splitSpec('orch:claude:2;impl:opencode:1 build it', R);
  assert.equal(roles.source, 'roles');
  assert.ok(Array.isArray(roles.roles.assignments), 'staffing attached');
  assert.equal(roles.task, 'build it');

  const caps = splitSpec('5:gemini,2:claude build it', R);
  assert.equal(caps.source, 'spec');
  assert.ok(Array.isArray(caps.roles.assignments), 'a backend-only spec resolves to staffing too');
  assert.equal(caps.caps.gemini, 5);
  assert.equal(caps.task, 'build it');
});

test('a spec still yields caps, so cap-only consumers keep working', () => {
  // `--gemini-cap` and the scripted path only understand caps; the staffing must project back onto
  // them. Caps count WORKERS only — a reviewer is the pipeline's verify loop, not parallel capacity.
  const { caps } = splitSpec('orch:claude:2;impl:opencode:1,claude:2;review:codex:2 x', R);
  assert.equal(caps.claude, 4, '2 planners + 2 executors on native');
  assert.equal(caps.opencode, 1);
  assert.equal(caps.codex, 0, 'codex reviews; it is not a parallel subtask worker');
  assert.equal(caps.gemini, 0, 'agy was not staffed');
  assert.equal(caps.total, 5);
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

// ── staffing resolution: the ONE place a job gets a backend ──────────────────

test('an unstaffed job falls back to Claude at its own tier — never to a CLI', () => {
  const s = resolveStaffing(parseRoleSpec('impl:opencode:2', R), R);
  assert.deepEqual(shape(s.workers), ['executor/opencodex2'], 'only what was staffed does the work');
  assert.deepEqual(shape(s.verifiers), ['verifier/nativex1'], 'nobody staffed review -> Claude');
  assert.deepEqual(s.defaulted, ['verifier']);
  // The tier is the ROLE's, which is what selects the Claude model.
  assert.equal(s.verifiers[0].tier, CAT.verifier.tier);
});

test('nothing staffed at all -> the whole pipeline is Claude', () => {
  const s = resolveStaffing([], R);
  assert.deepEqual(s.backends, ['native'], 'no CLI is ever auto-staffed');
  assert.deepEqual(s.defaulted, ['executor', 'verifier', 'fixer']);
  assert.deepEqual(shape(s.workers), ['executor/nativex4']);
});

test('the fixer follows the executor when only the executor was staffed', () => {
  const s = resolveStaffing(parseRoleSpec('impl:opencode:1,claude:2', R), R);
  assert.deepEqual(shape(s.fixers), ['fixer/opencodex1', 'fixer/nativex2'], 'same backends as the executors');
  assert.ok(s.fixers.every((f) => f.source === 'follows'));
  assert.ok(!s.defaulted.includes('fixer'), 'following is not defaulting');
});

test('an explicit fixer overrides the share', () => {
  const s = resolveStaffing(parseRoleSpec('impl:opencode:2;fix:claude:1', R), R);
  assert.deepEqual(shape(s.fixers), ['fixer/nativex1']);
  assert.equal(s.fixers[0].source, 'spec');
});

test('backends named without roles become the EXECUTORS, and the fixer follows them', () => {
  const s = staffingFromBackends({ agy: 5, native: 2 }, R);
  assert.deepEqual(shape(s.workers), ['executor/agyx5', 'executor/nativex2']);
  assert.deepEqual(shape(s.fixers), ['fixer/agyx5', 'fixer/nativex2']);
  assert.deepEqual(shape(s.verifiers), ['verifier/nativex1'], 'review still falls back to Claude');
});

test('a core job is satisfied by ANY role on its stage, not just the canonical one', () => {
  // Staffing `review:codex:2` IS staffing the review job — it must not ALSO get a defaulted Claude
  // verifier reviewing everything a second time.
  const s = resolveStaffing(parseRoleSpec('impl:agy:2;review:codex:2', R), R);
  assert.deepEqual(shape(s.verifiers), ['code-reviewer/codexx2']);
  assert.deepEqual(s.defaulted, [], 'every stage was covered');

  // Same on the exec side: a designer staffs the work, so no phantom Claude executors appear.
  const d = resolveStaffing(parseRoleSpec('designer:agy:2', R), R);
  assert.deepEqual(shape(d.workers), ['designer/agyx2']);
  assert.deepEqual(shape(d.fixers), ['fixer/agyx2'], 'the fix follows whoever did the work');
});

test('verify and fix staff the pipeline loop; they are never decomposed into subtasks', () => {
  const s = resolveStaffing(parseRoleSpec('orch:claude:2;impl:opencode:1;review:codex:2', R), R);
  assert.deepEqual(s.stages, ['plan', 'exec'], 'only worker stages are planned');
  assert.ok(s.workers.every((a) => a.stage !== 'verify' && a.stage !== 'fix'));
  assert.deepEqual(s.stageOrder, ['plan', 'prd', 'exec', 'verify', 'fix'], 'full order for consumers with no roster');
});

test('several reviewers are deduped per (role, backend) — a count bounds parallelism', () => {
  const s = resolveStaffing(parseRoleSpec('review:codex:2;security:agy:1', R), R);
  assert.deepEqual(shape(s.verifiers), ['code-reviewer/codexx2', 'security-reviewer/agyx1']);
});

test('a disabled backend cannot be staffed — the switch beats the spec', () => {
  const clone = JSON.parse(JSON.stringify(ROSTER));
  clone.backends.opencode.enabled = false;
  const s = resolveStaffing(parseRoleSpec('impl:opencode:2', { roster: clone }), { roster: clone });
  assert.match(s.note, /opencode.*disabled/, 'says why it was skipped');
  assert.deepEqual(shape(s.workers), ['executor/nativex4'], 'the job falls back to Claude, not to another CLI');
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

test('a backend added to the roster is staffable with NO code change (both grammars)', () => {
  // The docs promise that adding a backend means an invoker in backends.mjs + `enabled` — nothing
  // else. That was false: the backend word also had to be added by hand to roles.mjs, team-spec.mjs
  // and workflows/team.mjs, or it was invisible to /team. The vocabulary is now derived from the
  // roster, so a brand-new key works everywhere at once.
  const clone = JSON.parse(JSON.stringify(ROSTER));
  clone.backends.futurecli = { enabled: true, kind: 'grok', cmd: 'futurecli', models: {} };
  const O = { roster: clone };

  // 1 · the ROLE grammar names it directly
  const byRole = parseRoleSpec('impl:futurecli:2', O);
  assert.deepEqual(shape(byRole.assignments), ['executor/futureclix2']);

  // 2 · it is part of the shared backend vocabulary
  assert.ok(backendWords(clone).includes('futurecli'));

  // 3 · the BACKEND-ONLY grammar sees it too — spec boundary and all
  const byCap = splitSpec('3:futurecli build a thing', O);
  assert.equal(byCap.task, 'build a thing', 'the spec must not leak into the task');
  assert.equal(byCap.caps.futurecli, 3, 'counted under its own key');
  assert.deepEqual(shape(byCap.roles.workers), ['executor/futureclix3'], 'staffed as the executor');

  // 4 · and disabling it is still honoured
  clone.backends.futurecli.enabled = false;
  const off = resolveStaffing(parseRoleSpec('impl:futurecli:2', O), O);
  assert.match(off.note, /futurecli.*disabled/);
  assert.deepEqual(off.backends, ['native'], 'falls back to Claude, not to another CLI');
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
