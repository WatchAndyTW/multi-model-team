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
const REASON_SRC = readFileSync(join(ROOT, 'workflows', 'reasoning.mjs'), 'utf8');

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

test('team.mjs: relay/verify command template shells `node`, never `bash …run.mjs`', () => {
  // Regression for the find-replace bug class: the relay command ran `bash <run.mjs>` (exit 2, empty)
  // so every agy/codex dispatch AND the codex verify silently fell back to native. The command is a
  // template literal `... ${JSON.stringify(RUN)} --decision ...` where RUN ends in src/bin/run.mjs.
  // Assert every `run.mjs` invocation in the source is prefixed with `node `, and that no `bash `
  // shells a run.mjs (a substring source check, since this is a static-analysis suite).

  // 1. No `bash …run.mjs` anywhere (the exact broken form, tolerating the ${JSON.stringify(RUN)} expr).
  assert.doesNotMatch(
    SRC,
    /bash\s+\$\{[^}]*RUN[^}]*\}/,
    'team.mjs relay command must not shell `bash` at the run.mjs path',
  );
  assert.doesNotMatch(SRC, /bash\s+\S*run\.mjs/, 'team.mjs must not run `bash …run.mjs`');

  // 2. The relay command template (the line carrying --decision + the heredoc) starts with `node `.
  const relayLine = SRC.split(/\r?\n/).find(
    (l) => l.includes('--decision') && l.includes('RUN') && l.includes('MMT_SUB_EOF'),
  );
  assert.ok(relayLine, 'relay command template line not found');
  assert.match(relayLine.trim(), /^node\s+\$\{/, 'relay command must start with `node ${RUN}`');
});

// ── workflows/reasoning.mjs — the Fusion (Panel -> Judge -> Synthesize) workflow ─────
// Same static-analysis contract as team.mjs: determinism (no Date/random), the faithful-relay
// machinery, the four Fusion judge dimensions, and the `node …run.mjs` (never `bash`) relay shell.

test('reasoning.mjs: no Date/random APIs (determinism guard)', () => {
  assert.doesNotMatch(REASON_SRC, /Date\.now|Math\.random|new Date/, 'forbidden non-deterministic API present');
});

test('reasoning.mjs: self-contained — no project-lib imports (Workflow runtime has no fs/import)', () => {
  assert.doesNotMatch(REASON_SRC, /^\s*import\s.+from\s+['"]\.\.?\//m, 'workflow must not import project libs');
  assert.doesNotMatch(REASON_SRC, /\brequire\s*\(/, 'workflow must not require()');
});

test('reasoning.mjs: Fusion pipeline + faithful-relay markers present', () => {
  const markers = [
    'dispatchRelay',     // the PURE RELAY PIPE sub-agent (CLI panelists)
    'RELAY_SCHEMA',      // forces the faithful {stdout, backend_ran} report
    'JUDGE_SCHEMA',      // structured judge output
    'consensus',         // the four Fusion judge dimensions:
    'contradictions',
    'unique_insights',
    'blind_spots',
    'ranOn',             // records the backend that ACTUALLY produced each answer
    'native-fallback',   // visible native fallback (no dress-up behind a CLI label)
    'tierModel',         // tier -> concrete native model
    "phase('Panel')",    // the three staged phases:
    "phase('Judge')",
    "phase('Synthesize')",
  ];
  for (const m of markers) {
    assert.ok(REASON_SRC.includes(m), `reasoning.mjs missing marker: ${m}`);
  }
});

test('reasoning.mjs: relay command shells `node`, never `bash …run.mjs`', () => {
  assert.doesNotMatch(REASON_SRC, /bash\s+\$\{[^}]*RUN[^}]*\}/, 'relay must not shell `bash` at the run.mjs path');
  assert.doesNotMatch(REASON_SRC, /bash\s+\S*run\.mjs/, 'must not run `bash …run.mjs`');
  const relayLine = REASON_SRC.split(/\r?\n/).find(
    (l) => l.includes('--decision') && l.includes('RUN') && l.includes('MMT_SUB_EOF'),
  );
  assert.ok(relayLine, 'relay command template line not found');
  assert.match(relayLine.trim(), /^node\s+\$\{/, 'relay command must start with `node ${RUN}`');
});
