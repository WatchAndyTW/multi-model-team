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

test('team.mjs: relay command shells `node` with base64url args, no heredoc, never `bash …run.mjs`', () => {
  // Regression for the relay-scripting bug class: a POSIX heredoc + single-quoted JSON --decision
  // broke under PowerShell (the relay sub-agent's shell is not guaranteed), so every agy/codex
  // dispatch silently fell back to native. The fix carries payload + decision as base64url args
  // ([A-Za-z0-9_-] only) — shell-agnostic, no heredoc, no untrusted text on the command line.

  // 1. No `bash …run.mjs` anywhere (the older broken form, tolerating the ${JSON.stringify(RUN)} expr).
  assert.doesNotMatch(SRC, /bash\s+\$\{[^}]*RUN[^}]*\}/, 'team.mjs relay command must not shell `bash` at the run.mjs path');
  assert.doesNotMatch(SRC, /bash\s+\S*run\.mjs/, 'team.mjs must not run `bash …run.mjs`');

  // 2. The heredoc is gone (it was the PowerShell-incompatible failure path).
  assert.doesNotMatch(SRC, /MMT_SUB_EOF/, 'team.mjs relay must not use a heredoc delimiter');
  assert.doesNotMatch(SRC, /<<'[A-Z_]+'/, 'team.mjs relay must not use a POSIX heredoc');

  // 3. The relay command template is built with `node ${RUN}` + base64url transports.
  const relayLine = SRC.split(/\r?\n/).find(
    (l) => l.includes('--decision-b64') && l.includes('--task-b64') && l.includes('RUN'),
  );
  assert.ok(relayLine, 'base64url relay command template line not found');
  assert.match(relayLine.trim(), /^const command = `node \$\{/, 'relay command must start with `node ${RUN}`');

  // 4. The shell-agnostic encoder + oversize guard are present.
  assert.ok(SRC.includes('function b64url'), 'team.mjs missing inline b64url encoder');
  assert.ok(SRC.includes('MAX_RELAY_ARG_CHARS'), 'team.mjs missing relay-arg oversize guard');
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

test('reasoning.mjs: relay command shells `node` with base64url args, no heredoc, never `bash …run.mjs`', () => {
  assert.doesNotMatch(REASON_SRC, /bash\s+\$\{[^}]*RUN[^}]*\}/, 'relay must not shell `bash` at the run.mjs path');
  assert.doesNotMatch(REASON_SRC, /bash\s+\S*run\.mjs/, 'must not run `bash …run.mjs`');
  assert.doesNotMatch(REASON_SRC, /MMT_SUB_EOF/, 'reasoning.mjs relay must not use a heredoc delimiter');
  assert.doesNotMatch(REASON_SRC, /<<'[A-Z_]+'/, 'reasoning.mjs relay must not use a POSIX heredoc');
  const relayLine = REASON_SRC.split(/\r?\n/).find(
    (l) => l.includes('--decision-b64') && l.includes('--task-b64') && l.includes('RUN'),
  );
  assert.ok(relayLine, 'base64url relay command template line not found');
  assert.match(relayLine.trim(), /^const command = `node \$\{/, 'relay command must start with `node ${RUN}`');
  assert.ok(REASON_SRC.includes('function b64url'), 'reasoning.mjs missing inline b64url encoder');
  assert.ok(REASON_SRC.includes('MAX_RELAY_ARG_CHARS'), 'reasoning.mjs missing relay-arg oversize guard');
});
