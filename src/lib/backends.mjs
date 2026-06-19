// backends.mjs — backend invokers (ESM port of scripts/lib/backends.sh; native-authored).
//
// Parity target: scripts/lib/backends.sh (_mmt_invoke_gemini / _mmt_invoke_codex / mmt_clean /
// mmt_quota_exhausted / _mmt_health_*) and PROBES.md (the agy TTY/winpty quirk).
//
// Dispatch is on backendCfg.kind: 'gemini' (agy) | 'codex'. Unknown kind -> {ok:false,code:127}.
//
// THE agy QUIRK (PROBES.md): the gemini CLI gates output on isatty(stdout). Run through a pipe it
// exits 0 and prints NOTHING. Two things are required for it to emit:
//   1. wrap the argv in a PTY wrapper (winpty on win32) — handled by platform.ptyWrap.
//   2. give it an OPEN, IDLE stdin held open until the child exits — agy emits nothing on EOF stdin
//      (/dev/null or a drained pipe). The bash original held a mkfifo open with a background sleep;
//      here we simply create the child's stdin as a 'pipe' and never .end() it until the child exits.
// codex needs neither: it is non-interactive, prints the final message to stdout, exits cleanly.
//
// Zero runtime deps (Node stdlib only). Runs on win32 / linux / darwin.

import Module, { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import * as platform from './platform.mjs';

// Health-check TTL memoization — health() is called on EVERY fallback-chain hop in run.mjs; without
// caching that re-spawns `<bin> --version` each time. Cache the boolean per backend for HEALTH_TTL_MS.
const _healthCache = new Map();
const HEALTH_TTL_MS = 60_000;

function _healthKey(backendCfg) {
  return (backendCfg?.kind || '') + ':' + (backendCfg?.cmd || '');
}

// node-pty resolution: plugin-local install first, then a GLOBAL `npm install -g node-pty` via the
// NODE_PATH shim (ensureGlobalNodeModules). createRequire is used instead of ESM import() because
// NODE_PATH only affects CommonJS require() resolution — this is the same trick oh-my-claudecode uses
// to resolve native deps (better-sqlite3 / @ast-grep/napi) from global modules without a local install.
const _require = createRequire(import.meta.url);
let _globalPathInitialized = false;
function ensureGlobalNodeModules() {
  if (_globalPathInitialized) return;
  _globalPathInitialized = true;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
    if (!root) return;
    const sep = process.platform === 'win32' ? ';' : ':';
    const cur = process.env.NODE_PATH || '';
    if (!cur.split(sep).filter(Boolean).includes(root)) {
      process.env.NODE_PATH = root + (cur ? sep + cur : '');
      Module._initPaths();
    }
  } catch { /* npm unavailable — node-pty must resolve locally, else the agy lane degrades to fallback */ }
}
// Load node-pty: try local resolution, then fall back to the global-modules shim.
function loadPty() {
  try { return _require('node-pty'); }
  catch { ensureGlobalNodeModules(); return _require('node-pty'); }
}
// Whether node-pty is resolvable (local or global). Memoized. Drives the POSIX fallback: on Linux/
// macOS without node-pty we can still give agy a tty via the dep-free system `script` utility, so
// node-pty is OPTIONAL there. On Windows node-pty is required (winpty can't allocate a console from a
// headless parent — see the agy history in CLAUDE.md), with no `script` equivalent.
let _ptyAvailable = null;
function ptyAvailable() {
  if (_ptyAvailable !== null) return _ptyAvailable;
  try { loadPty(); _ptyAvailable = true; } catch { _ptyAvailable = false; }
  return _ptyAvailable;
}

// agy default bin candidates per-OS (passed to platform.resolveBinary; ~ / $LOCALAPPDATA / $HOME
// expansion happens there). PROBES.md: win32 path is %LOCALAPPDATA%/agy/bin/agy.exe.
function agyCandidates() {
  switch (platform.PLATFORM) {
    case 'win32':
      return ['$LOCALAPPDATA/agy/bin/agy.exe', '$HOME/AppData/Local/agy/bin/agy.exe'];
    case 'darwin':
      return ['~/.local/bin/agy', '/opt/homebrew/bin/agy', '/usr/local/bin/agy', '/usr/bin/agy'];
    case 'linux':
    default:
      return ['~/.local/bin/agy', '/usr/local/bin/agy', '/usr/bin/agy'];
  }
}

// Parse a hard_timeout that may be a number (ms) or a `coreutils timeout` duration string
// ("15m", "300s", "90", "1.5h"). Returns ms. Default 15 minutes — generous, so a heavy /team
// --writable job isn't SIGKILLed mid-run (the shipped roster sets 15m explicitly; this covers a
// roster that omits hard_timeout).
function timeoutMs(raw) {
  const DEFAULT = 15 * 60 * 1000;
  if (raw == null || raw === '') return DEFAULT;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 0 ? raw : DEFAULT;
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) return DEFAULT;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT;
  const mult = { '': 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * mult[(m[2] || '').toLowerCase()]);
}

// Read normalized fields from a backend cfg, tolerating BOTH the raw roster.json shape
// (oneshot_flag / model_flag / models{cheap,standard} / extra) AND the config.mjs-normalized
// shape (print_flag / model_tiers{cheap,standard} / extra). This keeps backends.mjs working
// against either, since config.mjs is a sibling worker.
function field(cfg, ...names) {
  for (const n of names) {
    if (cfg && cfg[n] !== undefined && cfg[n] !== null) return cfg[n];
  }
  return undefined;
}

function modelForTier(cfg, tier) {
  const tiers = field(cfg, 'model_tiers', 'models') || {};
  if (tier === 'cheap' && tiers.cheap) return tiers.cheap;
  // standard is the default for anything that isn't an explicit 'cheap'.
  return tiers.standard || '';
}

function asArray(v) {
  return Array.isArray(v) ? v.slice() : [];
}

// Pick the flag set for this invocation: in /team --writable mode use the backend's `writable_extra`
// (full-auto — the CLI may write files / run commands in its worktree cwd) when present; otherwise
// (and in the default read-only lane) use `extra`. A backend with no writable_extra simply reuses
// `extra`, so opting a backend out of the writable lane is a config no-op (no behaviour change).
function invocationExtra(cfg, writable) {
  if (writable) {
    const we = field(cfg, 'writable_extra');
    if (Array.isArray(we)) return we.slice();
    // Writable was requested but this backend has no writable_extra. Falling back to `extra` would
    // SILENTLY run read-only (the agent can't write), defeating writable mode — so signal it loudly
    // rather than fail mysteriously downstream when no files change.
    process.stderr.write(
      `[mmt] WARNING: writable mode requested but backend '${field(cfg, 'kind') || field(cfg, 'cmd') || '?'}' ` +
      `has no writable_extra — using read-only flags; the agent likely will NOT be able to write.\n`,
    );
  }
  return asArray(field(cfg, 'extra'));
}

// Windows can't spawn a .cmd/.bat directly — Node throws EINVAL (CVE-2024-27980 hardening). Route
// such argv through `cmd.exe /d /s /c` with the args as an ARRAY (Node quotes them), which avoids
// shell:true (DEP0190 — unescaped concatenation). agy/.exe and all posix argv pass through untouched.
// NOTE: cmd.exe still expands %VAR% inside quoted args; a literal % in a prompt is a rare edge for
// codex review/test prompts — exercised by a manual live smoke test against the real CLI, not the
// offline suite (there is no automated live-test gate).
function winCmdWrap(argv) {
  if (!platform.isWindows() || !Array.isArray(argv) || argv.length === 0) return argv;
  const [cmd, ...rest] = argv;
  if (!/\.(cmd|bat)$/i.test(String(cmd))) return argv;
  const comspec = process.env.ComSpec || 'cmd.exe';
  return [comspec, '/d', '/s', '/c', cmd, ...rest];
}

// Spawn a child, capture stdout/stderr, enforce a hard timeout (SIGKILL on expiry), and control
// the stdin lifecycle. When keepStdinOpen is true the stdin pipe is created but NEVER ended until
// the child exits — this is the agy "open, idle stdin" requirement (replaces the bash held-open
// FIFO). When false, stdin is closed immediately (codex: equivalent to </dev/null).
function runChild(argv, { hardTimeout, keepStdinOpen, stdinData, env, cwd }) {
  return new Promise((resolve) => {
    const [cmd, ...args] = winCmdWrap(argv);
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
        // cwd: in /team --writable mode this is the subtask's git worktree, so the CLI writes there.
        // Undefined -> inherit the parent's cwd (read-only/default behaviour, unchanged).
        ...(cwd ? { cwd } : {}),
      });
    } catch (err) {
      resolve({ stdout: '', stderr: String(err && err.message ? err.message : err), code: 127, spawnError: true });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, hardTimeout);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    // stdin lifecycle. Both modes leave the pipe writable but write nothing (idle).
    // keepStdinOpen: hold it open until exit (agy). Otherwise: close now (codex = EOF/devnull).
    if (child.stdin) {
      child.stdin.on('error', () => { /* EPIPE if child closes stdin first — ignore */ });
      if (stdinData != null) {
        // Deliver the prompt via stdin (codex `-`): avoids passing a multi-line prompt as a cmd.exe
        // arg on Windows (truncates at the first newline; expands %VAR%). Write the payload then EOF.
        try { child.stdin.end(String(stdinData)); } catch { /* ignore */ }
      } else if (!keepStdinOpen) {
        try { child.stdin.end(); } catch { /* ignore */ }
      }
      // keepStdinOpen (no data): intentionally do NOT end() — closed in the exit handler below.
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (keepStdinOpen && child.stdin && !child.stdin.destroyed) {
        try { child.stdin.end(); } catch { /* ignore */ }
      }
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        code: typeof code === 'number' ? code : (timedOut ? 124 : 1),
        timedOut,
      });
    };

    child.on('error', (err) => {
      // ENOENT etc. — treat like the bash "no invoker / not found" path (127).
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: '', stderr: String(err && err.message ? err.message : err), code: 127, spawnError: true });
    });

    child.on('close', (code, signal) => {
      // coreutils `timeout` reports 124 on a timed-out kill; mirror that for parity.
      if (timedOut) { finish(124); return; }
      if (code == null && signal) { finish(1); return; }
      finish(code);
    });
  });
}

// runPty — run a child under a real pseudo-terminal via node-pty (ConPTY on win32, forkpty on posix),
// so a child that gates on isatty(stdout) (agy) still emits — with no visible console, even from a
// fully headless parent. node-pty is LAZY-imported so the rest of backends.mjs (codex/health/clean/
// quota) still loads if the native module is missing; only the agy lane needs it. A pty is ONE merged
// stream (stdout+stderr); clean() strips the terminal control bytes. Wide cols avoid hard-wrapping the
// answer. Returns { stdout, stderr:'', code } — the same shape runChild resolves.
async function runPty(file, args, { hardTimeout = 15 * 60 * 1000, cols = 200, rows = 50, env, cwd } = {}) {
  let pty;
  try {
    pty = loadPty();
  } catch (e) {
    // node-pty not resolvable locally OR globally — return a failure so run.mjs falls back to the
    // next backend (codex/native), with a helpful install hint carried in the handoff reason.
    return { stdout: '', stderr: `node-pty unavailable (${(e && e.message) || e}); install with: npm install -g node-pty`, code: 127 };
  }
  return new Promise((resolve) => {
    let proc;
    try {
      proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: cwd || process.cwd(), env: env ? { ...process.env, ...env } : process.env });
    } catch (e) {
      resolve({ stdout: '', stderr: String((e && e.message) || e), code: 127 });
      return;
    }
    const chunks = [];
    let settled = false;
    let timedOut = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // timedOut is the AUTHORITATIVE signal (a genuine CLI exit 124 is NOT a timeout); code 124 is
      // just the conventional sentinel mirrored for parity with runChild / coreutils `timeout`.
      resolve({ stdout: chunks.join(''), stderr: '', code: typeof code === 'number' ? code : 1, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* ignore */ } finish(124); }, hardTimeout);
    if (typeof timer.unref === 'function') timer.unref();
    proc.onData((d) => chunks.push(d));
    proc.onExit(({ exitCode }) => finish(exitCode));
  });
}

// --- gemini (agy) ------------------------------------------------------------
async function invokeGemini(cfg, prompt, opts) {
  const bin = platform.resolveBinary('agy', {
    envVar: process.env.MMT_BE_BIN ? 'MMT_BE_BIN' : (process.env.MMT_AGY_BIN ? 'MMT_AGY_BIN' : undefined),
    candidates: [...asArray(field(cfg, 'bin_candidates')), ...agyCandidates()],
  });

  const printFlag = field(cfg, 'print_flag', 'oneshot_flag') || '--print';
  const modelFlag = field(cfg, 'model_flag') || '--model';
  const addDirFlag = field(cfg, 'add_dir_flag') || '--add-dir';
  const model = opts.model || modelForTier(cfg, opts.tier);
  const addDir = opts.addDir || opts.add_dir || '';

  // agy gates output on isatty(stdout). node-pty gives it a REAL pseudo-terminal cross-platform
  // (ConPTY on win32, forkpty on posix) so isatty is true and agy emits — with no visible console,
  // working even from a fully headless parent (Bash-tool / hook / sub-agent). This replaces the
  // winpty+console-spawn approach, which could not allocate a console with non-zero dims from a
  // console-less parent. The prompt rides as a real argv ELEMENT (node-pty passes argv to the child,
  // never via a shell) — injection-safe. The pty merges stdout+stderr into one stream.
  //   args order (parity with the bash invoker): [print_flag, prompt, model_flag, model, ...extra, add_dir_flag, add_dir]
  const args = [printFlag, prompt];
  if (model) args.push(modelFlag, model);
  args.push(...invocationExtra(cfg, opts.writable));
  if (addDir) args.push(addDirFlag, addDir);

  // agy (Gemini CLI) refuses to run in an untrusted directory unless the workspace is trusted. In a
  // headless/print run there is no interactive trust prompt, so without this it exits non-zero with
  // no output. The CLI has NO `--skip-trust` flag (that errors "flag not defined"); the supported
  // knob is the GEMINI_CLI_TRUST_WORKSPACE env var. Default it to "true" but let an explicit caller
  // env override stand.
  const trustEnv = { GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE || 'true' };

  // cwd: in /team --writable mode this is the subtask's git worktree, so agy writes there.
  const cwd = opts.cwd || undefined;
  const hardTimeout = timeoutMs(field(cfg, 'hard_timeout'));
  let res;
  if (platform.isWindows() || ptyAvailable()) {
    // node-pty path: REQUIRED on Windows (ConPTY — winpty can't allocate a console from a headless
    // parent); PREFERRED on POSIX when present (forkpty, uniform mechanism).
    try {
      res = await runPty(bin, args, { hardTimeout, env: trustEnv, cwd });
    } catch (e) {
      res = { stdout: '', stderr: String((e && e.message) || e), code: 127 };
    }
  } else {
    // POSIX WITHOUT node-pty: fall back to the dep-free system `script` pty wrapper (platform.ptyWrap
    // -> `script -qec '…'` on linux / `script -q /dev/null …` on darwin). agy runs under script's pty
    // so isatty(stdout) is true — no native module needed on Linux/macOS.
    const wrapped = platform.ptyWrap([bin, ...args], { needTty: field(cfg, 'use_winpty') !== false });
    res = await runChild(wrapped.argv, { hardTimeout, keepStdinOpen: true, env: trustEnv, cwd });
  }

  const cleaned = clean(res.stdout);
  // ok = exited 0 AND produced usable (non-empty) cleaned stdout. An empty result is the classic
  // agy "silent no-op" — treat as failure so run.sh falls through (parity with run.sh contract).
  const ok = res.code === 0 && cleaned.length > 0;
  // quota is gated on FAILURE (see quotaFromResult): a successful answer is never exhaustion, even
  // if its prose happens to contain "quota"/"429"/… (e.g. agy summarizing a doc about rate limits).
  const quota = quotaFromResult(res, cleaned, asArray(field(cfg, 'quota_patterns')), asArray(field(cfg, 'quota_exit_codes')));
  return { ok, stdout: cleaned, stderr: res.stderr, code: res.code, quota, timedOut: !!res.timedOut };
}

// --- codex (OpenAI Codex CLI) ------------------------------------------------
async function invokeCodex(cfg, prompt, opts) {
  const bin = platform.resolveBinary('codex', {
    envVar: process.env.MMT_BE_BIN ? 'MMT_BE_BIN' : undefined,
    candidates: asArray(field(cfg, 'bin_candidates')),
  });

  const oneshot = field(cfg, 'oneshot_flag') || 'exec';
  const modelFlag = field(cfg, 'model_flag') || '-m';
  const addDirFlag = field(cfg, 'add_dir_flag') || '--add-dir';
  const model = opts.model || modelForTier(cfg, opts.tier);
  const addDir = opts.addDir || opts.add_dir || '';

  // Parity with backends.sh _mmt_invoke_codex, with one cross-platform fix: the PROMPT is delivered
  // via STDIN using codex's `-` sentinel ("instructions are read from stdin"), NOT as an argv element.
  // On Windows codex is a .cmd shim spawned through cmd.exe, which truncates a multi-line arg at the
  // first newline (COMPACT_PROMPT adds \n\n) and expands %VAR%; stdin sidesteps both entirely.
  //   [bin, exec, ...extra(`-s read-only`, or writable_extra in --writable mode), (-m model)?, (--add-dir dir)?, '-']  + prompt on stdin
  const argv = [bin, oneshot, ...invocationExtra(cfg, opts.writable)];
  if (model) argv.push(modelFlag, model);
  if (addDir) argv.push(addDirFlag, addDir);
  argv.push('-');

  // cwd: in /team --writable mode this is the subtask's git worktree, so codex's writes (full-auto)
  // land there. A worktree IS a git repo, so the writable_extra drops --skip-git-repo-check.
  const res = await runChild(argv, {
    hardTimeout: timeoutMs(field(cfg, 'hard_timeout')),
    stdinData: prompt,
    cwd: opts.cwd || undefined,
  });

  const cleaned = clean(res.stdout);
  const ok = res.code === 0 && cleaned.length > 0;
  // Same FAILURE-gate as agy: codex reads files (read-only sandbox), so a successful review whose
  // answer quotes this repo's roster.json quota_patterns ("quota", "429", "rate limit", …) must NOT
  // be misread as exhaustion and discarded. Only scan when the call did not produce a usable result.
  const quota = quotaFromResult(res, cleaned, asArray(field(cfg, 'quota_patterns')), asArray(field(cfg, 'quota_exit_codes')));
  return { ok, stdout: cleaned, stderr: res.stderr, code: res.code, quota, timedOut: !!res.timedOut };
}

// invoke(backendCfg, prompt, opts) -> { ok, stdout, stderr, code, quota }
//   opts: { model?:string, tier?:'cheap'|'standard', addDir?:string, cwd?:string, writable?:boolean }
//   cwd      — run the CLI in this directory (the subtask's git worktree in /team --writable mode).
//   writable — use the backend's `writable_extra` (full-auto) instead of `extra` (read-only sandbox).
export async function invoke(backendCfg, prompt, opts = {}) {
  const kind = backendCfg && backendCfg.kind;
  switch (kind) {
    case 'gemini':
      return invokeGemini(backendCfg, prompt, opts);
    case 'codex':
      return invokeCodex(backendCfg, prompt, opts);
    default:
      // No invoker for this kind — caller falls through to the next backend / native (parity 127).
      return { ok: false, stdout: '', stderr: '', code: 127, quota: false };
  }
}

// --- health ------------------------------------------------------------------
// `<bin> --version` -> non-empty output, exit 0. WITHOUT any PTY wrapper for BOTH backends:
// PROBES.md confirms winpty yields empty for agy --version (not TTY-gated), and codex isn't gated.
async function _healthUncached(backendCfg) {
  const kind = backendCfg && backendCfg.kind;
  let bin;
  if (kind === 'gemini') {
    bin = platform.resolveBinary('agy', {
      envVar: process.env.MMT_BE_BIN ? 'MMT_BE_BIN' : (process.env.MMT_AGY_BIN ? 'MMT_AGY_BIN' : undefined),
      candidates: [...asArray(field(backendCfg, 'bin_candidates')), ...agyCandidates()],
    });
  } else if (kind === 'codex') {
    bin = platform.resolveBinary('codex', {
      envVar: process.env.MMT_BE_BIN ? 'MMT_BE_BIN' : undefined,
      candidates: asArray(field(backendCfg, 'bin_candidates')),
    });
  } else {
    return false;
  }

  const healthFlag = field(backendCfg, 'health') || '--version';
  // One-shot retry: a SINGLE `--version` probe is flaky on Windows — a cold-start, an AV scan of the
  // binary, or a momentary ConPTY hiccup can make it time out or return empty even though a real
  // dispatch seconds later would succeed. A false "unhealthy" verdict silently blackholes the backend
  // (run.mjs skips it → native handoff). Probe twice before declaring a backend down; a healthy CLI
  // answers `--version` in well under a second, so the retry cost on the happy path is zero.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runChild([bin, healthFlag], {
      hardTimeout: 30_000, // parity with backends.sh `timeout 30`.
      keepStdinOpen: false, // version probe: stdin closed (= </dev/null).
    });
    // Non-empty stdout (CR-stripped) + clean exit. spawnError/ENOENT -> code 127 -> false.
    const out = res.stdout.replace(/\r/g, '').trim();
    if (res.code === 0 && out.length > 0) return true;
  }
  return false;
}

// TTL-memoized health check. Caches POSITIVE verdicts only: a healthy backend is trusted for
// HEALTH_TTL_MS (keeps the per-hop fallback cost to one probe per TTL), but a NEGATIVE verdict is
// NEVER cached. A transient probe miss (cold start, AV scan, ConPTY hiccup) therefore costs at most
// one skipped dispatch, not a full TTL window of silent native-handoffs — the very next call
// re-probes and recovers. Asymmetric on purpose: a stale "healthy" is cheap (one real call fails →
// invalidateHealth re-probes), a stale "unhealthy" used to blackhole a working backend for 60s.
export async function health(backendCfg) {
  const key = _healthKey(backendCfg);
  const cached = _healthCache.get(key);
  const now = Date.now();
  if (cached !== undefined && cached.ok && (now - cached.ts) < HEALTH_TTL_MS) return true;
  const ok = await _healthUncached(backendCfg);
  if (ok) _healthCache.set(key, { ok: true, ts: now });
  else _healthCache.delete(key); // never cache a negative verdict; re-probe next call
  return ok;
}

// Drop a backend's cached health (e.g. after it errors mid-run) so the next call re-probes it.
export function invalidateHealth(backendCfg) {
  _healthCache.delete(_healthKey(backendCfg));
}

// Reset the whole health cache — for tests.
export function _clearHealthCache() {
  _healthCache.clear();
}

// --- clean -------------------------------------------------------------------
// Parity with backends.sh mmt_clean: strip CR, drop winpty teardown assertion lines, strip stray
// OSC / CSI / charset-select / 2-char ESC sequences, then trim trailing blank lines.
export function clean(raw) {
  if (raw == null) return '';
  let s = String(raw);

  // 1. Strip carriage returns (CRLF -> LF; bare CR removed). Matches `s/\r$//` broadly + safely.
  s = s.replace(/\r/g, '');

  // 2. ANSI / escape sequence stripping (the -Xplain backstop in mmt_clean):
  //    OSC: ESC ] ... (BEL | ESC \)
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  //    CSI: ESC [ params intermediates final
  s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  //    charset select: ESC ( X | ESC ) X
  s = s.replace(/\x1b[()][0-9A-Za-z]/g, '');
  //    2-char escapes: ESC = > c M 7 8
  s = s.replace(/\x1b[=>cM78]/g, '');

  // 3. Drop winpty teardown noise lines (cosmetic stderr that can leak): `Assertion failed:...winpty.cc`
  s = s
    .split('\n')
    .filter((line) => !/^Assertion failed:.*winpty\.cc/.test(line))
    .join('\n');

  // 4. Trim trailing blank lines (parity with the `:a;/^[[:space:]]*$/{$d;N;ba}` tail trim).
  s = s.replace(/[ \t]*\n[\s]*$/g, '').replace(/\s+$/g, '');

  return s;
}

// --- quota detection ---------------------------------------------------------
// Pure JS, no grep/regex-fork (parity with mmt_quota_exhausted): exit-code match first, then
// lowercased bounded substring scan over out+err.
export function quotaExhausted(blob, patterns, exitCode, exitCodes) {
  // Exit-code match (string-or-number compare, like bash `[ "$code" = "$c" ]`).
  if (Array.isArray(exitCodes)) {
    for (const c of exitCodes) {
      if (c === undefined || c === null || c === '') continue;
      if (String(exitCode) === String(c)) return true;
    }
  }
  if (!Array.isArray(patterns) || patterns.length === 0) return false;

  // Lowercase + bound the haystack (16000 chars, parity with the bash `${blob:0:16000}`).
  const hay = String(blob == null ? '' : blob).toLowerCase().slice(0, 16000);
  for (const p of patterns) {
    if (p === undefined || p === null || p === '') continue;
    if (hay.includes(String(p).toLowerCase())) return true;
  }
  return false;
}

// Decide quota/credit exhaustion from a COMPLETED child result. CRITICAL: a successful call (clean
// exit + usable output) is NEVER exhaustion — exhaustion always surfaces as a FAILURE (non-zero
// exit, empty output, or a stderr error). Scanning a successful answer's own stdout prose for
// "quota"/"429"/"rate limit"/… false-positives whenever the model merely quotes or discusses those
// terms — the exact bug where codex, reading this repo's roster.json quota_patterns to answer a
// review, got its perfectly good PASS discarded as "quota exhausted". So only scan on failure.
export function quotaFromResult(res, cleaned, patterns, exitCodes) {
  const ok = res && res.code === 0 && String(cleaned ?? '').length > 0;
  if (ok) return false;
  return quotaExhausted(`${res ? res.stdout : ''}\n${res ? res.stderr : ''}`, patterns, res ? res.code : 1, exitCodes);
}
