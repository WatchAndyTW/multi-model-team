// workflows.test.mjs — port of the oracle's team.mjs determinism + pipeline-structure block.
// Static analysis on workflows/team.mjs (the Ultracode dynamic-workflow fan-out): the Workflow
// runtime forbids Date/random APIs (they break resume), so they must not appear; and the staged
// pipeline + faithful-relay machinery must be present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const SRC = readFileSync(join(ROOT, 'workflows', 'team.mjs'), 'utf8');

test('team.mjs: no Date/random APIs (determinism guard)', () => {
  assert.doesNotMatch(SRC, /Date\.now|Math\.random|new Date/, 'forbidden non-deterministic API present');
});

test('team.mjs: staged-pipeline + faithful-relay markers present', () => {
  // The load-bearing structural markers (subset of the oracle list — the ones that encode the
  // equal-backends / faithful-relay / dynamic-tier contract).
  const markers = [
    'dispatchRelay',   // the PURE RELAY PIPE sub-agent
    'parseVerdict',    // deterministic PASS/FAIL parse of the verifier CLI
    'ranOn',           // records the backend that ACTUALLY produced each result
    'teamConfig',      // equal/configurable roles from roster
    'tierModel',       // tier -> concrete native model (dynamic by complexity)
    'native-fallback', // visible native fallback (no dress-up)
    'team-verify',     // forced codex verify rule
  ];
  for (const m of markers) {
    assert.ok(SRC.includes(m), `team.mjs missing marker: ${m}`);
  }
});
