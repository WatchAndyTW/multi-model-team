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

test('team.mjs: relay uses the file transport (--call-file), no heredoc, no base64, never `bash …run.mjs`', () => {
  // Regression for the relay-scripting bug class: a POSIX heredoc + single-quoted JSON --decision
  // broke under PowerShell (the relay sub-agent's shell is not guaranteed), so every agy/codex
  // dispatch silently fell back to native. The fix writes the payload to a .mmt/calls/ file (via the
  // Write tool — never a shell) and passes only the file PATH (--call-file) — shell-agnostic, no
  // heredoc, no base64, no untrusted text on the command line.

  // 1. No `bash …run.mjs` anywhere (the older broken form, tolerating the ${JSON.stringify(RUN)} expr).
  assert.doesNotMatch(SRC, /bash\s+\$\{[^}]*RUN[^}]*\}/, 'team.mjs relay command must not shell `bash` at the run.mjs path');
  assert.doesNotMatch(SRC, /bash\s+\S*run\.mjs/, 'team.mjs must not run `bash …run.mjs`');

  // 2. The heredoc is gone (it was the PowerShell-incompatible failure path).
  assert.doesNotMatch(SRC, /MMT_SUB_EOF/, 'team.mjs relay must not use a heredoc delimiter');
  assert.doesNotMatch(SRC, /<<'[A-Z_]+'/, 'team.mjs relay must not use a POSIX heredoc');

  // 3. The base64 transport is fully removed (no encoder, no --task-b64/--decision-b64 args).
  assert.doesNotMatch(SRC, /function b64url/, 'team.mjs must not retain the b64url encoder');
  assert.doesNotMatch(SRC, /--task-b64|--decision-b64/, 'team.mjs must not use base64url args');

  // 4. The relay instructs `node ${RUN} --call-file=…` and derives a deterministic .mmt/calls path.
  assert.match(SRC, /node \$\{JSON\.stringify\(RUN\)\} --call-file=/, 'relay must run `node ${RUN} --call-file=…`');
  assert.ok(SRC.includes('.mmt/calls/'), 'team.mjs relay must write the payload under .mmt/calls/');
  assert.ok(SRC.includes('function callFilePath'), 'team.mjs missing the deterministic call-file path helper');
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

test('reasoning.mjs: relay uses the file transport (--call-file), no heredoc, no base64, never `bash …run.mjs`', () => {
  assert.doesNotMatch(REASON_SRC, /bash\s+\$\{[^}]*RUN[^}]*\}/, 'relay must not shell `bash` at the run.mjs path');
  assert.doesNotMatch(REASON_SRC, /bash\s+\S*run\.mjs/, 'must not run `bash …run.mjs`');
  assert.doesNotMatch(REASON_SRC, /MMT_SUB_EOF/, 'reasoning.mjs relay must not use a heredoc delimiter');
  assert.doesNotMatch(REASON_SRC, /<<'[A-Z_]+'/, 'reasoning.mjs relay must not use a POSIX heredoc');
  assert.doesNotMatch(REASON_SRC, /function b64url/, 'reasoning.mjs must not retain the b64url encoder');
  assert.doesNotMatch(REASON_SRC, /--task-b64|--decision-b64/, 'reasoning.mjs must not use base64url args');
  assert.match(REASON_SRC, /node \$\{JSON\.stringify\(RUN\)\} --call-file=/, 'relay must run `node ${RUN} --call-file=…`');
  assert.ok(REASON_SRC.includes('.mmt/calls/'), 'reasoning.mjs relay must write the payload under .mmt/calls/');
  assert.ok(REASON_SRC.includes('function callFilePath'), 'reasoning.mjs missing the deterministic call-file path helper');
});
