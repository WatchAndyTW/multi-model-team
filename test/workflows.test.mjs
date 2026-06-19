// workflows.test.mjs — port of the oracle's team.mjs determinism + pipeline-structure block.
// Static analysis on workflows/team.mjs (the Ultracode dynamic-workflow fan-out): the Workflow
// runtime forbids Date/random APIs (they break resume), so they must not appear; and the staged
// pipeline + faithful-relay machinery must be present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
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
  // (a) The relay schema must collect the authoritative status-file fields + the sidecar-recovery field.
  for (const m of ['status_state', 'out_chars', 'fail_kind', 'relay_note', 'recovered_stdout', 'out_file']) {
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
  const helpers = [grab('isUsableText'), grab('relayBody'), grab('hasUsableStdout'), grab('relaySucceeded'), grab('relayFailReason')].join('\n') + '\n';
  const f = new Function(helpers + 'return { isUsableText, relayBody, hasUsableStdout, relaySucceeded, relayFailReason };')();

  // status:"done" + stdout overrides backend_ran:false — the core recovery (slow-but-fine CLI run).
  assert.equal(f.relaySucceeded({ status_state: 'done', out_chars: 10, stdout: 'real answer', backend_ran: false }), true);
  // SIDECAR RECOVERY: relay lost its live stdout to a tool timeout, but read out_file back into
  // recovered_stdout — status:"done" + recovered body == success, and relayBody returns the recovered text.
  const recov = { status_state: 'done', out_chars: 99, stdout: '', recovered_stdout: 'the real long answer', backend_ran: false };
  assert.equal(f.relaySucceeded(recov), true, 'recovered_stdout on a done run counts as success');
  assert.equal(f.relayBody(recov), 'the real long answer', 'relayBody returns the recovered sidecar body when stdout is empty');
  // live stdout wins over recovered when both present:
  assert.equal(f.relayBody({ stdout: 'live', recovered_stdout: 'sidecar' }), 'live');
  // a recovered handoff sentinel is still not usable:
  assert.equal(f.relaySucceeded({ status_state: 'done', stdout: '', recovered_stdout: 'MMT_NATIVE_HANDOFF x', backend_ran: false }), false);
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

// ── Regression: writable-mode native fallback resets a half-written worktree before re-implementing ──
// When a CLI is SIGKILLed at hard_timeout in writable mode it may leave PARTIAL files in its worktree.
// The native fallback must reset the worktree to clean HEAD first, so it never builds on corrupt state.
test('team.mjs: writable native fallback resets the worktree to the BASE deterministically (orchestrator, not the solver prompt)', () => {
  // The cleanup is run by a dedicated git plumbing agent (resetWorktree/RESET_SCHEMA) in deterministic
  // code whose ok is CHECKED — NOT left to the free-form native solver's prose (which could skip it).
  // CRITICAL: it resets to INT_BRANCH (the original base), NOT HEAD — a full-auto CLI can leave a PARTIAL
  // COMMIT, so `reset --hard HEAD` would preserve the bad state (codex caught both of these).
  assert.match(SRC, /function resetWorktree\(worktree, label, ph\)/, 'must have a deterministic resetWorktree helper');
  assert.ok(SRC.includes('RESET_SCHEMA'), 'reset agent must report a structured RESET_SCHEMA');
  assert.match(SRC, /git -C \$\{wtArg\} reset --hard \$\{JSON\.stringify\(INT_BRANCH\)\}/,
    'reset must target INT_BRANCH (the base), not HEAD — HEAD may be a partial commit');
  assert.doesNotMatch(SRC, /reset --hard HEAD/, 'must NOT reset to HEAD anywhere (would preserve a partial commit)');
  assert.match(SRC, /git -C \$\{wtArg\} clean -fd/, 'reset must git clean -fd the worktree');
  // path quoting is JSON.stringify (cross-shell — relay may be PowerShell, so NO bash single-quote
  // escaping) AND guarded by a construction-time sanitization assertion (codex-flagged hardening: the
  // safety comes from the path being sanitized at source, asserted here, not from shell quoting alone).
  assert.match(SRC, /const wtArg = JSON\.stringify\(worktree\)/, 'worktree path must be JSON.stringify-quoted (cross-shell)');
  assert.doesNotMatch(SRC, /git -C "\$\{worktree\}"/, 'must not bare-interpolate the worktree path into the shell command');
  // path guard is an exact-SHAPE assertion (not just char-class) + a `..` traversal reject (codex point).
  assert.ok(SRC.includes('.mmt[\\/\\\\]worktrees'), 'resetWorktree must assert the exact .mmt/worktrees/<slug>/<label> shape');
  assert.match(SRC, /\\\.\\\.\(\[/, 'resetWorktree must reject `..` path-traversal segments');
  assert.match(SRC, /unsafe worktree path/, 'an unsafe path must abort the reset, not run git');
  // dispatch() runs the reset BEFORE the native fallback, in writable mode, and ABORTS on failure.
  assert.match(SRC, /if \(WRITABLE && wt\) \{\s*\n\s*const reset = await resetWorktree\(wt, s\.label, ph\)/,
    'dispatch must reset the worktree before the writable native fallback');
  assert.match(SRC, /reset\.ok !== true/, 'dispatch must check the reset succeeded and abort otherwise');
  assert.match(SRC, /MMT_WORKTREE_RESET_FAILED/, 'a failed reset must surface a loud sentinel, not silently continue');
  // dispatchNative no longer takes a cleanFirst flag (cleanup moved to orchestrator code).
  assert.doesNotMatch(SRC, /function dispatchNative\([^)]*cleanFirst/, 'dispatchNative must NOT do its own cleanup');
});

test('team.mjs: reset-to-base actually discards a partial commit + dirty files (real git repo)', () => {
  // Behavioral test (codex's ask): the reset commands the plumbing agent is told to run must, against a
  // REAL repo with a partial commit AND dirty/untracked files, return HEAD to the base and wipe the mess.
  // We run the exact two commands from resetWorktree's prompt (reset --hard <base> ; clean -fd).
  const pjoin = join;
  const repo = mkdtempSync(pjoin(os.tmpdir(), 'mmt-reset-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(pjoin(repo, 'base.txt'), 'base\n');
    git('add', '-A'); git('commit', '-q', '-m', 'base');
    const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // a "base" ref mirroring INT_BRANCH (the reset target, NOT advanced)
    git('branch', 'mmt/base', base);
    // simulate the killed CLI: a PARTIAL COMMIT on top + dirty + untracked files
    writeFileSync(pjoin(repo, 'partial.txt'), 'half\n');
    git('add', '-A'); git('commit', '-q', '-m', 'partial CLI commit');
    writeFileSync(pjoin(repo, 'base.txt'), 'base-MODIFIED\n');       // dirty tracked
    writeFileSync(pjoin(repo, 'junk.txt'), 'untracked\n');           // untracked
    assert.notEqual(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), base, 'precondition: HEAD moved off base');
    // the exact reset resetWorktree instructs:
    git('reset', '--hard', 'mmt/base');
    git('clean', '-fd');
    // assertions: HEAD back at base, partial commit gone, dirty reverted, untracked removed
    assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), base, 'HEAD returned to base (partial commit discarded)');
    assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'worktree is clean (dirty + untracked gone)');
    assert.ok(!existsSync(pjoin(repo, 'partial.txt')), 'partial-commit file gone');
    assert.ok(!existsSync(pjoin(repo, 'junk.txt')), 'untracked file gone');
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('team.mjs: resetWorktree path-safety guard accepts the real shape, rejects metachars + traversal', () => {
  // Mirror the EXACT guard from resetWorktree: an exact-shape match AND a `..`-segment reject. A path is
  // SAFE iff it matches the shape and has no `..` segment.
  const SHAPE = /^\.mmt[\/\\]worktrees[\/\\][A-Za-z0-9._-]+[\/\\][A-Za-z0-9._-]+$/;
  const TRAVERSE = /(^|[\/\\])\.\.([\/\\]|$)/;
  const safe = (p) => SHAPE.test(p) && !TRAVERSE.test(p);
  // real path shapes the workflow constructs (.mmt/worktrees/<slug>/<label>) — must be accepted:
  for (const ok of ['.mmt/worktrees/fix-the-bug/data-model', '.mmt/worktrees/task/sql-report', '.mmt\\worktrees\\t\\a']) {
    assert.equal(safe(ok), true, `real worktree path should pass the guard: ${ok}`);
  }
  // metacharacters, wrong shape, or traversal — must be rejected:
  for (const bad of [
    '.mmt/wt/$(rm -rf x)', '.mmt/worktrees/`id`/x', '.mmt/worktrees/a b/x', ".mmt/worktrees/a'b/x",
    '.mmt/worktrees/a;b/x', '.mmt/worktrees/a$b/x',
    '.mmt/worktrees/x/../../other', '.mmt/worktrees/x',            // traversal / wrong depth
    '/etc/passwd', '.mmt/other/x/y',                               // wrong root
  ]) {
    assert.equal(safe(bad), false, `unsafe worktree path should fail the guard: ${bad}`);
  }
});

// ── Regression: the relay is told it may poll the status file far longer than its own Bash window ──
// hard_timeout (up to 30m) can exceed the relay's 10m Bash-tool cap; the relay must POLL (sleep+read),
// not give up or re-run the node command, for the full hard_timeout window.
test('team.mjs: relay polls the status file for the full hard_timeout window (long-wait hardening)', () => {
  assert.match(SRC, /HARD_TIMEOUT_MS \/ 60000/, 'relay prompt must surface the hard_timeout minute budget');
  assert.match(SRC, /Polling the status file is NOT re-running/, 'relay must distinguish polling from re-running');
  assert.match(SRC, /sleep 30; cat/, 'relay must be given a concrete sleep-and-read poll command');
});
