// backend-control.test.mjs — enable/disable a backend, and model selection.
//
// Covers the three capabilities added alongside the opencode backend:
//   1. a backend can be switched off (roster `enabled:false` OR an env kill switch) and every
//      surface honours it — the registry, the router, and run.mjs's chain walk;
//   2. tier -> model resolution beyond the original cheap/standard pair, with aliases, per-shell
//      overrides, and the "no model map means pass no flag" contract opencode relies on;
//   3. opencode and grok are wired as real backends rather than config stubs.
//
// Fully offline: no test here may spawn a real CLI. Anything that walks the fallback chain uses
// disableAllBackends() so a live binary is never reached.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backend, backendNames, enabledBackends, disabledBackends, isBackendEnabled,
  isNativeBackend, filterEnabled, backendDisabledByEnv, nativeModels, nativeModelForTier,
} from '../src/lib/config.mjs';
import { modelForTier, chooseModel } from '../src/lib/backends.mjs';
import { parseRoleSpec } from '../src/lib/roles.mjs';
import { decide } from '../src/lib/router.mjs';
import { validateRoster } from '../src/lib/validate-config.mjs';
import {
  ROSTER, TAGS_PATH, BIN_RUN, BIN_ROUTE, tmp, writeRosterVariant, runNode, disableAllBackends,
} from './helpers.mjs';

/** Deep-clone the shipped roster so a test can mutate it freely. */
const clone = () => JSON.parse(JSON.stringify(ROSTER));

/** Run the router against a roster clone. */
const route = (task, roster, preset) => decide({ task, roster, tagsPath: TAGS_PATH, preset });

/** Run a body with env vars set, always restoring them (even on throw). */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── registry ─────────────────────────────────────────────────────────────────

test('backend registry: names, enabled/disabled split, native is never disable-able', () => {
  const names = backendNames(ROSTER);
  assert.ok(['agy', 'codex', 'opencode', 'grok'].every((n) => names.includes(n)));
  assert.ok(!names.some((n) => n.startsWith('_')), 'doc keys must not be reported as backends');

  assert.deepEqual(enabledBackends(ROSTER).sort(), ['agy', 'codex', 'grok', 'opencode']);
  assert.deepEqual(disabledBackends(ROSTER), []);

  // native is always available — it is the guaranteed final fallback.
  assert.equal(isNativeBackend('native'), true);
  assert.equal(isNativeBackend('native:opus'), true);
  assert.equal(isBackendEnabled(ROSTER, 'native'), true);
  assert.equal(backendDisabledByEnv('native'), false);
  assert.equal(isBackendEnabled(ROSTER, 'nope'), false, 'undeclared backend is not enabled');
});

test('roster enabled:false disables a backend and is reported as reason "roster"', () => {
  const c = clone();
  c.backends.codex.enabled = false;
  assert.equal(isBackendEnabled(c, 'codex'), false);
  assert.equal(backend(c, 'codex').enabled, false);
  assert.equal(backend(c, 'codex').roster_enabled, false);
  assert.deepEqual(disabledBackends(c), [{ name: 'codex', reason: 'roster' }]);
  assert.deepEqual(enabledBackends(c).sort(), ['agy', 'grok', 'opencode']);
});

test('MMT_DISABLE_BACKENDS turns backends off for the shell, reported as reason "env"', () => {
  withEnv({ MMT_DISABLE_BACKENDS: 'codex, AGY' }, () => {   // spacing + case must not matter
    assert.equal(isBackendEnabled(ROSTER, 'codex'), false);
    assert.equal(isBackendEnabled(ROSTER, 'agy'), false);
    assert.equal(isBackendEnabled(ROSTER, 'opencode'), true);
    // The roster still says enabled — only the effective verdict flips.
    assert.equal(backend(ROSTER, 'codex').enabled, false);
    assert.equal(backend(ROSTER, 'codex').roster_enabled, true);
    assert.deepEqual(disabledBackends(ROSTER).map((d) => d.reason), ['env', 'env']);
  });
  // …and the switch is scoped to that shell: it must not leak once unset.
  assert.equal(isBackendEnabled(ROSTER, 'codex'), true);
});

test('MMT_ONLY_BACKENDS is an allowlist — everything unnamed is off', () => {
  withEnv({ MMT_ONLY_BACKENDS: 'agy' }, () => {
    assert.deepEqual(enabledBackends(ROSTER), ['agy']);
    assert.equal(isBackendEnabled(ROSTER, 'native'), true, 'native survives an allowlist');
  });
});

test('filterEnabled drops disabled backends but keeps native', () => {
  const c = clone();
  c.backends.agy.enabled = false;
  assert.deepEqual(
    filterEnabled(c, ['agy', 'codex', 'opencode', 'native']),
    ['codex', 'opencode', 'native'],
  );
});

// ── router honours disable ───────────────────────────────────────────────────

test('router SKIPS rules whose backend is disabled and falls through to the next match', () => {
  const task = 'write a CSS button component';
  assert.equal(route(task, ROSTER).backend, 'agy', 'baseline: agy owns this rule');

  const c = clone();
  c.backends.agy.enabled = false;
  const d = route(task, c);
  assert.notEqual(d.backend, 'agy', 'a disabled backend must never be returned as the decision');
  assert.equal(d.backend, 'native');
  // …and it must say WHY, so an unexpected destination is diagnosable.
  assert.ok(
    d.skippedDisabled.some((s) => s.rule === 'standard-coding' && s.backend === 'agy'),
    'the skipped rule is reported in skippedDisabled',
  );
});

test('router falls through to the NEXT ENABLED backend rather than straight to native', () => {
  // A review/test task normally lands on codex. With codex off it must not silently become an
  // agy task either — the rule is skipped and matching continues honestly.
  const task = 'write unit tests for the parser';
  assert.equal(route(task, ROSTER).backend, 'codex');
  const c = clone();
  c.backends.codex.enabled = false;
  const d = route(task, c);
  assert.equal(d.backend, 'native');
  assert.ok(d.skippedDisabled.some((s) => s.backend === 'codex'));
});

test('a preset that biases INTO a disabled backend is undone, not emitted', () => {
  // preset=budget pushes judgment-coding onto agy. With agy off that bias must not produce a
  // decision the executor would refuse.
  const task = 'refactor the existing payment module';
  const c = clone();
  assert.equal(route(task, c, 'budget').backend, 'agy', 'baseline: budget biases to agy');
  c.backends.agy.enabled = false;
  const d = route(task, c, 'budget');
  assert.equal(d.backend, 'native');
  assert.ok(d.skippedDisabled.some((s) => s.rule.includes('preset-budget')));
});

test('router honours the env kill switch too (not just roster enabled)', () => {
  withEnv({ MMT_DISABLE_BACKENDS: 'agy' }, () => {
    assert.notEqual(route('write a CSS button component', ROSTER).backend, 'agy');
  });
});

// ── model selection ──────────────────────────────────────────────────────────

test('modelForTier ladder: exact tier > default_tier > standard > cheap', () => {
  const cfg = { name: 'x', model_tiers: { cheap: 'C', standard: 'S', high: 'H' } };
  assert.equal(modelForTier(cfg, 'cheap'), 'C');
  assert.equal(modelForTier(cfg, 'high'), 'H', 'a `high` tier used to collapse to standard');
  assert.equal(modelForTier(cfg, 'standard'), 'S');
  assert.equal(modelForTier(cfg, 'nonexistent'), 'S', 'unknown tier falls back to standard');

  // default_tier redirects the fallback.
  const withDefault = { name: 'x', default_tier: 'cheap', model_tiers: { cheap: 'C', high: 'H' } };
  assert.equal(modelForTier(withDefault, 'nonexistent'), 'C');

  // A roster naming its tiers something else entirely still resolves to *something*.
  assert.equal(modelForTier({ name: 'x', model_tiers: { weird: 'W' } }, 'standard'), 'W');
});

test('an empty model map resolves to "" — meaning "pass no model flag"', () => {
  // This is the contract opencode depends on: no --model, so the CLI uses its own default.
  assert.equal(modelForTier({ name: 'opencode', model_tiers: {} }, 'standard'), '');
  assert.equal(modelForTier({ name: 'opencode' }, 'cheap'), '');
});

test('model_aliases expand in tiers and as a tier name', () => {
  const cfg = {
    name: 'agy',
    model_tiers: { standard: 'pro' },
    model_aliases: { pro: 'gemini-3.1-pro-low', flash: 'gemini-3.6-flash-low' },
  };
  assert.equal(modelForTier(cfg, 'standard'), 'gemini-3.1-pro-low', 'alias expands inside a tier');
  assert.equal(modelForTier(cfg, 'flash'), 'gemini-3.6-flash-low', 'a tier may name an alias');
});

test('MMT_MODEL_<BACKEND> overrides the tier map for one shell', () => {
  const cfg = { name: 'agy', model_tiers: { standard: 'gemini-3.1-pro-low' }, model_aliases: { flash: 'gemini-3.6-flash-low' } };
  withEnv({ MMT_MODEL_AGY: 'gemini-3.6-flash-high' }, () => {
    assert.equal(modelForTier(cfg, 'standard'), 'gemini-3.6-flash-high');
  });
  withEnv({ MMT_MODEL_AGY: 'flash' }, () => {
    assert.equal(modelForTier(cfg, 'standard'), 'gemini-3.6-flash-low', 'the override may be an alias');
  });
  assert.equal(modelForTier(cfg, 'standard'), 'gemini-3.1-pro-low', 'override does not leak');
});

test('an EXPLICIT model goes through the alias map too', () => {
  // Regression: `--model flash` used to bypass alias expansion and hand agy the literal string
  // "flash", which it rejected with exit 1 — the call then fell through the entire chain to native.
  // Caught live, not by the suite, because nothing exercised an explicit model.
  const cfg = {
    name: 'agy',
    model_tiers: { standard: 'gemini-3.1-pro-low' },
    model_aliases: { flash: 'gemini-3.6-flash-low' },
  };
  assert.equal(chooseModel(cfg, { model: 'flash', tier: 'standard' }), 'gemini-3.6-flash-low');
  // A real id passes through untouched…
  assert.equal(chooseModel(cfg, { model: 'gemini-3.1-pro-high' }), 'gemini-3.1-pro-high');
  // …and with no explicit model it falls back to the tier ladder.
  assert.equal(chooseModel(cfg, { tier: 'standard' }), 'gemini-3.1-pro-low');
});

test('the shipped agy tiers use the ID form from `agy models`', () => {
  // Display strings ("Gemini 3.1 Pro (Low)") also work, but ids carry no spaces or parens, so they
  // survive any command line. Verified live: `--model gemini-3.6-flash-low` answers.
  const tiers = backend(ROSTER, 'agy').model_tiers;
  for (const [tier, model] of Object.entries(tiers)) {
    assert.match(model, /^[a-z0-9.-]+$/, `agy tier ${tier} should be an id, got "${model}"`);
  }
  assert.ok(tiers.high, 'agy declares a high tier');
});

test('native tier -> model comes from one configurable map', () => {
  assert.equal(nativeModelForTier(ROSTER, 'cheap'), 'haiku');
  assert.equal(nativeModelForTier(ROSTER, 'standard'), 'sonnet');
  assert.equal(nativeModelForTier(ROSTER, 'high'), 'opus');
  assert.equal(nativeModelForTier(ROSTER, 'nonexistent'), 'sonnet', 'unknown tier -> standard');

  const c = clone();
  c.defaults.native_models = { standard: 'opus' };
  assert.equal(nativeModelForTier(c, 'standard'), 'opus', 'roster overrides the built-in');
  assert.equal(nativeModelForTier(c, 'cheap'), 'haiku', 'unspecified keys keep their default');
  assert.ok(nativeModels(ROSTER).opus);
});

test('the router reports the model that will actually be used', () => {
  const d = route('write a CSS button component', ROSTER);
  assert.equal(d.backend, 'agy');
  assert.equal(d.model, backend(ROSTER, 'agy').model_tiers.standard);
});

// ── opencode is a real backend ───────────────────────────────────────────────

test('opencode ships enabled, with an invoker kind and no model map', () => {
  const oc = backend(ROSTER, 'opencode');
  assert.equal(oc.enabled, true);
  assert.equal(oc.kind, 'opencode');
  assert.equal(oc.oneshot_flag, 'run');
  assert.deepEqual(oc.model_tiers, {}, 'no model map: opencode uses its own configured default');
  // read-only vs writable is expressed by AGENT, not a sandbox flag.
  assert.equal(oc.agent, 'plan');
  assert.equal(oc.writable_agent, 'build');
  // --auto is what makes the writable lane full-auto; --print-logs routes opencode's diagnostics to
  // stderr so a FAILED run reports the real cause (a provider it cannot reach) instead of its own
  // banner. Assert the meaningful members rather than the exact array, so adding a diagnostic flag
  // does not read as a behaviour change.
  assert.ok(oc.writable_extra.includes('--auto'), 'writable lane must be full-auto');
  assert.ok(oc.writable_extra.includes('--print-logs'), 'failures must carry a real reason');
});

test('opencode declares a cwd_flag — it ignores the spawned process cwd', () => {
  // Regression guard for a real isolation bug found in live testing: opencode resolves its own
  // project root and IGNORED the cwd run.mjs spawned it with, so a `/team --writable` subtask
  // reported success while writing into the PARENT repo instead of its worktree. `--dir` is what
  // confines it. Dropping this field would silently reintroduce the leak.
  assert.equal(backend(ROSTER, 'opencode').cwd_flag, '--dir');
});

test('opencode has a dispatcher agent, a fallback slot, and is staffable by name', () => {
  assert.equal(ROSTER.agents.opencode.enabled, true);
  assert.equal(ROSTER.agents.opencode.backend, 'opencode');
  assert.ok(ROSTER.defaults.quota_fallback.includes('opencode'), 'reachable via the fallback chain');
  // /team reaches it by STAFFING it, not from an eligible-backend list — there is no such list.
  const staffed = parseRoleSpec('impl:opencode:2', { roster: ROSTER }).assignments;
  assert.deepEqual(staffed.map((a) => [a.role, a.backend]), [['executor', 'opencode']], '/team may staff it');
});

test('opencode claims no auto-route lane — it never silently steals agy/codex work', () => {
  // Deliberate: opencode runs on a user-configured model of unknown strength, so it must be an
  // explicit choice (its agent, /team, /reasoning, or the fallback chain), not an ambush.
  const targets = new Set((ROSTER.routes || []).map((r) => r.backend).filter(Boolean));
  assert.ok(!targets.has('opencode'), 'no shipped route targets opencode');
});

// ── grok (Grok Build) is a real backend ──────────────────────────────────────

test('grok ships enabled, with an invoker kind and no model map', () => {
  const g = backend(ROSTER, 'grok');
  assert.equal(g.enabled, true);
  assert.equal(g.kind, 'grok');
  // `grok -p <PROMPT>` is the headless lane (verified live: prints to stdout and exits, through a
  // plain pipe — no pty). `--prompt-file` returned nothing piped, which is why the prompt is argv.
  assert.equal(g.oneshot_flag, '-p');
  assert.equal(g.model_flag, '-m');
  // Same design decision as opencode: no map -> omit -m -> grok's own configured default.
  assert.deepEqual(g.model_tiers, {});
});

test('grok expresses read-only vs writable as a PERMISSION MODE, and needs no pty', () => {
  const g = backend(ROSTER, 'grok');
  assert.equal(g.permission_flag, '--permission-mode');
  // VERIFIED LIVE: `plan` does NOT block a write (grok created the file anyway) — `default` does,
  // by refusing a tool call it cannot get approved without a TTY, while still answering read tasks.
  assert.equal(g.permission_mode, 'default', 'read-only lane must be the mode that actually blocks writes');
  assert.equal(g.writable_permission_mode, 'bypassPermissions', '/team --writable lane');
  assert.equal(g.use_winpty, false, 'piped stdout works — unlike agy, grok is not TTY-gated');
  assert.equal(g.cwd_flag, '--cwd', 'confines a --writable subtask to its worktree');
});

test('grok has a dispatcher agent, a fallback slot, and is staffable by name', () => {
  assert.equal(ROSTER.agents.grok.enabled, true);
  assert.equal(ROSTER.agents.grok.backend, 'grok');
  assert.ok(ROSTER.defaults.quota_fallback.includes('grok'), 'reachable via the fallback chain');
  const staffed = parseRoleSpec('impl:grok:2', { roster: ROSTER }).assignments;
  assert.deepEqual(staffed.map((a) => [a.role, a.backend]), [['executor', 'grok']], '/team may staff it');
});

test('grok claims no auto-route lane — it never silently steals agy/codex work', () => {
  const targets = new Set((ROSTER.routes || []).map((r) => r.backend).filter(Boolean));
  assert.ok(!targets.has('grok'), 'no shipped route targets grok');
});

// ── config passthrough regressions ───────────────────────────────────────────

test('backend() forwards cost_per_1k_chars (it used to be dropped, zeroing every HUD cost)', () => {
  assert.ok(backend(ROSTER, 'agy').cost_per_1k_chars > 0);
  assert.equal(backend(ROSTER, 'agy').cost_per_1k_chars, ROSTER.backends.agy.cost_per_1k_chars);
});

test('backend() drops non-string model entries rather than letting them reach a command line', () => {
  const c = clone();
  c.backends.agy.models = { cheap: 'ok', bad: { nested: 1 }, _note: 'doc' };
  assert.deepEqual(backend(c, 'agy').model_tiers, { cheap: 'ok' });
});

// ── validation ───────────────────────────────────────────────────────────────

test('validateRoster accepts the `high` tier and flags routes to disabled backends', () => {
  const c = clone();
  c.routes.push({ name: 'high-tier-route', when: { type: ['css'] }, backend: 'agy', tier: 'high' });
  const okResult = validateRoster(c);
  assert.equal(okResult.ok, true, `high tier must validate: ${okResult.errors.join('; ')}`);

  c.backends.agy.enabled = false;
  const warned = validateRoster(c);
  assert.equal(warned.ok, true, 'disabling a backend is legal, not an error');
  assert.ok(warned.warnings.some((w) => w.includes('disabled')), 'but it is surfaced as a warning');
});

test('validateRoster rejects an enabled backend with no kind, and non-string models', () => {
  const c = clone();
  c.backends.broken = { enabled: true, cmd: 'broken' };          // no kind -> no invoker
  assert.equal(validateRoster(c).ok, false);

  const c2 = clone();
  c2.backends.agy.models = { standard: 42 };
  assert.equal(validateRoster(c2).ok, false);
});

test('the shipped roster validates clean', () => {
  const r = validateRoster(ROSTER);
  assert.equal(r.ok, true, r.errors.join('; '));
});

// ── end-to-end through the binaries ──────────────────────────────────────────

test('route.mjs --backends reports on/off state and the reason', () => {
  const plain = runNode(BIN_ROUTE, { args: ['--backends'] });
  assert.equal(plain.code, 0);
  assert.match(plain.stdout, /agy\s+enabled/);
  assert.match(plain.stdout, /opencode\s+enabled/);
  assert.match(plain.stdout, /native\s+always on/);

  const envOff = runNode(BIN_ROUTE, { args: ['--backends'], env: { MMT_DISABLE_BACKENDS: 'codex' } });
  assert.match(envOff.stdout, /codex\s+DISABLED \(env\)/);
});

test('with every backend off the ROUTER hands off directly — no wasted chain walk', () => {
  const d = tmp('all-off-');
  const off = writeRosterVariant(d, 'off.json', disableAllBackends);
  const { stdout } = runNode(BIN_RUN, { args: ['--roster', off, 'Write a SQL query to list users'] });
  // Because disabled rules are skipped during matching, the decision is native up front rather
  // than "pick agy, then discover run.mjs refuses it".
  assert.match(stdout, /MMT_NATIVE_HANDOFF/);
  assert.match(stdout, /router selected native backend/);
});

test('a FORCED dispatch to a roster-disabled backend says why it was skipped', () => {
  // Forcing bypasses the router, so this is the path where the chain-walk skip message matters.
  const d = tmp('skip-why-');
  const off = writeRosterVariant(d, 'off.json', disableAllBackends);
  const { stdout, stderr } = runNode(BIN_RUN, {
    args: ['--roster', off,
      '--decision', '{"backend":"agy","model":"","tier":"standard","rule":"forced","native":false}',
      'Write a SQL query to list users'],
  });
  assert.match(stdout, /MMT_NATIVE_HANDOFF/);
  // The old behaviour was a bare "backend options exhausted" with no hint the user had turned
  // them off — both the live stderr and the handoff reason must now say so.
  assert.match(stderr, /skipped — disabled in the roster/);
  assert.match(stdout, /disabled in the roster/);
});

test('a FORCED dispatch to an env-disabled backend names the env switch, not the roster', () => {
  const d = tmp('skip-env-');
  const r = writeRosterVariant(d, 'r.json');   // roster leaves everything ON
  const { stdout, stderr } = runNode(BIN_RUN, {
    args: ['--roster', r,
      '--decision', '{"backend":"agy","model":"","tier":"standard","rule":"forced","native":false}',
      'Write a SQL query to list users'],
    // Derived from the roster, not hardcoded: a newly added backend must not quietly re-enter this
    // chain and spawn a REAL CLI (grok did exactly that when it was added).
    env: { MMT_DISABLE_BACKENDS: backendNames(ROSTER).join(',') },
  });
  assert.match(stdout, /MMT_NATIVE_HANDOFF/);
  assert.match(stderr, /MMT_DISABLE_BACKENDS/);
  assert.doesNotMatch(stderr, /disabled in the roster/, 'must not blame the roster for an env switch');
});

test('run.mjs --model is accepted and does not disturb the native handoff path', () => {
  const d = tmp('model-flag-');
  const off = writeRosterVariant(d, 'off.json', disableAllBackends);
  const { stdout, code } = runNode(BIN_RUN, {
    args: ['--roster', off, '--model', 'gemini-3.6-flash-high', 'Write a SQL query to list users'],
  });
  assert.equal(code, 0);
  assert.match(stdout, /MMT_NATIVE_HANDOFF/);
});
