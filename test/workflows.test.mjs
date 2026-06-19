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

test('team.mjs: relay uses the file transport (--call-file), no heredoc, never `bash …run.mjs`', () => {
  // Regression for the relay-scripting bug class: a POSIX heredoc + single-quoted JSON --decision
  // broke under PowerShell (the relay sub-agent's shell is not guaranteed), so every agy/codex
  // dispatch silently fell back to native. The fix writes the payload to a .mmt/calls/ file (via the
  // Write tool — never a shell) and passes only the file PATH (--call-file) — shell-agnostic, no
  // heredoc, no untrusted text on the command line.

  // 1. No `bash …run.mjs` anywhere (the older broken form, tolerating the ${JSON.stringify(RUN)} expr).
  assert.doesNotMatch(SRC, /bash\s+\$\{[^}]*RUN[^}]*\}/, 'team.mjs relay command must not shell `bash` at the run.mjs path');
  assert.doesNotMatch(SRC, /bash\s+\S*run\.mjs/, 'team.mjs must not run `bash …run.mjs`');

  // 2. The heredoc is gone (it was the PowerShell-incompatible failure path).
  assert.doesNotMatch(SRC, /MMT_SUB_EOF/, 'team.mjs relay must not use a heredoc delimiter');
  assert.doesNotMatch(SRC, /<<'[A-Z_]+'/, 'team.mjs relay must not use a POSIX heredoc');

  // 3. The relay instructs `node ${RUN} --call-file=…` and derives a deterministic .mmt/calls path.
  assert.match(SRC, /node \$\{JSON\.stringify\(RUN\)\} --call-file=/, 'relay must run `node ${RUN} --call-file=…`');
  assert.ok(SRC.includes('.mmt/calls/'), 'team.mjs relay must write the payload under .mmt/calls/');
  assert.ok(SRC.includes('function callFilePath'), 'team.mjs missing the deterministic call-file path helper');

  // 5. The relay must instruct a FOREGROUND wait (the premature-give-up fix): no background, no
  //    self-imposed sleep/timeout, retry-and-wait on the relay's own time limit.
  assert.match(SRC, /FOREGROUND and WAIT/, 'team.mjs relay must tell the worker to run foreground and wait');
  assert.ok(SRC.includes('status file') || SRC.includes('.status.json'), 'team.mjs relay must mention the pollable status file');
  // 6. Anti-thrash (the gemini multi-attempt-timeout bug): on the relay's OWN time limit it must
  //    poll the status file and keep WAITING on state:"running", NOT blindly re-run (which spawns a
  //    second CLI process). Re-run at most once.
  assert.match(SRC, /do NOT immediately re-run/i, 'team.mjs relay must not blindly re-run on its own time limit');
  assert.match(SRC, /at most ONCE/i, 'team.mjs relay must cap re-runs at once (no loop)');
});

test('workflows: relay guards against an empty/placeholder payload (the undefined-task bug)', () => {
  // Regression: relays once wrote a call file with a missing/placeholder task (JSON.stringify drops
  // an undefined task key), so the CLI ran on nothing and "refused". Both workflows must (a) skip the
  // relay on empty text -> visible native fallback, and (b) tell the relay to SELF-CHECK for an
  // unsubstituted <...> placeholder before writing.
  for (const [name, src] of [['team.mjs', SRC], ['reasoning.mjs', REASON_SRC]]) {
    assert.match(src, /text == null \|\| !String\(text\)\.trim\(\)/, `${name} dispatchRelay must guard empty text`);
    assert.match(src, /backend_ran: false/, `${name} empty-text guard returns a visible-fallback result`);
    assert.match(src, /SELF-CHECK/, `${name} relay prompt must include the placeholder self-check`);
    assert.match(src, /placeholder/i, `${name} self-check must mention the placeholder`);
  }
});

test('team.mjs: writable-mode worktree machinery present (Setup/Integrate, --cwd --writable, integration branch)', () => {
  const markers = [
    'WRITABLE',                 // the mode flag
    'INT_BRANCH',               // the integration branch name
    'mmt/team-',                // integration branch naming off the slug
    'worktreeFor',              // per-subtask worktree path
    '.mmt/worktrees/',          // gitignored worktree home
    'SETUP_SCHEMA',             // setup agent structured report
    'INTEGRATE_SCHEMA',         // integration agent structured report
    "phase('Setup')",           // the two new writable-only phases
    "phase('Integrate')",
    '--cwd=',                   // relay passes the worktree cwd
    '--writable',               // relay passes the writable flag
    'INT_WORKTREE',             // dedicated integration worktree (user's checkout never touched)
    'safeLabel',                // labels sanitized before use in refs/paths
    'show-ref --verify',        // idempotent branch creation (resume-safe)
    'RESOLVE it',               // the orchestrator resolves conflicts itself (not abort+leave)
    'resolved',                 // the schema field for orchestrator-resolved conflicts
    'unresolved',               // the rare conflict left for the user
  ];
  for (const m of markers) {
    assert.ok(SRC.includes(m), `team.mjs missing writable-mode marker: ${m}`);
  }
  // The integration agent RESOLVES conflicts rather than the old abort-and-leave-for-user flow:
  // `merge --abort` must only appear on the genuinely-unresolvable path, and the prompt must instruct
  // editing the conflicted files (remove conflict markers) + completing the merge.
  assert.match(SRC, /do NOT abort\. RESOLVE it/, 'integration must resolve conflicts, not blindly abort');
  assert.match(SRC, /remove ALL conflict markers/i, 'integration must remove conflict markers when resolving');
  // Determinism still holds with the new code (no Date/random crept in).
  assert.doesNotMatch(SRC, /Date\.now|Math\.random|new Date/, 'writable code must stay determinism-safe');
});

test('team.mjs safeLabel: produces git-ref-safe + path-safe tokens (no .., no .lock, no leading/trailing . or -)', () => {
  // Extract the REAL safeLabel() from the workflow source and exercise it, so this test tracks the
  // actual function (it can't be imported — the Workflow runtime globals aren't present under node).
  const m = SRC.match(/function safeLabel\([\s\S]*?\n\}/);
  assert.ok(m, 'safeLabel function found in team.mjs');
  // eslint-disable-next-line no-new-func
  const safeLabel = new Function(`${m[0]}; return safeLabel;`)();
  const ok = (label) => {
    const out = safeLabel(label);
    // git check-ref-format rules we care about for a single path component:
    assert.doesNotMatch(out, /\.\./, `"${label}" -> "${out}" must not contain ..`);
    assert.doesNotMatch(out, /\.lock$/i, `"${label}" -> "${out}" must not end in .lock`);
    assert.doesNotMatch(out, /^[-.]|[-.]$/, `"${label}" -> "${out}" must not start/end with . or -`);
    assert.doesNotMatch(out, /[^A-Za-z0-9._-]/, `"${label}" -> "${out}" only ref/path-safe chars`);
    assert.ok(out.length > 0 && out.length <= 48, `"${label}" -> "${out}" is 1..48 chars`);
    return out;
  };
  assert.equal(ok('a..b'), 'a.b', 'consecutive dots collapsed');
  assert.equal(ok('v1.lock'), 'v1-lock', '.lock suffix neutralized');
  assert.equal(ok('.hidden'), 'hidden', 'leading dot stripped');
  assert.equal(ok('trail-'), 'trail', 'trailing dash stripped');
  assert.equal(ok('ok-label'), 'ok-label', 'plain label unchanged');
  ok('weird/\\:*name'); ok(''); ok('...'); ok('a.lock.lock');
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

test('reasoning.mjs: relay uses the file transport (--call-file), no heredoc, never `bash …run.mjs`', () => {
  assert.doesNotMatch(REASON_SRC, /bash\s+\$\{[^}]*RUN[^}]*\}/, 'relay must not shell `bash` at the run.mjs path');
  assert.doesNotMatch(REASON_SRC, /bash\s+\S*run\.mjs/, 'must not run `bash …run.mjs`');
  assert.doesNotMatch(REASON_SRC, /MMT_SUB_EOF/, 'reasoning.mjs relay must not use a heredoc delimiter');
  assert.doesNotMatch(REASON_SRC, /<<'[A-Z_]+'/, 'reasoning.mjs relay must not use a POSIX heredoc');
  assert.match(REASON_SRC, /node \$\{JSON\.stringify\(RUN\)\} --call-file=/, 'relay must run `node ${RUN} --call-file=…`');
  assert.ok(REASON_SRC.includes('.mmt/calls/'), 'reasoning.mjs relay must write the payload under .mmt/calls/');
  assert.ok(REASON_SRC.includes('function callFilePath'), 'reasoning.mjs missing the deterministic call-file path helper');
  assert.match(REASON_SRC, /FOREGROUND and WAIT/, 'reasoning.mjs relay must tell the worker to run foreground and wait');
  assert.ok(REASON_SRC.includes('status file') || REASON_SRC.includes('.status.json'), 'reasoning.mjs relay must mention the pollable status file');
  assert.match(REASON_SRC, /do NOT immediately re-run/i, 'reasoning.mjs relay must not blindly re-run on its own time limit');
  assert.match(REASON_SRC, /at most ONCE/i, 'reasoning.mjs relay must cap re-runs at once (no loop)');
});

// ── Regression: status-file-authoritative dispatch (the "fails-without-a-reason" fix) ──
// The relay's backend_ran is an LLM self-judgment that a cheap relay model misreports when ITS OWN
// Bash tool times out on a slow-but-successful agy/codex call. run.mjs's status file is authoritative:
// state:"done" + usable stdout == success EVEN IF the relay said backend_ran:false. And every native
// fallback must carry the REAL reason (timeout/quota/…), not a generic "unavailable".
test('team.mjs: dispatch is status-file-authoritative + surfaces the real fallback reason', () => {
  // (a) The relay schema must collect the authoritative status-file fields.
  for (const m of ['status_state', 'out_chars', 'fail_kind', 'relay_note']) {
    assert.ok(SRC.includes(m), `team.mjs RELAY_SCHEMA missing status field: ${m}`);
  }
  // (b) The deterministic helpers + the relay-timeout pin must exist.
  for (const m of ['relaySucceeded', 'relayFailReason', 'hasUsableStdout', 'RELAY_BASH_TIMEOUT_MS', 'fallbackReasons', 'failReason']) {
    assert.ok(SRC.includes(m), `team.mjs missing marker: ${m}`);
  }
  // (c) dispatch() must NOT gate solely on backend_ran any more (the misclassification bug). The old
  //     `relay.backend_ran === true && ... relay.stdout ... trim()` guard is replaced by relaySucceeded.
  assert.match(SRC, /if \(relaySucceeded\(relay\)\)/, 'dispatch must decide success via relaySucceeded, not a raw backend_ran check');
});

test('team.mjs: relaySucceeded/relayFailReason behave (status file overrides relay judgment)', () => {
  // Extract the three helpers (function NAME(...) up to a lone `}` line) and exercise them in isolation.
  const grab = (name) => {
    const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n}');
    const m = SRC.match(re);
    assert.ok(m, 'could not extract ' + name);
    return m[0];
  };
  const helpers = [grab('hasUsableStdout'), grab('relaySucceeded'), grab('relayFailReason')].join('\n') + '\n';
  const f = new Function(helpers + 'return { hasUsableStdout, relaySucceeded, relayFailReason };')();

  // status:"done" + stdout overrides backend_ran:false — the core recovery (slow-but-fine CLI run).
  assert.equal(f.relaySucceeded({ status_state: 'done', out_chars: 10, stdout: 'real answer', backend_ran: false }), true);
  // status:"failed" is authoritative even if the relay claimed backend_ran:true.
  assert.equal(f.relaySucceeded({ status_state: 'failed', stdout: 'partial', backend_ran: true }), false);
  // a handoff sentinel is never success.
  assert.equal(f.relaySucceeded({ status_state: '', stdout: 'MMT_NATIVE_HANDOFF tier=x', backend_ran: true }), false);
  // no status file -> old contract (backend_ran + usable stdout) still holds — and must be a STRICT
  // boolean, not the stdout string (codex review caught hasUsableStdout returning a string).
  assert.strictEqual(f.relaySucceeded({ status_state: '', stdout: 'ans', backend_ran: true }), true);
  assert.strictEqual(f.hasUsableStdout({ stdout: 'ans' }), true, 'hasUsableStdout returns a real boolean');
  // "done" with empty stdout is NOT a success.
  assert.equal(f.relaySucceeded({ status_state: 'done', stdout: '   ', backend_ran: false }), false);
  assert.equal(f.relaySucceeded(null), false);
  // a WHITESPACE-PREFIXED handoff sentinel must still be rejected (not a byte-0-only check).
  assert.equal(f.relaySucceeded({ status_state: 'done', stdout: '\n  MMT_NATIVE_HANDOFF tier=x', backend_ran: true }), false,
    'leading-whitespace handoff sentinel is not success');
  assert.equal(f.relayFailReason({ stdout: '\n  MMT_NATIVE_HANDOFF x' }), 'native-handoff (CLI unavailable/exhausted)',
    'whitespace-prefixed sentinel reports as handoff, not empty output');

  // The real reason is surfaced (no blanket "unavailable").
  assert.equal(f.relayFailReason({ status_state: 'failed', fail_kind: 'timeout' }), 'timeout');
  assert.equal(f.relayFailReason({ status_state: 'failed', fail_kind: 'quota' }), 'quota');
  assert.equal(f.relayFailReason({ status_state: 'failed', fail_kind: '' }), 'backend reported failed');
  assert.equal(f.relayFailReason({ stdout: 'MMT_NATIVE_HANDOFF x' }), 'native-handoff (CLI unavailable/exhausted)');
  assert.equal(f.relayFailReason(null), 'no relay result');
});
