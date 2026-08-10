// team-staffing.test.mjs — the /team staffing contract, exercised against the REAL workflow.
//
// workflows/team.mjs runs under the Workflow runtime, so it can't be imported: it uses top-level
// `return` and receives agent()/parallel()/log()/phase() as injected globals. We compile the actual
// file and inject a stub runtime, which makes this a behavioural test of the shipped script rather
// than string-matching over its source. Fully offline — agent() is a stub, so no backend is spawned.
//
// What it pins (the rules the staffing rebuild is FOR):
//   · the user's spec is honoured exactly; an unstaffed (role, backend) pair is DROPPED, never
//     silently re-homed onto another backend;
//   · every job nobody staffed falls back to Claude at that role's tier — never to a CLI;
//   · the fixer shares the executor's backend, so a fix goes back to whoever did the work;
//   · verify and fix are the pipeline's own loop, staffed by role, not decomposed into subtasks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, ROSTER } from './helpers.mjs';
import { teamConfig } from '../src/lib/config.mjs';
import { splitSpec } from '../src/lib/team-spec.mjs';

const SRC = readFileSync(join(ROOT, 'workflows', 'team.mjs'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const R = { roster: ROSTER };

/**
 * Run the real workflow with a stub runtime.
 * @param {string} rawInput   what the user typed after `/team`
 * @param {Array}  subtasks   what the decompose agent "returns"
 * @param {{failLabels?:string[]}} [opts]
 */
async function runTeam(rawInput, subtasks, opts = {}) {
  const split = splitSpec(rawInput, R);
  const calls = [];
  const logs = [];
  const failing = (label) => (opts.failLabels || []).some((f) => label.includes(f));

  const agent = async (prompt, o = {}) => {
    const label = o.label || '';
    calls.push({ label, model: o.model || '', phase: o.phase || '', prompt });
    if (label === 'decompose') return { subtasks };
    if (label === 'synthesize') return 'FINAL';
    const props = (o.schema && o.schema.properties) || {};
    // A CLI relay reports {stdout, backend_ran}; a native verifier reports {pass, reason}.
    if (props.backend_ran) {
      return { stdout: failing(label) ? 'FAIL\nnot done\nfinish it' : 'PASS\nlooks right',
               backend_ran: true, status_state: 'done', out_chars: 9 };
    }
    if (props.pass) return { pass: !failing(label), reason: 'stub', fix_hint: failing(label) ? 'finish it' : '' };
    return `result of ${label}`;
  };
  const parallel = async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));

  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'workflow', SRC);
  const out = await fn(
    { task: split.task, pluginRoot: ROOT, roles: split.roles, teamConfig: teamConfig(ROSTER) },
    agent, parallel, null, (m) => logs.push(m), () => {},
    { total: null, spent: () => 0, remaining: () => Infinity }, null,
  );
  return { out, calls, logs };
}

const sub = (label, backend, role, extra = {}) => ({
  label, task: `do ${label}`, backend, role, tier: 'standard', deps: [], verify: 'x', ...extra,
});

// ── the requested spec, end to end through the pipeline ──────────────────────

test('the staffed spec is honoured exactly, and stages run in pipeline order', async () => {
  const { out } = await runTeam(
    'orch:claude:2;impl:opencode:1,claude:2;review:codex:2 build a REST service',
    [
      sub('plan-api', 'native', 'planner', { tier: 'high' }),
      sub('impl-oc', 'opencode', 'executor', { deps: ['plan-api'] }),
      sub('impl-n1', 'native', 'executor', { deps: ['plan-api'] }),
      sub('impl-n2', 'native', 'executor', { deps: ['plan-api'] }),
    ],
  );
  assert.deepEqual(out.counts.byStage, { plan: 1, exec: 3 }, 'plan runs before exec');
  assert.deepEqual(out.counts.ranOn, { native: 3, opencode: 1 });
  assert.equal(out.verifier, 'code-reviewer/codex', 'codex reviews, as staffed');
  assert.equal(out.counts.failed, 0);
  // A later-stage subtask must wait for the whole earlier stage — expressed as deps.
  assert.deepEqual(out.plan.find((p) => p.label === 'impl-oc').deps, ['plan-api']);
});

test('an unstaffed (role, backend) pair is DROPPED, never re-homed onto another backend', async () => {
  const { out, logs } = await runTeam('impl:opencode:1 build it', [
    sub('ok', 'opencode', 'executor'),
    sub('rogue', 'codex', 'executor'),      // codex was never staffed
  ]);
  assert.deepEqual(out.plan.map((p) => p.label), ['ok'], 'the rogue subtask did not run');
  assert.ok(logs.some((l) => /rogue.*not staffed/.test(l)), 'and it says so out loud');
  assert.equal(out.counts.ranOn.native, undefined, 'it must NOT quietly become a native subtask');
});

test('over-count subtasks are dropped at the staffed worker limit', async () => {
  const { out, logs } = await runTeam('impl:claude:2 build it', [
    sub('a', 'native', 'executor'), sub('b', 'native', 'executor'), sub('c', 'native', 'executor'),
  ]);
  assert.deepEqual(out.plan.map((p) => p.label), ['a', 'b'], 'the third exceeded 2 staffed workers');
  assert.ok(logs.some((l) => /'c'.*staffed worker/.test(l)));
});

// ── the fallbacks ────────────────────────────────────────────────────────────

test('with no spec the whole pipeline runs on Claude — nothing lands on a CLI', async () => {
  const { out, logs } = await runTeam('fix the login bug', [
    sub('a', 'native', 'executor'),
    sub('b', 'agy', 'executor'),           // not staffed: no spec means no CLI
  ]);
  assert.deepEqual(out.counts.ranOn, { native: 1 });
  assert.equal(out.verifier, 'verifier/native', 'review falls back to Claude too');
  assert.deepEqual(out.staffing.defaulted, ['executor', 'verifier', 'fixer']);
  assert.ok(logs.some((l) => /'b'.*not staffed/.test(l)));
});

test("an unstaffed role's tier picks the Claude model — that is what a tier is for", async () => {
  const { calls } = await runTeam('fix it', [sub('a', 'native', 'executor')]);
  // verifier's catalog tier is `standard` -> sonnet via defaults.native_models.
  const verify = calls.find((c) => c.phase === 'Verify');
  assert.equal(verify.model, 'sonnet');
  // planner is `high` -> opus, proving the tier is read per role rather than fixed per stage.
  const { calls: c2 } = await runTeam('orch:claude:1 plan it', [sub('p', 'native', 'planner', { tier: 'high' })]);
  assert.equal(c2.find((c) => c.label.includes('planner:p')).model, 'opus');
});

test('a role staffed at TWO tiers keeps both — the pin is not collapsed to one', async () => {
  // `impl:opus:1,haiku:2` staffs three executors on native at two different tiers. Keying the tier
  // by ROLE let the last assignment win, so the opus worker was silently downgraded to haiku. Slots
  // are consumed in spec order, so the first executor subtask must run on opus and the rest on haiku.
  const { calls } = await runTeam('impl:opus:1,haiku:2 build it', [
    sub('a', 'native', 'executor'), sub('b', 'native', 'executor'), sub('c', 'native', 'executor'),
  ]);
  const models = calls.filter((c) => c.phase === 'Dispatch').map((c) => c.model);
  assert.deepEqual(models, ['opus', 'haiku', 'haiku'], 'one opus worker + two haiku workers, as staffed');
});

test('the fixer shares the executor backend: a fix goes back to whoever did the work', async () => {
  const { out, calls } = await runTeam('impl:opencode:2 ship it', [sub('work', 'opencode', 'executor')],
    { failLabels: ['verifier:work'] });
  assert.equal(out.results[0].attempts, 2, 'one bounded fix attempt');
  const fix = calls.find((c) => c.phase === 'Fix');
  assert.ok(fix.label.startsWith('opencode:'), `fix ran on opencode, got ${fix.label}`);
  assert.deepEqual(out.staffing.fixers.map((f) => `${f.backend}:${f.source}`), ['opencode:follows']);
});

test('an explicit fixer redirects the fix off the executor backend', async () => {
  const { out, calls } = await runTeam('impl:opencode:2;fix:claude:1 ship it', [sub('work', 'opencode', 'executor')],
    { failLabels: ['verifier:work'] });
  const fix = calls.find((c) => c.phase === 'Fix');
  assert.ok(fix.label.startsWith('native:'), `fix ran on Claude, got ${fix.label}`);
  assert.deepEqual(out.staffing.fixers.map((f) => `${f.backend}:${f.source}`), ['native:spec']);
});

// ── verify/fix are the pipeline's loop, not planned work ─────────────────────

test('every staffed reviewer reviews each result, and all must pass', async () => {
  const { out, calls } = await runTeam('impl:agy:1;review:codex:1;security:claude:1 harden it',
    [sub('w', 'agy', 'executor')]);
  const reviewers = calls.filter((c) => c.phase === 'Verify').map((c) => c.label);
  assert.deepEqual(reviewers, ['codex:code-reviewer:w', 'native:security-reviewer:w']);
  assert.equal(out.counts.verified, 1);

  // One reviewer failing fails the result, even though the other passed.
  const { out: bad } = await runTeam('impl:agy:1;review:codex:1;security:claude:1 harden it',
    [sub('w', 'agy', 'executor')], { failLabels: ['security-reviewer'] });
  assert.equal(bad.counts.verified, 0);
});

test("a reviewer's role brief reaches it, so the role changes what it checks", async () => {
  const { calls } = await runTeam('impl:agy:1;security:claude:1 harden it', [sub('w', 'agy', 'executor')]);
  const review = calls.find((c) => c.phase === 'Verify');
  assert.match(review.prompt, /acting in the "security-reviewer" role/);
  assert.match(review.prompt, /vulnerabilities/, 'the roster desc rides along, not a generic brief');
});

test('the workflow is self-sufficient: no args.roles still means the Claude default staffing', async () => {
  // A caller that forgets to pass staffing must not fall back to an auto-assigned CLI panel.
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'workflow', SRC);
  const out = await fn(
    { task: 'do a thing', pluginRoot: ROOT },
    async (p, o = {}) => (o.label === 'decompose'
      ? { subtasks: [sub('a', 'native', 'executor'), sub('b', 'codex', 'executor')] }
      : ((o.schema && o.schema.properties && o.schema.properties.pass) ? { pass: true, reason: 'ok' } : 'r')),
    async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    null, () => {}, () => {}, { total: null, spent: () => 0, remaining: () => Infinity }, null,
  );
  assert.deepEqual(out.backends, ['native']);
  assert.deepEqual(out.counts.ranOn, { native: 1 }, 'the codex subtask was dropped, not dispatched');
});
