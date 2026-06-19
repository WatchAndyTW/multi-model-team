#!/usr/bin/env node
// run.mjs — execute a delegation: route -> fallback chain -> backend -> clean output.
//
// Writes HUD state on each hop start/end. On exhaustion (or a native decision) prints a
// native-handoff sentinel so the caller (delegate agent / Opus) solves it in-context.
//
// Parity target: scripts/run.sh (fallback chain + handoff). ESM, Node stdlib only.
//
// Usage:
//   node run.mjs [--preset P] [--tags PATH] [--roster PATH] [--sandbox] [--decision JSON] "<task text>"
//   echo "<task text>" | node run.mjs

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { loadRoster, defaults, backend } from '../lib/config.mjs';
import { decide } from '../lib/router.mjs';
import { invoke, health, clean, invalidateHealth } from '../lib/backends.mjs';
import * as state from '../lib/state.mjs';
import { resolveRosterPath } from '../lib/platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MMT_ROOT = path.resolve(__dirname, '..', '..');

const COMPACT_CONTRACT = 'Return only the result, no preamble.';
const COMPACT_PROMPT = (task) => `${COMPACT_CONTRACT}\n\n${task}`;

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const o = { preset: '', tags: '', roster: '', decision: '', callFile: '', taskFile: '', decisionFile: '', sandbox: false, addDir: '', cwd: '', writable: false, task: '' };
  let i = 0;
  const positional = [];
  while (i < argv.length) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > -1 ? a.slice(0, eq) : a;
    const inlineVal = a.startsWith('--') && eq > -1 ? a.slice(eq + 1) : null;
    const next = () => (inlineVal !== null ? inlineVal : argv[++i]);
    switch (flag) {
      case '--preset':       o.preset = next() ?? ''; break;
      case '--tags':         o.tags = next() ?? ''; break;
      case '--roster':       o.roster = next() ?? ''; break;
      case '--decision':     o.decision = next() ?? ''; break;
      // File transports (shell-agnostic): the Workflow relay can't safely put a heredoc or a
      // single-quoted JSON arg on a command line that may run in PowerShell — both mangle. Instead the
      // relay sub-agent WRITES the payload to a file in .mmt/calls/ (via the Write tool — never a
      // shell), and passes only the PATH on the command line. A path is [A-Za-z0-9_/.\\-] and survives
      // verbatim in BOTH PowerShell and bash; the untrusted task/decision text never appears as
      // parseable shell text. --call-file = one JSON file holding BOTH {decision, task}; --task-file
      // and --decision-file carry them separately (each a raw UTF-8 / JSON file).
      case '--call-file':     o.callFile = next() ?? ''; break;
      case '--task-file':     o.taskFile = next() ?? ''; break;
      case '--decision-file': o.decisionFile = next() ?? ''; break;
      case '--add-dir':      o.addDir = next() ?? ''; break;
      // /team --writable mode: run the backend CLI IN this dir (the subtask's git worktree) and use
      // the backend's writable_extra (full-auto) so it can actually write files there. Both are inert
      // when absent — default/read-only runs are unchanged.
      case '--cwd':          o.cwd = next() ?? ''; break;
      case '--writable':     o.writable = true; break;
      case '--sandbox':      o.sandbox = true; break;
      case '--':             positional.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith('-')) { process.stderr.write(`run.mjs: unknown flag: ${a}\n`); process.exit(2); }
        positional.push(...argv.slice(i)); i = argv.length; break;
    }
    i++;
  }
  if (positional.length) o.task = positional.join(' ');
  return o;
}

// Read a transport file's UTF-8 contents. A missing/unreadable file is a corrupt transport — fail
// loudly (exit 2), never silently dispatch an empty payload to a backend.
function readFileArg(p, flag) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    process.stderr.write(`run.mjs: cannot read ${flag} '${p}': ${sanitizeErr(e && e.message)}\n`);
    process.exit(2);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Code-point count (parity with `wc -m`).
function charCount(s) {
  return [...String(s)].length;
}

// Sanitize a backend's stderr into a short, single-line reason (parity with run.sh):
//   newlines -> spaces, " -> ', tail-truncate to 240 (prefixed with ... when longer).
function sanitizeErr(err) {
  let v = String(err || '').replace(/\n/g, ' ').replace(/"/g, "'");
  if (v.length > 240) v = '...' + v.slice(-240);
  return v;
}

function nativeSentinel(tier, rule, reason) {
  process.stdout.write(`MMT_NATIVE_HANDOFF tier=${tier} rule=${rule} reason="${reason}"\n`);
  process.stdout.write(
    'This task was routed to native Claude (no agy offload). Solve it directly in-context at the indicated tier.\n',
  );
}

// The literal placeholder tokens our command/.md + workflow relay templates use for the task text.
// A relay that fails to substitute the real prompt leaves one of these verbatim in the call file.
// Compared case-insensitively against the FULL trimmed task (a real prompt never equals one of these).
const TASK_PLACEHOLDERS = new Set([
  '<the question text>',
  '<the subtask text>',
  '<the task text>',
  '<text>',
  '<full text>',
  '<task stripped>',
  '<question>',
  '<task>',
]);

// True when the task is (still) an unsubstituted template placeholder — either an exact known token,
// or the leading "<the subtask text, with any Upstream result …>" form whose body the relay didn't fill.
function isUnsubstitutedPlaceholder(task) {
  const t = String(task || '').trim().toLowerCase();
  if (TASK_PLACEHOLDERS.has(t)) return true;
  // The team template's longer placeholder: "<the subtask text, with any Upstream result — <dep>: …>".
  if (/^<the (subtask|question|task) text[\s,]/.test(t)) return true;
  return false;
}

// --- failure logging --------------------------------------------------------
// When a CLI backend call fails (non-zero exit, empty output, or quota/credit limit) the user
// previously saw only a terse one-line stderr buried under the eventual native handoff. This makes
// failures LOUD and DURABLE: a clearly-marked `[mmt] ERROR …` banner on stderr (so the operator
// sees it live) PLUS a structured JSON record appended to .mmt/logs/failures.log (so it can be
// inspected after the fact — pairs with the .mmt/calls/ payload files). The HUD is non-critical, so
// a logging failure is swallowed — it must never break the delegation it's reporting on.
function failuresLogPath() {
  // Project-local .mmt/logs (cwd), independent of the HUD stateDir. Falls back to stateDir if cwd
  // is unwritable. Override with MMT_LOG_DIR.
  const base = process.env.MMT_LOG_DIR || path.join(process.cwd(), '.mmt', 'logs');
  return path.join(base, 'failures.log');
}

// --- progress heartbeat + status file ---------------------------------------
// A CLI backend can legitimately take minutes (agy/codex on a hard task). The OLD behaviour gave the
// orchestrator no signal that a slow call was still ALIVE — so a Claude-side poll that timed out at
// ~15s looked like a failure even though the CLI answered seconds later. While a call is in flight
// run.mjs now (a) emits a `[mmt] …still running (Ns)` heartbeat to stderr every HEARTBEAT_MS, and
// (b) maintains a status file at .mmt/calls/<callId>.status.json the orchestrator can poll —
// {state:"running"|"done"|"failed", backend, elapsed_ms, ...}. This makes "slow but alive"
// distinguishable from "dead" without shortening the (generous) hard_timeout. All best-effort: a
// status/heartbeat write that fails NEVER affects the actual dispatch.
const HEARTBEAT_MS = 10_000;

// Resolve the status-file path. PREDICTABLE so the orchestrator can poll it: when a --call-file was
// used, it is "<call-file>.status.json" (sits right next to the payload the relay wrote). Otherwise
// it falls back to .mmt/calls/<callId>.status.json (or MMT_LOG_DIR's parent /calls when set).
function statusFilePath(callId, callFile) {
  if (callFile) return `${callFile}.status.json`;
  const base = process.env.MMT_LOG_DIR ? path.dirname(process.env.MMT_LOG_DIR) : path.join(process.cwd(), '.mmt');
  return path.join(base, 'calls', `${callId}.status.json`);
}

// Sidecar OUTPUT file path (sits next to the status file): "<call-file>.out.txt" (or
// .mmt/calls/<callId>.out.txt). On a successful dispatch run.mjs persists the cleaned stdout HERE so a
// relay/orchestrator that LOST the live stdout — e.g. its own Bash-tool window timed out at 10min on a
// 10-30min CLI job while run.mjs kept running to hard_timeout — can still RECOVER the real result from
// disk. Without this, a slow-but-successful run reports state:"done" with no recoverable body and the
// orchestrator wrongly falls back to native (the gap codex caught in the 30m-timeout design).
function outFilePath(callId, callFile) {
  if (callFile) return `${callFile}.out.txt`;
  const base = process.env.MMT_LOG_DIR ? path.dirname(process.env.MMT_LOG_DIR) : path.join(process.cwd(), '.mmt');
  return path.join(base, 'calls', `${callId}.out.txt`);
}

function writeOutFile(outFile, data) {
  if (!outFile) return false;
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, data, 'utf8');
    return true;
  } catch { return false; } // sidecar is recovery-only — never break the run if it can't be written
}

function writeStatus(statusFile, callId, obj) {
  if (!statusFile) return;
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify({ callId, updated: new Date().toISOString(), ...obj }) + '\n', 'utf8');
  } catch { /* status is observability-only — never break the run */ }
}

// Start a heartbeat for a backend call. Returns a stop(finalObj) that clears the timer and writes the
// terminal status. Writes an initial "running" status immediately so a poll right after spawn sees it.
function startHeartbeat({ callId, statusFile, backend: be, model, tier, rule, startMs }) {
  writeStatus(statusFile, callId, { state: 'running', backend: be, model, tier, rule, elapsed_ms: 0 });
  const tick = () => {
    // Best-effort: a heartbeat must NEVER throw out of the interval callback (an uncaught throw there
    // is an unhandledException). Guard the stderr write (EPIPE/closed stream) and the status write.
    try {
      const elapsed = Date.now() - startMs;
      const secs = Math.round(elapsed / 1000);
      try { process.stderr.write(`[mmt] backend '${be}' still running (${secs}s)… [call=${callId}]\n`); } catch { /* stderr closed/EPIPE */ }
      writeStatus(statusFile, callId, { state: 'running', backend: be, model, tier, rule, elapsed_ms: elapsed });
    } catch { /* heartbeat is observability-only — never affect the dispatch */ }
  };
  const timer = setInterval(tick, HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return function stop(finalObj) {
    clearInterval(timer);
    writeStatus(statusFile, callId, { backend: be, model, tier, rule, ...finalObj });
  };
}

function logFailure({ backend: be, model, tier, rule, code, durMs, stderr, kind, callId }) {
  // 1. Loud, human-readable stderr banner (always — even if the file write fails).
  const why = sanitizeErr(stderr) || `exit ${code}`;
  process.stderr.write(
    `[mmt] ERROR: backend '${be}' (${kind}) failed — ${why} ` +
    `[rule=${rule} tier=${tier}${durMs != null ? ` ${durMs}ms` : ''} call=${callId}]\n`,
  );
  // 2. Durable structured record (best-effort; never throws).
  try {
    const file = failuresLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = {
      ts: new Date().toISOString(),
      callId, backend: be, model, tier, rule, kind, code,
      durMs: durMs ?? null,
      error: sanitizeErr(stderr),
    };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* logging is non-critical — never break the run */ }
}

// Resolve tier -> concrete model from a backend cfg's model_tiers.
function modelForTier(beCfg, tier) {
  const tiers = beCfg.model_tiers || {};
  // 'cheap'/'standard' are the canonical keys; a tier label maps to standard unless it's the cheap one.
  const m = tiers[tier] || tiers.standard || tiers.cheap || '';
  return m;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // --call-file holds BOTH the decision and the task as one JSON object: { decision, task }. It is
  // resolved first so it can seed both. --task-file / --decision-file carry them separately. Inline
  // --task / positional / stdin remain for direct CLI use.
  let callPayload = null;
  if (opts.callFile) {
    const raw = readFileArg(opts.callFile, '--call-file');
    try {
      callPayload = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`run.mjs: invalid JSON in --call-file '${opts.callFile}': ${sanitizeErr(e && e.message)}\n`);
      process.exit(2);
    }
  }

  let task = opts.task;
  const fromFile = opts.callFile || opts.taskFile;   // a relay transport, not an interactive call
  if (!task && opts.taskFile) task = readFileArg(opts.taskFile, '--task-file');
  if (!task && callPayload && typeof callPayload.task === 'string') task = callPayload.task;
  // A --call-file / --task-file is a relay transport: if it carries no usable task, fail LOUD (exit 2)
  // rather than silently falling through to stdin (which would block on a non-TTY or emit a confusing
  // "no task text"). A corrupt/empty relay payload must surface as an error. Use .trim() so a
  // whitespace-only task ("   ") — also non-usable — is rejected, not dispatched as blank.
  if (fromFile && !String(task ?? '').trim()) {
    process.stderr.write(`run.mjs: ${opts.callFile ? '--call-file' : '--task-file'} '${fromFile}' has no usable "task" field\n`);
    process.exit(2);
  }
  // Unsubstituted-placeholder guard. A relay agent that copies a command/.md template VERBATIM leaves
  // the literal placeholder (e.g. "<the question text>") in the call file — non-empty, so the check
  // above misses it, and the backend would otherwise run on meaningless text and "refuse". Reject the
  // exact placeholder tokens our own templates use so the relay reports backend_ran:false and the
  // workflow does a VISIBLE native fallback instead of a silent garbage run. Matched only when the
  // whole task IS the placeholder (a real prompt never equals "<the question text>").
  if (fromFile && isUnsubstitutedPlaceholder(task)) {
    process.stderr.write(
      `run.mjs: ${opts.callFile ? '--call-file' : '--task-file'} '${fromFile}' still contains an ` +
      `unsubstituted template placeholder ("${task.trim().slice(0, 60)}") — the relay did not insert the ` +
      `real task text. Aborting so it is not dispatched as garbage.\n`,
    );
    process.exit(2);
  }
  if (!task) task = (await readStdin()).trim();
  if (!task) { process.stderr.write('run.mjs: no task text\n'); process.exit(2); }

  // Writable-mode inputs: a --cwd (the subtask's worktree) + --writable (full-auto). The relay may
  // carry them in the call file too; the explicit flag wins. Both inert when absent (default lane).
  const cwd = opts.cwd || (callPayload && typeof callPayload.cwd === 'string' ? callPayload.cwd : '');
  const writable = opts.writable || !!(callPayload && callPayload.writable);

  // --roster flag wins; else shared resolver: .mmt/roster.json (cwd) > ~/.claude/mmt-roster.json > plugin default.
  const rosterPath = opts.roster || resolveRosterPath(MMT_ROOT);
  const tagsPath = opts.tags || path.join(MMT_ROOT, 'config', 'tags.txt');

  let roster;
  try {
    roster = loadRoster(rosterPath);
  } catch (e) {
    // Fail closed to native if the roster is unreadable.
    nativeSentinel('sonnet', 'no-roster', `roster load failed: ${sanitizeErr(e && e.message)}`);
    process.exit(0);
  }

  // ---- 1. Decision -----------------------------------------------------------
  // Safe native defaults survive any decision failure (fail closed — never fall open to agy).
  let decision = { backend: 'native', model: 'native:sonnet', tier: 'sonnet', rule: 'catch-all-safe', native: true };
  // Forced-decision precedence (file transports win over inline): --decision-file > --call-file's
  // .decision > inline --decision. A file's contents are a JSON string; --call-file's .decision may
  // already be a parsed object (it lived inside the call JSON).
  let forcedDecision = '';
  let forcedDecisionObj = null;
  if (opts.decisionFile) {
    forcedDecision = readFileArg(opts.decisionFile, '--decision-file');
  } else if (callPayload && callPayload.decision != null) {
    if (typeof callPayload.decision === 'object') forcedDecisionObj = callPayload.decision;
    else forcedDecision = String(callPayload.decision);
  } else if (opts.decision) {
    forcedDecision = opts.decision;
  }
  if (forcedDecision || forcedDecisionObj) {
    try {
      const d = forcedDecisionObj || JSON.parse(forcedDecision);
      decision = {
        backend: d.backend || 'native',
        model: d.model || 'native:sonnet',
        tier: d.tier || 'sonnet',
        rule: d.rule || 'catch-all-safe',
        native: !!d.native,
      };
    } catch {
      // bad forced decision JSON -> keep safe native defaults (fail closed).
    }
  } else {
    try {
      const d = decide({ task, roster, tagsPath, preset: opts.preset || undefined });
      if (d && d.backend) decision = d;
    } catch {
      // router error -> safe native defaults survive.
    }
  }
  // Belt-and-suspenders: an empty backend must never fail open to agy.
  if (!decision.backend) { decision.backend = 'native'; decision.native = true; }

  const D_tier = decision.tier || 'sonnet';
  const D_rule = decision.rule || 'catch-all-safe';

  // ---- 2. Native decision -> immediate handoff -------------------------------
  if (decision.native || decision.backend === 'native' || String(decision.backend).startsWith('native:')) {
    nativeSentinel(D_tier, D_rule, 'router selected native backend');
    process.exit(0);
  }

  // ---- 3. Build fallback chain: chosen backend + quota_fallback (deduped) -----
  const dfl = (() => { try { return defaults(roster) || {}; } catch { return {}; } })();
  const quotaFallback = Array.isArray(dfl.quota_fallback) ? dfl.quota_fallback : [];
  const defaultFallback = dfl.fallback || 'native:sonnet';

  const chain = [decision.backend];
  for (const e of quotaFallback) if (!chain.includes(e)) chain.push(e);

  const fullPrompt = COMPACT_PROMPT(task);
  const inChars = charCount(task);
  const callId = randomUUID().replace(/-/g, '').slice(0, 8);
  // Predictable status path so the orchestrator can poll it (next to the call file when given).
  const statusFile = statusFilePath(callId, opts.callFile);
  const outFile = outFilePath(callId, opts.callFile);

  // ---- 4. Walk the chain -----------------------------------------------------
  let lastErr = ''; // short, sanitized reason from the last backend that actually failed
  let fallbackCount = 0;

  for (const entry of chain) {
    if (entry === 'native' || String(entry).startsWith('native:')) {
      let tier = entry === 'native' ? '' : String(entry).slice('native:'.length);
      tier = tier || D_tier;
      const reason = `backend options exhausted; falling back to native${lastErr ? ` (last error: ${lastErr})` : ''}`;
      nativeSentinel(tier, D_rule, reason);
      process.exit(0);
    }

    const be = entry;
    let beCfg;
    try {
      beCfg = backend(roster, be);
    } catch {
      process.stderr.write(`run.mjs: cannot load backend '${be}' (skipped)\n`);
      fallbackCount++; continue;
    }
    if (!beCfg || !beCfg.enabled) {
      process.stderr.write(`run.mjs: backend '${be}' disabled or unknown (skipped)\n`);
      fallbackCount++; continue;
    }

    // Optional --sandbox: append the backend's sandbox flag for this hop only. Skipped when the
    // backend defines no single-flag sandbox (e.g. codex, already `-s read-only`).
    let invokeCfg = beCfg;
    if (opts.sandbox && beCfg.sandbox_flag) {
      invokeCfg = { ...beCfg, extra: [...(beCfg.extra || []), beCfg.sandbox_flag] };
    }

    let model = modelForTier(beCfg, D_tier) || modelForTier(beCfg, 'standard');

    // Health-gate: an unhealthy backend (or a kind with no invoker) is skipped. This used to be a
    // SILENT skip — no lastErr, no failures.log, no status record — so a backend that failed its
    // `--version` probe vanished into a bare "backend options exhausted" handoff with zero
    // diagnostics. That made transient probe misses look like random "the CLI refused to run"
    // failures. Now a health skip is LOUD: it names the cause in lastErr (→ handoff reason), appends
    // to failures.log, and writes a `failed` status record the orchestrator can poll.
    let healthy = false;
    let healthErr = '';
    try { healthy = await health(beCfg); } catch (e) { healthy = false; healthErr = String(e && e.message || e); }
    if (!healthy) {
      const why = sanitizeErr(healthErr) || `'${be}' version probe failed (binary missing, not authed, or probe timed out)`;
      lastErr = `'${be}' health check failed${healthErr ? ` (${sanitizeErr(healthErr)})` : ''}`;
      writeStatus(statusFile, callId, { state: 'failed', backend: be, model, tier: D_tier, rule: D_rule, kind: 'health', code: 127, elapsed_ms: 0 });
      logFailure({ backend: be, model, tier: D_tier, rule: D_rule, code: 127, durMs: 0, stderr: why, kind: 'health', callId });
      fallbackCount++; continue;
    }

    state.start({ id: callId, backend: be, model, rule: D_rule, inChars });
    const startMs = Date.now();
    // Heartbeat: emit "still running" to stderr + status file while the (possibly slow) CLI works,
    // so the orchestrator can tell alive-but-slow from dead. Always stopped below (every branch).
    const stopHeartbeat = startHeartbeat({ callId, statusFile, backend: be, model, tier: D_tier, rule: D_rule, startMs });
    let res;
    try {
      res = await invoke(invokeCfg, fullPrompt, { model, tier: D_tier, addDir: opts.addDir, cwd, writable });
    } catch (e) {
      res = { ok: false, stdout: '', stderr: String(e && e.message || e), code: 1, quota: false };
    }
    const durMs = Date.now() - startMs;
    const cleanOut = clean(res.stdout || '');
    const outChars = charCount(cleanOut);

    // quota/credit exhaustion -> next hop. A FAILED hop passes fallback:0 (it is not itself a
    // fallback); the single fallback tally is counted once on the success hop via fallbackCount.
    if (res.quota) {
      lastErr = `quota/credit limit on '${be}'`;
      stopHeartbeat({ state: 'failed', kind: 'quota', code: res.code, elapsed_ms: durMs });
      logFailure({ backend: be, model, tier: D_tier, rule: D_rule, code: res.code, durMs,
        stderr: res.stderr || 'quota/credit limit reached', kind: 'quota', callId });
      state.end({ id: callId, backend: be, model, rule: D_rule, code: res.code, durMs, outChars, fallback: 0 });
      fallbackCount++; continue;
    }

    // non-zero exit OR empty clean output -> surface + sanitize stderr, next hop. Drop this backend's
    // cached health so a later call re-probes it instead of trusting a now-stale "healthy" verdict.
    if (res.code !== 0 || !cleanOut) {
      // Surface a hard_timeout SIGKILL as a distinct `timeout` (not a generic nonzero-exit) so a
      // backend that ran out of time is diagnosable — the relay/operator can tell "the CLI was too
      // slow" from "the CLI errored". res.timedOut is AUTHORITATIVE (set by runChild/runPty when their
      // own timer fired); a genuine CLI exit 124 is therefore NOT misclassified as a timeout.
      const timedOut = res.timedOut === true;
      const kind = timedOut ? 'timeout' : (res.code !== 0 ? 'nonzero-exit' : 'empty-output');
      lastErr = timedOut
        ? `'${be}' timed out after ${Math.round(durMs / 1000)}s (raise backends.${be}.hard_timeout if it needs longer)`
        : (sanitizeErr(res.stderr) || `exit ${res.code}, empty output`);
      stopHeartbeat({ state: 'failed', kind, code: res.code, elapsed_ms: durMs });
      logFailure({ backend: be, model, tier: D_tier, rule: D_rule, code: res.code, durMs,
        stderr: timedOut
          ? `timed out after ${durMs}ms (hard_timeout exceeded)`
          : (res.stderr || `no usable output (exit ${res.code})`),
        kind, callId });
      invalidateHealth(beCfg);
      state.end({ id: callId, backend: be, model, rule: D_rule, code: res.code, durMs, outChars, fallback: 0 });
      fallbackCount++; continue;
    }

    // success. Approximate cost (USD micros) from the backend's per-1k-OUTPUT-char rate × outChars —
    // a rough HUD figure only (chars, not tokens), matching roster.json's "per 1000 output chars"
    // note. Missing/zero rate -> 0 cost.
    const rate = Number(beCfg.cost_per_1k_chars) || 0;
    const costMicros = Math.round(rate * (outChars / 1000) * 1e6);
    // Persist the cleaned output to the sidecar BEFORE writing the terminal status, so a reader that
    // sees state:"done" can always find the body at out_file (recovery path for a relay that lost its
    // live stdout to its own tool timeout). Record whether the sidecar was written + its path.
    const outWritten = writeOutFile(outFile, cleanOut);
    stopHeartbeat({ state: 'done', code: 0, elapsed_ms: durMs, out_chars: outChars, out_file: outWritten ? outFile : '' });
    state.end({ id: callId, backend: be, model, rule: D_rule, code: 0, durMs, outChars, fallback: fallbackCount, costMicros });
    process.stdout.write(cleanOut + '\n');
    process.exit(0);
  }

  // ---- 5. Everything exhausted -> guaranteed native fallback -----------------
  const tier = defaultFallback.startsWith('native:') ? defaultFallback.slice('native:'.length) : D_tier;
  const reason = `all backends exhausted${lastErr ? ` (last error: ${lastErr})` : ''}`;
  nativeSentinel(tier, D_rule, reason);
  process.exit(0);
}

main().catch((e) => {
  // Last-resort fail-closed handoff; never crash into a non-handoff state.
  process.stderr.write(`run.mjs: fatal: ${String(e && e.stack || e)}\n`);
  nativeSentinel('sonnet', 'fatal', `run.mjs fatal: ${sanitizeErr(e && e.message)}`);
  process.exit(0);
});
