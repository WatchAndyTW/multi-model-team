// reason.test.mjs — /reasoning panel-spec parser (reason-spec.mjs) +
// config.reasoningConfig deep-merge. node --test style, importing modules directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { expandPanel, parsePanel, splitPanel } from '../src/lib/reason-spec.mjs';
import { loadRoster, reasoningConfig } from '../src/lib/config.mjs';
import { ROSTER, tmp, writeRosterVariant } from './helpers.mjs';

// ── expandPanel: token -> panelist for every alias ───────────────────────────
test('expandPanel: every alias maps to the right backend/tier', () => {
  const one = (tok) => expandPanel([tok]).panel[0];

  assert.deepEqual({ ...one('opus'), label: 0, token: 0 }, { backend: 'native', tier: 'opus', label: 0, token: 0 });
  assert.equal(one('sonnet').backend, 'native');   assert.equal(one('sonnet').tier, 'sonnet');
  assert.equal(one('claude').tier, 'sonnet', 'claude -> sonnet');
  assert.equal(one('native').tier, 'sonnet', 'native -> sonnet');
  assert.equal(one('anthropic').tier, 'sonnet', 'anthropic -> sonnet');
  assert.equal(one('haiku').backend, 'native');    assert.equal(one('haiku').tier, 'haiku');
  assert.equal(one('gemini').backend, 'agy');      assert.equal(one('gemini').tier, 'standard');
  assert.equal(one('agy').backend, 'agy');
  assert.equal(one('pro').backend, 'agy', 'pro -> agy/standard');
  assert.equal(one('google').backend, 'agy');
  assert.equal(one('flash').backend, 'agy');       assert.equal(one('flash').tier, 'cheap');
  assert.equal(one('codex').backend, 'codex');     assert.equal(one('codex').tier, 'standard');
  assert.equal(one('openai').backend, 'codex');
  assert.equal(one('gpt').backend, 'codex');
  assert.equal(one('chatgpt').backend, 'codex');
});

test('expandPanel: count prefix 3:gemini -> three panelists, unique labels', () => {
  const { panel } = expandPanel(['3:gemini']);
  assert.equal(panel.length, 3, '3:gemini expands to 3');
  assert.ok(panel.every((p) => p.backend === 'agy'), 'all gemini');
  const labels = panel.map((p) => p.label);
  assert.deepEqual(labels, ['gemini', 'gemini-2', 'gemini-3'], 'unique labels');
  assert.equal(new Set(labels).size, 3, 'labels are unique');
});

test('expandPanel: gemini:3 (suffix form) also accepted', () => {
  assert.equal(expandPanel(['gemini:3']).panel.length, 3, 'suffix count form');
});

test('expandPanel: cap clamps total panelists', () => {
  const { panel, note } = expandPanel(['99:gemini'], { cap: 4 });
  assert.equal(panel.length, 4, 'clamped to cap 4');
  assert.match(note, /clamp/i, 'note records the clamp');
});

test('expandPanel: cap ceiling is 16, default 8', () => {
  assert.equal(expandPanel(['99:gemini'], { cap: 99 }).panel.length, 16, 'ceiling 16');
  assert.equal(expandPanel(['99:gemini']).panel.length, 8, 'default cap 8');
});

test('expandPanel: unknown token skipped and noted', () => {
  const { panel, note } = expandPanel(['gemini', 'banana', 'opus']);
  assert.equal(panel.length, 2, 'unknown skipped');
  assert.deepEqual(panel.map((p) => p.token), ['gemini', 'opus']);
  assert.match(note, /banana/, 'note names the skipped token');
});

// ── parsePanel: spec string parsing + default fallback ───────────────────────
test('parsePanel: spec parses, source spec', () => {
  const { panel, source } = parsePanel('2:gemini,opus,codex');
  assert.equal(source, 'spec');
  assert.equal(panel.length, 4, '2 gemini + opus + codex');
  assert.deepEqual(panel.map((p) => p.backend), ['agy', 'agy', 'native', 'codex']);
});

test('parsePanel: empty -> default panel + source default', () => {
  const { panel, source } = parsePanel('');
  assert.equal(source, 'default');
  assert.deepEqual(panel.map((p) => p.token), ['opus', 'sonnet', 'gemini']);
});

test('parsePanel: garbage -> default panel + source default', () => {
  const { panel, source } = parsePanel('banana,xyz,nope');
  assert.equal(source, 'default', 'all-unknown spec falls back to default');
  assert.deepEqual(panel.map((p) => p.token), ['opus', 'sonnet', 'gemini']);
});

test('parsePanel: respects cap', () => {
  assert.equal(parsePanel('10:gemini', { cap: 3 }).panel.length, 3, 'cap honored');
});

test('parsePanel: honors custom defaultPanel', () => {
  const { panel, source } = parsePanel('', { defaultPanel: ['codex', 'haiku'] });
  assert.equal(source, 'default');
  assert.deepEqual(panel.map((p) => p.token), ['codex', 'haiku']);
});

// ── splitPanel: peel leading spec, don't misread a question ──────────────────
test('splitPanel: leading spec peeled off the question', () => {
  const r = splitPanel('2:gemini,opus  why is the sky blue');
  assert.equal(r.source, 'spec');
  assert.equal(r.question, 'why is the sky blue', 'question extracted after spec');
  assert.equal(r.panel.length, 3, '2 gemini + opus');
});

test('splitPanel: a plain question is NOT misread as a spec', () => {
  const r = splitPanel('why is the sky blue');
  assert.equal(r.source, 'default');
  assert.equal(r.question, 'why is the sky blue', 'whole text is the question');
  assert.deepEqual(r.panel.map((p) => p.token), ['opus', 'sonnet', 'gemini'], 'default panel applied');
});

test('splitPanel: bare-token leading spec (gemini,opus build X)', () => {
  const r = splitPanel('gemini,opus build a parser');
  assert.equal(r.source, 'spec');
  assert.equal(r.question, 'build a parser');
  assert.deepEqual(r.panel.map((p) => p.backend), ['agy', 'native']);
});

test('splitPanel: default panel applied when no spec', () => {
  const r = splitPanel('explain monads');
  assert.equal(r.panel.length, 3, 'default panel size');
});

// Regression: a question whose FIRST WORD is a bare panel alias must NOT be peeled as a
// 1-panelist spec (would silently truncate the question). Only a comma-list or a colon pair
// is an unambiguous spec. (pro/native/opus/google/flash/openai/claude/gpt are common English.)
test('splitPanel: single bare alias as first word is NOT a spec (question preserved)', () => {
  for (const q of [
    'opus the movie was great',
    'pro tips for cooking pasta',
    'native apps are great for mobile',
    'openai released a new model today',
    'claude is better than gpt',
    'flash floods explained',
  ]) {
    const r = splitPanel(q);
    assert.equal(r.source, 'default', `"${q}" must not be read as a spec`);
    assert.equal(r.question, q, `"${q}" must be preserved verbatim`);
    assert.deepEqual(r.panel.map((p) => p.token), ['opus', 'sonnet', 'gemini'], 'default panel applied');
  }
  // But an explicit colon-pair or comma-list IS still a spec.
  assert.equal(splitPanel('2:gemini build a parser').source, 'spec', 'colon pair is a spec');
  assert.equal(splitPanel('2:gemini build a parser').question, 'build a parser');
  assert.equal(splitPanel('opus,sonnet why blue').source, 'spec', 'comma list is a spec');
  assert.equal(splitPanel('opus,sonnet why blue').question, 'why blue');
});

// ── custom default panel flows through splitPanel + CLI --default flag ────────

test('splitPanel: custom defaultPanel honored when no spec present', () => {
  // Simulates the command passing the user's configured roster panel as the default.
  const r = splitPanel('explain monads', { defaultPanel: ['gemini', 'codex'] });
  assert.equal(r.source, 'default', 'source is default (no spec typed)');
  assert.equal(r.question, 'explain monads', 'question preserved');
  assert.deepEqual(r.panel.map((p) => p.token), ['gemini', 'codex'], 'roster custom panel honored');
});

test('splitPanel: custom defaultPanel with 4 models', () => {
  const r = splitPanel('what is a monad', { defaultPanel: ['opus', 'sonnet', 'gemini', 'codex'] });
  assert.equal(r.source, 'default');
  assert.equal(r.panel.length, 4);
  assert.deepEqual(r.panel.map((p) => p.token), ['opus', 'sonnet', 'gemini', 'codex']);
});

test('splitPanel: per-invocation spec overrides custom defaultPanel', () => {
  // Even with a custom roster default, an explicit spec wins.
  const r = splitPanel('opus,haiku explain monads', { defaultPanel: ['gemini', 'codex'] });
  assert.equal(r.source, 'spec', 'spec wins over custom default');
  assert.deepEqual(r.panel.map((p) => p.token), ['opus', 'haiku'], 'spec panel used, not custom default');
  assert.equal(r.question, 'explain monads');
});

// ── config.reasoningConfig: defaults present + roster deep-merge ──────────────
test('reasoningConfig: real roster reasoning section resolves to the documented defaults', () => {
  const cfg = reasoningConfig(ROSTER);
  assert.deepEqual(cfg.panel, ['opus', 'sonnet', 'gemini'], 'default panel');
  assert.ok(cfg.judge, 'judge present');
  assert.equal(cfg.judge, 'native:opus', 'judge default');
  assert.equal(cfg.synthesizer, 'native:opus', 'synthesizer default');
  assert.equal(cfg.tier_models.opus, 'opus', 'tier_models.opus');
  assert.equal(cfg.cap, 6, 'default cap');
});

test('reasoningConfig: roster reasoning overrides deep-merge (tier_models key-by-key, panel wholesale, _keys ignored)', () => {
  const d = tmp('reason-cfg-');
  const p = writeRosterVariant(d, 'r.json', (c) => {
    c.reasoning = {
      _comment: 'ignored doc key',
      panel: ['codex', 'codex', 'opus'],
      judge: 'native:sonnet',
      tier_models: { standard: 'haiku' }, // override one key, keep the rest
    };
  });
  const cfg = reasoningConfig(loadRoster(p));

  assert.deepEqual(cfg.panel, ['codex', 'codex', 'opus'], 'panel replaced wholesale');
  assert.equal(cfg.judge, 'native:sonnet', 'judge overridden');
  assert.equal(cfg.synthesizer, 'native:opus', 'synthesizer keeps default');
  assert.equal(cfg.tier_models.standard, 'haiku', 'tier_models.standard overridden');
  assert.equal(cfg.tier_models.opus, 'opus', 'tier_models.opus kept from defaults (deep-merge)');
  assert.ok(!('_comment' in cfg), '_-prefixed keys ignored');
});
