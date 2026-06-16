// setup.test.mjs — the proactive-config installer/re-sync engine (src/bin/setup.mjs).
// Always run against TEMP roster + settings paths so the real ~/.claude is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_SETUP, tmp, runNode } from './helpers.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('setup: default writes enabled roster + wires settings, preserving other keys', () => {
  const d = tmp('setup-');
  const R = join(d, 'mmt-roster.json');
  const S = join(d, 'settings.json');
  writeFileSync(S, JSON.stringify({ model: 'x', enabledPlugins: { a: true } }), 'utf8');

  const r = runNode(BIN_SETUP, { args: ['--roster', R, '--settings-file', S] });
  assert.equal(r.code, 0, 'exit 0');

  const roster = readJson(R);
  assert.equal(roster.proactive.enabled, true, 'proactive enabled');
  assert.equal(roster.proactive.enforce_spawns, false, 'default is soft nudge');
  assert.ok(roster.backends && roster.backends.agy, 'base carried from plugin roster');

  const settings = readJson(S);
  assert.equal(settings.env.MMT_ROSTER, R, 'env.MMT_ROSTER wired to the roster path');
  assert.equal(settings.model, 'x', 'pre-existing settings keys preserved');
  assert.deepEqual(settings.enabledPlugins, { a: true }, 'nested settings preserved');
  assert.match(r.stdout, /RESTART Claude Code/, 'reminds to restart when settings changed');
});

test('setup --enforce: sets enforce_spawns true', () => {
  const d = tmp('setup-enf-');
  const R = join(d, 'r.json');
  const r = runNode(BIN_SETUP, { args: ['--enforce', '--no-settings', '--roster', R] });
  assert.equal(r.code, 0);
  assert.equal(readJson(R).proactive.enforce_spawns, true);
});

test('setup --sync: preserves user [proactive] toggles while refreshing the base', () => {
  const d = tmp('setup-sync-');
  const R = join(d, 'r.json');
  // First create it, then the user customizes proactive AND staleness creeps into the base.
  runNode(BIN_SETUP, { args: ['--enforce', '--no-settings', '--roster', R] });
  const cur = readJson(R);
  cur.proactive.rules = 'standard-coding';
  cur.backends.agy.models.standard = 'STALE-MODEL';
  writeFileSync(R, JSON.stringify(cur), 'utf8');

  const r = runNode(BIN_SETUP, { args: ['--sync', '--roster', R] });
  assert.equal(r.code, 0);
  const after = readJson(R);
  assert.equal(after.proactive.rules, 'standard-coding', 'user proactive.rules preserved');
  assert.equal(after.proactive.enforce_spawns, true, 'user enforce toggle preserved');
  assert.notEqual(after.backends.agy.models.standard, 'STALE-MODEL', 'base refreshed from plugin roster');
});

test('setup --disable: turns proactive off but keeps settings wiring', () => {
  const d = tmp('setup-dis-');
  const R = join(d, 'r.json');
  const S = join(d, 's.json');
  runNode(BIN_SETUP, { args: ['--roster', R, '--settings-file', S] });
  const r = runNode(BIN_SETUP, { args: ['--disable', '--roster', R, '--settings-file', S] });
  assert.equal(r.code, 0);
  assert.equal(readJson(R).proactive.enabled, false, 'disabled');
  assert.equal(readJson(S).env.MMT_ROSTER, R, 'settings wiring left intact');
});

test('setup: fail-safe — invalid settings.json is NOT clobbered', () => {
  const d = tmp('setup-bad-');
  const R = join(d, 'r.json');
  const S = join(d, 's.json');
  writeFileSync(S, '{bad json', 'utf8');
  const r = runNode(BIN_SETUP, { args: ['--roster', R, '--settings-file', S] });
  assert.equal(r.code, 0, 'still writes the roster (exit 0)');
  assert.equal(readJson(R).proactive.enabled, true, 'roster written');
  assert.equal(readFileSync(S, 'utf8'), '{bad json', 'broken settings left untouched');
  assert.match(r.stdout, /not valid JSON/, 'explains why settings was skipped');
});
