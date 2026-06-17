// helpers.mjs — shared test fixtures for the Node ESM suite.
//
// Resolves repo paths relative to this file (test/ -> repo root) and exposes the
// loaded roster + tags path so every test imports modules directly (fast, no fork).

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadRoster } from '../src/lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');

export const ROSTER_PATH = join(ROOT, 'config', 'roster.json');
export const TAGS_PATH = join(ROOT, 'config', 'tags.txt');

export const ROSTER = loadRoster(ROSTER_PATH);

export const BIN_ROUTE = join(ROOT, 'src', 'bin', 'route.mjs');
export const BIN_RUN = join(ROOT, 'src', 'bin', 'run.mjs');
export const BIN_SETUP = join(ROOT, 'src', 'bin', 'setup.mjs');
export const HOOK_PROACTIVE = join(ROOT, 'hooks', 'proactive-route.mjs');
export const HOOK_SPAWN = join(ROOT, 'hooks', 'spawn-route-guard.mjs');
export const HOOK_FANOUT = join(ROOT, 'hooks', 'command-fanout-guard.mjs');
export const STATUSLINE = join(ROOT, 'statusline', 'statusline.mjs');

/** Make a throwaway temp dir (auto-namespaced). */
export function tmp(prefix = 'mmt-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a roster variant: deep-clone the real roster, mutate via `fn`, write to `dir/name`. */
export function writeRosterVariant(dir, name, fn) {
  const clone = JSON.parse(JSON.stringify(ROSTER));
  if (fn) fn(clone);
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(clone), 'utf8');
  return p;
}

/**
 * Create a temp project dir with a `.mmt/roster.json` (deep-cloned real roster, mutated via `fn`).
 * Run a script with `{ cwd: <returned dir> }` so resolveRosterPath picks up this project roster —
 * the file-based replacement for the removed MMT_ROSTER env override.
 * @returns {string} the temp project dir (its .mmt/roster.json is the active roster when used as cwd)
 */
export function makeProjectRoster(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix || 'mmt-proj-'));
  const mmt = join(dir, '.mmt');
  mkdirSync(mmt, { recursive: true });
  const clone = JSON.parse(JSON.stringify(ROSTER));
  if (fn) fn(clone);
  writeFileSync(join(mmt, 'roster.json'), JSON.stringify(clone), 'utf8');
  return dir;
}

/**
 * Run a node script (a bin or a hook) capturing stdout.
 * @param {string} script  absolute path to the .mjs entry
 * @param {object} opts    { args?:string[], input?:string, env?:object, cwd?:string }
 * @returns {{ stdout:string, stderr:string, code:number }}
 */
export function runNode(script, { args = [], input = '', env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    input,
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    code: typeof r.status === 'number' ? r.status : (r.signal ? 1 : 0),
  };
}

export { readFileSync };
