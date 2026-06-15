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

import { spawn } from 'node:child_process';
import * as platform from './platform.mjs';

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
// ("6m", "300s", "90", "1.5h"). Returns ms. Default 6 minutes (parity with backends.sh `6m`).
function timeoutMs(raw) {
  const DEFAULT = 6 * 60 * 1000;
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

// Windows can't spawn a .cmd/.bat directly — Node throws EINVAL (CVE-2024-27980 hardening). Route
// such argv through `cmd.exe /d /s /c` with the args as an ARRAY (Node quotes them), which avoids
// shell:true (DEP0190 — unescaped concatenation). agy/.exe and all posix argv pass through untouched.
// NOTE: cmd.exe still expands %VAR% inside quoted args; a literal % in a prompt is a rare edge for
// codex review/test prompts — covered by the live (MMT_LIVE) smoke test, not the offline suite.
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
function runChild(argv, { hardTimeout, keepStdinOpen, stdinData }) {
  return new Promise((resolve) => {
    const [cmd, ...args] = winCmdWrap(argv);
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
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

  // Parity with backends.sh _mmt_invoke_gemini argv order:
  //   [bin, print_flag, prompt, model_flag, model, ...extra, add_dir_flag, add_dir]
  // INTERFACES summarizes as [bin, print_flag, prompt, ...extra]; the model + extra go after the
  // prompt either way. We keep the bash order (model pair, then extra) — agy parses flags freely.
  let argv = [bin, printFlag, prompt];
  if (model) argv.push(modelFlag, model);
  argv.push(...asArray(field(cfg, 'extra')));
  if (addDir) argv.push(addDirFlag, addDir);

  // winpty/PTY wrap when configured (and a wrapper exists). use_winpty true by default for agy.
  const useWinpty = field(cfg, 'use_winpty') !== false;
  const wrapped = platform.ptyWrap(argv, { needTty: useWinpty });
  argv = wrapped.argv;

  const res = await runChild(argv, {
    hardTimeout: timeoutMs(field(cfg, 'hard_timeout')),
    keepStdinOpen: true, // agy: hold stdin open+idle until exit (the FIFO replacement).
  });

  const cleaned = clean(res.stdout);
  const quota = quotaExhausted(
    `${res.stdout}\n${res.stderr}`,
    asArray(field(cfg, 'quota_patterns')),
    res.code,
    asArray(field(cfg, 'quota_exit_codes')),
  );
  // ok = exited 0 AND produced usable (non-empty) cleaned stdout. An empty result is the classic
  // agy "silent no-op" — treat as failure so run.sh falls through (parity with run.sh contract).
  const ok = res.code === 0 && cleaned.length > 0;
  return { ok, stdout: cleaned, stderr: res.stderr, code: res.code, quota };
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
  //   [bin, exec, ...extra(incl `-s read-only`), (-m model)?, (--add-dir dir)?, '-']  + prompt on stdin
  const argv = [bin, oneshot, ...asArray(field(cfg, 'extra'))];
  if (model) argv.push(modelFlag, model);
  if (addDir) argv.push(addDirFlag, addDir);
  argv.push('-');

  const res = await runChild(argv, {
    hardTimeout: timeoutMs(field(cfg, 'hard_timeout')),
    stdinData: prompt,
  });

  const cleaned = clean(res.stdout);
  const quota = quotaExhausted(
    `${res.stdout}\n${res.stderr}`,
    asArray(field(cfg, 'quota_patterns')),
    res.code,
    asArray(field(cfg, 'quota_exit_codes')),
  );
  const ok = res.code === 0 && cleaned.length > 0;
  return { ok, stdout: cleaned, stderr: res.stderr, code: res.code, quota };
}

// invoke(backendCfg, prompt, opts) -> { ok, stdout, stderr, code, quota }
//   opts: { model?:string, tier?:'cheap'|'standard', addDir?:string }
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
export async function health(backendCfg) {
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
  const res = await runChild([bin, healthFlag], {
    hardTimeout: 30_000, // parity with backends.sh `timeout 30`.
    keepStdinOpen: false, // version probe: stdin closed (= </dev/null).
  });
  // Non-empty stdout (CR-stripped) + clean exit. spawnError/ENOENT -> code 127 -> false.
  const out = res.stdout.replace(/\r/g, '').trim();
  return res.code === 0 && out.length > 0;
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
