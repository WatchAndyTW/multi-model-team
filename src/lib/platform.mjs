// platform.mjs — cross-platform OS layer (the Linux/macOS linchpin).
//
// The ONLY place OS branching for the TTY gate belongs. Zero runtime deps (Node stdlib only).
// Parity target: scripts/lib/backends.sh (binary resolution + winpty wrapping) and
// scripts/lib/state.sh (state dir = ~/.cache/mmt). Must run on win32 / linux / darwin.
//
// No imports from other project modules.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const PLATFORM = process.platform; // 'win32' | 'linux' | 'darwin' | ...

export function isWindows() {
  return PLATFORM === 'win32';
}

export function homeDir() {
  return os.homedir();
}

// HUD state cache dir.
//   MMT_STATE_DIR override > (posix: $XDG_CACHE_HOME/mmt) > ~/.cache/mmt
// Windows parity with state.sh keeps ~/.cache/mmt (state.sh hardcodes $HOME/.cache/mmt on every OS),
// so the XDG branch is posix-only and the default is ~/.cache/mmt everywhere.
export function stateDir() {
  const override = process.env.MMT_STATE_DIR;
  if (override && override.trim()) return override;
  if (!isWindows()) {
    const xdg = process.env.XDG_CACHE_HOME;
    if (xdg && xdg.trim()) return path.join(xdg, 'mmt');
  }
  return path.join(homeDir(), '.cache', 'mmt');
}

// Resolve the roster.json the whole plugin should read, with a USER-LEVEL OVERRIDE.
// Precedence (highest first):
//   1. $MMT_ROSTER            — explicit env override (tests, power users); used verbatim.
//   2. ~/.claude/mmt-roster.json  — the user's personal roster, if it exists. This is the
//      "setup is correct" path: a user drops their tuned config here and every entry point picks
//      it up automatically, instead of editing the (cache-managed, upgrade-clobbered) plugin copy.
//   3. <pluginRoot>/config/roster.json  — the shipped default, used when neither above is present.
// `pluginRoot` is required for the fallback; pass the directory that contains config/roster.json
// (each caller already knows its own root). The user file is honored ONLY when it actually exists,
// so an absent ~/.claude/mmt-roster.json transparently falls through to the shipped default.
const USER_ROSTER_REL = ['.claude', 'mmt-roster.json'];

export function userRosterPath() {
  return path.join(homeDir(), ...USER_ROSTER_REL);
}

export function resolveRosterPath(pluginRoot) {
  const env = process.env.MMT_ROSTER;
  if (env && env.trim()) return env;
  const user = userRosterPath();
  if (isUsableFile(user)) return user;
  return path.join(pluginRoot, 'config', 'roster.json');
}

// Expand a leading ~ and embedded $LOCALAPPDATA / $HOME tokens in a candidate path.
function expandCandidate(c) {
  if (!c) return c;
  let out = c;
  if (out === '~') {
    out = homeDir();
  } else if (out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(homeDir(), out.slice(2));
  }
  out = out
    .replaceAll('$LOCALAPPDATA', process.env.LOCALAPPDATA || '')
    .replaceAll('$HOME', process.env.HOME || homeDir());
  return out;
}

// Is `p` an existing regular/executable file we can use directly?
function isUsableFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Resolve a binary without forking `where`/`which`:
//   process.env[envVar] (if set and points at a file) > scan process.env.PATH > expanded candidates > bare name.
export function resolveBinary(name, opts = {}) {
  const { envVar, candidates = [] } = opts;

  // 1. Explicit env override (must point at a usable file to win; otherwise fall through).
  if (envVar) {
    const ov = process.env[envVar];
    if (ov && ov.trim() && isUsableFile(ov)) return ov;
  }

  // 2. Scan PATH directly (no where/which fork). Honor PATHEXT on Windows.
  const pathVar = process.env.PATH || process.env.Path || '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts = isWindows()
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    if (isWindows() && !path.extname(name)) {
      // Windows: an extensionless file is NOT executable by CreateProcess / Node spawn. npm drops a
      // bare Unix shim (e.g. `codex`) on PATH next to `codex.cmd`; prefer the PATHEXT match so we
      // return `codex.cmd`, not the unrunnable shim. (The bash port dodged this — msys runs the shim.)
      for (const ext of exts) {
        const withExt = path.join(dir, name + ext);
        if (isUsableFile(withExt)) return withExt;
      }
    } else {
      // Name already carries an extension/separator (or posix) — try it verbatim.
      const direct = path.join(dir, name);
      if (isUsableFile(direct)) return direct;
    }
  }

  // 3. Explicit candidates (with ~ / $LOCALAPPDATA / $HOME expansion).
  for (const cand of candidates) {
    const ex = expandCandidate(cand);
    if (ex && isUsableFile(ex)) return ex;
  }

  // 4. Give up — return the bare name and let the OS resolve it at spawn time.
  return name;
}

// Is a PTY wrapper available? winpty on win32, `script` on posix.
export function hasPtyWrapper() {
  if (isWindows()) {
    return resolveBinary('winpty') !== 'winpty';
  }
  return resolveBinary('script') !== 'script';
}

// POSIX single-quote a string so it is safe inside `script -c '<cmd>'`.
// Wrap in single quotes and escape embedded single quotes as '\'' — neutralizes
// $, backticks, quotes, spaces, newlines, etc.
function shquote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

// Wrap an argv so a child that gates on isatty(stdout) still emits.
//   opts: { needTty?:boolean (default true) }
//   returns { argv: string[], usedPty: boolean }
//   win32:  winpty -Xallow-non-tty -Xplain <argv...>
//   linux:  script -qec '<shell-quoted argv>' /dev/null   (GNU util-linux)
//   darwin: script -q /dev/null <argv...>                 (BSD arg order)
// Passthrough (no wrap) when needTty is false OR no wrapper is present.
export function ptyWrap(argv, opts = {}) {
  const { needTty = true } = opts;
  const original = Array.isArray(argv) ? argv.slice() : [];

  if (!needTty || !hasPtyWrapper()) {
    return { argv: original, usedPty: false };
  }

  if (isWindows()) {
    return { argv: ['winpty', '-Xallow-non-tty', '-Xplain', ...original], usedPty: true };
  }

  if (PLATFORM === 'darwin') {
    // BSD script: `script -q /dev/null <argv...>` — runs the command directly, no shell string.
    return { argv: ['script', '-q', '/dev/null', ...original], usedPty: true };
  }

  // linux (and any other posix): GNU util-linux `script -qec '<cmd>' /dev/null`.
  // The command is a single shell string, so EVERY arg must be shell-quoted (a prompt may
  // contain quotes / $ / backticks). -c takes one string => join the quoted argv.
  const cmd = original.map(shquote).join(' ');
  return { argv: ['script', '-qec', cmd, '/dev/null'], usedPty: true };
}
